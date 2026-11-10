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
module.exports = { careerStations, atCareerStation, register };
