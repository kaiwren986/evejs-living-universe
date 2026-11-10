"use strict";

const { createPublishedFacade } = require("./publishedFacade");

module.exports = createPublishedFacade([
  "configureAbyssalEnginePort",
  "getConfiguredAbyssalEnginePort",
  "handleSessionDisconnect",
  "handleSessionShipDestroyed",
  "prepareAbyssalRuntimeArtifactDestruction",
  "handleAbyssalRuntimeArtifactDestroyed",
  "handleAbyssalRewardLootContainerRemoved",
  "handleAbyssalEnvironmentalObjectDestroyed",
  "handleAbyssalNpcDestroyed",
  "handleAbyssalNpcsDestroyed",
  "queuePendingAbyssalNpcDestroyed",
  "ensureClientReadyBallparkPrimed",
  "recoverAbyssalSessionStateForBeyonce",
  "recoverAbyssalSessionState",
  "rollbackFreshEntryBootstrapForBeyonce",
  "completeAbyssalEntryReadyForBeyonce",
  "completeAbyssalKSpaceArrivalForBeyonce",
  "resolveCharacterSpaceLocationBeforeLogin",
  "validateInitialCharacterSelectionAbyssalLocation",
  "prepareStartupRecoveryBarrier",
  "rescueAbyssalSession",
  "abortAbyssalRunForAdministrativeTransition",
  "evacuateAbyssalRunSession",
]);
