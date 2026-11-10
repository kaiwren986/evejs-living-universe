"use strict";

// Observed reward presentations already include the captured character's skills.
// The caller must apply these after its skill calculation, for this source only.
const DATA = require("./careerRetailMissionData.json");
const clone = value => JSON.parse(JSON.stringify(value));

function resolveCapturedRewardPresentation(contentID, agentRecord) {
  if (Number(agentRecord?.agentTypeID) !== 12) return null;
  const record = DATA.contracts.find(entry => Number(entry.missionID) === Number(contentID) &&
    entry.sourceAgentID === Number(agentRecord.agentID) && entry.sourceSolarSystemID === Number(agentRecord.solarSystemID));
  return record?.rewardPresentation ? clone(record.rewardPresentation) : null;
}

function resolveCapturedInitialBlueprintGift(contentID, agentRecord, typeID, licensedRuns) {
  if (Number(agentRecord?.agentTypeID) !== 12) return null;
  const record = DATA.contracts.find(entry => Number(entry.missionID) === Number(contentID) &&
    entry.sourceAgentID === Number(agentRecord.agentID) && entry.sourceSolarSystemID === Number(agentRecord.solarSystemID));
  const gift = record?.initialBlueprintGift;
  // A capture must agree with the mission's own gift before it can add instance
  // attributes. Never substitute another mission's gift or generalize an agent.
  return gift && gift.typeID === Number(typeID) && gift.quantity === 1 &&
    gift.blueprintInfo.licensedProductionRunsRemaining === Number(licensedRuns) ? clone(gift) : null;
}

function applyToMissionAuthorityPayload(payload) {
  if (!payload?.missionsByID) return payload;
  const byMission = new Map();
  for (const entry of DATA.contracts.filter(record => record.cargoObjective)) {
    const list = byMission.get(String(entry.missionID)) || [];
    list.push(entry.cargoObjective);
    byMission.set(String(entry.missionID), list);
  }
  for (const [missionID, objectives] of byMission) {
    if (new Set(objectives.map(JSON.stringify)).size !== 1) continue;
    const mission = payload.missionsByID[missionID];
    if (!mission) continue;
    const target = mission.killMission || mission.courierMission;
    if (!target) continue;
    target.objectiveTypeID = objectives[0].typeID;
    target.objectiveQuantity = objectives[0].quantity;
  }
  return payload;
}

function filterCapturedRewardPresentation(contentID, agentRecord, presentation) {
  if (!presentation) return null;
  const key = `${Number(contentID)}:${Number(agentRecord?.agentID)}:${Number(agentRecord?.solarSystemID)}`;
  const result = clone(presentation);
  for (const conflict of DATA.conflicts) {
    if (conflict.key === key && String(conflict.field).startsWith("rewardPresentation.")) {
      delete result[conflict.field.split(".")[1]];
    }
  }
  return Object.keys(result).length ? result : null;
}

module.exports = { resolveCapturedRewardPresentation, resolveCapturedInitialBlueprintGift, applyToMissionAuthorityPayload, filterCapturedRewardPresentation };
