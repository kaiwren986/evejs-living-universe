"use strict";

const path = require("path");

const log = require(path.join(__dirname, "../../utils/logger"));
const {
  createSpaceItemForOwner,
  ITEM_FLAGS,
  findItemById,
  listContainerItems,
  listStarbaseForceFieldItems,
  removeInventoryItem,
  updateInventoryItem: persistInventoryItem,
} = require(path.join(__dirname, "../inventory/itemStore"));
const {
  TABLE,
  readStaticTable,
} = require(path.join(__dirname, "../_shared/referenceData"));
const {
  getCachedCharacterSkillMap,
} = require(path.join(__dirname, "../skills/skillState"));
const {
  canEntitiesInteractLocally,
} = require(path.join(
  __dirname,
  "../../space/destiny/identity/interactionScope",
));
const {
  buildStarbaseHarmonicUpdates,
} = require(path.join(
  __dirname,
  "../../space/destiny/commands/starbaseForceField",
));
const {
  resolveItemByTypeID,
} = require(path.join(__dirname, "../inventory/itemTypeRegistry"));
const starbaseAnchoringPolicy = require(path.join(
  __dirname,
  "../starbase/starbaseAnchoringPolicy",
));

function updateInventoryItem(itemID, updater) {
  const before = findItemById(itemID);
  const result = persistInventoryItem(itemID, updater);
  if (result.success) require("../starbase/starbaseTravelRuntime").notifyInfrastructureChanged(result.data);
  if (result.success && (before?.spaceState?.onlineState !== result.data?.spaceState?.onlineState ||
      before?.spaceState?.anchorState !== result.data?.spaceState?.anchorState)) {
    require("../starbase/starbaseProductionCycles").invalidateProductionForItem(result.data);
  }
  return result;
}

const CATEGORY_STARBASE = 23;
const GROUP_CONTROL_TOWER = 365;
const GROUP_FORCE_FIELD = 411;
const TYPE_FORCE_FIELD = 16103;
const TYPE_ANCHORING = 11584;
const EFFECT_ONLINE_FOR_STRUCTURES = 901;
const EFFECT_ANCHOR_DROP_FOR_STRUCTURES = 1022;
const EFFECT_ANCHOR_LIFT_FOR_STRUCTURES = 1023;
const ATTRIBUTE_ANCHORING_DELAY = 556;
const ATTRIBUTE_UNANCHORING_DELAY = 676;
const ATTRIBUTE_ONLINING_DELAY = 677;
const ATTRIBUTE_POS_CONTROL_TOWER_PERIOD = 722;
const ATTRIBUTE_CONTROL_TOWER_SIZE = 1031;
const ATTRIBUTE_SHIELD_RADIUS = 680;
const DEFAULT_CONTROL_TOWER_ANCHOR_DELAY_MS = 30 * 60 * 1000;
const DEFAULT_CONTROL_TOWER_UNANCHOR_DELAY_MS = 60 * 60 * 1000;
const DEFAULT_CONTROL_TOWER_ONLINE_DELAY_MS = 30 * 60 * 1000;
const DEFAULT_CONTROL_TOWER_FUEL_PERIOD_MS = 60 * 60 * 1000;
const CONTROL_TOWER_CHARTER_SECURITY_THRESHOLD = 0.45;
const MAX_CONTROL_TOWER_INTERACTION_DISTANCE_METERS = 30000;
const MAX_TIMER_DELAY_MS = 2147000000;
const CONTROL_TOWER_FORCE_FIELD_MARKER_PREFIX = "evejs:control-tower-force-field:";

const CONTROL_TOWER_FUEL_BLOCK_BY_RACE_ID = Object.freeze({
  1: 4051, // Caldari: Nitrogen Fuel Block
  2: 4246, // Minmatar: Hydrogen Fuel Block
  4: 4247, // Amarr: Helium Fuel Block
  8: 4312, // Gallente: Oxygen Fuel Block
});

const CONTROL_TOWER_CHARTER_BY_FACTION_ID = Object.freeze({
  500001: 24593, // Caldari State
  500002: 24595, // Minmatar Republic
  500003: 24592, // Amarr Empire
  500004: 24594, // Gallente Federation
  500007: 24597, // Ammatar Mandate
  500008: 24596, // Khanid Kingdom
});

const CONTROL_TOWER_ANCHOR_STATE = Object.freeze({
  UNANCHORED: "unanchored",
  ANCHORING: "anchoring",
  ANCHORED: "anchored",
  UNANCHORING: "unanchoring",
});

const CONTROL_TOWER_ONLINE_STATE = Object.freeze({
  OFFLINE: "offline",
  ONLINING: "onlining",
  ONLINE: "online",
});

// These are the legacy POS state values consumed by the retail context-menu
// checkers. A tower that is anchoring already reports Anchored and has a fixed
// destiny ball, while one that is fully unanchored reports Unanchored.
const CONTROL_TOWER_POS_STATE = Object.freeze({
  UNANCHORED: 0,
  ANCHORED: 1,
  ONLINING: 2,
  REINFORCED: 3,
  ONLINE: 4,
});

const controlTowerAnchorTimers = new Map();
const controlTowerOnlineTimers = new Map();

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function normalizeTimestamp(value) {
  const numeric = toInt(value, 0);
  return numeric > 0 ? numeric : null;
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
  if (!isFiniteVector(left) || !isFiniteVector(right)) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.sqrt(
    ((Number(left.x) - Number(right.x)) ** 2) +
    ((Number(left.y) - Number(right.y)) ** 2) +
    ((Number(left.z) - Number(right.z)) ** 2),
  );
}

function getSpaceRuntime() {
  // Loaded lazily so space-runtime hydration can reconcile persisted tower
  // transitions without creating a module initialization cycle.
  return require(path.join(__dirname, "../../space/runtime"));
}

function getWorldData() {
  return require(path.join(__dirname, "../../space/worldData"));
}

function getSyncInventoryItemForSession() {
  return require(path.join(__dirname, "../character/characterState"))
    .syncInventoryItemForSession;
}

function getStarbaseFuelRuntime() {
  return require(path.join(__dirname, "../starbase/starbaseFuelRuntime"));
}

function isControlTowerType(item) {
  return Boolean(
    item &&
    toInt(item.categoryID, 0) === CATEGORY_STARBASE &&
    toInt(item.groupID, 0) === GROUP_CONTROL_TOWER,
  );
}

function getTypeDogmaRecord(typeID) {
  const root = readStaticTable(TABLE.TYPE_DOGMA) || {};
  return root.typesByTypeID && root.typesByTypeID[String(toInt(typeID, 0))] || null;
}

function getTypeDogmaAttributeValue(typeID, attributeID, fallback) {
  const record = getTypeDogmaRecord(typeID);
  const rawValue = record && record.attributes && record.attributes[String(attributeID)];
  const numericValue = Number(rawValue);
  return Number.isFinite(numericValue) ? numericValue : fallback;
}

function typeHasDogmaEffect(typeID, effectID) {
  const record = getTypeDogmaRecord(typeID);
  return Boolean(
    record &&
    Array.isArray(record.effects) &&
    record.effects.includes(toInt(effectID, 0)),
  );
}

function isAnchorableControlTowerType(item) {
  return Boolean(
    isControlTowerType(item) &&
    typeHasDogmaEffect(item.typeID, EFFECT_ANCHOR_DROP_FOR_STRUCTURES) &&
    typeHasDogmaEffect(item.typeID, EFFECT_ANCHOR_LIFT_FOR_STRUCTURES),
  );
}

function normalizeControlTowerAnchorState(value, isAnchored = false) {
  const normalized = String(value || "").trim().toLowerCase();
  return Object.values(CONTROL_TOWER_ANCHOR_STATE).includes(normalized)
    ? normalized
    : isAnchored
      ? CONTROL_TOWER_ANCHOR_STATE.ANCHORED
      : CONTROL_TOWER_ANCHOR_STATE.UNANCHORED;
}

function getControlTowerAnchorState(item) {
  const spaceState = item && item.spaceState || {};
  const storedIsAnchored =
    spaceState.isAnchored === true ||
    spaceState.isAnchored === 1 ||
    spaceState.isAnchored === "1";
  const anchorState = normalizeControlTowerAnchorState(
    spaceState.anchorState || item && item.anchorState,
    storedIsAnchored,
  );
  const isTransitioning =
    anchorState === CONTROL_TOWER_ANCHOR_STATE.ANCHORING ||
    anchorState === CONTROL_TOWER_ANCHOR_STATE.UNANCHORING;
  const isAnchored = anchorState !== CONTROL_TOWER_ANCHOR_STATE.UNANCHORED;
  const anchorStartedAtMs = isTransitioning
    ? normalizeTimestamp(spaceState.anchorStartedAtMs)
    : null;
  const anchorCompletesAtMs = isTransitioning
    ? normalizeTimestamp(spaceState.anchorCompletesAtMs)
    : null;
  const delayMs =
    anchorStartedAtMs && anchorCompletesAtMs
      ? Math.max(0, anchorCompletesAtMs - anchorStartedAtMs)
      : 0;
  const posState =
    anchorState === CONTROL_TOWER_ANCHOR_STATE.ANCHORING ||
    anchorState === CONTROL_TOWER_ANCHOR_STATE.ANCHORED
      ? CONTROL_TOWER_POS_STATE.ANCHORED
      : CONTROL_TOWER_POS_STATE.UNANCHORED;

  return {
    anchorState,
    isAnchored,
    anchorStartedAtMs,
    anchorCompletesAtMs,
    posState,
    posTimestampMs: anchorStartedAtMs,
    posDelayTimeMs: delayMs,
  };
}

function normalizeControlTowerOnlineState(value, isOnline = false) {
  const normalized = String(value || "").trim().toLowerCase();
  return Object.values(CONTROL_TOWER_ONLINE_STATE).includes(normalized)
    ? normalized
    : isOnline
      ? CONTROL_TOWER_ONLINE_STATE.ONLINE
      : CONTROL_TOWER_ONLINE_STATE.OFFLINE;
}

function getControlTowerOnlineState(item) {
  const spaceState = item && item.spaceState || {};
  const storedIsOnline =
    spaceState.online === true ||
    spaceState.online === 1 ||
    spaceState.online === "1" ||
    item && (
      item.online === true ||
      item.online === 1 ||
      item.online === "1"
    );
  const onlineState = normalizeControlTowerOnlineState(
    spaceState.onlineState || item && item.onlineState,
    storedIsOnline,
  );
  const isOnlining = onlineState === CONTROL_TOWER_ONLINE_STATE.ONLINING;
  const onlineStartedAtMs = isOnlining
    ? normalizeTimestamp(spaceState.onlineStartedAtMs)
    : null;
  const onlineCompletesAtMs = isOnlining
    ? normalizeTimestamp(spaceState.onlineCompletesAtMs)
    : null;
  const delayMs = onlineStartedAtMs && onlineCompletesAtMs
    ? Math.max(0, onlineCompletesAtMs - onlineStartedAtMs)
    : 0;

  return {
    onlineState,
    isOnline: onlineState === CONTROL_TOWER_ONLINE_STATE.ONLINE,
    onlineStartedAtMs,
    onlineCompletesAtMs,
    delayMs,
  };
}

function getControlTowerPresentationState(item) {
  const anchor = getControlTowerAnchorState(item);
  const online = getControlTowerOnlineState(item);

  if (anchor.anchorState !== CONTROL_TOWER_ANCHOR_STATE.ANCHORED) {
    return {
      ...anchor,
      ...online,
      onlineState: CONTROL_TOWER_ONLINE_STATE.OFFLINE,
      isOnline: false,
      online: 0,
    };
  }
  if (online.onlineState === CONTROL_TOWER_ONLINE_STATE.ONLINING) {
    return {
      ...anchor,
      ...online,
      online: 0,
      posState: CONTROL_TOWER_POS_STATE.ONLINING,
      posTimestampMs: online.onlineStartedAtMs,
      posDelayTimeMs: online.delayMs,
    };
  }
  if (online.onlineState === CONTROL_TOWER_ONLINE_STATE.ONLINE) {
    const reinforcement = require("../starbase/starbaseReinforcementRuntime");
    if (reinforcement.isReinforced(item)) {
      return { ...anchor, ...online, online: 1,
        posState: CONTROL_TOWER_POS_STATE.REINFORCED,
        posTimestampMs: reinforcement.getReinforcementState(item).endsAtMs,
        posDelayTimeMs: 0 };
    }
    return {
      ...anchor,
      ...online,
      online: 1,
      posState: CONTROL_TOWER_POS_STATE.ONLINE,
      posTimestampMs: null,
      posDelayTimeMs: 0,
    };
  }
  return {
    ...anchor,
    ...online,
    online: 0,
  };
}

function buildControlTowerSpaceState(item, overrides = {}) {
  const current = getControlTowerAnchorState(item);
  const anchorState = normalizeControlTowerAnchorState(
    Object.prototype.hasOwnProperty.call(overrides, "anchorState")
      ? overrides.anchorState
      : current.anchorState,
    current.isAnchored,
  );
  const isTransitioning =
    anchorState === CONTROL_TOWER_ANCHOR_STATE.ANCHORING ||
    anchorState === CONTROL_TOWER_ANCHOR_STATE.UNANCHORING;
  const currentOnline = getControlTowerOnlineState(item);
  let onlineState = normalizeControlTowerOnlineState(
    Object.prototype.hasOwnProperty.call(overrides, "onlineState")
      ? overrides.onlineState
      : currentOnline.onlineState,
    currentOnline.isOnline,
  );
  if (anchorState !== CONTROL_TOWER_ANCHOR_STATE.ANCHORED) {
    onlineState = CONTROL_TOWER_ONLINE_STATE.OFFLINE;
  }
  const isOnlining = onlineState === CONTROL_TOWER_ONLINE_STATE.ONLINING;
  return {
    ...(item && item.spaceState || {}),
    ...(Object.prototype.hasOwnProperty.call(overrides, "moonID")
      ? { moonID: toInt(overrides.moonID, 0) || null }
      : {}),
    anchorState,
    isAnchored: anchorState !== CONTROL_TOWER_ANCHOR_STATE.UNANCHORED,
    anchorStartedAtMs: isTransitioning
      ? normalizeTimestamp(
        Object.prototype.hasOwnProperty.call(overrides, "anchorStartedAtMs")
          ? overrides.anchorStartedAtMs
          : current.anchorStartedAtMs,
      )
      : null,
    anchorCompletesAtMs: isTransitioning
      ? normalizeTimestamp(
        Object.prototype.hasOwnProperty.call(overrides, "anchorCompletesAtMs")
          ? overrides.anchorCompletesAtMs
          : current.anchorCompletesAtMs,
      )
      : null,
    onlineState,
    online: onlineState === CONTROL_TOWER_ONLINE_STATE.ONLINE ? 1 : 0,
    onlineStartedAtMs: isOnlining
      ? normalizeTimestamp(
        Object.prototype.hasOwnProperty.call(overrides, "onlineStartedAtMs")
          ? overrides.onlineStartedAtMs
          : currentOnline.onlineStartedAtMs,
      )
      : null,
    onlineCompletesAtMs: isOnlining
      ? normalizeTimestamp(
        Object.prototype.hasOwnProperty.call(overrides, "onlineCompletesAtMs")
          ? overrides.onlineCompletesAtMs
          : currentOnline.onlineCompletesAtMs,
      )
      : null,
  };
}

function getControlTowerAnchorDelayMs(item, effectName) {
  const normalizedEffect = String(effectName || "").trim().toLowerCase();
  const isUnanchor = normalizedEffect.includes("lift");
  const timerScale = getControlTowerTimerScale(item);
  return Math.max(
    0,
    toInt(
      getTypeDogmaAttributeValue(
        item && item.typeID,
        isUnanchor ? ATTRIBUTE_UNANCHORING_DELAY : ATTRIBUTE_ANCHORING_DELAY,
        isUnanchor
          ? DEFAULT_CONTROL_TOWER_UNANCHOR_DELAY_MS
          : DEFAULT_CONTROL_TOWER_ANCHOR_DELAY_MS,
      ) * timerScale,
      isUnanchor
        ? DEFAULT_CONTROL_TOWER_UNANCHOR_DELAY_MS
        : DEFAULT_CONTROL_TOWER_ANCHOR_DELAY_MS,
    ),
  );
}

function getControlTowerTimerScale(item) {
  const scale = Number(item && item.spaceState && item.spaceState.posTimerScale);
  return Number.isFinite(scale) && scale > 0 ? scale : 1;
}

function getControlTowerOnlineDelayMs(item) {
  const timerScale = getControlTowerTimerScale(item);
  return Math.max(
    0,
    toInt(
      getTypeDogmaAttributeValue(
        item && item.typeID,
        ATTRIBUTE_ONLINING_DELAY,
        DEFAULT_CONTROL_TOWER_ONLINE_DELAY_MS,
      ) * timerScale,
      DEFAULT_CONTROL_TOWER_ONLINE_DELAY_MS,
    ),
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

function getSessionContext(session) {
  return {
    characterID: toInt(session && (session.characterID || session.charid), 0),
    corporationID: toInt(session && (session.corporationID || session.corpid), 0),
    shipID: toInt(
      session && session._space && session._space.shipID,
      toInt(session && (session.shipID || session.shipid || session.activeShipID), 0),
    ),
    systemID: toInt(
      session && session._space && session._space.systemID,
      toInt(session && (session.solarsystemid2 || session.solarsystemid), 0),
    ),
  };
}

function validateControlTowerAnchorAccess(session, item, context, options = {}) {
  if (!context.characterID || !context.shipID || !context.systemID) {
    return "INVALID_SESSION";
  }
  if (!item) {
    return "ITEM_NOT_FOUND";
  }
  if (!isAnchorableControlTowerType(item)) {
    return "ITEM_NOT_ANCHORABLE_CONTROL_TOWER";
  }
  if (require("../starbase/starbaseDefenseRuntime").hasUnavailableHealth(item)) {
    return "CONTROL_TOWER_INCAPACITATED";
  }
  if (require("../starbase/starbaseReinforcementRuntime").isReinforced(item, options.nowMs ?? Date.now())) {
    return "CONTROL_TOWER_REINFORCED";
  }
  if (
    toInt(item.locationID, 0) !== context.systemID ||
    toInt(item.flagID, -1) !== 0 ||
    !item.spaceState ||
    toInt(item.spaceState.systemID, 0) !== context.systemID ||
    !isFiniteVector(item.spaceState.position)
  ) {
    return "CONTROL_TOWER_NOT_IN_SPACE";
  }
  const authority = starbaseAnchoringPolicy.validateCorporationAuthority(
    session,
    item.ownerID,
    { tower: item, structureID: item.itemID, operation: options.operation || "anchor" },
  );
  if (!authority.success) {
    return authority.errorMsg;
  }

  const spaceRuntime = getSpaceRuntime();
  const scene = spaceRuntime.getSceneForSession(session);
  const shipEntity = spaceRuntime.getEntity(session, context.shipID);
  const towerEntity = scene && scene.getEntityByID(item.itemID);
  if (!scene || !shipEntity || shipEntity.kind !== "ship") {
    return "SHIP_NOT_VISIBLE";
  }
  if (
    !towerEntity ||
    towerEntity.kind !== "starbase" ||
    !canEntitiesInteractLocally(shipEntity, towerEntity)
  ) {
    return "CONTROL_TOWER_NOT_VISIBLE";
  }
  const interactionDistance =
    scene && typeof scene.getEntitySurfaceDistance === "function"
      ? scene.getEntitySurfaceDistance(shipEntity, towerEntity)
      : Math.max(
          0,
          getVectorDistance(shipEntity.position, towerEntity.position) -
            Math.max(0, Number(shipEntity.radius) || 0) -
            Math.max(0, Number(towerEntity.radius) || 0),
        );
  if (
    options.requireInteractionDistance !== false &&
    interactionDistance > MAX_CONTROL_TOWER_INTERACTION_DISTANCE_METERS
  ) {
    return "TARGET_TOO_FAR";
  }
  if (
    options.requireAnchoringSkill !== false &&
    getCharacterSkillLevel(context.characterID, TYPE_ANCHORING) < 1
  ) {
    return "ANCHORING_SKILL_REQUIRED";
  }
  return null;
}

function getControlTowerFuelRequirements(item) {
  if (!isControlTowerType(item)) {
    return null;
  }
  const typeRecord = resolveItemByTypeID(item.typeID);
  const raceID = toInt(item.raceID, toInt(typeRecord && typeRecord.raceID, 0));
  const fuelBlockTypeID = toInt(CONTROL_TOWER_FUEL_BLOCK_BY_RACE_ID[raceID], 0);
  const towerSize = Math.min(
    3,
    Math.max(
      1,
      toInt(
        getTypeDogmaAttributeValue(
          item.typeID,
          ATTRIBUTE_CONTROL_TOWER_SIZE,
          1,
        ),
        1,
      ),
    ),
  );
  const systemID = toInt(
    item.spaceState && item.spaceState.systemID,
    toInt(item.locationID, 0),
  );
  const system = getWorldData().getSolarSystemByID(systemID);
  if (!system) return null;
  const security = Number(
    system && (system.security ?? system.securityStatus),
  );
  // Latest moonmining.py:592-596,625 matches resources against the system's
  // faction, not the constellation/region. Never replace an explicit owner
  // such as CONCORD with the surrounding empire to manufacture a charter.
  const factionID = toInt(system && system.factionID, 0);
  const charterRequired = Number.isFinite(security) &&
    security >= CONTROL_TOWER_CHARTER_SECURITY_THRESHOLD;
  const charterTypeID =
    // controlTowerResources in the target SDE uses 0.45, which covers the
    // rounded 0.5 systems presented by the client without misclassifying 0.4.
    charterRequired
      ? toInt(CONTROL_TOWER_CHARTER_BY_FACTION_ID[factionID], 0)
      : 0;

  return {
    raceID,
    towerSize,
    systemID,
    security: Number.isFinite(security) ? security : null,
    factionID,
    fuelBlockTypeID,
    fuelBlockQuantity: 10 * (2 ** (towerSize - 1)),
    charterRequired,
    charterAvailable: !charterRequired || charterTypeID > 0,
    charterTypeID,
    charterQuantity: charterTypeID > 0 ? 1 : 0,
    fuelPeriodMs: Math.max(
      0,
      toInt(
        getTypeDogmaAttributeValue(
          item.typeID,
          ATTRIBUTE_POS_CONTROL_TOWER_PERIOD,
          DEFAULT_CONTROL_TOWER_FUEL_PERIOD_MS,
        ),
        DEFAULT_CONTROL_TOWER_FUEL_PERIOD_MS,
      ),
    ),
  };
}

function validateControlTowerAnchorSystem(item) {
  const requirements = getControlTowerFuelRequirements(item);
  if (!requirements) {
    return { success: false, errorMsg: "CONTROL_TOWER_SYSTEM_UNAVAILABLE" };
  }
  if (requirements.charterRequired && !requirements.charterAvailable) {
    return {
      success: false,
      errorMsg: "CONTROL_TOWER_CHARTER_UNAVAILABLE",
      data: requirements,
    };
  }
  return { success: true, data: requirements };
}

function getContainerTypeQuantity(containerID, typeID) {
  const numericTypeID = toInt(typeID, 0);
  return listContainerItems(null, containerID, null)
    .filter((entry) => toInt(entry && entry.typeID, 0) === numericTypeID)
    .reduce(
      (total, entry) => total + Math.max(
        0,
        toInt(entry && (entry.stacksize ?? entry.quantity), 0),
      ),
      0,
    );
}

function validateControlTowerAnchorCharter(session, item, requirements = getControlTowerFuelRequirements(item)) {
  if (!requirements || !requirements.charterAvailable) {
    return validateControlTowerAnchorSystem(item);
  }
  if (!requirements.charterRequired) return { success: true, data: requirements };
  const context = getSessionContext(session);
  // The anchor prerequisite is a charter in the active ship's ordinary cargo.
  // It is a presence check only: hourly upkeep consumes fuel after onlining.
  // https://forums-archive.eveonline.com/message/2452094 (post #8)
  const availableQuantity = context.shipID > 0
    ? listContainerItems(null, context.shipID, ITEM_FLAGS.CARGO_HOLD)
      .filter((entry) => toInt(entry.typeID, 0) === requirements.charterTypeID &&
        [context.characterID, toInt(item.ownerID, 0)].includes(toInt(entry.ownerID, 0)))
      .reduce((total, entry) => total + Math.max(0, toInt(entry.stacksize ?? entry.quantity, 0)), 0)
    : 0;
  if (availableQuantity < requirements.charterQuantity) {
    return {
      success: false,
      errorMsg: "CONTROL_TOWER_CHARTER_REQUIRED",
      data: { ...requirements, availableQuantity },
    };
  }
  return { success: true, data: requirements };
}

function validateControlTowerFuel(item) {
  const requirements = getControlTowerFuelRequirements(item);
  if (!requirements || !requirements.fuelBlockTypeID) {
    return {
      success: false,
      errorMsg: "CONTROL_TOWER_FUEL_CONFIGURATION_UNAVAILABLE",
      data: requirements,
    };
  }
  if (requirements.charterRequired && !requirements.charterAvailable) {
    return {
      success: false,
      errorMsg: "CONTROL_TOWER_CHARTER_UNAVAILABLE",
      data: requirements,
    };
  }
  const fuelBlockQuantity = getContainerTypeQuantity(
    item.itemID,
    requirements.fuelBlockTypeID,
  );
  if (fuelBlockQuantity < requirements.fuelBlockQuantity) {
    return {
      success: false,
      errorMsg: "CONTROL_TOWER_FUEL_REQUIRED",
      data: {
        ...requirements,
        availableQuantity: fuelBlockQuantity,
      },
    };
  }
  if (requirements.charterTypeID > 0) {
    const charterQuantity = getContainerTypeQuantity(
      item.itemID,
      requirements.charterTypeID,
    );
    if (charterQuantity < requirements.charterQuantity) {
      return {
        success: false,
        errorMsg: "CONTROL_TOWER_CHARTER_REQUIRED",
        data: {
          ...requirements,
          availableQuantity: charterQuantity,
        },
      };
    }
  }
  return { success: true, data: requirements };
}

function getControlTowerMoon(itemOrID) {
  const item = itemOrID && typeof itemOrID === "object"
    ? itemOrID
    : findItemById(toInt(itemOrID, 0));
  if (!isControlTowerType(item) || !isFiniteVector(item.spaceState && item.spaceState.position)) {
    return null;
  }
  const nearest = starbaseAnchoringPolicy.findNearestMoon(item);
  const persistedMoonID = toInt(item.spaceState && item.spaceState.moonID, 0);
  return nearest
    ? {
        moonID: persistedMoonID || toInt(nearest.moon.itemID, 0),
        distance: nearest.surfaceDistance,
        resources: [],
      }
    : null;
}

function getControlTowerForceFieldTowerID(item) {
  const stateTowerID = toInt(
    item && item.spaceState && item.spaceState.controlTowerID,
    0,
  );
  if (stateTowerID > 0) {
    return stateTowerID;
  }
  const customInfo = String(item && item.customInfo || "");
  if (!customInfo.startsWith(CONTROL_TOWER_FORCE_FIELD_MARKER_PREFIX)) {
    return 0;
  }
  return toInt(customInfo.slice(CONTROL_TOWER_FORCE_FIELD_MARKER_PREFIX.length), 0);
}

function isControlTowerForceFieldItem(item, controlTowerID = 0) {
  if (
    !item ||
    toInt(item.typeID, 0) !== TYPE_FORCE_FIELD ||
    toInt(item.groupID, 0) !== GROUP_FORCE_FIELD
  ) {
    return false;
  }
  const associatedTowerID = getControlTowerForceFieldTowerID(item);
  return associatedTowerID > 0 && (
    toInt(controlTowerID, 0) <= 0 ||
    associatedTowerID === toInt(controlTowerID, 0)
  );
}

function listControlTowerForceFields(itemOrID) {
  const tower = itemOrID && typeof itemOrID === "object"
    ? itemOrID
    : findItemById(toInt(itemOrID, 0));
  if (!isControlTowerType(tower)) {
    return [];
  }
  const systemID = toInt(
    tower.spaceState && tower.spaceState.systemID,
    toInt(tower.locationID, 0),
  );
  if (systemID <= 0) return [];
  const nowMs = Date.now();
  return listStarbaseForceFieldItems({ systemID }).filter((entry) => (
    entry.locationID === systemID && entry.flagID === 0 &&
    (!Number.isFinite(Number(entry.expiresAtMs)) || Number(entry.expiresAtMs) > nowMs) &&
    isControlTowerForceFieldItem(entry, tower.itemID)
  ));
}

function removeControlTowerForceFieldItem(fieldItem, options = {}) {
  if (!isControlTowerForceFieldItem(fieldItem)) {
    return { success: false, errorMsg: "ITEM_NOT_CONTROL_TOWER_FORCE_FIELD" };
  }
  const removeResult = removeInventoryItem(fieldItem.itemID, {
    removeContents: true,
  });
  if (!removeResult.success) {
    return removeResult;
  }
  if (options.updateScene !== false) {
    const systemID = toInt(
      fieldItem.spaceState && fieldItem.spaceState.systemID,
      toInt(fieldItem.locationID, 0),
    );
    const sceneResult = getSpaceRuntime().removeDynamicEntity(
      systemID,
      fieldItem.itemID,
      {
        broadcast: options.broadcast !== false,
        persistSpaceState: false,
      },
    );
    if (
      sceneResult &&
      !sceneResult.success &&
      !["SCENE_NOT_FOUND", "DYNAMIC_ENTITY_NOT_FOUND"].includes(sceneResult.errorMsg)
    ) {
      log.warn(
        `[ControlTower] Force field scene removal failed item=${fieldItem.itemID} ` +
        `error=${sceneResult.errorMsg}`,
      );
    }
  }
  return { success: true, data: removeResult.data };
}

function removeControlTowerForceFields(itemOrID, options = {}) {
  const fields = listControlTowerForceFields(itemOrID);
  const removedItemIDs = [];
  for (const fieldItem of fields) {
    const result = removeControlTowerForceFieldItem(fieldItem, options);
    if (!result.success) {
      return result;
    }
    removedItemIDs.push(fieldItem.itemID);
  }
  return { success: true, data: { removedItemIDs } };
}

function vectorsEqual(left, right) {
  return Boolean(
    isFiniteVector(left) &&
    isFiniteVector(right) &&
    Number(left.x) === Number(right.x) &&
    Number(left.y) === Number(right.y) &&
    Number(left.z) === Number(right.z)
  );
}

function getControlTowerForceFieldSpec(tower) {
  if (!isControlTowerType(tower)) {
    return null;
  }
  const towerID = toInt(tower.itemID, 0);
  const systemID = toInt(
    tower.spaceState && tower.spaceState.systemID,
    toInt(tower.locationID, 0),
  );
  const position = tower.spaceState && tower.spaceState.position;
  if (!towerID || !systemID || !isFiniteVector(position)) {
    return null;
  }
  const access = require("../starbase/starbaseAccessRuntime").getForceFieldAccess(tower);
  return {
    towerID,
    systemID,
    ownerID: toInt(tower.ownerID, 0),
    harmonic: access.harmonic,
    corporationID: access.corporationID,
    allianceID: access.allianceID,
    position: {
      x: Number(position.x),
      y: Number(position.y),
      z: Number(position.z),
    },
    radius: Math.max(
      1,
      Number(getTypeDogmaAttributeValue(
        tower.typeID,
        ATTRIBUTE_SHIELD_RADIUS,
        1,
      )) || 1,
    ),
    customInfo: `${CONTROL_TOWER_FORCE_FIELD_MARKER_PREFIX}${towerID}`,
  };
}

function buildControlTowerForceFieldSpaceState(fieldItem, spec) {
  return {
    ...(fieldItem && fieldItem.spaceState || {}),
    systemID: spec.systemID,
    position: spec.position,
    velocity: { x: 0, y: 0, z: 0 },
    direction: { x: 1, y: 0, z: 0 },
    targetPoint: spec.position,
    speedFraction: 0,
    mode: "FIELD",
    destinyHarmonic: spec.harmonic,
    harmonic: spec.harmonic,
    corporationID: spec.corporationID,
    allianceID: spec.allianceID,
    controlTowerID: spec.towerID,
  };
}

function refreshStarbaseHarmonicPresentation(itemID, access, options = {}) {
  const scene = getSpaceRuntime().findSceneContainingDynamicEntity(itemID);
  const entity = scene && scene.getEntityByID(itemID);
  if (!entity) return { success: true, data: { updated: false } };
  entity.destinyHarmonic = toInt(access.harmonic, -1);
  entity.harmonic = entity.destinyHarmonic;
  if (access.corporationID !== undefined) entity.corporationID = toInt(access.corporationID, -1);
  if (access.allianceID !== undefined) entity.allianceID = toInt(access.allianceID, -1);
  if (options.broadcast !== false) {
    scene.queueBubbleHistory(buildStarbaseHarmonicUpdates({
      scene,
      entityID: itemID,
      harmonic: entity.harmonic,
      corporationID: entity.corporationID,
      allianceID: entity.allianceID,
      isForcefield: options.isForcefield === true,
    }));
  }
  return { success: true, data: { updated: true } };
}

function ensureControlTowerForceField(itemOrID, options = {}) {
  const tower = itemOrID && typeof itemOrID === "object"
    ? itemOrID
    : findItemById(toInt(itemOrID, 0));
  const presentation = getControlTowerPresentationState(tower);
  if (!isControlTowerType(tower) || presentation.isOnline !== true) {
    return { success: false, errorMsg: "CONTROL_TOWER_NOT_ONLINE" };
  }
  const spec = getControlTowerForceFieldSpec(tower);
  if (!spec || !spec.ownerID) {
    return { success: false, errorMsg: "CONTROL_TOWER_FORCE_FIELD_SPEC_INVALID" };
  }

  const fields = listControlTowerForceFields(tower);
  let fieldItem = fields.shift() || null;
  let created = false;
  let accessChanged = false;
  if (!fieldItem) {
    const createResult = createSpaceItemForOwner(
      spec.ownerID,
      spec.systemID,
      { typeID: TYPE_FORCE_FIELD, name: "Force Field" },
      {
        customInfo: spec.customInfo,
        spaceRadius: spec.radius,
        ...buildControlTowerForceFieldSpaceState(null, spec),
      },
    );
    if (!createResult.success || !createResult.data) {
      return createResult;
    }
    fieldItem = createResult.data;
    created = true;
  } else {
    const fieldState = fieldItem.spaceState || {};
    accessChanged = toInt(fieldState.destinyHarmonic, 0) !== spec.harmonic ||
      toInt(fieldState.corporationID, 0) !== spec.corporationID ||
      toInt(fieldState.allianceID, 0) !== spec.allianceID;
    const needsUpdate =
      toInt(fieldItem.ownerID, 0) !== spec.ownerID ||
      toInt(fieldItem.locationID, 0) !== spec.systemID ||
      String(fieldItem.customInfo || "") !== spec.customInfo ||
      Number(fieldItem.spaceRadius) !== spec.radius ||
      toInt(fieldState.controlTowerID, 0) !== spec.towerID ||
      accessChanged ||
      String(fieldState.mode || "") !== "FIELD" ||
      !vectorsEqual(fieldState.position, spec.position);
    if (needsUpdate) {
      const updateResult = updateInventoryItem(fieldItem.itemID, (currentItem) => ({
        ...currentItem,
        ownerID: spec.ownerID,
        locationID: spec.systemID,
        flagID: 0,
        customInfo: spec.customInfo,
        spaceRadius: spec.radius,
        spaceState: buildControlTowerForceFieldSpaceState(currentItem, spec),
      }));
      if (!updateResult.success || !updateResult.data) {
        return updateResult;
      }
      fieldItem = updateResult.data;
    }
  }

  for (const duplicate of fields) {
    const removeResult = removeControlTowerForceFieldItem(duplicate, options);
    if (!removeResult.success) {
      log.warn(
        `[ControlTower] Duplicate force field cleanup failed tower=${spec.towerID} ` +
        `field=${duplicate.itemID} error=${removeResult.errorMsg}`,
      );
    }
  }

  if (options.spawn !== false) {
    const spawnResult = getSpaceRuntime().spawnDynamicInventoryEntity(
      spec.systemID,
      fieldItem.itemID,
      { broadcast: options.broadcast !== false },
    );
    if (!spawnResult.success) {
      return spawnResult;
    }
  }
  if (accessChanged && options.updateScene !== false) {
    refreshStarbaseHarmonicPresentation(fieldItem.itemID, spec, {
      isForcefield: true,
      broadcast: options.broadcast !== false,
    });
  }
  if (created) {
    log.info(
      `[ControlTower] Created force field tower=${spec.towerID} ` +
      `field=${fieldItem.itemID} radius=${spec.radius}`,
    );
  }
  return { success: true, data: { fieldItem, created } };
}

function reconcileControlTowerForceField(itemOrID, options = {}) {
  const tower = itemOrID && typeof itemOrID === "object"
    ? itemOrID
    : findItemById(toInt(itemOrID, 0));
  if (!isControlTowerType(tower)) {
    return { success: false, errorMsg: "ITEM_NOT_CONTROL_TOWER" };
  }
  const presentation = getControlTowerPresentationState(tower);
  return presentation.isOnline
    ? ensureControlTowerForceField(tower, options)
    : removeControlTowerForceFields(tower, options);
}

function syncInventoryChange(session, item, previousData) {
  if (!session || !item) {
    return;
  }
  const syncInventoryItemForSession = getSyncInventoryItemForSession();
  if (typeof syncInventoryItemForSession === "function") {
    syncInventoryItemForSession(
      session,
      item,
      previousData || {},
      { emitCfgLocation: true },
    );
  }
}

function refreshControlTowerAnchorPresentation(item, options = {}) {
  if (!item || !isControlTowerType(item)) {
    return null;
  }
  const systemID = toInt(
    item.spaceState && item.spaceState.systemID,
    toInt(item.locationID, 0),
  );
  if (!systemID || toInt(item.locationID, 0) !== systemID) {
    return null;
  }
  return getSpaceRuntime().refreshInventoryBackedEntityPresentation(
    systemID,
    item.itemID,
    {
      broadcast: options.broadcast !== false,
      excludedSession: options.excludedSession || null,
    },
  );
}

function clearControlTowerAnchorTimer(itemID) {
  const numericItemID = toInt(itemID, 0);
  const timer = controlTowerAnchorTimers.get(numericItemID);
  if (timer) {
    clearTimeout(timer);
    controlTowerAnchorTimers.delete(numericItemID);
  }
}

function clearControlTowerAnchorTimers() {
  for (const itemID of controlTowerAnchorTimers.keys()) {
    clearControlTowerAnchorTimer(itemID);
  }
}

function scheduleControlTowerAnchorReconciliation(itemID, completesAtMs, session = null) {
  const numericItemID = toInt(itemID, 0);
  const numericCompletesAtMs = normalizeTimestamp(completesAtMs);
  clearControlTowerAnchorTimer(numericItemID);
  if (!numericItemID || !numericCompletesAtMs) {
    return false;
  }
  const delayMs = Math.min(
    MAX_TIMER_DELAY_MS,
    Math.max(0, numericCompletesAtMs - Date.now()),
  );
  const timer = setTimeout(() => {
    controlTowerAnchorTimers.delete(numericItemID);
    const result = reconcileControlTowerAnchorState(numericItemID, {
      nowMs: Date.now(),
      session,
      schedule: true,
    });
    if (!result.success) {
      log.warn(
        `[ControlTower] Anchor reconciliation failed item=${numericItemID} ` +
        `error=${result.errorMsg}`,
      );
    }
  }, delayMs);
  if (timer && typeof timer.unref === "function") {
    timer.unref();
  }
  controlTowerAnchorTimers.set(numericItemID, timer);
  return true;
}

function reconcileControlTowerAnchorState(itemOrID, options = {}) {
  const itemID = toInt(
    itemOrID && typeof itemOrID === "object" ? itemOrID.itemID : itemOrID,
    0,
  );
  const item = findItemById(itemID);
  if (!item) {
    clearControlTowerAnchorTimer(itemID);
    return { success: false, errorMsg: "ITEM_NOT_FOUND" };
  }
  if (!isControlTowerType(item)) {
    clearControlTowerAnchorTimer(itemID);
    return { success: false, errorMsg: "ITEM_NOT_CONTROL_TOWER" };
  }

  const state = getControlTowerAnchorState(item);
  const isAnchoring = state.anchorState === CONTROL_TOWER_ANCHOR_STATE.ANCHORING;
  const isUnanchoring = state.anchorState === CONTROL_TOWER_ANCHOR_STATE.UNANCHORING;
  if (!isAnchoring && !isUnanchoring) {
    clearControlTowerAnchorTimer(itemID);
    return { success: true, data: item, completed: false };
  }

  const nowMs = Math.max(0, toInt(options.nowMs, Date.now()));
  if (state.anchorCompletesAtMs && nowMs < state.anchorCompletesAtMs) {
    if (options.schedule !== false) {
      scheduleControlTowerAnchorReconciliation(
        itemID,
        state.anchorCompletesAtMs,
        options.session || null,
      );
    }
    return { success: true, data: item, completed: false };
  }

  const finalAnchorState = isAnchoring
    ? state.anchorCompletesAtMs
      ? CONTROL_TOWER_ANCHOR_STATE.ANCHORED
      : CONTROL_TOWER_ANCHOR_STATE.UNANCHORED
    : state.anchorCompletesAtMs
      ? CONTROL_TOWER_ANCHOR_STATE.UNANCHORED
      : CONTROL_TOWER_ANCHOR_STATE.ANCHORED;
  const updateResult = updateInventoryItem(itemID, (currentItem) => ({
    ...currentItem,
    spaceState: buildControlTowerSpaceState(currentItem, {
      anchorState: finalAnchorState,
      ...(finalAnchorState === CONTROL_TOWER_ANCHOR_STATE.UNANCHORED
        ? { moonID: null }
        : {}),
    }),
  }));
  if (!updateResult.success || !updateResult.data) {
    return updateResult;
  }

  clearControlTowerAnchorTimer(itemID);
  syncInventoryChange(
    options.session || null,
    updateResult.data,
    updateResult.previousData || item,
  );
  if (options.refreshPresentation !== false) {
    refreshControlTowerAnchorPresentation(updateResult.data);
  }
  log.info(`[ControlTower] item=${itemID} anchorState=${finalAnchorState}`);
  return {
    success: true,
    data: updateResult.data,
    completed: Boolean(state.anchorCompletesAtMs),
    recovered: !state.anchorCompletesAtMs,
  };
}

function startControlTowerAnchorTransition(session, itemID, effectName, options = {}) {
  const normalizedEffectName = String(effectName || "").trim().toLowerCase();
  const isAnchorDrop = [
    "anchordropforstructures",
    "effectanchordropforstructures",
    "effects.anchordrop",
    String(EFFECT_ANCHOR_DROP_FOR_STRUCTURES),
  ].includes(normalizedEffectName);
  const isAnchorLift = [
    "anchorliftforstructures",
    "effectanchorliftforstructures",
    "effects.anchorlift",
    String(EFFECT_ANCHOR_LIFT_FOR_STRUCTURES),
  ].includes(normalizedEffectName);
  if (!isAnchorDrop && !isAnchorLift) {
    return { success: false, errorMsg: "INVALID_CONTROL_TOWER_ANCHOR_EFFECT" };
  }

  const numericItemID = toInt(itemID, 0);
  const nowMs = Math.max(0, toInt(options.nowMs, Date.now()));
  let item = findItemById(numericItemID);
  if (!item) {
    return { success: false, errorMsg: "ITEM_NOT_FOUND" };
  }
  if (!isAnchorableControlTowerType(item)) {
    return { success: false, errorMsg: "ITEM_NOT_ANCHORABLE_CONTROL_TOWER" };
  }

  const reconciliation = reconcileControlTowerAnchorState(item, {
    nowMs,
    session,
    schedule: false,
    refreshPresentation: false,
  });
  if (!reconciliation.success) {
    return reconciliation;
  }
  item = findItemById(numericItemID);
  const context = getSessionContext(session);
  const reconciledAnchorState = getControlTowerAnchorState(item);
  const isMatchingTransition =
    (isAnchorDrop &&
      reconciledAnchorState.anchorState === CONTROL_TOWER_ANCHOR_STATE.ANCHORING) ||
    (isAnchorLift &&
      reconciledAnchorState.anchorState === CONTROL_TOWER_ANCHOR_STATE.UNANCHORING);
  const accessError = validateControlTowerAnchorAccess(session, item, context, {
    operation: isAnchorLift ? "unanchor" : "anchor",
    // The retail client calls both posMgr and Dogma for the same operation.
    // Once the first call snaps an anchoring tower to its moon coordinate, the
    // duplicate call is intentionally remote but must remain idempotent.
    requireInteractionDistance: !isMatchingTransition,
  });
  if (accessError) {
    return { success: false, errorMsg: accessError };
  }

  const onlineReconciliation = reconcileControlTowerOnlineState(item, {
    nowMs,
    session,
    schedule: false,
    refreshPresentation: false,
  });
  if (!onlineReconciliation.success) {
    return onlineReconciliation;
  }
  item = findItemById(numericItemID);

  const state = getControlTowerAnchorState(item);
  const onlineState = getControlTowerOnlineState(item);
  if (
    isAnchorLift &&
    onlineState.onlineState !== CONTROL_TOWER_ONLINE_STATE.OFFLINE
  ) {
    return { success: false, errorMsg: "CONTROL_TOWER_MUST_BE_OFFLINE" };
  }
  if (
    (isAnchorDrop && state.anchorState === CONTROL_TOWER_ANCHOR_STATE.ANCHORING) ||
    (isAnchorLift && state.anchorState === CONTROL_TOWER_ANCHOR_STATE.UNANCHORING)
  ) {
    return {
      success: true,
      data: {
        itemID: numericItemID,
        ...state,
        delayMs: state.posDelayTimeMs,
        idempotent: true,
      },
    };
  }
  if (state.anchorState === CONTROL_TOWER_ANCHOR_STATE.ANCHORING ||
      state.anchorState === CONTROL_TOWER_ANCHOR_STATE.UNANCHORING) {
    return { success: false, errorMsg: "CONTROL_TOWER_ANCHOR_TRANSITION_IN_PROGRESS" };
  }
  if (isAnchorDrop && state.anchorState !== CONTROL_TOWER_ANCHOR_STATE.UNANCHORED) {
    return { success: false, errorMsg: "CONTROL_TOWER_ALREADY_ANCHORED" };
  }
  if (isAnchorLift && state.anchorState !== CONTROL_TOWER_ANCHOR_STATE.ANCHORED) {
    return { success: false, errorMsg: "CONTROL_TOWER_NOT_ANCHORED" };
  }
  if (isAnchorLift) {
    const resourceRuntime = require(path.join(
      __dirname,
      "../starbase/starbaseResourceRuntime",
    ));
    const hasAnchoredModules = resourceRuntime.listTowerModules(item)
      .some((module) => {
        const moduleSpaceState = module && module.spaceState || {};
        const moduleAnchorState = String(
          moduleSpaceState.anchorState || "",
        ).toLowerCase();
        return moduleAnchorState
          ? moduleAnchorState !== "unanchored"
          : moduleSpaceState.isAnchored === true || moduleSpaceState.isAnchored === 1;
      });
    if (hasAnchoredModules) {
      return { success: false, errorMsg: "CONTROL_TOWER_HAS_DEPENDENT_MODULES" };
    }
  }
  let placement = null;
  if (isAnchorDrop) {
    const systemValidation = validateControlTowerAnchorSystem(item);
    if (!systemValidation.success) {
      return systemValidation;
    }
    const charterValidation = validateControlTowerAnchorCharter(session, item, systemValidation.data);
    if (!charterValidation.success) return charterValidation;
    placement = starbaseAnchoringPolicy.validateControlTowerPlacement(item);
    if (!placement.success) {
      return placement;
    }
  }

  const canonicalEffectName = isAnchorDrop
    ? "anchorDropForStructures"
    : "anchorLiftForStructures";
  const delayMs = getControlTowerAnchorDelayMs(item, canonicalEffectName);
  const anchorState = isAnchorDrop
    ? CONTROL_TOWER_ANCHOR_STATE.ANCHORING
    : CONTROL_TOWER_ANCHOR_STATE.UNANCHORING;
  const anchorCompletesAtMs = nowMs + delayMs;
  const anchorPosition = placement && isFiniteVector(placement.data.anchorPosition)
    ? {
        x: Number(placement.data.anchorPosition.x),
        y: Number(placement.data.anchorPosition.y),
        z: Number(placement.data.anchorPosition.z),
      }
    : null;
  const updateResult = updateInventoryItem(numericItemID, (currentItem) => ({
    ...currentItem,
    spaceState: {
      ...buildControlTowerSpaceState(currentItem, {
        anchorState,
        anchorStartedAtMs: nowMs,
        anchorCompletesAtMs,
        ...(placement ? { moonID: placement.data.moonID } : {}),
      }),
      ...(anchorPosition
        ? {
            position: anchorPosition,
            targetPoint: anchorPosition,
            velocity: { x: 0, y: 0, z: 0 },
            mode: "STOP",
            speedFraction: 0,
          }
        : {}),
    },
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
    scheduleControlTowerAnchorReconciliation(
      numericItemID,
      anchorCompletesAtMs,
      session,
    );
  }
  if (options.refreshPresentation !== false) {
    refreshControlTowerAnchorPresentation(updateResult.data);
    if (anchorPosition) {
      const systemID = toInt(
        updateResult.data.spaceState && updateResult.data.spaceState.systemID,
        toInt(updateResult.data.locationID, 0),
      );
      const relocation = getSpaceRuntime().teleportDynamicEntityToPoint(
        systemID,
        numericItemID,
        anchorPosition,
        {
          direction:
            updateResult.data.spaceState && updateResult.data.spaceState.direction ||
            { x: 1, y: 0, z: 0 },
        },
      );
      if (
        relocation &&
        relocation.success === false &&
        !["SCENE_NOT_FOUND", "DYNAMIC_ENTITY_NOT_FOUND"].includes(relocation.errorMsg)
      ) {
        log.warn(
          `[ControlTower] Anchor snap presentation failed item=${numericItemID} ` +
          `error=${relocation.errorMsg}`,
        );
      }
    }
  }
  log.info(
    `[ControlTower] char=${context.characterID} corp=${context.corporationID} ` +
    `item=${numericItemID} anchorState=${anchorState} ` +
    `moonID=${toInt(updateResult.data.spaceState && updateResult.data.spaceState.moonID, 0)} ` +
    `completesAtMs=${anchorCompletesAtMs}`,
  );
  return {
    success: true,
    data: {
      itemID: numericItemID,
      anchorState,
      anchorStartedAtMs: nowMs,
      anchorCompletesAtMs,
      delayMs,
      ...(placement ? { moonID: placement.data.moonID } : {}),
      ...(anchorPosition ? { position: anchorPosition } : {}),
    },
  };
}

function clearControlTowerOnlineTimer(itemID) {
  const numericItemID = toInt(itemID, 0);
  const timer = controlTowerOnlineTimers.get(numericItemID);
  if (timer) {
    clearTimeout(timer);
    controlTowerOnlineTimers.delete(numericItemID);
  }
}

function clearControlTowerOnlineTimers() {
  for (const itemID of controlTowerOnlineTimers.keys()) {
    clearControlTowerOnlineTimer(itemID);
  }
  getStarbaseFuelRuntime()._testing.clearFuelTimers();
}

function clearControlTowerRuntimeTimers(itemID) {
  clearControlTowerAnchorTimer(itemID);
  clearControlTowerOnlineTimer(itemID);
}

function scheduleControlTowerOnlineReconciliation(itemID, completesAtMs, session = null) {
  const numericItemID = toInt(itemID, 0);
  const numericCompletesAtMs = normalizeTimestamp(completesAtMs);
  clearControlTowerOnlineTimer(numericItemID);
  if (!numericItemID || !numericCompletesAtMs) {
    return false;
  }
  const delayMs = Math.min(
    MAX_TIMER_DELAY_MS,
    Math.max(0, numericCompletesAtMs - Date.now()),
  );
  const timer = setTimeout(() => {
    controlTowerOnlineTimers.delete(numericItemID);
    const result = reconcileControlTowerOnlineState(numericItemID, {
      nowMs: Date.now(),
      session,
      schedule: true,
    });
    if (!result.success) {
      log.warn(
        `[ControlTower] Online reconciliation failed item=${numericItemID} ` +
        `error=${result.errorMsg}`,
      );
    }
  }, delayMs);
  if (timer && typeof timer.unref === "function") {
    timer.unref();
  }
  controlTowerOnlineTimers.set(numericItemID, timer);
  return true;
}

function reconcileControlTowerOnlineState(itemOrID, options = {}) {
  const itemID = toInt(
    itemOrID && typeof itemOrID === "object" ? itemOrID.itemID : itemOrID,
    0,
  );
  let item = findItemById(itemID);
  if (!item) {
    clearControlTowerOnlineTimer(itemID);
    return { success: false, errorMsg: "ITEM_NOT_FOUND" };
  }
  if (!isControlTowerType(item)) {
    clearControlTowerOnlineTimer(itemID);
    return { success: false, errorMsg: "ITEM_NOT_CONTROL_TOWER" };
  }

  const anchorState = getControlTowerAnchorState(item);
  const state = getControlTowerOnlineState(item);
  if (state.onlineState !== CONTROL_TOWER_ONLINE_STATE.ONLINING) {
    clearControlTowerOnlineTimer(itemID);
    let fuelResult = null;
    if (state.isOnline && options.reconcileFuel !== false) {
      fuelResult = getStarbaseFuelRuntime().reconcileControlTowerFuel(item, {
        nowMs: options.nowMs,
        session: options.session || null,
        schedule: options.schedule !== false,
        refreshPresentation: options.refreshPresentation !== false,
        updateScene: options.updateForceFieldScene !== false,
        broadcast: options.broadcastForceField !== false,
      });
      if (!fuelResult.success) {
        const shutdownResult = getStarbaseFuelRuntime()
          .offlineControlTowerForFuelFailure(item, {
            nowMs: options.nowMs,
            reason: "fuelReconciliationFailed",
            refreshPresentation: options.refreshPresentation !== false,
            updateScene: options.updateForceFieldScene !== false,
            broadcast: options.broadcastForceField !== false,
          });
        const failedItem = shutdownResult.success && shutdownResult.data
          ? shutdownResult.data
          : findItemById(itemID) || item;
        syncInventoryChange(options.session || null, failedItem, item);
        return {
          success: false,
          errorMsg: fuelResult.errorMsg,
          data: failedItem,
          fuelResult,
          shutdownResult,
        };
      }
      item = fuelResult.data || findItemById(itemID) || item;
    }
    if (options.reconcileForceField !== false) {
      const forceFieldResult = reconcileControlTowerForceField(item, {
        spawn: options.spawnForceField !== false,
        updateScene: options.updateForceFieldScene !== false,
        broadcast: options.broadcastForceField !== false,
      });
      if (!forceFieldResult.success) {
        return {
          success: false,
          errorMsg: forceFieldResult.errorMsg,
          data: item,
        };
      }
    }
    return { success: true, data: item, completed: false, fuelResult };
  }

  const nowMs = Math.max(0, toInt(options.nowMs, Date.now()));
  if (
    anchorState.anchorState === CONTROL_TOWER_ANCHOR_STATE.ANCHORED &&
    state.onlineCompletesAtMs &&
    nowMs < state.onlineCompletesAtMs
  ) {
    if (options.schedule !== false) {
      scheduleControlTowerOnlineReconciliation(
        itemID,
        state.onlineCompletesAtMs,
        options.session || null,
      );
    }
    return { success: true, data: item, completed: false };
  }

  const completed = Boolean(
    anchorState.anchorState === CONTROL_TOWER_ANCHOR_STATE.ANCHORED &&
    state.onlineCompletesAtMs,
  );
  const finalOnlineState = completed
    ? CONTROL_TOWER_ONLINE_STATE.ONLINE
    : CONTROL_TOWER_ONLINE_STATE.OFFLINE;
  const updateResult = updateInventoryItem(itemID, (currentItem) => ({
    ...currentItem,
    spaceState: buildControlTowerSpaceState(currentItem, {
      onlineState: finalOnlineState,
    }),
  }));
  if (!updateResult.success || !updateResult.data) {
    return updateResult;
  }

  clearControlTowerOnlineTimer(itemID);
  syncInventoryChange(
    options.session || null,
    updateResult.data,
    updateResult.previousData || item,
  );
  let forceFieldResult = null;
  let fuelResult = null;
  if (finalOnlineState === CONTROL_TOWER_ONLINE_STATE.ONLINE) {
    fuelResult = getStarbaseFuelRuntime().initializeControlTowerFuelState(
      updateResult.data,
      {
        nowMs,
        session: options.session || null,
        schedule: options.schedule !== false,
        updateScene: options.updateForceFieldScene !== false,
        broadcast: options.broadcastForceField !== false,
      },
    );
    if (!fuelResult.success) {
      log.warn(
        `[ControlTower] Fuel activation failed item=${itemID} ` +
        `error=${fuelResult.errorMsg}`,
      );
      const shutdownResult = getStarbaseFuelRuntime()
        .offlineControlTowerForFuelFailure(updateResult.data, {
          nowMs,
          reason: "fuelActivationFailed",
          refreshPresentation: options.refreshPresentation !== false,
          updateScene: options.updateForceFieldScene !== false,
          broadcast: options.broadcastForceField !== false,
        });
      const failedItem = shutdownResult.success && shutdownResult.data
        ? shutdownResult.data
        : findItemById(itemID) || updateResult.data;
      syncInventoryChange(
        options.session || null,
        failedItem,
        updateResult.data,
      );
      return {
        success: false,
        errorMsg: fuelResult.errorMsg,
        data: failedItem,
        completed,
        recovered: !state.onlineCompletesAtMs,
        fuelResult,
        shutdownResult,
      };
    }
  }
  const reconciledItem = fuelResult && fuelResult.success && fuelResult.data
    ? fuelResult.data
    : updateResult.data;
  const industryResult = require("../industry/starbaseIndustryRuntime").reconcileAssemblyJobs(reconciledItem, { nowMs });
  if (!industryResult.success) return { ...industryResult, data: reconciledItem };
  // Initialize and persist the paid startup fuel cycle before hydrating the
  // newly-online ball. Hydration can synchronously reconcile an online tower;
  // publishing the presentation first would expose an unfunded intermediate
  // state and could immediately offline the tower.
  if (options.refreshPresentation !== false) {
    refreshControlTowerAnchorPresentation(reconciledItem);
  }
  if (options.reconcileForceField !== false) {
    forceFieldResult = reconcileControlTowerForceField(reconciledItem, {
      spawn: options.spawnForceField !== false,
      updateScene: options.updateForceFieldScene !== false,
      broadcast: options.broadcastForceField !== false,
    });
    if (!forceFieldResult.success) {
      log.warn(
        `[ControlTower] Force field reconciliation failed item=${itemID} ` +
        `error=${forceFieldResult.errorMsg}`,
      );
    }
  }
  log.info(
    `[ControlTower] item=${itemID} ` +
    `onlineState=${getControlTowerOnlineState(reconciledItem).onlineState}`,
  );
  return {
    success: true,
    data: reconciledItem,
    completed,
    recovered: !state.onlineCompletesAtMs,
    forceFieldResult,
    fuelResult,
  };
}

function startControlTowerOnlineTransition(session, itemID, effectName, options = {}) {
  const normalizedEffectName = String(effectName || "").trim().toLowerCase();
  if (![
    "onlineforstructures",
    "effectonlineforstructures",
    "effects.structureonline",
    String(EFFECT_ONLINE_FOR_STRUCTURES),
  ].includes(normalizedEffectName)) {
    return { success: false, errorMsg: "INVALID_CONTROL_TOWER_ONLINE_EFFECT" };
  }

  const numericItemID = toInt(itemID, 0);
  const nowMs = Math.max(0, toInt(options.nowMs, Date.now()));
  let item = findItemById(numericItemID);
  if (!item) {
    return { success: false, errorMsg: "ITEM_NOT_FOUND" };
  }
  if (!isControlTowerType(item) || !typeHasDogmaEffect(item.typeID, EFFECT_ONLINE_FOR_STRUCTURES)) {
    return { success: false, errorMsg: "ITEM_NOT_ONLINEABLE_CONTROL_TOWER" };
  }

  const anchorReconciliation = reconcileControlTowerAnchorState(item, {
    nowMs,
    session,
    schedule: false,
    refreshPresentation: false,
  });
  if (!anchorReconciliation.success) {
    return anchorReconciliation;
  }
  const onlineReconciliation = reconcileControlTowerOnlineState(numericItemID, {
    nowMs,
    session,
    schedule: false,
    refreshPresentation: false,
  });
  if (!onlineReconciliation.success) {
    return onlineReconciliation;
  }
  item = findItemById(numericItemID);

  const context = getSessionContext(session);
  const accessError = validateControlTowerAnchorAccess(session, item, context, {
    operation: "online",
    requireAnchoringSkill: false,
  });
  if (accessError) {
    return { success: false, errorMsg: accessError };
  }

  const anchorState = getControlTowerAnchorState(item);
  if (anchorState.anchorState !== CONTROL_TOWER_ANCHOR_STATE.ANCHORED) {
    return { success: false, errorMsg: "CONTROL_TOWER_NOT_ANCHORED" };
  }
  const state = getControlTowerOnlineState(item);
  if (state.onlineState === CONTROL_TOWER_ONLINE_STATE.ONLINING) {
    return {
      success: true,
      data: {
        itemID: numericItemID,
        ...state,
        idempotent: true,
      },
    };
  }
  if (state.onlineState === CONTROL_TOWER_ONLINE_STATE.ONLINE) {
    return {
      success: true,
      data: {
        itemID: numericItemID,
        ...state,
        idempotent: true,
      },
    };
  }

  const fuelValidation = validateControlTowerFuel(item);
  if (!fuelValidation.success) {
    return fuelValidation;
  }
  const delayMs = getControlTowerOnlineDelayMs(item);
  const onlineCompletesAtMs = nowMs + delayMs;
  const updateResult = updateInventoryItem(numericItemID, (currentItem) => ({
    ...currentItem,
    spaceState: buildControlTowerSpaceState(currentItem, {
      onlineState: CONTROL_TOWER_ONLINE_STATE.ONLINING,
      onlineStartedAtMs: nowMs,
      onlineCompletesAtMs,
    }),
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
    scheduleControlTowerOnlineReconciliation(
      numericItemID,
      onlineCompletesAtMs,
      session,
    );
  }
  if (options.refreshPresentation !== false) {
    refreshControlTowerAnchorPresentation(updateResult.data);
  }
  log.info(
    `[ControlTower] char=${context.characterID} corp=${context.corporationID} ` +
    `item=${numericItemID} onlineState=${CONTROL_TOWER_ONLINE_STATE.ONLINING} ` +
    `completesAtMs=${onlineCompletesAtMs}`,
  );
  return {
    success: true,
    data: {
      itemID: numericItemID,
      onlineState: CONTROL_TOWER_ONLINE_STATE.ONLINING,
      onlineStartedAtMs: nowMs,
      onlineCompletesAtMs,
      delayMs,
      fuelRequirements: fuelValidation.data,
    },
  };
}

function setControlTowerOffline(session, itemID, options = {}) {
  const numericItemID = toInt(itemID, 0);
  const nowMs = Math.max(0, toInt(options.nowMs, Date.now()));
  let item = findItemById(numericItemID);
  if (!item) {
    return { success: false, errorMsg: "ITEM_NOT_FOUND" };
  }
  if (!isControlTowerType(item)) {
    return { success: false, errorMsg: "ITEM_NOT_CONTROL_TOWER" };
  }
  const reconciliation = reconcileControlTowerOnlineState(item, {
    nowMs,
    session,
    schedule: false,
    refreshPresentation: false,
  });
  if (!reconciliation.success) {
    return reconciliation;
  }
  item = findItemById(numericItemID);
  const context = getSessionContext(session);
  const accessError = validateControlTowerAnchorAccess(session, item, context, {
    operation: "offline",
    requireAnchoringSkill: false,
  });
  if (accessError) {
    return { success: false, errorMsg: accessError };
  }
  const state = getControlTowerOnlineState(item);
  if (state.onlineState === CONTROL_TOWER_ONLINE_STATE.OFFLINE) {
    return { success: true, data: item, idempotent: true };
  }

  const updateResult = updateInventoryItem(numericItemID, (currentItem) => ({
    ...currentItem,
    spaceState: buildControlTowerSpaceState(currentItem, {
      onlineState: CONTROL_TOWER_ONLINE_STATE.OFFLINE,
    }),
  }));
  if (!updateResult.success || !updateResult.data) {
    return updateResult;
  }
  clearControlTowerOnlineTimer(numericItemID);
  const fuelResult = getStarbaseFuelRuntime().deactivateControlTowerFuelState(
    updateResult.data,
  );
  const reconciledItem = fuelResult.success && fuelResult.data
    ? fuelResult.data
    : updateResult.data;
  const moduleResult = require(path.join(
    __dirname,
    "../starbase/starbaseResourceRuntime",
  )).deactivateTowerModules(reconciledItem, {
    reason: "controlTowerOffline",
    nowMs,
    refreshPresentation: options.refreshPresentation !== false,
    broadcast: options.broadcastModules !== false,
  });
  const industryResult = require("../industry/starbaseIndustryRuntime").reconcileAssemblyJobs(reconciledItem, { nowMs });
  if (!industryResult.success) return { ...industryResult, data: reconciledItem };
  syncInventoryChange(
    session,
    reconciledItem,
    updateResult.previousData || item,
  );
  if (options.refreshPresentation !== false) {
    refreshControlTowerAnchorPresentation(reconciledItem);
  }
  const forceFieldResult = removeControlTowerForceFields(reconciledItem, {
    updateScene: options.updateForceFieldScene !== false,
    broadcast: options.broadcastForceField !== false,
  });
  if (!forceFieldResult.success) {
    log.warn(
      `[ControlTower] Force field removal failed item=${numericItemID} ` +
      `error=${forceFieldResult.errorMsg}`,
    );
  }
  log.info(
    `[ControlTower] char=${context.characterID} corp=${context.corporationID} ` +
    `item=${numericItemID} onlineState=${CONTROL_TOWER_ONLINE_STATE.OFFLINE}`,
  );
  return {
    success: true,
    data: reconciledItem,
    forceFieldResult,
    fuelResult,
    moduleResult,
  };
}

module.exports = {
  CATEGORY_STARBASE,
  GROUP_CONTROL_TOWER,
  GROUP_FORCE_FIELD,
  TYPE_FORCE_FIELD,
  TYPE_ANCHORING,
  EFFECT_ONLINE_FOR_STRUCTURES,
  EFFECT_ANCHOR_DROP_FOR_STRUCTURES,
  EFFECT_ANCHOR_LIFT_FOR_STRUCTURES,
  ATTRIBUTE_ANCHORING_DELAY,
  ATTRIBUTE_UNANCHORING_DELAY,
  ATTRIBUTE_ONLINING_DELAY,
  ATTRIBUTE_POS_CONTROL_TOWER_PERIOD,
  ATTRIBUTE_CONTROL_TOWER_SIZE,
  ATTRIBUTE_SHIELD_RADIUS,
  DEFAULT_CONTROL_TOWER_ANCHOR_DELAY_MS,
  DEFAULT_CONTROL_TOWER_UNANCHOR_DELAY_MS,
  DEFAULT_CONTROL_TOWER_ONLINE_DELAY_MS,
  DEFAULT_CONTROL_TOWER_FUEL_PERIOD_MS,
  CONTROL_TOWER_CHARTER_SECURITY_THRESHOLD,
  MAX_CONTROL_TOWER_INTERACTION_DISTANCE_METERS,
  CONTROL_TOWER_FUEL_BLOCK_BY_RACE_ID,
  CONTROL_TOWER_CHARTER_BY_FACTION_ID,
  CONTROL_TOWER_FORCE_FIELD_MARKER_PREFIX,
  CONTROL_TOWER_ANCHOR_STATE,
  CONTROL_TOWER_ONLINE_STATE,
  CONTROL_TOWER_POS_STATE,
  isControlTowerType,
  isAnchorableControlTowerType,
  getControlTowerAnchorDelayMs,
  getControlTowerOnlineDelayMs,
  getControlTowerTimerScale,
  getControlTowerAnchorState,
  getControlTowerOnlineState,
  getControlTowerPresentationState,
  getControlTowerFuelRequirements,
  validateControlTowerAnchorSystem,
  validateControlTowerAnchorCharter,
  validateControlTowerFuel,
  getControlTowerMoon,
  getControlTowerForceFieldTowerID,
  isControlTowerForceFieldItem,
  listControlTowerForceFields,
  ensureControlTowerForceField,
  removeControlTowerForceFields,
  reconcileControlTowerForceField,
  refreshStarbaseHarmonicPresentation,
  buildControlTowerSpaceState,
  reconcileControlTowerAnchorState,
  reconcileControlTowerOnlineState,
  startControlTowerAnchorTransition,
  startControlTowerOnlineTransition,
  setControlTowerOffline,
  clearControlTowerRuntimeTimers,
  _testing: {
    clearControlTowerAnchorTimer,
    clearControlTowerAnchorTimers,
    clearControlTowerOnlineTimer,
    clearControlTowerOnlineTimers,
    scheduleControlTowerAnchorReconciliation,
    scheduleControlTowerOnlineReconciliation,
    refreshControlTowerAnchorPresentation,
    validateControlTowerAnchorAccess,
  },
};
