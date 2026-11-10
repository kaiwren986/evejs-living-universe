"use strict";

// Read facts from their existing durable owners. In particular, client supplied
// legacy achievement counters are not evidence for a career reward.
const authority = require("../achievement/achievementAuthority");
const { readDurablePath } = require("./careerOwnerReads");
const EPIC_ARC_ACHIEVEMENT = "8739d8d8-4e1e-5bca-b870-8f1357fa1dc7";

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
function durableEpicArcProgress(characterID, context) {
  const character = readDurablePath("missionRuntimeState", `/charactersByID/${characterID}`,
    context, "CAREER_EPIC_COMPLETION_UNAVAILABLE");
  if (Number(character?.characterID) !== Number(characterID)) return { progress: 0, updatedAtMs: 0 };
  let progress = 0, updatedAtMs = 0;
  for (const [key, completion] of Object.entries(character.epicArcProgress?.completedArcsByID || {})) {
    if (!Number.isSafeInteger(Number(key)) || Number(key) <= 0 || Number(completion?.epicArcID) !== Number(key) ||
        !Number.isSafeInteger(Number(completion.completedMissionID)) || Number(completion.completedMissionID) <= 0 ||
        !Number.isSafeInteger(Number(completion.agentID)) || Number(completion.agentID) <= 0 ||
        !Number.isSafeInteger(Number(completion.missionSequence)) || Number(completion.missionSequence) <= 0 ||
        typeof completion.completedAtFileTime !== "string" || !/^\d{1,20}$/.test(completion.completedAtFileTime)) continue;
    const completedAtMs = Number(BigInt(completion.completedAtFileTime) / 10000n - 11644473600000n);
    if (!Number.isSafeInteger(completedAtMs) || completedAtMs <= 0) continue;
    progress += 1;
    updatedAtMs = Math.max(updatedAtMs, completedAtMs);
  }
  return { progress, updatedAtMs };
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
  if (source.metric === "progress" && ids.length === 1 && ids[0] === EPIC_ARC_ACHIEVEMENT) {
    // The mission owner commits its terminal arc record before the achievement
    // hook runs. Recover that fact if the later projection was refused or lost.
    // Keep the achievement namespace so old progress and claims stay compatible.
    const durable = durableEpicArcProgress(characterID, context);
    progress = Math.max(progress, durable.progress);
    updatedAtMs = Math.max(updatedAtMs, durable.updatedAtMs);
  }
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
