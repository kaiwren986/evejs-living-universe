"use strict";

const CAPABILITY = "career-agent-missions-v1";
const SCHEMA = "evejs.career-agent-missions.v1";
function validate(content) {
  if (content?.schema !== SCHEMA || !Array.isArray(content.chains) || !content.missionsByID || !content.agentsByID) {
    throw new Error("Invalid career-agent mission contribution");
  }
  const canonical = require("../services/agent/careerAgentChains.json").chains;
  const seen = new Set(), identities = new Set();
  for (const chain of content.chains) {
    const key = `${chain.factionID}:${chain.divisionID}`;
    const native = canonical.find(row => `${row.factionID}:${row.divisionID}` === key);
    if (identities.has(key) || !native || JSON.stringify(chain.missionIDs) !== JSON.stringify(native.missionIDs)) {
      throw new Error(`Invalid career chain ${key}`);
    }
    identities.add(key);
    for (const id of chain.missionIDs) {
      const mission = content.missionsByID[id];
      if (!mission || Number(mission.missionID) !== Number(id) || Number(mission.factionID) !== Number(chain.factionID)) {
        throw new Error(`Missing career mission ${id}`);
      }
      seen.add(String(id));
    }
  }
  if (identities.size !== canonical.length || seen.size !== Object.keys(content.missionsByID).length) {
    throw new Error("Incomplete career mission chains");
  }
  const counts = new Map();
  for (const [id, agent] of Object.entries(content.agentsByID)) {
    const key = `${agent.factionID}:${agent.divisionID}`;
    if (String(agent.agentID) !== id || agent.agentTypeID !== 12 || !identities.has(key)) throw new Error(`Invalid career agent ${id}`);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  if ([...identities].some(key => counts.get(key) !== 5)) throw new Error("Incomplete career agent bindings");
  return { missions: seen.size, chains: identities.size, agents: Object.keys(content.agentsByID).length };
}
function apply(payload, agentsByID) {
  const contributions = require("./contentPackManager").initializeContentPacks()
    .map(loaded => loaded.pack?.payload?.careerAgents).filter(Boolean);
  if (!contributions.length) return payload; // Compatibility with earlier site-only packs.
  if (contributions.length !== 1) throw new Error("Conflicting career-agent mission packs");
  const content = contributions[0]; validate(content);
  payload.missionsByID ||= {};
  payload.indexes ||= {};
  payload.indexes.agentIDToMissionIDs ||= {};
  for (const [id, mission] of Object.entries(content.missionsByID)) payload.missionsByID[id] = structuredClone(mission);
  for (const [id, binding] of Object.entries(content.agentsByID)) {
    const actual = agentsByID?.[id];
    if (!actual || Number(actual.agentTypeID) !== 12 || Number(actual.factionID) !== binding.factionID ||
        Number(actual.divisionID) !== binding.divisionID) throw new Error(`Career agent identity conflict ${id}`);
    const chain = content.chains.find(row => row.factionID === binding.factionID && row.divisionID === binding.divisionID);
    payload.indexes.agentIDToMissionIDs[id] = [chain.missionIDs[0]];
  }
  return payload;
}
module.exports = { CAPABILITY, SCHEMA, validate, apply };
