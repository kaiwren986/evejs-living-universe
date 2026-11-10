"use strict";

// Accepted native challenges and bilateral combat permission share a durable
// outbox. Progress can be retried after restart without accepting a new duel.
const state = require("./crimewatchRuntimeState");
const log = require("../../utils/logger");

function recoverPendingDuelAchievements() {
  for (const receipt of state.listPendingDuelAchievements()) {
    try {
      const achievements = require("../achievement/achievementRuntime");
      for (const characterID of [receipt.firstCharacterID, receipt.secondCharacterID]) {
        const result = achievements.recordDuelParticipation(characterID, receipt.receiptID);
        if (!result?.success) throw new Error(result?.errorMsg || "WRITE_ERROR");
      }
      const acknowledged = state.acknowledgeDuelAchievement(receipt.receiptID);
      if (!acknowledged?.success) throw new Error(acknowledged?.errorMsg || "WRITE_ERROR");
    } catch (error) {
      log.warn(`[Duel] Achievement receipt ${receipt.receiptID} remains pending: ${error.message}`);
    }
  }
}

module.exports = { recoverPendingDuelAchievements };
