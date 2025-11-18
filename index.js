// index.js — AlphaStream v24 — CRASH-PROOF STARTUP (2025)
// Logs every step to catch failures

console.log("=== Node Starting (v24) ===");  // First log — proves container runs

import express from "express";
import axios from "axios";

console.log("Imports: express + axios loaded");

// === CRITICAL: Add utils imports with try/catch ===
let detectMarketRegime, extractFeatures, calculatePositionSize, std, safeDiv;
try {
  ({ detectMarketRegime } = await import("./utils/regime.js"));
  ({ extractFeatures } = await dynamic import("./utils/features.js"));
  ({ calculatePositionSize } = await import("./utils/risk.js"));
  ({ std, safeDiv } = await import("./utils/math.js"));
  console.log("Utils imported successfully");
} catch (e) {
  console.error("UTILS IMPORT FAILED (non-fatal for now):", e.message);
  // Fallback stubs
  detectMarketRegime = () => "BULL_TREND";
  extractFeatures = () => [];
  calculatePositionSize = () => 1;
  std = (arr) => 0;
  safeDiv = (a, b) => a / b || 0;
}

const app = express();
app.use(express.json());

console.log("Express app initialized");

// === ENV VARS ===
const {
  ALPACA_KEY = "",
  ALPACA_SECRET = "",
  MASSIVE_KEY = "",
  PREDICTOR_URL = "",
  LOG_WEBHOOK_URL = "",
  LOG_WEBHOOK_SECRET = "",
  FORWARD_SECRET = "",
  MAX_POS = "3",
  SCAN_INTERVAL_MS = "48000"
} = process.env;

const MAX_POS_NUM = Number(MAX_POS) || 3;
const SCAN_INTERVAL = Number(SCAN_INTERVAL_MS) || 48000;

console.log("Env vars parsed. Dry mode:", !ALPACA_KEY);

// === SAFE LOGGING ===
const sanitizeData = (data) => data ? { ...data, apiKey: '[REDACTED]', secret: '[REDACTED]' } : data;

async function log(event, symbol = "", note = "", data = {}) {
  const msg = `[${event}] ${symbol} | ${note}`;
  console.log(msg, sanitizeData(data));
  if (!LOG_WEBHOOK_URL) return;
  try {
    await axios.post(LOG_WEBHOOK_URL, {
      secret: LOG_WEBHOOK_SECRET,
      event, symbol, note, data: sanitizeData(data)
    }, { timeout: 5000 });
  } catch (e) {
    console.error("LOG POST FAILED:", e.message);
  }
}

// === HELPERS ===
async function safeGet(url, opts = {}) {
  for (let i = 0; i < 4; i++) {
    try {
      return (await axios.get(url, { ...opts, timeout: 10000 })).data;
    } catch (e) {
      if (i === 3) throw e;
      await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    }
  }
}

export async function getBars(sym, days = 5) {
  // ... (your existing getBars code)
  const to = new Date().toISOString().split('T')[0];
  const from = new Date(Date.now() - days * 86400000).toISOString().split('T')[0];
  const url = `https://api.massive.com/v2/aggs/ticker/${sym}/range/1/minute/${from}/${to}?adjusted=true&limit=5000&apiKey=${MASSIVE_KEY}`;
  try {
    const data = await safeGet(url);
    return data?.results || [];
  } catch (e) {
    console.error(`getBars(${sym}) failed:`, e.message);
    return [];
  }
}

// === MARKET HOURS (Eastern) ===
function isMarketHours() {
  const options = { timeZone: "America/New_York", hour: 'numeric', minute: 'numeric', hour12: false };
  const parts = new Intl.DateTimeFormat('en-US', options).formatToParts(new Date());
  const hour = Number(parts.find(p => p.type === 'hour').value);
  const minute = Number(parts.find(p => p.type === 'minute').value);
  if (hour < 9 || hour > 15) return false;
  if (hour === 9 && minute < 30) return false;
  if (hour === 15 && minute >= 0) return false;
  return true;
}

// === SCAN (Minimal for Startup Test) ===
let scanning = false;
let positions = {};

async function scanAndTrade() {
  if (scanning) return;
  scanning = true;
  try {
    if (!isMarketHours()) return;
    await log("HEARTBEAT", "SYSTEM", "Scan active", { positions: Object.keys(positions).length });
    // Add full logic later
  } catch (e) {
    console.error("Scan error:", e);
    await log("SCAN_ERROR", "SYSTEM", e.message);
  } finally {
    scanning = false;
  }
}

// === ROUTES ===
app.get("/healthz", (req, res) => res.status(200).send("OK"));

app.get("/", (req, res) => {
  res.json({
    bot: "AlphaStream v24 ELITE",
    status: "LIVE",
    positions: Object.keys(positions).length,
    dry_mode: !ALPACA_KEY,
    market_open: isMarketHours()
  });
});

app.post("/", async (req, res) => {
  if (FORWARD_SECRET && req.body?.secret !== FORWARD_SECRET) return res.status(403).json({ error: "forbidden" });
  scanAndTrade().catch(() => {});
  res.json({ status: "triggered" });
});

// === SHUTDOWN ===
const shutdown = (signal) => {
  console.log(`${signal}: Shutting down...`);
  process.exit(0);
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// === START (GCP-Compliant) ===
const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`=== LIVE on 0.0.0.0:${PORT} ===`);
  log("BOT_START", "SYSTEM", "Deployed", { port: PORT }).catch(() => {});
  scanAndTrade().catch(() => {});
  setInterval(scanAndTrade, SCAN_INTERVAL);
});

console.log("=== Startup Complete ===");
