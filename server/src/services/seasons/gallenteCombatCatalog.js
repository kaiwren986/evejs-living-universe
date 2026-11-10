"use strict";
const campaign = require("./campaignTrailCatalog");
const TIERS = Object.freeze([
  ["Supporter",40,50,92391,10], ["Volunteer",60,75,92391,15],
  ["Contributor",80,100,92391,20], ["Benefactor",100,125,92391,30],
  ["Lobbyist",120,150,92392,1], ["Repeatable",50,40,null,0],
].map(([name,count,points,typeID,quantity],index) => Object.freeze({
  name: `Rampant Drone Fabricator - ${name}${index < 5 ? ` Tier (${index + 1}/5)` : ""}`,
  count,points,typeID,quantity,nameID:1900170000+index*3,textID:1900170001+index*3,progressID:1900170002+index*3,
})));
function getActiveStep(state) {
  if (!campaign.getCandidate(state) || state.points >= campaign.MAX_POINTS) return null;
  const index = state.combat?.claims || 0;
  return { ...TIERS[Math.min(index,5)], index, challengeID: 95000000+index };
}
const MESSAGES = Object.fromEntries(TIERS.flatMap(tier => [
  [tier.nameID,tier.name], [tier.progressID,tier.name],
  [tier.textID,`Kill ${tier.count} Fabricator Rogue Drones in Rampant Drone Fabricator sites. Earn ${tier.points} points${tier.typeID ? ` and ${tier.quantity} ${tier.typeID === 92391 ? "Political Favors" : "Presidential Candidate Favor"}` : ""}. Find sites in lowsec, Pochven and C1-C6 wormholes. Drone and fighter kills count for their owner. Cash-out is separate.`],
]));
module.exports = { TIERS, MESSAGES, getActiveStep };
