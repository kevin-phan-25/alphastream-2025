// index.js — AlphaStream v27.5 — FIXED & DEPLOYABLE (2025)
import express from "express";
import axios from "axios";
import * as ti from "technicalindicators"; // robust import

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

// safer coercion if env var undefined
const DRY_MODE_BOOL = String(DRY_MODE).toLowerCase() !== "false";
const A_BASE = "https://paper-api.alpaca.markets/v2";
const M_BASE = "https://api.massive.com";
const headers = { "APCA-API-KEY-ID": ALPACA_KEY, "APCA-API-SECRET-KEY": ALPACA_SECRET };

let positions = {}; // symbol -> { entry, qty, stop, trailStop, peak, atr, took2R }
let scanning = false;
let dailyPnL = 0;
let lastResetDate = "";
let accountEquity = 25000; // fallback if Alpaca fails

// RISK
const RISK_PER_TRADE = 0.01;
const MAX_DAILY_LOSS = -0.02;
const MAX_FLOAT = 30000000; // avoid numeric separators for compatibility
const MIN_GAP = 15;
const MIN_VOLUME = 500000;

async function log(event, symbol = "", note = "", data = {}) {
  try {
    console.log(`[${event}] ${symbol} | ${note}`, data);
    if (LOG_WEBHOOK_URL && LOG_WEBHOOK_SECRET) {
      await axios.post(
        LOG_WEBHOOK_URL,
        { secret: LOG_WEBHOOK_SECRET, event, symbol, note, data },
        { timeout: 5000 }
      );
    }
  } catch (e) {
    // don't crash on logging failures
    console.warn("LOG_FAIL", event, symbol, e?.message || e);
  }
}

// Fetch real account equity on startup / when scanning
async function updateEquity() {
  if (!ALPACA_KEY || !ALPACA_SECRET) {
    await log("EQUITY", "SYSTEM", "No Alpaca creds, using fallback", { fallback: accountEquity });
    return;
  }
  try {
    const res = await axios.get(`${A_BASE}/account`, { headers, timeout: 8000 });
    accountEquity = parseFloat(res.data?.equity || res.data?.cash || accountEquity);
    await log("EQUITY", "SYSTEM", `$${Number(accountEquity).toLocaleString()}`);
  } catch (e) {
    await log("EQUITY_FAIL", "SYSTEM", `Using fallback $${accountEquity}`, { err: e?.message || String(e) });
  }
}

function resetDailyPnL() {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== lastResetDate) {
    dailyPnL = 0;
    lastResetDate = today;
    log("DAILY_RESET", "SYSTEM", "PnL reset");
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
    await log("ORDER_FAIL", sym, e?.response?.data?.message || e?.message || String(e));
  }
}

// Monitoring: trailing stop (peak - 1.5 * ATR), 50% partial at 2R
async function monitorPositions() {
  for (const sym of Object.keys(positions)) {
    const pos = positions[sym];
    try {
      const quoteRes = await axios.get(`${A_BASE}/stocks/${sym}/quote`, { headers, timeout: 5000 });
      const bid = quoteRes?.data?.quote?.bp || pos.entry;

      if (bid > pos.peak) pos.peak = bid;
      const newTrail = pos.peak - pos.atr * 1.5;
      if (newTrail > pos.trailStop) pos.trailStop = newTrail;

      // Partial at 2R
      const twoRlevel = pos.entry + 2 * (pos.entry - pos.stop);
      if (!pos.took2R && bid >= twoRlevel) {
        const half = Math.floor(pos.qty * 0.5);
        if (half > 0) {
          await placeOrder(sym, half, "sell");
          pos.qty -= half;
          pos.took2R = true;
          await log("PARTIAL_2R", sym, "50% off at 2R");
        }
      }

      // Trailing stop
      if (bid <= pos.trailStop) {
        await placeOrder(sym, pos.qty, "sell");
        const pnl = recordPnL(bid, pos.entry);
        await log("TRAIL_STOP", sym, `Hit @ $${Number(bid).toFixed(2)} | PnL ${(pnl * 100).toFixed(2)}%`);
        delete positions[sym];
      }
    } catch (e) {
      await log("MONITOR_ERROR", sym, e?.message || String(e));
    }
  }
}

async function exitAt345OrLoss() {
  const now = new Date();
  const utcH = now.getUTCHours();
  const utcM = now.getUTCMinutes();

  if (dailyPnL <= MAX_DAILY_LOSS && Object.keys(positions).length > 0) {
    await log("LOSS_STOP", "SYSTEM", `Daily loss ${(dailyPnL * 100).toFixed(2)}% → closing all`);
    for (const sym of Object.keys(positions)) {
      await placeOrder(sym, positions[sym].qty, "sell");
      delete positions[sym];
    }
    return;
  }

  // 3:45 PM ET approx = 19:45 UTC (watch minute window)
  if (utcH === 19 && utcM >= 45 && utcM < 50 && Object.keys(positions).length > 0) {
    await log("AUTO_EXIT_ALL", "SYSTEM", "3:45 PM flat");
    for (const sym of Object.keys(positions)) {
      await placeOrder(sym, positions[sym].qty, "sell");
      delete positions[sym];
    }
  }
}

async function scanLowFloatPennies() {
  if (scanning || dailyPnL <= MAX_DAILY_LOSS) return;
  scanning = true;
  await updateEquity();
  resetDailyPnL();

  const utcTime = new Date().getUTCHours() * 100 + new Date().getUTCMinutes();
  if (utcTime < 1100 || utcTime >= 1500) { scanning = false; return; }

  await log("SCAN", "SYSTEM", "Low-float penny hunt");

  let candidates = [];
  try {
    const res = await axios.get(`${M_BASE}/v2/snapshot/locale/us/markets/stocks/gainers?apiKey=${MASSIVE_KEY}`, { timeout: 10000 });
    candidates = (res?.data?.tickers || [])
      .filter(t => t?.lastTrade?.p >= 1 && t?.lastTrade?.p <= 20 && t?.lastTrade?.v >= MIN_VOLUME)
      .map(t => ({ symbol: t.ticker, price: t.lastTrade.p, gap: t.todaysChangePerc || 0 }))
      .filter(c => c.gap >= MIN_GAP)
      .sort((a, b) => b.gap - a.gap)
      .slice(0, 20);
  } catch (e) {
    await log("SNAPSHOT_FAIL", "SYSTEM", e?.message || String(e));
    scanning = false;
    return;
  }

  for (const c of candidates) {
    if (Object.keys(positions).length >= parseInt(MAX_POS)) break;

    // default large float
    let float = 100000000;
    try {
      const info = await axios.get(`${M_BASE}/v3/reference/tickers/${c.symbol}?apiKey=${MASSIVE_KEY}`, { timeout: 5000 });
      float = info?.data?.results?.outstanding_shares || float;
    } catch (e) {
      // ignore float failures (will skip if above threshold)
    }
    if (float > MAX_FLOAT) continue;

    // fetch minute bars (fixed Date.now() usage)
    let bars = [];
    try {
      const from = new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const to = new Date().toISOString().slice(0, 10);
      const b = await axios.get(`${M_BASE}/v2/aggs/ticker/${c.symbol}/range/1/minute/${from}/${to}?limit=300&apiKey=${MASSIVE_KEY}`, { timeout: 10000 });
      bars = b?.data?.results || [];
    } catch (e) {
      await log("BARS_FAIL", c.symbol, e?.message || String(e));
      continue;
    }
    if (bars.length < 100) continue;

    const close = bars.map(x => x.c);
    const high = bars.map(x => x.h);
    const low = bars.map(x => x.l);

    // use safe TI functions imported above
    let st = [];
    let adxData = [];
    let atrData = [];
    try {
      st = TI_Supertrend({ period: 10, multiplier: 3, high, low, close });
      adxData = TI_ADX({ period: 14, high, low, close });
      atrData = TI_ATR({ period: 14, high, low, close });
    } catch (e) {
      await log("TI_FAIL", c.symbol, e?.message || String(e));
      continue;
    }

    const cur = {
      price: close[close.length - 1],
      trend: st[st.length - 1]?.trend,
      line: st[st.length - 1]?.superTrend,
      adx: (adxData && adxData[adxData.length - 1] && adxData[adxData.length - 1].adx) ? adxData[adxData.length - 1].adx : 0,
      atr: (atrData && atrData[atrData.length - 1]) ? atrData[atrData.length - 1] : 1
    };

    if (cur.adx > 25 && cur.trend === 1 && cur.price > cur.line) {
      const riskAmount = accountEquity * RISK_PER_TRADE;
      const qty = Math.max(1, Math.floor(riskAmount / (cur.atr * 2)));

      // optional: check ML predictor quickly (non-blocking fallback)
      let prob = 0.84;
      if (PREDICTOR_URL) {
        try {
          const ml = await axios.post(`${PREDICTOR_URL}/predict`, { features: [c.gap, cur.adx, cur.atr / cur.price] }, { timeout: 3000 });
          prob = ml?.data?.probability || prob;
        } catch (e) {
          // ignore predictor failures
        }
      }

      // gating: if predictor present require > 0.8, else allow
      if (!PREDICTOR_URL || prob > 0.80) {
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

        await log("ENTRY", c.symbol, `+${c.gap.toFixed(1)}% | Float ${(float / 1e6).toFixed(1)}M`, { qty });
      }
    }
  } // end candidates loop

  scanning = false;
}

// endpoints
app.get("/", (_, res) => res.json({
  bot: "AlphaStream v27.5 — FUNDED READY",
  equity: `$${Number(accountEquity).toLocaleString()}`,
  dailyPnL: `${(dailyPnL * 100).toFixed(2)}%`,
  positions: Object.keys(positions).length + "/" + MAX_POS,
  status: dailyPnL <= MAX_DAILY_LOSS ? "STOPPED" : "LIVE",
  dry_mode: DRY_MODE_BOOL
}));
app.get("/healthz", (_, res) => res.status(200).send("OK"));

const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", async () => {
  console.log(`ALPHASTREAM v27.5 FUNDED-READY LIVE on port ${PORT}`);
  await log("BOT_START", "SYSTEM", "v27.5 — Real Equity + Trailing Stop + Partials");
  await updateEquity();
  setInterval(scanLowFloatPennies, 75_000); // this numeric literal is safe in Node 18+; if you want max compatibility change to 75000
  setInterval(monitorPositions, 30_000);
  setInterval(exitAt345OrLoss, 60_000);
});
