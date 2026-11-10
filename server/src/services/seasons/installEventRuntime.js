"use strict";

function install() {
  const trail = require("./campaignTrailRuntime");
  const missions = require("./gallenteMissionRuntime");
  const warpath = require("./warpathMissionRuntime");
  require("./eventHooks").install({
    recovery: { async recoverPending() {
      // Homefront recovers its own pending payouts when the site service starts.
      require("../faction/fwOpenRewards").recoverPending();
    } },
    trail,
    missions: {
      stageCompletion(characterState, characterID, agent, mission) {
        missions.stageCompletion(characterState, characterID, agent, mission);
        warpath.stageCompletion(characterState, agent, mission);
      },
      reconcileCharacter(session) {
        missions.reconcileProgress(session, trail.getProgress(trail.getCharacterID(session)));
        warpath.publishCompletion(session);
      },
    },
    depot: require("./gallenteDepotRuntime"),
    fabricator: require("./gallenteFabricatorRuntime"),
    fabricatorBonuses: require("./fabricatorBonuses"),
    fw: require("../faction/fwOpenRuntime"),
    fwRewards: require("../faction/fwOpenRewards"),
    outreach: require("./gallenteOutreachRuntime"),
  });
}

module.exports = { install };
