"use strict";

const observations = require("./securityMissionOfferObservations.json");
const exceptions = require("./securityMissionOfferExceptions.json");

const CONTEXT_KEYS = ["agentID", "agentTypeID", "level", "missionKind", "corporationID", "factionID", "stationID", "solarSystemID"];

function matchesAgentContext(row, agent) {
  return CONTEXT_KEYS.every((key) => row[key] === agent[key]);
}

// Offer evidence belongs to this exact agent/location. Moving an agent must not
// silently extrapolate an observed pool into a different context.
function getProfile(agent, catalog = observations) {
  const profile = catalog.profilesByAgentID?.[agent?.agentID];
  return profile && matchesAgentContext(profile, agent) ? profile : null;
}

// A single offer seen from an agent with no decline study. It adds one mission;
// only a profile may stand in for an agent's whole pool.
function getOfferException(agent, mission, catalog = exceptions) {
  const entry = catalog.agentsByID?.[agent?.agentID];
  return entry && matchesAgentContext(entry, agent) ? entry.missionsByID?.[mission?.missionID] : null;
}

function getMissionObservation(agent, mission, catalog = observations) {
  const profile = getProfile(agent, catalog);
  const row = profile?.missionsByID?.[mission?.missionID] || getOfferException(agent, mission);
  return row && row.titleID === mission.nameID && row.dungeonID === mission.killMission?.dungeonID &&
    mission.contentTemplate === "agent.missionTemplatizedContent_BasicKillMission" ? row : null;
}

module.exports = { getProfile, getMissionObservation, matchesAgentContext };
