"use strict";

const path = require("path");

const {
  resolveItemByName,
  resolveItemByTypeID,
} = require(path.join(__dirname, "../../../services/inventory/itemTypeRegistry"));
const {
  getAttributeIDByNames,
  getTypeAttributeMap,
  getTypeEffectRecords,
} = require(path.join(__dirname, "../../../services/fitting/liveFittingState"));

const {
  cloneValue,
} = require("../../../abyssal").engineSupport.valueUtils;

const OBSERVED_ABYSSAL_NPC_SPAWN_CATALOG = require("../../../abyssal").engineSupport.npcSpawnTables;

const {
  NPC_RUNTIME_CAPABILITY,
} = require(path.join(__dirname, "../npcSdeCapabilityResolver"));
const {
  auditNpcRuntimeSupport,
} = require(path.join(__dirname, "../npcRuntimeCapabilityAudit"));

const RETAIL_EMPTY_NPC_ENTITY_LOADOUT_ID =
  "retail_empty_npc_entity_loadout";
const ABYSSAL_PENDING_LOOT_TABLE_ID =
  "parity_abyssal_entities_pending_loot";
const CATEGORY_ENTITY = 11;
const FACTION_ROGUE_DRONES = 500025;
const FACTION_TRIGLAVIAN_COLLECTIVE = 500026;
const FACTION_ANGEL_CARTEL = 500011;

const ABYSSAL_NPC_CAPABILITY = NPC_RUNTIME_CAPABILITY;

const KNOWN_ABYSSAL_NPC_CAPABILITIES = new Set(
  Object.values(ABYSSAL_NPC_CAPABILITY),
);
const ABYSSAL_EWAR_CAPABILITIES = new Set([
  ABYSSAL_NPC_CAPABILITY.STASIS_WEBIFIER,
  ABYSSAL_NPC_CAPABILITY.ENERGY_NEUTRALIZER,
  ABYSSAL_NPC_CAPABILITY.ENERGY_NOSFERATU,
  ABYSSAL_NPC_CAPABILITY.WARP_SCRAMBLER,
  ABYSSAL_NPC_CAPABILITY.WARP_DISRUPTOR,
  ABYSSAL_NPC_CAPABILITY.TARGET_PAINTER,
  ABYSSAL_NPC_CAPABILITY.SENSOR_DAMPENER,
  ABYSSAL_NPC_CAPABILITY.TRACKING_DISRUPTOR,
  ABYSSAL_NPC_CAPABILITY.GUIDANCE_DISRUPTOR,
  ABYSSAL_NPC_CAPABILITY.ECM_JAMMER,
  ABYSSAL_NPC_CAPABILITY.ECM_BURST_JAMMER,
]);
const EXPLICIT_ABYSSAL_TIER1_SAFE_NPC_TYPES = Object.freeze({
  abyssal_rogue_drone_sparkneedle: Object.freeze({
    profileID: "abyssal_rogue_drone_sparkneedle",
    displayName: "Sparkneedle Tessella",
    typeID: 47847,
    groupID: 1997,
    factionID: FACTION_ROGUE_DRONES,
    factionTheme: "rogue_drone",
    sizeClass: "frigate",
    combatRole: "em_short_range_drone",
    verifiedDamageType: "em",
    supportBehavior: "",
    baseProfileID: "parity_abyssal_entities_47847_sparkneedle_tessella",
    behaviorProfileID: "retail_abyssal_entities_47847_sparkneedle_tessella",
    spawnDistanceMeters: 5_000,
    tierEligibility: [0, 1],
  }),
  abyssal_rogue_drone_emberneedle: Object.freeze({
    profileID: "abyssal_rogue_drone_emberneedle",
    displayName: "Emberneedle Tessella",
    typeID: 47848,
    groupID: 1997,
    factionID: FACTION_ROGUE_DRONES,
    factionTheme: "rogue_drone",
    sizeClass: "frigate",
    combatRole: "thermal_short_range_drone",
    verifiedDamageType: "thermal",
    supportBehavior: "",
    baseProfileID: "parity_abyssal_entities_47848_emberneedle_tessella",
    behaviorProfileID: "retail_abyssal_entities_47848_emberneedle_tessella",
    spawnDistanceMeters: 5_000,
    tierEligibility: [0, 1],
  }),
  abyssal_rogue_drone_strikeneedle: Object.freeze({
    profileID: "abyssal_rogue_drone_strikeneedle",
    displayName: "Strikeneedle Tessella",
    typeID: 47849,
    groupID: 1997,
    factionID: FACTION_ROGUE_DRONES,
    factionTheme: "rogue_drone",
    sizeClass: "frigate",
    combatRole: "kinetic_short_range_drone",
    verifiedDamageType: "kinetic",
    supportBehavior: "",
    baseProfileID: "parity_abyssal_entities_47849_strikeneedle_tessella",
    behaviorProfileID: "retail_abyssal_entities_47849_strikeneedle_tessella",
    spawnDistanceMeters: 5_000,
    tierEligibility: [0, 1],
  }),
  abyssal_rogue_drone_blastneedle: Object.freeze({
    profileID: "abyssal_rogue_drone_blastneedle",
    displayName: "Blastneedle Tessella",
    typeID: 47855,
    groupID: 1997,
    factionID: FACTION_ROGUE_DRONES,
    factionTheme: "rogue_drone",
    sizeClass: "frigate",
    combatRole: "explosive_close_range_drone",
    verifiedDamageType: "explosive",
    supportBehavior: "",
    baseProfileID: "parity_abyssal_entities_47855_blastneedle_tessella",
    behaviorProfileID: "retail_abyssal_entities_47855_blastneedle_tessella",
    spawnDistanceMeters: 5_000,
    tierEligibility: [0, 1],
  }),
  abyssal_triglavian_striking_vila_damavik: Object.freeze({
    profileID: "abyssal_triglavian_striking_vila_damavik",
    displayName: "Striking Vila Damavik",
    typeID: 48256,
    groupID: 1982,
    factionID: FACTION_TRIGLAVIAN_COLLECTIVE,
    factionTheme: "triglavian",
    sizeClass: "frigate",
    combatRole: "single_disintegrator_scout",
    verifiedDamageType: "thermal_explosive",
    supportBehavior: "",
    baseProfileID: "parity_abyssal_entities_48256_striking_vila_damavik",
    behaviorProfileID: "retail_abyssal_entities_48256_striking_vila_damavik",
    spawnDistanceMeters: 5_000,
    tierEligibility: [0, 1],
  }),
  abyssal_triglavian_striking_damavik: Object.freeze({
    profileID: "abyssal_triglavian_striking_damavik",
    displayName: "Striking Damavik",
    typeID: 48092,
    groupID: 1982,
    factionID: FACTION_TRIGLAVIAN_COLLECTIVE,
    factionTheme: "triglavian",
    sizeClass: "frigate",
    combatRole: "single_disintegrator_guard",
    verifiedDamageType: "thermal_explosive",
    supportBehavior: "",
    baseProfileID: "parity_abyssal_entities_48092_striking_damavik",
    behaviorProfileID: "retail_abyssal_entities_48092_striking_damavik",
    spawnDistanceMeters: 5_000,
    tierEligibility: [0, 1],
  }),
  abyssal_rogue_drone_sparklance: Object.freeze({
    profileID: "abyssal_rogue_drone_sparklance",
    displayName: "Sparklance Tessella",
    typeID: 47856,
    groupID: 1997,
    factionID: FACTION_ROGUE_DRONES,
    factionTheme: "rogue_drone",
    sizeClass: "frigate",
    combatRole: "em_lance_drone",
    verifiedDamageType: "em",
    supportBehavior: "",
    baseProfileID: "parity_abyssal_entities_47856_sparklance_tessella",
    behaviorProfileID: "retail_abyssal_entities_47856_sparklance_tessella",
    spawnDistanceMeters: 5_500,
    tierEligibility: [0, 2, 3, 4, 5, 6],
  }),
  abyssal_rogue_drone_emberlance: Object.freeze({
    profileID: "abyssal_rogue_drone_emberlance",
    displayName: "Emberlance Tessella",
    typeID: 47857,
    groupID: 1997,
    factionID: FACTION_ROGUE_DRONES,
    factionTheme: "rogue_drone",
    sizeClass: "frigate",
    combatRole: "thermal_lance_drone",
    verifiedDamageType: "thermal",
    supportBehavior: "",
    baseProfileID: "parity_abyssal_entities_47857_emberlance_tessella",
    behaviorProfileID: "retail_abyssal_entities_47857_emberlance_tessella",
    spawnDistanceMeters: 5_500,
    tierEligibility: [0, 2, 3, 4, 5, 6],
  }),
  abyssal_rogue_drone_strikelance: Object.freeze({
    profileID: "abyssal_rogue_drone_strikelance",
    displayName: "Strikelance Tessella",
    typeID: 47858,
    groupID: 1997,
    factionID: FACTION_ROGUE_DRONES,
    factionTheme: "rogue_drone",
    sizeClass: "frigate",
    combatRole: "kinetic_lance_drone",
    verifiedDamageType: "kinetic",
    supportBehavior: "",
    baseProfileID: "parity_abyssal_entities_47858_strikelance_tessella",
    behaviorProfileID: "retail_abyssal_entities_47858_strikelance_tessella",
    spawnDistanceMeters: 5_500,
    tierEligibility: [0, 2, 3, 4, 5, 6],
  }),
  abyssal_rogue_drone_blastlance: Object.freeze({
    profileID: "abyssal_rogue_drone_blastlance",
    displayName: "Blastlance Tessella",
    typeID: 47859,
    groupID: 1997,
    factionID: FACTION_ROGUE_DRONES,
    factionTheme: "rogue_drone",
    sizeClass: "frigate",
    combatRole: "explosive_lance_drone",
    verifiedDamageType: "explosive",
    supportBehavior: "",
    baseProfileID: "parity_abyssal_entities_47859_blastlance_tessella",
    behaviorProfileID: "retail_abyssal_entities_47859_blastlance_tessella",
    spawnDistanceMeters: 5_500,
    tierEligibility: [0, 2, 3, 4, 5, 6],
  }),
  abyssal_triglavian_ephialtes_lancer: Object.freeze({
    profileID: "abyssal_triglavian_ephialtes_lancer",
    displayName: "Ephialtes Lancer",
    typeID: 48234,
    groupID: 1982,
    factionID: FACTION_TRIGLAVIAN_COLLECTIVE,
    factionTheme: "triglavian",
    sizeClass: "frigate",
    combatRole: "missile_lancer",
    verifiedDamageType: "mixed_missile",
    supportBehavior: "",
    baseProfileID: "parity_abyssal_entities_48234_ephialtes_lancer",
    behaviorProfileID: "retail_abyssal_entities_48234_ephialtes_lancer",
    spawnDistanceMeters: 6_000,
    tierEligibility: [0, 1, 2, 3, 4, 5, 6],
  }),
  abyssal_triglavian_attacker_pacifier: Object.freeze({
    profileID: "abyssal_triglavian_attacker_pacifier",
    displayName: "Attacker Pacifier Disparu Troop",
    typeID: 56170,
    groupID: 1982,
    factionID: FACTION_TRIGLAVIAN_COLLECTIVE,
    factionTheme: "triglavian",
    sizeClass: "frigate",
    combatRole: "missile_attacker",
    verifiedDamageType: "mixed_missile",
    supportBehavior: "",
    baseProfileID: "parity_abyssal_entities_56170_attacker_pacifier_disparu_troop",
    behaviorProfileID: "retail_abyssal_entities_56170_attacker_pacifier_disparu_troop",
    spawnDistanceMeters: 6_000,
    tierEligibility: [0, 2, 3, 4, 5, 6],
  }),
  abyssal_triglavian_striking_kikimora: Object.freeze({
    profileID: "abyssal_triglavian_striking_kikimora",
    displayName: "Striking Kikimora",
    typeID: 56150,
    groupID: 1982,
    factionID: FACTION_TRIGLAVIAN_COLLECTIVE,
    factionTheme: "triglavian",
    sizeClass: "frigate",
    combatRole: "single_disintegrator_support",
    verifiedDamageType: "thermal_explosive",
    supportBehavior: "remote_armor_repair",
    baseProfileID: "parity_abyssal_entities_56150_striking_kikimora",
    behaviorProfileID: "retail_abyssal_entities_56150_striking_kikimora",
    spawnDistanceMeters: 6_000,
    tierEligibility: [2, 3, 4, 5, 6],
  }),
  abyssal_triglavian_devoted_hunter: Object.freeze({
    profileID: "abyssal_triglavian_devoted_hunter",
    displayName: "Devoted Hunter",
    typeID: 56138,
    groupID: 1982,
    factionID: FACTION_TRIGLAVIAN_COLLECTIVE,
    factionTheme: "triglavian",
    sizeClass: "frigate",
    combatRole: "observed_direct_weapon_hunter",
    verifiedDamageType: "",
    supportBehavior: "",
    baseProfileID: "parity_abyssal_entities_56138_devoted_hunter",
    behaviorProfileID: "retail_abyssal_entities_56138_devoted_hunter",
    spawnDistanceMeters: 6_000,
    tierEligibility: [0],
    safetyNotes: [
      "Tier 0 eligibility comes from the abyssal.space telemetry sample.",
      "Native SDE combat is enabled; retail-exact tactics and damage balance are not claimed.",
    ],
  }),
  abyssal_rogue_drone_embergrip: Object.freeze({
    profileID: "abyssal_rogue_drone_embergrip",
    displayName: "Embergrip Tessera",
    typeID: 48263,
    groupID: 1997,
    factionID: FACTION_ROGUE_DRONES,
    factionTheme: "rogue_drone",
    sizeClass: "frigate",
    combatRole: "observed_direct_weapon_drone",
    verifiedDamageType: "",
    supportBehavior: "",
    baseProfileID: "parity_abyssal_entities_48263_embergrip_tessera",
    behaviorProfileID: "retail_abyssal_entities_48263_embergrip_tessera",
    spawnDistanceMeters: 5_500,
    tierEligibility: [0],
    safetyNotes: [
      "Tier 0 eligibility comes from the abyssal.space telemetry sample.",
    ],
  }),
  abyssal_triglavian_hadal_overmind: Object.freeze({
    profileID: "abyssal_triglavian_hadal_overmind",
    displayName: "Hadal Abyssal Overmind",
    typeID: 47879,
    groupID: 1982,
    factionID: FACTION_TRIGLAVIAN_COLLECTIVE,
    factionTheme: "triglavian",
    sizeClass: "frigate",
    combatRole: "observed_direct_weapon_overmind",
    verifiedDamageType: "",
    supportBehavior: "",
    baseProfileID: "parity_abyssal_entities_47879_hadal_abyssal_overmind",
    behaviorProfileID: "retail_abyssal_entities_47879_hadal_abyssal_overmind",
    spawnDistanceMeters: 7_000,
    tierEligibility: [0],
    safetyNotes: [
      "The Benthic webifier variant remains gated; this profile covers only the locally validated Hadal type.",
    ],
  }),
  abyssal_triglavian_lucid_aegis: Object.freeze({
    profileID: "abyssal_triglavian_lucid_aegis",
    displayName: "Lucid Aegis",
    typeID: 48245,
    groupID: 1982,
    factionID: FACTION_TRIGLAVIAN_COLLECTIVE,
    factionTheme: "triglavian",
    sizeClass: "frigate",
    combatRole: "direct_weapon_local_and_remote_armor_support",
    verifiedDamageType: "",
    supportBehavior: "remote_armor_repair",
    capabilities: Object.freeze([
      ABYSSAL_NPC_CAPABILITY.DIRECT_WEAPON,
      ABYSSAL_NPC_CAPABILITY.LOCAL_ARMOR_REPAIR,
      ABYSSAL_NPC_CAPABILITY.REMOTE_ARMOR_REPAIR,
    ]),
    capabilityData: Object.freeze({
      local_armor_repair: {
        amount: 30,
        durationMs: 5_000,
        capacitorNeed: 0,
        provenance: "sde_dogma",
      },
      remote_armor_repair: {
        amount: 15,
        durationMs: 7_000,
        rangeMeters: 40_000,
        falloffMeters: 20_000,
        capacitorNeed: 0,
        provenance: "sde_dogma",
      },
    }),
    behaviorOverrides: Object.freeze({
      orbitDistanceMeters: 8_000,
    }),
    baseProfileID: "parity_abyssal_entities_48245_lucid_aegis",
    behaviorProfileID: "retail_abyssal_entities_48245_lucid_aegis",
    spawnDistanceMeters: 6_500,
    tierEligibility: [0, 1],
    safetyNotes: [
      "Direct weapons plus SDE local and remote armor-repair cycles use the generic native-NPC module runtime.",
    ],
  }),
  abyssal_triglavian_lucid_escort: Object.freeze({
    profileID: "abyssal_triglavian_lucid_escort",
    displayName: "Lucid Escort",
    typeID: 48241,
    groupID: 1982,
    factionID: FACTION_TRIGLAVIAN_COLLECTIVE,
    factionTheme: "triglavian",
    sizeClass: "frigate",
    combatRole: "direct_weapon_local_and_remote_armor_support",
    verifiedDamageType: "",
    supportBehavior: "remote_armor_repair",
    capabilities: Object.freeze([
      ABYSSAL_NPC_CAPABILITY.DIRECT_WEAPON,
      ABYSSAL_NPC_CAPABILITY.LOCAL_ARMOR_REPAIR,
      ABYSSAL_NPC_CAPABILITY.REMOTE_ARMOR_REPAIR,
    ]),
    capabilityData: Object.freeze({
      local_armor_repair: {
        amount: 20,
        durationMs: 5_000,
        capacitorNeed: 0,
        provenance: "sde_dogma",
      },
      remote_armor_repair: {
        amount: 15,
        durationMs: 7_000,
        rangeMeters: 40_000,
        falloffMeters: 20_000,
        capacitorNeed: 0,
        provenance: "sde_dogma",
      },
    }),
    behaviorOverrides: Object.freeze({
      orbitDistanceMeters: 8_000,
    }),
    baseProfileID: "parity_abyssal_entities_48241_lucid_escort",
    behaviorProfileID: "retail_abyssal_entities_48241_lucid_escort",
    spawnDistanceMeters: 6_500,
    tierEligibility: [0, 1],
    safetyNotes: [
      "Direct weapons plus SDE local and remote armor-repair cycles use the generic native-NPC module runtime.",
    ],
  }),
  abyssal_rogue_drone_vila_swarmer: Object.freeze({
    profileID: "abyssal_rogue_drone_vila_swarmer",
    displayName: "Vila Swarmer",
    typeID: 48253,
    groupID: 1997,
    factionID: FACTION_ROGUE_DRONES,
    factionTheme: "rogue_drone",
    sizeClass: "frigate",
    combatRole: "controller_dependant_direct_weapon_swarmer",
    verifiedDamageType: "mixed",
    supportBehavior: "",
    capabilities: Object.freeze([
      ABYSSAL_NPC_CAPABILITY.DIRECT_WEAPON,
    ]),
    capabilityData: Object.freeze({
      direct_weapon: {
        cycleTimeMs: 2_000,
        rangeMeters: 3_000,
        falloffMeters: 3_000,
        damage: {
          em: 4,
          thermal: 4,
          kinetic: 4,
          explosive: 4,
        },
        provenance: "sde_dogma",
      },
    }),
    behaviorOverrides: Object.freeze({
      orbitDistanceMeters: 2_500,
    }),
    baseProfileID: "parity_abyssal_entities_48253_vila_swarmer",
    behaviorProfileID: "retail_abyssal_entities_48253_vila_swarmer",
    spawnDistanceMeters: 3_000,
    tierEligibility: [1],
    safetyNotes: [
      "The generic controller/dependant lifecycle can stop offense while leaving the Swarmer present, targetable, and destructible.",
    ],
  }),
  abyssal_triglavian_lucifer_burst: Object.freeze({
    profileID: "abyssal_triglavian_lucifer_burst",
    displayName: "Lucifer Burst",
    typeID: 56351,
    groupID: 1982,
    factionID: FACTION_TRIGLAVIAN_COLLECTIVE,
    factionTheme: "triglavian",
    sizeClass: "frigate",
    combatRole: "observed_zero_damage_target_shell",
    verifiedDamageType: "",
    supportBehavior: "remote_shield_boost",
    capabilities: Object.freeze([
      ABYSSAL_NPC_CAPABILITY.LOCAL_SHIELD_BOOST,
      ABYSSAL_NPC_CAPABILITY.REMOTE_SHIELD_REPAIR,
    ]),
    allowMissingDirectWeapon: true,
    baseProfileID: "parity_zero_damage_target_shell_entities_56351_lucifer_burst",
    behaviorProfileID: "retail_zero_damage_target_shell_entities_56351_lucifer_burst",
    spawnDistanceMeters: 6_500,
    tierEligibility: [0],
    safetyNotes: [
      "The local retail behavior profile is a zero-damage target shell; no damaging behavior is claimed.",
    ],
  }),
  abyssal_triglavian_lucifer_dramiel: Object.freeze({
    profileID: "abyssal_triglavian_lucifer_dramiel",
    displayName: "Lucifer Dramiel",
    typeID: 56346,
    groupID: 1982,
    factionID: FACTION_TRIGLAVIAN_COLLECTIVE,
    factionTheme: "triglavian",
    sizeClass: "frigate",
    combatRole: "observed_direct_weapon_dramiel",
    verifiedDamageType: "",
    supportBehavior: "",
    capabilities: Object.freeze([
      ABYSSAL_NPC_CAPABILITY.DIRECT_WEAPON,
      ABYSSAL_NPC_CAPABILITY.LOCAL_SHIELD_BOOST,
    ]),
    capabilityData: Object.freeze({
      local_shield_boost: {
        amount: 35,
        durationMs: 5_000,
        capacitorNeed: 20,
        provenance: "sde_dogma",
      },
    }),
    behaviorOverrides: Object.freeze({
      orbitDistanceMeters: 6_000,
    }),
    baseProfileID: "parity_abyssal_entities_56346_lucifer_dramiel",
    behaviorProfileID: "retail_abyssal_entities_56346_lucifer_dramiel",
    spawnDistanceMeters: 7_000,
    tierEligibility: [0, 1],
    safetyNotes: [
      "Only the direct weapon and local shield boost found on this exact type are enabled; no EWAR is invented by family name.",
    ],
  }),
  abyssal_triglavian_lucifer_cynabal: Object.freeze({
    profileID: "abyssal_triglavian_lucifer_cynabal",
    displayName: "Lucifer Cynabal",
    typeID: 56295,
    groupID: 1982,
    factionID: FACTION_TRIGLAVIAN_COLLECTIVE,
    factionTheme: "triglavian",
    sizeClass: "frigate",
    combatRole: "direct_weapon_web_neutralizer_shield",
    verifiedDamageType: "",
    supportBehavior: "",
    capabilities: Object.freeze([
      ABYSSAL_NPC_CAPABILITY.DIRECT_WEAPON,
      ABYSSAL_NPC_CAPABILITY.LOCAL_SHIELD_BOOST,
      ABYSSAL_NPC_CAPABILITY.STASIS_WEBIFIER,
      ABYSSAL_NPC_CAPABILITY.ENERGY_NEUTRALIZER,
    ]),
    capabilityData: Object.freeze({
      local_shield_boost: {
        amount: 135,
        durationMs: 9_000,
        capacitorNeed: 40,
        provenance: "sde_dogma",
      },
      stasis_webifier: {
        strength: -40,
        durationMs: 5_000,
        rangeMeters: 13_000,
        falloffMeters: 0,
        provenance: "sde_dogma",
        provisional: false,
      },
      energy_neutralizer: {
        amount: 50,
        durationMs: 10_000,
        rangeMeters: 9_000,
        falloffMeters: 10_000,
        provenance: "sde_dogma",
      },
    }),
    behaviorOverrides: Object.freeze({
      orbitDistanceMeters: 8_000,
    }),
    baseProfileID: "parity_abyssal_entities_56295_lucifer_cynabal",
    behaviorProfileID: "retail_abyssal_entities_56295_lucifer_cynabal",
    spawnDistanceMeters: 8_000,
    tierEligibility: [1],
    allowRetailEwar: true,
    safetyNotes: [
      "Legacy/general encounter eligibility for the exact retail-authored web and neutralizer capabilities remains Tier 1 only during migration; wider live use is admitted only by the checked-in QSNA procedural ruleset, and the shared audit continues to classify them as offensive EWAR.",
    ],
  }),
  abyssal_triglavian_lucifer_fury: Object.freeze({
    profileID: "abyssal_triglavian_lucifer_fury",
    displayName: "Lucifer Fury",
    typeID: 56348,
    groupID: 1982,
    factionID: FACTION_TRIGLAVIAN_COLLECTIVE,
    factionTheme: "triglavian",
    sizeClass: "frigate",
    combatRole: "direct_weapon_neutralizer_shield",
    verifiedDamageType: "",
    supportBehavior: "",
    capabilities: Object.freeze([
      ABYSSAL_NPC_CAPABILITY.DIRECT_WEAPON,
      ABYSSAL_NPC_CAPABILITY.LOCAL_SHIELD_BOOST,
      ABYSSAL_NPC_CAPABILITY.ENERGY_NEUTRALIZER,
    ]),
    capabilityData: Object.freeze({
      local_shield_boost: {
        amount: 35,
        durationMs: 5_000,
        capacitorNeed: 20,
        provenance: "sde_dogma",
      },
      energy_neutralizer: {
        amount: 10,
        durationMs: 5_000,
        rangeMeters: 8_000,
        falloffMeters: 6_000,
        provenance: "sde_dogma",
      },
    }),
    behaviorOverrides: Object.freeze({
      orbitDistanceMeters: 8_000,
    }),
    baseProfileID: "parity_abyssal_entities_56348_lucifer_fury",
    behaviorProfileID: "retail_abyssal_entities_56348_lucifer_fury",
    spawnDistanceMeters: 8_000,
    tierEligibility: [1],
    allowRetailEwar: true,
    safetyNotes: [
      "Legacy/general encounter eligibility for the exact retail-authored neutralizer capability remains Tier 1 only during migration; wider live use is admitted only by the checked-in QSNA procedural ruleset, and the shared audit continues to classify it as offensive EWAR.",
    ],
  }),
  abyssal_triglavian_lucifer_echo: Object.freeze({
    profileID: "abyssal_triglavian_lucifer_echo",
    displayName: "Lucifer Echo",
    typeID: 56349,
    groupID: 1982,
    factionID: FACTION_TRIGLAVIAN_COLLECTIVE,
    factionTheme: "triglavian",
    sizeClass: "frigate",
    combatRole: "direct_weapon_web_scramble_shield",
    verifiedDamageType: "",
    supportBehavior: "",
    capabilities: Object.freeze([
      ABYSSAL_NPC_CAPABILITY.DIRECT_WEAPON,
      ABYSSAL_NPC_CAPABILITY.LOCAL_SHIELD_BOOST,
      ABYSSAL_NPC_CAPABILITY.STASIS_WEBIFIER,
      ABYSSAL_NPC_CAPABILITY.WARP_SCRAMBLER,
    ]),
    capabilityData: Object.freeze({
      local_shield_boost: {
        amount: 35,
        durationMs: 5_000,
        capacitorNeed: 20,
        provenance: "sde_dogma",
      },
      stasis_webifier: {
        strength: -40,
        durationMs: 5_000,
        rangeMeters: 12_000,
        falloffMeters: 0,
        provenance: "sde_dogma",
        provisional: false,
      },
      warp_scrambler: {
        strength: 2,
        durationMs: 5_000,
        rangeMeters: 11_250,
        falloffMeters: 0,
        provenance: "sde_dogma",
      },
    }),
    behaviorOverrides: Object.freeze({
      orbitDistanceMeters: 4_000,
    }),
    baseProfileID: "parity_abyssal_entities_56349_lucifer_echo",
    behaviorProfileID: "retail_abyssal_entities_56349_lucifer_echo",
    spawnDistanceMeters: 6_000,
    tierEligibility: [1],
    allowRetailEwar: true,
    safetyNotes: [
      "Legacy/general encounter eligibility for the exact retail-authored web and scrambler capabilities remains Tier 1 only during migration; wider live use is admitted only by the checked-in QSNA procedural ruleset, and the shared audit continues to classify them as offensive EWAR.",
    ],
  }),
  abyssal_triglavian_skybreaker_disparu: Object.freeze({
    profileID: "abyssal_triglavian_skybreaker_disparu",
    displayName: "Skybreaker Disparu Troop",
    typeID: 56188,
    groupID: 1982,
    factionID: FACTION_TRIGLAVIAN_COLLECTIVE,
    factionTheme: "triglavian",
    sizeClass: "frigate",
    combatRole: "observed_direct_weapon_disparu",
    verifiedDamageType: "",
    supportBehavior: "",
    capabilities: Object.freeze([
      ABYSSAL_NPC_CAPABILITY.CHAIN_LIGHTNING,
      ABYSSAL_NPC_CAPABILITY.LOCAL_SHIELD_BOOST,
    ]),
    baseProfileID: "parity_abyssal_entities_56188_skybreaker_disparu_troop",
    behaviorProfileID: "retail_abyssal_entities_56188_skybreaker_disparu_troop",
    spawnDistanceMeters: 7_000,
    tierEligibility: [0],
    safetyNotes: [
      "Tier 0 eligibility comes from the abyssal.space telemetry sample.",
    ],
  }),
});

function normalizeObservedNpcName(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function slugifyObservedNpcName(value) {
  return normalizeObservedNpcName(value).replace(/\s+/g, "_");
}

function listObservedAbyssalNpcNameRecords() {
  const tiersByTypeID = new Map();
  const familyMembershipsByTypeID = new Map();
  for (const combination of Object.values(
    OBSERVED_ABYSSAL_NPC_SPAWN_CATALOG.combinations || {},
  )) {
    const tier = toInt(combination && combination.tier, -1);
    for (const family of Array.isArray(combination && combination.spawnFamilies)
      ? combination.spawnFamilies
      : []) {
      for (const npc of Array.isArray(family && family.npcs) ? family.npcs : []) {
        const typeID = toInt(npc && npc.typeID, 0);
        if (!tiersByTypeID.has(typeID)) tiersByTypeID.set(typeID, new Set());
        tiersByTypeID.get(typeID).add(tier);
        familyMembershipsByTypeID.set(
          typeID,
          (familyMembershipsByTypeID.get(typeID) || 0) + 1,
        );
      }
    }
  }
  return (Array.isArray(OBSERVED_ABYSSAL_NPC_SPAWN_CATALOG.npcResolutionAudit)
    ? OBSERVED_ABYSSAL_NPC_SPAWN_CATALOG.npcResolutionAudit
    : [])
    .filter((entry) => entry && entry.success === true)
    .map((entry) => ({
      name: String(entry.name || ""),
      sdeName: String(entry.sdeName || ""),
      typeID: toInt(entry.typeID, 0),
      tiers: [...(tiersByTypeID.get(toInt(entry.typeID, 0)) || [])]
        .filter((tier) => tier >= 0 && tier <= 6)
        .sort((left, right) => left - right),
      observedQuantity: 0,
      observedFamilyMembershipCount:
        familyMembershipsByTypeID.get(toInt(entry.typeID, 0)) || 0,
      runtimeEligible: true,
      resolution: String(entry.resolution || ""),
    }));
}

function parseObservedNpcSuggestionTypeIDs(suggestions) {
  const typeIDs = [];
  for (const suggestion of Array.isArray(suggestions) ? suggestions : []) {
    const match = String(suggestion || "").match(/\((\d+)(?:,|\))/);
    const typeID = match ? toInt(match[1], 0) : 0;
    if (typeID > 0 && !typeIDs.includes(typeID)) {
      typeIDs.push(typeID);
    }
  }
  return typeIDs;
}

function resolveObservedAbyssalNpcTypeByName(name, preferredTypeID = 0) {
  const requestedName = String(name || "").trim();
  const preferred = toInt(preferredTypeID, 0);
  if (preferred > 0) {
    const preferredRecord = resolveItemByTypeID(preferred);
    const generatedRecord = listObservedAbyssalNpcNameRecords().find(
      (entry) =>
        normalizeObservedNpcName(entry && entry.name) ===
          normalizeObservedNpcName(requestedName) &&
        toInt(entry && entry.typeID, 0) === preferred,
    );
    if (
      preferredRecord &&
      toInt(preferredRecord.categoryID, 0) === CATEGORY_ENTITY &&
      (
        normalizeObservedNpcName(preferredRecord.name) ===
          normalizeObservedNpcName(requestedName) ||
        Boolean(generatedRecord)
      )
    ) {
      return {
        success: true,
        typeRecord: preferredRecord,
        resolution: generatedRecord
          ? "generated_qsna_type_id"
          : "explicit_profile_type",
        candidateTypeIDs: [preferred],
      };
    }
  }

  const direct = resolveItemByName(requestedName, { exactOnly: true });
  if (
    direct &&
    direct.success === true &&
    direct.match &&
    toInt(direct.match.categoryID, 0) === CATEGORY_ENTITY &&
    normalizeObservedNpcName(direct.match.name) ===
      normalizeObservedNpcName(requestedName)
  ) {
    return {
      success: true,
      typeRecord: direct.match,
      resolution: "exact_name",
      candidateTypeIDs: [toInt(direct.match.typeID, 0)],
    };
  }

  return {
    success: false,
    errorMsg: direct && direct.errorMsg === "AMBIGUOUS_ITEM_NAME"
      ? "OBSERVED_ABYSSAL_NPC_TYPE_AMBIGUOUS"
      : "OBSERVED_ABYSSAL_NPC_TYPE_NOT_FOUND",
    requestedName,
    candidateTypeIDs: parseObservedNpcSuggestionTypeIDs(
      direct && direct.suggestions,
    ),
  };
}

function inferObservedAbyssalNpcFactionID(name, typeRecord = null) {
  const authoredFactionID = toInt(typeRecord && typeRecord.factionID, 0);
  if (authoredFactionID > 0) {
    return authoredFactionID;
  }
  const normalized = normalizeObservedNpcName(name);
  if (/\b(tessella|tessera|overmind)\b/.test(normalized)) {
    return FACTION_ROGUE_DRONES;
  }
  if (/\bdrifter\b/.test(normalized)) {
    return 500024;
  }
  if (/\bdisparu troop\b/.test(normalized)) {
    return 500027;
  }
  return FACTION_TRIGLAVIAN_COLLECTIVE;
}

function inferObservedAbyssalNpcFactionTheme(name, typeRecord = null) {
  const factionID = inferObservedAbyssalNpcFactionID(name, typeRecord);
  if (factionID === FACTION_ROGUE_DRONES) return "rogue_drone";
  if (factionID === 500024) return "drifter";
  if (factionID === 500027) return "edencom";
  if (factionID === FACTION_ANGEL_CARTEL) return "angel";
  if (factionID === FACTION_TRIGLAVIAN_COLLECTIVE) return "triglavian";
  return "abyssal_mixed";
}

function inferObservedAbyssalNpcSizeClass(typeRecord) {
  const radius = Number(typeRecord && typeRecord.radius);
  if (!Number.isFinite(radius) || radius <= 0) {
    return "unknown";
  }
  if (radius < 100) return "frigate";
  if (radius < 300) return "cruiser";
  return "battleship";
}

function inferObservedAbyssalNpcSpawnDistanceMeters(typeID, suppliedAudit = null) {
  const audit = suppliedAudit || auditAbyssalNpcType(typeID);
  const targetingAttributes = audit && audit.targetingAttributes || {};
  const targetRange = Math.max(
    Number(targetingAttributes.maxTargetRange) || 0,
    Number(targetingAttributes.weaponMaxRange) || 0,
  );
  if (!(targetRange > 0)) {
    return 8_000;
  }
  return Math.max(5_000, Math.min(30_000, Math.round(targetRange * 0.6)));
}

function inferObservedAbyssalNpcCombatDistanceMeters(typeID, suppliedAudit = null) {
  const audit = suppliedAudit || auditAbyssalNpcType(typeID);
  const targetingAttributes = audit && audit.targetingAttributes || {};
  const weaponMaxRange = Math.max(
    0,
    Number(targetingAttributes.weaponMaxRange) || 0,
  );
  const hasDirectWeapon = Array.isArray(audit && audit.capabilityIDs) &&
    audit.capabilityIDs.includes(ABYSSAL_NPC_CAPABILITY.DIRECT_WEAPON);
  if (!hasDirectWeapon || !(weaponMaxRange > 0)) {
    return inferObservedAbyssalNpcSpawnDistanceMeters(typeID, audit);
  }
  return Math.max(5_000, Math.min(30_000, Math.round(weaponMaxRange * 0.6)));
}

function buildObservedAbyssalNpcTypeSpecs(explicitSpecs) {
  const explicitByTypeID = new Map(
    Object.values(explicitSpecs || {}).map((spec) => [
      toInt(spec && spec.typeID, 0),
      spec,
    ]),
  );
  const explicitByName = new Map(
    Object.values(explicitSpecs || {}).map((spec) => [
      normalizeObservedNpcName(spec && spec.displayName),
      spec,
    ]),
  );
  const mergedExplicitSpecs = {};
  for (const [profileID, spec] of Object.entries(explicitSpecs || {})) {
    const observedRecord = listObservedAbyssalNpcNameRecords().find(
      (entry) =>
        toInt(entry && entry.typeID, 0) === toInt(spec && spec.typeID, -1),
    );
    const legacyTierEligibility = Object.freeze([
      ...new Set(
        (Array.isArray(spec && spec.tierEligibility)
          ? spec.tierEligibility
          : [])
          .map((tier) => toInt(tier, -1))
          .filter((tier) => tier >= 0 && tier <= 6),
      ),
    ].sort((left, right) => left - right));
    const qsnaTierEligibility = observedRecord
      ? Object.freeze(
        [...new Set(
          (Array.isArray(observedRecord.tiers) ? observedRecord.tiers : [])
            .map((tier) => toInt(tier, -1))
            .filter((tier) => tier >= 0 && tier <= 6),
        )].sort((left, right) => left - right),
      )
      : Object.freeze([]);
    mergedExplicitSpecs[profileID] = Object.freeze({
      ...spec,
      // Preserve the legacy/general field during migration. QSNA eligibility
      // remains separate and is the authority for live procedural selection.
      tierEligibility: legacyTierEligibility,
      qsnaTierEligibility,
      observedSpawnEvidence:
        observedRecord
          ? Object.freeze({
            catalogueID: String(
              OBSERVED_ABYSSAL_NPC_SPAWN_CATALOG.catalogueID || "",
            ),
            observedFamilyMembershipCount: toInt(
              observedRecord.observedFamilyMembershipCount,
              0,
            ),
            observedTiers: Object.freeze(
              (Array.isArray(observedRecord.tiers) ? observedRecord.tiers : [])
                .map((tier) => toInt(tier, -1))
                .filter((tier) => tier >= 0 && tier <= 6)
                .sort((left, right) => left - right),
            ),
          })
          : null,
    });
  }

  const generatedSpecs = {};
  const resolutionAudit = [];
  for (const observedRecord of listObservedAbyssalNpcNameRecords()) {
    const displayName = String(observedRecord && observedRecord.name || "").trim();
    if (!displayName || observedRecord.runtimeEligible !== true) {
      resolutionAudit.push({
        displayName,
        status: "REJECTED_SOURCE_VALUE",
        reason: "NON_NPC_TELEMETRY_PLACEHOLDER",
      });
      continue;
    }
    const explicitSpec = explicitByTypeID.get(
      toInt(observedRecord && observedRecord.typeID, 0),
    ) || explicitByName.get(normalizeObservedNpcName(displayName));
    if (explicitSpec) {
      resolutionAudit.push({
        displayName,
        status: "EXPLICIT_PROFILE",
        profileID: explicitSpec.profileID,
        typeID: toInt(explicitSpec.typeID, 0),
      });
      continue;
    }

    const resolution = resolveObservedAbyssalNpcTypeByName(
      displayName,
      toInt(observedRecord && observedRecord.typeID, 0),
    );
    if (!resolution.success || !resolution.typeRecord) {
      resolutionAudit.push({
        displayName,
        status: "UNRESOLVED",
        reason: resolution.errorMsg || "OBSERVED_ABYSSAL_NPC_TYPE_NOT_FOUND",
        candidateTypeIDs: resolution.candidateTypeIDs || [],
      });
      continue;
    }
    const typeRecord = resolution.typeRecord;
    const typeID = toInt(typeRecord.typeID, 0);
    const authoritativeDisplayName = String(typeRecord.name || "").trim();
    const audit = auditAbyssalNpcType(typeID);
    const capabilityIDs = Object.freeze(
      Array.isArray(audit && audit.capabilityIDs)
        ? [...audit.capabilityIDs]
        : [],
    );
    const profileID =
      `abyssal_observed_${typeID}_${slugifyObservedNpcName(displayName)}`;
    const behaviorProfileID =
      `retail_observed_abyssal_entities_${typeID}_${slugifyObservedNpcName(displayName)}`;
    const candidateSpec = Object.freeze({
      profileID,
      displayName: authoritativeDisplayName,
      sourceObservedName: displayName,
      typeID,
      groupID: toInt(typeRecord.groupID, 0),
      factionID: inferObservedAbyssalNpcFactionID(displayName, typeRecord),
      factionTheme: inferObservedAbyssalNpcFactionTheme(displayName, typeRecord),
      sizeClass: inferObservedAbyssalNpcSizeClass(typeRecord),
      combatRole: "observed_native_dogma",
      verifiedDamageType: "",
      supportBehavior: "",
      capabilities: capabilityIDs,
      baseProfileID:
        `parity_observed_abyssal_entities_${typeID}_${slugifyObservedNpcName(displayName)}`,
      behaviorProfileID,
      spawnDistanceMeters: inferObservedAbyssalNpcSpawnDistanceMeters(typeID, audit),
      combatDistanceMeters: inferObservedAbyssalNpcCombatDistanceMeters(typeID, audit),
      // Generated profiles are QSNA-only. Do not make their observed tiers
      // available through the legacy/general admission path.
      tierEligibility: Object.freeze([]),
      qsnaTierEligibility: Object.freeze(
        (Array.isArray(observedRecord.tiers) ? observedRecord.tiers : [])
          .map((tier) => toInt(tier, -1))
          .filter((tier) => tier >= 0 && tier <= 6)
          .sort((left, right) => left - right),
      ),
      allowRetailEwar: audit && audit.forbiddenEwar === true,
      allowMissingDirectWeapon:
        capabilityIDs.length > 0 &&
        !capabilityIDs.includes(ABYSSAL_NPC_CAPABILITY.DIRECT_WEAPON),
      generatedObservedProfile: true,
      observedTypeResolution: resolution.resolution,
      observedSpawnEvidence: Object.freeze({
        catalogueID: String(
          OBSERVED_ABYSSAL_NPC_SPAWN_CATALOG.catalogueID || "",
        ),
        observedFamilyMembershipCount: toInt(
          observedRecord.observedFamilyMembershipCount,
          0,
        ),
      }),
      safetyNotes: Object.freeze([
        "QSNA procedural eligibility is derived from the checked-in QSNA spawn ruleset.",
        "The exact resolved NPC type and its native dogma are used; no substitute profile is permitted.",
      ]),
    });
    const validation = validateAbyssalTier1SafeNpcType(candidateSpec);
    if (!validation.success) {
      resolutionAudit.push({
        displayName,
        status: "UNSAFE_RUNTIME_PROFILE",
        profileID,
        typeID,
        resolution: resolution.resolution,
        capabilityIDs: [...capabilityIDs],
        reasons: [...validation.errors],
      });
      continue;
    }
    generatedSpecs[profileID] = candidateSpec;
    resolutionAudit.push({
      displayName,
      status: "GENERATED_PROFILE",
      profileID,
      typeID,
      resolution: resolution.resolution,
      capabilityIDs: [...capabilityIDs],
      unsupportedRuntimeModuleFamilies:
        Array.isArray(audit && audit.unsupportedRuntimeModuleFamilies)
          ? audit.unsupportedRuntimeModuleFamilies.map((entry) =>
            String(entry && (entry.family || entry.effectName) || "unknown")
          )
          : [],
    });
  }

  return {
    specs: Object.freeze({
      ...mergedExplicitSpecs,
      ...generatedSpecs,
    }),
    generatedSpecs: Object.freeze(generatedSpecs),
    resolutionAudit: Object.freeze(resolutionAudit.map((entry) =>
      Object.freeze(entry)
    )),
  };
}

const OBSERVED_ABYSSAL_NPC_TYPE_BUILD =
  buildObservedAbyssalNpcTypeSpecs(
    EXPLICIT_ABYSSAL_TIER1_SAFE_NPC_TYPES,
  );

const ABYSSAL_TIER1_SAFE_NPC_TYPES = Object.freeze(
  OBSERVED_ABYSSAL_NPC_TYPE_BUILD.specs,
);

const OBSERVED_ABYSSAL_GENERATED_NPC_TYPES = Object.freeze(
  OBSERVED_ABYSSAL_NPC_TYPE_BUILD.generatedSpecs,
);

const OBSERVED_ABYSSAL_NPC_TYPE_RESOLUTION_AUDIT = Object.freeze(
  OBSERVED_ABYSSAL_NPC_TYPE_BUILD.resolutionAudit,
);


function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function normalizeCapabilityIDs(value) {
  return [...new Set(
    (Array.isArray(value) ? value : [])
      .map((entry) => String(entry || "").trim())
      .filter(Boolean),
  )].sort();
}

function getDeclaredCapabilityIDs(spec = {}) {
  if (Array.isArray(spec.capabilities)) {
    return normalizeCapabilityIDs(spec.capabilities);
  }
  return normalizeCapabilityIDs([
    ABYSSAL_NPC_CAPABILITY.DIRECT_WEAPON,
    String(spec.supportBehavior || "") === "remote_armor_repair"
      ? ABYSSAL_NPC_CAPABILITY.REMOTE_ARMOR_REPAIR
      : "",
  ]);
}

function buildCapabilityFlags(capabilityIDs = []) {
  const capabilities = new Set(normalizeCapabilityIDs(capabilityIDs));
  const has = (capabilityID) => capabilities.has(capabilityID);
  return {
    directWeapons: has(ABYSSAL_NPC_CAPABILITY.DIRECT_WEAPON),
    chainLightning: has(ABYSSAL_NPC_CAPABILITY.CHAIN_LIGHTNING),
    web: has(ABYSSAL_NPC_CAPABILITY.STASIS_WEBIFIER),
    scram: has(ABYSSAL_NPC_CAPABILITY.WARP_SCRAMBLER),
    warpDisruptor: has(ABYSSAL_NPC_CAPABILITY.WARP_DISRUPTOR),
    neutralizer: has(ABYSSAL_NPC_CAPABILITY.ENERGY_NEUTRALIZER),
    nosferatu: has(ABYSSAL_NPC_CAPABILITY.ENERGY_NOSFERATU),
    targetPainter: has(ABYSSAL_NPC_CAPABILITY.TARGET_PAINTER),
    sensorDampener: has(ABYSSAL_NPC_CAPABILITY.SENSOR_DAMPENER),
    trackingDisruptor: has(ABYSSAL_NPC_CAPABILITY.TRACKING_DISRUPTOR),
    guidanceDisruptor: has(ABYSSAL_NPC_CAPABILITY.GUIDANCE_DISRUPTOR),
    ecm: has(ABYSSAL_NPC_CAPABILITY.ECM_JAMMER),
    ecmBurst: has(ABYSSAL_NPC_CAPABILITY.ECM_BURST_JAMMER),
    localArmorRepair: has(ABYSSAL_NPC_CAPABILITY.LOCAL_ARMOR_REPAIR),
    localShieldBoost: has(ABYSSAL_NPC_CAPABILITY.LOCAL_SHIELD_BOOST),
    remoteArmorRepair: has(ABYSSAL_NPC_CAPABILITY.REMOTE_ARMOR_REPAIR),
    remoteShieldRepair: has(ABYSSAL_NPC_CAPABILITY.REMOTE_SHIELD_REPAIR),
    remoteHullRepair: has(ABYSSAL_NPC_CAPABILITY.REMOTE_HULL_REPAIR),
    controllerBehavior: has(ABYSSAL_NPC_CAPABILITY.CONTROLLER),
    dependantBehavior: has(ABYSSAL_NPC_CAPABILITY.DEPENDANT),
    // Compatibility field for existing diagnostics only. EWAR membership is
    // not an admission failure; runtime support is decided by the shared audit.
    forbiddenEwar: [...ABYSSAL_EWAR_CAPABILITIES]
      .some((capabilityID) => has(capabilityID)),
  };
}

function auditAbyssalNpcType(typeID) {
  const numericTypeID = toInt(typeID, 0);
  const typeRecord = numericTypeID > 0 ? resolveItemByTypeID(numericTypeID) : null;
  const attributeMap = numericTypeID > 0 ? getTypeAttributeMap(numericTypeID) : {};
  const effects = numericTypeID > 0 ? getTypeEffectRecords(numericTypeID) : [];
  const runtimeCapabilityAudit = auditNpcRuntimeSupport(numericTypeID);
  const capabilityIDs = normalizeCapabilityIDs(
    runtimeCapabilityAudit.detectedCapabilities,
  );
  const capabilityEvidence = (runtimeCapabilityAudit.evidence || []).map((entry) => ({
    capabilityID: String(entry.capabilityID || ""),
    source: String(entry.source || ""),
    effectID: toInt(entry.effectID, 0),
    effectName: String(entry.effectName || ""),
    family: String(entry.family || ""),
  }));
  const capabilityFlags = buildCapabilityFlags(capabilityIDs);
  const forbiddenEffectHits = capabilityEvidence.filter((entry) =>
    ABYSSAL_EWAR_CAPABILITIES.has(entry.capabilityID)
  );
  const supportEffectHits = capabilityEvidence.filter((entry) =>
    [
      ABYSSAL_NPC_CAPABILITY.REMOTE_ARMOR_REPAIR,
      ABYSSAL_NPC_CAPABILITY.REMOTE_SHIELD_REPAIR,
      ABYSSAL_NPC_CAPABILITY.REMOTE_HULL_REPAIR,
    ].includes(entry.capabilityID)
  );
  return {
    typeID: numericTypeID,
    exists: Boolean(typeRecord),
    typeName: String(typeRecord && typeRecord.name || ""),
    categoryID: toInt(typeRecord && typeRecord.categoryID, 0),
    groupID: toInt(typeRecord && typeRecord.groupID, 0),
    graphicID: toInt(typeRecord && typeRecord.graphicID, 0),
    radius: Number(typeRecord && typeRecord.radius),
    mass: Number(typeRecord && typeRecord.mass),
    targetingAttributes: {
      maxTargetRange: Number(attributeMap && attributeMap[getAttributeIDByNames("maxTargetRange") || 76]),
      scanResolution: Number(attributeMap && attributeMap[getAttributeIDByNames("scanResolution") || 564]),
      maxLockedTargets: Number(attributeMap && attributeMap[getAttributeIDByNames("maxLockedTargets") || 192]),
      weaponMaxRange: Number(attributeMap && attributeMap[getAttributeIDByNames("maxRange") || 54]),
    },
    movementAttributes: {
      maxVelocity: Number(attributeMap && attributeMap[getAttributeIDByNames("maxVelocity") || 37]),
      agility: Number(attributeMap && attributeMap[getAttributeIDByNames("agility") || 70]),
    },
    weaponEffects: capabilityEvidence
      .filter((entry) => entry.capabilityID === ABYSSAL_NPC_CAPABILITY.DIRECT_WEAPON)
      .map((entry) => entry.effectName)
      .filter(Boolean),
    dogmaEffectNames: effects.map((effect) => String(effect && effect.name || "")),
    capabilityIDs,
    capabilityEvidence,
    capabilityFlags,
    directWeapons: capabilityFlags.directWeapons,
    web: capabilityFlags.web,
    scram: capabilityFlags.scram,
    neutralizer: capabilityFlags.neutralizer,
    targetPainter: capabilityFlags.targetPainter,
    localRepair:
      capabilityFlags.localArmorRepair || capabilityFlags.localShieldBoost,
    remoteArmorRepair: capabilityFlags.remoteArmorRepair,
    remoteShieldRepair: capabilityFlags.remoteShieldRepair,
    controllerBehavior: capabilityFlags.controllerBehavior,
    dependantBehavior: capabilityFlags.dependantBehavior,
    forbiddenEwar: capabilityFlags.forbiddenEwar,
    forbiddenAttributeHits: [],
    forbiddenEffectHits,
    supportEffectHits,
    unsupportedRuntimeModuleFamilies: [
      ...(runtimeCapabilityAudit.runtimeUnsupportedCapabilities || []).map((entry) => ({
        source: "runtime_capability_audit",
        family: String(entry.capabilityID || ""),
        effectName: String(
          entry.evidence && entry.evidence[0] && entry.evidence[0].effectName || "",
        ),
        reason: String(entry.reason || "NO_RUNTIME_IMPLEMENTATION"),
      })),
      ...(runtimeCapabilityAudit.unknownCapabilities || []).map((entry) => ({
        source: String(entry.source || "sde_dogma_effect"),
        family: "unknown_sde_mechanic",
        effectName: String(entry.effectName || ""),
        reason: String(entry.reason || "UNKNOWN_EFFECT"),
      })),
    ],
    runtimeCapabilityAudit,
  };
}

function validateAbyssalTier1SafeNpcType(spec) {
  const audit = auditAbyssalNpcType(spec && spec.typeID);
  const declaredCapabilityIDs = getDeclaredCapabilityIDs(spec);
  const profileRuntimeAudit = auditNpcRuntimeSupport(spec && spec.typeID, {
    ...(Array.isArray(spec && spec.capabilities)
      ? { declaredCapabilityIDs }
      : {}),
  });
  const unsupportedDeclaredCapabilityIDs = declaredCapabilityIDs.filter(
    (capabilityID) => (
      !KNOWN_ABYSSAL_NPC_CAPABILITIES.has(capabilityID) ||
      profileRuntimeAudit.runtimeUnsupportedCapabilities.some(
        (entry) => entry.capabilityID === capabilityID,
      )
    ),
  );
  const missingCapabilityIDs = declaredCapabilityIDs.filter(
    (capabilityID) => !audit.capabilityIDs.includes(capabilityID),
  );
  const undeclaredCapabilityIDs = audit.capabilityIDs.filter(
    (capabilityID) =>
      Array.isArray(spec && spec.capabilities) &&
      !declaredCapabilityIDs.includes(capabilityID),
  );
  const errors = [];
  if (!audit.exists) {
    errors.push("type missing");
  }
  if (audit.categoryID !== CATEGORY_ENTITY) {
    errors.push("category is not Entity");
  }
  if (audit.groupID !== toInt(spec && spec.groupID, 0)) {
    errors.push("unexpected groupID");
  }
  if (toInt(spec && spec.factionID, 0) <= 0) {
    errors.push("missing factionID");
  }
  if (audit.graphicID <= 0) {
    errors.push("missing graphicID");
  }
  if (!Number.isFinite(audit.radius) || audit.radius <= 0) {
    errors.push("invalid radius");
  }
  if (!Number.isFinite(audit.mass) || audit.mass <= 0) {
    errors.push("invalid mass");
  }
  if (
    spec &&
    spec.allowMissingTargetingAttributes !== true &&
    (
      (
        !Number.isFinite(audit.targetingAttributes.maxTargetRange) ||
        audit.targetingAttributes.maxTargetRange <= 0
      ) &&
      (
        !Number.isFinite(audit.targetingAttributes.weaponMaxRange) ||
        audit.targetingAttributes.weaponMaxRange <= 0
      )
    )
  ) {
    errors.push("missing targeting attributes");
  }

  if (
    !Number.isFinite(audit.movementAttributes.maxVelocity) ||
    audit.movementAttributes.maxVelocity <= 0
  ) {
    errors.push("missing movement attributes");
  }

  if (
    !audit.capabilityIDs.includes(
      ABYSSAL_NPC_CAPABILITY.DIRECT_WEAPON,
    ) &&
    !audit.capabilityIDs.includes(
      ABYSSAL_NPC_CAPABILITY.CHAIN_LIGHTNING,
    ) &&
    !(spec && spec.allowMissingDirectWeapon === true)
  ) {
    errors.push("missing direct weapon effects");
  }

  if (
    audit.capabilityIDs.length <= 0 &&
    !(spec && spec.allowPassiveTargetShell === true)
  ) {
    errors.push("missing supported runtime capabilities");
  }

  if (unsupportedDeclaredCapabilityIDs.length > 0) {
    errors.push(
      `unsupported declared capabilities: ${unsupportedDeclaredCapabilityIDs.join(",")}`,
    );
  }

  if (missingCapabilityIDs.length > 0) {
    errors.push(
      `declared capabilities missing from SDE/runtime: ${missingCapabilityIDs.join(",")}`,
    );
  }

  if (undeclaredCapabilityIDs.length > 0) {
    errors.push(
      `runtime capabilities not declared: ${undeclaredCapabilityIDs.join(",")}`,
    );
  }

  if (profileRuntimeAudit.runtimeUnsupportedCapabilities.length > 0) {
    errors.push(
      "unsupported runtime capabilities: " +
        profileRuntimeAudit.runtimeUnsupportedCapabilities
          .map((entry) => entry.capabilityID || "unknown")
          .join(","),
    );
  }

  if (profileRuntimeAudit.unknownCapabilities.length > 0) {
    errors.push(
      "unknown SDE mechanics: " +
        profileRuntimeAudit.unknownCapabilities
          .map((entry) => entry.effectName || entry.reason || "unknown")
          .join(","),
    );
  }

  if (profileRuntimeAudit.profileOmissions.length > 0) {
    errors.push(
      "SDE capabilities omitted from profile mapping: " +
        profileRuntimeAudit.profileOmissions
          .map((entry) => entry.capabilityID)
          .join(","),
    );
  }

  return {
    success: errors.length === 0,
    errors,
    audit: {
      ...audit,
      factionID: toInt(spec && spec.factionID, 0),
      declaredCapabilityIDs,
      missingCapabilityIDs,
      undeclaredCapabilityIDs,
      unsupportedDeclaredCapabilityIDs,
      runtimeCapabilityAudit: profileRuntimeAudit,
    },
  };
}

function buildAbyssalNpcProfileRow(spec) {
  return {
    profileID: spec.profileID,
    name: spec.displayName,
    description: `Safe Abyssal profile backed by retail NPC entity type ${spec.typeID}.`,
    aliases: [
      spec.displayName.toLowerCase(),
      spec.profileID.replace(/_/g, " "),
      "abyssal safe",
      ...(Array.isArray(spec.tierEligibility)
        ? spec.tierEligibility.map((tier) => `abyssal tier ${tier} safe`)
        : ["abyssal tier 1 safe"]),
    ],
    entityType: "npc",
    shipTypeID: spec.typeID,
    presentationTypeID: spec.typeID,
    corporationID: 0,
    allianceID: 0,
    factionID: spec.factionID,
    behaviorProfileID: spec.behaviorProfileID,
    loadoutID: RETAIL_EMPTY_NPC_ENTITY_LOADOUT_ID,
    hardwareFamily: "sdeEntityNpc",
    lootTableID: ABYSSAL_PENDING_LOOT_TABLE_ID,
    shipNameTemplate: spec.displayName,
    securityStatus: -5,
    bounty: 0,
    spawnDistanceMeters: spec.spawnDistanceMeters,
    preferredTargetMode: "invoker",
  };
}

const ABYSSAL_NPC_PROFILE_ROWS = Object.freeze(
  Object.values(ABYSSAL_TIER1_SAFE_NPC_TYPES).map(buildAbyssalNpcProfileRow),
);

// Shared so tables this catalog does not contribute to return the same array
// every call; npcData caches by identity and a fresh [] defeats it.
const NO_GENERATED_ROWS = Object.freeze([]);

function buildObservedAbyssalNpcBehaviorProfileRow(spec) {
  const capabilityIDs = getDeclaredCapabilityIDs(spec);
  const remoteSupport = capabilityIDs.some((capabilityID) => [
    ABYSSAL_NPC_CAPABILITY.REMOTE_ARMOR_REPAIR,
    ABYSSAL_NPC_CAPABILITY.REMOTE_SHIELD_REPAIR,
    ABYSSAL_NPC_CAPABILITY.REMOTE_HULL_REPAIR,
  ].includes(capabilityID));
  const combatDistanceMeters = Math.max(
    1_000,
    toInt(spec && spec.combatDistanceMeters, toInt(spec && spec.spawnDistanceMeters, 8_000)),
  );

  return {
    behaviorProfileID: spec.behaviorProfileID,
    movementMode: "orbit",
    orbitDistanceMeters: Math.max(
      1_000,
      toInt(
          spec &&
          spec.behaviorOverrides &&
          spec.behaviorOverrides.orbitDistanceMeters,
        combatDistanceMeters,
      ),
    ),
    followRangeMeters: combatDistanceMeters,
    autoAggro: true,
    targetPreference: "preferredTargetThenNearestPlayer",
    aggressionRangeMeters: 250_000,
    autoActivateWeapons:
      capabilityIDs.includes(ABYSSAL_NPC_CAPABILITY.DIRECT_WEAPON) ||
      capabilityIDs.includes(ABYSSAL_NPC_CAPABILITY.CHAIN_LIGHTNING),
    returnToHomeWhenIdle: false,
    useChasePropulsion: false,
    allowFriendlyNpcTargets: remoteSupport,
    observedAbyssalNativeDogma: true,
  };
}

const OBSERVED_ABYSSAL_NPC_BEHAVIOR_PROFILE_ROWS = Object.freeze(
  Object.values(OBSERVED_ABYSSAL_GENERATED_NPC_TYPES)
    .map(buildObservedAbyssalNpcBehaviorProfileRow),
);

function getAbyssalNpcGeneratedRows(tableName) {
  const normalizedTableName = String(tableName || "");

  if (normalizedTableName === "npcProfiles") {
    return ABYSSAL_NPC_PROFILE_ROWS;
  }

  if (normalizedTableName === "npcBehaviorProfiles") {
    return OBSERVED_ABYSSAL_NPC_BEHAVIOR_PROFILE_ROWS;
  }

  return NO_GENERATED_ROWS;
}

function getAbyssalTier1SafeNpcTypeSpecs() {
  return cloneValue(ABYSSAL_TIER1_SAFE_NPC_TYPES);
}

module.exports = {
  ABYSSAL_NPC_CAPABILITY,
  ABYSSAL_TIER1_SAFE_NPC_TYPES,
  OBSERVED_ABYSSAL_GENERATED_NPC_TYPES,
  OBSERVED_ABYSSAL_NPC_TYPE_RESOLUTION_AUDIT,
  auditAbyssalNpcType,
  getAbyssalNpcGeneratedRows,
  getAbyssalTier1SafeNpcTypeSpecs,
  listObservedAbyssalNpcNameRecords,
  resolveObservedAbyssalNpcTypeByName,
  validateAbyssalTier1SafeNpcType,
};
