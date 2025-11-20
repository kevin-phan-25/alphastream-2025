// index.js — AlphaStream v71.0 — FIXED ALPACA + FMP (No 403, Real Equity)
import express from "express";
import cors from "cors";
import axios from "axios";

const app = express();
app.use(cors());
app.use(express.json());

const {
  ALPACA_KEY = "",
  ALPACA_SECRET = "",
  FMP_KEY = "",
  DRY_MODE = "true",
  PORT = "8080"
} = process.env;

const DRY = DRY_MODE.toLowerCase() === "true";
const A_BASE = DRY ? "https://paper-api.alpaca.markets/v2" : "https://api.alpaca.markets/v2";

const HEADERS = {
  "APCA-API-KEY-ID": ALPACA_KEY,
  "APCA-API-SECRET-KEY": ALPACA_SECRET
};

let accountEquity = 100000;
let positions = [];
let tradeLog = [];
let lastGainers = [];
let lastScanTime = 0;
let fmpCallsToday = 0;
let maxFmpCalls = 250; // Free tier quota

console.log(`\nALPHASTREAM v71.0 — ALPACA + FMP FIXED`);
console.log(`Mode → ${DRY ? "DRY (Paper)" : "LIVE (Real Money)"}`);
console.log(`Alpaca Base → ${A_BASE}`);
console.log(`FMP Calls → ${fmpCallsToday}/${maxFmpCalls}\n`);

async function updateEquityAndPositions() {
  if (!ALPACA_KEY || !ALPACA_SECRET) {
    console.log("No Alpaca keys — using mock equity $100,000");
    return;
  }

  try {
    const [acct, pos] = await Promise.all([
      axios.get(`${A_BASE}/account`, { headers: HEADERS, timeout: 10000 }),
      axios.get(`${A_BASE}/positions`, { headers: HEADERS, timeout: 10000 })
    ]);
    accountEquity = parseFloat(acct.data.equity || 100000);
    positions = pos.data.map(p => ({
      symbol: p.symbol,
      qty: Number(p.qty),
      entry: Number(p.avg_entry_price),
      current: Number(p.current_price),
      unrealized_pl: Number(p.unrealized_pl)
    }));
    console.log(`Alpaca sync → Equity: $${accountEquity.toFixed(2)} | Positions: ${positions.length}`);
  } catch (e) {
    const status = e.response?.status;
    if (status === 401) {
      console.log("ALPACA 401 — Wrong key or paper/live mismatch. Check your secrets.");
    } else {
      console.log("Alpaca fetch failed:", e.message);
    }
  }
}

async function getGainers() {
  const now = Date.now();
  if (now - lastScanTime < 60000 && lastGainers.length > 0) {
    return lastGainers;
  }

  if (!FMP_KEY || fmpCallsToday >= maxFmpCalls) {
    console.log(`FMP quota hit (${fmpCallsToday}/${maxFmpCalls}) — using cache`);
    return lastGainers;
  }

  try {
    fmpCallsToday++;
    const url = `https://financialmodelingprep.com/api/v3/stock_market/gainers?apikey=${FMP_KEY}`;
    const res = await axios.get(url, { timeout: 12000 });

    const filtered = (res.data || [])
      .filter(t => {
        const change = parseFloat(t.changesPercentage || "0");
        const price = parseFloat(t.price || "0");
        const volume = parseInt(t.volume || "0");
        return change >= 7.5 &&
               volume >= 800000 &&
               price >= 8 && price <= 350 &&
               !positions.some(p => p.symbol === t.symbol);
      })
      .slice(0, 4);

    lastGainers = filtered.map(t => ({ symbol: t.symbol, price: t.price }));
    lastScanTime = now;
    console.log(`FMP → ${lastGainers.length} runners: ${lastGainers.map(r => r.symbol).join(", ")}`);
    return lastGainers;

  } catch (e) {
    const status = e.response?.status;
    console.log(`FMP FAILED (${status || e.message}) — using cache`);
    return lastGainers;
  }
}

async function placeOrder(symbol, qty) {
  if (DRY) {
    logTrade("ENTRY", symbol, qty, "market", "DRY MODE");
    return;
  }
  try {
    const res = await axios.post(`${A_BASE}/orders`, {
      symbol, qty, side: "buy", type: "market", time_in_force: "day"
    }, { headers: HEADERS });
    logTrade("ENTRY", symbol, qty, res.data.filled_avg_price || "market", "FMP Top Gainer");
  } catch (e) {
    console.log("Order failed:", e.response?.data?.message || e.message);
  }
}

async function scanAndTrade() {
  await updateEquityAndPositions();
  if (positions.length >= 5) return;

  const runners = await getGainers();
  for (const r of runners) {
    if (positions.length >= 5) break;
    const qty = Math.max(1, Math.floor((accountEquity * 0.02) / r.price));
    await placeOrder(r.symbol, qty);
    await new Promise(r => setTimeout(r, 3500));
  }
}

// Dashboard endpoint
app.get("/", async (req, res) => {
  await updateEquityAndPositions();
  const unrealized = positions.reduce((a, p) => a + p.unrealized_pl, 0);

  res.json({
    bot: "AlphaStream v71.0",
    version: "v71.0",
    status: "ONLINE",
    mode: DRY ? "DRY" : "LIVE",
    dry_mode: DRY,
    positions_count: positions.length,
    max_pos: 5,
    equity: `$${accountEquity.toFixed(2)}`,
    dailyPnL: unrealized >= 0 ? `+$${unrealized.toFixed(2)}` : `-$${Math.abs(unrealized.toFixed(2))}`,
    positions,
    tradeLog: tradeLog.slice(-30),
    backtest: {
      totalTrades: tradeLog.length,
      winRate: "0.0",
      wins: 0,
      losses: 0
    }
  });
});

app.post("/scan", async (req, res) => {
  console.log("Manual scan triggered from dashboard");
  await scanAndTrade();
  res.json({ ok: true });
});

app.get("/healthz", (req, res) => res.send("OK"));

const server = app.listen(Number(PORT), "0.0.0.0", () => {
  console.log(`\nALPHASTREAM v71.0 LIVE`);
  console.log(`Port ${PORT} | Dashboard → https://alphastream-dashboard.vercel.app\n`);
  setInterval(scanAndTrade, 300000); // 5 mins
  scanAndTrade();
});

// Graceful shutdown for Cloud Run
process.on("SIGTERM", () => {
  console.log("SIGTERM received — graceful shutdown");
  server.close(() => {
    console.log("Server closed");
    process.exit(0);
  });
});
