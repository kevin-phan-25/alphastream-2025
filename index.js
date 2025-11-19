// index.js — AlphaStream v29.0 — FULLY AUTONOMOUS
// Features: MTF confluence, regime detection, ML-gating, dynamic sizing, nightly self-optimization
// Requires Node 18+. Use DRY_MODE=true while testing.

import express from "express";
import fs from "fs";
import path from "path";
import axios from "axios";
import * as ti from "technicalindicators";
import crypto from "crypto";

const { EMA: TI_EMA, ATR: TI_ATR, ADX: TI_ADX, Supertrend: TI_Supertrend } = ti;

// ---------- CONFIG / ENV ----------
const {
  ALPACA_KEY = "",
  ALPACA_SECRET = "",
  MASSIVE_KEY = "",
  PREDICTOR_URL = "",        // optional ML predictor: POST /predict {features} returns {probability}
  NEWS_API_URL = "",         // optional quick news endpoint (GET q=SYMBOL&minutes=60)
  VIX_API_URL = "",          // optional VIX provider endpoint (GET /vix -> {vix: number})
  LOG_WEBHOOK_URL = "",
  LOG_WEBHOOK_SECRET = "",
  DRY_MODE = "false",
  MAX_POS = "3",
  START_UPGRADE_HOUR_UTC = "03:00", // nightly optimizer run time (UTC)
  RISK_BASE = "0.005",      // base risk per trade (0.5% default)
  OPT_WINDOW_DAYS = "45",   // days to use for nightly optimization
  TARGET_SYMBOLS = "SPY,QQQ,NVDA,TQQQ",
  PORT = "8080"
} = process.env;

const DRY = String(DRY_MODE).toLowerCase() !== "false";
const RISK_BASE_PCT = parseFloat(RISK_BASE) || 0.005;
const OPT_WINDOW = parseInt(OPT_WINDOW_DAYS, 10) || 45;
const TARGETS = TARGET_SYMBOLS.split(",").map(s => s.trim().toUpperCase());
const APP_PORT = parseInt(PORT, 10) || 8080;

const A_BASE = "https://paper-api.alpaca.markets/v2";
const M_BASE = "https://api.massive.com";
const headers = { "APCA-API-KEY-ID": ALPACA_KEY, "APCA-API-SECRET-KEY": ALPACA_SECRET };

const defaultConfig = {
  // hyperparameters the optimizer will tune
  supertrend_period: 10,
  supertrend_mult: 3,
  adx_thresh: 25,
  atr_multiplier_stop: 2,
  atr_multiplier_trail: 1.5,
  ema_short: 9,
  ema_long: 21,
  vwap_lookback_minutes: 60,
  timeframe_confirm_minutes: 5,    // 5-min confirmation timeframe
  timeframe_trend_minutes: 15      // 15-min higher timeframe trend
};

const CONFIG_PATH = path.join(process.cwd(), "alphastream29_config.json");
if (!fs.existsSync(CONFIG_PATH)) fs.writeFileSync(CONFIG_PATH, JSON.stringify(defaultConfig, null, 2));
let CONFIG = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));

// ---------- STATE ----------
let accountEquity = 25000;
let positions = {}; // symbol -> {entry, qty, stop, trailStop, peak, atr, took2R, openAt}
let dailyPnL = 0;
let lastResetDate = new Date().toISOString().slice(0,10);
let tradeHistory = []; // {symbol, entry, exit, pnl, date}
let scanning = false;

// ---------- UTILITIES ----------
async function log(event, symbol="", note="", data={}) {
  console.log(`[${event}] ${symbol} | ${note}`, data);
  if (LOG_WEBHOOK_URL && LOG_WEBHOOK_SECRET) {
    try {
      await axios.post(LOG_WEBHOOK_URL, { secret: LOG_WEBHOOK_SECRET, event, symbol, note, data }, { timeout: 5000 });
    } catch (e) { /* swallow */ }
  }
}

function nowISO() { return new Date().toISOString(); }

function resetDailyPnLIfNeeded() {
  const today = new Date().toISOString().slice(0,10);
  if (today !== lastResetDate) {
    dailyPnL = 0;
    lastResetDate = today;
    log("DAILY_RESET", "SYSTEM", "PnL reset");
  }
}

function recordPnL(exitPrice, entry) {
  const pnl = (exitPrice - entry) / entry;
  dailyPnL += pnl;
  return pnl;
}

async function updateEquity() {
  if (!ALPACA_KEY || !ALPACA_SECRET) {
    await log("EQUITY", "SYSTEM", "No Alpaca keys; using fallback", {accountEquity});
    return;
  }
  try {
    const res = await axios.get(`${A_BASE}/account`, { headers, timeout: 8000 });
    accountEquity = parseFloat(res?.data?.equity || res?.data?.cash || accountEquity);
    await log("EQUITY", "SYSTEM", `$${Number(accountEquity).toLocaleString()}`);
  } catch (e) {
    await log("EQUITY_FAIL", "SYSTEM", e?.message || String(e));
  }
}

async function placeOrder(sym, qty, side) {
  if (DRY) {
    await log("DRY_ORDER", sym, `${side.toUpperCase()} ${qty}`);
    return { dry: true };
  }
  try {
    const res = await axios.post(`${A_BASE}/orders`, {
      symbol: sym, qty, side, type: "market", time_in_force: "day", extended_hours: false
    }, { headers, timeout: 8000 });
    await log("LIVE_ORDER", sym, `${side.toUpperCase()} ${qty}`, res.data);
    return res.data;
  } catch (e) {
    await log("ORDER_FAIL", sym, e?.response?.data?.message || e?.message || String(e));
    return null;
  }
}

// Simple cache helper for API calls to avoid rate limits
const cache = new Map();
function cacheSet(key, val, ttlMs=5000) {
  cache.set(key, { val, expiry: Date.now() + ttlMs });
}
function cacheGet(key) {
  const c = cache.get(key);
  if (!c) return null;
  if (Date.now() > c.expiry) { cache.delete(key); return null; }
  return c.val;
}

// ---------- DATA FETCHERS ----------
async function fetchMinuteBarsMassive(symbol, limit=500) {
  // caching
  const cacheKey = `bars:${symbol}:${limit}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;
  try {
    const from = new Date(Date.now() - 7*24*60*60*1000).toISOString().slice(0,10);
    const to = new Date().toISOString().slice(0,10);
    const res = await axios.get(`${M_BASE}/v2/aggs/ticker/${symbol}/range/1/minute/${from}/${to}?limit=${limit}&apiKey=${MASSIVE_KEY}`, { timeout: 10000 });
    const bars = res?.data?.results || [];
    cacheSet(cacheKey, bars, 5000);
    return bars;
  } catch (e) {
    await log("BARS_FAIL", symbol, e?.message || String(e));
    return [];
  }
}

async function fetchRecentSnapshot(symbol) {
  // quick snapshot for price/volume — cache for 2s
  const key = `snap:${symbol}`;
  const cached = cacheGet(key);
  if (cached) return cached;
  try {
    const res = await axios.get(`${M_BASE}/v2/snapshot/locale/us/markets/stocks/tickers?apiKey=${MASSIVE_KEY}`, { timeout: 6000 });
    const all = res?.data?.tickers || {};
    const data = Object.values(all).find(t => t.ticker === symbol) || null;
    cacheSet(key, data, 2000);
    return data;
  } catch (e) {
    return null;
  }
}

// ---------- INDICATORS & HELPERS ----------
function aggregateBars(minuteBars, periodMinutes) {
  // minuteBars chronological (old->new)
  if (!minuteBars || minuteBars.length === 0) return [];
  const out = [];
  for (let i = 0; i + periodMinutes <= minuteBars.length; i += periodMinutes) {
    const slice = minuteBars.slice(i, i + periodMinutes);
    if (slice.length < periodMinutes) continue;
    const o = slice[0].o;
    const c = slice[slice.length-1].c;
    const h = Math.max(...slice.map(x => x.h));
    const l = Math.min(...slice.map(x => x.l));
    const v = slice.reduce((s,x)=>s+(x.v||0),0);
    out.push({ o, h, l, c, v, t: slice[slice.length-1].t });
  }
  return out;
}

function computeVWAP(minuteBars) {
  if (!minuteBars || minuteBars.length === 0) return null;
  let cumPV = 0;
  let cumV = 0;
  for (const b of minuteBars) {
    const tp = (b.h + b.l + b.c) / 3;
    cumPV += tp * (b.v || 0);
    cumV += (b.v || 0);
  }
  if (cumV === 0) return null;
  return cumPV / cumV;
}

function isVWAPRising(minuteBars, lookbackCount=6) {
  if (!minuteBars || minuteBars.length < lookbackCount) return false;
  const segments = minuteBars.slice(-lookbackCount).map(b => (b.h + b.l + b.c)/3);
  return segments[segments.length-1] > segments[0];
}

// ---------- ML & NEWS GATE ----------
async function hasFreshPositiveNews(symbol, minutes=60) {
  if (!NEWS_API_URL) return true;
  try {
    const res = await axios.get(`${NEWS_API_URL}?q=${encodeURIComponent(symbol)}&minutes=${minutes}`, { timeout: 3000 });
    const articles = res?.data?.articles || [];
    return articles.length > 0;
  } catch (e) {
    await log("NEWS_FAIL", symbol, e?.message || String(e));
    return true;
  }
}

async function predictorApprove(features) {
  if (!PREDICTOR_URL) return { ok: true, prob: 0.85 };
  try {
    const res = await axios.post(`${PREDICTOR_URL}/predict`, { features }, { timeout: 3000 });
    const prob = res?.data?.probability || res?.data?.prob || 0.0;
    return { ok: prob >= 0.62, prob };
  } catch (e) {
    await log("PRED_FAIL", "", e?.message || String(e));
    return { ok: true, prob: 0.75 }; // non-blocking fallback
  }
}

// ---------- REGIME DETECTION ----------
async function getVIX() {
  if (!VIX_API_URL) return null;
  try {
    const res = await axios.get(`${VIX_API_URL}`, { timeout: 3000 });
    return res?.data?.vix || null;
  } catch (e) {
    return null;
  }
}

async function regimeAllowsTrading() {
  // Basic rules:
  // - If VIX > 30 => disable new entries
  // - If SPY ATR (15m) very low => disable
  // - If dailyPnL <= MAX_DAILY_LOSS (safety) => close and stop (MAX_DAILY_LOSS read from CONFIG or env)
  const vix = await getVIX();
  if (vix && vix > 30) {
    await log("REGIME", "SYSTEM", `VIX ${vix} high — disabling new entries`);
    return false;
  }
  // SPY 15-min ATR check (low volatility kill switch)
  const spyBars = await fetchMinuteBarsMassive("SPY", 500);
  if (spyBars.length < 50) return true;
  const spy15 = aggregateBars(spyBars.slice(-150), 15);
  if (spy15.length >= 20) {
    const highs = spy15.map(b=>b.h), lows=spy15.map(b=>b.l), closes=spy15.map(b=>b.c);
    const atr = TI_ATR({ period: 14, high: highs, low: lows, close: closes });
    const atrLast = atr[atr.length-1] || 0;
    if (atrLast < 0.2) { // very low 15-min ATR threshold
      await log("REGIME", "SYSTEM", `SPY ATR low ${atrLast} — skipping entries`);
      return false;
    }
  }
  return true;
}

// ---------- ENTRY EVALUATOR (MTF) ----------
async function evaluateSymbolForEntry(symbol) {
  // fetch minute bars
  const minuteBars = await fetchMinuteBarsMassive(symbol, 500); // old->new
  if (!minuteBars || minuteBars.length < 120) return null;

  // timeframe aggregation
  const tTrend = CONFIG.timeframe_trend_minutes || 15;
  const tConfirm = CONFIG.timeframe_confirm_minutes || 5;
  const trendBars = aggregateBars(minuteBars.slice(-500), tTrend);
  const confirmBars = aggregateBars(minuteBars.slice(-200), tConfirm);
  const recentMinutes = minuteBars.slice(-Math.max(60, CONFIG.vwap_lookback_minutes || 60));

  if (!trendBars.length || !confirmBars.length || !recentMinutes.length) return null;

  // VWAP and rising VWAP
  const vwap = computeVWAP(recentMinutes);
  if (!vwap) return null;
  const lastPrice = recentMinutes[recentMinutes.length-1].c;
  if (lastPrice <= vwap) return null;
  if (!isVWAPRising(recentMinutes, 6)) return null;

  // EMA short/long on confirm timeframe
  const closesConfirm = confirmBars.map(b=>b.c);
  const emaShort = TI_EMA({ period: CONFIG.ema_short || 9, values: closesConfirm });
  const emaLong = TI_EMA({ period: CONFIG.ema_long || 21, values: closesConfirm });
  if (!emaShort.length || !emaLong.length) return null;
  if (emaShort[emaShort.length-1] <= emaLong[emaLong.length-1]) return null;

  // ADX on confirm timeframe
  const highs = confirmBars.map(b=>b.h), lows = confirmBars.map(b=>b.l), closes = closesConfirm;
  const adxData = TI_ADX({ period: 14, high: highs, low: lows, close: closes });
  const adxLast = adxData[adxData.length-1] ? adxData[adxData.length-1].adx : 0;
  if (adxLast < CONFIG.adx_thresh) return null;

  // Supertrend optional
  let stTrend = null;
  try {
    const st = TI_Supertrend({ period: CONFIG.supertrend_period, multiplier: CONFIG.supertrend_mult, high: highs, low: lows, close: closes });
    stTrend = st[st.length-1] ? st[st.length-1].trend : null;
  } catch (e) { /* ignore */ }
  if (stTrend !== null && stTrend !== 1) return null;

  // ATR for sizing & stop
  const atrData = TI_ATR({ period: 14, high: highs, low: lows, close: closes });
  const atrLast = atrData[atrData.length-1] || Math.max(...highs)-Math.min(...lows);

  // news + ML gating
  const newsOk = await hasFreshPositiveNews(symbol, 60);
  if (!newsOk) return null;

  const pickFeatures = {
    symbol,
    lastPrice,
    vwapDistancePct: (lastPrice - vwap) / vwap,
    adx: adxLast,
    atr: atrLast
  };
  const pred = await predictorApprove(pickFeatures);
  if (!pred.ok) return null;

  return {
    symbol,
    lastPrice,
    vwap,
    adx: adxLast,
    atr: atrLast,
    predProb: pred.prob
  };
}

// ---------- DYNAMIC SIZING ----------
function computeQty(entryPrice, atr, accountEquityLocal) {
  // dynamic risk sizing: base risk scaled by short-term performance
  const baseRisk = RISK_BASE_PCT;
  // performance modifier: if last 5 trades profitable, increase risk, if losing decrease
  const last5 = tradeHistory.slice(-5);
  const wins = last5.filter(t => t.pnl > 0).length;
  let perfMod = 1.0;
  if (last5.length >= 3) {
    if (wins >= 4) perfMod = 1.4;
    else if (wins >= 3) perfMod = 1.2;
    else if (wins <= 1) perfMod = 0.8;
    else perfMod = 1.0;
  }
  // volatility modifier: if ATR small, modestly increase size
  const volMod = Math.min(1.6, Math.max(0.5, 1.0 / (atr * 0.5))); // guard
  const riskPct = Math.max(0.0005, Math.min(0.02, baseRisk * perfMod * volMod));
  const riskAmount = accountEquityLocal * riskPct;
  const stopDistance = atr * (CONFIG.atr_multiplier_stop || 2);
  let qty = Math.max(1, Math.floor(riskAmount / stopDistance));
  // anti-over allocation: per-symbol cap at 25% of equity
  const price = entryPrice || 1;
  const maxQtyByCap = Math.max(1, Math.floor((accountEquityLocal * 0.25) / price));
  qty = Math.min(qty, maxQtyByCap);
  return { qty, riskPct, stopDistance };
}

// ---------- ENTRY / EXEC ----------
async function runScanAndEnter() {
  if (scanning) return;
  scanning = true;
  resetDailyPnLIfNeeded();
  await updateEquity();
  const canTrade = await regimeAllowsTrading();
  if (!canTrade) { scanning = false; return; }

  await log("SCAN_START", "SYSTEM", `scan for ${TARGETS.join(", ")}`, { equity: accountEquity });

  for (const sym of TARGETS) {
    try {
      if (Object.keys(positions).length >= parseInt(MAX_POS,10)) break;
      if (positions[sym]) continue;

      const pick = await evaluateSymbolForEntry(sym);
      if (!pick) continue;

      // compute qty & stop
      const sizing = computeQty(pick.lastPrice, pick.atr, accountEquity);
      if (!sizing.qty || sizing.qty <= 0) continue;

      // place order
      await placeOrder(sym, sizing.qty, "buy");
      const entry = pick.lastPrice;
      const stop = entry - sizing.stopDistance;
      positions[sym] = {
        entry,
        qty: sizing.qty,
        stop,
        trailStop: stop,
        peak: entry,
        atr: pick.atr,
        took2R: false,
        openAt: nowISO()
      };

      await log("ENTRY", sym, `entry ${entry} qty ${sizing.qty} stop ${stop.toFixed(2)} riskPct ${(sizing.riskPct*100).toFixed(2)}%`, { pick, sizing });
    } catch (e) {
      await log("SCAN_ERR", sym, e?.message || String(e));
    }
  }

  scanning = false;
}

// ---------- MONITOR & EXIT ----------
async function monitorOpenPositions() {
  for (const sym of Object.keys(positions)) {
    const pos = positions[sym];
    try {
      // latest quote
      let bid = pos.entry;
      try {
        const q = await axios.get(`${A_BASE}/stocks/${sym}/quote`, { headers, timeout: 4000 });
        bid = q?.data?.quote?.bp || bid;
      } catch (e) { /* fallback to last known */ }

      // update peak & trail
      if (bid > pos.peak) pos.peak = bid;
      const newTrail = pos.peak - pos.atr * (CONFIG.atr_multiplier_trail || 1.5);
      if (newTrail > pos.trailStop) pos.trailStop = newTrail;

      // take 50% at 2R
      const twoRlevel = pos.entry + 2 * (pos.entry - pos.stop);
      if (!pos.took2R && bid >= twoRlevel) {
        const half = Math.floor(pos.qty * 0.5);
        if (half > 0) {
          await placeOrder(sym, half, "sell");
          pos.qty -= half;
          pos.took2R = true;
          await log("PARTIAL_2R", sym, `50% taken at ${bid.toFixed(2)}`);
        }
      }

      // trail hit
      if (bid <= pos.trailStop) {
        await placeOrder(sym, pos.qty, "sell");
        const pnl = recordPnL(bid, pos.entry);
        tradeHistory.push({ symbol: sym, entry: pos.entry, exit: bid, pnl, date: nowISO() });
        await log("TRAIL_EXIT", sym, `exit ${bid.toFixed(2)} pnl ${(pnl*100).toFixed(2)}%`);
        delete positions[sym];
      }
    } catch (e) {
      await log("MONITOR_ERR", sym, e?.message || String(e));
    }
  }
}

// close all positions safely
async function closeAllPositions(reason="manual") {
  await log("CLOSE_ALL", "SYSTEM", `closing all positions: ${reason}`);
  for (const sym of Object.keys(positions)) {
    const pos = positions[sym];
    if (pos && pos.qty > 0) await placeOrder(sym, pos.qty, "sell");
    delete positions[sym];
  }
}

// ---------- NIGHTLY SELF-OPTIMIZER (simple hill-climb) ----------
async function runSelfOptimization() {
  await log("OPT_START", "SYSTEM", "Self-optimization starting");
  // fetch recent trade history and market data
  // strategy: small local search on a subset of hyperparams: adx_thresh, supertrend_mult, atr_multiplier_stop
  const base = CONFIG;
  const searchSpace = [
    { param: "adx_thresh", vals: [20, 22, 25, 28, 30] },
    { param: "supertrend_mult", vals: [2.5, 3, 3.5, 4] },
    { param: "atr_multiplier_stop", vals: [1.5, 2, 2.5, 3] }
  ];
  // quick backtest simulator using last OPT_WINDOW days for target symbols (very simplified)
  const windowDays = OPT_WINDOW;
  // pull minutebars for each symbol
  const results = [];
  for (const sym of TARGETS) {
    const bars = await fetchMinuteBarsMassive(sym, 2000);
    if (!bars || bars.length < 500) continue;
    // simple simulation function: will backtest a couple of parameter combos on aggregated 5-min bars
    const sim = (cfg) => {
      // aggregate to 5-min
      const five = aggregateBars(bars.slice(-1000), 5);
      if (five.length < 60) return { totalPnL: 0, trades: 0 };
      // naive backtest: look for EMA crossover + adx>thresh + price>vwap
      let equity = 0;
      let trades = 0;
      for (let i = 30; i < five.length - 5; i++) {
        const slice = five.slice(0, i);
        const closes = slice.map(b => b.c);
        const emaShort = TI_EMA({ period: base.ema_short || 9, values: closes });
        const emaLong = TI_EMA({ period: base.ema_long || 21, values: closes });
        if (!emaShort.length || !emaLong.length) continue;
        const lastShort = emaShort[emaShort.length - 1];
        const lastLong = emaLong[emaLong.length - 1];
        // adx
        const highs = slice.map(b=>b.h), lows = slice.map(b=>b.l);
        const adxData = TI_ADX({ period: 14, high: highs, low: lows, close: closes });
        const adx = adxData[adxData.length-1] ? adxData[adxData.length-1].adx : 0;
        const vwap = computeVWAP(slice.slice(-(base.vwap_lookback_minutes||60)));
        const priceNow = slice[slice.length-1].c;
        if (lastShort > lastLong && adx >= cfg.adx_thresh && priceNow > (vwap||0)) {
          // simulate trade: hold 10 bars ahead and exit at ATR-based stop or end
          const entry = priceNow;
          const atrData = TI_ATR({ period: 14, high: highs, low: lows, close: closes });
          const atr = atrData[atrData.length-1] || 0.5;
          const stop = entry - atr * cfg.atr_multiplier_stop;
          let exit = entry;
          for (let j = 1; j <= 10; j++) {
            const f = five[i + j];
            if (!f) break;
            // if price drops below stop, exit
            if (f.c <= stop) { exit = f.c; break; }
            exit = f.c;
          }
          const pnl = (exit - entry) / entry;
          equity += pnl;
          trades += 1;
        }
      }
      return { totalPnL: equity, trades };
    };

    // test combinations
    const combos = [];
    for (const a of searchSpace[0].vals) for (const b of searchSpace[1].vals) for (const c of searchSpace[2].vals) {
      combos.push({ adx_thresh: a, supertrend_mult: b, atr_multiplier_stop: c });
    }
    let best = null;
    for (const cfg of combos) {
      const simRes = sim(cfg);
      if (!best || simRes.totalPnL > best.totalPnL) best = { cfg, res: simRes };
    }
    if (best) results.push({ sym, best });
  }

  // pick best across symbols (majority vote)
  const counts = {};
  for (const r of results) {
    const key = JSON.stringify(r.best.cfg);
    counts[key] = (counts[key]||0) + 1;
  }
  const bestKey = Object.keys(counts).sort((a,b)=>counts[b]-counts[a])[0];
  if (bestKey) {
    const bestCfg = JSON.parse(bestKey);
    // update CONFIG minimally
    CONFIG.adx_thresh = bestCfg.adx_thresh || CONFIG.adx_thresh;
    CONFIG.supertrend_mult = bestCfg.supertrend_mult || CONFIG.supertrend_mult;
    CONFIG.atr_multiplier_stop = bestCfg.atr_multiplier_stop || CONFIG.atr_multiplier_stop;
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(CONFIG, null, 2));
    await log("OPT_DONE", "SYSTEM", "Updated CONFIG via optimizer", { updated: bestCfg });
  } else {
    await log("OPT_DONE", "SYSTEM", "No optimizer improvement found");
  }
}

// schedule optimizer run daily at START_UPGRADE_HOUR_UTC
function scheduleNightlyOptimizer() {
  const [hh, mm] = START_UPGRADE_HOUR_UTC.split(":").map(x=>parseInt(x,10));
  // compute ms to next hh:mm UTC
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hh, mm, 0));
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  const delay = next - now;
  setTimeout(async function tick() {
    try {
      await runSelfOptimization();
    } catch (e) { await log("OPT_ERR", "SYSTEM", e?.message || String(e)); }
    // reschedule 24h
    setTimeout(tick, 24*60*60*1000);
  }, delay);
}

// ---------- SANITY / EXITS ----------
async function checkDailyLossAndClose() {
  const MAX_DAILY_LOSS = parseFloat(process.env.MAX_DAILY_LOSS || "-0.08"); // -8% default
  if (dailyPnL <= MAX_DAILY_LOSS) {
    await log("DAILY_STOP", "SYSTEM", `Daily loss ${(dailyPnL*100).toFixed(2)}% reached. Closing all.`);
    await closeAllPositions("daily_loss_stop");
  }
}

// ---------- HTTP Server ----------
const app = express();
app.use(express.json());

app.get("/", (_, res) => res.json({
  bot: "AlphaStream v29.0 Fully Autonomous",
  config: CONFIG,
  equity: `$${Number(accountEquity).toLocaleString()}`,
  positions: Object.keys(positions).length,
  dailyPnL: `${(dailyPnL*100).toFixed(2)}%`,
  tradeHistoryLast5: tradeHistory.slice(-5)
}));

app.get("/healthz", (_, res) => res.status(200).send("OK"));

app.post("/manual/scan", async (req, res) => {
  await log("MANUAL", "SYSTEM", "Manual scan triggered");
  runScanAndEnter().catch(e=>log("ERR","MANUAL_SCAN",e?.message||String(e)));
  res.json({ status: "scan_triggered" });
});

app.post("/manual/close", async (req, res) => {
  await closeAllPositions("manual_api");
  res.json({ status: "closed" });
});

app.post("/config/reload", async (req, res) => {
  try {
    CONFIG = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    res.json({ status: "reloaded", config: CONFIG });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

// ---------- STARTUP SCHEDULE ----------
async function bootstrap() {
  await log("BOOT", "SYSTEM", "Starting AlphaStream v29.0");
  try { CONFIG = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")); } catch(e) { fs.writeFileSync(CONFIG_PATH, JSON.stringify(defaultConfig, null,2)); CONFIG = defaultConfig; }
  await updateEquity();
  scheduleNightlyOptimizer();
  // main loops
  setInterval(async ()=>{ try { await runScanAndEnter(); } catch(e){ await log("SCAN_LOOP_ERR","SYSTEM",e?.message||String(e)); } }, 60*1000);
  setInterval(async ()=>{ try { await monitorOpenPositions(); await checkDailyLossAndClose(); } catch(e){ await log("MONITOR_LOOP_ERR","SYSTEM",e?.message||String(e)); } }, 15*1000);
  // minimalist health monitor (persist tradehistory)
  setInterval(()=>{ try { fs.writeFileSync(path.join(process.cwd(),"alphastream29_state.json"), JSON.stringify({ positions, tradeHistory, dailyPnL, accountEquity }, null, 2)); } catch(e){ } }, 30*1000);
}

// start server & bootstrap
app.listen(APP_PORT, "0.0.0.0", async () => {
  console.log(`ALPHASTREAM v29.0 — listening on ${APP_PORT}`);
  await bootstrap();
});
