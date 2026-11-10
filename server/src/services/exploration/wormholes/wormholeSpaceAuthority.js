"use strict";

const {
  toInt,
} = require("../../../common/numbers");

// Where wormhole content belongs.
//
// The wormhole authority (explorationWormholeStatic) knows every J-space
// system's class. This module adds what the class alone does not say: which
// systems are shattered, which site classes a system may host, and which
// classes each documented wormhole site belongs to. Sources are the EVE
// University wormhole and shattered-system pages, recorded in
// tools/ClientDungeonCompiler/manifests/WORMHOLE_SITE_SPAWNS_RESEARCH.md.
//
// Class identifiers follow the SDE: 1-6 ordinary J-space, 12 Thera, 13 the 25
// small-ship shattered systems, 14-18 the five drifter hive systems, 7-9 and
// 19-25 known space.

const path = require("path");

const worldData = require(path.join(__dirname, "../../../space/worldData"));
const pirateFactionPolicy = require(path.join(__dirname, "../../../space/npc/pirateFactionPolicy"));
const wormholeAuthority = require(path.join(__dirname, "./wormholeAuthority"));

const THERA_CLASS_ID = 12;
const SMALL_SHIP_SHATTERED_CLASS_ID = 13;
const DRIFTER_CLASS_IDS = Object.freeze([14, 15, 16, 17, 18]);
const ORDINARY_CLASS_IDS = Object.freeze([1, 2, 3, 4, 5, 6]);

// The 75 shattered systems of classes 1 to 6 (EVE University: List of
// shattered systems). Thera and the 25 J000 systems are recognised by class.
const SHATTERED_SYSTEM_NAMES = Object.freeze([
  "J015092", "J005834", "J012402", "J005926", "J010569", "J012157", "J002757", "J004791", "J004317", "J002216",
  "J005482", "J005900", "J013070", "J001057", "J011321", "J013123", "J012735", "J012635", "J010000", "J001890", "J002964",
  "J004686", "J011563", "J001348", "J002838", "J001670", "J014348", "J003789", "J012794", "J005923", "J001398", "J011339", "J004283",
  "J002625", "J004470", "J011824", "J010247", "J002423", "J001302", "J010556", "J011778", "J005259", "J005969", "J001769",
  "J004150", "J005872", "J011376", "J005299", "J011355", "J011195", "J005280",
  "J010811", "J001694", "J003941", "J011790", "J013146", "J004998", "J003382", "J003546", "J001820", "J012578", "J012773",
  "J005223", "J005663", "J003793", "J004128", "J005070", "J001025", "J005724", "J004921",
  "J012686", "J010366", "J012475", "J015227", "J010951",
]);

// Which classes each documented wormhole site belongs to, by exact site name.
// A pack template may carry its own `wormholeClasses`; this table covers the
// base's generated templates and the resource pack's exact ones.
const SLEEPER_ANOMALY_CLASSES = Object.freeze({
  "Perimeter Ambush Point": [1],
  "Perimeter Camp": [1],
  "Phase Catalyst Node": [1],
  "The Line": [1],
  "Perimeter Checkpoint": [2],
  "Perimeter Hangar": [2],
  "The Ruins of Enclave Cohort 27": [2],
  "Sleeper Data Sanctuary": [2],
  "Fortification Frontier Stronghold": [3],
  "Outpost Frontier Stronghold": [3],
  "Solar Cell": [3],
  "The Oruze Construct": [3],
  "Frontier Barracks": [4],
  "Frontier Command Post": [4],
  "Integrated Terminus": [4],
  "Sleeper Information Sanctum": [4],
  "Core Garrison": [5],
  "Core Stronghold": [5],
  "Oruze Osobnyk": [5],
  "Quarantine Area": [5],
  "Core Citadel": [6],
  "Core Bastion": [6],
  "Strange Energy Readings": [6],
  "The Mirror": [6],
});

const SLEEPER_DATA_CLASSES = Object.freeze({
  "Unsecured Perimeter Amplifier": [1],
  "Unsecured Perimeter Information Center": [1],
  "Unsecured Perimeter Comms Relay": [2],
  "Unsecured Perimeter Transponder Farm": [2],
  "Unsecured Frontier Database": [3],
  "Unsecured Frontier Receiver": [3],
  "Unsecured Frontier Digital Nexus": [4],
  "Unsecured Frontier Trinary Hub": [4],
  "Unsecured Frontier Enclave Relay": [5],
  "Unsecured Frontier Server Bank": [5],
  "Unsecured Core Backup Array": [6],
  "Unsecured Core Emergence": [6],
});

const SLEEPER_RELIC_CLASSES = Object.freeze({
  "Forgotten Perimeter Coronation Platform": [1],
  "Forgotten Perimeter Power Array": [1],
  "Forgotten Perimeter Gateway": [2],
  "Forgotten Perimeter Habitation Coils": [2],
  "Forgotten Frontier Quarantine Outpost": [3],
  "Forgotten Frontier Recursive Depot": [3],
  "Forgotten Frontier Conversion Module": [4],
  "Forgotten Frontier Evacuation Center": [4],
  "Forgotten Core Data Field": [5],
  "Forgotten Core Information Pen": [5],
  "Forgotten Core Assembly Hall": [6],
  "Forgotten Core Circuitry Disassembler": [6],
});

const GAS_SITE_CLASSES = Object.freeze({
  // The Gas cloud harvesting page and the community class tables both put the
  // Perimeter reservoirs in every class; only the Wormhole sites page's
  // heading groups them as classes 1 to 4, which is a simplification.
  "Barren Perimeter Reservoir": [1, 2, 3, 4, 5, 6],
  "Token Perimeter Reservoir": [1, 2, 3, 4, 5, 6],
  "Minor Perimeter Reservoir": [1, 2, 3, 4, 5, 6],
  "Ordinary Perimeter Reservoir": [1, 2, 3, 4, 5, 6],
  "Sizeable Perimeter Reservoir": [1, 2, 3, 4, 5, 6],
  "Bountiful Frontier Reservoir": [3, 4, 5, 6],
  "Vast Frontier Reservoir": [3, 4, 5, 6],
  "Instrumental Core Reservoir": [5, 6],
  "Vital Core Reservoir": [5, 6],
});
// Core reservoirs also appear in every shattered system.
const SHATTERED_ALSO_SITE_NAMES = Object.freeze(new Set([
  "Instrumental Core Reservoir",
  "Vital Core Reservoir",
]));

const ORE_SITE_CLASSES = Object.freeze({
  "Common Perimeter Deposit": [1, 2, 3, 4, 5, 6],
  "Ordinary Perimeter Deposit": [1, 2, 3, 4, 5, 6],
  "Average Frontier Deposit": [1, 2, 3, 4, 5, 6],
  "Unexceptional Frontier Deposit": [1, 2, 3, 4, 5, 6],
  "Exceptional Core Deposit": [5, 6],
  "Infrequent Core Deposit": [5, 6],
  "Isolated Core Deposit": [5, 6],
  "Rarified Core Deposit": [5, 6],
  "Uncommon Core Deposit": [5, 6],
  "Unusual Core Deposit": [5, 6],
});
// Shattered systems and C13s only.
const SHATTERED_ONLY_SITE_NAMES = Object.freeze(new Set([
  "Shattered Debris Field",
  "Shattered Ice Field",
]));

// Sites that never spawn in wormhole space although their family has a
// wormhole band.
const NEVER_IN_WORMHOLE_PATTERNS = Object.freeze([
  /\bSleeper Cache\b/i,
]);

// Pirate relic and data sites and rogue drone relic sites reach only the low
// classes; rogue drone data sites stay in the drone regions.
const EXPLORATION_FACTION_CLASSES = Object.freeze([1, 2, 3]);
const EXPLORATION_SITE_FAMILIES = Object.freeze(new Set(["data", "relic"]));
// Families whose content is at home in every wormhole class (ghost sites'
// Superior tier) or that scope wormhole space themselves (drifter hives).
const ANY_CLASS_SITE_FAMILIES = Object.freeze(new Set(["ghost"]));
const SELF_SCOPED_SPAWN_FAMILY_PREFIXES = Object.freeze(["drifter_"]);
// Site families that wormhole space only hosts by name (documented Sleeper
// and resource sites) or by the exploration faction rule; anything else of
// these families is known-space content.
const WHITELISTED_SITE_FAMILIES = Object.freeze(new Set(["combat", "data", "relic", "gas", "ore", "ice", "combat_hacking"]));

const SITE_CLASSES_BY_NAME = Object.freeze({
  ...SLEEPER_ANOMALY_CLASSES,
  ...SLEEPER_DATA_CLASSES,
  ...SLEEPER_RELIC_CLASSES,
  ...GAS_SITE_CLASSES,
  ...ORE_SITE_CLASSES,
});

let shatteredSystemIDsCache = null;

function normalizeName(value) {
  return String(value == null ? "" : value).trim();
}

function listShatteredSystemIDs() {
  if (shatteredSystemIDsCache) {
    return shatteredSystemIDsCache;
  }
  const wanted = new Set(SHATTERED_SYSTEM_NAMES);
  const ids = new Set();
  for (const system of worldData.getSolarSystems()) {
    const name = normalizeName(system && (system.solarSystemName || system.name));
    if (wanted.has(name)) {
      ids.add(toInt(system.solarSystemID, 0));
    }
  }
  shatteredSystemIDsCache = ids;
  return ids;
}

function isShatteredSystem(systemID, classID = null) {
  const numericSystemID = toInt(systemID, 0);
  const resolvedClass = classID == null ? wormholeAuthority.getSystemClassID(numericSystemID) : toInt(classID, 0);
  if (resolvedClass === THERA_CLASS_ID || resolvedClass === SMALL_SHIP_SHATTERED_CLASS_ID) {
    return true;
  }
  return listShatteredSystemIDs().has(numericSystemID);
}

// Classes whose sites a system may host. Ordinary systems take their own
// class; shattered systems take one class up and down as well; the small-ship
// shattered systems take the C1 to C3 set; Thera hosts class 3 and 4 Sleeper
// content; drifter systems host only their hive families.
function resolveSiteClasses(classID, shattered) {
  const numericClass = toInt(classID, 0);
  if (numericClass === THERA_CLASS_ID) {
    return [3, 4];
  }
  if (numericClass === SMALL_SHIP_SHATTERED_CLASS_ID) {
    // The 25 small-ship shattered systems host classes 1 to 3, and also
    // anything that names class 13 itself (the fullerite reservoirs do).
    return [1, 2, 3, SMALL_SHIP_SHATTERED_CLASS_ID];
  }
  if (!ORDINARY_CLASS_IDS.includes(numericClass)) {
    return [];
  }
  if (!shattered) {
    return [numericClass];
  }
  return [numericClass - 1, numericClass, numericClass + 1]
    .filter((candidate) => ORDINARY_CLASS_IDS.includes(candidate));
}

function resolveKind(classID) {
  const numericClass = toInt(classID, 0);
  if (numericClass === THERA_CLASS_ID) {
    return "thera";
  }
  if (numericClass === SMALL_SHIP_SHATTERED_CLASS_ID) {
    return "small_ship_shattered";
  }
  if (DRIFTER_CLASS_IDS.includes(numericClass)) {
    return "drifter";
  }
  if (ORDINARY_CLASS_IDS.includes(numericClass)) {
    return "wormhole";
  }
  return "known_space";
}

function getWormholeSpaceProfile(systemID) {
  const numericSystemID = toInt(systemID, 0);
  const classID = wormholeAuthority.getSystemClassID(numericSystemID);
  const kind = resolveKind(classID);
  const shattered = kind === "known_space" ? false : isShatteredSystem(numericSystemID, classID);
  return {
    systemID: numericSystemID,
    classID,
    kind,
    isWormholeSpace: kind !== "known_space",
    shattered,
    siteClasses: resolveSiteClasses(classID, shattered),
  };
}

function normalizeClassList(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => toInt(value, 0))
    .filter((value) => ORDINARY_CLASS_IDS.includes(value)))]
    .sort((left, right) => left - right);
}

function templateName(template) {
  return normalizeName(template && (template.resolvedName || template.name || template.templateID));
}

// Returns the wormhole restriction a template carries, or null when it is
// unrestricted inside wormhole space:
//   { classes, shatteredOnly, shatteredAlso, source }
// Wormhole space is a whitelist: a template of a whitelisted site family
// spawns there only when it carries `wormholeClasses`, is a documented site
// name, or is pirate/drone exploration content; the rest of those families is
// known-space content and gets an empty class list.
function resolveTemplateWormholeRestriction(template, context = {}) {
  if (!template || typeof template !== "object") {
    return null;
  }
  const name = templateName(template);
  const siteFamily = String(template.siteFamily || "").trim().toLowerCase();
  const spawnFamilyKey = String(context.spawnFamilyKey || template.spawnFamilyKey || "").trim().toLowerCase();
  if (SELF_SCOPED_SPAWN_FAMILY_PREFIXES.some((prefix) => spawnFamilyKey.startsWith(prefix))) {
    return null;
  }
  if (Array.isArray(template.wormholeClasses)) {
    return {
      classes: normalizeClassList(template.wormholeClasses),
      shatteredOnly: template.wormholeShatteredOnly === true,
      shatteredAlso: template.wormholeShatteredAlso === true,
      source: "template",
    };
  }
  if (NEVER_IN_WORMHOLE_PATTERNS.some((pattern) => pattern.test(name))) {
    return { classes: [], shatteredOnly: false, shatteredAlso: false, source: "never_in_wormhole_space" };
  }
  if (SHATTERED_ONLY_SITE_NAMES.has(name)) {
    return { classes: [...ORDINARY_CLASS_IDS], shatteredOnly: true, shatteredAlso: false, source: "site_name" };
  }
  if (Object.prototype.hasOwnProperty.call(SITE_CLASSES_BY_NAME, name)) {
    return {
      classes: [...SITE_CLASSES_BY_NAME[name]],
      shatteredOnly: false,
      shatteredAlso: SHATTERED_ALSO_SITE_NAMES.has(name),
      source: "site_name",
    };
  }
  if (ANY_CLASS_SITE_FAMILIES.has(siteFamily)) {
    return { classes: [...ORDINARY_CLASS_IDS], shatteredOnly: false, shatteredAlso: true, source: "family_rule" };
  }
  if (EXPLORATION_SITE_FAMILIES.has(siteFamily)) {
    const factionKeys = pirateFactionPolicy.resolveTemplatePirateFactionKeys(template);
    const droneDataSite = siteFamily === "data" && factionKeys.includes("rogue_drones");
    if (factionKeys.length > 0 && !droneDataSite) {
      return {
        classes: [...EXPLORATION_FACTION_CLASSES],
        shatteredOnly: false,
        shatteredAlso: true,
        source: "exploration_faction_rule",
      };
    }
  }
  if (WHITELISTED_SITE_FAMILIES.has(siteFamily)) {
    return { classes: [], shatteredOnly: false, shatteredAlso: false, source: "known_space_content" };
  }
  return null;
}

// Decides whether a template may spawn in the given system. Returns null when
// the system is not wormhole space or the template is unrestricted there.
function evaluateTemplateInWormholeSystem(template, systemID, context = {}) {
  const profile = getWormholeSpaceProfile(systemID);
  if (!profile.isWormholeSpace) {
    return null;
  }
  const restriction = resolveTemplateWormholeRestriction(template, context);
  if (!restriction) {
    return null;
  }
  const matchesClass = restriction.classes.some((classID) => profile.siteClasses.includes(classID));
  let allowed;
  let reason;
  if (restriction.classes.length <= 0) {
    allowed = false;
    reason = restriction.source === "known_space_content" ? "known_space_content" : "not_in_wormhole_space";
  } else if (restriction.shatteredOnly) {
    allowed = profile.shattered;
    reason = allowed ? "allowed_shattered_site" : "wormhole_shattered_only";
  } else if (matchesClass) {
    allowed = true;
    reason = "allowed_wormhole_class";
  } else if (restriction.shatteredAlso && profile.shattered) {
    allowed = true;
    reason = "allowed_shattered_extension";
  } else {
    allowed = false;
    reason = "wrong_wormhole_class";
  }
  return {
    allowed,
    reason,
    systemClassID: profile.classID,
    systemKind: profile.kind,
    shattered: profile.shattered,
    siteClasses: [...profile.siteClasses],
    requiredClasses: [...restriction.classes],
    restrictionSource: restriction.source,
  };
}

function clearCacheForTests() {
  shatteredSystemIDsCache = null;
}

module.exports = {
  DRIFTER_CLASS_IDS,
  EXPLORATION_FACTION_CLASSES,
  ORDINARY_CLASS_IDS,
  SHATTERED_ONLY_SITE_NAMES,
  SHATTERED_SYSTEM_NAMES,
  SITE_CLASSES_BY_NAME,
  SMALL_SHIP_SHATTERED_CLASS_ID,
  THERA_CLASS_ID,
  clearCacheForTests,
  evaluateTemplateInWormholeSystem,
  getWormholeSpaceProfile,
  isShatteredSystem,
  listShatteredSystemIDs,
  resolveSiteClasses,
  resolveTemplateWormholeRestriction,
};
