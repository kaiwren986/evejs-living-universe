"use strict";

function inspect() {
  const campaign = require("./campaignTrailCatalog");
  const outreach = require("./gallenteOutreachCatalog");
  const { resolveItemByTypeID } = require("../inventory/itemTypeRegistry");
  const types = new Set([92391, 92392, ...campaign.CANDIDATES.map(row => row.busTypeID),
    ...campaign.REWARDS.map(row => row.typeID).filter(Boolean), ...outreach.CENTERS.map(row => row.typeID)]);
  for (const recipe of Object.values(require("./gallenteOutreachRecipes.json").recipes)) {
    for (const id of [...Object.keys(recipe.inputItems), ...Object.keys(recipe.outputItems)]) types.add(Number(id));
  }
  for (const day of require("../campaign/gallenteElectionLoginRewards.json").days) {
    types.add(day.alpha.typeID); types.add(day.omega.typeID);
  }
  const requiredTemplates = ["evejs-election:iteration-depot:highsec", "evejs-election:iteration-depot:vault",
    "evejs-election:fabricator:replay", "evejs-fw:open:gallente", "evejs-fw:open:caldari"];
  const authority = require("../dungeon/dungeonAuthority");
  const missingTypes = [...types].filter(id => !resolveItemByTypeID(id));
  const missingTemplates = requiredTemplates.filter(id => !authority.getTemplateByID(id));
  return { ready: !missingTypes.length && !missingTemplates.length, missingTypes, missingTemplates,
    profile: "development-replay", historicalParity: false,
    evidenceClientBuild: 3396210, dungeonEvidenceBuild: 3475087,
    optionalFeatures: { homefront: { installed: require("./gallenteHomefrontCatalog").isAvailable(), required: false } },
    manualChecks: ["Connected client build and presentation", "Fabricator edge cases", "FW multiplayer recovery", "Login rewards UI", "Homefront departure/replacement", "Backup/restore rehearsal"],
    authoredPolicy: ["Configurable bonus strengths", "Claimed-point election totals and shared ties", "Unclaimed reward retention"] };
}
module.exports = { inspect };
