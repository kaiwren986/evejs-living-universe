"use strict";

// Fractured Legacy identities already exist in the native catalogs. This owner
// contributes only captured contracts and ordered admission, never replacement
// agent/mission records or unrelated epic-arc rewards.
const DATA = require("./fracturedLegacy.data.json");
const clone = value => JSON.parse(JSON.stringify(value));
const has = (object, key) => Object.prototype.hasOwnProperty.call(object || {}, key);

function isAgent(agentID) {
  return has(DATA.agentsByID, String(agentID));
}

function isMission(missionID) {
  return has(DATA.missionsByID, String(missionID));
}

function missionIDs() {
  return [...DATA.arc.missionIDs];
}

function getMissionContract(missionID) {
  const record = DATA.missionsByID[String(missionID)];
  return record ? clone(record) : null;
}

function resolveCapturedRewardPresentation(missionID, agentRecord) {
  const record = DATA.missionsByID[String(missionID)];
  if (!record?.capturedRewardPresentation || Number(agentRecord?.agentID) !== Number(record.sourceAgentID) ||
      Number(agentRecord?.solarSystemID) !== Number(record.sourceSolarSystemID)) return null;
  return clone(record.capturedRewardPresentation);
}

function getRewardBlueprintInfo(missionID, agentRecord, typeID) {
  const reward = resolveCapturedRewardPresentation(missionID, agentRecord)?.normalReward;
  return reward?.typeID === Number(typeID) && reward.blueprintInfo ? clone(reward.blueprintInfo) : null;
}

function resolveCapturedStandingPresentation(missionID, agentRecord) {
  const record = DATA.missionsByID[String(missionID)];
  const nativeAgent = DATA.agentsByID[String(record?.sourceAgentID)];
  if (!nativeAgent || ["corporationID", "factionID"].some(key => agentRecord?.[key] !== undefined &&
      Number(agentRecord[key]) !== Number(nativeAgent[key]))) return null;
  return resolveCapturedRewardPresentation(missionID, agentRecord) && record.capturedStandingPresentation
    ? clone(record.capturedStandingPresentation) : null;
}

function fileTime(value) {
  try { return BigInt(value || 0); } catch { return 0n; }
}

function nextMissionID(characterState, agentID, nowFileTime) {
  if (!isAgent(agentID)) return null;
  const progress = characterState?.epicArcProgress || {};
  const arcID = String(DATA.arc.epicArcID), lastCompletion = progress.completedArcsByID?.[arcID];
  const now = nowFileTime === undefined
    ? BigInt(Date.now()) * 10000n + 116444736000000000n : fileTime(nowFileTime);
  if (fileTime(lastCompletion?.replayUntilFileTime) > now) return null;
  const cycleBoundary = fileTime(lastCompletion?.completedAtFileTime);
  const statuses = progress.missionStatusByArcID?.[arcID] || {};
  const nextID = DATA.arc.missionIDs.find(id => fileTime(statuses[id]?.completedDate) <= cycleBoundary);
  return nextID && Number(DATA.missionsByID[nextID].sourceAgentID) === Number(agentID) ? nextID : null;
}

function canOfferMission(characterState, agentID, missionID, nowFileTime) {
  return isMission(missionID) && nextMissionID(characterState, agentID, nowFileTime) === Number(missionID);
}

module.exports = { isAgent, isMission, missionIDs, getMissionContract,
  resolveCapturedRewardPresentation, resolveCapturedStandingPresentation, getRewardBlueprintInfo, nextMissionID, canOfferMission };
