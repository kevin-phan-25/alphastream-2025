// utils/regime.js
import { ADX } from "technicalindicators";
import { getBars } from "../index.js"; // We'll import from main later

export async function detectMarketRegime() {
  const indices = ["SPY", "QQQ", "IWM"];
  let totalTrend = 0, totalAdx = 0, totalVol = 0;

  for (const sym of indices) {
    try {
      const bars = await getBars(sym, 70);
      if (!bars || bars.length < 60) continue;

      const closes = bars.map(b => b.c);
      const highs = bars.map(b => b.h);
      const lows = bars.map(b => b.l);

      // 30-day trend
      const trend = (closes[closes.length - 1] / closes[closes.length - 30]) - 1;
      totalTrend += trend;

      // ADX (14)
      const adxSeries = ADX.calculate({ high: highs, low: lows, close: closes, period: 14 });
      const adx = adxSeries[adxSeries.length - 1]?.adx || 0;
      totalAdx += adx;

      // Annualized volatility
      const returns = closes.slice(1).map((c, i) => (c - closes[i]) / closes[i]);
      const vol = std(returns.slice(-20)) * Math.sqrt(252 * 390);
      totalVol += vol;
    } catch (e) {
      continue;
    }
  }

  const avgTrend = totalTrend / indices.length;
  const avgAdx = totalAdx / indices.length;
  const avgVol = totalVol / indices.length;

  if (avgTrend > 0.10 && avgAdx > 28) return "BULL_TREND";
  if (avgTrend < -0.06 && avgAdx > 22) return "BEAR_TREND";
  if (avgVol > 0.32) return "HIGH_VOL_CHOP";
  if (avgTrend > 0.03 && avgAdx > 20) return "WEAK_BULL";
  return "CHOP";
}
