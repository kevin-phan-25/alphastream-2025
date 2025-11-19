// index.js — AlphaStream v28.0 — Large-Cap Edition (2025)
// - 5-min trend continuation on SPY/QQQ/NVDA/TQQQ
// - VWAP + EMA + ADX + Supertrend confirmation
// - ATR-based sizing, trailing stop, 50% partial at 2R
// - Safe, deploy-ready (ESM)

import express from "express";
import axios from "axios";
import * as ti from "technicalindicators";

const { Supertrend: TI_Supertrend, ADX: TI_ADX, ATR: TI_ATR, EMA: TI_EMA } = ti;

const app = express();
app.use(express.json());

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
  MASSIVE_KEY = "",
  NEWS_API_URL = "",       // optional news provider base URL (GET /news?q=SYMBOL&minutes=60)
  LOG_WEBHOOK_URL = "",
  LOG_WEBHOOK_SECRET = "",
  MAX_POS = "3",
  DRY_MODE = "true",      // default true — set to "false" for live
  RISK_PER_TRADE = "0.005" // default 0.5% per trade (tighter sizing for large-caps)
} = process.env;

const DRY = String(DRY_MODE).toLowerCase() !== "false";
const RISK_PCT = parseFloat(RISK_PER_TRADE) || 0.005;
const A_BASE = "https://paper-api.alpaca.markets/v2";
const M_BASE = "https://api.massive.com";
const headers = { "APCA-API-KEY-ID": ALPACA_KEY, "APCA-API-SECRET-KEY": ALPACA_SECRET };

let accountEquity = 25000; // fallback
let positions = {}; // symbol -> { entry, qty, stop, trailStop, peak, atr, took2R, openAt }
let dailyPnL = 0;
let lastResetDate = new Date().toISOString().slice(0, 10);
let scanning = false;

// CONFIG: trading window (ET) 9:45 - 11:30 (user local = America/New_York)
// convert to UTC: ET = UTC-5 or UTC-4 depending on DST; to keep it simple we use fixed UTC window that matches standard EST practice.
// We'll allow override via env: ENTRY_START_UTC and ENTRY_END_UTC (in 24h hours, e.g., "14:45" "16:30")
const ENTRY_START_UTC = process.env.ENTRY_START_UTC || "14:45"; // default 9:45 ET (approx)
const ENTRY_END_UTC = process.env.ENTRY_END_UTC || "16:30";     // default 11:30 ET (approx)

const TARGET_SYMBOLS = (process.env.TARGET_SYMBOLS || "SPY,QQQ,NVDA,TQQQ").split(",").map(s => s.trim().toUpperCase());
const SCAN_INTERVAL_MS = parseInt(process.env.SCAN_INTERVAL_MS || "60000"); // 60s
const MONITOR_INTERVAL_MS = parseInt(process.env.MONITOR_INTERVAL_MS || "15000"); // 15s
const EXIT_INTERVAL_MS = parseInt(process.env.EXIT_INTERVAL_MS || "60000"); // 60s

const MAX_DAILY_LOSS = parseFloat(process.env.MAX_DAILY_LOSS || "-0.04"); // -4% default

// Helpers
async function log(event, symbol = "", note = "", data = {}) {
  try {
    console.log(`[${event}] ${symbol} | ${note}`, data || "");
    if (LOG_WEBHOOK_URL && LOG_WEBHOOK_SECRET) {
      await axios.post(LOG_WEBHOOK_URL, { secret: LOG_WEBHOOK_SECRET, event, symbol, note, data }, { timeout: 5000 });
    }
  } catch (e) {
    console.warn("LOG_FAIL", e?.message || e);
  }
}

function parseHHMM(hhmm) {
  const [h, m] = hhmm.split(":").map(x => parseInt(x, 10));
  return { h, m };
}

function utcTimeToComparable() {
  const now = new Date();
  return now.getUTCHours() * 100 + now.getUTCMinutes();
}

function hhmmToComparable(hhmm) {
  const { h, m } = parseHHMM(hhmm);
  return h * 100 + m;
}

function resetDailyPnLIfNeeded() {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== lastResetDate) {
    dailyPnL = 0;
    lastResetDate = today;
    log("DAILY_RESET", "SYSTEM", "Daily PnL reset");
  }
}

function recordPnL(exitPrice, entry) {
  const pnl = (exitPrice - entry) / entry;
  dailyPnL += pnl;
  return pnl;
}

async function updateEquity() {
  if (!ALPACA_KEY || !ALPACA_SECRET) {
    await log("EQUITY", "SYSTEM", "No Alpaca creds provided. Using fallback equity.", { accountEquity });
    return;
  }
  try {
    const res = await axios.get(`${A_BASE}/account`, { headers, timeout: 8000 });
    accountEquity = parseFloat(res?.data?.equity || res?.data?.cash || accountEquity);
    await log("EQUITY", "SYSTEM", `$${Number(accountEquity).toLocaleString()}`);
  } catch (e) {
    await log("EQUITY_FAIL", "SYSTEM", "Using fallback equity", { err: e?.message || String(e) });
  }
}

// Place order (market). In DRY mode we only log.
async function placeOrder(sym, qty, side) {
  if (DRY) {
    await log("DRY_ORDER", sym, `${side.toUpperCase()} ${qty}`);
    return { success: true };
  }
  try {
    const res = await axios.post(`${A_BASE}/orders`, {
      symbol: sym, qty, side, type: "market", time_in_force: "day", extended_hours: false
    }, { headers, timeout: 8000 });
    await log("LIVE_ORDER", sym, `${side.toUpperCase()} ${qty}`, res.data || {});
    return res.data;
  } catch (e) {
    await log("ORDER_FAIL", sym, e?.response?.data?.message || e?.message || String(e));
    return null;
  }
}

// VWAP from minute bars: bars = [{ t, o, h, l, c, v }, ... ] most recent last
function computeVWAP(bars) {
  let cumPV = 0;
  let cumV = 0;
  for (const b of bars) {
    const tp = (b.h + b.l + b.c) / 3;
    cumPV += tp * b.v;
    cumV += b.v;
  }
  if (cumV === 0) return null;
  return cumPV / cumV;
}

// Check VWAP trend (is VWAP rising over last N bars)
function isVWAPRising(bars, lookback = 6) {
  if (!bars || bars.length < lookback) return false;
  const segments = [];
  for (let i = bars.length - lookback; i < bars.length; i++) {
    segments.push((bars[i].h + bars[i].l + bars[i].c) / 3);
  }
  // simple monotonic check of VWAP-ish moving typical price
  return segments[segments.length - 1] > segments[0];
}

// Get 5-min aggregated bars via Massive (or fallback)
async function fetchMinuteBars(symbol, minutes = 60) {
  // returns last N minute bars (most recent last)
  try {
    // get last 6 hours window to be safe
    const from = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const to = new Date().toISOString().slice(0, 10);
    const url = `${M_BASE}/v2/aggs/ticker/${symbol}/range/1/minute/${from}/${to}?limit=500&apiKey=${MASSIVE_KEY}`;
    const res = await axios.get(url, { timeout: 10000 });
    const bars = res?.data?.results || [];
    return bars;
  } catch (e) {
    await log("BARS_FETCH_FAIL", symbol, e?.message || String(e));
    return [];
  }
}

// Aggregate minute bars into N-minute bars (e.g., 5-min)
function aggregateBars(minutes, minuteBars) {
  if (!minuteBars || minuteBars.length === 0) return [];
  const result = [];
  // minuteBars assumed chronological
  for (let i = 0; i < minuteBars.length; i += minutes) {
    const slice = minuteBars.slice(i, i + minutes);
    if (slice.length < minutes) continue;
    const o = slice[0].o;
    const c = slice[slice.length - 1].c;
    const h = Math.max(...slice.map(x => x.h));
    const l = Math.min(...slice.map(x => x.l));
    const v = slice.reduce((s, x) => s + (x.v || 0), 0);
    result.push({ o, h, l, c, v, t: slice[slice.length - 1].t });
  }
  return result;
}

// News filter: checks for any fresh positive news in last X minutes. Optional; non-blocking.
async function hasFreshPositiveNews(symbol, minutes = 60) {
  if (!NEWS_API_URL) return true; // allow if news service not provided
  try {
    const url = `${NEWS_API_URL}?q=${encodeURIComponent(symbol)}&minutes=${minutes}`;
    const res = await axios.get(url, { timeout: 3000 });
    const articles = res?.data?.articles || [];
    // basic heuristic: presence of any article => positive gate (you can improve NLP scoring)
    return articles.length > 0;
  } catch (e) {
    // non-blocking: if news fails, allow trade but log
    await log("NEWS_FAIL", symbol, e?.message || String(e));
    return true;
  }
}

// Indicator checks & entry logic
async function evaluateSymbol(symbol) {
  // load minute bars
  const minuteBars = await fetchMinuteBars(symbol);
  if (!minuteBars || minuteBars.length < 60) return null;

  // build 5-minute bars (aggregate last 60 minutes)
  const reversed = minuteBars.slice(-120); // last ~2 hours
  // ensure chronological
  const fiveBars = aggregateBars(5, reversed);
  if (fiveBars.length < 12) return null; // need at least 12 5-min bars (1 hour)

  // compute VWAP from minute bars (session VWAP over last N minutes)
  const recentMinutes = minuteBars.slice(-60); // last 60 minutes
  const vwap = computeVWAP(recentMinutes);
  if (!vwap) return null;

  // ensure price above VWAP
  const lastPrice = recentMinutes[recentMinutes.length - 1].c;
  if (lastPrice <= vwap) return null;

  // check VWAP rising
  if (!isVWAPRising(recentMinutes, 6)) return null;

  // compute EMA9 and EMA21 on 5-min close
  const closes5 = fiveBars.map(b => b.c);
  const ema9 = TI_EMA({ period: 9, values: closes5 });
  const ema21 = TI_EMA({ period: 21, values: closes5 });
  const ema9Last = ema9[ema9.length - 1];
  const ema21Last = ema21[ema21.length - 1];
  if (!ema9Last || !ema21Last) return null;
  if (ema9Last <= ema21Last) return null; // require short EMA above long EMA

  // ADX on 5-min bars
  const highs = fiveBars.map(b => b.h);
  const lows = fiveBars.map(b => b.l);
  const adxData = TI_ADX({ period: 14, high: highs, low: lows, close: closes5 });
  const adxLast = adxData[adxData.length - 1] ? adxData[adxData.length - 1].adx : 0;
  if (adxLast <= 25) return null;

  // Supertrend optional confirmation
  let supertrendTrend = null;
  try {
    const st = TI_Supertrend({ period: 10, multiplier: 3, high: highs, low: lows, close: closes5 });
    supertrendTrend = st[st.length - 1] ? st[st.length - 1].trend : null;
  } catch (e) {
    // not fatal — allow trade without ST if TI fails
    await log("ST_FAIL", symbol, e?.message || String(e));
  }
  if (supertrendTrend !== null && supertrendTrend !== 1) return null; // if available, require uptrend

  // ATR for stop sizing (use 14-period ATR on 5-min)
  const atrData = TI_ATR({ period: 14, high: highs, low: lows, close: closes5 });
  const atrLast = atrData[atrData.length - 1] || (Math.max(...highs) - Math.min(...lows));

  // news gate (optional)
  const freshNews = await hasFreshPositiveNews(symbol, 60);
  if (!freshNews) return null;

  const info = {
    symbol,
    price: lastPrice,
    vwap,
    ema9: ema9Last,
    ema21: ema21Last,
    adx: adxLast,
    atr: atrLast
  };
  return info;
}

// scanning loop
async function scanForEntries() {
  if (scanning) return;
  scanning = true;
  resetDailyPnLIfNeeded();
  await updateEquity();

  // check time window
  const nowComp = utcTimeToComparable();
  const startComp = hhmmToComparable(ENTRY_START_UTC);
  const endComp = hhmmToComparable(ENTRY_END_UTC);
  if (nowComp < startComp || nowComp > endComp) {
    scanning = false;
    return;
  }

  await log("SCAN_START", "SYSTEM", `Scanning targets: ${TARGET_SYMBOLS.join(", ")}`, { equity: accountEquity });

  for (const sym of TARGET_SYMBOLS) {
    try {
      // skip if already have position
      if (Object.keys(positions).length >= parseInt(MAX_POS, 10)) break;
      if (positions[sym]) continue;

      const info = await evaluateSymbol(sym);
      if (!info) continue;

      // sizing: risk amount = accountEquity * RISK_PCT; stop distance = 2 * ATR (configurable)
      const stopDistance = info.atr * 2;
      if (stopDistance <= 0) continue;
      const riskAmount = accountEquity * RISK_PCT;
      const qty = Math.max(1, Math.floor(riskAmount / stopDistance));

      // place buy
      await placeOrder(sym, qty, "buy");

      const entry = info.price;
      const stop = entry - stopDistance;
      positions[sym] = {
        entry,
        qty,
        stop,
        trailStop: stop,
        peak: entry,
        atr: info.atr,
        took2R: false,
        openAt: new Date().toISOString()
      };

      await log("ENTRY", sym, `Entry ${entry} qty ${qty} stop ${stop.toFixed(2)} atr ${info.atr.toFixed(4)}`, { info });
    } catch (e) {
      await log("SCAN_ERROR", "SYSTEM", e?.message || String(e));
    }
  }

  scanning = false;
}

// monitor positions: trailing, partial at 2R, exit at daily loss or session end
async function monitorPositions() {
  for (const sym of Object.keys(positions)) {
    const pos = positions[sym];
    try {
      // fetch latest quote from Alpaca (or Massive snapshot if you prefer)
      let bid = pos.entry;
      if (ALPACA_KEY && ALPACA_SECRET) {
        try {
          const q = await axios.get(`${A_BASE}/stocks/${sym}/quote`, { headers, timeout: 5000 });
          if (q?.data?.quote?.bp) bid = q.data.quote.bp;
        } catch (e) {
          // ignore quote failure
        }
      } else {
        // fallback to Massive last trade snapshot
        try {
          const s = await axios.get(`${M_BASE}/v2/snapshot/locale/us/markets/stocks/tickers?apiKey=${MASSIVE_KEY}`, { timeout: 5000 });
          // searching result expensive; skip fallback to keep monitors light in public version
        } catch (e) {}
      }

      // update peak and trailing
      if (bid > pos.peak) pos.peak = bid;
      const newTrail = pos.peak - pos.atr * 1.5;
      if (newTrail > pos.trailStop) pos.trailStop = newTrail;

      // partial at 2R
      const twoRlevel = pos.entry + 2 * (pos.entry - pos.stop);
      if (!pos.took2R && bid >= twoRlevel) {
        const half = Math.floor(pos.qty * 0.5);
        if (half > 0) {
          await placeOrder(sym, half, "sell");
          pos.qty -= half;
          pos.took2R = true;
          await log("PARTIAL_2R", sym, `Took 50% at ${bid.toFixed(2)}`);
        }
      }

      // trail stop
      if (bid <= pos.trailStop) {
        await placeOrder(sym, pos.qty, "sell");
        const pnl = recordPnL(bid, pos.entry);
        await log("TRAIL_EXIT", sym, `Exit ${bid.toFixed(2)} PnL ${(pnl*100).toFixed(2)}%`);
        delete positions[sym];
      }
    } catch (e) {
      await log("MONITOR_ERR", sym, e?.message || String(e));
    }
  }
}

// exit rules: daily loss or session end (close positions)
async function exitAtSessionEndOrLoss() {
  // daily loss
  if (dailyPnL <= MAX_DAILY_LOSS && Object.keys(positions).length > 0) {
    await log("DAILY_LOSS_STOP", "SYSTEM", `Daily loss ${ (dailyPnL * 100).toFixed(2) }% reached; closing all`);
    for (const sym of Object.keys(positions)) {
      await placeOrder(sym, positions[sym].qty, "sell");
      delete positions[sym];
    }
    return;
  }

  // session end window: convert ENTRY_END_UTC into comparable and check after end minute
  const nowComp = utcTimeToComparable();
  const endComp = hhmmToComparable(ENTRY_END_UTC);
  if (nowComp > endComp && Object.keys(positions).length > 0) {
    await log("SESSION_CLOSE", "SYSTEM", "Session ended - closing all");
    for (const sym of Object.keys(positions)) {
      await placeOrder(sym, positions[sym].qty, "sell");
      delete positions[sym];
    }
  }
}

// HTTP endpoints
app.get("/", (_, res) => {
  res.json({
    bot: "AlphaStream v28.0 — Large-Cap Edition",
    symbols: TARGET_SYMBOLS,
    equity: `$${Number(accountEquity).toLocaleString()}`,
    positions: Object.keys(positions).length,
    dailyPnL: `${(dailyPnL*100).toFixed(2)}%`,
    dryMode: DRY,
    scanIntervalMs: SCAN_INTERVAL_MS
  });
});
app.get("/healthz", (_, res) => res.status(200).send("OK"));

app.post("/scan", async (req, res) => {
  await log("MANUAL_SCAN", "SYSTEM", "Triggered via API");
  scanForEntries();
  res.json({ status: "scan_started" });
});

// boot
const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", async () => {
  console.log("ALPHASTREAM v28.0 Large-Cap — LIVE on port", PORT);
  await log("BOT_START", "SYSTEM", "v28.0 Large-Cap Edition", { dry: DRY });
  await updateEquity();
  scanForEntries();
  setInterval(scanForEntries, SCAN_INTERVAL_MS);
  setInterval(monitorPositions, MONITOR_INTERVAL_MS);
  setInterval(exitAtSessionEndOrLoss, EXIT_INTERVAL_MS);
});
