"use strict";
const campaign = require("./campaignTrailCatalog");
// Existing recovered tiers are preserved. Later tiers and repeats are authored
// replay extensions; see doc/election/CHALLENGE_TIER_POLICY.md.
const TIERS = Object.freeze([
  ["Supporter", 2, 50, 92391, 10],
  ["Volunteer", 2, 75, 92391, 15],
  ["Contributor", 3, 100, 92391, 20],
  ["Benefactor", 4, 125, 92391, 30],
  ["Lobbyist", 5, 150, 92392, 1],
  ["Repeatable", 2, 40, null, 0],
].map(([name, count, points, typeID, quantity], index) => Object.freeze({
  name: `Gallente Factional Warfare - ${name}${index < 5 ? ` Tier (${index + 1}/5)` : ""}`,
  count, points, typeID, quantity, evidence: index < 3 ? "documented" : "authored",
  nameID: 1900180000 + index * 3, textID: 1900180000 + 1 + index * 3,
  progressID: 1900180000 + 2 + index * 3,
})));
function getActiveStep(state) {
  if (!campaign.getCandidate(state) || state.points >= campaign.MAX_POINTS) return null;
  const index = state.fw?.claims || 0;
  return { ...TIERS[Math.min(index, 5)], index, challengeID: 96000000 + index };
}
const MESSAGES = Object.fromEntries(TIERS.flatMap(tier => [
  [tier.nameID, tier.name], [tier.progressID, tier.name],
  [tier.textID, `Capture or defend ${tier.count} Factional Warfare complexes for Gallente. Earn ${tier.points} points${tier.typeID ? ` and ${tier.quantity} ${tier.typeID === 92391 ? "Political Favors" : "Presidential Candidate Favor"}` : ""}. Enlist with Gallente and remain within 30 km of the capture point at completion. Replay Open Complexes are in Fliet and Heydieles.`],
]));
module.exports = { TIERS, MESSAGES, getActiveStep };
