"use strict";

const path = require("path");

const log = require(path.join(__dirname, "../../../utils/logger"));
const {
  resolveAbyssalPlayerLaunchScope,
} = require(path.join(__dirname, "../../_shared/abyssalPlayerLaunchScope"));
const {
  buildChildEntityScopeMetadata,
} = require(path.join(
  __dirname,
  "../../../space/destiny/identity/interactionScope.js",
));
const {
  buildDict,
  buildFiletimeLong,
  buildKeyVal,
  buildMarshalRealVectorList,
} = require(path.join(__dirname, "../../_shared/serviceHelpers"));
const {
  createSpaceItemForOwner,
  findItemById,
  getItemMetadata,
  removeInventoryItem,
  updateInventoryItem,
} = require(path.join(__dirname, "../../inventory/itemStore"));
const {
  getFittedModuleItems,
  getTypeDogmaAttributes,
  isChargeCompatibleWithModule,
  resolveDogmaSkillMapForHost,
} = require(path.join(__dirname, "../../fitting/liveFittingState"));
const {
  buildLocationModifiedAttributeMap,
  collectShipModifierAttributes,
} = require(path.join(__dirname, "../../../space/combat/weaponDogma"));
const { BALL_FLAG } = require(path.join(
  __dirname,
  "../../../space/destiny/constants",
));
const {
  getFreeBallFlags,
  getRigidBallFlags,
  isFreeBallEntity,
} = require(path.join(
  __dirname,
  "../../../space/destiny/stream/ballEncoding",
));
const { isPochvenSystem } = require(path.join(__dirname, "../../../space/pochvenPolicy"));

const CATEGORY_MODULE = 7;
const CATEGORY_CHARGE = 8;
const GROUP_MOON = 8;
const GROUP_SURVEY_PROBE_LAUNCHER = 1226;
const GROUP_SURVEY_PROBE = 492;

const ATTRIBUTE_MAX_VELOCITY = 37;
const ATTRIBUTE_EXPLOSION_DELAY = 281;
const ATTRIBUTE_MAX_SCAN_RANGE = 2697;

const FILETIME_EPOCH_OFFSET = 116444736000000000n;
const FILETIME_TICKS_PER_MS = 10000n;
// The completion deadline lives in the persisted survey state. Keep the
// inventory expiry later so a dormant scene can hydrate and deliver an overdue
// result before the generic inventory-entity expiry sweep removes the probe.
const SURVEY_PROBE_CLEANUP_GRACE_MS = 24 * 60 * 60 * 1000;
const CUSTOM_INFO_KEY = "evejsSurveyProbe";

let moonResourceResolverOverride = null;

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function toReal(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
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
  const length = Math.hypot(vector.x, vector.y, vector.z);
  if (!(length > 0)) {
    return { ...fallback };
  }
  return {
    x: vector.x / length,
    y: vector.y / length,
    z: vector.z / length,
  };
}

function addScaledVector(origin, direction, distance) {
  return {
    x: origin.x + direction.x * distance,
    y: origin.y + direction.y * distance,
    z: origin.z + direction.z * distance,
  };
}

function getSpaceRuntime() {
  return require(path.join(__dirname, "../../../space/runtime"));
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
    // ignored: preserve opaque legacy customInfo alongside the EveJS survey marker.
  }
  return { legacyCustomInfo: text };
}

function normalizeSurveyProbeState(state = {}) {
  const resourceSnapshot = state.resourceSnapshot &&
    typeof state.resourceSnapshot === "object" &&
    !Array.isArray(state.resourceSnapshot)
    ? Object.fromEntries(
      Object.entries(state.resourceSnapshot)
        .map(([typeID, fraction]) => [toInt(typeID, 0), toReal(fraction, 0)])
        .filter(([typeID, fraction]) => typeID > 0 && fraction > 0 && fraction <= 1)
        .sort((left, right) => left[0] - right[0]),
    )
    : null;
  return {
    ownerID: toInt(state.ownerID, 0),
    launcherCharacterID: toInt(state.launcherCharacterID, 0),
    sourceShipID: toInt(state.sourceShipID, 0),
    sourceModuleID: toInt(state.sourceModuleID, 0),
    solarSystemID: toInt(state.solarSystemID, 0),
    probeID: toInt(state.probeID, 0),
    typeID: toInt(state.typeID, 0),
    launchedAtMs: toInt(state.launchedAtMs, 0),
    completeAtMs: toInt(state.completeAtMs, 0),
    cleanupAtMs: toInt(state.cleanupAtMs, 0),
    completedAtMs: toInt(state.completedAtMs, 0),
    resultDeliveredAtMs: toInt(state.resultDeliveredAtMs, 0),
    removalNotifiedAtMs: toInt(state.removalNotifiedAtMs, 0),
    active: state.active !== false,
    chargeConsumed: state.chargeConsumed === true,
    delayMs: Math.max(0, toInt(state.delayMs, 0)),
    maxScanRange: Math.max(0, toReal(state.maxScanRange, 0)),
    maxVelocity: Math.max(0, toReal(state.maxVelocity, 0)),
    origin: normalizeVector(state.origin),
    direction: normalizeDirection(state.direction),
    moonID: toInt(state.moonID, 0),
    intersectionEntityID: toInt(state.intersectionEntityID, 0),
    resourceProfileAvailable: state.resourceProfileAvailable === true,
    resourceSnapshot,
  };
}

function buildCustomInfoWithState(customInfo, state) {
  const parsed = parseCustomInfo(customInfo);
  parsed[CUSTOM_INFO_KEY] = normalizeSurveyProbeState(state);
  return JSON.stringify(parsed);
}

function getStateFromCustomInfo(customInfo) {
  const parsed = parseCustomInfo(customInfo);
  const state = parsed && parsed[CUSTOM_INFO_KEY];
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    return null;
  }
  return normalizeSurveyProbeState(state);
}

function getTypeAttribute(typeID, attributeID, fallback = 0) {
  const attributes = getTypeDogmaAttributes(toInt(typeID, 0)) || {};
  return Object.prototype.hasOwnProperty.call(attributes, String(attributeID))
    ? toReal(attributes[String(attributeID)], fallback)
    : fallback;
}

function isSurveyProbeLauncherType(typeIDOrItem) {
  if (typeIDOrItem && typeof typeIDOrItem === "object") {
    return (
      toInt(typeIDOrItem.categoryID, 0) === CATEGORY_MODULE &&
      toInt(typeIDOrItem.groupID, 0) === GROUP_SURVEY_PROBE_LAUNCHER
    ) || isSurveyProbeLauncherType(toInt(typeIDOrItem.typeID, 0));
  }
  const metadata = getItemMetadata(toInt(typeIDOrItem, 0)) || {};
  return (
    toInt(metadata.categoryID, 0) === CATEGORY_MODULE &&
    toInt(metadata.groupID, 0) === GROUP_SURVEY_PROBE_LAUNCHER
  );
}

function isSurveyProbeType(typeIDOrItem) {
  if (typeIDOrItem && typeof typeIDOrItem === "object") {
    return (
      toInt(typeIDOrItem.categoryID, 0) === CATEGORY_CHARGE &&
      toInt(typeIDOrItem.groupID, 0) === GROUP_SURVEY_PROBE
    ) || isSurveyProbeType(toInt(typeIDOrItem.typeID, 0));
  }
  const metadata = getItemMetadata(toInt(typeIDOrItem, 0)) || {};
  return (
    toInt(metadata.categoryID, 0) === CATEGORY_CHARGE &&
    toInt(metadata.groupID, 0) === GROUP_SURVEY_PROBE
  );
}

function getSurveyDelayMs(moduleItem, chargeItem, context = {}) {
  const baseDelayMs = Math.max(
    0,
    getTypeAttribute(chargeItem && chargeItem.typeID, ATTRIBUTE_EXPLOSION_DELAY, 0),
  );
  if (!(baseDelayMs > 0)) {
    return 0;
  }
  const shipItem = context.shipItem || findItemById(toInt(context.shipID, 0));
  if (!shipItem) {
    return Math.round(baseDelayMs);
  }

  const characterID = toInt(context.characterID, 0);
  const skillMap = resolveDogmaSkillMapForHost(characterID, shipItem, context);
  const fittedItems = Array.isArray(context.fittedItems)
    ? context.fittedItems
    : getFittedModuleItems(characterID, toInt(shipItem.itemID, 0));
  const activeModuleContexts = Array.isArray(context.activeModuleContexts)
    ? context.activeModuleContexts
    : [];
  const shipModifierAttributes = collectShipModifierAttributes(
    shipItem,
    skillMap,
    activeModuleContexts,
    { fittedItems },
  );
  const chargeAttributes = buildLocationModifiedAttributeMap(
    chargeItem,
    shipItem,
    skillMap,
    shipModifierAttributes,
    fittedItems,
    activeModuleContexts,
  );
  const effectiveDelayMs = toReal(
    chargeAttributes[ATTRIBUTE_EXPLOSION_DELAY],
    baseDelayMs,
  );
  return effectiveDelayMs > 0 ? Math.max(1, Math.round(effectiveDelayMs)) : 0;
}

function getSurveyMaxScanRange(chargeItem) {
  return Math.max(
    0,
    getTypeAttribute(chargeItem && chargeItem.typeID, ATTRIBUTE_MAX_SCAN_RANGE, 0),
  );
}

function getSurveyMaxVelocity(chargeItem) {
  return Math.max(
    0,
    getTypeAttribute(chargeItem && chargeItem.typeID, ATTRIBUTE_MAX_VELOCITY, 0),
  );
}

function getSessionContext(session) {
  return {
    characterID: toInt(session && (session.characterID || session.charid), 0),
    shipID: toInt(
      session && session._space && session._space.shipID,
      toInt(session && (session.shipID || session.shipid || session.activeShipID), 0),
    ),
    systemID: toInt(
      session && session._space && session._space.systemID,
      toInt(session && (session.solarsystemid2 || session.solarsystemid), 0),
    ),
  };
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
    if (
      candidate &&
      typeof candidate === "object" &&
      Number.isFinite(Number(candidate.x)) &&
      Number.isFinite(Number(candidate.y)) &&
      Number.isFinite(Number(candidate.z))
    ) {
      return normalizeVector(candidate);
    }
  }
  return null;
}

function getRaySphereIntersectionDistance(origin, direction, entity) {
  const center = getObjectPosition(entity);
  const radius = Math.max(1, toReal(entity && entity.radius, 1));
  if (!center) {
    return null;
  }
  const offset = {
    x: center.x - origin.x,
    y: center.y - origin.y,
    z: center.z - origin.z,
  };
  const projected =
    offset.x * direction.x +
    offset.y * direction.y +
    offset.z * direction.z;
  const offsetLengthSquared =
    offset.x * offset.x + offset.y * offset.y + offset.z * offset.z;
  // Carbon rejects sphere centers behind the ray before solving the quadratic.
  if (projected < 0) {
    return null;
  }
  const perpendicularSquared = Math.max(0, offsetLengthSquared - projected * projected);
  const radiusSquared = radius * radius;
  if (perpendicularSquared > radiusSquared) {
    return null;
  }
  const halfChord = Math.sqrt(Math.max(0, radiusSquared - perpendicularSquared));
  const entry = projected - halfChord;
  // GetClosestIntersection compares squared distances, so a ray originating
  // inside a global sphere uses the magnitude of the negative entry value.
  return Math.abs(entry);
}

function resolveClosestRayIntersection(scene, origin, direction, maxRange, options = {}) {
  const session = options.session || null;
  const candidates = session && scene &&
    typeof scene.getVisibleEntitiesForSession === "function"
    ? scene.getVisibleEntitiesForSession(session)
    : [
        ...(scene && Array.isArray(scene.staticEntities) ? scene.staticEntities : []),
        ...(scene && scene.dynamicEntities instanceof Map
          ? scene.dynamicEntities.values()
          : []),
      ];
  const rangeSquared = Math.max(0, toReal(maxRange, 0)) ** 2;

  let closest = null;
  for (const entity of candidates) {
    const entityID = toInt(entity && entity.itemID, 0);
    if (entityID <= 0) {
      continue;
    }
    const ballFlags = isFreeBallEntity(entity)
      ? getFreeBallFlags(entity)
      : getRigidBallFlags(entity);
    if ((ballFlags & BALL_FLAG.IS_GLOBAL) === 0) {
      continue;
    }
    const center = getObjectPosition(entity);
    if (!center) {
      continue;
    }
    const centerDistanceSquared =
      (center.x - origin.x) ** 2 +
      (center.y - origin.y) ** 2 +
      (center.z - origin.z) ** 2;
    if (centerDistanceSquared > rangeSquared) {
      continue;
    }
    const distance = getRaySphereIntersectionDistance(origin, direction, entity);
    if (distance === null) {
      continue;
    }
    if (!closest || distance < closest.distance) {
      closest = {
        entityID,
        groupID: toInt(entity && (entity.slimGroupID ?? entity.groupID), 0),
        distance,
      };
    }
  }
  return closest;
}

function buildSurveyProbeSpawnState(session, context, delayMs, maxScanRange) {
  const runtime = getSpaceRuntime();
  const scene = typeof runtime.getSceneForSession === "function"
    ? runtime.getSceneForSession(session)
    : null;
  const shipEntity = runtime.getEntity(session, context.shipID);
  const origin = getObjectPosition(shipEntity);
  if (!scene || !shipEntity || !origin) {
    return null;
  }
  const launchScope = resolveAbyssalPlayerLaunchScope(session, shipEntity, scene);
  if (launchScope.valid !== true) {
    return null;
  }
  const direction = normalizeDirection(
    shipEntity.direction || shipEntity.velocity,
    { x: 1, y: 0, z: 0 },
  );
  const maxVelocity = getSurveyMaxVelocity(context.loadedCharge);
  const visualTravelDistance = Math.max(
    maxScanRange,
    maxVelocity * Math.max(1, delayMs) / 1000,
  );
  const targetPoint = addScaledVector(origin, direction, visualTravelDistance);
  const intersection = resolveClosestRayIntersection(
    scene,
    origin,
    direction,
    maxScanRange,
    { session },
  );
  return {
    ...buildChildEntityScopeMetadata(shipEntity),
    ...launchScope.metadata,
    scene,
    origin,
    direction,
    position: origin,
    velocity: addScaledVector({ x: 0, y: 0, z: 0 }, direction, maxVelocity),
    targetPoint,
    mode: "GOTO",
    speedFraction: 1,
    maxVelocity,
    intersection,
  };
}

function validateSurveyProbeLaunchContext(session, moduleItem, loadedCharge) {
  const context = getSessionContext(session);
  if (!session || !session._space || !context.characterID || !context.shipID || !context.systemID) {
    return { success: false, errorMsg: "NOT_IN_SPACE", data: { context } };
  }
  if (!moduleItem || !isSurveyProbeLauncherType(moduleItem)) {
    return { success: false, errorMsg: "INVALID_LAUNCHER", data: { context } };
  }
  if (toInt(moduleItem.locationID, 0) !== context.shipID) {
    return { success: false, errorMsg: "MODULE_NOT_FOUND", data: { context } };
  }
  if (!loadedCharge) {
    return { success: false, errorMsg: "NO_CHARGES", data: { context } };
  }
  if (!isSurveyProbeType(loadedCharge)) {
    return { success: false, errorMsg: "INVALID_CHARGE", data: { context } };
  }
  if (!isChargeCompatibleWithModule(moduleItem.typeID, loadedCharge.typeID)) {
    return { success: false, errorMsg: "INCOMPATIBLE_CHARGE", data: { context } };
  }
  const quantity = Math.max(0, toInt(loadedCharge.stacksize ?? loadedCharge.quantity, 0));
  if (quantity < 1) {
    return { success: false, errorMsg: "NO_CHARGES", data: { context } };
  }
  const delayMs = getSurveyDelayMs(moduleItem, loadedCharge, context);
  const maxScanRange = getSurveyMaxScanRange(loadedCharge);
  const maxVelocity = getSurveyMaxVelocity(loadedCharge);
  if (!(delayMs > 0)) {
    return { success: false, errorMsg: "SURVEY_DURATION_UNAVAILABLE", data: { context } };
  }
  if (!(maxScanRange > 0)) {
    return { success: false, errorMsg: "SURVEY_RANGE_UNAVAILABLE", data: { context } };
  }
  if (!(maxVelocity > 0)) {
    return { success: false, errorMsg: "SURVEY_VELOCITY_UNAVAILABLE", data: { context } };
  }
  return {
    success: true,
    data: {
      context: {
        ...context,
        ownerID: context.characterID,
        loadedCharge,
      },
      delayMs,
      maxScanRange,
    },
  };
}

function toFiletimeFromMs(valueMs) {
  return BigInt(Math.max(0, toInt(valueMs, 0))) * FILETIME_TICKS_PER_MS + FILETIME_EPOCH_OFFSET;
}

function buildSurveyProbeKeyVal(state) {
  const normalized = normalizeSurveyProbeState(state);
  return buildKeyVal([
    ["probeID", normalized.probeID],
    ["typeID", normalized.typeID],
    ["pos", buildMarshalRealVectorList(normalized.origin)],
    ["expiry", buildFiletimeLong(toFiletimeFromMs(normalized.completeAtMs))],
    ["delay", normalized.delayMs],
    ["maxScanRange", normalized.maxScanRange],
  ]);
}

function sendNotification(session, name, payload) {
  if (!session || typeof session.sendNotification !== "function") {
    return false;
  }
  try {
    session.sendNotification(name, "clientID", payload);
    return true;
  } catch (error) {
    log.warn(
      `[SurveyProbe] Notification failed char=${toInt(
        session.characterID || session.charid,
        0,
      )} name=${name}: ${error.message}`,
    );
    return false;
  }
}

function launchSurveyProbeFromModule(session, moduleItem, loadedCharge, options = {}) {
  const validation = validateSurveyProbeLaunchContext(session, moduleItem, loadedCharge);
  if (validation.success !== true) {
    return validation;
  }
  const context = validation.data.context;
  const spawnState = buildSurveyProbeSpawnState(
    session,
    context,
    validation.data.delayMs,
    validation.data.maxScanRange,
  );
  if (!spawnState) {
    return { success: false, errorMsg: "SURVEY_PROBE_POSITION_UNAVAILABLE" };
  }

  const sceneNow = typeof spawnState.scene.getCurrentSimTimeMs === "function"
    ? spawnState.scene.getCurrentSimTimeMs()
    : Date.now();
  const now = toInt(options.nowMs, sceneNow);
  const chargeTypeID = toInt(loadedCharge.typeID, 0);
  const completeAtMs = now + validation.data.delayMs;
  const cleanupAtMs = completeAtMs + SURVEY_PROBE_CLEANUP_GRACE_MS;
  const intersection = spawnState.intersection || null;
  const state = normalizeSurveyProbeState({
    ownerID: context.ownerID,
    launcherCharacterID: context.characterID,
    sourceShipID: context.shipID,
    sourceModuleID: toInt(moduleItem.itemID, 0),
    solarSystemID: context.systemID,
    probeID: 0,
    typeID: chargeTypeID,
    launchedAtMs: now,
    completeAtMs,
    cleanupAtMs,
    completedAtMs: 0,
    active: true,
    chargeConsumed: false,
    delayMs: validation.data.delayMs,
    maxScanRange: validation.data.maxScanRange,
    maxVelocity: spawnState.maxVelocity,
    origin: spawnState.origin,
    direction: spawnState.direction,
    moonID: intersection && intersection.groupID === GROUP_MOON ? intersection.entityID : 0,
    intersectionEntityID: intersection ? intersection.entityID : 0,
  });
  if (state.moonID > 0) {
    const profile = resolveMoonResourceProfile(state.moonID, {
      scene: spawnState.scene,
      state,
      session,
      phase: "launch",
    });
    state.resourceProfileAvailable = profile !== null;
    state.resourceSnapshot = profile ? profile.resources : null;
  }

  const createResult = createSpaceItemForOwner(
    context.ownerID,
    context.systemID,
    chargeTypeID,
    {
      ...spawnState,
      scene: undefined,
      intersection: undefined,
      origin: undefined,
      customInfo: buildCustomInfoWithState("", state),
      createdAtMs: now,
      expiresAtMs: cleanupAtMs,
      position: spawnState.position,
      velocity: spawnState.velocity,
      direction: spawnState.direction,
      targetPoint: spawnState.targetPoint,
      mode: spawnState.mode,
      speedFraction: spawnState.speedFraction,
      maxVelocity: spawnState.maxVelocity,
      spaceRadius: Math.max(1, toReal((getItemMetadata(chargeTypeID) || {}).radius, 1)),
    },
  );
  if (!createResult.success || !createResult.data) {
    return {
      success: false,
      errorMsg: createResult.errorMsg || "SURVEY_PROBE_CREATE_FAILED",
    };
  }

  const probeItem = createResult.data;
  state.probeID = toInt(probeItem.itemID, 0);
  const updateResult = updateInventoryItem(state.probeID, (currentItem) => ({
    ...currentItem,
    customInfo: buildCustomInfoWithState(currentItem.customInfo, state),
  }));
  if (!updateResult.success || !updateResult.data) {
    removeInventoryItem(state.probeID, { removeContents: true });
    return {
      success: false,
      errorMsg: updateResult.errorMsg || "SURVEY_PROBE_STATE_WRITE_FAILED",
    };
  }
  const spawnedItem = updateResult.data;

  // The owner's MoonScan service must learn the probe before AddBalls invokes
  // OnBallAdded; that callback reads this payload to ray-cast the destination.
  if (!sendNotification(session, "OnNewMoonProbe", [buildSurveyProbeKeyVal(state)])) {
    removeInventoryItem(state.probeID, { removeContents: true });
    return {
      success: false,
      errorMsg: "SURVEY_PROBE_NOTIFY_FAILED",
    };
  }

  const runtime = getSpaceRuntime();
  const sceneDescriptor = spawnState.scene && spawnState.scene.sceneDescriptor;
  const spawnResult = runtime.spawnDynamicInventoryEntity(
    sceneDescriptor || context.systemID,
    state.probeID,
    { sceneDescriptor: sceneDescriptor || undefined },
  );
  if (!spawnResult || spawnResult.success !== true) {
    sendNotification(session, "OnRemoveMoonProbe", [state.probeID]);
    removeInventoryItem(state.probeID, { removeContents: true });
    return {
      success: false,
      errorMsg: spawnResult && spawnResult.errorMsg
        ? spawnResult.errorMsg
        : "SURVEY_PROBE_SPAWN_FAILED",
    };
  }

  log.info(
    `[SurveyProbe] char=${context.characterID} launched probe=${state.probeID} ` +
      `system=${context.systemID} moon=${state.moonID || 0} ` +
      `delayMs=${state.delayMs} completeAtMs=${state.completeAtMs}`,
  );
  return {
    success: true,
    data: {
      itemID: state.probeID,
      sourceModuleID: state.sourceModuleID,
      chargeTypeID,
      state,
      item: spawnedItem,
    },
  };
}

function hydrateSurveyProbeEntityFromInventoryItem(entity, itemRecord) {
  if (!entity || !isSurveyProbeType(itemRecord)) {
    return entity;
  }
  const state = getStateFromCustomInfo(itemRecord.customInfo);
  if (!state) {
    return entity;
  }
  entity.kind = "probe";
  entity.isFree = true;
  entity.mode = state.active ? "GOTO" : "STOP";
  entity.direction = { ...state.direction };
  entity.velocity = state.active
    ? addScaledVector({ x: 0, y: 0, z: 0 }, state.direction, state.maxVelocity)
    : { x: 0, y: 0, z: 0 };
  entity.targetPoint = addScaledVector(
    state.origin,
    state.direction,
    Math.max(state.maxScanRange, state.maxVelocity * Math.max(1, state.delayMs) / 1000),
  );
  entity.speedFraction = state.active ? 1 : 0;
  entity.maxVelocity = state.maxVelocity;
  entity.ownerID = state.ownerID || toInt(itemRecord.ownerID, entity.ownerID || 0);
  entity.sourceShipID = state.sourceShipID;
  entity.sourceModuleID = state.sourceModuleID;
  entity.expiresAtMs = state.cleanupAtMs || toInt(itemRecord.expiresAtMs, 0) || null;
  entity.surveyProbeState = state;
  entity.slimTypeID = toInt(itemRecord.typeID, entity.slimTypeID || 0);
  entity.slimGroupID = GROUP_SURVEY_PROBE;
  entity.slimCategoryID = CATEGORY_CHARGE;
  return entity;
}

function markSurveyProbeChargeConsumed(probeID, options = {}) {
  const numericProbeID = toInt(probeID, 0);
  const item = findItemById(numericProbeID);
  const currentState = item ? getStateFromCustomInfo(item.customInfo) : null;
  if (!item || !currentState) {
    return { success: false, errorMsg: "SURVEY_PROBE_NOT_FOUND" };
  }
  const nextState = normalizeSurveyProbeState({
    ...currentState,
    chargeConsumed: true,
  });
  const updateResult = updateInventoryItem(numericProbeID, (currentItem) => ({
    ...currentItem,
    customInfo: buildCustomInfoWithState(currentItem.customInfo, nextState),
  }));
  if (!updateResult.success || !updateResult.data) {
    return {
      success: false,
      errorMsg: updateResult.errorMsg || "SURVEY_PROBE_STATE_WRITE_FAILED",
    };
  }

  const runtime = getSpaceRuntime();
  const scene = options.session && typeof runtime.getSceneForSession === "function"
    ? runtime.getSceneForSession(options.session)
    : null;
  const entity = scene && typeof scene.getEntityByID === "function"
    ? scene.getEntityByID(numericProbeID)
    : null;
  if (entity) {
    entity.surveyProbeState = nextState;
    entity.customInfo = updateResult.data.customInfo;
  }
  return { success: true, data: { state: nextState, item: updateResult.data } };
}

function getSurveyProbeStateFromSource(source) {
  if (!source || !isSurveyProbeType(source)) {
    return null;
  }
  return getStateFromCustomInfo(source.customInfo) ||
    (source.surveyProbeState
      ? normalizeSurveyProbeState(source.surveyProbeState)
      : null);
}

function normalizeMoonResourceProfile(rawProfile, moonID) {
  if (!rawProfile || typeof rawProfile !== "object") {
    return null;
  }
  const entries = [];
  if (Array.isArray(rawProfile.composition)) {
    for (const row of rawProfile.composition) {
      entries.push([toInt(row && row.typeID, 0), toReal(row && row.fraction, 0)]);
    }
  } else {
    const resources = rawProfile.resources && typeof rawProfile.resources === "object"
      ? rawProfile.resources
      : {};
    for (const [typeID, fraction] of Object.entries(resources)) {
      entries.push([toInt(typeID, 0), toReal(fraction, 0)]);
    }
  }
  const normalizedEntries = entries
    .filter(([typeID, fraction]) => typeID > 0 && fraction > 0 && fraction <= 1)
    .sort((left, right) => left[0] - right[0]);
  return {
    moonID: toInt(rawProfile.moonID, toInt(moonID, 0)),
    resources: Object.fromEntries(normalizedEntries),
  };
}

function resolveMoonResourceProfile(moonID, context = {}) {
  const surveySystemID = toInt(
    context && (
      context.solarSystemID ||
      context.systemID ||
      (context.state && context.state.solarSystemID) ||
      (context.scene && context.scene.systemID)
    ),
    0,
  );
  if (isPochvenSystem(surveySystemID)) {
    return null;
  }
  if (typeof moonResourceResolverOverride === "function") {
    return normalizeMoonResourceProfile(
      moonResourceResolverOverride(toInt(moonID, 0), context),
      moonID,
    );
  }
  // The SDE has moon geometry but no per-moon composition. The installed moon
  // composition pack supplies it; the same pack seeds moon extraction, so a
  // survey reports what a chunk from that moon will hold. Without a pack, or
  // for a moon the pack does not cover, the survey fails closed.
  const compositions = getMoonCompositionRuntime();
  const installed = compositions.getMoonComposition(toInt(moonID, 0));
  if (!installed) {
    // An installed pack covers every moon that has ores, so a moon it leaves
    // out has none: the client shows that as an empty result. Without a
    // pack nothing is known and the survey stays fail-closed.
    return compositions.getMoonCompositionStatus().state === compositions.STATE.READY
      ? { moonID: toInt(moonID, 0), resources: {} }
      : null;
  }
  if (surveySystemID > 0 && installed.solarSystemID !== surveySystemID) {
    return null;
  }
  return normalizeMoonResourceProfile(installed, moonID);
}

function getMoonCompositionRuntime() {
  return require(path.join(__dirname, "../../structure/moonCompositionRuntime"));
}

function getOwningSessions(scene, ownerID) {
  if (!scene || !(scene.sessions instanceof Map)) {
    return [];
  }
  const numericOwnerID = toInt(ownerID, 0);
  return [...scene.sessions.values()].filter((session) =>
    session &&
    (!session.socket || session.socket.destroyed !== true) &&
    toInt(session.characterID || session.charid || session.userid, 0) === numericOwnerID,
  );
}

function announceSurveyProbesForSession(scene, session, entities = null) {
  const ownerID = toInt(session && (session.characterID || session.charid), 0);
  if (!scene || ownerID <= 0) {
    return { announced: 0, probeIDs: [] };
  }
  const candidates = Array.isArray(entities)
    ? entities
    : scene.dynamicEntities instanceof Map
      ? [...scene.dynamicEntities.values()]
      : [];
  const probeIDs = [];
  for (const entity of candidates) {
    const state = getSurveyProbeStateFromSource(entity);
    if (
      !state ||
      state.ownerID !== ownerID ||
      state.probeID <= 0 ||
      state.chargeConsumed !== true ||
      state.removalNotifiedAtMs > 0
    ) {
      continue;
    }
    if (sendNotification(session, "OnNewMoonProbe", [buildSurveyProbeKeyVal(state)])) {
      probeIDs.push(state.probeID);
    }
  }
  return { announced: probeIDs.length, probeIDs };
}

function notifySurveyProbeRemoval(scene, source) {
  const state = getSurveyProbeStateFromSource(source);
  if (!state || state.probeID <= 0 || state.removalNotifiedAtMs > 0) {
    return { notified: 0, probeID: state ? state.probeID : 0 };
  }
  let notified = 0;
  for (const session of getOwningSessions(scene, state.ownerID)) {
    if (sendNotification(session, "OnRemoveMoonProbe", [state.probeID])) {
      notified += 1;
    }
  }
  return { notified, probeID: state.probeID };
}

function removeSurveyProbe(probeID, systemID = 0, reason = "removed", options = {}) {
  const numericProbeID = toInt(probeID, 0);
  if (numericProbeID <= 0) {
    return false;
  }
  if (options.notifySession) {
    sendNotification(options.notifySession, "OnRemoveMoonProbe", [numericProbeID]);
  }
  const runtime = getSpaceRuntime();
  const sessionScene = options.session && typeof runtime.getSceneForSession === "function"
    ? runtime.getSceneForSession(options.session)
    : null;
  const sceneDescriptor = options.sceneDescriptor ||
    (sessionScene && sessionScene.sceneDescriptor) || null;
  const destroyResult = runtime.destroyDynamicInventoryEntity(
    sceneDescriptor || toInt(systemID, 0),
    numericProbeID,
    {
      sceneDescriptor: sceneDescriptor || undefined,
      suppressSurveyProbeNotification:
        options.suppressSurveyProbeNotification === true ||
        Boolean(options.notifySession),
    },
  );
  if (destroyResult && destroyResult.success === true) {
    return true;
  }
  const removeResult = removeInventoryItem(numericProbeID, { removeContents: true });
  if (!removeResult.success) {
    log.warn(
      `[SurveyProbe] Failed to remove probe=${numericProbeID} reason=${reason} ` +
        `error=${removeResult.errorMsg}`,
    );
  }
  return removeResult.success === true;
}

function persistSurveyProbeState(entity, state, reason) {
  const normalizedState = normalizeSurveyProbeState(state);
  const updateResult = updateInventoryItem(normalizedState.probeID, (currentItem) => ({
    ...currentItem,
    customInfo: buildCustomInfoWithState(currentItem.customInfo, normalizedState),
  }));
  if (!updateResult.success || !updateResult.data) {
    log.warn(
      `[SurveyProbe] Failed to persist ${reason} probe=${normalizedState.probeID}: ` +
        `${updateResult.errorMsg || "WRITE_ERROR"}`,
    );
    return null;
  }
  entity.surveyProbeState = normalizedState;
  entity.customInfo = updateResult.data.customInfo;
  return normalizedState;
}

function sendSurveyProbeResult(session, state, resourceEntries) {
  if (state.moonID > 0 && state.resourceProfileAvailable && resourceEntries.length > 0) {
    return sendNotification(session, "OnMoonScanComplete", [
      state.moonID,
      buildDict(resourceEntries),
    ]);
  }
  if (state.moonID > 0 && state.resourceProfileAvailable) {
    return sendNotification(session, "OnScanNoMaterials", [state.moonID]);
  }
  if (state.moonID <= 0 && state.intersectionEntityID > 0) {
    return sendNotification(session, "OnScanNoMaterials", [state.intersectionEntityID]);
  }
  if (state.moonID > 0) {
    return sendNotification(session, "OnRemoteMessage", [
      "CustomNotify",
      buildDict([
        [
          "notify",
          "This moon has no verified survey composition in the configured resource authority.",
        ],
        ["moonID", state.moonID],
      ]),
    ]);
  }
  return true;
}

function completeSurveyProbe(scene, entity, nowMs) {
  let state = getSurveyProbeStateFromSource(entity);
  const now = toInt(nowMs, Date.now());
  if (!state || state.completeAtMs <= 0 || now < state.completeAtMs) {
    return { completed: false, notified: 0, removed: false };
  }

  const sessions = getOwningSessions(scene, state.ownerID);
  if (sessions.length <= 0) {
    return { completed: false, notified: 0, removed: false, awaitingOwner: true };
  }

  if (state.active !== false || state.completedAtMs <= 0) {
    state = persistSurveyProbeState(
      entity,
      {
        ...state,
        active: false,
        completedAtMs: state.completedAtMs > 0 ? state.completedAtMs : now,
      },
      "completion-pending",
    );
    if (!state) {
      return { completed: false, notified: 0, removed: false };
    }
  }

  const resourceEntries = state.moonID > 0 && state.resourceProfileAvailable
    ? Object.entries(state.resourceSnapshot || {})
        .map(([typeID, fraction]) => [toInt(typeID, 0), toReal(fraction, 0)])
        .filter(([typeID, fraction]) => typeID > 0 && fraction > 0)
        .sort((left, right) => left[0] - right[0])
    : [];

  if (state.resultDeliveredAtMs <= 0) {
    if (!sessions.every((session) => sendSurveyProbeResult(session, state, resourceEntries))) {
      return {
        completed: false,
        notified: 0,
        removed: false,
        deliveryPending: true,
      };
    }
    state = persistSurveyProbeState(
      entity,
      { ...state, resultDeliveredAtMs: now },
      "result-delivered",
    );
    if (!state) {
      return { completed: false, notified: sessions.length, removed: false };
    }
  }

  if (state.removalNotifiedAtMs <= 0) {
    if (!sessions.every((session) => (
      sendNotification(session, "OnRemoveMoonProbe", [state.probeID])
    ))) {
      return {
        completed: false,
        notified: sessions.length,
        removed: false,
        removalPending: true,
      };
    }
    state = persistSurveyProbeState(
      entity,
      { ...state, removalNotifiedAtMs: now },
      "removal-notified",
    );
    if (!state) {
      return { completed: false, notified: sessions.length, removed: false };
    }
  }

  let removed = false;
  if (scene && typeof scene.destroyInventoryBackedDynamicEntity === "function") {
    const destroyResult = scene.destroyInventoryBackedDynamicEntity(state.probeID, {
      suppressSurveyProbeNotification: true,
    });
    removed = Boolean(destroyResult && destroyResult.success);
  }
  if (!removed) {
    removed = removeSurveyProbe(
      state.probeID,
      state.solarSystemID,
      "survey-complete",
      {
        sceneDescriptor: scene && scene.sceneDescriptor,
        suppressSurveyProbeNotification: true,
      },
    );
  }

  log.info(
    `[SurveyProbe] completed probe=${state.probeID} ` +
      `moon=${state.moonID || 0} resources=${resourceEntries.length} removed=${removed}`,
  );
  return {
    completed: removed,
    notified: sessions.length,
    removed,
    moonID: state.moonID,
    resourceCount: resourceEntries.length,
  };
}

function tickScene(scene, nowMs = Date.now()) {
  if (!scene || !(scene.dynamicEntities instanceof Map)) {
    return { completed: 0, rolledBack: 0, results: [] };
  }
  const results = [];
  let rolledBack = 0;
  for (const entity of [...scene.dynamicEntities.values()]) {
    if (!isSurveyProbeType(entity)) {
      continue;
    }
    const state = getSurveyProbeStateFromSource(entity);
    if (state && state.chargeConsumed !== true) {
      const destroyResult = scene.destroyInventoryBackedDynamicEntity(state.probeID, {
        reason: "survey-charge-consume-uncommitted",
      });
      if (destroyResult && destroyResult.success) {
        rolledBack += 1;
      }
      continue;
    }
    const result = completeSurveyProbe(scene, entity, nowMs);
    if (result.completed) {
      results.push(result);
    }
  }
  return { completed: results.length, rolledBack, results };
}

module.exports = {
  CATEGORY_CHARGE,
  GROUP_MOON,
  GROUP_SURVEY_PROBE,
  GROUP_SURVEY_PROBE_LAUNCHER,
  SURVEY_PROBE_CLEANUP_GRACE_MS,
  isSurveyProbeLauncherType,
  isSurveyProbeType,
  getSurveyDelayMs,
  getSurveyMaxScanRange,
  validateSurveyProbeLaunchContext,
  launchSurveyProbeFromModule,
  markSurveyProbeChargeConsumed,
  removeSurveyProbe,
  announceSurveyProbesForSession,
  notifySurveyProbeRemoval,
  hydrateSurveyProbeEntityFromInventoryItem,
  getSurveyProbeStateFromSource,
  buildSurveyProbeKeyVal,
  completeSurveyProbe,
  tickScene,
  _testing: {
    buildCustomInfoWithState,
    getStateFromCustomInfo,
    getRaySphereIntersectionDistance,
    resolveClosestRayIntersection,
    resolveMoonResourceProfile,
    setMoonResourceResolver(resolver) {
      moonResourceResolverOverride = typeof resolver === "function" ? resolver : null;
    },
  },
};
