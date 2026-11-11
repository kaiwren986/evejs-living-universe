"use strict";

const crypto = require("crypto");
const path = require("path");
const { performance } = require("perf_hooks");
const rotatingLog = require(path.join(__dirname, "../utils/rotatingLog"));
const syncLedger = require(path.join(__dirname, "../network/syncLedger"));
const spatialTrace = require(path.join(__dirname, "../network/spatialTrace"));
const tickProfiler = require(path.join(__dirname, "tickProfiler"));
const starbaseDefenseRuntime = require("../services/starbase/starbaseDefenseRuntime");
const persistenceRoles = require(path.join(
  __dirname,
  "../gameStore/persistenceRoles",
));
const {
  MAX_GATE_ACTIVATION_SURFACE_DISTANCE_METERS,
} = require("../abyssal").engineSupport.gateActivationRange;
const {
  ABYSSAL_LOCATION_ID_MIN,
  ABYSSAL_LOCATION_ID_COUNT,
  isAbyssalHostLocationID,
} = require("../abyssal").engineSupport.hostLocation;
const {
  ABYSSAL_ROOM_ENTITY_ROLES,
  resolveAbyssalRoomEntityRole,
  applyAbyssalRoomEntityMetadata,
  summarizeAbyssalRoomEntities,
  formatAbyssalRoomEntityCountsForLog,
} = require("../abyssal").engineSupport.roomEntityRoles;
const {
  recordSuppressorMissileImpactBlocked,
  recordSuppressorMissileNormalImpact,
} = require("../abyssal").engineSupport.suppressorDiagnostics;
const config = require(path.join(__dirname, "../config"));
const log = require(path.join(__dirname, "../utils/logger"));
const {
  TYPE_ABYSSAL_TRACE,
  applyAbyssalGatePresentationState,
  applyAbyssalTracePresentationState,
} = require("../abyssal").engineSupport.gatePresentation;
const {
  ABYSSAL_TRACE_LIFECYCLE_PHASE,
  applyAbyssalTraceProfileToEntity,
  resolveAbyssalTraceProfile,
} = require("../abyssal").engineSupport.traceProfiles;
const {
  resolveRestrictionCharacterID,
  resolveRestrictionShipID,
  resolveActiveRunPocketState,
  buildRunRestriction,
  resolveAbyssalRunActivationRestriction,
} = require("../abyssal").engineSupport.activationRules;
const {
  createAbyssalInventoryClassifier,
} = require("../abyssal").engineSupport.inventoryClassification;
const {
  buildAbyssalTraceSessionIdentity,
  getAbyssalTracePublicationReceiptMap,
  getAbyssalTracePublicationReceipt,
  buildAbyssalTracePublicationReceipt,
  storeAbyssalTracePublicationReceipt,
  abyssalTracePublicationReceiptMatchesSession,
} = require("../abyssal").engineSupport.tracePublicationReceipts;
const {
  resolveAbyssalSceneAuthority,
} = require("../abyssal").engineSupport.sceneKey;
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
} = require(path.join(__dirname, "../services/inventory/itemStore"));
const {
  findItemById,
  findShipItemById,
  listContainerItems,
  listSystemSpaceItems,
  warmSimulationInventoryProjection,
} = require(path.join(
  __dirname,
  "../services/inventory/simulationInventoryProjection",
));
const {
  resolveRuntimeWreckRadius,
  resolveRuntimeWreckStructureFallbackHP,
} = require(path.join(__dirname, "../services/inventory/wreckRadius"));
const {
  resolveItemByTypeID,
} = require(path.join(__dirname, "../services/inventory/itemTypeRegistry"));
const {
  resolveStargatePhysicalRadius,
} = require(path.join(__dirname, "./stargateRadius"));
const {
  getStargateVisualOverrideField,
} = require(path.join(__dirname, "./stargateVisualOverrides"));
const {
  buildDunRotationFromNormalizedDirection: buildStargateDunRotationFromDirection,
  getStargateSystemForwardDirection,
} = require(path.join(__dirname, "./stargateOrientation"));
const {
  getClientParityWarpInPoint,
} = require(path.join(__dirname, "./destiny/simulation/warpInPointParity"));
const {
  entityIDsEqual,
  getEntityMapKey,
  normalizeEntityID,
  normalizeEntityIDSet,
  normalizeNonNegativeInt64,
  normalizePersistentEntityID,
  toJSONSafeEntityID,
} = require(path.join(__dirname, "./destiny/identity/entityID.js"));
const {
  canEntitiesInteractLocally,
  isSharedPveTarget,
  resolveEntityInteractionScope,
} = require(path.join(__dirname, "./destiny/identity/interactionScope.js"));
const {
  resolveExactAbyssalNpcOutcomeContext,
} = require(path.join(
  __dirname,
  "../services/_shared/abyssalNpcOutcomePolicy.js",
));
const {
  getPayloadPrimaryEntityID: getExactPayloadPrimaryEntityID,
} = require(path.join(__dirname, "./destiny/protocol/payloadIdentity.js"));
const {
  buildFleetWarpCommandAssociationPlan,
  clearFleetWarpCommandAssociation,
  commitFleetWarpCommandAssociationPlan,
  getFleetWarpCommandAssociation,
  haveSameFleetWarpCommandAssociation,
  isFleetWarpInProgress,
} = require(path.join(
  __dirname,
  "../services/fleets/fleetWarpCommandAssociation.js",
));
const {
  buildInitialBallparkEntityPlan,
} = require(path.join(__dirname, "./destiny/bootstrap/initialBallpark.js"));
const {
  buildCloakBallPresentationUpdates,
  buildCloakDeliveryPresentationUpdates,
  buildDamageStatePresentationUpdates,
  buildDbuffPresentationUpdates,
  buildOwnerUncloakPresentationUpdates,
  buildSingleSpecialFxPresentationUpdates,
  buildSlimItemPresentationUpdates,
  buildStructureLifecyclePresentationUpdates,
  buildTetherPresentationUpdates,
  buildUncloakDeliveryPresentationUpdates,
  createSpecialFxPayloadPresentation,
} = require(path.join(
  __dirname,
  "./destiny/presentation/specialFxPayloads.js",
));
const {
  buildActiveSpecialFxEffectStateEntriesForSetState:
    buildActiveSpecialFxEffectStateEntriesForSetStatePlan,
  buildFreshAcquireActiveSpecialFxReplayUpdates:
    buildFreshAcquireActiveSpecialFxReplayUpdatesPlan,
  shouldReplayActiveSpecialFxForFreshAcquire:
    shouldReplayActiveSpecialFxForFreshAcquirePlan,
} = require(path.join(
  __dirname,
  "./destiny/presentation/activeSpecialFxReplay.js",
));
const {
  buildAddBallsPresentationUpdates,
  buildInitialBootstrapAddBallsPresentationUpdate:
    buildInitialBootstrapAddBallsPresentationUpdatePlan,
  buildInitialBootstrapSetStatePresentationUpdate:
    buildInitialBootstrapSetStatePresentationUpdatePlan,
} = require(path.join(
  __dirname,
  "./destiny/presentation/addBalls.js",
));
const {
  resolveFreshAcquireBootstrapModeUpdates,
} = require(path.join(
  __dirname,
  "./destiny/presentation/freshAcquire.js",
));
const {
  buildDockingAcceptedNotificationPayload,
  buildModePresentationUpdates,
  buildOrdinaryDockingStopPresentationUpdates,
  buildSetBallFreePresentationUpdates,
  buildStructureDockingTransitionUpdates:
    buildStructureDockingTransitionPresentationUpdates,
  buildTeleportStopPresentationUpdates,
} = require(path.join(
  __dirname,
  "./destiny/presentation/mode.js",
));
const {
  buildTerminalDestructionRemoveBallsPresentationUpdates,
} = require(path.join(
  __dirname,
  "./destiny/presentation/removeBalls.js",
));
const {
  buildShipPrimeDeltaUpdates,
  buildShipPrimeUpdatesForEntities,
  buildUndockBootstrapMovementUpdates:
    buildUndockBootstrapMovementPresentationUpdates,
} = require(path.join(
  __dirname,
  "./destiny/presentation/shipPrime.js",
));
const defaultEmpireScenery = require(path.join(__dirname, "./defaultEmpireScenery"));
const authoredSpaceProps = require(path.join(__dirname, "./authoredSpaceProps"));
const planetOrbitalState = require(path.join(__dirname, "../services/planet/planetOrbitalState"));
const deployableCynoRuntime = require(path.join(__dirname, "../services/ship/deployableCynoRuntime"));
const mobileAnalysisBeaconRuntime = require(path.join(__dirname, "../services/ship/mobileAnalysisBeaconRuntime"));
const mobileCynoInhibitorRuntime = require(path.join(__dirname, "../services/ship/mobileCynoInhibitorRuntime"));
const mobileDepotRuntime = require(path.join(__dirname, "../services/ship/mobileDepotRuntime"));
const mobileMicroJumpUnitRuntime = require(path.join(__dirname, "../services/ship/mobileMicroJumpUnitRuntime"));
const mobileObservatoryRuntime = require(path.join(__dirname, "../services/ship/mobileObservatoryRuntime"));
const mobilePhaseAnchorRuntime = require(path.join(__dirname, "../services/ship/mobilePhaseAnchorRuntime"));
const mobileScanInhibitorRuntime = require(path.join(__dirname, "../services/ship/mobileScanInhibitorRuntime"));
const mobileSiphonUnitRuntime = require(path.join(__dirname, "../services/ship/mobileSiphonUnitRuntime"));
const mobileTractorUnitRuntime = require(path.join(__dirname, "../services/ship/mobileTractorUnitRuntime"));
const mobileWarpDisruptorRuntime = require(path.join(__dirname, "../services/ship/mobileWarpDisruptorRuntime"));
const interdictionProbeRuntime = require(path.join(__dirname, "../services/ship/interdictionProbeRuntime"));
const surveyProbeRuntime = require(path.join(
  __dirname,
  "../services/exploration/probes/surveyProbeRuntime",
));
const warpDisruptFieldGeneratorRuntime = require(path.join(
  __dirname,
  "../services/ship/warpDisruptFieldGeneratorRuntime",
));
const {
  getAppliedSkinMaterialSetID,
} = require(path.join(__dirname, "../services/ship/shipCosmeticsState"));
const {
  sendOnMultiEvent,
} = require(path.join(__dirname, "../services/_shared/godmaMultiEvent"));
const {
  getEnabledCosmeticsEntries,
} = require(path.join(__dirname, "../services/ship/shipLogoFittingState"));
const shipStanceRuntime = require(path.join(__dirname, "../services/ship/shipStanceRuntime"));
const {
  getModulesInBank: getGroupedWeaponBankModuleIDs,
  getMasterModuleID: getGroupedWeaponBankMasterID,
} = require(path.join(__dirname, "../services/moduleGrouping/moduleGroupingRuntime"));
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
} = require(path.join(__dirname, "../services/fitting/liveFittingState"));
const {
  buildLiveModuleAttributeMap,
} = require(path.join(__dirname, "./modules/liveModuleAttributes"));
const {
  getActiveImplantLocationModifierSources,
  getActiveImplantShipModifierEntries,
} = require(path.join(
  __dirname,
  "../services/dogma/implants/activeImplantModifiers",
));
const {
  getCachedCharacterSkillMap,
} = require(path.join(__dirname, "../services/skills/skillState"));
const {
  updateCharacterRecord,
} = require(path.join(__dirname, "../services/character/characterState"));
const {
  isNativeNpcEntity,
  getNpcFittedModuleItems,
  getNpcLoadedChargeForModule,
  getNpcWeaponModules,
  buildNpcWeaponModuleSnapshot,
  getNpcHostileModules,
  getNpcAssistanceModules,
  getNpcSelfModules,
  getNpcSuperweaponModules,
  getNpcPropulsionModules,
} = require(path.join(__dirname, "./npc/npcEquipment"));
const {
  logNpcCombatDebug,
  summarizeNpcCombatEntity,
  summarizeNpcCombatModule,
} = require(path.join(__dirname, "./npc/npcCombatDebug"));
const {
  buildStartupPresenceSummary,
  getSceneActivityState,
} = require(path.join(__dirname, "./npc/npcSceneActivity"));
const {
  materializeAmbientStartupControllersForScene,
  dematerializeAmbientStartupControllersForScene,
} = require(path.join(__dirname, "./npc/npcAmbientMaterialization"));
const {
  PILOT_WARP_ACTIVATION_DELAY_DESTINY_TICKS,
  PILOT_WARP_DESTINATION_ACQUIRE_LEAD_DESTINY_TICKS,
  PILOT_WARP_DESTINATION_STATIC_PRELOAD_DISTANCE_METERS,
  PILOT_WARP_HISTORY_SAFE_DESTINY_LEAD,
  PILOT_WARP_SOURCE_REMOVAL_SETTLE_MS,
} = require(path.join(__dirname, "./destiny/simulation/warpContract.js"));
const {
  tagUpdatesRequireExistingVisibility,
  buildDirectedMovementUpdates,
  buildPointMovementUpdates,
} = require(path.join(__dirname, "./destiny/dispatch/dispatchUtils.js"));
const {
  cloneDynamicEntityForDestinyPresentation,
} = require(path.join(__dirname, "./destiny/projection/entityProjection.js"));
const {
  createScenePositionAuthority,
} = require(path.join(__dirname, "./destiny/authority/scenePositionAuthority.js"));
const {
  getEntitySurfaceDistance: getDestinyEntitySurfaceDistance,
  getEntityTargetingRadius: getDestinyEntityTargetingRadius,
} = require(path.join(__dirname, "./destiny/projection/range.js"));
const {
  createDestinyWarpTargetPlanner,
} = require(path.join(__dirname, "./destiny/simulation/warpTargets.js"));
const {
  createDestinyMotionStateHelpers,
} = require(path.join(__dirname, "./destiny/simulation/motionState.js"));
const {
  createMovementSubwarpCommands,
} = require(path.join(__dirname, "./destiny/commands/subwarpCommands.js"));
const {
  createMovementWarpCommands,
} = require(path.join(__dirname, "./destiny/commands/warpCommands.js"));
const {
  createMovementStopSpeedCommands,
} = require(path.join(__dirname, "./destiny/commands/stopSpeedCommands.js"));
const {
  applyPendingDockStateCommand,
} = require(path.join(__dirname, "./destiny/commands/docking.js"));
const {
  applyTeleportRelocationMotionCommand,
} = require(path.join(__dirname, "./destiny/commands/teleport.js"));
const {
  applyPassiveMotionBaseCommand,
  applyPassiveMotionTimingCommand,
  applyPropulsionMotionBaseCommand,
  applyPropulsionMotionTimingCommand,
  restoreCommandedSpeedFractionCommand,
} = require(path.join(__dirname, "./destiny/commands/shipDerivedMotion.js"));
const {
  materializeDormantCombatControllersForScene,
  dematerializeDormantCombatControllersForScene,
} = require(path.join(__dirname, "./npc/npcCombatDormancy"));
const {
  isAnchorRelevanceEnabled,
  hasStartupAnchorRelevanceContext,
  syncRelevantStartupControllersForScene,
  prewarmStartupControllersForWarpDestination,
} = require(path.join(__dirname, "./npc/npcAnchorRelevance"));
const {
  buildNpcEffectiveModuleItem,
} = require(path.join(__dirname, "./npc/npcCapabilityResolver"));
const nativeNpcStore = require(path.join(__dirname, "./npc/nativeNpcStore"));
const {
  currentFileTime,
  buildFiletimeLong,
  buildMarshalReal,
} = require(path.join(__dirname, "../services/_shared/serviceHelpers"));
const mapTelemetryState = require(path.join(
  __dirname,
  "../services/map/mapTelemetryState",
));
const commandBurstRuntime = require(path.join(
  __dirname,
  "./modules/commandBurstRuntime",
));
const {
  collectNumericModuleAttributeDiffs,
  resolveModuleSnapshotDirectModifierEntries,
} = require(path.join(
  __dirname,
  "./modules/moduleAttributeDiff",
));
const hudIconRuntime = require(path.join(
  __dirname,
  "./modules/hudIconRuntime",
));
const assistanceModuleRuntime = require(path.join(
  __dirname,
  "./modules/assistanceModuleRuntime",
));
const hostileModuleRuntime = require(path.join(
  __dirname,
  "./modules/hostileModuleRuntime",
));
const jammerModuleRuntime = require(path.join(
  __dirname,
  "./modules/jammerModuleRuntime",
));
const smartbombRuntime = require(path.join(
  __dirname,
  "./modules/smartbombRuntime",
));
const targetingModuleRuntime = require(path.join(
  __dirname,
  "./modules/targetingModuleRuntime",
));
const entosisLinkRuntime = require(path.join(
  __dirname,
  "./modules/entosisLinkRuntime",
));
const scannerModuleRuntime = require(path.join(
  __dirname,
  "./modules/scannerModuleRuntime",
));
const reactiveArmorHardenerRuntime = require(path.join(
  __dirname,
  "./modules/reactiveArmorHardenerRuntime",
));
const pointDefenseRuntime = require(path.join(
  __dirname,
  "./modules/pointDefenseRuntime",
));
const microJumpDriveRuntime = require(path.join(
  __dirname,
  "./modules/microJumpDriveRuntime",
));
const tractorBeamRuntime = require(path.join(
  __dirname,
  "./modules/tractorBeamRuntime",
));
const salvagerRuntime = require(path.join(
  __dirname,
  "./modules/salvagerRuntime",
));
const genericModuleFuelRuntime = require(path.join(
  __dirname,
  "./modules/genericModuleFuelRuntime",
));
const remoteRepairShowRuntime = require(path.join(
  __dirname,
  "../RemoteRepShow/remoteRepairShowRuntime",
));
const structureState = require(path.join(
  __dirname,
  "../services/structure/structureState",
));
const {
  STRUCTURE_STATE,
} = require(path.join(
  __dirname,
  "../services/structure/structureConstants",
));
const sessionRegistry = require(path.join(
  __dirname,
  "../services/chat/sessionRegistry",
));
const {
  buildStructureHangarViewState,
} = require(path.join(
  __dirname,
  "../services/structure/structureHangarViewState",
));
const {
  resolveStructureEffectiveHitpoints,
} = require(path.join(
  __dirname,
  "../services/structure/structureFullPowerDogma",
));
const structureLocatorGeometry = require(path.join(
  __dirname,
  "../services/structure/structureLocatorGeometry",
));
const stationLocatorGeometry = require(path.join(
  __dirname,
  "../services/station/stationLocatorGeometry",
));
const {
  isEntityInActiveWarp,
} = require(path.join(__dirname, "./destiny/simulation/warpPhase"));
const structureTethering = require(path.join(
  __dirname,
  "./structureTethering",
));
const worldData = require(path.join(__dirname, "./worldData"));
const destiny = require(path.join(__dirname, "./destiny/index.js"));
const {
  applyResolvedDamageAmountToEntity,
  buildLiveDamageState,
  hasDamageableHealth,
  getEntityCurrentHealthLayers,
  getEntityMaxHealthLayers,
  sumDamageVector,
} = require(path.join(__dirname, "./combat/damage"));
const {
  buildWeaponModuleSnapshot,
  isChargeOptionalTurretWeapon,
  isMissileWeaponFamily,
  isVortonWeaponFamily,
  isTurretCycleWeaponFamily,
  isDefenderMissileWeaponSnapshot,
  resolveWeaponFamily,
  resolveWeaponSpecialFxGUID,
} = require(path.join(__dirname, "./combat/weaponDogma"));
const {
  resolveTurretShot,
  resolveTurretHitQualityTier,
} = require(path.join(__dirname, "./combat/laserTurrets"));
const {
  resolveVortonShot,
  resolveVortonArcShot,
  selectVortonArcTargets,
  isVortonArcTargetKind,
} = require(path.join(__dirname, "./combat/vortonProjectors"));
const {
  ATTRIBUTE_DAMAGE_MULTIPLIER_BONUS_CURRENT,
  ATTRIBUTE_DAMAGE_MULTIPLIER_BONUS_MAX_TIMESTAMP,
  isPrecursorTurretFamily,
  initializePrecursorTurretEffectState,
  synchronizePrecursorTurretEffectState,
  advancePrecursorTurretSpool,
  resetPrecursorTurretSpool,
  buildPrecursorTurretGraphicInfo,
  applyPrecursorTurretSpoolToSnapshot,
} = require(path.join(__dirname, "./combat/precursorTurrets"));
const {
  estimateMissileEffectiveRange,
  estimateMissileClientImpactTimeMs,
  resolveMissileClientVisualProfile,
  estimateMissileFlightBudgetMs,
  resolveMissileAppliedDamage,
} = require(path.join(__dirname, "./combat/missiles/missileSolver"));
const {
  flushDogmaReloadsAtSimTime,
  queueAutomaticMissileReload,
  resolvePendingMissileReload,
} = require(path.join(__dirname, "./combat/missiles/missileReloads"));
const {
  prepareLocalCycleActivation,
  prepareLocalCycleBoundary,
  executeLocalCycle,
  queueAncillaryLocalReloadOnManualDeactivate,
} = require(path.join(__dirname, "./modules/localCycleRuntime"));
const {
  queueAutomaticLocalModuleReload,
  resolvePendingLocalModuleReload,
} = require(path.join(__dirname, "./modules/localCycleReloads"));
const wormholeEnvironmentRuntime = require(path.join(
  __dirname,
  "../services/exploration/wormholes/wormholeEnvironmentRuntime",
));
const {
  buildSuperweaponFreshAcquireFxOptions,
  prepareSuperweaponActivation,
  executeSuperweaponActivation,
  finalizeSuperweaponDeactivation,
  isSuperweaponFxReplayWindowActive,
  tickScene: tickSuperweaponScene,
  isSuperweaponMovementLocked,
  isSuperweaponJumpOrCloakLocked,
  entityHasCloakDisallowingFittedModule,
} = require(path.join(__dirname, "./modules/superweapons/superweaponRuntime"));
const {
  isEntityDisruptiveLanceDebuffed,
} = require(path.join(__dirname, "./modules/superweapons/disruptiveLanceDebuff"));
const {
  noteDamage: noteKillmailDamage,
  resolveHighestDamageAttacker,
  enqueueKillmailFromDestruction: recordKillmailFromDestruction,
  recoverPendingKillmailWork,
} = require(path.join(__dirname, "./combat/killmailTracker"));

// Declarations moved into server/src/space/runtime/. They are required here in load
// order, so every value they build is ready before anything below can read it.
const state = require("./runtime/state");
const {
  SolarSystemScene,
} = require("./runtime/solarSystemScene");
const {
  DEFAULT_PASSIVE_SHIELD_RECHARGE_ENABLED,
  SYNTHETIC_RUNTIME_ENTITY_ID_START,
} = require("./runtime/state");
require("./runtime/stargateJumpRange");
const {
  OWNS_WORLD_SIMULATION,
  lazyRequire,
} = require("./runtime/runtimeModuleBoundary");
const {
  buildPublicGridKey,
} = require("./runtime/visibility");
const {
  ABYSSAL_TELEPORT_TRANSITION_BYPASS,
  applyCapturedRetailIdentityFromState,
  getInventoryAbyssalPlayerCompanionInfo,
  getInventoryAbyssalRunOwnership,
  isAbyssalVisualOnlyEntity,
  shouldHydrateInventoryItemIntoScene,
  summarizeAbyssalBootstrapInventory,
} = require("./runtime/abyssalRoomEntity");
const {
  SCENE_KIND_ABYSSAL,
  SCENE_KIND_SOLAR_SYSTEM,
  allocateAbyssalLocationID,
  buildAbyssalSceneKey,
  buildSolarSystemSceneKey,
  decorateEntitySceneOwnership,
  getSceneKeyForSession,
  normalizeSceneDescriptor,
  normalizeSceneText,
} = require("./runtime/sceneIdentity");
const {
  allocateRuntimeEntityID,
  applyRuntimeEntitySpawnMetadata,
} = require("./runtime/runtimeEntityIdentity");
const {
  buildChangedStructureRows,
  notifyDockedStructureHangarViewSessions,
  syncRuntimeStructureStateChanges,
} = require("./runtime/structureLifecycleFanout");
require("./runtime/characterStateBridge");
require("./runtime/squadronRuntimeBridge");
const {
  resolveTurretShotWithConfiguredAdditive,
} = require("./runtime/weaponSnapshot");
const {
  clearTrackingState,
  getStationWarpTargetPosition,
  getWarpStopDistanceForTarget,
  isInvalidDestinyFollowOrbitCommand,
  resetEntityMotion,
  resolveStargateWarpTarget,
} = require("./runtime/destinyMovementEngine");
const {
  FILETIME_TICKS_PER_MS,
  RUNTIME_TICK_INTERVAL_MS,
  getMonotonicTimeMs,
  getWallclockNowMs,
  setWallclockNowProvider,
} = require("./runtime/runtimeClock");
const {
  magnitude,
} = require("../common/vector");
const {
  deriveAgilitySeconds,
} = require("./runtime/shipMotionKinematics");
const {
  notifyRuntimeChargeTransitionToSession,
} = require("./runtime/loadedChargeState");
const {
  STARGATE_ACTIVATION_STATE,
  STARGATE_ACTIVATION_TRANSITION_MS,
  buildObserverStargateJumpFxOptions,
  buildStaticMoonMiningBeaconEntity,
  buildStaticPlanetOrbitalEntity,
  buildStaticStargateEntity,
  buildStaticStructureEntity,
  coerceActivationState,
  coerceStableActivationState,
  getSharedWorldPosition,
  getStargateDerivedDunRotation,
} = require("./runtime/staticSceneEntity");
const {
  RUNTIME_CORPSE_KIND,
  RUNTIME_UNANCHORED_STRUCTURE_HULL_KIND,
  buildRuntimeInventoryEntity,
  buildRuntimeSpaceEntityFromItem,
  isInventoryBackedDynamicEntity,
  isInventoryItemEligibleForSceneSpawn,
  refreshInventoryBackedEntityPresentationFields,
} = require("./runtime/inventorySpaceEntity");
const {
  EMPTY_SOLAR_SYSTEM_COLLECTION_GRACE_MS,
  EMPTY_SOLAR_SYSTEM_COLLECTION_MAX_PER_SWEEP,
  EMPTY_SOLAR_SYSTEM_COLLECTION_SWEEP_INTERVAL_MS,
  EMPTY_SOLAR_SYSTEM_RETAINED_OBJECT_GRACE_MS,
  NEW_EDEN_SYSTEM_LOADING,
  STARTUP_PRELOADED_SYSTEM_IDS,
  getEmptySolarSystemRetainedObjectState,
} = require("./runtime/solarSystemSceneLifecycle");
const {
  DEFAULT_STATION_DOCKING_RADIUS,
  buildDockingDebugState,
  canShipDockAtStation,
  getStationInteractionRadius,
  getStationUndockSpawnState,
} = require("./runtime/stationDockingGeometry");
const {
  ATTACH_UNIVERSE_SITE_RECONCILE_DELAY_MS,
  BUBBLE_DEBUG_ENTITY_ID_SAMPLE_LIMIT,
  DEBUG_TEST_AUTO_TARGET_DEFAULT_RANGE_METERS,
  beginSessionJumpTimingTrace,
  isBubbleDebugEnabled,
  isMissileDebugEnabled,
  recordSessionJumpTimingTrace,
  resolveDebugTestNearestStationTarget,
  shouldLogMissilePayloadGroup,
  summarizeBubbleState,
} = require("./runtime/runtimeDebugInstrumentation");
const {
  isEntityActiveWarpInFlight,
} = require("./runtime/shipCloak");
const {
  getEntityRuntimeActiveModuleContexts,
} = require("./runtime/entityDogmaView");
const {
  applyJammerCyclePresentation,
  removeJammerCyclePresentation,
} = require("./runtime/hudIconStates");
const {
  buildMissileDynamicEntity,
} = require("./runtime/missileEntity");
const {
  advancePassiveRechargeRatio,
  applyPassiveResourceStateToEntity,
  resolveModifiedWarpSpeedAU,
} = require("./runtime/passiveDerivedState");
const {
  getPropulsionModuleRuntimeAttributes,
} = require("./runtime/propulsionModule");
const {
  isReadyForDestiny,
} = require("./runtime/destinyDeliveryEligibility");
const {
  getGenericModuleRuntimeAttributes,
  resolveEffectiveModuleReloadTimeMs,
} = require("./runtime/moduleAttributes");
const {
  buildHostileModuleRuntimeCallbacks,
  buildMicroJumpDriveRuntimeCallbacks,
  buildSalvagerRuntimeCallbacks,
} = require("./runtime/moduleRuntimeCallbacks");
const {
  isShipMovementLockedByRuntime,
} = require("./runtime/shipActionRestrictions");
const {
  computeTargetLockDurationMs,
} = require("./runtime/targeting");
require("./runtime/autoTargetingMissiles");
const {
  buildAttributeChange,
  buildEntityDerivedAttributeSnapshot,
  captureFittedGenericModuleAttributeSnapshots,
  notifyCapacitorChangeToSession,
  notifyShipDerivedAttributesToSession,
} = require("./runtime/attributeChangeNotification");
const {
  hasActiveIndustrialCoreEffect,
  resolveCompressionFacilityRangeMeters,
  resolveCompressionFacilityTypelistsForEntity,
} = require("./runtime/industrialCore");
require("./runtime/cynosuralField");
const {
  resolveSpecialFxRepeatCount,
} = require("./runtime/activeModuleSpecialFx");
const {
  MODULE_CONSEQUENCE_DELIVERY,
  normalizeModuleConsequenceDelivery,
  resolveModuleConsequenceDelivery,
} = require("./runtime/moduleConsequenceDelivery");
const {
  persistDynamicEntity,
  persistInventoryBackedEntity,
  persistShipEntity,
  serializeSpaceState,
  shouldPersistShipEntityAtTick,
} = require("./runtime/entitySpacePersistence");
const {
  roundNumber,
  toFiniteNumber,
  toInt,
} = require("../common/numbers");
require("./runtime/marshalWireValues");
const {
  autoMaterializeNearbyUniverseSiteForAttach,
} = require("./runtime/universeSiteAttach");
const {
  getSecurityStatusIconKey,
} = require("./runtime/systemSecurityBand");
const {
  formatStartupBootstrapMetrics,
  getConfiguredStartupSystemLoadingMode,
  getStartupPreloadSystemLabel,
  keepsAllStargatesActiveDuringLazyLoading,
  resolveAlwaysOnSolarSystemIDs,
  resolveStartupPreloadedSystemIDs,
  resolveStartupSolarSystemPreloadPlan,
  shouldLogStartupPreloadCheckpoint,
} = require("./runtime/startupPreloadPlan");
const {
  hasKnownNativeControllerSceneRematerializer,
  hasValidDungeonNativeSceneOwner,
  storedNativeRecordBelongsToSolarSystemScene,
} = require("./runtime/nativeRecordSceneOwnership");
const {
  buildRuntimeShipEntity,
  buildShipEntity,
  clearSessionStateFromShipEntity,
  isPlayerOwnedActiveSpaceShipRecord,
  refreshEntitiesForSlimPayload,
  refreshShipPresentationFields,
  resolveShipSkinMaterialSetID,
} = require("./runtime/shipEntity");
require("./runtime/moduleHeat");
const {
  isCommandBurstRecipientEligible,
  isCommandBurstWeaponTimerExempt,
  isHighsecNeutralCommandBurstRecipientRestricted,
  recordCommandBurstWeaponTimer,
} = require("./runtime/commandBurst");
require("./runtime/moduleCycleBoundarySnapshot");
require("./runtime/crimewatchAdapter");
const {
  isDroneAssistEligibleTargetedOffensiveEffect,
  noteDroneAssistSuccessfulOffensiveCycle,
} = require("./runtime/droneAssistOffensiveNotice");
require("./runtime/entityDistance");
const {
  collectEntityActiveShipAttributeModifierEntries,
  noteReactiveArmorHardenerDamage,
} = require("./runtime/activeShipModifiers");
const {
  buildBankedWeaponSnapshot,
} = require("./runtime/groupedWeaponBank");
require("./runtime/moduleChargeReload");
const {
  buildSpecialFxDestinyUpdates,
  resolveGenericModuleSpecialFxGuid,
  resolveSpecialFxOptionsForEntity,
  splitSpecialFxGuids,
} = require("./runtime/moduleSpecialFx");
require("./runtime/microJumpDriveEligibility");
const {
  buildDeferredOwnerMissileAcquireOptions,
} = require("./runtime/firstSightPresentation");
const {
  applyRuntimeEntityScopeMetadata,
  clearPlayerShipGenericDungeonScope,
} = require("./runtime/entityScopeTags");
const {
  buildStructureObserverSpaceState,
} = require("./runtime/structureSessionHost");
require("./runtime/typeAttributeLookup");
require("./runtime/entityCapacitor");
require("./runtime/structureTether");
const {
  TIMED_INVULNERABILITY_KIND_ABYSSAL_RETURN,
  TIMED_INVULNERABILITY_KIND_UNDOCK,
  breakEntityTimedInvulnerability,
  breakUndockInvulnerability,
  clearEntityTimedInvulnerability,
  clearPendingTimedInvulnerabilityTimers,
  grantEntityTimedInvulnerability,
  isEntityTimedInvulnerable,
  isEntityUndockInvulnerable,
} = require("./runtime/timedInvulnerability");
require("./runtime/sessionNotificationTime");
const {
  ForceFieldIndexedEntityMap,
  isShipInsideForceField,
  listCommandBurstForceFields,
} = require("./runtime/forceFieldContainment");
const {
  notifyGenericModuleEffectState,
  notifyModuleEffectState,
} = require("./runtime/godmaShipEffectNotification");
const {
  isActivatableEffectRecord,
} = require("./runtime/moduleActivationEffectRecord");
require("./runtime/shipModuleFuel");
require("./runtime/entosisCapture");
require("./runtime/moduleCycleSchedule");
require("./runtime/moduleEffectShutdown");
require("./runtime/dogmaAttributeIds");
const {
  destroyCombatEntity,
  recordNpcBountyForCombatDestruction,
} = require("./runtime/combatDestruction");
const {
  broadcastDamageStateChange,
  buildShipHealthTransitionResult,
  healShipResourcesForSession,
  notifyShipHealthAttributesToSession,
} = require("./runtime/shipHealthState");
const {
  buildEnvironmentalDamageMessagePayload,
  buildLaserDamageMessagePayload,
  getAppliedDamageAmount,
  getCombatMessageHitQuality,
  notifyWeaponDamageMessages,
} = require("./runtime/combatDamageMessages");
require("./runtime/entityOwnerSession");
const {
  applyResolvedEnvironmentalDamageToTarget,
  applyWeaponDamageToTarget,
} = require("./runtime/targetDamageApplication");
require("./runtime/vortonArcChain");
const {
  queueAutomaticNpcTurretReload,
} = require("./runtime/weaponCycle");
const {
  markInventoryEntityLootAbandoned,
  sessionHasInventoryLootRight,
  sessionMayAbandonInventoryLoot,
} = require("./runtime/inventoryLootRights");
require("./runtime/inventoryCustomInfo");
require("./runtime/minHeap");
require("./runtime/abyssalServicePort");
const {
  noteAbyssalNpcStandingsSuppression,
  notifyAbyssalEnvironmentalObjectDestroyedSafe,
  notifyAbyssalNpcDestroyedFromContext,
  notifyAbyssalNpcsDestroyedFromContexts,
  resolveAbyssalNpcRuntimePolicy,
  resolveAbyssalNpcStandingsSuppressionResult,
} = require("./runtime/abyssalRunReporting");
const {
  resolveAbyssalCloakActivationRestriction,
  resolveAbyssalTeleportRestriction,
  resolveAbyssalWarpActivationRestriction,
} = require("./runtime/activationSpaceRestrictions");
const {
  STARBASE_DEFENSE_CLEANUP_RETRY_LIMIT,
  tickStarbaseDefenseForScene,
} = require("./runtime/starbaseDefenseTick");

const solarSystemSceneMethodTables = [
  require("./runtime/scene/expiryIndex"),
  require("./runtime/scene/staticEntities"),
  require("./runtime/scene/clock"),
  require("./runtime/scene/spatialTopology"),
  require("./runtime/scene/fleetWarp"),
  require("./runtime/scene/visibility"),
  require("./runtime/scene/missionAccess"),
  require("./runtime/scene/dynamicEntities"),
  require("./runtime/scene/modules"),
  require("./runtime/scene/targeting"),
  require("./runtime/scene/shipDerivedState"),
  require("./runtime/scene/presentation"),
  require("./runtime/scene/cloaking"),
  require("./runtime/scene/sessions"),
  require("./runtime/scene/pilotCommands"),
  require("./runtime/scene/movementQueue"),
  require("./runtime/scene/destinyHistory"),
  require("./runtime/scene/tick"),
  require("./runtime/scene/evolve"),
  require("./runtime/scene/stargateActivation"),
  require("./runtime/scene/commandBurstDbuff"),
  require("./runtime/scene/abyssalTrace"),
];
for (const methodTable of solarSystemSceneMethodTables) {
  for (const [methodName, descriptor] of Object.entries(
    Object.getOwnPropertyDescriptors(methodTable),
  )) {
    if (Object.prototype.hasOwnProperty.call(SolarSystemScene.prototype, methodName)) {
      throw new Error(`SolarSystemScene already has a ${methodName} method`);
    }
    Object.defineProperty(SolarSystemScene.prototype, methodName, {
      ...descriptor,
      enumerable: false,
      writable: true,
      configurable: true,
    });
  }
}

setImmediate(() => recoverPendingKillmailWork());
const {
  sendTimeDilationNotificationToSession,
} = require(path.join(__dirname, "../utils/synchronizedTimeDilation"));
class SceneRegistry extends Map {
  normalizeKey(key) {
    if (typeof key === "number") {
      return buildSolarSystemSceneKey(key);
    }
    if (typeof key === "string" && /^\d+$/.test(key.trim())) {
      return buildSolarSystemSceneKey(toInt(key, 0));
    }
    if (key && typeof key === "object") {
      const descriptor = normalizeSceneDescriptor(key);
      return descriptor ? descriptor.sceneKey : key;
    }
    return key;
  }

  get(key) {
    return super.get(this.normalizeKey(key));
  }

  has(key) {
    return super.has(this.normalizeKey(key));
  }

  set(key, value) {
    return super.set(this.normalizeKey(key), value);
  }

  delete(key) {
    return super.delete(this.normalizeKey(key));
  }
}
class SpaceRuntime {
  constructor() {
    this.scenes = new SceneRegistry();
    this.solarSystemGateActivationOverrides = new Map();
    this.stargateActivationOverrides = new Map();
    // In loading modes where never-loaded destinations have closed gates, a
    // scene that GC deliberately unloaded must remain reachable so the next
    // jump can wake it again.
    this._garbageCollectedSolarSystemIDs = new Set();
    this._pendingAttachUniverseSiteReconciles = new Map();
    this._tickIntervalMs = RUNTIME_TICK_INTERVAL_MS;
    this._lastTickStartedAtMonotonicMs = getMonotonicTimeMs();
    this._lastTickSummary = null;
    // Object state is intentional: runtimeExports is populated from the singleton
    // below, so both views must share sweep scheduling updates by reference.
    this._emptySolarSystemCollectionSchedule = {
      nextSweepAtMs:
        Date.now() + EMPTY_SOLAR_SYSTEM_COLLECTION_SWEEP_INTERVAL_MS,
    };
    this._tickHandle = null;
    if (!OWNS_WORLD_SIMULATION) {
      return;
    }
    const beaconPayments = mobileAnalysisBeaconRuntime.recoverPendingLinkPayments();
    if (!beaconPayments.success) {
      log.warn(`[SpaceRuntime] CRAB payment recovery pending: ${beaconPayments.errorMsg}`);
    }
    pruneExpiredSpaceItems(Date.now());
    warmSimulationInventoryProjection();
    this._tickHandle = setInterval(() => this.tick(), this._tickIntervalMs);
    if (this._tickHandle && typeof this._tickHandle.unref === "function") {
      this._tickHandle.unref();
    }
  }

}

const spaceRuntimeMethodTables = [
  require("./runtime/spaceRuntime/sceneRegistry"),
  require("./runtime/spaceRuntime/stargateActivation"),
  require("./runtime/spaceRuntime/scenePreload"),
  require("./runtime/spaceRuntime/universeSites"),
  require("./runtime/spaceRuntime/structureSync"),
  require("./runtime/spaceRuntime/clock"),
  require("./runtime/spaceRuntime/sessions"),
  require("./runtime/spaceRuntime/timedInvulnerability"),
  require("./runtime/spaceRuntime/entityQueries"),
  require("./runtime/spaceRuntime/dynamicEntities"),
  require("./runtime/spaceRuntime/pilotCommands"),
  require("./runtime/spaceRuntime/shipState"),
  require("./runtime/spaceRuntime/targeting"),
  require("./runtime/spaceRuntime/modules"),
  require("./runtime/spaceRuntime/specialFx"),
  require("./runtime/spaceRuntime/stargateJump"),
  require("./runtime/spaceRuntime/docking"),
  require("./runtime/spaceRuntime/tick"),
  require("./runtime/spaceRuntime/sceneDisposal"),
  require("./runtime/spaceRuntime/abyssalTrace"),
];
for (const methodTable of spaceRuntimeMethodTables) {
  for (const [methodName, descriptor] of Object.entries(
    Object.getOwnPropertyDescriptors(methodTable),
  )) {
    if (Object.prototype.hasOwnProperty.call(SpaceRuntime.prototype, methodName)) {
      throw new Error(`SpaceRuntime already has a ${methodName} method`);
    }
    Object.defineProperty(SpaceRuntime.prototype, methodName, {
      ...descriptor,
      enumerable: false,
      writable: true,
      configurable: true,
    });
  }
}
// Site hazards use the ordinary typed damage/resistance and destruction path.
// Registration and interaction scope remain authoritative for area effects.
function applySiteExplosionDamageToTarget(scene, sourceEntity, targetEntity, rawDamage, whenMs, options = {}) {
  if (options.preparedIntent) {
    return require("./runtime/siteHazardDamage").deliver(options.preparedIntent, { scene, target: targetEntity });
  }
  const sourceID = toInt(sourceEntity?.itemID, 0);
  const targetID = toInt(targetEntity?.itemID, 0);
  const registeredSource = scene && (
    scene.dynamicEntities?.get(sourceID) === sourceEntity || scene.staticEntitiesByID?.get(sourceID) === sourceEntity);
  const registeredTarget = scene?.dynamicEntities?.get(targetID) === targetEntity;
  const { isRuntimeEntityDestroyingOrDestroyed } = require("./runtime/combatDestruction");
  if (!registeredSource || !registeredTarget || sourceEntity?.dungeonMaterializedSiteContent !== true ||
      !canEntitiesInteractLocally(sourceEntity, targetEntity) ||
      !hasDamageableHealth(targetEntity) || isRuntimeEntityDestroyingOrDestroyed(targetEntity) ||
      !(sumDamageVector(rawDamage) > 0)) {
    return { success: false, errorMsg: "SITE_EXPLOSION_DAMAGE_CONTEXT_INVALID" };
  }
  // An unjournalled call cannot guarantee recovery after a source disappears.
  // The site owner prepares and durably queues the event before delivery.
  return { success: false, errorMsg: "SITE_HAZARD_PREPARED_INTENT_REQUIRED" };
}

// Preserve the original CommonJS exports object so modules that observed it
// during a circular load still see the fully initialized runtime singleton.
const runtimeSingleton = new SpaceRuntime();
const runtimeExports = module.exports;
Object.setPrototypeOf(runtimeExports, Object.getPrototypeOf(runtimeSingleton));
Object.assign(runtimeExports, runtimeSingleton);
runtimeExports.applySiteExplosionDamageToTarget = applySiteExplosionDamageToTarget;
// Object.assign is a one-time copy, and the tick loop writes to the singleton:
// the `setInterval(() => this.tick(), ...)` in the constructor captured `this`
// before this object existed. So every field the tick assigns fresh each pass
// lands on `runtimeSingleton` and never reaches the exports object anyone else
// holds -- `_lastTickSummary` stayed at the `null` copied above for the life of
// the process, which silently emptied getLastRuntimeTickSummary() and the whole
// `tick` block of the redshift monitor (latenessMs, tickDurationMs,
// tickedSceneCount). `scenes` survived only because it is a Map mutated in
// place rather than reassigned, which is what made the gap so hard to see: the
// per-scene numbers next to the dead ones were live.
//
// Delegate rather than copy, so the singleton stays the single source of truth
// and the tick hot path is untouched. The setter keeps a write through either
// object landing in the same place.
for (const telemetryKey of ["_lastTickSummary", "_recentTickSummaries"]) {
  Object.defineProperty(runtimeExports, telemetryKey, {
    configurable: true,
    enumerable: true,
    get() {
      return runtimeSingleton[telemetryKey];
    },
    set(value) {
      runtimeSingleton[telemetryKey] = value;
    },
  });
}
runtimeExports.beginSessionJumpTimingTrace = beginSessionJumpTimingTrace;
runtimeExports.recordSessionJumpTimingTrace = recordSessionJumpTimingTrace;
runtimeExports.notifyAbyssalNpcDestroyedFromContext =
  notifyAbyssalNpcDestroyedFromContext;
runtimeExports.notifyAbyssalNpcsDestroyedFromContexts =
  notifyAbyssalNpcsDestroyedFromContexts;
runtimeExports.resolveCompressionFacilityRangeMeters = resolveCompressionFacilityRangeMeters;
runtimeExports.resolveCompressionFacilityTypelistsForEntity =
  resolveCompressionFacilityTypelistsForEntity;
runtimeExports.TIMED_INVULNERABILITY_KIND_UNDOCK = TIMED_INVULNERABILITY_KIND_UNDOCK;
runtimeExports.TIMED_INVULNERABILITY_KIND_ABYSSAL_RETURN =
  TIMED_INVULNERABILITY_KIND_ABYSSAL_RETURN;
runtimeExports.grantEntityTimedInvulnerability = grantEntityTimedInvulnerability;
runtimeExports.clearEntityTimedInvulnerability = clearEntityTimedInvulnerability;
runtimeExports.isEntityTimedInvulnerable = isEntityTimedInvulnerable;
runtimeExports.breakEntityTimedInvulnerability = breakEntityTimedInvulnerability;
runtimeExports.isEntityUndockInvulnerable = isEntityUndockInvulnerable;
runtimeExports.breakUndockInvulnerability = breakUndockInvulnerability;
runtimeExports.applyJammerCyclePresentation = applyJammerCyclePresentation;
runtimeExports.removeJammerCyclePresentation = removeJammerCyclePresentation;
runtimeExports.applyRuntimeEntityScopeMetadata = applyRuntimeEntityScopeMetadata;
runtimeExports.buildHostileModuleRuntimeCallbacks = buildHostileModuleRuntimeCallbacks;
runtimeExports.buildSolarSystemSceneKey = buildSolarSystemSceneKey;
runtimeExports.buildAbyssalSceneKey = buildAbyssalSceneKey;
runtimeExports.allocateAbyssalLocationID = allocateAbyssalLocationID;
runtimeExports.normalizeSceneDescriptor = normalizeSceneDescriptor;
runtimeExports.getSceneKeyForSession = getSceneKeyForSession;
runtimeExports.applyResolvedEnvironmentalDamageToTarget =
  applyResolvedEnvironmentalDamageToTarget;
runtimeExports.summarizeAbyssalBootstrapInventory = summarizeAbyssalBootstrapInventory;
runtimeExports.droneInterop = {
  // Drone and fighter shots resolve through the same configured additive as
  // ship turrets; a caller passing its own hitChanceAdditive still wins.
  resolveTurretShot: resolveTurretShotWithConfiguredAdditive,
  getCombatMessageHitQuality,
  getAppliedDamageAmount,
  notifyWeaponDamageMessages,
  applyWeaponDamageToTarget,
  noteKillmailDamage,
  recordKillmailFromDestruction,
  normalizeShipConditionState,
  buildShipHealthTransitionResult,
  notifyShipHealthAttributesToSession,
  broadcastDamageStateChange,
  persistDynamicEntity,
};
if (typeof structureState.registerStructureChangeListener === "function") {
  structureState.registerStructureChangeListener((changePayload) => {
    try {
      runtimeExports.handleStructureStateChange(changePayload);
    } catch (error) {
      log.warn(
        `[SpaceRuntime] Structure state-change sync failed: ${error.message}`,
      );
    }
  });
}
runtimeExports._testing = {
  SolarSystemScene,
  BUBBLE_DEBUG_ENTITY_ID_SAMPLE_LIMIT,
  isBubbleDebugEnabled,
  isMissileDebugEnabled,
  shouldLogMissilePayloadGroup,
  summarizeBubbleState,
  buildBankedWeaponSnapshot,
  resolveModifiedWarpSpeedAU,
  applyPassiveResourceStateToEntity,
  SceneRegistry,
  SCENE_KIND_SOLAR_SYSTEM,
  SCENE_KIND_ABYSSAL,
  ABYSSAL_LOCATION_ID_MIN,
  ABYSSAL_LOCATION_ID_COUNT,
  buildSolarSystemSceneKey,
  buildAbyssalSceneKey,
  allocateAbyssalLocationID,
  normalizeSceneDescriptor,
  summarizeAbyssalBootstrapInventory,
  getSceneKeyForSession,
  getInventoryAbyssalPlayerCompanionInfo,
  getInventoryAbyssalRunOwnership,
  shouldHydrateInventoryItemIntoScene,
  isInventoryItemEligibleForSceneSpawn,
  MODULE_CONSEQUENCE_DELIVERY,
  normalizeModuleConsequenceDelivery,
  resolveModuleConsequenceDelivery,
  collectEntityActiveShipAttributeModifierEntries,
  RUNTIME_CORPSE_KIND,
  RUNTIME_UNANCHORED_STRUCTURE_HULL_KIND,
  STARGATE_ACTIVATION_STATE,
  STARGATE_ACTIVATION_TRANSITION_MS,
  RUNTIME_TICK_INTERVAL_MS,
  NEW_EDEN_SYSTEM_LOADING,
  STARTUP_PRELOADED_SYSTEM_IDS,
  EMPTY_SOLAR_SYSTEM_COLLECTION_GRACE_MS,
  EMPTY_SOLAR_SYSTEM_RETAINED_OBJECT_GRACE_MS,
  EMPTY_SOLAR_SYSTEM_COLLECTION_MAX_PER_SWEEP,
  EMPTY_SOLAR_SYSTEM_COLLECTION_SWEEP_INTERVAL_MS,
  resolveAlwaysOnSolarSystemIDsForTesting: resolveAlwaysOnSolarSystemIDs,
  getEmptySolarSystemRetainedObjectStateForTesting:
    getEmptySolarSystemRetainedObjectState,
  getStartupSolarSystemPreloadPlanForTesting: resolveStartupSolarSystemPreloadPlan,
  getConfiguredStartupSystemLoadingModeForTesting: getConfiguredStartupSystemLoadingMode,
  resolveStartupPreloadedSystemIDsForTesting: resolveStartupPreloadedSystemIDs,
  resolveStartupSolarSystemPreloadPlanForTesting: resolveStartupSolarSystemPreloadPlan,
  getSceneActivityStateForTesting(systemID, wallclockNow = Date.now()) {
    return runtimeExports.getSceneActivityState(systemID, wallclockNow);
  },
  wakeSceneForImmediateUseForTesting(systemID, options = {}) {
    return runtimeExports.wakeSceneForImmediateUse(systemID, options);
  },
  collectEmptySolarSystemsForTesting(wallclockNowMs = Date.now(), options = {}) {
    return runtimeExports.collectEmptySolarSystems(wallclockNowMs, options);
  },
  getLastRuntimeTickSummary() {
    return runtimeExports._lastTickSummary
      ? {
          ...runtimeExports._lastTickSummary,
        }
      : null;
  },
  buildShipEntityForTesting: buildShipEntity,
  buildRuntimeShipEntityForTesting: buildRuntimeShipEntity,
  buildSpecialFxDestinyUpdatesForTesting: buildSpecialFxDestinyUpdates,
  destroyCombatEntityForTesting: destroyCombatEntity,
  persistInventoryBackedEntityForTesting: persistInventoryBackedEntity,
  isInvalidDestinyFollowOrbitCommandForTesting:
    isInvalidDestinyFollowOrbitCommand,
  recordNpcBountyForCombatDestructionForTesting: recordNpcBountyForCombatDestruction,
  resolveAbyssalNpcRuntimePolicyForTesting: resolveAbyssalNpcRuntimePolicy,
  resolveAbyssalNpcStandingsSuppressionResultForTesting:
    resolveAbyssalNpcStandingsSuppressionResult,
  noteAbyssalNpcStandingsSuppressionForTesting: noteAbyssalNpcStandingsSuppression,
  resolveAbyssalCloakActivationRestrictionForTesting:
    resolveAbyssalCloakActivationRestriction,
  resolveAbyssalWarpActivationRestrictionForTesting:
    resolveAbyssalWarpActivationRestriction,
  resolveAbyssalTeleportRestrictionForTesting:
    resolveAbyssalTeleportRestriction,
  notifyAbyssalEnvironmentalObjectDestroyedForTesting:
    notifyAbyssalEnvironmentalObjectDestroyedSafe,
  isAbyssalVisualOnlyEntityForTesting: isAbyssalVisualOnlyEntity,
  resolveGenericModuleSpecialFxGuidForTesting: resolveGenericModuleSpecialFxGuid,
  splitSpecialFxGuidsForTesting: splitSpecialFxGuids,
  applyCapturedRetailIdentityFromStateForTesting: applyCapturedRetailIdentityFromState,
  refreshInventoryBackedEntityPresentationFieldsForTesting:
    refreshInventoryBackedEntityPresentationFields,
  buildRuntimeSpaceEntityFromItemForTesting: buildRuntimeSpaceEntityFromItem,
  clearSessionStateFromShipEntityForTesting: clearSessionStateFromShipEntity,
  clearTrackingStateForTesting: clearTrackingState,
  refreshShipPresentationFieldsForTesting: refreshShipPresentationFields,
  persistShipEntityForTesting: persistShipEntity,
  serializeSpaceStateForTesting: serializeSpaceState,
  shouldPersistShipEntityAtTickForTesting: shouldPersistShipEntityAtTick,
  buildPublicGridKeyForTesting: buildPublicGridKey,
  buildSalvagerRuntimeCallbacksForTesting: buildSalvagerRuntimeCallbacks,
  isShipInsideForceFieldForTesting: isShipInsideForceField,
  listCommandBurstForceFieldsForTesting: listCommandBurstForceFields,
  ForceFieldIndexedEntityMapForTesting: ForceFieldIndexedEntityMap,
  tickStarbaseDefenseForSceneForTesting: tickStarbaseDefenseForScene,
  STARBASE_DEFENSE_CLEANUP_RETRY_LIMIT,
  isHighsecNeutralCommandBurstRecipientRestrictedForTesting:
    isHighsecNeutralCommandBurstRecipientRestricted,
  isCommandBurstRecipientEligibleForTesting: isCommandBurstRecipientEligible,
  isCommandBurstWeaponTimerExemptForTesting:
    isCommandBurstWeaponTimerExempt,
  recordCommandBurstWeaponTimerForTesting: recordCommandBurstWeaponTimer,
  deriveAgilitySecondsForTesting: deriveAgilitySeconds,
  getWarpStopDistanceForTargetForTesting: getWarpStopDistanceForTarget,
  resolveStargateWarpTargetForTesting: resolveStargateWarpTarget,
  getClientParityWarpInPointForTesting: getClientParityWarpInPoint,
  buildDirectedMovementUpdatesForTesting: buildDirectedMovementUpdates,
  buildAttributeChangeForTesting: buildAttributeChange,
  buildEntityDerivedAttributeSnapshotForTesting:
    buildEntityDerivedAttributeSnapshot,
  notifyShipDerivedAttributesToSessionForTesting:
    notifyShipDerivedAttributesToSession,
  computeTargetLockDurationMsForTesting: computeTargetLockDurationMs,
  advancePassiveRechargeRatioForTesting: advancePassiveRechargeRatio,
  notifyCapacitorChangeToSessionForTesting: notifyCapacitorChangeToSession,
  notifyShipHealthAttributesToSessionForTesting: notifyShipHealthAttributesToSession,
  notifyModuleEffectStateForTesting: notifyModuleEffectState,
  notifyGenericModuleEffectStateForTesting: notifyGenericModuleEffectState,
  notifyRuntimeChargeTransitionToSessionForTesting: notifyRuntimeChargeTransitionToSession,
  broadcastDamageStateChangeForTesting: broadcastDamageStateChange,
  buildLaserDamageMessagePayloadForTesting: buildLaserDamageMessagePayload,
  buildEnvironmentalDamageMessagePayloadForTesting:
    buildEnvironmentalDamageMessagePayload,
  resolveEffectiveModuleReloadTimeMsForTesting: resolveEffectiveModuleReloadTimeMs,
  resolveSpecialFxOptionsForEntityForTesting: resolveSpecialFxOptionsForEntity,
  // Living Universe
  resolveGenericModuleActivationEffectForTesting:
    require("./runtime/moduleActivationEffectRecord").resolveGenericModuleActivationEffect,
  resolveSpecialFxRepeatCountForTesting: resolveSpecialFxRepeatCount,
  hasActiveIndustrialCoreEffectForTesting: hasActiveIndustrialCoreEffect,
  resolveCompressionFacilityRangeMetersForTesting: resolveCompressionFacilityRangeMeters,
  resolveCompressionFacilityTypelistsForTesting:
    resolveCompressionFacilityTypelistsForEntity,
  buildStaticStargateEntityForTesting: buildStaticStargateEntity,
  buildStaticMoonMiningBeaconEntityForTesting: buildStaticMoonMiningBeaconEntity,
  buildStaticPlanetOrbitalEntityForTesting: buildStaticPlanetOrbitalEntity,
  buildChangedStructureRowsForTesting: buildChangedStructureRows,
  syncRuntimeStructureStateChangesForTesting:
    syncRuntimeStructureStateChanges,
  refreshEntitiesForSlimPayloadForTesting: refreshEntitiesForSlimPayload,
  notifyDockedStructureHangarViewSessionsForTesting:
    notifyDockedStructureHangarViewSessions,
  buildRuntimeInventoryEntityForTesting: buildRuntimeInventoryEntity,
  sessionHasInventoryLootRightForTesting: sessionHasInventoryLootRight,
  sessionMayAbandonInventoryLootForTesting: sessionMayAbandonInventoryLoot,
  buildStaticStructureEntityForTesting: buildStaticStructureEntity,
  isDroneAssistEligibleTargetedOffensiveEffectForTesting:
    isDroneAssistEligibleTargetedOffensiveEffect,
  noteDroneAssistSuccessfulOffensiveCycleForTesting:
    noteDroneAssistSuccessfulOffensiveCycle,
  buildMissileDynamicEntityForTesting: buildMissileDynamicEntity,
  queueAutomaticNpcTurretReloadForTesting: queueAutomaticNpcTurretReload,
  cloneDynamicEntityForDestinyPresentationForTesting:
    cloneDynamicEntityForDestinyPresentation,
  buildDeferredOwnerMissileAcquireOptionsForTesting:
    buildDeferredOwnerMissileAcquireOptions,
  getStationWarpTargetPositionForTesting: getStationWarpTargetPosition,
  getStationUndockSpawnStateForTesting: getStationUndockSpawnState,
  isPlayerOwnedActiveSpaceShipRecordForTesting: isPlayerOwnedActiveSpaceShipRecord,
  getSharedWorldPosition,
  getStargateDerivedDunRotation,
  resetStargateActivationOverrides() {
    runtimeExports.solarSystemGateActivationOverrides.clear();
    runtimeExports.stargateActivationOverrides.clear();
  },
  isPassiveShieldRechargeEnabledForTesting() {
    return state.passiveShieldRechargeEnabled === true;
  },
  setPassiveShieldRechargeEnabledForTesting(enabled) {
    state.passiveShieldRechargeEnabled = enabled === true;
    return state.passiveShieldRechargeEnabled;
  },
  clearScenes() {
    // Each scene's features are torn down through Scene feature hooks, in
    // upstream's order, each in its own try.
    const sceneFeatureHooks = lazyRequire("./runtime/scene/sceneFeatureHooks");
    for (const scene of runtimeExports.scenes.values()) {
      sceneFeatureHooks.notifySceneDisposing(scene);
    }
    lazyRequire("../services/starbase/starbaseControlRuntime").resetStarbaseControlForTests();
    runtimeExports.scenes.clear();
    runtimeExports._garbageCollectedSolarSystemIDs.clear();
    for (const pending of runtimeExports._pendingAttachUniverseSiteReconciles.values()) {
      if (pending && pending.timer) {
        clearTimeout(pending.timer);
      }
    }
    runtimeExports._pendingAttachUniverseSiteReconciles.clear();
    runtimeExports._emptySolarSystemCollectionSchedule.nextSweepAtMs =
      Date.now() + EMPTY_SOLAR_SYSTEM_COLLECTION_SWEEP_INTERVAL_MS;
    state.nextRuntimeEntityID = SYNTHETIC_RUNTIME_ENTITY_ID_START;
    state.passiveShieldRechargeEnabled = DEFAULT_PASSIVE_SHIELD_RECHARGE_ENABLED;
  },
  getSecurityStatusIconKey,
  resolveShipSkinMaterialSetID,
  allocateRuntimeEntityIDForTesting: allocateRuntimeEntityID,
  isEntityActiveWarpInFlightForTesting: isEntityActiveWarpInFlight,
  isActivatableEffectRecordForTesting: isActivatableEffectRecord,
  // Exposed so a test can drive the real damage-to-hardener glue rather than
  // reimplementing it and asserting against its own copy.
  noteReactiveArmorHardenerDamageForTesting: noteReactiveArmorHardenerDamage,
};
