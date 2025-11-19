// index.js — AlphaStream v29.0 — Ultimate Bot (Pro EMA stack + VWAP + ADX anti-chop)
// Node 18+ recommended. Use DRY_MODE=true for paper runs.

import express from "express";
import fs from "fs";
import path from "path";
import axios from "axios";
import * as ti from "technicalindicators";

const { EMA: TI_EMA, ATR: TI_ATR, ADX: TI_ADX, Supertrend: TI_Supertrend } = ti;

// -------- ENV & CONFIG --------
const {
  ALPACA_KEY = "",
  ALPACA_SECRET = "",
  MASSIVE_KEY = "",
  PREDICTOR_URL = "",
  NEWS_API_URL = "",
  LOG_WEBHOOK_URL = "",
  LOG_WEBHOOK_SECRET = "",
  DRY_MODE = "true",
  MAX_POS = "3",
  TARGET_SYMBOLS = "SPY,QQQ,NVDA,TQQQ",
  SCAN_INTERVAL_MS = "8000",      // global scan throttle (ms)
  PER_SYMBOL_DELAY_MS = "300",    // delay between symbol API calls
  BACKOFF_BASE_MS = "500",        // base backoff for 429
  MAX_BACKOFF_MS = "8000",        // max backoff for 429
  RISK_PER_TRADE = "0.005",       // default 0.5%
  MAX_DAILY_LOSS = "-0.04",       // -4%
  PORT = "8080"
} = process.env;

const DRY = String(DRY_MODE).toLowerCase() !== "false";
const TARGETS = TARGET_SYMBOLS.split(",").map(s => s.trim().toUpperCase());
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
  flat_slope_threshold_pct: 0.0015,  // EMA flat if slope < 0.15% over lookback
  tangled_spread_pct: 0.0025         // EMAs tangled if spread < 0.25%
};
if (!fs.existsSync(CONFIG_PATH)) fs.writeFileSync(CONFIG_PATH, JSON.stringify(defaultConfig, null, 2));
let CONFIG = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));

let accountEquity = 25000;
let positions = {}; // symbol -> {entry, qty, stop, trailStop, peak, atr, took2R, openAt}
let dailyPnL = 0;
let lastResetDate = new Date().toISOString().slice(0,10);
let tradeHistory = []; // recent trades
let lastScanTime = 0;

// simple cache and rate-limit helpers
const cache = new Map();
function cacheSet(key, val, ttlMs=3000) { cache.set(key, { val, exp: Date.now()+ttlMs }); }
function cacheGet(key) { const c = cache.get(key); if (!c) return null; if (Date.now()>c.exp) { cache.delete(key); return null; } return c.val; }
function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

// logging (console + optional webhook)
async function log(ev, sym="", note="", data={}) {
  try {
    console.log(`[${ev}] ${sym} | ${note}`, data);
    if (LOG_WEBHOOK_URL && LOG_WEBHOOK_SECRET) {
      await axios.post(LOG_WEBHOOK_URL, { secret: LOG_WEBHOOK_SECRET, event: ev, symbol: sym, note, data }, { timeout: 4000 });
    }
  } catch (e) {
    console.warn("LOG_FAIL", e?.message || e);
  }
}

function resetDailyIfNeeded(){
  const today = new Date().toISOString().slice(0,10);
  if (today !== lastResetDate) { dailyPnL = 0; lastResetDate = today; log("DAILY_RESET","SYSTEM","Daily reset"); }
}
function recordPnL(exit, entry) { const pnl = (exit - entry) / entry; dailyPnL += pnl; return pnl; }

// fetch equity once per scan
async function updateEquity(){
  if (!ALPACA_KEY || !ALPACA_SECRET) { await log("EQUITY","SYSTEM","No Alpaca keys - fallback"); return; }
  try {
    const res = await axios.get(`${A_BASE}/account`, { headers, timeout: 8000 });
    accountEquity = parseFloat(res?.data?.equity || res?.data?.cash || accountEquity);
    await log("EQUITY","SYSTEM",`$${Number(accountEquity).toLocaleString()}`);
  } catch (e) {
    await log("EQUITY_FAIL","SYSTEM", e?.message || String(e));
  }
}

// fetch minute bars using Massive; with caching and 429 backoff
async function fetchMinuteBars(symbol, limit=500) {
  const key = `bars:${symbol}:${limit}`;
  const cached = cacheGet(key);
  if (cached) return cached;
  let backoff = parseInt(BACKOFF_BASE_MS,10);
  while (true) {
    try {
      const from = new Date(Date.now() - 7*24*60*60*1000).toISOString().slice(0,10);
      const to = new Date().toISOString().slice(0,10);
      const url = `${M_BASE}/v2/aggs/ticker/${symbol}/range/1/minute/${from}/${to}?limit=${limit}&apiKey=${MASSIVE_KEY}`;
      const res = await axios.get(url, { timeout: 10000 });
      const bars = res?.data?.results || [];
      cacheSet(key, bars, 3000);
      return bars;
    } catch (e) {
      const code = e?.response?.status;
      if (code === 429) {
        await log("RATE_LIMIT", symbol, `429 - backing off ${backoff}ms`);
        await sleep(backoff);
        backoff = Math.min(backoff * 2, parseInt(MAX_BACKOFF_MS || "8000",10));
        continue;
      } else {
        await log("BARS_FAIL", symbol, e?.message || String(e));
        return [];
      }
    }
  }
}

// aggregate minute bars to N-minute bars
function aggregateBars(minuteBars, period) {
  if (!minuteBars || minuteBars.length === 0) return [];
  const out = [];
  // minuteBars newest last; ensure chronological
  for (let i = 0; i + period <= minuteBars.length; i += period) {
    const slice = minuteBars.slice(i, i+period);
    if (slice.length < period) continue;
    const o = slice[0].o, c = slice[slice.length-1].c;
    const h = Math.max(...slice.map(x=>x.h)), l = Math.min(...slice.map(x=>x.l));
    const v = slice.reduce((s,x)=>s+(x.v||0), 0);
    out.push({ o, h, l, c, v, t: slice[slice.length-1].t });
  }
  return out;
}

// compute VWAP from minute bars
function computeVWAP(minuteBars) {
  if (!minuteBars || minuteBars.length === 0) return null;
  let cumPV = 0, cumV = 0;
  for (const b of minuteBars) {
    const tp = (b.h + b.l + b.c) / 3;
    cumPV += tp * (b.v || 0);
    cumV += (b.v || 0);
  }
  return cumV === 0 ? null : cumPV / cumV;
}

// detect VWAP rising (simple typical-price increase test)
function isVWAPRising(minuteBars, lookback = 6) {
  if (!minuteBars || minuteBars.length < lookback) return false;
  const seg = minuteBars.slice(-lookback).map(b => (b.h+b.l+b.c)/3);
  return seg[seg.length-1] > seg[0];
}

// EMA helpers — use TI_EMA.calculate
function safeEMA(values, period) {
  try {
    if (!values || values.length < period) return [];
    return TI_EMA.calculate({ period: period, values: values });
  } catch (e) {
    return [];
  }
}

// check EMA flat: slope of EMA9 over N bars small in pct
function isEMAFlat(emaValues, lookback=6, thresholdPct = CONFIG.flat_slope_threshold_pct) {
  if (!emaValues || emaValues.length < lookback+1) return true;
  const last = emaValues[emaValues.length-1];
  const prev = emaValues[emaValues.length-1-lookback];
  if (!prev || prev === 0) return true;
  const slopePct = Math.abs((last - prev) / prev);
  return slopePct < thresholdPct;
}

// check EMAs tangled: small relative spread between EMA9 and EMA21 and EMA21 & EMA200
function areEMAsTangled(emaShort, emaMid, emaLong, thresholdPct = CONFIG.tangled_spread_pct) {
  if (!emaShort.length || !emaMid.length || !emaLong.length) return true;
  const s = emaShort[emaShort.length-1];
  const m = emaMid[emaMid.length-1];
  const l = emaLong[emaLong.length-1];
  if (!s || !m || !l) return true;
  const spread1 = Math.abs((s - m) / m);
  const spread2 = Math.abs((m - l) / l);
  return (spread1 < thresholdPct) || (spread2 < thresholdPct);
}

// ADX check
function getADX(highs, lows, closes, period=14) {
  try {
    const a = TI_ADX({ period, high: highs, low: lows, close: closes });
    return a && a.length ? a[a.length-1].adx : 0;
  } catch (e) { return 0; }
}

// determine if entry conditions are satisfied for a symbol
async function evaluateForEntry(symbol) {
  // throttle symbol calls
  await sleep(parseInt(PER_SYMBOL_DELAY_MS || "300",10));

  const minuteBars = await fetchMinuteBars(symbol, 600); // last ~600 minutes
  if (!minuteBars || minuteBars.length < 120) return null;

  // recent minute slices
  const vwapMinutes = parseInt(CONFIG.vwap_lookback_minutes || 60, 10);
  const recentMinutes = minuteBars.slice(-vwapMinutes);
  const vwap = computeVWAP(recentMinutes);
  if (!vwap) return null;
  const lastPrice = recentMinutes[recentMinutes.length-1].c;
  if (lastPrice <= vwap) { await log("VWAP_FAIL", symbol, `price ${lastPrice} <= vwap ${vwap}`); return null; }
  if (!isVWAPRising(recentMinutes, 6)) { await log("VWAP_NOT_RISE", symbol, "VWAP not rising"); return null; }

  // aggregate to confirm timeframe (5-min) and trend timeframe (15-min)
  const confirm = aggregateBars(minuteBars.slice(-300), CONFIG.timeframe_confirm_minutes || 5);
  const trend = aggregateBars(minuteBars.slice(-600), CONFIG.timeframe_trend_minutes || 15);
  if (confirm.length < 20 || trend.length < 10) return null;

  // build close arrays for EMA and indicators (confirm timeframe)
  const closesConfirm = confirm.map(b => b.c);
  const highsConfirm = confirm.map(b => b.h);
  const lowsConfirm = confirm.map(b => b.l);

  // EMA arrays for confirm timeframe: use closing prices (5-min)
  const emaShort = safeEMA(closesConfirm, CONFIG.ema_short || 9);    // EMA9
  const emaMid = safeEMA(closesConfirm, CONFIG.ema_mid || 21);       // EMA21

  // EMA200 should be computed on longer series — use trend timeframe closes
  const closesTrend = trend.map(b => b.c);
  const emaLong = safeEMA(closesTrend, CONFIG.ema_long || 200); // EMA200 on 15-min bars
  // if we can't compute EMA200 (not enough bars), fallback to skipping trade
  if (!emaShort.length || !emaMid.length || !emaLong.length) return null;

  // flat/tangled checks
  if (isEMAFlat(emaShort, 6, CONFIG.flat_slope_threshold_pct)) { await log("EMA_FLAT", symbol, "EMA short is flat"); return null; }
  if (areEMAsTangled(emaShort, emaMid, emaLong, CONFIG.tangled_spread_pct)) { await log("EMA_TANGLED", symbol, "EMAs tangled"); return null; }

  // require EMA9 > EMA21 > EMA200 (stack)
  const lastEma9 = emaShort[emaShort.length-1];
  const lastEma21 = emaMid[emaMid.length-1];
  const lastEma200 = emaLong[emaLong.length-1];
  if (!(lastEma9 > lastEma21 && lastEma21 > lastEma200)) { await log("EMA_STACK_FAIL", symbol, `E9:${lastEma9} E21:${lastEma21} E200:${lastEma200}`); return null; }

  // ADX on confirm timeframe
  const adxVal = getADX(highsConfirm, lowsConfirm, closesConfirm, 14);
  if (adxVal < CONFIG.adx_thresh) { await log("ADX_FAIL", symbol, `ADX ${adxVal} < ${CONFIG.adx_thresh}`); return null; }

  // compute ATR on confirm timeframe for sizing
  const atrArr = TI_ATR({ period: 14, high: highsConfirm, low: lowsConfirm, close: closesConfirm });
  const atrVal = atrArr && atrArr.length ? atrArr[atrArr.length-1] : (Math.max(...highsConfirm) - Math.min(...lowsConfirm));

  // optional news/predictor gates
  if (NEWS_API_URL) {
    try {
      const newsRes = await axios.get(`${NEWS_API_URL}?q=${encodeURIComponent(symbol)}&minutes=60`, { timeout: 2500 });
      const articles = newsRes?.data?.articles || [];
      if (articles.length === 0) { await log("NEWS_FAIL", symbol, "no recent news"); return null; }
    } catch (e) {
      await log("NEWS_CHECK_FAIL", symbol, e?.message || String(e));
      // non-blocking: allow if news fails
    }
  }
  if (PREDICTOR_URL) {
    try {
      const pred = await axios.post(`${PREDICTOR_URL}/predict`, { symbol, features: { vwapDistPct: (lastPrice - vwap)/vwap, adx: adxVal, atr: atrVal } }, { timeout: 3000 });
      const prob = pred?.data?.probability || pred?.data?.prob || 0;
      if (prob < 0.62) { await log("PRED_FAIL", symbol, `prob ${prob}`); return null; }
    } catch (e) {
      await log("PRED_ERR", symbol, e?.message || String(e));
      // non-blocking fallback allow
    }
  }

  return {
    symbol,
    price: lastPrice,
    vwap,
    adx: adxVal,
    atr: atrVal,
    ema9: lastEma9,
    ema21: lastEma21,
    ema200: lastEma200
  };
}

// compute quantity given entry price and atr
function computeQty(entry, atr) {
  const baseRisk = parseFloat(RISK_PER_TRADE) || 0.005;
  // performance modifier (simple)
  const last5 = tradeHistory.slice(-5);
  const wins = last5.filter(t=>t.pnl > 0).length;
  let perf = 1.0;
  if (last5.length >= 3) {
    if (wins >= 4) perf = 1.3;
    else if (wins >= 3) perf = 1.1;
    else if (wins <= 1) perf = 0.8;
  }
  // volatility modifier (smaller ATR -> larger size within bounds)
  const volMod = Math.max(0.6, Math.min(1.6, 1.0 / Math.max(0.2, atr)));
  const riskPct = Math.max(0.0005, Math.min(0.02, baseRisk * perf * volMod));
  const riskAmt = accountEquity * riskPct;
  const stopDistance = atr * CONFIG.atr_stop_mult;
  const qty = Math.max(1, Math.floor(riskAmt / stopDistance));
  // cap per symbol (25% of equity)
  const maxByCap = Math.max(1, Math.floor((accountEquity * 0.25) / Math.max(1, entry)));
  return Math.min(qty, maxByCap);
}

// place order wrapper (market)
async function placeOrder(sym, qty, side) {
  if (DRY) {
    await log("DRY_ORDER", sym, `${side} ${qty}`);
    return { dry: true };
  }
  try {
    const res = await axios.post(`${A_BASE}/orders`, { symbol: sym, qty, side, type: "market", time_in_force: "day", extended_hours: false }, { headers, timeout: 8000 });
    await log("LIVE_ORDER", sym, `${side} ${qty}`, res.data);
    return res.data;
  } catch (e) {
    await log("ORDER_FAIL", sym, e?.response?.data?.message || e?.message || String(e));
    return null;
  }
}

// entry scanning loop
async function scanLoop() {
  const now = Date.now();
  const throttle = parseInt(SCAN_INTERVAL_MS || "8000",10);
  if (now - lastScanTime < throttle) return;
  lastScanTime = now;
  resetDailyIfNeeded();
  await updateEquity();

  // check daily loss
  if (dailyPnL <= parseFloat(MAX_DAILY_LOSS || "-0.04")) {
    await log("DAILY_STOP","SYSTEM","Daily loss limit hit, skipping new entries");
    return;
  }

  await log("SCAN_START","SYSTEM",`scanning ${TARGETS.join(", ")}`, { equity: accountEquity });
  for (const sym of TARGETS) {
    if (Object.keys(positions).length >= parseInt(MAX_POS || "3", 10)) break;
    try {
      const pick = await evaluateForEntry(sym);
      if (!pick) continue;
      const qty = computeQty(pick.price, pick.atr);
      if (!qty || qty <= 0) continue;

      await placeOrder(sym, qty, "buy");
      const stop = pick.price - pick.atr * CONFIG.atr_stop_mult;
      positions[sym] = { entry: pick.price, qty, stop, trailStop: stop, peak: pick.price, atr: pick.atr, took2R: false, openAt: new Date().toISOString() };
      await log("ENTRY", sym, `entry ${pick.price} qty ${qty} stop ${stop.toFixed(2)} atr ${pick.atr.toFixed(4)}`, { pick });

    } catch (e) {
      await log("SCAN_ERR", sym, e?.message || String(e));
    }
    // per-symbol delay to avoid rate-limits
    await sleep(parseInt(PER_SYMBOL_DELAY_MS || "300",10));
  }
}

// monitor open positions for trailing stop / partials
async function monitorLoop() {
  for (const sym of Object.keys(positions)) {
    const pos = positions[sym];
    try {
      // get latest bid
      let bid = pos.entry;
      try {
        const q = await axios.get(`${A_BASE}/stocks/${sym}/quote`, { headers, timeout: 4000 });
        bid = q?.data?.quote?.bp || bid;
      } catch (e) {
        // fallback: ignore
      }

      if (bid > pos.peak) pos.peak = bid;
      const newTrail = pos.peak - pos.atr * (CONFIG.atr_trail_mult || 1.5);
      if (newTrail > pos.trailStop) pos.trailStop = newTrail;

      // partial at 2R
      const twoR = pos.entry + 2 * (pos.entry - pos.stop);
      if (!pos.took2R && bid >= twoR) {
        const half = Math.floor(pos.qty * 0.5);
        if (half > 0) {
          await placeOrder(sym, half, "sell");
          pos.qty -= half;
          pos.took2R = true;
          await log("PARTIAL_2R", sym, `50% sold at ${bid.toFixed(2)}`);
        }
      }

      // trail hit
      if (bid <= pos.trailStop) {
        await placeOrder(sym, pos.qty, "sell");
        const pnl = recordPnL(bid, pos.entry);
        tradeHistory.push({ symbol: sym, entry: pos.entry, exit: bid, pnl, date: new Date().toISOString() });
        await log("TRAIL_EXIT", sym, `exit ${bid.toFixed(2)} pnl ${(pnl*100).toFixed(2)}%`);
        delete positions[sym];
      }
    } catch (e) {
      await log("MONITOR_ERR", sym, e?.message || String(e));
    }
  }
}

// close all positions
async function closeAll(reason="manual") {
  await log("CLOSE_ALL","SYSTEM",reason);
  for (const sym of Object.keys(positions)) {
    const pos = positions[sym];
    if (pos && pos.qty > 0) await placeOrder(sym, pos.qty, "sell");
    delete positions[sym];
  }
}

// periodic state flush
function persistState() {
  try {
    fs.writeFileSync(path.join(process.cwd(),"alphastream29_state.json"), JSON.stringify({ positions, tradeHistory, dailyPnL, accountEquity }, null, 2));
  } catch (e) { /* ignore */ }
}

// HTTP endpoints
const app = express();
app.use(express.json());
app.get("/", (_, res) => res.json({ bot: "AlphaStream v29.0 Ultimate", config: CONFIG, equity: accountEquity, positions: Object.keys(positions).length, dailyPnL }));
app.get("/healthz", (_, res) => res.status(200).send("OK"));
app.post("/scan", async (req, res) => { runSafe(scanLoop); res.json({ status: "scan_started" }); });
app.post("/close", async (req, res) => { await closeAll("api_close"); res.json({ status: "closed" }); });

// helper to run loops safely
async function runSafe(fn) { try { await fn(); } catch (e) { await log("LOOP_ERR","SYSTEM", e?.message || String(e)); } }

// bootstrap & main timers
async function bootstrap() {
  await log("BOOT","SYSTEM","AlphaStream v29.0 starting");
  try { CONFIG = JSON.parse(fs.readFileSync(CONFIG_PATH,"utf8")); } catch (e) { fs.writeFileSync(CONFIG_PATH, JSON.stringify(defaultConfig,null,2)); CONFIG = defaultConfig; }
  await updateEquity();
  // main loops
  setInterval(() => runSafe(scanLoop), Math.max(1000, parseInt(SCAN_INTERVAL_MS || "8000",10)));
  setInterval(() => runSafe(monitorLoop), 15000);
  setInterval(() => { resetDailyIfNeeded(); persistState(); }, 30000);
}

// start server
const PORT_NUM = parseInt(PORT || "8080",10);
app.listen(PORT_NUM, "0.0.0.0", async () => { console.log("AlphaStream v29.0 listening on", PORT_NUM); await bootstrap(); });
