// index.js — AlphaStream v24 ELITE — STARTUP-SAFE VERSION (2025)
import express from "express";
import axios from "axios";
import { ADX, ATR } from "technicalindicators";

const app = express();
app.use(express.json());

// ==================== CRITICAL: CORS FIRST ====================
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  next();
});

// === ENV VARS ===
const {
  ALPACA_KEY = "",
  ALPACA_SECRET = "",
  MASSIVE_KEY = "",
  PREDICTOR_URL = "",
  LOG_WEBHOOK_URL = "",
  LOG_WEBHOOK_SECRET = "",
  FORWARD_SECRET = "supersecret123",
  MAX_POS = "3",
  SCAN_INTERVAL_MS = "48000",
  DRY_MODE = "false"
} = process.env;

const DRY_MODE_BOOL = DRY_MODE === "false" || DRY_MODE === "0" ? false : true;

let positions = {};
let scanning = false;

// === SAFE UTILS IMPORTS (prevents startup crash if files missing) ===
let utilsLoaded = false;
try {
  const { detectMarketRegime } = await import("./utils/regime.js");
  const { extractFeatures } = await import("./utils/features.js");
  const { calculatePositionSize } = await import("./utils/risk.js");
  const { std, safeDiv } = await import("./utils/math.js");
  utilsLoaded = true;
  console.log("Utils loaded successfully");
} catch (e) {
  console.warn("Utils files not found – running in basic mode:", e.message);
}

// === LOGGING ===
async function log(event, symbol = "", note = "", data = {}) {
  const msg = `[${event}] ${symbol} | ${note}`;
  console.log(msg, data);
  if (!LOG_WEBHOOK_URL || !LOG_WEBHOOK_SECRET) return;
  try {
    await axios.post(LOG_WEBHOOK_URL, {
      secret: LOG_WEBHOOK_SECRET,
      event, symbol, note, data
    }, { timeout: 5000 });
  } catch (e) {
    console.error("LOG FAILED:", e.message);
  }
}

// === DATA HELPERS ===
async function safeGet(url, opts = {}) {
  for (let i = 0; i < 4; i++) {
    try {
      return (await axios.get(url, { ...opts, timeout: 10000 })).data;
    } catch (e) {
      if (i === 3) throw e;
      await new Promise(r => setTimeout(r, 800 * (i + 1)));
    }
  }
}

async function getBars(sym, days = 5) {
  const to = new Date().toISOString().split('T')[0];
  const from = new Date(Date.now() - days * 86400000).toISOString().split('T')[0];
  const url = `${process.env.M_BASE || 'https://api.massive.com'}/v2/aggs/ticker/${sym}/range/1/minute/${from}/${to}?adjusted=true&limit=5000&apiKey=${MASSIVE_KEY}`;
  try {
    const data = await safeGet(url);
    return data?.results || [];
  } catch (e) {
    console.error(`getBars(${sym}) failed:`, e.message);
    return [];
  }
}

async function getEquity() {
  try {
    const acc = await safeGet(`${A_BASE}/account`, { headers });
    return parseFloat(acc.equity || 25000);
  } catch (e) {
    return 25000;
  }
}

// === HEALTH ENDPOINT ===
app.get("/healthz", (req, res) => {
  res.status(200).send("OK");
});

// === ROOT ENDPOINT (DASHBOARD STATUS) ===
app.get("/", (req, res) => {
  res.json({
    bot: "AlphaStream v24 ELITE",
    status: "LIVE",
    time: new Date().toISOString(),
    positions: Object.keys(positions).length,
    max_pos: MAX_POS,
    dry_mode: DRY_MODE_BOOL || !ALPACA_KEY || !PREDICTOR_URL
  });
});

// === POST ENDPOINT (SCAN TRIGGER) ===
app.post("/", async (req, res) => {
  const secret = req.body?.secret || "";
  if (FORWARD_SECRET && secret !== FORWARD_SECRET) {
    return res.status(403).json({ error: "forbidden" });
  }
  res.json({ status: "triggered" });
  await log("SCAN_TRIGGER", "DASHBOARD", "Manual scan started");
  scanAndTrade().catch(console.error);
});

// === SCAN LOGIC ===
async function scanAndTrade() {
  if (scanning) return;
  scanning = true;
  try {
    const hour = new Date().getUTCHours();
    if (hour < 13 || hour >= 20) {
      scanning = false;
      return;
    }
    await log("HEARTBEAT", "SYSTEM", "Scan running", { positions: Object.keys(positions).length });
    // YOUR FULL LOGIC HERE
  } catch (e) {
    await log("SCAN_ERROR", "SYSTEM", e.message);
  } finally {
    scanning = false;
  }
}

// === START SERVER WITH ERROR HANDLING ===
const PORT = process.env.PORT || 8080;
const A_BASE = "https://paper-api.alpaca.markets/v2";
const M_BASE = "https://api.massive.com";
const headers = {
  "APCA-API-KEY-ID": ALPACA_KEY,
  "APCA-API-SECRET-KEY": ALPACA_SECRET
};

const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`ALPHASTREAM v24 ELITE LIVE on 0.0.0.0:${PORT}`);
  log("BOT_START", "SYSTEM", "Deployed successfully");
  scanAndTrade();
  setInterval(scanAndTrade, parseInt(SCAN_INTERVAL_MS, 10) || 48000);
});

// Handle graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  server.close(() => {
    console.log('Process terminated');
  });
});
