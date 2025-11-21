// index.js — AlphaStream v92.3 — FINAL DATA-COLLECTION BEAST (Nov 2025)
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
let lastRockets = [];

async function scrapeFree() {
  const nowET = parseInt(new Date().toLocaleString("en-US", { timeZone: "America/New_York", hour: "2-digit", hour12: false }));
  const isPre = nowET >= 4 && nowET < 9;

  try {
    const res = await axios.get(
      "https://api.nasdaq.com/api/screener/stocks?tableonly=true&download=true",
      {
        timeout: 15000,
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" }
      }
    );

    const rows = res.data.data?.rows || [];

    const rockets = rows
      .filter(t => t.symbol && t.lastsale && t.pctchange)  // safety
      .map(t => ({
        symbol: t.symbol.replace(/[^A-Z]/g, ""), // clean weird chars
        price: parseFloat(t.lastsale.replace(/[^0-9.]/g, "")),
        change: parseFloat(t.pctchange.replace(/[^0-9.-]/g, "")),
        volume: parseInt((t.volume || "0").replace(/,/g, ""), 10),
        marketcap: t.marketCap ? parseFloat(t.marketCap) : null
      }))
      .filter(t => t.price >= 0.5 && t.change !== 0)
      .filter(t => isPre
        ? t.change >= 25 && t.volume >= 500000
        : t.change >= 35 && t.volume >= 1200000
      )
      .sort((a, b) => b.change - a.change)
      .slice(0, 20);

    console.log(`${isPre ? "PRE" : "REG"} → ${rockets.length} rockets via NASDAQ free API`);
    return rockets;
  } catch (e) {
    console.log("NASDAQ scanner error:", e.message);
    return [];
  }
}

// Refresh prices + simple exit logic (optional but highly recommended for data quality)
async function updateAndExit() {
  if (!ALPACA_KEY || positions.length === 0) return;

  try {
    const res = await axios.get(`${BASE_URL}/positions`, { headers: HEADERS });
    const livePos = res.data;

    for (const live of livePos) {
      const pos = positions.find(p => p.symbol === live.symbol);
      if (!pos) continue;

      const current = parseFloat(live.current_price);
      pos.current = current;
      pos.peakPrice = Math.max(pos.peakPrice, current);

      const pnlPct = ((current - pos.entry) / pos.entry) * 100;
      const trailPct = ((current - pos.peakPrice) / pos.peakPrice) * 100;

      // Simple realistic exits — adjust % to whatever you want to study
      if (pnlPct >= 200 || trailPct <= -20) {
        await placeOrder(live.symbol, live.qty, "sell");
        fs.appendFileSync("free_trades_2025.csv",
          `${new Date().toISOString()},EXIT,${live.symbol},${live.qty},${current},${pnlPct.toFixed(1)},${trailPct.toFixed(1)}\n`);
        positions = positions.filter(p => p.symbol !== live.symbol);
      }
    }
  } catch (e) { /* ignore for paper data collection */ }
}

async function placeOrder(symbol, qty, side = "buy") { /* unchanged — your code is perfect */ }

async function scanAndTrade() {
  await updateAndExit();                // ← added
  const rockets = await scrapeFree();
  if (rockets.length === 0) return;

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

    fs.appendFileSync("free_trades_2025.csv",
      `${new Date().toISOString()},ENTRY,${r.symbol},${qty},${r.price},${r.change.toFixed(2)},${accountEquity}\n`
    );
  }

  lastRockets = rockets.map(r => `${r.symbol}+${r.change.toFixed(1)}%`);
}

// Dashboard + server unchanged — perfect already

setInterval(async () => {
  await scanAndTrade();
}, 180000);

app.listen(8080, "0.0.0.0", () => {
  console.log("\nALPHASTREAM v92.3 — FREE NASDAQ SCANNER — RUNNING FOREVER");
  scanAndTrade();
});
