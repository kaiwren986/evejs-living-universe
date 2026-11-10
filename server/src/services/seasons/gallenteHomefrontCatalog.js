"use strict";
const campaign = require("./campaignTrailCatalog");
// Existing recovered tiers are preserved. Later tiers and repeats are authored
// replay extensions; see doc/election/CHALLENGE_TIER_POLICY.md.
const TIERS = Object.freeze([
  ["Supporter", 4, 50, 92391, 10],
  ["Volunteer", 5, 75, 92391, 15],
  ["Contributor", 6, 100, 92391, 20],
  ["Benefactor", 7, 125, 92391, 30],
  ["Lobbyist", 8, 150, 92392, 1],
  ["Repeatable", 4, 40, null, 0],
].map(([name, count, points, typeID, quantity], index) => Object.freeze({
  name: `Gallente Homefront - ${name}${index < 5 ? ` Tier (${index + 1}/5)` : ""}`,
  count, points, typeID, quantity, evidence: index < 1 ? "documented" : "authored",
  nameID: 1900190000 + index * 3, textID: 1900190000 + 1 + index * 3,
  progressID: 1900190000 + 2 + index * 3,
})));
function getActiveStep(state) {
  if (!campaign.getCandidate(state) || state.points >= campaign.MAX_POINTS) return null;
  const index = state.homefront?.claims || 0;
  return { ...TIERS[Math.min(index, 5)], index, challengeID: 97000000 + index };
}
const MESSAGES = Object.fromEntries(TIERS.flatMap(tier => [
  [tier.nameID, tier.name], [tier.progressID, tier.name],
  [tier.textID, `Complete ${tier.count} Homefront Operations in Gallente space. Earn ${tier.points} points${tier.typeID ? ` and ${tier.quantity} ${tier.typeID === 92391 ? "Political Favors" : "Presidential Candidate Favor"}` : ""}. Find operations throughout high-security empire space. Qualify for the operation's completion payout in Gallente space, then claim this challenge's rewards.`],
]));
let availabilityDescriptors = null;
let available = false;
function isAvailable() {
  try { require.resolve("../homefront/homefrontRuntime"); }
  catch (error) { if (error.code === "MODULE_NOT_FOUND") return false; throw error; }
  const authority = require("../dungeon/dungeonAuthority");
  const descriptors = authority.listTemplateSelectionDescriptorsByFamily("combat");
  if (availabilityDescriptors !== descriptors) {
    available = descriptors.filter(row => row.templateID?.startsWith("evejs-homefront:"))
      .some(row => {
        const feature = authority.getTemplateByID(row.templateID)?.populationHints?.homefront;
        return feature && (feature.empire === "Gallente" || feature.universal);
      });
    availabilityDescriptors = descriptors;
  }
  return available;
}
module.exports = { TIERS, MESSAGES, getActiveStep, isAvailable };
