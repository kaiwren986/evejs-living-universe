"use strict";

const campaign = require("./campaignTrailCatalog");
const TIERS = Object.freeze([
  ["Supporter Tier (1/5)", 2, 25], ["Volunteer Tier (2/5)", 4, 35],
  ["Contributor Tier (3/5)", 6, 50], ["Benefactor Tier (4/5)", 8, 65],
  ["Lobbyist Tier (5/5)", 10, 105], ["Repeatable", 4, 50],
].map(([name, count, points], index) => Object.freeze({
  name: `Trading - ${name}`, count, points, typeID: index === 4 ? 92392 : null,
  quantity: index === 4 ? 1 : 0, nameID: 1900140000 + index * 3,
  textID: 1900140001 + index * 3, progressID: 1900140002 + index * 3,
})));

function getActiveStep(state) {
  if (!campaign.getCandidate(state) || state.points >= campaign.MAX_POINTS) return null;
  const index = state.trading?.claims || 0;
  return { ...TIERS[Math.min(index, 5)], index, challengeID: 92000000 + index };
}

const MESSAGES = Object.fromEntries(TIERS.flatMap(tier => [
  [tier.nameID, tier.name], [tier.progressID, tier.name],
  [tier.textID, `Receive ${tier.count} items from a Capsuleer Outreach Center in a campaign HQ located in Dodixie. Earn ${tier.points} points${tier.typeID ? " and 1 Presidential Candidate Favor" : ""}. Carry favors in your ship's cargo and approach a center within 2,500 m to trade.`],
]));

module.exports = { TIERS, MESSAGES, getActiveStep };
