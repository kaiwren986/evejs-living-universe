"use strict";

const THRESHOLDS = Object.freeze([0, 100, 300, 600, 1000, 1500]);
const SKILLS = Object.freeze({ mining: "Mining", refining: "Reprocessing", hauling: "Logistics", manufacturing: "Manufacturing", selling: "Market Sales", buying: "Procurement" });
const MAX_XP = THRESHOLDS.at(-1), XP_PER_COMPLETION = 10;

function invalid() {
  const error = new Error("Crew experience needs recovery; no new work was started.");
  error.code = "CREW_STATE_INVALID"; error.status = 503; throw error;
}
function validate(progression) {
  if (progression === undefined) return;
  if (!progression || Array.isArray(progression) || Object.keys(progression).sort().join() !== "version,xp" || progression.version !== 1 ||
      !Number.isSafeInteger(progression.xp) || progression.xp < 0 || progression.xp > MAX_XP) invalid();
}
function legacyCompletions(state, skill) {
  if (!state) return 0;
  if (skill === "mining") return state.completedDeliveries || 0;
  if (skill === "selling") return state.completedSales || 0;
  if (skill === "buying") return state.completedPurchases || 0;
  if (skill !== "hauling") return state.completedBatches || 0;
  const order = state.standingOrder;
  // Current-route deliveries have a durable lifetime count. Other historical
  // routes/manual deliveries can only be credited where history still exists.
  return (order?.completedDeliveries || 0) + (state.history || []).filter(trip =>
    trip.cargo && (!order || trip.automaticOrderID !== order.orderID)).length;
}
function ensure(state, skill) {
  if (!Object.hasOwn(SKILLS, skill)) throw new TypeError("Unknown crew skill");
  validate(state.progression);
  if (state.progression === undefined) {
    const completed = legacyCompletions(state, skill);
    if (!Number.isSafeInteger(completed) || completed < 0) invalid();
    state.progression = { version: 1, xp: completed >= MAX_XP / XP_PER_COMPLETION ? MAX_XP : completed * XP_PER_COMPLETION };
  }
  return state.progression;
}
function profile(state, skill) {
  const copy = { ...state }, { xp } = ensure(copy, skill);
  const level = THRESHOLDS.findLastIndex(threshold => xp >= threshold), nextLevelXP = THRESHOLDS[level + 1] ?? null;
  const perLevelReductionPercent = ["buying", "selling"].includes(skill) ? 10 : 3;
  return { skill: SKILLS[skill], xp, level, maxLevel: 5, nextLevelXP, xpToNext: nextLevelXP === null ? 0 : nextLevelXP - xp,
    timeReductionPercent: level * perLevelReductionPercent, durationBasisPoints: 10000 - level * perLevelReductionPercent * 100,
    perLevelReductionPercent, xpPerCompletion: XP_PER_COMPLETION };
}
function duration(base, state, skill) {
  if (!Number.isSafeInteger(base) || base < 1) throw new TypeError("Invalid crew work duration");
  return Math.max(1, Math.ceil(base * profile(state, skill).durationBasisPoints / 10000));
}
function award(state, skill) {
  const current = ensure(state, skill), before = current.xp;
  current.xp = Math.min(MAX_XP, current.xp + XP_PER_COMPLETION);
  return current.xp - before;
}
module.exports = { THRESHOLDS, MAX_XP, XP_PER_COMPLETION, validate, ensure, profile, duration, award };
