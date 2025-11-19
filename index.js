// index.js — AlphaStream v28.0 — ZERO DEPENDENCY, 100% STARTUP-PROOF (Nov 2025)
import express from "express";
import axios from "axios";

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

// ENV
const {
  ALPACA_KEY = "",
  ALPACA_SECRET = "",
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
let dailyPnL = 0;
let accountEquity = 25000;

// RISK
const RISK_PER_TRADE = 0.01;
const MAX_DAILY_LOSS = -0.02;
const MAX_FLOAT = 30_000_000;
const MIN_GAP = 15;
const MIN_VOLUME = 500_000;

async function log(event, symbol = "", note = "", data = {}) {
  console.log(`[${event}] ${symbol} | ${note}`, data);
  if (LOG_WEBHOOK_URL && LOG_WEBHOOK_SECRET) {
    try { await axios.post(LOG_WEBHOOK_URL, { secret: LOG_WEBHOOK_SECRET, event, symbol, note, data }, { timeout: 5000 }); } catch {}
  }
}

async function updateEquity() {
  try {
    const res = await axios.get(`${A_BASE}/account`, { headers, timeout: 8000 });
    accountEquity = parseFloat(res.data.equity || res.data.cash || 25000);
  } catch { accountEquity = 25000; }
}

function resetDailyPnL() {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== lastResetDate) {
    dailyPnL = 0;
    lastResetDate = today;
  }
}

function recordPnL(exitPrice, entry) {
  const pnl = (exitPrice - entry) / entry;
  dailyPnL += pnl;
  return pnl;
}

async function placeOrder(sym, qty, side) {
  if (DRY_MODE_BOOL) { await log("DRY_ORDER", sym, `${side.toUpperCase()} ${qty}`); return; }
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

async function exitAt345OrLoss() {
  const now = new Date();
  const utcH = now.getUTCHours();
  const utcM = now.getUTCMinutes();

  if (dailyPnL <= MAX_DAILY_LOSS && Object.keys(positions).length > 0) {
    await log("LOSS_STOP", "SYSTEM", `Daily loss ${(dailyPnL*100).toFixed(2)}% → closing all`);
    for (const sym in positions) await placeOrder(sym, positions[sym].qty, "sell");
    positions = {};
    return;
  }

  if (utcH === 19 && utcM >= 45 && utcM < 50 && Object.keys(positions).length > 0) {
    await log("AUTO_EXIT_ALL", "SYSTEM", "3:45 PM flat");
    for (const sym in positions) await placeOrder(sym, positions[sym].qty, "sell");
    positions = {};
  }
}

// MONITOR — TRAILING STOP + PARTIALS
async function monitorPositions() {
  for (const sym in positions) {
    const pos = positions[sym];
    try {
      const quote = await axios.get(`${A_BASE}/stocks/${sym}/quote`, { headers, timeout: 5000 });
      const bid = quote.data.quote?.bp || pos.entry;

      if (bid > pos.peak) pos.peak = bid;
      const newTrail = pos.peak - pos.atr * 1.5;
      if (newTrail > pos.trailStop) pos.trailStop = newTrail;

      if (!pos.took2R && bid >= pos.entry + 2 * (pos.entry - pos.stop)) {
        const half = Math.floor(pos.qty * 0.5);
        if (half > 0) {
          await placeOrder(sym, half, "sell");
          pos.qty -= half;
          pos.took2R = true;
          await log("PARTIAL_2R", sym, "50% off at 2R");
        }
      }

      if (bid <= pos.trailStop) {
        await placeOrder(sym, pos.qty, "sell");
        const pnl = recordPnL(bid, pos.entry);
        await log("TRAIL_STOP", sym, `Hit @ $${bid.toFixed(2)} | PnL ${(pnl*100).toFixed(2)}%`);
        delete positions[sym];
      }
    } catch (e) {
      await log("MONITOR_ERROR", sym, e.message);
    }
  }
}

// SCANNER — LOW FLOAT PENNY
async function scanLowFloatPennies() {
  if (scanning || dailyPnL <= MAX_DAILY_LOSS) return;
  scanning = true;
  await updateEquity();
  resetDailyPnL();

  const utcTime = new Date().getUTCHours() * 100 + new Date().getUTCMinutes();
  if (utcTime < 1100 || utcTime >= 1500) { scanning = false; return; }

  await log("SCAN_START", "SYSTEM", "Low-float penny hunt");

  let candidates = [];
  try {
    const res = await axios.get(`${M_BASE}/v2/snapshot/locale/us/markets/stocks/gainers?apiKey=${MASSIVE_KEY}`, { timeout: 10000 });
    candidates = (res.data.tickers || [])
      .filter(t => t.lastTrade && t.prevDay && t.lastTrade.p >= 1 && t.lastTrade.p <= 20 && t.lastTrade.v >= MIN_VOLUME)
      .map(t => ({
        symbol: t.ticker,
        price: t.lastTrade.p,
        gap: (t.lastTrade.p / t.prevDay.c - 1) * 100,
        volume: t.lastTrade.v
      }))
      .filter(t => t.gap >= MIN_GAP)
      .sort((a, b) => b.gap - a.gap);
  } catch (e) {
    await log("GAINERS_ERROR", "SYSTEM", "API failed — skipping scan");
    scanning = false;
    return;
  }

  for (const c of candidates) {
    if (Object.keys(positions).length >= parseInt(MAX_POS)) break;

    let float = 100_000_000;
    try {
      const info = await axios.get(`${M_BASE}/v3/reference/tickers/${c.symbol}?apiKey=${MASSIVE_KEY}`, { timeout: 5000 });
      float = info.data.results?.outstanding_shares || float;
    } catch {}
    if (float > MAX_FLOAT) continue;

    let bars = [];
    try {
      const from = new Date(Date.now() - 72*60*60*1000).toISOString().slice(0,10);
      const to = new Date().toISOString().slice(0,10);
      const b = await axios.get(`${M_BASE}/v2/aggs/ticker/${c.symbol}/range/1/minute/${from}/${to}?limit=300&apiKey=${MASSIVE_KEY}`, { timeout: 10000 });
      bars = b.data.results || [];
    } catch { continue; }
    if (bars.length < 100) continue;

    const close = bars.map(b => b.c);
    const high = bars.map(b => b.h);
    const low = bars.map(b => b.l);

    const st = Supertrend({ period: 10, multiplier: 3, high, low, close });
    const adxData = ADX({ period: 14, high
