"use strict";

module.exports = {
  appendBallDebug,
  appendBubbleDebug,
  appendDestinyDebug,
  appendJumpTimingTrace,
  appendMissileDebug,
  appendMovementDebug,
  appendWarpDebug,
  armMovementTrace,
  beginSessionJumpTimingTrace,
  buildMissileChargeTupleDebugContext,
  buildMissileFlightSnapshot,
  buildMissileLaunchRangeDebugContext,
  buildMissileSessionSnapshot,
  buildSessionJumpTraceSnapshot,
  extractSlimItemIdentity,
  getActiveSessionJumpTrace,
  getMovementTraceSnapshot,
  isBubbleDebugEnabled,
  isMissileDebugEnabled,
  isMovementTraceActive,
  limitTraceArray,
  logBallDebug,
  logBubbleDebug,
  logDestinyDispatch,
  logMissileDebug,
  logMovementDebug,
  logWarpDebug,
  normalizeTraceValue,
  recordSessionJumpTimingTrace,
  resolveDebugTestNearestStationTarget,
  shouldLogMissilePayloadGroup,
  summarizeAddBalls2Args,
  summarizeBubbleEntity,
  summarizeBubbleState,
  summarizeDamageStateArgs,
  summarizeDestinyArgs,
  summarizeMissileEntity,
  summarizeMissileInventoryItemForDebug,
  summarizeMissileUpdatesForLog,
  summarizeMissileWeaponSnapshotForDebug,
  summarizeWarp,
  summarizeRemoveBallsArgs,
  summarizeRuntimeEntityForMissileDebug,
  summarizeSetStateArgs,
  summarizeVector,
};

const runtimeEntryDirname = require("path").resolve(__dirname, "..");
const path = require("path");
const rotatingLog = require(path.join(runtimeEntryDirname, "../utils/rotatingLog"));
const config = require(path.join(runtimeEntryDirname, "../config"));
const { resolveDataRootPath } = require(path.join(runtimeEntryDirname, "../config/dataRoot"));
const log = require(path.join(runtimeEntryDirname, "../utils/logger"));
const {
  entityIDsEqual,
  getEntityMapKey,
  normalizeEntityID,
  normalizeEntityIDSet,
  normalizeNonNegativeInt64,
  normalizePersistentEntityID,
  toJSONSafeEntityID,
} = require(path.join(runtimeEntryDirname, "./destiny/identity/entityID.js"));
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
  PILOT_WARP_ACTIVATION_DELAY_DESTINY_TICKS,
  PILOT_WARP_DESTINATION_ACQUIRE_LEAD_DESTINY_TICKS,
  PILOT_WARP_DESTINATION_STATIC_PRELOAD_DISTANCE_METERS,
  PILOT_WARP_HISTORY_SAFE_DESTINY_LEAD,
  PILOT_WARP_SOURCE_REMOVAL_SETTLE_MS,
} = require(path.join(runtimeEntryDirname, "./destiny/simulation/warpContract.js"));
const {
  normalizeDestinyStamp,
} = require(path.join(runtimeEntryDirname, "./destiny/delivery/stamps.js"));
const destiny = require(path.join(runtimeEntryDirname, "./destiny/index.js"));
const {
  estimateMissileEffectiveRange,
  estimateMissileClientImpactTimeMs,
  resolveMissileClientVisualProfile,
  estimateMissileFlightBudgetMs,
  resolveMissileAppliedDamage,
} = require(path.join(runtimeEntryDirname, "./combat/missiles/missileSolver"));
const {
  getEntitySurfaceDistance,
} = require("./entityDistance");
const {
  getMarshalDictEntry,
  getMarshalListItems,
  unwrapMarshalNumber,
} = require("./marshalWireValues");
const {
  roundNumber,
  toFiniteNumber,
  toInt,
} = require("../../common/numbers");
const {
  getShipEntityDebugCharacterID,
} = require("./shipEntity");
const {
  distance,
  magnitude,
} = require("../../common/vector");

const DEBUG_TEST_AUTO_TARGET_DEFAULT_RANGE_METERS = 250_000;

const MOVEMENT_DEBUG_PATH = resolveDataRootPath("logs", "space-movement-debug.log");

const DESTINY_DEBUG_PATH = resolveDataRootPath("logs", "space-destiny-debug.log");

const MISSILE_DEBUG_PATH = resolveDataRootPath("logs", "space-missile-debug.log");

const WARP_DEBUG_PATH = resolveDataRootPath("logs", "space-warp-debug.log");

const BALL_DEBUG_PATH = resolveDataRootPath("logs", "space-ball-debug.log");

const BUBBLE_DEBUG_PATH = resolveDataRootPath("logs", "space-bubble-debug.log");

const BUBBLE_DEBUG_ENTITY_ID_SAMPLE_LIMIT = 32;

const JUMP_TIMING_TRACE_PATH = resolveDataRootPath("logs", "space-jump-timing-trace.log");

const MOVEMENT_TRACE_WINDOW_MS = 5000;

const SESSION_JUMP_TRACE_WINDOW_MS = 120000;

const ATTACH_UNIVERSE_SITE_RECONCILE_DELAY_MS = 30_000;

const STRANDED_DESTINY_SESSION_SWEEP_INTERVAL_MS = 5000;

const STRANDED_DESTINY_SESSION_RECOVERY_MS = 15000;

let nextSessionJumpTraceID = 1;

let nextMovementTraceID = 1;

// Debug/test-only helper for slash-command FX previews. This is intentionally
// not gameplay target acquisition logic and should not be reused for modules.
function resolveDebugTestNearestStationTarget(
  scene,
  sourceEntity,
  maxRangeMeters = DEBUG_TEST_AUTO_TARGET_DEFAULT_RANGE_METERS,
) {
  if (!scene || !sourceEntity) {
    return {
      success: false,
      errorMsg: "DEBUG_TEST_TARGET_CONTEXT_MISSING",
    };
  }

  const numericMaxRangeMeters = Math.max(0, toFiniteNumber(
    maxRangeMeters,
    DEBUG_TEST_AUTO_TARGET_DEFAULT_RANGE_METERS,
  ));
  let nearestStation = null;
  let nearestDistanceMeters = Number.POSITIVE_INFINITY;
  for (const entity of scene.staticEntities) {
    if (!entity || entity.kind !== "station") {
      continue;
    }

    const entityDistanceMeters = distance(sourceEntity.position, entity.position);
    if (entityDistanceMeters < nearestDistanceMeters) {
      nearestStation = entity;
      nearestDistanceMeters = entityDistanceMeters;
    }
  }

  if (!nearestStation) {
    return {
      success: false,
      errorMsg: "DEBUG_TEST_TARGET_NO_STATION",
      data: {
        maxRangeMeters: numericMaxRangeMeters,
      },
    };
  }

  if (nearestDistanceMeters > numericMaxRangeMeters) {
    return {
      success: false,
      errorMsg: "DEBUG_TEST_TARGET_OUT_OF_RANGE",
      data: {
        maxRangeMeters: numericMaxRangeMeters,
        nearestDistanceMeters,
        targetID: nearestStation.itemID,
        targetName: nearestStation.itemName || `station ${nearestStation.itemID}`,
      },
    };
  }

  return {
    success: true,
    data: {
      maxRangeMeters: numericMaxRangeMeters,
      nearestDistanceMeters,
      target: nearestStation,
    },
  };
}

function summarizeVector(vector) {
  return {
    x: roundNumber(vector && vector.x),
    y: roundNumber(vector && vector.y),
    z: roundNumber(vector && vector.z),
  };
}

function isMovementTraceActive(entity, now = Date.now()) {
  return Boolean(
    entity &&
      entity.movementTrace &&
      Number(entity.movementTrace.untilMs || 0) > Number(now || Date.now()),
  );
}

function getMovementTraceSnapshot(entity, now = Date.now()) {
  if (!isMovementTraceActive(entity, now)) {
    return null;
  }

  return {
    id: toInt(entity.movementTrace.id, 0),
    reason: entity.movementTrace.reason || "unknown",
    stamp: toInt(entity.movementTrace.stamp, 0),
    ageMs: Math.max(0, toInt(now, Date.now()) - toInt(entity.movementTrace.startedAtMs, 0)),
    remainingMs: Math.max(0, toInt(entity.movementTrace.untilMs, 0) - toInt(now, Date.now())),
    context: entity.movementTrace.context || null,
  };
}

// A warp as the Ball carries it: its effectStamp, goto, factor and length,
// and the destination context gameplay keeps beside it.
function summarizeWarp(entity) {
  if (!entity || entity.mode !== "WARP") {
    return null;
  }
  const destination = entity.warpDestination || {};
  return {
    effectStamp: toInt(entity.effectStamp, 0),
    warpFactor: toInt(entity.warpFactor, 0),
    minRange: roundNumber(entity.warpMinRange),
    warpDistance: roundNumber(entity.warpDistance),
    targetPoint: summarizeVector(entity.targetPoint),
    rawDestination: summarizeVector(destination.rawDestination),
    targetEntityID: toInt(destination.targetEntityID, 0),
    destinationStaticInstanceID: toJSONSafeEntityID(
      destination.destinationStaticInstanceID,
    ),
  };
}

function armMovementTrace(entity, reason, context = {}, now = Date.now()) {
  if (!entity) {
    return null;
  }

  entity.movementTrace = {
    id: nextMovementTraceID++,
    reason,
    startedAtMs: now,
    untilMs: now + MOVEMENT_TRACE_WINDOW_MS,
    context,
  };
  return entity.movementTrace;
}

function appendMovementDebug(entry) {
  if (!log.isVerboseDebugEnabled()) {
    return;
  }
  try {
    rotatingLog.append(MOVEMENT_DEBUG_PATH, `[${new Date().toISOString()}] ${entry}\n`);
  } catch (error) {
    log.warn(`[SpaceRuntime] Failed to write movement debug log: ${error.message}`);
  }
}

function appendDestinyDebug(entry) {
  if (!log.isVerboseDebugEnabled()) {
    return;
  }
  try {
    rotatingLog.append(DESTINY_DEBUG_PATH, `[${new Date().toISOString()}] ${entry}\n`);
  } catch (error) {
    log.warn(`[SpaceRuntime] Failed to write destiny debug log: ${error.message}`);
  }
}

function isMissileDebugEnabled() {
  return (
    config.spaceMissileDebugEnabled === true &&
    log.isVerboseDebugEnabled()
  );
}

function appendMissileDebug(entry) {
  if (!isMissileDebugEnabled()) {
    return;
  }
  try {
    rotatingLog.append(MISSILE_DEBUG_PATH, `[${new Date().toISOString()}] ${entry}\n`);
  } catch (error) {
    log.warn(`[SpaceRuntime] Failed to write missile debug log: ${error.message}`);
  }
}

function appendWarpDebug(entry) {
  if (!log.isVerboseDebugEnabled()) {
    return;
  }
  try {
    rotatingLog.append(WARP_DEBUG_PATH, `[${new Date().toISOString()}] ${entry}\n`);
  } catch (error) {
    log.warn(`[SpaceRuntime] Failed to write warp debug log: ${error.message}`);
  }
}

function appendBallDebug(entry) {
  if (!log.isVerboseDebugEnabled()) {
    return;
  }
  try {
    rotatingLog.append(BALL_DEBUG_PATH, `[${new Date().toISOString()}] ${entry}\n`);
  } catch (error) {
    log.warn(`[SpaceRuntime] Failed to write ball debug log: ${error.message}`);
  }
}

function isBubbleDebugEnabled() {
  return (
    config.spaceBubbleDebugEnabled === true &&
    log.isVerboseDebugEnabled()
  );
}

function appendBubbleDebug(entry) {
  if (!isBubbleDebugEnabled()) {
    return;
  }
  try {
    rotatingLog.append(BUBBLE_DEBUG_PATH, `[${new Date().toISOString()}] ${entry}\n`);
  } catch (error) {
    log.warn(`[SpaceRuntime] Failed to append bubble debug log: ${error.message}`);
  }
}

function normalizeTraceValue(value, depth = 0) {
  if (depth > 4) {
    return "[depth-limit]";
  }
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (
    typeof value === "number" ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeTraceValue(entry, depth + 1));
  }
  if (value instanceof Set) {
    return Array.from(value.values()).map((entry) =>
      normalizeTraceValue(entry, depth + 1),
    );
  }
  if (typeof value === "object") {
    const normalized = {};
    for (const [key, entry] of Object.entries(value)) {
      if (typeof entry === "function") {
        continue;
      }
      normalized[key] = normalizeTraceValue(entry, depth + 1);
    }
    return normalized;
  }
  return String(value);
}

function limitTraceArray(values, limit = 20) {
  const normalizedValues = Array.isArray(values) ? values : [];
  const maxItems = Math.max(1, toInt(limit, 20));
  if (normalizedValues.length <= maxItems) {
    return normalizedValues;
  }
  return [
    ...normalizedValues.slice(0, maxItems),
    `[+${normalizedValues.length - maxItems} more]`,
  ];
}

function extractSlimItemIdentity(slimEntry) {
  const slimItem = Array.isArray(slimEntry) ? slimEntry[0] : slimEntry;
  const itemID = toInt(
    slimItem && typeof slimItem === "object" && "itemID" in slimItem
      ? slimItem.itemID
      : getMarshalDictEntry(slimItem, "itemID"),
    0,
  );
  const typeID = toInt(
    slimItem && typeof slimItem === "object" && "typeID" in slimItem
      ? slimItem.typeID
      : getMarshalDictEntry(slimItem, "typeID"),
    0,
  );
  return {
    itemID,
    typeID,
  };
}

function summarizeAddBalls2Args(args) {
  return getMarshalListItems(args).map((batchEntry, index) => {
    const stateBuffer = Array.isArray(batchEntry) ? batchEntry[0] : null;
    const slimEntries = getMarshalListItems(
      Array.isArray(batchEntry) ? batchEntry[1] : null,
    );
    const slimIDs = slimEntries
      .map((entry) => extractSlimItemIdentity(entry))
      .filter((entry) => entry.itemID > 0);
    return {
      batchIndex: index,
      stateStamp:
        Buffer.isBuffer(stateBuffer) && stateBuffer.length >= 5
          ? (stateBuffer.readUInt32LE(1) >>> 0)
          : 0,
      entityCount: slimIDs.length,
      entityIDs: limitTraceArray(
        slimIDs.map((entry) => entry.itemID),
        25,
      ),
      typeIDs: limitTraceArray(
        slimIDs.map((entry) => entry.typeID).filter((value) => value > 0),
        12,
      ),
    };
  });
}

function summarizeSetStateArgs(args) {
  const state = Array.isArray(args) ? args[0] : null;
  const slims = getMarshalListItems(getMarshalDictEntry(state, "slims"));
  const slimIDs = slims
    .map((entry) => extractSlimItemIdentity(entry))
    .filter((entry) => entry.itemID > 0);
  const damageState = getMarshalDictEntry(state, "damageState");
  const damageStateEntityIDs =
    damageState && damageState.type === "dict" && Array.isArray(damageState.entries)
      ? damageState.entries
        .map((entry) => toInt(Array.isArray(entry) ? entry[0] : 0, 0))
        .filter((value) => value > 0)
      : [];
  return [{
    stamp: toInt(getMarshalDictEntry(state, "stamp"), 0) >>> 0,
    ego: toInt(getMarshalDictEntry(state, "ego"), 0) >>> 0,
    slimCount: slimIDs.length,
    slimIDs: limitTraceArray(
      slimIDs.map((entry) => entry.itemID),
      25,
    ),
    damageStateEntityIDs: limitTraceArray(damageStateEntityIDs, 25),
  }];
}

function summarizeDamageStateArgs(args) {
  return [
    toInt(args && args[0], 0),
    normalizeTraceValue(args && args[1]),
  ];
}

function summarizeRemoveBallsArgs(args) {
  const entityIDs = getMarshalListItems(args && args[0])
    .map((entry) => toInt(entry, 0))
    .filter((value) => value > 0);
  return [{
    entityCount: entityIDs.length,
    entityIDs: limitTraceArray(entityIDs, 30),
  }];
}

const MISSILE_DEBUG_PAYLOAD_NAMES = new Set([
  "AddBalls2",
  "FollowBall",
  "GotoDirection",
  "LaunchMissile",
  "OnDamageStateChange",
  "Orbit",
  "RemoveBalls",
  "SetBallPosition",
  "SetBallVelocity",
  "SetSpeedFraction",
  "SetState",
  "TerminalPlayDestructionEffect",
]);

function summarizeMissileEntity(entity) {
  if (!entity || entity.kind !== "missile") {
    return null;
  }
  return {
    debugLaunchTraceID: toInt(entity.debugLaunchTraceID, 0),
    itemID: toInt(entity.itemID, 0),
    sourceShipID: toInt(entity.sourceShipID, 0),
    sourceModuleID: toInt(entity.sourceModuleID, 0),
    targetEntityID: toInt(entity.targetEntityID, 0),
    typeID: toInt(entity.typeID, 0),
    groupID: toInt(entity.groupID, 0),
    categoryID: toInt(entity.categoryID, 0),
    mode: String(entity.mode || ""),
    launchedAtMs: roundNumber(toFiniteNumber(entity.launchedAtMs, 0), 3),
    expiresAtMs: roundNumber(toFiniteNumber(entity.expiresAtMs, 0), 3),
    effectStamp: toInt(entity.effectStamp, 0),
    isMoribund: entity.isMoribund === true,
    clientDoSpread: entity.clientDoSpread === true,
    maxVelocity: roundNumber(toFiniteNumber(entity.maxVelocity, 0), 3),
    speedFraction: roundNumber(toFiniteNumber(entity.speedFraction, 0), 3),
    position: summarizeVector(entity.position),
    velocity: summarizeVector(entity.velocity),
    direction: summarizeVector(entity.direction),
    targetPoint: summarizeVector(entity.targetPoint),
    launchModules: Array.isArray(entity.launchModules)
      ? entity.launchModules.map((value) => toInt(value, 0))
      : [],
  };
}

function buildMissileSessionSnapshot(scene, session, rawSimTimeMs = null) {
  if (!session) {
    return null;
  }
  const nowMs =
    rawSimTimeMs === null || rawSimTimeMs === undefined
      ? scene && typeof scene.getCurrentSimTimeMs === "function"
        ? scene.getCurrentSimTimeMs()
        : Date.now()
      : toFiniteNumber(
        rawSimTimeMs,
        scene && typeof scene.getCurrentSimTimeMs === "function"
          ? scene.getCurrentSimTimeMs()
          : Date.now(),
      );
  const sessionSpace = session._space || null;
  const rawDispatchStamp =
    scene && typeof scene.nextDestinyStamp === "number"
      ? scene.nextDestinyStamp
      : null;
  // The scene counter is the only Destiny stamp: a session has
  // no stamp state of its own, only its sim clock offset.
  return {
    clientID: toInt(session.clientID, 0),
    charID: toInt(session.characterID, 0),
    shipID: toInt(sessionSpace && sessionSpace.shipID, 0),
    systemID: toInt(sessionSpace && sessionSpace.systemID, 0),
    nowMs: roundNumber(nowMs, 3),
    rawDispatchStamp,
    clockOffsetMs: roundNumber(toFiniteNumber(sessionSpace && sessionSpace.clockOffsetMs, 0), 3),
  };
}

function shouldLogMissilePayloadGroup(updates = []) {
  return (
    isMissileDebugEnabled() &&
    Array.isArray(updates) &&
    updates.some((update) => {
      const payloadName =
        update &&
        Array.isArray(update.payload)
          ? update.payload[0]
          : null;
      return MISSILE_DEBUG_PAYLOAD_NAMES.has(payloadName);
    })
  );
}

function summarizeMissileUpdatesForLog(updates = []) {
  return Array.isArray(updates)
    ? updates.map((update) => ({
        stamp: toInt(update && update.stamp, 0) >>> 0,
        missileLifecycleGroup:
          update && update.missileLifecycleGroup === true,
        ownerMissileLifecycleGroup:
          update && update.ownerMissileLifecycleGroup === true,
        name:
          update &&
          Array.isArray(update.payload)
            ? update.payload[0]
            : null,
        args: summarizeDestinyArgs(
          update &&
          Array.isArray(update.payload)
            ? update.payload[0]
            : null,
          update &&
          Array.isArray(update.payload)
            ? update.payload[1]
            : null,
        ),
      }))
    : [];
}

// `details` may be a function that builds them: it runs only while missile
// debug logging is on, so callers on hot paths build nothing when it is off.
function logMissileDebug(event, details = {}) {
  if (!isMissileDebugEnabled()) {
    return;
  }
  appendMissileDebug(JSON.stringify(normalizeTraceValue({
    event,
    atMs: Date.now(),
    ...(typeof details === "function" ? details() : details),
  })));
}

function summarizeMissileInventoryItemForDebug(item) {
  if (!item || typeof item !== "object") {
    return null;
  }
  return {
    itemID: toInt(item.itemID, 0),
    typeID: toInt(item.typeID, 0),
    ownerID: toInt(item.ownerID, 0),
    locationID: toInt(item.locationID, 0),
    flagID: toInt(item.flagID, 0),
    groupID: toInt(item.groupID, 0),
    categoryID: toInt(item.categoryID, 0),
    quantity: Math.max(0, toInt(item.quantity, 0)),
    stacksize: Math.max(0, toInt(item.stacksize, 0)),
    singleton: toInt(item.singleton, 0),
    launcherID: toInt(item.launcherID, 0),
    itemName: typeof item.itemName === "string" ? item.itemName : null,
    moduleState:
      item.moduleState && typeof item.moduleState === "object"
        ? {
            damage: roundNumber(toFiniteNumber(item.moduleState.damage, 0), 6),
            armorDamage: roundNumber(toFiniteNumber(item.moduleState.armorDamage, 0), 6),
            shieldCharge: roundNumber(toFiniteNumber(item.moduleState.shieldCharge, 0), 6),
            incapacitated: item.moduleState.incapacitated === true,
          }
        : null,
  };
}

function summarizeMissileWeaponSnapshotForDebug(snapshot) {
  if (!snapshot || typeof snapshot !== "object") {
    return null;
  }
  return {
    family: String(snapshot.family || ""),
    moduleID: toInt(snapshot.moduleID, 0),
    moduleTypeID: toInt(snapshot.moduleTypeID, 0),
    chargeItemID: toInt(snapshot.chargeItemID, 0),
    chargeTypeID: toInt(snapshot.chargeTypeID, 0),
    chargeQuantity: Math.max(0, toInt(snapshot.chargeQuantity, 0)),
    durationMs: roundNumber(toFiniteNumber(snapshot.durationMs, 0), 6),
    capNeed: roundNumber(toFiniteNumber(snapshot.capNeed, 0), 6),
    damageMultiplier: roundNumber(toFiniteNumber(snapshot.damageMultiplier, 0), 6),
    rawShotDamage:
      snapshot.rawShotDamage && typeof snapshot.rawShotDamage === "object"
        ? {
            em: roundNumber(toFiniteNumber(snapshot.rawShotDamage.em, 0), 6),
            thermal: roundNumber(toFiniteNumber(snapshot.rawShotDamage.thermal, 0), 6),
            kinetic: roundNumber(toFiniteNumber(snapshot.rawShotDamage.kinetic, 0), 6),
            explosive: roundNumber(toFiniteNumber(snapshot.rawShotDamage.explosive, 0), 6),
          }
        : null,
    flightTimeMs: roundNumber(toFiniteNumber(snapshot.flightTimeMs, 0), 6),
    maxVelocity: roundNumber(toFiniteNumber(snapshot.maxVelocity, 0), 6),
    approxRange: roundNumber(toFiniteNumber(snapshot.approxRange, 0), 6),
    explosionRadius: roundNumber(toFiniteNumber(snapshot.explosionRadius, 0), 6),
    explosionVelocity: roundNumber(toFiniteNumber(snapshot.explosionVelocity, 0), 6),
    damageReductionFactor: roundNumber(
      toFiniteNumber(snapshot.damageReductionFactor, 0),
      6,
    ),
    damageReductionSensitivity: roundNumber(
      toFiniteNumber(snapshot.damageReductionSensitivity, 0),
      6,
    ),
    moduleAttributes:
      snapshot.moduleAttributes && typeof snapshot.moduleAttributes === "object"
        ? snapshot.moduleAttributes
        : {},
    chargeAttributes:
      snapshot.chargeAttributes && typeof snapshot.chargeAttributes === "object"
        ? snapshot.chargeAttributes
        : {},
    shipModifierAttributes:
      snapshot.shipModifierAttributes && typeof snapshot.shipModifierAttributes === "object"
        ? snapshot.shipModifierAttributes
        : {},
    characterAttributes:
      snapshot.characterAttributes && typeof snapshot.characterAttributes === "object"
        ? snapshot.characterAttributes
        : {},
  };
}

function buildMissileChargeTupleDebugContext(attackerEntity, moduleItem, chargeItem) {
  const shipID = toInt(attackerEntity && attackerEntity.itemID, 0);
  const moduleFlagID = toInt(moduleItem && moduleItem.flagID, 0);
  const chargeTypeID = toInt(chargeItem && chargeItem.typeID, 0);
  return {
    shipID,
    moduleFlagID,
    chargeTypeID,
    tupleItemID:
      shipID > 0 && moduleFlagID > 0 && chargeTypeID > 0
        ? buildChargeTupleItemID(shipID, moduleFlagID, chargeTypeID)
        : null,
  };
}

function buildMissileLaunchRangeDebugContext(
  attackerEntity,
  targetEntity,
  weaponSnapshot,
  moduleItem = null,
  chargeItem = null,
) {
  if (!attackerEntity || !targetEntity || !weaponSnapshot) {
    return null;
  }
  const sourceRadius = Math.max(0, toFiniteNumber(attackerEntity.radius, 0));
  const surfaceDistance = roundNumber(
    getEntitySurfaceDistance(attackerEntity, targetEntity),
    6,
  );
  const effectiveRange = roundNumber(
    estimateMissileEffectiveRange(weaponSnapshot),
    6,
  );
  const flightBudgetMs = roundNumber(
    estimateMissileFlightBudgetMs(weaponSnapshot, sourceRadius),
    6,
  );
  const visualProfile = resolveMissileClientVisualProfile(
    attackerEntity.position,
    targetEntity.position,
    Math.max(0, toFiniteNumber(targetEntity.radius, 0)),
    Math.max(0, toFiniteNumber(weaponSnapshot.maxVelocity, 0)),
  );
  return {
    moduleItem: summarizeMissileInventoryItemForDebug(moduleItem),
    chargeItem: summarizeMissileInventoryItemForDebug(chargeItem),
    chargeTuple: buildMissileChargeTupleDebugContext(
      attackerEntity,
      moduleItem,
      chargeItem,
    ),
    weaponSnapshot: summarizeMissileWeaponSnapshotForDebug(weaponSnapshot),
    sourceRadius: roundNumber(sourceRadius, 6),
    targetRadius: roundNumber(toFiniteNumber(targetEntity.radius, 0), 6),
    surfaceDistance,
    effectiveRange,
    rangeMargin: roundNumber(effectiveRange - surfaceDistance, 6),
    flightBudgetMs,
    visualProfile: normalizeTraceValue(visualProfile),
  };
}

// A missile's flight as Evolve sees it: its slots, its target, its time left.
function buildMissileFlightSnapshot(scene, missileEntity, nowMs) {
  if (!scene || !missileEntity || missileEntity.kind !== "missile") {
    return null;
  }
  const targetEntity = scene.getEntityByID(missileEntity.targetEntityID);
  const expiresAtMs = toFiniteNumber(missileEntity.expiresAtMs, 0);
  const launchedAtMs = toFiniteNumber(missileEntity.launchedAtMs, 0);
  return {
    missile: summarizeMissileEntity(missileEntity),
    previousPosition: summarizeVector(missileEntity.oldPosition),
    target: targetEntity
      ? {
          itemID: toInt(targetEntity.itemID, 0),
          kind: String(targetEntity.kind || ""),
          mode: String(targetEntity.mode || ""),
          position: summarizeVector(targetEntity.position),
          velocity: summarizeVector(targetEntity.velocity),
          radius: roundNumber(toFiniteNumber(targetEntity.radius, 0), 3),
        }
      : null,
    nowMs: roundNumber(toFiniteNumber(nowMs, 0), 3),
    nextDestinyStamp: scene.nextDestinyStamp,
    launchAgeMs: roundNumber(Math.max(0, toFiniteNumber(nowMs, 0) - launchedAtMs), 3),
    flightBudgetMs: roundNumber(Math.max(0, expiresAtMs - launchedAtMs), 3),
    remainingExpiryMs: roundNumber(Math.max(0, expiresAtMs - toFiniteNumber(nowMs, 0)), 3),
  };
}

function summarizeRuntimeEntityForMissileDebug(entity) {
  if (!entity || typeof entity !== "object") {
    return null;
  }
  return {
    itemID: toInt(entity.itemID, 0),
    kind: String(entity.kind || ""),
    mode: String(entity.mode || ""),
    bubbleID: toInt(entity.bubbleID, 0),
    radius: roundNumber(toFiniteNumber(entity.radius, 0), 3),
    maxVelocity: roundNumber(toFiniteNumber(entity.maxVelocity, 0), 3),
    speedFraction: roundNumber(toFiniteNumber(entity.speedFraction, 0), 6),
    position: summarizeVector(entity.position),
    velocity: summarizeVector(entity.velocity),
    direction: summarizeVector(entity.direction),
    targetEntityID: toInt(entity.targetEntityID, 0),
    ownerShipID: toInt(entity.sourceShipID, 0),
    typeID: toInt(entity.typeID, 0),
  };
}

function buildSessionJumpTraceSnapshot(session) {
  if (!session) {
    return null;
  }
  return normalizeTraceValue({
    clientID: session.clientID || null,
    characterID: session.characterID || null,
    characterName: session.characterName || null,
    transitionState: session._transitionState || null,
    space: session._space
      ? {
          systemID: session._space.systemID,
          shipID: session._space.shipID,
          beyonceBound: session._space.beyonceBound === true,
          initialStateSent: session._space.initialStateSent === true,
          initialBallparkVisualsSent:
            session._space.initialBallparkVisualsSent === true,
          initialBallparkClockSynced:
            session._space.initialBallparkClockSynced === true,
          deferInitialBallparkClockUntilBind:
            session._space.deferInitialBallparkClockUntilBind === true,
          deferInitialBallparkStateUntilBind:
            session._space.deferInitialBallparkStateUntilBind === true,
          timeDilation: session._space.timeDilation,
          simTimeMs: session._space.simTimeMs,
          simFileTime: session._space.simFileTime,
        }
      : null,
    nextInitialBallparkPreviousSimTimeMs:
      session._nextInitialBallparkPreviousSimTimeMs ?? null,
    nextInitialBallparkPreviousTimeDilation:
      session._nextInitialBallparkPreviousTimeDilation ?? null,
    nextInitialBallparkPreviousCapturedAtWallclockMs:
      session._nextInitialBallparkPreviousCapturedAtWallclockMs ?? null,
    skipNextInitialBallparkRebase:
      session._skipNextInitialBallparkRebase === true,
  });
}

function appendJumpTimingTrace(entry) {
  if (!log.isVerboseDebugEnabled()) {
    return;
  }
  try {
    rotatingLog.append(
      JUMP_TIMING_TRACE_PATH,
      `${JSON.stringify(normalizeTraceValue({
        loggedAt: new Date().toISOString(),
        ...entry,
      }))}\n`,
    );
  } catch (error) {
    log.warn(`[SpaceRuntime] Failed to append jump timing trace log: ${error.message}`);
  }
}

function getActiveSessionJumpTrace(session) {
  if (!session || !session._jumpTimingTrace) {
    return null;
  }
  const trace = session._jumpTimingTrace;
  const now = Date.now();
  if (Number(trace.untilMs || 0) > 0 && now > Number(trace.untilMs)) {
    session._jumpTimingTrace = null;
    return null;
  }
  return trace;
}

function beginSessionJumpTimingTrace(session, kind, details = {}) {
  if (!session) {
    return null;
  }
  const now = Date.now();
  const trace = {
    id: nextSessionJumpTraceID++,
    kind,
    startedAtMs: now,
    untilMs: now + SESSION_JUMP_TRACE_WINDOW_MS,
  };
  session._jumpTimingTrace = trace;
  appendJumpTimingTrace({
    traceID: trace.id,
    event: "trace-start",
    kind,
    atMs: now,
    details,
    session: buildSessionJumpTraceSnapshot(session),
  });
  return trace;
}

function recordSessionJumpTimingTrace(session, event, details = {}) {
  const trace = getActiveSessionJumpTrace(session);
  if (!trace) {
    return false;
  }
  appendJumpTimingTrace({
    traceID: trace.id,
    event,
    kind: trace.kind,
    atMs: Date.now(),
    details,
    session: buildSessionJumpTraceSnapshot(session),
  });
  return true;
}

function logBubbleDebug(event, details = {}) {
  appendBubbleDebug(JSON.stringify({
    event,
    atMs: Date.now(),
    ...details,
  }));
}

function summarizeBubbleEntity(entity) {
  if (!entity) {
    return null;
  }

  return {
    itemID: toInt(entity.itemID, 0),
    name: String(entity.itemName || entity.name || ""),
    mode: String(entity.mode || ""),
    bubbleID: toInt(entity.bubbleID, 0),
    position: summarizeVector(entity.position),
    velocityMs: roundNumber(magnitude(entity.velocity || { x: 0, y: 0, z: 0 }), 3),
  };
}

function summarizeBubbleState(bubble) {
  if (!bubble) {
    return null;
  }

  const entityCount = bubble.entityIDs instanceof Set
    ? bubble.entityIDs.size
    : 0;
  const entityIDs = [];
  if (bubble.entityIDs instanceof Set) {
    for (const itemID of bubble.entityIDs) {
      entityIDs.push(toInt(itemID, 0));
      if (entityIDs.length >= BUBBLE_DEBUG_ENTITY_ID_SAMPLE_LIMIT) break;
    }
  }

  return {
    id: toInt(bubble.id, 0),
    uuid: String(bubble.uuid || ""),
    center: summarizeVector(bubble.center),
    entityCount,
    entityIDs,
    truncatedEntityIDCount: Math.max(0, entityCount - entityIDs.length),
  };
}

function logWarpDebug(event, entity, extra = {}) {
  if (!entity) {
    return;
  }

  const now = Date.now();
  appendWarpDebug(JSON.stringify({
    event,
    atMs: now,
    charID: getShipEntityDebugCharacterID(entity, 0),
    shipID: entity.itemID || 0,
    systemID: entity.systemID || 0,
    mode: entity.mode || "UNKNOWN",
    maxVelocity: roundNumber(entity.maxVelocity, 3),
    speedFraction: roundNumber(entity.speedFraction, 3),
    warp: summarizeWarp(entity),
    ...extra,
  }));
}

function logBallDebug(event, entity, extra = {}) {
  if (!entity) {
    return;
  }

  appendBallDebug(JSON.stringify({
    event,
    atMs: Date.now(),
    charID: getShipEntityDebugCharacterID(entity, 0),
    shipID: entity.itemID || 0,
    systemID: entity.systemID || 0,
    mode: entity.mode || "UNKNOWN",
    ...destiny.debugDescribeEntityBall(entity),
    ...extra,
  }));
}

function summarizeDestinyArgs(name, args) {
  switch (name) {
    case "GotoDirection":
    case "GotoPoint":
    case "SetBallVelocity":
    case "SetBallPosition":
      return [
        toInt(args && args[0], 0),
        roundNumber(unwrapMarshalNumber(args && args[1])),
        roundNumber(unwrapMarshalNumber(args && args[2])),
        roundNumber(unwrapMarshalNumber(args && args[3])),
      ];
    case "SetSpeedFraction":
      return [
        toInt(args && args[0], 0),
        roundNumber(unwrapMarshalNumber(args && args[1]), 3),
      ];
    case "FollowBall":
    case "Orbit":
      return [
        toInt(args && args[0], 0),
        toInt(args && args[1], 0),
        roundNumber(args && args[2]),
      ];
    case "Stop":
      return [toInt(args && args[0], 0)];
    case "LaunchMissile":
      return [
        toInt(args && args[0], 0),
        toInt(args && args[1], 0),
        toInt(args && args[2], 0),
        toInt(args && args[3], 0),
        toInt(args && args[4], 0),
      ];
    case "WarpTo":
      return [
        toInt(args && args[0], 0),
        roundNumber(unwrapMarshalNumber(args && args[1])),
        roundNumber(unwrapMarshalNumber(args && args[2])),
        roundNumber(unwrapMarshalNumber(args && args[3])),
        roundNumber(unwrapMarshalNumber(args && args[4])),
        toInt(args && args[5], 0),
      ];
    case "AddBall":
      return [
        toInt(args && args[0], 0),
        roundNumber(unwrapMarshalNumber(args && args[1])),
        roundNumber(unwrapMarshalNumber(args && args[2])),
        roundNumber(unwrapMarshalNumber(args && args[3])),
        toInt(args && args[4], 0),
        toInt(args && args[5], 0),
        toInt(args && args[6], 0),
        toInt(args && args[7], 0),
        toInt(args && args[8], 0),
        roundNumber(unwrapMarshalNumber(args && args[9])),
        roundNumber(unwrapMarshalNumber(args && args[10])),
        roundNumber(unwrapMarshalNumber(args && args[11])),
        roundNumber(unwrapMarshalNumber(args && args[12])),
        roundNumber(unwrapMarshalNumber(args && args[13])),
        roundNumber(unwrapMarshalNumber(args && args[14])),
        roundNumber(unwrapMarshalNumber(args && args[15]), 3),
        roundNumber(unwrapMarshalNumber(args && args[16]), 3),
      ];
    case "AddBalls2":
      return summarizeAddBalls2Args(args);
    case "SetState":
      return summarizeSetStateArgs(args);
    case "OnDamageStateChange":
      return summarizeDamageStateArgs(args);
    case "OnDbuffUpdated":
      return [{
        entityID: toInt(args && args[0], 0),
        dbuffCollectionIDs: getMarshalListItems(args && args[1])
          .map((entry) => toInt(Array.isArray(entry) ? entry[0] : 0, 0))
          .filter((value) => value > 0),
      }];
    case "RemoveBalls":
      return summarizeRemoveBallsArgs(args);
    default:
      return args;
  }
}

function logDestinyDispatch(session, payloads, waitForBubble) {
  // Read the verbose gate before summarising any update (the damage state
  // summaries among them): with verbose logging off, nothing is built.
  if (!log.isVerboseDebugEnabled() || !session || payloads.length === 0) {
    return;
  }

  const dispatchDestinyStamp = normalizeDestinyStamp(
    payloads[0] && payloads[0].stamp,
    0,
  );
  const stampLeads = payloads.map((update) => (
    normalizeDestinyStamp(update && update.stamp, dispatchDestinyStamp) - dispatchDestinyStamp
  ));
  appendDestinyDebug(JSON.stringify({
    event: "destiny.send",
    charID: session.characterID || 0,
    shipID: session._space ? session._space.shipID || 0 : 0,
    systemID: session._space ? session._space.systemID || 0 : 0,
    waitForBubble: Boolean(waitForBubble),
    dispatchDestinyStamp,
    maxLeadFromDispatch: stampLeads.length > 0 ? Math.max(...stampLeads) : 0,
    updates: payloads.map((update) => ({
      stamp: toInt(update && update.stamp, 0),
      leadFromDispatch: normalizeDestinyStamp(update && update.stamp, dispatchDestinyStamp) - dispatchDestinyStamp,
      name: update && update.payload ? update.payload[0] : null,
      args: summarizeDestinyArgs(
        update && update.payload ? update.payload[0] : null,
        update && update.payload ? update.payload[1] : null,
      ),
    })),
  }, (_key, value) => (typeof value === "bigint" ? value.toString() : value)));
}

// Drones re-issue the same orbit every tick, which wrote hundreds of
// cmd.orbit.duplicate records a second. The first record per ship is written
// in full; repeats with the same target, range and speed are counted and
// written as one summary record at most every few seconds. A ship with an
// active movement trace still logs every record. Holds plain values only,
// never entity references.
const ORBIT_DUPLICATE_SUMMARY_INTERVAL_MS = 5000;
const ORBIT_DUPLICATE_MAX_ENTRIES = 1024;
const orbitDuplicateDebugEntries = new Map();
let orbitDuplicateDebugTimer = null;
let orbitDuplicateDebugUntilMs = 0;

function appendOrbitDuplicateSummary(entry, now, reason) {
  if (entry.suppressedCount === 0) {
    return;
  }
  appendMovementDebug(JSON.stringify({
    event: "cmd.orbit.duplicate.summary",
    atMs: now,
    ...entry,
    reason,
  }, (_key, value) => (typeof value === "bigint" ? value.toString() : value)));
}

function flushOrbitDuplicateDebug() {
  clearTimeout(orbitDuplicateDebugTimer);
  orbitDuplicateDebugTimer = null;
  orbitDuplicateDebugUntilMs = 0;
  const now = Date.now();
  try {
    for (const entry of orbitDuplicateDebugEntries.values()) {
      appendOrbitDuplicateSummary(entry, now, "interval");
    }
  } catch (error) {
    // This also runs from a timer, where a throw would be uncaught.
    log.warn(`[SpaceRuntime] Failed to write orbit duplicate summary: ${error.message}`);
  } finally {
    orbitDuplicateDebugEntries.clear();
  }
}

function shouldLogOrbitDuplicate(entity, extra, now) {
  // The timer may not have run yet when the window has already ended.
  if (orbitDuplicateDebugTimer && now >= orbitDuplicateDebugUntilMs) {
    flushOrbitDuplicateDebug();
  }
  const shipID = entity.itemID || 0;
  const systemID = entity.systemID || 0;
  const previous = orbitDuplicateDebugEntries.get(shipID);
  if (isMovementTraceActive(entity, now)) {
    if (previous) {
      appendOrbitDuplicateSummary(previous, now, "trace");
      orbitDuplicateDebugEntries.delete(shipID);
    }
    return true;
  }
  if (
    previous &&
    previous.systemID === systemID &&
    previous.orbitTargetID === extra.orbitTargetID &&
    previous.orbitDistance === extra.orbitDistance &&
    previous.requestedSpeedFraction === extra.requestedSpeedFraction
  ) {
    previous.suppressedCount += 1;
    previous.lastAtMs = now;
    return false;
  }
  if (previous) {
    appendOrbitDuplicateSummary(previous, now, "signature-changed");
    orbitDuplicateDebugEntries.delete(shipID);
  } else if (orbitDuplicateDebugEntries.size >= ORBIT_DUPLICATE_MAX_ENTRIES) {
    const oldestShipID = orbitDuplicateDebugEntries.keys().next().value;
    appendOrbitDuplicateSummary(
      orbitDuplicateDebugEntries.get(oldestShipID),
      now,
      "capacity",
    );
    orbitDuplicateDebugEntries.delete(oldestShipID);
  }
  orbitDuplicateDebugEntries.set(shipID, {
    shipID,
    systemID,
    orbitTargetID: extra.orbitTargetID,
    orbitDistance: extra.orbitDistance,
    requestedSpeedFraction: extra.requestedSpeedFraction,
    // firstAtMs is the full record; suppressedCount counts only repeats.
    firstAtMs: now,
    lastAtMs: now,
    suppressedCount: 0,
  });
  if (!orbitDuplicateDebugTimer) {
    orbitDuplicateDebugUntilMs = now + ORBIT_DUPLICATE_SUMMARY_INTERVAL_MS;
    orbitDuplicateDebugTimer = setTimeout(
      flushOrbitDuplicateDebug,
      ORBIT_DUPLICATE_SUMMARY_INTERVAL_MS,
    );
    orbitDuplicateDebugTimer.unref();
  }
  return true;
}

function logMovementDebug(event, entity, extra = {}) {
  // appendMovementDebug drops the record when verbose logging is off; return
  // before building it.
  if (!entity || !log.isVerboseDebugEnabled()) {
    return;
  }

  const now = Date.now();
  if (
    event === "cmd.orbit.duplicate" &&
    !shouldLogOrbitDuplicate(entity, extra, now)
  ) {
    return;
  }
  appendMovementDebug(JSON.stringify({
    event,
    atMs: now,
    charID: getShipEntityDebugCharacterID(entity, 0),
    shipID: entity.itemID || 0,
    systemID: entity.systemID || 0,
    mode: entity.mode || "UNKNOWN",
    speedFraction: roundNumber(entity.speedFraction, 3),
    position: summarizeVector(entity.position),
    velocity: summarizeVector(entity.velocity),
    direction: summarizeVector(entity.direction),
    targetPoint: summarizeVector(entity.targetPoint),
    targetEntityID: entity.targetEntityID || 0,
    dockingTargetID: entity.dockingTargetID || 0,
    warp: summarizeWarp(entity),
    speed: roundNumber(magnitude(entity.velocity), 3),
    previousPosition: entity.oldPosition || null,
    trace: getMovementTraceSnapshot(entity, now),
    ...extra,
  }));
}

Object.assign(module.exports, {
  ATTACH_UNIVERSE_SITE_RECONCILE_DELAY_MS,
  BALL_DEBUG_PATH,
  BUBBLE_DEBUG_ENTITY_ID_SAMPLE_LIMIT,
  BUBBLE_DEBUG_PATH,
  DEBUG_TEST_AUTO_TARGET_DEFAULT_RANGE_METERS,
  DESTINY_DEBUG_PATH,
  JUMP_TIMING_TRACE_PATH,
  MISSILE_DEBUG_PATH,
  MISSILE_DEBUG_PAYLOAD_NAMES,
  MOVEMENT_DEBUG_PATH,
  MOVEMENT_TRACE_WINDOW_MS,
  SESSION_JUMP_TRACE_WINDOW_MS,
  STRANDED_DESTINY_SESSION_RECOVERY_MS,
  STRANDED_DESTINY_SESSION_SWEEP_INTERVAL_MS,
  WARP_DEBUG_PATH,
  nextMovementTraceID,
  nextSessionJumpTraceID,
});
