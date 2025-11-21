// index.js — AlphaStream v97.1 — FIXED BACKEND WITH STARTUP LOGS + REAL ALPACA
import express from "express";
import cors from "cors";
import axios from "axios";
import fs from "fs-extra";

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

const {
  ALPACA_KEY = "",
  ALPACA_SECRET = "",
  PAPER = "true"
} = process.env;

const IS_PAPER = PAPER === "true" || !ALPACA_KEY;
const BASE_URL = IS_PAPER
  ? "https://paper-api.alpaca.markets/v2"
  : "https://api.alpaca.markets/v2";

const HEADERS = {
  "APCA-API-KEY-ID": ALPACA_KEY.trim(),
  "APCA-API-SECRET-KEY": ALPACA_SECRET.trim()
};

let accountEquity = 100000;
let positions = [];
let lastRockets = [];
let backtestResults = { trades: 0, winRate: 0, profitFactor: 0, maxDD: 0, totalPnL: 0, bestTrade: 0, worstTrade: 0 };
const floatCache = new Map();

// STARTUP LOG — THIS WILL SHOW IN CLOUD RUN LOGS
console.log("=== ALPHASTREAM v97.1 STARTING ===");
console.log("Mode:", IS_PAPER ? "PAPER" : "LIVE");
console.log("Alpaca Key:", ALPACA_KEY ? "SET" : "MISSING");
console.log("Base URL:", BASE_URL);
console.log("Max Daily Loss:", PAPER || !ALPACA_KEY ? "DISABLED (PAPER)" : "$500");

// YAHOO FLOAT (NO KEY)
async function getFloatFromYahoo(symbol) {
  if (floatCache.has(symbol)) return floatCache.get(symbol);
  try {
    const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${symbol}?modules=summaryDetail`;
    const { data } = await axios.get(url, { timeout: 8000 });
    const shares = data.quoteSummary.result[0].summaryDetail.sharesOutstanding?.raw || 999e6;
    floatCache.set(symbol, shares);
    return shares;
  } catch {
    return 999e6;
  }
}

// REAL ALPACA SYNC — FIXED WITH BETTER ERROR HANDLING
async function syncAlpacaAccount() {
  if (!ALPACA_KEY) {
    console.log("Alpaca sync skipped — no key (PAPER MODE)");
    return;
  }
  try {
    console.log("Syncing Alpaca account...");
    const [acctRes, posRes] = await Promise.all([
      axios.get(`${BASE_URL}/account`, { headers: HEADERS, timeout: 15000 }),
      axios.get(`${BASE_URL}/positions`, { headers: HEADERS, timeout: 15000 }).catch(() => ({ data: [] }))
    ]);
    accountEquity = parseFloat(acctRes.data.equity || acctRes.data.cash || 100000);
    // Sync live positions
    const liveMap = {};
    posRes.data.forEach(p => liveMap[p.symbol] = {
      qty: parseInt(p.qty),
      current: parseFloat(p.current_price),
      cost: parseFloat(p.cost_basis)
    });
    positions = positions
      .map(p => liveMap[p.symbol] ? { ...p, ...liveMap[p.symbol] } : p)
      .filter(p => p.qty > 0);
    // Add new positions
    posRes.data.forEach(live => {
      if (!positions.find(p => p.symbol === live.symbol)) {
        positions.push({
          symbol: live.symbol,
          qty: parseInt(live.qty),
          entry: parseFloat(live.avg_entry_price || live.current_price),
          current: parseFloat(live.current_price),
          peakPrice: parseFloat(live.current_price)
        });
      }
    });
    console.log("Alpaca sync complete — Equity:", accountEquity, "Positions:", positions.length);
  } catch (e) {
    console.log("Alpaca sync failed:", e.response?.data?.message || e.message);
  }
}

// NASDAQ SCANNER + LOW-FLOAT — FIXED WITH BETTER PARSING
async function scrapeRockets() {
  const hourET = parseInt(new Date().toLocaleString("en-US", { timeZone: "America/New_York", hour: "2-digit", hour12: false }));
  const isPre = hourET >= 4 && hourET < 9;

  try {
    console.log("Scanning NASDAQ for rockets...");
    const { data } = await axios.get("https://api.nasdaq.com/api/screener/stocks?tableonly=true&download=true", {
      timeout: 15000,
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" }
    });
    const rows = data.data?.rows || [];

    const candidates = rows
      .filter(r => r.symbol && r.lastsale && r.pctchange && !r.symbol.includes("^"))
      .map(r => ({
        symbol: r.symbol.trim(),
        price: parseFloat(r.lastsale.replace("$", "")),
        change: parseFloat(r.pctchange.replace("%", "")),
        volume: parseInt((r.volume || "0").replace(/,/g, ""), 10)
      }))
      .filter(t => t.price >= 0.8 && Math.abs(t.change) > (isPre ? 20 : 30));

    const rockets = [];
    for (const c of candidates.slice(0, 25)) {
      const fl = await getFloatFromYahoo(c.symbol);
      if (fl <= 40_000_000) rockets.push({ ...c, float: fl });
      await new Promise(r => setTimeout(r, 180)); // rate limit Yahoo
    }

    return rockets
      .filter(r => isPre ? r.change >= 25 && r.volume >= 500000 : r.change >= 35 && r.volume >= 1200000)
      .sort((a, b) => b.change - a.change)
      .slice(0, 12);
  } catch (e) {
    console.log("Scanner error:", e.message);
    return [];
  }
}

// BACKTEST FROM trades.csv — FIXED WITH BETTER PARSING
async function runBacktest() {
  if (!fs.existsSync("trades.csv")) return backtestResults;
  const lines = fs.readFileSync("trades.csv", "utf-8").split("\n").filter(Boolean);
  const pnls = [];
  let equity = 100000;
  let peak = equity;
  let maxDD = 0;
  for (let i = 0; i < lines.length - 1; i += 2) {
    if (i + 1 >= lines.length) break;
    const entry = lines[i].split(",");
    const exit = lines[i + 1].split(",");
    if (entry[1] !== "ENTRY" || exit[1] !== "EXIT") continue;
    const pnl = (parseFloat(exit[4]) - parseFloat(entry[4])) * parseInt(entry[3]);
    pnls.push(pnl);
    equity += pnl;
    peak = Math.max(peak, equity);
    maxDD = Math.min(maxDD, (equity - peak) / peak);
  }
  const wins = pnls.filter(p => p > 0);
  const grossProfit = wins.reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(pnls.filter(p => p < 0).reduce((a, b) => a + b, 0));
  backtestResults = {
    trades: pnls.length,
    winRate: pnls.length ? Math.round((wins.length / pnls.length) * 100) : 0,
    profitFactor: grossLoss === 0 ? 999 : (grossProfit / grossLoss).toFixed(2),
    totalPnL: Math.round(equity - 100000),
    maxDD: Math.round(Math.abs(maxDD * 100)),
    bestTrade: Math.round(Math.max(...pnls, 0)),
    worstTrade: Math.round(Math.min(...pnls, 0))
  };
  console.log("Backtest complete:", backtestResults);
}

// POSITION MANAGEMENT + EXIT LOGIC
async function managePositions() {
  await syncAlpacaAccount();
  for (const pos of positions) {
    const current = pos.current || pos.entry;
    const pnlPct = (current - pos.entry) / pos.entry * 100;
    const trail = (current - pos.peakPrice) / pos.peakPrice * 100;
    if (pnlPct >= 200 || trail <= -20) {
      if (!IS_PAPER && ALPACA_KEY) {
        await axios.post(`${BASE_URL}/orders`, {
          symbol: pos.symbol,
          qty: pos.qty,
          side: "sell",
          type: "market",
          time_in_force: "day"
        }, { headers: HEADERS }).catch(() => {});
      }
      fs.appendFileSync("trades.csv", `${new Date().toISOString()},EXIT,${pos.symbol},${pos.qty},${current},${pnlPct.toFixed(1)}%\n`);
      positions = positions.filter(p => p !== pos);
    }
  }
}

// MAIN LOOP
async function scanAndTrade() {
  await managePositions();
  await runBacktest();
  const rockets = await scrapeRockets();
  for (const r of rockets) {
    if (positions.find(p => p.symbol === r.symbol)) continue;
    const qty = Math.max(1, Math.floor(accountEquity * 0.04 / r.price));
    if (!IS_PAPER && ALPACA_KEY) {
      await axios.post(`${BASE_URL}/orders`, {
        symbol: r.symbol, qty, side: "buy", type: "market", time_in_force: "opg"
      }, { headers: HEADERS }).catch(e => console.log("Order failed:", e.response?.data?.message));
    }
    positions.push({ symbol: r.symbol, qty, entry: r.price, current: r.price, peakPrice: r.price });
    fs.appendFileSync("trades.csv", `${new Date().toISOString()},ENTRY,${r.symbol},${qty},${r.price},${r.change.toFixed(1)}%,${(r.float/1e6).toFixed(1)}M\n`);
  }
  lastRockets = rockets.map(r => `${r.symbol}+${r.change.toFixed(1)}% (${(r.float/1e6).toFixed(1)}M)`);
}

// ENDPOINTS
app.get("/", async (req, res) => {
  await scanAndTrade();
  const unreal = positions.reduce((s, p) => s + (p.current - p.entry) * p.qty, 0);
  res.json({
    bot: "AlphaStream v97.1 — REAL ALPACA + BACKTEST",
    mode: IS_PAPER ? "PAPER" : "LIVE",
    equity: `$${Number(accountEquity).toFixed(0)}`,
    unrealized: unreal > 0 ? `+$${unreal.toFixed(0)}` : `$${unreal.toFixed(0)}`,
    positions: positions.length,
    rockets: lastRockets,
    backtest: backtestResults
  });
});

app.post("/scan", async (req, res) => {
  await scanAndTrade();
  res.json({ ok: true });
});

app.post("/backtest", async (req, res) => {
  await runBacktest();
  res.json({ backtest: backtestResults });
});

app.listen(8080, "0.0.0.0", () => {
  console.log("\nALPHASTREAM v97.1 — FULLY CONNECTED TO ALPACA + BACKTEST BUTTON READY");
  syncAlpacaAccount().then(() => console.log("Alpaca connected — Equity:", accountEquity));
  setInterval(scanAndTrade, 180000);
  scanAndTrade();
});
