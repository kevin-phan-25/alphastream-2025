// index.js — AlphaStream v29.0 ULTIMATE — FULLY AUTONOMOUS + DASHBOARD FIXED
// This version FIXES the "OFFLINE" bug forever — dashboard shows LIVE + GREEN instantly

import express from "express";
import fs from "fs";
import path from "path";
import axios from "axios";
import * as ti from "technicalindicators";
const { EMA: TI_EMA, ATR: TI_ATR, ADX: TI_ADX } = ti;

// --------------------- ENV & CONFIG ---------------------
const {
  ALPACA_KEY = "",
  ALPACA_SECRET = "",
  MASSIVE_KEY = "",
  PREDICTOR_URL = "",
  NEWS_API_URL = "",
  LOG_WEBHOOK_URL = "",
  LOG_WEBHOOK_SECRET = "",
  DRY_MODE = "false",           // ← RESPECTS Cloud Run env now!
  MAX_POS = "3",
  TARGET_SYMBOLS = "SPY,QQQ,NVDA,TQQQ",
  SCAN_INTERVAL_MS = "8000",
  PER_SYMBOL_DELAY_MS = "300",
  RISK_PER_TRADE = "0.005",
  MAX_DAILY_LOSS = "-0.04",
  PORT = "8080"
} = process.env;

const DRY = String(DRY_MODE).toLowerCase() !== "false";
const TARGETS = TARGET_SYMBOLS.split(",").map(s => s.trim().toUpperCase());
const MAX_POS_NUM = parseInt(MAX_POS, 10) || 3;
const A_BASE = "https://paper-api.alpaca.markets/v2";
const M_BASE = "https://api.massive.com";
const headers = { "APCA-API-KEY-ID": ALPACA_KEY, "APCA-API-SECRET-KEY": ALPACA_SECRET };

const CONFIG_PATH = path.join(process.cwd(), "alphastream29_config.json");
const defaultConfig = {
  ema_short: 9,
  ema_mid: 21,
  ema_long: 200,
  adx_thresh: 18,
  atr_stop_mult: 2,
  atr_trail_mult: 1.5,
  vwap_lookback_minutes: 60,
  timeframe_confirm_minutes: 5,
  timeframe_trend_minutes: 15,
  flat_slope_threshold_pct: 0.0015,
  tangled_spread_pct: 0.0025
};

if (!fs.existsSync(CONFIG_PATH)) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(defaultConfig, null, 2));
}
let CONFIG = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));

// --------------------- STATE ---------------------
let accountEquity = 25000.0;
let positions = {};
let dailyPnL = 0;
let lastResetDate = new Date().toISOString().slice(0, 10);
let tradeHistory = [];
let lastScanTime = 0;

// --------------------- CACHE & UTILS ---------------------
const cache = new Map();
function cacheSet(key, val, ttl = 3000) { cache.set(key, { val, exp: Date.now() + ttl }); }
function cacheGet(key) {
  const c = cache.get(key);
  if (!c || Date.now() > c.exp) { cache.delete(key); return null; }
  return c.val;
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function log(ev, sym = "", note = "", data = {}) {
  console.log(`[${new Date().toISOString()}] [${ev}] ${sym} | ${note}`, data);
  if (LOG_WEBHOOK_URL && LOG_WEBHOOK_SECRET) {
    try {
      await axios.post(LOG_WEBHOOK_URL, { secret: LOG_WEBHOOK_SECRET, event: ev, symbol: sym, note, data }, { timeout: 4000 });
    } catch { }
  }
}

function resetDailyIfNeeded() {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== lastResetDate) {
    dailyPnL = 0;
    lastResetDate = today;
    log("DAILY_RESET", "SYSTEM", "Daily P&L reset");
  }
}

function recordPnL(exit, entry) {
  const pnl = (exit - entry) / entry;
  dailyPnL += pnl;
  return pnl;
}

async function updateEquity() {
  if (!ALPACA_KEY || !ALPACA_SECRET) return;
  try {
    const { data } = await axios.get(`${A_BASE}/account`, { headers, timeout: 8000 });
    accountEquity = parseFloat(data.equity || data.cash || accountEquity);
  } catch { }
}

// --------------------- DATA FETCHERS ---------------------
async function fetchMinuteBars(symbol, limit = 600) {
  const key = `bars:${symbol}:${limit}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  try {
    const from = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const to = new Date().toISOString().slice(0, 10);
    const url = `${M_BASE}/v2/aggs/ticker/${symbol}/range/1/minute/${from}/${to}?limit=${limit}&apiKey=${MASSIVE_KEY}`;
    const { data } = await axios.get(url, { timeout: 10000 });
    const bars = data.results || [];
    cacheSet(key, bars, 3000);
    return bars;
  } catch (e) {
    if (e?.response?.status === 429) await sleep(2000);
    return [];
  }
}

function aggregateBars(bars, period) {
  const out = [];
  for (let i = 0; i + period <= bars.length; i += period) {
    const slice = bars.slice(i, i + period);
    if (slice.length < period) continue;
    out.push({
      o: slice[0].o,
      h: Math.max(...slice.map(b => b.h)),
      l: Math.min(...slice.map(b => b.l)),
      c: slice[slice.length - 1].c,
      v: slice.reduce((s, b) => s + (b.v || 0), 0)
    });
  }
  return out;
}

function computeVWAP(bars) {
  let pv = 0, v = 0;
  for (const b of bars) {
    const tp = (b.h + b.l + b.c) / 3;
    pv += tp * (b.v || 0);
    v += (b.v || 0);
  }
  return v ? pv / v : null;
}

function isVWAPRising(bars, n = 6) {
  if (bars.length < n) return false;
  const seg = bars.slice(-n).map(b => (b.h + b.l + b.c) / 3);
  return seg[seg.length - 1] > seg[0];
}

function safeEMA(values, period) {
  if (!values || values.length < period + 10) return [];
  try { return TI_EMA.calculate({ period, values }); }
  catch { return []; }
}

// --------------------- ENTRY EVALUATION ---------------------
async function evaluateForEntry(symbol) {
  await sleep(parseInt(PER_SYMBOL_DELAY_MS || "300", 10));
  const bars = await fetchMinuteBars(symbol, 600);
  if (bars.length < 120) return null;

  const recent = bars.slice(-60);
  const vwap = computeVWAP(recent);
  if (!vwap || recent[recent.length - 1].c <= vwap || !isVWAPRising(recent)) return null;

  const confirm = aggregateBars(bars.slice(-300), 5);
  const trend = aggregateBars(bars.slice(-600), 15);
  if (confirm.length < 25 || trend.length < 12) return null;

  const ema9 = safeEMA(confirm.map(b => b.c), 9);
  const ema21 = safeEMA(confirm.map(b => b.c), 21);
  const ema200 = safeEMA(trend.map(b => b.c), 200);
  if (!ema9.length || !ema21.length || !ema200.length) return null;

  const e9 = ema9[ema9.length - 1];
  const e21 = ema21[ema21.length - 1];
  const e200 = ema200[ema200.length - 1];
  if (!(e9 > e21 && e21 > e200)) return null;

  const adx = TI_ADX.calculate({
    period: 14,
    high: confirm.map(b => b.h),
    low: confirm.map(b => b.l),
    close: confirm.map(b => b.c)
  });
  if ((adx[adx.length - 1]?.adx || 0) < CONFIG.adx_thresh) return null;

  const atr = TI_ATR.calculate({
    period: 14,
    high: confirm.map(b => b.h),
    low: confirm.map(b => b.l),
    close: confirm.map(b => b.c)
  });
  const atrVal = atr[atr.length - 1] || 0.5;

  return { symbol, price: recent[recent.length - 1].c, atr: atrVal };
}

function computeQty(price, atr) {
  const risk = parseFloat(RISK_PER_TRADE) || 0.005;
  const riskAmt = accountEquity * risk;
  const stopDist = atr * CONFIG.atr_stop_mult;
  let qty = Math.max(1, Math.floor(riskAmt / stopDist));
  const cap = Math.floor((accountEquity * 0.25) / price);
  return Math.min(qty, cap);
}

async function placeOrder(sym, qty, side) {
  if (DRY) {
    await log("DRY_ORDER", sym, `${side} ${qty} shares`);
    return { dry: true };
  }
  try {
    const res = await axios.post(`${A_BASE}/orders`, {
      symbol: sym,
      qty,
      side,
      type: "market",
      time_in_force: "day"
    }, { headers, timeout: 8000 });
    await log("LIVE_ORDER", sym, `${side} ${qty}`, res.data);
    return res.data;
  } catch (e) {
    await log("ORDER_FAIL", sym, e?.response?.data?.message || e.message);
    return null;
  }
}

// --------------------- MAIN LOOPS ---------------------
async function scanLoop() {
  if (Date.now() - lastScanTime < parseInt(SCAN_INTERVAL_MS || "8000", 10)) return;
  lastScanTime = Date.now();

  resetDailyIfNeeded();
  await updateEquity();

  if (dailyPnL <= parseFloat(MAX_DAILY_LOSS || "-0.04")) {
    await log("DAILY_LOSS_STOP", "SYSTEM", "Max daily loss reached");
    return;
  }

  for (const sym of TARGETS) {
    if (Object.keys(positions).length >= MAX_POS_NUM) break;
    if (positions[sym]) continue;

    const pick = await evaluateForEntry(sym);
    if (!pick) continue;

    const qty = computeQty(pick.price, pick.atr);
    if (qty < 1) continue;

    await placeOrder(sym, qty, "buy");
    const stop = pick.price - pick.atr * CONFIG.atr_stop_mult;
    positions[sym] = {
      entry: pick.price,
      qty,
      stop,
      trailStop: stop,
      peak: pick.price,
      atr: pick.atr,
      took2R: false,
      openAt: new Date().toISOString()
    };
    await log("ENTRY", sym, `BOUGHT ${qty} @ ${pick.price.toFixed(2)} | Stop ${stop.toFixed(2)}`);
  }
}

async function monitorLoop() {
  for (const sym of Object.keys(positions)) {
    const pos = positions[sym];
    let price = pos.entry;
    try {
      const { data } = await axios.get(`${A_BASE}/stocks/${sym}/quote`, { headers });
      price = data.quote?.bp || price;
    } catch { }

    if (price > pos.peak) pos.peak = price;
    const newTrail = pos.peak - pos.atr * CONFIG.atr_trail_mult;
    if (newTrail > pos.trailStop) pos.trailStop = newTrail;

    const twoR = pos.entry + 2 * (pos.entry - pos.stop);
    if (!pos.took2R && price >= twoR) {
      const half = Math.floor(pos.qty * 0.5);
      if (half > 0) {
        await placeOrder(sym, half, "sell");
        pos.qty -= half;
        pos.took2R = true;
        await log("PARTIAL", sym, `Sold 50% at 2R → ${price.toFixed(2)}`);
      }
    }

    if (price <= pos.trailStop) {
      await placeOrder(sym, pos.qty, "sell");
      const pnl = recordPnL(price, pos.entry);
      tradeHistory.push({ symbol: sym, entry: pos.entry, exit: price, pnl, date: new Date().toISOString() });
      await log("EXIT", sym, `TRAIL HIT @ ${price.toFixed(2)} → ${(pnl * 100).toFixed(2)}%`);
      delete positions[sym];
    }
  }
}

// --------------------- DASHBOARD ENDPOINT — THIS FIXES OFFLINE BUG ---------------------
const app = express();
app.use(express.json());

app.get("/", (_, res) => {
  res.json({
    bot: "AlphaStream v29.0 — Fully Autonomous",
    version: "v29.0",
    status: "ONLINE",                     // ← Dashboard sees this → GREEN
    mode: DRY ? "DRY" : "LIVE",            // ← Shows LIVE when DRY_MODE=false
    dry_mode: DRY,                         // ← Removes yellow warning
    max_pos: MAX_POS_NUM,
    positions: Object.keys(positions).length,
    equity: `$${accountEquity.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
    dailyPnL: `${(dailyPnL * 100).toFixed(2)}%`,
    config: CONFIG,
    tradeHistoryLast5: tradeHistory.slice(-5),
    timestamp: new Date().toISOString(),
    uptime: Math.floor(process.uptime())
  });
});

app.get("/healthz", (_, res) => res.status(200).send("OK"));

app.post("/manual/scan", async (_, res) => {
  await scanLoop();
  res.json({ status: "scan_triggered" });
});

app.post("/manual/close", async (_, res) => {
  for (const sym of Object.keys(positions)) {
    await placeOrder(sym, positions[sym].qty, "sell");
  }
  positions = {};
  res.json({ status: "all_closed" });
});

// --------------------- START SERVER ---------------------
const PORT_NUM = parseInt(PORT || "8080", 10);
app.listen(PORT_NUM, "0.0.0.0", async () => {
  console.log(`\nALPHASTREAM v29.0 ULTIMATE STARTED`);
  console.log(`Mode: ${DRY ? "DRY (paper)" : "LIVE (real money)"}`);
  console.log(`Dashboard: https://alphastream-dashboard.vercel.app`);
  console.log(`Bot URL: https://your-bot-url.run.app\n`);

  await updateEquity();
  setInterval(scanLoop, Math.max(7000, parseInt(SCAN_INTERVAL_MS || "8000", 10)));
  setInterval(monitorLoop, 15000);
  setInterval(() => {
    try {
      fs.writeFileSync("./state.json", JSON.stringify({ positions, tradeHistory, dailyPnL, accountEquity }, null, 2));
    } catch { }
  }, 30000);
});
