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
  findItemById,
  getItemMetadata,
  listSystemSpaceItems,
  updateInventoryItem,
} = require(path.join(__dirname, "../inventory/itemStore"));
const mobileItemCustody = require(path.join(__dirname, "../inventory/mobileItemCustody"));
const worldData = require(path.join(__dirname, "../../space/worldData"));
const { getMicroJumpDriverComponentAttributes } = require("../_shared/clientSpaceComponentRules");
const { resolveSessionCharacterID } = require("../_shared/sessionIdentity");
const { isEntityMicroJumpDriveBlocked } = require("../../space/runtime/microJumpDriveEligibility");

// Player structures live in structureState, required on use as worldData used to, so this
// file does not load the structure runtime and works where nothing else has loaded it.
function getStructureState() {
  return require(path.join(__dirname, "../structure/structureState"));
}

const CATEGORY_DEPLOYABLE = 22;
const CATEGORY_STATION = 3;
const CATEGORY_STARBASE = 23;
const CATEGORY_UPWELL_STRUCTURE = 65;
const GROUP_STARGATE = 10;
const GROUP_CONTROL_TOWER = 365;
const GROUP_MOBILE_MICRO_JUMP_UNIT = 1276;
const TYPE_MOBILE_MICRO_JUMP_UNIT = 33591;

const DEPLOY_DISTANCE_METERS = 2_500;
const MOBILE_MICRO_JUMP_UNIT_ACTIVATION_DELAY_MS = 60 * 1000;
const MOBILE_MICRO_JUMP_UNIT_LIFETIME_MS = 48 * 60 * 60 * 1000;
const MOBILE_MICRO_JUMP_UNIT_USE_RANGE_METERS = 5_000;
const MOBILE_MICRO_JUMP_UNIT_SPOOLUP_MS = 12 * 1000;
const MOBILE_MICRO_JUMP_UNIT_JUMP_DISTANCE_METERS = 100_000;
const MOBILE_MICRO_JUMP_UNIT_MAX_SHIP_MASS_KG = 1_000_000_000;
const MOBILE_MICRO_JUMP_UNIT_MIN_DISTANCE_FROM_OWN_GROUP_METERS = 6_000;
const MOBILE_MICRO_JUMP_UNIT_MIN_DISTANCE_FROM_STATION_STARGATE_UPWELL_METERS = 20_000;
const MOBILE_MICRO_JUMP_UNIT_MIN_DISTANCE_FROM_CONTROL_TOWER_METERS = 40_000;
const CUSTOM_INFO_KEY = "evejsMobileMicroJumpUnit";

const timersByUnitID = new Map();

function toInt(value, fallback = 0) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? Math.trunc(numericValue) : fallback;
}

function toReal(value, fallback = 0) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : fallback;
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

function getSyncInventoryItemForSession() {
  const characterState = require(path.join(__dirname, "../character/characterState"));
  return characterState.syncInventoryItemForSession;
}

function isMobileMicroJumpUnitType(typeIDOrItem) {
  if (typeIDOrItem && typeof typeIDOrItem === "object") {
    return (
      toInt(typeIDOrItem.categoryID, 0) === CATEGORY_DEPLOYABLE &&
      toInt(typeIDOrItem.groupID, 0) === GROUP_MOBILE_MICRO_JUMP_UNIT
    ) || toInt(typeIDOrItem.typeID, 0) === TYPE_MOBILE_MICRO_JUMP_UNIT;
  }
  return toInt(typeIDOrItem, 0) === TYPE_MOBILE_MICRO_JUMP_UNIT;
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
    unitID: toInt(state.unitID, 0),
    deployedAtMs: toInt(state.deployedAtMs, 0),
    activateAtMs: toInt(state.activateAtMs, 0),
    activatedAtMs: toInt(state.activatedAtMs, 0),
    expiresAtMs: toInt(state.expiresAtMs, 0),
    active: state.active === true,
    deactivatedAtMs: toInt(state.deactivatedAtMs, 0),
    lastJumpStartedAtMs: toInt(state.lastJumpStartedAtMs, 0),
    lastJumpStartedAtFileTime:
      state.lastJumpStartedAtFileTime === undefined ||
      state.lastJumpStartedAtFileTime === null
        ? null
        : String(state.lastJumpStartedAtFileTime),
  };
}

function getMobileMicroJumpUnitStateFromItem(item) {
  if (!item || !isMobileMicroJumpUnitType(item)) {
    return null;
  }
  const state = getStateFromCustomInfo(item.customInfo);
  if (!state || state.unitID <= 0) {
    return null;
  }
  return state;
}

function buildCustomInfoWithState(customInfo, state) {
  const parsed = parseCustomInfo(customInfo);
  parsed[CUSTOM_INFO_KEY] = {
    ownerID: toInt(state.ownerID, 0),
    deployerCharacterID: toInt(state.deployerCharacterID, 0),
    solarSystemID: toInt(state.solarSystemID, 0),
    unitID: toInt(state.unitID, 0),
    deployedAtMs: toInt(state.deployedAtMs, 0),
    activateAtMs: toInt(state.activateAtMs, 0),
    activatedAtMs: toInt(state.activatedAtMs, 0),
    expiresAtMs: toInt(state.expiresAtMs, 0),
    active: state.active === true,
    deactivatedAtMs: toInt(state.deactivatedAtMs, 0),
    lastJumpStartedAtMs: toInt(state.lastJumpStartedAtMs, 0),
    lastJumpStartedAtFileTime:
      state.lastJumpStartedAtFileTime === undefined ||
      state.lastJumpStartedAtFileTime === null
        ? null
        : String(state.lastJumpStartedAtFileTime),
  };
  return JSON.stringify(parsed);
}

function syncInventoryChange(session, item, previousData) {
  const syncInventoryItemForSession = getSyncInventoryItemForSession();
  if (typeof syncInventoryItemForSession !== "function") {
    return;
  }
  syncInventoryItemForSession(
    session,
    item,
    previousData || {},
    { emitCfgLocation: true },
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

function hasFiniteVectorCoordinates(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      Number.isFinite(Number(value.x)) &&
      Number.isFinite(Number(value.y)) &&
      Number.isFinite(Number(value.z)),
  );
}

function getObjectPosition(source) {
  if (!source || typeof source !== "object") {
    return null;
  }
  const candidates = [
    source.spaceState && source.spaceState.position,
    source.position,
    source,
  ];
  for (const candidate of candidates) {
    if (hasFiniteVectorCoordinates(candidate)) {
      return normalizeVector(candidate);
    }
  }
  return null;
}

function getObjectItemID(source) {
  return toInt(
    source && (
      source.itemID ||
      source.stationID ||
      source.stargateID ||
      source.structureID ||
      source.entityID ||
      source.id
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
  if (isMobileMicroJumpUnitType(source)) {
    return "mobileMicroJumpUnit";
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
  if (groupID === GROUP_CONTROL_TOWER || categoryID === CATEGORY_STARBASE) {
    return "controlTower";
  }
  return null;
}

function getPlacementBlockerMinimumDistance(kind) {
  if (kind === "mobileMicroJumpUnit") {
    return MOBILE_MICRO_JUMP_UNIT_MIN_DISTANCE_FROM_OWN_GROUP_METERS;
  }
  if (kind === "stationStargateUpwell") {
    return MOBILE_MICRO_JUMP_UNIT_MIN_DISTANCE_FROM_STATION_STARGATE_UPWELL_METERS;
  }
  if (kind === "controlTower") {
    return MOBILE_MICRO_JUMP_UNIT_MIN_DISTANCE_FROM_CONTROL_TOWER_METERS;
  }
  return 0;
}

function getPlacementConflictError(kind) {
  if (kind === "mobileMicroJumpUnit") {
    return "MOBILE_MICRO_JUMP_UNIT_TOO_CLOSE_TO_UNIT";
  }
  if (kind === "stationStargateUpwell") {
    return "MOBILE_MICRO_JUMP_UNIT_TOO_CLOSE_TO_STATION_STARGATE_OR_UPWELL";
  }
  if (kind === "controlTower") {
    return "MOBILE_MICRO_JUMP_UNIT_TOO_CLOSE_TO_CONTROL_TOWER";
  }
  return "MOBILE_MICRO_JUMP_UNIT_DEPLOYMENT_BLOCKED";
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
      {
        ...source,
        itemID: source && (source.itemID || source.stationID || source.stargateID || source.structureID),
      },
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
    append(
      {
        ...structure,
        itemID: structure.structureID || structure.itemID,
      },
    );
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
      errorMsg: "MOBILE_MICRO_JUMP_UNIT_DEPLOY_POSITION_UNAVAILABLE",
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

function updateMobileMicroJumpUnitState(itemID, updater) {
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
      errorMsg: "MOBILE_MICRO_JUMP_UNIT_STATE_NOT_FOUND",
    };
  }
  const nextState =
    typeof updater === "function" ? updater({ ...currentState }, item) : updater;
  return updateInventoryItem(itemID, (currentItem) => ({
    ...currentItem,
    customInfo: buildCustomInfoWithState(currentItem.customInfo, nextState),
  }));
}

function clearUnitTimers(unitID) {
  const normalizedUnitID = toInt(unitID, 0);
  const timerState = timersByUnitID.get(normalizedUnitID);
  if (timerState) {
    if (timerState.activationTimer) {
      clearTimeout(timerState.activationTimer);
    }
    if (timerState.expiryTimer) {
      clearTimeout(timerState.expiryTimer);
    }
    timersByUnitID.delete(normalizedUnitID);
  }
}

function setUnrefTimeout(callback, delayMs) {
  const timer = setTimeout(callback, Math.max(0, toInt(delayMs, 0)));
  if (typeof timer.unref === "function") {
    timer.unref();
  }
  return timer;
}

function clearMobileMicroJumpUnit(itemOrID, reason = "cleared") {
  const itemID = toInt(itemOrID && itemOrID.itemID ? itemOrID.itemID : itemOrID, 0);
  if (!itemID) {
    return false;
  }
  clearUnitTimers(itemID);

  for (const scene of getSpaceRuntime().scenes.values()) {
    const unit = scene.getEntityByID(itemID);
    if (unit) clearSpoolsForEntity(scene, unit);
  }

  const item = itemOrID && itemOrID.itemID ? itemOrID : findItemById(itemID);
  const state = getMobileMicroJumpUnitStateFromItem(item);
  if (!state) {
    return false;
  }

  if (findItemById(itemID)) {
    updateMobileMicroJumpUnitState(itemID, (currentState) => ({
      ...currentState,
      active: false,
      deactivatedAtMs: Date.now(),
    }));
  }
  log.info(`[MobileMicroJumpUnit] Cleared unit=${itemID} reason=${reason}`);
  return true;
}

function activateMobileMicroJumpUnit(itemID) {
  const item = findItemById(itemID);
  const state = getMobileMicroJumpUnitStateFromItem(item);
  if (!state) {
    clearUnitTimers(itemID);
    return false;
  }
  if (resolveAbyssalDeployableItemRestriction(item, state)) {
    clearMobileMicroJumpUnit(item, "abyssal-authority-forbidden");
    return false;
  }

  const now = Date.now();
  if (state.expiresAtMs > 0 && state.expiresAtMs <= now) {
    expireMobileMicroJumpUnit(itemID, "expired-before-activation");
    return false;
  }
  if (
    toInt(item.locationID, 0) !== state.solarSystemID ||
    toInt(item.flagID, 0) !== 0 ||
    !item.spaceState
  ) {
    clearMobileMicroJumpUnit(item, "removed-before-activation");
    return false;
  }

  updateMobileMicroJumpUnitState(itemID, (currentState) => ({
    ...currentState,
    active: true,
    activatedAtMs: now,
  }));
  getSpaceRuntime().refreshInventoryBackedEntityPresentation(state.solarSystemID, itemID);
  scheduleMobileMicroJumpUnitTimers(itemID);
  log.info(
    `[MobileMicroJumpUnit] Activated unit=${itemID} system=${state.solarSystemID}`,
  );
  return true;
}

function expireMobileMicroJumpUnit(itemID, reason = "expired") {
  const item = findItemById(itemID);
  const state = getMobileMicroJumpUnitStateFromItem(item);
  const systemID = toInt(
    state && state.solarSystemID,
    toInt(item && item.locationID, 0),
  );
  clearUnitTimers(itemID);

  const removeResult = mobileItemCustody.expireInSpace({
    runtime: getSpaceRuntime(),
    item,
    systemID,
  });
  if (removeResult && removeResult.success) {
    log.info(`[MobileMicroJumpUnit] Removed unit=${itemID} reason=${reason}`);
    return true;
  }
  return false;
}

function scheduleMobileMicroJumpUnitTimers(itemOrID) {
  const itemID = toInt(itemOrID && itemOrID.itemID ? itemOrID.itemID : itemOrID, 0);
  const item = itemOrID && itemOrID.itemID ? itemOrID : findItemById(itemID);
  const state = getMobileMicroJumpUnitStateFromItem(item);
  if (!state) {
    clearUnitTimers(itemID);
    return false;
  }
  if (resolveAbyssalDeployableItemRestriction(item, state)) {
    clearMobileMicroJumpUnit(item, "abyssal-authority-forbidden");
    return false;
  }

  clearUnitTimers(itemID);

  const now = Date.now();
  const nextTimers = {
    activationTimer: null,
    expiryTimer: null,
  };

  if (state.expiresAtMs > 0) {
    nextTimers.expiryTimer = setUnrefTimeout(
      () => expireMobileMicroJumpUnit(itemID, "expired"),
      state.expiresAtMs - now,
    );
  }

  if (state.active || state.activateAtMs <= now) {
    if (!state.active) {
      nextTimers.activationTimer = setUnrefTimeout(
        () => activateMobileMicroJumpUnit(itemID),
        0,
      );
    }
  } else {
    nextTimers.activationTimer = setUnrefTimeout(
      () => activateMobileMicroJumpUnit(itemID),
      state.activateAtMs - now,
    );
  }

  timersByUnitID.set(itemID, nextTimers);
  return true;
}

function registerMobileMicroJumpUnitItem(itemOrID) {
  return scheduleMobileMicroJumpUnitTimers(itemOrID);
}

function isActiveMobileMicroJumpUnitState(state, nowMs = Date.now()) {
  if (!state || state.deactivatedAtMs > 0) {
    return false;
  }
  if (state.expiresAtMs > 0 && state.expiresAtMs <= nowMs) {
    return false;
  }
  return state.active === true || (state.activateAtMs > 0 && state.activateAtMs <= nowMs);
}

function hydrateMobileMicroJumpUnitEntityFromInventoryItem(entity, itemRecord) {
  if (!entity || !isMobileMicroJumpUnitType(itemRecord)) {
    return entity;
  }

  const state = getMobileMicroJumpUnitStateFromItem(itemRecord);
  if (!state) {
    return entity;
  }

  if (resolveAbyssalDeployableItemRestriction(itemRecord, state)) {
    entity.component_activate = [false, null];
    entity.activate_comp_durationSeconds = Math.trunc(
      MOBILE_MICRO_JUMP_UNIT_ACTIVATION_DELAY_MS / 1000,
    );
    delete entity.component_microJumpDriver;
    return entity;
  }

  const active = isActiveMobileMicroJumpUnitState(state, Date.now());
  entity.component_activate = [active, active ? null : state.activateAtMs];
  entity.activate_comp_durationSeconds = Math.trunc(
    MOBILE_MICRO_JUMP_UNIT_ACTIVATION_DELAY_MS / 1000,
  );
  // The persisted timestamp is historical diagnostics, not a resumable jump.
  // Only an activation owned by this exact live scene/entity grants the slim.
  if (entity.mobileMicroJumpSpoolStartFileTime) {
    entity.component_microJumpDriver = entity.mobileMicroJumpSpoolStartFileTime;
  } else {
    entity.component_microJumpDriver = null;
  }
  const rules = getMicroJumpDriverComponentAttributes(itemRecord.typeID);
  entity.microJumpDriverUseRangeMeters = rules ? rules.interactionRange : 0;
  entity.microJumpDriverSpoolupMs = rules ? rules.spoolUpDurationMillisec : 0;
  return entity;
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

function validateMobileMicroJumpUnitLaunch(item, context) {
  if (!context.characterID || !context.ownerID || !context.shipID || !context.systemID) {
    return "INVALID_SESSION";
  }
  if (!item) {
    return "ITEM_NOT_FOUND";
  }
  if (!isMobileMicroJumpUnitType(item)) {
    return "ITEM_NOT_MOBILE_MICRO_JUMP_UNIT";
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

function launchMobileMicroJumpUnitFromShip(session, itemID, options = {}) {
  const context = getSessionContext(session, options);
  const item = findItemById(itemID);
  const validationError = validateMobileMicroJumpUnitLaunch(item, context);
  if (validationError) {
    return {
      success: false,
      errorMsg: validationError,
    };
  }

  const spawnState = buildDeployableSpawnState(session, context);
  const placementConflict = findPlacementConflict(session, item, context, spawnState);
  if (placementConflict) {
    log.info(
      `[MobileMicroJumpUnit] Launch rejected char=${context.characterID} item=${item.itemID} system=${context.systemID} reason=${placementConflict.errorMsg}`,
    );
    return {
      success: false,
      errorMsg: placementConflict.errorMsg,
    };
  }

  const sourceTypeID = toInt(item.typeID, 0);
  const transferResult = mobileItemCustody.deployFromShip({
    item,
    position: spawnState.position,
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
  const state = {
    ownerID: context.ownerID,
    deployerCharacterID: context.characterID,
    solarSystemID: context.systemID,
    unitID: launchedItemID,
    deployedAtMs: now,
    activateAtMs: now + MOBILE_MICRO_JUMP_UNIT_ACTIVATION_DELAY_MS,
    activatedAtMs: 0,
    expiresAtMs: now + MOBILE_MICRO_JUMP_UNIT_LIFETIME_MS,
    active: false,
    deactivatedAtMs: 0,
    lastJumpStartedAtMs: 0,
    lastJumpStartedAtFileTime: null,
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
  );

  const spawnResult = getSpaceRuntime().spawnDynamicInventoryEntity(context.systemID, launchedItemID);
  if (!spawnResult || !spawnResult.success) {
    log.warn(
      `[MobileMicroJumpUnit] Launched unit ${launchedItemID} but space spawn failed: ${spawnResult ? spawnResult.errorMsg : "UNKNOWN"}`,
    );
  }

  registerMobileMicroJumpUnitItem(updatedResult.data);
  log.info(
    `[MobileMicroJumpUnit] char=${context.characterID} launched unit itemID=${launchedItemID} system=${context.systemID}`,
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

function getEntitySurfaceDistance(left, right) {
  const leftPosition = getObjectPosition(left);
  const rightPosition = getObjectPosition(right);
  if (!leftPosition || !rightPosition) {
    return Number.POSITIVE_INFINITY;
  }
  const leftRadius = firstPositiveReal([
    left && left.radius,
    left && left.spaceRadius,
  ]);
  const rightRadius = firstPositiveReal([
    right && right.radius,
    right && right.spaceRadius,
  ]);
  return Math.max(0, getVectorDistance(leftPosition, rightPosition) - leftRadius - rightRadius);
}

function resolveShipMassKg(shipEntity, shipItem = null) {
  const metadata = shipItem && shipItem.typeID ? getItemMetadata(shipItem.typeID) : null;
  // Runtime mass already incorporates fitting/propulsion dogma. A base-type
  // maximum would incorrectly discard a legitimate reduced effective mass.
  return firstPositiveReal([shipEntity && shipEntity.mass,
    shipItem && shipItem.mass, metadata && metadata.mass]);
}

function isShipCloaked(entity) {
  if (!entity) {
    return false;
  }
  if (entity.cloaked === true) {
    return true;
  }
  if (toInt(entity.isCloaked, 0) > 0 || toInt(entity.cloakMode, 0) > 0) {
    return true;
  }
  if (typeof entity.cloakState === "number") {
    return toInt(entity.cloakState, 0) > 0;
  }
  if (entity.cloakState && typeof entity.cloakState === "object") {
    return (
      entity.cloakState.active === true ||
      String(entity.cloakState.state || "").toLowerCase() === "active" ||
      toInt(entity.cloakState.mode, 0) > 0
    );
  }
  return false;
}

function resolveActiveUnit(session, unitID) {
  const numericUnitID = toInt(unitID, 0);
  if (numericUnitID <= 0) {
    return {
      success: false,
      errorMsg: "MOBILE_MICRO_JUMP_UNIT_NOT_FOUND",
    };
  }

  const item = findItemById(numericUnitID);
  const state = getMobileMicroJumpUnitStateFromItem(item);
  if (resolveAbyssalDeployableItemRestriction(item, state)) {
    clearMobileMicroJumpUnit(item, "abyssal-authority-forbidden");
    return {
      success: false,
      errorMsg: "MOBILE_MICRO_JUMP_UNIT_NOT_FOUND",
    };
  }
  if (!item || !state || !isActiveMobileMicroJumpUnitState(state, Date.now())) {
    return {
      success: false,
      errorMsg: "MOBILE_MICRO_JUMP_UNIT_NOT_ACTIVE",
    };
  }

  const scene = getSpaceRuntime().getSceneForSession(session);
  const unitEntity = scene && typeof scene.getEntityByID === "function"
    ? scene.getEntityByID(numericUnitID)
    : null;
  const rules = getMicroJumpDriverComponentAttributes(item && item.typeID);
  if (!scene || !unitEntity || !isMobileMicroJumpUnitType(unitEntity) || !rules ||
      unitEntity.typeID !== item.typeID || toInt(item.locationID, 0) !== scene.systemID ||
      toInt(item.flagID, -1) !== 0 || !item.spaceState ||
      toInt(state.unitID, 0) !== numericUnitID) {
    return {
      success: false,
      errorMsg: "MOBILE_MICRO_JUMP_UNIT_NOT_FOUND",
    };
  }

  if (toInt(state.solarSystemID, 0) !== toInt(scene.systemID, 0)) {
    return {
      success: false,
      errorMsg: "MOBILE_MICRO_JUMP_UNIT_WRONG_SYSTEM",
    };
  }

  return {
    success: true,
    data: {
      item,
      scene,
      state,
      unitEntity,
      rules,
    },
  };
}

function validateShipCanUseUnit(session, unitEntity, scene, options = {}) {
  const shipEntity = scene && typeof scene.getShipEntityForSession === "function"
    ? scene.getShipEntityForSession(session)
    : null;
  if (shipEntity && shipEntity.kind === "ship" && !canEntitiesInteractLocally(shipEntity, unitEntity)) {
    return {
      success: false,
      errorMsg: "MOBILE_MICRO_JUMP_UNIT_NOT_FOUND",
    };
  }
  const characterID = resolveSessionCharacterID(session);
  const shipItem = findItemById(shipEntity && shipEntity.itemID);
  if (!characterID || toInt(session && session.userid, 0) <= 0 ||
      !shipEntity || shipEntity.kind !== "ship" || shipEntity.session !== session ||
      session.socket?.destroyed === true ||
      scene.sessions.get(session.clientID) !== session ||
      !shipItem || toInt(shipItem.ownerID, 0) !== characterID) {
    return {
      success: false,
      errorMsg: "SHIP_NOT_FOUND",
    };
  }

  if (isShipCloaked(shipEntity)) {
    return {
      success: false,
      errorMsg: "SHIP_CLOAKED",
    };
  }
  if (shipEntity.mode === "WARP") {
    return { success: false, errorMsg: "SHIP_WARPING" };
  }
  if (isEntityMicroJumpDriveBlocked(shipEntity, scene.getCurrentSimTimeMs())) {
    return {
      success: false,
      errorMsg: "MICRO_JUMP_DRIVE_BLOCKED",
    };
  }

  const rules = getMicroJumpDriverComponentAttributes(unitEntity.typeID);
  if (!rules) return { success: false, errorMsg: "MOBILE_MICRO_JUMP_UNIT_NOT_FOUND" };
  const massKg = resolveShipMassKg(shipEntity, shipItem);
  // Preserve the installed mobile-unit strict mass ceiling.
  if (massKg >= rules.maxShipMass) {
    return { success: false, errorMsg: "SHIP_TOO_MASSIVE_FOR_MOBILE_MICRO_JUMP_UNIT", massKg };
  }
  const surfaceDistance = typeof scene.getEntitySurfaceDistance === "function"
    ? scene.getEntitySurfaceDistance(shipEntity, unitEntity)
    : getEntitySurfaceDistance(shipEntity, unitEntity);
  if (options.allowRangeDeparture !== true && surfaceDistance > rules.interactionRange) {
    return {
      success: false,
      errorMsg: "SHIP_TOO_FAR_FROM_MOBILE_MICRO_JUMP_UNIT",
      surfaceDistance,
    };
  }

  return {
    success: true,
    data: {
      massKg,
      shipEntity,
      shipID: toInt(shipEntity.itemID, 0),
      surfaceDistance,
    },
  };
}

function getSessionFileTimeString(session) {
  const fileTime = getSpaceRuntime().getSimulationFileTimeForSession(session);
  return String(fileTime);
}

function getSceneSpools(scene, create = false) {
  if (!scene) return null;
  if (create && !(scene.mobileMicroJumpSpoolsByShipID instanceof Map)) {
    scene.mobileMicroJumpSpoolsByShipID = new Map();
  }
  return scene.mobileMicroJumpSpoolsByShipID instanceof Map
    ? scene.mobileMicroJumpSpoolsByShipID : null;
}

function clearSpool(scene, spool) {
  const pending = getSceneSpools(scene);
  if (!pending || pending.get(spool.shipID) !== spool) return false;
  pending.delete(spool.shipID);
  const unit = spool.unit;
  if (scene.getEntityByID(spool.unitID) === unit) {
    const remaining = [...pending.values()].filter((entry) => entry.unit === unit);
    const latest = remaining.at(-1);
    if (latest) unit.mobileMicroJumpSpoolStartFileTime = latest.startedAtFileTime;
    else delete unit.mobileMicroJumpSpoolStartFileTime;
    unit.component_microJumpDriver = latest ? latest.startedAtFileTime : null;
    scene.broadcastSlimItemChanges([unit]);
  }
  return true;
}

function clearSpoolsForEntity(scene, entity) {
  for (const spool of [...(getSceneSpools(scene)?.values() || [])]) {
    if (spool.ship === entity || spool.unit === entity) clearSpool(scene, spool);
  }
}

function clearSpoolsForSession(scene, session) {
  for (const spool of [...(getSceneSpools(scene)?.values() || [])]) {
    if (spool.session === session) clearSpool(scene, spool);
  }
}

function handleSessionDisconnected(session) {
  const scene = session && getSpaceRuntime().getSceneForSession(session);
  if (scene) clearSpoolsForSession(scene, session);
}

function disposeScene(scene) {
  for (const spool of [...(getSceneSpools(scene)?.values() || [])]) clearSpool(scene, spool);
}

function spoolIdentityIsCurrent(scene, spool) {
  return scene.getEntityByID(spool.unitID) === spool.unit &&
    scene.getEntityByID(spool.shipID) === spool.ship &&
    scene.sessions.get(spool.session.clientID) === spool.session &&
    getSpaceRuntime().getSceneForSession(spool.session) === scene &&
    scene.getShipEntityForSession(spool.session) === spool.ship &&
    resolveSessionCharacterID(spool.session) === spool.characterID;
}

function completeMobileMicroJumpSpool(scene, spool) {
  const { session, shipID, unitID } = spool;
  if (!spoolIdentityIsCurrent(scene, spool)) {
    clearSpool(scene, spool);
    return false;
  }
  const unitResult = resolveActiveUnit(session, unitID);
  if (!unitResult.success) {
    log.info(
      `[MobileMicroJumpUnit] Spool cancelled ship=${shipID} unit=${unitID} reason=${unitResult.errorMsg}`,
    );
    clearSpool(scene, spool);
    return false;
  }
  const shipResult = validateShipCanUseUnit(session, spool.unit, scene, { allowRangeDeparture: true });
  if (!shipResult.success) {
    log.info(
      `[MobileMicroJumpUnit] Spool cancelled ship=${shipID} unit=${unitID} reason=${shipResult.errorMsg}`,
    );
    clearSpool(scene, spool);
    return false;
  }
  // Remove ownership before invoking motion/FX callbacks: a duplicate tick or
  // callback cannot execute this activation again, including failed motion.
  clearSpool(scene, spool);
  const jumpResult = getSpaceRuntime().executeMobileMicroJumpForShip(session, unitID, {
    jumpDistanceMeters: MOBILE_MICRO_JUMP_UNIT_JUMP_DISTANCE_METERS,
    typeID: spool.unit.typeID,
  });
  if (!jumpResult || !jumpResult.success) {
    log.warn(
      `[MobileMicroJumpUnit] Jump failed ship=${shipID} unit=${unitID}: ${jumpResult ? jumpResult.errorMsg : "UNKNOWN"}`,
    );
    return false;
  }

  log.info(`[MobileMicroJumpUnit] Jumped ship=${shipID} unit=${unitID}`);
  return true;
}

function tickScene(scene) {
  const spools = getSceneSpools(scene);
  if (!spools?.size) return;
  const nowMs = scene.getCurrentSimTimeMs();
  for (const spool of [...spools.values()]) {
    if (!spoolIdentityIsCurrent(scene, spool) ||
        !validateShipCanUseUnit(spool.session, spool.unit, scene, { allowRangeDeparture: true }).success) {
      clearSpool(scene, spool);
    } else if (nowMs >= spool.completeAtMs) {
      completeMobileMicroJumpSpool(scene, spool);
    }
  }
}

function startMobileMicroJumpDriveForShip(session, unitID) {
  const unitResult = resolveActiveUnit(session, unitID);
  if (!unitResult.success) {
    log.info(
      `[MobileMicroJumpUnit] Activation rejected char=${session && session.characterID} unit=${unitID} reason=${unitResult.errorMsg}`,
    );
    return {
      success: false,
      errorMsg: unitResult.errorMsg,
    };
  }

  const { scene, state, unitEntity, rules } = unitResult.data;
  const shipResult = validateShipCanUseUnit(session, unitEntity, scene);
  if (!shipResult.success) {
    log.info(
      `[MobileMicroJumpUnit] Activation rejected char=${session && session.characterID} unit=${unitID} reason=${shipResult.errorMsg}`,
    );
    return shipResult;
  }

  const shipID = shipResult.data.shipID;
  const pending = getSceneSpools(scene, true);
  const existingSpool = pending.get(shipID);
  const now = Date.now();
  if (existingSpool && spoolIdentityIsCurrent(scene, existingSpool)) {
    return {
      success: false,
      errorMsg: "MOBILE_MICRO_JUMP_UNIT_ALREADY_SPOOLING",
    };
  }
  if (existingSpool) clearSpool(scene, existingSpool);

  const lastJumpStartedAtFileTime = getSessionFileTimeString(session);
  const updateResult = updateMobileMicroJumpUnitState(unitID, (currentState) => ({
    ...currentState,
    active: true,
    lastJumpStartedAtMs: now,
    lastJumpStartedAtFileTime,
  }));
  if (!updateResult.success) {
    return updateResult;
  }

  const startedAtSimMs = scene.getCurrentSimTimeMs();
  pending.set(shipID, {
    shipID,
    characterID: resolveSessionCharacterID(session),
    session,
    ship: shipResult.data.shipEntity,
    unit: unitEntity,
    unitID: toInt(unitID, 0),
    startedAtMs: startedAtSimMs,
    startedAtFileTime: lastJumpStartedAtFileTime,
    completeAtMs: startedAtSimMs + rules.spoolUpDurationMillisec,
  });
  unitEntity.mobileMicroJumpSpoolStartFileTime = lastJumpStartedAtFileTime;
  getSpaceRuntime().refreshInventoryBackedEntityPresentation(state.solarSystemID, unitID);

  log.info(
    `[MobileMicroJumpUnit] Started spool ship=${shipID} unit=${unitID} char=${session && session.characterID}`,
  );
  return {
    success: true,
    data: {
      shipID,
      unitID: toInt(unitID, 0),
      startedAtMs: now,
      startedAtFileTime: lastJumpStartedAtFileTime,
      spoolupMs: rules.spoolUpDurationMillisec,
    },
  };
}

module.exports = {
  CATEGORY_DEPLOYABLE,
  GROUP_MOBILE_MICRO_JUMP_UNIT,
  TYPE_MOBILE_MICRO_JUMP_UNIT,
  MOBILE_MICRO_JUMP_UNIT_ACTIVATION_DELAY_MS,
  MOBILE_MICRO_JUMP_UNIT_LIFETIME_MS,
  MOBILE_MICRO_JUMP_UNIT_USE_RANGE_METERS,
  MOBILE_MICRO_JUMP_UNIT_SPOOLUP_MS,
  MOBILE_MICRO_JUMP_UNIT_JUMP_DISTANCE_METERS,
  MOBILE_MICRO_JUMP_UNIT_MAX_SHIP_MASS_KG,
  isMobileMicroJumpUnitType,
  launchMobileMicroJumpUnitFromShip,
  registerMobileMicroJumpUnitItem,
  clearMobileMicroJumpUnit,
  getMobileMicroJumpUnitStateFromItem,
  hydrateMobileMicroJumpUnitEntityFromInventoryItem,
  startMobileMicroJumpDriveForShip,
  tickScene,
  clearSpoolsForEntity,
  clearSpoolsForSession,
  handleSessionDisconnected,
  disposeScene,
  _testing: {
    buildDeployableSpawnState,
    buildCustomInfoWithState,
    getStateFromCustomInfo,
    findPlacementConflict,
    validateShipCanUseUnit,
  },
};
