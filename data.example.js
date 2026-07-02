// Example seed format (FAKE data — safe to be public).
// Copy to `data.js` and fill with your own trades for a first-run seed.
// `data.js` is gitignored so your real data is never pushed here.
// This only bootstraps the app on first load; afterwards your browser's
// localStorage is the source of truth, and your real data is backed up to
// your PRIVATE data repo (see Settings -> Backup to private GitHub).
window.__SEED__ = {
  "version": 1,
  "baseCurrency": "USD",
  "fxEURUSD": 1.10,                 // fallback EUR->USD (refreshed live at runtime)
  "trades": [
    // One object per buy/sell. `totalUSD` = signed USD cash flow incl. fees
    // (positive for Buy, negative for Sell). For EUR trades it's the USD value.
    { "date": "2025-01-02", "asset": "AAPL", "type": "Stock", "venue": "ExampleBroker",
      "side": "Buy", "qty": 1, "price": 100, "fee": 0,
      "totalUSD": 100, "ccy": "USD" },
    { "date": "2025-02-01", "asset": "BTC", "type": "Crypto", "venue": "ExampleExchange",
      "side": "Buy", "qty": 0.01, "price": 50000, "fee": 0,
      "totalUSD": 500, "ccy": "USD" }
  ],
  "snapshots": [
    // Optional net-worth history for the sparkline. `debt` is negative.
    { "date": "2025-01-01", "navUSD": 1000, "cash": 400, "stocks": 100,
      "crypto": 500, "debt": 0 }
  ],
  "manualPrices": {
    // Current price (USD) for assets with no live feed (e.g. private equity).
    "AAPL": 110,
    "BTC": 52000
  }
};
