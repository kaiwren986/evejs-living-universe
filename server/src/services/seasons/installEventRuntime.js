"use strict";

function install() {
  const trail = require("./campaignTrailRuntime");
  const missions = require("./gallenteMissionRuntime");
  require("./eventHooks").install({
    recovery: { async recoverPending() {
      // Homefront recovers its own pending payouts when the site service starts.
      require("../faction/fwOpenRewards").recoverPending();
    } },
    trail,
    missions: {
      stageCompletion: missions.stageCompletion,
      reconcileCharacter(session) {
        missions.reconcileProgress(session, trail.getProgress(trail.getCharacterID(session)));
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
