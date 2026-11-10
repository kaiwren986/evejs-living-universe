"use strict";

const path = require("path");

const {
  buildChildEntityScopeMetadata,
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
  updateInventoryItem,
} = require(path.join(__dirname, "../inventory/itemStore"));
const mobileItemCustody = require(path.join(__dirname, "../inventory/mobileItemCustody"));
const {
  TABLE,
  readStaticTable,
} = require(path.join(__dirname, "../_shared/referenceData"));
const worldData = require(path.join(__dirname, "../../space/worldData"));
const {
  getCachedCharacterSkillMap,
} = require(path.join(__dirname, "../skills/skillState"));
const interdictionProbeRuntime = require(path.join(__dirname, "./interdictionProbeRuntime"));
const warpDisruptFieldGeneratorRuntime = require(path.join(
  __dirname,
  "./warpDisruptFieldGeneratorRuntime",
));

const CATEGORY_DEPLOYABLE = 22;
const GROUP_MOBILE_WARP_DISRUPTOR = 361;

const ATTRIBUTE_REQUIRED_SKILL_1 = 182;
const ATTRIBUTE_REQUIRED_SKILL_2 = 183;
const ATTRIBUTE_REQUIRED_SKILL_1_LEVEL = 277;
const ATTRIBUTE_REQUIRED_SKILL_2_LEVEL = 278;
const ATTRIBUTE_WARP_SCRAMBLE_RANGE = 103;
const ATTRIBUTE_ANCHORING_DELAY = 556;
const ATTRIBUTE_DISALLOW_IN_EMPIRE_SPACE = 1074;
const ATTRIBUTE_WARP_BUBBLE_IMMUNE = 1538;

const DEPLOY_DISTANCE_METERS = 2_500;
const WARP_DISRUPTOR_DEFAULT_LIFETIME_MS = 2 * 24 * 60 * 60 * 1000;
const CUSTOM_INFO_KEY = "evejsMobileWarpDisruptor";

const CURRENT_SDE_LIFETIME_MS_BY_TYPE_ID = Object.freeze({
  12198: 2 * 24 * 60 * 60 * 1000,
  12199: 2 * 24 * 60 * 60 * 1000,
  12200: 2 * 24 * 60 * 60 * 1000,
  26888: 7 * 24 * 60 * 60 * 1000,
  26890: 7 * 24 * 60 * 60 * 1000,
  26892: 7 * 24 * 60 * 60 * 1000,
  28770: 14 * 24 * 60 * 60 * 1000,
  28772: 14 * 24 * 60 * 60 * 1000,
  28774: 14 * 24 * 60 * 60 * 1000,
});

const timersByDisruptorID = new Map();

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

function getTypeDogmaEntry(typeID) {
  const payload = readStaticTable(TABLE.TYPE_DOGMA) || {};
  const typesByTypeID = payload.typesByTypeID || {};
  return typesByTypeID[String(toInt(typeID, 0))] || null;
}

function getTypeDogmaAttributes(typeID) {
  const entry = getTypeDogmaEntry(typeID);
  return entry && entry.attributes && typeof entry.attributes === "object"
    ? entry.attributes
    : {};
}

function getTypeDogmaAttributeValue(typeID, attributeID, fallback = 0) {
  const attributes = getTypeDogmaAttributes(typeID);
  const key = String(toInt(attributeID, 0));
  if (Object.prototype.hasOwnProperty.call(attributes, key)) {
    return toReal(attributes[key], fallback);
  }
  return fallback;
}

function getTypeName(typeID) {
  const metadata = getItemMetadata(typeID) || {};
  return String(metadata.name || `type ${typeID}`);
}

function isMobileWarpDisruptorType(typeIDOrItem) {
  if (typeIDOrItem && typeof typeIDOrItem === "object") {
    return (
      toInt(typeIDOrItem.categoryID, 0) === CATEGORY_DEPLOYABLE &&
      toInt(typeIDOrItem.groupID, 0) === GROUP_MOBILE_WARP_DISRUPTOR
    ) || isMobileWarpDisruptorType(toInt(typeIDOrItem.typeID, 0));
  }

  const typeID = toInt(typeIDOrItem, 0);
  if (typeID <= 0) {
    return false;
  }
  const metadata = getItemMetadata(typeID) || {};
  return (
    toInt(metadata.categoryID, 0) === CATEGORY_DEPLOYABLE &&
    toInt(metadata.groupID, 0) === GROUP_MOBILE_WARP_DISRUPTOR
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
    disruptorID: toInt(state.disruptorID, 0),
    deployedAtMs: toInt(state.deployedAtMs, 0),
    activateAtMs: toInt(state.activateAtMs, 0),
    activatedAtMs: toInt(state.activatedAtMs, 0),
    expiresAtMs: toInt(state.expiresAtMs, 0),
    active: state.active === true,
    deactivatedAtMs: toInt(state.deactivatedAtMs, 0),
    rangeMeters: toReal(state.rangeMeters, 0),
    anchoringDelayMs: toInt(state.anchoringDelayMs, 0),
  };
}

function getMobileWarpDisruptorStateFromItem(item) {
  if (!item || !isMobileWarpDisruptorType(item)) {
    return null;
  }
  const state = getStateFromCustomInfo(item.customInfo);
  if (!state || state.disruptorID <= 0) {
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
    disruptorID: toInt(state.disruptorID, 0),
    deployedAtMs: toInt(state.deployedAtMs, 0),
    activateAtMs: toInt(state.activateAtMs, 0),
    activatedAtMs: toInt(state.activatedAtMs, 0),
    expiresAtMs: toInt(state.expiresAtMs, 0),
    active: state.active === true,
    deactivatedAtMs: toInt(state.deactivatedAtMs, 0),
    rangeMeters: toReal(state.rangeMeters, 0),
    anchoringDelayMs: toInt(state.anchoringDelayMs, 0),
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

function getWarpDisruptionRangeMeters(typeID) {
  return Math.max(0, getTypeDogmaAttributeValue(typeID, ATTRIBUTE_WARP_SCRAMBLE_RANGE, 0));
}

function getAnchoringDelayMs(typeID) {
  return Math.max(0, toInt(
    getTypeDogmaAttributeValue(typeID, ATTRIBUTE_ANCHORING_DELAY, 0),
    0,
  ));
}

function getLifetimeMs(typeID) {
  return CURRENT_SDE_LIFETIME_MS_BY_TYPE_ID[toInt(typeID, 0)] ||
    WARP_DISRUPTOR_DEFAULT_LIFETIME_MS;
}

function getSkillLevel(characterID, skillTypeID) {
  const skillMap = characterID > 0 ? getCachedCharacterSkillMap(characterID) : new Map();
  const record = skillMap.get(toInt(skillTypeID, 0)) || null;
  return Math.max(0, Math.min(5, toInt(
    record &&
      (
        record.effectiveSkillLevel ??
        record.trainedSkillLevel ??
        record.skillLevel
      ),
    0,
  )));
}

function validateRequiredSkills(characterID, typeID) {
  const attributes = getTypeDogmaAttributes(typeID);
  const requirements = [
    [ATTRIBUTE_REQUIRED_SKILL_1, ATTRIBUTE_REQUIRED_SKILL_1_LEVEL],
    [ATTRIBUTE_REQUIRED_SKILL_2, ATTRIBUTE_REQUIRED_SKILL_2_LEVEL],
  ];
  for (const [skillAttributeID, levelAttributeID] of requirements) {
    const skillTypeID = toInt(attributes[String(skillAttributeID)], 0);
    const requiredLevel = toInt(attributes[String(levelAttributeID)], 0);
    if (skillTypeID <= 0 || requiredLevel <= 0) {
      continue;
    }
    const trainedLevel = getSkillLevel(characterID, skillTypeID);
    if (trainedLevel < requiredLevel) {
      return `${getTypeName(typeID)} deployment requires ${getTypeName(skillTypeID)} ${requiredLevel}.`;
    }
  }
  return null;
}

function getEmpireSpaceDeploymentRestriction(systemID, typeID) {
  if (
    getTypeDogmaAttributeValue(
      typeID,
      ATTRIBUTE_DISALLOW_IN_EMPIRE_SPACE,
      0,
    ) <= 0
  ) {
    return null;
  }
  const system = worldData.getSolarSystemByID(systemID);
  if (!system) {
    return "Solar system data is unavailable for this deployment.";
  }
  if (toReal(system.security, 0) > 0) {
    return "Mobile Warp Disruptors cannot be activated in empire space.";
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

function updateMobileWarpDisruptorState(itemID, updater) {
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
      errorMsg: "MOBILE_WARP_DISRUPTOR_STATE_NOT_FOUND",
    };
  }
  const nextState =
    typeof updater === "function" ? updater({ ...currentState }, item) : updater;
  return updateInventoryItem(itemID, (currentItem) => ({
    ...currentItem,
    customInfo: buildCustomInfoWithState(currentItem.customInfo, nextState),
  }));
}

function clearTimers(disruptorID) {
  const normalizedDisruptorID = toInt(disruptorID, 0);
  const timerState = timersByDisruptorID.get(normalizedDisruptorID);
  if (!timerState) {
    return;
  }
  if (timerState.activationTimer) {
    clearTimeout(timerState.activationTimer);
  }
  if (timerState.expiryTimer) {
    clearTimeout(timerState.expiryTimer);
  }
  timersByDisruptorID.delete(normalizedDisruptorID);
}

function setUnrefTimeout(callback, delayMs) {
  const timer = setTimeout(callback, Math.max(0, toInt(delayMs, 0)));
  if (typeof timer.unref === "function") {
    timer.unref();
  }
  return timer;
}

function clearMobileWarpDisruptor(itemOrID, reason = "cleared") {
  const itemID = toInt(itemOrID && itemOrID.itemID ? itemOrID.itemID : itemOrID, 0);
  if (!itemID) {
    return false;
  }
  clearTimers(itemID);

  const item = itemOrID && itemOrID.itemID ? itemOrID : findItemById(itemID);
  const state = getMobileWarpDisruptorStateFromItem(item);
  if (!state) {
    return false;
  }

  if (findItemById(itemID)) {
    updateMobileWarpDisruptorState(itemID, (currentState) => ({
      ...currentState,
      active: false,
      deactivatedAtMs: Date.now(),
    }));
  }
  // Cleared: its sphere is down for good.
  const volumes = resolveInterdictionVolumes(toInt(state.solarSystemID, 0));
  if (volumes) {
    volumes.removeVolume(itemID);
  }
  log.info(`[MobileWarpDisruptor] Cleared disruptor=${itemID} reason=${reason}`);
  return true;
}

function activateMobileWarpDisruptor(itemID) {
  const item = findItemById(itemID);
  const state = getMobileWarpDisruptorStateFromItem(item);
  if (!state) {
    clearTimers(itemID);
    return false;
  }
  if (resolveAbyssalDeployableItemRestriction(item, state)) {
    clearMobileWarpDisruptor(item, "abyssal-authority-forbidden");
    return false;
  }

  const now = Date.now();
  if (state.expiresAtMs > 0 && state.expiresAtMs <= now) {
    expireMobileWarpDisruptor(itemID, "expired-before-activation");
    return false;
  }
  if (
    toInt(item.locationID, 0) !== state.solarSystemID ||
    toInt(item.flagID, 0) !== 0 ||
    !item.spaceState
  ) {
    clearMobileWarpDisruptor(item, "removed-before-activation");
    return false;
  }

  updateMobileWarpDisruptorState(itemID, (currentState) => ({
    ...currentState,
    active: true,
    activatedAtMs: now,
  }));
  // Anchored and onlined: its volume reads the new state.
  const volumes = resolveInterdictionVolumes(toInt(state.solarSystemID, 0));
  if (volumes) {
    volumes.setVolumeState(itemID, { ...state, active: true, activatedAtMs: now });
  }
  getSpaceRuntime().refreshInventoryBackedEntityPresentation(state.solarSystemID, itemID);
  scheduleMobileWarpDisruptorTimers(itemID);
  log.info(
    `[MobileWarpDisruptor] Activated disruptor=${itemID} system=${state.solarSystemID} range=${state.rangeMeters}`,
  );
  return true;
}

function expireMobileWarpDisruptor(itemID, reason = "expired") {
  const item = findItemById(itemID);
  const state = getMobileWarpDisruptorStateFromItem(item);
  const systemID = toInt(
    state && state.solarSystemID,
    toInt(item && item.locationID, 0),
  );
  clearTimers(itemID);

  const removeResult = mobileItemCustody.expireInSpace({
    runtime: getSpaceRuntime(),
    item,
    systemID,
  });
  if (removeResult && removeResult.success) {
    log.info(`[MobileWarpDisruptor] Removed disruptor=${itemID} reason=${reason}`);
    return true;
  }
  return false;
}

function scheduleMobileWarpDisruptorTimers(itemOrID) {
  const itemID = toInt(itemOrID && itemOrID.itemID ? itemOrID.itemID : itemOrID, 0);
  const item = itemOrID && itemOrID.itemID ? itemOrID : findItemById(itemID);
  const state = getMobileWarpDisruptorStateFromItem(item);
  if (!state) {
    clearTimers(itemID);
    return false;
  }
  if (resolveAbyssalDeployableItemRestriction(item, state)) {
    clearMobileWarpDisruptor(item, "abyssal-authority-forbidden");
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
      () => expireMobileWarpDisruptor(itemID, "expired"),
      state.expiresAtMs - now,
    );
  }

  if (state.active || state.activateAtMs <= now) {
    if (!state.active) {
      nextTimers.activationTimer = setUnrefTimeout(
        () => activateMobileWarpDisruptor(itemID),
        0,
      );
    }
  } else {
    nextTimers.activationTimer = setUnrefTimeout(
      () => activateMobileWarpDisruptor(itemID),
      state.activateAtMs - now,
    );
  }

  timersByDisruptorID.set(itemID, nextTimers);
  return true;
}

function registerMobileWarpDisruptorItem(itemOrID) {
  return scheduleMobileWarpDisruptorTimers(itemOrID);
}

function isActiveWarpDisruptorState(state, nowMs = Date.now()) {
  if (!state || state.deactivatedAtMs > 0) {
    return false;
  }
  if (state.expiresAtMs > 0 && state.expiresAtMs <= nowMs) {
    return false;
  }
  return state.active === true || (state.activateAtMs > 0 && state.activateAtMs <= nowMs);
}

function hydrateMobileWarpDisruptorEntityFromInventoryItem(entity, itemRecord) {
  if (!entity || !isMobileWarpDisruptorType(itemRecord)) {
    return entity;
  }

  const state = getMobileWarpDisruptorStateFromItem(itemRecord);
  if (!state) {
    return entity;
  }

  if (resolveAbyssalDeployableItemRestriction(itemRecord, state)) {
    entity.isFree = true;
    entity.component_activate = [false, null];
    entity.activate_comp_durationSeconds = Math.trunc(
      Math.max(0, state.anchoringDelayMs) / 1000,
    );
    entity.warpDisruptionRangeMeters = 0;
    return entity;
  }

  const active = isActiveWarpDisruptorState(state, Date.now());
  entity.isFree = !active;
  entity.component_activate = [active, active ? null : state.activateAtMs];
  entity.activate_comp_durationSeconds = Math.trunc(
    Math.max(0, state.anchoringDelayMs) / 1000,
  );
  entity.warpDisruptionRangeMeters = Math.max(
    0,
    toReal(state.rangeMeters, getWarpDisruptionRangeMeters(itemRecord.typeID)),
  );
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

function validateMobileWarpDisruptorLaunch(item, context) {
  if (!context.characterID || !context.ownerID || !context.shipID || !context.systemID) {
    return "INVALID_SESSION";
  }
  if (!item) {
    return "ITEM_NOT_FOUND";
  }
  if (!isMobileWarpDisruptorType(item)) {
    return "ITEM_NOT_MOBILE_WARP_DISRUPTOR";
  }
  if (
    ![context.characterID, context.corporationID, context.ownerID].includes(toInt(item.ownerID, 0)) ||
    toInt(item.locationID, 0) !== context.shipID ||
    toInt(item.flagID, 0) !== ITEM_FLAGS.CARGO_HOLD
  ) {
    return "ITEM_NOT_IN_SHIP_CARGO";
  }

  const typeID = toInt(item.typeID, 0);
  const skillRestriction = validateRequiredSkills(context.characterID, typeID);
  if (skillRestriction) {
    return skillRestriction;
  }
  const empireRestriction = getEmpireSpaceDeploymentRestriction(context.systemID, typeID);
  if (empireRestriction) {
    return empireRestriction;
  }
  if (getWarpDisruptionRangeMeters(typeID) <= 0) {
    return "MOBILE_WARP_DISRUPTOR_RANGE_UNAVAILABLE";
  }
  return null;
}

function launchMobileWarpDisruptorFromShip(session, itemID, options = {}) {
  const context = getSessionContext(session, options);
  const item = findItemById(itemID);
  const validationError = validateMobileWarpDisruptorLaunch(item, context);
  if (validationError) {
    return {
      success: false,
      errorMsg: validationError,
    };
  }

  const spawnState = buildDeployableSpawnState(session, context);
  if (!spawnState) {
    return {
      success: false,
      errorMsg: "MOBILE_WARP_DISRUPTOR_DEPLOY_POSITION_UNAVAILABLE",
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
  const anchoringDelayMs = getAnchoringDelayMs(sourceTypeID);
  const state = {
    ownerID: context.ownerID,
    deployerCharacterID: context.characterID,
    solarSystemID: context.systemID,
    disruptorID: launchedItemID,
    deployedAtMs: now,
    activateAtMs: now + anchoringDelayMs,
    activatedAtMs: 0,
    expiresAtMs: now + getLifetimeMs(sourceTypeID),
    active: false,
    deactivatedAtMs: 0,
    rangeMeters: getWarpDisruptionRangeMeters(sourceTypeID),
    anchoringDelayMs,
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
      `[MobileWarpDisruptor] Launched disruptor ${launchedItemID} but space spawn failed: ${spawnResult ? spawnResult.errorMsg : "UNKNOWN"}`,
    );
  }

  registerMobileWarpDisruptorItem(updatedResult.data);
  log.info(
    `[MobileWarpDisruptor] char=${context.characterID} launched disruptor itemID=${launchedItemID} system=${context.systemID} range=${state.rangeMeters} activateDelayMs=${anchoringDelayMs}`,
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

function getEntityAttributeValue(entity, attributeID, fallback = 0) {
  const key = String(toInt(attributeID, 0));
  const sources = [
    entity && entity.passiveDerivedState && entity.passiveDerivedState.attributes,
    entity && entity.derivedAttributes,
    entity && entity.attributes,
    entity && entity.dogmaAttributes,
    entity && entity.runtimeAttributes,
  ];
  for (const source of sources) {
    if (!source || typeof source !== "object") {
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      return toReal(source[key], fallback);
    }
    if (Object.prototype.hasOwnProperty.call(source, toInt(attributeID, 0))) {
      return toReal(source[toInt(attributeID, 0)], fallback);
    }
  }
  return fallback;
}

function isEntityWarpBubbleImmune(entity) {
  if (!entity) {
    return false;
  }
  if (entity.warpBubbleImmune === true) {
    return true;
  }
  if (getEntityAttributeValue(entity, ATTRIBUTE_WARP_BUBBLE_IMMUNE, 0) > 0) {
    return true;
  }
  const typeID = getObjectTypeID(entity);
  return typeID > 0 &&
    getTypeDogmaAttributeValue(typeID, ATTRIBUTE_WARP_BUBBLE_IMMUNE, 0) > 0;
}

// The game time a sphere check runs at: the caller's (warp commands pass the
// scene's sim time), else the scene's, else the system's scene's.
function resolveSphereGameNowMs(systemID, options = {}) {
  const passed = Number(options.nowMs);
  if (options.nowMs !== undefined && options.nowMs !== null && Number.isFinite(passed)) {
    return passed;
  }
  const scene = options.scene && typeof options.scene.getCurrentSimTimeMs === "function"
    ? options.scene
    : null;
  if (scene) {
    return scene.getCurrentSimTimeMs();
  }
  const runtime = getSpaceRuntime();
  const systemScene = runtime && runtime.scenes instanceof Map
    ? runtime.scenes.get(systemID) || null
    : null;
  return systemScene && typeof systemScene.getCurrentSimTimeMs === "function"
    ? systemScene.getCurrentSimTimeMs()
    : Date.now();
}

// The system's InterdictionVolumes: the scene's list of spheres,
// `options.scene`'s or the loaded scene of `systemID`'s. A system with no
// loaded scene has no spheres up.
function resolveInterdictionVolumes(systemID, options = {}) {
  const scene = options.scene && typeof options.scene.getInterdictionVolumes === "function"
    ? options.scene
    : (() => {
      const runtime = getSpaceRuntime();
      return runtime && runtime.scenes instanceof Map
        ? runtime.scenes.get(toInt(systemID, 0)) || null
        : null;
    })();
  return scene && typeof scene.getInterdictionVolumes === "function"
    ? scene.getInterdictionVolumes()
    : null;
}

// The clocks a sphere look reads: a dictor's
// probe and a heavy interdictor's field on the game clock (the scene's sim
// time, which time dilation slows); a mobile warp disruptor's anchoring and
// 2-day decay on the wall clock. `options.nowMs` is game time,
// `options.wallclockNowMs` wall time.
function sphereLookOptions(systemID, options = {}) {
  return {
    nowMs: resolveSphereGameNowMs(toInt(systemID, 0), options),
    wallclockNowMs: toInt(options.wallclockNowMs, Date.now()),
    for: options.targetEntity || null,
  };
}

// Every sphere up now in `systemID`, from its InterdictionVolumes:
// no space item is scanned or copied.
function collectActiveWarpDisruptors(systemID, options = {}) {
  const volumes = resolveInterdictionVolumes(systemID, options);
  return volumes ? volumes.listActive(sphereLookOptions(systemID, options)) : [];
}

function findActiveWarpDisruptorForPosition(systemID, position, options = {}) {
  const volumes = resolveInterdictionVolumes(systemID, options);
  return volumes
    ? volumes.findVolumeContaining(position, sphereLookOptions(systemID, options))
    : null;
}

function findActiveWarpDisruptorForEntity(systemID, entity, options = {}) {
  if (!entity || isEntityWarpBubbleImmune(entity)) {
    return null;
  }
  const position = getObjectPosition(entity);
  if (!position) {
    return null;
  }
  return findActiveWarpDisruptorForPosition(systemID, position, {
    ...options,
    targetEntity: entity,
  });
}

// Warp outcome: the sphere that stops or drags a warp from `from` to
// its landing point `landing`, and where it lands instead, or null:
// InterdictionVolumes.resolveWarpOutcome on `systemID`'s scene, as `entity`
// sees spheres (immunity, interaction scope).
function resolveWarpSphereOutcome(systemID, entity, from, landing, options = {}) {
  if (!entity || isEntityWarpBubbleImmune(entity)) {
    return null;
  }
  const volumes = resolveInterdictionVolumes(systemID, options);
  return volumes
    ? volumes.resolveWarpOutcome(from, landing, sphereLookOptions(systemID, {
      ...options,
      targetEntity: entity,
    }))
    : null;
}

function isPositionWarpDisrupted(systemID, position, options = {}) {
  return Boolean(findActiveWarpDisruptorForPosition(systemID, position, options));
}

// Whether the abyssal deployable policy keeps this disruptor down.
function isAbyssalRestrictedWarpDisruptor(item, state) {
  return Boolean(resolveAbyssalDeployableItemRestriction(item, state));
}

module.exports = {
  CATEGORY_DEPLOYABLE,
  GROUP_MOBILE_WARP_DISRUPTOR,
  ATTRIBUTE_WARP_SCRAMBLE_RANGE,
  ATTRIBUTE_ANCHORING_DELAY,
  ATTRIBUTE_WARP_BUBBLE_IMMUNE,
  CURRENT_SDE_LIFETIME_MS_BY_TYPE_ID,
  isMobileWarpDisruptorType,
  launchMobileWarpDisruptorFromShip,
  registerMobileWarpDisruptorItem,
  clearMobileWarpDisruptor,
  getMobileWarpDisruptorStateFromItem,
  hydrateMobileWarpDisruptorEntityFromInventoryItem,
  collectActiveWarpDisruptors,
  resolveInterdictionVolumes,
  isActiveWarpDisruptorState,
  isAbyssalRestrictedWarpDisruptor,
  getWarpDisruptionRangeMetersForType: getWarpDisruptionRangeMeters,
  findActiveWarpDisruptorForPosition,
  findActiveWarpDisruptorForEntity,
  resolveWarpSphereOutcome,
  isPositionWarpDisrupted,
  isEntityWarpBubbleImmune,
  _testing: {
    buildDeployableSpawnState,
    buildCustomInfoWithState,
    getStateFromCustomInfo,
    getWarpDisruptionRangeMeters,
    getAnchoringDelayMs,
    getLifetimeMs,
    validateMobileWarpDisruptorLaunch,
  },
};
