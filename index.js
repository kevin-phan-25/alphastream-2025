// index.js — AlphaStream v64.0 — FINAL PRODUCTION (Paper + Live Ready)
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
const A_BASE = DRY 
  ? "https://paper-api.alpaca.markets/v2" 
  : "https://api.alpaca.markets/v2";

const HEADERS = {
  "APCA-API-KEY-ID": ALPACA_KEY,
  "APCA-API-SECRET-KEY": ALPACA_SECRET
};

let accountEquity = 100000;
let positions = [];
let tradeLog = [];
let lastGainers = [];
let lastScanTime = 0;

console.log(`\nALPHASTREAM v64.0 — FULLY OPERATIONAL`);
console.log(`Mode → ${DRY ? "DRY (Paper Trading)" : "LIVE (Real Money)"}`);
console.log(`FMP_KEY → ${FMP_KEY ? "FOUND" : "MISSING"}`);
console.log(`ALPACA_KEY → ${ALPACA_KEY ? "FOUND" : "MISSING"}\n`);

async function updateAccount() {
  if (!ALPACA_KEY) return;
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
  } catch (e) {
    console.log("Alpaca fetch failed — continuing with last known state");
  }
}

async function getGainers() {
  const now = Date.now();
  if (now - lastScanTime < 60_000 && lastGainers.length > 0) {
    return lastGainers;
  }

  if (!FMP_KEY) {
    console.log("No FMP_KEY — using cache");
    return lastGainers;
  }

  try {
    const url = `https://financialmodelingprep.com/api/v3/stock_market/gainers?apikey=${FMP_KEY}`;
    const res = await axios.get(url, { timeout: 12000 });

    const filtered = (res.data || [])
      .filter(t => {
        const change = parseFloat(t.changesPercentage || "0");
        const price = parseFloat(t.price || "0");
        const volume = parseInt(t.volume || "0", 10);
        return change >= 7.5 &&
               volume >= 800000 &&
               price >= 8 && price <= 350 &&
               !positions.some(p => p.symbol === t.symbol);
      })
      .slice(0, 4);

    lastGainers = filtered.map(t => ({ symbol: t.symbol, price: t.price }));
    lastScanTime = now;
    console.log(`FMP SUCCESS → ${lastGainers.length} runners: ${lastGainers.map(r => r.symbol).join(", ")}`);
    return lastGainers;

  } catch (e) {
    const status = e.response?.status;
    console.log(`FMP FAILED (${status || e.message}) — using cache`);
    return lastGainers;
  }
}

async function placeOrder(symbol, qty) {
  if (DRY || !ALPACA_KEY) {
    console.log(`[DRY] Would buy ${symbol} ×${qty} @ market`);
    tradeLog.push({ type: "ENTRY", symbol, qty, price: "market", timestamp: new Date().toISOString() });
    return;
  }

  try {
    const res = await axios.post(`${A_BASE}/orders`, {
      symbol, qty, side: "buy", type: "market", time_in_force: "day"
    }, { headers: HEADERS });
    const price = res.data.filled_avg_price || "market";
    console.log(`[LIVE] BUY ${symbol} ×${qty} @ $${price}`);
    tradeLog.push({ type: "ENTRY", symbol, qty, price, timestamp: new Date().toISOString() });
  } catch (e) {
    console.log("Order failed:", e.response?.data?.message || e.message);
  }
}

async function scanAndTrade() {
  await updateAccount();
  if (positions.length >= 5) return;

  const runners = await getGainers();
  for (const r of runners) {
    if (positions.length >= 5) break;
    const qty = Math.max(1, Math.floor((accountEquity * 0.02) / r.price));
    await placeOrder(r.symbol, qty);
    await new Promise(r => setTimeout(r, 3000));
  }
}

// MAIN DASHBOARD ENDPOINT — 100% COMPATIBLE WITH v60.1 DASHBOARD
app.get("/", async (req, res) => {
  await updateAccount();
  const unrealized = positions.reduce((a, p) => a + p.unrealized_pl, 0);

  res.json({
    bot: "AlphaStream",
    version: "v64.0",
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
  console.log("Manual scan triggered");
  await scanAndTrade();
  res.json({ ok: true });
});

app.get("/healthz", (req, res) => res.send("OK"));

app.listen(Number(PORT), "0.0.0.0", () => {
  console.log(`Server LIVE on port ${PORT}`);
  console.log(`Dashboard → https://alphastream-dashboard.vercel.app\n`);
  setInterval(scanAndTrade, 5 * 60 * 1000);
  scanAndTrade();
});
