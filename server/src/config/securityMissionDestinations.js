"use strict";

const baseline = require("./securityMissionDestinations.json");
const measured = require("./securityMissionDestinationMeasured.json");
const { familyKey, getCohort } = require("./securityMissionOfferProjection");
function securityBand(system) {
  const value = system?.security ?? system?.securityStatus;
  return Number.isFinite(value) ? value >= 0.45 ? "high" : value > 0 ? "low" : "null" : null;
}
function choose(rows, random) {
  const total = rows.reduce((sum, row) => sum + row.count, 0);
  let cursor = Math.max(0, Math.min(1 - Number.EPSILON, Number(random()) || 0)) * total;
  for (const row of rows) {
    cursor -= row.count;
    if (cursor < 0) return row;
  }
  return rows.at(-1);
}
function sameMission(row, mission) {
  return row.missionID === mission.missionID && row.titleID === mission.nameID && row.dungeonID === mission.killMission?.dungeonID;
}
function matchingContext(profile, agent) {
  return profile && ["agentID", "agentTypeID", "level", "missionKind", "corporationID", "factionID", "stationID", "solarSystemID"]
    .every((key) => profile[key] === agent[key]);
}
function selectDestination(agent, mission, options, catalog = baseline) {
  const { getSystem, systemsInBand, random, fixedSystemID = 0, capturedSystemID = 0 } = options;
  const origin = Number(agent?.solarSystemID) || 0;
  const fallback = () => ({ solarSystemID: capturedSystemID || origin, basis: capturedSystemID ? "captured_setup" : "agent_system_fallback" });
  if (fixedSystemID > 0) return { solarSystemID: fixedSystemID, basis: "native_fixed" };
  if (agent?.agentTypeID !== 2 || agent?.missionKind !== "encounter" || !(agent.level >= 1 && agent.level <= 5) ||
      mission?.contentTemplate !== "agent.missionTemplatizedContent_BasicKillMission") return fallback();
  const system = getSystem(origin), originBand = securityBand(system);
  if (!system || !originBand) return fallback();
  const bands = new Map();
  const candidatesAt = (jumps) => {
    if (!bands.has(jumps)) bands.set(jumps, [...new Set(jumps === 0 ? [origin] : systemsInBand(origin, jumps, jumps))]
      .filter((id) => id > 0 && getSystem(id)).sort((a, b) => a - b));
    return bands.get(jumps);
  };
  const sampleObserved = (profile, basis) => {
    const row = profile?.missionsByID[mission.missionID];
    if (!matchingContext(profile, agent) || !row || !sameMission(row, mission)) return null;
    const available = row.destinations.filter((entry) => entry.count > 0 && candidatesAt(entry.jumps).includes(entry.solarSystemID));
    return available.length ? { solarSystemID: choose(available, random).solarSystemID, basis, sampleCount: row.count } : null;
  };
  const observed = sampleObserved(catalog.contextsByAgentID[agent.agentID], "observed_agent_mission") ||
    sampleObserved(measured.contextsByAgentID[agent.agentID], "measured_agent_mission");
  if (observed) return observed;
  // An older exact-context setup remains authoritative when this decline study
  // has no matching observations. Never relocate that setup using a projection.
  if (capturedSystemID > 0) return fallback();
  const space = options.space || system;
  const cohort = getCohort(agent, space, catalog);
  if (!cohort && (space.specialSpace || space.wormholeSpace)) return fallback();
  const family = familyKey(mission.localizedName?.text);
  const all = Object.values(catalog.contextsByAgentID).flatMap((profile) => Object.values(profile.missionsByID));
  const nearby = (cohort?.profiles || []).flatMap((profile) => Object.values(profile.missionsByID));
  const groups = [
    ["cohort_mission", nearby.filter((entry) => sameMission(entry, mission))],
    ["cohort_family", nearby.filter((entry) => family && entry.family === family)],
    ["cohort_overall", nearby],
    ["corpus_family", all.filter((entry) => family && entry.family === family)],
    ["corpus_overall", all],
  ];
  const selected = groups.find(([, entries]) => entries.length);
  if (!selected) return fallback();
  const bins = new Map();
  for (const entry of selected[1].flatMap((item) => item.destinations)) {
    if (!Number.isSafeInteger(entry.jumps) || entry.jumps < 0 || entry.jumps > catalog.maximumObservedJumps || !(entry.count > 0)) continue;
    const band = entry.securityRelation === "same" ? originBand : entry.securityBand;
    const key = `${entry.jumps}:${band}`;
    if (!bins.has(key)) bins.set(key, { jumps: entry.jumps, band, count: 0 });
    bins.get(key).count += entry.count;
  }
  const available = [...bins.values()].map((bin) => ({ ...bin,
    systems: candidatesAt(bin.jumps).filter((id) => securityBand(getSystem(id)) === bin.band),
  })).filter((bin) => bin.systems.length);
  if (!available.length) return fallback();
  const bin = choose(available, random);
  return { solarSystemID: choose(bin.systems.map((id) => ({ id, count: 1 })), random).id,
    basis: selected[0], cohortBasis: cohort?.basis || null, projected: true,
    validationTODO: "TODO: Projected L1 distance/security distribution and uniform system choice; validate this agent, mission, level and destination restrictions." };
}
module.exports = { selectDestination };
