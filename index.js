// index.js — AlphaStream v25.0 "God Mode" - Kevin Phan @Kevin_Phan25
import express from "express";
import axios from "axios";
import { createClient } from "redis";

const app = express();
app.use(express.json());

// ==================== ENV VARS ====================
const A_KEY = process.env.ALPACA_KEY;
const A_SEC = process.env.ALPACA_SECRET;
const MASSIVE_KEY = process.env.MASSIVE_KEY;
const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379"; // Free on Upstash

const LOG_WEBHOOK_URL = process.env.LOG_WEBHOOK_URL;
const LOG_WEBHOOK_SECRET = process.env.LOG_WEBHOOK_SECRET || '';
const FORWARD_SECRET = process.env.FORWARD_SECRET || '';

const MAX_POS = parseInt(process.env.MAX_POS || "3", 10);
const RISK_PCT = parseFloat(process.env.RISK_PCT || "1.8");
const MIN_GAP = parseFloat(process.env.MIN_GAP || "0.18");
const MIN_RVOL = parseFloat(process.env.MIN_RVOL || "5.5");

// ==================== REDIS & PEAK EQUITY ====================
const redis = createClient({ url: REDIS_URL });
redis.on("error", (err) => console.error("Redis error:", err));
await redis.connect();

let peakEquity = 25000;

// ==================== STATE ====================
let positions = {};
let barCache = {};
let tradeHistory = [];
let premarketCandidates = [];
let lastScanId = null;
let lastTradeTime = Date.now();

// ==================== LOGGER ====================
async function logToGAS(event, symbol = "", note = "", data = {}) {
  if (!LOG_WEBHOOK_URL) return console.log(`[LOG] ${event} | ${symbol} | ${note}`, data);
  try {
    await axios.post(LOG_WEBHOOK_URL, { secret: LOG_WEBHOOK_SECRET, event, symbol, note, data }, { timeout: 4000 });
  } catch (e) {
    console.error("logToGAS failed:", e.message);
  }
}

// ==================== ALPACA & MASSIVE ====================
const ALPACA_BASE = "https://paper-api.alpaca.markets/v2";
const MASSIVE_BASE = "https://api.massive.com";

const alpacaHeaders = () => ({
  "APCA-API-KEY-ID": A_KEY,
  "APCA-API-SECRET-KEY": A_SEC,
});

async function safeGet(url, opts = {}, retries = 3) {
  for (let i = 0; i <= retries; i++) {
    try {
      return (await axios.get(url, opts)).data;
    } catch (e) {
      if (i === retries) throw e;
      await new Promise(r => setTimeout(r, 400 * (i + 1)));
    }
  }
}

async function safePost(url, payload, headers, retries = 3) {
  for (let i = 0; i <= retries; i++) {
    try {
      return await axios.post(url, payload, { headers });
    } catch (e) {
      if (i === retries) throw e;
      await new Promise(r => setTimeout(r, 400 * (i + 1)));
    }
  }
}

// ==================== ACCOUNT & DRAWDOWN DE-RISKING ====================
async function getEquity() {
  const r = await safeGet(`${ALPACA_BASE}/account`, { headers: alpacaHeaders() });
  const equity = parseFloat(r.equity || 25000);

  const storedPeak = parseFloat(await redis.get("peakEquity") || equity);
  if (equity > storedPeak) {
    peakEquity = equity;
    await redis.set("peakEquity", equity);
  } else {
    peakEquity = storedPeak;
  }

  return equity;
}

async function getRiskMultiplier() {
  const equity = await getEquity();
  const drawdown = (peakEquity - equity) / peakEquity;

  if (drawdown > 0.25) return 0.1;   // -25% → 90% cut
  if (drawdown > 0.15) return 0.3;   // -15% → 70% cut
  if (drawdown > 0.08) return 0.7;   // -8% → 30% cut
  return 1.0;
}

// ==================== POSITIONS & SYNC ====================
async function getOpenPositions() {
  return await safeGet(`${ALPACA_BASE}/positions`, { headers: alpacaHeaders() });
}

async function syncPositionsFromAlpaca() {
  const open = await getOpenPositions();
  positions = {};
  for (const p of open) {
    const current = parseFloat(p.current_price || p.avg_entry_price);
    positions[p.symbol] = {
      entry: parseFloat(p.avg_entry_price),
      qty: parseFloat(p.qty),
      trailPrice: current * 0.93,
      partialDone: false,
    };
  }
  await logToGAS("POS_SYNC", "SYSTEM", `Synced ${open.length} positions`);
}

// ==================== INDICATORS ====================
async function getBars(sym, fromDays = 3) {
  const now = Date.now();
  const cached = barCache[sym];
  if (cached && now - cached.lastFetch < 55000) return cached.bars;

  const today = new Date().toISOString().split("T")[0];
  const from = new Date();
  from.setDate(from.getDate() - fromDays);
  const fromStr = from.toISOString().split("T")[0];

  const data = await safeGet(
    `${MASSIVE_BASE}/v2/aggs/ticker/${sym}/range/1/minute/${fromStr}/${today}?adjusted=true&limit=1000&apiKey=${MASSIVE_KEY}`
  );
  const bars = data?.results || [];
  barCache[sym] = { bars, lastFetch: now };
  return bars;
}

function calculateVWAP(bars) {
  if (!bars.length) return null;
  let vp = 0, v = 0;
  for (const b of bars) {
    const t = (b.h + b.l + b.c) / 3;
    vp += t * (b.v || 0);
    v += (b.v || 0);
  }
  return v > 0 ? vp / v : null;
}

function calculateATR(bars, period = 14) {
  if (bars.length < period + 1) return 0;
  let trSum = 0;
  for (let i = 1; i <= period; i++) {
    const curr = bars[bars.length - i];
    const prev = bars[bars.length - i - 1];
    const tr = Math.max(
      curr.h - curr.l,
      Math.abs(curr.h - prev.c),
      Math.abs(curr.l - prev.c)
    );
    trSum += tr;
  }
  return trSum / period;
}

// NEW: Opening Range Breakout (5-min ORB)
function isORBConfirmed(bars) {
  if (bars.length < 6) return false;
  const orbBars = bars.slice(-6, -1); // First 5 mins
  const orbHigh = Math.max(...orbBars.map(b => b.h));
  const last = bars[bars.length - 1];
  return last.c > orbHigh * 1.002;
}

// ==================== GAPPER SCANNER ====================
async function getEliteGappers() {
  // ... (your original getEliteGappers — unchanged)
  const data = await safeGet(`${MASSIVE_BASE}/v3/reference/tickers?market=stocks&active=true&limit=1200&apiKey=${MASSIVE_KEY}`);
  const results = data?.results || [];

  const snapshots = await Promise.all(
    results.map(async (t) => {
      try {
        if (t.type !== "CS" || !t.ticker) return null;
        const snap = await safeGet(`${MASSIVE_BASE}/v2/snapshot/locale/us/markets/stocks/tickers?tickers=${t.ticker}&apiKey=${MASSIVE_KEY}`);
        return { ...t, snap: snap?.tickers?.[0] };
      } catch { return null; }
    })
  );

  const out = snapshots
    .filter(s => s?.snap)
    .map(s => {
      const last = s.snap.lastTrade?.p || s.snap.day?.c || 0;
      const prev = s.snap.prevDay?.c || 0;
      if (!prev || last < 2.8 || last > 22) return null;
      const gap = (last - prev) / prev;
      if (gap < MIN_GAP) return null;

      const rvol = (s.snap.day?.v || 0) / (prev * 100000);
      if (rvol < MIN_RVOL || (s.snap.day?.v || 0) < 900000) return null;
      if ((s.market_cap || Infinity) > 600000000) return null;
      if ((s.share_class_shares_outstanding || Infinity) > 25000000) return null;

      return { sym: s.ticker, price: last, gap, rvol };
    })
    .filter(Boolean);

  return out.sort((a, b) => b.rvol - a.rvol).slice(0, 12);
}

// ==================== CANDIDATE ANALYSIS (v25) ====================
async function analyzeCandidate(t) {
  try {
    const bars = await getBars(t.sym, 3);
    if (bars.length < 60) return null;

    const last = bars[bars.length - 1];
    const vwap = calculateVWAP(bars);
    if (!vwap || last.c <= vwap * 1.002) return null;

    if (!isORBConfirmed(bars)) return null; // ← GOD MODE FILTER #1

    const recentVol = bars.slice(-5).reduce((s, b) => s + (b.v || 0), 0) / 5;
    const avgVol = bars.slice(-35, -5).reduce((s, b) => s + (b.v || 0), 0) / 30 || 1;
    if (recentVol < avgVol * 2.3) return null;

    const features = [
      last.c / vwap,
      last.v / (bars[bars.length - 2]?.v || 1),
      recentVol / avgVol,
      t.gap,
      (last.c - bars[bars.length - 5].c) / bars[bars.length - 5].c,
    ];

    const score = mlPredict(features);
    if (score < getMLThreshold()) return null;

    const equity = await getEquity();
    const riskMultiplier = await getRiskMultiplier(); // ← GOD MODE FILTER #2
    const atr = calculateATR(bars);
    const riskPerShare = atr || last.c * 0.045;
    const riskFactor = Math.min(1.6, t.gap * 2.8 + t.rvol / 9);

    let qty = Math.max(1, Math.floor((equity * (RISK_PCT / 100) / riskFactor) / riskPerShare));
    qty = Math.floor(qty * riskMultiplier);

    const rankingScore = score * (1 + t.gap * 2.2) * Math.sqrt(t.rvol);

    return { symbol: t.sym, price: last.c, qty, mlScore: score, rankingScore, atr, gap: t.gap, rvol: t.rvol };
  } catch (e) {
    return null;
  }
}

// ==================== ORDER EXECUTION (Safer) ====================
async function placeBracketOrder(sig) {
  const payload = {
    symbol: sig.symbol,
    qty: sig.qty,
    side: "buy",
    type: "limit",
    limit_price: parseFloat((sig.price * 1.005).toFixed(2)),
    time_in_force: "day",
    order_class: "bracket",
    take_profit: { limit_price: parseFloat((sig.price * 1.12).toFixed(2)) },
    stop_loss: {
      stop_price: parseFloat((sig.price * (1 - (sig.atr ? sig.atr / sig.price * 1.8 : 0.06))).toFixed(2)),
    },
  };

  try {
    const r = await safePost(`${ALPACA_BASE}/orders`, payload, alpacaHeaders());
    await logToGAS("ENTRY", sig.symbol, `BUY ${sig.qty}@${sig.price.toFixed(2)} | Score ${sig.mlScore.toFixed(3)}`, { ml: sig.mlScore, rank: sig.rankingScore });
    positions[sig.symbol] = { entry: sig.price, qty: sig.qty, trailPrice: sig.price * 0.93, partialDone: false };
    lastTradeTime = Date.now();
    return r.data;
  } catch (e) {
    await logToGAS("ORDER_FAIL", sig.symbol, e.response?.data?.message || e.message);
    return null;
  }
}

// ==================== POSITION MANAGEMENT (unchanged logic) ====================
// ... (keep your existing managePositions, scanHandler, preMarketScan, routes)

// ==================== NEW DASHBOARD API ENDPOINTS ====================
app.get("/api/health", async (req, res) => {
  const equity = await getEquity();
  const drawdown = ((peakEquity - equity) / peakEquity * 100).toFixed(2);
  res.json({
    status: "healthy",
    equity: equity.toFixed(2),
    drawdown: `-${drawdown}%`,
    positions: Object.keys(positions).length,
    maxPositions: MAX_POS,
    lastTrade: lastTradeTime ? new Date(lastTradeTime).toLocaleTimeString('en-US', { timeZone: 'America/New_York' }) : "Never",
  });
});

app.get("/api/trades", (req, res) => {
  const recent = tradeHistory.slice(-20).map(t => ({
    symbol: t.symbol,
    pnl: t.pnl.toFixed(2) + "%",
    time: new Date(t.time-Secure).toLocaleTimeString('en-US', { timeZone: 'America/New_York' }),
    win: t.pnl > 0,
  }));
  const winRate = tradeHistory.length ? (tradeHistory.filter(t => t.pnl > 0).length / tradeHistory.length * 100).toFixed(1) : 0;
  res.json({ trades: recent, winRate: winRate + "%" });
});

app.get("/api/premarket", (req, res) => {
  res.json({ candidates: premarketCandidates.slice(0, 8) });
});

// Keep your existing routes (/health, /premarket, etc.)

// ==================== START ====================
const PORT = process.env.PORT || 8080;
app.listen(PORT, async () => {
  console.log(`AlphaStream v25 God Mode LIVE on port ${PORT}`);
  await syncPositionsFromAlpaca();
  await logToGAS("BOT_START", "SYSTEM", "AlphaStream v25 God Mode ACTIVATED");
});
