# 💎 Wealth Dashboard

A private, single-page portfolio tracker. Log your trades, and it computes live
P&L using a FIFO cost-basis engine — separating **stocks** and **crypto**, with
open holdings, closed (realized) positions, allocation charts and a net-worth
history. No backend, no build step; it's pure HTML/CSS/JS.

- **Live prices**: crypto via **CoinGecko** (no key needed), US stocks via
  **Finnhub** (free key), EUR/USD via **Frankfurter**.
- **Your data stays in your browser** (`localStorage`). Nothing is sent anywhere
  except read-only price requests to the APIs above.
- **FIFO engine** validated against the source spreadsheet — open-position
  quantities match exactly (cost basis includes trading fees).

---

## Files

| File | Purpose | Committed to git? |
|------|---------|-------------------|
| `index.html`, `styles.css`, `app.js` | the app | ✅ yes |
| `data.js` | **your** seed trades/snapshots (first-run bootstrap) | ❌ **gitignored** |
| `my-data.json` | same data as a portable JSON backup | ❌ **gitignored** |
| `data.example.js` | shows the seed format | ✅ yes |

`data.js` and `my-data.json` are in `.gitignore`, so **your real trades are never
pushed to GitHub.** The app works fully on your own machine (they bootstrap the
dashboard); on a public deploy they simply won't exist and you load your data via
**Settings → Import JSON** instead.

---

## Run locally

Because the app loads `data.js` and fetches prices, open it via a tiny local
server (double-clicking the file also works, but a server is cleaner):

```bash
cd wealth-dashboard
python3 -m http.server 8000
# open http://localhost:8000
```

First launch asks you to **set a passcode** (stored only in this browser). Crypto
prices load immediately; add a Finnhub key for live stocks (below).

---

## Live stock prices (Finnhub — free)

Crypto works with zero setup. For live **stock** prices:

1. Get a free key at <https://finnhub.io> (30 seconds, no card).
2. In the app: **⚙ Settings → Finnhub API key → paste → Save**.

The key is stored only in your browser's `localStorage` (never committed). Free
tier covers US-listed stocks in real time — which is every open stock position
here (COIN, GLXY, GRAB, NBIS, AVGO, NOW, PYPL…). Private/illiquid assets like
**FLOWDESK** have no feed — set their price manually in Settings.

---

## Deploy to GitHub Pages

```bash
cd wealth-dashboard
git init
git add .                      # data.js / my-data.json are gitignored
git commit -m "Wealth dashboard"
git branch -M main
git remote add origin git@github.com:<you>/wealth-dashboard.git
git push -u origin main
```

Then on GitHub: **Settings → Pages → Build from branch → `main` / root**. Your
site goes live at `https://<you>.github.io/wealth-dashboard/`. On that public URL
the app starts empty (no data.js) — unlock, then **Settings → Import JSON** and
pick your `my-data.json`. From then on it's saved in that browser.

### ⚠️ About "only I have access"

GitHub Pages **always serves the site publicly** (even from a private repo), and
the passcode here is a **client-side lock only** — a deterrent, not real
security. The genuine privacy guarantee in this setup is that **your data is never
in the repo** (gitignored) — a stranger hitting the URL sees an empty, locked app.

For real authentication (a login wall in front of the whole site), deploy to one
of these instead of GitHub Pages — same files, drag-and-drop:

- **Cloudflare Pages + Cloudflare Access** — free, gate by your email/Google.
- **Netlify** — password-protect the site (paid) or use Netlify Identity.
- **Vercel** — password protection / auth on the project.

---

## How it works

- **Trade log** → one row per buy/sell. Each trade stores a USD `totalUSD`
  (cost/proceeds incl. fees); EUR trades are converted at the FX you enter.
- **FIFO engine** (`computePortfolio` in `app.js`) walks trades oldest→newest,
  matching sells against the earliest buy lots to compute realized P&L and the
  remaining cost basis of open lots.
- **Open positions** → market value = remaining qty × live price; unrealized
  P&L = value − remaining cost.
- **Closed positions** → assets whose net quantity is ~0; shows realized P&L.
- **Realized P&L (KPI)** = *all* sells, including partial sells on still-open
  names (e.g. Nebius round-trips). The Closed-positions table only lists fully
  exited assets — that's the difference you'll see between the two numbers.
- Base currency is **USD**; the EUR toggle converts at the live rate.

## Backups

**⚙ Settings → Export JSON** downloads everything. Keep it safe / re-import on a
new device. **Reset to seed** restores the originally-loaded data.

Passcode reset: clear this site's data in your browser (DevTools → Application →
Local Storage). Export first — clearing also wipes your trades.
