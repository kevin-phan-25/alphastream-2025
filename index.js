// index.js — AlphaStream v96.0 — PURE NASDAQ + YAHOO LOW-FLOAT (NO API KEYS EVER)
        }, { headers: HEADERS }).catch(() => {});
        fs.appendFileSync("trades.csv", `${new Date().toISOString()},EXIT,${pos.symbol},${pos.qty},${current},${pnlPct.toFixed(1)}%\n`);
        positions = positions.filter(p => p.symbol !== pos.symbol);
      }
    }
  } catch {}
}

// MAIN LOOP
async function scanAndTrade() {
  await managePositions();
  await runBacktest();
  const rockets = await scrapeRockets();

  for (const r of rockets) {
    if (positions.find(p => p.symbol === r.symbol)) continue;

    const qty = Math.max(1, Math.floor(accountEquity * 0.04 / r.price));
    if (!IS_PAPER && ALPACA_KEY) {
      await axios.post(`${BASE_URL}/orders`, {
        symbol: r.symbol, qty, side: "buy", type: "market", time_in_force: "opg"
      }, { headers: HEADERS }).catch(() => {});
    }

    positions.push({ symbol: r.symbol, qty, entry: r.price, current: r.price, peakPrice: r.price });
    fs.appendFileSync("trades.csv", `${new Date().toISOString()},ENTRY,${r.symbol},${qty},${r.price},${r.change.toFixed(1)}%,${(r.float/1e6).toFixed(1)}M float\n`);
  }

  lastRockets = rockets.map(r => `${r.symbol}+${r.change.toFixed(1)}% (${(r.float/1e6).toFixed(1)}M)`);
}

// ENDPOINTS
app.get("/", async (req, res) => {
  await scanAndTrade();
  const unreal = positions.reduce((s, p) => s + (p.current - p.entry) * p.qty, 0);
  res.json({
    bot: "AlphaStream v96.0 — NASDAQ + YAHOO FLOAT",
    mode: IS_PAPER ? "PAPER" : "LIVE",
    equity: `$${accountEquity.toFixed(0)}`,// index.js — AlphaStream v93.0 — LOW-FLOAT ROCKETS + BACKTESTING
import express from "express";
import cors from "cors";
import axios from "axios";
import fs from "fs-extra";

const app = express();
app.use(cors());
app.use(express.json());

const {
  ALPACA_KEY = "",
  ALPACA_SECRET = "",
  PAPER = "true"
} = process.env;

const IS_PAPER = PAPER === "true" || !ALPACA_KEY;
const BASE_URL = IS_PAPER
  ? "https://paper-api.alpaca.markets/v2"
  : "https://api.alpaca.markets/v2";

const HEADERS = { "APCA-API-KEY-ID": ALPACA_KEY, "APCA-API-SECRET-KEY": ALPACA_SECRET };

let accountEquity = 100000;
let positions = [];
let tradesHistory = []; // For backtesting stats
let lastRockets = [];

// === LOW-FLOAT CACHE (updated daily) ===
let floatCache = {}; // symbol → float_in_millions
let lastFloatUpdate = null;

async function updateFloatCache() {
  const today = new Date().toISOString().split("T")[0];
  if (lastFloatUpdate === today) return;


    unrealized: unreal > 0 ? `+$${unreal.toFixed(0)}` : `$${unreal.toFixed(0)}`,
    positions: positions.length,
    rockets: lastRockets,
    backtest: backtestResults
  });
});

app.post("/scan", async (req, res) => {
  await scanAndTrade();
  res.json({ ok: true, time: new Date().toISOString() });
});

app.get("/healthz", (_, res) => res.send("OK"));

app.listen(8080, "0.0.0.0", () => {
  console.log("\nALPHASTREAM v96.0 — ZERO-API-KEY LOW-FLOAT ROCKET HUNTER LIVE");
  scanAndTrade();
  setInterval(scanAndTrade, 180000); // every 3 min
});
