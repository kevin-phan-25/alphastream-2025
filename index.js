// index.js — AlphaStream v24 — FINAL ELITE VERSION 2025
import express from "express";
import axios from "axios";
import { ADX, ATR } from "technicalindicators";
import { detectMarketRegime } from "./utils/regime.js";
import { extractFeatures } from "./utils/utils.features.js";
import { calculatePositionSize } from "./utils/risk.js";
import { std, safeDiv } from "./utils/math.js";

const app = express();
app.use(express.json());

// === ENVIRONMENT ===
const {
  ALPACA_KEY,
  ALPACA_SECRET,
  MASSIVE_KEY,
  PREDICTOR_URL,           // LightGBM model endpoint
  LOG_WEBHOOK_URL,
  LOG_WEBHOOK_SECRET = '',
  FORWARD_SECRET = '',
  MAX_POS = "3",
  SCAN_INTERVAL_MS = "48000",
} = process.env;

if (!ALPACA_KEY || !MASSIVE_KEY || !PREDICTOR_URL) {
  console.error("Missing required env vars!");
  process.exit(1);
}

const A_BASE = "https://paper-api.alpaca.markets/v2";
const M_BASE = "https://api.massive.com";
const headers = { "APCA-API-KEY-ID": ALPACA_KEY, "APCA-API-SECRET-KEY": ALPACA_SECRET };

let positions = {}; // symbol -> state

// === LOGGING ===
async function log(event, symbol = "", note = "", data = {}) {
  if (!LOG_WEBHOOK_URL) return console.log(`[${event}] ${symbol} | ${note}`, data);
  try {
    await axios.post(LOG_WEBHOOK_URL, {
      secret: LOG_WEBHOOK_SECRET,
      event, symbol, note, data
    }, { timeout: 4000 });
  } catch (e) {
    console.error("LOG FAILED:", e.message);
  }
}

// === DATA HELPERS ===
async function safeGet(url, opts = {}) {
  for (let i = 0; i < 4; i++) {
    try {
      const res = await axios.get(url, { ...opts, timeout: 8000 });
      return res.data;
    } catch (e) {
      if (i === 3) throw e;
      await new Promise(r => setTimeout(r, 600 * (i + 1)));
    }
  }
}

export async function getBars(sym, days = 5) {
  const to = new Date().toISOString().split('T')[0];
  const from = new Date(Date.now() - days * 86_400_000).toISOString().split('T')[0];
  const url = `${M_BASE}/v2/aggs/ticker/${sym}/range/1/minute/${from}/${to}?adjusted=true&limit=5000&apiKey=${MASSIVE_KEY}`;
  try {
    const data = await safeGet(url);
    return data?.results || [];
  } catch (e) {
    console.error(`Bars failed for ${sym}`, e.message);
    return [];
  }
}

async function getEquity() {
  const acc = await safeGet(`${A_BASE}/account`, { headers });
  return parseFloat(acc.equity || acc.cash || 25000);
}

async function getDailyPnL() {
  try {
    const hist = await safeGet(`${A_BASE}/account/portfolio/history?period=1D&timeframe=15Min`, { headers });
    if (hist?.equity?.length > 1) {
      return hist.equity[hist.equity.length - 1] - hist.equity[0];
    }
  } catch (e) { }
  return 0;
}

// === VWAP ===
function calculateVWAP(bars) {
  let tpv = 0, vol = 0;
  for (const b of bars) {
    const typ = (b.h + b.l + b.c) / 3;
    tpv += typ * (b.v || 0);
    vol += (b.v || 0);
  }
  return vol > 0 ? tpv / vol : null;
}

// === ML PREDICTION ===
async function getMLScore(features) {
  try {
    const r = await axios.post(`${PREDICTOR_URL}/predict`, { features }, { timeout: 2900 });
    return Math.max(0.5, r.data.probability || 0.65);
  } catch (e) {
    console.error("ML predictor down → fallback 0.68");
    return 0.68;
  }
}

// === SCANNER: Elite Gappers ===
async function getEliteGappers() {
  const url = `${M_BASE}/v3/reference/tickers?market=stocks&active=true&limit=2000&apiKey=${MASSIVE_KEY}`;
  const data = await safeGet(url);
  const candidates = [];

  for (const t of (data?.results || [])) {
    if (t.type !== 'CS' || !t.ticker || t.market_cap > 1_000_000_000) continue;
    try {
      const snap = awaitILabel safeGet(`${M_BASE}/v2/snapshot/locale/us/markets/stocks/tickers?tickers=${t.ticker}&apiKey=${MASSIVE_KEY}`);
      const s = snap?.tickers?.[0];
      if (!s) continue;

      const price = s.lastTrade?.p || s.day?.c || 0;
      const prev = s.prevDay?.c || price * 0.9;
      if (price < 2.9 || price > 28) continue;

      const gap = (price - prev) / prev;
      if (gap < 0.18 || gap > 1.2) continue;

      const vol = s.day?.v || 0;
      if (vol < 1_300_000) continue;

      const rvol = vol / (prev * 150_000);
      if (rvol < 5.8) continue;

      candidates.push({
        sym: t.ticker,
        price,
        gap,
        rvol,
        float: t.float_shares_outstanding || 18_000_000,
        shortInterest: t.short_interest || 0,
        marketCap: t.market_cap || 500_000_000,
        sector: t.sector || "Other"
      });
    } catch (e) { }
  }
  return candidates.sort((a, b) => b.rvol - a.rvol).slice(0, 14);
}

// === CANDIDATE ANALYSIS ===
async function analyzeCandidate(t) {
  const bars = await getBars(t.sym, 5);
  if (!bars || bars.length < 120) return null;

  const last = bars[bars.length - 1];
  const prevClose = bars.find(b => b.t.includes("20:00"))?.c || bars[0]?.c || last.c * 0.88;
  const vwapPrice = calculateVWAP(bars);
  if (!vwapPrice || last.c <= vwapPrice * 1.006) return null;

  const spyBars = await getBars("SPY", 1);
  const spyOpen = spyBars.find(b => b.t.includes("09:30"))?.o || 500;
  const spyNow = last.c || spyOpen;
  const spyReturn = (spyNow / spyOpen) - 1;

  const features = extractFeatures({
    t,
    bars,
    last,
    vwapPrice,
    spyReturn,
    prevClose
  });

  const mlScore = await getMLScore(features);
  if (mlScore < 0.748) return null;

  const hod = Math.max(...bars.slice(-50).map(b => b.h));
  if (last.c < hod * 0.993) return null;

  const regime = await detectMarketRegime();
  if (!["BULL_TREND", "WEAK_BULL"].includes(regime)) return null;

  const atr14 = ATR.calculate({
    high: bars.map(b => b.h),
    low: bars.map(b => b.l),
    close: bars.map(b => b.c),
    period: 14
  }).pop() || last.c * 0.035;

  const equity = await getEquity();
  const qty = calculatePositionSize({
    equity,
    price: last.c,
    atr: atr14,
    mlScore,
    regime
  });

  if (qty < 1) return null;

  return {
    symbol: t.sym,
    price: last.c,
    qty,
    score: mlScore,
    gap: (last.c - prevClose) / prevClose,
    rvol: t.rvol,
    regime
  };
}

// === ENTRY ===
async function enter(sig) {
  const payload = {
    symbol: sig.symbol,
    qty: sig.qty,
    side: "buy",
    type: "market",
    time_in_force: "day",
    order_class: "bracket",
    take_profit: { limit_price: +(sig.price * 1.13).toFixed(2) },
    stop_loss: { stop_price: +(sig.price * 0.952).toFixed(2) }
  };

  try {
    const r = await axios.post(`${A_BASE}/orders`, payload, { headers });
    positions[sig.symbol] = {
      entry: sig.price,
      qty: sig.qty,
      trailPrice: sig.price * 0.928,
      partialDone: false
    };
    await log("ENTRY", sig.symbol, `BUY ${sig.qty}@${sig.price.toFixed(2)} ML:${(sig.score*100).toFixed(1)}%`, {
      gap: sig.gap.toFixed(2),
      rvol: sig.rvol.toFixed(1),
      regime: sig.regime
    });
    return r.data;
  } catch (e) {
    await log("ORDER_FAIL", sig.symbol, e.response?.data?.message || e.message);
  }
}

// === POSITION MANAGEMENT ===
async function managePositions() {
  try {
    const open = await safeGet(`${A_BASE}/positions`, { headers });
    const equity = await getEquity();
    const dailyPnL = await getDailyPnL();

    // CIRCUIT BREAKER
    if (dailyPnL < -equity * 0.048) {
      await log("CIRCUIT_BREAKER", "SYSTEM", `Daily loss >4.8% → shutting down all positions`);
      for (const p of open) {
        await axios.delete(`${A_BASE}/positions/${p.symbol}`, { headers }).catch(() => {});
      }
      process.exit(0);
    }

    for (const pos of open) {
      const sym = pos.symbol;
      const cur = parseFloat(pos.current_price);
      const entry = parseFloat(pos.avg_entry_price);
      const qty = parseFloat(pos.qty);

      if (!positions[sym]) positions[sym] = { entry, qty, trailPrice: entry * 0.928, partialDone: false };

      // Partial +5.5%
      if (cur >= entry * 1.055 && !positions[sym].partialDone) {
        await axios.post(`${A_BASE}/orders`, {
          symbol: sym,
          qty: Math.floor(qty * 0.5),
          side: "sell",
          type: "market",
          time_in_force: "day"
        }, { headers });
        positions[sym].partialDone = true;
        await log("PARTIAL", sym, `+5.5% locked on ${Math.floor(qty * 0.5)} shares`);
      }

      // Trailing stop update
      const newTrail = cur * 0.93;
      if (newTrail > positions[sym].trailPrice + 0.01) {
        positions[sym].trailPrice = newTrail;
      }

      // Trail exit
      if (cur <= positions[sym].trailPrice) {
        await axios.post(`${A_BASE}/orders`, {
          symbol: sym,
          qty,
          side: "sell",
          type: "market",
          time_in_force: "day"
        }, { headers });
        await log("EXIT_TRAIL", sym, `Trail hit @ ${cur.toFixed(2)}`);
        delete positions[sym];
      }
    }
  } catch (e) {
    console.error("managePositions error:", e.message);
  }
}

// === MAIN SCAN LOOP ===
let scanning = false;
async function scanAndTrade() {
  if (scanning) return;
  scanning = true;

  try {
    const hour = new Date().getUTCHours();
    if (hour < 13 || hour >= 20) {
      scanning = false;
      return;
    }

    await managePositions();

    if (Object.keys(positions).length >= parseInt(MAX_POS)) {
      scanning = false;
      return;
    }

    const gappers = await getEliteGappers();
    for (const t of gappers) {
      if (Object.keys(positions).length >= parseInt(MAX_POS)) break;
      const signal = await analyzeCandidate(t);
      if (signal) await enter(signal);
    }
  } catch (e) {
    await log("SCAN_CRASH", "SYSTEM", e.stack || e.message);
  } finally {
    scanning = false;
  }
}

// === HTTP ENDPOINTS ===
app.get("/", (req, res) => {
  res.json({
    bot: "AlphaStream v24 ELITE",
    time: new Date().toISOString(),
    positions: Object.keys(positions).length,
    max_pos: MAX_POS,
    status: "LIVE"
  });
});

app.post("/", async (req, res) => {
  const secret = req.body?.secret || "";
  if (FORWARD_SECRET && secret !== FORWARD_SECRET) {
    return res.status(403).json({ error: "forbidden" });
  }
  scanAndTrade().catch(() => {});
  res.json({ status: "scan triggered" });
});

// === START ===
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`ALPHASTREAM v24 ELITE LIVE on port ${PORT}`);
  log("BOT_START", "SYSTEM", "AlphaStream v24 ELITE deployed & running");
  scanAndTrade();
  setInterval(scanAndTrade, parseInt(SCAN_INTERVAL_MS));
});
