"use strict";

// The bundled canonical export omits this arc; the actual supported build3396210
// client contains its native definitions. The bundled, capture-backed
// supplement fills absent native identities; a newer canonical export always
// keeps ownership of records it already supplies.
const DATA = require("./visionsOfGreatness.data.json");
const clone = value => JSON.parse(JSON.stringify(value));
const has = (object, key) => Object.prototype.hasOwnProperty.call(object || {}, key);

function copyIndexes(indexes = {}) {
  return Object.fromEntries(Object.entries(indexes).map(([name, index]) => [name, { ...index }]));
}

function addIndex(indexes, name, key, id) {
  if (key === undefined || key === null || key === "") return;
  const index = indexes[name] ||= {};
  index[key] = [...new Set([...(index[key] || []), Number(id)])].sort((a, b) => a - b);
}

function applyToAgentAuthorityPayload(payload = {}) {
  const result = { ...payload, agentsByID: { ...(payload.agentsByID || {}) }, indexes: copyIndexes(payload.indexes) };
  for (const [id, record] of Object.entries(DATA.agentsByID)) {
    if (has(result.agentsByID, id)) continue;
    result.agentsByID[id] = clone(record);
    for (const field of ["stationID", "corporationID", "factionID", "solarSystemID", "agentTypeID", "divisionID", "missionPoolKey"]) {
      addIndex(result.indexes, `${field}ToAgentIDs`, record[field], id);
    }
  }
  result.counts = { ...payload.counts, agentCount: Object.keys(result.agentsByID).length };
  return result;
}

function applyToMissionAuthorityPayload(payload = {}) {
  const result = {
    ...payload,
    missionsByID: { ...(payload.missionsByID || {}) },
    indexes: copyIndexes(payload.indexes),
  };
  for (const [id, record] of Object.entries(DATA.missionsByID)) {
    if (has(result.missionsByID, id)) continue;
    result.missionsByID[id] = clone(record);
    addIndex(result.indexes, "agentIDToMissionIDs", record.sourceAgentID, id);
    addIndex(result.indexes, "missionKindToMissionIDs", record.missionKind, id);
    addIndex(result.indexes, "missionFlavorToMissionIDs", record.missionFlavor, id);
    addIndex(result.indexes, "missionTemplateToMissionIDs", record.contentTemplate, id);
  }
  return result;
}

function isAgent(agentID) {
  return has(DATA.agentsByID, String(agentID));
}

function isMission(missionID) {
  return has(DATA.missionsByID, String(missionID));
}

function missionIDs() {
  return [...DATA.arc.missionIDs];
}

function resolveCapturedRewardPresentation(missionID, agentRecord) {
  const record = DATA.missionsByID[String(missionID)];
  const sourceAgent = DATA.agentsByID[String(record?.sourceAgentID)];
  if (!record?.capturedRewardPresentation || Number(agentRecord?.agentID) !== Number(record.sourceAgentID) ||
      Number(agentRecord?.solarSystemID) !== Number(sourceAgent?.solarSystemID)) return null;
  return clone(record.capturedRewardPresentation);
}

function fileTime(value) {
  try { return BigInt(value || 0); } catch { return 0n; }
}

function nextMissionID(characterState, agentID, nowFileTime) {
  if (!isAgent(agentID)) return null;
  const progress = characterState?.epicArcProgress || {};
  const arcID = String(DATA.arc.epicArcID);
  const lastCompletion = progress.completedArcsByID?.[arcID];
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

module.exports = {
  applyToAgentAuthorityPayload,
  applyToMissionAuthorityPayload,
  isAgent,
  isMission,
  missionIDs,
  resolveCapturedRewardPresentation,
  nextMissionID,
  canOfferMission,
};
