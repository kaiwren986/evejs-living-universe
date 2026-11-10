"use strict";

const baseline = require("./securityMissionRewardBaseline.json");
const fields = ["isk", "bonusISK", "baseLP", "bonusMinutes"];

function getLevel(level) { return baseline.levels[level] || null; }
function getMission(mission, level) {
  const row = baseline.missionsByID[mission?.missionID];
  return row && row.level === level && row.dungeonID === mission.killMission?.dungeonID ? row : null;
}
function selectFallbacks(binding, mission, level) {
  const observed = getMission(mission, level);
  const defaults = getLevel(level);
  const result = {};
  for (const field of fields) {
    const evidence = binding?.baselineEvidence?.find((row) => row.fieldPath === `/securityMission/rewards/${field}`)?.evidenceClass;
    if (["estimated", "TQ_log_projection"].includes(evidence) || observed && evidence === "wiki_display_used_as_provisional_base") {
      const value = observed?.[field] ?? defaults?.[field];
      if (Number.isFinite(value)) result[field] = value;
    }
  }
  return result;
}
module.exports = { getLevel, getMission, selectFallbacks };
