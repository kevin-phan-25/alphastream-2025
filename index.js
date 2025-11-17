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
const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";

const LOG_WEBHOOK_URL = process.env.LOG_WEBHOOK_URL;
const LOG_WEBHOOK_SECRET = process.env.LOG_WEBHOOK_SECRET || '';
const FORWARD_SECRET = process.env.FORWARD_SECRET || '';

const MAX_POS = parseInt(process.env.MAX_POS || "3", 10);
const RISK_PCT = parseFloat(process.env.RISK_PCT || "1.8");
const MIN_GAP = parseFloat(process.env.MIN_GAP || "0.18");
const MIN_RVOL = parseFloat(process.env.MIN_RVOL || "5.5");

// ==================== STATE ====================
let positions = {};
let barCache = {};
let tradeHistory = [];
let premarketCandidates = [];
let lastScanId = null;
let lastTradeTime = Date.now();
let peakEquity = 25000;
let redis;

// ==================== REDIS INIT (FIXED) ====================
async function initRedis() {
  redis = createClient({ url: REDIS_URL });
  redis.on("error", (err) => console.error("Redis error:", err));
  try {
    await redis.connect();
    console.log("Redis connected");
    const stored = await redis.get("peakEquity");
    if (stored) peakEquity = parseFloat(stored);
  } catch (err) {
    console.error("Redis failed, continuing without persistence:", err.message);
  }
}

// ==================== LOGGER ====================
async function logToGAS(event, symbol = "", note = "", data = {}) {
  if (!LOG_WEBHOOK_URL) return console.log(`[LOG] ${event} | ${symbol} | ${note}`, data);
  try {
    await axios.post(LOG_WEBHOOK_URL, { secret: LOG_WEBHOOK_SECRET, event, symbol, note, data }, { timeout: 4000 });
  } catch (e) {
    console.error("logToGAS failed:", e.message);
  }
}

// ==================== REST OF YOUR CODE (unchanged + fixed typo) ====================
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

async function getEquity() {
  const r = await safeGet(`${ALPACA_BASE}/account`, { headers: alpacaHeaders() });
  const equity = parseFloat(r.equity || 25000);

  if (redis?.isOpen) {
    const storedPeak = parseFloat(await redis.get("peakEquity") || equity);
    if (equity > storedPeak) {
      peakEquity = equity;
      await redis.set("peakEquity", equity);
    } else {
      peakEquity = storedPeak;
    }
  }
  return equity;
}

async function getRiskMultiplier() {
  const equity = await getEquity();
  const drawdown = (peakEquity - equity) / peakEquity;
  if (drawdown > 0.25) return 0.1;
  if (drawdown > 0.15) return 0.3;
  if (drawdown > 0.08) return 0.7;
  return 1.0;
}

// ... [Keep all your existing functions: getOpenPositions, syncPositionsFromAlpaca, getBars, indicators, getEliteGappers, analyzeCandidate, placeBracketOrder, etc.]

// YOUR EXISTING ML, INDICATORS, SCANNER, etc. — unchanged

// FIXED: mlPredict & getMLThreshold (you had these in v23 — keep them)
let ML_WEIGHTS = { w: [1.4, 1.1, 0.8, 1.6, 2.5], b: -2.6 };
function mlPredict(features) {
  let z = ML_WEIGHTS.b;
  for (let i = 0; i < Math.min(features.length, ML_WEIGHTS.w.length); i++)
    z += features[i] * ML_WEIGHTS.w[i];
  return 1 / (1 + Math.exp(-z));
}
function getMLThreshold() {
  if (tradeHistory.length < 10) return 0.72;
  const recent = tradeHistory.slice(-15);
  const winRate = recent.filter(t => t.pnl > 0).length / recent.length;
  const base = 0.68 + (winRate > 0.62 ? (winRate - 0.62) * 0.30 : 0);
  return Math.min(0.88, base - (recent.reduce((s, t) => s + t.pnl, 0) / recent.length < 0 ? 0.10 : 0));
}

// ==================== API ENDPOINTS (FIXED TYPO) ====================
app.get("/api/health", async (req, res) => {
  const equity = await getEquity();
  const drawdown = ((peakEquity - equity) / peakEquity * 100).toFixed(2);
  res.json({
    status: "healthy",
    equity: equity.toFixed(0),
    drawdown: `-${drawdown}%`,
    positions: Object.keys(positions).length,
    maxPositions: MAX_POS,
  });
});

app.get("/api/trades", (req, res) => {
  const recent = tradeHistory.slice(-20).map(t => ({
    symbol: t.symbol,
    pnl: t.pnl.toFixed(2) + "%",
    time: new Date(t.time).toLocaleTimeString('en-US', { timeZone: 'America/New_York' }), // FIXED: t.time-Secure → t.time
    win: t.pnl > 0,
  }));
  const winRate = tradeHistory.length ? (tradeHistory.filter(t => t.pnl > 0).length / tradeHistory.length * 100).toFixed(1) : 0;
  res.json({ trades: recent, winRate: winRate + "%" });
});

app.get("/api/premarket", (req, res) => {
  res.json({ candidates: premarketCandidates.slice(0, 8) });
});

// Your existing routes
app.get("/", (req, res) => res.json({ status: "AlphaStream v25 God Mode LIVE", positions: Object.keys(positions).length }));
app.get("/health", (req, res) => res.json({ status: "ok", positions: Object.keys(positions).length }));

// ==================== START ====================
const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', async () => {
  console.log(`AlphaStream v25 God Mode LIVE on port ${PORT}`);
  await initRedis();                    // ← Now safe
  await syncPositionsFromAlpaca();
  await logToGAS("BOT_START", "SYSTEM", "AlphaStream v25 God Mode ACTIVATED");
});
