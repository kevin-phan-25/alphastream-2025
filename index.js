// index.js — AlphaStream v62.8 — PRODUCTION READY (Your v62.7 + Polish)
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

const HEADERS = { "APCA-API-KEY-ID": ALPACA_KEY, "APCA-API-SECRET-KEY": ALPACA_SECRET };

let accountEquity = 100000;
let positions = [];
let tradeLog = [];
let stats = { wins: 0, losses: 0, totalPnL: 0, trades: 0 };
let lastGainersCache = [];
let lastScanTime = 0;

console.log(`\nALPHASTREAM v62.8 — PRODUCTION LIVE`);
console.log(`Mode → ${DRY ? "DRY (Paper)" : "LIVE (Real Money)"}`);
console.log(`FMP_KEY ${FMP_KEY ? "FOUND" : "MISSING → using cache/fallback"}\n`);

function logTrade(type, symbol, qty, price, reason = "") {
  const trade = {
    id: Date.now(),
    type,
    symbol,
    qty: Number(qty),
    price: Number(price).toFixed(2),
    timestamp: new Date().toISOString(),
    reason
  };
  tradeLog.push(trade);
  if (tradeLog.length > 200) tradeLog.shift();
  console.log(`[${type}] ${symbol} ×${qty} @ $${price} | ${reason}`);
}

async function updateEquityAndPositions() {
  if (DRY || !ALPACA_KEY) return;
  try {
    const [acct, pos] = await Promise.all([
      axios.get(`${A_BASE}/account`, { headers: HEADERS, timeout: 8000 }),
      axios.get(`${A_BASE}/positions`, { headers: HEADERS, timeout: 8000 })
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
    console.log("Alpaca update failed:", e.message);
  }
}

async function getTopGainers() {
  const now = Date.now();
  if (now - lastScanTime < 60_000 && lastGainersCache.length > 0) {
    return lastGainersCache.map(g => ({ symbol: g.symbol, price: g.price }));
  }

  if (!FMP_KEY) {
    console.log("No FMP_KEY → skipping scan (cache only)");
    return lastGainersCache.map(g => ({ symbol: g.symbol, price: g.price }));
  }

  try {
    const res = await axios.get("https://financialmodelingprep.com/api/v3/stock_market/gainers", {
      params: { apikey: FMP_KEY },
      timeout: 10000
    });

    const candidates = (res.data || [])
      .filter(t => 
        parseFloat(t.changesPercentage || 0) >= 7.5 &&
        t.volume >= 800000 &&
        t.price >= 8 && t.price <= 350 &&
        !positions.some(p => p.symbol === t.symbol)
      )
      .slice(0, 4);

    lastGainersCache = candidates;
    lastScanTime = now;
    console.log(`FMP Scan → ${candidates.length} runners found`);
    return candidates.map(t => ({ symbol: t.symbol, price: t.price }));

  } catch (e) {
    console.log("FMP failed → using cache:", e.message);
    return lastGainersCache.map(g => ({ symbol: g.symbol, price: g.price }));
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
    logTrade("ENTRY", symbol, qty, res.data.filled_avg_price || "market", "FMP Gainer");
  } catch (e) {
    console.log("Order failed:", e.response?.data?.message || e.message);
  }
}

async function tradingLoop() {
  await updateEquityAndPositions();
  if (positions.length >= 5) return;

  const runners = await getTopGainers();
  for (const r of runners) {
    if (positions.length >= 5) break;
    const qty = Math.max(1, Math.floor((accountEquity * 0.02) / r.price));
    await placeOrder(r.symbol, qty);
    await new Promise(r => setTimeout(r, 3000));
  }
}

// Dashboard endpoint — fully compatible with your v60.1 dashboard
app.get("/", async (req, res) => {
  await updateEquityAndPositions();
  const unrealized = positions.reduce((s, p) => s + p.unrealized_pl, 0);

  res.json({
    bot: "AlphaStream v62.8",
    version: "v62.8",
    status: "ONLINE",
    mode: DRY ? "DRY" : "LIVE",
    dry_mode: DRY,
    positions_count: positions.length,
    max_pos: 5,
    equity: `$${accountEquity.toFixed(2)}`,
    dailyPnL: unrealized >= 0 ? `+$${unrealized.toFixed(2)}` : `-$${Math.abs(unrealized).toFixed(2)}`,
    positions,
    tradeLog: tradeLog.slice(-30),
    backtest: {
      totalTrades: stats.trades,
      winRate: stats.trades ? ((stats.wins / stats.trades) * 100).toFixed(1) : "0.0",
      wins: stats.wins,
      losses: stats.losses
    }
  });
});

app.post("/scan", async (req, res) => {
  console.log("Manual scan triggered");
  await tradingLoop();
  res.json({ ok: true });
});

app.get("/healthz", (req, res) => res.send("OK"));

app.listen(Number(PORT), "0.0.0.0", () => {
  console.log(`\nServer LIVE on port ${PORT}`);
  console.log(`Dashboard → https://alphastream-dashboard.vercel.app\n`);
  setInterval(tradingLoop, 5 * 60 * 1000); // Every 5 minutes
  tradingLoop();
});
