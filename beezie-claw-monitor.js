/**
 * beezie-claw-monitor.js
 * ----------------------
 * Onchain monitor for Beezie claw machines on Base, with a Telegram bot + memory.
 *
 * Three parts in one process:
 *   1. MONITOR  — scans the machines and pushes alerts automatically.
 *   2. CHAT BOT — grammY, listens for /status /machine /budget /breakeven /log /patterns /export /help.
 *   3. MEMORY   — writes state + window history to disk (data.json) so a restart
 *                 forgets nothing and you can review patterns over time.
 *
 * Setup:
 *   npm init -y && npm pkg set type=module && npm i viem grammy
 *   export BASE_RPC_URL="https://base-mainnet.g.alchemy.com/v2/YOUR_KEY"
 *   export TELEGRAM_BOT_TOKEN="..."  TELEGRAM_CHAT_ID="..."
 *   export DATA_DIR="/data"   # on Railway: attach a Volume at /data (otherwise ./data)
 *   node beezie-claw-monitor.js
 */

import { createPublicClient, http, parseAbi, parseAbiItem, formatUnits, getAddress } from "viem";
import { base } from "viem/chains";
import { Bot, InputFile } from "grammy";
import fs from "fs";
import path from "path";

// ---------------------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------------------
const CONFIG = {
  rpcUrl: process.env.BASE_RPC_URL || "https://mainnet.base.org",
  factory: getAddress("0x8b50bab7464764f6d102a9819b7db967256db14c"),
  collectibles: getAddress("0xbb5ec6fd4b61723bd45c399840f1d868840ca16f"),

  swapFee: 0.06,            // 6% fee on the buyback swap
  usdcDecimals: 6,

  evAlertUsd: 0,            // alert once average per play >= this (0 = break-even)
  costPerPointAlert: 0.01,  // alert once points cost <= this
  pullPtsPerUsd: 1,         // Beezie points per $ pulled
  swapPtsPerUsd: 1.5,       // Beezie points per $ swapped
  grailTopN: 5,             // how many top cards per machine to track
  endgamePoolFrac: 0.45,    // near-empty alert when pool < 45% of start AND grails still in
  reAlertCooldownMs: 30 * 60_000,

  pollSlowMs: 5 * 60_000,
  pollFastMs: 15_000,
  warmMarginUsd: 8,

  defaultBudgetUsd: 800,    // used by /budget with no argument

  dataDir: process.env.DATA_DIR || "./data",
  saveEveryMs: 60_000,
  windowLogMax: 50,

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

const state = new Map();
let windowLog = [];
let lastFactoryBlock = 0n;
let freshStart = true;

// ---------------------------------------------------------------------------
// MEMORY: load and save
// ---------------------------------------------------------------------------
const dataFile = path.join(CONFIG.dataDir, "data.json");
let lastSave = 0;

function loadState() {
  try {
    if (!fs.existsSync(dataFile)) { console.log("No saved memory — fresh start."); return; }
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
    console.log(`Memory loaded: ${state.size} machines, ${windowLog.length} windows in history.`);
  } catch (e) { console.error("memory load failed:", e.message); }
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
  } catch (e) { console.error("memory save failed:", e.message); }
}

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
// CHAT BOT (grammY)
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
  // /status — overview of all machines, with the best pick called out at the top
  bot.command(["status", "pools"], async (ctx) => {
    const blocks = [];
    const rank = []; // for picking the best
    for (const m of CONFIG.machines) {
      try {
        const d = await readPool(getAddress(m.address));
        if (d.finished || d.items.length === 0) { blocks.push(`<b>${m.label}</b>: empty`); continue; }
        if (d.paused) { blocks.push(`<b>${m.label}</b>: ⏸️ refilling (${d.items.length} cards)`); continue; }
        const s = stats(d.price, d.items);
        const top = [...d.items].sort((a, b) => b.value - a.value).slice(0, 3).map((i) => fmtK(i.value));
        const flag = s.ev >= 0 ? "🟢 " : s.costPerPoint <= CONFIG.costPerPointAlert ? "🪙 " : "";
        rank.push({ label: m.label, evPct: s.ev / d.price, ev: s.ev, cpp: s.costPerPoint });
        blocks.push(
          `${flag}<b>${m.label}</b>: ${d.items.length} cards\n` +
          `avg ${fmt2(s.ev)}/play · usually ${fmt2(s.modeNet)} · ${cppText(s.costPerPoint)}/pt\n` +
          `top: ${top.join(", ")}`
        );
      } catch { blocks.push(`<b>${m.label}</b>: read error`); }
    }
    // best line on top
    let header = "📊 <b>Status</b>";
    if (rank.length) {
      rank.sort((a, b) => b.evPct - a.evPct);
      const best = rank[0];
      header = best.ev >= 0
        ? `🎯 <b>Best now: ${best.label}</b> — favorable, ${fmt2(best.ev)}/play\n📊 <b>Status</b>`
        : `🎯 <b>Best now: ${best.label}</b> — least bad at ${fmt2(best.ev)}/play (none favorable, waiting is smarter)\n📊 <b>Status</b>`;
    }
    await ctx.reply(header + "\n\n" + blocks.join("\n\n"), { parse_mode: "HTML" });
  });

  // /machine <name> — deep dive on one machine
  bot.command("machine", async (ctx) => {
    const m = findMachine(ctx.match);
    if (!m) return ctx.reply("Which one? e.g. /machine platinum");
    try {
      const d = await readPool(getAddress(m.address));
      if (d.paused) return ctx.reply(`${m.label}: ⏸️ refilling now (${d.items.length} cards).`);
      if (d.items.length === 0) return ctx.reply(`${m.label}: empty.`);
      const s = stats(d.price, d.items);
      const sorted = [...d.items].sort((a, b) => b.value - a.value);
      const breakeven = d.price / (1 - CONFIG.swapFee);
      const topList = sorted.slice(0, 5).map((i) => `• ${fmtK(i.value)}`).join("\n");
      await ctx.reply(
        `<b>${m.label}</b> — ${d.items.length} cards\n` +
        `Cost ${fmt(d.price)} · avg <b>${fmt2(s.ev)}</b>/play · ${cppText(s.costPerPoint)}/pt\n` +
        `Most often you pull ${fmtK(s.modeVal)} (${(s.modeShare * 100).toFixed(0)}% of plays) = ${fmt2(s.modeNet)}\n` +
        `Win chance: ${(s.winRate * 100).toFixed(0)}%\n` +
        `Favorable once the average card clears ${fmt2(breakeven)} (now ${fmt2(s.mean)})\n` +
        `\nMost valuable cards now:\n${topList}`,
        { parse_mode: "HTML" }
      );
    } catch (e) { await ctx.reply(`Read error: ${e.message}`); }
  });

  // /budget <amount> — what a given budget does per machine
  bot.command("budget", async (ctx) => {
    const budget = Number(ctx.match) > 0 ? Number(ctx.match) : CONFIG.defaultBudgetUsd;
    const lines = [`💰 <b>With ${fmt(budget)}</b>`];
    for (const m of CONFIG.machines) {
      try {
        const d = await readPool(getAddress(m.address));
        if (d.paused || d.items.length === 0) { lines.push(`\n<b>${m.label}</b>: not playable now`); continue; }
        const s = stats(d.price, d.items);
        const plays = Math.floor(budget / d.price);
        if (plays === 0) { lines.push(`\n<b>${m.label}</b>: too expensive (${fmt(d.price)}/play)`); continue; }
        lines.push(
          `\n<b>${m.label}</b>: ${plays}× plays\n` +
          `expected result ${fmt2(s.ev * plays)} · usually around ${fmt2(s.modeNet * plays)}\n` +
          `points ~${Math.round(s.ptsPerLoop * plays)}`
        );
      } catch { lines.push(`\n<b>${m.label}</b>: read error`); }
    }
    await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
  });

  // /breakeven — how far each machine is from favorable
  bot.command("breakeven", async (ctx) => {
    const lines = ["📐 <b>Distance from favorable</b>"];
    for (const m of CONFIG.machines) {
      try {
        const d = await readPool(getAddress(m.address));
        if (d.paused || d.items.length === 0) { lines.push(`\n<b>${m.label}</b>: not playable`); continue; }
        const s = stats(d.price, d.items);
        const breakeven = d.price / (1 - CONFIG.swapFee);
        const gap = breakeven - s.mean;
        if (gap <= 0) { lines.push(`\n🟢 <b>${m.label}</b>: already favorable`); continue; }
        const cheap = d.items.filter((i) => i.value < s.mean).length;
        lines.push(
          `\n<b>${m.label}</b>: avg card ${fmt2(s.mean)}, needs ${fmt2(breakeven)} (+${fmt2(gap)})\n` +
          `pool ${d.items.length} · ~${cheap} cheap cards to go`
        );
      } catch { lines.push(`\n<b>${m.label}</b>: read error`); }
    }
    lines.push(`\nMachines usually only flip in the last ~45%. The bot tells you when it does.`);
    await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
  });

  // /log — last favorable windows
  bot.command("log", async (ctx) => {
    if (windowLog.length === 0) return ctx.reply("No windows in history yet. Once one happens, it shows up here.");
    const recent = windowLog.slice(-10).reverse();
    const lines = ["📜 <b>Last favorable windows</b>"];
    for (const w of recent) {
      const d = new Date(w.opened);
      const day = d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
      const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
      lines.push(`\n<b>${w.machine}</b> · ${day} ${time}\n${w.durationMin} min open · best ${fmt2(w.bestEv ?? 0)}/play`);
    }
    await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
  });

  // /patterns — rhythm per machine from history
  bot.command(["patterns", "pattern"], async (ctx) => {
    if (windowLog.length < 2) {
      return ctx.reply("Not enough windows yet to see a pattern. Useful after a few days of running.");
    }
    const perMachine = new Map();
    for (const w of windowLog) {
      if (!perMachine.has(w.machine)) perMachine.set(w.machine, []);
      perMachine.get(w.machine).push(w);
    }
    const lines = [`🧠 <b>Patterns</b> (from ${windowLog.length} windows)`];
    for (const [machine, ws] of perMachine) {
      const hours = ws.map((w) => new Date(w.opened).getHours());
      const durs = ws.map((w) => w.durationMin).filter((d) => d > 0);
      const bests = ws.map((w) => w.bestEv).filter((e) => typeof e === "number");
      const blocks = {};
      for (const h of hours) { const b = Math.floor(h / 3) * 3; blocks[b] = (blocks[b] || 0) + 1; }
      const topBlock = Number(Object.entries(blocks).sort((a, b) => b[1] - a[1])[0][0]);
      const avgDur = durs.length ? Math.round(durs.reduce((a, b) => a + b, 0) / durs.length) : null;
      const bestEv = bests.length ? Math.max(...bests) : null;
      lines.push(
        `\n<b>${machine}</b> · favorable ${ws.length}×\n` +
        `usually ${topBlock}:00–${topBlock + 3}:00` +
        (avgDur !== null ? ` · ~${avgDur} min open` : "") +
        (bestEv !== null ? ` · best ${fmt2(bestEv)}/play` : "")
      );
    }
    const counts = [...perMachine.entries()].sort((a, b) => b[1].length - a[1].length);
    lines.push(`\nMost favorable: <b>${counts[0][0]}</b>. Least: ${counts[counts.length - 1][0]}.`);
    const weekend = windowLog.filter((w) => [0, 6].includes(new Date(w.opened).getDay())).length;
    lines.push(`Weekend ${weekend} · weekdays ${windowLog.length - weekend}.`);
    await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
  });

  // /export — history as a file
  bot.command("export", async (ctx) => {
    if (windowLog.length === 0) return ctx.reply("No history to export yet.");
    try {
      const json = JSON.stringify({ exportedAt: new Date().toISOString(), windowLog }, null, 2);
      await ctx.replyWithDocument(
        new InputFile(Buffer.from(json, "utf8"), `beezie-history-${Date.now()}.json`),
        { caption: `${windowLog.length} windows.` }
      );
    } catch {
      await ctx.reply("Could not send a file, here as text:\n\n" + JSON.stringify(windowLog).slice(0, 3500));
    }
  });

  bot.command(["help", "start"], async (ctx) => {
    await ctx.reply(
      `<b>Commands</b>\n` +
      `/status — all machines + best pick on top\n` +
      `/machine platinum — deep dive on one machine\n` +
      `/budget 800 — what a budget does per machine\n` +
      `/breakeven — how close each machine is to favorable\n` +
      `/log — last favorable windows\n` +
      `/patterns — rhythm per machine (hour, duration, frequency)\n` +
      `/export — history as a file\n\n` +
      `You also get auto-alerts: favorable 🟢, cheap points 🪙, grail pulled 🎣, near-empty ⏳, refilling ⏸️🔄, new machine 🆕.`,
      { parse_mode: "HTML" }
    );
  });

  bot.catch((err) => console.error("bot error:", err.message));
}

// ---------------------------------------------------------------------------
// SHARED DATA FUNCTIONS
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
  } catch { /* name is nice-to-have */ }
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
// MONITOR LOOP
// ---------------------------------------------------------------------------
async function scan(m) {
  const addr = getAddress(m.address);
  let st = state.get(m.address);
  let data;
  try {
    if (!st) { data = await initMachine(m); st = state.get(m.address); }
    else data = await readPool(addr);
  } catch (e) { console.error(`${m.label}: ${e.message}`); return CONFIG.pollSlowMs; }

  if (data.finished || data.items.length === 0) { console.log(`${m.label}: empty`); return CONFIG.pollSlowMs; }

  if (data.paused) {
    if (!st.wasPaused) {
      st.wasPaused = true;
      closeWindow(st, m.label);
      await tg(`⏸️ <b>${m.label} — refilling</b>\nCan't play now · changes are Beezie's own\nDo: ignore until it reopens`);
    }
    const inPoolPaused = new Set(data.items.map((i) => i.id));
    for (const [id] of st.grails) if (!inPoolPaused.has(id)) st.grails.delete(id);
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
      `🔄 <b>${m.label} — reopened</b>\n` +
      `avg ${fmt2(sf.ev)}/play · ${cppText(sf.costPerPoint)}/pt · pool ${sf.n}\n` +
      `Top cards: ${top.slice(0, 5).map((g) => fmtK(g.value)).join(", ")}\n` +
      (st.windowOpen ? `🚨 Do: check now, opens favorable` : `Do: not interesting yet, wait until it's near-empty`)
    );
    return CONFIG.pollFastMs;
  }
  if (data.items.length > st.initialPoolSize * 1.15) {
    st.initialPoolSize = data.items.length;
    const top = [...data.items].sort((a, b) => b.value - a.value).slice(0, CONFIG.grailTopN);
    st.grails = new Map();
    for (const g of top) st.grails.set(g.id, { value: g.value, name: await grailName(g.id) });
    await tg(`🔄 <b>${m.label} — just refilled</b>\nPool back to ${data.items.length} · top cards reloaded`);
  }

  const s = stats(data.price, data.items);
  const inPool = new Set(data.items.map((i) => i.id));

  if (freshStart) {
    for (const [id] of st.grails) if (!inPool.has(id)) st.grails.delete(id);
  } else {
    for (const [id, g] of st.grails) {
      if (!inPool.has(id)) {
        st.grails.delete(id);
        const left = [...st.grails.values()].map((x) => fmtK(x.value)).join(", ") || "none";
        await tg(`🎣 <b>${m.label} — grail pulled</b>\n${g.name} (${fmtK(g.value)}) was pulled\nLeft: ${left} · pool ${s.n} · avg ${fmt2(s.ev)}/play`);
      }
    }
  }

  const grailValueLeft = [...st.grails.values()].reduce((a, g) => a + g.value, 0);
  const cpp = s.costPerPoint;

  if (s.ev >= CONFIG.evAlertUsd && cooldownOk(st, "ev")) {
    openWindow(st, m.label, s.ev);
    await tg(
      `🟢 <b>${m.label} — favorable now</b>\n` +
      `avg <b>${fmt2(s.ev)}</b>/play · ${cppText(cpp)}/pt · ${(s.winRate * 100).toFixed(0)}% win chance\n` +
      `But usually you pull ${fmtK(s.modeVal)} = ${fmt2(s.modeNet)} (${(s.modeShare * 100).toFixed(0)}% of plays)\n` +
      `Pool ${s.n} · grails still in ${fmtK(grailValueLeft)}\n` +
      `Do: play — pull first, handle swaps after`
    );
  } else if (s.ev >= CONFIG.evAlertUsd) {
    openWindow(st, m.label, s.ev);
  }

  if (s.ev < CONFIG.evAlertUsd && cpp <= CONFIG.costPerPointAlert && cooldownOk(st, "pts")) {
    openWindow(st, m.label, s.ev);
    await tg(
      `🪙 <b>${m.label} — points cheap</b>\n` +
      `<b>${cppText(cpp)}</b> per point · ~${Math.round(s.ptsPerLoop)} points per play\n` +
      `But usually you pull ${fmtK(s.modeVal)} = ${fmt2(s.modeNet)} (${(s.modeShare * 100).toFixed(0)}% of plays)\n` +
      `Pool ${s.n}\nDo: farm points (pull → swap) until the 🔒 message`
    );
  }

  if (st.windowOpen && s.ev < CONFIG.evAlertUsd && cpp > CONFIG.costPerPointAlert) {
    closeWindow(st, m.label);
    await tg(`🔒 <b>${m.label} — no longer favorable</b>\navg ${fmt2(s.ev)}/play · ${cppText(cpp)}/pt\nDo: stop`);
  }

  const frac = s.n / st.initialPoolSize;
  if (frac <= CONFIG.endgamePoolFrac && st.grails.size > 0 && cooldownOk(st, "endgame")) {
    await tg(
      `⏳ <b>${m.label} — near-empty, watch</b>\n` +
      `${s.n} cards left (${(frac * 100).toFixed(0)}% remaining) · ${st.grails.size} grails ${fmtK(grailValueLeft)} still in\n` +
      `avg ${fmt2(s.ev)}/play and improving as it drains\nDo: stand by, could turn favorable soon`
    );
  }

  console.log(`${m.label}: pool ${s.n} (${(frac * 100).toFixed(0)}%) | avg ${fmt2(s.ev)} | usually ${fmt2(s.modeNet)} | ${cppText(cpp)}/pt`);

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
      const m = { label: `${fmt(data.price)} (new)`, address: addr };
      CONFIG.machines.push(m);
      await initMachine(m).catch(() => {});
      await tg(`🆕 <b>New ${fmt(data.price)} machine</b>\nPool ${s.n} · avg ${fmt2(s.ev)}/play\nDo: not interesting yet, watching it`);
    }
  } catch (e) { console.error("factory:", e.message); }
}

async function monitorLoop() {
  console.log(`Monitor started — ${CONFIG.machines.length} machines\n`);
  for (const m of CONFIG.machines) {
    if (!state.has(m.address)) await initMachine(m).catch((e) => console.error(`init ${m.label}: ${e.message}`));
  }
  for (;;) {
    await checkFactory();
    let delay = CONFIG.pollSlowMs;
    for (const m of CONFIG.machines) delay = Math.min(delay, await scan(m));
    freshStart = false;
    saveState();
    console.log(`— next scan in ${Math.round(delay / 1000)}s —\n`);
    await new Promise((r) => setTimeout(r, delay));
  }
}

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => { console.log(`\n${sig} — saving memory...`); saveState(true); process.exit(0); });
}

// ---------------------------------------------------------------------------
// START
// ---------------------------------------------------------------------------
loadState();
if (bot) bot.start({ onStart: () => console.log("Chat bot listening (long polling).") });
monitorLoop().catch((e) => { console.error(e); saveState(true); process.exit(1); });
