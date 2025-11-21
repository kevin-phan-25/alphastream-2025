// index.js — AlphaStream v85.5 — YOUR EXACT PRE + POST MARKET SCANNERS + 3:50PM EOD CLOSE
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
const COOKIE_PATH = "/tmp/tv_cookies.json";

// ---------------- TIME HELPERS (ET) ----------------
function etHour() { return new Date().toLocaleString("en-US", { timeZone: "America/New_York", hour: "2-digit", hour12: false }); }
function etMinute() { return new Date().toLocaleString("en-US", { timeZone: "America/New_York", minute: "2-digit" }); }
function isPremarket() {
  const h = parseInt(etHour());
  const m = parseInt(etMinute());
  return (h >= 4 && h < 9) || (h === 9 && m < 30);
}
function isPostmarket() {
  const h = parseInt(etHour());
  return h >= 16 || (h >= 9 && h < 16);
}

// ---------------- LOGGING ----------------
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

// ---------------- ALPACA SYNC ----------------
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

// ---------------- PUPPETEER ----------------
async function getBrowser() {
  if (browser) return browser;
  browser = await puppeteer.launch({
    headless: true,
    executablePath: "/usr/bin/google-chrome",
    args: [
      "--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage",
      "--disable-gpu", "--single-process", "--no-zygote", "--disable-extensions"
    ],
  });
  return browser;
}

// ---------------- TV LOGIN & COOKIES ----------------
async function loginAndSaveCookies(page) {
  if (!TV_EMAIL || !TV_PASSWORD) return false;
  const saved = fs.existsSync(COOKIE_PATH) ? JSON.parse(fs.readFileSync(COOKIE_PATH)) : null;
  if (saved) {
    await page.setCookie(...saved);
    await page.goto("https://www.tradingview.com", { waitUntil: "networkidle2", timeout: 30000 }).catch(() => {});
    if (await page.$("button[data-name='user-menu']")) {
      console.log("TradingView: session restored");
      return true;
    }
  }
  await page.goto("https://www.tradingview.com/accounts/signin/", { waitUntil: "networkidle2" });
  await page.type('input[name="username"]', TV_EMAIL);
  await page.type('input[name="password"]', TV_PASSWORD);
  await Promise.all([page.click('button[type="submit"]'), page.waitForNavigation({ waitUntil: "networkidle2" }).catch(() => {})]);
  await page.waitForTimeout(3000);
  const cookies = await page.cookies();
  fs.writeFileSync(COOKIE_PATH, JSON.stringify(cookies, null, 2));
  console.log("TradingView: logged in & cookies saved");
  return true;
}

// ---------------- SCRAPER: YOUR EXACT SCANS ----------------
async function scrapePremarket() {
  const url = "https://www.tradingview.com/screener/";
  let page;
  try {
    const br = await getBrowser();
    page = await br.newPage();
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36");
    await loginAndSaveCookies(page);
    await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });
    await page.waitForTimeout(2000);
    // Click "Extended Hours" tab
    await page.click('button[data-name="extended-hours-tab"]') .catch(() => {});
    await page.waitForTimeout(3000);

    const rockets = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll("table tbody tr"));
      return rows.map(row => {
        const cells = row.querySelectorAll("td");
        const symbol = cells[0]?.querySelector("a")?.innerText.trim();
        const change = parseFloat(cells[2]?.innerText.replace(/[%+]/g, "") || "0");
        const price = parseFloat(cells[3]?.innerText.replace(/[^0-9.]/g, "") || "0");
        const volume = (cells[4]?.innerText || "").includes("M") ? parseFloat(cells[4].innerText) * 1e6 : 0;
        const floatShares = parseFloat(cells[7]?.innerText.replace(/[^0-9.]/g, "") || "0") * 1e6;
        return { symbol, price, change, volume, floatShares };
      }).filter(r => r.symbol && r.change >= 20 && r.price >= 1 && r.volume >= 500000 && r.floatShares <= 30e6);
    });

    await page.close();
    console.log(`PRE-MARKET → ${rockets.length} rockets: ${rockets.map(r => `${r.symbol} +${r.change}%`).join(", ")}`);
    return rockets.slice(0, 5);
  } catch (e) {
    console.log("Premarket scrape failed:", e.message);
    if (page) await page.close().catch(() => {});
    return [];
  }
}

async function scrapePostmarket() {
  const url = "https://www.tradingview.com/screener/";
  let page;
  try {
    const br = await getBrowser();
    page = await br.newPage();
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36");
    await loginAndSaveCookies(page);
    await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });
    await page.waitForTimeout(2000);
    await page.click('button[data-name="extended-hours-tab"]') .catch(() => {});
    await page.waitForTimeout(3000);

    const rockets = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll("table tbody tr"));
      return rows.map(row => {
        const cells = row.querySelectorAll("td");
        const symbol = cells[0]?.querySelector("a")?.innerText.trim();
        const price = parseFloat(cells[1]?.innerText.replace(/[^0-9.]/g, "") || "0");
        const change = parseFloat(cells[2]?.innerText.replace(/[%+]/g, "") || "0");
        const volume = (cells[4]?.innerText || "").includes("M") ? parseFloat(cells[4].innerText) * 1e6 : 0;
        const floatShares = parseFloat(cells[6]?.innerText.replace(/[^0-9.]/g, "") || "0") * 1e6;
        return { symbol, price, change, volume, floatShares };
      }).filter(r => r.symbol && r.price >= 1 && r.price <= 20 && r.change >= 30 && r.volume >= 1e6 && r.floatShares <= 40e6);
    });

    await page.close();
    console.log(`POST-MARKET → ${rockets.length} rockets: ${rockets.map(r => `${r.symbol} +${r.change}%`).join(", ")}`);
    return rockets.slice(0, 5);
  } catch (e) {
    console.log("Postmarket scrape failed:", e.message);
    if (page) await page.close().catch(() => {});
    return [];
  }
}

// ---------------- EOD CLOSE @ 3:50 PM ----------------
async function closeAllAt350PM() {
  const h = parseInt(etHour());
  const m = parseInt(etMinute());
  if (h === 15 && m >= 50 && m < 56 && positions.length > 0) {
    console.log("3:50 PM ET — FLATTENING ALL POSITIONS");
    for (const p of positions) {
      logTrade("EXIT", p.symbol, p.qty, p.current, "EOD FLATTEN @ 3:50 PM", p.unrealized_pl);
      if (!DRY) {
        await axios.post(`${A_BASE}/orders`, {
          symbol: p.symbol, qty: p.qty, side: "sell", type: "market", time_in_force: "day"
        }, { headers: HEADERS }).catch(() => {});
      }
    }
    positions = [];
  }
}

// ---------------- MAIN SCAN LOOP ----------------
async function scanAndTrade() {
  await updateEquityAndPositions();
  await closeAllAt350PM();
  if (dailyMaxLossHit || positions.length >= 5) return;

  let rockets = [];
  if (isPremarket()) {
    rockets = await scrapePremarket();
  } else if (isPostmarket()) {
    rockets = await scrapePostmarket();
  }

  for (const r of rockets) {
    if (positions.length >= 5 || positions.some(p => p.symbol === r.symbol)) continue;
    const qty = Math.max(1, Math.floor((accountEquity * 0.025) / r.price));
    logTrade("ENTRY", r.symbol, qty, r.price, `${isPremarket() ? "PRE" : "POST"} +${r.change}%`, 0);
    if (!DRY) {
      await axios.post(`${A_BASE}/orders`, {
        symbol: r.symbol,
        qty,
        side: "buy",
        type: "market",
        time_in_force: isPremarket() ? "opg" : "day"
      }, { headers: HEADERS }).catch(() => {});
    }
    positions.push({ symbol: r.symbol, qty, entry: r.price, current: r.price, unrealized_pl: 0 });
    await new Promise(r => setTimeout(r, 4000));
  }
}

// ---------------- DASHBOARD ----------------
app.get("/", async (req, res) => {
  await updateEquityAndPositions();
  const unrealized = positions.reduce((s, p) => s + p.unrealized_pl, 0);
  res.json({
    bot: "AlphaStream v85.5 — YOUR EXACT SCANNERS",
    mode: DRY ? "PAPER" : "LIVE",
    scanner: isPremarket() ? "PRE-MARKET" : isPostmarket() ? "POST-MARKET" : "WAITING",
    equity: `$${accountEquity.toFixed(2)}`,
    positions_count: positions.length,
    lastGainers,
    tradeLog: tradeLog.slice(-30),
    nextEOD: "3:50 PM ET"
  });
});

app.post("/scan", async (req, res) => { await scanAndTrade(); res.json({ ok: true }); });
app.get("/healthz", (_, res) => res.send("OK"));

app.listen(Number(PORT), "0.0.0.0", async () => {
  console.log(`\nALPHASTREAM v85.5 LIVE — YOUR PRE + POST SCANNERS`);
  console.log(`Premarket: 4:00–9:29 AM | Postmarket: 4:00–8:00 PM | EOD Close: 3:50 PM`);
  await scanAndTrade();
  setInterval(scanAndTrade, 180000); // 3 min
});
