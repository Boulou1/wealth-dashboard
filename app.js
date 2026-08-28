/* ============================================================================
   Wealth Dashboard — single-file app logic
   - FIFO cost-basis engine (validated against the source spreadsheet)
   - Live prices: CoinGecko (crypto, no key) + Finnhub (stocks, your key) + FX
   - All state persists in this browser's localStorage
   ============================================================================ */

/* ---- Asset → price-source mapping (generic market metadata, safe to commit) */
const ASSET_META = {
  "BTC": { cls: "crypto", src: "coingecko", id: "bitcoin" },
  "ETH": { cls: "crypto", src: "coingecko", id: "ethereum" },
  "SOL": { cls: "crypto", src: "coingecko", id: "solana" },
  "COIN": { cls: "stock", src: "finnhub", sym: "COIN" },
  "Galaxy Digital": { cls: "stock", src: "finnhub", sym: "GLXY" },
  "GRAB": { cls: "stock", src: "finnhub", sym: "GRAB" },
  "Nebius Group (A)": { cls: "stock", src: "finnhub", sym: "NBIS" },
  "AVGO": { cls: "stock", src: "finnhub", sym: "AVGO" },
  "NOW": { cls: "stock", src: "mexc", sym: "NOWONUSDT" },  // tokenized on MEXC; price used as-is (~528)
  "PYPL": { cls: "stock", src: "finnhub", sym: "PYPL" },
  "HOOD": { cls: "stock", src: "finnhub", sym: "HOOD" },
  "SOFI": { cls: "stock", src: "finnhub", sym: "SOFI" },
  "NVDA": { cls: "stock", src: "finnhub", sym: "NVDA" },
  "TSLA": { cls: "stock", src: "finnhub", sym: "TSLA" },
  "TMDX": { cls: "stock", src: "finnhub", sym: "TMDX" },
  "SBET": { cls: "stock", src: "finnhub", sym: "SBET" },
  "Zeta Global Holdings": { cls: "stock", src: "finnhub", sym: "ZETA" },
  "Corning": { cls: "stock", src: "finnhub", sym: "GLW" },
  "ENHA": { cls: "stock", src: "finnhub", sym: "ENHA" },  // Enhanced Group Inc. (NYSE: ENHA)
  "FLOWDESK": { cls: "stock", src: "manual" },
  "Air Liquide": { cls: "stock", src: "manual" },
  "S&P 500 EUR (Acc)": { cls: "stock", src: "manual" },
  "MSCI Emerging Asia PEA ESG Leaders EUR (Acc)": { cls: "stock", src: "manual" },
};
function metaFor(asset) {
  const base = ASSET_META[asset] || { cls: "stock", src: "manual" };
  const u = (typeof STATE !== "undefined" && STATE && STATE.assetMeta) ? STATE.assetMeta[asset] : null;
  return u ? { ...base, ...u } : base;   // user registry (new/edited assets) overrides built-ins
}
// Price multiplier (user override wins over the config default)
function multFor(asset) {
  const o = STATE && STATE.settings && STATE.settings.multipliers;
  if (o && o[asset] != null && !isNaN(o[asset])) return Number(o[asset]);
  return metaFor(asset).mult || 1;
}

const LS_KEY = "wealth_state_v1";
// Shared page password for PUBLIC deploys: SHA-256 hex of the password everyone must enter.
// Empty string = per-device passcode (local use). Set this for the public GitHub Pages site.
const GATE_HASH = "";
const EPS = 1e-6;

/* ============================ State ============================ */
let STATE = null;   // { trades, snapshots, manualPrices, livePrices, fxEURUSD, settings }
let VIEW = { ccy: "USD", sparkRange: "1Y", holdSort: { key: "mv", dir: -1 }, closedSort: { key: "realized", dir: -1 } };

function defaultState() {
  const seed = window.__SEED__ || {};
  return {
    version: 1,
    trades: seed.trades ? structuredClone(seed.trades) : [],
    snapshots: seed.snapshots ? structuredClone(seed.snapshots) : [],
    manualPrices: seed.manualPrices ? { ...seed.manualPrices } : {},
    livePrices: {},                        // asset -> {price, changePct, prevClose, ts}
    cash: [],                              // ledger: {date, ccy, amount(signed), kind, note, tradeId?, grp?}
    interest: [],                          // {date, kind:'received'|'paid', ccy, amount, note, source}
    savings: [],                           // {id, name, ccy, rate, compound, monthly, anchorDate, anchorBalance}
    wallets: [],                           // {id, name, address, kind:'hyperliquid'}
    execRefs: {},                          // 'asset|date' -> {c,h,l} bougie du jour (qualité d'exécution)
    assetMeta: {},                         // user asset registry: asset -> {cls, src, sym}
    fxEURUSD: seed.fxEURUSD || 1.10,
    settings: { finnhubKey: "", multipliers: {} },
  };
}
function loadState() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) {}
  return null;
}
function saveLocal() {   // localStorage only (no GitHub push) — used for the daily value snapshot
  try { localStorage.setItem(LS_KEY, JSON.stringify(STATE)); } catch (e) {}
}
function saveState() {
  saveLocal();
  if (typeof ghAutoBackup === "function") ghAutoBackup();   // debounced push to private GitHub, if enabled
}

/* ============================ Utils ============================ */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const el = (tag, cls, html) => { const n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; };

async function sha256(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

const FX = () => STATE.fxEURUSD || 1.10;
const toCcy = (usd) => VIEW.ccy === "EUR" ? usd / FX() : usd;    // base is USD
const SYM = () => VIEW.ccy === "EUR" ? "€" : "$";

/* ---- Cash ledger (base = USD; USDT pegged 1:1 to USD) ---- */
const CCYS = ["USD", "EUR", "USDT", "USDC"];
const ccySym = (c) => c === "EUR" ? "€" : c === "USDT" ? "₮" : "$";
const ccyToUSD = (amount, ccy) => ccy === "EUR" ? amount * FX() : amount;   // USD, USDT, USDC ≈ 1
function cashBalances() {
  const b = {}; CCYS.forEach(c => b[c] = 0);
  for (const e of (STATE.cash || [])) b[e.ccy] = (b[e.ccy] || 0) + e.amount;
  return b;
}
const totalCashUSD = () => { const b = cashBalances(); return Object.keys(b).reduce((s, c) => s + ccyToUSD(b[c], c), 0); };

/* ---- On-chain wallets (live). Hyperliquid: public API, CORS-open, no key needed. ---- */
const HL_STABLE = /^(USDC|USDT0?|USDE|USDH|FEUSD|USDXL)$/i;
async function fetchHyperliquid(addr) {
  const post = body => fetchJSON("https://api.hyperliquid.xyz/info", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const [perp, spot, mids, fills, funding] = await Promise.all([
    post({ type: "clearinghouseState", user: addr }),
    post({ type: "spotClearinghouseState", user: addr }),
    post({ type: "allMids" }),
    post({ type: "userFills", user: addr }).catch(() => []),
    post({ type: "userFunding", user: addr, startTime: 0 }).catch(() => []),
  ]);
  const perps = parseFloat((perp && perp.marginSummary && perp.marginSummary.accountValue) || 0) || 0;
  let spotUSD = 0; const holdings = [];
  for (const b of ((spot && spot.balances) || [])) {
    const q = parseFloat(b.total);
    if (!(q > 0)) continue;
    let px = HL_STABLE.test(b.coin) ? 1 : parseFloat((mids || {})[b.coin]);
    if (!isFinite(px)) px = 0;                       // unknown token → don't invent value
    spotUSD += q * px;
    holdings.push({ coin: b.coin, qty: q, px, usd: q * px });
  }
  const positions = ((perp && perp.assetPositions) || []).map(a => ({
    coin: (a.position || {}).coin, szi: parseFloat((a.position || {}).szi || 0),
    upnl: parseFloat((a.position || {}).unrealizedPnl || 0),
    entry: parseFloat((a.position || {}).entryPx || 0),
  })).filter(p => p.szi);
  // P&L straight from Hyperliquid: realized (closedPnl) net of fees and funding, plus open unrealized
  const F = Array.isArray(fills) ? fills : [];
  const realized = F.reduce((a, f) => a + (parseFloat(f.closedPnl) || 0), 0);
  const fees = F.reduce((a, f) => a + (parseFloat(f.fee) || 0), 0);
  const fundingNet = (Array.isArray(funding) ? funding : [])
    .reduce((a, x) => a + (parseFloat(((x || {}).delta || {}).usdc) || 0), 0);
  const upnl = positions.reduce((a, p) => a + (p.upnl || 0), 0);
  const netPnl = realized - fees + fundingNet + upnl;
  return { value: perps + spotUSD, perps, spot: spotUSD, holdings, positions,
    realized, fees, funding: fundingNet, upnl, netPnl, fillCount: F.length, ts: Date.now() };
}
/* ---- Wallets on-chain natifs (Phantom & co) : Solana / Ethereum / Bitcoin, sans clé ----
   Prix pris sur les feeds déjà chargés (CoinGecko). Mode watch-only possible pour vérifier
   des positions déjà suivies dans le trade log sans les compter deux fois. ---- */
async function fetchChainWallet(w) {
  const pm = buildPriceMap();
  const px = a => (pm[a] && pm[a].price) || 0;
  let coin, qty;
  if (w.kind === "solana") {
    const r = await fetchJSON("https://solana-rpc.publicnode.com", {   // l'endpoint officiel renvoie 403 aux navigateurs
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getBalance", params: [w.address] }) });
    coin = "SOL"; qty = ((r.result || {}).value || 0) / 1e9;
  } else if (w.kind === "ethereum") {
    const r = await fetchJSON("https://ethereum-rpc.publicnode.com", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getBalance", params: [w.address, "latest"] }) });
    coin = "ETH"; qty = parseInt(r.result || "0x0", 16) / 1e18;
  } else if (w.kind === "bitcoin") {
    const d = await fetchJSON(`https://blockstream.info/api/address/${encodeURIComponent(w.address)}`);
    const cs = d.chain_stats || {}, ms = d.mempool_stats || {};
    coin = "BTC"; qty = ((cs.funded_txo_sum || 0) - (cs.spent_txo_sum || 0) + (ms.funded_txo_sum || 0) - (ms.spent_txo_sum || 0)) / 1e8;
  } else return null;
  const p = px(coin), usd = qty * p;
  return { value: usd, spot: usd, perps: 0, holdings: [{ coin, qty, px: p, usd }], positions: [], chain: w.kind, ts: Date.now() };
}
const ADDR_RE = {
  hyperliquid: /^0x[0-9a-fA-F]{40}$/, ethereum: /^0x[0-9a-fA-F]{40}$/,
  solana: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/,
  bitcoin: /^(bc1[0-9a-z]{20,60}|[13][1-9A-HJ-NP-Za-km-z]{25,34})$/,
};
function trackedQty(asset) {
  let q = 0;
  for (const t of STATE.trades) { if (t.asset !== asset) continue; q += String(t.side).toLowerCase() === "buy" ? Math.abs(t.qty) : -Math.abs(t.qty); }
  return q;
}

function walletTotals() {
  let usd = 0, live = 0, pnl = 0, hasPnl = false, watch = 0;
  for (const w of (STATE.wallets || [])) {
    const d = (STATE.liveWallets || {})[w.address];
    const counted = w.counted !== false;
    if (!counted) { if (d) live++; watch++; continue; }        // watch-only : vérification, pas de valeur
    if (d && isFinite(d.value)) { usd += d.value; live++; if (isFinite(d.netPnl)) { pnl += d.netPnl; hasPnl = true; } }
    else if (isFinite(w.manualValue)) usd += Number(w.manualValue);
  }
  return { usd, live, pnl, hasPnl, watch, count: (STATE.wallets || []).length };
}

/* ---- Savings accounts: {id, name, ccy, rate, compound:"daily"|"annual", monthly, anchorDate, anchorBalance} ----
   Balance is projected forward from a known anchor: contributions land on the 1st, interest accrues daily.
   "annual" accounts hold accrued interest as `pending` until it's credited at year end (PEL-style). ---- */
function savingsProject(acc, todayStr) {
  let bal = Number(acc.anchorBalance) || 0;
  let pending = Number(acc.anchorPending) || 0;   // accrued but not yet credited (e.g. PEL mid-year)
  let contributed = 0;
  let interest = Number(acc.anchorInterest) || 0;   // interest already earned before the anchor date
  const dayRate = (Number(acc.rate) || 0) / 365;
  const monthly = Number(acc.monthly) || 0;
  const cur = new Date((acc.anchorDate || todayStr) + "T00:00:00Z");
  const end = new Date(todayStr + "T00:00:00Z");
  let guard = 0;
  while (cur < end && guard++ < 20000) {
    cur.setUTCDate(cur.getUTCDate() + 1);
    if (monthly && cur.getUTCDate() === 1) { bal += monthly; contributed += monthly; }
    const i = bal * dayRate;
    interest += i;
    if (acc.compound === "daily") bal += i; else pending += i;
    if (acc.compound !== "daily" && cur.getUTCMonth() === 0 && cur.getUTCDate() === 1) { bal += pending; pending = 0; }
  }
  return { balance: bal, pending, value: bal + pending, contributed, interest };
}
function savingsRows() {
  const today = new Date().toISOString().slice(0, 10);
  return (STATE.savings || []).map(a => ({ acc: a, ...savingsProject(a, today) }));
}
function savingsTotals() {
  let usd = 0, interest = 0, contributed = 0;
  for (const r of savingsRows()) {
    usd += ccyToUSD(r.value, r.acc.ccy || "EUR");
    interest += ccyToUSD(r.interest, r.acc.ccy || "EUR");
    contributed += ccyToUSD(r.contributed, r.acc.ccy || "EUR");
  }
  return { usd, interest, contributed };
}
function nextFirstOfMonth() {
  const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + 1);
  return d.toISOString().slice(0, 10);
}

/* ---- Interest ledger: {date, kind:"received"|"paid", ccy, amount(+ve), note, source} ---- */
function interestTotals() {
  let received = typeof savingsTotals === "function" ? savingsTotals().interest : 0;   // savings accrual counts as earned
  let paid = 0;
  for (const e of (STATE.interest || [])) {
    const usd = ccyToUSD(Math.abs(e.amount), e.ccy || "USD");
    if (e.kind === "paid") paid += usd; else received += usd;
  }
  return { received, paid, net: received - paid };
}
const uid = () => "t" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
function nativeTotal(t) {   // cost/proceeds in the trade's own currency, incl. fee
  const gross = Math.abs(t.qty) * t.price;
  return String(t.side).toLowerCase() === "buy" ? gross + (t.fee || 0) : gross - (t.fee || 0);
}
function syncTradeCash(trade) {   // create/replace the cash movement linked to a trade
  STATE.cash = (STATE.cash || []).filter(e => e.tradeId !== trade.id);
  if (trade.settle) {
    const isBuy = String(trade.side).toLowerCase() === "buy";
    STATE.cash.push({
      date: trade.date, ccy: trade.ccy, amount: nativeTotal(trade) * (isBuy ? -1 : 1),
      kind: isBuy ? "buy" : "sell", note: `${trade.side} ${fmtQty(Math.abs(trade.qty))} ${trade.asset}`,
      tradeId: trade.id,
    });
  }
}
function moneyIn(amount, ccy, dp = 2) {   // format an amount in a specific currency
  const neg = amount < 0;
  return (neg ? "-" : "") + ccySym(ccy) + Math.abs(amount).toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

function money(usd, opts = {}) {
  if (usd == null || isNaN(usd)) return "—";
  const v = toCcy(usd);
  const neg = v < 0;
  const abs = Math.abs(v);
  const dp = opts.dp != null ? opts.dp : (abs < 100 && opts.small ? 2 : 0);
  const s = abs.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
  return (neg ? "-" : (opts.sign ? "+" : "")) + SYM() + s;
}
function fmtPrice(usd) {
  if (usd == null || isNaN(usd)) return "—";
  const v = toCcy(usd);
  let dp = v >= 1000 ? 2 : v >= 1 ? 2 : v >= 0.01 ? 4 : 6;
  return SYM() + v.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
}
function fmtQty(q) {
  const a = Math.abs(q);
  const dp = a >= 1000 ? 2 : a >= 1 ? 4 : 6;
  return q.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: dp });
}
function pct(v, withSign = true) {
  if (v == null || isNaN(v)) return "—";
  return (withSign && v > 0 ? "+" : "") + (v * 100).toFixed(2) + "%";
}
const cls = (v) => v > EPS ? "pos" : v < -EPS ? "neg" : "muted";
function toast(msg, isErr = false) {
  let t = $("#toast"); if (!t) { t = el("div", "toast"); t.id = "toast"; document.body.appendChild(t); }
  t.textContent = msg; t.className = "toast show" + (isErr ? " err" : "");
  clearTimeout(t._t); t._t = setTimeout(() => t.className = "toast", 2600);
}
const BADGE_OVERRIDE = { "TR Robo (ETF basket)": "ROBO" };
const initials = (name) => {
  if (BADGE_OVERRIDE[name]) return BADGE_OVERRIDE[name];
  const n = String(name).trim();
  if (/^[A-Za-z0-9.]{1,5}$/.test(n)) return n.toUpperCase();          // already a ticker: NOW, COIN, BTC
  const m = metaFor(name);
  if (m.sym) return m.sym.replace(/USDT$|USD$/, "").slice(0, 4);       // pair symbol → strip quote ccy
  const words = n.replace(/[^A-Za-z0-9 ]/g, "").split(/\s+/).filter(Boolean);
  if (words.length === 1) return words[0].slice(0, 4).toUpperCase();
  return words.map(w => w[0]).join("").slice(0, 4).toUpperCase();
};

/* ============================ FIFO engine ============================ */
function computePortfolio(priceMap) {
  const byAsset = {};
  const order = STATE.trades.map((t, i) => i)
    .sort((a, b) => STATE.trades[a].date < STATE.trades[b].date ? -1
      : STATE.trades[a].date > STATE.trades[b].date ? 1 : a - b);

  for (const i of order) {
    const t = STATE.trades[i];
    const a = t.asset;
    if (!byAsset[a]) byAsset[a] = { asset: a, cls: metaFor(a).cls, lots: [], venues: new Set(),
      buyQty: 0, buyCost: 0, sellQty: 0, sellProceeds: 0, costConsumed: 0 };
    const A = byAsset[a];
    A.venues.add(t.venue);
    const qty = Math.abs(t.qty);
    if (String(t.side).toLowerCase() === "buy") {
      const usd = Math.abs(t.totalUSD);
      A.lots.push([qty, usd / qty]);          // [qty, costPerUnitUSD incl fees]
      A.buyQty += qty; A.buyCost += usd;
    } else {
      const proceeds = Math.abs(t.totalUSD);
      let rem = qty, consumed = 0;
      while (rem > EPS && A.lots.length) {
        const lot = A.lots[0];
        const take = Math.min(rem, lot[0]);
        consumed += take * lot[1];
        lot[0] -= take; rem -= take;
        if (lot[0] <= EPS) A.lots.shift();
      }
      A.sellQty += qty; A.sellProceeds += proceeds; A.costConsumed += consumed;
    }
  }

  const open = [], realizedRows = [];
  const totals = { mv: 0, cost: 0, upl: 0, realizedAll: 0, day: 0 };
  const byClass = { stock: { mv: 0, cost: 0, upl: 0 }, crypto: { mv: 0, cost: 0, upl: 0 } };

  for (const a in byAsset) {
    const A = byAsset[a];
    const realized = A.sellProceeds - A.costConsumed;
    totals.realizedAll += realized;
    const openQty = A.lots.reduce((s, l) => s + l[0], 0);
    const openCost = A.lots.reduce((s, l) => s + l[0] * l[1], 0);
    const venues = [...A.venues].join(", ");
    const stillOpen = openQty > EPS;

    if (stillOpen) {
      const pinfo = priceMap[a] || {};
      const price = pinfo.price ?? 0;
      const mv = openQty * price;
      const upl = mv - openCost;
      let day = 0;
      if (pinfo.changePct != null) day = mv - mv / (1 + pinfo.changePct / 100);
      else if (pinfo.prevClose != null) day = openQty * (price - pinfo.prevClose);
      open.push({ asset: a, cls: A.cls, qty: openQty, cost: openCost, avg: openCost / openQty,
        price, status: pinfo.status || "none", changePct: pinfo.changePct, mv, upl,
        ret: openCost ? upl / openCost : 0, realized, venues, day });
      totals.mv += mv; totals.cost += openCost; totals.upl += upl; totals.day += day;
      byClass[A.cls].mv += mv; byClass[A.cls].cost += openCost; byClass[A.cls].upl += upl;
    }
    // Realized row for EVERY asset you've sold any of — fully closed OR trimmed.
    // Uses FIFO-matched sold lots, so the column sums exactly to Realized P&L.
    if (A.sellQty > EPS) {
      realizedRows.push({ asset: a, cls: A.cls, qty: A.sellQty, avgBuy: A.costConsumed / A.sellQty,
        cost: A.costConsumed, avgSell: A.sellProceeds / A.sellQty, proceeds: A.sellProceeds,
        realized, ret: A.costConsumed ? realized / A.costConsumed : 0, venues, stillOpen });
    }
  }
  open.sort((a, b) => b.mv - a.mv);
  realizedRows.sort((a, b) => b.realized - a.realized);
  return { open, realized: realizedRows, totals, byClass };
}

/* ============================ Live prices ============================ */
function heldAssets() {   // assets with an open position
  const set = new Set();
  const net = {};
  for (const t of STATE.trades) {
    net[t.asset] = (net[t.asset] || 0) + (String(t.side).toLowerCase() === "buy" ? Math.abs(t.qty) : -Math.abs(t.qty));
  }
  for (const a in net) if (net[a] > EPS) set.add(a);
  return [...set];
}
function buildPriceMap() {
  const map = {};
  for (const a in STATE.manualPrices) map[a] = { price: STATE.manualPrices[a], status: "manual" };
  for (const a in STATE.livePrices) {
    const lp = STATE.livePrices[a];
    map[a] = { price: lp.price * multFor(a), status: "live", changePct: lp.changePct, prevClose: lp.prevClose, ts: lp.ts };
  }
  // manual-source assets always use manual price (never overwritten by stale live)
  for (const a in ASSET_META) {
    if (metaFor(a).src === "manual" && STATE.manualPrices[a] != null)
      map[a] = { price: STATE.manualPrices[a], status: "manual" };
  }
  return map;
}

async function fetchJSON(url, opts) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 9000);
  try {
    const r = await fetch(url, { ...opts, signal: ctrl.signal });
    if (!r.ok) throw new Error(r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}
async function fetchText(url, opts) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 9000);
  try {
    const r = await fetch(url, { ...opts, signal: ctrl.signal });
    if (!r.ok) throw new Error(r.status);
    return await r.text();
  } finally { clearTimeout(t); }
}

async function refreshPrices() {
  const held = heldAssets();
  const btn = $("#refreshBtn"); if (btn) btn.disabled = true;
  setStatus("spin", "Fetching live prices…");
  const now = Date.now();
  let liveCount = 0, errors = [];

  // ---- Crypto: CoinGecko (batched, no key) ----
  const cryptoAssets = held.filter(a => metaFor(a).src === "coingecko");
  const cgId = a => metaFor(a).id || metaFor(a).sym;   // built-ins use .id, user assets use .sym
  if (cryptoAssets.length) {
    const ids = [...new Set(cryptoAssets.map(cgId).filter(Boolean))].join(",");
    try {
      const d = await fetchJSON(`https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true`);
      for (const a of cryptoAssets) {
        const row = d[cgId(a)];
        if (row && row.usd) {
          STATE.livePrices[a] = { price: row.usd, changePct: row.usd_24h_change, prevClose: null, ts: now };
          liveCount++;
        }
      }
    } catch (e) { errors.push("crypto"); }
  }

  // ---- FX: EUR→USD ----
  try {
    const fx = await fetchJSON("https://api.frankfurter.dev/v1/latest?base=EUR&symbols=USD");   // .app host lost CORS
    if (fx && fx.rates && fx.rates.USD) STATE.fxEURUSD = fx.rates.USD;
  } catch (e) {
    try {
      const fx2 = await fetchJSON("https://open.er-api.com/v6/latest/EUR");
      if (fx2 && fx2.rates && fx2.rates.USD) STATE.fxEURUSD = fx2.rates.USD;
    } catch (e2) {}
  }

  // ---- Stocks: Finnhub (needs key) ----
  const key = (STATE.settings.finnhubKey || "").trim();
  const stockAssets = held.filter(a => metaFor(a).src === "finnhub");
  if (stockAssets.length) {
    if (!key) {
      errors.push("stocks (no API key)");
    } else {
      const results = await Promise.allSettled(stockAssets.map(a =>
        fetchJSON(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(metaFor(a).sym)}&token=${key}`)
          .then(d => ({ a, d }))
      ));
      for (const r of results) {
        if (r.status === "fulfilled" && r.value.d && r.value.d.c > 0) {
          const { a, d } = r.value;
          STATE.livePrices[a] = { price: d.c, changePct: d.dp, prevClose: d.pc, ts: now };
          liveCount++;
        }
      }
      if (results.some(r => r.status === "rejected")) errors.push("some stocks");
    }
  }

  // ---- MEXC tokenized stocks (CORS-blocked → via proxy; falls back to manual on failure) ----
  const mexcAssets = held.filter(a => metaFor(a).src === "mexc");
  if (mexcAssets.length) {
    const proxies = u => [`https://corsproxy.io/?url=${encodeURIComponent(u)}`, `https://r.jina.ai/${u}`];
    const rs = await Promise.allSettled(mexcAssets.map(async a => {
      const sym = metaFor(a).sym;
      const target = `https://api.mexc.com/api/v3/ticker/price?symbol=${encodeURIComponent(sym)}`;
      let raw = null;
      for (const url of proxies(target)) {
        try {
          const txt = await fetchText(url);
          try { raw = parseFloat(JSON.parse(txt).price); }
          catch (e) { const mm = txt.match(/"price"\s*:\s*"?([\d.]+)/); if (mm) raw = parseFloat(mm[1]); }
          if (raw > 0) break;
        } catch (e) { /* try next proxy */ }
      }
      if (!(raw > 0)) throw new Error(sym);
      STATE.livePrices[a] = { price: raw, changePct: null, prevClose: null, ts: now };
      liveCount++;
    }));
    if (rs.some(r => r.status === "rejected")) errors.push("MEXC");
  }

  // ---- on-chain wallets (live, no key) ----
  if ((STATE.wallets || []).length) {
    STATE.liveWallets = STATE.liveWallets || {};
    const rs = await Promise.allSettled((STATE.wallets).map(async w => {
      if (w.kind === "hyperliquid") STATE.liveWallets[w.address] = await fetchHyperliquid(w.address);
      else if (w.kind === "solana" || w.kind === "ethereum" || w.kind === "bitcoin")
        STATE.liveWallets[w.address] = await fetchChainWallet(w);
    }));
    if (rs.some(r => r.status === "rejected")) errors.push("wallets");
  }

  STATE.lastRefresh = now;
  saveLocal();   // local only — live prices aren't in the backup, so don't push (and don't race) on every refresh
  render();
  if (btn) btn.disabled = false;
  if (errors.length) toast(`Updated ${liveCount} prices · missing: ${errors.join(", ")}`, true);
  else if (liveCount) toast(`Updated ${liveCount} live prices`);
}

/* ============================ Rendering ============================ */
function setStatus(dotClass, text) {
  const line = $("#statusLine");
  if (!line) return;
  line.innerHTML = `<span class="dot ${dotClass}"></span> ${text}`;
}
function refreshStatusText() {
  const key = (STATE.settings.finnhubKey || "").trim();
  const when = STATE.lastRefresh ? new Date(STATE.lastRefresh).toLocaleString("en-GB", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "short" }) : "never";
  const parts = [`Updated ${when}`, "Crypto: CoinGecko live", key ? "Stocks: Finnhub live" : "Stocks: manual (add Finnhub key in ⚙)"];
  setStatus(STATE.lastRefresh ? "live" : "", parts.join(" · "));
}

function render() {
  const map = buildPriceMap();
  const P = computePortfolio(map);
  recordSnapshot(P);
  renderKPIs(P);
  renderCash(P);
  renderSavings();
  renderWallets();
  renderAllocation(P);
  renderSparkline();
  renderHoldings(P);
  renderClosed(P);
  renderLog();
  refreshStatusText();
}

function renderKPIs(P) {
  const t = P.totals;
  const cashUSD = totalCashUSD();
  const ST = savingsTotals(), WT = walletTotals(), I = interestTotals();
  const savUSD = ST.usd, walUSD = WT.usd;
  const totalValue = t.mv + cashUSD + savUSD + walUSD;
  const walPnl = WT.hasPnl ? WT.pnl : 0;
  const totalPL = t.upl + t.realizedAll + walPnl;
  const dayPct = (t.mv - t.day) ? t.day / (t.mv - t.day) : 0;

  /* ---- hero: total value + composition bar ---- */
  const segs = [
    { nm: "Stocks & ETFs", v: P.byClass.stock.mv, c: "var(--stock)" },
    { nm: "Crypto", v: P.byClass.crypto.mv, c: "var(--crypto)" },
    { nm: "Wallets", v: walUSD, c: "var(--wallet)" },
    { nm: "Savings", v: savUSD, c: "var(--savings)" },
    { nm: "Cash", v: cashUSD, c: "var(--cash)" },
  ].filter(x => x.v > 0.5);
  const segTot = segs.reduce((a, x) => a + x.v, 0) || 1;
  $("#heroCard").innerHTML = `
    <div>
      <div class="label">Total value <span class="pdot live" style="margin-left:2px"></span></div>
      <div class="val num">${money(totalValue)}</div>
      <div class="hero-chips">
        ${t.day ? `<span class="chip ${cls(t.day)}">${t.day > 0 ? "▲" : "▼"} ${money(Math.abs(t.day))} · ${pct(Math.abs(dayPct))} today</span>` : ""}
        <span class="chip ${cls(totalPL)}">${money(totalPL, { sign: true })} all-time</span>
      </div>
    </div>
    <div>
      <div class="comp-bar">${segs.map(x => `<span style="width:${(x.v / segTot * 100).toFixed(2)}%;background:${x.c}" title="${x.nm}"></span>`).join("")}</div>
      <div class="comp-legend">${segs.map(x => `<span class="cl"><span class="sw" style="background:${x.c}"></span>${x.nm} <b class="num">${money(x.v)}</b></span>`).join("")}</div>
    </div>`;

  /* ---- stat tiles ---- */
  const tiles = [];
  const tile = (label, valHtml, sub) => tiles.push(`<div class="tile"><div class="label">${label}</div><div class="val num">${valHtml}</div>${sub ? `<div class="sub">${sub}</div>` : ""}</div>`);
  tile("Today",
    t.day ? `<span class="${cls(t.day)}">${money(t.day, { sign: true })}</span>` : `<span class="muted">—</span>`,
    t.day ? `<span class="chip ${cls(t.day)}">${pct(dayPct)}</span> <span class="muted">live-priced assets</span>` : `<span class="muted">no live move yet</span>`);
  tile("Total P&L", `<span class="${cls(totalPL)}">${money(totalPL, { sign: true })}</span>`,
    `<span class="muted">U ${money(t.upl, { sign: true })} · R ${money(t.realizedAll, { sign: true })}${walPnl ? ` · W ${money(walPnl, { sign: true })}` : ""}</span>`);
  tile("Unrealized", `<span class="${cls(t.upl)}">${money(t.upl, { sign: true })}</span>`,
    `<span class="chip ${cls(t.upl)}">${pct(t.cost ? t.upl / t.cost : 0)}</span> <span class="muted">on ${money(t.cost)} cost</span>`);
  tile("Realized", `<span class="${cls(t.realizedAll)}">${money(t.realizedAll, { sign: true })}</span>`,
    `<span class="muted">${P.realized.length} sold position${P.realized.length === 1 ? "" : "s"}</span>`);
  if (WT.count) tile("Wallet P&L", `<span class="${cls(walPnl)}">${money(walPnl, { sign: true })}</span>`,
    `<span class="muted">Hyperliquid · live</span>`);
  if (I.received || I.paid) tile("Net interest", `<span class="${cls(I.net)}">${money(I.net, { sign: true })}</span>`,
    `<span class="muted"><span class="pos">+${money(I.received)}</span> · <span class="neg">−${money(I.paid)}</span></span>`);
  $("#stats").innerHTML = tiles.join("");

  /* ---- class tiles ---- */
  const bal = cashBalances();
  const ccyStr = CCYS.filter(c => Math.abs(bal[c]) > 0.005).map(c => moneyIn(bal[c], c, 0)).join(" · ");
  const stk = P.byClass.stock, cry = P.byClass.crypto;
  const nStk = P.open.filter(o => o.cls === "stock").length, nCry = P.open.filter(o => o.cls === "crypto").length;
  const cts = [];
  const ct = (color, label, val, sub) => cts.push(`<div class="tile class-tile" style="--cc:${color}"><div class="label"><span class="dot-c"></span>${label}</div><div class="val num">${val}</div><div class="sub">${sub}</div></div>`);
  ct("var(--stock)", "Stocks & ETFs", money(stk.mv), `<span class="chip ${cls(stk.upl)}">${money(stk.upl, { sign: true })}</span> <span class="muted">${nStk} positions</span>`);
  ct("var(--crypto)", "Crypto", money(cry.mv), `<span class="chip ${cls(cry.upl)}">${money(cry.upl, { sign: true })}</span> <span class="muted">${nCry} positions</span>`);
  if (WT.count) ct("var(--wallet)", "Wallets", money(walUSD),
    WT.hasPnl ? `<span class="chip ${cls(WT.pnl)}">${money(WT.pnl, { sign: true })}</span> <span class="muted">live</span>` : `<span class="muted">${WT.count} wallet${WT.count === 1 ? "" : "s"}</span>`);
  if ((STATE.savings || []).length) ct("var(--savings)", "Savings", money(savUSD),
    `<span class="muted">${STATE.savings.length} accounts · <span class="pos">+${money(ST.interest)}</span> interest</span>`);
  ct("var(--cash)", "Cash", money(cashUSD), `<span class="muted">${ccyStr || "—"}</span>`);
  $("#classCards").innerHTML = cts.join("");

  /* ---- today's movers ---- */
  const mv = P.open.filter(o => o.status === "live" && o.changePct != null && Math.abs(o.day) > 0.5);
  const ups = mv.filter(o => o.day > 0).sort((a, b) => b.changePct - a.changePct).slice(0, 3);
  const dns = mv.filter(o => o.day < 0).sort((a, b) => a.changePct - b.changePct).slice(0, 3);
  const box = $("#movers");
  if (!ups.length && !dns.length) { box.innerHTML = ""; }
  else {
    const chipHtml = o => `<span class="mover ${cls(o.day)}"><b>${initials(o.asset)}</b> ${pct(o.changePct / 100)} <span class="muted num">${money(o.day, { sign: true })}</span></span>`;
    box.innerHTML = `<div class="panel movers"><span class="label">Today's movers</span>${[...ups, ...dns].map(chipHtml).join("")}</div>`;
  }
}

/* ============================ Wallets panel ============================ */
const shortAddr = a => a ? a.slice(0, 6) + "…" + a.slice(-4) : "";
function renderWallets() {
  const box = $("#walletsPanel"); if (!box) return;
  const ws = STATE.wallets || [];
  if (!ws.length) {
    box.innerHTML = `<div class="panel-head"><h2>Wallets</h2>
      <button class="btn primary" id="walAdd">＋ Add wallet</button></div>
      <div class="muted" style="font-size:.85rem;padding:6px 0">Track an on-chain wallet live — Hyperliquid needs no API key.</div>`;
    $("#walAdd", box).onclick = () => walletModal();
    return;
  }
  const T = walletTotals();
  const cards = ws.map((w, i) => {
    const d = (STATE.liveWallets || {})[w.address];
    const val = d && isFinite(d.value) ? d.value : (isFinite(w.manualValue) ? Number(w.manualValue) : null);
    const dot = d ? `<span class="pdot live"></span>` : `<span class="pdot manual"></span>`;
    const hold = (d && !d.chain) ? (d.holdings || []).filter(h => h.usd > 0.5)
      .sort((a, b) => b.usd - a.usd).slice(0, 4)
      .map(h => `${fmtQty(h.qty)} ${h.coin}`).join(" · ") : "";
    const posHtml = (!d || d.chain) ? ""
      : ((d.positions || []).length
        ? `<span>${d.positions.map(p => `<span class="${cls(p.upnl)}">${p.coin} ${p.szi > 0 ? "long" : "short"} ${money(p.upnl, { sign: true })}</span>`).join(" · ")}</span>`
        : `<span class="muted">no open positions</span>`);
    const KINDLBL = { hyperliquid: "Hyperliquid", solana: "Solana", ethereum: "Ethereum", bitcoin: "Bitcoin", manual: "manual" };
    const verify = (d && d.chain && (d.holdings || []).length) ? (() => {
      const h = d.holdings[0], tq = trackedQty(h.coin);
      const tol = Math.max(Math.abs(tq) * 0.005, 1e-6);
      return Math.abs(h.qty - tq) <= tol
        ? `<span class="pos">✓ matches the ${fmtQty(tq)} ${h.coin} tracked</span>`
        : `<span class="neg">⚠ on-chain ${fmtQty(h.qty)} vs ${fmtQty(tq)} tracked</span>`;
    })() : "";
    return `<div class="sav-card">
      <div class="sav-top">
        <span class="sav-name">${dot} ${w.name}${w.counted === false ? ` <span class="mini-tag" title="Verifies positions already tracked in the trade log — not added to Total Value">watch-only</span>` : ""}</span>
        <span class="sav-rate">${KINDLBL[w.kind] || w.kind}</span>
      </div>
      <div class="sav-val num">${val == null ? "—" : money(val)}
        ${d && isFinite(d.netPnl) ? `<span class="wal-pnl ${cls(d.netPnl)}">${money(d.netPnl, { sign: true })}</span>` : ""}</div>
      <div class="sav-meta">
        ${d ? (d.chain ? `<span>${(d.holdings || []).map(h => `${fmtQty(h.qty)} ${h.coin} @ ${fmtPrice(h.px)}`).join(" · ") || "empty"}</span>` : `<span>spot ${money(d.spot)} · perps ${money(d.perps)}</span>`) : `<span class="muted">not fetched yet — hit ↻</span>`}
        ${verify ? `<span>${verify}</span>` : ""}
        ${d && isFinite(d.realized) ? `<span class="muted">realized <span class="${cls(d.realized)}">${money(d.realized, { sign: true })}</span> · fees ${money(d.fees)} · funding <span class="${cls(d.funding)}">${money(d.funding, { sign: true })}</span>${d.upnl ? ` · unreal. <span class="${cls(d.upnl)}">${money(d.upnl, { sign: true })}</span>` : ""}</span>` : ""}
        ${d && d.fillCount ? `<span class="muted">${d.fillCount} fills</span>` : ""}
        ${hold ? `<span class="muted">${hold}</span>` : ""}
        ${posHtml}
        <span class="muted" title="${w.address}">${shortAddr(w.address)}</span>
      </div>
      <div class="sav-actions">
        <button class="btn tiny" data-waledit="${i}">Edit</button>
        <button class="btn tiny" data-waldel="${i}">Delete</button>
      </div>
    </div>`;
  }).join("");
  box.innerHTML = `<div class="panel-head"><h2>Wallets <span class="tag">${money(T.usd)}</span></h2>
      <button class="btn primary" id="walAdd">＋ Add wallet</button></div>
    <div class="sav-grid">${cards}</div>`;
  $("#walAdd", box).onclick = () => walletModal();
}

function walletModal(editIdx = null) {
  const w = editIdx != null ? STATE.wallets[editIdx] : { name: "", address: "", kind: "hyperliquid" };
  const m = el("div", "modal");
  m.innerHTML = `<h3>${editIdx != null ? "Edit" : "Add"} wallet <button class="x">&times;</button></h3>
    <div class="form-grid">
      <div class="field"><label>Label</label><input id="w_name" value="${(w.name || "").replace(/"/g, "&quot;")}" placeholder="Fun trading wallet"></div>
      <div class="field"><label>Network</label><select id="w_kind">
        <option value="hyperliquid"${w.kind === "hyperliquid" ? " selected" : ""}>Hyperliquid (live, no key)</option>
        <option value="solana"${w.kind === "solana" ? " selected" : ""}>Solana (live, no key)</option>
        <option value="ethereum"${w.kind === "ethereum" ? " selected" : ""}>Ethereum (live, no key)</option>
        <option value="bitcoin"${w.kind === "bitcoin" ? " selected" : ""}>Bitcoin (live, no key)</option>
        <option value="manual"${w.kind === "manual" ? " selected" : ""}>Manual value</option></select></div>
      <div class="field full"><label>Address</label><input id="w_addr" value="${w.address || ""}" placeholder="0x… / base58 / bc1…" spellcheck="false"></div>
      <label class="settle-row full"><input type="checkbox" id="w_counted"${w.counted !== false ? " checked" : ""}>
        <span>Count in <b>Total Value</b> — untick for watch-only (coins already tracked as positions in the trade log)</span></label>
      <div class="field full" id="w_manualbox" style="display:${w.kind === "manual" ? "" : "none"}">
        <label>Value (USD)</label><input id="w_val" type="number" step="any" value="${w.manualValue || 0}"></div>
      <div class="computed full"><span class="muted">Live check</span><span id="w_test" class="num muted">—</span></div>
    </div>
    <div class="modal-actions">
      <button class="btn" id="w_cancel">Cancel</button>
      <button class="btn" id="w_check">Test</button>
      <button class="btn primary" id="w_ok">${editIdx != null ? "Save changes" : "Add wallet"}</button>
    </div>`;
  const back = openModal(m); const close = () => back.remove();
  m.querySelector(".x").onclick = close; $("#w_cancel", m).onclick = close;
  $("#w_kind", m).onchange = () => {
    const k = $("#w_kind", m).value;
    $("#w_manualbox", m).style.display = k === "manual" ? "" : "none";
    if (editIdx == null) $("#w_counted", m).checked = !(k === "solana" || k === "ethereum" || k === "bitcoin");   // chaînes = déjà suivies en positions
  };
  $("#w_check", m).onclick = async () => {
    const addr = $("#w_addr", m).value.trim(), kind = $("#w_kind", m).value;
    const re = ADDR_RE[kind];
    if (re && !re.test(addr)) return void ($("#w_test", m).textContent = "invalid " + kind + " address");
    $("#w_test", m).textContent = "checking…";
    try {
      const d = kind === "hyperliquid" ? await fetchHyperliquid(addr) : await fetchChainWallet({ kind, address: addr });
      $("#w_test", m).innerHTML = `<span class="pos">${money(d.value)}</span> <span class="muted">${d.chain ? (d.holdings || []).map(h => `${fmtQty(h.qty)} ${h.coin}`).join(" · ") : `spot ${money(d.spot)} · perps ${money(d.perps)}`}</span>`;
    } catch (e) { $("#w_test", m).textContent = "failed: " + e.message.slice(0, 60); }
  };
  $("#w_ok", m).onclick = () => {
    const addr = $("#w_addr", m).value.trim();
    const kind = $("#w_kind", m).value;
    if (kind !== "manual" && !(ADDR_RE[kind] || /^.{6,}$/).test(addr)) return toast("Enter a valid " + kind + " address", true);
    const rec = { id: w.id || uid(), name: $("#w_name", m).value.trim() || "Wallet", address: addr, kind,
      counted: $("#w_counted", m).checked };
    if (kind === "manual") rec.manualValue = parseFloat($("#w_val", m).value) || 0;
    STATE.wallets = STATE.wallets || [];
    if (editIdx != null) STATE.wallets[editIdx] = rec; else STATE.wallets.push(rec);
    saveState(); render(); close(); toast(editIdx != null ? "Wallet updated" : "Wallet added");
    refreshPrices();
  };
}
function deleteWallet(i) {
  const w = (STATE.wallets || [])[i]; if (!w) return;
  if (!confirm(`Stop tracking "${w.name}"?`)) return;
  STATE.wallets.splice(i, 1); saveState(); render(); toast("Wallet removed");
}

/* ============================ Savings panel ============================ */
function renderSavings() {
  const box = $("#savingsPanel"); if (!box) return;
  const rows = savingsRows();
  const T = savingsTotals();
  if (!rows.length) {
    box.innerHTML = `<div class="panel-head"><h2>Savings</h2>
      <button class="btn primary" id="savAdd">＋ Add account</button></div>
      <div class="muted" style="font-size:.85rem;padding:6px 0">No savings accounts yet — add a PEL, Livret, or Revolut savings pocket.</div>`;
    $("#savAdd", box).onclick = () => savingsModal();
    return;
  }
  const cards = rows.map((r, i) => {
    const a = r.acc, ccy = a.ccy || "EUR";
    const compLabel = a.compound === "daily" ? "daily" : "annual";
    return `<div class="sav-card">
      <div class="sav-top">
        <span class="sav-name">${a.name}</span>
        <span class="sav-rate">${(Number(a.rate) * 100).toFixed(2)}%<span class="muted"> ${compLabel}</span></span>
      </div>
      <div class="sav-val num">${moneyIn(r.value, ccy, 2)}</div>
      <div class="sav-meta">
        ${Number(a.monthly) ? `<span>+${moneyIn(Number(a.monthly), ccy, 0)}/mo on the 1st</span>` : `<span class="muted">no recurring</span>`}
        <span class="pos">+${moneyIn(r.interest, ccy, 2)} interest</span>
        ${r.pending > 0.005 ? `<span class="muted">incl. ${moneyIn(r.pending, ccy, 2)} accrued — credited at year end</span>` : ""}
      </div>
      <div class="sav-actions">
        <button class="btn tiny" data-savedit="${i}">Edit</button>
        <button class="btn tiny" data-savdel="${i}">Delete</button>
      </div>
    </div>`;
  }).join("");
  box.innerHTML = `<div class="panel-head"><h2>Savings <span class="tag">${money(T.usd)}</span></h2>
      <button class="btn primary" id="savAdd">＋ Add account</button></div>
    <div class="sav-grid">${cards}</div>
    <div class="muted" style="font-size:.78rem;margin-top:12px">
      Balances project forward automatically: contributions post on the 1st, interest accrues daily.
      Next contribution: <b>${nextFirstOfMonth()}</b>.
    </div>`;
  $("#savAdd", box).onclick = () => savingsModal();
}

function savingsModal(editIdx = null) {
  const a = editIdx != null ? STATE.savings[editIdx]
    : { name: "", ccy: "EUR", rate: 0.02, compound: "daily", monthly: 0,
        anchorDate: new Date().toISOString().slice(0, 10), anchorBalance: 0 };
  const m = el("div", "modal");
  m.innerHTML = `<h3>${editIdx != null ? "Edit" : "Add"} savings account <button class="x">&times;</button></h3>
    <div class="form-grid">
      <div class="field"><label>Name</label><input id="s_name" value="${(a.name || "").replace(/"/g, "&quot;")}" placeholder="PEL, Revolut Savings…"></div>
      <div class="field"><label>Currency</label><select id="s_ccy">${CCYS.map(c => `<option${c === (a.ccy || "EUR") ? " selected" : ""}>${c}</option>`).join("")}</select></div>
      <div class="field"><label>Interest rate (% per year)</label><input id="s_rate" type="number" step="any" value="${(Number(a.rate) * 100).toFixed(3).replace(/0+$/, "").replace(/\.$/, "")}"></div>
      <div class="field"><label>Interest paid</label><select id="s_comp">
        <option value="daily"${a.compound === "daily" ? " selected" : ""}>Daily (compounds)</option>
        <option value="annual"${a.compound === "annual" ? " selected" : ""}>Yearly (at year end)</option></select></div>
      <div class="field"><label>Monthly deposit (on the 1st)</label><input id="s_monthly" type="number" step="any" value="${Number(a.monthly) || 0}"></div>
      <div class="field"><label>Balance today</label><input id="s_bal" type="number" step="any" value="${Number(a.anchorBalance) || 0}"></div>
      <div class="field"><label>Interest earned so far</label><input id="s_earned" type="number" step="any" value="${Number(a.anchorInterest) || 0}">
        <div class="hint">Interest this account has already paid you (included in the balance)</div></div>
      <div class="field"><label>…of which not yet credited</label><input id="s_pend" type="number" step="any" value="${Number(a.anchorPending) || 0}">
        <div class="hint">Leave 0 unless the balance excludes it (some PELs show it separately)</div></div>
      <div class="field full"><label>Balance as of date</label><input id="s_date" type="date" value="${a.anchorDate}">
        <div class="hint">The app projects forward from this date — deposits and interest are added automatically.</div></div>
      <div class="computed full"><span class="muted">Projected value today</span><span id="s_proj" class="num">—</span></div>
    </div>
    <div class="modal-actions">
      <button class="btn" id="s_cancel">Cancel</button>
      <button class="btn primary" id="s_ok">${editIdx != null ? "Save changes" : "Add account"}</button>
    </div>`;
  const back = openModal(m); const close = () => back.remove();
  m.querySelector(".x").onclick = close; $("#s_cancel", m).onclick = close;
  const read = () => ({
    id: a.id || uid(), name: $("#s_name", m).value.trim() || "Savings",
    ccy: $("#s_ccy", m).value, rate: (parseFloat($("#s_rate", m).value) || 0) / 100,
    compound: $("#s_comp", m).value, monthly: parseFloat($("#s_monthly", m).value) || 0,
    anchorDate: $("#s_date", m).value, anchorBalance: parseFloat($("#s_bal", m).value) || 0,
    anchorPending: parseFloat($("#s_pend", m).value) || 0,
    anchorInterest: parseFloat($("#s_earned", m).value) || 0,
  });
  const preview = () => {
    const acc = read(), r = savingsProject(acc, new Date().toISOString().slice(0, 10));
    $("#s_proj", m).textContent = `${moneyIn(r.value, acc.ccy, 2)}  (+${moneyIn(r.interest, acc.ccy, 2)} interest)`;
  };
  ["s_rate", "s_comp", "s_monthly", "s_bal", "s_pend", "s_earned", "s_date", "s_ccy"].forEach(id => { $("#" + id, m).oninput = preview; $("#" + id, m).onchange = preview; });
  preview();
  $("#s_ok", m).onclick = () => {
    const acc = read();
    STATE.savings = STATE.savings || [];
    if (editIdx != null) STATE.savings[editIdx] = acc; else STATE.savings.push(acc);
    saveState(); render(); close(); toast(editIdx != null ? "Account updated" : "Savings account added");
  };
}
function deleteSavings(i) {
  const a = (STATE.savings || [])[i]; if (!a) return;
  if (!confirm(`Delete savings account "${a.name}"?`)) return;
  STATE.savings.splice(i, 1); saveState(); render(); toast("Account removed");
}

/* ============================ Cash panel ============================ */
function renderCash(P) {
  const box = $("#cashPanel");
  if (!box) return;
  const bal = cashBalances();
  const totUSD = totalCashUSD();
  const chips = CCYS.map(c => `<div class="cash-chip${Math.abs(bal[c]) > 0.005 ? "" : " zero"}">
      <span class="cc">${c}</span><span class="cv num ${bal[c] < -0.005 ? "neg" : ""}">${moneyIn(bal[c], c, 2)}</span></div>`).join("");
  const tx = [...(STATE.cash || [])].map((e, i) => ({ e, i }))
    .sort((a, b) => a.e.date < b.e.date ? 1 : a.e.date > b.e.date ? -1 : b.i - a.i).slice(0, 6);
  const kindLabel = { deposit: "Deposit", withdraw: "Withdraw", convert: "Convert", adjust: "Set balance", buy: "Buy", sell: "Sell" };
  const txHtml = tx.length ? tx.map(({ e, i }) => `<div class="cash-tx">
      <span class="k k-${e.kind}">${kindLabel[e.kind] || e.kind}</span>
      <span class="tn">${e.note || ""}</span>
      <span class="td muted">${e.date}</span>
      <span class="ta num ${e.amount < 0 ? "neg" : "pos"}">${e.amount > 0 ? "+" : ""}${moneyIn(e.amount, e.ccy, 2)}</span>
      <button class="cash-del" data-cashdel="${i}" title="Delete">${ICON.trash}</button>
    </div>`).join("") : `<div class="muted" style="padding:8px 0;font-size:.85rem">No cash transactions yet. Add your salary or set your current balance to start tracking.</div>`;

  box.innerHTML = `
    <div class="panel-head">
      <h2>Cash <span class="tag">${money(totUSD)}</span></h2>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn primary" id="cashDeposit">＋ Add cash</button>
        <button class="btn" id="cashWithdraw">Withdraw</button>
        <button class="btn" id="cashConvert">Convert</button>
        <button class="btn" id="cashSet">Set balance</button>
        <button class="btn" id="cashInterest">% Interest</button>
      </div>
    </div>
    <div class="cash-bals">${chips}</div>
    <div class="cash-list">${txHtml}</div>`;

  $("#cashDeposit", box).onclick = () => cashModal("deposit");
  $("#cashWithdraw", box).onclick = () => cashModal("withdraw");
  $("#cashConvert", box).onclick = () => cashModal("convert");
  $("#cashSet", box).onclick = () => cashModal("adjust");
  $("#cashInterest", box).onclick = interestModal;
}

function renderAllocation(P) {
  const stk = P.byClass.stock.mv, cry = P.byClass.crypto.mv, cash = Math.max(totalCashUSD(), 0);
  const sav = Math.max(savingsTotals().usd, 0);
  const wal = Math.max(walletTotals().usd, 0);
  const tot = stk + cry + cash + sav + wal;
  const donut = $("#donut");
  if (!tot) { donut.innerHTML = `<div class="empty">Nothing to show yet — add a trade or some cash.</div>`; return; }

  const r = 52, C = 2 * Math.PI * r, sw = 18;
  const segs = [
    { nm: "Stocks & ETFs", v: stk, color: "var(--stock)" },
    { nm: "Crypto", v: cry, color: "var(--crypto)" },
    { nm: "Cash", v: cash, color: "var(--cash)" },
    { nm: "Savings", v: sav, color: "var(--savings)" },
    { nm: "Wallets", v: wal, color: "var(--wallet)" },
  ].filter(s => s.v > 0);
  let off = 0;
  const circles = segs.map(s => {
    const frac = s.v / tot, len = frac * C;
    const c = `<circle cx="70" cy="70" r="${r}" fill="none" stroke="${s.color}" stroke-width="${sw}"
      stroke-dasharray="${len} ${C - len}" stroke-dashoffset="${-off}" stroke-linecap="butt"
      transform="rotate(-90 70 70)"></circle>`;
    off += len; return c;
  }).join("");

  const legend = segs.map(s => `
    <div class="row">
      <span class="sw" style="background:${s.color}"></span>
      <span class="nm">${s.nm}</span>
      <span class="pc">${(s.v / tot * 100).toFixed(1)}%</span>
      <span class="amt">${money(s.v)}</span>
    </div>`).join("");

  donut.innerHTML = `
    <div class="donut-wrap">
      <div class="donut" style="width:140px;height:140px">
        <svg width="140" height="140" viewBox="0 0 140 140">
          <circle cx="70" cy="70" r="${r}" fill="none" stroke="var(--surface-2)" stroke-width="${sw}"></circle>
          ${circles}
        </svg>
        <div class="center"><div><div class="big">${money(tot)}</div><div class="small">Total</div></div></div>
      </div>
      <div class="legend">${legend}</div>
    </div>`;

  // allocation bars (top positions + cash)
  const bars = $("#allocBars");
  const items = [...P.open].sort((a, b) => b.mv - a.mv).slice(0, 8)
    .map(o => ({ nm: o.asset, v: o.mv, color: o.cls === "crypto" ? "var(--crypto)" : "var(--stock)" }));
  if (cash > 0) items.push({ nm: "Cash", v: cash, color: "var(--cash)" });
  if (sav > 0) items.push({ nm: "Savings", v: sav, color: "var(--savings)" });
  if (wal > 0) items.push({ nm: "Wallets", v: wal, color: "var(--wallet)" });
  items.sort((a, b) => b.v - a.v);
  bars.innerHTML = items.map(o => `<div class="alloc-bar">
      <div class="top"><span>${o.nm}</span><span class="muted">${money(o.v)} · ${(o.v / tot * 100).toFixed(1)}%</span></div>
      <div class="track"><div class="fill" style="width:${(o.v / tot * 100).toFixed(1)}%;background:${o.color}"></div></div>
    </div>`).join("");
  const top = [...P.open].sort((a, b) => b.mv - a.mv)[0];
  if (top && tot && top.mv / tot > 0.35)
    bars.insertAdjacentHTML("beforeend", `<div class="conc-note">⚠︎ ${top.asset} is ${(top.mv / tot * 100).toFixed(0)}% of your wealth — concentrated.</div>`);
}

/* Record today's true net worth (assets + cash + savings + wallets) once per day.
   Intraday re-renders overwrite the same point, so the last read of the day wins. */
function recordSnapshot(P) {
  const total = P.totals.mv + totalCashUSD() + savingsTotals().usd + walletTotals().usd;
  if (!(total > 0)) return;
  const today = new Date().toISOString().slice(0, 10);
  STATE.snapshots = STATE.snapshots || [];
  const rec = { date: today, navUSD: total, stocks: P.byClass.stock.mv, crypto: P.byClass.crypto.mv,
    cash: totalCashUSD(), savings: savingsTotals().usd, wallets: walletTotals().usd, auto: true };
  const i = STATE.snapshots.findIndex(x => x.date === today);
  if (i >= 0) {
    if (Math.abs((STATE.snapshots[i].navUSD || 0) - total) > 1) { STATE.snapshots[i] = { ...STATE.snapshots[i], ...rec }; saveLocal(); }
  } else { STATE.snapshots.push(rec); saveLocal(); }
}

function renderSparkline() {
  const wrap = $("#sparkPanel");
  const all = [...(STATE.snapshots || [])].filter(x => x.navUSD != null).sort((a, b) => a.date < b.date ? -1 : 1);
  if (all.length < 2) { wrap.classList.add("hidden"); return; }
  wrap.classList.remove("hidden");
  const DAY = 864e5, ts = x => new Date(x.date + "T00:00:00Z").getTime();
  const nowT = ts(all.at(-1)), t0 = ts(all[0]);
  const spans = { "3M": 91 * DAY, "1Y": 365 * DAY, "ALL": Infinity };
  let range = VIEW.sparkRange || "1Y";
  let startT = range === "ALL" ? t0 : Math.max(t0, nowT - spans[range]);
  let pts = all.filter(x => ts(x) >= startT).map(x => ({ t: ts(x), v: x.navUSD, real: true }));
  if (pts.length && t0 < startT) {                      // point interpolé au bord de la fenêtre
    const i = all.findIndex(x => ts(x) >= startT);
    if (i > 0) { const a = all[i - 1], b = all[i], f = (startT - ts(a)) / (ts(b) - ts(a) || 1);
      pts.unshift({ t: startT, v: a.navUSD + (b.navUSD - a.navUSD) * f, real: false }); }
  }
  if (pts.length < 2) { range = "ALL"; VIEW.sparkRange = "ALL"; startT = t0; pts = all.map(x => ({ t: ts(x), v: x.navUSD, real: true })); }

  const vals = pts.map(p => p.v), min = Math.min(...vals), max = Math.max(...vals), pad = (max - min) * 0.14 || 1;
  const W = 680, H = 190, lo = min - pad, hi = max + pad;
  const span = (pts.at(-1).t - pts[0].t) || 1;
  const X = t => ((t - pts[0].t) / span) * W, Y = v => H - ((v - lo) / (hi - lo)) * H;
  const P2 = pts.map(p => [X(p.t), Y(p.v)]);
  let d = `M${P2[0][0].toFixed(1)},${P2[0][1].toFixed(1)}`;
  for (let i = 0; i < P2.length - 1; i++) {             // Catmull-Rom → Bézier (courbe lissée)
    const p0 = P2[Math.max(0, i - 1)], p1 = P2[i], p2 = P2[i + 1], p3 = P2[Math.min(P2.length - 1, i + 2)];
    d += `C${(p1[0] + (p2[0] - p0[0]) / 6).toFixed(1)},${(p1[1] + (p2[1] - p0[1]) / 6).toFixed(1)} ${(p2[0] - (p3[0] - p1[0]) / 6).toFixed(1)},${(p2[1] - (p3[1] - p1[1]) / 6).toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
  }
  const first = pts[0].v, last = pts.at(-1).v, delta = last - first, up = delta >= 0;
  const col = up ? "var(--pos)" : "var(--neg)";
  const dots = pts.filter(p => p.real).map(p =>
    `<circle cx="${X(p.t).toFixed(1)}" cy="${Y(p.v).toFixed(1)}" r="2.8" fill="var(--bg-2)" stroke="${col}" stroke-width="1.6"></circle>`).join("");
  const grid = [0.25, 0.5, 0.75].map(f => `<line x1="0" x2="${W}" y1="${(H * f).toFixed(1)}" y2="${(H * f).toFixed(1)}" stroke="rgba(255,255,255,.05)"></line>`).join("");
  const segBtns = ["3M", "1Y", "ALL"].map(r => `<button data-range="${r}" class="${r === range ? "active" : ""}">${r === "ALL" ? "All" : r}</button>`).join("");
  const fmtD = t => new Date(t).toISOString().slice(0, 10);

  $("#sparkMeta").innerHTML = `
    <div><div class="label muted" style="font-size:.72rem;text-transform:uppercase;letter-spacing:.07em;font-weight:650">Net worth <span class="pdot live" style="margin-left:2px"></span></div>
      <div class="num" style="font-size:1.55rem;font-weight:750;letter-spacing:-.02em">${money(last)}</div>
      <div style="margin-top:2px"><span class="chip ${up ? "pos" : "neg"}">${up ? "▲" : "▼"} ${money(Math.abs(delta))} · ${pct(Math.abs(first ? delta / first : 0))}</span></div></div>
    <div style="text-align:right;display:flex;flex-direction:column;align-items:flex-end;gap:7px">
      <div class="seg seg-mini" id="sparkRange">${segBtns}</div>
      <div class="muted" style="font-size:.7rem">${fmtD(pts[0].t)} → ${all.at(-1).date} · ${pts.filter(p => p.real).length} points</div></div>`;
  $("#sparkSvg").innerHTML = `
    <svg id="sparkSvgEl" width="100%" height="${H}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
      <defs><linearGradient id="sg" x1="0" x2="0" y1="0" y2="1">
        <stop offset="0" stop-color="${col}" stop-opacity="0.32"/>
        <stop offset="1" stop-color="${col}" stop-opacity="0"/>
      </linearGradient></defs>
      ${grid}
      <path d="${d} L${W},${H} L0,${H} Z" fill="url(#sg)"></path>
      <path d="${d}" fill="none" stroke="${col}" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"></path>
      ${dots}
      <line id="sparkX" y1="0" y2="${H}" stroke="rgba(255,255,255,.22)" stroke-dasharray="3 3" visibility="hidden"></line>
    </svg>
    <div id="sparkTip" class="spark-tip hidden"></div>`;
  $$("#sparkRange button").forEach(b => b.onclick = () => { VIEW.sparkRange = b.dataset.range; renderSparkline(); });

  /* crosshair au survol : interpole la valeur à la date pointée */
  const svg = $("#sparkSvgEl"), tip = $("#sparkTip"), xline = $("#sparkX");
  svg.onmousemove = e => {
    const r = svg.getBoundingClientRect();
    const fx = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    const t = pts[0].t + fx * span;
    let i = pts.findIndex(p => p.t >= t); if (i <= 0) i = 1;
    const a = pts[i - 1], b = pts[i] || a;
    const v = a.v + (b.v - a.v) * ((t - a.t) / ((b.t - a.t) || 1));
    xline.setAttribute("x1", (fx * W).toFixed(1)); xline.setAttribute("x2", (fx * W).toFixed(1));
    xline.setAttribute("visibility", "visible");
    tip.classList.remove("hidden");
    tip.innerHTML = `<b class="num">${money(v)}</b><span>${fmtD(t)}</span>`;
    const left = Math.min(r.width - 130, Math.max(0, e.clientX - r.left + 12));
    tip.style.left = left + "px";
  };
  svg.onmouseleave = () => { tip.classList.add("hidden"); xline.setAttribute("visibility", "hidden"); };
}

function sortRows(rows, sort) {
  const { key, dir } = sort;
  return [...rows].sort((a, b) => {
    let va = a[key], vb = b[key];
    if (typeof va === "string") return va.localeCompare(vb) * dir;
    return ((va ?? 0) - (vb ?? 0)) * dir;
  });
}
function sortableHead(cols, sort, tableId) {
  return cols.map(c => {
    if (c.noSort) return `<th class="no-sort">${c.label}</th>`;
    const arr = sort.key === c.key ? (sort.dir < 0 ? "▼" : "▲") : "";
    return `<th data-table="${tableId}" data-key="${c.key}">${c.label} <span class="arr">${arr}</span></th>`;
  }).join("");
}

function assetCell(o, tag) {
  const badgeCls = o.cls === "crypto" ? "crypto" : "stock";
  return `<div class="asset-cell">
    <div class="asset-badge ${badgeCls}">${initials(o.asset)}</div>
    <div class="asset-name"><span class="nm">${o.asset}${tag ? ` <span class="mini-tag">${tag}</span>` : ""}</span><span class="vn">${o.venues}</span></div>
  </div>`;
}

function renderHoldings(P) {
  const cont = $("#holdings");
  const groups = [
    { title: "Stocks & ETFs", tag: "stock", rows: P.open.filter(o => o.cls === "stock") },
    { title: "Crypto", tag: "crypto", rows: P.open.filter(o => o.cls === "crypto") },
  ];
  const cols = [
    { key: "asset", label: "Asset" },
    { key: "qty", label: "Qty" },
    { key: "avg", label: "Avg Cost" },
    { key: "price", label: "Price" },
    { key: "day", label: "Today" },
    { key: "mv", label: "Value" },
    { key: "upl", label: "Unreal. P&L" },
    { key: "ret", label: "Return" },
  ];
  cont.innerHTML = "";
  for (const g of groups) {
    if (!g.rows.length) continue;
    const sub = g.rows.reduce((s, o) => ({ mv: s.mv + o.mv, cost: s.cost + o.cost, upl: s.upl + o.upl, day: s.day + (o.day || 0) }), { mv: 0, cost: 0, upl: 0, day: 0 });
    const rows = sortRows(g.rows, VIEW.holdSort).map(o => {
      const pdot = o.status === "live" ? "live" : "manual";
      const mult = multFor(o.asset);
      const multTag = (mult !== 1 && o.status === "live" && metaFor(o.asset).src !== "manual") ? ` <span class="muted" style="font-size:.7rem" title="${metaFor(o.asset).sym} × ${mult}">×${mult}</span>` : "";
      return `<tr>
        <td>${assetCell(o)}</td>
        <td class="num">${fmtQty(o.qty)}</td>
        <td class="num muted">${fmtPrice(o.avg)}</td>
        <td class="num"><span class="price-tag"><span class="pdot ${pdot}"></span>${fmtPrice(o.price)}${multTag}</span></td>
        <td class="num">${(o.status === "live" && o.changePct != null && o.day) ? `<span class="${cls(o.day)}">${money(o.day, { sign: true })}</span> <span class="muted" style="font-size:.72rem">${pct(o.changePct / 100)}</span>` : `<span class="muted">—</span>`}</td>
        <td class="num">${money(o.mv)}</td>
        <td class="num ${cls(o.upl)}">${money(o.upl, { sign: true })}</td>
        <td class="num ${cls(o.ret)}">${pct(o.ret)}</td>
      </tr>`;
    }).join("");
    const panel = el("div", "panel");
    panel.innerHTML = `
      <div class="panel-head"><h2>${g.title} <span class="tag">${g.rows.length}</span></h2>
        <div class="muted num">${money(sub.mv)} · <span class="${cls(sub.upl)}">${money(sub.upl, { sign: true })}</span></div></div>
      <div class="table-scroll"><table class="tbl">
        <thead><tr>${sortableHead(cols, VIEW.holdSort, "hold")}</tr></thead>
        <tbody>${rows}</tbody>
        <tfoot><tr><td>Subtotal</td><td></td><td></td><td></td>
          <td class="num ${cls(sub.day)}">${sub.day ? money(sub.day, { sign: true }) : ""}</td>
          <td class="num">${money(sub.mv)}</td>
          <td class="num ${cls(sub.upl)}">${money(sub.upl, { sign: true })}</td>
          <td class="num ${cls(sub.cost ? sub.upl / sub.cost : 0)}">${pct(sub.cost ? sub.upl / sub.cost : 0)}</td></tr></tfoot>
      </table></div>`;
    cont.appendChild(panel);
  }
  if (!P.open.length) cont.innerHTML = `<div class="panel"><div class="empty"><div class="big">📊</div>No open positions yet — add a trade to get started.</div></div>`;
}

function renderClosed(P) {
  const body = $("#closedBody");
  const cols = [
    { key: "asset", label: "Asset" },
    { key: "qty", label: "Qty" },
    { key: "avgBuy", label: "Avg Buy" },
    { key: "avgSell", label: "Avg Sell" },
    { key: "cost", label: "Cost" },
    { key: "proceeds", label: "Proceeds" },
    { key: "realized", label: "Realized P&L" },
    { key: "ret", label: "Return" },
  ];
  $("#closedHead").innerHTML = sortableHead(cols, VIEW.closedSort, "closed");
  if (!P.realized.length) { body.innerHTML = `<tr><td colspan="8" class="empty">No sold positions yet.</td></tr>`; $("#closedFoot").innerHTML = ""; return; }
  body.innerHTML = sortRows(P.realized, VIEW.closedSort).map(c => `
    <tr>
      <td>${assetCell(c, c.stillOpen ? "trimmed" : "")}</td>
      <td class="num">${fmtQty(c.qty)}</td>
      <td class="num muted">${fmtPrice(c.avgBuy)}</td>
      <td class="num muted">${fmtPrice(c.avgSell)}</td>
      <td class="num">${money(c.cost)}</td>
      <td class="num">${money(c.proceeds)}</td>
      <td class="num ${cls(c.realized)}">${money(c.realized, { sign: true })}</td>
      <td class="num ${cls(c.ret)}">${pct(c.ret)}</td>
    </tr>`).join("");
  const tc = P.realized.reduce((s, c) => ({ cost: s.cost + c.cost, proc: s.proc + c.proceeds, r: s.r + c.realized }), { cost: 0, proc: 0, r: 0 });
  $("#closedFoot").innerHTML = `<tr><td>Total</td><td></td><td></td><td></td>
    <td class="num">${money(tc.cost)}</td><td class="num">${money(tc.proc)}</td>
    <td class="num ${cls(tc.r)}">${money(tc.r, { sign: true })}</td>
    <td class="num ${cls(tc.cost ? tc.r / tc.cost : 0)}">${pct(tc.cost ? tc.r / tc.cost : 0)}</td></tr>`;
}

/* ---- Execution quality: bougie du jour (close/high/low) par trade, mise en cache ----
   Les trades ne stockent que la DATE (pas l'heure) → la référence est la clôture + le range du jour.
   Sources: crypto=CoinGecko range, actions US=Yahoo daily via r.jina.ai, tokenisés=MEXC klines via jina. ---- */
const EXEC_CCY = /^(USD|USDT|USDC)$/;
const execRefKey = t => `${t.asset}|${t.date}`;
function execEligible(t) {
  const src = metaFor(t.asset).src;
  return EXEC_CCY.test(t.ccy || "") && src && src !== "manual" && t.price > 0;
}
async function fetchExecRef(t) {
  const meta = metaFor(t.asset), mult = multFor(t.asset);
  const day0 = Date.parse(t.date + "T00:00:00Z"), day1 = day0 + 864e5;
  const viaJina = async url => {
    const txt = await fetchText("https://r.jina.ai/" + url);
    const m = txt.match(/Markdown Content:\s*([\[{].*)/s);
    return JSON.parse((m ? m[1] : txt).trim());
  };
  let c, h, l;
  if (meta.src === "coingecko") {
    const id = meta.id || meta.sym;
    const d = await fetchJSON(`https://api.coingecko.com/api/v3/coins/${id}/market_chart/range?vs_currency=usd&from=${day0 / 1000}&to=${day1 / 1000}`);
    const pts = (d.prices || []).map(x => x[1]);
    if (!pts.length) return null;
    c = pts[pts.length - 1]; h = Math.max(...pts); l = Math.min(...pts);
  } else if (meta.src === "mexc") {
    const d = await viaJina(`https://api.mexc.com/api/v3/klines?symbol=${meta.sym}&interval=1d&startTime=${day0}&endTime=${day1}`);
    if (!Array.isArray(d) || !d.length) return null;
    h = +d[0][2]; l = +d[0][3]; c = +d[0][4];
  } else {
    const sym = meta.sym || t.asset;
    const d = await viaJina(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?period1=${day0 / 1000}&period2=${day1 / 1000}&interval=1d`);
    const q = d.chart.result[0].indicators.quote[0];
    if (q.close == null || q.close[0] == null) return null;
    c = q.close[0]; h = q.high[0]; l = q.low[0];
  }
  if (!(c > 0)) return null;
  return { c: c * mult, h: h * mult, l: l * mult };
}
async function checkExecution() {
  const btn = $("#execBtn");
  STATE.execRefs = STATE.execRefs || {};
  const seen = new Set(); const todo = [];
  for (const t of STATE.trades) {
    if (!execEligible(t)) continue;
    const k = execRefKey(t);
    if (STATE.execRefs[k] || seen.has(k)) continue;
    seen.add(k); todo.push(t);
  }
  if (!todo.length) { toast("Execution data already up to date"); return; }
  if (btn) btn.disabled = true;
  let done = 0, fail = 0;
  for (const t of todo) {
    if (btn) btn.innerHTML = `⚖ ${done + fail}/${todo.length}…`;
    try { const ref = await fetchExecRef(t); STATE.execRefs[execRefKey(t)] = ref || { n: 1 }; done++; }
    catch (e) { fail++; }                        // pas de cache en cas d'erreur → retry possible
    saveLocal();
    await new Promise(r => setTimeout(r, metaFor(t.asset).src === "coingecko" ? 1500 : 450));
  }
  if (btn) { btn.disabled = false; btn.innerHTML = "⚖ Exec quality"; }
  saveState(); renderLog();
  toast(`Execution check: ${done} day candles fetched${fail ? `, ${fail} failed (retry later)` : ""}`);
}

function renderLog() {
  const body = $("#logBody");
  const rows = STATE.trades.map((t, i) => ({ t, i }))
    .sort((a, b) => a.t.date < b.t.date ? 1 : a.t.date > b.t.date ? -1 : b.i - a.i);
  $("#logCount").textContent = STATE.trades.length;
  if (!rows.length) { body.innerHTML = `<tr><td colspan="10" class="empty">No trades yet.</td></tr>`; return; }
  body.innerHTML = rows.map(({ t, i }) => {
    const buy = String(t.side).toLowerCase() === "buy";
    const feeCell = t.fee ? `<span class="muted">${moneyIn(t.fee, t.ccy === "EUR" ? "EUR" : (t.ccy || "USD"), 2)}</span>` : `<span class="muted">—</span>`;
    let execCell = `<span class="muted">—</span>`;
    if (execEligible(t)) {
      const ref = (STATE.execRefs || {})[execRefKey(t)];
      if (ref && ref.c) {
        const adv = buy ? (ref.c - t.price) / ref.c : (t.price - ref.c) / ref.c;
        execCell = `<span class="${cls(adv)}" title="Day close ${fmtPrice(ref.c)} · range ${fmtPrice(ref.l)}–${fmtPrice(ref.h)} — ${buy ? "bought" : "sold"} ${adv >= 0 ? "better" : "worse"} than close">${pct(adv)}</span>`;
      } else if (ref && ref.n) execCell = `<span class="muted" title="No market data for that day">n/a</span>`;
      else execCell = `<span class="muted" title="Click ⚖ Exec quality to fetch">·</span>`;
    }
    return `<tr>
      <td>${t.date}</td>
      <td style="text-align:left">${t.asset}</td>
      <td style="text-align:left"><span class="badge-side ${buy ? "buy" : "sell"}">${t.side}</span></td>
      <td style="text-align:left" class="muted">${t.venue}</td>
      <td class="num">${fmtQty(Math.abs(t.qty))}</td>
      <td class="num">${t.price.toLocaleString("en-US", { maximumFractionDigits: 4 })} ${t.ccy}</td>
      <td class="num">${feeCell}</td>
      <td class="num">$${Math.abs(t.totalUSD).toLocaleString("en-US", { maximumFractionDigits: 2 })}</td>
      <td class="num">${execCell}</td>
      <td><div class="row-actions">
        <button title="Edit" data-edit="${i}">${ICON.edit}</button>
        <button title="Delete" data-del="${i}">${ICON.trash}</button>
      </div></td>
    </tr>`;
  }).join("");
}

/* ============================ Trade modal ============================ */
const ICON = {
  edit: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>`,
  trash: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4h8v2m-9 0v14a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2V6"/></svg>`,
  plus: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M12 5v14M5 12h14"/></svg>`,
  refresh: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-2.6-6.4M21 3v6h-6"/></svg>`,
  gear: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1 2 2 0 1 1-4 0 1.6 1.6 0 0 0-2.7-1.1l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0-1.1-2.7 2 2 0 1 1 0-4 1.6 1.6 0 0 0 1.1-2.7l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5 2 2 0 1 1 4 0 1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1 2 2 0 1 1 0 4 1.6 1.6 0 0 0-1.5 1Z"/></svg>`,
  lock: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>`,
  print: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9V3h12v6"/><rect x="4" y="9" width="16" height="7" rx="2"/><path d="M8 16h8v5H8z"/></svg>`,
};

function openModal(node) {
  const back = el("div", "modal-back");
  back.appendChild(node);
  back.addEventListener("click", e => { if (e.target === back) back.remove(); });
  document.body.appendChild(back);
  const first = node.querySelector("input,select"); if (first) first.focus();
  return back;
}

function tradeModal(editIdx = null) {
  const t = editIdx != null ? STATE.trades[editIdx] : { date: new Date().toISOString().slice(0, 10), asset: "", type: "Stock", venue: "", side: "Buy", qty: "", price: "", fee: 0, ccy: "USD" };
  const assetList = [...new Set([...Object.keys(ASSET_META), ...STATE.trades.map(x => x.asset)])].sort();
  const settleChecked = editIdx != null ? !!t.settle : true;
  const m = el("div", "modal");
  m.innerHTML = `
    <h3>${editIdx != null ? "Edit" : "Add"} trade <button class="x">&times;</button></h3>
    <div class="form-grid">
      <div class="field"><label>Date</label><input type="date" id="f_date" value="${t.date}"></div>
      <div class="field"><label>Asset</label><input id="f_asset" list="assetOpts" value="${t.asset}" placeholder="e.g. BTC, COIN">
        <datalist id="assetOpts">${assetList.map(a => `<option value="${a.replace(/"/g, "&quot;")}">`).join("")}</datalist></div>
      <div class="field"><label>Type</label><select id="f_type"><option${t.type === "Stock" ? " selected" : ""}>Stock</option><option${t.type === "Crypto" ? " selected" : ""}>Crypto</option></select></div>
      <div class="field"><label>Venue</label><input id="f_venue" value="${t.venue}" placeholder="Revolut, Nexo…"></div>
      <div class="field"><label>Side</label><select id="f_side"><option${t.side === "Buy" ? " selected" : ""}>Buy</option><option${t.side === "Sell" ? " selected" : ""}>Sell</option></select></div>
      <div class="field"><label>Currency</label><select id="f_ccy">${CCYS.map(c => `<option${t.ccy === c ? " selected" : ""}>${c}</option>`).join("")}</select></div>
      <div class="field"><label>Quantity</label><input id="f_qty" type="number" step="any" value="${t.qty}" placeholder="0.00"></div>
      <div class="field"><label>Price (per unit)</label><input id="f_price" type="number" step="any" value="${t.price}" placeholder="0.00"></div>
      <div class="field"><label>Fee</label><input id="f_fee" type="number" step="any" value="${t.fee || 0}"></div>
      <div class="field"><label>FX (EUR→USD)</label><input id="f_fx" type="number" step="any" value="${FX().toFixed(4)}">
        <div class="hint">Used only for EUR trades → stored USD cost</div></div>
      <div class="field full" id="f_srcbox" style="display:none;background:var(--surface-2);border:1px solid var(--border);border-radius:10px;padding:12px">
        <label>Live price feed <span class="muted" style="text-transform:none;font-weight:400">— new asset, tell it where to price from</span></label>
        <div style="display:flex;gap:8px;margin-top:4px">
          <select id="f_src" style="flex:0 0 46%">
            <option value="finnhub">Stock · Finnhub</option>
            <option value="coingecko">Crypto · CoinGecko</option>
            <option value="mexc">MEXC pair</option>
            <option value="manual">Manual price</option>
          </select>
          <input id="f_sym" placeholder="ticker / id / pair" style="flex:1">
          <span class="muted" style="font-size:.85rem;align-self:center">×</span><input id="f_mult" type="number" step="any" value="1" title="Multiplier — scale the feed price (e.g. track SPY × 0.0505)" style="width:90px">
        </div>
        <div class="hint" id="f_srchint"></div>
      </div>
      <div class="computed full"><span class="muted">Total cost (USD, incl. fee)</span><span id="f_total" class="num">—</span></div>
      <label class="settle-row full"><input type="checkbox" id="f_settle"${settleChecked ? " checked" : ""}>
        <span>Settle in cash — updates your <b id="f_settleccy">${t.ccy || "USD"}</b> balance</span></label>
    </div>
    <div class="modal-actions">
      <button class="btn" id="f_cancel">Cancel</button>
      <button class="btn primary" id="f_save">${editIdx != null ? "Save changes" : "Add trade"}</button>
    </div>`;
  const back = openModal(m);
  const close = () => back.remove();
  m.querySelector(".x").onclick = close;
  $("#f_cancel", m).onclick = close;

  const calc = () => {
    const qty = parseFloat($("#f_qty", m).value) || 0;
    const price = parseFloat($("#f_price", m).value) || 0;
    const fee = parseFloat($("#f_fee", m).value) || 0;
    const ccy = $("#f_ccy", m).value;
    const fx = parseFloat($("#f_fx", m).value) || 1;
    const side = $("#f_side", m).value.toLowerCase();
    let gross = qty * price;
    let total = side === "buy" ? gross + fee : gross - fee;   // native ccy
    if (ccy === "EUR") total *= fx;                            // → USD
    $("#f_total", m).textContent = "$" + total.toLocaleString("en-US", { maximumFractionDigits: 2 });
    return total;
  };
  ["f_qty", "f_price", "f_fee", "f_ccy", "f_fx", "f_side"].forEach(id => { $("#" + id, m).oninput = calc; $("#" + id, m).onchange = calc; });
  $("#f_ccy", m).addEventListener("change", () => { $("#f_settleccy", m).textContent = $("#f_ccy", m).value; });
  // auto-set type from known asset
  const symHint = s => ({ finnhub: "US ticker (e.g. AAPL). Foreign index ETF? Use a US proxy like SPY and set × to scale.", coingecko: "CoinGecko id, e.g. bitcoin, solana, ripple", mexc: "MEXC pair, e.g. NOWONUSDT", manual: "no feed — set the price in ⚙ Settings" }[s] || "");
  const defSym = (a, s) => s === "finnhub" ? a.toUpperCase() : s === "coingecko" ? a.toLowerCase() : s === "mexc" ? a.toUpperCase() + "USDT" : "";
  const updateSrcBox = () => {
    const a = $("#f_asset", m).value.trim();
    const known = !!ASSET_META[a];
    const box = $("#f_srcbox", m);
    if (!a || known) { box.style.display = "none"; if (known) $("#f_type", m).value = metaFor(a).cls === "crypto" ? "Crypto" : "Stock"; return; }
    box.style.display = "";
    const reg = (STATE.assetMeta || {})[a];
    if (reg) { $("#f_src", m).value = reg.src || "manual"; $("#f_sym", m).value = reg.sym || ""; $("#f_mult", m).value = reg.mult || 1; }
    else { const s = $("#f_type", m).value === "Crypto" ? "coingecko" : "finnhub"; $("#f_src", m).value = s; $("#f_sym", m).value = defSym(a, s); $("#f_mult", m).value = 1; }
    $("#f_srchint", m).textContent = symHint($("#f_src", m).value);
  };
  $("#f_asset", m).oninput = updateSrcBox;
  $("#f_type", m).addEventListener("change", () => { const a = $("#f_asset", m).value.trim(); if (a && !ASSET_META[a] && !(STATE.assetMeta || {})[a]) { const s = $("#f_type", m).value === "Crypto" ? "coingecko" : "finnhub"; $("#f_src", m).value = s; $("#f_sym", m).value = defSym(a, s); $("#f_srchint", m).textContent = symHint(s); } });
  $("#f_src", m).addEventListener("change", () => { $("#f_srchint", m).textContent = symHint($("#f_src", m).value); const a = $("#f_asset", m).value.trim(); if (a) $("#f_sym", m).value = defSym(a, $("#f_src", m).value); });
  updateSrcBox();
  calc();

  $("#f_save", m).onclick = () => {
    const asset = $("#f_asset", m).value.trim();
    const qty = Math.abs(parseFloat($("#f_qty", m).value));
    const price = parseFloat($("#f_price", m).value);
    if (!asset || !qty || isNaN(price)) { toast("Fill asset, quantity and price", true); return; }
    const totalUSD = Math.abs(calc());
    const side = $("#f_side", m).value;
    const rec = {
      id: (editIdx != null && STATE.trades[editIdx].id) ? STATE.trades[editIdx].id : uid(),
      date: $("#f_date", m).value, asset, type: $("#f_type", m).value,
      venue: $("#f_venue", m).value.trim() || "—", side,
      qty, price, fee: parseFloat($("#f_fee", m).value) || 0,
      totalUSD: side === "Sell" ? -totalUSD : totalUSD, ccy: $("#f_ccy", m).value,
      settle: $("#f_settle", m).checked,
    };
    if (!ASSET_META[asset]) {   // new/user asset → remember its class + price feed
      STATE.assetMeta = STATE.assetMeta || {};
      STATE.assetMeta[asset] = { cls: rec.type === "Crypto" ? "crypto" : "stock",
        src: $("#f_src", m).value, sym: $("#f_sym", m).value.trim() || undefined,
        mult: parseFloat($("#f_mult", m).value) || 1 };
    }
    if (editIdx != null) STATE.trades[editIdx] = rec; else STATE.trades.push(rec);
    syncTradeCash(rec);
    saveState(); render(); close();
    toast(editIdx != null ? "Trade updated" : "Trade added");
    if (metaFor(asset).src !== "manual") refreshPrices();   // pull a live price for it now
  };
}

function deleteTrade(i) {
  const t = STATE.trades[i];
  if (!confirm(`Delete this trade?\n\n${t.date} · ${t.side} ${fmtQty(Math.abs(t.qty))} ${t.asset} @ ${t.price}`)) return;
  if (t.id) STATE.cash = (STATE.cash || []).filter(e => e.tradeId !== t.id);   // remove linked cash movement
  STATE.trades.splice(i, 1); saveState(); render(); toast("Trade deleted");
}

function deleteCash(i) {
  const e = (STATE.cash || [])[i];
  if (!e) return;
  if (e.tradeId) { toast("This came from a trade — edit or delete that trade instead", true); return; }
  // convert entries come in pairs (grp): remove both legs
  if (e.grp) STATE.cash = STATE.cash.filter(x => x.grp !== e.grp);
  else STATE.cash.splice(i, 1);
  saveState(); render(); toast("Cash entry removed");
}

function interestModal() {
  const today = new Date().toISOString().slice(0, 10);
  const I = interestTotals();
  const rows = [...(STATE.interest || [])].map((e, i) => ({ e, i }))
    .sort((a, b) => a.e.date < b.e.date ? 1 : a.e.date > b.e.date ? -1 : 0);
  const m = el("div", "modal");
  m.innerHTML = `<h3>Interest <button class="x">&times;</button></h3>
    <div class="cash-bals" style="margin-bottom:12px">
      <div class="cash-chip"><span class="cc">RECEIVED</span><span class="cv num pos">${money(I.received)}</span></div>
      <div class="cash-chip"><span class="cc">PAID</span><span class="cv num neg">${money(I.paid)}</span></div>
      <div class="cash-chip"><span class="cc">NET</span><span class="cv num ${cls(I.net)}">${money(I.net, { sign: true })}</span></div>
    </div>
    <div class="form-grid">
      <div class="field"><label>Date</label><input type="date" id="i_date" value="${today}"></div>
      <div class="field"><label>Type</label><select id="i_kind"><option value="received">Received (earned)</option><option value="paid">Paid (loan)</option></select></div>
      <div class="field"><label>Currency</label><select id="i_ccy">${CCYS.map(c => `<option${c === "USD" ? " selected" : ""}>${c}</option>`).join("")}</select></div>
      <div class="field"><label>Amount</label><input id="i_amt" type="number" step="any" placeholder="0.00"></div>
      <div class="field full"><label>Note</label><input id="i_note" placeholder="e.g. Nexo savings interest"></div>
    </div>
    <div class="modal-actions"><button class="btn primary" id="i_add">＋ Add entry</button></div>
    ${rows.length ? `<div class="settings-row"><div class="info"><div class="t" style="margin-top:12px">History (${rows.length})</div></div></div>
      <div class="cash-list" style="max-height:230px;overflow:auto">${rows.map(({ e, i }) => `<div class="cash-tx">
        <span class="k k-${e.kind === "paid" ? "withdraw" : "deposit"}">${e.kind === "paid" ? "Paid" : "Received"}</span>
        <span class="tn">${e.note || ""}${e.source ? ` <span class="muted">(${e.source})</span>` : ""}</span>
        <span class="td muted">${e.date}</span>
        <span class="ta num ${e.kind === "paid" ? "neg" : "pos"}">${moneyIn(Math.abs(e.amount), e.ccy || "USD", 2)}</span>
        <button class="cash-del" data-intdel="${i}" title="Delete">${ICON.trash}</button>
      </div>`).join("")}</div>` : `<div class="muted" style="font-size:.85rem;padding:8px 0">No interest logged yet.</div>`}
    <div class="modal-actions"><button class="btn" id="i_close">Close</button></div>`;
  const back = openModal(m); const close = () => back.remove();
  m.querySelector(".x").onclick = close; $("#i_close", m).onclick = close;
  $("#i_add", m).onclick = () => {
    const amt = Math.abs(parseFloat($("#i_amt", m).value));
    if (!amt) return toast("Enter an amount", true);
    const kind = $("#i_kind", m).value;
    STATE.interest = STATE.interest || [];
    STATE.interest.push({ date: $("#i_date", m).value, kind, ccy: $("#i_ccy", m).value, amount: amt, note: $("#i_note", m).value.trim() || (kind === "paid" ? "Loan interest" : "Interest earned") });
    saveState(); render(); close(); toast(`Interest ${kind} logged`);
  };
}
function deleteInterest(i) {
  const e = (STATE.interest || [])[i]; if (!e) return;
  if (!confirm(`Delete this interest entry?\n\n${e.date} · ${e.kind} · ${moneyIn(Math.abs(e.amount), e.ccy || "USD", 2)}`)) return;
  STATE.interest.splice(i, 1); saveState(); render(); toast("Interest entry removed");
}

function cashModal(kind) {
  const today = new Date().toISOString().slice(0, 10);
  const bal = cashBalances();
  const titles = { deposit: "Add cash", withdraw: "Withdraw cash", convert: "Convert currency", adjust: "Set cash balance" };
  const ccyOpts = sel => CCYS.map(c => `<option${c === sel ? " selected" : ""}>${c}</option>`).join("");
  const m = el("div", "modal");

  let body;
  if (kind === "convert") {
    body = `<div class="form-grid">
      <div class="field"><label>Date</label><input type="date" id="c_date" value="${today}"></div>
      <div class="field"><label>From</label><select id="c_from">${ccyOpts("EUR")}</select></div>
      <div class="field"><label>Amount (from)</label><input id="c_amt" type="number" step="any" placeholder="0.00"></div>
      <div class="field"><label>To</label><select id="c_to">${ccyOpts("USDT")}</select></div>
      <div class="field full"><label>Rate (to per from)</label><input id="c_rate" type="number" step="any"></div>
      <div class="computed full"><span class="muted">You receive</span><span id="c_recv" class="num">—</span></div>
    </div>`;
  } else if (kind === "adjust") {
    body = `<div class="form-grid">
      <div class="field"><label>Currency</label><select id="c_ccy">${ccyOpts("USD")}</select></div>
      <div class="field"><label>Set balance to</label><input id="c_target" type="number" step="any" placeholder="0.00"></div>
      <div class="computed full"><span class="muted">Adjustment</span><span id="c_adj" class="num">—</span></div>
    </div>`;
  } else {
    body = `<div class="form-grid">
      <div class="field"><label>Date</label><input type="date" id="c_date" value="${today}"></div>
      <div class="field"><label>Currency</label><select id="c_ccy">${ccyOpts("USD")}</select></div>
      <div class="field full"><label>Amount</label><input id="c_amt" type="number" step="any" placeholder="0.00"></div>
      <div class="field full"><label>Note</label><input id="c_note" value="${kind === "deposit" ? "Salary" : ""}" placeholder="${kind === "deposit" ? "Salary, transfer in…" : "Reason"}"></div>
    </div>`;
  }
  m.innerHTML = `<h3>${titles[kind]} <button class="x">&times;</button></h3>${body}
    <div class="modal-actions"><button class="btn" id="c_cancel">Cancel</button>
      <button class="btn primary" id="c_ok">${titles[kind]}</button></div>`;
  const back = openModal(m); const close = () => back.remove();
  m.querySelector(".x").onclick = close; $("#c_cancel", m).onclick = close;

  if (kind === "convert") {
    const usdPer = { USD: 1, USDT: 1, USDC: 1, EUR: FX() };
    const setRate = () => { const f = $("#c_from", m).value, tt = $("#c_to", m).value; $("#c_rate", m).value = (f === tt ? 1 : usdPer[f] / usdPer[tt]).toFixed(4); recalc(); };
    const recalc = () => { const amt = parseFloat($("#c_amt", m).value) || 0, rate = parseFloat($("#c_rate", m).value) || 0; $("#c_recv", m).textContent = moneyIn(amt * rate, $("#c_to", m).value, 2); };
    $("#c_from", m).onchange = setRate; $("#c_to", m).onchange = setRate;
    $("#c_amt", m).oninput = recalc; $("#c_rate", m).oninput = recalc; setRate();
    $("#c_ok", m).onclick = () => {
      const from = $("#c_from", m).value, to = $("#c_to", m).value;
      const amt = Math.abs(parseFloat($("#c_amt", m).value)), rate = parseFloat($("#c_rate", m).value);
      if (!amt || !rate || from === to) return toast("Enter amount, rate, and two different currencies", true);
      const grp = uid(), d = $("#c_date", m).value;
      STATE.cash.push({ date: d, ccy: from, amount: -amt, kind: "convert", note: `→ ${to}`, grp });
      STATE.cash.push({ date: d, ccy: to, amount: amt * rate, kind: "convert", note: `from ${from}`, grp });
      saveState(); render(); close(); toast(`Converted ${moneyIn(amt, from, 2)} → ${moneyIn(amt * rate, to, 2)}`);
    };
  } else if (kind === "adjust") {
    const recalc = () => { const ccy = $("#c_ccy", m).value, tgt = parseFloat($("#c_target", m).value); const adj = isNaN(tgt) ? 0 : tgt - (bal[ccy] || 0); $("#c_adj", m).textContent = `${adj >= 0 ? "+" : ""}${moneyIn(adj, ccy, 2)} (was ${moneyIn(bal[ccy] || 0, ccy, 2)})`; };
    $("#c_ccy", m).onchange = recalc; $("#c_target", m).oninput = recalc; recalc();
    $("#c_ok", m).onclick = () => {
      const ccy = $("#c_ccy", m).value, tgt = parseFloat($("#c_target", m).value);
      if (isNaN(tgt)) return toast("Enter a target balance", true);
      const adj = tgt - (bal[ccy] || 0);
      if (Math.abs(adj) >= 0.005) STATE.cash.push({ date: today, ccy, amount: adj, kind: "adjust", note: "Set balance" });
      saveState(); render(); close(); toast(`${ccy} balance set to ${moneyIn(tgt, ccy, 2)}`);
    };
  } else {
    $("#c_ok", m).onclick = () => {
      const ccy = $("#c_ccy", m).value, amt = Math.abs(parseFloat($("#c_amt", m).value));
      if (!amt) return toast("Enter an amount", true);
      STATE.cash.push({ date: $("#c_date", m).value, ccy, amount: kind === "withdraw" ? -amt : amt, kind,
        note: $("#c_note", m).value.trim() || (kind === "deposit" ? "Deposit" : "Withdrawal") });
      saveState(); render(); close(); toast(`${kind === "deposit" ? "Added" : "Withdrew"} ${moneyIn(amt, ccy, 2)}`);
    };
  }
}

/* ============================ Settings / prices / data ============================ */
function settingsModal() {
  const manualAssets = heldAssets().filter(a => metaFor(a).src === "manual");
  const mexcAssets = heldAssets().filter(a => metaFor(a).src === "mexc");
  const m = el("div", "modal");
  m.innerHTML = `
    <h3>Settings <button class="x">&times;</button></h3>
    <div class="settings-row">
      <div class="info"><div class="t">Finnhub API key (stocks)</div>
        <div class="d">Free key at finnhub.io. Enables live US stock prices. Crypto already works without a key. Stored only in this browser.</div></div>
    </div>
    <div class="field full"><input id="s_key" value="${STATE.settings.finnhubKey || ""}" placeholder="Paste Finnhub key…"></div>

    ${mexcAssets.length ? `<div class="settings-row"><div class="info"><div class="t" style="margin-top:14px">MEXC feeds &amp; multipliers</div>
      <div class="d">Fetched from MEXC via a proxy. The multiplier converts the token price to your share-equivalent price.</div></div></div>
      ${mexcAssets.map(a => `<div class="field full" style="display:flex;gap:10px;align-items:center">
        <label style="flex:1;margin:0;text-transform:none;font-size:.85rem;color:var(--text)">${a} <span class="muted">(${metaFor(a).sym})</span></label>
        <span class="muted" style="font-size:.85rem">×</span><input data-mult="${a.replace(/"/g, "&quot;")}" type="number" step="any" style="width:100px" value="${multFor(a)}">
      </div>`).join("")}` : ""}

    ${manualAssets.length ? `<div class="settings-row"><div class="info"><div class="t" style="margin-top:14px">Manual prices</div>
      <div class="d">Assets without an automatic feed (e.g. private equity). Set the current price per unit (USD).</div></div></div>
      ${manualAssets.map(a => `<div class="field full" style="display:flex;gap:10px;align-items:center">
        <label style="flex:1;margin:0;text-transform:none;font-size:.85rem;color:var(--text)">${a}</label>
        <input data-mp="${a.replace(/"/g, "&quot;")}" type="number" step="any" style="width:150px" value="${STATE.manualPrices[a] ?? ""}">
      </div>`).join("")}` : ""}

    <div class="settings-row"><div class="info"><div class="t" style="margin-top:14px">Backup to private GitHub</div>
      <div class="d">Saves <b>data.json + trades.csv + cash.csv</b> to your <b>private</b> data repo over HTTPS (CSVs render as tables on GitHub). Use a <b>fine-grained token</b> scoped to that repo (Contents: Read and write) — stored only in this browser, revocable anytime. <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" style="color:var(--accent)">Create token ↗</a></div></div></div>
    <div class="field full"><label>Private data repo (owner/name)</label><input id="s_gh_repo" value="${(ghCfg().repo || "Boulou1/wealth-data")}" placeholder="owner/repo"></div>
    <div class="field full"><label>Access token</label><input id="s_gh_token" type="password" value="${ghCfg().token || ""}" placeholder="github_pat_…"></div>
    <label class="settle-row full"><input type="checkbox" id="s_gh_auto"${ghCfg().auto ? " checked" : ""}> <span>Auto-backup after every change (new trades push to Git automatically)</span></label>
    <div class="modal-actions" style="margin-top:8px">
      <button class="btn primary" id="s_gh_backup">⬆ Back up now</button>
      <button class="btn" id="s_gh_restore">⬇ Restore from GitHub</button>
      <span class="muted" id="s_gh_status" style="align-self:center;font-size:.8rem"></span>
    </div>

    <div class="settings-row"><div class="info"><div class="t" style="margin-top:14px">Your data</div>
      <div class="d">Everything lives in this browser. Export to back up or move devices.</div></div></div>
    <div class="modal-actions" style="margin-top:8px">
      <button class="btn" id="s_export">⬇ Export JSON</button>
      <button class="btn" id="s_import">⬆ Import JSON</button>
      <button class="btn" id="s_reset">↺ Reset to seed</button>
    </div>
    <div class="modal-actions">
      <button class="btn" id="s_change">Change passcode</button>
      <button class="btn primary" id="s_save">Save</button>
    </div>
    <input type="file" id="s_file" accept="application/json" class="hidden">`;
  const back = openModal(m);
  const close = () => back.remove();
  m.querySelector(".x").onclick = close;

  const saveGh = () => { const c = ghCfg(); c.repo = $("#s_gh_repo", m).value.trim(); c.token = $("#s_gh_token", m).value.trim(); c.auto = $("#s_gh_auto", m).checked; setGhCfg(c); return c; };
  const ghStatus = () => { const s = $("#s_gh_status", m); if (!s) return; const c = ghCfg(); s.textContent = c.lastBackup ? "Last backup " + new Date(c.lastBackup).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : (c.token ? "Not backed up yet" : ""); };

  $("#s_save", m).onclick = () => {
    STATE.settings.finnhubKey = $("#s_key", m).value.trim();
    $$("[data-mp]", m).forEach(inp => {
      const a = inp.getAttribute("data-mp"); const v = parseFloat(inp.value);
      if (!isNaN(v)) STATE.manualPrices[a] = v;
    });
    STATE.settings.multipliers = STATE.settings.multipliers || {};
    $$("[data-mult]", m).forEach(inp => {
      const a = inp.getAttribute("data-mult"); const v = parseFloat(inp.value);
      if (!isNaN(v)) STATE.settings.multipliers[a] = v;
    });
    saveGh();
    saveState(); render(); close(); toast("Settings saved");
    refreshPrices();
    if (ghReady() && (!STATE.trades || !STATE.trades.length)) ghRestore();   // just added token on a fresh device → pull data
  };
  ghStatus();
  $("#s_gh_backup", m).onclick = async () => { saveGh(); const b = $("#s_gh_backup", m); b.disabled = true; b.textContent = "Backing up…"; await ghBackup(false); b.disabled = false; b.textContent = "⬆ Back up now"; ghStatus(); };
  $("#s_gh_restore", m).onclick = async () => { if (!confirm("Restore from GitHub? This replaces your current local data with the backup.")) return; saveGh(); await ghRestore(); ghStatus(); };
  $("#s_export", m).onclick = exportData;
  $("#s_import", m).onclick = () => $("#s_file", m).click();
  $("#s_file", m).onchange = e => importData(e.target.files[0], close);
  $("#s_reset", m).onclick = () => { if (confirm("Reset all data back to the original seed? This clears your local changes.")) { STATE = defaultState(); saveState(); render(); close(); toast("Reset to seed"); } };
  $("#s_change", m).onclick = () => { close(); changePasscodeModal(); };
}

function buildCSV() {
  const lines = ["TRADES", csvTrades(), "", "CASH TRANSACTIONS", csvCash()];
  if ((STATE.interest || []).length) {
    const I = interestTotals(), r2 = n => Math.round(n * 100) / 100;
    lines.push("", "INTEREST", csvInterest(),
      `,TOTAL RECEIVED (USD),,${r2(I.received)},,`,
      `,TOTAL PAID (USD),,${r2(I.paid)},,`,
      `,NET (USD),,${r2(I.net)},,`);
  }
  const bal = cashBalances();
  lines.push("", "CASH BALANCES", "Currency,Balance", ...CCYS.map(c => `${c},${bal[c]}`));
  return lines.join("\n");
}
function exportCSV() {
  const trades = STATE.trades || [], cash = STATE.cash || [];
  if (!trades.length && !cash.length) return toast("Nothing to export", true);
  const blob = new Blob([buildCSV()], { type: "text/csv;charset=utf-8" });
  const a = el("a"); a.href = URL.createObjectURL(blob);
  a.download = `wealth-export-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click(); URL.revokeObjectURL(a.href);
  toast(`Exported ${trades.length} trades + ${cash.length} cash entries`);
}
function exportData() {
  const data = { version: 1, exported: new Date().toISOString(), trades: STATE.trades,
    snapshots: STATE.snapshots, cash: STATE.cash, interest: STATE.interest, savings: STATE.savings, wallets: STATE.wallets, execRefs: STATE.execRefs, assetMeta: STATE.assetMeta, manualPrices: STATE.manualPrices, fxEURUSD: STATE.fxEURUSD };
  const blob = new Blob([JSON.stringify(data, null, 1)], { type: "application/json" });
  const a = el("a"); a.href = URL.createObjectURL(blob);
  a.download = `wealth-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click(); URL.revokeObjectURL(a.href); toast("Exported backup");
}
function importData(file, done) {
  if (!file) return;
  const r = new FileReader();
  r.onload = () => {
    try {
      const d = JSON.parse(r.result);
      if (!Array.isArray(d.trades)) throw new Error("no trades array");
      STATE.trades = d.trades;
      if (Array.isArray(d.snapshots)) STATE.snapshots = d.snapshots;
      if (Array.isArray(d.cash)) STATE.cash = d.cash;
      if (Array.isArray(d.interest)) STATE.interest = d.interest;
      if (Array.isArray(d.savings)) STATE.savings = d.savings;
      if (Array.isArray(d.wallets)) STATE.wallets = d.wallets;
      if (d.execRefs) STATE.execRefs = d.execRefs;
      if (d.assetMeta) STATE.assetMeta = d.assetMeta;
      if (d.manualPrices) STATE.manualPrices = d.manualPrices;
      if (d.fxEURUSD) STATE.fxEURUSD = d.fxEURUSD;
      saveState(); render(); if (done) done(); toast(`Imported ${d.trades.length} trades`);
    } catch (e) { toast("Import failed: " + e.message, true); }
  };
  r.readAsText(file);
}

/* ============================ GitHub private backup ============================ */
const GH_KEY = "gh_backup_cfg";   // {token, repo, path, branch, auto, lastBackup} — kept OUT of exported data
function ghCfg() { try { return JSON.parse(localStorage.getItem(GH_KEY)) || {}; } catch (e) { return {}; } }
function setGhCfg(c) { localStorage.setItem(GH_KEY, JSON.stringify(c)); }
function ghReady() { const c = ghCfg(); return !!(c.token && c.repo); }
const b64enc = s => btoa(unescape(encodeURIComponent(s)));
const b64dec = b => decodeURIComponent(escape(atob(b)));

function backupPayload() {   // full snapshot; token lives outside STATE so it is never included
  return { version: 1, exported: new Date().toISOString(), trades: STATE.trades, snapshots: STATE.snapshots,
    cash: STATE.cash, interest: STATE.interest, savings: STATE.savings, wallets: STATE.wallets, execRefs: STATE.execRefs, assetMeta: STATE.assetMeta, manualPrices: STATE.manualPrices,
    settings: { finnhubKey: STATE.settings.finnhubKey || "", multipliers: STATE.settings.multipliers || {} },
    fxEURUSD: STATE.fxEURUSD };
}
async function ghApi(method, path, body) {
  const c = ghCfg();
  const r = await fetch(`https://api.github.com/repos/${c.repo}/${path}`, {
    method, headers: { Authorization: `Bearer ${c.token}`, Accept: "application/vnd.github+json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 140)}`);
  return r.json();
}
async function ghSha(path, branch) {
  try { return (await ghApi("GET", `contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(branch)}`)).sha; }
  catch (e) { return null; }   // 404 = file doesn't exist yet
}
const csvEsc = v => { v = v == null ? "" : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
const csvByDate = (a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0;
const CASH_KIND = { deposit: "Deposit", withdraw: "Withdraw", convert: "Convert", adjust: "Set balance", buy: "Buy", sell: "Sell" };
const CSV_HEADERS = {
  trades: "Date,Asset,Type,Venue,Side,Quantity,Price,Currency,Fee,Total USD",
  cash: "Date,Transaction,Currency,Amount,Note",
  interest: "Date,Type,Currency,Amount,Note,Source",
};
function csvTrades() {
  const cols = ["date", "asset", "type", "venue", "side", "qty", "price", "ccy", "fee", "totalUSD"];
  return [CSV_HEADERS.trades, ...[...(STATE.trades || [])].sort(csvByDate).map(t => cols.map(c => csvEsc(t[c])).join(","))].join("\n");
}
function csvCash() {
  return [CSV_HEADERS.cash, ...[...(STATE.cash || [])].sort(csvByDate)
    .map(e => [e.date, CASH_KIND[e.kind] || e.kind, e.ccy, e.amount, e.note || ""].map(csvEsc).join(","))].join("\n");
}
function csvInterest() {
  return [CSV_HEADERS.interest, ...[...(STATE.interest || [])].sort(csvByDate)
    .map(e => [e.date, e.kind === "paid" ? "Paid" : "Received", e.ccy || "USD", e.amount, e.note || "", e.source || ""].map(csvEsc).join(","))].join("\n");
}
let D_EXPORT_STAMP = null;      // `exported` value of whatever we last pushed/pulled
const ghShaCache = {};   // path -> last known sha, so we don't rely on a (possibly stale) GET
async function ghPutFile(path, contentStr, message) {
  const branch = ghCfg().branch || "main";
  let sha = ghShaCache[path] || await ghSha(path, branch);
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const res = await ghApi("PUT", `contents/${encodeURIComponent(path)}`, { message, content: b64enc(contentStr), sha: sha || undefined, branch });
      if (res && res.content && res.content.sha) ghShaCache[path] = res.content.sha;   // remember the new sha for next write
      return;
    } catch (e) {
      const msg = String(e.message);
      // On a conflict, GitHub reports the current sha in the message ("... does not match <sha>"). Use it.
      if ((msg.startsWith("409") || msg.startsWith("422")) && attempt < 5) {
        const m = msg.match(/does not match ([0-9a-f]{7,40})/);
        sha = m ? m[1] : await ghSha(path, branch);
        ghShaCache[path] = sha;
        await new Promise(r => setTimeout(r, 300 * (attempt + 1)));   // let a concurrent writer settle
        continue;
      }
      throw e;
    }
  }
}
let ghBusy = false;
async function ghBackup(silent) {
  const c = ghCfg();
  if (!c.token || !c.repo) { if (!silent) toast("Set up GitHub backup in Settings first", true); return false; }
  if (ghBusy) { if (!silent) toast("A backup is already in progress…"); return false; }   // no concurrent writes
  ghBusy = true;
  try {
    const stamp = new Date().toISOString();
    const payload = backupPayload(); D_EXPORT_STAMP = payload.exported;
    await ghPutFile("data.json", JSON.stringify(payload, null, 1), `backup ${stamp}`);   // canonical (restore reads this)
    await ghPutFile("trades.csv", csvTrades(), `backup ${stamp}`);                                // readable table on GitHub
    await ghPutFile("cash.csv", csvCash(), `backup ${stamp}`);
    if ((STATE.interest || []).length) await ghPutFile("interest.csv", csvInterest(), `backup ${stamp}`);
    c.lastBackup = Date.now(); c.syncedExport = D_EXPORT_STAMP; setGhCfg(c);
    if (!silent) toast("Backed up to GitHub ✓ (data.json, trades.csv, cash.csv)");
    return true;
  } catch (e) { toast("GitHub backup failed: " + e.message, true); return false; }
  finally { ghBusy = false; }
}
async function ghRestore() {
  const c = ghCfg();
  if (!c.token || !c.repo) return toast("Set up GitHub backup first", true);
  const path = "data.json", branch = c.branch || "main";
  try {
    const d = await ghApi("GET", `contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(branch)}`);
    const j = JSON.parse(b64dec(d.content));
    if (!Array.isArray(j.trades)) throw new Error("backup has no trades");
    STATE.trades = j.trades;
    if (Array.isArray(j.snapshots)) STATE.snapshots = j.snapshots;
    if (Array.isArray(j.cash)) STATE.cash = j.cash;
    if (Array.isArray(j.interest)) STATE.interest = j.interest;
    if (Array.isArray(j.savings)) STATE.savings = j.savings;
    if (Array.isArray(j.wallets)) STATE.wallets = j.wallets;
    if (j.execRefs) STATE.execRefs = j.execRefs;
    if (j.assetMeta) STATE.assetMeta = j.assetMeta;
    if (j.manualPrices) STATE.manualPrices = j.manualPrices;
    if (j.settings) { STATE.settings.finnhubKey = j.settings.finnhubKey || STATE.settings.finnhubKey; STATE.settings.multipliers = j.settings.multipliers || STATE.settings.multipliers; }
    if (j.fxEURUSD) STATE.fxEURUSD = j.fxEURUSD;
    D_EXPORT_STAMP = j.exported || null;
    const c2 = ghCfg(); c2.syncedExport = D_EXPORT_STAMP; setGhCfg(c2);
    const b = $("#syncBanner"); if (b) b.remove();
    saveLocal(); render(); refreshPrices();   // just pulled from the repo — don't immediately push it back
    toast(`Restored ${STATE.trades.length} trades from GitHub ✓`);
  } catch (e) { toast("Restore failed: " + e.message, true); }
}
let ghTimer = null;
function ghAutoBackup() {
  const c = ghCfg();
  if (!c.auto || !c.token || !c.repo) return;
  clearTimeout(ghTimer);
  ghTimer = setTimeout(() => ghBackup(true), 3000);   // debounce bursts of edits into one push
}

/* ============================ Passcode gate ============================ */
async function initGate() {
  const gate = $("#gate"), app = $("#app");
  const sharedMode = !!GATE_HASH;                                   // public deploy: one password for everyone
  const hash = sharedMode ? GATE_HASH : localStorage.getItem("gateHash");
  if (sessionStorage.getItem("unlocked") === "1") { gate.classList.add("hidden"); app.classList.remove("hidden"); boot(); return true; }

  const title = $("#gateTitle"), sub = $("#gateSub"), inp = $("#gateInput"), err = $("#gateErr"), btn = $("#gateBtn");
  const setup = !sharedMode && !hash;                              // only offer "set" for per-device local use
  title.textContent = setup ? "Set a passcode" : "Enter password";
  sub.textContent = setup ? "Protects this dashboard on this device." : (sharedMode ? "Enter the page password." : "Welcome back.");
  btn.textContent = setup ? "Set & unlock" : "Unlock";

  const submit = async () => {
    const val = inp.value;
    if (!val) return;
    if (setup) {
      if (val.length < 4) { err.textContent = "Use at least 4 characters."; return; }
      localStorage.setItem("gateHash", await sha256(val));
      unlock();
    } else {
      if (await sha256(val) === hash) unlock();
      else { err.textContent = "Wrong passcode."; inp.value = ""; inp.focus(); }
    }
  };
  const unlock = () => { sessionStorage.setItem("unlocked", "1"); gate.classList.add("hidden"); app.classList.remove("hidden"); boot(); };
  btn.onclick = submit;
  inp.onkeydown = e => { if (e.key === "Enter") submit(); };
  inp.focus();
  return false;
}
function changePasscodeModal() {
  const m = el("div", "modal");
  m.innerHTML = `<h3>Change passcode <button class="x">&times;</button></h3>
    <div class="field full"><label>New passcode</label><input id="p_new" type="password" placeholder="At least 4 characters"></div>
    <div class="field full" style="margin-top:10px"><label>Confirm</label><input id="p_conf" type="password"></div>
    <div class="modal-actions"><button class="btn" id="p_cancel">Cancel</button><button class="btn primary" id="p_ok">Update</button></div>`;
  const back = openModal(m); const close = () => back.remove();
  m.querySelector(".x").onclick = close; $("#p_cancel", m).onclick = close;
  $("#p_ok", m).onclick = async () => {
    const a = $("#p_new", m).value, b = $("#p_conf", m).value;
    if (a.length < 4) return toast("At least 4 characters", true);
    if (a !== b) return toast("Passcodes don't match", true);
    localStorage.setItem("gateHash", await sha256(a)); close(); toast("Passcode updated");
  };
}

function printReport() {
  const map = buildPriceMap(), P = computePortfolio(map);
  const totalValue = P.totals.mv + totalCashUSD() + savingsTotals().usd + walletTotals().usd;
  const el2 = $("#printHead");
  if (el2) el2.innerHTML = `<div class="ph-title">Wealth Report</div>
    <div class="ph-sub">${new Date().toLocaleString("en-GB", { day: "2-digit", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" })}
      &nbsp;·&nbsp; Total value <b>${money(totalValue)}</b> &nbsp;·&nbsp; ${VIEW.ccy}</div>`;
  window.print();
}

/* ============================ Boot ============================ */
function wireHeader() {
  $("#refreshBtn").onclick = refreshPrices;
  $("#addBtn").onclick = () => tradeModal();
  const addBtn3 = $("#addBtn3"); if (addBtn3) addBtn3.onclick = () => tradeModal();
  const csvBtn = $("#csvBtn"); if (csvBtn) csvBtn.onclick = exportCSV;
  const eb = $("#execBtn"); if (eb) eb.onclick = checkExecution;
  const pb = $("#printBtn"); if (pb) pb.onclick = printReport;
  const sb = $("#syncBtn"); if (sb) sb.onclick = async () => {
    if (!ghReady()) { toast("Set up GitHub backup in Settings first", true); return settingsModal(); }
    sb.disabled = true; const keep = sb.innerHTML; sb.innerHTML = "⟳ Syncing…";
    try { await ghRestore(); } finally { sb.disabled = false; sb.innerHTML = keep; }
  };
  $("#settingsBtn").onclick = settingsModal;
  $("#lockBtn").onclick = () => { sessionStorage.removeItem("unlocked"); location.reload(); };
  $$("#ccyToggle button").forEach(b => b.onclick = () => {
    VIEW.ccy = b.dataset.ccy; $$("#ccyToggle button").forEach(x => x.classList.toggle("active", x === b)); render();
  });
  // event delegation for table sorts + log actions
  document.addEventListener("click", e => {
    const th = e.target.closest("th[data-key]");
    if (th) {
      const s = th.dataset.table === "closed" ? VIEW.closedSort : VIEW.holdSort;
      if (s.key === th.dataset.key) s.dir *= -1; else { s.key = th.dataset.key; s.dir = -1; }
      render(); return;
    }
    const ed = e.target.closest("[data-edit]"); if (ed) return tradeModal(+ed.dataset.edit);
    const dl = e.target.closest("[data-del]"); if (dl) return deleteTrade(+dl.dataset.del);
    const cd = e.target.closest("[data-cashdel]"); if (cd) return deleteCash(+cd.dataset.cashdel);
    const idl = e.target.closest("[data-intdel]"); if (idl) return deleteInterest(+idl.dataset.intdel);
    const se = e.target.closest("[data-savedit]"); if (se) return savingsModal(+se.dataset.savedit);
    const sd = e.target.closest("[data-savdel]"); if (sd) return deleteSavings(+sd.dataset.savdel);
    const we = e.target.closest("[data-waledit]"); if (we) return walletModal(+we.dataset.waledit);
    const wd = e.target.closest("[data-waldel]"); if (wd) return deleteWallet(+wd.dataset.waldel);
  });
}

let booted = false;
function boot() {
  if (booted) return; booted = true;
  STATE = loadState() || defaultState();
  // migrate: ensure fields exist
  STATE.livePrices = STATE.livePrices || {};
  STATE.settings = STATE.settings || { finnhubKey: "" };
  STATE.settings.multipliers = STATE.settings.multipliers || {};
  STATE.manualPrices = STATE.manualPrices || {};
  STATE.cash = STATE.cash || [];
  STATE.assetMeta = STATE.assetMeta || {};
  STATE.interest = STATE.interest || [];
  STATE.savings = STATE.savings || [];
  STATE.wallets = STATE.wallets || [];
  STATE.liveWallets = STATE.liveWallets || {};
  STATE.execRefs = STATE.execRefs || {};
  saveLocal();   // migrations shouldn't trigger a backup on every load
  wireHeader();
  render();
  refreshPrices();   // fetch live on load
  // Fresh device with a saved token but no local data → pull the latest backup down.
  if (ghReady() && (!STATE.trades || !STATE.trades.length)) ghRestore();
  else if (ghReady()) checkForNewerBackup();
}

/* If the private repo holds a NEWER backup than we last synced, surface a one-click pull.
   (Previously the auto-restore only fired on an empty dataset, so repo-side updates went unseen.) */
async function checkForNewerBackup() {
  try {
    const c = ghCfg();
    const d = await ghApi("GET", `contents/data.json?ref=${encodeURIComponent(c.branch || "main")}`);
    const j = JSON.parse(b64dec(d.content));
    const remote = j.exported, seen = c.syncedExport;
    if (!remote || remote === seen) return;
    const el2 = el("div", "sync-banner");
    el2.id = "syncBanner";
    el2.innerHTML = `<span>☁️ A newer backup is available on GitHub
        <span class="muted">(${new Date(remote).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}
        · ${(j.trades || []).length} trades${(j.wallets || []).length ? `, ${(j.wallets).length} wallet(s)` : ""}${(j.savings || []).length ? `, ${(j.savings).length} savings` : ""})</span></span>
      <span style="display:flex;gap:8px"><button class="btn primary" id="syncPull">⬇ Pull latest</button>
      <button class="btn" id="syncDismiss">Later</button></span>`;
    const main = $(".wrap"); if (main) main.insertBefore(el2, main.firstChild);
    $("#syncPull", el2).onclick = async () => { $("#syncPull", el2).textContent = "Pulling…"; await ghRestore(); };
    $("#syncDismiss", el2).onclick = () => { const cc = ghCfg(); cc.syncedExport = remote; setGhCfg(cc); el2.remove(); };
  } catch (e) { /* offline or no access — stay quiet */ }
}

document.addEventListener("DOMContentLoaded", () => { initGate(); });
