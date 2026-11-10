"use strict";

function initializeManagerGroup7Binding1(scope) {
  const {
  evaluateAbyssalConduitEligibility,
  evaluateAbyssalDelayedHandoffEligibility,
  evaluateAbyssalRoomObjectiveEligibility,
  isAbyssalFinalRoomIndex,
  resolveAbyssalRoomProgression,
} = require("./abyssalConduitPolicy");
  scope.evaluateAbyssalConduitEligibility = evaluateAbyssalConduitEligibility;
  scope.evaluateAbyssalDelayedHandoffEligibility = evaluateAbyssalDelayedHandoffEligibility;
  scope.evaluateAbyssalRoomObjectiveEligibility = evaluateAbyssalRoomObjectiveEligibility;
  scope.isAbyssalFinalRoomIndex = isAbyssalFinalRoomIndex;
  scope.resolveAbyssalRoomProgression = resolveAbyssalRoomProgression;
}

function initializeManagerGroup7Binding2(scope) {
  const {
  ABYSSAL_DEADLINE_ACTION,
  calculateAbyssalRemainingDuration,
  classifyAbyssalRunDeadline,
  resolveAbyssalRunDeadlineMs,
  resolveAbyssalTimeoutDecision,
} = require("./abyssalDeadlinePolicy");
  scope.ABYSSAL_DEADLINE_ACTION = ABYSSAL_DEADLINE_ACTION;
  scope.calculateAbyssalRemainingDuration = calculateAbyssalRemainingDuration;
  scope.classifyAbyssalRunDeadline = classifyAbyssalRunDeadline;
  scope.resolveAbyssalRunDeadlineMs = resolveAbyssalRunDeadlineMs;
  scope.resolveAbyssalTimeoutDecision = resolveAbyssalTimeoutDecision;
}

function initializeManagerGroup7Binding3(scope) {
  const {
  ABYSSAL_PARTICIPANT_DESTRUCTION_OPERATION_SCHEMA_VERSION,
  ABYSSAL_PARTICIPANT_DESTRUCTION_OPERATION_STATUS,
  ABYSSAL_PARTICIPANT_DESTRUCTION_STATUS_RANK,
  ABYSSAL_PARTICIPANT_TERMINAL_CAUSE,
  ABYSSAL_RUN_OUTCOME,
  ABYSSAL_TERMINAL_TRANSITION_ACTION,
  evaluateAbyssalParticipantDestructionOperationTransition,
  evaluateAbyssalParticipantDestructionTransition,
  evaluateAbyssalRewardArtifactDestructionOperationTransition,
  evaluateAbyssalRunOutcomeTransition,
  evaluateAbyssalTerminalOperationGuard,
  hasFailedParticipantShipDestroyedOutcome,
  hasFailedTimeoutOutcome,
  hasImmutableAbyssalRunOutcome,
  hasTerminalFailureOutcome,
  isKnownAbyssalRunOutcome,
  isSameAbyssalParticipantDestructionIdentity,
  isValidAbyssalParticipantDestructionOperation,
  normalizeAbyssalParticipantDestructionOperation,
  normalizeAbyssalRewardArtifactDestructionOperation,
  normalizeAbyssalRunOutcome,
  resolveAbyssalTerminalCallbackReason,
} = require("../domain/abyssalTerminalTransitionPolicy");
  scope.ABYSSAL_PARTICIPANT_DESTRUCTION_OPERATION_SCHEMA_VERSION = ABYSSAL_PARTICIPANT_DESTRUCTION_OPERATION_SCHEMA_VERSION;
  scope.ABYSSAL_PARTICIPANT_DESTRUCTION_OPERATION_STATUS = ABYSSAL_PARTICIPANT_DESTRUCTION_OPERATION_STATUS;
  scope.ABYSSAL_PARTICIPANT_DESTRUCTION_STATUS_RANK = ABYSSAL_PARTICIPANT_DESTRUCTION_STATUS_RANK;
  scope.ABYSSAL_PARTICIPANT_TERMINAL_CAUSE = ABYSSAL_PARTICIPANT_TERMINAL_CAUSE;
  scope.ABYSSAL_RUN_OUTCOME = ABYSSAL_RUN_OUTCOME;
  scope.ABYSSAL_TERMINAL_TRANSITION_ACTION = ABYSSAL_TERMINAL_TRANSITION_ACTION;
  scope.evaluateAbyssalParticipantDestructionOperationTransition = evaluateAbyssalParticipantDestructionOperationTransition;
  scope.evaluateAbyssalParticipantDestructionTransition = evaluateAbyssalParticipantDestructionTransition;
  scope.evaluateAbyssalRewardArtifactDestructionOperationTransition = evaluateAbyssalRewardArtifactDestructionOperationTransition;
  scope.evaluateAbyssalRunOutcomeTransition = evaluateAbyssalRunOutcomeTransition;
  scope.evaluateAbyssalTerminalOperationGuard = evaluateAbyssalTerminalOperationGuard;
  scope.hasFailedParticipantShipDestroyedOutcome = hasFailedParticipantShipDestroyedOutcome;
  scope.hasFailedTimeoutOutcome = hasFailedTimeoutOutcome;
  scope.hasImmutableAbyssalRunOutcome = hasImmutableAbyssalRunOutcome;
  scope.hasTerminalFailureOutcome = hasTerminalFailureOutcome;
  scope.isKnownAbyssalRunOutcome = isKnownAbyssalRunOutcome;
  scope.isSameAbyssalParticipantDestructionIdentity = isSameAbyssalParticipantDestructionIdentity;
  scope.isValidAbyssalParticipantDestructionOperation = isValidAbyssalParticipantDestructionOperation;
  scope.normalizeAbyssalParticipantDestructionOperation = normalizeAbyssalParticipantDestructionOperation;
  scope.normalizeAbyssalRewardArtifactDestructionOperation = normalizeAbyssalRewardArtifactDestructionOperation;
  scope.normalizeAbyssalRunOutcome = normalizeAbyssalRunOutcome;
  scope.resolveAbyssalTerminalCallbackReason = resolveAbyssalTerminalCallbackReason;
}

function initializeManagerGroup7Binding4(scope) {
  const {
  createAbyssalRunOutcomeCommitCoordinator,
} = require("./abyssalRunOutcomeCommitCoordinator");
  scope.createAbyssalRunOutcomeCommitCoordinator = createAbyssalRunOutcomeCommitCoordinator;
}

function initializeManagerGroup7Binding5(scope) {
  const {
  selectAbyssalSurvivorController,
} = require("./abyssalSurvivorControllerHandoffCoordinator");
  scope.selectAbyssalSurvivorController = selectAbyssalSurvivorController;
}

function initializeManagerGroup7Binding6(scope) {
  const {
  createAbyssalFinalExitCoordinator,
} = require("./abyssalFinalExitCoordinator");
  scope.createAbyssalFinalExitCoordinator = createAbyssalFinalExitCoordinator;
}

function initializeManagerGroup7Binding7(scope) {
  const {
  createAbyssalRecoveryExecutionCoordinator,
} = require("./abyssalRecoveryExecutionCoordinator");
  scope.createAbyssalRecoveryExecutionCoordinator = createAbyssalRecoveryExecutionCoordinator;
}

function initializeManagerGroup7Binding8(scope) {
  const { createAbyssalTraceLifecycle } = require("./abyssalTraceLifecycle");
  scope.createAbyssalTraceLifecycle = createAbyssalTraceLifecycle;
}

function initializeManagerGroup7Binding9(scope) {
  const { createAbyssalTraceActivation } = require("./abyssalTraceActivation");
  scope.createAbyssalTraceActivation = createAbyssalTraceActivation;
}

function initializeManagerGroup7Binding10(scope) {
  const { createAbyssalTraceDeployment } = require("./abyssalTraceDeployment");
  scope.createAbyssalTraceDeployment = createAbyssalTraceDeployment;
}

function initializeManagerGroup7Binding11(scope) {
  const { createAbyssalArtifactInventory } = require("./abyssalArtifactInventory");
  scope.createAbyssalArtifactInventory = createAbyssalArtifactInventory;
}

function initializeManagerGroup7Binding12(scope) {
  const { createAbyssalEnvironmentComposition } = require("./abyssalEnvironmentComposition");
  scope.createAbyssalEnvironmentComposition = createAbyssalEnvironmentComposition;
}

function initializeManagerGroup7Binding13(scope) {
  const { createAbyssalRoomTransferComposition } = require("./abyssalRoomTransferComposition");
  scope.createAbyssalRoomTransferComposition = createAbyssalRoomTransferComposition;
}

function initializeManagerGroup7Binding14(scope) {
  const { createAbyssalEntryComposition } = require("./abyssalEntryComposition");
  scope.createAbyssalEntryComposition = createAbyssalEntryComposition;
}

function initializeManagerGroup7Binding15(scope) {
  const { createAbyssalParticipantAdmission } = require("./abyssalParticipantAdmission");
  scope.createAbyssalParticipantAdmission = createAbyssalParticipantAdmission;
}

function initializeManagerGroup7Binding16(scope) {
  const { createAbyssalTransitionScheduling } = require("./abyssalTransitionScheduling");
  scope.createAbyssalTransitionScheduling = createAbyssalTransitionScheduling;
}

function initializeManagerGroup7Binding17(scope) {
  const { createAbyssalKSpaceArrival } = require("./abyssalKSpaceArrival");
  scope.createAbyssalKSpaceArrival = createAbyssalKSpaceArrival;
}

function initializeManagerGroup7Binding18(scope) {
  const { createAbyssalParticipantReturn } = require("./abyssalParticipantReturn");
  scope.createAbyssalParticipantReturn = createAbyssalParticipantReturn;
}

function initializeManagerGroup7Binding19(scope) {
  const { createAbyssalFinalExitSettlement } = require("./abyssalFinalExitSettlement");
  scope.createAbyssalFinalExitSettlement = createAbyssalFinalExitSettlement;
}

function initializeManagerGroup7Binding20(scope) {
  const { createAbyssalFinalExitExecution } = require("./abyssalFinalExitExecution");
  scope.createAbyssalFinalExitExecution = createAbyssalFinalExitExecution;
}

function initializeManagerGroup7Binding21(scope) {
  const { createAbyssalCleanupPreparation } = require("./abyssalCleanupPreparation");
  scope.createAbyssalCleanupPreparation = createAbyssalCleanupPreparation;
}

function initializeManagerGroup7Binding22(scope) {
  const { createAbyssalArtifactCleanup } = require("./abyssalArtifactCleanup");
  scope.createAbyssalArtifactCleanup = createAbyssalArtifactCleanup;
}

function initializeManagerGroup7Binding23(scope) {
  const { createAbyssalCleanupWeather } = require("./abyssalCleanupWeather");
  scope.createAbyssalCleanupWeather = createAbyssalCleanupWeather;
}

function initializeManagerGroup7Binding24(scope) {
  const { createAbyssalTerminalCleanup } = require("./abyssalTerminalCleanup");
  scope.createAbyssalTerminalCleanup = createAbyssalTerminalCleanup;
}

function initializeManagerGroup7Binding25(scope) {
  const { createAbyssalCleanupAuthority } = require("./abyssalCleanupAuthority");
  scope.createAbyssalCleanupAuthority = createAbyssalCleanupAuthority;
}

function initializeManagerGroup7Binding26(scope) {
  const { createAbyssalResidualCleanup } = require("./abyssalResidualCleanup");
  scope.createAbyssalResidualCleanup = createAbyssalResidualCleanup;
}

function initializeManagerGroup7Binding27(scope) {
  const { createAbyssalProbeCleanup } = require("./abyssalProbeCleanup");
  scope.createAbyssalProbeCleanup = createAbyssalProbeCleanup;
}

function initializeManagerGroup7Binding28(scope) {
  const { createAbyssalStaleCleanup } = require("./abyssalStaleCleanup");
  scope.createAbyssalStaleCleanup = createAbyssalStaleCleanup;
}

function initializeManagerGroup7Binding29(scope) {
  const { createAbyssalStartupReturn } = require("./abyssalStartupReturn");
  scope.createAbyssalStartupReturn = createAbyssalStartupReturn;
}

function initializeManagerGroup7Binding30(scope) {
  const { createAbyssalStartupReconciliation } = require("./abyssalStartupReconciliation");
  scope.createAbyssalStartupReconciliation = createAbyssalStartupReconciliation;
}

function initializeManagerGroup7Binding31(scope) {
  const { createAbyssalRunEvacuation } = require("./abyssalRunEvacuation");
  scope.createAbyssalRunEvacuation = createAbyssalRunEvacuation;
}

function initializeManagerGroup7Binding32(scope) {
  const { createAbyssalCompatibilityRecovery } = require("./abyssalCompatibilityRecovery");
  scope.createAbyssalCompatibilityRecovery = createAbyssalCompatibilityRecovery;
}

function initializeManagerGroup7Binding33(scope) {
  const { createAbyssalHostRecovery } = require("./abyssalHostRecovery");
  scope.createAbyssalHostRecovery = createAbyssalHostRecovery;
}

function initializeManagerGroup7Binding34(scope) {
  const { createAbyssalSessionRecovery } = require("./abyssalSessionRecovery");
  scope.createAbyssalSessionRecovery = createAbyssalSessionRecovery;
}

function initializeManagerGroup7Binding35(scope) {
  const { createAbyssalRelogInspection } = require("./abyssalRelogInspection");
  scope.createAbyssalRelogInspection = createAbyssalRelogInspection;
}

function initializeManagerGroup7Binding36(scope) {
  const { createAbyssalBallparkPriming } = require("./abyssalBallparkPriming");
  scope.createAbyssalBallparkPriming = createAbyssalBallparkPriming;
}

function initializeManagerGroup7Binding37(scope) {
  const { createAbyssalSessionDisconnect } = require("./abyssalSessionDisconnect");
  scope.createAbyssalSessionDisconnect = createAbyssalSessionDisconnect;
}

function initializeManagerGroup7Binding38(scope) {
  const { createAbyssalTimeoutLifecycle } = require("./abyssalTimeoutLifecycle");
  scope.createAbyssalTimeoutLifecycle = createAbyssalTimeoutLifecycle;
}

function initializeManagerGroup7Binding39(scope) {
  const { createAbyssalDestructionSessionSelection } = require("./abyssalDestructionSessionSelection");
  scope.createAbyssalDestructionSessionSelection = createAbyssalDestructionSessionSelection;
}

function initializeManagerGroup7Binding40(scope) {
  const { createAbyssalRoomMarkers } = require("./abyssalRoomMarkers");
  scope.createAbyssalRoomMarkers = createAbyssalRoomMarkers;
}

function initializeManagerGroup7Binding41(scope) {
  const { createAbyssalNpcMaterialization } = require("./abyssalNpcMaterialization");
  scope.createAbyssalNpcMaterialization = createAbyssalNpcMaterialization;
}

function initializeManagerGroup7Binding42(scope) {
  const { createAbyssalRewardComposition } = require("./abyssalRewardComposition");
  scope.createAbyssalRewardComposition = createAbyssalRewardComposition;
}

function initializeManagerGroup7Binding43(scope) {
  const { createAbyssalTerminalArtifactCleanupCoordinator } = require("./abyssalTerminalArtifactCleanupCoordinator");
  scope.createAbyssalTerminalArtifactCleanupCoordinator = createAbyssalTerminalArtifactCleanupCoordinator;
}

function initializeManagerGroup7Binding44(scope) {
  const {
  ABYSSAL_SPATIAL_RESERVATION_SCHEMA_VERSION,
  AbyssalHostSlotAllocator,
  resolveAbyssalSpatialSlotOrigin,
} = require("../state/abyssalHostSlotAllocator");
  scope.ABYSSAL_SPATIAL_RESERVATION_SCHEMA_VERSION = ABYSSAL_SPATIAL_RESERVATION_SCHEMA_VERSION;
  scope.AbyssalHostSlotAllocator = AbyssalHostSlotAllocator;
  scope.resolveAbyssalSpatialSlotOrigin = resolveAbyssalSpatialSlotOrigin;
}

function initializeManagerGroup7Binding45(scope) {
  const {
  AbyssalRunRegistryError,
  RunRegistry,
} = require("../state/abyssalRunRegistry");
  scope.AbyssalRunRegistryError = AbyssalRunRegistryError;
  scope.RunRegistry = RunRegistry;
}

function initializeManagerGroup7Binding46(scope) {
  const {
  ABYSS_RUN_DURATION_MS,
  ABYSS_RETURN_PROTECTION_DURATION_MS,
  ABYSS_UNUSED_TRACE_DURATION_MS,
} = require("../catalog/abyssalRuntimeConstants");
  scope.ABYSS_RUN_DURATION_MS = ABYSS_RUN_DURATION_MS;
  scope.ABYSS_RETURN_PROTECTION_DURATION_MS = ABYSS_RETURN_PROTECTION_DURATION_MS;
  scope.ABYSS_UNUSED_TRACE_DURATION_MS = ABYSS_UNUSED_TRACE_DURATION_MS;
}

function initializeManagerGroup7Binding47(scope) {
  const {
  MAX_GATE_ACTIVATION_SURFACE_DISTANCE_METERS,
  evaluateGateActivationRange,
} = require("./abyssalGateActivationRange");
  scope.MAX_GATE_ACTIVATION_SURFACE_DISTANCE_METERS = MAX_GATE_ACTIVATION_SURFACE_DISTANCE_METERS;
  scope.evaluateGateActivationRange = evaluateGateActivationRange;
}

function initializeManagerGroup7Binding48(scope) {
  const {
  ABYSSAL_REWARD_QUANTITY_POLICY,
  applyRewardQuantityPolicy,
  migrateLegacySerializedRewardProfile,
  rewardQuantityPolicyAppliesTierScaling,
  validateRewardProfileQuantityPolicy,
} = require("../domain/abyssalRewardQuantityPolicy");
  scope.ABYSSAL_REWARD_QUANTITY_POLICY = ABYSSAL_REWARD_QUANTITY_POLICY;
  scope.applyRewardQuantityPolicy = applyRewardQuantityPolicy;
  scope.migrateLegacySerializedRewardProfile = migrateLegacySerializedRewardProfile;
  scope.rewardQuantityPolicyAppliesTierScaling = rewardQuantityPolicyAppliesTierScaling;
  scope.validateRewardProfileQuantityPolicy = validateRewardProfileQuantityPolicy;
}

function initializeManagerGroup7Binding49(scope) {
  const {
  ABYSSAL_RUN_REWARD_ALLOCATION_MODEL,
  buildAbyssalRewardPlan: buildPureAbyssalRewardPlan,
  buildObservedRunRewardAllocation: buildPureObservedRunRewardAllocation,
  calculateAbyssalRewardPlanChecksum,
  calculateObservedRunRewardAllocationChecksum,
  getObservedRunRewardArtifactAllocation,
  mergeAbyssalRewardEntries,
  rewardEntryQuantitiesMatch,
  validateAbyssalRewardPlan,
  validateAbyssalRewardPlanContext: validatePureAbyssalRewardPlanContext,
  validateObservedRunRewardAllocation: validatePureObservedRunRewardAllocation,
} = require("./abyssalRewardPlanningPolicy");
  scope.ABYSSAL_RUN_REWARD_ALLOCATION_MODEL = ABYSSAL_RUN_REWARD_ALLOCATION_MODEL;
  scope.buildPureAbyssalRewardPlan = buildPureAbyssalRewardPlan;
  scope.buildPureObservedRunRewardAllocation = buildPureObservedRunRewardAllocation;
  scope.calculateAbyssalRewardPlanChecksum = calculateAbyssalRewardPlanChecksum;
  scope.calculateObservedRunRewardAllocationChecksum = calculateObservedRunRewardAllocationChecksum;
  scope.getObservedRunRewardArtifactAllocation = getObservedRunRewardArtifactAllocation;
  scope.mergeAbyssalRewardEntries = mergeAbyssalRewardEntries;
  scope.rewardEntryQuantitiesMatch = rewardEntryQuantitiesMatch;
  scope.validateAbyssalRewardPlan = validateAbyssalRewardPlan;
  scope.validatePureAbyssalRewardPlanContext = validatePureAbyssalRewardPlanContext;
  scope.validatePureObservedRunRewardAllocation = validatePureObservedRunRewardAllocation;
}

function initializeManagerGroup7Binding50(scope) {
  const {
  getAbyssalEmpiricalTierLootTable,
} = require("../catalog/abyssalLootTables");
  scope.getAbyssalEmpiricalTierLootTable = getAbyssalEmpiricalTierLootTable;
}

function initializeManagerGroup7Binding51(scope) {
  const {
  ABYSSAL_CALM_DARK_DEFAULT_EFFECT_KEY,
  listAbyssalCalmDarkProbeEffectKeys,
  resolveAbyssalCalmDarkProbeEffect,
} = require("../catalog/abyssalClientFxCatalog");
  scope.ABYSSAL_CALM_DARK_DEFAULT_EFFECT_KEY = ABYSSAL_CALM_DARK_DEFAULT_EFFECT_KEY;
  scope.listAbyssalCalmDarkProbeEffectKeys = listAbyssalCalmDarkProbeEffectKeys;
  scope.resolveAbyssalCalmDarkProbeEffect = resolveAbyssalCalmDarkProbeEffect;
}

function initializeManagerGroup7Binding52(scope) {
  const {
  assertValidAbyssalEnginePort,
} = require("../ports/abyssalEnginePort");
  scope.assertValidAbyssalEnginePort = assertValidAbyssalEnginePort;
}

function initializeManagerGroup7Binding53(scope) {
  const {
  ABYSSAL_RUNTIME_STATE_SCHEMA_VERSION,
  createAbyssalRuntimeStateCodec,
} = require("../domain/abyssalRuntimeStateCodec");
  scope.ABYSSAL_RUNTIME_STATE_SCHEMA_VERSION = ABYSSAL_RUNTIME_STATE_SCHEMA_VERSION;
  scope.createAbyssalRuntimeStateCodec = createAbyssalRuntimeStateCodec;
}

function initializeManagerGroup7Binding54(scope) {
  const { isProceduralAbyssalContent } = require("../catalog/content/abyssalProceduralContentComposer");
  scope.isProceduralAbyssalContent = isProceduralAbyssalContent;
}

function initializeManagerGroup7Binding55(scope) {
  const { isProceduralEnvironment, describeAbyssalEnvironmentSource } = require("../catalog/abyssalProceduralEnvironment");
  scope.isProceduralEnvironment = isProceduralEnvironment;
  scope.describeAbyssalEnvironmentSource = describeAbyssalEnvironmentSource;
}

function initializeManagerGroup7Binding56(scope) {
  const { AbyssalTraceStateRegistry } = require("../state/abyssalTraceStateRegistry");
  scope.AbyssalTraceStateRegistry = AbyssalTraceStateRegistry;
}

function initializeManagerGroup7Binding57(scope) {
  const { AbyssalRunWorkStore } = require("../state/abyssalRunWorkStore");
  scope.AbyssalRunWorkStore = AbyssalRunWorkStore;
}

function initializeManagerGroup7Binding58(scope) {
  const { AbyssalPendingWorkRegistry } = require("../state/abyssalPendingWorkRegistry");
  scope.AbyssalPendingWorkRegistry = AbyssalPendingWorkRegistry;
}

function initializeManagerGroup7Binding59(scope) {
  const { abyssalMaintenanceState } = require("../state/abyssalMaintenanceState");
  scope.abyssalMaintenanceState = abyssalMaintenanceState;
}

function initializeManagerGroup7Binding60(scope) {
  const {
  RECOVERY_TOMBSTONE_INDEX_DEFINITIONS,
  abyssalRecoveryTombstoneStore,
} = require("../state/abyssalRecoveryTombstoneStore");
  scope.RECOVERY_TOMBSTONE_INDEX_DEFINITIONS = RECOVERY_TOMBSTONE_INDEX_DEFINITIONS;
  scope.abyssalRecoveryTombstoneStore = abyssalRecoveryTombstoneStore;
}

function initializeManagerGroup7Binding61(scope) {
  const {
  ABYSSAL_DIAGNOSTIC_DEDUPE_SCOPE,
  abyssalDiagnosticsState,
} = require("../state/abyssalDiagnosticsState");
  scope.ABYSSAL_DIAGNOSTIC_DEDUPE_SCOPE = ABYSSAL_DIAGNOSTIC_DEDUPE_SCOPE;
  scope.abyssalDiagnosticsState = abyssalDiagnosticsState;
}

function initializeManagerGroup7Binding62(scope) {
  const {
  buildAbyssalBootstrapDiagnosticFields,
  cloneAbyssalAuditArgs: cloneArgs,
  normalizeAbyssalBootstrapMode,
  sanitizeAbyssalAuditValue,
} = require("../domain/abyssalDiagnosticValues");
  scope.buildAbyssalBootstrapDiagnosticFields = buildAbyssalBootstrapDiagnosticFields;
  scope.cloneArgs = cloneArgs;
  scope.normalizeAbyssalBootstrapMode = normalizeAbyssalBootstrapMode;
  scope.sanitizeAbyssalAuditValue = sanitizeAbyssalAuditValue;
}

function initializeManagerGroup7Binding63(scope) {
  const { abyssalEngineBindingState } = require("../state/abyssalEngineBindingState");
  scope.abyssalEngineBindingState = abyssalEngineBindingState;
}

function initializeManagerGroup7Binding64(scope) {
  const config = require("../../config");
  scope.config = config;
}

function initializeManagerGroup7Binding65(scope) {
  const { PROXY_NODE_ID } = require("../../network/protocolProfile");
  scope.PROXY_NODE_ID = PROXY_NODE_ID;
}

function initializeManagerGroup7Binding66(scope) {
  const CATEGORY_SHIP = 6;
  scope.CATEGORY_SHIP = CATEGORY_SHIP;
}

function initializeManagerGroup7Binding67(scope) {
  const CATEGORY_DRONE = 18;
  scope.CATEGORY_DRONE = CATEGORY_DRONE;
}

function initializeManagerGroup7Binding68(scope) {
  const CATEGORY_DEPLOYABLE = 22;
  scope.CATEGORY_DEPLOYABLE = CATEGORY_DEPLOYABLE;
}

function initializeManagerGroup7Binding69(scope) {
  const CATEGORY_FIGHTER = 87;
  scope.CATEGORY_FIGHTER = CATEGORY_FIGHTER;
}

function initializeManagerGroup7Binding70(scope) {
  const GROUP_SCANNER_PROBE = 479;
  scope.GROUP_SCANNER_PROBE = GROUP_SCANNER_PROBE;
}

function initializeManagerGroup7Binding71(scope) {
  const GROUP_WARP_DISRUPTION_PROBE = 548;
  scope.GROUP_WARP_DISRUPTION_PROBE = GROUP_WARP_DISRUPTION_PROBE;
}

function initializeManagerGroup7Binding72(scope) {
  const CATEGORY_BLUEPRINT = 9;
  scope.CATEGORY_BLUEPRINT = CATEGORY_BLUEPRINT;
}

function initializeManagerGroup7Binding73(scope) {
  const GROUP_ABYSSAL_FILAMENT = 1979;
  scope.GROUP_ABYSSAL_FILAMENT = GROUP_ABYSSAL_FILAMENT;
}

function initializeManagerGroup7Binding74(scope) {
  const GROUP_FILAMENT_TRACE = 1991;
  scope.GROUP_FILAMENT_TRACE = GROUP_FILAMENT_TRACE;
}

function initializeManagerGroup7Binding75(scope) {
  const FILAMENT_PROXIMITY_RESTRICTION_LIST_ID = 50;
  scope.FILAMENT_PROXIMITY_RESTRICTION_LIST_ID = FILAMENT_PROXIMITY_RESTRICTION_LIST_ID;
}

function initializeManagerGroup7Binding76(scope) {
  const FILAMENT_CRUISER_TYPE_RESTRICTION_LIST_ID = 57;
  scope.FILAMENT_CRUISER_TYPE_RESTRICTION_LIST_ID = FILAMENT_CRUISER_TYPE_RESTRICTION_LIST_ID;
}

function initializeManagerGroup7Binding77(scope) {
  const FILAMENT_FRIGATE_TYPE_RESTRICTION_LIST_ID = 92;
  scope.FILAMENT_FRIGATE_TYPE_RESTRICTION_LIST_ID = FILAMENT_FRIGATE_TYPE_RESTRICTION_LIST_ID;
}

function initializeManagerGroup7Binding78(scope) {
  const FILAMENT_DESTROYER_TYPE_RESTRICTION_LIST_ID = 233;
  scope.FILAMENT_DESTROYER_TYPE_RESTRICTION_LIST_ID = FILAMENT_DESTROYER_TYPE_RESTRICTION_LIST_ID;
}

function initializeManagerGroup7Binding79(scope) {
  const SOLAR_SYSTEM_ZARZAKH = 30_100_000;
  scope.SOLAR_SYSTEM_ZARZAKH = SOLAR_SYSTEM_ZARZAKH;
}

function initializeManagerGroup7Binding80(scope) {
  const VOID_SYSTEM_ID_MIN = 34_000_000;
  scope.VOID_SYSTEM_ID_MIN = VOID_SYSTEM_ID_MIN;
}

function initializeManagerGroup7Binding81(scope) {
  const VOID_SYSTEM_ID_MAX = 34_999_999;
  scope.VOID_SYSTEM_ID_MAX = VOID_SYSTEM_ID_MAX;
}

function initializeManagerGroup7Binding82(scope) {
  const FORCE_FIELD_GROUP_ID = 411;
  scope.FORCE_FIELD_GROUP_ID = FORCE_FIELD_GROUP_ID;
}

function initializeManagerGroup7Binding83(scope) {
  const TYPE_ABYSSAL_TRANSFER_CONDUIT = 47685;
  scope.TYPE_ABYSSAL_TRANSFER_CONDUIT = TYPE_ABYSSAL_TRANSFER_CONDUIT;
}

function initializeManagerGroup7Binding84(scope) {
  const TYPE_ABYSSAL_ORIGIN_CONDUIT = 47686;
  scope.TYPE_ABYSSAL_ORIGIN_CONDUIT = TYPE_ABYSSAL_ORIGIN_CONDUIT;
}

function initializeManagerGroup7Binding85(scope) {
  const TYPE_ABYSSAL_BIOCOMBINATIVE_CACHE = 49689;
  scope.TYPE_ABYSSAL_BIOCOMBINATIVE_CACHE = TYPE_ABYSSAL_BIOCOMBINATIVE_CACHE;
}

function initializeManagerGroup7Binding86(scope) {
  const TYPE_ABYSSAL_BIOCOMBINATIVE_CACHE_WRECK = 49692;
  scope.TYPE_ABYSSAL_BIOCOMBINATIVE_CACHE_WRECK = TYPE_ABYSSAL_BIOCOMBINATIVE_CACHE_WRECK;
}

function initializeManagerGroup7Binding87(scope) {
  const TYPE_CAPTURED_TRIGLAVIAN_BIOADAPTIVE_CACHE = 47951;
  scope.TYPE_CAPTURED_TRIGLAVIAN_BIOADAPTIVE_CACHE = TYPE_CAPTURED_TRIGLAVIAN_BIOADAPTIVE_CACHE;
}

function initializeManagerGroup7Binding88(scope) {
  const TYPE_CAPTURED_TRIGLAVIAN_BIOADAPTIVE_CACHE_WRECK = 48120;
  scope.TYPE_CAPTURED_TRIGLAVIAN_BIOADAPTIVE_CACHE_WRECK = TYPE_CAPTURED_TRIGLAVIAN_BIOADAPTIVE_CACHE_WRECK;
}

function initializeManagerGroup7Binding89(scope) {
  const TYPE_ABYSSAL_EXTRACTION_SUBNODE = 49661;
  scope.TYPE_ABYSSAL_EXTRACTION_SUBNODE = TYPE_ABYSSAL_EXTRACTION_SUBNODE;
}

function initializeManagerGroup7Binding90(scope) {
  const TYPE_ABYSSAL_EXTRACTION_NODE = 49662;
  scope.TYPE_ABYSSAL_EXTRACTION_NODE = TYPE_ABYSSAL_EXTRACTION_NODE;
}

function initializeManagerGroup7Binding91(scope) {
  const TYPE_ABYSSAL_EXTRACTION_SUBNODE_WRECK = 49664;
  scope.TYPE_ABYSSAL_EXTRACTION_SUBNODE_WRECK = TYPE_ABYSSAL_EXTRACTION_SUBNODE_WRECK;
}

function initializeManagerGroup7Binding92(scope) {
  const TYPE_ABYSSAL_EXTRACTION_NODE_WRECK = 49665;
  scope.TYPE_ABYSSAL_EXTRACTION_NODE_WRECK = TYPE_ABYSSAL_EXTRACTION_NODE_WRECK;
}

function initializeManagerGroup7Binding93(scope) {
  const TRANQUIL_ABYSSAL_FILAMENT_TYPE_IDS = new Set(scope.T0_TRANQUIL_FILAMENT_TYPE_IDS);
  scope.TRANQUIL_ABYSSAL_FILAMENT_TYPE_IDS = TRANQUIL_ABYSSAL_FILAMENT_TYPE_IDS;
}

function initializeManagerGroup7Binding94(scope) {
  const ABYSSAL_WEATHER_PRESENTATION_STAGES_BY_TYPE = Object.freeze({
  electrical: Object.freeze([
    Object.freeze({ stage: 1, typeID: 47381, name: "Electrical Storm Weather 1" }),
    Object.freeze({ stage: 2, typeID: 47382, name: "Electrical Storm Weather 2" }),
    Object.freeze({ stage: 3, typeID: 47383, name: "Electrical Storm Weather 3" }),
  ]),
  exotic: Object.freeze([
    Object.freeze({ stage: 1, typeID: 47384, name: "Caustic Toxin Weather 1" }),
    Object.freeze({ stage: 2, typeID: 47385, name: "Caustic Toxin Weather 2" }),
    Object.freeze({ stage: 3, typeID: 47386, name: "Caustic Toxin Weather 3" }),
  ]),
  firestorm: Object.freeze([
    Object.freeze({ stage: 1, typeID: 47390, name: "Infernal Weather 1" }),
    Object.freeze({ stage: 2, typeID: 47391, name: "Infernal Weather 2" }),
    Object.freeze({ stage: 3, typeID: 47392, name: "Infernal Weather 3" }),
  ]),
  gamma: Object.freeze([
    Object.freeze({ stage: 1, typeID: 47387, name: "Xenon Gas Weather 1" }),
    Object.freeze({ stage: 2, typeID: 47388, name: "Xenon Gas Weather 2" }),
    Object.freeze({ stage: 3, typeID: 47389, name: "Xenon Gas Weather 3" }),
  ]),
});
  scope.ABYSSAL_WEATHER_PRESENTATION_STAGES_BY_TYPE = ABYSSAL_WEATHER_PRESENTATION_STAGES_BY_TYPE;
}

function initializeManagerGroup7Binding95(scope) {
  const ABYSSAL_SCENE_MODE_ISOLATED = "isolated";
  scope.ABYSSAL_SCENE_MODE_ISOLATED = ABYSSAL_SCENE_MODE_ISOLATED;
}

function initializeManagerGroup7Binding96(scope) {
  const ABYSSAL_SCENE_MODE_LEGACY = "legacy-same-system";
  scope.ABYSSAL_SCENE_MODE_LEGACY = ABYSSAL_SCENE_MODE_LEGACY;
}

function initializeManagerGroup7Binding97(scope) {
  const ABYSSAL_ROOM_DELIVERY_STATE = Object.freeze({
  PREWARMED_HIDDEN: "prewarmed-hidden",
  TRANSITION_PENDING: "transition-pending",
  DELIVERY_COMMITTED: "delivery-committed",
  VISIBLE: "visible",
  RETIRED: "retired",
});
  scope.ABYSSAL_ROOM_DELIVERY_STATE = ABYSSAL_ROOM_DELIVERY_STATE;
}

function initializeManagerGroup7Binding98(scope) {
  const ABYSSAL_EARLY_VISIBILITY_STATES = new Set([
  scope.ABYSSAL_ROOM_DELIVERY_STATE.PREWARMED_HIDDEN,
  scope.ABYSSAL_ROOM_DELIVERY_STATE.TRANSITION_PENDING,
  scope.ABYSSAL_ROOM_DELIVERY_STATE.DELIVERY_COMMITTED,
]);
  scope.ABYSSAL_EARLY_VISIBILITY_STATES = ABYSSAL_EARLY_VISIBILITY_STATES;
}

function initializeManagerGroup7Binding99(scope) {
  const CAPTURED_T0_DARK_NPC_PROFILE_BY_TYPE_ID = Object.freeze({
  47848: "abyssal_rogue_drone_emberneedle",
  47849: "abyssal_rogue_drone_strikeneedle",
  48092: "abyssal_triglavian_striking_damavik",
  48234: "abyssal_triglavian_ephialtes_lancer",
});
  scope.CAPTURED_T0_DARK_NPC_PROFILE_BY_TYPE_ID = CAPTURED_T0_DARK_NPC_PROFILE_BY_TYPE_ID;
}

function initializeManagerGroup7Binding100(scope) {
  const CAPTURED_T0_DARK_NPC_COMBAT_BY_TYPE_ID = Object.freeze({
  48092: Object.freeze({
    movementMode: "orbit",
    orbitDistanceMeters: 5_250,
    followRangeMeters: 5_250,
    autoActivateWeapons: true,
    specialFxGuid: "effects.TriglavianBeam,effects.AttackMode",
    preserveSpecialFxGuidOrder: true,
    precursorSpoolPerCycle: 0.04,
    precursorSpoolMax: 1.5,
  }),
});
  scope.CAPTURED_T0_DARK_NPC_COMBAT_BY_TYPE_ID = CAPTURED_T0_DARK_NPC_COMBAT_BY_TYPE_ID;
}

function initializeManagerGroup7Binding101(scope) {
  const ABYSSAL_TIMER_TYPE_NORMAL_PVE = 11;
  scope.ABYSSAL_TIMER_TYPE_NORMAL_PVE = ABYSSAL_TIMER_TYPE_NORMAL_PVE;
}

function initializeManagerGroup7Binding102(scope) {
  const ABYSSAL_SUSPECT_RETURN_DURATION_MS = 15 * 60_000;
  scope.ABYSSAL_SUSPECT_RETURN_DURATION_MS = ABYSSAL_SUSPECT_RETURN_DURATION_MS;
}

function initializeManagerGroup7Binding103(scope) {
  const ABYSSAL_FILAMENT_COMPENSATION_STATE = Object.freeze({
  PENDING: "pending",
  APPLYING: "applying",
  COMPLETED: "completed",
});
  scope.ABYSSAL_FILAMENT_COMPENSATION_STATE = ABYSSAL_FILAMENT_COMPENSATION_STATE;
}

function initializeManagerGroup7Binding104(scope) {
  const ABYSSAL_FILAMENT_COMPENSATION_FAILURE_CLASS = Object.freeze({
  SERVER_INFRASTRUCTURE: "server_infrastructure",
  PLAYER_WORLD_INVALIDATION: "player_world_invalidation",
  POST_AUTHORITATIVE_ENTRY: "post_authoritative_entry",
});
  scope.ABYSSAL_FILAMENT_COMPENSATION_FAILURE_CLASS = ABYSSAL_FILAMENT_COMPENSATION_FAILURE_CLASS;
}

function initializeManagerGroup7Binding105(scope) {
  const ABYSSAL_POST_ENTRY_FILAMENT_FORFEIT_REASONS = new Set([
  "ABYSSAL_NPC_ACTIVATION_FAILED",
  "ENTRY_NPC_ACTIVATION_FAILED",
  "ENTRY_ACTIVE_ROOM_NOT_READY",
  "ENTRY_RECOVERY_PENDING_EVACUATION_FAILED",
]);
  scope.ABYSSAL_POST_ENTRY_FILAMENT_FORFEIT_REASONS = ABYSSAL_POST_ENTRY_FILAMENT_FORFEIT_REASONS;
}

function initializeManagerGroup7Binding106(scope) {
  const ABYSSAL_ENTRY_RECOVERY_REASON = Object.freeze({
  PENDING_EVACUATION: "ENTRY_ACTIVATION_ROLLBACK_PENDING_EVACUATION",
  EVACUATION_FAILED: "ENTRY_ACTIVATION_ROLLBACK_EVACUATION_FAILED",
  COMPENSATION_PENDING: "ENTRY_ACTIVATION_ROLLBACK_COMPENSATION_PENDING",
  CLEANUP_PENDING: "ENTRY_ACTIVATION_ROLLBACK_CLEANUP_PENDING",
});
  scope.ABYSSAL_ENTRY_RECOVERY_REASON = ABYSSAL_ENTRY_RECOVERY_REASON;
}

function initializeManagerGroup7Binding107(scope) {
  const ABYSSAL_POCKET_MUTATION_DURABILITY = Object.freeze({
  DURABLE: "durable",
  BEST_EFFORT: "best_effort",
});
  scope.ABYSSAL_POCKET_MUTATION_DURABILITY = ABYSSAL_POCKET_MUTATION_DURABILITY;
}

function initializeManagerGroup7Binding108(scope) {
  const ABYSSAL_POCKET_PERSISTENCE_ERROR = "ABYSSAL_POCKET_PERSISTENCE_FAILED";
  scope.ABYSSAL_POCKET_PERSISTENCE_ERROR = ABYSSAL_POCKET_PERSISTENCE_ERROR;
}

function initializeManagerGroup7Binding109(scope) {
  const FILETIME_UNIX_EPOCH_OFFSET = 116444736000000000n;
  scope.FILETIME_UNIX_EPOCH_OFFSET = FILETIME_UNIX_EPOCH_OFFSET;
}

function initializeManagerGroup7Binding110(scope) {
  const FILETIME_TICKS_PER_MS = 10000n;
  scope.FILETIME_TICKS_PER_MS = FILETIME_TICKS_PER_MS;
}

function initializeManagerGroup7Binding111(scope) {
  const DEPLOY_DISTANCE_METERS = 2_500;
  scope.DEPLOY_DISTANCE_METERS = DEPLOY_DISTANCE_METERS;
}

function initializeManagerGroup7Binding112(scope) {
  const MIN_DISTANCE_FROM_DISALLOWED_OBJECTS_METERS = 1_000_000;
  scope.MIN_DISTANCE_FROM_DISALLOWED_OBJECTS_METERS = MIN_DISTANCE_FROM_DISALLOWED_OBJECTS_METERS;
}

function initializeManagerGroup7Binding113(scope) {
  const TRACE_ACTIVATION_RANGE_METERS = scope.MAX_GATE_ACTIVATION_SURFACE_DISTANCE_METERS;
  scope.TRACE_ACTIVATION_RANGE_METERS = TRACE_ACTIVATION_RANGE_METERS;
}

function initializeManagerGroup7Binding114(scope) {
  const CONDUIT_ACTIVATION_RANGE_METERS = scope.MAX_GATE_ACTIVATION_SURFACE_DISTANCE_METERS;
  scope.CONDUIT_ACTIVATION_RANGE_METERS = CONDUIT_ACTIVATION_RANGE_METERS;
}

function initializeManagerGroup7Binding115(scope) {
  const PLACEHOLDER_POCKET_OFFSET_METERS = 50_000_000_000;
  scope.PLACEHOLDER_POCKET_OFFSET_METERS = PLACEHOLDER_POCKET_OFFSET_METERS;
}

function initializeManagerGroup7Binding116(scope) {
  const PLACEHOLDER_POCKET_SHIP_OFFSET_METERS = 1_000;
  scope.PLACEHOLDER_POCKET_SHIP_OFFSET_METERS = PLACEHOLDER_POCKET_SHIP_OFFSET_METERS;
}

function initializeManagerGroup7Binding117(scope) {
  const PLACEHOLDER_ROOM_CONDUIT_DISTANCE_METERS = 35_000;
  scope.PLACEHOLDER_ROOM_CONDUIT_DISTANCE_METERS = PLACEHOLDER_ROOM_CONDUIT_DISTANCE_METERS;
}

function initializeManagerGroup7Binding118(scope) {
  const PLACEHOLDER_NPC_CONDUIT_ORBIT_RADIUS_METERS = 5_000;
  scope.PLACEHOLDER_NPC_CONDUIT_ORBIT_RADIUS_METERS = PLACEHOLDER_NPC_CONDUIT_ORBIT_RADIUS_METERS;
}

function initializeManagerGroup7Binding119(scope) {
  const PLACEHOLDER_REWARD_CACHE_FROM_CONDUIT_METERS = 8_000;
  scope.PLACEHOLDER_REWARD_CACHE_FROM_CONDUIT_METERS = PLACEHOLDER_REWARD_CACHE_FROM_CONDUIT_METERS;
}

function initializeManagerGroup7Binding120(scope) {
  const PLACEHOLDER_EXTRACTION_NODE_FROM_CONDUIT_METERS = 7_000;
  scope.PLACEHOLDER_EXTRACTION_NODE_FROM_CONDUIT_METERS = PLACEHOLDER_EXTRACTION_NODE_FROM_CONDUIT_METERS;
}

function initializeManagerGroup7Binding121(scope) {
  const MIN_EXTRACTION_NODE_FROM_CONDUIT_METERS = 15_000;
  scope.MIN_EXTRACTION_NODE_FROM_CONDUIT_METERS = MIN_EXTRACTION_NODE_FROM_CONDUIT_METERS;
}

function initializeManagerGroup7Binding122(scope) {
  const PLACEHOLDER_RETURN_OFFSET_METERS = 10_000;
  scope.PLACEHOLDER_RETURN_OFFSET_METERS = PLACEHOLDER_RETURN_OFFSET_METERS;
}

function initializeManagerGroup7Binding123(scope) {
  const PLACEHOLDER_ROOM_OFFSET_VECTORS = Object.freeze([
  { x: 0, y: 0, z: 0 },
  { x: 0, y: 12_000_000, z: 0 },
  { x: 0, y: 24_000_000, z: 0 },
]);
  scope.PLACEHOLDER_ROOM_OFFSET_VECTORS = PLACEHOLDER_ROOM_OFFSET_VECTORS;
}

function initializeManagerGroup7Binding124(scope) {
  const PLACEHOLDER_POCKET_MAINTENANCE_INTERVAL_MS = 1_000;
  scope.PLACEHOLDER_POCKET_MAINTENANCE_INTERVAL_MS = PLACEHOLDER_POCKET_MAINTENANCE_INTERVAL_MS;
}

function initializeManagerGroup7Binding125(scope) {
  const ABYSSAL_WEATHER_REMOVAL_MAX_PENDING_MS = 120_000;
  scope.ABYSSAL_WEATHER_REMOVAL_MAX_PENDING_MS = ABYSSAL_WEATHER_REMOVAL_MAX_PENDING_MS;
}

function initializeManagerGroup7Binding126(scope) {
  const ABYSSAL_WEATHER_REMOVAL_MAX_ATTEMPTS = 60;
  scope.ABYSSAL_WEATHER_REMOVAL_MAX_ATTEMPTS = ABYSSAL_WEATHER_REMOVAL_MAX_ATTEMPTS;
}

function initializeManagerGroup7Binding127(scope) {
  const PLACEHOLDER_RELOG_RECOVERY_RADIUS_METERS = 5_000_000;
  scope.PLACEHOLDER_RELOG_RECOVERY_RADIUS_METERS = PLACEHOLDER_RELOG_RECOVERY_RADIUS_METERS;
}

function initializeManagerGroup7Binding128(scope) {
  const PLACEHOLDER_ROOM_CLEANUP_RADIUS_METERS = 250_000;
  scope.PLACEHOLDER_ROOM_CLEANUP_RADIUS_METERS = PLACEHOLDER_ROOM_CLEANUP_RADIUS_METERS;
}

function initializeManagerGroup7Binding129(scope) {
  const PLACEHOLDER_ENCOUNTER_OFFSET_METERS = scope.PLACEHOLDER_NPC_CONDUIT_ORBIT_RADIUS_METERS;
  scope.PLACEHOLDER_ENCOUNTER_OFFSET_METERS = PLACEHOLDER_ENCOUNTER_OFFSET_METERS;
}

function initializeManagerGroup7Binding130(scope) {
  const PLACEHOLDER_REWARD_CACHE_OFFSET_METERS = scope.PLACEHOLDER_REWARD_CACHE_FROM_CONDUIT_METERS;
  scope.PLACEHOLDER_REWARD_CACHE_OFFSET_METERS = PLACEHOLDER_REWARD_CACHE_OFFSET_METERS;
}

function initializeManagerGroup7Binding131(scope) {
  const PLACEHOLDER_REWARD_CACHE_MAX_REPAIRS = 1;
  scope.PLACEHOLDER_REWARD_CACHE_MAX_REPAIRS = PLACEHOLDER_REWARD_CACHE_MAX_REPAIRS;
}

function initializeManagerGroup7Binding132(scope) {
  const ABYSSAL_CALM_TIER_REWARD_QUANTITY_MULTIPLIER = 3;
  scope.ABYSSAL_CALM_TIER_REWARD_QUANTITY_MULTIPLIER = ABYSSAL_CALM_TIER_REWARD_QUANTITY_MULTIPLIER;
}

function initializeManagerGroup7Binding133(scope) {
  const ABYSSAL_TIER0_REWARD_OUTPUT_MULTIPLIER = 0.75;
  scope.ABYSSAL_TIER0_REWARD_OUTPUT_MULTIPLIER = ABYSSAL_TIER0_REWARD_OUTPUT_MULTIPLIER;
}

function initializeManagerGroup7Binding134(scope) {
  const ABYSSAL_BLUEPRINT_COPY_MIN_RUNS = 1;
  scope.ABYSSAL_BLUEPRINT_COPY_MIN_RUNS = ABYSSAL_BLUEPRINT_COPY_MIN_RUNS;
}

function initializeManagerGroup7Binding135(scope) {
  const ABYSSAL_BLUEPRINT_COPY_MAX_RUNS = 5;
  scope.ABYSSAL_BLUEPRINT_COPY_MAX_RUNS = ABYSSAL_BLUEPRINT_COPY_MAX_RUNS;
}

function initializeManagerGroup7Binding136(scope) {
  const ABYSSAL_TIER1_REWARD_STRUCTURE_DURABILITY = Object.freeze({
  shieldCapacity: 0,
  shieldRechargeRate: 0,
  armorHP: 0,
  structureHP: 400,
});
  scope.ABYSSAL_TIER1_REWARD_STRUCTURE_DURABILITY = ABYSSAL_TIER1_REWARD_STRUCTURE_DURABILITY;
}

function initializeManagerGroup7Binding137(scope) {
  const PLACEHOLDER_POCKET_MODE = "same-system-remote-coordinate-private-dungeon";
  scope.PLACEHOLDER_POCKET_MODE = PLACEHOLDER_POCKET_MODE;
}

function initializeManagerGroup7Binding138(scope) {
  const PLACEHOLDER_POCKET_ISOLATION = "same-scene-solar-system-placeholder";
  scope.PLACEHOLDER_POCKET_ISOLATION = PLACEHOLDER_POCKET_ISOLATION;
}

function initializeManagerGroup7Binding139(scope) {
  const ABYSS_UNSUPPORTED_FILAMENT_NOTIFY = "That Abyssal filament is not supported yet.";
  scope.ABYSS_UNSUPPORTED_FILAMENT_NOTIFY = ABYSS_UNSUPPORTED_FILAMENT_NOTIFY;
}

function initializeManagerGroup7Binding140(scope) {
  const ABYSSAL_PLAYER_ATTRIBUTE_SOURCE_KEY = "abyssalWeather:playerShipAttributeModifierEntries";
  scope.ABYSSAL_PLAYER_ATTRIBUTE_SOURCE_KEY = ABYSSAL_PLAYER_ATTRIBUTE_SOURCE_KEY;
}

function initializeManagerGroup7Binding141(scope) {
  const ABYSSAL_PLAYER_LOCATION_SOURCE_KEY = "abyssalWeather:playerLocationModifierSources";
  scope.ABYSSAL_PLAYER_LOCATION_SOURCE_KEY = ABYSSAL_PLAYER_LOCATION_SOURCE_KEY;
}

function initializeManagerGroup7Binding142(scope) {
  const ABYSSAL_VISIBILITY_STATUS = Object.freeze({
  AVAILABLE: "AVAILABLE",
  DSCAN_BLOCKED: "DSCAN_BLOCKED",
  SYSTEM_SCANNER_BLOCKED: "SYSTEM_SCANNER_BLOCKED",
  LOCAL_SUPPRESSED: "LOCAL_SUPPRESSED",
  MAP_BLOCKED: "MAP_BLOCKED",
  NOT_IMPLEMENTED_IN_EVEJS: "NOT_IMPLEMENTED_IN_EVEJS",
  ACTIVE_ABYSSAL_RUN: "ACTIVE_ABYSSAL_RUN",
  NO_ACTIVE_ABYSSAL_RUN: "NO_ACTIVE_ABYSSAL_RUN",
  RESTRICTION_BYPASSED: "RESTRICTION_BYPASSED",
});
  scope.ABYSSAL_VISIBILITY_STATUS = ABYSSAL_VISIBILITY_STATUS;
}

function initializeManagerGroup7Binding143(scope) {
  const ABYSSAL_INTERNAL_BYPASS = Symbol("abyssal-internal-bypass");
  scope.ABYSSAL_INTERNAL_BYPASS = ABYSSAL_INTERNAL_BYPASS;
}

function initializeManagerGroup7Binding144(scope) {
  const ABYSSAL_TIMEOUT_MODE = Object.freeze({
  SAFE_PLACEHOLDER: "safe_placeholder",
  LETHAL: "lethal",
});
  scope.ABYSSAL_TIMEOUT_MODE = ABYSSAL_TIMEOUT_MODE;
}

function initializeManagerGroup7Binding145(scope) {
  const ABYSSAL_PARTICIPANT_DESTRUCTION_MAP_SCHEMA_VERSION = 1;
  scope.ABYSSAL_PARTICIPANT_DESTRUCTION_MAP_SCHEMA_VERSION = ABYSSAL_PARTICIPANT_DESTRUCTION_MAP_SCHEMA_VERSION;
}

function initializeManagerGroup7Binding146(scope) {
  const ABYSSAL_PARTICIPANT_RETURN_OBLIGATION_SCHEMA_VERSION = 1;
  scope.ABYSSAL_PARTICIPANT_RETURN_OBLIGATION_SCHEMA_VERSION = ABYSSAL_PARTICIPANT_RETURN_OBLIGATION_SCHEMA_VERSION;
}

function initializeManagerGroup7Binding147(scope) {
  const ABYSSAL_PARTICIPANT_ROSTER_SCHEMA_VERSION = 1;
  scope.ABYSSAL_PARTICIPANT_ROSTER_SCHEMA_VERSION = ABYSSAL_PARTICIPANT_ROSTER_SCHEMA_VERSION;
}

function initializeManagerGroup7Binding148(scope) {
  const ABYSSAL_PARTICIPANT_STATUS = Object.freeze({
  RESERVED: "reserved",
  ADMITTING: "admitting",
  ADMISSION_FAILED: "admission_failed",
  ACTIVE: "active",
  DISCONNECTED: "disconnected",
  DESTROYED: "destroyed",
  EXITING: "exiting",
  EXITED: "exited",
});
  scope.ABYSSAL_PARTICIPANT_STATUS = ABYSSAL_PARTICIPANT_STATUS;
}

function initializeManagerGroup7Binding149(scope) {
  const ABYSSAL_TERMINAL_PARTICIPANT_STATUSES = new Set([
  scope.ABYSSAL_PARTICIPANT_STATUS.DESTROYED,
  scope.ABYSSAL_PARTICIPANT_STATUS.EXITED,
]);
  scope.ABYSSAL_TERMINAL_PARTICIPANT_STATUSES = ABYSSAL_TERMINAL_PARTICIPANT_STATUSES;
}

function initializeManagerGroup7Binding150(scope) {
  const ABYSSAL_TRANSITION_FX_PROFILE = Object.freeze({
  profileID: "abyssal:visual:retail-transition-v1",
  entryEffectKey: "jump_out_abyssal",
  transferEffectKey: "jump_out_abyssal_between",
  exitEffectKey: "jump_out_abyssal",
  arrivalEffectKey: "abyssal_reentry_splash",
  // TQTranquilAbyssal5.txt: JumpOutAbyssalBetween at 23:22:58 and
  // destination scene setup at 23:23:05. Use the captured seven-second handoff.
  transferTransitionDelayMs: 7_000,
  exitTransitionDelayMs: 4_500,
});
  scope.ABYSSAL_TRANSITION_FX_PROFILE = ABYSSAL_TRANSITION_FX_PROFILE;
}

function initializeManagerGroup7Binding151(scope) {
  const ABYSSAL_POST_SETSTATE_ENVIRONMENT_RETRY_DELAY_MS = 250;
  scope.ABYSSAL_POST_SETSTATE_ENVIRONMENT_RETRY_DELAY_MS = ABYSSAL_POST_SETSTATE_ENVIRONMENT_RETRY_DELAY_MS;
}

function initializeManagerGroup7Binding152(scope) {
  const OPTIONAL_CLOUD_PRESENTATION_NOT_AUTHORED = "OPTIONAL_CLOUD_PRESENTATION_NOT_AUTHORED";
  scope.OPTIONAL_CLOUD_PRESENTATION_NOT_AUTHORED = OPTIONAL_CLOUD_PRESENTATION_NOT_AUTHORED;
}

function initializeManagerGroup7Binding153(scope) {
  const ABYSSAL_BEYONCE_POST_SETSTATE_ARRIVAL_FX_DELAY_MS = 1_000;
  scope.ABYSSAL_BEYONCE_POST_SETSTATE_ARRIVAL_FX_DELAY_MS = ABYSSAL_BEYONCE_POST_SETSTATE_ARRIVAL_FX_DELAY_MS;
}

function initializeManagerGroup7Binding154(scope) {
  const ABYSSAL_KSPACE_ARRIVAL_READINESS_EXPIRY_MS = 15_000;
  scope.ABYSSAL_KSPACE_ARRIVAL_READINESS_EXPIRY_MS = ABYSSAL_KSPACE_ARRIVAL_READINESS_EXPIRY_MS;
}

function initializeManagerGroup7Binding155(scope) {
  const ABYSSAL_SCENERY_VISUAL_ROLE = "environment_visual";
  scope.ABYSSAL_SCENERY_VISUAL_ROLE = ABYSSAL_SCENERY_VISUAL_ROLE;
}

function initializeManagerGroup7Binding156(scope) {
  const ABYSSAL_ENVIRONMENTAL_OBJECT_ROLE = "environmental_object";
  scope.ABYSSAL_ENVIRONMENTAL_OBJECT_ROLE = ABYSSAL_ENVIRONMENTAL_OBJECT_ROLE;
}

function initializeManagerGroup7Binding157(scope) {
  const CALM_SCENERY_SUPPORTED_WEATHER_TYPES = Object.freeze([
  "dark",
  "electrical",
  "exotic",
  "firestorm",
  "gamma",
]);
  scope.CALM_SCENERY_SUPPORTED_WEATHER_TYPES = CALM_SCENERY_SUPPORTED_WEATHER_TYPES;
}

function initializeManagerGroup7Binding158(scope) {
  const ABYSSAL_ROOM_VISUAL_PROFILE = Object.freeze({
  profileID: "abyssal:visual:t0-dark-entering-dungeon-room-v2",
  blockReason: "ENVIRONMENT_PROFILE_NOT_AUTHORED",
  skybox: "NOT_FOUND",
  perRoomSkybox: "NOT_FOUND",
  fog: "NOT_FOUND",
  colorGrading: "NOT_FOUND",
  backgroundLighting: "CLIENT_NOTIFICATION_DRIVEN",
  ambientClientEffects: "CLIENT_NOTIFICATION_DRIVEN",
});
  scope.ABYSSAL_ROOM_VISUAL_PROFILE = ABYSSAL_ROOM_VISUAL_PROFILE;
}

function bindAbyssalManagerRuntimeGroup7Operations(scope) {

}

function initializeAbyssalManagerRuntimeGroup7Part1(scope) {
  initializeManagerGroup7Binding1(scope);
  initializeManagerGroup7Binding2(scope);
  initializeManagerGroup7Binding3(scope);
  initializeManagerGroup7Binding4(scope);
  initializeManagerGroup7Binding5(scope);
  initializeManagerGroup7Binding6(scope);
  initializeManagerGroup7Binding7(scope);
  initializeManagerGroup7Binding8(scope);
  initializeManagerGroup7Binding9(scope);
  initializeManagerGroup7Binding10(scope);
  initializeManagerGroup7Binding11(scope);
  initializeManagerGroup7Binding12(scope);
  initializeManagerGroup7Binding13(scope);
  initializeManagerGroup7Binding14(scope);
  initializeManagerGroup7Binding15(scope);
  initializeManagerGroup7Binding16(scope);
  initializeManagerGroup7Binding17(scope);
  initializeManagerGroup7Binding18(scope);
  initializeManagerGroup7Binding19(scope);
  initializeManagerGroup7Binding20(scope);
  initializeManagerGroup7Binding21(scope);
  initializeManagerGroup7Binding22(scope);
  initializeManagerGroup7Binding23(scope);
  initializeManagerGroup7Binding24(scope);
  initializeManagerGroup7Binding25(scope);
  initializeManagerGroup7Binding26(scope);
  initializeManagerGroup7Binding27(scope);
  initializeManagerGroup7Binding28(scope);
  initializeManagerGroup7Binding29(scope);
  initializeManagerGroup7Binding30(scope);
  initializeManagerGroup7Binding31(scope);
  initializeManagerGroup7Binding32(scope);
  initializeManagerGroup7Binding33(scope);
  initializeManagerGroup7Binding34(scope);
  initializeManagerGroup7Binding35(scope);
  initializeManagerGroup7Binding36(scope);
  initializeManagerGroup7Binding37(scope);
  initializeManagerGroup7Binding38(scope);
  initializeManagerGroup7Binding39(scope);
  initializeManagerGroup7Binding40(scope);
  initializeManagerGroup7Binding41(scope);
  initializeManagerGroup7Binding42(scope);
  initializeManagerGroup7Binding43(scope);
  initializeManagerGroup7Binding44(scope);
  initializeManagerGroup7Binding45(scope);
  initializeManagerGroup7Binding46(scope);
  initializeManagerGroup7Binding47(scope);
  initializeManagerGroup7Binding48(scope);
  initializeManagerGroup7Binding49(scope);
  initializeManagerGroup7Binding50(scope);
  initializeManagerGroup7Binding51(scope);
  initializeManagerGroup7Binding52(scope);
  initializeManagerGroup7Binding53(scope);
  initializeManagerGroup7Binding54(scope);
  initializeManagerGroup7Binding55(scope);
  initializeManagerGroup7Binding56(scope);
  initializeManagerGroup7Binding57(scope);
  initializeManagerGroup7Binding58(scope);
  initializeManagerGroup7Binding59(scope);
  initializeManagerGroup7Binding60(scope);
  initializeManagerGroup7Binding61(scope);
  initializeManagerGroup7Binding62(scope);
  initializeManagerGroup7Binding63(scope);
  initializeManagerGroup7Binding64(scope);
  initializeManagerGroup7Binding65(scope);
  initializeManagerGroup7Binding66(scope);
  initializeManagerGroup7Binding67(scope);
  initializeManagerGroup7Binding68(scope);
  initializeManagerGroup7Binding69(scope);
  initializeManagerGroup7Binding70(scope);
  initializeManagerGroup7Binding71(scope);
  initializeManagerGroup7Binding72(scope);
  initializeManagerGroup7Binding73(scope);
  initializeManagerGroup7Binding74(scope);
  initializeManagerGroup7Binding75(scope);
  initializeManagerGroup7Binding76(scope);
  initializeManagerGroup7Binding77(scope);
  initializeManagerGroup7Binding78(scope);
  initializeManagerGroup7Binding79(scope);
  initializeManagerGroup7Binding80(scope);
}

function initializeAbyssalManagerRuntimeGroup7Part2(scope) {
  initializeManagerGroup7Binding81(scope);
  initializeManagerGroup7Binding82(scope);
  initializeManagerGroup7Binding83(scope);
  initializeManagerGroup7Binding84(scope);
  initializeManagerGroup7Binding85(scope);
  initializeManagerGroup7Binding86(scope);
  initializeManagerGroup7Binding87(scope);
  initializeManagerGroup7Binding88(scope);
  initializeManagerGroup7Binding89(scope);
  initializeManagerGroup7Binding90(scope);
  initializeManagerGroup7Binding91(scope);
  initializeManagerGroup7Binding92(scope);
  initializeManagerGroup7Binding93(scope);
  initializeManagerGroup7Binding94(scope);
  initializeManagerGroup7Binding95(scope);
  initializeManagerGroup7Binding96(scope);
  initializeManagerGroup7Binding97(scope);
  initializeManagerGroup7Binding98(scope);
  initializeManagerGroup7Binding99(scope);
  initializeManagerGroup7Binding100(scope);
  initializeManagerGroup7Binding101(scope);
  initializeManagerGroup7Binding102(scope);
  initializeManagerGroup7Binding103(scope);
  initializeManagerGroup7Binding104(scope);
  initializeManagerGroup7Binding105(scope);
  initializeManagerGroup7Binding106(scope);
  initializeManagerGroup7Binding107(scope);
  initializeManagerGroup7Binding108(scope);
  initializeManagerGroup7Binding109(scope);
  initializeManagerGroup7Binding110(scope);
  initializeManagerGroup7Binding111(scope);
  initializeManagerGroup7Binding112(scope);
  initializeManagerGroup7Binding113(scope);
  initializeManagerGroup7Binding114(scope);
  initializeManagerGroup7Binding115(scope);
  initializeManagerGroup7Binding116(scope);
  initializeManagerGroup7Binding117(scope);
  initializeManagerGroup7Binding118(scope);
  initializeManagerGroup7Binding119(scope);
  initializeManagerGroup7Binding120(scope);
  initializeManagerGroup7Binding121(scope);
  initializeManagerGroup7Binding122(scope);
  initializeManagerGroup7Binding123(scope);
  initializeManagerGroup7Binding124(scope);
  initializeManagerGroup7Binding125(scope);
  initializeManagerGroup7Binding126(scope);
  initializeManagerGroup7Binding127(scope);
  initializeManagerGroup7Binding128(scope);
  initializeManagerGroup7Binding129(scope);
  initializeManagerGroup7Binding130(scope);
  initializeManagerGroup7Binding131(scope);
  initializeManagerGroup7Binding132(scope);
  initializeManagerGroup7Binding133(scope);
  initializeManagerGroup7Binding134(scope);
  initializeManagerGroup7Binding135(scope);
  initializeManagerGroup7Binding136(scope);
  initializeManagerGroup7Binding137(scope);
  initializeManagerGroup7Binding138(scope);
  initializeManagerGroup7Binding139(scope);
  initializeManagerGroup7Binding140(scope);
  initializeManagerGroup7Binding141(scope);
  initializeManagerGroup7Binding142(scope);
  initializeManagerGroup7Binding143(scope);
  initializeManagerGroup7Binding144(scope);
  initializeManagerGroup7Binding145(scope);
  initializeManagerGroup7Binding146(scope);
  initializeManagerGroup7Binding147(scope);
  initializeManagerGroup7Binding148(scope);
  initializeManagerGroup7Binding149(scope);
  initializeManagerGroup7Binding150(scope);
  initializeManagerGroup7Binding151(scope);
  initializeManagerGroup7Binding152(scope);
  initializeManagerGroup7Binding153(scope);
  initializeManagerGroup7Binding154(scope);
  initializeManagerGroup7Binding155(scope);
  initializeManagerGroup7Binding156(scope);
  initializeManagerGroup7Binding157(scope);
  initializeManagerGroup7Binding158(scope);
}

function initializeAbyssalManagerRuntimeGroup7(scope) {
  initializeAbyssalManagerRuntimeGroup7Part1(scope);
  initializeAbyssalManagerRuntimeGroup7Part2(scope);
}

module.exports = {
  bindAbyssalManagerRuntimeGroup7Operations,
  initializeAbyssalManagerRuntimeGroup7,
};
