"use strict";

const path = require("path");

const {
  buildChildEntityScopeMetadata,
  canEntitiesInteractLocally,
} = require(path.join(
  __dirname,
  "../../space/destiny/identity/interactionScope.js",
));
const {
  resolveAbyssalDeployableItemRestriction,
} = require(path.join(__dirname, "../_shared/abyssalDeployablePolicy"));

const log = require(path.join(__dirname, "../../utils/logger"));
const {
  ITEM_FLAGS,
  createSpaceItemForOwner,
  getItemMetadata,
  moveItemToLocation,
  transferItemToOwnerLocation,
  updateInventoryItem,
} = require(path.join(__dirname, "../inventory/itemStore"));
const {
  findItemById,
  listContainerItems,
  listSystemSpaceItems,
} = require(path.join(
  __dirname,
  "../inventory/simulationInventoryProjection",
));
const itemCustody = require(path.join(__dirname, "../inventory/itemCustody"));
const mobileItemCustody = require(path.join(__dirname, "../inventory/mobileItemCustody"));
const {
  LOOT_CUSTOM_INFO_KEY,
  buildSpaceLootRightsSnapshot,
  buildSpaceLootSourceFromItem,
  resolveCharacterSpaceLootContext,
  sessionHasSpaceLootRight,
} = require(path.join(__dirname, "../_shared/spaceLootEntitlement"));
const {
  buildShipResourceState,
  getTypeAttributeValue,
} = require(path.join(__dirname, "../fitting/liveFittingState"));
const {
  resolveItemByName,
} = require(path.join(__dirname, "../inventory/itemTypeRegistry"));
const worldData = require(path.join(__dirname, "../../space/worldData"));
const {
  captureMobileTractorUnitPresentation,
  applyMobileTractorUnitTractorStartCommand,
} = require(path.join(
  __dirname,
  "../../space/destiny/commands/mobileTractorUnit.js",
));
// Starting and stopping a pull is movement: it waits in the Movement queue and
// applies at the start of the next Destiny tick.
const {
  queueOrApplyMovementChange,
} = require(path.join(
  __dirname,
  "../../space/destiny/commands/movementQueueing.js",
));
const {
  applyTractorStopCommand,
} = require(path.join(
  __dirname,
  "../../space/destiny/commands/tractorBeam.js",
));
const {
  TRACTOR_FOLLOW_RANGE_METERS,
} = require(path.join(
  __dirname,
  "../../space/modules/tractorBeamRuntime.js",
));
const nativeNpcStore = require(path.join(__dirname, "../../space/npc/nativeNpcStore"));
const {
  buildGodmaShipEffectEvent,
  buildModuleAttributeChangeEvent,
  sendOnMultiEventPairs,
} = require(path.join(__dirname, "../_shared/godmaMultiEvent"));

// Player structures live in structureState, required on use as worldData used to, so this
// file does not load the structure runtime and works where nothing else has loaded it.
function getStructureState() {
  return require(path.join(__dirname, "../structure/structureState"));
}

const CATEGORY_DEPLOYABLE = 22;
const CATEGORY_STATION = 3;
const CATEGORY_UPWELL_STRUCTURE = 65;
const GROUP_STARGATE = 10;
const GROUP_CONTROL_TOWER = 365;
const GROUP_MOBILE_TRACTOR_UNIT = 1250;

const DEPLOY_DISTANCE_METERS = 2_500;
const MOBILE_TRACTOR_UNIT_ACTIVATION_DELAY_MS = 10 * 1000;
const MOBILE_TRACTOR_UNIT_LIFETIME_MS = 2 * 24 * 60 * 60 * 1000;
const MOBILE_TRACTOR_UNIT_CYCLE_TIME_SECONDS = 5;
const MOBILE_TRACTOR_UNIT_DEFAULT_RANGE_METERS = 125_000;
const MOBILE_TRACTOR_UNIT_DEFAULT_MAX_TRACTOR_VELOCITY = 1_000;
const MOBILE_TRACTOR_UNIT_DEFAULT_CAPACITY = 27_000;
const MOBILE_TRACTOR_UNIT_SCOOP_RANGE_METERS = 2_500;
const MOBILE_TRACTOR_UNIT_COLLECTION_RANGE_METERS = 2_500;
const MOBILE_TRACTOR_UNIT_EJECTED_CONTAINER_DISTANCE_METERS = 275;
const MOBILE_TRACTOR_UNIT_EJECTED_CONTAINER_LIFETIME_MS = 2 * 60 * 60 * 1000;
const MOBILE_TRACTOR_UNIT_MIN_DISTANCE_FROM_OWN_GROUP_METERS = 5_000;
const MOBILE_TRACTOR_UNIT_MIN_DISTANCE_FROM_STATION_STARGATE_UPWELL_METERS = 50_000;
const MOBILE_TRACTOR_UNIT_MIN_DISTANCE_FROM_CONTROL_TOWER_METERS = 40_000;
const CARGO_CONTAINER_NAME = "Cargo Container";
const CUSTOM_INFO_KEY = "evejsMobileTractorUnit";
const MOBILE_TRACTOR_UNIT_CARGO_FLAG_ID = ITEM_FLAGS.CARGO_HOLD;
const TRACTOR_BEAM_EFFECT_GUID = "effects.TractorBeam";
const TRACTOR_BEAM_GODMA_EFFECT_ID = 2255;
const TRACTOR_TARGET_MAX_SPEED_ATTRIBUTE_ID = 37;
// One constant for both halves of the mechanic. The fitted tractor beam owns it
// (space/modules/tractorBeamRuntime.js) because the SDE gives neither the module
// nor the deployable an attribute for it; a second literal here is exactly how
// the fitted beam drifted onto maxTractorVelocity and stopped agreeing with the
// unit that has always parked wrecks correctly.
const TRACTOR_BEAM_FOLLOW_RANGE_METERS = TRACTOR_FOLLOW_RANGE_METERS;
const TRACTOR_BEAM_EFFECT_DURATION_MS = 30_000;
const TRACTOR_BEAM_EFFECT_REPEAT = 1_000;
// A target whose loot refuses to move is otherwise re-selected every cycle
// forever, because it stays the nearest target that still holds loot. After
// this many consecutive cycles that moved nothing, the unit stops choosing it
// for a while and works the rest of the field instead. Nothing is discarded:
// the loot stays in the target and the target becomes selectable again once
// the backoff lapses.
const MOBILE_TRACTOR_UNIT_TARGET_FAILURE_LIMIT = 3;
const MOBILE_TRACTOR_UNIT_TARGET_BACKOFF_MS = 5 * 60 * 1000;
// A unit only has to remember the wrecks it has already hauled in and found
// empty, and only for as long as it is deployed. The cap is a guard against
// pathological growth on a very long-lived unit, not an expiry: a grid holds
// far fewer wrecks than this.
const MOBILE_TRACTOR_UNIT_EMPTY_HAUL_MEMORY_LIMIT = 512;

const timersByTractorUnitID = new Map();
const tractorBeamStartTimes = new Map();
const lootFailuresByTractorUnitID = new Map();
const emptyHaulsByTractorUnitID = new Map();

function toInt(value, fallback = 0) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? Math.trunc(numericValue) : fallback;
}

function toReal(value, fallback = 0) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : fallback;
}

function firstFiniteReal(values, fallback = 0) {
  for (const value of values) {
    if (value === null || value === undefined) {
      continue;
    }
    const numericValue = Number(value);
    if (Number.isFinite(numericValue)) {
      return numericValue;
    }
  }
  return fallback;
}

function normalizeVector(value, fallback = { x: 0, y: 0, z: 0 }) {
  const source = value && typeof value === "object" ? value : fallback;
  return {
    x: toReal(source.x, fallback.x),
    y: toReal(source.y, fallback.y),
    z: toReal(source.z, fallback.z),
  };
}

function normalizeDirection(value, fallback = { x: 1, y: 0, z: 0 }) {
  const vector = normalizeVector(value, fallback);
  const length = Math.sqrt(vector.x * vector.x + vector.y * vector.y + vector.z * vector.z);
  if (length <= 0) {
    return { ...fallback };
  }
  return {
    x: vector.x / length,
    y: vector.y / length,
    z: vector.z / length,
  };
}

function addVectors(left, right) {
  return {
    x: toReal(left && left.x, 0) + toReal(right && right.x, 0),
    y: toReal(left && left.y, 0) + toReal(right && right.y, 0),
    z: toReal(left && left.z, 0) + toReal(right && right.z, 0),
  };
}

function scaleVector(vector, scalar) {
  const factor = toReal(scalar, 0);
  return {
    x: toReal(vector && vector.x, 0) * factor,
    y: toReal(vector && vector.y, 0) * factor,
    z: toReal(vector && vector.z, 0) * factor,
  };
}

function getVectorDistance(left, right) {
  const leftVector = normalizeVector(left);
  const rightVector = normalizeVector(right);
  const dx = leftVector.x - rightVector.x;
  const dy = leftVector.y - rightVector.y;
  const dz = leftVector.z - rightVector.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function getSpaceRuntime() {
  return require(path.join(__dirname, "../../space/runtime"));
}

function getNativeNpcWreckService() {
  return require(path.join(__dirname, "../../space/npc/nativeNpcWreckService"));
}

function getMaybeExpireEmptySpaceContainer() {
  return require(path.join(__dirname, "./jettisonRuntime")).maybeExpireEmptySpaceContainer;
}

function getEmitItemsChangedForSession() {
  const characterState = require(path.join(__dirname, "../character/characterState"));
  return characterState.emitItemsChangedForSession;
}

function syncInventoryChange(session, item, previousData, options = {}) {
  const emitItemsChangedForSession = getEmitItemsChangedForSession();
  if (typeof emitItemsChangedForSession !== "function") {
    return;
  }
  emitItemsChangedForSession(
    session,
    item,
    previousData || {},
    {
      idType: options.idType,
      locationContext: options.locationContext,
    },
  );
}

function syncChangesExceptItem(session, changes = [], excludedItemID = 0) {
  for (const change of Array.isArray(changes) ? changes : []) {
    if (!change || !change.item || toInt(change.item.itemID, 0) === excludedItemID) {
      continue;
    }
    syncInventoryChange(session, change.item, change.previousData || change.previousState || {});
  }
}

function listInterestedSessions(scene, characterIDs = []) {
  if (!scene || !scene.sessions) {
    return [];
  }
  const interestedCharacterIDs = new Set(
    characterIDs.map((characterID) => toInt(characterID, 0)).filter((characterID) => characterID > 0),
  );
  if (interestedCharacterIDs.size === 0) {
    return [];
  }
  return [...scene.sessions.values()].filter((session) => (
    session && interestedCharacterIDs.has(toInt(session.characterID || session.charid, 0))
  ));
}

function syncInventoryChangesToInterestedSessions(scene, characterIDs = [], changes = [], options = {}) {
  if (!scene || !scene.sessions || !Array.isArray(changes) || changes.length === 0) {
    return;
  }
  for (const session of listInterestedSessions(scene, characterIDs)) {
    for (const change of changes) {
      if (!change || !change.item) {
        continue;
      }
      syncInventoryChange(
        session,
        change.item,
        change.previousData || change.previousState || {},
        options,
      );
    }
  }
}

function getSessionContext(session, options = {}) {
  const characterID = toInt(session && (session.characterID || session.charid), 0);
  const corporationID = toInt(
    session && (session.corporationID || session.corpid),
    characterID,
  );
  const behalfOwnerID = toInt(options.ownerID, 0);
  const shipID = toInt(
    session && session._space && session._space.shipID,
    toInt(session && (session.shipID || session.shipid || session.activeShipID), 0),
  );
  const systemID = toInt(
    session && session._space && session._space.systemID,
    toInt(session && (session.solarsystemid2 || session.solarsystemid), 0),
  );

  return {
    characterID,
    corporationID,
    ownerID: behalfOwnerID || characterID,
    shipID,
    systemID,
  };
}

function isMobileTractorUnitType(typeIDOrItem) {
  if (typeIDOrItem && typeof typeIDOrItem === "object") {
    if (
      toInt(typeIDOrItem.categoryID, 0) === CATEGORY_DEPLOYABLE &&
      toInt(typeIDOrItem.groupID, 0) === GROUP_MOBILE_TRACTOR_UNIT
    ) {
      return true;
    }
    return isMobileTractorUnitType(toInt(typeIDOrItem.typeID, 0));
  }

  const metadata = getItemMetadata(typeIDOrItem) || {};
  return (
    toInt(metadata.categoryID, 0) === CATEGORY_DEPLOYABLE &&
    toInt(metadata.groupID, 0) === GROUP_MOBILE_TRACTOR_UNIT
  );
}

function parseCustomInfo(customInfo) {
  const text = String(customInfo || "").trim();
  if (!text) {
    return {};
  }
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch (_) {
    // ignored: preserve opaque legacy customInfo values instead of discarding them.
  }
  return {
    legacyCustomInfo: text,
  };
}

function getStateFromCustomInfo(customInfo) {
  const parsed = parseCustomInfo(customInfo);
  const state = parsed && parsed[CUSTOM_INFO_KEY];
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    return null;
  }
  return {
    ownerID: toInt(state.ownerID, 0),
    deployerCharacterID: toInt(state.deployerCharacterID, 0),
    solarSystemID: toInt(state.solarSystemID, 0),
    tractorUnitID: toInt(state.tractorUnitID, 0),
    deployedAtMs: toInt(state.deployedAtMs, 0),
    activateAtMs: toInt(state.activateAtMs, 0),
    activatedAtMs: toInt(state.activatedAtMs, 0),
    expiresAtMs: toInt(state.expiresAtMs, 0),
    active: state.active === true,
    deactivatedAtMs: toInt(state.deactivatedAtMs, 0),
    nextCycleAtMs: toInt(state.nextCycleAtMs, 0),
    lastCycleAtMs: toInt(state.lastCycleAtMs, 0),
    lastLootMoveAtMs: toInt(state.lastLootMoveAtMs, 0),
    lastTractorTargetID: toInt(state.lastTractorTargetID, 0),
    tractorTargetID: toInt(state.tractorTargetID, 0),
    tractorStartedAtMs: toInt(state.tractorStartedAtMs, 0),
    movedItemCount: toInt(state.movedItemCount, 0),
    rangeMeters: toReal(state.rangeMeters, MOBILE_TRACTOR_UNIT_DEFAULT_RANGE_METERS),
    cycleTimeSeconds: toReal(state.cycleTimeSeconds, MOBILE_TRACTOR_UNIT_CYCLE_TIME_SECONDS),
    maxTractorVelocity: toReal(
      state.maxTractorVelocity,
      MOBILE_TRACTOR_UNIT_DEFAULT_MAX_TRACTOR_VELOCITY,
    ),
    holdCapacity: toReal(state.holdCapacity, MOBILE_TRACTOR_UNIT_DEFAULT_CAPACITY),
  };
}

function getMobileTractorUnitStateFromItem(item) {
  if (!item || !isMobileTractorUnitType(item)) {
    return null;
  }
  const state = getStateFromCustomInfo(item.customInfo);
  if (!state || state.tractorUnitID <= 0) {
    return null;
  }
  return state;
}

function getMobileTractorUnitTickDeadlineMs(entityOrItem) {
  if (!entityOrItem || !isMobileTractorUnitType(entityOrItem)) {
    return null;
  }

  const storedItem = findItemById(entityOrItem.itemID);
  const state = storedItem
    ? getMobileTractorUnitStateFromItem(storedItem)
    : getMobileTractorUnitStateFromItem(entityOrItem);
  if (!state) {
    return null;
  }

  const deadlines = [];
  if (state.expiresAtMs > 0) {
    deadlines.push(state.expiresAtMs);
  }
  if (state.deactivatedAtMs <= 0) {
    if (state.active === true) {
      if (state.nextCycleAtMs <= 0) {
        return 0;
      }
      deadlines.push(state.nextCycleAtMs);
    } else if (state.activateAtMs > 0) {
      deadlines.push(state.activateAtMs);
    }
  }

  return deadlines.length > 0 ? Math.min(...deadlines) : null;
}

function buildCustomInfoWithState(customInfo, state) {
  const parsed = parseCustomInfo(customInfo);
  parsed[CUSTOM_INFO_KEY] = {
    ownerID: toInt(state.ownerID, 0),
    deployerCharacterID: toInt(state.deployerCharacterID, 0),
    solarSystemID: toInt(state.solarSystemID, 0),
    tractorUnitID: toInt(state.tractorUnitID, 0),
    deployedAtMs: toInt(state.deployedAtMs, 0),
    activateAtMs: toInt(state.activateAtMs, 0),
    activatedAtMs: toInt(state.activatedAtMs, 0),
    expiresAtMs: toInt(state.expiresAtMs, 0),
    active: state.active === true,
    deactivatedAtMs: toInt(state.deactivatedAtMs, 0),
    nextCycleAtMs: toInt(state.nextCycleAtMs, 0),
    lastCycleAtMs: toInt(state.lastCycleAtMs, 0),
    lastLootMoveAtMs: toInt(state.lastLootMoveAtMs, 0),
    lastTractorTargetID: toInt(state.lastTractorTargetID, 0),
    tractorTargetID: toInt(state.tractorTargetID, 0),
    tractorStartedAtMs: toInt(state.tractorStartedAtMs, 0),
    movedItemCount: toInt(state.movedItemCount, 0),
    rangeMeters: toReal(state.rangeMeters, MOBILE_TRACTOR_UNIT_DEFAULT_RANGE_METERS),
    cycleTimeSeconds: toReal(state.cycleTimeSeconds, MOBILE_TRACTOR_UNIT_CYCLE_TIME_SECONDS),
    maxTractorVelocity: toReal(
      state.maxTractorVelocity,
      MOBILE_TRACTOR_UNIT_DEFAULT_MAX_TRACTOR_VELOCITY,
    ),
    holdCapacity: toReal(state.holdCapacity, MOBILE_TRACTOR_UNIT_DEFAULT_CAPACITY),
  };
  return JSON.stringify(parsed);
}

function buildCustomInfoWithoutState(customInfo) {
  const parsed = parseCustomInfo(customInfo);
  delete parsed[CUSTOM_INFO_KEY];
  return Object.keys(parsed).length > 0 ? JSON.stringify(parsed) : "";
}

function resolveMobileTractorUnitStats(itemOrTypeID) {
  const typeID = toInt(itemOrTypeID && itemOrTypeID.typeID ? itemOrTypeID.typeID : itemOrTypeID, 0);
  const metadata = getItemMetadata(typeID) || {};
  const maxRange = firstPositiveReal([
    getTypeAttributeValue(typeID, "maxRange"),
    getTypeAttributeValue(typeID, "maxTargetRange"),
  ], MOBILE_TRACTOR_UNIT_DEFAULT_RANGE_METERS);
  return {
    rangeMeters: maxRange,
    cycleTimeSeconds: MOBILE_TRACTOR_UNIT_CYCLE_TIME_SECONDS,
    maxTractorVelocity: firstPositiveReal([
      getTypeAttributeValue(typeID, "maxTractorVelocity"),
    ], MOBILE_TRACTOR_UNIT_DEFAULT_MAX_TRACTOR_VELOCITY),
    holdCapacity: firstPositiveReal([
      metadata.capacity,
    ], MOBILE_TRACTOR_UNIT_DEFAULT_CAPACITY),
  };
}

function getObjectItemID(source) {
  return toInt(
    source && (
      source.itemID ||
      source.entityID ||
      source.objectID ||
      source.stationID ||
      source.stargateID ||
      source.structureID
    ),
    0,
  );
}

function getObjectTypeID(source) {
  return toInt(
    source && (
      source.typeID ||
      source.stationTypeID ||
      source.entityTypeID
    ),
    0,
  );
}

function getObjectPosition(source) {
  if (!source || typeof source !== "object") {
    return null;
  }
  if (source.position && typeof source.position === "object") {
    return normalizeVector(source.position);
  }
  if (source.spaceState && source.spaceState.position) {
    return normalizeVector(source.spaceState.position);
  }
  if (
    Number.isFinite(Number(source.x)) ||
    Number.isFinite(Number(source.y)) ||
    Number.isFinite(Number(source.z))
  ) {
    return normalizeVector(source);
  }
  return null;
}

function firstPositiveReal(values, fallback = 0) {
  for (const value of values) {
    const numericValue = Number(value);
    if (Number.isFinite(numericValue) && numericValue > 0) {
      return numericValue;
    }
  }
  return Math.max(0, toReal(fallback, 0));
}

function getObjectPlacementRadius(source, metadata = null) {
  return firstPositiveReal([
    source && source.spaceRadius,
    source && source.radius,
    source && source.interactionRadius,
    metadata && metadata.radius,
  ]);
}

function resolvePlacementBlockerKind(source, explicitKind = null) {
  if (explicitKind) {
    return explicitKind;
  }
  if (isMobileTractorUnitType(source)) {
    return "mobileTractorUnit";
  }

  const typeID = getObjectTypeID(source);
  const metadata = typeID > 0 ? (getItemMetadata(typeID) || {}) : {};
  const groupID = toInt(source && source.groupID, toInt(metadata.groupID, 0));
  const categoryID = toInt(source && source.categoryID, toInt(metadata.categoryID, 0));

  if (
    groupID === GROUP_STARGATE ||
    categoryID === CATEGORY_STATION ||
    categoryID === CATEGORY_UPWELL_STRUCTURE
  ) {
    return "stationStargateUpwell";
  }
  // Control Towers only, by group. The retail deploy component names the rule
  // after groupControlTower (365) and nothing else -- see the V24.01 client at
  // packages/spacecomponents/client/components/deploy.py, which labels
  // minDistanceFromControlTower with GetGroupNameByGroup(groupControlTower).
  // Matching the whole Starbase category (23) instead swept in every POS module
  // ever anchored or spawned as scenery -- storage and assembly arrays, silos,
  // sentry batteries, jump bridges -- and each of those pushed a 40 km no-build
  // bubble that retail does not have. Dungeon and anomaly content is full of
  // them, which is how a pilot in Jita with no tower in sight got refused.
  if (groupID === GROUP_CONTROL_TOWER) {
    return "controlTower";
  }
  return null;
}

function getPlacementBlockerMinimumDistance(kind) {
  if (kind === "mobileTractorUnit") {
    return MOBILE_TRACTOR_UNIT_MIN_DISTANCE_FROM_OWN_GROUP_METERS;
  }
  if (kind === "stationStargateUpwell") {
    return MOBILE_TRACTOR_UNIT_MIN_DISTANCE_FROM_STATION_STARGATE_UPWELL_METERS;
  }
  if (kind === "controlTower") {
    return MOBILE_TRACTOR_UNIT_MIN_DISTANCE_FROM_CONTROL_TOWER_METERS;
  }
  return 0;
}

function getPlacementConflictError(kind) {
  if (kind === "mobileTractorUnit") {
    return "MOBILE_TRACTOR_UNIT_TOO_CLOSE_TO_TRACTOR_UNIT";
  }
  if (kind === "stationStargateUpwell") {
    return "MOBILE_TRACTOR_UNIT_TOO_CLOSE_TO_STATION_STARGATE_OR_UPWELL";
  }
  if (kind === "controlTower") {
    return "MOBILE_TRACTOR_UNIT_TOO_CLOSE_TO_CONTROL_TOWER";
  }
  return "MOBILE_TRACTOR_UNIT_DEPLOYMENT_BLOCKED";
}

function appendPlacementBlocker(blockers, seenKeys, source, options = {}) {
  const kind = resolvePlacementBlockerKind(source, options.kind);
  const minimumDistance = getPlacementBlockerMinimumDistance(kind);
  if (!minimumDistance) {
    return;
  }

  const itemID = getObjectItemID(source);
  if (itemID > 0 && itemID === toInt(options.sourceItemID, 0)) {
    return;
  }

  const position = getObjectPosition(source);
  if (!position) {
    return;
  }

  const typeID = getObjectTypeID(source);
  const metadata = typeID > 0 ? (getItemMetadata(typeID) || {}) : {};
  const seenKey = itemID > 0
    ? `${kind}:${itemID}`
    : `${kind}:${typeID}:${position.x}:${position.y}:${position.z}`;
  if (seenKeys.has(seenKey)) {
    return;
  }
  seenKeys.add(seenKey);

  blockers.push({
    kind,
    itemID,
    typeID,
    // The classifier prefers the object's own fields over type metadata, so
    // record what it actually read; a rejection log that quotes the type table
    // instead would describe an object nobody matched on.
    groupID: toInt(source && source.groupID, toInt(metadata.groupID, 0)),
    categoryID: toInt(source && source.categoryID, toInt(metadata.categoryID, 0)),
    name: String((source && source.itemName) || metadata.name || "unknown"),
    position,
    radius: getObjectPlacementRadius(source, metadata),
    minimumDistance,
    errorMsg: getPlacementConflictError(kind),
  });
}

function collectPlacementBlockers(session, context, options = {}) {
  const blockers = [];
  const seenKeys = new Set();
  const systemID = toInt(context && context.systemID, 0);
  if (systemID <= 0) {
    return blockers;
  }

  const interactionSource = session && context && context.shipID
    ? getSpaceRuntime().getEntity(session, context.shipID) || findItemById(context.shipID)
    : null;
  const append = (source, kind = null) => {
    if (
      interactionSource &&
      !canEntitiesInteractLocally(interactionSource, source)
    ) {
      return;
    }
    appendPlacementBlocker(
      blockers,
      seenKeys,
      source,
      {
        kind,
        sourceItemID: options.sourceItemID,
      },
    );
  };

  for (const station of worldData.getStationsForSystem(systemID)) {
    append(
      {
        ...station,
        itemID: station.stationID,
        typeID: station.stationTypeID,
      },
      "stationStargateUpwell",
    );
  }

  for (const stargate of worldData.getStargatesForSystem(systemID)) {
    append(stargate, "stationStargateUpwell");
  }

  for (const structure of getStructureState().listStructuresForSystem(systemID)) {
    append({
      ...structure,
      itemID: structure.structureID || structure.itemID,
    });
  }

  for (const item of listSystemSpaceItems(systemID)) {
    append(item);
  }

  const scene = session ? getSpaceRuntime().getSceneForSession(session) : null;
  if (scene) {
    for (const entity of Array.isArray(scene.staticEntities) ? scene.staticEntities : []) {
      append(entity);
    }
    const dynamicEntities = typeof scene.getDynamicEntities === "function"
      ? scene.getDynamicEntities()
      : scene.dynamicEntities instanceof Map
        ? [...scene.dynamicEntities.values()]
        : [];
    for (const entity of dynamicEntities) {
      append(entity);
    }
  }

  return blockers;
}

function findPlacementConflict(session, item, context, spawnState) {
  const deployPosition = getObjectPosition(spawnState);
  if (!deployPosition) {
    return {
      errorMsg: "MOBILE_TRACTOR_UNIT_DEPLOY_POSITION_UNAVAILABLE",
    };
  }

  const typeID = getObjectTypeID(item);
  const metadata = typeID > 0 ? (getItemMetadata(typeID) || {}) : {};
  const deployedRadius = getObjectPlacementRadius(item, metadata);
  const blockers = collectPlacementBlockers(session, context, {
    sourceItemID: item && item.itemID,
  });

  for (const blocker of blockers) {
    const distance = getVectorDistance(deployPosition, blocker.position);
    const surfaceDistance = distance - deployedRadius - Math.max(0, blocker.radius);
    if (surfaceDistance < blocker.minimumDistance) {
      return {
        errorMsg: blocker.errorMsg,
        blocker,
        distance,
        surfaceDistance,
      };
    }
  }

  return null;
}

// A refusal that only names the rule is unanswerable: the pilot sees nothing on
// grid and the log cannot say what the server saw. Name the offending object so
// the next report identifies itself.
function describePlacementBlocker(conflict) {
  const blocker = conflict && conflict.blocker;
  if (!blocker) {
    return "";
  }
  return (
    ` blocker=${blocker.kind}` +
    ` blockerItem=${toInt(blocker.itemID, 0)}` +
    ` blockerType=${toInt(blocker.typeID, 0)}` +
    ` blockerGroup=${toInt(blocker.groupID, 0)}` +
    ` blockerCategory=${toInt(blocker.categoryID, 0)}` +
    ` blockerName=${blocker.name || "unknown"}` +
    ` distance=${Math.round(toReal(conflict.distance, 0))}` +
    ` surfaceDistance=${Math.round(toReal(conflict.surfaceDistance, 0))}` +
    ` minimumDistance=${toInt(blocker.minimumDistance, 0)}`
  );
}

function buildDeployableSpawnState(session, context) {
  const shipEntity =
    session && context.shipID
      ? getSpaceRuntime().getEntity(session, context.shipID)
      : null;
  const position = getObjectPosition(shipEntity);
  if (!position) {
    return null;
  }
  const direction = normalizeDirection(
    shipEntity && shipEntity.direction,
    { x: 1, y: 0, z: 0 },
  );
  const deployedPosition = addVectors(
    position,
    scaleVector(direction, DEPLOY_DISTANCE_METERS),
  );

  return {
    ...buildChildEntityScopeMetadata(shipEntity),
    systemID: context.systemID,
    position: deployedPosition,
    velocity: { x: 0, y: 0, z: 0 },
    direction,
    targetPoint: deployedPosition,
    mode: "STOP",
    speedFraction: 0,
  };
}

function findLaunchedChange(changes = [], systemID, ownerID, sourceTypeID) {
  return (Array.isArray(changes) ? changes : []).find((change) => {
    const item = change && change.item;
    return Boolean(
      item &&
        toInt(item.locationID, 0) === systemID &&
        toInt(item.flagID, -1) === 0 &&
        toInt(item.ownerID, 0) === ownerID &&
        toInt(item.typeID, 0) === sourceTypeID,
    );
  }) || null;
}

function validateMobileTractorUnitLaunch(item, context) {
  if (!context.characterID || !context.ownerID || !context.shipID || !context.systemID) {
    return "INVALID_SESSION";
  }
  if (!item) {
    return "ITEM_NOT_FOUND";
  }
  if (!isMobileTractorUnitType(item)) {
    return "ITEM_NOT_MOBILE_TRACTOR_UNIT";
  }
  if (
    ![context.characterID, context.corporationID, context.ownerID].includes(toInt(item.ownerID, 0)) ||
    toInt(item.locationID, 0) !== context.shipID ||
    toInt(item.flagID, 0) !== ITEM_FLAGS.CARGO_HOLD
  ) {
    return "ITEM_NOT_IN_SHIP_CARGO";
  }
  return null;
}

function getShipCargoCapacity(characterID, shipItem) {
  if (!shipItem) {
    return 0;
  }
  const resourceState = buildShipResourceState(characterID, shipItem);
  return Math.max(0, toReal(resourceState && resourceState.cargoCapacity, 0));
}

function getShipFlagUsedVolume(ownerID, shipID, flagID, excludedItemID = 0) {
  return listContainerItems(ownerID, shipID, flagID).reduce((sum, item) => {
    if (!item || toInt(item.itemID, 0) === excludedItemID) {
      return sum;
    }
    return sum + getItemMoveVolume(item) * getItemMoveQuantity(item);
  }, 0);
}

function validateMobileTractorUnitDestinationCargo(item, context) {
  const shipItem = findItemById(context.shipID);
  const capacity = getShipCargoCapacity(context.characterID, shipItem);
  const used = getShipFlagUsedVolume(
    context.characterID,
    context.shipID,
    ITEM_FLAGS.CARGO_HOLD,
    item && item.itemID,
  );
  if (used + getItemMoveVolume(item) > capacity + 1e-7) {
    return "NOT_ENOUGH_CARGO_SPACE";
  }
  return null;
}

function validateMobileTractorUnitSpaceAccess(session, item, state, context, options = {}) {
  const rangeMeters = Math.max(
    0,
    toReal(options.rangeMeters, MOBILE_TRACTOR_UNIT_SCOOP_RANGE_METERS),
  );
  if (!context.characterID || !context.shipID || !context.systemID) {
    return "INVALID_SESSION";
  }
  if (!item) {
    return "ITEM_NOT_FOUND";
  }
  if (!isMobileTractorUnitType(item)) {
    return "ITEM_NOT_MOBILE_TRACTOR_UNIT";
  }
  if (!state || state.tractorUnitID <= 0) {
    return "MOBILE_TRACTOR_UNIT_STATE_NOT_FOUND";
  }
  if (resolveAbyssalDeployableItemRestriction(item, state)) {
    return "MOBILE_TRACTOR_UNIT_STATE_NOT_FOUND";
  }
  if (
    toInt(item.locationID, 0) !== context.systemID ||
    toInt(item.flagID, -1) !== 0 ||
    !item.spaceState
  ) {
    return "MOBILE_TRACTOR_UNIT_NOT_IN_SPACE";
  }
  if (
    toInt(item.ownerID, 0) !== context.characterID &&
    toInt(state.ownerID, 0) !== context.characterID &&
    toInt(state.deployerCharacterID, 0) !== context.characterID
  ) {
    return "MOBILE_TRACTOR_UNIT_NOT_OWNER";
  }
  const now = Date.now();
  if (
    options.requireActive !== false &&
    state.active !== true &&
    !(state.activateAtMs > 0 && state.activateAtMs <= now)
  ) {
    return "MOBILE_TRACTOR_UNIT_NOT_ACTIVE";
  }

  const runtime = getSpaceRuntime();
  const shipEntity = runtime.getEntity(session, context.shipID);
  const shipItem = findItemById(context.shipID);
  const tractorEntity = runtime.getEntity(session, item.itemID);
  const shipPosition =
    (shipEntity && shipEntity.position) ||
    (shipItem && shipItem.spaceState && shipItem.spaceState.position);
  const tractorPosition =
    (tractorEntity && tractorEntity.position) ||
    (item.spaceState && item.spaceState.position);
  if (!canEntitiesInteractLocally(shipEntity || shipItem, tractorEntity || item)) {
    return "TARGET_TOO_FAR";
  }
  if (
    shipPosition &&
    tractorPosition &&
    getShipToTractorDistance(
      runtime,
      session,
      shipEntity,
      tractorEntity,
      shipPosition,
      tractorPosition,
    ) > rangeMeters
  ) {
    return "TARGET_TOO_FAR";
  }

  return null;
}

// Hull to hull, as the client measures. Open Cargo and Scoop fly the ship in
// only until the ball's surfaceDist, which takes both radii off, drops under
// the range (autopilot.InInteractionRange). Measuring centre to centre refused
// the first action the client sent on arrival. With either ball missing there
// is no hull to measure, so the stored positions are compared as before.
function getShipToTractorDistance(
  runtime,
  session,
  shipEntity,
  tractorEntity,
  shipPosition,
  tractorPosition,
) {
  if (shipEntity && tractorEntity) {
    const scene = typeof runtime.getSceneForSession === "function"
      ? runtime.getSceneForSession(session)
      : null;
    const surfaceDistance =
      scene && typeof scene.getEntitySurfaceDistance === "function"
        ? scene.getEntitySurfaceDistance(shipEntity, tractorEntity)
        : Math.max(
          0,
          getVectorDistance(shipPosition, tractorPosition) -
            Math.max(0, toReal(shipEntity.radius, 0)) -
            Math.max(0, toReal(tractorEntity.radius, 0)),
        );
    if (Number.isFinite(surfaceDistance)) {
      return surfaceDistance;
    }
  }
  return getVectorDistance(shipPosition, tractorPosition);
}

function validateMobileTractorUnitCargoAccess(session, itemOrID) {
  const item = itemOrID && typeof itemOrID === "object"
    ? itemOrID
    : findItemById(itemOrID);
  const state = getMobileTractorUnitStateFromItem(item);
  const context = getSessionContext(session, { ownerID: 0 });
  const errorMsg = validateMobileTractorUnitSpaceAccess(
    session,
    item,
    state,
    context,
    {
      rangeMeters: MOBILE_TRACTOR_UNIT_SCOOP_RANGE_METERS,
      requireActive: false,
    },
  );
  return errorMsg
    ? { success: false, errorMsg }
    : { success: true, errorMsg: null };
}

function validateMobileTractorUnitScoop(session, item, state, context) {
  return validateMobileTractorUnitSpaceAccess(session, item, state, context, {
    rangeMeters: MOBILE_TRACTOR_UNIT_SCOOP_RANGE_METERS,
  });
}

function updateMobileTractorUnitState(itemID, updater) {
  const item = findItemById(itemID);
  if (!item) {
    return {
      success: false,
      errorMsg: "ITEM_NOT_FOUND",
    };
  }
  const currentState = getStateFromCustomInfo(item.customInfo);
  if (!currentState) {
    return {
      success: false,
      errorMsg: "MOBILE_TRACTOR_UNIT_STATE_NOT_FOUND",
    };
  }
  const nextState =
    typeof updater === "function" ? updater({ ...currentState }, item) : updater;
  return updateInventoryItem(itemID, (currentItem) => ({
    ...currentItem,
    customInfo: buildCustomInfoWithState(currentItem.customInfo, nextState),
  }));
}

function clearTimers(tractorUnitID) {
  const normalizedTractorUnitID = toInt(tractorUnitID, 0);
  tractorBeamStartTimes.delete(normalizedTractorUnitID);
  clearLootTargetFailures(normalizedTractorUnitID);
  clearCompletedEmptyHauls(normalizedTractorUnitID);
  const timerState = timersByTractorUnitID.get(normalizedTractorUnitID);
  if (!timerState) {
    return;
  }
  if (timerState.activationTimer) {
    clearTimeout(timerState.activationTimer);
  }
  if (timerState.expiryTimer) {
    clearTimeout(timerState.expiryTimer);
  }
  timersByTractorUnitID.delete(normalizedTractorUnitID);
}

function getExistingMobileTractorUnitScene(state, sceneOverride = null) {
  if (sceneOverride) {
    return sceneOverride;
  }
  const runtime = getSpaceRuntime();
  const systemID = toInt(state && state.solarSystemID, 0);
  return runtime && runtime.scenes instanceof Map && systemID > 0
    ? runtime.scenes.get(systemID) || null
    : null;
}

function stopPendingMobileTractorUnitPull(item, state, nowMs = Date.now(), sceneOverride = null) {
  const tractorUnitID = toInt(state && state.tractorUnitID, toInt(item && item.itemID, 0));
  const targetID = toInt(state && state.tractorTargetID, 0);
  if (tractorUnitID <= 0 || targetID <= 0) {
    tractorBeamStartTimes.delete(tractorUnitID);
    return false;
  }

  const scene = getExistingMobileTractorUnitScene(state, sceneOverride);
  const sourceEntity = scene && typeof scene.getEntityByID === "function"
    ? scene.getEntityByID(tractorUnitID)
    : null;
  const targetEntity = scene && typeof scene.getEntityByID === "function"
    ? scene.getEntityByID(targetID)
    : null;
  const presentationState = {
    startTime:
      tractorBeamStartTimes.get(tractorUnitID) ||
      getSceneFileTime(scene, toInt(state.tractorStartedAtMs, 0) || nowMs),
  };

  try {
    return broadcastMobileTractorUnitTractorStop(
      scene,
      sourceEntity || item,
      targetEntity,
      presentationState,
      nowMs,
    );
  } catch (error) {
    log.warn(
      `[MobileTractorUnit] Tractor cleanup failed tractorUnit=${tractorUnitID} target=${targetID} error=${error.message}`,
    );
    return false;
  } finally {
    tractorBeamStartTimes.delete(tractorUnitID);
  }
}

function setUnrefTimeout(callback, delayMs) {
  const timer = setTimeout(callback, Math.max(0, toInt(delayMs, 0)));
  if (typeof timer.unref === "function") {
    timer.unref();
  }
  return timer;
}

function clearMobileTractorUnit(itemOrID, reason = "cleared") {
  const itemID = toInt(itemOrID && itemOrID.itemID ? itemOrID.itemID : itemOrID, 0);
  if (!itemID) {
    return false;
  }

  const item = itemOrID && itemOrID.itemID ? itemOrID : findItemById(itemID);
  const state = getMobileTractorUnitStateFromItem(item);
  stopPendingMobileTractorUnitPull(item, state);
  clearTimers(itemID);
  if (!state) {
    return false;
  }

  if (findItemById(itemID)) {
    updateMobileTractorUnitState(itemID, (currentState) => ({
      ...currentState,
      active: false,
      deactivatedAtMs: Date.now(),
      tractorTargetID: 0,
      tractorStartedAtMs: 0,
    }));
  }
  log.info(`[MobileTractorUnit] Cleared tractorUnit=${itemID} reason=${reason}`);
  return true;
}

function activateMobileTractorUnit(itemID) {
  const item = findItemById(itemID);
  const state = getMobileTractorUnitStateFromItem(item);
  if (!state) {
    clearTimers(itemID);
    return false;
  }
  if (resolveAbyssalDeployableItemRestriction(item, state)) {
    clearMobileTractorUnit(item, "abyssal-authority-forbidden");
    return false;
  }

  const now = Date.now();
  if (state.expiresAtMs > 0 && state.expiresAtMs <= now) {
    expireMobileTractorUnit(itemID, "expired-before-activation");
    return false;
  }
  if (
    toInt(item.locationID, 0) !== state.solarSystemID ||
    toInt(item.flagID, 0) !== 0 ||
    !item.spaceState
  ) {
    clearMobileTractorUnit(item, "removed-before-activation");
    return false;
  }

  updateMobileTractorUnitState(itemID, (currentState) => ({
    ...currentState,
    active: true,
    activatedAtMs: now,
    nextCycleAtMs: now + Math.max(1, currentState.cycleTimeSeconds) * 1000,
  }));
  getSpaceRuntime().refreshInventoryBackedEntityPresentation(state.solarSystemID, itemID);
  scheduleMobileTractorUnitTimers(itemID);
  log.info(
    `[MobileTractorUnit] Activated tractorUnit=${itemID} system=${state.solarSystemID}`,
  );
  return true;
}

function expireMobileTractorUnit(itemID, reason = "expired") {
  const item = findItemById(itemID);
  const state = getMobileTractorUnitStateFromItem(item);
  const systemID = toInt(
    state && state.solarSystemID,
    toInt(item && item.locationID, 0),
  );
  stopPendingMobileTractorUnitPull(item, state);
  clearTimers(itemID);

  const removeResult = mobileItemCustody.expireInSpace({
    runtime: getSpaceRuntime(),
    item,
    systemID,
  });
  if (removeResult && removeResult.success) {
    log.info(`[MobileTractorUnit] Removed tractorUnit=${itemID} reason=${reason}`);
    return true;
  }
  updateMobileTractorUnitState(itemID, (currentState) => ({
    ...currentState,
    active: false,
    deactivatedAtMs: Date.now(),
    tractorTargetID: 0,
    tractorStartedAtMs: 0,
  }));
  return false;
}

function scheduleMobileTractorUnitTimers(itemOrID) {
  const itemID = toInt(itemOrID && itemOrID.itemID ? itemOrID.itemID : itemOrID, 0);
  const item = itemOrID && itemOrID.itemID ? itemOrID : findItemById(itemID);
  const state = getMobileTractorUnitStateFromItem(item);
  if (!state) {
    clearTimers(itemID);
    return false;
  }
  if (resolveAbyssalDeployableItemRestriction(item, state)) {
    clearMobileTractorUnit(item, "abyssal-authority-forbidden");
    return false;
  }

  clearTimers(itemID);

  const now = Date.now();
  const nextTimers = {
    activationTimer: null,
    expiryTimer: null,
  };

  if (state.expiresAtMs > 0) {
    nextTimers.expiryTimer = setUnrefTimeout(
      () => expireMobileTractorUnit(itemID, "expired"),
      state.expiresAtMs - now,
    );
  }

  if (state.active || state.activateAtMs <= now) {
    if (!state.active) {
      nextTimers.activationTimer = setUnrefTimeout(
        () => activateMobileTractorUnit(itemID),
        0,
      );
    }
  } else {
    nextTimers.activationTimer = setUnrefTimeout(
      () => activateMobileTractorUnit(itemID),
      state.activateAtMs - now,
    );
  }

  timersByTractorUnitID.set(itemID, nextTimers);
  return true;
}

function registerMobileTractorUnitItem(itemOrID) {
  return scheduleMobileTractorUnitTimers(itemOrID);
}

function isActiveTractorUnitState(state, nowMs = Date.now()) {
  if (!state || state.deactivatedAtMs > 0) {
    return false;
  }
  if (state.expiresAtMs > 0 && state.expiresAtMs <= nowMs) {
    return false;
  }
  return state.active === true || (state.activateAtMs > 0 && state.activateAtMs <= nowMs);
}

function hydrateMobileTractorUnitEntityFromInventoryItem(entity, itemRecord) {
  if (!entity || !isMobileTractorUnitType(itemRecord)) {
    return entity;
  }

  const state = getMobileTractorUnitStateFromItem(itemRecord);
  if (!state) {
    return entity;
  }

  if (resolveAbyssalDeployableItemRestriction(itemRecord, state)) {
    entity.component_activate = [false, null];
    entity.activate_comp_durationSeconds = Math.trunc(
      MOBILE_TRACTOR_UNIT_ACTIVATION_DELAY_MS / 1000,
    );
    entity.component_decay = null;
    return entity;
  }

  const active = isActiveTractorUnitState(state, Date.now());
  entity.component_activate = [active, active ? null : state.activateAtMs];
  entity.activate_comp_durationSeconds = Math.trunc(
    MOBILE_TRACTOR_UNIT_ACTIVATION_DELAY_MS / 1000,
  );
  entity.component_decay = state.expiresAtMs > 0 ? state.expiresAtMs : null;
  entity.autoTractorBeamMaxRange = state.rangeMeters;
  entity.autoTractorBeamCycleTimeSeconds = state.cycleTimeSeconds;
  entity.autoTractorBeamMaxTractorVelocity = state.maxTractorVelocity;
  entity.cargoCapacity = state.holdCapacity;
  return entity;
}

function launchMobileTractorUnitFromShip(session, itemID, options = {}) {
  const context = getSessionContext(session, options);
  const item = findItemById(itemID);
  const validationError = validateMobileTractorUnitLaunch(item, context);
  if (validationError) {
    return {
      success: false,
      errorMsg: validationError,
    };
  }

  const sourceTypeID = toInt(item.typeID, 0);
  const spawnState = buildDeployableSpawnState(session, context);
  const placementConflict = findPlacementConflict(session, item, context, spawnState);
  if (placementConflict) {
    log.info(
      `[MobileTractorUnit] Launch rejected char=${context.characterID} item=${item.itemID} system=${context.systemID} reason=${placementConflict.errorMsg}${describePlacementBlocker(placementConflict)}`,
    );
    return {
      success: false,
      errorMsg: placementConflict.errorMsg,
    };
  }

  const transferResult = mobileItemCustody.deployFromShip({
    item,
    ownerID: context.ownerID,
    shipID: context.shipID,
    systemID: context.systemID,
    actor: context.characterID,
  });
  if (!transferResult.success) {
    return transferResult;
  }

  const transferChanges = transferResult.data && transferResult.data.changes
    ? transferResult.data.changes
    : [];
  const launchedChange = findLaunchedChange(
    transferChanges,
    context.systemID,
    context.ownerID,
    sourceTypeID,
  );
  const launchedItemID = toInt(launchedChange && launchedChange.item && launchedChange.item.itemID, 0);
  if (!launchedItemID) {
    return {
      success: false,
      errorMsg: "LAUNCHED_ITEM_NOT_FOUND",
    };
  }

  const now = Date.now();
  const stats = resolveMobileTractorUnitStats(item);
  const state = {
    ownerID: context.ownerID,
    deployerCharacterID: context.characterID,
    solarSystemID: context.systemID,
    tractorUnitID: launchedItemID,
    deployedAtMs: now,
    activateAtMs: now + MOBILE_TRACTOR_UNIT_ACTIVATION_DELAY_MS,
    activatedAtMs: 0,
    expiresAtMs: now + MOBILE_TRACTOR_UNIT_LIFETIME_MS,
    active: false,
    deactivatedAtMs: 0,
    nextCycleAtMs: 0,
    lastCycleAtMs: 0,
    lastLootMoveAtMs: 0,
    lastTractorTargetID: 0,
    tractorTargetID: 0,
    tractorStartedAtMs: 0,
    movedItemCount: 0,
    ...stats,
  };
  const updatedResult = updateInventoryItem(launchedItemID, (currentItem) => ({
    ...currentItem,
    ownerID: context.ownerID,
    locationID: context.systemID,
    flagID: 0,
    singleton: 1,
    createdAtMs: currentItem.createdAtMs || now,
    expiresAtMs: state.expiresAtMs,
    spaceRadius: currentItem.spaceRadius || currentItem.radius || null,
    dunRotation: currentItem.dunRotation || [0, 0, 0],
    spaceState: spawnState,
    customInfo: buildCustomInfoWithState(currentItem.customInfo, state),
  }));
  if (!updatedResult.success || !updatedResult.data) {
    return updatedResult;
  }

  syncChangesExceptItem(session, transferChanges, launchedItemID);
  syncInventoryChange(
    session,
    updatedResult.data,
    launchedChange.previousData || updatedResult.previousData || {},
    { idType: "charid" },
  );

  const spawnResult = getSpaceRuntime().spawnDynamicInventoryEntity(context.systemID, launchedItemID);
  if (!spawnResult || !spawnResult.success) {
    log.warn(
      `[MobileTractorUnit] Launched tractor unit ${launchedItemID} but space spawn failed: ${spawnResult ? spawnResult.errorMsg : "UNKNOWN"}`,
    );
  }

  registerMobileTractorUnitItem(updatedResult.data);
  log.info(
    `[MobileTractorUnit] char=${context.characterID} launched tractorUnit itemID=${launchedItemID} typeID=${sourceTypeID} system=${context.systemID}`,
  );

  return {
    success: true,
    data: {
      itemID: launchedItemID,
      sourceItemID: item.itemID,
      state,
    },
  };
}

function buildNearbyEjectedContainerSpawnState(tractorItem, tractorEntity, shipEntity) {
  const position =
    getObjectPosition(tractorEntity) ||
    getObjectPosition(tractorItem) ||
    getObjectPosition(shipEntity);
  if (!position) {
    return null;
  }
  const direction = normalizeDirection(
    (tractorEntity && tractorEntity.direction) ||
      (tractorItem && tractorItem.spaceState && tractorItem.spaceState.direction) ||
      (shipEntity && shipEntity.direction),
    { x: 1, y: 0, z: 0 },
  );
  const containerPosition = addVectors(
    position,
    scaleVector(direction, MOBILE_TRACTOR_UNIT_EJECTED_CONTAINER_DISTANCE_METERS),
  );
  return {
    ...buildChildEntityScopeMetadata({
      ...(
        tractorItem && tractorItem.spaceState
          ? tractorItem.spaceState
          : {}
      ),
      ...(tractorEntity || shipEntity || {}),
    }),
    systemID: toInt(tractorItem && tractorItem.locationID, 0),
    position: containerPosition,
    velocity: { x: 0, y: 0, z: 0 },
    direction,
    targetPoint: containerPosition,
    mode: "STOP",
    speedFraction: 0,
  };
}

function resolveEjectedCargoContainerType() {
  const result = resolveItemByName(CARGO_CONTAINER_NAME);
  return result && result.success ? result.match : null;
}

function publishEjectedMobileTractorUnitContainer(runtime, systemID, containerID) {
  try {
    const spawnResult = runtime.spawnDynamicInventoryEntity(systemID, containerID);
    return spawnResult && spawnResult.success
      ? spawnResult
      : {
        success: false,
        errorMsg: (spawnResult && spawnResult.errorMsg) || "SPAWN_FAILED",
      };
  } catch (error) {
    return {
      success: false,
      errorMsg: String((error && error.message) || "SPAWN_FAILED"),
    };
  }
}

// The ejected container is unpublished while its contents are being moved in:
// the row exists in space records but no scene entity does. Discarding it the
// way the jetcan path discards an unpublished can keeps a failed ejection from
// leaving loot in something nobody can see and boot-time expiry would later
// delete with the contents still inside.
function discardUnpublishedEjectedContainer(session, containerItem, actorID) {
  const runtime = getSpaceRuntime();
  const scene = runtime && typeof runtime.getSceneForSession === "function"
    ? runtime.getSceneForSession(session)
    : null;
  // A spawn that failed halfway can still have registered the entity.
  if (
    scene &&
    typeof scene.getEntityByID === "function" &&
    scene.getEntityByID(containerItem.itemID) &&
    typeof scene.removeDynamicEntity === "function"
  ) {
    scene.removeDynamicEntity(containerItem.itemID, {
      broadcast: true,
      persistSpaceState: false,
    });
  }

  const removeResult = itemCustody.transfer({
    items: { itemID: containerItem.itemID },
    from: itemCustody.custodyRef.inSpace(
      toInt(containerItem.ownerID, 0),
      toInt(containerItem.locationID, 0),
    ),
    to: itemCustody.custodyRef.void(),
    reason: itemCustody.CUSTODY_REASON.MOBILE_TRACTOR_UNIT_EJECT_ROLLBACK,
    actor: toInt(actorID, 0) || null,
    idempotencyKey: `mobile-tractor-unit-eject-rollback:${containerItem.itemID}`,
    options: { removeContents: true },
  });
  if (!removeResult || removeResult.success !== true) {
    log.error(
      `[MobileTractorUnit] Failed to discard unpublished ejected container ${containerItem.itemID}: ${removeResult && removeResult.errorMsg || "REMOVE_FAILED"}`,
    );
    return false;
  }
  syncChangesExceptItem(session, removeResult.data && removeResult.data.changes, 0);
  return true;
}

// Return everything that already landed in the ejected container to the tractor
// unit, then throw the empty container away. Loot that refuses to come home has
// the container as its only holder, so that container is published instead of
// voided: a visible can beats destroyed loot.
function rollbackEjectedMobileTractorUnitContainer(
  session,
  item,
  containerItem,
  movedContents,
  context,
) {
  const strandedItemIDs = [];
  for (const contentItem of movedContents) {
    const restoreResult = moveItemToLocation(
      contentItem.itemID,
      toInt(contentItem.locationID, 0) || item.itemID,
      toInt(contentItem.flagID, MOBILE_TRACTOR_UNIT_CARGO_FLAG_ID),
    );
    if (!restoreResult.success) {
      strandedItemIDs.push(toInt(contentItem.itemID, 0));
      log.error(
        `[MobileTractorUnit] Failed to return ejected item=${contentItem.itemID} to tractorUnit=${item.itemID}: ${restoreResult.errorMsg}`,
      );
      continue;
    }
    syncChangesExceptItem(session, restoreResult.data && restoreResult.data.changes, 0);
  }

  if (strandedItemIDs.length > 0) {
    const spawnResult = publishEjectedMobileTractorUnitContainer(
      getSpaceRuntime(),
      context.systemID,
      containerItem.itemID,
    );
    log.error(
      `[MobileTractorUnit] Ejected container ${containerItem.itemID} kept in space holding ${strandedItemIDs.length} item(s) that would not return to tractorUnit=${item.itemID}: published=${spawnResult.success}${spawnResult.success ? "" : ` error=${spawnResult.errorMsg}`}`,
    );
    return false;
  }

  return discardUnpublishedEjectedContainer(
    session,
    containerItem,
    context.characterID,
  );
}

function ejectMobileTractorUnitContentsToContainer(session, item, state, context) {
  const contents = listContainerItems(null, item.itemID, null);
  if (contents.length === 0) {
    return {
      success: true,
      data: {
        containerID: 0,
        movedItemCount: 0,
      },
    };
  }

  const containerType = resolveEjectedCargoContainerType();
  if (!containerType) {
    return {
      success: false,
      errorMsg: "MOBILE_TRACTOR_UNIT_CONTENT_EJECTION_FAILED",
    };
  }

  const runtime = getSpaceRuntime();
  const tractorEntity = runtime.getEntity(session, item.itemID);
  const shipEntity = runtime.getEntity(session, context.shipID);
  const spawnState = buildNearbyEjectedContainerSpawnState(item, tractorEntity, shipEntity);
  if (!spawnState) {
    return {
      success: false,
      errorMsg: "MOBILE_TRACTOR_UNIT_CONTENT_EJECTION_FAILED",
    };
  }

  const now = Date.now();
  const ownerID = toInt(state && state.ownerID, context.characterID);
  const lootContext = resolveCharacterSpaceLootContext(ownerID, { session });
  const createResult = createSpaceItemForOwner(ownerID, context.systemID, containerType, {
    ...spawnState,
    itemName: CARGO_CONTAINER_NAME,
    customInfo: JSON.stringify({
      [LOOT_CUSTOM_INFO_KEY]: buildSpaceLootRightsSnapshot(lootContext),
    }),
    createdAtMs: now,
    expiresAtMs: now + MOBILE_TRACTOR_UNIT_EJECTED_CONTAINER_LIFETIME_MS,
  });
  if (!createResult.success || !createResult.data) {
    return {
      success: false,
      errorMsg: createResult.errorMsg || "MOBILE_TRACTOR_UNIT_CONTENT_EJECTION_FAILED",
    };
  }

  const containerItem = createResult.data;
  syncChangesExceptItem(session, createResult.changes || [], 0);

  // A content row that refuses to move - a packaged container the ejected can
  // will not nest, a write error - used to abandon the run here, leaving the
  // container row and everything already inside it in space with no entity to
  // see or loot. Roll the whole ejection back instead and fail the scoop, so
  // the loot stays in the tractor unit the pilot can still scoop later.
  const movedContents = [];
  for (const contentItem of contents) {
    const moveResult = moveItemToLocation(
      contentItem.itemID,
      containerItem.itemID,
      ITEM_FLAGS.HANGAR,
    );
    if (!moveResult.success) {
      log.warn(
        `[MobileTractorUnit] Failed to eject content item=${contentItem.itemID} from tractorUnit=${item.itemID} to container=${containerItem.itemID}: ${moveResult.errorMsg}`,
      );
      rollbackEjectedMobileTractorUnitContainer(
        session,
        item,
        containerItem,
        movedContents,
        context,
      );
      return {
        success: false,
        errorMsg: moveResult.errorMsg || "MOBILE_TRACTOR_UNIT_CONTENT_EJECTION_FAILED",
      };
    }
    movedContents.push(contentItem);
    syncChangesExceptItem(session, moveResult.data && moveResult.data.changes, 0);
  }

  // A loaded container that never reaches the scene is just as invisible as a
  // half-filled one, so the spawn failing fails the scoop too rather than
  // reporting success over stranded loot.
  const spawnResult = publishEjectedMobileTractorUnitContainer(
    runtime,
    context.systemID,
    containerItem.itemID,
  );
  if (!spawnResult.success) {
    log.warn(
      `[MobileTractorUnit] Ejected container ${containerItem.itemID} was created but space spawn failed: ${spawnResult.errorMsg}`,
    );
    rollbackEjectedMobileTractorUnitContainer(
      session,
      item,
      containerItem,
      movedContents,
      context,
    );
    return {
      success: false,
      errorMsg: "MOBILE_TRACTOR_UNIT_CONTENT_EJECTION_FAILED",
    };
  }

  return {
    success: true,
    data: {
      containerID: containerItem.itemID,
      movedItemCount: movedContents.length,
    },
  };
}

function scoopMobileTractorUnitToCargo(session, itemID) {
  const context = getSessionContext(session, { ownerID: 0 });
  const item = findItemById(itemID);
  const state = getMobileTractorUnitStateFromItem(item);
  const validationError = validateMobileTractorUnitScoop(session, item, state, context);
  if (validationError) {
    return {
      success: false,
      errorMsg: validationError,
    };
  }

  const destinationValidationError = validateMobileTractorUnitDestinationCargo(item, context);
  if (destinationValidationError) {
    return {
      success: false,
      errorMsg: destinationValidationError,
    };
  }

  const ejectionResult = ejectMobileTractorUnitContentsToContainer(
    session,
    item,
    state,
    context,
  );
  if (!ejectionResult.success) {
    return ejectionResult;
  }

  const runtime = getSpaceRuntime();
  stopPendingMobileTractorUnitPull(
    item,
    state,
    Date.now(),
    runtime && typeof runtime.getSceneForSession === "function"
      ? runtime.getSceneForSession(session)
      : null,
  );

  const updateResult = mobileItemCustody.scoopToShip({
    runtime,
    item,
    ownerID: context.characterID,
    shipID: context.shipID,
    systemID: context.systemID,
    flagID: ITEM_FLAGS.CARGO_HOLD,
    actor: context.characterID,
    destinationItemPatch: {
      singleton: 0,
      expiresAtMs: null,
      spaceRadius: null,
      spaceState: null,
      customInfo: buildCustomInfoWithoutState(item.customInfo),
    },
  });
  if (!updateResult.success || !updateResult.data || !updateResult.data.item) {
    return updateResult;
  }

  syncInventoryChange(
    session,
    updateResult.data.item,
    updateResult.data.changes && updateResult.data.changes[0] &&
      updateResult.data.changes[0].previousData || item,
    {
      idType: "charid",
      locationContext: ["Ship", context.shipID, "ShipCargo"],
    },
  );

  clearTimers(item.itemID);

  log.info(
    `[MobileTractorUnit] char=${context.characterID} scooped tractorUnit itemID=${item.itemID} system=${context.systemID} ship=${context.shipID} ejectedContainer=${ejectionResult.data.containerID || 0} movedItems=${ejectionResult.data.movedItemCount || 0}`,
  );

  return {
    success: true,
    response: true,
    data: {
      itemID: item.itemID,
      ejectedContainerID: ejectionResult.data.containerID || 0,
      movedItemCount: ejectionResult.data.movedItemCount || 0,
    },
  };
}

function getItemMoveVolume(item) {
  const metadata = getItemMetadata(item && item.typeID) || {};
  return Math.max(
    0,
    firstFiniteReal([item && item.volume, metadata.volume], 0),
  );
}

function getItemMoveQuantity(item) {
  return toInt(item && item.singleton, 0) === 1
    ? 1
    : Math.max(0, toInt(item && (item.stacksize ?? item.quantity), 0));
}

function getContainerUsedVolume(locationID) {
  return listContainerItems(null, locationID, MOBILE_TRACTOR_UNIT_CARGO_FLAG_ID).reduce((sum, item) => (
    sum + getItemMoveVolume(item) * getItemMoveQuantity(item)
  ), 0);
}

function getMoveQuantityForFreeVolume(item, freeVolume) {
  const quantity = getItemMoveQuantity(item);
  if (quantity <= 0) {
    return 0;
  }
  if (toInt(item && item.singleton, 0) === 1) {
    return getItemMoveVolume(item) <= freeVolume + 1e-7 ? 1 : 0;
  }

  const unitVolume = getItemMoveVolume(item);
  if (unitVolume <= 0) {
    return quantity;
  }
  return Math.max(0, Math.min(quantity, Math.floor((freeVolume + 1e-7) / unitVolume)));
}

function getLootFailureRecord(tractorUnitID, targetID) {
  const targets = lootFailuresByTractorUnitID.get(toInt(tractorUnitID, 0));
  return targets ? targets.get(toInt(targetID, 0)) || null : null;
}

function isLootTargetDeprioritised(tractorUnitID, targetID, nowMs) {
  const record = getLootFailureRecord(tractorUnitID, targetID);
  return Boolean(record && record.blockedUntilMs > toInt(nowMs, 0));
}

function clearLootTargetFailure(tractorUnitID, targetID) {
  const normalizedTractorUnitID = toInt(tractorUnitID, 0);
  const targets = lootFailuresByTractorUnitID.get(normalizedTractorUnitID);
  if (!targets) {
    return;
  }
  targets.delete(toInt(targetID, 0));
  if (targets.size <= 0) {
    lootFailuresByTractorUnitID.delete(normalizedTractorUnitID);
  }
}

function clearLootTargetFailures(tractorUnitID) {
  lootFailuresByTractorUnitID.delete(toInt(tractorUnitID, 0));
}

// A wreck that has been hauled all the way in and gave up nothing is finished
// business for this unit. Remember it by identity, not by where it ended up:
// two units that can both reach it would otherwise trade it back and forth
// forever, because each one keeps finding it parked next to the other, outside
// its own collection range and still empty. The minimum spacing between two
// units is wider than a collection range, so every hand-off lands the wreck
// back in the other unit's selectable band.
function hasCompletedEmptyHaul(tractorUnitID, targetID) {
  const targets = emptyHaulsByTractorUnitID.get(toInt(tractorUnitID, 0));
  return Boolean(targets && targets.has(toInt(targetID, 0)));
}

function registerCompletedEmptyHaul(tractorUnitID, targetID) {
  const normalizedTractorUnitID = toInt(tractorUnitID, 0);
  const normalizedTargetID = toInt(targetID, 0);
  if (normalizedTractorUnitID <= 0 || normalizedTargetID <= 0) {
    return;
  }
  let targets = emptyHaulsByTractorUnitID.get(normalizedTractorUnitID);
  if (!targets) {
    targets = new Set();
    emptyHaulsByTractorUnitID.set(normalizedTractorUnitID, targets);
  }
  // A Set iterates in insertion order, so this drops the oldest haul first.
  while (targets.size >= MOBILE_TRACTOR_UNIT_EMPTY_HAUL_MEMORY_LIMIT) {
    targets.delete(targets.values().next().value);
  }
  targets.add(normalizedTargetID);
}

function clearCompletedEmptyHauls(tractorUnitID) {
  emptyHaulsByTractorUnitID.delete(toInt(tractorUnitID, 0));
}

function registerMobileTractorUnitLootFailure(
  tractorUnitID,
  targetID,
  nowMs,
  madeProgress,
) {
  const normalizedTractorUnitID = toInt(tractorUnitID, 0);
  const normalizedTargetID = toInt(targetID, 0);
  const normalizedNowMs = toInt(nowMs, 0);
  if (normalizedTractorUnitID <= 0 || normalizedTargetID <= 0) {
    return { failures: 0, blockedUntilMs: 0 };
  }
  // A cycle that still moved something is making progress, so the remaining
  // failure does not count against the target.
  if (madeProgress) {
    clearLootTargetFailure(normalizedTractorUnitID, normalizedTargetID);
    return { failures: 0, blockedUntilMs: 0 };
  }

  let targets = lootFailuresByTractorUnitID.get(normalizedTractorUnitID);
  if (!targets) {
    targets = new Map();
    lootFailuresByTractorUnitID.set(normalizedTractorUnitID, targets);
  }
  for (const [candidateID, candidate] of targets) {
    if (
      candidateID !== normalizedTargetID &&
      normalizedNowMs - toInt(candidate.lastFailureAtMs, 0) >
        MOBILE_TRACTOR_UNIT_TARGET_BACKOFF_MS * 2
    ) {
      targets.delete(candidateID);
    }
  }

  const previous = targets.get(normalizedTargetID);
  const failures = toInt(previous && previous.failures, 0) + 1;
  const record = {
    failures,
    lastFailureAtMs: normalizedNowMs,
    blockedUntilMs: failures >= MOBILE_TRACTOR_UNIT_TARGET_FAILURE_LIMIT
      ? normalizedNowMs + MOBILE_TRACTOR_UNIT_TARGET_BACKOFF_MS
      : 0,
  };
  targets.set(normalizedTargetID, record);
  return record;
}

function isTractorableTarget(entity) {
  return Boolean(
    entity &&
      toInt(entity.itemID, 0) > 0 &&
      (entity.kind === "container" || entity.kind === "wreck")
  );
}

// A tractor unit hauls wrecks in for the salvager, not only for their loot, so
// a wreck is worth a beam even when there is nothing inside it - it may have
// spawned empty, or been hand-looted before the unit got to it. A container is
// loot and nothing else: an empty one has no second use and is never pulled.
function isSalvageHaulTarget(entity) {
  return Boolean(entity && entity.kind === "wreck");
}

function hasTargetLoot(entity) {
  const targetID = toInt(entity && entity.itemID, 0);
  if (!targetID) {
    return false;
  }
  if (entity && entity.nativeNpcWreck === true) {
    return nativeNpcStore.listNativeWreckItemsForWreck(targetID).length > 0;
  }
  return listContainerItems(null, targetID, null).length > 0;
}

// The shared loot rules are written against a session, but a deployed tractor
// unit only has an owner character - who is very often offline. Build the
// descriptor those rules actually read (character, corporation, system) from
// the owner's character record so the rule set stays shared instead of being
// forked here. Returns null when the persisted owner/deployer identity or
// system authority is absent; auto-loot must fail closed in that case.
function buildMobileTractorUnitOwnerSession(state) {
  const ownerID = toInt(state && state.ownerID, 0) ||
    toInt(state && state.deployerCharacterID, 0);
  const solarSystemID = toInt(state && state.solarSystemID, 0);
  if (ownerID <= 0 || solarSystemID <= 0) {
    return null;
  }
  let ownerRecord = null;
  try {
    ownerRecord = require(path.join(__dirname, "../character/characterState"))
      .peekCharacterRecord(ownerID);
  } catch (_error) {
    ownerRecord = null;
  }
  return {
    characterID: ownerID,
    charid: ownerID,
    corporationID: toInt(
      ownerRecord && (ownerRecord.corporationID ?? ownerRecord.corpid),
      0,
    ),
    _space: { systemID: solarSystemID },
  };
}

function buildMobileTractorUnitLootSource(entity) {
  const targetID = toInt(entity && entity.itemID, 0);
  if (targetID <= 0) {
    return null;
  }
  // Native NPC wrecks live outside itemStore. Their service-owned record is
  // authoritative for both ownership and abandonment, including after a scene
  // rematerializes.
  if (entity.nativeNpcWreck === true) {
    const wreckRecord = nativeNpcStore.getNativeWreck(targetID);
    if (!wreckRecord) {
      return null;
    }
    return {
      itemID: targetID,
      ownerID: toInt(wreckRecord.ownerID, 0),
      locationID: toInt(wreckRecord.systemID, 0),
      lootInfo: {
        rightsSnapshotVersion: toInt(
          wreckRecord.lootRightsSnapshotVersion,
          0,
        ),
        abandoned: wreckRecord.lootAbandoned === true,
        corporationID: toInt(wreckRecord.corporationID, 0),
        lootRightCorpID: toInt(wreckRecord.lootRightCorpID, 0),
        lootRightFleetID:
          toInt(wreckRecord.lootRightFleetID, 0) || null,
      },
    };
  }

  const source = buildSpaceLootSourceFromItem(findItemById(targetID));
  if (source && entity.lootAbandoned === true) {
    source.lootInfo = { ...source.lootInfo, abandoned: true };
  }
  return source;
}

// A tractor unit does not steal. It pulls only what its owner could already
// take by hand - their own debris, an abandoned wreck, or one held under
// corporation or fleet loot rights - so the loot cycle cannot launder a take
// that the inventory broker would have sent through crimewatch.
function isMobileTractorUnitLootTargetEntitled(entity, ownerSession) {
  if (!ownerSession) {
    return false;
  }
  const source = buildMobileTractorUnitLootSource(entity);
  if (!source) {
    return false;
  }
  return sessionHasSpaceLootRight(ownerSession, source);
}

function getEntitySurfaceDistance(left, right) {
  const centerDistance = getVectorDistance(left && left.position, right && right.position);
  const leftRadius = Math.max(0, toReal(left && left.radius, 0));
  const rightRadius = Math.max(0, toReal(right && right.radius, 0));
  return Math.max(0, centerDistance - leftRadius - rightRadius);
}

// Returns the nearest thing this unit should pull, which is not the same as the
// nearest thing it can loot: an empty wreck is still worth hauling in for the
// salvager. See isSalvageHaulTarget for where the two part company.
function findNearestTractorTarget(scene, tractorEntity, state, nowMs = Date.now()) {
  const rangeMeters = Math.max(0, toReal(state && state.rangeMeters, 0));
  if (!scene || !tractorEntity || rangeMeters <= 0) {
    return null;
  }
  const tractorUnitID = toInt(
    state && state.tractorUnitID,
    toInt(tractorEntity.itemID, 0),
  );
  const candidates = typeof scene.getDynamicEntities === "function"
    ? scene.getDynamicEntities()
    : [];
  const ownerSession = buildMobileTractorUnitOwnerSession(state);
  let nearest = null;
  for (const entity of candidates) {
    if (
      !isTractorableTarget(entity) ||
      toInt(entity.itemID, 0) === toInt(tractorEntity.itemID, 0) ||
      !canEntitiesInteractLocally(tractorEntity, entity) ||
      isLootTargetDeprioritised(tractorUnitID, entity.itemID, nowMs)
    ) {
      continue;
    }
    const surfaceDistance = getEntitySurfaceDistance(tractorEntity, entity);
    if (surfaceDistance > rangeMeters + 1e-7) {
      continue;
    }
    // An empty target earns a beam only when it is a wreck the salvager still
    // has to cross the grid for: already inside collection range there is
    // nothing left to do with it, and re-selecting it would restart the pull
    // every cycle. A wreck this unit has already hauled in and found empty is
    // done with regardless of where it has since drifted.
    if (
      !hasTargetLoot(entity) &&
      !(
        isSalvageHaulTarget(entity) &&
        surfaceDistance > MOBILE_TRACTOR_UNIT_COLLECTION_RANGE_METERS + 1e-7 &&
        !hasCompletedEmptyHaul(tractorUnitID, entity.itemID)
      )
    ) {
      continue;
    }
    // Last, because it is the dearest filter: an item store read plus the
    // shared loot rules on top.
    if (!isMobileTractorUnitLootTargetEntitled(entity, ownerSession)) {
      continue;
    }
    if (!nearest || surfaceDistance < nearest.surfaceDistance) {
      nearest = {
        entity,
        surfaceDistance,
      };
    }
  }
  return nearest;
}

// Item custody names the clause that refused a replayed receipt. Carry that
// name plus the two values into the warning so the cause is readable from one
// log line rather than a code audit.
function describeLootTransferFailure(moveResult) {
  const errorMsg = String(
    (moveResult && moveResult.errorMsg) || "MOBILE_TRACTOR_UNIT_LOOT_TRANSFER_FAILED",
  );
  const mismatch = moveResult && moveResult.data && moveResult.data.mismatch;
  if (!mismatch || typeof mismatch !== "object") {
    return errorMsg;
  }
  const describe = (value) => (
    value === null || value === undefined ? "null" : String(value)
  );
  return `${errorMsg}(expected=${describe(mismatch.expected)} actual=${describe(mismatch.actual)})`;
}

function buildLootTransferResult(
  changes,
  movedItemCount,
  failure,
  capacitySkippedItemCount = 0,
) {
  return {
    success: failure.failedItemCount <= 0,
    ...(failure.failedItemCount > 0
      ? { errorMsg: failure.errorMsg || "MOBILE_TRACTOR_UNIT_LOOT_TRANSFER_FAILED" }
      : {}),
    failedItemCount: failure.failedItemCount,
    failedItemID: failure.failedItemID,
    capacitySkippedItemCount,
    changes,
    movedItemCount,
  };
}

function transferInventoryTargetLootToMtu(targetEntity, tractorUnitID, ownerID, holdCapacity) {
  const targetID = toInt(targetEntity && targetEntity.itemID, 0);
  const changes = [];
  const failure = { failedItemCount: 0, failedItemID: 0, errorMsg: "" };
  let freeVolume = Math.max(0, toReal(holdCapacity, 0) - getContainerUsedVolume(tractorUnitID));
  let movedItemCount = 0;

  const contents = listContainerItems(null, targetID, null)
    .sort((left, right) => toInt(left.itemID, 0) - toInt(right.itemID, 0));
  let capacitySkippedItemCount = 0;
  for (const item of contents) {
    const moveQuantity = getMoveQuantityForFreeVolume(item, freeVolume);
    if (moveQuantity <= 0) {
      // Too big for what is left of the hold. Nothing failed, so the cycle
      // still reports success - but the target keeps its loot and stays the
      // nearest one that has any, so the caller has to hear about a cycle that
      // skipped everything or the unit re-selects it forever.
      if (getItemMoveQuantity(item) > 0) {
        capacitySkippedItemCount += 1;
      }
      continue;
    }
    const moveResult = transferItemToOwnerLocation(
      item.itemID,
      ownerID,
      tractorUnitID,
      MOBILE_TRACTOR_UNIT_CARGO_FLAG_ID,
      moveQuantity,
    );
    // One item that refuses to move must not strand every item behind it. The
    // refused item stays where it is and the rest of the target is worked.
    if (!moveResult.success) {
      failure.failedItemCount += 1;
      if (!failure.errorMsg) {
        failure.errorMsg = describeLootTransferFailure(moveResult);
        failure.failedItemID = toInt(item.itemID, 0);
      }
      continue;
    }
    movedItemCount += 1;
    changes.push(...((moveResult.data && moveResult.data.changes) || []));
    freeVolume -= getItemMoveVolume(item) * moveQuantity;
  }

  return buildLootTransferResult(
    changes,
    movedItemCount,
    failure,
    capacitySkippedItemCount,
  );
}

function transferNativeTargetLootToMtu(targetEntity, tractorUnitID, ownerID, holdCapacity) {
  const wreckID = toInt(targetEntity && targetEntity.itemID, 0);
  const changes = [];
  const failure = { failedItemCount: 0, failedItemID: 0, errorMsg: "" };
  let freeVolume = Math.max(0, toReal(holdCapacity, 0) - getContainerUsedVolume(tractorUnitID));
  let movedItemCount = 0;

  const contents = nativeNpcStore.listNativeWreckItemsForWreck(wreckID)
    .sort((left, right) => toInt(left.wreckItemID, 0) - toInt(right.wreckItemID, 0));
  let capacitySkippedItemCount = 0;
  for (const itemRecord of contents) {
    const itemLike = {
      itemID: itemRecord && itemRecord.wreckItemID,
      typeID: itemRecord && itemRecord.typeID,
      quantity: itemRecord && itemRecord.quantity,
      stacksize: itemRecord && itemRecord.quantity,
      singleton: itemRecord && itemRecord.singleton === true ? 1 : 0,
      volume: itemRecord && itemRecord.volume,
    };
    const moveQuantity = getMoveQuantityForFreeVolume(itemLike, freeVolume);
    if (moveQuantity <= 0) {
      if (getItemMoveQuantity(itemLike) > 0) {
        capacitySkippedItemCount += 1;
      }
      continue;
    }
    const moveResult = getNativeNpcWreckService().transferNativeWreckItemToCharacterLocation({
      characterID: ownerID,
      wreckID,
      wreckItemID: itemRecord.wreckItemID,
      destinationLocationID: tractorUnitID,
      destinationFlagID: MOBILE_TRACTOR_UNIT_CARGO_FLAG_ID,
      quantity: moveQuantity,
    });
    // A wreck item that custody refuses (a stale receipt, a diverged source)
    // used to abort the whole wreck, so every later item became unreachable and
    // the unit re-selected the same wreck forever. Skip it and keep going; the
    // refused item stays in the wreck and stays lootable by hand.
    if (!moveResult.success) {
      failure.failedItemCount += 1;
      if (!failure.errorMsg) {
        failure.errorMsg = describeLootTransferFailure(moveResult);
        failure.failedItemID = toInt(itemRecord.wreckItemID, 0);
      }
      continue;
    }
    movedItemCount += 1;
    changes.push(...((moveResult.data && moveResult.data.changes) || []));
    freeVolume -= getItemMoveVolume(itemLike) * moveQuantity;
  }

  return buildLootTransferResult(
    changes,
    movedItemCount,
    failure,
    capacitySkippedItemCount,
  );
}

function getSceneFileTime(scene, nowMs) {
  if (scene && typeof scene.toFileTimeFromSimMs === "function") {
    return scene.toFileTimeFromSimMs(nowMs);
  }
  if (scene && typeof scene.getCurrentFileTime === "function") {
    return scene.getCurrentFileTime();
  }
  return BigInt(Date.now()) * 10000n + 116444736000000000n;
}

function broadcastMobileTractorUnitTractorStart(scene, entity, targetEntity, state, nowMs) {
  if (!scene || !entity || !targetEntity) {
    return null;
  }
  const startTime = getSceneFileTime(scene, nowMs);
  const tractorVelocity = Math.max(
    0,
    toReal(state && state.maxTractorVelocity, MOBILE_TRACTOR_UNIT_DEFAULT_MAX_TRACTOR_VELOCITY),
  );

  queueOrApplyMovementChange(scene, targetEntity, "mobileTractorStart", nowMs, (atMs) => {
    const tractorStartCommand = applyMobileTractorUnitTractorStartCommand({
      sourceEntity: entity,
      targetEntity,
      tractorSpeedMetersPerSecond: tractorVelocity,
      followRangeMeters: TRACTOR_BEAM_FOLLOW_RANGE_METERS,
      effectGuid: TRACTOR_BEAM_EFFECT_GUID,
      effectDurationMs: TRACTOR_BEAM_EFFECT_DURATION_MS,
      effectRepeat: TRACTOR_BEAM_EFFECT_REPEAT,
      effectStartTime: startTime,
    });
    if (!tractorStartCommand.applied) {
      return;
    }

    if (typeof scene.queueBubbleHistory === "function") {
      scene.queueBubbleHistory(
        tractorStartCommand.buildPresentationUpdates({
          stamp: captureMobileTractorUnitPresentation({ scene, nowMs: atMs }),
        }),
      );
    }

    if (typeof scene.persistDynamicEntity === "function") {
      scene.persistDynamicEntity(targetEntity);
    }
  });

  const godmaEffect = buildGodmaShipEffectEvent(
    entity.itemID,
    state && state.ownerID,
    entity.itemID,
    TRACTOR_BEAM_GODMA_EFFECT_ID,
    startTime,
    {
      isStart: true,
      shouldStart: true,
      targetID: targetEntity.itemID,
      effectStartTime: startTime,
      duration: TRACTOR_BEAM_EFFECT_DURATION_MS,
      repeat: TRACTOR_BEAM_EFFECT_REPEAT,
    },
  );
  const velocityChange = buildModuleAttributeChangeEvent(
    state && state.ownerID,
    targetEntity.itemID,
    TRACTOR_TARGET_MAX_SPEED_ATTRIBUTE_ID,
    tractorVelocity,
    tractorVelocity,
    startTime,
  );
  for (const session of listInterestedSessions(scene, [state.ownerID, state.deployerCharacterID])) {
    sendOnMultiEventPairs(session, [
      { event: godmaEffect, time: startTime },
      { event: velocityChange, time: startTime },
    ]);
  }

  return {
    startTime,
  };
}

function broadcastMobileTractorUnitTractorStop(
  scene,
  entity,
  targetEntity,
  presentationState,
  nowMs,
) {
  if (!scene || !entity || !targetEntity) {
    return false;
  }

  let stopped = false;
  if (typeof scene.broadcastSpecialFx === "function") {
    try {
      scene.broadcastSpecialFx(entity.itemID, TRACTOR_BEAM_EFFECT_GUID, {
        moduleID: entity.itemID,
        moduleTypeID: entity.typeID,
        targetID: targetEntity.itemID,
        isOffensive: false,
        start: false,
        active: true,
        duration: TRACTOR_BEAM_EFFECT_DURATION_MS,
        repeat: TRACTOR_BEAM_EFFECT_REPEAT,
        startTime: presentationState && presentationState.startTime,
        timeFromStart: 0,
      }, entity);
      stopped = true;
    } catch (error) {
      log.warn(
        `[MobileTractorUnit] Tractor stop FX failed tractorUnit=${entity.itemID} target=${targetEntity.itemID} error=${error.message}`,
      );
    }
  }

  queueOrApplyMovementChange(scene, targetEntity, "mobileTractorStop", nowMs, (atMs) => {
    const stopCommand = applyTractorStopCommand({
      targetEntity,
      restoreMaxVelocity: 0,
    });
    if (!stopCommand.applied) {
      return;
    }
    targetEntity.targetEntityID = null;
    targetEntity.followRange = 0;
    if (typeof scene.queueBubbleHistory === "function") {
      try {
        const stamp = captureMobileTractorUnitPresentation({ scene, nowMs: atMs });
        scene.queueBubbleHistory([
          ...stopCommand.buildRestoreSpeedUpdates({ stamp }),
          ...stopCommand.buildStopUpdates({ stamp }),
        ]);
      } catch (error) {
        log.warn(
          `[MobileTractorUnit] Tractor stop movement broadcast failed tractorUnit=${entity.itemID} target=${targetEntity.itemID} error=${error.message}`,
        );
      }
    }
    if (typeof scene.persistDynamicEntity === "function") {
      try {
        scene.persistDynamicEntity(targetEntity);
      } catch (error) {
        log.warn(
          `[MobileTractorUnit] Tractor stop persistence failed tractorUnit=${entity.itemID} target=${targetEntity.itemID} error=${error.message}`,
        );
      }
    }
  });
  stopped = true;

  return stopped;
}

function buildEmptyLootTransferResult() {
  return {
    success: true,
    failedItemCount: 0,
    failedItemID: 0,
    capacitySkippedItemCount: 0,
    changes: [],
    movedItemCount: 0,
  };
}

function getMobileTractorUnitCycleMs(state) {
  return Math.max(
    1,
    toReal(state && state.cycleTimeSeconds, MOBILE_TRACTOR_UNIT_CYCLE_TIME_SECONDS),
  ) * 1000;
}

function clearPendingMobileTractorUnitPull(state, nowMs, options = {}) {
  const cycleMs = getMobileTractorUnitCycleMs(state);
  tractorBeamStartTimes.delete(toInt(state && state.tractorUnitID, 0));
  return updateMobileTractorUnitState(state.tractorUnitID, (currentState) => ({
    ...currentState,
    lastCycleAtMs: nowMs,
    lastTractorTargetID: toInt(options.lastTractorTargetID, 0),
    tractorTargetID: 0,
    tractorStartedAtMs: 0,
    nextCycleAtMs: nowMs + cycleMs,
  }));
}

function startMobileTractorUnitPull(scene, entity, state, nowMs) {
  const target = findNearestTractorTarget(scene, entity, state, nowMs);
  const targetEntity = target && target.entity ? target.entity : null;
  const cycleMs = getMobileTractorUnitCycleMs(state);

  if (!targetEntity) {
    clearPendingMobileTractorUnitPull(state, nowMs);
    return buildEmptyLootTransferResult();
  }

  const tractorPresentation = broadcastMobileTractorUnitTractorStart(
    scene,
    entity,
    targetEntity,
    state,
    nowMs,
  );
  if (!tractorPresentation) {
    clearPendingMobileTractorUnitPull(state, nowMs);
    return buildEmptyLootTransferResult();
  }

  tractorBeamStartTimes.set(toInt(state.tractorUnitID, 0), tractorPresentation.startTime);
  const stateUpdateResult = updateMobileTractorUnitState(state.tractorUnitID, (currentState) => ({
    ...currentState,
    lastCycleAtMs: nowMs,
    lastTractorTargetID: toInt(targetEntity.itemID, 0),
    tractorTargetID: toInt(targetEntity.itemID, 0),
    tractorStartedAtMs: nowMs,
    nextCycleAtMs: nowMs + cycleMs,
  }));
  if (!stateUpdateResult.success) {
    broadcastMobileTractorUnitTractorStop(
      scene,
      entity,
      targetEntity,
      tractorPresentation,
      nowMs,
    );
    tractorBeamStartTimes.delete(toInt(state.tractorUnitID, 0));
    return {
      success: false,
      errorMsg: stateUpdateResult.errorMsg || "MOBILE_TRACTOR_UNIT_STATE_UPDATE_FAILED",
      changes: [],
      movedItemCount: 0,
    };
  }

  return buildEmptyLootTransferResult();
}

function processMobileTractorUnitCycle(scene, entity, item, state, nowMs) {
  const normalizedNowMs = toInt(nowMs, Date.now());
  if (toInt(state && state.nextCycleAtMs, 0) > normalizedNowMs) {
    return buildEmptyLootTransferResult();
  }

  const pendingTargetID = toInt(state && state.tractorTargetID, 0);
  if (pendingTargetID <= 0) {
    return startMobileTractorUnitPull(scene, entity, state, normalizedNowMs);
  }

  const targetEntity = scene && typeof scene.getEntityByID === "function"
    ? scene.getEntityByID(pendingTargetID)
    : null;
  const surfaceDistance = targetEntity
    ? getEntitySurfaceDistance(entity, targetEntity)
    : Number.POSITIVE_INFINITY;
  const targetStillValid = Boolean(
    targetEntity &&
      isTractorableTarget(targetEntity) &&
      canEntitiesInteractLocally(entity, targetEntity) &&
      // A wreck is still worth delivering once its loot is gone, whether it
      // spawned that way or someone hand-looted it mid-flight. A container that
      // runs dry has nothing left to bring in, so its pull is dropped.
      (hasTargetLoot(targetEntity) || isSalvageHaulTarget(targetEntity)) &&
      // Still ours to pull. Running dry used to end a stolen pull by itself,
      // because the thief looted what was left; a wreck never ends that way, so
      // read the beam directly. Another tractor unit or a fitted beam that took
      // the ball will never bring it here, and the unit would sit on a target
      // that cannot arrive. Dropping it costs one cycle and re-selects.
      toInt(targetEntity.targetEntityID, 0) === toInt(entity.itemID, 0) &&
      // Loot rights can lapse between the pull and the collection cycle.
      isMobileTractorUnitLootTargetEntitled(
        targetEntity,
        buildMobileTractorUnitOwnerSession(state),
      ) &&
      surfaceDistance <= Math.max(0, toReal(state.rangeMeters, 0)) + 1e-7,
  );
  if (!targetStillValid) {
    stopPendingMobileTractorUnitPull(item, state, normalizedNowMs, scene);
    clearPendingMobileTractorUnitPull(state, normalizedNowMs);
    return buildEmptyLootTransferResult();
  }

  if (surfaceDistance > MOBILE_TRACTOR_UNIT_COLLECTION_RANGE_METERS + 1e-7) {
    const cycleMs = getMobileTractorUnitCycleMs(state);
    updateMobileTractorUnitState(state.tractorUnitID, (currentState) => ({
      ...currentState,
      lastCycleAtMs: normalizedNowMs,
      lastTractorTargetID: pendingTargetID,
      nextCycleAtMs: normalizedNowMs + cycleMs,
    }));
    return buildEmptyLootTransferResult();
  }

  let transferResult = buildEmptyLootTransferResult();

  if (targetEntity) {
    try {
      transferResult = targetEntity.nativeNpcWreck === true
        ? transferNativeTargetLootToMtu(
          targetEntity,
          state.tractorUnitID,
          state.ownerID,
          state.holdCapacity,
        )
        : transferInventoryTargetLootToMtu(
          targetEntity,
          state.tractorUnitID,
          state.ownerID,
          state.holdCapacity,
        );
    } catch (error) {
      transferResult = {
        success: false,
        errorMsg: error && error.message
          ? error.message
          : "MOBILE_TRACTOR_UNIT_LOOT_TRANSFER_FAILED",
        failedItemCount: 1,
        failedItemID: 0,
        capacitySkippedItemCount: 0,
        changes: [],
        movedItemCount: 0,
      };
    }
    if (!transferResult.success) {
      const movedItemCount = toInt(transferResult.movedItemCount, 0);
      const backoff = registerMobileTractorUnitLootFailure(
        state.tractorUnitID,
        targetEntity.itemID,
        normalizedNowMs,
        movedItemCount > 0,
      );
      log.warn(
        `[MobileTractorUnit] Loot cycle failed tractorUnit=${state.tractorUnitID} target=${targetEntity.itemID} item=${toInt(transferResult.failedItemID, 0)} error=${transferResult.errorMsg} failedItems=${toInt(transferResult.failedItemCount, 0)} movedItems=${movedItemCount} consecutiveFailures=${backoff.failures}${backoff.blockedUntilMs > 0 ? ` deprioritisedForMs=${backoff.blockedUntilMs - normalizedNowMs}` : ""}`,
      );
    } else if (toInt(transferResult.movedItemCount, 0) > 0) {
      clearLootTargetFailure(state.tractorUnitID, targetEntity.itemID);
    } else if (toInt(transferResult.capacitySkippedItemCount, 0) > 0) {
      // Nothing refused and nothing moved: the hold had no room for anything
      // the target still holds. An almost-full unit would otherwise jam on the
      // nearest target forever and never reach farther ones whose loot does
      // fit, so a wasted cycle counts toward the same backoff as a refusal.
      const backoff = registerMobileTractorUnitLootFailure(
        state.tractorUnitID,
        targetEntity.itemID,
        normalizedNowMs,
        false,
      );
      log.debug(
        `[MobileTractorUnit] Loot cycle moved nothing tractorUnit=${state.tractorUnitID} target=${targetEntity.itemID} reason=hold-full skippedItems=${toInt(transferResult.capacitySkippedItemCount, 0)} consecutiveFailures=${backoff.failures}${backoff.blockedUntilMs > 0 ? ` deprioritisedForMs=${backoff.blockedUntilMs - normalizedNowMs}` : ""}`,
      );
    } else if (isSalvageHaulTarget(targetEntity)) {
      // Delivered, with nothing aboard and nothing refused: the haul was the
      // whole point and it is done. Never pull this one again.
      registerCompletedEmptyHaul(state.tractorUnitID, targetEntity.itemID);
    }
  }

  const cycleMs = getMobileTractorUnitCycleMs(state);
  updateMobileTractorUnitState(state.tractorUnitID, (currentState) => ({
    ...currentState,
    lastCycleAtMs: normalizedNowMs,
    lastLootMoveAtMs:
      transferResult.movedItemCount > 0
        ? normalizedNowMs
        : toInt(currentState.lastLootMoveAtMs, 0),
    lastTractorTargetID: targetEntity ? toInt(targetEntity.itemID, 0) : 0,
    tractorTargetID: 0,
    tractorStartedAtMs: 0,
    movedItemCount:
      toInt(currentState.movedItemCount, 0) + toInt(transferResult.movedItemCount, 0),
    nextCycleAtMs: normalizedNowMs + cycleMs,
  }));

  if (transferResult.changes.length > 0) {
    syncInventoryChangesToInterestedSessions(
      scene,
      [state.ownerID, state.deployerCharacterID],
      transferResult.changes,
      { idType: "shipid" },
    );
    if (scene && typeof scene.refreshInventoryBackedEntityPresentation === "function") {
      scene.refreshInventoryBackedEntityPresentation(state.tractorUnitID, { broadcast: true });
      if (targetEntity && targetEntity.nativeNpcWreck !== true) {
        scene.refreshInventoryBackedEntityPresentation(targetEntity.itemID, { broadcast: true });
      }
    }
  }

  stopPendingMobileTractorUnitPull(item, state, normalizedNowMs, scene);

  if (transferResult.changes.length > 0) {
    if (targetEntity && targetEntity.nativeNpcWreck === true) {
      getNativeNpcWreckService().refreshNativeWreckRuntimeEntity(
        state.solarSystemID,
        targetEntity.itemID,
        { broadcast: true },
      );
    }
    if (targetEntity && targetEntity.nativeNpcWreck !== true) {
      const cleanupSession = listInterestedSessions(scene, [state.ownerID, state.deployerCharacterID])[0];
      getMaybeExpireEmptySpaceContainer()(cleanupSession, targetEntity.itemID);
    }
  }

  return transferResult;
}

function tickScene(scene, nowMs = Date.now()) {
  if (!scene || typeof scene.getDynamicEntities !== "function") {
    return;
  }
  for (const entity of scene.getDynamicEntities()) {
    if (!entity || entity.kind !== "deployable" || !isMobileTractorUnitType(entity)) {
      continue;
    }
    const item = findItemById(entity.itemID);
    const state = getMobileTractorUnitStateFromItem(item);
    if (!state) {
      continue;
    }
    if (resolveAbyssalDeployableItemRestriction(item, state)) {
      clearMobileTractorUnit(item, "abyssal-authority-forbidden");
      continue;
    }
    if (state.expiresAtMs > 0 && state.expiresAtMs <= nowMs) {
      expireMobileTractorUnit(state.tractorUnitID, "expired");
      continue;
    }
    if (!isActiveTractorUnitState(state, nowMs)) {
      continue;
    }
    if (state.active !== true) {
      activateMobileTractorUnit(state.tractorUnitID);
      continue;
    }
    if (state.nextCycleAtMs > 0 && state.nextCycleAtMs > nowMs) {
      continue;
    }
    processMobileTractorUnitCycle(scene, entity, item, state, nowMs);
  }
}

module.exports = {
  CATEGORY_DEPLOYABLE,
  GROUP_MOBILE_TRACTOR_UNIT,
  MOBILE_TRACTOR_UNIT_ACTIVATION_DELAY_MS,
  MOBILE_TRACTOR_UNIT_LIFETIME_MS,
  MOBILE_TRACTOR_UNIT_CYCLE_TIME_SECONDS,
  MOBILE_TRACTOR_UNIT_DEFAULT_RANGE_METERS,
  MOBILE_TRACTOR_UNIT_SCOOP_RANGE_METERS,
  MOBILE_TRACTOR_UNIT_COLLECTION_RANGE_METERS,
  isMobileTractorUnitType,
  validateMobileTractorUnitCargoAccess,
  launchMobileTractorUnitFromShip,
  scoopMobileTractorUnitToCargo,
  registerMobileTractorUnitItem,
  clearMobileTractorUnit,
  getMobileTractorUnitStateFromItem,
  getMobileTractorUnitTickDeadlineMs,
  hydrateMobileTractorUnitEntityFromInventoryItem,
  tickScene,
  _testing: {
    buildDeployableSpawnState,
    buildCustomInfoWithState,
    buildCustomInfoWithoutState,
    getStateFromCustomInfo,
    findPlacementConflict,
    resolveMobileTractorUnitStats,
    validateMobileTractorUnitScoop,
    getMoveQuantityForFreeVolume,
    buildMobileTractorUnitLootSource,
    findNearestTractorTarget,
    processMobileTractorUnitCycle,
    getTractorBeamStartTime: (tractorUnitID) => (
      tractorBeamStartTimes.get(toInt(tractorUnitID, 0)) || null
    ),
    getTractorBeamStartTimeCount: () => tractorBeamStartTimes.size,
    getLootFailureRecord,
    isLootTargetDeprioritised,
    clearLootTargetFailures,
    hasCompletedEmptyHaul,
    clearCompletedEmptyHauls,
    MOBILE_TRACTOR_UNIT_TARGET_FAILURE_LIMIT,
    MOBILE_TRACTOR_UNIT_TARGET_BACKOFF_MS,
  },
};
