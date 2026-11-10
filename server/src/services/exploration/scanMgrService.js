"use strict";

const {
  toFiniteNumber,
} = require("../../common/numbers");

const path = require("path");

const BaseService = require(path.join(__dirname, "../baseService"));
const config = require(path.join(__dirname, "../../config"));
const { PROXY_NODE_ID } = require(path.join(__dirname, "../../network/protocolProfile"));
const log = require(path.join(__dirname, "../../utils/logger"));
const { throwWrappedUserError } = require(path.join(
  __dirname,
  "../../common/machoErrors",
));
const DogmaService = require(path.join(__dirname, "../dogma/dogmaService"));
const explorationAuthority = require(path.join(
  __dirname,
  "./explorationAuthority",
));
const {
  buildBoundObjectResponse,
  buildKeyVal,
  buildDict,
  buildPythonSet,
  currentFileTime,
  extractList,
  marshalObjectToObject,
  normalizeNumber,
  resolveBoundNodeId,
  unwrapMarshalValue,
} = require(path.join(__dirname, "../_shared/serviceHelpers"));
const {
  getAttributeIDByNames,
  getTypeAttributeValue,
  getTypeDogmaAttributes,
  getTypeEffectRecords,
  getFittedModuleItems,
  getLoadedChargeByFlag,
  getFittedModuleByFlag,
  getModuleChargeCapacity,
  isModuleOnline,
  isChargeCompatibleWithModule,
} = require(path.join(__dirname, "../fitting/liveFittingState"));
const {
  getShipFittingSnapshot,
} = require(path.join(__dirname, "../../_secondary/fitting/fittingRuntime"));
const {
  getCharacterSkillMap,
} = require(path.join(__dirname, "../skills/skillState"));
const {
  getImplantDogmaModifierEntries,
} = require(path.join(__dirname, "../dogma/implants/activeImplantModifiers"));
const {
  ITEM_FLAGS,
  findItemById,
  grantItemToCharacterLocation,
} = require(path.join(__dirname, "../inventory/itemStore"));
const {
  resolveItemByTypeID,
} = require(path.join(__dirname, "../inventory/itemTypeRegistry"));
const wormholeRuntime = require(path.join(__dirname, "./wormholes/wormholeRuntime"));
const signatureRuntime = require(path.join(__dirname, "./signatures/signatureRuntime"));
const probeScanRuntime = require(path.join(__dirname, "./probes/probeScanRuntime"));
const probeScanWarpAuthority = require(path.join(
  __dirname,
  "./probes/probeScanWarpAuthority",
));
const probeRuntimeState = require(path.join(__dirname, "./probes/probeRuntimeState"));
const probeSceneRuntime = require(path.join(__dirname, "./probes/probeSceneRuntime"));
const commandBurstRuntime = require(path.join(
  __dirname,
  "../../space/modules/commandBurstRuntime",
));
const structureState = require(path.join(__dirname, "../structure/structureState"));
const mobileScanInhibitorRuntime = require(path.join(
  __dirname,
  "../ship/mobileScanInhibitorRuntime",
));
const {
  canEntityDiscoverTarget,
  resolveEntityInteractionScope,
} = require(path.join(
  __dirname,
  "../../space/destiny/identity/interactionScope.js",
));
const {
  entityIDsEqual,
} = require(path.join(
  __dirname,
  "../../space/destiny/identity/entityID.js",
));
const {
  resolveAbyssalPlayerLaunchScope,
  sessionClaimsAbyssalScene,
} = require(path.join(
  __dirname,
  "../_shared/abyssalPlayerLaunchScope",
));
const {
  ABYSS_BOUNDARY_RADIUS_METERS,
} = require("../../abyssal").engineSupport.runtimeConstants;

const SCAN_CONTRACTS = explorationAuthority.getScanContracts();
const SIGNATURE_TYPE_WORMHOLE =
  explorationAuthority.getSignatureTypeDefinition("wormhole") || {};
const ANOMALY_SCAN_GROUP =
  SCAN_CONTRACTS.probeScanGroups && SCAN_CONTRACTS.probeScanGroups.anomalies;
const AU_METERS = Number(SCAN_CONTRACTS.auMeters) || 149_597_870_700;
const DSCAN_MIN_RANGE_METERS = 10_000;
const DSCAN_FALLBACK_MAX_RANGE_METERS = 14.3 * AU_METERS;
const DSCAN_FULL_SWEEP_RADIANS = Math.PI * 2;
const DSCAN_COSMIC_SIGNATURE_GROUP_ID =
  Number(SIGNATURE_TYPE_WORMHOLE.inventoryGroupID) || 502;
const DSCAN_COSMIC_ANOMALY_GROUP_ID =
  Number(
    ANOMALY_SCAN_GROUP &&
      Array.isArray(ANOMALY_SCAN_GROUP.inventoryGroupIDs) &&
      ANOMALY_SCAN_GROUP.inventoryGroupIDs[0],
  ) || 885;
const GROUP_SCAN_PROBE_LAUNCHER = 481;
const GROUP_SCANNER_PROBE = 479;
const ATTRIBUTE_DSCAN_IMMUNE =
  getAttributeIDByNames("dscanImmune") || 1958;
const ATTRIBUTE_MAX_DIRECTIONAL_SCAN_RANGE =
  getAttributeIDByNames("maxDirectionalScanRange") || 5796;
const ATTRIBUTE_SCAN_DURATION =
  getAttributeIDByNames("scanDuration") || 73;
const ATTRIBUTE_SCAN_DURATION_ALTERNATE = 66;
const ATTRIBUTE_BASE_SCAN_RANGE =
  getAttributeIDByNames("baseScanRange") || 1370;
const ATTRIBUTE_RANGE_FACTOR =
  getAttributeIDByNames("rangeFactor") || 1373;
const ATTRIBUTE_PROBE_SCAN_STRENGTH_BONUS = 846;
const ATTRIBUTE_MAX_SCAN_DEVIATION_MODIFIER = 1156;
const ATTRIBUTE_BASE_SENSOR_STRENGTH = 1371;
const ATTRIBUTE_BASE_MAX_SCAN_DEVIATION = 1372;
const ATTRIBUTE_SCAN_STRENGTH_BONUS_MODULE = 1907;
const ATTRIBUTE_SCAN_DEVIATION_BONUS_MODULE = 1905;
const ATTRIBUTE_SCAN_DURATION_BONUS_MODULE = 1906;
const ATTRIBUTE_EXPEDITION_PROBE_STRENGTH_FACTOR = 6118;
const ATTRIBUTE_EXPEDITION_PROBE_DEVIATION_FACTOR = 6119;
const DOGMA_OP_POST_PERCENT = 6;
const SCAN_PROBE_NUMBER_OF_RANGE_STEPS =
  Math.max(1, Number(SCAN_CONTRACTS.rangeStepCount) || 8);
const DEFAULT_PROBE_MOVE_DURATION_MS = 1_250;
const SCANNING_SKILL_TYPE_IDS = Object.freeze([
  25739, // Astrometric Rangefinding
  25811, // Astrometric Acquisition
  25810, // Astrometric Pinpointing
  3412,  // Astrometrics
]);
const signalTrackerRegistrationsByCharacterID = new Map();
const anomalySnapshotBySystemID = new Map();
const signatureSnapshotBySystemID = new Map();
const staticSiteSnapshotBySystemID = new Map();
const structureSnapshotBySystemID = new Map();
const signalTrackerRefreshBySystemID = new Map();
let wormholeSignatureListenerRegistered = false;
let structureOverlayListenerRegistered = false;
let dogmaNotificationHelper = null;
let characterStateHelper = null;
let abyssalMgrServiceHelper = null;

function getDogmaNotificationHelper() {
  if (!dogmaNotificationHelper) {
    dogmaNotificationHelper = new DogmaService();
  }
  return dogmaNotificationHelper;
}

function getCharacterStateHelper() {
  if (!characterStateHelper) {
    characterStateHelper = require(path.join(__dirname, "../character/characterState"));
  }
  return characterStateHelper;
}

function getAbyssalMgrServiceHelper() {
  if (!abyssalMgrServiceHelper) {
    abyssalMgrServiceHelper = require("../../abyssal").scanIntegration;
  }
  return abyssalMgrServiceHelper;
}

function getSpaceRuntime() {
  return require(path.join(__dirname, "../../space/runtime"));
}

function cloneVector(vector = null) {
  return {
    x: toFiniteNumber(vector && vector.x, 0),
    y: toFiniteNumber(vector && vector.y, 0),
    z: toFiniteNumber(vector && vector.z, 0),
  };
}

function subtractVectors(left, right) {
  return {
    x: toFiniteNumber(left && left.x, 0) - toFiniteNumber(right && right.x, 0),
    y: toFiniteNumber(left && left.y, 0) - toFiniteNumber(right && right.y, 0),
    z: toFiniteNumber(left && left.z, 0) - toFiniteNumber(right && right.z, 0),
  };
}

function magnitude(vector) {
  return Math.sqrt(
    (toFiniteNumber(vector && vector.x, 0) ** 2) +
    (toFiniteNumber(vector && vector.y, 0) ** 2) +
    (toFiniteNumber(vector && vector.z, 0) ** 2)
  );
}

function normalizeVector(vector) {
  const length = magnitude(vector);
  if (!Number.isFinite(length) || length <= 0) {
    return null;
  }
  return {
    x: vector.x / length,
    y: vector.y / length,
    z: vector.z / length,
  };
}

function dotProduct(left, right) {
  return (
    (toFiniteNumber(left && left.x, 0) * toFiniteNumber(right && right.x, 0)) +
    (toFiniteNumber(left && left.y, 0) * toFiniteNumber(right && right.y, 0)) +
    (toFiniteNumber(left && left.z, 0) * toFiniteNumber(right && right.z, 0))
  );
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function throwCustomNotify(message) {
  throwWrappedUserError("CustomNotify", {
    notify: String(message || "").trim(),
  });
}

function buildEmptySignalTrackerFullState() {
  return [buildDict([]), buildDict([]), buildDict([]), buildDict([])];
}

function extractProbeIDsFromValue(value) {
  const unwrapped = unwrapMarshalValue(value);
  if (Array.isArray(unwrapped)) {
    return unwrapped.flatMap((entry) => extractProbeIDsFromValue(entry));
  }

  if (unwrapped && typeof unwrapped === "object") {
    return Object.values(unwrapped)
      .flatMap((entry) => extractProbeIDsFromValue(entry));
  }

  const numericProbeID = normalizeNumber(unwrapped, 0);
  return numericProbeID > 0 ? [numericProbeID] : [];
}

function extractProbeIDList(args) {
  const rawArgs = Array.isArray(args) ? args : [args];
  const candidateValues = rawArgs.flatMap((entry) => {
    const extracted = extractList(entry);
    return extracted.length > 0 ? extracted : [entry];
  });
  return [...new Set(
    candidateValues
      .flatMap((entry) => extractProbeIDsFromValue(entry))
      .map((probeID) => normalizeNumber(probeID, 0))
      .filter((probeID) => probeID > 0),
  )];
}

function collectSceneEntities(scene) {
  if (!scene) {
    return [];
  }

  const dynamicEntities =
    scene.dynamicEntities instanceof Map
      ? [...scene.dynamicEntities.values()]
      : Array.isArray(scene.dynamicEntities)
        ? scene.dynamicEntities
        : [];
  const staticEntities = Array.isArray(scene.staticEntities)
    ? scene.staticEntities
    : [];
  return [...staticEntities, ...dynamicEntities];
}

function getAbyssalRuntimeInstanceIDFromEntity(entity) {
  if (!entity || typeof entity !== "object") {
    return 0;
  }
  let instanceID = 0;
  let invalidAuthority = false;
  let hasAbyssalAuthority = false;
  const mergeAuthority = (rawValue) => {
    const candidate = Number(rawValue);
    hasAbyssalAuthority = true;
    if (
      !Number.isSafeInteger(candidate) ||
      candidate <= 0 ||
      (instanceID > 0 && instanceID !== candidate)
    ) {
      invalidAuthority = true;
      return;
    }
    instanceID = candidate;
  };

  const interactionScope = resolveEntityInteractionScope(entity);
  if (interactionScope && interactionScope.hasAbyssalScope === true) {
    if (
      interactionScope.valid !== true ||
      interactionScope.abyssalInstanceID === null ||
      interactionScope.abyssalInstanceID === undefined
    ) {
      hasAbyssalAuthority = true;
      invalidAuthority = true;
    } else {
      mergeAuthority(interactionScope.abyssalInstanceID);
    }
  }

  const nestedMarkerFields = [
    "evejsAbyssalRewardCache",
    "evejsAbyssalExtractionNode",
    "evejsAbyssalJettisonContainer",
  ];
  for (const markerField of nestedMarkerFields) {
    if (!Object.hasOwn(entity, markerField)) {
      continue;
    }
    const markerState = entity[markerField];
    if (!markerState || typeof markerState !== "object") {
      continue;
    }
    for (const aliasField of ["instanceID", "abyssalRunID"]) {
      if (Object.hasOwn(markerState, aliasField)) {
        mergeAuthority(markerState[aliasField]);
      }
    }
  }
  const abyssalMgrService = getAbyssalMgrServiceHelper();
  const entityItemID = normalizeNumber(entity.itemID, 0);
  const activeShipRun =
    abyssalMgrService &&
    entityItemID > 0 &&
    typeof abyssalMgrService.getActiveAbyssalRunForShipID === "function"
      ? abyssalMgrService.getActiveAbyssalRunForShipID(entityItemID)
      : null;
  const activeShipRunInstanceID = normalizeNumber(activeShipRun && activeShipRun.instanceID, 0);
  if (activeShipRunInstanceID > 0) {
    mergeAuthority(activeShipRunInstanceID);
  }
  if (invalidAuthority) {
    return -1;
  }
  if (hasAbyssalAuthority && instanceID > 0) {
    return instanceID;
  }
  if (
    (Boolean(entity.evejsAbyssalPocketMarker) ||
      Boolean(entity.evejsAbyssalRewardCache) ||
      Boolean(entity.evejsAbyssalExtractionNode) ||
      Boolean(entity.evejsAbyssalJettisonContainer) ||
      entity.evejsAbyssalVisualProbe === true ||
      entity.abyssalVisualOnly === true)
  ) {
    return -1;
  }
  return 0;
}

function getAbyssalRuntimeInstanceIDFromSession(session) {
  if (!session || typeof session !== "object") {
    return 0;
  }
  const containers = [session];
  if (session._space && typeof session._space === "object") {
    containers.push(session._space);
  }
  const abyssalAliasFields = [
    "abyssalInstanceID",
    "abyssalRunID",
    "evejsAbyssalInstanceID",
    "evejsAbyssalPocketInstanceID",
  ];
  let instanceID = 0;
  let hasAbyssalAlias = false;
  const mergeAlias = (rawValue) => {
    const candidate = Number(rawValue);
    if (!Number.isSafeInteger(candidate) || candidate <= 0) {
      return false;
    }
    if (instanceID > 0 && instanceID !== candidate) {
      return false;
    }
    instanceID = candidate;
    return true;
  };

  for (const container of containers) {
    for (const field of abyssalAliasFields) {
      if (!Object.hasOwn(container, field)) {
        continue;
      }
      hasAbyssalAlias = true;
      if (!mergeAlias(container[field])) {
        return 0;
      }
    }
  }
  if (!hasAbyssalAlias || instanceID <= 0) {
    return 0;
  }

  // dungeonInstanceID is shared with ordinary dungeons. It may corroborate an
  // explicit Abyssal identity, but it can never establish one by itself.
  for (const container of containers) {
    if (
      Object.hasOwn(container, "dungeonInstanceID") &&
      !mergeAlias(container.dungeonInstanceID)
    ) {
      return 0;
    }
  }
  return instanceID;
}

function canSessionDirectionalScanEntity(session, entity) {
  if (entity && entity.evejsAbyssalTrace === true) {
    return true;
  }
  const entityInstanceID = getAbyssalRuntimeInstanceIDFromEntity(entity);
  if (entityInstanceID === 0) {
    return true;
  }
  const sessionInstanceID = getAbyssalRuntimeInstanceIDFromSession(session);
  return sessionInstanceID > 0 && sessionInstanceID === entityInstanceID;
}

function resolveEntityRangeCapMeters(entity) {
  const derivedRange = Math.max(
    0,
    toFiniteNumber(
      entity &&
        entity.passiveDerivedState &&
        entity.passiveDerivedState.attributes &&
        entity.passiveDerivedState.attributes[ATTRIBUTE_MAX_DIRECTIONAL_SCAN_RANGE],
      0,
    ),
  );
  if (derivedRange > 0) {
    return derivedRange;
  }

  const explicitRange = Math.max(
    0,
    toFiniteNumber(entity && entity.maxDirectionalScanRange, 0),
  );
  if (explicitRange > 0) {
    return explicitRange;
  }

  const typedRange = Math.max(
    0,
    toFiniteNumber(
      getTypeAttributeValue(
        entity && entity.typeID,
        "maxDirectionalScanRange",
      ),
      toFiniteNumber(
        getTypeAttributeValueByID(
          entity && entity.typeID,
          ATTRIBUTE_MAX_DIRECTIONAL_SCAN_RANGE,
        ),
        0,
      ),
    ),
  );
  return typedRange > 0 ? typedRange : DSCAN_FALLBACK_MAX_RANGE_METERS;
}

function getTypeAttributeValueByID(typeID, attributeID) {
  const numericAttributeID = normalizeNumber(attributeID, 0);
  if (numericAttributeID <= 0) {
    return null;
  }

  const attributes = getTypeDogmaAttributes(typeID);
  const numericValue = Number(attributes[String(numericAttributeID)]);
  return Number.isFinite(numericValue) ? numericValue : null;
}

function isEntityDirectionalScanImmune(entity) {
  const attributeValue = toFiniteNumber(
    getTypeAttributeValue(entity && entity.typeID, "dscanImmune"),
    toFiniteNumber(
      getTypeAttributeValueByID(entity && entity.typeID, ATTRIBUTE_DSCAN_IMMUNE),
      0,
    ),
  );
  return attributeValue > 0;
}

function isEntityDirectionalScanCandidate(entity, egoEntity) {
  const itemID = normalizeNumber(entity && entity.itemID, 0);
  if (itemID <= 0 || itemID === normalizeNumber(egoEntity && egoEntity.itemID, 0)) {
    return false;
  }

  const typeID = normalizeNumber(entity && entity.typeID, 0);
  const groupID = normalizeNumber(entity && entity.groupID, 0);
  if (typeID <= 0 || groupID <= 0) {
    return false;
  }

  if (
    groupID === DSCAN_COSMIC_SIGNATURE_GROUP_ID ||
    groupID === DSCAN_COSMIC_ANOMALY_GROUP_ID
  ) {
    return false;
  }

  if (String(entity && entity.kind || "").trim().toLowerCase() === "missile") {
    return false;
  }

  if (
    String(entity && entity.mode || "").trim().toUpperCase() === "WARP"
  ) {
    return false;
  }

  if (isEntityDirectionalScanImmune(entity)) {
    return false;
  }

  if (
    entity &&
    entity.abyssalVisualOnly === true &&
    String(entity.evejsAbyssalVisualRole || "").trim().toLowerCase() === "environment_visual"
  ) {
    return false;
  }

  return true;
}

function buildDirectionalScanResult(entity) {
  return buildKeyVal([
    ["id", normalizeNumber(entity && entity.itemID, 0)],
    ["typeID", normalizeNumber(entity && entity.typeID, 0)],
    ["groupID", normalizeNumber(entity && entity.groupID, 0)],
  ]);
}

function isMobileScanInhibitorEntity(entity) {
  return mobileScanInhibitorRuntime.isMobileScanInhibitorType(entity);
}

function isPositionInsideActiveScanInhibitor(systemID, position, scene, options = {}) {
  if (!position) {
    return false;
  }
  return mobileScanInhibitorRuntime.isPositionScanInhibited(systemID, position, {
    scene,
    nowMs: options.nowMs,
    targetEntity: options.targetEntity,
    candidates: options.candidates,
  });
}

function isDirectionalScanBlindedByScanInhibitor(
  systemID,
  egoEntity,
  scene,
  candidates,
) {
  return isPositionInsideActiveScanInhibitor(
    systemID,
    egoEntity && egoEntity.position,
    scene,
    { targetEntity: egoEntity, candidates },
  );
}

function isDirectionalScanTargetHiddenByScanInhibitor(
  systemID,
  entity,
  scene,
  candidates,
) {
  if (isMobileScanInhibitorEntity(entity)) {
    return false;
  }
  return isPositionInsideActiveScanInhibitor(
    systemID,
    entity && entity.position,
    scene,
    { targetEntity: entity, candidates },
  );
}

function buildScanInhibitorBlindedProbeScanResult(probeMap, durationMs) {
  const normalizedProbeMap = probeMap instanceof Map ? probeMap : new Map();
  return {
    durationMs: Math.max(1, normalizeNumber(durationMs, probeScanRuntime.DEFAULT_PROBE_SCAN_DURATION_MS)),
    probes: normalizedProbeMap,
    probeIDs: [...normalizedProbeMap.keys()],
    results: [],
    absentTargets: [],
  };
}

function buildSignatureEntryMap(systemID, options = {}) {
  return new Map(
    signatureRuntime.buildSignalTrackerSignatureEntries(systemID, options)
      .map(([siteID, siteInfo]) => [normalizeNumber(siteID, 0), siteInfo])
      .filter(([siteID]) => siteID > 0),
  );
}

function buildAnomalyEntryMap(systemID, options = {}) {
  return new Map(
    signatureRuntime.buildSignalTrackerAnomalyEntries(systemID, options)
      .map(([siteID, siteInfo]) => [normalizeNumber(siteID, 0), siteInfo])
      .filter(([siteID]) => siteID > 0),
  );
}

function buildStructureEntryMap(systemID, options = {}) {
  return new Map(
    signatureRuntime.buildSignalTrackerStructureEntries(systemID, options)
      .map(([siteID, siteInfo]) => [normalizeNumber(siteID, 0), siteInfo])
      .filter(([siteID]) => siteID > 0),
  );
}

function buildStaticSiteEntryMap(systemID, options = {}) {
  return new Map(
    signatureRuntime.buildSignalTrackerStaticSiteEntries(systemID, options)
      .map(([siteID, siteInfo]) => [normalizeNumber(siteID, 0), siteInfo])
      .filter(([siteID]) => siteID > 0),
  );
}

function ensureStaticSiteSnapshot(systemID, options = {}) {
  const numericSystemID = normalizeNumber(systemID, 0);
  if (numericSystemID <= 0) {
    return new Map();
  }
  const snapshot = buildStaticSiteEntryMap(numericSystemID, options);
  invalidateSignalTrackerRefresh(numericSystemID, options);
  staticSiteSnapshotBySystemID.set(numericSystemID, snapshot);
  return snapshot;
}

function hasSignalTrackerSnapshots(systemID) {
  return anomalySnapshotBySystemID.has(systemID) &&
    signatureSnapshotBySystemID.has(systemID) &&
    staticSiteSnapshotBySystemID.has(systemID) &&
    structureSnapshotBySystemID.has(systemID);
}

function scheduleSignalTrackerRefresh(systemID, options = {}) {
  let refresh = signalTrackerRefreshBySystemID.get(systemID);
  if (refresh) {
    refresh.revision += 1;
    refresh.pendingOptions = mergeSignalTrackerRefreshOptions(refresh.pendingOptions, options);
    return refresh;
  }
  refresh = {
    revision: 0,
    pendingOptions: { ...options },
    promise: null,
    // Characters waiting for their first full state. An explicit overlay
    // refresh sets broadcast instead, and reaches every listener.
    recipientCharacterIDs: new Set(),
    broadcast: false,
  };
  signalTrackerRefreshBySystemID.set(systemID, refresh);
  refresh.promise = runSignalTrackerRefresh(systemID, refresh);
  return refresh;
}

function ensureSignalTrackerRefresh(systemID, characterID) {
  // A new listener needs one full state. Pilots already listening keep getting
  // deltas: the retail signal tracker sends full state only to new clients.
  // New listeners can use the generation already being built, so repeated
  // registrations must not keep invalidating a cold refresh.
  const refresh = signalTrackerRefreshBySystemID.get(systemID) ||
    scheduleSignalTrackerRefresh(systemID, { shouldRemoveOldSites: true });
  if (characterID > 0) {
    refresh.recipientCharacterIDs.add(characterID);
  }
}

function buildCachedSignalTrackerFullState(systemID) {
  return [
    anomalySnapshotBySystemID,
    signatureSnapshotBySystemID,
    staticSiteSnapshotBySystemID,
    structureSnapshotBySystemID,
  ].map((snapshots) => buildDict([...(snapshots.get(systemID) || new Map()).entries()]));
}

function buildLiveSignalTrackerFullState(systemID, options = {}) {
  // GetFullState is a direct read, so it answers from the live sites as the
  // retail tracker does. It uses the refresh builders, so the reply matches
  // what the next published generation holds.
  return [
    buildAnomalyEntryMap,
    buildSignatureEntryMap,
    buildStaticSiteEntryMap,
    buildStructureEntryMap,
  ].map((buildEntries) => buildDict([...buildEntries(systemID, options).entries()]));
}

function mergeSignalTrackerRefreshOptions(previous, next) {
  if (!previous) {
    return { ...next };
  }
  return {
    ...previous,
    ...next,
    refresh: previous.refresh !== false || next.refresh !== false,
    shouldRemoveOldSites: previous.shouldRemoveOldSites === true ||
      next.shouldRemoveOldSites === true,
  };
}

function invalidateSignalTrackerRefresh(systemID, options = {}) {
  const refresh = signalTrackerRefreshBySystemID.get(systemID);
  if (refresh) {
    refresh.revision += 1;
    refresh.pendingOptions = mergeSignalTrackerRefreshOptions(refresh.pendingOptions, options);
  }
}

async function runSignalTrackerRefresh(systemID, refresh) {
  const isCurrent = () => signalTrackerRefreshBySystemID.get(systemID) === refresh;
  try {
    while (refresh.pendingOptions) {
      // Defer even the first phase so registration and chat handlers can return.
      // Requests arriving before it starts share this cycle.
      await new Promise((resolve) => setImmediate(resolve));
      if (!isCurrent()) {
        return;
      }
      const options = refresh.pendingOptions;
      refresh.pendingOptions = null;
      const revision = refresh.revision;
      const snapshots = [];
      let failed = false;
      for (const buildEntries of [
        buildAnomalyEntryMap,
        buildSignatureEntryMap,
        buildStaticSiteEntryMap,
        buildStructureEntryMap,
      ]) {
        try {
          snapshots.push(buildEntries(systemID, options));
        } catch (error) {
          log.error(`[ScanMgr] Signal tracker build failed for ${systemID}: ${error.stack || error}`);
          failed = true;
          break;
        }
        await new Promise((resolve) => setImmediate(resolve));
        if (!isCurrent()) {
          return;
        }
        if (revision !== refresh.revision) {
          break;
        }
      }
      if (failed) {
        // Keep any newer request queued during this cycle, but do not spin
        // retrying the same failing build without a new request.
        if (refresh.pendingOptions) {
          refresh.pendingOptions = mergeSignalTrackerRefreshOptions(options, refresh.pendingOptions);
        }
        continue;
      }
      if (revision !== refresh.revision) {
        // Carry removal semantics into the replacement, including when the
        // invalidating delta arrived after its provider phase had already run.
        refresh.pendingOptions = mergeSignalTrackerRefreshOptions(
          options,
          refresh.pendingOptions || {},
        );
        continue;
      }

      // Publish one complete generation. Never expose partially rebuilt maps.
      anomalySnapshotBySystemID.set(systemID, snapshots[0]);
      signatureSnapshotBySystemID.set(systemID, snapshots[1]);
      staticSiteSnapshotBySystemID.set(systemID, snapshots[2]);
      structureSnapshotBySystemID.set(systemID, snapshots[3]);
      const fullState = buildCachedSignalTrackerFullState(systemID);
      // Only characters waiting for their first full state receive this
      // generation, unless an explicit overlay refresh asked for everyone.
      const broadcast = refresh.broadcast === true;
      const recipientCharacterIDs = new Set(refresh.recipientCharacterIDs);
      refresh.broadcast = false;
      refresh.recipientCharacterIDs.clear();
      let interrupted = false;
      for (const [characterID, session] of getRegisteredSignalTrackerEntriesForSystem(systemID)) {
        if (!isCurrent() || revision !== refresh.revision) {
          interrupted = true;
          break;
        }
        if (!broadcast && !recipientCharacterIDs.has(characterID)) {
          continue;
        }
        if (!canSignalTrackerSessionReceiveSystem(session, systemID)) {
          continue;
        }
        const payload = [systemID, fullState];
        if (options.shouldRemoveOldSites === true) {
          payload.push(true);
        }
        try {
          session.sendNotification("OnSignalTrackerFullState", "charid", payload);
        } catch (error) {
          log.error(`[ScanMgr] Signal tracker notification failed for ${systemID}: ${error.stack || error}`);
        }
      }
      if (interrupted) {
        // Hand the undelivered requests to the replacement cycle.
        refresh.broadcast = refresh.broadcast || broadcast;
        for (const characterID of recipientCharacterIDs) {
          refresh.recipientCharacterIDs.add(characterID);
        }
      }
      if (revision !== refresh.revision) {
        refresh.pendingOptions = mergeSignalTrackerRefreshOptions(options, refresh.pendingOptions || {});
      }
    }
  } catch (error) {
    // Release the coordinator after an unexpected failure so later requests
    // can retry instead of remaining wedged.
    log.error(`[ScanMgr] Signal tracker refresh failed for ${systemID}: ${error.stack || error}`);
  } finally {
    if (isCurrent()) {
      signalTrackerRefreshBySystemID.delete(systemID);
    }
  }
}

function getSignalTrackerSessionSystemID(session) {
  return normalizeNumber(
    session &&
      (
        (session._space && session._space.systemID) ||
        session.solarsystemid2 ||
        session.solarsystemid
      ),
    0,
  );
}

function canSignalTrackerSessionReceiveSystem(session, systemID, options = {}) {
  const numericSystemID = normalizeNumber(systemID, 0);
  if (
    !session ||
    typeof session.sendNotification !== "function" ||
    numericSystemID <= 0 ||
    getSignalTrackerSessionSystemID(session) !== numericSystemID
  ) {
    return false;
  }

  const restriction = resolveAbyssalScannerRestriction(
    session,
    "system_scanner",
    options,
  );
  return !(restriction && restriction.blocked === true);
}

function getRegisteredSignalTrackerEntriesForSystem(systemID) {
  const numericSystemID = normalizeNumber(systemID, 0);
  if (numericSystemID <= 0) {
    return [];
  }
  const registrations = [];
  for (const [characterID, entry] of signalTrackerRegistrationsByCharacterID.entries()) {
    if (normalizeNumber(entry && entry.systemID, 0) !== numericSystemID) {
      continue;
    }
    const session = entry && entry.session;
    if (!canSignalTrackerSessionReceiveSystem(session, numericSystemID)) {
      // Registrations are tied to one live session and one system. Prune them
      // as soon as the pilot moves or enters an Abyssal host so a later delta
      // cannot replay stale K-space or private-host scanner state.
      if (signalTrackerRegistrationsByCharacterID.get(characterID) === entry) {
        signalTrackerRegistrationsByCharacterID.delete(characterID);
      }
      continue;
    }
    registrations.push([characterID, session]);
  }
  return registrations;
}

function getRegisteredSessionsForSystem(systemID) {
  return getRegisteredSignalTrackerEntriesForSystem(systemID).map(([, session]) => session);
}

function notifySignatureDeltaForSystem(systemID, options = {}) {
  const numericSystemID = normalizeNumber(systemID, 0);
  if (numericSystemID <= 0) {
    return;
  }

  invalidateSignalTrackerRefresh(numericSystemID, options);
  const sessions = getRegisteredSessionsForSystem(numericSystemID);
  if (sessions.length <= 0) {
    // A snapshot is useful only as the previous state for a live listener.
    // Rebuilding one here turns a wormhole lifecycle fanout into synchronous
    // scanner work for every affected system, even when nobody is listening.
    signatureSnapshotBySystemID.delete(numericSystemID);
    return;
  }

  const previousEntries = signatureSnapshotBySystemID.get(numericSystemID) || new Map();
  const currentEntries = buildSignatureEntryMap(numericSystemID, options);
  signatureSnapshotBySystemID.set(numericSystemID, currentEntries);

  const addedEntries = [];
  const removedSiteIDs = new Set();
  for (const [siteID, siteInfo] of currentEntries.entries()) {
    const previousInfo = previousEntries.get(siteID);
    if (!previousInfo) {
      addedEntries.push([siteID, siteInfo]);
      continue;
    }
    if (!areTrackerEntriesEqual(previousInfo, siteInfo)) {
      removedSiteIDs.add(siteID);
      addedEntries.push([siteID, siteInfo]);
    }
  }
  for (const siteID of previousEntries.keys()) {
    if (!currentEntries.has(siteID)) {
      removedSiteIDs.add(siteID);
    }
  }

  if (addedEntries.length <= 0 && removedSiteIDs.size <= 0) {
    return;
  }

  const payload = [
    numericSystemID,
    buildDict(addedEntries),
    buildPythonSet([...removedSiteIDs]),
  ];
  for (const session of sessions) {
    session.sendNotification(
      "OnSignalTrackerSignatureUpdate",
      "charid",
      payload,
    );
    for (const [, siteInfo] of addedEntries) {
      sendLegacyCosmicSignatureAdded(session, siteInfo);
    }
  }
}

function notifyAnomalyDeltaForSystem(systemID, options = {}) {
  const numericSystemID = normalizeNumber(systemID, 0);
  if (numericSystemID <= 0) {
    return;
  }

  invalidateSignalTrackerRefresh(numericSystemID, options);
  const sessions = getRegisteredSessionsForSystem(numericSystemID);
  if (sessions.length <= 0) {
    anomalySnapshotBySystemID.delete(numericSystemID);
    return;
  }

  const previousEntries = anomalySnapshotBySystemID.get(numericSystemID) || new Map();
  const currentEntries = buildAnomalyEntryMap(numericSystemID, options);
  anomalySnapshotBySystemID.set(numericSystemID, currentEntries);

  const addedEntries = [];
  const removedSiteIDs = new Set();
  const removedEntries = new Map();
  for (const [siteID, siteInfo] of currentEntries.entries()) {
    const previousInfo = previousEntries.get(siteID);
    if (!previousInfo) {
      addedEntries.push([siteID, siteInfo]);
      continue;
    }
    if (!areTrackerEntriesEqual(previousInfo, siteInfo)) {
      removedSiteIDs.add(siteID);
      removedEntries.set(siteID, previousInfo);
      addedEntries.push([siteID, siteInfo]);
    }
  }
  for (const [siteID, siteInfo] of previousEntries.entries()) {
    if (!currentEntries.has(siteID)) {
      removedSiteIDs.add(siteID);
      removedEntries.set(siteID, siteInfo);
    }
  }

  if (addedEntries.length <= 0 && removedSiteIDs.size <= 0) {
    return;
  }

  const payload = [
    numericSystemID,
    buildDict(addedEntries),
    buildPythonSet([...removedSiteIDs]),
  ];
  for (const session of sessions) {
    session.sendNotification(
      "OnSignalTrackerAnomalyUpdate",
      "charid",
      payload,
    );
    for (const [, siteInfo] of addedEntries) {
      sendLegacyCosmicAnomalyAdded(session, siteInfo);
    }
    for (const siteID of removedSiteIDs) {
      sendLegacyCosmicAnomalyRemoved(
        session,
        siteID,
        removedEntries.get(siteID),
        numericSystemID,
      );
    }
  }
}

function areTrackerEntriesEqual(left, right) {
  if (left === right) {
    return true;
  }
  return JSON.stringify(marshalObjectToObject(left)) === JSON.stringify(marshalObjectToObject(right));
}

function getTrackerInfoField(siteInfo, fieldName, fallback = null) {
  const normalized = marshalObjectToObject(siteInfo);
  if (!normalized || typeof normalized !== "object") {
    return fallback;
  }
  return normalized[fieldName] === undefined || normalized[fieldName] === null
    ? fallback
    : normalized[fieldName];
}

function sendLegacyCosmicAnomalyAdded(session, siteInfo) {
  if (!session || typeof session.sendNotification !== "function" || !siteInfo) {
    return false;
  }
  session.sendNotification("OnCosmicAnomalyAdded", "solarsystemid2", [siteInfo]);
  return true;
}

function sendLegacyCosmicAnomalyRemoved(session, siteID, siteInfo, systemID) {
  if (!session || typeof session.sendNotification !== "function") {
    return false;
  }
  const numericSiteID = normalizeNumber(siteID, 0);
  if (numericSiteID <= 0) {
    return false;
  }
  session.sendNotification("OnCosmicAnomalyRemoved", "solarsystemid2", [
    numericSiteID,
    normalizeNumber(getTrackerInfoField(siteInfo, "dungeonID", 0), 0),
    normalizeNumber(getTrackerInfoField(siteInfo, "solarSystemID", systemID), systemID),
  ]);
  return true;
}

function sendLegacyCosmicSignatureAdded(session, siteInfo) {
  if (!session || typeof session.sendNotification !== "function" || !siteInfo) {
    return false;
  }
  const targetID = String(getTrackerInfoField(siteInfo, "targetID", "") || "").trim();
  if (!targetID) {
    return false;
  }
  session.sendNotification("OnCosmicSignatureAdded", "solarsystemid2", [targetID]);
  return true;
}

function notifyStructureDeltaForSystem(systemID, options = {}) {
  const numericSystemID = normalizeNumber(systemID, 0);
  if (numericSystemID <= 0) {
    return;
  }

  invalidateSignalTrackerRefresh(numericSystemID, options);
  const sessions = getRegisteredSessionsForSystem(numericSystemID);
  if (sessions.length <= 0) {
    structureSnapshotBySystemID.delete(numericSystemID);
    return;
  }

  const previousEntries = structureSnapshotBySystemID.get(numericSystemID) || new Map();
  const currentEntries = buildStructureEntryMap(numericSystemID, options);
  structureSnapshotBySystemID.set(numericSystemID, currentEntries);

  const addedEntries = [];
  const removedSiteIDs = new Set();
  for (const [siteID, siteInfo] of currentEntries.entries()) {
    const previousInfo = previousEntries.get(siteID);
    if (!previousInfo) {
      addedEntries.push([siteID, siteInfo]);
      continue;
    }
    if (!areTrackerEntriesEqual(previousInfo, siteInfo)) {
      removedSiteIDs.add(siteID);
      addedEntries.push([siteID, siteInfo]);
    }
  }
  for (const siteID of previousEntries.keys()) {
    if (!currentEntries.has(siteID)) {
      removedSiteIDs.add(siteID);
    }
  }

  if (addedEntries.length <= 0 && removedSiteIDs.size <= 0) {
    return;
  }

  const payload = [
    numericSystemID,
    buildDict(addedEntries),
    buildPythonSet([...removedSiteIDs]),
  ];
  for (const session of sessions) {
    session.sendNotification(
      "OnSignalTrackerStructureUpdate",
      "charid",
      payload,
    );
  }
}

function notifyFullStateRefreshForSystem(systemID, options = {}) {
  const numericSystemID = normalizeNumber(systemID, 0);
  if (numericSystemID <= 0) {
    return {
      success: false,
      errorMsg: "SYSTEM_NOT_FOUND",
    };
  }

  // An explicit full refresh, such as /overlayrefresh, replaces the overlay of
  // every listener in the system.
  const refresh = scheduleSignalTrackerRefresh(numericSystemID, options);
  refresh.broadcast = true;

  return {
    success: true,
    data: {
      systemID: numericSystemID,
      sessionCount: getRegisteredSessionsForSystem(numericSystemID).length,
      scheduled: true,
    },
  };
}

function scheduleNotification(session, name, payload = []) {
  if (!session || typeof session.sendNotification !== "function") {
    return;
  }
  setImmediate(() => {
    session.sendNotification(name, "clientID", payload);
  });
}

function scheduleProbeRemovalNotifications(session, probeIDs = []) {
  probeSceneRuntime.removeProbeEntitiesForSession(session, probeIDs);
  for (const probeID of Array.isArray(probeIDs) ? probeIDs : [probeIDs]) {
    const numericProbeID = normalizeNumber(probeID, 0);
    if (numericProbeID <= 0) {
      continue;
    }
    scheduleNotification(session, "OnRemoveProbe", [numericProbeID]);
  }
}

function scheduleProbeReplayNotifications(session, probes = []) {
  const normalizedProbes = (Array.isArray(probes) ? probes : [])
    .filter((probe) => normalizeNumber(probe && probe.probeID, 0) > 0);
  if (normalizedProbes.length <= 0) {
    return;
  }

  probeSceneRuntime.ensureProbeEntitiesForSession(session, normalizedProbes);
  setImmediate(() => {
    for (const probe of normalizedProbes) {
      session.sendNotification("OnNewProbe", "clientID", [
        probeScanRuntime.buildProbeKeyVal(probe),
      ]);
    }
    session.sendNotification("OnProbesIdle", "clientID", [
      normalizedProbes.map((probe) => probeScanRuntime.buildProbeKeyVal(probe)),
    ]);
  });
}

function resolveSessionProbeControlAuthority(session) {
  const localAbyssalClaim = sessionClaimsAbyssalScene(session);
  const runtime = getSpaceRuntime();
  const scene =
    runtime && typeof runtime.getSceneForSession === "function"
      ? runtime.getSceneForSession(session)
      : null;
  const controllerEntity =
    scene && typeof scene.getShipEntityForSession === "function"
      ? scene.getShipEntityForSession(session)
      : null;
  const scope = resolveAbyssalPlayerLaunchScope(
    session,
    controllerEntity,
    scene,
  );
  if (!scope || scope.scoped !== true) {
    return {
      restricted: localAbyssalClaim,
      valid: localAbyssalClaim !== true,
      runID: null,
      roomIndex: null,
      roomOriginPosition: null,
      scene,
    };
  }
  if (scope.valid !== true) {
    return {
      restricted: true,
      valid: false,
      runID: null,
      roomIndex: null,
      roomOriginPosition: null,
      scene,
    };
  }
  return {
    restricted: true,
    valid: true,
    runID: scope.runID,
    roomIndex: scope.roomIndex,
    roomOriginPosition: normalizeExactCartesianPosition(
      controllerEntity && controllerEntity.dungeonCurrentRoomPosition,
    ),
    scene,
  };
}

function filterProbeRecordsForSessionControl(session, probes = [], options = {}) {
  const records = Array.isArray(probes) ? probes : [];
  const authority = options.authority || resolveSessionProbeControlAuthority(session);
  if (authority.restricted !== true) {
    return records;
  }
  if (authority.valid !== true || !authority.scene) {
    return [];
  }
  const systemID = normalizeNumber(authority.scene.systemID, 0);
  return records.filter((probe) => {
    const probeScope = probeRuntimeState.getExactAbyssalProbeScope(probe);
    return Boolean(
      probeScope &&
        entityIDsEqual(probeScope.runID, authority.runID) &&
        probeScope.roomIndex === authority.roomIndex &&
        normalizeNumber(probe && probe.systemID, 0) === systemID
    );
  });
}

function filterProbeIDsForSessionControl(session, characterID, probeIDs = []) {
  const requestedIDs = new Set(
    (Array.isArray(probeIDs) ? probeIDs : [probeIDs])
      .map((probeID) => normalizeNumber(probeID, 0))
      .filter((probeID) => probeID > 0),
  );
  if (requestedIDs.size <= 0) {
    return [...requestedIDs];
  }
  const authority = resolveSessionProbeControlAuthority(session);
  if (authority.restricted !== true) {
    return [...requestedIDs];
  }
  const characterState = probeRuntimeState.getCharacterStateSnapshot(characterID);
  const selectedRecords = Object.values(
    characterState && characterState.probesByID || {},
  ).filter((probe) => requestedIDs.has(normalizeNumber(probe && probe.probeID, 0)));
  return filterProbeRecordsForSessionControl(session, selectedRecords, { authority })
    .map((probe) => normalizeNumber(probe && probe.probeID, 0))
    .filter((probeID) => probeID > 0);
}

function normalizeExactCartesianPosition(value) {
  const components = Array.isArray(value)
    ? value.slice(0, 3)
    : value && typeof value === "object"
      ? [value.x, value.y, value.z]
      : null;
  if (!components || components.length < 3) {
    return null;
  }
  const normalized = components.map((component) => Number(component));
  return normalized.every(Number.isFinite) ? normalized : null;
}

function retireOutOfBoundsAbyssalProbesForSession(
  session,
  characterID,
  systemID,
  effectiveProbeMap = null,
  options = {},
) {
  const authority = options.authority || resolveSessionProbeControlAuthority(session);
  const numericCharacterID = normalizeNumber(characterID, 0);
  const numericSystemID = normalizeNumber(systemID, 0);
  if (authority.restricted !== true) {
    return { applied: false, reason: "NOT_ABYSSAL", removedProbeIDs: [] };
  }
  if (
    authority.valid !== true ||
    !authority.scene ||
    normalizeNumber(authority.scene.systemID, 0) !== numericSystemID ||
    numericCharacterID <= 0 ||
    numericSystemID <= 0
  ) {
    return { applied: false, reason: "INVALID_SCOPE", removedProbeIDs: [] };
  }

  const roomOrigin = normalizeExactCartesianPosition(authority.roomOriginPosition);
  if (!roomOrigin) {
    // Boundary loss is destructive. If the exact authored room origin is not
    // available, preserve every probe instead of guessing from the ship or zero.
    return { applied: false, reason: "ROOM_ORIGIN_UNAVAILABLE", removedProbeIDs: [] };
  }

  const radiusSquared = ABYSS_BOUNDARY_RADIUS_METERS ** 2;
  const exactRoomProbes = filterProbeRecordsForSessionControl(
    session,
    probeRuntimeState.getCharacterSystemProbes(numericCharacterID, numericSystemID),
    { authority },
  );
  const outOfBoundsProbeIDs = exactRoomProbes
    .filter((probe) => {
      const position = normalizeExactCartesianPosition(probe && probe.pos);
      if (!position) {
        return false;
      }
      const distanceSquared = position.reduce((sum, component, index) => (
        sum + ((component - roomOrigin[index]) ** 2)
      ), 0);
      return Number.isFinite(distanceSquared) && distanceSquared > radiusSquared;
    })
    .map((probe) => normalizeNumber(probe && probe.probeID, 0))
    .filter((probeID) => probeID > 0);
  if (outOfBoundsProbeIDs.length <= 0) {
    return { applied: true, reason: "IN_BOUNDS", removedProbeIDs: [] };
  }

  const removedProbeIDs = probeRuntimeState.removeCharacterProbes(
    numericCharacterID,
    outOfBoundsProbeIDs,
    { nowMs: Date.now() },
  )
    .map((probe) => normalizeNumber(probe && probe.probeID, 0))
    .filter((probeID) => probeID > 0);
  for (const probeID of removedProbeIDs) {
    if (effectiveProbeMap instanceof Map) {
      effectiveProbeMap.delete(probeID);
    }
  }
  scheduleProbeRemovalNotifications(session, removedProbeIDs);
  return { applied: true, reason: "BOUNDARY_LOSS", removedProbeIDs };
}

function restoreRecoveredProbeCharges(session, characterID, removedProbes = [], options = {}) {
  const numericCharacterID = normalizeNumber(characterID, 0);
  const fallbackShipID = normalizeNumber(options.shipID, 0);
  if (numericCharacterID <= 0 || !Array.isArray(removedProbes) || removedProbes.length <= 0) {
    return 0;
  }

  const groupedRestores = new Map();
  for (const probe of removedProbes) {
    const typeID = normalizeNumber(probe && probe.typeID, 0);
    const persistedShipID = normalizeNumber(probe && probe.launchShipID, 0);
    const launcherFlagID = normalizeNumber(probe && probe.launcherFlagID, 0);
    const launcherItemID = normalizeNumber(probe && probe.launcherItemID, 0);
    const shipID =
      (persistedShipID > 0 && findItemById(persistedShipID))
        ? persistedShipID
        : fallbackShipID;
    if (typeID <= 0 || shipID <= 0) {
      continue;
    }

    const key = `${shipID}:${launcherFlagID}:${typeID}`;
    if (!groupedRestores.has(key)) {
      groupedRestores.set(key, {
        shipID,
        launcherFlagID,
        launcherItemID,
        typeID,
        quantity: 0,
      });
    }
    groupedRestores.get(key).quantity += 1;
  }

  let restoredCharges = 0;
  const dogmaHelper = getDogmaNotificationHelper();
  for (const entry of groupedRestores.values()) {
    if (entry.quantity <= 0) {
      continue;
    }

    const moduleItem = entry.launcherFlagID > 0
      ? getFittedModuleByFlag(numericCharacterID, entry.shipID, entry.launcherFlagID)
      : null;
    const canRestoreToLauncher =
      moduleItem &&
      normalizeNumber(moduleItem.itemID, 0) > 0 &&
      isChargeCompatibleWithModule(moduleItem.typeID, entry.typeID);
    const moduleCapacity = canRestoreToLauncher
      ? Math.max(0, normalizeNumber(
          getModuleChargeCapacity(moduleItem.typeID, entry.typeID),
          0,
        ))
      : 0;
    const currentLoadedCharge = canRestoreToLauncher
      ? getLoadedChargeByFlag(numericCharacterID, entry.shipID, entry.launcherFlagID)
      : null;
    const currentLoadedQuantity = Math.max(
      0,
      normalizeNumber(
        currentLoadedCharge &&
          (currentLoadedCharge.stacksize ?? currentLoadedCharge.quantity),
        0,
      ),
    );
    const launcherFreeSpace = canRestoreToLauncher
      ? Math.max(0, moduleCapacity - currentLoadedQuantity)
      : 0;
    const launcherQuantity = Math.min(entry.quantity, launcherFreeSpace);
    const cargoQuantity = Math.max(0, entry.quantity - launcherQuantity);
    const previousChargeState = launcherQuantity > 0
      ? dogmaHelper._captureChargeStateSnapshot(
          numericCharacterID,
          entry.shipID,
          entry.launcherFlagID,
        )
      : null;
    const previousChargeItem = launcherQuantity > 0
      ? dogmaHelper._captureChargeItemSnapshot(
          numericCharacterID,
          entry.shipID,
          entry.launcherFlagID,
        )
      : null;
    const itemType = resolveItemByTypeID(entry.typeID) || entry.typeID;
    const restoreTargets = [];
    if (launcherQuantity > 0) {
      restoreTargets.push({
        quantity: launcherQuantity,
        flagID: entry.launcherFlagID,
      });
    }
    if (cargoQuantity > 0) {
      restoreTargets.push({
        quantity: cargoQuantity,
        flagID: ITEM_FLAGS.CARGO_HOLD,
      });
    }

    let restoreFailed = false;
    for (const target of restoreTargets) {
      if (target.quantity <= 0) {
        continue;
      }
      const grantResult = grantItemToCharacterLocation(
        numericCharacterID,
        entry.shipID,
        target.flagID,
        itemType,
        target.quantity,
        { singleton: 0 },
      );
      if (!grantResult || grantResult.success !== true) {
        log.warn(
          `[ScanMgr] Failed to restore ${target.quantity} recovered probe charge(s) ` +
          `typeID=${entry.typeID} shipID=${entry.shipID} flagID=${target.flagID}: ` +
          `${grantResult && grantResult.errorMsg ? grantResult.errorMsg : "WRITE_ERROR"}`,
        );
        restoreFailed = true;
        break;
      }
      dogmaHelper._syncInventoryChanges(
        session,
        (grantResult.data && grantResult.data.changes) || [],
      );
      restoredCharges += target.quantity;
    }
    if (restoreFailed) {
      continue;
    }

    if (launcherQuantity > 0) {
      const nextChargeState = dogmaHelper._captureChargeStateSnapshot(
        numericCharacterID,
        entry.shipID,
        entry.launcherFlagID,
      );
      dogmaHelper._notifyChargeQuantityTransition(
        session,
        numericCharacterID,
        entry.shipID,
        entry.launcherFlagID,
        previousChargeState,
        nextChargeState,
      );
      dogmaHelper._notifyWeaponModuleAttributeTransition(
        session,
        moduleItem,
        previousChargeItem,
        dogmaHelper._captureChargeItemSnapshot(
          numericCharacterID,
          entry.shipID,
          entry.launcherFlagID,
        ),
      );
    }
  }

  return restoredCharges;
}

function handleWormholeSignatureStateChange(systemIDs = []) {
  for (const systemID of Array.isArray(systemIDs) ? systemIDs : [systemIDs]) {
    notifySignatureDeltaForSystem(systemID);
  }
}

function emitProbeScanLifecycleNotifications(session, scanResult, options = {}) {
  if (!session || typeof session.sendNotification !== "function" || !scanResult) {
    return;
  }

  const durationMs = Math.max(
    1,
    normalizeNumber(
      options.durationMs,
      normalizeNumber(scanResult.durationMs, probeScanRuntime.DEFAULT_PROBE_SCAN_DURATION_MS),
    ),
  );
  const startTime = options.startedAtFileTime || currentFileTime();
  session.sendNotification("OnSystemScanStarted", "charid", [
    startTime,
    durationMs,
    probeScanRuntime.buildProbeDict(scanResult.probes instanceof Map ? scanResult.probes : new Map()),
  ]);
  scheduleProbeScanStopNotification(session, scanResult, {
    durationMs,
    immediateStop: options.immediateStop === true,
    scheduleFn: options.scheduleFn,
    clearFn: options.clearFn,
  });
}

function emitProbeScanStoppedNotification(session, scanResult) {
  if (!session || !scanResult) {
    return;
  }

  probeScanWarpAuthority.recordCompletedScan(session, scanResult);
  if (typeof session.sendNotification !== "function") {
    return;
  }

  session.sendNotification("OnSystemScanStopped", "charid", [
    Array.isArray(scanResult.probeIDs) ? scanResult.probeIDs : [],
    Array.isArray(scanResult.results) ? scanResult.results : [],
    Array.isArray(scanResult.absentTargets) ? scanResult.absentTargets : [],
  ]);
}

function resolveAbyssalScannerRestriction(session, category, options = {}) {
  const abyssalMgrService = getAbyssalMgrServiceHelper();
  if (
    !abyssalMgrService ||
    typeof abyssalMgrService.resolveAbyssalVisibilityRestrictionForSession !== "function"
  ) {
    return null;
  }
  return abyssalMgrService.resolveAbyssalVisibilityRestrictionForSession(
    session,
    category,
    options,
  );
}

function buildSignalTrackerFullStateForSession(session, systemID, options = {}) {
  const restriction = resolveAbyssalScannerRestriction(session, "system_scanner", options);
  if (restriction && restriction.blocked === true) {
    return buildEmptySignalTrackerFullState();
  }
  return buildLiveSignalTrackerFullState(systemID, options);
}

function clearPendingProbeScanStop(session) {
  if (!session || !session._pendingProbeScanStop) {
    return;
  }

  const pending = session._pendingProbeScanStop;
  session._pendingProbeScanStop = null;
  if (typeof pending.clearFn === "function" && pending.handle !== undefined) {
    pending.clearFn(pending.handle);
  }
}

function clearPendingProbeMovement(session) {
  if (!session || !session._pendingProbeMovement) {
    return;
  }

  const pending = session._pendingProbeMovement;
  session._pendingProbeMovement = null;
  if (typeof pending.clearFn === "function" && pending.handle !== undefined) {
    pending.clearFn(pending.handle);
  }
}

function scheduleProbeScanStopNotification(session, scanResult, options = {}) {
  if (!session || typeof session.sendNotification !== "function" || !scanResult) {
    return;
  }

  const durationMs = Math.max(
    1,
    normalizeNumber(
      options.durationMs,
      normalizeNumber(scanResult.durationMs, probeScanRuntime.DEFAULT_PROBE_SCAN_DURATION_MS),
    ),
  );
  if (options.immediateStop === true) {
    clearPendingProbeScanStop(session);
    emitProbeScanStoppedNotification(session, scanResult);
    return;
  }

  const scheduleFn = typeof options.scheduleFn === "function"
    ? options.scheduleFn
    : setTimeout;
  const clearFn = typeof options.clearFn === "function"
    ? options.clearFn
    : clearTimeout;
  clearPendingProbeScanStop(session);
  const token = Symbol("probeScanStop");
  const handle = scheduleFn(() => {
    if (!session || !session._pendingProbeScanStop) {
      return;
    }
    if (session._pendingProbeScanStop.token !== token) {
      return;
    }
    session._pendingProbeScanStop = null;
    emitProbeScanStoppedNotification(session, scanResult);
  }, durationMs);
  session._pendingProbeScanStop = {
    token,
    handle,
    clearFn,
  };
}

function areProbePositionsEqual(left, right) {
  const leftPosition = Array.isArray(left) ? left : [0, 0, 0];
  const rightPosition = Array.isArray(right) ? right : [0, 0, 0];
  return (
    Math.abs(toFiniteNumber(leftPosition[0], 0) - toFiniteNumber(rightPosition[0], 0)) < 0.001 &&
    Math.abs(toFiniteNumber(leftPosition[1], 0) - toFiniteNumber(rightPosition[1], 0)) < 0.001 &&
    Math.abs(toFiniteNumber(leftPosition[2], 0) - toFiniteNumber(rightPosition[2], 0)) < 0.001
  );
}

const PROBE_STATE_WARPING = 3;

function scheduleProbeMovementThenScan(session, probes = [], scanStarter, options = {}) {
  const movingProbes = (Array.isArray(probes) ? probes : [])
    .filter((probe) => normalizeNumber(probe && probe.probeID, 0) > 0)
    .filter((probe) => !areProbePositionsEqual(probe && probe.pos, probe && probe.destination));
  if (movingProbes.length <= 0) {
    if (typeof scanStarter === "function") {
      scanStarter();
    }
    return;
  }

  const durationMs = Math.max(
    1,
    normalizeNumber(options.moveDurationMs, DEFAULT_PROBE_MOVE_DURATION_MS),
  );
  const scheduleFn = typeof options.scheduleFn === "function"
    ? options.scheduleFn
    : setTimeout;
  const clearFn = typeof options.clearFn === "function"
    ? options.clearFn
    : clearTimeout;
  const startTime = currentFileTime();

  clearPendingProbeMovement(session);
  // TQ first tells the owner each moving probe is now warping (probescanning
  // const probeStateWarping = 3), to the character, before the warps start
  // (golden log "Minmatar - Tutorial - Career missions part 1": eight
  // OnProbeStateChanged(probeID, 3) about 10 ms after the scan request).
  for (const probe of movingProbes) {
    session.sendNotification("OnProbeStateChanged", "charid", [
      normalizeNumber(probe && probe.probeID, 0),
      PROBE_STATE_WARPING,
    ]);
  }
  for (const probe of movingProbes) {
    session.sendNotification("OnProbeWarpStart", "charid", [
      normalizeNumber(probe && probe.probeID, 0),
      Array.isArray(probe && probe.pos) ? probe.pos : [0, 0, 0],
      Array.isArray(probe && probe.destination) ? probe.destination : [0, 0, 0],
      startTime,
      durationMs,
    ]);
  }

  const token = Symbol("probeMovement");
  const handle = scheduleFn(() => {
    if (!session || !session._pendingProbeMovement || session._pendingProbeMovement.token !== token) {
      return;
    }
    session._pendingProbeMovement = null;
    if (typeof options.onArrive === "function") {
      options.onArrive();
    }
    for (const probe of movingProbes) {
      session.sendNotification("OnProbeWarpEnd", "charid", [
        normalizeNumber(probe && probe.probeID, 0),
      ]);
    }
    if (typeof scanStarter === "function") {
      scanStarter();
    }
  }, durationMs);
  session._pendingProbeMovement = {
    token,
    handle,
    clearFn,
  };
}

function getSessionShipID(session) {
  return normalizeNumber(
    session && (
      session.shipID ||
      session.shipid ||
      session.activeShipID ||
      (session._space && session._space.shipID)
    ),
    0,
  );
}

function resolveActiveProbeLauncherForSession(session) {
  const charID = normalizeNumber(
    session && (session.characterID || session.charid || session.userid),
    0,
  );
  const shipID = getSessionShipID(session);
  if (charID <= 0 || shipID <= 0) {
    return null;
  }

  const onlineLaunchers = getFittedModuleItems(charID, shipID)
    .filter((item) => normalizeNumber(item && item.groupID, 0) === GROUP_SCAN_PROBE_LAUNCHER)
    .filter((item) => isModuleOnline(item));
  if (onlineLaunchers.length <= 0) {
    return null;
  }

  const loadedLauncher = onlineLaunchers.find((moduleItem) => {
    const loadedCharge = getLoadedChargeByFlag(charID, shipID, moduleItem.flagID);
    return normalizeNumber(loadedCharge && loadedCharge.groupID, 0) === GROUP_SCANNER_PROBE;
  });
  return loadedLauncher || onlineLaunchers[0] || null;
}

function getSkillLevel(skillRecord) {
  return Math.max(
    0,
    normalizeNumber(
      skillRecord && (
        skillRecord.effectiveSkillLevel ??
        skillRecord.trainedSkillLevel ??
        skillRecord.skillLevel
      ),
      0,
    ),
  );
}

function buildEmptyProbeScanBonuses() {
  return {
    strength: {
      modules: 0,
      ship: 0,
      skills: 0,
      implants: 0,
      boosters: 0,
    },
    deviation: {
      modules: 0,
      ship: 0,
      skills: 0,
      implants: 0,
      boosters: 0,
    },
    duration: {
      modules: 0,
      ship: 0,
      skills: 0,
      implants: 0,
      boosters: 0,
    },
  };
}

function addProbeScanBonus(scanBonuses, bonusID, originID, value) {
  const numericValue = toFiniteNumber(value, 0);
  if (!scanBonuses || !scanBonuses[bonusID] || !Number.isFinite(numericValue)) {
    return;
  }
  scanBonuses[bonusID][originID] =
    toFiniteNumber(scanBonuses[bonusID][originID], 0) + numericValue;
}

function addActiveProbeLauncherCommandBurstBonuses(
  scanBonuses,
  entity,
  launcherItem,
  nowMs,
) {
  if (!entity || !launcherItem) {
    return;
  }

  for (const entry of commandBurstRuntime.collectModifierEntriesForItem(
    entity,
    launcherItem,
    nowMs,
  )) {
    if (normalizeNumber(entry && entry.operation, 0) !== DOGMA_OP_POST_PERCENT) {
      continue;
    }
    const targetAttributeID = normalizeNumber(
      entry && (entry.modifiedAttributeID ?? entry.targetAttributeID),
      0,
    );
    if (targetAttributeID === ATTRIBUTE_EXPEDITION_PROBE_STRENGTH_FACTOR) {
      addProbeScanBonus(scanBonuses, "strength", "modules", entry.value);
    } else if (targetAttributeID === ATTRIBUTE_EXPEDITION_PROBE_DEVIATION_FACTOR) {
      addProbeScanBonus(scanBonuses, "deviation", "modules", entry.value);
    }
  }
}

function resolveCharacterProbeScanBonuses(characterID, options = {}) {
  const numericCharacterID = normalizeNumber(characterID, 0);
  const scanBonuses = buildEmptyProbeScanBonuses();
  if (numericCharacterID <= 0) {
    return scanBonuses;
  }

  const skillMap = getCharacterSkillMap(numericCharacterID, {
    includeExpertSystems: false,
  });
  for (const skillTypeID of SCANNING_SKILL_TYPE_IDS) {
    const skillLevel = getSkillLevel(skillMap.get(skillTypeID));
    if (skillLevel <= 0) {
      continue;
    }
    const attributes = getTypeDogmaAttributes(skillTypeID);
    addProbeScanBonus(
      scanBonuses,
      "strength",
      "skills",
      skillLevel * toFiniteNumber(attributes[String(ATTRIBUTE_PROBE_SCAN_STRENGTH_BONUS)], 0),
    );
    addProbeScanBonus(
      scanBonuses,
      "deviation",
      "skills",
      skillLevel * toFiniteNumber(attributes[String(ATTRIBUTE_MAX_SCAN_DEVIATION_MODIFIER)], 0),
    );
  }

  if (getSkillLevel(skillMap.get(3412)) <= 0) {
    return scanBonuses;
  }

  for (const entry of getImplantDogmaModifierEntries(numericCharacterID)) {
    if (normalizeNumber(entry && entry.operation, 0) !== DOGMA_OP_POST_PERCENT) {
      continue;
    }
    const targetAttributeID = normalizeNumber(
      entry && (entry.modifiedAttributeID ?? entry.targetAttributeID),
      0,
    );
    const originID = String(entry && entry.sourceKind || "") === "booster"
      ? "boosters"
      : "implants";
    if (targetAttributeID === ATTRIBUTE_BASE_SENSOR_STRENGTH) {
      addProbeScanBonus(scanBonuses, "strength", originID, entry.value);
    } else if (targetAttributeID === ATTRIBUTE_BASE_MAX_SCAN_DEVIATION) {
      addProbeScanBonus(scanBonuses, "deviation", originID, entry.value);
    }
  }

  const shipID = normalizeNumber(options && options.shipID, 0);
  if (shipID > 0) {
    const shipItem = findItemById(shipID);
    const fittingSnapshot = shipItem
      ? getShipFittingSnapshot(numericCharacterID, shipItem)
      : null;
    const shipAttributes = fittingSnapshot && fittingSnapshot.shipAttributes
      ? fittingSnapshot.shipAttributes
      : getTypeDogmaAttributes(shipItem && shipItem.typeID);
    for (const effectRecord of getTypeEffectRecords(shipItem && shipItem.typeID)) {
      for (const modifierInfo of Array.isArray(effectRecord && effectRecord.modifierInfo)
        ? effectRecord.modifierInfo
        : []) {
        if (
          modifierInfo &&
          String(modifierInfo.func || "") === "OwnerRequiredSkillModifier" &&
          normalizeNumber(modifierInfo.modifiedAttributeID, 0) ===
            ATTRIBUTE_BASE_SENSOR_STRENGTH &&
          normalizeNumber(modifierInfo.operation, 0) === DOGMA_OP_POST_PERCENT
        ) {
          addProbeScanBonus(
            scanBonuses,
            "strength",
            "ship",
            toFiniteNumber(
              shipAttributes[normalizeNumber(modifierInfo.modifyingAttributeID, 0)],
              0,
            ),
          );
        }
      }
    }

    const fittedModules = getFittedModuleItems(numericCharacterID, shipID);
    const onlineProbeLaunchers = fittedModules
      .filter((moduleItem) =>
        normalizeNumber(moduleItem && moduleItem.groupID, 0) === GROUP_SCAN_PROBE_LAUNCHER)
      .filter((moduleItem) => isModuleOnline(moduleItem));
    const activeProbeLauncher = onlineProbeLaunchers.find((moduleItem) => {
      const loadedCharge = getLoadedChargeByFlag(
        numericCharacterID,
        shipID,
        moduleItem.flagID,
      );
      return normalizeNumber(loadedCharge && loadedCharge.groupID, 0) === GROUP_SCANNER_PROBE;
    }) || onlineProbeLaunchers[0] || null;
    const shipEntity =
      options &&
      options.entity &&
      normalizeNumber(options.entity.itemID, 0) === shipID
        ? options.entity
        : null;
    const commandBurstNowMs = toFiniteNumber(
      options && options.nowMs,
      toFiniteNumber(
        shipEntity &&
          shipEntity.session &&
          shipEntity.session._space &&
          shipEntity.session._space.simTimeMs,
        Date.now(),
      ),
    );
    addActiveProbeLauncherCommandBurstBonuses(
      scanBonuses,
      shipEntity,
      activeProbeLauncher,
      commandBurstNowMs,
    );
    for (const moduleItem of fittedModules) {
      if (!isModuleOnline(moduleItem)) {
        continue;
      }
      const moduleAttributes = getTypeDogmaAttributes(moduleItem && moduleItem.typeID);
      const launcherStrengthBonus =
        activeProbeLauncher &&
        normalizeNumber(moduleItem && moduleItem.itemID, 0) ===
          normalizeNumber(activeProbeLauncher && activeProbeLauncher.itemID, 0)
          ? toFiniteNumber(
            moduleAttributes[String(ATTRIBUTE_PROBE_SCAN_STRENGTH_BONUS)],
            0,
          )
          : 0;
      addProbeScanBonus(
        scanBonuses,
        "strength",
        "modules",
        launcherStrengthBonus +
          toFiniteNumber(moduleAttributes[String(ATTRIBUTE_SCAN_STRENGTH_BONUS_MODULE)], 0),
      );
      addProbeScanBonus(
        scanBonuses,
        "deviation",
        "modules",
        toFiniteNumber(moduleAttributes[String(ATTRIBUTE_SCAN_DEVIATION_BONUS_MODULE)], 0),
      );
      addProbeScanBonus(
        scanBonuses,
        "duration",
        "modules",
        toFiniteNumber(moduleAttributes[String(ATTRIBUTE_SCAN_DURATION_BONUS_MODULE)], 0),
      );
    }
  }

  return scanBonuses;
}

function resolveCharacterScanDurationBonusMultiplier(characterID, options = {}) {
  const numericCharacterID = normalizeNumber(characterID, 0);
  if (numericCharacterID <= 0) {
    return 1;
  }

  let multiplier = 1;
  const skillMap = getCharacterSkillMap(numericCharacterID, {
    includeExpertSystems: false,
  });
  for (const skillTypeID of SCANNING_SKILL_TYPE_IDS) {
    const skillRecord = skillMap.get(skillTypeID) || null;
    const skillLevel = normalizeNumber(
      skillRecord && (
        skillRecord.effectiveSkillLevel ??
        skillRecord.trainedSkillLevel ??
        skillRecord.skillLevel
      ),
      0,
    );
    if (skillLevel <= 0) {
      continue;
    }
    const attributes = getTypeDogmaAttributes(skillTypeID);
    const perLevelBonus = Number(attributes[String(ATTRIBUTE_SCAN_DURATION_ALTERNATE)]);
    if (!Number.isFinite(perLevelBonus) || perLevelBonus === 0) {
      continue;
    }
    multiplier *= (1 + ((skillLevel * perLevelBonus) / 100));
  }

  const characterRecord = getCharacterStateHelper().getCharacterRecord(numericCharacterID);
  const implants = Array.isArray(characterRecord && characterRecord.implants)
    ? characterRecord.implants
    : [];
  let implantMultiplier = 1;
  for (const implant of implants) {
    const implantTypeID = normalizeNumber(implant && implant.typeID, 0);
    if (implantTypeID <= 0) {
      continue;
    }
    const attributes = getTypeDogmaAttributes(implantTypeID);
    const bonus = Number(attributes[String(ATTRIBUTE_SCAN_DURATION_ALTERNATE)]);
    if (Number.isFinite(bonus) && bonus !== 0) {
      implantMultiplier *= (1 + (bonus / 100));
    }
  }

  let moduleMultiplier = 1;
  const shipID = normalizeNumber(options && options.shipID, 0);
  if (shipID > 0) {
    for (const moduleItem of getFittedModuleItems(numericCharacterID, shipID)) {
      if (!isModuleOnline(moduleItem)) {
        continue;
      }
      const bonus = Number(
        getTypeDogmaAttributes(moduleItem && moduleItem.typeID)[
          String(ATTRIBUTE_SCAN_DURATION_BONUS_MODULE)
        ],
      );
      if (Number.isFinite(bonus) && bonus !== 0) {
        moduleMultiplier *= (1 + (bonus / 100));
      }
    }
  }

  return multiplier * implantMultiplier * moduleMultiplier;
}

function resolveProbeScanDurationMs(session, options = {}) {
  const explicitDurationMs = normalizeNumber(options.durationMs, 0);
  if (explicitDurationMs > 0) {
    return Math.max(1, Math.round(explicitDurationMs));
  }

  const probeLauncher = resolveActiveProbeLauncherForSession(session);
  const baseDurationMs = Math.max(
    1,
    normalizeNumber(
      getTypeAttributeValueByID(probeLauncher && probeLauncher.typeID, ATTRIBUTE_SCAN_DURATION),
      probeScanRuntime.DEFAULT_PROBE_SCAN_DURATION_MS,
    ),
  );
  const durationMultiplier = resolveCharacterScanDurationBonusMultiplier(
    session && (session.characterID || session.charid || session.userid),
    { shipID: getSessionShipID(session) },
  );
  const resolvedDurationMs = baseDurationMs * (
    Number.isFinite(durationMultiplier) && durationMultiplier > 0
      ? durationMultiplier
      : 1
  );
  return Math.max(1, Math.round(resolvedDurationMs));
}

function resolveProbeRangeStepsByTypeID(typeID) {
  const numericTypeID = normalizeNumber(typeID, 0);
  if (numericTypeID <= 0) {
    return [];
  }

  const baseScanRange = toFiniteNumber(
    getTypeAttributeValueByID(numericTypeID, ATTRIBUTE_BASE_SCAN_RANGE),
    toFiniteNumber(getTypeAttributeValue(numericTypeID, "baseScanRange"), 0),
  );
  const rangeFactor = toFiniteNumber(
    getTypeAttributeValueByID(numericTypeID, ATTRIBUTE_RANGE_FACTOR),
    toFiniteNumber(getTypeAttributeValue(numericTypeID, "rangeFactor"), 0),
  );
  if (baseScanRange <= 0 || rangeFactor <= 0) {
    return [];
  }

  const steps = [];
  for (let index = 0; index < SCAN_PROBE_NUMBER_OF_RANGE_STEPS; index += 1) {
    steps.push(baseScanRange * (rangeFactor ** index) * AU_METERS);
  }
  return steps;
}

function ensureWormholeSignatureListenerRegistered() {
  if (wormholeSignatureListenerRegistered) {
    return;
  }
  wormholeRuntime.registerSignatureStateChangeListener(handleWormholeSignatureStateChange);
  wormholeSignatureListenerRegistered = true;
}

function handleStructureOverlayStateChange(change = {}) {
  const systemIDs = new Set();
  for (const systemID of Array.isArray(change && change.systemIDs) ? change.systemIDs : []) {
    const numericSystemID = normalizeNumber(systemID, 0);
    if (numericSystemID > 0) {
      systemIDs.add(numericSystemID);
    }
  }
  for (const systemID of systemIDs) {
    notifyStructureDeltaForSystem(systemID, { refresh: false });
  }
}

function ensureStructureOverlayListenerRegistered() {
  if (structureOverlayListenerRegistered) {
    return;
  }
  if (
    structureState &&
    typeof structureState.registerStructureChangeListener === "function"
  ) {
    structureState.registerStructureChangeListener(handleStructureOverlayStateChange);
  }
  structureOverlayListenerRegistered = true;
}

function getKwargValue(kwargs, key) {
  if (!kwargs) {
    return undefined;
  }

  if (kwargs.type === "dict" && Array.isArray(kwargs.entries)) {
    // String(entryKey) resolves a Buffer key only because Buffer.toString defaults to
    // utf8, and yields "[object Object]" for the {type, value} forms the decoder also
    // produces. See the note on accountService.extractKwarg.
    const match = kwargs.entries.find(
      ([entryKey]) => unwrapMarshalValue(entryKey) === String(key),
    );
    return match ? match[1] : undefined;
  }

  if (typeof kwargs === "object" && Object.prototype.hasOwnProperty.call(kwargs, key)) {
    return kwargs[key];
  }

  return undefined;
}

function buildBoundObjectSubstruct(serviceName, session) {
  const normalizedServiceName = String(serviceName || "").trim() || "scanMgr";
  if (!session._boundObjectIDs || typeof session._boundObjectIDs !== "object") {
    session._boundObjectIDs = {};
  }
  if (!session._boundObjectState || typeof session._boundObjectState !== "object") {
    session._boundObjectState = {};
  }

  const existingObjectState = session._boundObjectState[normalizedServiceName] || null;
  const objectID =
    existingObjectState && typeof existingObjectState.objectID === "string"
      ? existingObjectState.objectID
      : `N=${PROXY_NODE_ID}:${config.getNextBoundId()}`;
  const boundAtFileTime =
    existingObjectState && existingObjectState.boundAtFileTime
      ? existingObjectState.boundAtFileTime
      : currentFileTime();

  session._boundObjectIDs[normalizedServiceName] = objectID;
  session._boundObjectState[normalizedServiceName] = {
    objectID,
    boundAtFileTime,
  };
  session.lastBoundObjectID = objectID;

  return {
    type: "substruct",
    value: {
      type: "substream",
      value: [objectID, boundAtFileTime],
    },
  };
}

class ScanMgrService extends BaseService {
  constructor() {
    super("scanMgr");
    this.reuseBoundObjectForSession = true;
    ensureWormholeSignatureListenerRegistered();
    ensureStructureOverlayListenerRegistered();
  }

  _getCharacterID(session) {
    return normalizeNumber(
      session && (session.characterID || session.charid || session.userid),
      0,
    );
  }

  _getSystemID(session) {
    return normalizeNumber(
      session &&
        (
          (session._space && session._space.systemID) ||
          session.solarsystemid2 ||
          session.solarsystemid
        ),
      0,
    );
  }

  _ensureSystemParity(session, nowMs = Date.now()) {
    const systemID = this._getSystemID(session);
    void nowMs;
    return systemID;
  }

  _buildFullState(session, options = {}) {
    const systemID = this._ensureSystemParity(
      session,
      normalizeNumber(options.nowMs, Date.now()),
    );
    if (systemID <= 0) {
      return buildEmptySignalTrackerFullState();
    }

    return buildSignalTrackerFullStateForSession(session, systemID, options);
  }

  _rememberSignalTrackerRegistration(session) {
    const characterID = this._getCharacterID(session);
    const systemID = this._getSystemID(session);
    if (characterID <= 0 || systemID <= 0) {
      return false;
    }
    if (!canSignalTrackerSessionReceiveSystem(session, systemID)) {
      signalTrackerRegistrationsByCharacterID.delete(characterID);
      return false;
    }

    signalTrackerRegistrationsByCharacterID.set(characterID, {
      characterID,
      systemID,
      registeredAtMs: Date.now(),
      session,
    });
    return true;
  }

  Handle_MachoResolveObject() {
    return resolveBoundNodeId();
  }

  Handle_MachoBindObject(args, session, kwargs) {
    log.debug("[ScanMgr] MachoBindObject");
    return buildBoundObjectResponse(this, args, session, kwargs);
  }

  Handle_GetSystemScanMgr(args, session) {
    log.debug("[ScanMgr] GetSystemScanMgr");
    this._ensureSystemParity(session);
    return buildBoundObjectSubstruct(this.name, session);
  }

  Handle_SignalTrackerRegister(args, session) {
    log.debug("[ScanMgr] SignalTrackerRegister");
    const systemID = this._ensureSystemParity(session);
    if (systemID <= 0) {
      return null;
    }

    if (!this._rememberSignalTrackerRegistration(session)) {
      return null;
    }
    if (hasSignalTrackerSnapshots(systemID)) {
      const notificationSession = session;
      setImmediate(() => {
        if (
          canSignalTrackerSessionReceiveSystem(notificationSession, systemID)
        ) {
          notificationSession.sendNotification(
            "OnSignalTrackerFullState",
            "charid",
            // The receive check above already applied the Abyssal restriction.
            [systemID, buildCachedSignalTrackerFullState(systemID)],
          );
        }
      });
    }
    ensureSignalTrackerRefresh(systemID, this._getCharacterID(session));
    return null;
  }

  Handle_GetFullState(args, session) {
    log.debug("[ScanMgr] GetFullState");
    // A read, not a registration. The client calls this from the Agency and
    // while docked, and those callers must not start receiving overlay pushes.
    return this._buildFullState(session);
  }

  refreshSignalTrackerForSession(session, options = {}) {
    const systemID = this._ensureSystemParity(
      session,
      normalizeNumber(options.nowMs, Date.now()),
    );
    if (systemID <= 0) {
      return {
        success: false,
        errorMsg: "SYSTEM_NOT_AVAILABLE",
      };
    }
    if (!this._rememberSignalTrackerRegistration(session)) {
      return { success: false, errorMsg: "SYSTEM_NOT_AVAILABLE" };
    }
    return notifyFullStateRefreshForSystem(systemID, {
      ...options,
      shouldRemoveOldSites: options.shouldRemoveOldSites === true,
    });
  }

  Handle_SetProbeDestination(args, session) {
    log.debug("[ScanMgr] SetProbeDestination");
    const characterID = this._getCharacterID(session);
    const systemID = this._getSystemID(session);
    const probeID = normalizeNumber(args && args[0], 0);
    const destination = args && args.length > 1 ? args[1] : null;
    if (characterID <= 0 || systemID <= 0 || probeID <= 0 || !destination) {
      return null;
    }
    if (
      filterProbeIDsForSessionControl(session, characterID, [probeID]).length !== 1
    ) {
      return null;
    }

    const updated = probeRuntimeState.synchronizeCharacterProbeGeometry(
      characterID,
      systemID,
      new Map([
        [probeID, { destination }],
      ]),
      { nowMs: Date.now() },
    );
    if (updated.length > 0) {
      probeSceneRuntime.ensureProbeEntitiesForSession(session, updated, {
        systemID,
        ownerID: characterID,
      });
    }
    return null;
  }

  Handle_SetProbeRangeStep(args, session) {
    log.debug("[ScanMgr] SetProbeRangeStep");
    const characterID = this._getCharacterID(session);
    const systemID = this._getSystemID(session);
    const probeID = normalizeNumber(args && args[0], 0);
    const requestedRangeStep = normalizeNumber(args && args[1], 0);
    if (characterID <= 0 || systemID <= 0 || probeID <= 0 || requestedRangeStep <= 0) {
      return null;
    }
    if (
      filterProbeIDsForSessionControl(session, characterID, [probeID]).length !== 1
    ) {
      return null;
    }

    const persistedProbe = probeRuntimeState.getCharacterSystemProbes(characterID, systemID)
      .find((probe) => normalizeNumber(probe && probe.probeID, 0) === probeID);
    if (!persistedProbe) {
      return null;
    }

    const rangeSteps = resolveProbeRangeStepsByTypeID(persistedProbe.typeID);
    const clampedRangeStep = clamp(
      requestedRangeStep,
      1,
      Math.max(1, rangeSteps.length || SCAN_PROBE_NUMBER_OF_RANGE_STEPS),
    );
    const scanRange = toFiniteNumber(
      rangeSteps[clampedRangeStep - 1],
      toFiniteNumber(persistedProbe.scanRange, 0),
    );

    probeRuntimeState.synchronizeCharacterProbeGeometry(
      characterID,
      systemID,
      new Map([
        [probeID, {
          rangeStep: clampedRangeStep,
          scanRange,
        }],
      ]),
      { nowMs: Date.now() },
    );
    return null;
  }

  Handle_GetScanTargetID(args, session, kwargs) {
    const siteID = normalizeNumber(args && args[0], 0);
    const targetSeedID = normalizeNumber(
      getKwargValue(kwargs, "targetSeedID"),
      siteID,
    );
    return signatureRuntime.getScanTargetID(this._getSystemID(session), siteID, {
      targetSeedID,
    });
  }

  Handle_ConeScan(args, session) {
    log.debug("[ScanMgr] ConeScan");
    const abyssalRestriction = resolveAbyssalScannerRestriction(session, "dscan");
    if (abyssalRestriction && abyssalRestriction.blocked === true) {
      log.info(
        `[AbyssalMgr] Directional scan blocked inside Abyssal run char=${abyssalRestriction.characterID} ` +
          `ship=${abyssalRestriction.shipID} instance=${abyssalRestriction.instanceID}`,
      );
      throwCustomNotify(abyssalRestriction.message);
    }
    const runtime = getSpaceRuntime();
    const scene =
      runtime && typeof runtime.getSceneForSession === "function"
        ? runtime.getSceneForSession(session)
        : null;
    if (!scene) {
      return [];
    }

    const egoEntity =
      scene && typeof scene.getShipEntityForSession === "function"
        ? scene.getShipEntityForSession(session)
        : null;
    if (!egoEntity) {
      return [];
    }
    const systemID = this._getSystemID(session);
    const scanInhibitorCandidates =
      mobileScanInhibitorRuntime.collectScanInhibitorCandidates(systemID, {
        scene,
      });
    if (
      isDirectionalScanBlindedByScanInhibitor(
        systemID,
        egoEntity,
        scene,
        scanInhibitorCandidates,
      )
    ) {
      return [];
    }

    const requestedAngle = toFiniteNumber(args && args[0], DSCAN_FULL_SWEEP_RADIANS);
    const requestedRange = toFiniteNumber(
      args && args[1],
      DSCAN_FALLBACK_MAX_RANGE_METERS,
    );
    const coneDirection = normalizeVector({
      x: toFiniteNumber(args && args[2], 0),
      y: toFiniteNumber(args && args[3], 0),
      z: toFiniteNumber(args && args[4], 0),
    });
    if (!coneDirection) {
      return [];
    }

    const effectiveAngle = clamp(requestedAngle, 0, DSCAN_FULL_SWEEP_RADIANS);
    const maxRangeMeters = Math.max(
      DSCAN_MIN_RANGE_METERS,
      resolveEntityRangeCapMeters(egoEntity),
    );
    const effectiveRangeMeters = clamp(
      requestedRange,
      DSCAN_MIN_RANGE_METERS,
      maxRangeMeters,
    );
    const egoPosition = cloneVector(egoEntity.position);
    const egoRadius = Math.max(0, toFiniteNumber(egoEntity.radius, 0));
    const fullSweep =
      effectiveAngle >= (DSCAN_FULL_SWEEP_RADIANS - 0.0001);
    const halfAngleCosine = fullSweep
      ? -1
      : Math.cos(Math.max(0, effectiveAngle) / 2);

    return collectSceneEntities(scene)
      .filter((entity) => isEntityDirectionalScanCandidate(entity, egoEntity))
      .filter((entity) => canSessionDirectionalScanEntity(session, entity))
      .filter((entity) => canEntityDiscoverTarget(egoEntity, entity))
      .filter((entity) => !isDirectionalScanTargetHiddenByScanInhibitor(
        systemID,
        entity,
        scene,
        scanInhibitorCandidates,
      ))
      .map((entity) => {
        const vectorToTarget = subtractVectors(entity.position, egoPosition);
        const centerDistance = magnitude(vectorToTarget);
        const targetRadius = Math.max(0, toFiniteNumber(entity.radius, 0));
        const surfaceDistance = Math.max(
          0,
          centerDistance - egoRadius - targetRadius,
        );
        const directionToTarget = normalizeVector(vectorToTarget);
        return {
          entity,
          centerDistance,
          surfaceDistance,
          directionToTarget,
        };
      })
      .filter((entry) => entry.surfaceDistance <= effectiveRangeMeters)
      .filter((entry) => {
        if (fullSweep) {
          return true;
        }

        if (!entry.directionToTarget) {
          return entry.surfaceDistance <= 0;
        }

        return dotProduct(entry.directionToTarget, coneDirection) >= halfAngleCosine;
      })
      .sort((left, right) => {
        if (left.surfaceDistance !== right.surfaceDistance) {
          return left.surfaceDistance - right.surfaceDistance;
        }
        return normalizeNumber(left.entity && left.entity.itemID, 0) -
          normalizeNumber(right.entity && right.entity.itemID, 0);
      })
      .map((entry) => buildDirectionalScanResult(entry.entity));
  }

  Handle_RequestScans(args, session, kwargs) {
    log.debug("[ScanMgr] RequestScans");
    // Core and combat probe scanning remains available inside Abyssal
    // Deadspace. D-scan and the system scanner use separate restricted paths.
    const systemID = this._ensureSystemParity(session);
    const characterID = this._getCharacterID(session);
    if (
      systemID <= 0 ||
      characterID <= 0 ||
      !session ||
      typeof session.sendNotification !== "function"
    ) {
      return null;
    }

    const nowMs = Date.now();
    probeRuntimeState.removeInvalidCharacterProbes(characterID, {
      systemID,
      nowMs,
    });
    probeRuntimeState.removeExpiredCharacterProbes(characterID, {
      systemID,
      nowMs,
    });

    const requestedProbePatchMap = probeScanRuntime.normalizeProbePatchMap(args && args[0]);
    const controllableProbeIDs = new Set(filterProbeIDsForSessionControl(
      session,
      characterID,
      [...requestedProbePatchMap.keys()],
    ));
    const probePatchMap = new Map(
      [...requestedProbePatchMap.entries()].filter(([probeID]) => (
        controllableProbeIDs.has(normalizeNumber(probeID, 0))
      )),
    );
    const synchronizedProbes = probeRuntimeState.synchronizeCharacterProbeGeometry(
      characterID,
      systemID,
      probePatchMap,
      { nowMs },
    );
    const synchronizedProbeIDs = new Set(
      synchronizedProbes.map((probe) => normalizeNumber(probe && probe.probeID, 0)),
    );
    const normalizedProbeMap = probeScanRuntime.normalizeProbeMap(args && args[0]);
    const effectiveProbeMap = new Map(
      [...normalizedProbeMap.entries()].filter(([probeID]) => synchronizedProbeIDs.has(
        normalizeNumber(probeID, 0),
      )),
    );
    if (synchronizedProbes.length > 0) {
      probeSceneRuntime.ensureProbeEntitiesForSession(session, synchronizedProbes, {
        systemID,
        ownerID: characterID,
      });
    }

    const resolvedDurationMs = resolveProbeScanDurationMs(session, {
      durationMs: getKwargValue(kwargs, "_testingDurationMs"),
    });
    const startResolvedScan = () => {
      // Probe movement has settled by this point. Apply the 75 km pocket
      // boundary only to probes carrying the exact active run-and-room scope.
      retireOutOfBoundsAbyssalProbesForSession(
        session,
        characterID,
        systemID,
        effectiveProbeMap,
      );
      const scene =
        getSpaceRuntime() && typeof getSpaceRuntime().getSceneForSession === "function"
          ? getSpaceRuntime().getSceneForSession(session)
          : null;
      const egoEntity =
        scene && typeof scene.getShipEntityForSession === "function"
          ? scene.getShipEntityForSession(session)
          : null;
      const scanResult = isPositionInsideActiveScanInhibitor(
        systemID,
        egoEntity && egoEntity.position,
        scene,
      )
        ? buildScanInhibitorBlindedProbeScanResult(effectiveProbeMap, resolvedDurationMs)
        : probeScanRuntime.buildSignatureScanResults(
          systemID,
          effectiveProbeMap,
          {
            durationMs: resolvedDurationMs,
            scanBonuses: resolveCharacterProbeScanBonuses(characterID, {
              shipID: getSessionShipID(session),
              session,
              entity: egoEntity,
              nowMs:
                scene && typeof scene.getCurrentSimTimeMs === "function"
                  ? scene.getCurrentSimTimeMs()
                  : Date.now(),
            }),
            scene,
            characterID,
            shipID: getSessionShipID(session),
          },
        );
      // Perfect wormhole resolution is committed before the accepted scan is
      // announced. Repeating a scan after a lost response reuses its endpoint.
      let careerScan;
      try {
        careerScan = require("../career/careerExplorationSources").recordResolvedWormholes(
          characterID, systemID, scanResult.perfectSignatureIDs || [], { scene },
        );
      } catch (error) { careerScan = { success: false, errorMsg: error.message }; }
      if (!careerScan?.success) {
        log.warn(`[ScanMgr] career scan awaits retry: ${careerScan?.errorMsg}`);
        // Native cancellation clears the client's scanning state while keeping
        // old results; it does not advertise a new successful resolution.
        session.sendNotification("OnSystemScanStopped", "charid", [scanResult.probeIDs || [], null, null]);
        return;
      }
      emitProbeScanLifecycleNotifications(session, scanResult, {
        startedAtFileTime: currentFileTime(),
        durationMs: scanResult.durationMs,
        immediateStop: resolvedDurationMs <= 1,
        scheduleFn: getKwargValue(kwargs, "_testingSetTimeout"),
        clearFn: getKwargValue(kwargs, "_testingClearTimeout"),
      });
      // Advance the "Scan N Signatures" AIR daily goal for each cosmic signature
      // resolved to 100% signal strength. De-duplicated by signature ID so
      // re-scans of an already-resolved signature don't re-credit. Defensive so
      // daily-goal bookkeeping can never disrupt scanning.
      const perfectSignatureIDs = Array.isArray(scanResult && scanResult.perfectSignatureIDs)
        ? scanResult.perfectSignatureIDs
        : [];
      if (perfectSignatureIDs.length > 0) {
        try {
          const dailyGoalsState = require(path.join(
            __dirname,
            "../../services/dailyGoals/dailyGoalsState",
          ));
          for (const signatureID of perfectSignatureIDs) {
            dailyGoalsState.recordUniqueActivity(characterID, "scan_signature", signatureID);
          }
        } catch (dailyGoalError) {
          log.debug(
            `[ScanMgr] daily-goal scan_signature hook failed char=${characterID}: ${dailyGoalError.message}`,
          );
        }
        try {
          const achievementRuntime = require(path.join(
            __dirname,
            "../achievement/achievementRuntime",
          ));
          for (const signatureID of perfectSignatureIDs) {
            achievementRuntime.recordSignatureResolution(
              characterID,
              signatureID,
              systemID,
            );
          }
        } catch (achievementError) {
          log.debug(
            `[ScanMgr] achievement signature hook failed char=${characterID}: ${achievementError.message}`,
          );
        }
      }
    };

    scheduleProbeMovementThenScan(
      session,
      synchronizedProbes,
      startResolvedScan,
      {
        moveDurationMs: getKwargValue(kwargs, "_testingMoveDurationMs"),
        scheduleFn: getKwargValue(kwargs, "_testingSetTimeout"),
        clearFn: getKwargValue(kwargs, "_testingClearTimeout"),
        onArrive: () => {
          const arrivedProbes = probeRuntimeState.synchronizeCharacterProbeGeometry(
            characterID,
            systemID,
            new Map(
              synchronizedProbes.map((probe) => [
                normalizeNumber(probe && probe.probeID, 0),
                {
                  pos: Array.isArray(probe && probe.destination) ? probe.destination : probe.pos,
                  destination: Array.isArray(probe && probe.destination) ? probe.destination : probe.pos,
                },
              ]),
            ),
            { nowMs: Date.now() },
          );
          if (arrivedProbes.length > 0) {
            probeSceneRuntime.ensureProbeEntitiesForSession(session, arrivedProbes, {
              systemID,
              ownerID: characterID,
            });
          }
        },
      },
    );
    return null;
  }

  Handle_ReconnectToLostProbes(args, session) {
    log.debug("[ScanMgr] ReconnectToLostProbes");
    const characterID = this._getCharacterID(session);
    const systemID = this._getSystemID(session);
    if (characterID <= 0 || systemID <= 0) {
      return null;
    }

    probeRuntimeState.removeInvalidCharacterProbes(characterID, {
      systemID,
      nowMs: Date.now(),
    });
    probeRuntimeState.removeExpiredCharacterProbes(characterID, {
      systemID,
      nowMs: Date.now(),
    });

    const probes = filterProbeRecordsForSessionControl(
      session,
      probeRuntimeState.getReconnectableCharacterProbes(
        characterID,
        systemID,
      ),
    );
    scheduleProbeReplayNotifications(session, probes);
    return null;
  }

  Handle_DestroyProbe(args, session) {
    log.debug("[ScanMgr] DestroyProbe");
    const characterID = this._getCharacterID(session);
    const probeID = normalizeNumber(args && args[0], 0);
    if (characterID <= 0 || probeID <= 0) {
      return null;
    }

    const controllableProbeIDs = filterProbeIDsForSessionControl(
      session,
      characterID,
      [probeID],
    );
    if (controllableProbeIDs.length <= 0) {
      return null;
    }
    probeRuntimeState.removeCharacterProbes(characterID, controllableProbeIDs, {
      nowMs: Date.now(),
    });
    probeSceneRuntime.removeProbeEntitiesForSession(session, controllableProbeIDs);
    return null;
  }

  Handle_RecoverProbes(args, session) {
    log.debug("[ScanMgr] RecoverProbes");
    const characterID = this._getCharacterID(session);
    const shipID = normalizeNumber(
      (session && (session.shipID || session.shipid || session.activeShipID)) ||
      (session && session._space && session._space.shipID) ||
      0,
      0,
    );
    const probeIDs = extractProbeIDList(args);
    if (characterID <= 0 || probeIDs.length <= 0) {
      return [];
    }

    const controllableProbeIDs = filterProbeIDsForSessionControl(
      session,
      characterID,
      probeIDs,
    );
    const removedProbes = probeRuntimeState.removeCharacterProbes(
      characterID,
      controllableProbeIDs,
      { nowMs: Date.now() },
    );
    restoreRecoveredProbeCharges(session, characterID, removedProbes, {
      shipID,
    });
    const removedProbeIDs = removedProbes.map((probe) => normalizeNumber(probe.probeID, 0));
    scheduleProbeRemovalNotifications(session, removedProbeIDs);
    return removedProbeIDs;
  }

  Handle_SetActivityState(args, session) {
    log.debug("[ScanMgr] SetActivityState");
    const characterID = this._getCharacterID(session);
    const probeIDs = extractProbeIDList(args && args[0]);
    const active = args && args.length > 1 ? args[1] === true : false;
    if (characterID <= 0 || probeIDs.length <= 0) {
      return null;
    }

    const controllableProbeIDs = filterProbeIDsForSessionControl(
      session,
      characterID,
      probeIDs,
    );
    probeRuntimeState.setCharacterProbeActivity(characterID, controllableProbeIDs, active, {
      nowMs: Date.now(),
    });
    return null;
  }

  Handle_QAOverrideProbeExpiry(args, session) {
    log.debug("[ScanMgr] QAOverrideProbeExpiry");
    const characterID = this._getCharacterID(session);
    const systemID = this._getSystemID(session);
    const duration = normalizeNumber(args && args[0], 0);
    if (characterID <= 0 || systemID <= 0 || duration < 0) {
      return null;
    }
    probeRuntimeState.overrideCharacterProbeExpiry(characterID, duration / 1000, {
      systemID,
    });
    return null;
  }

  Handle_QAScanSites(args, session) {
    log.debug("[ScanMgr] QAScanSites");
    const systemID = this._ensureSystemParity(session);
    if (systemID <= 0) {
      return [];
    }

    const requestedSiteKeys = new Set(
      (Array.isArray(args) ? args : [])
        .flatMap((value) => Array.isArray(value) ? value : [value])
        .map((value) => unwrapMarshalValue(value))
        .flatMap((value) => {
          const numericValue = normalizeNumber(value, 0);
          const stringValue = String(value || "").trim().toUpperCase();
          const keys = [];
          if (numericValue > 0) {
            keys.push(String(numericValue));
          }
          if (stringValue) {
            keys.push(stringValue);
          }
          return keys;
        }),
    );
    const scanResult = probeScanRuntime.buildResolvedSignatureScanResults(systemID, {
      nowMs: Date.now(),
      durationMs: 1,
    });
    const results = Array.isArray(scanResult.results) ? scanResult.results : [];
    if (requestedSiteKeys.size <= 0) {
      return results;
    }
    const signatureSitesByResultID = new Map(
      signatureRuntime.listSystemSignatureSites(systemID, { allowTemplateDiscovery: false }).map((site) => [
        String(probeScanRuntime.resolveResultID(site)).trim().toUpperCase(),
        String(normalizeNumber(site && site.siteID, 0)),
      ]),
    );
    return results.filter((entry) => {
      const resolved = marshalObjectToObject(entry);
      const resultID = String(resolved && resolved.id || "").trim().toUpperCase();
      const numericSiteID = signatureSitesByResultID.get(resultID) || "";
      return requestedSiteKeys.has(resultID) || (numericSiteID && requestedSiteKeys.has(numericSiteID));
    });
  }

  resolveAllSystemSignaturesForSession(session, options = {}) {
    const systemID = this._ensureSystemParity(
      session,
      normalizeNumber(options.nowMs, Date.now()),
    );
    if (
      systemID <= 0 ||
      !session ||
      typeof session.sendNotification !== "function"
    ) {
      return {
        success: false,
        errorMsg: "SYSTEM_NOT_AVAILABLE",
      };
    }

    if (options.refreshSignalTracker === true) {
      const refreshResult = this.refreshSignalTrackerForSession(session, {
        ...options,
        shouldRemoveOldSites: options.shouldRemoveOldSites !== false,
      });
      if (!refreshResult.success) {
        return refreshResult;
      }
    }

    const scanResult = probeScanRuntime.buildResolvedSignatureScanResults(
      systemID,
      {
        nowMs: normalizeNumber(options.nowMs, Date.now()),
        durationMs: normalizeNumber(options.durationMs, 1),
        allowTemplateDiscovery: false,
      },
    );
    emitProbeScanLifecycleNotifications(session, scanResult, {
      startedAtFileTime: currentFileTime(),
      durationMs: scanResult.durationMs,
      immediateStop: true,
    });

    return {
      success: true,
      data: {
        systemID,
        signatureCount: scanResult.results.length,
      },
    };
  }
}

ScanMgrService._testing = {
  clearSignalTrackerState() {
    signalTrackerRefreshBySystemID.clear();
    signalTrackerRegistrationsByCharacterID.clear();
    anomalySnapshotBySystemID.clear();
    signatureSnapshotBySystemID.clear();
    staticSiteSnapshotBySystemID.clear();
    structureSnapshotBySystemID.clear();
    probeRuntimeState.clearRuntimeCache();
  },
  waitForSignalTrackerRefresh(systemID) {
    const refresh = signalTrackerRefreshBySystemID.get(normalizeNumber(systemID, 0));
    return refresh ? refresh.promise : Promise.resolve();
  },
  getCachedSignalTrackerFullState(systemID) {
    return buildCachedSignalTrackerFullState(normalizeNumber(systemID, 0));
  },
  notifyAnomalyDeltaForSystem,
  notifyFullStateRefreshForSystem,
  notifySignatureDeltaForSystem,
  ensureStaticSiteSnapshot,
  notifyStructureDeltaForSystem,
  getRegisteredSessionsForSystem,
  canSignalTrackerSessionReceiveSystem,
  clearPendingProbeScanStop,
  resolveCharacterProbeScanBonuses,
  resolveProbeScanDurationMs,
  buildSignalTrackerFullStateForSession,
  resolveAbyssalScannerRestriction,
  resolveSessionProbeControlAuthority,
  retireOutOfBoundsAbyssalProbesForSession,
  isEntityDirectionalScanCandidate,
  canSessionDirectionalScanEntity,
  getAbyssalRuntimeInstanceIDFromSession,
  getAbyssalRuntimeInstanceIDFromEntity,
};

ScanMgrService.notifyAnomalyDeltaForSystem = notifyAnomalyDeltaForSystem;
ScanMgrService.notifySignatureDeltaForSystem = notifySignatureDeltaForSystem;
ScanMgrService.notifyStructureDeltaForSystem = notifyStructureDeltaForSystem;

module.exports = ScanMgrService;
