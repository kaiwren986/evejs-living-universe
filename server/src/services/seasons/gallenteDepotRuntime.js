"use strict";
const campaign = require("./campaignTrailCatalog");
const exploration = require("./gallenteExplorationCatalog");
const PREFIX = "evejs-election:iteration-depot:";
function isDepot(instance) { return Boolean(instance?.templateID?.startsWith(PREFIX)); }
function getRecord(entity) {
  const dungeon = require("../dungeon/dungeonRuntime");
  const instance = dungeon.getInstance(entity?.dungeonSiteInstanceID);
  if (!isDepot(instance) || ![92144,92145].includes(Number(entity?.typeID))) return null;
  return { instance, key: String(entity.dungeonSiteContentKey || entity.itemID) };
}
function restoreContainer(entity) {
  const record = getRecord(entity);
  const hack = record?.instance.spawnState?.electionHacks?.[record.key];
  if (hack) {
    entity.dungeonSiteContentHackingState = 2;
    entity.dungeonSiteContentHackedAtMs = hack.atMs;
  }
}
function reconcileProgress(session, state) {
  const trail = require("./campaignTrailRuntime");
  const dungeon = require("../dungeon/dungeonRuntime");
  const characterID = trail.getCharacterID(session);
  for (const [id, pending] of Object.entries(state.depotPending || {})) {
    const instance = dungeon.getInstance(pending.instanceID);
    const hack = instance?.spawnState?.electionHacks?.[pending.key];
    if (hack && hack.characterID === characterID && !state.depotReceipts?.[id]) {
      const step = exploration.getActiveStep(state);
      const eligible = step && !state.exploration?.readyAtMs && hack.index === step.index && hack.candidateKey === state.candidateKey;
      if (eligible) {
        state.exploration = { ...state.exploration, count: Math.min(step.count, (state.exploration?.count || 0)+1) };
        if (state.exploration.count >= step.count) state.exploration.readyAtMs = hack.atMs;
      }
      state.depotReceipts = { ...state.depotReceipts, [id]: true };
      trail.saveProgress(characterID,state);
      if (eligible && typeof session.sendNotification === "function") {
        session.sendNotification("OnChallengeProgressUpdate","charid",[step.challengeID,state.exploration.count]);
        if (state.exploration.readyAtMs) session.sendNotification("OnChallengeRewardsGranted","charid",[step.challengeID]);
      }
    }
    if (hack && hack.characterID === characterID && !hack.acknowledged) {
      dungeon.mergeSpawnState(instance.instanceID, { electionHacks: {
        ...instance.spawnState.electionHacks, [pending.key]: { ...hack, acknowledged:true },
      } }, { durable:true });
    }
    // Missing receipt means the process stopped before committing the hack.
    state.depotPending = { ...state.depotPending };
    delete state.depotPending[id];
    trail.saveProgress(characterID,state);
  }
}
function commitHack(entity, session, atMs) {
  const record = getRecord(entity);
  if (!record) return false;
  if (!campaign.isEnabled()) throw new Error("The election is disabled.");
  const trail = require("./campaignTrailRuntime");
  const dungeon = require("../dungeon/dungeonRuntime");
  const characterID = trail.getCharacterID(session);
  if (!characterID) throw new Error("A character is required to hack the Depot.");
  const { instance,key } = record;
  const previous = instance.spawnState?.electionHacks?.[key];
  if (previous) {
    if (previous.characterID !== characterID) throw new Error("This container was already hacked.");
    reconcileProgress(session,trail.getProgress(characterID));
    return true;
  }
  const state = trail.getProgress(characterID);
  reconcileProgress(session,state);
  const step = exploration.getActiveStep(state);
  const eligible = step && !state.exploration?.readyAtMs;
  const id = `${instance.instanceID}:${key}`;
  if (eligible) {
    state.depotPending = { ...state.depotPending, [id]: { instanceID:instance.instanceID,key } };
    trail.saveProgress(characterID,state);
  }
  dungeon.mergeSpawnState(instance.instanceID, { electionHacks: {
    ...dungeon.getInstance(instance.instanceID).spawnState?.electionHacks, [key]: { characterID, atMs,
      candidateKey:state.candidateKey, index:eligible ? step.index : null, acknowledged:!eligible },
  } }, { durable:true });
  if (eligible) reconcileProgress(session,state);
  return true;
}
// A pending credit must settle before terminal-site cleanup removes its receipt.
// Failure aborts cleanup and the scheduler retries; already-earned credit is
// recoverable even if the event is disabled in the meantime.
function beforePurge(instance) {
  if (!isDepot(instance)) return;
  const trail = require("./campaignTrailRuntime");
  for (const hack of Object.values(instance.spawnState?.electionHacks || {})) {
    if (!hack.acknowledged) {
      const session = { characterID:hack.characterID };
      reconcileProgress(session,trail.getProgress(hack.characterID));
    }
  }
  const latest = require("../dungeon/dungeonRuntime").getInstance(instance.instanceID);
  if (Object.values(latest?.spawnState?.electionHacks || {}).some(hack => !hack.acknowledged)) {
    throw new Error("Depot cleanup deferred: unresolved hack credit.");
  }
}
module.exports = { isDepot, getRecord, restoreContainer, commitHack, reconcileProgress, beforePurge };
