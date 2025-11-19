// index.js — AlphaStream v31.0 — FULL AUTO-TRADING + RISK ENGINE
import express from "express";
import cors from "cors";
import axios from "axios";

const app = express();
app.use(cors());
app.use(express.json());

const {
  ALPACA_KEY = "",
  ALPACA_SECRET = "",
  DRY_MODE = "false",
  PORT = "8080",
  PREDICTOR_URL = "",      // Your AI model endpoint
  MASSIVE_KEY = "",        // Auth for predictor
  LOG_SHEET_ID = "",       // Optional Google Sheets logging
  WEBHOOK_URL = ""         // Discord/Telegram alerts
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

// ==================== CONFIG ====================
const CONFIG = {
  maxPositions: 5,
  riskPerTrade: 0.02,        // 2% of equity per trade
  dailyLossLimit: -0.05,     // -5% = shutdown for the day
  trailingStopPct: 0.08,     // 8% trailing stop
  takeProfitPct: 0.20,       // 20% TP (optional)
  minVolume: 5000000,        // Only trade liquid stocks
  minPrice: 10,
  maxPrice: 500
};

console.log(`\nALPHASTREAM v31.0 AUTONOMOUS ENGINE STARTING`);
console.log(`Mode → ${DRY ? "DRY (Paper)" : "LIVE (REAL MONEY)"}`);
console.log(`Risk per trade → ${CONFIG.riskPerTrade * 100}%`);
console.log(`Max concurrent → ${CONFIG.maxPositions}\n`);

// ==================== STATE ====================
let accountEquity = 100000;
let positions = [];
let dailyPnL = 0;
let lastEquityFetch = null;
let tradingEnabled = true;
let lastTradeDay = new Date().toISOString().split("T")[0];

// ==================== HELPERS ====================
const log = (msg) => console.log(`[${new Date().toISOString()}] ${msg}`);
const alert = async (text) => {
  if (WEBHOOK_URL) {
    try { await axios.post(WEBHOOK_URL, { content: `**AlphaStream v31.0**\n${text}` }); }
    catch {}
  }
};

async function updateEquityAndPositions() {
  if (!ALPACA_KEY || !ALPACA_SECRET) return;

  try {
    const [accountRes, positionsRes] = await Promise.all([
      axios.get(`${A_BASE}/account`, { headers: HEADERS, timeout: 12000 }),
      axios.get(`${A_BASE}/positions`, { headers: HEADERS, timeout: 12000 })
    ]);

    const newEquity = parseFloat(accountRes.data.equity);
    const today = new Date().toISOString().split("T")[0];

    if (today !== lastTradeDay) {
      dailyPnL = 0;
      lastTradeDay = today;
    }

    dailyPnL = ((newEquity - accountEquity) / accountEquity);

    if (dailyPnL <= CONFIG.dailyLossLimit) {
      tradingEnabled = false;
      log(`DAILY LOSS LIMIT HIT (${(dailyPnL*100).toFixed(2)}%) — TRADING DISABLED FOR TODAY`);
      await alert(`DAILY LOSS LIMIT HIT — Bot paused until tomorrow`);
    }

    accountEquity = newEquity;
    positions = positionsRes.data.map(p => ({
      symbol: p.symbol,
      qty: Number(p.qty),
      side: p.side,
      entry: parseFloat(p.avg_entry_price),
      current: parseFloat(p.current_price),
      market_value: parseFloat(p.market_value),
      unrealized_pl: parseFloat(p.unrealized_pl),
      unrealized_plpc: parseFloat(p.unrealized_plpc)
    }));

    lastEquityFetch = new Date().toISOString();
  } catch (err) {
    log(`Alpaca fetch failed: ${err?.response?.data?.message || err.message}`);
  }
}

async function placeOrder(symbol, qty, side = "buy") {
  if (!tradingEnabled) return log("Trading disabled (daily loss limit)");
  if (positions.length >= CONFIG.maxPositions) return log("Max positions reached");

  try {
    const order = await axios.post(`${A_BASE}/orders`, {
      symbol,
      qty,
      side,
      type: "market",
      time_in_force: "day"
    }, { headers: HEADERS });

    log(`ORDER PLACED → ${side.toUpperCase()} ${qty} ${symbol}`);
    await alert(`ENTRY → ${side.toUpperCase()} ${qty} ${symbol} @ market`);
    return order.data;
  } catch (err) {
    log(`Order failed: ${err?.response?.data?.message || err.message}`);
  }
}

async function closePosition(symbol) {
  try {
    await axios.delete(`${A_BASE}/positions/${symbol}`, { headers: HEADERS });
    log(`EXIT → Closed ${symbol}`);
    await alert(`EXIT → Closed ${symbol}`);
  } catch (err) {
    log(`Close failed: ${err?.response?.data?.message || err.message}`);
  }
}

// ==================== AI PREDICTOR CALL ====================
async function getSignals() {
  if (!PREDICTOR_URL || !MASSIVE_KEY) return [];

  try {
    const res = await axios.post(PREDICTOR_URL, {}, {
      headers: { Authorization: `Bearer ${MASSIVE_KEY}` },
      timeout: 8000
    });

    return res.data.signals || []; // Expected: [{ symbol: "NVDA", score: 0.94, direction: "long" }, ...]
  } catch (err) {
    log("Predictor unreachable");
    return [];
  }
}

// ==================== MAIN TRADING LOOP ====================
async function tradingLoop() {
  await updateEquityAndPositions();

  if (!tradingEnabled) return;

  const signals = await getSignals();
  const longSignals = signals
    .filter(s => s.direction === "long" && s.score > 0.85)
    .slice(0, CONFIG.maxPositions - positions.length);

  for (const signal of longSignals) {
    if (positions.find(p => p.symbol === signal.symbol)) continue;

    const riskAmount = accountEquity * CONFIG.riskPerTrade;
    const qty = Math.floor(riskAmount / signal.entry_price || 100);

    if (qty < 1) continue;

    await placeOrder(signal.symbol, qty, "buy");
  }

  // Trailing stops & take profit
  for (const pos of positions) {
    if (pos.side !== "long") continue;
    const profitPct = pos.unrealized_plpc;

    if (profitPct >= CONFIG.takeProfitPct) {
      await closePosition(pos.symbol);
    } else if (profitPct <= -CONFIG.trailingStopPct) {
      await closePosition(pos.symbol);
    }
  }
}

// ==================== EXPRESS ROUTES ====================
app.get("/", async (req, res) => {
  await updateEquityAndPositions();
  const totalUnrealized = positions.reduce((sum, p) => sum + p.unrealized_pl, 0);
  const pnlPercent = accountEquity > 0 ? (totalUnrealized / accountEquity * 100).toFixed(2) : "0.00";

  res.json({
    bot: "AlphaStream v31.0 — Autonomous",
    version: "v31.0",
    status: tradingEnabled ? "ONLINE" : "PAUSED (Loss Limit)",
    mode: DRY ? "DRY" : "LIVE",
    dry_mode: DRY,
    positions_count: positions.length,
    max_pos: CONFIG.maxPositions,
    equity: `$${accountEquity.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
    dailyPnL: `${dailyPnL >= 0 ? "+" : ""}${(dailyPnL*100).toFixed(2)}%`,
    positions,
    trading_enabled: tradingEnabled,
    timestamp: new Date().toISOString()
  });
});

app.get("/healthz", (req, res) => res.send("OK"));
app.post("/manual/scan", async (req, res) => {
  await tradingLoop();
  res.json({ ok: true, message: "Manual scan + trade execution complete" });
});

// ==================== START ====================
const PORT_NUM = parseInt(PORT, 10);
app.listen(PORT_NUM, "0.0.0.0", async () => {
  log(`ALPHASTREAM v31.0 AUTONOMOUS ENGINE LIVE ON PORT ${PORT_NUM}`);
  log(`Dashboard → https://alphastream-dashboard.vercel.app`);
  await alert(`AlphaStream v31.0 ACTIVATED — ${DRY ? "PAPER" : "LIVE"} MODE"}`);

  // Start trading loop every 45 seconds
  setInterval(tradingLoop, 45000);
  tradingLoop(); // Immediate first run
});
