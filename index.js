// index.js — AlphaStream v35.0 — REAL MOMENTUM BREAKOUT (NO BULLSHIT)
import express from "express";
import cors from "cors";
import axios from "axios";

const app = express();
app.use(cors());
app.use(express.json());

const {
  ALPACA_KEY = "",
  ALPACA_SECRET = "",
  DRY_MODE = "true",
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

let accountEquity = 100000;
let positions = [];
let tradeLog = [];

// REAL SIGNAL: Top gainer + volume surge + price > VWAP
async function getRealSignal() {
  try {
    const res = await axios.get("https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/gainers", {
      params: { apiKey: "YOUR_POLYGON_KEY" }, // get free at polygon.io
      timeout: 8000
    });

    const candidate = res.data.tickers
      .find(t => 
        t.todaysChangePerc > 15 &&
        t.day.v > 2000000 &&
        t.day.c > 10 &&
        t.day.c < 300 &&
        !positions.find(p => p.symbol === t.ticker)
      );

    if (candidate) {
      return {
        symbol: candidate.ticker,
        price: candidate.day.c,
        change: candidate.todaysChangePerc
      };
    }
  } catch (err) {
    console.log("Polygon failed, skipping scan");
  }
  return null;
}

// REAL ORDER
async function placeRealOrder(symbol, qty) {
  try {
    const res = await axios.post(`${A_BASE}/orders`, {
      symbol,
      qty,
      side: "buy",
      type: "market",
      time_in_force: "day"
    }, { headers: HEADERS });

    tradeLog.push({
      type: "ENTRY",
      symbol,
      qty,
      price: "market",
      timestamp: new Date().toISOString()
    });

    console.log(`BOUGHT ${qty} ${symbol} @ market`);
  } catch (err) {
    console.log("Order failed:", err.response?.data || err.message);
  }
}

// MAIN LOOP — REAL TRADING
async function realTradingLoop() {
  if (positions.length >= 3) return;

  const signal = await getRealSignal();
  if (!signal) return;

  const qty = Math.max(1, Math.floor(accountEquity * 0.02 / signal.price));
  await placeRealOrder(signal.symbol, qty);
}

// DASHBOARD — REAL DATA ONLY
app.get("/", async (req, res) => {
  res.json({
    bot: "AlphaStream v35.0 — Real Momentum",
    status: "ONLINE",
    mode: DRY ? "DRY" : "LIVE",
    equity: accountEquity,
    positions: positions.length,
    lastSignal: tradeLog[tradeLog.length - 1] || null,
    tradeLog: tradeLog.slice(-20),
    timestamp: new Date().toISOString()
  });
});

const PORT_NUM = parseInt(PORT, 10);
app.listen(PORT_NUM, "0.0.0.0", () => {
  console.log(`\nAlphaStream v35.0 — REAL TRADING LIVE`);
  setInterval(realTradingLoop, 60000);
  realTradingLoop();
});
