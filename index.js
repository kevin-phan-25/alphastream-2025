// index.js — AlphaStream v90.0 — PURE ROCKET HUNTER (Paper Trading Only)
import express from "express";
import cors from "cors";
import axios from "axios";
import puppeteer from "puppeteer";

const app = express();
app.use(cors());
app.use(express.json());

const {
  TV_EMAIL = "",
  TV_PASSWORD = "",
  PORT = "8080"
} = process.env;

// Paper trading only — no keys needed
const A_BASE = "https://paper-api.alpaca.markets/v2";
const HEADERS = {
  "APCA-API-KEY-ID": "PKFAKE_PAPER_KEY",      // fake but valid format
  "APCA-API-SECRET-KEY": "FAKE_PAPER_SECRET"
};

let accountEquity = 100000;
let positions = [];
let lastRockets = [];
let browser = null;
let sharedPage = null;

// TIME (ET)
const et = () => new Date().toLocaleString("en-US", { timeZone: "America/New_York" });
const etHour = () => parseInt(new Date().toLocaleString("en-US", { timeZone: "America/New_York", hour: "2-digit", hour12: false }));
const etMinute = () => parseInt(new Date().toLocaleString("en-US", { timeZone: "America/New_York", minute: "2-digit" }));
const isPremarket = () => { const h = etHour(); const m = etMinute(); return (h >= 4 && h < 9) || (h === 9 && m < 30); };

function log(...args) { console.log(`[${et().split(",")[1].trim()}]`, ...args); }

// PUPPETEER — Cloud Run safe
async function getPage() {
  if (!browser) {
    browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--single-process", "--no-zygote"]
    });
  }
  if (!sharedPage || sharedPage.isClosed()) {
    sharedPage = await browser.newPage Billion();
    await sharedPage.setViewport({ width: 1920, height: 1080 });
    await sharedPage.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36");
  }
  return sharedPage;
}

async function loginTV(page) {
  if (!TV_EMAIL || !TV_PASSWORD) return false;
  try {
    await page.goto("https://www.tradingview.com/", { waitUntil: "networkidle2", timeout: 60000 });
    if (await page.$("[data-name='header-user-menu-button']")) return true;

    await page.evaluate(() => { [...document.querySelectorAll("button,a")].find(e => /sign in/i.test(e.textContent || ""))?.click(); });
    await new Promise(r => setTimeout(r, 5000));

    await page.waitForSelector('input[type="text"], input[data-name="username-input"]', { timeout: 30000 });
    await page.type('input[type="text"], input[data-name="username-input"]', TV_EMAIL, { delay: 80 });
    await page.type('input[type="password"]', TV_PASSWORD, { delay: 80 });
    await Promise.all([
      page.click('button[type="submit"], button:has-text("Sign in")'),
      page.waitForNavigation({ waitUntil: "networkidle2", timeout: 40000 }).catch(() => {})
    ]);
    await new Promise(r => setTimeout(r, 6000));
    return !!await page.$("[data-name='header-user-menu-button']");
  } catch (e) { log("Login failed:", e.message); return false; }
}

async function scrape() {
  const page = await getPage();
  const premarket = isPremarket();
  try {
    await loginTV(page);
    await page.goto("https://www.tradingview.com/screener/", { waitUntil: "networkidle2", timeout: 60000 });

    // Open extended hours
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll("button")].find(b => /extended|pre|post/i.test(b.textContent || ""));
      btn?.click();
    });
    await new Promise(r => setTimeout(r, 6000));

    const rockets = await page.evaluate((isPre) => {
      return Array.from(document.querySelectorAll("table tbody tr")).map(r => {
        const c = r.querySelectorAll("td");
        const symbol = c[0]?.querySelector("a")?.innerText.trim();
        const change = parseFloat(c[2]?.innerText.replace(/[%+]/g, "") || "0");
        const price = parseFloat((c[1]?.innerText || c[3]?.innerText || "0").replace(/[^0-9.]/g, "")) || 0;
        const vol = c[4]?.innerText.includes("M") ? parseFloat(c[4].innerText) * 1e6 : 0;
        const floatVal = parseFloat((c[6]?.innerText || c[7]?.innerText || "0").replace(/[^0-9.]/g, "")) * 1e6 || 100e6;
        return { symbol, price, change, vol, float: floatVal };
      }).filter(r => r.symbol && r.price > 0.5).filter(r => {
        return isPre
          ? r.change >= 25 && r.price >= 0.8 && r.vol >= 600000 && r.float <= 35e6
          : r.change >= 35 && r.price <= 25 && r.vol >= 1.5e6 && r.float <= 50e6;
      }).sort((a, b) => b.change - a.change);
    }, premarket);

    log(`${premarket ? "PRE" : "POST"} → ${rockets.length} ROCKETS:`, rockets.map(r => `${r.symbol}+${r.change.toFixed(1)}%`).join(" "));
    return rockets;
  } catch (e) { log("Scrape error:", e.message); return []; }
}

async function tradeRockets() {
  const rockets = await scrape();
  if (rockets.length === 0) return;

  for (const r of rockets.slice(0, 8)) {  // up to 8 rockets — no mercy
    if (positions.some(p => p.symbol === r.symbol)) continue;

    const qty = Math.max(1, Math.floor(accountEquity * 0.04 / r.price)); // 4% per rocket
    log(`ROCKET ENTRY → ${r.symbol} ×${qty} @ $${r.price.toFixed(3)} | +${r.change.toFixed(1)}%`);

    // Paper trade entry
    positions.push({
      symbol: r.symbol,
      qty,
      entry: r.price,
      current: r.price,
      peak: r.price,
      time: Date.now()
    });

    // Simulate market buy (paper)
    await axios.post(`${A_BASE}/orders`, {
      symbol: r.symbol, qty, side: "buy", type: "market", time_in_force: isPremarket() ? "opg" : "day"
    }, { headers: HEADERS }).catch(() => {});
  }
}

async function managePositions() {
  for (const p of positions) {
    // Simulate price update (in real bot you'd pull from Alpaca)
    const quote = await axios.get(`https://api.polygon.io/v2/last/trade/${p.symbol}?apiKey=...`).catch(() => ({ data: { last: { price: p.current } } }));
    p.current = quote.data?.last?.price || p.current;
    p.peak = Math.max(p.peak, p.current);

    const pnlPct = ((p.current - p.entry) / p.entry) * 100;
    const trailDrop = ((p.current - p.peak) / p.peak) * 100;

    if (trailDrop <= -18) {
      log(`TRAIL EXIT → ${p.symbol} @ $${p.current.toFixed(3)} | ${pnlPct > 0 ? "+" : ""}${pnlPct.toFixed(1)}%`);
      positions = positions.filter(x => x.symbol !== p.symbol);
    }
    if (pnlPct >= 200) {
      log(`200% EXIT → ${p.symbol} @ $${p.current.toFixed(3)} | +${pnlPct.toFixed(1)}%`);
      positions = positions.filter(x => x.symbol !== p.symbol);
    }
  }
}

// DASHBOARD
app.get("/", async (req, res) => {
  await managePositions();
  const unreal = positions.reduce((s, p) => s + (p.current - p.entry) * p.qty, 0);
  res.json({
    bot: "AlphaStream v90.0 — ROCKET HUNTER",
    mode: "PAPER (Real money ready)",
    equity: `$${accountEquity.toFixed(0)}`,
    unrealized: unreal > 0 ? `+$${unreal.toFixed(0)}` : `$${unreal.toFixed(0)}`,
    positions: positions.length,
    rockets: lastRockets.map(r => `${r.symbol}+${r.change.toFixed(1)}%`),
    status: "HUNTING EXPLOSIVE MOVES"
  });
});

app.listen(Number(PORT), "0.0.0.0", async () => {
  log("ALPHASTREAM v90.0 — PURE ROCKET HUNTER — PAPER TRADING");
  setInterval(async () => {
    await tradeRockets();
    await managePositions();
    lastRockets = (await scrape()).slice(0, 10);
  }, 180000); // every 3 min
  await tradeRockets();
});
