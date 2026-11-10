"use strict";

const path = require("path");

const config = require(path.join(__dirname, "../../config"));
const log = require(path.join(__dirname, "../../utils/logger"));
const itemStore = require(path.join(__dirname, "../inventory/itemStore"));
const {
  ITEM_FLAGS,
  findItemById,
  listContainerItems,
  updateInventoryItem,
} = itemStore;
const {
  buildShipResourceState,
} = require(path.join(__dirname, "../fitting/liveFittingState"));
const {
  getFleetHangarCapacity,
} = require(path.join(__dirname, "../inventory/fleetHangarInventory"));
const {
  TABLE,
  readStaticTable,
} = require(path.join(__dirname, "../_shared/referenceData"));
const {
  getCachedCharacterSkillMap,
} = require(path.join(__dirname, "../skills/skillState"));
const spaceRuntime = require(path.join(__dirname, "../../space/runtime"));
const worldData = require(path.join(__dirname, "../../space/worldData"));
const {
  buildChildEntityScopeMetadata,
  canEntitiesInteractLocally,
} = require(path.join(
  __dirname,
  "../../space/destiny/identity/interactionScope",
));
const {
  resolveAbyssalPlayerLaunchScope,
} = require(path.join(__dirname, "../_shared/abyssalPlayerLaunchScope"));
const {
  resolveAbyssalDeployableItemRestriction,
} = require(path.join(__dirname, "../_shared/abyssalDeployablePolicy"));
const {
  getNextClusterDowntimeAtMs: getNextClusterDowntimeAtMsShared,
  parseClusterDowntimeStartsUtc,
} = require(path.join(__dirname, "../_shared/clusterDowntime"));
const {
  LOOT_CUSTOM_INFO_KEY,
  buildSpaceLootRightsSnapshot,
  buildSpaceLootSourceFromItem,
  commitSpaceLootTheft,
  compensateSpaceLootTheft,
  evaluateSpaceLootAccess,
  recordSpaceLootTheft,
} = require(path.join(__dirname, "../_shared/spaceLootEntitlement"));
const {
  isCorpseType,
} = require(path.join(__dirname, "../../space/corpseUtils"));
const {
  RUNTIME_CORPSE_KIND,
} = require(path.join(__dirname, "../../space/destiny/constants"));
const {
  isJettisonableShipFlag,
} = require(path.join(__dirname, "./jettisonRuntime"));

const MAX_CARGO_CONTAINER_TRANSFER_DISTANCE_METERS = 2500;
const MAX_STARBASE_STRUCTURE_OPERATION_DISTANCE_METERS =
  MAX_CARGO_CONTAINER_TRANSFER_DISTANCE_METERS;

const CATEGORY_CELESTIAL = 2;
const CATEGORY_STARBASE = 23;
const CATEGORY_STRUCTURE = 65;
const GROUP_CARGO_CONTAINER = 12;
const GROUP_SECURE_CARGO_CONTAINER = 340;
const GROUP_CONTROL_TOWER = 365;
const GROUP_FORCE_FIELD = 411;
const GROUP_CORPORATE_HANGAR_ARRAY = 471;
const GROUP_AUDIT_LOG_SECURE_CONTAINER = 448;
const GROUP_FREIGHT_CONTAINER = 649;

const TYPE_CARGO_CONTAINER = 23;
const TYPE_HANGAR_CONTAINER = 41567;
const TYPE_PLANETARY_LAUNCH_CONTAINER = 2263;
const TYPE_STATION_CONTAINER = 17366;
const TYPE_STATION_VAULT_CONTAINER = 17367;
const TYPE_STATION_WAREHOUSE_CONTAINER = 17368;
const SCC_PASSWORD_TYPE_GENERAL = 1;
const SCC_PASSWORD_TYPE_CONFIG = 2;
const ALSC_PASSWORD_NEEDED_TO_OPEN = 1;
const ALSC_PASSWORD_NEEDED_TO_LOCK = 2;
const ALSC_PASSWORD_NEEDED_TO_UNLOCK = 4;
const ALSC_PASSWORD_NEEDED_TO_VIEW_AUDIT_LOG = 8;
const ALSC_LOCK_ADDED_ITEMS = 16;
const ALSC_CONFIG_MASK =
  ALSC_PASSWORD_NEEDED_TO_OPEN |
  ALSC_PASSWORD_NEEDED_TO_LOCK |
  ALSC_PASSWORD_NEEDED_TO_UNLOCK |
  ALSC_PASSWORD_NEEDED_TO_VIEW_AUDIT_LOG |
  ALSC_LOCK_ADDED_ITEMS;
const SECURE_CONTAINER_PASSWORD_MAX_LENGTH = 16;
const SECURE_CONTAINER_PASSWORD_MIN_LENGTH = 3;
const EFFECT_ANCHOR_DROP = 649;
const EFFECT_ANCHOR_LIFT = 650;
const ATTRIBUTE_REQUIRED_SKILL_1 = 182;
const ATTRIBUTE_REQUIRED_SKILL_1_LEVEL = 277;
const ATTRIBUTE_ANCHORING_DELAY = 556;
const TYPE_ANCHORING = 11584;
const DEFAULT_SECURE_CONTAINER_ANCHOR_DELAY_MS = 60000;
const MAX_SECURE_CONTAINER_ANCHOR_SECURITY = 0.7;
const MAX_TIMER_DELAY_MS = 2147000000;
const DAY_MS = 24 * 60 * 60 * 1000;
const ANCHORED_CARGO_CONTAINER_LIFETIME_MS = 30 * DAY_MS;
const RUNTIME_UNANCHORED_STRUCTURE_HULL_KIND = "unanchoredStructureHull";
const RUNTIME_STARBASE_KIND = "starbase";
const STRUCTURE_UNANCHOR_HULL_MARKER_PATTERN =
  /^evejs:structure-unanchor:hull:(\d+)$/;

const CARGO_CONTAINER_FAMILY = Object.freeze({
  STANDARD: "standard",
  SECURE: "secure",
  AUDIT_LOG_SECURE: "auditLogSecure",
  FREIGHT: "freight",
});
const SECURE_CONTAINER_ANCHOR_STATE = Object.freeze({
  UNANCHORED: "unanchored",
  ANCHORING: "anchoring",
  ANCHORED: "anchored",
  UNANCHORING: "unanchoring",
});
const secureContainerAnchorTimers = new Map();

function getNextClusterDowntimeAtMs(nowMs = Date.now()) {
  return getNextClusterDowntimeAtMsShared(
    nowMs,
    config.clusterDowntimeStarts,
  );
}

const NON_SCOOPABLE_CONTAINER_TYPE_IDS = new Set([
  TYPE_CARGO_CONTAINER,
  TYPE_HANGAR_CONTAINER,
  TYPE_PLANETARY_LAUNCH_CONTAINER,
]);
const STATION_ONLY_CONTAINER_TYPE_IDS = new Set([
  TYPE_STATION_CONTAINER,
  TYPE_STATION_VAULT_CONTAINER,
  TYPE_STATION_WAREHOUSE_CONTAINER,
]);

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function toReal(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function normalizeVector(value, fallback = { x: 0, y: 0, z: 0 }) {
  return {
    x: toReal(value && value.x, fallback.x),
    y: toReal(value && value.y, fallback.y),
    z: toReal(value && value.z, fallback.z),
  };
}

function isFiniteVector(value) {
  return Boolean(
    value &&
    Number.isFinite(Number(value.x)) &&
    Number.isFinite(Number(value.y)) &&
    Number.isFinite(Number(value.z))
  );
}

function getVectorDistance(left, right) {
  const l = normalizeVector(left);
  const r = normalizeVector(right);
  return Math.sqrt(
    ((l.x - r.x) ** 2) +
    ((l.y - r.y) ** 2) +
    ((l.z - r.z) ** 2),
  );
}

function getSessionContext(session) {
  const characterID = toInt(session && (session.characterID || session.charid), 0);
  const corporationID = toInt(
    session && (session.corporationID || session.corpid),
    0,
  );
  const shipID = toInt(
    session && session._space && session._space.shipID,
    toInt(session && (session.shipID || session.shipid || session.activeShipID), 0),
  );
  const systemID = toInt(
    session && session._space && session._space.systemID,
    toInt(session && (session.solarsystemid2 || session.solarsystemid), 0),
  );
  const scene = spaceRuntime.getSceneForSession(session);
  return {
    characterID,
    corporationID,
    shipID,
    systemID,
    sceneDescriptor: scene && scene.sceneDescriptor || null,
  };
}

function getSyncInventoryItemForSession() {
  const characterState = require(path.join(__dirname, "../character/characterState"));
  return characterState.syncInventoryItemForSession;
}

function getCargoContainerFamily(item) {
  if (!item || toInt(item.categoryID, 0) !== CATEGORY_CELESTIAL) {
    return null;
  }

  switch (toInt(item.groupID, 0)) {
    case GROUP_CARGO_CONTAINER:
      return CARGO_CONTAINER_FAMILY.STANDARD;
    case GROUP_SECURE_CARGO_CONTAINER:
      return CARGO_CONTAINER_FAMILY.SECURE;
    case GROUP_AUDIT_LOG_SECURE_CONTAINER:
      return CARGO_CONTAINER_FAMILY.AUDIT_LOG_SECURE;
    case GROUP_FREIGHT_CONTAINER:
      return CARGO_CONTAINER_FAMILY.FREIGHT;
    default:
      return null;
  }
}

function isCargoContainerType(item) {
  return getCargoContainerFamily(item) !== null;
}

function isControlTowerType(item) {
  return Boolean(
    item &&
      toInt(item.categoryID, 0) === CATEGORY_STARBASE &&
      toInt(item.groupID, 0) === GROUP_CONTROL_TOWER,
  );
}

function isScoopableStarbaseStructureType(item) {
  return Boolean(
    item &&
      toInt(item.categoryID, 0) === CATEGORY_STARBASE &&
      toInt(item.groupID, 0) !== GROUP_FORCE_FIELD,
  );
}

function isStarbaseCorporateHangarArrayType(item) {
  return Boolean(
    item &&
      toInt(item.categoryID, 0) === CATEGORY_STARBASE &&
      (toInt(item.groupID, 0) === GROUP_CORPORATE_HANGAR_ARRAY ||
        require("../industry/starbaseIndustryRuntime").isAssemblyArray(item)),
  );
}

function isNonScoopableContainerType(item) {
  return NON_SCOOPABLE_CONTAINER_TYPE_IDS.has(toInt(item && item.typeID, 0));
}

function isUnanchoredStructureHullItem(item) {
  const markerMatch = STRUCTURE_UNANCHOR_HULL_MARKER_PATTERN.exec(
    String(item && item.customInfo || ""),
  );
  const markerStructureID = toInt(markerMatch && markerMatch[1], 0);
  return Boolean(
    item &&
    markerMatch &&
    markerStructureID > 0 &&
    toInt(item.typeID, 0) > 0 &&
    toInt(item.categoryID, 0) === CATEGORY_STRUCTURE &&
    toInt(item.singleton, 0) === 1 &&
    toInt(item.launcherID, 0) === markerStructureID
  );
}

function isScoopableCargoContainerType(item) {
  return (
    (isCargoContainerType(item) && !isNonScoopableContainerType(item)) ||
    isUnanchoredStructureHullItem(item)
  );
}

// The client offers Scoop to Cargo Hold for corpses on the same ship.Scoop RPC
// it uses for containers (clientcodegrabber/latest/menucheckers/celestialCheckers
// .py IsScoopable), so they share this scoop path rather than being looted. An
// unanchored POS structure uses the same transfer contract, with explicit
// corporation ownership and starbase-ball checks below.
function isScoopableSpaceItem(item) {
  return (
    isScoopableCargoContainerType(item) ||
    isCorpseType(item) ||
    isScoopableStarbaseStructureType(item)
  );
}

function isSecureCargoContainerType(item) {
  const groupID = toInt(item && item.groupID, 0);
  return (
    groupID === GROUP_SECURE_CARGO_CONTAINER ||
    groupID === GROUP_AUDIT_LOG_SECURE_CONTAINER
  );
}

function isStationOnlyCargoContainerType(item) {
  return STATION_ONLY_CONTAINER_TYPE_IDS.has(toInt(item && item.typeID, 0));
}

function getTypeDogmaRecord(typeID) {
  const root = readStaticTable(TABLE.TYPE_DOGMA) || {};
  return (
    root.typesByTypeID &&
    root.typesByTypeID[String(toInt(typeID, 0))]
  ) || null;
}

function getTypeDogmaAttributeValue(typeID, attributeID, fallback = null) {
  const record = getTypeDogmaRecord(typeID);
  const value =
    record &&
    record.attributes &&
    record.attributes[String(toInt(attributeID, 0))];
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function typeHasDogmaEffect(typeID, effectID) {
  const record = getTypeDogmaRecord(typeID);
  return Boolean(
    record &&
    Array.isArray(record.effects) &&
    record.effects.includes(toInt(effectID, 0)),
  );
}

function isAnchorableSecureContainerType(item) {
  return Boolean(
    isSecureCargoContainerType(item) &&
    !isStationOnlyCargoContainerType(item) &&
    typeHasDogmaEffect(item.typeID, EFFECT_ANCHOR_DROP) &&
    typeHasDogmaEffect(item.typeID, EFFECT_ANCHOR_LIFT),
  );
}

function isDirectSpaceReusableCargoContainer(item) {
  const locationID = toInt(item && item.locationID, 0);
  const systemID = toInt(
    item && item.spaceState && item.spaceState.systemID,
    0,
  );
  return Boolean(
    item &&
    isCargoContainerType(item) &&
    !isNonScoopableContainerType(item) &&
    !isStationOnlyCargoContainerType(item) &&
    toInt(item.flagID, -1) === 0 &&
    systemID > 0 &&
    locationID === systemID
  );
}

function reconcileCargoContainerLifecycleExpiry(itemOrID, options = {}) {
  const itemID =
    itemOrID && typeof itemOrID === "object"
      ? toInt(itemOrID.itemID, 0)
      : toInt(itemOrID, 0);
  const item = findItemById(itemID) || (
    itemOrID && typeof itemOrID === "object" ? itemOrID : null
  );
  if (!item || !isDirectSpaceReusableCargoContainer(item)) {
    return {
      success: Boolean(item),
      data: item,
      changed: false,
    };
  }

  const nowMs = Number.isFinite(Number(options.nowMs))
    ? Number(options.nowMs)
    : Date.now();
  const state = isAnchorableSecureContainerType(item)
    ? getSecureContainerState(item)
    : null;
  const isAnchored = Boolean(state && state.anchored);
  const currentExpiryAtMs = Number(item.expiresAtMs);
  const hasCurrentExpiry =
    Number.isFinite(currentExpiryAtMs) && currentExpiryAtMs > 0;
  let expiresAtMs = currentExpiryAtMs;
  if (
    isAnchored &&
    (options.refreshAnchored === true || !hasCurrentExpiry)
  ) {
    expiresAtMs = nowMs + ANCHORED_CARGO_CONTAINER_LIFETIME_MS;
  } else if (
    !isAnchored &&
    (options.resetUnanchored === true || !hasCurrentExpiry)
  ) {
    expiresAtMs = getNextClusterDowntimeAtMs(nowMs);
  }

  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= 0) {
    return {
      success: false,
      errorMsg: "CONTAINER_EXPIRY_INVALID",
      data: item,
      changed: false,
    };
  }
  if (hasCurrentExpiry && currentExpiryAtMs === expiresAtMs) {
    return {
      success: true,
      data: item,
      changed: false,
    };
  }

  const updateResult = updateInventoryItem(itemID, (currentItem) => ({
    ...currentItem,
    expiresAtMs,
  }));
  return {
    ...updateResult,
    changed: Boolean(updateResult.success),
  };
}

function touchAnchoredCargoContainerContents(itemID, options = {}) {
  const item = findItemById(toInt(itemID, 0));
  if (
    !item ||
    !isDirectSpaceReusableCargoContainer(item) ||
    !isAnchorableSecureContainerType(item) ||
    !getSecureContainerState(item).anchored
  ) {
    return {
      success: Boolean(item),
      data: item,
      changed: false,
    };
  }

  const result = reconcileCargoContainerLifecycleExpiry(item, {
    nowMs: options.nowMs,
    refreshAnchored: true,
  });
  if (result.success && result.changed && options.refreshPresentation !== false) {
    refreshSecureContainerAnchorPresentation(result.data, {
      broadcast: false,
    });
  }
  return result;
}

function getSecureContainerAnchorDelayMs(itemOrTypeID) {
  const typeID =
    itemOrTypeID && typeof itemOrTypeID === "object"
      ? toInt(itemOrTypeID.typeID, 0)
      : toInt(itemOrTypeID, 0);
  const authoredDelay = getTypeDogmaAttributeValue(
    typeID,
    ATTRIBUTE_ANCHORING_DELAY,
    DEFAULT_SECURE_CONTAINER_ANCHOR_DELAY_MS,
  );
  return authoredDelay > 0
    ? Math.trunc(authoredDelay)
    : DEFAULT_SECURE_CONTAINER_ANCHOR_DELAY_MS;
}

function normalizeAnchorState(value, anchoredFallback = false) {
  const normalized = String(value || "").trim().toLowerCase();
  if (Object.values(SECURE_CONTAINER_ANCHOR_STATE).includes(normalized)) {
    return normalized;
  }
  return anchoredFallback
    ? SECURE_CONTAINER_ANCHOR_STATE.ANCHORED
    : SECURE_CONTAINER_ANCHOR_STATE.UNANCHORED;
}

function isAnchorStateSecured(anchorState) {
  return (
    anchorState === SECURE_CONTAINER_ANCHOR_STATE.ANCHORED ||
    anchorState === SECURE_CONTAINER_ANCHOR_STATE.UNANCHORING
  );
}

function normalizeAnchorTimestamp(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0
    ? Math.trunc(numeric)
    : null;
}

function parseCustomInfo(customInfo) {
  if (!customInfo) {
    return {};
  }
  if (typeof customInfo === "object" && !Array.isArray(customInfo)) {
    return customInfo;
  }
  try {
    const parsed = JSON.parse(String(customInfo));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch (_error) {
    // ignored: unreadable customInfo counts as empty
    return {};
  }
}

function cloneCustomInfoObjectForMutation(customInfo) {
  if (!customInfo) {
    return {};
  }
  if (typeof customInfo === "object" && !Array.isArray(customInfo)) {
    return JSON.parse(JSON.stringify(customInfo));
  }
  try {
    const parsed = JSON.parse(String(customInfo));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : null;
  } catch (_error) {
    // ignored: unreadable customInfo gives no object (null)
    return null;
  }
}

function serializeMutatedCustomInfo(parsed, originalCustomInfo) {
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed)
  ) {
    return originalCustomInfo;
  }
  if (typeof originalCustomInfo === "object") {
    return parsed;
  }
  return Object.keys(parsed).length > 0
    ? JSON.stringify(parsed)
    : "";
}

function getCargoContainerSessionLootContext(session, characterID) {
  let characterRecord = {};
  try {
    const characterState = require(path.join(
      __dirname,
      "../character/characterState",
    ));
    characterRecord =
      characterState &&
      typeof characterState.getCharacterRecord === "function"
        ? characterState.getCharacterRecord(characterID) || {}
        : {};
  } catch (_error) {
    characterRecord = {};
  }

  let fleetID = toInt(
    session && (
      session.fleetid ??
      session.fleetID ??
      (session._character && (
        session._character.fleetid ??
        session._character.fleetID
      ))
    ),
    0,
  );
  if (fleetID <= 0) {
    try {
      const fleetRuntime = require(path.join(
        __dirname,
        "../fleets/fleetRuntime",
      ));
      const fleet =
        fleetRuntime &&
        typeof fleetRuntime.getFleetForCharacter === "function"
          ? fleetRuntime.getFleetForCharacter(characterID)
          : null;
      fleetID = toInt(fleet && fleet.fleetID, 0);
    } catch (_error) {
      fleetID = 0;
    }
  }

  return {
    corporationID: toInt(
      session && (
        session.corporationID ??
        session.corpid ??
        session.corpID ??
        (session._character && (
          session._character.corporationID ??
          session._character.corpid
        ))
      ),
      toInt(
        characterRecord.corporationID ?? characterRecord.corpid,
        0,
      ),
    ),
    allianceID: toInt(
      session && (
        session.allianceID ??
        session.allianceid ??
        (session._character && (
          session._character.allianceID ??
          session._character.allianceid
        ))
      ),
      toInt(
        characterRecord.allianceID ?? characterRecord.allianceid,
        0,
      ),
    ),
    warFactionID: toInt(
      session && (
        session.warFactionID ??
        session.warfactionid ??
        (session._character && (
          session._character.warFactionID ??
          session._character.warfactionid
        ))
      ),
      toInt(
        characterRecord.warFactionID ?? characterRecord.warfactionid,
        0,
      ),
    ),
    fleetID,
  };
}

function buildCargoContainerLootCustomInfo(
  customInfo,
  lootContext,
) {
  const parsed = cloneCustomInfoObjectForMutation(customInfo);
  if (!parsed) {
    return customInfo;
  }
  parsed[LOOT_CUSTOM_INFO_KEY] = buildSpaceLootRightsSnapshot(lootContext);
  return serializeMutatedCustomInfo(parsed, customInfo);
}

function stripCargoContainerLootCustomInfo(customInfo) {
  const parsed = cloneCustomInfoObjectForMutation(customInfo);
  if (
    !parsed ||
    !Object.prototype.hasOwnProperty.call(parsed, LOOT_CUSTOM_INFO_KEY)
  ) {
    return customInfo;
  }
  delete parsed[LOOT_CUSTOM_INFO_KEY];
  return serializeMutatedCustomInfo(parsed, customInfo);
}

function firstTextValue(values) {
  for (const value of values) {
    if (value === null || value === undefined) {
      continue;
    }
    const text = String(value);
    if (text.length > 0) {
      return text;
    }
  }
  return "";
}

function firstBooleanTrue(values) {
  return values.some((value) => value === true || value === 1 || value === "1");
}

function getLegacySecureContainerState(item) {
  const info = parseCustomInfo(item && item.customInfo);
  const secure = info.secureContainer && typeof info.secureContainer === "object"
    ? info.secureContainer
    : {};
  const cargo = info.cargoContainer && typeof info.cargoContainer === "object"
    ? info.cargoContainer
    : {};
  const state = info.state && typeof info.state === "object" ? info.state : {};
  return {
    anchored: firstBooleanTrue([
      info.anchored,
      info.isAnchored,
      state.anchored,
      secure.anchored,
      cargo.anchored,
      info.anchorState === "anchored",
      secure.anchorState === "anchored",
      cargo.anchorState === "anchored",
    ]),
    password: firstTextValue([
      info.secureContainerPassword,
      info.containerPassword,
      info.scoopPassword,
      info.generalPassword,
      info.password,
      secure.password,
      secure.generalPassword,
      cargo.password,
      cargo.generalPassword,
      state.password,
      state.generalPassword,
    ]),
    configPassword: firstTextValue([
      info.configPassword,
      secure.configPassword,
      cargo.configPassword,
      state.configPassword,
    ]),
  };
}

function getSecureContainerState(item) {
  const stored =
    item &&
    item.secureContainerState &&
    typeof item.secureContainerState === "object" &&
    !Array.isArray(item.secureContainerState)
      ? item.secureContainerState
      : {};
  const legacy = getLegacySecureContainerState(item);
  const hasStoredAnchored = Object.prototype.hasOwnProperty.call(
    stored,
    "anchored",
  );
  const hasStoredGeneralPassword = Object.prototype.hasOwnProperty.call(
    stored,
    "generalPassword",
  );
  const hasStoredConfigPassword = Object.prototype.hasOwnProperty.call(
    stored,
    "configPassword",
  );
  const canonicalStored = { ...stored };
  delete canonicalStored.password;
  const anchoredFallback = hasStoredAnchored
    ? Boolean(stored.anchored)
    : Boolean(legacy.anchored);
  const anchorState = normalizeAnchorState(
    stored.anchorState,
    anchoredFallback,
  );
  const isTransitioning =
    anchorState === SECURE_CONTAINER_ANCHOR_STATE.ANCHORING ||
    anchorState === SECURE_CONTAINER_ANCHOR_STATE.UNANCHORING;

  const resolvedState = {
    ...canonicalStored,
    anchored: isAnchorStateSecured(anchorState),
    anchorState,
    anchorStartedAtMs: isTransitioning
      ? normalizeAnchorTimestamp(stored.anchorStartedAtMs)
      : null,
    anchorCompletesAtMs: isTransitioning
      ? normalizeAnchorTimestamp(stored.anchorCompletesAtMs)
      : null,
    generalPassword: String(
      hasStoredGeneralPassword
        ? stored.generalPassword || ""
        : legacy.password || "",
    ).slice(0, SECURE_CONTAINER_PASSWORD_MAX_LENGTH),
    configPassword: String(
      hasStoredConfigPassword
        ? stored.configPassword || ""
        : legacy.configPassword || "",
    ).slice(0, SECURE_CONTAINER_PASSWORD_MAX_LENGTH),
    generalPasswordRevision: Math.max(
      0,
      Math.trunc(Number(stored.generalPasswordRevision) || 0),
    ),
    configPasswordRevision: Math.max(
      0,
      Math.trunc(Number(stored.configPasswordRevision) || 0),
    ),
    alscConfig:
      Math.max(0, Math.trunc(Number(stored.alscConfig) || 0)) &
      ALSC_CONFIG_MASK,
  };
  if (resolveAbyssalDeployableItemRestriction(item, {
    solarSystemID: item && item.spaceState && item.spaceState.systemID,
  })) {
    return {
      ...resolvedState,
      anchored: false,
      anchorState: SECURE_CONTAINER_ANCHOR_STATE.UNANCHORED,
      anchorStartedAtMs: null,
      anchorCompletesAtMs: null,
    };
  }
  return resolvedState;
}

function buildCanonicalSecureContainerState(item, options = {}) {
  if (!isSecureCargoContainerType(item)) {
    return item && item.secureContainerState;
  }
  const resolved = getSecureContainerState(item);
  const hasAnchoredOverride = Object.prototype.hasOwnProperty.call(
    options,
    "anchored",
  );
  const hasAnchorStateOverride = Object.prototype.hasOwnProperty.call(
    options,
    "anchorState",
  );
  const anchorState = hasAnchorStateOverride
    ? normalizeAnchorState(options.anchorState, false)
    : hasAnchoredOverride
      ? (
        Boolean(options.anchored)
          ? SECURE_CONTAINER_ANCHOR_STATE.ANCHORED
          : SECURE_CONTAINER_ANCHOR_STATE.UNANCHORED
      )
      : normalizeAnchorState(resolved.anchorState, resolved.anchored);
  const isTransitioning =
    anchorState === SECURE_CONTAINER_ANCHOR_STATE.ANCHORING ||
    anchorState === SECURE_CONTAINER_ANCHOR_STATE.UNANCHORING;
  return {
    ...resolved,
    anchored: isAnchorStateSecured(anchorState),
    anchorState,
    anchorStartedAtMs: isTransitioning
      ? normalizeAnchorTimestamp(
        Object.prototype.hasOwnProperty.call(options, "anchorStartedAtMs")
          ? options.anchorStartedAtMs
          : resolved.anchorStartedAtMs,
      )
      : null,
    anchorCompletesAtMs: isTransitioning
      ? normalizeAnchorTimestamp(
        Object.prototype.hasOwnProperty.call(options, "anchorCompletesAtMs")
          ? options.anchorCompletesAtMs
          : resolved.anchorCompletesAtMs,
      )
      : null,
  };
}

function stripLegacySecureContainerStateFromCustomInfo(customInfo) {
  if (!customInfo) {
    return customInfo;
  }

  let parsed = null;
  try {
    parsed =
      typeof customInfo === "object" && !Array.isArray(customInfo)
        ? JSON.parse(JSON.stringify(customInfo))
        : JSON.parse(String(customInfo));
  } catch (_error) {
    return customInfo;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return customInfo;
  }

  let changed = false;
  const removeKeys = (target, keys) => {
    if (!target || typeof target !== "object" || Array.isArray(target)) {
      return;
    }
    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(target, key)) {
        delete target[key];
        changed = true;
      }
    }
  };
  removeKeys(parsed, [
    "secureContainerPassword",
    "containerPassword",
    "scoopPassword",
    "generalPassword",
    "configPassword",
    "password",
    "anchored",
    "isAnchored",
    "anchorState",
  ]);
  for (const key of ["secureContainer", "cargoContainer", "state"]) {
    const nested = parsed[key];
    removeKeys(nested, [
      "password",
      "generalPassword",
      "configPassword",
      "anchored",
      "isAnchored",
      "anchorState",
    ]);
    if (
      nested &&
      typeof nested === "object" &&
      !Array.isArray(nested) &&
      Object.keys(nested).length === 0
    ) {
      delete parsed[key];
      changed = true;
    }
  }

  if (!changed) {
    return customInfo;
  }
  return typeof customInfo === "object"
    ? parsed
    : JSON.stringify(parsed);
}

// Retail never offers Scoop for a container that is not free-floating: the
// client only lists the action while the ball is free, so an anchored - or
// still anchoring / unanchoring - container cannot be scooped by anyone, its
// owner included. It has to be unanchored first. Treating every non-idle
// anchor state as anchored also closes the window where a container caught
// mid-'anchoring' could be scooped without its password.
function isCargoContainerAnchorLocked(item) {
  if (isScoopableStarbaseStructureType(item)) {
    const spaceState = item && item.spaceState || {};
    const anchorState = String(spaceState.anchorState || "")
      .trim()
      .toLowerCase();
    return anchorState
      ? anchorState !== SECURE_CONTAINER_ANCHOR_STATE.UNANCHORED
      : spaceState.isAnchored === true || spaceState.isAnchored === 1;
  }
  if (!isAnchorableSecureContainerType(item)) {
    return false;
  }
  return (
    getSecureContainerState(item).anchorState !==
    SECURE_CONTAINER_ANCHOR_STATE.UNANCHORED
  );
}

function isSecureContainerPasswordSatisfied(item, providedPassword) {
  if (!isSecureCargoContainerType(item)) {
    return true;
  }

  const state = getSecureContainerState(item);
  if (!state.anchored || !state.generalPassword) {
    return true;
  }

  return String(providedPassword || "") === state.generalPassword;
}

function getItemMoveVolume(item) {
  return Math.max(0, toReal(item && item.volume, 0));
}

function getItemMoveQuantity(item) {
  return toInt(item && item.singleton, 0) === 1
    ? 1
    : Math.max(0, toInt(item && (item.stacksize ?? item.quantity), 0));
}

function getShipHoldCapacity(characterID, shipItem, destinationFlagID) {
  if (!shipItem) {
    return 0;
  }
  const resourceState = buildShipResourceState(characterID, shipItem);
  if (toInt(destinationFlagID, 0) === ITEM_FLAGS.FLEET_HANGAR) {
    return Math.max(0, toReal(getFleetHangarCapacity(resourceState), 0));
  }
  return Math.max(0, toReal(resourceState && resourceState.cargoCapacity, 0));
}

function getShipHoldUsedVolume(shipID, destinationFlagID, excludedItemID = 0) {
  const excludedID = toInt(excludedItemID, 0);
  return listContainerItems(null, shipID, destinationFlagID)
    .reduce((sum, item) => {
      if (!item || toInt(item.itemID, 0) === excludedID) {
        return sum;
      }
      return sum + (getItemMoveVolume(item) * getItemMoveQuantity(item));
    }, 0);
}

function validateScoopDestination(item, context, destinationFlagID) {
  const normalizedDestinationFlagID = toInt(destinationFlagID, 0);
  if (
    normalizedDestinationFlagID !== ITEM_FLAGS.CARGO_HOLD &&
    normalizedDestinationFlagID !== ITEM_FLAGS.FLEET_HANGAR
  ) {
    return "INVALID_SCOOP_DESTINATION";
  }
  const shipItem = findItemById(context.shipID);
  const capacity = getShipHoldCapacity(
    context.characterID,
    shipItem,
    normalizedDestinationFlagID,
  );
  if (
    normalizedDestinationFlagID === ITEM_FLAGS.FLEET_HANGAR &&
    capacity <= 0
  ) {
    return "FLEET_HANGAR_NOT_AVAILABLE";
  }
  const used = getShipHoldUsedVolume(
    context.shipID,
    normalizedDestinationFlagID,
    item && item.itemID,
  );
  if (used + getItemMoveVolume(item) > capacity + 1e-7) {
    return normalizedDestinationFlagID === ITEM_FLAGS.FLEET_HANGAR
      ? "NOT_ENOUGH_FLEET_HANGAR_SPACE"
      : "NOT_ENOUGH_CARGO_SPACE";
  }
  return null;
}

function hasAuthorizedStarbaseScoopShieldAccess(session, item, scene, shipEntity) {
  const resources = require("../starbase/starbaseResourceRuntime");
  const tower = findItemById(resources.getModuleControlTowerID(item));
  const modules = require("../starbase/starbaseModuleRuntime");
  if (!modules.isEligibleAssociationTower(item, tower)) {
    return false;
  }
  const towerState = tower.spaceState;
  if (
    toInt(tower.flagID, -1) !== 0 ||
    toInt(tower.locationID, 0) !== toInt(item.locationID, 0) ||
    towerState.onlineState !== "online" ||
    toInt(towerState.online, 0) !== 1 ||
    towerState.isFree === true ||
    !isFiniteVector(towerState.position)
  ) {
    return false;
  }
  const towerEntity = scene.getEntityByID(tower.itemID);
  const containerEntity = scene.getEntityByID(item.itemID);
  if (
    !towerEntity ||
    towerEntity.kind !== RUNTIME_STARBASE_KIND ||
    !isFiniteVector(towerEntity.position) ||
    !canEntitiesInteractLocally(shipEntity, towerEntity) ||
    (typeof scene.canSessionSeeDungeonScopedEntity === "function" &&
      (!scene.canSessionSeeDungeonScopedEntity(session, towerEntity) ||
        !scene.canSessionSeeDungeonScopedEntity(session, containerEntity)))
  ) {
    return false;
  }
  // michelle.py IsShipInRangeOfStructureControlTower uses the associated
  // tower and a strict centre-distance check, without either hull radius.
  // Extend scoop range only for an admitted pilot with recovery permission;
  // the caller still validates ownership, local scope and unanchored state.
  const policy = require("../starbase/starbaseAnchoringPolicy");
  const shieldRadius = toReal(policy.getDogmaAttribute(
    tower.typeID,
    policy.ATTRIBUTE_SHIELD_RADIUS,
    0,
  ), 0);
  const access = require("../starbase/starbaseAccessRuntime");
  return shieldRadius > 0 &&
    getVectorDistance(shipEntity.position, towerEntity.position) < shieldRadius &&
    access.canShipEnterForceField(tower, session) &&
    access.hasStarbasePermission(session, tower, item.itemID, "unanchor");
}

function validateCargoContainerSpaceAccess(session, item, context) {
  if (!context.characterID || !context.shipID || !context.systemID) {
    return "INVALID_SESSION";
  }
  if (!item) {
    return "ITEM_NOT_FOUND";
  }
  if (!isScoopableSpaceItem(item)) {
    return "ITEM_NOT_SCOOPABLE_CONTAINER";
  }
  if (
    isScoopableStarbaseStructureType(item) &&
    ![context.characterID, context.corporationID].includes(
      toInt(item.ownerID, 0),
    )
  ) {
    return isControlTowerType(item)
      ? "CONTROL_TOWER_NOT_OWNER"
      : "STARBASE_STRUCTURE_NOT_OWNER";
  }
  if (
    toInt(item.locationID, 0) !== context.systemID ||
    toInt(item.flagID, -1) !== 0 ||
    !item.spaceState ||
    toInt(item.spaceState.systemID, 0) !== context.systemID ||
    !isFiniteVector(item.spaceState.position)
  ) {
    return "CONTAINER_NOT_IN_SPACE";
  }

  const scene = spaceRuntime.getSceneForSession(session);
  const shipEntity = spaceRuntime.getEntity(session, context.shipID);
  if (!scene || !shipEntity || shipEntity.kind !== "ship") {
    return "SHIP_NOT_VISIBLE";
  }
  const containerEntity = scene && scene.getEntityByID(item.itemID);
  // Unanchored structure hulls and corpses each sit in space as their own
  // runtime kind rather than an ordinary jettison container, so accept whichever
  // kind the item is meant to have.
  const expectedEntityKind = isUnanchoredStructureHullItem(item)
    ? RUNTIME_UNANCHORED_STRUCTURE_HULL_KIND
    : isScoopableStarbaseStructureType(item)
      ? RUNTIME_STARBASE_KIND
      : isCorpseType(item)
        ? RUNTIME_CORPSE_KIND
        : "container";
  if (
    !shipEntity ||
    !containerEntity ||
    containerEntity.kind !== expectedEntityKind ||
    !canEntitiesInteractLocally(shipEntity, containerEntity)
  ) {
    return "CONTAINER_NOT_VISIBLE";
  }

  const shipPosition = shipEntity && shipEntity.position;
  const containerPosition = containerEntity && containerEntity.position;
  if (!isFiniteVector(shipPosition) || !isFiniteVector(containerPosition)) {
    return "INVALID_SPACE_POSITION";
  }
  const isStarbaseStructure = isScoopableStarbaseStructureType(item);
  // Measure hull to hull, as the client does. Its overview distance subtracts
  // both radii (overviewScrollEntry._GetSurfaceDistance), and Scoop to Cargo
  // Hold flies the ship in only until that distance drops under 2,500 m before
  // it sends the scoop (autopilot.InInteractionRange). Anything stricter
  // refuses a pilot the client has already put in range, and leaves an
  // unanchored control tower, whose radius alone exceeds the limit, impossible
  // to scoop from outside its own hull.
  const transferDistance =
    typeof scene.getEntitySurfaceDistance === "function"
      ? scene.getEntitySurfaceDistance(shipEntity, containerEntity)
      : Math.max(
        0,
        getVectorDistance(shipPosition, containerPosition) -
          Math.max(0, toReal(shipEntity && shipEntity.radius, 0)) -
          Math.max(0, toReal(containerEntity && containerEntity.radius, 0)),
      );
  if (!Number.isFinite(transferDistance)) {
    return "INVALID_SPACE_POSITION";
  }
  // menusvc.py Scoop and ScoopToFleetHangar both use the default 2,500 m
  // interaction range, including unanchored starbase structures.
  if (
    transferDistance > MAX_CARGO_CONTAINER_TRANSFER_DISTANCE_METERS &&
    !(isStarbaseStructure &&
      hasAuthorizedStarbaseScoopShieldAccess(session, item, scene, shipEntity))
  ) {
    return isStarbaseStructure
      ? "STARBASE_STRUCTURE_TOO_FAR"
      : "TARGET_TOO_FAR";
  }

  return null;
}

function syncInventoryChange(session, item, previousData) {
  if (!session || !item) {
    return;
  }
  const syncInventoryItemForSession = getSyncInventoryItemForSession();
  if (typeof syncInventoryItemForSession !== "function") {
    return;
  }
  syncInventoryItemForSession(
    session,
    item,
    previousData || {},
    { emitCfgLocation: true },
  );
}

function refreshSecureContainerAnchorPresentation(item, options = {}) {
  if (!item || !isAnchorableSecureContainerType(item)) {
    return null;
  }
  const systemID = toInt(
    item.spaceState && item.spaceState.systemID,
    toInt(item.locationID, 0),
  );
  if (!systemID || toInt(item.locationID, 0) !== systemID) {
    return null;
  }
  return spaceRuntime.refreshInventoryBackedEntityPresentation(
    systemID,
    item.itemID,
    {
      broadcast: options.broadcast !== false,
      excludedSession: options.excludedSession || null,
    },
  );
}

function getCharacterSkillLevel(characterID, skillTypeID) {
  const skillMap = getCachedCharacterSkillMap(toInt(characterID, 0));
  const record = skillMap instanceof Map
    ? skillMap.get(toInt(skillTypeID, 0))
    : null;
  return Math.max(
    0,
    toInt(
      record && (
        record.effectiveSkillLevel ??
        record.trainedSkillLevel ??
        record.skillLevel ??
        record.level
      ),
      0,
    ),
  );
}

function getSecureContainerAnchorSkillRequirement(item) {
  return {
    skillTypeID: toInt(
      getTypeDogmaAttributeValue(
        item && item.typeID,
        ATTRIBUTE_REQUIRED_SKILL_1,
        TYPE_ANCHORING,
      ),
      TYPE_ANCHORING,
    ),
    skillLevel: Math.max(
      1,
      toInt(
        getTypeDogmaAttributeValue(
          item && item.typeID,
          ATTRIBUTE_REQUIRED_SKILL_1_LEVEL,
          1,
        ),
        1,
      ),
    ),
  };
}

function getDisplayedSolarSystemSecurity(systemID) {
  const system = worldData.getSolarSystemByID(toInt(systemID, 0));
  if (!system) {
    return null;
  }
  const rawSecurity = Number(
    system.security ?? system.securityStatus,
  );
  if (!Number.isFinite(rawSecurity)) {
    return null;
  }
  return Math.round(rawSecurity * 10) / 10;
}

function clearSecureContainerAnchorTimer(itemID) {
  const numericItemID = toInt(itemID, 0);
  const timer = secureContainerAnchorTimers.get(numericItemID);
  if (timer) {
    clearTimeout(timer);
    secureContainerAnchorTimers.delete(numericItemID);
  }
}

function clearSecureContainerAnchorTimers() {
  for (const itemID of secureContainerAnchorTimers.keys()) {
    clearSecureContainerAnchorTimer(itemID);
  }
}

function scheduleSecureContainerAnchorReconciliation(
  itemID,
  completesAtMs,
  session = null,
) {
  const numericItemID = toInt(itemID, 0);
  const numericCompletesAtMs = normalizeAnchorTimestamp(completesAtMs);
  clearSecureContainerAnchorTimer(numericItemID);
  if (!numericItemID || !numericCompletesAtMs) {
    return false;
  }

  const delayMs = Math.min(
    MAX_TIMER_DELAY_MS,
    Math.max(0, numericCompletesAtMs - Date.now()),
  );
  const timer = setTimeout(() => {
    secureContainerAnchorTimers.delete(numericItemID);
    const result = reconcileSecureContainerAnchorState(numericItemID, {
      nowMs: Date.now(),
      session,
      schedule: true,
    });
    if (!result.success) {
      log.warn(
        `[CargoContainer] Anchor reconciliation failed item=${numericItemID} error=${result.errorMsg}`,
      );
    }
  }, delayMs);
  if (timer && typeof timer.unref === "function") {
    timer.unref();
  }
  secureContainerAnchorTimers.set(numericItemID, timer);
  return true;
}

function reconcileSecureContainerAnchorState(itemOrID, options = {}) {
  const itemID =
    itemOrID && typeof itemOrID === "object"
      ? toInt(itemOrID.itemID, 0)
      : toInt(itemOrID, 0);
  const item = findItemById(itemID);
  if (!item) {
    clearSecureContainerAnchorTimer(itemID);
    return {
      success: false,
      errorMsg: "ITEM_NOT_FOUND",
    };
  }
  if (!isAnchorableSecureContainerType(item)) {
    clearSecureContainerAnchorTimer(itemID);
    return {
      success: false,
      errorMsg: "ITEM_NOT_ANCHORABLE_CONTAINER",
    };
  }

  const state = getSecureContainerState(item);
  const isAnchoring =
    state.anchorState === SECURE_CONTAINER_ANCHOR_STATE.ANCHORING;
  const isUnanchoring =
    state.anchorState === SECURE_CONTAINER_ANCHOR_STATE.UNANCHORING;
  if (!isAnchoring && !isUnanchoring) {
    clearSecureContainerAnchorTimer(itemID);
    return {
      success: true,
      data: item,
      completed: false,
    };
  }

  const nowMs = Math.max(0, toInt(options.nowMs, Date.now()));
  const completesAtMs = normalizeAnchorTimestamp(state.anchorCompletesAtMs);
  if (
    completesAtMs &&
    nowMs < completesAtMs
  ) {
    if (options.schedule !== false) {
      scheduleSecureContainerAnchorReconciliation(
        itemID,
        completesAtMs,
        options.session || null,
      );
    }
    return {
      success: true,
      data: item,
      completed: false,
    };
  }

  const finalAnchorState = isAnchoring
    ? (
      completesAtMs
        ? SECURE_CONTAINER_ANCHOR_STATE.ANCHORED
        : SECURE_CONTAINER_ANCHOR_STATE.UNANCHORED
    )
    : (
      completesAtMs
        ? SECURE_CONTAINER_ANCHOR_STATE.UNANCHORED
      : SECURE_CONTAINER_ANCHOR_STATE.ANCHORED
    );
  const expiresAtMs =
    finalAnchorState === SECURE_CONTAINER_ANCHOR_STATE.ANCHORED
      ? nowMs + ANCHORED_CARGO_CONTAINER_LIFETIME_MS
      : getNextClusterDowntimeAtMs(nowMs);
  const updateResult = updateInventoryItem(itemID, (currentItem) => ({
    ...currentItem,
    expiresAtMs,
    customInfo: stripLegacySecureContainerStateFromCustomInfo(
      currentItem.customInfo,
    ),
    secureContainerState: buildCanonicalSecureContainerState(
      currentItem,
      { anchorState: finalAnchorState },
    ),
  }));
  if (!updateResult.success || !updateResult.data) {
    return updateResult;
  }

  clearSecureContainerAnchorTimer(itemID);
  syncInventoryChange(
    options.session || null,
    updateResult.data,
    updateResult.previousData || item,
  );
  if (options.refreshPresentation !== false) {
    refreshSecureContainerAnchorPresentation(updateResult.data);
  }
  log.info(
    `[CargoContainer] item=${itemID} anchorState=${finalAnchorState}`,
  );
  return {
    success: true,
    data: updateResult.data,
    completed: Boolean(completesAtMs),
    recovered: !completesAtMs,
  };
}

function startSecureContainerAnchorTransition(
  session,
  itemID,
  effectName,
  options = {},
) {
  const context = getSessionContext(session);
  const numericItemID = toInt(itemID, 0);
  const normalizedEffectName = String(effectName || "").trim().toLowerCase();
  const isAnchorDrop = normalizedEffectName === "anchordrop";
  const isAnchorLift = normalizedEffectName === "anchorlift";
  if (!isAnchorDrop && !isAnchorLift) {
    return {
      success: false,
      errorMsg: "INVALID_ANCHOR_EFFECT",
    };
  }

  const nowMs = Math.max(0, toInt(options.nowMs, Date.now()));
  let item = findItemById(numericItemID);
  if (!item) {
    return {
      success: false,
      errorMsg: "ITEM_NOT_FOUND",
    };
  }
  if (!isAnchorableSecureContainerType(item)) {
    return {
      success: false,
      errorMsg: "ITEM_NOT_ANCHORABLE_CONTAINER",
    };
  }

  const reconciliation = reconcileSecureContainerAnchorState(item, {
    nowMs,
    session,
    schedule: false,
  });
  if (!reconciliation.success) {
    return reconciliation;
  }
  item = findItemById(numericItemID);

  const accessError = validateCargoContainerSpaceAccess(
    session,
    item,
    context,
  );
  if (accessError) {
    return {
      success: false,
      errorMsg: accessError,
    };
  }
  if (toInt(item.ownerID, 0) !== context.characterID) {
    return {
      success: false,
      errorMsg: "CONTAINER_OWNER_REQUIRED",
    };
  }

  const requirement = getSecureContainerAnchorSkillRequirement(item);
  if (
    getCharacterSkillLevel(context.characterID, requirement.skillTypeID) <
    requirement.skillLevel
  ) {
    return {
      success: false,
      errorMsg: "ANCHORING_SKILL_REQUIRED",
      data: requirement,
    };
  }

  const displayedSecurity = getDisplayedSolarSystemSecurity(context.systemID);
  if (displayedSecurity === null) {
    return {
      success: false,
      errorMsg: "SOLAR_SYSTEM_DATA_UNAVAILABLE",
    };
  }
  if (displayedSecurity > MAX_SECURE_CONTAINER_ANCHOR_SECURITY) {
    return {
      success: false,
      errorMsg: "SOLAR_SYSTEM_SECURITY_TOO_HIGH",
      data: { displayedSecurity },
    };
  }

  const state = getSecureContainerState(item);
  if (
    state.anchorState === SECURE_CONTAINER_ANCHOR_STATE.ANCHORING ||
    state.anchorState === SECURE_CONTAINER_ANCHOR_STATE.UNANCHORING
  ) {
    return {
      success: false,
      errorMsg: "CONTAINER_ANCHOR_TRANSITION_IN_PROGRESS",
    };
  }
  if (
    isAnchorDrop &&
    state.anchorState !== SECURE_CONTAINER_ANCHOR_STATE.UNANCHORED
  ) {
    return {
      success: false,
      errorMsg: "CONTAINER_ALREADY_ANCHORED",
    };
  }
  if (
    isAnchorLift &&
    state.anchorState !== SECURE_CONTAINER_ANCHOR_STATE.ANCHORED
  ) {
    return {
      success: false,
      errorMsg: "CONTAINER_NOT_ANCHORED",
    };
  }

  const delayMs = getSecureContainerAnchorDelayMs(item);
  const anchorState = isAnchorDrop
    ? SECURE_CONTAINER_ANCHOR_STATE.ANCHORING
    : SECURE_CONTAINER_ANCHOR_STATE.UNANCHORING;
  const completesAtMs = nowMs + delayMs;
  const updateResult = updateInventoryItem(numericItemID, (currentItem) => ({
    ...currentItem,
    customInfo: stripLegacySecureContainerStateFromCustomInfo(
      currentItem.customInfo,
    ),
    secureContainerState: buildCanonicalSecureContainerState(
      currentItem,
      {
        anchorState,
        anchorStartedAtMs: nowMs,
        anchorCompletesAtMs: completesAtMs,
      },
    ),
  }));
  if (!updateResult.success || !updateResult.data) {
    return updateResult;
  }

  syncInventoryChange(
    session,
    updateResult.data,
    updateResult.previousData || item,
  );
  if (options.schedule !== false) {
    scheduleSecureContainerAnchorReconciliation(
      numericItemID,
      completesAtMs,
      session,
    );
  }
  if (options.refreshPresentation !== false) {
    refreshSecureContainerAnchorPresentation(updateResult.data);
  }
  log.info(
    `[CargoContainer] char=${context.characterID} item=${numericItemID} ` +
    `anchorState=${anchorState} completesAtMs=${completesAtMs}`,
  );
  return {
    success: true,
    data: {
      itemID: numericItemID,
      anchorState,
      anchorStartedAtMs: nowMs,
      anchorCompletesAtMs: completesAtMs,
      delayMs,
    },
  };
}

function collectContainedItems(containerID) {
  const normalizedContainerID = toInt(containerID, 0);
  if (!normalizedContainerID) {
    return [];
  }

  const descendants = [];
  const pendingContainerIDs = [normalizedContainerID];
  const seenItemIDs = new Set([normalizedContainerID]);
  for (let index = 0; index < pendingContainerIDs.length; index += 1) {
    const currentContainerID = pendingContainerIDs[index];
    for (const child of listContainerItems(null, currentContainerID, null)) {
      const childItemID = toInt(child && child.itemID, 0);
      if (!childItemID || seenItemIDs.has(childItemID)) {
        continue;
      }
      seenItemIDs.add(childItemID);
      descendants.push(child);
      pendingContainerIDs.push(childItemID);
    }
  }
  return descendants;
}

function isRestorableSpaceInventoryItem(context, item) {
  const itemID = toInt(item && item.itemID, 0);
  return Boolean(
    itemID > 0 &&
    toInt(item.locationID, 0) === toInt(context && context.systemID, 0) &&
    toInt(item.flagID, -1) === 0 &&
    item.spaceState &&
    toInt(item.spaceState.systemID, 0) === toInt(context && context.systemID, 0) &&
    isFiniteVector(item.spaceState.position)
  );
}

function inventoryItemsMatch(left, right) {
  return Boolean(
    left &&
    right &&
    toInt(left.itemID, 0) === toInt(right.itemID, 0) &&
    JSON.stringify(left) === JSON.stringify(right)
  );
}

function restoreSpaceEntityAfterFailedScoop(context, originalItem) {
  const itemID = toInt(originalItem && originalItem.itemID, 0);
  let restoredItem = null;
  let restoreResult = null;
  try {
    restoredItem = findItemById(itemID);
  } catch (error) {
    restoreResult = {
      success: false,
      errorMsg: error && error.message || "ROLLBACK_LOOKUP_FAILED",
    };
  }

  if (inventoryItemsMatch(restoredItem, originalItem)) {
    restoreResult = {
      success: true,
      skipped: true,
    };
  } else {
    try {
      restoreResult = itemStore.updateInventoryItem(
        itemID,
        () => ({ ...originalItem }),
      );
    } catch (error) {
      restoreResult = {
        success: false,
        errorMsg: error && error.message || "ROLLBACK_UPDATE_FAILED",
      };
    }
    if (restoreResult && restoreResult.success === true) {
      try {
        restoredItem = findItemById(itemID);
      } catch (error) {
        restoreResult = {
          success: false,
          errorMsg: error && error.message || "ROLLBACK_VERIFY_FAILED",
        };
      }
    }
  }
  const inventoryRestored = isRestorableSpaceInventoryItem(
    context,
    restoredItem,
  );
  if (!inventoryRestored) {
    log.error(
      `[CargoContainer] Failed scoop rollback item=${itemID} ` +
      `inventory=${restoreResult && restoreResult.errorMsg || "state-invalid"} ` +
      "space=not-respawned",
    );
    return {
      inventoryRestored: false,
      entityRestored: false,
    };
  }

  let spawnResult = null;
  try {
    spawnResult = spaceRuntime.spawnDynamicInventoryEntity(
      context.systemID,
      itemID,
      {
        sceneDescriptor: context.sceneDescriptor || undefined,
      },
    );
  } catch (error) {
    spawnResult = {
      success: false,
      errorMsg: error && error.message || "ROLLBACK_SPAWN_FAILED",
    };
  }
  if (!spawnResult || !spawnResult.success) {
    log.error(
      `[CargoContainer] Failed scoop rollback item=${itemID} ` +
      "inventory=ok " +
      `space=${spawnResult && spawnResult.errorMsg || "unknown"}`,
    );
  }
  return {
    inventoryRestored: true,
    entityRestored: Boolean(spawnResult && spawnResult.success === true),
  };
}

function launchCargoContainerFromShip(session, itemID) {
  const context = getSessionContext(session);
  const normalizedItemID = toInt(itemID, 0);
  const item = findItemById(normalizedItemID);
  if (!context.characterID || !context.shipID || !context.systemID) {
    return {
      success: false,
      errorMsg: "INVALID_SESSION",
    };
  }
  if (!item) {
    return {
      success: false,
      errorMsg: "ITEM_NOT_FOUND",
    };
  }
  if (
    !isCargoContainerType(item) ||
    isNonScoopableContainerType(item) ||
    isStationOnlyCargoContainerType(item)
  ) {
    return {
      success: false,
      errorMsg: "ITEM_NOT_DEPLOYABLE_CONTAINER",
    };
  }
  if (toInt(item.ownerID, 0) !== context.characterID) {
    return {
      success: false,
      errorMsg: "ITEM_NOT_OWNED",
    };
  }
  if (
    toInt(item.locationID, 0) !== context.shipID ||
    !isJettisonableShipFlag(item.flagID)
  ) {
    return {
      success: false,
      errorMsg: "ITEM_NOT_IN_ACTIVE_SHIP",
    };
  }

  const shipEntity = spaceRuntime.getEntity(session, context.shipID);
  if (!shipEntity || shipEntity.kind !== "ship") {
    return {
      success: false,
      errorMsg: "SHIP_NOT_VISIBLE",
    };
  }
  const launchScene = typeof spaceRuntime.getSceneForSession === "function"
    ? spaceRuntime.getSceneForSession(session)
    : null;
  const launchScope = resolveAbyssalPlayerLaunchScope(
    session,
    shipEntity,
    launchScene,
  );
  if (launchScope.valid !== true) {
    return {
      success: false,
      errorMsg: "ABYSSAL_LAUNCH_SCOPE_INVALID",
    };
  }
  const shipPosition = normalizeVector(shipEntity.position);
  const rawDirection = normalizeVector(
    shipEntity.direction,
    { x: 1, y: 0, z: 0 },
  );
  const directionLength = Math.sqrt(
    (rawDirection.x ** 2) +
    (rawDirection.y ** 2) +
    (rawDirection.z ** 2),
  );
  const direction =
    Number.isFinite(directionLength) && directionLength > 0
      ? {
          x: rawDirection.x / directionLength,
          y: rawDirection.y / directionLength,
          z: rawDirection.z / directionLength,
        }
      : { x: 1, y: 0, z: 0 };
  const launchDistance =
    Math.max(0, toReal(shipEntity.radius, 0)) + 275;
  const position = {
    x: shipPosition.x + (direction.x * launchDistance),
    y: shipPosition.y + (direction.y * launchDistance),
    z: shipPosition.z + (direction.z * launchDistance),
  };
  const simTimeMs = spaceRuntime.getSimulationTimeMsForSession(
    session,
    Date.now(),
  );
  const lootContext = getCargoContainerSessionLootContext(
    session,
    context.characterID,
  );
  const launchState = {
    ...buildChildEntityScopeMetadata(shipEntity),
    ...launchScope.metadata,
    systemID: context.systemID,
    position,
    velocity: { x: 0, y: 0, z: 0 },
    direction,
    targetPoint: position,
    mode: "STOP",
    speedFraction: 0,
  };

  // A container in space is always assembled, and TQ's client gives the player
  // no way to get there by hand while undocked: OfferAssembleContainer is
  // docked-only (clientcodegrabber/latest/menucheckers/itemCheckers.py:80-91)
  // while both ship-cargo launch entries -- OfferLaunchForSelf_Container
  // (:478-485, routed to Ship.Jettison) and OfferLaunchForSelf (:455-476,
  // routed to Ship.Drop) -- deliberately omit the IsSingleton() gate the same
  // file applies wherever assembly really is a precondition (OfferOpenContainer
  // :594, OfferLaunchContainerFromContainerInSpace :420). So the launch owns the
  // assembly, exactly as launchMobileDepotFromShip already does for a packaged
  // deployable. Refusing here left a packaged container with no working action
  // at all.
  //
  // A stack yields a single container: eveMisc.LaunchFromShip clamps the
  // packaged branch to (itemID, min(quantity, 1)) for this menu entry
  // (eve/client/script/ui/services/menusvc.py:353), and assembleInventoryItem
  // does the split -- the remainder stays packaged in the hold and the launched
  // unit gets its own itemID.
  let launchItem = item;
  if (
    toInt(item.singleton, 0) !== 1 ||
    Math.max(1, toInt(item.stacksize ?? item.quantity, 1)) !== 1
  ) {
    const assembleResult = itemStore.assembleInventoryItem(item.itemID, {
      resetInstanceState: true,
    });
    if (
      !assembleResult ||
      !assembleResult.success ||
      !assembleResult.data ||
      !assembleResult.data.assembledItem
    ) {
      return {
        success: false,
        errorMsg:
          (assembleResult && assembleResult.errorMsg) ||
          "CONTAINER_ASSEMBLY_FAILED",
      };
    }
    launchItem = assembleResult.data.assembledItem;
    for (const change of assembleResult.data.changes || []) {
      if (!change || !change.item) {
        continue;
      }
      syncInventoryChange(session, change.item, change.previousData || {});
    }
  }

  const updateResult = updateInventoryItem(launchItem.itemID, (currentItem) => {
    const baseCustomInfo = isSecureCargoContainerType(currentItem)
      ? stripLegacySecureContainerStateFromCustomInfo(
        currentItem.customInfo,
      )
      : currentItem.customInfo;
    const secureLifecycleUpdate = isSecureCargoContainerType(currentItem)
      ? {
          secureContainerState: buildCanonicalSecureContainerState(
            currentItem,
            { anchorState: SECURE_CONTAINER_ANCHOR_STATE.UNANCHORED },
          ),
        }
      : {};
    return {
      ...currentItem,
      ...secureLifecycleUpdate,
      customInfo: buildCargoContainerLootCustomInfo(
        baseCustomInfo,
        lootContext,
      ),
      locationID: context.systemID,
      flagID: 0,
      singleton: 1,
      createdAtMs: simTimeMs,
      expiresAtMs: getNextClusterDowntimeAtMs(simTimeMs),
      launcherID: context.shipID,
      spaceRadius: null,
      spaceState: launchState,
    };
  });
  if (!updateResult.success || !updateResult.data) {
    return updateResult;
  }

  const spawnResult = spaceRuntime.spawnDynamicInventoryEntity(
    context.systemID,
    launchItem.itemID,
    {
      sceneDescriptor: context.sceneDescriptor || undefined,
    },
  );
  if (!spawnResult || !spawnResult.success) {
    // Rolls the container back into the hold as it stood immediately before the
    // launch write, which after an auto-assemble means assembled rather than
    // packaged. That is a legitimate hold state the player can re-launch or
    // repackage; unwinding the split as well would have to re-merge the stack.
    const rollbackResult = updateInventoryItem(
      launchItem.itemID,
      () => updateResult.previousData || launchItem,
    );
    if (rollbackResult.success) {
      syncInventoryChange(
        session,
        rollbackResult.data,
        rollbackResult.previousData || updateResult.data,
      );
    }
    return {
      success: false,
      errorMsg:
        spawnResult && spawnResult.errorMsg
          ? spawnResult.errorMsg
          : "SPACE_SPAWN_FAILED",
      rollback: rollbackResult,
    };
  }

  if (isSecureCargoContainerType(updateResult.data)) {
    clearSecureContainerAnchorTimer(launchItem.itemID);
  }
  syncInventoryChange(
    session,
    updateResult.data,
    updateResult.previousData || launchItem,
  );
  log.info(
    `[CargoContainer] char=${context.characterID} launched ` +
    `container=${launchItem.itemID} system=${context.systemID} ` +
    `source=${item.itemID} ship=${context.shipID}`,
  );
  return {
    success: true,
    data: {
      itemID: launchItem.itemID,
      sourceItemID: item.itemID,
      systemID: context.systemID,
      entity: spawnResult.data && spawnResult.data.entity || null,
    },
  };
}

function scoopSpaceItemToShipHold(
  session,
  itemID,
  destinationFlagID,
  password = "",
) {
  const context = getSessionContext(session);
  const normalizedItemID = toInt(itemID, 0);
  const normalizedDestinationFlagID = toInt(destinationFlagID, 0);
  let item = findItemById(normalizedItemID);
  const accessError = validateCargoContainerSpaceAccess(session, item, context);
  if (accessError) {
    return {
      success: false,
      errorMsg: accessError,
    };
  }

  // Settle any elapsed anchor timer first so a finished unanchor releases the
  // container instead of leaving a stale transition state blocking the scoop.
  if (isAnchorableSecureContainerType(item)) {
    reconcileSecureContainerAnchorState(item, {
      session,
      schedule: false,
    });
    item = findItemById(normalizedItemID) || item;
  }
  if (require("../industry/starbaseIndustryRuntime").hasUnfinishedAssemblyJobs(item)) {
    return { success: false, errorMsg: "STARBASE_INDUSTRY_JOBS_ACTIVE" };
  }
  if (isScoopableStarbaseStructureType(item)) {
    if (isControlTowerType(item)) {
      require(path.join(__dirname, "./controlTowerRuntime"))
        .reconcileControlTowerAnchorState(item.itemID, {
          session,
          schedule: false,
          refreshPresentation: false,
        });
    } else {
      require(path.join(__dirname, "../starbase/starbaseModuleRuntime"))
        .reconcileStarbaseModule(item.itemID, {
          nowMs: Date.now(),
          schedule: false,
          refreshPresentation: false,
        });
    }
    item = findItemById(normalizedItemID) || item;
  }
  if (isCargoContainerAnchorLocked(item)) {
    return {
      success: false,
      errorMsg: "CONTAINER_ANCHORED",
    };
  }

  if (!isSecureContainerPasswordSatisfied(item, password)) {
    return {
      success: false,
      errorMsg: "SECURE_CONTAINER_PASSWORD_REQUIRED",
    };
  }

  // Swallowing a whole can is theft on the same terms as dragging one item out
  // of it, so it answers to the same loot rights and the same crimewatch
  // verdict: refused under green safety, suspect timer otherwise. Capture the
  // rights before the scoop rewrites ownerID and strips the loot metadata.
  const lootAccess = isCargoContainerType(item)
    ? evaluateSpaceLootAccess(session, buildSpaceLootSourceFromItem(item))
    : null;
  if (lootAccess && !lootAccess.success) {
    return {
      success: false,
      errorMsg: lootAccess.errorMsg || "SafetyActivated",
    };
  }

  const destinationError = validateScoopDestination(
    item,
    context,
    normalizedDestinationFlagID,
  );
  if (destinationError) {
    return {
      success: false,
      errorMsg: destinationError,
    };
  }

  let containedItems = [];
  try {
    containedItems = collectContainedItems(item.itemID);
  } catch (error) {
    return {
      success: false,
      errorMsg: error && error.message || "SCOOP_CONTENT_LOOKUP_FAILED",
    };
  }

  let theftSettlement = null;
  if (lootAccess && lootAccess.requiresSuspectTimer) {
    theftSettlement = recordSpaceLootTheft(session, lootAccess);
    if (theftSettlement.errorMsg) {
      log.warn(
        `[CargoContainer] Refusing scoop because the theft consequence ` +
        `could not be persisted char=${context.characterID} ` +
        `container=${item.itemID} error=${theftSettlement.errorMsg}`,
      );
      return {
        success: false,
        errorMsg: "CRIMEWATCH_CONSEQUENCE_PERSIST_FAILED",
      };
    }
  }

  let removeResult = null;
  try {
    removeResult = spaceRuntime.removeDynamicEntity(
      context.systemID,
      item.itemID,
      {
        persistSpaceState: false,
        sceneDescriptor: context.sceneDescriptor || undefined,
      },
    );
  } catch (error) {
    removeResult = {
      success: false,
      errorMsg: error && error.message || "DYNAMIC_ENTITY_REMOVE_FAILED",
    };
  }
  if (!removeResult || !removeResult.success) {
    const compensation = compensateSpaceLootTheft(session, theftSettlement);
    if (compensation.errorMsg) {
      log.warn(
        `[CargoContainer] Failed to compensate rejected scoop theft ` +
        `char=${context.characterID} container=${item.itemID} ` +
        `error=${compensation.errorMsg}`,
      );
    }
    return {
      success: false,
      errorMsg: removeResult ? removeResult.errorMsg : "DYNAMIC_ENTITY_NOT_FOUND",
    };
  }

  let updateResult = null;
  try {
    const scoopItemIDs = [
      normalizedItemID,
      ...containedItems.map((containedItem) => containedItem.itemID),
    ];
    updateResult = itemStore.updateInventoryItemsAtomic(
      scoopItemIDs,
      (currentItem) => {
        if (toInt(currentItem && currentItem.itemID, 0) !== normalizedItemID) {
          return {
            ...currentItem,
            ownerID: context.characterID,
          };
        }
        const baseCustomInfo = isSecureCargoContainerType(currentItem)
          ? stripLegacySecureContainerStateFromCustomInfo(
            currentItem.customInfo,
          )
          : currentItem.customInfo;
        const secureLifecycleUpdate = isSecureCargoContainerType(currentItem)
          ? {
              secureContainerState: buildCanonicalSecureContainerState(
                currentItem,
                { anchored: false },
              ),
            }
          : {};
        return {
          ...currentItem,
          ...secureLifecycleUpdate,
          customInfo: stripCargoContainerLootCustomInfo(baseCustomInfo),
          ownerID: context.characterID,
          locationID: context.shipID,
          flagID: normalizedDestinationFlagID,
          singleton: 1,
          expiresAtMs: null,
          spaceRadius: null,
          spaceState: null,
        };
      },
    );
  } catch (error) {
    updateResult = {
      success: false,
      errorMsg: error && error.message || "SCOOP_UPDATE_FAILED",
    };
  }
  if (
    !updateResult ||
    !updateResult.success ||
    !updateResult.data ||
    !Array.isArray(updateResult.changes)
  ) {
    const compensation = compensateSpaceLootTheft(session, theftSettlement);
    if (compensation.errorMsg) {
      log.warn(
        `[CargoContainer] Failed to compensate rolled-back scoop theft ` +
        `char=${context.characterID} container=${item.itemID} ` +
        `error=${compensation.errorMsg}`,
      );
    }
    return {
      ...(
        updateResult || {
          success: false,
          errorMsg: "SCOOP_UPDATE_FAILED",
        }
      ),
      rollback: restoreSpaceEntityAfterFailedScoop(context, item),
    };
  }

  const theftCommit = commitSpaceLootTheft(session, theftSettlement);
  if (theftCommit.errorMsg) {
    // The prepared receipt is already a durable active contribution. Custody
    // succeeded, so leave it prepared (fail closed) instead of risking a false
    // unflagged scoop through compensation.
    log.warn(
      `[CargoContainer] Scoop theft receipt remains prepared after custody ` +
      `char=${context.characterID} container=${item.itemID} ` +
      `error=${theftCommit.errorMsg}`,
    );
  }

  for (const change of updateResult.changes) {
    if (!change || change.removed === true || !change.item) {
      continue;
    }
    syncInventoryChange(session, change.item, change.previousData || {});
  }

  log.info(
    `[CargoContainer] char=${context.characterID} scooped container=${item.itemID} ` +
    `system=${context.systemID} ship=${context.shipID} flag=${normalizedDestinationFlagID}`,
  );

  return {
    success: true,
    data: {
      itemID: item.itemID,
    },
  };
}

function scoopCargoContainerToCargo(session, itemID, password = "") {
  return scoopSpaceItemToShipHold(
    session,
    itemID,
    ITEM_FLAGS.CARGO_HOLD,
    password,
  );
}

function scoopCargoContainerToFleetHangar(session, itemID, password = "") {
  return scoopSpaceItemToShipHold(
    session,
    itemID,
    ITEM_FLAGS.FLEET_HANGAR,
    password,
  );
}

module.exports = {
  CATEGORY_CELESTIAL,
  GROUP_CARGO_CONTAINER,
  GROUP_SECURE_CARGO_CONTAINER,
  GROUP_FORCE_FIELD,
  GROUP_AUDIT_LOG_SECURE_CONTAINER,
  GROUP_FREIGHT_CONTAINER,
  CARGO_CONTAINER_FAMILY,
  TYPE_CARGO_CONTAINER,
  TYPE_HANGAR_CONTAINER,
  TYPE_PLANETARY_LAUNCH_CONTAINER,
  TYPE_STATION_CONTAINER,
  TYPE_STATION_VAULT_CONTAINER,
  TYPE_STATION_WAREHOUSE_CONTAINER,
  SCC_PASSWORD_TYPE_GENERAL,
  SCC_PASSWORD_TYPE_CONFIG,
  ALSC_PASSWORD_NEEDED_TO_OPEN,
  ALSC_PASSWORD_NEEDED_TO_LOCK,
  ALSC_PASSWORD_NEEDED_TO_UNLOCK,
  ALSC_PASSWORD_NEEDED_TO_VIEW_AUDIT_LOG,
  ALSC_LOCK_ADDED_ITEMS,
  ALSC_CONFIG_MASK,
  SECURE_CONTAINER_PASSWORD_MAX_LENGTH,
  SECURE_CONTAINER_PASSWORD_MIN_LENGTH,
  EFFECT_ANCHOR_DROP,
  EFFECT_ANCHOR_LIFT,
  TYPE_ANCHORING,
  DEFAULT_SECURE_CONTAINER_ANCHOR_DELAY_MS,
  MAX_SECURE_CONTAINER_ANCHOR_SECURITY,
  ANCHORED_CARGO_CONTAINER_LIFETIME_MS,
  SECURE_CONTAINER_ANCHOR_STATE,
  RUNTIME_UNANCHORED_STRUCTURE_HULL_KIND,
  MAX_CARGO_CONTAINER_TRANSFER_DISTANCE_METERS,
  MAX_STARBASE_STRUCTURE_OPERATION_DISTANCE_METERS,
  getCargoContainerFamily,
  isCargoContainerType,
  isNonScoopableContainerType,
  isUnanchoredStructureHullItem,
  isScoopableCargoContainerType,
  isScoopableSpaceItem,
  isScoopableStarbaseStructureType,
  isStarbaseCorporateHangarArrayType,
  isSecureCargoContainerType,
  isStationOnlyCargoContainerType,
  isAnchorableSecureContainerType,
  isDirectSpaceReusableCargoContainer,
  reconcileCargoContainerLifecycleExpiry,
  touchAnchoredCargoContainerContents,
  getSecureContainerAnchorDelayMs,
  getSecureContainerState,
  buildCanonicalSecureContainerState,
  stripLegacySecureContainerStateFromCustomInfo,
  reconcileSecureContainerAnchorState,
  startSecureContainerAnchorTransition,
  launchCargoContainerFromShip,
  scoopCargoContainerToCargo,
  scoopCargoContainerToFleetHangar,
  _testing: {
    parseCustomInfo,
    getLegacySecureContainerState,
    getDisplayedSolarSystemSecurity,
    parseClusterDowntimeStartsUtc,
    getNextClusterDowntimeAtMs,
    getSecureContainerAnchorSkillRequirement,
    refreshSecureContainerAnchorPresentation,
    isCargoContainerAnchorLocked,
    isSecureContainerPasswordSatisfied,
    clearSecureContainerAnchorTimer,
    clearSecureContainerAnchorTimers,
    scheduleSecureContainerAnchorReconciliation,
    collectContainedItems,
    restoreSpaceEntityAfterFailedScoop,
  },
};
