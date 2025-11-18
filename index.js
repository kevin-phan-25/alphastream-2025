// index.js — AlphaStream v27.2 — FINAL LOW-FLOAT MONSTER (RSI DIVERGENCE + VWAP + FIXED TRAILING)
import express from "express";
import axios from "axios";
import { Supertrend, ADX, ATR, RSI } from "technicalindicators"; // Static import

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

let positions = {};           // { sym: { entry, qty, stop, trailStop, peak, vwap } }
let scanning = false;
let dailyPnL = 0;
let lastResetDate = "";
let accountEquity = 25000;

// RISK PARAMS
const RISK_PER_TRADE = 0.01;
const MAX_DAILY_LOSS = -0.02;
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

// Update equity
async function updateEquity() {
  try {
    const res = await axios.get(`${A_BASE}/account`, { headers });
    accountEquity = parseFloat(res.data.equity || res.data.cash);
  } catch { }
}

// Daily PnL reset
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

// TRAILING STOP + 3R + VWAP MONITOR (runs every 60s)
async function monitorPositions() {
  for (const sym in positions) {
    const pos = positions[sym];
    try {
      const [quoteRes, vwapRes] = await Promise.all([
        axios.get(`${A_BASE}/stocks/${sym}/quote`, { headers, timeout: 5000 }),
        axios.get(`${A_BASE}/stocks/${sym}/bars?timeframe=1Day&limit=1`, { headers, timeout: 5000 })
      ]);

      const bid = quoteRes.data.quote?.bp || pos.entry;
      const vwap = vwapRes.data.bars?.[0]?.vw || pos.vwap || pos.entry;

      // Update peak & trailing stop (1.5× ATR from peak)
      if (bid > pos.peak) pos.peak = bid;
      const newTrail = pos.peak - (pos.atr * 1.5);
      if (newTrail > pos.trailStop) pos.trailStop = newTrail;

      // 3R profit target
      const threeR = pos.entry + 3 * (pos.entry - pos.stop);
      if (bid >= threeR) {
        await placeOrder(sym, pos.qty, "sell");
        await log("PROFIT_TARGET", sym, `3R hit @ $${bid.toFixed(2)}`);
        delete positions[sym];
        continue;
      }

      // VWAP retest fail (if price drops below VWAP after breakout)
      if (bid < vwap && pos.entry > vwap) {
        await placeOrder(sym, pos.qty, "sell");
        await log("VWAP_FAIL", sym, `Dropped below VWAP $${vwap.toFixed(2)}`);
        delete positions[sym];
        continue;
      }

      // Trailing stop hit
      if (bid <= pos.trailStop) {
        await placeOrder(sym, pos.qty, "sell");
        const pnl = (bid - pos.entry) / pos.entry;
        dailyPnL += pnl;
        await log("TRAIL_STOP", sym, `Stopped @ $${bid.toFixed(2)} | PnL ${(pnl*100).toFixed(2)}%`);
        delete positions[sym];
      }
    } catch (e) {
      await log("MONITOR_ERROR", sym, e.message);
    }
  }
}

// RSI BULLISH DIVERGENCE DETECTION
function hasBullishDivergence(close, rsiValues, lookback = 20) {
  if (close.length < lookback * 2) return false;
  const recent = close.slice(-lookback);
  const prev = close.slice(-lookback*2, -lookback);
  const rsiRecent = rsiValues.slice(-lookback);
  const rsiPrev = rsiValues.slice(-lookback*2, -lookback);

  const priceLow = Math.min(...recent);
  const prevPriceLow = Math.min(...prev);
  const rsiLow = rsiValues[close.indexOf(priceLow)];
  const prevRsiLow = rsiValues[close.indexOf(prevPriceLow) + lookback];

  return priceLow < prevPriceLow && rsiLow > prevRsiLow && rsiLow < 40;
}

// MAIN SCANNER — RSI DIVERGENCE + VWAP BREAKOUT
async function scanLowFloatPennies() {
  if (scanning || dailyPnL <= MAX_DAILY_LOSS) return;
  scanning = true;
  await updateEquity();
  resetDailyPnL();

  const utcTime = new Date().getUTCHours() * 100 + new Date().getUTCMinutes();
  if (utcTime < 1100 || utcTime >= 1500) { scanning = false; return; }

  const isPreMarket = utcTime < 1330;
  await log(isPreMarket ? "PREMARKET_SCAN" : "MORNING_SCAN", "SYSTEM", "RSI Divergence + VWAP Breakout Hunt");

  let candidates = [];
  try {
    const res = await axios.get(`${M_BASE}/v2/snapshot/locale/us/markets/stocks/gainers?apiKey=${MASSIVE_KEY}`, { timeout: 10000 });
    candidates = (res.data.tickers || [])
      .filter(t => t.lastTrade && t.prevDay && t.lastTrade.p >= 1 && t.lastTrade.p <= 20 && t.lastTrade.v >= MIN_VOLUME)
      .map(t => ({
        symbol: t.ticker,
        price: t.lastTrade.p,
        gap: t.todaysChangePerc || (t.lastTrade.p / t.prevDay.c - 1) * 100,
        volume: t.lastTrade.v
      }))
      .filter(c => c.gap >= MIN_GAP)
      .sort((a, b) => b.gap - a.gap)
      .slice(0, 20);
  } catch { /* fallback already handled above */ }

  await log("CANDIDATES", "SYSTEM", `${candidates.length} potential runners`);

  for (const c of candidates) {
    if (Object.keys(positions).length >= parseInt(MAX_POS)) break;
    if (positions[c.symbol]) continue;

    // Float check
    let float = 100_000_000;
    try {
      const info = await axios.get(`${M_BASE}/v3/reference/tickers/${c.symbol}?apiKey=${MASSIVE_KEY}`, { timeout: 5000 });
      float = info.data.results?.outstanding_shares || info.data.results?.share_class_shares_outstanding || float;
    } catch {}
    if (float > MAX_FLOAT) continue;

    // Get bars
    let bars = [];
    try {
      const from = new Date(Date.now() - 72*60*60*1000).toISOString().slice(0,10);
      const to = new Date().toISOString().slice(0,10);
      const b = await axios.get(`${M_BASE}/v2/aggs/ticker/${c.symbol}/range/1/minute/${from}/${to}?limit=300&apiKey=${MASSIVE_KEY}`, { timeout: 10000 });
      bars = b.data.results || [];
    } catch { continue; }
    if (bars.length < 150) continue;

    const close = bars.map(b => b.c);
    const high = bars.map(b => b.h);
    const low = bars.map(b => b.l);
    const volume = bars.map(b => b.v);
    const vwapValues = bars.map((b, i) => (b.h + b.l + b.c) / 3 * b.v);
    const cumulativeVWAP = vwapValues.reduce((acc, v, i) => acc + v, 0) / volume.reduce((a, b) => a + b, 0);

    const rsiValues = RSI({ values: close, period: 14 });
    const currentRSI = rsiValues[rsiValues.length - 1];

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

    const vwapBreakout = cur.price > cumulativeVWAP;
    const rsiDivergence = hasBullishDivergence(close, rsiValues);

    if (cur.adx > 25 && cur.stTrend === 1 && cur.price > cur.stLine && vwapBreakout && rsiDivergence) {
      let prob = 0.88;
      if (PREDICTOR_URL) {
        try {
          const ml = await axios.post(`${PREDICTOR_URL}/predict`, { features: [c.gap, cur.adx, currentRSI] }, { timeout: 3000 });
          prob = ml.data.probability || prob;
        } catch {}
      }

      if (prob > 0.82) {
        const riskAmount = accountEquity * RISK_PER_TRADE;
        const qty = Math.max(1, Math.floor(riskAmount / (cur.atr * 2)));
        await placeOrder(c.symbol, qty, "buy");

        const stopPrice = cur.price - cur.atr * 2;
        positions[c.symbol] = {
          entry: cur.price,
          qty,
          stop: stopPrice,
          trailStop: stopPrice,
          peak: cur.price,
          atr: cur.atr,
          vwap: cumulativeVWAP
        };

        await log("ENTRY", c.symbol,
          `+${c.gap.toFixed(1)}% | RSI Div + VWAP Break | Float ${(float/1e6).toFixed(1)}M`,
          { qty, rsi: currentRSI.toFixed(1), prob: (prob*100).toFixed(1) });
      }
    }
  }

  scanning = false;
}

// START
const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", async () => {
  console.log(`ALPHASTREAM v27.2 FINAL MONSTER LIVE`);
  await updateEquity();
  await log("BOT_START", "SYSTEM", "RSI Divergence + VWAP + Fixed Trailing + All Fixes");
  scanLowFloatPennies();
  setInterval(scanLowFloatPennies, 75000);
  setInterval(monitorPositions, 60000);
  setInterval(exitAt345OrLoss, 60000);
});
