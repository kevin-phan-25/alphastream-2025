// index.js — AlphaStream v83.7 — TradingView Penny Scanner (Cloud Run Ready)
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
const A_BASE = IS_PAPER
  ? "https://paper-api.alpaca.markets/v2"
  : "https://api.alpaca.markets/v2";

const HEADERS = {
  "APCA-API-KEY-ID": ALPACA_KEY,
  "APCA-API-SECRET-KEY": ALPACA_SECRET,
};

let accountEquity = 100000;
let positions = [];
let tradeLog = [];
let lastGainers = [];
let lastScanTime = 0;
let dailyPnL = 0;
let dailyMaxLossHit = false;
let browser = null;

async function getBrowser() {
  if (browser) return browser;
  browser = await puppeteer.launch({
    headless: true,
    executablePath: "/usr/bin/google-chrome",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-features=IsolateOrigins,site-per-process",
      "--disable-web-security",
      "--single-process",
      "--no-zygote",
      "--disable-extensions",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--disable-backgrounding-occluded-windows",
    ],
    defaultViewport: { width: 1366, height: 768 },
  });
  return browser;
}

function logTrade(type, symbol, qty, price = 0, reason = "", pnl = 0) {
  const trade = {
    type,
    symbol,
    qty: Number(qty),
    price: Number(price).toFixed(2),
    timestamp: new Date().toISOString(),
    reason,
    pnl: Number(pnl).toFixed(2),
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

async function updateEquityAndPositions() {
  if (!ALPACA_KEY) return;

  try {
    const [acctRes, posRes] = await Promise.all([
      axios.get(`${A_BASE}/account`, { headers: HEADERS, timeout: 15000 }),
      axios.get(`${A_BASE}/positions`, { headers: HEADERS, timeout: 15000 }).catch(() => ({ data: [] })),
    ]);

    accountEquity = parseFloat(acctRes.data.equity || accountEquity);
    positions = (posRes.data || []).map(p => ({
      symbol: p.symbol,
      qty: Number(p.qty),
      entry: Number(p.avg_entry_price),
      current: Number(p.current_price),
      unrealized_pl: Number(p.unrealized_pl || 0),
    }));

    console.log(`Alpaca sync → $${accountEquity.toFixed(2)} | ${positions.length} positions`);
  } catch (err) {
    console.log("Alpaca sync failed:", err.message);
  }
}

async function scrapeTradingView() {
  const now = Date.now();
  if (now - lastScanTime < 60000 && lastGainers.length) return lastGainers;

  let page;
  try {
    const br = await getBrowser();
    page = await br.newPage();

    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36");

    // Login if credentials provided
    if (TV_EMAIL && TV_PASSWORD) {
      await page.goto("https://www.tradingview.com/accounts/signin/", { waitUntil: "networkidle2" });
      await page.type('input[name="username"]', TV_EMAIL);
      await page.type('input[name="password"]', TV_PASSWORD);
      await Promise.all([
        page.click('button[type="submit"]'),
        page.waitForNavigation({ waitUntil: "networkidle2" }).catch(() => {}),
      ]);
    }

    await page.goto("https://www.tradingview.com/screener/", { waitUntil: "networkidle2", timeout: 60000 });

    await page.waitForSelector('table tbody tr', { timeout: 30000 });

    const results = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll("table tbody tr"));
      return rows.map(row => {
        const cells = row.querySelectorAll("td");
        if (cells.length < 8) return null;
        const symbol = cells[0].querySelector("a")?.innerText.trim();
        const price = parseFloat(cells[2]?.innerText.replace(/[^0-9.]/g, "") || "0");
        const change = parseFloat(cells[3]?.innerText.replace(/[%+]/g, "") || "0");
        const volumeText = cells[5]?.innerText || "";
        const volume = volumeText.includes("M") ? parseFloat(volumeText) * 1e6 : parseFloat(volumeText.replace(/,/g, "")) || 0;
        return { symbol, price, change, volume };
      }).filter(Boolean);
    });

    const filtered = results
      .filter(g => g.price >= 2 && g.price <= 10 && g.change >= 3 && g.volume >= 500000)
      .filter(g => !positions.some(p => p.symbol === g.symbol))
      .sort((a, b) => b.change - a.change)
      .slice(0, 5);

    lastGainers = filtered;
    lastScanTime = now;
    console.log(`TradingView → ${filtered.length} penny rockets: ${filtered.map(g => `${g.symbol} +${g.change}%`).join(", ")}`);

    await page.close();
    return filtered;
  } catch (err) {
    console.log("Scrape error:", err.message);
    if (page) await page.close().catch(() => {});
    return lastGainers;
  }
}

async function scanAndTrade() {
  if (dailyMaxLossHit) return;
  await updateEquityAndPositions();
  if (positions.length >= 5) return;

  const candidates = await scrapeTradingView();

  for (const stock of candidates) {
    if (positions.length >= 5) break;
    const qty = Math.max(1, Math.floor((accountEquity * 0.02) / stock.price));

    logTrade("ENTRY", stock.symbol, qty, stock.price, "TV Penny Rocket", 0);

    if (!DRY && ALPACA_KEY) {
      try {
        await axios.post(`${A_BASE}/orders`, {
          symbol: stock.symbol,
          qty,
          side: "buy",
          type: "market",
          time_in_force: "day",
        }, { headers: HEADERS });
      } catch (e) {
        console.log(`Order failed:`, e.response?.data || e.message);
      }
    }
    await new Promise(r => setTimeout(r, 3000));
  }
}

app.get("/", async (req, res) => {
  await updateEquityAndPositions();
  const unrealized = positions.reduce((s, p) => s + p.unrealized_pl, 0);
  const exits = tradeLog.filter(t => t.type === "EXIT");
  const winRate = exits.length ? ((exits.filter(t => parseFloat(t.pnl) > 0).length / exits.length) * 100).toFixed(1) + "%" : "N/A";

  res.json({
    bot: "AlphaStream v83.7",
    status: "ONLINE",
    mode: DRY ? "PAPER" : "LIVE",
    equity: `$${accountEquity.toFixed(2)}`,
    dailyPnL: unrealized >= 0 ? `+$${unrealized.toFixed(2)}` : `-$${Math.abs(unrealized.toFixed(2))}`,
    positions_count: positions.length,
    positions,
    tradeLog: tradeLog.slice(-30),
    lastGainers,
    winRate,
  });
});

app.post("/scan", async (req, res) => {
  console.log("FORCE SCAN");
  await scanAndTrade();
  res.json({ ok: true });
});

app.get("/healthz", (_, res) => res.send("OK"));

app.listen(Number(PORT), "0.0.0.0", async () => {
  console.log(`\nALPHASTREAM v83.7 LIVE — TRADINGVIEW PENNY SCANNER`);
  console.log(`Mode: ${DRY ? "PAPER" : "LIVE"} | Equity: $${accountEquity}`);
  await scanAndTrade();
  setInterval(scanAndTrade, 300000);
});
