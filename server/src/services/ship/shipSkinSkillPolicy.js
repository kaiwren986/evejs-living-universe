"use strict";
const { getCharacterSkillMap } = require("../skills/skillState");
const { getCumulativeSkillPolicyValue } = require("./shipSkinSequencingAuthority");
function getCharacterShipSkinLimits(characterID) {
  const skills = getCharacterSkillMap(characterID);
  const level = id => skills.get(id)?.effectiveSkillLevel || 0;
  return Object.fromEntries(["maxRuns", "maxConcurrentJobs", "durationBonusPercent", "maxConcurrentListings", "taxReductionPercent"]
    .map(name => [name, getCumulativeSkillPolicyValue(name, level)]));
}
module.exports = { getCharacterShipSkinLimits };
