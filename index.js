// index.js — AlphaStream v23.1 Cloud Run service
import express from "express";
import axios from "axios";

const app = express();
app.use(express.json());

// Env vars
const A_KEY = process.env.ALPACA_KEY;
const A_SEC = process.env.ALPACA_SECRET;
const MASSIVE_KEY = process.env.MASSIVE_KEY;
const LOG_WEBHOOK_URL = process.env.LOG_WEBHOOK_URL;
const LOG_WEBHOOK_SECRET = process.env.LOG_WEBHOOK_SECRET || '';
const FORWARD_SECRET = process.env.FORWARD_SECRET || '';
const MAX_POS = parseInt(process.env.MAX_POS || "2", 10);
const SCAN_INTERVAL_MS = parseInt(process.env.SCAN_INTERVAL_MS || "20000", 10);

// In-memory positions & cache
let positions = {}; // symbol -> { entry, qty, trailPrice, partialDone }
let barCache = {};  // symbol -> { bars, lastFetch }

// Logger
async function logToGAS(event, symbol = "", note = "", data = {}) {
  if (!LOG_WEBHOOK_URL) return console.log(`[LOG] ${event} | ${symbol} | ${note}`, data);
  try {
    await axios.post(LOG_WEBHOOK_URL, { secret: LOG_WEBHOOK_SECRET, event, symbol, note, data }, { timeout: 3000 });
  } catch (e) {
    console.error("logToGAS failed:", e.message);
  }
}

// Alpaca & Massive helpers
const ALPACA_BASE = "https://paper-api.alpaca.markets/v2";
const MASSIVE_BASE = "https://api.massive.com";
const alpacaHeaders = () => ({ "APCA-API-KEY-ID": A_KEY, "APCA-API-SECRET-KEY": A_SEC });

// Safe network calls
async function safeGet(url, opts = {}, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try { return (await axios.get(url, opts)).data; }
    catch(e) { if (i === retries) throw e; await new Promise(r => setTimeout(r, 300 * (i+1))); }
  }
}

async function safePost(url, payload, headers, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try { return await axios.post(url, payload, { headers }); }
    catch(e) { if (i === retries) throw e; await new Promise(r => setTimeout(r, 300 * (i+1))); }
  }
}

// Equity & positions
async function getEquity() {
  const r = await safeGet(`${ALPACA_BASE}/account`, { headers: alpacaHeaders() });
  return parseFloat(r.equity || 25000);
}
async function getOpenPositions() {
  return await safeGet(`${ALPACA_BASE}/positions`, { headers: alpacaHeaders() });
}

// ML prediction (placeholder)
let ML_WEIGHTS = { w: [1.3, 0.9, 0.7, 1.5, 2.3], b: -2.4 };
function mlPredict(features) {
  let z = ML_WEIGHTS.b;
  for (let i = 0; i < Math.min(features.length, ML_WEIGHTS.w.length); i++) z += features[i] * ML_WEIGHTS.w[i];
  return 1 / (1 + Math.exp(-z));
}

// Scan & analyze
async function getEliteGappers(limit = 1000) {
  const data = await safeGet(`${MASSIVE_BASE}/v3/reference/tickers?market=stocks&active=true&limit=${limit}&apiKey=${MASSIVE_KEY}`);
  const results = data?.results || [];

  // Parallel snapshots
  const snapshots = await Promise.all(results.map(async t => {
    try {
      if (t.type !== 'CS' || !t.ticker) return null;
      const snap = await safeGet(`${MASSIVE_BASE}/v2/snapshot/locale/us/markets/stocks/tickers?tickers=${t.ticker}&apiKey=${MASSIVE_KEY}`);
      return { ...t, snap: snap?.tickers?.[0] };
    } catch { return null; }
  }));

  const out = snapshots.filter(s => s?.snap).map(s => {
    const last = s.snap.lastTrade?.p || s.snap.day?.c || 0;
    const prev = s.snap.prevDay?.c || 0;
    if (!prev || last < 2.5 || last > 20) return null;
    const gap = (last - prev) / prev;
    if (gap < 0.15) return null;
    const rvol = (s.snap.day?.v || 0) / (prev * 100000);
    if ((s.snap.day?.v || 0) < 750000 || rvol < 4) return null;
    if ((s.market_cap || Infinity) > 500000000) return null;
    if ((s.share_class_shares_outstanding || Infinity) > 20000000) return null;
    return { sym: s.ticker, price: last, rvol, gap };
  }).filter(Boolean);

  return out.sort((a,b) => b.rvol - a.rvol).slice(0,10);
}

async function getBars(sym, fromDays = 3) {
  const now = Date.now();
  const cached = barCache[sym];
  if (cached && now - cached.lastFetch < 60000) return cached.bars; // cache 1 min
  const today = new Date().toISOString().split('T')[0];
  const from = new Date(); from.setDate(from.getDate() - fromDays);
  const fromStr = from.toISOString().split('T')[0];
  const data = await safeGet(`${MASSIVE_BASE}/v2/aggs/ticker/${sym}/range/1/minute/${fromStr}/${today}?adjusted=true&limit=1000&apiKey=${MASSIVE_KEY}`);
  const bars = data?.results || [];
  barCache[sym] = { bars, lastFetch: now };
  return bars;
}

function calculateVWAP(bars) {
  if (!bars.length) return null;
  let volPrice=0, vol=0;
  for (const b of bars) { const typ=(b.h+b.l+b.c)/3; volPrice+=typ*(b.v||0); vol+=(b.v||0); }
  return vol>0 ? volPrice/vol : null;
}

async function analyzeCandidate(t) {
  try {
    const bars = await getBars(t.sym,3);
    if (!bars.length || bars.length<50) return null;
    const last = bars[bars.length-1];
    const vwap = calculateVWAP(bars);
    if (!vwap || last.c <= vwap) return null;
    const hod = Math.max(...bars.slice(-20).map(b=>b.h));
    if (last.c < hod*0.995) return null;
    const recentVol = bars.slice(-5).reduce((s,b)=>s+(b.v||0),0)/5;
    const avgVol = bars.slice(-30,-5).reduce((s,b)=>s+(b.v||0),0)/25||1;
    if (recentVol < avgVol*2) return null;

    const features = [
      last.c / vwap,
      last.v / (bars[bars.length-2]?.v || 1),
      1,1,
      (last.c - (bars[bars.length-2]?.c || last.c))/last.c
    ];
    const score = mlPredict(features);
    if (score<0.73) return null;

    const equity = await getEquity();
    const qty = Math.max(1, Math.floor(equity*0.015/(last.c*0.04)));
    return { symbol:t.sym, price:last.c, qty, mlScore:score, features };
  } catch { return null; }
}

async function placeBracketOrder(sig) {
  const payload = {
    symbol: sig.symbol,
    qty: sig.qty,
    side:'buy',
    type:'market',
    time_in_force:'day',
    order_class:'bracket',
    take_profit:{ limit_price: parseFloat((sig.price*1.10).toFixed(2)) },
    stop_loss:{ stop_price: parseFloat((sig.price*0.96).toFixed(2)) }
  };
  try {
    const r = await safePost(`${ALPACA_BASE}/orders`, payload, alpacaHeaders());
    await logToGAS('ENTRY', sig.symbol, `BUY ${sig.qty} @ ${sig.price}`, { ml: sig.mlScore });
    positions[sig.symbol] = { entry:sig.price, qty:sig.qty, trailPrice:sig.price*0.94, partialDone:false };
    return r.data;
  } catch(e) {
    await logToGAS('ORDER_FAIL', sig.symbol, e.response?.data?.message || e.message);
    return null;
  }
}

// Manage positions
async function managePositions() {
  try {
    const open = await getOpenPositions();
    for (const pos of open) {
      const symbol = pos.symbol;
      const current = parseFloat(pos.current_price || pos.avg_entry_price);
      const entry = parseFloat(pos.avg_entry_price);
      const qty = parseFloat(pos.qty);
      if (!positions[symbol]) positions[symbol]={entry,qty,trailPrice:entry*0.94,partialDone:false};

      // Partial + dynamic trail
      if (current >= entry*1.05 && !positions[symbol].partialDone) {
        await safePost(`${ALPACA_BASE}/orders`, {
          symbol, qty: Math.floor(qty/2), side:'sell', type:'market', time_in_force:'day'
        }, alpacaHeaders());
        positions[symbol].partialDone = true;
        await logToGAS('PARTIAL', symbol, `Locked +5% on ${Math.floor(qty/2)} shares`);
      }
      const newTrail = current * 0.94;
      if (newTrail > positions[symbol].trailPrice) positions[symbol].trailPrice = newTrail;

      // Exit if below trail
      if (current <= positions[symbol].trailPrice) {
        await safePost(`${ALPACA_BASE}/orders`, { symbol, qty, side:'sell', type:'market', time_in_force:'day' }, alpacaHeaders());
        await logToGAS('EXIT_TRAIL', symbol, `Trailed out @ ${current}`);
        delete positions[symbol];
      }
    }
  } catch(e) { console.error('managePositions error', e.message); }
}

// Scan handler
let isScanning=false;
async function scanHandler() {
  if (isScanning) return;
  isScanning=true;
  try {
    const d=new Date(); const hours=d.getUTCHours();
    if (hours<13 || hours>=20) { isScanning=false; return; }
    await managePositions();
    if (Object.keys(positions).length>=MAX_POS){ isScanning=false; return; }

    const gappers = await getEliteGappers();
    for (const t of gappers){
      if (Object.keys(positions).length>=MAX_POS) break;
      const sig = await analyzeCandidate(t);
      if (sig) await placeBracketOrder(sig);
    }
  } catch(e){ console.error('scan error', e.message); await logToGAS('SCAN_ERROR','SYSTEM',e.message);}
  finally{ isScanning=false; }
}

// Routes
app.get('/',(req,res)=>res.json({status:'AlphaStream v23.1',time:new Date().toISOString()}));
app.post('/', async (req,res)=>{
  const body = req.body||{};
  if (FORWARD_SECRET && body.secret !== FORWARD_SECRET) return res.status(403).json({status:'forbidden'});
  scanHandler().catch(e=>console.error('scanHandler err',e));
  return res.json({status:'queued'});
});

// Start
const PORT=process.env.PORT||8080;
app.listen(PORT, ()=>{console.log('AlphaStream v23.1 listening on port',PORT); logToGAS('BOT_START','SYSTEM','AlphaStream v23.1 started');});
