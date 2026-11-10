"use strict";

const {
  toFiniteNumber,
  toInt,
} = require("../../common/numbers");

const path = require("path");

const {
  getAttributeIDByNames,
  getTypeAttributeMap,
} = require(path.join(__dirname, "../../services/fitting/liveFittingState"));
const {
  buildLiveModuleAttributeMap,
} = require(path.join(__dirname, "./liveModuleAttributes"));
// localCycleRuntime is required lazily: it and this module sit on either side of
// a require cycle, so binding its exports at load time yields a half-built
// module whose own imports are still undefined.
let cachedLocalCycleRuntime = null;
function getLocalCycleRuntime() {
  if (!cachedLocalCycleRuntime) {
    cachedLocalCycleRuntime = require(path.join(__dirname, "./localCycleRuntime"));
  }
  return cachedLocalCycleRuntime;
}
const {
  queueAutomaticLocalModuleReload,
} = require(path.join(__dirname, "./localCycleReloads"));
const {
  getDisruptiveLanceRemoteRepairMultiplier,
} = require(path.join(__dirname, "./superweapons/disruptiveLanceDebuff"));
const {
  getActiveImplantLocationModifierSources,
  getActiveImplantShipModifierEntries,
} = require(path.join(
  __dirname,
  "../../services/dogma/implants/activeImplantModifiers",
));
const {
  canEntitiesInteractLocally,
} = require(path.join(__dirname, "../destiny/identity/interactionScope"));
const {
  SKILL_GUNNERY,
  filterProjectedWeaponModifierEntries,
} = require(path.join(__dirname, "./projectedWeaponModifiers"));
const starbaseRepair = require("../../services/starbase/starbaseRepairRuntime");

const ATTRIBUTE_CAPACITOR_NEED = getAttributeIDByNames("capacitorNeed") || 6;
const ATTRIBUTE_DURATION = getAttributeIDByNames("duration") || 73;
const ATTRIBUTE_SPEED = getAttributeIDByNames("speed") || 51;
const ATTRIBUTE_MAX_RANGE = getAttributeIDByNames("maxRange") || 54;
const ATTRIBUTE_MAX_TARGET_RANGE = getAttributeIDByNames("maxTargetRange") || 76;
const ATTRIBUTE_SCAN_RESOLUTION = getAttributeIDByNames("scanResolution") || 564;
const ATTRIBUTE_FALLOFF_EFFECTIVENESS = getAttributeIDByNames("falloffEffectiveness") || 2044;
const ATTRIBUTE_SHIELD_BONUS = getAttributeIDByNames("shieldBonus") || 68;
const ATTRIBUTE_ARMOR_DAMAGE_AMOUNT = getAttributeIDByNames("armorDamageAmount") || 84;
const ATTRIBUTE_CHARGED_ARMOR_DAMAGE_MULTIPLIER =
  getAttributeIDByNames("chargedArmorDamageMultiplier") || 1886;
// dogma/const.py: attributeChargeRate = 56. Its own SDE description is "Number
// of charges consumed per activation" and it displays as "Charges Per Cycle";
// its default is 1, so a module that does not declare it burns one unit.
const ATTRIBUTE_CHARGE_RATE = getAttributeIDByNames("chargeRate") || 56;
const ATTRIBUTE_RELOAD_TIME = getAttributeIDByNames("reloadTime") || 1795;
// dogma/const.py: attributeRepairMultiplierBonusPerCycle = 2796,
// attributeRepairMultiplierBonusMax = 2797. Effect 7166 ships EMPTY
// modifierInfo, so these two attributes are the whole contract for the
// Mutadaptive Remote Armor Repairer's ramp-up.
const ATTRIBUTE_REPAIR_MULTIPLIER_BONUS_PER_CYCLE =
  getAttributeIDByNames("repairMultiplierBonusPerCycle") || 2796;
const ATTRIBUTE_REPAIR_MULTIPLIER_BONUS_MAX =
  getAttributeIDByNames("repairMultiplierBonusMax") || 2797;
const ATTRIBUTE_STRUCTURE_DAMAGE_AMOUNT = getAttributeIDByNames("structureDamageAmount") || 83;
const ATTRIBUTE_POWER_TRANSFER_AMOUNT = getAttributeIDByNames("powerTransferAmount") || 90;
const ATTRIBUTE_MAX_TARGET_RANGE_BONUS =
  getAttributeIDByNames("maxTargetRangeBonus") || 309;
const ATTRIBUTE_SCAN_RESOLUTION_BONUS =
  getAttributeIDByNames("scanResolutionBonus") || 566;
const ATTRIBUTE_MAX_RANGE_BONUS = getAttributeIDByNames("maxRangeBonus") || 351;
const ATTRIBUTE_FALLOFF_BONUS = getAttributeIDByNames("falloffBonus") || 349;
const ATTRIBUTE_TRACKING_SPEED_BONUS =
  getAttributeIDByNames("trackingSpeedBonus") || 767;
const ATTRIBUTE_TRACKING_SPEED = getAttributeIDByNames("trackingSpeed") || 160;
const ATTRIBUTE_WEAPON_FALLOFF = getAttributeIDByNames("falloff") || 158;
const ATTRIBUTE_SCAN_GRAVIMETRIC_STRENGTH_PERCENT =
  getAttributeIDByNames("scanGravimetricStrengthPercent") || 1027;
const ATTRIBUTE_SCAN_LADAR_STRENGTH_PERCENT =
  getAttributeIDByNames("scanLadarStrengthPercent") || 1028;
const ATTRIBUTE_SCAN_MAGNETOMETRIC_STRENGTH_PERCENT =
  getAttributeIDByNames("scanMagnetometricStrengthPercent") || 1029;
const ATTRIBUTE_SCAN_RADAR_STRENGTH_PERCENT =
  getAttributeIDByNames("scanRadarStrengthPercent") || 1030;
const ATTRIBUTE_SCAN_GRAVIMETRIC_STRENGTH =
  getAttributeIDByNames("scanGravimetricStrength") || 211;
const ATTRIBUTE_SCAN_LADAR_STRENGTH =
  getAttributeIDByNames("scanLadarStrength") || 209;
const ATTRIBUTE_SCAN_MAGNETOMETRIC_STRENGTH =
  getAttributeIDByNames("scanMagnetometricStrength") || 210;
const ATTRIBUTE_SCAN_RADAR_STRENGTH =
  getAttributeIDByNames("scanRadarStrength") || 208;
const ATTRIBUTE_REMOTE_REPAIR_IMPEDANCE =
  getAttributeIDByNames("remoteRepairImpedance") || 2116;
const ATTRIBUTE_REMOTE_RESISTANCE_ID = getAttributeIDByNames("remoteResistanceID") || 2138;
const ATTRIBUTE_MAX_GROUP_ACTIVE = getAttributeIDByNames("maxGroupActive") || 763;
const ATTRIBUTE_REACTIVATION_DELAY =
  getAttributeIDByNames("moduleReactivationDelay", "reactivationDelay") || 669;
const ATTRIBUTE_DISALLOW_ASSISTANCE =
  getAttributeIDByNames("disallowAssistance") || 854;
const ATTRIBUTE_ENTOSIS_ASSISTANCE_IMPEDANCE_MULTIPLIER =
  getAttributeIDByNames("entosisAssistanceImpedanceMultiplier") || 2754;
const DOGMA_OP_POST_PERCENT = 6;
const PERSISTENT_SPECIAL_FX_WINDOW_MS = 12 * 60 * 60 * 1000;
const CATEGORY_STRUCTURE = 65;
const STRUCTURE_REMOTE_REPAIR_ERROR = "STRUCTURE_REMOTE_REPAIR_NOT_ALLOWED";
const DISALLOWED_ASSISTANCE_ERROR = "TARGET_DISALLOWS_ASSISTANCE";
const REMOTE_REPAIR_FAMILIES = new Set([
  "remoteShield",
  "remoteArmor",
  "remoteHull",
]);
const ASSISTANCE_FAMILY_REMOTE_CAPACITOR = "remoteCapacitor";
const ASSISTANCE_FAMILY_REMOTE_SENSOR_BOOST = "remoteSensorBoost";
const ASSISTANCE_FAMILY_REMOTE_TRACKING = "remoteTracking";

const ASSISTANCE_EFFECTS = Object.freeze({
  shipmoduleremotecapacitortransmitter: Object.freeze({
    family: ASSISTANCE_FAMILY_REMOTE_CAPACITOR,
    jammingType: "energyTransfer",
  }),
  npcbehaviorremotecapacitortransmitter: Object.freeze({
    family: ASSISTANCE_FAMILY_REMOTE_CAPACITOR,
    jammingType: "energyTransfer",
  }),
  shipmoduleremoteshieldbooster: Object.freeze({
    family: "remoteShield",
    jammingType: "shieldTransfer",
  }),
  shipmoduleremotearmorrepairer: Object.freeze({
    family: "remoteArmor",
    jammingType: "remoteArmorRepair",
  }),
  // The ancillary variants repair exactly like their plain counterparts off
  // armorDamageAmount / shieldBonus; what makes them ancillary is the charge
  // they can burn for a bigger cycle. Being absent from this table left them
  // unmatched, so activation fell through to the generic path and they cycled,
  // drew capacitor and healed nothing at all.
  shipmoduleancillaryremotearmorrepairer: Object.freeze({
    family: "remoteArmor",
    jammingType: "remoteArmorRepair",
    ancillaryChargeMultiplierAttributeID: ATTRIBUTE_CHARGED_ARMOR_DAMAGE_MULTIPLIER,
  }),
  shipmoduleancillaryremoteshieldbooster: Object.freeze({
    family: "remoteShield",
    jammingType: "shieldTransfer",
    // The shield variant's cap boosters pay its capacitor cost rather than
    // multiplying the boost, so it declares no charge multiplier.
    //
    // Nothing here has to waive that capacitor cost either: dogma already
    // reports capacitorNeed as 0 while a booster is loaded, and the assistance
    // cycle boundary rebuilds this whole snapshot from live attributes every
    // cycle, so the declared cost comes back by itself the moment it runs dry.
    ancillaryChargeMultiplierAttributeID: 0,
  }),
  shipmoduleremotearmormutadaptiverepairer: Object.freeze({
    family: "remoteArmor",
    jammingType: "RemoteArmorMutadaptiveRepairer",
  }),
  shipmoduleremotehullrepairer: Object.freeze({
    family: "remoteHull",
    jammingType: "remoteHullRepair",
  }),
  npcbehaviorremotearmorrepairer: Object.freeze({
    family: "remoteArmor",
    jammingType: "remoteArmorRepair",
  }),
  remotesensorboostfalloff: Object.freeze({
    family: ASSISTANCE_FAMILY_REMOTE_SENSOR_BOOST,
    jammingType: "remoteSensorBoost",
    stackingPenalized: true,
    affectsTargetDerivedState: true,
    moduleModifierSpecs: Object.freeze([
      Object.freeze({
        sourceAttributeID: ATTRIBUTE_MAX_TARGET_RANGE_BONUS,
        modifiedAttributeID: ATTRIBUTE_MAX_TARGET_RANGE,
        operation: DOGMA_OP_POST_PERCENT,
      }),
      Object.freeze({
        sourceAttributeID: ATTRIBUTE_SCAN_RESOLUTION_BONUS,
        modifiedAttributeID: ATTRIBUTE_SCAN_RESOLUTION,
        operation: DOGMA_OP_POST_PERCENT,
      }),
      Object.freeze({
        sourceAttributeID: ATTRIBUTE_SCAN_GRAVIMETRIC_STRENGTH_PERCENT,
        modifiedAttributeID: ATTRIBUTE_SCAN_GRAVIMETRIC_STRENGTH,
        operation: DOGMA_OP_POST_PERCENT,
      }),
      Object.freeze({
        sourceAttributeID: ATTRIBUTE_SCAN_LADAR_STRENGTH_PERCENT,
        modifiedAttributeID: ATTRIBUTE_SCAN_LADAR_STRENGTH,
        operation: DOGMA_OP_POST_PERCENT,
      }),
      Object.freeze({
        sourceAttributeID: ATTRIBUTE_SCAN_MAGNETOMETRIC_STRENGTH_PERCENT,
        modifiedAttributeID: ATTRIBUTE_SCAN_MAGNETOMETRIC_STRENGTH,
        operation: DOGMA_OP_POST_PERCENT,
      }),
      Object.freeze({
        sourceAttributeID: ATTRIBUTE_SCAN_RADAR_STRENGTH_PERCENT,
        modifiedAttributeID: ATTRIBUTE_SCAN_RADAR_STRENGTH,
        operation: DOGMA_OP_POST_PERCENT,
      }),
    ]),
  }),
  shipmoduleremotetrackingcomputer: Object.freeze({
    family: ASSISTANCE_FAMILY_REMOTE_TRACKING,
    jammingType: "remoteTracking",
    stackingPenalized: true,
    affectsTargetDerivedState: false,
    // remoteTrackingComputer.py declares these three as
    // SKILL_MODIFIER_CHANGES_FOR_LOCATION rows keyed on invConst.typeGunnery,
    // so they only reach weapons on the target that require Gunnery. Without
    // the key they also reached Vorton Projectors, which require Vorton
    // Projector Operation and are the one published weapon family that
    // declares maxRange without requiring Gunnery.
    weaponModuleModifierSpecs: Object.freeze([
      Object.freeze({
        sourceAttributeID: ATTRIBUTE_MAX_RANGE_BONUS,
        modifiedAttributeID: ATTRIBUTE_MAX_RANGE,
        operation: DOGMA_OP_POST_PERCENT,
        requiredSkillTypeID: SKILL_GUNNERY,
      }),
      Object.freeze({
        sourceAttributeID: ATTRIBUTE_FALLOFF_BONUS,
        modifiedAttributeID: ATTRIBUTE_WEAPON_FALLOFF,
        operation: DOGMA_OP_POST_PERCENT,
        requiredSkillTypeID: SKILL_GUNNERY,
      }),
      Object.freeze({
        sourceAttributeID: ATTRIBUTE_TRACKING_SPEED_BONUS,
        modifiedAttributeID: ATTRIBUTE_TRACKING_SPEED,
        operation: DOGMA_OP_POST_PERCENT,
        requiredSkillTypeID: SKILL_GUNNERY,
      }),
    ]),
  }),
});

function roundNumber(value, digits = 6) {
  return Number(toFiniteNumber(value, 0).toFixed(digits));
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, toFiniteNumber(value, min)));
}

function normalizeEffectName(effectRecord) {
  return String(effectRecord && effectRecord.name || "").trim().toLowerCase();
}

function resolveAssistanceDefinition(effectRecord) {
  return ASSISTANCE_EFFECTS[normalizeEffectName(effectRecord)] || null;
}

function isStructureEntity(entity) {
  return Boolean(
    entity && (
      entity.kind === "structure" ||
      toInt(entity.categoryID, 0) === CATEGORY_STRUCTURE
    ),
  );
}

// `disallowAssistance` (854): "If this module is in use and this attribute is 1,
// then assistance modules cannot be used on the ship." Eleven published module
// types carry it — the eight Warp Disruption Field Generators and the three Jump
// Portal Generators — so this is read off the attribute rather than off a type
// or effect whitelist, and it covers every family this runtime serves: remote
// reps, remote capacitor transmitters, remote sensor boosters and remote
// tracking computers.
function effectStateDisallowsAssistance(effectState, nowMs) {
  if (!effectState || typeof effectState !== "object") {
    return false;
  }
  if (toFiniteNumber(effectState.deactivatedAtMs, 0) > 0) {
    return false;
  }
  const now = toFiniteNumber(nowMs, 0);
  if (now > 0) {
    const startedAtMs = toFiniteNumber(effectState.startedAtMs, 0);
    if (startedAtMs > 0 && startedAtMs > now) {
      return false;
    }
    const expiresAtMs = toFiniteNumber(effectState.expiresAtMs, 0);
    if (expiresAtMs > 0 && expiresAtMs <= now) {
      return false;
    }
  }

  const overrides =
    effectState.genericAttributeOverrides &&
    typeof effectState.genericAttributeOverrides === "object"
      ? effectState.genericAttributeOverrides
      : null;
  if (overrides) {
    const overridden = Number(
      overrides[String(ATTRIBUTE_DISALLOW_ASSISTANCE)] ??
        overrides[ATTRIBUTE_DISALLOW_ASSISTANCE],
    );
    if (Number.isFinite(overridden)) {
      return overridden > 0;
    }
  }

  const typeAttributes = getTypeAttributeMap(toInt(effectState.typeID, 0)) || {};
  return toFiniteNumber(typeAttributes[ATTRIBUTE_DISALLOW_ASSISTANCE], 0) > 0;
}

function isEntityAssistanceDisallowed(entity, nowMs = 0) {
  if (
    !entity ||
    !entity.activeModuleEffects ||
    typeof entity.activeModuleEffects.values !== "function"
  ) {
    return false;
  }
  for (const effectState of entity.activeModuleEffects.values()) {
    if (effectStateDisallowsAssistance(effectState, nowMs)) {
      return true;
    }
  }
  return false;
}

// The structure state module is required lazily; it sits on the far side of a
// require cycle with the space runtime this module serves.
function getStructureState() {
  return require(path.join(__dirname, "../../services/structure/structureState"));
}

// An Upwell structure that cannot repair itself (CanHaveAutoRepair 0: the
// Ansiblex and the Metenox) must be repaired by hand, so remote repair lands on
// it. Every other Upwell structure refuses remote repair.
function isManuallyRepairedStructure(entity) {
  return isStructureEntity(entity) && !getStructureState().canStructureAutoRepair(entity);
}

function isAssistanceTargetEntity(effectData, entity) {
  if (
    entity?.homefrontKey &&
    require("../../services/homefront/homefrontHooks").runtime.acceptsAssistance(
      entity,
      effectData && (effectData.family || effectData.assistanceFamily),
    )
  )
    return true;
  return Boolean(
    entity && (
      entity.kind === "ship" ||
      (
        (
          entity.kind === "drone" ||
          starbaseRepair.isStarbaseEntity(entity) ||
          isManuallyRepairedStructure(entity)
        ) &&
        isRemoteRepairFamily(
          effectData && (effectData.family || effectData.assistanceFamily),
        )
      )
    ),
  );
}

function homefrontAssistanceRejection(effectData, source, target) {
  const family =
    effectData && (effectData.family || effectData.assistanceFamily);
  if (
    target?.homefrontKey &&
    target.homefrontRole === "dread" &&
    family === "remoteCapacitor" &&
    canEntitiesInteractLocally(source, target) &&
    !require("../../services/homefront/homefrontHooks").runtime.acceptsAssistance(
      target,
      family,
    )
  ) {
    const {
      DREAD_SIEGE_ERROR,
      DREAD_SIEGE_STOP_REASON,
    } = require("../../services/homefront/homefrontMessages");
    return {
      success: false,
      errorMsg: DREAD_SIEGE_ERROR,
      stopReason: DREAD_SIEGE_STOP_REASON,
    };
  }
  return null;
}

function isRemoteRepairFamily(value) {
  return REMOTE_REPAIR_FAMILIES.has(String(value || ""));
}

function isBlockedStructureRemoteRepair(effectData, targetEntity) {
  const family = effectData
    ? effectData.family || effectData.assistanceFamily
    : null;
  return (
    isStructureEntity(targetEntity) &&
    isRemoteRepairFamily(family) &&
    !isManuallyRepairedStructure(targetEntity)
  );
}

function getPreferredAttributeValue(moduleAttributes, attributeIDs, fallback = 0) {
  const resolvedAttributes =
    moduleAttributes && typeof moduleAttributes === "object"
      ? moduleAttributes
      : null;
  if (!resolvedAttributes) {
    return toFiniteNumber(fallback, 0);
  }

  for (const attributeID of Array.isArray(attributeIDs) ? attributeIDs : [attributeIDs]) {
    const numericAttributeID = toInt(attributeID, 0);
    if (numericAttributeID <= 0) {
      continue;
    }
    const numericValue = Number(resolvedAttributes[numericAttributeID]);
    if (Number.isFinite(numericValue)) {
      return numericValue;
    }
  }

  return toFiniteNumber(fallback, 0);
}

function getEntityPassiveAttributeValue(entity, attributeID, fallback = 0) {
  const attributes =
    entity &&
    entity.passiveDerivedState &&
    entity.passiveDerivedState.attributes &&
    typeof entity.passiveDerivedState.attributes === "object"
      ? entity.passiveDerivedState.attributes
      : null;
  const numericAttributeID = toInt(attributeID, 0);
  if (attributes && Number.isFinite(Number(attributes[numericAttributeID]))) {
    return Number(attributes[numericAttributeID]);
  }
  return toFiniteNumber(fallback, 0);
}

function resolveRemoteAssistanceMultiplier(targetEntity, resistanceAttributeID) {
  const normalizedResistanceAttributeID = toInt(resistanceAttributeID, 0);
  const targetResistanceAttributeID = normalizedResistanceAttributeID > 0
    ? normalizedResistanceAttributeID
    : ATTRIBUTE_REMOTE_REPAIR_IMPEDANCE;
  // Unit 108 is an inverse absolute percent: 1 applies fully, 0 is fully impeded.
  return roundNumber(clamp(
    getEntityPassiveAttributeValue(targetEntity, targetResistanceAttributeID, 1),
    0,
    1,
  ), 6);
}

// Effect 6104 gives every capital hull entosisAssistanceImpedanceMultiplier
// 0.00001 and PostAssigns it onto a fitted Entosis Link; subcapitals have no
// such attribute, so the module's own 1 stands. Retail applies that number to
// everything a ship receives while its link runs: remote reps, capacitor and
// boosts land on a linking capital at 0.00001 of their amount, which is the
// "capitals may not receive remote assistance" rule in the SDE's own terms.
function resolveEntosisAssistanceImpedanceMultiplier(targetEntity) {
  const { hasActiveEntosisLinkEffect } = require(path.join(
    __dirname,
    "./entosisLinkRuntime",
  ));
  if (!hasActiveEntosisLinkEffect(targetEntity)) {
    return 1;
  }
  const passiveValue = getEntityPassiveAttributeValue(
    targetEntity,
    ATTRIBUTE_ENTOSIS_ASSISTANCE_IMPEDANCE_MULTIPLIER,
    -1,
  );
  let multiplier = passiveValue;
  if (!(multiplier >= 0)) {
    const typeAttributes = getTypeAttributeMap(toInt(targetEntity.typeID, 0)) || {};
    multiplier = toFiniteNumber(
      typeAttributes[ATTRIBUTE_ENTOSIS_ASSISTANCE_IMPEDANCE_MULTIPLIER],
      1,
    );
  }
  return roundNumber(clamp(multiplier, 0, 1), 6);
}

function resolveAssistanceResistanceMultiplier(
  effectState,
  targetEntity,
  nowMs = Date.now(),
) {
  const family = String(effectState && effectState.assistanceFamily || "");
  const resistanceAttributeID = toInt(
    effectState && effectState.assistanceRemoteResistanceAttributeID,
    0,
  );
  let baseMultiplier = 1;
  if (resistanceAttributeID > 0) {
    baseMultiplier = resolveRemoteAssistanceMultiplier(
      targetEntity,
      resistanceAttributeID,
    );
  } else if (
    isRemoteRepairFamily(family) ||
    family === ASSISTANCE_FAMILY_REMOTE_CAPACITOR
  ) {
    baseMultiplier = resolveRemoteAssistanceMultiplier(targetEntity, 0);
  }

  // "a 50% reduction to incoming remote repair" for the life of a Disruptive
  // Lance debuff. CCP scope this to repair specifically, so remote capacitor
  // transfer is left alone even though it shares the impedance attribute here.
  const disruptiveLanceMultiplier = isRemoteRepairFamily(family)
    ? getDisruptiveLanceRemoteRepairMultiplier(targetEntity, nowMs)
    : 1;

  const entosisMultiplier = resolveEntosisAssistanceImpedanceMultiplier(targetEntity);
  return roundNumber(
    Math.max(baseMultiplier, 0) *
      Math.max(disruptiveLanceMultiplier, 0) *
      Math.max(entosisMultiplier, 0),
    6,
  );
}

function resolvePersistentRepeat(durationMs) {
  const cycleMs = Math.max(1, toFiniteNumber(durationMs, 1000));
  return Math.max(1, Math.ceil(PERSISTENT_SPECIAL_FX_WINDOW_MS / cycleMs));
}

// `toFiniteNumber(Infinity, 0)` is 0, so folding the range read straight into
// it collapsed an unmeasurable distance to POINT BLANK — a remote repper or cap
// transfer landing at full strength from any range, the fail-open mirror of the
// tractor beam's fail-closed bug. Keep the two cases it conflated apart. A wired
// reader that answers non-finite means the pair genuinely cannot be measured
// this tick, and a repair that cannot be placed has to be refused rather than
// applied at zero metres. An absent reader says something different: every
// production caller wires one, so only a harness that does not gate on range at
// all reaches that branch, and it keeps the old zero.
function readCallbackSurfaceDistanceMeters(callbacks, sourceEntity, targetEntity) {
  if (!callbacks || typeof callbacks.getEntitySurfaceDistance !== "function") {
    return 0;
  }
  const reported = Number(
    callbacks.getEntitySurfaceDistance(sourceEntity, targetEntity),
  );
  return Number.isFinite(reported) ? Math.max(0, reported) : Number.NaN;
}

function resolveAssistanceMultiplier(effectState, sourceEntity, targetEntity, callbacks = {}) {
  const surfaceDistance = readCallbackSurfaceDistanceMeters(
    callbacks,
    sourceEntity,
    targetEntity,
  );
  if (!Number.isFinite(surfaceDistance)) {
    return {
      success: false,
      errorMsg: "TARGET_OUT_OF_RANGE",
      stopReason: "target",
      surfaceDistance: Infinity,
    };
  }
  const optimalRangeMeters = Math.max(
    0,
    toFiniteNumber(effectState && effectState.assistanceMaxRangeMeters, 0),
  );
  const falloffMeters = Math.max(
    0,
    toFiniteNumber(effectState && effectState.assistanceFalloffMeters, 0),
  );

  if (surfaceDistance <= optimalRangeMeters + 1) {
    return {
      success: true,
      multiplier: 1,
      surfaceDistance,
    };
  }
  if (falloffMeters <= 0) {
    return {
      success: false,
      errorMsg: "TARGET_OUT_OF_RANGE",
      stopReason: "target",
      surfaceDistance,
    };
  }

  const distanceIntoFalloff = surfaceDistance - optimalRangeMeters;
  if (distanceIntoFalloff > falloffMeters + 1) {
    return {
      success: false,
      errorMsg: "TARGET_OUT_OF_RANGE",
      stopReason: "target",
      surfaceDistance,
    };
  }

  const normalizedDistance = distanceIntoFalloff / Math.max(falloffMeters, 1);
  return {
    success: true,
    multiplier: roundNumber(0.5 ** (normalizedDistance ** 2), 6),
    surfaceDistance,
  };
}

function buildAssistanceModifierEntries(attributeMap, modifierSpecs = [], stackingPenalized = false) {
  const entries = [];
  for (const modifierSpec of Array.isArray(modifierSpecs) ? modifierSpecs : []) {
    const sourceAttributeID = toInt(modifierSpec && modifierSpec.sourceAttributeID, 0);
    const modifiedAttributeID = toInt(modifierSpec && modifierSpec.modifiedAttributeID, 0);
    const operation = toInt(modifierSpec && modifierSpec.operation, -1);
    if (sourceAttributeID <= 0 || modifiedAttributeID <= 0 || operation < 0) {
      continue;
    }
    const value = toFiniteNumber(attributeMap && attributeMap[sourceAttributeID], NaN);
    if (!Number.isFinite(value) || Math.abs(value) <= 1e-9) {
      continue;
    }
    const requiredSkillTypeID = toInt(modifierSpec && modifierSpec.requiredSkillTypeID, 0);
    entries.push(Object.freeze({
      modifiedAttributeID,
      operation,
      value: roundNumber(value, 6),
      stackingPenalized: stackingPenalized === true,
      ...(requiredSkillTypeID > 0 ? { requiredSkillTypeID } : {}),
    }));
  }
  return Object.freeze(entries);
}

function buildTargetAssistanceStateKey(sourceBallID, moduleID, targetBallID) {
  return [
    toInt(sourceBallID, 0),
    toInt(moduleID, 0),
    toInt(targetBallID, 0),
  ].join(":");
}

function ensureTargetAssistanceState(targetEntity, create = false) {
  if (!targetEntity || typeof targetEntity !== "object") {
    return null;
  }
  if (!targetEntity.assistanceModuleState && create) {
    targetEntity.assistanceModuleState = {
      incomingEffects: new Map(),
      modifierEntries: Object.freeze([]),
      weaponModuleModifierEntries: Object.freeze([]),
      weaponChargeModifierEntries: Object.freeze([]),
      aggregateSignature: "",
    };
  }
  return (
    targetEntity.assistanceModuleState &&
    targetEntity.assistanceModuleState.incomingEffects instanceof Map
  )
    ? targetEntity.assistanceModuleState
    : null;
}

function hasAssistanceModifierEffect(effectState) {
  return Boolean(
    effectState &&
    (
      (
        Array.isArray(effectState.assistanceModifierEntries) &&
        effectState.assistanceModifierEntries.length > 0
      ) ||
      (
        Array.isArray(effectState.assistanceWeaponModuleModifierEntries) &&
        effectState.assistanceWeaponModuleModifierEntries.length > 0
      ) ||
      (
        Array.isArray(effectState.assistanceWeaponChargeModifierEntries) &&
        effectState.assistanceWeaponChargeModifierEntries.length > 0
      )
    )
  );
}

function buildAssistanceTargetRecord(sourceEntity, effectState, targetEntity, nowMs, rangeMultiplier) {
  return Object.freeze({
    key: buildTargetAssistanceStateKey(
      sourceEntity && sourceEntity.itemID,
      effectState && effectState.moduleID,
      targetEntity && targetEntity.itemID,
    ),
    sourceBallID: toInt(sourceEntity && sourceEntity.itemID, 0),
    moduleID: toInt(effectState && effectState.moduleID, 0),
    effectID: toInt(effectState && effectState.effectID, 0),
    moduleTypeID: toInt(effectState && effectState.typeID, 0),
    moduleGroupID: toInt(effectState && effectState.groupID, 0),
    chargeTypeID: toInt(effectState && effectState.chargeTypeID, 0),
    targetBallID: toInt(targetEntity && targetEntity.itemID, 0),
    family: String(effectState && effectState.assistanceFamily || ""),
    jammingType: String(effectState && effectState.assistanceJammingType || ""),
    startedAtMs: Math.max(0, toFiniteNumber(nowMs, Date.now())),
    expiresAtMs: Math.max(
      0,
      toFiniteNumber(nowMs, Date.now()) +
        Math.max(1, toFiniteNumber(effectState && effectState.durationMs, 1000)),
    ),
    rangeMultiplier: roundNumber(rangeMultiplier, 6),
    resistanceAttributeID: toInt(effectState && effectState.assistanceRemoteResistanceAttributeID, 0),
    modifierEntries: Object.freeze(
      (Array.isArray(effectState && effectState.assistanceModifierEntries)
        ? effectState.assistanceModifierEntries
        : []
      ).map((entry) => Object.freeze({ ...entry })),
    ),
    weaponModuleModifierEntries: Object.freeze(
      (Array.isArray(effectState && effectState.assistanceWeaponModuleModifierEntries)
        ? effectState.assistanceWeaponModuleModifierEntries
        : []
      ).map((entry) => Object.freeze({ ...entry })),
    ),
    weaponChargeModifierEntries: Object.freeze(
      (Array.isArray(effectState && effectState.assistanceWeaponChargeModifierEntries)
        ? effectState.assistanceWeaponChargeModifierEntries
        : []
      ).map((entry) => Object.freeze({ ...entry })),
    ),
  });
}

function buildAggregateSignature(modifierEntries, weaponModuleModifierEntries, weaponChargeModifierEntries) {
  return JSON.stringify({
    entries: (Array.isArray(modifierEntries) ? modifierEntries : []).map((entry) => ({
      attribute: toInt(entry && entry.modifiedAttributeID, 0),
      operation: toInt(entry && entry.operation, 0),
      value: roundNumber(entry && entry.value, 6),
      stackingPenalized: entry && entry.stackingPenalized === true,
    })),
    weaponModuleEntries: (Array.isArray(weaponModuleModifierEntries) ? weaponModuleModifierEntries : []).map((entry) => ({
      attribute: toInt(entry && entry.modifiedAttributeID, 0),
      operation: toInt(entry && entry.operation, 0),
      value: roundNumber(entry && entry.value, 6),
      stackingPenalized: entry && entry.stackingPenalized === true,
    })),
    weaponChargeEntries: (Array.isArray(weaponChargeModifierEntries) ? weaponChargeModifierEntries : []).map((entry) => ({
      attribute: toInt(entry && entry.modifiedAttributeID, 0),
      operation: toInt(entry && entry.operation, 0),
      value: roundNumber(entry && entry.value, 6),
      stackingPenalized: entry && entry.stackingPenalized === true,
    })),
  });
}

function appendScaledModifierEntries(destination, entries, scaledMultiplier) {
  for (const entry of Array.isArray(entries) ? entries : []) {
    const value = roundNumber(
      toFiniteNumber(entry && entry.value, 0) * Math.max(scaledMultiplier, 0),
      6,
    );
    if (Math.abs(value) <= 1e-6) {
      continue;
    }
    const requiredSkillTypeID = toInt(entry && entry.requiredSkillTypeID, 0);
    destination.push({
      modifiedAttributeID: toInt(entry && entry.modifiedAttributeID, 0),
      operation: toInt(entry && entry.operation, -1),
      value,
      stackingPenalized: entry && entry.stackingPenalized === true,
      ...(requiredSkillTypeID > 0 ? { requiredSkillTypeID } : {}),
    });
  }
}

function recomputeTargetAssistanceAggregateState(targetEntity) {
  const targetState = ensureTargetAssistanceState(targetEntity, false);
  if (!targetState) {
    return {
      changed: false,
      modifierEntries: [],
      weaponModuleModifierEntries: [],
      weaponChargeModifierEntries: [],
    };
  }

  const modifierEntries = [];
  const weaponModuleModifierEntries = [];
  const weaponChargeModifierEntries = [];
  for (const record of targetState.incomingEffects.values()) {
    if (!record) {
      continue;
    }
    const resistanceMultiplier = record.resistanceAttributeID > 0
      ? resolveRemoteAssistanceMultiplier(targetEntity, record.resistanceAttributeID)
      : 1;
    const scaledMultiplier =
      Math.max(record.rangeMultiplier, 0) *
      Math.max(resistanceMultiplier, 0);
    appendScaledModifierEntries(modifierEntries, record.modifierEntries, scaledMultiplier);
    appendScaledModifierEntries(
      weaponModuleModifierEntries,
      record.weaponModuleModifierEntries,
      scaledMultiplier,
    );
    appendScaledModifierEntries(
      weaponChargeModifierEntries,
      record.weaponChargeModifierEntries,
      scaledMultiplier,
    );
  }

  const nextSignature = buildAggregateSignature(
    modifierEntries,
    weaponModuleModifierEntries,
    weaponChargeModifierEntries,
  );
  const changed = nextSignature !== String(targetState.aggregateSignature || "");
  targetState.modifierEntries = Object.freeze(
    modifierEntries.map((entry) => Object.freeze({ ...entry })),
  );
  targetState.weaponModuleModifierEntries = Object.freeze(
    weaponModuleModifierEntries.map((entry) => Object.freeze({ ...entry })),
  );
  targetState.weaponChargeModifierEntries = Object.freeze(
    weaponChargeModifierEntries.map((entry) => Object.freeze({ ...entry })),
  );
  targetState.aggregateSignature = nextSignature;
  return {
    changed,
    modifierEntries: targetState.modifierEntries,
    weaponModuleModifierEntries: targetState.weaponModuleModifierEntries,
    weaponChargeModifierEntries: targetState.weaponChargeModifierEntries,
  };
}

function collectModifierEntriesForTarget(targetEntity) {
  const targetState = ensureTargetAssistanceState(targetEntity, false);
  if (!targetState || !Array.isArray(targetState.modifierEntries)) {
    return [];
  }
  return [...targetState.modifierEntries];
}

// `weaponModuleItem` is the weapon the caller is about to build a snapshot for.
// It is what decides whether a skill-keyed entry applies; omitting it keeps
// every entry, which is what the pre-filter callers relied on.
function collectWeaponModifierEntriesForTarget(targetEntity, weaponModuleItem = null) {
  const targetState = ensureTargetAssistanceState(targetEntity, false);
  if (!targetState) {
    return {
      moduleEntries: [],
      chargeEntries: [],
    };
  }
  return {
    moduleEntries: filterProjectedWeaponModifierEntries(
      Array.isArray(targetState.weaponModuleModifierEntries)
        ? targetState.weaponModuleModifierEntries
        : [],
      weaponModuleItem,
    ),
    chargeEntries: filterProjectedWeaponModifierEntries(
      Array.isArray(targetState.weaponChargeModifierEntries)
        ? targetState.weaponChargeModifierEntries
        : [],
      weaponModuleItem,
    ),
  };
}

function upsertTargetAssistanceRecord(targetEntity, record) {
  const targetState = ensureTargetAssistanceState(targetEntity, true);
  const previousRecord = targetState.incomingEffects.get(record.key) || null;
  targetState.incomingEffects.set(record.key, record);
  return {
    changed:
      !previousRecord ||
      previousRecord.rangeMultiplier !== record.rangeMultiplier ||
      previousRecord.startedAtMs !== record.startedAtMs ||
      previousRecord.expiresAtMs !== record.expiresAtMs,
    previousRecord,
    record,
  };
}

function removeTargetAssistanceRecord(targetEntity, sourceEntity, effectState) {
  const targetState = ensureTargetAssistanceState(targetEntity, false);
  if (!targetState) {
    return null;
  }
  const key = buildTargetAssistanceStateKey(
    sourceEntity && sourceEntity.itemID,
    effectState && effectState.moduleID,
    targetEntity && targetEntity.itemID,
  );
  const existing = targetState.incomingEffects.get(key) || null;
  if (!existing) {
    return null;
  }
  targetState.incomingEffects.delete(key);
  return existing;
}

function refreshAssistanceModuleState({
  scene,
  sourceEntity,
  targetEntity,
  effectState,
  nowMs,
  rangeMultiplier = 1,
} = {}) {
  if (!scene || !sourceEntity || !targetEntity || !effectState) {
    return {
      success: false,
      errorMsg: "UNSUPPORTED_MODULE",
      stopReason: "module",
    };
  }
  if (!hasAssistanceModifierEffect(effectState)) {
    return {
      success: true,
      data: {
        targetEntity,
        aggregateChanged: false,
        recordChanged: false,
        multiplier: Math.max(0, toFiniteNumber(rangeMultiplier, 0)),
      },
    };
  }

  const record = buildAssistanceTargetRecord(
    sourceEntity,
    effectState,
    targetEntity,
    nowMs,
    rangeMultiplier,
  );
  const upsertResult = upsertTargetAssistanceRecord(targetEntity, record);
  const aggregateResult = recomputeTargetAssistanceAggregateState(targetEntity);
  return {
    success: true,
    data: {
      targetEntity,
      record,
      recordChanged: upsertResult.changed,
      aggregateChanged: aggregateResult.changed,
      multiplier: Math.max(0, toFiniteNumber(rangeMultiplier, 0)),
    },
  };
}

function removeAssistanceModuleState({
  targetEntity,
  sourceEntity,
  effectState,
} = {}) {
  if (!targetEntity || !sourceEntity || !effectState) {
    return {
      success: false,
      errorMsg: "UNSUPPORTED_MODULE",
    };
  }
  const removedRecord = removeTargetAssistanceRecord(targetEntity, sourceEntity, effectState);
  const aggregateResult = recomputeTargetAssistanceAggregateState(targetEntity);
  return {
    success: true,
    data: {
      removedRecord,
      targetEntity,
      aggregateChanged: aggregateResult.changed,
    },
  };
}

function resolveSourceCharacterID(entity) {
  return toInt(
    entity && (
      entity.characterID ??
      entity.pilotCharacterID ??
      (entity.session && (entity.session.characterID || entity.session.charid))
    ),
    0,
  );
}

function getChargeItemQuantity(chargeItem) {
  return Math.max(
    0,
    toInt(chargeItem && (chargeItem.stacksize ?? chargeItem.quantity), 0),
  );
}

// An ancillary remote repairer runs a bigger cycle while it has a charge loaded.
// Only the armour variant multiplies its output — the shield variant's cap
// boosters pay its capacitor cost instead, so it declares no multiplier and this
// returns 1 for it. Unloaded, both fall back to their base amount rather than
// refusing to run, which is what separates an ancillary module from a charge
// consumer proper.
function resolveAncillaryChargeMultiplier(definition, moduleAttributes, chargeItem) {
  const multiplierAttributeID = toInt(
    definition && definition.ancillaryChargeMultiplierAttributeID,
    0,
  );
  if (multiplierAttributeID <= 0 || getChargeItemQuantity(chargeItem) <= 0) {
    return 1;
  }
  return Math.max(
    1,
    toFiniteNumber(moduleAttributes && moduleAttributes[multiplierAttributeID], 1),
  );
}

// Per-cycle charge budget for an ancillary remote repairer. Modules that are not
// ancillary contribute nothing here, so their effect state is unchanged.
//
// The budget is `chargeRate`, not one unit. All four Ancillary Remote Armor
// Repairers declare it — 1 / 4 / 8 / 16 for Small / Medium / Large / Capital —
// and each one's cargo capacity divided by the volume of Nanite Repair Paste
// divided by that rate is exactly 8, which is the "eight cycles worth of
// charges" the module is built around. A flat 1 was right only for the Small,
// and left the other three holding 32, 64 and 128 cycles of paste. The shield
// variants really do burn one cap booster per cycle; they declare 1.
function buildAncillaryChargeState(definition, moduleAttributes, chargeItem) {
  if (
    !definition ||
    definition.ancillaryChargeMultiplierAttributeID === undefined
  ) {
    return {};
  }
  const loadedQuantity = getChargeItemQuantity(chargeItem);
  const chargeUnitsPerCycle = Math.max(
    1,
    toInt(moduleAttributes && moduleAttributes[ATTRIBUTE_CHARGE_RATE], 1),
  );
  return {
    assistanceAncillary: true,
    assistanceChargeUnitsPerCycle: loadedQuantity > 0 ? chargeUnitsPerCycle : 0,
    assistanceChargeTypeID: toInt(chargeItem && chargeItem.typeID, 0),
    // Kept so the boosted amount can be divided back out when the module runs
    // dry, rather than re-deriving the whole attribute map mid-cycle.
    assistanceAncillaryChargeMultiplier: resolveAncillaryChargeMultiplier(
      definition,
      moduleAttributes,
      chargeItem,
    ),
    assistanceReloadTimeMs: Math.max(
      0,
      roundNumber(toFiniteNumber(moduleAttributes[ATTRIBUTE_RELOAD_TIME], 0), 3),
    ),
  };
}

// Burn one charge for the cycle that just ran. When the last one goes the module
// keeps running — an ancillary repairer falls back to its base amount rather
// than stopping — so the boosted output is recomputed down to base here.
function consumeAncillaryChargeForCycle({
  entity,
  session = null,
  effectState,
  nowMs = 0,
  callbacks = {},
}) {
  if (
    !entity ||
    !effectState ||
    effectState.assistanceAncillary !== true ||
    toInt(effectState.assistanceChargeUnitsPerCycle, 0) <= 0
  ) {
    return false;
  }

  const moduleItem = callbacks.getEntityRuntimeModuleItem
    ? callbacks.getEntityRuntimeModuleItem(entity, effectState.moduleID, effectState.moduleFlagID)
    : null;
  const chargeItem = moduleItem && callbacks.getEntityRuntimeLoadedCharge
    ? callbacks.getEntityRuntimeLoadedCharge(entity, moduleItem)
    : null;
  if (!moduleItem || getChargeItemQuantity(chargeItem) <= 0) {
    downgradeAncillaryCycleToBaseAmount(effectState);
    return false;
  }

  // Holding a charge means any reload that was running has landed, so the next
  // time this module empties it is allowed to start another one.
  effectState.assistanceReloadQueued = false;

  const consumeResult = getLocalCycleRuntime().consumeLoadedChargeQuantity(
    entity,
    moduleItem,
    chargeItem,
    toInt(effectState.assistanceChargeUnitsPerCycle, 1),
    { session, callbacks },
  );
  if (!consumeResult || consumeResult.success !== true) {
    downgradeAncillaryCycleToBaseAmount(effectState);
    return false;
  }

  if (toInt(consumeResult.data && consumeResult.data.nextQuantity, 0) <= 0) {
    queueAncillaryAssistanceReload({ entity, session, effectState, moduleItem, nowMs });
  }

  // Deliberately no downgrade here. The charge spent above pays for the cycle
  // that is about to land, so the cycle which takes the last one still repairs
  // at the charged rate. The next cycle finds nothing loaded and falls back
  // through the no-charge branch above.
  return true;
}

// Emptying an ancillary module starts a reload from the cargo hold, the same
// 60 s the local ancillary modules take. The remote variants keep cycling right
// through it — unloaded — rather than pausing, so this only books the refill.
//
// Nothing else was doing this: the boosters or paste in the cargo hold sat there
// untouched for the rest of the fight, and the module never came back off its
// base output.
function queueAncillaryAssistanceReload({
  entity,
  session = null,
  effectState,
  moduleItem,
  nowMs = 0,
}) {
  if (!effectState || !moduleItem || effectState.assistanceReloadQueued === true) {
    return false;
  }
  const reloadTimeMs = Math.max(0, toFiniteNumber(effectState.assistanceReloadTimeMs, 0));
  const chargeTypeID = toInt(effectState.assistanceChargeTypeID, 0);
  if (reloadTimeMs <= 0 || chargeTypeID <= 0) {
    return false;
  }

  const queueResult = queueAutomaticLocalModuleReload({
    entity,
    session: session || entity.session || null,
    moduleItem,
    chargeTypeID,
    reloadTimeMs,
    // Remote repairers apply at the end of the cycle and take the charge with
    // them, so there is no part-spent cycle to wait out first.
    reloadStartDelayMs: 0,
    startedAtMs: Math.max(0, toFiniteNumber(nowMs, 0)),
    shipID: toInt(entity && entity.itemID, 0),
    ammoLocationID: toInt(entity && entity.itemID, 0),
    resumeMode: "end",
  });
  if (!queueResult || queueResult.success !== true) {
    return false;
  }
  effectState.assistanceReloadQueued = true;
  return true;
}

// A Mutadaptive Remote Armor Repairer ramps up while it is held on one target:
// +repairMultiplierBonusPerCycle of its base amount every cycle, capped at
// repairMultiplierBonusMax. Effect 7166 declares no modifierInfo, so those two
// attributes are the entire contract, and neither had a reader anywhere — all
// five published types repaired a flat base amount for ever.
//
// This is the same mechanic as a Triglavian disintegrator's damage spool, which
// `combat/precursorTurrets.js` already implements correctly, so the convention
// is taken from there rather than invented: the current bonus is APPLIED to the
// cycle that is about to land and only then ADVANCED, so the first delivery is
// x1.0 and the sixteenth is x2.5. That puts full strength 15 ramping cycles —
// 90 s at the family's 6000 ms — after the module is switched on, which is what
// EVE University's Logistics page states.
//
// Deliberately NOT part of `effectStatePatch`: the assistance cycle boundary
// copies the whole patch onto the effect state every cycle, so a spool carried
// there would reset itself to zero for ever. Only the two static parameters are
// re-derived per cycle, the way the ancillary reload guard is kept out too.
function resolveRepairSpoolPerCycle(effectState) {
  return Math.max(0, toFiniteNumber(effectState && effectState.assistanceRepairSpoolPerCycle, 0));
}

function resolveRepairSpoolMax(effectState) {
  return Math.max(0, toFiniteNumber(effectState && effectState.assistanceRepairSpoolMax, 0));
}

// Returns the multiplier this cycle repairs at, then advances the spool for the
// next one. Switching target throws the accumulated ramp away, exactly as
// deactivating does — EVE University: "if deactivated for any reason reset to
// their minimum effectiveness".
function advanceAssistanceRepairSpool(effectState) {
  if (!effectState || typeof effectState !== "object") {
    return 1;
  }
  const perCycle = resolveRepairSpoolPerCycle(effectState);
  const maxBonus = resolveRepairSpoolMax(effectState);
  if (perCycle <= 0 || maxBonus <= 0) {
    return 1;
  }

  const targetID = toInt(effectState.targetID, 0);
  if (toInt(effectState.assistanceRepairSpoolTargetID, 0) !== targetID) {
    effectState.assistanceRepairSpoolTargetID = targetID;
    effectState.assistanceRepairSpoolCurrent = 0;
  }

  const current = clamp(
    toFiniteNumber(effectState.assistanceRepairSpoolCurrent, 0),
    0,
    maxBonus,
  );
  effectState.assistanceRepairSpoolCurrent = roundNumber(
    Math.min(maxBonus, current + perCycle),
    6,
  );
  return roundNumber(1 + current, 6);
}

// Strip the charged multiplier back out of the cached cycle amount once the
// module has run dry, leaving the unloaded output the SDE declares.
function downgradeAncillaryCycleToBaseAmount(effectState) {
  if (!effectState || effectState.assistanceAncillary !== true) {
    return;
  }
  effectState.assistanceChargeUnitsPerCycle = 0;
  const multiplier = Math.max(
    1,
    toFiniteNumber(effectState.assistanceAncillaryChargeMultiplier, 1),
  );
  if (multiplier > 1) {
    effectState.assistanceArmorRepairAmount = roundNumber(
      toFiniteNumber(effectState.assistanceArmorRepairAmount, 0) / multiplier,
      6,
    );
    effectState.assistanceAncillaryChargeMultiplier = 1;
  }
}

function resolveAssistanceModuleActivation({
  scene,
  entity,
  moduleItem,
  effectRecord,
  chargeItem = null,
  shipItem,
  skillMap = null,
  fittedItems = null,
  activeModuleContexts = null,
  additionalDirectModifierEntries = null,
  options = {},
  callbacks = {},
} = {}) {
  const definition = resolveAssistanceDefinition(effectRecord);
  if (!definition) {
    return { matched: false };
  }

  if (!scene || !entity || !moduleItem || !shipItem) {
    return {
      matched: true,
      success: false,
      errorMsg: "UNSUPPORTED_MODULE",
    };
  }

  const normalizedTargetID = toInt(options.targetID, 0);
  if (normalizedTargetID <= 0) {
    return {
      matched: true,
      success: false,
      errorMsg: "TARGET_REQUIRED",
    };
  }

  const targetEntity = scene.getEntityByID(normalizedTargetID);
  if (starbaseRepair.isStarbaseEntity(targetEntity)) {
    const valid = starbaseRepair.validateStarbaseRemoteRepair(targetEntity, definition.family,
      { scene, nowMs: Date.now() });
    if (!valid.success) return { ...valid, matched: true, stopReason: "target" };
  }
  if (isBlockedStructureRemoteRepair(definition, targetEntity)) {
    return {
      matched: true,
      success: false,
      errorMsg: STRUCTURE_REMOTE_REPAIR_ERROR,
      stopReason: "target",
    };
  }
  if (isEntityAssistanceDisallowed(targetEntity, toFiniteNumber(options.nowMs, 0))) {
    return {
      matched: true,
      success: false,
      errorMsg: DISALLOWED_ASSISTANCE_ERROR,
      stopReason: "target",
    };
  }
  const homefrontRejection = homefrontAssistanceRejection(
    definition,
    entity,
    targetEntity,
  );
  if (homefrontRejection) return { matched: true, ...homefrontRejection };
  if (!isAssistanceTargetEntity(definition, targetEntity)) {
    return {
      matched: true,
      success: false,
      errorMsg: "TARGET_NOT_FOUND",
    };
  }
  if (!canEntitiesInteractLocally(entity, targetEntity)) {
    return {
      matched: true,
      success: false,
      errorMsg: "TARGET_NOT_FOUND",
    };
  }

  if (
    !callbacks.isEntityLockedTarget ||
    callbacks.isEntityLockedTarget(entity, normalizedTargetID) !== true
  ) {
    return {
      matched: true,
      success: false,
      errorMsg: "TARGET_NOT_LOCKED",
    };
  }

  const characterID = resolveSourceCharacterID(entity);
  const moduleAttributes = buildLiveModuleAttributeMap(
    shipItem,
    moduleItem,
    chargeItem,
    skillMap,
    fittedItems,
    activeModuleContexts,
    {
      additionalLocationModifierSources:
        characterID > 0
          ? getActiveImplantLocationModifierSources(characterID)
          : [],
      additionalShipModifierEntries:
        characterID > 0
          ? getActiveImplantShipModifierEntries(characterID)
          : [],
      additionalDirectModifierEntries: Array.isArray(
        additionalDirectModifierEntries,
      )
        ? additionalDirectModifierEntries
        : [],
    },
  );
  if (!moduleAttributes) {
    return {
      matched: true,
      success: false,
      errorMsg: "UNSUPPORTED_MODULE",
    };
  }

  const preferredDurationAttributeID = (
    getPreferredAttributeValue(moduleAttributes, [
      effectRecord && effectRecord.durationAttributeID,
    ], 0) > 0
  )
    ? toInt(effectRecord && effectRecord.durationAttributeID, 0)
    : 0;
  const rawDurationMs = getPreferredAttributeValue(
    moduleAttributes,
    [
      preferredDurationAttributeID,
      ATTRIBUTE_DURATION,
      ATTRIBUTE_SPEED,
    ],
    1000,
  );
  const durationAttributeID =
    preferredDurationAttributeID > 0
      ? preferredDurationAttributeID
      : toFiniteNumber(moduleAttributes[ATTRIBUTE_DURATION], 0) > 0
        ? ATTRIBUTE_DURATION
      : ATTRIBUTE_SPEED;
  const modifierEntries = buildAssistanceModifierEntries(
    moduleAttributes,
    definition.moduleModifierSpecs,
    definition.stackingPenalized === true,
  );
  const weaponModuleModifierEntries = buildAssistanceModifierEntries(
    moduleAttributes,
    definition.weaponModuleModifierSpecs,
    definition.stackingPenalized === true,
  );
  const weaponChargeModifierEntries = buildAssistanceModifierEntries(
    moduleAttributes,
    definition.weaponChargeModifierSpecs,
    definition.stackingPenalized === true,
  );
  const effectStatePatch = {
    assistanceModuleEffect: true,
    assistanceFamily: definition.family,
    assistanceJammingType: String(definition.jammingType || ""),
    assistanceAffectsTargetDerivedState: definition.affectsTargetDerivedState === true,
    assistanceModifierEntries: modifierEntries,
    assistanceWeaponModuleModifierEntries: weaponModuleModifierEntries,
    assistanceWeaponChargeModifierEntries: weaponChargeModifierEntries,
    assistanceMaxRangeMeters: Math.max(
      0,
      roundNumber(getPreferredAttributeValue(
        moduleAttributes,
        [
          effectRecord && effectRecord.rangeAttributeID,
          ATTRIBUTE_MAX_RANGE,
        ],
        0,
      ), 3),
    ),
    assistanceFalloffMeters: Math.max(
      0,
      roundNumber(getPreferredAttributeValue(
        moduleAttributes,
        [
          effectRecord && effectRecord.falloffAttributeID,
          ATTRIBUTE_FALLOFF_EFFECTIVENESS,
        ],
        0,
      ), 3),
    ),
    assistanceShieldBonusAmount: Math.max(
      0,
      roundNumber(toFiniteNumber(moduleAttributes[ATTRIBUTE_SHIELD_BONUS], 0), 6),
    ),
    assistanceArmorRepairAmount: Math.max(
      0,
      roundNumber(
        toFiniteNumber(moduleAttributes[ATTRIBUTE_ARMOR_DAMAGE_AMOUNT], 0) *
          resolveAncillaryChargeMultiplier(definition, moduleAttributes, chargeItem),
        6,
      ),
    ),
    ...buildAncillaryChargeState(definition, moduleAttributes, chargeItem),
    assistanceHullRepairAmount: Math.max(
      0,
      roundNumber(toFiniteNumber(moduleAttributes[ATTRIBUTE_STRUCTURE_DAMAGE_AMOUNT], 0), 6),
    ),
    assistancePowerTransferAmount: Math.max(
      0,
      roundNumber(toFiniteNumber(moduleAttributes[ATTRIBUTE_POWER_TRANSFER_AMOUNT], 0), 6),
    ),
    assistanceRemoteResistanceAttributeID: Math.max(
      0,
      toInt(moduleAttributes[ATTRIBUTE_REMOTE_RESISTANCE_ID], 0),
    ),
    // The two static ramp parameters only. They are re-derived from live
    // attributes every cycle boundary, which is correct — a hull or skill
    // change should move them. The accumulated spool is not here on purpose;
    // see advanceAssistanceRepairSpool.
    assistanceRepairSpoolPerCycle: Math.max(
      0,
      roundNumber(
        toFiniteNumber(moduleAttributes[ATTRIBUTE_REPAIR_MULTIPLIER_BONUS_PER_CYCLE], 0),
        6,
      ),
    ),
    assistanceRepairSpoolMax: Math.max(
      0,
      roundNumber(
        toFiniteNumber(moduleAttributes[ATTRIBUTE_REPAIR_MULTIPLIER_BONUS_MAX], 0),
        6,
      ),
    ),
    forceFreshAcquireSpecialFxReplay: true,
    repeat: resolvePersistentRepeat(rawDurationMs),
  };

  const rangeResult = resolveAssistanceMultiplier(
    effectStatePatch,
    entity,
    targetEntity,
    callbacks,
  );
  if (!rangeResult.success) {
    return {
      matched: true,
      success: false,
      errorMsg: rangeResult.errorMsg || "TARGET_OUT_OF_RANGE",
    };
  }

  return {
    matched: true,
    success: true,
    data: {
      targetEntity,
      runtimeAttrs: {
        capNeed: Math.max(
          0,
          roundNumber(getPreferredAttributeValue(
            moduleAttributes,
            [
              ATTRIBUTE_CAPACITOR_NEED,
              effectRecord && effectRecord.dischargeAttributeID,
            ],
            0,
          ), 6),
        ),
        durationMs: Math.max(1, roundNumber(rawDurationMs, 3)),
        durationAttributeID,
        reactivationDelayMs: Math.max(
          0,
          roundNumber(toFiniteNumber(moduleAttributes[ATTRIBUTE_REACTIVATION_DELAY], 0), 3),
        ),
        maxGroupActive: Math.max(0, toInt(moduleAttributes[ATTRIBUTE_MAX_GROUP_ACTIVE], 0)),
        weaponFamily: null,
        attributeOverrides: {
          ...moduleAttributes,
        },
      },
      effectStatePatch,
    },
  };
}

function buildNormalizedConditionState(targetEntity, callbacks = {}) {
  return callbacks.normalizeShipConditionState
    ? callbacks.normalizeShipConditionState(targetEntity && targetEntity.conditionState)
    : {
        ...((targetEntity && targetEntity.conditionState) || {}),
      };
}

function commitHealthRepair({
  scene,
  targetEntity,
  previousConditionState,
  callbacks = {},
  nowMs,
  careerContext = null,
  careerEffect = null,
  careerAmount = 0,
  careerSource = null,
} = {}) {
  const careerResult = careerContext
    ? require("../../services/inventory/careerCombatOutcomes").commit(
      careerContext, careerEffect, careerAmount, nowMs, [careerSource, targetEntity].filter(Boolean),
    ) : { success: true, handled: false };
  if (!careerResult?.success) {
    targetEntity.conditionState = previousConditionState;
    return careerResult;
  }
  const isStarbase = starbaseRepair.isStarbaseEntity(targetEntity);
  const starbaseResult = isStarbase
    ? starbaseRepair.commitStarbaseHealthChange(targetEntity, previousConditionState,
      { scene, nowMs: Date.now() })
    : null;
  if (starbaseResult && !starbaseResult.success) return starbaseResult;
  const isStructure = isStructureEntity(targetEntity);
  if (isStructure) {
    // The scene rebuilds a structure's health from its saved record every
    // tick, so the repair must be saved there, including any stage change.
    const structureResult = getStructureState().applyRuntimeStructureRepair(
      targetEntity.itemID,
      targetEntity.conditionState,
      nowMs,
    );
    if (!structureResult.success) return structureResult;
    const savedCondition = structureResult.data.structure.conditionState;
    targetEntity.conditionState = callbacks.normalizeShipConditionState
      ? callbacks.normalizeShipConditionState(savedCondition)
      : { ...savedCondition };
  }
  const healthResult =
    callbacks.buildShipHealthTransitionResult &&
    callbacks.buildShipHealthTransitionResult(targetEntity, previousConditionState);
  if (targetEntity.session && healthResult && callbacks.notifyShipHealthAttributesToSession) {
    callbacks.notifyShipHealthAttributesToSession(
      targetEntity.session,
      targetEntity,
      healthResult,
      nowMs,
    );
  }
  if (callbacks.broadcastDamageStateChange) {
    callbacks.broadcastDamageStateChange(scene, targetEntity, nowMs);
  }
  if (!careerResult.handled && !isStarbase && !isStructure && callbacks.persistDynamicEntity) {
    callbacks.persistDynamicEntity(targetEntity);
  }
  if (starbaseResult && starbaseResult.data.recovered) {
    scene.broadcastSlimItemChanges?.([targetEntity]);
  }
  return { success: true };
}

function executeAssistanceModuleCycle({
  scene,
  session,
  entity,
  effectState,
  nowMs,
  isActivationPass = false,
  callbacks = {},
} = {}) {
  if (!scene || !entity || !effectState) {
    return {
      success: false,
      stopReason: "module",
    };
  }

  const targetEntity = scene.getEntityByID(toInt(effectState.targetID, 0));
  if (starbaseRepair.isStarbaseEntity(targetEntity)) {
    const valid = starbaseRepair.validateStarbaseRemoteRepair(targetEntity,
      effectState.assistanceFamily, { scene, nowMs: Date.now() });
    if (!valid.success) return { ...valid, stopReason: "target" };
  }
  if (isBlockedStructureRemoteRepair(effectState, targetEntity)) {
    return {
      success: false,
      errorMsg: STRUCTURE_REMOTE_REPAIR_ERROR,
      stopReason: "target",
    };
  }
  // The twin of the activation gate: a field generator that comes up *after* a
  // remote repairer is already running must break the link at the next cycle
  // boundary, not wait for the repairer's pilot to switch it off.
  if (isEntityAssistanceDisallowed(targetEntity, toFiniteNumber(nowMs, 0))) {
    return {
      success: false,
      errorMsg: DISALLOWED_ASSISTANCE_ERROR,
      stopReason: "target",
    };
  }
  const homefrontRejection = homefrontAssistanceRejection(
    effectState,
    entity,
    targetEntity,
  );
  if (homefrontRejection) return homefrontRejection;
  if (!isAssistanceTargetEntity(effectState, targetEntity)) {
    return {
      success: false,
      errorMsg: "TARGET_NOT_FOUND",
      stopReason: "target",
    };
  }
  if (!canEntitiesInteractLocally(entity, targetEntity)) {
    return {
      success: false,
      errorMsg: "TARGET_NOT_FOUND",
      stopReason: "target",
    };
  }

  if (
    !callbacks.isEntityLockedTarget ||
    callbacks.isEntityLockedTarget(entity, effectState.targetID) !== true
  ) {
    return {
      success: false,
      errorMsg: "TARGET_NOT_LOCKED",
      stopReason: "target",
    };
  }

  const multiplierResult = resolveAssistanceMultiplier(
    effectState,
    entity,
    targetEntity,
    callbacks,
  );
  if (!multiplierResult.success) {
    return multiplierResult;
  }

  const resistanceMultiplier = resolveAssistanceResistanceMultiplier(
    effectState,
    targetEntity,
    nowMs,
  );
  const assistanceMultiplier = roundNumber(
    Math.max(multiplierResult.multiplier, 0) * Math.max(resistanceMultiplier, 0),
    6,
  );
  const refreshResult = refreshAssistanceModuleState({
    scene,
    sourceEntity: entity,
    targetEntity,
    effectState,
    nowMs,
    rangeMultiplier: multiplierResult.multiplier,
  });
  if (!refreshResult.success) {
    return refreshResult;
  }
  const aggregateChanged = Boolean(
    refreshResult.data && refreshResult.data.aggregateChanged === true,
  );

  const careerEffect = effectState.assistanceFamily === "remoteShield" ? "shield-repair"
    : effectState.assistanceFamily === "remoteArmor" ? "armor-repair" : null;
  const careerContext = careerEffect
    ? require("../../services/inventory/careerCombatOutcomes").begin(
      entity, targetEntity, effectState, careerEffect, nowMs, true,
    ) : null;
  if (careerContext?.duplicate)
    return { success: true, data: { targetEntity, appliedAmount: 0, duplicate: true, aggregateChanged } };

  if (!isActivationPass) {
    consumeAncillaryChargeForCycle({ entity, session, effectState, nowMs, callbacks });
  }

  // Every gate above has passed, so this cycle will land: take the ramp's
  // current multiplier and advance it. Non-mutadaptive modules declare no ramp
  // and this is a hard 1 for them.
  const repairSpoolMultiplier = advanceAssistanceRepairSpool(effectState);
  const repairAmountMultiplier = roundNumber(
    Math.max(assistanceMultiplier, 0) * Math.max(repairSpoolMultiplier, 0),
    6,
  );

  if (effectState.assistanceFamily === "remoteShield") {
    const shieldCapacity = Math.max(
      0,
      toFiniteNumber(targetEntity && targetEntity.shieldCapacity, 0),
    );
    const shieldBonusAmount = Math.max(
      0,
      toFiniteNumber(effectState.assistanceShieldBonusAmount, 0),
    ) * Math.max(repairAmountMultiplier, 0);
    const previousConditionState = buildNormalizedConditionState(targetEntity, callbacks);

    if (shieldCapacity > 0 && shieldBonusAmount > 0) {
      const currentShieldRatio = toFiniteNumber(
        previousConditionState && previousConditionState.shieldCharge,
        toFiniteNumber(targetEntity && targetEntity.capacitorChargeRatio, 0),
      );
      const nextShieldRatio = Math.min(1, currentShieldRatio + (shieldBonusAmount / shieldCapacity));
      targetEntity.conditionState = callbacks.normalizeShipConditionState
        ? callbacks.normalizeShipConditionState({
            ...previousConditionState,
            shieldCharge: nextShieldRatio,
          })
        : {
            ...previousConditionState,
            shieldCharge: nextShieldRatio,
          };
    }

    const committed = commitHealthRepair({
      scene,
      targetEntity,
      previousConditionState,
      callbacks,
      nowMs,
      careerContext,
      careerEffect,
      careerSource: entity,
      careerAmount: Math.max(0, (Number(targetEntity.conditionState.shieldCharge) -
        Number(previousConditionState.shieldCharge)) * shieldCapacity),
    });
    if (!committed.success) return { ...committed, stopReason: "target" };

    require("../../services/homefront/homefrontHooks").runtime.noteContribution(
      scene,
      entity,
      targetEntity,
      shieldCapacity > 0 ? shieldBonusAmount : 0,
      "repair",
      nowMs,
    );

    return {
      success: true,
      data: {
        targetEntity,
        multiplier: assistanceMultiplier,
        appliedAmount: roundNumber(shieldBonusAmount, 6),
        aggregateChanged,
      },
    };
  }

  if (effectState.assistanceFamily === "remoteCapacitor") {
    const capacitorCapacity = Math.max(
      0,
      toFiniteNumber(targetEntity && targetEntity.capacitorCapacity, 0),
    );
    const capacitorBonusAmount = Math.max(
      0,
      toFiniteNumber(effectState.assistancePowerTransferAmount, 0),
    ) * Math.max(assistanceMultiplier, 0);
    let appliedAmount = 0;
    if (capacitorCapacity > 0 && capacitorBonusAmount > 0) {
      const previousChargeAmount = callbacks.getEntityCapacitorAmount
        ? callbacks.getEntityCapacitorAmount(targetEntity)
        : 0;
      const nextChargeAmount = Math.min(
        capacitorCapacity,
        previousChargeAmount + capacitorBonusAmount,
      );
      appliedAmount = Math.max(0, nextChargeAmount - previousChargeAmount);
      if (callbacks.setEntityCapacitorRatio) {
        callbacks.setEntityCapacitorRatio(
          targetEntity,
          nextChargeAmount / capacitorCapacity,
        );
      }
      if (callbacks.persistDynamicEntity) {
        callbacks.persistDynamicEntity(targetEntity);
      }
      if (
        targetEntity.session &&
        callbacks.notifyCapacitorChangeToSession
      ) {
        callbacks.notifyCapacitorChangeToSession(
          targetEntity.session,
          targetEntity,
          nowMs,
          previousChargeAmount,
        );
      }
    }

    require("../../services/homefront/homefrontHooks").runtime.noteContribution(
      scene,
      entity,
      targetEntity,
      appliedAmount,
      "capacitor",
      nowMs,
    );
    return {
      success: true,
      data: {
        targetEntity,
        multiplier: assistanceMultiplier,
        appliedAmount: roundNumber(appliedAmount, 6),
        aggregateChanged,
      },
    };
  }

  if (effectState.assistanceFamily === "remoteArmor") {
    const armorHP = Math.max(
      0,
      toFiniteNumber(targetEntity && targetEntity.armorHP, 0),
    );
    const armorRepairAmount = Math.max(
      0,
      toFiniteNumber(effectState.assistanceArmorRepairAmount, 0),
    ) * Math.max(repairAmountMultiplier, 0);
    const previousConditionState = buildNormalizedConditionState(targetEntity, callbacks);

    if (armorHP > 0 && armorRepairAmount > 0) {
      // Losing an armor-HP bonus can legitimately leave absolute armor damage
      // greater than the reduced maximum HP. Preserve that repair deficit until
      // remote repair cycles work it down instead of silently clamping it away.
      const currentArmorDamageRatio = Math.max(
        0,
        toFiniteNumber(previousConditionState && previousConditionState.armorDamage, 0),
      );
      const nextArmorDamageRatio = Math.max(
        0,
        currentArmorDamageRatio - (armorRepairAmount / armorHP),
      );
      targetEntity.conditionState = callbacks.normalizeShipConditionState
        ? callbacks.normalizeShipConditionState({
            ...previousConditionState,
            armorDamage: nextArmorDamageRatio,
          })
        : {
            ...previousConditionState,
            armorDamage: nextArmorDamageRatio,
          };
    }

    const committed = commitHealthRepair({
      scene,
      targetEntity,
      previousConditionState,
      callbacks,
      nowMs,
      careerContext,
      careerEffect,
      careerSource: entity,
      careerAmount: Math.max(0, (Number(previousConditionState.armorDamage) -
        Number(targetEntity.conditionState.armorDamage)) * armorHP),
    });
    if (!committed.success) return { ...committed, stopReason: "target" };
    require("../../services/homefront/homefrontHooks").runtime.noteContribution(
      scene,
      entity,
      targetEntity,
      armorHP > 0 ? armorRepairAmount : 0,
      "repair",
      nowMs,
    );


    return {
      success: true,
      data: {
        targetEntity,
        multiplier: assistanceMultiplier,
        appliedAmount: roundNumber(armorRepairAmount, 6),
        aggregateChanged,
      },
    };
  }

  if (effectState.assistanceFamily === "remoteHull") {
    const structureHP = Math.max(
      0,
      toFiniteNumber(targetEntity && targetEntity.structureHP, 0),
    );
    const hullRepairAmount = Math.max(
      0,
      toFiniteNumber(effectState.assistanceHullRepairAmount, 0),
    ) * Math.max(repairAmountMultiplier, 0);
    const previousConditionState = buildNormalizedConditionState(targetEntity, callbacks);

    if (structureHP > 0 && hullRepairAmount > 0) {
      const currentStructureDamageRatio = clamp(
        toFiniteNumber(previousConditionState && previousConditionState.damage, 0),
        0,
        1,
      );
      const nextStructureDamageRatio = Math.max(
        0,
        currentStructureDamageRatio - (hullRepairAmount / structureHP),
      );
      targetEntity.conditionState = callbacks.normalizeShipConditionState
        ? callbacks.normalizeShipConditionState({
            ...previousConditionState,
            damage: nextStructureDamageRatio,
          })
        : {
            ...previousConditionState,
            damage: nextStructureDamageRatio,
          };
    }

    const committed = commitHealthRepair({
      scene,
      targetEntity,
      previousConditionState,
      callbacks,
      nowMs,
    });
    if (!committed.success) return { ...committed, stopReason: "target" };

    return {
      success: true,
      data: {
        targetEntity,
        multiplier: assistanceMultiplier,
        appliedAmount: roundNumber(hullRepairAmount, 6),
        aggregateChanged,
      },
    };
  }

  if (hasAssistanceModifierEffect(effectState)) {
    return {
      success: true,
      data: {
        targetEntity,
        multiplier: assistanceMultiplier,
        appliedAmount: 0,
        aggregateChanged,
      },
    };
  }

  return {
    success: false,
    stopReason: "module",
  };
}

module.exports = {
  DISALLOWED_ASSISTANCE_ERROR,
  resolveAssistanceDefinition,
  resolveAssistanceModuleActivation,
  executeAssistanceModuleCycle,
  removeAssistanceModuleState,
  recomputeTargetAssistanceAggregateState,
  collectModifierEntriesForTarget,
  collectWeaponModifierEntriesForTarget,
  isEntityAssistanceDisallowed,
  resolveEntosisAssistanceImpedanceMultiplier,
};
