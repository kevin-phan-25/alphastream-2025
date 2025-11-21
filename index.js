// index.js — AlphaStream v86.0 — DUAL SCANNER + AGGRESSIVE PROFIT-TAKING + TRAILING STOP
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
let positions = [];  // Now stores {symbol, qty, entry, current, peakPrice, sold25: false, sold50: false, sold100: false}
let tradeLog = [];
let lastGainers = [];
let dailyPnL = 0;
let dailyMaxLossHit = false;
let browser = null;

// ---------------- TIME HELPERS ----------------
function etHour() { return parseInt(new Date().toLocaleString("en-US", { timeZone: "America/New_York", hour: "2-digit", hour12: false })); }
function etMinute() { return parseInt(new Date().toLocaleString("en-US", { timeZone: "America/New_York", minute: "2-digit" })); }
function isPremarket() { const h = etHour(); const m = etMinute(); return (h >= 4 && h < 9) || (h === 9 && m < 30); }
function isPostmarket() { return etHour() >= 16; }

// ---------------- LOGGING ----------------
function logTrade(type, symbol, qty, price, reason = "", pnl = 0) {
  const trade = { type, symbol, qty, price: Number(price).toFixed(4), timestamp: new Date().toISOString(), reason, pnl: Number(pnl).toFixed(2) };
  tradeLog.push(trade);
  if (tradeLog.length > 1000) tradeLog.shift();
  dailyPnL += pnl;
  console.log(`[${DRY ? "DRY" : "LIVE"}] ${type} ${symbol} ×${qty} @ $${price} | ${reason} | +$${pnl.toFixed(2)}`);
  if (!dailyMaxLossHit && dailyPnL <= -MAX_LOSS) {
    dailyMaxLossHit = true;
    console.log(`MAX DAILY LOSS HIT: $${dailyPnL.toFixed(2)} — HALTED`);
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
    const alpacaPositions = (pos.data || []).reduce((map, p) => {
      map[p.symbol] = {
        qty: Number(p.qty),
        current: Number(p.current_price),
        unrealized_pl: Number(p.unrealized_pl || 0)
      };
      return map;
    }, {});

    // Update local positions with latest prices
    positions = positions.map(pos => {
      const live = alpacaPositions[pos.symbol] || { current: pos.current, qty: pos.qty };
      const currentPrice = live.current;
      const peakPrice = Math.max(pos.peakPrice || pos.entry, currentPrice);
      return { ...pos, current: currentPrice, peakPrice, qty: live.qty };
    }).filter(p => p.qty > 0);

    console.log(`Alpaca → $${accountEquity.toFixed(2)} | ${positions.length} pos`);
  } catch (e) { console.log("Alpaca sync error:", e.message); }
}

// ---------------- PROFIT-TAKING + TRAILING STOP ----------------
async function checkProfitTargets() {
  if (positions.length === 0) return;

  for (const pos of positions) {
    const { symbol, qty, entry, current, peakPrice = entry } = pos;
    const pnlPct = ((current - entry) / entry) * 100;
    const fromPeak = ((current - peakPrice) / peakPrice) * 100;

    // Trailing stop: if dropped 15% from peak → FULL EXIT
    if (fromPeak <= -15 && pos.qty > 0) {
      console.log(`${symbol} TRAILING STOP HIT (-15% from peak)`);
      await exitPosition(symbol, pos.qty, current, "TRAILING STOP -15%");
      continue;
    }

    // +100% → FULL EXIT
    if (pnlPct >= 100 && !pos.sold100) {
      await exitPosition(symbol, pos.qty, current, "+100% FULL EXIT");
      pos.sold100 = true;
      continue;
    }

    // +50% → sell 25% (75% total sold)
    if (pnlPct >= 50 && !pos.sold50) {
      const sellQty = Math.floor(qty * 0.25);
      if (sellQty > 0) {
        await exitPosition(symbol, sellQty, current, "+50% TAKE 25%");
        pos.sold50 = true;
        pos.qty -= sellQty;
      }
    }

    // +25% → sell 50%
    if (pnlPct >= 25 && !pos.sold25) {
      const sellQty = Math.floor(qty * 0.5);
      if (sellQty > 0) {
        await exitPosition(symbol, sellQty, current, "+25% TAKE 50%");
        pos.sold25 = true;
        pos.qty -= sellQty;
      }
    }
  }
}

async function exitPosition(symbol, qty, price, reason) {
  const pnl = (price - positions.find(p => p.symbol === symbol)?.entry || price) * qty;
  logTrade("EXIT", symbol, qty, price, reason, pnl);

  if (!DRY && ALPACA_KEY) {
    try {
      await axios.post(`${A_BASE}/orders`, {
        symbol, qty, side: "sell", type: "market", time_in_force: "day"
      }, { headers: HEADERS });
    } catch (e) { console.log(`Exit failed ${symbol}:`, e.message); }
  }

  // Update local position
  const idx = positions.findIndex(p => p.symbol === symbol);
  if (idx !== -1) {
    if (positions[idx].qty <= qty) {
      positions.splice(idx, 1);
    } else {
      positions[idx].qty -= qty;
    }
  }
}

// ---------------- EOD FLATTEN @ 3:50 PM ----------------
async function eodFlatten() {
  const h = etHour();
  const m = etMinute();
  if (h === 15 && m >= 50 && m < 56 && positions.length > 0) {
    console.log("3:50 PM ET — EOD FLATTEN ALL");
    for (const p of positions) {
      await exitPosition(p.symbol, p.qty, p.current, "EOD FLATTEN");
    }
  }
}

// ---------------- SCANNER & ENTRY ----------------
async function scanAndTrade() {
  await updateEquityAndPositions();
  await eodFlatten();
  await checkProfitTargets();  // ← NEW: PROFIT-TAKING
  if (dailyMaxLossHit || positions.length >= 5) return;

  let rockets = [];
  if (isPremarket()) {
    rockets = await scrapePremarket();  // your exact premarket
  } else if (isPostmarket() || etHour() >= 9) {
    rockets = await scrapePostmarket(); // your exact postmarket
  }

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
      symbol: r.symbol,
      qty,
      entry: r.price,
      current: r.price,
      peakPrice: r.price,
      sold25: false,
      sold50: false,
      sold100: false
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
    bot: "AlphaStream v86.0 — PROFIT-TAKING + TRAILING STOP",
    mode: DRY ? "PAPER" : "LIVE",
    scanner: isPremarket() ? "PRE-MARKET" : "POST-MARKET / REGULAR",
    equity: `$${accountEquity.toFixed(2)}`,
    dailyPnL: `$${unrealized.toFixed(2)}`,
    positions_count: positions.length,
    positions: positions.map(p => ({
      symbol: p.symbol,
      qty: p.qty,
      entry: p.entry.toFixed(4),
      current: p.current.toFixed(4),
      pnlPct: (((p.current - p.entry) / p.entry) * 100).toFixed(2) + "%",
      peakDrop: p.peakPrice ? (((p.current - p.peakPrice) / p.peakPrice) * 100).toFixed(1) + "%" : "0%"
    })),
    lastGainers,
    profitRules: "25%→50% | 50%→75% | 100%→100% | Trail - ),

    tradeLog: tradeLog.slice(-30),
    nextEOD: "3:50 PM ET"
  });
});

app.post("/scan", async (req, res) => { await scanAndTrade(); res.json({ ok: true }); });
app.get("/healthz", (_, res) => res.send("OK"));

// ---------------- START ----------------
app.listen(Number(PORT), "0.0.0.0", async () => {
  console.log(`\nALPHASTREAM v86.0 LIVE — PROFIT-TAKING + TRAILING STOP ACTIVATED`);
  console.log(`+25% → 50% out | +50% → 75% out | +100% → FULL EXIT | -15% from peak → STOP`);
  await scanAndTrade();
  setInterval(scanAndTrade, 180000); // 3 min
});
