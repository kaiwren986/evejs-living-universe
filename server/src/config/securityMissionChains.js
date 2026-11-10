"use strict";

const baseline = require("./securityMissionChains.json");

function getPart(mission, catalog = baseline) {
  const row = catalog.missionsByID?.[mission?.missionID];
  return row && row.nameID === mission.nameID && row.contentTemplate === mission.contentTemplate &&
    row.dungeonID === Number(mission.killMission?.dungeonID || 0) &&
    ["factionID", "corporationID", "agentTypeID"].every((field) => row[field] === Number(mission[field] || 0))
    ? row : null;
}

function getCandidateMissionIDs(part, agentLevel) {
  return [...(part?.nextByAgentLevel?.[agentLevel] || [])];
}

module.exports = { getPart, getCandidateMissionIDs };
