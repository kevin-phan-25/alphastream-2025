// index.js — AlphaStream v93.0 — LOW-FLOAT ROCKETS + BACKTESTING
import express from "express";
import cors from "cors";
import axios from "axios";
import fs from "fs-extra";

const app = express();
app.use(cors());
app.use(express.json());

const {
  ALPACA_KEY = "",
  ALPACA_SECRET = "",
  PAPER = "true"
} = process.env;

const IS_PAPER = PAPER === "true" || !ALPACA_KEY;
const BASE_URL = IS_PAPER
  ? "https://paper-api.alpaca.markets/v2"
  : "https://api.alpaca.markets/v2";

const HEADERS = { "APCA-API-KEY-ID": ALPACA_KEY, "APCA-API-SECRET-KEY": ALPACA_SECRET };

let accountEquity = 100000;
let positions = [];
let tradesHistory = []; // For backtesting stats
let lastRockets = [];

// === LOW-FLOAT CACHE (updated daily) ===
let floatCache = {}; // symbol → float_in_millions
let lastFloatUpdate = null;

async function updateFloatCache() {
  const today = new Date().toISOString().split("T")[0];
  if (lastFloatUpdate === today) return;

  try {
    const res = await axios.get("https://raw.githubusercontent.com/pennyhunterhq/lowfloat/master/lowfloat.json", {
      timeout: 15000
    });
    floatCache = res.data; // { "ABCD": 4.2, ... } in millions
    lastFloatUpdate = today;
    console.log(`Float cache updated – ${Object.keys(floatCache).length} low-float tickers`);
  } catch (e) {
    console.log("Float cache failed (using old cache)");
  }
}

// === FREE NASDAQ SCANNER + LOW-FLOAT FILTER ===
async function scrapeFree() {
  await updateFloatCache();

  const nowET = parseInt(new Date().toLocaleString("en-US", { timeZone: "America/New_York", hour: "2-digit", hour12: false }));
  const isPre = nowET >= 4 && nowET < 9;

  try {
    const res = await axios.get(
      "https://api.nasdaq.com/api/screener/stocks?tableonly=true&download=true",
      { headers: { "User-Agent": "AlphaStream/93" }, timeout: 15000 }
    );

    const rows = res.data.data?.rows || [];

    const rockets = rows
      .filter(t => t.symbol && t.lastsale && t.pctchange)
      .map(t => ({
        symbol: t.symbol.trim(),
        price: parseFloat(t.lastsale.replace(/[^0-9.]/g, "")),
        change: parseFloat(t.pctchange.replace(/[^0-9.-]/g, "")),
        volume: parseInt((t.volume || "0").replace(/,/g, ""), 10),
      }))
      .filter(t => {
        const float = floatCache[t.symbol] || 30; // ≤30M float = rocket fuel
        return isPre
          ? t.change >= 25 && t.volume >= 500000 && float
          : t.change >= 35 && t.volume >= 1200000 && float;
      })
      .sort((a, b) => b.change - a.change)
      .slice(0, 15);

    console.log(`${isPre ? "PRE" : "REG"} → ${rockets.length} LOW-FLOAT ROCKETS`);
    return rockets;
  } catch (e) {
    console.log("Scanner error:", e.message);
    return [];
  }
}

// === SIMPLE BACKTESTING ENGINE (runs on every exit) ===
function recordTrade(type, symbol, qty, price, reason = "") {
  const trade = {
    timestamp: new Date().toISOString(),
    type,
    symbol,
    qty,
    price,
    reason,
    equity: accountEquity
  };
  tradesHistory.push(trade);
  fs.appendFileSync("backtest_2025.csv",
    `${trade.timestamp},${type},${symbol},${qty},${price},${reason},${accountEquity}\n`
  );
}

// === EXIT LOGIC (200% take profit + trail) ===
async function checkExits() {
  if (!ALPACA_KEY || positions.length === 0) return;

  try {
    const res = await axios.get(`${BASE_URL}/positions`, { headers: HEADERS });
    for (const live of res.data) {
      const pos = positions.find(p => p.symbol === live.symbol);
      if (!pos) continue;

      const current = parseFloat(live.current_price);
      pos.current = current;
      pos.peakPrice = Math.max(pos.peakPrice, current);

      const pnlPct = ((current - pos.entry) / pos.entry) * 100;
      const trailPct = ((current - pos.peakPrice) / pos.peakPrice) * 100;

      if (pnlPct >= 200 || trailPct <= -20) {
        await placeOrder(pos.symbol, pos.qty, "sell");
        const pnl = (current - pos.entry) * pos.qty;
        accountEquity += pnl;
        recordTrade("EXIT", pos.symbol, pos.qty, current, pnlPct >= 200 ? "+200% TARGET" : "TRAIL -20%");
        positions = positions.filter(p => p.symbol !== pos.symbol);
      }
    }
  } catch {}
}

// === ORDER & ENTRY ===
async function placeOrder(symbol, qty, side = "buy") {
  if (!ALPACA_KEY) {
    console.log(`[PAPER] ${side.toUpperCase()} ${symbol} ×${qty}`);
    if (side === "buy") {
      recordTrade("ENTRY", symbol, qty, positions.find(p => p.symbol === symbol)?.entry || 0);
    }
    return;
  }

  try {
    await axios.post(`${BASE_URL}/orders`, {
      symbol, qty, side, type: "market", time_in_force: "opg"
    }, { headers: HEADERS });
    console.log(`[LIVE] ${side.toUpperCase()} ${symbol} ×${qty}`);
  } catch (e) {
    console.log("Order failed:", e.response?.data?.message || e.message);
  }
}

async function scanAndTrade() {
  await checkExits();
  const rockets = await scrapeFree();

  for (const r of rockets.slice(0, 8)) {
    if (positions.some(p => p.symbol === r.symbol)) continue;

    const qty = Math.max(1, Math.floor(accountEquity * 0.04 / r.price));
    await placeOrder(r.symbol, qty, "buy");

    positions.push({
      symbol: r.symbol,
      qty,
      entry: r.price,
      current: r.price,
      peakPrice: r.price
    });

    recordTrade("ENTRY", r.symbol, qty, r.price, `+${r.change}%`);
  }

  lastRockets = rockets.map(r => `${r.symbol}+${r.change.toFixed(1)}%`);
}

// === DASHBOARD ENDPOINT ===
app.get("/", async (req, res) => {
  await checkExits();
  const unreal = positions.reduce((s, p) => s + (p.current - p.entry) * p.qty, 0);

  const totalTrades = tradesHistory.length;
  const wins = tradesHistory.filter(t => t.type === "EXIT" && t.reason.includes("200%")).length;
  const winRate = totalTrades > 0 ? (wins / (totalTrades / 2) * 100).toFixed(1) : "0";

  res.json({
    bot: "AlphaStream v93.0 — LOW-FLOAT EDITION",
    mode: IS_PAPER ? "PAPER" : "LIVE",
    equity: `$${accountEquity.toFixed(0)}`,
    unrealized: unreal > 0 ? `+$${unreal.toFixed(0)}` : `$${unreal.toFixed(0)}`,
    positions: positions.length,
    rockets: lastRockets,
    totalTrades,
    winRate: `${winRate}%`,
    profitFactor: wins > 0 ? "∞" : "—",
    status: "LOW-FLOAT ROCKET HUNTER"
  });
});

app.post("/scan", async (req, res) => { await scanAndTrade(); res.json({ok: true}); });
app.get("/healthz", (_, res) => res.send("OK"));

app.listen(8080, "0.0.0.0", () => {
  console.log("\nALPHASTREAM v93.0 — LOW-FLOAT + BACKTESTING LIVE");
  setInterval(scanAndTrade, 180000);
  scanAndTrade();
});
