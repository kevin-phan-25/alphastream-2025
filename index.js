// index.js — AlphaStream v83.0 — PROP-FIRM READY + PUPPETEER YAHOO SCRAPER
import express from "express";
import cors from "cors";
import axios from "axios";
import fs from "fs";
import puppeteer from "puppeteer";

const app = express();
app.use(cors());
app.use(express.json());

// ----------------- ENV -----------------
const {
  ALPACA_KEY = "",
  ALPACA_SECRET = "",
  DRY_MODE = "true",
  PORT = "8080",
  MAX_DAILY_LOSS = "500"
} = process.env;

const DRY = DRY_MODE.toLowerCase() === "true";
const MAX_LOSS = parseFloat(MAX_DAILY_LOSS);
const IS_PAPER = DRY || !ALPACA_KEY.includes("live");
const A_BASE = IS_PAPER
  ? "https://paper-api.alpaca.markets/v2"
  : "https://api.alpaca.markets/v2";

const HEADERS = {
  "APCA-API-KEY-ID": ALPACA_KEY,
  "APCA-API-SECRET-KEY": ALPACA_SECRET
};

// ----------------- CORE DATA -----------------
let accountEquity = 100000;
let positions = [];
let tradeLog = [];
let lastGainers = [];
let lastScanTime = 0;
let dailyPnL = 0;
let dailyMaxLossHit = false;

// ----------------- LOGGING -----------------
function logTrade(type, symbol, qty, price, reason = "", pnl = 0) {
  const trade = {
    type,
    symbol,
    qty: Number(qty),
    price: Number(price).toFixed(2),
    timestamp: new Date().toISOString(),
    reason,
    pnl: pnl.toFixed(2),
    equity: accountEquity.toFixed(2)
  };
  tradeLog.push(trade);
  if (tradeLog.length > 1000) tradeLog.shift();

  dailyPnL += pnl;

  console.log(
    `[${DRY ? "DRY" : "LIVE"}] ${type} ${symbol} ×${qty} @ $${price} | ${reason} | PnL ${pnl.toFixed(
      2
    )} | DailyPnL $${dailyPnL.toFixed(2)}`
  );

  fs.writeFileSync("tradeLog.json", JSON.stringify(tradeLog, null, 2));

  if (!dailyMaxLossHit && dailyPnL <= -MAX_LOSS) {
    dailyMaxLossHit = true;
    console.log(
      `⚠️ MAX DAILY LOSS HIT: $${dailyPnL.toFixed(
        2
      )} — trading halted for today`
    );
  }
}

// ----------------- ALPACA SYNC -----------------
async function updateEquityAndPositions() {
  if (!ALPACA_KEY) {
    console.log("No Alpaca keys — using mock $100k");
    return;
  }

  try {
    const [acct, pos] = await Promise.all([
      axios.get(`${A_BASE}/account`, { headers: HEADERS, timeout: 15000 }),
      axios.get(`${A_BASE}/positions`, { headers: HEADERS, timeout: 15000 })
    ]);

    accountEquity = parseFloat(acct.data.equity || 100000);

    positions = pos.data.map((p) => ({
      symbol: p.symbol,
      qty: Number(p.qty),
      entry: Number(p.avg_entry_price),
      current: Number(p.current_price),
      unrealized_pl: Number(p.unrealized_pl),
      highestPrice: Math.max(Number(p.current_price), Number(p.avg_entry_price))
    }));

    console.log(
      `Alpaca sync → $${accountEquity.toFixed(2)} | ${positions.length} positions`
    );
  } catch (e) {
    console.log("Alpaca sync failed:", e.response?.status || e.message);
  }
}

// ----------------- PUPPETEER YAHOO SCRAPER -----------------
async function getTopGainers() {
  const now = Date.now();
  if (now - lastScanTime < 60000 && lastGainers.length) return lastGainers;

  console.log("🚀 Launching Puppeteer for Yahoo Gainers scan...");
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"]
    });

    const page = await browser.newPage();
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
      "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36"
    );

    await page.goto("https://finance.yahoo.com/gainers", { waitUntil: "networkidle2", timeout: 30000 });

    await page.waitForSelector("table tbody tr", { timeout: 15000 });

    const candidates = await page.evaluate((positions) => {
      const rows = Array.from(document.querySelectorAll("table tbody tr")).slice(0, 50);
      const result = [];

      for (const row of rows) {
        const cells = row.querySelectorAll("td");
        const symbol = cells[0]?.innerText?.trim();
        const price = parseFloat(cells[2]?.innerText.replace(/,/g, "")) || 0;
        const changeText = cells[3]?.innerText?.trim() || "";
        const change = parseFloat(changeText.replace("%", ""));
        const volumeText = cells[5]?.innerText?.trim() || "";
        let volume = 0;
        if (volumeText.includes("M")) volume = parseFloat(volumeText) * 1e6;
        else if (volumeText.includes("K")) volume = parseFloat(volumeText) * 1e3;
        else volume = parseFloat(volumeText.replace(/,/g, "")) || 0;

        if (!symbol || !changeText.includes("+")) continue;

        if (change >= 7.5 && volume >= 800000 && price >= 8 && price <= 350 && !positions.some(p => p.symbol === symbol)) {
          result.push({ symbol, price, change });
        }
      }
      return result.slice(0, 8);
    }, positions);

    lastGainers = candidates;
    lastScanTime = now;

    console.log(
      `Yahoo → ${lastGainers.length} gainers: ${lastGainers
        .map(r => `${r.symbol} +${r.change}%`)
        .join(", ")}`
    );

  } catch (e) {
    console.log("SCRAPER ERROR:", e.message);
  } finally {
    if (browser) await browser.close();
  }

  return lastGainers;
}

// ----------------- POSITION MANAGEMENT -----------------
async function managePositions() {
  for (const pos of positions.slice()) {
    const pnlPct = (pos.current - pos.entry) / pos.entry;

    if (pnlPct >= 0.25) {
      logTrade("EXIT", pos.symbol, pos.qty, pos.current, "Take Profit +25%", pnlPct * pos.qty * pos.entry);
      if (!DRY && !dailyMaxLossHit) await exitPosition(pos.symbol, pos.qty);
      positions = positions.filter((p) => p.symbol !== pos.symbol);
    } else if (pos.highestPrice && pos.current < pos.highestPrice * 0.92) {
      logTrade("EXIT", pos.symbol, pos.qty, pos.current, "Trailing Stop -8%", (pos.current - pos.entry) * pos.qty);
      if (!DRY && !dailyMaxLossHit) await exitPosition(pos.symbol, pos.qty);
      positions = positions.filter((p) => p.symbol !== pos.symbol);
    } else if (pnlPct <= -0.12) {
      logTrade("EXIT", pos.symbol, pos.qty, pos.current, "Hard Stop -12%", (pos.current - pos.entry) * pos.qty);
      if (!DRY && !dailyMaxLossHit) await exitPosition(pos.symbol, pos.qty);
      positions = positions.filter((p) => p.symbol !== pos.symbol);
    }
  }
}

// ----------------- EXIT HELPER -----------------
async function exitPosition(symbol, qty) {
  if (dailyMaxLossHit) return;
  try {
    await axios.post(
      `${A_BASE}/orders`,
      { symbol, qty, side: "sell", type: "market", time_in_force: "day" },
      { headers: HEADERS }
    );
  } catch (e) {
    console.log(`Exit order failed for ${symbol}:`, e.response?.status || e.message);
  }
}

// ----------------- PLACE ORDER -----------------
async function placeOrder(symbol, qty, price) {
  if (dailyMaxLossHit) return;
  logTrade("ENTRY", symbol, qty, price, "Top Gainer Entry", 0);

  if (!DRY) {
    try {
      await axios.post(
        `${A_BASE}/orders`,
        { symbol, qty, side: "buy", type: "market", time_in_force: "day" },
        { headers: HEADERS }
      );
    } catch (e) {
      console.log(`Order failed for ${symbol}:`, e.response?.status || e.message);
    }
  }
}

// ----------------- SCAN AND TRADE -----------------
async function scanAndTrade() {
  if (dailyMaxLossHit) return console.log("Trading halted — max daily loss reached.");

  await updateEquityAndPositions();
  await managePositions();

  if (positions.length >= 5) return;

  const candidates = await getTopGainers();

  for (const c of candidates) {
    if (positions.length >= 5) break;
    if (positions.some((p) => p.symbol === c.symbol)) continue;

    const qty = Math.max(1, Math.floor((accountEquity * 0.02) / c.price));
    await placeOrder(c.symbol, qty, c.price);
    await new Promise((r) => setTimeout(r, 4000));
  }
}

// ----------------- DASHBOARD -----------------
app.get("/", async (req, res) => {
  await updateEquityAndPositions();
  const unrealized = positions.reduce((s, p) => s + (p.unrealized_pl || 0), 0);

  const exits = tradeLog.filter((t) => t.type === "EXIT");
  const wins = exits.filter((t) => parseFloat(t.pnl) > 0).length;
  const winRate = exits.length > 0 ? `${((wins / exits.length) * 100).toFixed(1)}%` : "0.0%";

  res.json({
    bot: "AlphaStream v83.0",
    status: "ONLINE",
    mode: DRY ? "PAPER" : "LIVE",
    dailyMaxLossHit,
    equity: `$${accountEquity.toFixed(2)}`,
    dailyPnL: unrealized >= 0 ? `+$${unrealized.toFixed(2)}` : `-$${Math.abs(unrealized).toFixed(2)}`,
    positions_count: positions.length,
    positions: positions.length ? positions : null,
    tradeLog: tradeLog.slice(-40),
    backtest: { totalTrades: tradeLog.length, winRate, wins, losses: exits.length - wins }
  });
});

// ----------------- FORCE SCAN -----------------
app.post("/scan", async (req, res) => {
  console.log("FORCE SCAN TRIGGERED");
  await scanAndTrade();
  res.json({ ok: true });
});

// ----------------- HEALTH -----------------
app.get("/healthz", (req, res) => res.send("OK"));

// ----------------- START SERVER -----------------
app.listen(Number(PORT), "0.0.0.0", async () => {
  console.log(`\nALPHASTREAM v83.0 FULLY LIVE`);
  await updateEquityAndPositions();
  setInterval(scanAndTrade, 300000); // scan every 5 min
  scanAndTrade();
});
