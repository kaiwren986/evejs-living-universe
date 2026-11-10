"use strict";

const TABLE = "crewEquipmentRuntime";
const ROLES = Object.freeze(["mining", "hauling", "manufacturing"]);
const CATALOG = Object.freeze({
  mining: Object.freeze({ name: "Mining tools", costs: Object.freeze([1000, 5000, 20000]) }),
  hauling: Object.freeze({ name: "Hauling equipment", costs: Object.freeze([1500, 7500, 30000]) }),
  manufacturing: Object.freeze({ name: "Factory tooling", costs: Object.freeze([2000, 10000, 40000]) }),
});
function invalid() { const error = Error("Crew equipment needs recovery; no upgrade was purchased."); error.code = "CREW_STATE_INVALID"; error.status = 503; throw error; }
function tiers(record) {
  if (record && !record.tiers) invalid();
  const value = record?.tiers || Object.fromEntries(ROLES.map(role => [role, 0]));
  if (Object.keys(value).sort().join() !== [...ROLES].sort().join() || ROLES.some(role => !Number.isSafeInteger(value[role]) || value[role] < 0 || value[role] > 3)) invalid();
  return value;
}
function profile(record, role) {
  if (!ROLES.includes(role)) throw TypeError("Unknown equipment specialization");
  const tier = tiers(record)[role];
  return { name: CATALOG[role].name, tier, maxTier: 3, timeReductionPercent: tier * 5, durationBasisPoints: 10000 - tier * 500,
    capacityMultiplier: role === "hauling" ? 1 + tier * 0.25 : 1, nextCost: CATALOG[role].costs[tier] ?? null };
}
function read(ownerID) {
  const result = require("../../gameStore").read(TABLE, `/${ownerID}`);
  if (!result.success && !["TABLE_NOT_FOUND", "ENTRY_NOT_FOUND"].includes(result.errorMsg)) invalid();
  const record = result.success ? result.data : null;
  if (record && (record.ownerID !== ownerID || record.version !== 1 || !Number.isFinite(record.totalSpent) || record.totalSpent < 0)) invalid();
  const levels = tiers(record);
  if (record) {
    if (!Array.isArray(record.history) || record.history.length !== Object.values(levels).reduce((a, b) => a + b, 0)) invalid();
    let spent = 0;
    for (const role of ROLES) for (let tier = 1; tier <= levels[role]; tier++) {
      const cost = CATALOG[role].costs[tier - 1];
      if (record.history.filter(row => row.role === role && row.tier === tier && row.cost === cost).length !== 1) invalid(); spent += cost;
    }
    if (spent !== record.totalSpent || (record.job && (!ROLES.includes(record.job.role) || record.job.tier !== levels[record.job.role] + 1 || record.job.cost !== CATALOG[record.job.role].costs[record.job.tier - 1]))) invalid();
  }
  return record;
}
function forOwner(ownerID, role) { return profile(read(ownerID), role); }
function committed(ownerID) { const record = read(ownerID); return (record?.totalSpent || 0) + (record?.job?.cost || 0); }
function duration(base, equipment) { return Math.max(1, Math.ceil(base * equipment.durationBasisPoints / 10000)); }
module.exports = { TABLE, ROLES, CATALOG, tiers, profile, read, forOwner, committed, duration, invalid };
