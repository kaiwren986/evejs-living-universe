"use strict";

const {
  cloneValue,
} = require("../../common/clone");
const {
  toFiniteNumber,
} = require("../../common/numbers");

const path = require("path");

const log = require(path.join(__dirname, "../../utils/logger"));
const config = require(path.join(__dirname, "../../config"));
const { random } = require(path.join(__dirname, "../../common/random"));
const worldData = require(path.join(__dirname, "../../space/worldData"));
const dungeonAuthority = require(path.join(__dirname, "./dungeonAuthority"));
const homefrontPopulationPolicy = require("./homefrontPopulationPolicy");
const dungeonRuntime = require(path.join(__dirname, "./dungeonRuntime"));
const dungeonSiteAdapter = require(path.join(__dirname, "./dungeonSiteAdapter"));
const dungeonSiteSpawnPolicy = require(path.join(__dirname, "./dungeonSiteSpawnPolicy"));
const dungeonRuntimeState = require(path.join(__dirname, "./dungeonRuntimeState"));
const {
  getSovProspectingRepairTemplateName,
  isValidSovProspectingClientNameTemplate,
} = require("./sovProspectingNameRepair");
const wormholeAuthority = require(path.join(__dirname, "../exploration/wormholes/wormholeAuthority"));
const {
  buildAnchorRelativeSignaturePlacement,
} = require(path.join(__dirname, "../exploration/signatures/signaturePlacement"));
const trigDrifterSpawnAuthority = require(path.join(
  __dirname,
  "../../space/npc/trigDrifter/trigDrifterSpawnAuthority",
));
const miningResourceSiteService = require(path.join(
  __dirname,
  "../mining/miningResourceSiteService",
));
const iceSystemAuthority = require(path.join(
  __dirname,
  "../mining/iceSystemAuthority",
));
const oreAnomalySecurityAuthority = require(path.join(
  __dirname,
  "../mining/oreAnomalySecurityAuthority",
));
// Phase 0 / 0.C: dungeon-universe seeding reconciles the generated mining
// entities it spawns through mining's owner API rather than writing the
// miningRuntimeState table directly (it does not own that table).
const miningRuntimeState = require(path.join(__dirname, "../mining/miningRuntimeState"));
const sovState = require(path.join(__dirname, "../sovereignty/sovState"));

const GENERATED_MINING_RECONCILE_INTERVAL_MS = 60_000;
const GENERATED_MINING_DEFAULT_SITE_LIFETIME_MINUTES = 1440;
const DAILY_DOWNTIME_HOUR_UTC = 11;
const DEFAULT_CLUSTER_DOWNTIME_STARTS_UTC = "11:00:00";
const DAY_MS = 24 * 60 * 60 * 1000;
const UNIVERSE_SITE_ID_SYSTEM_STRIDE = 1_000;
const UNIVERSE_SITE_ID_BASES = Object.freeze({
  // Permanent ranges for the 24 Homefront spawn families. Never reorder this
  // list: family/system/slot IDs must survive restarts and pack upgrades.
  ...Object.fromEntries([
    "homefront_emergency_aid_amarr", "homefront_emergency_aid_caldari",
    "homefront_emergency_aid_gallente", "homefront_emergency_aid_minmatar",
    "homefront_dread_assault_amarr", "homefront_dread_assault_caldari",
    "homefront_dread_assault_gallente", "homefront_dread_assault_minmatar",
    "homefront_raid_amarr", "homefront_raid_caldari",
    "homefront_raid_gallente", "homefront_raid_minmatar",
    "homefront_suspicious_signal_amarr", "homefront_suspicious_signal_caldari",
    "homefront_suspicious_signal_gallente", "homefront_suspicious_signal_minmatar",
    "homefront_metaliminal_meteoroid_amarr", "homefront_metaliminal_meteoroid_caldari",
    "homefront_metaliminal_meteoroid_gallente", "homefront_metaliminal_meteoroid_minmatar",
    "homefront_abyssal_artifact_recovery", "homefront_salvage_research",
    "homefront_stabilize_rift", "homefront_traffic_stop",
  ].map((family, index) => [family, 7_000_000_000_000 + index * 50_000_000_000])),
  combat: 5_300_000_000_000,
  combat_anomaly: 5_350_000_000_000,
  data: 5_400_000_000_000,
  drifter_observatory: 5_450_000_000_000,
  drifter_unidentified_wormhole: 5_475_000_000_000,
  drifter_space_sentinel_hive: 5_476_000_000_000,
  drifter_space_barbican_hive: 5_477_000_000_000,
  drifter_space_vidette_hive: 5_478_000_000_000,
  drifter_space_conflux_hive: 5_479_000_000_000,
  drifter_space_redoubt_hive: 5_480_000_000_000,
  drifter_space_reckoning_labyrinth: 5_481_000_000_000,
  drifter_space_reckoning_nexus: 5_482_000_000_000,
  drifter_occupied_tabbetzur_field_rescue: 5_483_000_000_000,
  drifter_occupied_tabbetzur_deathless_research_outpost: 5_484_000_000_000,
  drifter_vigilance_point: 5_485_000_000_000,
  drifter_observatory_infiltration: 5_486_000_000_000,
  drifter_deepflow_rift_pochven: 5_487_000_000_000,
  drifter_deepflow_rift_knownspace: 5_488_000_000_000,
  relic: 5_500_000_000_000,
  ghost: 5_600_000_000_000,
  combat_hacking: 5_700_000_000_000,
  ore: 5_800_000_000_000,
  gas: 5_900_000_000_000,
  sov_threat_detection: 6_000_000_000_000,
  sov_prospecting: 6_100_000_000_000,
  sov_exploration_detector: 6_200_000_000_000,
  // Each family needs about 31e9 of room (solarSystemID x stride), so new
  // families continue above the sovereignty bands.
  drone_anomaly: 6_300_000_000_000,
  wormhole_anomaly: 6_400_000_000_000,
  wormhole_data: 6_410_000_000_000,
  wormhole_relic: 6_420_000_000_000,
  wormhole_ore: 6_430_000_000_000,
  pirate_relic: 6_500_000_000_000,
  pirate_data: 6_510_000_000_000,
  gas_nebula: 6_520_000_000_000,
  wormhole_gas: 6_530_000_000_000,
  booster_lab: 6_540_000_000_000,
  booster_facility: 6_550_000_000_000,
  ded_rated: 6_560_000_000_000,
  gallente_fabricator: 6_610_000_000_000,
  gallente_fw_open: 6_700_000_000_000,
  caldari_fw_open: 6_750_000_000_000,
  gallente_iteration_depot: 6_600_000_000_000,
});
const COSMIC_SIGNATURE_TYPE_ID = 19_728;
const COSMIC_SIGNATURE_GROUP_ID = 502;
const COSMIC_ANOMALY_TYPE_ID = 28_356;
const COSMIC_ANOMALY_GROUP_ID = 885;
const BACKGROUND_RECONCILE_DELAY_MS = 25;
const SYSTEM_RECONCILE_INITIAL_DELAY_MS = 250;
const SYSTEM_WAKE_RECONCILE_DEBOUNCE_MS = 30_000;
const UNIVERSE_SEEDED_LIFECYCLE_STATES = Object.freeze(["seeded", "active", "paused"]);
const UNIVERSE_TERMINAL_LIFECYCLE_STATES = Object.freeze(["completed", "failed", "despawned"]);
const SOV_GUARANTEED_SITE_ORIGIN = "sov_hub";
const SOV_GUARANTEED_SPAWN_FAMILIES = Object.freeze([
  "sov_threat_detection",
  "sov_prospecting",
  "sov_exploration_detector",
]);
const SOV_GUARANTEED_FAMILY_SET = new Set(SOV_GUARANTEED_SPAWN_FAMILIES);
const STRICT_SECURITY_ORE_SELECTION_AUTHORITY = "strict_security_ore";
const DRONE_REGION_IDS = new Set([
  10000013, // Malpais
  10000018, // The Spire
  10000021, // Outer Passage
  10000027, // Etherium Reach
  10000034, // The Kalevala Expanse
  10000040, // Oasa
  10000053, // Cobalt Edge
  10000066, // Perrigen Falls
]);

const THREAT_DETECTION_TABLE = Object.freeze({
  pirate: Object.freeze([
    Object.freeze({
      key: "0.0_to_-0.25",
      minSecurity: -0.25,
      maxSecurity: 0,
      minor: Object.freeze({
        1: Object.freeze([["Refuge", 2], ["Den", 2], ["Hidden Den", 1]]),
        2: Object.freeze([["Refuge", 1], ["Den", 3], ["Hidden Den", 1], ["Forsaken Den", 1], ["Forlorn Den", 1], ["Rally Point", 2], ["Hidden Rally Point", 1]]),
        3: Object.freeze([["Refuge", 2], ["Den", 4], ["Hidden Den", 3], ["Forsaken Den", 2], ["Forlorn Den", 1], ["Rally Point", 2], ["Hidden Rally Point", 1]]),
      }),
      major: Object.freeze({
        1: Object.freeze([["Hub", 2], ["Hidden Hub", 3], ["Forsaken Hub", 2]]),
        2: Object.freeze([["Hub", 3], ["Hidden Hub", 3], ["Forsaken Hub", 2], ["Forlorn Hub", 2], ["Haven", 1]]),
        3: Object.freeze([["Hub", 4], ["Hidden Hub", 3], ["Forsaken Hub", 3], ["Forlorn Hub", 3], ["Haven", 2]]),
      }),
    }),
    Object.freeze({
      key: "-0.25_to_-0.45",
      minSecurity: -0.45,
      maxSecurity: -0.25,
      minor: Object.freeze({
        1: Object.freeze([["Refuge", 1], ["Den", 2], ["Hidden Den", 1], ["Forsaken Den", 1]]),
        2: Object.freeze([["Refuge", 1], ["Den", 3], ["Hidden Den", 2], ["Forsaken Den", 1], ["Forlorn Den", 1], ["Rally Point", 2], ["Hidden Rally Point", 1]]),
        3: Object.freeze([["Refuge", 2], ["Den", 4], ["Hidden Den", 2], ["Forsaken Den", 2], ["Forlorn Den", 1], ["Rally Point", 2], ["Hidden Rally Point", 2], ["Forsaken Rally Point", 1]]),
      }),
      major: Object.freeze({
        1: Object.freeze([["Hub", 2], ["Hidden Hub", 2], ["Forsaken Hub", 2], ["Forlorn Hub", 1]]),
        2: Object.freeze([["Hub", 2], ["Hidden Hub", 3], ["Forsaken Hub", 2], ["Forlorn Hub", 2], ["Haven", 2]]),
        3: Object.freeze([["Hub", 2], ["Hidden Hub", 3], ["Forsaken Hub", 3], ["Forlorn Hub", 3], ["Haven", 4], ["Sanctum", 1]]),
      }),
    }),
    Object.freeze({
      key: "-0.45_to_-0.65",
      minSecurity: -0.65,
      maxSecurity: -0.45,
      minor: Object.freeze({
        1: Object.freeze([["Refuge", 1], ["Den", 2], ["Hidden Den", 2], ["Forsaken Den", 1]]),
        2: Object.freeze([["Refuge", 1], ["Den", 2], ["Hidden Den", 2], ["Forsaken Den", 2], ["Forlorn Den", 1], ["Rally Point", 2], ["Hidden Rally Point", 1]]),
        3: Object.freeze([["Refuge", 1], ["Den", 4], ["Hidden Den", 2], ["Forsaken Den", 2], ["Forlorn Den", 2], ["Rally Point", 2], ["Hidden Rally Point", 1], ["Forsaken Rally Point", 2], ["Forlorn Rally Point", 1]]),
      }),
      major: Object.freeze({
        1: Object.freeze([["Hidden Hub", 2], ["Forsaken Hub", 2], ["Forlorn Hub", 2], ["Haven", 1]]),
        2: Object.freeze([["Hidden Hub", 3], ["Forsaken Hub", 3], ["Forlorn Hub", 3], ["Haven", 3]]),
        3: Object.freeze([["Hidden Hub", 3], ["Forsaken Hub", 3], ["Forlorn Hub", 3], ["Haven", 6], ["Sanctum", 2]]),
      }),
    }),
    Object.freeze({
      key: "-0.65_to_-0.85",
      minSecurity: -0.85,
      maxSecurity: -0.65,
      minor: Object.freeze({
        1: Object.freeze([["Den", 2], ["Hidden Den", 1], ["Forsaken Den", 2], ["Forlorn Den", 1]]),
        2: Object.freeze([["Den", 2], ["Hidden Den", 2], ["Forsaken Den", 2], ["Forlorn Den", 2], ["Rally Point", 3], ["Hidden Rally Point", 1]]),
        3: Object.freeze([["Den", 2], ["Hidden Den", 2], ["Forsaken Den", 2], ["Forlorn Den", 2], ["Rally Point", 4], ["Hidden Rally Point", 2], ["Forsaken Rally Point", 2], ["Forlorn Rally Point", 2]]),
      }),
      major: Object.freeze({
        1: Object.freeze([["Hidden Hub", 2], ["Forsaken Hub", 2], ["Forlorn Hub", 2], ["Haven", 2]]),
        2: Object.freeze([["Hidden Hub", 2], ["Forsaken Hub", 2], ["Forlorn Hub", 2], ["Haven", 4], ["Sanctum", 2]]),
        3: Object.freeze([["Hidden Hub", 2], ["Forsaken Hub", 3], ["Forlorn Hub", 2], ["Haven", 7], ["Sanctum", 3], ["Forsaken Sanctum", 1]]),
      }),
    }),
    Object.freeze({
      key: "-0.85_to_-1.0",
      minSecurity: -1,
      maxSecurity: -0.85,
      minor: Object.freeze({
        1: Object.freeze([["Den", 2], ["Hidden Den", 1], ["Forsaken Den", 2], ["Forlorn Den", 2]]),
        2: Object.freeze([["Den", 2], ["Hidden Den", 2], ["Forsaken Den", 2], ["Forlorn Den", 2], ["Rally Point", 2], ["Hidden Rally Point", 1], ["Forsaken Rally Point", 2]]),
        3: Object.freeze([["Den", 2], ["Hidden Den", 2], ["Forsaken Den", 2], ["Forlorn Den", 2], ["Rally Point", 2], ["Hidden Rally Point", 3], ["Forsaken Rally Point", 3], ["Forlorn Rally Point", 3]]),
      }),
      major: Object.freeze({
        1: Object.freeze([["Forsaken Hub", 3], ["Forlorn Hub", 2], ["Haven", 2], ["Sanctum", 1]]),
        2: Object.freeze([["Forsaken Hub", 3], ["Forlorn Hub", 3], ["Haven", 5], ["Sanctum", 2]]),
        3: Object.freeze([["Forsaken Hub", 2], ["Forlorn Hub", 2], ["Haven", 8], ["Sanctum", 4], ["Forsaken Sanctum", 3]]),
      }),
    }),
  ]),
  drone: Object.freeze([
    Object.freeze({
      key: "0.0_to_-0.25",
      minSecurity: -0.25,
      maxSecurity: 0,
      minor: Object.freeze({
        1: Object.freeze([["Drone Assembly", 4], ["Drone Gathering", 1]]),
        2: Object.freeze([["Drone Assembly", 5], ["Drone Gathering", 2], ["Drone Surveillance", 2], ["Drone Menagerie", 2], ["Drone Herd", 1]]),
        3: Object.freeze([["Drone Assembly", 5], ["Drone Gathering", 3], ["Drone Surveillance", 2], ["Drone Menagerie", 3], ["Drone Herd", 2], ["Drone Squad", 1]]),
      }),
      major: Object.freeze({
        1: Object.freeze([["Drone Patrol", 2], ["Drone Horde", 2]]),
        2: Object.freeze([["Drone Patrol", 3], ["Drone Horde", 3], ["Teeming Drone Horde", 1]]),
        3: Object.freeze([["Drone Patrol", 4], ["Drone Horde", 4], ["Teeming Drone Horde", 2]]),
      }),
    }),
    Object.freeze({
      key: "-0.25_to_-0.45",
      minSecurity: -0.45,
      maxSecurity: -0.25,
      minor: Object.freeze({
        1: Object.freeze([["Drone Assembly", 3], ["Drone Gathering", 2]]),
        2: Object.freeze([["Drone Assembly", 5], ["Drone Gathering", 2], ["Drone Surveillance", 2], ["Drone Menagerie", 3], ["Drone Herd", 2]]),
        3: Object.freeze([["Drone Assembly", 5], ["Drone Gathering", 3], ["Drone Surveillance", 3], ["Drone Menagerie", 3], ["Drone Herd", 3], ["Drone Squad", 1]]),
      }),
      major: Object.freeze({
        1: Object.freeze([["Drone Patrol", 2], ["Drone Horde", 3]]),
        2: Object.freeze([["Drone Patrol", 3], ["Drone Horde", 3], ["Teeming Drone Horde", 2]]),
        3: Object.freeze([["Drone Patrol", 4], ["Drone Horde", 4], ["Teeming Drone Horde", 3]]),
      }),
    }),
    Object.freeze({
      key: "-0.45_to_-0.65",
      minSecurity: -0.65,
      maxSecurity: -0.45,
      minor: Object.freeze({
        1: Object.freeze([["Drone Assembly", 2], ["Drone Gathering", 3]]),
        2: Object.freeze([["Drone Assembly", 4], ["Drone Gathering", 3], ["Drone Surveillance", 3], ["Drone Menagerie", 3], ["Drone Herd", 2]]),
        3: Object.freeze([["Drone Assembly", 5], ["Drone Gathering", 3], ["Drone Surveillance", 3], ["Drone Menagerie", 4], ["Drone Herd", 3], ["Drone Squad", 2]]),
      }),
      major: Object.freeze({
        1: Object.freeze([["Drone Patrol", 1], ["Drone Horde", 4]]),
        2: Object.freeze([["Drone Patrol", 2], ["Drone Horde", 3], ["Teeming Drone Horde", 3]]),
        3: Object.freeze([["Drone Patrol", 3], ["Drone Horde", 4], ["Teeming Drone Horde", 4]]),
      }),
    }),
    Object.freeze({
      key: "-0.65_to_-0.85",
      minSecurity: -0.85,
      maxSecurity: -0.65,
      minor: Object.freeze({
        1: Object.freeze([["Drone Assembly", 1], ["Drone Gathering", 4]]),
        2: Object.freeze([["Drone Assembly", 3], ["Drone Gathering", 3], ["Drone Surveillance", 4], ["Drone Menagerie", 3], ["Drone Herd", 3]]),
        3: Object.freeze([["Drone Assembly", 4], ["Drone Gathering", 3], ["Drone Surveillance", 3], ["Drone Menagerie", 5], ["Drone Herd", 3], ["Drone Squad", 3]]),
      }),
      major: Object.freeze({
        1: Object.freeze([["Drone Horde", 4], ["Teeming Drone Horde", 2]]),
        2: Object.freeze([["Drone Patrol", 2], ["Drone Horde", 2], ["Teeming Drone Horde", 4]]),
        3: Object.freeze([["Drone Patrol", 2], ["Drone Horde", 3], ["Teeming Drone Horde", 5]]),
      }),
    }),
    Object.freeze({
      key: "-0.85_to_-1.0",
      minSecurity: -1,
      maxSecurity: -0.85,
      minor: Object.freeze({
        1: Object.freeze([["Drone Gathering", 4], ["Drone Surveillance", 1]]),
        2: Object.freeze([["Drone Assembly", 2], ["Drone Gathering", 3], ["Drone Surveillance", 3], ["Drone Menagerie", 4], ["Drone Herd", 4]]),
        3: Object.freeze([["Drone Assembly", 3], ["Drone Gathering", 4], ["Drone Surveillance", 3], ["Drone Menagerie", 4], ["Drone Herd", 4], ["Drone Squad", 4]]),
      }),
      major: Object.freeze({
        1: Object.freeze([["Drone Horde", 4], ["Teeming Drone Horde", 3]]),
        2: Object.freeze([["Drone Patrol", 1], ["Drone Horde", 2], ["Teeming Drone Horde", 5]]),
        3: Object.freeze([["Drone Patrol", 2], ["Drone Horde", 2], ["Teeming Drone Horde", 6]]),
      }),
    }),
  ]),
});
const COMBAT_ANOMALY_LABELS = Object.freeze([
  "Teeming Drone Horde",
  "Forsaken Rally Point",
  "Forlorn Rally Point",
  "Hidden Rally Point",
  "Forsaken Sanctum",
  "Forsaken Hub",
  "Forlorn Hub",
  "Hidden Hub",
  "Forsaken Den",
  "Forlorn Den",
  "Hidden Den",
  "Drone Surveillance",
  "Drone Menagerie",
  "Drone Assembly",
  "Drone Gathering",
  "Drone Patrol",
  "Drone Horde",
  "Drone Squad",
  "Drone Herd",
  "Rally Point",
  "Sanctum",
  "Haven",
  "Refuge",
  "Hub",
  "Den",
]);
const PROSPECTING_MINERAL_ORE_NAMES = Object.freeze({
  tritanium: Object.freeze(["Veldspar"]),
  pyerite: Object.freeze(["Mordunium", "Kylixium"]),
  mexallon: Object.freeze(["Kylixium", "Mordunium"]),
  isogen: Object.freeze(["Griemeer", "Hezorime"]),
  nocxium: Object.freeze(["Nocxite"]),
  zydrine: Object.freeze(["Hezorime"]),
  megacyte: Object.freeze(["Ueganite"]),
});
const EXPLORATION_DETECTOR_FAMILY_SEQUENCE = Object.freeze([
  "data",
  "relic",
  "combat_hacking",
]);
let systemUniverseReconcileTimer = null;
const systemUniverseReconcileJobs = new Map();
let compiledSpawnFamiliesCache = null;
const spawnProfileTemplateFilterCache = new Map();
const templateCandidatesBySpawnFamilyCache = new Map();
const bandTemplateCandidatesCache = new Map();
const policyEligibleTemplateCandidatesCache = new Map();
const systemWakeReconcileState = new Map();
const combatAnomalyTemplatesByLabelCache = new Map();
const prospectingOreTemplatesByKeyCache = new Map();
let stargateAdjacencyCache = null;

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function firstPositiveInt(...values) {
  for (const value of values) {
    const numeric = toInt(value, 0);
    if (numeric > 0) {
      return numeric;
    }
  }
  return 0;
}

function hasOwnValue(object, key) {
  return object &&
    Object.prototype.hasOwnProperty.call(object, key) &&
    object[key] !== undefined &&
    object[key] !== null;
}

function normalizeText(value, fallback = "") {
  const normalized = String(value == null ? "" : value).trim();
  return normalized || fallback;
}

function normalizeLowerText(value, fallback = "") {
  return normalizeText(value, fallback).toLowerCase();
}

function normalizeTextArray(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((entry) => normalizeLowerText(entry, ""))
    .filter(Boolean))];
}

function normalizeObject(value) {
  return value && typeof value === "object" ? value : {};
}

function normalizeIntegerArray(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((entry) => toInt(entry, 0))
    .filter((entry) => entry > 0))]
    .sort((left, right) => left - right);
}

function formatUtcClock(hour, minute, second) {
  return [
    Math.max(0, toInt(hour, 0)).toString().padStart(2, "0"),
    Math.max(0, toInt(minute, 0)).toString().padStart(2, "0"),
    Math.max(0, toInt(second, 0)).toString().padStart(2, "0"),
  ].join(":");
}

function normalizeSecurityBand(value) {
  const normalized = normalizeLowerText(value, "nullsec");
  switch (normalized) {
    case "highsec":
    case "lowsec":
    case "nullsec":
    case "wormhole":
      return normalized;
    default:
      return "nullsec";
  }
}

function normalizeRatio(value, fallback = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.max(0, Math.min(1, numeric));
}

function normalizeSystemIDs(systemIDs = null) {
  if (!Array.isArray(systemIDs) || systemIDs.length <= 0) {
    return worldData.getSolarSystems()
      .map((system) => toInt(system && system.solarSystemID, 0))
      .filter((entry) => entry > 0)
      .sort((left, right) => left - right);
  }

  return [...new Set(systemIDs
    .map((entry) => toInt(entry, 0))
    .filter((entry) => entry > 0))].sort((left, right) => left - right);
}

function normalizeProvidedSystemIDs(systemIDs = []) {
  return [...new Set((Array.isArray(systemIDs) ? systemIDs : [systemIDs])
    .map((entry) => toInt(entry, 0))
    .filter((entry) => entry > 0))].sort((left, right) => left - right);
}

function hashValue(value) {
  let state = toInt(value, 0) >>> 0;
  state = Math.imul(state ^ (state >>> 16), 0x45d9f3b);
  state = Math.imul(state ^ (state >>> 16), 0x45d9f3b);
  state ^= state >>> 16;
  return state >>> 0;
}

function hashText(value) {
  const normalized = normalizeText(value, "");
  let state = 0;
  for (let index = 0; index < normalized.length; index += 1) {
    state = hashValue(state + normalized.charCodeAt(index));
  }
  return state >>> 0;
}

function clonePosition(position, fallback = { x: 0, y: 0, z: 0 }) {
  return {
    x: toFiniteNumber(position && position.x, fallback.x),
    y: toFiniteNumber(position && position.y, fallback.y),
    z: toFiniteNumber(position && position.z, fallback.z),
  };
}

function addVectors(left, right) {
  return {
    x: toFiniteNumber(left && left.x, 0) + toFiniteNumber(right && right.x, 0),
    y: toFiniteNumber(left && left.y, 0) + toFiniteNumber(right && right.y, 0),
    z: toFiniteNumber(left && left.z, 0) + toFiniteNumber(right && right.z, 0),
  };
}

function normalizeVector(vector, fallback = { x: 1, y: 0, z: 0 }) {
  const x = toFiniteNumber(vector && vector.x, 0);
  const y = toFiniteNumber(vector && vector.y, 0);
  const z = toFiniteNumber(vector && vector.z, 0);
  const magnitude = Math.sqrt((x * x) + (y * y) + (z * z));
  if (magnitude <= 0) {
    return { ...fallback };
  }
  return {
    x: x / magnitude,
    y: y / magnitude,
    z: z / magnitude,
  };
}

function scaleVector(vector, scalar) {
  const numericScalar = toFiniteNumber(scalar, 0);
  return {
    x: toFiniteNumber(vector && vector.x, 0) * numericScalar,
    y: toFiniteNumber(vector && vector.y, 0) * numericScalar,
    z: toFiniteNumber(vector && vector.z, 0) * numericScalar,
  };
}

function getSecurityBand(systemID) {
  const numericSystemID = toInt(systemID, 0);
  if (numericSystemID >= 31_000_000 && numericSystemID <= 31_999_999) {
    return "wormhole";
  }
  const systemRecord = worldData.getSolarSystemByID(numericSystemID) || null;
  const securityStatus = toFiniteNumber(
    systemRecord && (systemRecord.securityStatus ?? systemRecord.security),
    0,
  );
  if (securityStatus >= 0.45) {
    return "highsec";
  }
  if (securityStatus >= 0) {
    return "lowsec";
  }
  return "nullsec";
}

function resolveSiteLifetimeMs(siteLifetimeMinutes) {
  return Math.max(60_000, Math.max(1, toInt(siteLifetimeMinutes, 1440)) * 60_000);
}

function getSpawnProfileTemplateFilters(family) {
  const cacheKey = normalizeLowerText(family, "unknown");
  if (spawnProfileTemplateFilterCache.has(cacheKey)) {
    return spawnProfileTemplateFilterCache.get(cacheKey);
  }
  const profile = dungeonAuthority.getSpawnProfile(family);
  const filters =
    profile && profile.templateFilters && typeof profile.templateFilters === "object"
      ? profile.templateFilters
      : {};
  const normalizedFilters = Object.freeze({
    siteFamilies: normalizeTextArray(filters.siteFamilies),
    siteKinds: normalizeTextArray(filters.siteKinds),
    nameIncludesAny: normalizeTextArray(filters.nameIncludesAny),
    nameExcludesAny: normalizeTextArray(filters.nameExcludesAny),
    siteVariants: normalizeTextArray(filters.siteVariants),
    siteTiers: normalizeTextArray(filters.siteTiers),
  });
  spawnProfileTemplateFilterCache.set(cacheKey, normalizedFilters);
  return normalizedFilters;
}

function buildBandCounts(systemIDs = null) {
  const counts = {
    highsec: 0,
    lowsec: 0,
    nullsec: 0,
    wormhole: 0,
  };
  for (const systemID of normalizeSystemIDs(systemIDs)) {
    counts[getSecurityBand(systemID)] += 1;
  }
  return counts;
}

function buildScopedSystemSelector(family, bandProfile) {
  const profile = dungeonAuthority.getSpawnProfile(family) || {};
  return {
    systemAuthorityKeys: normalizeTextArray([
      ...(Array.isArray(profile.systemAuthorityKeys) ? profile.systemAuthorityKeys : []),
      ...(Array.isArray(bandProfile && bandProfile.systemAuthorityKeys)
        ? bandProfile.systemAuthorityKeys
        : []),
    ]),
    systemIDs: normalizeIntegerArray([
      ...(Array.isArray(profile.systemIDs) ? profile.systemIDs : []),
      ...(Array.isArray(bandProfile && bandProfile.systemIDs) ? bandProfile.systemIDs : []),
    ]),
    regionIDs: normalizeIntegerArray([
      ...(Array.isArray(profile.regionIDs) ? profile.regionIDs : []),
      ...(Array.isArray(bandProfile && bandProfile.regionIDs) ? bandProfile.regionIDs : []),
    ]),
    constellationIDs: normalizeIntegerArray([
      ...(Array.isArray(profile.constellationIDs) ? profile.constellationIDs : []),
      ...(Array.isArray(bandProfile && bandProfile.constellationIDs)
        ? bandProfile.constellationIDs
        : []),
    ]),
    wormholeClassIDs: normalizeIntegerArray([
      ...(Array.isArray(profile.wormholeClassIDs) ? profile.wormholeClassIDs : []),
      ...(Array.isArray(bandProfile && bandProfile.wormholeClassIDs)
        ? bandProfile.wormholeClassIDs
        : []),
    ]),
    excludeSystemIDs: normalizeIntegerArray([
      ...(Array.isArray(profile.excludeSystemIDs) ? profile.excludeSystemIDs : []),
      ...(Array.isArray(bandProfile && bandProfile.excludeSystemIDs)
        ? bandProfile.excludeSystemIDs
        : []),
    ]),
    excludeRegionIDs: normalizeIntegerArray([
      ...(Array.isArray(profile.excludeRegionIDs) ? profile.excludeRegionIDs : []),
      ...(Array.isArray(bandProfile && bandProfile.excludeRegionIDs)
        ? bandProfile.excludeRegionIDs
        : []),
    ]),
    excludeConstellationIDs: normalizeIntegerArray([
      ...(Array.isArray(profile.excludeConstellationIDs) ? profile.excludeConstellationIDs : []),
      ...(Array.isArray(bandProfile && bandProfile.excludeConstellationIDs)
        ? bandProfile.excludeConstellationIDs
        : []),
    ]),
    excludeWormholeClassIDs: normalizeIntegerArray([
      ...(Array.isArray(profile.excludeWormholeClassIDs) ? profile.excludeWormholeClassIDs : []),
      ...(Array.isArray(bandProfile && bandProfile.excludeWormholeClassIDs)
        ? bandProfile.excludeWormholeClassIDs
        : []),
    ]),
  };
}

/**
 * Compiles a scoped selector into a per-system predicate.
 *
 * The selector is resolved once (authority lookups, Set construction) and the
 * returned function answers for a single systemID, so callers never have to
 * materialise the eligible-system list to ask whether one system qualifies.
 */
function buildScopedSelectorMatcher(selector = {}) {
  const authoritySystemIDs = normalizeIntegerArray(
    normalizeTextArray(selector.systemAuthorityKeys)
      .flatMap((key) => trigDrifterSpawnAuthority.getSystemList(key)),
  );
  const explicitSystemIDs = normalizeIntegerArray(selector.systemIDs);
  const regionIDs = new Set(normalizeIntegerArray(selector.regionIDs));
  const constellationIDs = new Set(normalizeIntegerArray(selector.constellationIDs));
  const wormholeClassIDs = new Set(normalizeIntegerArray(selector.wormholeClassIDs));
  const excludeSystemIDs = new Set(normalizeIntegerArray(selector.excludeSystemIDs));
  const excludeRegionIDs = new Set(normalizeIntegerArray(selector.excludeRegionIDs));
  const excludeConstellationIDs = new Set(normalizeIntegerArray(selector.excludeConstellationIDs));
  const excludeWormholeClassIDs = new Set(normalizeIntegerArray(selector.excludeWormholeClassIDs));
  const scopedSystemIDs = new Set([
    ...authoritySystemIDs,
    ...explicitSystemIDs,
  ]);
  const hasScopedSelectors =
    scopedSystemIDs.size > 0 ||
    regionIDs.size > 0 ||
    constellationIDs.size > 0 ||
    wormholeClassIDs.size > 0;
  const hasExcludeSelectors =
    excludeSystemIDs.size > 0 ||
    excludeRegionIDs.size > 0 ||
    excludeConstellationIDs.size > 0 ||
    excludeWormholeClassIDs.size > 0;

  // An unscoped selector admits everything; skip the per-system work entirely.
  if (!hasScopedSelectors && !hasExcludeSelectors) {
    return () => true;
  }

  return (candidateSystemID) => {
    const systemID = Math.max(0, toInt(candidateSystemID, 0));
    if (excludeSystemIDs.has(systemID)) {
      return false;
    }
    const systemRecord = worldData.getSolarSystemByID(systemID) || null;
    const regionID = toInt(systemRecord && systemRecord.regionID, 0);
    if (excludeRegionIDs.has(regionID)) {
      return false;
    }
    const constellationID = toInt(systemRecord && systemRecord.constellationID, 0);
    if (excludeConstellationIDs.has(constellationID)) {
      return false;
    }
    // Solar-system rows carry no class; the wormhole authority does.
    const wormholeClassID = wormholeAuthority.getSystemClassID(systemID);
    if (excludeWormholeClassIDs.has(wormholeClassID)) {
      return false;
    }
    if (!hasScopedSelectors) {
      return true;
    }
    if (scopedSystemIDs.has(systemID)) {
      return true;
    }
    if (regionIDs.has(regionID)) {
      return true;
    }
    if (constellationIDs.has(constellationID)) {
      return true;
    }
    return wormholeClassIDs.has(wormholeClassID);
  };
}

/**
 * Compiles the authored spawn profiles into per-band predicates.
 *
 * Spawn profiles are static config, so this is built once and reused. Each entry
 * carries everything `resolveSystemSitePlan` needs to answer for a single system:
 * the global per-system count, which bands the family may appear in, and a
 * compiled scope matcher per band.
 */
/**
 * How many sites of a family every eligible system receives.
 *
 * This is operator configuration, not authored content: config/world.json owns
 * the amount, while the authority data owns which bands a family may appear in
 * and which templates can fill a slot. A family absent from
 * universeSiteCountsByFamily falls back to universeSiteCountDefault, and a count
 * of 0 stops it spawning without editing the authority data.
 */
function resolveConfiguredSiteCount(family) {
  const normalizedFamily = normalizeLowerText(family, "");
  const countsByFamily = config.universeSiteCountsByFamily &&
    typeof config.universeSiteCountsByFamily === "object"
    ? config.universeSiteCountsByFamily
    : {};
  const configured = countsByFamily[normalizedFamily];
  if (configured !== undefined && configured !== null) {
    return Math.max(0, toInt(configured, 0));
  }
  return Math.max(0, toInt(config.universeSiteCountDefault, 0));
}

/**
 * Authored per-region density: a spawn profile may scale the configured
 * per-system count for specific regions (rogue drone anomalies are densest in
 * the eight drone regions). The operator count stays the base amount; a
 * multiplier below one thins a region, zero removes the family from it.
 */
function normalizeRegionSiteCountMultipliers(value) {
  const multipliers = new Map();
  if (!value || typeof value !== "object") {
    return multipliers;
  }
  for (const [regionID, multiplier] of Object.entries(value)) {
    const numericRegionID = toInt(regionID, 0);
    const numericMultiplier = toFiniteNumber(multiplier, NaN);
    if (numericRegionID > 0 && Number.isFinite(numericMultiplier) && numericMultiplier >= 0) {
      multipliers.set(numericRegionID, numericMultiplier);
    }
  }
  return multipliers;
}

function getSystemRegionID(systemID) {
  const systemRecord = worldData.getSolarSystemByID(systemID) || null;
  return Math.max(0, toInt(systemRecord && systemRecord.regionID, 0));
}

function resolveFamilySiteCountForSystem(entry, systemID) {
  const multipliers = entry && entry.regionSiteCountMultipliers;
  if (!multipliers || multipliers.size <= 0) {
    return entry.count;
  }
  const multiplier = multipliers.get(getSystemRegionID(systemID));
  if (multiplier === undefined) {
    return entry.count;
  }
  return Math.max(0, Math.round(entry.count * multiplier));
}

/**
 * Authored rarity: a spawn profile may declare that only a fraction of the
 * eligible systems host the family at all (ghost sites are uncommon). The
 * choice is a stable hash of family and system, so a system either hosts the
 * family or it does not, independent of wake order or time.
 */
function normalizeSystemSpawnChance(value) {
  const chance = toFiniteNumber(value, NaN);
  if (!Number.isFinite(chance) || chance >= 1) {
    return 1;
  }
  return Math.max(0, chance);
}

function systemHostsFamily(entry, systemID) {
  if (entry.homefrontPopulation) {
    return homefrontPopulationPolicy.hostsSystem(
      entry.homefrontPopulation,
      systemID,
      config,
    );
  }
  const chance = entry && entry.systemSpawnChance;
  if (chance === undefined || chance >= 1) {
    return true;
  }
  if (chance <= 0) {
    return false;
  }
  const roll = hashText(`spawn-chance:${entry.family}:${Math.max(0, toInt(systemID, 0))}`) / 4294967296;
  return roll < chance;
}

function listCompiledSpawnFamilies() {
  if (compiledSpawnFamiliesCache) {
    return compiledSpawnFamiliesCache;
  }
  const compiled = [];
  for (const family of dungeonAuthority.listUniverseSpawnFamilies()) {
    const profile = dungeonAuthority.getSpawnProfile(family);
    if (!profile || profile.enabled === false) {
      continue;
    }
    const count = resolveConfiguredSiteCount(family);
    if (count <= 0) {
      continue;
    }
    const selectionAuthority = normalizeLowerText(profile.selectionAuthority, "");
    if (selectionAuthority === STRICT_SECURITY_ORE_SELECTION_AUTHORITY) {
      oreAnomalySecurityAuthority.assertAuthority({ configuredCount: count });
    }
    const bands = new Set(
      normalizeTextArray(profile.bands).map((band) => normalizeSecurityBand(band)),
    );
    if (bands.size <= 0) {
      continue;
    }
    const bandTuning = profile.bandTuning && typeof profile.bandTuning === "object"
      ? profile.bandTuning
      : {};
    const matchersByBand = new Map();
    const tuningByBand = new Map();
    for (const band of bands) {
      const tuning = bandTuning[band] && typeof bandTuning[band] === "object"
        ? bandTuning[band]
        : {};
      tuningByBand.set(band, tuning);
      matchersByBand.set(band, buildScopedSelectorMatcher(buildScopedSystemSelector(family, tuning)));
    }
    compiled.push({
      family: normalizeLowerText(family, ""),
      count: homefrontPopulationPolicy.operationType(family) ? 1 : count,
      selectionAuthority,
      bands,
      matchersByBand,
      tuningByBand,
      regionSiteCountMultipliers: normalizeRegionSiteCountMultipliers(profile.regionSiteCountMultipliers),
      systemSpawnChance: normalizeSystemSpawnChance(profile.systemSpawnChance),
      homefrontSystemIDs: homefrontPopulationPolicy.operationType(family) ? profile.systemIDs || [] : [],
      lifetimeMs: resolveSiteLifetimeMs(profile.siteLifetimeMinutes),
    });
  }
  homefrontPopulationPolicy.prepareGroups(compiled);
  compiledSpawnFamiliesCache = compiled;
  return compiled;
}

/**
 * Answers "what cosmic content belongs in this system?" as a pure function of one
 * systemID.
 *
 * Reads no runtime state and touches no other system: the security band comes
 * from the system's own record, and every family contributes a fixed count if its
 * band eligibility and scope predicate admit this system. Cost is proportional to
 * the number of configured families, not to the size of the universe.
 */
function resolveSystemSitePlan(systemID, options = {}) {
  const numericSystemID = Math.max(0, toInt(systemID, 0));
  if (numericSystemID <= 0) {
    return [];
  }
  const familyFilter = new Set((Array.isArray(options.families) ? options.families : [])
    .map((entry) => normalizeLowerText(entry, ""))
    .filter(Boolean));
  const band = getSecurityBand(numericSystemID);
  const plan = [];
  for (const entry of listCompiledSpawnFamilies()) {
    if (["gallente_fw_open","caldari_fw_open"].includes(entry.family) && !require("../seasons/campaignTrailCatalog").isEnabled()) continue;
    if (entry.family === "gallente_fabricator" && (!require("../seasons/campaignTrailCatalog").isEnabled() || !require("../seasons/eventHooks").fabricator.eligibleSystem(numericSystemID))) continue;
    if (entry.family === "gallente_iteration_depot" &&
        (!require("../seasons/campaignTrailCatalog").isEnabled() ||
         require("../../space/npc/pirateFactionPolicy").isSpecialSpaceSystem(numericSystemID, worldData.getSolarSystemByID(numericSystemID)))) continue;
    if (familyFilter.size > 0 && !familyFilter.has(entry.family)) {
      continue;
    }
    if (!entry.bands.has(band)) {
      continue;
    }
    const matcher = entry.matchersByBand.get(band);
    if (matcher && !matcher(numericSystemID)) {
      continue;
    }
    if (
      entry.selectionAuthority === STRICT_SECURITY_ORE_SELECTION_AUTHORITY &&
      !oreAnomalySecurityAuthority.isEligibleSecurityTier(
        oreAnomalySecurityAuthority.resolveSecurityTierForSystemID(numericSystemID),
      )
    ) {
      continue;
    }
    if (!systemHostsFamily(entry, numericSystemID)) {
      continue;
    }
    const count = resolveFamilySiteCountForSystem(entry, numericSystemID);
    if (count <= 0) {
      continue;
    }
    plan.push({
      family: entry.family,
      band,
      count,
      selectionAuthority: entry.selectionAuthority,
      lifetimeMs: entry.lifetimeMs,
      bandTuning: entry.tuningByBand.get(band) || {},
    });
  }
  return plan;
}

function resolveGeneratedMiningSiteLifetimeMs() {
  return resolveSiteLifetimeMs(
    Math.max(
      1,
      toInt(
        config && config.miningGeneratedIceSiteLifetimeMinutes,
        GENERATED_MINING_DEFAULT_SITE_LIFETIME_MINUTES,
      ),
    ),
  );
}

function extractStaticPosition(record) {
  const position = record && record.position && typeof record.position === "object"
    ? record.position
    : record;
  return {
    x: toFiniteNumber(position && position.x, 0),
    y: toFiniteNumber(position && position.y, 0),
    z: toFiniteNumber(position && position.z, 0),
  };
}

function buildUniverseAnchorCandidates(systemID, family) {
  const normalizedFamily = normalizeLowerText(family, "combat");
  const belts = worldData.getAsteroidBeltsForSystem(systemID)
    .map((belt) => ({
      itemID: toInt(belt && belt.itemID, 0),
      position: extractStaticPosition(belt),
    }))
    .filter((entry) => entry.itemID > 0);
  const celestials = worldData.getCelestialsForSystem(systemID)
    .filter((celestial) => toInt(celestial && celestial.groupID, 0) !== 6)
    .map((celestial) => ({
      itemID: toInt(celestial && celestial.itemID, 0),
      position: extractStaticPosition(celestial),
    }))
    .filter((entry) => entry.itemID > 0);
  const stations = worldData.getStationsForSystem(systemID)
    .map((station) => ({
      itemID: toInt(station && station.stationID, 0),
      position: extractStaticPosition(station),
    }))
    .filter((entry) => entry.itemID > 0);
  const stargates = worldData.getStargatesForSystem(systemID)
    .map((stargate) => ({
      itemID: toInt(stargate && stargate.itemID, 0),
      position: extractStaticPosition(stargate),
    }))
    .filter((entry) => entry.itemID > 0);

  const ordered = normalizedFamily === "ore" || normalizedFamily === "gas"
    ? [...belts, ...celestials, ...stations, ...stargates]
    : [...celestials, ...belts, ...stations, ...stargates];
  if (ordered.length > 0) {
    return ordered;
  }

  const systemRecord = worldData.getSolarSystemByID(systemID) || null;
  const fallbackRadius = Math.max(
    1_000_000_000,
    Math.round(toFiniteNumber(systemRecord && systemRecord.radius, 0) * 0.25),
  );
  return [{
    itemID: systemID,
    position: { x: fallbackRadius, y: 0, z: 0 },
  }];
}

function buildUniverseSitePosition(systemID, family, slotIndex, rotationIndex = 0) {
  return buildUniverseSitePlacement(systemID, family, slotIndex, rotationIndex).position;
}

function buildUniverseSitePlacement(systemID, family, slotIndex, rotationIndex = 0) {
  const anchorCandidates = buildUniverseAnchorCandidates(systemID, family);
  const placement = buildAnchorRelativeSignaturePlacement(
    anchorCandidates,
    `universe-site:${normalizeLowerText(family, "unknown")}:${toInt(systemID, 0)}:${Math.max(0, toInt(slotIndex, 0))}:${Math.max(0, toInt(rotationIndex, 0))}`,
    {
      fallbackAnchorItemID: toInt(systemID, 0),
      baseDistanceAu: 4,
      distanceJitterAu: 0.35,
      verticalJitterAu: 0.14,
    },
  );
  return {
    ...placement,
    anchorDistanceMeters: toFiniteNumber(placement && placement.distanceMeters, 0),
    anchorDistanceAu: toFiniteNumber(placement && placement.distanceAu, 0),
  };
}

function buildGeneratedMiningSiteKey(definition) {
  return [
    "generatedmining",
    normalizeText(definition && definition.family, "unknown").toLowerCase(),
    toInt(definition && definition.solarSystemID, 0),
    toInt(definition && definition.localSiteIndex, 0),
  ].join(":");
}

function buildGeneratedMiningDefinitionHash(definition, templateID, placement = null) {
  const sitePosition = placement && placement.position
    ? placement.position
    : definition && definition.position;
  return JSON.stringify({
    templateID: normalizeText(templateID, ""),
    family: normalizeText(definition && definition.family, "unknown").toLowerCase(),
    solarSystemID: toInt(definition && definition.solarSystemID, 0),
    localSiteIndex: toInt(definition && definition.localSiteIndex, 0),
    rawSiteIndex: toInt(definition && definition.rawSiteIndex, 0),
    rotationIndex: Math.max(0, toInt(definition && definition.rotationIndex, 0)),
    sourceDungeonID: toInt(definition && definition.sourceDungeonID, 0) || null,
    authorityKey: normalizeText(definition && definition.authorityKey, "") || null,
    exactClientDungeonContent: definition && definition.exactClientDungeonContent === true,
    resourceTypeIDs: Array.isArray(definition && definition.resourceTypeIDs)
      ? [...definition.resourceTypeIDs]
      : [],
    members: (Array.isArray(definition && definition.members) ? definition.members : [])
      .map((member) => [
        toInt(member && member.entityID, 0),
        toInt(member && member.yieldTypeID, 0),
        Math.max(0, toInt(member && member.originalQuantity, 0)),
      ]),
    anchorItemID: toInt(placement && placement.anchorItemID, 0),
    anchorDistanceMeters: Math.round(toFiniteNumber(placement && placement.anchorDistanceMeters, 0)),
    position: [
      Math.round(toFiniteNumber(sitePosition && sitePosition.x, 0)),
      Math.round(toFiniteNumber(sitePosition && sitePosition.y, 0)),
      Math.round(toFiniteNumber(sitePosition && sitePosition.z, 0)),
    ],
  });
}

function buildGeneratedMiningSpawnState(definition) {
  const members = (Array.isArray(definition && definition.members) ? definition.members : [])
    .map((member) => cloneValue(member));
  return {
    siteID: toInt(definition && definition.siteID, 0),
    rawSiteIndex: toInt(definition && definition.rawSiteIndex, 0),
    localSiteIndex: toInt(definition && definition.localSiteIndex, 0),
    sourceDungeonID: toInt(definition && definition.sourceDungeonID, 0) || null,
    templateID: normalizeText(definition && definition.templateID, "") || null,
    authorityKey: normalizeText(definition && definition.authorityKey, "") || null,
    authorityScope: normalizeText(definition && definition.authorityScope, "") || null,
    exactClientDungeonContent: definition && definition.exactClientDungeonContent === true,
    label: normalizeText(definition && definition.label, "Mining Site"),
    memberCount: members.length,
    activeMemberCount: members.filter((member) => toFiniteNumber(member && member.remainingQuantity, 0) > 0).length,
    totalOriginalQuantity: members.reduce(
      (sum, member) => sum + Math.max(0, toFiniteNumber(member && member.originalQuantity, 0)),
      0,
    ),
    totalRemainingQuantity: members.reduce(
      (sum, member) => sum + Math.max(0, toFiniteNumber(member && member.remainingQuantity, 0)),
      0,
    ),
    resourceTypeIDs: Array.isArray(definition && definition.resourceTypeIDs)
      ? [...definition.resourceTypeIDs]
      : [],
    resourceNames: Array.isArray(definition && definition.resourceNames)
      ? [...definition.resourceNames]
      : [],
    members,
  };
}

function resolveGeneratedMiningTemplate(definition) {
  const family = normalizeText(definition && definition.family, "unknown").toLowerCase();
  const resourceHintField =
    family === "gas"
      ? "gasTypeIDs"
      : (
        family === "ice"
          ? "iceTypeIDs"
          : "oreTypeIDs"
      );
  const hints = {
    readOnly: true,
    templateID: normalizeText(definition && definition.templateID, ""),
    [resourceHintField]: Array.isArray(definition && definition.resourceTypeIDs)
      ? definition.resourceTypeIDs
      : [],
  };
  return dungeonSiteAdapter.resolveTemplateForSite({
    solarSystemID: toInt(definition && definition.solarSystemID, 0),
    dungeonID: toInt(definition && definition.sourceDungeonID, 0),
    archetypeID: family === "ice" ? 28 : 0,
    siteKind: "anomaly",
    family,
    label: normalizeText(definition && definition.label, "Mining Site"),
  }, hints);
}

function enrichGeneratedMiningDefinition(definition, nowMs, options = {}) {
  const template = resolveGeneratedMiningTemplate(definition);
  if (!template) {
    return null;
  }

  const templateID = normalizeText(template.templateID, "");
  const slotIndex = Math.max(
    0,
    toInt(
      definition && definition.localSiteIndex,
      options && options.slotIndex,
    ),
  );
  const rotationIndex = Math.max(
    0,
    toInt(
      options && options.rotationIndex,
      definition && definition.rotationIndex,
    ),
  );
  const startedAtMs = Math.max(0, toInt(options && options.startedAtMs, nowMs));
  const lifetimeMs = Math.max(
    60_000,
    toInt(
      options && options.lifetimeMs,
      resolveGeneratedMiningSiteLifetimeMs(),
    ),
  );
  const placement = buildUniverseSitePlacement(
    toInt(definition && definition.solarSystemID, 0),
    normalizeText(definition && definition.family, "ice").toLowerCase(),
    slotIndex,
    rotationIndex,
  );
  const position = placement.position;
  return {
    templateID,
    solarSystemID: toInt(definition && definition.solarSystemID, 0),
    siteKey: buildGeneratedMiningSiteKey(definition),
    lifecycleState: "active",
    instanceScope: "shared",
    siteFamily: normalizeText(definition && definition.family, "unknown").toLowerCase(),
    siteKind: "anomaly",
    siteOrigin: "generatedMining",
    position,
    nowMs: startedAtMs,
    activatedAtMs: startedAtMs,
    expiresAtMs: startedAtMs + lifetimeMs,
    spawnState: {
      ...buildGeneratedMiningSpawnState(definition),
      slotIndex,
      rotationIndex,
      securityBand: normalizeText(definition && definition.securityBand, getSecurityBand(definition && definition.solarSystemID)),
      lifetimeMs,
      anchorItemID: toInt(placement && placement.anchorItemID, 0) || null,
      anchorDistanceMeters: Math.round(toFiniteNumber(placement && placement.anchorDistanceMeters, 0)),
      anchorDistanceAu: Number(toFiniteNumber(placement && placement.anchorDistanceAu, 0).toFixed(3)),
    },
    roomStatesByKey: {
      "room:entry": {
        roomKey: "room:entry",
        state: "active",
        stage: "entry",
        pocketID: null,
        nodeGraphID: null,
        activatedAtMs: startedAtMs,
        completedAtMs: 0,
        lastUpdatedAtMs: startedAtMs,
        spawnedEntityIDs: [],
        counters: {},
        metadata: {
          seededFromTemplate: false,
          lightweight: true,
        },
      },
    },
    gateStatesByKey: {},
    objectiveState: {
      state: "pending",
      currentNodeID: null,
      currentObjectiveID: null,
      completedObjectiveIDs: [],
      completedNodeIDs: [],
      counters: {},
      metadata: {
        lightweight: true,
      },
    },
    environmentState: {
      seededAtMs: startedAtMs,
      lightweight: true,
    },
    runtimeFlags: {
      universeSeeded: true,
      universePersistent: true,
      lazyMaterialized: true,
      generatedMining: true,
      exactClientDungeonContent: definition && definition.exactClientDungeonContent === true,
    },
    metadata: {
      providerID: "generatedMining",
      definitionHash: buildGeneratedMiningDefinitionHash(definition, templateID, placement),
      siteID: toInt(definition && definition.siteID, 0),
      rawSiteIndex: toInt(definition && definition.rawSiteIndex, 0),
      localSiteIndex: slotIndex,
      slotIndex,
      rotationIndex,
      sourceDungeonID: toInt(definition && definition.sourceDungeonID, 0) || null,
      authorityKey: normalizeText(definition && definition.authorityKey, "") || null,
      authorityScope: normalizeText(definition && definition.authorityScope, "") || null,
      exactClientDungeonContent: definition && definition.exactClientDungeonContent === true,
      label: normalizeText(definition && definition.label, "Mining Site"),
      securityBand: normalizeText(definition && definition.securityBand, getSecurityBand(definition && definition.solarSystemID)),
      universeSeededAtMs: startedAtMs,
      anchorItemID: toInt(placement && placement.anchorItemID, 0) || null,
      anchorDistanceMeters: Math.round(toFiniteNumber(placement && placement.anchorDistanceMeters, 0)),
      anchorDistanceAu: Number(toFiniteNumber(placement && placement.anchorDistanceAu, 0).toFixed(3)),
    },
  };
}

function listDesiredGeneratedMiningDefinitions(systemIDs = null, nowMs = Date.now()) {
  const targetedSystemIDs = normalizeSystemIDs(systemIDs);
  const eligibleSystemIDs = iceSystemAuthority.listIceSystemIDs(targetedSystemIDs);
  const freshDefinitions = eligibleSystemIDs
    .flatMap((systemID) => miningResourceSiteService.buildGeneratedResourceSiteDefinitionsForSystem(systemID))
    .map((definition) => enrichGeneratedMiningDefinition(definition, nowMs))
    .filter(Boolean);
  if (freshDefinitions.length <= 0) {
    return [];
  }
  const activeBySiteKey = new Map(
    listUniverseSeededGeneratedMiningInstances(eligibleSystemIDs)
      .map((instance) => [normalizeText(instance && instance.siteKey, ""), instance])
      .filter(([siteKey]) => Boolean(siteKey)),
  );
  return freshDefinitions.map((definition) => {
    const existing = activeBySiteKey.get(normalizeText(definition && definition.siteKey, "")) || null;
    return existing && normalizeText(existing.templateID, "") === normalizeText(definition.templateID, "")
      ? cloneValue(existing)
      : definition;
  });
}

function buildGeneratedMiningDefinitionFromInstance(instance) {
  if (
    !instance ||
    normalizeLowerText(instance && instance.siteOrigin, "") !== "generatedmining"
  ) {
    return null;
  }
  const metadata = instance && instance.metadata && typeof instance.metadata === "object"
    ? instance.metadata
    : {};
  const spawnState = instance && instance.spawnState && typeof instance.spawnState === "object"
    ? instance.spawnState
    : {};
  const family = normalizeText(instance && instance.siteFamily, "ice").toLowerCase();
  const runtimeFlags = instance && instance.runtimeFlags && typeof instance.runtimeFlags === "object"
    ? instance.runtimeFlags
    : {};
  const rawSiteIndex = Math.max(
    0,
    toInt(
      metadata.rawSiteIndex,
      spawnState.rawSiteIndex,
    ),
  );
  const localSiteIndex = Math.max(
    0,
    toInt(
      metadata.localSiteIndex,
      spawnState.localSiteIndex,
    ),
  );
  const definition = {
    solarSystemID: Math.max(0, toInt(instance && instance.solarSystemID, 0)),
    family,
    siteFamily: family,
    siteKind: "anomaly",
    localSiteIndex,
    rawSiteIndex,
    rotationIndex: Math.max(
      0,
      toInt(
        metadata.rotationIndex,
        spawnState.rotationIndex,
      ),
    ),
    siteID: Math.max(
      0,
      toInt(
        metadata.siteID,
        spawnState.siteID,
      ),
    ),
    sourceDungeonID: Math.max(
      0,
      toInt(
        metadata.sourceDungeonID,
        spawnState.sourceDungeonID,
      ),
    ) || null,
    templateID: normalizeText(
      instance && instance.templateID,
      normalizeText(spawnState.templateID, ""),
    ) || null,
    exactClientDungeonContent:
      spawnState.exactClientDungeonContent === true ||
      runtimeFlags.exactClientDungeonContent === true ||
      metadata.exactClientDungeonContent === true,
    authorityKey: normalizeText(
      metadata.authorityKey,
      normalizeText(spawnState.authorityKey, ""),
    ) || null,
    authorityScope: normalizeText(
      metadata.authorityScope,
      normalizeText(spawnState.authorityScope, ""),
    ) || null,
    label: normalizeText(
      metadata.label,
      normalizeText(spawnState.label, "Mining Site"),
    ),
    securityBand: normalizeText(
      metadata.securityBand,
      normalizeText(
        spawnState.securityBand,
        getSecurityBand(instance && instance.solarSystemID),
      ),
    ),
    memberCount: Math.max(
      0,
      toInt(spawnState.memberCount, Array.isArray(spawnState.members) ? spawnState.members.length : 0),
    ),
    activeMemberCount: Math.max(
      0,
      toInt(
        spawnState.activeMemberCount,
        Array.isArray(spawnState.members)
          ? spawnState.members.filter((member) => toInt(member && member.remainingQuantity, 0) > 0).length
          : 0,
      ),
    ),
    totalOriginalQuantity: Math.max(0, toInt(spawnState.totalOriginalQuantity, 0)),
    totalRemainingQuantity: Math.max(0, toInt(spawnState.totalRemainingQuantity, 0)),
    resourceTypeIDs: Array.isArray(spawnState.resourceTypeIDs)
      ? [...spawnState.resourceTypeIDs]
      : [],
    resourceNames: Array.isArray(spawnState.resourceNames)
      ? [...spawnState.resourceNames]
      : [],
    members: Array.isArray(spawnState.members)
      ? cloneValue(spawnState.members)
      : [],
    position:
      instance && instance.position && typeof instance.position === "object"
        ? clonePosition(instance.position)
        : null,
  };
  return {
    ...definition,
    spawnState: buildGeneratedMiningSpawnState(definition),
  };
}

function listActiveGeneratedMiningDefinitionsFromRuntime(systemIDs = null) {
  return listUniverseSeededGeneratedMiningInstances(systemIDs)
    .map((instance) => buildGeneratedMiningDefinitionFromInstance(instance))
    .filter(Boolean);
}

function buildGeneratedMiningPersistedState(member, family, nowMs) {
  return {
    version: 1,
    entityID: toInt(member && member.entityID, 0),
    visualTypeID: Math.max(1, toInt(member && member.visualTypeID, 0)),
    beltID: 0,
    fieldStyleID: null,
    yieldTypeID: Math.max(0, toInt(member && member.yieldTypeID, 0)),
    yieldKind: normalizeText(
      member && member.yieldKind,
      family,
    ).toLowerCase(),
    unitVolume: Math.max(0.000001, toFiniteNumber(member && member.unitVolume, 1)),
    originalQuantity: Math.max(0, toInt(member && member.originalQuantity, 0)),
    remainingQuantity: Math.max(0, toInt(member && member.remainingQuantity, 0)),
    originalRadius: Math.max(1, toFiniteNumber(member && member.originalRadius, 1)),
    updatedAtMs: Math.max(0, toInt(nowMs, Date.now())),
  };
}

function reconcileGeneratedMiningRuntimeState(definitions, systemIDs, nowMs) {
  const targetedSystemIDs = normalizeSystemIDs(systemIDs);
  const desiredBySystem = new Map();
  for (const systemID of targetedSystemIDs) {
    desiredBySystem.set(systemID, new Map());
  }

  for (const definition of Array.isArray(definitions) ? definitions : []) {
    const systemID = toInt(definition && definition.solarSystemID, 0);
    if (!desiredBySystem.has(systemID)) {
      desiredBySystem.set(systemID, new Map());
    }
    const desiredByEntityID = desiredBySystem.get(systemID);
    const spawnState = definition && definition.spawnState && typeof definition.spawnState === "object"
      ? definition.spawnState
      : {};
    for (const member of Array.isArray(spawnState.members) ? spawnState.members : []) {
      const entityID = toInt(member && member.entityID, 0);
      if (entityID > 0) {
        desiredByEntityID.set(entityID, buildGeneratedMiningPersistedState(
          member,
          definition && definition.siteFamily,
          nowMs,
        ));
      }
    }
  }

  let createdRows = 0;
  let updatedRows = 0;
  let removedRows = 0;
  for (const [systemID, desiredByEntityID] of desiredBySystem.entries()) {
    const existingByEntityID = miningRuntimeState.readPersistedSystemEntities(systemID);

    for (const [entityIDKey, persistedState] of Object.entries(existingByEntityID)) {
      const descriptor = miningResourceSiteService.resolveGeneratedMiningEntityDescriptor(
        persistedState && persistedState.entityID != null
          ? persistedState.entityID
          : entityIDKey,
      );
      if (!descriptor || descriptor.systemID !== systemID) {
        continue;
      }
      if (!desiredByEntityID.has(toInt(entityIDKey, 0))) {
        if (miningRuntimeState.removePersistedSystemEntity(systemID, entityIDKey)) {
          removedRows += 1;
        }
      }
    }

    for (const [entityID, desiredState] of desiredByEntityID.entries()) {
      const existingState = existingByEntityID[String(entityID)];
      if (!existingState) {
        if (miningRuntimeState.writePersistedSystemEntity(systemID, entityID, desiredState)) {
          createdRows += 1;
        }
        continue;
      }

      const existingComparable = {
        ...cloneValue(existingState),
        updatedAtMs: 0,
      };
      const desiredComparable = {
        ...cloneValue(desiredState),
        updatedAtMs: 0,
      };
      if (JSON.stringify(existingComparable) !== JSON.stringify(desiredComparable)) {
        if (miningRuntimeState.writePersistedSystemEntity(systemID, entityID, desiredState)) {
          updatedRows += 1;
        }
      }
    }
  }

  return {
    createdRows,
    updatedRows,
    removedRows,
  };
}

function getUniverseSiteProviderID(siteKind) {
  return normalizeLowerText(siteKind, "signature") === "anomaly"
    ? "sceneAnomalySite"
    : "sceneSignatureSite";
}

function buildUniverseSiteID(family, systemID, slotIndex) {
  const base = UNIVERSE_SITE_ID_BASES[normalizeLowerText(family, "")];
  if (!base) {
    return 0;
  }
  return base + (toInt(systemID, 0) * UNIVERSE_SITE_ID_SYSTEM_STRIDE) + (Math.max(0, toInt(slotIndex, 0)) + 1);
}

function resolveSiteFamilyLabel(family) {
  switch (normalizeLowerText(family, "unknown")) {
    case "combat":
      return "Combat";
    case "combat_anomaly":
      return "Combat Anomaly";
    case "drone_anomaly":
      return "Drone Anomaly";
    case "wormhole_anomaly":
      return "Sleeper Anomaly";
    case "wormhole_data":
      return "Sleeper Data";
    case "wormhole_relic":
      return "Sleeper Relic";
    case "wormhole_ore":
      return "Wormhole Ore";
    case "pirate_relic":
      return "Relic";
    case "pirate_data":
      return "Data";
    case "gas_nebula":
    case "wormhole_gas":
      return "Gas";
    case "booster_lab":
    case "booster_facility":
      return "Combat Hacking";
    case "drifter_observatory":
      return "Jove Observatory";
    case "drifter_unidentified_wormhole":
      return "Unidentified Wormhole";
    case "drifter_space_sentinel_hive":
    case "drifter_space_barbican_hive":
    case "drifter_space_vidette_hive":
    case "drifter_space_conflux_hive":
    case "drifter_space_redoubt_hive":
      return "Drifter Hive";
    case "combat_hacking":
      return "Combat Hacking";
    case "data":
      return "Data";
    case "relic":
      return "Relic";
    case "ore":
      return "Ore";
    case "gas":
      return "Gas";
    case "sov_threat_detection":
      return "Sov Combat";
    case "sov_prospecting":
      return "Sov Ore";
    case "sov_exploration_detector":
      return "Sov Exploration";
    case "ghost":
      return "Ghost";
    default:
      return "Site";
  }
}

function resolveUniverseSiteLabel(template, family, slotIndex) {
  const normalizedFamily = normalizeLowerText(family, "unknown");
  const resolvedName = normalizeText(template && template.resolvedName, "");
  if (
    resolvedName &&
    (
      normalizedFamily.startsWith("drifter_")
    )
  ) {
    return resolvedName;
  }
  const familyLabel = resolveSiteFamilyLabel(family);
  const templateMarker =
    Math.max(0, toInt(template && template.sourceDungeonID, 0)) ||
    Math.max(0, toInt(template && template.dungeonNameID, 0)) ||
    (Math.max(0, toInt(slotIndex, 0)) + 1);
  return `${familyLabel} Site ${templateMarker}`;
}

function normalizeDifficultyRange(range) {
  const values = Array.isArray(range) ? range : [];
  const minimum = toInt(values[0], 0);
  const maximum = toInt(values[1], minimum);
  return [
    Math.min(minimum, maximum),
    Math.max(minimum, maximum),
  ];
}

function listTemplateCandidatesForSpawnFamily(family) {
  const cacheKey = normalizeLowerText(family, "unknown");
  if (templateCandidatesBySpawnFamilyCache.has(cacheKey)) {
    return templateCandidatesBySpawnFamilyCache.get(cacheKey);
  }
  const filters = getSpawnProfileTemplateFilters(cacheKey);
  const profile = dungeonAuthority.getSpawnProfile(cacheKey) || {};
  const candidatesByTemplateID = new Map();
  if (Array.isArray(profile.templateIDs) && profile.templateIDs.length > 0) {
    // A spawn profile that lists its templates explicitly (content packs do)
    // selects only those; family/kind filters still apply as a boundary check.
    for (const templateID of normalizeTextArray(profile.templateIDs)) {
      const template = dungeonAuthority.getTemplateSelectionDescriptorByID(templateID);
      if (!template || !template.templateID) {
        continue;
      }
      if (templateMatchesSpawnFamily(template, cacheKey, { difficultyRange: [0, 99] })) {
        candidatesByTemplateID.set(template.templateID, template);
      }
    }
  } else {
    const siteFamilies = filters.siteFamilies.length > 0
      ? filters.siteFamilies
      : [cacheKey];
    for (const siteFamily of siteFamilies) {
      for (const template of dungeonAuthority.listTemplateSelectionDescriptorsByFamily(siteFamily)) {
        if (!template || !template.templateID) {
          continue;
        }
        if (templateMatchesSpawnFamily(template, cacheKey, { difficultyRange: [0, 99] })) {
          candidatesByTemplateID.set(template.templateID, template);
        }
      }
    }
  }
  const candidates = Object.freeze([...candidatesByTemplateID.values()]);
  templateCandidatesBySpawnFamilyCache.set(cacheKey, candidates);
  return candidates;
}

function templateSiteVariant(template) {
  return normalizeLowerText(template && template.siteVariant, "base");
}

function templateSiteTier(template) {
  return normalizeLowerText(template && template.siteTier, "");
}

function isMissionOnlyUniverseTemplate(template) {
  const archetypeLocation = normalizeLowerText(
    template && template.archetype && template.archetype.location,
    "",
  );
  return (
    Math.max(0, toInt(template && template.missionBriefingID, 0)) > 0 ||
    archetypeLocation === "mission specific"
  );
}

function templateMatchesSpawnFamily(template, family, bandProfile) {
  // Phase 7 provides controlled placement. Organic incursion activation and
  // site scheduling must supply their own admitted context in Phase 8.
  if (template?.templateID === "evejs-incursion-vanguard:nation-commander-outpost") return false;
  // The event pack supplies explicit Depot variants. Never schedule the old
  // family-derived generic research-container placeholder as an ordinary site.
  if (String(template?.templateID).startsWith("evejs-fw:open:") && `${template.templateID.split(":").at(-1)}_fw_open` !== family) return false;
  if ((Number(template?.sourceDungeonID) === 13890 || String(template?.templateID).startsWith("evejs-election:fabricator:")) && family !== "gallente_fabricator") return false;
  if ((Number(template?.sourceDungeonID) === 13978 || String(template?.templateID).startsWith("evejs-election:iteration-depot:")) && family !== "gallente_iteration_depot") return false;
  if (!template || typeof template !== "object") {
    return false;
  }
  // The client dungeon catalog also contains ordinary agent-mission pockets.
  // Their inferred combat/signature classification is not authorization to
  // seed them as public cosmic signatures.
  if (isMissionOnlyUniverseTemplate(template)) {
    return false;
  }
  const filters = getSpawnProfileTemplateFilters(family);
  const [minimum, maximum] = normalizeDifficultyRange(bandProfile && bandProfile.difficultyRange);
  const difficulty = toInt(template && template.difficulty, 0);
  if (difficulty < minimum || difficulty > maximum) {
    return false;
  }
  const siteFamily = normalizeLowerText(template && template.siteFamily, "unknown");
  const siteKind = normalizeLowerText(template && template.siteKind, "signature");
  const resolvedName = normalizeLowerText(template && template.resolvedName, "");
  if (filters.siteFamilies.length > 0 && !filters.siteFamilies.includes(siteFamily)) {
    return false;
  }
  if (filters.siteKinds.length > 0 && !filters.siteKinds.includes(siteKind)) {
    return false;
  }
  if (filters.nameIncludesAny.length > 0 && !filters.nameIncludesAny.some((entry) => resolvedName.includes(entry))) {
    return false;
  }
  if (filters.nameExcludesAny.length > 0 && filters.nameExcludesAny.some((entry) => resolvedName.includes(entry))) {
    return false;
  }
  if (filters.siteVariants.length > 0 && !filters.siteVariants.includes(templateSiteVariant(template))) {
    return false;
  }
  if (filters.siteTiers.length > 0 && !filters.siteTiers.includes(templateSiteTier(template))) {
    return false;
  }
  // Per-band tuning may narrow the selection further (e.g. Forlorn variants
  // only in null-sec, Drone Horde tiers only in null-sec).
  const bandVariants = normalizeTextArray(bandProfile && bandProfile.siteVariants);
  if (bandVariants.length > 0 && !bandVariants.includes(templateSiteVariant(template))) {
    return false;
  }
  const bandTiers = normalizeTextArray(bandProfile && bandProfile.siteTiers);
  if (bandTiers.length > 0 && !bandTiers.includes(templateSiteTier(template))) {
    return false;
  }
  const bandExcludes = normalizeTextArray(bandProfile && bandProfile.nameExcludesAny);
  if (bandExcludes.length > 0 && bandExcludes.some((entry) => resolvedName.includes(entry))) {
    return false;
  }
  const bandIncludes = normalizeTextArray(bandProfile && bandProfile.nameIncludesAny);
  if (bandIncludes.length > 0 && !bandIncludes.some((entry) => resolvedName.includes(entry))) {
    return false;
  }
  return true;
}

function listFamilyTemplatesForBand(family, band, bandProfile) {
  const cacheKey = JSON.stringify({
    family: normalizeLowerText(family, "unknown"),
    band: normalizeSecurityBand(band),
    difficultyRange: normalizeDifficultyRange(bandProfile && bandProfile.difficultyRange),
  });
  if (bandTemplateCandidatesCache.has(cacheKey)) {
    return bandTemplateCandidatesCache.get(cacheKey);
  }
  const allCandidates = listTemplateCandidatesForSpawnFamily(family);
  const candidates = allCandidates
    .filter((template) => {
      return templateMatchesSpawnFamily(template, family, bandProfile);
    })
    .sort((left, right) => (
      toInt(left && left.sourceDungeonID, Number.MAX_SAFE_INTEGER) -
      toInt(right && right.sourceDungeonID, Number.MAX_SAFE_INTEGER)
    ) || String(left && left.templateID || "").localeCompare(String(right && right.templateID || "")));
  if (candidates.length > 0) {
    const cachedCandidates = Object.freeze(candidates);
    bandTemplateCandidatesCache.set(cacheKey, cachedCandidates);
    return cachedCandidates;
  }
  const fallbackCandidates = Object.freeze(allCandidates
    .sort((left, right) => (
      toInt(left && left.sourceDungeonID, Number.MAX_SAFE_INTEGER) -
      toInt(right && right.sourceDungeonID, Number.MAX_SAFE_INTEGER)
    ) || String(left && left.templateID || "").localeCompare(String(right && right.templateID || ""))));
  bandTemplateCandidatesCache.set(cacheKey, fallbackCandidates);
  return fallbackCandidates;
}

// Policy options a spawn profile carries for its own family: whether a concrete
// local pirate faction is required (pirate anomaly packs) and whether the
// family's faction is at home in every region (rogue drone anomaly pack).
function buildSpawnProfilePolicyOptions(spawnProfile, options = {}) {
  if (!spawnProfile || typeof spawnProfile !== "object") {
    return options;
  }
  const merged = { ...options };
  if (spawnProfile.requireConcreteLocalPirateFaction === true) {
    merged.requireConcreteLocalPirateFaction = true;
  }
  const factionScope = normalizeLowerText(spawnProfile.factionScope, "");
  if (factionScope) {
    merged.factionScope = factionScope;
  }
  const wormholeFactionScope = normalizeLowerText(spawnProfile.wormholeFactionScope, "");
  if (wormholeFactionScope) {
    merged.wormholeFactionScope = wormholeFactionScope;
  }
  return merged;
}

function evaluateTemplateSpawnPolicy(template, family, systemID, band, context, options = {}) {
  const spawnProfile = dungeonAuthority.getSpawnProfileReadOnly(family);
  const policyOptions = buildSpawnProfilePolicyOptions(spawnProfile, options);
  return dungeonSiteSpawnPolicy.evaluateSiteSpawnPolicy({
    template,
    spawnFamilyKey: family,
    systemID,
    securityBand: band,
  }, context, policyOptions);
}

// Startup repair for persisted universe sites whose content is gone: a removed
// content pack takes its templates and spawn family with it, and an instance
// that still points at them would throw on the first warp-in. They are purged
// here (scene teardown follows through the normal instance-change path).
function resetStartupOrphanedUniverseSites(options = {}) {
  const nowMs = Math.max(0, toInt(options.nowMs, Date.now()));
  const origins = new Set(["universe_dungeon", SOV_GUARANTEED_SITE_ORIGIN]);
  const seen = new Set();
  const orphans = [];
  const byReason = { missing_spawn_profile: 0, missing_template: 0 };
  const affectedSystemIDs = new Set();
  let scannedCount = 0;
  for (const lifecycleState of ["seeded", "active", "paused", "completed", "failed", "despawned"]) {
    for (const instance of dungeonRuntime.listInstancesByLifecycle(lifecycleState, { full: true })) {
      const instanceID = Math.max(0, toInt(instance && instance.instanceID, 0));
      if (instanceID <= 0 || seen.has(instanceID)) {
        continue;
      }
      seen.add(instanceID);
      if (!(instance.runtimeFlags && instance.runtimeFlags.universeSeeded === true)) {
        continue;
      }
      if (!origins.has(normalizeLowerText(instance.siteOrigin, ""))) {
        continue;
      }
      scannedCount += 1;
      const spawnFamilyKey = getInstanceSpawnFamilyKey(instance);
      let reason = null;
      if (spawnFamilyKey && !dungeonAuthority.getSpawnProfile(spawnFamilyKey)) {
        reason = "missing_spawn_profile";
      } else if (!dungeonAuthority.getTemplateByID(normalizeText(instance.templateID, ""))) {
        reason = "missing_template";
      }
      if (!reason) {
        continue;
      }
      byReason[reason] += 1;
      affectedSystemIDs.add(Math.max(0, toInt(instance.solarSystemID, 0)));
      orphans.push({ instanceID, templateID: normalizeText(instance.templateID, ""), spawnFamilyKey, reason });
    }
  }
  const purge = orphans.length > 0
    ? dungeonRuntime.purgeInstances(orphans.map((orphan) => orphan.instanceID), {
      source: "resetStartupOrphanedUniverseSites",
    })
    : { removedCount: 0, removedInstanceIDs: [] };
  return {
    nowMs,
    scannedCount,
    orphanedCount: orphans.length,
    purgedCount: Math.max(0, toInt(purge && purge.removedCount, 0)),
    purgedInstanceIDs: Array.isArray(purge && purge.removedInstanceIDs) ? purge.removedInstanceIDs : [],
    byReason,
    orphans,
    affectedSystemIDs: [...affectedSystemIDs].filter((systemID) => systemID > 0).sort((left, right) => left - right),
  };
}

function listSovereigntyGuaranteedSpawnFamilies() {
  return [...SOV_GUARANTEED_SPAWN_FAMILIES];
}

function isSovereigntyGuaranteedSpawnFamily(family) {
  return SOV_GUARANTEED_FAMILY_SET.has(normalizeLowerText(family, ""));
}

function getSystemSecurityStatus(systemID) {
  const systemRecord = worldData.getSolarSystemByID(systemID) || null;
  return toFiniteNumber(
    systemRecord && (systemRecord.securityStatus ?? systemRecord.security),
    0,
  );
}

function isDroneRegionSystem(systemID) {
  const systemRecord = worldData.getSolarSystemByID(systemID) || null;
  return DRONE_REGION_IDS.has(toInt(systemRecord && systemRecord.regionID, 0));
}

function resolveThreatDetectionSecurityBracket(systemID) {
  const security = Math.max(-1, Math.min(0, getSystemSecurityStatus(systemID)));
  const table = isDroneRegionSystem(systemID)
    ? THREAT_DETECTION_TABLE.drone
    : THREAT_DETECTION_TABLE.pirate;
  return table.find((entry) => (
    security >= entry.minSecurity &&
    (
      security < entry.maxSecurity ||
      (entry.maxSecurity === 0 && security <= 0)
    )
  )) || table[table.length - 1];
}

function parseNumberedUpgradeName(name, pattern) {
  const match = pattern.exec(normalizeText(name, ""));
  if (!match) {
    return null;
  }
  return {
    kind: normalizeLowerText(match[1], ""),
    tier: Math.max(1, Math.min(3, toInt(match[2], 1))),
  };
}

function parseThreatDetectionUpgrade(upgrade) {
  const parsed = parseNumberedUpgradeName(
    upgrade && upgrade.name,
    /\b(minor|major)\s+threat detection array\s+([123])\b/i,
  );
  if (!parsed || !["minor", "major"].includes(parsed.kind)) {
    return null;
  }
  return {
    ...parsed,
    category: "threat_detection",
    upgrade,
  };
}

function parseProspectingUpgrade(upgrade) {
  const match = /\b([a-z]+)\s+prospecting array\s+([123])\b/i
    .exec(normalizeText(upgrade && upgrade.name, ""));
  if (!match) {
    return null;
  }
  const mineral = normalizeLowerText(match[1], "");
  if (!PROSPECTING_MINERAL_ORE_NAMES[mineral]) {
    return null;
  }
  return {
    category: "prospecting",
    mineral,
    tier: Math.max(1, Math.min(3, toInt(match[2], 1))),
    upgrade,
  };
}

function parseExplorationDetectorUpgrade(upgrade) {
  const parsed = parseNumberedUpgradeName(
    upgrade && upgrade.name,
    /\b(exploration detector)\s+([123])\b/i,
  );
  if (!parsed) {
    return null;
  }
  return {
    category: "exploration_detector",
    kind: "exploration_detector",
    tier: parsed.tier,
    upgrade,
  };
}

function listParsedOnlineUpgrades(context, parser) {
  const normalized = dungeonSiteSpawnPolicy.normalizePolicyContext(context);
  const byKey = new Map();
  for (const parsed of normalized.sovereignty.onlineUpgrades
    .map((upgrade) => parser(upgrade))
    .filter(Boolean)) {
    const key = [
      parsed.category,
      parsed.kind || parsed.mineral || "",
      parsed.tier,
      toInt(parsed.upgrade && parsed.upgrade.typeID, 0),
    ].join(":");
    if (!byKey.has(key)) {
      byKey.set(key, parsed);
    }
  }
  return [...byKey.values()]
    .sort((left, right) => (
      normalizeText(left.kind || left.mineral, "").localeCompare(normalizeText(right.kind || right.mineral, ""))
    ) || (left.tier - right.tier) || (
      toInt(left.upgrade && left.upgrade.typeID, 0) - toInt(right.upgrade && right.upgrade.typeID, 0)
    ));
}

function expandSlotCounts(entries = []) {
  const slots = [];
  for (const entry of entries) {
    const label = normalizeText(entry && entry[0], "");
    const count = Math.max(0, toInt(entry && entry[1], 0));
    for (let index = 0; label && index < count; index += 1) {
      slots.push({
        label,
        occurrence: index + 1,
      });
    }
  }
  return slots;
}

function classifyCombatAnomalyTemplate(template) {
  // Match whole words only. A plain substring test read "Angel Hidden Hideaway"
  // as a Den, because "hidden" contains "den".
  const words = ` ${normalizeLowerText(
    template && (template.resolvedName || template.name || template.templateID),
    "",
  ).replace(/[^a-z0-9]+/g, " ").trim()} `;
  for (const label of COMBAT_ANOMALY_LABELS) {
    const normalizedLabel = normalizeLowerText(label, "");
    if (!normalizedLabel || normalizedLabel === "teeming drone horde") {
      continue;
    }
    if (words.includes(` ${normalizedLabel} `)) {
      return label;
    }
  }
  return "";
}

function listCombatAnomalyTemplatesForLabel(label, options = {}) {
  const normalizedLabel = normalizeLowerText(label, "");
  if (!combatAnomalyTemplatesByLabelCache.has(normalizedLabel)) {
    const lookupLabel = normalizedLabel === "teeming drone horde"
      ? "drone horde"
      : normalizedLabel;
    // Classify on the authority's small selection descriptors, then hydrate
    // only the matches. Cloning the whole combat family (room graphs and
    // all) for each new label held the event loop for over 30 s when a Hub
    // first brought in a Major and a Minor Threat Detection Array.
    const templates = Object.freeze(dungeonAuthority
      .listTemplateSelectionDescriptorsByFamily("combat")
      .filter((template) => normalizeLowerText(template && template.siteKind, "") === "anomaly")
      .filter((template) => normalizeLowerText(classifyCombatAnomalyTemplate(template), "") === lookupLabel)
      .map((descriptor) => dungeonAuthority.getTemplateByID(descriptor.templateID))
      .filter(Boolean)
      .sort((left, right) => (
        toInt(left && left.sourceDungeonID, Number.MAX_SAFE_INTEGER) -
        toInt(right && right.sourceDungeonID, Number.MAX_SAFE_INTEGER)
      ) || String(left && left.templateID || "").localeCompare(String(right && right.templateID || ""))));
    combatAnomalyTemplatesByLabelCache.set(normalizedLabel, templates);
  }
  const templates = combatAnomalyTemplatesByLabelCache.get(normalizedLabel);
  const systemID = Math.max(0, toInt(options.systemID, 0));
  if (systemID <= 0) {
    return templates;
  }
  const band = normalizeSecurityBand(options.band || getSecurityBand(systemID));
  const spawnFamilyKey = normalizeLowerText(
    options.spawnFamilyKey,
    "sov_threat_detection",
  );
  const policyContext = options.policyContext ||
    buildTemplatePolicyContext(spawnFamilyKey, systemID, band);
  const allowed = templates.filter((template) => {
    const evaluation = evaluateTemplateSpawnPolicy(
      template,
      spawnFamilyKey,
      systemID,
      band,
      policyContext,
      options.policyOptions || {},
    );
    return evaluation && evaluation.allowed !== false;
  });
  // Prefer the client's own dungeons. The eve-university templates are research
  // placeholders with no client dungeon ID, so a site built from one reaches the
  // sensor overlay with dungeonID 0 and no name. Keep them only for a site the
  // pinned client data does not cover.
  const clientDungeons = allowed.filter((template) => toInt(template && template.sourceDungeonID, 0) > 0);
  return Object.freeze(clientDungeons.length > 0 ? clientDungeons : allowed);
}

function pickDeterministicTemplate(candidates, seedText) {
  const list = Array.isArray(candidates) ? candidates : [];
  if (list.length <= 0) {
    return null;
  }
  return list[hashText(seedText) % list.length] || list[0] || null;
}

function prospectingSizeTermsForTier(tier) {
  switch (Math.max(1, Math.min(3, toInt(tier, 1)))) {
    case 1:
      return ["small", ""];
    case 2:
      return ["", "large", "average"];
    case 3:
      return ["large", "enormous", ""];
    default:
      return [""];
  }
}

function listProspectingOreTemplates(mineral, tier) {
  const cacheKey = `${normalizeLowerText(mineral, "")}:${Math.max(1, Math.min(3, toInt(tier, 1)))}`;
  if (prospectingOreTemplatesByKeyCache.has(cacheKey)) {
    return prospectingOreTemplatesByKeyCache.get(cacheKey);
  }
  const oreNames = PROSPECTING_MINERAL_ORE_NAMES[normalizeLowerText(mineral, "")] || [];
  const sizeTerms = prospectingSizeTermsForTier(tier);
  const candidates = dungeonAuthority
    .listTemplatesByFamily("ore")
    .filter((template) => normalizeLowerText(template && template.siteKind, "") === "anomaly")
    // Reference-only ore templates cannot supply the client's localized anomaly
    // name. Keep them out of both initial prospecting slots and later rotations.
    .filter((template) => (
      toInt(template && template.sourceDungeonID, 0) > 0 &&
      toInt(template && template.dungeonNameID, 0) > 0
    ))
    .filter((template) => {
      const name = normalizeLowerText(template && (template.resolvedName || template.name || ""), "");
      return oreNames.some((oreName) => name.includes(normalizeLowerText(oreName, "")));
    })
    .sort((left, right) => {
      const leftName = normalizeLowerText(left && (left.resolvedName || left.name), "");
      const rightName = normalizeLowerText(right && (right.resolvedName || right.name), "");
      const leftRank = sizeTerms.findIndex((term) => term === "" || leftName.includes(term));
      const rightRank = sizeTerms.findIndex((term) => term === "" || rightName.includes(term));
      return (
        (leftRank < 0 ? Number.MAX_SAFE_INTEGER : leftRank) -
        (rightRank < 0 ? Number.MAX_SAFE_INTEGER : rightRank)
      ) || (
        toInt(left && left.sourceDungeonID, Number.MAX_SAFE_INTEGER) -
        toInt(right && right.sourceDungeonID, Number.MAX_SAFE_INTEGER)
      ) || String(left && left.templateID || "").localeCompare(String(right && right.templateID || ""));
    });
  const result = Object.freeze(candidates);
  prospectingOreTemplatesByKeyCache.set(cacheKey, result);
  return result;
}

function getStargateAdjacency() {
  if (stargateAdjacencyCache) {
    return stargateAdjacencyCache;
  }
  const adjacency = new Map();
  for (const system of worldData.getSolarSystems()) {
    const systemID = toInt(system && system.solarSystemID, 0);
    if (systemID > 0 && !adjacency.has(systemID)) {
      adjacency.set(systemID, new Set());
    }
  }
  for (const systemID of adjacency.keys()) {
    for (const gate of worldData.getStargatesForSystem(systemID)) {
      const destinationSystemID = toInt(gate && gate.destinationSolarSystemID, 0);
      if (destinationSystemID <= 0) {
        continue;
      }
      if (!adjacency.has(destinationSystemID)) {
        adjacency.set(destinationSystemID, new Set());
      }
      adjacency.get(systemID).add(destinationSystemID);
      adjacency.get(destinationSystemID).add(systemID);
    }
  }
  stargateAdjacencyCache = adjacency;
  return stargateAdjacencyCache;
}

function listSystemJumpDistances(sourceSystemID, maxJumps) {
  const source = toInt(sourceSystemID, 0);
  const limit = Math.max(0, toInt(maxJumps, 0));
  if (source <= 0) {
    return new Map();
  }
  const adjacency = getStargateAdjacency();
  const visited = new Map([[source, 0]]);
  const queue = [source];
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index];
    const jumps = visited.get(current) || 0;
    if (jumps >= limit) {
      continue;
    }
    for (const next of adjacency.get(current) || []) {
      if (visited.has(next)) {
        continue;
      }
      visited.set(next, jumps + 1);
      queue.push(next);
    }
  }
  return visited;
}

function listSystemsWithinJumps(sourceSystemID, maxJumps) {
  return [...listSystemJumpDistances(sourceSystemID, maxJumps).entries()]
    .filter(([systemID]) => getSecurityBand(systemID) === "nullsec")
    .sort((left, right) => (left[1] - right[1]) || (left[0] - right[0]))
    .map(([systemID, jumps]) => ({
      systemID,
      jumps,
    }));
}

/**
 * Builds the spawn-policy context for one family in one system.
 *
 * The runtime branch reads sovereignty claim, hub and development state, each of
 * which loads and clones the whole sovereignty table. Those are per-system facts,
 * but this is called once per family, so callers planning several families for the
 * same system should pass a Map as `systemContextCache` to share the result.
 *
 * The cache is deliberately caller-scoped rather than module-level: sovereignty
 * state changes over time, and a per-call memo has no staleness to reason about.
 */
function buildTemplatePolicyContext(family, systemID, band, systemContextCache = null) {
  const normalizedFamily = normalizeLowerText(family, "");
  const spawnProfile = dungeonAuthority.getSpawnProfileReadOnly(normalizedFamily);
  if (
    normalizeLowerText(spawnProfile && spawnProfile.selectionAuthority, "") ===
    STRICT_SECURITY_ORE_SELECTION_AUTHORITY
  ) {
    return dungeonSiteSpawnPolicy.normalizePolicyContext({
      securityBand: band,
    });
  }
  // Wormhole space needs the system's class placement for every family; other
  // unruled families keep the minimal context.
  if (
    normalizeSecurityBand(band) !== "wormhole" &&
    !dungeonSiteSpawnPolicy.isRuledSpawnFamily(family) &&
    !dungeonSiteSpawnPolicy.isLocallyScopedPirateSpawnFamily(family)
  ) {
    return dungeonSiteSpawnPolicy.normalizePolicyContext({
      securityBand: band,
    });
  }
  const numericSystemID = Math.max(0, toInt(systemID, 0));
  if (systemContextCache && systemContextCache.has(numericSystemID)) {
    return systemContextCache.get(numericSystemID);
  }
  const context = dungeonSiteSpawnPolicy.buildRuntimeSystemPolicyContext(numericSystemID, {
    securityBand: band,
  });
  if (systemContextCache) {
    systemContextCache.set(numericSystemID, context);
  }
  return context;
}

function buildPolicyCandidateCacheKey(family, systemID, band, bandProfile, policyContext, policyOptions = {}) {
  const normalizedContext = dungeonSiteSpawnPolicy.normalizePolicyContext({
    ...(policyContext || {}),
    securityBand: band,
  });
  const upgradeCategories = ["exploration_detector", "prospecting", "threat_detection"]
    .filter((category) => dungeonSiteSpawnPolicy.hasOnlineUpgradeCategory(normalizedContext, category));
  const spawnProfile = dungeonAuthority.getSpawnProfileReadOnly(family);
  const selectionAuthority = normalizeLowerText(spawnProfile && spawnProfile.selectionAuthority, "");
  const oreSecurityTier = selectionAuthority === STRICT_SECURITY_ORE_SELECTION_AUTHORITY
    ? oreAnomalySecurityAuthority.resolveSecurityTierForSystemID(systemID)
    : null;
  // K-space gas is region- and constellation-locked, so its candidates differ
  // between systems that share every other key field.
  const selectsGas = Boolean(spawnProfile && spawnProfile.templateFilters &&
    Array.isArray(spawnProfile.templateFilters.siteFamilies) &&
    spawnProfile.templateFilters.siteFamilies.includes("gas"));
  const gasSystem = selectsGas && normalizeSecurityBand(band) !== "wormhole"
    ? worldData.getSolarSystemByID(systemID)
    : null;
  return JSON.stringify({
    policyVersion: dungeonSiteSpawnPolicy.POLICY_VERSION,
    gasPlacement: gasSystem
      ? [toInt(gasSystem.regionID, 0), toInt(gasSystem.constellationID, 0)]
      : null,
    factionClassifierVersion: Math.max(
      0,
      toInt(dungeonSiteSpawnPolicy.getPolicyDescriptor().factionClassifierVersion, 0),
    ),
    family: normalizeLowerText(family, "unknown"),
    band: normalizeSecurityBand(band),
    selectionAuthority: selectionAuthority || null,
    factionScope: normalizeLowerText(spawnProfile && spawnProfile.factionScope, "") || null,
    wormholeFactionScope: normalizeLowerText(spawnProfile && spawnProfile.wormholeFactionScope, "") || null,
    requireConcreteLocalPirateFaction: Boolean(spawnProfile && spawnProfile.requireConcreteLocalPirateFaction === true),
    oreSecurityAuthorityVersion: oreSecurityTier
      ? oreAnomalySecurityAuthority.AUTHORITY_VERSION
      : null,
    oreSecurityTier,
    difficultyRange: normalizeDifficultyRange(bandProfile && bandProfile.difficultyRange),
    localPirateFactionKey: normalizedContext.localPirateFactionKey,
    localPirateFactionSource: normalizedContext.localPirateFactionSource,
    localPirateFactionSpecialSpace: normalizedContext.localPirateFactionSpecialSpace === true,
    wormholeSiteClasses: normalizedContext.wormhole ? [...normalizedContext.wormhole.siteClasses] : null,
    wormholeShattered: Boolean(normalizedContext.wormhole && normalizedContext.wormhole.shattered),
    reviewedNeutralTemplateIDs: [...new Set(
      (Array.isArray(policyOptions.reviewedNeutralTemplateIDs)
        ? policyOptions.reviewedNeutralTemplateIDs
        : [])
        .map((entry) => normalizeText(entry, ""))
        .filter(Boolean),
    )].sort((left, right) => left.localeCompare(right)),
    enforceSovereigntyUpgrades: policyOptions.enforceSovereigntyUpgrades,
    hasSovereignty: normalizedContext.sovereignty.hasSovereignty === true,
    hasHub: Boolean(normalizedContext.sovereignty.hubID),
    upgradeCategories,
    systemID: normalizedContext.sovereignty.hasSovereignty === true
      ? Math.max(0, toInt(systemID, 0))
      : 0,
  });
}

function listPolicyEligibleTemplateDescriptorsForBand(
  family,
  systemID,
  band,
  bandProfile,
  policyContext,
  policyOptions = {},
) {
  const cacheKey = buildPolicyCandidateCacheKey(
    family,
    systemID,
    band,
    bandProfile,
    policyContext,
    policyOptions,
  );
  if (policyEligibleTemplateCandidatesCache.has(cacheKey)) {
    return policyEligibleTemplateCandidatesCache.get(cacheKey);
  }
  const spawnProfile = dungeonAuthority.getSpawnProfileReadOnly(family);
  const selectionAuthority = normalizeLowerText(spawnProfile && spawnProfile.selectionAuthority, "");
  const candidates = selectionAuthority === STRICT_SECURITY_ORE_SELECTION_AUTHORITY
    ? oreAnomalySecurityAuthority
      .listAllowedTemplateIDs(
        oreAnomalySecurityAuthority.resolveSecurityTierForSystemID(systemID),
      )
      .map((templateID) => dungeonAuthority.getTemplateSelectionDescriptorByID(templateID))
      .filter(Boolean)
    : listFamilyTemplatesForBand(family, band, bandProfile);
  const eligible = Object.freeze(candidates
    .map((descriptor) => ({
      descriptor,
      evaluation: evaluateTemplateSpawnPolicy(
        descriptor,
        family,
        systemID,
        band,
        policyContext,
        policyOptions,
      ),
    }))
    .filter((entry) => entry.evaluation && entry.evaluation.allowed !== false));
  policyEligibleTemplateCandidatesCache.set(cacheKey, eligible);
  return eligible;
}

function hydrateTemplateSelection(selection) {
  const descriptor = selection && selection.descriptor;
  if (!descriptor || !descriptor.templateID) {
    return null;
  }
  const template = dungeonAuthority.getTemplateByID(descriptor.templateID);
  if (!template) {
    return null;
  }
  return {
    template,
    evaluation: selection.evaluation || null,
  };
}

// This compatibility boundary intentionally returns full templates.  Runtime
// planning uses the descriptor-only function above and hydrates only the
// selected entry; callers of the established helper keep their old contract.
function listPolicyEligibleTemplatesForBand(family, systemID, band, bandProfile, policyContext, policyOptions = {}) {
  return Object.freeze(listPolicyEligibleTemplateDescriptorsForBand(
    family,
    systemID,
    band,
    bandProfile,
    policyContext,
    policyOptions,
  )
    .map(hydrateTemplateSelection)
    .filter(Boolean));
}

function buildOreAllocationError(code, details = {}) {
  const error = new Error(`${code}: ${JSON.stringify(details)}`);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function allocateOreTemplatesForSystem(options = {}) {
  return oreAnomalySecurityAuthority.allocateTemplatesForSystem(options);
}

function createOreSecurityTelemetryCounters() {
  return {
    oreSecurityAuthorityVersion: oreAnomalySecurityAuthority.AUTHORITY_VERSION,
    oreEligibleSystems: 0,
    oreIneligibleTierSystems: 0,
    oreRetainedByAuthority: 0,
    oreReplacedWrongSecurity: 0,
    oreReplacedDuplicate: 0,
    oreAuthorityValidationErrors: 0,
  };
}

function buildOreSecurityTelemetry(systemIDs, configuredCount) {
  const summary = createOreSecurityTelemetryCounters();
  const validation = oreAnomalySecurityAuthority.validateAuthority({ configuredCount });
  summary.oreAuthorityValidationErrors = validation.errors.length;
  if (!validation.valid) {
    const error = new Error(
      `ORE_ANOMALY_SECURITY_AUTHORITY_INVALID: ${JSON.stringify(validation.errors)}`,
    );
    error.code = "ORE_ANOMALY_SECURITY_AUTHORITY_INVALID";
    error.validation = validation;
    throw error;
  }
  for (const systemID of normalizeSystemIDs(systemIDs)) {
    const tier = oreAnomalySecurityAuthority.resolveSecurityTierForSystemID(systemID);
    if (oreAnomalySecurityAuthority.isEligibleSecurityTier(tier)) {
      summary.oreEligibleSystems += 1;
    } else {
      summary.oreIneligibleTierSystems += 1;
    }
  }
  return summary;
}

function recordOreAllocationTelemetry(summary, assignment) {
  if (!summary || !assignment) {
    return;
  }
  switch (normalizeLowerText(assignment.allocationReason, "")) {
    case "retained_allowed_unique_template":
      summary.oreRetainedByAuthority += 1;
      break;
    case "replaced_wrong_security_template":
      summary.oreReplacedWrongSecurity += 1;
      break;
    case "replaced_duplicate_template":
      summary.oreReplacedDuplicate += 1;
      break;
    default:
      break;
  }
}

function pickUniverseTemplateDescriptorForSlotWithPolicy(
  family,
  systemID,
  slotIndex,
  rotationIndex,
  band,
  bandProfile,
  options = {},
) {
  const policyContext =
    options.policyContext ||
    buildTemplatePolicyContext(family, systemID, band);
  const policyOptions = options.policyOptions || {};
  const eligible = listPolicyEligibleTemplateDescriptorsForBand(
    family,
    systemID,
    band,
    bandProfile,
    policyContext,
    policyOptions,
  );
  if (eligible.length <= 0) {
    return null;
  }
  const templateIndex = hashValue(
    (toInt(systemID, 0) * 4099) +
    (slotIndex * 131) +
    (Math.max(0, toInt(rotationIndex, 0)) * 17) +
    hashText(family),
  ) % eligible.length;
  return eligible[templateIndex] || eligible[0] || null;
}

function pickUniverseTemplateForSlotWithPolicy(
  family,
  systemID,
  slotIndex,
  rotationIndex,
  band,
  bandProfile,
  options = {},
) {
  return hydrateTemplateSelection(pickUniverseTemplateDescriptorForSlotWithPolicy(
    family,
    systemID,
    slotIndex,
    rotationIndex,
    band,
    bandProfile,
    options,
  ));
}

function pickRandomArrayIndex(length, rng = random) {
  const size = Math.max(0, toInt(length, 0));
  if (size <= 0) {
    return -1;
  }
  const randomValue = Number(typeof rng === "function" ? rng() : random());
  return Math.max(
    0,
    Math.min(size - 1, Math.floor((Number.isFinite(randomValue) ? randomValue : random()) * size)),
  );
}

function pickRandomArrayEntry(entries, rng = random) {
  const values = Array.isArray(entries) ? entries : [];
  const index = pickRandomArrayIndex(values.length, rng);
  if (index < 0) {
    return null;
  }
  return values[index] || values[0] || null;
}

function pickRandomUniverseTemplateDescriptorForSlotWithPolicy(
  family,
  systemID,
  slotIndex,
  rotationIndex,
  band,
  bandProfile,
  options = {},
) {
  const policyContext =
    options.policyContext ||
    buildTemplatePolicyContext(family, systemID, band);
  const policyOptions = options.policyOptions || {};
  const eligible = listPolicyEligibleTemplateDescriptorsForBand(
    family,
    systemID,
    band,
    bandProfile,
    policyContext,
    policyOptions,
  );
  if (eligible.length <= 0) {
    return null;
  }
  return pickRandomArrayEntry(eligible, options.rng) || eligible[0] || null;
}

function pickRandomUniverseTemplateForSlotWithPolicy(
  family,
  systemID,
  slotIndex,
  rotationIndex,
  band,
  bandProfile,
  options = {},
) {
  return hydrateTemplateSelection(pickRandomUniverseTemplateDescriptorForSlotWithPolicy(
    family,
    systemID,
    slotIndex,
    rotationIndex,
    band,
    bandProfile,
    options,
  ));
}

function buildLightweightRoomStates(nowMs) {
  return {
    "room:entry": {
      roomKey: "room:entry",
      state: "active",
      stage: "entry",
      pocketID: null,
      nodeGraphID: null,
      activatedAtMs: nowMs,
      completedAtMs: 0,
      lastUpdatedAtMs: nowMs,
      spawnedEntityIDs: [],
      counters: {},
      metadata: {
        lightweight: true,
      },
    },
  };
}

function pickUniverseTemplateForSlot(family, systemID, slotIndex, rotationIndex, band, bandProfile) {
  const selection = pickUniverseTemplateForSlotWithPolicy(
    family,
    systemID,
    slotIndex,
    rotationIndex,
    band,
    bandProfile,
  );
  return selection && selection.template || null;
}

function buildUniverseSiteDefinition(template, family, systemID, slotIndex, options = {}) {
  const spawnFamilyKey = normalizeLowerText(options.spawnFamilyKey, family);
  const siteID = buildUniverseSiteID(spawnFamilyKey, systemID, slotIndex);
  if (siteID <= 0) {
    return null;
  }
  const rotationIndex = Math.max(0, toInt(options.rotationIndex, 0));
  const startedAtMs = Math.max(0, toInt(options.startedAtMs, Date.now()));
  const lifetimeMs = Math.max(60_000, toInt(options.lifetimeMs, resolveSiteLifetimeMs(1440)));
  const band = normalizeLowerText(options.band, getSecurityBand(systemID));
  const siteKind = normalizeLowerText(template && template.siteKind, "signature");
  const providerID = getUniverseSiteProviderID(siteKind);
  const placement = buildUniverseSitePlacement(systemID, spawnFamilyKey, slotIndex, rotationIndex);
  const position = placement.position;
  const templateSiteFamily = normalizeLowerText(template && template.siteFamily, normalizeLowerText(family, "unknown"));
  const entryObjectTypeID = Math.max(
    0,
    toInt(
      template && template.entryObjectTypeID,
      siteKind === "anomaly" ? COSMIC_ANOMALY_TYPE_ID : COSMIC_SIGNATURE_TYPE_ID,
    ),
  ) || (siteKind === "anomaly" ? COSMIC_ANOMALY_TYPE_ID : COSMIC_SIGNATURE_TYPE_ID);
  const groupID = siteKind === "anomaly" ? COSMIC_ANOMALY_GROUP_ID : COSMIC_SIGNATURE_GROUP_ID;
  const label = normalizeText(options.label, resolveUniverseSiteLabel(template, spawnFamilyKey, slotIndex));
  const expiresAtMs = startedAtMs + lifetimeMs;
  const siteKey = dungeonSiteAdapter.buildSiteKey(providerID, systemID, siteID);
  const customMetadata = normalizeObject(options.metadata);
  const customSpawnState = normalizeObject(options.spawnState);
  const customRuntimeFlags = normalizeObject(options.runtimeFlags);
  const spawnProfile = dungeonAuthority.getSpawnProfileReadOnly(spawnFamilyKey);
  const siteOrigin = normalizeLowerText(
    options.siteOrigin,
    normalizeLowerText(
      spawnProfile && spawnProfile.siteOrigin,
      "universe_dungeon",
    ),
  );
  const spawnPolicy = dungeonSiteSpawnPolicy.buildSelectionMetadata(
    options.spawnPolicyEvaluation ||
    evaluateTemplateSpawnPolicy(
      template,
      spawnFamilyKey,
      systemID,
      band,
      options.policyContext || {},
      options.policyOptions || {},
    ),
  );
  const metadata = {
    providerID,
    definitionHash: JSON.stringify({
      family: templateSiteFamily,
      spawnFamilyKey,
      siteID,
      slotIndex,
      rotationIndex,
      templateID: template.templateID,
      siteKind,
      position: [
        Math.round(toFiniteNumber(position && position.x, 0)),
        Math.round(toFiniteNumber(position && position.y, 0)),
        Math.round(toFiniteNumber(position && position.z, 0)),
      ],
      anchorItemID: toInt(placement && placement.anchorItemID, 0),
      anchorDistanceMeters: Math.round(toFiniteNumber(placement && placement.anchorDistanceMeters, 0)),
      spawnPolicy,
      templateContentHash: hashText(JSON.stringify({
        contentPack: cloneValue(template && template._contentPack || null),
        populationHints: cloneValue(template && template.populationHints || null),
        environmentTemplates: cloneValue(template && template.environmentTemplates || null),
        objectiveMetadata: cloneValue(template && template.objectiveMetadata || null),
        siteSceneProfile: cloneValue(template && template.siteSceneProfile || null),
      })),
      discriminator: cloneValue(options.definitionDiscriminator || null),
    }),
    siteID,
    slotIndex: Math.max(0, toInt(slotIndex, 0)),
    rotationIndex,
    spawnFamilyKey,
    securityBand: band,
    label,
    universeSeededAtMs: startedAtMs,
    anchorItemID: toInt(placement && placement.anchorItemID, 0) || null,
    anchorDistanceMeters: Math.round(toFiniteNumber(placement && placement.anchorDistanceMeters, 0)),
    anchorDistanceAu: Number(toFiniteNumber(placement && placement.anchorDistanceAu, 0).toFixed(3)),
    spawnPolicy,
    ...cloneValue(customMetadata),
  };

  return {
    templateID: template.templateID,
    solarSystemID: toInt(systemID, 0),
    siteKey,
    lifecycleState: "active",
    instanceScope: "shared",
    siteFamily: templateSiteFamily,
    siteKind,
    siteOrigin,
    position,
    nowMs: startedAtMs,
    activatedAtMs: startedAtMs,
    expiresAtMs,
    roomStatesByKey: buildLightweightRoomStates(startedAtMs),
    gateStatesByKey: {},
    objectiveState: {
      state: "pending",
      currentNodeID: null,
      currentObjectiveID: null,
      completedObjectiveIDs: [],
      completedNodeIDs: [],
      counters: {},
      metadata: {
        lightweight: true,
      },
    },
    environmentState: {
      seededAtMs: startedAtMs,
      templateRef: template.templateID,
      lightweight: true,
    },
    spawnState: {
      siteID,
      slotIndex: Math.max(0, toInt(slotIndex, 0)),
      rotationIndex,
      spawnFamilyKey,
      label,
      groupID,
      entryObjectTypeID,
      securityBand: band,
      lifetimeMs,
      anchorItemID: toInt(placement && placement.anchorItemID, 0) || null,
      anchorDistanceMeters: Math.round(toFiniteNumber(placement && placement.anchorDistanceMeters, 0)),
      anchorDistanceAu: Number(toFiniteNumber(placement && placement.anchorDistanceAu, 0).toFixed(3)),
      populationHints: cloneValue(template && template.populationHints || null),
      spawnPolicy,
      ...cloneValue(customSpawnState),
    },
    runtimeFlags: {
      universeSeeded: true,
      universePersistent: true,
      lazyMaterialized: true,
      ...cloneValue(customRuntimeFlags),
    },
    metadata,
  };
}

function buildSovSpawnPolicyEvaluation(policyKey, upgradeCategory, sourceRefs, extra = {}) {
  const localPirateEvaluation = extra.localPirateEvaluation &&
    typeof extra.localPirateEvaluation === "object"
    ? extra.localPirateEvaluation
    : null;
  return {
    allowed: true,
    reason: normalizeText(
      localPirateEvaluation && localPirateEvaluation.reason,
      normalizeText(extra.reason, "allowed_by_online_sov_hub_upgrade"),
    ),
    policyKey,
    securityBand: "nullsec",
    siteFamily: normalizeLowerText(extra.siteFamily, ""),
    siteKind: normalizeLowerText(extra.siteKind, ""),
    requiredBands: ["nullsec"],
    requiredUpgradeCategory: upgradeCategory,
    localPirateFactionKey: normalizeLowerText(
      localPirateEvaluation && localPirateEvaluation.localPirateFactionKey,
      "",
    ) || null,
    localPirateFactionSource: normalizeLowerText(
      localPirateEvaluation && localPirateEvaluation.localPirateFactionSource,
      "",
    ) || null,
    localPirateFactionSpecialSpace:
      localPirateEvaluation && localPirateEvaluation.localPirateFactionSpecialSpace === true,
    templatePirateFactionKeys: Array.isArray(
      localPirateEvaluation && localPirateEvaluation.templatePirateFactionKeys,
    )
      ? [...localPirateEvaluation.templatePirateFactionKeys]
      : [],
    factionClassifierVersion: Math.max(
      0,
      toInt(localPirateEvaluation && localPirateEvaluation.factionClassifierVersion, 0),
    ),
    reviewedNeutralOverride:
      localPirateEvaluation && localPirateEvaluation.reviewedNeutralOverride === true,
    sourceRefs: [...new Set([
      ...(Array.isArray(sourceRefs) ? sourceRefs : []),
      ...(Array.isArray(localPirateEvaluation && localPirateEvaluation.sourceRefs)
        ? localPirateEvaluation.sourceRefs
        : []),
    ])],
    assumptions: [...new Set([
      ...(Array.isArray(extra.assumptions) ? extra.assumptions : []),
      ...(Array.isArray(localPirateEvaluation && localPirateEvaluation.assumptions)
        ? localPirateEvaluation.assumptions
        : []),
    ])],
    tags: [
      "sov_hub",
      "guaranteed",
      ...(Array.isArray(extra.tags) ? extra.tags : []),
      ...(Array.isArray(localPirateEvaluation && localPirateEvaluation.tags)
        ? localPirateEvaluation.tags
        : []),
    ],
  };
}

function buildSovGuaranteedDefinition(
  template,
  spawnFamilyKey,
  targetSystemID,
  slotIndex,
  nowMs,
  sovHub,
  options = {},
) {
  if (!template || !template.templateID || !sovHub) {
    return null;
  }
  const band = getSecurityBand(targetSystemID);
  if (band !== "nullsec") {
    return null;
  }
  const rotationIndex = Math.max(0, toInt(options.rotationIndex, 0));
  const sourceRefs = Array.isArray(sovHub.sourceRefs)
    ? [...sovHub.sourceRefs]
    : ["ccpSovHub"];
  return buildUniverseSiteDefinition(template, spawnFamilyKey, targetSystemID, slotIndex, {
    spawnFamilyKey,
    rotationIndex,
    startedAtMs: Math.max(0, toInt(nowMs, Date.now())),
    lifetimeMs: resolveSiteLifetimeMs(options.siteLifetimeMinutes || 1440),
    band,
    siteOrigin: SOV_GUARANTEED_SITE_ORIGIN,
    label: normalizeText(options.label, normalizeText(template.resolvedName, template.name)),
    policyContext: options.policyContext,
    spawnPolicyEvaluation: buildSovSpawnPolicyEvaluation(
      normalizeText(options.policyKey, `${spawnFamilyKey}_guaranteed`),
      normalizeText(sovHub.upgradeCategory, ""),
      sourceRefs,
      {
        siteFamily: template.siteFamily,
        siteKind: template.siteKind,
        tags: options.tags,
        assumptions: options.assumptions,
        localPirateEvaluation: options.localPirateEvaluation,
      },
    ),
    metadata: {
      sovHub: cloneValue(sovHub),
      sourceRefs,
    },
    spawnState: {
      sovHub: cloneValue(sovHub),
    },
    runtimeFlags: {
      sovereigntyGuaranteed: true,
    },
    definitionDiscriminator: {
      sovHub,
      rotationIndex,
    },
  });
}

function allocateSovSlotIndex(slotAllocations, spawnFamilyKey, targetSystemID) {
  const key = `${normalizeLowerText(spawnFamilyKey, "")}:${toInt(targetSystemID, 0)}`;
  const nextIndex = Math.max(0, toInt(slotAllocations.get(key), 0));
  slotAllocations.set(key, nextIndex + 1);
  return nextIndex;
}

function getSovSlotKey(spawnFamilyKey, targetSystemID, slotIndex) {
  return [
    normalizeLowerText(spawnFamilyKey, ""),
    Math.max(0, toInt(targetSystemID, 0)),
    Math.max(0, toInt(slotIndex, 0)),
  ].join(":");
}

function resolveDesiredSovSlotRotationIndex(
  options,
  spawnFamilyKey,
  targetSystemID,
  slotIndex,
) {
  const existingRotationBySlot = options && options.existingRotationBySlot instanceof Map
    ? options.existingRotationBySlot
    : null;
  const slotKey = getSovSlotKey(spawnFamilyKey, targetSystemID, slotIndex);
  if (existingRotationBySlot && existingRotationBySlot.has(slotKey)) {
    return Math.max(0, toInt(existingRotationBySlot.get(slotKey), 0));
  }
  return Math.max(0, toInt(options && options.rotationIndex, 0));
}

function buildThreatDetectionDefinitionsForSystem(systemID, context, nowMs, slotAllocations, options = {}) {
  const definitions = [];
  const normalizedContext = dungeonSiteSpawnPolicy.normalizePolicyContext(context);
  if (
    normalizedContext.sovereignty.hasSovereignty !== true ||
    !normalizedContext.sovereignty.hubID ||
    getSecurityBand(systemID) !== "nullsec"
  ) {
    return definitions;
  }

  const bracket = resolveThreatDetectionSecurityBracket(systemID);
  const upgrades = listParsedOnlineUpgrades(normalizedContext, parseThreatDetectionUpgrade);
  for (const upgrade of upgrades) {
    const entries = bracket && bracket[upgrade.kind] && bracket[upgrade.kind][upgrade.tier]
      ? bracket[upgrade.kind][upgrade.tier]
      : [];
    const slots = expandSlotCounts(entries);
    for (const slot of slots) {
      const slotIndex = allocateSovSlotIndex(slotAllocations, "sov_threat_detection", systemID);
      const rotationIndex = resolveDesiredSovSlotRotationIndex(
        options,
        "sov_threat_detection",
        systemID,
        slotIndex,
      );
      const template = pickDeterministicTemplate(
        listCombatAnomalyTemplatesForLabel(slot.label, {
          systemID,
          band: "nullsec",
          spawnFamilyKey: "sov_threat_detection",
          policyContext: normalizedContext,
          policyOptions: options.policyOptions,
        }),
        `sov-threat:${systemID}:${upgrade.kind}:${upgrade.tier}:${slot.label}:${slot.occurrence}:${rotationIndex}`,
      );
      if (!template) {
        continue;
      }
      const localPirateEvaluation = evaluateTemplateSpawnPolicy(
        template,
        "sov_threat_detection",
        systemID,
        "nullsec",
        normalizedContext,
        options.policyOptions || {},
      );
      if (!localPirateEvaluation || localPirateEvaluation.allowed === false) {
        continue;
      }
      const sovHub = {
        provider: "sov_hub",
        upgradeCategory: "threat_detection",
        upgradeKind: upgrade.kind,
        upgradeTier: upgrade.tier,
        upgradeTypeID: toInt(upgrade.upgrade && upgrade.upgrade.typeID, 0) || null,
        upgradeName: normalizeText(upgrade.upgrade && upgrade.upgrade.name, ""),
        sourceSystemID: systemID,
        sourceHubID: normalizedContext.sovereignty.hubID,
        targetSystemID: systemID,
        jumpsFromSource: 0,
        ccpSecurityBracket: bracket && bracket.key,
        ccpSiteLabel: slot.label,
        ccpSlotOccurrence: slot.occurrence,
        sourceRefs: ["ccpSovHubCombatAnomalies"],
      };
      const definition = buildSovGuaranteedDefinition(
        template,
        "sov_threat_detection",
        systemID,
        slotIndex,
        nowMs,
        sovHub,
        {
          rotationIndex,
          policyKey: "sov_threat_detection_guaranteed",
          label: normalizeText(template.resolvedName, slot.label),
          tags: ["threat_detection"],
          policyContext: normalizedContext,
          localPirateEvaluation,
        },
      );
      if (definition) {
        definitions.push(definition);
      }
    }
  }
  return definitions;
}

function buildProspectingDefinitionsForSystem(systemID, context, nowMs, slotAllocations, options = {}) {
  const definitions = [];
  const normalizedContext = dungeonSiteSpawnPolicy.normalizePolicyContext(context);
  if (
    normalizedContext.sovereignty.hasSovereignty !== true ||
    !normalizedContext.sovereignty.hubID ||
    getSecurityBand(systemID) !== "nullsec"
  ) {
    return definitions;
  }

  const upgrades = listParsedOnlineUpgrades(normalizedContext, parseProspectingUpgrade);
  for (const upgrade of upgrades) {
    const slotIndex = allocateSovSlotIndex(slotAllocations, "sov_prospecting", systemID);
    const rotationIndex = resolveDesiredSovSlotRotationIndex(
      options,
      "sov_prospecting",
      systemID,
      slotIndex,
    );
    const template = pickDeterministicTemplate(
      listProspectingOreTemplates(upgrade.mineral, upgrade.tier),
      `sov-prospecting:${systemID}:${upgrade.mineral}:${upgrade.tier}:${rotationIndex}`,
    );
    if (!template) {
      continue;
    }
    const sovHub = {
      provider: "sov_hub",
      upgradeCategory: "prospecting",
      mineral: upgrade.mineral,
      upgradeTier: upgrade.tier,
      upgradeTypeID: toInt(upgrade.upgrade && upgrade.upgrade.typeID, 0) || null,
      upgradeName: normalizeText(upgrade.upgrade && upgrade.upgrade.name, ""),
      sourceSystemID: systemID,
      sourceHubID: normalizedContext.sovereignty.hubID,
      targetSystemID: systemID,
      jumpsFromSource: 0,
      sourceRefs: ["ccpSovHub", "ccpEquinoxSovUpdates"],
    };
    const definition = buildSovGuaranteedDefinition(
      template,
      "sov_prospecting",
      systemID,
      slotIndex,
      nowMs,
      sovHub,
      {
        rotationIndex,
        policyKey: "sov_prospecting_guaranteed",
        label: normalizeText(template.resolvedName, `${upgrade.mineral} Prospecting Site`),
        tags: ["prospecting"],
        assumptions: [
          "CCP publishes prospecting upgrade categories; the emulator maps each online mineral prospecting upgrade to one active ore anomaly slot.",
        ],
      },
    );
    if (definition) {
      definitions.push(definition);
    }
  }
  return definitions;
}

function listSovereigntySourceSystemIDs() {
  try {
    return sovState.listAllAllianceSystems()
      .map((entry) => toInt(entry && entry.solarSystemID, 0))
      .filter((entry) => entry > 0)
      .sort((left, right) => left - right);
  } catch (_) {
    // ignored: no sovereignty data means no sov source systems
    return [];
  }
}

function pickExplorationDetectorTarget(sourceSystemID, tier, slotOrdinal) {
  const candidates = listSystemsWithinJumps(sourceSystemID, 5);
  if (candidates.length <= 0) {
    return null;
  }
  const offset = hashValue(
    (sourceSystemID * 6151) +
    (Math.max(1, toInt(tier, 1)) * 313) +
    (Math.max(0, toInt(slotOrdinal, 0)) * 37),
  ) % candidates.length;
  return candidates[offset] || candidates[0] || null;
}

function pickExplorationDetectorTemplate(
  family,
  sourceSystemID,
  targetSystemID,
  tier,
  slotOrdinal,
  rotationIndex,
  policyOptions = {},
) {
  const band = getSecurityBand(targetSystemID);
  const policyContext = buildTemplatePolicyContext(family, targetSystemID, band);
  const candidates = dungeonAuthority
    .listTemplatesByFamily(family)
    .filter((template) => normalizeLowerText(template && template.siteKind, "") === "signature")
    .filter((template) => !isMissionOnlyUniverseTemplate(template))
    .filter((template) => {
      const evaluation = evaluateTemplateSpawnPolicy(
        template,
        family,
        targetSystemID,
        band,
        policyContext,
        policyOptions,
      );
      return evaluation && evaluation.allowed !== false;
    })
    .sort((left, right) => (
      toInt(left && left.sourceDungeonID, Number.MAX_SAFE_INTEGER) -
      toInt(right && right.sourceDungeonID, Number.MAX_SAFE_INTEGER)
    ) || String(left && left.templateID || "").localeCompare(String(right && right.templateID || "")));
  return pickDeterministicTemplate(
    candidates,
    `sov-exploration:${sourceSystemID}:${targetSystemID}:${family}:${tier}:${slotOrdinal}:${rotationIndex || 0}`,
  );
}

function buildExplorationDetectorDefinitions(targetSystemIDs, nowMs, slotAllocations, options = {}) {
  const targetSet = new Set(normalizeSystemIDs(targetSystemIDs));
  const definitions = [];
  for (const sourceSystemID of listSovereigntySourceSystemIDs()) {
    const context = dungeonSiteSpawnPolicy.buildRuntimeSystemPolicyContext(sourceSystemID, {
      securityBand: getSecurityBand(sourceSystemID),
      nowMs,
    });
    const normalizedContext = dungeonSiteSpawnPolicy.normalizePolicyContext(context);
    if (
      normalizedContext.sovereignty.hasSovereignty !== true ||
      !normalizedContext.sovereignty.hubID ||
      getSecurityBand(sourceSystemID) !== "nullsec"
    ) {
      continue;
    }
    const upgrades = listParsedOnlineUpgrades(normalizedContext, parseExplorationDetectorUpgrade);
    for (const upgrade of upgrades) {
      const slotCount = Math.max(1, Math.min(3, upgrade.tier));
      for (let slotOrdinal = 0; slotOrdinal < slotCount; slotOrdinal += 1) {
        const target = pickExplorationDetectorTarget(sourceSystemID, upgrade.tier, slotOrdinal);
        if (!target || !targetSet.has(target.systemID)) {
          continue;
        }
        const family = EXPLORATION_DETECTOR_FAMILY_SEQUENCE[
          slotOrdinal % EXPLORATION_DETECTOR_FAMILY_SEQUENCE.length
        ];
        const slotIndex = allocateSovSlotIndex(
          slotAllocations,
          "sov_exploration_detector",
          target.systemID,
        );
        const rotationIndex = resolveDesiredSovSlotRotationIndex(
          options,
          "sov_exploration_detector",
          target.systemID,
          slotIndex,
        );
        const template = pickExplorationDetectorTemplate(
          family,
          sourceSystemID,
          target.systemID,
          upgrade.tier,
          slotOrdinal,
          rotationIndex,
          options.policyOptions || {},
        );
        if (!template) {
          continue;
        }
        const targetBand = getSecurityBand(target.systemID);
        const targetPolicyContext = buildTemplatePolicyContext(
          family,
          target.systemID,
          targetBand,
        );
        const localPirateEvaluation = evaluateTemplateSpawnPolicy(
          template,
          family,
          target.systemID,
          targetBand,
          targetPolicyContext,
          options.policyOptions || {},
        );
        if (!localPirateEvaluation || localPirateEvaluation.allowed === false) {
          continue;
        }
        const sovHub = {
          provider: "sov_hub",
          upgradeCategory: "exploration_detector",
          upgradeTier: upgrade.tier,
          upgradeTypeID: toInt(upgrade.upgrade && upgrade.upgrade.typeID, 0) || null,
          upgradeName: normalizeText(upgrade.upgrade && upgrade.upgrade.name, ""),
          sourceSystemID,
          sourceHubID: normalizedContext.sovereignty.hubID,
          targetSystemID: target.systemID,
          jumpsFromSource: target.jumps,
          detectorSlotOrdinal: slotOrdinal,
          sourceRefs: ["ccpSovHub", "ccpEquinoxSovUpdates"],
        };
        const definition = buildSovGuaranteedDefinition(
          template,
          "sov_exploration_detector",
          target.systemID,
          slotIndex,
          nowMs,
          sovHub,
          {
            rotationIndex,
            policyKey: "sov_exploration_detector_guaranteed",
            label: normalizeText(template.resolvedName, "Exploration Detector Signature"),
            tags: ["exploration_detector"],
            assumptions: [
              "CCP documents Exploration Detector effects within zero to five jumps; target systems are deterministic within that range.",
            ],
            policyContext: targetPolicyContext,
            localPirateEvaluation,
          },
        );
        if (definition) {
          definitions.push(definition);
        }
      }
    }
  }
  return definitions;
}

function summarizeSovDefinitions(definitions, families) {
  for (const definition of definitions) {
    const family = normalizeLowerText(
      definition && definition.metadata && definition.metadata.spawnFamilyKey,
      normalizeLowerText(definition && definition.spawnState && definition.spawnState.spawnFamilyKey, ""),
    );
    if (!family) {
      continue;
    }
    if (!families[family]) {
      families[family] = {
        desiredSiteCount: 0,
        systemsTouched: 0,
        templateCount: 0,
      };
    }
    families[family].desiredSiteCount += 1;
  }
  for (const family of Object.keys(families)) {
    const systems = new Set(definitions
      .filter((definition) => (
        normalizeLowerText(definition && definition.metadata && definition.metadata.spawnFamilyKey, "") === family
      ))
      .map((definition) => toInt(definition && definition.solarSystemID, 0))
      .filter((entry) => entry > 0));
    families[family].systemsTouched = systems.size;
  }
}

// Site definitions stamp spawnFamilyKey, slotIndex and rotationIndex into
// metadata at creation, so these read metadata and fall back only to the
// instance's own siteFamily. The old spawnState fallbacks were dead: nothing
// writes those fields, and no instance in a live table resolved through them.
function getInstanceSpawnFamilyKey(instance) {
  return normalizeLowerText(
    instance && instance.metadata && instance.metadata.spawnFamilyKey,
    normalizeLowerText(instance && instance.siteFamily, ""),
  );
}

function getInstanceSlotIndex(instance) {
  return Math.max(0, toInt(instance && instance.metadata && instance.metadata.slotIndex, 0));
}

function getInstanceRotationIndex(instance) {
  return Math.max(0, toInt(instance && instance.metadata && instance.metadata.rotationIndex, 0));
}

function chooseRandomSystemIDs(systemIDs, count, rng = random) {
  const remaining = normalizeIntegerArray(systemIDs);
  const target = Math.max(0, Math.min(remaining.length, toInt(count, 0)));
  const picked = [];
  while (picked.length < target && remaining.length > 0) {
    const index = pickRandomArrayIndex(remaining.length, rng);
    if (index < 0) {
      break;
    }
    const entry = remaining[index];
    picked.push(entry);
    const last = remaining.pop();
    if (index < remaining.length) {
      remaining[index] = last;
    }
  }
  return picked.sort((left, right) => left - right);
}

function buildExistingSovRotationBySlot(systemIDs) {
  const rotations = new Map();
  const instanceIDsBySlot = new Map();
  for (const instance of listUniverseSeededPersistentSiteInstances(systemIDs)) {
    if (normalizeLowerText(instance && instance.siteOrigin, "") !== SOV_GUARANTEED_SITE_ORIGIN) {
      continue;
    }
    const spawnFamilyKey = getInstanceSpawnFamilyKey(instance);
    if (!isSovereigntyGuaranteedSpawnFamily(spawnFamilyKey)) {
      continue;
    }
    const systemID = Math.max(0, toInt(instance && instance.solarSystemID, 0));
    const slotIndex = getInstanceSlotIndex(instance);
    const slotKey = getSovSlotKey(spawnFamilyKey, systemID, slotIndex);
    const instanceID = Math.max(0, toInt(instance && instance.instanceID, 0));
    if (
      instanceIDsBySlot.has(slotKey) &&
      instanceIDsBySlot.get(slotKey) <= instanceID
    ) {
      continue;
    }
    instanceIDsBySlot.set(slotKey, instanceID);
    rotations.set(slotKey, getInstanceRotationIndex(instance));
  }
  return rotations;
}

function preserveRepairedProspectingDefinition(definition) {
  if (getInstanceSpawnFamilyKey(definition) !== "sov_prospecting") {
    return definition;
  }
  const existing = dungeonRuntimeState.findInstanceSummaryBySiteKey(definition.siteKey);
  const marker = existing && existing.metadata && existing.metadata.sovProspectingNameRepair;
  if (
    !existing || !dungeonRuntimeState.isActiveLifecycleState(existing.lifecycleState) ||
    existing.runtimeFlags?.universeSeeded !== true ||
    normalizeLowerText(existing.siteOrigin, "") !== SOV_GUARANTEED_SITE_ORIGIN ||
    getInstanceSpawnFamilyKey(existing) !== "sov_prospecting" ||
    normalizeLowerText(existing.siteFamily, "") !== "ore" ||
    normalizeLowerText(existing.siteKind, "") !== "anomaly" ||
    !normalizeText(existing.templateID, "").startsWith("eve-university:") ||
    marker?.version !== 1 ||
    !Number.isSafeInteger(marker.dungeonNameID) || marker.dungeonNameID <= 0 ||
    existing.dungeonNameID !== marker.dungeonNameID ||
    !normalizeText(existing.metadata.definitionHash, "") ||
    getInstanceRotationIndex(existing) !== getInstanceRotationIndex(definition)
  ) {
    return definition;
  }

  // The repair changes presentation only. Retain its original population and
  // definition hash while this exact online upgrade still owns the slot. A
  // removed/replaced upgrade must retain the ordinary reconciliation behavior.
  const previousHub = normalizeObject(existing.metadata.sovHub);
  const desiredHub = normalizeObject(definition.metadata && definition.metadata.sovHub);
  const hubNumberFields = [
    "sourceHubID", "sourceSystemID", "targetSystemID", "upgradeTypeID", "upgradeTier",
  ];
  if (
    hubNumberFields.some((field) => (
      toInt(previousHub[field], 0) <= 0 ||
      toInt(previousHub[field], 0) !== toInt(desiredHub[field], 0)
    )) ||
    normalizeLowerText(previousHub.upgradeCategory, "") !== "prospecting" ||
    normalizeLowerText(previousHub.mineral, "") !== normalizeLowerText(desiredHub.mineral, "")
  ) {
    return definition;
  }

  const original = dungeonAuthority.getTemplateByIDReadOnly(existing.templateID);
  const client = dungeonAuthority.getTemplateByIDReadOnly(marker.clientTemplateID);
  if (
    !original || original.siteFamily !== "ore" || original.siteKind !== "anomaly" ||
    !isValidSovProspectingClientNameTemplate(client) ||
    getSovProspectingRepairTemplateName(original) !== getSovProspectingRepairTemplateName(client) ||
    client.dungeonNameID !== marker.dungeonNameID
  ) {
    return definition;
  }
  return dungeonRuntime.getInstance(existing.instanceID) || definition;
}

function listDesiredSovereigntyDungeonSiteDefinitions(systemIDs = null, nowMs = Date.now(), options = {}) {
  const targetSystemIDs = normalizeSystemIDs(systemIDs);
  const familyFilter = new Set((Array.isArray(options.families) ? options.families : [])
    .map((entry) => normalizeLowerText(entry, ""))
    .filter(Boolean));
  const includeFamily = (family) => familyFilter.size <= 0 || familyFilter.has(family);
  const definitions = [];
  const families = {};
  const slotAllocations = new Map();
  const sovOptions = {
    ...options,
    existingRotationBySlot: options.existingRotationBySlot instanceof Map
      ? options.existingRotationBySlot
      : buildExistingSovRotationBySlot(targetSystemIDs),
  };

  if (includeFamily("sov_threat_detection") || includeFamily("sov_prospecting")) {
    for (const systemID of targetSystemIDs) {
      if (getSecurityBand(systemID) !== "nullsec") {
        continue;
      }
      const context = dungeonSiteSpawnPolicy.buildRuntimeSystemPolicyContext(systemID, {
        securityBand: "nullsec",
        nowMs,
      });
      if (includeFamily("sov_threat_detection")) {
        definitions.push(...buildThreatDetectionDefinitionsForSystem(
          systemID,
          context,
          nowMs,
          slotAllocations,
          sovOptions,
        ));
      }
      if (includeFamily("sov_prospecting")) {
        definitions.push(...buildProspectingDefinitionsForSystem(
          systemID,
          context,
          nowMs,
          slotAllocations,
          sovOptions,
        ));
      }
    }
  }

  if (includeFamily("sov_exploration_detector")) {
    definitions.push(...buildExplorationDetectorDefinitions(
      targetSystemIDs,
      nowMs,
      slotAllocations,
      sovOptions,
    ));
  }

  const preservedDefinitions = definitions.map(preserveRepairedProspectingDefinition);
  summarizeSovDefinitions(preservedDefinitions, families);
  return {
    definitions: preservedDefinitions,
    families,
  };
}

/**
 * Builds the desired site definitions for the given systems.
 *
 * `systemIDs` is required: the plan is resolved per system, so there is no
 * meaningful "every system" mode and asking for one is what used to drag the
 * whole cluster into a single system's wake.
 */
function listDesiredUniverseDungeonSiteDefinitions(systemIDs, nowMs = Date.now(), options = {}) {
  const definitions = [];
  const allSystemIDs = normalizeSystemIDs(systemIDs);
  const familySummaries = {};
  const existingBySlot = new Map();
  const requestedFamilies = new Set(
    (Array.isArray(options.families) ? options.families : [])
      .map((family) => normalizeLowerText(family, ""))
      .filter(Boolean),
  );
  const includesOrdinaryOre = requestedFamilies.size <= 0 || requestedFamilies.has("ore");
  const oreSpawnProfile = includesOrdinaryOre
    ? dungeonAuthority.getSpawnProfileReadOnly("ore")
    : null;
  const usesStrictSecurityOreAuthority = Boolean(
    oreSpawnProfile &&
    oreSpawnProfile.enabled !== false &&
    normalizeLowerText(oreSpawnProfile.selectionAuthority, "") ===
      STRICT_SECURITY_ORE_SELECTION_AUTHORITY
  );
  const oreSecurity = usesStrictSecurityOreAuthority
    ? buildOreSecurityTelemetry(allSystemIDs, resolveConfiguredSiteCount("ore"))
    : null;

  if (allSystemIDs.length <= 0) {
    return {
      definitions,
      families: familySummaries,
      oreSecurity,
    };
  }

  // The one state read: which slots this system already fills, so an existing
  // site keeps its template instead of being rerolled on every wake.
  for (const instance of listUniverseSeededPersistentSiteInstances(allSystemIDs)) {
    if (normalizeLowerText(instance && instance.siteOrigin, "") !== "universe_dungeon") {
      continue;
    }
    const spawnFamilyKey = getInstanceSpawnFamilyKey(instance);
    const systemID = Math.max(0, toInt(instance && instance.solarSystemID, 0));
    const slotIndex = getInstanceSlotIndex(instance);
    if (!spawnFamilyKey || systemID <= 0) {
      continue;
    }
    const key = `${spawnFamilyKey}:${systemID}:${slotIndex}`;
    const existing = existingBySlot.get(key);
    if (
      !existing ||
      Math.max(0, toInt(instance && instance.instanceID, 0)) <
        Math.max(0, toInt(existing && existing.instanceID, 0))
    ) {
      existingBySlot.set(key, instance);
    }
  }

  for (const systemID of allSystemIDs) {
    // Shared across every family planned for this system; see
    // buildTemplatePolicyContext for why it is scoped to this call.
    const systemContextCache = new Map();
    for (const entry of resolveSystemSitePlan(systemID, { families: options.families })) {
      const { family, band, count, lifetimeMs, bandTuning, selectionAuthority } = entry;
      if (!familySummaries[family]) {
        familySummaries[family] = {
          desiredSiteCount: 0,
          systemsTouched: 0,
          templateCount: selectionAuthority === STRICT_SECURITY_ORE_SELECTION_AUTHORITY
            ? oreAnomalySecurityAuthority.countEligibleTemplatesForSystem(systemID)
            : listTemplateCandidatesForSpawnFamily(family).length,
        };
      }
      const policyContext = buildTemplatePolicyContext(family, systemID, band, systemContextCache);
      let systemDefinitionCount = 0;
      if (selectionAuthority === STRICT_SECURITY_ORE_SELECTION_AUTHORITY) {
        const existingSlots = [];
        for (let slotIndex = 0; slotIndex < count; slotIndex += 1) {
          const existing = existingBySlot.get(`${family}:${systemID}:${slotIndex}`) || null;
          if (existing) {
            existingSlots.push(existing);
          }
        }
        const allocation = allocateOreTemplatesForSystem({
          systemID,
          configuredCount: count,
          existingSlots,
        });
        for (const assignment of allocation.assignments) {
          recordOreAllocationTelemetry(oreSecurity, assignment);
          const { slotIndex, rotationIndex, template } = assignment;
          const evaluation = evaluateTemplateSpawnPolicy(
            template,
            family,
            systemID,
            band,
            policyContext,
            options.policyOptions || {},
          );
          if (!evaluation || evaluation.allowed === false) {
            throw buildOreAllocationError("ORE_SECURITY_POLICY_REJECTED_AUTHORITY_TEMPLATE", {
              systemID,
              securityTier: allocation.securityTier,
              slotIndex,
              templateID: template && template.templateID,
              policyReason: evaluation && evaluation.reason,
            });
          }
          const definition = buildUniverseSiteDefinition(template, family, systemID, slotIndex, {
            rotationIndex,
            startedAtMs: Math.max(0, toInt(nowMs, Date.now())),
            lifetimeMs,
            band,
            policyContext,
            spawnPolicyEvaluation: evaluation,
            metadata: {
              oreSecurityTier: allocation.securityTier,
              oreAllocationReason: assignment.allocationReason,
              oreSecurityAuthorityVersion: oreAnomalySecurityAuthority.AUTHORITY_VERSION,
            },
          });
          if (!definition) {
            throw buildOreAllocationError("ORE_SECURITY_DEFINITION_BUILD_FAILED", {
              systemID,
              securityTier: allocation.securityTier,
              slotIndex,
              templateID: template && template.templateID,
            });
          }
          definitions.push(definition);
          familySummaries[family].desiredSiteCount += 1;
          systemDefinitionCount += 1;
        }
        if (systemDefinitionCount > 0) {
          familySummaries[family].systemsTouched += 1;
        }
        continue;
      }
      for (let slotIndex = 0; slotIndex < count; slotIndex += 1) {
        const existing = existingBySlot.get(`${family}:${systemID}:${slotIndex}`) || null;
        const rotationIndex = existing ? getInstanceRotationIndex(existing) : 0;
        let templateDescriptor = existing && existing.templateID
          ? dungeonAuthority.getTemplateSelectionDescriptorByID(existing.templateID)
          : null;
        if (
          templateDescriptor &&
          !templateMatchesSpawnFamily(templateDescriptor, family, bandTuning)
        ) {
          templateDescriptor = null;
        }
        let evaluation = templateDescriptor
          ? evaluateTemplateSpawnPolicy(
            templateDescriptor,
            family,
            systemID,
            band,
            policyContext,
            options.policyOptions || {},
          )
          : null;
        if (evaluation && evaluation.allowed === false) {
          templateDescriptor = null;
          evaluation = null;
        }
        if (!templateDescriptor) {
          const selection = pickUniverseTemplateDescriptorForSlotWithPolicy(
            family,
            systemID,
            slotIndex,
            rotationIndex,
            band,
            bandTuning,
            {
              policyContext,
              policyOptions: options.policyOptions,
            },
          );
          templateDescriptor = selection && selection.descriptor || null;
          evaluation = selection && selection.evaluation || null;
        }
        const template = templateDescriptor && templateDescriptor.templateID
          ? dungeonAuthority.getTemplateByIDReadOnly(templateDescriptor.templateID)
          : null;
        if (!template) {
          continue;
        }
        const definition = buildUniverseSiteDefinition(template, family, systemID, slotIndex, {
          rotationIndex,
          startedAtMs: Math.max(0, toInt(nowMs, Date.now())),
          lifetimeMs,
          band,
          policyContext,
          spawnPolicyEvaluation: evaluation,
        });
        if (!definition) {
          continue;
        }
        definitions.push(definition);
        familySummaries[family].desiredSiteCount += 1;
        systemDefinitionCount += 1;
      }
      if (systemDefinitionCount > 0) {
        familySummaries[family].systemsTouched += 1;
      }
    }
  }

  const sovResult = listDesiredSovereigntyDungeonSiteDefinitions(allSystemIDs, nowMs, {
    ...options,
    families: Array.isArray(options.families) ? options.families : [],
  });
  definitions.push(...sovResult.definitions);
  for (const [family, summary] of Object.entries(sovResult.families || {})) {
    familySummaries[family] = summary;
  }

  return {
    definitions,
    families: familySummaries,
    oreSecurity,
  };
}

function buildGeneratedMiningRotationDefinitionFromInstance(instance, nowMs = Date.now()) {
  if (
    !instance ||
    normalizeLowerText(instance && instance.siteOrigin, "") !== "generatedmining"
  ) {
    return null;
  }
  const family = normalizeLowerText(instance.siteFamily, "ice");
  const systemID = Math.max(0, toInt(instance.solarSystemID, 0));
  const slotIndex = Math.max(
    0,
    toInt(
      instance.metadata && instance.metadata.slotIndex,
      instance.spawnState && instance.spawnState.slotIndex,
    ),
  );
  const currentRotationIndex = Math.max(
    0,
    toInt(
      instance.metadata && instance.metadata.rotationIndex,
      instance.spawnState && instance.spawnState.rotationIndex,
    ),
  );
  const nextRotationIndex = currentRotationIndex + 1;
  const definition = miningResourceSiteService.buildGeneratedResourceSiteDefinition(
    systemID,
    family,
    slotIndex,
    {
      rotationIndex: nextRotationIndex,
    },
  );
  if (!definition) {
    return null;
  }
  return enrichGeneratedMiningDefinition(definition, nowMs, {
    slotIndex,
    rotationIndex: nextRotationIndex,
    startedAtMs: Math.max(0, toInt(nowMs, Date.now())),
    lifetimeMs: resolveGeneratedMiningSiteLifetimeMs(),
  });
}

function buildSovereigntyRotationDefinitionFromInstance(
  instance,
  nowMs = Date.now(),
  options = {},
) {
  if (!instance) {
    return null;
  }
  const spawnFamilyKey = normalizeLowerText(
    instance && instance.metadata && instance.metadata.spawnFamilyKey,
    normalizeLowerText(instance && instance.spawnState && instance.spawnState.spawnFamilyKey, ""),
  );
  if (!isSovereigntyGuaranteedSpawnFamily(spawnFamilyKey)) {
    return null;
  }
  const sovHub = normalizeObject(
    instance && instance.metadata && instance.metadata.sovHub,
  );
  const sourceSystemID = Math.max(0, toInt(sovHub.sourceSystemID, 0));
  const targetSystemID = Math.max(0, toInt(instance && instance.solarSystemID, 0));
  const slotIndex = Math.max(
    0,
    toInt(
      instance.metadata && instance.metadata.slotIndex,
      instance.spawnState && instance.spawnState.slotIndex,
    ),
  );
  const currentRotationIndex = Math.max(
    0,
    toInt(
      instance.metadata && instance.metadata.rotationIndex,
      instance.spawnState && instance.spawnState.rotationIndex,
    ),
  );
  const nextRotationIndex = currentRotationIndex + 1;
  if (sourceSystemID <= 0 || targetSystemID <= 0 || getSecurityBand(targetSystemID) !== "nullsec") {
    return null;
  }

  const context = dungeonSiteSpawnPolicy.buildRuntimeSystemPolicyContext(sourceSystemID, {
    securityBand: getSecurityBand(sourceSystemID),
  });
  const normalizedContext = dungeonSiteSpawnPolicy.normalizePolicyContext(context);
  if (
    normalizedContext.sovereignty.hasSovereignty !== true ||
    !normalizedContext.sovereignty.hubID
  ) {
    return null;
  }

  let template = null;
  let localPirateEvaluation = null;
  let targetPolicyContext = null;
  if (spawnFamilyKey === "sov_threat_detection") {
    const upgrades = listParsedOnlineUpgrades(normalizedContext, parseThreatDetectionUpgrade);
    const matchingUpgrade = upgrades.find((upgrade) => (
      upgrade.kind === normalizeLowerText(sovHub.upgradeKind, "") &&
      upgrade.tier === Math.max(1, toInt(sovHub.upgradeTier, 1))
    ));
    if (!matchingUpgrade || sourceSystemID !== targetSystemID) {
      return null;
    }
    targetPolicyContext = buildTemplatePolicyContext(
      "sov_threat_detection",
      targetSystemID,
      "nullsec",
    );
    template = pickDeterministicTemplate(
      listCombatAnomalyTemplatesForLabel(sovHub.ccpSiteLabel, {
        systemID: targetSystemID,
        band: "nullsec",
        spawnFamilyKey: "sov_threat_detection",
        policyContext: targetPolicyContext,
        policyOptions: options.policyOptions,
      }),
      `sov-threat:${targetSystemID}:${sovHub.upgradeKind}:${sovHub.upgradeTier}:${sovHub.ccpSiteLabel}:${sovHub.ccpSlotOccurrence}:${nextRotationIndex}`,
    );
  } else if (spawnFamilyKey === "sov_prospecting") {
    const upgrades = listParsedOnlineUpgrades(normalizedContext, parseProspectingUpgrade);
    const matchingUpgrade = upgrades.find((upgrade) => (
      upgrade.mineral === normalizeLowerText(sovHub.mineral, "") &&
      upgrade.tier === Math.max(1, toInt(sovHub.upgradeTier, 1))
    ));
    if (!matchingUpgrade || sourceSystemID !== targetSystemID) {
      return null;
    }
    template = pickDeterministicTemplate(
      listProspectingOreTemplates(sovHub.mineral, sovHub.upgradeTier),
      `sov-prospecting:${targetSystemID}:${sovHub.mineral}:${sovHub.upgradeTier}:${nextRotationIndex}`,
    );
  } else if (spawnFamilyKey === "sov_exploration_detector") {
    const upgrades = listParsedOnlineUpgrades(normalizedContext, parseExplorationDetectorUpgrade);
    const matchingUpgrade = upgrades.find((upgrade) => (
      upgrade.tier === Math.max(1, toInt(sovHub.upgradeTier, 1))
    ));
    const withinRange = listSystemsWithinJumps(sourceSystemID, 5)
      .some((entry) => entry.systemID === targetSystemID);
    if (!matchingUpgrade || !withinRange) {
      return null;
    }
    const family = normalizeLowerText(instance && instance.siteFamily, "data");
    template = pickExplorationDetectorTemplate(
      family,
      sourceSystemID,
      targetSystemID,
      sovHub.upgradeTier,
      sovHub.detectorSlotOrdinal,
      nextRotationIndex,
      options.policyOptions || {},
    );
    targetPolicyContext = buildTemplatePolicyContext(
      family,
      targetSystemID,
      getSecurityBand(targetSystemID),
    );
  }

  if (!template) {
    return null;
  }
  if (
    spawnFamilyKey === "sov_threat_detection" ||
    spawnFamilyKey === "sov_exploration_detector"
  ) {
    const policyFamily = spawnFamilyKey === "sov_threat_detection"
      ? "sov_threat_detection"
      : normalizeLowerText(instance && instance.siteFamily, "data");
    localPirateEvaluation = evaluateTemplateSpawnPolicy(
      template,
      policyFamily,
      targetSystemID,
      getSecurityBand(targetSystemID),
      targetPolicyContext,
      options.policyOptions || {},
    );
    if (!localPirateEvaluation || localPirateEvaluation.allowed === false) {
      return null;
    }
  }
  return buildSovGuaranteedDefinition(
    template,
    spawnFamilyKey,
    targetSystemID,
    slotIndex,
    nowMs,
    sovHub,
    {
      rotationIndex: nextRotationIndex,
      policyKey: `${spawnFamilyKey}_guaranteed`,
      label: normalizeText(template.resolvedName, instance && instance.spawnState && instance.spawnState.label),
      policyContext: targetPolicyContext,
      localPirateEvaluation,
    },
  );
}

function buildRotationDefinitionFromInstance(instance, nowMs = Date.now(), options = {}) {
  if (
    !instance ||
    !(instance.runtimeFlags && instance.runtimeFlags.universePersistent === true)
  ) {
    return null;
  }
  if (normalizeLowerText(instance && instance.siteOrigin, "") === "generatedmining") {
    return buildGeneratedMiningRotationDefinitionFromInstance(instance, nowMs);
  }
  const family = normalizeLowerText(instance.siteFamily, "");
  const spawnFamilyKey = normalizeLowerText(
    instance &&
    instance.metadata &&
    instance.metadata.spawnFamilyKey,
    normalizeLowerText(
      instance &&
      instance.spawnState &&
      instance.spawnState.spawnFamilyKey,
      family,
    ),
  );
  const systemID = Math.max(0, toInt(instance.solarSystemID, 0));
  if (isSovereigntyGuaranteedSpawnFamily(spawnFamilyKey)) {
    return buildSovereigntyRotationDefinitionFromInstance(instance, nowMs, options);
  }
  if (!spawnFamilyKey || systemID <= 0) {
    return null;
  }
  // A site rotates in place. The system's own plan decides whether this family
  // still belongs here and which templates may fill the slot.
  const planEntry = resolveSystemSitePlan(systemID, { families: [spawnFamilyKey] })
    .find((entry) => entry.family === spawnFamilyKey) || null;
  if (!planEntry) {
    return null;
  }
  const { band, bandTuning, lifetimeMs, count, selectionAuthority } = planEntry;
  const slotIndex = Math.max(
    0,
    toInt(
      instance.metadata && instance.metadata.slotIndex,
      instance.spawnState && instance.spawnState.slotIndex,
    ),
  );
  const currentRotationIndex = Math.max(
    0,
    toInt(
      instance.metadata && instance.metadata.rotationIndex,
      instance.spawnState && instance.spawnState.rotationIndex,
    ),
  );
  const nextRotationIndex = currentRotationIndex + 1;
  const policyContext = buildTemplatePolicyContext(spawnFamilyKey, systemID, band);
  if (selectionAuthority === STRICT_SECURITY_ORE_SELECTION_AUTHORITY) {
    const existingSlots = listUniverseSeededPersistentSiteInstances([systemID])
      .filter((candidate) => (
        normalizeLowerText(candidate && candidate.siteOrigin, "") === "universe_dungeon" &&
        getInstanceSpawnFamilyKey(candidate) === spawnFamilyKey &&
        getInstanceSlotIndex(candidate) !== slotIndex
      ));
    existingSlots.push(instance);
    const allocation = allocateOreTemplatesForSystem({
      systemID,
      configuredCount: count,
      existingSlots,
      rotationIndexes: {
        [slotIndex]: nextRotationIndex,
      },
      forceRotateSlotIndexes: [slotIndex],
    });
    const assignment = allocation.assignments[slotIndex] || null;
    const template = assignment && assignment.template || null;
    if (!template) {
      throw buildOreAllocationError("ORE_SECURITY_ROTATION_ASSIGNMENT_MISSING", {
        systemID,
        securityTier: allocation.securityTier,
        slotIndex,
      });
    }
    const evaluation = evaluateTemplateSpawnPolicy(
      template,
      spawnFamilyKey,
      systemID,
      band,
      policyContext,
      options.policyOptions || {},
    );
    if (!evaluation || evaluation.allowed === false) {
      throw buildOreAllocationError("ORE_SECURITY_ROTATION_POLICY_REJECTED", {
        systemID,
        securityTier: allocation.securityTier,
        slotIndex,
        templateID: template.templateID,
        policyReason: evaluation && evaluation.reason,
      });
    }
    return buildUniverseSiteDefinition(template, spawnFamilyKey, systemID, slotIndex, {
      spawnFamilyKey,
      rotationIndex: nextRotationIndex,
      startedAtMs: Math.max(0, toInt(nowMs, Date.now())),
      lifetimeMs,
      band,
      policyContext,
      spawnPolicyEvaluation: evaluation,
      metadata: {
        oreSecurityTier: allocation.securityTier,
        oreAllocationReason: assignment.allocationReason,
        oreSecurityAuthorityVersion: oreAnomalySecurityAuthority.AUTHORITY_VERSION,
      },
    });
  }
  const selection = pickUniverseTemplateDescriptorForSlotWithPolicy(
    spawnFamilyKey,
    systemID,
    slotIndex,
    nextRotationIndex,
    band,
    bandTuning,
    {
      policyContext,
      policyOptions: options.policyOptions,
      rng: random,
    },
  );
  const descriptor = selection && selection.descriptor || null;
  const template = descriptor && descriptor.templateID
    ? dungeonAuthority.getTemplateByIDReadOnly(descriptor.templateID)
    : null;
  if (!template) {
    return null;
  }
  return buildUniverseSiteDefinition(template, spawnFamilyKey, systemID, slotIndex, {
    spawnFamilyKey,
    rotationIndex: nextRotationIndex,
    startedAtMs: Math.max(0, toInt(nowMs, Date.now())),
    lifetimeMs,
    band,
    policyContext,
    spawnPolicyEvaluation: selection && selection.evaluation,
  });
}

// A universe-persistent site ID is derived from (family, system, slot) with no rotation component,
// so a rotation hands the successor the SAME site ID. handleRuntimeChange reacts to that by flushing
// the outgoing instance's parked teardown immediately -- deliberately, so stale content cannot share
// a grid with its replacement. With CLEARED_ANOMALY_ROTATION_DELAY_MS at 0 the successor arrives
// ~25 ms after the last rat dies, so that flush always wins and the occupancy grace never gets to do
// its job: the pocket, its props and the fresh wrecks vanish while the pilot is still sitting in them.
//
// The slot is not actually free until the cleared site has closed, so rotation waits for the grid to
// empty. Retail agrees -- a completed combat anomaly persists until you leave and only then goes.
//
// Lazily required and defensive: the site service is the owner of scene state and must not become a
// load-time dependency of the runtime, and a site service that cannot answer must not stall rotation.
function terminalInstanceStillHoldsItsGrid(instance) {
  const systemID = Math.max(0, toInt(instance && instance.solarSystemID, 0));
  const instanceID = Math.max(0, toInt(instance && instance.instanceID, 0));
  if (systemID <= 0 || instanceID <= 0) {
    return false;
  }
  try {
    const siteService = require(path.join(__dirname, "./dungeonUniverseSiteService"));
    return Boolean(
      siteService &&
      typeof siteService.isUniverseSiteTeardownParked === "function" &&
      siteService.isUniverseSiteTeardownParked(systemID, instanceID) === true
    );
  } catch (_error) {
    // ignored: the site service is not loaded in this process; nothing is parked
    return false;
  }
}

function shouldRotateUniversePersistentTerminalInstance(instance, nowMs) {
  if (!instance) {
    return false;
  }
  const isGeneratedMining =
    normalizeLowerText(instance && instance.siteOrigin, "") === "generatedmining";
  if (!isGeneratedMining) {
    return true;
  }
  if (normalizeLowerText(instance && instance.lifecycleReason, "") !== "depleted") {
    return true;
  }
  const respawnAtMs = Math.max(0, toInt(instance && instance.timers && instance.timers.expiresAtMs, 0));
  return respawnAtMs <= 0 || respawnAtMs <= Math.max(0, toInt(nowMs, Date.now()));
}

function getUniversePersistentLifecycleBoundariesBySystem(nowMs = Date.now(), options = {}) {
  const normalizedNowMs = Math.max(0, toInt(nowMs, Date.now()));
  const hasSystemFilter = Array.isArray(options.systemIDs);
  const scopedSystemIDs = hasSystemFilter
    ? normalizeProvidedSystemIDs(options.systemIDs)
    : [];
  if (hasSystemFilter && scopedSystemIDs.length <= 0) {
    return [];
  }
  const boundaries = new Map();
  const consider = (instance, boundaryAtMs, phase) => {
    const numericBoundaryAtMs = Math.max(0, toInt(boundaryAtMs, 0));
    const instanceID = Math.max(0, toInt(instance && instance.instanceID, 0));
    const systemID = Math.max(0, toInt(instance && instance.solarSystemID, 0));
    if (
      numericBoundaryAtMs <= 0 ||
      instanceID <= 0 ||
      systemID <= 0
    ) {
      return;
    }
    const boundary = boundaries.get(systemID);
    if (
      !boundary ||
      numericBoundaryAtMs < boundary.boundaryAtMs ||
      (
        numericBoundaryAtMs === boundary.boundaryAtMs &&
        instanceID < boundary.instanceID
      )
    ) {
      boundaries.set(systemID, {
        boundaryAtMs: numericBoundaryAtMs,
        instanceID,
        phase,
        solarSystemID: systemID,
      });
    }
  };

  // The owner projects only lifecycle scalars. A local update never clones
  // unrelated systems' metadata, encounter plans or complete instance records.
  const entries = dungeonRuntimeState.listUniversePersistentLifecycleEntries({
    systemIDs: hasSystemFilter ? scopedSystemIDs : undefined,
  });
  for (const instance of entries) {
    if (dungeonRuntimeState.isActiveLifecycleState(instance.lifecycleState)) {
      consider(
        instance,
        instance.timers && instance.timers.expiresAtMs,
        "expiry",
      );
      continue;
    }
    // A cleared site whose grid is still occupied is not ready to rotate, so it must not name the
    // boundary either: the scheduler throws if the boundary it just tried to settle is still due,
    // and advanceUniversePersistentSites skips the same instances. Both reads share one predicate
    // so they cannot disagree. drainPendingSiteTeardowns pokes a reconcile once the grid empties.
    if (terminalInstanceStillHoldsItsGrid(instance)) {
      continue;
    }
    const isDelayedGeneratedMiningRespawn =
      normalizeLowerText(instance && instance.siteOrigin, "") === "generatedmining" &&
      normalizeLowerText(instance && instance.lifecycleReason, "") === "depleted";
    if (isDelayedGeneratedMiningRespawn) {
      const timers = instance && instance.timers || {};
      consider(
        instance,
        timers.expiresAtMs ||
          timers.completedAtMs ||
          timers.lastUpdatedAtMs ||
          timers.createdAtMs ||
          normalizedNowMs,
        "respawn",
      );
      continue;
    }
    const timers = instance && instance.timers || {};
    const transitionAtMs =
      normalizeLowerText(instance && instance.lifecycleState, "") === "completed"
        ? timers.completedAtMs
        : normalizeLowerText(instance && instance.lifecycleState, "") === "failed"
          ? timers.failedAtMs
          : timers.despawnAtMs;
    consider(
      instance,
      transitionAtMs || timers.lastUpdatedAtMs || timers.createdAtMs || normalizedNowMs,
      "rotation",
    );
  }

  return [...boundaries.values()];
}

function getUniversePersistentLifecycleBoundary(nowMs = Date.now(), options = {}) {
  let boundary = null;
  for (const candidate of getUniversePersistentLifecycleBoundariesBySystem(nowMs, options)) {
    if (!boundary || candidate.boundaryAtMs < boundary.boundaryAtMs || (
      candidate.boundaryAtMs === boundary.boundaryAtMs && candidate.instanceID < boundary.instanceID
    )) {
      boundary = {
        boundaryAtMs: candidate.boundaryAtMs,
        instanceID: candidate.instanceID,
        phase: candidate.phase,
      };
    }
  }
  return boundary;
}

function listUniversePersistentTerminalSummariesBySystems(systemIDs) {
  // Entry preparation only needs local site keys, origins and respawn timers.
  // Read those fields from the system index instead of copying terminal sites
  // across the cluster before filtering them to the destination.
  return normalizeSystemIDs(systemIDs)
    .flatMap((systemID) => dungeonRuntime.listInstancesBySystem(systemID, {
      lifecycleStates: UNIVERSE_TERMINAL_LIFECYCLE_STATES,
    }))
    .filter((instance) => (
      instance.runtimeFlags &&
      instance.runtimeFlags.universePersistent === true &&
      instance.runtimeFlags.universeSeeded === true
    ))
    .sort((left, right) => toInt(left.instanceID, 0) - toInt(right.instanceID, 0));
}

function listProtectedGeneratedMiningSiteKeys(systemIDs, nowMs = Date.now()) {
  return listUniversePersistentTerminalSummariesBySystems(systemIDs)
    .filter((instance) => (
      normalizeLowerText(instance && instance.siteOrigin, "") === "generatedmining" &&
      shouldRotateUniversePersistentTerminalInstance(instance, nowMs) === false
    ))
    .map((instance) => normalizeText(instance && instance.siteKey, ""))
    .filter(Boolean);
}

function listUniversePersistentTerminalSiteKeys(systemIDs, options = {}) {
  const siteOrigins = new Set(
    (Array.isArray(options.siteOrigins) ? options.siteOrigins : [])
      .map((entry) => normalizeLowerText(entry, ""))
      .filter(Boolean),
  );
  return listUniversePersistentTerminalSummariesBySystems(systemIDs)
    .filter((instance) => (
      siteOrigins.size <= 0 ||
      siteOrigins.has(normalizeLowerText(instance && instance.siteOrigin, ""))
    ))
    .map((instance) => normalizeText(instance && instance.siteKey, ""))
    .filter(Boolean);
}

function refreshLoadedGeneratedMiningScenes(systemIDs, nowMs) {
  const targetedSystemIDs = normalizeSystemIDs(systemIDs);
  if (targetedSystemIDs.length <= 0) {
    return {
      refreshedCount: 0,
      refreshedSystemIDs: [],
    };
  }

  let runtime = null;
  try {
    runtime = require(path.join(__dirname, "../../space/runtime"));
  } catch (_) {
    return {
      refreshedCount: 0,
      refreshedSystemIDs: [],
    };
  }

  const refreshedSystemIDs = [];
  for (const systemID of targetedSystemIDs) {
    const scene =
      runtime &&
      runtime.scenes &&
      typeof runtime.scenes.get === "function"
        ? runtime.scenes.get(systemID)
        : null;
    if (!scene) {
      continue;
    }

    scene._miningRuntimeState = null;
    const resetResult = miningResourceSiteService.resetSceneGeneratedResourceSites(scene, {
      broadcast: false,
      nowMs,
    });
    scene._miningRuntimeState = null;
    if (resetResult && resetResult.success === true) {
      refreshedSystemIDs.push(systemID);
    }
  }

  return {
    refreshedCount: refreshedSystemIDs.length,
    refreshedSystemIDs,
  };
}

function advanceUniversePersistentSites(options = {}) {
  const nowMs = Math.max(0, toInt(options.nowMs, Date.now()));
  const lifecycleReason = normalizeText(options.lifecycleReason, "expired");
  const hasSystemFilter = Array.isArray(options.systemIDs);
  const scopedSystemIDs = hasSystemFilter
    ? normalizeProvidedSystemIDs(options.systemIDs)
    : null;
  if (hasSystemFilter && scopedSystemIDs.length <= 0) {
    return {
      expiredCount: 0,
      rotatedCount: 0,
      removedCount: 0,
      retiredWithoutReplacementCount: 0,
      skipped: true,
      reason: "no_awake_systems",
    };
  }
  const emitExpiryEvents =
    options.emitExpiryEvents !== false &&
    lifecycleReason !== "startup-resume";
  const expired = dungeonRuntime.tickRuntime({
    nowMs,
    lifecycleReason,
    emitChanges: emitExpiryEvents,
    systemIDs: hasSystemFilter ? scopedSystemIDs : undefined,
    universePersistentOnly: true,
  });
  const terminalSummaries = hasSystemFilter
    ? listUniversePersistentTerminalSummariesBySystems(scopedSystemIDs)
    : dungeonRuntime.listUniversePersistentTerminalInstances();
  const candidates = terminalSummaries
    .filter((instance) => shouldRotateUniversePersistentTerminalInstance(instance, nowMs))
    // Must mirror the boundary's own skip, or the scheduler settles a boundary that still names one
    // of these and throws "remains unsettled".
    .filter((instance) => !terminalInstanceStillHoldsItsGrid(instance))
    .map((instance) => dungeonRuntime.getInstance(instance.instanceID))
    .filter(Boolean);

  if (
    Math.max(0, toInt(expired && expired.expiredCount, 0)) <= 0 &&
    candidates.length <= 0
  ) {
    return {
      expiredCount: 0,
      rotatedCount: 0,
      removedCount: 0,
      retiredWithoutReplacementCount: 0,
    };
  }

  const rotations = [];
  const retirementsWithoutReplacement = [];
  const affectedGeneratedMiningSystemIDs = new Set();
  for (const instance of candidates) {
    const isGeneratedMining =
      normalizeLowerText(instance && instance.siteOrigin, "") === "generatedmining";
    if (isGeneratedMining) {
      affectedGeneratedMiningSystemIDs.add(Math.max(0, toInt(instance && instance.solarSystemID, 0)));
    }
    const nextDefinition = buildRotationDefinitionFromInstance(instance, nowMs, {
      policyOptions: options.policyOptions,
    });
    if (!nextDefinition) {
      // A terminal slot can legitimately disappear from the current plan: a
      // thinned family may no longer host this system after a policy change, a
      // Sov upgrade may have gone offline, or generated-mining authority may
      // have retired the slot. The old instance is already terminal, so leaving
      // it behind cannot preserve playable work. It only leaves the same past-
      // due boundary at the head of the single global scheduler forever.
      //
      // Retire it as a successful lifecycle outcome. If the family still ought
      // to exist, the ordinary per-system reconcile remains responsible for
      // filling the vacancy from the current plan.
      retirementsWithoutReplacement.push(instance);
      continue;
    }
    rotations.push({
      existingInstance: instance,
      nextDefinition,
    });
    if (normalizeLowerText(nextDefinition && nextDefinition.siteOrigin, "") === "generatedmining") {
      affectedGeneratedMiningSystemIDs.add(Math.max(0, toInt(nextDefinition && nextDefinition.solarSystemID, 0)));
    }
  }

  const rotationSummary = rotations.length > 0
    ? dungeonRuntime.rotateUniversePersistentInstances(rotations, { nowMs })
    : {
      rotatedCount: 0,
      removedCount: 0,
    };
  const retirementSummary = retirementsWithoutReplacement.length > 0
    ? dungeonRuntime.purgeInstances(
      retirementsWithoutReplacement.map((instance) => instance.instanceID),
      { source: "advanceUniversePersistentSites:no-replacement" },
    )
    : {
      removedCount: 0,
      removedInstanceIDs: [],
    };

  if (affectedGeneratedMiningSystemIDs.size > 0) {
    reconcileGeneratedMiningRuntimeState(
      listActiveGeneratedMiningDefinitionsFromRuntime([...affectedGeneratedMiningSystemIDs]),
      [...affectedGeneratedMiningSystemIDs],
      nowMs,
    );
    if (
      options.refreshLoadedScenes !== false &&
      Math.max(0, toInt(rotationSummary && rotationSummary.rotatedCount, 0)) > 0
    ) {
      refreshLoadedGeneratedMiningScenes([...affectedGeneratedMiningSystemIDs], nowMs);
    }
  }

  return {
    affectedSystemIDs: [...affectedGeneratedMiningSystemIDs]
      .filter((systemID) => systemID > 0)
      .sort((left, right) => left - right),
    expiredCount: Math.max(0, toInt(expired && expired.expiredCount, 0)),
    rotatedCount: Math.max(0, toInt(rotationSummary && rotationSummary.rotatedCount, 0)),
    removedCount:
      Math.max(0, toInt(rotationSummary && rotationSummary.removedCount, 0)) +
      Math.max(0, toInt(retirementSummary && retirementSummary.removedCount, 0)),
    retiredWithoutReplacementCount: Math.max(
      0,
      toInt(retirementSummary && retirementSummary.removedCount, 0),
    ),
  };
}

/** Same scoping contract as listUniverseSeededPersistentSiteInstances. */
function listUniverseSeededGeneratedMiningInstances(systemIDs) {
  if (systemIDs === null || systemIDs === undefined) {
    throw new Error("UNIVERSE_SEEDED_SITE_SCOPE_REQUIRED");
  }
  return normalizeSystemIDs(systemIDs)
    .flatMap((systemID) => dungeonRuntime.listInstancesBySystem(systemID, {
      full: true,
      lifecycleStates: UNIVERSE_SEEDED_LIFECYCLE_STATES,
    }))
    .filter((instance) => (
      instance &&
      String(instance.siteOrigin || "").trim().toLowerCase() === "generatedmining" &&
      instance.runtimeFlags &&
      instance.runtimeFlags.universeSeeded === true
    ));
}

function isStartupResetMiningAnomalyInstance(instance) {
  if (!instance || !(instance.runtimeFlags && instance.runtimeFlags.universeSeeded === true)) {
    return false;
  }
  const siteFamily = normalizeLowerText(instance && instance.siteFamily, "");
  if (siteFamily !== "ice" && siteFamily !== "ore") {
    return false;
  }
  const siteKind = normalizeLowerText(instance && instance.siteKind, "anomaly");
  if (siteKind && siteKind !== "anomaly") {
    return false;
  }
  const siteOrigin = normalizeLowerText(instance && instance.siteOrigin, "");
  if (siteFamily === "ice") {
    return siteOrigin === "generatedmining";
  }
  return (
    siteOrigin === "universe_dungeon" &&
    getInstanceSpawnFamilyKey(instance) === "ore"
  );
}

// Generated ice in any of these states no longer shows a belt, so startup
// purges it and the next system wake rebuilds the slot.
const STARTUP_TERMINAL_ICE_LIFECYCLE_STATES = new Set([
  "completed",
  "failed",
  "despawned",
]);

function listStartupResetMiningAnomalyInstances(systemIDs = null) {
  const targetedSystemIDs = new Set(normalizeSystemIDs(systemIDs));
  const byInstanceID = new Map();
  for (const lifecycleState of ["seeded", "active", "paused", "completed", "failed", "despawned"]) {
    for (const instance of dungeonRuntime.listInstancesByLifecycle(lifecycleState, { full: true })) {
      const systemID = Math.max(0, toInt(instance && instance.solarSystemID, 0));
      if (systemID <= 0 || (targetedSystemIDs.size > 0 && !targetedSystemIDs.has(systemID))) {
        continue;
      }
      if (isStartupResetMiningAnomalyInstance(instance)) {
        byInstanceID.set(Math.max(0, toInt(instance && instance.instanceID, 0)), instance);
      }
    }
  }
  return [...byInstanceID.values()].sort((left, right) => (
    toInt(left && left.solarSystemID, 0) - toInt(right && right.solarSystemID, 0) ||
    toInt(left && left.instanceID, 0) - toInt(right && right.instanceID, 0)
  ));
}

function resetStartupMiningAnomalies(options = {}) {
  const nowMs = Math.max(0, toInt(options.nowMs, Date.now()));
  const hasSystemFilter = Array.isArray(options.systemIDs);
  const targetedSystemIDs = hasSystemFilter
    ? normalizeProvidedSystemIDs(options.systemIDs)
    : null;
  const emptyOreSecurity = createOreSecurityTelemetryCounters();
  if (options.enabled === false) {
    return {
      skipped: true,
      reason: "disabled",
      purgedCount: 0,
      purgedInstanceIDs: [],
      affectedSystemIDs: [],
      desiredIceSites: 0,
      desiredOreSites: 0,
      createdInstances: 0,
      retainedInstances: 0,
      replacedInstances: 0,
      removedInstances: 0,
      miningStateRowsCreated: 0,
      miningStateRowsUpdated: 0,
      miningStateRowsRemoved: 0,
      refreshedSceneCount: 0,
      refreshedSystemIDs: [],
      ...emptyOreSecurity,
    };
  }
  if (hasSystemFilter && targetedSystemIDs.length <= 0) {
    return {
      skipped: true,
      reason: "no_startup_systems",
      purgedCount: 0,
      purgedInstanceIDs: [],
      affectedSystemIDs: [],
      desiredIceSites: 0,
      desiredOreSites: 0,
      createdInstances: 0,
      retainedInstances: 0,
      replacedInstances: 0,
      removedInstances: 0,
      miningStateRowsCreated: 0,
      miningStateRowsUpdated: 0,
      miningStateRowsRemoved: 0,
      refreshedSceneCount: 0,
      refreshedSystemIDs: [],
      ...emptyOreSecurity,
    };
  }

  const existing = listStartupResetMiningAnomalyInstances(
    hasSystemFilter ? targetedSystemIDs : options.systemIDs,
  );
  const affectedSystemIDs = new Set();
  const generatedMiningSystemIDs = new Set();
  const existingOreSystemIDs = new Set();
  const purgeCandidateIDs = [];

  for (const instance of existing) {
    const instanceID = Math.max(0, toInt(instance && instance.instanceID, 0));
    const systemID = Math.max(0, toInt(instance && instance.solarSystemID, 0));
    const family = normalizeLowerText(instance && instance.siteFamily, "");
    const origin = normalizeLowerText(instance && instance.siteOrigin, "");
    if (systemID > 0) {
      affectedSystemIDs.add(systemID);
      if (family === "ore") {
        existingOreSystemIDs.add(systemID);
      }
      if (origin === "generatedmining" || family === "ice") {
        generatedMiningSystemIDs.add(systemID);
      }
    }
    if (
      instanceID > 0 &&
      origin === "generatedmining" &&
      family === "ice" &&
      STARTUP_TERMINAL_ICE_LIFECYCLE_STATES.has(
        normalizeLowerText(instance && instance.lifecycleState, ""),
      )
    ) {
      purgeCandidateIDs.push(instanceID);
    }
  }

  // A restart is this emulator's downtime, and retail ice keeps no respawn
  // timer across downtime: "there is always an ice belt after downtime - a new
  // one or the leftovers of a not finished one" (EVE University, Ice
  // harvesting). A live generated belt therefore keeps its instance and its
  // remaining ice, while a depleted or otherwise terminal record is purged
  // here so the system's next wake rebuilds that slot fresh.
  const purgeSummary = purgeCandidateIDs.length > 0
    ? dungeonRuntime.purgeInstances(purgeCandidateIDs, {
      source: "resetStartupMiningAnomalies",
    })
    : null;
  const purgedInstanceIDs = Array.isArray(purgeSummary && purgeSummary.removedInstanceIDs)
    ? purgeSummary.removedInstanceIDs
    : [];

  const miningStateSummary = reconcileGeneratedMiningRuntimeState(
    listActiveGeneratedMiningDefinitionsFromRuntime([...generatedMiningSystemIDs]),
    [...generatedMiningSystemIDs],
    nowMs,
  );

  const oreSystemIDs = [...existingOreSystemIDs].sort((left, right) => left - right);
  const oreResult = oreSystemIDs.length > 0
    ? listDesiredUniverseDungeonSiteDefinitions(oreSystemIDs, nowMs, { families: ["ore"] })
    : { definitions: [] };
  const oreDefinitions = Array.isArray(oreResult && oreResult.definitions)
    ? oreResult.definitions
    : [];
  const oreInstanceSummary = oreDefinitions.length > 0 || oreSystemIDs.length > 0
    ? dungeonRuntime.reconcileUniverseSeededInstances(oreDefinitions, {
      systemIDs: oreSystemIDs,
      nowMs,
      spawnFamilyFilter: ["ore"],
      siteOriginFilter: ["universe_dungeon"],
    })
    : {
      createdCount: 0,
      retainedCount: 0,
      replacedCount: 0,
      removedCount: 0,
    };

  const refreshed = refreshLoadedGeneratedMiningScenes([...generatedMiningSystemIDs], nowMs);
  const oreSecurity = oreResult && oreResult.oreSecurity
    ? oreResult.oreSecurity
    : emptyOreSecurity;
  return {
    skipped: false,
    reason: "server_restart_reset",
    purgedCount: purgedInstanceIDs.length,
    purgedInstanceIDs,
    affectedSystemIDs: [...affectedSystemIDs].sort((left, right) => left - right),
    desiredIceSites: 0,
    desiredOreSites: oreDefinitions.length,
    createdInstances: Math.max(0, toInt(oreInstanceSummary && oreInstanceSummary.createdCount, 0)),
    retainedInstances: Math.max(0, toInt(oreInstanceSummary && oreInstanceSummary.retainedCount, 0)),
    replacedInstances: Math.max(0, toInt(oreInstanceSummary && oreInstanceSummary.replacedCount, 0)),
    removedInstances: Math.max(0, toInt(oreInstanceSummary && oreInstanceSummary.removedCount, 0)),
    miningStateRowsCreated: Math.max(0, toInt(miningStateSummary && miningStateSummary.createdRows, 0)),
    miningStateRowsUpdated: Math.max(0, toInt(miningStateSummary && miningStateSummary.updatedRows, 0)),
    miningStateRowsRemoved: Math.max(0, toInt(miningStateSummary && miningStateSummary.removedRows, 0)),
    refreshedSceneCount: Math.max(0, toInt(refreshed && refreshed.refreshedCount, 0)),
    refreshedSystemIDs: Array.isArray(refreshed && refreshed.refreshedSystemIDs)
      ? refreshed.refreshedSystemIDs
      : [],
    ...oreSecurity,
  };
}

function getInstanceObject(value, key) {
  return value && value[key] && typeof value[key] === "object" && !Array.isArray(value[key])
    ? value[key]
    : {};
}

function getGeneratedIceProviderID(instance) {
  const metadata = getInstanceObject(instance, "metadata");
  return normalizeLowerText(metadata.providerID, "");
}

function resolveInstanceSourceDungeonID(instance) {
  const metadata = getInstanceObject(instance, "metadata");
  const spawnState = getInstanceObject(instance, "spawnState");
  const template = dungeonAuthority.getTemplateByID(normalizeText(instance && instance.templateID, ""));
  return Math.max(
    0,
    toInt(
      instance && instance.sourceDungeonID,
      toInt(
        metadata.sourceDungeonID,
        toInt(spawnState.sourceDungeonID, toInt(template && template.sourceDungeonID, 0)),
      ),
    ),
  );
}

function resolveInstanceArchetypeID(instance) {
  const template = dungeonAuthority.getTemplateByIDReadOnly(normalizeText(instance && instance.templateID, ""));
  return Math.max(0, toInt(instance && instance.archetypeID, toInt(template && template.archetypeID, 0)));
}

function isGeneratedIceRuntimeInstance(instance) {
  if (!instance || normalizeLowerText(instance.siteFamily, "") !== "ice") {
    return false;
  }
  const runtimeFlags = getInstanceObject(instance, "runtimeFlags");
  const providerID = getGeneratedIceProviderID(instance);
  const siteOrigin = normalizeLowerText(instance.siteOrigin, "");
  return (
    siteOrigin === "generatedmining" ||
    providerID === "generatedmining" ||
    runtimeFlags.generatedMining === true ||
    (runtimeFlags.shadowProviderSite === true && providerID === "generatedmining")
  );
}

function isIceAuthorityRuntimeInstance(instance) {
  if (!instance) {
    return false;
  }
  if (isGeneratedIceRuntimeInstance(instance)) {
    return true;
  }
  const siteFamily = normalizeLowerText(instance.siteFamily, "");
  const archetypeID = resolveInstanceArchetypeID(instance);
  return siteFamily === "ice" || archetypeID === 28;
}

function listActiveIceAuthorityRuntimeInstances(systemIDs = null) {
  const byInstanceID = new Map();
  const selectedSystemIDs = normalizeSystemIDs(systemIDs);
  // Filter through the system index before copying any full instances.
  // An empty normalized scope historically means an unfiltered audit.
  const summaries = selectedSystemIDs.length > 0
    ? selectedSystemIDs.flatMap((systemID) => (
      dungeonRuntime.listInstancesBySystem(systemID, {
        lifecycleStates: UNIVERSE_SEEDED_LIFECYCLE_STATES,
      })
    ))
    : UNIVERSE_SEEDED_LIFECYCLE_STATES.flatMap((lifecycleState) => (
      dungeonRuntime.listInstancesByLifecycle(lifecycleState)
    ));

  for (const summary of summaries) {
    const instanceID = toInt(summary.instanceID, 0);
    if (instanceID <= 0 || byInstanceID.has(instanceID)) {
      continue;
    }

    // Inspect the cached record without copying or modifying it.
    const instance = dungeonRuntime.getInstanceRef(instanceID);
    if (
      !instance ||
      toInt(instance.solarSystemID, 0) <= 0 ||
      !isIceAuthorityRuntimeInstance(instance)
    ) {
      continue;
    }

    // Only matching ice instances need independent snapshots.
    const snapshot = dungeonRuntime.getInstance(instanceID);
    if (snapshot) {
      byInstanceID.set(instanceID, snapshot);
    }
  }

  const results = Array.from(byInstanceID.values());
  results.sort((left, right) => (
    toInt(left.solarSystemID, 0) - toInt(right.solarSystemID, 0) ||
    toInt(left.instanceID, 0) - toInt(right.instanceID, 0)
  ));
  return results;
}

function listActiveGeneratedIceRuntimeInstances(systemIDs = null) {
  return listActiveIceAuthorityRuntimeInstances(systemIDs);
}

function getIceRuntimeKind(instance) {
  if (isGeneratedIceRuntimeInstance(instance)) {
    return "generated_mining";
  }
  if (resolveInstanceArchetypeID(instance) === 28) {
    return "normal_ice_belt";
  }
  return "ice_family";
}

function buildGeneratedIceAuthorityAuditEntry(instance) {
  const systemID = Math.max(0, toInt(instance && instance.solarSystemID, 0));
  const archetypeID = resolveInstanceArchetypeID(instance);
  const runtimeFlags = getInstanceObject(instance, "runtimeFlags");
  const metadata = getInstanceObject(instance, "metadata");
  const spawnState = getInstanceObject(instance, "spawnState");
  const authorityRow = iceSystemAuthority.getIceSystemAuthorityRow(systemID);
  const expectedSourceDungeonID = Math.max(0, toInt(authorityRow && authorityRow.sourceDungeonID, 0));
  const expectedTemplateID = authorityRow && expectedSourceDungeonID > 0
    ? `client-dungeon:${expectedSourceDungeonID}`
    : null;
  const sourceDungeonID = resolveInstanceSourceDungeonID(instance);
  const templateID = normalizeText(instance && instance.templateID, "");
  const authorityKey = normalizeText(
    metadata.authorityKey,
    normalizeText(spawnState.authorityKey, ""),
  );
  const reasons = [];

  if (!authorityRow) {
    reasons.push("system_not_in_ice_authority");
  } else {
    if (sourceDungeonID <= 0) {
      reasons.push("source_dungeon_missing");
    } else if (sourceDungeonID !== expectedSourceDungeonID) {
      reasons.push("source_dungeon_mismatch");
    }
    if (templateID && expectedTemplateID && templateID !== expectedTemplateID) {
      reasons.push("template_mismatch");
    }
    if (authorityKey && authorityKey !== authorityRow.authorityKey) {
      reasons.push("authority_key_mismatch");
    }
  }

  if (runtimeFlags.shadowProviderSite === true) {
    reasons.push("legacy_shadow_provider_generated_ice");
  }
  if (
    normalizeLowerText(instance && instance.siteOrigin, "") === "generatedmining" &&
    runtimeFlags.universeSeeded !== true
  ) {
    reasons.push("not_universe_seeded_generated_ice");
  }

  return {
    instanceID: Math.max(0, toInt(instance && instance.instanceID, 0)),
    solarSystemID: systemID,
    siteKey: normalizeText(instance && instance.siteKey, ""),
    lifecycleState: normalizeLowerText(instance && instance.lifecycleState, ""),
    siteOrigin: normalizeLowerText(instance && instance.siteOrigin, ""),
    providerID: getGeneratedIceProviderID(instance),
    runtimeKind: getIceRuntimeKind(instance),
    archetypeID: archetypeID || null,
    sourceDungeonID: sourceDungeonID || null,
    expectedSourceDungeonID: expectedSourceDungeonID || null,
    templateID: templateID || null,
    expectedTemplateID: expectedTemplateID || null,
    authorityKey: authorityKey || null,
    expectedAuthorityKey: authorityRow && authorityRow.authorityKey || null,
    runtimeFlags: cloneValue(runtimeFlags),
    valid: reasons.length === 0,
    reasons,
  };
}

function auditGeneratedIceAuthority(options = {}) {
  const includeValid = options.includeValid === true;
  const entries = [];
  let validCount = 0;
  let invalidCount = 0;
  for (const instance of listActiveGeneratedIceRuntimeInstances(options.systemIDs)) {
    const entry = buildGeneratedIceAuthorityAuditEntry(instance);
    if (entry.valid) {
      validCount += 1;
      if (includeValid) {
        entries.push(entry);
      }
    } else {
      invalidCount += 1;
      entries.push(entry);
    }
  }
  return {
    scannedCount: validCount + invalidCount,
    validCount,
    invalidCount,
    invalidInstanceIDs: entries
      .filter((entry) => entry.valid !== true)
      .map((entry) => entry.instanceID),
    entries,
  };
}

function cleanupInvalidGeneratedIceAuthority(options = {}) {
  const nowMs = Math.max(0, toInt(options.nowMs, Date.now()));
  const applyCleanup = options.apply === true || options.dryRun === false;
  const hasSystemFilter = Array.isArray(options.systemIDs);
  const targetedSystemIDs = hasSystemFilter
    ? normalizeProvidedSystemIDs(options.systemIDs)
    : null;
  if (hasSystemFilter && targetedSystemIDs.length <= 0) {
    return {
      scannedCount: 0,
      validCount: 0,
      invalidCount: 0,
      invalidInstanceIDs: [],
      entries: [],
      applied: false,
      dryRun: !applyCleanup,
      affectedSystemIDs: [],
      despawnedCount: 0,
      despawnedInstanceIDs: [],
      miningStateRowsRemoved: 0,
      miningStateRowsUpdated: 0,
      miningStateRowsCreated: 0,
      refreshedSystemIDs: [],
      refreshedSceneCount: 0,
      skipped: true,
      reason: "no_startup_systems",
    };
  }
  const audit = auditGeneratedIceAuthority({
    systemIDs: hasSystemFilter ? targetedSystemIDs : options.systemIDs,
    includeValid: options.includeValid === true,
  });
  const invalidEntries = audit.entries.filter((entry) => entry.valid !== true);
  const affectedSystemIDs = [...new Set(
    invalidEntries
      .map((entry) => Math.max(0, toInt(entry && entry.solarSystemID, 0)))
      .filter((entry) => entry > 0),
  )].sort((left, right) => left - right);

  if (!applyCleanup || invalidEntries.length <= 0) {
    return {
      ...audit,
      applied: false,
      dryRun: true,
      affectedSystemIDs,
      despawnedCount: 0,
      despawnedInstanceIDs: [],
      miningStateRowsRemoved: 0,
      miningStateRowsUpdated: 0,
      miningStateRowsCreated: 0,
      refreshedSystemIDs: [],
      refreshedSceneCount: 0,
    };
  }

  const despawnedInstanceIDs = [];
  for (const entry of invalidEntries) {
    const updated = dungeonRuntime.setLifecycleState(entry.instanceID, "despawned", {
      nowMs,
      despawnAtMs: nowMs,
      lifecycleReason: "invalid_ice_authority",
      expiresAtMs: 0,
    });
    if (updated && normalizeLowerText(updated.lifecycleState, "") === "despawned") {
      despawnedInstanceIDs.push(entry.instanceID);
    }
  }

  const miningState = affectedSystemIDs.length > 0
    ? reconcileGeneratedMiningRuntimeState(
      listActiveGeneratedMiningDefinitionsFromRuntime(affectedSystemIDs),
      affectedSystemIDs,
      nowMs,
    )
    : {
      createdRows: 0,
      updatedRows: 0,
      removedRows: 0,
    };
  const sceneRefresh = options.refreshLoadedScenes === false
    ? {
      refreshedCount: 0,
      refreshedSystemIDs: [],
    }
    : refreshLoadedGeneratedMiningScenes(affectedSystemIDs, nowMs);

  return {
    ...audit,
    applied: true,
    dryRun: false,
    affectedSystemIDs,
    despawnedCount: despawnedInstanceIDs.length,
    despawnedInstanceIDs,
    miningStateRowsRemoved: Math.max(0, toInt(miningState && miningState.removedRows, 0)),
    miningStateRowsUpdated: Math.max(0, toInt(miningState && miningState.updatedRows, 0)),
    miningStateRowsCreated: Math.max(0, toInt(miningState && miningState.createdRows, 0)),
    refreshedSystemIDs: sceneRefresh.refreshedSystemIDs || [],
    refreshedSceneCount: Math.max(0, toInt(sceneRefresh && sceneRefresh.refreshedCount, 0)),
  };
}

/**
 * Lists universe-seeded persistent sites in the given systems.
 *
 * `systemIDs` is required and the lookup goes through the per-system index. An
 * unscoped default here is what let a single system's wake enumerate and clone
 * the entire cluster once per spawn family, so asking for everything is an error
 * rather than a slow success.
 */
function listUniverseSeededPersistentSiteInstances(systemIDs) {
  if (systemIDs === null || systemIDs === undefined) {
    throw new Error("UNIVERSE_SEEDED_SITE_SCOPE_REQUIRED");
  }
  const targetedSystemIDs = normalizeSystemIDs(systemIDs);
  const byInstanceID = new Map();
  for (const systemID of targetedSystemIDs) {
    // Summaries carry every field the callers read (instanceID, templateID,
    // solarSystemID, siteOrigin, runtimeFlags and metadata), so there is no need
    // to clone the full instance a second time per row.
    for (const instance of dungeonRuntime.listInstancesBySystem(systemID, {
      lifecycleStates: UNIVERSE_SEEDED_LIFECYCLE_STATES,
    })) {
      if (!instance || !(instance.runtimeFlags && instance.runtimeFlags.universeSeeded === true)) {
        continue;
      }
      if (String(instance.siteOrigin || "").trim().toLowerCase() === "generatedmining") {
        continue;
      }
      byInstanceID.set(instance.instanceID, instance);
    }
  }
  return [...byInstanceID.values()].sort((left, right) => left.instanceID - right.instanceID);
}

function summarizeActiveUniverseSeededCounts(systemIDs) {
  const generatedMiningCount = listUniverseSeededGeneratedMiningInstances(systemIDs).length;
  const persistentCount = listUniverseSeededPersistentSiteInstances(systemIDs).length;
  return {
    generatedMiningCount,
    persistentCount,
    totalCount: generatedMiningCount + persistentCount,
  };
}

/**
 * Build the lightweight system/count projection used by clients which need to
 * advertise universe-persistent sites before those sites are materialized.
 *
 * Randomly allocated families deliberately include every eligible candidate
 * system with a zero count. Retail's dungeon cache uses the same shape: the
 * selected systems carry their slot count while the rest remain explicit
 * zeroes. Keeping this separate from full site-definition construction avoids
 * choosing templates, positions, and entity layouts merely to populate an
 * Agency or starmap location list.
 */
function buildUniverseSpawnCountMap(family, options = {}) {
  const normalizedFamily = normalizeLowerText(family, "");
  const countsBySystem = new Map();
  if (!normalizedFamily) {
    return countsBySystem;
  }
  const hasSystemFilter = Array.isArray(options.systemIDs);
  const targetedSystemIDs = hasSystemFilter
    ? new Set(normalizeProvidedSystemIDs(options.systemIDs))
    : null;
  const includeSystem = (systemID) => (
    !targetedSystemIDs || targetedSystemIDs.has(Math.max(0, toInt(systemID, 0)))
  );
  const setCount = (systemID, count) => {
    const numericSystemID = Math.max(0, toInt(systemID, 0));
    if (numericSystemID <= 0 || !includeSystem(numericSystemID)) {
      return;
    }
    countsBySystem.set(numericSystemID, Math.max(0, toInt(count, 0)));
  };
  const incrementCount = (systemID, incrementBy = 1) => {
    const numericSystemID = Math.max(0, toInt(systemID, 0));
    if (numericSystemID <= 0 || !includeSystem(numericSystemID)) {
      return;
    }
    countsBySystem.set(
      numericSystemID,
      Math.max(0, toInt(countsBySystem.get(numericSystemID), 0)) +
        Math.max(0, toInt(incrementBy, 0)),
    );
  };

  // Projection for the client's availability dictionary, so it spans systems by
  // design. Each system is still answered independently by its own plan.
  //
  // Systems where the family cannot spawn are recorded as an explicit zero
  // rather than omitted: retail count maps are dense, and the Agency UI treats a
  // missing key differently from a zero.
  const projectionSystemIDs = hasSystemFilter
    ? [...targetedSystemIDs]
    : normalizeSystemIDs();
  for (const systemID of projectionSystemIDs) {
    const planned = resolveSystemSitePlan(systemID, { families: [normalizedFamily] });
    setCount(systemID, planned.length > 0 ? planned[0].count : 0);
  }

  if (options.includeSovereignty !== false) {
    const sovereignty = listDesiredSovereigntyDungeonSiteDefinitions(
      hasSystemFilter ? [...targetedSystemIDs] : null,
      Math.max(0, toInt(options.nowMs, Date.now())),
      {
        ...options,
        families: [normalizedFamily],
      },
    );
    for (const definition of sovereignty.definitions || []) {
      incrementCount(definition && definition.solarSystemID);
    }
  }

  return countsBySystem;
}

function buildSystemUniverseReconcileFamilyQueue(options = {}) {
  const familyFilter = new Set((Array.isArray(options.families) ? options.families : [])
    .map((entry) => normalizeLowerText(entry, ""))
    .filter(Boolean));
  const hasFamilyFilter = familyFilter.size > 0;
  const queue = [];
  const seen = new Set();
  const addFamily = (family) => {
    const normalizedFamily = normalizeLowerText(family, "");
    if (!normalizedFamily || seen.has(normalizedFamily)) {
      return;
    }
    if (hasFamilyFilter && !familyFilter.has(normalizedFamily)) {
      return;
    }
    seen.add(normalizedFamily);
    queue.push(normalizedFamily);
  };

  if (
    options.includeMining !== false &&
    (!hasFamilyFilter || familyFilter.has("generatedmining"))
  ) {
    addFamily("generatedmining");
  }
  if (options.includeBroad !== false) {
    for (const family of dungeonAuthority.listUniverseSpawnFamilies()) {
      addFamily(family);
    }
    for (const family of listSovereigntyGuaranteedSpawnFamilies()) {
      addFamily(family);
    }
  }
  return queue;
}

function cloneSystemUniverseReconcileJob(job) {
  if (!job) {
    return null;
  }
  return cloneValue({
    systemID: job.systemID,
    startedAtMs: job.startedAtMs,
    nowMs: job.nowMs,
    reason: job.reason,
    familyQueue: job.familyQueue,
    familyIndex: job.familyIndex,
    sliceCount: job.sliceCount,
    initialDelayMs: job.initialDelayMs,
    sliceDelayMs: job.sliceDelayMs,
    desiredSiteCount: job.desiredSiteCount,
    desiredMiningSiteCount: job.desiredMiningSiteCount,
    desiredPersistentSiteCount: job.desiredPersistentSiteCount,
    createdInstances: job.createdInstances,
    retainedInstances: job.retainedInstances,
    replacedInstances: job.replacedInstances,
    removedInstances: job.removedInstances,
    miningStateRowsCreated: job.miningStateRowsCreated,
    miningStateRowsRemoved: job.miningStateRowsRemoved,
    invalidGeneratedIceScanned: job.invalidGeneratedIceScanned,
    invalidGeneratedIceFound: job.invalidGeneratedIceFound,
    invalidGeneratedIceDespawned: job.invalidGeneratedIceDespawned,
    oreSecurity: job.oreSecurity,
    queuedCallbackCount: Array.isArray(job.completionCallbacks)
      ? job.completionCallbacks.length
      : 0,
    completed: job.completed === true,
  });
}

function getSystemUniverseReconcileJob(systemID = null) {
  const numericSystemID = Math.max(0, toInt(systemID, 0));
  if (numericSystemID > 0) {
    return cloneSystemUniverseReconcileJob(systemUniverseReconcileJobs.get(numericSystemID) || null);
  }
  return [...systemUniverseReconcileJobs.values()]
    .map((job) => cloneSystemUniverseReconcileJob(job));
}

function clearSystemUniverseReconcileTimer() {
  if (systemUniverseReconcileTimer) {
    clearTimeout(systemUniverseReconcileTimer);
    systemUniverseReconcileTimer = null;
  }
}

function getNextSystemUniverseReconcileJob() {
  for (const job of systemUniverseReconcileJobs.values()) {
    if (job && job.completed !== true) {
      return job;
    }
  }
  return null;
}

function scheduleNextSystemUniverseReconcileSlice() {
  if (systemUniverseReconcileTimer || systemUniverseReconcileJobs.size <= 0) {
    return;
  }
  const job = getNextSystemUniverseReconcileJob();
  if (!job) {
    return;
  }
  const delayMs = job.sliceCount <= 0
    ? Math.max(0, toInt(job.initialDelayMs, SYSTEM_RECONCILE_INITIAL_DELAY_MS))
    : Math.max(0, toInt(job.sliceDelayMs, BACKGROUND_RECONCILE_DELAY_MS));
  systemUniverseReconcileTimer = setTimeout(() => {
    systemUniverseReconcileTimer = null;
    runSystemUniverseReconcileSlice();
  }, delayMs);
  if (typeof systemUniverseReconcileTimer.unref === "function") {
    systemUniverseReconcileTimer.unref();
  }
}

function appendSystemUniverseReconcileCallback(job, callback) {
  if (!job || typeof callback !== "function") {
    return;
  }
  if (!Array.isArray(job.completionCallbacks)) {
    job.completionCallbacks = [];
  }
  job.completionCallbacks.push(callback);
}

function mergeFamilySummaries(target, source) {
  if (!target || !source || typeof source !== "object") {
    return;
  }
  for (const [family, summary] of Object.entries(source)) {
    target[family] = summary;
  }
}

function addInstanceSummaryToSystemJob(job, instanceSummary) {
  job.createdInstances += Math.max(0, toInt(instanceSummary && instanceSummary.createdCount, 0));
  job.retainedInstances += Math.max(0, toInt(instanceSummary && instanceSummary.retainedCount, 0));
  job.replacedInstances += Math.max(0, toInt(instanceSummary && instanceSummary.replacedCount, 0));
  job.removedInstances += Math.max(0, toInt(instanceSummary && instanceSummary.removedCount, 0));
}

function completeSystemUniverseReconcileJob(job, failure = null) {
  if (!job) {
    return null;
  }
  const completedAtMs = Date.now();
  job.completed = true;
  const summary = {
    systemCount: 1,
    desiredSiteCount: job.desiredSiteCount,
    desiredMiningSiteCount: job.desiredMiningSiteCount,
    desiredPersistentSiteCount: job.desiredPersistentSiteCount,
    createdInstances: job.createdInstances,
    retainedInstances: job.retainedInstances,
    replacedInstances: job.replacedInstances,
    removedInstances: job.removedInstances,
    miningStateRowsCreated: job.miningStateRowsCreated,
    miningStateRowsRemoved: job.miningStateRowsRemoved,
    invalidGeneratedIceScanned: job.invalidGeneratedIceScanned,
    invalidGeneratedIceFound: job.invalidGeneratedIceFound,
    invalidGeneratedIceDespawned: job.invalidGeneratedIceDespawned,
    oreSecurity: job.oreSecurity,
    mining: {
      desiredSiteCount: job.desiredMiningSiteCount,
    },
    families: job.families,
    elapsedMs: completedAtMs - job.startedAtMs,
  };
  const failed = failure && failure.error;
  const result = failed
    ? {
      success: false,
      errorMsg: failure.error.message,
      systemID: job.systemID,
      family: failure.family || null,
      summary,
    }
    : {
      success: true,
      skipped: false,
      systemID: job.systemID,
      summary,
    };
  systemUniverseReconcileJobs.delete(job.systemID);
  if (!failed) {
    systemWakeReconcileState.set(job.systemID, {
      checkedAtMs: completedAtMs,
      nowMs: job.nowMs,
      reason: job.reason,
      summary,
    });
  }
  if (failed) {
    log.warn(
      `[DungeonUniverse] background system reconcile failed system=${job.systemID} ` +
        `family=${failure.family || "unknown"}: ${failure.error.message}`,
    );
  } else if (job.logProgress === true || summary.elapsedMs >= 500) {
    log.info(
      `[DungeonUniverse] background system reconcile complete system=${job.systemID} ` +
        `reason=${job.reason} in ${summary.elapsedMs}ms ` +
        `(${summary.desiredSiteCount} desired sites, created ${summary.createdInstances}, ` +
        `retained ${summary.retainedInstances}, replaced ${summary.replacedInstances}, ` +
        `removed ${summary.removedInstances})`,
    );
  }
  const callbacks = Array.isArray(job.completionCallbacks)
    ? [...job.completionCallbacks]
    : [];
  for (const callback of callbacks) {
    try {
      callback(result);
    } catch (error) {
      log.warn(
        `[DungeonUniverse] background system reconcile callback failed ` +
        `system=${job.systemID}: ${error.message}`,
      );
    }
  }
  return result;
}

function reconcileSystemUniverseFamilySlice(job, family) {
  if (family === "generatedmining") {
    const miningDefinitions = listDesiredGeneratedMiningDefinitions([job.systemID], job.nowMs);
    const instanceSummary = dungeonRuntime.reconcileUniverseSeededInstances(miningDefinitions, {
      systemIDs: [job.systemID],
      nowMs: job.nowMs,
      siteOriginFilter: ["generatedmining"],
      preserveSiteKeys: listProtectedGeneratedMiningSiteKeys([job.systemID], job.nowMs),
    });
    const persistedMiningState = reconcileGeneratedMiningRuntimeState(
      listActiveGeneratedMiningDefinitionsFromRuntime([job.systemID]),
      [job.systemID],
      job.nowMs,
    );
    const invalidGeneratedIceCleanup = job.cleanupInvalidGeneratedIce !== false
      ? cleanupInvalidGeneratedIceAuthority({
        systemIDs: [job.systemID],
        nowMs: job.nowMs,
        apply: true,
      })
      : {
        scannedCount: 0,
        invalidCount: 0,
        despawnedCount: 0,
        miningStateRowsRemoved: 0,
      };
    job.desiredSiteCount += miningDefinitions.length;
    job.desiredMiningSiteCount += miningDefinitions.length;
    addInstanceSummaryToSystemJob(job, instanceSummary);
    job.miningStateRowsCreated += Math.max(0, toInt(persistedMiningState && persistedMiningState.createdRows, 0));
    job.miningStateRowsRemoved += (
      Math.max(0, toInt(persistedMiningState && persistedMiningState.removedRows, 0)) +
      Math.max(0, toInt(invalidGeneratedIceCleanup && invalidGeneratedIceCleanup.miningStateRowsRemoved, 0))
    );
    job.invalidGeneratedIceScanned += Math.max(0, toInt(invalidGeneratedIceCleanup && invalidGeneratedIceCleanup.scannedCount, 0));
    job.invalidGeneratedIceFound += Math.max(0, toInt(invalidGeneratedIceCleanup && invalidGeneratedIceCleanup.invalidCount, 0));
    job.invalidGeneratedIceDespawned += Math.max(0, toInt(invalidGeneratedIceCleanup && invalidGeneratedIceCleanup.despawnedCount, 0));
    return {
      desiredSiteCount: miningDefinitions.length,
    };
  }

  const definitionOptions = {
    families: [family],
  };
  if (typeof job.rng === "function") {
    definitionOptions.rng = job.rng;
  }
  const broadResult = listDesiredUniverseDungeonSiteDefinitions(
    [job.systemID],
    job.nowMs,
    definitionOptions,
  );
  const instanceSummary = dungeonRuntime.reconcileUniverseSeededInstances(broadResult.definitions, {
    systemIDs: [job.systemID],
    nowMs: job.nowMs,
    spawnFamilyFilter: [family],
    preserveSiteKeys: listUniversePersistentTerminalSiteKeys([job.systemID], {
      siteOrigins: ["universe_dungeon", SOV_GUARANTEED_SITE_ORIGIN],
    }),
  });
  job.desiredSiteCount += broadResult.definitions.length;
  job.desiredPersistentSiteCount += broadResult.definitions.length;
  addInstanceSummaryToSystemJob(job, instanceSummary);
  mergeFamilySummaries(job.families, broadResult.families);
  if (family === "ore" && broadResult.oreSecurity) {
    job.oreSecurity = broadResult.oreSecurity;
  }
  return {
    desiredSiteCount: broadResult.definitions.length,
  };
}

function runSystemUniverseReconcileSlice() {
  clearSystemUniverseReconcileTimer();
  const job = getNextSystemUniverseReconcileJob();
  if (!job) {
    return null;
  }
  const family = job.familyQueue[job.familyIndex];
  if (!family) {
    const result = completeSystemUniverseReconcileJob(job);
    scheduleNextSystemUniverseReconcileSlice();
    return result;
  }

  const sliceStartMs = Date.now();
  let sliceSummary;
  try {
    sliceSummary = reconcileSystemUniverseFamilySlice(job, family);
  } catch (error) {
    const result = completeSystemUniverseReconcileJob(job, { error, family });
    scheduleNextSystemUniverseReconcileSlice();
    return result;
  }
  job.familyIndex += 1;
  job.sliceCount += 1;
  const elapsedMs = Date.now() - sliceStartMs;
  if (elapsedMs >= 500 || job.logProgress === true) {
    log.info(
      `[DungeonUniverse] background system reconcile system=${job.systemID} ` +
        `family=${family} slice=${job.sliceCount}/${job.familyQueue.length} ` +
        `desired=${Math.max(0, toInt(sliceSummary && sliceSummary.desiredSiteCount, 0))} ` +
        `took ${elapsedMs}ms`,
    );
  }
  if (job.familyIndex >= job.familyQueue.length) {
    const result = completeSystemUniverseReconcileJob(job);
    scheduleNextSystemUniverseReconcileSlice();
    return {
      success: true,
      family,
      systemID: job.systemID,
      elapsedMs,
      completed: true,
      result,
    };
  }

  systemUniverseReconcileJobs.delete(job.systemID);
  systemUniverseReconcileJobs.set(job.systemID, job);
  scheduleNextSystemUniverseReconcileSlice();
  return {
    success: true,
    family,
    systemID: job.systemID,
    elapsedMs,
    completed: false,
  };
}

function scheduleSystemUniversePersistentSitesReconcile(systemID, options = {}) {
  const numericSystemID = Math.max(0, toInt(systemID, 0));
  if (numericSystemID <= 0) {
    return {
      success: false,
      scheduled: false,
      errorMsg: "INVALID_SYSTEM_ID",
    };
  }

  const requestedFamilyQueue = buildSystemUniverseReconcileFamilyQueue(options);
  const existingJob = systemUniverseReconcileJobs.get(numericSystemID) || null;
  if (existingJob && existingJob.completed !== true) {
    appendSystemUniverseReconcileCallback(existingJob, options.onComplete);
    existingJob.force = existingJob.force === true || options.force === true;
    existingJob.logProgress = existingJob.logProgress === true || options.logProgress === true;
    for (const family of requestedFamilyQueue) {
      // A Hub can change again after this job has processed a family. A forced
      // refresh must revisit it using the newly committed configuration.
      const remainingFamilies = options.force === true
        ? existingJob.familyQueue.slice(existingJob.familyIndex)
        : existingJob.familyQueue;
      if (!remainingFamilies.includes(family)) {
        existingJob.familyQueue.push(family);
      }
    }
    return {
      success: true,
      scheduled: false,
      reason: "already_running",
      systemID: numericSystemID,
      job: cloneSystemUniverseReconcileJob(existingJob),
    };
  }

  const wallclockNowMs = Date.now();
  const nowMs = Math.max(0, toInt(options.nowMs, wallclockNowMs));
  const debounceMs = Math.max(0, toInt(options.debounceMs, SYSTEM_WAKE_RECONCILE_DEBOUNCE_MS));
  const currentState = systemWakeReconcileState.get(numericSystemID) || null;
  if (
    options.force !== true &&
    currentState &&
    debounceMs > 0 &&
    wallclockNowMs - Math.max(0, toInt(currentState.checkedAtMs, 0)) < debounceMs
  ) {
    return {
      success: true,
      scheduled: false,
      skipped: true,
      reason: "debounced",
      systemID: numericSystemID,
      previous: cloneValue(currentState.summary || null),
    };
  }

  const familyQueue = requestedFamilyQueue;
  if (familyQueue.length <= 0) {
    return {
      success: true,
      scheduled: false,
      skipped: true,
      reason: "no_families",
      systemID: numericSystemID,
    };
  }

  const job = {
    systemID: numericSystemID,
    startedAtMs: wallclockNowMs,
    nowMs,
    reason: normalizeText(options.reason, "system-wake"),
    includeMining: options.includeMining !== false,
    includeBroad: options.includeBroad !== false,
    cleanupInvalidGeneratedIce: options.cleanupInvalidGeneratedIce !== false,
    force: options.force === true,
    familyQueue,
    familyIndex: 0,
    sliceCount: 0,
    initialDelayMs: Math.max(0, toInt(options.initialDelayMs, SYSTEM_RECONCILE_INITIAL_DELAY_MS)),
    sliceDelayMs: Math.max(0, toInt(options.sliceDelayMs, BACKGROUND_RECONCILE_DELAY_MS)),
    rng: typeof options.rng === "function" ? options.rng : null,
    desiredSiteCount: 0,
    desiredMiningSiteCount: 0,
    desiredPersistentSiteCount: 0,
    createdInstances: 0,
    retainedInstances: 0,
    replacedInstances: 0,
    removedInstances: 0,
    miningStateRowsCreated: 0,
    miningStateRowsRemoved: 0,
    invalidGeneratedIceScanned: 0,
    invalidGeneratedIceFound: 0,
    invalidGeneratedIceDespawned: 0,
    oreSecurity: null,
    families: {},
    completionCallbacks: [],
    completed: false,
    logProgress: options.logProgress === true,
  };
  appendSystemUniverseReconcileCallback(job, options.onComplete);
  systemUniverseReconcileJobs.set(numericSystemID, job);
  scheduleNextSystemUniverseReconcileSlice();
  return {
    success: true,
    scheduled: true,
    reason: job.reason,
    systemID: numericSystemID,
    job: cloneSystemUniverseReconcileJob(job),
  };
}

function prepareSystemForPlayerEntry(systemID, options = {}) {
  const numericSystemID = Math.max(0, toInt(systemID, 0));
  if (numericSystemID <= 0) {
    return {
      success: false,
      errorMsg: "INVALID_SYSTEM_ID",
    };
  }

  const nowMs = Math.max(0, toInt(options.nowMs, Date.now()));
  const lifecycle = {
    deferredToDurableScheduler: true,
    expiredCount: 0,
    rotatedCount: 0,
    removedCount: 0,
  };
  const reconcile = ensureSystemUniversePersistentSites(numericSystemID, {
    ...options,
    nowMs,
    force: true,
    debounceMs: 0,
    includeMining: options.includeMining !== false,
    includeBroad: options.includeBroad !== false,
    cleanupInvalidGeneratedIce: options.cleanupInvalidGeneratedIce !== false,
  });
  if (!reconcile || reconcile.success === false) {
    return {
      success: false,
      errorMsg: reconcile && reconcile.errorMsg || "SYSTEM_CONTENT_RECONCILE_FAILED",
      systemID: numericSystemID,
      lifecycle,
      reconcile,
    };
  }

  const miningSceneRefresh = options.refreshLoadedMiningScene === false
    ? {
      refreshedCount: 0,
      refreshedSystemIDs: [],
    }
    : refreshLoadedGeneratedMiningScenes([numericSystemID], nowMs);
  return {
    success: true,
    systemID: numericSystemID,
    nowMs,
    lifecycle,
    reconcile,
    miningSceneRefresh,
  };
}

function ensureSystemUniversePersistentSites(systemID, options = {}) {
  const numericSystemID = Math.max(0, toInt(systemID, 0));
  if (numericSystemID <= 0) {
    return {
      success: false,
      errorMsg: "INVALID_SYSTEM_ID",
    };
  }

  const wallclockNowMs = Date.now();
  const nowMs = Math.max(0, toInt(options.nowMs, wallclockNowMs));
  const debounceMs = Math.max(0, toInt(options.debounceMs, SYSTEM_WAKE_RECONCILE_DEBOUNCE_MS));
  const currentState = systemWakeReconcileState.get(numericSystemID) || null;
  if (
    options.force !== true &&
    currentState &&
    debounceMs > 0 &&
    wallclockNowMs - Math.max(0, toInt(currentState.checkedAtMs, 0)) < debounceMs
  ) {
    return {
      success: true,
      skipped: true,
      reason: "debounced",
      systemID: numericSystemID,
      previous: cloneValue(currentState.summary || null),
    };
  }

  const startedAtMs = Date.now();
  const includeMining = options.includeMining !== false;
  const includeBroad = options.includeBroad !== false;
  const miningDefinitions = includeMining
    ? listDesiredGeneratedMiningDefinitions([numericSystemID], nowMs)
    : [];
  const protectedGeneratedMiningSiteKeys = includeMining
    ? listUniversePersistentTerminalSiteKeys([numericSystemID], {
      siteOrigins: ["generatedmining"],
    })
    : [];
  const broadResult = includeBroad
    ? listDesiredUniverseDungeonSiteDefinitions([numericSystemID], nowMs, {
      rng: options.rng,
    })
    : { definitions: [], families: {} };
  const miningSummary = includeMining
    ? dungeonRuntime.reconcileUniverseSeededInstances(miningDefinitions, {
      systemIDs: [numericSystemID],
      nowMs,
      siteOriginFilter: ["generatedmining"],
      preserveSiteKeys: protectedGeneratedMiningSiteKeys,
    })
    : {
      createdCount: 0,
      retainedCount: 0,
      replacedCount: 0,
      removedCount: 0,
    };
  const broadSummary = includeBroad
    ? dungeonRuntime.reconcileUniverseSeededInstances(broadResult.definitions, {
      systemIDs: [numericSystemID],
      nowMs,
      siteOriginFilter: ["universe_dungeon", SOV_GUARANTEED_SITE_ORIGIN],
      preserveSiteKeys: listUniversePersistentTerminalSiteKeys(
        [numericSystemID],
        {
          siteOrigins: ["universe_dungeon", SOV_GUARANTEED_SITE_ORIGIN],
        },
      ),
    })
    : {
      createdCount: 0,
      retainedCount: 0,
      replacedCount: 0,
      removedCount: 0,
    };
  const persistedMiningState = includeMining
    ? reconcileGeneratedMiningRuntimeState(
      listActiveGeneratedMiningDefinitionsFromRuntime([numericSystemID]),
      [numericSystemID],
      nowMs,
    )
    : {
      createdRows: 0,
      updatedRows: 0,
      removedRows: 0,
    };
  const invalidGeneratedIceCleanup = includeMining && options.cleanupInvalidGeneratedIce !== false
    ? cleanupInvalidGeneratedIceAuthority({
      systemIDs: [numericSystemID],
      nowMs,
      apply: true,
    })
    : {
      scannedCount: 0,
      invalidCount: 0,
      despawnedCount: 0,
      miningStateRowsRemoved: 0,
    };
  const summary = {
    systemCount: 1,
    desiredSiteCount: miningDefinitions.length + broadResult.definitions.length,
    createdInstances: miningSummary.createdCount + broadSummary.createdCount,
    retainedInstances: miningSummary.retainedCount + broadSummary.retainedCount,
    replacedInstances: miningSummary.replacedCount + broadSummary.replacedCount,
    removedInstances: miningSummary.removedCount + broadSummary.removedCount,
    miningStateRowsCreated: persistedMiningState.createdRows,
    miningStateRowsRemoved:
      persistedMiningState.removedRows +
      Math.max(0, toInt(invalidGeneratedIceCleanup && invalidGeneratedIceCleanup.miningStateRowsRemoved, 0)),
    invalidGeneratedIceScanned: Math.max(0, toInt(invalidGeneratedIceCleanup && invalidGeneratedIceCleanup.scannedCount, 0)),
    invalidGeneratedIceFound: Math.max(0, toInt(invalidGeneratedIceCleanup && invalidGeneratedIceCleanup.invalidCount, 0)),
    invalidGeneratedIceDespawned: Math.max(0, toInt(invalidGeneratedIceCleanup && invalidGeneratedIceCleanup.despawnedCount, 0)),
    mining: {
      desiredSiteCount: miningDefinitions.length,
      protectedTerminalSiteCount: protectedGeneratedMiningSiteKeys.length,
    },
    oreSecurity: broadResult.oreSecurity || null,
    families: broadResult.families,
    elapsedMs: Date.now() - startedAtMs,
  };
  const state = {
    checkedAtMs: wallclockNowMs,
    nowMs,
    reason: normalizeText(options.reason, "system-wake"),
    summary,
  };
  systemWakeReconcileState.set(numericSystemID, state);
  return {
    success: true,
    skipped: false,
    systemID: numericSystemID,
    summary,
  };
}

function stopTicker() {
  clearSystemUniverseReconcileTimer();
  systemUniverseReconcileJobs.clear();
  systemWakeReconcileState.clear();
}

function clearPolicyCandidateCachesForTests() {
  policyEligibleTemplateCandidatesCache.clear();
  prospectingOreTemplatesByKeyCache.clear();
  combatAnomalyTemplatesByLabelCache.clear();
}

module.exports = {
  summarizeActiveUniverseSeededCounts,
  buildUniverseSpawnCountMap,
  listSystemJumpDistances,
  getSystemUniverseReconcileJob,
  listDesiredGeneratedMiningDefinitions,
  listDesiredUniverseDungeonSiteDefinitions,
  listUniverseSeededGeneratedMiningInstances,
  listUniverseSeededPersistentSiteInstances,
  advanceUniversePersistentSites,
  getUniversePersistentLifecycleBoundary,
  getUniversePersistentLifecycleBoundariesBySystem,
  resetStartupMiningAnomalies,
  resetStartupOrphanedUniverseSites,
  auditGeneratedIceAuthority,
  cleanupInvalidGeneratedIceAuthority,
  prepareSystemForPlayerEntry,
  ensureSystemUniversePersistentSites,
  scheduleSystemUniversePersistentSitesReconcile,
  stopTicker,
  _testing: {
    summarizeActiveUniverseSeededCounts,
    buildUniverseSpawnCountMap,
    buildGeneratedMiningDefinitionHash,
    buildGeneratedMiningPersistedState,
    buildGeneratedMiningSiteKey,
    buildGeneratedMiningSpawnState,
    buildUniverseAnchorCandidates,
    buildUniverseSiteDefinition,
    buildUniverseSitePlacement,
    buildUniverseSiteID,
    buildUniverseSitePosition,
    buildTemplatePolicyContext,
    buildPolicyCandidateCacheKey,
    allocateOreTemplatesForSystem,
    buildRotationDefinitionFromInstance,
    enrichGeneratedMiningDefinition,
    evaluateTemplateSpawnPolicy,
    listPolicyEligibleTemplateDescriptorsForBand,
    listPolicyEligibleTemplatesForBand,
    pickUniverseTemplateForSlotWithPolicy,
    pickRandomUniverseTemplateForSlotWithPolicy,
    clearPolicyCandidateCachesForTests,
    listDesiredSovereigntyDungeonSiteDefinitions,
    listSovereigntyGuaranteedSpawnFamilies,
    isSovereigntyGuaranteedSpawnFamily,
    resolveThreatDetectionSecurityBracket,
    listCombatAnomalyTemplatesForLabel,
    listProspectingOreTemplates,
    parseThreatDetectionUpgrade,
    parseProspectingUpgrade,
    parseExplorationDetectorUpgrade,
    listSystemsWithinJumps,
    advanceUniversePersistentSites,
    resetStartupMiningAnomalies,
    resetStartupOrphanedUniverseSites,
    auditGeneratedIceAuthority,
    cleanupInvalidGeneratedIceAuthority,
    getSystemUniverseReconcileJob,
    prepareSystemForPlayerEntry,
    ensureSystemUniversePersistentSites,
    scheduleSystemUniversePersistentSitesReconcile,
    getSecurityBand,
    normalizeSystemIDs,
    reconcileGeneratedMiningRuntimeState,
    runSystemUniverseReconcileSlice,
    listProtectedGeneratedMiningSiteKeys,
    resolveSystemSitePlan,
    listCompiledSpawnFamilies,
    isMissionOnlyUniverseTemplate,
    templateMatchesSpawnFamily,
    siteSpawnPolicy: dungeonSiteSpawnPolicy,
  },
};
