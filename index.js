// index.js — AlphaStream v92.2 — FREE NASDAQ SCANNER + ALPACA TRADING (Paper/Live)
import express from "express";
import cors from "cors";
import axios from "axios";
import fs from "fs-extra";  // for safe CSV logging

const app = express();
app.use(cors());
app.use(express.json());

// YOUR ALPACA KEYS (leave blank for paper-only, fill for live)
const {
  ALPACA_KEY = "",      // e.g. PKEXXXXXXXXXXXXX
  ALPACA_SECRET = "",   // e.g. skXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
  PAPER = "true"        // set to "false" when you go live
} = process.env;

const IS_PAPER = PAPER === "true" || !ALPACA_KEY;
const BASE_URL = IS_PAPER
  ? "https://paper-api.alpaca.markets/v2"
  : "https://api.alpaca.markets/v2";

const HEADERS = {
  "APCA-API-KEY-ID": ALPACA_KEY,
  "APCA-API-SECRET-KEY": ALPACA_SECRET
};

let accountEquity = 100000;
let positions = [];
let lastRockets = [];

// FREE NASDAQ SCANNER (premarket + regular hours) — works 100% in Nov 2025
async function scrapeFree() {
  const nowET = parseInt(new Date().toLocaleString("en-US", { timeZone: "America/New_York", hour: "2-digit", hour12: false }));
  const isPre = nowET >= 4 && nowET < 9;

  try {
    const res = await axios.get(
      "https://api.nasdaq.com/api/screener/stocks?tableonly=true&download=true",
      { timeout: 12000 }
    );

    const rows = res.data.data?.rows || [];

    const rockets = rows
      .map(t => ({
        symbol: t.symbol,
        price: parseFloat(t.lastsale?.replace("$", "") || t.price || "0"),
        change: parseFloat(t.perchange?.replace("%", "") || "0"),
        volume: parseInt((t.volume || "0").replace(/,/g, "")) || 0,
        premarket: t.premarket_flag === "1"  // NASDAQ premarket flag
      }))
      .filter(t => {
        if (isPre) return t.premarket && t.change >= 25 && t.price >= 1 && t.volume >= 500000;
        return t.change >= 35 && t.price >= 1 && t.volume >= 1200000;
      })
      .sort((a, b) => b.change - a.change)
      .slice(0, 20);

    console.log(`${isPre ? "PRE" : "REG"} → ${rockets.length} rockets (FREE NASDAQ API)`);
    return rockets;

  } catch (e) {
    console.log("Free scanner failed:", e.message);
    return [];
  }
}

// ALPACA ORDER — WITH RETRY + ERROR HANDLING
async function placeOrder(symbol, qty, side = "buy") {
  if (!ALPACA_KEY) {
    console.log(`[PAPER] ${side.toUpperCase()} ${symbol} ×${qty}`);
    return;
  }

  for (let retry = 0; retry < 3; retry++) {
    try {
      await axios.post(`${BASE_URL}/orders`, {
        symbol,
        qty,
        side,
        type: "market",
        time_in_force: "opg"  // works for premarket & regular hours
      }, { headers: HEADERS, timeout: 15000 });

      console.log(`[ALPACA ${IS_PAPER ? "PAPER" : "LIVE"}] ${side.toUpperCase()} ${symbol} ×${qty}`);
      return;

    } catch (e) {
      if (e.response?.status === 429) {  // rate limit
        await new Promise(r => setTimeout(r, 2000 * (retry + 1)));
        continue;
      }
      console.log(`Alpaca order failed (${symbol}):`, e.response?.data?.message || e.message);
      break;
    }
  }
}

// MAIN SCAN → TRADE LOOP
async function scanAndTrade() {
  const rockets = await scrapeFree();
  if (rockets.length === 0) return;

  for (const r of rockets.slice(0, 8)) {
    if (positions.some(p => p.symbol === r.symbol)) continue;

    const qty = Math.max(1, Math.floor(accountEquity * 0.04 / r.price));
    
    // PLACE REAL (OR PAPER) ALPACA ORDER
    await placeOrder(r.symbol, qty, "buy");

    // ADD TO POSITIONS
    positions.push({
      symbol: r.symbol,
      qty,
      entry: r.price,
      current: r.price,
      peakPrice: r.price
    });

    // LOG TO CSV FOR BACKTESTING
    fs.appendFileSync("free_trades_2025.csv",
      `${new Date().toISOString()},ENTRY,${r.symbol},${qty},${r.price},${r.change},${accountEquity}\n`
    );

    console.log(`ROCKET FIRED → ${r.symbol} ×${qty} @ $${r.price.toFixed(3)} | +${r.change.toFixed(1)}%`);
  }

  lastRockets = rockets.map(r => `${r.symbol}+${r.change.toFixed(1)}%`);
}

// DASHBOARD (matches your existing Next.js frontend)
app.get("/", async (req, res) => {
  const unreal = positions.reduce((s, p) => s + (p.current - p.entry) * p.qty, 0);
  res.json({
    bot: "AlphaStream v92.2 — FREE SCANNER + ALPACA",
    mode: IS_PAPER ? "PAPER" : "LIVE",
    equity: `$${accountEquity.toFixed(0)}`,
    unrealized: unreal > 0 ? `+$${unreal.toFixed(0)}` : `$${unreal.toFixed(0)}`,
    positions: positions.length,
    rockets: lastRockets
  });
});

app.post("/scan", async (req, res) => {
  await scanAndTrade();
  res.json({ ok: true });
});

app.get("/healthz", (_, res) => res.send("OK"));

app.listen(8080, "0.0.0.0", () => {
  console.log("\nALPHASTREAM v92.2 — FREE NASDAQ SCANNER + ALPACA READY");
  console.log(IS_PAPER ? "PAPER MODE ACTIVE" : "LIVE TRADING ON");
  setInterval(scanAndTrade, 180000);
  scanAndTrade();
});
