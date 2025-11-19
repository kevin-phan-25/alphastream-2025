// index.js — AlphaStream v36.0 — REAL MASSIVE.COM + FULLY AUTOMATED + NO HARD CODING
import express from "express";
import cors from "cors";
import axios from "axios";

const app = express();
app.use(cors());
app.use(express.json());

const {
  ALPACA_KEY = "",
  ALPACA_SECRET = "",
  MASSIVE_KEY = "",           // ← YOUR MASSIVE.COM API KEY
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

console.log(`\nALPHASTREAM v36.0 — REAL MASSIVE.COM SCANNING`);
console.log(`Mode → ${DRY ? "DRY (Paper)" : "LIVE (Real Money)"}\n`);

// ==================== STATE ====================
let accountEquity = 100000;
let positions = [];
let tradeLog = [];
let backtestResults = { wins: 0, losses: 0, totalPnL: 0, trades: 0 };

// ==================== LOGGING + WIN RATE ====================
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
    const entry = tradeLog.find(t => t.type === "ENTRY" && t.symbol === symbol);
    if (entry) {
      const pnl = (price - entry.price) * qty;
      const pnlPct = ((pnl / (entry.price * qty)) * 100).toFixed(2);
      trade.pnl = pnl.toFixed(2);
      trade.pnlPct = pnlPct;

      backtestResults.trades++;
      backtestResults.totalPnL += pnl;
      if (pnl > 0) backtestResults.wins++;
      else backtestResults.losses++;
    }
  }

  tradeLog.push(trade);
  if (tradeLog.length > 200) tradeLog.shift();

  console.log(`[TRADE ${type}] ${qty} ${symbol} @ $${price} | ${reason} ${type === "EXIT" ? `| P&L: $${trade.pnl} (${trade.pnlPct}%)` : ""}`);
}

// ==================== ORDER EXECUTION ====================
async function placeOrder(symbol, qty, side = "buy") {
  if (DRY) {
    logTrade("ENTRY", symbol, qty, "market", "DRY MODE");
    return;
  }
  try {
    const res = await axios.post(`${A_BASE}/orders`, {
      symbol,
      qty,
      side,
      type: "market",
      time_in_force: "day"
    }, { headers: HEADERS, timeout: 10000 });

    const filledPrice = res.data.filled_avg_price || "market";
    logTrade("ENTRY", symbol, qty, filledPrice, "Massive Momentum Signal");
    return res.data;
  } catch (err) {
    console.log("Order failed:", err?.response?.data?.message || err.message);
  }
}

async function closePosition(symbol) {
  if (DRY) {
    const pos = positions.find(p => p.symbol === symbol);
    if (pos) logTrade("EXIT", symbol, pos.qty, pos.current || pos.entry, "EOD Close");
    return;
  }
  try {
    await axios.delete(`${A_BASE}/positions/${symbol}`, { headers: HEADERS });
    const pos = positions.find(p => p.symbol === symbol);
    if (pos) logTrade("EXIT", symbol, pos.qty, pos.current, "EOD Close");
  } catch (err) {
    console.log("Close failed:", err?.response?.data?.message || err.message);
  }
}

// ==================== EQUITY & POSITIONS ====================
async function updateEquityAndPositions() {
  if (!ALPACA_KEY || !ALPACA_SECRET) return;
  try {
    const [accountRes, positionsRes] = await Promise.all([
      axios.get(`${A_BASE}/account`, { headers: HEADERS, timeout: 12000 }),
      axios.get(`${A_BASE}/positions`, { headers: HEADERS, timeout: 12000 })
    ]);

    accountEquity = parseFloat(accountRes.data.equity || 100000);
    positions = positionsRes.data.map(p => ({
      symbol: p.symbol,
      qty: Number(p.qty),
      entry: parseFloat(p.avg_entry_price),
      current: parseFloat(p.current_price),
      market_value: parseFloat(p.market_value),
      unrealized_pl: parseFloat(p.unrealized_pl),
      unrealized_plpc: parseFloat(p.unrealized_plpc) * 100
    }));
  } catch (err) {
    console.error("Alpaca fetch error:", err.message);
  }
}

// ==================== MASSIVE.COM REAL SCANNER ====================
async function getMassiveGainers() {
  if (!MASSIVE_KEY) {
    console.log("MASSIVE_KEY not set → skipping scan");
    return [];
  }

  try {
    const res = await axios.get("https://api.massive.com/v1/stocks/snapshot/gainers", {
      headers: { "X-API-Key": MASSIVE_KEY },
      timeout: 10000
    });

    return res.data.data
      .filter(t => 
        t.change_percent > 12 &&
        t.volume > 2_000_000 &&
        t.price > 10 &&
        t.price < 500 &&
        !positions.find(p => p.symbol === t.symbol)
      )
      .slice(0, 5)
      .map(t => ({
        symbol: t.symbol,
        price: t.price,
        change: t.change_percent
      }));
  } catch (err) {
    console.log("Massive API error:", err.response?.data || err.message);
    return [];
  }
}

// ==================== TRADING LOOP (FULLY AUTOMATED) ====================
async function tradingLoop() {
  await updateEquityAndPositions();

  // Close all at end of day (optional — remove if you want overnight)
  const now = new Date();
  if (now.getHours() === 15 && now.getMinutes() >= 55) {
    for (const pos of positions) await closePosition(pos.symbol);
    return;
  }

  if (positions.length >= 5) return;

  const signals = await getMassiveGainers();
  for (const s of signals) {
    if (positions.length >= 5) break;
    const qty = Math.max(1, Math.floor(accountEquity * 0.02 / s.price));
    await placeOrder(s.symbol, qty);
  }
}

// ==================== DASHBOARD ENDPOINT (100% COMPATIBLE) ====================
app.get("/", async (req, res) => {
  await updateEquityAndPositions();
  const totalPnL = positions.reduce((sum, p) => sum + p.unrealized_pl, 0);
  const winRate = backtestResults.trades > 0
    ? ((backtestResults.wins / backtestResults.trades) * 100).toFixed(1)
    : "0.0";

  res.json({
    bot: "AlphaStream v36.0 — Massive.com Live",
    version: "v36.0",
    status: "ONLINE",
    mode: DRY ? "DRY" : "LIVE",
    dry_mode: DRY,
    positions_count: positions.length,
    max_pos: 5,
    equity: `$${accountEquity.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
    dailyPnL: totalPnL >= 0 ? `+$${totalPnL.toFixed(2)}` : `-$${Math.abs(totalPnL).toFixed(2)}`,
    positions,
    tradeLog: tradeLog.slice(-30),
    backtest: {
      totalTrades: backtestResults.trades,
      winRate: `${winRate}%`,
      totalPnL: backtestResults.totalPnL.toFixed(2),
      wins: backtestResults.wins,
      losses: backtestResults.losses
    },
    timestamp: new Date().toISOString()
  });
});

app.get("/healthz", (req, res) => res.send("OK"));
app.post("/manual/scan", async (req, res) => {
  await tradingLoop();
  res.json({ ok: true });
});

const PORT_NUM = parseInt(PORT, 10);
app.listen(PORT_NUM, "0.0.0.0", () => {
  console.log(`\nALPHASTREAM v36.0 LIVE ON PORT ${PORT_NUM}`);
  console.log(`Dashboard → https://alphastream-dashboard.vercel.app\n`);
  setInterval(tradingLoop, 60000);
  tradingLoop();
});
