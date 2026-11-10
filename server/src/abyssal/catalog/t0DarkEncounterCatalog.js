"use strict";

const {
  cloneValue,
  deepFreeze,
} = require("../domain/abyssalValueUtils");

const T0_DARK_ENCOUNTER_THEME = "abyssal_tier0_mixed_triglavian_drone";

const T0_DARK_APPROVED_NPC_REFERENCES = deepFreeze({
  abyssal_rogue_drone_sparkneedle: {
    typeID: 47847,
    displayName: "Sparkneedle Tessella",
    groupID: 1997,
    factionID: 500025,
    damageType: "em",
    source: "EVE_REF_AND_EXISTING_EVEJS_PROFILE",
  },
  abyssal_rogue_drone_emberneedle: {
    typeID: 47848,
    displayName: "Emberneedle Tessella",
    groupID: 1997,
    factionID: 500025,
    damageType: "thermal",
    maximumTargetingRangeMeters: 20_000,
    source: "EVE_REF_TYPE_47848",
  },
  abyssal_rogue_drone_strikeneedle: {
    typeID: 47849,
    displayName: "Strikeneedle Tessella",
    groupID: 1997,
    factionID: 500025,
    damageType: "kinetic",
    maximumTargetingRangeMeters: 20_000,
    source: "EVE_REF_TYPE_47849",
  },
  abyssal_rogue_drone_blastneedle: {
    typeID: 47855,
    displayName: "Blastneedle Tessella",
    groupID: 1997,
    factionID: 500025,
    damageType: "explosive",
    source: "EVE_REF_AND_EXISTING_EVEJS_PROFILE",
  },
  abyssal_triglavian_striking_vila_damavik: {
    typeID: 48256,
    displayName: "Striking Vila Damavik",
    groupID: 1982,
    factionID: 500026,
    damageType: "thermal_explosive",
    source: "EXISTING_RETAIL_CAPTURED_EVEJS_PROFILE",
  },
  abyssal_triglavian_striking_damavik: {
    typeID: 48092,
    displayName: "Striking Damavik",
    groupID: 1982,
    factionID: 500026,
    damageType: "thermal_explosive",
    source: "EXISTING_RETAIL_CAPTURED_EVEJS_PROFILE",
  },
});

function npcEntry(npcEntryID, npcProfileKey, role, overrides = {}) {
  return {
    npcEntryID,
    npcProfileKey,
    role,
    minimumCount: 1,
    maximumCount: 1,
    required: true,
    objectiveRelevant: true,
    ...overrides,
  };
}

function encounter(encounterProfileID, encounterName, roomIndex, spawnRadiusMeters, spawnJitterMeters, npcEntries) {
  return {
    encounterProfileID,
    encounterName,
    tier: 0,
    eligibleRoomIndexes: [roomIndex],
    factionTheme: T0_DARK_ENCOUNTER_THEME,
    encounterTheme: T0_DARK_ENCOUNTER_THEME,
    weight: 1,
    spawnRadiusMeters,
    spawnJitterMeters,
    npcEntries,
  };
}

const T0_DARK_ENCOUNTER_VARIANT_SPECS = deepFreeze([
  encounter(
    "abyssal:tier0:drone-escorted-vila-scout",
    "Tier 0 Drone-Escorted Vila Scout",
    1,
    9_000,
    1_500,
    [
      npcEntry("needle_escort", "abyssal_rogue_drone_sparkneedle", "needle_escort", {
        npcProfileKeyChoices: [
          "abyssal_rogue_drone_sparkneedle",
          "abyssal_rogue_drone_blastneedle",
        ],
      }),
      npcEntry(
        "striking_vila_scout",
        "abyssal_triglavian_striking_vila_damavik",
        "striking_vila_scout",
      ),
    ],
  ),
  encounter(
    "abyssal:tier0:mixed-needle-patrol",
    "Tier 0 Mixed Needle Patrol",
    2,
    11_000,
    2_000,
    [
      npcEntry("sparkneedle", "abyssal_rogue_drone_sparkneedle", "sparkneedle_support"),
      npcEntry("blastneedle", "abyssal_rogue_drone_blastneedle", "blastneedle_support"),
      npcEntry(
        "striking_vila",
        "abyssal_triglavian_striking_vila_damavik",
        "striking_vila_scout",
      ),
    ],
  ),
  encounter(
    "abyssal:tier0:drone-escorted-striking-guard",
    "Tier 0 Drone-Escorted Striking Guard",
    3,
    12_000,
    2_000,
    [
      npcEntry("sparkneedle", "abyssal_rogue_drone_sparkneedle", "sparkneedle_support"),
      npcEntry("blastneedle", "abyssal_rogue_drone_blastneedle", "blastneedle_support"),
      npcEntry(
        "striking_vila",
        "abyssal_triglavian_striking_vila_damavik",
        "striking_vila_scout",
      ),
      npcEntry(
        "striking_damavik",
        "abyssal_triglavian_striking_damavik",
        "striking_damavik_guard",
      ),
    ],
  ),
  encounter(
    "abyssal:tier0:ember-vila-screen",
    "Tier 0 Ember Vila Screen",
    1,
    9_500,
    1_500,
    [
      npcEntry("emberneedle", "abyssal_rogue_drone_emberneedle", "thermal_needle"),
      npcEntry(
        "striking_vila",
        "abyssal_triglavian_striking_vila_damavik",
        "vila_scout",
      ),
    ],
  ),
  encounter(
    "abyssal:tier0:strikeneedle-damavik-pair",
    "Tier 0 Strikeneedle Damavik Pair",
    1,
    10_500,
    1_500,
    [
      npcEntry("strikeneedle", "abyssal_rogue_drone_strikeneedle", "kinetic_needle"),
      npcEntry(
        "striking_damavik",
        "abyssal_triglavian_striking_damavik",
        "damavik_guard",
      ),
    ],
  ),
  encounter(
    "abyssal:tier0:ember-strike-vila-patrol",
    "Tier 0 Ember Strike Vila Patrol",
    2,
    11_500,
    2_000,
    [
      npcEntry("emberneedle", "abyssal_rogue_drone_emberneedle", "thermal_support"),
      npcEntry("strikeneedle", "abyssal_rogue_drone_strikeneedle", "kinetic_support"),
      npcEntry(
        "striking_vila",
        "abyssal_triglavian_striking_vila_damavik",
        "vila_primary",
      ),
    ],
  ),
  encounter(
    "abyssal:tier0:spark-ember-damavik-patrol",
    "Tier 0 Spark Ember Damavik Patrol",
    2,
    12_000,
    2_000,
    [
      npcEntry("sparkneedle", "abyssal_rogue_drone_sparkneedle", "em_support"),
      npcEntry("emberneedle", "abyssal_rogue_drone_emberneedle", "thermal_support"),
      npcEntry(
        "striking_damavik",
        "abyssal_triglavian_striking_damavik",
        "damavik_primary",
      ),
    ],
  ),
  encounter(
    "abyssal:tier0:three-needle-damavik-guard",
    "Tier 0 Three-Needle Damavik Guard",
    3,
    12_500,
    2_200,
    [
      npcEntry("sparkneedle", "abyssal_rogue_drone_sparkneedle", "em_needle"),
      npcEntry("emberneedle", "abyssal_rogue_drone_emberneedle", "thermal_needle"),
      npcEntry("strikeneedle", "abyssal_rogue_drone_strikeneedle", "kinetic_needle"),
      npcEntry(
        "striking_damavik",
        "abyssal_triglavian_striking_damavik",
        "damavik_guard",
      ),
    ],
  ),
  encounter(
    "abyssal:tier0:ember-strike-double-triglavian-guard",
    "Tier 0 Ember Strike Double Triglavian Guard",
    3,
    13_000,
    2_000,
    [
      npcEntry("emberneedle", "abyssal_rogue_drone_emberneedle", "thermal_needle"),
      npcEntry("strikeneedle", "abyssal_rogue_drone_strikeneedle", "kinetic_needle"),
      npcEntry(
        "striking_vila",
        "abyssal_triglavian_striking_vila_damavik",
        "vila_support",
      ),
      npcEntry(
        "striking_damavik",
        "abyssal_triglavian_striking_damavik",
        "damavik_primary",
      ),
    ],
  ),
]);

function listNpcProfileKeys(entry) {
  const choices = Array.isArray(entry && entry.npcProfileKeyChoices)
    ? entry.npcProfileKeyChoices
    : [];
  return choices.length > 0 ? choices : [entry && entry.npcProfileKey].filter(Boolean);
}

function validateT0DarkEncounterVariantSpecs() {
  const errors = [];
  const profileIDs = new Set();
  for (const [index, profile] of T0_DARK_ENCOUNTER_VARIANT_SPECS.entries()) {
    if (!profile.encounterProfileID || profileIDs.has(profile.encounterProfileID)) {
      errors.push(`profile ${index + 1}: missing or duplicate profile ID`);
    }
    profileIDs.add(profile.encounterProfileID);
    const roomIndex = Number(profile.eligibleRoomIndexes && profile.eligibleRoomIndexes[0]);
    if (![1, 2, 3].includes(roomIndex)) errors.push(`${profile.encounterProfileID}: invalid room`);
    const entries = Array.isArray(profile.npcEntries) ? profile.npcEntries : [];
    let droneCount = 0;
    let triglavianCount = 0;
    for (const entry of entries) {
      for (const profileKey of listNpcProfileKeys(entry)) {
        const reference = T0_DARK_APPROVED_NPC_REFERENCES[profileKey];
        if (!reference) {
          errors.push(`${profile.encounterProfileID}: unsupported NPC profile ${profileKey}`);
          continue;
        }
        if (reference.groupID === 1997) droneCount += 1;
        if (reference.groupID === 1982) triglavianCount += 1;
      }
    }
    if (droneCount <= 0 || triglavianCount <= 0) {
      errors.push(`${profile.encounterProfileID}: composition must mix drones and Triglavian ships`);
    }
    const expectedNpcCount = roomIndex + 1;
    if (entries.length !== expectedNpcCount) {
      errors.push(`${profile.encounterProfileID}: expected ${expectedNpcCount} NPC entries`);
    }
  }
  const perRoomCounts = [1, 2, 3].map((roomIndex) =>
    T0_DARK_ENCOUNTER_VARIANT_SPECS.filter(
      (profile) => profile.eligibleRoomIndexes.includes(roomIndex),
    ).length,
  );
  if (perRoomCounts.some((count) => count !== 3)) {
    errors.push(`expected three encounter variants per room; got ${perRoomCounts.join("/")}`);
  }
  return { valid: errors.length === 0, errors };
}

function listT0DarkEncounterVariantSpecs() {
  return cloneValue(T0_DARK_ENCOUNTER_VARIANT_SPECS);
}

module.exports = {
  T0_DARK_ENCOUNTER_THEME,
  T0_DARK_APPROVED_NPC_REFERENCES,
  T0_DARK_ENCOUNTER_VARIANT_SPECS,
  listT0DarkEncounterVariantSpecs,
  validateT0DarkEncounterVariantSpecs,
};
