"use strict";
const { getWallclockNowMs } = require("../../space/runtime/runtimeClock");
const database = require("../../gameStore");
const campaign = require("./campaignTrailCatalog");
const missions = require("./gallenteMissionCatalog");

// Called inside the mission owner's completion mutation. The event and completed
// mission are persisted together; unlike history, this outbox is never truncated.
function stageCompletion(characterState, characterID, agent, mission) {
  if (!campaign.isEnabled() || !missions.isEligible(agent, mission)) return;
  const state = require("./campaignTrailRuntime").getProgress(characterID);
  const step = missions.getActiveStep(state);
  if (!step || state.missions?.readyAtMs) return;
  const sequence = Number(mission.missionSequence);
  if (!Number.isSafeInteger(sequence) || sequence <= 0) return;
  characterState.electionMissionOutbox = { ...characterState.electionMissionOutbox,
    [sequence]: { seasonID: campaign.SEASON_ID, index: step.index,
      candidateKey: state.candidateKey, completedAtMs: getWallclockNowMs() } };
}

function reconcileProgress(session, state) {
  const trail = require("./campaignTrailRuntime");
  const characterID = trail.getCharacterID(session);
  const owner = require("../agent/missionRuntimeState");
  const pending = owner.getCharacterStateSnapshot(characterID)?.electionMissionOutbox || {};
  if (!Object.keys(pending).length) return;
  // Never award from a completion that exists only in the write-back cache.
  const flushed = database.flushTableSync("missionRuntimeState");
  if (!flushed.success) throw new Error(`Election mission completion flush failed: ${flushed.errorMsg}`);
  for (const [sequence, event] of Object.entries(pending)) {
    const receipt = `${event.seasonID}:${sequence}`;
    if (!state.missionReceipts?.[receipt]) {
      const step = missions.getActiveStep(state);
      const eligible = step && event.seasonID === campaign.SEASON_ID &&
        event.candidateKey === state.candidateKey && event.index === step.index && !state.missions?.readyAtMs;
      if (eligible) {
        state.missions = { ...state.missions, count: Math.min(step.count, (state.missions?.count || 0) + 1) };
        if (state.missions.count >= step.count) state.missions.readyAtMs = event.completedAtMs;
      }
      state.missionReceipts = { ...state.missionReceipts, [receipt]: true };
      trail.saveProgress(characterID, state);
      if (eligible && typeof session.sendNotification === "function") {
        session.sendNotification("OnChallengeProgressUpdate", "charid", [step.challengeID, state.missions.count]);
        if (state.missions.readyAtMs) session.sendNotification("OnChallengeRewardsGranted", "charid", [step.challengeID]);
      }
    }
    const result = owner.mutateCharacterState(characterID, current => {
      delete current.electionMissionOutbox?.[sequence];
      return true;
    });
    if (!result.success) throw new Error(`Election mission acknowledgement failed: ${result.errorMsg}`);
    const acknowledged = database.flushTableSync("missionRuntimeState");
    if (!acknowledged.success) throw new Error(`Election mission acknowledgement flush failed: ${acknowledged.errorMsg}`);
  }
}
module.exports = { stageCompletion, reconcileProgress };
