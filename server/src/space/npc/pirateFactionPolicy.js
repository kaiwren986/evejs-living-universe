"use strict";

const {
  toInt,
} = require("../../common/numbers");

const path = require("path");

const worldData = require(path.join(__dirname, "../worldData"));

const TEMPLATE_CLASSIFIER_VERSION = 1;

const PIRATE_FACTION_BY_FACTION_ID = Object.freeze({
  500010: "guristas",
  500011: "angels",
  500012: "blood",
  500019: "sanshas",
  500020: "serpentis",
  500025: "rogue_drones",
});

// The client tags rogue drone, Sleeper and several event sites with the generic
// "Unknown" faction (500021); it carries no faction evidence, so templates that
// use it are classified by their explicit factionKey or their name instead.
const TEMPLATE_PIRATE_FACTION_BY_FACTION_ID = Object.freeze({
  ...PIRATE_FACTION_BY_FACTION_ID,
});

const EMPIRE_FALLBACK_PIRATE_BY_FACTION_ID = Object.freeze({
  500001: "guristas",
  500002: "angels",
  500004: "serpentis",
  500007: "sanshas",
  500008: "sanshas",
});

const PIRATE_FACTION_BY_REGION_ID = Object.freeze({
  // Caldari / Guristas border and NPC space.
  10000002: "guristas",
  10000010: "guristas",
  10000015: "guristas",
  10000016: "guristas",
  10000023: "guristas",
  10000029: "guristas",
  10000033: "guristas",
  10000045: "guristas",
  10000055: "guristas",
  10000069: "guristas",

  // Guristas null-sec regions that used to fall through to "mixed"
  // (Vale of the Silent, Deklein, Fade). Rat faction per EVE University
  // region pages; the content-pack combat anomalies require a concrete faction.
  10000003: "guristas",
  10000035: "guristas",
  10000046: "guristas",

  // Minmatar / Angel and Angel NPC space.
  10000006: "angels",
  10000007: "angels",
  10000008: "angels",
  10000011: "angels",
  10000012: "angels",
  10000028: "angels",
  10000030: "angels",
  10000042: "angels",
  // Angel null-sec regions that used to fall through (Detorid, Insmother,
  // Immensea, Tenerifis, Omist).
  10000005: "angels",
  10000009: "angels",
  10000025: "angels",
  10000061: "angels",
  10000062: "angels",

  // Gallente / Serpentis and Serpentis NPC space.
  10000032: "serpentis",
  10000037: "serpentis",
  10000041: "serpentis",
  10000044: "serpentis",
  10000048: "serpentis",
  10000051: "serpentis",
  10000057: "serpentis",
  10000058: "serpentis",
  10000064: "serpentis",
  10000068: "serpentis",

  // Amarr west / Blood Raider and Blood Raider NPC space.
  10000038: "blood",
  10000049: "blood",
  10000050: "blood",
  10000054: "blood",
  10000060: "blood",
  10000063: "blood",
  10000065: "blood",

  // Amarr east / Ammatar / Sansha and Sansha NPC space.
  10000001: "sanshas",
  10000014: "sanshas",
  10000020: "sanshas",
  10000022: "sanshas",
  10000036: "sanshas",
  10000039: "sanshas",
  10000043: "sanshas",
  10000047: "sanshas",
  10000052: "sanshas",
  10000059: "sanshas",
  10000067: "sanshas",
  // Sansha null-sec regions that used to fall through (Impass, Feythabolis).
  10000031: "sanshas",
  10000056: "sanshas",

  // Rogue Drone regions. Phase 1 exposes this authority but does not apply
  // the five-faction local-pirate rule to Rogue Drone space.
  10000013: "rogue_drones",
  10000018: "rogue_drones",
  10000021: "rogue_drones",
  10000027: "rogue_drones",
  10000034: "rogue_drones",
  10000040: "rogue_drones",
  10000053: "rogue_drones",
  10000066: "rogue_drones",
});

// The factions a region can supply as its own local pirate group. The five
// empire-space pirates, plus the rogue drones, who hold the eight drone
// regions the same way: their relic sites and anomalies belong there and
// pirate content does not.
const SUPPORTED_LOCAL_PIRATE_FACTION_KEYS = Object.freeze([
  "guristas",
  "angels",
  "blood",
  "sanshas",
  "serpentis",
  "rogue_drones",
]);

const CONCRETE_PIRATE_FACTION_KEYS = new Set([
  ...SUPPORTED_LOCAL_PIRATE_FACTION_KEYS,
  "rogue_drones",
  // Sleepers own wormhole space; the client tags their sites with the generic
  // "Unknown" factionID, so packs name the faction explicitly.
  "sleepers",
]);

const SPECIAL_REGION_IDS = new Set([
  10000070, // Pochven
  10001000, // Zarzakh
]);

const SPECIAL_SYSTEM_FACTION_IDS = new Set([
  500026, // Triglavian Collective
  500029, // Deathless Circle
]);

const TEXT_FACTION_PATTERNS = Object.freeze([
  Object.freeze({ key: "guristas", pattern: /\b(?:guristas?|pith(?:i|um|atis)?)\b/i }),
  Object.freeze({ key: "serpentis", pattern: /\b(?:serpentis|guardian angels?)\b/i }),
  Object.freeze({ key: "angels", pattern: /\b(?:angel cartel|arch angels?|domination|angels?)\b/i }),
  Object.freeze({ key: "blood", pattern: /\b(?:blood raiders?|blood raider covenant|dark blood|crimson hand)\b/i }),
  Object.freeze({ key: "sanshas", pattern: /\b(?:sansha(?:'s)?(?: nation)?|true sansha)\b/i }),
  Object.freeze({ key: "rogue_drones", pattern: /\b(?:rogue drones?|rogue_drones)\b/i }),
]);

const COMMUNITY_TEMPLATE_NAME_PATTERNS = Object.freeze([
  Object.freeze({ key: "serpentis", pattern: /\b(?:guardian angels?|serpentis|core runner)\b/i }),
  Object.freeze({ key: "guristas", pattern: /\b(?:guristas?|pith(?:i|um|atis)?|h-pa crew)\b/i }),
  Object.freeze({ key: "angels", pattern: /\b(?:angel cartel|arch angels?|domination|elohim|angel)\b/i }),
  Object.freeze({ key: "blood", pattern: /\b(?:blood raiders?|dark blood|crimson hand|chain mindflood)\b/i }),
  Object.freeze({ key: "sanshas", pattern: /\b(?:sansha(?:'s)?(?: nation)?|true sansha|pdw-09fx)\b/i }),
  Object.freeze({ key: "rogue_drones", pattern: /\b(?:rogue drones?|drone infestation|drone hive)\b/i }),
]);

function normalizeLowerText(value, fallback = "") {
  const normalized = String(value == null ? "" : value).trim().toLowerCase();
  return normalized || fallback;
}

function normalizeExplicitFactionKey(value) {
  const normalized = normalizeLowerText(value, "");
  return CONCRETE_PIRATE_FACTION_KEYS.has(normalized) ? normalized : "";
}

function isSupportedLocalPirateFactionKey(value) {
  return SUPPORTED_LOCAL_PIRATE_FACTION_KEYS.includes(normalizeLowerText(value, ""));
}

// Wormhole space (J-space, Thera, the drifter hives): no local pirate faction,
// but ordinary content lives there under the wormhole class rules. It is not
// special space in the Pochven/Zarzakh sense.
function isWormholeSpaceSystem(systemID) {
  const numericSystemID = toInt(systemID, 0);
  return numericSystemID >= 31_000_000 && numericSystemID <= 31_999_999;
}

function isSpecialSpaceSystem(systemID, systemRecord = null) {
  const numericSystemID = toInt(systemID, 0);
  const system = systemRecord && typeof systemRecord === "object"
    ? systemRecord
    : worldData.getSolarSystemByID(numericSystemID);
  const regionID = toInt(system && system.regionID, 0);
  const factionID = toInt(system && system.factionID, 0);
  return (
    SPECIAL_REGION_IDS.has(regionID) ||
    SPECIAL_SYSTEM_FACTION_IDS.has(factionID)
  );
}

function buildSystemFactionResolution(systemID, system, factionKey, source) {
  const numericSystemID = toInt(systemID, 0);
  const regionID = toInt(system && system.regionID, 0);
  const factionID = toInt(system && system.factionID, 0);
  return {
    systemID: numericSystemID,
    regionID: regionID || null,
    factionID: factionID || null,
    factionKey,
    source,
    specialSpace: isSpecialSpaceSystem(numericSystemID, system),
    wormholeSpace: isWormholeSpaceSystem(numericSystemID),
    supportedLocalFaction: isSupportedLocalPirateFactionKey(factionKey),
  };
}

function resolvePirateFactionForSystem(systemID, options = {}) {
  const numericSystemID = toInt(systemID, 0);
  const system = options.systemRecord && typeof options.systemRecord === "object"
    ? options.systemRecord
    : worldData.getSolarSystemByID(numericSystemID);
  const explicitFactionKey = normalizeExplicitFactionKey(options.factionKey);
  if (explicitFactionKey) {
    return buildSystemFactionResolution(
      numericSystemID,
      system,
      explicitFactionKey,
      "explicit_override",
    );
  }

  if (isWormholeSpaceSystem(numericSystemID)) {
    return buildSystemFactionResolution(numericSystemID, system, "sleepers", "wormhole");
  }

  if (
    options.allowSpecialSpaceEmpireFallback !== true &&
    isSpecialSpaceSystem(numericSystemID, system)
  ) {
    return buildSystemFactionResolution(numericSystemID, system, "mixed", "special_space");
  }

  const factionID = toInt(system && system.factionID, 0);
  const regionID = toInt(system && system.regionID, 0);
  if (PIRATE_FACTION_BY_FACTION_ID[factionID]) {
    return buildSystemFactionResolution(
      numericSystemID,
      system,
      PIRATE_FACTION_BY_FACTION_ID[factionID],
      "faction_id",
    );
  }
  if (PIRATE_FACTION_BY_REGION_ID[regionID]) {
    return buildSystemFactionResolution(
      numericSystemID,
      system,
      PIRATE_FACTION_BY_REGION_ID[regionID],
      "region",
    );
  }
  if (EMPIRE_FALLBACK_PIRATE_BY_FACTION_ID[factionID]) {
    return buildSystemFactionResolution(
      numericSystemID,
      system,
      EMPIRE_FALLBACK_PIRATE_BY_FACTION_ID[factionID],
      "empire_fallback",
    );
  }
  return buildSystemFactionResolution(numericSystemID, system, "mixed", "unmapped");
}

function resolvePirateFactionKeyForSystem(systemID, options = {}) {
  return resolvePirateFactionForSystem(systemID, {
    ...options,
    // This compatibility helper preserves the resolver semantics previously
    // exported by beltRatRuntime. Dungeon policy uses the richer safe result.
    allowSpecialSpaceEmpireFallback: true,
  }).factionKey;
}

function classifyTextFaction(value, patterns = TEXT_FACTION_PATTERNS) {
  const normalized = String(value == null ? "" : value).trim();
  if (!normalized) {
    return "";
  }
  const match = patterns.find((entry) => entry.pattern.test(normalized));
  return match ? match.key : "";
}

function listTemplateSpawnQueries(template = {}) {
  const populationHints = template.populationHints && typeof template.populationHints === "object"
    ? template.populationHints
    : {};
  return [
    populationHints.encounter,
    ...(Array.isArray(populationHints.encounters) ? populationHints.encounters : []),
  ]
    .filter((entry) => entry && typeof entry === "object")
    .map((entry) => normalizeLowerText(entry.spawnQuery, ""))
    .filter(Boolean);
}

function resolveSpawnQueryFactionKey(value) {
  const normalized = normalizeLowerText(value, "");
  const match = /^(guristas|angels|blood|sanshas|serpentis|rogue_drones|sleepers)(?:_|$)/.exec(normalized);
  return match ? match[1] : "";
}

function resolveTemplatePirateFactionKeys(template = {}) {
  if (!template || typeof template !== "object") {
    return [];
  }

  // A pack names its faction explicitly; that beats the client factionID,
  // which the client shares between rogue drones and Sleepers ("Unknown").
  const explicitFactionKey = normalizeExplicitFactionKey(template.factionKey);
  if (explicitFactionKey) {
    return [explicitFactionKey];
  }

  // A mapped pirate factionID is decisive; an unmapped one (empire factions,
  // the client's generic "Unknown") says nothing and the other evidence decides.
  const factionID = toInt(template.factionID, 0);
  const factionIDKey = factionID > 0 ? TEMPLATE_PIRATE_FACTION_BY_FACTION_ID[factionID] || "" : "";
  if (factionIDKey) {
    return [factionIDKey];
  }

  const metadata = template.metadata && typeof template.metadata === "object"
    ? template.metadata
    : {};
  const textualFactionValues = [
    template.factionKey,
    template.faction,
    template.factionName,
    template.pirateFaction,
    template.npcFaction,
    metadata.factionKey,
    metadata.faction,
    metadata.factionName,
  ];
  for (const value of textualFactionValues) {
    const factionKey = classifyTextFaction(value);
    if (factionKey) {
      return [factionKey];
    }
  }

  const spawnQueryFactionKeys = [...new Set(
    listTemplateSpawnQueries(template)
      .map(resolveSpawnQueryFactionKey)
      .filter(Boolean),
  )];
  if (spawnQueryFactionKeys.length > 0) {
    return spawnQueryFactionKeys;
  }

  const templateName = template.resolvedName || template.name || "";
  const nameFactionKey = classifyTextFaction(templateName, COMMUNITY_TEMPLATE_NAME_PATTERNS);
  return nameFactionKey ? [nameFactionKey] : [];
}

module.exports = {
  TEMPLATE_CLASSIFIER_VERSION,
  PIRATE_FACTION_BY_FACTION_ID,
  TEMPLATE_PIRATE_FACTION_BY_FACTION_ID,
  EMPIRE_FALLBACK_PIRATE_BY_FACTION_ID,
  PIRATE_FACTION_BY_REGION_ID,
  SUPPORTED_LOCAL_PIRATE_FACTION_KEYS,
  isSpecialSpaceSystem,
  isSupportedLocalPirateFactionKey,
  isWormholeSpaceSystem,
  resolvePirateFactionForSystem,
  resolvePirateFactionKeyForSystem,
  resolveTemplatePirateFactionKeys,
  _testing: {
    COMMUNITY_TEMPLATE_NAME_PATTERNS,
    SPECIAL_REGION_IDS,
    SPECIAL_SYSTEM_FACTION_IDS,
    TEXT_FACTION_PATTERNS,
    classifyTextFaction,
    listTemplateSpawnQueries,
    normalizeExplicitFactionKey,
    resolveSpawnQueryFactionKey,
  },
};
