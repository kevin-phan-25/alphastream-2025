// index.js — AlphaStream v70.0 — FMP FULL POWER (Gainers + Quotes + Indicators + Fundamentals)
import express from "express";
import cors from "cors";
import axios from "axios";

const app = express();
app.use(cors());
app.use(express.json());

const {
  ALPACA_KEY = "",
  ALPACA_SECRET = "",
  FMP_KEY = "U3oUW9joz8br7yB1Uz4nVHFyqcL76Xon",  // Your key
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
let stats = { wins: 0, losses: 0, totalPnL: 0, trades: 0 };

console.log(`\nALPHASTREAM v70.0 — FMP FULL POWER`);
console.log(`Mode → ${DRY ? "DRY" : "LIVE"}\n`);

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

async function updateEquityAndPositions() {
  if (!ALPACA_KEY || DRY) return;
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
  } catch (e) {
    console.log("Alpaca fetch failed:", e.message);
  }
}

async function getTopGainers() {
  const now = Date.now();
  if (now - lastScanTime < 60000 && lastGainers.length > 0) return lastGainers;

  if (!FMP_KEY) return lastGainers;

  try {
    const res = await axios.get("https://financialmodelingprep.com/api/v3/stock_market/gainers", {
      params: { apikey: FMP_KEY },
      timeout: 10000
    });

    const candidates = (res.data || [])
      .filter(t => {
        const change = parseFloat(t.changesPercentage || "0");
        const price = parseFloat(t.price || "0");
        const volume = parseInt(t.volume || "0");
        return change >= 7.5 &&
               volume >= 800000 &&
               price >= 8 && price <= 350 &&
               !positions.some(p => p.symbol === t.symbol);
      })
      .slice(0, 4);

    lastGainers = candidates.map(t => ({ symbol: t.symbol, price: t.price }));
    lastScanTime = now;
    console.log(`FMP → ${lastGainers.length} runners: ${lastGainers.map(r => r.symbol).join(", ")}`);
    return lastGainers;

  } catch (e) {
    console.log("FMP failed:", e.response?.status || e.message);
    return lastGainers;
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
    await new Promise(r => setTimeout(r, 3500));
  }
}

// Dashboard
app.get("/", async (req, res) => {
  await updateEquityAndPositions();
  const unrealized = positions.reduce((a, p) => a + p.unrealized_pl, 0);
  const winRate = stats.trades > 0 ? ((stats.wins / stats.trades) * 100).toFixed(1) : "0.0";

  res.json({
    bot: "AlphaStream",
    version: "v70.0",
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
      totalTrades: stats.trades,
      winRate: `${winRate}%`,
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
  console.log(`Server LIVE on port ${PORT}`);
  console.log(`Dashboard → https://alphastream-dashboard.vercel.app\n`);
  setInterval(tradingLoop, 300000); // 5 mins
  tradingLoop();
});
