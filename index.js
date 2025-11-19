// index.js — AlphaStream v35.0 — Fully Autonomous + Online ML + Supertrend + Backtest
// Node 18+ recommended. Drop into repo root and `npm install` dependencies listed below.

import express from "express";
import fs from "fs";
import path from "path";
import axios from "axios";
import * as ti from "technicalindicators";
import Predictor from "./predictor/predictor.js";

const {
  ALPACA_KEY = "",
  ALPACA_SECRET = "",
  MASSIVE_KEY = "",
  DRY_MODE = "true",      // default to DRY for safety
  PREDICTOR_LEARN = "true",
  PORT = "8080",
  MAX_POS = "3",
  LOG_WEBHOOK_URL = ""
} = process.env;

const DRY = String(DRY_MODE).toLowerCase() === "true";
const IS_PAPER = DRY || (ALPACA_KEY && ALPACA_KEY.startsWith("PK"));
const A_BASE = IS_PAPER ? "https://paper-api.alpaca.markets/v2" : "https://api.alpaca.markets/v2";
const M_BASE = "https://api.polygon.io"; // will use Massive if you prefer; keep flexible
const HEADERS = { "APCA-API-KEY-ID": ALPACA_KEY, "APCA-API-SECRET-KEY": ALPACA_SECRET };

const STATE_FILE = path.join(process.cwd(), "state.json");
const PREDICTOR_PATH = path.join(process.cwd(), "predictor", "model.json");

const app = express();
app.use(express.json());

// ----------------------- Utilities -----------------------
function nowTs(){ return new Date().toISOString(); }
function saveState(state){
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); } catch(e){ console.warn("SAVE_STATE_FAIL", e?.message || e); }
}
function loadState(){
  try {
    if (fs.existsSync(STATE_FILE)) return JSON.parse(fs.readFileSync(STATE_FILE,"utf8"));
  } catch(e){ console.warn("LOAD_STATE_FAIL", e?.message || e); }
  return null;
}
async function webhookLog(msg){
  if (!LOG_WEBHOOK_URL) return;
  try { await axios.post(LOG_WEBHOOK_URL, { text: msg }, { timeout: 3000 }); } catch(e) {}
}

// ----------------------- Bot state & persistence -----------------------
const defaultState = {
  accountEquity: 100000,
  positions: {},       // symbol -> {entry, qty, stop, peak, atr, took2R, openAt}
  tradeHistory: [],    // {symbol, entry, exit, pnl, pnlPct, ts}
  logs: [],
  backtest: { trades: 0, wins: 0, losses: 0, totalPnL: 0 }
};

let STATE = loadState() || defaultState;
saveState(STATE); // ensure file exists

// instantiate predictor (online learner)
const predictor = new Predictor({ modelPath: PREDICTOR_PATH, learn: String(PREDICTOR_LEARN).toLowerCase() === "true" });

// ----------------------- Market helpers -----------------------
async function fetchMinuteBarsMassive(symbol, fromDays=7, limit=600) {
  // This uses Polygon/Massive-style endpoint — replace base or key as needed.
  // We added exponential backoff and caching to be gentle on rate-limits.
  const cacheKey = `bars:${symbol}:${limit}`;
  // simple file cache (in-memory would be fine but keep persistent for brevity)
  if (!global._cache) global._cache = {};
  const cached = global._cache[cacheKey];
  if (cached && (Date.now() - cached.ts) < 5000) return cached.val;

  const to = new Date().toISOString().slice(0,10);
  const from = new Date(Date.now() - (fromDays*24*60*60*1000)).toISOString().slice(0,10);
  const url = `${M_BASE}/v2/aggs/ticker/${symbol}/range/1/minute/${from}/${to}?limit=${limit}&apiKey=${MASSIVE_KEY}`;
  let backoff = 500;
  while (true) {
    try {
      const res = await axios.get(url, { timeout: 10000 });
      const bars = res.data?.results || [];
      global._cache[cacheKey] = { ts: Date.now(), val: bars };
      return bars;
    } catch (e) {
      const code = e?.response?.status;
      if (code === 429) { await new Promise(r => setTimeout(r, backoff)); backoff = Math.min(backoff*2, 8000); continue; }
      console.warn("BARS_FAIL", symbol, e?.message || e);
      return [];
    }
  }
}

function aggregateBars(minuteBars, period) {
  if (!minuteBars || minuteBars.length < period) return [];
  const out = [];
  // ensure chronological order (old -> new)
  const bars = Array.from(minuteBars);
  for (let i = 0; i + period <= bars.length; i += period) {
    const slice = bars.slice(i, i+period);
    const o = slice[0].o, c = slice[slice.length-1].c;
    const h = Math.max(...slice.map(x=>x.h));
    const l = Math.min(...slice.map(x=>x.l));
    const v = slice.reduce((s,x)=>s+(x.v||0), 0);
    out.push({ o, h, l, c, v, t: slice[slice.length-1].t });
  }
  return out;
}

function computeVWAP(minuteBars) {
  if (!minuteBars || minuteBars.length === 0) return null;
  let cumPV = 0, cumV = 0;
  for (const b of minuteBars) {
    const tp = (b.h + b.l + b.c) / 3;
    cumPV += tp * (b.v || 0);
    cumV += (b.v || 0);
  }
  return cumV === 0 ? null : cumPV / cumV;
}

// ----------------------- Strategy / Entry evaluation -----------------------
async function evaluateSymbol(symbol) {
  // fetch minute bars (fast)
  const minuteBars = await fetchMinuteBarsMassive(symbol, 3, 600);
  if (!minuteBars || minuteBars.length < 120) return null;

  // compute confirm (5-min) and trend (15-min)
  const confirm = aggregateBars(minuteBars.slice(-300), 5);
  const trend = aggregateBars(minuteBars.slice(-600), 15);
  if (confirm.length < 20 || trend.length < 30) return null;

  const closesConfirm = confirm.map(b=>b.c);
  const highConfirm = confirm.map(b=>b.h);
  const lowConfirm = confirm.map(b=>b.l);

  // EMA's
  const ema9 = ti.EMA.calculate({ period: 9, values: closesConfirm });
  const ema21 = ti.EMA.calculate({ period: 21, values: closesConfirm });
  const ema200 = ti.EMA.calculate({ period: 200, values: trend.map(b=>b.c) });

  if (!ema9.length || !ema21.length || !ema200.length) return null;

  const lastPrice = closesConfirm[closesConfirm.length-1];
  const st = ti.Supertrend({ period: 10, multiplier: 3, high: highConfirm, low: lowConfirm, close: closesConfirm });
  const adxArr = ti.ADX({ period: 14, high: highConfirm, low: lowConfirm, close: closesConfirm });
  const atrArr = ti.ATR({ period: 14, high: highConfirm, low: lowConfirm, close: closesConfirm });

  const lastEma9 = ema9[ema9.length-1];
  const lastEma21 = ema21[ema21.length-1];
  const lastEma200 = ema200[ema200.length-1];

  // filters — VWAP, EMA stacking, ADX
  const vwap = computeVWAP(minuteBars.slice(-60));
  if (!vwap || lastPrice <= vwap) return null;
  const adx = adxArr.length ? adxArr[adxArr.length-1].adx : 0;
  if (adx < 18) return null;
  if (!(lastEma9 > lastEma21 && lastEma21 > lastEma200)) return null; // pro stack

  const atr = atrArr.length ? atrArr[atrArr.length-1] : Math.max(...highConfirm) - Math.min(...lowConfirm);
  const trendDirection = st.length ? st[st.length-1].trend : 1;
  if (trendDirection !== 1) return null;

  // create feature vector for predictor
  const features = {
    symbol,
    price: lastPrice,
    vwap,
    vwapDistPct: (lastPrice - vwap)/vwap,
    adx,
    atr,
    ema9: lastEma9,
    ema21: lastEma21,
    ema200: lastEma200,
    slope9pct: (lastEma9 - ema9[Math.max(0, ema9.length-6)]) / (ema9[Math.max(0, ema9.length-6)] || lastEma9)
  };

  // let predictor score decide
  const score = predictor.predictScore(features);
  return { symbol, features, score };
}

// ----------------------- Position sizing / orders -----------------------
function computeQty(entry, atr) {
  const baseRisk = 0.0075; // 0.75% default
  const riskAmt = (STATE.accountEquity || 100000) * baseRisk;
  const stopDist = Math.max(atr*2, Math.max(0.01, entry*0.01));
  const qty = Math.max(1, Math.floor(riskAmt / stopDist));
  // cap to 25% of equity
  const maxByCap = Math.max(1, Math.floor((STATE.accountEquity || 100000) * 0.25 / Math.max(entry,1)));
  return Math.min(qty, maxByCap);
}

async function placeOrder(symbol, qty, side="buy"){
  if (DRY) {
    // faked fill price = current price from evaluateSymbol or predictor
    STATE.logs.unshift({ ts: nowTs(), lvl: "INFO", msg:`DRY ${side} ${qty} ${symbol}` });
    saveState(STATE);
    return { dry: true };
  }
  try {
    const res = await axios.post(`${A_BASE}/orders`, {
      symbol, qty, side, type: "market", time_in_force: "day", extended_hours: false
    }, { headers: HEADERS, timeout: 10000 });
    STATE.logs.unshift({ ts: nowTs(), lvl: "INFO", msg:`ORDER ${side} ${qty} ${symbol} => ${res.data?.id || "no-id"}` });
    saveState(STATE);
    return res.data;
  } catch(e){
    STATE.logs.unshift({ ts: nowTs(), lvl: "ERROR", msg:`ORDER_FAIL ${symbol} ${e?.message||e}` });
    saveState(STATE);
    return null;
  }
}

// ----------------------- Monitor + Trailing + Partial -----------------------
async function monitorPositions(){
  const syms = Object.keys(STATE.positions);
  for (const s of syms) {
    try {
      const pos = STATE.positions[s];
      const quote = await axios.get(`${A_BASE}/stocks/${s}/quote`, { headers: HEADERS, timeout: 5000 }).catch(()=>null);
      const bid = quote?.data?.quote?.bp || pos.entry;
      if (bid > pos.peak) pos.peak = bid;
      const newTrail = pos.peak - pos.atr * 1.5;
      if (newTrail > pos.trailStop) pos.trailStop = newTrail;

      // 2R partial
      const twoR = pos.entry + 2*(pos.entry - pos.stop);
      if (!pos.took2R && bid >= twoR) {
        const half = Math.floor(pos.qty*0.5);
        if (half>0) {
          await placeOrder(s, half, "sell");
          pos.qty -= half;
          pos.took2R = true;
          STATE.logs.unshift({ ts: nowTs(), lvl: "INFO", msg:`PARTIAL_2R ${s} sold ${half}`});
        }
      }

      // trail hit
      if (bid <= pos.trailStop) {
        await placeOrder(s, pos.qty, "sell");
        const pnl = (bid - pos.entry) * (pos.qty);
        const pnlPct = ((bid - pos.entry) / pos.entry) * 100;
        STATE.tradeHistory.push({ symbol: s, entry: pos.entry, exit: bid, pnl, pnlPct, ts: nowTs() });
        // update backtest stats
        STATE.backtest.trades++;
        STATE.backtest.totalPnL += pnl;
        (pnl>0) ? STATE.backtest.wins++ : STATE.backtest.losses++;
        delete STATE.positions[s];
        STATE.logs.unshift({ ts: nowTs(), lvl: "INFO", msg:`TRAIL_EXIT ${s} at ${bid} pnl ${pnl}`});
      }

    } catch(e){
      STATE.logs.unshift({ ts: nowTs(), lvl:"ERROR", msg: `MONITOR_ERR ${s} ${e?.message||e}` });
    }
  }
  saveState(STATE);
}

// ----------------------- Scan + Entry loop -----------------------
let scanning = false;
async function scanAndEnter(){
  if (scanning) return;
  scanning = true;
  try {
    // targets: prefer large-cap ETFs + top momentum tickers found by Massive (or user-specified)
    const targets = (process.env.TARGET_SYMBOLS || "SPY,QQQ,NVDA,TQQQ").split(",").map(s=>s.trim().toUpperCase());
    // refresh equity every scan
    if (ALPACA_KEY && ALPACA_SECRET) {
      try {
        const acc = await axios.get(`${A_BASE}/account`, { headers: HEADERS, timeout: 8000 });
        STATE.accountEquity = Number(acc.data.equity || acc.data.cash || STATE.accountEquity);
      } catch(e){}
    }

    for (const sym of targets) {
      // skip if too many positions
      if (Object.keys(STATE.positions).length >= Number(MAX_POS)) break;

      const evalRes = await evaluateSymbol(sym);
      if (!evalRes) continue;
      // require strong score
      if (evalRes.score < 0.62) continue;

      const qty = computeQty(evalRes.features.price, evalRes.features.atr);
      if (qty <= 0) continue;

      const stop = evalRes.features.price - evalRes.features.atr * 2;
      // place order
      const ord = await placeOrder(sym, qty, "buy");
      // create internal position record (if dry, ord may be {dry:true})
      STATE.positions[sym] = { entry: evalRes.features.price, qty, stop, trailStop: stop, peak: evalRes.features.price, atr: evalRes.features.atr, took2R: false, openAt: nowTs() };
      STATE.logs.unshift({ ts: nowTs(), lvl: "INFO", msg:`ENTRY ${sym} entry ${evalRes.features.price} qty ${qty} stop ${stop}`});

      // instruct predictor to learn as positive prior if desired (semi-supervised)
      predictor.onNewEntry(evalRes.features);

      saveState(STATE);
      // small pause between orders to be gentle
      await new Promise(r=>setTimeout(r, 250));
    }

  } catch(e) {
    STATE.logs.unshift({ ts: nowTs(), lvl:"ERROR", msg:`SCAN_ERR ${e?.message||e}` });
  } finally {
    scanning = false;
    saveState(STATE);
  }
}

// ----------------------- Learning from outcomes -----------------------
function learnFromTrade(tradeRecord){
  // tradeRecord: {symbol, entry, exit, pnl, pnlPct, ts}
  if (!predictor.learnMode) return;
  // create features based on what was stored when we entered
  // (predictor currently stores the latest features when onNewEntry was called)
  predictor.onTradeOutcome(tradeRecord);
  predictor.saveModel(); // persist often
}

// ----------------------- HTTP Endpoints -----------------------
app.get("/healthz", (_,res)=>res.status(200).send("OK"));

app.get("/", async (_, res) => {
  // refresh account equity if available
  if (ALPACA_KEY && ALPACA_SECRET) {
    try {
      const acc = await axios.get(`${A_BASE}/account`, { headers: HEADERS, timeout: 8000 });
      STATE.accountEquity = Number(acc.data.equity || acc.data.cash || STATE.accountEquity);
    } catch(e){}
  }
  // compute simple metrics
  const unrealized = Object.values(STATE.positions).reduce((s,p)=> s + ((p.peak || p.entry) - p.entry) * p.qty, 0);
  const winRate = STATE.backtest.trades ? (STATE.backtest.wins / STATE.backtest.trades) : 0;
  res.json({
    bot: "AlphaStream v35.0 — Autonomous",
    version: "v35.0",
    mode: DRY ? "DRY" : "LIVE",
    accountEquity: STATE.accountEquity,
    positions: STATE.positions,
    tradeHistory: STATE.tradeHistory.slice(-50),
    backtest: STATE.backtest,
    unrealized,
    winRate,
    logs: STATE.logs.slice(0,50),
    timestamp: nowTs()
  });
});

// manual endpoints for dashboard control
app.post("/manual/scan", async (req,res)=>{
  scanAndEnter().catch(e=>console.warn(e));
  res.json({ ok:true, ts: nowTs() });
});
app.post("/manual/close", async (req,res)=>{
  // close all positions (dry-mode will just record)
  const syms = Object.keys(STATE.positions);
  for (const s of syms) {
    const p = STATE.positions[s];
    // record exit
    const exitPrice = p.peak || p.entry;
    STATE.tradeHistory.push({ symbol: s, entry: p.entry, exit: exitPrice, pnl: (exitPrice - p.entry)*p.qty, pnlPct: ((exitPrice - p.entry)/p.entry)*100, ts: nowTs() });
    learnFromTrade(STATE.tradeHistory[STATE.tradeHistory.length-1]);
    delete STATE.positions[s];
  }
  saveState(STATE);
  res.json({ ok:true });
});

// model management
app.get("/model", (_,res)=>{
  res.json({ version: predictor.versionInfo(), meta: predictor.metaSummary() });
});
app.post("/model/export", (_,res)=>{
  predictor.saveModel();
  res.download(PREDICTOR_PATH);
});

// ----------------------- Scheduler -----------------------
setInterval(async ()=>{
  try { await scanAndEnter(); await monitorPositions(); } catch(e){ console.warn("loop err", e); }
}, 30*1000); // scan + monitor every 30s

// persist state every 20s
setInterval(()=>saveState(STATE), 20*1000);

// start server
const PORT_NUM = parseInt(PORT||"8080",10);
app.listen(PORT_NUM, "0.0.0.0", ()=>{
  console.log(`AlphaStream v35.0 listening ${PORT_NUM} | DRY=${DRY}`);
  webhookLog(`AlphaStream v35.0 started (${DRY ? "DRY" : "LIVE"})`);
});
