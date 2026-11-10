"use strict";

const store = require("./incursionRewardStore");

// The native journal discovers LP pool IDs through the global reward report.
// These rows expose controlled Phase7 pools only; they do not activate system
// effects, chat, map-system occupancy or a natural incursion lifecycle.
function listControlledRewardReports() {
  const pools = new Map();
  for (const operation of Object.values(store.read("/operations") || {})) {
    if (operation.policy?.schema !== "evejs.incursion-vanguard-policy.v1" ||
        !["active", "completed"].includes(operation.status)) continue;
    const identity = operation.identity;
    if (!identity) continue;
    if (identity.placement === "tale-slot") continue;
    const release = store.read(`/releases/${identity.poolGroupID}:${identity.taleID}`);
    if (release && Object.values(release.participants).every(participant => participant.historyPublished)) continue;
    const row = { taleID: identity.taleID, templateClassID: 2, templateNameID: 114106,
      stagingSolarSystemID: identity.solarSystemID, aggressorFactionID: 500019,
      state: 2, influence: 0, hasFinalEncounter: false, effects: [],
      rewardGroupID: identity.poolGroupID, incursedSystems: [], systems: [],
      severity: 4, hasChat: false, chatAnnouncementMessageId: 0, musicState: null };
    const prior = pools.get(identity.poolGroupID);
    if (prior && (prior.taleID !== row.taleID || prior.stagingSolarSystemID !== row.stagingSolarSystemID)) {
      throw new Error("INCURSION_POOL_REPORT_SCOPE_MISMATCH");
    }
    pools.set(identity.poolGroupID, row);
  }
  return [...pools.values()].sort((a, b) => a.rewardGroupID - b.rewardGroupID);
}

module.exports = { listControlledRewardReports };
