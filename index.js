// index.js — AlphaStream v24.5 — PENNY STOCKS ONLY ($1–$20, No Blue Chips)
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
  MASSIVE_KEY = "uJq_QdVgvrlry9ZpvkIKcs6s2q2qGKtZ",  // Your key
  PREDICTOR_URL = "",
  LOG_WEBHOOK_URL = "",
  LOG_WEBHOOK_SECRET = "",
  FORWARD_SECRET = "",
  MAX_POS = "3",
  DRY_MODE = "false"
} = process.env;

const DRY_MODE_BOOL = !["false", "0", "no", "off"].includes(String(DRY_MODE).toLowerCase());
const A_BASE = "https://paper-api.alpaca.markets/v2";
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
  bot: "AlphaStream v24.5 PENNY MONSTER",
  status: "LIVE",
  time: new Date().toISOString(),
  positions: Object.keys(positions).length,
  max_pos: MAX_POS,
  dry_mode: DRY_MODE_BOOL
}));

app.get("/healthz", (_, res) => res.status(200).send("OK"));

// Manual scan
app.post("/", async (req, res) => {
  if (FORWARD_SECRET && req.body?.secret !== FORWARD_SECRET) return res.status(403).send("no");
  res.json({ status: "PENNY SCAN TRIGGERED — $1–$20 ONLY" });
  await log("MANUAL_SCAN", "DASHBOARD", "User triggered");
  scanPennyStocks();
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
    await log("LIVE_ORDER", sym, `${side.toUpperCase()} ${qty} (penny stock)`);
  } catch (e) {
    await log("ORDER_FAIL", sym, e.response?.data?.message || e.message);
  }
}

// 3:45 PM ET AUTO EXIT
async function exitAt345() {
  const now = new Date();
  const utcHour = now.getUTCHours();
  const utcMin = now.getUTCMinutes();
  if (utcHour === 19 && utcMin >= 45 && utcMin < 50 && Object.keys(positions).length > 0) {
    await log("AUTO_EXIT_ALL", "SYSTEM", "3:45 PM — closing all penny positions");
    for (const sym in positions) {
      await placeOrder(sym, positions[sym].qty, "sell");
      await log("AUTO_EXIT", sym, "Sold at 3:45 PM");
    }
    positions = {};
  }
}

// PENNY STOCKS SCANNER — $1–$20 ONLY, NO BLUE CHIPS
async function scanPennyStocks() {
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
    await log(isPreMarket ? "PREMARKET_PENNY" : "MORNING_PENNY", "SYSTEM", 
      isPreMarket ? "7:00–9:29 AM ET — hunting penny monsters" : "9:30–11:00 AM ET — hunting pennies");

    // FULL SNAPSHOT — FILTER TO PENNY STOCKS ($1–$20, high gap/volume)
    let snapshot;
    try {
      const res = await axios.get(
        `${M_BASE}/v2/snapshot/locale/us/markets/stocks/tickers?apiKey=${MASSIVE_KEY}`,
        { timeout: 15000 }
      );
      snapshot = res.data;
    } catch (e) {
      await log("SNAPSHOT_ERROR", "SYSTEM", "Snapshot failed", { error: e.message });
      scanning = false;
      return;
    }

    const tickers = Object.values(snapshot.tickers || {});
    const pennyGappers = tickers
      .filter(t => t.prevDay && t.lastTrade && t.lastTrade.p >= 1 && t.lastTrade.p <= 20) // $1–$20
      .filter(t => t.lastTrade.v >= 500000) // 500K+ volume
      .map(t => {
        const gap = (t.lastTrade.p / t.prevDay.c - 1) * 100;
        return { ...t, gap };
      })
      .filter(t => t.gap >= 15) // 15%+ gap
      .sort((a, b) => b.gap - a.gap)
      .slice(0, 20); // top 20 penny monsters

    await log("PENNY_MONSTERS", "SYSTEM", `${pennyGappers.length} penny rockets $1–$20`, 
      pennyGappers.map(t => `${t.ticker} +${t.gap.toFixed(1)}% | $${t.lastTrade.p.toFixed(2)}`));

    for (const t of pennyGappers) {
      if (Object.keys(positions).length >= parseInt(MAX_POS)) break;
      if (positions[t.ticker]) continue;

      const gap = t.gap;
      await log("PENNY_CANDIDATE", t.ticker, `+${gap.toFixed(1)}% | $${t.lastTrade.p.toFixed(2)} | Vol ${(t.lastTrade.v/1000).toFixed(0)}K`);

      // Get 1-min bars
      let bars = [];
      try {
        const from = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10); // 3 days
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
          await log("PENNY_ENTRY", t.ticker, `+${gap.toFixed(1)}% | ML ${(prob*100).toFixed(1)}%`, { qty });
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
  console.log(`ALPHASTREAM v24.5 PENNY MONSTER LIVE on port ${PORT}`);
  await log("BOT_START", "SYSTEM", "$1–$20 penny stocks only", { dry_mode: DRY_MODE_BOOL });
  scanPennyStocks();
  setInterval(scanPennyStocks, 90000); // every 90 sec
  setInterval(exitAt345, 60000); // check every min
});
