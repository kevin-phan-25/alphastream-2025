// index.js — AlphaStream v86.5 — FINAL: DUAL SCANNER + PROFIT-TAKING + TRAILING STOP + CLOUD RUN READY
import express from "express";
import cors from "cors";
import axios from "axios";
import puppeteer from "puppeteer";

const app = express();
app.use(cors());
app.use(express.json());

const {
  ALPACA_KEY = "", ALPACA_SECRET = "", DRY_MODE = "true", PORT = "8080",
  MAX_DAILY_LOSS = "500", TV_EMAIL = "", TV_PASSWORD = ""
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
let dailyPnL = 0;
let dailyMaxLossHit = false;
let browser = null;

// ---------------- TIME HELPERS ----------------
function etHour() { return parseInt(new Date().toLocaleString("en-US", { timeZone: "America/New_York", hour: "2-digit", hour12: false })); }
function etMinute() { return parseInt(new Date().toLocaleString("en-US", { timeZone: "America/New_York", minute: "2-digit" })); }
function isPremarket() { const h = etHour(); const m = etMinute(); return (h >= 4 && h < 9) || (h === 9 && m < 30); }
function isRegularHours() { const h = etHour(); return h >= 9 && h < 16; }
function isPostmarket() { return etHour() >= 16 || etHour() < 4; }

// ---------------- LOGGING ----------------
function logTrade(type, symbol, qty, price, reason = "", pnl = 0) {
  const trade = { type, symbol, qty, price: Number(price).toFixed(4), timestamp: new Date().toISOString(), reason, pnl: Number(pnl).toFixed(2) };
  tradeLog.push(trade);
  if (tradeLog.length > 1000) tradeLog.shift();
  dailyPnL += pnl;
  console.log(`[${DRY ? "DRY" : "LIVE"}] ${type} ${symbol} ×${qty} @ $${price} | ${reason} | PnL: $${pnl.toFixed(2)}`);
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
    const livePos = (pos.data || []).reduce((map, p) => {
      map[p.symbol] = { qty: Number(p.qty), current: Number(p.current_price), unrealized_pl: Number(p.unrealized_pl || 0) };
      return map;
    }, {});

    positions = positions.map(p => {
      const live = livePos[p.symbol] || { current: p.current, qty: p.qty };
      const peakPrice = Math.max(p.peakPrice || p.entry, live.current);
      return { ...p, current: live.current, peakPrice, qty: live.qty };
    }).filter(p => p.qty > 0);

    console.log(`Alpaca sync → $${accountEquity.toFixed(2)} | ${positions.length} positions`);
  } catch (e) { console.log("Alpaca sync error:", e.message); }
}

// ---------------- PUPPETEER BROWSER ----------------
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

// ---------------- TV LOGIN (COOKIE PERSISTENCE) ----------------
async function ensureTVLogin(page) {
  if (!TV_EMAIL || !TV_PASSWORD) return false;
  try {
    await page.goto("https://www.tradingview.com", { waitUntil: "networkidle2", timeout: 30000 });
    const loggedIn = await page.$("button[data-name='user-menu']");
    if (loggedIn) return true;

    await page.goto("https://www.tradingview.com/accounts/signin/", { waitUntil: "networkidle2" });
    await page.type('input[name="username"]', TV_EMAIL);
    await page.type('input[name="password"]', TV_PASSWORD);
    await Promise.all([
      page.click('button[type="submit"]'),
      page.waitForNavigation({ waitUntil: "networkidle2", timeout: 30000 }).catch(() => {})
    ]);
    await page.waitForTimeout(3000);
    return !!(await page.$("button[data-name='user-menu']"));
  } catch (e) {
    console.log("TV login failed:", e.message);
    return false;
  }
}

// ---------------- EXACT PREMARKET SCANNER ----------------
async function scrapePremarket() {
  let page;
  try {
    const br = await getBrowser();
    page = await br.newPage();
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36");
    await ensureTVLogin(page);
    await page.goto("https://www.tradingview.com/screener/", { waitUntil: "networkidle2", timeout: 60000 });
    await page.waitForTimeout(3000);

    const rockets = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll("table tbody tr"));
      return rows.map(row => {
        const cells = row.querySelectorAll("td");
        const symbol = cells[0]?.querySelector("a")?.innerText.trim();
        const change = parseFloat(cells[2]?.innerText.replace(/[%+]/g, "") || "0");
        const price = parseFloat(cells[3]?.innerText.replace(/[^0-9.]/g, "") || "0");
        const volume = cells[4]?.innerText.includes("M") ? parseFloat(cells[4].innerText) * 1e6 : 0;
        const floatShares = parseFloat(cells[7]?.innerText.replace(/[^0-9.]/g, "") || "0") * 1e6;
        return { symbol, price, change, volume, floatShares };
      }).filter(r => r.symbol && r.change >= 20 && r.price >= 1 && r.volume >= 500000 && r.floatShares <= 30e6);
    });

    await page.close();
    console.log(`PRE-MARKET → ${rockets.length} rockets: ${rockets.map(r => `${r.symbol} +${r.change}%`).join(", ")}`);
    return rockets.slice(0, 5);
  } catch (e) {
    console.log("Premarket scrape error:", e.message);
    if (page) await page.close().catch(() => {});
    return [];
  }
}

// ---------------- EXACT POSTMARKET SCANNER ----------------
async function scrapePostmarket() {
  let page;
  try {
    const br = await getBrowser();
    page = await br.newPage();
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36");
    await ensureTVLogin(page);
    await page.goto("https://www.tradingview.com/screener/", { waitUntil: "networkidle2", timeout: 60000 });
    await page.click('button[data-name="extended-hours-tab"]');
    await page.waitForTimeout(4000);

    const rockets = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll("table tbody tr"));
      return rows.map(row => {
        const cells = row.querySelectorAll("td");
        const symbol = cells[0]?.querySelector("a")?.innerText.trim();
        const price = parseFloat(cells[1]?.innerText.replace(/[^0-9.]/g, "") || "0");
        const change = parseFloat(cells[2]?.innerText.replace(/[%+]/g, "") || "0");
        const volume = cells[4]?.innerText.includes("M") ? parseFloat(cells[4].innerText) * 1e6 : 0;
        const floatShares = parseFloat(cells[6]?.innerText.replace(/[^0-9.]/g, "") || "0") * 1e6;
        return { symbol, price, change, volume, floatShares };
      }).filter(r => r.symbol && r.price >= 1 && r.price <= 20 && r.change >= 30 && r.volume >= 1e6 && r.floatShares <= 40e6);
    });

    await page.close();
    console.log(`POST-MARKET → ${rockets.length} rockets: ${rockets.map(r => `${r.symbol} +${r.change}%`).join(", ")}`);
    return rockets.slice(0, 5);
  } catch (e) {
    console.log("Postmarket scrape error:", e.message);
    if (page) await page.close().catch(() => {});
    return [];
  }
}

// ---------------- PROFIT-TAKING + TRAILING STOP ----------------
async function checkProfitTargets() {
  if (positions.length === 0) return;
  for (const pos of positions) {
    const { symbol, qty, entry, current, peakPrice = entry } = pos;
    const pnlPct = ((current - entry) / entry) * 100;
    const fromPeak = ((current - peakPrice) / peakPrice) * 100;

    if (fromPeak <= -15) {
      await exitPosition(symbol, pos.qty, current, "TRAILING STOP -15%");
      continue;
    }
    if (pnlPct >= 100 && !pos.sold100) {
      await exitPosition(symbol, pos.qty, current, "+100% FULL EXIT");
      pos.sold100 = true;
    }
    if (pnlPct >= 50 && !pos.sold50) {
      const sellQty = Math.floor(qty * 0.25);
      if (sellQty > 0) await exitPosition(symbol, sellQty, current, "+50% TAKE 25%");
      pos.sold50 = true;
    }
    if (pnlPct >= 25 && !pos.sold25) {
      const sellQty = Math.floor(qty * 0.5);
      if (sellQty > 0) await exitPosition(symbol, sellQty, current, "+25% TAKE 50%");
      pos.sold25 = true;
    }
  }
}

async function exitPosition(symbol, qty, price, reason) {
  const entry = positions.find(p => p.symbol === symbol)?.entry || price;
  const pnl = (price - entry) * qty;
  logTrade("EXIT", symbol, qty, price, reason, pnl);
  if (!DRY && ALPACA_KEY) {
    await axios.post(`${A_BASE}/orders`, { symbol, qty, side: "sell", type: "market", time_in_force: "day" }, { headers: HEADERS }).catch(() => {});
  }
  const idx = positions.findIndex(p => p.symbol === symbol);
  if (idx !== -1) {
    if (positions[idx].qty <= qty) positions.splice(idx, 1);
    else positions[idx].qty -= qty;
  }
}

async function eodFlatten() {
  const h = etHour(); const m = etMinute();
  if (h === 15 && m >= 50 && m < 56 && positions.length > 0) {
    console.log("3:50 PM ET — EOD FLATTEN");
    for (const p of positions) await exitPosition(p.symbol, p.qty, p.current, "EOD FLATTEN");
  }
}

async function scanAndTrade() {
  await updateEquityAndPositions();
  await eodFlatten();
  await checkProfitTargets();
  if (dailyMaxLossHit || positions.length >= 5) return;

  let rockets = [];
  if (isPremarket()) rockets = await scrapePremarket();
  else if (isRegularHours() || isPostmarket()) rockets = await scrapePostmarket();

  for (const r of rockets) {
    if (positions.length >= 5 || positions.some(p => p.symbol === r.symbol)) continue;
    const qty = Math.max(1, Math.floor((accountEquity * 0.025) / r.price));
    logTrade("ENTRY", r.symbol, qty, r.price, `${isPremarket() ? "PRE" : "POST"} +${r.change.toFixed(1)}%`, 0);
    if (!DRY) {
      await axios.post(`${A_BASE}/orders`, {
        symbol: r.symbol, qty, side: "buy", type: "market",
        time_in_force: isPremarket() ? "opg" : "day"
      }, { headers: HEADERS }).catch(() => {});
    }
    positions.push({
      symbol: r.symbol, qty, entry: r.price, current: r.price,
      peakPrice: r.price, sold25: false, sold50: false, sold100: false
    });
    await new Promise(r => setTimeout(r, 4000));
  }
  lastGainers = rockets;
}

// ---------------- DASHBOARD ----------------
app.get("/", async (req, res) => {
  await updateEquityAndPositions();
  const unrealized = positions.reduce((s, p) => s + (p.current - p.entry) * p.qty, 0);
  res.json({
    bot: "AlphaStream v86.5 — FINAL BUILD",
    mode: DRY ? "PAPER" : "LIVE",
    scanner: isPremarket() ? "PRE-MARKET" : "POST-MARKET",
    equity: `$${accountEquity.toFixed(2)}`,
    dailyPnL: `$${unrealized.toFixed(2)}`,
    positions_count: positions.length,
    positions: positions.map(p => ({
      symbol: p.symbol, qty: p.qty, entry: p.entry.toFixed(4), current: p.current.toFixed(4),
      pnlPct: (((p.current - p.entry) / p.entry) * 100).toFixed(2) + "%"
    })),
    lastGainers,
    profitRules: "25%→50% | 50%→75% | 100%→100% | Trail -15%",
    nextEOD: "3:50 PM ET"
  });
});

app.post("/scan", async (req, res) => { await scanAndTrade(); res.json({ ok: true }); });
app.get("/healthz", (_, res) => res.send("OK"));

app.listen(Number(PORT), "0.0.0.0", async () => {
  console.log(`\nALPHASTREAM v86.5 LIVE — FINAL BUILD`);
  console.log(`Premarket 4:00–9:29 | Postmarket 4:00–8:00 PM | Profit-Taking + Trailing Stop`);
  await scanAndTrade();
  setInterval(scanAndTrade, 180000); // 3 min
});
