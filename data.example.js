// Example seed format. Copy to `data.js` and fill with your own trades.
// `data.js` is gitignored so your real data is never pushed to GitHub.
// This only bootstraps the app on first load; afterwards your browser's
// localStorage is the source of truth (edit trades in the UI).
window.__SEED__ = {
  "version": 1,
  "baseCurrency": "USD",
  "fxEURUSD": 1.10,                 // fallback EUR→USD (refreshed live at runtime)
  "trades": [
    // One object per buy/sell. `totalUSD` = signed USD cash flow incl. fees
    // (positive for Buy, negative for Sell). For EUR trades it's the USD value.
    { "date": "2025-04-29", "asset": "COIN", "type": "Stock", "venue": "Revolut",
      "side": "Buy", "qty": 0.485499, "price": 203.63, "fee": 0,
      "totalUSD": 98.86, "ccy": "USD" },
    { "date": "2026-05-29", "asset": "BTC", "type": "Crypto", "venue": "Nexo",
      "side": "Buy", "qty": 0.187254, "price": 107850, "fee": 0,
      "totalUSD": 20195.38, "ccy": "USD" }
  ],
  "snapshots": [
    // Optional net-worth history for the sparkline. `debt` is negative.
    { "date": "2025-09-29", "navUSD": 78964, "cash": 0, "stocks": 11556,
      "crypto": 67408, "debt": 0 }
  ],
  "manualPrices": {
    // Current price (USD) for assets with no live feed (e.g. private equity),
    // and a fallback for everything else.
    "FLOWDESK": 18.455445,
    "BTC": 59565.5
  }
};
