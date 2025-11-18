```js
// index.js — AlphaStream v24.1 ELITE — PRE-MARKET MONSTER EDITION (Nov 2025)
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

// === US TRADING HOLIDAYS 2025 (NYSE) ===
const HOLIDAYS_2025 = [
  "2025-01-01", // New Year's Day
  "2025-01-20", // MLK Day
  "2025-02-17", // Presidents' Day
  "2025-04-18", // Good Friday
  "2025-05-26", // Memorial Day
  "2025-06-19", // Juneteenth
  "2025-07-04", // Independence Day
  "2025-09-01", // Labor Day
  "2025-11-27", // Thanksgiving
  "2025-12-25"  // Christmas
];

// Logger
async function log(event, symbol = "", note = "", data = {}) {
  const msg = `[${event}] ${symbol} | ${note}`;
  console.log(msg, data);
  if (!LOG_WEBHOOK_URL || !LOG_WEBHOOK_SECRET) return;
  try {
    { await axios.post(LOG_WEBHOOK_URL, { secret: LOG_WEBHOOK_SECRET, event, symbol, note, data }, { timeout: 5000 }); }
  catch   {}
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

// Manual scan (anytime)
app.post("/", async (req, res) => {
  if (FORWARD_SECRET && req.body?.secret !== FORWARD_SECRET) return res.status(403).send("no");
  res.json({ status: "PRE-MARKET SCAN TRIGGERED — HUNTING MONSTERS" });
  await log("MANUAL_SCAN", "DASHBOARD", "User triggered pre-market scan");
  scanPreMarket();
});

// Exit endpoint
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
      time_in_force: "opg" // Use OPG for pre-market entries at 9:30 open
    }, { headers });
    await log("LIVE_ORDER", sym, `${side.toUpperCase()} ${qty} shares at open`);
  } catch (e) {
    await log("ORDER_FAIL", sym, e.response?.data?.message || e.message);
  }
}

// === PRE-MARKET MONSTER SCANNER (7:00 – 9:29 AM ET) ===
async function scanPreMarket() {
  if (scanning) return;
  scanning = true;

  try {
    const now = new Date();
    const utcHour = now.getUTCHours();
    const utcMinute = now.getUTCMinutes();
    const today = now.toISOString().slice(0, 10); // YYYY-MM-DD
    const dayOfWeek = now.getUTCDay(); // 0=Sun, 6=Sat

    // Skip weekends
    if (dayOfWeek === 0 || dayOfWeek === 6) {
      await log("SKIP_WEEKEND", "SYSTEM", "No trading on weekends");
      scanning = false;
      return;
    }

    // Skip holidays
    if (HOLIDAYS_2025.includes(today)) {
      await log("SKIP_HOLIDAY", "SYSTEM", `Holiday: ${today}`);
      scanning = false;
      return;
    }

    // Only run 7:00 AM – 9:29 AM ET (UTC 11:00 – 13:29)
    const utcTime = utcHour * 100 + utcMinute;
    if (utcTime < 1100 || utcTime >= 1329) {
      // await log("OUTSIDE_PRE_MARKET", "SYSTEM", `Current UTC time: ${utcHour}:${utcMinute.toString().padStart(2,'0')}`);
      scanning = false;
      return;
    }

    await log("PREMARKET_SCAN", "SYSTEM", "HUNTING 20%+ MONSTERS", { timeET: `${utcHour-4}:${utcMinute.toString().padStart(2,'0')} AM` });

    const gappersRes = await axios.get(
      `https://api.massive.com/v2/gappers?min_change=20&min_volume=500000&apiKey=${MASSIVE_KEY}`
    );
    const gappers = gappersRes.data;

    await log("MONSTERS_FOUND", "SYSTEM", `${gappers.length} rockets detected`, {
      list: gappers.map(t => `${t.symbol} ${t.change.toFixed(1)}%`).join(", ") || "none"
    });

    for (const t of gappers) {
      if (Object.keys(positions).length >= parseInt(MAX_POS)) break;
      if (positions[t.symbol]) continue;
      if (t.lastPrice <= 1) continue; // price filter

      await log("ROCKET", t.symbol, `+${t.change.toFixed(1)}% | $${t.lastPrice} | Vol ${(t.volume/1000000).toFixed(1)}M`);

      // Get minute bars for indicators
      let bars = [];
      try {
        const res = await axios.get(
          `https://api.massive.com/v2/aggs/ticker/${t.symbol}/range/1/minute/?adjusted=true&limit=200&apiKey=${MASSIVE_KEY}`
        );
        bars = res.data.results || [];
      } catch {}

      if (bars.length < 80) continue;

      const close = bars.map(b => b.c);
      const high = bars.map(b => b.h);
      const low = bars.map(b => b.l);

      // Dynamic import technicalindicators safely
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
          const qty = Math.max(1, Math.floor(25000 * 0.012 / (current.atr * 1.5))); // 1.2% risk
          await placeOrder(t.symbol, qty, "buy");
          positions[t.symbol] = { entry: current.price, qty, gap: t.change };
          await log("ENTRY", t.symbol, `MONSTER GAP +${t.change.toFixed(1)}% | ML ${(prob*100).toFixed(1)}%`, {
            qty,
            price: current.price.toFixed(2),
            risk: (current.atr * 1.5 * qty).toFixed(0)
          });
        }
      }
    }

  } catch (err) {
    await log("SCAN_ERROR", "SYSTEM", err.message);
  } finally {
    scanning = false;
  }
}

// START SERVER
const PORT = process.env.PORT || 8080;
const server = app.listen(PORT, "0.0.0.0", async () => {
  console.log(`ALPHASTREAM v24.1 PRE-MARKET MONSTER LIVE on port ${PORT}`);
  await log("BOT_START", "SYSTEM", "Pre-market monster scanner armed", { dry_mode: DRY_MODE_BOOL });

  // Start scanning immediately and every 2 minutes during pre-market
  scanPreMarket();
  setInterval(scanPreMarket, 120000); // every 2 minutes
});

// Graceful shutdown
process.on("SIGTERM", () => server.close(() => process.exit(0)));
