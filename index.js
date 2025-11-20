// index.js — AlphaStream v80.3 — FULLY WORKING + REAL ALPACA + FORCE SCAN
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
  DRY_MODE = "false",
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
let tradeLog = [];
let lastGainers = [];
let lastScanTime = 0;

console.log(`\nALPHASTREAM v80.3 — FULLY LIVE`);
console.log(`Mode → ${DRY ? "DRY (real data)" : "LIVE"}\n`);

function logTrade(type, symbol, qty, price, reason = "") {
  const trade = { type, symbol, qty: Number(qty), price: Number(price).toFixed(2), timestamp: new Date().toISOString(), reason };
  tradeLog.push(trade);
  if (tradeLog.length > 500) tradeLog.shift();
  console.log(`[${DRY ? "DRY" : "LIVE"}] ${type} ${symbol} ×${qty} @ $${price} | ${reason}`);
}

async function updateEquityAndPositions() {
  if (!ALPACA_KEY) return;
  try {
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
      simulated: false,
      highestPrice: Number(p.current_price)
    }));
  } catch (e) {
    console.log("Alpaca sync failed:", e.message);
  }
}

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
    const rows = $("table tbody tr").toArray();
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
    console.log(`Yahoo → ${lastGainers.length} gainers found`);
    return lastGainers;
  } catch (e) {
    console.log("Scrape failed:", e.message);
    return lastGainers;
  }
}

async function managePositions() {
  for (const pos of positions) {
    const current = pos.current;
    const pnlPct = (current - pos.entry) / pos.entry;

    if (pnlPct >= 0.25) {
      logTrade("EXIT", pos.symbol, pos.qty, current, "TP +25%");
      if (!DRY) await axios.post(`${A_BASE}/orders`, { symbol: pos.symbol, qty: pos.qty, side: "sell", type: "market", time_in_force: "day" }, { headers: HEADERS });
      positions = positions.filter(p => p.symbol !== pos.symbol);
    }
    else if (pos.highestPrice && current < pos.highestPrice * 0.92) {
      logTrade("EXIT", pos.symbol, pos.qty, current, "Trailing Stop -8%");
      if (!DRY) await axios.post(`${A_BASE}/orders`, { symbol: pos.symbol, qty: pos.qty, side: "sell", type: "market", time_in_force: "day" }, { headers: HEADERS });
      positions = positions.filter(p => p.symbol !== pos.symbol);
    }
    else if (pnlPct <= -0.12) {
      logTrade("EXIT", pos.symbol, pos.qty, current, "Hard Stop -12%");
      if (!DRY) await axios.post(`${A_BASE}/orders`, { symbol: pos.symbol, qty: pos.qty, side: "sell", type: "market", time_in_force: "day" }, { headers: HEADERS });
      positions = positions.filter(p => p.symbol !== pos.symbol);
    }
    else if (current > (pos.highestPrice || pos.entry)) {
      pos.highestPrice = current;
    }
  }
}

async function scanAndTrade() {
  await updateEquityAndPositions();
  await managePositions();

  if (positions.length >= 5) return;

  const candidates = await getTopGainers();
  for (const c of candidates) {
    if (positions.length >= 5) break;

    const qty = Math.max(1, Math.floor((accountEquity * 0.02) / c.price));
    if (DRY) {
      positions.push({ symbol: c.symbol, qty, entry: c.price, current: c.price, unrealized_pl: 0, simulated: true, highestPrice: c.price });
      logTrade("ENTRY", c.symbol, qty, c.price, "DRY MODE");
    } else {
      try {
        await axios.post(`${A_BASE}/orders`, { symbol: c.symbol, qty, side: "buy", type: "market", time_in_force: "day" }, { headers: HEADERS });
        logTrade("ENTRY", c.symbol, qty, c.price, "LIVE");
        await updateEquityAndPositions();
      } catch (e) { console.log("Order failed:", e.message); }
    }
    await new Promise(r => setTimeout(r, 3000));
  }
}

app.get("/", async (req, res) => {
  await updateEquityAndPositions();
  const unrealized = positions.reduce((s, p) => s + (p.unrealized_pl || 0), 0);

  res.json({
    bot: "AlphaStream v80.3",
    version: "v80.3",
    status: "ONLINE",
    mode: DRY ? "PAPER" : "LIVE",
    dry_mode: DRY,
    equity: `$${accountEquity.toFixed(2)}`,
    dailyPnL: unrealized >= 0 ? `+$${unrealized.toFixed(2)}` : `-$${Math.abs(unrealized.toFixed(2))}`,
    positions_count: positions.length,
    positions,
    tradeLog: tradeLog.slice(-50)
  });
});

app.post("/scan", async (req, res) => {
  console.log("FORCE SCAN FROM DASHBOARD");
  await scanAndTrade();
  res.json({ ok: true });
});

app.listen(Number(PORT), "0.0.0.0", () => {
  console.log(`\nALPHASTREAM v80.3 FULLY LIVE & UNBREAKABLE`);
  updateEquityAndPositions();
  setInterval(scanAndTrade, 300000);
  scanAndTrade();
});
