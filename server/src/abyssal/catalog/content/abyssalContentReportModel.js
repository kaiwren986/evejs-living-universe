"use strict";

// Private fixed capability links preserve late reads during catalogue initialization.
function normalizeNpcOperation(ports, entry = {}) {
  return {
    quantity: Math.max(0, (0, ports.toInteger)(entry.quantity, 0)),
    type_id: Math.max(0, (0, ports.toInteger)(entry.type_id ?? entry.typeID, 0)),
    behavior_name: String(entry.behavior_name ?? entry.behaviorName ?? ""),
    behavior_id: Math.max(0, (0, ports.toInteger)(entry.behavior_id ?? entry.behaviorID, 0)),
    cost: Math.max(0, (0, ports.toInteger)(entry.cost, 0)),
    total_cost: Math.max(0, (0, ports.toInteger)(entry.total_cost ?? entry.totalCost, 0)),
    npc_tag_names: (0, ports.normalizeStringArray)(entry.npc_tag_names ?? entry.npcTagNames),
    npc_tags: (0, ports.normalizeIntegerArray)(entry.npc_tags ?? entry.npcTags),
  };
}

function normalizeSpawnOperation(ports, entry = {}) {
  const npcs = Array.isArray(entry.npcs) ? entry.npcs.map(ports.normalizeNpc) : [];
  return {
    npc_fleet_type_name: String(entry.npc_fleet_type_name ?? entry.npcFleetTypeName ?? ""),
    npc_fleet_type_id: Math.max(0, (0, ports.toInteger)(entry.npc_fleet_type_id ?? entry.npcFleetTypeID, 0)),
    group_behavior_name: String(entry.group_behavior_name ?? entry.groupBehaviorName ?? ""),
    group_behavior_id: Math.max(0, (0, ports.toInteger)(entry.group_behavior_id ?? entry.groupBehaviorID, 0)),
    spawn_points: Math.max(0, (0, ports.toInteger)(entry.spawn_points ?? entry.spawnPoints, 0)),
    spent_points: Math.max(0, (0, ports.toInteger)(entry.spent_points ?? entry.spentPoints, 0)),
    remaining_points: Math.max(0, (0, ports.toInteger)(entry.remaining_points ?? entry.remainingPoints, 0)),
    npc_fleet_spawn_tag_names: (0, ports.normalizeStringArray)(
      entry.npc_fleet_spawn_tag_names ?? entry.npcFleetSpawnTagNames,
    ),
    npc_fleet_spawn_tags: (0, ports.normalizeIntegerArray)(
      entry.npc_fleet_spawn_tags ?? entry.npcFleetSpawnTags,
    ),
    npcs,
  };
}

function buildEmptyReportOperation(ports, difficultyTier, spawnTableID, repetitions) {
  return {
    difficulty_tier: difficultyTier,
    spawn_table_id: spawnTableID,
    repetitions,
    average_spawn_points: 0,
    average_spent_points: 0,
    average_remaining_points: 0,
    average_number_of_npcs: 0,
    unsupported_tag_names: [],
    unsupported_tags: [],
    spawns: [],
  };
}

function normalizeReportOperation(ports, rawReport, difficultyTier, spawnTableID, repetitions) {
  const source = rawReport && typeof rawReport === "object" ? rawReport : {};
  const spawns = Array.isArray(source.spawns)
    ? source.spawns.map(ports.normalizeSpawn)
    : [];

  return {
    difficulty_tier: (0, ports.toInteger)(source.difficulty_tier ?? source.difficultyTier, difficultyTier),
    spawn_table_id: (0, ports.toInteger)(source.spawn_table_id ?? source.spawnTableID, spawnTableID),
    repetitions: (0, ports.toInteger)(source.repetitions, repetitions),
    average_spawn_points: Math.max(
      0,
      (0, ports.toInteger)(source.average_spawn_points ?? source.averageSpawnPoints, 0),
    ),
    average_spent_points: Math.max(
      0,
      (0, ports.toInteger)(source.average_spent_points ?? source.averageSpentPoints, 0),
    ),
    average_remaining_points: Math.max(
      0,
      (0, ports.toInteger)(source.average_remaining_points ?? source.averageRemainingPoints, 0),
    ),
    average_number_of_npcs: Math.max(
      0,
      (0, ports.toInteger)(source.average_number_of_npcs ?? source.averageNumberOfNpcs, 0),
    ),
    unsupported_tag_names: (0, ports.normalizeStringArray)(
      source.unsupported_tag_names ?? source.unsupportedTagNames,
    ),
    unsupported_tags: (0, ports.normalizeIntegerArray)(
      source.unsupported_tags ?? source.unsupportedTags,
    ),
    spawns,
  };
}

function marshalNpcOperation(ports, entry = {}) {
  return (0, ports.buildDict)([
    ["quantity", entry.quantity],
    ["type_id", entry.type_id],
    ["behavior_name", entry.behavior_name],
    ["behavior_id", entry.behavior_id],
    ["cost", entry.cost],
    ["total_cost", entry.total_cost],
    ["npc_tag_names", (0, ports.buildList)(entry.npc_tag_names)],
    ["npc_tags", (0, ports.buildList)(entry.npc_tags)],
  ]);
}

function marshalSpawnOperation(ports, entry = {}) {
  return (0, ports.buildDict)([
    ["npc_fleet_type_name", entry.npc_fleet_type_name],
    ["npc_fleet_type_id", entry.npc_fleet_type_id],
    ["group_behavior_name", entry.group_behavior_name],
    ["group_behavior_id", entry.group_behavior_id],
    ["spawn_points", entry.spawn_points],
    ["spent_points", entry.spent_points],
    ["remaining_points", entry.remaining_points],
    ["npc_fleet_spawn_tag_names", (0, ports.buildList)(entry.npc_fleet_spawn_tag_names)],
    ["npc_fleet_spawn_tags", (0, ports.buildList)(entry.npc_fleet_spawn_tags)],
    ["npcs", (0, ports.buildList)((entry.npcs || []).map(ports.marshalNpc))],
  ]);
}

function marshalReportOperation(ports, report = {}) {
  return (0, ports.buildDict)([
    ["difficulty_tier", report.difficulty_tier],
    ["spawn_table_id", report.spawn_table_id],
    ["repetitions", report.repetitions],
    ["average_spawn_points", report.average_spawn_points],
    ["average_spent_points", report.average_spent_points],
    ["average_remaining_points", report.average_remaining_points],
    ["average_number_of_npcs", report.average_number_of_npcs],
    ["unsupported_tag_names", (0, ports.buildList)(report.unsupported_tag_names || [])],
    ["unsupported_tags", (0, ports.buildList)(report.unsupported_tags || [])],
    ["spawns", (0, ports.buildList)((report.spawns || []).map(ports.marshalSpawn))],
  ]);
}

function createAbyssalContentReportModel(dependencies) {
  const ports = Object.create(dependencies);
  const model = {
    normalizeNpc: normalizeNpcOperation.bind(undefined, ports),
    normalizeSpawn: normalizeSpawnOperation.bind(undefined, ports),
    buildEmptyReport: buildEmptyReportOperation.bind(undefined, ports),
    normalizeReport: normalizeReportOperation.bind(undefined, ports),
    marshalNpc: marshalNpcOperation.bind(undefined, ports),
    marshalSpawn: marshalSpawnOperation.bind(undefined, ports),
    marshalReport: marshalReportOperation.bind(undefined, ports),
  };
  Object.assign(ports, model);
  Object.freeze(ports);
  return model;
}

module.exports = { createAbyssalContentReportModel };
