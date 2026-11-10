"use strict";

const {
  ENTITY_TYPE,
} = require("../entityConstants");

const NPC_TABLE = Object.freeze({
  PROFILES: "npcProfiles",
  LOADOUTS: "npcLoadouts",
  SPAWN_POOLS: "npcSpawnPools",
});

const ICE_HARVESTER_TYPE_ID = 16278;
// Ice Harvester Upgrade I shortens the cycle of modules that need Ice
// Harvesting. Mining Laser Upgrades only boost modules that need the Mining
// skill, so they do nothing for an Ice Harvester.
const ICE_HARVESTER_UPGRADE_TYPE_ID = 22576;
// NPC queries also match part of an ID, so this ID must not contain
// "mining ops": that query belongs to the authored npc_mining_ops pool.
const ICE_MINING_POOL_ID = "npc_ice_harvesters";
const PASSIVE_MINING_BEHAVIOR_ID = "npc_passive_idle";
const MINING_LOOT_TABLE_ID = "parity_diamond_entities_pending_loot";
const ORE_CORPORATION_ID = 1000129;
const ORE_FACTION_ID = 500014;

const ICE_MINER_SPECS = Object.freeze([
  Object.freeze({
    profileID: "ore_ice_mining_retriever",
    name: "ORE Ice Mining Retriever",
    description: "Diamond-style Retriever fitted with Ice Harvesters for NPC ice-mining fleets.",
    aliases: ["ice mining retriever", "retriever ice miner"],
    shipTypeID: 17478,
    presentationTypeID: 42534,
    presentationName: "♦ Retriever",
    shipNameTemplate: "Ice Mining Retriever",
    moduleUpgradeCount: 2,
    weight: 5,
  }),
  Object.freeze({
    profileID: "ore_ice_mining_skiff",
    name: "ORE Ice Mining Skiff",
    description: "Diamond-style Skiff fitted with Ice Harvesters for tougher NPC ice-mining fleets.",
    aliases: ["ice mining skiff", "skiff ice miner"],
    shipTypeID: 22546,
    presentationTypeID: 42535,
    presentationName: "♦ Skiff",
    shipNameTemplate: "Ice Mining Skiff",
    moduleUpgradeCount: 1,
    weight: 2,
  }),
  Object.freeze({
    profileID: "ore_ice_mining_hulk",
    name: "ORE Ice Mining Hulk",
    description: "Diamond-style Hulk fitted with Ice Harvesters for high-yield NPC ice-mining fleets.",
    aliases: ["ice mining hulk", "hulk ice miner"],
    shipTypeID: 22544,
    presentationTypeID: 22544,
    presentationName: "♦ Hulk",
    shipNameTemplate: "Ice Mining Hulk",
    moduleUpgradeCount: 2,
    weight: 1,
  }),
]);

function buildIceMinerProfile(spec) {
  return {
    profileID: spec.profileID,
    name: spec.name,
    description: spec.description,
    aliases: spec.aliases,
    entityType: ENTITY_TYPE.NPC,
    shipTypeID: spec.shipTypeID,
    presentationTypeID: spec.presentationTypeID,
    presentationName: spec.presentationName,
    corporationID: ORE_CORPORATION_ID,
    allianceID: 0,
    factionID: ORE_FACTION_ID,
    behaviorProfileID: PASSIVE_MINING_BEHAVIOR_ID,
    loadoutID: `${spec.profileID}_harvester_pair`,
    lootTableID: MINING_LOOT_TABLE_ID,
    shipNameTemplate: spec.shipNameTemplate,
    securityStatus: 0,
    bounty: 0,
    spawnDistanceMeters: 12_000,
    preferredTargetMode: "invoker",
    miningRole: "miner",
    hostileResponseThreshold: -5,
    friendlyResponseThreshold: 5,
  };
}

function buildIceMinerLoadout(spec) {
  return {
    loadoutID: `${spec.profileID}_harvester_pair`,
    name: `${spec.name} Harvester Pair`,
    modules: [
      {
        typeID: ICE_HARVESTER_TYPE_ID,
        quantity: 2,
      },
      {
        typeID: ICE_HARVESTER_UPGRADE_TYPE_ID,
        quantity: spec.moduleUpgradeCount,
      },
    ],
    charges: [],
  };
}

function buildGeneratedRows() {
  return Object.freeze({
    [NPC_TABLE.PROFILES]: Object.freeze(ICE_MINER_SPECS.map(buildIceMinerProfile)),
    [NPC_TABLE.LOADOUTS]: Object.freeze(ICE_MINER_SPECS.map(buildIceMinerLoadout)),
    [NPC_TABLE.SPAWN_POOLS]: Object.freeze([{
      spawnPoolID: ICE_MINING_POOL_ID,
      name: "Ice Mining Operations",
      description: "Weighted diamond-style barge and exhumer pool fitted with Ice Harvesters for manual ice-mining fleet spawning.",
      aliases: ["ice mining", "ice miners", "npc ice miners"],
      entityType: ENTITY_TYPE.NPC,
      entries: ICE_MINER_SPECS.map((spec) => ({
        profileID: spec.profileID,
        weight: spec.weight,
      })),
    }]),
  });
}

let cachedRowsByTableName = null;
const NO_GENERATED_ROWS = Object.freeze([]);

function getMiningNpcGeneratedRows(tableName) {
  if (!cachedRowsByTableName) {
    cachedRowsByTableName = buildGeneratedRows();
  }
  return cachedRowsByTableName[tableName] || NO_GENERATED_ROWS;
}

module.exports = {
  ICE_HARVESTER_TYPE_ID,
  ICE_MINING_POOL_ID,
  getMiningNpcGeneratedRows,
};
