// index.js — AlphaStream v46.0 — FINAL VERSION (Massive.com Fixed + Dashboard Works)
import express from "express";
import cors from "cors";
import axios from "axios";

const app = express();
app.use(cors());
app.use(express.json());

// ==================== CONFIG (ENV) ====================
const {
  ALPACA_KEY = "",
  ALPACA_SECRET = "",
  MASSIVE_KEY = "",                    // ← Your Massive.com Bearer token
  DRY_MODE = "true",
  MAX_POSITIONS = "5",
  POSITION_RISK_PCT = "0.02",          // 2% per trade
  MIN_GAINER_PCT = "7.5",
  MIN_GAINER_VOLUME = "800000",
  MIN_PRICE = "8",
  MAX_PRICE = "350",
  PORT = "8080"
} = process.env;

const DRY = DRY_MODE.toLowerCase() === "true";
const IS_PAPER = DRY || ALPACA_KEY.startsWith("PK");
const A_BASE = IS_PAPER
  ? "https://paper-api.alpaca.markets/v2"
  : "https://api.alpaca.markets/v2";

const HEADERS = {
  "APCA-API-KEY-ID": ALPACA_KEY,
  "APCA-API-SECRET-KEY": ALPACA_SECRET
};

// ==================== STATE ====================
let accountEquity = 100000;
let positions = [];
let tradeLog = [];
let stats = { wins: 0, losses: 0, totalPnL: 0, trades: 0 };

// ==================== LOGGING + STATS ====================
function logTrade(type, symbol, qty, price, reason = "") {
  const trade = {
    id: Date.now().toString(36) + Math.random().toString(36).substr(2, 9),
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
      if (pnl > 0) stats.wins++;
      else stats.losses++;
    }
  }

  tradeLog.push(trade);
  if (tradeLog.length > 200) tradeLog.shift();

  console.log(
    `[${type}] ${symbol} ×${qty} @ $${price} | ${reason}` +
    (trade.pnl ? ` → P&L: $${trade.pnl} (${trade.pnlPct}%)` : "")
  );
}

// ==================== ALPACA: ORDERS ====================
async function placeOrder(symbol, qty) {
  if (DRY) {
    logTrade("ENTRY", symbol, qty, "market", "DRY MODE");
    return;
  }

  try {
    const res = await axios.post(
      `${A_BASE}/orders`,
      { symbol, qty, side: "buy", type: "market", time_in_force: "day" },
      { headers: HEADERS, timeout: 12000 }
    );
    const price = res.data.filled_avg_price || "market";
    logTrade("ENTRY", symbol, qty, price, "Massive Top Mover");
  } catch (err) {
    console.log("Order failed:", err?.response?.data?.message || err.message);
  }
}

async function closePosition(symbol) {
  const pos = positions.find(p => p.symbol === symbol);
  if (!pos) return;

  if (DRY) {
    logTrade("EXIT", symbol, pos.qty, pos.current, "DRY EOD");
    return;
  }

  try {
    await axios.delete(`${A_BASE}/positions/${symbol}`, { headers: HEADERS });
    logTrade("EXIT", symbol, pos.qty, pos.current, "TP/SL or EOD");
  } catch (err) {
    console.log("Close failed:", err?.response?.data?.message || err.message);
  }
}

// ==================== ALPACA: ACCOUNT & POSITIONS ====================
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
    console.log("Alpaca sync error:", err.message);
  }
}

// ==================== MASSIVE.COM: TOP MOVERS (FIXED) ====================
async function getMassiveGainers() {
  if (!MASSIVE_KEY) {
    console.log("MASSIVE_KEY missing → scan skipped");
    return [];
  }

  try {
    const res = await axios.get(
      "https://api.massive.com/v2/snapshot/locale/us/markets/stocks/gainers",
      {
        headers: {
          Authorization: `Bearer ${MASSIVE_KEY}`,
          Accept: "application/json"
        },
        timeout: 12000
      }
    );

    const gainers = res.data?.tickers || [];
    console.log(`Massive returned ${gainers.length} top gainers`);

    return gainers
      .filter(t =>
        t.todaysChangePerc >= Number(MIN_GAINER_PCT) &&
        t.volume >= Number(MIN_GAINER_VOLUME) &&
        t.price >= Number(MIN_PRICE) &&
        t.price <= Number(MAX_PRICE) &&
        !positions.some(p => p.symbol === t.symbol)
      )
      .slice(0, Number(MAX_POSITIONS))
      .map(t => ({ symbol: t.symbol, price: t.price }));

  } catch (err) {
    console.log("Massive API Error:", err.response?.status, err.response?.data?.message || err.message);
    return [];
  }
}

// ==================== CORE TRADING LOOP ====================
async function tradingLoop() {
  await updateEquityAndPositions();

  if (positions.length >= Number(MAX_POSITIONS)) {
    console.log(`Max positions reached (${positions.length}/${MAX_POSITIONS})`);
    return;
  }

  const candidates = await getMassiveGainers();
  if (candidates.length === 0) return;

  for (const c of candidates) {
    if (positions.length >= Number(MAX_POSITIONS)) break;

    const riskPct = Number(POSITION_RISK_PCT);
    const qty = Math.max(1, Math.floor((accountEquity * riskPct) / c.price));

    await placeOrder(c.symbol, qty);
    await new Promise(r => setTimeout(r, 2000)); // Be nice to rate limits
  }
}

// ==================== DASHBOARD API ====================
app.get("/", async (req, res) => {
  await updateEquityAndPositions();
  const unrealizedPnL = positions.reduce((sum, p) => sum + p.unrealized_pl, 0);
  const winRate = stats.trades > 0 ? ((stats.wins / stats.trades) * 100).toFixed(1) : "0.0";

  res.json({
    bot: "AlphaStream v46.0",
    version: "v46.0",
    status: "ONLINE",
    mode: DRY ? "DRY" : "LIVE",
    dry_mode: DRY,
    positions_count: positions.length,
    max_pos: Number(MAX_POSITIONS),
    equity: `$${accountEquity.toFixed(2)}`,
    dailyPnL: unrealizedPnL >= 0 ? `+$${unrealizedPnL.toFixed(2)}` : `-$${Math.abs(unrealizedPnL).toFixed(2)}`,
    positions,
    tradeLog: tradeLog.slice(-30),
    backtest: {
      totalTrades: stats.trades,
      winRate: `${winRate}%`,
      totalPnL: stats.totalPnL.toFixed(2),
      wins: stats.wins,
      losses: stats.losses
    },
    timestamp: new Date().toISOString()
  });
});

app.get("/healthz", (req, res) => res.send("OK"));

// This endpoint makes your "FORCE SCAN" button work instantly
app.post("/scan", async (req, res) => {
  console.log("Manual scan triggered from dashboard");
  await tradingLoop();
  res.json({ ok: true, message: "Scan complete" });
});

// ==================== START ====================
const PORT_NUM = Number(PORT);
app.listen(PORT_NUM, "0.0.0.0", () => {
  console.log(`\nAlphaStream v46.0 LIVE on port ${PORT_NUM}`);
  console.log(`Dashboard: https://alphastream-dashboard.vercel.app`);
  console.log(`Mode: ${DRY ? "DRY (Paper)" : "LIVE"}\n`);

  // Start automated scanning
  setInterval(tradingLoop, 60_000);
  tradingLoop(); // Run immediately on start
});
