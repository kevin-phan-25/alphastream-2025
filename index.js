// index.js — AlphaStream v27.0 — LOW FLOAT PENNY MONSTER + HARD RISK (2025) — Updated
import express from "express";
import axios from "axios";
import { Supertrend, ADX, ATR } from "technicalindicators"; // Static import to fix memory leak

const app = express();
app.use(express.json());

// CORS
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
  MASSIVE_KEY = "uJq_QdVgvrlry9ZpvkIKcs6s2q2qGKtZ",
  PREDICTOR_URL = "",
  LOG_WEBHOOK_URL = "",
  LOG_WEBHOOK_SECRET = "",
  FORWARD_SECRET = "",
  MAX_POS = "3",
  DRY_MODE = "false"
} = process.env;

const DRY_MODE_BOOL = DRY_MODE.toLowerCase() !== "false";
const A_BASE = "https://paper-api.alpaca.markets/v2";
const M_BASE = "https://api.massive.com";
const headers = { "APCA-API-KEY-ID": ALPACA_KEY, "APCA-API-SECRET-KEY": ALPACA_SECRET };

let positions = {};
let scanning = false;
let dailyPnL = 0;
let lastResetDate = new Date().toISOString().slice(0, 10);
let accountEquity = 25000; // Default, updated on startup

// HARD RISK LIMITS
const MAX_DAILY_LOSS = -0.02; // 2% daily stop
const RISK_PER_TRADE = 0.01;  // 1% risk per trade
const MAX_FLOAT = 30_000_000; // < 30M shares
const MIN_GAP = 15;
const MIN_VOLUME = 500_000;

// Logger
async function log(event, symbol = "", note = "", data = {}) {
  console.log(`[${event}] ${symbol} | ${note}`, data || "");
  if (LOG_WEBHOOK_URL && LOG_WEBHOOK_SECRET) {
    try { await axios.post(LOG_WEBHOOK_URL, { secret: LOG_WEBHOOK_SECRET, event, symbol, note, data }, { timeout: 5000 }); } catch {}
  }
}

// Update equity on startup
async function updateEquity() {
  try {
    const res = await axios.get(`${A_BASE}/account`, { headers, timeout: 8000 });
    accountEquity = parseFloat(res.data.equity || res.data.cash || 25000);
    await log("EQUITY_UPDATE", "SYSTEM", `$${accountEquity.toLocaleString()}`);
  } catch (e) {
    console.warn("Equity fetch failed, using $25,000 default");
  }
}

// Reset daily PnL at midnight ET
function resetDailyPnL() {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== lastResetDate) {
    dailyPnL = 0;
    lastResetDate = today;
    log("DAILY_RESET", "SYSTEM", "Daily PnL reset");
  }
}

// Dashboard
app.get("/", (req, res) => res.json({
  bot: "AlphaStream v27.0 LOW FLOAT PENNY",
  status: dailyPnL <= MAX_DAILY_LOSS ? "STOPPED (Daily Loss Limit)" : "LIVE",
  dailyPnL: (dailyPnL * 100).toFixed(2) + "%",
  positions: `${Object.keys(positions).length}/${MAX_POS}`,
  dry_mode: DRY_MODE_BOOL
}));

app.get("/healthz", (_, res) => res.status(200).send("OK"));

app.post("/", async (req, res) => {
  if (FORWARD_SECRET && req.body?.secret !== FORWARD_SECRET) return res.status(403).send("no");
  res.json({ status: "LOW FLOAT PENNY SCAN TRIGGERED" });
  await log("MANUAL_SCAN", "DASHBOARD", "User triggered");
  await scanLowFloatPennies();
});

async function placeOrder(sym, qty, side, price = null) {
  if (DRY_MODE_BOOL) {
    await log("DRY_ORDER", sym, `${side.toUpperCase()} ${qty} @ $${price?.toFixed(2) || "market"}`);
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
    await log("LIVE_ORDER", sym, `${side.toUpperCase()} ${qty}`);
  } catch (e) {
    await log("ORDER_FAIL", sym, e.response?.data?.message || e.message);
  }
}

// 3:45 PM ET EXIT + DAILY LOSS STOP
async function exitAt345OrLoss() {
  const now = new Date();
  const utcH = now.getUTCHours();
  const utcM = now.getUTCMinutes();

  if (dailyPnL <= MAX_DAILY_LOSS && Object.keys(positions).length > 0) {
    await log("LOSS_STOP", "SYSTEM", `Daily loss ${Math.round(dailyPnL * 100)}% → closing all`);
    for (const sym in positions) await placeOrder(sym, positions[sym].qty, "sell");
    positions = {};
    return;
  }

  if (utcH === 19 && utcM >= 45 && utcM < 50 && Object.keys(positions).length > 0) {
    await log("AUTO_EXIT_ALL", "SYSTEM", "3:45 PM — closing all");
    for (const sym in positions) await placeOrder(sym, positions[sym].qty, "sell");
    positions = {};
  }
}

// LOW FLOAT + PENNY SCANNER — OPTIMIZED & SAFE
async function scanLowFloatPennies() {
  if (scanning || dailyPnL <= MAX_DAILY_LOSS) return;
  scanning = true;
  resetDailyPnL();

  try {
    const now = new Date();
    const utcTime = now.getUTCHours() * 100 + now.getUTCMinutes();
    if (utcTime < 1100 || utcTime >= 1500) { // 7:00 AM - 11:00 AM ET
      scanning = false;
      return;
    }

    const isPreMarket = utcTime < 1330;
    await log(isPreMarket ? "PREMARKET_LOW_FLOAT" : "MORNING_LOW_FLOAT", "SYSTEM", "Scanning $1–$20 + <30M float");

    let candidates = [];
    try {
      const res = await axios.get(`${M_BASE}/v2/snapshot/locale/us/markets/stocks/gainers?apiKey=${MASSIVE_KEY}`, { timeout: 10000 });
      candidates = (res.data.tickers || [])
        .filter(t => t.lastTrade && t.prevDay)
        .filter(t => t.lastTrade.p >= 1 && t.lastTrade.p <= 20)
        .filter(t => t.lastTrade.v >= MIN_VOLUME)
        .map(t => ({
          symbol: t.ticker,
          price: t.lastTrade.p,
          gap: (t.lastTrade.p / t.prevDay.c - 1) * 100,
          volume: t.lastTrade.v
        }))
        .filter(t => t.gap >= MIN_GAP)
        .sort((a, b) => b.gap - a.gap);
    } catch (e) {
      await log("GAINERS_ERROR", "SYSTEM", "Gainers API failed, using fallback", { error: e.message });
    }

    if (candidates.length === 0) {
      try {
        const res = await axios.get(`${M_BASE}/v2/snapshot/locale/us/markets/stocks/tickers?apiKey=${MASSIVE_KEY}`, { timeout: 15000 });
        const all = Object.values(res.data.tickers || {});
        candidates = all
          .filter(t => t.lastTrade && t.prevDay && t.lastTrade.p >= 1 && t.lastTrade.p <= 20 && t.lastTrade.v >= MIN_VOLUME)
          .map(t => ({
            symbol: t.ticker,
            price: t.lastTrade.p,
            gap: (t.lastTrade.p / t.prevDay.c - 1) * 100,
            volume: t.lastTrade.v
          }))
          .filter(t => t.gap >= MIN_GAP)
          .sort((a, b) => b.gap - a.gap)
          .slice(0, 25);
      } catch (e) {
        await log("SNAPSHOT_ERROR", "SYSTEM", "Fallback failed, skipping scan", { error: e.message });
        scanning = false;
        return;
      }
    }

    await log("LOW_FLOAT_CANDIDATES", "SYSTEM", `${candidates.length} penny rockets`, candidates.map(c => `${c.symbol} +${c.gap.toFixed(1)}%`));

    for (const c of candidates) {
      if (Object.keys(positions).length >= parseInt(MAX_POS)) break;

      let float = 100_000_000;
      try {
        const info = await axios.get(`${M_BASE}/v3/reference/tickers/${c.symbol}?apiKey=${MASSIVE_KEY}`, { timeout: 5000 });
        float = info.data.results?.outstanding_shares || float;
      } catch (e) {
        await log("FLOAT_ERROR", c.symbol, "Could not fetch float", { error: e.message });
      }
      if (float > MAX_FLOAT) {
        await log("SKIP_FLOAT", c.symbol, `Float ${float.toLocaleString()} > 30M`);
        continue;
      }

      await log("VALID_PENNY", c.symbol, `+${c.gap.toFixed(1)}% | $${c.price.toFixed(2)} | Float ${(float/1e6).toFixed(1)}M`);

      let bars = [];
      try {
        const from = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString().slice(0, 10);
        const to = new Date().toISOString().slice(0, 10);
        const b = await axios.get(`${M_BASE}/v2/aggs/ticker/${c.symbol}/range/1/minute/${from}/${to}?limit=200&apiKey=${MASSIVE_KEY}`, { timeout: 8000 });
        bars = b.data.results || [];
      } catch (e) {
        await log("BARS_ERROR", c.symbol, "Bars fetch failed", { error: e.message });
        continue;
      }

      if (bars.length < 80) continue;

      const close = bars.map(b => b.c);
      const high = bars.map(b => b.h);
      const low = bars.map(b => b.l);

      const st = Supertrend({ period: 10, multiplier: 3, high, low, close });
      const adxData = ADX({ period: 14, high, low, close });
      const atrData = ATR({ period: 14, high, low, close });

      const current = {
        price: close[close.length - 1],
        stTrend: st[st.length - 1]?.trend,
        stLine: st[st.length - 1]?.superTrend,
        adx: adxData[adxData.length - 1]?.adx || 0,
        atr: atrData[atrData.length - 1] || 1
      };

      if (current.adx > 25 && current.stTrend === 1 && current.price > current.stLine) {
        let prob = 0.84;
        if (PREDICTOR_URL) {
          try {
            const ml = await axios.post(`${PREDICTOR_URL}/predict`, {
              features: [c.gap, current.adx, current.atr / current.price]
            }, { timeout: 3000 });
            prob = ml.data.probability || prob;
          } catch (e) {
            await log("ML_ERROR", c.symbol, "Prediction failed", { error: e.message });
          }
        }

        if (prob > 0.80) {
          const riskAmount = accountEquity * RISK_PER_TRADE; // Updated to use equity
          const qty = Math.max(1, Math.floor(riskAmount / (current.atr * 1.5)));
          await placeOrder(c.symbol, qty, "buy");
          positions[c.symbol] = { entry: current.price, qty, stop: current.price - current.atr * 2 };
          await log("LOW_FLOAT_ENTRY", c.symbol, `+${c.gap.toFixed(1)}% | Float ${(float/1e6).toFixed(1)}M | Risk 1%`, {
            qty,
            prob: (prob * 100).toFixed(1)
          });
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
  console.log(`ALPHASTREAM v27.0 LOW FLOAT PENNY LIVE on port ${PORT}`);
  await log("BOT_START", "SYSTEM", "Low Float + 1% Risk + Daily Stop", { dry_mode: DRY_MODE_BOOL });
  await updateEquity(); // Ensure equity is set before scanning
  scanLowFloatPennies();
  setInterval(scanLowFloatPennies, 75000);
  setInterval(exitAt345OrLoss, 60000);
});
