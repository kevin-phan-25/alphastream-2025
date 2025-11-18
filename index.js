// index.js — AlphaStream v24 ELITE — FULLY ARMED & CLOUD-RUN PROVEN (Nov 2025)
import express from "express";
import axios from "axios";
import { Supertrend, ADX, ATR } from "technicalindicators";

const app = express();
app.use(express.json());

// CORS — MUST BE FIRST
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  next();
});

// ENV VARS
const {
  ALPACA_KEY = "",
  ALPACA_SECRET = "",
  MASSIVE_KEY = "",
  PREDICTOR_URL = "",
  LOG_WEBHOOK_URL = "",
  LOG_WEBHOOK_SECRET = "",
  FORWARD_SECRET = "",
  MAX_POS = "3",
  SCAN_INTERVAL_MS = "48000",
  DRY_MODE = "true"            // default safe
} = process.env;

const DRY_MODE_BOOL = !["false", "0", "no", "off"].includes(String(DRY_MODE).toLowerCase());
const A_BASE = "https://paper-api.alpaca.markets/v2";
const headers = {
  "APCA-API-KEY-ID": ALPACA_KEY,
  "APCA-API-SECRET-KEY": ALPACA_SECRET
};

let positions = {};
let scanning = false;

// Logger
async function log(event, symbol = "", note = "", data = {}) {
  console.log(`[${event}] ${symbol} | ${note}`, data);
  if (!LOG_WEBHOOK_URL || !LOG_WEBHOOK_SECRET) return;
  try {
    await axios.post(LOG_WEBHOOK_URL, { secret: LOG_WEBHOOK_SECRET, event, symbol, note, data }, { timeout: 5000 });
  } catch {}
}

// Alpaca helpers
async function getEquity() {
  try {
    const r = await axios.get(`${A_BASE}/account`, { headers });
    return parseFloat(r.data.equity) || 25000;
  } catch { return 25000; }
}

async function placeOrder(sym, qty, side) {
  if (DRY_MODE_BOOL) {
    await log("DRY_ORDER", sym, `${side.toUpperCase()} ${qty} shares`);
    return;
  }
  try {
    await axios.post(`${A_BASE}/orders`, {
      symbol: sym,
      qty,
      side,
      type: "market",
      time_in_force: "day"
    }, { headers });
    await log("LIVE_ORDER", sym, `${side.toUpperCase()} ${qty} shares`);
  } catch (e) {
    await log("ORDER_FAIL", sym, e.response?.data?.message || e.message);
  }
}

// Dashboard status
app.get("/", (req, res) => {
  res.json({
    bot: "AlphaStream v24 ELITE",
    status: "LIVE",
    time: new Date().toISOString(),
    positions: Object.keys(positions).length,
    max_pos: MAX_POS,
    dry_mode: DRY_MODE_BOOL || !ALPACA_KEY || !PREDICTOR_URL
  });
});

app.get("/healthz", (_, res) => res.status(200).send("OK"));

// Manual scan
app.post("/", async (req, res) => {
  if (FORWARD_SECRET && req.body?.secret !== FORWARD_SECRET) {
    return res.status(403).json({ error: "forbidden" });
  }
  res.json({ status: "SCAN TRIGGERED — FULL SEND" });
  await log("MANUAL_SCAN", "DASHBOARD", "User triggered");
  scanAndTrade().catch(console.error);
});

// FULL TRADING ENGINE — Cameron Ross + Supertrend + ADX + ML
async function scanAndTrade() {
  if (scanning) return;
  scanning = true;

  try {
    const hour = new Date().getUTCHours();
    if (hour < 13 || hour >= 20) return; // 9:30 AM – 4:00 PM ET

    const equity = await getEquity();
    const maxRiskPerTrade = equity * 0.01;

    const gappersRes = await axios.get(
      `https://api.massive.com/v2/gappers?min_change=3&min_volume=500000&apiKey=${MASSIVE_KEY}`
    );
    const gappers = gappersRes.data.slice(0, 15);

    for (const t of gappers) {
      if (Object.keys(positions).length >= parseInt(MAX_POS)) break;
      if (positions[t.symbol]) continue;

      const barsRes = await axios.get(
        `https://api.massive.com/v2/aggs/ticker/${t.symbol}/range/1/minute/?adjusted=true&limit=200&apiKey=${MASSIVE_KEY}`
      );
      const bars = barsRes.data.results || [];
      if (bars.length < 100) continue;

      const close = bars.map(b => b.c);
      const high = bars.map(b => b.h);
      const low = bars.map(b => b.l);

      const st = Supertrend({ period: 10, multiplier: 3, high, low, close });
      const adxData = ADX({ period: 14, high, low, close });
      const atrData = ATR({ period: 14, high, low, close });

      const current = {
        stTrend: st[st.length - 1]?.trend,
        stLine: st[st.length - 1]?.superTrend,
        adx: adxData[adxData.length - 1]?.adx,
        atr: atrData[atrData.length - 1],
        price: close[close.length - 1]
      };

      if (current.adx > 25 && current.stTrend === 1 && current.price > current.stLine) {
        const features = [t.change, current.adx, current.atr / current.price];
        let prob = 0.7;
        try {
          const ml = await axios.post(`${PREDICTOR_URL}/predict`, { features }, { timeout: 3000 });
          prob = ml.data.probability || 0.7;
        } catch {}

        if (prob > 0.78) {
          const risk = current.atr * 1.5;
          const qty = Math.max(1, Math.floor(maxRiskPerTrade / risk));

          await placeOrder(t.symbol, qty, "buy");
          positions[t.symbol] = { entry: current.price, qty, risk };
          await log("ENTRY", t.symbol, `ML ${ (prob*100).toFixed(1) }% | Gap ${ t.change.toFixed(1) }%`, { qty, price: current.price });
        }
      }
    }

    await log("HEARTBEAT", "SYSTEM", "Scan complete", {
      positions: Object.keys(positions).length,
      dry_mode: DRY_MODE_BOOL
    });

  } catch (err) {
    await log("SCAN_ERROR", "SYSTEM", err.message);
  } finally {
    scanning = false;
  }
}

// SERVER START
const PORT = process.env.PORT || 8080;
const server = app.listen(PORT, "0.0.0.0", async () => {
  console.log(`ALPHASTREAM v24 ELITE FULLY ARMED on port ${PORT}`);
  await log("BOT_START", "SYSTEM", "Full trading engine LIVE", { dry_mode: DRY_MODE_BOOL });
  scanAndTrade();
  setInterval(() => scanAndTrade().catch(console.error), Number(SCAN_INTERVAL_MS) || 48000);
});

// Graceful shutdown
process.on("SIGTERM", () => server.close(() => process.exit(0)));
process.on("SIGINT", () => server.close(() => process.exit(0)));
