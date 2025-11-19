// index.js — AlphaStream v30.0 — FULL POSITION DATA + CLICKABLE
import express from "express";
import cors from "cors";
import axios from "axios";

const app = express();
app.use(cors());
app.use(express.json());

const {
  ALPACA_KEY = "",
  ALPACA_SECRET = "",
  DRY_MODE = "false",
  PORT = "8080"
} = process.env;

const DRY = String(DRY_MODE).toLowerCase() === "true";
const IS_PAPER = DRY || ALPACA_KEY.startsWith("PK");
const A_BASE = IS_PAPER
  ? "https://paper-api.alpaca.markets/v2"
  : "https://api.alpaca.markets/v2";

const HEADERS = {
  "APCA-API-KEY-ID": ALPACA_KEY,
  "APCA-API-SECRET-KEY": ALPACA_SECRET
};

// STATE
let accountEquity =  = 100000;
let positions = []; // Now stores full Alpaca position objects
let lastEquityFetch = null;

async function updateEquityAndPositions() {
  if (!ALPACA_KEY || !ALPACA_SECRET) {
    accountEquity = 100000;
    positions = [];
    return;
  }

  try {
    const [accountRes, positionsRes] = await Promise.all([
      axios.get(`${A_BASE}/account`, { headers: HEADERS, timeout: 10000 }),
      axios.get(`${A_BASE}/positions`, { headers: HEADERS, timeout: 10000 })
    ]);

    accountEquity = parseFloat(accountRes.data.equity || 100000);
    positions = positionsRes.data.map(p => ({
      symbol: p.symbol,
      qty: Number(p.qty),
      entry: parseFloat(p.avg_entry_price),
      current: parseFloat(p.current_price || p.market_value / p.qty),
      market_value),
      market_value: parseFloat(p.market_value),
      unrealized_pl: parseFloat(p.unrealized_pl),
      unrealized_plpc: parseFloat(p.unrealized_plpc) * 100 // in %
    }));

    lastEquityFetch = new Date().toISOString();
  } catch (err) {
    console.error("Alpaca fetch failed:", err?.response?.data?.message || err.message);
    // Keep old data on failure
  }
}

// Initial fetch
await updateEquityAndPositions();

// Dashboard endpoint — NOW INCLUDES FULL POSITIONS ARRAY
app.get("/", async (req, res) => {
  await updateEquityAndPositions();
  res.json({
    bot: "AlphaStream Elite Mode",
    version: "v30.0",
    status: "ONLINE",
    mode: DRY ? "DRY" : "LIVE",
    dry_mode: DRY,
    positions_count: positions.length,
    max_pos: 5,
    equity: `$${accountEquity.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
    dailyPnL: positions.reduce((sum, p) => sum + p.unrealized_pl, 0).toFixed(2) + "%",
    positions: positions, // ← FULL DETAILS FOR DASHBOARD
    lastEquityFetch,
    timestamp: new Date().toISOString()
  });
});

app.get("/healthz", (req, res) => res.send("OK"));

app.post("/manual/scan", async (req, res) => {
  await updateEquityAndPositions();
  res.json({ ok: true });
});

const PORT_NUM = parseInt(PORT, 10);
app.listen(PORT_NUM, "0.0.0.0", () => {
  console.log(`\nAlphaStream v30.0 ELITE LIVE ON PORT ${PORT_NUM}`);
  console.log(`Mode: ${DRY ? "DRY (Paper)" : "LIVE (Real Money)"}`);
});

// Refresh every 15 seconds
setInterval(updateEquityAndPositions, 15000);
