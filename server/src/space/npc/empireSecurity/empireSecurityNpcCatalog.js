"use strict";

const {
  EVERMORE_CUSTOMS_CORPORATION_ID,
  EVERMORE_CUSTOMS_LOADOUT_ID,
  EVERMORE_CUSTOMS_MAJOR_PROFILE_ID,
  EVERMORE_CUSTOMS_MAJOR_TYPE_ID,
  EVERMORE_CUSTOMS_OFFICIAL_PROFILE_ID,
  EVERMORE_CUSTOMS_OFFICIAL_TYPE_ID,
  EVERMORE_CUSTOMS_SPAWN_GROUP_ID,
  EVERMORE_FACTION_ID,
} = require("../../empireGatePresence/everMoreGatePresence");
const {
  ENTITY_TYPE,
} = require("../../entityConstants");
const {
  CPF_AGENT_PROFILE_ID,
  CPF_COMMISSIONER_PROFILE_ID,
  CPF_CORPORATION_ID,
  CPF_CUSTOMS_LOADOUT_ID,
  CPF_FACTION_ID,
  CPF_SPAWN_GROUP_ID,
} = require("../../empireGatePresence/customsOperatorLayouts");

const NPC_TABLE = Object.freeze({
  PROFILES: "npcProfiles",
  LOADOUTS: "npcLoadouts",
  SPAWN_GROUPS: "npcSpawnGroups",
});

const PASSIVE_SECURITY_BEHAVIOR_ID = "npc_passive_idle";
const GENERIC_LOOT_TABLE_ID = "generic_random_any";

function buildSpawnGroup(spawnGroupID, name, description, entityType, entries, aliases = []) {
  return {
    spawnGroupID,
    name,
    description,
    aliases,
    entityType,
    entries,
  };
}

function buildEverMoreGatePresenceRows() {
  const profileBase = {
    description:
      "TQ-observed EverMore/Villore Sec Ops gate-presence profile for Jita-style stargate security.",
    aliases: [],
    entityType: ENTITY_TYPE.CONCORD,
    corporationID: EVERMORE_CUSTOMS_CORPORATION_ID,
    allianceID: 0,
    factionID: EVERMORE_FACTION_ID,
    behaviorProfileID: PASSIVE_SECURITY_BEHAVIOR_ID,
    loadoutID: EVERMORE_CUSTOMS_LOADOUT_ID,
    lootTableID: GENERIC_LOOT_TABLE_ID,
    securityStatus: 5,
    bounty: 0,
    spawnDistanceMeters: 16_000,
    preferredTargetMode: "none",
    hardwareFamily: "concord",
    hostileResponseThreshold: -11,
    friendlyResponseThreshold: -11,
  };

  return {
    profiles: [
      {
        ...profileBase,
        profileID: EVERMORE_CUSTOMS_MAJOR_PROFILE_ID,
        name: "EverMore Customs Major",
        presentationTypeID: EVERMORE_CUSTOMS_MAJOR_TYPE_ID,
        shipTypeID: EVERMORE_CUSTOMS_MAJOR_TYPE_ID,
        shipNameTemplate: "EverMore Customs Major",
        aliases: ["evermore customs major", "villore sec ops customs major"],
      },
      {
        ...profileBase,
        profileID: EVERMORE_CUSTOMS_OFFICIAL_PROFILE_ID,
        name: "EverMore Customs Official",
        presentationTypeID: EVERMORE_CUSTOMS_OFFICIAL_TYPE_ID,
        shipTypeID: EVERMORE_CUSTOMS_OFFICIAL_TYPE_ID,
        shipNameTemplate: "EverMore Customs Official",
        aliases: ["evermore customs official", "villore sec ops customs official"],
      },
    ],
    loadouts: [
      {
        loadoutID: EVERMORE_CUSTOMS_LOADOUT_ID,
        name: "EverMore Gate Customs Observed Empty Loadout",
        modules: [],
        charges: [],
      },
    ],
    spawnGroups: [
      buildSpawnGroup(
        EVERMORE_CUSTOMS_SPAWN_GROUP_ID,
        "EverMore Gate Customs",
        "TQ-observed EverMore/Villore Sec Ops Jita-style customs chain for configured high-security stargates.",
        ENTITY_TYPE.CONCORD,
        [
          {
            profileID: EVERMORE_CUSTOMS_MAJOR_PROFILE_ID,
            count: 2,
          },
          {
            profileID: EVERMORE_CUSTOMS_OFFICIAL_PROFILE_ID,
            count: 2,
          },
        ],
        ["evermore customs", "villore sec ops customs", "jita gate customs"],
      ),
    ],
  };
}

function buildGeneratedRows() {
  const everMoreRows = buildEverMoreGatePresenceRows();
  const cpfProfiles = [
    { profileID: CPF_COMMISSIONER_PROFILE_ID, name: "Caldari Customs Commissioner", typeID: 19367 },
    { profileID: CPF_AGENT_PROFILE_ID, name: "Caldari Customs Agent", typeID: 19385 },
  ].map((entry) => ({
    profileID: entry.profileID,
    name: entry.name,
    description: "TQ-captured Corporate Police Force customs operator using installed retail entity dogma.",
    aliases: [entry.name.toLowerCase()],
    entityType: ENTITY_TYPE.CONCORD,
    shipTypeID: entry.typeID,
    presentationTypeID: entry.typeID,
    corporationID: CPF_CORPORATION_ID,
    allianceID: 0,
    factionID: CPF_FACTION_ID,
    behaviorProfileID: PASSIVE_SECURITY_BEHAVIOR_ID,
    loadoutID: CPF_CUSTOMS_LOADOUT_ID,
    lootTableID: GENERIC_LOOT_TABLE_ID,
    shipNameTemplate: entry.name,
    hardwareFamily: "sdeEntityNpc",
    securityStatus: 5,
    bounty: 0,
    spawnDistanceMeters: 16000,
    preferredTargetMode: "none",
    hostileResponseThreshold: -11,
    friendlyResponseThreshold: -11,
  }));
  return Object.freeze({
    [NPC_TABLE.PROFILES]: Object.freeze([...everMoreRows.profiles, ...cpfProfiles]),
    [NPC_TABLE.LOADOUTS]: Object.freeze([...everMoreRows.loadouts, {
      loadoutID: CPF_CUSTOMS_LOADOUT_ID,
      name: "Customs retail entity hull equipment",
      modules: [],
      charges: [],
    }]),
    [NPC_TABLE.SPAWN_GROUPS]: Object.freeze([...everMoreRows.spawnGroups, buildSpawnGroup(
      CPF_SPAWN_GROUP_ID,
      "Corporate Police Force Customs",
      "TQ-captured four-officer customs gate formation.",
      ENTITY_TYPE.CONCORD,
      cpfProfiles.map((profile) => ({ profileID: profile.profileID, count: 2 })),
      ["corporate police force customs"],
    )]),
  });
}

let cachedRowsByTableName = null;

// Shared so tables this catalog does not contribute to return the same array
// every call; npcData caches by identity and a fresh [] defeats it.
const NO_GENERATED_ROWS = Object.freeze([]);

function getEmpireSecurityGeneratedRows(tableName) {
  if (!cachedRowsByTableName) {
    cachedRowsByTableName = buildGeneratedRows();
  }
  return cachedRowsByTableName[tableName] || NO_GENERATED_ROWS;
}

module.exports = {
  getEmpireSecurityGeneratedRows,
};
