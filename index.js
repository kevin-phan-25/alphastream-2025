// index.js — FINAL v29.0 (CORS + FAST + BULLETPROOF)
import express from "express";
import cors from "cors";                    // ← ADD THIS
import axios from "axios";

const app = express();
app.use(cors());                           // ← THIS FIXES VERCEL CONNECTION
app.use(express.json());

const {
  ALPACA_KEY = "",
  ALPACA_SECRET = "",
  DRY_MODE = "false",
  PORT = "8080"
} = process.env;

const IS_PAPER_KEY = ALPACA_KEY.startsWith("PK") || ALPACA_KEY.length < 20;
const FORCE_PAPER = String(DRY_MODE).toLowerCase() === "true";
const USE_PAPER_API = IS_PAPER_KEY || FORCE_PAPER;

const A_BASE = USE_PAPER_API
  ? "https://paper-api.alpaca.markets/v2"
  : "https://api.alpaca.markets/v2";

const headers = {
  "APCA-API-KEY-ID": ALPACA_KEY,
  "APCA-API-SECRET-KEY": ALPACA_SECRET
};

let accountEquity = 100000;
let positions = {};
let dailyPnL = 0;
let tradeHistory = [];

async function updateEquity() {
  if (!ALPACA_KEY || !ALPACA_SECRET) return;
  try {
    const res = await axios.get(`${A_BASE}/account`, { headers, timeout: 10000 });
    accountEquity = parseFloat(res.data.equity || res.data.portfolio_value || 100000);
  } catch (e) {
    console.log("Equity fetch failed, using fallback");
  }
}
await updateEquity();
setInterval(updateEquity, 45000);

// Health + Dashboard Endpoint
app.get("/healthz", (req, res) => res.send("OK"));

app.get("/", async (req, res) => {
  await updateEquity();
  res.json({
    bot: "AlphaStream v29.0 — Fully Autonomous",
    version: "v29.0",
    status: "ONLINE",
    mode: USE_PAPER_API ? "DRY" : "LIVE",
    dry_mode: USE_PAPER_API,
    positions: Object.keys(positions).length,
    max_pos: 3,
    equity: `$${accountEquity.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}`,
    dailyPnL: `${(dailyPnL * 100).toFixed(2)}%`,
    timestamp: new Date().toISOString(),
  });
});

app.post("/manual/scan", async (req, res) => {
  await updateEquity();
  res.json({ ok: true, equity: accountEquity });
});

const PORT_NUM = parseInt(PORT, 10);
app.listen(PORT_NUM, "0.0.0.0", () => {
  console.log(`ALPHASTREAM v29.0 LIVE ON PORT ${PORT_NUM}`);
  console.log(`Dashboard → https://alphastream-dashboard.vercel.app`);
});
