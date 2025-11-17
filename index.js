// index.js — AlphaStream v23.4 (Production Battle-Tested) - Kevin Phan @Kevin_Phan25
import express from "express";
import axios from "axios";

const app = express();
app.use(express.json());

// ==================== ENV VARS ====================
const A_KEY = process.env.ALPACA_KEY;
const A_SEC = process.env.ALPACA_SECRET;
const MASSIVE_KEY = process.env.MASSIVE_KEY;

const LOG_WEBHOOK_URL = process.env.LOG_WEBHOOK_URL;           // Your GAS doPost URL
const LOG_WEBHOOK_SECRET = process.env.LOG_WEBHOOK_SECRET || '';
const FORWARD_SECRET = process.env.FORWARD_SECRET || '';

const MAX_POS = parseInt(process.env.MAX_POS || "3", 10);      // bumped to 3
const RISK_PCT = parseFloat(process.env.RISK_PCT || "1.8");    // 1.8% risk per trade
const MIN_GAP = parseFloat(process.env.MIN_GAP || "0.18");     // 18%+ only
const MIN_RVOL = parseFloat(process.env.MIN_RVOL || "5.5");    // tighter RVOL

const SCAN_INTERVAL_MS = 20000;

// ==================== STATE ====================
let positions = {};
let barCache = {};
let tradeHistory = [];
let premarketCandidates = [];
let lastScanId = null;                // idempotency
let lastTradeTime = Date.now();       // for health check

// ==================== LOGGER ====================
async function logToGAS(event, symbol = "", note = "", data = {}) {
  if (!LOG_WEBHOOK_URL) {
    console.log(`[LOG] ${event} | ${symbol} | ${note}`, data);
    return;
  }
  try {
    await axios.post(LOG_WEBHOOK_URL, {
      secret: LOG_WEBHOOK_SECRET,
      event,
      symbol,
      note,
      data,
    }, { timeout: 4000 });
  } catch (e) {
    console.error("logToGAS failed:", e.message);
  }
}

// ==================== ALPACA & MASSIVE ====================
const ALPACA_BASE = "https://paper-api.alpaca.markets/v2";
const MASSIVE_BASE = "https://api.massive.com";

const alpacaHeaders = () => ({
  "APCA-API-KEY-ID": A_KEY,
  "APCA-API-SECRET-KEY": A_SEC,
});

async function safeGet(url, opts = {}, retries = 3) {
  for (let i = 0; i <= retries; i++) {
    try {
      return (await axios.get(url, opts)).data;
    } catch (e) {
      if (i === retries) throw e;
      await new Promise(r => setTimeout(r, 400 * (i + 1)));
    }
  }
}

async function safePost(url, payload, headers, retries = 3) {
  for (let i = 0; i <= retries; i++) {
    try {
      return await axios.post(url, payload, { headers });
    } catch (e) {
      if (i === retries) throw e;
      await new Promise(r => setTimeout(r, 400 * (i + 1)));
    }
  }
}

// ==================== ACCOUNT & POSITIONS ====================
async function getEquity() {
  const r = await safeGet(`${ALPACA_BASE}/account`, { headers: alpacaHeaders() });
  return parseFloat(r.equity || 25000);
}

async function getOpenPositions() {
  return await safeGet(`${ALPACA_BASE}/positions`, { headers: alpacaHeaders() });
}

async function syncPositionsFromAlpaca() {
  const open = await getOpenPositions();
  positions = {};
  for (const p of open) {
    const current = parseFloat(p.current_price || p.avg_entry_price);
    positions[p.symbol] = {
      entry: parseFloat(p.avg_entry_price),
      qty: parseFloat(p.qty),
      trailPrice: current * 0.93,      // start tighter
      partialDone: false,
    };
  }
  await logToGAS("POS_SYNC", "SYSTEM", `Synced ${open.length} positions`);
}

// ==================== ML & THRESHOLD ====================
let ML_WEIGHTS = { w: [1.4, 1.1, 0.8, 1.6, 2.5], b: -2.6 };

function mlPredict(features) {
  let z = ML_WEIGHTS.b;
  for (let i = 0; i < Math.min(features.length, ML_WEIGHTS.w.length); i++)
    z += features[i] * ML_WEIGHTS.w[i];
  return 1 / (1 + Math.exp(-z));
}

function getMLThreshold() {
  if (tradeHistory.length < 10) return 0.72;
  const recent = tradeHistory.slice(-15);
  const winRate = recent.filter(t => t.pnl > 0).length / recent.length;
  const avgPnl = recent.reduce((s, t) => s + t.pnl, 0) / recent.length;
  const base = 0.68;
  const boost = winRate > 0.62 ? (winRate - 0.62) * 0.30 : 0;
  const penalty = avgPnl < 0 ? 0.10 : 0;
  return Math.min(0.88, base + boost - penalty);
}

// ==================== INDICATORS ====================
async function getBars(sym, fromDays = 3) {
  const now = Date.now();
  const cached = barCache[sym];
  if (cached && now - cached.lastFetch < 55000) return cached.bars;

  const today = new Date().toISOString().split("T")[0];
  const from = new Date();
  from.setDate(from.getDate() - fromDays);
  const fromStr = from.toISOString().split("T")[0];

  const data = await safeGet(
    `${MASSIVE_BASE}/v2/aggs/ticker/${sym}/range/1/minute/${fromStr}/${today}?adjusted=true&limit=1000&apiKey=${MASSIVE_KEY}`
  );
  const bars = data?.results || [];
  barCache[sym] = { bars, lastFetch: now };
  return bars;
}

function calculateVWAP(bars) {
  if (!bars.length) return null;
  let vp = 0, v = 0;
  for (const b of bars) {
    const t = (b.h + b.l + b.c) / 3;
    vp += t * (b.v || 0);
    v += (b.v || 0);
  }
  return v > 0 ? vp / v : null;
}

function calculateATR(bars, period = 14) {
  if (bars.length < period + 1) return 0;
  let trSum = 0;
  for (let i = 1; i <= period; i++) {
    const curr = bars[bars.length - i];
    const prev = bars[bars.length - i - 1];
    const tr = Math.max(
      curr.h - curr.l,
      Math.abs(curr.h - prev.c),
      Math.abs(curr.l - prev.c)
    );
    trSum += tr;
  }
  return trSum / period;
}

// ==================== GAPPER SCANNER (ELITE ONLY) ====================
async function getEliteGappers() {
  const data = await safeGet(
    `${MASSIVE_BASE}/v3/reference/tickers?market=stocks&active=true&limit=1200&apiKey=${MASSIVE_KEY}`
  );
  const results = data?.results || [];

  const snapshots = await Promise.all(
    results.map(async (t) => {
      try {
        if (t.type !== "CS" || !t.ticker) return null;
        const snap = await safeGet(
          `${MASSIVE_BASE}/v2/snapshot/locale/us/markets/stocks/tickers?tickers=${t.ticker}&apiKey=${MASSIVE_KEY}`
        );
        return { ...t, snap: snap?.tickers?.[0] };
      } catch { return null; }
    })
  );

  const out = snapshots
    .filter(s => s?.snap)
    .map(s => {
      const last = s.snap.lastTrade?.p || s.snap.day?.c || 0;
      const prev = s.snap.prevDay?.c || 0;
      if (!prev || last < 2.8 || last > 22) return null;
      const gap = (last - prev) / prev;
      if (gap < MIN_GAP) return null;

      const rvol = (s.snap.day?.v || 0) / (prev * 100000);
      if (rvol < MIN_RVOL || (s.snap.day?.v || 0) < 900000) return null;
      if ((s.market_cap || Infinity) > 600000000) return null;
      if ((s.share_class_shares_outstanding || Infinity) > 25000000) return null;

      return { sym: s.ticker, price: last, gap, rvol };
    })
    .filter(Boolean);

  return out.sort((a, b) => b.rvol - a.rvol).slice(0, 12);
}

// ==================== CANDIDATE ANALYSIS ====================
async function analyzeCandidate(t) {
  try {
    const bars = await getBars(t.sym, 3);
    if (bars.length < 60) return null;

    const last = bars[bars.length - 1];
    const vwap = calculateVWAP(bars);
    if (!vwap || last.c <= vwap * 1.002) return null;

    const hod = Math.max(...bars.slice(-25).map(b => b.h));
    if (last.c < hod * 0.994) return null;

    const recentVol = bars.slice(-5).reduce((s, b) => s + (b.v || 0), 0) / 5;
    const avgVol = bars.slice(-35, -5).reduce((s, b) => s + (b.v || 0), 0) / 30 || 1;
    if (recentVol < avgVol * 2.3) return null;

    const features = [
      last.c / vwap,
      last.v / (bars[bars.length - 2]?.v || 1),
      recentVol / avgVol,
      t.gap,
      (last.c - bars[bars.length - 5].c) / bars[bars.length - 5].c,
    ];

    const score = mlPredict(features);
    if (score < getMLThreshold()) return null;

    const equity = await getEquity();
    const atr = calculateATR(bars);
    const riskPerShare = atr || last.c * 0.045;

    const riskFactor = Math.min(1.6, t.gap * 2.8 + t.rvol / 9);
    const qty = Math.max(1, Math.floor((equity * (RISK_PCT / 100) / riskFactor) / riskPerShare));

    const rankingScore = score * (1 + t.gap * 2.2) * Math.sqrt(t.rvol);

    return {
      symbol: t.sym,
      price: last.c,
      qty,
      mlScore: score,
      rankingScore,
      atr,
      gap: t.gap,
      rvol: t.rvol,
      features,
    };
  } catch (e) {
    return null;
  }
}

// ==================== ORDER EXECUTION ====================
async function placeBracketOrder(sig) {
  const payload = {
    symbol: sig.symbol,
    qty: sig.qty,
    side: "buy",
    type: "market",
    time_in_force: "day",
    order_class: "bracket",
    take_profit: { limit_price: parseFloat((sig.price * 1.12).toFixed(2)) },
    stop_loss: {
      stop_price: parseFloat((sig.price * (1 - (sig.atr ? sig.atr / sig.price * 1.8 : 0.06))).toFixed(2)),
    },
  };

  try {
    const r = await safePost(`${ALPACA_BASE}/orders`, payload, alpacaHeaders());
    await logToGAS("ENTRY", sig.symbol, `BUY ${sig.qty}@${sig.price.toFixed(2)} | Score ${(sig.mlScore).toFixed(3)} | Rank ${(sig.rankingScore).toFixed(2)}`, {
      ml: sig.mlScore,
      rank: sig.rankingScore,
      gap: sig.gap.toFixed(2),
      rvol: sig.rvol.toFixed(1),
    });
    positions[sig.symbol] = {
      entry: sig.price,
      qty: sig.qty,
      trailPrice: sig.price * 0.93,
      partialDone: false,
    };
    lastTradeTime = Date.now();
    return r.data;
  } catch (e) {
    await logToGAS("ORDER_FAIL", sig.symbol, e.response?.data?.message || e.message);
    return null;
  }
}

// ==================== POSITION MANAGEMENT ====================
async function managePositions() {
  await syncPositionsFromAlpaca();   // critical for cold starts

  const open = await getOpenPositions();
  for (const pos of open) {
    const symbol = pos.symbol;
    const current = parseFloat(pos.current_price || pos.avg_entry_price);
    const entry = parseFloat(pos.avg_entry_price);
    const qty = parseFloat(pos.qty);

    if (!positions[symbol]) continue;

    const bars = await getBars(symbol, 3);
    const atr = calculateATR(bars);
    const unrealized = (current - entry) / entry;

    // Smarter partials — only if still strong momentum
    if (unrealized >= 0.09 && !positions[symbol].partialDone) {
      const last10 = bars.slice(-10);
      const upBars = last10.filter(b => b.c > b.o).length;
      if (upBars >= 7) {
        await safePost(`${ALPACA_BASE}/orders`, {
          symbol, qty: Math.floor(qty * 0.5), side: "sell", type: "market", time_in_force: "day"
        }, alpacaHeaders());
        positions[symbol].partialDone = true;
        await logToGAS("PARTIAL", symbol, `+9% Locked 50% (${Math.floor(qty * 0.5)} shares)`);
      }
    }

    // Trailing stop — ATR based
    const newTrail = current - (atr ? atr * 1.9 : current * 0.05);
    if (newTrail > positions[symbol].trailPrice) {
      positions[symbol].trailPrice = newTrail;
    }

    if (current <= positions[symbol].trailPrice) {
      await safePost(`${ALPACA_BASE}/orders`, {
        symbol, qty, side: "sell", type: "market", time_in_force: "day"
      }, alpacaHeaders());

      const pnl = ((current - entry) / entry) * 100;
      tradeHistory.push({ symbol, pnl, time: Date.now() });
      await logToGAS("EXIT_TRAIL", symbol, `Trailed @ ${current.toFixed(2)} | P&L ${pnl.toFixed(2)}%`);
      delete positions[symbol];
      lastTradeTime = Date.now();
    }
  }
}

// ==================== SCAN HANDLER ====================
let isScanning = false;
async function scanHandler() {
  if (isScanning) return;
  isScanning = true;

  try {
    const hours = new Date().getUTCHours();
    if (hours < 13 || hours >= 20) { isScanning = false; return; }  // 9:30 AM - 4 PM EST

    await managePositions();
    if (Object.keys(positions).length >= MAX_POS) { isScanning = false; return; }

    const gappers = await getEliteGappers();
    for (const t of gappers) {
      if (Object.keys(positions).length >= MAX_POS) break;
      const sig = await analyzeCandidate(t);
      if (sig && sig.rankingScore > 2.8) {   // only absolute monsters
        await placeBracketOrder(sig);
      }
    }
  } catch (e) {
    console.error("scan error", e.message);
    await logToGAS("SCAN_ERROR", "SYSTEM", e.message);
  } finally {
    isScanning = false;
  }
}

// ==================== PRE-MARKET SCAN ====================
async function preMarketScan() {
  try {
    premarketCandidates = [];
    const gappers = await getEliteGappers();
    const candidates = await Promise.all(gappers.map(analyzeCandidate));
    const valid = candidates.filter(Boolean);

    valid
      .sort((a, b) => b.rankingScore - a.rankingScore)
      .slice(0, 8)
      .forEach(async (sig) => {
        const logData = {
          symbol: sig.symbol,
          price: sig.price.toFixed(2),
          mlScore: sig.mlScore.toFixed(3),
          rankingScore: sig.rankingScore.toFixed(2),
          gapPct: (sig.gap * 100).toFixed(1),
          rvol: sig.rvol.toFixed(1),
          qtyEstimate: sig.qty,
          time: new Date().toISOString(),
        };
        premarketCandidates.push(logData);
        await logToGAS("PREMARKET_CANDIDATE", sig.symbol, `Rank ${sig.rankingScore.toFixed(2)} | ${sig.mlScore.toFixed(3)} | Gap ${(sig.gap*100).toFixed(1)}%`, logData);
      });

    await logToGAS("PREMARKET_SUMMARY", "SYSTEM", `${valid.length} candidates | Top ${premarketCandidates.length} logged`);
  } catch (e) {
    await logToGAS("PREMARKET_ERROR", "SYSTEM", e.message);
  }
}

// Daily 8:45 AM EST (12:45 UTC) pre-market scan
function scheduleDailyPremarket() {
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 12, 45, 0));
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  const delay = next - now;
  setTimeout(() => {
    preMarketScan();
    setInterval(preMarketScan, 24 * 60 * 60 * 1000);
  }, delay);
}
scheduleDailyPremarket();

// ==================== ROUTES ====================
app.get("/", (req, res) => res.json({ status: "AlphaStream v23.4 LIVE", time: new Date().toISOString(), positions: Object.keys(positions).length }));

app.post("/", async (req, res) => {
  const body = req.body || {};
  if (FORWARD_SECRET && body.secret !== FORWARD_SECRET) return res.status(403).json({ error: "forbidden" });

  const scanId = body.t || body.scanId || Date.now();
  if (lastScanId === scanId) return res.json({ status: "already_running" });
  lastScanId = scanId;

  scanHandler().catch(e => console.error(e));
  res.json({ status: "scan_queued", scanId });
});

app.get("/premarket", async (req, res) => {
  const result = await preMarketScan();
  res.json({ status: "ok", count: result.length, candidates: premarketCandidates });
});

app.get("/premarket/last", (req, res) => {
  res.json({ status: "ok", count: premarketCandidates.length, candidates: premarketCandidates });
});

app.get("/health", (req, res) => {
  const inactiveMins = (Date.now() - lastTradeTime) / 60000;
  if (inactiveMins > 240) return res.status(500).json({ error: "stale_bot" });
  res.json({ status: "healthy", positions: Object.keys(positions).length, uptime: process.uptime() });
});

// ==================== START ====================
const PORT = process.env.PORT || 8080;
app.listen(PORT, async () => {
  console.log(`AlphaStream v23.4 (Kevin Phan) listening on ${PORT}`);
  await syncPositionsFromAlpaca();
  await logToGAS("BOT_START", "SYSTEM", "AlphaStream v23.4 DEPLOYED & SYNCED");
});
