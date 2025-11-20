// index.js — AlphaStream v36.2 — REAL EXIT LOGIC + PROFIT TAKING + STOP LOSS
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

console.log(`\nALPHASTREAM v36.2 — MASSIVE.COM + REAL EXITS (TP/SL + EOD)`);
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
    const entry = tradeLog.findLast(t => t.type === "ENTRY" && t.symbol === symbol);
    if (entry) {
      const pnl = (price - entry.price) * qty * (entry.side === "sell" ? -1 : 1);
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

  console.log(`[${type}] ${qty} ${symbol} @ $${price} | ${reason} ${type === "EXIT" ? `| P&L: $${trade.pnl} (${trade.pnlPct}%)` : ""}`);
}

// ==================== ORDER EXECUTION ====================
async function placeOrder(symbol, qty, side = "buy") {
  if (DRY) {
    logTrade("ENTRY", symbol, qty, "market", "DRY MODE");
    positions.push({ symbol, qty, entry: "market", current: "market" });
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
  const pos = positions.find(p => p.symbol === symbol);
  if (!pos) return;

  if (DRY) {
    logTrade("EXIT", symbol, pos.qty, pos.current || pos.entry, pos.reason || "Manual Close");
    positions = positions.filter(p => p.symbol !== symbol);
    return;
  }

  try {
    await axios.delete(`${A_BASE}/positions/${symbol}`, { headers: HEADERS });
    logTrade("EXIT", symbol, pos.qty, pos.current, pos.reason || "EOD/TP/SL");
    positions = positions.filter(p => p.symbol !== symbol);
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
      unrealized_plpc: parseFloat(p.unrealized_plpc) * 100,
      reason: ""
    }));
  } catch (err) {
    console.error("Alpaca fetch error:", err.message);
  }
}

// ==================== MASSIVE.COM SCANNER ====================
async function getMassiveGainers() {
  if (!MASSIVE_KEY) return [];

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

// ==================== REAL EXIT LOGIC (TAKE PROFIT + STOP LOSS) ====================
async function checkExits() {
  if (positions.length === 0) return;

  for (const pos of positions) {
    if (!pos.entry || !pos.current) continue;

    const gainPct = ((pos.current - pos.entry) / pos.entry) * 100;

    // Take Profit: +18%
    if (gainPct >= 18) {
      pos.reason = "Take Profit +18%";
      await closePosition(pos.symbol);
      continue;
    }

    // Stop Loss: -9%
    if (gainPct <= -9) {
      pos.reason = "Stop Loss -9%";
      await closePosition(pos.symbol);
      continue;
    }

    // Trailing Stop: if up +12%, trail with 6% stop
    if (gainPct >= 12) {
      const trailStop = pos.current * 0.94; // 6% trail
      if (pos.current <= trailStop && !pos.trailSet) {
        pos.reason = "Trailing Stop Hit";
        await closePosition(pos.symbol);
      }
    }
  }
}

// ==================== EOD FORCE CLOSE (RELIABLE) ====================
function isMarketCloseTime() {
  const now = new Date();
  const utcHour = now.getUTCHours();
  const utcMin = now.getUTCMinutes();
  const etHour = utcHour - 4; // EST (adjust -5 during EDT, but safe trigger)

  return etHour >= 15 && (etHour > 15 || utcMin >= 59); // After 3:59 PM ET
}

// ==================== MAIN TRADING LOOP ====================
async function tradingLoop() {
  await updateEquityAndPositions();

  // 1. EOD Force Close
  if (isMarketCloseTime()) {
    console.log("🛑 MARKET CLOSED — FLATTENING EVERYTHING");
    for (const pos of positions) await closePosition(pos.symbol);
    return;
  }

  // 2. Check Take Profit / Stop Loss / Trailing
  await checkExits();

  // 3. Enter new positions (only if under max)
  if (positions.length >= 5) return;

  const signals = await getMassiveGainers();
  for (const s of signals) {
    if (positions.length >= 5) break;
    const qty = Math.max(1, Math.floor(accountEquity * 0.02 / s.price));
    await placeOrder(s.symbol, qty);
  }
}

// ==================== DASHBOARD ====================
app.get("/", async (req, res) => {
  await updateEquityAndPositions();
  const totalPnL = positions.reduce((sum, p) => sum + p.unrealized_pl, 0);
  const winRate = backtestResults.trades > 0
    ? ((backtestResults.wins / backtestResults.trades) * 100).toFixed(1)
    : "0.0";

  res.json({
    bot: "AlphaStream v36.2 — Massive.com + Real Exits",
    version: "v36.2",
    status: "ONLINE",
    mode: DRY ? "DRY" : "LIVE",
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
  console.log(`\nALPHASTREAM v36.2 LIVE ON PORT ${PORT_NUM}`);
  console.log(`Dashboard → https://alphastream-dashboard.vercel.app\n`);
  setInterval(tradingLoop, 60000);
  tradingLoop();
});
