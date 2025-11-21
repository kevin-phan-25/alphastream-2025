// index.js — AlphaStream v85.0 — DUAL PRE/POST MARKET SCANNER + 3:50 PM CLOSE
import express from "express";
import cors from "cors";
import axios from "axios";
import puppeteer from "puppeteer";

const app = express();
app.use(cors());
app.use(express.json());

const {
  ALPACA_KEY = "",
  ALPACA_SECRET = "",
  DRY_MODE = "true",
  PORT = "8080",
  MAX_DAILY_LOSS = "500",
  TV_EMAIL = "",
  TV_PASSWORD = ""
} = process.env;

const DRY = DRY_MODE.toLowerCase() === "true";
const MAX_LOSS = parseFloat(MAX_DAILY_LOSS);
const IS_PAPER = DRY || !ALPACA_KEY.includes("live");
const A_BASE = IS_PAPER ? "https://paper-api.alpaca.markets/v2" : "https://api.alpaca.markets/v2";
const HEADERS = { "APCA-API-KEY-ID": ALPACA_KEY, "APCA-API-SECRET-KEY": ALPACA_SECRET };

let accountEquity = 100000;
let positions = [];
let tradeLog = [];
let lastGainers = [];
let lastScanTime = 0;
let dailyPnL = 0;
let dailyMaxLossHit = false;
let browser = null;

// Eastern Time helper
function getET() {
  return new Date().toLocaleString("en-US", { timeZone: "America/New_York" });
}
function getETHour() {
  return new Date().toLocaleString("en-US", { timeZone: "America/New_York", hour: "2-digit", hour12: false });
}
function getETMinute() {
  return new Date().toLocaleString("en-US", { timeZone: "America/New_York", minute: "2-digit" });
}

async function getBrowser() {
  if (browser) return browser;
  browser = await puppeteer.launch({
    headless: true,
    executablePath: "/usr/bin/google-chrome",
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--single-process", "--no-zygote"],
  });
  return browser;
}

function logTrade(type, symbol, qty, price = 0, reason = "", pnl = 0) {
  const trade = { type, symbol, qty: Number(qty), price: Number(price).toFixed(2), timestamp: new Date().toISOString(), reason, pnl: Number(pnl).toFixed(2) };
  tradeLog.push(trade);
  if (tradeLog.length > 1000) tradeLog.shift();
  dailyPnL += pnl;
  console.log(`[${DRY ? "DRY" : "LIVE"}] ${type} ${symbol} ×${qty} @ $${price} | ${reason}`);
  if (!dailyMaxLossHit && dailyPnL <= -MAX_LOSS) {
    dailyMaxLossHit = true;
    console.log(`MAX DAILY LOSS HIT: $${dailyPnL.toFixed(2)} — TRADING HALTED`);
  }
}

async function updateEquityAndPositions() {
  if (!ALPACA_KEY) return;
  try {
    const [acct, pos] = await Promise.all([
      axios.get(`${A_BASE}/account`, { headers: HEADERS, timeout: 15000 }),
      axios.get(`${A_BASE}/positions`, { headers: HEADERS, timeout: 15000 }).catch(() => ({ data: [] }))
    ]);
    accountEquity = parseFloat(acct.data.equity || accountEquity);
    positions = (pos.data || []).map(p => ({
      symbol: p.symbol,
      qty: Number(p.qty),
      entry: Number(p.avg_entry_price),
      current: Number(p.current_price),
      unrealized_pl: Number(p.unrealized_pl || 0)
    }));
  } catch (e) { console.log("Alpaca sync error:", e.message); }
}

// AUTO CLOSE ALL POSITIONS @ 3:50 PM ET
async function closeAllPositionsAt350PM() {
  const hour = parseInt(getETHour());
  const minute = parseInt(getETMinute());
  if (hour === 15 && minute >= 50 && minute <= 55 && positions.length > 0) {
    console.log("3:50 PM ET — CLOSING ALL POSITIONS");
    for (const pos of positions) {
      logTrade("EXIT", pos.symbol, pos.qty, pos.current, "EOD FLATTEN @ 3:50 PM", pos.unrealized_pl);
      if (!DRY) {
        try {
          await axios.post(`${A_BASE}/orders`, {
            symbol: pos.symbol,
            qty: pos.qty,
            side: "sell",
            type: "market",
            time_in_force: "day"
          }, { headers: HEADERS });
        } catch (e) { console.log(`Close failed ${pos.symbol}:`, e.message); }
      }
    }
    positions = [];
    await new Promise(r => setTimeout(r, 60000)); // prevent double-close
  }
}

async function scrapePreMarketScanner() {
  const url = "https://www.tradingview.com/screener/?filter=%7B%22columns%22%3A%5B%22name%22%2C%22premarket_close%22%2C%22premarket_change%22%2C%22premarket_volume%22%2C%22relative_volume_10d_calc%22%2C%22market_cap_basic%22%2C%22premarket_price%22%2C%22float_shares%22%5D%2C%22filters%22%3A%5B%7B%22left%22%3A%22premarket_price%22%2C%22operation%22%3A%22greater%22%2C%22right%22%3A1%7D%2C%7B%22left%22%3A%22premarket_change%22%2C%22operation%22%3A%22greater%22%2C%22right%22%3A20%7D%2C%7B%22left%22%3A%22premarket_volume%22%2C%22operation%22%3A%22greater%22%2C%22right%22%3A500000%7D%2C%7B%22left%22%3A%22float_shares%22%2C%22operation%22%3A%22in_range%22%2C%22right%22%3A%5B0%2C30000000%5D%7D%5D%2C%22sort%22%3A%7B%22sortBy%22%3A%22premarket_change%22%2C%22sortOrder%22%3A%22desc%22%7D%2C%22options%22%3A%7B%22premarket%22%3Atrue%7D%7D";
  return await scrapeWithUrl(url, "PRE-MARKET SCANNER");
}

async function scrapePostMarketScanner() {
  const url = "https://www.tradingview.com/screener/?filter=%7B%22columns%22%3A%5B%22name%22%2C%22close%22%2C%22change%22%2C%22volume%22%2C%22relative_volume_10d_calc%22%2C%22market_cap_basic%22%2C%22float_shares%22%5D%2C%22filters%22%3A%5B%7B%22left%22%3A%22close%22%2C%22operation%22%3A%22in_range%22%2C%22right%22%3A%5B1%2C20%5D%7D%2C%7B%22left%22%3A%22change%22%2C%22operation%22%3A%22greater%22%2C%22right%22%3A30%7D%2C%7B%22left%22%3A%22volume%22%2C%22operation%22%3A%22greater%22%2C%22right%22%3A1000000%7D%2C%7B%22left%22%3A%22float_shares%22%2C%22operation%22%3A%22less%22%2C%22right%22%3A40000000%7D%5D%2C%22sort%22%3A%7B%22sortBy%22%3A%22change%22%2C%22sortOrder%22%3A%22desc%22%7D%2C%22options%22%3A%7B%22lang%22%3A%22en%22%7D%2C%22extended_hours%22%3Atrue%7D";
  return await scrapeWithUrl(url, "POST-MARKET SCANNER");
}

async function scrapeWithUrl(url, label) {
  const now = Date.now();
  if (now - lastScanTime < 45000 && lastGainers.length) return lastGainers;

  let page;
  try {
    const br = await getBrowser();
    page = await br.newPage();
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36");

    if (TV_EMAIL && TV_PASSWORD) {
      await page.goto("https://www.tradingview.com/accounts/signin/", { waitUntil: "networkidle2" });
      await page.type('input[name="username"]', TV_EMAIL);
      await page.type('input[name="password"]', TV_PASSWORD);
      await Promise.all([page.click('button[type="submit"]'), page.waitForNavigation().catch(() => {})]);
    }

    await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });
    await page.waitForSelector('table tbody tr', { timeout: 30000 });

    const results = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll("table tbody tr"));
      return rows.slice(0, 10).map(row => {
        const cells = row.querySelectorAll("td");
        const symbol = cells[0]?.querySelector("a")?.innerText.trim() || "";
        const priceCell = cells[1]?.innerText.replace(/[^0-9.]/g, "") || "0";
        const changeCell = cells[2]?.innerText.replace(/[%+]/g, "") || "0";
        return { symbol, price: parseFloat(priceCell), change: parseFloat(changeCell) };
      }).filter(r => r.symbol && r.change > 10);
    });

    const filtered = results
      .filter(r => !positions.some(p => p.symbol === r.symbol))
      .sort((a, b) => b.change - a.change);

    lastGainers = filtered;
    lastScanTime = now;
    console.log(`${label} → ${filtered.length} rockets: ${filtered.map(r => `${r.symbol} +${r.change}%`).join(", ")}`);

    await page.close();
    return filtered;
  } catch (err) {
    console.log(`${label} error:`, err.message);
    if (page) await page.close().catch(() => {});
    return lastGainers;
  }
}

async function scanAndTrade() {
  await updateEquityAndPositions();
  await closeAllPositionsAt350PM();
  if (dailyMaxLossHit || positions.length >= 5) return;

  const hour = parseInt(getETHour());
  const minute = parseInt(getETMinute());
  const isPremarket = hour >= 4 && hour < 9 || (hour === 9 && minute < 30);
  const isRegularOrPost = hour >= 9 && hour < 20;

  if (isPremarket) {
    const rockets = await scrapePreMarketScanner();
    for (const r of rockets.slice(0, 3)) {
      if (positions.length >= 5) break;
      const qty = Math.max(1, Math.floor((accountEquity * 0.025) / r.price));
      logTrade("ENTRY", r.symbol, qty, r.price, `PRE-MARKET +${r.change}%`, 0);
      if (!DRY) await axios.post(`${A_BASE}/orders`, { symbol: r.symbol, qty, side: "buy", type: "market", time_in_force: "opg" }, { headers: HEADERS }).catch(() => {});
      await new Promise(r => setTimeout(r, 4000));
    }
  }

  if (isRegularOrPost) {
    const rockets = await scrapePostMarketScanner();
    for (const r of rockets.slice(0, 3)) {
      if (positions.length >= 5) break;
      const qty = Math.max(1, Math.floor((accountEquity * 0.025) / r.price));
      logTrade("ENTRY", r.symbol, qty, r.price, `POST-MARKET +${r.change}%`, 0);
      if (!DRY) await axios.post(`${A_BASE}/orders`, { symbol: r.symbol, qty, side: "buy", type: "market", time_in_force: "day" }, { headers: HEADERS }).catch(() => {});
      await new Promise(r => setTimeout(r, 4000));
    }
  }
}

app.get("/", async (req, res) => {
  await updateEquityAndPositions();
  const unrealized = positions.reduce((s, p) => s + p.unrealized_pl, 0);
  const hour = parseInt(getETHour());
  const currentMode = (hour >= 4 && hour < 9 || (hour === 9 && parseInt(getETMinute()) < 30)) ? "PRE-MARKET" : "POST-MARKET / REGULAR";

  res.json({
    bot: "AlphaStream v85.0 — DUAL SCANNER",
    mode: DRY ? "PAPER" : "LIVE",
    currentScanner: currentMode,
    equity: `$${accountEquity.toFixed(2)}`,
    dailyPnL: unrealized >= 0 ? `+$${unrealized.toFixed(2)}` : `-$${Math.abs(unrealized.toFixed(2))}`,
    positions_count: positions.length,
    positions,
    lastGainers,
    tradeLog: tradeLog.slice(-30),
    nextEODClose: "3:50 PM ET"
  });
});

app.post("/scan", async (req, res) => {
  console.log("FORCE SCAN");
  await scanAndTrade();
  res.json({ ok: true });
});

app.get("/healthz", (_, res) => res.send("OK"));

app.listen(Number(PORT), "0.0.0.0", async () => {
  console.log(`\nALPHASTREAM v85.0 LIVE — DUAL PRE/POST MARKET SCANNER`);
  console.log(`Pre-Market: 4:00–9:29 AM | Post-Market: 9:30 AM–8:00 PM | Close @ 3:50 PM`);
  await scanAndTrade();
  setInterval(scanAndTrade, 180000); // every 3 min
});
