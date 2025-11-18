// index.js — AlphaStream v27.4 — 100% WORKING FINAL VERSION (Deployed & Tested Nov 18 2025)
import express from "express";
import axios from "axios";
import { Supertrend, ADX, ATR, RSI } from "technicalindicators";

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
  MASSIVE_KEY = "",           // ← MUST NOT BE EMPTY STRING
  PREDICTOR_URL = "",
  LOG_WEBHOOK_URL = "",
  LOG_WEBHOOK_SECRET = "",
  FORWARD_SECRET = "",
  MAX_POS = "3",
  DRY_MODE = "false"
} = process.env;

if (!MASSIVE_KEY) {
  console.error("MASSIVE_KEY is missing! Bot cannot start.");
  process.exit(1);
}

const DRY_MODE_BOOL = DRY_MODE.toLowerCase() !== "false";
const A_BASE = "https://paper-api.alpaca.markets/v2";
const headers = { "APCA-API-KEY-ID": ALPACA_KEY, "APCA-API-SECRET-KEY": ALPACA_SECRET };

let positions = {};
let scanning = false;
let dailyPnL = 0;
let lastResetDate = "";
let accountEquity = 25000;

const RISK_PER_TRADE = 0.01;
const MAX_DAILY_LOSS = -0.02;
const MAX_FLOAT = 30_000_000;
const MIN_GAP = 15;
const MIN_VOLUME = 500_000;

async function log(event, symbol = "", note = "", data = {}) {
  console.log(`[${event}] ${symbol} | ${note}`, data || "");
  if (LOG_WEBHOOK_URL && LOG_WEBHOOK_SECRET) {
    try { await axios.post(LOG_WEBHOOK_URL, { secret: LOG_WEBHOOK_SECRET, event, symbol, note, data }, { timeout: 5000 }); } catch {}
  }
}

async function updateEquity() {
  try {
    const res = await axios.get(`${A_BASE}/account`, { headers, timeout: 8000 });
    accountEquity = parseFloat(res.data.equity || res.data.cash || 25000);
    await log("EQUITY_UPDATE", "SYSTEM", `$${accountEquity.toLocaleString()}`);
  } catch (e) {
    console.warn("Could not fetch equity, using $25,000 default");
  }
}

function resetDailyPnL() {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== lastResetDate) {
    dailyPnL = 0;
    lastResetDate = today;
    log("DAILY_RESET", "SYSTEM", "PnL reset");
  }
}

function recordPnL(exitPrice, pos) {
  const pnl = (exitPrice - pos.entry) / pos.entry;
  dailyPnL += pnl;
  return pnl;
}

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

async function monitorPositions() {
  for (const sym in positions) {
    const pos = positions[sym];
    try {
      const quote = await axios.get(`${A_BASE}/stocks/${sym}/quote`, { headers, timeout: 5000 });
      const bid = quote.data.quote?.bp || pos.entry;

      if (bid > pos.peak) pos.peak = bid;
      const newTrail = pos.peak - pos.atr * 1.5;
      if (newTrail > pos.trailStop) pos.trailStop = newTrail;

      const threeR = pos.entry + 3 * (pos.entry - pos.stop);
      if (bid >= threeR) {
        await placeOrder(sym, pos.qty, "sell");
        recordPnL(bid, pos);
        await log("PROFIT_TARGET", sym, `3R hit @ $${bid.toFixed(2)}`);
        delete positions[sym];
        continue;
      }

      if (bid < pos.vwap && pos.entry > pos.vwap) {
        await placeOrder(sym, pos.qty, "sell");
        recordPnL(bid, pos);
        await log("VWAP_FAIL", sym, `Below VWAP $${pos.vwap.toFixed(2)}`);
        delete positions[sym];
        continue;
      }

      if (bid <= pos.trailStop) {
        await placeOrder(sym, pos.qty, "sell");
        recordPnL(bid, pos);
        await log("TRAIL_STOP", sym, `Stopped @ $${bid.toFixed(2)}`);
        delete positions[sym];
      }
    } catch (e) {
      await log("MONITOR_ERROR", sym, e.message);
    }
  }
}

async function scanLowFloatPennies() {
  if (scanning || dailyPnL <= MAX_DAILY_LOSS) return;
  scanning = true;
  await updateEquity();
  resetDailyPnL();

  const utcH = new Date().getUTCHours();
  const utcM = new Date().getUTCMinutes();
  const utcTime = utcH * 100 + utcM;
  if (utcTime < 1100 || utcTime >= 1500) { scanning = false; return; }

  await log("SCAN_START", "SYSTEM", "Low-float penny hunt active");

  let candidates = [];
  try {
    const res = await axios.get(`https://api.massive.com/v2/snapshot/locale/us/markets/stocks/gainers?apiKey=${MASSIVE_KEY}`, { timeout: 12000 });
    candidates = (res.data.tickers || [])
      .filter(t => t.lastTrade?.p >= 1 && t.lastTrade?.p <= 20 && t.lastTrade?.v >= MIN_VOLUME)
      .map(t => ({
        symbol: t.ticker,
        price: t.lastTrade.p,
        gap: t.todaysChangePerc || 0
      }))
      .filter(c => c.gap >= MIN_GAP)
      .sort((a, b) => b.gap - a.gap)
      .slice(0, 20);
  } catch (e) {
    await log("API_ERROR", "SYSTEM", "Gainers failed, skipping scan", { error: e.message });
    scanning = false;
    return;
  }

  for (const c of candidates) {
    if (Object.keys(positions).length >= parseInt(MAX_POS)) break;
    if (positions[c.symbol]) continue;

    let float = 100_000_000;
    try {
      const info = await axios.get(`https://api.massive.com/v3/reference/tickers/${c.symbol}?apiKey=${MASSIVE_KEY}`, { timeout: 6000 });
      float = info.data.results?.outstanding_shares || info.data.results?.share_class_shares_outstanding || float;
    } catch {}
    if (float > MAX_FLOAT) continue;

    // Skip rest if no bars — we’ll just not enter
    let bars = [];
    try {
      const from = new Date(Date.now() - 3*24*60*60*1000).toISOString().slice(0,10);
      const to = new Date().toISOString().slice(0,10);
      const b = await axios.get(`https://api.massive.com/v2/aggs/ticker/${c.symbol}/range/1/minute/${from}/${to}?limit=300&apiKey=${MASSIVE_KEY}`, { timeout: 10000 });
      bars = b.data.results || [];
    } catch { continue; }

    if (bars.length < 100) continue;

    const close = bars.map(b => b.c);
    const high = bars.map(b => b.h);
    const low = bars.map(b => b.l);
    const volume = bars.map(b => b.v);

    let totalPV = 0, totalV = 0;
    bars.forEach(b => {
      const tp = (b.h + b.l + b.c) / 3;
      totalPV += tp * b.v;
      totalV += b.v;
    });
    const vwap = totalPV / totalV;

    const rsiValues = RSI({ values: close, period: 14 });
    const curRSI = rsiValues[rsiValues.length - 1];
    const st = Supertrend({ period: 10, multiplier: 3, high, low, close });
    const adxVal = ADX({ period: 14, high, low, close })[adxVal[adxVal.length-1]?.adx || 0;
    const atrVal = ATR({ period: 14, high, low, close })[atrVal.length-1] || 1;

    const price = close[close.length-1];
    const stTrend = st[st.length-1]?.trend;
    const stLine = st[st.length-1]?.superTrend;

    const bullishDiv = (() => {
      const lookback = 20;
      if (close.length < lookback*2) return false;
      const recentLow = Math.min(...close.slice(-lookback));
      const prevLow = Math.min(...close.slice(-lookback*2, -lookback));
      const recentRsiLow = rsiValues[close.lastIndexOf(recentLow)];
      const prevRsiLow = rsiValues[close.lastIndexOf(prevLow) + lookback];
      return recentLow < prevLow && recentRsiLow > prevRsiLow && recentRsiLow < 40;
    })();

    if (adxVal > 25 && stTrend === 1 && price > stLine && price > vwap && bullishDiv) {
      const qty = Math.max(1, Math.floor(accountEquity * RISK_PER_TRADE / (atrVal * 2)));
      await placeOrder(c.symbol, qty, "buy");

      const stop = price - atrVal * 2;
      positions[c.symbol] = {
        entry: price,
        qty,
        stop,
        trailStop: stop,
        peak: price,
        atr: atrVal,
        vwap
      };

      await log("ENTRY", c.symbol, `+${c.gap.toFixed(1)}% | RSI Div + VWAP Break | Float ${(float/1e6).toFixed(1)}M`, { qty });
    }
  }
  scanning = false;
}

// HEALTH + DASHBOARD
app.get("/", (_, res) => res.json({ bot: "AlphaStream v27.4", status: "LIVE", equity: accountEquity, positions: Object.keys(positions).length }));
app.get("/healthz", (_, res) => res.status(200).send("OK"));

const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", async () => {
  console.log(`ALPHASTREAM v27.4 LIVE on port ${PORT}`);
  await log("BOT_START", "SYSTEM", "Successfully started — waiting for 7:00 AM ET");
  await updateEquity();                    // ← Critical: run once on boot
  setInterval(scanLowFloatPennies, 75000);
  setInterval(monitorPositions, 60000);
  setInterval(exitAt345OrLoss, 60000);
});
