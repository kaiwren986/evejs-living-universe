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
  resolveAbyssalDeployableLaunchRestriction,
  resolveDeployableAbyssalRestriction,
} = require(path.join(__dirname, "../_shared/abyssalDeployablePolicy"));

const log = require(path.join(__dirname, "../../utils/logger"));
const {
  ITEM_FLAGS,
  findItemById,
  findShipItemById,
  getItemMetadata,
  listSystemSpaceItems,
  updateInventoryItem,
} = require(path.join(__dirname, "../inventory/itemStore"));
const mobileItemCustody = require(path.join(__dirname, "../inventory/mobileItemCustody"));
const itemStore = require("../inventory/itemStore");
const { normalizeRoleValue, ROLE_GML, ROLE_WORLDMOD } = require("../account/accountRoleProfiles");
const { TABLE, readStaticRows } = require("../_shared/referenceData");
const { buildDict, buildMarshalReal } = require("../_shared/serviceHelpers");
const characterEnergyState = require("../character/characterEnergyState");
const interferenceState = require("../map/solarSystemInterferenceState");
const InterferenceMgr = require("../map/solarsystemInterferenceMgrService");
const characterEnergyMgrService = require(path.join(
  __dirname,
  "../character/characterEnergyMgrService",
));
const worldData = require(path.join(__dirname, "../../space/worldData"));
const {
  getCachedCharacterSkillMap,
} = require(path.join(__dirname, "../skills/skillState"));
const {
  isTriglavianSolarSystemID,
  isWormholeSolarSystemID,
} = require(path.join(__dirname, "../chat/channelRules"));
const {
  matchesTypeList,
} = require(path.join(__dirname, "../inventory/typeListAuthority"));

const CATEGORY_DEPLOYABLE = 22;
const CATEGORY_UPWELL_STRUCTURE = 65;
const GROUP_CONTROL_TOWER = 365;
const GROUP_MOBILE_ANALYSIS_BEACON = 4137;
const TYPE_CONCORD_ROGUE_ANALYSIS_BEACON = 60244;
const TYPE_CONCORD_CARRIER_ROGUE_ANALYSIS_BEACON = 92183;
const TYPE_ANCHORING = 11584;
const TYPE_COCKROACH = 11019;
const TYPE_LIST_STANDARD_CRAB_LINKABLE_SHIPS = 300;
const TYPE_LIST_CARRIER_CRAB_LINKABLE_SHIPS = 946;

const LINKSTATE_IDLE = 1;
const LINKSTATE_RUNNING = 2;
const LINKSTATE_COMPLETED = 3;

const DEPLOY_DISTANCE_METERS = 2_500;
const MOBILE_ANALYSIS_BEACON_ACTIVATION_DELAY_MS = 20 * 1000;
const MOBILE_ANALYSIS_BEACON_LINK_DURATION_MS = 4 * 60 * 1000;
const MOBILE_ANALYSIS_BEACON_QUICK_LINK_DURATION_MS = 1000;
const MOBILE_ANALYSIS_BEACON_LINK_STATUS_CLEAR_DELAY_MS = 60 * 1000;
const MOBILE_ANALYSIS_BEACON_CHARACTER_ENERGY_COST = 33;
const MOBILE_ANALYSIS_BEACON_SCAN_DURATION_MS = 10 * 60 * 1000;
const CARRIER_ANALYSIS_BEACON_SCAN_DURATION_MS = 16 * 60 * 1000;
const ANALYSIS_BEACON_REWARD_ACCESS_MS = 2 * 60 * 1000;
const DESTRUCTION_EFFECT_EXPLOSION = 3;
const ANALYSIS_BEACON_TICK_MS = 1000;
const ANALYSIS_BEACON_WAVE_INTERVAL_MS = 2 * 60 * 1000;
const MOBILE_ANALYSIS_BEACON_LIFETIME_MS = 60 * 60 * 1000;
const MOBILE_ANALYSIS_BEACON_SECURITY_CUTOFF = 0.45;
const MOBILE_ANALYSIS_BEACON_MIN_DISTANCE_FROM_UPWELL_METERS = 10_000_000;
const MOBILE_ANALYSIS_BEACON_MIN_DISTANCE_FROM_CONTROL_TOWER_METERS = 30_000_000;
const CUSTOM_INFO_KEY = "evejsMobileAnalysisBeacon";
const SHIP_CATEGORY = 6;
const GROUP_TITAN = 30;
const GROUP_DREADNOUGHT = 485;
const GROUP_CARRIER = 547;
const GROUP_SUPERCARRIER = 659;
const GROUP_LANCER_DREADNOUGHT = 4594;
const GROUP_COMMAND_CARRIER = 5120;
const STANDARD_CRAB_LINKABLE_SHIP_GROUP_IDS = new Set([
  GROUP_TITAN,
  GROUP_DREADNOUGHT,
  GROUP_CARRIER,
  GROUP_SUPERCARRIER,
  GROUP_LANCER_DREADNOUGHT,
  GROUP_COMMAND_CARRIER,
]);
const STANDARD_CRAB_LINKABLE_SHIP_TYPE_IDS = new Set([TYPE_COCKROACH]);
const CARRIER_CRAB_LINKABLE_SHIP_GROUP_IDS = new Set([
  GROUP_CARRIER,
  GROUP_COMMAND_CARRIER,
]);
const CARRIER_CRAB_LINKABLE_SHIP_TYPE_IDS = new Set();

const timersByBeaconID = new Map();
const pendingLinkPayments = new Map();
let nowMsOverride = null;

function currentMobileAnalysisBeaconNowMs() {
  const overridden = typeof nowMsOverride === "function" ? Number(nowMsOverride()) : NaN;
  return Number.isFinite(overridden) ? overridden : Date.now();
}

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

function getLinkAttributes(typeID) {
  const authored = readStaticRows(TABLE.CLIENT_SHIP_LINK_COMPONENTS)
    .find((row) => Number(row.typeID) === Number(typeID));
  return {
    characterEnergyCost: toReal(authored && authored.characterEnergyCost,
      Number(typeID) === TYPE_CONCORD_CARRIER_ROGUE_ANALYSIS_BEACON ? 25 : 33),
    solarsystemInterferenceCost: toReal(authored && authored.solarsystemInterferenceCost,
      Number(typeID) === TYPE_CONCORD_CARRIER_ROGUE_ANALYSIS_BEACON ? 500 : 550),
    maxLinkRange: toReal(authored && authored.maxLinkRange, 5000),
    linkDurationMs: toReal(authored && authored.linkDuration, 240) * 1000,
    linkEffectGraphicID: toInt(authored && authored.linkEffectGraphicIDOverride, 25114),
  };
}

function synchronizeBeaconLinkEffect(itemID) {
  const item = findItemById(itemID);
  const state = getMobileAnalysisBeaconStateFromItem(item);
  const scene = getSpaceRuntime().findSceneContainingDynamicEntity(itemID);
  const beacon = scene?.getEntityByID(itemID);
  if (!state || !beacon || !state.active || state.deactivatedAtMs ||
      state.linkState === LINKSTATE_IDLE || !scene.getEntityByID(state.linkedShipID)) return;

  // The component starts the beam locally. Its first EveStretch3.Prepare sets
  // flags on the beam only; updating that activation also sets the beacon's
  // controller variables, which drive the linking ring and scanning sphere.
  // Queue after the slim update so this merges with the component's beam.
  const encounter = state.encounter;
  try {
    scene.broadcastSpecialFx(state.linkedShipID, "effects.LinkWithShipComponent", {
      targetID: itemID,
      start: true,
      active: true,
      repeat: 99,
      graphicInfo: buildDict([
        ["graphicIDOverride", getLinkAttributes(item.typeID).linkEffectGraphicID],
        ["locatorSetName", "linkwithship"],
        ["deathTimer", 10],
        ["controllerTrigger", buildDict([
          ["Activate_IsActive", buildMarshalReal(1)],
          ["LinkWithShip_Active", buildMarshalReal(state.linkState === LINKSTATE_RUNNING ? 1 : 0)],
          ["LinkWithShip_Complete", buildMarshalReal(state.linkState === LINKSTATE_COMPLETED ? 1 : 0)],
          ["HostileBaiter_Active", buildMarshalReal(encounter ? 1 : 0)],
          ["HostileBaiter_Paused", buildMarshalReal(encounter?.pausedAtMs ? 1 : 0)],
          ["HostileBaiter_Completed", buildMarshalReal(encounter?.rewardedAtMs ? 1 : 0)],
        ])],
      ]),
    }, beacon);
  } catch (error) {
    log.warn(`[MobileAnalysisBeacon] Link effect synchronization failed beacon=${itemID}: ${error.message}`);
  }
}

function normalizeEncounter(raw) {
  if (!raw || raw.version !== 1) return null;
  return {
    version: 1,
    startedAtMs: toInt(raw.startedAtMs),
    updatedAtMs: toInt(raw.updatedAtMs),
    durationMs: Math.max(1, toInt(raw.durationMs, MOBILE_ANALYSIS_BEACON_SCAN_DURATION_MS)),
    remainingMs: Math.max(0, toInt(raw.remainingMs)),
    pausedAtMs: toInt(raw.pausedAtMs),
    waveIndex: Math.max(0, toInt(raw.waveIndex)),
    members: (Array.isArray(raw.members) ? raw.members : []).map((member) => ({
      typeID: toInt(member.typeID), entityID: toInt(member.entityID), key: String(member.key || ""),
      arrivalPending: member.arrivalPending === true,
    })),
    rewardManifest: (Array.isArray(raw.rewardManifest) ? raw.rewardManifest : []).map((entry) => ({
      typeID: toInt(entry.typeID), quantity: Math.max(1, toInt(entry.quantity, 1)),
    })),
    rewardedAtMs: toInt(raw.rewardedAtMs),
  };
}

function getSyncInventoryItemForSession() {
  const characterState = require(path.join(__dirname, "../character/characterState"));
  return characterState.syncInventoryItemForSession;
}

function isMobileAnalysisBeaconType(typeIDOrItem) {
  if (typeIDOrItem && typeof typeIDOrItem === "object") {
    return (
      toInt(typeIDOrItem.categoryID, 0) === CATEGORY_DEPLOYABLE &&
      toInt(typeIDOrItem.groupID, 0) === GROUP_MOBILE_ANALYSIS_BEACON
    ) || isMobileAnalysisBeaconType(toInt(typeIDOrItem.typeID, 0));
  }

  const typeID = toInt(typeIDOrItem, 0);
  if (
    typeID === TYPE_CONCORD_ROGUE_ANALYSIS_BEACON ||
    typeID === TYPE_CONCORD_CARRIER_ROGUE_ANALYSIS_BEACON
  ) {
    return true;
  }
  const metadata = getItemMetadata(typeID) || {};
  return (
    toInt(metadata.categoryID, 0) === CATEGORY_DEPLOYABLE &&
    toInt(metadata.groupID, 0) === GROUP_MOBILE_ANALYSIS_BEACON
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
    // ignored: preserve opaque legacy customInfo values.
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
    beaconID: toInt(state.beaconID, 0),
    deployedAtMs: toInt(state.deployedAtMs, 0),
    activateAtMs: toInt(state.activateAtMs, 0),
    activatedAtMs: toInt(state.activatedAtMs, 0),
    expiresAtMs: toInt(state.expiresAtMs, 0),
    active: state.active === true,
    deactivatedAtMs: toInt(state.deactivatedAtMs, 0),
    linkState: toInt(state.linkState, LINKSTATE_IDLE),
    linkCompleteAtMs: toInt(state.linkCompleteAtMs, 0),
    linkedShipID: toInt(state.linkedShipID, 0),
    linkedCharacterID: toInt(state.linkedCharacterID, toInt(state.deployerCharacterID, 0)),
    rewardWreckGeneration: Math.max(0, toInt(state.rewardWreckGeneration)),
    encounter: normalizeEncounter(state.encounter),
    linkPayment: state.linkPayment ? JSON.parse(JSON.stringify(state.linkPayment)) : null,
  };
}

function getMobileAnalysisBeaconStateFromItem(item) {
  if (!item || !isMobileAnalysisBeaconType(item)) {
    return null;
  }
  const state = getStateFromCustomInfo(item.customInfo);
  if (!state || state.beaconID <= 0) {
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
    beaconID: toInt(state.beaconID, 0),
    deployedAtMs: toInt(state.deployedAtMs, 0),
    activateAtMs: toInt(state.activateAtMs, 0),
    activatedAtMs: toInt(state.activatedAtMs, 0),
    expiresAtMs: toInt(state.expiresAtMs, 0),
    active: state.active === true,
    deactivatedAtMs: toInt(state.deactivatedAtMs, 0),
    linkState: toInt(state.linkState, LINKSTATE_IDLE),
    linkCompleteAtMs: toInt(state.linkCompleteAtMs, 0),
    linkedShipID: toInt(state.linkedShipID, 0),
    linkedCharacterID: toInt(state.linkedCharacterID, toInt(state.deployerCharacterID, 0)),
    rewardWreckGeneration: Math.max(0, toInt(state.rewardWreckGeneration)),
    encounter: normalizeEncounter(state.encounter),
    linkPayment: state.linkPayment ? JSON.parse(JSON.stringify(state.linkPayment)) : null,
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

function isAbyssalSession(session) {
  return Boolean(resolveDeployableAbyssalRestriction(
    session,
    getSessionContext(session),
  ));
}

function getSolarSystemSecurity(system) {
  const security = Math.max(0, Math.min(1, toReal(system && system.security, 0)));
  if (security > 0 && security < 0.05) {
    return 0.05;
  }
  return security;
}

function getDeploymentRestriction(session, context) {
  if (resolveDeployableAbyssalRestriction(session, context)) {
    return "Mobile Analysis Beacons cannot be deployed in Abyssal space.";
  }
  if (isWormholeSolarSystemID(context.systemID)) {
    return "Mobile Analysis Beacons can only be deployed in low and null security space.";
  }
  if (isTriglavianSolarSystemID(context.systemID)) {
    return "Mobile Analysis Beacons can only be deployed in low and null security space.";
  }

  const system = worldData.getSolarSystemByID(context.systemID);
  if (!system) {
    return "Solar system data is unavailable for this deployment.";
  }
  if (getSolarSystemSecurity(system) >= MOBILE_ANALYSIS_BEACON_SECURITY_CUTOFF) {
    return "Mobile Analysis Beacons can only be deployed below 0.5 security.";
  }
  return null;
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
  const typeID = getObjectTypeID(source);
  const metadata = typeID > 0 ? (getItemMetadata(typeID) || {}) : {};
  const groupID = toInt(source && source.groupID, toInt(metadata.groupID, 0));
  const categoryID = toInt(source && source.categoryID, toInt(metadata.categoryID, 0));

  if (categoryID === CATEGORY_UPWELL_STRUCTURE) {
    return "upwell";
  }
  if (groupID === GROUP_CONTROL_TOWER) {
    return "controlTower";
  }
  return null;
}

function getPlacementBlockerMinimumDistance(kind) {
  if (kind === "upwell") {
    return MOBILE_ANALYSIS_BEACON_MIN_DISTANCE_FROM_UPWELL_METERS;
  }
  if (kind === "controlTower") {
    return MOBILE_ANALYSIS_BEACON_MIN_DISTANCE_FROM_CONTROL_TOWER_METERS;
  }
  return 0;
}

function getPlacementConflictError(kind) {
  if (kind === "upwell") {
    return "MOBILE_ANALYSIS_BEACON_TOO_CLOSE_TO_UPWELL";
  }
  if (kind === "controlTower") {
    return "MOBILE_ANALYSIS_BEACON_TOO_CLOSE_TO_CONTROL_TOWER";
  }
  return "MOBILE_ANALYSIS_BEACON_DEPLOYMENT_BLOCKED";
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
        ...options,
        kind,
      },
    );
  };

  for (const item of listSystemSpaceItems(systemID)) {
    append(item);
  }

  const scene = getSpaceRuntime().ensureScene(systemID);
  if (scene) {
    for (const entity of scene.staticEntities || []) {
      append(entity);
    }
    for (const entity of scene.dynamicEntities ? scene.dynamicEntities.values() : []) {
      append(entity);
    }
  }

  if (worldData && typeof worldData.getCelestialsForSystem === "function") {
    for (const celestial of worldData.getCelestialsForSystem(systemID)) {
      append(celestial);
    }
  }

  return blockers;
}

function findPlacementConflict(session, item, context, spawnState) {
  const position = getObjectPosition({ spaceState: spawnState });
  if (!position) {
    return {
      errorMsg: "MOBILE_ANALYSIS_BEACON_DEPLOYMENT_POSITION_UNAVAILABLE",
    };
  }

  const blockers = collectPlacementBlockers(session, context, {
    sourceItemID: item && item.itemID,
  });
  for (const blocker of blockers) {
    const distance = getVectorDistance(position, blocker.position);
    const clearDistance = Math.max(0, distance - toReal(blocker.radius, 0));
    if (clearDistance < blocker.minimumDistance) {
      return {
        ...blocker,
        distance,
        clearDistance,
      };
    }
  }
  return null;
}

function buildDeployableSpawnState(session, context) {
  const shipEntity =
    session && session._space && session._space.shipID
      ? getSpaceRuntime().getEntity(session, session._space.shipID)
      : null;
  const position = shipEntity && hasFiniteVectorCoordinates(shipEntity.position)
    ? normalizeVector(shipEntity.position)
    : null;
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

function updateMobileAnalysisBeaconState(itemID, updater) {
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
      errorMsg: "MOBILE_ANALYSIS_BEACON_STATE_NOT_FOUND",
    };
  }
  const nextState =
    typeof updater === "function" ? updater({ ...currentState }, item) : updater;
  return updateInventoryItem(itemID, (currentItem) => ({
    ...currentItem,
    customInfo: buildCustomInfoWithState(currentItem.customInfo, nextState),
  }));
}

function rollbackLinkPayment(beaconID, payment) {
  pendingLinkPayments.set(beaconID, payment);
  try {
    if (payment.version !== 1 || payment.beaconID !== beaconID ||
        !Number.isSafeInteger(payment.characterID) || payment.characterID <= 0 ||
        payment.solarSystemID !== payment.previousBeaconState?.solarSystemID ||
        payment.previousBeaconState?.beaconID !== beaconID ||
        payment.previousBeaconState?.linkState !== LINKSTATE_IDLE) {
      throw new Error("INVALID_ANALYSIS_BEACON_PAYMENT");
    }
    // Fence the undo intent before touching either resource. A failed link
    // commit may have reached disk even when its acknowledgement was lost.
    requireBeaconResult(updateMobileAnalysisBeaconState(beaconID, () => ({
      ...payment.previousBeaconState, linkPayment: payment,
    })));
    requireBeaconResult(require("../../gameStore").flushTableSync("items"));
    requireBeaconResult(characterEnergyState.restoreCharacterEnergyState(payment.characterID, payment.energyBefore));
    requireBeaconResult(interferenceState.restoreSolarSystemInterferenceState(payment.solarSystemID, payment.interferenceBefore));
    requireBeaconResult(updateMobileAnalysisBeaconState(beaconID, () => payment.previousBeaconState));
    requireBeaconResult(require("../../gameStore").flushTableSync("items"));
    pendingLinkPayments.delete(beaconID);
    return { success: true };
  } catch (error) {
    log.warn(`[MobileAnalysisBeacon] Payment recovery pending beacon=${beaconID}: ${error.message}`);
    return { success: false, errorMsg: "MOBILE_ANALYSIS_BEACON_PAYMENT_RECOVERY_PENDING" };
  }
}

function recoverPendingLinkPayments() {
  // All CRAB resource writers use this barrier. An unfinished payment must be
  // undone before another beacon can change the same character or system.
  for (const item of itemStore.listItemsMatching((row) =>
    Number(row.groupID) === GROUP_MOBILE_ANALYSIS_BEACON ||
    [TYPE_CONCORD_ROGUE_ANALYSIS_BEACON, TYPE_CONCORD_CARRIER_ROGUE_ANALYSIS_BEACON].includes(Number(row.typeID)))) {
    const state = getMobileAnalysisBeaconStateFromItem(item);
    if (state?.linkPayment && !pendingLinkPayments.has(item.itemID)) {
      pendingLinkPayments.set(item.itemID, state.linkPayment);
    }
  }
  for (const [beaconID, payment] of pendingLinkPayments) {
    const result = rollbackLinkPayment(beaconID, payment);
    if (!result.success) return result;
  }
  return { success: true };
}

function payForBeaconLink(session, item, state, context, attributes, filetime, linkCompleteAtMs) {
  let energyBefore;
  let interferenceBefore;
  try {
    // Only a confirmed absent row is a null preimage. A failed read must not
    // journal a deletion for rollback or allow either resource to be charged.
    energyBefore = requireBeaconResult(characterEnergyState.readCharacterEnergyState(
      context.characterID,
    )).data;
    interferenceBefore = requireBeaconResult(interferenceState.readSolarSystemInterferenceState(
      context.systemID,
    )).data;
  } catch (error) {
    return { success: false, errorMsg: error.message };
  }
  const payment = {
    version: 1, beaconID: item.itemID, characterID: context.characterID,
    solarSystemID: context.systemID,
    previousBeaconState: { ...state, linkPayment: null },
    energyBefore,
    interferenceBefore,
  };
  pendingLinkPayments.set(item.itemID, payment);
  try {
    requireBeaconResult(updateMobileAnalysisBeaconState(item.itemID, (current) => ({ ...current, linkPayment: payment })));
    requireBeaconResult(require("../../gameStore").flushTableSync("items"));
    const energy = requireBeaconResult(characterEnergyMgrService.spendCharacterEnergy(
      session, attributes.characterEnergyCost, { filetime, publish: false },
    ));
    const interference = requireBeaconResult(interferenceState.addSolarSystemInterference(
      context.systemID, attributes.solarsystemInterferenceCost, { filetime },
    ));
    requireBeaconResult(require("../../gameStore").flushTablesSync(["characterEnergyState", "solarSystemInterferenceState"]));
    const updated = requireBeaconResult(updateMobileAnalysisBeaconState(item.itemID, (current) => ({
      ...current, active: true, activatedAtMs: current.activatedAtMs || currentMobileAnalysisBeaconNowMs(),
      linkState: LINKSTATE_RUNNING, linkCompleteAtMs,
      linkedShipID: context.shipID, linkedCharacterID: context.characterID, linkPayment: null,
    })));
    requireBeaconResult(require("../../gameStore").flushTableSync("items"));
    pendingLinkPayments.delete(item.itemID);
    return { success: true, updated, energy: energy.data.state, interference: interference.data.state };
  } catch (error) {
    const rollback = rollbackLinkPayment(item.itemID, payment);
    return { success: false, errorMsg: rollback.success ? error.message : rollback.errorMsg };
  }
}

function clearTimers(beaconID) {
  const normalizedBeaconID = toInt(beaconID, 0);
  const timerState = timersByBeaconID.get(normalizedBeaconID);
  if (!timerState) {
    return;
  }
  for (const timer of [
    timerState.activationTimer,
    timerState.expiryTimer,
    timerState.linkTimer,
    timerState.encounterTimer,
  ]) {
    if (timer) {
      clearTimeout(timer);
    }
  }
  timersByBeaconID.delete(normalizedBeaconID);
}

function setUnrefTimeout(callback, delayMs) {
  const timer = setTimeout(callback, Math.max(0, toInt(delayMs, 0)));
  if (typeof timer.unref === "function") {
    timer.unref();
  }
  return timer;
}

function clearMobileAnalysisBeacon(itemOrID, reason = "cleared") {
  const itemID = toInt(itemOrID && itemOrID.itemID ? itemOrID.itemID : itemOrID, 0);
  if (!itemID) {
    return false;
  }
  clearTimers(itemID);

  const liveItem = findItemById(itemID);
  const item = liveItem || (itemOrID && itemOrID.itemID ? itemOrID : null);
  let state = getMobileAnalysisBeaconStateFromItem(item);
  if (!state) {
    return false;
  }
  if (liveItem && (state.linkPayment || pendingLinkPayments.has(itemID))) {
    if (!rollbackLinkPayment(itemID, pendingLinkPayments.get(itemID) || state.linkPayment).success) return false;
    state = getMobileAnalysisBeaconStateFromItem(findItemById(itemID));
  }

  cleanupBeaconNpcs(state);
  const linkedScene = getSpaceRuntime().findSceneContainingDynamicEntity(state.linkedShipID);
  const linkedShip = linkedScene?.getEntityByID(state.linkedShipID);
  if (toInt(linkedShip?.mobileAnalysisBeaconLinkedBeaconID) === state.beaconID) {
    // Both authored CRAB link components clear their restrictions on a broken
    // link. Do not clear a newer link that now owns the same ship.
    for (const field of ["mobileAnalysisBeaconLinkedBeaconID", "mobileAnalysisBeaconImmobileUntilMs",
      "mobileAnalysisBeaconWarpDisabledUntilMs", "mobileAnalysisBeaconCloakBlockedUntilMs",
      "mobileAnalysisBeaconTetherBlockedUntilMs"]) {
      delete linkedShip[field];
    }
  }

  if (findItemById(itemID)) {
    updateMobileAnalysisBeaconState(itemID, (currentState) => ({
      ...currentState,
      active: false,
      deactivatedAtMs: currentMobileAnalysisBeaconNowMs(),
    }));
  }
  log.info(`[MobileAnalysisBeacon] Cleared beacon=${itemID} reason=${reason}`);
  return true;
}

function activateMobileAnalysisBeacon(itemID) {
  const item = findItemById(itemID);
  const state = getMobileAnalysisBeaconStateFromItem(item);
  if (!state) {
    clearTimers(itemID);
    return false;
  }
  if (resolveAbyssalDeployableItemRestriction(item, state)) {
    clearMobileAnalysisBeacon(item, "abyssal-authority-forbidden");
    return false;
  }

  const now = currentMobileAnalysisBeaconNowMs();
  if (state.expiresAtMs > 0 && state.expiresAtMs <= now) {
    expireMobileAnalysisBeacon(itemID, "expired-before-activation");
    return false;
  }
  if (
    toInt(item.locationID, 0) !== state.solarSystemID ||
    toInt(item.flagID, 0) !== 0 ||
    !item.spaceState
  ) {
    clearMobileAnalysisBeacon(item, "removed-before-activation");
    return false;
  }

  let updated;
  try {
    updated = updateMobileAnalysisBeaconState(itemID, (currentState) => ({
      ...currentState,
      active: true,
      activatedAtMs: now,
    }));
  } catch (error) {
    updated = { success: false, errorMsg: error.message };
  }
  if (!updated?.success) {
    log.warn(`[MobileAnalysisBeacon] Activation pending beacon=${itemID}: ${updated?.errorMsg || "WRITE_ERROR"}`);
    scheduleMobileAnalysisBeaconTimers(itemID);
    return false;
  }
  scheduleMobileAnalysisBeaconTimers(itemID);
  try {
    getSpaceRuntime().refreshInventoryBackedEntityPresentation(state.solarSystemID, itemID);
  } catch (error) {
    log.warn(`[MobileAnalysisBeacon] Activation presentation pending beacon=${itemID}: ${error.message}`);
  }
  log.info(
    `[MobileAnalysisBeacon] Activated beacon=${itemID} system=${state.solarSystemID}`,
  );
  return true;
}

function completeMobileAnalysisBeaconLink(itemID) {
  const item = findItemById(itemID);
  const state = getMobileAnalysisBeaconStateFromItem(item);
  if (!state) {
    clearTimers(itemID);
    return false;
  }
  if (resolveAbyssalDeployableItemRestriction(item, state)) {
    clearMobileAnalysisBeacon(item, "abyssal-authority-forbidden");
    return false;
  }
  if (toInt(state.linkState, LINKSTATE_IDLE) !== LINKSTATE_RUNNING) {
    scheduleMobileAnalysisBeaconTimers(itemID);
    return false;
  }

  const now = currentMobileAnalysisBeaconNowMs();
  if (state.expiresAtMs > 0 && state.expiresAtMs <= now) {
    expireMobileAnalysisBeacon(itemID, "expired-before-link-complete");
    return false;
  }
  if (state.linkCompleteAtMs > now) {
    scheduleMobileAnalysisBeaconTimers(itemID);
    return false;
  }

  let updated;
  try {
    updated = updateMobileAnalysisBeaconState(itemID, (currentState) => ({
      ...currentState,
      linkState: LINKSTATE_COMPLETED,
      encounter: currentState.encounter || createBeaconEncounter(item, now),
    }));
  } catch (error) {
    updated = { success: false, errorMsg: error.message };
  }
  if (!updated?.success) {
    log.warn(`[MobileAnalysisBeacon] Link completion pending beacon=${itemID}: ${updated?.errorMsg || "WRITE_ERROR"}`);
    scheduleMobileAnalysisBeaconTimers(itemID);
    return false;
  }
  scheduleMobileAnalysisBeaconTimers(itemID);
  try {
    getSpaceRuntime().refreshInventoryBackedEntityPresentation(state.solarSystemID, itemID);
    synchronizeBeaconLinkEffect(itemID);
  } catch (error) {
    log.warn(`[MobileAnalysisBeacon] Link completion presentation pending beacon=${itemID}: ${error.message}`);
  }
  log.info(
    `[MobileAnalysisBeacon] Link completed beacon=${itemID} ship=${state.linkedShipID} system=${state.solarSystemID}`,
  );
  return true;
}

// CCP's scan durations and client state shape are public. Wave mixes and loot
// quantities below are an emulator approximation, not a captured retail table.
function createBeaconEncounter(item, now) {
  const carrier = Number(item.typeID) === TYPE_CONCORD_CARRIER_ROGUE_ANALYSIS_BEACON;
  const durationMs = carrier ? CARRIER_ANALYSIS_BEACON_SCAN_DURATION_MS : MOBILE_ANALYSIS_BEACON_SCAN_DURATION_MS;
  const seed = Number(item.itemID) % 16;
  return normalizeEncounter({ version: 1, startedAtMs: now, updatedAtMs: now,
    durationMs, remainingMs: durationMs,
    rewardManifest: [
      { typeID: 60459, quantity: Math.round((1000 + seed * 25) * (carrier ? 1.6 : 1)) },
      { typeID: 60460 + seed, quantity: carrier ? 3 : 2 },
    ],
  });
}

function requireBeaconResult(result) {
  if (!result || !result.success) throw new Error(result && result.errorMsg || "ANALYSIS_BEACON_STORAGE_FAILED");
  return result;
}

function saveBeaconEncounter(itemID, encounter, options = {}) {
  const result = requireBeaconResult(updateMobileAnalysisBeaconState(itemID, (state) => ({
    ...state, encounter,
  })));
  if (options.durable) {
    requireBeaconResult(require("../../gameStore").flushTableSync("items"));
  }
  return result;
}

function beaconNpcRecords(state) {
  const prefix = `crab:${state.beaconID}:`;
  return require("../../space/npc/nativeNpcStore").listNativeEntitiesForSystem(state.solarSystemID)
    .filter((record) => record.anchorID === state.beaconID && String(record.spawnGroupID || "").startsWith(prefix));
}

function ownsBeaconNpcRecord(record) {
  if (!record || !String(record.spawnGroupID || "").startsWith("crab:")) return false;
  const item = findItemById(record.anchorID);
  const state = getMobileAnalysisBeaconStateFromItem(item);
  return Boolean(state && !state.deactivatedAtMs && item.flagID === 0 &&
    item.locationID === record.systemID && state.encounter?.members.some((member) =>
      member.key === record.spawnGroupID && member.typeID === record.typeID &&
      (!member.entityID || member.entityID === record.entityID)));
}

function cleanupBeaconNpcs(state) {
  const records = beaconNpcRecords(state);
  if (!records.length) return;
  const scene = getSpaceRuntime().findSceneContainingDynamicEntity(state.beaconID);
  for (const record of records) {
    if (scene) {
      requireBeaconResult(require("../../space/npc/nativeNpcService").destroyNativeNpcController({
        entityID: record.entityID, systemID: state.solarSystemID,
      }, { scene, broadcast: true, suppressWreck: true }));
    } else {
      require("../../space/npc/npcRegistry").unregisterController(record.entityID);
      requireBeaconResult(require("../../space/npc/nativeNpcStore").removeNativeEntityCascade(record.entityID));
    }
  }
}

function spawnBeaconWave(item, state, encounter, scene) {
  const native = require("../../space/npc/nativeNpcService");
  let profiles;
  const records = beaconNpcRecords(state);
  const beacon = scene.getEntityByID(state.beaconID);
  const carrier = item.typeID === TYPE_CONCORD_CARRIER_ROGUE_ANALYSIS_BEACON;
  for (const member of encounter.members) {
    const recorded = member.entityID && require("../../space/npc/nativeNpcStore").getNativeEntity(member.entityID);
    if (recorded?.nativeDeathWreck) {
      requireBeaconResult(require("../../space/npc/nativeNpcDeathWrecks").settle(scene, recorded));
      continue;
    }
    if (!member.entityID) {
      member.arrivalPending = true;
      const prior = records.find((record) => record.spawnGroupID === member.key);
      if (prior) {
        member.entityID = prior.entityID;
      } else {
        profiles ||= require("../../space/npc/npcData").listNpcProfiles();
        const profile = profiles.find((row) => row.shipTypeID === member.typeID);
        if (!profile) throw new Error(`ANALYSIS_BEACON_NPC_PROFILE_MISSING:${member.typeID}`);
        const result = requireBeaconResult(native.spawnNativeNpcEntityInSystem(state.solarSystemID, {
          profileQuery: profile.profileID,
          anchorEntity: beacon,
          sceneDescriptor: scene.sceneDescriptor,
          spawnGroupID: member.key,
          preferredTargetID: state.linkedShipID,
          fallbackOwnerID: 500025, // Rogue Drones
          transient: false,
          materializeRuntime: false,
          behaviorOverrides: { autoAggro: true, autoActivateWeapons: true,
            ...(carrier ? { autoAggroTargetClasses: ["player"] } : {}),
          },
        }));
        member.entityID = result.data.entityRecord.entityID;
      }
      // Birth and membership are durable before the NPC becomes targetable.
      for (const table of ["npcEntities", "npcModules", "npcCargo", "npcRuntimeControllers"]) {
        requireBeaconResult(require("../../gameStore").flushTableSync(table));
      }
      saveBeaconEncounter(state.beaconID, encounter, { durable: true });
    }
    // A recorded death must never respawn; an unloaded living member can be
    // projected again from the same persistent native NPC record.
    if (!scene.getEntityByID(member.entityID) &&
        require("../../space/npc/nativeNpcStore").getNativeEntity(member.entityID)) {
      requireBeaconResult(native.materializeStoredNativeController(scene, member.entityID, {
        broadcast: true,
        warpIn: member.arrivalPending,
        onWarpInRefused() {
          // A queued ingress can be refused on the following Destiny tick.
          // Keep its durable birth and retry the arrival, not another NPC.
          const current = getMobileAnalysisBeaconStateFromItem(findItemById(state.beaconID));
          const retry = current?.encounter?.members.find((entry) => entry.entityID === member.entityID);
          if (!retry || current.deactivatedAtMs) return;
          retry.arrivalPending = true;
          saveBeaconEncounter(state.beaconID, current.encounter, { durable: true });
        },
      }));
      if (member.arrivalPending) {
        member.arrivalPending = false;
        saveBeaconEncounter(state.beaconID, encounter, { durable: true });
      }
    }
  }
}

function processBeaconEncounter(itemID) {
  const item = findItemById(itemID);
  const state = getMobileAnalysisBeaconStateFromItem(item);
  const now = currentMobileAnalysisBeaconNowMs();
  if (!state || state.deactivatedAtMs || state.linkState !== LINKSTATE_COMPLETED) return false;
  if (resolveAbyssalDeployableItemRestriction(item, state) ||
      item.locationID !== state.solarSystemID || item.flagID !== 0 || !item.spaceState) {
    clearMobileAnalysisBeacon(item, "encounter-item-unavailable");
    return false;
  }
  if (state.expiresAtMs <= now) return expireMobileAnalysisBeacon(itemID);
  const encounter = state.encounter || createBeaconEncounter(item, now);
  if (encounter.rewardedAtMs) return true;
  const scene = getSpaceRuntime().findSceneContainingDynamicEntity(itemID);
  if (!scene) {
    // Never award scanning progress in a scene that is not being simulated.
    encounter.updatedAtMs = now;
    saveBeaconEncounter(itemID, encounter);
    return false;
  }

  if (encounter.members.length) {
    spawnBeaconWave(item, state, encounter, scene);
    const liveIDs = new Set(beaconNpcRecords(state).map((record) => record.entityID));
    if (encounter.members.some((member) => liveIDs.has(member.entityID))) {
      encounter.pausedAtMs ||= now;
      encounter.updatedAtMs = now;
      saveBeaconEncounter(itemID, encounter);
      getSpaceRuntime().refreshInventoryBackedEntityPresentation(state.solarSystemID, itemID);
      return true;
    }
    encounter.members = [];
    encounter.pausedAtMs = 0;
    encounter.updatedAtMs = now;
  } else if (!encounter.pausedAtMs) {
    encounter.remainingMs = Math.max(0, encounter.remainingMs - Math.max(0, now - encounter.updatedAtMs));
    encounter.updatedAtMs = now;
  }

  // Each wave is planned durably before its first birth. Recovery adopts an
  // already-created actor by its beacon/slot key rather than spawning another.
  const waveAtMs = encounter.waveIndex * ANALYSIS_BEACON_WAVE_INTERVAL_MS;
  if (waveAtMs < encounter.durationMs && encounter.durationMs - encounter.remainingMs >= waveAtMs) {
    const mixes = [[60317, 60316], [60382, 60316, 60316], [60255, 60332, 60316]];
    const types = mixes[encounter.waveIndex % mixes.length];
    encounter.waveIndex += 1;
    encounter.members = types.map((typeID, index) => ({ typeID, entityID: 0,
      key: `crab:${itemID}:${encounter.waveIndex}:${index}`, arrivalPending: true }));
    encounter.pausedAtMs = now;
    saveBeaconEncounter(itemID, encounter, { durable: true });
    spawnBeaconWave(item, state, encounter, scene);
  } else if (encounter.remainingMs === 0) {
    const grants = encounter.rewardManifest.map((entry) => ({
      itemType: getItemMetadata(entry.typeID), quantity: entry.quantity,
    }));
    const reward = requireBeaconResult(itemStore.grantItemsToOwnerLocationIdempotent(
      state.linkedCharacterID || state.ownerID, itemID, ITEM_FLAGS.CARGO_HOLD, grants,
      { receiptKey: `crab-reward:${itemID}`, grantedAtMs: now },
    ));
    encounter.rewardedAtMs = reward.receipt.grantedAtMs;
    // The marker and the shortened expiry share one write. A replay retains
    // the original grant timestamp, including the two-minute access window.
    requireBeaconResult(updateMobileAnalysisBeaconState(itemID, (current) => ({ ...current,
      encounter,
      expiresAtMs: Math.min(state.expiresAtMs, encounter.rewardedAtMs + ANALYSIS_BEACON_REWARD_ACCESS_MS),
    })));
    requireBeaconResult(require("../../gameStore").flushTableSync("items"));
  }
  saveBeaconEncounter(itemID, encounter);
  getSpaceRuntime().refreshInventoryBackedEntityPresentation(state.solarSystemID, itemID);
  return true;
}

function dropBeaconRewards(item, state) {
  const lootItems = itemStore.listContainerItems(null, state.beaconID, null);
  let generation = state.rewardWreckGeneration;
  const wreckReceiptKey = () => `crab-wreck:${state.beaconID}${generation ? `:${generation}` : ""}`;
  if (!lootItems.length) {
    // Delivery can finish before the wreck's first scene publication succeeds.
    // Replay an existing birth, but never create a wreck for an emptied hold.
    const prior = itemStore.getIdempotentGrantReceipt(wreckReceiptKey());
    if (!prior.success) return prior;
    if (!prior.found) return { success: true };
  }
  const createWreck = () => itemStore.createSpaceItemForOwnerIdempotent(state.linkedCharacterID || state.ownerID,
    state.solarSystemID, getItemMetadata(26468), {
      receiptKey: wreckReceiptKey(),
      fingerprint: { beaconID: state.beaconID, systemID: state.solarSystemID },
      ...buildChildEntityScopeMetadata(item.spaceState),
      position: item.spaceState.position,
      itemName: `${item.itemName || "CONCORD Rogue Analysis Beacon"} Wreck`,
      expiresAtMs: currentMobileAnalysisBeaconNowMs() + 2 * 60 * 60 * 1000,
      customInfo: JSON.stringify({ evejsLoot: { abandoned: true } }),
    });
  let result = createWreck();
  if (!result.success) return result;
  let wreckID = result.data.itemIDs?.[0] || result.data.items?.[0]?.itemID;
  if (!findItemById(wreckID)) {
    // Its public wreck may have been destroyed during final removal retries.
    if (!lootItems.length) return { success: true };
    // Only undelivered items move to a replacement. Checkpoint its receipt
    // generation before creating it so crash/retry cannot mint two wrecks.
    generation += 1;
    requireBeaconResult(updateMobileAnalysisBeaconState(state.beaconID, current => ({
      ...current, rewardWreckGeneration: generation,
    })));
    requireBeaconResult(require("../../gameStore").flushTableSync("items"));
    result = createWreck();
    if (!result.success) return result;
    wreckID = result.data.itemIDs?.[0] || result.data.items?.[0]?.itemID;
  }
  if (!findItemById(wreckID)) return { success: false, errorMsg: "ANALYSIS_BEACON_WRECK_UNAVAILABLE" };
  for (const loot of lootItems) {
    const moved = itemStore.moveItemToLocationIdempotent(loot.itemID, wreckID, ITEM_FLAGS.CARGO_HOLD, null, {
      receiptKey: `crab-wreck-loot:${state.beaconID}:${loot.itemID}${generation ? `:${generation}` : ""}`,
      fingerprint: { beaconID: state.beaconID, wreckID, itemID: loot.itemID },
    });
    if (!moved.success) return moved;
  }
  return getSpaceRuntime().spawnDynamicInventoryEntity(state.solarSystemID, wreckID);
}

function getBeaconCargoAccessError(session, item) {
  const state = getMobileAnalysisBeaconStateFromItem(item);
  if (!state || !item.spaceState || item.flagID !== 0) return null;
  if (state.deactivatedAtMs || !state.encounter || !state.encounter.rewardedAtMs) return "CONTAINER_NOT_READY";
  const shipID = toInt(session && (session.shipid || session.shipID || session._space && session._space.shipID));
  return shipID === state.linkedShipID ? null : "CONTAINER_NOT_VISIBLE";
}

function prepareMobileAnalysisBeaconDestruction(item) {
  item = findItemById(item?.itemID) || item;
  let state = getMobileAnalysisBeaconStateFromItem(item);
  if (!state) return { success: true };
  if (state.linkPayment || pendingLinkPayments.has(item.itemID)) {
    const recovery = rollbackLinkPayment(item.itemID, pendingLinkPayments.get(item.itemID) || state.linkPayment);
    if (!recovery.success) return recovery;
    item = findItemById(item.itemID);
    state = getMobileAnalysisBeaconStateFromItem(item);
  }
  try {
    // A process can die after the durable grant and before its presentation
    // marker. Expiry/destruction must preserve those already-earned items too.
    // The grant fences inventory before the encounter's completion marker.
    // Its durable preimage can still have scan time remaining at that boundary.
    const receipt = itemStore.getIdempotentGrantReceipt(`crab-reward:${state.beaconID}`);
    if (!receipt.success) return receipt;
    if (state.encounter?.rewardedAtMs || receipt.found) {
      const dropped = dropBeaconRewards(item, state);
      if (!dropped.success) return dropped;
    }
    cleanupBeaconNpcs(state);
    return { success: true };
  } catch (error) {
    return { success: false, errorMsg: error.message };
  }
}

function expireMobileAnalysisBeacon(itemID, reason = "expired") {
  const item = findItemById(itemID);
  const state = getMobileAnalysisBeaconStateFromItem(item);
  const systemID = toInt(
    state && state.solarSystemID,
    toInt(item && item.locationID, 0),
  );
  clearTimers(itemID);

  if (!item || !state) return false;
  let removeResult;
  try {
    const cleanupResult = prepareMobileAnalysisBeaconDestruction(item);
    removeResult = cleanupResult.success ? mobileItemCustody.expireInSpace({
      runtime: getSpaceRuntime(),
      item,
      systemID,
      terminalDestructionEffectID: DESTRUCTION_EFFECT_EXPLOSION,
    }) : cleanupResult;
  } catch (error) {
    removeResult = { success: false, errorMsg: error.message };
  }
  if (removeResult && removeResult.success) {
    log.info(`[MobileAnalysisBeacon] Removed beacon=${itemID} reason=${reason}`);
    return true;
  }
  // Generic inventory expiry is disabled for beacons so that earned loot is
  // preserved. Keep this owner alive until both loot delivery and removal win.
  log.warn(`[MobileAnalysisBeacon] Expiry pending beacon=${itemID}: ${removeResult?.errorMsg || "ANALYSIS_BEACON_REMOVAL_FAILED"}`);
  timersByBeaconID.set(itemID, { expiryTimer: setUnrefTimeout(
    () => expireMobileAnalysisBeacon(itemID, reason), ANALYSIS_BEACON_TICK_MS,
  ) });
  return false;
}

function scheduleMobileAnalysisBeaconTimers(itemOrID) {
  const itemID = toInt(itemOrID && itemOrID.itemID ? itemOrID.itemID : itemOrID, 0);
  const item = itemOrID && itemOrID.itemID ? itemOrID : findItemById(itemID);
  const state = getMobileAnalysisBeaconStateFromItem(item);
  if (!state) {
    clearTimers(itemID);
    return false;
  }
  if (resolveAbyssalDeployableItemRestriction(item, state)) {
    clearMobileAnalysisBeacon(item, "abyssal-authority-forbidden");
    return false;
  }

  clearTimers(itemID);

  if (state.deactivatedAtMs > 0) return false;

  const now = currentMobileAnalysisBeaconNowMs();
  const nextTimers = {
    activationTimer: null,
    expiryTimer: null,
    linkTimer: null,
    encounterTimer: null,
  };

  if (state.expiresAtMs > 0) {
    nextTimers.expiryTimer = setUnrefTimeout(
      () => expireMobileAnalysisBeacon(itemID, "expired"),
      state.expiresAtMs <= now ? ANALYSIS_BEACON_TICK_MS : state.expiresAtMs - now,
    );
  }

  if (!state.active) {
    nextTimers.activationTimer = setUnrefTimeout(
      () => activateMobileAnalysisBeacon(itemID),
      state.activateAtMs <= now ? ANALYSIS_BEACON_TICK_MS : state.activateAtMs - now,
    );
  }

  if (
    toInt(state.linkState, LINKSTATE_IDLE) === LINKSTATE_RUNNING &&
    state.linkCompleteAtMs > 0
  ) {
    nextTimers.linkTimer = setUnrefTimeout(
      () => completeMobileAnalysisBeaconLink(itemID),
      state.linkCompleteAtMs <= now ? ANALYSIS_BEACON_TICK_MS : state.linkCompleteAtMs - now,
    );
  }

  if (state.linkState === LINKSTATE_COMPLETED && !state.encounter?.rewardedAtMs) {
    nextTimers.encounterTimer = setUnrefTimeout(() => {
      try {
        processBeaconEncounter(itemID);
      } catch (error) {
        log.warn(`[MobileAnalysisBeacon] Encounter pending beacon=${itemID}: ${error.message}`);
      }
      // Re-read after each step: destruction, reward delivery and expiry can
      // remove the item or shorten its deadline.
      scheduleMobileAnalysisBeaconTimers(itemID);
    }, ANALYSIS_BEACON_TICK_MS);
  }

  timersByBeaconID.set(itemID, nextTimers);
  return true;
}

function registerMobileAnalysisBeaconItem(itemOrID) {
  const itemID = toInt(itemOrID && itemOrID.itemID ? itemOrID.itemID : itemOrID);
  const item = findItemById(itemID);
  let state = getMobileAnalysisBeaconStateFromItem(item);
  if (state?.linkPayment || pendingLinkPayments.has(itemID)) {
    const recovery = rollbackLinkPayment(itemID, pendingLinkPayments.get(itemID) || state.linkPayment);
    if (!recovery.success) return false;
    state = getMobileAnalysisBeaconStateFromItem(findItemById(itemID));
  }
  if (state && item.expiresAtMs !== null) {
    // The beacon owner must drop earned loot before removal. Generic inventory
    // expiry deletes container contents and therefore cannot own this timer.
    updateInventoryItem(itemID, (current) => ({ ...current, expiresAtMs: null }));
  }
  if (state && state.linkState === LINKSTATE_COMPLETED && !state.deactivatedAtMs) {
    // Unloaded/offline time is not uncontested scanning time. Legacy beacons
    // that already completed linking enter the encounter here as well.
    updateMobileAnalysisBeaconState(itemID, (current) => ({ ...current,
      encounter: { ...(current.encounter || createBeaconEncounter(item, currentMobileAnalysisBeaconNowMs())),
        updatedAtMs: currentMobileAnalysisBeaconNowMs() },
    }));
  }
  return scheduleMobileAnalysisBeaconTimers(itemID);
}

function isActiveMobileAnalysisBeaconState(state, nowMs = currentMobileAnalysisBeaconNowMs()) {
  if (!state || state.deactivatedAtMs > 0) {
    return false;
  }
  if (state.expiresAtMs > 0 && state.expiresAtMs <= nowMs) {
    return false;
  }
  return state.active === true || (state.activateAtMs > 0 && state.activateAtMs <= nowMs);
}

function hydrateMobileAnalysisBeaconEntityFromInventoryItem(entity, itemRecord) {
  if (!entity || !isMobileAnalysisBeaconType(itemRecord)) {
    return entity;
  }

  const state = getMobileAnalysisBeaconStateFromItem(itemRecord);
  if (!state) {
    return entity;
  }

  if (resolveAbyssalDeployableItemRestriction(itemRecord, state)) {
    entity.component_activate = [false, null];
    entity.activate_comp_durationSeconds = Math.trunc(
      MOBILE_ANALYSIS_BEACON_ACTIVATION_DELAY_MS / 1000,
    );
    entity.component_linkWithShip = [
      state.deployedAtMs,
      LINKSTATE_IDLE,
      null,
      null,
    ];
    entity.component_hostileBaiter = [null, null, null];
    return entity;
  }

  const active = isActiveMobileAnalysisBeaconState(state, currentMobileAnalysisBeaconNowMs());
  entity.component_activate = [active, active ? null : state.activateAtMs];
  entity.activate_comp_durationSeconds = Math.trunc(
    MOBILE_ANALYSIS_BEACON_ACTIVATION_DELAY_MS / 1000,
  );
  entity.component_linkWithShip = [
    state.deployedAtMs,
    Math.max(LINKSTATE_IDLE, Math.min(LINKSTATE_COMPLETED, toInt(state.linkState, LINKSTATE_IDLE))),
    state.linkCompleteAtMs > 0 ? state.linkCompleteAtMs : null,
    state.linkedShipID > 0 ? state.linkedShipID : null,
  ];
  const encounter = state.encounter;
  entity.component_hostileBaiter = encounter ? [
    (encounter.pausedAtMs || encounter.updatedAtMs) + encounter.remainingMs,
    encounter.pausedAtMs || null,
    encounter.rewardedAtMs || null,
  ] : [null, null, null];
  return entity;
}

function getLinkableShipTypeListIDForBeaconType(typeID) {
  return toInt(typeID, 0) === TYPE_CONCORD_CARRIER_ROGUE_ANALYSIS_BEACON
    ? TYPE_LIST_CARRIER_CRAB_LINKABLE_SHIPS
    : TYPE_LIST_STANDARD_CRAB_LINKABLE_SHIPS;
}

function getFallbackLinkableShipIDsForBeaconType(typeID) {
  return toInt(typeID, 0) === TYPE_CONCORD_CARRIER_ROGUE_ANALYSIS_BEACON
    ? {
        groupIDs: CARRIER_CRAB_LINKABLE_SHIP_GROUP_IDS,
        typeIDs: CARRIER_CRAB_LINKABLE_SHIP_TYPE_IDS,
      }
    : {
        groupIDs: STANDARD_CRAB_LINKABLE_SHIP_GROUP_IDS,
        typeIDs: STANDARD_CRAB_LINKABLE_SHIP_TYPE_IDS,
      };
}

function isShipTypeLinkableForBeaconType(beaconTypeID, shipType) {
  const typeListID = getLinkableShipTypeListIDForBeaconType(beaconTypeID);
  if (matchesTypeList(shipType, typeListID)) {
    return true;
  }

  const fallback = getFallbackLinkableShipIDsForBeaconType(beaconTypeID);
  return (
    fallback.groupIDs.has(toInt(shipType && shipType.groupID, 0)) ||
    fallback.typeIDs.has(toInt(shipType && shipType.typeID, 0))
  );
}

function resolveShipTypeContext(shipEntity, shipItem) {
  const typeID = toInt(
    shipEntity && shipEntity.typeID,
    toInt(shipItem && shipItem.typeID, 0),
  );
  const metadata = typeID > 0 ? (getItemMetadata(typeID) || {}) : {};
  return {
    typeID,
    groupID: toInt(
      shipEntity && shipEntity.groupID,
      toInt(shipItem && shipItem.groupID, toInt(metadata.groupID, 0)),
    ),
    categoryID: toInt(
      shipEntity && shipEntity.categoryID,
      toInt(shipItem && shipItem.categoryID, toInt(metadata.categoryID, 0)),
    ),
    groupName: String(
      (shipEntity && shipEntity.groupName) ||
      (shipItem && shipItem.groupName) ||
      metadata.groupName ||
      "",
    ).trim(),
  };
}

function validateLinkingShip(beaconItem, shipEntity, shipItem) {
  if (!shipEntity || shipEntity.kind !== "ship") {
    return "SHIP_NOT_FOUND";
  }
  if (!canEntitiesInteractLocally(shipEntity, beaconItem)) {
    return "MOBILE_ANALYSIS_BEACON_NOT_FOUND";
  }
  if (shipEntity.linkWithShipRestriction ||
      toReal(shipEntity.mobileAnalysisBeaconImmobileUntilMs) > currentMobileAnalysisBeaconNowMs()) {
    return "LINK_WITH_SHIP_ALREADY_LINKED";
  }

  const shipType = resolveShipTypeContext(shipEntity, shipItem);
  if (shipType.categoryID !== SHIP_CATEGORY) {
    return "MOBILE_ANALYSIS_BEACON_LINK_INVALID_SHIP";
  }

  if (!isShipTypeLinkableForBeaconType(beaconItem && beaconItem.typeID, shipType)) {
    return "MOBILE_ANALYSIS_BEACON_LINK_INVALID_SHIP";
  }
  return null;
}

function applyLinkRestrictionsToShip(session, shipEntity, beaconID, linkCompleteAtMs, options = {}) {
  if (!shipEntity) {
    return false;
  }

  const statusClearAtMs =
    linkCompleteAtMs + MOBILE_ANALYSIS_BEACON_LINK_STATUS_CLEAR_DELAY_MS;
  shipEntity.mobileAnalysisBeaconLinkedBeaconID = toInt(beaconID, 0);
  shipEntity.mobileAnalysisBeaconImmobileUntilMs = Math.max(
    toReal(shipEntity.mobileAnalysisBeaconImmobileUntilMs, 0),
    linkCompleteAtMs,
  );
  shipEntity.mobileAnalysisBeaconWarpDisabledUntilMs = Math.max(
    toReal(shipEntity.mobileAnalysisBeaconWarpDisabledUntilMs, 0),
    statusClearAtMs,
  );
  shipEntity.mobileAnalysisBeaconCloakBlockedUntilMs = Math.max(
    toReal(shipEntity.mobileAnalysisBeaconCloakBlockedUntilMs, 0),
    statusClearAtMs,
  );
  shipEntity.mobileAnalysisBeaconTetherBlockedUntilMs = Math.max(
    toReal(shipEntity.mobileAnalysisBeaconTetherBlockedUntilMs, 0),
    statusClearAtMs,
  );

  const scene = getSpaceRuntime().getSceneForSession(session);
  if (options.stopShip !== false && scene && typeof scene.stopShipEntity === "function") {
    scene.stopShipEntity(shipEntity, {
      reason: "mobile-analysis-beacon-link",
    });
  }
  return true;
}

function restoreShipLinkRestrictions(scene, shipEntity) {
  if (!scene || shipEntity?.kind !== "ship") return false;
  const now = currentMobileAnalysisBeaconNowMs();
  // The beacon owns the paid link and its original deadlines. A new ship
  // entity after reconnect/restart must retain both the running link and any
  // remaining post-link hold, without restarting either clock or its motion.
  let latestLink = null;
  for (const item of listSystemSpaceItems(scene.systemID)) {
    if (!isMobileAnalysisBeaconType(item) || !item.spaceState || toInt(item.flagID, -1) !== 0) continue;
    const state = getMobileAnalysisBeaconStateFromItem(item);
    if (!isActiveMobileAnalysisBeaconState(state, now) ||
        ![LINKSTATE_RUNNING, LINKSTATE_COMPLETED].includes(state.linkState) ||
        state.linkedShipID !== toInt(shipEntity.itemID) || state.linkCompleteAtMs <= 0 ||
        state.linkCompleteAtMs + MOBILE_ANALYSIS_BEACON_LINK_STATUS_CLEAR_DELAY_MS <= now) continue;
    if (!latestLink || state.linkCompleteAtMs > latestLink.linkCompleteAtMs) latestLink = state;
  }
  return latestLink ? applyLinkRestrictionsToShip(shipEntity.session, shipEntity,
    latestLink.beaconID, latestLink.linkCompleteAtMs, { stopShip: false }) : false;
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

function validateMobileAnalysisBeaconLaunch(item, context, session) {
  if (!context.characterID || !context.ownerID || !context.shipID || !context.systemID) {
    return "INVALID_SESSION";
  }
  if (!item) {
    return "ITEM_NOT_FOUND";
  }
  if (!isMobileAnalysisBeaconType(item)) {
    return "ITEM_NOT_MOBILE_ANALYSIS_BEACON";
  }
  if (
    ![context.characterID, context.corporationID, context.ownerID].includes(toInt(item.ownerID, 0)) ||
    toInt(item.locationID, 0) !== context.shipID ||
    toInt(item.flagID, 0) !== ITEM_FLAGS.CARGO_HOLD
  ) {
    return "ITEM_NOT_IN_SHIP_CARGO";
  }
  const deploymentRestriction = getDeploymentRestriction(session, context);
  if (deploymentRestriction) {
    return deploymentRestriction;
  }
  if (getSkillLevel(context.characterID, TYPE_ANCHORING) < 3) {
    return "Mobile Analysis Beacon deployment requires Anchoring 3.";
  }
  return null;
}

function launchMobileAnalysisBeaconFromShip(session, itemID, options = {}) {
  const context = getSessionContext(session, options);
  const item = findItemById(itemID);
  const validationError = validateMobileAnalysisBeaconLaunch(item, context, session);
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
      errorMsg: "MOBILE_ANALYSIS_BEACON_DEPLOYMENT_POSITION_UNAVAILABLE",
    };
  }

  const placementConflict = findPlacementConflict(session, item, context, spawnState);
  if (placementConflict) {
    log.info(
      `[MobileAnalysisBeacon] Launch rejected char=${context.characterID} item=${item.itemID} system=${context.systemID} reason=${placementConflict.errorMsg}`,
    );
    return {
      success: false,
      errorMsg: placementConflict.errorMsg,
    };
  }

  const now = currentMobileAnalysisBeaconNowMs();
  const deploymentState = {
    ownerID: context.ownerID,
    deployerCharacterID: context.characterID,
    solarSystemID: context.systemID,
    deployedAtMs: now,
    activateAtMs: now + MOBILE_ANALYSIS_BEACON_ACTIVATION_DELAY_MS,
    activatedAtMs: 0,
    expiresAtMs: now + MOBILE_ANALYSIS_BEACON_LIFETIME_MS,
    active: false,
    deactivatedAtMs: 0,
    linkState: LINKSTATE_IDLE,
    linkCompleteAtMs: 0,
    linkedShipID: 0,
  };
  const sourceTypeID = toInt(item.typeID, 0);
  const transferResult = mobileItemCustody.deployFromShip({
    item,
    position: spawnState.position,
    ownerID: context.ownerID,
    shipID: context.shipID,
    systemID: context.systemID,
    actor: context.characterID,
    // Custody allocates a split ID before this finalizer runs. Placement,
    // singleton state and the beacon component join the move's sole write.
    finalizeMovedItem(currentItem) {
      return {
        ...currentItem,
        singleton: 1,
        quantity: null,
        stacksize: 1,
        createdAtMs: currentItem.createdAtMs || now,
        expiresAtMs: null,
        spaceRadius: currentItem.spaceRadius || currentItem.radius || null,
        dunRotation: currentItem.dunRotation || [0, 0, 0],
        spaceState: spawnState,
        customInfo: buildCustomInfoWithState(currentItem.customInfo, {
          ...deploymentState, beaconID: currentItem.itemID,
        }),
      };
    },
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

  const deployedItem = launchedChange.item;
  const state = getMobileAnalysisBeaconStateFromItem(deployedItem);

  syncChangesExceptItem(session, transferChanges, launchedItemID);
  syncInventoryChange(
    session,
    deployedItem,
    launchedChange.previousData || {},
  );

  const spawnResult = getSpaceRuntime().spawnDynamicInventoryEntity(context.systemID, launchedItemID);
  if (!spawnResult || !spawnResult.success) {
    log.warn(
      `[MobileAnalysisBeacon] Launched beacon ${launchedItemID} but space spawn failed: ${spawnResult ? spawnResult.errorMsg : "UNKNOWN"}`,
    );
  }

  registerMobileAnalysisBeaconItem(deployedItem);
  log.info(
    `[MobileAnalysisBeacon] char=${context.characterID} launched beacon itemID=${launchedItemID} typeID=${sourceTypeID} system=${context.systemID}`,
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

function initiateMobileAnalysisBeaconLink(session, beaconID, options = {}) {
  const quick = options.quick === true;
  // Match the extracted client's GM menu gate; missing/malformed roles must
  // not inherit normalizeRoleValue's default GM chat classification.
  if (quick && (normalizeRoleValue(session?.role, 0n) & (ROLE_GML | ROLE_WORLDMOD)) === 0n) {
    return { success: false, errorMsg: "LINK_WITH_SHIP_QUICK_NOT_PERMITTED" };
  }
  const recovery = recoverPendingLinkPayments();
  if (!recovery.success) return recovery;
  const item = findItemById(beaconID);
  const state = getMobileAnalysisBeaconStateFromItem(item);
  const context = getSessionContext(session, options);
  const characterID = context.characterID;
  if (!context.characterID || !context.shipID || !context.systemID) {
    return {
      success: false,
      errorMsg: "INVALID_SESSION",
    };
  }
  if (!item || !state) {
    return {
      success: false,
      errorMsg: "MOBILE_ANALYSIS_BEACON_NOT_FOUND",
    };
  }
  if (item.locationID !== context.systemID || item.flagID !== 0 || !item.spaceState?.position) {
    return { success: false, errorMsg: "MOBILE_ANALYSIS_BEACON_NOT_FOUND" };
  }
  if (resolveAbyssalDeployableItemRestriction(item, state)) {
    clearMobileAnalysisBeacon(item, "abyssal-authority-forbidden");
    return {
      success: false,
      errorMsg: "MOBILE_ANALYSIS_BEACON_NOT_FOUND",
    };
  }

  const now = currentMobileAnalysisBeaconNowMs();
  if (!isActiveMobileAnalysisBeaconState(state, now)) {
    return {
      success: false,
      errorMsg: "MOBILE_ANALYSIS_BEACON_NOT_ACTIVE",
    };
  }
  if (toInt(state.solarSystemID, 0) !== toInt(context.systemID, 0)) {
    return {
      success: false,
      errorMsg: "MOBILE_ANALYSIS_BEACON_NOT_IN_SYSTEM",
    };
  }
  if (
    toInt(state.linkState, LINKSTATE_IDLE) !== LINKSTATE_IDLE ||
    toInt(state.linkedShipID, 0) > 0
  ) {
    return {
      success: false,
      errorMsg: "MOBILE_ANALYSIS_BEACON_ALREADY_LINKED",
    };
  }

  const shipEntity = getSpaceRuntime().getEntity(session, context.shipID);
  const shipItem = findShipItemById(context.shipID) || findItemById(context.shipID);
  const shipValidationError = validateLinkingShip(item, shipEntity, shipItem);
  if (shipValidationError) {
    return {
      success: false,
      errorMsg: shipValidationError,
    };
  }

  const linkAttributes = getLinkAttributes(item.typeID);
  if (![linkAttributes.characterEnergyCost, linkAttributes.solarsystemInterferenceCost]
    .every((cost) => Number.isFinite(cost) && cost > 0)) {
    return { success: false, errorMsg: "INVALID_ANALYSIS_BEACON_LINK_COST" };
  }
  const beaconEntity = getSpaceRuntime().getEntity(session, beaconID);
  if (!hasFiniteVectorCoordinates(shipEntity.position) || !hasFiniteVectorCoordinates(beaconEntity?.position)) {
    return { success: false, errorMsg: "MOBILE_ANALYSIS_BEACON_NOT_FOUND" };
  }
  const range = Math.max(0, getVectorDistance(shipEntity.position, beaconEntity.position) -
    toReal(shipEntity.radius) - toReal(beaconEntity.radius));
  if (range > linkAttributes.maxLinkRange) {
    return { success: false, errorMsg: "MOBILE_ANALYSIS_BEACON_LINK_TOO_FAR" };
  }

  const currentEnergyState = characterEnergyMgrService.getCharacterEnergyStateNow(session);
  if (
    currentEnergyState.energyLevel - linkAttributes.characterEnergyCost <
    currentEnergyState.minEnergyLevel
  ) {
    return {
      success: false,
      errorMsg: "INSUFFICIENT_CHARACTER_ENERGY",
    };
  }

  const filetime = currentEnergyState.lastRechargeTickTimestamp;
  const currentInterference = interferenceState.getSolarSystemInterferenceStateNow(context.systemID, filetime);
  if (currentInterference.interferenceLevel + linkAttributes.solarsystemInterferenceCost >
      currentInterference.maxInterferenceLevel) {
    return { success: false, errorMsg: "SOLAR_SYSTEM_INTERFERENCE_TOO_HIGH" };
  }

  const linkCompleteAtMs = now + (quick ? MOBILE_ANALYSIS_BEACON_QUICK_LINK_DURATION_MS : linkAttributes.linkDurationMs);
  const payment = payForBeaconLink(session, item, state, context, linkAttributes, filetime, linkCompleteAtMs);
  if (!payment.success) return payment;
  const updatedResult = payment.updated;
  scheduleMobileAnalysisBeaconTimers(beaconID);
  applyLinkRestrictionsToShip(session, shipEntity, beaconID, linkCompleteAtMs);
  // Publish only committed state. Transport failures cannot undo a paid link.
  for (const publish of [
    () => characterEnergyMgrService.publishCharacterEnergyState(session, payment.energy),
    () => InterferenceMgr.notifySolarSystemInterferenceChanged(context.systemID, payment.interference, filetime),
  ]) {
    try { publish(); }
    catch (error) { log.warn(`[MobileAnalysisBeacon] Payment notification failed beacon=${beaconID}: ${error.message}`); }
  }

  syncInventoryChange(
    session,
    updatedResult.data,
    updatedResult.previousData || {},
  );
  getSpaceRuntime().refreshInventoryBackedEntityPresentation(state.solarSystemID, beaconID);
  synchronizeBeaconLinkEffect(beaconID);
  log.info(
    `[MobileAnalysisBeacon] Link started char=${characterID} ship=${context.shipID} beacon=${beaconID} method=${options.quick ? "InitiateLinkQuick" : "InitiateLink"}`,
  );
  return {
    success: true,
    data: {
      beaconID: toInt(beaconID, 0),
      linkedShipID: context.shipID,
      linkCompleteAtMs,
      characterEnergyCost: linkAttributes.characterEnergyCost,
      solarsystemInterferenceCost: linkAttributes.solarsystemInterferenceCost,
    },
  };
}

module.exports = {
  CATEGORY_DEPLOYABLE,
  GROUP_MOBILE_ANALYSIS_BEACON,
  TYPE_CONCORD_ROGUE_ANALYSIS_BEACON,
  TYPE_CONCORD_CARRIER_ROGUE_ANALYSIS_BEACON,
  TYPE_LIST_STANDARD_CRAB_LINKABLE_SHIPS,
  TYPE_LIST_CARRIER_CRAB_LINKABLE_SHIPS,
  LINKSTATE_IDLE,
  LINKSTATE_RUNNING,
  LINKSTATE_COMPLETED,
  MOBILE_ANALYSIS_BEACON_ACTIVATION_DELAY_MS,
  MOBILE_ANALYSIS_BEACON_LINK_DURATION_MS,
  MOBILE_ANALYSIS_BEACON_LINK_STATUS_CLEAR_DELAY_MS,
  MOBILE_ANALYSIS_BEACON_CHARACTER_ENERGY_COST,
  MOBILE_ANALYSIS_BEACON_LIFETIME_MS,
  MOBILE_ANALYSIS_BEACON_MIN_DISTANCE_FROM_UPWELL_METERS,
  MOBILE_ANALYSIS_BEACON_MIN_DISTANCE_FROM_CONTROL_TOWER_METERS,
  isMobileAnalysisBeaconType,
  getMobileAnalysisBeaconStateFromItem,
  launchMobileAnalysisBeaconFromShip,
  registerMobileAnalysisBeaconItem,
  clearMobileAnalysisBeacon,
  hydrateMobileAnalysisBeaconEntityFromInventoryItem,
  restoreShipLinkRestrictions,
  initiateMobileAnalysisBeaconLink,
  recoverPendingLinkPayments,
  getBeaconCargoAccessError,
  prepareMobileAnalysisBeaconDestruction,
  ownsBeaconNpcRecord,
  _testing: {
    findPlacementConflict,
    getDeploymentRestriction,
    getStateFromCustomInfo,
    buildCustomInfoWithState,
    getLinkableShipTypeListIDForBeaconType,
    isShipTypeLinkableForBeaconType,
    validateLinkingShip,
    getLinkAttributes,
    recoverPendingLinkPayments,
    processBeaconEncounter,
    expireMobileAnalysisBeacon,
    clearTimers,
    setNowMsOverride(callback) {
      nowMsOverride = typeof callback === "function" ? callback : null;
    },
    resetNowMsOverride() {
      nowMsOverride = null;
    },
  },
};
