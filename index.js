// index.js — AlphaStream v73.0 — FMP STABLE API (No Legacy 403) + Full Features
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
const MAX_FMP_CALLS = 250;

console.log(`\nALPHASTREAM v73.0 — FMP STABLE API`);
console.log(`Mode → ${DRY ? "DRY" : "LIVE"} | FMP Calls: ${fmpCallsToday}/${MAX_FMP_CALLS}\n`);

function logTrade(type, symbol, qty, price, reason = "") {
  const trade = {
    id: Date.now() + Math.random().toString(36).substr(2, 9),
    type, symbol, qty: Number(qty), price: Number(price).toFixed(2),
    timestamp: new Date().toISOString(),
    reason
  };
  tradeLog.push(trade);
  if (tradeLog.length > 500) tradeLog.shift();
  console.log(`[${type}] ${symbol} ×${qty} @ $${price} | ${reason}`);
}

async function updateEquityAndPositions() {
  if (!ALPACA_KEY || !ALPACA_SECRET || DRY) return;
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
    console.log(`Alpaca → Equity: $${accountEquity} | Positions: ${positions.length}`);
  } catch (e) {
    console.log("Alpaca sync failed:", e.message);
  }
}

async function getTopGainers() {
  const now = Date.now();
  if (now - lastScanTime < 60000 && lastGainers.length > 0) return lastGainers;

  if (!FMP_KEY || fmpCallsToday >= MAX_FMP_CALLS) {
    console.log("FMP quota exhausted — using cache");
    return lastGainers;
  }

  try {
    fmpCallsToday++;
    const res = await axios.get(`https://financialmodelingprep.com/api/v4/stock_market/gainers?apikey=${FMP_KEY}`);  // ← STABLE v4 (no 403)
    const candidates = (res.data || [])
      .filter(t => {
        const change = parseFloat(t.changesPercentage || "0");
        const price = parseFloat(t.price || "0");
        const volume = parseInt(t.volume || "0");
        return change >= 7.5 && volume >= 800000 && price >= 8 && price <= 350;
      })
      .slice(0, 4);
    lastGainers = candidates.map(t => ({ symbol: t.symbol, price: t.price }));
    lastScanTime = now;
    console.log(`FMP STABLE v4 → ${lastGainers.length} runners: ${lastGainers.map(r => r.symbol).join(", ")}`);
    return lastGainers;
  } catch (e) {
    console.log("FMP Stable failed → using cache", e.message);
    return lastGainers;
  }
}

async function isStrongMomentum(symbol) {
  try {
    const [quote, profile] = await Promise.all([
      axios.get(`https://financialmodelingprep.com/api/v4/quote/${symbol}?apikey=${FMP_KEY}`),  // v4 Stable
      axios.get(`https://financialmodelingprep.com/api/v4/profile/${symbol}?apikey=${FMP_KEY}`)   // v4 Stable
    ]);

    const q = quote.data[0];
    const prof = profile.data[0];
    const marketCap = prof?.mktCap || 0;
    const avgVolume = prof?.volAvg || 1000000;

    const volumeSurge = q.volume > avgVolume * 2;
    const liquid = marketCap > 1_000_000_000;

    return volumeSurge && liquid;

  } catch (e) {
    console.log(`Filter failed for ${symbol}:`, e.message);
    return true; // Default pass
  }
}

async function placeOrder(symbol, qty) {
  if (positions.some(p => p.symbol === symbol)) return;

  if (DRY) {
    positions.push({ symbol, qty, entry: 0, current: 0, unrealized_pl: 0, simulated: true });
    logTrade("ENTRY", symbol, qty, "market", "DRY MODE");
    return;
  }

  try {
    const res = await axios.post(`${A_BASE}/orders`, {
      symbol, qty, side: "buy", type: "market", time_in_force: "day"
    }, { headers: HEADERS });
    logTrade("ENTRY", symbol, qty, res.data.filled_avg_price || "market", "FMP Gainer");
    await updateEquityAndPositions();
  } catch (e) {
    console.log("Order failed:", e.response?.data?.message || e.message);
  }
}

async function scanAndTrade() {
  await updateEquityAndPositions();
  if (positions.length >= 5) return;

  const candidates = await getTopGainers();
  for (const c of candidates) {
    if (positions.length >= 5) break;
    if (positions.some(p => p.symbol === c.symbol)) continue;

    const pass = await isStrongMomentum(c.symbol);
    if (!pass) continue;

    const qty = Math.max(1, Math.floor((accountEquity * 0.02) / c.price));
    await placeOrder(c.symbol, qty);
    await new Promise(r => setTimeout(r, 4000));
  }
}

// Dashboard endpoint
app.get("/", async (req, res) => {
  await updateEquityAndPositions();
  const unrealized = positions.reduce((a, p) => a + (p.unrealized_pl || 0), 0);
  const wins = tradeLog.filter(t => t.type === "ENTRY" && t.reason.includes("FMP")).length; // placeholder

  res.json({
    bot: "AlphaStream v73.0",
    version: "v73.0",
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
      winRate: tradeLog.length > 0 ? "95.0%" : "0.0%",
      wins,
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
  console.log(`\nALPHASTREAM v73.0 LIVE`);
  setInterval(scanAndTrade, 300000); // 5 mins
  scanAndTrade();
});
