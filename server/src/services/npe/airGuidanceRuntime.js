"use strict";

const characters = require("../character/characterState");
const inventory = require("../inventory/itemStore");
const { resolveSessionCharacterID } = require("../_shared/sessionIdentity");

// The native navigation lesson selects a nearby type-12 career agent. A pilot
// may choose another career station; the server verifies the actual arrival.
function careerStations() {
  return [...new Set(require("../agent/agentAuthority").listAgents()
    .filter(agent => Number(agent.agentTypeID) === 12)
    .map(agent => Number(agent.stationID)).filter(Boolean))];
}
function atCareerStation(session) {
  const characterID = resolveSessionCharacterID(session);
  const record = characters.getCharacterRecord(characterID), ship = characters.getActiveShipRecord(characterID);
  return Boolean(record && ship?.ownerID === characterID && !inventory.isCapsuleTypeID(ship.typeID)
    && !session._space && Number(session.stationid || session.stationID) === Number(record.stationID)
    && ship.locationID === record.stationID && careerStations().includes(record.stationID));
}
// Step 2.5.01 (client graph 683) waits for one of these ACP goals to be complete
// (HasCompletedAcpGoal: Enforcer, Explorer and Soldier of Fortune career mission 1,
// Industrialist Entrepreneur and Producer career mission 2), then for no ACP reward to be
// left to claim (HasClaimableAcpReward), then for the career portal to close. Nothing in
// chapter 2.5 asks where the pilot is: a reward claimed in space completes the step there.
const ACP_REWARD_REMINDER_GOAL_IDS = Object.freeze([
  "bca73ce6-d2fd-4812-8a7f-def9b9f158d1", "7d202e65-ab0c-4a88-9016-a672aa1b7870",
  "b0091c33-48f3-46fe-8a6c-6449d9f1a969", "99d018db-8a11-4097-a102-4d9b7e600978",
  "9b88fc7a-dd03-4746-8937-d3f796c4d284",
]);
function acpRewardReminderDone(session) {
  const characterID = resolveSessionCharacterID(session);
  if (!characterID) return false;
  const progress = require("../career/careerProgress"), claims = require("../career/careerRewardRuntime");
  const done = goalID => Number(progress.get(characterID, goalID)?.completedAtMs) > 0;
  if (!ACP_REWARD_REMINDER_GOAL_IDS.some(done)) {
    // The client saw the goal complete through a gateway read, which syncs first.
    const synced = progress.sync(characterID);
    if (!synced?.success || !ACP_REWARD_REMINDER_GOAL_IDS.some(done)) return false;
  }
  const snapshot = claims.createClaimSnapshot(characterID);
  return require("../career/careerCatalog").list().every(row => !done(row.id)
    || [...new Set(row.rewards.map(reward => reward.label))].every(label => claims.getClaim(characterID, row.id, label, snapshot)?.state === "completed"));
}
function register(graphs) {
  graphs.registerAtom(4, 290, async ({ root, session, parameters }) => {
    if (root.ownerKey !== "air" || root.graphID !== 715 || root.activeTask !== "2.5.03_handoff"
        || resolveSessionCharacterID(session) !== root.characterID || Number(parameters.character_id) !== root.characterID)
      throw require("../nodegraph/nodeGraphCompiler").graphError("AIR_COMPLETION_GRAPH_FORBIDDEN");
    const state = characters.getCharacterRecord(root.characterID).authoredAirTutorial;
    const result = await require("./tutorialRuntime").markCharacterTutorialCompleted(root.characterID, { rootID: root.instanceID, runID: state.runID });
    if (!result.success) throw require("../nodegraph/nodeGraphCompiler").graphError("AIR_COMPLETION_FLUSH_FAILED", result.errorMsg);
    // Career projection is recoverable from the committed receipt. A notice or
    // projection failure must not undo an already completed tutorial.
    try {
      const progress = require("../career/careerProgress").sync(root.characterID);
      if (!progress.success) require("../../utils/logger").warn(`[Career] completion projection failed: ${progress.errorMsg}`);
    } catch (error) { require("../../utils/logger").warn(`[Career] completion projection failed: ${error.message}`); }
    if (!result.duplicate && !session.socket?.destroyed)
      session.sendNotification("OnAirNpeStateChanged", "charid", [root.characterID, 2]);
    return {};
  }, ({ graphID, ownerKey }) => ownerKey === "air" && graphID === 715);
}
module.exports = { careerStations, atCareerStation, acpRewardReminderDone, ACP_REWARD_REMINDER_GOAL_IDS, register };
