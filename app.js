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
  "NOW": { cls: "stock", src: "finnhub", sym: "NOW" },
  "PYPL": { cls: "stock", src: "finnhub", sym: "PYPL" },
  "HOOD": { cls: "stock", src: "finnhub", sym: "HOOD" },
  "SOFI": { cls: "stock", src: "finnhub", sym: "SOFI" },
  "NVDA": { cls: "stock", src: "finnhub", sym: "NVDA" },
  "TSLA": { cls: "stock", src: "finnhub", sym: "TSLA" },
  "TMDX": { cls: "stock", src: "finnhub", sym: "TMDX" },
  "SBET": { cls: "stock", src: "finnhub", sym: "SBET" },
  "Zeta Global Holdings": { cls: "stock", src: "finnhub", sym: "ZETA" },
  "Corning": { cls: "stock", src: "finnhub", sym: "GLW" },
  "ENHA": { cls: "stock", src: "manual" },
  "FLOWDESK": { cls: "stock", src: "manual" },
  "Air Liquide": { cls: "stock", src: "manual" },
  "S&P 500 EUR (Acc)": { cls: "stock", src: "manual" },
  "MSCI Emerging Asia PEA ESG Leaders EUR (Acc)": { cls: "stock", src: "manual" },
};
function metaFor(asset) {
  return ASSET_META[asset] || { cls: "stock", src: "manual" };
}

const LS_KEY = "wealth_state_v1";
const EPS = 1e-6;

/* ============================ State ============================ */
let STATE = null;   // { trades, snapshots, manualPrices, livePrices, fxEURUSD, settings }
let VIEW = { ccy: "USD", holdSort: { key: "mv", dir: -1 }, closedSort: { key: "realized", dir: -1 } };

function defaultState() {
  const seed = window.__SEED__ || {};
  return {
    version: 1,
    trades: seed.trades ? structuredClone(seed.trades) : [],
    snapshots: seed.snapshots ? structuredClone(seed.snapshots) : [],
    manualPrices: seed.manualPrices ? { ...seed.manualPrices } : {},
    livePrices: {},                        // asset -> {price, changePct, prevClose, ts}
    fxEURUSD: seed.fxEURUSD || 1.10,
    settings: { finnhubKey: "" },
  };
}
function loadState() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) {}
  return null;
}
function saveState() {
  try { localStorage.setItem(LS_KEY, JSON.stringify(STATE)); } catch (e) {}
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
const initials = (name) => {
  const m = metaFor(name);
  if (m.sym) return m.sym.slice(0, 4);
  return name.replace(/[^A-Za-z0-9 ]/g, "").split(" ").map(w => w[0]).join("").slice(0, 4).toUpperCase() || name.slice(0, 3).toUpperCase();
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

  const open = [], closed = [];
  const totals = { mv: 0, cost: 0, upl: 0, realizedAll: 0, closedRealized: 0, day: 0 };
  const byClass = { stock: { mv: 0, cost: 0, upl: 0 }, crypto: { mv: 0, cost: 0, upl: 0 } };

  for (const a in byAsset) {
    const A = byAsset[a];
    const realized = A.sellProceeds - A.costConsumed;
    totals.realizedAll += realized;
    const openQty = A.lots.reduce((s, l) => s + l[0], 0);
    const openCost = A.lots.reduce((s, l) => s + l[0] * l[1], 0);
    const venues = [...A.venues].join(", ");

    if (openQty > EPS) {
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
    } else if (A.sellQty > EPS) {
      closed.push({ asset: a, cls: A.cls, qty: A.sellQty, avgBuy: A.costConsumed / A.sellQty,
        cost: A.costConsumed, avgSell: A.sellProceeds / A.sellQty, proceeds: A.sellProceeds,
        realized, ret: A.costConsumed ? realized / A.costConsumed : 0, venues });
      totals.closedRealized += realized;
    }
  }
  open.sort((a, b) => b.mv - a.mv);
  closed.sort((a, b) => b.realized - a.realized);
  return { open, closed, totals, byClass };
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
    map[a] = { price: lp.price, status: "live", changePct: lp.changePct, prevClose: lp.prevClose, ts: lp.ts };
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

async function refreshPrices() {
  const held = heldAssets();
  const btn = $("#refreshBtn"); if (btn) btn.disabled = true;
  setStatus("spin", "Fetching live prices…");
  const now = Date.now();
  let liveCount = 0, errors = [];

  // ---- Crypto: CoinGecko (batched, no key) ----
  const cryptoAssets = held.filter(a => metaFor(a).src === "coingecko");
  if (cryptoAssets.length) {
    const ids = [...new Set(cryptoAssets.map(a => metaFor(a).id))].join(",");
    try {
      const d = await fetchJSON(`https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true`);
      for (const a of cryptoAssets) {
        const row = d[metaFor(a).id];
        if (row && row.usd) {
          STATE.livePrices[a] = { price: row.usd, changePct: row.usd_24h_change, prevClose: null, ts: now };
          liveCount++;
        }
      }
    } catch (e) { errors.push("crypto"); }
  }

  // ---- FX: EUR→USD ----
  try {
    const fx = await fetchJSON("https://api.frankfurter.app/latest?from=EUR&to=USD");
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

  STATE.lastRefresh = now;
  saveState();
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
  renderKPIs(P);
  renderAllocation(P);
  renderSparkline();
  renderHoldings(P);
  renderClosed(P);
  renderLog();
  refreshStatusText();
}

function renderKPIs(P) {
  const t = P.totals;
  const cashDebt = latestCashDebt();
  const netWorth = t.mv + cashDebt.net;   // investments + (cash - debt) from latest snapshot
  const totalPL = t.upl + t.realizedAll;
  const box = $("#kpis");
  box.innerHTML = "";

  const card = (label, valHtml, subHtml, hero) => {
    const c = el("div", "kpi" + (hero ? " hero" : ""));
    c.innerHTML = `<div class="label">${label}</div><div class="val">${valHtml}</div>${subHtml ? `<div class="sub">${subHtml}</div>` : ""}`;
    box.appendChild(c);
  };

  const dayChip = t.day ? `<span class="chip ${cls(t.day)}">${t.day > 0 ? "▲" : "▼"} ${money(Math.abs(t.day))} today</span>` : "";
  card("Portfolio Value", money(t.mv),
    `${dayChip} <span class="muted">invested cost ${money(t.cost)}</span>`, true);

  card("Unrealized P&L", `<span class="${cls(t.upl)}">${money(t.upl, { sign: true })}</span>`,
    `<span class="chip ${cls(t.upl)}">${pct(t.cost ? t.upl / t.cost : 0)}</span>`);

  card("Realized P&L", `<span class="${cls(t.realizedAll)}">${money(t.realizedAll, { sign: true })}</span>`,
    `<span class="muted">${money(t.closedRealized, { sign: true })} from closed</span>`);

  card("Total P&L", `<span class="${cls(totalPL)}">${money(totalPL, { sign: true })}</span>`,
    `<span class="muted">unrealized + realized</span>`);

  const stk = P.byClass.stock, cry = P.byClass.crypto;
  card("Stocks & ETFs", money(stk.mv),
    `<span class="chip ${cls(stk.upl)}">${money(stk.upl, { sign: true })}</span>`);
  card("Crypto", money(cry.mv),
    `<span class="chip ${cls(cry.upl)}">${money(cry.upl, { sign: true })}</span>`);

  if (cashDebt.has) {
    card("Net Worth", money(netWorth),
      `<span class="muted">incl. cash ${money(cashDebt.cash)} · debt ${money(cashDebt.debt)}</span>`);
  }
}

function latestCashDebt() {
  const s = STATE.snapshots || [];
  if (!s.length) return { has: false, net: 0, cash: 0, debt: 0 };
  const last = [...s].sort((a, b) => a.date < b.date ? -1 : 1).at(-1);
  const cash = last.cash || 0, debt = last.debt || 0;
  return { has: (cash !== 0 || debt !== 0), net: cash + debt, cash, debt };  // debt already negative
}

function renderAllocation(P) {
  const stk = P.byClass.stock.mv, cry = P.byClass.crypto.mv, tot = stk + cry;
  const donut = $("#donut");
  if (!tot) { donut.innerHTML = `<div class="empty">No open positions yet.</div>`; return; }

  const r = 52, C = 2 * Math.PI * r, sw = 18;
  const segs = [
    { nm: "Stocks & ETFs", v: stk, color: "var(--stock)" },
    { nm: "Crypto", v: cry, color: "var(--crypto)" },
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
        <div class="center"><div><div class="big">${money(tot)}</div><div class="small">Invested</div></div></div>
      </div>
      <div class="legend">${legend}</div>
    </div>`;

  // per-asset allocation bars (top positions)
  const bars = $("#allocBars");
  const top = [...P.open].sort((a, b) => b.mv - a.mv).slice(0, 8);
  bars.innerHTML = top.map(o => {
    const color = o.cls === "crypto" ? "var(--crypto)" : "var(--stock)";
    return `<div class="alloc-bar">
      <div class="top"><span>${o.asset}</span><span class="muted">${money(o.mv)} · ${(o.mv / tot * 100).toFixed(1)}%</span></div>
      <div class="track"><div class="fill" style="width:${(o.mv / tot * 100).toFixed(1)}%;background:${color}"></div></div>
    </div>`;
  }).join("");
}

function renderSparkline() {
  const wrap = $("#sparkPanel");
  const snaps = [...(STATE.snapshots || [])].filter(s => s.navUSD != null).sort((a, b) => a.date < b.date ? -1 : 1);
  if (snaps.length < 2) { wrap.classList.add("hidden"); return; }
  wrap.classList.remove("hidden");
  const vals = snaps.map(s => s.navUSD);
  const min = Math.min(...vals), max = Math.max(...vals), pad = (max - min) * 0.12 || 1;
  const W = 640, H = 120, lo = min - pad, hi = max + pad;
  const x = i => (i / (snaps.length - 1)) * W;
  const y = v => H - ((v - lo) / (hi - lo)) * H;
  const pts = snaps.map((s, i) => `${x(i).toFixed(1)},${y(s.navUSD).toFixed(1)}`).join(" ");
  const area = `0,${H} ${pts} ${W},${H}`;
  const first = snaps[0].navUSD, last = snaps.at(-1).navUSD, delta = last - first;
  const up = delta >= 0;
  $("#sparkMeta").innerHTML = `
    <div><div class="label muted" style="font-size:.72rem;text-transform:uppercase;letter-spacing:.05em">Net worth (snapshots)</div>
    <div style="font-size:1.5rem;font-weight:700;letter-spacing:-.02em">${money(last)}</div></div>
    <div style="text-align:right"><span class="chip ${up ? "pos" : "neg"}">${up ? "▲" : "▼"} ${money(Math.abs(delta), { sign: false })}</span>
    <div class="muted" style="font-size:.72rem;margin-top:4px">${snaps[0].date} → ${snaps.at(-1).date}</div></div>`;
  $("#sparkSvg").innerHTML = `
    <svg width="100%" height="${H}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
      <defs><linearGradient id="sg" x1="0" x2="0" y1="0" y2="1">
        <stop offset="0" stop-color="${up ? "var(--pos)" : "var(--neg)"}" stop-opacity="0.35"/>
        <stop offset="1" stop-color="${up ? "var(--pos)" : "var(--neg)"}" stop-opacity="0"/>
      </linearGradient></defs>
      <polygon points="${area}" fill="url(#sg)"></polygon>
      <polyline points="${pts}" fill="none" stroke="${up ? "var(--pos)" : "var(--neg)"}" stroke-width="2.5"
        stroke-linejoin="round" stroke-linecap="round"></polyline>
    </svg>`;
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

function assetCell(o) {
  const badgeCls = o.cls === "crypto" ? "crypto" : "stock";
  return `<div class="asset-cell">
    <div class="asset-badge ${badgeCls}">${initials(o.asset)}</div>
    <div class="asset-name"><span class="nm">${o.asset}</span><span class="vn">${o.venues}</span></div>
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
    { key: "mv", label: "Value" },
    { key: "upl", label: "Unreal. P&L" },
    { key: "ret", label: "Return" },
  ];
  cont.innerHTML = "";
  for (const g of groups) {
    if (!g.rows.length) continue;
    const sub = g.rows.reduce((s, o) => ({ mv: s.mv + o.mv, cost: s.cost + o.cost, upl: s.upl + o.upl }), { mv: 0, cost: 0, upl: 0 });
    const rows = sortRows(g.rows, VIEW.holdSort).map(o => {
      const pdot = o.status === "live" ? "live" : "manual";
      return `<tr>
        <td>${assetCell(o)}</td>
        <td class="num">${fmtQty(o.qty)}</td>
        <td class="num muted">${fmtPrice(o.avg)}</td>
        <td class="num"><span class="price-tag"><span class="pdot ${pdot}"></span>${fmtPrice(o.price)}</span></td>
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
  if (!P.closed.length) { body.innerHTML = `<tr><td colspan="8" class="empty">No fully-closed positions yet.</td></tr>`; $("#closedFoot").innerHTML = ""; return; }
  body.innerHTML = sortRows(P.closed, VIEW.closedSort).map(c => `
    <tr>
      <td>${assetCell(c)}</td>
      <td class="num">${fmtQty(c.qty)}</td>
      <td class="num muted">${fmtPrice(c.avgBuy)}</td>
      <td class="num muted">${fmtPrice(c.avgSell)}</td>
      <td class="num">${money(c.cost)}</td>
      <td class="num">${money(c.proceeds)}</td>
      <td class="num ${cls(c.realized)}">${money(c.realized, { sign: true })}</td>
      <td class="num ${cls(c.ret)}">${pct(c.ret)}</td>
    </tr>`).join("");
  const tc = P.closed.reduce((s, c) => ({ cost: s.cost + c.cost, proc: s.proc + c.proceeds, r: s.r + c.realized }), { cost: 0, proc: 0, r: 0 });
  $("#closedFoot").innerHTML = `<tr><td>Total</td><td></td><td></td><td></td>
    <td class="num">${money(tc.cost)}</td><td class="num">${money(tc.proc)}</td>
    <td class="num ${cls(tc.r)}">${money(tc.r, { sign: true })}</td>
    <td class="num ${cls(tc.cost ? tc.r / tc.cost : 0)}">${pct(tc.cost ? tc.r / tc.cost : 0)}</td></tr>`;
}

function renderLog() {
  const body = $("#logBody");
  const rows = STATE.trades.map((t, i) => ({ t, i }))
    .sort((a, b) => a.t.date < b.t.date ? 1 : a.t.date > b.t.date ? -1 : b.i - a.i);
  $("#logCount").textContent = STATE.trades.length;
  if (!rows.length) { body.innerHTML = `<tr><td colspan="8" class="empty">No trades yet.</td></tr>`; return; }
  body.innerHTML = rows.map(({ t, i }) => {
    const buy = String(t.side).toLowerCase() === "buy";
    return `<tr>
      <td>${t.date}</td>
      <td style="text-align:left">${t.asset}</td>
      <td style="text-align:left"><span class="badge-side ${buy ? "buy" : "sell"}">${t.side}</span></td>
      <td style="text-align:left" class="muted">${t.venue}</td>
      <td class="num">${fmtQty(Math.abs(t.qty))}</td>
      <td class="num">${t.price.toLocaleString("en-US", { maximumFractionDigits: 4 })} ${t.ccy}</td>
      <td class="num">$${Math.abs(t.totalUSD).toLocaleString("en-US", { maximumFractionDigits: 2 })}</td>
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
      <div class="field"><label>Currency</label><select id="f_ccy"><option${t.ccy === "USD" ? " selected" : ""}>USD</option><option${t.ccy === "EUR" ? " selected" : ""}>EUR</option></select></div>
      <div class="field"><label>Quantity</label><input id="f_qty" type="number" step="any" value="${t.qty}" placeholder="0.00"></div>
      <div class="field"><label>Price (per unit)</label><input id="f_price" type="number" step="any" value="${t.price}" placeholder="0.00"></div>
      <div class="field"><label>Fee</label><input id="f_fee" type="number" step="any" value="${t.fee || 0}"></div>
      <div class="field"><label>FX (EUR→USD)</label><input id="f_fx" type="number" step="any" value="${FX().toFixed(4)}">
        <div class="hint">Used only for EUR trades → stored USD cost</div></div>
      <div class="computed full"><span class="muted">Total cost (USD, incl. fee)</span><span id="f_total" class="num">—</span></div>
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
  // auto-set type from known asset
  $("#f_asset", m).onchange = () => { const a = $("#f_asset", m).value.trim(); if (ASSET_META[a]) $("#f_type", m).value = metaFor(a).cls === "crypto" ? "Crypto" : "Stock"; };
  calc();

  $("#f_save", m).onclick = () => {
    const asset = $("#f_asset", m).value.trim();
    const qty = Math.abs(parseFloat($("#f_qty", m).value));
    const price = parseFloat($("#f_price", m).value);
    if (!asset || !qty || isNaN(price)) { toast("Fill asset, quantity and price", true); return; }
    const totalUSD = Math.abs(calc());
    const side = $("#f_side", m).value;
    const rec = {
      date: $("#f_date", m).value, asset, type: $("#f_type", m).value,
      venue: $("#f_venue", m).value.trim() || "—", side,
      qty, price, fee: parseFloat($("#f_fee", m).value) || 0,
      totalUSD: side === "Sell" ? -totalUSD : totalUSD, ccy: $("#f_ccy", m).value,
    };
    if (editIdx != null) STATE.trades[editIdx] = rec; else STATE.trades.push(rec);
    saveState(); render(); close();
    toast(editIdx != null ? "Trade updated" : "Trade added");
  };
}

function deleteTrade(i) {
  const t = STATE.trades[i];
  if (!confirm(`Delete this trade?\n\n${t.date} · ${t.side} ${fmtQty(Math.abs(t.qty))} ${t.asset} @ ${t.price}`)) return;
  STATE.trades.splice(i, 1); saveState(); render(); toast("Trade deleted");
}

/* ============================ Settings / prices / data ============================ */
function settingsModal() {
  const manualAssets = heldAssets().filter(a => metaFor(a).src === "manual");
  const m = el("div", "modal");
  m.innerHTML = `
    <h3>Settings <button class="x">&times;</button></h3>
    <div class="settings-row">
      <div class="info"><div class="t">Finnhub API key (stocks)</div>
        <div class="d">Free key at finnhub.io. Enables live US stock prices. Crypto already works without a key. Stored only in this browser.</div></div>
    </div>
    <div class="field full"><input id="s_key" value="${STATE.settings.finnhubKey || ""}" placeholder="Paste Finnhub key…"></div>

    ${manualAssets.length ? `<div class="settings-row"><div class="info"><div class="t" style="margin-top:14px">Manual prices</div>
      <div class="d">Assets without an automatic feed (e.g. private equity). Set the current price per unit (USD).</div></div></div>
      ${manualAssets.map(a => `<div class="field full" style="display:flex;gap:10px;align-items:center">
        <label style="flex:1;margin:0;text-transform:none;font-size:.85rem;color:var(--text)">${a}</label>
        <input data-mp="${a.replace(/"/g, "&quot;")}" type="number" step="any" style="width:150px" value="${STATE.manualPrices[a] ?? ""}">
      </div>`).join("")}` : ""}

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

  $("#s_save", m).onclick = () => {
    STATE.settings.finnhubKey = $("#s_key", m).value.trim();
    $$("[data-mp]", m).forEach(inp => {
      const a = inp.getAttribute("data-mp"); const v = parseFloat(inp.value);
      if (!isNaN(v)) STATE.manualPrices[a] = v;
    });
    saveState(); render(); close(); toast("Settings saved");
    if (STATE.settings.finnhubKey) refreshPrices();
  };
  $("#s_export", m).onclick = exportData;
  $("#s_import", m).onclick = () => $("#s_file", m).click();
  $("#s_file", m).onchange = e => importData(e.target.files[0], close);
  $("#s_reset", m).onclick = () => { if (confirm("Reset all data back to the original seed? This clears your local changes.")) { STATE = defaultState(); saveState(); render(); close(); toast("Reset to seed"); } };
  $("#s_change", m).onclick = () => { close(); changePasscodeModal(); };
}

function exportData() {
  const data = { version: 1, exported: new Date().toISOString(), trades: STATE.trades,
    snapshots: STATE.snapshots, manualPrices: STATE.manualPrices, fxEURUSD: STATE.fxEURUSD };
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
      if (d.manualPrices) STATE.manualPrices = d.manualPrices;
      if (d.fxEURUSD) STATE.fxEURUSD = d.fxEURUSD;
      saveState(); render(); if (done) done(); toast(`Imported ${d.trades.length} trades`);
    } catch (e) { toast("Import failed: " + e.message, true); }
  };
  r.readAsText(file);
}

/* ============================ Passcode gate ============================ */
async function initGate() {
  const gate = $("#gate"), app = $("#app");
  const hash = localStorage.getItem("gateHash");
  if (sessionStorage.getItem("unlocked") === "1") { gate.classList.add("hidden"); app.classList.remove("hidden"); boot(); return true; }

  const title = $("#gateTitle"), sub = $("#gateSub"), inp = $("#gateInput"), err = $("#gateErr"), btn = $("#gateBtn");
  const setup = !hash;
  title.textContent = setup ? "Set a passcode" : "Enter passcode";
  sub.textContent = setup ? "Protects this dashboard on this device." : "Welcome back.";
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

/* ============================ Boot ============================ */
function wireHeader() {
  $("#refreshBtn").onclick = refreshPrices;
  $("#addBtn").onclick = () => tradeModal();
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
  });
}

let booted = false;
function boot() {
  if (booted) return; booted = true;
  STATE = loadState() || defaultState();
  // migrate: ensure fields exist
  STATE.livePrices = STATE.livePrices || {};
  STATE.settings = STATE.settings || { finnhubKey: "" };
  STATE.manualPrices = STATE.manualPrices || {};
  saveState();
  wireHeader();
  render();
  refreshPrices();   // fetch live on load
}

document.addEventListener("DOMContentLoaded", () => { initGate(); });
