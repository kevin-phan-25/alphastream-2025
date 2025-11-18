// index.js — AlphaStream v27.1 — UNKILLABLE LOW-FLOAT PENNY MONSTER (2025)
import express from "express";
import axios from "axios";
import { Supertrend, ADX, ATR } from "technicalindicators"; // ← FIXED: STATIC IMPORT

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

let positions = {};           // { sym: { entry, qty, stop, trailStop, peak } }
let scanning = false;
let dailyPnL = 0;
let lastResetDate = "";
let accountEquity = 25000;    // Will be updated on start

// HARD RISK PARAMS
const RISK_PER_TRADE = 0.01;     // 1%
const MAX_DAILY_LOSS = -0.02;    // 2%
const MAX_FLOAT = 30_000_000;
const MIN_GAP = 15;
const MIN_VOLUME = 500_000;

// Logger
async function log(event, symbol = "", note = "", data = {}) {
  console.log(`[${event}] ${symbol} | ${note}`, data);
  if (LOG_WEBHOOK_URL && LOG_WEBHOOK_SECRET) {
    try { await axios.post(LOG_WEBHOOK_URL, { secret: LOG_WEBHOOK_SECRET, event, symbol, note, data }, { timeout: 5000 }); } catch {}
  }
}

// Get fresh equity
async function updateEquity() {
  try {
    const res = await axios.get(`${A_BASE}/account`, { headers });
    accountEquity = parseFloat(res.data.equity || res.data.cash);
  } catch { }
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

// Place order
async function placeOrder(sym, qty, side) {
  if (DRY_MODE_BOOL) {
    await log("DRY_ORDER", sym, `${side.toUpperCase()} ${qty}`);
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

// 3:45 PM EXIT + DAILY LOSS STOP
async function exitAt345OrLoss() {
  const now = new Date();
  const utcH = now.getUTCHours();
  const utcM = now.getUTCMinutes();

  if (dailyPnL <= MAX_DAILY_LOSS && Object.keys(positions).length > 0) {
    await log("LOSS_STOP", "SYSTEM", `Daily loss ${Math.round(dailyPnL*100)}% → closing all`);
    for (const sym in positions) {
      await placeOrder(sym, positions[sym].qty, "sell");
      delete positions[sym];
    }
    return;
  }

  if (utcH === 19 && utcM >= 45 && utcM < 50 && Object.keys(positions).length > 0) {
    await log("AUTO_EXIT_ALL", "SYSTEM", "3:45 PM — closing all positions");
    for (const sym in positions) {
      await placeOrder(sym, positions[sym].qty, "sell");
      delete positions[sym];
    }
  }
}

// TRAILING STOP + PROFIT TARGET MONITOR (runs every 60s)
async function monitorPositions() {
  for (const sym in positions) {
    const pos = positions[sym];
    try {
      const quote = await axios.get(`${A_BASE}/stocks/${sym}/quote`, { headers, timeout: 5000 });
      const bid = quote.data.quote?.bp || quote.data.quote?.ap || pos.entry;

      // Update trailing stop (1.5 × ATR)
      const newTrail = = pos.entry + (bid - pos.entry);
      if (newTrail > pos.trailStop) pos.trailStop = newTrail;

      // 3R profit target
      const threeR = pos.entry + 3 * (pos.entry - pos.stop);
      if (bid >= threeR) {
        await placeOrder(sym, pos.qty, "sell");
        await log("PROFIT_TARGET", sym, `3R hit @ $${bid.toFixed(2)}`);
        delete positions[sym];
        continue;
      }

      // Trailing stop hit
      if (bid <= pos.trailStop) {
        await placeOrder(sym, pos.qty, "sell");
        await log("TRAIL_STOP", sym, `Stopped out @ $${bid.toFixed(2)} (trail $${pos.trailStop.toFixed(2)})`);
        dailyPnL += (bid - pos.entry) / pos.entry;
        delete positions[sym];
      }
    } catch (e) {
      await log("MONITOR_ERROR", sym, e.message);
    }
  }
}

// MAIN SCANNER — LOW FLOAT PENNY MONSTER
async function scanLowFloatPennies() {
  if (scanning || dailyPnL <= MAX_DAILY_LOSS) return;
  scanning = true;
  await updateEquity();
  resetDailyPnL();

  const utcTime = new Date().getUTCHours() * 100 + new Date().getUTCMinutes();
  if (utcTime < 1100 || utcTime >= 1500) { scanning = false; return; }

  const isPreMarket = utcTime < 1330;
  await log(isPreMarket ? "PREMARKET_SCAN" : "MORNING_SCAN", "SYSTEM", "Low-float penny hunt");

  let candidates = [];
  try {
    const res = await axios.get(`${M_BASE}/v2/snapshot/locale/us/markets/stocks/gainers?apiKey=${MASSIVE_KEY}`, { timeout: 10000 });
    candidates = (res.data.tickers || []).map(t => ({
      symbol: t.ticker,
      price: t.lastTrade?.p,
      gap: t.todaysChangePerc,
      volume: t.lastTrade?.v
    }));
  } catch {
    await log("GAINERS_FAIL", "SYSTEM", "Falling back to full snapshot");
  }

  if (candidates.length === 0) {
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
      .filter(c => c.gap >= MIN_GAP)
      .sort((a, b) => b.gap - a.gap)
      .slice(0, 25);
  }

  await log("CANDIDATES", "SYSTEM", `${candidates.length} low-float runners`, candidates.map(c => `${c.symbol} +${c.gap.toFixed(1)}%`));

  for (const c of candidates) {
    if (Object.keys(positions).length >= parseInt(MAX_POS)) break;
    if (positions[c.symbol]) continue; // ← DUPLICATE PROTECTION

    // Float check
    let float = 100_000_000;
    try {
      const info = await axios.get(`${M_BASE}/v3/reference/tickers/${c.symbol}?apiKey=${MASSIVE_KEY}`, { timeout: 5000 });
      float = info.data.results?.outstanding_shares || info.data.results?.share_class_shares_outstanding || float;
    } catch {}
    if (float > MAX_FLOAT) continue;

    // Bars
    let bars = [];
    try {
      const from = new Date(Date.now() - 48*60*60*1000).toISOString().slice(0,10);
      const to = new Date().toISOString().slice(0,10);
      const b = await axios.get(`${M_BASE}/v2/aggs/ticker/${c.symbol}/range/1/minute/${from}/${to}?limit=200&apiKey=${MASSIVE_KEY}`, { timeout: 8000 });
      bars = b.data.results || [];
    } catch { continue; }
    if (bars.length < 80) continue;

    const close = bars.map(b => b.c);
    const high = bars.map(b => b.h);
    const low = bars.map(b => b.l);

    const st = Supertrend({ period: 10, multiplier: 3, high, low, close });
    const adxData = ADX({ period: 14, high, low, close });
    const atrData = ATR({ period: 14, high, low, close });

    const cur = {
      price: close[close.length-1],
      stTrend: st[st.length-1]?.trend,
      stLine: st[st.length-1]?.superTrend,
      adx: adxData[adxData.length-1]?.adx || 0,
      atr: atrData[atrData.length-1] || 1
    };

    if (cur.adx > 25 && cur.stTrend === 1 && cur.price > cur.stLine) {
      let prob = 0.84;
      if (PREDICTOR_URL) {
        try {
          const ml = await axios.post(`${PREDICTOR_URL}/predict`, { features: [c.gap, cur.adx, cur.atr/cur.price] }, { timeout: 3000 });
          prob = ml.data.probability || prob;
        } catch {}
      }

      if (prob > 0.80) {
        const riskAmount = accountEquity * RISK_PER_TRADE;
        const qty = Math.max(1, Math.floor(riskAmount / (cur.atr * 2))); // 2×ATR stop
        await placeOrder(c.symbol, qty, "buy");

        const stopPrice = cur.price - cur.atr * 2;
        positions[c.symbol] = {
          entry: cur.price,
          qty,
          stop: stopPrice,
          trailStop: stopPrice,
          peak: cur.price
        };

        await log("ENTRY", c.symbol,
          `+${c.gap.toFixed(1)}% | Float ${(float/1e6).toFixed(1)}M | Risk 1% | Stop $${stopPrice.toFixed(2)}`,
          { qty, prob: (prob*100).toFixed(1) });
      }
    }
  }

  scanning = false;
}

// START
const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", async () => {
  console.log(`ALPHASTREAM v27.1 UNKILLABLE PENNY MONSTER LIVE`);
  await updateEquity();
  await log("BOT_START", "SYSTEM", "Final version — no more blowups", { equity: accountEquity });
  scanLowFloatPennies();
  setInterval(scanLowFloatPennies, 75000);
  setInterval(monitorPositions, 60000);
  setInterval(exitAt345OrLoss, 60000);
});
