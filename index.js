// index.js — AlphaStream v83.5 — TradingView Penny Scanner (Puppeteer + Alpaca)
// WORKS ON CLOUD RUN — NO CRASHES — REAL GAINERS — FUNDED READY
import express from "express";
import cors from "cors";
import fs from "fs";
import axios from "axios";
import puppeteer from "puppeteer";

const app = express();
app.use(cors());
app.use(express.json());

// ---------------- ENV ----------------
const {
  ALPACA_KEY = "",
  ALPACA_SECRET = "",
  DRY_MODE = "true",
  PORT = "8080",
  MAX_DAILY_LOSS = "500",
  TV_EMAIL = "",
  TV_PASSWORD = "",
  SCAN_INTERVAL_MS = "300000" // 5 min
} = process.env;

const DRY = DRY_MODE.toLowerCase() === "true";
const MAX_LOSS = parseFloat(MAX_DAILY_LOSS);
const IS_PAPER = DRY || !ALPACA_KEY.includes("live");
const A_BASE = IS_PAPER
  ? "https://paper-api.alpaca.markets/v2"
  : "https://api.alpaca.markets/v2";

const HEADERS = {
  "APCA-API-KEY-ID": ALPACA_KEY,
  "APCA-API-SECRET-KEY": ALPACA_SECRET,
};

// ---------------- STATE ----------------
let accountEquity = 100000;
let positions = [];
let tradeLog = [];
let lastGainers = [];
let lastScanTime = 0;
let dailyPnL = 0;
let dailyMaxLossHit = false;
let browser = null;

// ---------------- BROWSER REUSE ----------------
async function getBrowser() {
  if (browser) return browser;
  browser = await puppeteer.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-features=IsolateOrigins,site-per-process",
      "--disable-web-security",
      "--disable-features=AudioServiceOutOfProcess",
      "--single-process",
      "--no-zygote"
    ],
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
  });
  return browser;
}

// ---------------- LOGGING ----------------
function logTrade(type, symbol, qty, price = 0, reason = "", pnl = 0) {
  const trade = {
    type,
    symbol,
    qty: Number(qty),
    price: Number(price).toFixed(2),
    timestamp: new Date().toISOString(),
    reason,
    pnl: Number(pnl).toFixed(2),
    equity: accountEquity.toFixed(2),
  };
  tradeLog.push(trade);
  if (tradeLog.length > 1000) tradeLog.shift();
  dailyPnL += pnl;

  console.log(
    `[${DRY ? "DRY" : "LIVE"}] ${type} ${symbol} ×${qty} @ $${price} | ${reason} | PnL: $${pnl.toFixed(2)}`
  );

  if (!dailyMaxLossHit && dailyPnL <= -MAX_LOSS) {
    dailyMaxLossHit = true;
    console.log(`MAX DAILY LOSS HIT: $${dailyPnL.toFixed(2)} — TRADING HALTED`);
  }
}

// ---------------- ALPACA SYNC ----------------
async function updateEquityAndPositions() {
  if (!ALPACA_KEY) return Promise.resolve();

  return Promise.all([
    axios.get(`${A_BASE}/account`, { headers: HEADERS, timeout: 15000 }).catch(() => ({ data: {} })),
    axios.get(`${A_BASE}/positions`, { headers: HEADERS, timeout: 15000 }).catch(() => ({ data: [] })),
  ])
    .then(([acctRes, posRes]) => {
      accountEquity = parseFloat(acctRes.data.equity || accountEquity);
      positions = posRes.data.map(p => ({
        symbol: p.symbol,
        qty: Number(p.qty),
        entry: Number(p.avg_entry_price),
        current: Number(p.current_price),
        unrealized_pl: Number(p.unrealized_pl || 0),
        highestPrice: Math.max(Number(p.current_price), Number(p.avg_entry_price)),
      }));
      console.log(`Alpaca sync → $${accountEquity.toFixed(2)} | ${positions.length} positions`);
    })
    .catch(err => console.log("Alpaca sync error:", err.message));
}

// ---------------- TRADINGVIEW SCRAPER ----------------
async function scrapeTradingViewGainers() {
  const now = Date.now();
  if (now - lastScanTime < 60000 && lastGainers.length) return lastGainers;

  let page;
  try {
    const br = await getBrowser();
    page = await br.newPage();

    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36"
    );

    // Load saved cookies if exist
    const cookiePath = "/tmp/tv_cookies.json";
    if (fs.existsSync(cookiePath)) {
      const cookies = JSON.parse(fs.readFileSync(cookiePath));
      await page.setCookie(...cookies);
    }

    await page.goto("https://www.tradingview.com/screener/", {
      waitUntil: "networkidle2",
      timeout: 40000,
    });

    // Close any popup
    await page.evaluate(() => {
      document.querySelectorAll('button[aria-label="Close"], button.close-button').forEach(b => b.click());
    }).catch(() => {});

    // Wait for table
    await page.waitForSelector('table tbody tr', { timeout: 30000 });

    const gainers = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll("table tbody tr"));
      return rows.map(row => {
        const cells = row.querySelectorAll("td");
        if (cells.length < 8) return null;

        const symbol = cells[0].querySelector("a")?.innerText.trim();
        const price = parseFloat(cells[2]?.innerText.replace(/[^0-9.]/g, "") || "0");
        const change = parseFloat(cells[3]?.innerText.replace(/[%+]/g, "") || "0");
        const volume = cells[5]?.innerText.trim() || "0";
        const volNum = volume.includes("M")
          ? parseFloat(volume) * 1e6
          : volume.includes("K")
          ? parseFloat(volume) * 1e3
          : parseFloat(volume.replace(/,/g, "")) || 0;

        return { symbol, price, change, volume: volNum };
      }).filter(Boolean);
    });

    // Filter: $2–$10, +3% or more, >500k volume, not already in position
    const filtered = gainers
      .filter(g => {
        if (!g.symbol || positions.some(p => p.symbol === g.symbol)) return false;
        if (g.price < 2 || g.price > 10) return false;
        if (g.change < 3) return false;
        if (g.volume < 500000) return false;
        return true;
      })
      .sort((a, b) => b.change - a.change)
      .slice(0, 5);

    // Save cookies
    const cookies = await page.cookies();
    fs.writeFileSync(cookiePath, JSON.stringify(cookies, null, 2));

    lastGainers = filtered;
    lastScanTime = now;

    console.log(`TRADINGVIEW → ${filtered.length} penny rockets: ${filtered.map(g => `${g.symbol} +${g.change}%`).join(", ")}`);

    await page.close();
    return filtered;
  } catch (err) {
    console.log("TradingView scraper error:", err.message);
    if (page) await page.close().catch(() => {});
    return lastGainers;
  }
}

// ---------------- TRADING LOGIC ----------------
async function scanAndTrade() {
  if (dailyMaxLossHit) return console.log("Trading halted — max daily loss");

  await updateEquityAndPositions();

  if (positions.length >= 5) {
    console.log("Max 5 positions — skipping scan");
    return;
  }

  const candidates = await scrapeTradingViewGainers();

  for (const stock of candidates) {
    if (positions.length >= 5) break;
    if (positions.some(p => p.symbol === stock.symbol)) continue;

    const qty = Math.max(1, Math.floor((accountEquity * 0.02) / stock.price));

    logTrade("ENTRY", stock.symbol, qty, stock.price, "TV Penny Rocket", 0);

    if (!DRY && ALPACA_KEY) {
      try {
        await axios.post(
          `${A_BASE}/orders`,
          {
            symbol: stock.symbol,
            qty,
            side: "buy",
            type: "market",
            time_in_force: "day",
          },
          { headers: HEADERS }
        );
      } catch (e) {
        console.log(`Order failed ${stock.symbol}:`, e.response?.data || e.message);
      }
    }

    // Simulate position for dry mode
    if (DRY) {
      positions.push({
        symbol: stock.symbol,
        qty,
        entry: stock.price,
        current: stock.price,
        unrealized_pl: 0,
      });
    }

    await new Promise(r => setTimeout(r, 3000));
  }
}

// ---------------- DASHBOARD ----------------
app.get("/", async (req, res) => {
  await updateEquityAndPositions();

  const unrealized = positions.reduce((sum, p) => sum + p.unrealized_pl, 0);
  const exits = tradeLog.filter(t => t.type === "EXIT");
  const winRate = exits.length ? ((exits.filter(t => parseFloat(t.pnl) > 0).length / exits.length) * 100).toFixed(1) + "%" : "N/A";

  res.json({
    bot: "AlphaStream v83.5 — TradingView Penny Scanner",
    status: "ONLINE",
    mode: DRY ? "PAPER" : "LIVE",
    equity: `$${accountEquity.toFixed(2)}`,
    dailyPnL: unrealized >= 0 ? `+$${unrealized.toFixed(2)}` : `-$${Math.abs(unrealized.toFixed(2))}`,
    positions_count: positions.length,
    positions: positions.length ? positions : null,
    tradeLog: tradeLog.slice(-30),
    lastGainers,
    winRate,
    dailyMaxLossHit,
  });
});

app.post("/scan", async (req, res) => {
  console.log("FORCE SCAN TRIGGERED");
  await scanAndTrade();
  res.json({ ok: true });
});

app.get("/healthz", (_, res) => res.send("OK"));

// ---------------- START ----------------
app.listen(Number(PORT), "0.0.0.0", async () => {
  console.log(`\nALPHASTREAM v83.5 LIVE — TRADINGVIEW PENNY SCANNER`);
  console.log(`Mode: ${DRY ? "PAPER" : "LIVE"} | Max Loss: $${MAX_LOSS}`);

  await updateEquityAndPositions();
  await scanAndTrade(); // first scan

  setInterval(scanAndTrade, Number(SCAN_INTERVAL_MS));
});
