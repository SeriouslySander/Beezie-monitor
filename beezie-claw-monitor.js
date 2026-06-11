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
  const [price, finished, pool] = await Promise.all([
    client.readContract({ address, abi: machineAbi, functionName: "price" }),
    client.readContract({ address, abi: machineAbi, functionName: "isFinished" }),
    client.readContract({ address, abi: machineAbi, functionName: "getPrizePool" }),
  ]);
  return {
    price: usd(price),
    finished,
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
  return { n, mean, ev, winRate };
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
  state.set(m.address, { initialPoolSize: data.items.length, grails, lastAlert: {} });
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

  const s = stats(data.price, data.items);
  const inPool = new Set(data.items.map((i) => i.id));

  // 2) GRAIL-alerts: gevolgde topkaart verdwenen uit de pool
  for (const [id, g] of st.grails) {
    if (!inPool.has(id)) {
      st.grails.delete(id);
      await tg(
        `🎣 <b>GRAIL GETROKKEN uit ${m.label}</b>\n${g.name} (${fmt(g.value)}) is uit de pool.\n` +
        `Resterende grails: ${st.grails.size ? [...st.grails.values()].map((x) => `${x.name} ${fmt(x.value)}`).join(", ") : "geen"}\n` +
        `Pool nu ${s.n} | EV ${fmt2(s.ev)}/pull`
      );
    }
  }

  const grailValueLeft = [...st.grails.values()].reduce((a, g) => a + g.value, 0);

  // 1) EV-FLIP
  if (s.ev >= CONFIG.evAlertUsd && cooldownOk(st, "ev")) {
    await tg(
      `🟢 <b>+EV: ${m.label}</b>\nEV per pull: <b>${fmt2(s.ev)}</b> (netto, na 6% fee)\n` +
      `Pool ${s.n} | gem swap ${fmt2(s.mean)} | winrate ${(s.winRate * 100).toFixed(1)}%\n` +
      `Grails nog aanwezig: ${fmt(grailValueLeft)}\nhttps://basescan.org/address/${addr}`
    );
  }

  // 3) ENDGAME: pool sterk gekrompen, grails nog binnen
  const frac = s.n / st.initialPoolSize;
  if (frac <= CONFIG.endgamePoolFrac && st.grails.size > 0 && cooldownOk(st, "endgame")) {
    await tg(
      `⏳ <b>ENDGAME: ${m.label}</b>\nPool gekrompen naar ${s.n} (${(frac * 100).toFixed(0)}% van start) ` +
      `met nog ${st.grails.size} grails t.w.v. ${fmt(grailValueLeft)} erin.\n` +
      `EV ${fmt2(s.ev)}/pull en stijgend naarmate de pool krimpt — houd deze in de gaten.`
    );
  }

  console.log(
    `${m.label}: pool ${s.n} (${(frac * 100).toFixed(0)}%) | EV ${fmt2(s.ev)} | ` +
    `grails ${st.grails.size} (${fmt(grailValueLeft)})`
  );

  const warm = s.ev >= CONFIG.evAlertUsd - CONFIG.warmMarginUsd || frac <= CONFIG.endgamePoolFrac;
  return warm ? CONFIG.pollFastMs : CONFIG.pollSlowMs;
}

// 4) NIEUWE machines via factory
async function checkFactory() {
  try {
    const latest = await client.getBlockNumber();
    if (lastFactoryBlock === 0n) lastFactoryBlock = latest - 200n;
    const logs = await client.getLogs({
      address: CONFIG.factory, event: clawCreated,
      fromBlock: lastFactoryBlock + 1n, toBlock: latest,
    });
    lastFactoryBlock = latest;
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
        `🆕 <b>Nieuwe ${fmt(data.price)} machine live</b>\nVolle pool: ${s.n} kaarten | EV ${fmt2(s.ev)}/pull\n` +
        `https://basescan.org/address/${addr}`
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
