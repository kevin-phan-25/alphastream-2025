// index.js — AlphaStream v35.0 — FULLY AUTONOMOUS + MASSIVE.AI SCANNING
import express from "express";
import cors from "cors";
import axios from "axios";

const app = express();
app.use(cors());
app.use(express.json());

// ==================== ENV ====================
const {
  ALPACA_KEY = "",
  ALPACA_SECRET = "",
  MASSIVE_KEY = "",
  DRY_MODE = "false",
  PORT = "8080"
} = process.env;

const DRY = String(DRY_MODE).toLowerCase() === "true";
const IS_PAPER = DRY || (ALPACA_KEY.startsWith("PK"));

const A_BASE = IS_PAPER
  ? "https://paper-api.alpaca.markets/v2"
  : "https://api.alpaca.markets/v2";

const HEADERS = {
  "APCA-API-KEY-ID": ALPACA_KEY,
  "APCA-API-SECRET-KEY": ALPACA_SECRET
};

console.log(`\n🔵 AlphaStream v35.0 — Fully Autonomous Trading`);
console.log(`Mode → ${DRY ? "DRY (Paper)" : "LIVE (Real Money)"}`);
console.log(`Massive.ai Connected → ${!!MASSIVE_KEY}\n`);

// ==================== STATE ====================
let accountEquity = 100000;
let positions = [];
let tradeLog = []; 
let metrics = {
  wins: 0,
  losses: 0,
  pnl: 0,
  trades: 0,
  uptime: 0,
  started: new Date().toISOString()
};

// ==================== MASSIVE API — STOCK SCANNING ====================
async function scanMarket() {
  if (!MASSIVE_KEY) return [];

  try {
    const res = await axios.get(
      "https://api.massive.com/v1/stocks/market-movers",
      {
        headers: { Authorization: `Bearer ${MASSIVE_KEY}` },
        timeout: 12000
      }
    );

    // Format:
    // [{ symbol, score, trend, volRank, price }]
    return (res.data?.data || [])
      .filter(s => s.price > 1 && s.score > 0.7)
      .slice(0, 10);

  } catch (err) {
    console.log("Massive API error:", err.message);
    return [];
  }
}

// ==================== MASSIVE ML PREDICTOR ====================
async function aiPredict(symbol) {
  if (!MASSIVE_KEY) return null;

  try {
    const res = await axios.get(
      `https://api.massive.com/v1/stocks/predict/${symbol}`,
      {
        headers: { Authorization: `Bearer ${MASSIVE_KEY}` },
        timeout: 12000
      }
    );

    return res.data?.prediction || null;
  } catch {
    return null;
  }
}

// ==================== LOGGING ====================
function logTrade(type, symbol, qty, price, reason = "") {
  const t = {
    id: Date.now(),
    type,
    symbol,
    qty,
    price: Number(price),
    timestamp: new Date().toISOString(),
    reason
  };

  if (type === "EXIT") {
    const entry = tradeLog.find(e => e.type === "ENTRY" && e.symbol === symbol);
    if (entry) {
      const pnl = (price - entry.price) * qty;
      t.pnl = pnl;
      t.pnlPct = ((pnl / (entry.price * qty)) * 100).toFixed(2);

      metrics.pnl += pnl;
      metrics.trades++;
      pnl > 0 ? metrics.wins++ : metrics.losses++;
    }
  }

  tradeLog.push(t);
  if (tradeLog.length > 300) tradeLog.shift();

  console.log(
    `[TRADE ${type}] ${symbol} | QTY ${qty} @ ${price} | ${reason} ${
      t.pnl ? `→ PnL: ${t.pnl.toFixed(2)} (${t.pnlPct}%)` : ""
    }`
  );
}

// ==================== ALPACA ORDERING ====================
async function placeOrder(symbol, qty) {
  if (DRY) {
    logTrade("ENTRY", symbol, qty, 0, "DRY-MODE");
    return;
  }

  try {
    const res = await axios.post(
      `${A_BASE}/orders`,
      {
        symbol,
        qty,
        side: "buy",
        type: "market",
        time_in_force: "day"
      },
      { headers: HEADERS }
    );

    logTrade("ENTRY", symbol, qty, res.data?.filled_avg_price || 0, "AI Entry");
  } catch (err) {
    console.log("Order error:", err.response?.data || err.message);
  }
}

async function closePosition(symbol) {
  const pos = positions.find(p => p.symbol === symbol);
  if (!pos) return;

  if (DRY) {
    logTrade("EXIT", symbol, pos.qty, pos.current, "DRY-MODE EXIT");
    return;
  }

  try {
    await axios.delete(`${A_BASE}/positions/${symbol}`, { headers: HEADERS });
    logTrade("EXIT", symbol, pos.qty, pos.current, "TP/SL Trigger");
  } catch (err) {
    console.log("Close error:", err.message);
  }
}

// ==================== ACCOUNT STATE ====================
async function updateState() {
  try {
    const [acct, pos] = await Promise.all([
      axios.get(`${A_BASE}/account`, { headers: HEADERS }),
      axios.get(`${A_BASE}/positions`, { headers: HEADERS })
    ]);

    accountEquity = parseFloat(acct.data.equity);
    positions = pos.data.map(p => ({
      symbol: p.symbol,
      qty: Number(p.qty),
      entry: Number(p.avg_entry_price),
      current: Number(p.current_price),
      unreal: Number(p.unrealized_pl),
      unrealPct: Number(p.unrealized_plpc) * 100
    }));
  } catch (err) {
    console.log("Alpaca error:", err.message);
  }
}

// ==================== AUTONOMOUS ENGINE ====================
async function engine() {
  await updateState();

  // Don't overtrade
  if (positions.length >= 5) return;

  const movers = await scanMarket();
  if (!movers.length) return;

  for (const m of movers) {
    if (positions.find(p => p.symbol === m.symbol)) continue;

    const prediction = await aiPredict(m.symbol);
    if (!prediction || prediction.confidence < 0.7) continue;

    const qty = Math.max(
      1,
      Math.floor((accountEquity * 0.02) / m.price)
    );

    await placeOrder(m.symbol, qty);

    if (positions.length >= 5) break;
  }
}

// Run engine automatically
setInterval(engine, 60000);

// ==================== API ROUTES ====================
app.get("/", async (req, res) => {
  await updateState();

  const totalUnreal = positions.reduce((n, p) => n + p.unreal, 0);
  const winRate =
    metrics.trades > 0
      ? ((metrics.wins / metrics.trades) * 100).toFixed(1)
      : "0.0";

  res.json({
    bot: "AlphaStream v35.0",
    status: "ONLINE",
    mode: DRY ? "DRY" : "LIVE",
    equity: accountEquity,
    positions,
    pnl: metrics.pnl,
    winRate: `${winRate}%`,
    trades: metrics.trades,
    uptime: `${metrics.uptime} min`,
    tradeLog: tradeLog.slice(-30),
    timestamp: new Date().toISOString()
  });
});

app.get("/healthz", (req, res) => res.send("OK"));

// ==================== START ====================
const PORT_NUM = parseInt(PORT, 10);
app.listen(PORT_NUM, "0.0.0.0", () => {
  console.log(`AlphaStream v35.0 running on port ${PORT_NUM}`);
  setInterval(() => (metrics.uptime += 1), 60000);
});
