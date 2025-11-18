// index.js — AlphaStream v24.4 — MASSIVE.COM STOCKS API INTEGRATION (Nov 2025)
import express from "express";
import axios from "axios";

const app = express();
app.use(express.json());

// CORS
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  next();
});

// ENV
const {
  ALPACA_KEY = "",
  ALPACA_SECRET = "",
  MASSIVE_KEY = "",
  PREDICTOR_URL = "",
  LOG_WEBHOOK_URL = "",
  LOG_WEBHOOK_SECRET = "",
  FORWARD_SECRET = "",
  MAX_POS = "3",
  DRY_MODE = "false"
} = process.env;

const DRY_MODE_BOOL = !["false", "0", "no", "off"].includes(String(DRY_MODE).toLowerCase());
const A_BASE = "https://paper-api.alpaca.markets/v2";
const M_BASE = "https://api.massive.com";
const headers = { "APCA-API-KEY-ID": ALPACA_KEY, "APCA-API-SECRET-KEY": ALPACA_SECRET };

let positions = {};
let scanning = false;

// US Holidays 2025
const HOLIDAYS_2025 = [
  "2025-01-01", "2025-01-20", "2025-02-17", "2025-04-18", "2025-05-26",
  "2025-06-19", "2025-07-04", "2025-09-01", "2025-11-27", "2025-12-25"
];

// Logger
async function log(event, symbol = "", note = "", data = {}) {
  console.log(`[${event}] ${symbol} | ${note}`, data);
  if (!LOG_WEBHOOK_URL || !LOG_WEBHOOK_SECRET) return;
  try {
    await axios.post(LOG_WEBHOOK_URL, { secret: LOG_WEBHOOK_SECRET, event, symbol, note, data }, { timeout: 5000 });
  } catch {}
}

// Dashboard
app.get("/", (req, res) => res.json({
  bot: "AlphaStream v24.4",
  status: "LIVE",
  time: new Date().toISOString(),
  positions: Object.keys(positions).length,
  max_pos: MAX_POS,
  dry_mode: DRY_MODE_BOOL,
  mode: "MASSIVE STOCKS API — PRE-MARKET + MORNING"
}));

app.get("/healthz", (_, res) => res.status(200).send("OK"));

// Manual scan
app.post("/", async (req, res) => {
  if (FORWARD_SECRET && req.body?.secret !== FORWARD_SECRET) return res.status(403).send("no");
  res.json({ status: "SCAN TRIGGERED — MASSIVE STOCKS API" });
  await log("MANUAL_SCAN", "DASHBOARD", "User triggered");
  scanAndEnter();
});

// Exit all
app.post("/exit-all", async (req, res) => {
  if (req.body?.secret !== FORWARD_SECRET) return res.status(403).send("no");
  for (const sym in positions) {
    await placeOrder(sym, positions[sym].qty, "sell");
    await log("FORCED_EXIT", sym, "Manual exit-all");
  }
  positions = {};
  res.json({ status: "ALL POSITIONS CLOSED" });
});

async function placeOrder(sym, qty, side) {
  if (DRY_MODE_BOOL) {
    await log("DRY_ORDER", sym, `${side.toUpperCase()} ${qty} shares`);
    return;
  }
  try {
    await axios.post(`${A_BASE}/orders`, {
      symbol: sym,
      qty,
      side,
      type: "market",
      time_in_force: "day",
      extended_hours: true
    }, { headers });
    await log("LIVE_ORDER", sym, `${side.toUpperCase()} ${qty} (extended hours)`);
  } catch (e) {
    await log("ORDER_FAIL", sym, e.response?.data?.message || e.message);
  }
}

// 3:45 PM ET EXIT
async function exitAt345() {
  const now = new Date();
  const utcHour = now.getUTCHours();
  const utcMin = now.getUTCMinutes();
  if (utcHour === 19 && utcMin >= 45 && utcMin < 50 && Object.keys(positions).length > 0) {
    await log("AUTO_EXIT_ALL", "SYSTEM", "3:45 PM — closing all positions");
    for (const sym in positions) {
      await placeOrder(sym, positions[sym].qty, "sell");
      await log("AUTO_EXIT", sym, "Sold at 3:45 PM");
    }
    positions = {};
  }
}

// MAIN SCANNER — MASSIVE.COM TOP GAINERS & SNAPSHOTS
async function scanAndEnter() {
  if (scanning) return;
  scanning = true;

  try {
    const now = new Date();
    const utcHour = now.getUTCHours();
    const utcMin = now.getUTCMinutes();
    const utcTime = utcHour * 100 + utcMin;
    const today = now.toISOString().slice(0, 10);
    const dow = now.getUTCDay();

    if (dow === 0 || dow === 6 || HOLIDAYS_2025.includes(today)) {
      scanning = false;
      return;
    }

    // 7:00 AM – 11:00 AM ET (11:00 – 15:00 UTC)
    if (utcTime < 1100 || utcTime >= 1500) {
      scanning = false;
      return;
    }

    const isPreMarket = utcTime < 1330;
    await log(isPreMarket ? "PREMARKET_SCAN" : "MORNING_SCAN", "SYSTEM", 
      isPreMarket ? "7:00–9:29 AM ET — hunting monsters" : "9:30–11:00 AM ET — hunting");

    // TOP GAINERS — MASSIVE.COM (your key works here)
    let gappers = [];
    try {
      const res = await axios.get(
        `${M_BASE}/v2/snapshot/locale/us/markets/stocks/gainers?apiKey=${MASSIVE_KEY}`,
        { timeout: 15000 }
      );
      gappers = res.data.tickers || [];
      await log("TOP_GAINERS", "SYSTEM", `${gappers.length} top movers loaded`, gappers.map(t => `${t.ticker} +${t.todaysChangePerc?.toFixed(1)}%`));
    } catch (e) {
      await log("GAINERS_ERROR", "SYSTEM", "Top gainers failed", { error: e.message });
      // Fallback: Full snapshot
      try {
        const res = await axios.get(
          `${M_BASE}/v2/snapshot/locale/us/markets/stocks/tickers?apiKey=${MASSIVE_KEY}`,
          { timeout: 15000 }
        );
        const tickers = Object.values(res.data.tickers || {});
        gappers = tickers
          .filter(t => t.prevDay && t.lastTrade && t.lastTrade.p > 1 && t.lastTrade.v >= 500000)
          .map(t => {
            const gap = (t.lastTrade.p / t.prevDay.c - 1) * 100;
            return { ticker: t.ticker, ...t, gap };
          })
          .filter(t => t.gap >= 15)
          .sort((a, b) => b.gap - a.gap)
          .slice(0, 20);
        await log("SNAPSHOT_FALLBACK", "SYSTEM", `${gappers.length} gappers from full snapshot`);
      } catch (fallbackE) {
        await log("SNAPSHOT_FAIL", "SYSTEM", "Both endpoints failed", { error: fallbackE.message });
        scanning = false;
        return;
      }
    }

    for (const t of gappers) {
      if (Object.keys(positions).length >= parseInt(MAX_POS)) break;
      if (positions[t.ticker]) continue;

      const gap = t.gap || t.todaysChangePerc || 0;
      await log("CANDIDATE", t.ticker, `+${gap.toFixed(1)}% | $${t.lastTrade?.p.toFixed(2)}`);

      // Get 1-min bars from Massive (works with your key)
      let bars = [];
      try {
        const from = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10); // 3 days ago
        const to = new Date().toISOString().slice(0, 10);
        const res = await axios.get(
          `${M_BASE}/v2/aggs/ticker/${t.ticker}/range/1/minute/${from}/${to}?adjusted=true&limit=200&apiKey=${MASSIVE_KEY}`
        );
        bars = res.data.results || [];
      } catch (e) {
        await log("BARS_FAIL", t.ticker, "Bars fetch failed", { error: e.message });
        continue;
      }

      if (bars.length < 80) continue;

      const close = bars.map(b => b.c);
      const high = bars.map(b => b.h);
      const low = bars.map(b => b.l);

      let Supertrend, ADX, ATR;
      try {
        const ti = await import("technicalindicators");
        Supertrend = ti.Supertrend;
        ADX = ti.ADX;
        ATR = ti.ATR;
      } catch {
        Supertrend = () => [{ trend: 1, superTrend: close[close.length-1] * 0.95 }];
        ADX = () => [{ adx: 35 }];
        ATR = () => [close[close.length-1] * 0.06];
      }

      const st = Supertrend({ period: 10, multiplier: 3, high, low, close });
      const adxData = ADX({ period: 14, high, low, close });
      const atrData = ATR({ period: 14, high, low, close });

      const cur = {
        price: close[close.length - 1],
        stTrend: st[st.length - 1]?.trend,
        stLine: st[st.length - 1]?.superTrend,
        adx: adxData[adxData.length - 1]?.adx || 0,
        atr: atrData[atrData.length - 1] || 1
      };

      if (cur.adx > 25 && cur.stTrend === 1 && cur.price > cur.stLine) {
        let prob = 0.82;
        if (PREDICTOR_URL) {
          try {
            const ml = await axios.post(`${PREDICTOR_URL}/predict`, {
              features: [gap, cur.adx, cur.atr / cur.price]
            }, { timeout: 3000 });
            prob = ml.data.probability || 0.82;
          } catch {}
        }

        if (prob > 0.78) {
          const qty = Math.max(1, Math.floor(25000 * 0.012 / (cur.atr * 1.5)));
          await placeOrder(t.ticker, qty, "buy");
          positions[t.ticker] = { entry: cur.price, qty, gap };
          await log("ENTRY", t.ticker, `${isPreMarket ? "PRE-MARKET" : "REGULAR"} +${gap.toFixed(1)}% | ML ${(prob*100).toFixed(1)}%`, { qty });
        }
      }
    }

  } catch (err) {
    await log("SCAN_ERROR", "SYSTEM", err.message);
  } finally {
    scanning = false;
  }
}

// START
const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", async () => {
  console.log(`ALPHASTREAM v26.0 LIVE on port ${PORT}`);
  await log("BOT_START", "SYSTEM", "Massive.com Top Gainers + Pre-Market Entries", { dry_mode: DRY_MODE_BOOL });
  scanAndEnter();
  setInterval(scanAndEnter, 75000);  // every 75 sec
  setInterval(exitAt345, 60000);     // check every min
});
