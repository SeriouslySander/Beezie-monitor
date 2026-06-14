/**
 * beezie-claw-monitor.js
 * ----------------------
 * Onchain monitor voor Beezie claw-machines op Base, met Telegram-bot + geheugen.
 *
 * Drie delen in één proces:
 *   1. MONITOR  — scant de machines en stuurt vanzelf alerts.
 *   2. CHAT-BOT — grammY, luistert naar /status /machine /budget /best /breakeven /log /help.
 *   3. GEHEUGEN — schrijft toestand + vensergeschiedenis naar schijf (data.json),
 *                 zodat een herstart niets vergeet en je patronen kunt terugzien.
 *
 * Setup:
 *   npm init -y && npm pkg set type=module && npm i viem grammy
 *   export BASE_RPC_URL="https://base-mainnet.g.alchemy.com/v2/JOUW_KEY"
 *   export TELEGRAM_BOT_TOKEN="..."  TELEGRAM_CHAT_ID="..."
 *   export DATA_DIR="/data"   # op Railway: koppel een Volume aan /data (anders ./data)
 *   node beezie-claw-monitor.js
 */

import { createPublicClient, http, parseAbi, parseAbiItem, formatUnits, getAddress } from "viem";
import { base } from "viem/chains";
import { Bot } from "grammy";
import fs from "fs";
import path from "path";

// ---------------------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------------------
const CONFIG = {
  rpcUrl: process.env.BASE_RPC_URL || "https://mainnet.base.org",
  factory: getAddress("0x8b50bab7464764f6d102a9819b7db967256db14c"),
  collectibles: getAddress("0xbb5ec6fd4b61723bd45c399840f1d868840ca16f"),

  swapFee: 0.06,
  usdcDecimals: 6,

  evAlertUsd: 0,
  costPerPointAlert: 0.01,
  pullPtsPerUsd: 1,
  swapPtsPerUsd: 1.5,
  grailTopN: 5,
  endgamePoolFrac: 0.45,
  reAlertCooldownMs: 30 * 60_000,

  pollSlowMs: 5 * 60_000,
  pollFastMs: 15_000,
  warmMarginUsd: 8,

  defaultBudgetUsd: 800,

  dataDir: process.env.DATA_DIR || "./data",
  saveEveryMs: 60_000,          // hooguit 1× per minuut wegschrijven
  windowLogMax: 50,             // bewaar de laatste 50 vensters

  machines: [
    { label: "Wildcard $30",  address: "0x99856ed47021572c0C4A26e286559A7A56f85dd2" },
    { label: "Silver $50",    address: "0x064591f28a5cDBBbd2eA9318eb4329a140DE4A1D" },
    { label: "Gold $250",     address: "0x297B94d5b0D9aB4F013E54FcB8B8F965Ce02c8F3" },
    { label: "Platinum $500", address: "0xcA82E14F618380f7394E1196Ca4beF007F0954BB" },
  ],

  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN || "",
    chatId: process.env.TELEGRAM_CHAT_ID || "",
  },
};

// ---------------------------------------------------------------------------
const machineAbi = parseAbi([
  "function price() view returns (uint128)",
  "function isFinished() view returns (bool)",
  "function paused() view returns (bool)",
  "function getPrizePool() view returns ((uint48 tokenId, uint128 swapValue, uint40 timestamp)[])",
]);
const erc721Abi = parseAbi(["function tokenURI(uint256 tokenId) view returns (string)"]);
const clawCreated = parseAbiItem("event ClawMachineCreated(address indexed clawMachine)");

const client = createPublicClient({ chain: base, transport: http(CONFIG.rpcUrl) });
const usd = (v) => Number(formatUnits(v, CONFIG.usdcDecimals));
const fmt = (n) => `$${Number(n).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
const fmt2 = (n) => `$${Number(n).toFixed(2)}`;
const fmtK = (n) => (n >= 1000 ? `$${(n / 1000).toFixed(1)}k` : `$${Math.round(n)}`);
const cppText = (cpp) => (cpp <= 0 ? `−$${Math.abs(cpp).toFixed(3)}` : `$${cpp.toFixed(3)}`);

// state per machine (in geheugen) + venstergeschiedenis
const state = new Map();
let windowLog = [];            // [{machine, opened, closed, durationMin, bestEv, reason}]
let lastFactoryBlock = 0n;
let freshStart = true;         // eerste scan na (her)start: stil reconciliëren, niet alarmeren

// ---------------------------------------------------------------------------
// GEHEUGEN: laden en opslaan
// ---------------------------------------------------------------------------
const dataFile = path.join(CONFIG.dataDir, "data.json");
let lastSave = 0;

function loadState() {
  try {
    if (!fs.existsSync(dataFile)) { console.log("Geen opgeslagen geheugen — verse start."); return; }
    const raw = JSON.parse(fs.readFileSync(dataFile, "utf8"));
    windowLog = raw.windowLog || [];
    lastFactoryBlock = raw.lastFactoryBlock ? BigInt(raw.lastFactoryBlock) : 0n;
    for (const [addr, st] of Object.entries(raw.state || {})) {
      state.set(addr, {
        initialPoolSize: st.initialPoolSize,
        grails: new Map((st.grails || []).map((g) => [g.id, { value: g.value, name: g.name }])),
        lastAlert: st.lastAlert || {},
        wasPaused: !!st.wasPaused,
        windowOpen: !!st.windowOpen,
        windowOpenedAt: st.windowOpenedAt || null,
        windowBestEv: st.windowBestEv ?? null,
      });
    }
    console.log(`Geheugen geladen: ${state.size} machines, ${windowLog.length} vensters in historie.`);
  } catch (e) { console.error("geheugen laden mislukt:", e.message); }
}

function saveState(force = false) {
  if (!force && Date.now() - lastSave < CONFIG.saveEveryMs) return;
  lastSave = Date.now();
  try {
    fs.mkdirSync(CONFIG.dataDir, { recursive: true });
    const out = {
      savedAt: new Date().toISOString(),
      lastFactoryBlock: lastFactoryBlock.toString(),
      windowLog: windowLog.slice(-CONFIG.windowLogMax),
      state: {},
    };
    for (const [addr, st] of state) {
      out.state[addr] = {
        initialPoolSize: st.initialPoolSize,
        grails: [...st.grails].map(([id, g]) => ({ id, value: g.value, name: g.name })),
        lastAlert: st.lastAlert,
        wasPaused: st.wasPaused,
        windowOpen: st.windowOpen,
        windowOpenedAt: st.windowOpenedAt,
        windowBestEv: st.windowBestEv,
      };
    }
    fs.writeFileSync(dataFile, JSON.stringify(out));
  } catch (e) { console.error("geheugen opslaan mislukt:", e.message); }
}

// Venster openen/sluiten registreren in de historie
function openWindow(st, label, ev) {
  if (st.windowOpen) { st.windowBestEv = Math.max(st.windowBestEv ?? -Infinity, ev); return; }
  st.windowOpen = true;
  st.windowOpenedAt = Date.now();
  st.windowBestEv = ev;
}
function closeWindow(st, label) {
  if (!st.windowOpen) return;
  st.windowOpen = false;
  const opened = st.windowOpenedAt || Date.now();
  windowLog.push({
    machine: label,
    opened: new Date(opened).toISOString(),
    closed: new Date().toISOString(),
    durationMin: Math.round((Date.now() - opened) / 60000),
    bestEv: st.windowBestEv,
  });
  if (windowLog.length > CONFIG.windowLogMax) windowLog = windowLog.slice(-CONFIG.windowLogMax);
  st.windowOpenedAt = null;
  st.windowBestEv = null;
  saveState(true);
}

// ---------------------------------------------------------------------------
// CHAT-BOT (grammY)
// ---------------------------------------------------------------------------
const bot = CONFIG.telegram.botToken ? new Bot(CONFIG.telegram.botToken) : null;

async function tg(text) {
  console.log("[ALERT]", text.replace(/<[^>]+>/g, "").replace(/\n/g, " | "));
  if (!bot || !CONFIG.telegram.chatId) return;
  try {
    await bot.api.sendMessage(CONFIG.telegram.chatId, text, {
      parse_mode: "HTML", link_preview_options: { is_disabled: true },
    });
  } catch (e) { console.error("telegram:", e.message); }
}

function findMachine(arg) {
  if (!arg) return null;
  const a = arg.toLowerCase();
  return CONFIG.machines.find((m) => m.label.toLowerCase().includes(a)) || null;
}

if (bot) {
  bot.command(["status", "pools"], async (ctx) => {
    const lines = ["📊 <b>Stand nu</b>"];
    for (const m of CONFIG.machines) {
      try {
        const d = await readPool(getAddress(m.address));
        if (d.finished || d.items.length === 0) { lines.push(`\n<b>${m.label}</b>: leeg`); continue; }
        if (d.paused) { lines.push(`\n<b>${m.label}</b>: ⏸️ wordt bijgevuld (${d.items.length} kaarten)`); continue; }
        const s = stats(d.price, d.items);
        const top = [...d.items].sort((a, b) => b.value - a.value).slice(0, 3).map((i) => fmtK(i.value));
        const flag = s.ev >= 0 ? "🟢 " : s.costPerPoint <= CONFIG.costPerPointAlert ? "🪙 " : "";
        lines.push(
          `\n${flag}<b>${m.label}</b>: ${d.items.length} kaarten\n` +
          `gemiddeld ${fmt2(s.ev)}/keer · meestal ${fmt2(s.modeNet)} · ${cppText(s.costPerPoint)}/punt\n` +
          `top: ${top.join(", ")}`
        );
      } catch { lines.push(`\n<b>${m.label}</b>: leesfout`); }
    }
    await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
  });

  bot.command("machine", async (ctx) => {
    const m = findMachine(ctx.match);
    if (!m) return ctx.reply("Welke? Bijv: /machine platinum");
    try {
      const d = await readPool(getAddress(m.address));
      if (d.paused) return ctx.reply(`${m.label}: ⏸️ wordt nu bijgevuld (${d.items.length} kaarten).`);
      if (d.items.length === 0) return ctx.reply(`${m.label}: leeg.`);
      const s = stats(d.price, d.items);
      const sorted = [...d.items].sort((a, b) => b.value - a.value);
      const breakeven = d.price / (1 - CONFIG.swapFee);
      const topList = sorted.slice(0, 5).map((i) => `• ${fmtK(i.value)}`).join("\n");
      await ctx.reply(
        `<b>${m.label}</b> — ${d.items.length} kaarten\n` +
        `Inzet ${fmt(d.price)} · gemiddeld <b>${fmt2(s.ev)}</b>/keer · ${cppText(s.costPerPoint)}/punt\n` +
        `Meestal trek je ${fmtK(s.modeVal)} (${(s.modeShare * 100).toFixed(0)}% v.d. keren) = ${fmt2(s.modeNet)}\n` +
        `Kans op winst: ${(s.winRate * 100).toFixed(0)}%\n` +
        `Gunstig zodra de gemiddelde kaart boven ${fmt2(breakeven)} komt (nu ${fmt2(s.mean)})\n` +
        `\nDuurste kaarten nu:\n${topList}`,
        { parse_mode: "HTML" }
      );
    } catch (e) { await ctx.reply(`Leesfout: ${e.message}`); }
  });

  bot.command("budget", async (ctx) => {
    const budget = Number(ctx.match) > 0 ? Number(ctx.match) : CONFIG.defaultBudgetUsd;
    const lines = [`💰 <b>Met ${fmt(budget)}</b>`];
    for (const m of CONFIG.machines) {
      try {
        const d = await readPool(getAddress(m.address));
        if (d.paused || d.items.length === 0) { lines.push(`\n<b>${m.label}</b>: niet speelbaar nu`); continue; }
        const s = stats(d.price, d.items);
        const keer = Math.floor(budget / d.price);
        if (keer === 0) { lines.push(`\n<b>${m.label}</b>: te duur (${fmt(d.price)}/keer)`); continue; }
        lines.push(
          `\n<b>${m.label}</b>: ${keer}× spelen\n` +
          `verwacht resultaat ${fmt2(s.ev * keer)} · meestal rond ${fmt2(s.modeNet * keer)}\n` +
          `punten ~${Math.round(s.ptsPerLoop * keer)}`
        );
      } catch { lines.push(`\n<b>${m.label}</b>: leesfout`); }
    }
    await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
  });

  bot.command("best", async (ctx) => {
    let rows = [];
    for (const m of CONFIG.machines) {
      try {
        const d = await readPool(getAddress(m.address));
        if (d.paused || d.items.length === 0) continue;
        const s = stats(d.price, d.items);
        rows.push({ label: m.label, evPct: s.ev / d.price, cpp: s.costPerPoint, ev: s.ev });
      } catch { /* skip */ }
    }
    if (rows.length === 0) return ctx.reply("Geen speelbare machines nu.");
    rows.sort((a, b) => b.evPct - a.evPct);
    const top = rows[0];
    const lines = ["🎯 <b>Beste keuze nu</b>"];
    for (const r of rows) {
      const mark = r === top ? "👉 " : "   ";
      lines.push(`${mark}<b>${r.label}</b>: ${fmt2(r.ev)}/keer (${(r.evPct * 100).toFixed(1)}%) · ${cppText(r.cpp)}/punt`);
    }
    lines.push(
      top.ev >= 0
        ? `\n${top.label} is nu gunstig — spelen kan.`
        : `\nNog niets gunstig. ${top.label} is het minst slecht, maar wachten op een bericht is verstandiger.`
    );
    await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
  });

  bot.command("breakeven", async (ctx) => {
    const lines = ["📐 <b>Hoe ver van gunstig</b>"];
    for (const m of CONFIG.machines) {
      try {
        const d = await readPool(getAddress(m.address));
        if (d.paused || d.items.length === 0) { lines.push(`\n<b>${m.label}</b>: niet speelbaar`); continue; }
        const s = stats(d.price, d.items);
        const breakeven = d.price / (1 - CONFIG.swapFee);
        const gap = breakeven - s.mean;
        if (gap <= 0) { lines.push(`\n🟢 <b>${m.label}</b>: nu al gunstig`); continue; }
        const cheap = d.items.filter((i) => i.value < s.mean).length;
        lines.push(
          `\n<b>${m.label}</b>: gemiddelde kaart ${fmt2(s.mean)}, moet naar ${fmt2(breakeven)} (+${fmt2(gap)})\n` +
          `pool ${d.items.length} · ~${cheap} goedkope kaarten te gaan`
        );
      } catch { lines.push(`\n<b>${m.label}</b>: leesfout`); }
    }
    lines.push(`\nMeestal kantelt een machine pas in de laatste ~45%. De bot meldt het zelf zodra het zover is.`);
    await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
  });

  bot.command("log", async (ctx) => {
    if (windowLog.length === 0) return ctx.reply("Nog geen vensters in de historie. Zodra er één is geweest, zie je hem hier.");
    const recent = windowLog.slice(-10).reverse();
    const lines = ["📜 <b>Laatste gunstige vensters</b>"];
    for (const w of recent) {
      const d = new Date(w.opened);
      const dag = d.toLocaleDateString("nl-NL", { day: "numeric", month: "short" });
      const tijd = d.toLocaleTimeString("nl-NL", { hour: "2-digit", minute: "2-digit" });
      lines.push(`\n<b>${w.machine}</b> · ${dag} ${tijd}\n${w.durationMin} min open · best ${fmt2(w.bestEv ?? 0)}/keer`);
    }
    // simpel patroon: gemiddeld openingsuur
    const uren = windowLog.map((w) => new Date(w.opened).getHours());
    if (uren.length >= 3) {
      const gem = Math.round(uren.reduce((a, b) => a + b, 0) / uren.length);
      lines.push(`\nVensters openen gemiddeld rond ${gem}:00.`);
    }
    await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
  });

  bot.command(["help", "start"], async (ctx) => {
    await ctx.reply(
      `<b>Wat ik kan</b>\n` +
      `/status — alle machines in één blik\n` +
      `/machine platinum — alles over één machine\n` +
      `/budget 800 — wat kun je met dit bedrag, per machine\n` +
      `/best — welke is nu het minst slecht / gunstig\n` +
      `/breakeven — hoe dicht elke machine bij gunstig is\n` +
      `/log — laatste gunstige vensters + patroon\n\n` +
      `En je krijgt vanzelf bericht bij: gunstig 🟢, punten goedkoop 🪙, topkaart eruit 🎣, bijna leeg ⏳, bijvullen ⏸️🔄, nieuwe machine 🆕.`,
      { parse_mode: "HTML" }
    );
  });

  bot.catch((err) => console.error("bot-fout:", err.message));
}

// ---------------------------------------------------------------------------
// GEDEELDE DATA-FUNCTIES
// ---------------------------------------------------------------------------
async function grailName(tokenId) {
  try {
    const uri = await client.readContract({
      address: CONFIG.collectibles, abi: erc721Abi, functionName: "tokenURI", args: [BigInt(tokenId)],
    });
    if (uri.startsWith("http")) {
      const meta = await fetch(uri).then((r) => r.json());
      if (meta?.name) return meta.name;
    }
  } catch { /* naam is nice-to-have */ }
  return `token ${tokenId}`;
}

async function readPool(address) {
  const [price, finished, paused, pool] = await Promise.all([
    client.readContract({ address, abi: machineAbi, functionName: "price" }),
    client.readContract({ address, abi: machineAbi, functionName: "isFinished" }),
    client.readContract({ address, abi: machineAbi, functionName: "paused" }),
    client.readContract({ address, abi: machineAbi, functionName: "getPrizePool" }),
  ]);
  return {
    price: usd(price), finished, paused,
    items: pool.map((p) => ({ id: Number(p.tokenId), value: usd(p.swapValue) })),
  };
}

function stats(priceUsd, items) {
  const n = items.length;
  const vals = items.map((i) => i.value);
  const sorted = [...vals].sort((a, b) => a - b);
  const mean = vals.reduce((a, b) => a + b, 0) / n;
  const ev = mean * (1 - CONFIG.swapFee) - priceUsd;
  const winRate = vals.filter((v) => v * (1 - CONFIG.swapFee) >= priceUsd).length / n;
  const medianNet = sorted[Math.floor(n / 2)] * (1 - CONFIG.swapFee) - priceUsd;
  const freq = new Map();
  for (const v of vals) freq.set(v, (freq.get(v) || 0) + 1);
  let modeVal = vals[0], modeCnt = 0;
  for (const [v, c] of freq) if (c > modeCnt) { modeCnt = c; modeVal = v; }
  const modeNet = modeVal * (1 - CONFIG.swapFee) - priceUsd;
  const ptsPerLoop = priceUsd * CONFIG.pullPtsPerUsd + mean * CONFIG.swapPtsPerUsd;
  const costPerPoint = -ev / ptsPerLoop;
  return { n, mean, ev, winRate, ptsPerLoop, costPerPoint, medianNet, modeVal, modeNet, modeShare: modeCnt / n };
}

function cooldownOk(st, key) {
  const t = st.lastAlert[key] || 0;
  if (Date.now() - t < CONFIG.reAlertCooldownMs) return false;
  st.lastAlert[key] = Date.now();
  return true;
}

async function initMachine(m) {
  const data = await readPool(getAddress(m.address));
  const top = [...data.items].sort((a, b) => b.value - a.value).slice(0, CONFIG.grailTopN);
  const grails = new Map();
  for (const g of top) grails.set(g.id, { value: g.value, name: await grailName(g.id) });
  state.set(m.address, {
    initialPoolSize: data.items.length, grails, lastAlert: {},
    wasPaused: data.paused, windowOpen: false, windowOpenedAt: null, windowBestEv: null,
  });
  console.log(`init ${m.label}: pool ${data.items.length}`);
  return data;
}

// ---------------------------------------------------------------------------
// MONITOR-LOOP
// ---------------------------------------------------------------------------
async function scan(m) {
  const addr = getAddress(m.address);
  let st = state.get(m.address);
  let data;
  try {
    if (!st) { data = await initMachine(m); st = state.get(m.address); }
    else data = await readPool(addr);
  } catch (e) { console.error(`${m.label}: ${e.message}`); return CONFIG.pollSlowMs; }

  if (data.finished || data.items.length === 0) { console.log(`${m.label}: leeg`); return CONFIG.pollSlowMs; }

  if (data.paused) {
    if (!st.wasPaused) {
      st.wasPaused = true;
      closeWindow(st, m.label);
      await tg(`⏸️ <b>${m.label} — wordt bijgevuld</b>\nSpelen kan nu niet · wijzigingen zijn van Beezie zelf\nDoen: negeren tot hij weer opengaat`);
    }
    const inPoolPaused = new Set(data.items.map((i) => i.id));
    for (const [id, g] of st.grails) if (!inPoolPaused.has(id)) { st.grails.delete(id); }
    return CONFIG.pollFastMs;
  }
  if (st.wasPaused) {
    st.wasPaused = false;
    st.initialPoolSize = data.items.length;
    const top = [...data.items].sort((a, b) => b.value - a.value).slice(0, CONFIG.grailTopN);
    st.grails = new Map();
    for (const g of top) st.grails.set(g.id, { value: g.value, name: await grailName(g.id) });
    const sf = stats(data.price, data.items);
    if (sf.ev >= CONFIG.evAlertUsd || sf.costPerPoint <= CONFIG.costPerPointAlert) openWindow(st, m.label, sf.ev);
    await tg(
      `🔄 <b>${m.label} — weer open</b>\n` +
      `Gemiddeld ${fmt2(sf.ev)}/keer · ${cppText(sf.costPerPoint)} per punt · pool ${sf.n}\n` +
      `Topkaarten: ${top.slice(0, 5).map((g) => fmtK(g.value)).join(", ")}\n` +
      (st.windowOpen ? `🚨 Doen: meteen kijken, opent gunstig` : `Doen: nog niet interessant, wachten tot hij bijna leeg is`)
    );
    return CONFIG.pollFastMs;
  }
  if (data.items.length > st.initialPoolSize * 1.15) {
    st.initialPoolSize = data.items.length;
    const top = [...data.items].sort((a, b) => b.value - a.value).slice(0, CONFIG.grailTopN);
    st.grails = new Map();
    for (const g of top) st.grails.set(g.id, { value: g.value, name: await grailName(g.id) });
    await tg(`🔄 <b>${m.label} — net bijgevuld</b>\nPool weer ${data.items.length} · topkaarten opnieuw ingeladen`);
  }

  const s = stats(data.price, data.items);
  const inPool = new Set(data.items.map((i) => i.id));

  // Eerste scan na (her)start: grails stil gelijktrekken zonder valse alerts
  if (freshStart) {
    for (const [id] of st.grails) if (!inPool.has(id)) st.grails.delete(id);
  } else {
    for (const [id, g] of st.grails) {
      if (!inPool.has(id)) {
        st.grails.delete(id);
        const left = [...st.grails.values()].map((x) => fmtK(x.value)).join(", ") || "geen";
        await tg(`🎣 <b>${m.label} — topkaart eruit</b>\n${g.name} (${fmtK(g.value)}) is getrokken\nNog over: ${left} · pool ${s.n} · gemiddeld ${fmt2(s.ev)}/keer`);
      }
    }
  }

  const grailValueLeft = [...st.grails.values()].reduce((a, g) => a + g.value, 0);
  const cpp = s.costPerPoint;

  if (s.ev >= CONFIG.evAlertUsd && cooldownOk(st, "ev")) {
    openWindow(st, m.label, s.ev);
    await tg(
      `🟢 <b>${m.label} — nu gunstig</b>\n` +
      `Gemiddeld <b>${fmt2(s.ev)}</b>/keer · ${cppText(cpp)}/punt · ${(s.winRate * 100).toFixed(0)}% kans op winst\n` +
      `Maar meestal trek je ${fmtK(s.modeVal)} = ${fmt2(s.modeNet)} (${(s.modeShare * 100).toFixed(0)}% v.d. keren)\n` +
      `Pool ${s.n} · topkaarten nog erin ${fmtK(grailValueLeft)}\n` +
      `Doen: spelen — eerst trekken, daarna swaps afhandelen`
    );
  } else if (s.ev >= CONFIG.evAlertUsd) {
    openWindow(st, m.label, s.ev); // venster blijft open, beste-EV bijwerken zonder spam
  }

  if (s.ev < CONFIG.evAlertUsd && cpp <= CONFIG.costPerPointAlert && cooldownOk(st, "pts")) {
    openWindow(st, m.label, s.ev);
    await tg(
      `🪙 <b>${m.label} — punten goedkoop</b>\n` +
      `<b>${cppText(cpp)}</b> per punt · ~${Math.round(s.ptsPerLoop)} punten per keer\n` +
      `Maar meestal trek je ${fmtK(s.modeVal)} = ${fmt2(s.modeNet)} (${(s.modeShare * 100).toFixed(0)}% v.d. keren)\n` +
      `Pool ${s.n}\nDoen: punten sprokkelen (trekken → swappen) tot het 🔒-bericht`
    );
  }

  if (st.windowOpen && s.ev < CONFIG.evAlertUsd && cpp > CONFIG.costPerPointAlert) {
    closeWindow(st, m.label);
    await tg(`🔒 <b>${m.label} — niet meer gunstig</b>\nGemiddeld ${fmt2(s.ev)}/keer · ${cppText(cpp)} per punt\nDoen: stoppen`);
  }

  const frac = s.n / st.initialPoolSize;
  if (frac <= CONFIG.endgamePoolFrac && st.grails.size > 0 && cooldownOk(st, "endgame")) {
    await tg(
      `⏳ <b>${m.label} — bijna leeg, let op</b>\n` +
      `Nog ${s.n} kaarten (${(frac * 100).toFixed(0)}% over) · ${st.grails.size} topkaarten ${fmtK(grailValueLeft)} nog erin\n` +
      `Gemiddeld ${fmt2(s.ev)}/keer en verbetert naarmate hij leegloopt\nDoen: klaarzitten, kan zo gunstig worden`
    );
  }

  console.log(`${m.label}: pool ${s.n} (${(frac * 100).toFixed(0)}%) | gemiddeld ${fmt2(s.ev)} | meestal ${fmt2(s.modeNet)} | ${cppText(cpp)}/punt`);

  const warm = s.ev >= CONFIG.evAlertUsd - CONFIG.warmMarginUsd || cpp <= CONFIG.costPerPointAlert * 2 || frac <= CONFIG.endgamePoolFrac;
  return warm ? CONFIG.pollFastMs : CONFIG.pollSlowMs;
}

async function checkFactory() {
  try {
    const latest = await client.getBlockNumber();
    if (lastFactoryBlock === 0n) lastFactoryBlock = latest - 1n;
    const CHUNK = 10n;
    const logs = [];
    let from = lastFactoryBlock + 1n, rounds = 0;
    while (from <= latest && rounds < 30) {
      const to = from + CHUNK - 1n > latest ? latest : from + CHUNK - 1n;
      logs.push(...await client.getLogs({ address: CONFIG.factory, event: clawCreated, fromBlock: from, toBlock: to }));
      lastFactoryBlock = to; from = to + 1n; rounds++;
    }
    for (const log of logs) {
      const addr = getAddress(log.args.clawMachine);
      if (CONFIG.machines.find((m) => getAddress(m.address) === addr)) continue;
      const data = await readPool(addr).catch(() => null);
      if (!data) continue;
      const s = stats(data.price, data.items);
      const m = { label: `${fmt(data.price)} (nieuw)`, address: addr };
      CONFIG.machines.push(m);
      await initMachine(m).catch(() => {});
      await tg(`🆕 <b>Nieuwe machine van ${fmt(data.price)}</b>\nPool ${s.n} · gemiddeld ${fmt2(s.ev)}/keer\nDoen: nog niet interessant, ik houd hem in de gaten`);
    }
  } catch (e) { console.error("factory:", e.message); }
}

async function monitorLoop() {
  console.log(`Monitor gestart — ${CONFIG.machines.length} machines\n`);
  // machines die nog niet uit geheugen kwamen, alsnog initialiseren
  for (const m of CONFIG.machines) {
    if (!state.has(m.address)) await initMachine(m).catch((e) => console.error(`init ${m.label}: ${e.message}`));
  }
  for (;;) {
    await checkFactory();
    let delay = CONFIG.pollSlowMs;
    for (const m of CONFIG.machines) delay = Math.min(delay, await scan(m));
    freshStart = false; // na de eerste volledige ronde weer normaal alarmeren
    saveState();
    console.log(`— volgende scan over ${Math.round(delay / 1000)}s —\n`);
    await new Promise((r) => setTimeout(r, delay));
  }
}

// schoon afsluiten: laatste stand bewaren
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => { console.log(`\n${sig} — geheugen opslaan...`); saveState(true); process.exit(0); });
}

// ---------------------------------------------------------------------------
// START
// ---------------------------------------------------------------------------
loadState();
if (bot) bot.start({ onStart: () => console.log("Chat-bot luistert (long polling).") });
monitorLoop().catch((e) => { console.error(e); saveState(true); process.exit(1); });
