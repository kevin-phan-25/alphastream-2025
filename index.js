// index.js — AlphaStream v27.2 — NUCLEAR + NEWS CATALYST (FIXED & LIVE)
import express from "express";
import axios from "axios";
import { Supertrend, ADX, ATR } from "technicalindicators";

const app = express();
app.use(express.json());

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");
  if (req.method === "OPTIONS") return res.status(200).end();
  next();
});

const {
  ALPACA_KEY = "",
  ALPACA_SECRET = "",
  MASSIVE_KEY = "",
  PREDICTOR_URL = "",
  LOG_WEBHOOK_URL = "",
  LOG_WEBHOOK_SECRET = "",
  FORWARD_SECRET = "",
  MAX_POS = "3",
  DRY_MODE = "false"
} = process.env;

const DRY_MODE_BOOL = DRY_MODE.toLowerCase() !== "false";
const A_BASE = "https://paper-api.alpaca.markets/v2";
const M_BASE = "https://api.massive.com";
const headers = { "APCA-API-KEY-ID": ALPACA_KEY, "APCA-API-SECRET-KEY": ALPACA_SECRET };

let positions = {};
let scanning = false;
let dailyPnL = 0;
let lastResetDate = "";
let accountEquity = 25000;

// RISK
const RISK_PER_TRADE = 0.01;
const MAX_DAILY_LOSS = -0.02;
const MAX_FLOAT = 30_000_000;
const MIN_GAP = 15;
const MIN_VOLUME = 500_000;

async function log(event, symbol = "", note = "", data = {}) {
  console.log(`[${event}] ${symbol} | ${note}`, data);
  if (LOG_WEBHOOK_URL && LOG_WEBHOOK_SECRET) {
    try { await axios.post(LOG_WEBHOOK_URL, { secret: LOG_WEBHOOK_SECRET, event, symbol, note, data }, { timeout: 5000 }); } catch {}
  }
}

async function updateEquity() {
  try {
    const res = await axios.get(`${A_BASE}/account`, { headers, timeout: 8000 });
    accountEquity = parseFloat(res.data.equity || res.data.cash || 25000);
  } catch (e) {
    accountEquity = 25000;
  }
}

function resetDailyPnL() {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== lastResetDate) {
    dailyPnL = 0;
    lastResetDate = today;
    log("DAILY_RESET", "SYSTEM", "Daily PnL reset");
  }
}

function recordPnL(exitPrice, entry) {
  const pnl = (exitPrice - entry) / entry;
  dailyPnL += pnl;
  return pnl;
}

async function placeOrder(sym, qty, side) {
  if (DRY_MODE_BOOL) {
    await log("DRY_ORDER", sym, `${side.toUpperCase()} ${qty}`);
    return;
  }
  try {
    await axios.post(`${A_BASE}/orders`, {
      symbol: sym,
      qty,
      side,
      type: "market",
      time_in_force: "day",
      extended_hours: true
    }, { headers });
    await log("LIVE_ORDER", sym, `${side.toUpperCase()} ${qty}`);
  } catch (e) {
    await log("ORDER_FAIL", sym, e.response?.data?.message || e.message);
  }
}

async function exitAt345OrLoss() {
  const now = new Date();
  const utcH = now.getUTCHours();
  const utcM = now.getUTCMinutes();

  if (dailyPnL <= MAX_DAILY_LOSS && Object.keys(positions).length > 0) {
    await log("LOSS_STOP", "SYSTEM", `Daily loss ${(dailyPnL*100).toFixed(2)}% → closing all`);
    for (const sym in positions) {
      await placeOrder(sym, positions[sym].qty, "sell");
      delete positions[sym];
    }
    return;
  }

  if (utcH === 19 && utcM >= 45 && utcM < 50 && Object.keys(positions).length > 0) {
    await log("AUTO_EXIT_ALL", "SYSTEM", "3:45 PM flat exit");
    for (const sym in positions) {
      await placeOrder(sym, positions[sym].qty, "sell");
      delete positions[sym];
    }
  }
}

async function monitorPositions() {
  for (const sym in positions) {
    const pos = positions[sym];
    try {
      const quote = await axios.get(`${A_BASE}/stocks/${sym}/quote`, { headers, timeout: 5000 });
      const bid = quote.data.quote?.bp || pos.entry;

      if (bid > pos.peak) pos.peak = bid;
      const newTrail = pos.peak - (pos.atr * 1.5);
      if (newTrail > pos.trailStop) pos.trailStop = newTrail;

      if (!pos.took2R && bid >= pos.entry + 2 * (pos.entry - pos.stop)) {
        const halfQty = Math.floor(pos.qty * 0.5);
        if (halfQty > 0) {
          await placeOrder(sym, halfQty, "sell");
          pos.qty -= halfQty;
          pos.took2R = true;
          await log("PARTIAL_2R", sym, "50% off at 2R — trailing rest");
        }
      }

      if (bid <= pos.trailStop) {
        await placeOrder(sym, pos.qty, "sell");
        const pnl = recordPnL(bid, pos.entry);
        await log("TRAIL_STOP", sym, `Hit @ $${bid.toFixed(2)} | PnL ${(pnl*100).toFixed(2)}%`);
        delete positions[sym];
      }
    } catch (e) {
      await log("MONITOR_ERROR", sym, e.message);
    }
  }
}

// FIXED: Proper news endpoint + correct date syntax
async function hasPositiveNews(symbol) {
  try {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const url = `${M_BASE}/v2/reference/news?ticker=${symbol}&published_utc=>${oneHourAgo}&limit=10&apiKey=${MASSIVE_KEY}`;
    const res = await axios.get(url, { timeout: 8000 });

    const articles = res.data.results || [];
    if (articles.length === 0) return false;

    return articles.some(article => {
      const text = `${article.title || ""} ${article.description || ""}`.toLowerCase();
      const positiveKeywords = [
        "breakout", "surges", "spikes", "soars", "rallies", "beats", "raises guidance",
        "fda", "approval", "partnership", "contract", "acquisition", "merger", "record revenue"
      ];
      return positiveKeywords.some(kw => text.includes(kw));
    });
  } catch (e) {
    return false; // Fail-open: don't block entry if news fails
  }
}

async function scanLowFloatPennies() {
  if (scanning || dailyPnL <= MAX_DAILY_LOSS) return;
  scanning = true;
  await updateEquity();
  resetDailyPnL();

  const utcTime = new Date().getUTCHours() * 100 + new Date().getUTCMinutes();
  if (utcTime < 1100 || utcTime >= 1500) {
    scanning = false;
    return;
  }

  await log("SCAN", "SYSTEM", "Nuclear scan: Low-float + Fresh Positive News");

  let candidates = [];
  try {
    const res = await axios.get(`${M_BASE}/v2/snapshot/locale/us/markets/stocks/gainers?apiKey=${MASSIVE_KEY}`, { timeout: 10000 });
    candidates = (res.data.tickers || [])
      .filter(t => t.lastTrade?.p >= 1 && t.lastTrade?.p <= 20 && t.lastTrade?.v >= MIN_VOLUME)
      .map(t => ({ symbol: t.ticker, price: t.lastTrade.p, gap: t.todaysChangePerc || 0 }))
      .filter(c => c.gap >= MIN_GAP)
      .sort((a, b) => b.gap - a.gap)
      .slice(0, 20);
  } catch (e) {
    await log("GAINERS_ERROR", "SYSTEM", "Failed to fetch gainers");
    scanning = false;
    return;
  }

  for (const c of candidates) {
    if (Object.keys(positions).length >= parseInt(MAX_POS)) break;
    if (positions[c.symbol]) continue;

    // Float check
    let float = 100_000_000;
    try {
      const info = await axios.get(`${M_BASE}/v3/reference/tickers/${c.symbol}?apiKey=${MASSIVE_KEY}`, { timeout: 5000 });
      float = info.data.results?.outstanding_shares || float;
    } catch {}
    if (float > MAX_FLOAT) continue;

    // NEWS CATALYST — THIS IS THE EDGE
    const hasNews = await hasPositiveNews(c.symbol);
    if (!hasNews) {
      await log("NO_CATALYST", c.symbol, `+${c.gap.toFixed(1)}% — no fresh positive news → skipped`);
      continue;
    }

    // Technicals
    let bars = [];
    try {
      const from = new Date(Date.now() - 72*60*60*1000).toISOString().slice(0,10);
      const to = new Date().toISOString().slice(0,10);
      const res = await axios.get(`${M_BASE}/v2/aggs/ticker/${c.symbol}/range/1/minute/${from}/${to}?limit=300&apiKey=${MASSIVE_KEY}`, { timeout: 10000 });
      bars = res.data.results || [];
    } catch { continue; }
    if (bars.length < 100) continue;

    const close = bars.map(b => b.c);
    const high = bars.map(b => b.h);
    const low = bars.map(b => b.l);

    const st = Supertrend({ period: 10, multiplier: 3, high, low, close });
    const adxData = ADX({ period: 14, high, low, close });
    const atrData = ATR({ period: 14, high, low, close });

    const cur = {
      price: close[close.length-1],
      trend: st[st.length-1]?.trend,
      line: st[st.length-1]?.superTrend,
      adx: adxData[adxData.length-1]?.adx || 0,
      atr: atrData[atrData.length-1] || 1
    };

    if (cur.adx > 25 && cur.trend === 1 && cur.price > cur.line) {
      const riskAmount = accountEquity * RISK_PER_TRADE;
      const qty = Math.max(1, Math.floor(riskAmount / (cur.atr * 2)));

      await placeOrder(c.symbol, qty, "buy");

      const stopPrice = cur.price - cur.atr * 2;
      positions[c.symbol] = {
        entry: cur.price,
        qty,
        stop: stopPrice,
        trailStop: stopPrice,
        peak: cur.price,
        atr: cur.atr,
        took2R: false
      };

      await log("NUCLEAR_ENTRY", c.symbol,
        `+${c.gap.toFixed(1)}% | Float ${(float/1e6).toFixed(1)}M | FRESH POSITIVE NEWS`,
        { qty, catalyst: "YES" }
      );
    }
  }
  scanning = false;
}

app.get("/", (_, res) => res.json({
  bot: "AlphaStream v27.2 NUCLEAR + NEWS",
  equity: `$${accountEquity.toLocaleString()}`,
  dailyPnL: `${(dailyPnL*100).toFixed(2)}%`,
  positions: Object.keys(positions).length,
  status: dailyPnL <= MAX_DAILY_LOSS ? "DAILY LOSS STOP" : "LIVE"
}));
app.get("/healthz", (_, res) => res.status(200).send("OK"));

const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", async () => {
  console.log(`ALPHASTREAM v27.2 NUCLEAR LIVE on port ${PORT}`);
  await log("BOT_START", "SYSTEM", "v27.2 NUCLEAR — Low Float + News Catalyst + Unbreakable Trail");
  await updateEquity();
  setInterval(scanLowFloatPennies, 75000);
  setInterval(monitorPositions, 30000);
  setInterval(exitAt345OrLoss, 60000);
});
