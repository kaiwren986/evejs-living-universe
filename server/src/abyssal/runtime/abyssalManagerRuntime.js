"use strict";

const crypto = require("node:crypto");
const { createAbyssalFinalExitInputs } = require("./abyssalFinalExitInputs");
const { createAbyssalProtocolErrors } = require("./abyssalProtocolErrors");
const { createAbyssalSessionAudit } = require("./abyssalSessionAudit");
const { createAbyssalLayoutDiagnostics } = require("./abyssalLayoutDiagnostics");
const { createAbyssalStaffControls } = require("./abyssalStaffControls");
const { createAbyssalRewardStateViews } = require("./abyssalRewardStateViews");
const { createAbyssalContentMaterializationViews } = require("./abyssalContentMaterializationViews");
const { createAbyssalSceneDiagnostics } = require("./abyssalSceneDiagnostics");
const { createAbyssalSceneMode } = require("./abyssalSceneMode");
const { createAbyssalVisibilityRestrictions } = require("./abyssalVisibilityRestrictions");
const { createAbyssalDeploymentPlacement } = require("./abyssalDeploymentPlacement");
const { createAbyssalAdmissionPolicies } = require("./abyssalAdmissionPolicies");
const { createAbyssalInventoryTypeViews } = require("./abyssalInventoryTypeViews");
const { createAbyssalActivationInputs } = require("./abyssalActivationInputs");
const { createAbyssalRoomClientEffects } = require("./abyssalRoomClientEffects");
const { createAbyssalVisualDiagnostics } = require("./abyssalVisualDiagnostics");
const { createAbyssalProbeCatalogue } = require("./abyssalProbeCatalogue");
const { createAbyssalVisualPolicy } = require("./abyssalVisualPolicy");
const { createAbyssalSpawnGeometry } = require("./abyssalSpawnGeometry");
const { createAbyssalTimerModels } = require("./abyssalTimerModels");
const { createAbyssalRewardLootResolution } = require("./abyssalRewardLootResolution");
const { createAbyssalRewardSelection } = require("./abyssalRewardSelection");
const { createAbyssalRewardPlanModels } = require("./abyssalRewardPlanModels");
const { createAbyssalRewardProfiles } = require("./abyssalRewardProfiles");
const { createAbyssalNpcProfiles } = require("./abyssalNpcProfiles");
const { createAbyssalEncounterViews } = require("./abyssalEncounterViews");
const { createAbyssalEncounterSelection } = require("./abyssalEncounterSelection");
const { createAbyssalRoomDiagnostics } = require("./abyssalRoomDiagnostics");
const { createAbyssalRuntimeDiagnostics } = require("./abyssalRuntimeDiagnostics");
const { createAbyssalStatusReport } = require("./abyssalStatusReport");
const { createAbyssalContentViews } = require("./abyssalContentViews");
const { createAbyssalRoomStateModel } = require("./abyssalRoomStateModel");
const { createAbyssalItemMetadata } = require("./abyssalItemMetadata");
const {
  toInt,
  toReal,
  round6,
  toBool,
  normalizeText,
  normalizeLowerText,
  normalizeVector,
  normalizeDirection,
  addVectors,
  scaleVector,
  hasFiniteVectorCoordinates,
  getObjectPosition,
  getObjectItemID,
  getObjectTypeID,
  getObjectRadius,
  listUniquePositiveInts,
  listPositiveInts,
  listUniqueNonNegativeInts,
  getVectorDistance,
  isFinitePosition,
  formatVectorForLog,
} = require("../domain/abyssalRuntimeValues");
const { createAbyssalStructuralClone } = require("../domain/abyssalStructuralClone");
const { createAbyssalEntranceExecution } = require("./abyssalEntranceExecution");
const { createAbyssalEntranceRequest } = require("./abyssalEntranceRequest");
const { createAbyssalEndGateRequest } = require("./abyssalEndGateRequest");
const { createAbyssalClientReadyRequest } = require("./abyssalClientReadyRequest");
const { createAbyssalDeploymentRequest } = require("./abyssalDeploymentRequest");
const { createAbyssalParticipantRoster } = require("./abyssalParticipantRoster");
const { createAbyssalMaintenanceControl } = require("./abyssalMaintenanceControl");
const { createAbyssalNpcLifecycleMetadata } = require("./abyssalNpcLifecycleMetadata");
const { createAbyssalParticipantSession } = require("./abyssalParticipantSession");
const { createAbyssalRunQueries } = require("./abyssalRunQueries");
const { createAbyssalTerminalEvidence } = require("./abyssalTerminalEvidence");
const { createAbyssalRunMutations } = require("./abyssalRunMutations");
const { createAbyssalAdmissionIdentity } = require("./abyssalAdmissionIdentity");
const { createAbyssalDestructionReceipts } = require("./abyssalDestructionReceipts");
const { createAbyssalReturnObligations } = require("./abyssalReturnObligations");
const { createAbyssalTransitionSettlement } = require("./abyssalTransitionSettlement");
const { createAbyssalDependantLifecycle } = require("./abyssalDependantLifecycle");
const { createAbyssalRecoveryTombstoneOperations } = require("./abyssalRecoveryTombstones");
const { createAbyssalRoomDelivery } = require("./abyssalRoomDelivery");
const { createAbyssalDestinationRequirements } = require("./abyssalDestinationRequirements");
const { createAbyssalTransitionAuthority } = require("./abyssalTransitionAuthority");
const { createAbyssalDungeonNotifications } = require("./abyssalDungeonNotifications");
const { createAbyssalArrivalEffects } = require("./abyssalArrivalEffects");
const { createAbyssalRunReconstruction } = require("./abyssalRunReconstruction");
const { createAbyssalRunRegistration } = require("./abyssalRunRegistration");
const { createAbyssalTransitionEffects } = require("./abyssalTransitionEffects");
const { createAbyssalRoomProgression } = require("./abyssalRoomProgression");
const { createAbyssalPlayerObjectCleanup } = require("./abyssalPlayerObjectCleanup");
const { createAbyssalFilamentCompensation } = require("./abyssalFilamentCompensation");
const { createAbyssalSuspectEffects } = require("./abyssalSuspectEffects");
const { createAbyssalReturnProtection } = require("./abyssalReturnProtection");
const { createAbyssalRunMaintenance } = require("./abyssalRunMaintenance");
const { createAbyssalAdmissionComposition } = require("./abyssalAdmissionComposition");
const { createAbyssalNpcOutcomeComposition } = require("./abyssalNpcOutcomeComposition");
const { createAbyssalNpcControllers } = require("./abyssalNpcControllers");
const {
  createAbyssalNpcWatchdog,
  resolveAbyssalNpcControllerExpectedCombatTickIntervalMs,
  resolveAbyssalNpcControllerStaleThresholdMs,
  resolveAbyssalNpcControllerLiveness,
} = require("./abyssalNpcWatchdog");
const { createAbyssalDestructionCallback } = require("./abyssalDestructionCallback");
const { createAbyssalPodSettlement } = require("./abyssalPodSettlement");
const { createAbyssalParticipantExecution } = require("./abyssalParticipantExecution");
const { createAbyssalDeathRecovery } = require("./abyssalDeathRecovery");
const { createAbyssalDestructionCommits } = require("./abyssalDestructionCommits");
const path = require("path");
const BaseService = require("../../services/baseService");
const AbyssalContentManagerService = require("../transport/abyssalContentManagerService");
const abyssalFilamentCompensationStore = require("../state/abyssalFilamentCompensationStore");
const log = require("../../utils/logger");
const { bindAbyssalManagerRuntimeGroup1Operations, initializeAbyssalManagerRuntimeGroup1 } = require("./abyssalManagerRuntimeGroup1");
const { bindAbyssalManagerRuntimeGroup2Operations, initializeAbyssalManagerRuntimeGroup2 } = require("./abyssalManagerRuntimeGroup2");
const { bindAbyssalManagerRuntimeGroup3Operations, initializeAbyssalManagerRuntimeGroup3 } = require("./abyssalManagerRuntimeGroup3");
const { bindAbyssalManagerRuntimeGroup4Operations, initializeAbyssalManagerRuntimeGroup4 } = require("./abyssalManagerRuntimeGroup4");
const { bindAbyssalManagerRuntimeGroup5Operations, initializeAbyssalManagerRuntimeGroup5 } = require("./abyssalManagerRuntimeGroup5");
const { bindAbyssalManagerRuntimeGroup6Operations, initializeAbyssalManagerRuntimeGroup6 } = require("./abyssalManagerRuntimeGroup6");
const { bindAbyssalManagerRuntimeGroup7Operations, initializeAbyssalManagerRuntimeGroup7 } = require("./abyssalManagerRuntimeGroup7");
const { bindAbyssalManagerRuntimeGroup8Operations, initializeAbyssalManagerRuntimeGroup8 } = require("./abyssalManagerRuntimeGroup8");
const { bindAbyssalManagerRuntimeGroup9Operations, initializeAbyssalManagerRuntimeGroup9 } = require("./abyssalManagerRuntimeGroup9");
const { bindAbyssalManagerRuntimeGroup10Operations, initializeAbyssalManagerRuntimeGroup10 } = require("./abyssalManagerRuntimeGroup10");
const { bindAbyssalManagerRuntimeGroup11Operations, initializeAbyssalManagerRuntimeGroup11 } = require("./abyssalManagerRuntimeGroup11");
const { bindAbyssalManagerRuntimeGroup12Operations, initializeAbyssalManagerRuntimeGroup12 } = require("./abyssalManagerRuntimeGroup12");
const { bindAbyssalManagerRuntimeGroup13Operations, initializeAbyssalManagerRuntimeGroup13 } = require("./abyssalManagerRuntimeGroup13");

function createAbyssalManagerRuntime() {
  const scope = {
    AbyssalContentManagerService,
    BaseService,
    abyssalFilamentCompensationStore,
    addVectors,
    createAbyssalActivationInputs,
    createAbyssalAdmissionComposition,
    createAbyssalAdmissionIdentity,
    createAbyssalAdmissionPolicies,
    createAbyssalArrivalEffects,
    createAbyssalClientReadyRequest,
    createAbyssalContentMaterializationViews,
    createAbyssalContentViews,
    createAbyssalDeathRecovery,
    createAbyssalDependantLifecycle,
    createAbyssalDeploymentPlacement,
    createAbyssalDeploymentRequest,
    createAbyssalDestinationRequirements,
    createAbyssalDestructionCallback,
    createAbyssalDestructionCommits,
    createAbyssalDestructionReceipts,
    createAbyssalDungeonNotifications,
    createAbyssalEncounterSelection,
    createAbyssalEncounterViews,
    createAbyssalEndGateRequest,
    createAbyssalEntranceExecution,
    createAbyssalEntranceRequest,
    createAbyssalFilamentCompensation,
    createAbyssalFinalExitInputs,
    createAbyssalInventoryTypeViews,
    createAbyssalItemMetadata,
    createAbyssalLayoutDiagnostics,
    createAbyssalMaintenanceControl,
    createAbyssalNpcControllers,
    createAbyssalNpcLifecycleMetadata,
    createAbyssalNpcOutcomeComposition,
    createAbyssalNpcProfiles,
    createAbyssalNpcWatchdog,
    createAbyssalParticipantExecution,
    createAbyssalParticipantRoster,
    createAbyssalParticipantSession,
    createAbyssalPlayerObjectCleanup,
    createAbyssalPodSettlement,
    createAbyssalProbeCatalogue,
    createAbyssalProtocolErrors,
    createAbyssalRecoveryTombstoneOperations,
    createAbyssalReturnObligations,
    createAbyssalReturnProtection,
    createAbyssalRewardLootResolution,
    createAbyssalRewardPlanModels,
    createAbyssalRewardProfiles,
    createAbyssalRewardSelection,
    createAbyssalRewardStateViews,
    createAbyssalRoomClientEffects,
    createAbyssalRoomDelivery,
    createAbyssalRoomDiagnostics,
    createAbyssalRoomProgression,
    createAbyssalRoomStateModel,
    createAbyssalRunMaintenance,
    createAbyssalRunMutations,
    createAbyssalRunQueries,
    createAbyssalRunReconstruction,
    createAbyssalRunRegistration,
    createAbyssalRuntimeDiagnostics,
    createAbyssalSceneDiagnostics,
    createAbyssalSceneMode,
    createAbyssalSessionAudit,
    createAbyssalSpawnGeometry,
    createAbyssalStaffControls,
    createAbyssalStatusReport,
    createAbyssalStructuralClone,
    createAbyssalSuspectEffects,
    createAbyssalTerminalEvidence,
    createAbyssalTimerModels,
    createAbyssalTransitionAuthority,
    createAbyssalTransitionEffects,
    createAbyssalTransitionSettlement,
    createAbyssalVisibilityRestrictions,
    createAbyssalVisualDiagnostics,
    createAbyssalVisualPolicy,
    crypto,
    formatVectorForLog,
    getObjectItemID,
    getObjectPosition,
    getObjectRadius,
    getObjectTypeID,
    getVectorDistance,
    hasFiniteVectorCoordinates,
    isFinitePosition,
    listPositiveInts,
    listUniqueNonNegativeInts,
    listUniquePositiveInts,
    log,
    normalizeDirection,
    normalizeLowerText,
    normalizeText,
    normalizeVector,
    path,
    resolveAbyssalNpcControllerExpectedCombatTickIntervalMs,
    resolveAbyssalNpcControllerLiveness,
    resolveAbyssalNpcControllerStaleThresholdMs,
    round6,
    scaleVector,
    toBool,
    toInt,
    toReal,
  };
  bindAbyssalManagerRuntimeGroup1Operations(scope);
  bindAbyssalManagerRuntimeGroup2Operations(scope);
  bindAbyssalManagerRuntimeGroup3Operations(scope);
  bindAbyssalManagerRuntimeGroup4Operations(scope);
  bindAbyssalManagerRuntimeGroup5Operations(scope);
  bindAbyssalManagerRuntimeGroup6Operations(scope);
  bindAbyssalManagerRuntimeGroup7Operations(scope);
  bindAbyssalManagerRuntimeGroup8Operations(scope);
  bindAbyssalManagerRuntimeGroup9Operations(scope);
  bindAbyssalManagerRuntimeGroup10Operations(scope);
  bindAbyssalManagerRuntimeGroup11Operations(scope);
  bindAbyssalManagerRuntimeGroup12Operations(scope);
  bindAbyssalManagerRuntimeGroup13Operations(scope);
  initializeAbyssalManagerRuntimeGroup1(scope);
  initializeAbyssalManagerRuntimeGroup2(scope);
  initializeAbyssalManagerRuntimeGroup3(scope);
  initializeAbyssalManagerRuntimeGroup4(scope);
  initializeAbyssalManagerRuntimeGroup5(scope);
  initializeAbyssalManagerRuntimeGroup6(scope);
  initializeAbyssalManagerRuntimeGroup7(scope);
  initializeAbyssalManagerRuntimeGroup8(scope);
  initializeAbyssalManagerRuntimeGroup9(scope);
  initializeAbyssalManagerRuntimeGroup10(scope);
  initializeAbyssalManagerRuntimeGroup11(scope);
  initializeAbyssalManagerRuntimeGroup12(scope);
  initializeAbyssalManagerRuntimeGroup13(scope);
  return scope;
}

module.exports = createAbyssalManagerRuntime();
