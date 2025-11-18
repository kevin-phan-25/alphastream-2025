// index.js — AlphaStream v24 ELITE — FINAL 2025 VERSION (DASHBOARD FULLY WORKING)
import express from "express";
import axios from "axios";
import { ADX, ATR } from "technicalindicators";

// === FIX: Correct import paths (adjust if needed) ===
import { detectMarketRegime } from "./utils/regime.js";
import { extractFeatures } from "./utils/features.js";
import { calculatePositionSize } from "./utils/risk.js";
import { std, safeDiv } from "./utils/math.js";

const app = express();
app.use(express.json());

// ==================== CRITICAL: CORS FIRST (MUST BE AT TOP) ====================
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
  FORWARD_SECRET = "supersecret123", // fallback for testing
  MAX_POS = "3",
  SCAN_INTERVAL_MS = "48000",
  DRY_MODE = "false"
} = process.env;

const DRY_MODE_BOOL = DRY_MODE === "false" || DRY_MODE === "0" ? false : true;

let positions = {};
let scanning = false;

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

// === ROOT HEALTH + STATUS ENDPOINT (DASHBOARD READS THIS) ===
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

app.get("/healthz", (req, res) => {
  res.status(200).send("OK");
});

// === MANUAL SCAN TRIGGER (DASHBOARD POSTS HERE) ===
app.post("/", async (req, res) => {
  const secret = req.body?.secret || "";
  if (FORWARD_SECRET && secret !== FORWARD_SECRET) {
    return res.status(403).json({ error: "wrong secret" });
  }

  res.json({ status: "SCAN TRIGGERED — FULL SEND" });
  console.log("MANUAL SCAN TRIGGERED FROM DASHBOARD");
  await log("MANUAL_SCAN", "DASHBOARD", "Triggered by user");

  // Trigger scan immediately
  scanAndTrade().catch(console.error);
});

// === MAIN SCAN LOGIC (placeholder — your full logic goes here) ===
async function scanAndTrade() {
  if (scanning) return;
  scanning = true;
  try {
    const hour = new Date().getUTCHours();
    if (hour < 13 || hour >= 20) {
      scanning = false;
      return;
    }

    await log("HEARTBEAT", "SYSTEM", "Scan running", {
      positions: Object.keys(positions).length,
      dry_mode: DRY_MODE_BOOL
    });

    // YOUR FULL SCAN + TRADE LOGIC HERE
    // analyzeCandidate(), enter(), managePositions(), etc.

  } catch (e) {
    await log("ERROR", "SYSTEM", e.message);
    console.error("SCAN ERROR:", e);
  } finally {
    scanning = false;
  }
}

// === START SERVER ===
const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`ALPHASTREAM v24 ELITE LIVE on 0.0.0.0:${PORT}`);
  console.log(`Dashboard URL: https://alphastream-autopilot-1017433009054.us-east1.run.app`);
  log("BOT_START", "SYSTEM", "AlphaStream v24 ELITE deployed & ready");

  // Initial scan
  scanAndTrade();
  setInterval(scanAndTrade, parseInt(SCAN_INTERVAL_MS, 10) || 48000);
});

export default app;
