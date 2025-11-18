// utils/features.js
import { ATR } from "technicalindicators";

export function extractFeatures({ t, bars, last, vwapPrice, spyReturn, prevClose }) {
  const openBar = bars.find(b => b.t.includes("09:30") || b.t.includes("09:31")) || last;
  const atr14 = ATR.calculate({
    high: bars.map(b => b.h),
    low: bars.map(b => b.l),
    close: bars.map(b => b.c),
    period: 14
  }).pop() || last.c * 0.04;

  const recentVol = bars.slice(-10).reduce((s, b) => s + b.v, 0) / 10;
  const earlierVol = bars.slice(-40, -10).reduce((s, b) => s + b.v, 0) / 30 || 1;
  const volAccel = recentVol / earlierVol;

  const gap = (last.c - prevClose) / prevClose;
  const rvol = recentVol / (prevClose * 80000); // rough ADV proxy

  return [
    gap,                                          // 0
    rvol,                                         // 1
    last.c / vwapPrice,                           // 2
    last.c / openBar.o,                           // 3
    spyReturn,                                    // 4
    t.float / 20_000_000,                         // 5  (capped at 20M)
    (t.shortInterest || 0) / (t.float || 1),      // 6
    volAccel,                                     // 7
    (last.c - prevClose) / atr14,                 // 8  (gap in ATRs)
    last.v / (bars[bars.length - 2]?.v || 1),     // 9
    t.marketCap / 1e9,                            // 10
    t.sector === "Technology" ? 1 : 0,            // 11
    t.sector === "Healthcare" ? 1 : 0,            // 12
    t.sector === "Consumer Cyclical" ? 1 : 0,     // 13
    last.c > t.price * 1.15 ? 1 : 0,               // 14  parabolic?
    Math.min(gap / 0.4, 2),                       // 15  gap intensity (capped)
    spyReturn > 0.005 ? 1 : 0,                    // 16  SPY green
    volAccel > 2.5 ? 1 : 0,                       // 17  volume surge
    last.c / prevClose,                           // 18  raw gap multiplier
    atr14 / last.c,                               // 19  volatility norm
    recentVol / 1e6,                              // 20  absolute volume
    t.float < 10_000_000 ? 1 : 0,                 // 21  sub-10M float
    t.shortInterest > t.float * 0.25 ? 1 : 0,     // 22  >25% short
    last.h === Math.max(...bars.slice(-30).map(b => b.h)) ? 1 : 0, // 23 HOD
    bars.length > 200 ? 1 : 0,                    // 24  enough history
    new Date().getUTCHours() < 14 ? 1 : 0,        // 25  pre-10am ET power hour
    gap > 0.3 ? 1 : 0,                            // 26  monster gap
    rvol > 10 ? 1 : 0                             // 27  insane rvol
  ].map(f => isFinite(f) ? Number(f.toFixed(6)) : 0);
}
