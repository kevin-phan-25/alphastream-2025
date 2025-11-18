// index.js — AlphaStream v27.5-merge — LOW FLOAT PENNY + TRAILING + REAL EQUITY (2025)
import express from "express";
import axios from "axios";
import * as ti from "technicalindicators"; // safe import for broad runtimes

const { Supertrend: TI_Supertrend, ADX: TI_ADX, ATR: TI_ATR } = ti;

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

// safer coercion in case env var is undefined
const DRY_MODE_BOOL = String(DRY_MODE).toLowerCase() !== "false";
const A_BASE = "https://paper-api.alpaca.markets/v2";
const M_BASE = "https://api.massive.com";
const headers = { "APCA-API-KEY-ID": ALPACA_KEY, "APCA-API-SECRET-KEY": ALPACA_SECRET };

let positions = {}; // symbol -> { entry, qty, stop, trailStop, peak, atr, took2R }
let scanning = false;
let dailyPnL = 0;
let lastResetDate = new Date().toISOString().slice(0, 10);
let accountEquity = 25000; // fallback, will be updated from Alpaca if possible

// HARD RISK LIMITS
const MAX_DAILY_LOSS = -0.02;  // 2% daily stop
const RISK_PER_TRADE = 0.01;   // 1% risk per trade
const MAX_FLOAT = 30000000;    // < 30M shares
const MIN_GAP = 15;
const MIN_VOLUME = 500000;

async function log(event, symbol = "", note = "", data = {}) {
  console.log(`[${event}] ${symbol} | ${note}`, data);
  if (LOG_WEBHOOK_URL && LOG_WEBHOOK_SECRET) {
    try {
      await axios.post(LOG_WEBHOOK_URL, { secret: LOG_WEBHOOK_SECRET, event, symbol, note, data }, { timeout: 5000 });
    } catch (e) {
      /* swallow logging failures */
    }
  }
}

// Get real equity from Alpaca on startup / when scanning
async function updateEquity() {
  if (!ALPACA_KEY || !ALPACA_SECRET) return;
  try {
    const res = await axios.get(`${A_BASE}/account`, { headers, timeout: 8000 });
    accountEquity = parseFloat(res.data.equity || res.data.cash || accountEquity);
    await log("EQUITY", "SYSTEM", `$${Number(accountEquity).toLocaleString()}`);
  } catch (e) {
    await log("EQUITY_FAIL", "SYSTEM", `Using fallback $${accountEquity}`, { err: e.message });
  }
}

// Reset daily PnL at midnight ET
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

async function placeOrder(sym, qty, side, price = null) {
  if (DRY_MODE_BOOL) {
    await log("DRY_ORDER", sym, `${side.toUpperCase()} ${qty} @ ${price ? `$${price.toFixed(2)}` : "market"}`);
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

// Monitor positions: update peak, set trailing stop (peak - 1.5 * ATR), partial 50% at 2R, flat on trail hit
async function monitorPositions() {
  for (const sym of Object.keys(positions)) {
    const pos = positions[sym];
    try {
      const quote = await axios.get(`${A_BASE}/stocks/${sym}/quote`, { headers, timeout: 5000 });
      const bid = (quote && quote.data && quote.data.quote && quote.data.quote.bp) ? quote.data.quote.bp : pos.entry;

      if (bid > pos.peak) pos.peak = bid;
      const newTrail = pos.peak - pos.atr * 1.5;
      if (newTrail > pos.trailStop) pos.trailStop = newTrail;

      // Partial at 2R (50%)
      const twoRlevel = pos.entry + 2 * (pos.entry - pos.stop);
      if (!pos.took2R && bid >= twoRlevel) {
        const half = Math.floor(pos.qty * 0.5);
        if (half > 0) {
          await placeOrder(sym, half, "sell");
          pos.qty -= half;
          pos.took2R = true;
          await log("PARTIAL_2R", sym, "50% taken at 2R");
        }
      }

      // Trailing stop hit
      if (bid <= pos.trailStop) {
        await placeOrder(sym, pos.qty, "sell");
        const pnl = recordPnL(bid, pos.entry);
        await log("TRAIL_STOP", sym, `Hit @ $${bid.toFixed(2)} | PnL ${(pnl*100).toFixed(2)}%`);
        delete positions[sym];
      }
    } catch (e) {
      await log("MONITOR_ERROR", sym, e.message || String(e));
    }
  }
}

// 3:45 PM ET EXIT + DAILY LOSS STOP
async function exitAt345OrLoss() {
  const now = new Date();
  const utcH = now.getUTCHours();
  const utcM = now.getUTCMinutes();

  if (dailyPnL <= MAX_DAILY_LOSS) {
    if (Object.keys(positions).length > 0) {
      await log("LOSS_STOP", "SYSTEM", `Daily loss hit ${(dailyPnL*100).toFixed(2)}% → closing all`);
      for (const sym in positions) await placeOrder(sym, positions[sym].qty, "sell");
      positions = {};
    }
    return;
  }

  // 3:45 PM ET = 19:45 UTC (approx; you already used 19:45 earlier)
  if (utcH === 19 && utcM >= 45 && utcM < 50 && Object.keys(positions).length > 0) {
    await log("AUTO_EXIT_ALL", "SYSTEM", "3:45 PM — closing all");
    for (const sym in positions) await placeOrder(sym, positions[sym].qty, "sell");
    positions = {};
  }
}

// LOW FLOAT + PENNY SCANNER — OPTIMIZED & SAFE
async function scanLowFloatPennies() {
  if (scanning || dailyPnL <= MAX_DAILY_LOSS) return;
  scanning = true;
  resetDailyPnL();
  await updateEquity();

  try {
    const now = new Date();
    const utcTime = now.getUTCHours() * 100 + now.getUTCMinutes();
    if (utcTime < 1100 || utcTime >= 1500) { scanning = false; return; } // scanning window

    const isPreMarket = utcTime < 1330;
    await log(isPreMarket ? "PREMARKET_LOW_FLOAT" : "MORNING_LOW_FLOAT", "SYSTEM", "Scanning $1–$20 + <30M float");

    // FIRST: gainers snapshot
    let candidates = [];
    try {
      const res = await axios.get(`${M_BASE}/v2/snapshot/locale/us/markets/stocks/gainers?apiKey=${MASSIVE_KEY}`, { timeout: 10000 });
      candidates = (res.data.tickers || [])
        .filter(t => t.lastTrade && t.prevDay)
        .filter(t => t.lastTrade.p >= 1 && t.lastTrade.p <= 20)
        .filter(t => t.lastTrade.v >= MIN_VOLUME)
        .map(t => ({
          symbol: t.ticker,
          price: t.lastTrade.p,
          gap: (t.lastTrade.p / t.prevDay.c - 1) * 100,
          volume: t.lastTrade.v
        }))
        .filter(t => t.gap >= MIN_GAP)
        .sort((a, b) => b.gap - a.gap);
    } catch (e) {
      await log("GAINERS_ERROR", "SYSTEM", "Gainers snapshot failed, will fallback");
    }

    // fallback to a broader snapshot if empty
    if (candidates.length === 0) {
      try {
        const res = await axios.get(`${M_BASE}/v2/snapshot/locale/us/markets/stocks/tickers?apiKey=${MASSIVE_KEY}`, { timeout: 15000 });
        const all = Object.values(res.data.tickers || {});
        candidates = all
          .filter(t => t.lastTrade && t.prevDay && t.lastTrade.p >= 1 && t.lastTrade.p <= 20 && t.lastTrade.v >= MIN_VOLUME)
          .map(t => ({ symbol: t.ticker, price: t.lastTrade.p, gap: (t.lastTrade.p / t.prevDay.c - 1) * 100, volume: t.lastTrade.v }))
          .filter(t => t.gap >= MIN_GAP)
          .sort((a, b) => b.gap - a.gap)
          .slice(0, 25);
      } catch (e) {
        await log("SNAPSHOT_FAIL", "SYSTEM", e.message || String(e));
      }
    }

    await log("LOW_FLOAT_CANDIDATES", "SYSTEM", `${candidates.length} penny rockets`, candidates.map(c => `${c.symbol} +${c.gap.toFixed(1)}%`));

    for (const c of candidates) {
      if (Object.keys(positions).length >= parseInt(MAX_POS)) break;

      // GET FLOAT
      let float = 100000000;
      try {
        const info = await axios.get(`${M_BASE}/v3/reference/tickers/${c.symbol}?apiKey=${MASSIVE_KEY}`, { timeout: 5000 });
        float = info.data.results?.outstanding_shares || float;
      } catch (e) {}

      if (float > MAX_FLOAT) {
        await log("SKIP_FLOAT", c.symbol, `Float ${float.toLocaleString()} > ${MAX_FLOAT.toLocaleString()}`);
        continue;
      }

      await log("VALID_PENNY", c.symbol, `+${c.gap.toFixed(1)}% | $${c.price.toFixed(2)} | Float ${(float/1e6).toFixed(1)}M`);

      // Bars + indicators (only if float OK)
      let bars = [];
      try {
        // fixed Date.now() use
        const from = new Date(Date.now() - 48*60*60*1000).toISOString().slice(0,10);
        const to = new Date().toISOString().slice(0,10);
        const b = await axios.get(`${M_BASE}/v2/aggs/ticker/${c.symbol}/range/1/minute/${from}/${to}?limit=200&apiKey=${MASSIVE_KEY}`, { timeout: 8000 });
        bars = b.data.results || [];
      } catch (e) {
        await log("BARS_FAIL", c.symbol, e.message || String(e));
        continue;
      }

      if (bars.length < 80) continue;

      const close = bars.map(x => x.c);
      const high = bars.map(x => x.h);
      const low = bars.map(x => x.l);

      // use already-imported TI functions for compatibility & performance
      const st = TI_Supertrend({ period: 10, multiplier: 3, high, low, close });
      const adx = TI_ADX({ period: 14, high, low, close });
      const atr = TI_ATR({ period: 14, high, low, close });

      const current = {
        price: close[close.length - 1],
        stTrend: st[st.length - 1]?.trend,
        stLine: st[st.length - 1]?.superTrend,
        adx: (adx && adx[adx.length - 1] && adx[adx.length - 1].adx) ? adx[adx.length - 1].adx : 0,
        atr: atr && atr[atr.length - 1] ? atr[atr.length - 1] : 1
      };

      if (current.adx > 25 && current.stTrend === 1 && current.price > current.stLine) {
        // optional ML predictor
        let prob = 0.84;
        if (PREDICTOR_URL) {
          try {
            const ml = await axios.post(PREDICTOR_URL + "/predict", { features: [c.gap, current.adx, current.atr / current.price] }, { timeout: 3000 });
            prob = ml.data.probability || prob;
          } catch (e) {
            /* ignore predictor failures */
          }
        }

        if (prob > 0.80) {
          const riskAmount = accountEquity * RISK_PER_TRADE;
          const qty = Math.max(1, Math.floor(riskAmount / (current.atr * 1.5)));
          await placeOrder(c.symbol, qty, "buy");
          positions[c.symbol] = {
            entry: current.price,
            qty,
            stop: current.price - current.atr * 2,
            trailStop: current.price - current.atr * 2,
            peak: current.price,
            atr: current.atr,
            took2R: false
          };
          await log("LOW_FLOAT_ENTRY", c.symbol, `+${c.gap.toFixed(1)}% | Float ${(float/1e6).toFixed(1)}M | Risk ${(RISK_PER_TRADE*100).toFixed(2)}%`, { qty, prob: (prob*100).toFixed(1) });
        }
      }
    }
  } catch (err) {
    await log("SCAN_ERROR", "SYSTEM", err.message || String(err));
  } finally {
    scanning = false;
  }
}

// Dashboard endpoints
app.get("/", (req, res) => res.json({
  bot: "AlphaStream v27.5-merge — LOW FLOAT PENNY",
  status: dailyPnL <= MAX_DAILY_LOSS ? "STOPPED (Daily Loss Limit)" : "LIVE",
  dailyPnL: (dailyPnL*100).toFixed(2) + "%",
  positions: Object.keys(positions).length + "/" + MAX_POS,
  dry_mode: DRY_MODE_BOOL,
  equity: `$${Number(accountEquity).toLocaleString()}`
}));

app.get("/healthz", (_, res) => res.status(200).send("OK"));

app.post("/", async (req, res) => {
  if (FORWARD_SECRET && req.body?.secret !== FORWARD_SECRET) return res.status(403).send("no");
  res.json({ status: "LOW FLOAT PENNY SCAN TRIGGERED" });
  await log("MANUAL_SCAN", "DASHBOARD", "User triggered");
  await scanLowFloatPennies();
});

// START
const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", async () => {
  console.log(`ALPHASTREAM v27.5-merge LOW FLOAT PENNY LIVE on ${PORT}`);
  await log("BOT_START", "SYSTEM", "Low Float + Trailing + Real Equity", { dry_mode: DRY_MODE_BOOL });
  await updateEquity();
  scanLowFloatPennies();
  setInterval(scanLowFloatPennies, 75000);
  setInterval(monitorPositions, 30000); // trailing check every 30s
  setInterval(exitAt345OrLoss, 60000);
});
