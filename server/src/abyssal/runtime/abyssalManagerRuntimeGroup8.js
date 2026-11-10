"use strict";

function buildManagerGroup8Binding48Part2(scope) {
  return {
  get getDependencies() { return scope.getDependencies; },
  get cloneValue() { return scope.cloneValue; },
  get getPlaceholderRoomEntry() { return scope.getPlaceholderRoomEntry; },
  get setPlaceholderRoomEntry() { return scope.setPlaceholderRoomEntry; },
  get buildPocketStateForCurrentRoom() { return scope.buildPocketStateForCurrentRoom; },
  get updatePocketState() { return scope.updatePocketState; },
  get ensureAbyssalPocketPersistenceReady() { return scope.ensureAbyssalPocketPersistenceReady; },
  get buildPlaceholderRoomState() { return scope.buildPlaceholderRoomState; },
  get validateObservedRunRewardAllocation() { return scope.validateObservedRunRewardAllocation; },
  get validateAbyssalRewardPlanContext() { return scope.validateAbyssalRewardPlanContext; },
  get buildAbyssalRewardPlan() { return scope.buildAbyssalRewardPlan; },
  get isObservedRunRewardAllocationProfile() { return scope.isObservedRunRewardAllocationProfile; },
  get buildObservedRunRewardAllocation() { return scope.buildObservedRunRewardAllocation; },
  get hasLegacyObservedRunRewardPlanState() { return scope.hasLegacyObservedRunRewardPlanState; },
  get buildLegacyObservedRunRewardProfile() { return scope.buildLegacyObservedRunRewardProfile; },
  get parseCustomInfo() { return scope.parseCustomInfo; },
  get getContentProfile() { return scope.getContentProfile; },
  get resolvePlaceholderDurationMs() { return scope.resolvePlaceholderDurationMs; },
  get spawnPocketDynamicInventoryEntity() { return scope.spawnPocketDynamicInventoryEntity; },
  get syncInventoryChanges() { return scope.syncInventoryChanges; },
  get nextAbyssalLootRandom() { return scope.nextAbyssalLootRandom; },
  get listUniquePositiveInts() { return scope.listUniquePositiveInts; },
  get CATEGORY_BLUEPRINT() { return scope.CATEGORY_BLUEPRINT; },
  get TYPE_CAPTURED_TRIGLAVIAN_BIOADAPTIVE_CACHE() { return scope.TYPE_CAPTURED_TRIGLAVIAN_BIOADAPTIVE_CACHE; },
  get TYPE_ABYSSAL_BIOCOMBINATIVE_CACHE() { return scope.TYPE_ABYSSAL_BIOCOMBINATIVE_CACHE; },
  get TYPE_ABYSSAL_BIOCOMBINATIVE_CACHE_WRECK() { return scope.TYPE_ABYSSAL_BIOCOMBINATIVE_CACHE_WRECK; },
  get TYPE_CAPTURED_TRIGLAVIAN_BIOADAPTIVE_CACHE_WRECK() { return scope.TYPE_CAPTURED_TRIGLAVIAN_BIOADAPTIVE_CACHE_WRECK; },
  get TYPE_ABYSSAL_EXTRACTION_SUBNODE() { return scope.TYPE_ABYSSAL_EXTRACTION_SUBNODE; },
  get TYPE_ABYSSAL_EXTRACTION_SUBNODE_WRECK() { return scope.TYPE_ABYSSAL_EXTRACTION_SUBNODE_WRECK; },
  get TYPE_ABYSSAL_EXTRACTION_NODE_WRECK() { return scope.TYPE_ABYSSAL_EXTRACTION_NODE_WRECK; },
  get ABYSSAL_BLUEPRINT_COPY_MIN_RUNS() { return scope.ABYSSAL_BLUEPRINT_COPY_MIN_RUNS; },
  get ABYSSAL_BLUEPRINT_COPY_MAX_RUNS() { return scope.ABYSSAL_BLUEPRINT_COPY_MAX_RUNS; },
  get buildAbyssalSceneDescriptor() { return scope.buildAbyssalSceneDescriptor; },
  get destroyPlaceholderTrace() { return scope.destroyPlaceholderTrace; },
  get getActivePocketStateByInstanceID() { return scope.getActivePocketStateByInstanceID; },
  get getCacheProfile() { return scope.getCacheProfile; },
  get resolveRoomRewardProfile() { return scope.resolveRoomRewardProfile; },
  get buildRewardCacheCustomInfo() { return scope.buildRewardCacheCustomInfo; },
  get getRewardTierMultiplierApplied() { return scope.getRewardTierMultiplierApplied; },
  get markAbyssalRewardPlanGranted() { return scope.markAbyssalRewardPlanGranted; },
  get resolveRoomExtractionNodeProfile() { return scope.resolveRoomExtractionNodeProfile; },
  get buildExtractionNodeCustomInfo() { return scope.buildExtractionNodeCustomInfo; },
  get refreshAbyssalDungeonTrackingState() { return scope.refreshAbyssalDungeonTrackingState; },
  get getRewardState() { return scope.getRewardState; },
  get clampRoomIndex() { return scope.clampRoomIndex; },
  get log() { return scope.log; },
  get readRewardCacheStateFromItem() { return scope.readRewardCacheStateFromItem; },
  get readExtractionNodeStateFromItem() { return scope.readExtractionNodeStateFromItem; },
  get evaluateAbyssalDirectCallbackTerminalGuard() { return scope.evaluateAbyssalDirectCallbackTerminalGuard; },
  get buildAbyssalDirectCallbackSuppressedResult() { return scope.buildAbyssalDirectCallbackSuppressedResult; },
  get toReal() { return scope.toReal; },
  get isIntentionallyEmptyObservedRunRoomRewardPlan() { return scope.isIntentionallyEmptyObservedRunRoomRewardPlan; },
  get hasFailedTimeoutOutcome() { return scope.hasFailedTimeoutOutcome; },
  get resolveRoomEncounterProfile() { return scope.resolveRoomEncounterProfile; },
  get summarizeRewardLootEntries() { return scope.summarizeRewardLootEntries; },
  get listGuaranteedRewardLootEntries() { return scope.listGuaranteedRewardLootEntries; },
  get buildRewardCacheSpawnState() { return scope.buildRewardCacheSpawnState; },
  get resolveRoomOriginPosition() { return scope.resolveRoomOriginPosition; },
  get formatVectorForLog() { return scope.formatVectorForLog; },
  get PLACEHOLDER_REWARD_CACHE_MAX_REPAIRS() { return scope.PLACEHOLDER_REWARD_CACHE_MAX_REPAIRS; },
  get ABYSSAL_ROOM_DELIVERY_STATE() { return scope.ABYSSAL_ROOM_DELIVERY_STATE; },
  get ABYSSAL_ROOM_ENTITY_ROLES() { return scope.ABYSSAL_ROOM_ENTITY_ROLES; },
  get isTranquilAbyssalContent() { return scope.isTranquilAbyssalContent; },
  get buildExtractionNodeSpawnStates() { return scope.buildExtractionNodeSpawnStates; },
  get TYPE_ABYSSAL_EXTRACTION_NODE() { return scope.TYPE_ABYSSAL_EXTRACTION_NODE; },
  get ABYSSAL_EARLY_VISIBILITY_STATES() { return scope.ABYSSAL_EARLY_VISIBILITY_STATES; },
  get abyssalRunWorkStore() { return scope.abyssalRunWorkStore; },
  get getAbyssalRewardArtifactDestructionOperation() { return scope.getAbyssalRewardArtifactDestructionOperation; },
  get commitPocketStateDurably() { return scope.commitPocketStateDurably; },
  get buildAbyssalRewardArtifactDestructionOperationPatch() { return scope.buildAbyssalRewardArtifactDestructionOperationPatch; },
  get readPersistedAbyssalPocketStateFromInstance() { return scope.readPersistedAbyssalPocketStateFromInstance; },
  get getObjectPosition() { return scope.getObjectPosition; },
  get normalizeDirection() { return scope.normalizeDirection; },
  get getCapturedT0DarkRoom() { return scope.getCapturedT0DarkRoom; },
  get normalizeLowerText() { return scope.normalizeLowerText; },
  get syncExpiredAbyssalPocketState() { return scope.syncExpiredAbyssalPocketState; },
  get buildResolvedExtractionNodeLootEntries() { return scope.buildResolvedExtractionNodeLootEntries; },
  get buildAbyssalRewardArtifactDestructionOperationID() { return scope.buildAbyssalRewardArtifactDestructionOperationID; },
  get buildAbyssalPersistencePendingResult() { return scope.buildAbyssalPersistencePendingResult; },
  get getAuthoritativeAbyssalPocketState() { return scope.getAuthoritativeAbyssalPocketState; },
  get getAbyssalRewardArtifactDestructionOperations() { return scope.getAbyssalRewardArtifactDestructionOperations; },
};
}

function buildManagerGroup8Binding48Part1(scope) {
  return (0, scope.createAbyssalRewardComposition)(buildManagerGroup8Binding48Part2(scope));
}

function initializeManagerGroup8Binding1(scope) {
  const {
  ABYSSAL_SCENERY_PROBE_PROFILE,
} = require("../catalog/abyssalSceneryProbeProfile");
  scope.ABYSSAL_SCENERY_PROBE_PROFILE = ABYSSAL_SCENERY_PROBE_PROFILE;
}

function initializeManagerGroup8Binding2(scope) {
  const ABYSSAL_SCENERY_GUARD_STATUS = Object.freeze({
  active: true,
  targeting: true,
  movement: true,
  warp: true,
  directionalScan: true,
  damageByShape: true,
  lootByShape: true,
});
  scope.ABYSSAL_SCENERY_GUARD_STATUS = ABYSSAL_SCENERY_GUARD_STATUS;
}

function initializeManagerGroup8Binding3(scope) {
  const ABYSSAL_SCENERY_STATIC_ITEM_ID_BASE = 9_840_000_000;
  scope.ABYSSAL_SCENERY_STATIC_ITEM_ID_BASE = ABYSSAL_SCENERY_STATIC_ITEM_ID_BASE;
}

function initializeManagerGroup8Binding4(scope) {
  const ABYSSAL_SHIP_HIDE_SUPPORT = Object.freeze({
  supported: false,
  reason: "NO_SAFE_SCOPED_VISUAL_HIDE_HOOK",
});
  scope.ABYSSAL_SHIP_HIDE_SUPPORT = ABYSSAL_SHIP_HIDE_SUPPORT;
}

function initializeManagerGroup8Binding5(scope) {
  const ABYSSAL_TIMEOUT_POD_STATUS = Object.freeze({
  NO_SAFE_HOOK: "NO_SAFE_POD_DESTRUCTION_HOOK",
  SHIP_AND_POD_DESTROYED: "SHIP_AND_POD_DESTROYED",
  POD_DESTRUCTION_REQUEST_FAILED: "POD_DESTRUCTION_REQUEST_FAILED",
});
  scope.ABYSSAL_TIMEOUT_POD_STATUS = ABYSSAL_TIMEOUT_POD_STATUS;
}

function initializeManagerGroup8Binding6(scope) {
  const PLACEHOLDER_POCKET_TEMPLATE_ID_BY_TIER = Object.freeze({
  0: "client-dungeon:10589",
  1: "client-dungeon:10589",
  2: "client-dungeon:10590",
  3: "client-dungeon:10591",
  4: "client-dungeon:10592",
  5: "client-dungeon:10592",
  6: "client-dungeon:10592",
});
  scope.PLACEHOLDER_POCKET_TEMPLATE_ID_BY_TIER = PLACEHOLDER_POCKET_TEMPLATE_ID_BY_TIER;
}

function initializeManagerGroup8Binding7(scope) {
  const {
  CLIENT_ABYSS_ERROR,
  ABYSS_ERROR,
  ABYSS_ERROR_KIND,
  ABYSSAL_SHIP_STATE_CLIENT_CODE,
} = require("../catalog/abyssalClientErrorCodes");
  scope.CLIENT_ABYSS_ERROR = CLIENT_ABYSS_ERROR;
  scope.ABYSS_ERROR = ABYSS_ERROR;
  scope.ABYSS_ERROR_KIND = ABYSS_ERROR_KIND;
  scope.ABYSSAL_SHIP_STATE_CLIENT_CODE = ABYSSAL_SHIP_STATE_CLIENT_CODE;
}

function initializeManagerGroup8Binding8(scope) {
  const DOGMA_OP_POST_PERCENT = 6;
  scope.DOGMA_OP_POST_PERCENT = DOGMA_OP_POST_PERCENT;
}

function initializeManagerGroup8Binding9(scope) {
  const ATTRIBUTE_MAX_VELOCITY = (0, scope.getAttributeIDByNames)("maxVelocity") || 37;
  scope.ATTRIBUTE_MAX_VELOCITY = ATTRIBUTE_MAX_VELOCITY;
}

function initializeManagerGroup8Binding10(scope) {
  const ATTRIBUTE_SCAN_RESOLUTION = (0, scope.getAttributeIDByNames)("scanResolution") || 564;
  scope.ATTRIBUTE_SCAN_RESOLUTION = ATTRIBUTE_SCAN_RESOLUTION;
}

function initializeManagerGroup8Binding11(scope) {
  const ATTRIBUTE_CAPACITOR_RECHARGE_RATE = (0, scope.getAttributeIDByNames)("rechargerate", "capacitorRechargeRate") || 55;
  scope.ATTRIBUTE_CAPACITOR_RECHARGE_RATE = ATTRIBUTE_CAPACITOR_RECHARGE_RATE;
}

function initializeManagerGroup8Binding12(scope) {
  const ATTRIBUTE_SHIELD_CAPACITY = (0, scope.getAttributeIDByNames)("shieldCapacity") || 263;
  scope.ATTRIBUTE_SHIELD_CAPACITY = ATTRIBUTE_SHIELD_CAPACITY;
}

function initializeManagerGroup8Binding13(scope) {
  const ATTRIBUTE_ARMOR_HP = (0, scope.getAttributeIDByNames)("armorHP") || 265;
  scope.ATTRIBUTE_ARMOR_HP = ATTRIBUTE_ARMOR_HP;
}

function initializeManagerGroup8Binding14(scope) {
  const ATTRIBUTE_MAX_RANGE = (0, scope.getAttributeIDByNames)("maxRange") || 54;
  scope.ATTRIBUTE_MAX_RANGE = ATTRIBUTE_MAX_RANGE;
}

function initializeManagerGroup8Binding15(scope) {
  const ATTRIBUTE_FALLOFF = (0, scope.getAttributeIDByNames)("falloff") || 158;
  scope.ATTRIBUTE_FALLOFF = ATTRIBUTE_FALLOFF;
}

function initializeManagerGroup8Binding16(scope) {
  const ATTRIBUTE_SHIELD_EM_RESONANCE = (0, scope.getAttributeIDByNames)("shieldEmDamageResonance") || 271;
  scope.ATTRIBUTE_SHIELD_EM_RESONANCE = ATTRIBUTE_SHIELD_EM_RESONANCE;
}

function initializeManagerGroup8Binding17(scope) {
  const ATTRIBUTE_SHIELD_EXPLOSIVE_RESONANCE = (0, scope.getAttributeIDByNames)("shieldExplosiveDamageResonance") || 272;
  scope.ATTRIBUTE_SHIELD_EXPLOSIVE_RESONANCE = ATTRIBUTE_SHIELD_EXPLOSIVE_RESONANCE;
}

function initializeManagerGroup8Binding18(scope) {
  const ATTRIBUTE_SHIELD_KINETIC_RESONANCE = (0, scope.getAttributeIDByNames)("shieldKineticDamageResonance") || 273;
  scope.ATTRIBUTE_SHIELD_KINETIC_RESONANCE = ATTRIBUTE_SHIELD_KINETIC_RESONANCE;
}

function initializeManagerGroup8Binding19(scope) {
  const ATTRIBUTE_SHIELD_THERMAL_RESONANCE = (0, scope.getAttributeIDByNames)("shieldThermalDamageResonance") || 274;
  scope.ATTRIBUTE_SHIELD_THERMAL_RESONANCE = ATTRIBUTE_SHIELD_THERMAL_RESONANCE;
}

function initializeManagerGroup8Binding20(scope) {
  const ATTRIBUTE_ARMOR_EM_RESONANCE = (0, scope.getAttributeIDByNames)("armorEmDamageResonance") || 267;
  scope.ATTRIBUTE_ARMOR_EM_RESONANCE = ATTRIBUTE_ARMOR_EM_RESONANCE;
}

function initializeManagerGroup8Binding21(scope) {
  const ATTRIBUTE_ARMOR_EXPLOSIVE_RESONANCE = (0, scope.getAttributeIDByNames)("armorExplosiveDamageResonance") || 268;
  scope.ATTRIBUTE_ARMOR_EXPLOSIVE_RESONANCE = ATTRIBUTE_ARMOR_EXPLOSIVE_RESONANCE;
}

function initializeManagerGroup8Binding22(scope) {
  const ATTRIBUTE_ARMOR_KINETIC_RESONANCE = (0, scope.getAttributeIDByNames)("armorKineticDamageResonance") || 269;
  scope.ATTRIBUTE_ARMOR_KINETIC_RESONANCE = ATTRIBUTE_ARMOR_KINETIC_RESONANCE;
}

function initializeManagerGroup8Binding23(scope) {
  const ATTRIBUTE_ARMOR_THERMAL_RESONANCE = (0, scope.getAttributeIDByNames)("armorThermalDamageResonance") || 270;
  scope.ATTRIBUTE_ARMOR_THERMAL_RESONANCE = ATTRIBUTE_ARMOR_THERMAL_RESONANCE;
}

function initializeManagerGroup8Binding24(scope) {
  const ATTRIBUTE_STRUCTURE_EM_RESONANCE = (0, scope.getAttributeIDByNames)("emDamageResonance") || 113;
  scope.ATTRIBUTE_STRUCTURE_EM_RESONANCE = ATTRIBUTE_STRUCTURE_EM_RESONANCE;
}

function initializeManagerGroup8Binding25(scope) {
  const ATTRIBUTE_STRUCTURE_EXPLOSIVE_RESONANCE = (0, scope.getAttributeIDByNames)("explosiveDamageResonance") || 111;
  scope.ATTRIBUTE_STRUCTURE_EXPLOSIVE_RESONANCE = ATTRIBUTE_STRUCTURE_EXPLOSIVE_RESONANCE;
}

function initializeManagerGroup8Binding26(scope) {
  const ATTRIBUTE_STRUCTURE_KINETIC_RESONANCE = (0, scope.getAttributeIDByNames)("kineticDamageResonance") || 109;
  scope.ATTRIBUTE_STRUCTURE_KINETIC_RESONANCE = ATTRIBUTE_STRUCTURE_KINETIC_RESONANCE;
}

function initializeManagerGroup8Binding27(scope) {
  const ATTRIBUTE_STRUCTURE_THERMAL_RESONANCE = (0, scope.getAttributeIDByNames)("thermalDamageResonance") || 110;
  scope.ATTRIBUTE_STRUCTURE_THERMAL_RESONANCE = ATTRIBUTE_STRUCTURE_THERMAL_RESONANCE;
}

function initializeManagerGroup8Binding28(scope) {
  const ABYSSAL_WEATHER_TURRET_GROUP_IDS = Object.freeze([53, 55, 74, 1986]);
  scope.ABYSSAL_WEATHER_TURRET_GROUP_IDS = ABYSSAL_WEATHER_TURRET_GROUP_IDS;
}

function initializeManagerGroup8Binding29(scope) {
  const ABYSSAL_WEATHER_SYNTHETIC_ATTRIBUTE_RANGE_PERCENT = 9_880_000_001;
  scope.ABYSSAL_WEATHER_SYNTHETIC_ATTRIBUTE_RANGE_PERCENT = ABYSSAL_WEATHER_SYNTHETIC_ATTRIBUTE_RANGE_PERCENT;
}

function initializeManagerGroup8Binding30(scope) {
  const ABYSSAL_WEATHER_SHIP_ATTRIBUTE_NAME_TO_ID = Object.freeze({
  maxVelocity: scope.ATTRIBUTE_MAX_VELOCITY,
  scanResolution: scope.ATTRIBUTE_SCAN_RESOLUTION,
  capacitorRechargeRate: scope.ATTRIBUTE_CAPACITOR_RECHARGE_RATE,
  shieldCapacity: scope.ATTRIBUTE_SHIELD_CAPACITY,
  armorHP: scope.ATTRIBUTE_ARMOR_HP,
  shieldEmDamageResonance: scope.ATTRIBUTE_SHIELD_EM_RESONANCE,
  shieldExplosiveDamageResonance: scope.ATTRIBUTE_SHIELD_EXPLOSIVE_RESONANCE,
  shieldKineticDamageResonance: scope.ATTRIBUTE_SHIELD_KINETIC_RESONANCE,
  shieldThermalDamageResonance: scope.ATTRIBUTE_SHIELD_THERMAL_RESONANCE,
  armorEmDamageResonance: scope.ATTRIBUTE_ARMOR_EM_RESONANCE,
  armorExplosiveDamageResonance: scope.ATTRIBUTE_ARMOR_EXPLOSIVE_RESONANCE,
  armorKineticDamageResonance: scope.ATTRIBUTE_ARMOR_KINETIC_RESONANCE,
  armorThermalDamageResonance: scope.ATTRIBUTE_ARMOR_THERMAL_RESONANCE,
  emDamageResonance: scope.ATTRIBUTE_STRUCTURE_EM_RESONANCE,
  explosiveDamageResonance: scope.ATTRIBUTE_STRUCTURE_EXPLOSIVE_RESONANCE,
  kineticDamageResonance: scope.ATTRIBUTE_STRUCTURE_KINETIC_RESONANCE,
  thermalDamageResonance: scope.ATTRIBUTE_STRUCTURE_THERMAL_RESONANCE,
});
  scope.ABYSSAL_WEATHER_SHIP_ATTRIBUTE_NAME_TO_ID = ABYSSAL_WEATHER_SHIP_ATTRIBUTE_NAME_TO_ID;
}

function initializeManagerGroup8Binding31(scope) {
  const ABYSSAL_AUDIT_MAX_EVENTS = 5_000;
  scope.ABYSSAL_AUDIT_MAX_EVENTS = ABYSSAL_AUDIT_MAX_EVENTS;
}

function initializeManagerGroup8Binding32(scope) {
  const ABYSSAL_AUDIT_MAX_EVENT_BYTES = 16 * 1024;
  scope.ABYSSAL_AUDIT_MAX_EVENT_BYTES = ABYSSAL_AUDIT_MAX_EVENT_BYTES;
}

function initializeManagerGroup8Binding33(scope) {
  const ABYSSAL_AUDIT_DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
  scope.ABYSSAL_AUDIT_DEFAULT_MAX_AGE_MS = ABYSSAL_AUDIT_DEFAULT_MAX_AGE_MS;
}

function initializeManagerGroup8Binding34(scope) {
  const ABYSSAL_AUDIT_REJECTION_AGGREGATION_WINDOW_MS = 60_000;
  scope.ABYSSAL_AUDIT_REJECTION_AGGREGATION_WINDOW_MS = ABYSSAL_AUDIT_REJECTION_AGGREGATION_WINDOW_MS;
}

function initializeManagerGroup8Binding35(scope) {
  const abyssalTraceStateRegistry = new scope.AbyssalTraceStateRegistry();
  scope.abyssalTraceStateRegistry = abyssalTraceStateRegistry;
}

function initializeManagerGroup8Binding36(scope) {
  const { listPocketCleanupAnchors, isItemWithinPocketCleanupAnchors, inspectResidualPocketItemAuthority } = (0, scope.createAbyssalCleanupAuthority)({
  buildPlaceholderRoomState: scope.buildPlaceholderRoomState,
  getObjectPosition: scope.getObjectPosition,
  getVectorDistance: scope.getVectorDistance,
  PLACEHOLDER_ROOM_CLEANUP_RADIUS_METERS: scope.PLACEHOLDER_ROOM_CLEANUP_RADIUS_METERS,
  parseCustomInfo: scope.parseCustomInfo,
});
  scope.listPocketCleanupAnchors = listPocketCleanupAnchors;
  scope.isItemWithinPocketCleanupAnchors = isItemWithinPocketCleanupAnchors;
  scope.inspectResidualPocketItemAuthority = inspectResidualPocketItemAuthority;
}

function initializeManagerGroup8Binding37(scope) {
  const { buildTrackedPocketArtifactIDSet, destroyResidualPocketSpaceItem, cleanupResidualPocketSpaceItems } = (0, scope.createAbyssalResidualCleanup)({
  buildPlaceholderRoomState: scope.buildPlaceholderRoomState,
  usesIsolatedAbyssalScene: scope.usesIsolatedAbyssalScene,
  buildAbyssalSceneDescriptor: scope.buildAbyssalSceneDescriptor,
  log: scope.log,
  listPocketCleanupAnchors: scope.listPocketCleanupAnchors,
  getAbyssalTimeoutState: scope.getAbyssalTimeoutState,
  hasTerminalFailureOutcome: scope.hasTerminalFailureOutcome,
  CATEGORY_SHIP: scope.CATEGORY_SHIP,
  listUniquePositiveInts: scope.listUniquePositiveInts,
  isCapsuleTypeID: scope.isCapsuleTypeID,
  isItemWithinPocketCleanupAnchors: scope.isItemWithinPocketCleanupAnchors,
  inspectResidualPocketItemAuthority: scope.inspectResidualPocketItemAuthority,
  isCorpseType: scope.isCorpseType,
});
  scope.buildTrackedPocketArtifactIDSet = buildTrackedPocketArtifactIDSet;
  scope.destroyResidualPocketSpaceItem = destroyResidualPocketSpaceItem;
  scope.cleanupResidualPocketSpaceItems = cleanupResidualPocketSpaceItems;
}

function initializeManagerGroup8Binding38(scope) {
  const { cleanupExactAbyssalScannerProbes } = (0, scope.createAbyssalProbeCleanup)({
  normalizeLowerText: scope.normalizeLowerText,
  GROUP_WARP_DISRUPTION_PROBE: scope.GROUP_WARP_DISRUPTION_PROBE,
  GROUP_SCANNER_PROBE: scope.GROUP_SCANNER_PROBE,
  resolveExactAbyssalRunRoomScope: scope.resolveExactAbyssalRunRoomScope,
  getPocketScene: scope.getPocketScene,
  buildPlaceholderRoomState: scope.buildPlaceholderRoomState,
  log: scope.log,
});
  scope.cleanupExactAbyssalScannerProbes = cleanupExactAbyssalScannerProbes;
}

function initializeManagerGroup8Binding39(scope) {
  const { syncInventoryChanges, destroyPlaceholderTrace } = (0, scope.createAbyssalArtifactInventory)({
  getDependencies: scope.getDependencies,
  inspectResidualPocketItemAuthority: scope.inspectResidualPocketItemAuthority,
  listPocketCleanupAnchors: scope.listPocketCleanupAnchors,
  // Trace lifecycle is bound below; callbacks are not invoked during construction.
  unregisterTrace: (...args) => (0, scope.unregisterTrace)(...args),
  log: scope.log,
});
  scope.syncInventoryChanges = syncInventoryChanges;
  scope.destroyPlaceholderTrace = destroyPlaceholderTrace;
}

function initializeManagerGroup8Binding40(scope) {
  const {
  buildPocketMarkerCustomInfo,
  readPocketMarkerStateFromItem,
  spawnPocketDynamicInventoryEntity,
  ensurePocketMarker,
} = (0, scope.createAbyssalRoomMarkers)({
  buildPlaceholderRoomState: scope.buildPlaceholderRoomState,
  clampRoomIndex: scope.clampRoomIndex,
  ABYSSAL_ROOM_ENTITY_ROLES: scope.ABYSSAL_ROOM_ENTITY_ROLES,
  listAbyssalParticipantCharacterIDs: scope.listAbyssalParticipantCharacterIDs,
  cloneValue: scope.cloneValue,
  isFinalRoomIndex: scope.isFinalRoomIndex,
  toReal: scope.toReal,
  buildCapturedRetailIdentityState: scope.buildCapturedRetailIdentityState,
  parseCustomInfo: scope.parseCustomInfo,
  normalizeLowerText: scope.normalizeLowerText,
  getDependencies: scope.getDependencies,
  usesIsolatedAbyssalScene: scope.usesIsolatedAbyssalScene,
  buildAbyssalSceneDescriptor: scope.buildAbyssalSceneDescriptor,
  getPlaceholderRoomEntry: scope.getPlaceholderRoomEntry,
  TYPE_ABYSSAL_TRANSFER_CONDUIT: scope.TYPE_ABYSSAL_TRANSFER_CONDUIT,
  TYPE_ABYSSAL_TRACE: scope.TYPE_ABYSSAL_TRACE,
  normalizeDirection: scope.normalizeDirection,
  ABYSSAL_ROOM_DELIVERY_STATE: scope.ABYSSAL_ROOM_DELIVERY_STATE,
  destroyPlaceholderTrace: scope.destroyPlaceholderTrace,
  syncInventoryChanges: scope.syncInventoryChanges,
});
  scope.buildPocketMarkerCustomInfo = buildPocketMarkerCustomInfo;
  scope.readPocketMarkerStateFromItem = readPocketMarkerStateFromItem;
  scope.spawnPocketDynamicInventoryEntity = spawnPocketDynamicInventoryEntity;
  scope.ensurePocketMarker = ensurePocketMarker;
}

function initializeManagerGroup8Binding41(scope) {
  const {
  registerTrace,
  clearCreatedAbyssalTraceExpirySchedule,
  unregisterTrace,
  getActiveTraceState,
  persistTraceState,
  publishSourceTraceInitial,
  isCompleteAbyssalTracePublicationReceipt,
  hasCommittedAbyssalFilamentConsumption,
  canRecoverCreatedAbyssalTraceAfterRestart,
  persistAbyssalTracePublicationState,
  ensureSourceTraceRuntime,
  buildReturnedSourceTraceRetirementIdentity,
  revalidateReturnedSourceTraceRetirement,
  removeReturnedSourceTraceRepresentation,
  finalizeReturnedSourceTraceRetirement,
  attemptReturnedSourceTraceRetirement,
  removeOwnedSourceTrace,
  scheduleSourceTraceRemoval,
  transitionSourceTraceState,
  buildAbyssalTraceDeploymentToken,
  isCreatedAbyssalTraceExpired,
  expireCreatedAbyssalTrace,
  scheduleCreatedAbyssalTraceExpiry,
} = (0, scope.createAbyssalTraceLifecycle)({
  getDependencies: scope.getDependencies,
  abyssalTraceStateRegistry: scope.abyssalTraceStateRegistry,
  buildTraceCustomInfo: scope.buildTraceCustomInfo,
  readTraceStateFromItem: scope.readTraceStateFromItem,
  cloneValue: scope.cloneValue,
  getReadOnlySolarSystemScene: scope.getReadOnlySolarSystemScene,
  destroyPlaceholderTrace: scope.destroyPlaceholderTrace,
  // Delayed bindings avoid a construction-time cycle between the two stateless
  // trace units. No callback executes until both have been initialized.
  clearPendingAbyssalTraceActivation: (...args) => (0, scope.clearPendingAbyssalTraceActivation)(...args),
  clearPendingAbyssalTraceActivationHandle: (...args) => (0, scope.clearPendingAbyssalTraceActivationHandle)(...args),
  invalidateFailedAbyssalDeploymentTrace: scope.invalidateFailedAbyssalDeploymentTrace,
  isAbyssalReturnProtectionPending: scope.isAbyssalReturnProtectionPending,
  isAbyssalSuspectReturnPending: scope.isAbyssalSuspectReturnPending,
  resolveAbyssalReturnedTraceProtectionDeadlineMs: scope.resolveAbyssalReturnedTraceProtectionDeadlineMs,
  log: scope.log,
  GROUP_FILAMENT_TRACE: scope.GROUP_FILAMENT_TRACE,
});
  scope.registerTrace = registerTrace;
  scope.clearCreatedAbyssalTraceExpirySchedule = clearCreatedAbyssalTraceExpirySchedule;
  scope.unregisterTrace = unregisterTrace;
  scope.getActiveTraceState = getActiveTraceState;
  scope.persistTraceState = persistTraceState;
  scope.publishSourceTraceInitial = publishSourceTraceInitial;
  scope.isCompleteAbyssalTracePublicationReceipt = isCompleteAbyssalTracePublicationReceipt;
  scope.hasCommittedAbyssalFilamentConsumption = hasCommittedAbyssalFilamentConsumption;
  scope.canRecoverCreatedAbyssalTraceAfterRestart = canRecoverCreatedAbyssalTraceAfterRestart;
  scope.persistAbyssalTracePublicationState = persistAbyssalTracePublicationState;
  scope.ensureSourceTraceRuntime = ensureSourceTraceRuntime;
  scope.buildReturnedSourceTraceRetirementIdentity = buildReturnedSourceTraceRetirementIdentity;
  scope.revalidateReturnedSourceTraceRetirement = revalidateReturnedSourceTraceRetirement;
  scope.removeReturnedSourceTraceRepresentation = removeReturnedSourceTraceRepresentation;
  scope.finalizeReturnedSourceTraceRetirement = finalizeReturnedSourceTraceRetirement;
  scope.attemptReturnedSourceTraceRetirement = attemptReturnedSourceTraceRetirement;
  scope.removeOwnedSourceTrace = removeOwnedSourceTrace;
  scope.scheduleSourceTraceRemoval = scheduleSourceTraceRemoval;
  scope.transitionSourceTraceState = transitionSourceTraceState;
  scope.buildAbyssalTraceDeploymentToken = buildAbyssalTraceDeploymentToken;
  scope.isCreatedAbyssalTraceExpired = isCreatedAbyssalTraceExpired;
  scope.expireCreatedAbyssalTrace = expireCreatedAbyssalTrace;
  scope.scheduleCreatedAbyssalTraceExpiry = scheduleCreatedAbyssalTraceExpiry;
}

function initializeManagerGroup8Binding42(scope) {
  const abyssalRunWorkStore = new scope.AbyssalRunWorkStore();
  scope.abyssalRunWorkStore = abyssalRunWorkStore;
}

function initializeManagerGroup8Binding43(scope) {
  const {
  logPendingAbyssalTraceActivation,
  clearPendingAbyssalTraceActivationHandle,
  clearPendingAbyssalTraceActivation,
  pendingAbyssalTraceActivationSessionIsReady,
  pendingAbyssalTraceActivationMatchesSession,
  refreshPendingAbyssalTraceActivationFromValidation,
  deferPendingAbyssalTraceActivationForTransientState,
  executePendingAbyssalTraceActivation,
  armPendingAbyssalTraceActivation,
  schedulePendingAbyssalTraceActivation,
  claimPendingAbyssalTraceActivation,
  updatePendingAbyssalTraceActivation,
  completePendingAbyssalTraceActivation,
  pausePendingAbyssalTraceActivationForCharacter,
} = (0, scope.createAbyssalTraceActivation)({
  getDependencies: scope.getDependencies,
  abyssalTraceStateRegistry: scope.abyssalTraceStateRegistry,
  cloneValue: scope.cloneValue,
  log: scope.log,
  getSessionContext: scope.getSessionContext,
  isCompleteAbyssalTracePublicationReceipt: scope.isCompleteAbyssalTracePublicationReceipt,
  getActiveTraceState: scope.getActiveTraceState,
  buildAbyssalTraceDeploymentToken: scope.buildAbyssalTraceDeploymentToken,
  isCreatedAbyssalTraceExpired: scope.isCreatedAbyssalTraceExpired,
  expireCreatedAbyssalTrace: scope.expireCreatedAbyssalTrace,
  persistTraceState: scope.persistTraceState,
  validateAbyssalTraceActivation: (...args) => (0, scope.validateAbyssalTraceActivation)(...args),
  rollbackPendingAbyssalTraceActivation: (...args) => (0, scope.rollbackPendingAbyssalTraceActivation)(...args),
});
  scope.logPendingAbyssalTraceActivation = logPendingAbyssalTraceActivation;
  scope.clearPendingAbyssalTraceActivationHandle = clearPendingAbyssalTraceActivationHandle;
  scope.clearPendingAbyssalTraceActivation = clearPendingAbyssalTraceActivation;
  scope.pendingAbyssalTraceActivationSessionIsReady = pendingAbyssalTraceActivationSessionIsReady;
  scope.pendingAbyssalTraceActivationMatchesSession = pendingAbyssalTraceActivationMatchesSession;
  scope.refreshPendingAbyssalTraceActivationFromValidation = refreshPendingAbyssalTraceActivationFromValidation;
  scope.deferPendingAbyssalTraceActivationForTransientState = deferPendingAbyssalTraceActivationForTransientState;
  scope.executePendingAbyssalTraceActivation = executePendingAbyssalTraceActivation;
  scope.armPendingAbyssalTraceActivation = armPendingAbyssalTraceActivation;
  scope.schedulePendingAbyssalTraceActivation = schedulePendingAbyssalTraceActivation;
  scope.claimPendingAbyssalTraceActivation = claimPendingAbyssalTraceActivation;
  scope.updatePendingAbyssalTraceActivation = updatePendingAbyssalTraceActivation;
  scope.completePendingAbyssalTraceActivation = completePendingAbyssalTraceActivation;
  scope.pausePendingAbyssalTraceActivationForCharacter = pausePendingAbyssalTraceActivationForCharacter;
}

function initializeManagerGroup8Binding44(scope) {
  const abyssalPendingWorkRegistry = new scope.AbyssalPendingWorkRegistry();
  scope.abyssalPendingWorkRegistry = abyssalPendingWorkRegistry;
}

function initializeManagerGroup8Binding45(scope) {
  const { deployPlaceholderTrace } = (0, scope.createAbyssalTraceDeployment)({
  getDependencies: scope.getDependencies,
  resolveConfiguredUnusedTraceDurationMs: scope.resolveConfiguredUnusedTraceDurationMs,
  getObjectPosition: scope.getObjectPosition,
  normalizeDirection: scope.normalizeDirection,
  getObjectRadius: scope.getObjectRadius,
  resolveTypeRecord: scope.resolveTypeRecord,
  listAuthoritativeAbyssalFleetCharacterIDs: scope.listAuthoritativeAbyssalFleetCharacterIDs,
  cloneValue: scope.cloneValue,
  buildTraceCustomInfo: scope.buildTraceCustomInfo,
  buildAbyssalTraceDeploymentToken: scope.buildAbyssalTraceDeploymentToken,
  persistTraceState: scope.persistTraceState,
  destroyPlaceholderTrace: scope.destroyPlaceholderTrace,
  compensateFailedAbyssalDeployment: scope.compensateFailedAbyssalDeployment,
  publishSourceTraceInitial: scope.publishSourceTraceInitial,
  persistAbyssalTracePublicationState: scope.persistAbyssalTracePublicationState,
  registerTrace: scope.registerTrace,
  syncInventoryChanges: scope.syncInventoryChanges,
  getVectorDistance: scope.getVectorDistance,
  formatVectorForLog: scope.formatVectorForLog,
  log: scope.log,
  GROUP_FILAMENT_TRACE: scope.GROUP_FILAMENT_TRACE,
  ABYSSAL_PARTICIPANT_ROSTER_SCHEMA_VERSION: scope.ABYSSAL_PARTICIPANT_ROSTER_SCHEMA_VERSION,
  ABYSSAL_PARTICIPANT_STATUS: scope.ABYSSAL_PARTICIPANT_STATUS,
});
  scope.deployPlaceholderTrace = deployPlaceholderTrace;
}

function initializeManagerGroup8Binding46(scope) {
  const activeAbyssalRunRegistry = new scope.RunRegistry({
  getParticipantCharacterIDs(pocketState) {
    return (0, scope.normalizeAbyssalParticipantRoster)(pocketState)
      .filter(scope.isAbyssalParticipantIndexed)
      .map((participant) => participant.characterID);
  },
});
  scope.activeAbyssalRunRegistry = activeAbyssalRunRegistry;
}

function initializeManagerGroup8Binding47(scope) {
  const abyssalHostSlotAllocator = new scope.AbyssalHostSlotAllocator();
  scope.abyssalHostSlotAllocator = abyssalHostSlotAllocator;
}

function initializeManagerGroup8Binding48(scope) {
  const {
  persistAbyssalRewardPlan,
  persistObservedRunRewardAllocation,
  ensureObservedRunRewardAllocation,
  ensureAbyssalRewardPlan,
  resolveRewardContainerType,
  resolveExtractionNodeContainerType,
  resolveAbyssalStructureType,
  resolveRewardLootType,
  resolveAbyssalRewardGrantManifest,
  buildAbyssalRewardManifestReceiptKey,
  resolveInventoryItemLogicalQuantity,
  inspectAbyssalRewardContainerManifest,
  isTerminalAbyssalRewardMaterializationError,
  applyAbyssalBlueprintCopyStates,
  cleanupAbyssalBlueprintCopyStates,
  materializeAbyssalRewardStructureWreck,
  retryAbyssalRewardLootContainer,
  listAuthoritativeAbyssalRoomRewardArtifacts,
  removeDuplicateAbyssalRoomRewardArtifacts,
  summarizeAbyssalRewardContainerContents,
  failClosedAbyssalRewardArtifactReconciliation,
  retryPendingAbyssalRewardMaterializations,
  markRewardCacheUnavailable,
  getAbyssalRoomRewardSuppressionReason,
  suppressAbyssalRoomRewards,
  markRewardCacheConsumedOrRemoved,
  handleAbyssalRewardLootContainerRemoved,
  reconcileUntrackedAbyssalRewardCacheArtifacts,
  ensurePlaceholderRewardCache,
  reconcileObsoleteTranquilExtractionState,
  reconcileUntrackedAbyssalExtractionArtifacts,
  ensurePlaceholderExtractionNodes,
  markAbyssalRewardArtifactPersistenceFailure,
  commitAbyssalRewardArtifactDestructionOperationState,
  persistAndVerifyAbyssalRewardArtifactDestructionOperation,
  buildAbyssalRewardArtifactSnapshot,
  resolveAbyssalRewardArtifactKind,
  prepareAbyssalRuntimeArtifactDestruction,
  commitDurableAbyssalRewardArtifactSourceDestroyed,
  finalizeDurableAbyssalRewardArtifactOperation,
  reconcilePendingAbyssalRewardArtifactDestructions,
  finalizeResolvedAbyssalRewardArtifactDestructions,
  handleAbyssalRuntimeArtifactDestroyed,
  destroyRoomExtractionNodes,
  destroyRoomExtractionNodeLootContainers,
} = buildManagerGroup8Binding48Part1(scope);
  scope.persistAbyssalRewardPlan = persistAbyssalRewardPlan;
  scope.persistObservedRunRewardAllocation = persistObservedRunRewardAllocation;
  scope.ensureObservedRunRewardAllocation = ensureObservedRunRewardAllocation;
  scope.ensureAbyssalRewardPlan = ensureAbyssalRewardPlan;
  scope.resolveRewardContainerType = resolveRewardContainerType;
  scope.resolveExtractionNodeContainerType = resolveExtractionNodeContainerType;
  scope.resolveAbyssalStructureType = resolveAbyssalStructureType;
  scope.resolveRewardLootType = resolveRewardLootType;
  scope.resolveAbyssalRewardGrantManifest = resolveAbyssalRewardGrantManifest;
  scope.buildAbyssalRewardManifestReceiptKey = buildAbyssalRewardManifestReceiptKey;
  scope.resolveInventoryItemLogicalQuantity = resolveInventoryItemLogicalQuantity;
  scope.inspectAbyssalRewardContainerManifest = inspectAbyssalRewardContainerManifest;
  scope.isTerminalAbyssalRewardMaterializationError = isTerminalAbyssalRewardMaterializationError;
  scope.applyAbyssalBlueprintCopyStates = applyAbyssalBlueprintCopyStates;
  scope.cleanupAbyssalBlueprintCopyStates = cleanupAbyssalBlueprintCopyStates;
  scope.materializeAbyssalRewardStructureWreck = materializeAbyssalRewardStructureWreck;
  scope.retryAbyssalRewardLootContainer = retryAbyssalRewardLootContainer;
  scope.listAuthoritativeAbyssalRoomRewardArtifacts = listAuthoritativeAbyssalRoomRewardArtifacts;
  scope.removeDuplicateAbyssalRoomRewardArtifacts = removeDuplicateAbyssalRoomRewardArtifacts;
  scope.summarizeAbyssalRewardContainerContents = summarizeAbyssalRewardContainerContents;
  scope.failClosedAbyssalRewardArtifactReconciliation = failClosedAbyssalRewardArtifactReconciliation;
  scope.retryPendingAbyssalRewardMaterializations = retryPendingAbyssalRewardMaterializations;
  scope.markRewardCacheUnavailable = markRewardCacheUnavailable;
  scope.getAbyssalRoomRewardSuppressionReason = getAbyssalRoomRewardSuppressionReason;
  scope.suppressAbyssalRoomRewards = suppressAbyssalRoomRewards;
  scope.markRewardCacheConsumedOrRemoved = markRewardCacheConsumedOrRemoved;
  scope.handleAbyssalRewardLootContainerRemoved = handleAbyssalRewardLootContainerRemoved;
  scope.reconcileUntrackedAbyssalRewardCacheArtifacts = reconcileUntrackedAbyssalRewardCacheArtifacts;
  scope.ensurePlaceholderRewardCache = ensurePlaceholderRewardCache;
  scope.reconcileObsoleteTranquilExtractionState = reconcileObsoleteTranquilExtractionState;
  scope.reconcileUntrackedAbyssalExtractionArtifacts = reconcileUntrackedAbyssalExtractionArtifacts;
  scope.ensurePlaceholderExtractionNodes = ensurePlaceholderExtractionNodes;
  scope.markAbyssalRewardArtifactPersistenceFailure = markAbyssalRewardArtifactPersistenceFailure;
  scope.commitAbyssalRewardArtifactDestructionOperationState = commitAbyssalRewardArtifactDestructionOperationState;
  scope.persistAndVerifyAbyssalRewardArtifactDestructionOperation = persistAndVerifyAbyssalRewardArtifactDestructionOperation;
  scope.buildAbyssalRewardArtifactSnapshot = buildAbyssalRewardArtifactSnapshot;
  scope.resolveAbyssalRewardArtifactKind = resolveAbyssalRewardArtifactKind;
  scope.prepareAbyssalRuntimeArtifactDestruction = prepareAbyssalRuntimeArtifactDestruction;
  scope.commitDurableAbyssalRewardArtifactSourceDestroyed = commitDurableAbyssalRewardArtifactSourceDestroyed;
  scope.finalizeDurableAbyssalRewardArtifactOperation = finalizeDurableAbyssalRewardArtifactOperation;
  scope.reconcilePendingAbyssalRewardArtifactDestructions = reconcilePendingAbyssalRewardArtifactDestructions;
  scope.finalizeResolvedAbyssalRewardArtifactDestructions = finalizeResolvedAbyssalRewardArtifactDestructions;
  scope.handleAbyssalRuntimeArtifactDestroyed = handleAbyssalRuntimeArtifactDestroyed;
  scope.destroyRoomExtractionNodes = destroyRoomExtractionNodes;
  scope.destroyRoomExtractionNodeLootContainers = destroyRoomExtractionNodeLootContainers;
}

function bindAbyssalManagerRuntimeGroup8Operations(scope) {

}

function initializeAbyssalManagerRuntimeGroup8Part1(scope) {
  initializeManagerGroup8Binding1(scope);
  initializeManagerGroup8Binding2(scope);
  initializeManagerGroup8Binding3(scope);
  initializeManagerGroup8Binding4(scope);
  initializeManagerGroup8Binding5(scope);
  initializeManagerGroup8Binding6(scope);
  initializeManagerGroup8Binding7(scope);
  initializeManagerGroup8Binding8(scope);
  initializeManagerGroup8Binding9(scope);
  initializeManagerGroup8Binding10(scope);
  initializeManagerGroup8Binding11(scope);
  initializeManagerGroup8Binding12(scope);
  initializeManagerGroup8Binding13(scope);
  initializeManagerGroup8Binding14(scope);
  initializeManagerGroup8Binding15(scope);
  initializeManagerGroup8Binding16(scope);
  initializeManagerGroup8Binding17(scope);
  initializeManagerGroup8Binding18(scope);
  initializeManagerGroup8Binding19(scope);
  initializeManagerGroup8Binding20(scope);
  initializeManagerGroup8Binding21(scope);
  initializeManagerGroup8Binding22(scope);
  initializeManagerGroup8Binding23(scope);
  initializeManagerGroup8Binding24(scope);
  initializeManagerGroup8Binding25(scope);
  initializeManagerGroup8Binding26(scope);
  initializeManagerGroup8Binding27(scope);
  initializeManagerGroup8Binding28(scope);
  initializeManagerGroup8Binding29(scope);
  initializeManagerGroup8Binding30(scope);
  initializeManagerGroup8Binding31(scope);
  initializeManagerGroup8Binding32(scope);
  initializeManagerGroup8Binding33(scope);
  initializeManagerGroup8Binding34(scope);
  initializeManagerGroup8Binding35(scope);
  initializeManagerGroup8Binding36(scope);
  initializeManagerGroup8Binding37(scope);
  initializeManagerGroup8Binding38(scope);
  initializeManagerGroup8Binding39(scope);
  initializeManagerGroup8Binding40(scope);
  initializeManagerGroup8Binding41(scope);
  initializeManagerGroup8Binding42(scope);
  initializeManagerGroup8Binding43(scope);
  initializeManagerGroup8Binding44(scope);
  initializeManagerGroup8Binding45(scope);
  initializeManagerGroup8Binding46(scope);
  initializeManagerGroup8Binding47(scope);
  initializeManagerGroup8Binding48(scope);
}

function initializeAbyssalManagerRuntimeGroup8(scope) {
  initializeAbyssalManagerRuntimeGroup8Part1(scope);
}

module.exports = {
  bindAbyssalManagerRuntimeGroup8Operations,
  initializeAbyssalManagerRuntimeGroup8,
};
