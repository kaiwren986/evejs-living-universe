"use strict";
const campaign = require("./campaignTrailCatalog");
const TIERS = Object.freeze([
  ["Supporter",3,50,92391,10], ["Volunteer",4,75,92391,15],
  ["Contributor",5,100,92391,20], ["Benefactor",6,125,92391,30],
  ["Lobbyist",7,150,92392,1], ["Repeatable",3,40,null,0],
].map(([name,count,points,typeID,quantity],index) => Object.freeze({
  name: `Exploration - ${name}${index < 5 ? ` Tier (${index + 1}/5)` : ""}`,
  count,points,typeID,quantity,nameID:1900160000+index*3,textID:1900160001+index*3,progressID:1900160002+index*3,
})));
function getActiveStep(state) {
  if (!campaign.getCandidate(state) || state.points >= campaign.MAX_POINTS) return null;
  const index = state.exploration?.claims || 0;
  return { ...TIERS[Math.min(index,5)], index, challengeID: 94000000+index };
}
const MESSAGES = Object.fromEntries(TIERS.flatMap(tier => [
  [tier.nameID,tier.name], [tier.progressID,tier.name],
  [tier.textID,`Hack ${tier.count} Iteration Databanks or Vaults in Drone Iteration Depots. Earn ${tier.points} points${tier.typeID ? ` and ${tier.quantity} ${tier.typeID === 92391 ? "Political Favors" : "Presidential Candidate Favor"}` : ""}. Scan down a Depot and use a Data Analyzer. Successful hacks count once; looting is separate.`],
]));
module.exports = { TIERS, MESSAGES, getActiveStep };
