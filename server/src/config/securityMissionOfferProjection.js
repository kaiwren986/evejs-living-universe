"use strict";

const baseline = require("./securityMissionOfferProjection.json");
function familyKey(title) {
  return String(title || "").toLowerCase().replace(/\s*\(\d+ of \d+\)\s*/g, " ").replace(/\s+/g, " ").trim();
}
function getCohort(agent, space, catalog = baseline) {
  if (!agent || !space || !(space.factionID > 0 || space.regionID > 0)) return null;
  const ranked = Object.values(catalog.contextsByAgentID).filter((source) =>
    source.agentTypeID === agent.agentTypeID && source.missionKind === agent.missionKind).map((source) => {
    const corporation = source.corporationID === agent.corporationID;
    const faction = source.factionID === agent.factionID;
    const system = source.solarSystemID === agent.solarSystemID;
    const region = space.regionID > 0 && source.regionID === space.regionID;
    const owner = space.factionID > 0 && source.spaceFactionID === space.factionID;
    const rank = [corporation && system, faction && system, system, corporation && region, faction && region, region,
      corporation && owner, faction && owner, owner, faction, corporation].findIndex(Boolean);
    return { source, rank };
  }).filter((row) => row.rank >= 0 &&
    (!(space.specialSpace || space.wormholeSpace) || row.source.solarSystemID === agent.solarSystemID || row.source.regionID === space.regionID));
  if (!ranked.length) return null;
  const bestRank = Math.min(...ranked.map((row) => row.rank));
  return { basis: ["corporation_system", "faction_system", "system", "corporation_region", "faction_region", "region",
    "corporation_space", "faction_space", "space", "agent_faction", "corporation"][bestRank],
  profiles: ranked.filter((row) => row.rank === bestRank).map((row) => row.source),
  validationTODO: "TODO: Closest captured L1 cohort is a projected eligibility baseline for this agent/level, not an exhaustive or measured pool." };
}
function allowsFamily(cohort, title, level, catalog = baseline) {
  const family = familyKey(title);
  if (!cohort || !family) return true;
  // L2-5 introduce their own missions. Do not erase them for lacking an L1 analogue.
  if (level > 1 && !catalog.families[family]) return true;
  return cohort.profiles.some((profile) => profile.families.includes(family));
}
function desiredEnemyFactionIDs(agent, space, title, localPirateFactionID, catalog = baseline) {
  const family = familyKey(title), row = catalog.families[family];
  if (!row || row.mode === "unknown_native_enemy") return null;
  if (row.mode === "space") return row.bySpaceFactionID[space?.factionID] || (localPirateFactionID ? [localPirateFactionID] : null);
  if (row.mode === "agent_faction") {
    const cohort = getCohort(agent, space, catalog);
    const sameFactionAgents = new Set((cohort?.profiles || []).filter((source) => source.factionID === agent.factionID).map((source) => source.agentID));
    const nearest = [...new Set(row.observations.filter((source) => sameFactionAgents.has(source.agentID))
      .map((source) => source.enemyFactionID).filter(Boolean))];
    return nearest.length ? nearest : row.byAgentFactionID[agent.factionID] || null;
  }
  if (row.mode === "fixed_observed_enemy") return row.observedEnemyFactionIDs;
  const cohort = getCohort(agent, space, catalog);
  if (!cohort) return null;
  const agents = new Set(cohort.profiles.map((profile) => profile.agentID));
  const enemies = [...new Set(row.observations.filter((observation) => agents.has(observation.agentID))
    .map((observation) => observation.enemyFactionID).filter(Boolean))];
  return enemies.length ? enemies : null;
}
module.exports = { familyKey, getCohort, allowsFamily, desiredEnemyFactionIDs };
