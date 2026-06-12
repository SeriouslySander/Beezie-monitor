/**
 * beezie-claw-monitor.js
 * ----------------------
 * Onchain +EV-detector voor Beezie claw-machines op Base.
 *
 * Alerts via Telegram bij:
 *  1. EV-FLIP    — netto EV per pull (na swap-fee) wordt positief op een machine
 *  2. GRAIL      — een gevolgde grail (top-kaart) verdwijnt uit de pool (getrokken!)
 *  3. ENDGAME    — pool krimpt onder een drempel terwijl er nog grails in zitten
 *  4. NIEUW      — de factory zet een verse machine live (vol = alle grails aanwezig)
 *
 * Alles komt rechtstreeks uit de contracten: getPrizePool() geeft per kaart de
 * exacte swapValue. Geen frontend, geen schattingen.
 *
 * Setup:
 *   npm init -y && npm pkg set type=module && npm i viem
 *   export BASE_RPC_URL="https://base-mainnet.g.alchemy.com/v2/JOUW_KEY"
 *   export TELEGRAM_BOT_TOKEN="..."  TELEGRAM_CHAT_ID="..."
 *   node beezie-claw-monitor.js
 */

import { createPublicClient, http, parseAbi, parseAbiItem, formatUnits, getAddress } from "viem";
import { base } from "viem/chains";

// ---------------------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------------------
const CONFIG = {
  rpcUrl: process.env.BASE_RPC_URL || "https://mainnet.base.org",
  factory: getAddress("0x8b50bab7464764f6d102a9819b7db967256db14c"),
  collectibles: getAddress("0xbb5ec6fd4b61723bd45c399840f1d868840ca16f"),

  swapFee: 0.06,            // 6% fee op buyback-swap
  usdcDecimals: 6,

  // Alert-drempels
  evAlertUsd: 0,            // alert zodra EV per pull >= dit bedrag (0 = breakeven)
  costPerPointAlert: 0.01,  // alert zodra kostprijs per punt <= dit bedrag ($0.01)
  pullPtsPerUsd: 1,         // Beezie-punten per $ pull
  swapPtsPerUsd: 1.5,       // Beezie-punten per $ swap (over bruto swap-waarde)
  grailTopN: 5,             // volg de top-N kaarten per machine als 'grails'
  endgamePoolFrac: 0.45,    // ENDGAME-alert als pool < 45% van eerste meting én grails aanwezig
  reAlertCooldownMs: 30 * 60_000,

  // Poll-tempo (adaptief)
  pollSlowMs: 5 * 60_000,   // koud: elke 5 min
  pollFastMs: 15_000,       // warm: elke 15s
  warmMarginUsd: 8,         // 'warm' = EV binnen $8 van de drempel, of endgame actief

  // Actieve machines (peil 7 jun 2026). Nieuwe komen automatisch binnen via factory.
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
const erc721Abi = parseAbi([
  "function tokenURI(uint256 tokenId) view returns (string)",
]);
const clawCreated = parseAbiItem("event ClawMachineCreated(address indexed clawMachine)");

const client = createPublicClient({ chain: base, transport: http(CONFIG.rpcUrl) });
const usd = (v) => Number(formatUnits(v, CONFIG.usdcDecimals));
const fmt = (n) => `$${Number(n).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
const fmt2 = (n) => `$${Number(n).toFixed(2)}`;
const fmtK = (n) => (n >= 1000 ? `$${(n / 1000).toFixed(1)}k` : `$${Math.round(n)}`);

// state per machine
// { initialPoolSize, grails: Map<tokenId, {value, name}>, lastAlert: {} }
const state = new Map();
let lastFactoryBlock = 0n;

async function tg(text) {
  console.log("[ALERT]", text.replace(/<[^>]+>/g, "").replace(/\n/g, " | "));
  const { botToken, chatId } = CONFIG.telegram;
  if (!botToken || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true }),
    });
  } catch (e) { console.error("telegram:", e.message); }
}

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
    price: usd(price),
    finished,
    paused,
    items: pool.map((p) => ({ id: Number(p.tokenId), value: usd(p.swapValue) })),
  };
}

function stats(priceUsd, items) {
  const n = items.length;
  const vals = items.map((i) => i.value);
  const mean = vals.reduce((a, b) => a + b, 0) / n;
  const net = mean * (1 - CONFIG.swapFee);
  const ev = net - priceUsd;
  const winRate = vals.filter((v) => v * (1 - CONFIG.swapFee) >= priceUsd).length / n;
  // punten per pull+swap-lus en kostprijs per punt (house edge / punten)
  const ptsPerLoop = priceUsd * CONFIG.pullPtsPerUsd + mean * CONFIG.swapPtsPerUsd;
  const costPerPoint = -ev / ptsPerLoop; // negatief = je wordt betaald per punt
  return { n, mean, ev, winRate, ptsPerLoop, costPerPoint };
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
  state.set(m.address, { initialPoolSize: data.items.length, grails, lastAlert: {}, wasPaused: data.paused, windowOpen: false });
  const s = stats(data.price, data.items);
  console.log(`init ${m.label}: pool ${s.n}, EV ${fmt2(s.ev)}, grails: ${[...grails.values()].map((g) => `${g.name} (${fmt(g.value)})`).join(" | ")}`);
  return data;
}

async function scan(m) {
  const addr = getAddress(m.address);
  let st = state.get(m.address);
  let data;
  try {
    if (!st) { data = await initMachine(m); st = state.get(m.address); }
    else data = await readPool(addr);
  } catch (e) { console.error(`${m.label}: ${e.message}`); return CONFIG.pollSlowMs; }

  if (data.finished || data.items.length === 0) {
    console.log(`${m.label}: finished/leeg`);
    return CONFIG.pollSlowMs;
  }

  // --- PAUZE = RESTOCK BEZIG ---
  if (data.paused) {
    if (!st.wasPaused) {
      st.wasPaused = true;
      await tg(
        `⏸️ <b>${m.label} — restock bezig</b>\n` +
        `Pulls onmogelijk · poolwijzigingen = beheer\n` +
        `Actie: negeren tot heropening`
      );
    }
    // Tijdens pauze: grail-verdwijningen zijn admin-verwijderingen — stil bijwerken, niet alerten.
    const inPoolPaused = new Set(data.items.map((i) => i.id));
    for (const [id, g] of st.grails) {
      if (!inPoolPaused.has(id)) {
        st.grails.delete(id);
        console.log(`${m.label}: ⚙️ ${g.name} (${fmt(g.value)}) verwijderd tijdens restock (geen pull)`);
      }
    }
    return CONFIG.pollFastMs; // snel pollen: de unpause is het meetmoment
  }
  if (st.wasPaused) {
    // Unpause: venster mogelijk open. Volledige her-initialisatie + verse meting.
    st.wasPaused = false;
    st.initialPoolSize = data.items.length;
    const top = [...data.items].sort((a, b) => b.value - a.value).slice(0, CONFIG.grailTopN);
    st.grails = new Map();
    for (const g of top) st.grails.set(g.id, { value: g.value, name: await grailName(g.id) });
    const sf = stats(data.price, data.items);
    const cppF = sf.costPerPoint;
    const cppFTxt = cppF <= 0 ? `−$${Math.abs(cppF).toFixed(3)} (betaald!)` : `$${cppF.toFixed(3)}`;
    st.windowOpen = sf.ev >= CONFIG.evAlertUsd || cppF <= CONFIG.costPerPointAlert;
    await tg(
      `🔄 <b>${m.label} — weer open</b>\n` +
      `EV ${fmt2(sf.ev)} · ${cppFTxt}/punt · pool ${sf.n} · win ${(sf.winRate * 100).toFixed(0)}%\n` +
      `Top: ${top.slice(0, 5).map((g) => fmtK(g.value)).join(", ")}\n` +
      (st.windowOpen ? `Actie: 🚨 opent +EV — NU kijken` : `Actie: baseline, wachten op eindspel`)
    );
    return CONFIG.pollFastMs;
  }
  // Fallback: pool groeit fors zonder dat we de pauze zagen (gemist tussen polls)
  if (data.items.length > st.initialPoolSize * 1.15) {
    st.initialPoolSize = data.items.length;
    const top = [...data.items].sort((a, b) => b.value - a.value).slice(0, CONFIG.grailTopN);
    st.grails = new Map();
    for (const g of top) st.grails.set(g.id, { value: g.value, name: await grailName(g.id) });
    await tg(`🔄 <b>${m.label} — pool fors gegroeid</b>\nRestock gemist · baseline en grails ververst · pool ${data.items.length}`);
  }

  const s = stats(data.price, data.items);
  const inPool = new Set(data.items.map((i) => i.id));

  // 2) GRAIL-alerts: gevolgde topkaart verdwenen uit de pool
  for (const [id, g] of st.grails) {
    if (!inPool.has(id)) {
      st.grails.delete(id);
      const left = [...st.grails.values()].map((x) => fmtK(x.value)).join(", ") || "geen";
      await tg(
        `🎣 <b>${m.label} — grail eruit</b>\n` +
        `${g.name} (${fmtK(g.value)}) getrokken\n` +
        `Nog: ${left} · pool ${s.n} · EV ${fmt2(s.ev)}`
      );
    }
  }

  const grailValueLeft = [...st.grails.values()].reduce((a, g) => a + g.value, 0);
  const cpp = s.costPerPoint;
  const cppTxt = cpp <= 0 ? `−$${Math.abs(cpp).toFixed(3)} (betaald!)` : `$${cpp.toFixed(3)}`;

  // 1) EV-FLIP
  if (s.ev >= CONFIG.evAlertUsd && cooldownOk(st, "ev")) {
    st.windowOpen = true;
    await tg(
      `🟢 <b>${m.label} — +EV OPEN</b>\n` +
      `EV <b>${fmt2(s.ev)}</b>/pull · ${cppTxt}/punt · win ${(s.winRate * 100).toFixed(0)}%\n` +
      `Pool ${s.n} · swap ${fmt2(s.mean)} · grails ${fmtK(grailValueLeft)}\n` +
      `Actie: NU spelen — pulls eerst, swaps in batch`
    );
  }

  // 1b) GOEDKOPE PUNTEN: kostprijs per punt onder drempel (maar nog geen +EV)
  if (s.ev < CONFIG.evAlertUsd && cpp <= CONFIG.costPerPointAlert && cooldownOk(st, "pts")) {
    st.windowOpen = true;
    await tg(
      `🪙 <b>${m.label} — goedkope punten</b>\n` +
      `<b>${cppTxt}</b>/punt · ~${Math.round(s.ptsPerLoop)} pt/lus · EV ${fmt2(s.ev)}\n` +
      `Pool ${s.n} · swap ${fmt2(s.mean)}\n` +
      `Actie: farmen (pull → swap) tot 🔒`
    );
  }

  // 1c) VENSTER DICHT: was open, maar EV én puntenprijs zijn terug boven de drempels
  if (st.windowOpen && s.ev < CONFIG.evAlertUsd && cpp > CONFIG.costPerPointAlert) {
    st.windowOpen = false;
    await tg(
      `🔒 <b>${m.label} — venster dicht</b>\n` +
      `EV ${fmt2(s.ev)} · ${cppTxt}/punt\n` +
      `Actie: stoppen`
    );
  }

  // 3) ENDGAME: pool sterk gekrompen, grails nog binnen
  const frac = s.n / st.initialPoolSize;
  if (frac <= CONFIG.endgamePoolFrac && st.grails.size > 0 && cooldownOk(st, "endgame")) {
    await tg(
      `⏳ <b>${m.label} — eindspel</b>\n` +
      `Pool ${s.n} (${(frac * 100).toFixed(0)}% van start) · ${st.grails.size} grails ${fmtK(grailValueLeft)}\n` +
      `EV ${fmt2(s.ev)} en stijgend\n` +
      `Actie: standby, flip kan komen`
    );
  }

  console.log(
    `${m.label}: pool ${s.n} (${(frac * 100).toFixed(0)}%) | EV ${fmt2(s.ev)} | ` +
    `${cppTxt}/punt | grails ${st.grails.size} (${fmt(grailValueLeft)})`
  );

  const warm =
    s.ev >= CONFIG.evAlertUsd - CONFIG.warmMarginUsd ||
    cpp <= CONFIG.costPerPointAlert * 2 ||
    frac <= CONFIG.endgamePoolFrac;
  return warm ? CONFIG.pollFastMs : CONFIG.pollSlowMs;
}

// 4) NIEUWE machines via factory
async function checkFactory() {
  try {
    const latest = await client.getBlockNumber();
    if (lastFactoryBlock === 0n) lastFactoryBlock = latest - 1n;
    // Alchemy free tier staat maar een klein blok-bereik per eth_getLogs toe:
    // scan daarom in chunks van max 10 blokken, en max 30 chunks per ronde.
    const CHUNK = 10n;
    const logs = [];
    let from = lastFactoryBlock + 1n;
    let rounds = 0;
    while (from <= latest && rounds < 30) {
      const to = from + CHUNK - 1n > latest ? latest : from + CHUNK - 1n;
      const part = await client.getLogs({
        address: CONFIG.factory, event: clawCreated,
        fromBlock: from, toBlock: to,
      });
      logs.push(...part);
      lastFactoryBlock = to;
      from = to + 1n;
      rounds++;
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
      await tg(
        `🆕 <b>${fmt(data.price)} — nieuwe machine</b>\n` +
        `Pool ${s.n} · EV ${fmt2(s.ev)}\n` +
        `Actie: baseline, ik volg hem vanaf nu`
      );
    }
  } catch (e) { console.error("factory:", e.message); }
}

async function main() {
  console.log(`Beezie claw-monitor — ${CONFIG.machines.length} machines, EV-drempel ${fmt2(CONFIG.evAlertUsd)}, grail top-${CONFIG.grailTopN}\n`);
  for (const m of CONFIG.machines) await initMachine(m).catch((e) => console.error(`init ${m.label}: ${e.message}`));
  for (;;) {
    await checkFactory();
    let delay = CONFIG.pollSlowMs;
    for (const m of CONFIG.machines) delay = Math.min(delay, await scan(m));
    console.log(`— volgende scan over ${Math.round(delay / 1000)}s —\n`);
    await new Promise((r) => setTimeout(r, delay));
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
