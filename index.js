// index.js — AlphaStream v37.0 — PROP FIRM CHALLENGE CRUSHER (Paper → Funded)
// 7.5%+ gainers, 800k+ volume, max 4 positions, daily loss limit, bulletproof exits
import express from "express";
import cors from "cors";
import axios from "axios";

const app = express();
app.use(cors());
app.use(express.json());

const {
  ALPACA_KEY = "",
  ALPACA_SECRET = "",
  MASSIVE_KEY = "",           // YOUR MASSIVE.COM API KEY
  DRY_MODE = "true",          // SET TO "false" ONLY WHEN ON REAL PROP ACCOUNT
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

console.log(`\nALPHASTREAM v37.0 — PROP FIRM CHALLENGE CRUSHER`);
console.log(`Mode → ${DRY ? "PAPER (Challenge Mode)" : "LIVE (Real Money)"}\n`);

// ==================== STATE ====================
let accountEquity = 100000;
let startingEquityToday = 100000;
let positions = [];
let tradeLog = [];
let backtestResults = { wins: 0, losses: 0, totalPnL: 0, trades: 0 };

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

      backtestResults.trades++;
      backtestResults.totalPnL += pnl;
      if (pnl > 0) backtestResults.wins++;
      else backtestResults.losses++;
    }
  }

  tradeLog.push(trade);
  if (tradeLog.length > 300) tradeLog.shift();

  console.log(`[${type}] ${qty} ${symbol} @ $${price} | ${reason} ${type === "EXIT" ? `| P&L: $${trade.pnl} (${trade.pnlPct}%)` : ""}`);
}

// ==================== ORDERS ====================
async function placeOrder(symbol, qty) {
  if (DRY) {
    logTrade("ENTRY", symbol, qty, "market", "Momentum Signal");
    positions.push({ symbol, qty, entry: 999, current: 999 });
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

    const price = res.data.filled_avg_price || "market";
    logTrade("ENTRY", symbol, qty, price, "Momentum Signal");
  } catch (err) {
    console.log("Order failed:", err?.response?.data?.message || err.message);
  }
}

async function closePosition(symbol, reason = "EOD/TP/SL") {
  const pos = positions.find(p => p.symbol === symbol);
  if (!pos) return;

  if (DRY) {
    logTrade("EXIT", symbol, pos.qty, pos.current || pos.entry, reason);
    positions = positions.filter(p => p.symbol !== symbol);
    return;
  }

  try {
    await axios.delete(`${A_BASE}/positions/${symbol}`, { headers: HEADERS });
    logTrade("EXIT", symbol, pos.qty, pos.current, reason);
    positions = positions.filter(p => p.symbol !== symbol);
  } catch (err) {
    console.log("Close failed:", err?.response?.data?.message || err.message);
  }
}

// ==================== ACCOUNT UPDATE ====================
async function updateEquityAndPositions() {
  if (!ALPACA_KEY || !ALPACA_SECRET) return;

  // Reset daily starting equity at market open
  const now = new Date();
  if (now.getHours() === 9 && now.getMinutes() < 5) {
    startingEquityToday = accountEquity;
  }

  try {
    const [accountRes, positionsRes] = await Promise.all([
      axios.get(`${A_BASE}/account`, { headers: HEADERS }),
      axios.get(`${A_BASE}/positions`, { headers: HEADERS })
    ]);

    accountEquity = parseFloat(accountRes.data.equity || 100000);
    positions = positionsRes.data.map(p => ({
      symbol: p.symbol,
      qty: Number(p.qty),
      entry: parseFloat(p.avg_entry_price),
      current: parseFloat(p.current_price),
      unrealized_pl: parseFloat(p.unrealized_pl)
    }));
  } catch (err) {
    console.error("Alpaca error:", err.message);
  }
}

// ==================== MOMENTUM SCANNER (PROP-OPTIMIZED) ====================
async function getMassiveGainers() {
  if (!MASSIVE_KEY) return [];

  try {
    const res = await axios.get("https://api.massive.com/v1/stocks/snapshot/gainers", {
      headers: { "X-API-Key": MASSIVE_KEY },
      timeout: 10000
    });

    return res.data.data
      .filter(t =>
        t.change_percent > 7.5 &&      // relaxed for daily trades
        t.volume > 800_000 &&
        t.price > 8 &&
        t.price < 350 &&
        !positions.find(p => p.symbol === t.symbol)
      )
      .slice(0, 4)
      .map(t => ({ symbol: t.symbol, price: t.price }));
  } catch (err) {
    console.log("Massive API error:", err.response?.data || err.message);
    return [];
  }
}

// ==================== PROFESSIONAL EXIT RULES ====================
async function checkExits() {
  if (positions.length === 0) return;

  const dailyPnL = accountEquity - startingEquityToday;
  // DAILY LOSS LIMIT – critical for prop firms
  if (dailyPnL <= -0.045 * startingEquityToday) {
    console.log("DAILY DRAWDOWN LIMIT HIT (-4.5%) — FLATTENING ALL");
    for (const pos of positions) await closePosition(pos.symbol, "Daily Loss Limit");
    return;
  }

  for (const pos of positions) {
    if (!pos.entry || !pos.current) continue;
    const gainPct = (pos.current - pos.entry) / pos.entry * 100;

    if (gainPct >= 18) {
      await closePosition(pos.symbol, "Take Profit +18%");
    } else if (gainPct <= -9) {
      await closePosition(pos.symbol, "Stop Loss -9%");
    }
  }
}

// ==================== EOD FORCE CLOSE ====================
function isAfterMarketClose() {
  const now = new Date();
  const etHour = now.getUTCHours() - 4;  // EST
  return etHour >= 16 || (etHour === 15 && now.getUTCMinutes() >= 59);
}

// ==================== MAIN LOOP ====================
async function tradingLoop() {
  await updateEquityAndPositions();

  if (isAfterMarketClose()) {
    if (positions.length > 0) {
      console.log("MARKET CLOSED — CLOSING ALL POSITIONS");
      for (const pos of positions) await closePosition(pos.symbol, "EOD Flatten");
    }
    return;
  }

  await checkExits();

  if (positions.length >= 4) return;

  const signals = await getMassiveGainers();
  for (const s of signals) {
    if (positions.length >= 4) break;
    const qty = Math.max(1, Math.floor(accountEquity * 0.02 / s.price));
    await placeOrder(s.symbol, qty);
  }
}

// ==================== DASHBOARD ====================
app.get("/", async (req, res) => {
  await updateEquityAndPositions();
  const unreal = positions.reduce((sum, p) => sum + p.unrealized_pl, 0);
  const winRate = backtestResults.trades > 0
    ? ((backtestResults.wins / backtestResults.trades) * 100).toFixed(1)
    : "0.0";

  res.json({
    bot: "AlphaStream v37.0 — Prop Challenge Crusher",
    version: "v37.0",
    status: "ONLINE",
    mode: DRY ? "PAPER" : "LIVE",
    equity: `$${accountEquity.toFixed(2)}`,
    dailyPnL: unreal >= 0 ? `+$${unreal.toFixed(2)}` : `-$${Math.abs(unreal).toFixed(2)}`,
    positions: positions.length,
    max_positions: 4,
    total_trades: backtestResults.trades,
    win_rate: `${winRate}%`,
    tradeLog: tradeLog.slice(-50),
    timestamp: new Date().toISOString()
  });
});

app.get("/healthz", (req, res) => res.send("OK"));
app.post("/manual/scan", async (req, res) => {
  await tradingLoop(); res.json({ ok: true });
});

const PORT_NUM = parseInt(PORT, 10);
app.listen(PORT_NUM, "0.0.0.0", () => {
  console.log(`\nALPHASTREAM v37.0 READY — PORT ${PORT_NUM}`);
  console.log(`Dashboard → https://alphastream-dashboard.vercel.app\n`);
  setInterval(tradingLoop, 60000);
  tradingLoop();
});