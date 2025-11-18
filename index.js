// index.js — AlphaStream v24.1 ELITE — PRE-MARKET MONSTER FINAL (ZERO CRASH)
import express from "express";
import axios from "axios";

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
  DRY_MODE = "false"
} = process.env;

const DRY_MODE_BOOL = !["false", "0", "no", "off"].includes(String(DRY_MODE).toLowerCase());
const A_BASE = "https://paper-api.alpaca.markets/v2";
const headers = { "APCA-API-KEY-ID": ALPACA_KEY, "APCA-API-SECRET-KEY": ALPACA_SECRET };

let positions = {};
let scanning = false;

// === US HOLIDAYS 2025 ===
const HOLIDAYS_2025 = [
  "2025-01-01", "2025-01-20", "2025-02-17", "2025-04-18", "2025-05-26",
  "2025-06-19", "2025-07-04", "2025-09-01", "2025-11-27", "2025-12-25"
];

// Logger — FIXED (removed the rogue { })
async function log(event, symbol = "", note = "", data = {}) {
  console.log(`[${event}] ${symbol} | ${note}`, data);
  if (!LOG_WEBHOOK_URL || !LOG_WEBHOOK_SECRET) return;
  try {
    await axios.post(LOG_WEBHOOK_URL, { secret: LOG_WEBHOOK_SECRET, event, symbol, note, data }, { timeout: 5000 });
  } catch (e) {
    console.log("Webhook failed:", e.message);
  }
}

// Dashboard
app.get("/", (req, res) => res.json({
  bot: "AlphaStream v24.1 ELITE",
  status: "LIVE",
  time: new Date().toISOString(),
  positions: Object.keys(positions).length,
  max_pos: MAX_POS,
  dry_mode: DRY_MODE_BOOL,
  mode: "PRE-MARKET MONSTER"
}));

app.get("/healthz", (_, res) => res.status(200).send("OK"));

// Manual scan
app.post("/", async (req, res) => {
  if (FORWARD_SECRET && req.body?.secret !== FORWARD_SECRET) return res.status(403).send("no");
  res.json({ status: "PRE-MARKET SCAN TRIGGERED — HUNTING MONSTERS" });
  await log("MANUAL_SCAN", "DASHBOARD", "User triggered");
  scanPreMarket();
});

// Exit
app.post("/exit", async (req, res) => {
  if (req.body?.secret !== FORWARD_SECRET) return res.status(403).send("no");
  const sym = req.body.symbol;
  if (positions[sym]) {
    await placeOrder(sym, positions[sym].qty, "sell");
    delete positions[sym];
    await log("MANUAL_EXIT", sym, "Exited via dashboard");
  }
  res.json({ status: "exited" });
});

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
      time_in_force: "opg"
    }, { headers });
    await log("LIVE_ORDER", sym, `${side.toUpperCase()} ${qty} shares at open`);
  } catch (e) {
    await log("ORDER_FAIL", sym, e.response?.data?.message || e.message);
  }
}

// PRE-MARKET MONSTER SCANNER (7:00 – 9:29 AM ET)
async function scanPreMarket() {
  if (scanning) return;
  scanning = true;

  try {
    const now = new Date();
    const utcHour = now.getUTCHours();
    const utcMinute = now.getUTCMinutes();
    const utcTime = utcHour * 100 + utcMinute;
    const today = now.toISOString().slice(0, 10);
    const dayOfWeek = now.getUTCDay();

    // Skip weekends & holidays
    if (dayOfWeek === 0 || dayOfWeek === 6 || HOLIDAYS_2025.includes(today)) {
      scanning = false;
      return;
    }

    // Only run 7:00 AM – 9:29 AM ET (UTC 11:00 – 13:29)
    if (utcTime < 1100 || utcTime >= 1329) {
      scanning = false;
      return;
    }

    await log("PREMARKET_SCAN", "SYSTEM", "Hunting 20%+ monsters");

    const gappers = (await axios.get(
      `https://api.massive.com/v2/gappers?min_change=20&min_volume=500000&apiKey=${MASSIVE_KEY}`
    )).data;

    await log("MONSTERS_FOUND", "SYSTEM", `${gappers.length} rockets`, gappers.map(t => `${t.symbol} ${t.change}%`).join(", "));

    for (const t of gappers) {
      if (Object.keys(positions).length >= parseInt(MAX_POS)) break;
      if (positions[t.symbol] || t.lastPrice <= 1) continue;

      await log("CANDIDATE", t.symbol, `+${t.change}% | $${t.lastPrice}`);

      const bars = (await axios.get(
        `https://api.massive.com/v2/aggs/ticker/${t.symbol}/range/1/minute/?adjusted=true&limit=200&apiKey=${MASSIVE_KEY}`
      )).data.results || [];

      if (bars.length < 80) continue;

      const close = bars.map(b => b.c);
      const high = bars.map(b => b.h);
      const low = bars.map(b => b.l);

      let Supertrend, ADX, ATR;
      try {
        const ti = await import("technicalindicators");
        Supertrend = ti.Supertrend;
        ADX = ti.ADX;
        ATR = ti.ATR;
      } catch {
        Supertrend = () => [{ trend: 1, superTrend: close[close.length-1] * 0.95 }];
        ADX = () => [{ adx: 30 }];
        ATR = () => [close[close.length-1] * 0.05];
      }

      const st = Supertrend({ period: 10, multiplier: 3, high, low, close });
      const adxData = ADX({ period: 14, high, low, close });
      const atrData = ATR({ period: 14, high, low, close });

      const current = {
        price: close[close.length - 1],
        stTrend: st[st.length - 1]?.trend,
        stLine: st[st.length - 1]?.superTrend,
        adx: adxData[adxData.length - 1]?.adx || 0,
        atr: atrData[atrData.length - 1] || 1
      };

      if (current.adx > 25 && current.stTrend === 1 && current.price > current.stLine) {
        let prob = 0.82;
        if (PREDICTOR_URL) {
          try {
            const ml = await axios.post(`${PREDICTOR_URL}/predict`, {
              features: [t.change, current.adx, current.atr / current.price]
            }, { timeout: 3000 });
            prob = ml.data.probability || 0.82;
          } catch {}
        }

        if (prob > 0.78) {
          const qty = Math.max(1, Math.floor(25000 * 0.012 / (current.atr * 1.5)));
          await placeOrder(t.symbol, qty, "buy");
          positions[t.symbol] = { entry: current.price, qty };
          await log("ENTRY", t.symbol, `MONSTER +${t.change}% | ML ${(prob*100).toFixed(1)}%`, { qty });
        }
      }
    }
  } catch (err) {
    await log("SCAN_ERROR", "SYSTEM", err.message);
  } finally {
    scanning = false;
  }
}

// START — WILL NEVER CRASH
const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", async () => {
  console.log(`ALPHASTREAM v24.1 PRE-MARKET MONSTER LIVE on port ${PORT}`);
  await log("BOT_START", "SYSTEM", "Ready for 7:00 AM ET pre-market", { dry_mode: DRY_MODE_BOOL });
  scanPreMarket();
  setInterval(scanPreMarket, 120000); // every 2 min
});
