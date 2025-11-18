// utils/risk.js
export function calculatePositionSize({ equity, price, atr, mlScore, regime }) {
  const baseRisk = 0.018; // 1.8% per trade
  const kelly = mlScore > 0.78 ? 1.4 : mlScore > 0.75 ? 1.1 : 0.9;
  const regimeMult = regime === "BULL_TREND" ? 1.3 : regime === "WEAK_BULL" ? 1.0 : 0.7;
  const volTarget = 0.008; // 0.8% daily vol target
  const riskPerShare = atr * 1.3;

  const rawQty = (equity * baseRisk * kelly * regimeMult) / riskPerShare;
  return Math.max(1, Math.floor(rawQty));
}
