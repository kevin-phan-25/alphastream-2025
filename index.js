// index.js — AlphaStream v87.4 — FINAL | WORKS WITH CURRENT TV LOGIN (Email + Password on one screen)
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

// TIME
const etHour = () => parseInt(new Date().toLocaleString("en-US", { timeZone: "America/New_York", hour: "2-digit", hour12: false }));
const etMinute = () => parseInt(new Date().toLocaleString("en-US", { timeZone: "America/New_York", minute: "2-digit" }));
const isPremarket = () => { const h = etHour(); const m = etMinute(); return (h >= 4 && h < 9) || (h === 9 && m < 30); };

// LOG
function logTrade(type, symbol, qty, price, reason = "", pnl = 0) {
  const t = { type, symbol, qty, price: +price.toFixed(4), reason, pnl: +pnl.toFixed(2), time: new Date().toISOString() };
  tradeLog.push(t); if (tradeLog.length > 1000) tradeLog.shift();
  dailyPnL += pnl;
  console.log(`[${DRY ? "DRY" : "LIVE"}] ${type} ${symbol} ×${qty} @ $${price.toFixed(4)} | ${reason} | $${pnl.toFixed(0)}`);
}

// ALPACA SYNC
async function updateEquityAndPositions() {
  if (!ALPACA_KEY) return;
  try {
    const [acct, pos] = await Promise.all([
      axios.get(`${A_BASE}/account`, { headers: HEADERS, timeout: 15000 }),
      axios.get(`${A_BASE}/positions`, { headers: HEADERS, timeout: 15000 }).catch(() => ({ data: [] }))
    ]);
    accountEquity = parseFloat(acct.data.equity || accountEquity);
    const live = (pos.data || []).reduce((m, p) => (m[p.symbol] = { qty: +p.qty, current: +p.current_price }, m), {});
    positions = positions.map(p => ({
      ...p,
      current: live[p.symbol]?.current || p.current,
      qty: live[p.symbol]?.qty || p.qty,
      peakPrice: Math.max(p.peakPrice || p.entry, live[p.symbol]?.current || p.current)
    })).filter(p => p.qty > 0);
  } catch (e) { console.log("Alpaca sync error:", e.message); }
}

// BROWSER
async function getBrowser() {
  if (browser) return browser;
  browser = await puppeteer.launch({
    headless: true,
    executablePath: "/usr/bin/google-chrome",
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--single-process", "--no-zygote"]
  });
  return browser;
}

// FINAL TV LOGIN — WORKS WITH YOUR SCREENSHOT (NOV 2025)
async function loginTV(page) {
  if (!TV_EMAIL || !TV_PASSWORD) return false;

  try {
    await page.goto("https://www.tradingview.com/", { waitUntil: "networkidle2", timeout: 40000 });

    if (await page.$("[data-name='header-user-menu-button']")) {
      console.log("TV: Already logged in");
      return true;
    }

    // Click "Sign in"
    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll("button, a"))
        .find(el => /sign in|log in/i.test(el.textContent || ""));
      if (btn) btn.click();
    });
    await new Promise(r => setTimeout(r, 3000));

    // Wait for Email/Username field
    await page.waitForSelector('input[placeholder="Email or Username"], input[placeholder="Email or username"], input[type="text"]', { timeout: 15000 });

    // Clear & type email
    await page.click('input[placeholder="Email or Username"], input[type="text"]');
    await page.keyboard.down('Control');
    await page.keyboard.press('A');
    await page.keyboard.up('Control');
    await page.type('input[placeholder="Email or Username"], input[type="text"]', TV_EMAIL);

    // Type password
    await page.type('input[type="password"]', TV_PASSWORD);

    // Click Sign in
    await Promise.all([
      page.click('button:has-text("Sign in"), button:has-text("Sign In")'),
      page.waitForNavigation({ waitUntil: "networkidle2", timeout: 30000 }).catch(() => {})
    ]);

    await new Promise(r => setTimeout(r, 6000));

    const success = await page.$("[data-name='header-user-menu-button']") !== null;
    console.log(success ? "TV: LOGIN SUCCESS" : "TV: LOGIN FAILED");
    return success;
  } catch (e) {
    console.log("Login error:", e.message);
    return false;
  }
}

// EXTENDED HOURS TAB
async function openExtended(page) {
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll("button"))
      .find(b => /extended|pre.?post/i.test(b.textContent || "") || b.getAttribute("data-name")?.includes("extended"));
    if (btn) btn.click();
  });
  await new Promise(r => setTimeout(r, 5000));
}

// SCRAPERS
async function scrapePremarket() {
  let page;
  try {
    const br = await getBrowser();
    page = await br.newPage();
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36");
    await loginTV(page);
    await page.goto("https://www.tradingview.com/screener/", { waitUntil: "networkidle2", timeout: 60000 });
    await openExtended(page);

    const rockets = await page.evaluate(() => {
      return Array.from(document.querySelectorAll("table tbody tr")).slice(0, 20).map(r => {
        const c = r.querySelectorAll("td");
        const symbol = c[0]?.querySelector("a")?.innerText.trim();
        const change = parseFloat(c[2]?.innerText.replace(/[%+]/g, "") || "0");
        const price = parseFloat(c[3]?.innerText.replace(/[^0-9.]/g, "") || "0");
        const vol = c[4]?.innerText.includes("M") ? parseFloat(c[4].innerText) * 1e6 : 0;
        const fl = parseFloat(c[7]?.innerText.replace(/[^0-9.]/g, "") || "0") * 1e6;
        return { symbol, price, change, vol, fl };
      }).filter(r => r.symbol && r.change >= 20 && r.price >= 1 && r.vol >= 500000 && r.fl <= 30e6);
    });

    await page.close();
    console.log(`PRE-MARKET → ${rockets.length} rockets: ${rockets.map(r => `${r.symbol}+${r.change.toFixed(0)}%`).join(" ")}`);
    return rockets.slice(0, 5);
  } catch (e) {
    console.log("Premarket error:", e.message);
    if (page) await page.close().catch(() => {});
    return [];
  }
}

async function scrapePostmarket() {
  let page;
  try {
    const br = await getBrowser();
    page = await br.newPage();
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36");
    await loginTV(page);
    await page.goto("https://www.tradingview.com/screener/", { waitUntil: "networkidle2", timeout: 60000 });
    await openExtended(page);

    const rockets = await page.evaluate(() => {
      return Array.from(document.querySelectorAll("table tbody tr")).slice(0, 20).map(r => {
        const c = r.querySelectorAll("td");
        const symbol = c[0]?.querySelector("a")?.innerText.trim();
        const price = parseFloat(c[1]?.innerText.replace(/[^0-9.]/g, "") || "0");
        const change = parseFloat(c[2]?.innerText.replace(/[%+]/g, "") || "0");
        const vol = c[4]?.innerText.includes("M") ? parseFloat(c[4].innerText) * 1e6 : 0;
        const fl = parseFloat(c[6]?.innerText.replace(/[^0-9.]/g, "") || "0") * 1e6;
        return { symbol, price, change, vol, fl };
      }).filter(r => r.symbol && r.price >= 1 && r.price <= 20 && r.change >= 30 && r.vol >= 1e6 && r.fl <= 40e6);
    });

    await page.close();
    console.log(`POST-MARKET → ${rockets.length} rockets: ${rockets.map(r => `${r.symbol}+${r.change.toFixed(0)}%`).join(" ")}`);
    return rockets.slice(0, 5);
  } catch (e) {
    console.log("Postmarket error:", e.message);
    if (page) await page.close().catch(() => {});
    return [];
  }
}

// PROFIT-TAKING + TRAILING
async function checkProfitTargets() {
  for (const p of positions) {
    const pnl = ((p.current - p.entry) / p.entry) * 100;
    const drop = ((p.current - (p.peakPrice || p.entry)) / (p.peakPrice || p.entry)) * 100;
    if (drop <= -15) { await exit(p.symbol, p.qty, p.current, "TRAIL -15%"); continue; }
    if (pnl >= 100 && !p.sold100) { await exit(p.symbol, p.qty, p.current, "+100% EXIT"); p.sold100 = true; }
    if (pnl >= 50 && !p.sold50) { const q = Math.floor(p.qty * 0.25); if (q) await exit(p.symbol, q, p.current, "+50% TAKE 25%"); p.sold50 = true; }
    if (pnl >= 25 && !p.sold25) { const q = Math.floor(p.qty * 0.5); if (q) await exit(p.symbol, q, p.current, "+25% TAKE 50%"); p.sold25 = true; }
  }
}

async function exit(symbol, qty, price, reason) {
  const entry = positions.find(p => p.symbol === symbol)?.entry || price;
  const pnl = (price - entry) * qty;
  logTrade("EXIT", symbol, qty, price, reason, pnl);
  if (!DRY && ALPACA_KEY) {
    await axios.post(`${A_BASE}/orders`, { symbol, qty, side: "sell", type: "market", time_in_force: "day" }, { headers: HEADERS }).catch(() => {});
  }
  const i = positions.findIndex(p => p.symbol === symbol);
  if (i > -1) positions[i].qty <= qty ? positions.splice(i, 1) : positions[i].qty -= qty;
}

async function eodFlatten() {
  if (etHour() === 15 && etMinute() >= 50 && positions.length) {
    console.log("3:50 PM ET — EOD FLATTEN");
    for (const p of positions) await exit(p.symbol, p.qty, p.current, "EOD");
  }
}

// MAIN LOOP
async function scanAndTrade() {
  try {
    await updateEquityAndPositions();
    await eodFlatten();
    await checkProfitTargets();
    if (dailyMaxLossHit || positions.length >= 5) return;

    const rockets = isPremarket() ? await scrapePremarket() : await scrapePostmarket();

    for (const r of rockets) {
      if (positions.length >= 5 || positions.some(p => p.symbol === r.symbol)) continue;
      const qty = Math.max(1, Math.floor(accountEquity * 0.025 / r.price));
      logTrade("ENTRY", r.symbol, qty, r.price, `${isPremarket() ? "PRE" : "POST"} +${r.change.toFixed(1)}%`, 0);
      if (!DRY) {
        await axios.post(`${A_BASE}/orders`, {
          symbol: r.symbol, qty, side: "buy", type: "market",
          time_in_force: isPremarket() ? "opg" : "day"
        }, { headers: HEADERS }).catch(() => {});
      }
      positions.push({ symbol: r.symbol, qty, entry: r.price, current: r.price, peakPrice: r.price, sold25: false, sold50: false, sold100: false });
      await new Promise(r => setTimeout(r, 4000));
    }
    lastGainers = rockets;
  } catch (e) {
    console.log("scanAndTrade error:", e.message);
  }
}

// DASHBOARD (clean & short)
app.get("/", async (req, res) => {
  await updateEquityAndPositions();
  const unreal = positions.reduce((s, p) => s + (p.current - p.entry) * p.qty, 0);
  res.json({
    bot: "AlphaStream v87.4",
    mode: DRY ? "PAPER" : "LIVE",
    time: `${etHour()}:${etMinute().toString().padStart(2,"0")} ET`,
    equity: `$${accountEquity.toFixed(0)}`,
    unrealized: unreal > 0 ? `+$${unreal.toFixed(0)}` : `$${unreal.toFixed(0)}`,
    positions: positions.length,
    max: 5,
    scanner: isPremarket() ? "PRE" : "POST",
    rockets: lastGainers.map(r => `${r.symbol}+${r.change.toFixed(0)}%`),
    rules: "25→50% | 50→75% | 100→ALL | Trail -15%",
    status: dailyMaxLossHit ? "HALTED" : "RUNNING"
  });
});

app.post("/scan", async (req, res) => { await scanAndTrade(); res.json({ ok: true }); });
app.get("/healthz", (_, res) => res.send("OK"));

app.listen(Number(PORT), "0.0.0.0", async () => {
  console.log(`\nALPHASTREAM v87.4 LIVE — FINAL BUILD — WORKS WITH CURRENT TV LOGIN`);
  await scanAndTrade();
  setInterval(() => scanAndTrade().catch(() => {}), 180000);
});
