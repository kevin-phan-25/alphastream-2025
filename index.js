// index.js — AlphaStream v98 ELITE EDITION — FINAL & GOD-TIER
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
const BASE_URL = IS_PAPER ? "https://paper-api.alpaca.markets/v2" : "https://api.alpaca.markets/v2";
const DATA_URL = "https://data.alpaca.markets";
const HEADERS = {
  "APCA-API-KEY-ID": ALPACA_KEY.trim(),
  "APCA-API-SECRET-KEY": ALPACA_SECRET.trim()
};

let accountEquity = 100000;
let positions = [];
let lastRockets = [];
const floatCache = new Map();

// EQUITY CURVE HISTORY — AUTO-TRACKED EVERY SYNC
let equityHistory = [];

// ==================== UTILS ====================
async function getFloatFromYahoo(symbol) {
  if (floatCache.has(symbol)) return floatCache.get(symbol);
  try {
    const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${symbol}?modules=summaryDetail`;
    const { data } = await axios.get(url, { timeout: 8000 });
    const shares = data.quoteSummary.result[0].summaryDetail.sharesOutstanding?.raw || 999e6;
    floatCache.set(symbol, shares);
    return shares;
  } catch { return 999e6; }
}

async function syncAlpacaAccount() {
  if (!ALPACA_KEY) return;
  try {
    const [acct, pos] = await Promise.all([
      axios.get(`${BASE_URL}/account`, { headers: HEADERS, timeout: 10000 }),
      axios.get(`${BASE_URL}/positions`, { headers: HEADERS, timeout: 10000 }).catch(() => ({ data: [] }))
    ]);

    const newEquity = parseFloat(acct.data.equity || acct.data.cash || 100000);
    
    // ONLY PUSH IF EQUITY CHANGED (avoids spam)
    if (Math.abs(newEquity - accountEquity) > 5 || equityHistory.length === 0) {
      accountEquity = newEquity;
      equityHistory.push({
        time: new Date().toISOString(),
        equity: parseFloat(newEquity.toFixed(2))
      });
      // Keep last 1000 points max
      if (equityHistory.length > 1000) equityHistory.shift();
    }

    positions = pos.data
      .filter(p => parseInt(p.qty) > 0)
      .map(p => ({
        symbol: p.symbol,
        qty: parseInt(p.qty),
        entry: parseFloat(p.avg_entry_price),
        current: parseFloat(p.current_price),
        peakPrice: parseFloat(p.current_price)
      }));

  } catch (e) {
    console.log("Alpaca sync error:", e.message);
  }
}

// ==================== 1-MIN BARS ====================
async function fetch1minBars(symbol) {
  if (!ALPACA_KEY) return [];
  try {
    const end = new Date();
    const start = new Date(end.getTime() - 8 * 60 * 60 * 1000);
    const url = `${DATA_URL}/v2/stocks/${symbol}/bars?timeframe=1Min&start=${start.toISOString()}&end=${end.toISOString()}&limit=500`;
    const { data } = await axios.get(url, { headers: HEADERS, timeout: 12000 });
    return data.bars || [];
  } catch { return []; }
}

// ==================== 7 ELITE PATTERNS ====================
function detectELITEPatterns(bars) {
  if (bars.length < 40) return null;
  const recent = bars.slice(-40);
  const c = recent.map(b => b.c);
  const h = recent.map(b => b.h);
  const l = recent.map(b => b.l);
  const v = recent.map(b => b.v);
  const totalVol = v.reduce((a, b) => a + b, 0);
  const vwap = totalVol === 0 ? c[c.length-1] : recent.reduce((s, b) => s + b.c * b.v, 0) / totalVol;
  const last = c[c.length-1];

  if (c[10] < c[20] * 1.4 && c[30] < c[20] * 0.95 &&
      v.slice(-10).reduce((a,b)=>a+b,0) < v.slice(-30,-20).reduce((a,b)=>a+b,0) * 0.6 &&
      last > c[c.length-3]) return "bull_flag";

  const resistance = Math.max(...h.slice(-18,-4));
  if (h.slice(-4).every(hh => hh <= resistance * 1.02) &&
      last > resistance * 1.01 && v[v.length-1] > v[v.length-2] * 2) return "flat_top";

  if (c[15] < last * 1.3 && Math.min(...l.slice(-20)) > c[20] * 0.88 && last > Math.max(...c.slice(-20)) * 0.99)
    return "micro_pullback";

  const openPrice = c.find(p => p > 0) || last;
  if (Math.min(...l) < openPrice * 0.98 && last > openPrice * 1.02) return "red_to_green";

  if (l.slice(-12).some(ll => ll < vwap * 0.99) && last > vwap * 1.005 && v[v.length-1] > v[v.length-2] * 1.5)
    return "vwap_reclaim";

  if (h[h.length-2] < h[h.length-3] && l[l.length-2] > l[l.length-3] && last > h[h.length-3] * 1.005)
    return "inside_bar";

  const a = c[10], b = c[22], cdTarget = b + (b - a);
  if (b > a * 1.4 && c[30] < b * 0.92 && last > cdTarget * 0.98) return "abcd";

  return null;
}

// ==================== SCANNER ====================
async function scrapeRockets() {
  console.log("ELITE v98 — Scanning 7 Warrior Patterns...");
  try {
    const { data } = await axios.get("https://api.nasdaq.com/api/screener/stocks?tableonly=true&download=true", {
      timeout: 15000,
      headers: { "User-Agent": "Mozilla/5.0" }
    });

    const candidates = (data.data?.rows || [])
      .filter(r => r.symbol && !r.symbol.includes("^"))
      .map(r => ({
        symbol: r.symbol.trim(),
        price: parseFloat(r.lastsale.replace("$", "")),
        change: parseFloat(r.pctchange.replace("%", "")),
        volume: parseInt((r.volume || "0").replace(/,/g, ""), 10)
      }))
      .filter(t => t.price >= 0.8 && t.price <= 25 && t.change >= 28 && t.volume >= 800000);

    const rockets = [];
    for (const c of candidates.slice(0, 18)) {
      const fl = await getFloatFromYahoo(c.symbol);
      if (fl > 40_000_000) continue;
      const bars = await fetch1minBars(c.symbol);
      const pattern = detectELITEPatterns(bars);
      if (pattern) {
        rockets.push({ ...c, float: fl, pattern });
        console.log(`ROCKET → ${c.symbol} +${c.change.toFixed(1)}% (${(fl/1e6).toFixed(1)}M float) [${pattern.toUpperCase()}]`);
      }
      await new Promise(r => setTimeout(r, 280));
    }
    return rockets.sort((a,b) => b.change - a.change).slice(0, 10);
  } catch (e) {
    console.log("Scanner error:", e.message);
    return [];
  }
}

// ==================== TRADING LOGIC ====================
async function managePositions() {
  await syncAlpacaAccount();
  for (const pos of positions) {
    const pnl = (pos.current - pos.entry) / pos.entry * 100;
    const trail = (pos.current - pos.peakPrice) / pos.peakPrice * 100;
    if (pnl >= 180 || trail <= -18) {
      if (!IS_PAPER && ALPACA_KEY) {
        await axios.post(`${BASE_URL}/orders`, {
          symbol: pos.symbol, qty: pos.qty, side: "sell", type: "market", time_in_force: "day"
        }, { headers: HEADERS }).catch(() => {});
      }
      fs.appendFileSync("trades.csv", `${new Date().toISOString()},EXIT,${pos.symbol},${pos.qty},${pos.current},${pnl.toFixed(1)}%\n`);
      positions = positions.filter(p => p !== pos);
    } else {
      pos.peakPrice = Math.max(pos.peakPrice, pos.current);
    }
  }
}

async function scanAndTrade() {
  await managePositions();
  const rockets = await scrapeRockets();
  for (const r of rockets) {
    if (positions.find(p => p.symbol === r.symbol)) continue;
    const qty = Math.max(1, Math.floor(accountEquity * 0.05 / r.price));
    if (!IS_PAPER && ALPACA_KEY) {
      await axios.post(`${BASE_URL}/orders`, {
        symbol: r.symbol, qty, side: "buy", type: "market", time_in_force: "opg"
      }, { headers: HEADERS }).catch(() => {});
    }
    positions.push({ symbol: r.symbol, qty, entry: r.price, current: r.price, peakPrice: r.price });
    fs.appendFileSync("trades.csv", `${new Date().toISOString()},ENTRY,${r.symbol},${qty},${r.price},${r.change.toFixed(1)}%,${(r.float/1e6).toFixed(1)}M,${r.pattern}\n`);
  }
  lastRockets = rockets.map(r => `${r.symbol}+${r.change.toFixed(1)}% (${(r.float/1e6).toFixed(1)}M) [${r.pattern.toUpperCase()}]`);
}

// ==================== ENDPOINTS ====================
app.get("/", async (req, res) => {
  await scanAndTrade();
  const unreal = positions.reduce((s, p) => s + (p.current - p.entry) * p.qty, 0);
  res.json({
    bot: "AlphaStream v98 — ELITE EDITION",
    mode: IS_PAPER ? "PAPER" : "LIVE",
    equity: `$${accountEquity.toFixed(0)}`,
    unrealized: unreal > 0 ? `+$${unreal.toFixed(0)}` : `$${unreal.toFixed(0)}`,
    positions: positions.length,
    rockets: lastRockets,
    pattern: "7 ELITE PATTERNS ACTIVE"
  });
});

app.post("/scan", async (req, res) => {
  await scanAndTrade();
  res.json({ ok: true });
});

// FINAL PERFORMANCE ENDPOINT — EQUITY CURVE + STATS
app.get("/performance", async (req, res) => {
  await syncAlpacaAccount(); // ensure latest equity

  if (!fs.existsSync("trades.csv")) {
    return res.json({
      trades: [],
      stats: { trades: 0, wins: 0, losses: 0, winRate: "0.0", avgWin: "+0.0%", avgLoss: "0.0%", netPnL: "0.0" },
      equityCurve: equityHistory.length > 0 ? equityHistory : [{ time: new Date().toISOString(), equity: 100000 }]
    });
  }

  const lines = fs.readFileSync("trades.csv", "utf-8").trim().split("\n").filter(Boolean);
  const trades = [];
  let entry = null;

  for (const line of lines) {
    const cols = line.split(",");
    const type = cols[1];
    const symbol = cols[2];
    const price = parseFloat(cols[4]);
    const pattern = cols[7] || "momentum";

    if (type === "ENTRY") {
      entry = { symbol, entryPrice: price, pattern };
    } else if (type === "EXIT" && entry && entry.symbol === symbol) {
      const pnlPct = ((price - entry.entryPrice) / entry.entryPrice * 100).toFixed(2);
      trades.push({
        symbol,
        pattern: pattern.toUpperCase(),
        pnlPct,
        result: parseFloat(pnlPct) >= 0 ? "WIN" : "LOSS",
        time: new Date(cols[0]).toLocaleString()
      });
      entry = null;
    }
  }

  const wins = trades.filter(t => t.result === "WIN");
  const losses = trades.filter(t => t.result === "LOSS");
  const winRate = trades.length ? (wins.length / trades.length * 100).toFixed(1) : "0.0";
  const avgWin = wins.length ? (wins.reduce((s, t) => s + parseFloat(t.pnlPct), 0) / wins.length).toFixed(1) : "0.0";
  const avgLoss = losses.length ? (losses.reduce((s, t) => s + parseFloat(t.pnlPct), 0) / losses.length).toFixed(1) : "0.0";

  res.json({
    trades: trades.slice(-100),
    stats: {
      trades: trades.length,
      wins: wins.length,
      losses: losses.length,
      winRate,
      avgWin: `+${avgWin}%`,
      avgLoss: `${avgLoss}%`,
      netPnL: (wins.length * parseFloat(avgWin) + losses.length * parseFloat(avgLoss)).toFixed(1)
    },
    equityCurve: equityHistory.length > 0 ? equityHistory : [{ time: new Date().toISOString(), equity: accountEquity }]
  });
});

app.listen(8080, "0.0.0.0", () => {
  console.log("\nALPHASTREAM v98 ELITE — 7 WARRIOR PATTERNS — EQUITY CURVE LIVE");
  syncAlpacaAccount();
  setInterval(scanAndTrade, 180000);
  scanAndTrade();
});
