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

// ENV VARS — CLEAN & SAFE
const {
  ALPACA_KEY = "",
  ALPACA_SECRET = "",
  MASSIVE_KEY = "",
  PREDICTOR_URL = "",
  LOG_WEBHOOK_URL = "",
  LOG_WEBHOOK_SECRET = "",
  FORWARD_SECRET = "",           // ← comes from GitHub Secret / Cloud Run
  MAX_POS = "3",
  SCAN_INTERVAL_MS = "48000",
  DRY_MODE = "true"              // default safe mode
} = process.env;

// Proper DRY_MODE handling
const DRY_MODE_BOOL = !["false", "0", "no", "off"].includes(String(DRY_MODE).toLowerCase());

let positions = {};
let scanning = false;

// Simple logger (fire-and-forget)
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
  } catch {
    // silent fail — never crash the bot
  }
}

// ROOT — Dashboard status
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

  res.json({ status: "SCAN TRIGGERED — FULL SEND" });
  await log("MANUAL_SCAN", "DASHBOARD", "Triggered by user");
  scanAndTrade().catch(console.error);
});

// SCAN LOGIC — safe placeholder
async function scanAndTrade() {
  if (scanning) return;
  scanning = true;

  try {
    const hour = new Date().getUTCHours();
    if (hour < 13 || hour >= 20) return; // 9:30 AM – 4:00 PM ET

    await log("HEARTBEAT", "SYSTEM", "Scan running", {
      positions: Object.keys(positions).length,
      dry_mode: DRY_MODE_BOOL
    });

    // YOUR FULL TRADING LOGIC GOES HERE
    // Currently safe: does nothing but keeps bot alive and healthy

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
  await log("BOT_START", "SYSTEM", "Deployed & running", { dry_mode: DRY_MODE_BOOL });

  // First scan + safe recurring interval
  scanAndTrade();
  setInterval(() => {
    scanAndTrade().catch(console.error);
  }, Number(SCAN_INTERVAL_MS) || 48000);
});

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("SIGTERM received – shutting down gracefully");
  server.close(() => process.exit(0));
});

process.on("SIGINT", () => {
  console.log("SIGINT received – shutting down");
  server.close(() => process.exit(0));
});
