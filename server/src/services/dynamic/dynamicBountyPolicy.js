"use strict";

// Control terms mined from the donor's resolveDbsOutputFromInputs. Bounds,
// equilibrium and cadence retain EveJS's existing dynamic resource settings.
// CCP documents the direction of these effects, not its proprietary equation.
const CONTROL_SETTINGS = Object.freeze({ minBounties: 100_000_000, referenceRiskRatio: 1,
  boundsExponent: 1, equilibriumStepBonus: 0.01, equilibriumStepPenalty: 0.01,
  riskRatioBonusStep: 0.02, riskRatioPenaltyStep: 0.02,
  currentOutputBonusStep: 0.01, currentOutputPenaltyStep: 0.01 });
function clamp(value, settings) { return Math.max(settings.minOutput, Math.min(settings.maxOutput, value)); }
function idle(output, periods, settings) {
  const difference = settings.equilibriumValue - output;
  const step = difference >= 0 ? settings.equilibriumStepBonus : settings.equilibriumStepPenalty;
  return clamp(output + Math.sign(difference) * Math.min(Math.abs(difference), step * periods), settings);
}
function step(output, input, settings) {
  const paid = Number(input?.paidCents || 0), loss = Number(input?.lossCents || 0), minimum = settings.minBounties * 100;
  if (paid < minimum && loss <= 0) return idle(output, 1, settings);
  const risk = ((loss + minimum * settings.referenceRiskRatio) / Math.max(1, paid + minimum)) ** settings.boundsExponent;
  const next = risk >= settings.referenceRiskRatio
    ? output + settings.equilibriumStepBonus + settings.riskRatioBonusStep * (risk - settings.referenceRiskRatio) + settings.currentOutputBonusStep * Math.max(0, settings.equilibriumValue - output)
    : output - settings.equilibriumStepPenalty - settings.riskRatioPenaltyStep * (settings.referenceRiskRatio - risk) - settings.currentOutputPenaltyStep * Math.max(0, output - settings.equilibriumValue);
  return clamp(next, settings);
}
module.exports = { CONTROL_SETTINGS, clamp, idle, step };
