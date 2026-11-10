"use strict";
const campaign = require("./campaignTrailCatalog");
const TIERS = Object.freeze([
  ["Supporter", 3, 50, 92391, 10], ["Volunteer", 4, 75, 92391, 15],
  ["Contributor", 5, 100, 92391, 20], ["Benefactor", 6, 125, 92391, 30],
  ["Lobbyist", 7, 150, 92392, 1], ["Repeatable", 3, 40, null, 0],
].map(([name, count, points, typeID, quantity], index) => Object.freeze({
  name: `Gallente Security Missions - ${name}${index < 5 ? ` Tier (${index + 1}/5)` : ""}`,
  count, points, typeID, quantity, nameID: 1900150000 + index * 3,
  textID: 1900150001 + index * 3, progressID: 1900150002 + index * 3,
})));
function getActiveStep(state) {
  if (!campaign.getCandidate(state) || state.points >= campaign.MAX_POINTS) return null;
  const index = state.missions?.claims || 0;
  return { ...TIERS[Math.min(index, 5)], index, challengeID: 93000000 + index };
}
// Replay eligibility: ordinary Gallente security agent, combat assignment,
// mission owner only. Career/storyline/FW and GM-completed fixtures are excluded.
function isEligible(agent, mission) {
  return Number(agent?.factionID) === 500004 && Number(agent?.agentTypeID) === 2 &&
    require("../agent/missionAuthority").isOrdinarySecurityAgent(agent) &&
    mission?.missionKind === "encounter" && !mission.importantMission &&
    !mission.gmCompleted && !mission.placeholder;
}
const MESSAGES = Object.fromEntries(TIERS.flatMap(tier => [
  [tier.nameID, tier.name], [tier.progressID, tier.name],
  [tier.textID, `Complete ${tier.count} Gallente Security Missions. Earn ${tier.points} points${tier.typeID ? ` and ${tier.quantity} ${tier.typeID === 92391 ? "Political Favors" : "Presidential Candidate Favor"}` : ""}. Turn in combat assignments to ordinary Gallente security agents. Only the mission owner receives credit.`],
]));
module.exports = { TIERS, MESSAGES, getActiveStep, isEligible };
