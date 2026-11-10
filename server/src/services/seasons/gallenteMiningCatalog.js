"use strict";

const campaign = require("./campaignTrailCatalog");

// Local SDE: base, II-, III-, IV- and (Scordite only) 0-Grade ores.
// Group IDs also contain mission ores and legacy batch-compressed types, so
// group membership alone is not sufficient to qualify harvested ore.
const ORE_TYPE_IDS = Object.freeze([1228, 17463, 17464, 46687, 92373,
  1229, 17865, 17866, 46679]);

// Per-tier targets supplied for the Gallente election replay. Volumes reset
// after each claim; excess yield does not pre-complete a locked tier.
const TIERS = Object.freeze([
  ["Supporter Tier (1/5)", 30000, 50, 92391, 10],
  ["Volunteer Tier (2/5)", 45000, 75, 92391, 15],
  ["Contributor Tier (3/5)", 60000, 100, 92391, 20],
  ["Benefactor Tier (4/5)", 75000, 125, 92391, 30],
  ["Lobbyist Tier (5/5)", 90000, 150, 92392, 1],
  ["Repeatable", 50000, 30, null, 0],
].map(([name, volume, points, typeID, quantity], index) => Object.freeze({
  name: `Gallente Mining - ${name}`, volume, points, typeID, quantity,
  nameID: 1900130000 + index * 3, textID: 1900130001 + index * 3,
  progressID: 1900130002 + index * 3,
})));

function getActiveStep(state) {
  if (!campaign.getCandidate(state) || state.points >= campaign.MAX_POINTS) return null;
  const index = state.mining?.claims || 0;
  return { ...TIERS[Math.min(index, 5)], index, challengeID: 91000000 + index };
}

const MESSAGES = Object.fromEntries(TIERS.flatMap((tier) => [
  [tier.nameID, tier.name],
  [tier.textID, `Mine ${tier.volume.toLocaleString("en-US")} m³ Scordite or Gneiss in Gallente space. Earn ${tier.points} points${tier.typeID ? ` and ${tier.quantity} ${tier.typeID === 92391 ? "Political Favors" : "Presidential Candidate Favor"}` : ""}.`],
  [tier.progressID, `${tier.name} (m³)`],
]));

module.exports = { TIERS, MESSAGES, ORE_TYPE_IDS, getActiveStep };
