// index.js — AlphaStream v23.3 Cloud Run service (v23.2 + Pre-market scan & candidate logging)
import express from "express";
import axios from "axios";

const app = express();
app.use(express.json());

// Env vars
const A_KEY = process.env.ALPACA_KEY;
const A_SEC = process.env.ALPACA_SECRET;
const MASSIVE_KEY = process.env.MASSIVE_KEY;
const LOG_WEBHOOK_URL = process.env.LOG_WEBHOOK_URL;
const LOG_WEBHOOK_SECRET = process.env.LOG_WEBHOOK_SECRET || '';
const FORWARD_SECRET = process.env.FORWARD_SECRET || '';
const MAX_POS = parseInt(process.env.MAX_POS || "2", 10);
const SCAN_INTERVAL_MS = parseInt(process.env.SCAN_INTERVAL_MS || "20000", 10);

// In-memory positions, cache, and tracking
let positions = {};
let barCache = {};
let tradeHistory = []; // For dynamic ML threshold
let premarketCandidates = []; // last premarket run

// Logger
async function logToGAS(event, symbol = "", note = "", data = {}) {
  if (!LOG_WEBHOOK_URL) return console.log(`[LOG] ${event} | ${symbol} | ${note}`, data);
  try {
    await axios.post(LOG_WEBHOOK_URL, {
      secret: LOG_WEBHOOK_SECRET,
      event,
      symbol,
      note,
      data
    }, { timeout: 3000 });
  } catch (e) {
    console.error("logToGAS failed:", e.message);
  }
}

// Alpaca & Massive
const ALPACA_BASE = "https://paper-api.alpaca.markets/v2";
const MASSIVE_BASE = "https://api.massive.com";
const alpacaHeaders = () => ({ "APCA-API-KEY-ID": A_KEY, "APCA-API-SECRET-KEY": A_SEC });

// Safe network calls
async function safeGet(url, opts = {}, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try { return (await axios.get(url, opts)).data; }
    catch (e) { if (i === retries) throw e; await new Promise(r => setTimeout(r, 300 * (i + 1))); }
  }
}
async function safePost(url, payload, headers, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try { return await axios.post(url, payload, { headers }); }
    catch (e) { if (i === retries) throw e; await new Promise(r => setTimeout(r, 300 * (i + 1))); }
  }
}

// Equity & positions
async function getEquity() { const r = await safeGet(`${ALPACA_BASE}/account`, { headers: alpacaHeaders() }); return parseFloat(r.equity || 25000); }
async function getOpenPositions() { return await safeGet(`${ALPACA_BASE}/positions`, { headers: alpacaHeaders() }); }

// ML model and dynamic threshold
let ML_WEIGHTS = { w: [1.3, 0.9, 0.7, 1.5, 2.3], b: -2.4 };
function mlPredict(features) { let z = ML_WEIGHTS.b; for (let i = 0; i < Math.min(features.length, ML_WEIGHTS.w.length); i++) z += features[i] * ML_WEIGHTS.w[i]; return 1 / (1 + Math.exp(-z)); }
function getMLThreshold() {
  if (tradeHistory.length < 5) return 0.73;
  const wins = tradeHistory.slice(-20).filter(t => t.pnl > 0).length;
  return Math.min(0.85, Math.max(0.65, 0.65 + (wins / 20) * 0.2));
}

// Bars, VWAP, ATR
async function getBars(sym, fromDays = 3) {
  const now = Date.now();
  const cached = barCache[sym];
  if (cached && now - cached.lastFetch < 60000) return cached.bars;
  const today = new Date().toISOString().split('T')[0];
  const from = new Date(); from.setDate(from.getDate() - fromDays);
  const fromStr = from.toISOString().split('T')[0];
  const data = await safeGet(`${MASSIVE_BASE}/v2/aggs/ticker/${sym}/range/1/minute/${fromStr}/${today}?adjusted=true&limit=1000&apiKey=${MASSIVE_KEY}`);
  const bars = data?.results || [];
  barCache[sym] = { bars, lastFetch: now };
  return bars;
}
function calculateVWAP(bars) { if (!bars.length) return null; let vp = 0, v = 0; for (const b of bars) { const t = (b.h + b.l + b.c) / 3; vp += t * (b.v || 0); v += b.v || 0; } return v > 0 ? vp / v : null; }
function calculateATR(bars, period = 14) {
  if (bars.length < period + 1) return 0;
  let trSum = 0;
  // compute ATR using last `period` bars
  for (let i = 1; i <= period; i++) {
    const curr = bars[bars.length - i];
    const prev = bars[bars.length - i - 1];
    const tr = Math.max(curr.h - curr.l, Math.abs(curr.h - prev.c), Math.abs(curr.l - prev.c));
    trSum += tr;
  }
  return trSum / period;
}

// Gappers (parallel snapshots)
async function getEliteGappers(limit = 1000) {
  const data = await safeGet(`${MASSIVE_BASE}/v3/reference/tickers?market=stocks&active=true&limit=${limit}&apiKey=${MASSIVE_KEY}`);
  const results = data?.results || [];
  const snapshots = await Promise.all(results.map(async t => {
    try {
      if (t.type !== 'CS' || !t.ticker) return null;
      const snap = await safeGet(`${MASSIVE_BASE}/v2/snapshot/locale/us/markets/stocks/tickers?tickers=${t.ticker}&apiKey=${MASSIVE_KEY}`);
      return { ...t, snap: snap?.tickers?.[0] };
    } catch { return null; }
  }));

  const out = snapshots.filter(s => s?.snap).map(s => {
    const last = s.snap.lastTrade?.p || s.snap.day?.c || 0;
    const prev = s.snap.prevDay?.c || 0;
    if (!prev || last < 2.5 || last > 20) return null;
    const gap = (last - prev) / prev;
    if (gap < 0.15) return null;
    const rvol = (s.snap.day?.v || 0) / (prev * 100000);
    if ((s.snap.day?.v || 0) < 750000 || rvol < 4) return null;
    if ((s.market_cap || Infinity) > 500000000) return null;
    if ((s.share_class_shares_outstanding || Infinity) > 20000000) return null;
    return { sym: s.ticker, price: last, rvol, gap };
  }).filter(Boolean);

  return out.sort((a, b) => b.rvol - a.rvol).slice(0, 10);
}

// Analyze candidate (used by both premarket and live scan)
async function analyzeCandidate(t) {
  try {
    const bars = await getBars(t.sym, 3);
    if (!bars.length || bars.length < 50) return null;
    const last = bars[bars.length - 1];
    const vwap = calculateVWAP(bars);
    if (!vwap || last.c <= vwap) return null;
    const hod = Math.max(...bars.slice(-20).map(b => b.h));
    if (last.c < hod * 0.995) return null;
    const recentVol = bars.slice(-5).reduce((s, b) => s + (b.v || 0), 0) / 5;
    const avgVol = bars.slice(-30, -5).reduce((s, b) => s + (b.v || 0), 0) / 25 || 1;
    if (recentVol < avgVol * 2) return null;

    const features = [
      last.c / vwap,
      last.v / (bars[bars.length - 2]?.v || 1),
      1, 1,
      (last.c - (bars[bars.length - 2]?.c || last.c)) / last.c
    ];
    const score = mlPredict(features);
    const mlThresh = getMLThreshold();
    if (score < mlThresh) return null;

    const equity = await getEquity();
    const atr = calculateATR(bars);
    const riskPerShare = atr || last.c * 0.04;
    const qty = Math.max(1, Math.floor(equity * 0.015 / riskPerShare));
    return { symbol: t.sym, price: last.c, qty, mlScore: score, atr, features, gap: t.gap, rvol: t.rvol };
  } catch (e) {
    return null;
  }
}

// Place bracket order
async function placeBracketOrder(sig) {
  const payload = {
    symbol: sig.symbol, qty: sig.qty, side: 'buy', type: 'market', time_in_force: 'day', order_class: 'bracket',
    take_profit: { limit_price: parseFloat((sig.price * 1.10).toFixed(2)) },
    stop_loss: { stop_price: parseFloat((sig.price * (1 - (sig.atr ? sig.atr / sig.price : 0.04))).toFixed(2)) }
  };
  try {
    const r = await safePost(`${ALPACA_BASE}/orders`, payload, alpacaHeaders());
    await logToGAS('ENTRY', sig.symbol, `BUY ${sig.qty} @ ${sig.price}`, { ml: sig.mlScore });
    positions[sig.symbol] = { entry: sig.price, qty: sig.qty, trailPrice: sig.price * 0.94, partialDone: false };
    return r.data;
  } catch (e) {
    await logToGAS('ORDER_FAIL', sig.symbol, e.response?.data?.message || e.message);
    return null;
  }
}

// Manage positions
async function managePositions() {
  try {
    const open = await getOpenPositions();
    for (const pos of open) {
      const symbol = pos.symbol;
      const current = parseFloat(pos.current_price || pos.avg_entry_price);
      const entry = parseFloat(pos.avg_entry_price);
      const qty = parseFloat(pos.qty);
      if (!positions[symbol]) positions[symbol] = { entry, qty, trailPrice: entry * 0.94, partialDone: false };

      const bars = await getBars(symbol, 3);
      const atr = calculateATR(bars);
      const partialPct = 0.5;

      if (current >= entry * 1.05 && !positions[symbol].partialDone) {
        await safePost(`${ALPACA_BASE}/orders`, { symbol, qty: Math.floor(qty * partialPct), side: 'sell', type: 'market', time_in_force: 'day' }, alpacaHeaders());
        positions[symbol].partialDone = true;
        await logToGAS('PARTIAL', symbol, `Locked +5% on ${Math.floor(qty * partialPct)} shares`);
      }

      const newTrail = current - (atr || current * 0.04);
      if (newTrail > positions[symbol].trailPrice) positions[symbol].trailPrice = newTrail;

      if (current <= positions[symbol].trailPrice) {
        await safePost(`${ALPACA_BASE}/orders`, { symbol, qty, side: 'sell', type: 'market', time_in_force: 'day' }, alpacaHeaders());
        await logToGAS('EXIT_TRAIL', symbol, `Trailed out @ ${current}`);
        tradeHistory.push({ symbol, pnl: current - entry, time: Date.now() });
        delete positions[symbol];
      }
    }
  } catch (e) {
    console.error('managePositions error', e.message);
  }
}

// Scan handler (live market)
let isScanning = false;
async function scanHandler() {
  if (isScanning) return;
  isScanning = true;
  try {
    const d = new Date(); const hours = d.getUTCHours();
    // Market hours (approx): 13:30 - 20:00 UTC
    if (hours < 13 || hours >= 20) { isScanning = false; return; }
    await managePositions();
    if (Object.keys(positions).length >= MAX_POS) { isScanning = false; return; }

    const gappers = await getEliteGappers();
    for (const t of gappers) {
      if (Object.keys(positions).length >= MAX_POS) break;
      const sig = await analyzeCandidate(t);
      if (sig) await placeBracketOrder(sig);
    }
  } catch (e) {
    console.error('scan error', e.message);
    await logToGAS('SCAN_ERROR', 'SYSTEM', e.message);
  } finally {
    isScanning = false;
  }
}

// -------------------- PRE-MARKET SCAN + SCHEDULER --------------------
/*
  preMarketScan:
  - Runs the same candidate analysis but does NOT place orders.
  - Logs candidate list to GAS with mlScore, atr, features, price, gap, rvol.
  - Stores the candidates in `premarketCandidates` for quick retrieval.
*/
async function preMarketScan() {
  try {
    premarketCandidates = []; // reset
    const gappers = await getEliteGappers();
    const candidatePromises = gappers.map(async t => {
      const sig = await analyzeCandidate(t);
      if (!sig) return null;
      // log each candidate (short summary)
      const logData = {
        symbol: sig.symbol,
        price: sig.price,
        mlScore: sig.mlScore,
        atr: sig.atr,
        qtyEstimate: sig.qty,
        features: sig.features,
        gap: sig.gap,
        rvol: sig.rvol,
        time: new Date().toISOString()
      };
      await logToGAS('PREMARKET_CANDIDATE', sig.symbol, `score=${sig.mlScore.toFixed(3)} atr=${sig.atr ? sig.atr.toFixed(4) : 'n/a'}`, logData);
      return logData;
    });

    const results = await Promise.all(candidatePromises);
    premarketCandidates = results.filter(Boolean);
    await logToGAS('PREMARKET_SUMMARY', 'SYSTEM', `Found ${premarketCandidates.length} candidates`, { count: premarketCandidates.length });
    return premarketCandidates;
  } catch (e) {
    console.error('preMarketScan error', e.message);
    await logToGAS('PREMARKET_ERROR', 'SYSTEM', e.message);
    return [];
  }
}

// Schedule daily premarket run at 12:45 UTC (adjustable)
function scheduleDailyPremarket(hourUTC = 12, minuteUTC = 45) {
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hourUTC, minuteUTC, 0));
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1); // tomorrow
  const delay = next.getTime() - now.getTime();
  setTimeout(async function runAndInterval() {
    try { await preMarketScan(); } catch (e) { console.error('scheduled premarket error', e.message); }
    // schedule every 24h after first run
    setInterval(async () => {
      try { await preMarketScan(); } catch (e) { console.error('scheduled premarket error', e.message); }
    }, 24 * 60 * 60 * 1000);
  }, delay);
}
// start scheduler
scheduleDailyPremarket(12, 45);

// -------------------- Routes --------------------
app.get('/', (req, res) => res.json({ status: 'AlphaStream v23.3', time: new Date().toISOString() }));

// Trigger live scan via POST (heartbeat forward from GAS)
app.post('/', async (req, res) => {
  const body = req.body || {};
  if (FORWARD_SECRET && body.secret !== FORWARD_SECRET) return res.status(403).json({ status: 'forbidden' });
  // fire-and-forget scan
  scanHandler().catch(e => console.error('scanHandler err', e));
  return res.json({ status: 'queued' });
});

// Manual premarket trigger + return last premarket candidates
app.get('/premarket', async (req, res) => {
  try {
    const run = await preMarketScan();
    return res.json({ status: 'ok', count: run.length, candidates: run });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// get last premarket cached candidates quickly
app.get('/premarket/last', (req, res) => {
  res.json({ status: 'ok', count: premarketCandidates.length, candidates: premarketCandidates });
});

// Start
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log('AlphaStream v23.3 listening on port', PORT);
  logToGAS('BOT_START', 'SYSTEM', 'AlphaStream v23.3 started');
});
