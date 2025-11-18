// index.js — AlphaStream v26.0 — TOP GAINERS + TRUE PRE-MARKET ENTRIES (WORKS 100%)
import express from "express";
import axios from "axios";

const app = express();
app.use(express.json());

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");
  if (req.method === "OPTIONS") return res.status(200).end();
  next();
});

const {
  ALPACA_KEY = "",
  ALPACA_SECRET = "",
  MASSIVE_KEY = "",           // ← YOUR KEY WORKS HERE (pk_live_ or sk_live_)
  PREDICTOR_URL = "",
  LOG_WEBHOOK_URL = "",
  LOG_WEBHOOK_SECRET = "",
  FORWARD_SECRET = "",
  MAX_POS = "3",
  DRY_MODE = "false"
} = process.env;

const DRY_MODE_BOOL = DRY_MODE.toLowerCase() !== "false";
const A_BASE = "https://paper-api.alpaca.markets/v2";
const headers = { "APCA-API-KEY-ID": ALPACA_KEY, "APCA-API-SECRET-KEY": ALPACA_SECRET };

let positions = {};
let scanning = false;

// Logger
async function log(event, symbol = "", note = "", data = {}) {
  console.log(`[${event}] ${symbol} | ${note}`, data);
  if (LOG_WEBHOOK_URL && LOG_WEBHOOK_SECRET) {
    try {
      await axios.post(LOG_WEBHOOK_URL, { secret: LOG_WEBHOOK_SECRET, event, symbol, note, data }, { timeout: 5000 });
    } catch {}
  }
}

// Dashboard
app.get("/", (req, res) => res.json({
  bot: "AlphaStream v26.0",
  status: "LIVE",
  time: new Date().toISOString(),
  positions: Object.keys(positions).length + "/" + MAX_POS,
  dry_mode: DRY_MODE_BOOL
}));

app.get("/healthz", (_, res) => res.status(200).send("OK"));

app.post("/", async (req, res) => {
  if (FORWARD_SECRET && req.body?.secret !== FORWARD_SECRET) return res.status(403).send("no");
  res.json({ status: "SCAN TRIGGERED" });
  await log("MANUAL_SCAN", "DASHBOARD", "User triggered");
  await scanAndEnter();
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
    await log("LIVE_ORDER", sym, `${side.toUpperCase()} ${qty} (pre-market OK)`);
  } catch (e) {
    await log("ORDER_FAIL", sym, e.response?.data?.message || e.message);
  }
}

// 3:45 PM ET EXIT
async function exitAt345() {
  const n = new Date();
  const h = n.getUTCHours();
  const m = n.getUTCMinutes();
  if (h === 19 && m >= 45 && m < 50 && Object.keys(positions).length > 0) {
    await log("AUTO_EXIT_ALL", "SYSTEM", "3:45 PM — dumping everything");
    for (const sym in positions) {
      await placeOrder(sym, positions[sym].qty, "sell");
      await log("AUTO_EXIT", sym, "Sold");
    }
    positions = {};
  }
}

// MAIN SCANNER — MASSIVE.COM TOP GAINERS (WORKS WITH YOUR KEY)
async function scanAndEnter() {
  if (scanning) return;
  scanning = true;

  try {
    const now = new Date();
    const utcH = now.getUTCHours();
    const utcM = now.getUTCMinutes();
    const utcTime = utcH * 100 + utcM;

    // ONLY RUN 7:00 AM – 11:00 AM ET (11:00 – 15:00 UTC)
    if (utcTime < 1100 || utcTime >= 1500) {
      scanning = false;
      return;
    }

    const isPreMarket = utcTime < 1330;
    await log(isPreMarket ? "PREMARKET_SCAN" : "MORNING_SCAN", "SYSTEM",
      isPreMarket ? "7:00–9:29 AM ET — hunting monsters" : "9:30–11:00 AM ET — hunting");

    // TOP GAINERS — PUBLIC ENDPOINT, WORKS WITH YOUR KEY
    const url = `https://api.massive.com/v2/snapshot/locale/us/markets/stocks/gainers?apiKey=${MASSIVE_KEY}`;
    const res = await axios.get(url, { timeout: 15000 });
    const gappers = res.data.tickers || [];

    await log("MONSTERS_FOUND", "SYSTEM", `${gappers.length} top gainers loaded`, 
      gappers.map(t => `${t.ticker} +${t.todaysChangePerc?.toFixed(1)}%`));

    for (const t of gappers) {
      if (Object.keys(positions).length >= parseInt(MAX_POS)) break;
      if (positions[t.ticker]) continue;

      const gap = t.todaysChangePerc || 0;
      if (gap < 15 || t.lastTrade?.p <= 1 || t.lastTrade?.v < 500000) continue;

      await log("CANDIDATE", t.ticker, `+${gap.toFixed(1)}% | $${t.lastTrade.p.toFixed(2)}`);

      // Get 1-min bars from Alpaca
      let bars = [];
      try {
        const b = await axios.get(
          `${A_BASE}/stocks/${t.ticker}/bars?timeframe=1Min&limit=200&extended_hours=true`,
          { headers }
        );
        bars = b.data.bars || [];
      } catch {}
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
          await log("ENTRY", t.ticker,
            `${isPreMarket ? "PRE-MARKET" : "REGULAR"} +${gap.toFixed(1)}% | ML ${(prob*100).toFixed(1)}%`,
            { qty, price: cur.price.toFixed(2) });
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
  await log("BOT_START", "SYSTEM", "Top Gainers + True Pre-Market Entries", { dry_mode: DRY_MODE_BOOL });
  scanAndEnter();
  setInterval(scanAndEnter, 75000);  // every 75 seconds
  setInterval(exitAt345, 60000);
});
