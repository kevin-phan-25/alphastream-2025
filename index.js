import express from "express";
import cors from "cors";
import axios from "axios";

const { ALPACA_KEY = "", ALPACA_SECRET = "", DRY_MODE = "false", PORT = "8080" } = process.env;
const DRY = String(DRY_MODE).toLowerCase() === "true";
const A_BASE = DRY ? "https://paper-api.alpaca.markets/v2" : "https://api.alpaca.markets/v2";
const HEADERS = { "APCA-API-KEY-ID": ALPACA_KEY, "APCA-API-SECRET-KEY": ALPACA_SECRET };

console.log(`\nAlphaStream v30.0 STARTING`);
console.log(`Mode → ${DRY ? "PAPER" : "LIVE"}`);
console.log(`API → ${A_BASE}\n`);

let accountEquity = 100000;
let positions = [];
let dailyPnL = 0;
let tradeHistory = [];
let lastEquityFetch = null;
let lastScanTime = null;

async function updateEquity() {
  if (!ALPACA_KEY || !ALPACA_SECRET) {
    accountEquity = 100000;
    return;
  }
  try {
    const res = await axios.get(`${A_BASE}/account`, { headers: HEADERS, timeout: 10000 });
    accountEquity = parseFloat(res.data.equity || res.data.cash || 100000);
    lastEquityFetch = new Date().toISOString();

    dailyPnL = (positions.length > 0 && accountEquity > 0)
      ? positions.reduce((acc, p) => acc + ((p.current ?? p.entry) - p.entry) * p.qty, 0) / accountEquity
      : 0;

  } catch (err) {
    console.error("Equity fetch failed:", err?.message || err);
    accountEquity = 100000;
    dailyPnL = 0;
  }
}

async function scanMarket() {
  lastScanTime = new Date().toISOString();
  console.log("Market scan triggered");

  if (positions.length === 0) {
    positions = [{ symbol: "AAPL", qty: 10, entry: 175, current: 177 }];
  }

  tradeHistory = [...tradeHistory, { timestamp: new Date().toISOString(), action: "SCAN", positions: [...positions] }];
}

const app = express();
app.use(cors());
app.use(express.json());

app.get("/healthz", (req, res) => res.status(200).send("OK"));

app.get("/", async (req, res) => {
  await updateEquity();
  res.json({
    bot: "AlphaStream v30.0 — Funding Ready",
    version: "v30.0",
    status: "ONLINE",
    mode: DRY ? "DRY" : "LIVE",
    dry_mode: DRY,
    positions: positions.length,
    max_pos: 5,
    equity: `$${accountEquity.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
    dailyPnL: `${(dailyPnL * 100).toFixed(2)}%`,
    tradeHistoryLast5: tradeHistory.slice(-5),
    lastEquityFetch,
    lastScanTime,
    timestamp: new Date().toISOString()
  });
});

app.post("/manual/scan", async (req, res) => {
  try {
    await scanMarket();
    await updateEquity();
    res.json({ ok: true, positions, equity: accountEquity, lastScanTime });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

const PORT_NUM = parseInt(PORT, 10);
app.listen(PORT_NUM, "0.0.0.0", () => {
  console.log(`AlphaStream v30.0 LIVE ON PORT ${PORT_NUM}`);
  console.log(`Mode: ${DRY ? "DRY" : "LIVE"}`);
  console.log(`Dashboard URL: https://alphastream-dashboard.vercel.app`);
});

setInterval(updateEquity, 30000);
