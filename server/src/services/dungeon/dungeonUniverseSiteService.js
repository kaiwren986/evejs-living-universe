"use strict";

const {
  cloneValue,
} = require("../../common/clone");
const {
  toFiniteNumber,
} = require("../../common/numbers");

const fs = require("fs");
const path = require("path");
const { isDeepStrictEqual } = require("util");

const log = require(path.join(__dirname, "../../utils/logger"));
const BaseService = require(path.join(__dirname, "../baseService"));
const dungeonAuthority = require(path.join(__dirname, "./dungeonAuthority"));
const dungeonRuntime = require(path.join(__dirname, "./dungeonRuntime"));
const dungeonTrackingRuntime = require(path.join(__dirname, "./dungeonTrackingRuntime"));
const dungeonVisibilityPolicy = require(path.join(__dirname, "./dungeonVisibilityPolicy"));
const loadedMissionRuntime = require(path.join(__dirname, "../agent/loadedMissionRuntime"));
const {
  entityIDsEqual,
  getEntityIDText,
  normalizePersistentEntityID,
} = require(path.join(__dirname, "../../space/destiny/identity/entityID"));
const {
  canEntitiesInteractLocally,
} = require(path.join(
  __dirname,
  "../../space/destiny/identity/interactionScope.js",
));
const {
  DESTINY_BOOTSTRAP_DELIVERY_ADDBALLS2,
  resolveSiteEnvironmentPropDestinyPresentation,
} = require(path.join(__dirname, "../../space/destiny/presentation/siteEnvironment"));
const explorationAuthority = require(path.join(__dirname, "../exploration/explorationAuthority"));
const {
  listItemTypes,
  listExactItemMatchesByName,
  resolveItemByName,
  resolveItemByTypeID,
} = require(path.join(__dirname, "../inventory/itemTypeRegistry"));
const { rollTieredContainerLoot } = require("./containerLootTables");
const { resolveHackingDifficultyTier } = require("../exploration/hackingBoardEngine");
const {
  getTypeAttributeValue,
} = require(path.join(__dirname, "../fitting/liveFittingState"));
const {
  isDestructibleNpcSentry,
} = require(path.join(__dirname, "../../space/npc/npcSentryPolicy"));
const {
  grantItemsToOwnerLocation,
  findItemById,
  listItemsMatching,
  listContainerItems,
  ITEM_FLAGS,
  pruneIdempotentGrantReceipts,
  removeInventoryItem,
  updateInventoryItem,
} = require(path.join(__dirname, "../inventory/itemStore"));
const {
  isBlueprintCopyRewardType,
  resolveBlueprintLootCopyState,
  ensureGrantedBlueprintCopyState,
} = require("../inventory/blueprintRewardState");
const { resolveSiteBlueprintLootSource } = require("./siteBlueprintLootSources");

const COSMIC_SIGNATURE_TYPE_ID = 19_728;
const COSMIC_SIGNATURE_GROUP_ID = 502;
const COSMIC_ANOMALY_TYPE_ID = 28_356;
const COSMIC_ANOMALY_GROUP_ID = 885;
const SITE_CONTENT_CONTAINER_ID_BASE = 6_200_000_000_000;
const SITE_CONTENT_HAZARD_ID_BASE = 6_300_000_000_000;
const SITE_CONTENT_ENVIRONMENT_ID_BASE = 6_400_000_000_000;
const SITE_CONTENT_GATE_ID_BASE = 6_450_000_000_000;
const SITE_CONTENT_OBJECTIVE_ID_BASE = 6_500_000_000_000;
const SITE_CONTENT_KILLABLE_STRUCTURE_ID_BASE = 6_700_000_000_000;
const MANUAL_DUNGEON_SITE_ID_BASE = 6_800_000_000_000;
const MANUAL_DUNGEON_SITE_LIFETIME_MS = 2 * 60 * 60 * 1000;
const SITE_CONTENT_ENCOUNTER_OFFSET_METERS = 25_000;
const SITE_CONTENT_REWARD_OFFSET_METERS = 16_000;
const SITE_CONTENT_CONTAINER_RING_METERS = 12_500;
const SITE_CONTENT_CONTAINER_JITTER_METERS = 3_500;
// Default trigger range for proximity-spawned encounters when a plan omits proximityRangeMeters.
const SITE_CONTENT_PROXIMITY_DEFAULT_RANGE_METERS = 7_500;
// Default pickup range for a proximity fetch objective (auto_cargo_on_proximity) when the pack
// omits triggerRangeMeters. A TQ log records WHEN the item landed in cargo, not the authored
// radius, so the decoder normally cannot bound it; 2,500 m is EVE's usual object-interaction
// distance and is tight enough that the pilot has to actually fly to the object rather than
// collect it from across the pocket.
const SITE_CONTENT_FETCH_PROXIMITY_DEFAULT_RANGE_METERS = 2_500;
const SITE_CONTENT_MAX_CONTAINER_COUNT = 24;
// Mission mining rocks: special mineable asteroids placed in the deadspace site (Plan C).
// NOTE: must be unique vs the other SITE_CONTENT_*_ID_BASE values. It previously aliased
// SITE_CONTENT_ENVIRONMENT_ID_BASE (6.4e12), so on a site that also spawned environment props the rock's
// itemID collided with an already-spawned prop and was skipped as "already present" (no asteroid).
const SITE_CONTENT_MINING_ROCK_ID_BASE = 6_600_000_000_000;
// Renderable asteroid SHELL types (categoryID 2, real 3D model/graphicID) - the in-space ball MUST present
// one of these. The mission ore (Banidine 28617 etc.) is categoryID 25 with graphicID 0 / no model; putting
// it directly in the renderable ball fields makes the retail client crash to desktop building a modelless
// asteroid. So the shell goes in the ball/typeID fields and the ore only in slim*/miningYield* (same split
// belt asteroids use in buildSystemOreAsteroidEntity).
const MINING_ROCK_SHELL_TYPE_IDS = Object.freeze([
  64063, 64064, 64065, 64066, 64067, 64068, 64069, 64070,
  64071, 64072, 64073, 64074, 64075, 64076, 64077,
]);
const SITE_CONTENT_MAX_MINING_ROCK_COUNT = 64;
const SITE_CONTENT_MAX_EXACT_MINING_ROCK_COUNT = 512;
const SITE_CONTENT_MAX_ENCOUNTER_NPCS = 8;
const SITE_CONTENT_MAX_EXACT_ENCOUNTER_NPCS = 96;
const SITE_CONTENT_MAX_HAZARD_COUNT = 6;
const SITE_CONTENT_MAX_ENVIRONMENT_PROPS = 8;
const SITE_CONTENT_MAX_EXACT_ENVIRONMENT_PROPS = 512;
const SITE_CONTENT_MAX_GATE_COUNT = 6;
const SITE_CONTENT_MAX_EXACT_GATE_COUNT = 96;
const SITE_CONTENT_MAX_OBJECTIVE_MARKERS = 6;
const SITE_CONTENT_MAX_LOOT_ENTRIES = 4;
const SITE_CONTENT_MAX_TRIGGER_NOTIFICATIONS = 16;
const SITE_CONTENT_BEHAVIOR_TICK_INTERVAL_MS = 1_000;
const CLEARED_ANOMALY_ROTATION_DELAY_MS = 0;
// Grid radius used to decide whether a cleared site still has players in it. Matches the ~250km at
// which the client treats objects as sharing a grid.
const SITE_OCCUPANCY_GRACE_RANGE_METERS = 250_000;
const SITE_CONTENT_OWNER_ID = 1;
const SITE_CONTENT_SAFE_SLIM_CATEGORY_ID = 2;
const DEFAULT_ACCELERATION_GATE_ACTIVATION_RANGE_METERS = 2_500;
const CONTAINER_COMPLETION_SITE_FAMILIES = new Set(["data", "relic", "ghost", "combat_hacking"]);
const DATA_RELIC_CONTAINER_ANALYZERS = new Set(["data", "relic"]);
const HACKING_STATE_HACKED = 2;
const SITE_NAME_LOOKUP_PATH = path.join(
  __dirname,
  "../../../../tools/SignalAtlas/data/siteNameLookup.json",
);

let runtimeSyncStarted = false;
let registeredListener = null;
let siteBehaviorTicker = null;
let cachedGenericContainerType = undefined;
let cachedSiteNameLookup = undefined;
const cachedContainerTypeRecordByName = new Map();
const cachedGenericTypeRecordByName = new Map();
const cachedLootTypeRecordByName = new Map();
let cachedBlueprintLootTypeRecords = null;

function buildSafeSitePropSlimOverrides(typeRecord = null) {
  const rawCategoryID = Math.max(0, toInt(typeRecord && typeRecord.categoryID, 0));
  if (![11, 23].includes(rawCategoryID)) {
    return {};
  }
  return {
    // These deadspace/ambient props use entity/starbase categories in CCP data,
    // but the packaged client's bracket/state paths then expect POS/entity
    // metadata we do not send for passive site dressing. Keep the real
    // type/graphic for rendering, but advertise a safe slim category.
    slimCategoryID: SITE_CONTENT_SAFE_SLIM_CATEGORY_ID,
  };
}

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function normalizeText(value, fallback = "") {
  const normalized = String(value == null ? "" : value).trim();
  return normalized || fallback;
}

function normalizeLowerText(value, fallback = "") {
  return normalizeText(value, fallback).toLowerCase();
}

function normalizeSlimNullableValue(value) {
  if (value === undefined || value === null) {
    return null;
  }
  const normalized = String(value).trim();
  if (!normalized || normalized.toLowerCase() === "none" || normalized.toLowerCase() === "null") {
    return null;
  }
  return value;
}

function normalizeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeMaybeArray(value) {
  if (Array.isArray(value)) {
    return value;
  }
  return value === undefined || value === null ? [] : [value];
}

function uniqueSorted(values) {
  return [...new Set(normalizeArray(values).filter(Boolean))]
    .sort((left, right) => String(left).localeCompare(String(right)));
}

function normalizeIDList(value) {
  return [...new Set(
    normalizeArray(value)
      .map((entry) => Math.max(0, toInt(entry, 0)))
      .filter((entry) => entry > 0),
  )].sort((left, right) => left - right);
}

function resolveGateDungeonObjectID(gateProfile, gateState, gateKey) {
  const explicitObjectID = Math.max(
    0,
    toInt(
      gateProfile && (gateProfile.dungeonObjectID || gateProfile.dunObjectID || gateProfile.fromObjectID),
      0,
    ),
  );
  if (explicitObjectID > 0) {
    return explicitObjectID;
  }

  const metadata = normalizeObject(gateState && gateState.metadata);
  const metadataObjectID = Math.max(
    0,
    toInt(metadata.dungeonObjectID || metadata.dunObjectID || metadata.fromObjectID, 0),
  );
  if (metadataObjectID > 0) {
    return metadataObjectID;
  }

  const gateKeyMatch = String(gateKey || "").match(/(\d+)$/);
  return gateKeyMatch ? Math.max(0, toInt(gateKeyMatch[1], 0)) : 0;
}

function resolveGateActivationRangeMeters(gateProfile, typeID) {
  const explicitRange = toFiniteNumber(
    gateProfile && (gateProfile.gateActivationRange || gateProfile.activationRange || gateProfile.proximityRange),
    0,
  );
  if (explicitRange > 0) {
    return explicitRange;
  }

  return (
    toFiniteNumber(
      getTypeAttributeValue(typeID, "proximityRange", "Activation proximity"),
      0,
    ) ||
    DEFAULT_ACCELERATION_GATE_ACTIVATION_RANGE_METERS
  );
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null);
}

function resolveGateRequirementMetadata(gateProfile, gateState) {
  const metadata = normalizeObject(gateState && gateState.metadata);
  const rawConnection = normalizeObject(metadata.rawConnection);
  return {
    keyLock: firstDefined(
      gateProfile && gateProfile.keyLock,
      gateProfile && gateProfile.keylock,
      gateProfile && gateProfile.keyLockType,
      gateState && gateState.keyLock,
      gateState && gateState.keylock,
      metadata.keyLock,
      metadata.keylock,
      metadata.keyLockType,
      rawConnection.keyLock,
      rawConnection.keylock,
      rawConnection.keyLockType,
    ),
    requiredItems: firstDefined(
      gateProfile && gateProfile.requiredItems,
      gateProfile && gateProfile.requiredKeyItems,
      gateProfile && gateProfile.requiredItemTypeIDs,
      gateProfile && gateProfile.requiredKeyTypeIDs,
      gateProfile && gateProfile.keyTypeIDs,
      gateProfile && gateProfile.passcardTypeIDs,
      gateState && gateState.requiredItems,
      metadata.requiredItems,
      metadata.requiredKeyItems,
      metadata.requiredItemTypeIDs,
      metadata.requiredKeyTypeIDs,
      rawConnection.requiredItems,
      rawConnection.requiredKeyItems,
      rawConnection.requiredItemTypeIDs,
      rawConnection.requiredKeyTypeIDs,
    ),
    requiredItemTypeID: Math.max(
      0,
      toInt(
        firstDefined(
          gateProfile && gateProfile.requiredItemTypeID,
          gateProfile && gateProfile.requiredKeyTypeID,
          gateProfile && gateProfile.keyTypeID,
          gateProfile && gateProfile.keyItemTypeID,
          gateProfile && gateProfile.passcardTypeID,
          gateState && gateState.requiredItemTypeID,
          metadata.requiredItemTypeID,
          metadata.requiredKeyTypeID,
          rawConnection.requiredItemTypeID,
          rawConnection.requiredKeyTypeID,
          rawConnection.keyTypeID,
          rawConnection.passcardTypeID,
        ),
        0,
      ),
    ) || null,
    requiredItemQuantity: Math.max(
      0,
      toInt(
        firstDefined(
          gateProfile && gateProfile.requiredItemQuantity,
          gateProfile && gateProfile.requiredQuantity,
          gateProfile && gateProfile.keyQuantity,
          gateProfile && gateProfile.passcardQuantity,
          gateState && gateState.requiredItemQuantity,
          metadata.requiredItemQuantity,
          metadata.requiredQuantity,
          rawConnection.requiredItemQuantity,
          rawConnection.requiredQuantity,
          rawConnection.keyQuantity,
          rawConnection.passcardQuantity,
        ),
        0,
      ),
    ) || null,
  };
}

function clonePosition(value) {
  return {
    x: toFiniteNumber(value && value.x, 0),
    y: toFiniteNumber(value && value.y, 0),
    z: toFiniteNumber(value && value.z, 0),
  };
}

function addVectors(left, right) {
  return {
    x: toFiniteNumber(left && left.x, 0) + toFiniteNumber(right && right.x, 0),
    y: toFiniteNumber(left && left.y, 0) + toFiniteNumber(right && right.y, 0),
    z: toFiniteNumber(left && left.z, 0) + toFiniteNumber(right && right.z, 0),
  };
}

function hashText(value) {
  const normalized = normalizeText(value, "");
  let state = 0;
  for (let index = 0; index < normalized.length; index += 1) {
    state = Math.imul(state ^ normalized.charCodeAt(index), 0x45d9f3b);
    state ^= state >>> 16;
  }
  state = Math.imul(state ^ (state >>> 16), 0x45d9f3b);
  state ^= state >>> 16;
  return state >>> 0;
}

function getSpaceRuntime() {
  return require(path.join(__dirname, "../../space/runtime"));
}

function getKeeperService() {
  // keeperService already depends on this module, so resolve it lazily after module startup.
  return require(path.join(__dirname, "./keeperService"));
}

function getNpcSpawnService() {
  return require(path.join(__dirname, "../../space/npc/npcService"));
}

function getNativeNpcService() {
  return require(path.join(__dirname, "../../space/npc/nativeNpcService"));
}

function getNativeNpcStore() {
  return require(path.join(__dirname, "../../space/npc/nativeNpcStore"));
}

function getNativeNpcWreckService() {
  return require(path.join(__dirname, "../../space/npc/nativeNpcWreckService"));
}

function getScanMgrService() {
  return require(path.join(__dirname, "../exploration/scanMgrService"));
}

function getSiteNameLookup() {
  if (cachedSiteNameLookup !== undefined) {
    return cachedSiteNameLookup;
  }
  try {
    if (!fs.existsSync(SITE_NAME_LOOKUP_PATH)) {
      cachedSiteNameLookup = null;
      return cachedSiteNameLookup;
    }
    cachedSiteNameLookup = JSON.parse(fs.readFileSync(SITE_NAME_LOOKUP_PATH, "utf8"));
    return cachedSiteNameLookup;
  } catch (error) {
    cachedSiteNameLookup = null;
    return cachedSiteNameLookup;
  }
}

function resolveSiteFamilyLabel(family) {
  switch (normalizeLowerText(family, "unknown")) {
    case "combat":
      return "Combat";
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
    case "ghost":
      return "Ghost";
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
    default:
      return "Site";
  }
}

function resolveFallbackStrengthAttribute(family) {
  switch (normalizeLowerText(family, "")) {
    case "ghost":
    case "combat_hacking":
      return explorationAuthority.getScanStrengthAttribute("data") || 208;
    // scanStrengthAttributes is keyed by scan-attribute NAME, not by site family, and EVE has no
    // "ice" scan strength attribute - ice belts group under Ore Site / gravimetric (211). Without
    // this case the lookup misses, the site ships scanStrengthAttribute null, and the client's
    // Surroundings > Anomalies menu dies on ICONS_BY_SCANGROUP[None] (KeyError: None), which takes
    // every other anomaly in the system down with it because the None group sorts first. 211 is
    // what the client itself uses: mapMarkerUtil.GetSiteBracketIcon returns the ore-site icon for
    // dunArchetypeIceBelt (28) as well as dunArchetypeOreAnomaly, and miningAnomalyProvider.js
    // already maps ice -> "ore" on the generated-mining path.
    case "ice":
      return explorationAuthority.getScanStrengthAttribute("ore") || 211;
    default:
      return explorationAuthority.getScanStrengthAttribute(family) || 0;
  }
}

function resolveContainerRoleLabel(role) {
  switch (normalizeLowerText(role, "container")) {
    case "data":
      return "Data Cache";
    case "relic":
      return "Relic Cache";
    case "research":
      return "Research Cache";
    case "covert_research":
      return "Covert Research Cache";
    default:
      return "Site Container";
  }
}

function resolveHazardLabel(hazard) {
  switch (normalizeLowerText(hazard, "hazard")) {
    case "ghost_site_timer":
      return "Ghost Site Timer Beacon";
    case "ghost_site_explosion":
      return "Ghost Site Blast Zone";
    case "ghost_site_npc_response":
      return "Ghost Site Response Beacon";
    case "reservoir_sleeper_response_timer":
      return "Reservoir Sleeper Response Timer";
    default:
      return "Site Hazard Beacon";
  }
}

function splitLabelTail(value) {
  const normalized = normalizeText(value, "");
  if (!normalized) {
    return "";
  }
  const lastSegment = normalized.split("/").pop();
  return lastSegment || normalized;
}

function humanizeIdentifier(value, fallback = "") {
  const tail = splitLabelTail(value);
  const normalized = String(tail || "")
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim();
  return normalized || fallback;
}

function resolveTypeRecordName(typeRecord, fallback = "") {
  return normalizeText(
    typeRecord && (typeRecord.name || typeRecord.typeName || typeRecord.slimName),
    fallback,
  );
}

function resolveLocalizedTemplateName(template) {
  if (normalizeText(template && template.resolvedName, "")) {
    return normalizeText(template && template.resolvedName, "");
  }
  const lookup = getSiteNameLookup();
  if (!lookup || typeof lookup !== "object") {
    return "";
  }
  const templateNamesByID =
    lookup && lookup.templateNamesByID && typeof lookup.templateNamesByID === "object"
      ? lookup.templateNamesByID
      : {};
  const dungeonNamesByMessageID =
    lookup && lookup.dungeonNamesByMessageID && typeof lookup.dungeonNamesByMessageID === "object"
      ? lookup.dungeonNamesByMessageID
      : {};
  const templateID = normalizeText(template && template.templateID, "");
  if (templateID && normalizeText(templateNamesByID[templateID], "")) {
    return normalizeText(templateNamesByID[templateID], "");
  }
  const dungeonNameID = Math.max(0, toInt(template && template.dungeonNameID, 0));
  if (dungeonNameID > 0 && normalizeText(dungeonNamesByMessageID[String(dungeonNameID)], "")) {
    return normalizeText(dungeonNamesByMessageID[String(dungeonNameID)], "");
  }
  return "";
}

function resolveGenericContainerTypeRecord() {
  if (cachedGenericContainerType !== undefined) {
    return cachedGenericContainerType;
  }
  const lookup = resolveItemByName("Cargo Container");
  cachedGenericContainerType = lookup && lookup.success && lookup.match
    ? lookup.match
    : null;
  return cachedGenericContainerType;
}

const HACKABLE_CAN_GROUP_IDS = new Set([306, 1207]);

function resolveContainerTypeRecordByName(candidateNames) {
  let fallback = null;
  for (const rawCandidate of normalizeArray(candidateNames)) {
    const candidate = normalizeText(rawCandidate, "");
    if (!candidate) {
      continue;
    }
    if (cachedContainerTypeRecordByName.has(candidate)) {
      const cached = cachedContainerTypeRecordByName.get(candidate);
      if (cached && HACKABLE_CAN_GROUP_IDS.has(toInt(cached.groupID, 0))) return cached;
      fallback ||= cached;
      continue;
    }
    const lookup = resolveItemByName(candidate, { exactOnly: true });
    const match = lookup && lookup.success && lookup.match
      ? lookup.match
      : listExactItemMatchesByName(candidate)
        .filter(entry => HACKABLE_CAN_GROUP_IDS.has(toInt(entry.groupID, 0)))
        .sort((left, right) => left.typeID - right.typeID)[0] || null;
    cachedContainerTypeRecordByName.set(candidate, match);
    if (match && HACKABLE_CAN_GROUP_IDS.has(toInt(match.groupID, 0))) {
      return match;
    }
    // Aliases can name decorative wrecks before the actual analyzer can
    // (Blood Raider Structure Ruins precedes Blood Ruins, for example).
    // Preserve ordinary container fallbacks only after checking every alias.
    fallback ||= match;
  }
  return fallback;
}

function listGenericTypeNameAliases(candidate) {
  const normalized = normalizeLowerText(candidate, "");
  const aliases = [];
  if (/\bstarbase\b.*\bstasis\b.*\btower\b/.test(normalized) || /^stasis\s+tower$/.test(normalized)) {
    aliases.push("Stasis Webification Battery");
  }
  return aliases;
}

function resolveGenericTypeRecordByName(candidateNames) {
  for (const rawCandidate of normalizeArray(candidateNames)) {
    const candidate = normalizeText(rawCandidate, "");
    if (!candidate) {
      continue;
    }
    if (cachedGenericTypeRecordByName.has(candidate)) {
      const cached = cachedGenericTypeRecordByName.get(candidate);
      if (cached) return cached;
      continue;
    }
    let match = null;
    for (const lookupName of [candidate, ...listGenericTypeNameAliases(candidate)]) {
      const lookup = resolveItemByName(lookupName);
      match = lookup && lookup.success && lookup.match
        ? lookup.match
        : null;
      if (match) {
        break;
      }
    }
    cachedGenericTypeRecordByName.set(candidate, match);
    if (match) {
      return match;
    }
  }
  return null;
}

function resolveLootTypeRecordByName(candidateName) {
  const normalizedCandidate = normalizeText(candidateName, "");
  if (!normalizedCandidate) {
    return null;
  }
  if (cachedLootTypeRecordByName.has(normalizedCandidate)) {
    return cachedLootTypeRecordByName.get(normalizedCandidate);
  }
  const lookup = resolveItemByName(normalizedCandidate);
  const match = lookup && lookup.success && lookup.match
    ? lookup.match
    : null;
  cachedLootTypeRecordByName.set(normalizedCandidate, match);
  return match;
}

function resolveTypeHealthState(typeID) {
  const normalizedTypeID = Math.max(0, toInt(typeID, 0));
  if (normalizedTypeID <= 0) {
    return {
      shieldCapacity: 0,
      armorHP: 0,
      structureHP: 0,
      conditionState: {
        shieldCharge: 0,
        armorDamage: 0,
        damage: 0,
      },
    };
  }
  const shieldCapacity = Math.max(
    0,
    toFiniteNumber(getTypeAttributeValue(normalizedTypeID, "shieldCapacity"), 0),
  );
  const armorHP = Math.max(
    0,
    toFiniteNumber(getTypeAttributeValue(normalizedTypeID, "armorHP"), 0),
  );
  const structureHP = Math.max(
    0,
    toFiniteNumber(
      getTypeAttributeValue(normalizedTypeID, "hp", "structureHP"),
      0,
    ),
  );
  return {
    shieldCapacity,
    armorHP,
    structureHP,
    conditionState: {
      shieldCharge: shieldCapacity > 0 ? 1 : 0,
      armorDamage: 0,
      damage: 0,
    },
  };
}

function chooseDeterministicEntry(entries, seed) {
  const normalizedEntries = normalizeArray(entries).filter(Boolean);
  if (normalizedEntries.length <= 0) {
    return null;
  }
  const index = hashText(seed) % normalizedEntries.length;
  return normalizedEntries[index] || normalizedEntries[0] || null;
}

function resolveDeterministicQuantity(seed, minimum, maximum) {
  const normalizedMinimum = Math.max(1, toInt(minimum, 1));
  const normalizedMaximum = Math.max(normalizedMinimum, toInt(maximum, normalizedMinimum));
  if (normalizedMaximum <= normalizedMinimum) {
    return normalizedMinimum;
  }
  return normalizedMinimum + (hashText(seed) % ((normalizedMaximum - normalizedMinimum) + 1));
}

function mergeLootGrantEntries(entries) {
  const mergedByTypeID = new Map();
  for (const entry of normalizeArray(entries).filter(Boolean)) {
    const itemType = entry && entry.itemType ? entry.itemType : null;
    const typeID = Math.max(0, toInt(itemType && itemType.typeID, 0));
    if (typeID <= 0) {
      continue;
    }
    const quantity = Math.max(1, toInt(entry && entry.quantity, 1));
    const mergeKey = entry.options?.blueprintState ? `${typeID}:copy:${mergedByTypeID.size}` : typeID;
    if (!mergedByTypeID.has(mergeKey)) {
      mergedByTypeID.set(mergeKey, {
        itemType,
        quantity,
        options: cloneValue(entry && entry.options),
      });
      continue;
    }
    mergedByTypeID.get(mergeKey).quantity += quantity;
  }
  return [...mergedByTypeID.values()];
}

function resolveLootProfileDefinition(populationHints, profileKey) {
  const normalizedProfileKey = normalizeText(profileKey, "");
  if (!normalizedProfileKey) {
    return null;
  }
  return normalizeArray(populationHints && populationHints.lootProfiles)
    .find((profile) => normalizeText(profile && profile.key, "") === normalizedProfileKey) || null;
}

function resolveContainerLootTags(containerEntity, populationHints) {
  const explicitTags = normalizeArray(
    containerEntity &&
    (
      containerEntity.dungeonSiteContentLootTags ||
      containerEntity.lootTags
    ),
  )
    .map((tag) => normalizeLowerText(tag, ""))
    .filter(Boolean);
  if (explicitTags.length > 0) {
    return explicitTags;
  }
  const profile = resolveLootProfileDefinition(
    populationHints,
    normalizeText(
      containerEntity &&
      (
        containerEntity.dungeonSiteContentLootProfile ||
        containerEntity.lootProfile
      ),
      "",
    ),
  );
  return normalizeArray(profile && profile.tags)
    .map((tag) => normalizeLowerText(tag, ""))
    .filter(Boolean);
}

function resolveBoosterFamilyFromText(value) {
  const normalized = normalizeText(value, "").toLowerCase();
  const knownFamilies = [
    "Mindflood",
    "Exile",
    "Crash",
    "X-Instinct",
    "Sooth Sayer",
    "Blue Pill",
    "Drop",
    "Frentix",
  ];
  return knownFamilies.find((family) => normalized.includes(family.toLowerCase())) || "";
}

function resolvePreferredLootItem(candidateNames, seed) {
  const resolved = normalizeArray(candidateNames)
    .map((candidate) => resolveLootTypeRecordByName(candidate))
    .filter(Boolean);
  return chooseDeterministicEntry(resolved, seed);
}

function buildLootGrantEntry(itemType, quantity = 1, options = {}) {
  if (!itemType || Math.max(0, toInt(itemType.typeID, 0)) <= 0) {
    return null;
  }
  return {
    itemType,
    quantity: Math.max(1, toInt(quantity, 1)),
    options: {
      ...cloneValue(options),
      ...(isBlueprintCopyRewardType(itemType) ? {
        singleton: 2,
        blueprintState: resolveBlueprintLootCopyState(
          itemType, options.blueprintState || options, options.blueprintSource,
        ),
      } : {}),
    },
  };
}

function buildLootEntryFromNames(candidateNames, seed, minimum = 1, maximum = minimum, options = {}) {
  const itemType = resolvePreferredLootItem(candidateNames, seed);
  if (!itemType) {
    return null;
  }
  return buildLootGrantEntry(
    itemType,
    resolveDeterministicQuantity(seed, minimum, maximum),
    isBlueprintCopyRewardType(itemType)
      ? { ...options, blueprintSource: { ...options.blueprintSource, seed } }
      : options,
  );
}

function buildBoosterLootGrantEntries(seed, tags, context = {}) {
  const siteTier = normalizeLowerText(context.template && context.template.siteTier, "");
  const blueprintStrengths = {
    chemical_lab: [],
    gas_processing_site: [],
    distribution_base: ["Synth", "Standard", "Improved"],
    production_facility: ["Standard", "Improved", "Strong"],
    digital_complex: ["Standard", "Improved", "Strong"],
  }[siteTier] || ["Standard", "Improved", "Strong"];
  const siteLabel = normalizeText(
    context &&
    (
      context.template && context.template.resolvedName ||
      context.siteEntity && context.siteEntity.itemName
    ),
    "",
  );
  const preferredFamily = resolveBoosterFamilyFromText(siteLabel);
  const knownFamilies = [
    "Crash",
    "Exile",
    "Mindflood",
    "X-Instinct",
    "Sooth Sayer",
    "Blue Pill",
    "Drop",
    "Frentix",
  ];
  const orderedFamilies = uniqueSorted([
    preferredFamily,
    ...knownFamilies,
  ].filter(Boolean));
  const entries = [];
  for (const tag of normalizeArray(tags)) {
    switch (normalizeLowerText(tag, "")) {
      case "booster_bpc":
        // Chemical Labs and Gas Processing Sites have Synth reactions, not
        // copies. Distribution Bases supply the documented 500-run Synth BPCs.
        if (blueprintStrengths.length === 0) break;
        entries.push(buildLootEntryFromNames(
          orderedFamilies.flatMap((family) => blueprintStrengths
            .map((strength) => `${strength} ${family} Booster Blueprint`)),
          `${seed}:booster_bpc`,
          1,
          1,
          { blueprintSource: { kind: "booster-site-container", siteTier } },
        ));
        break;
      case "reaction_formula":
        entries.push(buildLootEntryFromNames(
          orderedFamilies.map((family) => `Standard ${family} Booster Reaction Formula`),
          `${seed}:reaction_formula`,
        ));
        break;
      case "skillbook":
        entries.push(buildLootEntryFromNames(
          [
            "Biology",
            "Drug Manufacturing",
            "Neurotoxin Recovery",
            "Neurotoxin Control",
          ],
          `${seed}:skillbook`,
        ));
        break;
      case "booster_commodity":
        entries.push(buildLootEntryFromNames(
          orderedFamilies.flatMap((family) => [
            `Standard ${family} Booster`,
            `Improved ${family} Booster`,
            `Synth ${family} Booster`,
          ]),
          `${seed}:booster_commodity`,
          1,
          2,
        ));
        break;
      default:
        break;
    }
  }
  return mergeLootGrantEntries(entries.slice(0, SITE_CONTENT_MAX_LOOT_ENTRIES));
}

function buildSleeperLootGrantEntries(seed, tags) {
  const entries = [];
  for (const tag of normalizeArray(tags)) {
    switch (normalizeLowerText(tag, "")) {
      case "blue_loot":
        entries.push(buildLootEntryFromNames(
          [
            "Neural Network Analyzer",
            "Sleeper Data Library",
            "Sleeper Drone AI Nexus",
          ],
          `${seed}:blue_loot`,
          1,
          3,
        ));
        break;
      case "salvage":
        entries.push(buildLootEntryFromNames(
          [
            "Melted Nanoribbons",
            "Intact Armor Plates",
            "Tripped Power Circuit",
            "Burned Logic Circuit",
            "Charred Micro Circuit",
          ],
          `${seed}:salvage`,
          2,
          6,
        ));
        break;
      default:
        break;
    }
  }
  return mergeLootGrantEntries(entries.slice(0, SITE_CONTENT_MAX_LOOT_ENTRIES));
}

// Hacked Sleeper databanks in the wormhole data sites (Unsecured ...).
function buildSleeperDataLootGrantEntries(seed, tags) {
  const entries = [];
  for (const tag of normalizeArray(tags)) {
    switch (normalizeLowerText(tag, "")) {
      case "datacore":
        entries.push(buildLootEntryFromNames(
          [
            "Datacore - Electronic Engineering",
            "Datacore - Mechanical Engineering",
            "Datacore - Quantum Physics",
            "Datacore - Rocket Science",
            "Datacore - Laser Physics",
          ],
          `${seed}:sleeper_datacore`,
          2,
          6,
        ));
        break;
      case "decryptor":
        entries.push(buildLootEntryFromNames(
          [
            "Accelerant Decryptor",
            "Attainment Decryptor",
            "Optimized Attainment Decryptor",
            "Process Decryptor",
            "Symmetry Decryptor",
          ],
          `${seed}:sleeper_decryptor`,
        ));
        break;
      case "sleeper_data":
        entries.push(buildLootEntryFromNames(
          [
            "Neural Network Analyzer",
            "Sleeper Data Library",
            "Ancient Coordinates Database",
          ],
          `${seed}:sleeper_data`,
          1,
          3,
        ));
        break;
      default:
        break;
    }
  }
  return mergeLootGrantEntries(entries.slice(0, SITE_CONTENT_MAX_LOOT_ENTRIES));
}

// Analyzed Sleeper artifacts and Talocan hulls in the wormhole relic sites
// (Forgotten ...): ancient salvage.
function buildSleeperRelicLootGrantEntries(seed, tags) {
  const entries = [];
  for (const tag of normalizeArray(tags)) {
    switch (normalizeLowerText(tag, "")) {
      case "ancient_salvage":
        entries.push(buildLootEntryFromNames(
          [
            "Melted Nanoribbons",
            "Fused Nanomechanical Engines",
            "Powdered C-540 Graphite",
            "Modified Fluid Router",
            "Heuristic Selfassemblers",
            "Cartesian Temporal Coordinator",
            "Thermoelectric Catalysts",
            "Electromechanical Hull Sheeting",
          ],
          `${seed}:ancient_salvage`,
          2,
          6,
        ));
        break;
      case "ancient_salvage_rare":
        entries.push(buildLootEntryFromNames(
          [
            "Emergent Combat Analyzer",
            "Neurovisual Input Matrix",
            "Resonance Calibration Matrix",
            "Defensive Control Node",
            "Jump Drive Control Nexus",
            "Central System Controller",
            "Emergent Combat Intelligence",
          ],
          `${seed}:ancient_salvage_rare`,
          1,
          2,
        ));
        break;
      case "salvage":
        entries.push(buildLootEntryFromNames(
          [
            "Intact Armor Plates",
            "Tripped Power Circuit",
            "Burned Logic Circuit",
            "Charred Micro Circuit",
          ],
          `${seed}:sleeper_relic_salvage`,
          1,
          4,
        ));
        break;
      default:
        break;
    }
  }
  return mergeLootGrantEntries(entries.slice(0, SITE_CONTENT_MAX_LOOT_ENTRIES));
}

function buildPirateDataLootGrantEntries(seed, tags) {
  const entries = [];
  for (const tag of normalizeArray(tags)) {
    switch (normalizeLowerText(tag, "")) {
      case "datacore":
        entries.push(buildLootEntryFromNames(
          [
            "Datacore - Electronic Engineering",
            "Datacore - Mechanical Engineering",
            "Datacore - Laser Physics",
            "Datacore - Rocket Science",
            "Datacore - Quantum Physics",
          ],
          `${seed}:datacore`,
          2,
          6,
        ));
        break;
      case "decryptor":
        entries.push(buildLootEntryFromNames(
          [
            "Accelerant Decryptor",
            "Attainment Decryptor",
            "Optimized Attainment Decryptor",
            "Process Decryptor",
            "Symmetry Decryptor",
          ],
          `${seed}:decryptor`,
        ));
        break;
      case "data_material":
        entries.push(buildLootEntryFromNames(
          [
            "Esoteric Data Interface",
          ],
          `${seed}:data_material`,
        ));
        break;
      default:
        break;
    }
  }
  return mergeLootGrantEntries(entries.slice(0, SITE_CONTENT_MAX_LOOT_ENTRIES));
}

function buildPirateRelicLootGrantEntries(seed, tags) {
  const entries = [];
  for (const tag of normalizeArray(tags)) {
    switch (normalizeLowerText(tag, "")) {
      case "salvage":
        entries.push(buildLootEntryFromNames(
          [
            "Burned Logic Circuit",
            "Charred Micro Circuit",
            "Contaminated Nanite Compound",
            "Fried Interface Circuit",
            "Tripped Power Circuit",
          ],
          `${seed}:salvage`,
          2,
          7,
        ));
        break;
      case "relic_component":
        entries.push(buildLootEntryFromNames(
          [
            "Alloyed Tritanium Bar",
            "Armor Plates",
            "Intact Armor Plates",
            "Melted Nanoribbons",
          ],
          `${seed}:relic_component`,
          1,
          3,
        ));
        break;
      default:
        break;
    }
  }
  return mergeLootGrantEntries(entries.slice(0, SITE_CONTENT_MAX_LOOT_ENTRIES));
}

function buildGhostResearchLootGrantEntries(seed, tags) {
  const entries = [];
  for (const tag of normalizeArray(tags)) {
    switch (normalizeLowerText(tag, "")) {
      case "datacore":
        entries.push(buildLootEntryFromNames(
          [
            "Datacore - Electronic Engineering",
            "Datacore - Quantum Physics",
            "Datacore - Mechanical Engineering",
          ],
          `${seed}:datacore`,
          2,
          5,
        ));
        break;
      case "decryptor":
        entries.push(buildLootEntryFromNames(
          [
            "Accelerant Decryptor",
            "Attainment Decryptor",
            "Optimized Attainment Decryptor",
            "Process Decryptor",
            "Symmetry Decryptor",
          ],
          `${seed}:decryptor`,
        ));
        break;
      case "research_component":
        entries.push(buildLootEntryFromNames(
          [
            "Esoteric Data Interface",
            "Neural Network Analyzer",
          ],
          `${seed}:research_component`,
        ));
        break;
      default:
        break;
    }
  }
  return mergeLootGrantEntries(entries.slice(0, SITE_CONTENT_MAX_LOOT_ENTRIES));
}

function buildGenericDataLootGrantEntries(seed, tags) {
  const entries = [];
  for (const tag of normalizeArray(tags)) {
    switch (normalizeLowerText(tag, "")) {
      case "datacore":
        entries.push(buildLootEntryFromNames(
          [
            "Datacore - Electronic Engineering",
            "Datacore - Mechanical Engineering",
            "Datacore - Laser Physics",
            "Datacore - Gallentean Starship Engineering",
            "Datacore - Minmatar Starship Engineering",
          ],
          `${seed}:generic_datacore`,
          1,
          4,
        ));
        break;
      case "decryptor":
        entries.push(buildLootEntryFromNames(
          [
            "Accelerant Decryptor",
            "Attainment Decryptor",
            "Optimized Attainment Decryptor",
            "Process Decryptor",
            "Symmetry Decryptor",
          ],
          `${seed}:generic_decryptor`,
        ));
        break;
      case "data_material":
        entries.push(buildLootEntryFromNames(
          [
            "Esoteric Data Interface",
            "Occult Data Interface",
            "Incognito Data Interface",
            "Engagement Plan Data Chip",
          ],
          `${seed}:generic_data_material`,
          1,
          2,
        ));
        break;
      default:
        break;
    }
  }
  return mergeLootGrantEntries(entries.slice(0, SITE_CONTENT_MAX_LOOT_ENTRIES));
}

function buildGenericRelicLootGrantEntries(seed, tags) {
  const entries = [];
  for (const tag of normalizeArray(tags)) {
    switch (normalizeLowerText(tag, "")) {
      case "salvage":
        entries.push(buildLootEntryFromNames(
          [
            "Burned Logic Circuit",
            "Charred Micro Circuit",
            "Fried Interface Circuit",
            "Tripped Power Circuit",
            "Contaminated Nanite Compound",
          ],
          `${seed}:generic_salvage`,
          2,
          7,
        ));
        break;
      case "relic_component":
        entries.push(buildLootEntryFromNames(
          [
            "Alloyed Tritanium Bar",
            "Armor Plates",
            "Intact Armor Plates",
            "Melted Nanoribbons",
            "Power Circuit",
          ],
          `${seed}:generic_relic_component`,
          1,
          3,
        ));
        break;
      default:
        break;
    }
  }
  return mergeLootGrantEntries(entries.slice(0, SITE_CONTENT_MAX_LOOT_ENTRIES));
}

function resolveCombatLootFlavor(context = {}) {
  const label = normalizeLowerText(
    context &&
    (
      context.template && context.template.resolvedName ||
      context.siteEntity && context.siteEntity.itemName
    ),
    "",
  );
  if (label.includes("angel") || label.includes("cartel")) {
    return "angel";
  }
  if (label.includes("blood")) {
    return "blood";
  }
  if (label.includes("guristas") || label.includes("pith")) {
    return "guristas";
  }
  if (label.includes("sansha")) {
    return "sansha";
  }
  if (label.includes("serpentis")) {
    return "serpentis";
  }
  if (label.includes("drone")) {
    return "drone";
  }
  return "generic";
}

function buildCombatLootGrantEntries(seed, tags, context = {}, options = {}) {
  const flavor = resolveCombatLootFlavor(context);
  const flavorModules = {
    angel: ["Domination Gyrostabilizer", "Domination 10MN Afterburner"],
    blood: ["Dark Blood Heat Sink", "Dark Blood Cap Recharger"],
    guristas: ["Dread Guristas Ballistic Control System", "Dread Guristas 250mm Railgun"],
    sansha: ["True Sansha Heat Sink", "True Sansha Cap Recharger"],
    serpentis: ["Shadow Serpentis Magnetic Field Stabilizer", "Shadow Serpentis 10MN Afterburner"],
    drone: ["Drone Transceiver", "Drone Link Augmentor I"],
    generic: ["Domination Gyrostabilizer", "Dread Guristas Ballistic Control System", "True Sansha Heat Sink"],
  };
  const flavorTagItems = {
    angel: ["Domination Platinum Tag", "Domination EMP L"],
    blood: ["Dark Blood Brass Tag", "Dark Blood Gamma L"],
    guristas: ["Dread Guristas Brass Tag", "Dread Guristas Antimatter Charge L"],
    sansha: ["True Sansha Brass Tag", "True Sansha Heat Sink"],
    serpentis: ["Shadow Serpentis Bronze Tag", "Shadow Serpentis Magnetic Field Stabilizer"],
    drone: ["Drone Transceiver", "Charred Micro Circuit"],
    generic: ["Domination Platinum Tag", "Dread Guristas Brass Tag"],
  };
  const overseerTierCandidates = options.overseerTierCandidates && options.overseerTierCandidates.length > 0
    ? options.overseerTierCandidates
    : [
      "4th Tier Overseer's Personal Effects",
      "5th Tier Overseer's Personal Effects",
      "6th Tier Overseer's Personal Effects",
      "7th Tier Overseer's Personal Effects",
      "8th Tier Overseer's Personal Effects",
    ];
  const entries = [];
  for (const tag of normalizeArray(tags)) {
    switch (normalizeLowerText(tag, "")) {
      case "faction_module":
        entries.push(buildLootEntryFromNames(
          flavorModules[flavor] || flavorModules.generic,
          `${seed}:combat_module`,
        ));
        break;
      case "faction_ammo":
      case "pirate_tag":
        entries.push(buildLootEntryFromNames(
          flavorTagItems[flavor] || flavorTagItems.generic,
          `${seed}:combat_tag:${tag}`,
          1,
          2,
        ));
        break;
      case "overseer_effect":
        entries.push(buildLootEntryFromNames(
          overseerTierCandidates,
          `${seed}:overseer_effect`,
        ));
        break;
      case "drone_component":
        entries.push(buildLootEntryFromNames(
          [
            "Drone Transceiver",
            "Drone Parasitic Rovers",
            "Drone Cerebral Fragment",
          ],
          `${seed}:drone_component`,
          1,
          2,
        ));
        break;
      case "salvage":
        entries.push(buildLootEntryFromNames(
          [
            "Burned Logic Circuit",
            "Charred Micro Circuit",
            "Fried Interface Circuit",
            "Tripped Power Circuit",
          ],
          `${seed}:combat_salvage`,
          2,
          5,
        ));
        break;
      default:
        break;
    }
  }
  return mergeLootGrantEntries(entries.slice(0, SITE_CONTENT_MAX_LOOT_ENTRIES));
}

function buildBaseLootGrantEntriesForContainer(containerEntity, populationHints, context = {}) {
  // Explicit, golden-derived contents (e.g. a fetch mission's cargo container seeded with the exact
  // objective item, or a hacked mission container yielding its data chip) take precedence over any
  // procedural loot profile. Shape: [{ typeID, quantity }].
  const explicitLoot = Array.isArray(containerEntity && containerEntity.dungeonSiteContentExplicitLoot)
    ? containerEntity.dungeonSiteContentExplicitLoot
    : null;
  if (explicitLoot && explicitLoot.length > 0) {
    return explicitLoot
      .flatMap((entry, entryIndex) => {
        const typeID = Math.max(0, toInt(entry && (entry.typeID ?? entry.itemType), 0));
        const itemType = resolveItemByTypeID(typeID);
        return isBlueprintCopyRewardType(itemType)
          ? Array.from({ length: Math.max(1, toInt(entry.quantity, 1)) }, (_, copyIndex) => buildLootGrantEntry(itemType, 1, {
            blueprintState: resolveBlueprintLootCopyState(itemType, entry, {
              kind: "explicit-site-container",
              seed: `${context.instance?.instanceID || containerEntity.dungeonSiteInstanceID || 0}:${containerEntity.dungeonSiteContentKey || containerEntity.itemID || "explicit"}:${entryIndex}:${copyIndex}`,
            }),
          }))
          : typeID > 0 ? { itemType: typeID, quantity: Math.max(1, toInt(entry && entry.quantity, 1)) } : null;
      })
      .filter(Boolean);
  }
  const profileKey = normalizeText(
    containerEntity &&
    (
      containerEntity.dungeonSiteContentLootProfile ||
      containerEntity.lootProfile
    ),
    "",
  );
  if (!profileKey) {
    return [];
  }
  const tags = resolveContainerLootTags(containerEntity, populationHints);
  const seedBase = normalizeText(
    containerEntity && containerEntity.dungeonSiteContentKey,
    `${profileKey}:${normalizeText(containerEntity && containerEntity.itemName, "container")}`,
  );
  const tieredEntries = rollTieredContainerLoot({
    profileKey,
    role: containerEntity?.dungeonSiteContentRole,
    siteLabel: context.template?.resolvedName || context.template?.name || context.siteEntity?.itemName,
    securityBand: context.instance?.metadata?.securityBand || context.instance?.spawnState?.spawnPolicy?.securityBand,
    wormholeClassID: context.instance?.spawnState?.spawnPolicy?.wormholeClassID,
    seed: `${context.instance?.instanceID || containerEntity?.dungeonSiteInstanceID || 0}:${seedBase}`,
  });
  if (Array.isArray(tieredEntries)) return tieredEntries;
  switch (profileKey) {
    case "election_iteration_databank":
    case "election_iteration_vault": {
      const minimum = profileKey === "election_iteration_databank" ? 3 : 7;
      const count = profileKey === "election_iteration_databank" ? 4 : 5;
      // Stable per site/container; rematerializing cannot reroll the contents.
      const seed = `${context.instance?.instanceID}:${seedBase}`;
      let hash = 2166136261;
      for (const char of seed) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
      return [{ itemType: 92149, quantity: minimum + hash % count }];
    }
    case "booster_site_loot":
      return buildBoosterLootGrantEntries(seedBase, tags, context);
    case "sleeper_blue_loot":
      return buildSleeperLootGrantEntries(seedBase, tags);
    case "sleeper_data_loot":
      return buildSleeperDataLootGrantEntries(seedBase, tags);
    case "sleeper_relic_loot":
    case "talocan_relic_loot":
      return buildSleeperRelicLootGrantEntries(seedBase, tags);
    case "generic_data_loot":
      return buildGenericDataLootGrantEntries(seedBase, tags);
    case "generic_relic_loot":
      return buildGenericRelicLootGrantEntries(seedBase, tags);
    case "generic_combat_hacking_loot":
      return buildBoosterLootGrantEntries(seedBase, tags, context);
    case "pirate_data_loot":
      return buildPirateDataLootGrantEntries(seedBase, tags);
    case "pirate_relic_loot":
      return buildPirateRelicLootGrantEntries(seedBase, tags);
    case "ghost_research_loot":
      return buildGhostResearchLootGrantEntries(seedBase, tags);
    case "pirate_combat_loot":
      return buildCombatLootGrantEntries(seedBase, tags, context, {
        overseerTierCandidates: [
          "2nd Tier Overseer's Personal Effects",
          "3rd Tier Overseer's Personal Effects",
          "4th Tier Overseer's Personal Effects",
          "5th Tier Overseer's Personal Effects",
        ],
      });
    case "combat_overseer_loot":
      return buildCombatLootGrantEntries(seedBase, tags, context, {
        overseerTierCandidates: [
          "6th Tier Overseer's Personal Effects",
          "7th Tier Overseer's Personal Effects",
          "8th Tier Overseer's Personal Effects",
          "9th Tier Overseer's Personal Effects",
          "10th Tier Overseer's Personal Effects",
        ],
      });
    default:
      return [];
  }
}

function buildLootGrantEntriesForContainer(containerEntity, populationHints, context = {}) {
  const entries = buildBaseLootGrantEntriesForContainer(containerEntity, populationHints, context);
  if (normalizeArray(containerEntity?.dungeonSiteContentExplicitLoot).length > 0) return entries;
  const profileKey = normalizeText(containerEntity?.dungeonSiteContentLootProfile || containerEntity?.lootProfile, "");
  // Coordinate and defense-grid controls have no loot table. Merely being in
  // a Sleeper Cache must not turn them into polarized blueprint reward cans.
  const containerType = resolveItemByTypeID(containerEntity?.typeID);
  const source = resolveSiteBlueprintLootSource({
    ...context, container: containerEntity, populationHints, profileKey,
    containerTypeName: containerType?.name || "",
    pirateFaction: resolveCombatLootFlavor(context),
    getBlueprintTypes: () => {
      if (!cachedBlueprintLootTypeRecords) {
        cachedBlueprintLootTypeRecords = listItemTypes()
          .filter((itemType) => Number(itemType.categoryID) === 9 && itemType.published !== false);
      }
      return cachedBlueprintLootTypeRecords;
    },
  });
  if (!source || source.candidates.length === 0) return entries;
  const seed = `${context.instance?.instanceID || containerEntity?.dungeonSiteInstanceID || 0}:${containerEntity?.dungeonSiteContentKey || containerEntity?.itemID || profileKey}:${source.id}`;
  // Drop weights are emulation values; the evidence establishes reward pools
  // and licensed runs, not CCP's private drop probability distributions.
  if (hashText(`${seed}:chance`) % source.chanceOneIn !== 0) return entries;
  const candidates = source.candidates.map((candidate) => ({
    ...candidate, itemType: candidate.typeID
      ? resolveItemByTypeID(candidate.typeID) : resolveLootTypeRecordByName(candidate.name),
  })).filter((candidate) => isBlueprintCopyRewardType(candidate.itemType));
  const selected = chooseDeterministicEntry(candidates, `${seed}:candidate`);
  if (!selected) return entries;
  const copy = buildLootGrantEntry(selected.itemType, 1, {
    blueprintState: resolveBlueprintLootCopyState(selected.itemType, selected, { kind: source.id, seed }),
    blueprintSource: { kind: source.id, seed, evidence: source.evidence },
  });
  return [...entries, copy];
}

const PIRATE_FACTION_CAN_PREFIXES_BY_KEY = Object.freeze({
  angel: "Angel",
  blood: "Blood",
  "blood raider": "Blood",
  guristas: "Guristas",
  sansha: "Sansha",
  serpentis: "Serpentis",
});

const PIRATE_FACTION_NAME_NEEDLES = Object.freeze([
  ["blood raider", "Blood"],
  ["angel", "Angel"],
  ["guristas", "Guristas"],
  ["sansha", "Sansha"],
  ["serpentis", "Serpentis"],
]);

const DATA_ROLE_CAN_NAME_SUFFIXES = Object.freeze({
  info_shard: ["Info Shard"],
  debris: ["Debris"],
  com_tower: ["Com Tower"],
  mainframe: ["Mainframe"],
  databank: ["Databank"],
});

const RELIC_ROLE_CAN_NAME_SUFFIXES = Object.freeze({
  rubble: ["Rubble"],
  remains: ["Remains"],
  ruins: ["Ruins"],
});

// Generic-role tier spreads: a flat "data x6"/"relic x6" spec still shows the
// site's can tiers instead of six identical cans.
const GENERIC_DATA_CAN_SPREAD = Object.freeze(["Com Tower", "Mainframe", "Databank"]);
const GENERIC_RELIC_CAN_SPREAD = Object.freeze(["Rubble", "Remains", "Ruins"]);

const FAMILY_FALLBACK_CAN_NAMES = Object.freeze({
  sleepers: { data: ["Sleeper Data Storage"], relic: ["Sleeper Artifact"] },
  sleeper: { data: ["Sleeper Data Storage"], relic: ["Sleeper Artifact"] },
  rogue_drone: { data: ["Rogue Drone Container"], relic: ["Rogue Drone Ship Remains"] },
  default: { data: ["Sleeper Data Storage"], relic: ["Sleeper Artifact"] },
});

function resolveTemplateCanFallbackContext(template, populationHints) {
  const factionKey = normalizeLowerText(
    template && (template.factionKey || template.faction || template.factionName),
    "",
  );
  let pirateCanPrefix = PIRATE_FACTION_CAN_PREFIXES_BY_KEY[factionKey] || null;
  if (!pirateCanPrefix) {
    const templateName = normalizeLowerText(
      template && (template.resolvedName || template.name),
      "",
    );
    for (const [needle, prefix] of PIRATE_FACTION_NAME_NEEDLES) {
      if (templateName.includes(needle)) {
        pirateCanPrefix = prefix;
        break;
      }
    }
  }
  return {
    siteFamily: normalizeLowerText(populationHints && populationHints.siteFamily, "") ||
      normalizeLowerText(template && template.siteFamily, ""),
    factionKey,
    pirateCanPrefix,
  };
}

function resolveContainerRoleFallbackTypeNames(containerSpec, fallbackContext = {}) {
  const role = normalizeLowerText(containerSpec && containerSpec.role, "")
    .replace(/^(?:data|relic)_/, "");
  const analyzer = normalizeLowerText(containerSpec && containerSpec.analyzer, "");
  const effectiveAnalyzer = DATA_RELIC_CONTAINER_ANALYZERS.has(analyzer)
    ? analyzer
    : (new Set(["data", "relic"]).has(fallbackContext.siteFamily) ? fallbackContext.siteFamily : "");
  if (!effectiveAnalyzer) {
    return [];
  }
  const piratePrefix = fallbackContext.pirateCanPrefix;
  if (piratePrefix) {
    const roleSuffixes = effectiveAnalyzer === "relic"
      ? RELIC_ROLE_CAN_NAME_SUFFIXES[role]
      : DATA_ROLE_CAN_NAME_SUFFIXES[role];
    if (roleSuffixes) {
      return roleSuffixes.map((suffix) => `${piratePrefix} ${suffix}`);
    }
    const spread = effectiveAnalyzer === "relic" ? GENERIC_RELIC_CAN_SPREAD : GENERIC_DATA_CAN_SPREAD;
    const ordinal = Math.max(1, toInt(containerSpec && containerSpec.ordinal, 1));
    return [`${piratePrefix} ${spread[(ordinal - 1) % spread.length]}`];
  }
  const familyCans = FAMILY_FALLBACK_CAN_NAMES[fallbackContext.factionKey] ||
    FAMILY_FALLBACK_CAN_NAMES.default;
  return familyCans[effectiveAnalyzer] || [];
}

// Env-can promotion: several compiled templates record the site's hackable
// cans as ambient environment props (family-derived sites carry named props
// next to their count-only container table; authored combat layouts like the
// AEGIS Construction Forges carry the cans as props with no container table
// at all). Materializing those as scenery is forbidden - the 2026-09-11
// in-game finding: a scenery ball with a can model is lockable/shootable but
// not the real hackable can, and the analyzer rejects it
// (ANALYZER_TARGET_INVALID) - so buildEnvironmentEntities drops them and the
// sites lost their cans entirely. Promoting them into container specs gives
// the objects their real TQ identity (spawn-container groups 306/1207 are
// hackable cans): model, bracket, analyzer flow, and loot all survive.
//
// Guards: a container table that already carries typeIDs or type names is an
// authoritative extract and wins (no promotion, no doubling). An untyped
// family-derived table and the environment props describe the same cans, so
// the promoted specs REPLACE the count-only specs and inherit their loot
// profile; sites with no container table get the promoted specs plus the
// family-default loot profile.

// True when the curated hackable overlay authored this container table. The
// overlay stamps curatedHackableContent.applied on the populationHints whose
// containers it replaced, so the marker is checked on both the hints in hand
// (instance snapshots carry their own copy) and the template's own.
function isCuratedContainerTable(populationHints, template = null) {
  if (
    populationHints &&
    populationHints.curatedHackableContent &&
    populationHints.curatedHackableContent.applied === true
  ) {
    return true;
  }
  const templateHints = template && template.populationHints;
  return Boolean(
    templateHints &&
    templateHints.curatedHackableContent &&
    templateHints.curatedHackableContent.applied === true,
  );
}

function resolveEnvPromotedContainerSpecs(populationHints, template = null) {
  // Promotion is exploration-only: warehouse/ruins props (groups 306/1207)
  // also appear as dressing in combat, mission and event layouts, where they
  // must stay scenery. Everything outside the data/relic signature families
  // returns null before any prop is examined - except combat layouts the
  // curated overlay explicitly flags as hacking sites (the AEGIS forges,
  // whose can-type props ARE the cans).
  const siteFamily = normalizeLowerText(populationHints && populationHints.siteFamily, "") ||
    normalizeLowerText(template && template.siteFamily, "");
  if (
    !new Set(["data", "relic"]).has(siteFamily) &&
    !(template && template.hackingCombatSite === true)
  ) {
    return null;
  }
  const specs = normalizeArray(populationHints && populationHints.containers)
    .filter((entry) => entry && typeof entry === "object");
  const hasTypedSpec = specs.some((spec) =>
    Math.max(0, toInt(spec && spec.typeID, 0)) > 0 ||
    normalizeArray(spec && spec.typeNameCandidates).length > 0);
  // A table that carries authored behavior owns its cans: the env props
  // describe the same objects, but replacing the table here would drop that
  // behavior onto the floor. Authored tables are marked where they are built
  // - the curated overlay stamps curatedHackableContent.applied on every
  // populationHints whose container table it replaced - and an individual
  // spec still speaks for itself through its trigger or its failure-routing /
  // finale flags. Loot profiles, tags and labels alone do NOT block promotion
  // - the count-only family-derived tables carry those and the promoted
  // specs inherit them.
  const hasAuthoredBehaviorSpec = specs.some((spec) => (
    normalizeText(spec && spec.trigger, "") !== "" ||
    Boolean(spec && (
      spec.bonus === true ||
      spec.failureExplodes === true ||
      spec.persistsAfterResponse === true ||
      spec.failureNeverDestroys === true ||
      spec.failureLocksOut === true ||
      spec.completesSiteOnHack === true
    ))
  )) || isCuratedContainerTable(populationHints, template);
  if (hasTypedSpec || hasAuthoredBehaviorSpec) {
    return null;
  }
  const envProps = normalizeArray(populationHints && populationHints.environmentProps)
    .filter((entry) => entry && typeof entry === "object");
  let sourceProps = envProps;
  if (sourceProps.length <= 0) {
    const sceneProfile = resolveSiteSceneProfile(template);
    sourceProps = normalizeArray(sceneProfile && sceneProfile.structureProfiles)
      .filter((entry) => entry && typeof entry === "object");
  }
  if (sourceProps.length <= 0) {
    return null;
  }
  const isRelicFamily = siteFamily === "relic";
  const analyzer = isRelicFamily ? "relic" : "data";
  const inheritable = specs.find((spec) => normalizeText(spec && spec.lootProfile, "")) || null;
  const lootProfile = normalizeText(inheritable && inheritable.lootProfile, "") ||
    (isRelicFamily ? "generic_relic_loot" : "generic_data_loot");
  const lootTags = normalizeArray(inheritable && inheritable.lootTags).length > 0
    ? normalizeArray(inheritable && inheritable.lootTags)
    : (isRelicFamily ? ["salvage", "relic_component"] : ["datacore", "decryptor"]);
  const promoted = [];
  const seenSources = new Set();
  for (const prop of sourceProps) {
    const typeRecord = Math.max(0, toInt(prop && prop.typeID, 0)) > 0
      ? resolveItemByTypeID(prop.typeID)
      : resolveContainerTypeRecordByName(prop && prop.typeNameCandidates) ||
        resolveGenericTypeRecordByName(prop && prop.typeNameCandidates);
    if (!typeRecord || !HACKABLE_CAN_GROUP_IDS.has(Math.max(0, toInt(typeRecord.groupID, 0)))) {
      continue;
    }
    if (template?.hackingCombatSite === true && !["data", "relic"].includes(siteFamily) &&
        !/^AEGIS\b/i.test(typeRecord.name || "")) {
      continue;
    }
    const sourceObjectID = Math.max(0, toInt(prop.dunObjectID ?? prop.objectID, 0));
    const sourceKey = sourceObjectID ? `object:${sourceObjectID}` :
      normalizeText(prop.key, "") || `type:${typeRecord.typeID}:${normalizeText(prop.label, "")}`;
    if (seenSources.has(sourceKey)) continue;
    seenSources.add(sourceKey);
    const aegisStorage = /AEGIS Encrypted Key Storage/i.test(typeRecord.name || "");
    promoted.push({
      role: analyzer,
      analyzer,
      count: 1,
      typeID: typeRecord.typeID,
      contentKey: `container:environment:${sourceKey}`,
      label: normalizeText(prop && prop.label, "") || null,
      typeNameCandidates: normalizeArray(prop && prop.typeNameCandidates),
      lootProfile,
      lootTags,
      ...(template?.hackingCombatSite === true ? { trigger: "hack_failure" } : {}),
      ...(aegisStorage ? { hackingDifficulty: 5 } : {}),
      dunObjectID: Math.max(0, toInt(prop && (prop.dunObjectID ?? prop.objectID), 0)) || null,
      positionOffset: prop && prop.positionOffset && typeof prop.positionOffset === "object"
        ? clonePosition(prop.positionOffset)
        : null,
    });
  }
  return promoted;
}

function applyEnvPromotedContainerSpecs(populationHints, template = null) {
  const promoted = resolveEnvPromotedContainerSpecs(populationHints, template);
  if (!promoted || promoted.length <= 0) {
    return populationHints;
  }
  return { ...populationHints, containers: promoted };
}

const CONTAINER_ROLE_DIFFICULTY = Object.freeze({
  info_shard: 1, debris: 1, com_tower: 2, rubble: 2,
  mainframe: 3, remains: 3, databank: 4, ruins: 4,
});

function resolveContainerHackingDifficultyTier(container, instance, typeRecord) {
  const explicit = container?.hackingDifficulty;
  if (explicit !== null && explicit !== undefined && explicit !== "") {
    const authored = resolveHackingDifficultyTier(explicit, Number.NaN);
    if (Number.isFinite(authored)) return authored;
  }
  const role = normalizeLowerText(container?.role, "").replace(/^(?:data|relic)_/, "");
  if (/^(?:sleeper|talocan)_/.test(role)) {
    const classID = toInt(container?.wormholeClassID,
      toInt(instance?.spawnState?.spawnPolicy?.wormholeClassID, 0));
    return classID >= 5 ? 4 : classID >= 3 ? 3 : classID > 0 ? 2 : 3;
  }
  if (CONTAINER_ROLE_DIFFICULTY[role] !== undefined) return CONTAINER_ROLE_DIFFICULTY[role];
  const nativeTier = getTypeAttributeValue(typeRecord?.typeID, "tierDifficulty");
  if (nativeTier !== null && Number.isFinite(nativeTier) && nativeTier >= 0) {
    return resolveHackingDifficultyTier(nativeTier, null);
  }
  if (!DATA_RELIC_CONTAINER_ANALYZERS.has(container?.analyzer)) return null;
  return ({ highsec: 2, lowsec: 3, nullsec: 4, wormhole: 4 })[
    normalizeLowerText(instance?.metadata?.securityBand, "")
  ] ?? null;
}

function resolveContainerTypeRecord(containerSpec, options = {}) {
  const explicitTypeID = Math.max(0, toInt(containerSpec && containerSpec.typeID, 0));
  if (explicitTypeID > 0) {
    const explicitType = resolveItemByTypeID(explicitTypeID);
    if (explicitType) {
      return explicitType;
    }
  }
  const namedType = options.legacy === true
    ? normalizeArray(containerSpec?.typeNameCandidates)
      .map(candidate => resolveItemByName(candidate))
      .find(lookup => lookup?.success && lookup.match)?.match || null
    : resolveContainerTypeRecordByName(containerSpec && containerSpec.typeNameCandidates);
  if (namedType) {
    return namedType;
  }
  const fallbackType = resolveContainerTypeRecordByName(options.fallbackTypeNames);
  if (fallbackType) return fallbackType;
  return resolveGenericContainerTypeRecord();
}

function resolveContainerDisplayName(containerSpec, typeRecord, ordinal) {
  const explicitLabel = normalizeText(containerSpec && containerSpec.label, "");
  if (explicitLabel) {
    return explicitLabel;
  }
  const baseLabel = explicitLabel || resolveTypeRecordName(typeRecord, "");
  const fallbackLabel = resolveContainerRoleLabel(containerSpec && containerSpec.role);
  const displayLabel = baseLabel || fallbackLabel || "Site Container";
  return ordinal > 1 ? `${displayLabel} ${ordinal}` : displayLabel;
}

function buildMissionRoomKey(room = null, index = 0) {
  const roomID = normalizeText(room && room.roomId, "");
  if (roomID) {
    return `room:${roomID}`;
  }
  return index <= 0 ? "room:entry" : `room:mission_${index + 1}`;
}

function parseMissionGroupNumber(group = null, fallback = 0) {
  const candidates = [
    normalizeText(group && group.title, ""),
    normalizeText(group && group.groupId, ""),
    normalizeText(group && group.key, ""),
  ];
  for (const candidate of candidates) {
    const match = candidate.match(/\bgroup[_\s:-]*(\d{1,2})\b/i);
    if (match) {
      return Math.max(1, toInt(match[1], fallback));
    }
  }
  return Math.max(1, toInt(fallback, 1));
}

function buildMissionGroupTimingText(group = null) {
  return [
    normalizeText(group && group.title, ""),
    ...normalizeArray(group && group.notes)
      .map((note) => normalizeText(note, ""))
      .filter(Boolean),
  ].join(" ");
}

function parseMissionSameWaveGroupNumber(group = null) {
  const text = buildMissionGroupTimingText(group);
  const patterns = [
    /\bsame\s+time\s+as\s+group\s*(\d{1,2})\b/i,
    /\bspawns?\s+(?:at\s+)?(?:the\s+)?same\s+time\s+as\s+group\s*(\d{1,2})\b/i,
    /\bspawns?\s+with\s+group\s*(\d{1,2})\b/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      return Math.max(1, toInt(match[1], 0));
    }
  }
  return 0;
}

function normalizeMissionSpawnCount(entry = null) {
  const count = normalizeObject(entry && entry.count);
  return Math.max(
    1,
    Math.min(
      SITE_CONTENT_MAX_ENCOUNTER_NPCS,
      toInt(count.max, toInt(count.min, 1)),
    ),
  );
}

function resolveBoundedContentLimit(value, fallback, hardMaximum) {
  const explicit = Math.max(0, toInt(value, 0));
  const selected = explicit > 0 ? explicit : fallback;
  return Math.max(0, Math.min(Math.max(0, toInt(hardMaximum, fallback)), selected));
}

function resolveExactEnvironmentPropLimit(populationHints, candidateCount) {
  const caps = normalizeObject(populationHints && populationHints.exactContentCaps);
  const limit = resolveBoundedContentLimit(
    caps.environmentProps ||
      caps.exactEnvironmentProps ||
      (populationHints && populationHints.maxExactEnvironmentProps),
    SITE_CONTENT_MAX_EXACT_ENVIRONMENT_PROPS,
    SITE_CONTENT_MAX_EXACT_ENVIRONMENT_PROPS,
  );
  return Math.min(Math.max(0, toInt(candidateCount, 0)), limit);
}

function resolveGateLimit(template, candidateCount) {
  const populationHints = normalizeObject(template && template.populationHints);
  const exactClientContent = populationHints.exactClientContent === true ||
    normalizeObject(template && template.siteSceneProfile).exactClientContent === true;
  if (!exactClientContent) {
    return Math.min(Math.max(0, toInt(candidateCount, 0)), SITE_CONTENT_MAX_GATE_COUNT);
  }
  const caps = normalizeObject(populationHints.exactContentCaps);
  const limit = resolveBoundedContentLimit(
    caps.gates || caps.exactGates || populationHints.maxExactGates,
    SITE_CONTENT_MAX_EXACT_GATE_COUNT,
    SITE_CONTENT_MAX_EXACT_GATE_COUNT,
  );
  return Math.min(Math.max(0, toInt(candidateCount, 0)), limit);
}

// Site content entities are numbered BASE + siteID * slots + ordinal, which keeps
// every entity of a site in one contiguous block. Mission sites are numbered from
// MISSION_SITE_ID_OFFSET (9.7e12, agentMissionRuntime.js), so the two content types
// that reserve 1000 slots push the product past Number.MAX_SAFE_INTEGER. The scene's
// position authority only accepts safe integers (scenePositionAuthority.js
// normalizeEntityID), so those entities were refused and silently vanished -- a
// mining mission arrived with no asteroid to mine.
//
// A site whose block still fits keeps the id it has always had. Only the overflowing
// case folds the site down to its low digits, which for a mission site is the dungeon
// instance id and is therefore still unique. The folded ids land near the base, far
// below the universe-site ids (6.5e15 and up), so the two cannot collide.
const SITE_CONTENT_ID_FOLD_MODULUS = 1_000_000_000;

function buildSiteContentItemID(base, siteID, slotsPerSite, ordinal) {
  const normalizedSiteID = Math.max(0, toInt(siteID, 0));
  const normalizedOrdinal = Math.max(0, toInt(ordinal, 0));
  const candidate = base + (normalizedSiteID * slotsPerSite) + normalizedOrdinal;
  if (Number.isSafeInteger(candidate)) {
    return candidate;
  }
  return base + ((normalizedSiteID % SITE_CONTENT_ID_FOLD_MODULUS) * slotsPerSite) + normalizedOrdinal;
}

function resolveMiningRockLimit(populationHints) {
  if (!(populationHints && populationHints.exactClientContent === true)) {
    return SITE_CONTENT_MAX_MINING_ROCK_COUNT;
  }
  const caps = normalizeObject(populationHints.exactContentCaps);
  return resolveBoundedContentLimit(
    caps.miningRocks || caps.exactMiningRocks || populationHints.maxExactMiningRocks,
    SITE_CONTENT_MAX_EXACT_MINING_ROCK_COUNT,
    SITE_CONTENT_MAX_EXACT_MINING_ROCK_COUNT,
  );
}

function resolveEncounterSpawnEntryLimit(encounterPlan) {
  const explicitLimit = Math.max(0, toInt(
    encounterPlan && (
      encounterPlan.maxSpawnEntries ||
      encounterPlan.maxExactSpawnEntries ||
      encounterPlan.maxEncounterNpcs
    ),
    0,
  ));
  const defaultLimit = encounterPlan && encounterPlan.exact === true
    ? SITE_CONTENT_MAX_EXACT_ENCOUNTER_NPCS
    : SITE_CONTENT_MAX_ENCOUNTER_NPCS;
  return Math.max(
    1,
    resolveBoundedContentLimit(
      explicitLimit,
      defaultLimit,
      SITE_CONTENT_MAX_EXACT_ENCOUNTER_NPCS,
    ),
  );
}

function normalizeEncounterTriggerMessages(entry) {
  return normalizeMaybeArray(
    (entry && (entry.triggerMessages || entry.triggerMessage || entry.dungeonTriggerMessages)) || [],
  )
    .map((message) => {
      if (Array.isArray(message)) {
        return {
          messageType: Math.max(0, toInt(message[0], 0)),
          messageID: Math.max(0, toInt(message[1], 0)),
          idType: normalizeText(message[2], "charid"),
        };
      }
      if (!(message && typeof message === "object")) {
        return null;
      }
      return {
        messageType: Math.max(0, toInt(
          message.messageType || message.type || message.notificationType,
          0,
        )),
        messageID: Math.max(0, toInt(
          message.messageID || message.messageId || message.id || message.labelID,
          0,
        )),
        idType: normalizeText(message.idType || message.channel, "charid"),
      };
    })
    .filter((message) => message && message.messageType > 0 && message.messageID > 0)
    .slice(0, SITE_CONTENT_MAX_TRIGGER_NOTIFICATIONS);
}

function normalizeEncounterTriggerAudio(entry) {
  return normalizeMaybeArray(
    (entry && (entry.triggerAudio || entry.triggerAudios || entry.dungeonTriggerAudio)) || [],
  )
    .map((audioEntry) => {
      if (typeof audioEntry === "string") {
        return {
          dungeonID: null,
          audio: normalizeText(audioEntry, ""),
          idType: "shipid",
        };
      }
      if (Array.isArray(audioEntry)) {
        return {
          dungeonID: Math.max(0, toInt(audioEntry[0], 0)) || null,
          audio: normalizeText(audioEntry[1], ""),
          idType: normalizeText(audioEntry[2], "shipid"),
        };
      }
      if (!(audioEntry && typeof audioEntry === "object")) {
        return null;
      }
      return {
        dungeonID: Math.max(0, toInt(
          audioEntry.dungeonID || audioEntry.sourceDungeonID || audioEntry.dungeonId,
          0,
        )) || null,
        audio: normalizeText(audioEntry.audio || audioEntry.sound || audioEntry.event, ""),
        idType: normalizeText(audioEntry.idType || audioEntry.channel, "shipid"),
      };
    })
    .filter((audioEntry) => audioEntry && audioEntry.audio)
    .slice(0, SITE_CONTENT_MAX_TRIGGER_NOTIFICATIONS);
}

const LEGACY_MISSION_NPC_FACTION_MAPPINGS = Object.freeze([
  Object.freeze({
    factionKey: "blood",
    profilePrefix: "parity_blood_raider_pulse_",
    patterns: [
      /\bcorpii\b/i,
      /\bcorpior\b/i,
      /\bcorpum\b/i,
      /\bcorpatis\b/i,
      /\bcorpus\b/i,
      /\bblood raider\b/i,
    ],
  }),
  Object.freeze({
    factionKey: "sansha",
    profilePrefix: "parity_sansha_pulse_",
    patterns: [
      /\bcentii\b/i,
      /\bcentior\b/i,
      /\bcentum\b/i,
      /\bcentus\b/i,
    ],
  }),
  Object.freeze({
    factionKey: "serpentis",
    profilePrefix: "parity_serpentis_blaster_",
    patterns: [
      /\bcoreli\b/i,
      /\bcorelior\b/i,
      /\bcorelum\b/i,
      /\bcorelatis\b/i,
      /\bcore grand admiral\b/i,
    ],
  }),
  Object.freeze({
    factionKey: "angel",
    profilePrefix: "parity_angel_autocannon_",
    patterns: [
      /\bgistii\b/i,
      /\bgistior\b/i,
      /\bgistum\b/i,
      /\bgistatis\b/i,
      /\bgist(?:\s|$)/i,
      /\bangel cartel\b/i,
    ],
  }),
  Object.freeze({
    factionKey: "guristas",
    profilePrefix: "parity_guristas_missile_",
    patterns: [
      /\bpithi\b/i,
      /\bpithior\b/i,
      /\bpithium\b/i,
      /\bpithum\b/i,
      /\bpithatis\b/i,
      /\bpithathis\b/i,
      /\bpith(?:\s|$)/i,
    ],
  }),
]);

function resolveMissionSpawnHullClass(entry = null) {
  const text = [
    normalizeText(entry && entry.label, ""),
    normalizeText(entry && entry.raw, ""),
    ...normalizeArray(entry && entry.candidateNames)
      .map((value) => normalizeText(value, ""))
      .filter(Boolean),
  ]
    .join(" ")
    .toLowerCase();

  if (!text) {
    return "";
  }
  if (/\belite frigates?\b/.test(text)) {
    return "frigate";
  }
  if (/\bfrigates?\b/.test(text)) {
    return "frigate";
  }
  if (/\bdestroyers?\b/.test(text)) {
    return "destroyer";
  }
  if (/\bcruisers?\b/.test(text)) {
    return "cruiser";
  }
  if (/\bbattlecruisers?\b/.test(text)) {
    return "battlecruiser";
  }
  if (/\bbattleships?\b/.test(text)) {
    return "battleship";
  }
  return "";
}

function isLikelyNamedMissionNpcCandidate(candidate = "") {
  const normalized = normalizeText(candidate, "").toLowerCase();
  if (!normalized) {
    return false;
  }
  return (
    /\btrue\b/.test(normalized) ||
    /\bshadow\b/.test(normalized) ||
    /\bdread\b/.test(normalized) ||
    /\bdomination\b/.test(normalized) ||
    /\bdark blood\b/.test(normalized) ||
    /\bofficer\b/.test(normalized)
  );
}

function resolveLegacyMissionNpcSpawnQuery(entry = null) {
  const candidateNames = normalizeArray(entry && entry.candidateNames)
    .map((name) => normalizeText(name, ""))
    .filter(Boolean);
  if (candidateNames.some((candidate) => isLikelyNamedMissionNpcCandidate(candidate))) {
    return "";
  }

  const hullClass = resolveMissionSpawnHullClass(entry);
  if (!hullClass) {
    return "";
  }

  const searchText = [
    normalizeText(entry && entry.label, ""),
    normalizeText(entry && entry.raw, ""),
    ...candidateNames,
  ]
    .join(" ")
    .toLowerCase();

  for (const mapping of LEGACY_MISSION_NPC_FACTION_MAPPINGS) {
    if (mapping.patterns.some((pattern) => pattern.test(searchText))) {
      return `${mapping.profilePrefix}${hullClass}`;
    }
  }

  return "";
}

function resolveMissionTemplateFactionKey(template = null) {
  const searchText = [
    normalizeText(template && template.faction, ""),
    normalizeText(template && template.enemyFaction, ""),
    normalizeText(template && template.npcFaction, ""),
  ]
    .join(" ")
    .toLowerCase();
  if (/\bguristas?\b|\bpithi|\bpith\b/.test(searchText)) {
    return "guristas";
  }
  if (/\bblood\b|\bcorpi/.test(searchText)) {
    return "blood";
  }
  if (/\bsansha\b|\bcenti/.test(searchText)) {
    return "sansha";
  }
  if (/\bserpentis\b|\bcoreli/.test(searchText)) {
    return "serpentis";
  }
  if (/\bangel\b|\bgist/.test(searchText)) {
    return "angel";
  }
  return "";
}

function resolveMissionFallbackSpawnQuery(template = null, entry = null) {
  const factionKey = resolveMissionTemplateFactionKey(template);
  const hullClass = resolveMissionSpawnHullClass(entry);
  if (factionKey && hullClass) {
    const factionMapping = LEGACY_MISSION_NPC_FACTION_MAPPINGS
      .find((mapping) => mapping.factionKey === factionKey);
    if (factionMapping) {
      return `${factionMapping.profilePrefix}${hullClass}`;
    }
  }
  return "generic_hostile";
}

// Shared NPC profile-resolution index, built ONCE from the rats catalog (5k+ profiles, each carrying a
// shipTypeID + name + aliases). Lets a mission spawn entry be matched to its EXACT profile by ship typeID
// (imported-log/pack path) or ship name (scrape path), so both paths spawn the correct hull/faction off
// the template data instead of a coarse faction guess. Memoized only once the catalog is populated, so an
// early-startup empty read is retried rather than cached.
let cachedNpcProfileResolutionIndex = null;
function getNpcProfileResolutionIndex() {
  if (cachedNpcProfileResolutionIndex) {
    return cachedNpcProfileResolutionIndex;
  }
  const byShipTypeID = new Map();
  const byName = new Map();
  let profiles = [];
  try {
    profiles = getNpcSpawnService().listNpcProfiles() || [];
  } catch (error) {
    profiles = [];
  }
  for (const profile of profiles) {
    const profileID = normalizeText(profile && profile.profileID, "");
    if (!profileID) {
      continue;
    }
    const shipTypeID = toInt(profile && profile.shipTypeID, 0);
    if (shipTypeID > 0 && !byShipTypeID.has(shipTypeID)) {
      byShipTypeID.set(shipTypeID, profileID);
    }
    for (const token of [profile && profile.name, ...normalizeArray(profile && profile.aliases), profileID]) {
      const normalizedToken = normalizeLowerText(token, "");
      if (normalizedToken && !byName.has(normalizedToken)) {
        byName.set(normalizedToken, profileID);
      }
    }
  }
  const index = { byShipTypeID, byName };
  if (profiles.length > 0) {
    cachedNpcProfileResolutionIndex = index;
  }
  return index;
}

// Resolve a single mission spawn entry to the most specific NPC profile query its own template identity
// supports, in priority order: explicit profile override -> exact ship typeID -> exact ship name -> legacy
// faction+hull mapping -> the caller's fallback (e.g. the encounter's group-level baseProfileID/spawnQuery).
// Drives BOTH the scrape path (candidateNames/label) and the imported-log path (per-NPC typeID).
function resolveSpawnIdentityProfileQuery(entry, fallbackQuery = "") {
  if (!entry || typeof entry !== "object") {
    return fallbackQuery;
  }
  const explicit = normalizeText(entry.spawnQuery, "") || normalizeText(entry.profileID, "");
  if (explicit) {
    return explicit;
  }
  // Content-pack pirate entries name a faction and a hull class only; the engine picks the ship
  // (deterministically per entry key, so a persisted site respawns the same hulls after a restart).
  if (
    normalizeText(entry.factionKey || entry.npcFactionKey, "") &&
    normalizeText(entry.hullClass, "")
  ) {
    const pirateHullProfiles = require(path.join(__dirname, "../../space/npc/pirateHullProfiles"));
    const resolvedFactionHull = pirateHullProfiles.resolveSpawnEntryProfileQuery(entry);
    if (resolvedFactionHull) {
      return resolvedFactionHull;
    }
  }
  const index = getNpcProfileResolutionIndex();
  const shipTypeID = toInt(entry.typeID, 0) || toInt(entry.shipTypeID, 0);
  if (shipTypeID > 0 && index.byShipTypeID.has(shipTypeID)) {
    return index.byShipTypeID.get(shipTypeID);
  }
  for (const candidate of [entry.label, entry.name, ...normalizeArray(entry.candidateNames)]) {
    const normalizedCandidate = normalizeLowerText(candidate, "");
    if (normalizedCandidate && index.byName.has(normalizedCandidate)) {
      return index.byName.get(normalizedCandidate);
    }
  }
  const legacyQuery = resolveLegacyMissionNpcSpawnQuery(entry);
  if (legacyQuery) {
    return legacyQuery;
  }
  return fallbackQuery;
}

function normalizeMissionSpawnQuery(entry = null) {
  const candidateNames = normalizeArray(entry && entry.candidateNames)
    .map((name) => normalizeText(name, ""))
    .filter(Boolean);
  const label = normalizeText(entry && entry.label, "");
  const raw = normalizeText(entry && entry.raw, "");
  // Scrape path: a known pirate faction + hull class maps to a clean parity profile; otherwise the raw
  // ship name flows through to live NPC selection, which resolves it to the exact catalog profile by name
  // (so unmapped factions — e.g. Rogue Drones — still spawn correctly off the template's ship names).
  const legacyMissionSpawnQuery = resolveLegacyMissionNpcSpawnQuery(entry);
  if (legacyMissionSpawnQuery) {
    return legacyMissionSpawnQuery;
  }
  const candidates = [
    ...candidateNames,
    label,
    raw,
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    if (!/\bfrigates?\b|\bcruisers?\b|\bbattlecruisers?\b|\bbattleships?\b|\belite frigates?\b/i.test(candidate)) {
      return candidate;
    }
  }
  const fallbackCandidate = candidates[0] || "";
  return fallbackCandidate.replace(/\b(Fighters|Frigates|Cruisers|Battlecruisers|Battleships)\b$/, (match) => (
    match.endsWith("s") ? match.slice(0, -1) : match
  ));
}

function buildMissionDerivedObjectiveMarkers(template) {
  const objectiveHints = normalizeArray(template && template.objectiveHints)
    .map((entry) => normalizeText(entry && (entry.label || entry.text || entry.raw || entry), ""))
    .filter(Boolean);
  const advisory = normalizeObject(template && template.advisory);
  const markers = objectiveHints.map((label, index) => ({
    role: index <= 0 ? "objective" : "task",
    label,
    analyzer: /\bhack|analyzer|databank|mainframe\b/i.test(label)
      ? "data"
      : /\bsalvage|relic|archaeolog/i.test(label)
        ? "relic"
        : null,
  }));
  if (markers.length <= 0) {
    markers.push({ role: "objective", label: "Complete mission objectives" });
  }
  if (normalizeText(advisory.webScramble, "")) {
    markers.push({ role: "task", label: "Watch for tackle ships" });
  }
  return markers;
}

function buildMissionDerivedEnvironmentProps(template) {
  const rooms = normalizeArray(template && template.rooms);
  const candidates = [];
  for (const room of rooms) {
    const entries = [
      ...normalizeArray(room && room.spawnEntries),
      ...normalizeArray(room && room.groups).flatMap((group) => normalizeArray(group && group.spawnEntries)),
    ];
    for (const entry of entries) {
      if (normalizeLowerText(entry && entry.entityKind, "") !== "structure") {
        continue;
      }
      const typeNameCandidates = [
        ...normalizeArray(entry && entry.candidateNames)
          .map((name) => normalizeText(name, ""))
          .filter(Boolean),
        normalizeText(entry && entry.label, ""),
      ].filter(Boolean);
      if (typeNameCandidates.length <= 0) {
        continue;
      }
      candidates.push({
        typeNameCandidates: [...new Set(typeNameCandidates)],
        label: normalizeText(entry && entry.label, "") || null,
      });
    }
  }
  return candidates;
}

function buildMissionDerivedEncounterPlans(template) {
  const rooms = normalizeArray(template && template.rooms);
  const encounterPlans = [];
  let waveIndex = 1;

  // Rooms reached through an acceleration gate spawn their encounters on gate activation
  // (on_room_active), not on warp-in (on_load) — this is what gives mission sites the retail
  // "warp in to an empty gate, activate, then fight the pocket" flow.
  const gateDestinationRoomKeys = new Set(
    normalizeArray(template && template.siteSceneProfile && template.siteSceneProfile.gateProfiles)
      .map((gateProfile) => normalizeText(gateProfile && gateProfile.destinationRoomKey, ""))
      .filter(Boolean),
  );

  for (let roomIndex = 0; roomIndex < rooms.length; roomIndex += 1) {
    const room = rooms[roomIndex];
    const roomKey = buildMissionRoomKey(room, roomIndex);
    const roomIsBehindGate = gateDestinationRoomKeys.has(roomKey);
    // Fallback trigger ladder for scraped missions: first group enters through the room trigger;
    // later groups chain on wave_cleared unless the scrape says they spawn with an earlier group.
    const roomTrigger = roomIsBehindGate
      ? "on_room_active"
      : (roomIndex === 0 ? "on_load" : "wave_cleared");
    const groups = normalizeArray(room && room.groups);
    const groupedEntries = groups.length > 0
      ? groups.map((group, index) => ({
          key: normalizeText(group && group.groupId, "") || `group_${index + 1}`,
          title: normalizeText(group && group.title, ""),
          groupNumber: parseMissionGroupNumber(group, index + 1),
          notes: normalizeArray(group && group.notes),
          spawnEntries: normalizeArray(group && group.spawnEntries),
        }))
      : [{
          key: "room",
          title: normalizeText(room && room.title, "Room"),
          groupNumber: 1,
          notes: normalizeArray(room && room.notes),
          spawnEntries: normalizeArray(room && room.spawnEntries),
        }];

    const waveIndexByGroupNumber = new Map();
    const triggerByWaveIndex = new Map();
    let hasSpawnedGroupInRoom = false;
    for (const group of groupedEntries) {
      const npcEntries = normalizeArray(group && group.spawnEntries)
        .filter((entry) => normalizeLowerText(entry && entry.entityKind, "") === "npc");
      if (npcEntries.length <= 0) {
        continue;
      }
      const sameWaveGroupNumber = parseMissionSameWaveGroupNumber(group);
      const referencedWaveIndex = sameWaveGroupNumber > 0
        ? waveIndexByGroupNumber.get(sameWaveGroupNumber)
        : 0;
      const groupWaveIndex = referencedWaveIndex || waveIndex;
      const trigger = referencedWaveIndex
        ? normalizeText(triggerByWaveIndex.get(groupWaveIndex), roomTrigger)
        : (hasSpawnedGroupInRoom ? "wave_cleared" : roomTrigger);
      waveIndexByGroupNumber.set(group.groupNumber, groupWaveIndex);
      triggerByWaveIndex.set(groupWaveIndex, trigger);
      if (!referencedWaveIndex) {
        waveIndex += 1;
      }
      hasSpawnedGroupInRoom = true;
      for (let entryIndex = 0; entryIndex < npcEntries.length; entryIndex += 1) {
        const entry = npcEntries[entryIndex];
        const spawnQuery = normalizeMissionSpawnQuery(entry) || "npc_hostiles";
        encounterPlans.push({
          key: normalizeText(
            `${roomKey}:${normalizeText(group && group.key, "group")}:${entryIndex + 1}`,
            `mission_wave_${groupWaveIndex}_${entryIndex + 1}`,
          ).toLowerCase().replace(/[^a-z0-9:._-]+/g, "_"),
          label: normalizeText(entry && entry.label, "") || `Encounter Wave ${groupWaveIndex}`,
          supported: true,
          spawnQuery,
          fallbackSpawnQuery: resolveMissionFallbackSpawnQuery(template, entry),
          amount: normalizeMissionSpawnCount(entry),
          deadspace: true,
          trigger,
          waveIndex: groupWaveIndex,
          roomKey,
          notes: normalizeArray(group && group.notes)
            .map((note) => normalizeText(note, ""))
            .filter(Boolean),
          sourceGroupID: normalizeText(group && group.key, "") || null,
          sourceGroupTitle: normalizeText(group && group.title, "") || null,
        });
      }
    }
  }

  return encounterPlans;
}

function buildDerivedMissionPopulationHints(template) {
  if (normalizeLowerText(template && template.siteFamily, "") !== "mission") {
    return null;
  }
  const encounters = buildMissionDerivedEncounterPlans(template);
  const environmentProps = buildMissionDerivedEnvironmentProps(template);
  const objectiveMarkers = buildMissionDerivedObjectiveMarkers(template);
  return {
    source: "mission_runtime_derived",
    roomCount: normalizeArray(template && template.rooms).length,
    encounter:
      encounters.length === 1
        ? cloneValue(encounters[0])
        : null,
    encounters,
    environmentProps,
    objectiveMarkers,
  };
}

function mergeDerivedMissionPopulationHints(baseHints, derivedHints) {
  if (!derivedHints) {
    return baseHints ? cloneValue(baseHints) : null;
  }
  const merged = {
    ...(baseHints ? cloneValue(baseHints) : {}),
    source: normalizeText(
      baseHints && baseHints.source,
      normalizeText(derivedHints && derivedHints.source, "mission_runtime_derived"),
    ),
    roomCount: Math.max(
      toInt(baseHints && baseHints.roomCount, 0),
      toInt(derivedHints && derivedHints.roomCount, 0),
    ),
    encounter:
      normalizeObject(baseHints && baseHints.encounter).supported !== undefined
        ? cloneValue(baseHints.encounter)
        : cloneValue(derivedHints.encounter),
    encounters: [
      ...normalizeArray(baseHints && baseHints.encounters),
      ...normalizeArray(derivedHints && derivedHints.encounters),
    ],
    environmentProps: [
      ...normalizeArray(baseHints && baseHints.environmentProps),
      ...normalizeArray(derivedHints && derivedHints.environmentProps),
    ],
    objectiveMarkers: [
      ...normalizeArray(baseHints && baseHints.objectiveMarkers),
      ...normalizeArray(derivedHints && derivedHints.objectiveMarkers),
    ],
  };
  return merged;
}

function resolvePopulationHints(instance, template) {
  const layout = instance?.spawnState?.hackingContainerLayout;
  if (layout?.version === 1 && layout.populationHints) return cloneValue(layout.populationHints);
  const legacyLayout = !layout &&
    (Object.keys(normalizeObject(instance?.spawnState?.contentEntityRefsByKey)).some(key => key.startsWith("container:")) ||
      Object.keys(normalizeObject(instance?.spawnState?.hackingContainers)).length > 0);
  const spawnHints =
    instance &&
    instance.spawnState &&
    typeof instance.spawnState === "object" &&
    instance.spawnState.populationHints &&
    typeof instance.spawnState.populationHints === "object"
      ? instance.spawnState.populationHints
      : null;
  if (spawnHints) {
    return { ...cloneValue(spawnHints), ...(legacyLayout ? { hackingLayoutVersion: 0 } : {}) };
  }
  const templateHints =
    template &&
    template.populationHints &&
    typeof template.populationHints === "object"
      ? template.populationHints
      : null;
  const originalHints = templateHints?.curatedHackableContent?.originalPopulationHints;
  const baseHints = templateHints ? cloneValue(legacyLayout && originalHints ? originalHints : templateHints) : null;
  if (baseHints && legacyLayout) baseHints.hackingLayoutVersion = 0;
  if (normalizeLowerText(template && template.siteFamily, "") !== "mission") {
    return baseHints;
  }
  return mergeDerivedMissionPopulationHints(baseHints, buildDerivedMissionPopulationHints(template));
}

function resolveEncounterPlans(populationHints) {
  const explicitPlans = normalizeArray(populationHints && populationHints.encounters)
    .filter((entry) => entry && typeof entry === "object");
  const fallbackPlan =
    populationHints &&
    populationHints.encounter &&
    typeof populationHints.encounter === "object"
      ? [populationHints.encounter]
      : [];
  const normalizedPlans = (explicitPlans.length > 0 ? explicitPlans : fallbackPlan)
    .map((entry, index) => {
      // Log-sourced ("TQ pack") encounters describe their NPCs as baseProfileID + an explicit
      // spawnEntries[] (per-NPC typeID/position/AI); simpler authored data only carries
      // spawnQuery + amount. Fall back across both so either shape survives the plan filter below.
      const spawnEntries = normalizeArray(entry && entry.spawnEntries)
        .filter((spawnEntry) => spawnEntry && typeof spawnEntry === "object");
      const spawnQuery =
        normalizeText(entry && entry.spawnQuery, "") ||
        normalizeText(entry && entry.baseProfileID, "") ||
        normalizeText(entry && entry.profileID, "");
      const amount =
        Math.max(0, toInt(entry && entry.amount, 0)) ||
        spawnEntries.length ||
        Math.max(0, toInt(entry && entry.count, 0));
      return {
        key: normalizeText(entry && entry.key, "") || `encounter_${index + 1}`,
        label: normalizeText(entry && entry.label, "") || `Encounter ${index + 1}`,
        supported: entry && entry.supported !== false,
        spawnQuery,
        amount,
        spawnEntries,
        exact: entry && entry.exact === true,
        fallbackSpawnQuery: normalizeText(entry && entry.fallbackSpawnQuery, "") || null,
        maxSpawnEntries: Math.max(0, toInt(
          entry && (entry.maxSpawnEntries || entry.maxExactSpawnEntries || entry.maxEncounterNpcs),
          0,
        )) || null,
        deadspace: entry && entry.deadspace === true,
        trigger: normalizeLowerText(entry && entry.trigger, "on_load"),
        triggerMessages: normalizeEncounterTriggerMessages(entry),
        triggerAudio: normalizeEncounterTriggerAudio(entry),
        proximityTargetKey: normalizeText(entry && entry.proximityTargetKey, "") || null,
        proximityRangeMeters:
          Math.max(0, toFiniteNumber(entry && entry.proximityRangeMeters, 0)) || null,
        countdownSeconds: Math.max(0, toInt(entry && entry.countdownSeconds, 0)) || null,
        delaySeconds: Math.max(0, toInt(entry && entry.delaySeconds, 0)) || null,
        waveIndex: Math.max(1, toInt(entry && entry.waveIndex, index + 1)),
        prerequisiteKey: normalizeText(entry && entry.prerequisiteKey, "") || null,
        // entity_killed waves: the single ship whose death fires this wave on TQ.
        triggerEntity: normalizeObject(entry && entry.triggerEntity),
        // container_hacked waves: when set, only a hack of one of these client objects fires the wave.
        triggerContainerObjectIDs: normalizeIDList(entry && entry.triggerContainerObjectIDs),
        lootProfile: normalizeText(entry && entry.lootProfile, "") || null,
        lootTags: normalizeArray(entry && entry.lootTags)
          .map((tag) => normalizeLowerText(tag, ""))
          .filter(Boolean),
        notes: normalizeArray(entry && entry.notes)
          .map((note) => normalizeText(note, ""))
          .filter(Boolean),
        roomKey: normalizeText(entry && entry.roomKey, "") || null,
        sourceGroupID: normalizeText(entry && entry.sourceGroupID, "") || null,
        sourceGroupTitle: normalizeText(entry && entry.sourceGroupTitle, "") || null,
        objective: entry && entry.objective === true,
        completionRole: normalizeLowerText(entry && entry.completionRole, "") || null,
        // Chance waves (content-pack reconstruction of "0-1x commander" spawns): the wave rolls once
        // per instance and settles immediately when the roll fails.
        spawnChance: Number.isFinite(Number(entry && entry.spawnChance)) &&
          Number(entry.spawnChance) > 0 &&
          Number(entry.spawnChance) < 1
          ? Number(entry.spawnChance)
          : null,
        chanceGroup: entry && entry.chanceGroup === true,
      };
    })
    .filter((entry) => entry.spawnQuery && entry.amount > 0);
  return normalizedPlans;
}

function listOrderedInstanceRoomKeys(instance) {
  const roomStatesByKey =
    instance &&
    instance.roomStatesByKey &&
    typeof instance.roomStatesByKey === "object"
      ? instance.roomStatesByKey
      : {};
  const dynamicRoomKeys = Object.keys(roomStatesByKey)
    .filter((roomKey) => roomKey && roomKey !== "room:entry")
    .sort((left, right) => toInt(left.split(":").pop(), 0) - toInt(right.split(":").pop(), 0));
  return ["room:entry", ...dynamicRoomKeys];
}

function listOrderedInstanceGateKeys(instance) {
  const gateStatesByKey =
    instance &&
    instance.gateStatesByKey &&
    typeof instance.gateStatesByKey === "object"
      ? instance.gateStatesByKey
      : {};
  return Object.keys(gateStatesByKey)
    .sort((left, right) => {
      const leftState = gateStatesByKey[left] || {};
      const rightState = gateStatesByKey[right] || {};
      return (
        toInt(leftState && leftState.metadata && leftState.metadata.connectionIndex, 0) -
        toInt(rightState && rightState.metadata && rightState.metadata.connectionIndex, 0)
      ) || left.localeCompare(right);
    });
}

function resolveEncounterRoomKey(instance, populationHints, encounterPlan) {
  const explicitRoomKey = normalizeText(encounterPlan && encounterPlan.roomKey, "");
  if (explicitRoomKey) {
    return explicitRoomKey;
  }
  const orderedRoomKeys = listOrderedInstanceRoomKeys(instance);
  if (orderedRoomKeys.length <= 1) {
    return "room:entry";
  }
  const orderedPlans = resolveEncounterPlans(populationHints)
    .sort((left, right) => (
      Math.max(1, toInt(left && left.waveIndex, 1)) - Math.max(1, toInt(right && right.waveIndex, 1))
    ) || normalizeText(left && left.key, "").localeCompare(normalizeText(right && right.key, "")));
  const planKey = normalizeText(encounterPlan && encounterPlan.key, "");
  const planIndex = Math.max(0, orderedPlans.findIndex((plan) => normalizeText(plan && plan.key, "") === planKey));
  const roomIndex = Math.min(
    orderedRoomKeys.length - 1,
    Math.floor((planIndex * orderedRoomKeys.length) / Math.max(1, orderedPlans.length)),
  );
  return orderedRoomKeys[roomIndex] || "room:entry";
}

function groupEncounterPlansByRoom(instance, populationHints) {
  const grouped = {};
  const orderedPlans = resolveEncounterPlans(populationHints)
    .sort((left, right) => (
      Math.max(1, toInt(left && left.waveIndex, 1)) - Math.max(1, toInt(right && right.waveIndex, 1))
    ) || normalizeText(left && left.key, "").localeCompare(normalizeText(right && right.key, "")));
  for (const plan of orderedPlans) {
    const roomKey = resolveEncounterRoomKey(instance, populationHints, plan);
    if (!grouped[roomKey]) {
      grouped[roomKey] = [];
    }
    grouped[roomKey].push(plan);
  }
  return grouped;
}

function getEncounterStateByKey(instance, planKey) {
  return normalizeObject(
    instance &&
    instance.spawnState &&
    instance.spawnState.encounterStatesByKey &&
    instance.spawnState.encounterStatesByKey[planKey],
  );
}

function isEncounterPlanSettled(instance, plan) {
  const state = getEncounterStateByKey(instance, plan && plan.key);
  const spawnedAtMs = Math.max(0, toInt(state && state.spawnedAtMs, 0));
  if (spawnedAtMs <= 0) {
    return false;
  }
  return (
    Math.max(0, toInt(state && state.completedAtMs, 0)) > 0 ||
    normalizeIDList(state && state.remainingEntityIDs).length <= 0
  );
}

// How a site's client objective chain counts waves, read from the chain's own current_wave
// default. Chain 69 (combat anomalies and escalations, "Current Wave", default 1) counts the
// wave on grid; chain 88 ("Completed Waves", default 0) counts waves already cleared. A chain
// without both keys has no wave counter.
function resolveClientWaveCounterKind(objectiveChainID) {
  const chainID = Math.max(0, toInt(objectiveChainID, 0));
  if (chainID <= 0) {
    return null;
  }
  const chain = dungeonAuthority.getObjectiveChainByID(chainID);
  const parameters = normalizeArray(chain && chain.contextParameters);
  const currentWave = parameters.find((parameter) => parameter && parameter.parameterKey === "current_wave");
  const totalWaves = parameters.find((parameter) => parameter && parameter.parameterKey === "total_waves");
  if (!currentWave || !totalWaves) {
    return null;
  }
  return toInt(currentWave.defaultValue, 1) === 0 ? "cleared" : "on_grid";
}

// The current_wave/total_waves values the client's site panel reads. With none sent the panel
// keeps its authored defaults for the whole site (1/2 on chain 69), so it never moves and never
// completes. Groups sharing a waveIndex are one wave. Not the stored objective counters: those
// mean something else and the mission code reads them.
function buildClientWaveValues(instance, options = {}) {
  if (!instance) {
    return null;
  }
  const template = options.template || dungeonAuthority.getTemplateByID(instance.templateID);
  const counterKind = resolveClientWaveCounterKind(
    template && template.clientObjectives && template.clientObjectives.objectiveChainID,
  );
  if (!counterKind) {
    return null;
  }
  const plans = normalizeArray(
    options.plans || resolveEncounterPlans(resolvePopulationHints(instance, template)),
  ).filter((plan) => plan && plan.supported);
  const plansByWave = new Map();
  for (const plan of plans) {
    const waveIndex = Math.max(1, toInt(plan.waveIndex, 1));
    if (!plansByWave.has(waveIndex)) {
      plansByWave.set(waveIndex, []);
    }
    plansByWave.get(waveIndex).push(plan);
  }
  const totalWaves = plansByWave.size;
  if (totalWaves <= 0) {
    return null;
  }
  let spawnedWaves = 0;
  let clearedWaves = 0;
  for (const wavePlans of plansByWave.values()) {
    if (wavePlans.some((plan) => (
      Math.max(0, toInt(getEncounterStateByKey(instance, plan.key).spawnedAtMs, 0)) > 0
    ))) {
      spawnedWaves += 1;
    }
    if (wavePlans.every((plan) => isEncounterPlanSettled(instance, plan))) {
      clearedWaves += 1;
    }
  }
  // A completed site ends on a full counter even when its completion did not need every wave.
  const currentWave = normalizeLowerText(instance.lifecycleState, "") === "completed"
    ? totalWaves
    : counterKind === "cleared"
      ? clearedWaves
      : Math.max(1, spawnedWaves);
  return {
    current_wave: Math.min(totalWaves, currentWave),
    total_waves: totalWaves,
  };
}

// Pushes the wave counter to pilots in the site when it changes. Pilots arriving later get it
// with OnEnteringDungeonRoom (dungeonTrackingRuntime.buildDungeonValues).
function publishClientWaveValues(scene, instance, options = {}) {
  if (!scene || !instance) {
    return 0;
  }
  const values = buildClientWaveValues(instance, options);
  if (!values) {
    return 0;
  }
  const signature = `${values.current_wave}/${values.total_waves}`;
  scene.dungeonWaveValuesByInstanceID ??= new Map();
  if (scene.dungeonWaveValuesByInstanceID.get(instance.instanceID) === signature) {
    return 0;
  }
  scene.dungeonWaveValuesByInstanceID.set(instance.instanceID, signature);
  return dungeonTrackingRuntime.notifyDungeonValuesForScene(scene, instance, values);
}

function normalizeCompletionHints(populationHints) {
  const completion =
    populationHints &&
    populationHints.completion &&
    typeof populationHints.completion === "object"
      ? populationHints.completion
      : {};
  return {
    ...cloneValue(completion),
    // Objective metadata (used by non-kill objective modes: investigate/hack/mine/etc.). The
    // interaction/mining handlers report explicit progress; until then, encounter-clear is the
    // fallback. completeOnEncounterClear defaults true and is only disabled when explicitly false.
    objectiveMode: normalizeLowerText(
      completion.objectiveMode || (populationHints && populationHints.objectiveMode),
      "",
    ) || null,
    completeOnEncounterClear:
      completion.completeOnEncounterClear === false ||
      completion.completeObjectiveOnEncounterClear === false ||
      (populationHints && populationHints.completeObjectiveOnEncounterClear === false)
        ? false
        : true,
    mode: normalizeLowerText(
      completion.mode || completion.completionMode,
      "",
    ) || null,
    encounterKeys: normalizeArray(
      completion.encounterKeys ||
      completion.encounterKey ||
      completion.groupKeys ||
      completion.groupKey ||
      completion.objectiveEncounterKeys ||
      completion.objectiveEncounterKey,
    )
      .map((entry) => normalizeText(entry, ""))
      .filter(Boolean),
    objectiveTargets: normalizeArray(
      completion.objectiveTargets ||
      completion.objectiveTarget ||
      completion.destroyTargets ||
      completion.destroyTarget ||
      completion.targetObjects ||
      completion.targetObject,
    )
      .filter((entry) => entry && typeof entry === "object")
      .map((entry) => ({
        key: normalizeText(entry.key, "") || null,
        label: normalizeText(entry.label || entry.name, "") || null,
        typeID: Math.max(0, toInt(entry.typeID, 0)) || null,
        dunObjectID: Math.max(0, toInt(entry.dunObjectID, 0)) || null,
        dunObjectNameID: Math.max(0, toInt(entry.dunObjectNameID, 0)) || null,
        nameID: Math.max(0, toInt(entry.nameID, 0)) || null,
      }))
      .filter((entry) => (
        entry.key ||
        entry.label ||
        entry.typeID ||
        entry.dunObjectID ||
        entry.dunObjectNameID ||
        entry.nameID
      )),
  };
}

function entityOrSpawnEntryMatchesObjectiveTarget(candidate, target) {
  if (!candidate || !target) {
    return false;
  }
  const targetKey = normalizeText(target.key, "");
  if (
    targetKey &&
    normalizeText(candidate.key || candidate.dungeonSiteContentKey || candidate.dungeonObjectiveTargetKey, "") === targetKey
  ) {
    return true;
  }
  const targetDunObjectID = Math.max(0, toInt(target.dunObjectID, 0));
  if (
    targetDunObjectID > 0 &&
    Math.max(0, toInt(candidate.dunObjectID, 0)) === targetDunObjectID
  ) {
    return true;
  }
  const targetNameID = Math.max(0, toInt(target.nameID || target.dunObjectNameID, 0));
  if (
    targetNameID > 0 &&
    (
      Math.max(0, toInt(candidate.nameID, 0)) === targetNameID ||
      Math.max(0, toInt(candidate.dunObjectNameID, 0)) === targetNameID
    )
  ) {
    return true;
  }
  const targetTypeID = Math.max(0, toInt(target.typeID, 0));
  if (
    targetTypeID > 0 &&
    Math.max(0, toInt(candidate.typeID, 0)) === targetTypeID
  ) {
    // A nameID on both sides is a discriminator, not just another match key: the same hull can
    // be authored as different actors in one dungeon (Rouvenor fields a "State Dogo" 25045 in
    // two pockets and only the final one — nameID 118708 — triggers the armor grant).
    const candidateNameID = Math.max(
      0,
      toInt(candidate.nameID || candidate.dunObjectNameID, 0),
    );
    if (targetNameID > 0 && candidateNameID > 0 && candidateNameID !== targetNameID) {
      return false;
    }
    const targetLabel = normalizeLowerText(target.label, "");
    if (!targetLabel) {
      return true;
    }
    const candidateLabel = normalizeLowerText(candidate.label || candidate.name || candidate.itemName || candidate.slimName, "");
    if (candidateLabel && candidateLabel === targetLabel) {
      return true;
    }
  }
  return false;
}

function isObjectiveTargetSpawnEntry(spawnEntry, encounterPlan, completion) {
  if (!spawnEntry || typeof spawnEntry !== "object") {
    return false;
  }
  if (
    spawnEntry.objective === true ||
    spawnEntry.objectiveTarget === true ||
    spawnEntry.blocksObjectiveProgress === true
  ) {
    return true;
  }
  const completionRole = normalizeLowerText(
    (spawnEntry && spawnEntry.completionRole) ||
      (encounterPlan && encounterPlan.completionRole),
    "",
  );
  if (completionRole === "objective") {
    return true;
  }
  return normalizeArray(completion && completion.objectiveTargets)
    .some((target) => entityOrSpawnEntryMatchesObjectiveTarget(spawnEntry, target));
}

function resolveCompletionEncounterKeys(completion, plans) {
  const explicitKeys = new Set(
    normalizeArray(completion && completion.encounterKeys)
      .map((entry) => normalizeText(entry, ""))
      .filter(Boolean),
  );
  for (const plan of plans) {
    const planKey = normalizeText(plan && plan.key, "");
    if (!planKey) {
      continue;
    }
    if (
      plan.objective === true ||
      normalizeLowerText(plan && plan.completionRole, "") === "objective"
    ) {
      explicitKeys.add(planKey);
    }
  }
  return [...explicitKeys];
}

function isSiteObjectiveExplicitlySatisfied(instance) {
  return Math.max(0, toInt(instance && instance.objectiveSatisfiedAtMs, 0)) > 0 ||
    Math.max(0, toInt(instance && instance.metadata && instance.metadata.objectiveSatisfiedAtMs, 0)) > 0;
}

function isEncounterCompletionSatisfied(instance, plans, populationHints) {
  if (!instance) {
    return false;
  }
  const completion = normalizeCompletionHints(populationHints);
  // Explicit objective satisfaction (set by interactable/mining objective handlers, B2/C) completes
  // the site regardless of remaining encounters — the hook for non-kill objective modes. Until those
  // report progress, encounter-clear is the fallback unless the author disabled it.
  if (isSiteObjectiveExplicitlySatisfied(instance)) {
    return true;
  }
  if (!Array.isArray(plans) || plans.length <= 0) {
    return false;
  }
  if (completion.completeOnEncounterClear === false) {
    return false;
  }
  const mode = normalizeLowerText(completion && completion.mode, "");
  if (
    mode === "objective_target_destroyed" ||
    mode === "objective_targets_destroyed" ||
    mode === "destroy_objective_target" ||
    mode === "destroy_objective_targets"
  ) {
    return false;
  }
  const completionKeys = resolveCompletionEncounterKeys(completion, plans);
  if (
    completionKeys.length > 0 ||
    mode === "encounter_group_cleared" ||
    mode === "encounter_groups_cleared" ||
    mode === "objective_group_cleared"
  ) {
    const targetKeys = completionKeys.length > 0
      ? completionKeys
      : plans.map((plan) => normalizeText(plan && plan.key, "")).filter(Boolean);
    return targetKeys.every((planKey) => {
      const plan = plans.find((entry) => normalizeText(entry && entry.key, "") === planKey);
      return plan && isEncounterPlanSettled(instance, plan);
    });
  }
  return plans.every((plan) => isEncounterPlanSettled(instance, plan));
}

function areSortedNumberListsEqual(left, right) {
  const normalizedLeft = normalizeIDList(left);
  const normalizedRight = normalizeIDList(right);
  if (normalizedLeft.length !== normalizedRight.length) {
    return false;
  }
  for (let index = 0; index < normalizedLeft.length; index += 1) {
    if (normalizedLeft[index] !== normalizedRight[index]) {
      return false;
    }
  }
  return true;
}

function upsertEncounterState(instanceID, planKey, patch = {}, options = {}) {
  const existing = dungeonRuntime.getInstance(instanceID);
  if (!existing) {
    return null;
  }
  const encounterStatesByKey = normalizeObject(
    existing.spawnState && existing.spawnState.encounterStatesByKey,
  );
  return dungeonRuntime.mergeSpawnState(instanceID, {
    encounterStatesByKey: {
      ...encounterStatesByKey,
      [planKey]: {
        ...normalizeObject(encounterStatesByKey[planKey]),
        ...(patch && typeof patch === "object" ? cloneValue(patch) : {}),
        key: planKey,
      },
    },
  }, options);
}

function resolveEncounterPrerequisiteKeys(plans, encounterPlan) {
  const explicitKey = normalizeText(encounterPlan && encounterPlan.prerequisiteKey, "");
  if (explicitKey) {
    return [explicitKey];
  }
  const currentWaveIndex = Math.max(1, toInt(encounterPlan && encounterPlan.waveIndex, 1));
  let prerequisiteWaveIndex = 0;
  for (const plan of normalizeArray(plans)) {
    if (!plan || !normalizeText(plan.key, "")) {
      continue;
    }
    if (normalizeText(plan.key, "") === normalizeText(encounterPlan && encounterPlan.key, "")) {
      continue;
    }
    const planWaveIndex = Math.max(1, toInt(plan.waveIndex, 1));
    if (planWaveIndex < currentWaveIndex && planWaveIndex > prerequisiteWaveIndex) {
      prerequisiteWaveIndex = planWaveIndex;
    }
  }
  if (prerequisiteWaveIndex <= 0) {
    return [];
  }
  const priorPlans = normalizeArray(plans)
    .filter((plan) => (
      plan &&
      normalizeText(plan.key, "") &&
      normalizeText(plan.key, "") !== normalizeText(encounterPlan && encounterPlan.key, "") &&
      Math.max(1, toInt(plan.waveIndex, 1)) === prerequisiteWaveIndex
    ))
    .sort((left, right) => (
      Math.max(1, toInt(left && left.waveIndex, 1)) - Math.max(1, toInt(right && right.waveIndex, 1)) ||
      normalizeText(left && left.key, "").localeCompare(normalizeText(right && right.key, ""))
    ));
  return priorPlans
    .map((plan) => normalizeText(plan && plan.key, ""))
    .filter(Boolean);
}

function encounterPlanHasNpcProgressEntries(encounterPlan) {
  const spawnEntries = normalizeArray(encounterPlan && encounterPlan.spawnEntries)
    .filter((entry) => entry && typeof entry === "object");
  if (spawnEntries.length <= 0) {
    return true;
  }
  return spawnEntries.some((entry) => !isKillableStructureSpawnEntry(entry));
}

function buildSpawnedIdentityMap(spawned) {
  const identitiesByEntityID = {};
  for (const entry of normalizeArray(spawned)) {
    const entity = entry && entry.entity;
    const entityID = Math.max(0, toInt(entity && entity.itemID, 0));
    if (entityID <= 0) {
      continue;
    }
    identitiesByEntityID[String(entityID)] = {
      typeID: Math.max(0, toInt(entity && entity.typeID, 0)) || null,
      nameID: Math.max(0, toInt(entity && (entity.nameID || entity.dunObjectNameID), 0)) || null,
      dunObjectID: Math.max(0, toInt(entity && entity.dunObjectID, 0)) || null,
      label: normalizeText(entity && (entity.label || entity.itemName || entity.slimName), "") || null,
    };
  }
  return identitiesByEntityID;
}

// Plain "is this entity still on grid" test. Deliberately NOT listAliveEncounterEntityIDs, which
// filters to progress-BLOCKING entities: a TQ trigger ship does not have to be one of those.
function isEncounterEntityStillPresent(scene, entityID) {
  const numericEntityID = Math.max(0, toInt(entityID, 0));
  if (numericEntityID <= 0 || !scene) {
    return false;
  }
  if (scene.dynamicEntities instanceof Map && scene.dynamicEntities.has(numericEntityID)) {
    return true;
  }
  const staticEntity = scene.staticEntitiesByID instanceof Map
    ? scene.staticEntitiesByID.get(numericEntityID)
    : null;
  if (!staticEntity) {
    return false;
  }
  return toFiniteNumber(normalizeObject(staticEntity.conditionState).damage, 0) < 1;
}

// entity_killed: has the wave's named trigger ship died yet? Scoped to the prerequisite wave's own
// spawns, so an identically-hulled ship elsewhere in the pocket cannot fire it.
function hasEncounterTriggerEntityBeenKilled(scene, instance, plans, prerequisiteKeys, triggerEntity) {
  const trigger = normalizeObject(triggerEntity);
  if (
    Math.max(0, toInt(trigger.typeID, 0)) <= 0 &&
    Math.max(0, toInt(trigger.nameID || trigger.dunObjectNameID, 0)) <= 0 &&
    Math.max(0, toInt(trigger.dunObjectID, 0)) <= 0
  ) {
    return false;
  }
  for (const prerequisiteKey of normalizeArray(prerequisiteKeys)) {
    const prerequisiteState = getEncounterStateByKey(instance, prerequisiteKey);
    if (Math.max(0, toInt(prerequisiteState && prerequisiteState.spawnedAtMs, 0)) <= 0) {
      continue;
    }
    const identitiesByEntityID = normalizeObject(
      prerequisiteState && prerequisiteState.spawnedIdentitiesByEntityID,
    );
    for (const [entityIDText, identity] of Object.entries(identitiesByEntityID)) {
      const entityID = Math.max(0, toInt(entityIDText, 0));
      if (entityID <= 0 || isEncounterEntityStillPresent(scene, entityID)) {
        continue;
      }
      if (entityOrSpawnEntryMatchesObjectiveTarget(identity, trigger)) {
        return true;
      }
    }
  }
  return false;
}

function listAliveEncounterEntityIDs(scene, encounterState, encounterPlan = null) {
  const nonBlockingEntityIDs = new Set(normalizeIDList(
    encounterState && encounterState.nonBlockingEntityIDs,
  ));
  const hasNpcProgressEntries = encounterPlanHasNpcProgressEntries(encounterPlan);
  const seededEntityIDs = normalizeIDList(
    encounterState &&
    (
      encounterState.remainingEntityIDs ||
      encounterState.spawnedEntityIDs
    ),
  )
    .filter((entityID) => !nonBlockingEntityIDs.has(entityID));
  if (!scene) {
    return seededEntityIDs;
  }
  return seededEntityIDs.filter((entityID) => {
    if (scene.dynamicEntities instanceof Map && scene.dynamicEntities.has(entityID)) {
      return true;
    }
    const staticEntity = scene.staticEntitiesByID instanceof Map
      ? scene.staticEntitiesByID.get(entityID)
      : null;
    if (!staticEntity) {
      return false;
    }
    if (staticEntity.dungeonEncounterBlocksProgress === false) {
      return false;
    }
    if (
      hasNpcProgressEntries &&
      staticEntity.dungeonMaterializedKillableStructure === true &&
      !Object.prototype.hasOwnProperty.call(staticEntity, "dungeonEncounterBlocksProgress")
    ) {
      return false;
    }
    const conditionState = normalizeObject(staticEntity && staticEntity.conditionState);
    return toFiniteNumber(conditionState.damage, 0) < 1;
  });
}

function syncEncounterStateProgress(scene, instance, plans, options = {}) {
  const nowMs = Math.max(0, toInt(options.nowMs, Date.now()));
  let completedCount = 0;
  let updatedCount = 0;
  for (const plan of normalizeArray(plans)) {
    const planKey = normalizeText(plan && plan.key, "");
    if (!planKey) {
      continue;
    }
    const encounterState = getEncounterStateByKey(instance, planKey);
    const spawnedAtMs = Math.max(0, toInt(encounterState && encounterState.spawnedAtMs, 0));
    if (spawnedAtMs <= 0) {
      continue;
    }
    const completedAtMs = Math.max(0, toInt(encounterState && encounterState.completedAtMs, 0));
    const aliveEntityIDs = listAliveEncounterEntityIDs(scene, encounterState, plan);
    const patch = {};
    if (!areSortedNumberListsEqual(encounterState && encounterState.remainingEntityIDs, aliveEntityIDs)) {
      patch.remainingEntityIDs = aliveEntityIDs;
    }
    if (aliveEntityIDs.length <= 0 && completedAtMs <= 0) {
      patch.completedAtMs = nowMs;
      completedCount += 1;
    }
    if (Object.keys(patch).length <= 0) {
      continue;
    }
    upsertEncounterState(instance.instanceID, planKey, patch, { nowMs });
    updatedCount += 1;
  }
  return {
    completedCount,
    updatedCount,
  };
}

function rematerializeStoredDungeonEncounterEntities(
  scene,
  instance,
  siteEntity,
  options = {},
) {
  const systemID = Math.max(0, toInt(scene && scene.systemID, 0));
  const instanceID = Math.max(0, toInt(instance && instance.instanceID, 0));
  const instanceSystemID = Math.max(
    0,
    toInt(instance && instance.solarSystemID, 0),
  );
  const siteID = Math.max(0, toInt(siteEntity && siteEntity.itemID, 0));
  if (
    !scene ||
    systemID <= 0 ||
    instanceID <= 0 ||
    siteID <= 0 ||
    instanceSystemID !== systemID
  ) {
    return { npcCount: 0, wreckCount: 0 };
  }

  const nativeNpcStore = getNativeNpcStore();
  const nativeNpcService = getNativeNpcService();
  const nativeNpcWreckService = getNativeNpcWreckService();
  const encounterStatesByKey = normalizeObject(
    instance && instance.spawnState && instance.spawnState.encounterStatesByKey,
  );
  const storedEntityIDs = normalizeIDList(
    Object.values(encounterStatesByKey).flatMap((state) => [
      ...normalizeIDList(state && state.spawnedEntityIDs),
      ...normalizeIDList(state && state.remainingEntityIDs),
    ]),
  );
  let npcCount = 0;
  for (const entityID of storedEntityIDs) {
    const entityRecord = nativeNpcStore.getNativeEntity(entityID);
    const controllerRecord = nativeNpcStore.getNativeController(entityID);
    if (
      !entityRecord ||
      !controllerRecord ||
      entityRecord.dungeonMaterializedSiteContent !== true ||
      toInt(entityRecord.systemID, 0) !== systemID ||
      toInt(entityRecord.dungeonSiteInstanceID, 0) !== instanceID ||
      toInt(entityRecord.dungeonSiteID, 0) !== siteID
    ) {
      continue;
    }
    const materializeResult = nativeNpcService.materializeStoredNativeController(
      scene,
      entityID,
      { broadcast: false },
    );
    if (materializeResult && materializeResult.success === true) {
      npcCount += 1;
    }
  }

  const nowMs = Math.max(0, toInt(options.nowMs, Date.now()));
  let wreckCount = 0;
  for (const wreckRecord of nativeNpcStore.listNativeWrecks()) {
    if (
      !wreckRecord ||
      wreckRecord.dungeonMaterializedSiteContent !== true ||
      toInt(wreckRecord.systemID, 0) !== systemID ||
      toInt(wreckRecord.dungeonSiteInstanceID, 0) !== instanceID ||
      toInt(wreckRecord.dungeonSiteID, 0) !== siteID
    ) {
      continue;
    }
    if (
      toInt(wreckRecord.expiresAtMs, 0) > 0 &&
      toInt(wreckRecord.expiresAtMs, 0) <= nowMs
    ) {
      nativeNpcWreckService.destroyNativeWreck(wreckRecord.wreckID, {
        systemID,
        broadcast: false,
      });
      continue;
    }
    const spawnResult = nativeNpcWreckService.spawnNativeWreck(
      systemID,
      wreckRecord.wreckID,
      { broadcast: false },
    );
    if (spawnResult && spawnResult.success === true) {
      wreckCount += 1;
    }
  }
  return { npcCount, wreckCount };
}

function rehydrateMissingEncounterStates(scene, instance, populationHints, options = {}) {
  const nowMs = Math.max(0, toInt(options.nowMs, Date.now()));
  let workingInstance = instance;
  let resetCount = 0;
  for (const plan of resolveEncounterPlans(populationHints)) {
    const planKey = normalizeText(plan && plan.key, "");
    if (!planKey) {
      continue;
    }
    const encounterState = getEncounterStateByKey(workingInstance, planKey);
    const spawnedAtMs = Math.max(0, toInt(encounterState && encounterState.spawnedAtMs, 0));
    const completedAtMs = Math.max(0, toInt(encounterState && encounterState.completedAtMs, 0));
    if (spawnedAtMs <= 0 || completedAtMs > 0) {
      continue;
    }
    const aliveEntityIDs = listAliveEncounterEntityIDs(scene, encounterState, plan);
    if (aliveEntityIDs.length > 0) {
      if (!areSortedNumberListsEqual(encounterState && encounterState.remainingEntityIDs, aliveEntityIDs)) {
        workingInstance = upsertEncounterState(workingInstance.instanceID, planKey, {
          remainingEntityIDs: aliveEntityIDs,
        }, { nowMs });
      }
      continue;
    }
    workingInstance = upsertEncounterState(workingInstance.instanceID, planKey, {
      spawnedAtMs: 0,
      spawnCount: 0,
      spawnedEntityIDs: [],
      remainingEntityIDs: [],
      lastRehydratedAtMs: nowMs,
    }, { nowMs });
    resetCount += 1;
  }
  return {
    instance: workingInstance,
    resetCount,
  };
}

function resolveObjectiveLabel(objective, objectiveType) {
  return humanizeIdentifier(
    objective && objective.title,
    humanizeIdentifier(
      objectiveType && objectiveType.title,
      humanizeIdentifier(objective && objective.key, "Objective"),
    ),
  );
}

function resolveObjectiveTaskLabel(task, taskType) {
  return humanizeIdentifier(
    taskType && taskType.title,
    humanizeIdentifier(task && task.key, "Task"),
  );
}

function normalizeObjectiveMarkerHintEntries(entries) {
  const normalized = [];
  const seen = new Set();
  for (const entry of normalizeArray(entries)) {
    if (!(entry && typeof entry === "object")) {
      continue;
    }
    const role = normalizeLowerText(entry.role, "");
    const label = normalizeText(entry.label, "");
    if (!role || !label) {
      continue;
    }
    const analyzer = normalizeLowerText(entry.analyzer, "") || null;
    const icon = normalizeText(entry.icon, "") || null;
    const key = normalizeText(entry.key, "") ||
      label.toLowerCase().replace(/[^a-z0-9]+/g, "_");
    const dedupeKey = `${role}:${label}:${analyzer || ""}:${icon || ""}`;
    if (seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);
    normalized.push({
      role,
      label,
      objectiveKey: key,
      objectiveTypeID: null,
      objectiveTaskTypeID: null,
      icon,
      analyzer,
    });
  }
  return normalized;
}

function buildFallbackPopulationObjectiveMarkers(populationHints, template) {
  const family = normalizeLowerText(template && template.siteFamily, "unknown");
  const containers = normalizeArray(populationHints && populationHints.containers)
    .filter((entry) => entry && typeof entry === "object");
  const hazards = normalizeArray(populationHints && populationHints.hazards);
  const encounters = resolveEncounterPlans(populationHints);
  const resources =
    populationHints && populationHints.resources && typeof populationHints.resources === "object"
      ? populationHints.resources
      : {};
  const markers = [];
  switch (family) {
    case "data":
      markers.push(
        { role: "objective", label: "Hack research caches", analyzer: "data" },
        { role: "task", label: "Recover site intelligence", analyzer: "data" },
      );
      break;
    case "relic":
      markers.push(
        { role: "objective", label: "Recover archaeology caches", analyzer: "relic" },
        { role: "task", label: "Salvage relic materials", analyzer: "relic" },
      );
      break;
    case "ghost":
      markers.push(
        { role: "objective", label: "Hack covert research caches", analyzer: "data" },
        { role: "task", label: "Beat the response timer", analyzer: "data" },
      );
      break;
    case "combat":
      markers.push({ role: "objective", label: "Eliminate hostile defenders" });
      break;
    case "combat_hacking":
      markers.push(
        { role: "objective", label: "Hack the facility network", analyzer: "data" },
        { role: "task", label: "Defeat security reinforcements" },
      );
      break;
    case "gas":
      markers.push({ role: "objective", label: "Harvest gas clouds" });
      break;
    case "ore":
      markers.push({ role: "objective", label: "Mine resource deposits" });
      break;
    default:
      break;
  }
  if (
    encounters.length > 0 &&
    family !== "combat"
  ) {
    markers.push({ role: "task", label: "Neutralize site defenders" });
  }
  if (hazards.some((entry) => normalizeLowerText(entry && entry.kind || entry, "").includes("ghost_site"))) {
    markers.push({ role: "task", label: "Avoid cache detonation", analyzer: "data" });
  }
  if (containers.some((entry) => normalizeLowerText(entry && entry.analyzer, "") === "data")) {
    markers.push({ role: "task", label: "Open data containers", analyzer: "data" });
  }
  if (containers.some((entry) => normalizeLowerText(entry && entry.analyzer, "") === "relic")) {
    markers.push({ role: "task", label: "Open relic containers", analyzer: "relic" });
  }
  if (normalizeArray(resources.gasTypeIDs).length > 0 && family !== "gas") {
    markers.push({ role: "task", label: "Harvest gas resources" });
  }
  if (
    normalizeArray(resources.oreTypeIDs).length > 0 ||
    normalizeArray(resources.iceTypeIDs).length > 0
  ) {
    markers.push({ role: "task", label: "Extract mineable resources" });
  }
  return normalizeObjectiveMarkerHintEntries(markers);
}

function resolvePopulationObjectiveMarkers(populationHints, template) {
  const explicitMarkers = normalizeObjectiveMarkerHintEntries(
    populationHints && populationHints.objectiveMarkers,
  );
  if (explicitMarkers.length > 0) {
    return explicitMarkers;
  }
  return buildFallbackPopulationObjectiveMarkers(populationHints, template);
}

function buildContentOffset(seed, index, total, options = {}) {
  const baseDistance = Math.max(
    2500,
    toFiniteNumber(options.baseDistanceMeters, SITE_CONTENT_CONTAINER_RING_METERS),
  );
  const jitterMeters = Math.max(
    0,
    toFiniteNumber(options.jitterMeters, SITE_CONTENT_CONTAINER_JITTER_METERS),
  );
  const count = Math.max(1, toInt(total, 1));
  const angleBase = ((index % count) / count) * Math.PI * 2;
  const angleJitter = ((hashText(`${seed}:angle:${index}`) % 2001) - 1000) / 1000 * 0.18;
  const distance = baseDistance +
    ((((hashText(`${seed}:distance:${index}`) % 2001) - 1000) / 1000) * jitterMeters);
  const vertical = ((((hashText(`${seed}:vertical:${index}`) % 2001) - 1000) / 1000) * 1200);
  const angle = angleBase + angleJitter;
  return {
    x: Math.cos(angle) * distance,
    y: vertical,
    z: Math.sin(angle) * distance,
  };
}

function isExactClientGeneratedMiningInstance(instance, template = null) {
  if (
    !instance ||
    normalizeLowerText(instance.siteFamily, "") !== "ice" ||
    !instance.runtimeFlags ||
    instance.runtimeFlags.generatedMining !== true
  ) {
    return false;
  }
  const resolvedTemplate = template || dungeonAuthority.getTemplateByID(instance.templateID);
  const populationHints = normalizeObject(resolvedTemplate && resolvedTemplate.populationHints);
  return (
    instance.runtimeFlags.exactClientDungeonContent === true ||
    normalizeObject(instance.spawnState).exactClientDungeonContent === true ||
    normalizeObject(instance.metadata).exactClientDungeonContent === true ||
    populationHints.exactClientContent === true
  );
}

function decorateGeneratedMiningSiteEntity(entity, instance, template = null) {
  if (!entity || !isExactClientGeneratedMiningInstance(instance, template)) {
    return entity;
  }
  const metadata = normalizeObject(instance && instance.metadata);
  const spawnState = normalizeObject(instance && instance.spawnState);
  entity.generatedMiningSite = true;
  entity.generatedMiningSiteKind = "ice";
  entity.generatedMiningSiteIndex = Math.max(
    0,
    toInt(metadata.rawSiteIndex, toInt(spawnState.rawSiteIndex, 0)),
  );
  entity.generatedMiningSiteID = Math.max(
    0,
    toInt(metadata.siteID, toInt(spawnState.siteID, 0)),
  ) || null;
  entity.generatedMiningSiteInstanceID = Math.max(
    0,
    toInt(instance && instance.instanceID, 0),
  ) || null;
  return entity;
}

function isManagedUniverseSiteInstance(instance) {
  return Boolean(
    instance &&
    instance.runtimeFlags &&
    instance.runtimeFlags.universeSeeded === true &&
    (
      instance.runtimeFlags.generatedMining !== true ||
      isExactClientGeneratedMiningInstance(instance)
    ) &&
    (
      instance.runtimeFlags.manualSpawn === true ||
      // Only the two kinds a scene site provider will actually list. "belt" was accepted here
      // alongside the compiler that emitted it (both bd385737); nothing downstream understands
      // it, so letting it through only produced a site registered under sceneSignatureSite and
      // listed by neither provider. Failing the check is the honest outcome.
      normalizeLowerText(instance.siteKind, "signature") === "signature" ||
      normalizeLowerText(instance.siteKind, "signature") === "anomaly"
    ),
  );
}

function isManagedMissionSiteInstance(instance) {
  return Boolean(
    instance &&
    instance.runtimeFlags &&
    instance.runtimeFlags.missionRuntime === true,
  );
}

function isMissionLikeSiteInstance(instance, template = null) {
  const runtimeFlags = normalizeObject(instance && instance.runtimeFlags);
  const metadata = normalizeObject(instance && instance.metadata);
  return (
    runtimeFlags.missionRuntime === true ||
    metadata.missionRuntime === true ||
    normalizeLowerText(instance && instance.siteFamily, "") === "mission" ||
    normalizeLowerText(template && template.siteFamily, "") === "mission"
  );
}

function isManagedMaterializedSiteInstance(instance) {
  return isManagedUniverseSiteInstance(instance) || isManagedMissionSiteInstance(instance);
}

function resolveEntityLabel(instance, template) {
  if (require("../seasons/eventHooks").fw.isSite(instance)) {
    return `${instance.templateID.endsWith(":gallente") ? "Gallente" : "Caldari"} Open Complex Capture Point`;
  }
  const metadata = instance && instance.metadata && typeof instance.metadata === "object"
    ? instance.metadata
    : {};
  const spawnState = instance && instance.spawnState && typeof instance.spawnState === "object"
    ? instance.spawnState
    : {};
  return normalizeText(
    metadata.label,
    normalizeText(
      resolveLocalizedTemplateName(template),
      normalizeText(
      spawnState.label,
      `${resolveSiteFamilyLabel(instance && instance.siteFamily)} Site ${
        Math.max(0, toInt(template && template.sourceDungeonID, 0)) ||
        Math.max(0, toInt(template && template.dungeonNameID, 0)) ||
        Math.max(0, toInt(instance && instance.instanceID, 0))
      }`,
      ),
    ),
  );
}

function buildSiteEntity(instance) {
  if (!isManagedMaterializedSiteInstance(instance)) {
    return null;
  }
  // Universe sites only read their template here (population hints are
  // copied below). Mission templates derive hints that can share their
  // objects, so those keep a private copy.
  const templateView = dungeonAuthority.getTemplateByIDReadOnly(instance.templateID);
  const template = isMissionLikeSiteInstance(instance, templateView)
    ? dungeonAuthority.getTemplateByID(instance.templateID)
    : templateView;
  const siteKind = normalizeLowerText(instance && instance.siteKind, "signature");
  const entryObjectTypeID = Math.max(
    0,
    toInt(
      instance && instance.entryObjectTypeID,
      template && template.entryObjectTypeID,
    ),
  ) || (siteKind === "anomaly" ? COSMIC_ANOMALY_TYPE_ID : COSMIC_SIGNATURE_TYPE_ID);
  const typeRecord = resolveItemByTypeID(entryObjectTypeID) || null;
  const family = normalizeLowerText(instance && instance.siteFamily, "unknown");
  const label = resolveEntityLabel(instance, template);
  const position = clonePosition(instance && instance.position);
  const strengthAttributeID = resolveFallbackStrengthAttribute(family);
  const groupID = siteKind === "anomaly" ? COSMIC_ANOMALY_GROUP_ID : COSMIC_SIGNATURE_GROUP_ID;
  const populationHints = resolvePopulationHints(instance, template);
  const encounterPlans = resolveEncounterPlans(populationHints);

  if (isManagedMissionSiteInstance(instance)) {
    return {
      kind: "missionSite",
      itemID: Math.max(0, toInt(instance && instance.metadata && instance.metadata.siteID, 0)) ||
        Math.max(0, toInt(instance && instance.instanceID, 0)),
      typeID: toInt(typeRecord && typeRecord.typeID, entryObjectTypeID),
      groupID: toInt(typeRecord && typeRecord.groupID, groupID) || groupID,
      categoryID: toInt(typeRecord && typeRecord.categoryID, 16) || 16,
      graphicID: toInt(typeRecord && typeRecord.graphicID, 0) || null,
      ownerID: 1,
      itemName: label,
      slimName: label,
      position,
      velocity: { x: 0, y: 0, z: 0 },
      direction: { x: 1, y: 0, z: 0 },
      radius: Math.max(1_000, toFiniteNumber(typeRecord && typeRecord.radius, 2_000)),
      staticVisibilityScope: "bubble",
      dungeonMaterializedSiteContent: true,
      dungeonSiteInstanceID:
        Math.max(0, toInt(instance && instance.instanceID, 0)) || null,
      dungeonSiteID:
        Math.max(0, toInt(instance && instance.metadata && instance.metadata.siteID, 0)) ||
        Math.max(0, toInt(instance && instance.instanceID, 0)) ||
        null,
      dungeonID: toInt(instance && instance.sourceDungeonID, 0) || null,
      dungeonNameID: toInt(instance && instance.dungeonNameID, 0) || null,
      archetypeID: toInt(instance && instance.archetypeID, 0) || null,
      factionID: toInt(instance && instance.factionID, 0) || null,
      entryObjectTypeID,
      dungeonEncounterPlanCount: encounterPlans.length,
      dungeonLootProfiles: normalizeArray(populationHints && populationHints.lootProfiles),
    };
  }

  const entity = {
    kind: siteKind === "anomaly" ? "universeAnomalySite" : "universeSignatureSite",
    signalTrackerUniverseSeededSite: true,
    signalTrackerSiteKind: siteKind,
    signalTrackerSiteFamily: family,
    signalTrackerSiteTemplateID: normalizeText(instance && instance.templateID, "") || null,
    signalTrackerSiteLabel: label,
    signalTrackerSiteDifficulty: Math.max(1, toInt(instance && instance.difficulty, 1)),
    signalTrackerSiteGroupID: groupID,
    signalTrackerSiteTypeID: toInt(typeRecord && typeRecord.typeID, entryObjectTypeID),
    signalTrackerEntryObjectTypeID: entryObjectTypeID,
    signalTrackerStrengthAttributeID: strengthAttributeID > 0 ? strengthAttributeID : null,
    signalTrackerAllowedTypes: [],
    signalTrackerAnomalySite: siteKind === "anomaly",
    signalTrackerAnomalySiteFamily: siteKind === "anomaly" ? family : undefined,
    signalTrackerSignatureSite: siteKind === "signature",
    signalTrackerSignatureSiteFamily: siteKind === "signature" ? family : undefined,
    dungeonSiteInstanceID: Math.max(0, toInt(instance && instance.instanceID, 0)) || null,
    dungeonSiteID: Math.max(0, toInt(instance && instance.metadata && instance.metadata.siteID, 0)) ||
      Math.max(0, toInt(instance && instance.instanceID, 0)) ||
      null,
    itemID: Math.max(0, toInt(instance && instance.metadata && instance.metadata.siteID, 0)) ||
      Math.max(0, toInt(instance && instance.instanceID, 0)),
    typeID: toInt(typeRecord && typeRecord.typeID, entryObjectTypeID),
    groupID: toInt(typeRecord && typeRecord.groupID, groupID) || groupID,
    categoryID: toInt(typeRecord && typeRecord.categoryID, 16) || 16,
    graphicID: toInt(typeRecord && typeRecord.graphicID, 0) || null,
    ownerID: 1,
    itemName: label,
    slimName: label,
    position,
    velocity: { x: 0, y: 0, z: 0 },
    direction: { x: 1, y: 0, z: 0 },
    radius: Math.max(1_000, toFiniteNumber(typeRecord && typeRecord.radius, 2_000)),
    staticVisibilityScope: "bubble",
    dungeonID: toInt(instance && instance.sourceDungeonID, 0) || null,
    dungeonNameID: toInt(instance && instance.dungeonNameID, 0) || null,
    archetypeID: toInt(instance && instance.archetypeID, 0) || null,
    factionID: toInt(instance && instance.factionID, 0) || null,
    entryObjectTypeID,
    dungeonEncounterPlanCount: encounterPlans.length,
    dungeonLootProfiles: normalizeArray(populationHints && populationHints.lootProfiles),
  };
  if (isExactClientGeneratedMiningInstance(instance, template)) {
    decorateGeneratedMiningSiteEntity(entity, instance, template);
    entity.generatedMiningSiteAnchor = true;
  }
  return entity;
}

function buildStableUniverseSiteEntitySignature(entity) {
  if (!entity || typeof entity !== "object") {
    return "";
  }
  return JSON.stringify({
    kind: normalizeText(entity.kind, ""),
    signalTrackerUniverseSeededSite: entity.signalTrackerUniverseSeededSite === true,
    signalTrackerSiteKind: normalizeLowerText(entity.signalTrackerSiteKind, ""),
    signalTrackerSiteFamily: normalizeLowerText(entity.signalTrackerSiteFamily, ""),
    signalTrackerSiteTemplateID: normalizeText(entity.signalTrackerSiteTemplateID, ""),
    signalTrackerSiteLabel: normalizeText(entity.signalTrackerSiteLabel, ""),
    signalTrackerSiteDifficulty: Math.max(1, toInt(entity.signalTrackerSiteDifficulty, 1)),
    signalTrackerSiteGroupID: Math.max(0, toInt(entity.signalTrackerSiteGroupID, 0)),
    signalTrackerSiteTypeID: Math.max(0, toInt(entity.signalTrackerSiteTypeID, 0)),
    signalTrackerEntryObjectTypeID: Math.max(0, toInt(entity.signalTrackerEntryObjectTypeID, 0)),
    signalTrackerStrengthAttributeID: Math.max(0, toInt(entity.signalTrackerStrengthAttributeID, 0)) || null,
    signalTrackerAllowedTypes: normalizeArray(entity.signalTrackerAllowedTypes),
    signalTrackerAnomalySite: entity.signalTrackerAnomalySite === true,
    signalTrackerAnomalySiteFamily: normalizeLowerText(entity.signalTrackerAnomalySiteFamily, ""),
    signalTrackerSignatureSite: entity.signalTrackerSignatureSite === true,
    signalTrackerSignatureSiteFamily: normalizeLowerText(entity.signalTrackerSignatureSiteFamily, ""),
    itemID: Math.max(0, toInt(entity.itemID, 0)),
    typeID: Math.max(0, toInt(entity.typeID, 0)),
    groupID: Math.max(0, toInt(entity.groupID, 0)),
    categoryID: Math.max(0, toInt(entity.categoryID, 0)),
    graphicID: Math.max(0, toInt(entity.graphicID, 0)) || null,
    ownerID: Math.max(0, toInt(entity.ownerID, 0)),
    itemName: normalizeText(entity.itemName, ""),
    slimName: normalizeText(entity.slimName, ""),
    position: clonePosition(entity.position),
    velocity: clonePosition(entity.velocity),
    direction: clonePosition(entity.direction),
    radius: Math.max(0, toFiniteNumber(entity.radius, 0)),
    staticVisibilityScope: normalizeLowerText(entity.staticVisibilityScope, ""),
    dungeonMaterializedSiteContent:
      entity.dungeonMaterializedSiteContent === true,
    dungeonSiteInstanceID:
      Math.max(0, toInt(entity.dungeonSiteInstanceID, 0)) || null,
    dungeonSiteID: Math.max(0, toInt(entity.dungeonSiteID, 0)) || null,
    dungeonID: Math.max(0, toInt(entity.dungeonID, 0)) || null,
    dungeonNameID: Math.max(0, toInt(entity.dungeonNameID, 0)) || null,
    archetypeID: Math.max(0, toInt(entity.archetypeID, 0)) || null,
    factionID: Math.max(0, toInt(entity.factionID, 0)) || null,
    entryObjectTypeID: Math.max(0, toInt(entity.entryObjectTypeID, 0)) || null,
    dungeonEncounterPlanCount: Math.max(0, toInt(entity.dungeonEncounterPlanCount, 0)),
    dungeonLootProfiles: normalizeArray(entity.dungeonLootProfiles),
  });
}

function listMaterializedUniverseSiteEntities(scene) {
  return (Array.isArray(scene && scene.staticEntities) ? scene.staticEntities : [])
    .filter((entity) => entity && entity.signalTrackerUniverseSeededSite === true);
}

function ensureSceneMaterializedSiteSet(scene) {
  if (!scene) {
    return new Set();
  }
  if (!(scene._dungeonUniverseMaterializedSiteIDs instanceof Set)) {
    scene._dungeonUniverseMaterializedSiteIDs = new Set();
  }
  return scene._dungeonUniverseMaterializedSiteIDs;
}

function ensureSceneMaterializedSiteInstanceMap(scene) {
  if (!scene) {
    return new Map();
  }
  if (!(scene._dungeonUniverseMaterializedInstanceIDsBySiteID instanceof Map)) {
    scene._dungeonUniverseMaterializedInstanceIDsBySiteID = new Map();
  }
  return scene._dungeonUniverseMaterializedInstanceIDsBySiteID;
}

function markSceneSiteMaterialized(scene, siteID, instanceID = null) {
  const numericSiteID = Math.max(0, toInt(siteID, 0));
  if (numericSiteID <= 0 || !scene) {
    return false;
  }
  ensureSceneMaterializedSiteSet(scene).add(numericSiteID);
  const numericInstanceID = Math.max(0, toInt(instanceID, 0));
  if (numericInstanceID > 0) {
    ensureSceneMaterializedSiteInstanceMap(scene).set(numericSiteID, numericInstanceID);
  }
  return true;
}

function unmarkSceneSiteMaterialized(scene, siteID) {
  const numericSiteID = Math.max(0, toInt(siteID, 0));
  if (numericSiteID <= 0 || !scene) {
    return false;
  }
  ensureSceneMaterializedSiteInstanceMap(scene).delete(numericSiteID);
  return ensureSceneMaterializedSiteSet(scene).delete(numericSiteID);
}

function isSceneSiteMaterialized(scene, siteID) {
  const numericSiteID = Math.max(0, toInt(siteID, 0));
  if (numericSiteID <= 0 || !scene) {
    return false;
  }
  return ensureSceneMaterializedSiteSet(scene).has(numericSiteID);
}

function isActiveLifecycleState(value) {
  const normalized = normalizeLowerText(value, "");
  return normalized === "seeded" || normalized === "active" || normalized === "paused";
}

function isActiveManagedMaterializedSiteInstance(instance) {
  return isManagedMaterializedSiteInstance(instance) && isActiveLifecycleState(instance.lifecycleState);
}

function resolveManagedUniverseSiteInstance(scene, instanceOrSite, options = {}) {
  const systemID = Math.max(0, toInt(options.systemID, toInt(scene && scene.systemID, 0)));
  if (systemID <= 0) {
    return null;
  }

  if (instanceOrSite && typeof instanceOrSite === "object") {
    const candidateInstanceID = Math.max(0, toInt(instanceOrSite.instanceID, 0));
    if (candidateInstanceID > 0) {
      const directInstance = dungeonRuntime.getInstance(candidateInstanceID);
      if (
        directInstance &&
        isManagedMaterializedSiteInstance(directInstance) &&
        Math.max(0, toInt(directInstance.solarSystemID, 0)) === systemID
      ) {
        return directInstance;
      }
    }
    if (isManagedMaterializedSiteInstance(instanceOrSite)) {
      const candidateSystemID = Math.max(0, toInt(instanceOrSite.solarSystemID, 0));
      if (!candidateSystemID || candidateSystemID === systemID) {
        return instanceOrSite;
      }
    }
  }

  const numericSiteID = Math.max(
    0,
    toInt(
      options.siteID,
      instanceOrSite && (
        instanceOrSite.siteID ||
        instanceOrSite.itemID ||
        (instanceOrSite.metadata && instanceOrSite.metadata.siteID)
      ),
    ),
  );
  if (numericSiteID <= 0) {
    return null;
  }

  const trackedInstanceID = Math.max(
    0,
    toInt(ensureSceneMaterializedSiteInstanceMap(scene).get(numericSiteID), 0),
  );
  if (trackedInstanceID > 0) {
    const trackedInstance = dungeonRuntime.getInstance(trackedInstanceID);
    if (
      trackedInstance &&
      isManagedMaterializedSiteInstance(trackedInstance) &&
      Math.max(0, toInt(trackedInstance && trackedInstance.solarSystemID, 0)) === systemID
    ) {
      return trackedInstance;
    }
    ensureSceneMaterializedSiteInstanceMap(scene).delete(numericSiteID);
  }

  return dungeonRuntime.listActiveInstancesBySystem(systemID, {
    full: true,
  }).find((instance) => (
    isManagedMaterializedSiteInstance(instance) &&
    Math.max(0, toInt(instance && instance.metadata && instance.metadata.siteID, 0)) === numericSiteID
  )) || null;
}

function listMaterializedUniverseSiteContentEntities(scene, options = {}) {
  const numericSiteID = Math.max(0, toInt(options.siteID, 0));
  const numericInstanceID = Math.max(0, toInt(options.instanceID, 0));
  const staticEntities = Array.isArray(scene && scene.staticEntities) ? scene.staticEntities : [];
  const dynamicEntities = scene && scene.dynamicEntities instanceof Map
    ? [...scene.dynamicEntities.values()]
    : [];
  return [...staticEntities, ...dynamicEntities]
    .filter((entity) => entity && entity.dungeonMaterializedSiteContent === true)
    .filter((entity) => (
      (!numericSiteID || toInt(entity && entity.dungeonSiteID, 0) === numericSiteID) &&
      (!numericInstanceID || toInt(entity && entity.dungeonSiteInstanceID, 0) === numericInstanceID) &&
      (!numericSiteID || toInt(entity && entity.itemID, 0) !== numericSiteID)
    ));
}

function listMaterializedUniverseSiteStaticContentEntities(scene, options = {}) {
  return listMaterializedUniverseSiteContentEntities(scene, options)
    .filter((entity) => (
      entity &&
      scene &&
      scene.staticEntitiesByID instanceof Map &&
      scene.staticEntitiesByID.has(toInt(entity && entity.itemID, 0))
    ));
}

function getContentEntityRefsByKey(instance) {
  return normalizeObject(
    instance &&
    instance.spawnState &&
    instance.spawnState.contentEntityRefsByKey,
  );
}

function upsertContentEntityRef(instanceID, contentKey, patch = {}, options = {}) {
  const normalizedContentKey = normalizeText(contentKey, "");
  if (!normalizedContentKey) {
    return null;
  }
  const existing = dungeonRuntime.getInstance(instanceID);
  if (!existing) {
    return null;
  }
  const contentEntityRefsByKey = getContentEntityRefsByKey(existing);
  return dungeonRuntime.mergeSpawnState(instanceID, {
    contentEntityRefsByKey: {
      ...contentEntityRefsByKey,
      [normalizedContentKey]: {
        ...normalizeObject(contentEntityRefsByKey[normalizedContentKey]),
        ...(patch && typeof patch === "object" ? cloneValue(patch) : {}),
        contentKey: normalizedContentKey,
      },
    },
  }, options);
}

function annotateMaterializedContainerEntity(entity, containerEntity) {
  if (!entity || !containerEntity) {
    return entity;
  }
  if (containerEntity.homefrontKey) {
    entity.homefrontKey = containerEntity.homefrontKey;
    entity.homefrontRole = containerEntity.homefrontRole;
    if (entity.homefrontRole === "salvage") entity.kind = "wreck";
  }
  entity.dungeonMaterializedSiteContent = true;
  entity.dungeonMaterializedContainer = true;
  entity.dungeonSiteID = toInt(containerEntity && containerEntity.dungeonSiteID, 0);
  entity.dungeonSiteInstanceID = toInt(containerEntity && containerEntity.dungeonSiteInstanceID, 0);
  entity.dungeonSiteContentKey = normalizeText(containerEntity && containerEntity.dungeonSiteContentKey, "");
  entity.dungeonSiteContentRole = normalizeLowerText(containerEntity && containerEntity.dungeonSiteContentRole, "container");
  entity.dungeonSiteContentAnalyzer = normalizeLowerText(containerEntity && containerEntity.dungeonSiteContentAnalyzer, "") || null;
  entity.dungeonSiteContentBonus = containerEntity && containerEntity.dungeonSiteContentBonus === true;
  entity.dungeonSiteContentFailureExplodes = containerEntity && containerEntity.dungeonSiteContentFailureExplodes === true;
  entity.dungeonSiteContentFailureNeverDestroys = containerEntity.dungeonSiteContentFailureNeverDestroys === true;
  entity.dungeonSiteContentFailureLocksOut = containerEntity.dungeonSiteContentFailureLocksOut === true;
  entity.dungeonSiteContentCompletesSiteOnHack = containerEntity.dungeonSiteContentCompletesSiteOnHack === true;
  entity.dungeonSiteContentPersistsAfterResponse = containerEntity && containerEntity.dungeonSiteContentPersistsAfterResponse === true;
  entity.dungeonSiteContentTrigger = normalizeLowerText(containerEntity && containerEntity.dungeonSiteContentTrigger, "") || null;
  entity.dungeonSiteContentLootProfile = normalizeText(containerEntity && containerEntity.dungeonSiteContentLootProfile, "") || null;
  entity.dungeonSiteContentExplicitLoot = Array.isArray(containerEntity && containerEntity.dungeonSiteContentExplicitLoot)
    ? cloneValue(containerEntity.dungeonSiteContentExplicitLoot)
    : null;
  entity.dungeonSiteContentLootTags = cloneValue(containerEntity && containerEntity.dungeonSiteContentLootTags) || [];
  entity.dungeonSiteContentHackingDifficulty = normalizeLowerText(containerEntity && containerEntity.dungeonSiteContentHackingDifficulty, "") || null;
  entity.dungeonSourceObjectID = toInt(containerEntity && containerEntity.dungeonSourceObjectID, 0) || null;
  entity.dunObjectID = entity.dungeonSourceObjectID || undefined;
  entity.dungeonLootEntryCount = listContainerItems(null, entity.itemID).length;
  if (containerEntity.generatedMiningSite === true) {
    entity.generatedMiningSite = true;
    entity.generatedMiningSiteKind = normalizeLowerText(
      containerEntity.generatedMiningSiteKind,
      "ice",
    );
    entity.generatedMiningSiteIndex = Math.max(
      0,
      toInt(containerEntity.generatedMiningSiteIndex, 0),
    );
    entity.generatedMiningSiteID = Math.max(
      0,
      toInt(containerEntity.generatedMiningSiteID, 0),
    ) || null;
    entity.generatedMiningSiteInstanceID = Math.max(
      0,
      toInt(containerEntity.generatedMiningSiteInstanceID, 0),
    ) || null;
  }
  return entity;
}

function destroyMaterializedContentEntity(scene, entity, options = {}) {
  // A resolved cache must stay gone across scene unloads and restarts. Keeping
  // this durable barrier before removal also covers failed hacks and ghost
  // timers. A failed removal can retry; removed inventory cannot regenerate.
  if (isDataRelicMaterializedContainer(entity)) {
    try {
      const committed = upsertContentEntityRef(entity.dungeonSiteInstanceID, entity.dungeonSiteContentKey, {
        itemID: entity.itemID,
        resolvedAtMs: Math.max(1, toInt(options.nowMs, Date.now())),
      }, { ...options, durable: true, force: true });
      if (!committed) return { success: false, errorMsg: "CONTAINER_RESOLUTION_COMMIT_FAILED" };
    } catch (error) {
      return { success: false, errorMsg: "CONTAINER_RESOLUTION_COMMIT_FAILED", cause: error.message };
    }
  }
  return removeMaterializedContentEntity(scene, entity, options);
}

function removeMaterializedContentEntity(scene, entity, options = {}) {
  if (!scene || !entity) {
    return {
      success: false,
      errorMsg: "ENTITY_NOT_FOUND",
    };
  }
  const spaceRuntime = getSpaceRuntime();
  if (entity.nativeNpc === true) {
    const npcSpawnService = getNpcSpawnService();
    const liveDestroyResult =
      typeof npcSpawnService.destroyNpcControllerByEntityID === "function"
        ? npcSpawnService.destroyNpcControllerByEntityID(entity.itemID, options)
        : null;
    if (liveDestroyResult && liveDestroyResult.success === true) {
      return liveDestroyResult;
    }
    return getNativeNpcService().destroyNativeNpcController(
      {
        entityID: entity.itemID,
        systemID: scene.systemID,
        runtimeKind: "nativeCombat",
      },
      options,
    );
  }
  if (entity.nativeNpcWreck === true) {
    return getNativeNpcWreckService().destroyNativeWreck(entity.itemID, {
      systemID: scene.systemID,
      ...options,
    });
  }
  if (entity.dungeonMaterializedContainer === true && scene.dynamicEntities instanceof Map && scene.dynamicEntities.has(Number(entity.itemID))) {
    return spaceRuntime.destroyDynamicInventoryEntity(scene.systemID, entity.itemID, {
      removeContents: true,
      ...options,
    });
  }
  if (entity.dungeonMaterializedContainer === true && findItemById(Number(entity.itemID))) {
    return removeInventoryItem(Number(entity.itemID), {
      removeContents: true,
    });
  }
  if (
    scene.dynamicEntities instanceof Map &&
    scene.dynamicEntities.has(Number(entity.itemID))
  ) {
    if (findItemById(Number(entity.itemID))) {
      return spaceRuntime.destroyDynamicInventoryEntity(
        scene.systemID,
        entity.itemID,
        {
          removeContents: true,
          ...options,
        },
      );
    }
    return spaceRuntime.removeDynamicEntity(scene.systemID, entity.itemID, {
      allowSessionOwned: true,
      ...options,
    });
  }
  return scene.removeStaticEntity(toInt(entity && entity.itemID, 0), {
    broadcast: options.broadcast === true,
    excludedSession: options.excludedSession || null,
    nowMs: options.nowMs,
  });
}

// What mining has left in each rock this site placed, keyed by rock item ID. The mining runtime saves it
// on every mining cycle, because a dungeon rock keeps no mining row of its own. A rock with no entry has
// not been mined. Generated ice keeps its own record in spawnState.members instead.
function readRecordedMiningRockRemainders(instance) {
  const recorded = instance && instance.spawnState && instance.spawnState.miningRockRemainingByID;
  return recorded && typeof recorded === "object" && !Array.isArray(recorded) ? recorded : {};
}

function readRecordedMiningRockRemainder(recordedRemainders, entityID) {
  const key = String(Math.max(0, toInt(entityID, 0)));
  return Object.prototype.hasOwnProperty.call(recordedRemainders, key)
    ? Math.max(0, toInt(recordedRemainders[key], 0))
    : null;
}

// Mining missions (Plan C): build the special mineable asteroids declared by a template's
// populationHints.miningRocks ([{ typeID/oreTypeID/objectiveTypeID, count, quantity }]). They are
// kind:"asteroid" entities (so the existing mining systems target them); materializeSiteContents
// registers each one's ore quantity in miningRuntimeState. Gated on miningRocks, so combat sites
// are unaffected.
// Fit a site's declared rock rows into `cap` rocks by largest-remainder (Hamilton)
// apportionment, returning the per-row counts.
//
// The cap used to be applied by slice() over the row-ordered concatenation, which kept the
// leading rows whole and dropped every later row outright. eve-university:Shattered_Ice_Field
// declares 206 rocks across 8 ice types and takes the 64 cap (it is not exact client content),
// so it materialised Blue Ice, Clear Icicle and part of Dark Glitter, and silently lost the
// other five types -- including Glare Crust, its largest deposit at 45 rocks, purely because of
// where it sits in declaration order. A site advertised as a mixed deposit became a three-ore one.
//
// Every row carrying rocks keeps at least one, so the resource MIX survives a cap its volume
// cannot. At or under the cap the counts come back untouched, so an ordinary site still builds
// exactly the rocks it always did.
function apportionMiningRockCounts(counts, cap) {
  const total = counts.reduce((sum, count) => sum + count, 0);
  if (cap <= 0 || total <= cap) {
    return counts;
  }
  const eligible = counts.filter((count) => count > 0).length;
  if (eligible > cap) {
    // More rows than the cap can seat: keep one rock each for as many rows as fit.
    let remaining = cap;
    return counts.map((count) => {
      if (count <= 0 || remaining <= 0) return 0;
      remaining -= 1;
      return 1;
    });
  }
  // One rock reserved per row, the rest shared out in proportion, largest remainder first.
  const shareable = cap - eligible;
  const exact = counts.map((count) => (count > 0 ? ((count - 1) / (total - eligible)) * shareable : 0));
  const allocated = counts.map((count, index) => (count > 0 ? 1 + Math.floor(exact[index]) : 0));
  let leftover = cap - allocated.reduce((sum, count) => sum + count, 0);
  const order = counts
    .map((count, index) => ({ index, remainder: count > 0 ? exact[index] - Math.floor(exact[index]) : -1 }))
    .filter((entry) => entry.remainder >= 0)
    .sort((left, right) => right.remainder - left.remainder);
  for (let i = 0; leftover > 0 && order.length > 0; i += 1) {
    allocated[order[i % order.length].index] += 1;
    leftover -= 1;
  }
  return allocated;
}

function resolveMiningRockCounts(instance, populationHints) {
  const counts = populationHints.miningRocks
    .filter((rock) => rock && typeof rock === "object")
    .map((rock) => (
      Math.max(0, toInt(rock.typeID || rock.oreTypeID || rock.objectiveTypeID, 0)) > 0
        ? Math.max(0, toInt(rock.count, 1))
        : 0
    ));
  const cap = resolveMiningRockLimit(populationHints);
  if (toInt(instance && instance.spawnState && instance.spawnState.miningRockAllocationVersion, 0) >= 1) {
    return apportionMiningRockCounts(counts, cap);
  }

  // Saved depletion uses flattened ordinal IDs. Changing an existing site's
  // allocation would apply one ore's depletion to a different ore after reload.
  // Even an unmined legacy site keeps its layout; no depletion map is required.
  let remaining = cap;
  return counts.map((count) => {
    const allocated = Math.min(count, remaining);
    remaining -= allocated;
    return allocated;
  });
}

function buildMiningRockEntities(instance, siteEntity, populationHints) {
  if (!populationHints || !Array.isArray(populationHints.miningRocks)) {
    return [];
  }
  const siteID = Math.max(0, toInt(siteEntity && siteEntity.itemID, 0));
  const instanceID = Math.max(0, toInt(instance && instance.instanceID, 0));
  const exactClientContent = populationHints.exactClientContent === true;
  const exactGeneratedIce = exactClientContent &&
    isExactClientGeneratedMiningInstance(instance);
  const recordedRemainders = exactGeneratedIce ? {} : readRecordedMiningRockRemainders(instance);
  const generatedMembers = exactGeneratedIce &&
    instance && instance.spawnState && Array.isArray(instance.spawnState.members)
    ? instance.spawnState.members
    : [];
  const generatedMembersBySourceObjectID = new Map(
    generatedMembers
      .map((member) => [
        Math.max(0, toInt(member && member.sourceObjectID, 0)),
        member,
      ])
      .filter(([sourceObjectID]) => sourceObjectID > 0),
  );
  const defaultYieldKind = normalizeLowerText(
    populationHints.resourceYieldKind || populationHints.resourceFamily || populationHints.siteFamily,
    "ore",
  );
  const apportionedRockCounts = resolveMiningRockCounts(instance, populationHints);
  const rockSpecs = populationHints.miningRocks
    .filter((rock) => rock && typeof rock === "object")
    .flatMap((rock, rockRowIndex) => {
      const count = Math.max(0, toInt(apportionedRockCounts[rockRowIndex], 0));
      const oreTypeID = Math.max(0, toInt(rock.typeID || rock.oreTypeID || rock.objectiveTypeID, 0));
      const rawQuantity = rock.quantity ?? rock.remainingQuantity ?? rock.quantityPerRock;
      const quantity = exactClientContent
        ? Math.max(0, toFiniteNumber(rawQuantity, 0))
        : Math.max(1, toInt(rawQuantity, 1_000));
      const yieldKind = normalizeLowerText(rock.yieldKind, defaultYieldKind);
      // Honor an explicit per-rock positionOffset (log-sourced exact retail placement, e.g. the single
      // special mission asteroid); absent it, the rock is placed procedurally in a ring (the fallback).
      const positionOffset = (rock.positionOffset && typeof rock.positionOffset === "object")
        ? rock.positionOffset
        : null;
      // Exact dungeon-object id from the TQ log (so the client renders the ore-type asteroid as a dungeon
      // object instead of crashing on a modelless stand-alone asteroid). Only the first rock carries it.
      const dunObjectID = Math.max(0, toInt(rock.dunObjectID, 0));
      const sourceObjectID = Math.max(
        0,
        toInt(rock.objectID || rock.sourceObjectID || rock.dunObjectID, 0),
      );
      const generatedMember = generatedMembersBySourceObjectID.get(sourceObjectID) || null;
      const dunRotation = Array.isArray(rock.dunRotation) && rock.dunRotation.length === 3
        ? rock.dunRotation.map((value) => toFiniteNumber(value, 0))
        : null;
      return Array.from({ length: count }, (_unused, index) => ({
        oreTypeID,
        quantity,
        yieldKind,
        ordinal: index + 1,
        positionOffset,
        dunObjectID: index === 0 ? dunObjectID : 0,
        sourceObjectID: index === 0 ? sourceObjectID : 0,
        generatedMember: index === 0 ? generatedMember : null,
        dunRotation: index === 0 ? dunRotation : null,
        dunObjectNameID: Object.prototype.hasOwnProperty.call(rock, "dunObjectNameID")
          ? Math.max(0, toInt(rock.dunObjectNameID, 0)) || null
          : null,
        nameID: Object.prototype.hasOwnProperty.call(rock, "nameID")
          ? Math.max(0, toInt(rock.nameID, 0)) || null
          : null,
        objectiveTargetGroup: Object.prototype.hasOwnProperty.call(rock, "objectiveTargetGroup")
          ? normalizeSlimNullableValue(rock.objectiveTargetGroup)
          : null,
      }));
    })
    .filter((rock) => rock.oreTypeID > 0);
  const total = rockSpecs.length;
  if (total <= 0) {
    return [];
  }
  return rockSpecs.map((rock, index) => {
    const oreRecord = resolveItemByTypeID(rock.oreTypeID) || {};
    const generatedMember = rock.generatedMember && typeof rock.generatedMember === "object"
      ? rock.generatedMember
      : null;
    const itemID = Math.max(0, toInt(generatedMember && generatedMember.entityID, 0)) ||
      buildSiteContentItemID(SITE_CONTENT_MINING_ROCK_ID_BASE, siteID, 1_000, index + 1);
    // A rock mined out before this load stays gone. It still counts toward the placement below, so
    // the rocks that remain keep their positions.
    const recordedRemaining = readRecordedMiningRockRemainder(recordedRemainders, itemID);
    if (recordedRemaining !== null && recordedRemaining <= 0) {
      return null;
    }
    // RENDER SPLIT (mirrors belt asteroids in buildSystemOreAsteroidEntity - the only asteroid spawn proven
    // to render without crashing): the in-space BALL must present a renderable asteroid SHELL (real 3D
    // model + graphicID). The mission ore (Banidine 28617 etc.) is categoryID 25 with graphicID 0 and NO
    // model - putting it in the ball makes the retail client crash ON APPROACH inside _trinity_dx11
    // (INTEGER DIVIDE BY ZERO building a modelless asteroid). So the shell goes in typeID/groupID/
    // categoryID/graphicID; the ORE rides only in slim*/miningYield* (overview + mining still show the ore,
    // matching the golden slimItem). Log-authored owner/objective fields keep the golden dungeon-object identity.
    const shellTypeID = MINING_ROCK_SHELL_TYPE_IDS[
      (Math.abs(toInt(rock.oreTypeID, 0)) + index) % MINING_ROCK_SHELL_TYPE_IDS.length
    ];
    const shellRecord = resolveItemByTypeID(shellTypeID) || {};
    const shellGraphicID = toInt(shellRecord.graphicID, 0) || null;
    const dunObjectID = Math.max(0, toInt(rock.dunObjectID, 0)) ||
      (800000 + (siteID % 100000) + index + 1);
    const contentOffset = (rock.positionOffset && typeof rock.positionOffset === "object")
      ? clonePosition(rock.positionOffset)
      : buildContentOffset(`${siteID}:miningrock`, index, total, {
        baseDistanceMeters: SITE_CONTENT_CONTAINER_RING_METERS,
        jitterMeters: 6_000,
      });
    return decorateGeneratedMiningSiteEntity({
      kind: "asteroid",
      dungeonMaterializedSiteContent: true,
      dungeonMaterializedMiningRock: true,
      dungeonSiteID: siteID,
      dungeonSiteInstanceID: instanceID,
      dungeonSiteContentKey: rock.sourceObjectID > 0
        ? `mining_rock:client_object:${rock.sourceObjectID}`
        : `mining_rock:${rock.oreTypeID}:${rock.ordinal}`,
      dungeonSourceObjectID: rock.sourceObjectID || null,
      itemID,
      // Renderable SHELL in the ball fields (has a model/graphicID -> trinity can build it).
      typeID: toInt(shellRecord.typeID, shellTypeID) || shellTypeID,
      groupID: toInt(shellRecord.groupID, 0) || null,
      categoryID: toInt(shellRecord.categoryID, SITE_CONTENT_SAFE_SLIM_CATEGORY_ID) || SITE_CONTENT_SAFE_SLIM_CATEGORY_ID,
      graphicID: shellGraphicID,
      visualTypeID: toInt(shellRecord.typeID, shellTypeID) || shellTypeID,
      // The ORE type only in slim*/miningYield* -> overview + mining read the ore, golden slimItem match.
      slimTypeID: rock.oreTypeID,
      slimGroupID: toInt(oreRecord.groupID, 0) || null,
      slimCategoryID: toInt(oreRecord.categoryID, 25) || 25,
      slimGraphicID: null,
      suppressSlimGraphicID: true,
      suppressSlimName: true,
      // Rocks are world resources.  The mission/site system creates them, but
      // neither the template nor a mission owner may make one player own them.
      ownerID: SITE_CONTENT_OWNER_ID,
      dunObjectID,
      dunObjectNameID: Math.max(0, toInt(rock.dunObjectNameID, 0)) || null,
      nameID: Math.max(0, toInt(rock.nameID, 0)) || undefined,
      objectiveTargetGroup: normalizeSlimNullableValue(rock.objectiveTargetGroup),
      dunPosition: [contentOffset.x, contentOffset.y, contentOffset.z],
      dunRotation: Array.isArray(rock.dunRotation) ? rock.dunRotation : undefined,
      itemName: "",
      slimName: "",
      miningYieldTypeID: rock.oreTypeID,
      miningYieldKind: rock.yieldKind,
      miningRemainingQuantity: exactGeneratedIce && generatedMember
        ? Math.max(0, toFiniteNumber(generatedMember.remainingQuantity, rock.quantity))
        : (recordedRemaining === null ? rock.quantity : Math.min(rock.quantity, recordedRemaining)),
      miningOriginalQuantity: exactGeneratedIce && generatedMember
        ? Math.max(0, toFiniteNumber(generatedMember.originalQuantity, rock.quantity))
        : rock.quantity,
      miningUnitVolume: Math.max(0.000001, toFiniteNumber(oreRecord.volume, 1)),
      position: addVectors(clonePosition(siteEntity && siteEntity.position), contentOffset),
      velocity: { x: 0, y: 0, z: 0 },
      direction: { x: 1, y: 0, z: 0 },
      radius: Math.max(500, toFiniteNumber(shellRecord.radius, toFiniteNumber(oreRecord.radius, 0))) || 900,
      staticVisibilityScope: "bubble",
    }, instance);
  }).filter(Boolean);
}

function listMiningObjectiveRockDescriptors(instance, populationHints) {
  const siteID = Math.max(
    0,
    toInt(
      instance && instance.metadata && instance.metadata.siteID,
      instance && instance.siteID,
    ),
  );
  if (!siteID || !populationHints || !Array.isArray(populationHints.miningRocks)) {
    return [];
  }
  const exactClientContent = populationHints.exactClientContent === true;
  const apportionedRockCounts = resolveMiningRockCounts(instance, populationHints);
  const rockSpecs = populationHints.miningRocks
    .filter((rock) => rock && typeof rock === "object")
    .flatMap((rock, rockRowIndex) => {
      const count = Math.max(0, toInt(apportionedRockCounts[rockRowIndex], 0));
      const oreTypeID = Math.max(0, toInt(rock.typeID || rock.oreTypeID || rock.objectiveTypeID, 0));
      const rawQuantity = rock.quantity ?? rock.remainingQuantity ?? rock.quantityPerRock;
      const quantity = exactClientContent
        ? Math.max(0, toFiniteNumber(rawQuantity, 0))
        : Math.max(1, toInt(rawQuantity, 1_000));
      return Array.from({ length: count }, () => ({
        oreTypeID,
        quantity,
      }));
    })
    .filter((rock) => rock.oreTypeID > 0);
  return rockSpecs.map((rock, index) => ({
    ...rock,
    entityID: buildSiteContentItemID(SITE_CONTENT_MINING_ROCK_ID_BASE, siteID, 1_000, index + 1),
  }));
}

function buildContainerEntities(instance, siteEntity, populationHints, template = null) {
  const frozen = instance?.spawnState?.hackingContainerLayout;
  if (frozen?.version === 1 && Array.isArray(frozen.entities)) {
    return cloneValue(frozen.entities);
  }
  template ||= instance?.templateID ? dungeonAuthority.getTemplateByID(instance.templateID) : null;
  const legacy = populationHints?.hackingLayoutVersion === 0;
  if (!legacy) populationHints = applyEnvPromotedContainerSpecs(populationHints, template);
  if (!populationHints || !Array.isArray(populationHints.containers)) {
    return [];
  }
  const containerLimit =
    populationHints.homefront === true ? 32 : SITE_CONTENT_MAX_CONTAINER_COUNT;
  const siteID = Math.max(0, toInt(siteEntity && siteEntity.itemID, 0));
  const instanceID = Math.max(0, toInt(instance && instance.instanceID, 0));
  const fallbackContext = resolveTemplateCanFallbackContext(template, populationHints);
  const containerSpecs = populationHints.containers
    .filter((container) => container && typeof container === "object")
    .flatMap((container) => {
      const count = Math.max(
        0,
        Math.min(
          containerLimit,
          toInt(container && container.count, 0),
        ),
      );
      return Array.from({ length: count }, (_, index) => ({
        role: normalizeLowerText(container && container.role, "container"),
        analyzer: normalizeLowerText(container && container.analyzer, "") || null,
        typeID: Math.max(0, toInt(container && container.typeID, 0)) || null,
        typeNameCandidates: normalizeArray(container && container.typeNameCandidates),
        label: normalizeText(container && container.label, "") || null,
        contentKey: normalizeText(container && container.contentKey, "") || null,
        // Exact client content places each container itself; generated content is laid out below.
        positionOffset: container && container.positionOffset && typeof container.positionOffset === "object"
          ? clonePosition(container.positionOffset)
          : null,
        dunObjectID: Math.max(0, toInt(container && (container.dunObjectID ?? container.objectID), 0)) || null,
        bonus: container && container.bonus === true,
        persistsAfterResponse: container && container.persistsAfterResponse === true,
        failureExplodes: container && container.failureExplodes === true,
        failureNeverDestroys: container && container.failureNeverDestroys === true,
        failureLocksOut: container && container.failureLocksOut === true,
        completesSiteOnHack: container && container.completesSiteOnHack === true,
        wormholeClassID: toInt(container && container.wormholeClassID, 0) || null,
        trigger: normalizeLowerText(container && container.trigger, "") || null,
        lootProfile: normalizeText(container && container.lootProfile, "") || null,
        lootTags: normalizeArray(container && container.lootTags)
          .map((tag) => normalizeLowerText(tag, ""))
          .filter(Boolean),
        hackingDifficulty: container && container.hackingDifficulty != null ? container.hackingDifficulty : null,
        explicitLoot: normalizeArray(container && container.explicitLoot)
          .map((entry) => ({
            ...cloneValue(entry),
            typeID: Math.max(0, toInt(entry && entry.typeID, 0)),
            quantity: Math.max(1, toInt(entry && entry.quantity, 1)),
          }))
          .filter((entry) => entry.typeID > 0),
        ordinal: index + 1,
      }));
    })
    .slice(0, containerLimit);
  const total = containerSpecs.length;
  if (total <= 0) {
    return [];
  }

  return containerSpecs.map((container, index) => {
    const typeRecord = resolveContainerTypeRecord(container, {
      legacy,
      fallbackTypeNames: legacy ? [] : resolveContainerRoleFallbackTypeNames(container, fallbackContext),
    });
    const displayName = resolveContainerDisplayName(container, typeRecord, container.ordinal);
    const contentKey = normalizeText(
      container.contentKey || (container.dunObjectID
        ? `container:${container.role}:object${container.dunObjectID}:${displayName}`
        : `container:${container.role}:${container.ordinal}:${displayName}`),
      `container:${index + 1}`,
    ).toLowerCase();
    return {
      kind: "container",
      dungeonMaterializedSiteContent: true,
      dungeonMaterializedContainer: true,
      dungeonSiteID: siteID,
      dungeonSiteInstanceID: instanceID,
      dungeonSiteContentKey: contentKey,
      dungeonSiteContentRole: container.role,
      dungeonSiteContentAnalyzer: container.analyzer,
      dungeonSiteContentBonus: container.bonus === true,
      dungeonSiteContentFailureExplodes: container.failureExplodes === true,
      dungeonSiteContentFailureNeverDestroys: container.failureNeverDestroys === true,
      dungeonSiteContentFailureLocksOut: container.failureLocksOut === true,
      dungeonSiteContentCompletesSiteOnHack: container.completesSiteOnHack === true,
      dungeonSiteContentPersistsAfterResponse: container.persistsAfterResponse === true,
      dungeonSiteContentTrigger: container.trigger || null,
      dungeonSiteContentLootProfile: container.lootProfile,
      dungeonSiteContentLootTags: container.lootTags,
      dungeonSiteContentExplicitLoot:
        container.explicitLoot && container.explicitLoot.length > 0 ? container.explicitLoot : null,
      dungeonSiteContentHackingDifficulty: populationHints.homefront === true
        ? container.hackingDifficulty : resolveContainerHackingDifficultyTier(container, instance, typeRecord),
      itemID: SITE_CONTENT_CONTAINER_ID_BASE + (siteID * 100) + index + 1,
      typeID: toInt(typeRecord && typeRecord.typeID, 23) || 23,
      groupID: toInt(typeRecord && typeRecord.groupID, 12) || 12,
      categoryID: toInt(typeRecord && typeRecord.categoryID, 2) || 2,
      graphicID: toInt(typeRecord && typeRecord.graphicID, 0) || null,
      ownerID: 1,
      itemName: displayName,
      slimName: displayName,
      dungeonSourceObjectID: container.dunObjectID,
      position: addVectors(
        clonePosition(siteEntity && siteEntity.position),
        container.positionOffset || buildContentOffset(`${siteID}:${container.role}`, index, total),
      ),
      velocity: { x: 0, y: 0, z: 0 },
      direction: { x: 1, y: 0, z: 0 },
      radius: Math.max(200, toFiniteNumber(typeRecord && typeRecord.radius, 14)),
      staticVisibilityScope: "bubble",
    };
  });
}

function buildEncounterRewardContainerEntity(instance, siteEntity, encounterPlan, encounterState, populationHints) {
  if (!instance || !siteEntity || !encounterPlan) {
    return null;
  }
  const rewardProfile = normalizeText(encounterPlan && encounterPlan.lootProfile, "");
  if (!rewardProfile) {
    return null;
  }
  const siteID = Math.max(0, toInt(siteEntity && siteEntity.itemID, 0));
  const rewardIndex = Math.max(1, toInt(encounterPlan && encounterPlan.waveIndex, 1));
  const totalPlans = Math.max(1, resolveEncounterPlans(populationHints).length);
  const label = rewardProfile === "combat_overseer_loot"
    ? "Overseer Cache"
    : `${normalizeText(encounterPlan && encounterPlan.label, "Encounter")} Reward Cache`;
  const typeRecord = resolveGenericContainerTypeRecord() || resolveItemByTypeID(23) || {};
  return {
    kind: "container",
    dungeonMaterializedSiteContent: true,
    dungeonMaterializedContainer: true,
    dungeonSiteID: siteID,
    dungeonSiteInstanceID: Math.max(0, toInt(instance && instance.instanceID, 0)),
    dungeonSiteContentKey: `encounter_reward:${normalizeText(encounterPlan && encounterPlan.key, `wave_${rewardIndex}`)}`.toLowerCase(),
    dungeonSiteContentRole: "encounter_reward",
    dungeonSiteContentAnalyzer: null,
    dungeonSiteContentBonus: true,
    dungeonSiteContentFailureExplodes: false,
    dungeonSiteContentPersistsAfterResponse: true,
    dungeonSiteContentTrigger: normalizeLowerText(encounterPlan && encounterPlan.trigger, "") || null,
    dungeonSiteContentLootProfile: rewardProfile,
    dungeonSiteContentLootTags: cloneValue(encounterPlan && encounterPlan.lootTags) || [],
    dungeonSiteContentHackingDifficulty: null,
    itemID: SITE_CONTENT_CONTAINER_ID_BASE + (siteID * 100) + 50 + rewardIndex,
    typeID: toInt(typeRecord && typeRecord.typeID, 23) || 23,
    groupID: toInt(typeRecord && typeRecord.groupID, 12) || 12,
    categoryID: toInt(typeRecord && typeRecord.categoryID, 2) || 2,
    graphicID: toInt(typeRecord && typeRecord.graphicID, 0) || null,
    ownerID: 1,
    itemName: label,
    slimName: label,
    position: addVectors(
      clonePosition(siteEntity && siteEntity.position),
      buildContentOffset(
        `${siteID}:encounter_reward:${normalizeText(encounterPlan && encounterPlan.key, rewardIndex)}`,
        rewardIndex - 1,
        totalPlans,
        {
          baseDistanceMeters: SITE_CONTENT_REWARD_OFFSET_METERS,
          jitterMeters: 4_500,
        },
      ),
    ),
    velocity: { x: 0, y: 0, z: 0 },
    direction: { x: 1, y: 0, z: 0 },
    radius: Math.max(200, toFiniteNumber(typeRecord && typeRecord.radius, 14)),
    staticVisibilityScope: "bubble",
    dungeonEncounterCompletedAtMs: Math.max(0, toInt(encounterState && encounterState.completedAtMs, 0)) || null,
  };
}

function materializeEncounterRewardContainers(scene, instance, siteEntity, template, populationHints, options = {}) {
  if (!scene || !instance || !siteEntity) {
    return 0;
  }
  if (normalizeLowerText(instance && instance.siteKind, "") === "anomaly") {
    return 0;
  }
  const nowMs = Math.max(0, toInt(options.nowMs, Date.now()));
  let createdCount = 0;
  for (const plan of resolveEncounterPlans(populationHints)) {
    if (!normalizeText(plan && plan.lootProfile, "")) {
      continue;
    }
    const encounterState = getEncounterStateByKey(instance, plan.key);
    if (Math.max(0, toInt(encounterState && encounterState.completedAtMs, 0)) <= 0) {
      continue;
    }
    if (Math.max(0, toInt(encounterState && encounterState.rewardMaterializedAtMs, 0)) > 0) {
      continue;
    }
    const rewardContainer = buildEncounterRewardContainerEntity(
      instance,
      siteEntity,
      plan,
      encounterState,
      populationHints,
    );
    if (!rewardContainer) {
      continue;
    }
    const created = materializeContainerEntity(
      scene,
      instance,
      siteEntity,
      template,
      populationHints,
      rewardContainer,
      { nowMs },
    );
    if (!created) {
      continue;
    }
    upsertEncounterState(instance.instanceID, plan.key, {
      rewardMaterializedAtMs: nowMs,
    }, { nowMs });
    createdCount += 1;
  }
  return createdCount;
}

// container_on_trigger_kill: once maybeGrantFetchObjectiveItems has armed the fetch container on the
// trigger kill (spawnState.fetchObjectiveContainerTriggeredAtMs), materialize one real Cargo Container
// holding the objective item at the recorded kill position for the player to loot. One-shot.
function materializeFetchObjectiveContainer(scene, instance, siteEntity, template, populationHints, options = {}) {
  if (!scene || !instance || !siteEntity) {
    return 0;
  }
  const fetchObjective = normalizeFetchObjectiveHints(populationHints);
  if (!fetchObjective || fetchObjective.mechanic !== "container_on_trigger_kill") {
    return 0;
  }
  const spawnState = normalizeObject(instance.spawnState);
  if (Math.max(0, toInt(spawnState.fetchObjectiveContainerTriggeredAtMs, 0)) <= 0) {
    return 0;
  }
  if (Math.max(0, toInt(spawnState.fetchObjectiveContainerMaterializedAtMs, 0)) > 0) {
    return 0;
  }
  const nowMs = Math.max(0, toInt(options.nowMs, Date.now()));
  const siteID = Math.max(0, toInt(siteEntity && siteEntity.itemID, 0));
  const typeRecord = resolveGenericContainerTypeRecord() || resolveItemByTypeID(23) || {};
  const dropPosition =
    clonePosition(spawnState.fetchObjectiveContainerPosition) ||
    addVectors(clonePosition(siteEntity.position), buildContentOffset(`${siteID}:fetch_container`, 0, 1));
  const label = normalizeText(typeRecord && typeRecord.typeName, "Cargo Container");
  const containerEntity = {
    kind: "container",
    dungeonMaterializedSiteContent: true,
    dungeonMaterializedContainer: true,
    dungeonSiteID: siteID,
    dungeonSiteInstanceID: Math.max(0, toInt(instance && instance.instanceID, 0)),
    dungeonSiteContentKey: `fetch_objective_container:${instance.instanceID}`.toLowerCase(),
    dungeonSiteContentRole: "fetch_objective",
    dungeonSiteContentAnalyzer: null,
    dungeonSiteContentBonus: false,
    dungeonSiteContentFailureExplodes: false,
    dungeonSiteContentPersistsAfterResponse: true,
    dungeonSiteContentTrigger: "trigger_kill",
    dungeonSiteContentLootProfile: null,
    dungeonSiteContentExplicitLoot: [
      { typeID: fetchObjective.typeID, quantity: fetchObjective.quantity },
    ],
    dungeonSiteContentLootTags: [],
    dungeonSiteContentHackingDifficulty: null,
    itemID: SITE_CONTENT_CONTAINER_ID_BASE + (siteID * 100) + 95,
    typeID: toInt(typeRecord && typeRecord.typeID, 23) || 23,
    groupID: toInt(typeRecord && typeRecord.groupID, 12) || 12,
    categoryID: toInt(typeRecord && typeRecord.categoryID, 2) || 2,
    graphicID: toInt(typeRecord && typeRecord.graphicID, 0) || null,
    ownerID: 1,
    itemName: label,
    slimName: label,
    position: dropPosition,
    velocity: { x: 0, y: 0, z: 0 },
    direction: { x: 1, y: 0, z: 0 },
    radius: Math.max(200, toFiniteNumber(typeRecord && typeRecord.radius, 14)),
    staticVisibilityScope: "bubble",
  };
  const created = materializeContainerEntity(
    scene,
    instance,
    siteEntity,
    template,
    populationHints,
    containerEntity,
    { nowMs, broadcast: true },
  );
  if (!created) {
    return 0;
  }
  dungeonRuntime.mergeSpawnState(instance.instanceID, {
    fetchObjectiveContainerMaterializedAtMs: nowMs,
  });
  return 1;
}

function maybeCompleteClearedEncounterSite(instance, populationHints, options = {}) {
  if (!instance) {
    return false;
  }
  // Missions have their own turn-in lifecycle. Resource and hacking sites
  // finish through their resource/container handlers, even if they have rats.
  if (
    isMissionLikeSiteInstance(instance) ||
    normalizeLowerText(instance.siteFamily, "") !== "combat" ||
    !["anomaly", "signature", "escalation"].includes(normalizeLowerText(instance.siteKind, ""))
  ) {
    return false;
  }
  if (normalizeLowerText(instance && instance.lifecycleState, "") !== "active") {
    return false;
  }
  const plans = resolveEncounterPlans(populationHints).filter((plan) => plan.supported);
  const latestInstance = dungeonRuntime.getInstance(instance.instanceID) || instance;
  if (!isEncounterCompletionSatisfied(latestInstance, plans, populationHints)) {
    return false;
  }
  // Read the full template only after the cheap encounter checks succeed.
  // AEGIS still needs its analyzer cans resolved before the site can retire.
  if (dungeonAuthority.getTemplateByID(instance.templateID)?.hackingCombatSite === true) {
    return false;
  }
  let latestCompletionAtMs = 0;
  for (const plan of plans) {
    const state = getEncounterStateByKey(latestInstance, plan.key);
    const completedAtMs = Math.max(0, toInt(state && state.completedAtMs, 0));
    latestCompletionAtMs = Math.max(latestCompletionAtMs, completedAtMs);
  }
  const objectiveCompletedAtMs = Math.max(
    0,
    toInt(latestInstance && latestInstance.objectiveState && latestInstance.objectiveState.completedAtMs, 0),
  );
  const completionAtMs = Math.max(
    latestCompletionAtMs,
    objectiveCompletedAtMs,
    Math.max(0, toInt(options.nowMs, Date.now())),
  );
  if (dungeonTrackingRuntime.settleSiteCompletionAchievements(options.scene, latestInstance, {
    nowMs: completionAtMs,
  }).success !== true) {
    return false;
  }
  const updated = dungeonRuntime.setLifecycleState(latestInstance.instanceID, "completed", {
    nowMs: Math.max(0, toInt(options.nowMs, Date.now())),
    completedAtMs: completionAtMs,
    expiresAtMs: completionAtMs + CLEARED_ANOMALY_ROTATION_DELAY_MS,
    lifecycleReason: "encounters_cleared",
  });
  if (options.scene) {
    // The panel's last counter (N/N) goes out before the completion notice.
    publishClientWaveValues(options.scene, updated, { plans });
    dungeonTrackingRuntime.notifyDungeonCompletedForScene(options.scene, updated, {
      nowMs: completionAtMs,
    });
  }
  return true;
}

function isDataRelicUniverseSignatureInstance(instance) {
  if (!instance || isMissionLikeSiteInstance(instance)) {
    return false;
  }
  const siteKind = normalizeLowerText(instance.siteKind, "signature");
  const siteFamily = normalizeLowerText(instance.siteFamily, "");
  if (siteKind !== "signature" && !(siteKind === "escalation" && siteFamily === "combat")) {
    return false;
  }
  if (siteKind === "signature" && CONTAINER_COMPLETION_SITE_FAMILIES.has(siteFamily)) {
    return true;
  }
  const template = dungeonAuthority.getTemplateByID(instance.templateID);
  if (siteFamily === "combat" && template?.hackingCombatSite === true) return true;
  if (siteKind !== "signature") return false;
  const completion = normalizeCompletionHints(resolvePopulationHints(instance, template));
  return completion.completeOnContainersResolved === true;
}

function isDataRelicMaterializedContainer(entity) {
  return Boolean(
    entity &&
    entity.dungeonMaterializedContainer === true &&
    entity.dungeonMaterializedSiteContent === true &&
    DATA_RELIC_CONTAINER_ANALYZERS.has(
      normalizeLowerText(entity.dungeonSiteContentAnalyzer, ""),
    )
  );
}

function getContainerLootCount(entity) {
  return listContainerItems(null, Math.max(0, toInt(entity && entity.itemID, 0))).length;
}

function resolveMaterializedContainerCompletionContext(scene, source = null, options = {}) {
  if (!scene) {
    return null;
  }
  const sourceEntity = source && typeof source === "object" ? source : null;
  const containerID = Math.max(
    0,
    toInt(
      options.containerID,
      sourceEntity && sourceEntity.itemID,
    ),
  );
  const liveSourceEntity =
    sourceEntity ||
    (
      containerID > 0 && typeof scene.getEntityByID === "function"
        ? scene.getEntityByID(containerID)
        : null
    ) ||
    (
      containerID > 0 && scene.dynamicEntities instanceof Map
        ? scene.dynamicEntities.get(containerID)
        : null
    ) ||
    (
      containerID > 0 && scene.staticEntitiesByID instanceof Map
        ? scene.staticEntitiesByID.get(containerID)
        : null
    ) ||
    null;
  const instanceID = Math.max(
    0,
    toInt(
      options.instanceID,
      liveSourceEntity && liveSourceEntity.dungeonSiteInstanceID,
    ),
  );
  const siteID = Math.max(
    0,
    toInt(
      options.siteID,
      liveSourceEntity && liveSourceEntity.dungeonSiteID,
    ),
  );
  const instance =
    (instanceID > 0 ? dungeonRuntime.getInstance(instanceID) : null) ||
    resolveManagedUniverseSiteInstance(scene, liveSourceEntity || { itemID: siteID }, {
      siteID,
      systemID: scene.systemID,
    });

  if (!instance) {
    return null;
  }

  return {
    sourceEntity: liveSourceEntity,
    sourceWasDataRelicContainer: isDataRelicMaterializedContainer(liveSourceEntity),
    instance,
    instanceID: Math.max(0, toInt(instance && instance.instanceID, instanceID)),
    siteID: Math.max(
      0,
      toInt(
        siteID,
        instance && instance.metadata && instance.metadata.siteID,
      ),
    ),
  };
}

function isMissionRuntimeInstance(instance) {
  return Boolean(
    instance &&
    (
      (instance.metadata && instance.metadata.missionRuntime === true) ||
      (instance.runtimeFlags && instance.runtimeFlags.missionRuntime === true)
    ),
  );
}

// Bridge: a hacked container in a MISSION dungeon satisfies the mission's hack objective. Unlike the
// exploration data/relic path (maybeCompleteMaterializedDataRelicSite, which completes the whole
// signature site), here we only mark the dungeon objective satisfied — agentMissionRuntime still gates
// journal completion on the yielded item (the container's explicit loot, lootable now that it is
// hacked) reaching the player's cargo and being returned to the agent. Called after a successful hack
// (hackingMgrService.maybeCompleteAttemptSite). Returns { reason: "not_mission_instance" } for
// exploration/signature containers so the caller can fall back to the data/relic path.
function maybeSatisfyMissionHackObjective(scene, source = null, options = {}) {
  const context = resolveMaterializedContainerCompletionContext(scene, source, options);
  if (!context || !isMissionRuntimeInstance(context.instance)) {
    return { success: false, completed: false, reason: "not_mission_instance" };
  }
  const lifecycleState = normalizeLowerText(context.instance.lifecycleState, "");
  if (!isActiveLifecycleState(lifecycleState)) {
    return {
      success: true,
      completed: lifecycleState === "completed",
      reason: "inactive_lifecycle",
      instance: context.instance,
    };
  }
  const nowMs = Math.max(0, toInt(options.nowMs, Date.now()));
  dungeonRuntime.markInstanceObjectiveSatisfied(context.instanceID, {
    nowMs,
    reason: "mission_hack_container_hacked",
  });
  const refreshed = dungeonRuntime.getInstance(context.instanceID) || context.instance;
  syncAgentMissionForCompletedDungeonObjective(refreshed, { nowMs, scene });
  return {
    success: true,
    completed: true,
    reason: "mission_hack_objective_satisfied",
    instance: refreshed,
  };
}

// A container of a materialized site was hacked: fire the site's container_hacked encounter
// plans (Sleeper data/relic defenders). Runs before the site checks whether it is finished.
function notifyMaterializedContainerHacked(scene, source = null, options = {}) {
  const context = resolveMaterializedContainerCompletionContext(scene, source, options);
  if (!context || !context.instance) {
    return { success: false, encountersSpawned: 0, reason: "no_site_instance" };
  }
  const instance = context.instance;
  if (!isActiveLifecycleState(normalizeLowerText(instance.lifecycleState, ""))) {
    return { success: true, encountersSpawned: 0, reason: "inactive_lifecycle" };
  }
  const template = dungeonAuthority.getTemplateByID(instance.templateID);
  const populationHints = resolvePopulationHints(instance, template);
  const plans = resolveEncounterPlans(populationHints);
  if (!plans.some((plan) => plan.trigger === "container_hacked")) {
    return { success: true, encountersSpawned: 0, reason: "no_container_hacked_plans" };
  }
  const nowMs = Math.max(0, toInt(options.nowMs, Date.now()));
  const siteID = Math.max(0, toInt(instance && instance.metadata && instance.metadata.siteID, context.siteID));
  const siteEntity = (
    scene.staticEntitiesByID &&
    scene.staticEntitiesByID.get(siteID)
  ) || buildSiteEntity(instance);
  if (!siteEntity) {
    return { success: false, encountersSpawned: 0, reason: "no_site_entity" };
  }
  const hackedContainerDunObjectID = Math.max(0, toInt(
    context.sourceEntity && (context.sourceEntity.dunObjectID || context.sourceEntity.dungeonSourceObjectID),
    0,
  ));
  const encountersSpawned = processEncounterPlansForTrigger(
    scene,
    instance,
    siteEntity,
    populationHints,
    "container_hacked",
    { nowMs, hackedContainerDunObjectID },
  );
  const refreshed = dungeonRuntime.getInstance(instance.instanceID) || instance;
  const pendingPlans = plans.filter(plan => plan.trigger === "container_hacked" && plan.supported === true)
    .filter(plan => {
      const wanted = normalizeIDList(plan.triggerContainerObjectIDs);
      return wanted.length === 0 || wanted.includes(hackedContainerDunObjectID);
    })
    .filter(plan => toInt(getEncounterStateByKey(refreshed, plan.key)?.spawnedAtMs, 0) <= 0);
  if (pendingPlans.length > 0) {
    return { success: false, pending: true, errorMsg: "HACKING_DEFENDER_SPAWN_PENDING",
      encountersSpawned, pendingPlanKeys: pendingPlans.map(plan => plan.key) };
  }
  return { success: true, encountersSpawned, reason: encountersSpawned > 0 ? "container_hacked_encounters_spawned" : "container_hacked_nothing_due" };
}

function maybeCompleteMaterializedDataRelicSite(scene, source = null, options = {}) {
  const context = resolveMaterializedContainerCompletionContext(scene, source, options);
  if (!context || !isDataRelicUniverseSignatureInstance(context.instance)) {
    return {
      success: false,
      completed: false,
      reason: "not_data_relic_signature",
    };
  }

  const lifecycleState = normalizeLowerText(context.instance.lifecycleState, "");
  if (!isActiveLifecycleState(lifecycleState)) {
    return {
      success: true,
      completed: lifecycleState === "completed",
      reason: "inactive_lifecycle",
      instance: context.instance,
    };
  }

  const nowMs = Math.max(0, toInt(options.nowMs, Date.now()));
  const broadcast = options.broadcast === true;
  const excludedSession = options.excludedSession || null;
  if (hasPendingInstanceHackingOutcomes(context.instance)) {
    return { success: true, completed: false, reason: "hacking_outcomes_pending", instance: context.instance,
      unfinishedCount: 1 };
  }
  const containers = listMaterializedUniverseSiteContentEntities(scene, {
    instanceID: context.instanceID,
    siteID: context.siteID,
  }).filter(isDataRelicMaterializedContainer);

  const retainEmptyContainers = require("../seasons/eventHooks").depot.isDepot(context.instance);
  const template = dungeonAuthority.getTemplateByID(context.instance.templateID);
  const populationHints = resolvePopulationHints(context.instance, template);
  const expectedContainers = buildContainerEntities(
    context.instance, buildSiteEntity(context.instance), populationHints, template,
  ).filter(isDataRelicMaterializedContainer);
  const hackingRecords = normalizeObject(context.instance.spawnState?.hackingContainers);
  const hasDurableWin = (entity) => {
    const record = hackingRecords[entity.dungeonSiteContentKey];
    return record?.state === HACKING_STATE_HACKED &&
      Object.values(normalizeObject(record.outcomes)).some(receipt => receipt.outcome === "won");
  };
  // A live flag or a missing cache is not evidence of success. Detected relic
  // and F-can completion must be recoverable from the journal after a restart.
  if (expectedContainers.some(entity => entity.dungeonSiteContentCompletesSiteOnHack === true && hasDurableWin(entity))) {
    return completeClearedDataRelicSite(scene, context, { ...options, nowMs, removedEmptyContainers: 0 });
  }
  const hasDurableProgress = expectedContainers.some(entity => {
    const record = hackingRecords[entity.dungeonSiteContentKey];
    return hasDurableWin(entity) || toInt(record?.resolvedAtMs, 0) > 0 ||
      toInt(getContentEntityRefsByKey(context.instance)[entity.dungeonSiteContentKey]?.resolvedAtMs, 0) > 0;
  });
  const isOptionalFinale = entity => hasDurableProgress &&
    entity.dungeonSiteContentRole === "detected_drone_finale" &&
    entity.dungeonSiteContentCompletesSiteOnHack === true;
  const isDurablyLocked = entity => hackingRecords[entity.dungeonSiteContentKey]?.state === 3;
  let removedEmptyContainers = 0;
  let unfinishedCount = 0;

  // The site tick calls this every second for each loaded hacking site, so the
  // cheap live-cache checks run first. An unhacked cache ends the check before
  // any loot lookup or rebuild of the authored cache list.
  for (const entity of containers) {
    if (isOptionalFinale(entity) || isDurablyLocked(entity)) continue;
    const state = Math.max(0, toInt(entity && entity.dungeonSiteContentHackingState, 0));
    const seededDepotContainer = retainEmptyContainers &&
      getContentEntityRefsByKey(context.instance)[entity.dungeonSiteContentKey]?.lootSeeded === true;
    // An empty, previously seeded Depot is depleted even if its transient hack
    // state was lost or its loot was removed through another inventory path.
    // Completion is separate from (and must never grant) exploration credit.
    if (
      (state !== HACKING_STATE_HACKED && !seededDepotContainer) ||
      getContainerLootCount(entity) > 0
    ) {
      unfinishedCount += 1;
      continue;
    }
    // A looted Depot bank/vault remains visible and empty until whole-site cleanup.
    // It is finished for completion accounting, but is not a destroyed container.
    if (retainEmptyContainers) continue;
    // A pending win still needs a live source for mission/encounter delivery.
    // Emptying its inventory must not tear down that retry anchor first.
    if (require("../exploration/hackingContainerState").getPendingSuccessOutcomes(entity, {
      instance: context.instance,
    }).length > 0) {
      unfinishedCount += 1;
      continue;
    }
    const removeResult = destroyMaterializedContentEntity(scene, entity, {
      broadcast,
      excludedSession,
      nowMs,
    });
    if (removeResult && removeResult.success === true) {
      removedEmptyContainers += 1;
    } else {
      unfinishedCount += 1;
    }
  }

  if (unfinishedCount > 0) {
    return {
      success: true,
      completed: false,
      reason: "containers_unfinished",
      instance: dungeonRuntime.getInstance(context.instanceID) || context.instance,
      removedEmptyContainers,
      unfinishedCount,
    };
  }

  // Read the refs after the loop above, which marks the caches it removed.
  const contentRefs = getContentEntityRefsByKey(
    dungeonRuntime.getInstance(context.instanceID) || context.instance,
  );
  const liveKeys = new Set(containers.map((entity) => entity.dungeonSiteContentKey));
  // Missing content alone is not progress: every authored cache must either
  // exist on this grid or have a durable record of being resolved.
  if (expectedContainers.some((entity) => (
    !isOptionalFinale(entity) && !isDurablyLocked(entity) &&
    !liveKeys.has(entity.dungeonSiteContentKey) &&
    !(toInt(contentRefs[entity.dungeonSiteContentKey]?.resolvedAtMs, 0) > 0)
  ))) {
    return {
      success: true,
      completed: false,
      reason: "containers_unfinished",
      instance: dungeonRuntime.getInstance(context.instanceID) || context.instance,
      removedEmptyContainers,
    };
  }

  if (containers.length <= 0 && expectedContainers.length <= 0 && context.sourceWasDataRelicContainer !== true) {
    return {
      success: true,
      completed: false,
      reason: "no_materialized_containers",
      instance: context.instance,
    };
  }

  const remainingContainers = listMaterializedUniverseSiteContentEntities(scene, {
    instanceID: context.instanceID,
    siteID: context.siteID,
  }).filter(isDataRelicMaterializedContainer);
  if (!retainEmptyContainers && remainingContainers.some(entity => !isOptionalFinale(entity) && !isDurablyLocked(entity))) {
    return {
      success: true,
      completed: false,
      reason: "containers_still_materialized",
      instance: dungeonRuntime.getInstance(context.instanceID) || context.instance,
      removedEmptyContainers,
      unfinishedCount: remainingContainers.length,
    };
  }

  // Depot scanner visibility and grid lifetime must end at the same boundary.
  // Keeping only the grid alive after marking completed removes the signature
  // too early. The scene tick retries depletion once the last pilot leaves.
  if (retainEmptyContainers && anyPlayerShipPresentAtSite(scene, context.instance, context.siteID)) {
    return {
      success: true, completed: false, reason: "awaiting_grid_departure",
      instance: context.instance, removedEmptyContainers, unfinishedCount: 0,
    };
  }

  return completeClearedDataRelicSite(scene, context, { ...options, nowMs, removedEmptyContainers });
}

function completeClearedDataRelicSite(scene, context, options = {}) {
  const nowMs = Math.max(0, toInt(options.nowMs, Date.now()));
  const latestInstance = dungeonRuntime.getInstance(context.instanceID) || context.instance;
  const template = dungeonAuthority.getTemplateByID(latestInstance.templateID);
  if (normalizeLowerText(latestInstance.siteFamily, "") === "combat" && template?.hackingCombatSite === true) {
    const populationHints = resolvePopulationHints(latestInstance, template);
    const plans = resolveEncounterPlans(populationHints).filter(plan => plan.supported);
    if (!isEncounterCompletionSatisfied(latestInstance, plans, populationHints)) {
      return {
        success: true, completed: false, reason: "encounters_unfinished",
        instance: latestInstance,
        removedEmptyContainers: Math.max(0, toInt(options.removedEmptyContainers, 0)),
      };
    }
  }
  if (dungeonTrackingRuntime.settleSiteCompletionAchievements(scene,
    latestInstance, { nowMs }).success !== true) {
    return { success: true, completed: false, reason: "achievement_completion_pending", instance: context.instance };
  }
  const updated = dungeonRuntime.setLifecycleState(context.instanceID, "completed", {
    nowMs,
    completedAtMs: nowMs,
    expiresAtMs: nowMs + CLEARED_ANOMALY_ROTATION_DELAY_MS,
    lifecycleReason: "containers_cleared",
  });
  const dungeonCompletionNotifiedCount = dungeonTrackingRuntime.notifyDungeonCompletedForScene(
    scene,
    updated,
    { nowMs },
  );
  if (options.notifyTracker !== false) {
    notifyTrackerDelta(Math.max(0, toInt(scene && scene.systemID, 0)), "signature", {
      scene,
      refresh: false,
    });
  }

  return {
    success: true,
    completed: true,
    reason: "containers_cleared",
    instance: updated,
    removedEmptyContainers: Math.max(0, toInt(options.removedEmptyContainers, 0)),
    dungeonCompletionNotifiedCount,
  };
}

function maybeCompleteMaterializedDataRelicSiteForContainerID(scene, containerID, options = {}) {
  return maybeCompleteMaterializedDataRelicSite(scene, null, {
    ...options,
    containerID,
  });
}

function hasPendingInstanceHackingOutcomes(instance) {
  if (require("./siteHazardOutcomes").hasPending(instance)) return true;
  return Object.values(normalizeObject(instance?.spawnState?.hackingContainers)).some(record =>
    Object.values(normalizeObject(record?.outcomes)).some(receipt =>
      (receipt.outcome === "won" && receipt.successEffectsDelivered !== true) ||
      (receipt.outcome === "lost" && receipt.failureEffectsDelivered !== true)));
}

function retryContainerHackingOutcomes(scene, entity, instance) {
  const state = require("../exploration/hackingContainerState");
  const failures = state.getPendingFailureOutcomes(entity, { instance });
  const successes = state.getPendingSuccessOutcomes(entity, { instance });
  if (!failures.length && !successes.length) return true;
  const service = require("../exploration/hackingMgrService");
  try {
    if (failures.length && service.retryPendingFailureEffects(scene, entity) !== true) return false;
    if (successes.length && service.retryPendingSuccessEffects(scene, entity) !== true) return false;
    return true;
  } catch (error) {
    log.warn(`[DungeonSites] container outcome replay deferred: ${error.message}`);
    return false;
  }
}

function retryInstanceHackingOutcomes(scene, instance, populationHints, options = {}) {
  if (!hasPendingInstanceHackingOutcomes(instance)) return true;
  const siteEntity = buildSiteEntity(instance);
  const descriptors = buildContainerEntities(instance, siteEntity, populationHints);
  let completed = true;
  for (const descriptor of descriptors) {
    const ref = getContentEntityRefsByKey(instance)[descriptor.dungeonSiteContentKey];
    const itemID = toInt(ref?.itemID, toInt(descriptor.itemID, 0));
    const live = typeof scene.getEntityByID === "function" ? scene.getEntityByID(itemID) : null;
    const source = live || { ...descriptor, itemID };
    if (!live) require("../exploration/hackingContainerState").restore(source, { instance, nowMs: options.nowMs });
    if (!retryContainerHackingOutcomes(scene, source, instance)) {
      completed = false;
      continue;
    }
    if (require("../exploration/hackingContainerState").isDestroyed(source) &&
        (live || findItemById(itemID))) {
      const removed = destroyMaterializedContentEntity(scene, source, { broadcast: true, nowMs: options.nowMs });
      if (removed?.success !== true) completed = false;
    }
  }
  return completed && !hasPendingInstanceHackingOutcomes(dungeonRuntime.getInstance(instance.instanceID) || instance);
}

function restoreMaterializedContainerHackingState(scene, entity, instance, nowMs, options = {}) {
  const hackingState = require("../exploration/hackingContainerState");
  if (!hackingState.isHackable(entity)) return;
  if (options.preserveActive === true && hackingState.getState(entity) === hackingState.BEING_HACKED) return;
  if ([92144, 92145].includes(Number(entity.typeID))) {
    const depot = require("../seasons/eventHooks").depot;
    const record = depot.getRecord(entity);
    const hack = record?.instance?.spawnState?.electionHacks?.[record.key];
    hackingState.setTransientState(entity, hack ? HACKING_STATE_HACKED : hackingState.SECURE,
      { nowMs: hack?.atMs || nowMs });
  } else if (entity.homefrontKey) {
    require("../homefront/homefrontHooks").runtime.restoreHackingContainer(entity, instance, nowMs);
  } else {
    hackingState.restore(entity, { instance, nowMs });
    if (hackingState.getPendingSuccessOutcomes(entity, { instance }).length > 0) {
      scene._pendingHackingSuccessEntityIDs ||= new Set();
      scene._pendingHackingSuccessEntityIDs.add(entity.itemID);
    }
  }
}

function materializeContainerEntity(scene, instance, siteEntity, template, populationHints, containerEntity, options = {}) {
  if (!scene || !instance || !containerEntity) {
    return false;
  }
  const nowMs = Math.max(0, toInt(options.nowMs, Date.now()));
  const contentKey = normalizeText(containerEntity && containerEntity.dungeonSiteContentKey, "");
  const latestInstance = dungeonRuntime.getInstance(instance.instanceID) || instance;
  const existingRef = normalizeObject(getContentEntityRefsByKey(latestInstance)[contentKey]);
  const hackingState = require("../exploration/hackingContainerState");
  const restoredHack = hackingState.getRecord(containerEntity, { instance: latestInstance });
  const recoveryItemID = Math.max(0, toInt(existingRef.itemID, toInt(containerEntity.itemID, 0)));
  const recoveryLive = recoveryItemID > 0 && typeof scene.getEntityByID === "function"
    ? scene.getEntityByID(recoveryItemID) : null;
  const recoverySource = recoveryLive || { ...containerEntity, itemID: recoveryItemID };
  if (!recoveryLive) hackingState.restore(recoverySource, { instance: latestInstance, nowMs });
  if (!retryContainerHackingOutcomes(scene, recoverySource, latestInstance)) return false;
  if (toInt(existingRef.resolvedAtMs, 0) > 0 || restoredHack?.destroyed === true) {
    // Generic inventory hydration runs before site materialization. If a crash
    // interrupted the physical removal after the terminal receipt, remove that
    // retained item too instead of leaving a resurrected can on the new scene.
    const resolvedItemID = Math.max(0, toInt(existingRef.itemID, 0));
    const resolvedEntity = resolvedItemID > 0 && typeof scene.getEntityByID === "function"
      ? scene.getEntityByID(resolvedItemID) : null;
    if (resolvedEntity || (resolvedItemID > 0 && findItemById(resolvedItemID))) {
      const target = resolvedEntity || { ...containerEntity, itemID: resolvedItemID };
      if (restoredHack?.destroyed === true) hackingState.restore(target, { instance: latestInstance, nowMs });
      destroyMaterializedContentEntity(scene, target, { ...options, nowMs });
    }
    return false;
  }
  const lootPreviouslySeeded = existingRef.lootSeeded === true || restoredHack?.state === HACKING_STATE_HACKED;
  const containerLootEntries = lootPreviouslySeeded ? []
    : Array.isArray(existingRef.blueprintLootPlan) ? cloneValue(existingRef.blueprintLootPlan)
    : buildLootGrantEntriesForContainer(containerEntity, populationHints, { instance, siteEntity, template });
  const hasBlueprintLoot = containerLootEntries.some((entry) => entry.options?.blueprintState);
  if (hasBlueprintLoot && !Array.isArray(existingRef.blueprintLootPlan)) {
    // Retain the exact reward choice before creating either the container or
    // its loot. A retry must repair these copies using the original plan.
    if (!upsertContentEntityRef(instance.instanceID, contentKey, {
      blueprintLootPlan: cloneValue(containerLootEntries),
    }, { nowMs })) return false;
  }
  // A prior plan write may still be dirty after a failed flush. Confirm its
  // durability on retries too, before creating the inventory receipt or items.
  if (hasBlueprintLoot && require("../../gameStore").flushTableSync("dungeonRuntimeState").success !== true) return false;
  const grantContainerItems = (ownerID,locationID,flagID,entries) => {
    const copyEntries = entries.filter((entry) => entry.options?.blueprintState);
    const fabricator = require("../seasons/eventHooks").fabricator.isFabricator(instance);
    if (!fabricator && !hasBlueprintLoot) return grantItemsToOwnerLocation(ownerID,locationID,flagID,entries);
    const result = require("../inventory/itemStore").grantItemsToOwnerLocationIdempotent(ownerID,locationID,flagID,entries,{
      receiptKey:`${fabricator ? "fabricator" : "site-blueprint-loot"}:${instance.instanceID}:${containerEntity.dungeonSiteContentKey}:${locationID}:${flagID}`,
    });
    if (!result.success) {
      if (fabricator) throw new Error(`Fabricator loot settlement deferred: ${result.errorMsg}`);
      return result;
    }
    const itemsByTypeID = new Map();
    for (const item of result.data.items) {
      const copies = itemsByTypeID.get(item.typeID) || [];
      copies.push(item);
      itemsByTypeID.set(item.typeID, copies);
    }
    for (const entry of copyEntries) {
      const copies = (itemsByTypeID.get(entry.itemType.typeID) || []).splice(0, entry.quantity);
      if (copies.length !== entry.quantity) return { success: false, ambiguous: true, errorMsg: "BLUEPRINT_COPY_INSTANCE_MISSING" };
      const stateResult = ensureGrantedBlueprintCopyState(copies, entry.options.blueprintState);
      if (!stateResult.success) return stateResult;
    }
    return result;
  };
  const entityScopeMetadata = {
    ...(containerEntity.homefrontKey ? {homefrontKey:containerEntity.homefrontKey,homefrontRole:containerEntity.homefrontRole} : {}),
    dungeonMaterializedSiteContent: true,
    dungeonMaterializedContainer: true,
    dungeonSiteID: toInt(containerEntity && containerEntity.dungeonSiteID, 0),
    dungeonSiteInstanceID: toInt(
      containerEntity && containerEntity.dungeonSiteInstanceID,
      0,
    ),
    dungeonSiteContentKey: contentKey,
    dungeonSiteContentRole: normalizeLowerText(
      containerEntity && containerEntity.dungeonSiteContentRole,
      "container",
    ),
    dungeonSiteContentAnalyzer: normalizeLowerText(
      containerEntity && containerEntity.dungeonSiteContentAnalyzer,
      "",
    ) || null,
    dungeonSiteContentBonus:
      containerEntity && containerEntity.dungeonSiteContentBonus === true,
    dungeonSiteContentFailureExplodes:
      containerEntity && containerEntity.dungeonSiteContentFailureExplodes === true,
    dungeonSiteContentFailureNeverDestroys: containerEntity.dungeonSiteContentFailureNeverDestroys === true,
    dungeonSiteContentFailureLocksOut: containerEntity.dungeonSiteContentFailureLocksOut === true,
    dungeonSiteContentCompletesSiteOnHack: containerEntity.dungeonSiteContentCompletesSiteOnHack === true,
    dungeonSiteContentPersistsAfterResponse:
      containerEntity && containerEntity.dungeonSiteContentPersistsAfterResponse === true,
    dungeonSiteContentTrigger: normalizeLowerText(
      containerEntity && containerEntity.dungeonSiteContentTrigger,
      "",
    ) || null,
    dungeonSiteContentLootProfile: normalizeText(
      containerEntity && containerEntity.dungeonSiteContentLootProfile,
      "",
    ) || null,
    dungeonSiteContentExplicitLoot: Array.isArray(
      containerEntity && containerEntity.dungeonSiteContentExplicitLoot,
    )
      ? cloneValue(containerEntity.dungeonSiteContentExplicitLoot)
      : null,
    dungeonSiteContentLootTags:
      cloneValue(containerEntity && containerEntity.dungeonSiteContentLootTags) || [],
    dungeonSiteContentHackingDifficulty: normalizeLowerText(
      containerEntity && containerEntity.dungeonSiteContentHackingDifficulty,
      "",
    ) || null,
    generatedMiningSite: containerEntity.generatedMiningSite === true,
    generatedMiningSiteKind: normalizeLowerText(containerEntity.generatedMiningSiteKind, "") || null,
    generatedMiningSiteIndex: toInt(containerEntity.generatedMiningSiteIndex, 0),
    generatedMiningSiteID: toInt(containerEntity.generatedMiningSiteID, 0) || null,
    generatedMiningSiteInstanceID: toInt(containerEntity.generatedMiningSiteInstanceID, 0) || null,
    // Exact client caches keep the client object they came from.
    dungeonSourceObjectID: toInt(containerEntity.dungeonSourceObjectID, 0) || null,
  };
  let itemID = Math.max(0, toInt(existingRef && existingRef.itemID, 0));
  let createdItem = false;

  if (!(itemID > 0 && findItemById(itemID))) {
    itemID = 0;
  }

  if (itemID <= 0) {
    const containerType = resolveItemByTypeID(toInt(containerEntity && containerEntity.typeID, 0)) ||
      resolveContainerTypeRecord(containerEntity);
    if (!containerType) {
      return false;
    }
    const createResult = grantContainerItems(
      SITE_CONTENT_OWNER_ID,
      scene.systemID,
      0,
      [{
        itemType: containerType,
        quantity: 1,
        options: {
          singleton: 1,
          itemName: normalizeText(containerEntity && containerEntity.itemName, resolveTypeRecordName(containerType, "Site Container")),
          createdAtMs: nowMs,
          spaceRadius: Math.max(100, toFiniteNumber(containerEntity && containerEntity.radius, 0)) || null,
          spaceState: {
            systemID: scene.systemID,
            position: clonePosition(containerEntity && containerEntity.position),
            velocity: { x: 0, y: 0, z: 0 },
            direction: { x: 1, y: 0, z: 0 },
            mode: "STOP",
            ...entityScopeMetadata,
          },
        },
      }],
    );
    if (!createResult || !createResult.success || !createResult.data || !Array.isArray(createResult.data.items)) {
      return false;
    }
    itemID = Math.max(0, toInt(createResult.data.items[0] && createResult.data.items[0].itemID, 0));
    createdItem = itemID > 0;
  }

  if (itemID <= 0) {
    return false;
  }

  const runtime = getSpaceRuntime();
  const lootSeeded = lootPreviouslySeeded;
  if (!lootSeeded) {
    const lootEntries = containerLootEntries;
    if (lootEntries.length > 0) {
      const lootResult = grantContainerItems(
        SITE_CONTENT_OWNER_ID,
        itemID,
        ITEM_FLAGS.CARGO_HOLD,
        lootEntries,
      );
      if (!lootResult || lootResult.success !== true) return false;
    }
  }

  const spawnResult = runtime.spawnDynamicInventoryEntity(scene.systemID, itemID, {
    broadcast: false,
    excludedSession: options.excludedSession || null,
    entityScopeMetadata,
  });
  if (!spawnResult || !spawnResult.success) {
    return false;
  }
  const liveEntity = scene.getEntityByID(itemID) || (spawnResult.data && spawnResult.data.entity) || null;
  if (!liveEntity) {
    return false;
  }
  annotateMaterializedContainerEntity(liveEntity, {
    ...containerEntity,
    itemID,
  });
  restoreMaterializedContainerHackingState(scene, liveEntity, latestInstance, nowMs, { preserveActive: true });
  if (options.broadcast === true && typeof scene.broadcastAddBalls === "function") {
    scene.broadcastAddBalls(
      [liveEntity],
      options.excludedSession || null,
      { freshAcquire: true },
    );
  }
  upsertContentEntityRef(instance.instanceID, contentKey, {
    itemID,
    lootSeeded: true,
    lastMaterializedAtMs: nowMs,
    createdAtMs: createdItem ? nowMs : Math.max(0, toInt(existingRef && existingRef.createdAtMs, 0)) || null,
  }, { nowMs });
  return true;
}

function broadcastStaticSiteContentBatch(scene, entities, options = {}) {
  if (
    !scene ||
    !Array.isArray(entities) ||
    entities.length <= 0 ||
    options.broadcast !== true ||
    typeof scene.broadcastAddBalls !== "function"
  ) {
    return 0;
  }
  const filtered = entities.filter(Boolean);
  if (filtered.length <= 0) {
    return 0;
  }
  scene.broadcastAddBalls(filtered, options.excludedSession || null);
  return filtered.length;
}

function buildSiteHazardPrivateScope(source) {
  const result = {};
  for (const field of ["airNpeOwnerCharacterID", "airNpeOperationID", "airNpeInstanceID",
    "abyssalRunID", "evejsAbyssalInstanceID", "evejsAbyssalPocketInstanceID",
    "abyssalRoomIndex", "evejsAbyssalRoomIndex", "sceneKey"]) {
    if (source && Object.hasOwn(source, field)) result[field] = source[field];
  }
  return result;
}

function buildHazardEntities(instance, siteEntity, populationHints) {
  if (!populationHints || !Array.isArray(populationHints.hazards)) {
    return [];
  }
  const siteID = Math.max(0, toInt(siteEntity && siteEntity.itemID, 0));
  const instanceID = Math.max(0, toInt(instance && instance.instanceID, 0));
  const hazards = [...new Set(
    populationHints.hazards
      .map((entry) => {
        if (entry && typeof entry === "object") {
          return JSON.stringify({
            kind: normalizeLowerText(entry.kind, ""),
            label: normalizeText(entry.label, ""),
            visibleCountdownSeconds: Math.max(0, toInt(entry.visibleCountdownSeconds, 0)),
            hiddenTimerMinSeconds: Math.max(0, toInt(entry.hiddenTimerMinSeconds, 0)),
            hiddenTimerMaxSeconds: Math.max(0, toInt(entry.hiddenTimerMaxSeconds, 0)),
            failureTriggersExplosion: entry.failureTriggersExplosion === true,
          });
        }
        return JSON.stringify({
          kind: normalizeLowerText(entry, ""),
        });
      })
      .filter((entry) => entry !== JSON.stringify({ kind: "" })),
  )]
    .map((entry) => {
      try {
        return JSON.parse(entry);
      } catch (error) {
        // ignored: an unreadable entry is dropped by the filter that follows
        return null;
      }
    })
    .filter(Boolean)
    .filter(hazard => normalizeLowerText(hazard.kind, "") !== "sleeper_toxic_cloud")
    .slice(0, SITE_CONTENT_MAX_HAZARD_COUNT);
  const total = hazards.length;
  if (total <= 0) {
    return [];
  }

  return hazards.map((hazard, index) => {
    const hazardKind = normalizeLowerText(hazard && hazard.kind, "");
    const hazardLabel = normalizeText(hazard && hazard.label, "") || resolveHazardLabel(hazardKind);
    return {
      kind: "siteHazardBeacon",
      dungeonMaterializedSiteContent: true,
      dungeonMaterializedHazard: true,
      ...buildSiteHazardPrivateScope(siteEntity),
      dungeonSiteID: siteID,
      dungeonSiteInstanceID: instanceID,
      dungeonSiteContentHazard: hazardKind,
      dungeonHazardVisibleCountdownSeconds: Math.max(0, toInt(hazard && hazard.visibleCountdownSeconds, 0)) || null,
      dungeonHazardHiddenTimerMinSeconds: Math.max(0, toInt(hazard && hazard.hiddenTimerMinSeconds, 0)) || null,
      dungeonHazardHiddenTimerMaxSeconds: Math.max(0, toInt(hazard && hazard.hiddenTimerMaxSeconds, 0)) || null,
      dungeonHazardFailureTriggersExplosion: hazard && hazard.failureTriggersExplosion === true,
      itemID: SITE_CONTENT_HAZARD_ID_BASE + (siteID * 100) + index + 1,
      typeID: toInt(siteEntity && siteEntity.typeID, COSMIC_SIGNATURE_TYPE_ID) || COSMIC_SIGNATURE_TYPE_ID,
      groupID: toInt(siteEntity && siteEntity.groupID, COSMIC_SIGNATURE_GROUP_ID) || COSMIC_SIGNATURE_GROUP_ID,
      categoryID: toInt(siteEntity && siteEntity.categoryID, 16) || 16,
      graphicID: toInt(siteEntity && siteEntity.graphicID, 0) || null,
      ownerID: 1,
      itemName: hazardLabel,
      slimName: hazardLabel,
      position: addVectors(
        clonePosition(siteEntity && siteEntity.position),
        buildContentOffset(
          `${siteID}:${hazardKind}`,
          index,
          total,
          {
            baseDistanceMeters: SITE_CONTENT_ENCOUNTER_OFFSET_METERS + 5_000,
            jitterMeters: 6_000,
          },
        ),
      ),
      velocity: { x: 0, y: 0, z: 0 },
      direction: { x: 1, y: 0, z: 0 },
      radius: Math.max(2_500, Math.round(toFiniteNumber(siteEntity && siteEntity.radius, 2_000) * 0.75)),
      staticVisibilityScope: "bubble",
    };
  });
}

function resolveSiteSceneProfile(template) {
  return normalizeObject(
    template &&
    template.siteSceneProfile &&
    typeof template.siteSceneProfile === "object"
      ? template.siteSceneProfile
      : null,
  );
}

function cloneSceneRoomProfilePosition(value) {
  if (Array.isArray(value) && value.length >= 3) {
    return {
      x: toFiniteNumber(value[0], 0),
      y: toFiniteNumber(value[1], 0),
      z: toFiniteNumber(value[2], 0),
    };
  }
  if (value && typeof value === "object") {
    return clonePosition(value);
  }
  return null;
}

// Multi-pocket log packs record each room's absolute TQ anchor in roomProfiles[].position and the
// site materializes at the ENTRY room's anchor, so a room's world position is the site position
// plus that room's recorded offset from the entry room. Gates, props, and waves keyed to a deeper
// pocket belong at that pocket's anchor (tens of thousands of km off the warp-in grid), not on the
// entry grid. Returns null when the template carries no room positions (procedural/legacy packs)
// so callers keep their site-position anchoring.
function resolveRoomWorldPositionForTemplate(sitePosition, template, roomKey) {
  const normalizedRoomKey = normalizeText(roomKey, "");
  if (!normalizedRoomKey || !sitePosition || typeof sitePosition !== "object") {
    return null;
  }
  const roomProfiles = normalizeArray(resolveSiteSceneProfile(template).roomProfiles)
    .filter((entry) => entry && typeof entry === "object");
  if (roomProfiles.length <= 0) {
    return null;
  }
  const entryProfile = roomProfiles.find((profile) => (
    normalizeLowerText(profile.initialState, "") === "active"
  )) || roomProfiles[0];
  const roomProfile = roomProfiles.find((profile) => (
    normalizeText(profile.roomKey, "") === normalizedRoomKey
  )) || null;
  const entryPosition = cloneSceneRoomProfilePosition(entryProfile && entryProfile.position);
  const roomPosition = cloneSceneRoomProfilePosition(roomProfile && roomProfile.position);
  if (!entryPosition || !roomPosition) {
    return null;
  }
  return addVectors(clonePosition(sitePosition), {
    x: roomPosition.x - entryPosition.x,
    y: roomPosition.y - entryPosition.y,
    z: roomPosition.z - entryPosition.z,
  });
}

function resolveMissionGateDunDirection(gatePosition, destinationPoint) {
  // WarpGate aligns its local +Z to dunDirection, but the gate mouth faces local -Z.
  const x = toFiniteNumber(gatePosition && gatePosition.x, 0) -
    toFiniteNumber(destinationPoint && destinationPoint.x, 0);
  const y = toFiniteNumber(gatePosition && gatePosition.y, 0) -
    toFiniteNumber(destinationPoint && destinationPoint.y, 0);
  const z = toFiniteNumber(gatePosition && gatePosition.z, 0) -
    toFiniteNumber(destinationPoint && destinationPoint.z, 0);
  const length = Math.sqrt((x * x) + (y * y) + (z * z));
  return length > 0.000001
    ? [x / length, y / length, z / length]
    : null;
}

function buildGateEntities(instance, siteEntity, template) {
  const sceneProfile = resolveSiteSceneProfile(template);
  const siteFamily = normalizeLowerText(
    instance && instance.siteFamily,
    normalizeLowerText(template && template.siteFamily, ""),
  );
  const siteKind = normalizeLowerText(
    instance && instance.siteKind,
    normalizeLowerText(template && template.siteKind, ""),
  );
  // Ore anomalies are open-grid mining sites. Some exact client records retain
  // source acceleration-gate objects, but those are not part of the materialized
  // anomaly scene. Keep this rule explicit so content-pack object ordering cannot
  // change whether a gated source record happens to be selected or spawned.
  if (siteFamily === "ore" && siteKind === "anomaly") {
    return [];
  }
  if (!isMissionLikeSiteInstance(instance, template) && !(sceneProfile && sceneProfile.exactClientContent === true)) {
    return [];
  }
  const rawGateProfiles = normalizeArray(sceneProfile && sceneProfile.gateProfiles)
    .filter((entry) => entry && typeof entry === "object");
  if (rawGateProfiles.length <= 0) {
    return [];
  }
  const gateStatesByKey =
    instance &&
    instance.gateStatesByKey &&
    typeof instance.gateStatesByKey === "object"
      ? instance.gateStatesByKey
      : {};
  const dedupedGateProfiles = [];
  const seenEntryGateKeys = new Set();
  for (const gateProfile of rawGateProfiles) {
    const gateKey = normalizeText(gateProfile && gateProfile.gateKey, "");
    const gateState = normalizeObject(gateStatesByKey[gateKey]);
    const destinationRoomKey = normalizeText(
      gateProfile && gateProfile.destinationRoomKey,
      normalizeText(gateState && gateState.destinationRoomKey, ""),
    );
    const label = normalizeText(gateProfile && gateProfile.label, "");
    const allowedShipsList = Math.max(
      0,
      toInt(
        gateProfile && gateProfile.allowedShipsList,
        gateState && gateState.metadata && gateState.metadata.allowedShipsList,
      ),
    );
    if (destinationRoomKey === "room:entry" && !label) {
      const dedupeKey = `${destinationRoomKey}:${allowedShipsList}`;
      if (seenEntryGateKeys.has(dedupeKey)) {
        continue;
      }
      seenEntryGateKeys.add(dedupeKey);
    }
    dedupedGateProfiles.push(gateProfile);
  }
  const gateProfiles = dedupedGateProfiles.slice(0, resolveGateLimit(template, dedupedGateProfiles.length));
  if (gateProfiles.length <= 0) {
    return [];
  }
  const siteID = Math.max(0, toInt(siteEntity && siteEntity.itemID, 0));
  const instanceID = Math.max(0, toInt(instance && instance.instanceID, 0));
  return gateProfiles.map((gateProfile, index) => {
    const explicitTypeID = Math.max(0, toInt(gateProfile && gateProfile.typeID, 0));
    const typeRecord = (
      explicitTypeID > 0
        ? resolveItemByTypeID(explicitTypeID)
        : resolveGenericTypeRecordByName(gateProfile && gateProfile.typeNameCandidates)
    ) || resolveItemByTypeID(17_831) || {};
    const gateKey = normalizeText(gateProfile && gateProfile.gateKey, `gate:${index + 1}`);
    const gateState = normalizeObject(gateStatesByKey[gateKey]);
    const label = normalizeText(
      gateProfile && gateProfile.label,
      resolveTypeRecordName(typeRecord, "Acceleration Gate"),
    ) || "Acceleration Gate";
    const gateTypeID = Math.max(0, toInt(typeRecord && typeRecord.typeID, explicitTypeID || 17_831)) || 17_831;
    const dungeonObjectID = resolveGateDungeonObjectID(gateProfile, gateState, gateKey);
    const gateActivationRange = resolveGateActivationRangeMeters(gateProfile, gateTypeID);
    const requirementMetadata = resolveGateRequirementMetadata(gateProfile, gateState);
    const exactOffset = gateProfile && gateProfile.positionOffset && typeof gateProfile.positionOffset === "object"
      ? clonePosition(gateProfile.positionOffset)
      : null;
    const contentOffset = exactOffset || buildContentOffset(
      `${siteID}:gate:${gateKey}`,
      index,
      gateProfiles.length,
      {
        baseDistanceMeters: 22_000,
        jitterMeters: 7_000,
      },
    );
    const sourceRoomKey = normalizeText(gateProfile && gateProfile.roomKey, "");
    const roomAnchorPosition =
      resolveRoomWorldPositionForTemplate(siteEntity && siteEntity.position, template, sourceRoomKey) ||
      clonePosition(siteEntity && siteEntity.position);
    const dunRotation = Array.isArray(gateProfile && gateProfile.dunRotation) &&
      gateProfile.dunRotation.length === 3
      ? gateProfile.dunRotation.map((value) => toFiniteNumber(value, 0))
      : null;
    const destinationRoomKey = normalizeText(
      gateProfile && gateProfile.destinationRoomKey,
      normalizeText(gateState && gateState.destinationRoomKey, "") || null,
    ) || null;
    const gatePosition = addVectors(roomAnchorPosition, contentOffset);
    const destinationPoint = getKeeperService().resolveGateDestinationPoint(
      siteEntity,
      { position: gatePosition },
      instance,
      template,
      destinationRoomKey,
    );
    const dunDirection = resolveMissionGateDunDirection(gatePosition, destinationPoint);
    const suppressSlimName = gateProfile && gateProfile.suppressSlimName === true;
    const suppressSlimGraphicID = gateProfile && gateProfile.suppressSlimGraphicID === true;
    const slimLabel = suppressSlimName ? "" : label;
    return {
      kind: "siteAccelerationGate",
      ...require("../homefront/homefrontHooks").admission.gateFields(instance),
      dungeonMaterializedSiteContent: true,
      dungeonMaterializedGate: true,
      dungeonSiteID: siteID,
      dungeonSiteInstanceID: instanceID,
      dungeonGateKey: gateKey,
      dungeonObjectID: dungeonObjectID || null,
      dunObjectID: dungeonObjectID || null,
      dungeonGateSourceRoomKey: sourceRoomKey || null,
      dungeonGateDestinationRoomKey: destinationRoomKey,
      dungeonGateState: normalizeLowerText(gateState && gateState.state, "locked"),
      dungeonGateAllowedShipsList: Math.max(
        0,
        toInt(
          gateProfile && gateProfile.allowedShipsList,
          gateState && gateState.metadata && gateState.metadata.allowedShipsList,
        ),
      ) || null,
      dungeonGateKeyLock: requirementMetadata.keyLock ?? null,
      dungeonGateRequiredItems: requirementMetadata.requiredItems ?? null,
      dungeonGateRequiredItemTypeID: requirementMetadata.requiredItemTypeID,
      dungeonGateRequiredItemQuantity: requirementMetadata.requiredItemQuantity,
      gateActivationRange,
      dunMusicUrl: normalizeText(gateProfile && gateProfile.dunMusicUrl, "") || null,
      itemID: SITE_CONTENT_GATE_ID_BASE + (siteID * 100) + index + 1,
      typeID: gateTypeID,
      groupID: Math.max(0, toInt(typeRecord && typeRecord.groupID, 366)) || 366,
      categoryID: Math.max(0, toInt(typeRecord && typeRecord.categoryID, 2)) || 2,
      graphicID: suppressSlimGraphicID ? null : toInt(typeRecord && typeRecord.graphicID, 0) || null,
      slimGraphicID: suppressSlimGraphicID ? null : undefined,
      suppressSlimGraphicID,
      ownerID: Math.max(0, toInt(gateProfile && gateProfile.ownerID, 0)) || 1,
      itemName: slimLabel,
      slimName: slimLabel,
      suppressSlimName,
      dunObjectNameID: Object.prototype.hasOwnProperty.call(gateProfile || {}, "dunObjectNameID")
        ? gateProfile.dunObjectNameID
        : undefined,
      nameID: Object.prototype.hasOwnProperty.call(gateProfile || {}, "nameID")
        ? gateProfile.nameID
        : undefined,
      objectiveTargetGroup: Object.prototype.hasOwnProperty.call(gateProfile || {}, "objectiveTargetGroup")
        ? gateProfile.objectiveTargetGroup
        : undefined,
      dunPosition: exactOffset ? [contentOffset.x, contentOffset.y, contentOffset.z] : undefined,
      dunRotation: Array.isArray(dunRotation) ? dunRotation : undefined,
      dunDirection: Array.isArray(dunDirection) ? dunDirection : undefined,
      position: gatePosition,
      velocity: { x: 0, y: 0, z: 0 },
      direction: { x: 1, y: 0, z: 0 },
      radius: Math.max(2_500, toFiniteNumber(typeRecord && typeRecord.radius, 12_000)),
      staticVisibilityScope: "bubble",
    };
  });
}

function buildEnvironmentEntities(instance, siteEntity, template, populationHints) {
  // An exploration grid's container layout owns its usable cans. Older
  // family dressing can name different can types from that authored layout;
  // those props still cannot become inventory or analyzer targets.
  const explorationGrid = ["data", "relic", "ghost", "combat_hacking"].includes(
    normalizeLowerText(populationHints?.siteFamily || template?.siteFamily, ""),
  );
  const canReplaceEnvironment = explorationGrid || template?.hackingCombatSite === true;
  const replacementContainers = canReplaceEnvironment
    ? buildContainerEntities(instance, siteEntity, populationHints, template) : [];
  const hasExplorationCans = explorationGrid && replacementContainers.some(isDataRelicMaterializedContainer);
  const replacementObjectIDs = new Set(replacementContainers
    .map(entity => entity.dungeonSourceObjectID).filter(Boolean));
  const replacementTypeIDs = new Set(replacementContainers.map(entity => entity.typeID));
  const resolveNamedEnvironmentType = (candidateNames) => {
    // Use the container owner's identity before trying scenery aliases. A
    // duplicate classic/Legion name such as "Angel Remains" otherwise falls
    // through to "Angel Ship Remains" here, leaving a fake extra can beside
    // the real one because their type IDs differ.
    const containerType = canReplaceEnvironment
      ? resolveContainerTypeRecordByName(candidateNames) : null;
    if (containerType && HACKABLE_CAN_GROUP_IDS.has(toInt(containerType.groupID, 0)) &&
        (hasExplorationCans || replacementTypeIDs.has(containerType.typeID))) {
      return containerType;
    }
    return resolveGenericTypeRecordByName(candidateNames);
  };
  const sceneProfile = resolveSiteSceneProfile(template);
  const environmentTemplates =
    template &&
    template.environmentTemplates &&
    typeof template.environmentTemplates === "object"
      ? template.environmentTemplates
      : null;
  const resolvedTemplateCatalog =
    environmentTemplates &&
    environmentTemplates.resolvedTemplateCatalog &&
    typeof environmentTemplates.resolvedTemplateCatalog === "object"
      ? environmentTemplates.resolvedTemplateCatalog
      : {};
  const entryObjectEnvironmentMapping =
    environmentTemplates &&
    environmentTemplates.entryObjectEnvironmentMapping &&
    typeof environmentTemplates.entryObjectEnvironmentMapping === "object"
      ? environmentTemplates.entryObjectEnvironmentMapping
      : null;

  const siteID = Math.max(0, toInt(siteEntity && siteEntity.itemID, 0));
  const instanceID = Math.max(0, toInt(instance && instance.instanceID, 0));
  const candidates = [];
  const pushDefinitionCandidates = (environmentTemplateID, definition, source) => {
    const anchorTypeIDs = Array.isArray(definition && definition.anchorTypeIDs)
      ? definition.anchorTypeIDs
      : [];
    const subEnvironmentTypeIDs = Array.isArray(definition && definition.subEnvironmentTypeIDs)
      ? definition.subEnvironmentTypeIDs
      : [];
    for (const typeID of [...anchorTypeIDs, ...subEnvironmentTypeIDs.slice(0, 12)]) {
      const normalizedTypeID = Math.max(0, toInt(typeID, 0));
      if (normalizedTypeID <= 0) {
        continue;
      }
      const typeRecord = resolveItemByTypeID(normalizedTypeID);
      if (!typeRecord || !resolveTypeRecordName(typeRecord, "")) {
        continue;
      }
      candidates.push({
        typeID: normalizedTypeID,
        typeRecord,
        environmentTemplateID: Math.max(0, toInt(environmentTemplateID, 0)) || null,
        source: anchorTypeIDs.includes(normalizedTypeID)
          ? `${source}:anchorType`
          : `${source}:subEnvironmentType`,
        explicitLabel: null,
      });
    }
  };
  for (const [environmentTemplateID, definition] of Object.entries(resolvedTemplateCatalog)) {
    pushDefinitionCandidates(environmentTemplateID, definition, "catalog");
  }
  const mappedTemplateRefs = [
    ...(entryObjectEnvironmentMapping && entryObjectEnvironmentMapping.baseEnvironment
      ? [entryObjectEnvironmentMapping.baseEnvironment]
      : []),
    ...Object.values(
      entryObjectEnvironmentMapping && entryObjectEnvironmentMapping.overridesByMaterialSetID
        ? entryObjectEnvironmentMapping.overridesByMaterialSetID
        : {},
    ),
  ];
  for (const templateRef of mappedTemplateRefs) {
    const environmentTemplateID = Math.max(0, toInt(templateRef && templateRef.templateID, 0)) || null;
    const explicitDefinition = normalizeObject(templateRef && templateRef.definition);
    const definition = Object.keys(explicitDefinition).length > 0
      ? explicitDefinition
      : normalizeObject(environmentTemplateID ? resolvedTemplateCatalog[String(environmentTemplateID)] : null);
    if (Object.keys(definition).length <= 0) {
      continue;
    }
    pushDefinitionCandidates(environmentTemplateID, definition, "entryObjectMapping");
  }

  const rawHintedEnvironmentProps = normalizeArray(populationHints && populationHints.environmentProps)
    .filter((entry) => entry && typeof entry === "object");
  const hasExactHintedEnvironmentProps = rawHintedEnvironmentProps
    .some((entry) => entry && entry.exact === true);
  const hintedEnvironmentProps = hasExactHintedEnvironmentProps
    ? rawHintedEnvironmentProps.filter((entry) => entry && entry.exact === true)
    : rawHintedEnvironmentProps;
  if (hasExactHintedEnvironmentProps) {
    candidates.length = 0;
  }
  const sceneProfileStructures = (hasExactHintedEnvironmentProps ? [] : normalizeArray(sceneProfile && sceneProfile.structureProfiles))
    .filter((entry) => entry && typeof entry === "object");
  if (
    Object.keys(resolvedTemplateCatalog).length <= 0 &&
    mappedTemplateRefs.length <= 0 &&
    hintedEnvironmentProps.length <= 0 &&
    sceneProfileStructures.length <= 0
  ) {
    return [];
  }
  for (const structureProfile of sceneProfileStructures) {
    const explicitTypeID = Math.max(0, toInt(structureProfile && structureProfile.typeID, 0));
    const typeRecord = (
      explicitTypeID > 0
        ? resolveItemByTypeID(explicitTypeID)
        : resolveNamedEnvironmentType(structureProfile && structureProfile.typeNameCandidates)
    );
    if (!typeRecord) {
      continue;
    }
    candidates.push({
      typeID: Math.max(0, toInt(typeRecord && typeRecord.typeID, explicitTypeID)) || explicitTypeID,
      typeRecord,
      environmentTemplateID: null,
      source: normalizeText(structureProfile && structureProfile.source, "sceneProfile"),
      explicitLabel: normalizeText(structureProfile && structureProfile.label, "") || null,
      roomKey: normalizeText(structureProfile && structureProfile.roomKey, ""),
    });
  }
  for (const environmentProp of hintedEnvironmentProps) {
    const explicitTypeID = Math.max(0, toInt(environmentProp && environmentProp.typeID, 0));
    const typeRecord = (
      explicitTypeID > 0
        ? resolveItemByTypeID(explicitTypeID)
        : resolveNamedEnvironmentType(environmentProp && environmentProp.typeNameCandidates)
    );
    if (!typeRecord) {
      continue;
    }
    const exact = environmentProp && environmentProp.exact === true;
    const positionOffset = environmentProp && environmentProp.positionOffset && typeof environmentProp.positionOffset === "object"
      ? clonePosition(environmentProp.positionOffset)
      : null;
    const dunRotation = Array.isArray(environmentProp && environmentProp.dunRotation) &&
      environmentProp.dunRotation.length === 3
      ? environmentProp.dunRotation.map((value) => toFiniteNumber(value, 0))
      : null;
    candidates.push({
      typeID: Math.max(0, toInt(typeRecord && typeRecord.typeID, explicitTypeID)) || explicitTypeID,
      typeRecord,
      environmentTemplateID: null,
      source: exact ? "populationHint:exact" : "populationHint",
      explicitLabel: normalizeText(environmentProp && environmentProp.label, "") || null,
      exact,
      exactKey: normalizeText(environmentProp && environmentProp.key, ""),
      staticVisibilityScope: exact && environmentProp.staticVisibilityScope === "site" ? "site" : "bubble",
      roomKey: normalizeText(environmentProp && environmentProp.roomKey, ""),
      positionOffset,
      dunObjectID: Math.max(0, toInt(environmentProp && environmentProp.dunObjectID, 0)),
      dunObjectNameID: Object.prototype.hasOwnProperty.call(environmentProp, "dunObjectNameID")
        ? environmentProp.dunObjectNameID
        : exact ? null : undefined,
      nameID: Object.prototype.hasOwnProperty.call(environmentProp, "nameID")
        ? environmentProp.nameID
        : exact ? null : undefined,
      objectiveTargetGroup: Object.prototype.hasOwnProperty.call(environmentProp, "objectiveTargetGroup")
        ? environmentProp.objectiveTargetGroup
        : exact ? null : undefined,
      dunRotation,
      ownerID: Math.max(0, toInt(environmentProp && environmentProp.ownerID, 0)) || null,
      suppressSlimName: environmentProp && (environmentProp.suppressSlimName === true || exact),
      suppressSlimGraphicID: environmentProp && (environmentProp.suppressSlimGraphicID === true || exact),
      destinyBallMode: environmentProp && (
        environmentProp.destinyBallMode ?? environmentProp.mode
      ),
      destinyForceFree: environmentProp && environmentProp.destinyForceFree,
      destinyBallFlags: environmentProp && (
        environmentProp.destinyBallFlags ?? environmentProp.flagsByte
      ),
      destinyCollisionTail: environmentProp && environmentProp.destinyCollisionTail,
      destinyCollisionTailSource:
        environmentProp && environmentProp.destinyCollisionTailSource,
    });
  }

  const deduped = [];
  const seen = new Set();
  for (const [candidateIndex, candidate] of candidates.entries()) {
    if (canReplaceEnvironment && HACKABLE_CAN_GROUP_IDS.has(toInt(candidate.typeRecord?.groupID, 0)) &&
        (hasExplorationCans || (candidate.dunObjectID && replacementObjectIDs.has(candidate.dunObjectID)) ||
          (!candidate.dunObjectID && replacementTypeIDs.has(candidate.typeID)))) {
      continue;
    }
    const key = candidate.exact
      ? `exact:${normalizeText(candidate.exactKey, "")}:${candidate.dunObjectID || 0}:${candidate.typeID}:${candidateIndex}`
      : `${candidate.typeID}:${normalizeText(candidate.explicitLabel, "")}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(candidate);
  }
  const maxEnvironmentProps = deduped.some((candidate) => candidate && candidate.exact)
    ? resolveExactEnvironmentPropLimit(populationHints, deduped.length)
    : SITE_CONTENT_MAX_ENVIRONMENT_PROPS;
  const selected = deduped.slice(0, maxEnvironmentProps);
  if (selected.length <= 0) {
    return [];
  }

  return selected.map((candidate, index) => {
    const resolvedTypeID =
      toInt(candidate.typeRecord && candidate.typeRecord.typeID, candidate.typeID) || candidate.typeID;
    const healthState = resolveTypeHealthState(resolvedTypeID);
    const destinyPresentation = resolveSiteEnvironmentPropDestinyPresentation(
      {
        ...candidate,
        destinyBootstrapDelivery: DESTINY_BOOTSTRAP_DELIVERY_ADDBALLS2,
      },
      {
        mass: candidate.typeRecord && candidate.typeRecord.mass,
        maxVelocity: getTypeAttributeValue(resolvedTypeID, "maxVelocity"),
        agility: getTypeAttributeValue(resolvedTypeID, "agility"),
      },
    );
    const exactOffset = candidate.exact && candidate.positionOffset
      ? candidate.positionOffset
      : null;
    const contentOffset = exactOffset || buildContentOffset(
      `${siteID}:environment:${candidate.typeID}`,
      index,
      selected.length,
      {
        baseDistanceMeters: 18_000,
        jitterMeters: 9_000,
      },
    );
    const roomAnchorPosition =
      resolveRoomWorldPositionForTemplate(siteEntity && siteEntity.position, template, candidate.roomKey) ||
      clonePosition(siteEntity && siteEntity.position);
    const suppressSlimName = candidate.suppressSlimName === true;
    const slimLabel = suppressSlimName
      ? ""
      : normalizeText(candidate.explicitLabel, "") || resolveTypeRecordName(candidate.typeRecord, "Environment Feature");
    return {
      kind: "siteEnvironmentProp",
      dungeonMaterializedSiteContent: true,
      dungeonMaterializedEnvironment: true,
      dungeonSiteID: siteID,
      dungeonSiteInstanceID: instanceID,
      dungeonEnvironmentTemplateID: candidate.environmentTemplateID,
      dungeonEnvironmentSource: candidate.source,
      itemID: buildSiteContentItemID(SITE_CONTENT_ENVIRONMENT_ID_BASE, siteID, 1_000, index + 1),
      typeID: resolvedTypeID,
      groupID: toInt(candidate.typeRecord && candidate.typeRecord.groupID, 0) || 0,
      categoryID: toInt(candidate.typeRecord && candidate.typeRecord.categoryID, 0) || 0,
      graphicID: toInt(candidate.typeRecord && candidate.typeRecord.graphicID, 0) || null,
      ownerID: Math.max(0, toInt(candidate.ownerID, 0)) || SITE_CONTENT_OWNER_ID,
      itemName: slimLabel,
      slimName: slimLabel,
      ...buildSafeSitePropSlimOverrides(candidate.typeRecord),
      slimGraphicID: candidate.suppressSlimGraphicID === true ? null : undefined,
      suppressSlimGraphicID: candidate.suppressSlimGraphicID === true,
      suppressSlimName,
      dunObjectID: Math.max(0, toInt(candidate.dunObjectID, 0)) || undefined,
      ...(candidate.dunObjectNameID !== undefined ? { dunObjectNameID: candidate.dunObjectNameID } : {}),
      ...(candidate.nameID !== undefined ? { nameID: candidate.nameID } : {}),
      ...(candidate.objectiveTargetGroup !== undefined ? { objectiveTargetGroup: candidate.objectiveTargetGroup } : {}),
      dunPosition: candidate.exact ? [contentOffset.x, contentOffset.y, contentOffset.z] : undefined,
      dunRotation: Array.isArray(candidate.dunRotation) ? candidate.dunRotation : undefined,
      position: addVectors(roomAnchorPosition, contentOffset),
      velocity: { x: 0, y: 0, z: 0 },
      direction: { x: 1, y: 0, z: 0 },
      radius: Math.max(500, toFiniteNumber(candidate.typeRecord && candidate.typeRecord.radius, 1_500)),
      shieldCapacity: healthState.shieldCapacity,
      armorHP: healthState.armorHP,
      structureHP: healthState.structureHP,
      conditionState: cloneValue(healthState.conditionState),
      staticVisibilityScope: candidate.staticVisibilityScope || "bubble",
      ...destinyPresentation,
    };
  });
}

function buildObjectiveEntities(instance, siteEntity, template, populationHints = null) {
  // Depot objectives are the actual analyzer containers. Generic task markers
  // look like loot cans but cannot be hacked, so do not create them here.
  if (require("../seasons/eventHooks").fw.isSite(instance) || require("../seasons/eventHooks").depot.isDepot(instance) || require("../seasons/eventHooks").fabricator.isFabricator(instance)) return [];
  const objectiveMetadata =
    template &&
    template.objectiveMetadata &&
    typeof template.objectiveMetadata === "object"
      ? template.objectiveMetadata
      : null;
  const objectiveChain =
    objectiveMetadata &&
    objectiveMetadata.objectiveChain &&
    typeof objectiveMetadata.objectiveChain === "object"
      ? objectiveMetadata.objectiveChain
      : null;
  const objectiveTypesByID =
    objectiveMetadata &&
    objectiveMetadata.objectiveTypesByID &&
    typeof objectiveMetadata.objectiveTypesByID === "object"
      ? objectiveMetadata.objectiveTypesByID
      : {};
  const objectiveTaskTypesByID =
    objectiveMetadata &&
    objectiveMetadata.objectiveTaskTypesByID &&
    typeof objectiveMetadata.objectiveTaskTypesByID === "object"
      ? objectiveMetadata.objectiveTaskTypesByID
      : {};
  const objectives = Array.isArray(objectiveChain && objectiveChain.objectives)
    ? objectiveChain.objectives
    : [];
  const siteID = Math.max(0, toInt(siteEntity && siteEntity.itemID, 0));
  const instanceID = Math.max(0, toInt(instance && instance.instanceID, 0));
  const markers = [];
  if (objectives.length > 0) {
    const currentObjectiveKey = normalizeText(
      instance &&
      instance.objectiveState &&
      instance.objectiveState.currentObjectiveKey,
      "",
    );
    const selectedObjective = objectives.find((objective) => (
      currentObjectiveKey && normalizeText(objective && objective.key, "") === currentObjectiveKey
    )) ||
      objectives.find((objective) => objective && (objective.startActive === 1 || objective.startActive === true)) ||
      objectives[0] ||
      null;
    if (selectedObjective) {
      const selectedObjectiveType = normalizeObject(
        objectiveTypesByID[String(toInt(selectedObjective && selectedObjective.objectiveType, 0))],
      );
      markers.push({
        role: "objective",
        label: resolveObjectiveLabel(selectedObjective, selectedObjectiveType),
        objectiveKey: normalizeText(selectedObjective && selectedObjective.key, "") || null,
        objectiveTypeID: Math.max(0, toInt(selectedObjective && selectedObjective.objectiveType, 0)) || null,
        objectiveTaskTypeID: null,
        icon: null,
        analyzer: null,
      });

      for (const task of normalizeArray(selectedObjectiveType.tasks)) {
        if (!(task && (task.startActive === 1 || task.startActive === true))) {
          continue;
        }
        const taskTypeID = Math.max(0, toInt(task && task.taskType, 0)) || null;
        const taskType = normalizeObject(taskTypeID ? objectiveTaskTypesByID[String(taskTypeID)] : null);
        markers.push({
          role: "task",
          label: resolveObjectiveTaskLabel(task, taskType),
          objectiveKey: normalizeText(task && task.key, "") || null,
          objectiveTypeID: Math.max(0, toInt(selectedObjective && selectedObjective.objectiveType, 0)) || null,
          objectiveTaskTypeID: taskTypeID,
          icon: normalizeText(taskType && taskType.icon, "") || null,
          analyzer:
            normalizeLowerText(taskType && taskType.icon, "") === "hacking"
              ? "data"
              : null,
        });
      }
    }
  }
  markers.push(...resolvePopulationObjectiveMarkers(populationHints, template));

  // Analyzer objectives describe the real containers and their progress; a
  // second marker with a Cargo Container model has neither inventory nor a
  // hacking target. Keep that objective metadata without spawning fake cans.
  const visibleMarkers = markers.filter((marker) =>
    !DATA_RELIC_CONTAINER_ANALYZERS.has(marker.analyzer));
  const total = Math.min(SITE_CONTENT_MAX_OBJECTIVE_MARKERS, visibleMarkers.length);
  if (total <= 0) {
    return [];
  }
  const typeRecord = resolveItemByTypeID(toInt(siteEntity && siteEntity.typeID, COSMIC_SIGNATURE_TYPE_ID)) ||
    resolveItemByTypeID(COSMIC_SIGNATURE_TYPE_ID) || {};
  return visibleMarkers.slice(0, total).map((marker, index) => {
    return {
      kind: "siteObjectiveMarker",
      dungeonMaterializedSiteContent: true,
      dungeonMaterializedObjective: true,
      dungeonSiteID: siteID,
      dungeonSiteInstanceID: instanceID,
      dungeonObjectiveRole: marker.role,
      dungeonObjectiveKey: marker.objectiveKey,
      dungeonObjectiveTypeID: marker.objectiveTypeID,
      dungeonObjectiveTaskTypeID: marker.objectiveTaskTypeID,
      dungeonObjectiveIcon: marker.icon,
      itemID: SITE_CONTENT_OBJECTIVE_ID_BASE + (siteID * 100) + index + 1,
      typeID: toInt(typeRecord && typeRecord.typeID, COSMIC_SIGNATURE_TYPE_ID) || COSMIC_SIGNATURE_TYPE_ID,
      groupID: toInt(typeRecord && typeRecord.groupID, COSMIC_SIGNATURE_GROUP_ID) || COSMIC_SIGNATURE_GROUP_ID,
      categoryID: toInt(typeRecord && typeRecord.categoryID, 16) || 16,
      graphicID: toInt(typeRecord && typeRecord.graphicID, 0) || null,
      ownerID: 1,
      itemName: marker.label,
      slimName: marker.label,
      position: addVectors(
        clonePosition(siteEntity && siteEntity.position),
        buildContentOffset(
          `${siteID}:objective:${marker.objectiveKey || index}`,
          index,
          total,
          {
            baseDistanceMeters: 8_500,
            jitterMeters: 2_500,
          },
        ),
      ),
      velocity: { x: 0, y: 0, z: 0 },
      direction: { x: 1, y: 0, z: 0 },
      radius: Math.max(250, toFiniteNumber(typeRecord && typeRecord.radius, 800)),
      staticVisibilityScope: "bubble",
    };
  });
}

function listEncounterNotificationSessions(scene, options = {}) {
  const sessions = [];
  const seen = new Set();
  const pushSession = (session) => {
    if (!session || typeof session.sendNotification !== "function" || seen.has(session)) {
      return;
    }
    seen.add(session);
    sessions.push(session);
  };

  pushSession(options.session);
  if (!scene || !scene.sessions) {
    return sessions;
  }
  if (scene.sessions instanceof Map) {
    for (const session of scene.sessions.values()) {
      pushSession(session);
    }
    return sessions;
  }
  if (Array.isArray(scene.sessions)) {
    for (const session of scene.sessions) {
      pushSession(session);
    }
    return sessions;
  }
  if (typeof scene.sessions === "object") {
    for (const session of Object.values(scene.sessions)) {
      pushSession(session);
    }
  }
  return sessions;
}

function resolveTriggerAudioDungeonID(instance, audioEntry) {
  const explicitDungeonID = Math.max(0, toInt(audioEntry && audioEntry.dungeonID, 0));
  if (explicitDungeonID > 0) {
    return explicitDungeonID;
  }
  const metadataDungeonID = Math.max(0, toInt(
    instance && instance.metadata && (
      instance.metadata.sourceDungeonID ||
      instance.metadata.dungeonID ||
      instance.metadata.clientDungeonID
    ),
    0,
  ));
  if (metadataDungeonID > 0) {
    return metadataDungeonID;
  }
  const templateID = normalizeText(instance && instance.templateID, "");
  const match = /^client-dungeon:(\d+)$/i.exec(templateID);
  return match ? Math.max(0, toInt(match[1], 0)) : 0;
}

function sendEncounterTriggerNotifications(scene, instance, encounterPlan, options = {}) {
  const planKey = normalizeText(encounterPlan && encounterPlan.key, "");
  if (!planKey) {
    return {
      messagesSent: 0,
      audioSent: 0,
    };
  }
  const triggerMessages = normalizeArray(encounterPlan && encounterPlan.triggerMessages);
  const triggerAudio = normalizeArray(encounterPlan && encounterPlan.triggerAudio);
  if (triggerMessages.length <= 0 && triggerAudio.length <= 0) {
    return {
      messagesSent: 0,
      audioSent: 0,
    };
  }

  const state = getEncounterStateByKey(instance, planKey);
  if (Math.max(0, toInt(state && state.triggerNotificationsSentAtMs, 0)) > 0) {
    return {
      messagesSent: 0,
      audioSent: 0,
    };
  }
  const sessions = listEncounterNotificationSessions(scene, options);
  if (sessions.length <= 0) {
    return {
      messagesSent: 0,
      audioSent: 0,
    };
  }

  let messagesSent = 0;
  let audioSent = 0;
  for (const session of sessions) {
    for (const message of triggerMessages) {
      try {
        session.sendNotification(
          "OnDungeonTriggerMessage",
          normalizeText(message && message.idType, "charid"),
          [
            Math.max(0, toInt(message && message.messageType, 0)),
            Math.max(0, toInt(message && message.messageID, 0)),
          ],
        );
        messagesSent += 1;
      } catch (error) {
        // Notification delivery is best-effort; encounter materialization must continue.
        log.debug(`[DungeonSites] encounter message notification failed: ${error && error.message}`);
      }
    }
    for (const audioEntry of triggerAudio) {
      try {
        session.sendNotification(
          "OnDungeonTriggerAudio",
          normalizeText(audioEntry && audioEntry.idType, "shipid"),
          [
            resolveTriggerAudioDungeonID(instance, audioEntry),
            normalizeText(audioEntry && audioEntry.audio, ""),
          ],
        );
        audioSent += 1;
      } catch (error) {
        // Notification delivery is best-effort; encounter materialization must continue.
        log.debug(`[DungeonSites] encounter audio notification failed: ${error && error.message}`);
      }
    }
  }

  if (messagesSent > 0 || audioSent > 0) {
    upsertEncounterState(instance.instanceID, planKey, {
      triggerNotificationsSentAtMs: Math.max(0, toInt(options.nowMs, Date.now())),
      triggerNotifications: {
        messages: cloneValue(triggerMessages),
        audio: cloneValue(triggerAudio),
      },
    }, { nowMs: options.nowMs });
  }
  return {
    messagesSent,
    audioSent,
  };
}

function sendCompletionTriggerNotifications(scene, instance, populationHints, options = {}) {
  const triggerMessages = normalizeMaybeArray(populationHints && populationHints.completionTriggerMessages);
  const triggerAudio = normalizeMaybeArray(populationHints && populationHints.completionTriggerAudio);
  if (triggerMessages.length <= 0 && triggerAudio.length <= 0) {
    return {
      messagesSent: 0,
      audioSent: 0,
    };
  }

  const objectiveState = normalizeObject(instance && instance.objectiveState);
  const objectiveMetadata = normalizeObject(objectiveState && objectiveState.metadata);
  if (Math.max(0, toInt(objectiveMetadata.completionTriggerNotificationsSentAtMs, 0)) > 0) {
    return {
      messagesSent: 0,
      audioSent: 0,
    };
  }

  const sessions = listEncounterNotificationSessions(scene, options);
  if (sessions.length <= 0) {
    return {
      messagesSent: 0,
      audioSent: 0,
    };
  }

  let messagesSent = 0;
  let audioSent = 0;
  for (const session of sessions) {
    for (const message of triggerMessages) {
      try {
        session.sendNotification(
          "OnDungeonTriggerMessage",
          normalizeText(message && message.idType, "charid"),
          [
            Math.max(0, toInt(message && message.messageType, 0)),
            Math.max(0, toInt(message && message.messageID, 0)),
          ],
        );
        messagesSent += 1;
      } catch (error) {
        // Notification delivery is best-effort; objective completion must continue.
        log.debug(`[DungeonSites] objective message notification failed: ${error && error.message}`);
      }
    }
    for (const audioEntry of triggerAudio) {
      try {
        session.sendNotification(
          "OnDungeonTriggerAudio",
          normalizeText(audioEntry && audioEntry.idType, "shipid"),
          [
            resolveTriggerAudioDungeonID(instance, audioEntry),
            normalizeText(audioEntry && audioEntry.audio, ""),
          ],
        );
        audioSent += 1;
      } catch (error) {
        // Notification delivery is best-effort; objective completion must continue.
        log.debug(`[DungeonSites] objective audio notification failed: ${error && error.message}`);
      }
    }
  }

  if (messagesSent > 0 || audioSent > 0) {
    const nowMs = Math.max(0, toInt(options.nowMs, Date.now()));
    dungeonRuntime.mergeObjectiveState(instance.instanceID, {
      metadata: {
        ...cloneValue(objectiveMetadata),
        completionTriggerNotificationsSentAtMs: nowMs,
        completionTriggerNotifications: {
          messages: cloneValue(triggerMessages),
          audio: cloneValue(triggerAudio),
        },
      },
    }, { nowMs });
  }
  return {
    messagesSent,
    audioSent,
  };
}

function isKillableStructureSpawnEntry(entry) {
  const entityKind = normalizeLowerText(
    entry && (entry.entityKind || entry.kind || entry.spawnKind || entry.role),
    "",
  ).replace(/[^a-z0-9]+/g, "");
  return Boolean(
    entry &&
      (
        entry.killableStructure === true ||
        entityKind === "killablestructure" ||
        entityKind === "combatstructure" ||
        entityKind === "dungeonstructure"
      )
  );
}

function shouldKillableStructureBlockEncounterProgress(spawnEntry, encounterPlan, context = {}) {
  if (Object.prototype.hasOwnProperty.call(spawnEntry || {}, "blocksEncounterProgress")) {
    return spawnEntry.blocksEncounterProgress !== false;
  }
  if (Object.prototype.hasOwnProperty.call(spawnEntry || {}, "blocksWaveProgress")) {
    return spawnEntry.blocksWaveProgress !== false;
  }
  return context.hasNpcEntries !== true;
}

function allocateKillableStructureEntityID(scene, siteID) {
  const base = SITE_CONTENT_KILLABLE_STRUCTURE_ID_BASE + (Math.max(0, toInt(siteID, 0)) * 100);
  for (let slot = 1; slot <= 99; slot += 1) {
    const candidateID = base + slot;
    if (
      !(scene && scene.staticEntitiesByID instanceof Map && scene.staticEntitiesByID.has(candidateID)) &&
      !(scene && scene.dynamicEntities instanceof Map && scene.dynamicEntities.has(candidateID))
    ) {
      return candidateID;
    }
  }
  return base + 99;
}

function buildKillableStructureEntity(instance, siteEntity, encounterPlan, spawnEntry, context = {}) {
  const typeID = Math.max(0, toInt(spawnEntry && spawnEntry.typeID, 0));
  if (typeID <= 0) {
    return null;
  }
  const typeRecord = resolveItemByTypeID(typeID);
  if (!typeRecord) {
    return null;
  }
  const siteID = Math.max(0, toInt(siteEntity && siteEntity.itemID, 0));
  const instanceID = Math.max(0, toInt(instance && instance.instanceID, 0));
  const itemID = Math.max(0, toInt(context.itemID, 0));
  if (siteID <= 0 || instanceID <= 0 || itemID <= 0) {
    return null;
  }
  const total = Math.max(1, toInt(context.total, 1));
  const index = Math.max(0, toInt(context.index, 0));
  const anchorPosition = clonePosition(
    context.anchorPosition && typeof context.anchorPosition === "object"
      ? context.anchorPosition
      : (siteEntity && siteEntity.position),
  );
  const exactOffset = spawnEntry && spawnEntry.positionOffset && typeof spawnEntry.positionOffset === "object"
    ? clonePosition(spawnEntry.positionOffset)
    : null;
  const contentOffset = exactOffset || buildContentOffset(
    `${siteID}:killable_structure:${normalizeText(encounterPlan && encounterPlan.key, "encounter")}`,
    index,
    total,
    {
      baseDistanceMeters: SITE_CONTENT_ENCOUNTER_OFFSET_METERS,
      jitterMeters: 6_000,
    },
  );
  const dunRotation = Array.isArray(spawnEntry && spawnEntry.dunRotation) &&
    spawnEntry.dunRotation.length === 3
    ? spawnEntry.dunRotation.map((value) => toFiniteNumber(value, 0))
    : null;
  const healthState = resolveTypeHealthState(typeID);
  const label =
    normalizeText(spawnEntry && spawnEntry.label, "") ||
    normalizeText(spawnEntry && spawnEntry.name, "") ||
    resolveTypeRecordName(typeRecord, "Mission Structure");
  const suppressSlimName = spawnEntry && spawnEntry.suppressSlimName === true;
  const slimLabel = suppressSlimName ? "" : label;
  return {
    kind: "siteKillableStructure",
    runtimeKind: "missionCombatStructure",
    dungeonMaterializedSiteContent: true,
    dungeonMaterializedKillableStructure: true,
    dungeonSiteID: siteID,
    dungeonSiteInstanceID: instanceID,
    dungeonEncounterKey: normalizeText(encounterPlan && encounterPlan.key, "") || null,
    dungeonSiteContentKey:
      normalizeText(spawnEntry && spawnEntry.key, "") ||
      `killable_structure:${normalizeText(encounterPlan && encounterPlan.key, "encounter")}:${index + 1}`,
    itemID,
    typeID: toInt(typeRecord && typeRecord.typeID, typeID) || typeID,
    groupID: toInt(typeRecord && typeRecord.groupID, 0) || 0,
    categoryID: toInt(typeRecord && typeRecord.categoryID, 0) || 0,
    graphicID: toInt(typeRecord && typeRecord.graphicID, 0) || null,
    ownerID: Math.max(0, toInt(spawnEntry && spawnEntry.ownerID, 0)) || SITE_CONTENT_OWNER_ID,
    itemName: slimLabel,
    slimName: slimLabel,
    suppressSlimName,
    dunObjectID: Math.max(0, toInt(spawnEntry && spawnEntry.dunObjectID, 0)) || undefined,
    ...(Object.prototype.hasOwnProperty.call(spawnEntry || {}, "dunObjectNameID")
      ? { dunObjectNameID: spawnEntry.dunObjectNameID }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(spawnEntry || {}, "nameID")
      ? { nameID: spawnEntry.nameID }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(spawnEntry || {}, "objectiveTargetGroup")
      ? { objectiveTargetGroup: spawnEntry.objectiveTargetGroup }
      : {}),
    dunPosition: [contentOffset.x, contentOffset.y, contentOffset.z],
    dunRotation: dunRotation || undefined,
    position: addVectors(anchorPosition, contentOffset),
    velocity: { x: 0, y: 0, z: 0 },
    direction: { x: 1, y: 0, z: 0 },
    radius: Math.max(250, toFiniteNumber(typeRecord && typeRecord.radius, 1_000)),
    shieldCapacity: healthState.shieldCapacity,
    armorHP: healthState.armorHP,
    structureHP: healthState.structureHP,
    conditionState: cloneValue(healthState.conditionState),
    staticVisibilityScope: "bubble",
  };
}

function spawnEncounterKillableStructures(scene, instance, siteEntity, encounterPlan, spawnEntries, options = {}) {
  const structures = [];
  const total = Math.max(1, normalizeArray(spawnEntries).length);
  for (let index = 0; index < total; index += 1) {
    const spawnEntry = spawnEntries[index];
    const entity = buildKillableStructureEntity(instance, siteEntity, encounterPlan, spawnEntry, {
      itemID: allocateKillableStructureEntityID(scene, siteEntity && siteEntity.itemID),
      anchorPosition: options.anchorPosition,
      index,
      total,
    });
    if (!entity) {
      continue;
    }
    if (scene.staticEntitiesByID && scene.staticEntitiesByID.has(Number(entity.itemID))) {
      continue;
    }
    if (!scene.addStaticEntity(entity)) {
      continue;
    }
    structures.push({
      entity,
      spawnEntry,
    });
  }
  if (
    structures.length > 0 &&
    options.broadcast !== false &&
    scene &&
    typeof scene.broadcastAddBalls === "function"
  ) {
    scene.broadcastAddBalls(
      structures.map((entry) => entry.entity),
      options.excludedSession || null,
    );
  }
  return structures;
}

function resolveGhostTimerPhaseSpec(populationHints) {
  for (const hazard of normalizeArray(populationHints?.hazards)) {
    const hiddenMinSeconds = Math.max(0, toInt(hazard?.hiddenTimerMinSeconds, 0));
    const hiddenMaxSeconds = Math.max(0, toInt(hazard?.hiddenTimerMaxSeconds, 0));
    const visibleWindowSeconds = Math.max(0, toInt(hazard?.visibleCountdownSeconds, 0));
    if (hiddenMinSeconds > 0 && hiddenMaxSeconds >= hiddenMinSeconds && visibleWindowSeconds > 0) {
      return { hiddenMinSeconds, hiddenMaxSeconds, visibleWindowSeconds };
    }
  }
  return null;
}

function resolveGhostTimerPlan(populationHints) {
  return resolveEncounterPlans(populationHints).find(plan => plan.trigger === "visible_countdown") || null;
}

function buildGhostTimerPhaseFields(plan, phaseSpec, armedAtMs) {
  const visibleWindowMs = phaseSpec.visibleWindowSeconds * 1000;
  const totalMs = Math.max(0, toInt(plan?.countdownSeconds, 0)) * 1000;
  const span = phaseSpec.hiddenMaxSeconds - phaseSpec.hiddenMinSeconds + 1;
  const hiddenMs = totalMs > visibleWindowMs ? totalMs - visibleWindowMs
    : (phaseSpec.hiddenMinSeconds + Math.floor(stableUnitInterval(`${plan?.key}:${totalMs}`) * span)) * 1000;
  return { hiddenUntilMs: armedAtMs + hiddenMs, visibleCountdownSeconds: phaseSpec.visibleWindowSeconds };
}

function resolveVisibleCountdownDueAtMs(state, plan) {
  const hiddenUntilMs = Math.max(0, toInt(state?.hiddenUntilMs, 0));
  const visibleSeconds = Math.max(0, toInt(state?.visibleCountdownSeconds, 0));
  return hiddenUntilMs > 0 && visibleSeconds > 0 ? hiddenUntilMs + visibleSeconds * 1000
    : Math.max(0, toInt(state?.armedAtMs, 0)) + Math.max(0, toInt(plan?.countdownSeconds, 0)) * 1000;
}

function resolveGhostTimerHiddenUntilMs(instance, populationHints, phaseSpec, fallbackArmedAtMs) {
  const plan = resolveGhostTimerPlan(populationHints);
  if (!plan) return 0;
  const state = getEncounterStateByKey(instance, plan.key);
  if (toInt(state?.hiddenUntilMs, 0) > 0) return state.hiddenUntilMs;
  const armedAtMs = Math.max(0, toInt(state?.armedAtMs, 0)) || Math.max(0, toInt(fallbackArmedAtMs, 0));
  return armedAtMs > 0 ? buildGhostTimerPhaseFields(plan, phaseSpec, armedAtMs).hiddenUntilMs : 0;
}

function isDeferredGhostTimerHazardEntity(entity) {
  return entity?.dungeonMaterializedHazard === true && toInt(entity.dungeonHazardHiddenTimerMinSeconds, 0) > 0;
}

function materializeDeferredGhostTimerHazards(scene, instance, siteEntity, populationHints, options = {}) {
  const phaseSpec = resolveGhostTimerPhaseSpec(populationHints);
  const plan = resolveGhostTimerPlan(populationHints);
  if (!scene || !instance || !siteEntity || !phaseSpec || !plan) return 0;
  instance = dungeonRuntime.getInstance(instance.instanceID) || instance;
  const nowMs = Math.max(1, toInt(options.nowMs, Date.now()));
  const state = getEncounterStateByKey(instance, plan.key);
  const hiddenUntilMs = resolveGhostTimerHiddenUntilMs(instance, populationHints, phaseSpec, state?.armedAtMs);
  if (!hiddenUntilMs || nowMs < hiddenUntilMs ||
      toInt(state?.triggeredEffectsAtMs, 0) > 0 || !isActiveLifecycleState(instance.lifecycleState)) return 0;
  // A failed reveal flush leaves all beacons hidden. Reconnects use the same
  // persisted phase times and cannot restart or shorten the countdown.
  if (toInt(state?.ghostTimerHazardsVisibleAtMs, 0) <= 0) {
    upsertEncounterState(instance.instanceID, plan.key, { ghostTimerHazardsVisibleAtMs: nowMs },
      { nowMs, durable: true, force: true });
  }
  const revealed = [];
  let spawned = 0;
  for (const entity of buildHazardEntities(instance, siteEntity, populationHints).filter(isDeferredGhostTimerHazardEntity)) {
    let live = scene.staticEntitiesByID?.get(Number(entity.itemID));
    // A committed reveal may have been interrupted before native admission.
    // Retry only the missing Ball, without resending an already visible one.
    if (live && live.dungeonGhostTimerHidden !== true) continue;
    if (!live) {
      scene.addStaticEntity(entity);
      live = scene.staticEntitiesByID?.get(Number(entity.itemID));
      if (!live) continue;
      spawned++;
    }
    live.dungeonGhostTimerHidden = false;
    revealed.push(live);
  }
  if (revealed.length) broadcastStaticSiteContentBatch(scene, revealed, { broadcast: true });
  return spawned;
}

function armDeferredEncounterPlans(instance, populationHints, options = {}) {
  const nowMs = Math.max(0, toInt(options.nowMs, Date.now()));
  const ghostTimerPhaseSpec = resolveGhostTimerPhaseSpec(populationHints);
  let armedCount = 0;
  for (const plan of resolveEncounterPlans(populationHints)) {
    // Both visible_countdown (UI timer) and timer (silent delay) arm at site load and fire after
    // their elapsed time; arm them here so the tick can spawn them when due.
    if (plan.trigger !== "visible_countdown" && plan.trigger !== "timer") {
      continue;
    }
    // Timers count from their ROOM's combat beginning, not from site load: the composer
    // authors delaySeconds relative to the room's first spawn burst (golden AIMEDs spawns
    // Group 2 ~20s after the player lands in pocket 2). A timer plan whose room has other
    // waves stays unarmed until one of them has spawned (= the player actually entered the
    // pocket; room auto-activation on previous-room-clear must not start the clock early).
    // A room with no other waves falls back to arming when the room itself activates.
    const planRoomKey = resolveEncounterRoomKey(instance, populationHints, plan);
    if (planRoomKey) {
      const planKey = normalizeText(plan.key, "");
      const siblingRoomPlans = resolveEncounterPlans(populationHints).filter((other) => (
        normalizeText(other && other.key, "") !== planKey &&
        other.trigger !== "timer" &&
        other.trigger !== "visible_countdown" &&
        resolveEncounterRoomKey(instance, populationHints, other) === planRoomKey
      ));
      if (siblingRoomPlans.length > 0) {
        const roomCombatBegun = siblingRoomPlans.some((other) => {
          const otherState = getEncounterStateByKey(instance, other.key);
          return Math.max(0, toInt(otherState && otherState.spawnedAtMs, 0)) > 0;
        });
        if (!roomCombatBegun) {
          continue;
        }
      } else {
        const planRoomState =
          instance.roomStatesByKey && instance.roomStatesByKey[planRoomKey];
        if (normalizeLowerText(planRoomState && planRoomState.state, "active") === "pending") {
          continue;
        }
      }
    }
    const existingState = getEncounterStateByKey(instance, plan.key);
    if (Math.max(0, toInt(existingState && existingState.armedAtMs, 0)) > 0) {
      continue;
    }
    if (Math.max(0, toInt(existingState && existingState.spawnedAtMs, 0)) > 0) {
      continue;
    }
    upsertEncounterState(instance.instanceID, plan.key, {
      armedAtMs: nowMs,
      ...(plan.trigger === "visible_countdown" && ghostTimerPhaseSpec
        ? buildGhostTimerPhaseFields(plan, ghostTimerPhaseSpec, nowMs) : {}),
      countdownSeconds: plan.countdownSeconds,
      delaySeconds: plan.delaySeconds,
      trigger: plan.trigger,
      waveIndex: plan.waveIndex,
      prerequisiteKey: plan.prerequisiteKey,
      lootProfile: plan.lootProfile,
      lootTags: plan.lootTags,
    }, { nowMs, ...(ghostTimerPhaseSpec && plan.trigger === "visible_countdown" ? { durable: true, force: true } : {}) });
    armedCount += 1;
  }
  return armedCount;
}

// 32-bit FNV-1a mapped to [0, 1). Chance waves must roll the same way every time a persisted
// instance is evaluated, so the roll cannot come from Math.random.
function stableUnitInterval(value) {
  let state = 0x811c9dc5;
  const text = String(value == null ? "" : value);
  for (let index = 0; index < text.length; index += 1) {
    state ^= text.charCodeAt(index);
    state = Math.imul(state, 0x01000193) >>> 0;
  }
  return (state >>> 0) / 4294967296;
}

function applyNpcSentryEncounterProgressPolicy(spawnedEntries) {
  for (const entry of normalizeArray(spawnedEntries)) {
    if (entry && isDestructibleNpcSentry(entry.entity)) {
      entry.encounterProgressBlocker = false;
      entry.entity.dungeonEncounterBlocksProgress = false;
    }
  }
  return spawnedEntries;
}

function spawnEncounterPlan(scene, instance, siteEntity, encounterPlan, options = {}) {
  if (!scene || !instance || !siteEntity || !encounterPlan || encounterPlan.supported !== true) {
    return 0;
  }
  const planKey = normalizeText(encounterPlan.key, "");
  if (!planKey) {
    return 0;
  }
  const instanceID = Math.max(0, toInt(instance && instance.instanceID, 0));
  const instanceSystemID = Math.max(
    0,
    toInt(instance && instance.solarSystemID, 0),
  );
  const siteID = Math.max(0, toInt(siteEntity && siteEntity.itemID, 0));
  if (
    instanceID <= 0 ||
    instanceSystemID <= 0 ||
    instanceSystemID !== toInt(scene && scene.systemID, 0) ||
    siteID <= 0
  ) {
    return 0;
  }
  const existingState = getEncounterStateByKey(instance, planKey);
  if (Math.max(0, toInt(existingState && existingState.spawnedAtMs, 0)) > 0) {
    return 0;
  }

  // A chance wave that fails its roll is recorded as spawned-and-cleared with no entities, so the
  // wave after it can still trigger and site completion still accounts for it.
  const spawnChance = Number(encounterPlan.spawnChance);
  if (Number.isFinite(spawnChance) && spawnChance > 0 && spawnChance < 1) {
    const chanceRoll = stableUnitInterval(`${instanceID}:${planKey}:spawn-chance`);
    if (chanceRoll >= spawnChance) {
      const rolledAtMs = Math.max(0, toInt(options.nowMs, Date.now()));
      upsertEncounterState(instance.instanceID, planKey, {
        armedAtMs: Math.max(0, toInt(existingState && existingState.armedAtMs, 0)) || rolledAtMs,
        spawnedAtMs: rolledAtMs,
        completedAtMs: rolledAtMs,
        completionTrigger: "spawn_chance_failed",
        spawnCount: 0,
        spawnedEntityIDs: [],
        remainingEntityIDs: [],
        chanceRoll,
        chanceRollFailed: true,
        trigger: normalizeText(options.trigger, encounterPlan.trigger),
        waveIndex: encounterPlan.waveIndex,
        prerequisiteKey: encounterPlan.prerequisiteKey || null,
        label: encounterPlan.label,
      }, { nowMs: rolledAtMs });
      return 0;
    }
  }

  if (!(scene._dungeonUniverseEncounterKeys instanceof Set)) {
    scene._dungeonUniverseEncounterKeys = new Set();
  }
  const encounterKey = `instance:${instanceID}:${planKey}`;
  if (scene._dungeonUniverseEncounterKeys.has(encounterKey)) {
    return 0;
  }

  const nowMs = Math.max(0, toInt(options.nowMs, Date.now()));
  const encounterScopeMetadata = {
    dungeonMaterializedSiteContent: true,
    dungeonSiteInstanceID: instanceID,
    dungeonSiteID: siteID,
    dungeonEncounterKey: encounterKey,
  };
  // Anchor encounter spawns to the plan's own room: exact log packs record each pocket's world
  // anchor in roomProfiles, so a gated pocket's wave belongs at that pocket — tens of thousands of
  // km off the warp-in grid — with the pack's per-NPC offsets relative to it. When the template
  // has no room positions, fall back to the trigger-supplied position (e.g. an acceleration
  // gate's destination point, so the player still arrives among the rats), then the site anchor.
  const template = dungeonAuthority.getTemplateByID(instance.templateID);
  const encounterAnchorPosition = clonePosition(
    resolveRoomWorldPositionForTemplate(
      siteEntity && siteEntity.position,
      template,
      normalizeText(encounterPlan.roomKey, ""),
    ) ||
    ((options.roomPosition && typeof options.roomPosition === "object")
      ? options.roomPosition
      : null) ||
    (siteEntity && siteEntity.position),
  );
  // Imported-log/pack encounters carry explicit per-NPC spawnEntries — each with its own ship typeID
  // (and, for log packs, an exact positionOffset). Spawn each NPC as its EXACT profile, resolved from the
  // entry's own identity (typeID/name) rather than the encounter's group-level baseProfileID (which is a
  // coarse, sometimes-wrong faction guess in decoded packs), at its exact position when given, else a
  // procedural offset. The encounter's group-level spawnQuery is only the per-entry last-resort fallback.
  // The scrape path carries no per-NPC spawnEntries on the plan, so it uses the procedural batch below,
  // whose spawnQuery is already the exact profile (resolved upstream in normalizeMissionSpawnQuery).
  const encounterFallbackQuery = normalizeText(encounterPlan.spawnQuery, "npc_hostiles");
  const explicitSpawnEntries = normalizeArray(encounterPlan.spawnEntries)
    .filter((entry) => entry && typeof entry === "object")
    .slice(0, resolveEncounterSpawnEntryLimit(encounterPlan));
  const structureSpawnEntries = explicitSpawnEntries.filter(isKillableStructureSpawnEntry);
  const identitySpawnEntries = explicitSpawnEntries.filter((entry) => !isKillableStructureSpawnEntry(entry));
  const hasNpcEntries = identitySpawnEntries.length > 0 || explicitSpawnEntries.length <= 0;
  const needsNpcSpawnService = hasNpcEntries;
  const npcSpawnService = needsNpcSpawnService ? getNpcSpawnService() : null;
  const populationHints = resolvePopulationHints(instance, template);
  const completion = normalizeCompletionHints(populationHints);
  if (
    needsNpcSpawnService &&
    (!npcSpawnService || typeof npcSpawnService.spawnNpcBatchInSystem !== "function")
  ) {
    return 0;
  }
  const aggregatedSpawns = [];
  let lastSpawnFailure = null;
  if (identitySpawnEntries.length > 0) {
    for (let entryIndex = 0; entryIndex < identitySpawnEntries.length; entryIndex += 1) {
      const entry = identitySpawnEntries[entryIndex];
      const entryPosition = (entry.positionOffset && typeof entry.positionOffset === "object")
        ? addVectors(encounterAnchorPosition, entry.positionOffset)
        : addVectors(
            encounterAnchorPosition,
            buildContentOffset(
              `${encounterKey}:entry:${entryIndex}`,
              entryIndex,
              identitySpawnEntries.length,
              {
                baseDistanceMeters: SITE_CONTENT_ENCOUNTER_OFFSET_METERS,
                jitterMeters: 8_000,
              },
            ),
          );
      const singleSpawn = npcSpawnService.spawnNpcBatchInSystem(scene.systemID, {
        profileQuery: resolveSpawnIdentityProfileQuery(entry, encounterFallbackQuery),
        amount: 1,
        transient: true,
        position: encounterAnchorPosition,
        spawnStateOverride: { position: entryPosition },
        slimNameOverride: Object.prototype.hasOwnProperty.call(entry || {}, "slimName")
          ? entry.slimName
          : undefined,
        suppressSlimName: entry && entry.suppressSlimName === true,
        nameIDOverride: Math.max(0, toInt(entry && entry.nameID, 0)) || undefined,
        anchorName: `${normalizeText(siteEntity && siteEntity.itemName, "Site")} ${normalizeText(entry.label || encounterPlan.label, "Encounter")}`,
        runtimeKind: "nativeCombat",
        entityScopeMetadata: encounterScopeMetadata,
        broadcast: options.broadcast !== false,
      });
      if (singleSpawn && singleSpawn.success && singleSpawn.data && Array.isArray(singleSpawn.data.spawned)) {
        aggregatedSpawns.push(...singleSpawn.data.spawned);
      } else if (singleSpawn) {
        lastSpawnFailure = singleSpawn;
      }
    }
  } else if (explicitSpawnEntries.length <= 0) {
    const proceduralSpawnResult = npcSpawnService.spawnNpcBatchInSystem(scene.systemID, {
      profileQuery: encounterFallbackQuery,
      amount: Math.max(
        1,
        Math.min(
          resolveEncounterSpawnEntryLimit(encounterPlan),
          toInt(encounterPlan.amount, 3),
        ),
      ),
      transient: true,
      position: addVectors(
        encounterAnchorPosition,
        buildContentOffset(
          `${encounterKey}:encounter`,
          Math.max(0, toInt(encounterPlan.waveIndex, 1)) - 1,
          Math.max(1, toInt(options.totalPlans, 1)),
          {
            baseDistanceMeters: SITE_CONTENT_ENCOUNTER_OFFSET_METERS,
            jitterMeters: 8_000,
          },
        ),
      ),
      anchorName: `${normalizeText(siteEntity && siteEntity.itemName, "Site")} ${normalizeText(encounterPlan.label, "Encounter")}`,
      spreadMeters: 8_000,
      formationSpacingMeters: 2_500,
      runtimeKind: "nativeCombat",
      entityScopeMetadata: encounterScopeMetadata,
      broadcast: options.broadcast !== false,
    });
    if (
      proceduralSpawnResult &&
      proceduralSpawnResult.success &&
      proceduralSpawnResult.data &&
      Array.isArray(proceduralSpawnResult.data.spawned)
    ) {
      aggregatedSpawns.push(...proceduralSpawnResult.data.spawned);
    } else if (proceduralSpawnResult) {
      lastSpawnFailure = proceduralSpawnResult;
    }
    const fallbackSpawnQuery = normalizeText(encounterPlan.fallbackSpawnQuery, "");
    if (
      aggregatedSpawns.length <= 0 &&
      fallbackSpawnQuery &&
      normalizeLowerText(fallbackSpawnQuery, "") !== normalizeLowerText(encounterFallbackQuery, "")
    ) {
      const fallbackSpawnResult = npcSpawnService.spawnNpcBatchInSystem(scene.systemID, {
        profileQuery: fallbackSpawnQuery,
        amount: Math.max(
          1,
          Math.min(
            resolveEncounterSpawnEntryLimit(encounterPlan),
            toInt(encounterPlan.amount, 3),
          ),
        ),
        transient: true,
        position: addVectors(
          encounterAnchorPosition,
          buildContentOffset(
            `${encounterKey}:encounter:fallback`,
            Math.max(0, toInt(encounterPlan.waveIndex, 1)) - 1,
            Math.max(1, toInt(options.totalPlans, 1)),
            {
              baseDistanceMeters: SITE_CONTENT_ENCOUNTER_OFFSET_METERS,
              jitterMeters: 8_000,
            },
          ),
        ),
        anchorName: `${normalizeText(siteEntity && siteEntity.itemName, "Site")} ${normalizeText(encounterPlan.label, "Encounter")}`,
        spreadMeters: 8_000,
        formationSpacingMeters: 2_500,
        runtimeKind: "nativeCombat",
        entityScopeMetadata: encounterScopeMetadata,
        broadcast: options.broadcast !== false,
      });
      if (
        fallbackSpawnResult &&
        fallbackSpawnResult.success &&
        fallbackSpawnResult.data &&
        Array.isArray(fallbackSpawnResult.data.spawned)
      ) {
        aggregatedSpawns.push(...fallbackSpawnResult.data.spawned);
      } else if (fallbackSpawnResult) {
        lastSpawnFailure = fallbackSpawnResult;
      }
    }
  }
  if (structureSpawnEntries.length > 0) {
    const structureSpawns = spawnEncounterKillableStructures(
      scene,
      instance,
      siteEntity,
      encounterPlan,
      structureSpawnEntries,
      {
        anchorPosition: encounterAnchorPosition,
        broadcast: options.broadcast,
        excludedSession: options.excludedSession || null,
      },
    )
      .map((entry) => ({
        ...entry,
        encounterProgressBlocker: shouldKillableStructureBlockEncounterProgress(
          entry && entry.spawnEntry,
          encounterPlan,
          {
            hasNpcEntries,
          },
        ),
        objectiveProgressBlocker: isObjectiveTargetSpawnEntry(
          entry && entry.spawnEntry,
          encounterPlan,
          completion,
        ),
      }));
    for (const entry of structureSpawns) {
      if (entry && entry.entity) {
        entry.entity.dungeonEncounterBlocksProgress = entry.encounterProgressBlocker !== false;
        entry.entity.dungeonObjectiveProgressTarget = entry.objectiveProgressBlocker === true;
        if (entry.objectiveProgressBlocker === true && entry.spawnEntry) {
          entry.entity.dungeonObjectiveTargetKey =
            normalizeText(entry.spawnEntry.key, "") ||
            normalizeText(entry.spawnEntry.label, "") ||
            null;
        }
      }
    }
    aggregatedSpawns.push(...structureSpawns);
  }
  applyNpcSentryEncounterProgressPolicy(aggregatedSpawns);
  const spawnResult = aggregatedSpawns.length > 0
    ? { success: true, data: { spawned: aggregatedSpawns } }
    : (lastSpawnFailure || { success: false, errorMsg: "ENCOUNTER_SPAWN_FAILED" });
  if (
    !spawnResult ||
    !spawnResult.success ||
    !spawnResult.data ||
    !Array.isArray(spawnResult.data.spawned) ||
    spawnResult.data.spawned.length <= 0
  ) {
    upsertEncounterState(instance.instanceID, planKey, {
      lastAttemptAtMs: nowMs,
    }, { nowMs });
    return 0;
  }

  scene._dungeonUniverseEncounterKeys.add(encounterKey);
  const spawnedEntityIDs = normalizeIDList(
    spawnResult.data.spawned
      .map((entry) => toInt(entry && entry.entity && entry.entity.itemID, 0))
      .filter((entry) => entry > 0),
  );
  const remainingEntityIDs = normalizeIDList(
    spawnResult.data.spawned
      .filter((entry) => !(entry && entry.encounterProgressBlocker === false))
      .map((entry) => toInt(entry && entry.entity && entry.entity.itemID, 0))
      .filter((entry) => entry > 0),
  );
  const objectiveBlockingEntityIDs = normalizeIDList(
    spawnResult.data.spawned
      .filter((entry) => entry && entry.objectiveProgressBlocker === true)
      .map((entry) => toInt(entry && entry.entity && entry.entity.itemID, 0))
      .filter((entry) => entry > 0),
  );
  const plans = resolveEncounterPlans(populationHints);
  const currentRoomKey = resolveEncounterRoomKey(
    dungeonRuntime.getInstance(instance.instanceID) || instance,
    { encounters: plans },
    encounterPlan,
  );
  try {
    dungeonRuntime.activateRoom(instance.instanceID, currentRoomKey, {
      nowMs,
      stage: currentRoomKey === "room:entry" ? "entry" : "pocket",
    });
  } catch (error) {
    // ignored: some site templates have no explicit room progression beyond the entry state.
  }
  const totalWaves = Math.max(
    1,
    plans.reduce((highest, plan) => Math.max(highest, toInt(plan && plan.waveIndex, 1)), 1),
  );
  if (
    instance &&
    instance.objectiveState &&
    ["seeded", "in_progress"].includes(normalizeLowerText(instance.objectiveState.state, ""))
  ) {
    const existingCounters =
      instance.objectiveState && instance.objectiveState.counters && typeof instance.objectiveState.counters === "object"
        ? instance.objectiveState.counters
        : {};
    const existingMetadata =
      instance.objectiveState && instance.objectiveState.metadata && typeof instance.objectiveState.metadata === "object"
        ? instance.objectiveState.metadata
        : {};
    dungeonRuntime.advanceObjective(instance.instanceID, {
      state: "in_progress",
      counters: {
        ...cloneValue(existingCounters),
        current_wave: Math.max(1, toInt(encounterPlan.waveIndex, 1)),
        total_waves: totalWaves,
      },
      metadata: {
        ...cloneValue(existingMetadata),
        currentRoomKey,
        currentWave: Math.max(1, toInt(encounterPlan.waveIndex, 1)),
        totalWaves,
      },
    }, { nowMs });
  }
  upsertEncounterState(instance.instanceID, planKey, {
    armedAtMs: Math.max(0, toInt(existingState && existingState.armedAtMs, 0)) || nowMs,
    spawnedAtMs: nowMs,
    spawnCount: spawnResult.data.spawned.length,
    spawnedEntityIDs,
    remainingEntityIDs,
    nonBlockingEntityIDs: spawnedEntityIDs.filter((entityID) => !remainingEntityIDs.includes(entityID)),
    objectiveBlockingEntityIDs,
    nonObjectiveEntityIDs: spawnedEntityIDs.filter((entityID) => !objectiveBlockingEntityIDs.includes(entityID)),
    // Identity of each spawn, kept so an entity_killed wave can tell WHICH of this wave's ships
    // died: once a ship is destroyed it is gone from the scene, and its entityID alone says nothing.
    spawnedIdentitiesByEntityID: buildSpawnedIdentityMap(spawnResult.data.spawned),
    trigger: normalizeText(options.trigger, encounterPlan.trigger),
    waveIndex: encounterPlan.waveIndex,
    prerequisiteKey: encounterPlan.prerequisiteKey || null,
    lootProfile: encounterPlan.lootProfile,
    lootTags: encounterPlan.lootTags,
    roomKey: currentRoomKey,
    label: encounterPlan.label,
    notes: encounterPlan.notes,
  }, { nowMs });
  sendEncounterTriggerNotifications(scene, instance, encounterPlan, {
    ...options,
    nowMs,
  });
  return spawnResult.data.spawned.length;
}

function processEncounterPlansForTrigger(scene, instance, siteEntity, populationHints, trigger, options = {}) {
  const normalizedTrigger = normalizeLowerText(trigger, "");
  if (!normalizedTrigger) {
    return 0;
  }
  const triggerRoomKey = normalizeText(
    options.roomKey || options.currentRoomKey || options.destinationRoomKey,
    "",
  );
  const plans = resolveEncounterPlans(populationHints);
  const triggeredPlans = plans
    .filter((plan) => {
      if (plan.trigger !== normalizedTrigger) {
        return false;
      }
      if (!triggerRoomKey) {
        return true;
      }
      return resolveEncounterRoomKey(instance, populationHints, plan) === triggerRoomKey;
    });
  if (triggeredPlans.length <= 0) {
    return 0;
  }
  const nowMs = Math.max(0, toInt(options.nowMs, Date.now()));
  let encountersSpawned = 0;
  for (const plan of triggeredPlans) {
    if (normalizedTrigger === "visible_countdown") {
      const state = getEncounterStateByKey(instance, plan.key);
      const armedAtMs = Math.max(0, toInt(state && state.armedAtMs, 0));
      if (armedAtMs <= 0) {
        continue;
      }
      if (nowMs < resolveVisibleCountdownDueAtMs(state, plan)) {
        continue;
      }
    }
    if (normalizedTrigger === "timer") {
      // Silent delayed spawn: fire once delaySeconds have elapsed since the encounter was armed
      // (site load). delaySeconds<=0 fires on the next tick (immediate reinforcement).
      const state = getEncounterStateByKey(instance, plan.key);
      const armedAtMs = Math.max(0, toInt(state && state.armedAtMs, 0));
      if (armedAtMs <= 0) {
        continue;
      }
      const delayMs = Math.max(0, toInt(plan.delaySeconds, 0)) * 1000;
      if (delayMs > 0 && nowMs < armedAtMs + delayMs) {
        continue;
      }
    }
    if (normalizedTrigger === "entity_killed") {
      // TQ fires this wave on ONE named ship of the prior wave dying, not on the wave clearing.
      // The rest of that wave can still be alive - that is the whole point of a trigger ship.
      const prerequisiteKeys = resolveEncounterPrerequisiteKeys(plans, plan);
      if (prerequisiteKeys.length <= 0) {
        continue;
      }
      if (
        !hasEncounterTriggerEntityBeenKilled(
          scene,
          instance,
          plans,
          prerequisiteKeys,
          plan.triggerEntity,
        )
      ) {
        continue;
      }
    }
    if (normalizedTrigger === "wave_cleared" || normalizedTrigger === "battleships_destroyed") {
      const prerequisiteKeys = resolveEncounterPrerequisiteKeys(plans, plan);
      if (prerequisiteKeys.length <= 0) {
        continue;
      }
      let prerequisiteBlocked = false;
      for (const prerequisiteKey of prerequisiteKeys) {
        const prerequisiteState = getEncounterStateByKey(instance, prerequisiteKey);
        const prerequisiteSpawnedAtMs = Math.max(0, toInt(prerequisiteState && prerequisiteState.spawnedAtMs, 0));
        if (prerequisiteSpawnedAtMs <= 0) {
          prerequisiteBlocked = true;
          break;
        }
        const prerequisitePlan = plans.find((entry) => normalizeText(entry && entry.key, "") === prerequisiteKey) || null;
        const aliveEntityIDs = listAliveEncounterEntityIDs(scene, prerequisiteState, prerequisitePlan);
        if (aliveEntityIDs.length > 0) {
          if (!areSortedNumberListsEqual(prerequisiteState && prerequisiteState.remainingEntityIDs, aliveEntityIDs)) {
            upsertEncounterState(instance.instanceID, prerequisiteKey, {
              remainingEntityIDs: aliveEntityIDs,
            }, { nowMs });
          }
          prerequisiteBlocked = true;
          break;
        }
        if (Math.max(0, toInt(prerequisiteState && prerequisiteState.completedAtMs, 0)) <= 0) {
          upsertEncounterState(instance.instanceID, prerequisiteKey, {
            remainingEntityIDs: [],
            completedAtMs: nowMs,
            completionTrigger: normalizedTrigger,
          }, { nowMs });
        }
      }
      if (prerequisiteBlocked) {
        continue;
      }
    }
    if (normalizedTrigger === "container_hacked") {
      // Sleeper data/relic defenders answer a hack: the first hack of any container, or of one
      // of the listed client objects only (a Talocan hull's guard).
      const wantedObjectIDs = normalizeIDList(plan.triggerContainerObjectIDs);
      const hackedObjectID = Math.max(0, toInt(options.hackedContainerDunObjectID, 0));
      if (wantedObjectIDs.length > 0 && !wantedObjectIDs.includes(hackedObjectID)) {
        continue;
      }
    }
    encountersSpawned += spawnEncounterPlan(scene, instance, siteEntity, plan, {
      ...options,
      nowMs,
      trigger: normalizedTrigger,
      totalPlans: plans.length,
    });
  }
  return encountersSpawned;
}

function hasDueVisibleCountdownTrigger(instance, populationHints, options = {}) {
  const nowMs = Math.max(0, toInt(options.nowMs, Date.now()));
  for (const plan of resolveEncounterPlans(populationHints)) {
    if (normalizeLowerText(plan && plan.trigger, "") !== "visible_countdown") {
      continue;
    }
    const state = getEncounterStateByKey(instance, plan.key);
    const armedAtMs = Math.max(0, toInt(state && state.armedAtMs, 0));
    const triggeredAtMs = Math.max(0, toInt(state && state.triggeredEffectsAtMs, 0));
    if (armedAtMs <= 0 || triggeredAtMs > 0) {
      continue;
    }
    if (nowMs >= resolveVisibleCountdownDueAtMs(state, plan)) {
      return true;
    }
  }
  return false;
}

function maybeAdvanceEncounterDrivenProgression(instance, populationHints, options = {}) {
  if (!instance) {
    return {
      roomsCompleted: 0,
      gatesUnlocked: 0,
      roomsActivated: 0,
    };
  }
  const plans = resolveEncounterPlans(populationHints)
    .filter((plan) => plan.supported === true);
  if (plans.length <= 0) {
    return {
      roomsCompleted: 0,
      gatesUnlocked: 0,
      roomsActivated: 0,
    };
  }
  const latestInstance = dungeonRuntime.getInstance(instance.instanceID) || instance;
  const groupedPlans = groupEncounterPlansByRoom(latestInstance, populationHints);
  const orderedRoomKeys = listOrderedInstanceRoomKeys(latestInstance);
  const orderedGateKeys = listOrderedInstanceGateKeys(latestInstance);
  const nowMs = Math.max(0, toInt(options.nowMs, Date.now()));
  let roomsCompleted = 0;
  let gatesUnlocked = 0;
  let roomsActivated = 0;
  let settledPlanCount = 0;

  const settledPlansByKey = {};
  for (const plan of plans) {
    const settled = isEncounterPlanSettled(latestInstance, plan);
    settledPlansByKey[plan.key] = settled;
    if (settled) {
      settledPlanCount += 1;
    }
  }
  const completionSatisfied = isEncounterCompletionSatisfied(latestInstance, plans, populationHints);

  let workingInstance = latestInstance;
  orderedRoomKeys.forEach((roomKey, roomIndex) => {
    const roomPlans = normalizeArray(groupedPlans[roomKey]);
    if (roomPlans.length <= 0) {
      return;
    }
    const roomState = workingInstance.roomStatesByKey && workingInstance.roomStatesByKey[roomKey];
    const roomSettled = roomPlans.every((plan) => settledPlansByKey[plan.key] === true);
    if (!roomSettled) {
      return;
    }
    if (roomState && normalizeLowerText(roomState.state, "") !== "completed") {
      workingInstance = dungeonRuntime.completeRoom(workingInstance.instanceID, roomKey, {
        nowMs,
        stage: roomKey === "room:entry" ? "entry" : "pocket",
      });
      roomsCompleted += 1;
    }
    const nextRoomKey = orderedRoomKeys[roomIndex + 1] || null;
    if (!nextRoomKey) {
      return;
    }
    const nextRoomState = workingInstance.roomStatesByKey && workingInstance.roomStatesByKey[nextRoomKey];
    const gateKey = orderedGateKeys.find((candidateGateKey) => {
      const gateState = workingInstance.gateStatesByKey && workingInstance.gateStatesByKey[candidateGateKey];
      return normalizeText(gateState && gateState.destinationRoomKey, "") === nextRoomKey;
    }) || orderedGateKeys[roomIndex] || null;
    if (gateKey) {
      const gateState = workingInstance.gateStatesByKey && workingInstance.gateStatesByKey[gateKey];
      if (normalizeLowerText(gateState && gateState.state, "") === "locked") {
        workingInstance = dungeonRuntime.unlockGate(workingInstance.instanceID, gateKey, {
          nowMs,
          destinationRoomKey: nextRoomKey,
        });
        gatesUnlocked += 1;
      }
    }
    if (nextRoomState && normalizeLowerText(nextRoomState.state, "") === "pending") {
      workingInstance = dungeonRuntime.activateRoom(workingInstance.instanceID, nextRoomKey, {
        nowMs,
        stage: roomIndex + 1 >= orderedRoomKeys.length - 1 ? "final_pocket" : "pocket",
      });
      roomsActivated += 1;
    }
  });

  const refreshedInstance = dungeonRuntime.getInstance(instance.instanceID) || workingInstance;
  if (refreshedInstance && refreshedInstance.objectiveState) {
    const existingCounters =
      refreshedInstance.objectiveState.counters && typeof refreshedInstance.objectiveState.counters === "object"
        ? refreshedInstance.objectiveState.counters
        : {};
    const existingMetadata =
      refreshedInstance.objectiveState.metadata && typeof refreshedInstance.objectiveState.metadata === "object"
        ? refreshedInstance.objectiveState.metadata
        : {};
    const nextPatch = {
      state: completionSatisfied ? "completed" : "in_progress",
      counters: {
        ...cloneValue(existingCounters),
        current_wave: Math.max(0, settledPlanCount),
        total_waves: Math.max(1, plans.length),
        rooms_completed: Object.values(refreshedInstance.roomStatesByKey || {})
          .filter((roomState) => normalizeLowerText(roomState && roomState.state, "") === "completed")
          .length,
      },
      metadata: {
        ...cloneValue(existingMetadata),
        currentWave: Math.max(0, settledPlanCount),
        totalWaves: Math.max(1, plans.length),
        completionEncounterKeys: resolveCompletionEncounterKeys(
          normalizeCompletionHints(populationHints),
          plans,
        ),
      },
    };
    const currentComparableObjectiveState = {
      state: normalizeLowerText(refreshedInstance.objectiveState.state, "pending"),
      counters: cloneValue(existingCounters),
      metadata: {
        ...cloneValue(existingMetadata),
      },
      completedAtMs: Math.max(
        0,
        toInt(refreshedInstance.objectiveState.completedAtMs, 0),
      ),
    };
    delete currentComparableObjectiveState.metadata.lastAdvancedAtMs;
    delete currentComparableObjectiveState.metadata.lastProgressionAtMs;
    const nextComparableObjectiveState = {
      state: normalizeLowerText(nextPatch.state, "pending"),
      counters: cloneValue(nextPatch.counters),
      metadata: {
        ...cloneValue(nextPatch.metadata),
      },
      completedAtMs: Math.max(
        0,
        toInt(refreshedInstance.objectiveState.completedAtMs, 0),
      ),
    };
    if (completionSatisfied) {
      const existingCompletedAtMs = Math.max(
        0,
        toInt(refreshedInstance.objectiveState.completedAtMs, 0),
      );
      const nextCompletedAtMs = existingCompletedAtMs > 0 ? existingCompletedAtMs : nowMs;
      nextComparableObjectiveState.completedAtMs = nextCompletedAtMs;
      nextPatch.completedAtMs = nextCompletedAtMs;
    }
    if (
      !isDeepStrictEqual(
        currentComparableObjectiveState,
        nextComparableObjectiveState,
      )
    ) {
      nextPatch.metadata.lastProgressionAtMs = nowMs;
      dungeonRuntime.advanceObjective(refreshedInstance.instanceID, nextPatch, {
        nowMs,
      });
    }
    if (completionSatisfied) {
      sendCompletionTriggerNotifications(
        options.scene || null,
        dungeonRuntime.getInstance(refreshedInstance.instanceID) || refreshedInstance,
        populationHints,
        {
          nowMs,
          session: options.session || null,
        },
      );
    }
  }
  return {
    roomsCompleted,
    gatesUnlocked,
    roomsActivated,
  };
}

const GHOST_SITE_EXPLOSION_MIN_DAMAGE = 6000;
const GHOST_SITE_EXPLOSION_MAX_DAMAGE = 12000;
const GHOST_SITE_EXPLOSION_RANGE_METERS = 10000;
const SLEEPER_TOXIC_CLOUD_DAMAGE_BY_TIER = Object.freeze({ limited: 200, standard: 400, superior: 800 });

function listPilotedShips(scene) {
  return scene?.dynamicEntities instanceof Map ? [...scene.dynamicEntities.values()].filter(entity =>
    entity?.kind === "ship" && entity.position &&
    (toInt(entity.charID, 0) > 0 || toInt(entity.characterID, 0) > 0 || entity.session)) : [];
}

function isPositionWithinRangeSquared(position, sourcePosition, rangeSquared) {
  const dx = toFiniteNumber(position.x, 0) - toFiniteNumber(sourcePosition.x, 0);
  const dy = toFiniteNumber(position.y, 0) - toFiniteNumber(sourcePosition.y, 0);
  const dz = toFiniteNumber(position.z, 0) - toFiniteNumber(sourcePosition.z, 0);
  return dx * dx + dy * dy + dz * dz <= rangeSquared;
}

function closeHackingAttemptsForExplodedCans(scene, cans, trigger, options = {}) {
  return require("../exploration/hackingMgrService").failActiveAttemptsForSceneEntities(
    scene, cans.map(entity => entity.itemID), `site_${trigger}`, options);
}

// Commit the disappearance and claim each blast in the same durable site
// record before touching health or publishing a closed hacking window. A
// removal retry cannot charge the blast twice, even after a cold rebuild.
function buildPreparedSiteHazardHits(scene, instance, source, prefix, atMs, rangeMeters, damageForShip, sourceName) {
  const events = [];
  for (const ship of listPilotedShips(scene)) {
    if (ship.persistSpaceState !== true ||
        require("../../space/runtime/combatDestruction").isRuntimeEntityDestroyingOrDestroyed(ship) ||
        !require("../../space/combat/damage").hasDamageableHealth(ship)) continue;
    if (!source.position || !canEntitiesInteractLocally(source, ship) ||
        !isPositionWithinRangeSquared(ship.position, source.position, rangeMeters ** 2)) continue;
    events.push({ eventID: `${prefix}:${ship.itemID}`, atMs, sourceName,
      source: { itemID: source.itemID, position: clonePosition(source.position),
        dungeonMaterializedSiteContent: true, dungeonSiteID: source.dungeonSiteID,
        dungeonSiteInstanceID: instance.instanceID, ...buildSiteHazardPrivateScope(source) },
      rawDamage: damageForShip(ship),
      target: require("../../space/runtime/siteHazardDamage").prepareTarget(scene, ship) });
  }
  return events;
}

function claimGhostSiteExplosions(scene, instance, cans, nowMs, options = {}) {
  const latest = dungeonRuntime.getInstance(instance.instanceID);
  if (!latest) throw new Error("SITE_EXPLOSION_INSTANCE_REQUIRED");
  const refs = { ...getContentEntityRefsByKey(latest) };
  const blasts = { ...normalizeObject(latest.spawnState?.siteExplosionClaims) };
  const events = [];
  for (const entity of cans) {
    const key = normalizeText(entity.dungeonSiteContentKey, "");
    if (!key) throw new Error("SITE_EXPLOSION_CONTAINER_IDENTITY_REQUIRED");
    refs[key] = { ...normalizeObject(refs[key]), itemID: entity.itemID, contentKey: key,
      resolvedAtMs: refs[key]?.resolvedAtMs || nowMs };
    if (!Object.hasOwn(blasts, key)) {
      blasts[key] = { claimedAtMs: nowMs, itemID: entity.itemID };
      if (options.ghostSite || entity.dungeonSiteContentFailureExplodes === true) {
        events.push(...buildPreparedSiteHazardHits(scene, instance, entity,
          `${instance.instanceID}:ghost:${key}`, nowMs, GHOST_SITE_EXPLOSION_RANGE_METERS, ship => ({
            explosive: GHOST_SITE_EXPLOSION_MIN_DAMAGE + Math.floor(
              stableUnitInterval(`${entity.itemID}:${ship.itemID}:${nowMs}`) *
              (GHOST_SITE_EXPLOSION_MAX_DAMAGE - GHOST_SITE_EXPLOSION_MIN_DAMAGE + 1)),
          }), "Container Explosion"));
      }
    }
  }
  require("./siteHazardOutcomes").prepareEvents(instance, events, { nowMs,
    spawnPatch: { contentEntityRefsByKey: refs, siteExplosionClaims: blasts } });
  return events;
}

function resolveSleeperToxicCloudSpec(populationHints) {
  return normalizeArray(populationHints?.hazards).find(hazard =>
    normalizeLowerText(hazard?.kind, "") === "sleeper_toxic_cloud") || null;
}

function materializeSleeperToxicClouds(scene, instance, siteEntity, populationHints, options = {}) {
  const spec = resolveSleeperToxicCloudSpec(populationHints);
  if (!spec || !scene?.addStaticEntity || !siteEntity) return 0;
  const nowMs = Math.max(1, toInt(options.nowMs, Date.now()));
  let record = dungeonRuntime.getInstance(instance.instanceID)?.hazardState?.sleeperToxicCloud;
  if (!record) {
    if (options.restoreOnly) return 0;
    const source = options.failedEntity || listMaterializedUniverseSiteContentEntities(scene,
      { instanceID: instance.instanceID, siteID: siteEntity.itemID }).find(entity => entity.dungeonMaterializedContainer) || siteEntity;
    const intervalMs = Math.max(1000, toInt(spec.tickIntervalMs, 4000));
    const ticksTotal = Math.max(1, toInt(spec.ticksTotal, 10));
    record = { createdAtMs: nowMs, expiresAtMs: nowMs + intervalMs * ticksTotal,
      intervalMs, ticksTotal, ticksDone: 0, position: clonePosition(source.position),
      scope: { ...buildSiteHazardPrivateScope(siteEntity), ...buildSiteHazardPrivateScope(source) },
      damagePerTick: Math.max(1, toInt(spec.damagePerTick,
        SLEEPER_TOXIC_CLOUD_DAMAGE_BY_TIER[normalizeLowerText(spec.tier, "standard")] || 400)),
      rangeMeters: Math.max(1000, toInt(spec.rangeMeters, 7500)) };
    dungeonRuntime.mergeHazardState(instance.instanceID, { sleeperToxicCloud: record },
      { nowMs, durable: true, force: true });
  }
  if (nowMs >= record.expiresAtMs) return 0;
  const itemID = SITE_CONTENT_HAZARD_ID_BASE + siteEntity.itemID * 100 + 90;
  if (scene.staticEntitiesByID?.has(itemID)) return 0;
  const entity = { kind: "siteToxicCloud", dungeonMaterializedSiteContent: true,
    dungeonMaterializedHazard: true, dungeonHazardToxicCloud: true,
    dungeonSiteID: siteEntity.itemID, dungeonSiteInstanceID: instance.instanceID,
    dungeonSiteContentHazard: "sleeper_toxic_cloud", ...record.scope,
    dungeonHazardDamagePerTick: record.damagePerTick, dungeonHazardRangeMeters: record.rangeMeters,
    dungeonHazardTickIntervalMs: record.intervalMs, dungeonHazardTicksTotal: record.ticksTotal,
    dungeonHazardTicksDone: record.ticksDone,
    dungeonHazardNextTickAtMs: record.createdAtMs + (record.ticksDone + 1) * record.intervalMs,
    dungeonHazardExpiresAtMs: record.expiresAtMs, itemID,
    typeID: toInt(siteEntity.typeID, COSMIC_SIGNATURE_TYPE_ID) || COSMIC_SIGNATURE_TYPE_ID,
    groupID: toInt(siteEntity.groupID, COSMIC_SIGNATURE_GROUP_ID) || COSMIC_SIGNATURE_GROUP_ID,
    categoryID: toInt(siteEntity.categoryID, 16) || 16, ownerID: SITE_CONTENT_OWNER_ID,
    itemName: "Toxic Gas Cloud", slimName: "Toxic Gas Cloud", position: clonePosition(record.position),
    velocity: { x: 0, y: 0, z: 0 }, direction: { x: 1, y: 0, z: 0 }, radius: 3000,
    staticVisibilityScope: "bubble" };
  scene.addStaticEntity(entity);
  if (!scene.staticEntitiesByID?.has(itemID)) return 0;
  broadcastStaticSiteContentBatch(scene, [entity], { broadcast: true });
  return 1;
}

function processToxicCloudHazards(scene, options = {}) {
  const result = { ticks: 0, damageHits: 0, dissipated: 0 };
  if (!(scene?.staticEntitiesByID instanceof Map)) return result;
  const nowMs = Math.max(1, toInt(options.nowMs, Date.now()));
  for (const cloud of scene.staticEntitiesByID.values()) {
    if (cloud.dungeonHazardToxicCloud !== true) continue;
    const instance = dungeonRuntime.getInstance(cloud.dungeonSiteInstanceID);
    const recovered = require("./siteHazardOutcomes").replayPendingSiteHazardDamage(instance, { scene, nowMs });
    if (!recovered.success) throw new Error(recovered.errorMsg);
    result.damageHits += recovered.delivered;
    const previous = instance?.hazardState?.sleeperToxicCloud;
    if (!previous) continue;
    const due = Math.min(previous.ticksTotal, Math.floor((nowMs - previous.createdAtMs) / previous.intervalMs));
    if (due > previous.ticksDone) {
      const latest = dungeonRuntime.getInstance(instance.instanceID) || instance;
      const markers = { ...normalizeObject(latest.spawnState?.siteHazardDamageTicksByID) };
      const savedEvents = normalizeObject(latest.spawnState?.siteHazardDamageEventsByID);
      const events = [];
      for (let tick = previous.ticksDone + 1; tick <= due; tick++) {
        const prefix = `${instance.instanceID}:cloud:${previous.createdAtMs}:${tick}`;
        const atMs = previous.createdAtMs + tick * previous.intervalMs;
        if (markers[prefix]) {
          for (const eventID of markers[prefix].targetEventIDs) {
            if (!savedEvents[eventID]) throw new Error("SITE_HAZARD_TICK_PLAN_MISSING");
            events.push(savedEvents[eventID]);
          }
          continue;
        }
        const planned = buildPreparedSiteHazardHits(scene, instance, cloud, prefix, atMs,
          previous.rangeMeters, () => ({ thermal: previous.damagePerTick }), cloud.itemName);
        markers[prefix] = { atMs, targetEventIDs: planned.map(event => event.eventID) };
        events.push(...planned);
      }
      require("./siteHazardOutcomes").prepareEvents(instance, events, { nowMs,
        spawnPatch: { siteHazardDamageTicksByID: markers } });
      const record = { ...previous, ticksDone: due };
      dungeonRuntime.mergeHazardState(instance.instanceID, { sleeperToxicCloud: record },
        { nowMs, durable: true, force: true });
      cloud.dungeonHazardTicksDone = due;
      cloud.dungeonHazardNextTickAtMs = previous.createdAtMs + (due + 1) * previous.intervalMs;
      result.ticks += due - previous.ticksDone;
    }
    const replay = require("./siteHazardOutcomes").replayPendingSiteHazardDamage(instance, { scene, nowMs });
    if (!replay.success) throw new Error(replay.errorMsg);
    result.damageHits += replay.delivered;
    if (nowMs >= previous.expiresAtMs && scene.removeStaticEntity) {
      scene.removeStaticEntity(cloud.itemID, { broadcast: true, nowMs });
      result.dissipated++;
    }
  }
  return result;
}

function applyTriggeredSiteEffects(scene, instance, siteEntity, populationHints, trigger, options = {}) {
  const normalizedTrigger = normalizeLowerText(trigger, "");
  if (!scene || !instance || !normalizedTrigger) {
    return {
      removedContainers: 0,
      triggeredHazards: 0,
    };
  }
  const nowMs = Math.max(0, toInt(options.nowMs, Date.now()));
  const recovered = require("./siteHazardOutcomes").replayPendingSiteHazardDamage(instance, { scene, nowMs });
  if (!recovered.success) throw new Error(recovered.errorMsg);
  // Scope to this site, not just this instance. Several materialized sites can share one scene,
  // and a hack failure at one of them must not blow up the caches standing at another.
  const contentEntities = listMaterializedUniverseSiteContentEntities(scene, {
    instanceID: Math.max(0, toInt(instance && instance.instanceID, 0)),
    siteID: Math.max(0, toInt(siteEntity && siteEntity.itemID, 0)),
  });
  let removedContainers = 0;
  let triggeredHazards = 0;
  let failedContainers = 0;

  const explodingCans = contentEntities.filter(entity => entity?.dungeonMaterializedContainer === true &&
    ((normalizedTrigger === "hack_failure" && entity.dungeonSiteContentFailureExplodes === true) ||
     (normalizedTrigger === "visible_countdown" && entity.dungeonSiteContentPersistsAfterResponse !== true)));
  let closedHackingAttempts = 0;
  let explosionDamageHits = recovered.delivered;
  if (explodingCans.length) {
    closeHackingAttemptsForExplodedCans(scene, explodingCans, normalizedTrigger, { settleWinsOnly: true });
    const ghostSite = normalizeLowerText(instance.siteFamily, "") === "ghost" ||
      normalizeArray(populationHints?.hazards).some(hazard => normalizeLowerText(hazard?.kind || hazard, "").startsWith("ghost_site"));
    claimGhostSiteExplosions(scene, instance, explodingCans, nowMs, { ghostSite });
    closedHackingAttempts = toInt(closeHackingAttemptsForExplodedCans(scene, explodingCans, normalizedTrigger)?.closed, 0);
    const replay = require("./siteHazardOutcomes").replayPendingSiteHazardDamage(instance, { scene, nowMs });
    if (!replay.success) throw new Error(replay.errorMsg);
    explosionDamageHits += replay.delivered;
  }
  if (normalizedTrigger === "hack_failure") {
    triggeredHazards += materializeSleeperToxicClouds(scene, instance, siteEntity, populationHints,
      { nowMs, failedEntity: options.failedEntity });
  }

  if (normalizedTrigger === "hack_failure") {
    for (const entity of contentEntities) {
      if (!entity || entity.dungeonMaterializedContainer !== true) {
        continue;
      }
      if (entity.dungeonSiteContentFailureExplodes !== true) {
        continue;
      }
      const removed = destroyMaterializedContentEntity(scene, entity, {
        broadcast: false,
        nowMs,
      });
      if (removed && removed.success) {
        removedContainers += 1;
      } else failedContainers += 1;
    }
  }

  if (normalizedTrigger === "visible_countdown") {
    for (const entity of contentEntities) {
      if (!entity || entity.dungeonMaterializedContainer !== true) {
        continue;
      }
      if (entity.dungeonSiteContentPersistsAfterResponse === true) {
        continue;
      }
      const removed = destroyMaterializedContentEntity(scene, entity, {
        broadcast: false,
        nowMs,
      });
      if (removed && removed.success) {
        removedContainers += 1;
      } else failedContainers += 1;
    }
  }

  for (const entity of contentEntities) {
    if (!entity || entity.dungeonMaterializedHazard !== true) {
      continue;
    }
    const shouldTrigger = (
      (normalizedTrigger === "hack_failure" && entity.dungeonHazardFailureTriggersExplosion === true) ||
      (normalizedTrigger === "visible_countdown" && Number(entity.dungeonHazardVisibleCountdownSeconds || 0) > 0)
    );
    if (!shouldTrigger) {
      continue;
    }
    if (normalizeLowerText(entity.dungeonHazardState, "") === "triggered") {
      continue;
    }
    entity.dungeonHazardState = "triggered";
    entity.dungeonHazardTriggeredAtMs = nowMs;
    triggeredHazards += 1;
  }

  if (removedContainers > 0 || triggeredHazards > 0) {
    dungeonRuntime.mergeHazardState(instance.instanceID, {
      lastTrigger: normalizedTrigger,
      lastTriggeredAtMs: nowMs,
      removedContainers,
      triggeredHazards,
      responseTriggered:
        normalizedTrigger === "visible_countdown" || normalizedTrigger === "hack_failure",
    }, { nowMs });
  }

  return {
    removedContainers,
    triggeredHazards,
    failedContainers,
    explosionDamageHits,
    closedHackingAttempts,
  };
}

// Resolve the world position a proximity encounter watches. Prefer the named objective/environment
// object (proximityTargetKey); fall back to the site beacon center (the warp-in point) so proximity
// missions still trigger sensibly even when the exact target object isn't separately materialized.
function resolveProximityTargetPosition(siteEntity, populationHints, targetKey) {
  const siteCenter = siteEntity && siteEntity.position ? clonePosition(siteEntity.position) : null;
  const key = normalizeText(targetKey, "");
  if (key && siteCenter) {
    const candidates = [
      ...normalizeArray(populationHints && populationHints.objectiveMarkers),
      ...normalizeArray(populationHints && populationHints.environmentProps),
    ];
    const marker = candidates.find((candidate) => normalizeText(candidate && candidate.key, "") === key);
    if (marker) {
      if (marker.position && typeof marker.position === "object") {
        return clonePosition(marker.position);
      }
      if (marker.positionOffset && typeof marker.positionOffset === "object") {
        return addVectors(siteCenter, marker.positionOffset);
      }
    }
  }
  return siteCenter;
}

function anyPlayerShipWithinRange(scene, interactionSource, position, rangeMeters) {
  if (
    !interactionSource ||
    !position ||
    !scene ||
    !(scene.dynamicEntities instanceof Map)
  ) {
    return false;
  }
  const range = Math.max(1, toFiniteNumber(rangeMeters, 1));
  const rangeSquared = range * range;
  for (const entity of scene.dynamicEntities.values()) {
    if (!entity || entity.kind !== "ship") {
      continue;
    }
    if (toInt(entity.charID, 0) <= 0 && toInt(entity.characterID, 0) <= 0) {
      continue;
    }
    if (!canEntitiesInteractLocally(interactionSource, entity)) {
      continue;
    }
    const entityPosition = entity.position;
    if (!entityPosition) {
      continue;
    }
    const dx = toFiniteNumber(entityPosition.x, 0) - position.x;
    const dy = toFiniteNumber(entityPosition.y, 0) - position.y;
    const dz = toFiniteNumber(entityPosition.z, 0) - position.z;
    if ((dx * dx) + (dy * dy) + (dz * dz) <= rangeSquared) {
      return true;
    }
  }
  return false;
}

// Spawn proximity-triggered encounters when a player ship comes within range of the encounter's
// target object. Mirrors the gate (on_room_active) / wave_cleared trigger handling but is evaluated
// continuously from tickSceneSiteBehaviors since there is no explicit player action to hook.
function processProximityEncounterTriggers(scene, instance, siteEntity, populationHints, options = {}) {
  const nowMs = Math.max(0, toInt(options.nowMs, Date.now()));
  const proximityPlans = resolveEncounterPlans(populationHints)
    .filter((plan) => normalizeLowerText(plan && plan.trigger, "") === "proximity")
    .sort((left, right) => Math.max(1, toInt(left.waveIndex, 1)) - Math.max(1, toInt(right.waveIndex, 1)));
  if (proximityPlans.length <= 0) {
    return 0;
  }
  let encountersSpawned = 0;
  for (const plan of proximityPlans) {
    const existingState = getEncounterStateByKey(instance, plan.key);
    if (Math.max(0, toInt(existingState && existingState.spawnedAtMs, 0)) > 0) {
      continue;
    }
    // Stagger reinforcement waves: a higher-waveIndex wave for the same target spawns only once
    // every lower wave is spawned AND cleared (no alive entities). Same-waveIndex groups spawn
    // together; wave 1 has no lower wave so it fires as soon as the player is in range.
    const planWaveIndex = Math.max(1, toInt(plan.waveIndex, 1));
    const planTargetKey = normalizeText(plan.proximityTargetKey, "");
    const blockedByEarlierWave = proximityPlans.some((other) => {
      if (other === plan || normalizeText(other.proximityTargetKey, "") !== planTargetKey) {
        return false;
      }
      if (Math.max(1, toInt(other.waveIndex, 1)) >= planWaveIndex) {
        return false;
      }
      const otherState = getEncounterStateByKey(instance, other.key);
      if (Math.max(0, toInt(otherState && otherState.spawnedAtMs, 0)) <= 0) {
        return true;
      }
      return listAliveEncounterEntityIDs(scene, otherState, other).length > 0;
    });
    if (blockedByEarlierWave) {
      continue;
    }
    const targetPosition = resolveProximityTargetPosition(siteEntity, populationHints, plan.proximityTargetKey);
    if (!targetPosition) {
      continue;
    }
    const rangeMeters =
      Math.max(0, toFiniteNumber(plan.proximityRangeMeters, 0)) ||
      SITE_CONTENT_PROXIMITY_DEFAULT_RANGE_METERS;
    if (!anyPlayerShipWithinRange(scene, siteEntity, targetPosition, rangeMeters)) {
      continue;
    }
    encountersSpawned += spawnEncounterPlan(scene, instance, siteEntity, plan, {
      ...options,
      nowMs,
      trigger: "proximity",
      totalPlans: proximityPlans.length,
      roomPosition: targetPosition,
    });
  }
  return encountersSpawned;
}

// Where the fetch objective's trigger can be collected. Prefer live materialized entities, and take
// ALL that match rather than the first: a trigger identity is usually one ship (Vigilance's five
// State Haulers are separately named, and only nameID 119126 carries the evidence), but a typeID-only
// trigger can cover several, and the pilot may reach any of them. Falls back to the authored offsets
// so a pilot who shot the trigger first can still collect: TQ's dungeon trigger is positional, and in
// the golden log the item arrives before the hauler dies, leaving an empty wreck - without the
// fallback, killing it at range would strand the mission.
function resolveFetchObjectiveTriggerPositions(scene, instance, siteEntity, populationHints, trigger) {
  const instanceID = Math.max(0, toInt(instance && instance.instanceID, 0));
  const livePositions = [];
  for (const entity of listMaterializedUniverseSiteContentEntities(scene, { instanceID })) {
    if (entity && entity.position && entityOrSpawnEntryMatchesObjectiveTarget(entity, trigger)) {
      livePositions.push(clonePosition(entity.position));
    }
  }
  if (livePositions.length > 0) {
    return livePositions;
  }
  const template = dungeonAuthority.getTemplateByID(instance && instance.templateID);
  const authored = [
    ...normalizeArray(populationHints && populationHints.encounters).flatMap((plan) => (
      normalizeArray(plan && plan.spawnEntries).map((entry) => ({ entry, roomKey: plan && plan.roomKey }))
    )),
    ...normalizeArray(populationHints && populationHints.environmentProps)
      .map((entry) => ({ entry, roomKey: entry && entry.roomKey })),
    ...normalizeArray(populationHints && populationHints.containers)
      .map((entry) => ({ entry, roomKey: entry && entry.roomKey })),
  ];
  const authoredPositions = [];
  for (const { entry, roomKey } of authored) {
    if (!entry || !entry.positionOffset || !entityOrSpawnEntryMatchesObjectiveTarget(entry, trigger)) {
      continue;
    }
    const anchorPosition =
      resolveRoomWorldPositionForTemplate(siteEntity && siteEntity.position, template, normalizeText(roomKey, "")) ||
      (siteEntity && siteEntity.position);
    if (!anchorPosition) {
      continue;
    }
    authoredPositions.push(addVectors(clonePosition(anchorPosition), entry.positionOffset));
  }
  return authoredPositions;
}

function isMissionOwnerShipWithinRange(scene, siteEntity, position, rangeMeters, characterID) {
  const ownerCharacterID = Math.max(0, toInt(characterID, 0));
  if (
    ownerCharacterID <= 0 ||
    !siteEntity ||
    !position ||
    !scene ||
    !(scene.dynamicEntities instanceof Map)
  ) {
    return false;
  }
  const range = Math.max(1, toFiniteNumber(rangeMeters, 1));
  const rangeSquared = range * range;
  for (const entity of scene.dynamicEntities.values()) {
    if (!entity || entity.kind !== "ship" || !entity.position) {
      continue;
    }
    if (
      toInt(entity.charID, 0) !== ownerCharacterID &&
      toInt(entity.characterID, 0) !== ownerCharacterID
    ) {
      continue;
    }
    if (!canEntitiesInteractLocally(siteEntity, entity)) {
      continue;
    }
    const dx = toFiniteNumber(entity.position.x, 0) - position.x;
    const dy = toFiniteNumber(entity.position.y, 0) - position.y;
    const dz = toFiniteNumber(entity.position.z, 0) - position.z;
    if ((dx * dx) + (dy * dy) + (dz * dz) <= rangeSquared) {
      return true;
    }
  }
  return false;
}

// TQ parity for proximity fetch missions (Interstellar Railroad 1 of 4): the objective item is not
// dropped by a kill or looted from a container — flying up to the named mission object puts it
// straight into the runner's cargo. In the golden log the Amarr Diplomat (29229) appears in
// ShipCargo while the pilot is approaching the Amarr-Caldari Mediation Center, with no kill and no
// loot action anywhere near it, and before the pocket's only NPC has even spawned. There is no
// player action to hook, so like proximity encounters this is evaluated every behavior tick.
function processFetchObjectiveProximity(scene, instance, siteEntity, populationHints, options = {}) {
  const fetchObjective = normalizeFetchObjectiveHints(populationHints);
  if (!fetchObjective || fetchObjective.mechanic !== "auto_cargo_on_proximity") {
    return 0;
  }
  const spawnState = normalizeObject(instance && instance.spawnState);
  if (Math.max(0, toInt(spawnState.fetchObjectiveGrantedAtMs, 0)) > 0) {
    return 0;
  }
  const trigger = fetchObjective.triggerEntity;
  const hasTriggerIdentity =
    Math.max(0, toInt(trigger.typeID, 0)) > 0 ||
    Math.max(0, toInt(trigger.nameID || trigger.dunObjectNameID, 0)) > 0 ||
    Math.max(0, toInt(trigger.dunObjectID, 0)) > 0 ||
    Boolean(normalizeText(trigger.key, ""));
  if (!hasTriggerIdentity) {
    return 0;
  }
  const targetPositions = resolveFetchObjectiveTriggerPositions(
    scene,
    instance,
    siteEntity,
    populationHints,
    trigger,
  );
  if (targetPositions.length <= 0) {
    return 0;
  }
  const ownership = normalizeObject(instance && instance.ownership);
  const characterID = Math.max(
    0,
    toInt(ownership.missionOwnerCharacterID, toInt(ownership.characterID, 0)),
  );
  const reachedTrigger = targetPositions.some((targetPosition) => isMissionOwnerShipWithinRange(
    scene,
    siteEntity,
    targetPosition,
    fetchObjective.triggerRangeMeters,
    characterID,
  ));
  if (!reachedTrigger) {
    return 0;
  }
  const nowMs = Math.max(0, toInt(options.nowMs, Date.now()));
  return grantFetchObjectiveItemsToMissionOwner(instance, fetchObjective, {
    nowMs,
    reason: "fetch_objective_proximity_reached",
  })
    ? 1
    : 0;
}

// Mining objective (Plan C2): complete the site once objectiveQuantity ore has been extracted from
// its mission rocks (sum of each rock's initial quantity minus its current miningRuntimeState
// remaining). Reports into the B1/B2 completion hook (markInstanceObjectiveSatisfied). Gated on a
// positive populationHints.objectiveQuantity, so non-mining sites are unaffected.
function processMiningObjective(scene, instance, populationHints, options = {}) {
  const objectiveQuantity = Math.max(0, toInt(populationHints && populationHints.objectiveQuantity, 0));
  if (objectiveQuantity <= 0 || isSiteObjectiveExplicitlySatisfied(instance)) {
    return 0;
  }
  const instanceID = Math.max(0, toInt(instance && instance.instanceID, 0));
  if (!instanceID || !scene) {
    return 0;
  }
  let miningRuntimeState = null;
  try {
    miningRuntimeState = require(path.join(__dirname, "../mining/miningRuntimeState"));
  } catch (_error) {
    // ignored: the mining state is not loaded in this process; no rocks to count (0)
    return 0;
  }
  const nowMs = Math.max(0, toInt(options.nowMs, Date.now()));
  let extracted = 0;
  let rockCount = 0;
  const liveRocksByID = new Map();
  for (const entity of listMaterializedUniverseSiteContentEntities(scene, { instanceID })) {
    if (!entity || entity.dungeonMaterializedMiningRock !== true) {
      continue;
    }
    if (Math.max(0, toInt(entity.dungeonSiteInstanceID, 0)) !== instanceID) {
      continue;
    }
    const entityID = Math.max(0, toInt(entity.itemID, 0));
    if (entityID > 0) {
      liveRocksByID.set(entityID, entity);
    }
  }
  const descriptorsByID = new Map();
  for (const descriptor of listMiningObjectiveRockDescriptors(instance, populationHints)) {
    const entityID = Math.max(0, toInt(descriptor && descriptor.entityID, 0));
    if (entityID > 0) {
      descriptorsByID.set(entityID, descriptor);
    }
  }
  for (const [entityID, entity] of liveRocksByID.entries()) {
    if (!descriptorsByID.has(entityID)) {
      descriptorsByID.set(entityID, {
        entityID,
        quantity: Math.max(
          0,
          toInt(entity.miningOriginalQuantity, 0),
          toInt(entity.originalQuantity, 0),
          toInt(entity.mineableQuantity, 0),
          toInt(entity.resourceQuantity, 0),
          toInt(entity.miningRemainingQuantity, 0),
        ),
      });
    }
  }
  const recordedRemainders = readRecordedMiningRockRemainders(instance);
  for (const descriptor of descriptorsByID.values()) {
    const entityID = Math.max(0, toInt(descriptor && descriptor.entityID, 0));
    if (entityID <= 0) {
      continue;
    }
    const entity = liveRocksByID.get(entityID) || null;
    rockCount += 1;
    let state = null;
    if (typeof miningRuntimeState.getMineableState === "function") {
      state = miningRuntimeState.getMineableState(scene, entityID);
    }
    const initial = Math.max(
      0,
      toInt(state && state.originalQuantity, 0),
      toInt(descriptor && descriptor.quantity, 0),
      toInt(entity && entity.miningOriginalQuantity, 0),
      toInt(entity && entity.originalQuantity, 0),
      toInt(entity && entity.mineableQuantity, 0),
      toInt(entity && entity.resourceQuantity, 0),
      toInt(entity && entity.miningRemainingQuantity, 0),
    );
    // A rock mined out before this load is no longer in the scene; the site's record still counts it.
    const recordedRemaining = state
      ? null
      : readRecordedMiningRockRemainder(recordedRemainders, entityID);
    const remaining = Math.max(
      0,
      state
        ? toInt(state.remainingQuantity, initial)
        : (recordedRemaining === null ? initial : recordedRemaining),
    );
    extracted += Math.max(0, initial - remaining);
  }
  if (rockCount > 0 && extracted >= objectiveQuantity) {
    try {
      dungeonRuntime.markInstanceObjectiveSatisfied(instanceID, {
        reason: "mining_quantity_reached",
        nowMs,
      });
      return 1;
    } catch (error) {
      log.debug(`[DungeonSites] marking the mining objective of dungeon ${instanceID} failed: ${error && error.message}`);
      return 0;
    }
  }
  return 0;
}

// Ore anomalies and gas signatures end once every rock or cloud they placed is mined out; their packs
// author that as "deplete_all_mining_rocks". Generated ice ends through miningRuntimeState instead.
const MINED_OUT_SITE_FAMILIES = new Set(["ore", "gas"]);

function maybeCompleteMinedOutSite(scene, instance, populationHints, options = {}) {
  if (
    !MINED_OUT_SITE_FAMILIES.has(normalizeLowerText(instance && instance.siteFamily, "")) ||
    normalizeLowerText(instance && instance.lifecycleState, "") !== "active"
  ) {
    return false;
  }
  // Depleted rocks leave the scene, and a later load does not rebuild them. Check the authored
  // rock identities against mining state, or the site's record for a rock no longer in the scene,
  // so an empty/unloaded grid cannot be mistaken for a mined site.
  const rocks = listMiningObjectiveRockDescriptors(instance, populationHints);
  if (rocks.length <= 0) {
    return false;
  }
  const miningRuntimeState = require(path.join(__dirname, "../mining/miningRuntimeState"));
  const recordedRemainders = readRecordedMiningRockRemainders(instance);
  for (const rock of rocks) {
    const state = miningRuntimeState.getMineableState(scene, rock.entityID);
    const remaining = state
      ? toFiniteNumber(state.remainingQuantity, 1)
      : readRecordedMiningRockRemainder(recordedRemainders, rock.entityID);
    if (remaining === null || remaining > 0) {
      return false;
    }
  }
  const nowMs = Math.max(0, toInt(options.nowMs, Date.now()));
  const updated = dungeonRuntime.setLifecycleState(instance.instanceID, "completed", {
    nowMs,
    completedAtMs: nowMs,
    expiresAtMs: nowMs + CLEARED_ANOMALY_ROTATION_DELAY_MS,
    lifecycleReason: "depleted",
  });
  dungeonTrackingRuntime.notifyDungeonCompletedForScene(scene, updated, { nowMs });
  return true;
}

function maybeAdvanceExplicitlySatisfiedObjective(instance, options = {}) {
  if (!instance || !isSiteObjectiveExplicitlySatisfied(instance)) {
    return false;
  }
  const instanceID = Math.max(0, toInt(instance && instance.instanceID, 0));
  if (!instanceID) {
    return false;
  }
  const refreshedInstance = dungeonRuntime.getInstance(instanceID) || instance;
  const objectiveState =
    refreshedInstance &&
    refreshedInstance.objectiveState &&
    typeof refreshedInstance.objectiveState === "object"
      ? refreshedInstance.objectiveState
      : {};
  if (
    normalizeLowerText(objectiveState.state, "") === "completed" &&
    Math.max(0, toInt(objectiveState.completedAtMs, 0)) > 0
  ) {
    return false;
  }
  const nowMs = Math.max(0, toInt(options.nowMs, Date.now()));
  const satisfiedAtMs = Math.max(
    0,
    toInt(refreshedInstance && refreshedInstance.objectiveSatisfiedAtMs, 0),
    toInt(refreshedInstance && refreshedInstance.metadata && refreshedInstance.metadata.objectiveSatisfiedAtMs, 0),
    nowMs,
  );
  const existingMetadata =
    objectiveState.metadata &&
    typeof objectiveState.metadata === "object" &&
    !Array.isArray(objectiveState.metadata)
      ? objectiveState.metadata
      : {};
  const existingCounters =
    objectiveState.counters &&
    typeof objectiveState.counters === "object" &&
    !Array.isArray(objectiveState.counters)
      ? objectiveState.counters
      : {};
  dungeonRuntime.advanceObjective(instanceID, {
    state: "completed",
    completedAtMs: satisfiedAtMs,
    counters: cloneValue(existingCounters),
    metadata: {
      ...cloneValue(existingMetadata),
      objectiveSatisfiedAtMs: satisfiedAtMs,
      objectiveSatisfiedReason:
        normalizeText(refreshedInstance && refreshedInstance.objectiveSatisfiedReason, "") ||
        normalizeText(existingMetadata.objectiveSatisfiedReason, "") ||
        null,
    },
  }, { nowMs });
  return true;
}

function isDungeonInstanceObjectiveCompleted(instance) {
  const objectiveState = normalizeObject(instance && instance.objectiveState);
  return (
    normalizeLowerText(objectiveState.state, "") === "completed" ||
    Math.max(0, toInt(objectiveState.completedAtMs, 0)) > 0
  );
}

function syncAgentMissionForCompletedDungeonObjective(instance, options = {}) {
  if (!instance || !isDungeonInstanceObjectiveCompleted(instance)) {
    return null;
  }
  const metadata = normalizeObject(instance && instance.metadata);
  const runtimeFlags = normalizeObject(instance && instance.runtimeFlags);
  if (metadata.missionRuntime !== true && runtimeFlags.missionRuntime !== true) {
    return null;
  }
  const agentMissionRuntime = loadedMissionRuntime.getLoadedMissionRuntime();
  if (!agentMissionRuntime) {
    log.debug(`[DungeonSites] mission record sync for dungeon ${instance && instance.instanceID} skipped: the mission runtime is not loaded`);
    return null;
  }
  try {
    if (typeof agentMissionRuntime.syncMissionRecordForDungeonInstance === "function") {
      return agentMissionRuntime.syncMissionRecordForDungeonInstance(instance, {
        notifyTracker: true,
        notifyMissionChange: false,
        nowMs: options.nowMs,
      });
    }
  } catch (error) {
    log.debug(`[DungeonSites] mission record sync for dungeon ${instance && instance.instanceID} failed: ${error && error.message}`);
    return null;
  }
  return null;
}

function tickSceneSiteBehaviors(scene, options = {}) {
  if (!scene) {
    return {
      armedCount: 0,
      encountersSpawned: 0,
      encounterCompletions: 0,
      gatesUnlocked: 0,
      rewardContainersSpawned: 0,
    };
  }
  try { require("./siteHazardOutcomes").recoverForScene(scene); }
  catch (error) {
    log.warn(`[universe-sites] hazard health recovery deferred: ${error.message}`);
    return { blocked: true, armedCount: 0, encountersSpawned: 0, encounterCompletions: 0,
      gatesUnlocked: 0, rewardContainersSpawned: 0 };
  }
  require("../seasons/eventHooks").fabricator.refreshDepartedBonuses(scene);
  // Cleared sites parked by the occupancy grace close here, once their grid has emptied.
  drainPendingSiteTeardowns(scene, { nowMs: options.nowMs });
  const materializedSiteIDs = [...ensureSceneMaterializedSiteSet(scene)];
  if (materializedSiteIDs.length <= 0) {
    return {
      armedCount: 0,
      encountersSpawned: 0,
      encounterCompletions: 0,
      gatesUnlocked: 0,
      rewardContainersSpawned: 0,
    };
  }
  const nowMs = Math.max(0, toInt(options.nowMs, Date.now()));
  let armedCount = 0;
  let encountersSpawned = 0;
  let encounterCompletions = 0;
  let gatesUnlocked = 0;
  let rewardContainersSpawned = 0;
  let fetchObjectiveGrants = 0;
  try { processToxicCloudHazards(scene, { nowMs }); }
  catch (error) {
    log.warn(`[universe-sites] toxic cloud settlement deferred: ${error.message}`);
    return { blocked: true, armedCount, encountersSpawned, encounterCompletions,
      gatesUnlocked, rewardContainersSpawned };
  }
  const instances = materializedSiteIDs
    .map((siteID) => resolveManagedUniverseSiteInstance(scene, null, { siteID }))
    .filter((instance) => isManagedMaterializedSiteInstance(instance));

  for (const instance of instances) {
    const hazardRecovery = require("./siteHazardOutcomes").replayPendingSiteHazardDamage(instance, { scene, nowMs });
    if (!hazardRecovery.success) continue;
    const template = dungeonAuthority.getTemplateByID(instance.templateID);
    const populationHints = resolvePopulationHints(instance, template);
    const eventHooks = require("../seasons/eventHooks");
    const eventSite = eventHooks.fw.isSite(instance) ? "fw"
      : eventHooks.fabricator.isFabricator(instance) ? "fabricator"
        : eventHooks.depot.isDepot(instance) ? "depot" : null;
    if (eventSite) {
      if (scene.eventParkedSites?.has(instance.instanceID)) continue;
      // Same contract as Homefront below: an event site that throws is set
      // aside once, not retried every second, and never stops the server.
      try {
        if (eventSite === "fw") {
          eventHooks.fw.tick(scene, instance, nowMs);
          continue;
        }
        if (eventSite === "fabricator") {
          eventHooks.fabricator.tick(scene, instance, nowMs);
          continue;
        }
        const completion = maybeCompleteMaterializedDataRelicSite(scene, null, {
          instanceID: instance.instanceID, siteID: instance.metadata?.siteID, nowMs,
        });
        if (completion.completed) continue;
      } catch (error) {
        scene.eventParkedSites ??= new Set();
        scene.eventParkedSites.add(instance.instanceID);
        log.error(
          `[Event] Parked ${eventSite} site ${instance.instanceID}: ${error.stack || error.message}`,
        );
        continue;
      }
    }
    if (populationHints?.homefront) {
      if (scene.homefrontParkedSites?.has(instance.instanceID)) continue;
      const homefront = require("../homefront/homefrontHooks").runtime;
      try {
        homefront.tick(scene, instance, nowMs);
      } catch (error) {
        // Park before attempting persistence or cleanup: those can be the cause
        // of the failure, and must not take the rest of the simulation down.
        scene.homefrontParkedSites ??= new Set();
        scene.homefrontParkedSites.add(instance.instanceID);
        log.error(
          `[Homefront] Parked site ${instance.instanceID}: ${error.stack || error.message}`,
        );
        try {
          homefront.parkSite(scene, instance, error, nowMs);
        } catch (cleanupError) {
          log.error(
            `[Homefront] Could not persist parked site ${instance.instanceID}: ${cleanupError.message}`,
          );
        }
      }
      continue;
    }
    if (!retryInstanceHackingOutcomes(scene, instance, populationHints, { nowMs })) continue;
    if (maybeCompleteMinedOutSite(scene, instance, populationHints, { nowMs })) {
      continue;
    }
    // Mining objective runs before the encounter-plan gate so pure-mining sites (no NPCs) progress.
    processMiningObjective(scene, instance, populationHints, { nowMs });
    const refreshedForObjective =
      dungeonRuntime.getInstance(instance.instanceID) || instance;
    maybeAdvanceExplicitlySatisfiedObjective(refreshedForObjective, { nowMs });
    syncAgentMissionForCompletedDungeonObjective(
      dungeonRuntime.getInstance(instance.instanceID) || refreshedForObjective,
      { nowMs },
    );
    const plans = resolveEncounterPlans(populationHints);
    if (plans.length <= 0) {
      maybeCompleteMaterializedDataRelicSite(scene, null, {
        instanceID: instance.instanceID,
        siteID: instance.metadata && instance.metadata.siteID,
        nowMs,
        broadcast: true,
      });
      maybeCompleteClearedEncounterSite(
        dungeonRuntime.getInstance(instance.instanceID) || instance,
        populationHints,
        { nowMs, scene },
      );
      continue;
    }
    const siteID = Math.max(0, toInt(instance && instance.metadata && instance.metadata.siteID, 0));
    const siteEntity = (
      scene.staticEntitiesByID &&
      scene.staticEntitiesByID.get(siteID)
    ) || buildSiteEntity(instance);
    if (!siteEntity) {
      continue;
    }
    if (!isSceneSiteMaterialized(scene, siteID)) {
      continue;
    }
    const progressResult = syncEncounterStateProgress(scene, instance, plans, { nowMs });
    encounterCompletions += Math.max(0, toInt(progressResult && progressResult.completedCount, 0));
    armedCount += armDeferredEncounterPlans(instance, populationHints, { nowMs });
    materializeDeferredGhostTimerHazards(scene, dungeonRuntime.getInstance(instance.instanceID) || instance,
      siteEntity, populationHints, { nowMs });
    // Proximity-triggered encounters (e.g. "investigate the drone" ambushes) have no player action
    // to hook, so evaluate the player's distance to the target object every tick.
    encountersSpawned += processProximityEncounterTriggers(scene, instance, siteEntity, populationHints, { nowMs });
    // Same for a proximity fetch pickup: reaching the mission object is the whole objective.
    fetchObjectiveGrants += processFetchObjectiveProximity(
      scene,
      dungeonRuntime.getInstance(instance.instanceID) || instance,
      siteEntity,
      populationHints,
      { nowMs },
    );
    // Timer encounters: silent delayed reinforcements (delaySeconds after site load).
    encountersSpawned += processEncounterPlansForTrigger(scene, instance, siteEntity, populationHints, "timer", { nowMs });
    const visibleCountdownDue = hasDueVisibleCountdownTrigger(instance, populationHints, { nowMs });
    const visibleCountdownEncounters = processEncounterPlansForTrigger(
      scene,
      instance,
      siteEntity,
      populationHints,
      "visible_countdown",
      { nowMs },
    );
    encountersSpawned += visibleCountdownEncounters;
    if (visibleCountdownDue) {
      const effects = applyTriggeredSiteEffects(
        scene,
        instance,
        siteEntity,
        populationHints,
        "visible_countdown",
        { nowMs },
      );
      if (effects.failedContainers > 0) continue;
      for (const plan of resolveEncounterPlans(populationHints)) {
        if (normalizeLowerText(plan && plan.trigger, "") !== "visible_countdown") {
          continue;
        }
        upsertEncounterState(instance.instanceID, plan.key, {
          triggeredEffectsAtMs: nowMs,
        }, { nowMs, durable: true, force: true });
      }
    }
    const latestInstance = dungeonRuntime.getInstance(instance.instanceID) || instance;
    syncEncounterStateProgress(scene, latestInstance, plans, { nowMs });
    // Kill-trigger waves: evaluated before wave_cleared, since their trigger ship dying is what
    // brings in the reinforcements that would otherwise have to clear first.
    encountersSpawned += processEncounterPlansForTrigger(
      scene,
      latestInstance,
      siteEntity,
      populationHints,
      "entity_killed",
      { nowMs },
    );
    const afterEntityKilled = dungeonRuntime.getInstance(instance.instanceID) || latestInstance;
    syncEncounterStateProgress(scene, afterEntityKilled, plans, { nowMs });
    encountersSpawned += processEncounterPlansForTrigger(
      scene,
      afterEntityKilled,
      siteEntity,
      populationHints,
      "wave_cleared",
      { nowMs },
    );
    const afterWaveClear = dungeonRuntime.getInstance(instance.instanceID) || afterEntityKilled;
    syncEncounterStateProgress(scene, afterWaveClear, plans, { nowMs });
    encountersSpawned += processEncounterPlansForTrigger(
      scene,
      afterWaveClear,
      siteEntity,
      populationHints,
      "battleships_destroyed",
      { nowMs },
    );
    const refreshedForRewards = dungeonRuntime.getInstance(instance.instanceID) || afterWaveClear;
    syncEncounterStateProgress(scene, refreshedForRewards, plans, { nowMs });
    rewardContainersSpawned += materializeEncounterRewardContainers(
      scene,
      refreshedForRewards,
      siteEntity,
      template,
      populationHints,
      { nowMs },
    );
    rewardContainersSpawned += materializeFetchObjectiveContainer(
      scene,
      dungeonRuntime.getInstance(instance.instanceID) || refreshedForRewards,
      siteEntity,
      template,
      populationHints,
      { nowMs },
    );
    const refreshedForProgression = dungeonRuntime.getInstance(instance.instanceID) || refreshedForRewards;
    const progressionResult = maybeAdvanceEncounterDrivenProgression(
      refreshedForProgression,
      populationHints,
      { nowMs, scene },
    );
    const refreshedForCompletion = dungeonRuntime.getInstance(instance.instanceID) || refreshedForRewards;
    publishClientWaveValues(scene, refreshedForCompletion, { template, plans });
    maybeCompleteClearedEncounterSite(
      refreshedForCompletion,
      populationHints,
      { nowMs, scene },
    );
    maybeCompleteMaterializedDataRelicSite(scene, null, {
      instanceID: instance.instanceID,
      siteID: instance.metadata && instance.metadata.siteID,
      nowMs,
      broadcast: true,
    });
    syncAgentMissionForCompletedDungeonObjective(
      dungeonRuntime.getInstance(instance.instanceID) || refreshedForProgression,
      { nowMs },
    );
    gatesUnlocked += Math.max(0, toInt(progressionResult && progressionResult.gatesUnlocked, 0));
  }

  return {
    armedCount,
    encountersSpawned,
    encounterCompletions,
    gatesUnlocked,
    rewardContainersSpawned,
    fetchObjectiveGrants,
  };
}

function encounterStateReferencesEntityID(encounterState, entityID) {
  const numericEntityID = Math.max(0, toInt(entityID, 0));
  if (numericEntityID <= 0) {
    return false;
  }
  return (
    normalizeIDList(encounterState && encounterState.spawnedEntityIDs).includes(numericEntityID) ||
    normalizeIDList(encounterState && encounterState.remainingEntityIDs).includes(numericEntityID)
  );
}

function instanceReferencesEncounterEntityID(instance, entityID) {
  const encounterStatesByKey = normalizeObject(
    instance && instance.spawnState && instance.spawnState.encounterStatesByKey,
  );
  return Object.values(encounterStatesByKey)
    .some((encounterState) => encounterStateReferencesEntityID(encounterState, entityID));
}

function destroyedEntityMatchesObjectiveTarget(instance, destroyedEntity, populationHints) {
  if (!instance || !destroyedEntity) {
    return false;
  }
  if (destroyedEntity.dungeonObjectiveProgressTarget === true) {
    return true;
  }
  const completion = normalizeCompletionHints(populationHints);
  if (normalizeArray(completion && completion.objectiveTargets).length <= 0) {
    return false;
  }
  return completion.objectiveTargets
    .some((target) => entityOrSpawnEntryMatchesObjectiveTarget(destroyedEntity, target));
}

function markDestroyedObjectiveTargets(matchingInstances, destroyedEntity, options = {}) {
  const entityID = Math.max(0, toInt(destroyedEntity && destroyedEntity.itemID, 0));
  if (entityID <= 0 || !destroyedEntity) {
    return 0;
  }
  const nowMs = Math.max(0, toInt(options.nowMs, Date.now()));
  let markedCount = 0;
  for (const instance of normalizeArray(matchingInstances)) {
    if (!instance || isSiteObjectiveExplicitlySatisfied(instance)) {
      continue;
    }
    const template = dungeonAuthority.getTemplateByID(instance.templateID);
    const populationHints = resolvePopulationHints(instance, template);
    if (!destroyedEntityMatchesObjectiveTarget(instance, destroyedEntity, populationHints)) {
      continue;
    }
    dungeonRuntime.markInstanceObjectiveSatisfied(instance.instanceID, {
      nowMs,
      reason: "objective_target_destroyed",
    });
    markedCount += 1;
  }
  return markedCount;
}

// populationHints.fetchObjective (emitted by tools/TQMissionLogDecoder for dungeon-fetch
// missions like Freedom and Commerce): { objectiveTypeID, objectiveQuantity, mechanic,
// triggerEntity: {typeID, nameID, dunObjectID?, label?} }.
function normalizeFetchObjectiveHints(populationHints) {
  const fetchObjective =
    populationHints &&
    populationHints.fetchObjective &&
    typeof populationHints.fetchObjective === "object"
      ? populationHints.fetchObjective
      : null;
  if (!fetchObjective) {
    return null;
  }
  const typeID = Math.max(0, toInt(fetchObjective.objectiveTypeID, 0));
  const quantity = Math.max(0, toInt(fetchObjective.objectiveQuantity, 0));
  if (typeID <= 0 || quantity <= 0) {
    return null;
  }
  return {
    typeID,
    quantity,
    mechanic: normalizeLowerText(fetchObjective.mechanic, "auto_cargo_on_trigger_kill"),
    triggerEntity: normalizeObject(fetchObjective.triggerEntity),
    triggerRangeMeters:
      Math.max(0, toFiniteNumber(fetchObjective.triggerRangeMeters, 0)) ||
      SITE_CONTENT_FETCH_PROXIMITY_DEFAULT_RANGE_METERS,
  };
}

// Insert the fetch objective's items into the mission owner's ship cargo and satisfy the dungeon
// objective. Shared by the trigger-kill and proximity mechanics; the two differ only in what arms
// the grant. agentMissionRuntime still gates journal completion on the items reaching the agent.
function grantFetchObjectiveItemsToMissionOwner(instance, fetchObjective, options = {}) {
  const nowMs = Math.max(0, toInt(options.nowMs, Date.now()));
  const ownership = normalizeObject(instance && instance.ownership);
  const characterID = Math.max(
    0,
    toInt(ownership.missionOwnerCharacterID, toInt(ownership.characterID, 0)),
  );
  if (characterID <= 0) {
    return false;
  }
  let shipItemID = 0;
  try {
    const characterState = require(path.join(__dirname, "../character/characterState"));
    const activeShip = characterState.getActiveShipRecord(characterID);
    shipItemID = Math.max(0, toInt(activeShip && activeShip.itemID, 0));
  } catch (_error) {
    shipItemID = 0;
  }
  if (shipItemID <= 0) {
    return false;
  }
  const grantResult = grantItemsToOwnerLocation(characterID, shipItemID, ITEM_FLAGS.CARGO_HOLD, [
    { itemType: fetchObjective.typeID, quantity: fetchObjective.quantity },
  ]);
  if (!grantResult || grantResult.success !== true) {
    return false;
  }
  dungeonRuntime.mergeSpawnState(instance.instanceID, {
    fetchObjectiveGrantedAtMs: nowMs,
  });
  dungeonRuntime.markInstanceObjectiveSatisfied(instance.instanceID, {
    nowMs,
    reason: normalizeText(options.reason, "") || "fetch_objective_items_granted",
  });
  try {
    const agentMissionRuntime = loadedMissionRuntime.getLoadedMissionRuntime();
    if (
      agentMissionRuntime &&
      typeof agentMissionRuntime.notifyMissionInventoryChanges === "function"
    ) {
      agentMissionRuntime.notifyMissionInventoryChanges(
        characterID,
        (grantResult.data && grantResult.data.changes) || [],
      );
    }
  } catch (error) {
    // Inventory notification is best-effort; the grant itself already persisted.
    log.debug(`[DungeonSites] mission inventory notification for character ${characterID} failed: ${error && error.message}`);
  }
  return true;
}

// TQ parity for trigger-kill fetch missions: destroying the trigger entity delivers the objective
// item(s) one of two ways, keyed by fetchObjective.mechanic:
//   - "auto_cargo_on_trigger_kill" — the item is inserted directly into the mission owner's ship
//     cargo (e.g. Freedom & Commerce's Slaver Ship drop).
//   - "container_on_trigger_kill" — a real Cargo Container is jettison-spawned holding the item, and
//     the player must loot it (e.g. Carrying AIMEDs). Here we only ARM the container (record the
//     trigger + drop position); the physical container is materialized on the next behavior tick
//     (materializeFetchObjectiveContainer), which has the scene/site context this handler lacks.
// Either way the dungeon objective is satisfied on the kill; agentMissionRuntime still gates journal
// completion on the item actually being in cargo + returned to the agent (the cargo spec check).
function maybeGrantFetchObjectiveItems(matchingInstances, destroyedEntity, options = {}) {
  if (!destroyedEntity) {
    return 0;
  }
  const candidate = {
    ...destroyedEntity,
    nameID:
      destroyedEntity.nameID ||
      destroyedEntity.slimNameID ||
      destroyedEntity.nameIDOverride ||
      null,
  };
  const nowMs = Math.max(0, toInt(options.nowMs, Date.now()));
  let grantedCount = 0;
  for (const instance of normalizeArray(matchingInstances)) {
    if (!instance) {
      continue;
    }
    const spawnState = normalizeObject(instance.spawnState);
    const template = dungeonAuthority.getTemplateByID(instance.templateID);
    const populationHints = resolvePopulationHints(instance, template);
    const fetchObjective = normalizeFetchObjectiveHints(populationHints);
    if (
      !fetchObjective ||
      (fetchObjective.mechanic !== "auto_cargo_on_trigger_kill" &&
        fetchObjective.mechanic !== "container_on_trigger_kill")
    ) {
      continue;
    }
    // One-shot guard, per mechanic.
    const alreadyGranted = Math.max(0, toInt(spawnState.fetchObjectiveGrantedAtMs, 0)) > 0;
    const alreadyArmedContainer = Math.max(0, toInt(spawnState.fetchObjectiveContainerTriggeredAtMs, 0)) > 0;
    if (alreadyGranted || alreadyArmedContainer) {
      continue;
    }
    const trigger = fetchObjective.triggerEntity;
    const hasTriggerIdentity =
      Math.max(0, toInt(trigger.typeID, 0)) > 0 ||
      Math.max(0, toInt(trigger.nameID || trigger.dunObjectNameID, 0)) > 0 ||
      Math.max(0, toInt(trigger.dunObjectID, 0)) > 0 ||
      Boolean(normalizeText(trigger.key, ""));
    // A trigger nameID is STRICT for the fetch grant: the same hull can appear elsewhere in
    // the dungeon as a non-trigger actor with no nameID at all (AIMEDs fields a Mercenary
    // Fighter lookalike at warp-in; only the Group-2 fighters — nameID 118688 — jettison the
    // container on TQ). The generic matcher's typeID+label fallback must not fire here.
    const strictTriggerNameID = Math.max(0, toInt(trigger.nameID || trigger.dunObjectNameID, 0));
    if (
      strictTriggerNameID > 0 &&
      Math.max(0, toInt(candidate.nameID, 0)) !== strictTriggerNameID
    ) {
      continue;
    }
    if (hasTriggerIdentity && !entityOrSpawnEntryMatchesObjectiveTarget(candidate, trigger)) {
      continue;
    }
    // container_on_trigger_kill: arm the container; the tick materializes it near the kill site.
    if (fetchObjective.mechanic === "container_on_trigger_kill") {
      dungeonRuntime.mergeSpawnState(instance.instanceID, {
        fetchObjectiveContainerTriggeredAtMs: nowMs,
        fetchObjectiveContainerPosition: clonePosition(destroyedEntity && destroyedEntity.position),
      });
      dungeonRuntime.markInstanceObjectiveSatisfied(instance.instanceID, {
        nowMs,
        reason: "fetch_objective_container_armed",
      });
      grantedCount += 1;
      continue;
    }
    if (!grantFetchObjectiveItemsToMissionOwner(instance, fetchObjective, { nowMs })) {
      continue;
    }
    grantedCount += 1;
  }
  return grantedCount;
}

function handleEncounterEntityDestroyed(scene, entityOrID, options = {}) {
  const entityID = Math.max(
    0,
    toInt(
      entityOrID && typeof entityOrID === "object"
        ? entityOrID.itemID || entityOrID.entityID
        : entityOrID,
      0,
    ),
  );
  const destroyedEntity = entityOrID && typeof entityOrID === "object"
    ? entityOrID
    : null;
  if (!scene || entityID <= 0) {
    return {
      success: false,
      errorMsg: "ENCOUNTER_ENTITY_NOT_FOUND",
    };
  }

  const systemID = Math.max(0, toInt(scene && scene.systemID, 0));
  if (systemID <= 0) {
    return {
      success: false,
      errorMsg: "SOLAR_SYSTEM_NOT_FOUND",
    };
  }

  const matchingInstances = dungeonRuntime.listActiveInstancesBySystem(systemID, {
    full: true,
  })
    .filter((instance) => (
      isManagedMaterializedSiteInstance(instance) &&
      instanceReferencesEncounterEntityID(instance, entityID)
    ));
  if (matchingInstances.length <= 0) {
    return {
      success: true,
      data: {
        entityID,
        matchedInstanceIDs: [],
        progression: {
          armedCount: 0,
          encountersSpawned: 0,
          encounterCompletions: 0,
          gatesUnlocked: 0,
          rewardContainersSpawned: 0,
        },
      },
    };
  }

  for (const instance of matchingInstances) {
    const siteID = Math.max(0, toInt(instance && instance.metadata && instance.metadata.siteID, 0));
    if (siteID > 0) {
      markSceneSiteMaterialized(scene, siteID, instance.instanceID);
    }
  }

  const objectiveTargetsSatisfied = markDestroyedObjectiveTargets(
    matchingInstances,
    destroyedEntity || { itemID: entityID },
    {
      nowMs: options.nowMs,
    },
  );
  const fetchObjectiveGrants = maybeGrantFetchObjectiveItems(
    matchingInstances,
    destroyedEntity || { itemID: entityID },
    {
      nowMs: options.nowMs,
    },
  );
  const progression = tickSceneSiteBehaviors(scene, {
    nowMs: options.nowMs,
    session: options.session || null,
  });
  return {
    success: true,
    data: {
      entityID,
      matchedInstanceIDs: matchingInstances.map((instance) => Math.max(0, toInt(instance && instance.instanceID, 0))),
      objectiveTargetsSatisfied,
      fetchObjectiveGrants,
      progression,
    },
  };
}

function triggerSiteEncounter(scene, instanceOrID, trigger, options = {}) {
  if (!scene) {
    return {
      success: false,
      errorMsg: "SCENE_REQUIRED",
    };
  }
  const instance = typeof instanceOrID === "object"
    ? instanceOrID
    : dungeonRuntime.getInstance(Math.max(0, toInt(instanceOrID, 0)));
  if (!instance) {
    return {
      success: false,
      errorMsg: "INSTANCE_NOT_FOUND",
    };
  }
  if (
    options.session &&
    !dungeonVisibilityPolicy.resolveDungeonInstanceVisibilityForSession(
      options.session,
      instance.instanceID,
      { systemID: scene.systemID },
    )
  ) {
    return {
      success: false,
      errorMsg: "DUNGEON_INSTANCE_NOT_AUTHORIZED",
    };
  }
  const template = dungeonAuthority.getTemplateByID(instance.templateID);
  const populationHints = resolvePopulationHints(instance, template);
  const siteID = Math.max(0, toInt(instance && instance.metadata && instance.metadata.siteID, 0));
  const siteEntity = (
    scene.staticEntitiesByID &&
    scene.staticEntitiesByID.get(siteID)
  ) || buildSiteEntity(instance);
  const triggeredEffects = applyTriggeredSiteEffects(
    scene,
    instance,
    siteEntity,
    populationHints,
    trigger,
    options,
  );
  const encountersSpawned = processEncounterPlansForTrigger(
    scene,
    instance,
    siteEntity,
    populationHints,
    trigger,
    options,
  );
  const refreshed = dungeonRuntime.getInstance(instance.instanceID) || instance;
  const failedPlans = normalizeLowerText(trigger, "") === "hack_failure" &&
    resolveEncounterPlans(populationHints).some(plan => plan.trigger === "hack_failure" &&
      plan.supported === true && toInt(getEncounterStateByKey(refreshed, plan.key)?.spawnedAtMs, 0) <= 0);
  return {
    success: !(triggeredEffects.failedContainers > 0 || failedPlans),
    ...(triggeredEffects.failedContainers > 0 || failedPlans ? { errorMsg: "HACKING_FAILURE_EFFECTS_PENDING" } : {}),
    data: {
      encountersSpawned,
      removedContainers: Math.max(0, toInt(triggeredEffects && triggeredEffects.removedContainers, 0)),
      triggeredHazards: Math.max(0, toInt(triggeredEffects && triggeredEffects.triggeredHazards, 0)),
    },
  };
}

function materializeSiteContents(scene, instance, siteEntity, template, options = {}) {
  if (!scene || !siteEntity || !instance) {
    return {
      containersSpawned: 0,
      hazardsSpawned: 0,
      environmentPropsSpawned: 0,
      gatesSpawned: 0,
      objectivesSpawned: 0,
      encountersSpawned: 0,
    };
  }
  const materializedSiteID = Math.max(
    0,
    toInt(
      siteEntity && siteEntity.itemID,
      instance && instance.metadata && instance.metadata.siteID,
    ),
  );
  // A persisted instance can outlive its template (a removed content pack). The startup sweep
  // purges those, but a site that slips through must not throw from inside a warp or gate.
  if (!template) {
    log.warn(
      `[DungeonUniverseSite] instance ${toInt(instance && instance.instanceID, 0)} template ` +
        `${normalizeText(instance && instance.templateID, "")} is not in the effective dungeon authority; ` +
        "site content was not materialized",
    );
    return {
      containersSpawned: 0,
      hazardsSpawned: 0,
      environmentPropsSpawned: 0,
      miningRocksSpawned: 0,
      gatesSpawned: 0,
      objectivesSpawned: 0,
      encountersSpawned: 0,
      templateMissing: true,
    };
  }
  if (materializedSiteID > 0) {
    markSceneSiteMaterialized(scene, materializedSiteID, instance.instanceID);
  }
  let workingInstance = dungeonRuntime.ensureTemplateRuntimeState(
    Math.max(0, toInt(instance && instance.instanceID, 0)),
    {
      nowMs: options.nowMs,
    },
  ) || instance;
  const populationHints = resolvePopulationHints(workingInstance, template);
  if (!workingInstance.spawnState?.hackingContainerLayout && !populationHints?.homefront &&
      !require("../seasons/eventHooks").depot.isDepot(workingInstance)) {
    const layoutEntities = buildContainerEntities(workingInstance, siteEntity, populationHints, template);
    if (layoutEntities.some(isDataRelicMaterializedContainer)) {
      // Freeze stable content identities before creating loot or containers.
      // Catalog updates must never generate a new can over an old outcome.
      workingInstance = dungeonRuntime.mergeSpawnState(workingInstance.instanceID, {
        hackingContainerLayout: { version: 1, entities: cloneValue(layoutEntities),
          populationHints: cloneValue(populationHints) },
      }, { nowMs: options.nowMs, durable: true, force: true });
    }
  }
  rematerializeStoredDungeonEncounterEntities(
    scene,
    workingInstance,
    siteEntity,
    { nowMs: options.nowMs },
  );
  const rehydrated = rehydrateMissingEncounterStates(scene, workingInstance, populationHints, {
    nowMs: options.nowMs,
  });
  workingInstance = rehydrated.instance || workingInstance;
  const contentEntities = buildContainerEntities(workingInstance, siteEntity, populationHints)
    .map((entity) => decorateGeneratedMiningSiteEntity(entity, workingInstance, template));
  const staticBroadcastEntities = [];
  let containersSpawned = 0;
  for (const entity of contentEntities) {
    const created = materializeContainerEntity(
      scene,
      workingInstance,
      siteEntity,
      template,
      populationHints,
      entity,
      {
        nowMs: options.nowMs,
        broadcast: options.broadcast === true,
        excludedSession: options.excludedSession || null,
      },
    );
    if (created) {
      containersSpawned += 1;
    }
  }
  const hazardEntities = buildHazardEntities(workingInstance, siteEntity, populationHints)
    .map((entity) => decorateGeneratedMiningSiteEntity(entity, workingInstance, template));
  const ghostTimerPhaseSpec = resolveGhostTimerPhaseSpec(populationHints);
  if (ghostTimerPhaseSpec) {
    armDeferredEncounterPlans(workingInstance, populationHints, { nowMs: options.nowMs });
    workingInstance = dungeonRuntime.getInstance(workingInstance.instanceID) || workingInstance;
  }
  const ghostTimerInstance = dungeonRuntime.getInstance(workingInstance.instanceID) || workingInstance;
  const ghostTimerPlan = resolveGhostTimerPlan(populationHints);
  const ghostTimerState = ghostTimerPlan ? getEncounterStateByKey(ghostTimerInstance, ghostTimerPlan.key) : null;
  let hazardsSpawned = 0;
  for (const entity of hazardEntities) {
    if (isDeferredGhostTimerHazardEntity(entity) && toInt(ghostTimerState?.triggeredEffectsAtMs, 0) > 0) continue;
    if (scene.staticEntitiesByID && scene.staticEntitiesByID.has(Number(entity.itemID))) {
      continue;
    }
    const hidden = isDeferredGhostTimerHazardEntity(entity) &&
      toInt(ghostTimerState?.ghostTimerHazardsVisibleAtMs, 0) <= 0;
    // A hidden countdown is durable encounter state, not a native Ball. The
    // retail Grid bubble publishes every non-cloaked Ball it owns; creating
    // this beacon early would expose it during SetState or a bubble update.
    // materializeDeferredGhostTimerHazards creates it after the reveal commits.
    if (hidden) continue;
    scene.addStaticEntity(entity);
    if (scene.staticEntitiesByID && scene.staticEntitiesByID.has(Number(entity.itemID))) {
      hazardsSpawned += 1;
      staticBroadcastEntities.push(entity);
    }
  }
  materializeSleeperToxicClouds(scene, ghostTimerInstance, siteEntity, populationHints,
    { nowMs: options.nowMs, restoreOnly: true });
  const gateEntities = buildGateEntities(workingInstance, siteEntity, template)
    .map((entity) => decorateGeneratedMiningSiteEntity(entity, workingInstance, template));
  let gatesSpawned = 0;
  for (const entity of gateEntities) {
    if (scene.staticEntitiesByID && scene.staticEntitiesByID.has(Number(entity.itemID))) {
      continue;
    }
    scene.addStaticEntity(entity);
    if (scene.staticEntitiesByID && scene.staticEntitiesByID.has(Number(entity.itemID))) {
      gatesSpawned += 1;
      staticBroadcastEntities.push(entity);
    }
  }
  const environmentEntities = buildEnvironmentEntities(workingInstance, siteEntity, template, populationHints)
    .map((entity) => decorateGeneratedMiningSiteEntity(entity, workingInstance, template));
  let environmentPropsSpawned = 0;
  for (const entity of environmentEntities) {
    if (scene.staticEntitiesByID && scene.staticEntitiesByID.has(Number(entity.itemID))) {
      continue;
    }
    scene.addStaticEntity(entity);
    if (scene.staticEntitiesByID && scene.staticEntitiesByID.has(Number(entity.itemID))) {
      environmentPropsSpawned += 1;
      staticBroadcastEntities.push(entity);
    }
  }
  // Mining missions: spawn the special mineable asteroids and register each one's ore quantity so
  // the existing mining systems can harvest them (Plan C). Best-effort and gated on miningRocks.
  const miningRockEntities = buildMiningRockEntities(workingInstance, siteEntity, populationHints);
  let miningRocksSpawned = 0;
  if (miningRockEntities.length > 0) {
    let miningRuntimeState = null;
    try {
      miningRuntimeState = require(path.join(__dirname, "../mining/miningRuntimeState"));
    } catch (_error) {
      miningRuntimeState = null;
    }
    for (const entity of miningRockEntities) {
      if (scene.staticEntitiesByID && scene.staticEntitiesByID.has(Number(entity.itemID))) {
        continue;
      }
      scene.addStaticEntity(entity);
      if (scene.staticEntitiesByID && scene.staticEntitiesByID.has(Number(entity.itemID))) {
        miningRocksSpawned += 1;
        staticBroadcastEntities.push(entity);
        if (miningRuntimeState && typeof miningRuntimeState.updateMineableState === "function") {
          try {
            miningRuntimeState.updateMineableState(scene, entity, {
              entityID: entity.itemID,
              visualTypeID: entity.visualTypeID || entity.typeID,
              yieldTypeID: entity.miningYieldTypeID,
              yieldKind: entity.miningYieldKind || "ore",
              unitVolume: entity.miningUnitVolume,
              originalQuantity: entity.miningOriginalQuantity || entity.miningRemainingQuantity,
              remainingQuantity: entity.miningRemainingQuantity,
              originalRadius: entity.radius,
            });
          } catch (error) {
            // Mineable registration is best-effort; the rock still renders if it fails.
            log.debug(`[DungeonSites] mineable registration for ${entity.itemID} failed: ${error && error.message}`);
          }
        }
      }
    }
  }
  const objectiveEntities = buildObjectiveEntities(workingInstance, siteEntity, template, populationHints)
    .map((entity) => decorateGeneratedMiningSiteEntity(entity, workingInstance, template));
  let objectivesSpawned = 0;
  for (const entity of objectiveEntities) {
    if (scene.staticEntitiesByID && scene.staticEntitiesByID.has(Number(entity.itemID))) {
      continue;
    }
    scene.addStaticEntity(entity);
    if (scene.staticEntitiesByID && scene.staticEntitiesByID.has(Number(entity.itemID))) {
      objectivesSpawned += 1;
      staticBroadcastEntities.push(entity);
    }
  }

  broadcastStaticSiteContentBatch(scene, staticBroadcastEntities, options);

  let encountersSpawned = 0;
  armDeferredEncounterPlans(workingInstance, populationHints, {
    nowMs: options.nowMs,
  });
  if (options.spawnEncounters !== false) {
    const onLoadEncountersSpawned = processEncounterPlansForTrigger(
      scene,
      workingInstance,
      siteEntity,
      populationHints,
      "on_load",
      {
        nowMs: options.nowMs,
        session: options.session || null,
      },
    );
    encountersSpawned += onLoadEncountersSpawned;
    if (onLoadEncountersSpawned <= 0) {
    const refreshedInstance =
      dungeonRuntime.getInstance(Math.max(0, toInt(workingInstance && workingInstance.instanceID, 0))) ||
      workingInstance;
    syncEncounterStateProgress(scene, refreshedInstance, resolveEncounterPlans(populationHints), {
      nowMs: options.nowMs,
    });
    encountersSpawned += processEncounterPlansForTrigger(
      scene,
      refreshedInstance,
      siteEntity,
      populationHints,
      "wave_cleared",
      {
        nowMs: options.nowMs,
        session: options.session || null,
      },
    );
    const afterWaveClear =
      dungeonRuntime.getInstance(Math.max(0, toInt(workingInstance && workingInstance.instanceID, 0))) ||
      refreshedInstance;
    syncEncounterStateProgress(scene, afterWaveClear, resolveEncounterPlans(populationHints), {
      nowMs: options.nowMs,
    });
    encountersSpawned += processEncounterPlansForTrigger(
      scene,
      afterWaveClear,
      siteEntity,
      populationHints,
      "battleships_destroyed",
      {
        nowMs: options.nowMs,
        session: options.session || null,
      },
    );
    }
  }

  return {
    containersSpawned,
    hazardsSpawned,
    environmentPropsSpawned,
    miningRocksSpawned,
    gatesSpawned,
    objectivesSpawned,
    encountersSpawned,
  };
}

function ensureSiteContentsMaterialized(scene, instanceOrSite, options = {}) {
  if (!scene) {
    return {
      success: false,
      errorMsg: "SCENE_NOT_FOUND",
    };
  }

  let instance = resolveManagedUniverseSiteInstance(scene, instanceOrSite, options);
  if (!instance) {
    return {
      success: false,
      errorMsg: "INSTANCE_NOT_FOUND",
    };
  }
  if (options.session) {
    const visibilityResolution =
      dungeonVisibilityPolicy.resolveDungeonInstanceVisibilityForSession(
        options.session,
        instance.instanceID,
        { systemID: scene.systemID },
      );
    if (!visibilityResolution) {
      return {
        success: false,
        errorMsg: "DUNGEON_INSTANCE_NOT_AUTHORIZED",
      };
    }
    instance = visibilityResolution.instance;
  }

  const siteID = Math.max(0, toInt(instance && instance.metadata && instance.metadata.siteID, 0));
  if (siteID <= 0) {
    return {
      success: false,
      errorMsg: "SITE_NOT_FOUND",
    };
  }

  let siteEntity = (
    scene.staticEntitiesByID &&
    scene.staticEntitiesByID.get(siteID)
  ) || null;
  if (!siteEntity) {
    upsertSceneEntity(scene, instance, {
      broadcast: options.broadcast === true,
      excludedSession: options.excludedSession || null,
      nowMs: options.nowMs,
    });
    siteEntity = (
      scene.staticEntitiesByID &&
      scene.staticEntitiesByID.get(siteID)
    ) || buildSiteEntity(instance);
  }
  if (!siteEntity) {
    return {
      success: false,
      errorMsg: "SITE_ENTITY_NOT_FOUND",
    };
  }

  const alreadyMaterialized = isSceneSiteMaterialized(scene, siteID);

  const template = dungeonAuthority.getTemplateByID(instance.templateID);
  const contentSummary = materializeSiteContents(scene, instance, siteEntity, template, {
    spawnEncounters: options.spawnEncounters !== false,
    nowMs: options.nowMs,
    broadcast: options.broadcast === true,
    excludedSession: options.excludedSession || null,
    session: options.session || null,
  });
  markSceneSiteMaterialized(scene, siteID, instance.instanceID);
  if (options.session && options.markCurrentDungeonRoom === true) {
    dungeonTrackingRuntime.enterDungeonRoomForSession(scene, options.session, instance, "room:entry", {
      nowMs: options.nowMs,
      roomPosition: siteEntity.position,
      siteID,
    });
  }
  // Diagnostic: how many mining-rock entities are actually present in the scene for this instance (vs only
  // spawned-this-call, which is 0 once cached), and the nearest rock's distance from the site beacon - so a
  // warp can tell whether the asteroid exists at all vs. a render/distance problem.
  const instanceIDForCount = Math.max(0, toInt(instance.instanceID, 0));
  let miningRockEntityCount = 0;
  let firstRockDistanceMeters = null;
  if (scene.staticEntitiesByID instanceof Map) {
    for (const entity of scene.staticEntitiesByID.values()) {
      if (
        entity &&
        entity.dungeonMaterializedMiningRock === true &&
        Math.max(0, toInt(entity.dungeonSiteInstanceID, 0)) === instanceIDForCount
      ) {
        miningRockEntityCount += 1;
        if (firstRockDistanceMeters === null && entity.position && siteEntity.position) {
          const dx = toFiniteNumber(entity.position.x, 0) - toFiniteNumber(siteEntity.position.x, 0);
          const dy = toFiniteNumber(entity.position.y, 0) - toFiniteNumber(siteEntity.position.y, 0);
          const dz = toFiniteNumber(entity.position.z, 0) - toFiniteNumber(siteEntity.position.z, 0);
          firstRockDistanceMeters = Math.round(Math.sqrt(dx * dx + dy * dy + dz * dz));
        }
      }
    }
  }
  return {
    success: true,
    data: {
      instanceID: instanceIDForCount,
      siteID,
      alreadyMaterialized,
      contentSummary,
      miningRockEntityCount,
      firstRockDistanceMeters,
    },
  };
}

function spawnTemplateForSession(session, templateID, options = {}) {
  const requestedTemplateID = normalizeText(templateID, "");
  const normalizedTemplateID = /^\d+$/.test(requestedTemplateID)
    ? `client-dungeon:${Number(requestedTemplateID)}`
    : requestedTemplateID;
  const template = dungeonAuthority.getTemplateByID(normalizedTemplateID);
  if (!template) {
    return {
      success: false,
      errorMsg: "DUNGEON_TEMPLATE_NOT_FOUND",
    };
  }
  const runtime = getSpaceRuntime();
  const scene = runtime && typeof runtime.getSceneForSession === "function"
    ? runtime.getSceneForSession(session)
    : null;
  if (!scene) {
    return {
      success: false,
      errorMsg: "NOT_IN_SPACE",
    };
  }
  const shipEntity = typeof scene.getShipEntityForSession === "function"
    ? scene.getShipEntityForSession(session)
    : null;
  if (!shipEntity) {
    return {
      success: false,
      errorMsg: "SHIP_NOT_FOUND",
    };
  }

  const nowMs = Math.max(0, toInt(options.nowMs, Date.now()));
  const operationKey = options.operationKey;
  const characterID = Math.max(0, toInt(session && session.characterID, 0));
  if (operationKey !== undefined && (!characterID || typeof operationKey !== "string" || !/^[a-zA-Z0-9:_-]{1,200}$/.test(operationKey))) return { success: false, errorMsg: "OPERATION_KEY_INVALID" };
  if (operationKey) {
    const existing = dungeonRuntime.findInstanceBySiteKey(`operation:${characterID}:${operationKey}`, { full: true });
    if (existing) {
      if (existing.lifecycleState !== "active" || existing.templateID !== normalizedTemplateID || existing.solarSystemID !== scene.systemID || Number(existing.ownership?.characterID) !== characterID) return { success: false, errorMsg: "OPERATION_INSTANCE_CONFLICT" };
      upsertSceneEntity(scene, existing, { broadcast: options.broadcast !== false, nowMs });
      const result = ensureSiteContentsMaterialized(scene, existing, { ...options, session, nowMs });
      return result.success ? { success: true, duplicate: true, data: { instance: existing, template, siteID: existing.spawnState.siteID, position: existing.position, materialized: result.data } } : result;
    }
  }
  const nextInstanceID = dungeonRuntime.peekNextInstanceID();
  const siteID = MANUAL_DUNGEON_SITE_ID_BASE + nextInstanceID;
  const label = normalizeText(
    options.label,
    resolveLocalizedTemplateName(template) || normalizedTemplateID,
  );
  const position = options.position && typeof options.position === "object"
    ? clonePosition(options.position)
    : (() => {
      const origin = clonePosition(shipEntity.position);
      const offset = Math.max(0, toFiniteNumber(options.spawnOffsetMeters, 0));
      return {
        ...origin,
        x: origin.x + offset,
      };
    })();
  let instance;
  try {
    instance = dungeonRuntime.createInstance({
      templateID: normalizedTemplateID,
      solarSystemID: Math.max(0, toInt(scene.systemID, 0)),
      siteKey: operationKey ? `operation:${characterID}:${operationKey}` : `manual-spawn:${scene.systemID}:${normalizedTemplateID}:${nextInstanceID}`,
      lifecycleState: "active",
      instanceScope: operationKey ? "private" : "shared",
      ...(operationKey ? { ownership: { characterID, visibilityScope: "private" } } : {}),
      siteFamily: normalizeLowerText(template.siteFamily, "unknown"),
      siteKind: normalizeLowerText(template.siteKind, "anomaly"),
      siteOrigin: operationKey ? "authored_operation" : "manual_spawn_command",
      position,
      nowMs,
      activatedAtMs: nowMs,
      expiresAtMs: operationKey ? 0 : nowMs + MANUAL_DUNGEON_SITE_LIFETIME_MS,
      spawnState: {
        siteID,
        label,
        entryObjectTypeID: Math.max(0, toInt(template.entryObjectTypeID, 0)) || null,
        populationHints: cloneValue(template.populationHints || null),
      },
      runtimeFlags: {
        universeSeeded: true,
        universePersistent: false,
        lazyMaterialized: false,
        manualSpawn: true,
      },
      metadata: {
        providerID: operationKey ? "authoredOperation" : "manualSpawnSiteCommand",
        siteID,
        label,
        manualSpawn: true,
        requestedByCharacterID: Math.max(0, toInt(session && session.characterID, 0)) || null,
        ...(operationKey ? { operationKey } : {}),
      },
    });
  } catch (error) {
    return {
      success: false,
      errorMsg: error && (error.dungeonError || error.message) || "DUNGEON_CREATE_FAILED",
    };
  }

  upsertSceneEntity(scene, instance, {
    broadcast: options.broadcast !== false,
    nowMs,
  });
  const materialized = ensureSiteContentsMaterialized(scene, instance, {
    broadcast: options.broadcast !== false,
    spawnEncounters: options.spawnEncounters !== false,
    session,
    markCurrentDungeonRoom: options.markCurrentDungeonRoom !== false,
    nowMs,
  });
  if (!materialized || materialized.success !== true) {
    dungeonRuntime.purgeInstance(instance.instanceID);
    return {
      success: false,
      errorMsg: materialized && materialized.errorMsg || "DUNGEON_MATERIALIZATION_FAILED",
    };
  }
  return {
    success: true,
    data: {
      instance: dungeonRuntime.getInstance(instance.instanceID) || instance,
      template,
      siteID,
      position,
      materialized: materialized.data,
    },
  };
}

function upsertSceneEntity(scene, instance, options = {}) {
  const entity = buildSiteEntity(instance);
  if (!scene || !entity) {
    return false;
  }
  const existing = scene.staticEntitiesByID && scene.staticEntitiesByID.get(Number(entity.itemID));
  if (!existing) {
    if (!scene.addStaticEntity(entity)) {
      return false;
    }
    if (options.broadcast === true) {
      scene.broadcastAddBalls([entity], options.excludedSession || null);
    }
    return true;
  }

  const nextSignature = buildStableUniverseSiteEntitySignature(entity);
  const previousSignature = buildStableUniverseSiteEntitySignature(existing);
  if (previousSignature === nextSignature) {
    return false;
  }

  scene.removeStaticEntity(entity.itemID, {
    broadcast: options.broadcast === true,
    excludedSession: options.excludedSession || null,
    nowMs: options.nowMs,
  });
  if (!scene.addStaticEntity(entity)) {
    return false;
  }
  if (options.broadcast === true) {
    scene.broadcastAddBalls([entity], options.excludedSession || null);
  }
  return true;
}

function purgePrivateOperationForCharacter(characterID, instanceID, operationKey) {
  const instance = dungeonRuntime.getInstance(instanceID);
  if (!instance) return { success: true, duplicate: true };
  if (instance.instanceScope !== "private" || Number(instance.ownership?.characterID) !== Number(characterID) || instance.metadata?.operationKey !== operationKey) return { success: false, errorMsg: "OPERATION_INSTANCE_NOT_AUTHORIZED" };
  const runtime = getSpaceRuntime();
  const scene = runtime?.scenes?.get(instance.solarSystemID);
  const siteID = instance.spawnState.siteID;
  if (scene) {
    releasePlayerShipsFromSitePocket(scene, { instanceIdentity: instance.instanceID, siteIdentity: siteID });
    removeSceneSiteContent(scene, siteID, { instance, instanceID: instance.instanceID, broadcast: true });
    removeSceneEntity(scene, siteID, { instanceID: instance.instanceID, broadcast: true });
  }
  removeStoredDungeonSiteContent(instance.solarSystemID, { instance, instanceID: instance.instanceID, siteID });
  dungeonRuntime.purgeInstance(instance.instanceID);
  return { success: true };
}

function removeSceneEntity(scene, siteID, options = {}) {
  if (!scene) {
    return false;
  }
  const numericSiteID = toSafeCleanupNumber(siteID);
  if (numericSiteID <= 0) {
    return false;
  }
  const requestedInstanceID = normalizePersistentEntityID(options.instanceID);
  if (requestedInstanceID !== null) {
    const existingRoot =
      scene.staticEntitiesByID instanceof Map
        ? scene.staticEntitiesByID.get(numericSiteID) || null
        : null;
    const rootInstanceID = normalizePersistentEntityID(
      existingRoot && existingRoot.dungeonSiteInstanceID,
    );
    const trackedInstanceID = normalizePersistentEntityID(
      ensureSceneMaterializedSiteInstanceMap(scene).get(numericSiteID),
    );
    if (
      (rootInstanceID !== null &&
        !entityIDsEqual(rootInstanceID, requestedInstanceID)) ||
      (trackedInstanceID !== null &&
        !entityIDsEqual(trackedInstanceID, requestedInstanceID)) ||
      (existingRoot && rootInstanceID === null && trackedInstanceID === null)
    ) {
      return false;
    }
  }
  const removeResult = scene.removeStaticEntity(numericSiteID, {
    broadcast: options.broadcast === true,
    excludedSession: options.excludedSession || null,
    nowMs: options.nowMs,
  });
  return Boolean(removeResult && removeResult.success === true);
}

function normalizeCleanupIdentity(value) {
  return normalizePersistentEntityID(value);
}

function toSafeCleanupNumber(value) {
  const normalized = normalizeCleanupIdentity(value);
  return typeof normalized === "number" ? normalized : 0;
}

function addExactIdentity(identitySet, value) {
  const identityText = getEntityIDText(value);
  if (identityText !== null && normalizeCleanupIdentity(value) !== null) {
    identitySet.add(identityText);
  }
  return identitySet;
}

function exactIdentitySetHas(identitySet, value) {
  const identityText = getEntityIDText(value);
  return identityText !== null && identitySet.has(identityText);
}

function getCanonicalStoredContentItemIDs(instance, options = {}) {
  const systemID = normalizeCleanupIdentity(options.systemID);
  const siteID = normalizeCleanupIdentity(options.siteID);
  const instanceID = normalizeCleanupIdentity(options.instanceID);
  if (
    !instance ||
    systemID === null ||
    siteID === null ||
    instanceID === null ||
    !entityIDsEqual(instance.instanceID, instanceID) ||
    !entityIDsEqual(instance.solarSystemID, systemID) ||
    !entityIDsEqual(instance.metadata && instance.metadata.siteID, siteID)
  ) {
    return new Set();
  }
  const itemIDs = new Set();
  for (const entry of Object.values(getContentEntityRefsByKey(instance))) {
    addExactIdentity(itemIDs, entry && entry.itemID);
  }
  return itemIDs;
}

function storedInventoryItemMatchesDungeonScope(
  item,
  systemID,
  siteID,
  instanceID,
) {
  const spaceState = normalizeObject(item && item.spaceState);
  return Boolean(
    item &&
    entityIDsEqual(item.locationID, systemID) &&
    toInt(item.flagID, -1) === 0 &&
    entityIDsEqual(spaceState.systemID, systemID) &&
    entityIDsEqual(spaceState.dungeonSiteID, siteID) &&
    entityIDsEqual(spaceState.dungeonSiteInstanceID, instanceID)
  );
}

// A deployable launched inside a site (MTU, mobile depot, jettisoned can) inherits the site's
// dungeonSiteID/dungeonSiteInstanceID from the launching ship via buildChildEntityScopeMetadata, so it
// stays visibility-scoped to the pocket. That tag is an isolation key, not an ownership claim: site
// teardown must never delete the player's property. The site's own materialized content is owned by
// SITE_CONTENT_OWNER_ID, so anything else with a real owner belongs to a player and is left alone.
function storedInventoryItemIsPlayerOwned(item) {
  const ownerID = Math.max(0, toInt(item && item.ownerID, 0));
  return ownerID > 0 && ownerID !== SITE_CONTENT_OWNER_ID;
}

function storedInventoryItemBelongsToNativeController(
  item,
  controllerEntityIDs,
) {
  if (
    !item ||
    !(controllerEntityIDs instanceof Set) ||
    controllerEntityIDs.size <= 0
  ) {
    return false;
  }
  return [
    item.fighterState && item.fighterState.controllerID,
    item.launcherID,
  ].some((controllerID) => (
    exactIdentitySetHas(controllerEntityIDs, controllerID)
  ));
}

function getCanonicalEncounterEntityIDs(instance, options = {}) {
  const systemID = normalizeCleanupIdentity(options.systemID);
  const siteID = normalizeCleanupIdentity(options.siteID);
  const instanceID = normalizeCleanupIdentity(options.instanceID);
  if (
    !instance ||
    systemID === null ||
    siteID === null ||
    instanceID === null ||
    !entityIDsEqual(instance.instanceID, instanceID) ||
    !entityIDsEqual(instance.solarSystemID, systemID) ||
    !entityIDsEqual(instance.metadata && instance.metadata.siteID, siteID)
  ) {
    return new Set();
  }
  const entityIDs = new Set();
  const encounterStatesByKey = normalizeObject(
    instance.spawnState && instance.spawnState.encounterStatesByKey,
  );
  for (const encounterState of Object.values(encounterStatesByKey)) {
    for (const entityID of [
      ...normalizeArray(encounterState && encounterState.spawnedEntityIDs),
      ...normalizeArray(encounterState && encounterState.remainingEntityIDs),
    ]) {
      addExactIdentity(entityIDs, entityID);
    }
  }
  return entityIDs;
}

function listStoredDungeonNativeControllerEntityIDs(
  systemID,
  siteID,
  instanceID,
  instance,
  additionalEntityIDs = [],
) {
  const nativeNpcStore = getNativeNpcStore();
  const canonicalEncounterEntityIDs = getCanonicalEncounterEntityIDs(
    instance,
    { systemID, siteID, instanceID },
  );
  const nativeControllerEntityIDs = new Set();
  for (const entityIDText of canonicalEncounterEntityIDs) {
    const numericEntityID = toSafeCleanupNumber(entityIDText);
    const entityRecord = numericEntityID > 0
      ? nativeNpcStore.getNativeEntity(numericEntityID)
      : null;
    const recordSiteID = normalizeCleanupIdentity(
      entityRecord && entityRecord.dungeonSiteID,
    );
    const recordInstanceID = normalizeCleanupIdentity(
      entityRecord && entityRecord.dungeonSiteInstanceID,
    );
    if (
      (recordSiteID !== null && !entityIDsEqual(recordSiteID, siteID)) ||
      (recordInstanceID !== null &&
        !entityIDsEqual(recordInstanceID, instanceID))
    ) {
      continue;
    }
    nativeControllerEntityIDs.add(entityIDText);
  }
  const additionalEntries = additionalEntityIDs instanceof Set
    ? [...additionalEntityIDs]
    : normalizeArray(additionalEntityIDs);
  for (const entityID of additionalEntries) {
    addExactIdentity(nativeControllerEntityIDs, entityID);
  }
  const numericSystemID = toSafeCleanupNumber(systemID);
  for (const entityRecord of nativeNpcStore.listNativeEntitiesForSystem(numericSystemID)) {
    if (
      !entityRecord ||
      !entityIDsEqual(entityRecord.dungeonSiteID, siteID) ||
      !entityIDsEqual(entityRecord.dungeonSiteInstanceID, instanceID)
    ) {
      continue;
    }
    addExactIdentity(nativeControllerEntityIDs, entityRecord.entityID);
  }
  return nativeControllerEntityIDs;
}

function listStoredDungeonNativeWreckIDs(
  systemID,
  siteID,
  instanceID,
  nativeControllerEntityIDs,
) {
  const nativeWreckIDs = new Set();
  for (const wreckRecord of getNativeNpcStore().listNativeWrecks()) {
    const wreckSystemMatches = entityIDsEqual(
      wreckRecord && wreckRecord.systemID,
      systemID,
    );
    const wreckSiteID = normalizeCleanupIdentity(
      wreckRecord && wreckRecord.dungeonSiteID,
    );
    const wreckInstanceID = normalizeCleanupIdentity(
      wreckRecord && wreckRecord.dungeonSiteInstanceID,
    );
    const wreckAirInstanceID = normalizeCleanupIdentity(
      wreckRecord && wreckRecord.airNpeInstanceID,
    );
    const explicitSiteMismatch =
      wreckSiteID !== null && !entityIDsEqual(wreckSiteID, siteID);
    const explicitInstanceMismatch =
      wreckInstanceID !== null &&
      !entityIDsEqual(wreckInstanceID, instanceID);
    const explicitScopeMismatch =
      explicitSiteMismatch || explicitInstanceMismatch;
    const exactScopeMatches =
      wreckSiteID !== null &&
      wreckInstanceID !== null &&
      entityIDsEqual(wreckSiteID, siteID) &&
      entityIDsEqual(wreckInstanceID, instanceID);
    const sourceMatchesCanonicalEncounter =
      !explicitScopeMismatch &&
      [wreckRecord && wreckRecord.sourceEntityID, wreckRecord && wreckRecord.launcherID]
        .some((sourceEntityID) => (
          exactIdentitySetHas(nativeControllerEntityIDs, sourceEntityID)
        ));
    const projectedAirSourceMatchesCanonicalEncounter =
      explicitInstanceMismatch &&
      wreckSiteID !== null &&
      wreckInstanceID !== null &&
      wreckAirInstanceID !== null &&
      !explicitSiteMismatch &&
      entityIDsEqual(wreckSiteID, siteID) &&
      entityIDsEqual(wreckInstanceID, wreckAirInstanceID) &&
      exactIdentitySetHas(
        nativeControllerEntityIDs,
        wreckRecord && wreckRecord.sourceEntityID,
      );
    if (
      wreckRecord &&
      wreckSystemMatches &&
      (
        exactScopeMatches ||
        sourceMatchesCanonicalEncounter ||
        projectedAirSourceMatchesCanonicalEncounter
      )
    ) {
      addExactIdentity(nativeWreckIDs, wreckRecord.wreckID);
    }
  }
  return nativeWreckIDs;
}

function listStoredDungeonInventoryItemIDs(
  systemID,
  siteID,
  instanceID,
  instance,
  nativeControllerEntityIDs,
) {
  const canonicalContentItemIDs = getCanonicalStoredContentItemIDs(
    instance,
    {
      systemID,
      siteID,
      instanceID,
    },
  );
  // Runs on every persistent site despawn anywhere in the universe, so it must not clone
  // the items table: listItemsMatching copies only the rows accepted here.
  const matchedItems = listItemsMatching((item) => {
    const itemID = toSafeCleanupNumber(item && item.itemID);
    if (itemID <= 0) {
      return false;
    }
    const isCanonicalContentRef =
      exactIdentitySetHas(canonicalContentItemIDs, itemID) &&
      entityIDsEqual(item.locationID, systemID) &&
      toInt(item.flagID, -1) === 0 &&
      entityIDsEqual(item.spaceState && item.spaceState.systemID, systemID);
    const matchesInheritedDungeonScope =
      storedInventoryItemMatchesDungeonScope(
        item,
        systemID,
        siteID,
        instanceID,
      ) &&
      !storedInventoryItemIsPlayerOwned(item);
    return (
      isCanonicalContentRef ||
      matchesInheritedDungeonScope ||
      storedInventoryItemBelongsToNativeController(
        item,
        nativeControllerEntityIDs,
      )
    );
  });
  return new Set(
    matchedItems.map((item) => toSafeCleanupNumber(item.itemID)),
  );
}

function removeStoredDungeonSiteContent(systemID, options = {}) {
  const normalizedSystemID = normalizeCleanupIdentity(systemID);
  const siteID = normalizeCleanupIdentity(options.siteID);
  const instanceID = normalizeCleanupIdentity(options.instanceID);
  const numericSystemID = toSafeCleanupNumber(normalizedSystemID);
  if (numericSystemID <= 0 || siteID === null || instanceID === null) {
    return 0;
  }
  const nativeNpcStore = getNativeNpcStore();
  let removedCount = 0;
  const nativeControllerEntityIDs = listStoredDungeonNativeControllerEntityIDs(
    numericSystemID,
    siteID,
    instanceID,
    options.instance,
    options.nativeControllerEntityIDs,
  );
  const inventoryItemIDs = listStoredDungeonInventoryItemIDs(
    numericSystemID,
    siteID,
    instanceID,
    options.instance,
    nativeControllerEntityIDs,
  );
  for (const itemID of inventoryItemIDs) {
    const item = findItemById(itemID);
    if (item && Number(item.groupID) === 186 && item.spaceState?.homefrontRole !== "artifactCacheWreck") {
      updateInventoryItem(itemID, (currentItem) => ({
        ...currentItem,
        spaceState: clearDungeonScopeFields(currentItem.spaceState),
      }));
      continue;
    }
    const result = removeInventoryItem(itemID, { removeContents: true });
    if (result && result.success === true) {
      removedCount += Math.max(
        1,
        Array.isArray(result.data && result.data.removedItems)
          ? result.data.removedItems.length
          : 0,
      );
    }
  }

  for (const entityIDText of nativeControllerEntityIDs) {
    const entityID = toSafeCleanupNumber(entityIDText);
    if (entityID <= 0) {
      continue;
    }
    const result = nativeNpcStore.removeNativeEntityCascade(entityID);
    if (result && result.success === true) {
      removedCount += 1;
    }
  }
  // Site lifetime does not own wreck lifetime, even when the grid is unloaded.
  // Release the persisted wrecks so returning pilots can still loot/salvage
  // them; their own expiresAtMs remains the only normal expiry clock.
  const nativeWreckIDs = listStoredDungeonNativeWreckIDs(
    normalizedSystemID,
    siteID,
    instanceID,
    nativeControllerEntityIDs,
  );
  for (const wreckIDText of nativeWreckIDs) {
    const wreckID = toSafeCleanupNumber(wreckIDText);
    if (wreckID <= 0) {
      continue;
    }
    const wreck = nativeNpcStore.getNativeWreck(wreckID);
    if (wreck) {
      nativeNpcStore.upsertNativeWreck(clearDungeonScopeFields(wreck), {
        transient: wreck.transient === true,
      });
    }
  }
  return removedCount;
}

function removeSceneSiteContent(scene, siteID, options = {}) {
  if (!scene) {
    return 0;
  }
  const normalizedSiteID = normalizeCleanupIdentity(siteID);
  const normalizedInstanceID = normalizeCleanupIdentity(options.instanceID);
  const cleanupInstance = options.instance || dungeonRuntime.getInstance(options.instanceID);
  if (
    cleanupInstance &&
    ["completed", "failed", "despawned"].includes(
      cleanupInstance.lifecycleState,
    )
  ) {
    require("../homefront/homefrontHooks").weather.cleanupSite(
      scene,
      cleanupInstance,
    );
    require("../homefront/homefrontHooks").runtime.closeOperation(
      cleanupInstance,
    );
  }
  const numericSiteID = toSafeCleanupNumber(normalizedSiteID);
  if (numericSiteID <= 0) {
    return removeStoredDungeonSiteContent(scene.systemID, {
      ...options,
      siteID: normalizedSiteID,
      instanceID: normalizedInstanceID,
    });
  }
  const contentEntities = listMaterializedUniverseSiteContentEntities(scene, {
    siteID: numericSiteID,
  }).filter((entity) => (
    normalizedInstanceID === null ||
    entityIDsEqual(entity && entity.dungeonSiteInstanceID, normalizedInstanceID)
  ))
    // Site NPC wrecks carry the site's dungeonMaterializedSiteContent tag, so they land in this list
    // by default. They must survive the site: see the note in removeStoredDungeonSiteContent.
    .filter((entity) => !(entity && (entity.nativeNpcWreck === true ||
      (entity.kind === "wreck" && entity.homefrontRole !== "artifactCacheWreck"))));
  const nativeControllerEntityIDs = listStoredDungeonNativeControllerEntityIDs(
    Math.max(0, toInt(scene.systemID, 0)),
    normalizedSiteID,
    normalizedInstanceID,
    options.instance,
    contentEntities
      .filter((entity) => entity && entity.nativeNpc === true)
      .map((entity) => entity.itemID),
  );
  const contentEntityIDs = new Set();
  for (const entity of contentEntities) {
    addExactIdentity(contentEntityIDs, entity && entity.itemID);
  }
  if (scene.dynamicEntities instanceof Map) {
    for (const entity of scene.dynamicEntities.values()) {
      const liveSiteID = normalizeCleanupIdentity(
        entity && entity.dungeonSiteID,
      );
      const liveInstanceID = normalizeCleanupIdentity(
        entity && entity.dungeonSiteInstanceID,
      );
      const hasExplicitScopeMismatch =
        (liveSiteID !== null &&
          !entityIDsEqual(liveSiteID, normalizedSiteID)) ||
        (liveInstanceID !== null &&
          !entityIDsEqual(liveInstanceID, normalizedInstanceID));
      const isCanonicalNativeNpc =
        entity &&
        entity.nativeNpc === true &&
        !hasExplicitScopeMismatch &&
        exactIdentitySetHas(nativeControllerEntityIDs, entity.itemID);
      if (
        isCanonicalNativeNpc &&
        !exactIdentitySetHas(contentEntityIDs, entity.itemID)
      ) {
        contentEntities.push(entity);
        addExactIdentity(contentEntityIDs, entity.itemID);
      }
    }
  }
  const storedInventoryItemIDs = listStoredDungeonInventoryItemIDs(
    Math.max(0, toInt(scene.systemID, 0)),
    normalizedSiteID,
    normalizedInstanceID,
    options.instance,
    nativeControllerEntityIDs,
  );
  let removedCount = 0;
  for (const entity of contentEntities) {
    // Clearing a whole grid (teardown, or an in-place site refresh) resolves no
    // cache. Only a hack, a failed hack, a timer or looting marks one resolved.
    const removeResult = removeMaterializedContentEntity(scene, entity, {
      broadcast: options.broadcast === true,
      excludedSession: options.excludedSession || null,
      nowMs: options.nowMs,
    });
    if (removeResult && removeResult.success === true) {
      removedCount += 1;
    }
  }
  const spaceRuntime = getSpaceRuntime();
  for (const itemID of storedInventoryItemIDs) {
    const storedItem = findItemById(itemID);
    if (Number(storedItem?.groupID) === 186 && storedItem?.spaceState?.homefrontRole !== "artifactCacheWreck") {
      continue;
    }
    if (
      !(scene.dynamicEntities instanceof Map) ||
      !scene.dynamicEntities.has(itemID) ||
      !findItemById(itemID)
    ) {
      continue;
    }
    const removeResult = spaceRuntime.destroyDynamicInventoryEntity(
      scene.systemID,
      itemID,
      {
        removeContents: true,
        broadcast: options.broadcast === true,
        excludedSession: options.excludedSession || null,
        nowMs: options.nowMs,
      },
    );
    if (removeResult && removeResult.success === true) {
      removedCount += 1;
    }
  }
  removedCount += removeStoredDungeonSiteContent(scene.systemID, {
    ...options,
    siteID: normalizedSiteID,
    nativeControllerEntityIDs,
  });
  const trackedInstanceID = normalizeCleanupIdentity(
    ensureSceneMaterializedSiteInstanceMap(scene).get(numericSiteID),
  );
  const rootInstanceID = normalizeCleanupIdentity(
    scene.staticEntitiesByID instanceof Map &&
      scene.staticEntitiesByID.get(numericSiteID) &&
      scene.staticEntitiesByID.get(numericSiteID).dungeonSiteInstanceID,
  );
  const materializedOwnerInstanceIDs = [trackedInstanceID, rootInstanceID]
    .filter((ownerInstanceID) => ownerInstanceID !== null);
  const everyMaterializedOwnerMatches =
    materializedOwnerInstanceIDs.length > 0 &&
    materializedOwnerInstanceIDs.every((ownerInstanceID) => (
      entityIDsEqual(ownerInstanceID, normalizedInstanceID)
    ));
  if (
    normalizedInstanceID === null ||
    everyMaterializedOwnerMatches
  ) {
    unmarkSceneSiteMaterialized(scene, numericSiteID);
  }
  return removedCount;
}

function notifyTrackerDelta(systemID, siteKind, options = {}) {
  const scanMgrService = getScanMgrService();
  if (siteKind === "anomaly") {
    scanMgrService.notifyAnomalyDeltaForSystem(systemID, options);
    return;
  }
  scanMgrService.notifySignatureDeltaForSystem(systemID, options);
}

// Occupancy grace (TQ parity): a site closes when its grid empties, not when its last NPC pops. Killing
// the final rat flips the instance to "completed" synchronously inside the destroy call, so without
// this gate the beacon, the props and everything scoped to the pocket vanish out from under the players
// still sitting in it. Terminal teardown parks in this per-scene map instead and is drained by
// tickSceneSiteBehaviors once nobody is left on grid.
function ensureScenePendingSiteTeardownMap(scene) {
  if (!scene) {
    return new Map();
  }
  if (!(scene._dungeonUniversePendingSiteTeardowns instanceof Map)) {
    scene._dungeonUniversePendingSiteTeardowns = new Map();
  }
  return scene._dungeonUniversePendingSiteTeardowns;
}

function buildPendingSiteTeardownKey(siteIdentity, instanceIdentity) {
  return `${siteIdentity === null ? "" : siteIdentity}:${instanceIdentity === null ? "" : instanceIdentity}`;
}

// Asked by SpaceScene.resolveDungeonInstanceVisibilityForSession. A parked teardown is the only reason a
// terminal instance is still allowed to resolve for visibility and for warp-in authority.
function hasPendingSiteTeardownForInstance(scene, instanceID) {
  const pending = ensureScenePendingSiteTeardownMap(scene);
  if (pending.size <= 0) {
    return false;
  }
  const normalizedInstanceID = normalizeCleanupIdentity(instanceID);
  if (normalizedInstanceID === null) {
    return false;
  }
  for (const entry of pending.values()) {
    if (
      entry &&
      entityIDsEqual(entry.instanceIdentity, normalizedInstanceID)
    ) {
      return true;
    }
  }
  return false;
}

function resolveSiteOccupancyProbe(scene, instance, siteID) {
  const numericSiteID = toSafeCleanupNumber(siteID);
  const liveRoot = numericSiteID > 0 && scene && scene.staticEntitiesByID instanceof Map
    ? scene.staticEntitiesByID.get(numericSiteID) || null
    : null;
  return liveRoot || buildSiteEntity(instance);
}

// The world positions of the rooms a site's template places, per site instance: instance identity
// text -> (template ID + site position key -> positions). Presence runs on every pending-teardown
// drain and runtime change, so the template is resolved once per instance rather than per call; the
// instance's entries go when it is purged (handleRuntimeChange) or its teardown runs.
const siteRoomPositionsByInstance = new Map();

function resolveTemplateRoomWorldPositions(template, sitePosition) {
  return normalizeArray(resolveSiteSceneProfile(template).roomProfiles)
    .map((room) => resolveRoomWorldPositionForTemplate(sitePosition, template, room && room.roomKey))
    .filter(Boolean);
}

function getSiteRoomWorldPositions(instanceIdentity, templateID, sitePosition) {
  const normalizedTemplateID = normalizeText(templateID, "");
  if (!normalizedTemplateID) {
    return [];
  }
  const instanceKey = getEntityIDText(instanceIdentity);
  if (instanceKey === null) {
    // No instance identity to drop the entry by on purge: resolve without caching.
    return resolveTemplateRoomWorldPositions(
      dungeonAuthority.getTemplateByID(normalizedTemplateID),
      sitePosition,
    );
  }
  const entryKey = `${normalizedTemplateID}|${sitePosition.x}|${sitePosition.y}|${sitePosition.z}`;
  let entries = siteRoomPositionsByInstance.get(instanceKey);
  if (!entries) {
    entries = new Map();
    siteRoomPositionsByInstance.set(instanceKey, entries);
  }
  if (!entries.has(entryKey)) {
    entries.set(entryKey, resolveTemplateRoomWorldPositions(
      dungeonAuthority.getTemplateByID(normalizedTemplateID),
      sitePosition,
    ));
  }
  return entries.get(entryKey);
}

function dropSiteRoomWorldPositions(instanceIdentity) {
  const instanceKey = getEntityIDText(instanceIdentity);
  if (instanceKey !== null) {
    siteRoomPositionsByInstance.delete(instanceKey);
  }
}

// Deliberately NOT anyPlayerShipWithinRange: that helper gates on canEntitiesInteractLocally, which
// rejects any ship whose scope does not mirror the site's. Here the question is the looser "is anyone
// still standing on this grid", so only a ship explicitly claimed by a *different* pocket is discounted
// - an unscoped ship sitting in the site still counts, and holding the site open is the safe answer.
function anyPlayerShipPresentAtSite(scene, instance, siteID) {
  const probe = resolveSiteOccupancyProbe(scene, instance, siteID);
  const position = clonePosition(
    (probe && probe.position) || (instance && instance.position),
  );
  if (!position || !scene || !(scene.dynamicEntities instanceof Map)) {
    return false;
  }
  const instanceIdentity = normalizeCleanupIdentity(
    (instance && instance.instanceID) ??
    (probe && probe.dungeonSiteInstanceID),
  );
  const rangeSquared =
    SITE_OCCUPANCY_GRACE_RANGE_METERS * SITE_OCCUPANCY_GRACE_RANGE_METERS;
  // Upstream's rule: DED complexes and mission pockets end far from the entry beacon, so a
  // pilot near any room the template places is still at the site, claimed into this instance or not.
  // A template with no room positions leaves the entry and the claim below.
  const templateRoomPositions = getSiteRoomWorldPositions(
    instanceIdentity,
    instance && instance.templateID,
    position,
  );
  for (const entity of scene.dynamicEntities.values()) {
    if (!entity || entity.kind !== "ship") {
      continue;
    }
    if (toInt(entity.charID, 0) <= 0 && toInt(entity.characterID, 0) <= 0) {
      continue;
    }
    const shipInstanceIdentity = normalizeCleanupIdentity(
      entity.dungeonCurrentInstanceID ?? entity.dungeonSiteInstanceID,
    );
    if (
      shipInstanceIdentity !== null &&
      instanceIdentity !== null &&
      !entityIDsEqual(shipInstanceIdentity, instanceIdentity)
    ) {
      continue;
    }
    const entityPosition = entity.position;
    if (!entityPosition) {
      continue;
    }
    if (isWithinRangeSquared(entityPosition, position, rangeSquared)) {
      return true;
    }
    if (templateRoomPositions.some((roomPosition) => (
      isWithinRangeSquared(entityPosition, roomPosition, rangeSquared)
    ))) {
      return true;
    }
    // A pocket's rooms behind an acceleration gate sit where the dungeon's data puts them, often
    // thousands of km from the entry room ("Avenge a Fallen Comrade"'s second room is 31,457
    // km away). A ship this pocket claims is also on its grid when it is near the room it was put
    // in; a stale claim on a ship that has flown off counts for nothing.
    const roomPosition = Array.isArray(entity.dungeonCurrentRoomPosition) &&
      entity.dungeonCurrentRoomPosition.length === 3
      ? {
          x: toFiniteNumber(entity.dungeonCurrentRoomPosition[0], 0),
          y: toFiniteNumber(entity.dungeonCurrentRoomPosition[1], 0),
          z: toFiniteNumber(entity.dungeonCurrentRoomPosition[2], 0),
        }
      : null;
    if (
      roomPosition &&
      shipInstanceIdentity !== null &&
      instanceIdentity !== null &&
      isWithinRangeSquared(entityPosition, roomPosition, rangeSquared)
    ) {
      return true;
    }
  }
  return false;
}

function isWithinRangeSquared(entityPosition, position, rangeSquared) {
  const dx = toFiniteNumber(entityPosition.x, 0) - position.x;
  const dy = toFiniteNumber(entityPosition.y, 0) - position.y;
  const dz = toFiniteNumber(entityPosition.z, 0) - position.z;
  return (dx * dx) + (dy * dy) + (dz * dz) <= rangeSquared;
}

// A survivor is anything the teardown deliberately left standing: an NPC wreck (its own expiresAtMs runs
// the clock, not the site) or a deployable a player launched inside the pocket. Site content is owned by
// SITE_CONTENT_OWNER_ID and is already gone by the time this runs.
function isSurvivingSitePocketEntity(entity) {
  if (!entity) {
    return false;
  }
  if (entity.nativeNpcWreck === true || entity.kind === "wreck") {
    return true;
  }
  if (entity.dungeonMaterializedSiteContent === true) {
    return false;
  }
  const ownerID = Math.max(0, toInt(entity.ownerID, 0));
  return ownerID > 0 && ownerID !== SITE_CONTENT_OWNER_ID;
}

// Every dungeon* field goes, not just the two identity fields. Two reasons, and both are load-bearing:
// nativeNpcStore rejects a record that keeps a scope marker (dungeonMaterializedSiteContent,
// dungeonEncounterKey, ...) without an instance identity to hang it on - NPC_PRIVATE_SCOPE_INVALID - and
// SpaceScene.canSessionSeeDungeonScopedEntity treats any surviving marker as "this is dungeon content",
// which hides an unscoped object from everyone. A survivor is leaving the dungeon, so it leaves whole.
// air* NPE scoping is a different subsystem and is deliberately left alone.
function clearDungeonScopeFields(source) {
  const next = { ...(source || {}) };
  for (const key of Object.keys(next)) {
    if (key.startsWith("dungeon")) {
      delete next[key];
    }
  }
  return next;
}

function clearEntityDungeonScopeFields(entity) {
  if (!entity) {
    return;
  }
  for (const key of Object.keys(entity)) {
    if (key.startsWith("dungeon")) {
      delete entity[key];
    }
  }
  // The nested copy counts too: resolveEntityInteractionScope reads spaceState as well as the top level,
  // so a wreck released with its spaceState still tagged hands the purged instance to the container
  // salvagerRuntime spawns from it, and that container is hidden from everyone.
  if (entity.spaceState && typeof entity.spaceState === "object" && !Array.isArray(entity.spaceState)) {
    entity.spaceState = clearDungeonScopeFields(entity.spaceState);
  }
}

// TQ parity: a cleared anomaly's wrecks and the MTU you left in it are ordinary objects in space, not
// site content - you bookmark them, warp back with a salvager and they are still there. Here they were
// tagged with the site's dungeonSiteID/dungeonSiteInstanceID purely so the pocket stayed isolated while
// it was open. Once the pocket closes that tag becomes a trap: dungeonVisibilityPolicy refuses to resolve
// a terminal instance, and a ship can only ever acquire dungeon scope by warping to a *live* instance, so
// anything still wearing the tag is invisible and unreachable until it expires on its own. Dropping the
// tag at teardown hands them back to normal space.
// Hands one survivor back to normal space: the live entity, and whichever store owns its persisted
// copy. Shared by the teardown sweep and the stranded sweep so there is exactly one definition of
// what "released" means -- a partial release is worse than none, because an entity that keeps any
// dungeon* marker without a resolvable instance is hidden from everyone by
// canSessionSeeDungeonScopedEntity and rejected by nativeNpcStore as NPC_PRIVATE_SCOPE_INVALID.
function releaseEntityFromSitePocket(entity, nativeNpcStore) {
  clearEntityDungeonScopeFields(entity);
  const entityID = Math.max(0, toInt(entity && entity.itemID, 0));
  if (entityID <= 0) {
    return;
  }
  if (entity.nativeNpcWreck === true) {
    const wreckRecord = nativeNpcStore.getNativeWreck(entityID);
    if (wreckRecord) {
      nativeNpcStore.upsertNativeWreck(
        clearDungeonScopeFields(wreckRecord),
        { transient: wreckRecord.transient === true },
      );
    }
  } else if (findItemById(entityID)) {
    updateInventoryItem(entityID, (currentItem) => ({
      ...currentItem,
      spaceState: clearDungeonScopeFields(currentItem.spaceState),
    }));
  }
}

// releaseSurvivorsFromSitePocket runs exactly once, at teardown, and matches one instance identity.
// Anything that acquires a pocket's scope AFTER that teardown has already run is therefore never
// released by anyone -- and a tag whose instance no longer exists is not merely cosmetic:
// canSessionSeeDungeonScopedEntity asks resolveDungeonInstanceVisibilityForSession to resolve the
// instance, gets nothing back, and hides the entity from every session on the grid. A player's own
// jetcans and deployables become invisible and unreachable until they expire on their own.
//
// A purged instance cannot be a live pocket, so releasing its stragglers can never hand away
// somebody else's content -- which is the danger the instance-scoped sweep above guards against.
// Deliberately keyed on *purged*, not merely terminal: a terminal instance inside its occupancy
// grace still resolves for the pilot standing in it, and its survivors must keep the tag until the
// grace ends. Site content (owner SITE_CONTENT_OWNER_ID) is likewise left alone -- stale content
// wants removing by sweepStoredTerminalDungeonSiteContent, not revealing.
function releaseSurvivorsStrandedByPurgedInstances(scene) {
  if (!scene || !(scene.dynamicEntities instanceof Map)) {
    return 0;
  }
  const nativeNpcStore = getNativeNpcStore();
  const strandedByInstanceID = new Map();
  // Stranded means purged, with no teardown still parked for it on this grid. A parked teardown already
  // owns its pocket: it releases the survivors and the pilots together once the grid empties, so the
  // sweep must not reach in first and split a pilot from its drones.
  const isStrandedInstance = (identity) => {
    const instanceKey = String(identity);
    if (!strandedByInstanceID.has(instanceKey)) {
      const numericInstanceID = Math.max(0, toInt(identity, 0));
      // Existence only, so the live cache entry: getInstance deep-clones the whole record.
      strandedByInstanceID.set(
        instanceKey,
        numericInstanceID > 0 &&
          !dungeonRuntime.getInstanceRef(numericInstanceID) &&
          !hasPendingSiteTeardownForInstance(scene, identity),
      );
    }
    return strandedByInstanceID.get(instanceKey) === true;
  };
  const strandedPilotInstances = new Map();
  let releasedCount = 0;
  for (const entity of scene.dynamicEntities.values()) {
    if (entity && entity.kind === "ship") {
      const trackedInstanceID = normalizeCleanupIdentity(entity.dungeonCurrentInstanceID);
      if (trackedInstanceID !== null && isStrandedInstance(trackedInstanceID)) {
        strandedPilotInstances.set(String(trackedInstanceID), trackedInstanceID);
      }
    }
    const liveInstanceID = normalizeCleanupIdentity(
      entity && entity.dungeonSiteInstanceID,
    );
    if (liveInstanceID === null || !isSurvivingSitePocketEntity(entity)) {
      continue;
    }
    if (!isStrandedInstance(liveInstanceID)) {
      continue;
    }
    releaseEntityFromSitePocket(entity, nativeNpcStore);
    releasedCount += 1;
  }
  // Same contract as releaseSurvivorsFromSitePocket: a pilot still tracked into the stranded pocket
  // leaves it in this same synchronous pass. Its drones and fighters take their scope from that tracker,
  // so releasing them alone makes droneRuntime.tickScene and fighterRuntime.tickScene abandon them.
  let releasedPilotCount = 0;
  for (const instanceIdentity of strandedPilotInstances.values()) {
    releasedPilotCount += releasePlayerShipsFromSitePocket(scene, {
      instanceIdentity,
      siteIdentity: null,
    });
  }
  if (releasedCount > 0 || releasedPilotCount > 0) {
    // Worth a line: these were invisible to everyone, so the only other evidence a player had was
    // their own cargo going missing.
    log.info(
      "[DungeonUniverse] released survivors stranded by purged site instances " +
        `systemID=${Math.max(0, toInt(scene.systemID, 0))} count=${releasedCount} ` +
        `pilots=${releasedPilotCount}`,
    );
  }
  return releasedCount;
}

function releaseSurvivorsFromSitePocket(scene, entry) {
  if (!scene || !entry || !(scene.dynamicEntities instanceof Map)) {
    return 0;
  }
  const instanceIdentity = entry.instanceIdentity;
  const siteIdentity = entry.siteIdentity;
  if (instanceIdentity === null && siteIdentity === null) {
    return 0;
  }
  const nativeNpcStore = getNativeNpcStore();
  let releasedCount = 0;
  for (const entity of scene.dynamicEntities.values()) {
    const liveInstanceID = normalizeCleanupIdentity(
      entity && entity.dungeonSiteInstanceID,
    );
    if (liveInstanceID === null) {
      continue;
    }
    // Instance identity is the precise key; the site ID is only the fallback for a site that never
    // carried one. Never release on "it is scoped to something" alone - that would hand another live
    // pocket's survivors back to open space.
    const belongsToThisPocket = instanceIdentity !== null
      ? entityIDsEqual(liveInstanceID, instanceIdentity)
      : entityIDsEqual(
          normalizeCleanupIdentity(entity && entity.dungeonSiteID),
          siteIdentity,
        );
    if (!belongsToThisPocket || !isSurvivingSitePocketEntity(entity)) {
      continue;
    }
    releaseEntityFromSitePocket(entity, nativeNpcStore);
    releasedCount += 1;
  }
  releasePlayerShipsFromSitePocket(scene, entry);
  return releasedCount;
}

// A player ship never wears dungeonSiteInstanceID - its accepted site truth is the dungeonCurrent*
// tracker written by dungeonTrackingRuntime - so the survivor sweep above walks straight past it and
// the ship keeps naming a pocket that no longer exists. That asymmetry strands drones and fighters:
// their scope is derived from dungeonSiteInstanceID, which the sweep just deleted, while the ship's
// is derived from dungeonCurrentInstanceID, which it did not. droneRuntime.tickScene and
// fighterRuntime.tickScene abandon any companion whose scope stops matching its controller, and
// scoopDrone then refuses the abandoned drone with "That drone is not in this private-site room" -
// permanent loss of every drone left in space when an anomaly completes. The ship leaves the pocket
// in the same synchronous pass as its companions, so no tick ever observes the two disagreeing.
function releasePlayerShipsFromSitePocket(scene, entry) {
  if (!scene || !entry || !(scene.dynamicEntities instanceof Map)) {
    return 0;
  }
  const instanceIdentity = entry.instanceIdentity ?? null;
  const siteIdentity = entry.siteIdentity ?? null;
  if (instanceIdentity === null && siteIdentity === null) {
    return 0;
  }
  let releasedCount = 0;
  for (const entity of scene.dynamicEntities.values()) {
    if (!entity || entity.kind !== "ship") {
      continue;
    }
    // Instance identity is the precise key; the site ID is only the fallback for a pocket that never
    // carried one. Never release on "it is tracked into something" alone.
    const trackedInstanceID = normalizeCleanupIdentity(
      entity.dungeonCurrentInstanceID,
    );
    const belongsToThisPocket = instanceIdentity !== null
      ? (
          trackedInstanceID !== null &&
          entityIDsEqual(trackedInstanceID, instanceIdentity)
        )
      : (() => {
          const trackedSiteID = normalizeCleanupIdentity(
            entity.dungeonCurrentSiteID,
          );
          return (
            trackedSiteID !== null &&
            entityIDsEqual(trackedSiteID, siteIdentity)
          );
        })();
    if (!belongsToThisPocket) {
      continue;
    }
    const exitingDungeonID = Math.max(
      0,
      toInt(entity.dungeonCurrentDungeonID, 0),
    );
    dungeonTrackingRuntime.clearShipCurrentDungeonRoom(entity);
    if (entity.session) {
      // Same notification the pilot would get flying out under their own power - the client's dungeon
      // context has to close with the pocket, not linger until the next warp.
      dungeonTrackingRuntime.sendExitingDungeonNotification(
        entity.session,
        exitingDungeonID,
      );
    }
    if (typeof scene.persistAcceptedDungeonTrackingContext === "function") {
      try {
        scene.persistAcceptedDungeonTrackingContext(entity);
      } catch (error) {
        log.warn(
          `[DungeonUniverse] Released ship dungeon context failed to persist ship=${toInt(entity.itemID, 0)}: ${error.message}`,
        );
      }
    }
    releasedCount += 1;
  }
  return releasedCount;
}

// The teardown that used to run inline on the active -> terminal transition. Removes the site's
// materialized content, then its root beacon, hands whatever survived back to normal space, then pushes
// the scanner delta.
function runSiteTeardown(scene, entry, options = {}) {
  if (!scene || !entry) {
    return 0;
  }
  const removedCount = removeSceneSiteContent(scene, entry.siteIdentity, {
    broadcast: options.broadcast !== false,
    instanceID: entry.instanceIdentity,
    instance: entry.instance,
    nowMs: options.nowMs,
  });
  const removed = removeSceneEntity(scene, entry.siteID, {
    broadcast: options.broadcast !== false,
    instanceID: entry.instanceIdentity,
    nowMs: options.nowMs,
  });
  // A teardown parked behind the occupancy grace keeps checking presence after its instance's purge,
  // which caches the rooms again; the teardown is that check's last use, so the entry goes with it.
  dropSiteRoomWorldPositions(entry.instanceIdentity);
  // After the removals, so anything still wearing this site's scope is by definition a survivor.
  releaseSurvivorsFromSitePocket(scene, entry);
  // Closing any site on this grid is also the cheapest moment to notice stragglers left behind by a
  // pocket that is already gone: we have just walked these entities, and nothing else ever will.
  releaseSurvivorsStrandedByPurgedInstances(scene);
  if ((removed || entry.siteID > 0) && entry.notifyTracker === true) {
    notifyTrackerDelta(entry.systemID, entry.siteKind, {
      scene,
      refresh: false,
    });
  }
  return removedCount;
}

function schedulePendingSiteTeardown(scene, entry) {
  if (!scene || !entry) {
    return false;
  }
  ensureScenePendingSiteTeardownMap(scene).set(
    buildPendingSiteTeardownKey(entry.siteIdentity, entry.instanceIdentity),
    entry,
  );
  return true;
}

// A parked entry whose own instance came back to life (paused -> active, or a reseed in place) is
// obsolete: the site it was going to close is the site that is now running. Drop it rather than run it.
function pendingSiteTeardownIsObsolete(entry) {
  const latestInstance = entry && entry.instanceID > 0
    ? dungeonRuntime.getInstance(entry.instanceID)
    : null;
  return isActiveManagedMaterializedSiteInstance(latestInstance);
}

// The grace period ends the moment the site ID is handed to a new instance: flush the old instance's
// teardown now so its content cannot outlive it. Both removeSceneSiteContent and removeSceneEntity are
// instance-scoped, so this cannot touch the incoming instance's root or content.
function flushPendingSiteTeardownsForSite(scene, siteID, options = {}) {
  const pending = ensureScenePendingSiteTeardownMap(scene);
  if (pending.size <= 0) {
    return 0;
  }
  const numericSiteID = toSafeCleanupNumber(siteID);
  let flushedCount = 0;
  for (const [key, entry] of [...pending]) {
    if (!entry || (numericSiteID > 0 && entry.siteID !== numericSiteID)) {
      continue;
    }
    pending.delete(key);
    if (pendingSiteTeardownIsObsolete(entry)) {
      continue;
    }
    runSiteTeardown(scene, entry, {
      broadcast: options.broadcast !== false,
      nowMs: options.nowMs,
    });
    flushedCount += 1;
  }
  return flushedCount;
}

function drainPendingSiteTeardowns(scene, options = {}) {
  const pending = ensureScenePendingSiteTeardownMap(scene);
  if (pending.size <= 0) {
    return 0;
  }
  let drainedCount = 0;
  for (const [key, entry] of [...pending]) {
    if (!entry || pendingSiteTeardownIsObsolete(entry)) {
      pending.delete(key);
      continue;
    }
    if (anyPlayerShipPresentAtSite(scene, entry.instance, entry.siteID)) {
      continue;
    }
    pending.delete(key);
    runSiteTeardown(scene, entry, { nowMs: options.nowMs });
    drainedCount += 1;
  }
  if (drainedCount > 0) {
    // The slot this site was holding is free again. Rotation deliberately skips a terminal site
    // whose grid is still occupied, and a drain changes no instance, so it emits no instance-change
    // event -- without this poke the freed slot would wait for an unrelated boundary to come due.
    requestGlobalSiteLifecycleReconcile();
  }
  return drainedCount;
}

// True while a cleared site's teardown is parked behind the occupancy grace, i.e. a player is still
// standing on its grid. The rotation pass reads this: site IDs are slot-derived, so rotating hands
// the *same* ID to the successor, and handleRuntimeChange flushes the parked teardown the moment
// that happens -- which would delete the pocket out from under the pilot who just cleared it.
function isUniverseSiteTeardownParked(systemID, instanceID) {
  const numericSystemID = Math.max(0, toInt(systemID, 0));
  const normalizedInstanceID = normalizeCleanupIdentity(instanceID);
  if (numericSystemID <= 0 || normalizedInstanceID === null) {
    return false;
  }
  let scene = null;
  try {
    const runtime = getSpaceRuntime();
    scene =
      runtime && runtime.scenes && typeof runtime.scenes.get === "function"
        ? runtime.scenes.get(numericSystemID) || null
        : null;
  } catch (_error) {
    // ignored: no space runtime here; the system has no scene (false)
    return false;
  }
  // No scene means nobody is on that grid: an unloaded system holds nothing open.
  if (!scene) {
    return false;
  }
  return hasPendingSiteTeardownForInstance(scene, normalizedInstanceID);
}

// Lazy, best-effort: the scheduler owns this module's rotation cadence but must not be a load-time
// dependency of it, and a reconcile failure must never break a teardown that already succeeded.
function requestGlobalSiteLifecycleReconcile() {
  try {
    const globalSiteScheduler = require(path.join(
      __dirname,
      "./globalSiteSchedulerRuntime",
    ));
    if (
      globalSiteScheduler &&
      typeof globalSiteScheduler.queueDurableGlobalSiteReconciliation === "function"
    ) {
      Promise.resolve(
        globalSiteScheduler.queueDurableGlobalSiteReconciliation({ scanExisting: false }),
      ).catch(() => null);
    }
  } catch (_error) {
    // ignored: no scheduler bound (tests, or a boot that has not wired it yet)
  }
}

function pruneOrphanedSiteBlueprintLootReceipts() {
  try {
    const database = require("../../gameStore");
    // A cached deletion alone is insufficient: a restart could restore that
    // instance and replay its loot. Flush the owning table before trusting
    // absence from its authoritative runtime cache. Existing instances retain
    // their receipts even in terminal states, since they can be reactivated.
    if (database.flushTableSync("dungeonRuntimeState").success !== true) return false;
    const ledger = database.read("items", "/__evejsInventoryGrantReceipts");
    if (!ledger.success) return ledger.errorMsg === "ENTRY_NOT_FOUND";
    const orphanedReceipts = Object.values(normalizeObject(ledger.data)).filter((receipt) => {
      if (!receipt || typeof receipt !== "object") return false;
      const match = /^site-blueprint-loot:([1-9]\d*):/.exec(String(receipt.receiptKey || ""));
      if (!match || !Number.isSafeInteger(Number(match[1]))) return false;
      return !dungeonRuntime.getInstanceRef(Number(match[1]));
    });
    if (orphanedReceipts.length === 0) return true;

    // Inventory deletion must be durable before discarding a copy's industry
    // state. The source receipts retain the exact IDs across a failed cleanup;
    // copies looted to any other owner/location still exist and are preserved.
    if (database.flushTableSync("items").success !== true) return false;
    const industry = require("../industry/industryRuntimeState");
    for (const receipt of orphanedReceipts) {
      const itemIDs = normalizeArray(receipt.resultData && receipt.resultData.itemIDs);
      const typeIDs = new Set(normalizeArray(receipt.manifest)
        .map((entry) => Number(entry && entry.typeID))
        .filter((typeID) => Number.isSafeInteger(typeID) && typeID > 0));
      for (const rawItemID of itemIDs) {
        const itemID = Number(rawItemID);
        if (!Number.isSafeInteger(itemID) || itemID <= 0 || findItemById(itemID)) continue;
        const state = industry.getBlueprintState(itemID);
        if (!state || Number(state.itemID) !== itemID || state.original !== false ||
            state.jobID || !typeIDs.has(Number(state.typeID))) continue;
        if (!industry.removeBlueprintState(itemID)) return false;
      }
    }
    // Flush even when the rows were already absent from cache: an earlier
    // cleanup may have removed them before its durable write was refused.
    if (database.flushTableSync("industryBlueprintState").success !== true) return false;
    const retiredKeys = new Set(orphanedReceipts.map((receipt) => receipt.receiptKey));
    const result = pruneIdempotentGrantReceipts((receipt) => retiredKeys.has(receipt.receiptKey));
    return result.success === true;
  } catch (error) {
    // Failed housekeeping retains the receipts for a later removal/startup.
    log.debug(`[DungeonSites] Blueprint loot receipt cleanup deferred: ${error.message}`);
    return false;
  }
}

function handleRuntimeChange(change) {
  const previous = change && change.before ? change.before : null;
  const next = change && change.after ? change.after : null;
  const runtime = getSpaceRuntime();
  const previousSystemID = Math.max(
    0,
    toInt(
      change && change.previousSolarSystemID,
      toInt(previous && previous.solarSystemID, 0),
    ),
  );
  const nextSystemID = Math.max(
    0,
    toInt(
      change && change.solarSystemID,
      toInt(next && next.solarSystemID, 0),
    ),
  );

  const previousWasVisible = isActiveManagedMaterializedSiteInstance(previous);
  const nextIsVisible = isActiveManagedMaterializedSiteInstance(next);
  const previousSiteIdentity = normalizeCleanupIdentity(
    previous && previous.metadata && previous.metadata.siteID,
  );
  const nextSiteIdentity = normalizeCleanupIdentity(
    next && next.metadata && next.metadata.siteID,
  );
  const previousSiteID = toSafeCleanupNumber(previousSiteIdentity);
  const nextSiteID = toSafeCleanupNumber(nextSiteIdentity);
  const previousInstanceIdentity = normalizeCleanupIdentity(
    previous && previous.instanceID,
  );
  const nextInstanceIdentity = normalizeCleanupIdentity(next && next.instanceID);
  const previousIdentityChangedInSystem = Boolean(
    previousWasVisible &&
    nextIsVisible &&
    previousSystemID > 0 &&
    previousSystemID === nextSystemID &&
    (
      !entityIDsEqual(previousInstanceIdentity, nextInstanceIdentity) ||
      !entityIDsEqual(previousSiteIdentity, nextSiteIdentity)
    )
  );

  if (
    previousSystemID > 0 &&
    previousWasVisible &&
    (
      !nextIsVisible ||
      nextSystemID !== previousSystemID ||
      previousIdentityChangedInSystem
    )
  ) {
    const previousScene = runtime.scenes.get(previousSystemID) || null;
    if (previousScene) {
      const teardownEntry = {
        systemID: previousSystemID,
        siteID: previousSiteID,
        siteIdentity: previousSiteIdentity,
        instanceID: Math.max(0, toInt(previous && previous.instanceID, 0)),
        instanceIdentity: previousInstanceIdentity,
        instance: previous,
        siteKind: normalizeLowerText(previous && previous.siteKind, "signature"),
        notifyTracker: isManagedUniverseSiteInstance(previous),
      };
      // Only an in-place terminal transition earns the occupancy grace. A site that moved system or
      // swapped identity has to hand its old grid back right away, or the stale content outlives it.
      const wentTerminalInPlace = Boolean(
        !nextIsVisible &&
        !previousIdentityChangedInSystem &&
        (nextSystemID <= 0 || nextSystemID === previousSystemID)
      );
      if (
        wentTerminalInPlace &&
        anyPlayerShipPresentAtSite(previousScene, previous, previousSiteID)
      ) {
        schedulePendingSiteTeardown(previousScene, teardownEntry);
      } else {
        flushPendingSiteTeardownsForSite(previousScene, previousSiteID);
        runSiteTeardown(previousScene, teardownEntry, { broadcast: true });
      }
    } else {
      removeStoredDungeonSiteContent(previousSystemID, {
        siteID: previousSiteIdentity,
        instanceID: previousInstanceIdentity,
        instance: previous,
      });
    }
  }

  // A purge (no instance after the change) drops the instance's cached room positions, after the
  // teardown above has had its last presence check.
  if (!next && previous) {
    dropSiteRoomWorldPositions(previousInstanceIdentity);
  }

  if (nextSystemID > 0 && nextIsVisible) {
    const nextScene = runtime.scenes.get(nextSystemID) || null;
    if (nextScene) {
      const isInPlaceGeneratedMiningStateUpdate = Boolean(
        previousWasVisible &&
        previousSystemID === nextSystemID &&
        entityIDsEqual(previousInstanceIdentity, nextInstanceIdentity) &&
        entityIDsEqual(previousSiteIdentity, nextSiteIdentity) &&
        isExactClientGeneratedMiningInstance(next) &&
        buildStableUniverseSiteEntitySignature(buildSiteEntity(previous)) ===
          buildStableUniverseSiteEntitySignature(buildSiteEntity(next))
      );
      // Mining quantity changes are persisted through spawnState. They do not
      // change the anomaly root, and must not replace the specialized ice
      // anchor with a generic dungeon root on every mining cycle.
      if (isInPlaceGeneratedMiningStateUpdate) {
        return;
      }
      flushPendingSiteTeardownsForSite(nextScene, nextSiteID);
      const changed = upsertSceneEntity(nextScene, next, {
        broadcast: true,
      });
      if (changed && isSceneSiteMaterialized(nextScene, nextSiteID)) {
        removeSceneSiteContent(nextScene, nextSiteID, {
          broadcast: true,
          instanceID: previousInstanceIdentity,
          instance: previous,
        });
      }
      if (changed && isManagedUniverseSiteInstance(next)) {
        notifyTrackerDelta(nextSystemID, normalizeLowerText(next && next.siteKind, "signature"), {
          scene: nextScene,
          refresh: false,
        });
      }
    }
  }
  if (previous && !next && Object.values(getContentEntityRefsByKey(previous))
    .some((reference) => Array.isArray(reference && reference.blueprintLootPlan))) {
    pruneOrphanedSiteBlueprintLootReceipts();
  }
}

function sweepStoredTerminalDungeonSiteContent() {
  const runtime = getSpaceRuntime();
  const terminalInstances = ["completed", "failed", "despawned"]
    .flatMap((lifecycleState) => (
      dungeonRuntime.listInstancesByLifecycle(lifecycleState, { full: true })
    ))
    .filter((instance) => isManagedMaterializedSiteInstance(instance));
  let cleanedInstanceCount = 0;
  let removedCount = 0;
  for (const instance of terminalInstances) {
    const systemID = toSafeCleanupNumber(instance && instance.solarSystemID);
    const siteID = normalizeCleanupIdentity(
      instance && instance.metadata && instance.metadata.siteID,
    );
    const instanceID = normalizeCleanupIdentity(instance && instance.instanceID);
    if (systemID <= 0 || siteID === null || instanceID === null) {
      continue;
    }
    const scene = runtime.scenes.get(systemID) || null;
    if (scene) {
      ensureScenePendingSiteTeardownMap(scene).delete(
        buildPendingSiteTeardownKey(siteID, instanceID),
      );
      removedCount += removeSceneSiteContent(scene, siteID, {
        broadcast: false,
        instanceID,
        instance,
      });
      removeSceneEntity(scene, siteID, { instanceID, broadcast: false });
      // Same contract as runSiteTeardown: a site closed by the startup sweep still has to hand its
      // survivors back to normal space rather than leave them tagged to an instance nobody can enter.
      releaseSurvivorsFromSitePocket(scene, {
        siteIdentity: siteID,
        instanceIdentity: instanceID,
      });
    } else {
      removedCount += removeStoredDungeonSiteContent(systemID, {
        siteID,
        instanceID,
        instance,
      });
    }
    cleanedInstanceCount += 1;
  }
  return {
    cleanedInstanceCount,
    removedCount,
  };
}

function startRuntimeSync() {
  if (runtimeSyncStarted) {
    return true;
  }
  // Network startup calls this before admitting pilots. Pay prepared damage
  // even when the original can, cloud, scene or site lifetime has ended.
  require("./siteHazardOutcomes").recoverAll();
  registeredListener = handleRuntimeChange;
  dungeonRuntime.registerInstanceChangeListener(registeredListener);
  sweepStoredTerminalDungeonSiteContent();
  pruneOrphanedSiteBlueprintLootReceipts();
  if (!siteBehaviorTicker) {
    siteBehaviorTicker = setInterval(() => {
      try { require("./siteHazardOutcomes").recoverAll(); }
      catch (error) { log.warn(`[universe-sites] hazard health recovery deferred: ${error.message}`); }
      const runtime = getSpaceRuntime();
      for (const scene of runtime && runtime.scenes instanceof Map ? runtime.scenes.values() : []) {
        if (
          ensureSceneMaterializedSiteSet(scene).size <= 0 &&
          ensureScenePendingSiteTeardownMap(scene).size <= 0
        ) {
          continue;
        }
        try { tickSceneSiteBehaviors(scene, { nowMs: Date.now() }); }
        catch (error) { log.warn(`[universe-sites] site settlement deferred: ${error.message}`); }
      }
    }, SITE_CONTENT_BEHAVIOR_TICK_INTERVAL_MS);
    if (typeof siteBehaviorTicker.unref === "function") {
      siteBehaviorTicker.unref();
    }
  }
  runtimeSyncStarted = true;
  // Retry durable Homefront wallet receipts even when their scene is unloaded.
  require("../homefront/homefrontHooks")
    .rewards.recoverPending()
    .catch((error) => {
      log.error(
        `[Homefront] Reward recovery failed: ${error.stack || error.message}`,
      );
    });
  return true;
}

function stopRuntimeSync() {
  if (!runtimeSyncStarted || !registeredListener) {
    return false;
  }
  dungeonRuntime.unregisterInstanceChangeListener(registeredListener);
  if (siteBehaviorTicker) {
    clearInterval(siteBehaviorTicker);
    siteBehaviorTicker = null;
  }
  runtimeSyncStarted = false;
  registeredListener = null;
  return true;
}

function handleSceneCreated(scene, options = {}) {
  if (!scene || (scene._universeDungeonSitesInitialized === true && options.force !== true)) {
    return {
      success: true,
      data: {
        spawned: [],
      },
    };
  }
  require("./siteHazardOutcomes").recoverAll({ scene, nowMs: options.nowMs });

  const initialLoad = scene._universeDungeonSitesInitialized !== true;
  scene._universeDungeonSitesInitialized = true;
  // Inventory hydrates before the dungeon source. Restore already stored cans
  // before a reconnect can acquire them; a forced refresh must leave active
  // transient attempts alone.
  if (initialLoad && scene.dynamicEntities instanceof Map) {
    const hackingState = require("../exploration/hackingContainerState");
    for (const entity of [...scene.dynamicEntities.values()]) {
      if (!hackingState.isHackable(entity)) continue;
      const instance = dungeonRuntime.getInstance(toInt(entity.dungeonSiteInstanceID, 0));
      if (!instance) continue;
      restoreMaterializedContainerHackingState(scene, entity, instance, options.nowMs);
      const ref = getContentEntityRefsByKey(instance)[entity.dungeonSiteContentKey];
      if (hackingState.isDestroyed(entity) || toInt(ref?.resolvedAtMs, 0) > 0) {
        if (!retryContainerHackingOutcomes(scene, entity, instance)) continue;
        destroyMaterializedContentEntity(scene, entity, { broadcast: false, nowMs: options.nowMs });
      }
    }
  }
  // A scene rebuilt from the store can carry survivors whose pocket was purged while the system was
  // asleep, and nothing else revisits them: the teardown that would have released them already ran.
  releaseSurvivorsStrandedByPurgedInstances(scene);
  const spawned = [];
  const contentSummary = {
    containersSpawned: 0,
    hazardsSpawned: 0,
    environmentPropsSpawned: 0,
    miningRocksSpawned: 0,
    gatesSpawned: 0,
    objectivesSpawned: 0,
    encountersSpawned: 0,
  };
  const instances = dungeonRuntime.listActiveInstancesBySystem(toInt(scene && scene.systemID, 0), {
    full: true,
  })
    .filter((instance) => isManagedMaterializedSiteInstance(instance));
  for (const instance of instances) {
    const entity = buildSiteEntity(instance);
    if (!entity) {
      continue;
    }
    if (scene.addStaticEntity(entity)) {
      spawned.push(entity);
    }
    if (initialLoad) {
      const template = dungeonAuthority.getTemplateByID(instance.templateID);
      retryInstanceHackingOutcomes(scene, instance, resolvePopulationHints(instance, template), { nowMs: options.nowMs });
    }
    if (isExactClientGeneratedMiningInstance(instance)) {
      const materializeResult = ensureSiteContentsMaterialized(scene, instance, {
        nowMs: options.nowMs,
        broadcast: options.broadcast === true,
        excludedSession: options.excludedSession || null,
        spawnEncounters: false,
      });
      const spawnedContent = materializeResult && materializeResult.success === true &&
        materializeResult.data && materializeResult.data.contentSummary
        ? materializeResult.data.contentSummary
        : {};
      for (const key of Object.keys(contentSummary)) {
        contentSummary[key] += Math.max(0, toInt(spawnedContent[key], 0));
      }
    }
  }
  if (contentSummary.miningRocksSpawned > 0) {
    // Mining may have memoized its scene cache before exact client dungeon
    // rocks were materialized. Force the next mining read to include them and
    // any persisted per-rock quantities.
    scene._miningRuntimeState = null;
  }

  return {
    success: true,
    data: {
      spawned,
      contentSummary,
    },
  };
}

class DungeonUniverseSiteService extends BaseService {
  constructor() {
    super("dungeonUniverseSite");
  }
}

DungeonUniverseSiteService.buildSiteEntity = buildSiteEntity;
// Narrow world-construction ports; Homefront owns encounter decisions and state.
DungeonUniverseSiteService.homefrontPorts = {
  structure: spawnEncounterKillableStructures,
  rocks: buildMiningRockEntities,
  containers: buildContainerEntities,
  materializeContainer: materializeContainerEntity,
  occupied: anyPlayerShipPresentAtSite,
};
DungeonUniverseSiteService.ensureSiteContentsMaterialized = ensureSiteContentsMaterialized;
DungeonUniverseSiteService.spawnTemplateForSession = spawnTemplateForSession;
DungeonUniverseSiteService.purgePrivateOperationForCharacter = purgePrivateOperationForCharacter;
DungeonUniverseSiteService.handleSceneCreated = handleSceneCreated;
DungeonUniverseSiteService.hasPendingSiteTeardownForInstance =
  hasPendingSiteTeardownForInstance;
DungeonUniverseSiteService.isUniverseSiteTeardownParked =
  isUniverseSiteTeardownParked;
DungeonUniverseSiteService.listMaterializedUniverseSiteContentEntities =
  listMaterializedUniverseSiteContentEntities;
DungeonUniverseSiteService.listMaterializedUniverseSiteEntities = listMaterializedUniverseSiteEntities;
DungeonUniverseSiteService.destroyMaterializedContentEntity =
  destroyMaterializedContentEntity;
DungeonUniverseSiteService.maybeCompleteMaterializedDataRelicSite =
  maybeCompleteMaterializedDataRelicSite;
DungeonUniverseSiteService.maybeCompleteMaterializedDataRelicSiteForContainerID =
  maybeCompleteMaterializedDataRelicSiteForContainerID;
DungeonUniverseSiteService.notifyMaterializedContainerHacked = notifyMaterializedContainerHacked;
DungeonUniverseSiteService.maybeSatisfyMissionHackObjective = maybeSatisfyMissionHackObjective;
DungeonUniverseSiteService.startRuntimeSync = startRuntimeSync;
DungeonUniverseSiteService.stopRuntimeSync = stopRuntimeSync;
DungeonUniverseSiteService.tickSceneSiteBehaviors = tickSceneSiteBehaviors;
DungeonUniverseSiteService.buildClientWaveValues = buildClientWaveValues;
DungeonUniverseSiteService.triggerSiteEncounter = triggerSiteEncounter;
DungeonUniverseSiteService.handleEncounterEntityDestroyed = handleEncounterEntityDestroyed;
DungeonUniverseSiteService.maybeGrantFetchObjectiveItems = maybeGrantFetchObjectiveItems;
DungeonUniverseSiteService.processFetchObjectiveProximity = processFetchObjectiveProximity;
DungeonUniverseSiteService.resolveRoomWorldPositionForTemplate = resolveRoomWorldPositionForTemplate;
// Narrow adapter: seasonal policy owns state; the dungeon service owns world entities.
// Trusted AIR adapter. Entity creation, visibility and removal remain owned by
// the dungeon/NPC/scene domains; graph actions cannot select public entities.
DungeonUniverseSiteService.airEncounterPorts = {
  hostiles(scene, instance, specs) {
    for (const spec of specs) {
      if (scene.getDynamicEntities().some(entity => entity.airNpeOwnerCharacterID === instance.ownership.characterID && entity.airEncounterSlot === spec.key)) continue;
      const contract = dungeonAuthority.getTemplateByID(instance.templateID).airEncounter;
      const hull = contract.hostileProfiles.find(profile => profile.shipTypeID === spec.typeID);
      const resolved = hull && getNpcSpawnService().resolveProfileDefinition(hull.sourceProfileID);
      if (!resolved?.success) throw new Error("AIR_HOSTILE_PROFILE_MISSING");
      const definition = cloneValue(resolved.data);
      definition.profile = { ...definition.profile, shipTypeID: spec.typeID, presentationTypeID: spec.typeID, presentationName: "Unidentified Ship", name: "Unidentified Ship", bounty: 0 };
      definition.profile.hardwareFamily = "sdeEntityNpc";
      definition.loadout = { loadoutID: `air-hull:${spec.typeID}`, modules: [], charges: [], cargo: [] };
      definition.lootTable = null;
      definition.behaviorProfile = { ...definition.behaviorProfile, autoAggro: false, autoActivateWeapons: false, autoAggroTargetClasses: [], returnToHomeWhenIdle: false };
      const position = addVectors(instance.position, spec.positionOffset), root = scene.getEntityByID(instance.spawnState.siteID);
      const spawned = getNativeNpcService().spawnNativeNpcEntityInContext({ scene, systemID: scene.systemID, anchorEntity: root }, definition, {
        transient: true, skipInitialBehaviorTick: true, broadcast: false, position, spawnStateOverride: { position },
        entityScopeMetadata: { dungeonMaterializedSiteContent: true, dungeonSiteInstanceID: instance.instanceID, dungeonSiteID: root.itemID, airNpeOwnerCharacterID: instance.ownership.characterID, airNpeOperationID: 2433, airNpeInstanceID: instance.instanceID },
      });
      if (!spawned.success || !spawned.data?.entity) throw new Error(`AIR_HOSTILE_SPAWN_FAILED:${spawned.errorMsg}`);
      spawned.data.entity.airEncounterSlot = spec.key;
      scene.broadcastAddBalls([spawned.data.entity]);
    }
  },
  attack(scene, sources, target, fire = true) {
    for (const source of sources) {
      const result = getNpcSpawnService().issueManualOrder(source.itemID, { type: fire ? "attack" : "holdFire", targetID: target.itemID, allowWeapons: fire, movementMode: "orbit", orbitDistanceMeters: 8000, keepLock: true });
      if (!result?.success) throw new Error(`AIR_ATTACK_REFUSED:${result?.errorMsg}`);
    }
  },
  retire(scene, characterID, instanceIDs) {
    for (const entity of scene.getDynamicEntities()) {
      if (entity.ownerID !== characterID || ![entity.airNpeInstanceID, entity.dungeonCurrentInstanceID, entity.dungeonSiteInstanceID].some(id => instanceIDs.includes(id))) continue;
      for (const key of ["airNpeOwnerCharacterID", "airNpeOperationID", "airNpeInstanceID", "dungeonSiteInstanceID", "dungeonSiteID", "dungeonMaterializedSiteContent"]) delete entity[key];
      if (instanceIDs.includes(entity.dungeonCurrentInstanceID)) require("./dungeonTrackingRuntime").clearShipCurrentDungeonRoom(entity);
      const result = require("../../space/runtime/entitySpacePersistence").persistDynamicEntity(entity);
      if (!result.success) throw new Error(`AIR_SCOPE_RETIRE_FAILED:${result.errorMsg}`);
    }
  },
  scopeShip(entity, instance, operationID) {
    // A boarded hull becomes the pilot tracker, rather than site content.
    delete entity.dungeonSiteInstanceID; delete entity.dungeonSiteID;
    delete entity.dungeonMaterializedSiteContent;
    require("./dungeonTrackingRuntime").markShipCurrentDungeonRoom(entity, instance, instance.currentRoomKey || "room:entry", { siteID: instance.spawnState.siteID, roomPosition: entity.position });
    // Private AIR targets authorize the actual pilot by character ownership.
    // Do not constrain the pilot's ordinary public-space interactions.
    for (const key of ["airNpeOwnerCharacterID", "airNpeOperationID", "airNpeInstanceID"]) delete entity[key];
    const persisted = require("../../space/runtime/entitySpacePersistence").persistShipEntity(entity);
    if (!persisted?.success) throw new Error(`AIR_SHIP_SCOPE_FAILED:${persisted?.errorMsg}`);
  },
  actors(scene, instance, specs, options = {}) {
    const created = [];
    try {
      for (const spec of specs) {
        if (scene.getDynamicEntities().some(entity => entity.airNpeOwnerCharacterID === instance.ownership.characterID && entity.airEncounterSlot === spec.key)) continue;
        const root = scene.getEntityByID(instance.spawnState.siteID), position = addVectors(instance.position, spec.positionOffset);
        const origin = options.arrival ? { ...position, x: position.x - 149597870700 } : position;
        const profileID = `air-encounter:${spec.key}`;
        const result = getNativeNpcService().spawnNativeNpcEntityInContext({ scene, systemID: scene.systemID, anchorEntity: root }, {
          profile: { profileID, name: spec.label || spec.key, shipTypeID: spec.typeID, presentationTypeID: spec.typeID, presentationName: spec.label || spec.key, corporationID: 1000125, factionID: 500021, entityType: "npc", hardwareFamily: "miningops", bounty: 0, hostileResponseThreshold: -11, friendlyResponseThreshold: -11 },
          loadout: { loadoutID: profileID, modules: [], charges: [], cargo: [] },
          behaviorProfile: { behaviorProfileID: profileID, autoAggro: false, autoAggroTargetClasses: [], autoActivateWeapons: false, returnToHomeWhenIdle: false }, lootTable: null,
        }, { transient: true, skipInitialBehaviorTick: true, broadcast: false, position: origin, spawnStateOverride: { position: origin },
          entityScopeMetadata: { dungeonMaterializedSiteContent: true, dungeonSiteInstanceID: instance.instanceID, dungeonSiteID: root.itemID,
            airNpeOwnerCharacterID: instance.ownership.characterID, airNpeOperationID: Number(instance.templateID.endsWith("9103") ? 2423 : 2433), airNpeInstanceID: instance.instanceID },
        });
        if (!result.success || !result.data?.entity) throw new Error(`AIR_ACTOR_SPAWN_FAILED:${result.errorMsg}`);
        const entity = result.data.entity; entity.airEncounterSlot = spec.key; created.push(entity);
        if (options.arrival) {
          const warp = require("../../space/npc/npcRuntime").warpBatchToPoints([{ entityID: entity.itemID, point: position }], { ingressDurationMs: 2000, acquireForRelevantSessions: true, useNativeWarpProfile: true });
          if (!warp.success) throw new Error(`AIR_ACTOR_ARRIVAL_FAILED:${warp.errorMsg}`);
        } else scene.broadcastAddBalls([entity]);
      }
      return created;
    } catch (error) {
      for (const entity of created) destroyMaterializedContentEntity(scene, entity, { broadcast: true });
      throw error;
    }
  },
  arrive(scene, instance, specs) { return this.actors(scene, instance, specs, { arrival: true }); },
  repair(scene, source, target) {
    const pseudoSession = { characterID: 0, _space: { systemID: scene.systemID, shipID: source.itemID }, sendNotification() {} };
    const modules = require("../../space/npc/npcEquipment").getNpcAssistanceModules(source).filter(entry => ["remoteArmor", "remoteShield"].includes(entry.definition?.family));
    if (!modules.length) return { success: false, errorMsg: "AIR_REPAIR_MODULES_MISSING" };
    scene.finalizeTargetLock(source, target, { nowMs: scene.getCurrentSimTimeMs() });
    for (const entry of modules) {
      if (source.activeModuleEffects?.has(entry.moduleItem.itemID)) continue;
      const result = scene.activateGenericModule(pseudoSession, entry.moduleItem, entry.effectName, { targetID: target.itemID, activationHint: "assistance", assistanceDurationMs: 8000, assistanceRepeatOverride: 1, deferInitialCycleMs: 8000 });
      if (!result.success) return result;
    }
    return { success: true };
  },
  fleetWarp(scene, session, companions, point, destination) {
    const options = { destinationStaticInstanceID: destination.instanceID, destinationDungeonSiteID: destination.spawnState.siteID, stopDistance: 0 };
    const ship = scene.getShipEntityForSession(session);
    const distance = entity => Math.hypot(entity.position.x - point.x, entity.position.y - point.y, entity.position.z - point.z);
    if (ship.mode !== "WARP" && !scene.hasQueuedWarpOrder(ship) && distance(ship) > 100000) {
      const result = scene.warpToPoint(session, point, options);
      if (!result.success) throw new Error(`AIR_PLAYER_WARP_FAILED:${result.errorMsg}`);
    }
    for (const companion of companions) {
      if (companion.airNpeOwnerCharacterID !== destination.ownership.characterID || Number(session.characterID) !== destination.ownership.characterID) throw new Error("AIR_COMPANION_WARP_FORBIDDEN");
      if (companion.mode !== "WARP" && !scene.hasQueuedWarpOrder(companion) && distance(companion) > 100000) {
        // The NPC owner holds its behavior wake until native warp completes.
        // A raw scene warp lets an idle controller stop its alignment.
        const warp = require("../../space/npc/npcRuntime").warpToPoint(companion.itemID, point, { ...options, session, useNativeWarpProfile: true, acquireForRelevantSessions: true });
        if (!warp.success) throw new Error(`AIR_COMPANION_WARP_FAILED:${warp.errorMsg}`);
      }
      Object.assign(companion, { dungeonSiteInstanceID: destination.instanceID, dungeonSiteID: destination.spawnState.siteID, airNpeInstanceID: destination.instanceID, airNpeOperationID: 2433 });
    }
  },
};
DungeonUniverseSiteService.airMiningPorts = {
  scope(scene, instance) {
    const content = [...scene.staticEntitiesByID.values(), ...scene.getDynamicEntities()];
    for (const entity of content) {
      if (entity.dungeonSiteInstanceID !== instance.instanceID) continue;
      Object.assign(entity, { airNpeOwnerCharacterID: instance.ownership.characterID, airNpeOperationID: 2674, airNpeInstanceID: instance.instanceID });
    }
  },
  actors(scene, instance, actors) {
    const root = scene.getEntityByID(instance.spawnState.siteID);
    for (const actor of actors) {
      if (scene.getDynamicEntities().some(entity => entity.dungeonSiteInstanceID === instance.instanceID && entity.airMiningActorKey === actor.key)) continue;
      const position = addVectors(instance.position, actor.positionOffset);
      const profileID = `air-mining:${actor.key}`;
      const definition = {
        profile: { profileID, name: actor.label, shipTypeID: actor.typeID, presentationTypeID: actor.typeID, presentationName: actor.label, corporationID: 1000125, factionID: 500021, entityType: "npc", hardwareFamily: "miningops", bounty: 0, hostileResponseThreshold: -11, friendlyResponseThreshold: -11 },
        loadout: { loadoutID: profileID, modules: [], charges: [], cargo: [] },
        behaviorProfile: { behaviorProfileID: profileID, autoAggro: false, autoAggroTargetClasses: [], autoActivateWeapons: false, returnToHomeWhenIdle: false },
        lootTable: null,
      };
      const result = getNativeNpcService().spawnNativeNpcEntityInContext({ scene, systemID: scene.systemID, anchorEntity: root }, definition, {
        transient: true, skipInitialBehaviorTick: true, broadcast: false,
        position, spawnStateOverride: { position, maxVelocity: actor.maxVelocity || 420, speedFraction: 1 },
        behaviorOverrides: { autoAggro: false, autoAggroTargetClasses: [], autoActivateWeapons: false, returnToHomeWhenIdle: false },
        entityScopeMetadata: { dungeonMaterializedSiteContent: true, dungeonSiteInstanceID: instance.instanceID, dungeonSiteID: root.itemID, airNpeOwnerCharacterID: instance.ownership.characterID, airNpeOperationID: 2674, airNpeInstanceID: instance.instanceID },
      });
      if (!result.success || !result.data?.entity) throw new Error(`AIR_ACTOR_SPAWN_FAILED:${result.errorMsg}`);
      const entity = result.data.entity;
      entity.airMiningActorKey = actor.key;
      entity.airMiningGroup = actor.group;
      entity.airMiningTargetable = false;
      scene.broadcastAddBalls([entity]);
    }
  },
  targetable(scene, entity, value) {
    entity.airMiningTargetable = Boolean(value);
    if (!value) scene.clearAllTargetingForEntity(entity);
    scene.broadcastSlimItemChanges([entity]);
  },
  cloak(scene, entity, value) {
    const result = value ? scene.cloakEntity(entity, { cloakMode: 2, uncloakRange: 0 }) : scene.uncloakEntity(entity);
    if (!result.success) throw new Error(`AIR_OBJECT_CLOAK_FAILED:${result.errorMsg}`);
  },
  remove: destroyMaterializedContentEntity,
};
DungeonUniverseSiteService.fwOpenPorts = {
  remove: destroyMaterializedContentEntity,
  occupied: anyPlayerShipPresentAtSite,
  npc(scene,instance,root,slot) {
    const profile = getNpcSpawnService().listNpcProfiles().find(p=>Number(p.shipTypeID)===slot.typeID);
    if (!profile) throw new Error(`Missing FW NPC profile ${slot.typeID}`);
    const position={x:root.position.x+(slot.faction===500004?-1:1)*12000,y:root.position.y,z:root.position.z+slot.index*3000};
    const result=getNpcSpawnService().spawnNpcBatchInSystem(scene.systemID,{
      profileQuery:profile.profileID,amount:1,transient:true,runtimeKind:"nativeCombat",position,
      spawnStateOverride:{position},skipInitialBehaviorTick:true,
      behaviorOverrides:{autoAggro:true,autoAggroTargetClasses:["player","npc","drone"],allowFriendlyNpcTargets:true,aggressionRangeMeters:50000,leashRangeMeters:60000},
      entityScopeMetadata:{dungeonMaterializedSiteContent:true,dungeonSiteInstanceID:instance.instanceID,dungeonSiteID:root.itemID,dungeonEncounterKey:`fw-open:${slot.key}`},broadcast:true,
    });
    if(!result.success) throw new Error(`FW spawn failed: ${result.errorMsg}`);
    const entity=result.data?.spawned?.[0]?.entity;
    if(!entity) throw new Error("FW spawn returned no entity");
    Object.assign(entity,{fwOpenFaction:slot.faction,fwOpenSlot:slot.key});
    const controller=require("../../space/npc/npcRegistry").getControllerByEntityID(entity.itemID);
    if(controller) controller.nextThinkAtMs=0;
    return entity;
  },
};
DungeonUniverseSiteService.fabricatorPorts = {
  remove: destroyMaterializedContentEntity,
  occupied: anyPlayerShipPresentAtSite,
  structure(scene,instance,root,entry) {
    const entity = spawnEncounterKillableStructures(scene,instance,root,{key:entry.key},[entry])[0]?.entity || null;
    if (entity && entry.typeID === 91774) Object.assign(entity,{shieldCapacity:2000,armorHP:14000,structureHP:4000});
    else if (entity) Object.assign(entity,{shieldCapacity:0,armorHP:0,structureHP:1000});
    return entity;
  },
  bonusType(name) { return require("../seasons/eventHooks").fabricatorBonuses.BONUSES[name]?.typeID || 0; },
  npc(scene,instance,root,slot) {
    const profile = getNpcSpawnService().listNpcProfiles().find(p=>Number(p.shipTypeID)===slot.typeID);
    if (!profile) throw new Error(`Missing Fabricator NPC profile ${slot.typeID}`);
    const index = Number(slot.key.split(":")[1]);
    const angle = index*2.399963;
    const result = getNpcSpawnService().spawnNpcBatchInSystem(scene.systemID,{
      profileQuery:profile.profileID, amount:1, transient:true, runtimeKind:"nativeCombat",
      position:{x:root.position.x+Math.cos(angle)*22000,y:root.position.y,z:root.position.z+Math.sin(angle)*22000},
      entityScopeMetadata:{dungeonMaterializedSiteContent:true,dungeonSiteInstanceID:instance.instanceID,dungeonSiteID:root.itemID},
      broadcast:true,
    });
    if (!result.success) throw new Error(`Fabricator spawn failed: ${result.errorMsg}`);
    return result.data?.spawned?.[0]?.entity || null;
  },
  cashout(scene,instance,root,quantity,nowMs) {
    const hints = {containers:[{role:"reward",count:1,typeID:92152,label:"Rampant Fabricator Wreck",positionOffset:{x:0,y:0,z:0},
      explicitLoot:[...(quantity>0 ? [{typeID:91773,quantity}] : []), ...Object.entries(instance.spawnState.fabricator.hybrids || {}).map(([typeID,quantity])=>({typeID:Number(typeID),quantity}))]}]};
    const container = buildContainerEntities(instance,root,hints)[0];
    const ref = getContentEntityRefsByKey(instance)[container.dungeonSiteContentKey];
    if (ref?.itemID && scene.getEntityByID(ref.itemID)) return scene.getEntityByID(ref.itemID);
    materializeContainerEntity(scene,instance,root,dungeonAuthority.getTemplateByID(instance.templateID),hints,container,{nowMs});
    const latestRef = getContentEntityRefsByKey(dungeonRuntime.getInstance(instance.instanceID))[container.dungeonSiteContentKey];
    const entity = latestRef && scene.getEntityByID(latestRef.itemID);
    if (entity) { entity.shieldCapacity=0; entity.armorHP=0; entity.structureHP=20000; }
    return entity;
  },
};
DungeonUniverseSiteService._testing = {
  armDeferredEncounterPlans,
  resolveGhostTimerPhaseSpec,
  resolveGhostTimerHiddenUntilMs,
  resolveVisibleCountdownDueAtMs,
  materializeDeferredGhostTimerHazards,
  hasDueVisibleCountdownTrigger,
  materializeSleeperToxicClouds,
  processToxicCloudHazards,
  applyEnvPromotedContainerSpecs,
  resolveContainerHackingDifficultyTier,
  resolveContainerTypeRecord,
  materializeContainerEntity,
  anyPlayerShipWithinRange,
  getContentEntityRefsByKey,
  processFetchObjectiveProximity,
  resolveFetchObjectiveTriggerPositions,
  buildSpawnedIdentityMap,
  hasEncounterTriggerEntityBeenKilled,
  isEncounterEntityStillPresent,
  applyTriggeredSiteEffects,
  buildGateEntities,
  buildEnvironmentEntities,
  buildContainerEntities,
  buildMiningRockEntities,
  buildSiteContentItemID,
  destroyMaterializedContentEntity,
  buildHazardEntities,
  buildObjectiveEntities,
  ensureSiteContentsMaterialized,
  spawnTemplateForSession,
  tickSceneSiteBehaviors,
  triggerSiteEncounter,
  handleEncounterEntityDestroyed,
  maybeGrantFetchObjectiveItems,
  materializeFetchObjectiveContainer,
  buildLootGrantEntriesForContainer,
  buildBaseLootGrantEntriesForContainer,
  handleRuntimeChange,
  anyPlayerShipPresentAtSite,
  drainPendingSiteTeardowns,
  ensureScenePendingSiteTeardownMap,
  flushPendingSiteTeardownsForSite,
  releaseSurvivorsFromSitePocket,
  releaseSurvivorsStrandedByPurgedInstances,
  releasePlayerShipsFromSitePocket,
  removeSceneSiteContent,
  removeStoredDungeonSiteContent,
  sweepStoredTerminalDungeonSiteContent,
  isManagedUniverseSiteInstance,
  isSceneSiteMaterialized,
  materializeSiteContents,
  resolveManagedUniverseSiteInstance,
  resolveEncounterPlans,
  resolveSpawnIdentityProfileQuery,
  normalizeMissionSpawnQuery,
  resolveLocalizedTemplateName,
  resolveFallbackStrengthAttribute,
  resolvePopulationHints,
  resolveRoomWorldPositionForTemplate,
  buildStableUniverseSiteEntitySignature,
  maybeCompleteMaterializedDataRelicSite,
  notifyMaterializedContainerHacked,
  maybeCompleteMaterializedDataRelicSiteForContainerID,
  maybeCompleteClearedEncounterSite,
  buildClientWaveValues,
  publishClientWaveValues,
  applyNpcSentryEncounterProgressPolicy,
};

module.exports = DungeonUniverseSiteService;
