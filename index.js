// index.js — AlphaStream v24 ELITE — FINAL PRODUCTION VERSION (Nov 2025)
import express from "express";
import axios from "axios";

const app = express();
app.use(express.json());

// CORS — MUST BE FIRST
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  next();
});

// ENV VARS — NO HARDCODED SECRETS
const {
  ALPACA_KEY = "",
  ALPACA_SECRET = "",
  MASSIVE_KEY = "",
  PREDICTOR_URL = "",
  LOG_WEBHOOK_URL = "",
  LOG_WEBHOOK_SECRET = "",
  FORWARD_SECRET = "",           // ← comes from GitHub Secret / Cloud Run env
    process.env.FORWARD_SECRET || "",   // safe fallback, will be empty if not set
  MAX_POS = "3",
  SCAN_INTERVAL_MS = "48000",
  DRY_MODE = "true"               // default to safe mode
} = process.env;

// Clean DRY_MODE logic
const DRY_MODE_BOOL = !["false", "0", "no"].includes(String(DRY_MODE).toLowerCase());

// Global state
let positions = {};
let scanning = false;

// Simple logger
async function log(event, symbol = "", note = "", data = {}) {
  console.log(`[${event}] ${symbol} | ${note}`, data);

  if (!LOG_WEBHOOK_URL || !LOG_WEBHOOK_SECRET) return;
  try {
    await axios.post(LOG_WEBHOOK_URL, {
      secret: LOG_WEBHOOK_SECRET,
      event,
      symbol,
      note,
      data
    }, { timeout: 5000 });
  } catch {} // silent fail
}

// ROOT — Dashboard reads this
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

app.get("/healthz", (req, res) => res.status(200).send("OK"));

// MANUAL SCAN TRIGGER
app.post("/", async (req, res) => {
  if (FORWARD_SECRET && req.body?.secret !== FORWARD_SECRET) {
    return res.status(403).json({ error: "forbidden" });
  }

  res.json({ status: "SCAN TRIGGERED — FULL SEND });
  await log("MANUAL_SCAN", "DASHBOARD", "Triggered by user");
  scanAndTrade().catch(console.error);
});

// SCAN LOGIC (placeholder – safe even if utils missing)
async function scanAndTrade() {
  if (scanning) return;
  scanning = true;

  try {
    const hour = new Date().getUTCHours();
    if (hour < 13 || hour >= 20) return; // 9:30–16:00 ET

    await log("HEARTBEAT", "SYSTEM", "Scan running", {
      positions: Object.keys(positions).length,
      dry_mode: DRY_MODE_BOOL
    });

    // YOUR FULL TRADING LOGIC GOES HERE
    // Safe to leave empty for now — bot stays alive and shows LIVE

  } catch (err) {
    await log("SCAN_ERROR", "SYSTEM", err.message);
  } finally {
    scanning = false;
  }
}

// SERVER START
const PORT = process.env.PORT || 8080;

const server = app.listen(PORT, "0.0.0.0", async () => {
  console.log(`ALPHASTREAM v24 ELITE LIVE on port ${PORT}`);
  await log("BOT_START", "SYSTEM", "Deployed successfully", { dry_mode: DRY_MODE_BOOL });

  // Initial scan + scheduler
  scanAndTrade();
  setInterval(scanAndTrade, Number(SCAN_INTERVAL_MS) || 48000);
});

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("SIGTERM received – shutting down");
  server.close();
});
