"use strict";

module.exports = {
  applyStargateJumpCloakState,
  buildCloakModuleActivationDogmaEvents,
  buildCloakModuleUncloakDogmaEvents,
  clearStargateJumpCloakState,
  demoteEntityMassiveState,
  restoreEntityMassiveState,
  findActiveCloakingModuleEffectState,
  getEntityCloakMode,
  getEntityCloakStabilizationStrength,
  hasFiniteEntityPosition,
  isCloakingModuleActivation,
  isCloakingModuleEffectState,
  isDecloakNonPhysicalExemptEntity,
  isDecloakProbeExemptEntity,
  isDecloakProximityExemptEntity,
  isEntityActiveWarpInFlight,
  isEntityCloaked,
  isEntityModuleCloaked,
  isEntityNormalCloaked,
  isEntityRemoteDecloakImmune,
  isEntityStargateJumpCloaked,
  isEntityWarpBlockedByCloak,
  isEntityWarpSafeCloakedInFlight,
  isPrototypeCloakingModule,
  isWarpSafeActiveModuleEffectState,
  isWarpSafeModuleEffectDescriptor,
  isWarpSafeCloakingEffectDescriptor,
  resolveActiveModuleEffectRecord,
  resolveCloakModuleTargetingDelayMs,
  resolveCloakModuleUncloakRangeMeters,
  resolveCloakStabilizationDurationMs,
  setEntityCloakStabilizationState,
};

const runtimeEntryDirname = require("path").resolve(__dirname, "..");
const path = require("path");
const {
  getFittedModuleItems,
  listFittedItemsForLocation,
  buildSlimModuleTuples,
  buildCharacterTargetingState,
  buildChargeTupleItemID,
  buildShipResourceState,
  SLOT_FAMILY_FLAGS,
  getAttributeIDByNames,
  getEffectIDByNames,
  getTypeDogmaAttributes,
  getTypeDogmaEffects,
  getTypeEffectRecords,
  getPassiveModifierEffectRecords,
  getTypeAttributeValue,
  getEffectTypeRecord,
  getRequiredSkillRequirements,
  getLoadedChargeByFlag,
  isChargeCompatibleWithModule,
  isModuleOnline,
  isStructureDogmaHost,
  resolveDogmaSkillMapForHost,
  appendDirectModifierEntries,
  buildEffectiveItemAttributeMap,
  indexOverloadEffectRecordsByModuleID,
  buildProjectedModuleSourceAttributeMap,
} = require(path.join(runtimeEntryDirname, "../services/fitting/liveFittingState"));
const {
  buildAttributeChange,
} = require("./attributeChangeNotification");
const {
  ATTRIBUTE_CLOAKING_TARGETING_DELAY,
  ATTRIBUTE_CLOAK_STABILIZATION_STRENGTH,
  ATTRIBUTE_MAX_VELOCITY,
  ATTRIBUTE_STABILIZE_CLOAK_DURATION,
} = require("./dogmaAttributeIds");
const {
  buildGenericModuleEffectStateDogmaEvent,
} = require("./godmaShipEffectNotification");
const {
  roundNumber,
  toFiniteNumber,
  toInt,
} = require("../../common/numbers");
const {
  getPropulsionEffectID,
} = require("./propulsionModule");
const {
  resolveSessionNotificationFileTime,
} = require("./sessionNotificationTime");
const {
  getTypeDogmaAttributeValueByID,
} = require("./typeAttributeLookup");

const DESTINY_CLOAK_MODE_NORMAL = 1;

const DESTINY_CLOAK_MODE_RESTORE = 2;

const MIN_CLOAKING_DISTANCE_METERS = 2000;

const DEFAULT_STARGATE_JUMP_CLOAK_DURATION_MS = 60_000;

const DEFAULT_CLOAK_STABILIZATION_STRENGTH = 0;

const DEFAULT_CLOAK_STABILIZATION_DURATION_MS = 15 * 60 * 1000;

const CLOAK_RENDER_EFFECT_GUID = "effects.Cloak";

const UNCLOAK_RENDER_EFFECT_GUID = "effects.Uncloak";

const CLOAK_RENDER_EFFECT_DURATION_MS = 6000;

const CLOAK_ACTIVATION_DBUFF_COLLECTION_ID = 2113;

const DECLOAK_PROBE_EXEMPT_GROUP_IDS = new Set([479, 492, 548, 972, 4088]);

const DECLOAK_NON_PHYSICAL_EXEMPT_GROUP_IDS = new Set([502, 885]);

const GROUP_CLOAKING_DEVICE = 330;

const TYPE_PROTOTYPE_CLOAKING_DEVICE = 11370;

const EFFECT_ID_CLOAKING_PROTOTYPE =
  getEffectIDByNames("cloakingPrototype") || 5945;

const CLOAKING_MODULE_EFFECT_NAMES = new Set([
  "cloaking",
  "cloakingwarpsafe",
  "cloakingprototype",
]);

const CLOAKING_MODULE_EFFECT_GUIDS = new Set([
  "effects.cloaking",
  "effects.cloakingcovertops",
  "effects.cloakingprototype",
]);

const CLOAK_UNCLOAK_RANGE_ATTRIBUTE_NAMES = Object.freeze([
  "uncloakRange",
  "decloakRange",
  "decloakFieldRange",
]);

const MODULE_ATTRIBUTE_CAN_ACTIVATE_IN_GATE_CLOAK =
  getAttributeIDByNames("canActivateInGateCloak") || 3123;

function isCloakingModuleActivation(moduleItem, effectRecord) {
  const groupID = toInt(moduleItem && moduleItem.groupID, 0);
  const effectName = String(effectRecord && effectRecord.name || "").trim().toLowerCase();
  const effectGuid = String(effectRecord && effectRecord.guid || "").trim().toLowerCase();
  return (
    groupID === GROUP_CLOAKING_DEVICE ||
    CLOAKING_MODULE_EFFECT_NAMES.has(effectName) ||
    CLOAKING_MODULE_EFFECT_GUIDS.has(effectGuid)
  );
}

function isPrototypeCloakingModule(moduleItem, effectRecordOrState = null) {
  const typeID = toInt(
    moduleItem && moduleItem.typeID,
    toInt(effectRecordOrState && effectRecordOrState.typeID, 0),
  );
  if (typeID === TYPE_PROTOTYPE_CLOAKING_DEVICE) {
    return true;
  }

  const effectID = toInt(
    effectRecordOrState && (
      effectRecordOrState.effectID ||
      effectRecordOrState.id
    ),
    0,
  );
  if (effectID === EFFECT_ID_CLOAKING_PROTOTYPE) {
    return true;
  }

  const effectName = String(
    effectRecordOrState && (
      effectRecordOrState.effectName ||
      effectRecordOrState.name
    ) || "",
  ).trim().toLowerCase();
  const effectGuid = String(effectRecordOrState && effectRecordOrState.guid || "")
    .trim()
    .toLowerCase();
  return (
    effectName === "cloakingprototype" ||
    effectGuid === "effects.cloakingprototype"
  );
}

function resolveCloakModuleUncloakRangeMeters(moduleItem, effectRecord = null) {
  const explicitRange = toFiniteNumber(
    moduleItem && (
      moduleItem.uncloakRangeMeters ??
      moduleItem.uncloakRange ??
      moduleItem.decloakRangeMeters ??
      moduleItem.decloakRange
    ),
    Number.NaN,
  );
  if (Number.isFinite(explicitRange) && explicitRange > 0) {
    return explicitRange;
  }

  const typeID = toInt(moduleItem && moduleItem.typeID, 0);
  if (typeID > 0) {
    for (const attributeName of CLOAK_UNCLOAK_RANGE_ATTRIBUTE_NAMES) {
      const attributeRange = toFiniteNumber(
        getTypeAttributeValue(typeID, attributeName),
        Number.NaN,
      );
      if (Number.isFinite(attributeRange) && attributeRange > 0) {
        return attributeRange;
      }
    }
  }

  return MIN_CLOAKING_DISTANCE_METERS;
}

function isCloakingModuleEffectState(effectState) {
  if (!effectState) {
    return false;
  }
  if (effectState.cloakModuleEffect === true) {
    return true;
  }
  const groupID = toInt(effectState.groupID, 0);
  const effectName = String(effectState.effectName || "").trim().toLowerCase();
  const effectGuid = String(effectState.guid || "").trim().toLowerCase();
  return (
    groupID === GROUP_CLOAKING_DEVICE ||
    CLOAKING_MODULE_EFFECT_NAMES.has(effectName) ||
    CLOAKING_MODULE_EFFECT_GUIDS.has(effectGuid)
  );
}

function isWarpSafeCloakingEffectDescriptor(effectRecordOrState) {
  if (!effectRecordOrState || typeof effectRecordOrState !== "object") {
    return false;
  }
  if (effectRecordOrState.isWarpSafe === true) {
    return true;
  }

  const effectName = String(
    effectRecordOrState.effectName ||
      effectRecordOrState.name ||
      "",
  ).trim().toLowerCase();
  const effectGuid = String(effectRecordOrState.guid || "")
    .trim()
    .toLowerCase();
  return (
    effectName === "cloakingwarpsafe" ||
    effectGuid === "effects.cloakingcovertops"
  );
}

function findActiveCloakingModuleEffectState(entity) {
  if (!entity || !(entity.activeModuleEffects instanceof Map)) {
    return null;
  }
  for (const effectState of entity.activeModuleEffects.values()) {
    if (
      effectState &&
      toFiniteNumber(effectState.deactivatedAtMs, 0) <= 0 &&
      isCloakingModuleEffectState(effectState)
    ) {
      return effectState;
    }
  }
  return null;
}

function isEntityModuleCloaked(entity) {
  return isEntityNormalCloaked(entity) && Boolean(findActiveCloakingModuleEffectState(entity));
}

function getEntityCloakMode(entity) {
  return toInt(
    entity && (
      entity.isCloaked ??
      entity.cloakMode ??
      entity.cloaked
    ),
    0,
  );
}

function isEntityCloaked(entity) {
  return getEntityCloakMode(entity) > 0;
}

function isEntityNormalCloaked(entity) {
  return getEntityCloakMode(entity) === DESTINY_CLOAK_MODE_NORMAL;
}

function setEntityCloakStabilizationState(entity, untilMs, nowMs = Date.now()) {
  if (!entity) {
    return 0;
  }

  const now = Math.max(0, toFiniteNumber(nowMs, Date.now()));
  const until = Math.max(0, toFiniteNumber(untilMs, 0));
  const strength = until > now ? 1 : DEFAULT_CLOAK_STABILIZATION_STRENGTH;
  entity.cloakStabilizationUntilMs = strength > 0 ? until : 0;
  entity.cloakStabilizationStrength = strength;
  if (entity.passiveDerivedState && typeof entity.passiveDerivedState === "object") {
    entity.passiveDerivedState.cloakStabilizationStrength = strength;
    if (
      entity.passiveDerivedState.attributes &&
      typeof entity.passiveDerivedState.attributes === "object"
    ) {
      entity.passiveDerivedState.attributes[String(ATTRIBUTE_CLOAK_STABILIZATION_STRENGTH)] =
        strength;
    }
  }
  return strength;
}

function getEntityCloakStabilizationStrength(entity, nowMs = Date.now()) {
  if (!entity) {
    return 0;
  }

  const now = Math.max(0, toFiniteNumber(nowMs, Date.now()));
  const until = Math.max(0, toFiniteNumber(entity.cloakStabilizationUntilMs, 0));
  if (until > now) {
    return Math.max(1, toFiniteNumber(entity.cloakStabilizationStrength, 1));
  }
  if (until > 0) {
    setEntityCloakStabilizationState(entity, 0, now);
    return 0;
  }

  const passiveState = entity.passiveDerivedState || null;
  const candidates = [
    entity.cloakStabilizationStrength,
    passiveState && passiveState.cloakStabilizationStrength,
    passiveState &&
      passiveState.attributes &&
      typeof passiveState.attributes === "object"
      ? passiveState.attributes[String(ATTRIBUTE_CLOAK_STABILIZATION_STRENGTH)]
      : null,
  ];
  for (const candidate of candidates) {
    const value = toFiniteNumber(candidate, 0);
    if (value > 0) {
      return value;
    }
  }
  return 0;
}

function isEntityRemoteDecloakImmune(entity, nowMs = Date.now()) {
  return getEntityCloakStabilizationStrength(entity, nowMs) > 0;
}

function isEntityStargateJumpCloaked(entity) {
  return Boolean(
    entity &&
      entity.stargateJumpCloak === true &&
      getEntityCloakMode(entity) === DESTINY_CLOAK_MODE_RESTORE
  );
}

// CloakBall's demotion (and the dock acceptance's). A Ball of another kind
// than a ship keeps the flags it had, for restoreEntityMassiveState.
function demoteEntityMassiveState(entity) {
  if (!entity) {
    return;
  }
  if (entity.kind !== "ship" && !entity.massiveBeforeDemotion) {
    entity.massiveBeforeDemotion = { isMassive: entity.isMassive, massive: entity.massive };
  }
  entity.isMassive = false;
  entity.massive = false;
}

// Retail's UncloakBall sets the Ball massive again unless it is in proper
// warp (carbon-destiny v2.1.1 Ballpark.cpp L5261-L5281), and its warp drop
// sets it massive (L4334). Server's warp never clears the flag (Evolve reads
// isWarping instead), so the uncloak restores it whatever the warp state;
// Evolve still leaves a warping Ball out of collision and missile hits. A
// ship is massive; a Ball of another kind gets back the flags it had before
// the demotion, so a kind whose flag was unset is not sent IS_MASSIVE after
// its uncloak (ballEncoding.js getFreeBallFlags).
function restoreEntityMassiveState(entity) {
  if (!entity) {
    return;
  }
  if (entity.kind !== "ship") {
    const before = entity.massiveBeforeDemotion;
    delete entity.massiveBeforeDemotion;
    if (!before) {
      return;
    }
    for (const key of ["isMassive", "massive"]) {
      if (before[key] === undefined) {
        delete entity[key];
      } else {
        entity[key] = before[key];
      }
    }
    return;
  }
  entity.isMassive = true;
  entity.massive = true;
}

function hasFiniteEntityPosition(entity) {
  const position = entity && entity.position;
  return Boolean(
    position &&
      Number.isFinite(Number(position.x)) &&
      Number.isFinite(Number(position.y)) &&
      Number.isFinite(Number(position.z))
  );
}

function isDecloakProbeExemptEntity(entity) {
  const groupID = toInt(entity && entity.groupID, 0);
  if (DECLOAK_PROBE_EXEMPT_GROUP_IDS.has(groupID)) {
    return true;
  }

  const kind = String((entity && entity.kind) || "").trim().toLowerCase();
  if (kind === "probe") {
    return true;
  }

  const categoryID = toInt(entity && entity.categoryID, 0);
  if (categoryID !== 8) {
    return false;
  }

  const label = [
    entity && entity.groupName,
    entity && entity.typeName,
    entity && entity.itemName,
  ]
    .filter((value) => value !== null && value !== undefined)
    .map((value) => String(value))
    .join(" ");

  return /\bprobes?\b/i.test(label);
}

function isDecloakNonPhysicalExemptEntity(entity) {
  if (!entity) {
    return false;
  }
  if (
    entity.nonPhysicalDecloakExempt === true ||
    entity.decloakExempt === true
  ) {
    return true;
  }

  if (DECLOAK_NON_PHYSICAL_EXEMPT_GROUP_IDS.has(toInt(entity.groupID, 0))) {
    return true;
  }

  const kind = String(entity.kind || "").trim().toLowerCase();
  return kind === "asteroidbelt";
}

function isDecloakProximityExemptEntity(entity) {
  return (
    isDecloakProbeExemptEntity(entity) ||
    isDecloakNonPhysicalExemptEntity(entity)
  );
}

function applyStargateJumpCloakState(entity, options = {}) {
  if (!entity) {
    return null;
  }
  const now = Math.max(0, toFiniteNumber(options.nowMs, Date.now()));
  const durationMs = Math.max(
    0,
    toFiniteNumber(
      options.durationMs,
      DEFAULT_STARGATE_JUMP_CLOAK_DURATION_MS,
    ),
  );
  entity.isCloaked = DESTINY_CLOAK_MODE_RESTORE;
  entity.cloakMode = DESTINY_CLOAK_MODE_RESTORE;
  entity.cloaked = true;
  entity.uncloakRangeMeters = 0;
  entity.stargateJumpCloak = true;
  entity.stargateJumpCloakStartedAtMs = now;
  entity.stargateJumpCloakDurationMs = durationMs;
  entity.stargateJumpCloakUntilMs = now + durationMs;
  demoteEntityMassiveState(entity);
  return {
    startedAtMs: now,
    durationMs,
    untilMs: entity.stargateJumpCloakUntilMs,
  };
}

function clearStargateJumpCloakState(entity) {
  if (!entity) {
    return;
  }
  entity.stargateJumpCloak = false;
  entity.stargateJumpCloakStartedAtMs = 0;
  entity.stargateJumpCloakDurationMs = 0;
  entity.stargateJumpCloakUntilMs = 0;
}

function resolveCloakStabilizationDurationMs(moduleItem) {
  const typeID = toInt(moduleItem && moduleItem.typeID, 0);
  if (typeID <= 0) {
    return DEFAULT_CLOAK_STABILIZATION_DURATION_MS;
  }
  const durationSeconds = toFiniteNumber(
    getTypeDogmaAttributeValueByID(
      typeID,
      ATTRIBUTE_STABILIZE_CLOAK_DURATION,
      DEFAULT_CLOAK_STABILIZATION_DURATION_MS / 1000,
    ),
    DEFAULT_CLOAK_STABILIZATION_DURATION_MS / 1000,
  );
  return Math.max(0, Math.trunc(durationSeconds * 1000));
}

// `cloakingTargetingDelay` (560, "Sensor Recalibration Time") is the family's
// defining drawback: after a cloaking device drops, the ship cannot lock
// anything for this long. 30 s on a Prototype, 20 s on an Improved, 10 s on a
// Covert Ops, and the number that matters is the LIVE one, not the type's — a
// Stealth Bomber or a Black Ops zeroes it (effect 2253), the Endurance cuts it
// to 5 s, the Targeting Systems Stabilizer rigs take 10-15% off (2853) and the
// Cloaking skill another 10% per level (848). `genericAttributeOverrides` is
// the module's live dogma map, so all of that is already folded in.
function resolveCloakModuleTargetingDelayMs(effectState) {
  const overrides =
    effectState && typeof effectState.genericAttributeOverrides === "object"
      ? effectState.genericAttributeOverrides
      : null;
  const liveValue = overrides
    ? toFiniteNumber(overrides[ATTRIBUTE_CLOAKING_TARGETING_DELAY], Number.NaN)
    : Number.NaN;
  if (Number.isFinite(liveValue)) {
    return Math.max(0, liveValue);
  }
  return Math.max(
    0,
    toFiniteNumber(
      getTypeDogmaAttributeValueByID(
        toInt(effectState && effectState.typeID, 0),
        ATTRIBUTE_CLOAKING_TARGETING_DELAY,
        0,
      ),
      0,
    ),
  );
}

function resolveActiveModuleEffectRecord(effectState) {
  if (!effectState || typeof effectState !== "object") {
    return null;
  }
  if (
    effectState.effectRecord &&
    typeof effectState.effectRecord === "object"
  ) {
    return effectState.effectRecord;
  }

  const effectID =
    toInt(effectState.effectID, 0) ||
    getPropulsionEffectID(effectState.effectName) ||
    getEffectIDByNames(effectState.effectName);
  return effectID > 0 ? getEffectTypeRecord(effectID) : null;
}

function isWarpSafeActiveModuleEffectState(effectState) {
  const effectRecord = resolveActiveModuleEffectRecord(effectState);
  return isWarpSafeModuleEffectDescriptor(effectRecord || effectState);
}

function isWarpSafeModuleEffectDescriptor(effectRecordOrState) {
  const effectName = String(
    effectRecordOrState?.name || effectRecordOrState?.effectName || "",
  ).trim();
  // Burst projectors and the transportation oscillator carry isWarpSafe in
  // the SDE, but their doomsday effects cannot operate during warp. Apply the
  // same exception when activating and when stopping an effect at warp start.
  if (/^doomsday/i.test(effectName)) {
    return false;
  }
  return isWarpSafeCloakingEffectDescriptor(effectRecordOrState);
}

function isEntityActiveWarpInFlight(entity) {
  return Boolean(
    entity &&
      String(entity.mode || "").toUpperCase() === "WARP" &&
      Number(entity.effectStamp) >= 0,
  );
}

function isEntityWarpSafeCloakedInFlight(entity) {
  if (!isEntityActiveWarpInFlight(entity)) {
    return false;
  }
  const activeCloakEffect = findActiveCloakingModuleEffectState(entity);
  return Boolean(
    activeCloakEffect &&
      isWarpSafeActiveModuleEffectState(activeCloakEffect),
  );
}

// A standard cloaking device holds the ship out of warp: the pilot must
// decloak before warping. Only warp-safe (covert ops) cloaks may carry a ship
// into warp, so those never block the warp command.
function isEntityWarpBlockedByCloak(entity) {
  const activeCloakEffect = findActiveCloakingModuleEffectState(entity);
  if (!activeCloakEffect) {
    return false;
  }
  return !isWarpSafeActiveModuleEffectState(activeCloakEffect);
}

function buildCloakModuleUncloakDogmaEvents(
  session,
  entity,
  effectState,
  options = {},
) {
  if (!session || !entity || !effectState) {
    return [];
  }

  const when =
    options.whenMs === undefined || options.whenMs === null
      ? resolveSessionNotificationFileTime(session)
      : resolveSessionNotificationFileTime(session, options.whenMs);
  const events = [];
  const previousMaxVelocity = toFiniteNumber(
    options.previousMaxVelocity,
    Number.NaN,
  );
  const currentMaxVelocity = toFiniteNumber(
    options.currentMaxVelocity,
    entity.maxVelocity,
  );
  let maxVelocityEvent = null;
  if (
    Number.isFinite(previousMaxVelocity) &&
    Number.isFinite(currentMaxVelocity)
  ) {
    maxVelocityEvent = buildAttributeChange(
      session,
      entity.itemID,
      ATTRIBUTE_MAX_VELOCITY,
      roundNumber(currentMaxVelocity, 6),
      roundNumber(previousMaxVelocity, 6),
      when,
    );
    events.push([maxVelocityEvent, when]);
  }

  const effectEvent = buildGenericModuleEffectStateDogmaEvent(
    session,
    entity,
    effectState,
    false,
    {
      ...options,
      whenMs: options.whenMs,
      repeat: false,
      error: null,
    },
  );
  if (effectEvent) {
    events.push(effectEvent);
  }

  if (maxVelocityEvent && options.duplicateMaxVelocity === true) {
    events.push([maxVelocityEvent.slice(), when]);
  }

  return events;
}

function buildCloakModuleActivationDogmaEvents(
  session,
  entity,
  effectState,
  options = {},
) {
  if (!session || !entity || !effectState) {
    return [];
  }

  const when =
    options.whenMs === undefined || options.whenMs === null
      ? resolveSessionNotificationFileTime(session)
      : resolveSessionNotificationFileTime(session, options.whenMs);
  const events = [];
  const previousMaxVelocity = toFiniteNumber(
    options.previousMaxVelocity,
    Number.NaN,
  );
  const currentMaxVelocity = toFiniteNumber(
    options.currentMaxVelocity,
    entity.maxVelocity,
  );
  let maxVelocityEvent = null;
  if (
    Number.isFinite(previousMaxVelocity) &&
    Number.isFinite(currentMaxVelocity)
  ) {
    maxVelocityEvent = buildAttributeChange(
      session,
      entity.itemID,
      ATTRIBUTE_MAX_VELOCITY,
      roundNumber(currentMaxVelocity, 6),
      roundNumber(previousMaxVelocity, 6),
      when,
    );
    events.push([maxVelocityEvent, when]);
  }

  let cloakStabilizationEvent = null;
  const previousCloakStabilizationStrength = toFiniteNumber(
    options.previousCloakStabilizationStrength,
    Number.NaN,
  );
  const currentCloakStabilizationStrength = toFiniteNumber(
    options.currentCloakStabilizationStrength,
    Number.NaN,
  );
  if (
    Number.isFinite(previousCloakStabilizationStrength) &&
    Number.isFinite(currentCloakStabilizationStrength) &&
    roundNumber(previousCloakStabilizationStrength, 6) !==
      roundNumber(currentCloakStabilizationStrength, 6)
  ) {
    cloakStabilizationEvent = buildAttributeChange(
      session,
      entity.itemID,
      ATTRIBUTE_CLOAK_STABILIZATION_STRENGTH,
      roundNumber(currentCloakStabilizationStrength, 6),
      roundNumber(previousCloakStabilizationStrength, 6),
      when,
    );
    events.push([cloakStabilizationEvent, when]);
  }

  const effectEvent = buildGenericModuleEffectStateDogmaEvent(
    session,
    entity,
    effectState,
    true,
    {
      ...options,
      whenMs: options.whenMs,
      startTimeMs: options.startTimeMs,
      repeat: false,
      error: null,
    },
  );
  if (effectEvent) {
    events.push(effectEvent);
  }

  if (
    cloakStabilizationEvent &&
    options.repeatCurrentCloakStabilizationStrength === true
  ) {
    const repeatedCloakStabilizationEvent = buildAttributeChange(
      session,
      entity.itemID,
      ATTRIBUTE_CLOAK_STABILIZATION_STRENGTH,
      roundNumber(currentCloakStabilizationStrength, 6),
      roundNumber(currentCloakStabilizationStrength, 6),
      when,
    );
    events.push([repeatedCloakStabilizationEvent, when]);
  }

  if (maxVelocityEvent && options.duplicateMaxVelocity === true) {
    events.push([maxVelocityEvent.slice(), when]);
  }

  return events;
}

Object.assign(module.exports, {
  CLOAKING_MODULE_EFFECT_GUIDS,
  CLOAKING_MODULE_EFFECT_NAMES,
  CLOAK_ACTIVATION_DBUFF_COLLECTION_ID,
  CLOAK_RENDER_EFFECT_DURATION_MS,
  CLOAK_RENDER_EFFECT_GUID,
  CLOAK_UNCLOAK_RANGE_ATTRIBUTE_NAMES,
  DECLOAK_NON_PHYSICAL_EXEMPT_GROUP_IDS,
  DECLOAK_PROBE_EXEMPT_GROUP_IDS,
  DEFAULT_CLOAK_STABILIZATION_DURATION_MS,
  DEFAULT_CLOAK_STABILIZATION_STRENGTH,
  DEFAULT_STARGATE_JUMP_CLOAK_DURATION_MS,
  DESTINY_CLOAK_MODE_NORMAL,
  DESTINY_CLOAK_MODE_RESTORE,
  EFFECT_ID_CLOAKING_PROTOTYPE,
  GROUP_CLOAKING_DEVICE,
  MIN_CLOAKING_DISTANCE_METERS,
  MODULE_ATTRIBUTE_CAN_ACTIVATE_IN_GATE_CLOAK,
  TYPE_PROTOTYPE_CLOAKING_DEVICE,
  UNCLOAK_RENDER_EFFECT_GUID,
});
