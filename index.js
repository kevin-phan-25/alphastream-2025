// index.js — AlphaStream v81.0 — FINAL PERFECTION
import express from "express";
import cors from "cors";
import { gotScraping } from "got-scraping";
import * as cheerio from "cheerio";
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

const DRY = DRY_MODE.toLowerCase() === "true";
const IS_PAPER = ALPACA_KEY && !ALPACA_KEY.includes("live");
const A_BASE = IS_PAPER || DRY 
  ? "https://paper-api.alpaca.markets/v2" 
  : "https://api.alpaca.markets/v2";

const HEADERS = { 
  "APCA-API-KEY-ID": ALPACA_KEY, 
  "APCA-API-SECRET-KEY": ALPACA_SECRET 
};

let accountEquity = 100000;
let positions = [];
let tradeLog = [];  // Full history
let closedTrades = []; // For win rate

console.log(`\nALPHASTREAM v81.0 — FINAL PERFECTION LIVE`);
console.log(`Mode → ${DRY ? "DRY (with real PnL)" : "LIVE"}\n`);

function logTrade(type, symbol, qty, price, reason = "", entryPrice = null) {
  const trade = {
    type,
    symbol,
    qty: Number(qty),
    price: Number(price).toFixed(2),
    timestamp: new Date().toISOString(),
    reason,
    entryPrice
  };
  tradeLog.push(trade);
  if (tradeLog.length > 500) tradeLog.shift();

  if (type === "EXIT" && entryPrice) {
    const pnl = (price - entryPrice) * qty;
    closedTrades.push({ win: pnl > 0, pnl });
  }

  console.log(`[${DRY ? "DRY" : "LIVE"}] ${type} ${symbol} ×${qty} @ $${price} | ${reason}`);
}

async function updateEquityAndPositions() {
  if (!ALPACA_KEY && !DRY) return;

  try {
    if (!DRY) {
      const [acct, pos] = await Promise.all([
        axios.get(`${A_BASE}/account`, { headers: HEADERS, timeout: 10000 }),
        axios.get(`${A_BASE}/positions`, { headers: HEADERS, timeout: 10000 })
      ]);
      accountEquity = parseFloat(acct.data.equity);
      positions = pos.data.map(p => ({
        symbol: p.symbol,
        qty: Number(p.qty),
        entry: Number(p.avg_entry_price),
        current: Number(p.current_price),
        unrealized_pl: Number(p.unrealized_pl),
        highestPrice: Math.max(Number(p.current_price), Number(p.avg_entry_price))
      }));
    }

    // DRY MODE: Simulate current price from lastGainers
    if (DRY) {
      for (const pos of positions) {
        const live = lastGainers.find(g => g.symbol === pos.symbol);
        if (live) {
          pos.current = live.price;
          pos.unrealized_pl = (pos.current - pos.entry) * pos.qty;
          if (pos.current > pos.highestPrice) pos.highestPrice = pos.current;
        }
      }
      accountEquity = 100000 + positions.reduce((s, p) => s + p.unrealized_pl, 0);
    }
  } catch (e) {
    console.log("Alpaca sync failed:", e.message);
  }
}

let lastGainers = [];
let lastScanTime = 0;

async function getTopGainers() {
  const now = Date.now();
  if (now - lastScanTime < 60000 && lastGainers.length) return lastGainers;

  try {
    const res = await gotScraping.get("https://finance.yahoo.com/gainers", {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept-Encoding": "gzip, deflate, br"
      },
      timeout: { request: 20000 }
    });

    const $ = cheerio.load(res.body);
    const rows = $("table tbody tr").slice(0, 50);
    const candidates = [];

    rows.each((_, row) => {
      const tds = $(row).find("td");
      const symbol = tds.eq(0).find("a").text().trim();
      const price = parseFloat(tds.eq(2).text().replace(/,/g, "")) || 0;
      const changePct = tds.eq(3).text().trim();
      const volumeText = tds.eq(5).text().trim();

      if (!symbol || !changePct.includes("+")) return;
      const change = parseFloat(changePct);
      const volume = volumeText.includes("M") ? parseFloat(volumeText) * 1e6 :
                    volumeText.includes("K") ? parseFloat(volumeText) * 1e3 :
                    parseFloat(volumeText.replace(/,/g, "")) || 0;

      if (change >= 7.5 && volume >= 800000 && price >= 8 && price <= 350) {
        candidates.push({ symbol, price, change, volume });
      }
    });

    lastGainers = candidates.slice(0, 8);
    lastScanTime = now;
    console.log(`Yahoo → ${lastGainers.length} nuclear gainers found`);
    return lastGainers;
  } catch (e) {
    console.log("Scrape failed:", e.message);
    return lastGainers;
  }
}

async function managePositions() {
  for (const pos of positions.slice()) {
    const pnlPct = (pos.current - pos.entry) / pos.entry;

    if (pnlPct >= 0.25) {
      logTrade("EXIT", pos.symbol, pos.qty, pos.current, "Take Profit +25%", pos.entry);
      if (!DRY) await axios.post(`${A_BASE}/orders`, { symbol: pos.symbol, qty: pos.qty, side: "sell", type: "market", time_in_force: "day" }, { headers: HEADERS });
      positions = positions.filter(p => p.symbol !== pos.symbol);
    }
    else if (pos.highestPrice && pos.current < pos.highestPrice * 0.92) {
      logTrade("EXIT", pos.symbol, pos.qty, pos.current, "Trailing Stop -8%", pos.entry);
      if (!DRY) await axios.post(`${A_BASE}/orders`, { symbol: pos.symbol, qty: pos.qty, side: "sell", type: "market", time_in_force: "day" }, { headers: HEADERS });
      positions = positions.filter(p => p.symbol !== pos.symbol);
    }
    else if (pnlPct <= -0.12) {
      logTrade("EXIT", pos.symbol, pos.qty, pos.current, "Hard Stop -12%", pos.entry);
      if (!DRY) await axios.post(`${A_BASE}/orders`, { symbol: pos.symbol, qty: pos.qty, side: "sell", type: "market", time_in_force: "day" }, { headers: HEADERS });
      positions = positions.filter(p => p.symbol !== pos.symbol);
    }
  }
}

async function scanAndTrade() {
  await updateEquityAndPositions();
  await managePositions();
  if (positions.length >= 5) return;

  const candidates = await getTopGainers();
  const buys = [];

  for (const c of candidates) {
    if (positions.length >= 5) break;
    if (positions.some(p => p.symbol === c.symbol)) continue;

    const qty = Math.max(1, Math.floor(accountEquity * 0.02 / c.price));
    buys.push({ symbol: c.symbol, qty, price: c.price });
  }

  // Parallel buying (safe for Alpaca)
  await Promise.allSettled(buys.map(async (b) => {
    if (!DRY) {
      try {
        await axios.post(`${A_BASE}/orders`, { symbol: b.symbol, qty: b.qty, side: "buy", type: "market", time_in_force: "day" }, { headers: HEADERS });
        logTrade("ENTRY", b.symbol, b.qty, b.price, "LIVE ENTRY");
      } catch (e) { console.log("Order failed:", e.message); }
    } else {
      positions.push({
        symbol: b.symbol,
        qty: b.qty,
        entry: b.price,
        current: b.price,
        unrealized_pl: 0,
        highestPrice: b.price
      });
      logTrade("ENTRY", b.symbol, b.qty, b.price, "DRY ENTRY");
    }
  }));

  await updateEquityAndPositions();
}

app.get("/", async (req, res) => {
  await updateEquityAndPositions();
  const unrealized = positions.reduce((s, p) => s + (p.unrealized_pl || 0), 0);
  const wins = closedTrades.filter(t => t.win).length;
  const losses = closedTrades.filter(t => !t.win).length;
  const winRate = closedTrades.length > 0 ? ((wins / closedTrades.length) * 100).toFixed(1) + "%" : "0.0%";

  res.json({
    bot: "AlphaStream v81.0",
    version: "v81.0",
    status: "ONLINE",
    mode: DRY ? "PAPER" : "LIVE",
    dry_mode: DRY,
    equity: `$${accountEquity.toFixed(2)}`,
    dailyPnL: unrealized >= 0 ? `+$${unrealized.toFixed(2)}` : `-$${Math.abs(unrealized.toFixed(2))}`,
    positions_count: positions.length,
    positions,
    tradeLog: tradeLog.slice(-50),
    stats: { wins, losses, total: closedTrades.length, winRate }
  });
});

app.post("/scan", async (req, res) => {
  console.log("FORCE SCAN TRIGGERED");
  await scanAndTrade();
  res.json({ ok: true });
});

app.listen(Number(PORT), "0.0.0.0", () => {
  console.log(`\nALPHASTREAM v81.0 — FINAL PERFECTION IS LIVE`);
  updateEquityAndPositions();
  setInterval(scanAndTrade, 300000);
  scanAndTrade();
});
