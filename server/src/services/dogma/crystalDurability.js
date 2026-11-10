"use strict";

// Pure durability policy. Callers supply dogma and randomness; current charge
// owners retain custody, accepted-cycle decisions and client presentation.
const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const clamp = (value, maximum) => Math.min(maximum, Math.max(0, finite(value)));

function resolveCrystalDamage(item) {
  return Math.max(0, finite(item?.moduleState?.damage));
}

function buildCrystalDurabilitySnapshot(typeID, attributes = {}, chanceMultiplier = 1) {
  return Object.freeze({
    typeID: Math.trunc(finite(typeID)),
    hitpoints: Math.max(0, finite(attributes[9])),
    crystalsGetDamaged: finite(attributes[786]) > 0,
    volatilityChance: clamp(attributes[783], 1) * clamp(chanceMultiplier, 1),
    volatilityDamage: Math.max(0, finite(attributes[784])),
  });
}

function planCrystalDurabilityCycle({ chargeItem, durabilitySnapshot: snapshot, random } = {}) {
  const previousDamage = resolveCrystalDamage(chargeItem);
  const unchanged = { damaged: false, burnedOut: false, rollConsumed: false,
    previousDamage, nextDamage: previousDamage, hitpoints: snapshot?.hitpoints || 0 };
  if (!chargeItem || !snapshot || snapshot.typeID <= 0 ||
      snapshot.typeID !== Number(chargeItem.typeID) || !snapshot.crystalsGetDamaged ||
      !(snapshot.hitpoints > 0) || !Number.isFinite(snapshot.hitpoints)) {
    return { success: true, data: unchanged };
  }
  // A persisted exhausted crystal needs removal, never another wear roll.
  if (previousDamage >= snapshot.hitpoints) {
    return { success: true, data: { ...unchanged, burnedOut: true, nextDamage: snapshot.hitpoints } };
  }
  if (!(snapshot.volatilityChance > 0) || !(snapshot.volatilityDamage > 0)) return { success: true, data: unchanged };
  if (typeof random !== "function") return { success: false, errorMsg: "CRYSTAL_RANDOM_SOURCE_REQUIRED" };
  const roll = random();
  if (!Number.isFinite(roll) || roll < 0 || roll >= 1 || roll >= snapshot.volatilityChance) {
    return { success: true, data: { ...unchanged, rollConsumed: true } };
  }
  const nextDamage = Math.min(snapshot.hitpoints, Number((previousDamage + snapshot.volatilityDamage).toFixed(12)));
  return { success: true, data: { ...unchanged, rollConsumed: true,
    damaged: nextDamage > previousDamage, nextDamage, burnedOut: nextDamage >= snapshot.hitpoints } };
}

function crystalDamageRatio(item, hitpoints) {
  return hitpoints > 0 && Number.isFinite(hitpoints) ? clamp(resolveCrystalDamage(item) / hitpoints, 1) : 0;
}

function isCrystalBurnedOut(item, snapshot) {
  return Boolean(item && snapshot?.crystalsGetDamaged && snapshot.hitpoints > 0 &&
    snapshot.typeID === Number(item.typeID) && resolveCrystalDamage(item) >= snapshot.hitpoints);
}

module.exports = { buildCrystalDurabilitySnapshot, planCrystalDurabilityCycle, resolveCrystalDamage, crystalDamageRatio, isCrystalBurnedOut };
