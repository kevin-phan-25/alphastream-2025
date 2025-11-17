// index.js — AlphaStream v23.0 Cloud Run service
import express from "express";
import axios from "axios";

const app = express();
app.use(express.json());

// Environment variables (set in Cloud Run)
// ALPACA_KEY, ALPACA_SECRET, MASSIVE_KEY, LOG_WEBHOOK_URL, LOG_WEBHOOK_SECRET,
// FORWARD_SECRET (must match GAS FORWARD_SECRET), MAX_POS, SCAN_INTERVAL_MS, TZ
const A_KEY = process.env.ALPACA_KEY;
const A_SEC = process.env.ALPACA_SECRET;
const MASSIVE_KEY = process.env.MASSIVE_KEY;
const LOG_WEBHOOK_URL = process.env.LOG_WEBHOOK_URL;         // GAS doPost URL
const LOG_WEBHOOK_SECRET = process.env.LOG_WEBHOOK_SECRET || '';
const FORWARD_SECRET = process.env.FORWARD_SECRET || '';
const MAX_POS = parseInt(process.env.MAX_POS || "2", 10);
const SCAN_INTERVAL_MS = parseInt(process.env.SCAN_INTERVAL_MS || "20000", 10);

// Simple in-memory positions (consider external store for production)
let positions = {}; // symbol -> { entry, qty, trailPrice, partialDone }

// Utility: send logs to GAS
async function logToGAS(event, symbol = "", note = "", data = {}) {
  if (!LOG_WEBHOOK_URL) {
    console.log(`[LOG] ${event} | ${symbol} | ${note}`, data);
    return;
  }
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

const ALPACA_BASE = "https://paper-api.alpaca.markets/v2";
const MASSIVE_BASE = "https://api.massive.com";

function alpacaHeaders() {
  return { "APCA-API-KEY-ID": A_KEY, "APCA-API-SECRET-KEY": A_SEC };
}

// Simple ML (replace with real model or call external predict endpoint)
let ML_WEIGHTS = { w: [1.3, 0.9, 0.7, 1.5, 2.3], b: -2.4 };
function mlPredict(features) {
  let z = ML_WEIGHTS.b;
  for (let i = 0; i < Math.min(features.length, ML_WEIGHTS.w.length); i++) {
    z += features[i] * ML_WEIGHTS.w[i];
  }
  return 1 / (1 + Math.exp(-z));
}

// Safe GET with retries
async function safeGet(url, opts = {}) {
  const maxRetries = opts.retries || 2;
  let attempt = 0;
  while (attempt <= maxRetries) {
    try {
      const r = await axios.get(url, opts.axiosOptions || {});
      return r.data;
    } catch (err) {
      attempt++;
      if (attempt > maxRetries) throw err;
      await new Promise(r => setTimeout(r, 300 * attempt));
    }
  }
}

// Get equity
async function getEquity() {
  const r = await axios.get(`${ALPACA_BASE}/account`, { headers: alpacaHeaders() });
  return parseFloat(r.data.equity || 25000);
}
async function getOpenPositions() {
  const r = await axios.get(`${ALPACA_BASE}/positions`, { headers: alpacaHeaders() });
  return r.data;
}

// Scanning
async function getEliteGappers(limit = 1000) {
  const url = `${MASSIVE_BASE}/v3/reference/tickers?market=stocks&active=true&limit=${limit}&apiKey=${MASSIVE_KEY}`;
  const data = await safeGet(url);
  const out = [];
  for (const t of (data?.results || [])) {
    try {
      if (t.type !== 'CS' || !t.ticker) continue;
      const snapUrl = `${MASSIVE_BASE}/v2/snapshot/locale/us/markets/stocks/tickers?tickers=${t.ticker}&apiKey=${MASSIVE_KEY}`;
      const snap = await safeGet(snapUrl);
      const s = snap?.tickers?.[0];
      if (!s) continue;
      const price = s.lastTrade?.p || s.day?.c || 0;
      const prev = s.prevDay?.c || 0;
      if (!prev || price < 2.5 || price > 20) continue;
      const gap = (price - prev) / prev;
      if (gap < 0.15) continue;
      if ((s.day?.v || 0) < 750000) continue;
      const rvol = (s.day?.v || 0) / (prev * 100000);
      if (rvol < 4) continue;
      if ((t.market_cap || Infinity) > 500000000) continue;
      if ((t.share_class_shares_outstanding || Infinity) > 20000000) continue;
      out.push({ sym: t.ticker, price, rvol, gap });
    } catch (e) {
      continue;
    }
  }
  return out.sort((a,b) => b.rvol - a.rvol).slice(0, 10);
}

async function getBars(sym, fromDays = 3) {
  const today = new Date().toISOString().split('T')[0];
  const from = new Date(); from.setDate(from.getDate() - fromDays);
  const fromStr = from.toISOString().split('T')[0];
  const url = `${MASSIVE_BASE}/v2/aggs/ticker/${sym}/range/1/minute/${fromStr}/${today}?adjusted=true&limit=1000&apiKey=${MASSIVE_KEY}`;
  const data = await safeGet(url);
  return data?.results || [];
}

function calculateVWAP(bars) {
  if (!bars || bars.length === 0) return null;
  let volPrice = 0, vol = 0;
  for (const b of bars) {
    const typ = (b.h + b.l + b.c) / 3;
    volPrice += typ * (b.v || 0);
    vol += (b.v || 0);
  }
  return vol > 0 ? volPrice / vol : null;
}

async function analyzeCandidate(t) {
  try {
    const bars = await getBars(t.sym, 3);
    if (!bars || bars.length < 50) return null;
    const last = bars[bars.length - 1];
    const vwap = calculateVWAP(bars);
    if (!vwap || last.c <= vwap) return null;
    const hod = Math.max(...bars.slice(-20).map(b => b.h));
    if (last.c < hod * 0.995) return null;
    const recentVol = bars.slice(-5).reduce((s,b) => s + (b.v || 0), 0) / 5;
    const avgVol = bars.slice(-30, -5).reduce((s,b) => s + (b.v || 0), 0) / 25 || 1;
    if (recentVol < avgVol * 2) return null;

    const features = [
      last.c / vwap,
      last.v / (bars[bars.length-2]?.v || 1),
      1, 1,
      (last.c - (bars[bars.length-2]?.c || last.c)) / last.c
    ];

    const score = mlPredict(features);
    if (score < 0.73) return null;

    const equity = await getEquity();
    const qty = Math.max(1, Math.floor(equity * 0.015 / (last.c * 0.04)));
    return { symbol: t.sym, price: last.c, qty, mlScore: score, features };
  } catch (e) {
    return null;
  }
}

async function placeBracketOrder(sig) {
  const payload = {
    symbol: sig.symbol,
    qty: sig.qty,
    side: 'buy',
    type: 'market',
    time_in_force: 'day',
    order_class: 'bracket',
    take_profit: { limit_price: parseFloat((sig.price * 1.10).toFixed(2)) },
    stop_loss: { stop_price: parseFloat((sig.price * (1 - 0.04)).toFixed(2)) }
  };
  try {
    const r = await axios.post(`${ALPACA_BASE}/orders`, payload, { headers: alpacaHeaders() });
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

      // Partial at +5%
      if (current >= entry * 1.05 && !positions[symbol].partialDone) {
        await axios.post(`${ALPACA_BASE}/orders`, {
          symbol,
          qty: Math.floor(qty / 2),
          side: 'sell',
          type: 'market',
          time_in_force: 'day'
        }, { headers: alpacaHeaders() });
        positions[symbol].partialDone = true;
        await logToGAS('PARTIAL', symbol, `Locked +5% on ${Math.floor(qty/2)} shares`);
      }

      // Trailing update
      const newTrail = current * 0.94;
      if (newTrail > positions[symbol].trailPrice) positions[symbol].trailPrice = newTrail;

      // Exit if price <= trail
      if (current <= positions[symbol].trailPrice) {
        await axios.post(`${ALPACA_BASE}/orders`, {
          symbol,
          qty: qty,
          side: 'sell',
          type: 'market',
          time_in_force: 'day'
        }, { headers: alpacaHeaders() });
        await logToGAS('EXIT_TRAIL', symbol, `Trailed out @ ${current}`);
        delete positions[symbol];
      }
    }
  } catch (e) {
    console.error('managePositions error', e.message);
  }
}

let isScanning = false;
async function scanHandler() {
  if (isScanning) return;
  isScanning = true;
  try {
    // Check market hours in UTC (roughly 13:30 - 20:00 UTC)
    const d = new Date();
    const hours = d.getUTCHours();
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

// Endpoint: GET /
app.get('/', (req, res) => {
  res.json({ status: 'AlphaStream v23.0', time: new Date().toISOString() });
});

// Endpoint: POST /heartbeat — called by GAS forwardHeartbeat
app.post('/', async (req, res) => {
  try {
    const body = req.body || {};
    const secret = body.secret || '';
    // Optional check: only process when secret matches
    const expected = FORWARD_SECRET || '';
    if (expected && secret !== expected) {
      return res.status(403).json({ status: 'forbidden' });
    }

    // Kick off a scan asynchronously (respond fast)
    scanHandler().catch(err => console.error('scanHandler err', err));
    return res.json({ status: 'queued' });
  } catch (e) {
    console.error('heartbeat error', e.message);
    return res.status(500).json({ error: e.message });
  }
});

// Start
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log('AlphaStream v23.0 listening on port', PORT);
  logToGAS('BOT_START', 'SYSTEM', 'AlphaStream v23.0 started');
});
