"use strict";

module.exports = {
  buildRuntimeInventoryEntity,
  buildRuntimeSpaceEntityFromItem,
  getRuntimeInventoryEntityKind,
  getStructureUnanchorArtifactStructureID,
  hydrateCargoContainerAnchorPresentationFields,
  hydrateForceFieldEntityFromInventoryItem,
  hydrateStarbaseEntityFromInventoryItem,
  isDirectSystemSpaceInventoryItem,
  isInventoryBackedDynamicEntity,
  isInventoryItemEligibleForSceneSpawn,
  isInventoryWreckMarkedSalvaged,
  isNativeNpcWreckDynamicEntity,
  refreshInventoryBackedEntityPresentationFields,
  resolveRuntimeInventoryEntityRadius,
  resolveRuntimeInventoryEntitySignatureRadius,
  shouldDeferStructureUnanchorArtifactPresentation,
  spawnDeferredStructureLootEntities,
};

const runtimeEntryDirname = require("path").resolve(__dirname, "..");
const path = require("path");
const starbaseDefenseRuntime = require("../../services/starbase/starbaseDefenseRuntime");
const log = require(path.join(runtimeEntryDirname, "../utils/logger"));
const {
  CAPSULE_TYPE_ID,
  CAPSULE_TYPE_ID_GOLDEN,
  ITEM_FLAGS,
  updateShipItem,
  updateInventoryItem,
  removeInventoryItem,
  getShipConditionState,
  normalizeShipConditionState,
  getItemMetadata,
  pruneExpiredSpaceItems,
} = require(path.join(runtimeEntryDirname, "../services/inventory/itemStore"));
const {
  findItemById,
  findShipItemById,
  listContainerItems,
  listSystemSpaceItems,
  warmSimulationInventoryProjection,
} = require(path.join(
  runtimeEntryDirname,
  "../services/inventory/simulationInventoryProjection",
));
const {
  resolveRuntimeWreckRadius,
  resolveRuntimeWreckStructureFallbackHP,
} = require(path.join(runtimeEntryDirname, "../services/inventory/wreckRadius"));
const planetOrbitalState = require(path.join(runtimeEntryDirname, "../services/planet/planetOrbitalState"));
const deployableCynoRuntime = require(path.join(runtimeEntryDirname, "../services/ship/deployableCynoRuntime"));
const mobileAnalysisBeaconRuntime = require(path.join(runtimeEntryDirname, "../services/ship/mobileAnalysisBeaconRuntime"));
const mobileCynoInhibitorRuntime = require(path.join(runtimeEntryDirname, "../services/ship/mobileCynoInhibitorRuntime"));
const mobileDepotRuntime = require(path.join(runtimeEntryDirname, "../services/ship/mobileDepotRuntime"));
const mobileMicroJumpUnitRuntime = require(path.join(runtimeEntryDirname, "../services/ship/mobileMicroJumpUnitRuntime"));
const mobileObservatoryRuntime = require(path.join(runtimeEntryDirname, "../services/ship/mobileObservatoryRuntime"));
const mobilePhaseAnchorRuntime = require(path.join(runtimeEntryDirname, "../services/ship/mobilePhaseAnchorRuntime"));
const mobileScanInhibitorRuntime = require(path.join(runtimeEntryDirname, "../services/ship/mobileScanInhibitorRuntime"));
const mobileSiphonUnitRuntime = require(path.join(runtimeEntryDirname, "../services/ship/mobileSiphonUnitRuntime"));
const mobileTractorUnitRuntime = require(path.join(runtimeEntryDirname, "../services/ship/mobileTractorUnitRuntime"));
const mobileWarpDisruptorRuntime = require(path.join(runtimeEntryDirname, "../services/ship/mobileWarpDisruptorRuntime"));
const interdictionProbeRuntime = require(path.join(runtimeEntryDirname, "../services/ship/interdictionProbeRuntime"));
const surveyProbeRuntime = require(path.join(
  runtimeEntryDirname,
  "../services/exploration/probes/surveyProbeRuntime",
));
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
const structureState = require(path.join(
  runtimeEntryDirname,
  "../services/structure/structureState",
));
const {
  hydrateAbyssalPocketMarkerEntityFromInventoryItem,
  hydrateAbyssalRuntimeArtifactEntityFromInventoryItem,
  hydrateAbyssalTraceEntityFromInventoryItem,
  shouldHydrateInventoryItemIntoScene,
} = require("./abyssalRoomEntity");
const {
  applyRuntimeEntityScopeMetadata,
} = require("./entityScopeTags");
const {
  parseInventoryCustomInfo,
} = require("./inventoryCustomInfo");
const {
  applyInventoryLootInfoToEntity,
  isInventoryLootAbandoned,
} = require("./inventoryLootRights");
const {
  clamp,
  toFiniteNumber,
  toInt,
} = require("../../common/numbers");
const {
  allocateRuntimeEntityID,
} = require("./runtimeEntityIdentity");
const {
  SCENE_KIND_ABYSSAL,
} = require("./sceneIdentity");
const {
  buildRuntimePersistedSpaceShipEntity,
} = require("./shipEntity");
const {
  normalizeMode,
} = require("./shipMotionKinematics");
const {
  getDroneCategoryID,
  getFighterCategoryID,
  hydrateDroneEntityFromInventoryItem,
  hydrateFighterEntityFromInventoryItem,
} = require("./squadronRuntimeBridge");
const {
  coerceDunRotationTuple,
} = require("./staticSceneEntity");
const {
  DEFAULT_RIGHT,
  buildPerpendicular,
  cloneVector,
  normalizeVector,
} = require("../../common/vector");
const abyssalRoomEntityModule = require("./abyssalRoomEntity");

const CATEGORY_STARBASE = 23;

const CATEGORY_STRUCTURE = 65;

const GROUP_BIOMASS = 14;

const GROUP_CONTROL_TOWER = 365;

const RUNTIME_CORPSE_KIND = "corpse";

const RUNTIME_STARBASE_KIND = "starbase";

const STARBASE_ANCHOR_STATE = Object.freeze({
  UNANCHORED: "unanchored",
  ANCHORING: "anchoring",
  ANCHORED: "anchored",
  UNANCHORING: "unanchoring",
});

const RUNTIME_UNANCHORED_STRUCTURE_HULL_KIND = "unanchoredStructureHull";

const STRUCTURE_UNANCHOR_HULL_MARKER_PATTERN =
  /^evejs:structure-unanchor:hull:(\d+)$/;

const STRUCTURE_UNANCHOR_FITTINGS_MARKER_PATTERN =
  /^evejs:structure-unanchor:fittings:(\d+)(?::core-complete)?$/;

const STRUCTURE_UNANCHOR_ASSETS_MARKER_PATTERN =
  /^evejs:structure-unanchor:assets:(\d+):owner:\d+$/;

const STRUCTURE_UNANCHOR_OFFICE_MARKER_PATTERN =
  /^evejs:structure-unanchor:office:(\d+):office:\d+$/;

function isInventoryBackedDynamicEntity(entity) {
  return Boolean(
    entity &&
    entity.nativeNpcWreck !== true &&
    (
      entity.kind === "container" ||
      entity.kind === "skyhookSilo" ||
      entity.kind === RUNTIME_UNANCHORED_STRUCTURE_HULL_KIND ||
      entity.kind === RUNTIME_CORPSE_KIND ||
      entity.kind === "wreck" ||
      entity.kind === "drone" ||
      entity.kind === "fighter" ||
      entity.kind === "orbital" ||
      entity.kind === "forceField" ||
      entity.kind === RUNTIME_STARBASE_KIND ||
      (
        entity.kind === "probe" &&
        (
          interdictionProbeRuntime.isWarpDisruptionProbeType(entity) ||
          surveyProbeRuntime.isSurveyProbeType(entity)
        )
      ) ||
      entity.kind === "deployable"
    ),
  );
}

function isNativeNpcWreckDynamicEntity(entity) {
  return Boolean(
    entity &&
    entity.nativeNpcWreck === true &&
    (entity.kind === "container" || entity.kind === "wreck"),
  );
}

function hydrateCargoContainerAnchorPresentationFields(
  entity,
  itemRecord,
  nowMs = Date.now(),
) {
  if (!entity || entity.kind !== "container" || !itemRecord) {
    return entity;
  }

  // Lazy import avoids the cargo runtime -> space runtime module-load cycle.
  const cargoContainerRuntime = require(path.join(
    runtimeEntryDirname,
    "../services/ship/cargoContainerRuntime",
  ));
  if (!cargoContainerRuntime.isCargoContainerType(itemRecord)) {
    return entity;
  }
  const lifecycleReconciliation =
    cargoContainerRuntime.reconcileCargoContainerLifecycleExpiry(
      itemRecord.itemID,
      {
        nowMs,
        refreshPresentation: false,
      },
    );
  const resolvedItem =
    lifecycleReconciliation.success && lifecycleReconciliation.data
      ? lifecycleReconciliation.data
      : itemRecord;
  entity.expiresAtMs = toFiniteNumber(resolvedItem.expiresAtMs, 0) || null;
  if (!cargoContainerRuntime.isAnchorableSecureContainerType(resolvedItem)) {
    return entity;
  }

  const reconciliation =
    cargoContainerRuntime.reconcileSecureContainerAnchorState(
      resolvedItem.itemID,
      {
        nowMs,
        schedule: true,
        refreshPresentation: false,
      },
    );
  const resolvedAnchorItem = reconciliation.success && reconciliation.data
    ? reconciliation.data
    : resolvedItem;
  entity.expiresAtMs =
    toFiniteNumber(resolvedAnchorItem.expiresAtMs, 0) || null;
  const state = cargoContainerRuntime.getSecureContainerState(resolvedAnchorItem);
  entity.cargoContainerAnchorable = true;
  entity.anchorState = state.anchorState;
  entity.anchorStartedAtMs = state.anchorStartedAtMs;
  entity.anchorCompletesAtMs = state.anchorCompletesAtMs;
  entity.isAnchored = Boolean(state.anchored);
  entity.destinyForceFree = !state.anchored;
  entity.isFree = !state.anchored;
  if (state.anchored) {
    entity.velocity = { x: 0, y: 0, z: 0 };
    entity.targetPoint = cloneVector(entity.position);
    entity.mode = "STOP";
    entity.speedFraction = 0;
  }
  return entity;
}

function refreshInventoryBackedEntityPresentationFields(entity, itemRecordOverride = null) {
  if (!isInventoryBackedDynamicEntity(entity)) {
    return entity;
  }

  const itemRecord = itemRecordOverride || findItemById(entity.itemID) || null;
  if (!itemRecord) {
    return entity;
  }

  const metadata = getItemMetadata(itemRecord.typeID, itemRecord.itemName);
  const resolvedRadius = resolveRuntimeInventoryEntityRadius(
    entity.kind,
    itemRecord,
    metadata,
    toFiniteNumber(entity.radius, 1),
  );
  entity.ownerID = toInt(itemRecord.ownerID, toInt(entity.ownerID, 0));
  entity.itemName = String(itemRecord.itemName || metadata.name || entity.itemName || "Container");
  entity.typeID = toInt(itemRecord.typeID, entity.typeID);
  entity.groupID = toInt(itemRecord.groupID, entity.groupID);
  entity.categoryID = toInt(itemRecord.categoryID, entity.categoryID);
  entity.graphicID = toInt(metadata && metadata.graphicID, 0) || null;
  entity.radius = resolvedRadius;
  entity.signatureRadius = resolveRuntimeInventoryEntitySignatureRadius(
    itemRecord,
    metadata,
    resolvedRadius,
  );
  entity.spaceState = itemRecord.spaceState || entity.spaceState || null;
  if (entity.kind === "forceField") {
    hydrateForceFieldEntityFromInventoryItem(entity, itemRecord);
  }
  if (entity.kind === RUNTIME_STARBASE_KIND) {
    hydrateStarbaseEntityFromInventoryItem(entity, itemRecord);
  }
  entity.conditionState = normalizeShipConditionState(itemRecord.conditionState);
  entity.createdAtMs = toFiniteNumber(itemRecord.createdAtMs, 0) || null;
  entity.expiresAtMs = toFiniteNumber(itemRecord.expiresAtMs, 0) || null;
  entity.isEmpty = listContainerItems(null, entity.itemID).length === 0;
  applyInventoryLootInfoToEntity(entity, itemRecord);
  hydrateCargoContainerAnchorPresentationFields(entity, itemRecord);
  if (entity.kind === "drone") {
    hydrateDroneEntityFromInventoryItem(entity, itemRecord);
  }
  if (entity.kind === "fighter") {
    // How a fighter in the scene moves is not presentation.
    hydrateFighterEntityFromInventoryItem(entity, itemRecord, { keepMotion: true });
  }
  if (entity.kind === "orbital") {
    planetOrbitalState.hydrateOrbitalEntityFromInventoryItem(entity, itemRecord, {
      solarSystemID: entity.systemID,
    });
  }
  if (entity.kind === "probe") {
    interdictionProbeRuntime.hydrateInterdictionProbeEntityFromInventoryItem(entity, itemRecord);
    surveyProbeRuntime.hydrateSurveyProbeEntityFromInventoryItem(entity, itemRecord);
  }
  if (entity.kind === "deployable") {
    hydrateAbyssalTraceEntityFromInventoryItem(entity, itemRecord);
    deployableCynoRuntime.hydrateMobileCynoDeployableEntityFromInventoryItem(entity, itemRecord);
    mobileDepotRuntime.hydrateMobileDepotEntityFromInventoryItem(entity, itemRecord);
    mobileAnalysisBeaconRuntime.hydrateMobileAnalysisBeaconEntityFromInventoryItem(entity, itemRecord);
    mobileCynoInhibitorRuntime.hydrateMobileCynoInhibitorEntityFromInventoryItem(entity, itemRecord);
    mobileMicroJumpUnitRuntime.hydrateMobileMicroJumpUnitEntityFromInventoryItem(entity, itemRecord);
    mobilePhaseAnchorRuntime.hydrateMobilePhaseAnchorEntityFromInventoryItem(entity, itemRecord);
    mobileScanInhibitorRuntime.hydrateMobileScanInhibitorEntityFromInventoryItem(entity, itemRecord);
    mobileSiphonUnitRuntime.hydrateMobileSiphonUnitEntityFromInventoryItem(entity, itemRecord);
    mobileTractorUnitRuntime.hydrateMobileTractorUnitEntityFromInventoryItem(entity, itemRecord);
    mobileWarpDisruptorRuntime.hydrateMobileWarpDisruptorEntityFromInventoryItem(entity, itemRecord);
    hydrateAbyssalPocketMarkerEntityFromInventoryItem(entity, itemRecord);
  }
  hydrateAbyssalRuntimeArtifactEntityFromInventoryItem(entity, itemRecord);
  return entity;
}

function isInventoryWreckMarkedSalvaged(item) {
  const parsed = parseInventoryCustomInfo(item);
  return Boolean(parsed && parsed.evejsSalvage && parsed.evejsSalvage.salvaged);
}

function getRuntimeInventoryEntityKind(item) {
  const TYPE_ABYSSAL_BIOCOMBINATIVE_CACHE = abyssalRoomEntityModule.TYPE_ABYSSAL_BIOCOMBINATIVE_CACHE;
  const TYPE_ABYSSAL_EXTRACTION_NODE = abyssalRoomEntityModule.TYPE_ABYSSAL_EXTRACTION_NODE;
  const TYPE_ABYSSAL_EXTRACTION_SUBNODE = abyssalRoomEntityModule.TYPE_ABYSSAL_EXTRACTION_SUBNODE;
  const TYPE_CAPTURED_TRIGLAVIAN_BIOADAPTIVE_CACHE = abyssalRoomEntityModule.TYPE_CAPTURED_TRIGLAVIAN_BIOADAPTIVE_CACHE;
  const getInventoryAbyssalPocketMarkerInfo = abyssalRoomEntityModule.getInventoryAbyssalPocketMarkerInfo;
  const getInventoryAbyssalRuntimeArtifactInfo = abyssalRoomEntityModule.getInventoryAbyssalRuntimeArtifactInfo;
  const isInventoryAbyssalTrace = abyssalRoomEntityModule.isInventoryAbyssalTrace;
  if (!item) {
    return null;
  }
  if (Number(item.typeID) === 81933) {
    return parseInventoryCustomInfo(item)?.evejsSkyhookSilo ? "skyhookSilo" : null;
  }
  if (
    Number(item.typeID) === 83590 &&
    item.spaceState?.dungeonSiteContentRole === "homefront" &&
    item.spaceState?.dungeonSiteContentAnalyzer === "data" &&
    Number(item.spaceState.dungeonSiteInstanceID) > 0
  )
    return "container";

  const metadata = getItemMetadata(item.typeID, item.itemName);
  const unanchorHullMarker = STRUCTURE_UNANCHOR_HULL_MARKER_PATTERN.exec(
    String(item.customInfo || ""),
  );
  const unanchorHullStructureID = toInt(
    unanchorHullMarker && unanchorHullMarker[1],
    0,
  );
  if (
    unanchorHullMarker &&
    unanchorHullStructureID > 0 &&
    toInt(item.typeID, 0) > 0 &&
    toInt(item.categoryID, 0) === CATEGORY_STRUCTURE &&
    toInt(item.singleton, 0) === 1 &&
    toInt(item.launcherID, 0) === unanchorHullStructureID
  ) {
    // A completed Upwell unanchor leaves the packaged structure hull as a
    // scoopable inventory item in space. Keep it inventory-backed, but do not
    // inherit generic container loot, abandon, or tractor behavior.
    return RUNTIME_UNANCHORED_STRUCTURE_HULL_KIND;
  }
  if (toInt(item.categoryID, 0) === getDroneCategoryID()) {
    return "drone";
  }
  if (toInt(item.categoryID, 0) === getFighterCategoryID()) {
    return "fighter";
  }
  if (toInt(item.categoryID, 0) === planetOrbitalState.CATEGORY_ORBITAL) {
    return "orbital";
  }
  if (interdictionProbeRuntime.isWarpDisruptionProbeType(item)) {
    return "probe";
  }
  if (surveyProbeRuntime.isSurveyProbeType(item)) {
    return "probe";
  }
  if (
    toInt(item.categoryID, 0) === deployableCynoRuntime.CATEGORY_DEPLOYABLE ||
    toInt(metadata && metadata.categoryID, 0) === deployableCynoRuntime.CATEGORY_DEPLOYABLE
  ) {
    return "deployable";
  }
  const groupName = String(metadata && metadata.groupName || "").trim().toLowerCase();
  const groupID = toInt(item.groupID, toInt(metadata && metadata.groupID, 0));
  const categoryID = toInt(
    item.categoryID,
    toInt(metadata && metadata.categoryID, 0),
  );
  if (categoryID === CATEGORY_STARBASE && groupID === GROUP_CONTROL_TOWER) {
    return RUNTIME_STARBASE_KIND;
  }
  if (groupID === 411 || groupName === "force field") {
    return "forceField";
  }
  if (categoryID === CATEGORY_STARBASE) {
    return RUNTIME_STARBASE_KIND;
  }
  if (groupID === GROUP_BIOMASS || groupName === "biomass") {
  // Podded pilots leave a corpse. The client scoops it straight to the cargo
  // hold instead of opening it, so it never becomes a loot container.
  return RUNTIME_CORPSE_KIND;
  }
  if (getInventoryAbyssalPocketMarkerInfo(item)) {
    return "deployable";
  }
  if (isInventoryAbyssalTrace(item)) {
    return "deployable";
  }
  const abyssalArtifactInfo = getInventoryAbyssalRuntimeArtifactInfo(item);
  if (
    abyssalArtifactInfo &&
    abyssalArtifactInfo.kind === "environmental_object"
  ) {
    return "deployable";
  }
  if (
    abyssalArtifactInfo &&
    (
      toInt(item && item.typeID, 0) === TYPE_ABYSSAL_BIOCOMBINATIVE_CACHE ||
      toInt(item && item.typeID, 0) ===
        TYPE_CAPTURED_TRIGLAVIAN_BIOADAPTIVE_CACHE ||
      toInt(item && item.typeID, 0) === TYPE_ABYSSAL_EXTRACTION_SUBNODE ||
      toInt(item && item.typeID, 0) === TYPE_ABYSSAL_EXTRACTION_NODE
    )
  ) {
    return "deployable";
  }
  if (groupName === "wreck") {
    if (isInventoryWreckMarkedSalvaged(item)) {
      return "container";
    }
    return "wreck";
  }
  if (
    groupName.includes("container") ||
    groupName === "spawn container"
  ) {
    return "container";
  }
  return null;
}

function hydrateStarbaseEntityFromInventoryItem(entity, item) {
  if (!entity || !item) {
    return entity;
  }
  const persistedSpaceState = item.spaceState || {};
  if (
    persistedSpaceState.position &&
    [
      persistedSpaceState.position.x,
      persistedSpaceState.position.y,
      persistedSpaceState.position.z,
    ].every((value) => Number.isFinite(Number(value)))
  ) {
    entity.position = cloneVector(persistedSpaceState.position, entity.position);
    entity.targetPoint = cloneVector(
      persistedSpaceState.targetPoint,
      persistedSpaceState.position,
    );
    entity.velocity = cloneVector(
      persistedSpaceState.velocity,
      { x: 0, y: 0, z: 0 },
    );
  }
  const controlTowerRuntime = require(path.join(
    runtimeEntryDirname,
    "../services/ship/controlTowerRuntime",
  ));
  if (!controlTowerRuntime.isControlTowerType(item)) {
    const moduleRuntime = require(path.join(
      runtimeEntryDirname,
      "../services/starbase/starbaseModuleRuntime",
    ));
    const reconciliation = moduleRuntime.reconcileStarbaseModule(item.itemID, {
      nowMs: Date.now(),
      schedule: true,
      refreshPresentation: false,
    });
    const resolved = reconciliation.success && reconciliation.data
      ? reconciliation.data
      : item;
    const state = moduleRuntime.getState(resolved);
    entity.spaceState = { ...resolved.spaceState };
    const presentation = controlTowerRuntime.getControlTowerPresentationState(
      resolved,
    );
    entity.corporationID = toInt(
      resolved.spaceState && resolved.spaceState.corporationID,
      toInt(resolved.ownerID, 0),
    );
    entity.controlTowerID = state.controlTowerID || null;
    entity.starbaseModuleState = {
      ...(state.moduleSpecificState || {}),
    };
    entity.anchorState = state.anchorState;
    entity.isAnchored = state.isAnchored;
    entity.anchorStartedAtMs = state.anchorStartedAtMs;
    entity.anchorCompletesAtMs = state.anchorCompletesAtMs;
    entity.onlineState = state.onlineState;
    entity.onlineStartedAtMs = state.onlineStartedAtMs;
    entity.onlineCompletesAtMs = state.onlineCompletesAtMs;
    entity.online = state.isOnline ? 1 : 0;
    entity.incapacitated = state.health.incapacitated ? 1 : 0;
    entity.posState = presentation.posState;
    entity.posTimestampMs = presentation.posTimestampMs;
    entity.posDelayTimeMs = presentation.posDelayTimeMs;
    entity.destinyForceFree = !state.isAnchored;
    entity.isFree = !state.isAnchored;
    entity.destinyForceInteractive = !state.isAnchored;
    starbaseDefenseRuntime.hydrateBatteryActor(entity, resolved);
    return entity;
  }
  const anchorReconciliation = controlTowerRuntime.reconcileControlTowerAnchorState(
    item.itemID,
    {
      nowMs: Date.now(),
      schedule: true,
      refreshPresentation: false,
    },
  );
  let resolvedItem = anchorReconciliation.success && anchorReconciliation.data
    ? anchorReconciliation.data
    : item;
  const onlineReconciliation = controlTowerRuntime.reconcileControlTowerOnlineState(
    resolvedItem.itemID,
    {
      nowMs: Date.now(),
      schedule: true,
      refreshPresentation: false,
      reconcileForceField: false,
    },
  );
  if (onlineReconciliation.success && onlineReconciliation.data) {
    resolvedItem = onlineReconciliation.data;
  }
  const spaceState = resolvedItem.spaceState || {};
  entity.spaceState = { ...spaceState };
  entity.corporationID = toInt(
    spaceState.corporationID,
    toInt(resolvedItem.corporationID, toInt(resolvedItem.ownerID, 0)),
  );
  entity.allianceID = toInt(
    spaceState.allianceID,
    toInt(resolvedItem.allianceID, 0),
  );
  entity.warFactionID = toInt(
    spaceState.warFactionID,
    toInt(resolvedItem.warFactionID, 0),
  );
  entity.incapacitated = toInt(
    spaceState.incapacitated,
    toInt(resolvedItem.incapacitated, 0),
  );
  entity.moonID = toInt(spaceState.moonID, 0) || null;
  const storedAnchorState = String(
    spaceState.anchorState || resolvedItem.anchorState || "",
  ).trim().toLowerCase();
  const anchorState = Object.values(STARBASE_ANCHOR_STATE).includes(
    storedAnchorState,
  )
    ? storedAnchorState
    : spaceState.isAnchored === true ||
        spaceState.isAnchored === 1 ||
        spaceState.isAnchored === "1" ||
        resolvedItem.isAnchored === true ||
        resolvedItem.isAnchored === 1 ||
        resolvedItem.isAnchored === "1"
      ? STARBASE_ANCHOR_STATE.ANCHORED
      : STARBASE_ANCHOR_STATE.UNANCHORED;
  const isAnchored = anchorState !== STARBASE_ANCHOR_STATE.UNANCHORED;
  const towerPresentation = controlTowerRuntime.getControlTowerPresentationState(
    resolvedItem,
  );
  entity.anchorState = anchorState;
  entity.isAnchored = isAnchored;
  entity.anchorStartedAtMs = towerPresentation.anchorStartedAtMs;
  entity.anchorCompletesAtMs = towerPresentation.anchorCompletesAtMs;
  entity.onlineState = towerPresentation.onlineState;
  entity.onlineStartedAtMs = towerPresentation.onlineStartedAtMs;
  entity.onlineCompletesAtMs = towerPresentation.onlineCompletesAtMs;
  entity.posTimerScale =
    Number.isFinite(Number(spaceState.posTimerScale)) &&
    Number(spaceState.posTimerScale) > 0
      ? Number(spaceState.posTimerScale)
      : 1;
  entity.online = towerPresentation.online;
  entity.posState = towerPresentation.posState;
  entity.posTimestampMs = towerPresentation.posTimestampMs;
  entity.posDelayTimeMs = towerPresentation.posDelayTimeMs;
  entity.destinyForceFree = !isAnchored;
  entity.isFree = !isAnchored;
  entity.destinyForceInteractive = !isAnchored;
  return entity;
}

function hydrateForceFieldEntityFromInventoryItem(entity, item) {
  if (!entity || !item) {
    return entity;
  }
  const spaceState = item.spaceState || {};
  entity.destinyForceFree = true;
  entity.isFree = true;
  entity.mode = "FIELD";
  entity.destinyBallMode = "FIELD";
  entity.destinyHarmonic = toInt(
    spaceState.destinyHarmonic ?? spaceState.harmonic,
    0,
  );
  entity.harmonic = entity.destinyHarmonic;
  entity.corporationID = toInt(
    spaceState.corporationID,
    toInt(item.corporationID, 0),
  );
  entity.allianceID = toInt(
    spaceState.allianceID,
    toInt(item.allianceID, 0),
  );
  entity.controlTowerID = toInt(
    spaceState.controlTowerID,
    toInt(item.controlTowerID, 0),
  ) || null;
  return entity;
}

function getStructureUnanchorArtifactStructureID(item) {
  const customInfo = String(item && item.customInfo || "");
  const markerMatch =
    STRUCTURE_UNANCHOR_HULL_MARKER_PATTERN.exec(customInfo) ||
    STRUCTURE_UNANCHOR_FITTINGS_MARKER_PATTERN.exec(customInfo) ||
    STRUCTURE_UNANCHOR_ASSETS_MARKER_PATTERN.exec(customInfo) ||
    STRUCTURE_UNANCHOR_OFFICE_MARKER_PATTERN.exec(customInfo);
  return toInt(markerMatch && markerMatch[1], 0);
}

function shouldDeferStructureUnanchorArtifactPresentation(item) {
  const structureID = getStructureUnanchorArtifactStructureID(item);
  if (structureID <= 0) {
    return false;
  }
  return Boolean(
    structureState.getStructureByID(structureID, { refresh: false }),
  );
}

function isDirectSystemSpaceInventoryItem(item, systemID) {
  const numericSystemID = toInt(systemID, 0);
  return Boolean(
    item &&
    numericSystemID > 0 &&
    toInt(item.locationID, 0) === numericSystemID &&
    toInt(item.flagID, -1) === 0 &&
    item.spaceState &&
    toInt(item.spaceState.systemID, 0) === numericSystemID
  );
}

function isInventoryItemEligibleForSceneSpawn(item, descriptor) {
  const getInventoryAbyssalRunOwnership = abyssalRoomEntityModule.getInventoryAbyssalRunOwnership;
  if (!item || !descriptor) {
    return false;
  }
  const sceneLocationID = toInt(descriptor.locationID, 0);
  if (
    isDirectSystemSpaceInventoryItem(item, sceneLocationID) &&
    shouldHydrateInventoryItemIntoScene(item, descriptor)
  ) {
    return true;
  }
  const sourceSolarSystemID = toInt(descriptor.sourceSolarSystemID, 0);
  const abyssalOwnership = getInventoryAbyssalRunOwnership(item);
  return Boolean(
    descriptor.sceneKind === SCENE_KIND_ABYSSAL &&
    sourceSolarSystemID > 0 &&
    abyssalOwnership &&
    toInt(abyssalOwnership.instanceID, 0) === toInt(descriptor.instanceID, 0) &&
    isDirectSystemSpaceInventoryItem(item, sourceSolarSystemID)
  );
}

function resolveRuntimeInventoryEntityRadius(kind, item, metadata, fallback = 40) {
  const staticRadius =
    toFiniteNumber(item && item.radius, 0) > 0
      ? toFiniteNumber(item && item.radius, 0)
      : toFiniteNumber(metadata && metadata.radius, 0);
  const explicitSpaceRadius = toFiniteNumber(item && item.spaceRadius, 0);
  if (explicitSpaceRadius > 0) {
    return explicitSpaceRadius;
  }
  if (kind === "wreck") {
    return resolveRuntimeWreckRadius(
      {
        ...metadata,
        itemName: item && item.itemName,
        name: String(item && item.itemName || metadata && metadata.name || "Wreck"),
        radius: staticRadius,
      },
      staticRadius,
    );
  }
  return staticRadius > 0 ? staticRadius : fallback;
}

function resolveRuntimeInventoryEntitySignatureRadius(item, metadata, ballRadius = 0) {
  const typeID = toInt(
    item && item.typeID,
    toInt(metadata && metadata.typeID, 0),
  );
  const typeSignatureRadius = getTypeAttributeValue(typeID, "signatureRadius");
  if (typeSignatureRadius !== null && typeSignatureRadius !== undefined) {
    const resolvedTypeSignatureRadius = toFiniteNumber(typeSignatureRadius, 0);
    if (resolvedTypeSignatureRadius > 0) {
      return resolvedTypeSignatureRadius;
    }
  }

  const runtimeBallRadius = toFiniteNumber(ballRadius, 0);
  if (runtimeBallRadius > 0) {
    return runtimeBallRadius;
  }

  const staticTypeRadius = toFiniteNumber(metadata && metadata.radius, 0);
  if (staticTypeRadius > 0) {
    return staticTypeRadius;
  }

  return 1;
}

function buildRuntimeInventoryEntity(item, systemID, nowMs) {
  if (nowMs === undefined || nowMs === null) {
    log.warn("buildRuntimeInventoryEntity: nowMs not provided, using wallclock fallback — caller should pass scene sim time");
    nowMs = Date.now();
  }
  if (!item || !item.itemID) {
    return null;
  }
  if (
    Number.isFinite(Number(item.expiresAtMs)) &&
    Number(item.expiresAtMs) > 0 &&
    Number(item.expiresAtMs) <= nowMs
  ) {
    return null;
  }

  const kind = getRuntimeInventoryEntityKind(item);
  if (!kind) {
    return null;
  }

  const metadata = getItemMetadata(item.typeID, item.itemName);
  const spaceState = item.spaceState || {};
  const position = cloneVector(spaceState.position);
  const direction = normalizeVector(
    cloneVector(spaceState.direction, DEFAULT_RIGHT),
    DEFAULT_RIGHT,
  );
  const resolvedRadius = resolveRuntimeInventoryEntityRadius(
    kind,
    item,
    metadata,
    40,
  );
  const resolvedSignatureRadius = resolveRuntimeInventoryEntitySignatureRadius(
    item,
    metadata,
    resolvedRadius,
  );
  const resolvedMass = Math.max(0, toFiniteNumber(
    getTypeAttributeValue(item.typeID, "mass"),
    0,
  ));
  const resolvedInertia = Math.max(0, toFiniteNumber(
    getTypeAttributeValue(item.typeID, "agility"),
    0,
  ));
  const resolvedMaxVelocity = Math.max(0, toFiniteNumber(
    getTypeAttributeValue(item.typeID, "maxVelocity"),
    toFiniteNumber(spaceState.maxVelocity, 0),
  ));
  const staticStructureHP = Math.max(0, toFiniteNumber(
    getTypeAttributeValue(item.typeID, "hp", "structureHP"),
    0,
  ));
  const resolvedStructureHP =
    kind === "wreck" && staticStructureHP <= 0
      // Some scenery / event wreck rows carry no HP dogma at all, but the
      // client still lets pilots lock and shoot them. Fall back to the live
      // wreck radius so those targets participate in the normal weapon path.
      ? resolveRuntimeWreckStructureFallbackHP({
          ...metadata,
          itemName: item.itemName,
          name: item.itemName,
          radius: resolvedRadius,
        }, resolvedRadius)
      : staticStructureHP;

  const entity = {
    kind,
    systemID,
    itemID: allocateRuntimeEntityID(item.itemID),
    typeID: toInt(item.typeID, 0),
    groupID: toInt(item.groupID, toInt(metadata.groupID, 0)),
    categoryID: toInt(item.categoryID, toInt(metadata.categoryID, 0)),
    itemName: String(item.itemName || metadata.name || "Container"),
    ownerID: toInt(item.ownerID, 0),
    graphicID: toInt(metadata && metadata.graphicID, 0) || null,
    position,
    velocity: cloneVector(spaceState.velocity),
    direction,
    targetPoint: cloneVector(spaceState.targetPoint, position),
    mode: normalizeMode(spaceState.mode, "STOP"),
    speedFraction: clamp(toFiniteNumber(spaceState.speedFraction, 0), 0, 1),
    mass: resolvedMass > 0 ? resolvedMass : 10_000,
    inertia: resolvedInertia > 0 ? resolvedInertia : 1,
    maxVelocity: resolvedMaxVelocity,
    radius: resolvedRadius,
    // Retail lock timing prefers the type dogma signature radius and only
    // falls back to the ball/static radius when that attribute is absent.
    signatureRadius: resolvedSignatureRadius,
    passiveDerivedState: {
      attributes: getTypeDogmaAttributes(item.typeID),
    },
    shieldCapacity: Math.max(0, toFiniteNumber(
      getTypeAttributeValue(item.typeID, "shieldCapacity"),
      0,
    )),
    shieldRechargeRate: Math.max(0, toFiniteNumber(
      getTypeAttributeValue(item.typeID, "shieldRechargeRate"),
      0,
    )),
    armorHP: Math.max(0, toFiniteNumber(
      getTypeAttributeValue(item.typeID, "armorHP"),
      0,
    )),
    structureHP: resolvedStructureHP,
    bubbleID: null,
    publicGridKey: null,
    persistSpaceState: true,
    lastPersistAt: 0,
    spaceState: item.spaceState || null,
    conditionState: normalizeShipConditionState(item.conditionState),
    createdAtMs: toFiniteNumber(item.createdAtMs, 0) || null,
    expiresAtMs: toFiniteNumber(item.expiresAtMs, 0) || null,
    isEmpty: listContainerItems(null, item.itemID).length === 0,
    launcherID: toInt(item.launcherID, 0) || null,
    lootAbandoned: isInventoryLootAbandoned(item),
    dunRotation: coerceDunRotationTuple(item.dunRotation),
  };
  applyRuntimeEntityScopeMetadata(entity, item);
  applyRuntimeEntityScopeMetadata(entity, spaceState);
  applyInventoryLootInfoToEntity(entity, item);
  hydrateCargoContainerAnchorPresentationFields(entity, item, nowMs);

  if (kind === "forceField") {
    hydrateForceFieldEntityFromInventoryItem(entity, item);
  }
  if (kind === RUNTIME_STARBASE_KIND) {
    hydrateStarbaseEntityFromInventoryItem(entity, item);
  }
  if (kind === "drone") {
    entity.targetEntityID = toInt(spaceState.targetEntityID, 0) || null;
    entity.followRange = toFiniteNumber(spaceState.followRange, 0);
    entity.orbitDistance = toFiniteNumber(spaceState.orbitDistance, 0);
    entity.orbitNormal = cloneVector(
      spaceState.orbitNormal,
      buildPerpendicular(direction),
    );
    entity.orbitSign = toFiniteNumber(spaceState.orbitSign, 1) < 0 ? -1 : 1;
    entity.lockedTargets = new Map();
    entity.pendingTargetLocks = new Map();
    entity.targetedBy = new Set();
    entity.activeModuleEffects = new Map();
    entity.moduleReactivationLocks = new Map();
    hydrateDroneEntityFromInventoryItem(entity, item);
  }
  if (kind === "fighter") {
    entity.targetEntityID = toInt(spaceState.targetEntityID, 0) || null;
    entity.followRange = toFiniteNumber(spaceState.followRange, 0);
    entity.orbitDistance = toFiniteNumber(spaceState.orbitDistance, 0);
    entity.orbitNormal = cloneVector(
      spaceState.orbitNormal,
      buildPerpendicular(direction),
    );
    entity.orbitSign = toFiniteNumber(spaceState.orbitSign, 1) < 0 ? -1 : 1;
    entity.lockedTargets = new Map();
    entity.pendingTargetLocks = new Map();
    entity.targetedBy = new Set();
    entity.activeModuleEffects = new Map();
    entity.moduleReactivationLocks = new Map();
    hydrateFighterEntityFromInventoryItem(entity, item);
  }
  if (kind === "orbital") {
    planetOrbitalState.hydrateOrbitalEntityFromInventoryItem(entity, item, {
      solarSystemID: systemID,
    });
  }
  if (kind === "probe") {
    interdictionProbeRuntime.hydrateInterdictionProbeEntityFromInventoryItem(entity, item);
    surveyProbeRuntime.hydrateSurveyProbeEntityFromInventoryItem(entity, item);
  }
  if (kind === "deployable") {
    hydrateAbyssalTraceEntityFromInventoryItem(entity, item);
    hydrateAbyssalPocketMarkerEntityFromInventoryItem(entity, item);
    deployableCynoRuntime.hydrateMobileCynoDeployableEntityFromInventoryItem(entity, item);
    mobileDepotRuntime.hydrateMobileDepotEntityFromInventoryItem(entity, item);
    mobileAnalysisBeaconRuntime.hydrateMobileAnalysisBeaconEntityFromInventoryItem(entity, item);
    mobileCynoInhibitorRuntime.hydrateMobileCynoInhibitorEntityFromInventoryItem(entity, item);
    mobileMicroJumpUnitRuntime.hydrateMobileMicroJumpUnitEntityFromInventoryItem(entity, item);
    mobileObservatoryRuntime.hydrateMobileObservatoryEntityFromInventoryItem(entity, item);
    mobilePhaseAnchorRuntime.hydrateMobilePhaseAnchorEntityFromInventoryItem(entity, item);
    mobileScanInhibitorRuntime.hydrateMobileScanInhibitorEntityFromInventoryItem(entity, item);
    mobileSiphonUnitRuntime.hydrateMobileSiphonUnitEntityFromInventoryItem(entity, item);
    mobileTractorUnitRuntime.hydrateMobileTractorUnitEntityFromInventoryItem(entity, item);
    mobileWarpDisruptorRuntime.hydrateMobileWarpDisruptorEntityFromInventoryItem(entity, item);
  }
  hydrateAbyssalRuntimeArtifactEntityFromInventoryItem(entity, item);

  return entity;
}

function buildRuntimeSpaceEntityFromItem(item, systemID, nowMs, options = {}) {
  if (shouldDeferStructureUnanchorArtifactPresentation(item)) {
    return null;
  }
  const raidRuntime = require("../../services/sovereignty/skyhookRaidRuntime");
  if (raidRuntime.isSealedRaidContainer(item)) return null;
  if (toInt(item && item.categoryID, 0) === 6 && item && item.spaceState) {
    return buildRuntimePersistedSpaceShipEntity(item, systemID, options);
  }
  let entity = buildRuntimeInventoryEntity(item, systemID, nowMs);
  if (entity && entity.kind === "skyhookSilo") entity = raidRuntime.hydrateSilo(entity, item);
  applyRuntimeEntityScopeMetadata(entity, options.entityScopeMetadata);
  // The dungeon journal owns terminal hack states. Rebuild that authority
  // before the reconstructed inventory entity reaches native slim or RPCs.
  const hackingContainerState = require("../../services/exploration/hackingContainerState");
  if (hackingContainerState.isHackable(entity)) hackingContainerState.restore(entity, { nowMs });
  return entity;
}

function spawnDeferredStructureLootEntities(scene, structureID, options = {}) {
  if (!scene) {
    return {
      success: false,
      errorMsg: "SCENE_NOT_FOUND",
    };
  }

  const numericStructureID = toInt(structureID, 0);
  if (!numericStructureID) {
    return {
      success: false,
      errorMsg: "STRUCTURE_NOT_FOUND",
    };
  }

  const spawnedItemIDs = [];
  const spaceItems = listSystemSpaceItems(scene.systemID)
    .filter((item) => toInt(item && item.launcherID, 0) === numericStructureID)
    .sort((left, right) => toInt(left && left.itemID, 0) - toInt(right && right.itemID, 0));

  for (const item of spaceItems) {
    const itemID = toInt(item && item.itemID, 0);
    if (!itemID || scene.getEntityByID(itemID)) {
      continue;
    }

    const entity = buildRuntimeSpaceEntityFromItem(
      item,
      scene.systemID,
      scene.getCurrentSimTimeMs(),
    );
    if (!entity) {
      continue;
    }

    const spawnResult = scene.spawnDynamicEntity(entity, {
      broadcast: options.broadcast !== false,
      excludedSession: options.excludedSession || null,
    });
    if (!spawnResult.success) {
      return spawnResult;
    }
    spawnedItemIDs.push(itemID);
  }

  return {
    success: true,
    data: {
      itemIDs: spawnedItemIDs,
    },
  };
}

Object.assign(module.exports, {
  CATEGORY_STARBASE,
  CATEGORY_STRUCTURE,
  GROUP_BIOMASS,
  GROUP_CONTROL_TOWER,
  RUNTIME_CORPSE_KIND,
  RUNTIME_STARBASE_KIND,
  RUNTIME_UNANCHORED_STRUCTURE_HULL_KIND,
  STARBASE_ANCHOR_STATE,
  STRUCTURE_UNANCHOR_ASSETS_MARKER_PATTERN,
  STRUCTURE_UNANCHOR_FITTINGS_MARKER_PATTERN,
  STRUCTURE_UNANCHOR_HULL_MARKER_PATTERN,
  STRUCTURE_UNANCHOR_OFFICE_MARKER_PATTERN,
});
