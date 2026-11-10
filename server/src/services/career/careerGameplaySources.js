"use strict";

// Read facts from their existing durable owners. In particular, client supplied
// legacy achievement counters are not evidence for a career reward.
const authority = require("../achievement/achievementAuthority");

function count(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}
function idsFor(source) {
  return Array.isArray(source?.achievementIDs) ? source.achievementIDs : [source?.achievementID];
}
function isSupportedAchievementSource(source) {
  const ids = idsFor(source);
  return source?.kind === "achievement" && ids.length > 0 && ids.length <= 16 &&
    new Set(ids).size === ids.length && ids.every(id => typeof id === "string" &&
      authority.normalizeUUID(id) === id && authority.getAchievementById(id)) &&
    ["progress", "unique"].includes(source.metric) &&
    (source.metric === "unique" ? typeof source.valueType === "string" &&
      /^[a-z][a-z0-9_]{0,63}$/.test(source.valueType) : source.valueType === undefined);
}
function unique(values) {
  return new Set((Array.isArray(values) ? values : []).filter(value => typeof value === "string" && value.length > 0));
}
function achievementProgress(definition, state) {
  const method = authority.getContributionMethodById(definition.contribution?.method_id);
  const mode = method?.progress?.progress_type;
  return ["SET", "CHECKLIST"].includes(mode)
    ? unique(state.checklistValuesByType?.[method.progress.target_parameter]).size
    : count(state.progressValue);
}
function createContext(characterID) {
  let nativeState;
  return { getNativeState() { return nativeState ||= require("../achievement/achievementState").getCharacterState(characterID); } };
}
function tutorialSource(characterID, record) {
  const state = record?.authoredAirTutorial, completion = state?.completion;
  if (record?.airNpeState !== 2 || !completion ||
      state.characterID !== undefined && Number(state.characterID) !== characterID ||
      typeof completion.rootID !== "string" || !completion.rootID || completion.rootID.length > 128 ||
      typeof completion.runID !== "string" || !completion.runID || completion.runID.length > 128 ||
      completion.runID !== state.runID) return null;
  return { kind: "tutorial-completed", id: `${characterID}:${completion.runID}:${completion.rootID}`,
    progress: 1, updatedAtMs: count(completion.completedAtMs) };
}
function observe(characterID, record, definition, context = createContext(characterID)) {
  const source = definition.source;
  if (source?.kind === "tutorial-completed") return tutorialSource(characterID, record);
  if (source?.kind !== "achievement") return null;
  if (!isSupportedAchievementSource(source)) return null;
  const ids = idsFor(source).slice().sort(), state = context.getNativeState();
  let progress = 0, updatedAtMs = 0;
  const values = new Set();
  for (const id of ids) {
    const native = state?.achievementsById?.[id];
    if (!native) continue;
    if (source.metric === "progress") progress += achievementProgress(authority.getAchievementById(id), native);
    else for (const value of unique([
      ...(native.hiddenUniqueValuesByType?.[source.valueType] || []),
      ...(native.checklistValuesByType?.[source.valueType] || []),
    ])) values.add(value);
    updatedAtMs = Math.max(updatedAtMs, count(native.updatedAtMs));
  }
  if (source.metric === "unique") progress = values.size;
  if (!Number.isSafeInteger(progress) || progress <= 0) return null;
  return { kind: source.kind,
    id: `${characterID}:achievement:${ids.join(",")}:${source.metric}:${source.valueType || ""}`,
    progress, updatedAtMs };
}
function careerPoints(characterID, definition, definitions, goals) {
  const career = definition.source?.career;
  if (!Number.isInteger(career) || career < 0 || career > 4) return null;
  let progress = 0, updatedAtMs = 0;
  for (const activity of definitions) {
    if (activity.source?.kind === "career-points" || career !== 0 && activity.career !== career) continue;
    const completed = goals[activity.id];
    if (!completed || completed.goalID !== activity.id || completed.progress < activity.target ||
        !completed.completedAtMs || completed.source?.kind !== activity.source?.kind) continue;
    progress += count(activity.points);
    updatedAtMs = Math.max(updatedAtMs, count(completed.completedAtMs));
  }
  return progress > 0 && Number.isSafeInteger(progress)
    ? { kind: "career-points", id: `${characterID}:career-points:${career}`, progress, updatedAtMs } : null;
}

module.exports = { observe, careerPoints, createContext, isSupportedAchievementSource };
