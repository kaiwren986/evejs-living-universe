"use strict";

function rate(candidate) {
  const profit = Math.round((candidate.profit?.expectedProfit || 0) * 100);
  const duration = Math.round((candidate.timeSeconds || 0) * 1000);
  return Number.isSafeInteger(profit) && profit > 0 && Number.isSafeInteger(duration) && duration > 0
    ? { profit: BigInt(profit), duration: BigInt(duration) } : null;
}
function compareProductionPriority(a, b) {
  const left = rate(a), right = rate(b);
  if (!left || !right) return left ? -1 : right ? 1 : 0;
  const difference = left.profit * right.duration - right.profit * left.duration;
  return difference > 0n ? -1 : difference < 0n ? 1 : 0;
}
function productionPriority(candidate) {
  const value = rate(candidate);
  return { timeSeconds: candidate.timeSeconds, expectedProfit: candidate.profit?.expectedProfit,
    profitPerHour: value ? Number((value.profit * 3600000n + value.duration / 2n) / value.duration) / 100 : null };
}
module.exports = { compareProductionPriority, productionPriority };
