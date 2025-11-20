// index.js — AlphaStream v53.0 — YAHOO RSS TOP GAINERS (FREE, NO 403) + MASSIVE VALIDATION
import express from "express";
import cors from "cors";
import axios from "axios";
import * as cheerio from "cheerio"; // npm install cheerio

const app = express();
app.use(cors());
app.use(express.json());

const {
  ALPACA_KEY = "",
  ALPACA_SECRET = "",
  MASSIVE_KEY = "",           // ← For price validation (free tier OK)
  DRY_MODE = "true",
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

let accountEquity = 100000;
let positions = [];
let tradeLog = [];
let stats = { wins: 0, losses: 0, totalPnL: 0, trades: 0 };

console.log(`\nALPHASTREAM v53.0 — YAHOO RSS GAINERS (FREE, NO 403)`);
console.log(`Mode → ${DRY ? "DRY" : "LIVE"}\n`);

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
    logTrade("ENTRY", symbol, qty, res.data.filled_avg_price || "market", "Yahoo Gainer Signal");
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
    console.log("Alpaca error:", err.message);
  }
}

// ==================== FREE TIER TOP GAINERS (Yahoo RSS + Massive Validation) ====================
async function getTopGainers() {
  try {
    // Parse Yahoo RSS for top gainers headlines (free, no key)
    const rssRes = await axios.get("https://feeds.finance.yahoo.com/rss/2.0/headline?s=yhoo&region=US&lang=en-US", { timeout: 8000 });
    const $ = cheerio.load(rssRes.data);
    const items = $("item").slice(0, 50).toArray();

    const candidates = [];
    for (const item of items) {
      const title = $(item).find('title').text();
      const match = title.match(/([A-Z]{1,5})[A-Z]?.*\+(\d+\.?\d*)%/); // e.g. "NVDA +8.5%"
      if (!match) continue;

      const symbol = match[1];
      const change = parseFloat(match[2]);

      if (change < 7.5) continue;

      // Validate price/volume with Massive.com (free tier OK)
      try {
        const priceRes = await axios.get(`https://api.massive.com/v2/last/trade/${symbol}`, {
          headers: { Authorization: `Bearer ${MASSIVE_KEY}` },
          timeout: 5000
        });
        const price = priceRes.data?.results?.P || 0;
        const volume = priceRes.data?.results?.s || 0;

        if (price >= 8 && price <= 350 && volume >= 800000) {
          candidates.push({ symbol, price, change });
        }
      } catch {
        // Skip validation if Massive fails — RSS is primary
      }
    }

    console.log(`Yahoo RSS + Massive: ${candidates.length} candidates`);
    return candidates.slice(0, 4);

  } catch (err) {
    console.log("Gainers scan error:", err.message);
    return [];
  }
}

// ==================== TRADING LOOP ====================
async function tradingLoop() {
  await updateEquityAndPositions();
  if (positions.length >= 5) return;

  const candidates = await getTopGainers();
  for (const c of candidates) {
    if (positions.length >= 5) break;
    const qty = Math.max(1, Math.floor((accountEquity * 0.02) / c.price));
    await placeOrder(c.symbol, qty);
    await new Promise(r => setTimeout(r, 3000));
  }
}

// ==================== DASHBOARD ====================
app.get("/", async (req, res) => {
  await updateEquityAndPositions();
  const unrealized = positions.reduce((s, p) => s + p.unrealized_pl, 0);
  const winRate = stats.trades > 0 ? ((stats.wins / stats.trades) * 100).toFixed(1) : "0.0";

  res.json({
    bot: "AlphaStream v53.0",
    version: "v53.0",
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

app.post("/manual/scan", async (req, res) => {
  console.log("Manual scan triggered");
  await tradingLoop();
  res.json({ ok: true });
});

app.get("/healthz", (req, res) => res.send("OK"));

app.listen(Number(PORT), "0.0.0.0", () => {
  console.log(`\nALPHASTREAM v53.0 LIVE — FREE RSS GAINERS`);
  console.log(`Dashboard: https://alphastream-dashboard.vercel.app\n`);
  setInterval(tradingLoop, 60000);
  tradingLoop();
});
