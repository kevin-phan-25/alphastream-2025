// index.js — AlphaStream v60.1 — FMP Full Power (Secrets via env)
import express from "express";
import cors from "cors";
import axios from "axios";

const app = express();
app.use(cors());
app.use(express.json());

const {
  ALPACA_KEY = "",
  ALPACA_SECRET = "",
  FMP_KEY = "",              // ← NOW FROM GITHUB / VERCEL SECRETS
  DRY_MODE = "true",
  PORT = "8080"
} = process.env;

if (!FMP_KEY) {
  console.error("FMP_KEY is missing! Add it to GitHub Secrets / Vercel Env");
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

console.log(`\nALPHASTREAM v60.1 — FMP FULL API (Secure`);
console.log(`Mode → ${DRY ? "DRY (Paper)" : "LIVE (Real Money)"}\n`);

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
      symbol, qty, side: "buy", type: "market", time_in_force: "day"
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

// ==================== FMP TOP GAINERS + FILTERS ====================
async function getTopGainers() {
  try {
    const res = await axios.get("https://financialmodelingprep.com/api/v3/stock_market/gainers", {
      params: { apikey: FMP_KEY },
      timeout: 10000
    });

    const gainers = res.data || [];
    console.log(`FMP Gainers Scan: ${gainers.length} found`);

    return gainers
      .filter(t =>
        parseFloat(t.changesPercentage) >= 7.5 &&
        t.volume >= 800000 &&
        t.price >= 8 &&
        t.price <= 350 &&
        !positions.some(p => p.symbol === t.symbol)
      )
      .slice(0, 4)
      .forEach(c => {
        const qty = Math.max(1, Math.floor((accountEquity * 0.02) / c.price));
        placeOrder(c.symbol, qty);
      });

  } catch (err) {
    console.log("FMP scan failed:", err.response?.status || err.message);
  }
}

// ==================== MAIN LOOP ====================
async function tradingLoop() {
  await updateEquityAndPositions();
  if (positions.length >= 5) return;
  await getTopGainers();
}

// ==================== DASHBOARD ENDPOINT ====================
app.get("/", async (req, res) => {
  await updateEquityAndPositions();
  const unrealized = positions.reduce((s, p) => s + p.unrealized_pl, 0);
  const winRate = stats.trades > 0 ? ((stats.wins / stats.trades) * 100).toFixed(1) : "0.0";

  res.json({
    bot: "AlphaStream v60.1",
    version: "v60.1",
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
    },
    timestamp: new Date().toISOString()
  });
});

app.post("/manual/scan", async (req, res) => {
  console.log("Manual scan triggered");
  await tradingLoop();
  res.json({ ok: true });
});

app.get("/healthz", (req, res) => res.send("OK"));

app.listen(Number(PORT), "0.0.0.0", () => {
  console.log(`ALPHASTREAM v60.1 LIVE — FMP SECURE`);
  console.log(`Dashboard → https://alphastream-dashboard.vercel.app\n`);
  setInterval(tradingLoop, 60000);
  tradingLoop();
});
