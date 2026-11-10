"use strict";

const runtime = require("./abyssalManagerRuntime");
const { runAfterSessionSetState } = require("./abyssalSetStateDelivery");

const facade = {};
facade.configureAbyssalEnginePort = runtime.configureAbyssalEnginePort;
facade.getConfiguredAbyssalEnginePort = runtime.getConfiguredAbyssalEnginePort;
facade.handleSessionDisconnect = function handleSessionDisconnect(session, options = {}) {
  return (0, runtime.handleAbyssalSessionDisconnect)(session, options, (0, runtime.getDependencies)());
};
facade.handleSessionShipDestroyed =
  function handleSessionShipDestroyed(session, options = {}) {
    return (0, runtime.handleAbyssalSessionShipDestroyed)(session, options, (0, runtime.getDependencies)());
  };
facade.prepareAbyssalRuntimeArtifactDestruction =
  function prepareRuntimeArtifactDestruction(destroyedArtifact = {}) {
    return (0, runtime.prepareAbyssalRuntimeArtifactDestruction)(
      destroyedArtifact,
      (0, runtime.getDependencies)(),
    );
  };
facade.handleAbyssalRuntimeArtifactDestroyed =
  function handleRuntimeArtifactDestroyed(destroyedArtifact = {}) {
    return (0, runtime.handleAbyssalRuntimeArtifactDestroyed)(destroyedArtifact, (0, runtime.getDependencies)());
  };
facade.handleAbyssalRewardLootContainerRemoved =
  function handleRewardLootContainerRemoved(containerItem, reason = "reward-loot-container-removed") {
    return (0, runtime.handleAbyssalRewardLootContainerRemoved)(containerItem, reason, (0, runtime.getDependencies)());
  };
facade.handleAbyssalEnvironmentalObjectDestroyed =
  function handleEnvironmentalObjectDestroyed(destroyedEnvironmentalObject = {}) {
    return (0, runtime.handleAbyssalEnvironmentalObjectDestroyed)(
      destroyedEnvironmentalObject,
      (0, runtime.getDependencies)(),
    );
  };
facade.handleAbyssalNpcDestroyed =
  function handleAbyssalNpcDestroyedStatic(destroyedNpc = {}) {
    return (0, runtime.handleAbyssalNpcDestroyed)(destroyedNpc, (0, runtime.getDependencies)());
  };
facade.handleAbyssalNpcsDestroyed =
  async function handleAbyssalNpcsDestroyedStatic(destroyedNpcs = []) {
    return (0, runtime.handleAbyssalNpcsDestroyed)(destroyedNpcs, (0, runtime.getDependencies)());
  };
facade.queuePendingAbyssalNpcDestroyed =
  function queuePendingAbyssalNpcDestroyedStatic(destroyedNpc = {}, options = {}) {
    return (0, runtime.queuePendingAbyssalNpcDestroyed)(destroyedNpc, options);
  };
facade.ensureClientReadyBallparkPrimed =
  function ensureClientReadyBallparkPrimedForBeyonce(session, options = {}) {
    return (0, runtime.ensureClientReadyBallparkPrimed)(
      session,
      (0, runtime.getDependencies)(),
      (0, runtime.getSessionContext)(session),
      options,
    );
  };
facade.recoverAbyssalSessionStateForBeyonce =
  function recoverAbyssalSessionStateForBeyonce(session) {
    return (0, runtime.routeAbyssalSessionStateForBeyonce)(session, (0, runtime.getDependencies)());
  };
facade.recoverAbyssalSessionState =
  function recoverAbyssalSessionStateStatic(session, options = {}) {
    return (0, runtime.recoverAbyssalSessionState)(session, (0, runtime.getDependencies)(), options);
  };
facade.rollbackFreshEntryBootstrapForBeyonce =
  function rollbackFreshEntryBootstrapForBeyonce(session, reason = "FRESH_ENTRY_BOOTSTRAP_FAILED") {
    const pocketState = (0, runtime.getActivePocketStateForCharacterID)((0, runtime.getCharacterID)(session));
    return pocketState
      ? (0, runtime.rollbackAbyssalFreshEntryBootstrap)(session, pocketState, reason, (0, runtime.getDependencies)())
      : { recovered: false, evacuated: false, reason: "NO_ACTIVE_POCKET" };
  };
// Both run once the bind's SetState is out (abyssalSetStateDelivery.js).
facade.completeAbyssalEntryReadyForBeyonce =
  function completeAbyssalEntryReadyForBeyonce(session) {
    const deps = (0, runtime.getDependencies)();
    const delivery = runAfterSessionSetState(deps, session, () => (
      (0, runtime.completeAbyssalEntryReadyForSession)(session, deps, "beyonce-post-setstate")
    ));
    return delivery.deferred
      ? { success: false, deferred: true, reason: "AWAITING_SETSTATE" }
      : delivery.result;
  };
facade.completeAbyssalKSpaceArrivalForBeyonce =
  function completeAbyssalKSpaceArrivalForBeyonce(session) {
    if (!session || !session._abyssalKSpaceArrival) {
      return null;
    }
    const deps = (0, runtime.getDependencies)();
    const delivery = runAfterSessionSetState(deps, session, () => (
      (0, runtime.completeAbyssalKSpaceArrivalForSession)(session, deps, "beyonce-post-setstate")
    ));
    return delivery.deferred
      ? { success: false, scheduled: true, reason: "AWAITING_SETSTATE" }
      : delivery.result;
  };
facade.resolveCharacterSpaceLocationBeforeLogin =
  function resolveCharacterSpaceLocationBeforeLoginStatic(options = {}) {
    return (0, runtime.resolveCharacterSpaceLocationBeforeLogin)(options, (0, runtime.getDependencies)());
  };
facade.validateInitialCharacterSelectionAbyssalLocation =
  function validateInitialCharacterSelectionAbyssalLocationStatic(session, notificationPlan) {
    return (0, runtime.validateInitialCharacterSelectionAbyssalLocation)(session, notificationPlan, (0, runtime.getDependencies)());
  };
facade.prepareStartupRecoveryBarrier =
  function prepareStartupRecoveryBarrierStatic(reason = "startup", sessionOrOptions = null) {
    return (0, runtime.prepareStartupRecoveryBarrier)(reason, sessionOrOptions, (0, runtime.getDependencies)());
  };
facade.rescueAbyssalSession =
  function rescueAbyssalSessionStatic(session, reason = "manual-rescue") {
    return (0, runtime.rescueAbyssalSession)(session, reason, (0, runtime.getDependencies)());
  };
facade.abortAbyssalRunForAdministrativeTransition =
  function abortAbyssalRunForAdministrativeTransitionStatic(session, reason = "admin-aborted") {
    return (0, runtime.abortAbyssalRunForAdministrativeTransition)(session, reason, (0, runtime.getDependencies)());
  };
facade.evacuateAbyssalRunSession =
  function evacuateAbyssalRunSessionStatic(session, pocketState, reason = "manual-rescue") {
    const terminalGuard = (0, runtime.evaluateAbyssalDirectCallbackTerminalGuard)(
      pocketState,
      "direct-run-evacuation",
    );
    if (terminalGuard.blocked) {
      return (0, runtime.buildAbyssalDirectCallbackSuppressedResult)(terminalGuard, {
        handled: true,
        extra: {
          evacuated: false,
          cleanupSkipped: true,
        },
      });
    }
    return (0, runtime.evacuateAbyssalRunSession)(session, pocketState, reason, (0, runtime.getDependencies)());
  };
facade.getActiveAbyssalRunForCharacterID = runtime.getActiveAbyssalRunForCharacterID;
facade.getActiveAbyssalRunForShipID = runtime.getActiveAbyssalRunForShipID;
facade.getActiveAbyssalRunForCharacter = runtime.getActiveAbyssalRunForCharacter;
facade.getActiveAbyssalRunForShip = runtime.getActiveAbyssalRunForShip;
facade.isCharacterInActiveAbyssalRun = runtime.isCharacterInActiveAbyssalRun;
facade.isShipInActiveAbyssalRun = runtime.isShipInActiveAbyssalRun;
Object.defineProperty(facade, "ABYSSAL_INTERNAL_BYPASS", {
  value: runtime.ABYSSAL_INTERNAL_BYPASS,
});
facade.isAbyssalRestrictionBypassAllowed = runtime.isAbyssalRestrictionBypassAllowed;
facade.buildAbyssalVisibilityRestrictionSummaryForSession =
  function buildAbyssalVisibilityRestrictionSummaryForSessionStatic(session, options = {}) {
    return (0, runtime.buildAbyssalVisibilityRestrictionSummaryForSession)(session, options);
  };
facade.resolveAbyssalVisibilityRestrictionForSession =
  function resolveAbyssalVisibilityRestrictionForSessionStatic(session, category, options = {}) {
    return (0, runtime.resolveAbyssalVisibilityRestrictionForSession)(session, category, options);
  };
facade.getAbyssalTimeoutPolicy =
  function getAbyssalTimeoutPolicyStatic() {
    return (0, runtime.getAbyssalTimeoutPolicy)((0, runtime.getDependencies)());
  };
facade.getAbyssalTimeoutState =
  function getAbyssalTimeoutStateStatic(pocketState) {
    return (0, runtime.getAbyssalTimeoutState)(pocketState, (0, runtime.getDependencies)());
  };
facade.playAbyssalCalmDarkFxProbeForSession =
  function playAbyssalCalmDarkFxProbeForSessionStatic(session, effectKey) {
    return (0, runtime.playAbyssalCalmDarkFxProbeForSession)(session, effectKey, (0, runtime.getDependencies)());
  };
facade.spawnAbyssalSceneryProbeForSession =
  function spawnAbyssalSceneryProbeForSessionStatic(session, candidateKey, presetKey = "near") {
    return (0, runtime.spawnAbyssalSceneryProbeForSession)(session, candidateKey, presetKey, (0, runtime.getDependencies)());
  };
facade.stepAbyssalSceneryProbeForSession =
  function stepAbyssalSceneryProbeForSessionStatic(session, direction, presetKey = "near") {
    return (0, runtime.stepAbyssalSceneryProbeForSession)(session, direction, presetKey, (0, runtime.getDependencies)());
  };
facade.listAbyssalSceneryProbeCatalogue =
  function listAbyssalSceneryProbeCatalogueStatic(categoryKey = "all") {
    return (0, runtime.listAbyssalSceneryProbeCatalogue)(categoryKey, (0, runtime.getDependencies)());
  };
facade.listAbyssalSceneryProbeCandidateKeys = runtime.listAbyssalSceneryProbeCandidateKeys;
facade.listAbyssalSceneryProbeCatalogueCategoryKeys =
  runtime.listAbyssalSceneryProbeCatalogueCategoryKeys;
facade.listAbyssalSceneryProbePresetKeys = runtime.listAbyssalSceneryProbePresetKeys;
facade.buildAbyssalWeatherState = runtime.buildAbyssalWeatherState;
facade.resolveAbyssalWeatherStrengthSelection =
  runtime.resolveAbyssalWeatherStrengthSelection;
facade.resolveDeterministicAbyssalWeatherStrengthPercent =
  runtime.resolveDeterministicAbyssalWeatherStrengthPercent;
facade.collectAbyssalShipAttributeModifierEntriesForShipID =
  runtime.collectAbyssalShipAttributeModifierEntriesForShipID;
facade.collectAbyssalNpcShipAttributeModifierEntriesForEntity =
  runtime.collectAbyssalNpcShipAttributeModifierEntriesForEntity;
facade.collectAbyssalLocationModifierSourcesForShipID =
  runtime.collectAbyssalLocationModifierSourcesForShipID;
facade.collectAbyssalLocationModifierSourcesForEntity =
  runtime.collectAbyssalLocationModifierSourcesForEntity;
facade.applyAbyssalWeatherToNpcEntity = runtime.applyAbyssalWeatherToNpcEntity;
facade.setAbyssalSuppressorDebugForSession =
  function setAbyssalSuppressorDebugForSessionStatic(session, enabled) {
    return (0, runtime.setAbyssalSuppressorDebugForSession)(session, enabled, (0, runtime.getDependencies)());
  };
facade.getAbyssalSuppressorDebugForSession =
  function getAbyssalSuppressorDebugForSessionStatic(session) {
    return (0, runtime.getAbyssalSuppressorDebugForSession)(session);
  };
facade.buildAbyssalStatusReportForSession =
  function buildAbyssalStatusReportForSessionStatic(session) {
    return (0, runtime.buildAbyssalStatusReportForSession)(session, (0, runtime.getDependencies)());
  };
facade.listT0DarkLayoutsForStaff = runtime.listT0DarkLayoutsForStaff;
facade.setNextT0DarkLayoutForSession =
  function setNextT0DarkLayoutForSessionStatic(session, layoutSetID) {
    return (0, runtime.setNextT0DarkLayoutForSession)(session, layoutSetID, (0, runtime.getDependencies)());
  };
facade.clearNextT0DarkLayoutForSession = runtime.clearNextT0DarkLayoutForSession;
facade.getT0DarkLayoutStatusForSession = runtime.getT0DarkLayoutStatusForSession;

module.exports = facade;
