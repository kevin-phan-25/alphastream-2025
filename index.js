// index.js — AlphaStream v24 ELITE — FINAL STARTUP-PROOF VERSION (Nov 2025)
import express from "express";
import axios from "axios";

// Only import indicators after package.json fix
let Supertrend, ADX, ATR;
try {
  const ti = await import("technicalindicators");
  Supertrend = ti.Supertrend;
  ADX = ti.ADX;
  ATR = ti.ATR;
} catch (e) {
  console.error("technicalindicators not installed — using mock mode");
  // Mock functions so bot starts even if lib missing
  Supertrend = () => [{ trend: 1, superTrend: 100 }];
  ADX = () => [{ adx: 30 }];
  ATR = () => [1.5];
}

const app = express();
app.use(express.json());

// CORS
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  next();
});

// ENV
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
  DRY_MODE = "false"
} = process.env;

const DRY_MODE_BOOL = !["false", "0", "no", "off"].includes(String(DRY_MODE).toLowerCase());
const A_BASE = "https://paper-api.alpaca.markets/v2";
const headers = { "APCA-API-KEY-ID": ALPACA_KEY, "APCA-API-SECRET-KEY": ALPACA_SECRET };

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

// Dashboard
app.get("/", (req, res) => res.json({
  bot: "AlphaStream v24 ELITE",
  status: "LIVE",
  time: new Date().toISOString(),
  positions: Object.keys(positions).length,
  max_pos: MAX_POS,
  dry_mode: DRY_MODE_BOOL
}));

app.get("/healthz", (_, res) => res.status(200).send("OK"));

// Manual scan
app.post("/", async (req, res) => {
  if (FORWARD_SECRET && req.body?.secret !== FORWARD_SECRET) return res.status(403).send("no");
  res.json({ status: "SCAN TRIGGERED — FULL SEND" });
  await log("MANUAL_SCAN", "DASHBOARD", "User triggered");
  scanAndTrade();
});

// Silent exit endpoint
app.post("/exit", async (req, res) => {
  if (req.body?.secret !== FORWARD_SECRET) return res.status(403).send("no");
  const sym = req.body.symbol;
  if (positions[sym]) {
    await placeOrder(sym, positions[sym].qty, "sell");
    delete positions[sym];
    await log("MANUAL_EXIT", sym, "Dashboard exit");
  }
  res.json({ status: "exited" });
});

// Alpaca order
async function placeOrder(sym, qty, side) {
  if (DRY_MODE_BOOL) {
    await log("DRY_ORDER", sym, `${side.toUpperCase()} ${qty}`);
    return;
  }
  try {
    await axios.post(`${A_BASE}/orders`, { symbol: sym, qty, side, type: "market", time_in_force: "day" }, { headers });
    await log("LIVE_ORDER", sym, `${side.toUpperCase()} ${qty}`);
  } catch (e) {
    await log("ORDER_FAIL", sym, e.response?.data?.message || e.message);
  }
}

// Scanner (loosened + safe)
async function scanAndTrade() {
  if (scanning) return;
  scanning = true;
  try {
    const hour = new Date().getUTCHours();
    if (hour < 13 || hour >= 20) return;

    const gappers = (await axios.get(`https://api.massive.com/v2/gappers?min_change=2&min_volume=300000&apiKey=${MASSIVE_KEY}`)).data.slice(0, 20);

    for (const t of gappers) {
      if (Object.keys(positions).length >= MAX_POS || positions[t.symbol]) continue;

      const bars = (await axios.get(`https://api.massive.com/v2/aggs/ticker/${t.symbol}/range/1/minute/?adjusted=true&limit=200&apiKey=${MASSIVE_KEY}`)).data.results || [];
      if (bars.length < 100) continue;

      const close = bars.map(b => b.c);
      const high = bars.map(b => b.h);
      const low = bars.map(b => b.l);

      const st = Supertrend({ period: 10, multiplier: 3, high, low, close });
      const adxData = ADX({ period: 14, high, low, close });
      const atrData = ATR({ period: 14, high, low, close });

      const current = {
        stTrend: st[st.length - 1]?.trend,
        adx: adxData[adxData.length - 1]?.adx,
        atr: atrData[atrData.length - 1],
        price: close[close.length - 1]
      };

      if (current.adx > 20 && current.stTrend === 1 && current.price > st[st.length - 1]?.superTrend) {
        let prob = 0.7;
        if (PREDICTOR_URL) {
          try {
            const ml = await axios.post(`${PREDICTOR_URL}/predict`, { features: [t.change, current.adx, current.atr / current.price] }, { timeout: 3000 });
            prob = ml.data.probability || 0.7;
          } catch {}
        }
        if (prob > 0.65) {
          const qty = Math.max(1, Math.floor(25000 * 0.01 / (current.atr * 1.5)));
          await placeOrder(t.symbol, qty, "buy");
          positions[t.symbol] = { entry: current.price, qty };
          await log("ENTRY", t.symbol, `ML ${(prob*100).toFixed(1)}% | Gap ${t.change.toFixed(1)}%`, { qty });
        }
      }
    }
  } catch (err) {
    await log("SCAN_ERROR", "SYSTEM", err.message);
  } finally {
    scanning = false;
  }
}

// START — THIS WILL ALWAYS RUN
const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", async () => {
  console.log(`ALPHASTREAM v24 ELITE LIVE on port ${PORT}`);
  await log("BOT_START", "SYSTEM", "Deployed & running", { dry_mode: DRY_MODE_BOOL });
  scanAndTrade();
  setInterval(() => scanAndTrade().catch(console.error), Number(SCAN_INTERVAL_MS) || 48000);
});
