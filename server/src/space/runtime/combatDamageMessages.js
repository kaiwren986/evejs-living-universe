"use strict";

const { queueDogmaEvent } = require("./dogmaEvents");

module.exports = {
  buildCombatMessageDamageDict,
  buildCombatMessageOwnerTuple,
  buildEnvironmentalDamageMessagePayload,
  buildLaserDamageMessagePayload,
  buildMarshalDict,
  getAppliedDamageAmount,
  getCombatMessageHitQuality,
  notifyEnvironmentalDamageMessage,
  notifyWeaponDamageMessages,
  resolveCombatMessageOwnerID,
};

const runtimeEntryDirname = require("path").resolve(__dirname, "..");
const path = require("path");
const log = require(path.join(runtimeEntryDirname, "../utils/logger"));
const {
  resolveTurretShot,
  resolveTurretHitQualityTier,
} = require(path.join(runtimeEntryDirname, "./combat/laserTurrets"));
const {
  ATTRIBUTE_EM_DAMAGE,
  ATTRIBUTE_EXPLOSIVE_DAMAGE,
  ATTRIBUTE_KINETIC_DAMAGE,
  ATTRIBUTE_THERMAL_DAMAGE,
} = require("./dogmaAttributeIds");
const {
  getCombatNotificationSession,
  getOwningSessionForEntity,
} = require("./entityOwnerSession");
const {
  roundNumber,
  toFiniteNumber,
  toInt,
} = require("../../common/numbers");
const {
  lazyRequire,
} = require("./runtimeModuleBoundary");

// The band table lives next to the roll that produces the quality, in
// combat/laserTurrets.js, so the two cannot drift. Turrets, vorton arcs, drones
// and fighters all classify through here.
function getCombatMessageHitQuality(shotResult) {
  return resolveTurretHitQualityTier(shotResult);
}

function getAppliedDamageAmount(damageResult) {
  if (!damageResult || damageResult.success !== true || !damageResult.data) {
    return 0;
  }

  const perLayer = Array.isArray(damageResult.data.perLayer)
    ? damageResult.data.perLayer
    : [];
  return roundNumber(
    perLayer.reduce(
      (sum, layerEntry) => sum + toFiniteNumber(layerEntry && layerEntry.appliedEffective, 0),
      0,
    ),
    6,
  );
}

function buildMarshalDict(entries = []) {
  return {
    type: "dict",
    entries,
  };
}

function buildCombatMessageDamageDict(damageVector = {}) {
  return buildMarshalDict([
    [
      ATTRIBUTE_EM_DAMAGE,
      roundNumber(toFiniteNumber(damageVector && damageVector.em, 0), 6),
    ],
    [
      ATTRIBUTE_THERMAL_DAMAGE,
      roundNumber(toFiniteNumber(damageVector && damageVector.thermal, 0), 6),
    ],
    [
      ATTRIBUTE_KINETIC_DAMAGE,
      roundNumber(toFiniteNumber(damageVector && damageVector.kinetic, 0), 6),
    ],
    [
      ATTRIBUTE_EXPLOSIVE_DAMAGE,
      roundNumber(toFiniteNumber(damageVector && damageVector.explosive, 0), 6),
    ],
  ]);
}

function resolveCombatMessageOwnerID(entity, moduleItem = null) {
  const entityCharacterID = toInt(
    entity && (
      entity.pilotCharacterID ??
      entity.characterID
    ),
    0,
  );
  if (entityCharacterID > 0) {
    return entityCharacterID;
  }

  const entityOwnerID = toInt(
    entity && (
      entity.ownerID ??
      entity.corporationID
    ),
    0,
  );
  if (entityOwnerID > 0) {
    return entityOwnerID;
  }

  return toInt(moduleItem && moduleItem.ownerID, 0);
}

function buildCombatMessageOwnerTuple(ownerID) {
  const normalizedOwnerID = toInt(ownerID, 0);
  return normalizedOwnerID > 0 ? [2, normalizedOwnerID] : null;
}

function buildLaserDamageMessagePayload({
  attackType = "me",
  attackerEntity = null,
  targetEntity = null,
  moduleItem = null,
  shotDamage = null,
  totalDamage = 0,
  hitQuality = 0,
  includeAttackerID = false,
  isBanked = false,
} = {}) {
  const resolvedShotDamage =
    shotDamage && typeof shotDamage === "object"
      ? shotDamage
      : {};
  const attackerID = (() => {
    const entityItemID = toInt(attackerEntity && attackerEntity.itemID, 0);
    if (entityItemID > 0) {
      return entityItemID;
    }
    return toInt(moduleItem && moduleItem.locationID, 0);
  })();
  const targetID = toInt(targetEntity && targetEntity.itemID, 0);
  const sourceOwnerID = resolveCombatMessageOwnerID(attackerEntity, moduleItem);
  const weaponTypeID = (() => {
    const moduleTypeID = toInt(moduleItem && moduleItem.typeID, 0);
    if (moduleTypeID > 0) {
      return moduleTypeID;
    }
    return toInt(attackerEntity && attackerEntity.typeID, 0);
  })();
  const entries = [
    ["attackType", String(attackType || "me")],
    ["source", attackerID],
    ["target", targetID],
    ["weapon", weaponTypeID],
    ["damage", roundNumber(toFiniteNumber(totalDamage, 0), 6)],
    ["damageAttributes", buildCombatMessageDamageDict(resolvedShotDamage)],
    ["splash", ""],
    ["hitQuality", toInt(hitQuality, 0)],
    ["isBanked", isBanked === true],
  ];

  const ownerTuple = buildCombatMessageOwnerTuple(sourceOwnerID);
  if (ownerTuple) {
    entries.push(["owner", ownerTuple]);
  }
  if (includeAttackerID && attackerID > 0) {
    entries.push(["attackerID", attackerID]);
  }

  // The stock logger needs a player identity when a firing fighter is gone.
  // Bombs retain these explicit pilot fields in their immutable launch source.
  const sourceCharacterID = toInt(attackerEntity && attackerEntity.characterID, 0);
  const sourcePilotID = toInt(attackerEntity && attackerEntity.pilotCharacterID, 0);
  if (
    attackerEntity && attackerEntity.kind === "fighter" &&
    sourceCharacterID > 0 && sourceCharacterID === sourcePilotID &&
    lazyRequire("../services/character/characterState").peekCharacterRecord(sourceCharacterID)
  ) {
    entries.push(["sourceCharID", sourceCharacterID]);
  }

  return buildMarshalDict(entries);
}

function notifyWeaponDamageMessages(
  attackerEntity,
  targetEntity,
  moduleItem,
  shotDamage,
  totalDamage,
  hitQuality = 0,
  options = {},
) {
  if (!targetEntity || !moduleItem) {
    return false;
  }

  try {
    const droneRuntime = lazyRequire("../services/drone/droneRuntime");
    if (droneRuntime && typeof droneRuntime.noteIncomingAggression === "function") {
      droneRuntime.noteIncomingAggression(
        attackerEntity,
        targetEntity,
        Date.now(),
      );
    }
  } catch (error) {
    log.warn(`[SpaceRuntime] Drone aggression note failed: ${error.message}`);
  }

  const resolvedShotDamage =
    shotDamage && typeof shotDamage === "object"
      ? shotDamage
      : {};
  const resolvedTotalDamage = roundNumber(toFiniteNumber(totalDamage, 0), 6);
  let notified = false;

  const attackerSession = getCombatNotificationSession(attackerEntity);
  if (attackerSession) {
    queueDogmaEvent(attackerSession, "OnDamageMessage", [
      buildLaserDamageMessagePayload({
        attackType: "me",
        attackerEntity,
        targetEntity,
        moduleItem,
        shotDamage: resolvedShotDamage,
        totalDamage: resolvedTotalDamage,
        hitQuality,
        isBanked: options && options.isBanked === true,
      }),
    ]);
    notified = true;
  }

  const targetSession = getCombatNotificationSession(targetEntity);
  if (targetSession && targetSession !== attackerSession) {
    queueDogmaEvent(targetSession, "OnDamageMessage", [
      buildLaserDamageMessagePayload({
        attackType: "otherPlayerWeapons",
        attackerEntity,
        targetEntity,
        moduleItem,
        shotDamage: resolvedShotDamage,
        totalDamage: resolvedTotalDamage,
        hitQuality,
        includeAttackerID: true,
        isBanked: options && options.isBanked === true,
      }),
    ]);
    notified = true;
  }

  return notified;
}

function buildEnvironmentalDamageMessagePayload({
  sourceEntity = null,
  targetEntity = null,
  sourceName = "Environmental Hazard",
  totalDamage = 0,
  hitQuality = 4,
} = {}) {
  return buildMarshalDict([
    ["attackType", "otherPlayerWeapons"],
    ["source", toInt(sourceEntity && sourceEntity.itemID, 0)],
    ["sourceName", String(sourceName || "Environmental Hazard")],
    ["target", toInt(targetEntity && targetEntity.itemID, 0)],
    ["damage", roundNumber(toFiniteNumber(totalDamage, 0), 6)],
    ["splash", ""],
    ["hitQuality", toInt(hitQuality, 4)],
    ["isBanked", false],
    ["environmental", true],
  ]);
}

function notifyEnvironmentalDamageMessage(
  scene,
  sourceEntity,
  targetEntity,
  sourceName,
  totalDamage,
) {
  const targetSession = getOwningSessionForEntity(scene, targetEntity);
  if (!targetSession || typeof targetSession.sendNotification !== "function") {
    return false;
  }
  queueDogmaEvent(targetSession, "OnDamageMessage", [
    buildEnvironmentalDamageMessagePayload({
      sourceEntity,
      targetEntity,
      sourceName,
      totalDamage,
      // Existing combat-message quality 4 is the ordinary "Hits" quality.
      hitQuality: 4,
    }),
  ]);
  return true;
}
