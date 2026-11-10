"use strict";

const baseline = require("./securityMissionDeclineBaseline.json");
const offers = require("./securityMissionOfferEvidence");
const measured = require("./securityMissionDeclineMeasured.json");

function project(coefficients, baseLP) {
  return Object.fromEntries(["agentRaw", "corpRaw"].map((field) =>
    [field, Math.max(-1, Math.min(1, coefficients[field] * Math.max(0, baseLP)))]));
}

// A decline seen in a TQ packet outranks the projection, even with no full study.
function getMeasured(agent, mission) {
  const entry = measured.agentsByID[agent?.agentID];
  const row = entry && offers.matchesAgentContext(entry, agent) ? entry.missionsByID[mission?.missionID] : null;
  return row && row.dungeonID === mission.killMission?.dungeonID && row.titleID === mission.nameID ? row : null;
}

function getDeclined(agent, mission, baseLP) {
  const profile = offers.getProfile(agent);
  const captured = profile && offers.getMissionObservation(agent, mission) && baseline.declineProfilesByAgentID[agent.agentID];
  const row = captured?.captureID === profile?.captureID ? captured?.missionsByID[mission.missionID] : null;
  const exact = row && row.dungeonID === mission.killMission?.dungeonID && row.titleID === mission.nameID;
  const derived = exact && captured.derivedPatternsByID?.[row.derivedPatternID]?.changes ||
    baseline.declineDerivedByCorporationID?.[agent.corporationID]?.patterns[0]?.changes ||
    baseline.declineDerivedByFactionID?.[agent.factionID]?.patterns[0]?.changes;
  const coefficients = baseline.declineCoefficientsByCorporationID?.[agent.corporationID] ||
    baseline.declineCoefficientsByFactionID?.[agent.factionID] || baseline.declineCoefficientsPerBaseLP;
  const source = exact ? row : getMeasured(agent, mission);
  return { ...(source ? { agentRaw: source.agentRaw, corpRaw: source.corpRaw } : project(coefficients, baseLP)),
    ...(derived ? { eventExtras: { notificationMin: -1, notificationMax: 1, notificationGroup: "direct",
      derivedStandings: derived.map((change) => ({ ...change, applySocial: false, notificationGroup: "derived" })) } } : {}),
  };
}

module.exports = { getDeclined };
