"use strict";

const baseline = require("./securityMissionStandingBaseline.json");
const corporationStanding = require("./securityMissionCorporationStanding.json");
const measured = require("./securityMissionStandingMeasured.json");

function project(coefficients, baseLP) {
  return Object.fromEntries(["agentRaw", "corpRaw"].map((field) =>
    [field, Math.max(-1, Math.min(1, coefficients[field] * Math.max(0, baseLP)))]));
}

// The baseline's corporation gain came from one corporation at one level. Size and
// agent level decide it elsewhere; with no known size, the baseline value stands.
function corporationRaw(agentRaw, level, corporationID) {
  const sizeFactor = corporationStanding.sizeFactorByCorporationID[corporationID];
  if (!(sizeFactor > 0)) return null;
  const share = corporationStanding.shareByAgentLevel[level] ?? corporationStanding.projectedShareForHigherLevels;
  return agentRaw * share / sizeFactor;
}

// A direct TQ packet outranks a screenshot-derived value.
function getMeasuredAgentRaw(mission, level) {
  const row = measured.dungeonsByID[mission?.killMission?.dungeonID];
  return row?.level === level ? row.agentRaw : undefined;
}

function getCompleted(mission, level, baseLP, corporationID) {
  const dungeon = baseline.completedByDungeonID[mission?.killMission?.dungeonID];
  const calibrated = dungeon?.level === level ? { agentRaw: dungeon.agentRaw, corpRaw: dungeon.corpRaw }
    : project(baseline.completionCoefficientsPerBaseLP, baseLP);
  const gains = { ...calibrated, agentRaw: getMeasuredAgentRaw(mission, level) ?? calibrated.agentRaw };
  const corpRaw = corporationRaw(gains.agentRaw, level, corporationID);
  return corpRaw === null ? gains : { ...gains, corpRaw };
}

module.exports = { getCompleted };
