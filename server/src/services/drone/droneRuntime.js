"use strict";

const {
  toInt,
  toNumber,
} = require("../../common/numbers");

const path = require("path");

// Memoized resolver for lazy (circular-dependency-safe) requires that run on the
// drone tick path. require(path.join(__dirname, id)) costs ~1.8us/call even when
// cached (path rebuild + resolver lookup); caching the resolved reference drops
// it to a ~4ns Map lookup. Safe because the targets assign module.exports once
// at load (or mutate it in place), so the cached reference never goes stale.
const _lazyModuleCache = new Map();
function lazyRequire(relativeId) {
  let resolved = _lazyModuleCache.get(relativeId);
  if (resolved === undefined) {
    resolved = require(path.join(__dirname, relativeId));
    _lazyModuleCache.set(relativeId, resolved);
  }
  return resolved;
}

const log = require(path.join(__dirname, "../../utils/logger"));
const {
  findSessionByCharacterID,
} = require(path.join(__dirname, "../chat/sessionRegistry"));
const {
  ITEM_FLAGS,
  createSpaceItemForCharacter,
  grantItemToCharacterLocation,
  normalizeShipConditionState,
  removeInventoryItem,
  updateInventoryItem,
  updateInventoryItemSuccessOnly,
} = require(path.join(__dirname, "../inventory/itemStore"));
const {
  findItemById,
  listContainerItems,
} = require(path.join(__dirname, "../inventory/simulationInventoryProjection"));
const itemCustody = require(path.join(__dirname, "../inventory/itemCustody"));
const {
  buildEffectiveItemAttributeMap,
  buildShipResourceState,
  getAttributeIDByNames,
  getDynamicItemAttributeOverrides,
  getTypeAttributeValue,
} = require(path.join(__dirname, "../fitting/liveFittingState"));
const {
  getShipFittingSnapshot,
} = require(path.join(__dirname, "../../_secondary/fitting/fittingRuntime"));
const {
  resolveItemByName,
  resolveItemByTypeID,
} = require(path.join(__dirname, "../inventory/itemTypeRegistry"));
const {
  DRONE_CATEGORY_ID,
  isDroneItemRecord,
} = require(path.join(__dirname, "../fighter/fighterInventory"));
const {
  beginDogmaTick,
  endDogmaTick,
  resolveDroneOperationalAttributes,
  resolveDroneTooltipAttributes,
  buildDroneTooltipAttributeStamp,
  setControllerDogmaCacheRebuiltHandler,
  resolveDroneCombatSnapshot,
  resolveDroneMiningSnapshot,
  resolveDroneSalvageSnapshot,
  resolveDroneRepairSnapshot,
} = require(path.join(__dirname, "./droneDogma"));
const jammerModuleRuntime = require(path.join(
  __dirname,
  "../../space/modules/jammerModuleRuntime",
));
const assistanceModuleRuntime = require(path.join(
  __dirname,
  "../../space/modules/assistanceModuleRuntime",
));
const salvagerRuntime = require(path.join(
  __dirname,
  "../../space/modules/salvagerRuntime",
));
const {
  hasDamageableHealth,
} = require(path.join(__dirname, "../../space/combat/damage"));
const {
  computeMiningResult,
} = require(path.join(__dirname, "../mining/miningMath"));
const {
  MINING_HOLD_FLAGS,
  getPreferredMiningHoldFlagForType,
  getShipHoldCapacityByFlag,
} = require(path.join(__dirname, "../mining/miningInventory"));
const {
  ensureSceneMiningState,
  getMineableState,
  applyMiningDelta,
  shouldPersistMineableState,
} = require(path.join(__dirname, "../mining/miningRuntimeState"));
const {
  entityIDsEqual,
  normalizeNonNegativeInt64,
  normalizePersistentEntityID,
  toJSONSafeEntityID,
} = require(path.join(__dirname, "../../space/destiny/identity/entityID"));
const {
  buildChildEntityScopeMetadata,
  isSharedPveTarget,
} = require(path.join(
  __dirname,
  "../../space/destiny/identity/interactionScope",
));
const {
  createDroneOperationalMotionCommand,
} = require(path.join(__dirname, "../../space/destiny/commands/drone.js"));
const {
  buildDroneStateChangePresentation,
  canPresentDroneStateOnDestiny,
} = require(path.join(__dirname, "../../space/destiny/commands/droneState.js"));
const {
  resolveAbyssalPlayerLaunchScope,
  sessionClaimsAbyssalScene,
} = require(path.join(__dirname, "../_shared/abyssalPlayerLaunchScope"));
const {
  getSceneSurfaceDistance,
} = require(path.join(
  __dirname,
  "../../space/destiny/authority/sceneRangeDecision",
));
const {
  isWarping,
} = require(path.join(__dirname, "../../space/destiny/simulation/evolve.js"));

const STATE_IDLE = 0;
const STATE_COMBAT = 1;
const STATE_MINING = 2;
const STATE_APPROACHING = 3;
const STATE_DEPARTING = 4;
const STATE_PURSUIT = 6;
const STATE_SALVAGING = 18;
const ATTRIBUTE_DRONE_BANDWIDTH_USED =
  getAttributeIDByNames("droneBandwidthUsed", "droneBandwidthLoad", "droneBandwidth") ||
  1272;
// Ship-side drone limits. The fitting snapshot keys shipAttributes by numeric
// attribute ID (see normalizeNumericAttributeMap), so these must be read by ID,
// not by name. droneBandwidth (1271) is the hull's available Mbit/sec; each
// drone's droneBandwidthUsed (1272) draws against it, matching the client check
// in shipfitting/droneUtil.GetDroneBandwidth.
const ATTRIBUTE_DRONE_BANDWIDTH =
  getAttributeIDByNames("droneBandwidth") || 1271;
const ATTRIBUTE_MAX_ACTIVE_DRONES =
  getAttributeIDByNames("maxActiveDrones") || 352;

const DRONE_COMMAND_RETURN_BAY = "RETURN_BAY";
const DRONE_COMMAND_RETURN_HOME = "RETURN_HOME";
const DRONE_COMMAND_ENGAGE = "ENGAGE";
const DRONE_COMMAND_MINE = "MINE";
const DRONE_COMMAND_SALVAGE = "SALVAGE";
// Pilot assignments are NOT one of the DRONE_COMMAND_* task states above.
// Retail models them as an ACTIVITY that rides alongside whatever the drone is doing:
// the client's drone entry reads it out of OnDroneActivityChange and renders
// UI/Inflight/Drone/Assisting with cfg.eveowners.Get(activityID).name, so the
// wire pair has to be exactly ("assist"|"guard", <assigned characterID>). See
// eve/client/script/ui/inflight/drones/droneEntry.py GetDroneActivityDescription.
const DRONE_ACTIVITY_ASSIST = "assist";
const DRONE_ACTIVITY_GUARD = "guard";
// appConst.maxDroneAssist (V24.01): retail caps how many drones may assist one
// character at once, across every ship that pointed drones at them.
const MAX_DRONE_ASSIST = 20;
// A pod is a ship by category but never a valid assist subject — the client
// refuses it with DroneCommandRequiresShipButNotCapsule.
const GROUP_CAPSULE_ID = 29;
const ATTRIBUTE_DRONE_IS_AGGRESSIVE =
  getAttributeIDByNames("droneIsAggressive", "droneIsAgressive") || 1275;
const ATTRIBUTE_DRONE_FOCUS_FIRE =
  getAttributeIDByNames("droneFocusFire") || 1297;
const ATTRIBUTE_STRUCTURE_HP = getAttributeIDByNames("hp", "structureHP") || 9;
const ATTRIBUTE_MASS = getAttributeIDByNames("mass") || 4;
const ATTRIBUTE_MAX_VELOCITY = getAttributeIDByNames("maxVelocity") || 37;
const ATTRIBUTE_SHIELD_RECHARGE_RATE =
  getAttributeIDByNames("shieldRechargeRate") || 479;
const ATTRIBUTE_SHIELD_CAPACITY = getAttributeIDByNames("shieldCapacity") || 263;
const ATTRIBUTE_ARMOR_HP = getAttributeIDByNames("armorHP") || 265;
const ATTRIBUTE_AGILITY = getAttributeIDByNames("agility") || 70;
const ATTRIBUTE_ENTITY_FLY_RANGE =
  getAttributeIDByNames("entityFlyRange") || 416;
const ATTRIBUTE_ENTITY_CRUISE_SPEED =
  getAttributeIDByNames("entityCruiseSpeed") || 508;
const ATTRIBUTE_ENTITY_CHASE_MAX_DISTANCE =
  getAttributeIDByNames("entityChaseMaxDistance") || 665;
const ATTRIBUTE_ORBIT_RANGE = getAttributeIDByNames("orbitRange") || 157;
const ATTRIBUTE_DRONE_CONTROL_DISTANCE =
  getAttributeIDByNames("droneControlDistance") || 458;

const DRONE_BAY_SCOOP_DISTANCE_METERS = 2500;
// Same container and two-hour life as a pilot's own jetcan (jettisonRuntime).
const DRONE_SALVAGE_JETTISON_CONTAINER_NAME = "Cargo Container";
const DRONE_SALVAGE_JETTISON_LIFETIME_MS = 2 * 60 * 60 * 1000;
const DRONE_BAY_RETURN_APPROACH_DISTANCE_METERS = 0;
const DEFAULT_DRONE_LAUNCH_OFFSET_METERS = 75;
const MIN_ORBIT_DISTANCE_METERS = 500;
const MAX_ORBIT_DISTANCE_METERS = 5000;
// Drone control range base: a pilot with no control-range bonus has 20 km, and
// the derived droneControlDistance (458) only appears in the ship snapshot once
// a bonus introduces it, so an absent value falls back to this base.
const DEFAULT_DRONE_CONTROL_DISTANCE_METERS = 20000;
const MIN_DRONE_MAX_VELOCITY = 0.00001;
const ONE_METER = 1;
const DRONE_FAST_PROPULSION_DEAD_BAND_FRACTION = 0.5;
const DRONE_SPEED_FRACTION_EPSILON = 0.000001;
const DEFAULT_DRONE_IS_AGGRESSIVE = true;
const DEFAULT_DRONE_FOCUS_FIRE = false;
const DRONE_AGGRESSION_THREAT_RETENTION_MS = 30_000;
const DRONE_WINDOW_SETTLE_DELAY_MS = 350;
// Module-private capability: only commandEngage's synchronous planning pass
// can certify that the exact entity references below were already validated.
// RPC input can never manufacture a Symbol value.
const MANUAL_ENGAGE_PREFLIGHT = Symbol("manual-drone-engage-preflight");

const PLAYER_COMPANION_AIR_SCOPE_ID_FIELDS = Object.freeze([
  "airNpeOwnerCharacterID",
  "airNpeOperationID",
  "airNpeInstanceID",
]);
const PLAYER_COMPANION_ABYSSAL_SCOPE_ID_FIELDS = Object.freeze([
  "abyssalRunID",
  "evejsAbyssalInstanceID",
  "evejsAbyssalPocketInstanceID",
]);
const PLAYER_COMPANION_ABYSSAL_ROOM_INDEX_FIELDS = Object.freeze([
  "abyssalRoomIndex",
  "evejsAbyssalRoomIndex",
]);
const ABYSSAL_PLAYER_COMPANION_CUSTOM_INFO_KEY =
  "evejsAbyssalPlayerCompanion";
const PLAYER_COMPANION_INVALID_SCOPE_SENTINEL =
  "invalid-player-companion-scope";

function resolveAbyssalPlayerCompanionInstanceID(source = null) {
  let resolvedInstanceID = null;
  for (const key of PLAYER_COMPANION_ABYSSAL_SCOPE_ID_FIELDS) {
    const rawValue = source && source[key];
    if (rawValue === undefined || rawValue === null) {
      continue;
    }
    const value = normalizePersistentEntityID(rawValue);
    if (
      value === null ||
      (resolvedInstanceID !== null && !entityIDsEqual(resolvedInstanceID, value))
    ) {
      return null;
    }
    resolvedInstanceID = value;
  }
  return resolvedInstanceID;
}

function resolveAbyssalPlayerCompanionRoomIndex(source = null) {
  let resolvedRoomIndex = null;
  for (const key of PLAYER_COMPANION_ABYSSAL_ROOM_INDEX_FIELDS) {
    const rawValue = source && source[key];
    if (rawValue === undefined || rawValue === null) {
      continue;
    }
    const value = toInt(rawValue, 0);
    if (
      value <= 0 ||
      (resolvedRoomIndex !== null && resolvedRoomIndex !== value)
    ) {
      return null;
    }
    resolvedRoomIndex = value;
  }
  return resolvedRoomIndex;
}

function buildDroneAbyssalOwnershipCustomInfo(currentItem, source = null) {
  const rawCustomInfo = String(currentItem && currentItem.customInfo || "").trim();
  let parsedCustomInfo = null;
  if (rawCustomInfo) {
    try {
      const parsed = JSON.parse(rawCustomInfo);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        parsedCustomInfo = { ...parsed };
      }
    } catch (_) {
      // ignored: preserve an opaque legacy value when adding an Abyssal ownership tag.
    }
  }

  const hasAbyssalScope = PLAYER_COMPANION_ABYSSAL_SCOPE_ID_FIELDS.some(
    (key) =>
      source &&
      source[key] !== undefined &&
      source[key] !== null,
  );
  const instanceID = resolveAbyssalPlayerCompanionInstanceID(source);
  const hasAbyssalRoomScope = PLAYER_COMPANION_ABYSSAL_ROOM_INDEX_FIELDS.some(
    (key) =>
      source &&
      source[key] !== undefined &&
      source[key] !== null,
  );
  const roomIndex = resolveAbyssalPlayerCompanionRoomIndex(source);
  if (!hasAbyssalScope) {
    if (
      parsedCustomInfo &&
      Object.prototype.hasOwnProperty.call(
        parsedCustomInfo,
        ABYSSAL_PLAYER_COMPANION_CUSTOM_INFO_KEY,
      )
    ) {
      delete parsedCustomInfo[ABYSSAL_PLAYER_COMPANION_CUSTOM_INFO_KEY];
      const remainingKeys = Object.keys(parsedCustomInfo);
      if (
        remainingKeys.length === 1 &&
        remainingKeys[0] === "evejsLegacyDroneCustomInfo" &&
        typeof parsedCustomInfo.evejsLegacyDroneCustomInfo === "string"
      ) {
        return parsedCustomInfo.evejsLegacyDroneCustomInfo;
      }
      return Object.keys(parsedCustomInfo).length > 0
        ? JSON.stringify(parsedCustomInfo)
        : "";
    }
    return rawCustomInfo;
  }

  const nextCustomInfo = parsedCustomInfo || (
    rawCustomInfo
      ? { evejsLegacyDroneCustomInfo: rawCustomInfo }
      : {}
  );
  if (
    instanceID === null ||
    (hasAbyssalRoomScope && roomIndex === null)
  ) {
    nextCustomInfo[ABYSSAL_PLAYER_COMPANION_CUSTOM_INFO_KEY] = {
      instanceID: 0,
      companionKind: "drone",
      invalid: true,
    };
    return JSON.stringify(nextCustomInfo);
  }
  nextCustomInfo[ABYSSAL_PLAYER_COMPANION_CUSTOM_INFO_KEY] = {
    instanceID: toJSONSafeEntityID(instanceID),
    ...(roomIndex !== null ? { roomIndex } : {}),
    companionKind: "drone",
    controllerID: toJSONSafeEntityID(
      normalizePersistentEntityID(
        source && (source.controllerID ?? source.launcherID),
      ),
    ),
  };
  return JSON.stringify(nextCustomInfo);
}

function buildPlayerCompanionScopeMetadata(controllerEntity = null) {
  if (!controllerEntity || typeof controllerEntity !== "object") {
    return {};
  }

  const metadata = {};
  for (const key of PLAYER_COMPANION_AIR_SCOPE_ID_FIELDS) {
    const rawValue = controllerEntity[key];
    if (rawValue === undefined || rawValue === null) {
      continue;
    }
    const value = normalizePersistentEntityID(rawValue);
    if (value !== null) {
      metadata[key] = toJSONSafeEntityID(value);
    } else {
      metadata[key] = PLAYER_COMPANION_INVALID_SCOPE_SENTINEL;
    }
  }

  for (const key of PLAYER_COMPANION_ABYSSAL_SCOPE_ID_FIELDS) {
    const rawValue = controllerEntity[key];
    if (rawValue === undefined || rawValue === null) {
      continue;
    }
    const value = normalizePersistentEntityID(rawValue);
    if (value !== null) {
      metadata[key] = toJSONSafeEntityID(value);
    } else {
      metadata[key] = PLAYER_COMPANION_INVALID_SCOPE_SENTINEL;
    }
  }
  for (const key of PLAYER_COMPANION_ABYSSAL_ROOM_INDEX_FIELDS) {
    const rawValue = controllerEntity[key];
    if (rawValue === undefined || rawValue === null) {
      continue;
    }
    const value = toInt(rawValue, 0);
    metadata[key] = value > 0
      ? value
      : PLAYER_COMPANION_INVALID_SCOPE_SENTINEL;
  }

  // The player ship's accepted dungeon tracker is the sole room/site truth.
  // A launched child receives a presentation scope without manufacturing a
  // second dungeonSiteInstanceID authority on the controller.
  const dungeonSiteInstanceID = normalizePersistentEntityID(
    controllerEntity.dungeonCurrentInstanceID,
  );
  if (dungeonSiteInstanceID !== null) {
    metadata.dungeonSiteInstanceID = toJSONSafeEntityID(
      dungeonSiteInstanceID,
    );
  }
  if (
    getPlayerCompanionSecurityScope(controllerEntity, {
      controller: true,
    }).invalid === true
  ) {
    metadata.dungeonSiteInstanceID =
      PLAYER_COMPANION_INVALID_SCOPE_SENTINEL;
  }
  return metadata;
}

function applyPlayerCompanionScopeMetadata(entity, source = null) {
  if (!entity || !source || typeof source !== "object") {
    return entity;
  }
  for (const key of [
    ...PLAYER_COMPANION_AIR_SCOPE_ID_FIELDS,
    ...PLAYER_COMPANION_ABYSSAL_SCOPE_ID_FIELDS,
    ...PLAYER_COMPANION_ABYSSAL_ROOM_INDEX_FIELDS,
    "dungeonSiteInstanceID",
  ]) {
    const rawValue = source[key];
    if (rawValue === undefined || rawValue === null) {
      continue;
    }
    const value = normalizePersistentEntityID(rawValue);
    if (value !== null) {
      const hasExistingValue = Object.hasOwn(entity, key) &&
        entity[key] !== null &&
        entity[key] !== undefined;
      const existingValue = hasExistingValue
        ? normalizePersistentEntityID(entity[key])
        : null;
      if (
        hasExistingValue &&
        (
          existingValue === null ||
          !entityIDsEqual(existingValue, value)
        )
      ) {
        entity[key] = PLAYER_COMPANION_INVALID_SCOPE_SENTINEL;
        entity.playerCompanionScopeInvalid = true;
      } else {
        entity[key] = value;
      }
    } else {
      entity[key] = PLAYER_COMPANION_INVALID_SCOPE_SENTINEL;
      entity.playerCompanionScopeInvalid = true;
    }
  }
  return entity;
}

function serializePlayerCompanionScopeMetadata(entity = null) {
  if (!entity || typeof entity !== "object") {
    return {};
  }
  const metadata = {};
  for (const key of [
    ...PLAYER_COMPANION_AIR_SCOPE_ID_FIELDS,
    ...PLAYER_COMPANION_ABYSSAL_SCOPE_ID_FIELDS,
    ...PLAYER_COMPANION_ABYSSAL_ROOM_INDEX_FIELDS,
    "dungeonSiteInstanceID",
  ]) {
    const rawValue = entity[key];
    if (rawValue === undefined || rawValue === null) {
      continue;
    }
    const value = normalizePersistentEntityID(rawValue);
    if (value !== null) {
      metadata[key] = toJSONSafeEntityID(value);
    } else {
      metadata[key] = PLAYER_COMPANION_INVALID_SCOPE_SENTINEL;
    }
  }
  return metadata;
}

function getPlayerCompanionSecurityScope(entity = null, options = {}) {
  const scope = {
    invalid: Boolean(entity && entity.playerCompanionScopeInvalid === true),
  };
  const isController = options.controller === true;
  const isPlayerShipController = Boolean(
    isController &&
    entity &&
    entity.kind === "ship",
  );
  const rawSiteInstanceID = entity && entity.dungeonSiteInstanceID;
  const rawCurrentInstanceID = entity && entity.dungeonCurrentInstanceID;
  const rawDungeonSiteID = entity && entity.dungeonSiteID;
  const rawCurrentSiteID = entity && entity.dungeonCurrentSiteID;
  const siteInstanceID = normalizePersistentEntityID(rawSiteInstanceID);
  const currentInstanceID = normalizePersistentEntityID(rawCurrentInstanceID);
  let abyssalInstanceID = null;
  let abyssalInstancePresent = false;
  for (const key of PLAYER_COMPANION_ABYSSAL_SCOPE_ID_FIELDS) {
    const rawValue = entity && entity[key];
    if (rawValue === undefined || rawValue === null) {
      continue;
    }
    abyssalInstancePresent = true;
    const value = normalizePersistentEntityID(rawValue);
    if (
      value === null ||
      (abyssalInstanceID !== null && !entityIDsEqual(abyssalInstanceID, value))
    ) {
      scope.invalid = true;
      continue;
    }
    abyssalInstanceID = value;
  }
  let abyssalRoomIndex = null;
  let abyssalRoomPresent = false;
  for (const key of PLAYER_COMPANION_ABYSSAL_ROOM_INDEX_FIELDS) {
    const rawValue = entity && entity[key];
    if (rawValue === undefined || rawValue === null) {
      continue;
    }
    abyssalRoomPresent = true;
    const value = toInt(rawValue, 0);
    if (
      value <= 0 ||
      (abyssalRoomIndex !== null && abyssalRoomIndex !== value)
    ) {
      scope.invalid = true;
      continue;
    }
    abyssalRoomIndex = value;
  }
  const hasDungeonSiteID = Boolean(
    entity &&
    Object.hasOwn(entity, "dungeonSiteID") &&
    rawDungeonSiteID !== undefined &&
    rawDungeonSiteID !== null,
  );
  const hasCurrentSiteID = Boolean(
    entity &&
    Object.hasOwn(entity, "dungeonCurrentSiteID") &&
    rawCurrentSiteID !== undefined &&
    rawCurrentSiteID !== null,
  );
  const dungeonSiteID = normalizePersistentEntityID(rawDungeonSiteID);
  const currentSiteID = normalizePersistentEntityID(rawCurrentSiteID);
  let hasPlayerDungeonTrackingContext = false;
  if (entity && entity.kind === "ship") {
    for (const [key, normalizeIdentity] of [
      ["dungeonCurrentDungeonID", normalizePersistentEntityID],
      ["dungeonCurrentRoomID", normalizeNonNegativeInt64],
      ["dungeonCurrentSiteID", normalizePersistentEntityID],
    ]) {
      const rawValue = entity && entity[key];
      if (
        rawValue === undefined ||
        rawValue === null
      ) {
        continue;
      }
      hasPlayerDungeonTrackingContext = true;
      if (normalizeIdentity(rawValue) === null) {
        scope.invalid = true;
      }
    }
    hasPlayerDungeonTrackingContext = Boolean(
      hasPlayerDungeonTrackingContext ||
      String(entity.dungeonCurrentRoomKey || "").trim() ||
      Array.isArray(entity.dungeonCurrentRoomPosition)
    );
  }
  if (
    (rawSiteInstanceID !== undefined &&
      rawSiteInstanceID !== null &&
      siteInstanceID === null) ||
    (rawCurrentInstanceID !== undefined &&
      rawCurrentInstanceID !== null &&
      currentInstanceID === null) ||
    (siteInstanceID !== null &&
      currentInstanceID !== null &&
      !entityIDsEqual(siteInstanceID, currentInstanceID)) ||
    (isPlayerShipController &&
      siteInstanceID !== null &&
      currentInstanceID === null) ||
    (entity && entity.kind === "ship" &&
      currentInstanceID === null &&
      hasPlayerDungeonTrackingContext)
  ) {
    scope.invalid = true;
  }
  const dungeonInstanceID = isPlayerShipController
    ? currentInstanceID
    : siteInstanceID !== null
      ? siteInstanceID
      : entity && entity.kind === "ship"
        ? currentInstanceID
        : null;
  if (
    dungeonInstanceID !== null &&
    abyssalInstanceID !== null &&
    !entityIDsEqual(dungeonInstanceID, abyssalInstanceID)
  ) {
    scope.invalid = true;
  }
  scope.dungeonSiteInstanceID = dungeonInstanceID !== null
    ? dungeonInstanceID
    : abyssalInstanceID;
  scope.abyssalInstanceID = abyssalInstanceID;
  scope.abyssalRoomIndex = abyssalRoomIndex;
  if (
    hasDungeonSiteID &&
    (
      dungeonSiteID === null ||
      scope.dungeonSiteInstanceID === null ||
      (
        isController &&
        entity &&
        entity.kind === "ship" &&
        hasCurrentSiteID &&
        (
          currentSiteID === null ||
          !entityIDsEqual(dungeonSiteID, currentSiteID)
        )
      )
    )
  ) {
    scope.invalid = true;
  }
  for (const key of PLAYER_COMPANION_AIR_SCOPE_ID_FIELDS) {
    const rawValue = entity && entity[key];
    const value = normalizePersistentEntityID(rawValue);
    if (rawValue !== undefined && rawValue !== null && value === null) {
      scope.invalid = true;
    }
    scope[key] = value;
  }
  scope.effectiveInstanceID =
    scope.dungeonSiteInstanceID ?? scope.airNpeInstanceID;
  const hasDungeonScopeMarker = Boolean(
    entity && (
      entity.dungeonMaterializedContainer === true ||
      entity.dungeonMaterializedSiteContent === true ||
      entity.dungeonSiteContentBonus === true ||
      entity.dungeonSiteContentFailureExplodes === true ||
      entity.dungeonSiteContentPersistsAfterResponse === true ||
      [
        "dungeonEncounterKey",
        "dungeonSiteContentKey",
        "dungeonSiteContentRole",
        "dungeonSiteContentAnalyzer",
        "dungeonSiteContentTrigger",
        "dungeonSiteContentLootProfile",
        "dungeonSiteContentHackingDifficulty",
      ].some((key) => String(entity[key] || "").trim()) ||
      Array.isArray(entity.dungeonSiteContentExplicitLoot) ||
      Array.isArray(entity.dungeonSiteContentLootTags)
    )
  );
  const hasAirScopeMarker = Boolean(
    entity && (
      entity.airNpeBoardingShipPresentation === true ||
      entity.airNpeTutorialDebris === true ||
      entity.airNpeHostile === true ||
      String(entity.airNpeHostileWave || "").trim()
    )
  );
  if (
    (hasDungeonScopeMarker && scope.dungeonSiteInstanceID === null) ||
    (abyssalInstancePresent && abyssalInstanceID === null) ||
    (abyssalRoomPresent && (
      abyssalRoomIndex === null ||
      abyssalInstanceID === null
    )) ||
    (
      hasAirScopeMarker &&
      scope.airNpeInstanceID === null &&
      scope.airNpeOwnerCharacterID === null
    ) ||
    (scope.effectiveInstanceID === null &&
    (
      scope.airNpeOwnerCharacterID !== null ||
      scope.airNpeOperationID !== null
    ))
  ) {
    scope.invalid = true;
  }
  return scope;
}

function resolveExactCompanionActorCharacterID(entity = null, session = null) {
  let resolvedCharacterID = null;
  let invalid = false;
  const candidates = [];
  if (session && typeof session === "object") {
    for (const key of ["characterID", "charID", "charid"]) {
      if (Object.hasOwn(session, key)) {
        candidates.push(session[key]);
      }
    }
  }
  if (entity && typeof entity === "object") {
    for (const key of ["characterID", "pilotCharacterID"]) {
      if (Object.hasOwn(entity, key)) {
        candidates.push(entity[key]);
      }
    }
    if (entity.kind === "ship" && Object.hasOwn(entity, "ownerID")) {
      candidates.push(entity.ownerID);
    }
  }
  for (const rawValue of candidates) {
    if (
      rawValue === undefined ||
      rawValue === null ||
      String(rawValue).trim() === ""
    ) {
      continue;
    }
    const value = normalizePersistentEntityID(rawValue);
    if (
      value === null ||
      (resolvedCharacterID !== null &&
        !entityIDsEqual(resolvedCharacterID, value))
    ) {
      invalid = true;
      continue;
    }
    resolvedCharacterID = value;
  }
  return { invalid, value: resolvedCharacterID };
}

function dungeonInstanceScopesAreCompatible(
  scene,
  visibilitySession,
  companionScope,
  targetScope,
) {
  const companionDungeonInstanceID = companionScope.effectiveInstanceID;
  const targetDungeonInstanceID = targetScope.effectiveInstanceID;
  if (
    companionDungeonInstanceID === null &&
    targetDungeonInstanceID === null
  ) {
    return true;
  }
  if (
    companionDungeonInstanceID !== null &&
    targetDungeonInstanceID !== null
  ) {
    return entityIDsEqual(
      companionDungeonInstanceID,
      targetDungeonInstanceID,
    );
  }

  const scopedScope = companionDungeonInstanceID !== null
    ? companionScope
    : targetScope;
  const scopedInstanceID = companionDungeonInstanceID !== null
    ? companionDungeonInstanceID
    : targetDungeonInstanceID;
  if (
    scopedScope.dungeonSiteInstanceID === null ||
    !entityIDsEqual(scopedScope.dungeonSiteInstanceID, scopedInstanceID) ||
    !scene ||
    !visibilitySession ||
    typeof scene.resolveDungeonInstanceVisibilityForSession !== "function"
  ) {
    return false;
  }

  try {
    const resolution = scene.resolveDungeonInstanceVisibilityForSession(
      visibilitySession,
      scopedInstanceID,
    );
    return Boolean(resolution && resolution.isPrivate === false);
  } catch (_error) {
    // ignored: an unreadable dungeon visibility is not public, so the scopes are not compatible (fail closed)
    return false;
  }
}

function playerCompanionTargetScopeIsCompatible(
  companionScope,
  targetScope,
  controllerEntity,
  targetEntity,
  session,
  scene,
  visibilitySession,
) {
  if (
    !companionScope ||
    !targetScope ||
    companionScope.invalid === true ||
    targetScope.invalid === true
  ) {
    return false;
  }

  if (!abyssalRunRoomScopesExactlyMatch(companionScope, targetScope)) {
    return false;
  }

  // A mission/site controller has no player ownership claim over its rats or
  // mineable rocks.  Let a companion act on these shared targets even when its
  // controller did not enter through that site's private access list.  AIR and
  // Abyssal are real isolated lanes and remain subject to their exact scopes.
  const sharedPveTarget = isSharedPveTarget(targetEntity) &&
    companionScope.airNpeOperationID === null &&
    companionScope.airNpeInstanceID === null &&
    companionScope.airNpeOwnerCharacterID === null &&
    targetScope.airNpeOperationID === null &&
    targetScope.airNpeInstanceID === null &&
    targetScope.airNpeOwnerCharacterID === null;
  if (!sharedPveTarget && !dungeonInstanceScopesAreCompatible(
    scene,
    visibilitySession,
    companionScope,
    targetScope,
  )) {
    return false;
  }

  for (const key of ["airNpeOperationID", "airNpeInstanceID"]) {
    const companionValue = companionScope[key];
    const targetValue = targetScope[key];
    if (
      companionValue !== null &&
      targetValue !== null &&
      !entityIDsEqual(companionValue, targetValue)
    ) {
      return false;
    }
  }

  const companionOwnerCharacterID = companionScope.airNpeOwnerCharacterID;
  const targetOwnerCharacterID = targetScope.airNpeOwnerCharacterID;
  if (
    companionOwnerCharacterID !== null &&
    targetOwnerCharacterID !== null
  ) {
    return entityIDsEqual(
      companionOwnerCharacterID,
      targetOwnerCharacterID,
    );
  }

  if (companionOwnerCharacterID !== null) {
    const targetActor = resolveExactCompanionActorCharacterID(
      targetEntity,
      targetEntity && targetEntity.session,
    );
    if (targetActor.invalid) {
      return false;
    }
    if (
      targetActor.value !== null &&
      !entityIDsEqual(companionOwnerCharacterID, targetActor.value)
    ) {
      return false;
    }
    if (targetEntity && targetEntity.kind === "ship" && targetActor.value === null) {
      return false;
    }
  }

  if (targetOwnerCharacterID !== null) {
    const controllerActor = resolveExactCompanionActorCharacterID(
      controllerEntity,
      session || (controllerEntity && controllerEntity.session),
    );
    if (
      controllerActor.invalid ||
      controllerActor.value === null ||
      !entityIDsEqual(targetOwnerCharacterID, controllerActor.value)
    ) {
      return false;
    }
  }

  return true;
}

function abyssalRunRoomScopesExactlyMatch(leftScope, rightScope) {
  const leftRunID = leftScope && leftScope.abyssalInstanceID != null
    ? leftScope.abyssalInstanceID
    : null;
  const rightRunID = rightScope && rightScope.abyssalInstanceID != null
    ? rightScope.abyssalInstanceID
    : null;
  const leftRoomIndex = toInt(leftScope && leftScope.abyssalRoomIndex, 0);
  const rightRoomIndex = toInt(rightScope && rightScope.abyssalRoomIndex, 0);
  const hasAbyssalScope = Boolean(
    leftRunID !== null ||
    rightRunID !== null ||
    leftRoomIndex > 0 ||
    rightRoomIndex > 0
  );
  if (!hasAbyssalScope) {
    return true;
  }
  return Boolean(
    leftRunID !== null &&
    rightRunID !== null &&
    entityIDsEqual(leftRunID, rightRunID) &&
    leftRoomIndex > 0 &&
    rightRoomIndex > 0 &&
    leftRoomIndex === rightRoomIndex
  );
}

function securityScopesExactlyMatch(leftScope, rightScope) {
  if (
    !leftScope ||
    !rightScope ||
    leftScope.invalid === true ||
    rightScope.invalid === true
  ) {
    return false;
  }
  if (!abyssalRunRoomScopesExactlyMatch(leftScope, rightScope)) {
    return false;
  }
  for (const key of [
    "dungeonSiteInstanceID",
    ...PLAYER_COMPANION_AIR_SCOPE_ID_FIELDS,
  ]) {
    const left = leftScope && leftScope[key];
    const right = rightScope && rightScope[key];
    if (left === null && right === null) {
      continue;
    }
    if (left === null || right === null || !entityIDsEqual(left, right)) {
      return false;
    }
  }
  return true;
}

function hasPlayerCompanionSecurityScope(scope) {
  return Boolean(
    scope && (
      scope.invalid === true ||
      [
        "dungeonSiteInstanceID",
        ...PLAYER_COMPANION_AIR_SCOPE_ID_FIELDS,
      ].some((key) => scope[key] !== null)
    ),
  );
}

function canPlayerCompanionActOnTarget(
  scene,
  session,
  companionEntity,
  controllerEntity,
  targetEntity,
) {
  if (!scene || !companionEntity || !controllerEntity || !targetEntity) {
    return false;
  }

  const companionScope = getPlayerCompanionSecurityScope(companionEntity);
  const controllerScope = getPlayerCompanionSecurityScope(controllerEntity, {
    controller: true,
  });
  const targetScope = getPlayerCompanionSecurityScope(targetEntity);
  const isPlayerShipController = Boolean(
    controllerEntity.kind === "ship",
  );
  const controllerSession =
    session || resolveDroneControllerSession(companionEntity, controllerEntity);
  const effectiveSession =
    controllerSession || (!isPlayerShipController && targetEntity.session) || null;
  if (
    !securityScopesExactlyMatch(companionScope, controllerScope) ||
    !playerCompanionTargetScopeIsCompatible(
      companionScope,
      targetScope,
      controllerEntity,
      targetEntity,
      session,
      scene,
      effectiveSession,
    )
  ) {
    return false;
  }

  const visibilityGate = scene.canSessionSeeDungeonScopedEntity;
  if (typeof visibilityGate !== "function") {
    return ![
      companionScope,
      controllerScope,
      targetScope,
    ].some(hasPlayerCompanionSecurityScope);
  }

  if (!effectiveSession) {
    return (
      !isPlayerShipController &&
      !controllerScope.invalid
    );
  }
  try {
    return (
      visibilityGate.call(scene, effectiveSession, companionEntity) === true &&
      visibilityGate.call(scene, effectiveSession, targetEntity) === true
    );
  } catch (_error) {
    // ignored: a visibility check that throws does not let the drone act on the target (fail closed)
    return false;
  }
}

function getCharacterStateService() {
  return lazyRequire("../character/characterState");
}

// Lazy for the same reason as every other resolver on this path: fleetHelpers
// pulls in fleetRuntime, which is nowhere near the drone tick's dependency
// order, and assist is the only caller.
function charactersShareFleet(leftCharacterID, rightCharacterID) {
  const fleetHelpers = lazyRequire("../fleets/fleetHelpers");
  return Boolean(
    fleetHelpers &&
      typeof fleetHelpers.isInSameFleet === "function" &&
      fleetHelpers.isInSameFleet(leftCharacterID, rightCharacterID),
  );
}

function resolveCharacterRecord(characterID) {
  const characterState = getCharacterStateService();
  return characterState && typeof characterState.getCharacterRecord === "function"
    ? characterState.getCharacterRecord(characterID)
    : null;
}

function resolveActiveShipRecord(characterID) {
  const characterState = getCharacterStateService();
  return characterState && typeof characterState.getActiveShipRecord === "function"
    ? characterState.getActiveShipRecord(characterID)
    : null;
}

function buildDogmaPrimeEntry(item, options = {}) {
  const characterState = getCharacterStateService();
  return characterState &&
    typeof characterState.buildInventoryDogmaPrimeEntry === "function"
    ? characterState.buildInventoryDogmaPrimeEntry(item, options)
    : characterState &&
      typeof characterState.buildChargeDogmaPrimeEntry === "function"
      ? characterState.buildChargeDogmaPrimeEntry(item, options)
    : null;
}

function syncInventoryItemForCharacterSession(session, item, previousData, options = {}) {
  const characterState = getCharacterStateService();
  if (!characterState || typeof characterState.syncInventoryItemForSession !== "function") {
    return false;
  }
  return characterState.syncInventoryItemForSession(
    session,
    item,
    previousData,
    options,
  );
}

function buildCreatedInventoryInsertPreviousState(item) {
  return {
    locationID: 0,
    flagID: toInt(item && item.flagID, 0),
    quantity: 0,
    stacksize: 0,
    singleton: 0,
  };
}

function buildDroneLaunchPreviousState(entity, item, shipRecord) {
  const shipID = toInt(shipRecord && shipRecord.itemID, 0);
  const systemID = toInt(entity && entity.systemID, 0);
  if (
    shipID <= 0 ||
    systemID <= 0 ||
    !item ||
    !isDroneItemRecord(item) ||
    toInt(item.locationID, 0) !== systemID ||
    toInt(item.flagID, 0) !== 0
  ) {
    return null;
  }

  // CCP client godma treats launched drones specially only when the item
  // change says they moved from the controlling ship's drone bay into the
  // solar system. Without this old location/flag pair, split-created drones
  // look like generic brand-new space items and one can fall out of the
  // active-drone UI even though the ball exists.
  return {
    locationID: shipID,
    flagID: ITEM_FLAGS.DRONE_BAY,
  };
}

function buildDroneBayClientItem(item, shipRecord) {
  const shipID = toInt(shipRecord && shipRecord.itemID, 0);
  if (!item || shipID <= 0) {
    return null;
  }

  return {
    ...item,
    locationID: shipID,
    flagID: ITEM_FLAGS.DRONE_BAY,
    quantity: null,
    stacksize: 1,
    singleton: 1,
    launcherID: shipID,
  };
}

function primeDroneBayDogmaForLaunch(item, shipRecord, sessions = null) {
  const targetSessions = normalizeDroneSessions(sessions);
  if (targetSessions.length <= 0) {
    return false;
  }

  const bayItem = buildDroneBayClientItem(item, shipRecord);
  const shipID = toInt(shipRecord && shipRecord.itemID, 0);
  if (!bayItem || shipID <= 0) {
    return false;
  }

  // Prime with the operational (skill/ship/module-bonused) map, not bare
  // type dogma: this prime is what fills the client godma cache for the
  // drone row the moment it leaves the bay.
  const attributeOverrides = resolveDroneTooltipAttributes(
    bayItem,
    targetSessions[0] || null,
    { controllerShipID: shipID },
  );
  const primeEntry = buildDogmaPrimeEntry(bayItem, {
    description: "drone",
    includeTypeAttributes: true,
    attributeOverrides: attributeOverrides || {},
  });
  if (!primeEntry) {
    return false;
  }

  // Seed the cache-rebuild push baseline with the values the client just
  // received. This runs before the in-space drone entity exists, which is why
  // the baseline map is keyed by ship and drone item rather than hung on the
  // entity.
  setDroneTooltipLastSentStamp(
    shipID,
    toInt(bayItem.itemID, 0),
    buildDroneTooltipAttributeStamp(attributeOverrides),
  );

  for (const session of targetSessions) {
    if (!session || typeof session.sendNotification !== "function") {
      continue;
    }
    session.sendNotification("OnGodmaPrimeItem", "clientID", [shipID, primeEntry]);
  }
  return true;
}

function syncInventoryItemToSessions(
  sessions,
  item,
  previousData,
  options = {},
) {
  for (const session of normalizeDroneSessions(sessions)) {
    if (!session) {
      continue;
    }
    syncInventoryItemForCharacterSession(
      session,
      item,
      previousData,
      options,
    );
  }
}

function clamp(value, min, max) {
  return Math.min(Math.max(toNumber(value, min), min), max);
}

function normalizeDroneSessions(sessions) {
  const normalizedSessions = [];
  const seenSessions = new Set();
  for (const session of Array.isArray(sessions) ? sessions : []) {
    if (!session || seenSessions.has(session)) {
      continue;
    }
    seenSessions.add(session);
    normalizedSessions.push(session);
  }
  return normalizedSessions;
}

function getDroneIdentityPrimeSessionKey(session) {
  return toInt(
    session &&
      (session.clientID ||
        session.characterID ||
        session.charid),
    0,
  );
}

function getDroneIdentityPrimeCache(entity) {
  if (!entity || typeof entity !== "object") {
    return null;
  }

  if (!(entity.clientIdentityPrimedSessionKeys instanceof Set)) {
    entity.clientIdentityPrimedSessionKeys = new Set();
  }
  return entity.clientIdentityPrimedSessionKeys;
}

function cloneVector(source = null, fallback = { x: 0, y: 0, z: 0 }) {
  return {
    x: toNumber(source && source.x, fallback.x),
    y: toNumber(source && source.y, fallback.y),
    z: toNumber(source && source.z, fallback.z),
  };
}

function addVectors(left, right) {
  return {
    x: toNumber(left && left.x, 0) + toNumber(right && right.x, 0),
    y: toNumber(left && left.y, 0) + toNumber(right && right.y, 0),
    z: toNumber(left && left.z, 0) + toNumber(right && right.z, 0),
  };
}

function subtractVectors(left, right) {
  return {
    x: toNumber(left && left.x, 0) - toNumber(right && right.x, 0),
    y: toNumber(left && left.y, 0) - toNumber(right && right.y, 0),
    z: toNumber(left && left.z, 0) - toNumber(right && right.z, 0),
  };
}

function scaleVector(vector, scalar) {
  return {
    x: toNumber(vector && vector.x, 0) * toNumber(scalar, 0),
    y: toNumber(vector && vector.y, 0) * toNumber(scalar, 0),
    z: toNumber(vector && vector.z, 0) * toNumber(scalar, 0),
  };
}

function magnitude(vector) {
  const resolved = cloneVector(vector);
  return Math.sqrt(
    (resolved.x * resolved.x) +
    (resolved.y * resolved.y) +
    (resolved.z * resolved.z),
  );
}

function normalizeVector(vector, fallback = { x: 1, y: 0, z: 0 }) {
  const resolved = cloneVector(vector, fallback);
  const length = magnitude(resolved);
  if (length <= 0) {
    return cloneVector(fallback);
  }
  return scaleVector(resolved, 1 / length);
}

function distance(left, right) {
  return magnitude(subtractVectors(left, right));
}

function buildPerpendicular(vector) {
  const normalized = normalizeVector(vector, { x: 1, y: 0, z: 0 });
  if (Math.abs(normalized.x) < 0.5 && Math.abs(normalized.y) < 0.5) {
    return normalizeVector({ x: 0, y: 1, z: 0 });
  }
  return normalizeVector({ x: -normalized.y, y: normalized.x, z: 0 });
}

function serializeDroneSpaceState(entity) {
  return {
    systemID: toInt(entity && entity.systemID, 0),
    position: cloneVector(entity && entity.position),
    velocity: cloneVector(entity && entity.velocity),
    direction: cloneVector(entity && entity.direction, { x: 1, y: 0, z: 0 }),
    targetPoint: cloneVector(entity && entity.targetPoint, entity && entity.position),
    speedFraction: clamp(entity && entity.speedFraction, 0, 1),
    mode: String(entity && entity.mode || "STOP"),
    targetEntityID: toInt(entity && entity.targetEntityID, 0) || null,
    followRange: Math.max(0, toNumber(entity && entity.followRange, 0)),
    orbitDistance: Math.max(0, toNumber(entity && entity.orbitDistance, 0)),
    orbitNormal: cloneVector(entity && entity.orbitNormal, buildPerpendicular(entity && entity.direction)),
    orbitSign: toNumber(entity && entity.orbitSign, 1) < 0 ? -1 : 1,
    effectStamp: 0,
    warpDestination: null,
    ...serializePlayerCompanionScopeMetadata(entity),
  };
}

function buildDroneErrorTuple(message) {
  return [
    "CustomNotify",
    buildMarshalDict([["notify", String(message || "")]]),
  ];
}

function buildMarshalDict(entries = []) {
  return {
    type: "dict",
    entries: Array.isArray(entries) ? entries : [],
  };
}

function buildMarshalList(items = []) {
  return {
    type: "list",
    items: Array.isArray(items) ? items : [],
  };
}

function buildNotifyErrorResult(message) {
  return buildMarshalDict([
    [
      "CustomNotify",
      buildMarshalDict([["notify", String(message || "")]]),
    ],
  ]);
}

function buildMultiDroneResult(droneIDs = []) {
  return buildMarshalDict();
}

function ensureLaunchResponseEntry(result, itemID) {
  const numericItemID = toInt(itemID, 0);
  if (
    !result ||
    result.type !== "dict" ||
    !Array.isArray(result.entries) ||
    numericItemID <= 0
  ) {
    return null;
  }

  let existingEntry = result.entries.find(
    (entry) => Array.isArray(entry) && toInt(entry[0], 0) === numericItemID,
  );
  if (!existingEntry) {
    existingEntry = [numericItemID, buildMarshalList()];
    result.entries.push(existingEntry);
  }

  if (
    !existingEntry[1] ||
    existingEntry[1].type !== "list" ||
    !Array.isArray(existingEntry[1].items)
  ) {
    existingEntry[1] = buildMarshalList();
  }

  return existingEntry[1];
}

function appendLaunchEntry(result, itemID, value) {
  const launchEntries = ensureLaunchResponseEntry(result, itemID);
  if (!launchEntries) {
    return result;
  }
  launchEntries.items.push(value);
  return result;
}

function appendLaunchError(result, itemID, message) {
  return appendLaunchEntry(result, itemID, buildDroneErrorTuple(message));
}

function appendLaunchUserError(result, itemID, messageKey, entries = []) {
  return appendLaunchEntry(
    result,
    itemID,
    buildDroneUserErrorTuple(messageKey, entries),
  );
}

function appendDroneErrorTuple(result, droneID, errorTuple) {
  const numericDroneID = toInt(droneID, 0);
  if (
    !result ||
    result.type !== "dict" ||
    !Array.isArray(result.entries) ||
    numericDroneID <= 0
  ) {
    return result;
  }

  const existingEntry = result.entries.find(
    (entry) => Array.isArray(entry) && toInt(entry[0], 0) === numericDroneID,
  );
  if (existingEntry) {
    existingEntry[1] = errorTuple;
    return result;
  }

  result.entries.push([numericDroneID, errorTuple]);
  return result;
}

function appendDroneError(result, droneID, message) {
  return appendDroneErrorTuple(result, droneID, buildDroneErrorTuple(message));
}

// The client re-raises a per-drone or per-launch entry as UserError(key,
// args), so a refusal that TQ names can travel as its own message key instead
// of a CustomNotify.
function buildDroneUserErrorTuple(messageKey, entries = []) {
  return [String(messageKey || ""), buildMarshalDict(entries)];
}

function appendDroneUserError(result, droneID, messageKey, entries = []) {
  return appendDroneErrorTuple(
    result,
    droneID,
    buildDroneUserErrorTuple(messageKey, entries),
  );
}

function listifyRawValue(rawValue) {
  if (Array.isArray(rawValue)) {
    return rawValue;
  }
  if (rawValue && rawValue.type === "list" && Array.isArray(rawValue.items)) {
    return rawValue.items;
  }
  return rawValue === null || rawValue === undefined ? [] : [rawValue];
}

function isIterableCollection(rawValue) {
  return Boolean(
    rawValue &&
      typeof rawValue !== "string" &&
      typeof rawValue[Symbol.iterator] === "function",
  );
}

function flattenDroneCommandValues(rawValue, result = [], depth = 0) {
  if (rawValue === null || rawValue === undefined || depth > 8) {
    return result;
  }

  if (Array.isArray(rawValue)) {
    for (const entry of rawValue) {
      flattenDroneCommandValues(entry, result, depth + 1);
    }
    return result;
  }

  if (rawValue && rawValue.type === "list" && Array.isArray(rawValue.items)) {
    for (const entry of rawValue.items) {
      flattenDroneCommandValues(entry, result, depth + 1);
    }
    return result;
  }

  if (rawValue instanceof Map) {
    for (const key of rawValue.keys()) {
      flattenDroneCommandValues(key, result, depth + 1);
    }
    return result;
  }

  if (rawValue instanceof Set) {
    for (const entry of rawValue) {
      flattenDroneCommandValues(entry, result, depth + 1);
    }
    return result;
  }

  if (rawValue && rawValue.type === "dict" && Array.isArray(rawValue.entries)) {
    for (const entry of rawValue.entries) {
      if (Array.isArray(entry) && entry.length > 0) {
        flattenDroneCommandValues(entry[0], result, depth + 1);
      }
    }
    return result;
  }

  if (rawValue && typeof rawValue.keys === "function") {
    try {
      const keysView = rawValue.keys();
      if (isIterableCollection(keysView)) {
        for (const key of keysView) {
          flattenDroneCommandValues(key, result, depth + 1);
        }
        return result;
      }
    } catch (error) {
      void error;
    }
  }

  if (isIterableCollection(rawValue)) {
    for (const entry of rawValue) {
      flattenDroneCommandValues(entry, result, depth + 1);
    }
    return result;
  }

  if (rawValue && typeof rawValue === "object") {
    const objectKeys = Object.keys(rawValue);
    if (objectKeys.length > 0) {
      const numericKeys = objectKeys
        .map((key) => ({
          key,
          numeric: Number(key),
        }))
        .filter((entry) => Number.isInteger(entry.numeric) && entry.numeric >= 0);
      if (numericKeys.length === objectKeys.length) {
        const sortedNumericKeys = numericKeys
          .map((entry) => entry.numeric)
          .sort((left, right) => left - right);
        const looksArrayLike = sortedNumericKeys.every((value, index) => value === index);
        if (looksArrayLike) {
          for (const entry of objectKeys) {
            flattenDroneCommandValues(rawValue[entry], result, depth + 1);
          }
          return result;
        }
        for (const entry of objectKeys) {
          flattenDroneCommandValues(entry, result, depth + 1);
        }
        return result;
      }
    }
  }

  result.push(rawValue);
  return result;
}

function normalizeDroneIDList(rawValue) {
  return [...new Set(
    flattenDroneCommandValues(rawValue)
      .map((value) => toInt(value, 0))
      .filter((value) => value > 0),
  )];
}

function normalizeLaunchRequests(rawValue) {
  const normalized = [];
  for (const entry of listifyRawValue(rawValue)) {
    const tuple = listifyRawValue(entry);
    const itemID = toInt(tuple[0], 0);
    const quantity = Math.max(1, toInt(tuple[1], 1));
    if (itemID > 0) {
      normalized.push({ itemID, quantity });
    }
  }
  return normalized;
}

function isDroneEntity(entity) {
  return Boolean(entity && entity.kind === "drone");
}

function resolveDroneControllerOwnerCharacterID(controllerEntity = null, droneEntity = null) {
  return toInt(
    controllerEntity &&
      (
        controllerEntity.session &&
        controllerEntity.session.characterID
      ) ||
      controllerEntity &&
      (
        controllerEntity.pilotCharacterID ??
        controllerEntity.characterID ??
        controllerEntity.ownerID
      ) ||
      droneEntity &&
      (
        droneEntity.controllerOwnerID ??
        droneEntity.ownerID
      ),
    0,
  );
}

function getRuntime() {
  return lazyRequire("../../space/runtime");
}

function getInterestedDroneSessions(entity) {
  const sessions = new Set();
  const controllerOwnerID = toInt(entity && entity.controllerOwnerID, 0);
  const ownerID = toInt(entity && entity.ownerID, 0);
  const controllerEntity =
    entity && entity.systemID
      ? getRuntime().getEntity(entity.systemID, entity.controllerID)
      : null;

  if (controllerEntity && controllerEntity.session) {
    sessions.add(controllerEntity.session);
  }
  if (controllerOwnerID > 0) {
    const controllerOwnerSession = findSessionByCharacterID(controllerOwnerID);
    if (controllerOwnerSession) {
      sessions.add(controllerOwnerSession);
    }
  }
  if (ownerID > 0) {
    const ownerSession = findSessionByCharacterID(ownerID);
    if (ownerSession) {
      sessions.add(ownerSession);
    }
  }
  return [...sessions];
}

function ensureDroneClientIdentityState(
  entity,
  shipRecord = null,
  sessions = null,
  options = {},
) {
  if (!entity) {
    return false;
  }

  const targetSessions = normalizeDroneSessions(
    Array.isArray(sessions)
      ? sessions
      : getInterestedDroneSessions(entity),
  );
  if (targetSessions.length <= 0) {
    return false;
  }

  const primeCache = getDroneIdentityPrimeCache(entity);
  const forceInsert = options.forceInsert === true;
  const forceRefresh = options.forceRefresh === true;
  const skipInventorySync = options.skipInventorySync === true;
  const skipDogmaPrime = options.skipDogmaPrime === true;
  const sessionsNeedingIdentity = forceInsert || forceRefresh
    ? targetSessions
    : targetSessions.filter((session) => {
        const sessionKey = getDroneIdentityPrimeSessionKey(session);
        return sessionKey <= 0 || !primeCache || !primeCache.has(sessionKey);
      });
  if (sessionsNeedingIdentity.length <= 0) {
    return false;
  }

  const currentItem = findItemById(toInt(entity.itemID, 0));
  if (currentItem && !skipInventorySync) {
    const launchPreviousState = buildDroneLaunchPreviousState(
      entity,
      currentItem,
      shipRecord,
    );
    const previousInventoryState = launchPreviousState ||
      (forceInsert !== true
        ? {
            locationID: currentItem.locationID,
            flagID: currentItem.flagID,
            quantity: currentItem.quantity,
            stacksize: currentItem.stacksize,
            singleton: currentItem.singleton,
          }
        : buildCreatedInventoryInsertPreviousState(currentItem));
    syncInventoryItemToSessions(
      sessionsNeedingIdentity,
      currentItem,
      previousInventoryState,
      {
        emitCfgLocation: false,
      },
    );
  }

  if (shipRecord && !skipDogmaPrime) {
    emitDroneDogmaPrime(entity, shipRecord, sessionsNeedingIdentity, currentItem);
  }

  if (primeCache) {
    for (const session of sessionsNeedingIdentity) {
      const sessionKey = getDroneIdentityPrimeSessionKey(session);
      if (sessionKey > 0) {
        primeCache.add(sessionKey);
      }
    }
  }

  return Boolean(currentItem || shipRecord);
}

function clearDroneWindowSettleForSession(session) {
  const state = session && session._droneWindowSettleState;
  if (!state) {
    return false;
  }
  if (state.timer) {
    clearTimeout(state.timer);
  }
  session._droneWindowSettleState = null;
  return true;
}

function refreshDroneWindowInventoryRows(session, state) {
  if (
    !session ||
    !state ||
    typeof session.sendNotification !== "function" ||
    (session.socket && session.socket.destroyed)
  ) {
    return;
  }

  const shipRecord = findItemById(state.shipID) || state.shipRecord || null;
  for (const droneID of state.droneIDs) {
    const item = findItemById(droneID);
    if (!item || !isDroneItemRecord(item)) {
      continue;
    }

    const entity = state.scene && typeof state.scene.getEntityByID === "function"
      ? state.scene.getEntityByID(droneID)
      : null;
    if (isDroneEntity(entity)) {
      ensureDroneClientIdentityState(entity, shipRecord, [session], {
        forceRefresh: true,
        skipDogmaPrime: true,
      });
      continue;
    }

    if (
      toInt(item.locationID, 0) !== toInt(state.shipID, 0) ||
      (
        toInt(item.flagID, 0) !== ITEM_FLAGS.DRONE_BAY &&
        toInt(item.flagID, 0) !== ITEM_FLAGS.CARGO_HOLD
      )
    ) {
      continue;
    }
    syncInventoryItemForCharacterSession(session, item, {
      locationID: item.locationID,
      flagID: item.flagID,
      quantity: item.quantity,
      stacksize: item.stacksize,
      singleton: item.singleton,
    }, {
      emitCfgLocation: false,
    });
  }
}

function scheduleDroneWindowInventorySettle(
  scene,
  shipRecord,
  sessions,
  droneIDs,
) {
  const normalizedDroneIDs = [...new Set(
    (Array.isArray(droneIDs) ? droneIDs : [droneIDs])
      .map((droneID) => toInt(droneID, 0))
      .filter((droneID) => droneID > 0),
  )];
  if (normalizedDroneIDs.length <= 0) {
    return 0;
  }

  let scheduledCount = 0;
  for (const session of normalizeDroneSessions(sessions)) {
    let state = session._droneWindowSettleState;
    if (!state) {
      state = {
        timer: null,
        scene,
        shipID: toInt(shipRecord && shipRecord.itemID, 0),
        shipRecord,
        droneIDs: new Set(),
      };
      session._droneWindowSettleState = state;
    }
    if (state.timer) {
      clearTimeout(state.timer);
    }
    state.scene = scene;
    state.shipID = toInt(shipRecord && shipRecord.itemID, state.shipID);
    state.shipRecord = shipRecord || state.shipRecord;
    for (const droneID of normalizedDroneIDs) {
      state.droneIDs.add(droneID);
    }

    state.timer = setTimeout(() => {
      if (session._droneWindowSettleState !== state) {
        return;
      }
      session._droneWindowSettleState = null;
      state.timer = null;
      refreshDroneWindowInventoryRows(session, state);
    }, DRONE_WINDOW_SETTLE_DELAY_MS);
    if (state.timer && typeof state.timer.unref === "function") {
      state.timer.unref();
    }
    scheduledCount += 1;
  }
  return scheduledCount;
}

function buildDroneStateNotificationTuple(entity, overrides = {}) {
  const hasOverride = (key) =>
    Object.prototype.hasOwnProperty.call(overrides || {}, key);
  const intField = (key, fallback) => (
    hasOverride(key) && overrides[key] === null
      ? null
      : toInt(hasOverride(key) ? overrides[key] : fallback, 0)
  );
  const targetField = (key, fallback) => {
    if (hasOverride(key)) {
      return overrides[key] === null ? null : toInt(overrides[key], 0) || null;
    }
    return toInt(fallback, 0) || null;
  };
  return [
    toInt(overrides.droneID ?? (entity && entity.itemID), 0),
    intField("ownerID", entity && entity.ownerID),
    intField("controllerID", entity && entity.controllerID),
    intField("activityState", entity && entity.activityState),
    intField("typeID", entity && entity.typeID),
    intField("controllerOwnerID", entity && entity.controllerOwnerID),
    targetField("targetID", entity && entity.targetID),
  ];
}

// A drone's state and activity are Gameplay events: a
// stamped entry in the character history of each Observer the drone
// concerns (its owner and controller), ahead of the tick's Grid bubble
// entries and exits: TQ sends a launch as OnDroneStateChange rows, then the
// drones' packaged add, and a recall as the rows, then the removal (golden
// log "Drone Launch just 2 - orbiting - recalling" lines 516, 1702, 1711). Only a session with no ballpark yet has
// no stream to stamp into (michelle drops a DoDestinyUpdate before its
// SetState): it keeps the direct notification. Returns true when queued.
function queueDroneGameplayEvent(session, payload) {
  if (!session || !session._space || session._space.initialStateSent !== true) {
    return false;
  }
  const spaceRuntime = getRuntime();
  const scene = spaceRuntime && typeof spaceRuntime.getSceneForSession === "function"
    ? spaceRuntime.getSceneForSession(session)
    : null;
  return Boolean(
    scene &&
    typeof scene.queueCharacterHistory === "function" &&
    scene.queueCharacterHistory(session, [payload], { beforeBubbleEntries: true }) !== null,
  );
}

function emitDroneStateChange(entity, overrides = {}, sessions = null) {
  const targetSessions = normalizeDroneSessions(
    Array.isArray(sessions)
      ? sessions
      : getInterestedDroneSessions(entity),
  );
  const payload = buildDroneStateNotificationTuple(entity, overrides);
  for (const session of targetSessions) {
    if (!session || typeof session.sendNotification !== "function") {
      continue;
    }
    if (!queueDroneGameplayEvent(session, ["OnDroneStateChange", payload])) {
      session.sendNotification("OnDroneStateChange", "charid", payload);
    }
  }
}

function emitDroneStateChangeBatch(scene, entries) {
  const normalizedEntries = (Array.isArray(entries) ? entries : [])
    .filter((entry) => entry && entry.entity)
    .map((entry) => ({
      entity: entry.entity,
      overrides: entry.overrides || {},
      sessions: normalizeDroneSessions(
        Array.isArray(entry.sessions)
          ? entry.sessions
          : getInterestedDroneSessions(entry.entity),
      ),
    }));
  const targetSessions = normalizeDroneSessions(
    normalizedEntries.flatMap((entry) => entry.sessions),
  );
  const destinyReady = canPresentDroneStateOnDestiny(scene);

  for (const session of targetSessions) {
    const sessionEntries = normalizedEntries.filter(
      (entry) => entry.sessions.includes(session),
    );
    if (sessionEntries.length <= 0) {
      continue;
    }
    if (
      destinyReady &&
      session &&
      session._space &&
      session._space.initialStateSent === true
    ) {
      const presentation = buildDroneStateChangePresentation({
        scene,
        stateTuples: sessionEntries.map((entry) => (
          buildDroneStateNotificationTuple(entry.entity, entry.overrides)
        )),
      });
      const emittedStamp = scene.queueCharacterHistory(
        session,
        presentation.updates,
        { beforeBubbleEntries: true },
      );
      if (emittedStamp !== null && emittedStamp !== undefined) {
        continue;
      }
    }
    for (const entry of sessionEntries) {
      emitDroneStateChange(entry.entity, entry.overrides, [session]);
    }
  }
}

function emitDroneActivityChange(entity, activityID = null, activity = null, sessions = null) {
  const targetSessions = normalizeDroneSessions(
    Array.isArray(sessions)
      ? sessions
      : getInterestedDroneSessions(entity),
  );
  // A standing pilot assignment outlives any one task, so the (null, null)
  // clear that every task reset sends must not wipe the assignment line off the
  // drone entry. Callers that really mean to end it clear the assignment first.
  const standingAssignment =
    activityID === null || activityID === undefined
      ? getDronePilotAssignment(entity)
      : null;
  const payload = [
    toInt(entity && entity.itemID, 0),
    toInt(standingAssignment ? standingAssignment.characterID : activityID, 0) || null,
    standingAssignment
      ? standingAssignment.mode
      : activity === null || activity === undefined
        ? null
        : String(activity),
  ];
  for (const session of targetSessions) {
    if (!session || typeof session.sendNotification !== "function") {
      continue;
    }
    if (!queueDroneGameplayEvent(session, ["OnDroneActivityChange", payload])) {
      session.sendNotification("OnDroneActivityChange", "charid", payload);
    }
  }
}

// The tooltip attribute stamps the client last received, per controller ship
// per drone item. Seeded by every prime emission (launch bay prime, launch
// space prime, cache-rebuild push) and read by handleControllerDogmaCacheRebuilt
// so an irrelevant stat change costs one string compare and zero primes.
// Released the moment a drone leaves its controller's custody (destroyed,
// abandoned, recalled into a hold) so the map tracks the live drone set; the
// rebuild-handler prune is only a backstop for anything a lifecycle hook
// misses.
const droneTooltipLastSentByShipID = new Map();

function getDroneTooltipLastSentStamp(shipID, droneItemID) {
  const byDroneID = droneTooltipLastSentByShipID.get(toInt(shipID, 0));
  return byDroneID
    ? byDroneID.get(toInt(droneItemID, 0))
    : undefined;
}

function setDroneTooltipLastSentStamp(shipID, droneItemID, stamp) {
  const numericShipID = toInt(shipID, 0);
  const numericDroneItemID = toInt(droneItemID, 0);
  if (numericShipID <= 0 || numericDroneItemID <= 0) {
    return;
  }
  let byDroneID = droneTooltipLastSentByShipID.get(numericShipID);
  if (!byDroneID) {
    byDroneID = new Map();
    droneTooltipLastSentByShipID.set(numericShipID, byDroneID);
  }
  byDroneID.set(numericDroneItemID, stamp);
}

// Drop baselines for drones this ship no longer controls (recalled, destroyed,
// abandoned) so the per-ship map tracks the live drone set.
function pruneDroneTooltipLastSentStamps(shipID, liveDroneItemIDs) {
  const byDroneID = droneTooltipLastSentByShipID.get(toInt(shipID, 0));
  if (!byDroneID) {
    return;
  }
  for (const droneItemID of [...byDroneID.keys()]) {
    if (!liveDroneItemIDs.has(droneItemID)) {
      byDroneID.delete(droneItemID);
    }
  }
  if (byDroneID.size === 0) {
    droneTooltipLastSentByShipID.delete(toInt(shipID, 0));
  }
}

// Release one drone's baseline the moment it leaves its controller's custody,
// so a controller that never triggers another cache rebuild (pilot recalls
// their drones and logs off) does not keep the entry forever. Callers pass the
// controller keys they can still read — the transitions clear
// controllerID/launcherID as part of the release.
function forgetDroneTooltipLastSentStamp(shipID, droneItemID) {
  const numericShipID = toInt(shipID, 0);
  const numericDroneItemID = toInt(droneItemID, 0);
  if (numericShipID <= 0 || numericDroneItemID <= 0) {
    return;
  }
  const byDroneID = droneTooltipLastSentByShipID.get(numericShipID);
  if (!byDroneID) {
    return;
  }
  byDroneID.delete(numericDroneItemID);
  if (byDroneID.size === 0) {
    droneTooltipLastSentByShipID.delete(numericShipID);
  }
}

function emitDroneDogmaPrime(entity, shipRecord, sessions = null, itemOverride = null) {
  if (!entity || !shipRecord) {
    return;
  }

  const targetSessions = normalizeDroneSessions(
    Array.isArray(sessions)
      ? sessions
      : getInterestedDroneSessions(entity),
  );
  if (targetSessions.length === 0) {
    return;
  }

  const currentItem =
    itemOverride && typeof itemOverride === "object"
      ? itemOverride
      : findItemById(toInt(entity.itemID, 0)) || null;
  // Prime launched/returning drones as their real live in-space items. If we
  // advertise them as flag=DRONE_BAY under the controlling ship here, the
  // client synthesizes phantom bay rows and the drone UI/damage tracker churn.
  const dogmaPrimeItem = {
    itemID: toInt(entity.itemID, 0),
    typeID: toInt(
      currentItem && currentItem.typeID,
      toInt(entity.typeID, 0),
    ),
    ownerID: toInt(
      currentItem && currentItem.ownerID,
      toInt(entity.ownerID, 0),
    ),
    locationID: toInt(
      currentItem && currentItem.locationID,
      toInt(entity.systemID, 0),
    ),
    flagID: toInt(currentItem && currentItem.flagID, 0),
    quantity:
      currentItem && currentItem.quantity !== undefined
        ? currentItem.quantity
        : null,
    stacksize: Math.max(
      1,
      toInt(
        currentItem && (currentItem.stacksize ?? currentItem.quantity),
        1,
      ),
    ),
    singleton: toInt(currentItem && currentItem.singleton, 1),
    groupID: toInt(
      currentItem && currentItem.groupID,
      toInt(entity.groupID, 0),
    ),
    categoryID: toInt(
      currentItem && currentItem.categoryID,
      DRONE_CATEGORY_ID,
    ),
    customInfo:
      currentItem && currentItem.customInfo !== undefined && currentItem.customInfo !== null
        ? String(currentItem.customInfo)
        : "",
    moduleState: null,
    conditionState: null,
    launcherID: toInt(shipRecord.itemID, 0),
    volume: toNumber(
      currentItem && currentItem.volume,
      toNumber(entity.volume, null),
    ),
  };
  // Advertise the operational (skill/ship/module-bonused) attribute map, or
  // a launched drone's tooltip falls back to base type dogma until the
  // client re-queries the item.
  const attributeOverrides = resolveDroneTooltipAttributes(
    dogmaPrimeItem,
    targetSessions[0] || null,
    { controllerShipID: toInt(shipRecord.itemID, 0) },
  );
  const primeEntry = buildDogmaPrimeEntry(dogmaPrimeItem, {
    description: "drone",
    includeTypeAttributes: true,
    attributeOverrides: attributeOverrides || {},
  });
  if (!primeEntry) {
    return;
  }

  // Record exactly what the client just received. The cache-rebuild push
  // (handleControllerDogmaCacheRebuilt) compares freshly resolved values
  // against this stamp and stays silent when they match. Keyed by ship, not
  // hung on the drone entity: the launch-time bay prime runs before the
  // in-space entity exists, and the scene may replace entity instances.
  setDroneTooltipLastSentStamp(
    toInt(shipRecord.itemID, 0),
    toInt(entity.itemID, 0),
    buildDroneTooltipAttributeStamp(attributeOverrides),
  );

  const primeLocationID = toInt(
    dogmaPrimeItem.locationID,
    toInt(entity.systemID, 0),
  );
  for (const session of targetSessions) {
    if (!session || typeof session.sendNotification !== "function") {
      continue;
    }
    session.sendNotification("OnGodmaPrimeItem", "clientID", [primeLocationID, primeEntry]);
  }
}

// Re-advertise a controller's IN-SPACE drone dogma when their stat inputs
// actually changed. Notified by droneDogma when the per-ship drone stat cache
// is rebuilt (fingerprint change: refit, module on/off such as an Industrial
// Core deploying, implants, boosters, system change), which happens at most
// once per change — never per tick. The fingerprint also flips for changes
// that cannot move drone values (another character's refit bumping the
// server-wide counters, a module with no drone modifiers cycling), so each
// drone's freshly resolved map is compared against the last-advertised stamp
// (droneTooltipLastSentByShipID, seeded by every prime emission) and only
// genuinely changed drones are pushed. Drone-bay rows are deliberately NOT
// refreshed: godma's UpdateItem discards attributes for bay items (the
// client computes bay tooltips itself), so those primes were pure cost.
let controllerDogmaCacheRebuildDepth = 0;
function handleControllerDogmaCacheRebuilt(controllerEntity) {
  if (!controllerEntity || controllerDogmaCacheRebuildDepth > 0) {
    return;
  }
  const shipID = toInt(controllerEntity.itemID, 0);
  if (shipID <= 0) {
    return;
  }
  const session = controllerEntity.session || null;
  const spaceRuntime = getRuntime();
  const scene = session && spaceRuntime &&
      typeof spaceRuntime.getSceneForSession === "function"
    ? spaceRuntime.getSceneForSession(session)
    : null;
  if (!scene || typeof scene.getEntityByID !== "function") {
    return;
  }
  const shipRecord = findItemById(shipID);
  if (!shipRecord) {
    return;
  }
  controllerDogmaCacheRebuildDepth += 1;
  try {
    const liveDroneItemIDs = new Set();
    for (const droneEntity of listControlledDroneEntities(scene, shipID)) {
      liveDroneItemIDs.add(toInt(droneEntity.itemID, 0));
      const interestedSessions = getInterestedDroneSessions(droneEntity);
      if (interestedSessions.length <= 0) {
        continue;
      }
      const droneItem = findItemById(toInt(droneEntity.itemID, 0));
      if (!droneItem) {
        continue;
      }
      const attributes = resolveDroneTooltipAttributes(
        droneItem,
        interestedSessions[0] || session,
        {
          controllerShipID: shipID,
          controllerEntity,
          scene,
        },
      );
      if (
        !attributes ||
        buildDroneTooltipAttributeStamp(attributes) ===
          getDroneTooltipLastSentStamp(shipID, droneEntity.itemID)
      ) {
        continue;
      }
      emitDroneDogmaPrime(droneEntity, shipRecord, interestedSessions);
    }
    pruneDroneTooltipLastSentStamps(shipID, liveDroneItemIDs);
  } finally {
    controllerDogmaCacheRebuildDepth -= 1;
  }
}
setControllerDogmaCacheRebuiltHandler(handleControllerDogmaCacheRebuilt);

function handleDroneDestroyed(scene, droneEntity) {
  if (!scene || !isDroneEntity(droneEntity)) {
    return false;
  }

  forgetDroneTooltipLastSentStamp(droneEntity.controllerID, droneEntity.itemID);
  forgetDroneTooltipLastSentStamp(droneEntity.launcherID, droneEntity.itemID);
  clearDroneAssistAssignment(scene, droneEntity);
  const interestedSessions = getInterestedDroneSessions(droneEntity);
  if (interestedSessions.length <= 0) {
    return false;
  }

  emitDroneStateChange(droneEntity, {
    ownerID: 0,
    controllerID: 0,
    activityState: STATE_IDLE,
    controllerOwnerID: 0,
    targetID: 0,
  }, interestedSessions);
  emitDroneActivityChange(droneEntity, null, null, interestedSessions);
  markSceneControlledCombatDroneIndexDirty(scene);
  return true;
}

function markSceneControlledCombatDroneIndexDirty(scene) {
  if (!scene) {
    return;
  }
  scene.droneControlledCombatIndexDirty = true;
}

function pruneSceneDroneAggressionThreats(scene, now) {
  if (!scene || !(scene.droneAggressionThreatsByController instanceof Map)) {
    return;
  }
  const threshold = toNumber(now, Date.now()) - DRONE_AGGRESSION_THREAT_RETENTION_MS;
  for (const [controllerID, threatMap] of scene.droneAggressionThreatsByController.entries()) {
    if (!(threatMap instanceof Map)) {
      scene.droneAggressionThreatsByController.delete(controllerID);
      continue;
    }
    for (const [targetID, lastAggressedAtMs] of threatMap.entries()) {
      if (toNumber(lastAggressedAtMs, 0) < threshold) {
        threatMap.delete(targetID);
      }
    }
    if (threatMap.size <= 0) {
      scene.droneAggressionThreatsByController.delete(controllerID);
    }
  }
}

function getSceneDroneAggressionThreats(scene) {
  if (!scene) {
    return new Map();
  }
  if (!(scene.droneAggressionThreatsByController instanceof Map)) {
    scene.droneAggressionThreatsByController = new Map();
  }
  return scene.droneAggressionThreatsByController;
}

function isDroneCombatCapable(droneEntity, controllerEntity = null) {
  if (!isDroneEntity(droneEntity)) {
    return false;
  }
  if (typeof droneEntity.droneCombatCapable === "boolean") {
    return droneEntity.droneCombatCapable;
  }
  droneEntity.droneCombatCapable = Boolean(
    resolveDroneCombatSnapshot(droneEntity, controllerEntity) || null,
  );
  return droneEntity.droneCombatCapable;
}

function normalizeDroneBehaviorSettings(rawSettings = null) {
  const source =
    rawSettings && typeof rawSettings === "object"
      ? rawSettings
      : {};
  return {
    aggressive: Object.prototype.hasOwnProperty.call(
      source,
      ATTRIBUTE_DRONE_IS_AGGRESSIVE,
    )
      ? Boolean(source[ATTRIBUTE_DRONE_IS_AGGRESSIVE])
      : DEFAULT_DRONE_IS_AGGRESSIVE,
    focusFire: Object.prototype.hasOwnProperty.call(
      source,
      ATTRIBUTE_DRONE_FOCUS_FIRE,
    )
      ? Boolean(source[ATTRIBUTE_DRONE_FOCUS_FIRE])
      : DEFAULT_DRONE_FOCUS_FIRE,
  };
}

function getControllerDroneBehaviorSettings(controllerEntity = null) {
  const characterID = resolveDroneControllerOwnerCharacterID(controllerEntity);
  const controllerSession =
    controllerEntity &&
    controllerEntity.session &&
    typeof controllerEntity.session === "object"
      ? controllerEntity.session
      : characterID > 0
        ? findSessionByCharacterID(characterID)
        : null;
  const cachedSettings =
    controllerSession &&
    controllerSession.droneSettings &&
    typeof controllerSession.droneSettings === "object"
      ? controllerSession.droneSettings
      : null;
  if (cachedSettings) {
    return normalizeDroneBehaviorSettings(cachedSettings);
  }

  const characterRecord = characterID > 0 ? resolveCharacterRecord(characterID) || null : null;
  const persistedSettings =
    characterRecord &&
    characterRecord.droneSettings &&
    typeof characterRecord.droneSettings === "object"
      ? characterRecord.droneSettings
      : {};
  const normalizedSettings = normalizeDroneBehaviorSettings(persistedSettings);
  if (controllerSession) {
    controllerSession.droneSettings = {
      ...persistedSettings,
      [ATTRIBUTE_DRONE_IS_AGGRESSIVE]: normalizedSettings.aggressive,
      [ATTRIBUTE_DRONE_FOCUS_FIRE]: normalizedSettings.focusFire,
    };
  }
  return normalizedSettings;
}

function isCreatedInventoryChange(change) {
  if (!change || !change.item || !change.previousData) {
    return false;
  }
  const previousLocationID = toInt(change.previousData.locationID, 0);
  const previousQuantity = Number(change.previousData.quantity);
  const previousStacksize = Number(change.previousData.stacksize);
  return previousLocationID === 0 && (
    previousQuantity === 0 ||
    previousStacksize === 0
  );
}

function emitRelevantInventoryChanges(session, shipID, changes = [], options = {}) {
  const numericShipID = toInt(shipID, 0);
  if (!session || numericShipID <= 0) {
    return;
  }
  const includeCreatedItems = options.includeCreatedItems === true;
  for (const change of Array.isArray(changes) ? changes : []) {
    if (!change || !change.item) {
      continue;
    }
    const currentLocationID = toInt(change.item.locationID, 0);
    const previousLocationID = toInt(change.previousData && change.previousData.locationID, 0);
    if (
      currentLocationID !== numericShipID &&
      previousLocationID !== numericShipID &&
      !(includeCreatedItems && isCreatedInventoryChange(change))
    ) {
      continue;
    }
    syncInventoryItemForCharacterSession(session, change.item, change.previousData || {}, {
      emitCfgLocation: true,
    });
  }
}

function resolveShipStorageSnapshotForDrone(controllerEntity) {
  if (!controllerEntity) {
    return null;
  }

  const characterID = toInt(
    controllerEntity &&
      (
        controllerEntity.session &&
        controllerEntity.session.characterID
      ) ||
      controllerEntity &&
      (
        controllerEntity.pilotCharacterID ??
        controllerEntity.characterID ??
        controllerEntity.ownerID
      ),
    0,
  );
  const shipID = toInt(controllerEntity && controllerEntity.itemID, 0);
  if (characterID <= 0 || shipID <= 0) {
    return null;
  }

  const shipItem = findItemById(shipID) || null;
  if (!shipItem) {
    return null;
  }

  // The ship's resource state (cargo/hold CAPACITIES) is invariant between ore
  // deliveries — it only changes on a refit/skill/implant change, which the
  // controller dogma fingerprint already tracks. Cache it on that fingerprint so a
  // tick where every drone delivers at once rebuilds buildShipResourceState ONCE
  // (it was the dominant ore-delivery spike: ~530ms/call live before the dogma
  // clone fixes, still ~74ms after) instead of once per drone, and it then holds
  // across deliveries until an actual refit. usedByFlag (volume currently stored)
  // DOES change per delivery, so it is always recomputed fresh from the item index
  // (cheap). When no fingerprint is available (flag off / no dogma context yet) we
  // rebuild every call, exactly as before.
  const resourceFingerprint =
    (controllerEntity.droneDogmaCache &&
      controllerEntity.droneDogmaCache.fingerprint) ||
    null;
  let resourceState;
  if (
    resourceFingerprint &&
    controllerEntity.droneResourceStateCache &&
    controllerEntity.droneResourceStateCache.fingerprint === resourceFingerprint
  ) {
    resourceState = controllerEntity.droneResourceStateCache.resourceState;
  } else {
    resourceState = buildShipResourceState(characterID, shipItem, {
      skillMap: controllerEntity.skillMap,
      fittedItems: controllerEntity.fittedItems,
    });
    if (resourceFingerprint) {
      controllerEntity.droneResourceStateCache = {
        fingerprint: resourceFingerprint,
        resourceState,
      };
    }
  }

  const usedByFlag = new Map();
  for (const item of listContainerItems(characterID, shipID, null)) {
    const flagID = toInt(item && item.flagID, 0);
    const units = Math.max(
      0,
      toInt(item && (item.stacksize ?? item.quantity), 1) || 1,
    );
    const itemVolume = Math.max(
      0,
      toNumber(item && item.volume, 0),
    );
    usedByFlag.set(
      flagID,
      Number(
        (
          toNumber(usedByFlag.get(flagID), 0) +
          (itemVolume * units)
        ).toFixed(6)
      ),
    );
  }

  return {
    characterID,
    shipID,
    resourceState,
    usedByFlag,
  };
}

function getDroneStorageCapacityByFlag(resourceState, flagID) {
  if (!resourceState) {
    return 0;
  }

  const normalizedFlagID = toInt(flagID, 0);
  if (normalizedFlagID === ITEM_FLAGS.CARGO_HOLD) {
    return toNumber(resourceState.cargoCapacity, 0);
  }
  // getShipHoldCapacityByFlag only knows the mining holds, so it answers 0 for
  // the drone bay. Read droneCapacity straight off the resource state — the
  // same number invBroker bills every other drone bay deposit against.
  if (normalizedFlagID === ITEM_FLAGS.DRONE_BAY) {
    return toNumber(resourceState.droneCapacity, 0);
  }
  return getShipHoldCapacityByFlag(resourceState, normalizedFlagID);
}

function getAvailableDroneStorageVolume(storageSnapshot, flagID) {
  if (!storageSnapshot || !storageSnapshot.resourceState) {
    return 0;
  }

  const normalizedFlagID = toInt(flagID, 0);
  const capacity = getDroneStorageCapacityByFlag(
    storageSnapshot.resourceState,
    normalizedFlagID,
  );
  const used = toNumber(storageSnapshot.usedByFlag.get(normalizedFlagID), 0);
  return Math.max(0, Number((capacity - used).toFixed(6)));
}

// Launching a drone hands its item row to itemCustody.custodyRef.inSpace, which
// stamps flagID 0 and the solar system as the location, so the drone bay reads
// as empty space the pilot never actually got back. The bay still owes every
// drone it has out a berth, so that volume is billed as reserved: it is what
// stops a pilot from refilling the freed volume and then discovering their own
// drones have nowhere to land.
function getLaunchedDroneReservedBayVolume(
  shipID,
  systemID,
  ownerID,
  excludedItemIDs = null,
) {
  const normalizedShipID = toInt(shipID, 0);
  const normalizedSystemID = toInt(systemID, 0);
  const normalizedOwnerID = toInt(ownerID, 0);
  if (normalizedShipID <= 0 || normalizedSystemID <= 0 || normalizedOwnerID <= 0) {
    return 0;
  }

  let reservedVolume = 0;
  for (const item of listContainerItems(
    normalizedOwnerID,
    normalizedSystemID,
    0,
  )) {
    if (
      !item ||
      toInt(item.launcherID, 0) !== normalizedShipID ||
      !isDroneItemRecord(item) ||
      (excludedItemIDs && excludedItemIDs.has(toInt(item.itemID, 0)))
    ) {
      continue;
    }
    reservedVolume += getDroneInventoryVolume(item);
  }

  return Math.max(0, Number(reservedVolume.toFixed(6)));
}

function getDroneInventoryVolume(item) {
  if (!item) {
    return 0;
  }
  const units = toInt(item.singleton, 0) === 1
    ? 1
    : Math.max(1, toInt(item.stacksize ?? item.quantity, 1));
  return Math.max(0, toNumber(item.volume, 0)) * units;
}

function classifyDroneMiningYieldKind(droneEntity) {
  const typeRecord = resolveItemByTypeID(toInt(droneEntity && droneEntity.typeID, 0)) || null;
  const droneName = String(
    typeRecord && typeRecord.name ||
    droneEntity && droneEntity.itemName ||
    "",
  ).trim().toLowerCase();
  if (!droneName) {
    return null;
  }
  if (droneName.includes("ice harvesting")) {
    return "ice";
  }
  if (droneName.includes("excavator") || droneName.includes("mining")) {
    return "ore";
  }
  return null;
}

function isDroneMiningCompatibleWithTarget(droneEntity, mineableState) {
  if (!droneEntity || !mineableState) {
    return false;
  }
  const family = classifyDroneMiningYieldKind(droneEntity);
  if (!family) {
    return false;
  }
  return family === String(mineableState.yieldKind || "").trim().toLowerCase();
}

function resolveDroneMiningDestination(controllerEntity, yieldTypeID, yieldKind = "") {
  const storageSnapshot = resolveShipStorageSnapshotForDrone(controllerEntity);
  if (!storageSnapshot) {
    return null;
  }

  const preferredFlag = getPreferredMiningHoldFlagForType(
    storageSnapshot.resourceState,
    yieldTypeID,
  );
  const normalizedYieldKind = String(yieldKind || "").trim().toLowerCase();
  const orderedFlags = [
    preferredFlag,
    normalizedYieldKind === "ore" ? MINING_HOLD_FLAGS.SPECIALIZED_ASTEROID_HOLD : null,
    normalizedYieldKind === "gas" ? MINING_HOLD_FLAGS.SPECIALIZED_GAS_HOLD : null,
    normalizedYieldKind === "ice" ? MINING_HOLD_FLAGS.SPECIALIZED_ICE_HOLD : null,
    MINING_HOLD_FLAGS.GENERAL_MINING_HOLD,
    ITEM_FLAGS.CARGO_HOLD,
  ].filter((value, index, array) => value && array.indexOf(value) === index);
  for (const flagID of orderedFlags) {
    const availableVolume = getAvailableDroneStorageVolume(
      storageSnapshot,
      flagID,
    );
    if (availableVolume > 0) {
      return {
        storageSnapshot,
        flagID,
        availableVolume,
      };
    }
  }

  return {
    storageSnapshot,
    flagID: preferredFlag || ITEM_FLAGS.CARGO_HOLD,
    availableVolume: 0,
  };
}

function getDroneMiningCycleDurationMs(snapshot) {
  return Math.max(1, toNumber(snapshot && snapshot.durationMs, 1000));
}

function beginDroneMiningCycle(miningState, snapshot, now) {
  if (!miningState || typeof miningState !== "object") {
    return false;
  }

  const cycleStartedAtMs = Math.max(0, toNumber(now, Date.now()));
  miningState.cycleStartedAtMs = cycleStartedAtMs;
  miningState.nextCycleAtMs =
    cycleStartedAtMs + getDroneMiningCycleDurationMs(snapshot);
  miningState.fxCycleKey = null;
  return true;
}

function clearDroneMiningCycle(miningState) {
  if (!miningState || typeof miningState !== "object") {
    return false;
  }
  miningState.cycleStartedAtMs = null;
  miningState.nextCycleAtMs = null;
  miningState.fxCycleKey = null;
  return true;
}

function resolveDroneMiningFxTargetID(targetEntityOrID) {
  return toInt(
    targetEntityOrID && typeof targetEntityOrID === "object"
      ? targetEntityOrID.itemID
      : targetEntityOrID,
    0,
  );
}

function emitDroneMiningCycleFx(
  scene,
  droneEntity,
  targetEntityOrID,
  snapshot,
  miningState,
  now,
  options = {},
) {
  if (!scene || !droneEntity || !snapshot || !snapshot.effectGUID) {
    return false;
  }

  const targetID = resolveDroneMiningFxTargetID(targetEntityOrID);
  if (targetID <= 0) {
    return false;
  }

  const active = options.active !== false;
  const durationMs = getDroneMiningCycleDurationMs(snapshot);
  const cycleStartedAtMs = toNumber(
    miningState && miningState.cycleStartedAtMs,
    toNumber(now, Date.now()),
  );
  const fxCycleKey = `${targetID}:${Math.trunc(cycleStartedAtMs)}:${durationMs}`;
  if (active && miningState && miningState.fxCycleKey === fxCycleKey) {
    return false;
  }

  scene.broadcastSpecialFx(
    droneEntity.itemID,
    snapshot.effectGUID,
    {
      moduleID: droneEntity.itemID,
      moduleTypeID: droneEntity.typeID,
      targetID,
      isOffensive: false,
      start: active,
      active: true,
      duration: durationMs,
      repeat: 1,
    },
    droneEntity,
  );

  if (miningState) {
    miningState.fxCycleKey = active ? fxCycleKey : null;
  }
  return true;
}

function stopDroneMiningCycleFx(scene, droneEntity) {
  const miningState =
    droneEntity &&
    droneEntity.droneMining &&
    typeof droneEntity.droneMining === "object"
      ? droneEntity.droneMining
      : null;
  if (!miningState || !miningState.fxCycleKey) {
    return false;
  }
  return emitDroneMiningCycleFx(
    scene,
    droneEntity,
    miningState.targetID,
    miningState.snapshot,
    miningState,
    Date.now(),
    { active: false },
  );
}

function syncDroneInventoryChangesToSession(session, changes = []) {
  if (!session || typeof session.sendNotification !== "function") {
    return;
  }
  for (const change of Array.isArray(changes) ? changes : []) {
    if (!change || !change.item) {
      continue;
    }
    syncInventoryItemForCharacterSession(
      session,
      change.item,
      change.previousData || change.previousState || {},
      {
        emitCfgLocation: true,
      },
    );
  }
}

function clearDroneTaskState(droneEntity) {
  if (!droneEntity) {
    return;
  }
  droneEntity.droneCommand = null;
  droneEntity.droneCombat = null;
  droneEntity.droneMining = null;
  droneEntity.droneSalvage = null;
  droneEntity.droneRepair = null;
  droneEntity.activityID = null;
  droneEntity.activity = null;
}

// --- Drone pilot assignments -------------------------------------------------
//
// ⚠ ASSIST/GUARD ARE STANDING ORDERS, NOT TASKS, so they deliberately
// do NOT live in clearDroneTaskState above. Retail keeps a drone assisting
// across kills: it engages what the assisted pilot engages, the target dies,
// the drone falls idle still assisting, and the assisted pilot's next shot
// pulls it back in. Guard has the same lifetime across incoming aggressors.
// Clearing either with the task would make the assignment fire exactly once.
// It ends only when an order replaces it (engage / mine / salvage / return /
// abandon / reconnect) or the drone leaves space.
//
// The counters are cheap gates for the hot aggression paths. An over-count can
// only cost a scan that finds no assignment; it can never suppress a dispatch.
let activeDroneAssistAssignmentCount = 0;
let activeDroneGuardAssignmentCount = 0;

function getScenePilotAssignedDroneIDs(scene, create = false) {
  if (!scene) {
    return null;
  }
  if (!(scene.droneAssistEntityIDs instanceof Set)) {
    if (!create) {
      return null;
    }
    scene.droneAssistEntityIDs = new Set();
  }
  return scene.droneAssistEntityIDs;
}

function getDronePilotAssignment(droneEntity) {
  const assignment = droneEntity && droneEntity.droneAssist;
  if (
    !assignment ||
    typeof assignment !== "object" ||
    toInt(assignment.characterID, 0) <= 0
  ) {
    return null;
  }
  const mode = assignment.mode === DRONE_ACTIVITY_GUARD
    ? DRONE_ACTIVITY_GUARD
    : DRONE_ACTIVITY_ASSIST;
  return assignment.mode === mode
    ? assignment
    : { ...assignment, mode };
}

function getDroneAssistAssignment(droneEntity) {
  const assignment = getDronePilotAssignment(droneEntity);
  return assignment && assignment.mode === DRONE_ACTIVITY_ASSIST
    ? assignment
    : null;
}

function getDroneGuardAssignment(droneEntity) {
  const assignment = getDronePilotAssignment(droneEntity);
  return assignment && assignment.mode === DRONE_ACTIVITY_GUARD
    ? assignment
    : null;
}

function adjustActiveDronePilotAssignmentCount(mode, delta) {
  if (mode === DRONE_ACTIVITY_GUARD) {
    activeDroneGuardAssignmentCount = Math.max(
      0,
      activeDroneGuardAssignmentCount + delta,
    );
    return;
  }
  activeDroneAssistAssignmentCount = Math.max(
    0,
    activeDroneAssistAssignmentCount + delta,
  );
}

function setDronePilotAssignment(
  scene,
  droneEntity,
  assignedCharacterID,
  assignedShipID,
  mode,
) {
  const characterID = toInt(assignedCharacterID, 0);
  const shipID = toInt(assignedShipID, 0);
  if (
    !isDroneEntity(droneEntity) ||
    characterID <= 0 ||
    shipID <= 0 ||
    ![DRONE_ACTIVITY_ASSIST, DRONE_ACTIVITY_GUARD].includes(mode)
  ) {
    return false;
  }
  const previousAssignment = getDronePilotAssignment(droneEntity);
  if (previousAssignment) {
    adjustActiveDronePilotAssignmentCount(previousAssignment.mode, -1);
  }
  droneEntity.droneAssist = { mode, characterID, shipID };
  adjustActiveDronePilotAssignmentCount(mode, 1);
  const assignedDroneIDs = getScenePilotAssignedDroneIDs(scene, true);
  if (assignedDroneIDs) {
    assignedDroneIDs.add(toInt(droneEntity.itemID, 0));
  }
  return true;
}

function clearDroneAssistAssignment(scene, droneEntity) {
  if (!droneEntity) {
    return false;
  }
  const assignment = getDronePilotAssignment(droneEntity);
  droneEntity.droneAssist = null;
  const assignedDroneIDs = getScenePilotAssignedDroneIDs(scene);
  if (assignedDroneIDs) {
    assignedDroneIDs.delete(toInt(droneEntity.itemID, 0));
  }
  if (assignment) {
    adjustActiveDronePilotAssignmentCount(assignment.mode, -1);
  }
  return Boolean(assignment);
}

function countSceneDronesAssisting(scene, assistCharacterID) {
  const characterID = toInt(assistCharacterID, 0);
  const assignedDroneIDs = getScenePilotAssignedDroneIDs(scene);
  if (!assignedDroneIDs || characterID <= 0) {
    return 0;
  }

  let count = 0;
  for (const droneID of [...assignedDroneIDs]) {
    const droneEntity = scene.getEntityByID(toInt(droneID, 0));
    const pilotAssignment = getDronePilotAssignment(droneEntity);
    if (!isDroneEntity(droneEntity) || !pilotAssignment) {
      assignedDroneIDs.delete(droneID);
      continue;
    }
    const assistAssignment = getDroneAssistAssignment(droneEntity);
    if (
      assistAssignment &&
      toInt(assistAssignment.characterID, 0) === characterID
    ) {
      count += 1;
    }
  }
  return count;
}

function copyControllerIdentity(droneEntity, controllerEntity = null, controllerOwnerID = 0) {
  if (!droneEntity) {
    return;
  }

  const fallbackControllerOwnerID = toInt(
    (
      controllerEntity &&
      controllerEntity.session &&
      controllerEntity.session.characterID
    ) ||
      (
        controllerEntity &&
        (
          controllerEntity.pilotCharacterID ??
          controllerEntity.characterID ??
          droneEntity.ownerID
        )
      ),
    0,
  );
  const resolvedControllerOwnerID =
    toInt(controllerOwnerID, 0) > 0
      ? toInt(controllerOwnerID, 0)
      : fallbackControllerOwnerID;
  droneEntity.controllerOwnerID = resolvedControllerOwnerID;
  droneEntity.characterID = toInt(droneEntity.ownerID, resolvedControllerOwnerID);
  droneEntity.pilotCharacterID = resolvedControllerOwnerID;
  if (controllerEntity) {
    droneEntity.corporationID = toInt(
      controllerEntity.corporationID,
      toInt(droneEntity.corporationID, 0),
    );
    droneEntity.allianceID = toInt(
      controllerEntity.allianceID,
      toInt(droneEntity.allianceID, 0),
    );
    droneEntity.warFactionID = toInt(
      controllerEntity.warFactionID,
      toInt(droneEntity.warFactionID, 0),
    );
    applyPlayerCompanionScopeMetadata(
      droneEntity,
      buildPlayerCompanionScopeMetadata(controllerEntity),
    );
    applyDroneOperationalEntityAttributes(droneEntity, controllerEntity);
  }
}

function applyDroneOperationalEntityAttributes(droneEntity, controllerEntity = null) {
  if (!isDroneEntity(droneEntity) || !controllerEntity) {
    return false;
  }
  const attributes = resolveDroneOperationalAttributes(droneEntity, controllerEntity);
  if (!attributes || Object.keys(attributes).length <= 0) {
    return false;
  }

  const typeID = toInt(droneEntity.typeID, 0);
  const typeRecord = resolveItemByTypeID(typeID) || null;
  const mass = Math.max(
    1,
    toNumber(
      attributes[ATTRIBUTE_MASS] ??
        getTypeAttributeValue(typeID, "mass") ??
        (typeRecord && typeRecord.mass) ??
        droneEntity.mass,
      droneEntity.mass || 1,
    ),
  );
  const inertia = Math.max(
    0.05,
    toNumber(attributes[ATTRIBUTE_AGILITY], droneEntity.inertia || 0.1),
  );
  const motionCommand = createDroneOperationalMotionCommand({
    droneEntity,
    mass,
    inertia,
  });
  motionCommand.applyMassAndInertia();
  const maxVelocity = Math.max(
    MIN_DRONE_MAX_VELOCITY,
    toNumber(
      attributes[ATTRIBUTE_MAX_VELOCITY] ?? droneEntity.maxVelocity,
      droneEntity.maxVelocity || MIN_DRONE_MAX_VELOCITY,
    ),
  );
  motionCommand.applyVelocityAndAgility({
    maxVelocity,
    resolveAlignTime: () => inertia * Math.log(4),
    maxAccelerationTime: inertia,
    resolveAgilitySeconds: () => Math.max((mass * inertia) / 1000000, 0.05),
  });
  droneEntity.shieldCapacity = Math.max(
    0,
    toNumber(attributes[ATTRIBUTE_SHIELD_CAPACITY], droneEntity.shieldCapacity || 0),
  );
  droneEntity.shieldRechargeRate = Math.max(
    0,
    toNumber(
      attributes[ATTRIBUTE_SHIELD_RECHARGE_RATE],
      droneEntity.shieldRechargeRate || 0,
    ),
  );
  droneEntity.armorHP = Math.max(
    0,
    toNumber(attributes[ATTRIBUTE_ARMOR_HP], droneEntity.armorHP || 0),
  );
  droneEntity.structureHP = Math.max(
    0,
    toNumber(attributes[ATTRIBUTE_STRUCTURE_HP], droneEntity.structureHP || 0),
  );
  droneEntity.passiveDerivedState = {
    ...(droneEntity.passiveDerivedState || {}),
    attributes: { ...attributes },
  };
  return true;
}

function captureDroneClientState(entity) {
  return {
    ownerID: toInt(entity && entity.ownerID, 0),
    controllerID: toInt(entity && entity.controllerID, 0),
    activityState: toInt(entity && entity.activityState, STATE_IDLE),
    typeID: toInt(entity && entity.typeID, 0),
    controllerOwnerID: toInt(entity && entity.controllerOwnerID, 0),
    targetID: toInt(entity && entity.targetID, 0) || null,
  };
}

function didDroneClientStateChange(before, entity) {
  if (!before || !entity) {
    return true;
  }
  return (
    before.ownerID !== toInt(entity.ownerID, 0) ||
    before.controllerID !== toInt(entity.controllerID, 0) ||
    before.activityState !== toInt(entity.activityState, STATE_IDLE) ||
    before.typeID !== toInt(entity.typeID, 0) ||
    before.controllerOwnerID !== toInt(entity.controllerOwnerID, 0) ||
    before.targetID !== (toInt(entity.targetID, 0) || null)
  );
}

function persistAndNotifyDroneState(droneEntity, beforeState = null, sessions = null) {
  persistDroneEntityState(droneEntity);
  if (!beforeState || didDroneClientStateChange(beforeState, droneEntity)) {
    emitDroneStateChange(droneEntity, {}, sessions);
  }
}

function buildDronePseudoModuleItem(droneEntity) {
  return {
    itemID: toInt(droneEntity && droneEntity.itemID, 0),
    typeID: toInt(droneEntity && droneEntity.typeID, 0),
    groupID: toInt(droneEntity && droneEntity.groupID, 0),
    flagID: 0,
    locationID: toInt(droneEntity && droneEntity.itemID, 0),
    singleton: 1,
    quantity: 1,
    stacksize: 1,
    itemName: String(droneEntity && droneEntity.itemName || "Drone"),
    moduleState: {
      isOnline: true,
      isActive: true,
    },
  };
}

function resolveDroneControllerSession(droneEntity, controllerEntity = null) {
  if (
    controllerEntity &&
    controllerEntity.session &&
    typeof controllerEntity.session.sendNotification === "function"
  ) {
    return controllerEntity.session;
  }

  const controllerCharacterID = resolveDroneControllerOwnerCharacterID(
    controllerEntity,
    droneEntity,
  );
  if (controllerCharacterID <= 0) {
    return null;
  }
  return findSessionByCharacterID(controllerCharacterID) || null;
}

function resolveDroneMiningLedgerObserverContext(scene, targetEntity) {
  const observerIDCandidates = [
    targetEntity && targetEntity.observerItemID,
    targetEntity && targetEntity.observerID,
    targetEntity && targetEntity.structureID,
    targetEntity && targetEntity.ownerStructureID,
    targetEntity && targetEntity.sourceStructureID,
    targetEntity && targetEntity.moonMiningStructureID,
    scene && scene.observerItemID,
    scene && scene.observerID,
    scene && scene.structureID,
  ];
  const observerNameCandidates = [
    targetEntity && targetEntity.observerItemName,
    targetEntity && targetEntity.observerName,
    targetEntity && targetEntity.structureName,
    targetEntity && targetEntity.ownerStructureName,
    targetEntity && targetEntity.sourceStructureName,
    scene && scene.observerItemName,
    scene && scene.observerName,
    scene && scene.structureName,
  ];
  return {
    observerItemID: observerIDCandidates
      .map((candidate) => toInt(candidate, 0))
      .find((candidate) => candidate > 0) || 0,
    observerItemName: observerNameCandidates
      .find((candidate) => typeof candidate === "string" && candidate.trim())
      ?.trim() || "",
  };
}

function notifyMiningDroneAsteroidDepleted(droneEntity, controllerEntity = null) {
  const session = resolveDroneControllerSession(droneEntity, controllerEntity);
  if (!session) {
    return false;
  }

  session.sendNotification("OnRemoteMessage", "clientID", [
    "MiningDronesDeactivatedAsteroidEmpty",
    buildMarshalDict([
      ["asteroidname", ""],
      ["modulename", [4, toInt(droneEntity && droneEntity.typeID, 0)]],
    ]),
  ]);
  return true;
}

function buildDroneCombatSourceEntity(droneEntity, controllerEntity = null) {
  if (!droneEntity) {
    return null;
  }

  const controllerSession = resolveDroneControllerSession(
    droneEntity,
    controllerEntity,
  );
  const controllerCharacterID = resolveDroneControllerOwnerCharacterID(
    controllerEntity,
    droneEntity,
  );
  return {
    ...droneEntity,
    session: controllerSession,
    characterID: controllerCharacterID || toInt(droneEntity.characterID, 0) || null,
    pilotCharacterID:
      controllerCharacterID || toInt(droneEntity.pilotCharacterID, 0) || null,
  };
}

// Crimewatch belongs to the pilot who ordered the drones, not to the
// disposable drone ball.  Keep the drone's controller attribution while using
// the controlling hull as the offender entity (and therefore as CONCORD's
// response target), matching the fighter activation path.
function buildDroneCrimewatchSourceEntity(droneEntity, controllerEntity = null) {
  const combatSourceEntity = buildDroneCombatSourceEntity(
    droneEntity,
    controllerEntity,
  );
  if (!combatSourceEntity || !controllerEntity) {
    return null;
  }
  return {
    ...combatSourceEntity,
    itemID: toInt(controllerEntity.itemID, toInt(combatSourceEntity.itemID, 0)),
    kind: String(controllerEntity.kind || combatSourceEntity.kind || "ship"),
    position: controllerEntity.position || combatSourceEntity.position,
    direction: controllerEntity.direction || combatSourceEntity.direction,
  };
}

function evaluateDroneOffensiveAggression(
  scene,
  droneEntity,
  controllerEntity,
  targetEntity,
  nowMs,
) {
  const sourceEntity = buildDroneCrimewatchSourceEntity(
    droneEntity,
    controllerEntity,
  );
  if (!scene || !sourceEntity || !targetEntity) {
    return { success: false, errorMsg: "DRONE_CONTROLLER_NOT_FOUND" };
  }
  try {
    const crimewatchState = lazyRequire("../security/crimewatchState");
    if (
      !crimewatchState ||
      typeof crimewatchState.evaluateOffensiveAggression !== "function"
    ) {
      return { success: false, errorMsg: "CRIMEWATCH_UNAVAILABLE" };
    }
    return crimewatchState.evaluateOffensiveAggression(
      scene,
      sourceEntity,
      targetEntity,
      nowMs,
    );
  } catch (error) {
    log.warn(
      `[DroneRuntime] Crimewatch engage preflight failed: ${
        error && error.message || error || "UNKNOWN_ERROR"
      }`,
    );
    return { success: false, errorMsg: "CRIMEWATCH_PREFLIGHT_FAILED" };
  }
}

function recordDroneOffensiveAggression(
  scene,
  droneEntity,
  controllerEntity,
  targetEntity,
  nowMs,
) {
  const sourceEntity = buildDroneCrimewatchSourceEntity(
    droneEntity,
    controllerEntity,
  );
  if (!scene || !sourceEntity || !targetEntity) {
    return { success: false, errorMsg: "DRONE_CONTROLLER_NOT_FOUND" };
  }
  try {
    const crimewatchState = lazyRequire("../security/crimewatchState");
    if (
      !crimewatchState ||
      typeof crimewatchState.recordHighSecCriminalAggression !== "function"
    ) {
      return { success: false, errorMsg: "CRIMEWATCH_UNAVAILABLE" };
    }
    return crimewatchState.recordHighSecCriminalAggression(
      scene,
      sourceEntity,
      targetEntity,
      nowMs,
    );
  } catch (error) {
    log.warn(
      `[DroneRuntime] Crimewatch engage commit failed: ${
        error && error.message || error || "UNKNOWN_ERROR"
      }`,
    );
    return { success: false, errorMsg: "CRIMEWATCH_AGGRESSION_FAILED" };
  }
}

function getEntitySurfaceDistance(
  left,
  right,
  scene = null,
  nowMs = null,
  reason = "drone-surface-distance",
) {
  return getSceneSurfaceDistance(scene, left, right, {
    nowMs,
    reason,
  });
}

// The controller ship's effective drone control range (metres). Read from the
// derived droneControlDistance (458) in the ship fitting snapshot the drone
// runtime already consumes; falls back to the 20 km base when no bonus put 458
// in the map. This is the radius, centred on the controlling ship, that a
// drone may operate within.
function resolveDroneControlRangeMeters(controllerEntity) {
  if (!controllerEntity) {
    return DEFAULT_DRONE_CONTROL_DISTANCE_METERS;
  }
  const characterID = resolveDroneControllerOwnerCharacterID(controllerEntity);
  const shipID = toInt(controllerEntity.itemID, 0);
  if (characterID <= 0 || shipID <= 0) {
    return DEFAULT_DRONE_CONTROL_DISTANCE_METERS;
  }
  const fittingSnapshot = getShipFittingSnapshot(characterID, shipID, {
    reason: "drone.controlRange",
  });
  const shipAttributes =
    fittingSnapshot && fittingSnapshot.shipAttributes
      ? fittingSnapshot.shipAttributes
      : null;
  const value = shipAttributes
    ? toNumber(shipAttributes[ATTRIBUTE_DRONE_CONTROL_DISTANCE], NaN)
    : NaN;
  return Number.isFinite(value) && value > 0
    ? value
    : DEFAULT_DRONE_CONTROL_DISTANCE_METERS;
}

// True when a target sits outside the controlling ship's drone control range.
// Used to refuse an engage order (manual, assist or auto-aggression) against a
// target the drones could not legally operate against.
function isTargetBeyondDroneControlRange(scene, controllerEntity, targetEntity, now) {
  if (!scene || !controllerEntity || !targetEntity) {
    return false;
  }
  const controlRangeMeters = resolveDroneControlRangeMeters(controllerEntity);
  const distanceMeters = getEntitySurfaceDistance(
    controllerEntity,
    targetEntity,
    scene,
    now,
    "drone-control-range-gate",
  );
  return Number.isFinite(distanceMeters) && distanceMeters > controlRangeMeters;
}

function readDroneMovementAttribute(
  attributes,
  typeID,
  attributeID,
  ...attributeNames
) {
  if (
    attributes &&
    Object.prototype.hasOwnProperty.call(attributes, attributeID) &&
    attributes[attributeID] !== null &&
    attributes[attributeID] !== undefined
  ) {
    return {
      present: true,
      value: toNumber(attributes[attributeID], 0),
    };
  }

  const typeValue = getTypeAttributeValue(typeID, ...attributeNames);
  if (typeValue !== null && typeValue !== undefined) {
    return {
      present: true,
      value: toNumber(typeValue, 0),
    };
  }
  return {
    present: false,
    value: 0,
  };
}

function resolveDroneMovementProfile(droneEntity, controllerEntity = null) {
  const itemRecord = resolveDroneRuntimeItemRecord(droneEntity);
  const typeID = toInt(
    itemRecord && itemRecord.typeID,
    toInt(droneEntity && droneEntity.typeID, 0),
  );
  // Restrict the fast path to the ordinary hydrated, unmutated drone. The
  // operational resolver still runs on every call; custom items and incomplete
  // or disconnected entities retain the original eager evaluation order.
  const mayDeferBase = Boolean(
    controllerEntity &&
    isDroneEntity(droneEntity) &&
    itemRecord && itemRecord !== droneEntity &&
    toInt(droneEntity.itemID, 0) > 0 &&
    toInt(itemRecord.itemID, 0) === toInt(droneEntity.itemID, 0) &&
    toInt(droneEntity.typeID, 0) > 0 &&
    toInt(itemRecord.typeID, 0) === toInt(droneEntity.typeID, 0) &&
    (droneEntity.customInfo == null || droneEntity.customInfo === "") &&
    (itemRecord.customInfo == null || itemRecord.customInfo === "") &&
    droneEntity.passiveDerivedState &&
    droneEntity.passiveDerivedState.attributes &&
    typeof droneEntity.passiveDerivedState.attributes === "object"
  );
  const baseAttributes = mayDeferBase
    ? null
    : buildEffectiveItemAttributeMap(itemRecord || typeID);
  const operationalAttributes = controllerEntity
    ? resolveDroneOperationalAttributes(droneEntity, controllerEntity)
    : null;
  const cachedOperationalAttributes =
    droneEntity &&
    droneEntity.passiveDerivedState &&
    droneEntity.passiveDerivedState.attributes &&
    typeof droneEntity.passiveDerivedState.attributes === "object"
      ? droneEntity.passiveDerivedState.attributes
      : null;
  const attributes =
    operationalAttributes || cachedOperationalAttributes ||
    (mayDeferBase ? buildEffectiveItemAttributeMap(itemRecord || typeID) : baseAttributes);
  const itemAttributeOverrides = itemRecord
    ? getDynamicItemAttributeOverrides(itemRecord)
    : {};
  const hasItemFlyRangeOverride = Object.prototype.hasOwnProperty.call(
    itemAttributeOverrides,
    ATTRIBUTE_ENTITY_FLY_RANGE,
  );
  const hasItemOrbitRangeOverride = Object.prototype.hasOwnProperty.call(
    itemAttributeOverrides,
    ATTRIBUTE_ORBIT_RANGE,
  );

  const maximumVelocityAttribute = readDroneMovementAttribute(
    attributes,
    typeID,
    ATTRIBUTE_MAX_VELOCITY,
    "maxVelocity",
  );
  const maxVelocity = Math.max(
    MIN_DRONE_MAX_VELOCITY,
    toNumber(
      maximumVelocityAttribute.present
        ? maximumVelocityAttribute.value
        : droneEntity && droneEntity.maxVelocity,
      MIN_DRONE_MAX_VELOCITY,
    ),
  );
  const flyRangeAttribute = readDroneMovementAttribute(
    attributes,
    typeID,
    ATTRIBUTE_ENTITY_FLY_RANGE,
    "entityFlyRange",
  );
  const legacyOrbitRangeAttribute = readDroneMovementAttribute(
    attributes,
    typeID,
    ATTRIBUTE_ORBIT_RANGE,
    "orbitRange",
  );
  let orbitDistance = MIN_ORBIT_DISTANCE_METERS;
  if (hasItemFlyRangeOverride) {
    orbitDistance = Math.min(
      MAX_ORBIT_DISTANCE_METERS,
      Math.max(0, flyRangeAttribute.value),
    );
  } else if (
    hasItemOrbitRangeOverride &&
    legacyOrbitRangeAttribute.value > 0
  ) {
    orbitDistance = clamp(
      legacyOrbitRangeAttribute.value,
      MIN_ORBIT_DISTANCE_METERS,
      MAX_ORBIT_DISTANCE_METERS,
    );
  } else if (flyRangeAttribute.present) {
    orbitDistance = Math.min(
      MAX_ORBIT_DISTANCE_METERS,
      Math.max(0, flyRangeAttribute.value),
    );
  } else if (legacyOrbitRangeAttribute.present && legacyOrbitRangeAttribute.value > 0) {
    orbitDistance = clamp(
      legacyOrbitRangeAttribute.value,
      MIN_ORBIT_DISTANCE_METERS,
      MAX_ORBIT_DISTANCE_METERS,
    );
  }

  const cruiseSpeedAttribute = readDroneMovementAttribute(
    attributes,
    typeID,
    ATTRIBUTE_ENTITY_CRUISE_SPEED,
    "entityCruiseSpeed",
  );
  const cruiseSpeed = cruiseSpeedAttribute.present
    ? Math.max(0, cruiseSpeedAttribute.value)
    : maxVelocity;
  const cruiseFraction = clamp(cruiseSpeed / maxVelocity, 0, 1);
  const chaseDistanceAttribute = readDroneMovementAttribute(
    attributes,
    typeID,
    ATTRIBUTE_ENTITY_CHASE_MAX_DISTANCE,
    "entityChaseMaxDistance",
  );
  const chaseDistance = chaseDistanceAttribute.present
    ? Math.max(0, chaseDistanceAttribute.value)
    : 0;
  const fastPropulsionDisabled =
    maxVelocity <= MIN_DRONE_MAX_VELOCITY + 0.000001 ||
    (
      cruiseSpeedAttribute.present &&
      cruiseSpeed <= 0 &&
      chaseDistanceAttribute.present &&
      chaseDistance <= 0
    );

  return {
    typeID,
    maxVelocity,
    orbitDistance,
    cruiseSpeed,
    cruiseFraction,
    chaseDistance,
    hasCruiseSpeed: cruiseSpeedAttribute.present,
    hasChaseDistance: chaseDistanceAttribute.present,
    fastSpeedFraction: fastPropulsionDisabled ? 0 : 1,
  };
}

function resolveDroneControllerEntity(scene, droneEntity) {
  if (!scene || !droneEntity || typeof scene.getEntityByID !== "function") {
    return null;
  }
  const controllerID = toInt(droneEntity.controllerID, 0);
  return controllerID > 0 ? scene.getEntityByID(controllerID) || null : null;
}

function resolveDroneFastPropulsionExitDistance(movementProfile = {}) {
  const chaseDistance = Math.max(
    0,
    toNumber(movementProfile.chaseDistance, 0),
  );
  const deadBand = Math.min(
    chaseDistance,
    Math.max(
      Math.max(0, toNumber(movementProfile.orbitDistance, 0)),
      chaseDistance * DRONE_FAST_PROPULSION_DEAD_BAND_FRACTION,
    ),
  );
  return Math.max(0, chaseDistance - deadBand);
}

// A distance-only dead band cannot latch against a target that outruns the
// drone's own cruise speed. Standing down to cruise makes the gap re-diverge by
// the speed difference every tick, so it blows straight back through
// chaseDistance and the regime bounces fast/cruise forever — the drone spends
// half its pursuit decelerating to a speed at which it is losing ground. No
// widening of the dead band fixes that, because the release is what causes the
// re-divergence. Cruise may only be selected when cruise can actually hold
// station. An unknown cruise speed keeps the old distance-only rule.
function droneCruiseCanHoldStation(targetEntity, movementProfile) {
  const cruiseSpeed = Math.max(
    0,
    toNumber(movementProfile && movementProfile.cruiseSpeed, 0),
  );
  if (cruiseSpeed <= 0) {
    return true;
  }
  return magnitude(targetEntity && targetEntity.velocity) <= cruiseSpeed;
}

function shouldUseFastDronePropulsion(
  droneEntity,
  targetEntity,
  surfaceDistanceMeters,
  movementProfile,
  options = {},
) {
  if (options.forceFullSpeed === true) {
    return true;
  }
  if (
    !movementProfile ||
    !movementProfile.hasChaseDistance ||
    movementProfile.chaseDistance <= 0
  ) {
    return false;
  }
  if (!droneCruiseCanHoldStation(targetEntity, movementProfile)) {
    return true;
  }

  const surfaceDistance = Math.max(0, toNumber(surfaceDistanceMeters, 0));
  const fastPropulsionLatched = Boolean(
    droneEntity &&
    targetEntity &&
    String(droneEntity.mode || "").toUpperCase() === "ORBIT" &&
    entityIDsEqual(droneEntity.targetEntityID, targetEntity.itemID) &&
    Math.abs(
      toNumber(droneEntity.speedFraction, 0) -
        toNumber(movementProfile.fastSpeedFraction, 0),
    ) <= DRONE_SPEED_FRACTION_EPSILON,
  );
  if (
    fastPropulsionLatched &&
    surfaceDistance <= movementProfile.chaseDistance + ONE_METER &&
    droneHasArrivedInOrbit(droneEntity, targetEntity, movementProfile)
  ) {
    return false;
  }
  const regimeThreshold = fastPropulsionLatched
    ? resolveDroneFastPropulsionExitDistance(movementProfile)
    : movementProfile.chaseDistance;
  return surfaceDistance > regimeThreshold + ONE_METER;
}

// A drone latched at full speed inside its chase distance has arrived once it
// no longer closes on its target faster than its cruise speed: it is circling,
// not closing. Retail's Evolve cannot hold a small orbit at full speed (the old
// style orbit's thrust is capped at speedFraction * maxVelocity), so a fast
// drone settles into a much wider one: about 1.8 km from a Hobgoblin I's target
// against its 1.4 km exit distance. The exit distance alone then never
// releases it, and it circles at full speed until the target dies. An unknown
// cruise speed keeps the
// distance-only rule.
function droneHasArrivedInOrbit(droneEntity, targetEntity, movementProfile) {
  const cruiseSpeed = Math.max(
    0,
    toNumber(movementProfile && movementProfile.cruiseSpeed, 0),
  );
  if (cruiseSpeed <= 0 || !droneEntity || !targetEntity) {
    return false;
  }
  const towardTarget = normalizeVector(
    subtractVectors(targetEntity.position, droneEntity.position),
    { x: 0, y: 0, z: 0 },
  );
  const relativeVelocity = subtractVectors(droneEntity.velocity, targetEntity.velocity);
  const closingSpeed =
    (relativeVelocity.x * towardTarget.x) +
    (relativeVelocity.y * towardTarget.y) +
    (relativeVelocity.z * towardTarget.z);
  return closingSpeed <= cruiseSpeed;
}

function syncDroneOrbitBehavior(
  scene,
  droneEntity,
  targetEntity,
  orbitDistanceMeters,
  options = {},
) {
  if (!scene || !droneEntity || !targetEntity) {
    return false;
  }
  const controllerEntity =
    options.controllerEntity || resolveDroneControllerEntity(scene, droneEntity);
  const movementProfile = resolveDroneMovementProfile(
    droneEntity,
    controllerEntity,
  );
  return scene.orbitShipEntity(
    droneEntity,
    targetEntity.itemID,
    Math.max(0, toNumber(orbitDistanceMeters, 0)),
    {
      broadcast: options.broadcast !== false,
      speedFraction: movementProfile.cruiseFraction,
    },
  );
}

function syncDronePursuitBehavior(
  scene,
  droneEntity,
  targetEntity,
  followRangeMeters,
  options = {},
) {
  if (!scene || !droneEntity || !targetEntity) {
    return false;
  }
  const controllerEntity =
    options.controllerEntity || resolveDroneControllerEntity(scene, droneEntity);
  const movementProfile = resolveDroneMovementProfile(
    droneEntity,
    controllerEntity,
  );
  const surfaceDistance = Number.isFinite(Number(options.surfaceDistanceMeters))
    ? Math.max(0, Number(options.surfaceDistanceMeters))
    : getEntitySurfaceDistance(
        droneEntity,
        targetEntity,
        scene,
        null,
        "drone-propulsion-regime",
      );
  // TQ's analogous ball-level regime controller samples every five seconds,
  // and mission captures show one fast-to-cruise retune roughly nine seconds
  // into a sustained target assignment rather than a tick-by-tick boundary
  // bounce. Preserve the standing orbit's current regime inside a real spatial
  // dead band: enter above chaseDistance, but release only after closing by at
  // least one orbit radius or half of chaseDistance.
  const useFastPropulsion = shouldUseFastDronePropulsion(
    droneEntity,
    targetEntity,
    surfaceDistance,
    movementProfile,
    options,
  );
  // TQ never chases with FollowBall. Across the mission captures in
  // `LOGS/Missions/Done`, every drone engagement is `Orbit(drone, target,
  // orbitRange)` paired with `SetSpeedFraction`, toggling between 1.0 while
  // closing and the cruise fraction once on station; the only FollowBall calls
  // in those logs are the player ship's own keep-at-range. Orbit is also the
  // only correct law here: Carbon's FOLLOW damps its homing scale once the gap
  // falls inside one step of travel, which pins a fast drone at exactly its
  // target's speed and stops it ever closing.
  return scene.orbitShipEntity(
    droneEntity,
    targetEntity.itemID,
    Math.max(0, toNumber(followRangeMeters, 0)),
    {
      broadcast: options.broadcast !== false,
      speedFraction: useFastPropulsion
        ? movementProfile.fastSpeedFraction
        : movementProfile.cruiseFraction,
    },
  );
}

function resolveDroneEngagementRanges(snapshot, fallbackRangeMeters = MIN_ORBIT_DISTANCE_METERS) {
  const orbitDistance = Math.max(
    MIN_ORBIT_DISTANCE_METERS,
    toNumber(
      snapshot && snapshot.orbitDistanceMeters,
      fallbackRangeMeters,
    ),
  );
  const attackRange = Math.max(
    0,
    toNumber(snapshot && snapshot.attackRangeMeters, 0),
  );
  const engagementRange = attackRange > 0 ? attackRange : orbitDistance;
  return {
    orbitDistance,
    engagementRange,
    movementRange: Math.min(orbitDistance, engagementRange),
    chaseRange: Math.max(
      engagementRange,
      toNumber(
        snapshot && snapshot.chaseRangeMeters,
        engagementRange,
      ),
    ),
  };
}

function shouldDroneOrbitTarget(targetEntity) {
  return magnitude(targetEntity && targetEntity.velocity) <= 50;
}

function persistDroneEntityState(entity) {
  if (!isDroneEntity(entity)) {
    return false;
  }
  const result = updateInventoryItemSuccessOnly(entity.itemID, (currentItem) => ({
    ...currentItem,
    locationID: toInt(entity.systemID, toInt(currentItem.locationID, 0)),
    flagID: 0,
    singleton: 1,
    quantity: null,
    stacksize: 1,
    launcherID: toInt(entity.launcherID ?? entity.controllerID, 0) || null,
    customInfo: buildDroneAbyssalOwnershipCustomInfo(currentItem, entity),
    spaceState: serializeDroneSpaceState(entity),
  }));
  return result.success;
}

function getDroneBandwidthLoad(droneItemOrTypeID) {
  const sourceRecord =
    droneItemOrTypeID && typeof droneItemOrTypeID === "object"
      ? droneItemOrTypeID
      : { typeID: droneItemOrTypeID };
  const itemRecord =
    sourceRecord &&
    !sourceRecord.customInfo &&
    toInt(sourceRecord.itemID, 0) > 0
      ? findItemById(sourceRecord.itemID) || sourceRecord
      : sourceRecord;
  const typeID = toInt(itemRecord && itemRecord.typeID, 0);
  const attributes = buildEffectiveItemAttributeMap(itemRecord);
  return Math.max(
    0,
    toNumber(
      attributes[ATTRIBUTE_DRONE_BANDWIDTH_USED],
      getTypeAttributeValue(typeID, "droneBandwidthUsed", "droneBandwidthLoad", "droneBandwidth"),
      0,
    ),
  );
}

function resolveDroneRuntimeItemRecord(droneItemOrEntity) {
  const sourceRecord =
    droneItemOrEntity && typeof droneItemOrEntity === "object"
      ? droneItemOrEntity
      : { typeID: droneItemOrEntity };
  return sourceRecord &&
    !sourceRecord.customInfo &&
    toInt(sourceRecord.itemID, 0) > 0
      ? findItemById(sourceRecord.itemID) || sourceRecord
      : sourceRecord;
}

function resolveDroneOrbitDistance(entity) {
  return resolveDroneMovementProfile(entity).orbitDistance;
}

function buildDroneLaunchSpaceState(
  shipEntity,
  launchIndex = 0,
  launchScopeMetadata = {},
) {
  const shipDirection = normalizeVector(shipEntity && shipEntity.direction, { x: 1, y: 0, z: 0 });
  const lateralDirection = buildPerpendicular(shipDirection);
  const launchDistance =
    Math.max(
      toNumber(shipEntity && shipEntity.radius, 0),
      ONE_METER,
    ) +
    DEFAULT_DRONE_LAUNCH_OFFSET_METERS;
  const lateralOffset = (launchIndex % 5) * 30;
  const signedSide = launchIndex % 2 === 0 ? 1 : -1;
  const position = addVectors(
    addVectors(
      cloneVector(shipEntity && shipEntity.position),
      scaleVector(shipDirection, launchDistance),
    ),
    scaleVector(lateralDirection, lateralOffset * signedSide),
  );
  return {
    systemID: toInt(shipEntity && shipEntity.systemID, 0),
    position,
    velocity: { x: 0, y: 0, z: 0 },
    direction: shipDirection,
    targetPoint: cloneVector(position),
    speedFraction: 0,
    mode: "STOP",
    targetEntityID: null,
    followRange: 0,
    orbitDistance: 0,
    orbitNormal: buildPerpendicular(shipDirection),
    orbitSign: 1,
    effectStamp: 0,
    warpDestination: null,
    ...buildPlayerCompanionScopeMetadata(shipEntity),
    ...(launchScopeMetadata && typeof launchScopeMetadata === "object"
      ? launchScopeMetadata
      : {}),
  };
}

function hydrateDroneEntityFromItem(entity, itemRecord = null) {
  if (!isDroneEntity(entity)) {
    return entity;
  }

  const item = itemRecord || findItemById(entity.itemID) || null;
  const persistedPosition = item && item.spaceState && item.spaceState.position;
  const hasPersistedPosition =
    persistedPosition &&
    Number.isFinite(Number(persistedPosition.x)) &&
    Number.isFinite(Number(persistedPosition.y)) &&
    Number.isFinite(Number(persistedPosition.z));
  const typeID = toInt(item && item.typeID, toInt(entity.typeID, 0));
  const attributes = buildEffectiveItemAttributeMap(item || entity);
  const cachedOperationalAttributes =
    entity.passiveDerivedState &&
    entity.passiveDerivedState.attributes &&
    typeof entity.passiveDerivedState.attributes === "object"
      ? entity.passiveDerivedState.attributes
      : null;
  const motionAttributes = cachedOperationalAttributes || attributes;
  const typeRecord = resolveItemByTypeID(typeID) || null;
  const mass = Math.max(
    1,
    toNumber(
      motionAttributes[ATTRIBUTE_MASS] ??
        getTypeAttributeValue(typeID, "mass") ??
        (typeRecord && typeRecord.mass) ??
        entity.mass,
      entity.mass || 1,
    ),
  );
  const inertia = Math.max(
    0.05,
    toNumber(
      motionAttributes[ATTRIBUTE_AGILITY] ??
        getTypeAttributeValue(typeID, "agility"),
      entity.inertia || 0.1,
    ),
  );
  const maxVelocity = Math.max(
    MIN_DRONE_MAX_VELOCITY,
    toNumber(
      motionAttributes[ATTRIBUTE_MAX_VELOCITY] ??
        getTypeAttributeValue(typeID, "maxVelocity"),
      entity.maxVelocity || MIN_DRONE_MAX_VELOCITY,
    ),
  );

  entity.kind = "drone";
  applyPlayerCompanionScopeMetadata(entity, item);
  applyPlayerCompanionScopeMetadata(entity, item && item.spaceState);
  entity.typeID = typeID;
  entity.groupID = toInt(item && item.groupID, toInt(entity.groupID, 0));
  entity.categoryID = DRONE_CATEGORY_ID;
  entity.ownerID = toInt(item && item.ownerID, toInt(entity.ownerID, 0));
  entity.itemName = String(item && item.itemName || entity.itemName || "Drone");
  entity.customInfo =
    item && item.customInfo !== undefined && item.customInfo !== null
      ? String(item.customInfo)
      : String(entity.customInfo || "");
  entity.mass = mass;
  entity.inertia = inertia;
  entity.maxVelocity = maxVelocity;
  entity.alignTime = inertia * Math.log(4);
  entity.maxAccelerationTime = inertia;
  entity.agilitySeconds = Math.max((mass * inertia) / 1000000, 0.05);
  entity.launcherID = toInt(item && item.launcherID, toInt(entity.launcherID, 0)) || null;
  entity.controllerID = toInt(entity.controllerID, entity.launcherID || 0) || null;
  entity.controllerOwnerID = toInt(entity.controllerOwnerID, entity.ownerID);
  entity.activityState = toInt(entity.activityState, STATE_IDLE);
  entity.targetID = toInt(entity.targetID, 0) || null;
  entity.droneStateVisible = entity.controllerID > 0;
  entity.persistSpaceState = true;
  if (!(entity.lockedTargets instanceof Map)) {
    entity.lockedTargets = new Map();
  }
  if (!(entity.pendingTargetLocks instanceof Map)) {
    entity.pendingTargetLocks = new Map();
  }
  if (!(entity.targetedBy instanceof Set)) {
    entity.targetedBy = new Set();
  }
  if (!(entity.activeModuleEffects instanceof Map)) {
    entity.activeModuleEffects = new Map();
  }
  if (!(entity.moduleReactivationLocks instanceof Map)) {
    entity.moduleReactivationLocks = new Map();
  }
  if (!entity.mode) {
    entity.mode = "STOP";
  }
  if (!entity.direction) {
    entity.direction = { x: 1, y: 0, z: 0 };
  }
  if (!entity.position && hasPersistedPosition) {
    entity.position = cloneVector(persistedPosition);
  }
  if (!entity.velocity) {
    entity.velocity = { x: 0, y: 0, z: 0 };
  }
  if (!entity.targetPoint && entity.position) {
    entity.targetPoint = cloneVector(entity.position);
  }
  return entity;
}

function buildDroneStateRows(entities = []) {
  return entities
    .filter(isDroneEntity)
    .filter((entity) => toInt(entity.controllerID, 0) > 0)
    .map((entity) => [
      toInt(entity.itemID, 0),
      toInt(entity.ownerID, 0),
      toInt(entity.controllerID, 0),
      toInt(entity.activityState, STATE_IDLE),
      toInt(entity.typeID, 0),
      toInt(entity.controllerOwnerID, 0),
      toInt(entity.targetID, 0) || null,
    ]);
}

function resolveRuntimeSceneForSession(runtime, session) {
  if (!runtime || !session || !session._space) {
    return null;
  }
  const sessionScene = typeof runtime.getSceneForSession === "function"
    ? runtime.getSceneForSession(session)
    : null;
  if (sessionScene || sessionClaimsAbyssalScene(session)) {
    return sessionScene;
  }
  return (
    typeof runtime.ensureScene === "function"
      ? runtime.ensureScene(toInt(session._space.systemID, 0))
      : null
  );
}

function getShipStateForSession(session) {
  const characterID = toInt(session && (session.characterID || session.charid), 0);
  if (characterID <= 0) {
    return null;
  }

  const shipRecord = resolveActiveShipRecord(characterID);
  const runtime = getRuntime();
  const scene = shipRecord
    ? resolveRuntimeSceneForSession(runtime, session)
    : null;
  const shipEntity = scene && shipRecord
    ? scene.getEntityByID(shipRecord.itemID)
    : null;

  if (!shipRecord || !scene || !shipEntity) {
    return null;
  }

  return {
    characterID,
    shipRecord,
    shipEntity,
    scene,
  };
}

function getSceneDroneEntities(scene) {
  if (!scene || !(scene.dynamicEntities instanceof Map) || scene.dynamicEntities.size === 0) {
    return [];
  }

  if (scene.droneEntityIDs instanceof Set && scene.droneEntityIDs.size > 0) {
    return [...scene.droneEntityIDs]
      .map((entityID) => scene.dynamicEntities.get(entityID) || null)
      .filter(Boolean);
  }

  const drones = [];
  for (const entity of scene.dynamicEntities.values()) {
    if (isDroneEntity(entity)) {
      drones.push(entity);
    }
  }
  return drones;
}

function listControlledDroneEntities(scene, shipID) {
  const numericShipID = toInt(shipID, 0);
  return getSceneDroneEntities(scene)
    .filter((entity) => toInt(entity.controllerID, 0) === numericShipID);
}

function getSceneControlledCombatDroneIndex(scene) {
  if (!scene) {
    return new Map();
  }

  const expectedCount =
    scene.droneEntityIDs instanceof Set
      ? scene.droneEntityIDs.size
      : 0;
  if (
    scene.droneControlledCombatIndex instanceof Map &&
    scene.droneControlledCombatIndexDirty !== true &&
    toInt(scene.droneControlledCombatIndexCount, -1) === expectedCount
  ) {
    return scene.droneControlledCombatIndex;
  }

  const byControllerID = new Map();
  const controllerCache = new Map();
  for (const droneEntity of getSceneDroneEntities(scene)) {
    const controllerID = toInt(droneEntity && droneEntity.controllerID, 0);
    if (controllerID <= 0) {
      continue;
    }

    const controllerEntity = controllerCache.has(controllerID)
      ? controllerCache.get(controllerID)
      : scene.getEntityByID(controllerID) || null;
    controllerCache.set(controllerID, controllerEntity);
    if (!isDroneCombatCapable(droneEntity, controllerEntity)) {
      continue;
    }

    let entry = byControllerID.get(controllerID);
    if (!entry) {
      entry = {
        combatDroneIDs: [],
        idleCombatDroneIDs: [],
      };
      byControllerID.set(controllerID, entry);
    }
    entry.combatDroneIDs.push(droneEntity.itemID);
    if (!droneEntity.droneCommand) {
      entry.idleCombatDroneIDs.push(droneEntity.itemID);
    }
  }

  scene.droneControlledCombatIndex = byControllerID;
  scene.droneControlledCombatIndexDirty = false;
  scene.droneControlledCombatIndexCount = expectedCount;
  return byControllerID;
}

function selectAggressiveTargetIDs(scene, controllerEntity, preferredTargetID, options = {}) {
  const controllerID = toInt(controllerEntity && controllerEntity.itemID, 0);
  const primaryTargetID = toInt(preferredTargetID, 0);
  const now = toNumber(options.nowMs, Date.now());
  const focusFire = options.focusFire === true;
  const desiredCount = Math.max(0, toInt(options.desiredCount, 0));
  if (!scene || controllerID <= 0 || primaryTargetID <= 0 || desiredCount <= 0) {
    return [];
  }

  const threatsByController = getSceneDroneAggressionThreats(scene);
  const controllerThreats = threatsByController.get(controllerID) || new Map();
  controllerThreats.set(primaryTargetID, now);
  threatsByController.set(controllerID, controllerThreats);
  pruneSceneDroneAggressionThreats(scene, now);

  const recentTargets = [...controllerThreats.entries()]
    .filter(([targetID, lastAggressedAtMs]) => (
      toNumber(lastAggressedAtMs, 0) >= now - DRONE_AGGRESSION_THREAT_RETENTION_MS &&
      Boolean(scene.getEntityByID(toInt(targetID, 0)))
    ))
    .sort((left, right) => (
      toNumber(right[1], 0) - toNumber(left[1], 0) ||
      toInt(left[0], 0) - toInt(right[0], 0)
    ))
    .map(([targetID]) => toInt(targetID, 0))
    .filter((targetID) => targetID > 0);
  if (recentTargets.length <= 0) {
    return [];
  }
  if (focusFire) {
    return Array.from({ length: desiredCount }, () => recentTargets[0]);
  }
  return recentTargets.slice(0, Math.min(desiredCount, recentTargets.length));
}

function assignDroneCombatTask(scene, droneEntity, controllerEntity, targetEntity, options = {}) {
  const usesManualEngagePlan =
    options.preflightToken === MANUAL_ENGAGE_PREFLIGHT;
  if (
    !usesManualEngagePlan &&
    (
      !scene ||
      !isDroneEntity(droneEntity) ||
      !controllerEntity ||
      !targetEntity ||
      !hasDamageableHealth(targetEntity) ||
      !canPlayerCompanionActOnTarget(
        scene,
        options.session || null,
        droneEntity,
        controllerEntity,
        targetEntity,
      )
    )
  ) {
    return {
      success: false,
      errorMsg: "DRONE_INVALID_COMBAT_ASSIGNMENT",
    };
  }

  const snapshot = usesManualEngagePlan
    ? options.resolvedSnapshot
    : resolveDroneCombatSnapshot(droneEntity, controllerEntity);
  if (!usesManualEngagePlan && !snapshot) {
    return {
      success: false,
      errorMsg: "DRONE_NO_COMBAT_PROFILE",
    };
  }

  const now = Math.max(
    0,
    toNumber(
      options.nowMs,
      scene && typeof scene.getCurrentSimTimeMs === "function"
        ? scene.getCurrentSimTimeMs()
        : Date.now(),
    ),
  );
  // Drones cannot be tasked onto a target outside the ship's drone control
  // range. The manual path already refused it in commandEngage (before the
  // crimewatch commit); this guards the assist and auto-aggression paths, so
  // idle drones only ever pick up targets within range. Once tasked, a drone
  // keeps chasing its target past control range, as on TQ.
  if (
    !usesManualEngagePlan &&
    isTargetBeyondDroneControlRange(scene, controllerEntity, targetEntity, now)
  ) {
    return {
      success: false,
      errorMsg: "DRONE_TARGET_OUT_OF_CONTROL_RANGE",
    };
  }
  const beforeState = captureDroneClientState(droneEntity);
  const controllerCharacterID = resolveDroneControllerOwnerCharacterID(
    controllerEntity,
    droneEntity,
  );
  copyControllerIdentity(droneEntity, controllerEntity, controllerCharacterID);
  droneEntity.launcherID = toInt(controllerEntity.itemID, 0);
  droneEntity.controllerID = toInt(controllerEntity.itemID, 0);
  droneEntity.droneCommand = DRONE_COMMAND_ENGAGE;
  // Cycle deadlines belong to the drone, so new orders (including a target
  // change or return/engage) cannot make a weapon that just fired ready again.
  droneEntity.droneCombat = {
    targetID: toInt(targetEntity.itemID, 0),
    nextCycleAtMs: Math.max(now, toNumber(droneEntity.droneNextCombatCycleAtMs, 0)),
    nextJammerCycleAtMs: Math.max(now, toNumber(droneEntity.droneNextJammerCycleAtMs, 0)),
    snapshot,
    autoAssigned: options.autoAssigned === true,
  };
  droneEntity.droneMining = null;
  droneEntity.droneRepair = null;
  droneEntity.targetID = toInt(targetEntity.itemID, 0);

  const distanceToTarget = getEntitySurfaceDistance(
    droneEntity,
    targetEntity,
    scene,
    now,
    "drone-combat-assignment",
  );
  const ranges = resolveDroneEngagementRanges(snapshot);
  const movementProfile = resolveDroneMovementProfile(
    droneEntity,
    controllerEntity,
  );
  if (distanceToTarget > ranges.movementRange + 1) {
    syncDronePursuitBehavior(
      scene,
      droneEntity,
      targetEntity,
      ranges.movementRange,
      {
        controllerEntity,
        surfaceDistanceMeters: distanceToTarget,
      },
    );
    droneEntity.activityState =
      movementProfile.hasChaseDistance &&
      movementProfile.chaseDistance > 0 &&
      distanceToTarget > movementProfile.chaseDistance + 1
        ? STATE_PURSUIT
        : distanceToTarget > ranges.engagementRange + 1
          ? STATE_APPROACHING
          : STATE_COMBAT;
  } else if (shouldDroneOrbitTarget(targetEntity)) {
    syncDroneOrbitBehavior(
      scene,
      droneEntity,
      targetEntity,
      ranges.movementRange,
    );
    droneEntity.activityState = STATE_COMBAT;
  } else {
    syncDronePursuitBehavior(
      scene,
      droneEntity,
      targetEntity,
      ranges.movementRange,
    );
    droneEntity.activityState = STATE_COMBAT;
  }

  persistAndNotifyDroneState(droneEntity, beforeState);
  if (options.emitActivity !== false) {
    emitDroneActivityChange(droneEntity, null, null);
  }
  markSceneControlledCombatDroneIndexDirty(scene);
  return {
    success: true,
    data: {
      snapshot,
    },
  };
}

function getRepairAffinityIDs(entity = null) {
  if (!entity || typeof entity !== "object") {
    return {
      characterID: 0,
      ownerID: 0,
      corporationID: 0,
      allianceID: 0,
    };
  }
  return {
    characterID: toInt(entity.pilotCharacterID ?? entity.characterID, 0),
    ownerID: toInt(entity.ownerID, 0),
    corporationID: toInt(entity.corporationID, 0),
    allianceID: toInt(entity.allianceID, 0),
  };
}

function isFriendlyRepairTarget(controllerEntity, targetEntity) {
  const controller = getRepairAffinityIDs(controllerEntity);
  const target = getRepairAffinityIDs(targetEntity);
  if (
    controller.characterID > 0 &&
    (
      target.characterID === controller.characterID ||
      target.ownerID === controller.characterID
    )
  ) {
    return true;
  }
  if (controller.ownerID > 0 && target.ownerID === controller.ownerID) {
    return true;
  }
  if (controller.corporationID > 0 && target.corporationID === controller.corporationID) {
    return true;
  }
  return controller.allianceID > 0 && target.allianceID === controller.allianceID;
}

function assignDroneRepairTask(scene, droneEntity, controllerEntity, targetEntity, options = {}) {
  const usesManualEngagePlan =
    options.preflightToken === MANUAL_ENGAGE_PREFLIGHT;
  if (
    !usesManualEngagePlan &&
    (
      !scene ||
      !isDroneEntity(droneEntity) ||
      !controllerEntity ||
      !targetEntity ||
      targetEntity.kind !== "ship" ||
      !hasDamageableHealth(targetEntity) ||
      !isFriendlyRepairTarget(controllerEntity, targetEntity) ||
      !canPlayerCompanionActOnTarget(
        scene,
        options.session || null,
        droneEntity,
        controllerEntity,
        targetEntity,
      )
    )
  ) {
    return {
      success: false,
      errorMsg: "DRONE_INVALID_REPAIR_ASSIGNMENT",
    };
  }

  const snapshot = usesManualEngagePlan
    ? options.resolvedSnapshot
    : resolveDroneRepairSnapshot(droneEntity, controllerEntity);
  if (!usesManualEngagePlan && !snapshot) {
    return {
      success: false,
      errorMsg: "DRONE_NO_REPAIR_PROFILE",
    };
  }

  const now = Math.max(
    0,
    toNumber(
      options.nowMs,
      scene && typeof scene.getCurrentSimTimeMs === "function"
        ? scene.getCurrentSimTimeMs()
        : Date.now(),
    ),
  );
  const beforeState = captureDroneClientState(droneEntity);
  const controllerCharacterID = resolveDroneControllerOwnerCharacterID(
    controllerEntity,
    droneEntity,
  );
  copyControllerIdentity(droneEntity, controllerEntity, controllerCharacterID);
  droneEntity.launcherID = toInt(controllerEntity.itemID, 0);
  droneEntity.controllerID = toInt(controllerEntity.itemID, 0);
  droneEntity.droneCommand = DRONE_COMMAND_ENGAGE;
  droneEntity.droneRepair = {
    targetID: toInt(targetEntity.itemID, 0),
    nextCycleAtMs: now,
    snapshot,
  };
  droneEntity.droneCombat = null;
  droneEntity.droneMining = null;
  droneEntity.droneSalvage = null;
  droneEntity.targetID = toInt(targetEntity.itemID, 0);

  const distanceToTarget = getEntitySurfaceDistance(
    droneEntity,
    targetEntity,
    scene,
    now,
    "drone-repair-assignment",
  );
  const ranges = resolveDroneEngagementRanges(snapshot);
  if (distanceToTarget > ranges.movementRange + 1) {
    syncDronePursuitBehavior(
      scene,
      droneEntity,
      targetEntity,
      ranges.movementRange,
    );
    droneEntity.activityState =
      distanceToTarget > ranges.engagementRange + 1
        ? STATE_APPROACHING
        : STATE_COMBAT;
  } else if (shouldDroneOrbitTarget(targetEntity)) {
    syncDroneOrbitBehavior(
      scene,
      droneEntity,
      targetEntity,
      ranges.movementRange,
    );
    droneEntity.activityState = STATE_COMBAT;
  } else {
    syncDronePursuitBehavior(
      scene,
      droneEntity,
      targetEntity,
      ranges.movementRange,
    );
    droneEntity.activityState = STATE_COMBAT;
  }

  persistAndNotifyDroneState(droneEntity, beforeState);
  if (options.emitActivity !== false) {
    emitDroneActivityChange(droneEntity, null, null);
  }
  markSceneControlledCombatDroneIndexDirty(scene);
  return {
    success: true,
    data: {
      snapshot,
    },
  };
}

function extractLaunchedDroneItem(moveResult, systemID) {
  const changes = moveResult && moveResult.data && Array.isArray(moveResult.data.changes)
    ? moveResult.data.changes
    : [];
  return changes
    .map((change) => change && change.item)
    .find((item) =>
      item &&
      toInt(item.locationID, 0) === toInt(systemID, 0) &&
      toInt(item.flagID, 0) === 0,
    ) || null;
}

function clearRecalledDroneEntityState(droneEntity) {
  if (!droneEntity) {
    return;
  }
  droneEntity.launcherID = null;
  droneEntity.controllerID = null;
  droneEntity.controllerOwnerID = 0;
  droneEntity.targetID = null;
  droneEntity.activityState = STATE_IDLE;
  droneEntity.droneCommand = null;
  droneEntity.droneStateVisible = false;
  droneEntity.activityID = null;
  droneEntity.activity = null;
}

function buildDroneRecoveryItemPatch(item, customInfo = item && item.customInfo) {
  const patch = {
    customInfo,
    singleton: 1,
    quantity: 1,
    stacksize: 1,
    launcherID: null,
    spaceState: null,
  };

  // Space persistence stamps the drone's live conditionState onto its item, so a
  // drone knocked into armor carries shieldCharge 0 into the bay and redeploys
  // with no shields at all. Shields and capacitor recharge on their own — only
  // the armor and hull damage survives being stowed, which is what the station
  // repair service then charges to undo. Same trade the ship gets on docking.
  if (item && item.conditionState && typeof item.conditionState === "object") {
    patch.conditionState = normalizeShipConditionState({
      ...item.conditionState,
      charge: 1,
      shieldCharge: 1,
    });
  }

  return patch;
}

function buildDroneRecallRollbackItemPatch(item) {
  return {
    customInfo: item && item.customInfo,
    singleton: item && item.singleton,
    quantity: item && item.quantity,
    stacksize: item && item.stacksize,
    launcherID: item && item.launcherID,
    spaceState: item && item.spaceState,
  };
}

function rollbackPreparedDroneRecallInventory(entries) {
  const failures = [];
  for (const entry of [...(Array.isArray(entries) ? entries : [])].reverse()) {
    const previousData = entry && entry.sourceItem;
    const itemID = toInt(entry && entry.droneEntity && entry.droneEntity.itemID, 0);
    if (!previousData || itemID <= 0) {
      failures.push(itemID);
      continue;
    }
    const currentItem = findItemById(itemID);
    if (!currentItem) {
      failures.push(itemID);
      continue;
    }
    const rollbackResult = itemCustody.transfer({
      items: { itemID },
      from: itemCustody.custodyRef.shipBay(
        toInt(currentItem.ownerID, 0),
        toInt(currentItem.locationID, 0),
        toInt(currentItem.flagID, 0),
      ),
      to: itemCustody.custodyRef.inSpace(
        toInt(previousData.ownerID, 0),
        toInt(previousData.locationID, 0),
        previousData.spaceState || null,
      ),
      reason: itemCustody.CUSTODY_REASON.DRONE_RECOVER_ROLLBACK,
      actor: toInt(currentItem.ownerID, 0) || null,
      idempotencyKey:
        `drone-recover-rollback:${itemID}:` +
        `${toInt(currentItem.locationID, 0)}:${toInt(previousData.locationID, 0)}`,
      options: {
        destinationItemPatch: buildDroneRecallRollbackItemPatch(previousData),
      },
    });
    if (!rollbackResult || rollbackResult.success !== true) {
      failures.push(itemID);
    }
  }
  return {
    success: failures.length === 0,
    failedItemIDs: failures,
  };
}

function restoreDroneRecallScene(scene, entries) {
  const failures = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    const itemID = toInt(entry && entry.droneEntity && entry.droneEntity.itemID, 0);
    if (itemID <= 0 || scene.getEntityByID(itemID)) {
      continue;
    }
    const item = findItemById(itemID);
    if (!item || toInt(item.locationID, 0) !== toInt(scene.systemID, 0)) {
      failures.push(itemID);
      continue;
    }
    const spawnResult = getRuntime().spawnDynamicInventoryEntity(
      scene.sceneDescriptor || scene.systemID,
      itemID,
      {
        sceneDescriptor: scene.sceneDescriptor || undefined,
        // Recall removal is withheld until custody commits. A rollback must
        // restore only local simulation state or clients receive a duplicate
        // AddBalls for a ball they never lost.
        broadcast: false,
        excludedSession: null,
      },
    );
    if (!spawnResult || !spawnResult.success || !spawnResult.data || !spawnResult.data.entity) {
      failures.push(itemID);
      continue;
    }
    hydrateDroneEntityFromItem(spawnResult.data.entity, item);
  }
  markSceneControlledCombatDroneIndexDirty(scene);
  return {
    success: failures.length === 0,
    failedItemIDs: failures,
  };
}

// Stowing a drone is a deposit like any other, and the destination is a
// dogma-limited bay. itemCustody carries no capacity logic of its own, so the
// volume has to be settled here or an abandoned drone can be scooped into a bay
// that is already full — repeatedly.
//
// Drones this ship still has out are already reserved against the bay (see
// getLaunchedDroneReservedBayVolume), so excluding the batch from that reserve
// makes their own recall net out to zero: a drone you launched always has a
// berth waiting. Only volume nobody reserved — captures, abandoned drones,
// drones reconnected after the bay was refilled — has to find real free space.
function getDroneRecallCapacityRefusal(
  scene,
  shipRecord,
  prepared,
  destinationFlagID,
) {
  const shipID = toInt(shipRecord && shipRecord.itemID, 0);
  const requiredVolume = prepared.reduce(
    (sum, entry) => sum + getDroneInventoryVolume(entry.sourceItem),
    0,
  );
  if (shipID <= 0 || requiredVolume <= 0) {
    return null;
  }

  const shipEntity =
    scene && typeof scene.getEntityByID === "function"
      ? scene.getEntityByID(shipID)
      : null;
  const storageSnapshot = resolveShipStorageSnapshotForDrone(shipEntity);
  if (!storageSnapshot) {
    return null;
  }

  const reservedVolume =
    destinationFlagID === ITEM_FLAGS.DRONE_BAY
      ? getLaunchedDroneReservedBayVolume(
        shipID,
        toInt(scene && scene.systemID, 0),
        toInt(shipRecord && shipRecord.ownerID, 0),
        new Set(prepared.map((entry) => toInt(entry.sourceItem.itemID, 0))),
      )
      : 0;
  const availableVolume =
    getAvailableDroneStorageVolume(storageSnapshot, destinationFlagID) -
    reservedVolume;
  if (requiredVolume <= availableVolume + 1e-7) {
    return null;
  }

  return {
    success: false,
    errorMsg:
      destinationFlagID === ITEM_FLAGS.DRONE_BAY
        ? "NOT_ENOUGH_DRONE_BAY_SPACE"
        : "NOT_ENOUGH_CARGO_SPACE",
  };
}

function recallDronesToShipBay(
  scene,
  shipRecord,
  droneEntities,
  destinationFlagID = ITEM_FLAGS.DRONE_BAY,
) {
  const shipID = toInt(shipRecord && shipRecord.itemID, 0);
  const shipOwnerID = toInt(shipRecord && shipRecord.ownerID, 0);
  const normalizedDestinationFlagID = toInt(
    destinationFlagID,
    ITEM_FLAGS.DRONE_BAY,
  );
  if (
    normalizedDestinationFlagID !== ITEM_FLAGS.DRONE_BAY &&
    normalizedDestinationFlagID !== ITEM_FLAGS.CARGO_HOLD
  ) {
    return {
      success: false,
      errorMsg: "INVALID_DRONE_SCOOP_DESTINATION",
    };
  }
  const ownerSession = findSessionByCharacterID(toInt(shipRecord && shipRecord.ownerID, 0));
  const candidates = (Array.isArray(droneEntities) ? droneEntities : [droneEntities])
    .filter((droneEntity) =>
      isDroneEntity(droneEntity) &&
      scene.getEntityByID(toInt(droneEntity && droneEntity.itemID, 0)),
    );
  if (candidates.length <= 0) {
    return {
      success: false,
      errorMsg: "DRONE_REMOVE_FAILED",
    };
  }

  const recalled = [];
  const prepared = [];
  for (const droneEntity of candidates) {
    const sourceItem = findItemById(droneEntity.itemID);
    if (
      !sourceItem ||
      toInt(sourceItem.locationID, 0) !== toInt(scene.systemID, 0) ||
      toInt(sourceItem.flagID, 0) !== 0
    ) {
      return {
        success: false,
        errorMsg: "DRONE_INVENTORY_SOURCE_INVALID",
      };
    }
    prepared.push({
      droneEntity,
      sourceItem,
      interestedSessions: getInterestedDroneSessions(droneEntity),
    });
  }

  const capacityRefusal = getDroneRecallCapacityRefusal(
    scene,
    shipRecord,
    prepared,
    normalizedDestinationFlagID,
  );
  if (capacityRefusal) {
    return capacityRefusal;
  }

  // Unload carried salvage before any drone leaves space. A drone whose salvage
  // cannot be unloaded stays out, so the rows are never shut inside a bay item.
  const unloadNowMs = toNumber(
    typeof scene.getCurrentSimTimeMs === "function"
      ? scene.getCurrentSimTimeMs()
      : scene.simTimeMs,
    Date.now(),
  );
  const shipEntity = scene.getEntityByID(shipID) || null;
  const unloaded = prepared.filter((entry) => unloadDroneSalvageBeforeRecall(
    scene,
    entry.droneEntity,
    shipEntity,
    shipOwnerID,
    unloadNowMs,
  ));
  if (unloaded.length <= 0) {
    return {
      success: false,
      errorMsg: "DRONE_SALVAGE_UNLOAD_FAILED",
    };
  }
  prepared.length = 0;
  prepared.push(...unloaded);

  const removed = [];
  for (const entry of prepared) {
    const removeResult = scene.removeDynamicEntity(entry.droneEntity.itemID, {
      broadcast: false,
      persistSpaceState: false,
    });
    if (!removeResult || removeResult.success !== true) {
      const restoreResult = restoreDroneRecallScene(scene, [...removed, entry]);
      return restoreResult.success
        ? removeResult || { success: false, errorMsg: "DRONE_REMOVE_FAILED" }
        : {
            success: false,
            errorMsg: "DRONE_RECALL_ROLLBACK_FAILED",
            data: { restoreResult, cause: removeResult || null },
          };
    }
    removed.push(entry);
  }

  for (const entry of prepared) {
    const sourceOwnerID = toInt(entry.sourceItem.ownerID, 0);
    const capture = shipOwnerID > 0 && sourceOwnerID !== shipOwnerID;
    const bayUpdateResult = itemCustody.transfer({
      items: { itemID: entry.droneEntity.itemID },
      from: itemCustody.custodyRef.inSpace(
        sourceOwnerID,
        toInt(scene.systemID, 0),
        entry.sourceItem.spaceState || null,
      ),
      to: itemCustody.custodyRef.shipBay(
        shipOwnerID || sourceOwnerID,
        shipID,
        normalizedDestinationFlagID,
      ),
      reason: capture
        ? itemCustody.CUSTODY_REASON.DRONE_CAPTURE
        : itemCustody.CUSTODY_REASON.DRONE_RECOVER,
      actor: shipOwnerID || null,
      idempotencyKey:
        `${capture ? "drone-capture" : "drone-recover"}:` +
        `${entry.droneEntity.itemID}:${shipID}:${normalizedDestinationFlagID}`,
      options: {
        destinationItemPatch: buildDroneRecoveryItemPatch(
          entry.sourceItem,
          buildDroneAbyssalOwnershipCustomInfo(entry.sourceItem, null),
        ),
      },
    });
    if (!bayUpdateResult.success) {
      const rollbackResult = rollbackPreparedDroneRecallInventory(
        recalled,
      );
      const restoreResult = restoreDroneRecallScene(scene, prepared);
      return rollbackResult.success && restoreResult.success
        ? bayUpdateResult
        : {
            success: false,
            errorMsg: "DRONE_RECALL_ROLLBACK_FAILED",
            data: { rollbackResult, restoreResult, cause: bayUpdateResult },
          };
    }

    recalled.push({
      ...entry,
      changes: bayUpdateResult.data && bayUpdateResult.data.changes || [],
    });
  }

  for (const entry of recalled) {
    emitRelevantInventoryChanges(ownerSession, shipID, entry.changes);
  }
  emitDroneStateChangeBatch(
    scene,
    recalled.map((entry) => ({
      entity: entry.droneEntity,
      overrides: {
        ownerID: null,
        controllerID: null,
        activityState: null,
        typeID: null,
        controllerOwnerID: null,
        targetID: null,
      },
      sessions: entry.interestedSessions,
    })),
  );
  // The drones left the park when they were removed: their Grid bubble's
  // Observers get the RemoveBalls at the next bubble update.
  scheduleDroneWindowInventorySettle(
    scene,
    shipRecord,
    normalizeDroneSessions([
      ownerSession,
      ...recalled.flatMap((entry) => entry.interestedSessions),
    ]),
    recalled.map((entry) => entry.droneEntity.itemID),
  );

  for (const entry of recalled) {
    // Read the controller keys before clearRecalledDroneEntityState nulls
    // them — the recall may even capture a foreign drone whose baseline
    // hangs under its previous controller, not under this ship.
    forgetDroneTooltipLastSentStamp(
      entry.droneEntity.controllerID,
      entry.droneEntity.itemID,
    );
    forgetDroneTooltipLastSentStamp(
      entry.droneEntity.launcherID,
      entry.droneEntity.itemID,
    );
    clearRecalledDroneEntityState(entry.droneEntity);
  }

  markSceneControlledCombatDroneIndexDirty(scene);
  return {
    success: true,
    data: {
      droneID: toInt(recalled[0] && recalled[0].droneEntity && recalled[0].droneEntity.itemID, 0),
      droneIDs: recalled.map((entry) => toInt(entry && entry.droneEntity && entry.droneEntity.itemID, 0)),
      shipID,
      destinationFlagID: normalizedDestinationFlagID,
      changes: recalled.flatMap((entry) => entry.changes),
    },
  };
}

function recallDronesToBay(scene, shipRecord, droneEntities) {
  return recallDronesToShipBay(
    scene,
    shipRecord,
    droneEntities,
    ITEM_FLAGS.DRONE_BAY,
  );
}

function recallDroneToBay(scene, shipRecord, droneEntity) {
  return recallDronesToBay(scene, shipRecord, [droneEntity]);
}

function recallDroneToCargo(scene, shipRecord, droneEntity) {
  return recallDronesToShipBay(
    scene,
    shipRecord,
    [droneEntity],
    ITEM_FLAGS.CARGO_HOLD,
  );
}

function launchDronesForSession(session, rawLaunchRequests) {
  const shipState = getShipStateForSession(session);
  const requests = normalizeLaunchRequests(rawLaunchRequests);
  const response = buildMarshalDict();
  if (!shipState) {
    return {
      success: false,
      errorMsg: "Unable to launch drones without an active in-space ship.",
      response,
    };
  }

  const { characterID, shipRecord, shipEntity, scene } = shipState;
  // A ship in warp launches no drones: the client's ShipInWarp ("You cannot do
  // that while warping."). Aligning to warp (mode WARP, the warp not yet
  // begun) still launches. A drone launched in warp is left on the warp path,
  // and one launched on a warp's last tick takes the room the ship is leaving.
  if (isWarping(shipEntity)) {
    for (const request of requests) {
      appendLaunchUserError(response, request.itemID, "ShipInWarp");
    }
    return {
      success: true,
      response,
    };
  }
  if (
    getPlayerCompanionSecurityScope(shipEntity, {
      controller: true,
    }).invalid === true
  ) {
    for (const request of requests) {
      ensureLaunchResponseEntry(response, request.itemID);
      appendLaunchError(
        response,
        request.itemID,
        "Unable to launch a drone while the ship's private-site scope is invalid.",
      );
    }
    return {
      success: true,
      response,
    };
  }
  const launchScope = resolveAbyssalPlayerLaunchScope(
    session,
    shipEntity,
    scene,
  );
  if (launchScope.valid !== true) {
    for (const request of requests) {
      ensureLaunchResponseEntry(response, request.itemID);
      appendLaunchError(
        response,
        request.itemID,
        "Unable to launch a drone while the Abyssal room scope is unresolved.",
      );
    }
    return {
      success: true,
      response,
    };
  }
  const ownerSession = findSessionByCharacterID(toInt(shipRecord && shipRecord.ownerID, 0));
  const launchIdentitySessions = normalizeDroneSessions([session, ownerSession]);
  const fittingSnapshot = getShipFittingSnapshot(characterID, shipRecord.itemID, {
    shipItem: shipRecord,
    reason: "drone.launch",
  });
  const shipAttributes = fittingSnapshot && fittingSnapshot.shipAttributes
    ? fittingSnapshot.shipAttributes
    : {};
  const maxActiveDrones = Math.max(
    0,
    // No derived value means the pilot has no Drones skill: no drones in space.
    toInt(shipAttributes[ATTRIBUTE_MAX_ACTIVE_DRONES], 0),
  );
  const droneBandwidth = scene.getEntityByID(shipRecord.itemID)?.droneBandwidthSuppressed === true
    ? 0
    : Math.max(
      0,
      toNumber(shipAttributes[ATTRIBUTE_DRONE_BANDWIDTH], 0),
    );
  let activeDroneEntities = listControlledDroneEntities(scene, shipRecord.itemID);
  let activeDroneCount = activeDroneEntities.length;
  const launchedDroneEntries = [];
  let usedBandwidth = activeDroneEntities.reduce(
    (sum, entity) => sum + getDroneBandwidthLoad(entity),
    0,
  );
  let launchIndex = activeDroneCount;

  for (const request of requests) {
    ensureLaunchResponseEntry(response, request.itemID);
    const sourceItem = findItemById(request.itemID);
    if (
      !sourceItem ||
      !isDroneItemRecord(sourceItem) ||
      toInt(sourceItem.locationID, 0) !== toInt(shipRecord.itemID, 0) ||
      toInt(sourceItem.flagID, 0) !== ITEM_FLAGS.DRONE_BAY
    ) {
      appendLaunchError(response, request.itemID, "That drone is not available in the active ship drone bay.");
      continue;
    }

    for (let count = 0; count < request.quantity; count += 1) {
      const refreshedSource = findItemById(request.itemID);
      if (!refreshedSource || !isDroneItemRecord(refreshedSource)) {
        appendLaunchError(response, request.itemID, "The requested drone stack is no longer available.");
        break;
      }
      if (maxActiveDrones <= 0 || activeDroneCount >= maxActiveDrones) {
        appendLaunchError(response, request.itemID, "Maximum active drones already in space.");
        break;
      }

      const launchBandwidth = getDroneBandwidthLoad(refreshedSource);
      if ((launchBandwidth > 0 && droneBandwidth <= 0) || usedBandwidth + launchBandwidth > droneBandwidth) {
        appendLaunchError(response, request.itemID, "Not enough drone bandwidth to launch that drone.");
        break;
      }

      const moveResult = itemCustody.transfer({
        items: {
          itemID: refreshedSource.itemID,
          quantity: 1,
        },
        from: itemCustody.custodyRef.shipBay(
          Number(refreshedSource.ownerID) || 0,
          shipRecord.itemID,
          ITEM_FLAGS.DRONE_BAY,
        ),
        to: itemCustody.custodyRef.inSpace(
          Number(refreshedSource.ownerID) || 0,
          scene.systemID,
        ),
        reason: itemCustody.CUSTODY_REASON.DRONE_LAUNCH,
        actor: characterID,
        idempotencyKey:
          `drone-launch:${characterID}:${shipRecord.itemID}:` +
          `${request.itemID}:` +
          `${toNumber(scene.getCurrentSimTimeMs && scene.getCurrentSimTimeMs(), Date.now())}:` +
          `${count}`,
      });
      if (!moveResult.success) {
        appendLaunchError(response, request.itemID, "Unable to launch that drone.");
        break;
      }

      const launchedItem = extractLaunchedDroneItem(moveResult, scene.systemID);
      if (!launchedItem) {
        appendLaunchError(response, request.itemID, "Drone launch created no in-space item.");
        break;
      }

      const inventoryChanges = Array.isArray(moveResult.data && moveResult.data.changes)
        ? moveResult.data.changes.filter(
            (change) =>
              toInt(change && change.item && change.item.itemID, 0) !==
              toInt(launchedItem.itemID, 0),
          )
        : [];
      emitRelevantInventoryChanges(
        session,
        shipRecord.itemID,
        inventoryChanges,
      );

      const spaceState = buildDroneLaunchSpaceState(
        shipEntity,
        launchIndex,
        launchScope.metadata,
      );
      const updateResult = updateInventoryItem(launchedItem.itemID, (currentItem) => ({
        ...currentItem,
        singleton: 1,
        quantity: null,
        stacksize: 1,
        launcherID: shipRecord.itemID,
        spaceState,
      }));
      if (!updateResult.success) {
        appendLaunchError(response, request.itemID, "Unable to finalize drone launch.");
        break;
      }

      primeDroneBayDogmaForLaunch(
        updateResult.data,
        shipRecord,
        launchIdentitySessions,
      );

      const spawnResult = getRuntime().spawnDynamicInventoryEntity(
        scene.sceneDescriptor || scene.systemID,
        launchedItem.itemID,
        {
          sceneDescriptor: scene.sceneDescriptor || undefined,
          broadcast: false,
          excludedSession: null,
        },
      );
      if (!spawnResult.success || !spawnResult.data || !spawnResult.data.entity) {
        appendLaunchError(response, request.itemID, "Unable to materialize drone in space.");
        break;
      }

      const droneEntity = hydrateDroneEntityFromItem(spawnResult.data.entity, updateResult.data);
      applyPlayerCompanionScopeMetadata(
        droneEntity,
        launchScope.metadata,
      );
      if (scene && scene.sceneDescriptor) {
        droneEntity.sceneKey = scene.sceneKey;
        droneEntity.sceneKind = scene.sceneKind;
        droneEntity.instanceScope = scene.sceneKind;
        if (
          String(scene.sceneKind || "").trim().toLowerCase() === "abyssal" &&
          toInt(scene.instanceID, 0) > 0
        ) {
          droneEntity.abyssalRunID = toInt(scene.instanceID, 0);
        }
      }
      droneEntity.launcherID = shipRecord.itemID;
      droneEntity.controllerID = shipRecord.itemID;
      copyControllerIdentity(droneEntity, shipEntity, characterID);
      droneEntity.activityState = STATE_IDLE;
      droneEntity.targetID = null;
      clearDroneTaskState(droneEntity);
      droneEntity.droneHomeOrbitDistance = resolveDroneOrbitDistance(droneEntity);
      // The home orbit is the drone's first order: it applies at the next
      // DoPreTick, before the bubble update that adds the drone, and its Orbit
      // and SetSpeedFraction go to the bubble batch after the pilot's
      // character batch, as TQ sends a launch (golden log "Drone Launch just 2
      // - orbiting - recalling" lines 516 and 571, stamp 29923).
      syncDroneOrbitBehavior(
        scene,
        droneEntity,
        shipEntity,
        droneEntity.droneHomeOrbitDistance,
        {
          controllerEntity: shipEntity,
        },
      );
      droneEntity.droneStateVisible = true;
      persistDroneEntityState(droneEntity);
      const splitCreatedLaunch =
        toInt(droneEntity.itemID, 0) !== toInt(refreshedSource.itemID, 0);
      markSceneControlledCombatDroneIndexDirty(scene);
      appendLaunchEntry(response, request.itemID, toInt(droneEntity.itemID, 0));
      activeDroneEntities.push(droneEntity);
      launchedDroneEntries.push({
        droneEntity,
        splitCreatedLaunch,
      });
      activeDroneCount += 1;
      usedBandwidth += launchBandwidth;
      launchIndex += 1;
    }
  }

  const launchedDroneEntities = launchedDroneEntries.map(
    (entry) => entry.droneEntity,
  );
  if (launchedDroneEntities.length > 0) {
    scene.broadcastAddBalls(launchedDroneEntities);
  }
  // Reassert controller-derived motion after the slim refresh. The drones'
  // AddBalls2, with their modes, comes from the next Grid bubble update,
  // which encodes the same operational fields.
  for (const droneEntity of launchedDroneEntities) {
    applyDroneOperationalEntityAttributes(droneEntity, shipEntity);
  }

  // A launching pilot in space gets its drones' OnDroneStateChange in its
  // character history, ahead of the tick's bubble entries carrying their
  // AddBalls2 (the golden OnDroneStateChange* + AddBalls2 order). Tests and
  // bootstrap callers can launch before Michelle is ready for a Destiny
  // update: those keep the direct event.
  for (const targetSession of launchIdentitySessions) {
    if (targetSession && targetSession._space && targetSession._space.initialStateSent === true) {
      if (launchedDroneEntities.length > 0) {
        scene.queueCharacterHistory(
          targetSession,
          launchedDroneEntities.map((entity) => [
            "OnDroneStateChange",
            buildDroneStateNotificationTuple(entity),
          ]),
          { beforeBubbleEntries: true },
        );
      }
      continue;
    }
    for (const droneEntity of launchedDroneEntities) {
      emitDroneStateChange(droneEntity, {}, [targetSession]);
    }
  }

  // Prime and advertise only finalized singleton rows, after Michelle has the
  // complete authoritative launch set. The count remains bounded above by the
  // fitting snapshot's pilot skill cap and the hull's bandwidth budget.
  for (const entry of launchedDroneEntries) {
    ensureDroneClientIdentityState(
      entry.droneEntity,
      shipRecord,
      launchIdentitySessions,
      {
        forceInsert: entry.splitCreatedLaunch,
        skipDogmaPrime: true,
      },
    );
  }
  scheduleDroneWindowInventorySettle(
    scene,
    shipRecord,
    launchIdentitySessions,
    launchedDroneEntities.map((entity) => entity.itemID),
  );

  return {
    success: true,
    response,
  };
}

function commandReturnDrones(session, rawDroneIDs, commandName) {
  const shipState = getShipStateForSession(session);
  const droneIDs = normalizeDroneIDList(rawDroneIDs);
  const response = buildMultiDroneResult(droneIDs);
  if (!shipState) {
    return response;
  }

  const { shipRecord, shipEntity, scene } = shipState;
  const ownerSession = findSessionByCharacterID(toInt(shipRecord && shipRecord.ownerID, 0));
  const interestedSessions = normalizeDroneSessions([session, ownerSession]);
  for (const droneID of droneIDs) {
    const droneEntity = scene.getEntityByID(droneID);
    if (!isDroneEntity(droneEntity) || toInt(droneEntity.controllerID, 0) !== toInt(shipRecord.itemID, 0)) {
      appendDroneError(response, droneID, "That drone is not currently under this ship's control.");
      continue;
    }
    if (
      !securityScopesExactlyMatch(
        getPlayerCompanionSecurityScope(droneEntity),
        getPlayerCompanionSecurityScope(shipEntity, { controller: true }),
      )
    ) {
      appendDroneError(response, droneID, "That drone is not in this private-site room.");
      continue;
    }

    // Coming home ends a standing pilot assignment. Clear it before the state
    // emit below so the drone entry drops its Assist/Guard line with the order.
    clearDroneAssistAssignment(scene, droneEntity);

    const followDistance =
      commandName === DRONE_COMMAND_RETURN_BAY
        ? DRONE_BAY_RETURN_APPROACH_DISTANCE_METERS
        : resolveDroneOrbitDistance(droneEntity);
    const returnSurfaceDistance = getEntitySurfaceDistance(
      droneEntity,
      shipEntity,
      scene,
      null,
      commandName === DRONE_COMMAND_RETURN_BAY
        ? "drone-return-bay-command"
        : "drone-return-home-command",
    );
    const alreadyWithinScoopRange =
      commandName === DRONE_COMMAND_RETURN_BAY &&
      returnSurfaceDistance <= DRONE_BAY_SCOOP_DISTANCE_METERS;
    if (!alreadyWithinScoopRange) {
      syncDronePursuitBehavior(
        scene,
        droneEntity,
        shipEntity,
        followDistance,
        {
          broadcast: true,
          controllerEntity: shipEntity,
          forceFullSpeed: true,
          surfaceDistanceMeters: returnSurfaceDistance,
        },
      );
    }
    droneEntity.launcherID = shipRecord.itemID;
    droneEntity.controllerID = shipRecord.itemID;
    droneEntity.controllerOwnerID = toInt(shipRecord.ownerID, 0);
    droneEntity.targetID = shipRecord.itemID;
    droneEntity.activityState = STATE_DEPARTING;
    droneEntity.droneCommand = commandName;
    droneEntity.droneHomeOrbitDistance = resolveDroneOrbitDistance(droneEntity);
    droneEntity.droneCombat = null;
    droneEntity.droneRepair = null;
    stopDroneMiningCycleFx(scene, droneEntity);
    droneEntity.droneMining = null;
    droneEntity.droneSalvage = null;
    droneEntity.activityID = null;
    droneEntity.activity = null;
    persistDroneEntityState(droneEntity);
    // CCP client parity: returning drones must already have a dogma item by
    // the time OnDroneStateChange2 hits the RETURNING state. The client checks
    // both invCache and dogma first; if either side is missing it falls back
    // to a short synthesized DBRow and logs "sequence is too short".
    ensureDroneClientIdentityState(
      droneEntity,
      shipRecord,
      interestedSessions,
      {
        forceRefresh: true,
        skipInventorySync: true,
      },
    );
    emitDroneStateChange(droneEntity, {}, interestedSessions);
    if (commandName !== DRONE_COMMAND_RETURN_BAY) {
      emitDroneActivityChange(droneEntity, null, null, interestedSessions);
    }
    markSceneControlledCombatDroneIndexDirty(scene);
  }

  return response;
}

function commandReturnHome(session, rawDroneIDs) {
  return commandReturnDrones(session, rawDroneIDs, DRONE_COMMAND_RETURN_HOME);
}

function commandReturnBay(session, rawDroneIDs) {
  return commandReturnDrones(session, rawDroneIDs, DRONE_COMMAND_RETURN_BAY);
}

function commandEngage(session, rawDroneIDs, rawTargetID) {
  const shipState = getShipStateForSession(session);
  const droneIDs = normalizeDroneIDList(rawDroneIDs);
  const response = buildMultiDroneResult(droneIDs);
  if (!shipState) {
    return response;
  }

  const targetID = toInt(rawTargetID, 0);
  const { shipRecord, shipEntity, scene } = shipState;
  const targetEntity = scene.getEntityByID(targetID);
  if (!targetEntity || !hasDamageableHealth(targetEntity)) {
    for (const droneID of droneIDs) {
      appendDroneError(response, droneID, "That target cannot be engaged by drones.");
    }
    return response;
  }

  const nowMs = toNumber(
    scene.getCurrentSimTimeMs && scene.getCurrentSimTimeMs(),
    Date.now(),
  );
  const commandPlans = [];
  let crimewatchPreflightFailure = null;

  // The retail client asks Crimewatch for the minimum safety level across all
  // active effects on every selected drone before it sends CmdEngage. Mirror
  // that as a server-side, mutation-free planning pass so a forged RPC cannot
  // assign an illegal task before its consequence is durably recorded.
  for (const droneID of droneIDs) {
    const droneEntity = scene.getEntityByID(droneID);
    if (!isDroneEntity(droneEntity) || toInt(droneEntity.controllerID, 0) !== toInt(shipRecord.itemID, 0)) {
      appendDroneError(response, droneID, "That drone is not currently under this ship's control.");
      continue;
    }
    if (
      !canPlayerCompanionActOnTarget(
        scene,
        session,
        droneEntity,
        shipEntity,
        targetEntity,
      )
    ) {
      appendDroneError(response, droneID, "That target is not visible to this drone.");
      continue;
    }

    const repairSnapshot =
      targetEntity.kind === "ship" &&
      isFriendlyRepairTarget(shipEntity, targetEntity)
        ? resolveDroneRepairSnapshot(droneEntity, shipEntity)
        : null;
    if (repairSnapshot) {
      commandPlans.push({
        droneID,
        droneEntity,
        taskKind: "repair",
        snapshot: repairSnapshot,
      });
      continue;
    }

    const combatSnapshot = resolveDroneCombatSnapshot(
      droneEntity,
      shipEntity,
    );
    if (!combatSnapshot) {
      appendDroneError(response, droneID, "That drone has no supported engage profile.");
      continue;
    }

    if (isTargetBeyondDroneControlRange(scene, shipEntity, targetEntity, nowMs)) {
      appendDroneError(response, droneID, "That target is out of drone control range.");
      continue;
    }

    const crimewatchEvaluation = evaluateDroneOffensiveAggression(
      scene,
      droneEntity,
      shipEntity,
      targetEntity,
      nowMs,
    );
    if (!crimewatchEvaluation || crimewatchEvaluation.success !== true) {
      crimewatchPreflightFailure =
        crimewatchEvaluation ||
        { success: false, errorMsg: "CRIMEWATCH_PREFLIGHT_FAILED" };
      appendDroneError(
        response,
        droneID,
        crimewatchPreflightFailure.errorMsg === "SafetyActivated"
          ? "Your safety setting prevents that drone attack."
          : "Crimewatch could not authorize that drone attack.",
      );
      continue;
    }

    commandPlans.push({
      droneID,
      droneEntity,
      taskKind: "combat",
      snapshot: combatSnapshot,
    });
  }

  if (crimewatchPreflightFailure) {
    // The client treats the selected collection as one safety decision. Keep
    // repair drones in a mixed batch unchanged too; otherwise a rejected
    // command would report a partial success the client never issues itself.
    for (const plan of commandPlans) {
      appendDroneError(
        response,
        plan.droneID,
        crimewatchPreflightFailure.errorMsg === "SafetyActivated"
          ? "Your safety setting prevents that drone command."
          : "Crimewatch could not authorize that drone command.",
      );
    }
    return response;
  }

  const offensivePlans = commandPlans.filter(
    (plan) => plan.taskKind === "combat",
  );
  if (offensivePlans.length > 0) {
    // CmdEngage is one player order even when it carries several drones. One
    // durable consequence commits the order without multiplying security hits
    // or CONCORD responses by the number of selected drone balls.
    const firstOffensivePlan = offensivePlans[0];
    const crimewatchCommit = recordDroneOffensiveAggression(
      scene,
      firstOffensivePlan.droneEntity,
      shipEntity,
      targetEntity,
      nowMs,
    );
    if (!crimewatchCommit || crimewatchCommit.success !== true) {
      for (const plan of commandPlans) {
        appendDroneError(
          response,
          plan.droneID,
          "Crimewatch could not authorize that drone command.",
        );
      }
      return response;
    }
  }

  for (const plan of commandPlans) {
    const { droneEntity, snapshot, taskKind } = plan;
    // An engage order the player gave by hand replaces any standing assignment,
    // but only after every safety check and durable Crimewatch write succeeds.
    // This loop is synchronous with the planning pass. The module-private
    // Symbol consumes those exact entity references and fixed snapshot, so the
    // assignment helpers have no validation/return-false path after commit.
    clearDroneAssistAssignment(scene, droneEntity);
    stopDroneMiningCycleFx(scene, droneEntity);
    const assignOptions = {
      session,
      nowMs,
      emitActivity: true,
      resolvedSnapshot: snapshot,
      preflightToken: MANUAL_ENGAGE_PREFLIGHT,
    };
    if (taskKind === "repair") {
      assignDroneRepairTask(
        scene,
        droneEntity,
        shipEntity,
        targetEntity,
        assignOptions,
      );
    } else {
      assignDroneCombatTask(
        scene,
        droneEntity,
        shipEntity,
        targetEntity,
        assignOptions,
      );
    }
  }

  return response;
}

// entity.CmdAssist/CmdGuard(characterID, droneIDs) — attach a standing drone
// order to a fleet mate without transferring ownership or controller identity.
//
// ⚠ THE ARGUMENT ORDER IS THE INVERSE OF ITS SIBLINGS. CmdEngage, CmdSalvage and
// CmdMineRepeatedly are all (droneIDs, targetID); CmdAssist and CmdGuard are
// (charID, droneIDs). That is the retail wire, not a typo — see
// menuSvcExtras/droneFunctions.py Assist().
//
// ⚠ THE SUBJECT IS A CHARACTER, NOT A BALL. Every other drone order names a
// thing in space; these name a PILOT, and the drones then follow that pilot's
// qualifying NPC combat while the assignment remains valid. The client picks
// the charID two ways: off the active target (where it does the
// ship/capsule/fleet checks itself) or
// straight off the fleet-member menu (where it does none of them and puts a bare
// charID on the wire). So the server has to be the one that means those checks.
function commandDronePilotAssignment(session, rawAssignedCharacterID, rawDroneIDs, mode) {
  const shipState = getShipStateForSession(session);
  const droneIDs = normalizeDroneIDList(rawDroneIDs);
  const response = buildMultiDroneResult(droneIDs);
  if (
    !shipState ||
    ![DRONE_ACTIVITY_ASSIST, DRONE_ACTIVITY_GUARD].includes(mode)
  ) {
    return response;
  }

  const { characterID, shipRecord, shipEntity, scene } = shipState;
  const assignedCharacterID = toInt(rawAssignedCharacterID, 0);
  const assignedShipRecord =
    assignedCharacterID > 0 ? resolveActiveShipRecord(assignedCharacterID) : null;
  const assignedShipEntity = assignedShipRecord
    ? scene.getEntityByID(toInt(assignedShipRecord.itemID, 0))
    : null;
  if (
    assignedCharacterID <= 0 ||
    !assignedShipEntity ||
    String(assignedShipEntity.kind || "") !== "ship" ||
    toInt(assignedShipEntity.groupID, 0) === GROUP_CAPSULE_ID ||
    resolveShipPilotCharacterID(assignedShipEntity) !== assignedCharacterID ||
    !securityScopesExactlyMatch(
      getPlayerCompanionSecurityScope(shipEntity, { controller: true }),
      getPlayerCompanionSecurityScope(assignedShipEntity, { controller: true }),
    )
  ) {
    for (const droneID of droneIDs) {
      appendDroneUserError(
        response,
        droneID,
        "DroneCommandRequiresShipButNotCapsule",
      );
    }
    return response;
  }
  // Assigning to yourself is legal and is what the fleet-member menu offers
  // when you pick your own name. Anyone else must satisfy the fleet rule the
  // client checks before it draws the entry.
  if (
    assignedCharacterID !== characterID &&
    !charactersShareFleet(characterID, assignedCharacterID)
  ) {
    for (const droneID of droneIDs) {
      appendDroneUserError(
        response,
        droneID,
        "DroneCommandRequiresShipPilotedFleetMember",
      );
    }
    return response;
  }

  const ownerSession = findSessionByCharacterID(
    toInt(shipRecord && shipRecord.ownerID, 0),
  );
  const interestedSessions = normalizeDroneSessions([session, ownerSession]);
  let assistingDroneCount = mode === DRONE_ACTIVITY_ASSIST
    ? countSceneDronesAssisting(scene, assignedCharacterID)
    : 0;
  for (const droneID of droneIDs) {
    const droneEntity = scene.getEntityByID(droneID);
    if (
      !isDroneEntity(droneEntity) ||
      toInt(droneEntity.controllerID, 0) !== toInt(shipRecord.itemID, 0)
    ) {
      appendDroneError(response, droneID, "That drone is not currently under this ship's control.");
      continue;
    }
    if (
      !securityScopesExactlyMatch(
        getPlayerCompanionSecurityScope(droneEntity),
        getPlayerCompanionSecurityScope(shipEntity, { controller: true }),
      )
    ) {
      appendDroneError(response, droneID, "That drone is not in this private-site room.");
      continue;
    }
    // Both modes dispatch through the combat assignment path, so a drone with no
    // combat profile could accept the order and then never act on it. Refuse it
    // where the player can see the refusal instead.
    if (!isDroneCombatCapable(droneEntity, shipEntity)) {
      appendDroneError(response, droneID, "That drone has no supported engage profile.");
      continue;
    }

    const existingAssignment = getDronePilotAssignment(droneEntity);
    const isNewSubject =
      !existingAssignment ||
      existingAssignment.mode !== mode ||
      toInt(existingAssignment.characterID, 0) !== assignedCharacterID;
    if (
      mode === DRONE_ACTIVITY_ASSIST &&
      isNewSubject &&
      assistingDroneCount >= MAX_DRONE_ASSIST
    ) {
      appendDroneError(
        response,
        droneID,
        "That pilot already has the maximum number of assisting drones.",
      );
      continue;
    }
    if (mode === DRONE_ACTIVITY_ASSIST && isNewSubject) {
      assistingDroneCount += 1;
    }

    setDronePilotAssignment(
      scene,
      droneEntity,
      assignedCharacterID,
      assignedShipRecord.itemID,
      mode,
    );
    droneEntity.activity = mode;
    droneEntity.activityID = assignedCharacterID;
    persistDroneEntityState(droneEntity);
    emitDroneActivityChange(
      droneEntity,
      assignedCharacterID,
      mode,
      interestedSessions,
    );
  }

  return response;
}

function commandAssist(session, rawAssistID, rawDroneIDs) {
  return commandDronePilotAssignment(
    session,
    rawAssistID,
    rawDroneIDs,
    DRONE_ACTIVITY_ASSIST,
  );
}

function commandGuard(session, rawGuardID, rawDroneIDs) {
  return commandDronePilotAssignment(
    session,
    rawGuardID,
    rawDroneIDs,
    DRONE_ACTIVITY_GUARD,
  );
}

function assignDroneSalvageTask({
  scene,
  session,
  droneEntity,
  shipEntity,
  shipRecord,
  characterID,
  targetEntity,
} = {}) {
  if (!scene || !isDroneEntity(droneEntity) || !shipEntity || !targetEntity) {
    return {
      success: false,
      errorMsg: "That drone cannot salvage the selected target.",
    };
  }
  if (!salvagerRuntime.isSalvageableTarget(targetEntity)) {
    return {
      success: false,
      errorMsg: "That target cannot be salvaged by drones.",
    };
  }
  if (
    !canPlayerCompanionActOnTarget(
      scene,
      session || null,
      droneEntity,
      shipEntity,
      targetEntity,
    )
  ) {
    return {
      success: false,
      errorMsg: "That target is not visible to this drone.",
    };
  }

  const snapshot = resolveDroneSalvageSnapshot(droneEntity, shipEntity);
  if (!snapshot) {
    return {
      success: false,
      errorMsg: "That drone has no supported salvaging profile.",
    };
  }

  const targetID = toInt(targetEntity.itemID, 0);
  const chanceSnapshot = salvagerRuntime.buildSalvageChanceSnapshot(
    targetEntity,
    snapshot.accessBonusPercent,
  );
  const beforeState = captureDroneClientState(droneEntity);
  // A salvage order the player gave by hand replaces any standing assignment.
  clearDroneAssistAssignment(scene, droneEntity);
  stopDroneMiningCycleFx(scene, droneEntity);
  copyControllerIdentity(droneEntity, shipEntity, characterID);
  droneEntity.launcherID = toInt(shipRecord && shipRecord.itemID, toInt(shipEntity.itemID, 0));
  droneEntity.controllerID = toInt(shipRecord && shipRecord.itemID, toInt(shipEntity.itemID, 0));
  droneEntity.targetID = targetID;
  droneEntity.droneCommand = DRONE_COMMAND_SALVAGE;
  droneEntity.droneSalvage = {
    targetID,
    nextCycleAtMs:
      Math.max(
        toNumber(scene.getCurrentSimTimeMs && scene.getCurrentSimTimeMs(), Date.now()),
        Date.now(),
      ) + Math.max(1, toNumber(snapshot.durationMs, 1000)),
    snapshot,
    chanceSnapshot,
  };
  droneEntity.droneMining = null;
  droneEntity.droneCombat = null;
  droneEntity.droneRepair = null;

  const distanceToTarget = getEntitySurfaceDistance(
    droneEntity,
    targetEntity,
    scene,
    scene.simTimeMs,
    "drone-salvage-assignment",
  );
  const orbitDistance = Math.max(
    MIN_ORBIT_DISTANCE_METERS,
    toNumber(snapshot.orbitDistanceMeters, MIN_ORBIT_DISTANCE_METERS),
  );
  const maxRange = Math.max(
    orbitDistance,
    toNumber(snapshot.maxRangeMeters, orbitDistance),
  );
  if (distanceToTarget > maxRange + 1) {
    syncDronePursuitBehavior(scene, droneEntity, targetEntity, orbitDistance);
    droneEntity.activityState = STATE_APPROACHING;
  } else {
    syncDroneOrbitBehavior(scene, droneEntity, targetEntity, orbitDistance);
    droneEntity.activityState = STATE_SALVAGING;
  }

  persistAndNotifyDroneState(droneEntity, beforeState);
  return { success: true };
}

function isAutomaticSalvageCandidate(targetEntity, characterID) {
  // Unattended selection includes the pilot's and current fleet mates' wrecks.
  // Explicit salvage orders may target any pilot's wreck.
  const ownerID = toInt(targetEntity && targetEntity.ownerID, 0);
  return Boolean(
    targetEntity &&
      salvagerRuntime.isSalvageableTarget(targetEntity) &&
      (ownerID === toInt(characterID, 0) ||
        charactersShareFleet(characterID, ownerID))
  );
}

function resolveAutomaticSalvageTarget(
  scene,
  droneEntity,
  shipEntity,
  characterID,
  assignedTargetIDs = null,
  session = null,
) {
  const entities =
    scene && typeof scene.getAllVisibleEntities === "function"
      ? scene.getAllVisibleEntities()
      : [
          ...(Array.isArray(scene && scene.staticEntities) ? scene.staticEntities : []),
          ...(scene && scene.dynamicEntities instanceof Map
            ? [...scene.dynamicEntities.values()]
            : []),
        ];
  let bestTarget = null;
  let bestDistance = Infinity;
  for (const targetEntity of entities) {
    const targetID = toInt(targetEntity && targetEntity.itemID, 0);
    if (
      targetID <= 0 ||
      (assignedTargetIDs instanceof Set && assignedTargetIDs.has(targetID)) ||
      !isAutomaticSalvageCandidate(targetEntity, characterID) ||
      !canPlayerCompanionActOnTarget(
        scene,
        session,
        droneEntity,
        shipEntity,
        targetEntity,
      )
    ) {
      continue;
    }

    const distanceToShip = getEntitySurfaceDistance(
      shipEntity,
      targetEntity,
      scene,
      scene.simTimeMs,
      "drone-auto-salvage-ship",
    );
    const distanceToDrone = getEntitySurfaceDistance(
      droneEntity,
      targetEntity,
      scene,
      scene.simTimeMs,
      "drone-auto-salvage-drone",
    );
    const candidateDistance = Math.min(distanceToShip, distanceToDrone);
    if (candidateDistance < bestDistance) {
      bestDistance = candidateDistance;
      bestTarget = targetEntity;
    }
  }
  return bestTarget;
}

function commandMineRepeatedly(session, rawDroneIDs, rawTargetID) {
  const shipState = getShipStateForSession(session);
  const droneIDs = normalizeDroneIDList(rawDroneIDs);
  const response = buildMultiDroneResult(droneIDs);
  if (!shipState) {
    return response;
  }

  const targetID = toInt(rawTargetID, 0);
  const { characterID, shipRecord, shipEntity, scene } = shipState;
  ensureSceneMiningState(scene);
  const targetEntity = scene.getEntityByID(targetID);
  const mineableState = getMineableState(scene, targetID);
  const targetIsMineable = Boolean(
    targetEntity &&
      mineableState &&
      toInt(mineableState.remainingQuantity, 0) > 0,
  );
  const targetIsSalvageable = Boolean(
    targetEntity &&
      salvagerRuntime.isSalvageableTarget(targetEntity),
  );
  if (
    !targetIsMineable &&
    !targetIsSalvageable
  ) {
    for (const droneID of droneIDs) {
      appendDroneError(response, droneID, "That target cannot be mined or salvaged by drones.");
    }
    return response;
  }

  for (const droneID of droneIDs) {
    const droneEntity = scene.getEntityByID(droneID);
    if (!isDroneEntity(droneEntity) || toInt(droneEntity.controllerID, 0) !== toInt(shipRecord.itemID, 0)) {
      appendDroneError(response, droneID, "That drone is not currently under this ship's control.");
      continue;
    }
    if (
      !canPlayerCompanionActOnTarget(
        scene,
        session,
        droneEntity,
        shipEntity,
        targetEntity,
      )
    ) {
      appendDroneError(response, droneID, "That target is not visible to this drone.");
      continue;
    }

    if (targetIsMineable) {
      const snapshot = resolveDroneMiningSnapshot(droneEntity, shipEntity);
      if (!snapshot) {
        appendDroneError(response, droneID, "That drone has no supported mining profile.");
        continue;
      }
      if (!isDroneMiningCompatibleWithTarget(droneEntity, mineableState)) {
        appendDroneError(response, droneID, "That drone cannot mine the selected resource.");
        continue;
      }

      const beforeState = captureDroneClientState(droneEntity);
      const nowMs = Math.max(
        toNumber(scene.getCurrentSimTimeMs && scene.getCurrentSimTimeMs(), Date.now()),
        Date.now(),
      );
      // A mining order the player gave by hand replaces any standing assignment.
      clearDroneAssistAssignment(scene, droneEntity);
      stopDroneMiningCycleFx(scene, droneEntity);
      copyControllerIdentity(droneEntity, shipEntity, characterID);
      droneEntity.launcherID = shipRecord.itemID;
      droneEntity.controllerID = shipRecord.itemID;
      droneEntity.targetID = targetID;
      droneEntity.droneCommand = DRONE_COMMAND_MINE;
      droneEntity.droneMining = {
        targetID,
        cycleStartedAtMs: null,
        nextCycleAtMs: null,
        fxCycleKey: null,
        snapshot,
      };
      droneEntity.droneSalvage = null;
      droneEntity.droneCombat = null;
      droneEntity.droneRepair = null;

      const distanceToTarget = getEntitySurfaceDistance(
        droneEntity,
        targetEntity,
        scene,
        nowMs,
        "drone-mining-assignment",
      );
      const orbitDistance = Math.max(
        MIN_ORBIT_DISTANCE_METERS,
        toNumber(snapshot.orbitDistanceMeters, MIN_ORBIT_DISTANCE_METERS),
      );
      const maxRange = Math.max(
        orbitDistance,
        toNumber(snapshot.maxRangeMeters, orbitDistance),
      );
      if (distanceToTarget > maxRange + 1) {
        syncDronePursuitBehavior(scene, droneEntity, targetEntity, orbitDistance);
        droneEntity.activityState = STATE_APPROACHING;
      } else {
        syncDroneOrbitBehavior(scene, droneEntity, targetEntity, orbitDistance);
        droneEntity.activityState = STATE_MINING;
        beginDroneMiningCycle(droneEntity.droneMining, snapshot, nowMs);
      }

      persistAndNotifyDroneState(droneEntity, beforeState);
      if (droneEntity.activityState === STATE_MINING) {
        emitDroneMiningCycleFx(
          scene,
          droneEntity,
          targetEntity,
          snapshot,
          droneEntity.droneMining,
          nowMs,
        );
      }
    } else {
      const assignResult = assignDroneSalvageTask({
        scene,
        session,
        droneEntity,
        shipEntity,
        shipRecord,
        characterID,
        targetEntity,
      });
      if (!assignResult || assignResult.success !== true) {
        appendDroneError(
          response,
          droneID,
          assignResult && assignResult.errorMsg
            ? assignResult.errorMsg
            : "That drone has no supported salvaging profile.",
        );
        continue;
      }
    }

    emitDroneActivityChange(droneEntity, null, null);
    markSceneControlledCombatDroneIndexDirty(scene);
  }

  return response;
}

function commandSalvage(session, rawDroneIDs, rawTargetID) {
  const shipState = getShipStateForSession(session);
  const droneIDs = normalizeDroneIDList(rawDroneIDs);
  const response = buildMultiDroneResult(droneIDs);
  if (!shipState) {
    return response;
  }

  const targetID = toInt(rawTargetID, 0);
  const { characterID, shipRecord, shipEntity, scene } = shipState;
  const explicitTargetEntity = targetID > 0 ? scene.getEntityByID(targetID) : null;
  if (targetID > 0 && !salvagerRuntime.isSalvageableTarget(explicitTargetEntity)) {
    for (const droneID of droneIDs) {
      appendDroneError(response, droneID, "That target cannot be salvaged by drones.");
    }
    return response;
  }

  const assignedTargetIDs = new Set();
  for (const droneID of droneIDs) {
    const droneEntity = scene.getEntityByID(droneID);
    if (!isDroneEntity(droneEntity) || toInt(droneEntity.controllerID, 0) !== toInt(shipRecord.itemID, 0)) {
      appendDroneError(response, droneID, "That drone is not currently under this ship's control.");
      continue;
    }

    const targetEntity =
      explicitTargetEntity ||
      resolveAutomaticSalvageTarget(
        scene,
        droneEntity,
        shipEntity,
        characterID,
        assignedTargetIDs,
        session,
      );
    if (!targetEntity) {
      appendDroneError(response, droneID, "No salvageable wreck owned by you or a fleet member is available.");
      continue;
    }

    const assignResult = assignDroneSalvageTask({
      scene,
      session,
      droneEntity,
      shipEntity,
      shipRecord,
      characterID,
      targetEntity,
    });
    if (!assignResult || assignResult.success !== true) {
      appendDroneError(
        response,
        droneID,
        assignResult && assignResult.errorMsg
          ? assignResult.errorMsg
          : "That drone has no supported salvaging profile.",
      );
      continue;
    }

    assignedTargetIDs.add(toInt(targetEntity.itemID, 0));
    emitDroneActivityChange(droneEntity, null, null);
    markSceneControlledCombatDroneIndexDirty(scene);
  }

  return response;
}

function commandAbandonDrone(session, rawDroneIDs) {
  const shipState = getShipStateForSession(session);
  const droneIDs = normalizeDroneIDList(rawDroneIDs);
  const response = buildMultiDroneResult(droneIDs);
  if (!shipState) {
    return response;
  }

  const { scene, shipRecord } = shipState;
  for (const droneID of droneIDs) {
    const droneEntity = scene.getEntityByID(droneID);
    if (!isDroneEntity(droneEntity) || toInt(droneEntity.controllerID, 0) !== toInt(shipRecord.itemID, 0)) {
      appendDroneError(response, droneID, "That drone is not currently under this ship's control.");
      continue;
    }
    abandonDroneInSpace(scene, droneEntity, {
      stopMovement: true,
    });
  }

  return response;
}

function abandonDroneInSpace(scene, droneEntity, options = {}) {
  if (!scene || !isDroneEntity(droneEntity)) {
    return false;
  }

  forgetDroneTooltipLastSentStamp(droneEntity.controllerID, droneEntity.itemID);
  forgetDroneTooltipLastSentStamp(droneEntity.launcherID, droneEntity.itemID);

  if (options.stopMovement !== false && typeof scene.stopShipEntity === "function") {
    scene.stopShipEntity(droneEntity, {
      allowSessionOwned: true,
      broadcast: options.broadcastMovement !== false,
    });
  }

  droneEntity.launcherID = null;
  droneEntity.controllerID = null;
  droneEntity.controllerOwnerID = 0;
  droneEntity.targetID = null;
  droneEntity.activityState = STATE_IDLE;
  stopDroneMiningCycleFx(scene, droneEntity);
  clearDroneAssistAssignment(scene, droneEntity);
  clearDroneTaskState(droneEntity);
  droneEntity.droneStateVisible = false;
  droneEntity.activityID = null;
  droneEntity.activity = null;
  updateInventoryItem(droneEntity.itemID, (currentItem) => ({
    ...currentItem,
    launcherID: null,
    spaceState: serializeDroneSpaceState(droneEntity),
  }));
  emitDroneStateChange(droneEntity, {
    ownerID: 0,
    controllerID: 0,
    activityState: STATE_IDLE,
    controllerOwnerID: 0,
    targetID: 0,
  });
  emitDroneActivityChange(droneEntity, null, null);
  markSceneControlledCombatDroneIndexDirty(scene);
  return true;
}

function handleControllerLost(scene, controllerEntity, options = {}) {
  if (!scene || !controllerEntity) {
    return {
      success: false,
      releasedCount: 0,
      recoveredCount: 0,
    };
  }

  const controllerID = toInt(controllerEntity.itemID, 0);
  if (controllerID <= 0) {
    return {
      success: false,
      releasedCount: 0,
      recoveredCount: 0,
    };
  }

  const shipRecord =
    options.shipRecord ||
    findItemById(controllerID) ||
    null;
  const shouldAttemptBayRecovery =
    options.attemptBayRecovery === true ||
    ["disconnect", "logoff"].includes(String(options.lifecycleReason || "").trim().toLowerCase());
  const requestedEntityIDs = Array.isArray(options.entityIDs)
    ? new Set(normalizeDroneIDList(options.entityIDs))
    : null;
  let releasedCount = 0;
  let recoveredCount = 0;

  for (const droneEntity of listControlledDroneEntities(scene, controllerID)) {
    if (requestedEntityIDs && !requestedEntityIDs.has(toInt(droneEntity.itemID, 0))) {
      continue;
    }
    if (
      shouldAttemptBayRecovery &&
      shipRecord &&
      getEntitySurfaceDistance(
        droneEntity,
        controllerEntity,
        scene,
        toNumber(options.nowMs, scene.simTimeMs),
        "drone-controller-loss-recovery",
      ) <= DRONE_BAY_SCOOP_DISTANCE_METERS
    ) {
      const recallResult = recallDroneToBay(scene, shipRecord, droneEntity);
      if (recallResult && recallResult.success === true) {
        releasedCount += 1;
        recoveredCount += 1;
        continue;
      }
    }

    if (abandonDroneInSpace(scene, droneEntity, options)) {
      releasedCount += 1;
    }
  }

  return {
    success: true,
    releasedCount,
    recoveredCount,
  };
}

function commandReconnectToDrones(session, rawDroneIDs) {
  const shipState = getShipStateForSession(session);
  if (!shipState) {
    return buildMarshalDict();
  }

  const { characterID, shipRecord, shipEntity, scene } = shipState;
  const droneIDs = normalizeDroneIDList(rawDroneIDs);
  const fittingSnapshot = getShipFittingSnapshot(characterID, shipRecord.itemID, {
    shipItem: shipRecord,
    reason: "drone.reconnect",
  });
  const shipAttributes = fittingSnapshot && fittingSnapshot.shipAttributes
    ? fittingSnapshot.shipAttributes
    : {};
  const maxActiveDrones = Math.max(
    0,
    // No derived value means the pilot has no Drones skill: no drones in space.
    toInt(shipAttributes[ATTRIBUTE_MAX_ACTIVE_DRONES], 0),
  );
  const droneBandwidth = Math.max(
    0,
    toNumber(shipAttributes[ATTRIBUTE_DRONE_BANDWIDTH], 0),
  );
  const controlledDroneEntities = listControlledDroneEntities(scene, shipRecord.itemID);
  let activeDroneCount = controlledDroneEntities.length;
  let usedBandwidth = controlledDroneEntities.reduce(
    (sum, entity) => sum + getDroneBandwidthLoad(entity),
    0,
  );

  for (const droneID of droneIDs) {
    const droneEntity = scene.getEntityByID(droneID);
    if (!isDroneEntity(droneEntity)) {
      continue;
    }
    if (toInt(droneEntity.ownerID, 0) !== characterID || toInt(droneEntity.controllerID, 0) > 0) {
      continue;
    }
    if (
      !securityScopesExactlyMatch(
        getPlayerCompanionSecurityScope(droneEntity),
        getPlayerCompanionSecurityScope(shipEntity, { controller: true }),
      )
    ) {
      continue;
    }
    if (maxActiveDrones <= 0 || activeDroneCount >= maxActiveDrones) {
      return buildNotifyErrorResult("Maximum active drones already in space.");
    }
    const droneBandwidthLoad = getDroneBandwidthLoad(droneEntity);
    if (
      (droneBandwidthLoad > 0 && droneBandwidth <= 0) ||
      usedBandwidth + droneBandwidthLoad > droneBandwidth
    ) {
      return buildNotifyErrorResult(
        "Not enough drone bandwidth to reconnect to those drones.",
      );
    }

    droneEntity.controllerID = shipRecord.itemID;
    copyControllerIdentity(droneEntity, scene.getEntityByID(shipRecord.itemID), characterID);
    droneEntity.activityState = STATE_IDLE;
    droneEntity.targetID = null;
    clearDroneAssistAssignment(scene, droneEntity);
    clearDroneTaskState(droneEntity);
    droneEntity.droneStateVisible = true;
    droneEntity.launcherID = shipRecord.itemID;
    persistDroneEntityState(droneEntity);
    emitDroneStateChange(droneEntity);
    emitDroneActivityChange(droneEntity, null, null);
    markSceneControlledCombatDroneIndexDirty(scene);
    activeDroneCount += 1;
    usedBandwidth += droneBandwidthLoad;
  }

  return buildMarshalDict();
}

function scoopDrone(session, rawDroneIDs) {
  const shipState = getShipStateForSession(session);
  const droneIDs = normalizeDroneIDList(rawDroneIDs);
  const response = buildMultiDroneResult(droneIDs);
  if (!shipState) {
    return response;
  }

  const { characterID, shipRecord, shipEntity, scene } = shipState;
  for (const droneID of droneIDs) {
    const droneEntity = scene.getEntityByID(droneID);
    if (!isDroneEntity(droneEntity)) {
      appendDroneError(response, droneID, "That drone is not in local space.");
      continue;
    }
    if (toInt(droneEntity.controllerID, 0) > 0) {
      appendDroneError(response, droneID, "That drone cannot currently be scooped into the drone bay.");
      continue;
    }
    if (
      !securityScopesExactlyMatch(
        getPlayerCompanionSecurityScope(droneEntity),
        getPlayerCompanionSecurityScope(shipEntity, { controller: true }),
      )
    ) {
      appendDroneError(response, droneID, "That drone is not in this private-site room.");
      continue;
    }
    if (
      getEntitySurfaceDistance(
        droneEntity,
        shipEntity,
        scene,
        scene.simTimeMs,
        "drone-scoop",
      ) > DRONE_BAY_SCOOP_DISTANCE_METERS
    ) {
      appendDroneError(response, droneID, "Drone is too far away to scoop into the bay.");
      continue;
    }

    const recallResult = recallDroneToBay(scene, shipRecord, droneEntity);
    if (!recallResult || recallResult.success !== true) {
      if (
        recallResult &&
        recallResult.errorMsg === "NOT_ENOUGH_DRONE_BAY_SPACE"
      ) {
        appendDroneUserError(response, droneID, "NotEnoughDroneBaySpace");
        continue;
      }
      appendDroneError(response, droneID, "Unable to scoop that drone.");
    }
  }

  return response;
}

function scoopDroneToCargo(session, rawDroneID) {
  const shipState = getShipStateForSession(session);
  if (!shipState) {
    return {
      success: false,
      errorMsg: "INVALID_SESSION",
    };
  }

  const droneID = toInt(rawDroneID, 0);
  const { shipRecord, shipEntity, scene } = shipState;
  const droneEntity = droneID > 0 ? scene.getEntityByID(droneID) : null;
  if (!isDroneEntity(droneEntity)) {
    return {
      success: false,
      errorMsg: "TARGET_NOT_FOUND",
    };
  }
  if (toInt(droneEntity.controllerID, 0) > 0) {
    return {
      success: false,
      errorMsg: "DRONE_CONTROLLED",
    };
  }
  if (
    !securityScopesExactlyMatch(
      getPlayerCompanionSecurityScope(droneEntity),
      getPlayerCompanionSecurityScope(shipEntity, { controller: true }),
    )
  ) {
    return {
      success: false,
      errorMsg: "DRONE_SECURITY_SCOPE_MISMATCH",
    };
  }
  if (
    getEntitySurfaceDistance(
      droneEntity,
      shipEntity,
      scene,
      scene.simTimeMs,
      "drone-cargo-scoop",
    ) > DRONE_BAY_SCOOP_DISTANCE_METERS
  ) {
    return {
      success: false,
      errorMsg: "TARGET_TOO_FAR",
    };
  }

  const sourceItem = findItemById(droneID);
  if (
    !sourceItem ||
    !isDroneItemRecord(sourceItem) ||
    toInt(sourceItem.locationID, 0) !== toInt(scene.systemID, 0) ||
    toInt(sourceItem.flagID, 0) !== 0
  ) {
    return {
      success: false,
      errorMsg: "DRONE_INVENTORY_SOURCE_INVALID",
    };
  }

  const requiredVolume = getDroneInventoryVolume(sourceItem);
  const storageSnapshot = resolveShipStorageSnapshotForDrone(shipEntity);
  if (!storageSnapshot || requiredVolume <= 0) {
    return {
      success: false,
      errorMsg: "SHIP_CARGO_UNAVAILABLE",
    };
  }
  if (
    requiredVolume >
    getAvailableDroneStorageVolume(storageSnapshot, ITEM_FLAGS.CARGO_HOLD) + 1e-7
  ) {
    return {
      success: false,
      errorMsg: "NOT_ENOUGH_CARGO_SPACE",
    };
  }

  return recallDroneToCargo(scene, shipRecord, droneEntity);
}

function resetDroneToIdle(droneEntity, controllerEntity = null, options = {}) {
  if (!droneEntity) {
    return false;
  }

  const beforeState = captureDroneClientState(droneEntity);
  const keepController = options.keepController !== false;
  if (!keepController) {
    droneEntity.controllerID = null;
    droneEntity.controllerOwnerID = 0;
  } else if (controllerEntity) {
    droneEntity.controllerID = toInt(controllerEntity.itemID, 0) || droneEntity.controllerID;
    copyControllerIdentity(
      droneEntity,
      controllerEntity,
      toInt(
        controllerEntity &&
          (
            controllerEntity.session && controllerEntity.session.characterID
          ) ||
          controllerEntity &&
          (
            controllerEntity.pilotCharacterID ??
            controllerEntity.characterID ??
            droneEntity.controllerOwnerID
          ),
        0,
      ),
    );
  }
  stopDroneMiningCycleFx(options.scene || null, droneEntity);
  clearDroneTaskState(droneEntity);
  droneEntity.activityState = STATE_IDLE;
  droneEntity.targetID = null;
  if (options.stopMovement === true && controllerEntity) {
    const orbitDistance = Math.max(
      MIN_ORBIT_DISTANCE_METERS,
      resolveDroneOrbitDistance(droneEntity),
    );
    syncDroneOrbitBehavior(
      options.scene,
      droneEntity,
      controllerEntity,
      orbitDistance,
    );
  }
  persistAndNotifyDroneState(droneEntity, beforeState, options.sessions || null);
  emitDroneActivityChange(droneEntity, null, null, options.sessions || null);
  markSceneControlledCombatDroneIndexDirty(options.scene || null);
  return true;
}

function idleMiningDronesTargeting(scene, rawTargetID, options = {}) {
  if (!scene) {
    return 0;
  }

  const targetID = toInt(rawTargetID, 0);
  const excludeDroneID = toInt(options.excludeDroneID, 0);
  if (targetID <= 0) {
    return 0;
  }

  let idledCount = 0;
  for (const droneEntity of getSceneDroneEntities(scene)) {
    const droneID = toInt(droneEntity && droneEntity.itemID, 0);
    if (droneID <= 0 || droneID === excludeDroneID) {
      continue;
    }

    const miningState =
      droneEntity &&
      droneEntity.droneMining &&
      typeof droneEntity.droneMining === "object"
        ? droneEntity.droneMining
        : null;
    const miningTargetID = toInt(
      miningState && miningState.targetID,
      toInt(droneEntity && droneEntity.targetID, 0),
    );
    if (miningTargetID !== targetID) {
      continue;
    }
    if (droneEntity.droneCommand !== DRONE_COMMAND_MINE && !miningState) {
      continue;
    }

    const controllerID = toInt(droneEntity.controllerID, 0);
    const controllerEntity = controllerID > 0 ? scene.getEntityByID(controllerID) : null;
    if (resetDroneToIdle(droneEntity, controllerEntity, {
      scene,
      stopMovement: Boolean(controllerEntity),
      sessions: options.sessions || null,
    })) {
      idledCount += 1;
    }
  }

  return idledCount;
}

function resolveAggressionScene(entity) {
  const systemID = toInt(entity && entity.systemID, 0);
  if (!entity || systemID <= 0) {
    return null;
  }

  const runtime = getRuntime();
  const scene =
    runtime && typeof runtime.findSceneContainingDynamicEntity === "function"
      ? runtime.findSceneContainingDynamicEntity(toInt(entity.itemID, 0))
      : null;
  return scene ||
    (
      runtime && typeof runtime.getSceneByDescriptor === "function" && entity.sceneKey
        ? runtime.getSceneByDescriptor({
          sceneKey: entity.sceneKey,
          sceneKind: entity.sceneKind,
          instanceID: entity.abyssalRunID || entity.instanceID,
          locationID: entity.locationID || systemID,
          solarSystemID: entity.locationID || systemID,
        })
        : null
    ) ||
    (
      runtime && typeof runtime.ensureScene === "function"
        ? runtime.ensureScene(systemID)
        : null
    );
}

function isNativeNpcDroneAssignmentTarget(entity) {
  return Boolean(
    entity &&
      String(entity.kind || "") === "ship" &&
      entity.nativeNpc === true &&
      entity.nativeNpcOccupied === true &&
      !entity.session &&
      toInt(entity.characterID, 0) === 0 &&
      toInt(entity.pilotCharacterID, 0) === 0,
  );
}

function resolveShipPilotCharacterID(entity) {
  return toInt(
    entity && entity.session &&
      (entity.session.characterID || entity.session.charid || entity.session.charID) ||
      entity && (entity.pilotCharacterID || entity.characterID),
    0,
  );
}

function getDroneCombatAssignmentMode(droneEntity) {
  const combatState =
    droneEntity && droneEntity.droneCombat && typeof droneEntity.droneCombat === "object"
      ? droneEntity.droneCombat
      : null;
  if (!combatState) {
    return null;
  }
  if ([DRONE_ACTIVITY_ASSIST, DRONE_ACTIVITY_GUARD].includes(combatState.assignmentMode)) {
    return combatState.assignmentMode;
  }
  return combatState.assistAssigned === true ? DRONE_ACTIVITY_ASSIST : null;
}

function resolveDronePilotAssignmentContext(
  scene,
  droneEntity,
  expectedMode = null,
  assignedShipEntity = null,
) {
  const assignment = getDronePilotAssignment(droneEntity);
  if (
    !scene ||
    !isDroneEntity(droneEntity) ||
    !assignment ||
    (expectedMode && assignment.mode !== expectedMode)
  ) {
    return null;
  }

  const controllerEntity = scene.getEntityByID(toInt(droneEntity.controllerID, 0));
  const resolvedAssignedShip = assignedShipEntity ||
    scene.getEntityByID(toInt(assignment.shipID, 0));
  const ownerCharacterID = resolveDroneControllerOwnerCharacterID(
    controllerEntity,
    droneEntity,
  );
  const assignedCharacterID = toInt(assignment.characterID, 0);
  if (
    !controllerEntity ||
    !resolvedAssignedShip ||
    String(resolvedAssignedShip.kind || "") !== "ship" ||
    toInt(resolvedAssignedShip.itemID, 0) !== toInt(assignment.shipID, 0) ||
    resolveShipPilotCharacterID(resolvedAssignedShip) !== assignedCharacterID ||
    toInt(droneEntity.ownerID, 0) !== ownerCharacterID ||
    toInt(droneEntity.controllerOwnerID, 0) !== ownerCharacterID ||
    toInt(droneEntity.launcherID, 0) !== toInt(controllerEntity.itemID, 0) ||
    (
      ownerCharacterID !== assignedCharacterID &&
      !charactersShareFleet(ownerCharacterID, assignedCharacterID)
    ) ||
    !securityScopesExactlyMatch(
      getPlayerCompanionSecurityScope(droneEntity),
      getPlayerCompanionSecurityScope(controllerEntity, { controller: true }),
    ) ||
    !securityScopesExactlyMatch(
      getPlayerCompanionSecurityScope(controllerEntity, { controller: true }),
      getPlayerCompanionSecurityScope(resolvedAssignedShip, { controller: true }),
    )
  ) {
    return null;
  }

  return {
    assignment,
    controllerEntity,
    assignedShipEntity: resolvedAssignedShip,
  };
}

function invalidateDronePilotAssignment(scene, droneEntity, controllerEntity = null) {
  const assignmentDerivedCombat = Boolean(getDroneCombatAssignmentMode(droneEntity));
  const cleared = clearDroneAssistAssignment(scene, droneEntity);
  if (assignmentDerivedCombat) {
    resetDroneToIdle(droneEntity, controllerEntity, {
      scene,
      stopMovement: Boolean(controllerEntity),
    });
  } else if (cleared) {
    droneEntity.activityID = null;
    droneEntity.activity = null;
    persistDroneEntityState(droneEntity);
    emitDroneActivityChange(droneEntity, null, null);
  }
  return cleared;
}

function dispatchDronePilotAssignment(
  scene,
  assignedShipEntity,
  combatTargetEntity,
  mode,
  whenMs,
) {
  const activeCount = mode === DRONE_ACTIVITY_GUARD
    ? activeDroneGuardAssignmentCount
    : activeDroneAssistAssignmentCount;
  if (
    activeCount <= 0 ||
    !scene ||
    ![DRONE_ACTIVITY_ASSIST, DRONE_ACTIVITY_GUARD].includes(mode) ||
    !isNativeNpcDroneAssignmentTarget(combatTargetEntity) ||
    !hasDamageableHealth(combatTargetEntity)
  ) {
    return 0;
  }

  const assignedCharacterID = resolveShipPilotCharacterID(assignedShipEntity);
  const assignedShipID = toInt(assignedShipEntity && assignedShipEntity.itemID, 0);
  const assignedDroneIDs = getScenePilotAssignedDroneIDs(scene);
  if (assignedCharacterID <= 0 || !assignedDroneIDs || assignedDroneIDs.size <= 0) {
    return 0;
  }

  const assignedTarget = scene.getEntityByID(toInt(combatTargetEntity.itemID, 0));
  if (!assignedTarget || !isNativeNpcDroneAssignmentTarget(assignedTarget)) {
    return 0;
  }

  let engagedCount = 0;
  for (const droneID of [...assignedDroneIDs]) {
    const droneEntity = scene.getEntityByID(toInt(droneID, 0));
    const assignment = getDronePilotAssignment(droneEntity);
    if (!isDroneEntity(droneEntity) || !assignment) {
      assignedDroneIDs.delete(droneID);
      continue;
    }
    if (
      assignment.mode !== mode ||
      toInt(assignment.characterID, 0) !== assignedCharacterID ||
      toInt(assignment.shipID, 0) !== assignedShipID
    ) {
      continue;
    }

    const context = resolveDronePilotAssignmentContext(
      scene,
      droneEntity,
      mode,
      assignedShipEntity,
    );
    if (!context) {
      invalidateDronePilotAssignment(
        scene,
        droneEntity,
        scene.getEntityByID(toInt(droneEntity.controllerID, 0)),
      );
      continue;
    }

    // Explicit owner tasks always win. An assignment-derived task is only
    // replaceable after its target has actually left the scene or died.
    if (droneEntity.droneCommand) {
      const assignmentMode = getDroneCombatAssignmentMode(droneEntity);
      const combatState = droneEntity.droneCombat;
      const currentTarget = combatState
        ? scene.getEntityByID(toInt(combatState.targetID, 0))
        : null;
      if (
        assignmentMode !== mode ||
        (currentTarget && hasDamageableHealth(currentTarget))
      ) {
        continue;
      }
      resetDroneToIdle(droneEntity, context.controllerEntity, {
        scene,
        stopMovement: true,
      });
    }

    const assignResult = assignDroneCombatTask(
      scene,
      droneEntity,
      context.controllerEntity,
      assignedTarget,
      {
        nowMs: whenMs,
        autoAssigned: true,
        emitActivity: true,
      },
    );
    if (assignResult && assignResult.success === true) {
      droneEntity.droneCombat.assignmentMode = mode;
      engagedCount += 1;
    }
  }
  return engagedCount;
}

// Assist reads a successful offensive event from the attacker's end. The
// explicit scene form is also used by module activation/repeat paths, including
// successful targeted EWAR that does not produce a damage notification.
function noteAssistedPilotOffensiveAction(
  scene,
  assistedShipEntity,
  targetEntity,
  whenMs = Date.now(),
) {
  return dispatchDronePilotAssignment(
    scene,
    assistedShipEntity,
    targetEntity,
    DRONE_ACTIVITY_ASSIST,
    whenMs,
  );
}

function noteGuardedPilotIncomingAggression(
  scene,
  guardedShipEntity,
  attackerEntity,
  whenMs = Date.now(),
) {
  return dispatchDronePilotAssignment(
    scene,
    guardedShipEntity,
    attackerEntity,
    DRONE_ACTIVITY_GUARD,
    whenMs,
  );
}

function noteIncomingAggression(attackerEntity, targetEntity, whenMs = Date.now()) {
  const targetSystemID = toInt(targetEntity && targetEntity.systemID, 0);
  if (
    !attackerEntity ||
    !targetEntity ||
    targetSystemID <= 0 ||
    toInt(attackerEntity.itemID, 0) <= 0 ||
    toInt(targetEntity.itemID, 0) <= 0 ||
    toInt(attackerEntity.itemID, 0) === toInt(targetEntity.itemID, 0)
  ) {
    return 0;
  }

  // Assist is deliberately not inferred from generic damage here. Doing so
  // would make excluded area/vorton/superweapon families look like supported
  // targeted actions. The module activation and repeat paths call the explicit
  // Assist hook only after a qualifying cycle succeeds.
  if (
    String(targetEntity.kind || "") !== "ship" ||
    !hasDamageableHealth(attackerEntity)
  ) {
    return 0;
  }

  const resolvedScene = resolveAggressionScene(targetEntity);
  if (!resolvedScene) {
    return 0;
  }

  const controllerEntity = resolvedScene.getEntityByID(toInt(targetEntity.itemID, 0)) || null;
  const hostileEntity = resolvedScene.getEntityByID(toInt(attackerEntity.itemID, 0)) || null;
  if (!controllerEntity || !hostileEntity) {
    return 0;
  }

  const guardEngagedCount = noteGuardedPilotIncomingAggression(
    resolvedScene,
    controllerEntity,
    hostileEntity,
    whenMs,
  );

  const behaviorSettings = getControllerDroneBehaviorSettings(controllerEntity);
  if (behaviorSettings.aggressive !== true) {
    return guardEngagedCount;
  }

  const controlledCombatIndex = getSceneControlledCombatDroneIndex(resolvedScene);
  const controllerEntry =
    controlledCombatIndex.get(toInt(controllerEntity.itemID, 0)) || null;
  const idleCombatDroneIDs =
    controllerEntry && Array.isArray(controllerEntry.idleCombatDroneIDs)
      ? controllerEntry.idleCombatDroneIDs
      : [];
  if (idleCombatDroneIDs.length <= 0) {
    return guardEngagedCount;
  }

  const targetIDs = selectAggressiveTargetIDs(
    resolvedScene,
    controllerEntity,
    hostileEntity.itemID,
    {
      focusFire: behaviorSettings.focusFire,
      desiredCount: idleCombatDroneIDs.length,
      nowMs: whenMs,
    },
  );
  if (targetIDs.length <= 0) {
    return guardEngagedCount;
  }

  let engagedCount = guardEngagedCount;
  const assignmentCount =
    behaviorSettings.focusFire === true
      ? idleCombatDroneIDs.length
      : Math.min(idleCombatDroneIDs.length, targetIDs.length);
  for (let index = 0; index < assignmentCount; index += 1) {
    const droneEntity = resolvedScene.getEntityByID(toInt(idleCombatDroneIDs[index], 0));
    const targetID = toInt(targetIDs[Math.min(index, targetIDs.length - 1)], 0);
    const assignedTarget = targetID > 0 ? resolvedScene.getEntityByID(targetID) : null;
    if (!droneEntity || !assignedTarget || !hasDamageableHealth(assignedTarget)) {
      continue;
    }

    const assignResult = assignDroneCombatTask(
      resolvedScene,
      droneEntity,
      controllerEntity,
      assignedTarget,
      {
        nowMs: whenMs,
        autoAssigned: true,
        emitActivity: true,
      },
    );
    if (assignResult && assignResult.success === true) {
      engagedCount += 1;
    }
  }
  return engagedCount;
}

function resolveDroneJammerCycleMs(jammerConfig) {
  return Math.max(1, toNumber(jammerConfig && jammerConfig.durationMs, 20_000));
}

// One ECM cycle for a drone. Shared by the pure ECM drones, whose whole combat
// snapshot IS the jammer, and by the faction hybrids, which carry it alongside a
// turret and run it on its own clock.
function runDroneJammerCycle(scene, droneEntity, targetEntity, jammerConfig, now) {
  const runtime = getRuntime();
  const cycleMs = resolveDroneJammerCycleMs(jammerConfig);
  if (jammerConfig.effectGUID) {
    scene.broadcastSpecialFx(
      droneEntity.itemID,
      jammerConfig.effectGUID,
      {
        moduleID: toInt(droneEntity && droneEntity.itemID, 0),
        moduleTypeID: toInt(droneEntity && droneEntity.typeID, 0),
        targetID: targetEntity.itemID,
        isOffensive: true,
        start: true,
        active: false,
        duration: cycleMs,
        repeat: 1,
      },
      droneEntity,
    );
  }
  const effectState = {
    moduleID: toInt(droneEntity && droneEntity.itemID, 0),
    targetID: targetEntity.itemID,
    hostileJammingType: jammerModuleRuntime.ECM_JAMMING_TYPE,
    jammerModuleEffect: true,
    jammerStrengthBySensorType: jammerConfig.jammerStrengthBySensorType || {},
    jammerMaxRangeMeters: Math.max(0, toNumber(jammerConfig.optimalRange, 0)),
    jammerFalloffMeters: Math.max(0, toNumber(jammerConfig.falloff, 0)),
    durationMs: cycleMs,
    jamDurationMs: Math.max(1, toNumber(jammerConfig.jamDurationMs, 5_000)),
    nextCycleAtMs: now + cycleMs,
  };
  const cycleResult = jammerModuleRuntime.executeJammerModuleCycle({
    scene,
    entity: droneEntity,
    effectState,
    nowMs: now,
    callbacks: {
      getEntityByID(entityID) {
        return scene && typeof scene.getEntityByID === "function"
          ? scene.getEntityByID(entityID)
          : null;
      },
      isEntityLockedTarget() {
        return true;
      },
      getEntitySurfaceDistance(sourceEntity, externalTargetEntity) {
        return getEntitySurfaceDistance(
          sourceEntity,
          externalTargetEntity,
          scene,
          now,
          "drone-jammer-cycle",
        );
      },
      clearOutgoingTargetLocksExcept(externalTargetEntity, allowedTargetIDs, options = {}) {
        return scene && typeof scene.clearOutgoingTargetLocksExcept === "function"
          ? scene.clearOutgoingTargetLocksExcept(externalTargetEntity, allowedTargetIDs, options)
          : {
            clearedTargetIDs: [],
            cancelledPendingIDs: [],
          };
      },
      random() {
        return scene && typeof scene.__jammerRandom === "function"
          ? Number(scene.__jammerRandom()) || 0
          : Math.random();
      },
    },
  });
  if (
    cycleResult.success &&
    runtime &&
    typeof runtime.applyJammerCyclePresentation === "function"
  ) {
    runtime.applyJammerCyclePresentation(
      scene,
      droneEntity,
      effectState,
      now,
      cycleResult,
    );
  }
  return cycleResult;
}

// The faction hybrids shoot on a 4 s turret cycle and jam on a 20 s ECM cycle at
// the same time, so the jam cannot hang off the turret's `nextCycleAtMs` — it
// gets its own, evaluated before the turret gate so a 20 s jam is not quantised
// up to the next turret boundary.
function tickDroneHybridJammer(scene, droneEntity, targetEntity, snapshot, combatState, now) {
  const jammerConfig = snapshot && snapshot.jammer;
  if (!jammerConfig) {
    return false;
  }
  if (toNumber(combatState.nextJammerCycleAtMs, 0) > now) {
    return false;
  }
  // The cycle clock advances whether or not the jam lands, exactly as the
  // pure-ECM drone path already does. Retrying a refused cycle every tick would
  // also re-broadcast the activation FX every tick, and the three hybrids are
  // never out of jam range while they are in turret range anyway — their jam
  // optimal is more than twice their turret's.
  combatState.nextJammerCycleAtMs = now + resolveDroneJammerCycleMs(jammerConfig);
  droneEntity.droneNextJammerCycleAtMs = combatState.nextJammerCycleAtMs;
  runDroneJammerCycle(scene, droneEntity, targetEntity, jammerConfig, now);
  return true;
}

function tickDroneCombat(scene, droneEntity, controllerEntity, now) {
  const combatState =
    droneEntity &&
    droneEntity.droneCombat &&
    typeof droneEntity.droneCombat === "object"
      ? droneEntity.droneCombat
      : null;
  const targetID = toInt(
    combatState && combatState.targetID,
    toInt(droneEntity && droneEntity.targetID, 0),
  );
  const targetEntity = targetID > 0 ? scene.getEntityByID(targetID) : null;
  if (
    !combatState ||
    !controllerEntity ||
    !targetEntity ||
    !hasDamageableHealth(targetEntity) ||
    !canPlayerCompanionActOnTarget(
      scene,
      null,
      droneEntity,
      controllerEntity,
      targetEntity,
    )
  ) {
    resetDroneToIdle(droneEntity, controllerEntity, {
      scene,
      stopMovement: Boolean(controllerEntity),
    });
    return;
  }

  const snapshot =
    resolveDroneCombatSnapshot(droneEntity, controllerEntity) ||
    combatState.snapshot ||
    null;
  if (!snapshot) {
    resetDroneToIdle(droneEntity, controllerEntity, {
      scene,
      stopMovement: Boolean(controllerEntity),
    });
    return;
  }
  combatState.snapshot = snapshot;

  const ranges = resolveDroneEngagementRanges(snapshot);
  const surfaceDistance = getEntitySurfaceDistance(
    droneEntity,
    targetEntity,
    scene,
    now,
    "drone-combat-tick",
  );
  const beforeState = captureDroneClientState(droneEntity);
  copyControllerIdentity(droneEntity, controllerEntity);
  droneEntity.targetID = targetEntity.itemID;
  const movementProfile = resolveDroneMovementProfile(
    droneEntity,
    controllerEntity,
  );
  if (surfaceDistance > ranges.engagementRange + 1) {
    syncDronePursuitBehavior(
      scene,
      droneEntity,
      targetEntity,
      ranges.movementRange,
      {
        controllerEntity,
        surfaceDistanceMeters: surfaceDistance,
      },
    );
    droneEntity.activityState =
      movementProfile.hasChaseDistance &&
      movementProfile.chaseDistance > 0 &&
      surfaceDistance > movementProfile.chaseDistance + 1
        ? STATE_PURSUIT
        : STATE_APPROACHING;
    persistAndNotifyDroneState(droneEntity, beforeState);
    return;
  }

  if (
    surfaceDistance > ranges.movementRange + 1 ||
    !shouldDroneOrbitTarget(targetEntity)
  ) {
    syncDronePursuitBehavior(
      scene,
      droneEntity,
      targetEntity,
      ranges.movementRange,
      {
        controllerEntity,
        surfaceDistanceMeters: surfaceDistance,
      },
    );
  } else {
    syncDroneOrbitBehavior(
      scene,
      droneEntity,
      targetEntity,
      ranges.movementRange,
    );
  }
  droneEntity.activityState = STATE_COMBAT;
  persistAndNotifyDroneState(droneEntity, beforeState);

  if (tickDroneHybridJammer(scene, droneEntity, targetEntity, snapshot, combatState, now)) {
    persistDroneEntityState(droneEntity);
  }

  if (toNumber(combatState.nextCycleAtMs, 0) > now) {
    return;
  }

  if (String(snapshot && snapshot.effectKind || "") === "jammer") {
    combatState.nextCycleAtMs = now + resolveDroneJammerCycleMs(snapshot);
    droneEntity.droneNextCombatCycleAtMs = combatState.nextCycleAtMs;
    runDroneJammerCycle(scene, droneEntity, targetEntity, snapshot, now);
    persistDroneEntityState(droneEntity);
    return;
  }

  const runtime = getRuntime();
  const droneInterop =
    runtime && runtime.droneInterop && typeof runtime.droneInterop === "object"
      ? runtime.droneInterop
      : null;
  if (!droneInterop || typeof droneInterop.resolveTurretShot !== "function") {
    return;
  }

  // Consume the cycle before resolving damage or target destruction, even
  // when the shot misses or the resulting idle state clears the combat task.
  combatState.nextCycleAtMs = now + Math.max(1, toNumber(snapshot.durationMs, 1000));
  droneEntity.droneNextCombatCycleAtMs = combatState.nextCycleAtMs;
  const pseudoModuleItem = buildDronePseudoModuleItem(droneEntity);
  const combatSourceEntity = buildDroneCombatSourceEntity(
    droneEntity,
    controllerEntity,
  ) || droneEntity;
  const shotResult = droneInterop.resolveTurretShot({
    attackerEntity: droneEntity,
    targetEntity,
    weaponSnapshot: snapshot,
  });
  if (snapshot.effectGUID) {
    scene.broadcastSpecialFx(
      droneEntity.itemID,
      snapshot.effectGUID,
      {
        moduleID: pseudoModuleItem.itemID,
        moduleTypeID: pseudoModuleItem.typeID,
        targetID: targetEntity.itemID,
        isOffensive: true,
        start: true,
        active: false,
        duration: snapshot.durationMs,
        repeat: 1,
      },
      droneEntity,
    );
  }

  let damageResult = null;
  let destroyResult = null;
  if (
    shotResult &&
    shotResult.hit === true &&
    typeof droneInterop.applyWeaponDamageToTarget === "function"
  ) {
    const weaponDamageResult = droneInterop.applyWeaponDamageToTarget(
      scene,
      droneEntity,
      targetEntity,
      shotResult.shotDamage,
      now,
    );
    damageResult = weaponDamageResult && weaponDamageResult.damageResult
      ? weaponDamageResult.damageResult
      : null;
    destroyResult = weaponDamageResult && weaponDamageResult.destroyResult
      ? weaponDamageResult.destroyResult
      : null;
    const appliedDamageAmount =
      typeof droneInterop.getAppliedDamageAmount === "function"
        ? droneInterop.getAppliedDamageAmount(damageResult)
        : 0;
    if (
      appliedDamageAmount > 0 &&
      typeof droneInterop.noteKillmailDamage === "function"
    ) {
      droneInterop.noteKillmailDamage(
        combatSourceEntity,
        targetEntity,
        appliedDamageAmount,
        {
          whenMs: now,
          weaponSnapshot: {
            ...snapshot,
            moduleTypeID: pseudoModuleItem.typeID,
          },
          moduleItem: pseudoModuleItem,
          chargeItem: null,
        },
      );
    }
    if (
      destroyResult &&
      destroyResult.success === true &&
      typeof droneInterop.recordKillmailFromDestruction === "function"
    ) {
      droneInterop.recordKillmailFromDestruction(targetEntity, destroyResult, {
        attackerEntity: combatSourceEntity,
        victimSession: weaponDamageResult && weaponDamageResult.victimSession,
        whenMs: now,
        weaponSnapshot: {
          ...snapshot,
          moduleTypeID: pseudoModuleItem.typeID,
        },
        moduleItem: pseudoModuleItem,
        chargeItem: null,
      });
    }
  }

  if (typeof droneInterop.notifyWeaponDamageMessages === "function") {
    droneInterop.notifyWeaponDamageMessages(
      combatSourceEntity,
      targetEntity,
      pseudoModuleItem,
      shotResult && shotResult.shotDamage,
      typeof droneInterop.getAppliedDamageAmount === "function"
        ? droneInterop.getAppliedDamageAmount(damageResult)
        : 0,
      typeof droneInterop.getCombatMessageHitQuality === "function"
        ? droneInterop.getCombatMessageHitQuality(shotResult)
        : 0,
    );
  }

  if (destroyResult && destroyResult.success === true) {
    resetDroneToIdle(droneEntity, controllerEntity, {
      scene,
      stopMovement: true,
    });
  } else {
    persistDroneEntityState(droneEntity);
  }
}

function tickDroneMining(scene, droneEntity, controllerEntity, now) {
  const miningState =
    droneEntity &&
    droneEntity.droneMining &&
    typeof droneEntity.droneMining === "object"
      ? droneEntity.droneMining
      : null;
  const targetID = toInt(
    miningState && miningState.targetID,
    toInt(droneEntity && droneEntity.targetID, 0),
  );
  ensureSceneMiningState(scene);
  const targetEntity = targetID > 0 ? scene.getEntityByID(targetID) : null;
  const missionSettlement = targetEntity?.dungeonMaterializedMiningRock === true
    ? lazyRequire("../dungeon/missionMiningSettlement") : null;
  const missionRock = missionSettlement?.isMissionRock(targetEntity) === true;
  if (missionRock && !missionSettlement.reconcile(targetEntity.dungeonSiteInstanceID, { scene, nowMs: now }).success) {
    resetDroneToIdle(droneEntity, controllerEntity, { scene, stopMovement: Boolean(controllerEntity) });
    return;
  }
  const mineableState = getMineableState(scene, targetID);
  if (
    !miningState ||
    !controllerEntity ||
    !targetEntity ||
    !mineableState ||
    toInt(mineableState.remainingQuantity, 0) <= 0 ||
    !canPlayerCompanionActOnTarget(
      scene,
      null,
      droneEntity,
      controllerEntity,
      targetEntity,
    )
  ) {
    resetDroneToIdle(droneEntity, controllerEntity, {
      scene,
      stopMovement: Boolean(controllerEntity),
    });
    return;
  }

  const snapshot =
    resolveDroneMiningSnapshot(droneEntity, controllerEntity) ||
    miningState.snapshot ||
    null;
  if (!snapshot || !isDroneMiningCompatibleWithTarget(droneEntity, mineableState)) {
    resetDroneToIdle(droneEntity, controllerEntity, {
      scene,
      stopMovement: Boolean(controllerEntity),
    });
    return;
  }
  miningState.snapshot = snapshot;

  const orbitDistance = Math.max(
    MIN_ORBIT_DISTANCE_METERS,
    toNumber(snapshot.orbitDistanceMeters, MIN_ORBIT_DISTANCE_METERS),
  );
  const maxRange = Math.max(
    orbitDistance,
    toNumber(snapshot.maxRangeMeters, orbitDistance),
  );
  const surfaceDistance = getEntitySurfaceDistance(
    droneEntity,
    targetEntity,
    scene,
    now,
    "drone-mining-tick",
  );
  const beforeState = captureDroneClientState(droneEntity);

  copyControllerIdentity(droneEntity, controllerEntity);
  droneEntity.targetID = targetEntity.itemID;
  if (surfaceDistance > maxRange + 1) {
    syncDronePursuitBehavior(scene, droneEntity, targetEntity, orbitDistance);
    droneEntity.activityState = STATE_APPROACHING;
    clearDroneMiningCycle(miningState);
    persistAndNotifyDroneState(droneEntity, beforeState);
    return;
  }

  syncDroneOrbitBehavior(scene, droneEntity, targetEntity, orbitDistance);
  droneEntity.activityState = STATE_MINING;
  if (
    toNumber(miningState.cycleStartedAtMs, 0) <= 0 ||
    toNumber(miningState.nextCycleAtMs, 0) <= 0
  ) {
    beginDroneMiningCycle(miningState, snapshot, now);
  }
  persistAndNotifyDroneState(droneEntity, beforeState);
  emitDroneMiningCycleFx(
    scene,
    droneEntity,
    targetEntity,
    snapshot,
    miningState,
    now,
  );

  if (toNumber(miningState.nextCycleAtMs, 0) > now) {
    return;
  }

  const destination = resolveDroneMiningDestination(
    controllerEntity,
    mineableState.yieldTypeID,
    mineableState.yieldKind,
  );
  const miningAmountM3 = Math.max(0, toNumber(snapshot.miningAmountM3, 0));
  const unitVolume = Math.max(0.000001, toNumber(mineableState.unitVolume, 1));
  // A mining drone can only deliver whole units of ore, so the destination hold
  // is "full" the moment it cannot accept even one unit. Mirror the ship-side
  // mining laser (services/mining/miningRuntime): EVE cancels a cycle's progress
  // when "the ship has no more room for the ore by the time they return", and
  // the drone must idle here rather than keep mining. Testing only
  // availableVolume <= 0 missed the common near-full case: when a sub-unit
  // sliver of space was left, each cycle's fractional yield rounded back down to
  // zero and the drone restarted the cycle forever instead of stopping.
  const maximumTransferredQuantity = destination
    ? Math.max(0, Math.floor(destination.availableVolume / unitVolume))
    : 0;
  if (!destination || maximumTransferredQuantity <= 0 || miningAmountM3 <= 0) {
    resetDroneToIdle(droneEntity, controllerEntity, {
      scene,
      stopMovement: true,
    });
    return;
  }

  const quantityVolumeAvailable =
    Math.max(0, toInt(mineableState.remainingQuantity, 0)) * unitVolume;
  const availableTransferVolume = maximumTransferredQuantity * unitVolume;
  const clampFactor = Math.min(
    1,
    quantityVolumeAvailable / miningAmountM3,
    availableTransferVolume / miningAmountM3,
  );
  if (clampFactor <= 0) {
    resetDroneToIdle(droneEntity, controllerEntity, {
      scene,
      stopMovement: true,
    });
    return;
  }

  const miningResult = computeMiningResult({
    clampFactor,
    volume: miningAmountM3,
    unitVolume,
    asteroidQuantity: mineableState.remainingQuantity,
    wasteVolumeMultiplier: toNumber(snapshot.wasteVolumeMultiplier, 0),
    wasteProbability: toNumber(snapshot.wasteProbability, 0),
    // Mining drones carry no miningCritChance / miningCritBonusYield rows in the
    // SDE, so there is nothing to read for the critical half; leaving it at zero
    // keeps `criticalHitQuantity` out of the transferred total, which the cargo
    // clamp below assumes.
    critQuantityMultiplier: 0,
    critProbability: 0,
    efficiency: 1,
  });
  // Never deliver past the room actually left in the hold; whole-unit rounding
  // can otherwise overshoot a near-full bay by a unit.
  miningResult.normalQuantity = Math.min(
    miningResult.normalQuantity,
    maximumTransferredQuantity,
  );
  const transferredQuantity = miningResult.getTotalTransferredQuantity();
  const yieldTypeRecord = resolveItemByTypeID(toInt(mineableState.yieldTypeID, 0)) || null;
  // Yield and residue round independently, so a small cycle can waste a unit
  // even when no whole unit is transferred. Settle that residue normally.
  if (!yieldTypeRecord || (transferredQuantity <= 0 && miningResult.wastedQuantity <= 0)) {
    beginDroneMiningCycle(miningState, snapshot, now);
    return;
  }

  const controllerSession = resolveDroneControllerSession(droneEntity, controllerEntity);
  let missionMiningDelta = null;
  if (transferredQuantity > 0 || (!missionRock && shouldPersistMineableState(targetEntity))) {
    let grantResult;
    try {
      grantResult = missionRock
        ? missionSettlement.extract(scene, controllerEntity, targetEntity, mineableState, {
          transferredQuantity, normalQuantity: miningResult.normalQuantity, wastedQuantity: miningResult.wastedQuantity,
          criticalHitQuantity: 0, moduleID: droneEntity.itemID,
          cycleBoundaryMs: Number(miningState.nextCycleAtMs), flagID: destination.flagID,
        })
        : shouldPersistMineableState(targetEntity)
        ? require("../mining/miningCargoCommits").extractPlayer({ scene, entity: controllerEntity,
            target: targetEntity, state: mineableState, moduleID: droneEntity.itemID,
            cycleMs: Number(miningState.nextCycleAtMs), transferred: transferredQuantity,
            mined: miningResult.normalQuantity, wasted: miningResult.wastedQuantity,
            player: { characterID: destination.storageSnapshot.characterID, flagID: destination.flagID } })
        : grantItemToCharacterLocation(
          destination.storageSnapshot.characterID,
          destination.storageSnapshot.shipID,
          destination.flagID,
          yieldTypeRecord,
          transferredQuantity,
        );
    } catch (error) {
      if (!missionRock) throw error;
      grantResult = { success: false, errorMsg: error.message };
    }
    if (!grantResult || grantResult.success !== true) {
      resetDroneToIdle(droneEntity, controllerEntity, {
        scene,
        stopMovement: true,
      });
      return;
    }
    if (grantResult.duplicate) {
      beginDroneMiningCycle(miningState, snapshot, now);
      persistDroneEntityState(droneEntity);
      return;
    }
    missionMiningDelta = grantResult.data.committedMiningDelta || null;
    syncDroneInventoryChangesToSession(controllerSession, grantResult.data && grantResult.data.changes);
  }

  const pseudoModuleItem = buildDronePseudoModuleItem(droneEntity);
  const deltaResult = applyMiningDelta(
    scene,
    targetEntity,
    miningResult.normalQuantity,
    miningResult.wastedQuantity,
    {
      broadcast: true,
      nowMs: now,
      sourceDroneID: droneEntity.itemID,
      sourceEntity: controllerEntity,
      moduleItem: pseudoModuleItem,
      quantityAdded: transferredQuantity,
      amountWasted: miningResult.wastedQuantity,
      moduleItemID: droneEntity.itemID,
      moduleTypeID: droneEntity.typeID,
      moduleGroupID: droneEntity.groupID,
      committedCargoDelta: missionMiningDelta,
    },
  );
  if (!deltaResult || deltaResult.success !== true) {
    resetDroneToIdle(droneEntity, controllerEntity, {
      scene,
      stopMovement: true,
    });
    return;
  }

  const ledgerCharacterID = toInt(
    destination.storageSnapshot && destination.storageSnapshot.characterID,
    resolveDroneControllerOwnerCharacterID(controllerEntity, droneEntity),
  );
  if (ledgerCharacterID > 0) {
    const observerContext = resolveDroneMiningLedgerObserverContext(scene, targetEntity);
    lazyRequire("../mining/miningLedgerState").recordMiningLedgerEvent({
      characterID: ledgerCharacterID,
      corporationID: toInt(
        controllerSession && (controllerSession.corporationID || controllerSession.corpid),
        toInt(controllerEntity && controllerEntity.corporationID, 0),
      ),
      solarSystemID: toInt(
        scene && (scene.systemID || scene.solarSystemID),
        toInt(controllerEntity && controllerEntity.systemID, 0),
      ),
      typeID: mineableState.yieldTypeID,
      quantity: transferredQuantity,
      quantityWasted: miningResult.wastedQuantity,
      quantityCritical: miningResult.criticalHitQuantity,
      shipTypeID: toInt(controllerEntity && controllerEntity.typeID, 0),
      moduleTypeID: toInt(droneEntity && droneEntity.typeID, 0),
      observerItemID: observerContext.observerItemID,
      observerItemName: observerContext.observerItemName,
      yieldKind: mineableState.yieldKind,
      eventDateMs: now,
    });
  }

  if (
    deltaResult.data &&
    deltaResult.data.depleted === true
  ) {
    // Mining modules surface this named UserError through their terminal
    // OnGodmaShipEffect. Drones have no module effect to stop, so send the
    // same client message explicitly; it drives Aura's depletion voice cue.
    notifyMiningDroneAsteroidDepleted(droneEntity, controllerEntity);
    resetDroneToIdle(droneEntity, controllerEntity, {
      scene,
      stopMovement: true,
    });
    return;
  }

  beginDroneMiningCycle(miningState, snapshot, now);
  emitDroneMiningCycleFx(
    scene,
    droneEntity,
    targetEntity,
    snapshot,
    miningState,
    now,
  );
  persistDroneEntityState(droneEntity);
}

function getCarriedDroneSalvage(droneEntity) {
  return listContainerItems(null, droneEntity.itemID, ITEM_FLAGS.CARGO_HOLD);
}

function depositDroneSalvage(scene, droneEntity, controllerEntity, now) {
  const cargo = getCarriedDroneSalvage(droneEntity);
  if (cargo.length === 0) return true;
  if (getEntitySurfaceDistance(droneEntity, controllerEntity, scene, now,
    "drone-salvage-delivery") > DRONE_BAY_SCOOP_DISTANCE_METERS) return false;
  const storage = resolveShipStorageSnapshotForDrone(controllerEntity);
  const volume = cargo.reduce((sum, item) => sum +
    toNumber(item.volume, 0) * Math.max(1, toInt(item.stacksize ?? item.quantity, 1)), 0);
  if (!storage || volume > getAvailableDroneStorageVolume(storage, ITEM_FLAGS.CARGO_HOLD) + 1e-6) {
    return false;
  }
  const session = resolveDroneControllerSession(droneEntity, controllerEntity);
  for (const item of cargo) {
    const ownerID = toInt(item.ownerID, 0);
    const result = itemCustody.transfer({
      items: { itemID: item.itemID },
      from: itemCustody.custodyRef.container(ownerID, droneEntity.itemID, ITEM_FLAGS.CARGO_HOLD),
      to: itemCustody.custodyRef.shipBay(ownerID, storage.shipID, ITEM_FLAGS.CARGO_HOLD),
      reason: itemCustody.CUSTODY_REASON.DRONE_SALVAGE_DELIVER,
      actor: toInt(session && session.characterID, 0) || ownerID,
      idempotencyKey: `drone-salvage-deliver:${droneEntity.itemID}:${item.itemID}`,
    });
    if (!result.success) return false;
    // Each successful move is durable. A later failed move leaves only the
    // remaining rows on the drone, so retrying cannot duplicate a delivery.
    for (const change of (result.data && result.data.changes) || []) {
      lazyRequire("../character/characterState").emitItemsChangedForSession(
        session, change.item, change.previousData || change.previousState || {},
        { locationContext: ["Ship", storage.shipID, "ShipCargo"] },
      );
    }
  }
  return true;
}

// Salvage a drone cannot hand over goes into a cargo container where the drone
// is. The container belongs to whoever owns the salvage, which is not the ship's
// owner when another pilot scoops an abandoned drone.
function jettisonDroneSalvage(scene, droneEntity, now, launcherID = 0) {
  const cargo = getCarriedDroneSalvage(droneEntity);
  if (cargo.length === 0) return true;
  const characterID = toInt(cargo[0].ownerID, 0) || toInt(droneEntity.ownerID, 0);
  const systemID = toInt(scene && scene.systemID, 0);
  const containerLookup = resolveItemByName(DRONE_SALVAGE_JETTISON_CONTAINER_NAME);
  if (characterID <= 0 || systemID <= 0 ||
      !containerLookup || !containerLookup.success || !containerLookup.match) {
    return false;
  }
  const nowMs = toNumber(now, Date.now());
  const createResult = createSpaceItemForCharacter(characterID, systemID, containerLookup.match, {
    ...buildChildEntityScopeMetadata(droneEntity),
    position: { ...droneEntity.position },
    velocity: { x: 0, y: 0, z: 0 },
    direction: { ...(droneEntity.direction || { x: 1, y: 0, z: 0 }) },
    mode: "STOP",
    speedFraction: 0,
    createdAtMs: nowMs,
    expiresAtMs: nowMs + DRONE_SALVAGE_JETTISON_LIFETIME_MS,
    launcherID: toInt(launcherID, 0) || null,
  });
  if (!createResult.success || !createResult.data) return false;
  const containerID = toInt(createResult.data.itemID, 0);
  const spawnResult = getRuntime().spawnDynamicInventoryEntity(
    scene.sceneDescriptor || scene.systemID,
    containerID,
    {
      broadcast: true,
      broadcastOptions: { freshAcquire: true },
      sceneDescriptor: scene.sceneDescriptor || undefined,
    },
  );
  if (!spawnResult || spawnResult.success !== true) {
    // A container nobody can see would hide the salvage. Keep it on the drone.
    removeInventoryItem(containerID, { removeContents: true });
    return false;
  }
  for (const item of cargo) {
    const ownerID = toInt(item.ownerID, 0);
    const result = itemCustody.transfer({
      items: { itemID: item.itemID },
      from: itemCustody.custodyRef.container(ownerID, droneEntity.itemID, ITEM_FLAGS.CARGO_HOLD),
      to: itemCustody.custodyRef.container(ownerID, containerID, ITEM_FLAGS.HANGAR),
      reason: itemCustody.CUSTODY_REASON.DRONE_SALVAGE_JETTISON,
      actor: characterID,
      idempotencyKey: `drone-salvage-jettison:${containerID}:${item.itemID}`,
    });
    // Rows that fail to move stay on the drone, and the caller keeps it out.
    if (!result.success) return false;
  }
  return true;
}

// Every way into a bay ends in recallDronesToShipBay: a recall order, the
// recall on disconnect, and a scoop to the drone bay or the cargo hold. Salvage
// the drone still holds is unloaded there first, into the ship's hold when the
// salvage is the ship owner's and it fits, otherwise into a container in space.
// A drone must never go into a bay with salvage rows still inside it.
function unloadDroneSalvageBeforeRecall(scene, droneEntity, shipEntity, shipOwnerID, now) {
  const cargo = getCarriedDroneSalvage(droneEntity);
  if (cargo.length === 0) return true;
  const ownSalvage = cargo.every((item) => toInt(item.ownerID, 0) === toInt(shipOwnerID, 0));
  if (shipEntity && ownSalvage &&
      depositDroneSalvage(scene, droneEntity, shipEntity, now)) {
    return true;
  }
  return jettisonDroneSalvage(scene, droneEntity, now, toInt(shipEntity && shipEntity.itemID, 0));
}

function returnDroneSalvage(scene, droneEntity, controllerEntity, now) {
  const beforeState = captureDroneClientState(droneEntity);
  droneEntity.targetID = controllerEntity.itemID;
  droneEntity.activityState = STATE_DEPARTING;
  syncDronePursuitBehavior(scene, droneEntity, controllerEntity,
    DRONE_BAY_RETURN_APPROACH_DISTANCE_METERS, {
      broadcast: true, controllerEntity, forceFullSpeed: true,
      surfaceDistanceMeters: getEntitySurfaceDistance(
        droneEntity, controllerEntity, scene, now, "drone-salvage-return"),
    });
  persistAndNotifyDroneState(droneEntity, beforeState);
}

function selectNextDroneSalvageTarget(scene, droneEntity, controllerEntity) {
  const session = resolveDroneControllerSession(droneEntity, controllerEntity);
  const characterID = resolveDroneControllerOwnerCharacterID(controllerEntity, droneEntity);
  const targetEntity = resolveAutomaticSalvageTarget(
    scene, droneEntity, controllerEntity, characterID, null, session,
  );
  if (targetEntity) {
    return assignDroneSalvageTask({
      scene, session, droneEntity, shipEntity: controllerEntity,
      shipRecord: findItemById(controllerEntity.itemID), characterID, targetEntity,
    });
  }
  resetDroneToIdle(droneEntity, controllerEntity, { scene, stopMovement: true });
  return null;
}

function tickDroneSalvage(scene, droneEntity, controllerEntity, now) {
  if (controllerEntity && getCarriedDroneSalvage(droneEntity).length > 0) {
    if (!depositDroneSalvage(scene, droneEntity, controllerEntity, now)) {
      returnDroneSalvage(scene, droneEntity, controllerEntity, now);
      return;
    }
    selectNextDroneSalvageTarget(scene, droneEntity, controllerEntity);
    return;
  }
  const salvageState =
    droneEntity &&
    droneEntity.droneSalvage &&
    typeof droneEntity.droneSalvage === "object"
      ? droneEntity.droneSalvage
      : null;
  const targetID = toInt(
    salvageState && salvageState.targetID,
    toInt(droneEntity && droneEntity.targetID, 0),
  );
  const targetEntity = targetID > 0 ? scene.getEntityByID(targetID) : null;
  if (salvageState && controllerEntity && !salvagerRuntime.isSalvageableTarget(targetEntity)) {
    selectNextDroneSalvageTarget(scene, droneEntity, controllerEntity);
    return;
  }
  if (
    !salvageState ||
    !controllerEntity ||
    !targetEntity ||
    !salvagerRuntime.isSalvageableTarget(targetEntity) ||
    !canPlayerCompanionActOnTarget(
      scene,
      null,
      droneEntity,
      controllerEntity,
      targetEntity,
    )
  ) {
    resetDroneToIdle(droneEntity, controllerEntity, {
      scene,
      stopMovement: Boolean(controllerEntity),
    });
    return;
  }

  const snapshot =
    resolveDroneSalvageSnapshot(droneEntity, controllerEntity) ||
    salvageState.snapshot ||
    null;
  if (!snapshot) {
    resetDroneToIdle(droneEntity, controllerEntity, {
      scene,
      stopMovement: Boolean(controllerEntity),
    });
    return;
  }
  salvageState.snapshot = snapshot;
  salvageState.chanceSnapshot = salvagerRuntime.buildSalvageChanceSnapshot(
    targetEntity,
    snapshot.accessBonusPercent,
  );

  const orbitDistance = Math.max(
    MIN_ORBIT_DISTANCE_METERS,
    toNumber(snapshot.orbitDistanceMeters, MIN_ORBIT_DISTANCE_METERS),
  );
  const maxRange = Math.max(
    orbitDistance,
    toNumber(snapshot.maxRangeMeters, orbitDistance),
  );
  const surfaceDistance = getEntitySurfaceDistance(
    droneEntity,
    targetEntity,
    scene,
    now,
    "drone-salvage-tick",
  );
  const beforeState = captureDroneClientState(droneEntity);

  copyControllerIdentity(droneEntity, controllerEntity);
  droneEntity.targetID = targetEntity.itemID;
  if (surfaceDistance > maxRange + 1) {
    syncDronePursuitBehavior(scene, droneEntity, targetEntity, orbitDistance);
    droneEntity.activityState = STATE_APPROACHING;
    persistAndNotifyDroneState(droneEntity, beforeState);
    return;
  }

  syncDroneOrbitBehavior(scene, droneEntity, targetEntity, orbitDistance);
  droneEntity.activityState = STATE_SALVAGING;
  persistAndNotifyDroneState(droneEntity, beforeState);

  if (toNumber(salvageState.nextCycleAtMs, 0) > now) {
    return;
  }

  const controllerSession = resolveDroneControllerSession(droneEntity, controllerEntity);
  const controllerCharacterID = toInt(
    (
      controllerSession &&
      (controllerSession.characterID || controllerSession.charid)
    ) ||
      controllerEntity.pilotCharacterID ||
      controllerEntity.characterID ||
      controllerEntity.ownerID,
    0,
  );
  const controllerShipItem =
    findItemById(toInt(controllerEntity && controllerEntity.itemID, 0)) || {
      itemID: toInt(controllerEntity && controllerEntity.itemID, 0),
      typeID: toInt(controllerEntity && controllerEntity.typeID, 0),
      ownerID: controllerCharacterID,
    };
  const cycleResult = salvagerRuntime.executeSalvagerCycle({
    scene,
    entity: droneEntity,
    effectState: {
      moduleID: toInt(droneEntity && droneEntity.itemID, 0),
      moduleFlagID: 0,
      typeID: toInt(droneEntity && droneEntity.typeID, 0),
      targetID,
      salvagerRangeMeters: snapshot.maxRangeMeters,
      salvageChancePercent: salvageState.chanceSnapshot.chancePercent,
    },
    nowMs: now,
    callbacks: {
      isEntityLockedTarget: () => true,
      getEntitySurfaceDistance(sourceEntity, externalTargetEntity) {
        return getEntitySurfaceDistance(
          sourceEntity,
          externalTargetEntity,
          scene,
          now,
          "drone-salvager-cycle",
        );
      },
      resolveCharacterID: () => controllerCharacterID,
      getEntityRuntimeShipItem: () => controllerShipItem,
      getEntityRuntimeFittedItems: () => controllerEntity.fittedItems || [],
      getEntityRuntimeSkillMap: () => controllerEntity.skillMap || new Map(),
      resolveSession: () => controllerSession,
      suppressSalvageMessages: true,
      salvageRewardLocationID: droneEntity.itemID,
      syncInventoryChangesToSession: syncDroneInventoryChangesToSession,
      spawnInventoryBackedEntity(itemRecord, options = {}) {
        return getRuntime().spawnDynamicInventoryEntity(
          scene.sceneDescriptor || scene.systemID,
          itemRecord.itemID,
          {
            ...options,
            sceneDescriptor: scene.sceneDescriptor || undefined,
          },
        );
      },
      onWreckSalvaged(event = {}) {
        try {
          lazyRequire("../achievement/achievementRuntime").recordSalvage(
            event.characterID || controllerCharacterID,
            event.targetID,
          );
        } catch (error) {
          log.warn(
            `[Achievements] Failed to record drone salvage ` +
              `wreck=${toInt(event && event.targetID, 0)}: ${error.message}`,
          );
        }
      },
      random() {
        return scene && typeof scene.__salvageRandom === "function"
          ? scene.__salvageRandom()
          : Math.random();
      },
    },
  });

  if (snapshot.effectGUID) {
    scene.broadcastSpecialFx(
      droneEntity.itemID,
      snapshot.effectGUID,
      {
        moduleID: droneEntity.itemID,
        moduleTypeID: droneEntity.typeID,
        targetID: targetEntity.itemID,
        isOffensive: false,
        start: true,
        active: false,
        duration: snapshot.durationMs,
        repeat: 1,
      },
      droneEntity,
    );
  }

  if (cycleResult.data && cycleResult.data.salvaged === true) {
    if (getCarriedDroneSalvage(droneEntity).length > 0) {
      returnDroneSalvage(scene, droneEntity, controllerEntity, now);
    } else {
      selectNextDroneSalvageTarget(scene, droneEntity, controllerEntity);
    }
    return;
  }
  if (!cycleResult.success) {
    resetDroneToIdle(droneEntity, controllerEntity, {
      scene,
      stopMovement: true,
    });
    return;
  }

  salvageState.nextCycleAtMs = now + Math.max(1, toNumber(snapshot.durationMs, 1000));
  persistDroneEntityState(droneEntity);
}

function tickDroneRepair(scene, droneEntity, controllerEntity, now) {
  const repairState =
    droneEntity &&
    droneEntity.droneRepair &&
    typeof droneEntity.droneRepair === "object"
      ? droneEntity.droneRepair
      : null;
  const targetID = toInt(
    repairState && repairState.targetID,
    toInt(droneEntity && droneEntity.targetID, 0),
  );
  const targetEntity = targetID > 0 ? scene.getEntityByID(targetID) : null;
  if (
    !repairState ||
    !controllerEntity ||
    !targetEntity ||
    targetEntity.kind !== "ship" ||
    !hasDamageableHealth(targetEntity) ||
    !isFriendlyRepairTarget(controllerEntity, targetEntity) ||
    !canPlayerCompanionActOnTarget(
      scene,
      null,
      droneEntity,
      controllerEntity,
      targetEntity,
    )
  ) {
    resetDroneToIdle(droneEntity, controllerEntity, {
      scene,
      stopMovement: Boolean(controllerEntity),
    });
    return;
  }

  const snapshot =
    resolveDroneRepairSnapshot(droneEntity, controllerEntity) ||
    repairState.snapshot ||
    null;
  if (!snapshot) {
    resetDroneToIdle(droneEntity, controllerEntity, {
      scene,
      stopMovement: Boolean(controllerEntity),
    });
    return;
  }
  repairState.snapshot = snapshot;

  const ranges = resolveDroneEngagementRanges(snapshot);
  const surfaceDistance = getEntitySurfaceDistance(
    droneEntity,
    targetEntity,
    scene,
    now,
    "drone-repair-tick",
  );
  const beforeState = captureDroneClientState(droneEntity);
  copyControllerIdentity(droneEntity, controllerEntity);
  droneEntity.targetID = targetEntity.itemID;
  if (surfaceDistance > ranges.engagementRange + 1) {
    syncDronePursuitBehavior(
      scene,
      droneEntity,
      targetEntity,
      ranges.movementRange,
    );
    droneEntity.activityState =
      surfaceDistance > ranges.chaseRange + 1
        ? STATE_PURSUIT
        : STATE_APPROACHING;
    persistAndNotifyDroneState(droneEntity, beforeState);
    return;
  }

  if (
    surfaceDistance > ranges.movementRange + 1 ||
    !shouldDroneOrbitTarget(targetEntity)
  ) {
    syncDronePursuitBehavior(
      scene,
      droneEntity,
      targetEntity,
      ranges.movementRange,
    );
  } else {
    syncDroneOrbitBehavior(
      scene,
      droneEntity,
      targetEntity,
      ranges.movementRange,
    );
  }
  droneEntity.activityState = STATE_COMBAT;
  persistAndNotifyDroneState(droneEntity, beforeState);

  if (toNumber(repairState.nextCycleAtMs, 0) > now) {
    return;
  }

  if (snapshot.effectGUID) {
    scene.broadcastSpecialFx(
      droneEntity.itemID,
      snapshot.effectGUID,
      {
        moduleID: toInt(droneEntity && droneEntity.itemID, 0),
        moduleTypeID: toInt(droneEntity && droneEntity.typeID, 0),
        targetID: targetEntity.itemID,
        isOffensive: false,
        start: true,
        active: false,
        duration: Math.max(1, toNumber(snapshot.durationMs, 1000)),
        repeat: 1,
      },
      droneEntity,
    );
  }

  const runtime = getRuntime();
  const droneInterop =
    runtime && runtime.droneInterop && typeof runtime.droneInterop === "object"
      ? runtime.droneInterop
      : {};
  const effectState = {
    moduleID: toInt(droneEntity && droneEntity.itemID, 0),
    targetID: targetEntity.itemID,
    assistanceModuleEffect: true,
    assistanceFamily: snapshot.repairFamily,
    assistanceJammingType: snapshot.repairFamily,
    assistanceMaxRangeMeters: Math.max(0, toNumber(snapshot.maxRangeMeters, 0)),
    assistanceFalloffMeters: 0,
    assistanceShieldBonusAmount: Math.max(0, toNumber(snapshot.shieldBonusAmount, 0)),
    assistanceArmorRepairAmount: Math.max(0, toNumber(snapshot.armorRepairAmount, 0)),
    assistanceHullRepairAmount: Math.max(0, toNumber(snapshot.hullRepairAmount, 0)),
  };
  const cycleResult = assistanceModuleRuntime.executeAssistanceModuleCycle({
    scene,
    session: resolveDroneControllerSession(droneEntity, controllerEntity),
    entity: droneEntity,
    effectState,
    nowMs: now,
    callbacks: {
      isEntityLockedTarget: () => true,
      getEntitySurfaceDistance(sourceEntity, externalTargetEntity) {
        return getEntitySurfaceDistance(
          sourceEntity,
          externalTargetEntity,
          scene,
          now,
          "drone-assistance-cycle",
        );
      },
      normalizeShipConditionState: droneInterop.normalizeShipConditionState,
      buildShipHealthTransitionResult: droneInterop.buildShipHealthTransitionResult,
      notifyShipHealthAttributesToSession: droneInterop.notifyShipHealthAttributesToSession,
      broadcastDamageStateChange: droneInterop.broadcastDamageStateChange,
      persistDynamicEntity: droneInterop.persistDynamicEntity,
    },
  });

  if (!cycleResult || cycleResult.success !== true) {
    resetDroneToIdle(droneEntity, controllerEntity, {
      scene,
      stopMovement: true,
    });
    return;
  }

  repairState.nextCycleAtMs = now + Math.max(1, toNumber(snapshot.durationMs, 1000));
  persistDroneEntityState(droneEntity);
}

// Drones stop and disconnect when their controlling ship loses control of
// them, which is when the controller leaves the drones' Grid bubble. Run at
// the start of doPreTick, with retail's follower clean-up
// (space/runtime/destinyTick.js): the exit is read from the bubbles the last
// Evolve left, and the Stop is queued and applies with the rest of the queue,
// so every Observer of the drone's bubble receives it on that tick's stamp,
// after the warp activation where StopAllFollowers sent an idle drone off
// along its velocity on Server and on every client alike. Every
// such drone, with an order or without, is then released as abandonDroneInSpace
// releases it: no controller, idle, no task, its owner kept; its owner is told
// (OnDroneStateChange with owner and controller 0, which drops it from the
// client's drone window), and the owner can reconnect to it from its grid
// (commandReconnectToDrones). Returns how many it released.
function stopDronesOfDepartedControllers(scene) {
  if (!scene || typeof scene.getGridBubbleIDForEntity !== "function") {
    return 0;
  }
  let released = 0;
  for (const droneEntity of getSceneDroneEntities(scene)) {
    const controllerEntity = resolveDroneControllerEntity(scene, droneEntity);
    if (!controllerEntity) {
      continue;
    }
    const droneBubbleID = scene.getGridBubbleIDForEntity(droneEntity);
    const controllerBubbleID = scene.getGridBubbleIDForEntity(controllerEntity);
    if (
      droneBubbleID === null ||
      droneBubbleID === undefined ||
      controllerBubbleID === null ||
      controllerBubbleID === undefined ||
      droneBubbleID === controllerBubbleID
    ) {
      continue;
    }
    // A movement change queued for the drone (its AI's last order) is
    // overridden: for one Ball the last queued order wins.
    const queued =
      typeof scene.hasQueuedMovementChange === "function" &&
      scene.hasQueuedMovementChange(droneEntity);
    if (droneEntity.mode !== "STOP" || queued) {
      scene.stopShipEntity(droneEntity, { reason: "droneControllerLeftGridBubble" });
    }
    if (abandonDroneInSpace(scene, droneEntity, { stopMovement: false })) {
      released += 1;
    }
  }
  return released;
}

// An idle drone orbits its controller: launchDronesForSession and
// resetDroneToIdle order that orbit, and nothing else re-tasks an idle drone.
// An idle drone that is not orbiting its controller while the controller is
// on its grid (in its Grid bubble) and not in warp gets that orbit again. The
// case: a warp that stays in the drones' Grid bubble. At the warp
// activation retail's StopAllFollowers sends each idle drone off
// along its velocity, as every client does; the controller never leaves the
// drones' bubble, so stopDronesOfDepartedControllers does not
// apply, and the drones flew on for good. Once the controller lands, they
// orbit it again. A drone with an order, a pilot assignment, or a movement
// change queued this tick is left alone. Returns true when it gave the order.
function returnIdleDroneToControllerOrbit(scene, droneEntity, controllerEntity) {
  if (
    !scene ||
    !droneEntity ||
    !controllerEntity ||
    droneEntity.droneCommand ||
    toInt(droneEntity.activityState, STATE_IDLE) !== STATE_IDLE ||
    getDronePilotAssignment(droneEntity) ||
    String(controllerEntity.mode || "").toUpperCase() === "WARP"
  ) {
    return false;
  }
  if (
    String(droneEntity.mode || "").toUpperCase() === "ORBIT" &&
    entityIDsEqual(droneEntity.targetEntityID, controllerEntity.itemID)
  ) {
    return false;
  }
  if (typeof scene.getGridBubbleIDForEntity === "function") {
    const droneBubbleID = scene.getGridBubbleIDForEntity(droneEntity);
    if (
      droneBubbleID === null ||
      droneBubbleID === undefined ||
      droneBubbleID !== scene.getGridBubbleIDForEntity(controllerEntity)
    ) {
      return false;
    }
  }
  if (
    typeof scene.hasQueuedMovementChange === "function" &&
    scene.hasQueuedMovementChange(droneEntity)
  ) {
    return false;
  }
  const orbitDistance = Math.max(
    MIN_ORBIT_DISTANCE_METERS,
    toNumber(droneEntity.droneHomeOrbitDistance, 0) || resolveDroneOrbitDistance(droneEntity),
  );
  return Boolean(syncDroneOrbitBehavior(
    scene,
    droneEntity,
    controllerEntity,
    orbitDistance,
    { controllerEntity },
  ));
}

function tickScene(scene, now) {
  void now;
  const droneEntities = getSceneDroneEntities(scene);
  if (droneEntities.length === 0) {
    return;
  }

  const returnBayReadyByShipID = new Map();
  beginDogmaTick();
  try {
  for (const droneEntity of droneEntities) {
    const controllerID = toInt(droneEntity.controllerID, 0);
    const controllerEntity = controllerID > 0 ? scene.getEntityByID(controllerID) : null;
    const controllerScopeMismatch = Boolean(
      controllerEntity &&
      !securityScopesExactlyMatch(
        getPlayerCompanionSecurityScope(droneEntity),
        getPlayerCompanionSecurityScope(controllerEntity, { controller: true }),
      )
    );
    if ((!controllerEntity && controllerID > 0) || controllerScopeMismatch) {
      abandonDroneInSpace(scene, droneEntity, {
        stopMovement: true,
      });
      continue;
    }

    // A recall or new order must not discard salvage already in the drone's
    // inventory. Deposit at the ship even if the original task was replaced.
    if (controllerEntity && droneEntity.droneCommand !== DRONE_COMMAND_SALVAGE &&
        getCarriedDroneSalvage(droneEntity).length > 0) {
      // Out of reach or no room: carry on with the order. A drone that ends up
      // going into a bay unloads what it still holds in recallDronesToShipBay.
      depositDroneSalvage(scene, droneEntity, controllerEntity, now);
    }

    const pilotAssignment = getDronePilotAssignment(droneEntity);
    if (pilotAssignment) {
      const assignmentContext = resolveDronePilotAssignmentContext(
        scene,
        droneEntity,
        pilotAssignment.mode,
      );
      if (!assignmentContext) {
        const assignmentDerivedCombat = Boolean(
          getDroneCombatAssignmentMode(droneEntity),
        );
        invalidateDronePilotAssignment(scene, droneEntity, controllerEntity);
        if (assignmentDerivedCombat) {
          continue;
        }
      }
    }

    if (returnIdleDroneToControllerOrbit(scene, droneEntity, controllerEntity)) {
      continue;
    }

    if (
      droneEntity.droneCommand === DRONE_COMMAND_ENGAGE &&
      controllerEntity &&
      droneEntity.droneRepair
    ) {
      tickDroneRepair(scene, droneEntity, controllerEntity, toNumber(now, Date.now()));
      continue;
    }

    if (droneEntity.droneCommand === DRONE_COMMAND_ENGAGE && controllerEntity) {
      tickDroneCombat(scene, droneEntity, controllerEntity, toNumber(now, Date.now()));
      continue;
    }

    if (droneEntity.droneCommand === DRONE_COMMAND_MINE && controllerEntity) {
      tickDroneMining(scene, droneEntity, controllerEntity, toNumber(now, Date.now()));
      continue;
    }

    if (droneEntity.droneCommand === DRONE_COMMAND_SALVAGE && controllerEntity) {
      tickDroneSalvage(scene, droneEntity, controllerEntity, toNumber(now, Date.now()));
      continue;
    }

    if (droneEntity.droneCommand === DRONE_COMMAND_RETURN_HOME && controllerEntity) {
      const orbitDistance = Math.max(
        resolveDroneOrbitDistance(droneEntity),
        toNumber(droneEntity.droneHomeOrbitDistance, 0),
      );
      if (
        getEntitySurfaceDistance(
          droneEntity,
          controllerEntity,
          scene,
          now,
          "drone-return-home",
        ) <= orbitDistance
      ) {
        syncDroneOrbitBehavior(
          scene,
          droneEntity,
          controllerEntity,
          orbitDistance,
          {
            broadcast: true,
            controllerEntity,
          },
        );
        droneEntity.activityState = STATE_IDLE;
        droneEntity.targetID = null;
        droneEntity.droneCommand = null;
        droneEntity.activityID = null;
        droneEntity.activity = null;
        persistDroneEntityState(droneEntity);
        emitDroneStateChange(droneEntity);
        emitDroneActivityChange(droneEntity, null, null);
        markSceneControlledCombatDroneIndexDirty(scene);
      }
      continue;
    }

    if (droneEntity.droneCommand === DRONE_COMMAND_RETURN_BAY && controllerEntity) {
      if (
        getEntitySurfaceDistance(
          droneEntity,
          controllerEntity,
          scene,
          now,
          "drone-return-bay",
        ) <= DRONE_BAY_SCOOP_DISTANCE_METERS
      ) {
        const shipRecord = findItemById(controllerEntity.itemID);
        if (shipRecord) {
          const shipID = toInt(shipRecord.itemID, 0);
          let readyGroup = returnBayReadyByShipID.get(shipID);
          if (!readyGroup) {
            readyGroup = {
              shipRecord,
              drones: [],
            };
            returnBayReadyByShipID.set(shipID, readyGroup);
          }
          readyGroup.drones.push(droneEntity);
        }
      }
    }
  }
  for (const readyGroup of returnBayReadyByShipID.values()) {
    recallDronesToBay(scene, readyGroup.shipRecord, readyGroup.drones);
  }
  } finally {
    endDogmaTick();
  }
}

module.exports = {
  DRONE_CATEGORY_ID,
  DRONE_COMMAND_RETURN_BAY,
  DRONE_COMMAND_RETURN_HOME,
  DRONE_COMMAND_ENGAGE,
  DRONE_COMMAND_MINE,
  DRONE_COMMAND_SALVAGE,
  DRONE_ACTIVITY_ASSIST,
  DRONE_ACTIVITY_GUARD,
  STATE_IDLE,
  STATE_COMBAT,
  STATE_MINING,
  STATE_APPROACHING,
  STATE_DEPARTING,
  STATE_PURSUIT,
  STATE_SALVAGING,
  isDroneEntity,
  getDroneBandwidthLoad,
  getLaunchedDroneReservedBayVolume,
  resolveDroneMovementProfile,
  applyDroneOperationalEntityAttributes,
  resolveDroneOrbitDistance,
  hydrateDroneEntityFromItem,
  buildDroneStateRows,
  buildDroneStateNotificationTuple,
  emitDroneActivityChange,
  handleDroneDestroyed,
  noteAssistedPilotOffensiveAction,
  noteIncomingAggression,
  normalizeDroneIDList,
  normalizeLaunchRequests,
  launchDronesForSession,
  commandAssist,
  commandGuard,
  commandEngage,
  commandMineRepeatedly,
  commandSalvage,
  commandReturnHome,
  commandReturnBay,
  commandAbandonDrone,
  commandReconnectToDrones,
  handleControllerLost,
  scoopDrone,
  scoopDroneToCargo,
  idleMiningDronesTargeting,
  tickScene,
  stopDronesOfDepartedControllers,
  _testing: {
    buildDroneAbyssalOwnershipCustomInfo,
    canPlayerCompanionActOnTarget,
    getDroneAssistAssignment,
    getDroneGuardAssignment,
    getDronePilotAssignment,
    invalidateDronePilotAssignment,
    isNativeNpcDroneAssignmentTarget,
    noteGuardedPilotIncomingAggression,
    resetDroneToIdle,
    resolveDronePilotAssignmentContext,
    clearDroneWindowSettleForSession,
    recallDronesToShipBay,
    resolveAbyssalPlayerCompanionInstanceID,
    serializePlayerCompanionScopeMetadata,
    resolveRuntimeSceneForSession,
    resolveDroneFastPropulsionExitDistance,
    droneCruiseCanHoldStation,
    shouldUseFastDronePropulsion,
  },
};
