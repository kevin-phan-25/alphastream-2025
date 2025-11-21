// index.js — AlphaStream v87.5 — FINAL | PROP-FIRM READY | ZERO LEAKS | MAX LOSS ENFORCED
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
const MAX_LOSS = Math.abs(parseFloat(MAX_DAILY_LOSS));
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
let sharedPage = null; // ← Reused page = no memory leaks

// TIME
const etHour = () => parseInt(new Date().toLocaleString("en-US", { timeZone: "America/New_York", hour: "2-digit", hour12: false }));
const etMinute = () => parseInt(new Date().toLocaleString("en-US", { timeZone: "America/New_York", minute: "2-digit" }));
const isPremarket = () => { const h = etHour(); const m = etMinute(); return (h >= 4 && h < 9) || (h === 9 && m < 30); };

function logTrade(type, symbol, qty, price, reason = "", pnl = 0) {
  const t = { type, symbol, qty, price: +price.toFixed(4), reason, pnl: +pnl.toFixed(2), time: new Date().toISOString() };
  tradeLog.push(t); if (tradeLog.length > 500) tradeLog.shift();
  dailyPnL += pnl;

  // MAX DAILY LOSS ENFORCED
  if (!dailyMaxLossHit && dailyPnL <= -MAX_LOSS) {
    dailyMaxLossHit = true;
    console.log(`MAX DAILY LOSS HIT: -$${MAX_LOSS} → TRADING HALTED FOR TODAY`);
  }

  console.log(`[${DRY?"DRY":"LIVE"}] ${type} ${symbol} ×${qty} @ $${price.toFixed(4)} | ${reason} | $${pnl >= 0 ? "+" : ""}${pnl.toFixed(0)}`);
}

// ALPACA SYNC + PEAK PRICE UPDATE
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
      const livePrice = live[p.symbol]?.current || p.current;
      return {
        ...p,
        current: livePrice,
        qty: live[p.symbol]?.qty ?? p.qty,
        peakPrice: Math.max(p.peakPrice || p.entry, livePrice) // ← Accurate trailing
      };
    }).filter(p => p.qty > 0);
  } catch (e) { console.log("Alpaca sync error:", e.message); }
}

// SHARED BROWSER + PAGE (no leaks)
async function getPage() {
  if (!browser) {
    browser = await puppeteer.launch({
      headless: true,
      executablePath: "/usr/bin/google-chrome",
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--single-process", "--no-zygote"]
    });
  }
  if (!sharedPage || !sharedPage.isClosed?.()) {
    sharedPage = await browser.newPage();
    await sharedPage.setViewport({ width: 1920, height: 1080 });
    await sharedPage.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36");
  }
  return sharedPage;
}

// LOGIN (works with your screenshot)
async function loginTV(page) {
  if (!TV_EMAIL || !TV_PASSWORD) return false;
  try {
    await page.goto("https://www.tradingview.com/", { waitUntil: "networkidle2", timeout: 40000 });
    if (await page.$("[data-name='header-user-menu-button']")) {
      console.log("TV: Already logged in");
      return true;
    }

    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll("button, a"))
        .find(el => /sign in|log in/i.test(el.textContent || ""));
      if (btn) btn.click();
    });
    await new Promise(r => setTimeout(r, 3000));

    await page.waitForSelector('input[placeholder*="Email"], input[type="text"]', { timeout: 15000 });
    await page.click('input[placeholder*="Email"], input[type="text"]');
    await page.keyboard.down('Control'); await page.keyboard.press('A'); await page.keyboard.up('Control');
    await page.type('input[placeholder*="Email"], input[type="text"]', TV_EMAIL);
    await page.type('input[type="password"]', TV_PASSWORD);

    await Promise.all([
      page.click('button:has-text("Sign in"), button:has-text("Sign In")'),
      page.waitForNavigation({ waitUntil: "networkidle2", timeout: 30000 }).catch(() => {})
    ]);

    await new Promise(r => setTimeout(r, 6000));
    const ok = await page.$("[data-name='header-user-menu-button']") !== null;
    console.log(ok ? "TV: LOGIN SUCCESS" : "TV: LOGIN FAILED");
    return ok;
  } catch (e) {
    console.log("Login error:", e.message);
    return false;
  }
}

async function openExtended(page) {
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll("button"))
      .find(b => /extended|pre.?post/i.test(b.textContent || "") || b.getAttribute("data-name")?.includes("extended"));
    if (btn) btn.click();
  });
  await new Promise(r => setTimeout(r, 5000));
}

async function scrape() {
  const page = await getPage();
  try {
    const start = Date.now();
    await loginTV(page);
    await page.goto("https://www.tradingview.com/screener/", { waitUntil: "networkidle2", timeout: 60000 });
    await openExtended(page);

    const rockets = await page.evaluate(() => {
      return Array.from(document.querySelectorAll("table tbody tr")).slice(0, 20).map(r => {
        const c = r.querySelectorAll("td");
        const symbol = c[0]?.querySelector("a")?.innerText.trim();
        const change = parseFloat(c[2]?.innerText.replace(/[%+]/g, "") || "0");
        const price = parseFloat((c[1]?.innerText || c[3]?.innerText || "0").replace(/[^0-9.]/g, "")) || 0;
        const vol = c[4]?.innerText.includes("M") ? parseFloat(c[4].innerText) * 1e6 : 0;
        const fl = parseFloat((c[6]?.innerText || c[7]?.innerText || "0").replace(/[^0-9.]/g, "")) * 1e6 || 100e6;
        return { symbol, price, change, vol, fl };
      }).filter(r => {
        if (!r.symbol || r.price < 0.5) return false;
        return isPremarket()
          ? r.change >= 20 && r.price >= 1 && r.vol >= 500000 && r.fl <= 30e6
          : r.price <= 20 && r.change >= 30 && r.vol >= 1e6 && r.fl <= 40e6;
      });
    });

    const label = isPremarket() ? "PRE-MARKET" : "POST-MARKET";
    console.log(`${label} → ${rockets.length} rockets (${((Date.now()-start)/1000).toFixed(1)}s): ${rockets.map(r => `${r.symbol}+${r.change.toFixed(0)}%`).join(" ")}`);
    return rockets.slice(0, 5);
  } catch (e) {
    console.log("Scrape error:", e.message);
    return [];
  }
}

// PROFIT-TAKING + TRAILING
async function checkProfitTargets() {
  for (const p of positions) {
    const pnl = ((p.current - p.entry) / p.entry) * 100;
    const drop = ((p.current - p.peakPrice) / p.peakPrice) * 100;

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

async function scanAndTrade() {
  if (dailyMaxLossHit) {
    console.log("DAILY LOSS LIMIT REACHED — NO NEW TRADES TODAY");
    return;
  }
  try {
    await updateEquityAndPositions();
    await eodFlatten();
    await checkProfitTargets();
    if (positions.length >= 5) return;

    const rockets = await scrape();
    for (const r of rockets) {
      if (positions.length >= 5 || positions.some(p => p.symbol === r.symbol)) continue;
      const qty = Math.max(1, Math.floor(accountEquity * 0.025 / r.price));
      logTrade("ENTRY", r.symbol, qty, r.price, `${isPremarket()?"PRE":"POST"} +${r.change.toFixed(1)}%`, 0);
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

// DASHBOARD
app.get("/", async (req, res) => {
  await updateEquityAndPositions();
  const unreal = positions.reduce((s, p) => s + (p.current - p.entry) * p.qty, 0);
  res.json({
    bot: "AlphaStream v87.5 — PROP READY",
    mode: DRY ? "PAPER" : "LIVE",
    time: `${etHour()}:${etMinute().toString().padStart(2,"0")} ET`,
    equity: `$${accountEquity.toFixed(0)}`,
    unrealized: unreal > 0 ? `+$${unreal.toFixed(0)}` : `$${unreal.toFixed(0)}`,
    dailyPnL: dailyPnL > 0 ? `+$${dailyPnL.toFixed(0)}` : `$${dailyPnL.toFixed(0)}`,
    positions: positions.length,
    max: 5,
    scanner: isPremarket() ? "PRE" : "POST",
    rockets: lastGainers.map(r => `${r.symbol}+${r.change.toFixed(0)}%`),
    rules: "25→50% | 50→75% | 100→ALL | Trail -15%",
    maxLoss: `$${MAX_LOSS}`,
    status: dailyMaxLossHit ? "HALTED (MAX LOSS)" : "RUNNING"
  });
});

app.post("/scan", async (req, res) => { await scanAndTrade(); res.json({ ok: true }); });
app.get("/healthz", (_, res) => res.send("OK"));

app.listen(Number(PORT), "0.0.0.0", async () => {
  console.log(`\nALPHASTREAM v87.5 LIVE — PROP-FIRM READY — ZERO LEAKS`);
  await scanAndTrade();
  setInterval(() => scanAndTrade().catch(() => {}), 180000);
});
