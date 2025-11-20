// index.js — AlphaStream v62.0 — 100% FMP (NO RSS, NO CHEERIO)
import express from "express";
import cors from "cors";
import axios from "axios";

const app = express();
app.use(cors());
app.use(express.json());

const {
  ALPACA_KEY = "",
  ALPACA_SECRET = "",
  FMP_KEY = "",           // ← From GitHub Secrets / Cloud Run env
  DRY_MODE = "true",
  PORT = "8080"
} = process.env;

// CRITICAL: Stop deployment if FMP_KEY missing
if (!FMP_KEY) {
  console.error("FMP_KEY is missing! Add it to GitHub Secrets or Cloud Run env");
  process.exit(1);
}

const DRY = DRY_MODE.toLowerCase() === "true";
const IS_PAPER = DRY || ALPACA_KEY.startsWith("PK");
const A_BASE = IS_PAPER
  ? "https://paper-api.alpaca.markets/v2"
  : "https://api.alpaca.markets/v2";

const HEADERS = {
  "APCA-API-KEY-ID": ALPACA_KEY,
  "APCA-API-SECRET-KEY": ALPACA_SECRET
};

let accountEquity = 100000;
let positions = [];
let tradeLog = [];
let stats = { wins: 0, losses: 0, totalPnL: 0, trades: 0 };

console.log(`\nALPHASTREAM v62.0 — PURE FMP GAINERS`);
console.log(`Mode → ${DRY ? "DRY (Paper)" : "LIVE (Real Money)"}`);
console.log(`FMP calls used today: ~250 max allowed\n`);

// ==================== LOGGING ====================
function logTrade(type, symbol, qty, price, reason = "") {
  const trade = {
    id: Date.now() + Math.random().toString(36).substr(2, 9),
    type,
    symbol,
    qty: Number(qty),
    price: Number(price).toFixed(2),
    timestamp: new Date().toISOString(),
    reason
  };

  if (type === "EXIT") {
    const entry = tradeLog.findLast(t => t.type === "ENTRY" && t.symbol === symbol);
    if (entry) {
      const pnl = (price - entry.price) * qty;
      const pnlPct = ((pnl / (entry.price * qty)) * 100).toFixed(2);
      trade.pnl = pnl.toFixed(2);
      trade.pnlPct = pnlPct;
      stats.trades++;
      stats.totalPnL += pnl;
      pnl > 0 ? stats.wins++ : stats.losses++;
    }
  }

  tradeLog.push(trade);
  if (tradeLog.length > 200) tradeLog.shift();
  console.log(`[${type}] ${symbol} ×${qty} @ $${price} | ${reason}`);
}

// ==================== ORDERS ====================
async function placeOrder(symbol, qty) {
  if (DRY) {
    logTrade("ENTRY", symbol, qty, "market", "DRY MODE");
    return;
  }
  try {
    const res = await axios.post(`${A_BASE}/orders`, {
      symbol,
      qty,
      side: "buy",
      type: "market",
      time_in_force: "day"
    }, { headers: HEADERS, timeout: 10000 });
    logTrade("ENTRY", symbol, qty, res.data.filled_avg_price || "market", "FMP Top Gainer");
  } catch (err) {
    console.log("Order failed:", err?.response?.data?.message || err.message);
  }
}

// ==================== ACCOUNT & POSITIONS ====================
async function updateEquityAndPositions() {
  if (!ALPACA_KEY || !ALPACA_SECRET) return;
  try {
    const [acct, pos] = await Promise.all([
      axios.get(`${A_BASE}/account`, { headers: HEADERS }),
      axios.get(`${A_BASE}/positions`, { headers: HEADERS })
    ]);
    accountEquity = parseFloat(acct.data.equity || 100000);
    positions = pos.data.map(p => ({
      symbol: p.symbol,
      qty: Number(p.qty),
      entry: Number(p.avg_entry_price),
      current: Number(p.current_price),
      unrealized_pl: Number(p.unrealized_pl)
    }));
  } catch (err) {
    console.log("Alpaca fetch error:", err.message);
  }
}

// ==================== PURE FMP TOP GAINERS ====================
async function getTopGainers() {
  try {
    const res = await axios.get("https://financialmodelingprep.com/api/v3/stock_market/gainers", {
      params: { apikey: FMP_KEY },
      timeout: 10000
    });

    const gainers = res.data || [];
    console.log(`FMP returned ${gainers.length} gainers`);

    const candidates = gainers
      .filter(t =>
        parseFloat(t.changesPercentage || 0) >= 7.5 &&
        t.volume >= 800000 &&
        t.price >= 8 &&
        t.price <= 350 &&
        !positions.some(p => p.symbol === t.symbol)
      )
      .slice(0, 4);

    console.log(`Filtered ${candidates.length} valid runners`);
    return candidates.map(t => ({ symbol: t.symbol, price: t.price }));

  } catch (err) {
    console.log("FMP gainers failed:", err.response?.status || err.message);
    return [];
  }
}

// ==================== TRADING LOOP ====================
async function tradingLoop() {
  await updateEquityAndPositions();
  if (positions.length >= 5) {
    console.log("Max 5 positions reached — skipping scan");
    return;
  }

  const candidates = await getTopGainers();
  for (const c of candidates) {
    if (positions.length >= 5) break;
    const qty = Math.max(1, Math.floor((accountEquity * 0.02) / c.price));
    await placeOrder(c.symbol, qty);
    await new Promise(r => setTimeout(r, 3500)); // Stay under 5 calls/min
  }
}

// ==================== DASHBOARD ====================
app.get("/", async (req, res) => {
  await updateEquityAndPositions();
  const unrealized = positions.reduce((s, p) => s + p.unrealized_pl, 0, 0);
  const winRate = stats.trades > 0 ? ((stats.wins / stats.trades) * 100).toFixed(1) : "0.0";

  res.json({
    bot: "AlphaStream v62.0",
    version: "v62.0",
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
      winRate: `${winRate}%`,
      wins: stats.wins,
      losses: stats.losses
    }
  });
});

app.post("/scan", async (req, res) => {
  console.log("Manual scan triggered from dashboard");
  await tradingLoop();
  res.json({ ok: true });
});

app.get("/healthz", (req, res) => res.send("OK"));

const server = app.listen(Number(PORT), "0.0.0.0", () => {
  console.log(`\nALPHASTREAM v62.0 LIVE — 100% FMP`);
  console.log(`Listening on port ${PORT}`);
  console.log(`Dashboard → https://alphastream-dashboard.vercel.app\n`);
  setInterval(tradingLoop, 60000);
  tradingLoop();
});

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("SIGTERM received — shutting down");
  server.close(() => process.exit(0));
});
