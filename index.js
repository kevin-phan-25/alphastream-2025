// index.js — AlphaStream v81.2 — FIXED: Alpaca Live + Equity Feed
import express from "express";
import cors from "cors";
import axios from "axios";
import * as cheerio from "cheerio";

const app = express();
app.use(cors());
app.use(express.json());

const {
  ALPACA_KEY = "",
  ALPACA_SECRET = "",
  DRY_MODE = "true",
  PORT = "8080"
} = process.env;

const DRY = DRY_MODE.toLowerCase() === "true";
const IS_PAPER = !ALPACA_KEY.includes("live"); // true = paper, false = live
const A_BASE = DRY || IS_PAPER
  ? "https://paper-api.alpaca.markets/v2"
  : "https://api.alpaca.markets/v2";

const HEADERS = { 
  "APCA-API-KEY-ID": ALPACA_KEY, 
  "APCA-API-SECRET-KEY": ALPACA_SECRET 
};

let accountEquity = 100000;
let positions = [];
let tradeLog = [];
let lastGainers = [];
let lastScanTime = 0;

console.log(`\nALPHASTREAM v81.2 — FIXED & LIVE`);
console.log(`Mode → ${DRY ? "DRY (simulated trades)" : IS_PAPER ? "PAPER" : "LIVE"}\n`);

// ----- Helper for logging trades -----
function logTrade(type, symbol, qty, price, reason = "", pnl = 0) {
  const trade = {
    type,
    symbol,
    qty: Number(qty),
    price: Number(price).toFixed(2),
    timestamp: new Date().toISOString(),
    reason,
    pnl: pnl.toFixed(2)
  };
  tradeLog.push(trade);
  if (tradeLog.length > 500) tradeLog.shift();
  console.log(`[${DRY ? "DRY" : IS_PAPER ? "PAPER" : "LIVE"}] ${type} ${symbol} ×${qty} @ $${price} | ${reason} | PnL ${pnl.toFixed(2)}`);
}

// ----- Retry wrapper for Alpaca -----
async function fetchWithRetry(url, opts, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try { 
      return await axios.get(url, opts); 
    } catch (e) { 
      if (i === retries - 1) throw e;
      console.log(`Retrying ${url}... (${i+1})`);
      await new Promise(r => setTimeout(r, 1000));
    }
  }
}

// ----- Update Alpaca account & positions -----
async function updateEquityAndPositions() {
  if (!ALPACA_KEY) {
    console.log("No Alpaca keys — using mock $100k");
    return;
  }

  try {
    if (!DRY) {
      console.log("Fetching Alpaca account & positions...");
      const [acctRes, posRes] = await Promise.all([
        fetchWithRetry(`${A_BASE}/account`, { headers: HEADERS, timeout: 10000 }),
        fetchWithRetry(`${A_BASE}/positions`, { headers: HEADERS, timeout: 10000 })
      ]);

      accountEquity = parseFloat(acctRes.data.equity || 100000);
      positions = posRes.data.map(p => ({
        symbol: p.symbol,
        qty: Number(p.qty),
        entry: Number(p.avg_entry_price),
        current: Number(p.current_price),
        unrealized_pl: Number(p.unrealized_pl),
        highestPrice: Math.max(Number(p.current_price), Number(p.avg_entry_price))
      }));

      console.log(`Alpaca sync → $${accountEquity.toFixed(2)} | ${positions.length} positions`);
    }
  } catch (e) {
    console.log("Alpaca sync failed:", e.response?.status || e.message);
  }
}

// ----- Get top gainers from Yahoo Finance -----
async function getTopGainers() {
  const now = Date.now();
  if (now - lastScanTime < 60000 && lastGainers.length) return lastGainers;

  try {
    const res = await axios.get("https://finance.yahoo.com/gainers", { headers: { "User-Agent": "Mozilla/5.0" }, timeout: 15000 });
    const $ = cheerio.load(res.data);
    const rows = $("table tbody tr").slice(0, 50).toArray();
    const candidates = [];

    for (const row of rows) {
      const tds = $(row).find("td");
      const symbol = tds.eq(0).find("a").text().trim() || tds.eq(0).text().trim();
      const price = parseFloat(tds.eq(2).text().replace(/,/g, "")) || 0;
      const changePct = tds.eq(3).text().trim();
      const volume = tds.eq(5).text().trim();
      if (!symbol || !changePct.includes("+")) continue;

      const change = parseFloat(changePct);
      const volNum = volume.includes("M") ? parseFloat(volume) * 1e6 : parseFloat(volume.replace(/,/g, "")) || 0;

      if (change >= 7.5 && volNum >= 800000 && price >= 8 && price <= 350 && !positions.some(p => p.symbol === symbol)) {
        candidates.push({ symbol, price, change });
      }
    }

    lastGainers = candidates.slice(0, 8);
    lastScanTime = now;
    console.log(`Yahoo → ${lastGainers.length} gainers: ${lastGainers.map(r => `${r.symbol} +${r.change}%`).join(", ")}`);
    return lastGainers;

  } catch (e) {
    console.log("Scrape failed:", e.message);
    return lastGainers;
  }
}

// ----- Manage positions (exits) -----
async function managePositions() {
  for (const pos of positions.slice()) {
    const pnlPct = (pos.current - pos.entry) / pos.entry;

    if (pnlPct >= 0.25) {
      logTrade("EXIT", pos.symbol, pos.qty, pos.current, "Take Profit +25%", pnlPct * pos.qty * pos.entry);
      if (!DRY) await axios.post(`${A_BASE}/orders`, { symbol: pos.symbol, qty: pos.qty, side: "sell", type: "market", time_in_force: "day" }, { headers: HEADERS });
      positions = positions.filter(p => p.symbol !== pos.symbol);
    } else if (pos.highestPrice && pos.current < pos.highestPrice * 0.92) {
      logTrade("EXIT", pos.symbol, pos.qty, pos.current, "Trailing Stop -8%", (pos.current - pos.entry) * pos.qty);
      if (!DRY) await axios.post(`${A_BASE}/orders`, { symbol: pos.symbol, qty: pos.qty, side: "sell", type: "market", time_in_force: "day" }, { headers: HEADERS });
      positions = positions.filter(p => p.symbol !== pos.symbol);
    } else if (pnlPct <= -0.12) {
      logTrade("EXIT", pos.symbol, pos.qty, pos.current, "Hard Stop -12%", (pos.current - pos.entry) * pos.qty);
      if (!DRY) await axios.post(`${A_BASE}/orders`, { symbol: pos.symbol, qty: pos.qty, side: "sell", type: "market", time_in_force: "day" }, { headers: HEADERS });
      positions = positions.filter(p => p.symbol !== pos.symbol);
    }
  }
}

// ----- Place orders -----
async function placeOrder(symbol, qty, price) {
  if (!qty) return;
  if (DRY) {
    positions.push({ symbol, qty, entry: price, current: price, unrealized_pl: 0, highestPrice: price });
    logTrade("ENTRY", symbol, qty, price, "DRY ENTRY", 0);
  } else {
    try {
      await axios.post(`${A_BASE}/orders`, { symbol, qty, side: "buy", type: "market", time_in_force: "day" }, { headers: HEADERS });
      logTrade("ENTRY", symbol, qty, price, IS_PAPER ? "PAPER ENTRY" : "LIVE ENTRY", 0);
    } catch (e) {
      console.log("Order failed:", e.response?.status || e.message);
    }
  }
}

// ----- Scan & Trade -----
async function scanAndTrade() {
  await updateEquityAndPositions();
  await managePositions();
  if (positions.length >= 5) return;

  const candidates = await getTopGainers();
  for (const c of candidates) {
    if (positions.length >= 5) break;
    if (positions.some(p => p.symbol === c.symbol)) continue;
    const qty = Math.max(1, Math.floor((accountEquity * 0.02) / c.price));
    await placeOrder(c.symbol, qty, c.price);
    await new Promise(r => setTimeout(r, 4000));
  }
}

// ----- API Endpoints -----
app.get("/", async (req, res) => {
  await updateEquityAndPositions();
  const unrealized = positions.reduce((s, p) => s + (p.unrealized_pl || 0), 0);
  const wins = tradeLog.filter(t => t.type === "ENTRY").length;

  res.json({
    bot: "AlphaStream v81.2",
    version: "v81.2",
    status: "ONLINE",
    mode: DRY ? "PAPER" : IS_PAPER ? "PAPER" : "LIVE",
    dry_mode: DRY,
    equity: `$${accountEquity.toFixed(2)}`,
    dailyPnL: unrealized >= 0 ? `+$${unrealized.toFixed(2)}` : `-$${Math.abs(unrealized.toFixed(2))}`,
    positions_count: positions.length,
    positions,
    tradeLog: tradeLog.slice(-30),
    backtest: {
      totalTrades: tradeLog.length,
      winRate: "0.0%",
      wins,
      losses: 0
    }
  });
});

app.post("/scan", async (req, res) => {
  console.log("FORCE SCAN TRIGGERED");
  await scanAndTrade();
  res.json({ ok: true });
});

app.get("/healthz", (req, res) => res.send("OK"));

// ----- Start server -----
app.listen(Number(PORT), "0.0.0.0", () => {
  console.log(`\nALPHASTREAM v81.2 FULLY LIVE`);
  updateEquityAndPositions();
  setInterval(scanAndTrade, 300000); // every 5 min
  scanAndTrade();
});
