"use strict";

// Pure translations of client dbuff collections. Dogma and HUD application
// remain with the existing continuous-dbuff owner, not a second buff engine.
const DBUFF = Object.freeze({ VELOCITY_PERCENT: 3, WARP_PENALTY: 4,
  DISALLOW_CLOAK: 5, DISALLOW_JUMP_OR_DOCK: 6, DISALLOW_TETHER: 57,
  DISABLE_MJD: 2426, SPEED_LIMIT: 2427, DISABLE_MJFG: 2428 });
const supported = new Set(Object.values(DBUFF));

function normalizeLinkRules(raw) {
  if (!raw || !Number.isSafeInteger(raw.typeID) || raw.typeID <= 0 ||
      !Number.isSafeInteger(raw.linkableShipTypeListID) || raw.linkableShipTypeListID <= 0 ||
      !Number.isFinite(raw.linkDuration) || raw.linkDuration <= 0 ||
      !Number.isFinite(raw.maxLinkRange) || raw.maxLinkRange <= 0 ||
      !Number.isFinite(raw.dbuffPostLinkDuration ?? 0) || (raw.dbuffPostLinkDuration ?? 0) < 0) return null;
  for (const flag of ["omegaOnly", "applyPvpFlag", "canRelink", "keepDbuffDurationOnLinkBreak", "generateCynoInhibitor"]) {
    if (raw[flag] != null && typeof raw[flag] !== "boolean") return null;
  }
  for (const cost of [raw.characterEnergyCost, raw.solarsystemInterferenceCost]) {
    if (cost != null && (!Number.isFinite(cost) || cost < 0)) return null;
  }
  if (!raw.dbuffs || typeof raw.dbuffs !== "object" || Array.isArray(raw.dbuffs)) return null;
  const dbuffs = { ...raw.dbuffs };
  if (Object.entries(dbuffs).some(([id, value]) => !Number.isSafeInteger(Number(id)) ||
      Number(id) <= 0 || !Number.isFinite(value))) return null;
  if (dbuffs[DBUFF.SPEED_LIMIT] != null && dbuffs[DBUFF.SPEED_LIMIT] < 0) return null;
  const value = (id) => dbuffs[id] ?? 0;
  return Object.freeze({ ...raw, dbuffs: Object.freeze(dbuffs),
    unsupportedDbuffs: Object.freeze(Object.keys(dbuffs).map(Number).filter((id) => !supported.has(id))),
    linkDurationMs: raw.linkDuration * 1000,
    residualDurationMs: (raw.dbuffPostLinkDuration ?? 0) * 1000,
    maxSpeed: dbuffs[DBUFF.SPEED_LIMIT] ?? null,
    velocityMultiplier: Math.max(0, 1 + value(DBUFF.VELOCITY_PERCENT) / 100),
    blocksWarp: value(DBUFF.WARP_PENALTY) !== 0,
    blocksCloak: value(DBUFF.DISALLOW_CLOAK) !== 0,
    blocksJumpOrDock: value(DBUFF.DISALLOW_JUMP_OR_DOCK) !== 0,
    blocksFilament: value(DBUFF.DISALLOW_JUMP_OR_DOCK) !== 0,
    blocksTether: value(DBUFF.DISALLOW_TETHER) !== 0 || raw.applyPvpFlag === true,
    blocksMicroJump: value(DBUFF.DISABLE_MJD) !== 0 || value(DBUFF.DISABLE_MJFG) !== 0,
  });
}

module.exports = { normalizeLinkRules, DBUFF };
