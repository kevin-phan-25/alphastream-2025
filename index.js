// src/app/page.tsx — FINAL DASHBOARD FOR AlphaStream v39.0+ (NOV 2025)
'use client';

import { useState, useEffect } from 'react';
import axios from 'axios';
import { Activity, Rocket, RefreshCw, X, TrendingUp, AlertTriangle, Zap } from 'lucide-react';

export default function Home() {
  const [data, setData] = useState<any>({});
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [showPositions, setShowPositions] = useState(false);

  const BOT_URL = process.env.NEXT_PUBLIC_BOT_URL?.trim();

  const fetchData = async () => {
    if (!BOT_URL) return;
    try {
      const res = await axios.get(BOT_URL, { timeout: 12000 });
      setData(res.data || {});
      setLoading(false);
    } catch (err) {
      console.error("Bot offline or error");
      setData({});
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
    const id = setInterval(fetchData, 8000);
    return () => clearInterval(id);
  }, [BOT_URL]);

  const triggerScan = async () => {
    if (!BOT_URL) return;
    setScanning(true);
    try { await axios.post(`${BOT_URL}/manual/scan`); }
    finally { setScanning(false); fetchData(); }
  };

  // Safe field extraction — works with v34 to v39+
  const equity = data.equity || data.equity || "$0.00";
  const dailyPnL = data.dailyPnL || "+$0.00";
  const positionsCount = data.positions_count ?? data.positions?.length ?? data.positions ?? 0;
  const winRate = data.backtest?.winRate || data.win_rate || "0.0%";
  const totalTrades = data.backtest?.totalTrades || data.backtest?.trades || 0;
  const isLive = (data.status === "ONLINE") && !data.dry_mode;

  if (loading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-purple-900 via-black to-pink-900 flex items-center justify-center">
        <div className="text-6xl font-black text-purple-400 animate-pulse">AlphaStream v39.0</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-purple-900 via-black to-pink-900 text-white">

      {/* Header */}
      <header className="fixed top-0 w-full z-50 backdrop-blur-xl bg-black/80 border-b border-white/10">
        <div className="max-w-7xl mx-auto px-6 py-5 flex justify-between items-center">
          <h1 className="text-4xl md:text-5xl font-black bg-gradient-to-r from-purple-400 to-pink-400 bg-clip-text text-transparent">
            AlphaStream v39.0
          </h1>
          <div className="flex items-center gap-6">
            <span className="text-2xl font-bold text-cyan-400">ELITE AUTOMATION</span>
            <span className={`px-8 py-4 rounded-full text-2xl font-black ${isLive ? 'bg-green-600' : 'bg-yellow-600'}`}>
              {isLive ? "LIVE TRADING" : "PAPER MODE"}
            </span>
          </div>
        </div>
      </header>

      <main className="pt-32 px-6 pb-32">
        <div className="max-w-7xl mx-auto space-y-20">

          {/* Hero */}
          <div className="text-center">
            <h2 className="text-7xl md:text-9xl font-black bg-gradient-to-r from-cyan-400 via-purple-400 to-pink-400 bg-clip-text text-transparent">
              PROP CRUSHER
            </h2>
            <p className="text-3xl mt-6 text-gray-300">7.5%+ Gainers • 800k+ Volume • 4 Max Positions • Daily Loss Stop</p>
          </div>

          {/* Pulse */}
          <div className="flex justify-center">
            <div className="w-80 h-80 rounded-full bg-gradient-to-r from-green-600/40 to-cyan-600/40 border-12 border-green-400 shadow-2xl flex items-center justify-center animate-pulse">
              <Zap className="w-48 h-48 text-green-400" />
            </div>
          </div>

          {/* Main Stats */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-10">
            <div className="bg-white/10 backdrop-blur-xl rounded-3xl p-10 border border-white/20 text-center">
              <p className="text-gray-400 text-lg">EQUITY</p>
              <p className="text-6xl md:text-3xl font-black text-cyan-400 mt-4">{equity}</p>
            </div>

            <div className="bg-white/10 backdrop-blur-xl rounded-3xl p-10 border border-white/20 text-center">
              <p className="text-gray-400 text-lg">DAILY P&L</p>
              <p className={`text-6xl md:text-3xl font-black mt-4 ${dailyPnL.includes('-') ? 'text-red-400' : 'text-green-400'}`}>
                {dailyPnL}
              </p>
            </div>

            <div 
              onClick={() => setShowPositions(true)}
              className="bg-white/10 backdrop-blur-xl rounded-3xl p-10 border border-white/20 text-center cursor-pointer hover:scale-105 transition"
            >
              <p className="text-gray-400 text-lg">POSITIONS</p>
              <p className="text-7xl font-black text-purple-400 mt-4">
                {positionsCount}<span className="text-5xl text-gray-400">/4</span>
              </p>
            </div>

            <div className="bg-white/10 backdrop-blur-xl rounded-3xl p-10 border border-white/20 text-center">
              <p className="text-gray-400 text-lg">WIN RATE</p>
              <p className="text-7xl font-black text-yellow-400 mt-4">{winRate}</p>
            </div>
          </div>

          {/* Win/Loss Counters */}
          <div className="grid grid-cols-3 gap-10 max-w-4xl mx-auto">
            <div className="bg-white/10 backdrop-blur-xl rounded-3xl p-10 border border-white/20 text-center">
              <TrendingUp className="w-20 h-20 mx-auto text-green-400 mb-4" />
              <p className="text-7xl font-black text-green-400">{data.backtest?.wins || 0}</p>
              <p className="text-xl text-gray-400 mt-2">WINS</p>
            </div>
            <div className="bg-white/10 backdrop-blur-xl rounded-3xl p-10 border border-white/20 text-center">
              <AlertTriangle className="w-20 h-20 mx-auto text-red-400 mb-4" />
              <p className="text-7xl font-black text-red-400">{data.backtest?.losses || 0}</p>
              <p className="text-xl text-gray-400 mt-2">LOSSES</p>
            </div>
            <div className="bg-white/10 backdrop-blur-xl rounded-3xl p-10 border border-white/20 text-center">
              <Activity className="w-20 h-20 mx-auto text-purple-400 mb-4" />
              <p className="text-7xl font-black text-purple-400">{totalTrades}</p>
              <p className="text-xl text-gray-400 mt-2">TOTAL TRADES</p>
            </div>
          </div>

          {/* Live Trade Log */}
          <div className="mt-20">
            <h3 className="text-6xl font-black text-center mb-10 bg-gradient-to-r from-cyan-400 to-purple-400 bg-clip-text text-transparent">
              LIVE TRADE LOG
            </h3>
            <div className="bg-white/5 backdrop-blur-xl rounded-3xl border border-white/20 p-10 max-h-96 overflow-y-auto">
              {(!data.tradeLog || data.tradeLog.length === 0) ? (
                <p className="text-center text-4xl text-gray-500 py-32">Waiting for 7.5%+ runners...</p>
              ) : (
                <div className="space-y-6">
                  {data.tradeLog.slice().reverse().map((t: any) => (
                    <div key={t.id} className={`p-8 rounded-3xl border-4 ${t.type === "ENTRY" ? "bg-green-900/60 border-green-500" : "bg-red-900/60 border-red-500"}`}>
                      <div className="flex justify-between items-center">
                        <div>
                          <span className="text-5xl font-black">{t.symbol}</span>
                          <span className={`ml-8 text-3xl font-bold ${t.type === "ENTRY" ? "text-green-300" : "text-red-300"}`}>
                            {t.type === "ENTRY" ? "BUY" : "SELL"} {t.qty} @ ${t.price}
                          </span>
                        </div>
                        <div className="text-right">
                          {t.pnl !== undefined && (
                            <p className={`text-4xl font-black ${t.pnl >= 0 ? "text-green-400" : "text-red-400"}`}>
                              {t.pnl >= 0 ? "+" : ""}{t.pnl} ({t.pnlPct}%)
                            </p>
                          )}
                          <p className="text-xl text-gray-400 mt-3">
                            {new Date(t.timestamp).toLocaleTimeString()} • {t.reason}
                          </p>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* FORCE SCAN BUTTON */}
          <div className="text-center mt-20">
            <button
            onClick={triggerScan}
            disabled={scanning}
            className="px-40 py-20 text-7xl font-black rounded-full bg-gradient-to-r from-purple-600 to-pink-600 hover:from-purple-700 hover:to-pink-700 shadow-2xl disabled:opacity-60 transition-all"
          >
            {scanning ? (
              <>SCANNING <RefreshCw className="inline ml-12 w-20 h-20 animate-spin" /></>
            ) : (
              <>FORCE SCAN <Rocket className="inline ml-12 w-20 h-20" /></>
            )}
          </button>
          </div>
        </div>
      </main>

      {/* POSITIONS MODAL — 100% FIXED */}
      {showPositions && data.positions && (
        <div className="fixed inset-0 bg-black/95 backdrop-blur-xl z-50 flex items-center justify-center p-6">
          <div className="bg-gray-900/95 border border-white/20 rounded-3xl p-12 max-w-5xl w-full max-h-screen overflow-y-auto">
            <div className="flex justify-between items-center mb-10">
              <h3 className="text-6xl font-black text-purple-400">ACTIVE POSITIONS</h3>
              <button onClick={() => setShowPositions(false)}>
                <X className="w-14 h-14 text-gray-400 hover:text-white" />
              </button>
            </div>

            {data.positions.length === 0 ? (
              <p className="text-center text-4xl text-gray-400 py-32">No open positions</p>
            ) : (
              <div className="space-y-8">
                {data.positions.map((p: any, i: number) => (
                  <div key={i} className="bg-white/5 rounded-3xl p-10 border border-white/10">
                    <div className="grid grid-cols-2 md:grid-cols-5 gap-8 text-2xl">
                      <div><span className="text-gray-400">Symbol</span><p className="text-5xl font-bold text-purple-400">{p.symbol}</p></div>
                      <div><span className="text-gray-400">Qty</span><p className="text-5xl font-bold">{p.qty}</p></div>
                      <div><span className="text-gray-400">Entry</span><p className="text-4xl">${p.entry?.toFixed(2)}</p></div>
                      <div><span className="text-gray-400">Current</span><p className={`text-4xl font-bold ${p.unrealized_pl >= 0 ? 'text-green-400' : 'text-red-400'}`}>${p.current?.toFixed(2)}</p></div>
                      <div><span className="text-gray-400">P&L</span><p className={`text-5xl font-black ${p.unrealized_pl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                        ${p.unrealized_pl?.toFixed(2)}
                      </p></div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
