"use strict";

// Career agents (agentTypeID 12, divisions 25-29, level 1) and their real mission chains.
//
// The agent authority has the career agents, and the mission authority has the career chains
// ("Cash Flow for Capsuleers (1 of 10)", ...) as storyline missions per faction, but nothing
// links the two: the agents handed out generic pool missions. careerAgentChains.json names
// each faction's chain per division (built from the mission names for this release):
//   - every career agent offers part 1 of its faction's chain for its division;
//   - the chains are golden mission chains (config/productionMissionPolicy.js), so completing
//     part N offers part N+1;
//   - the Exploration chain's "bring item" parts send the pilot to their private training
//     sites (on Tranquility those parts are site missions), and Industry part 1 is a mining
//     mission;
//   - the Agent Finder ticks a career agent only after the last part of its chain.
// The chains' sites are the content pack evejs.career-agents (tools/CareerAgents).

const path = require("path");

const DATA = require(path.join(__dirname, "careerAgentChains.json"));
const CAREER_AGENT_TYPE_ID = 12;

const chainByKey = new Map(DATA.chains.map((chain) => [`${chain.factionID}:${chain.divisionID}`, chain]));
const chainOf = (agentRecord) => (agentRecord && Number(agentRecord.agentTypeID) === CAREER_AGENT_TYPE_ID
  ? chainByKey.get(`${Number(agentRecord.factionID)}:${Number(agentRecord.divisionID)}`) || null
  : null);

// The chains as golden mission chains (name, missionIDs).
function listGoldenMissionChains() {
  return DATA.chains.map((chain) => ({ name: chain.name, missionIDs: [...chain.missionIDs] }));
}

// Applied to the mission authority's static payload before it is normalized.
function applyToMissionAuthorityPayload(payload, agentsByID, options = {}) {
  if (!payload || typeof payload !== "object") return payload;
  if (options.installed !== false) require("../../contentPacks/careerMissionContent").apply(payload, agentsByID);
  payload.indexes ||= {};
  const index = payload.indexes.agentIDToMissionIDs ||= {};
  for (const agent of Object.values(agentsByID || {})) {
    const chain = chainOf(agent);
    if (chain) index[String(agent.agentID)] = [chain.missionIDs[0]];
  }
  const missionsByID = payload.missionsByID || {};
  for (const chain of DATA.chains) {
    chain.missionIDs.forEach((missionID, partIndex) => {
      const mission = missionsByID[String(missionID)];
      if (!mission) return;
      // TQ's 6-hour bonus window, unless the client data sets one (Military part 1, Industry parts 7 and 10).
      if (!(mission.missionRewards?.bonusTimeInterval > 0)) {
        mission.missionRewards = { ...(mission.missionRewards || {}), bonusTimeInterval: DATA.bonusTimeIntervalMinutes };
      }
      // A patch's missionRewards fill in the client's rewards field by field: the Explorer chain's
      // ISK from a TQ recording, while part 5 keeps its faction's reward ship.
      // A mission's own patch (missionPatchesByID) comes after its division's and touches only
      // that faction's part.
      for (const { missionRewards, ...patch } of [
        DATA.missionPatches[String(chain.divisionID)]?.[String(partIndex)] || {},
        DATA.missionPatchesByID?.[String(missionID)] || {},
      ]) {
        Object.assign(mission, patch);
        if (missionRewards) {
          // The division-wide Explorer cash values are estimates from one
          // source agent. Keep native fields authoritative and mark only the
          // missing fields this estimate actually supplies.
          const native = mission.missionRewards || {};
          mission.estimatedRewardFields ||= [];
          for (const [field, value] of Object.entries(missionRewards)) {
            if (native[field] !== undefined && native[field] !== null) continue;
            (mission.missionRewards ||= {})[field] = value;
            mission.estimatedRewardFields.push(field);
          }
        }
      }
      const site = chain.divisionID === 26 ? DATA.explorationSites[String(partIndex)] : null;
      if (site) {
        // The same shape as EveJS's dungeon-fetch missions ("Civilians"). Gifts stay the
        // client's own values.
        mission.killMission = {
          ...(mission.killMission || {}),
          dungeonID: site.dungeonID,
          objectiveTypeID: site.objectiveTypeID,
          objectiveQuantity: 1,
        };
        mission.courierMission = null;
        mission.missionKind = "encounter";
        mission.contentTemplate = "agent.missionTemplatizedContent_StorylineKillMission";
      }
    });
  }
  return payload;
}

// Which part of the agent's career chain this mission is: { divisionID, part } with part 1-based,
// or null (not a career agent, or not one of its chain's missions).
function getChainPart(agentRecord, missionID) {
  const chain = chainOf(agentRecord);
  const index = chain ? chain.missionIDs.findIndex((id) => String(id) === String(missionID)) : -1;
  return index >= 0 ? { divisionID: chain.divisionID, part: index + 1 } : null;
}

// The chains' parts per division, for the AIR Career Program's career agent goals.
function listChainLengths() {
  const lengths = {};
  for (const chain of DATA.chains) lengths[chain.divisionID] = Math.max(lengths[chain.divisionID] || 0, chain.missionIDs.length);
  return lengths;
}

// True when this mission finishes the agent's career chain (or the agent has none).
function isCareerAgentFinished(agentRecord, missionID) {
  const chain = chainOf(agentRecord);
  return !chain || String(chain.missionIDs[chain.missionIDs.length - 1]) === String(missionID);
}

// The part of the agent's chain to offer after part 1: the first one the character has not
// completed (completedMissionIDs, from permanent chain progress). Null for an agent without a chain,
// before any part is completed (part 1 is the agent's usual offer), and after the last part.
function nextChainMissionID(agentRecord, completedMissionIDs) {
  const chain = chainOf(agentRecord);
  if (!chain) return null;
  const completed = new Set([...(completedMissionIDs || [])].map(String));
  if (!completed.has(String(chain.missionIDs[0]))) return null;
  return chain.missionIDs.find((missionID) => !completed.has(String(missionID))) ?? null;
}

// True once the character has completed the last part of the agent's chain: a career agent's
// missions can be done once, so it has nothing more to offer.
function isCareerChainCompleted(agentRecord, completedMissionIDs) {
  const chain = chainOf(agentRecord);
  if (!chain) return false;
  const completed = new Set([...(completedMissionIDs || [])].map(String));
  return completed.has(String(chain.missionIDs[chain.missionIDs.length - 1]));
}

// Career progression is an entitlement, not the bounded journal displayed to the
// client. Migrate retained history before it is pruned and keep only this agent's
// actual chain members. A completed Finder flag is already a permanent receipt:
// generic retained history cannot disprove a final completion that was pruned.
function reconcileChainProgress(characterState, getAgentByID) {
  const stored = characterState.careerChainProgressByAgentID;
  const source = stored && typeof stored === "object" && !Array.isArray(stored) ? stored : {};
  const oldStored = characterState.completedCareerMissionIDsByAgentID;
  const oldProgress = oldStored && typeof oldStored === "object" && !Array.isArray(oldStored) ? oldStored : {};
  const evidence = characterState.careerProgramMissionEvidence;
  const receipts = evidence?.version === 1 && evidence.receipts && typeof evidence.receipts === "object" &&
    !Array.isArray(evidence.receipts) ? Object.entries(evidence.receipts).flatMap(([key, receipt]) => {
      const match = /^([1-9]\d*):([1-9]\d*)$/.exec(key);
      return match && Number.isSafeInteger(receipt?.completedAtMs) && receipt.completedAtMs > 0
        ? [{ agentID: Number(match[1]), contentID: receipt.contentID }] : [];
    }) : [];
  const history = Array.isArray(characterState.history) ? characterState.history : [];
  const agentIDs = new Set([
    ...Object.keys(source),
    ...Object.keys(oldProgress),
    ...Object.keys(characterState.completedCareerAgentIDs || {}),
    ...history.map(entry => String(entry?.agentID)),
    ...receipts.map(receipt => String(receipt.agentID)),
  ]);
  const normalized = {};
  for (const key of [...agentIDs].sort((left, right) => Number(left) - Number(right))) {
    const agentID = Number(key);
    if (!Number.isSafeInteger(agentID) || agentID <= 0) continue;
    const agent = getAgentByID(agentID), chain = chainOf(agent);
    if (!chain) continue;
    const record = source[String(agentID)] || {};
    const completed = new Set((Array.isArray(record.completedMissionIDs) ? record.completedMissionIDs : []).map(String));
    const migrateLegacy = !Object.hasOwn(source, String(agentID));
    const addCompleted = (missionID, inferPredecessors = false) => {
      const index = chain.missionIDs.findIndex(id => String(id) === String(missionID));
      if (index < 0) return;
      for (const id of inferPredecessors ? chain.missionIDs.slice(0, index + 1) : [chain.missionIDs[index]]) {
        completed.add(String(id));
      }
    };
    if (migrateLegacy) {
      // The earlier AIR fixes branch used a flat per-agent completion list.
      for (const missionID of Array.isArray(oldProgress[String(agentID)]) ? oldProgress[String(agentID)] : []) {
        addCompleted(missionID);
      }
      // Before permanent progress existed, part N could be the only surviving
      // journal entry. Sequential completion proves predecessors for this same
      // agent's own chain. Modern records never receive this inference.
      for (const receipt of receipts.filter(entry => entry.agentID === agentID)) {
        addCompleted(receipt.contentID, true);
      }
    }
    let closedStatus = ["completed", "declined", "quit"].includes(record.closedStatus) ? record.closedStatus : null;
    const here = history.filter(entry => entry && Number(entry.agentID) === agentID && getChainPart(agent, entry.contentID));
    for (const entry of here) {
      if (entry.runtimeStatus === "completed") addCompleted(entry.contentID, migrateLegacy);
      else if (!closedStatus && ["declined", "quit"].includes(entry.runtimeStatus)) closedStatus = entry.runtimeStatus;
    }
    const completedMissionIDs = chain.missionIDs.filter(id => completed.has(String(id)));
    if (characterState.completedCareerAgentIDs?.[String(agentID)] === true ||
        isCareerChainCompleted(agent, completedMissionIDs)) closedStatus = "completed";
    if (completedMissionIDs.length || closedStatus) {
      normalized[String(agentID)] = { completedMissionIDs, ...(closedStatus ? { closedStatus } : {}) };
    }
  }
  characterState.careerChainProgressByAgentID = normalized;
  return normalized;
}

function completedChainMissionIDs(characterState, agentRecord) {
  return characterState?.careerChainProgressByAgentID?.[String(agentRecord?.agentID)]?.completedMissionIDs || [];
}

function isCareerChainClosed(characterState, agentRecord) {
  if (!chainOf(agentRecord)) return false;
  return characterState?.completedCareerAgentIDs?.[String(agentRecord.agentID)] === true ||
    Boolean(characterState?.careerChainProgressByAgentID?.[String(agentRecord.agentID)]?.closedStatus);
}

function recordChainOutcome(characterState, agentRecord, missionID, status) {
  if (!getChainPart(agentRecord, missionID) || !["completed", "declined", "quit"].includes(status)) return;
  characterState.careerChainProgressByAgentID ||= {};
  const key = String(agentRecord.agentID);
  const record = characterState.careerChainProgressByAgentID[key] ||= { completedMissionIDs: [] };
  if (status === "completed") {
    const completed = new Set([...(Array.isArray(record.completedMissionIDs) ? record.completedMissionIDs : []), missionID].map(String));
    record.completedMissionIDs = chainOf(agentRecord).missionIDs.filter(id => completed.has(String(id)));
    if (isCareerChainCompleted(agentRecord, record.completedMissionIDs)) record.closedStatus = "completed";
  } else if (record.closedStatus !== "completed") record.closedStatus = status;
}

module.exports = {
  listGoldenMissionChains,
  isCareerChainCompleted,
  applyToMissionAuthorityPayload,
  isCareerAgentFinished,
  nextChainMissionID,
  getChainPart,
  listChainLengths,
  reconcileChainProgress,
  completedChainMissionIDs,
  isCareerChainClosed,
  recordChainOutcome,
};
