"use strict";

// Reviewed challenge types 3483–3488 from the matching binary loaders for
// builds 3396210 and 3475087. Instance IDs are assigned separately at runtime.
const EVENT_TYPE = "agentDungeonMissionCompleted";
const FACTIONS = new Set([500001, 500002, 500003, 500004]);
const TIERS = Object.freeze([
  [3483, 1042656, 5, 40, 93592, 30, 3484],
  [3484, 1042659, 7, 60, 93592, 50, 3485],
  [3485, 1042662, 10, 90, 93592, 70, 3486],
  [3486, 1042665, 15, 130, 93592, 100, 3487],
  [3487, 1042668, 20, 180, 44992, 10, 3488],
  [3488, 1042671, 6, 30, null, 0, 3488],
].map(([typeID, nameID, count, points, rewardTypeID, quantity, nextTypeID]) => Object.freeze({
  typeID, nameID, progressID: nameID + 1, textID: nameID + 2,
  count, points, rewardTypeID, quantity, nextTypeID,
  activeAtStart: typeID === 3483,
  once: typeID !== nextTypeID,
})));

function isEligible(agent, mission) {
  return FACTIONS.has(Number(agent?.factionID)) && Number(agent.agentTypeID) === 2 &&
    require("../agent/missionAuthority").isOrdinarySecurityAgent(agent) &&
    mission?.missionKind === "encounter" && Number(mission.dungeonInstanceID) > 0 &&
    !mission.importantMission && !mission.gmCompleted && !mission.placeholder;
}

module.exports = { EVENT_TYPE, TIERS, isEligible };
