// index.js — AlphaStream v90.0 — PURE ROCKET HUNTER (NO LIMITS • PAPER READY)
import express from "express";
import cors from "cors";
import axios from "axios";
import puppeteer from "puppeteer";
import fs from "fs";

const app = express();
app.use(cors());
app.use(express.json());

const {
  ALPACA_KEY = "",
  ALPACA_SECRET = "",
  DRY_MODE = "true",
  PORT = "8080",
  TV_EMAIL = "",
  TV_PASSWORD = ""
} = process.env;

const DRY = DRY_MODE.toLowerCase() === "true";
const IS_PAPER = DRY || !ALPACA_KEY.includes("live");
const A_BASE = IS_PAPER ? "https://paper-api.alpaca.markets/v2" : "https://api.alpaca.markets/v2";
const HEADERS = { "APCA-API-KEY-ID": ALPACA_KEY, "APCA-API-SECRET-KEY": ALPACA_SECRET };

let accountEquity = 100000;
let positions = [];
let lastRockets = [];  // renamed for clarity
let browser = null;
let sharedPage = null;

// TIME HELPERS
const etHour = () => parseInt(new Date().toLocaleString("en-US", { timeZone: "America/New_York", hour: "2-digit", hour12: false }));
const etMinute = () => parseInt(new Date().toLocaleString("en-US", { timeZone: "America/New_York", minute: "2-digit" }));
const isPremarket = () => {
  const h = etHour(), m = etMinute();
  return (h >= 4 && h < 9) || (h === 9 && m < 30);
};
const isMarketOpen = () => {
  const h = etHour();
  return h >= 9 && h < 16;
};

// LOGGING
function logTrade(type, symbol, qty, price, reason = "", pnl = 0) {
  const line = `[${DRY?"PAPER":"LIVE"}] ${type} ${symbol} ×${qty} @ $${price.toFixed(3)} | ${reason} | ${pnl >= 0 ? "+" : ""}$${Math.abs(pnl).toFixed(2)}`;
  console.log(line);
  try { fs.appendFileSync("trades.log", line + "\n"); } catch {}
}

// UPDATE EQUITY & POSITIONS
async function updateEquityAndPositions() {
  if (!ALPACA_KEY) return;
  try {
    const [acct, pos] = await Promise.all([
      axios.get(`${A_BASE}/account`, { headers: HEADERS, timeout: 15000 }),
      axios.get(`${A_BASE}/positions`, { headers: HEADERS, timeout: 15000 }).catch(() => ({ data: [] }))
    ]);
    accountEquity = parseFloat(acct.data.equity || accountEquity);
    const live = (pos.data || []).reduce((m, p) => (m[p.symbol] = { qty: +p.qty, current: +p.current_price }, m), {});
    positions = positions.map(p => {
      const cp = live[p.symbol]?.current || p.current;
      return { ...p, current: cp, qty: live[p.symbol]?.qty ?? p.qty, peakPrice: Math.max(p.peakPrice || p.entry, cp) };
    }).filter(p => p.qty > 0);
  } catch (e) { console.log("Alpaca sync error:", e.message); }
}

// PUPPETEER — Cloud Run safe (NO executablePath)
async function getPage() {
  if (!browser) {
    browser = await puppeteer.launch({
      headless: true,
      args: [
        "--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage",
        "--single-process", "--no-zygote", "--disable-gpu"
      ]
    });
  }
  if (!sharedPage || sharedPage.isClosed()) {
    sharedPage = await browser.newPage();
    await sharedPage.setViewport({ width: 1920, height: 1080 });
    await sharedPage.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36");
  }
  return sharedPage;
}

// ROBUST TRADINGVIEW LOGIN (same as v88.2 — proven)
async function loginTV(page) {
  if (!TV_EMAIL || !TV_PASSWORD) return false;
  for (let i = 0; i < 3; i++) {
    try {
      await page.goto("https://www.tradingview.com/", { waitUntil: "networkidle2", timeout: 60000 });
      if (await page.$("[data-name='header-user-menu-button']")) return true;

      await page.evaluate(() => {
        const btn = [...document.querySelectorAll("button,a")].find(el => /sign in/i.test(el.textContent || ""));
        btn?.click();
      });
      await page.waitForTimeout(5000);

      await page.evaluate(() => {
        document.querySelectorAll(".tv-cookie-banner, .tv-dialog, .tv-banner").forEach(el => el.remove());
      });

      await page.waitForSelector('input[data-name="username-input"], input[placeholder*="Email"], input[type="text"]', { timeout: 30000 });
      await page.click('input[data-name="username-input"], input[placeholder*="Email"], input[type="text"]');
      await page.keyboard.down('Control'); await page.keyboard.press('A'); await page.keyboard.up('Control');
      await page.type('input[data-name="username-input"], input[placeholder*="Email"]', TV_EMAIL, { delay: 70 });
      await page.type('input[type="password"]', TV_PASSWORD, { delay: 70 });

      await Promise.all([
        page.click('button:has-text("Sign in"), button[type="submit"]'),
        page.waitForNavigation({ waitUntil: "networkidle2", timeout: 40000 }).catch(() => {})
      ]);

      await page.waitForTimeout(6000);
      if (await page.$("[data-name='header-user-menu-button']")) {
        console.log("TV LOGIN SUCCESS");
        return true;
      }
    } catch (e) { console.log("Login retry:", e.message); }
  }
  console.log("TV LOGIN FAILED");
  return false;
}

async function openExtended(page) {
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll("button")].find(b => /extended|pre|post/i.test(b.textContent || ""));
    btn?.click();
  });
  await page.waitForTimeout(6000);
}

// AGGRESSIVE SCRAPER — v90 ROCKET FILTERS
async function scrape() {
  const page = await getPage();
  const start = Date.now();
  const premarket = isPremarket();

  try {
    await loginTV(page);
    await page.goto("https://www.tradingview.com/screener/", { waitUntil: "networkidle2", timeout: 60000 });
    await openExtended(page);

    const rockets = await page.evaluate((isPre) => {
      return Array.from(document.querySelectorAll("table tbody tr")).map(r => {
        const c = r.querySelectorAll("td");
        const symbol = c[0]?.querySelector("a")?.innerText.trim();
        const change = parseFloat(c[2]?.innerText.replace(/[%+]/g, "") || "0");
        const price = parseFloat((c[1]?.innerText || c[3]?.innerText || "0").replace(/[^0-9.]/g, "")) || 0;
        const vol = c[4]?.innerText.includes("M") ? parseFloat(c[4].innerText) * 1e6 : 0;
        const fl = parseFloat((c[6]?.innerText || c[7]?.innerText || "0").replace(/[^0-9.]/g, "") || "0") * 1e6;
        return { symbol, price, change, vol, fl };
      }).filter(r => r.symbol && r.price > 0.5).filter(r => {
        return isPre
          ? r.change >= 25 && r.price >= 0.8 && r.vol >= 600000 && r.fl <= 35e6
          : r.change >= 35 && r.price <= 25 && r.vol >= 1.5e6 && r.fl <= 50e6;
      }).sort((a, b) => b.change - a.change);
    }, premarket);

    console.log(`${premarket ? "PRE" : "POST"} → ${rockets.length} ROCKETS (${((Date.now()-start)/1000).toFixed(1)}s)`);
    return rockets;
  } catch (e) {
    console.log("Scrape error:", e.message);
    return [];
  }
}

// PURE EXIT LOGIC — NO PROP-FIRM BULLSHIT
async function exit(symbol, qty, price, reason) {
  const pos = positions.find(p => p.symbol === symbol);
  if (!pos) return;
  const pnl = (price - pos.entry) * qty;
  logTrade("EXIT", symbol, qty, price, reason, pnl);
  if (!DRY && ALPACA_KEY) {
    await axios.post(`${A_BASE}/orders`, { symbol, qty, side: "sell", type: "market", time_in_force: "day" }, { headers: HEADERS }).catch(() => {});
  }
  pos.qty -= qty;
  if (pos.qty <= 0) positions = positions.filter(p => p.symbol !== symbol);
}

async function checkProfitTargets() {
  for (const p of positions) {
    const pnlPct = ((p.current - p.entry) / p.entry) * 100;
    const trailDrop = ((p.current - p.peakPrice) / p.peakPrice) * 100;

    if (trailDrop <= -18) { await exit(p.symbol, p.qty, p.current, "TRAIL -18%"); continue; }
    if (pnlPct >= 300) { await exit(p.symbol, p.qty, p.current, "+300% MOON EXIT"); }
    if (pnlPct >= 200) { await exit(p.symbol, Math.floor(p.qty * 0.5), p.current, "+200% TAKE 50%"); }
    if (pnlPct >= 100) { await exit(p.symbol, Math.floor(p.qty * 0.3), p.current, "+100% TAKE 30%"); }
  }
}

// NO EOD FLATTEN — we ride winners overnight if they want
// Only flatten at 3:50 PM if you want — optional
async function optionalEODFlatten() {
  if (etHour() === 15 && etMinute() >= 50 && positions.length) {
    console.log("3:50 PM — OPTIONAL FLATTEN");
    for (const p of positions) await exit(p.symbol, p.qty, p.current, "EOD FLATTEN");
  }
}

// PURE ROCKET HUNTING
async function scanAndTrade() {
  if (!isMarketOpen()) return;
  try {
    await updateEquityAndPositions();
    await optionalEODFlatten();
    await checkProfitTargets();

    const rockets = await scrape();
    if (rockets.length === 0) return;

    for (const r of rockets.slice(0, 10)) {  // up to 10 rockets — no mercy
      if (positions.some(p => p.symbol === r.symbol)) continue;

      const qty = Math.max(1, Math.floor(accountEquity * 0.04 / r.price)); // 4% per rocket
      logTrade("ENTRY", r.symbol, qty, r.price, `${isPremarket()?"PRE":"POST"} +${r.change.toFixed(1)}%`, 0);

      if (!DRY) {
        await axios.post(`${A_BASE}/orders`, {
          symbol: r.symbol, qty, side: "buy", type: "market",
          time_in_force: isPremarket() ? "opg" : "day"
        }, { headers: HEADERS }).catch(() => {});
      }

      positions.push({
        symbol: r.symbol, qty, entry: r.price, current: r.price,
        peakPrice: r.price
      });
      await new Promise(r => setTimeout(r, 3000));
    }

    lastRockets = rockets.map(r => `${r.symbol}+${r.change.toFixed(1)}%`);
  } catch (e) { console.log("scanAndTrade error:", e.message); }
}

// DASHBOARD — matches your v90 dashboard
app.get("/", async (req, res) => {
  await updateEquityAndPositions();
  const unreal = positions.reduce((s, p) => s + (p.current - p.entry) * p.qty, 0);
  res.json({
    bot: "AlphaStream v90.0 — PURE ROCKET HUNTER",
    mode: DRY ? "PAPER" : "LIVE",
    equity: `$${accountEquity.toFixed(0)}`,
    unrealized: unreal > 0 ? `+$${unreal.toFixed(0)}` : `$${unreal.toFixed(0)}`,
    positions: positions.length,
    rockets: lastRockets
  });
});

app.post("/scan", async (req, res) => { await scanAndTrade(); res.json({ ok: true }); });
app.get("/healthz", (_, res) => res.send("OK"));

app.listen(Number(PORT), "0.0.0.0", async () => {
  console.log(`\nALPHASTREAM v90.0 — PURE ROCKET HUNTER — NO LIMITS`);
  await scanAndTrade();
  setInterval(() => scanAndTrade().catch(() => {}), 180000);
});
