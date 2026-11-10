"use strict";
const database = require("../../gameStore");
function observe(characterID, record, definition, context = {}) {
  const minimum = definition.source?.minimum;
  if (![0.1, 0.25, 0.5, 1].includes(minimum)) return null;
  if (!context.careerStandingCharacter) {
    const result = database.readPersisted("characters", `/${characterID}`);
    if (!result?.success) throw new Error(result?.errorMsg || "CAREER_STANDING_SOURCE_UNAVAILABLE");
    context.careerStandingCharacter = result.data || {};
  }
  const character = context.careerStandingCharacter;
  const corps = require("../corporation/corporationState");
  const receipts = Object.entries(character.standingOperationReceipts || {}).filter(([key, receipt]) =>
    key.startsWith(`mission-reward:${characterID}:`) && key.endsWith(":standing") &&
    receipt && Array.isArray(receipt.result?.appliedChanges)).map(([, receipt]) => receipt);
  let completed = false, updatedAtMs = 0;
  for (const receipt of receipts) {
    for (const change of receipt.result.appliedChanges) {
      if (Number(change.toID) !== Number(characterID) || !(Number(change.rawChange) > 0) ||
          !Number.isFinite(Number(change.standing)) || Number(change.standing) < minimum) continue;
      const corp = corps.getCorporationRecord(Number(change.fromID));
      if (!corp || corp.isNPC !== true) continue;
      // Historical mission receipts retain earned thresholds even if the
      // character later loses that standing. GM/contact sets cannot qualify.
      completed = true;
      updatedAtMs = Math.max(updatedAtMs, Date.parse(receipt.createdAt) || 0);
    }
  }
  return { kind: "corporation-standing", id: `corporation-standing:${minimum}:v1`, progress: completed ? 1 : 0, updatedAtMs };
}
function supports(source) { return source?.kind === "corporation-standing" && [0.1, 0.25, 0.5, 1].includes(source.minimum); }
module.exports = { observe, supports };
