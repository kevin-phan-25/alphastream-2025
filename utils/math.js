// utils/math.js
export const std = (arr) => {
  if (!arr || arr.length === 0) return 0;
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  const variance = arr.reduce((a, b) => a + (b - mean) ** 2, 0) / arr.length;
  return Math.sqrt(variance);
};

export const safeDiv = (a, b, fallback = 0) => (b === 0 || b === null || !isFinite(b)) ? fallback : a / b;
