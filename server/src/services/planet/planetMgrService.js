"use strict";

const path = require("path");

const BaseService = require(path.join(__dirname, "../baseService"));
const log = require(path.join(__dirname, "../../utils/logger"));
const {
  throwWrappedUserError,
} = require(path.join(__dirname, "../../common/machoErrors"));
const {
  getCharacterRecord,
  syncInventoryItemForSession,
} = require(path.join(
  __dirname,
  "../character/characterState",
));
const {
  ITEM_FLAGS,
  consumeInventoryItemQuantity,
  consumeInventoryItemQuantityIdempotent,
  findItemById,
  getActiveShipItem,
  grantItemsToCharacterLocation,
  createSpaceItemForCharacter,
  moveItemToLocation,
  moveItemToLocationIdempotent,
  removeInventoryItem,
} = require(path.join(__dirname, "../inventory/itemStore"));

// A placed command centre stays an item, moved to the planet in this flag
// (inventorycommon const.py flagSpecializedCommandCenterHold); its item ID is
// the pin's. Golden log "Setup Barren Planet Full": the colony's first
// UserUpdateNetwork brings one OnItemsChanged moving the centre from the
// ship's hold to the planet, and no planet notice.
const FLAG_SPECIALIZED_COMMAND_CENTER_HOLD = 148;
const {
  buildBoundObjectResponse,
  buildDbRowset,
  buildDict,
  buildKeyVal,
  buildList,
  currentFileTime,
  normalizeNumber,
  resolveBoundNodeId,
  unwrapMarshalValue,
} = require(path.join(__dirname, "../_shared/serviceHelpers"));
const {
  buildCachedMethodCallResult,
} = require(path.join(__dirname, "../cache/objectCacheRuntime"));
const {
  LOOT_CUSTOM_INFO_KEY,
  buildSpaceLootRightsSnapshot,
  resolveCharacterSpaceLootContext,
} = require(path.join(__dirname, "../_shared/spaceLootEntitlement"));
const {
  TABLE,
  readStaticRows,
} = require(path.join(__dirname, "../_shared/referenceData"));
const {
  JOURNAL_ENTRY_TYPE,
  adjustCharacterBalanceAsync,
  buildNotEnoughMoneyUserErrorValues,
  getCharacterWallet,
} = require(path.join(__dirname, "../account/walletState"));
const {
  hasStaffAccountRole,
} = require(path.join(__dirname, "../account/accountRoleProfiles"));
const planetStaticData = require("./planetStaticData");
const planetCostCalculator = require("./planetCostCalculator");
const planetRuntimeStore = require("./planetRuntimeStore");
const spaceRuntime = require(path.join(__dirname, "../../space/runtime"));

let planetMetaCache = null;
const PLANETARY_LAUNCH_CONTAINER_TYPE_ID = 2263;
const PLANETS_FOR_CHAR_ROWSET_NAME = "carbon.common.script.sys.crowset.CRowset";
const PI_LAUNCH_DETAILS_ROWSET_NAME = "carbon.common.script.sys.crowset.CRowset";
const PLANETS_FOR_CHAR_COLUMNS = [
  ["solarSystemID", 0x03],
  ["planetID", 0x03],
  ["typeID", 0x03],
  ["numberOfPins", 0x03],
  ["celestialIndex", 0x11], // UI1 in the retail colony-summary descriptor.
];
const PI_LAUNCH_DETAILS_COLUMNS = [
  ["launchID", 0x03],
  ["solarSystemID", 0x03],
  ["itemID", 0x14],
  ["ownerID", 0x03],
  ["planetID", 0x03],
  ["status", 0x11],
  ["launchTime", 0x40],
  ["x", 0x05],
  ["y", 0x05],
  ["z", 0x05],
];
function toInt(value, fallback = 0) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return fallback;
  }
  return Math.trunc(numericValue);
}

function getCharacterColonies(characterRecord = {}) {
  const candidates = [
    characterRecord.colonies,
    characterRecord.planets,
    characterRecord.planetColonies,
  ];
  const source = candidates.find((entry) => Array.isArray(entry));
  return Array.isArray(source) ? source.filter(Boolean) : [];
}

function getPlanetMetaByID() {
  if (planetMetaCache) {
    return planetMetaCache;
  }

  planetMetaCache = new Map();
  for (const row of readStaticRows(TABLE.CELESTIALS)) {
    if (!row || (row.kind !== "planet" && row.groupName !== "Planet")) {
      continue;
    }
    const itemID = toInt(row.itemID, 0);
    if (itemID <= 0) {
      continue;
    }
    planetMetaCache.set(itemID, {
      planetID: itemID,
      solarSystemID: toInt(row.solarSystemID, 0),
      typeID: toInt(row.typeID, 0),
      celestialIndex: toInt(row.celestialIndex, 0),
        radius: Number(row.radius) || 0,
        position: row.position && typeof row.position === "object"
          ? {
            x: Number(row.position.x) || 0,
            y: Number(row.position.y) || 0,
            z: Number(row.position.z) || 0,
          }
          : { x: 0, y: 0, z: 0 },
        security: Number(row.security),
        itemName: row.itemName || "",
      });
  }

  return planetMetaCache;
}

function getPlanetMeta(planetID) {
  const normalizedPlanetID = toInt(planetID, 0);
  return getPlanetMetaByID().get(normalizedPlanetID) || {
    planetID: normalizedPlanetID,
    solarSystemID: 0,
    typeID: 0,
    celestialIndex: 0,
    radius: 0,
    position: { x: 0, y: 0, z: 0 },
    security: 0,
    itemName: "",
  };
}

function getItemTypeGroupID(typeID) {
  const typeInfo = planetStaticData.getPITypeInfo(typeID);
  return typeInfo ? typeInfo.groupID : 0;
}

function getResourceTypeIDsForPlanetType(planetTypeID) {
  return planetStaticData.getPlanetResourceTypeIDs(planetTypeID);
}

function mergeColonies(primaryColonies = [], extraColonies = []) {
  const merged = new Map();
  for (const entry of [...primaryColonies, ...extraColonies]) {
    const planetID = toInt(entry && (entry.planetID ?? entry.itemID ?? entry.id), 0);
    if (planetID > 0) {
      merged.set(planetID, entry);
    }
  }
  return [...merged.values()];
}

function buildPlanetRowFields(entry = {}) {
  const planetID = toInt(entry.planetID ?? entry.itemID ?? entry.id, 0);
  if (planetID <= 0) {
    return null;
  }

  const staticMeta = getPlanetMetaByID().get(planetID) || {};
  const pins = Array.isArray(entry.pins) ? entry.pins : [];

  return {
    planetID,
    solarSystemID: toInt(
      entry.solarSystemID ?? entry.systemID,
      staticMeta.solarSystemID || 0,
    ),
    typeID: toInt(entry.typeID ?? entry.planetTypeID, staticMeta.typeID || 0),
    numberOfPins: toInt(entry.numberOfPins ?? entry.pinCount, pins.length),
    celestialIndex: toInt(entry.celestialIndex, staticMeta.celestialIndex || 0),
  };
}

function buildPlanetEntry(entry = {}) {
  const fields = buildPlanetRowFields(entry);
  if (!fields) {
    return null;
  }
  return buildKeyVal(PLANETS_FOR_CHAR_COLUMNS.map(([columnName]) => [
    columnName,
    fields[columnName],
  ]));
}

function buildPlanetRow(entry = {}) {
  const fields = buildPlanetRowFields(entry);
  if (!fields) {
    return null;
  }
  return PLANETS_FOR_CHAR_COLUMNS.map(([columnName]) => fields[columnName]);
}

function buildPlanetListForCharacter(characterRecord = {}) {
  return buildList(
    mergeColonies(
      getCharacterColonies(characterRecord),
      characterRecord.runtimeColonies,
    )
      .map((entry) => buildPlanetEntry(entry))
      .filter(Boolean),
  );
}

function buildPlanetRowsetForCharacter(characterRecord = {}) {
  return buildDbRowset(
    PLANETS_FOR_CHAR_COLUMNS,
    mergeColonies(
      getCharacterColonies(characterRecord),
      characterRecord.runtimeColonies,
    )
      .map((entry) => buildPlanetRow(entry))
      .filter(Boolean),
    PLANETS_FOR_CHAR_ROWSET_NAME,
  );
}

function marshalPlainValue(value) {
  if (value === null || value === undefined) {
    return value;
  }

  if (Array.isArray(value)) {
    return buildList(value.map((entry) => marshalPlainValue(entry)));
  }

  if (value && typeof value === "object") {
    if (value.type && typeof value.type === "string") {
      return value;
    }
    return buildDict(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        marshalPlainValue(entryValue),
      ]),
    );
  }

  return value;
}

// JavaScript object keys are always strings, but PI commodity type IDs are
// integer keys in the retail client's pin.contents dictionary.  The client
// later compares a storage-content key directly to ProcessPin.demands, whose
// keys come from the schematic and are integers.  Sending { "3689": 10 }
// consequently makes Mechanical Parts appear to be absent from a Robotics
// schematic even though the persisted colony and the schematic are correct.
function marshalCommodityContents(contents = {}) {
  return buildDict(
    Object.entries(contents && typeof contents === "object" ? contents : {})
      .map(([typeID, quantity]) => [
        toInt(typeID, 0),
        toInt(quantity, 0),
      ])
      .filter(([typeID, quantity]) => typeID > 0 && quantity > 0),
  );
}

function buildKeyValFromObject(value = {}) {
  return buildKeyVal(
    Object.entries(value || {}).map(([entryKey, entryValue]) => [
      entryKey,
      marshalPlainValue(entryValue),
    ]),
  );
}

function toFiletimeBigInt(value, fallback = null) {
  if (value === null || value === undefined || value === "") {
    return fallback;
  }

  try {
    if (typeof value === "bigint") {
      return value;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return BigInt(Math.trunc(value));
    }
    if (typeof value === "string") {
      return BigInt(value);
    }
  } catch (error) {
    return fallback;
  }

  return fallback;
}

function buildPinRow(pin = {}) {
  const pinID = toInt(pin.pinID ?? pin.id, 0);
  const entityType = planetStaticData.getPinEntityType(pin.typeID);
  const row = {
    id: toInt(pin.id ?? pinID, pinID),
    latitude: Number(pin.latitude) || 0,
    longitude: Number(pin.longitude) || 0,
    ownerID: toInt(pin.ownerID ?? pin.charID, 0),
    lastRunTime: toFiletimeBigInt(pin.lastRunTime, currentFileTime()),
    typeID: toInt(pin.typeID, 0),
    contents: marshalCommodityContents(pin.contents),
    state: toInt(pin.state, 0),
  };

  if (entityType === "command" || entityType === "spaceport") {
    row.lastLaunchTime = toFiletimeBigInt(pin.lastLaunchTime, 0n);
  }

  if (entityType === "process") {
    row.schematicID = pin.schematicID === null || pin.schematicID === undefined
      ? null
      : toInt(pin.schematicID, 0);
    row.hasReceivedInputs = pin.hasReceivedInputs === true;
    row.receivedInputsLastCycle = pin.receivedInputsLastCycle === true;
  }

  if (entityType === "ecu") {
    row.cycleTime = toInt(pin.cycleTime, 0);
    row.programType = pin.programType === null || pin.programType === undefined
      ? null
      : toInt(pin.programType, 0);
    row.qtyPerCycle = toInt(pin.qtyPerCycle, 0);
    row.expiryTime = toFiletimeBigInt(pin.expiryTime, null);
    row.installTime = toFiletimeBigInt(pin.installTime, null);
    row.headRadius = Number(pin.headRadius) || 0;
    row.heads = Array.isArray(pin.heads) ? pin.heads : [];
  }

  return buildKeyValFromObject(row);
}

function buildLinkRow(link = {}) {
  return buildKeyValFromObject({
    ...link,
    endpoint1: toInt(link.endpoint1, 0),
    endpoint2: toInt(link.endpoint2, 0),
    level: toInt(link.level, 0),
    typeID: toInt(link.typeID, 0),
  });
}

function buildRouteRow(route = {}) {
  return buildKeyValFromObject({
    routeID: toInt(route.routeID, 0),
    charID: toInt(route.charID ?? route.ownerID, 0),
    path: Array.isArray(route.path) ? route.path.map((pinID) => toInt(pinID, 0)) : [],
    commodityTypeID: toInt(route.commodityTypeID ?? route.typeID, 0),
    commodityQuantity: toInt(route.commodityQuantity ?? route.quantity, 0),
  });
}

function buildSerializedColony(colony = {}) {
  return buildKeyVal([
    ["ownerID", toInt(colony.ownerID, 0)],
    ["pins", buildList((Array.isArray(colony.pins) ? colony.pins : []).map(buildPinRow))],
    ["links", buildList((Array.isArray(colony.links) ? colony.links : []).map(buildLinkRow))],
    ["routes", buildList((Array.isArray(colony.routes) ? colony.routes : []).map(buildRouteRow))],
    ["level", toInt(colony.level ?? colony.commandCenterLevel, 0)],
    ["currentSimTime", colony.currentSimTime ? BigInt(colony.currentSimTime) : currentFileTime()],
  ]);
}

function buildPlanetInfo(planetMeta, colony = null) {
  const entries = [
    ["planetID", toInt(planetMeta.planetID, 0)],
    ["solarSystemID", toInt(planetMeta.solarSystemID, 0)],
    ["planetTypeID", toInt(planetMeta.typeID, 0)],
    // Radius must reach the client as a Python float, not an int. The client's
    // template writer computes Diam = planet.radius * 2 / 1000 under Python 2
    // integer division, and eveplanet verification.py::_VerifyDiamater rejects a
    // non-float outright (PITemplateVerificationFailed). Every SDE planet radius
    // is integer-valued, so a bare number would always marshal as PyInt.
    ["radius", { type: "real", value: Number(planetMeta.radius) || 0 }],
    ["celestialIndex", toInt(planetMeta.celestialIndex, 0)],
  ];

  if (colony) {
    const serializedColony = buildSerializedColony(colony);
    const serializedEntries = serializedColony.args.entries || [];
    entries.push(...serializedEntries);
  }

  return buildKeyVal(entries);
}

function buildResourceInfoForPlanet(planetMeta) {
  const resourceTypeIDs = getResourceTypeIDsForPlanetType(planetMeta.typeID);
  const resourceRecord = planetRuntimeStore.getOrCreatePlanetResources(
    planetMeta,
    resourceTypeIDs,
  );
  const qualities = planetRuntimeStore.getResourceQualitiesForClient(resourceRecord);
  return buildDict(
    (resourceRecord.resourceTypeIDs || resourceTypeIDs).map((resourceTypeID) => [
      toInt(resourceTypeID, 0),
      toInt(qualities[String(resourceTypeID)], 0),
    ]),
  );
}

function buildResourceDataResponse(planetMeta, info = {}) {
  const resourceTypeIDs = getResourceTypeIDsForPlanetType(planetMeta.typeID);
  const resourceTypeID = toInt(info.resourceTypeID, 0);
  const resourceData = planetRuntimeStore.getResourceDataForClient(
    planetMeta,
    resourceTypeID,
    resourceTypeIDs,
    info,
  );
  return buildKeyVal([
    ["data", resourceData.data],
    ["numBands", resourceData.numBands],
    ["proximity", resourceData.proximity],
  ]);
}

function extractSurfacePoint(value) {
  const unwrapped = unwrapMarshalValue(value);
  if (Array.isArray(unwrapped)) {
    return {
      latitude: Number(unwrapped[0]) || 0,
      longitude: Number(unwrapped[1]) || 0,
    };
  }
  if (unwrapped && typeof unwrapped === "object") {
    return {
      latitude: Number(unwrapped.latitude ?? unwrapped.theta ?? unwrapped[0]) || 0,
      longitude: Number(unwrapped.longitude ?? unwrapped.phi ?? unwrapped[1]) || 0,
    };
  }
  return { latitude: 0, longitude: 0 };
}

function buildLocalDistributionReport(planetMeta, surfacePoint = {}) {
  const resourceTypeIDs = getResourceTypeIDsForPlanetType(planetMeta.typeID);
  planetRuntimeStore.getOrCreatePlanetResources(planetMeta, resourceTypeIDs);
  const resources = resourceTypeIDs.map((resourceTypeID) => [
    resourceTypeID,
    planetRuntimeStore.evaluateResourceValueAt(
      planetMeta.planetID,
      resourceTypeID,
      surfacePoint.latitude,
      surfacePoint.longitude,
    ),
  ]);

  return buildKeyVal([
    ["planetID", toInt(planetMeta.planetID, 0)],
    ["latitude", Number(surfacePoint.latitude) || 0],
    ["longitude", Number(surfacePoint.longitude) || 0],
    ["resources", buildDict(resources)],
  ]);
}

function buildCommandPinSummary(pin = {}, ownerID = 0) {
  const pinID = toInt(pin.pinID ?? pin.id, 0);
  return buildKeyVal([
    ["pinID", pinID],
    ["id", pinID],
    ["typeID", toInt(pin.typeID, 0)],
    ["ownerID", toInt(pin.ownerID ?? ownerID, 0)],
    ["latitude", Number(pin.latitude) || 0],
    ["longitude", Number(pin.longitude) || 0],
  ]);
}

function buildExtractorSummary(pin = {}, ownerID = 0) {
  const pinID = toInt(pin.pinID ?? pin.id, 0);
  return buildKeyVal([
    ["pinID", pinID],
    ["id", pinID],
    ["typeID", toInt(pin.typeID, 0)],
    ["ownerID", toInt(pin.ownerID ?? ownerID, 0)],
    ["latitude", Number(pin.latitude) || 0],
    ["longitude", Number(pin.longitude) || 0],
  ]);
}

function buildLaunchRow(launch = {}) {
  const fields = {
    launchID: toInt(launch.launchID ?? launch.itemID, 0),
    solarSystemID: toInt(launch.solarSystemID, 0),
    itemID: toInt(launch.itemID ?? launch.launchID, 0),
    ownerID: toInt(launch.ownerID, 0),
    planetID: toInt(launch.planetID, 0),
    status: toInt(launch.status, 0),
    launchTime: launch.launchTime ? BigInt(launch.launchTime) : currentFileTime(),
    x: Number(launch.x) || 0,
    y: Number(launch.y) || 0,
    z: Number(launch.z) || 0,
  };
  return PI_LAUNCH_DETAILS_COLUMNS.map(([columnName]) => fields[columnName]);
}

function buildLaunchDetailsRowset(launches = []) {
  return buildDbRowset(
    PI_LAUNCH_DETAILS_COLUMNS,
    (Array.isArray(launches) ? launches : []).map(buildLaunchRow),
    PI_LAUNCH_DETAILS_ROWSET_NAME,
  );
}

function extractPlanetIDFromValue(value) {
  const unwrapped = unwrapMarshalValue(value);
  if (Array.isArray(unwrapped)) {
    return extractPlanetIDFromValue(unwrapped[0]);
  }
  if (unwrapped && typeof unwrapped === "object") {
    return toInt(
      unwrapped.planetID ??
        unwrapped.itemID ??
        unwrapped.id ??
        unwrapped[0],
      0,
    );
  }
  return toInt(unwrapped, 0);
}

function extractPlanetIDFromArgs(args) {
  if (!Array.isArray(args) || args.length < 1) {
    return 0;
  }
  return extractPlanetIDFromValue(args[0]);
}

function extractBoundObjectIDFromBindResponse(response) {
  try {
    const boundObject = Array.isArray(response) ? response[0] : null;
    const substream = boundObject && boundObject.type === "substruct"
      ? boundObject.value
      : null;
    const objectID = substream && substream.type === "substream"
      ? substream.value
      : substream;
    return Array.isArray(objectID) && typeof objectID[0] === "string"
      ? objectID[0]
      : null;
  } catch (error) {
    // ignored: an unreadable bound object has no object ID (null)
    return null;
  }
}

function ensurePlanetBindingMap(session) {
  if (!session || typeof session !== "object") {
    return null;
  }
  if (!session._planetMgrBoundPlanets || typeof session._planetMgrBoundPlanets !== "object") {
    session._planetMgrBoundPlanets = {};
  }
  return session._planetMgrBoundPlanets;
}

function ensurePlanetBoundObjectReuseMap(session) {
  if (!session || typeof session !== "object") {
    return null;
  }
  if (
    !session._planetMgrBoundObjectByPlanetID ||
    typeof session._planetMgrBoundObjectByPlanetID !== "object"
  ) {
    session._planetMgrBoundObjectByPlanetID = {};
  }
  return session._planetMgrBoundObjectByPlanetID;
}

function preparePlanetBoundObjectReuse(serviceName, planetID, session) {
  if (!session || !serviceName || planetID <= 0) {
    return;
  }
  const reuseMap = ensurePlanetBoundObjectReuseMap(session);
  const cachedBinding = reuseMap && reuseMap[String(planetID)];
  if (!session._boundObjectIDs || typeof session._boundObjectIDs !== "object") {
    session._boundObjectIDs = {};
  }
  if (!session._boundObjectState || typeof session._boundObjectState !== "object") {
    session._boundObjectState = {};
  }

  if (
    cachedBinding &&
    typeof cachedBinding.objectID === "string" &&
    cachedBinding.objectID.trim() !== ""
  ) {
    session._boundObjectIDs[serviceName] = cachedBinding.objectID;
    session._boundObjectState[serviceName] = {
      objectID: cachedBinding.objectID,
      boundAtFileTime: cachedBinding.boundAtFileTime || currentFileTime(),
    };
    return;
  }

  delete session._boundObjectIDs[serviceName];
  delete session._boundObjectState[serviceName];
}

function rememberPlanetBoundObjectReuse(serviceName, planetID, boundObjectID, session) {
  if (!session || !serviceName || planetID <= 0 || !boundObjectID) {
    return;
  }
  const reuseMap = ensurePlanetBoundObjectReuseMap(session);
  if (!reuseMap) {
    return;
  }
  const serviceState = session._boundObjectState && session._boundObjectState[serviceName];
  reuseMap[String(planetID)] = {
    objectID: boundObjectID,
    boundAtFileTime:
      (serviceState && serviceState.boundAtFileTime) || currentFileTime(),
  };
}

// TQ sends OnMajorPlanetStateUpdate to the character (golden logs: charid).
const PLANET_NOTIFICATION_ID_TYPES = Object.freeze({ OnMajorPlanetStateUpdate: "charid" });

function sendPlanetNotification(session, methodName, args = []) {
  if (!session || typeof session.sendNotification !== "function") {
    return;
  }

  try {
    session.sendNotification(methodName, PLANET_NOTIFICATION_ID_TYPES[methodName] || "clientID", args);
  } catch (error) {
    log.warn(`[PlanetMgr] Failed to send ${methodName}: ${error.message}`);
  }
}

function getSessionCharacterID(session) {
  return toInt(
    session && (session.characterID ?? session.charid ?? session.charID ?? session.userid),
    0,
  );
}

// The GM verbs are staff tools. Nothing before a handler asks what account a
// session is, so each of them asks here: a staff or GM account passes, as every
// default account on a development server is, and an account saved with
// isGM:false is refused, the same check the staff-only chat commands make.
function requireStaffAccount(session) {
  if (!hasStaffAccountRole(session)) {
    throwWrappedUserError("CustomNotify", {
      notify: "This planet command requires a staff account.",
    });
  }
}

function getOptionalOwnerID(args, index, session) {
  if (!Array.isArray(args) || args.length <= index) {
    return getSessionCharacterID(session);
  }

  const value = unwrapMarshalValue(args[index]);
  if (value === null || value === undefined || value === "") {
    return getSessionCharacterID(session);
  }
  return toInt(value, getSessionCharacterID(session));
}

function getSessionShipID(session, characterID = 0) {
  const sessionShipID = toInt(
    session && (
      session.shipID ??
      session.shipid ??
      session.shipId ??
      (session._space && session._space.shipID)
    ),
    0,
  );
  if (sessionShipID > 0) {
    return sessionShipID;
  }

  const activeShip = getActiveShipItem(characterID);
  return toInt(activeShip && activeShip.itemID, 0);
}

function isCommandCenterSourceItem(item, pin, characterID, shipID) {
  if (!item || !pin) {
    return false;
  }

  const allowedSourceFlags = new Set([
    ITEM_FLAGS.CARGO_HOLD,
    ITEM_FLAGS.SPECIALIZED_COMMAND_CENTER_HOLD,
    ITEM_FLAGS.COLONY_RESOURCES_HOLD,
  ]);

  return (
    toInt(item.ownerID, 0) === characterID &&
    toInt(item.typeID, 0) === toInt(pin.typeID, 0) &&
    toInt(item.locationID, 0) === shipID &&
    allowedSourceFlags.has(toInt(item.flagID, 0)) &&
    planetStaticData.getPinEntityType(pin.typeID) === "command"
  );
}

function syncInventoryChanges(session, changes = [], options = {}) {
  for (const change of Array.isArray(changes) ? changes : []) {
    if (!change || !change.item) {
      continue;
    }
    syncInventoryItemForSession(
      session,
      change.item,
      change.previousData || {},
      { emitCfgLocation: true, ...options },
    );
  }
}

function buildLaunchCommodityGrantEntries(contents = {}) {
  return Object.entries(contents || {})
    .map(([typeID, quantity]) => ({
      itemType: toInt(typeID, 0),
      quantity: toInt(quantity, 0),
      options: { singleton: 0 },
    }))
    .filter((entry) => entry.itemType > 0 && entry.quantity > 0);
}

function createPhysicalLaunchContainer(launch, session) {
  const characterID = getSessionCharacterID(session);
  const solarSystemID = toInt(launch && launch.solarSystemID, 0);
  const launchID = toInt(launch && launch.launchID, 0);
  if (characterID <= 0 || solarSystemID <= 0 || launchID <= 0) {
    return null;
  }

  const grantEntries = buildLaunchCommodityGrantEntries(launch.contents);
  if (grantEntries.length < 1) {
    return null;
  }

  const simTimeMs = spaceRuntime.getSimulationTimeMsForSession(session, Date.now());
  const expiresAtMs = simTimeMs + Number(
    planetRuntimeStore.PI_LAUNCH_ORBIT_DECAY_TICKS / 10000n,
  );
  const lootContext = resolveCharacterSpaceLootContext(characterID, { session });
  const createResult = createSpaceItemForCharacter(
    characterID,
    solarSystemID,
    PLANETARY_LAUNCH_CONTAINER_TYPE_ID,
    {
      itemName: "Planetary Launch Container",
      customInfo: JSON.stringify({
        evejsPiLaunch: { launchID },
        [LOOT_CUSTOM_INFO_KEY]: buildSpaceLootRightsSnapshot(lootContext),
      }),
      position: {
        x: Number(launch.x) || 0,
        y: Number(launch.y) || 0,
        z: Number(launch.z) || 0,
      },
      velocity: { x: 0, y: 0, z: 0 },
      mode: "STOP",
      speedFraction: 0,
      createdAtMs: simTimeMs,
      expiresAtMs,
    },
  );
  if (!createResult.success || !createResult.data) {
    log.warn(
      `[PlanetMgr] Failed to create PI launch container launchID=${launchID}: ${createResult.errorMsg || "UNKNOWN"}`,
    );
    return null;
  }

  const containerID = toInt(createResult.data.itemID, 0);
  const grantResult = grantItemsToCharacterLocation(
    characterID,
    containerID,
    ITEM_FLAGS.HANGAR,
    grantEntries,
  );
  if (!grantResult.success) {
    log.warn(
      `[PlanetMgr] Failed to fill PI launch container launchID=${launchID} containerID=${containerID}: ${grantResult.errorMsg || "UNKNOWN"}`,
    );
    removeInventoryItem(containerID, { removeContents: true });
    return null;
  }

  syncInventoryChanges(session, createResult.changes || []);
  syncInventoryChanges(session, (grantResult.data && grantResult.data.changes) || []);

  const spawnResult = spaceRuntime.spawnDynamicInventoryEntity(solarSystemID, containerID);
  if (!spawnResult || !spawnResult.success) {
    log.warn(
      `[PlanetMgr] PI launch container persisted but did not spawn launchID=${launchID} containerID=${containerID}: ${(spawnResult && spawnResult.errorMsg) || "UNKNOWN"}`,
    );
  }

  return planetRuntimeStore.attachLaunchContainer({
    launchID,
    ownerID: characterID,
    itemID: containerID,
  }) || {
    ...launch,
    itemID: containerID,
    physicalContainerID: containerID,
  };
}

function throwNotEnoughMoney(requiredAmount, currentBalance) {
  throwWrappedUserError(
    "NotEnoughMoney",
    buildNotEnoughMoneyUserErrorValues(requiredAmount, currentBalance),
  );
}

async function debitPIWallet({
  characterID,
  amount,
  entryTypeID,
  referenceID = 0,
  ownerID2 = 0,
  description = "Planetary Interaction charge",
  idempotencyKey = null,
} = {}) {
  const normalizedAmount = Number(amount) || 0;
  if (!(normalizedAmount > 0)) {
    return null;
  }

  const wallet = getCharacterWallet(characterID);
  if (!wallet) {
    throwWrappedUserError("CustomNotify", {
      notify: "Cannot charge PI wallet: character wallet not found.",
    });
  }
  if (wallet.balance < normalizedAmount) {
    throwNotEnoughMoney(normalizedAmount, wallet.balance);
  }
  const debitResult = await adjustCharacterBalanceAsync(characterID, -normalizedAmount, {
    entryTypeID,
    referenceID,
    ownerID1: characterID,
    ownerID2,
    description,
    idempotencyKey: idempotencyKey || undefined,
  }, {
    source: "planetMgr",
    idempotencyKey: idempotencyKey || undefined,
  });
  if (!debitResult.success) {
    if (debitResult.errorMsg === "INSUFFICIENT_FUNDS") {
      throwNotEnoughMoney(normalizedAmount, wallet.balance);
    }
    throwWrappedUserError("CustomNotify", {
      notify: `Cannot charge PI wallet: ${debitResult.errorMsg || "wallet debit failed"}.`,
    });
  }

  return debitResult;
}

async function refundPIWalletDebit(
  characterID,
  debitResult,
  description,
  idempotencyKey = null,
) {
  const amount = Math.abs(Number(debitResult && debitResult.delta) || 0);
  if (!(amount > 0)) {
    return;
  }

  await adjustCharacterBalanceAsync(characterID, amount, {
    entryTypeID: debitResult.journalEntry && debitResult.journalEntry.entryTypeID,
    referenceID: debitResult.journalEntry && debitResult.journalEntry.referenceID,
    ownerID1: characterID,
    ownerID2: debitResult.journalEntry && debitResult.journalEntry.ownerID2,
    description,
    idempotencyKey: idempotencyKey || undefined,
  }, {
    source: "planetMgr",
    idempotencyKey: idempotencyKey || undefined,
  });
}

function getPlanetLabel(planetMeta = {}) {
  return planetMeta.itemName || `planet ${toInt(planetMeta.planetID, 0) || "unknown"}`;
}

// One Command Center item is charged per command-centre *pin*, once, when the pin is
// created. `colony.pins` is the whole post-simulation pin set, so it still holds the
// command centre from the first submit on every later one; charging from it re-charged the
// player on every UserUpdateNetwork call until the cargo stack ran dry and the item row was
// deleted (docs/ErrorWatch/2026-08-06T23-55-27-237Z.md). Charge only for the pins this
// submit created.
//
// `createdPinIDs` carries the post-remap pin IDs of this call's CREATEPIN commands. Charging
// nothing when it is empty cannot skip a legitimate first charge: planetRuntimeStore's
// validatePinTypeForCreate throws CannotBuildMultipleCommandPins unless the colony has no
// command pin at that point in the stream, so every CREATEPIN of a command centre that
// survives the apply is a genuine new placement — and the client's CommandStream is a delta
// it Resets after each successful submit (clientPlanet._SubmitChanges), never a replay of
// the existing network.
function consumePlacedCommandCenterItems(
  colony,
  session,
  createdPinIDs,
  operationKey = null,
) {
  const characterID = getSessionCharacterID(session);
  const shipID = getSessionShipID(session, characterID);
  if (characterID <= 0 || shipID <= 0 || !colony) {
    return;
  }

  const chargeablePinIDs = createdPinIDs instanceof Set ? createdPinIDs : new Set();
  if (chargeablePinIDs.size < 1) {
    return;
  }

  const planetID = toInt(colony.planetID, 0);
  const commandPins = (Array.isArray(colony.pins) ? colony.pins : [])
    .filter((pin) => planetStaticData.getPinEntityType(pin && pin.typeID) === "command");
  for (const pin of commandPins) {
    const pinID = toInt(pin.pinID ?? pin.id, 0);
    if (pinID <= 0 || !chargeablePinIDs.has(pinID)) {
      continue;
    }

    const sourceItem = findItemById(pinID);
    if (!isCommandCenterSourceItem(sourceItem, pin, characterID, shipID)) {
      // The pin was placed but nothing was taken for it, so the colony is running on an
      // unpaid command centre. Warn when an item does exist and was refused; a pin ID with
      // no item behind it at all is the ordinary shape for synthetic/scripted colonies, so
      // that stays at debug.
      if (sourceItem) {
        log.warn(
          `[PlanetMgr] Refused command center itemID=${pinID} as the source for a newly ` +
          `placed pin typeID=${toInt(pin.typeID, 0)} planetID=${planetID}; pin placed without consuming an item`,
        );
      } else {
        log.debug(
          `[PlanetMgr] Placed command center pinID=${pinID} planetID=${planetID} with no ` +
          `source item in ship ${shipID}; charged=0`,
        );
      }
      continue;
    }

    // A single centre moves to the planet as TQ does; a stack gives one up.
    const singleItem =
      toInt(sourceItem.singleton, 0) === 1 ||
      toInt(sourceItem.stacksize ?? sourceItem.quantity, 0) === 1;
    if (singleItem) {
      const moveResult = operationKey
        ? moveItemToLocationIdempotent(pinID, planetID, FLAG_SPECIALIZED_COMMAND_CENTER_HOLD, null, {
            receiptKey: `${operationKey}:command-center:${pinID}`,
            fingerprint: {
              operation: "pi-command-center-place",
              ownerID: characterID,
              planetID,
              pinID,
              typeID: toInt(pin.typeID, 0),
            },
          })
        : moveItemToLocation(pinID, planetID, FLAG_SPECIALIZED_COMMAND_CENTER_HOLD);
      if (!moveResult.success) {
        log.warn(
          `[PlanetMgr] Failed to place command center itemID=${pinID}: ${moveResult.errorMsg || "UNKNOWN"}`,
        );
        continue;
      }
      // TQ tells the client with OnItemsChanged, as the golden log shows.
      syncInventoryChanges(session, moveResult.data && moveResult.data.changes, {
        emitItemsChangedBatch: true,
      });
      continue;
    }

    const consumeResult = operationKey
      ? consumeInventoryItemQuantityIdempotent(pinID, 1, {
          removeContents: false,
          receiptKey: `${operationKey}:command-center:${pinID}`,
          fingerprint: {
            operation: "pi-command-center-consume",
            ownerID: characterID,
            planetID,
            pinID,
            typeID: toInt(pin.typeID, 0),
            quantity: 1,
          },
          receiptMetadata: {
            planetaryIndustry: {
              operationKey,
              planetID,
              pinID,
            },
          },
        })
      : consumeInventoryItemQuantity(pinID, 1, {
          removeContents: false,
        });
    if (!consumeResult.success) {
      log.warn(
        `[PlanetMgr] Failed to consume command center itemID=${pinID}: ${consumeResult.errorMsg || "UNKNOWN"}`,
      );
      continue;
    }

    // Log what changed, not just that something did: `remaining` is what makes a double
    // charge legible in a diff of two records. The row is gone once the last unit goes.
    const remaining = toInt((findItemById(pinID) || {}).stacksize, 0);
    log.debug(
      `[PlanetMgr] Consumed command center itemID=${pinID} typeID=${toInt(pin.typeID, 0)} ` +
      `planetID=${planetID} remaining=${remaining} for PI deployment`,
    );
    syncInventoryChanges(session, consumeResult.data && consumeResult.data.changes);
  }
}

class PlanetMgrService extends BaseService {
  constructor() {
    super("planetMgr");
    this.reuseBoundObjectForSession = true;
  }

  Handle_MachoResolveObject(args) {
    const planetID = extractPlanetIDFromArgs(args);
    log.debug(`[PlanetMgr] MachoResolveObject planetID=${planetID || "unknown"}`);
    return resolveBoundNodeId();
  }

  Handle_MachoBindObject(args, session, kwargs) {
    const planetID = extractPlanetIDFromArgs(args);
    log.debug(`[PlanetMgr] MachoBindObject planetID=${planetID || "unknown"}`);

    if (session && planetID > 0) {
      session._planetMgrBindingPlanetID = planetID;
      session._planetMgrLastPlanetID = planetID;
    }
    preparePlanetBoundObjectReuse(this.name, planetID, session);

    let response;
    try {
      response = buildBoundObjectResponse(this, args, session, kwargs);
    } finally {
      if (session && Object.prototype.hasOwnProperty.call(session, "_planetMgrBindingPlanetID")) {
        delete session._planetMgrBindingPlanetID;
      }
    }

    // An async nested call (UserUpdateNetwork, UserLaunchCommodities) makes the
    // bind response a promise, and the OID only shows up once it settles.
    const rememberBinding = (settledResponse) => {
      const boundObjectID = extractBoundObjectIDFromBindResponse(settledResponse);
      if (boundObjectID && planetID > 0) {
        rememberPlanetBoundObjectReuse(this.name, planetID, boundObjectID, session);
        const bindingMap = ensurePlanetBindingMap(session);
        if (bindingMap) {
          bindingMap[boundObjectID] = planetID;
        }
      }
      return settledResponse;
    };

    return response && typeof response.then === "function"
      ? response.then(rememberBinding)
      : rememberBinding(response);
  }

  _resolvePlanetID(args, session, options = {}) {
    if (options.allowArgs === true) {
      const argPlanetID = extractPlanetIDFromArgs(args);
      if (argPlanetID > 0) {
        return argPlanetID;
      }
    }

    const bindingPlanetID = toInt(session && session._planetMgrBindingPlanetID, 0);
    if (bindingPlanetID > 0) {
      return bindingPlanetID;
    }

    const bindingMap = ensurePlanetBindingMap(session);
    const currentBoundObjectID = session && session.currentBoundObjectID;
    const boundPlanetID = bindingMap && currentBoundObjectID
      ? toInt(bindingMap[currentBoundObjectID], 0)
      : 0;
    if (boundPlanetID > 0) {
      return boundPlanetID;
    }

    return toInt(session && session._planetMgrLastPlanetID, 0);
  }

  Handle_GetPlanetsForChar(args, session) {
    log.debug("[PlanetMgr] GetPlanetsForChar");
    const characterRecord = getCharacterRecord(session && session.characterID);
    const runtimeColonies = planetRuntimeStore.listColoniesForCharacter(
      session && session.characterID,
    );
    return buildPlanetRowsetForCharacter({
      ...(characterRecord || {}),
      runtimeColonies,
    });
  }

  Handle_GetPlanetInfo(args, session) {
    const planetID = this._resolvePlanetID(args, session, { allowArgs: true });
    log.debug(`[PlanetMgr] GetPlanetInfo planetID=${planetID || "unknown"}`);
    const planetMeta = getPlanetMeta(planetID);
    const colony = planetRuntimeStore.getColony(
      planetID,
      session && session.characterID,
    );
    return buildPlanetInfo(planetMeta, colony);
  }

  Handle_GetPlanetResourceInfo(args, session) {
    const planetID = this._resolvePlanetID(args, session, { allowArgs: true });
    log.debug(`[PlanetMgr] GetPlanetResourceInfo planetID=${planetID || "unknown"}`);
    return buildCachedMethodCallResult(
      buildResourceInfoForPlanet(getPlanetMeta(planetID)),
      {
        serviceName: this.name,
        method: "GetPlanetResourceInfo",
        args: [planetID],
        versionCheck: "run",
      },
    );
  }

  Handle_GetResourceData(args, session) {
    const planetID = this._resolvePlanetID(args, session, { allowArgs: false });
    const info = unwrapMarshalValue(Array.isArray(args) ? args[0] : {}) || {};
    const resourceTypeID = toInt(info.resourceTypeID, 0);
    const response = buildResourceDataResponse(getPlanetMeta(planetID), info);
    const entries = new Map(response.args.entries || []);
    const data = entries.get("data");
    const dataBytes = data && data.type === "bytes" && Buffer.isBuffer(data.value)
      ? data.value.length
      : 0;
    log.debug(
      `[PlanetMgr] GetResourceData planetID=${planetID || "unknown"} resourceTypeID=${resourceTypeID || "unknown"} oldBand=${toInt(info.oldBand, 0)} newBand=${toInt(info.newBand, 0)} dataBytes=${dataBytes}`,
    );
    return response;
  }

  Handle_GMGetCompleteResource(args, session) {
    requireStaffAccount(session);
    const planetID = this._resolvePlanetID(args, session, { allowArgs: false });
    const resourceTypeID = toInt(unwrapMarshalValue(Array.isArray(args) ? args[0] : 0), 0);
    const layer = String(unwrapMarshalValue(Array.isArray(args) ? args[1] : "base") || "base");
    log.debug(
      `[PlanetMgr] GMGetCompleteResource planetID=${planetID || "unknown"} resourceTypeID=${resourceTypeID || "unknown"} layer=${layer}`,
    );
    return buildResourceDataResponse(getPlanetMeta(planetID), {
      resourceTypeID,
      oldBand: 0,
      newBand: 30,
      proximity: null,
    });
  }

  Handle_GMGetLocalDistributionReport(args, session) {
    requireStaffAccount(session);
    const planetID = extractPlanetIDFromArgs(args) ||
      this._resolvePlanetID(args, session, { allowArgs: false });
    const surfacePoint = extractSurfacePoint(Array.isArray(args) ? args[1] : null);
    log.debug(
      `[PlanetMgr] GMGetLocalDistributionReport planetID=${planetID || "unknown"}`,
    );
    return buildLocalDistributionReport(getPlanetMeta(planetID), surfacePoint);
  }

  Handle_GMGetSynchedServerState(args, session) {
    requireStaffAccount(session);
    const planetID = this._resolvePlanetID(args, session, { allowArgs: false });
    const ownerID = getOptionalOwnerID(args, 0, session);
    const startMs = Date.now();
    const colony = planetRuntimeStore.getColony(planetID, ownerID) || {
      ownerID,
      pins: [],
      links: [],
      routes: [],
      level: 0,
      currentSimTime: currentFileTime().toString(),
    };
    const duration = BigInt(Math.max(0, Date.now() - startMs)) * 10000n;
    log.debug(
      `[PlanetMgr] GMGetSynchedServerState planetID=${planetID || "unknown"} ownerID=${ownerID || "unknown"}`,
    );
    return [duration, buildSerializedColony(colony)];
  }

  Handle_GetFullNetworkForOwner(args, session) {
    const planetID = this._resolvePlanetID(args, session, { allowArgs: true });
    const ownerID = toInt(
      Array.isArray(args) && args.length > 1 ? normalizeNumber(args[1], 0) : 0,
      0,
    );
    const colony = planetRuntimeStore.getColony(planetID, ownerID);
    if (!colony) {
      return [buildList([]), buildList([])];
    }

    const pins = (Array.isArray(colony.pins) ? colony.pins : []).map(buildPinRow);
    const links = (Array.isArray(colony.links) ? colony.links : [])
      .map((link) => buildList([toInt(link.endpoint1, 0), toInt(link.endpoint2, 0)]));
    return [buildList(pins), buildList(links)];
  }

  Handle_GetCommandPinsForPlanet(args, session) {
    const planetID = this._resolvePlanetID(args, session, { allowArgs: true });
    const entries = [];
    const seenOwnerIDs = new Set();
    for (const colony of planetRuntimeStore.listColoniesForPlanet(planetID)) {
      const ownerID = toInt(colony.ownerID, 0);
      const commandPin = (Array.isArray(colony.pins) ? colony.pins : [])
        .find((pin) => (
          getItemTypeGroupID(pin && pin.typeID) === planetStaticData.GROUP.COMMAND_PINS
        ));
      if (ownerID > 0 && commandPin && !seenOwnerIDs.has(ownerID)) {
        entries.push([ownerID, buildCommandPinSummary(commandPin, ownerID)]);
        seenOwnerIDs.add(ownerID);
      }
    }
    return buildDict(entries);
  }

  Handle_GetExtractorsForPlanet(args, session) {
    const planetID = this._resolvePlanetID(args, session, { allowArgs: true });
    const extractors = [];
    for (const colony of planetRuntimeStore.listColoniesForPlanet(planetID)) {
      const ownerID = toInt(colony.ownerID, 0);
      for (const pin of Array.isArray(colony.pins) ? colony.pins : []) {
        if (
          getItemTypeGroupID(pin && pin.typeID) ===
          planetStaticData.GROUP.EXTRACTION_CONTROL_UNIT_PINS
        ) {
          extractors.push(buildExtractorSummary(pin, ownerID));
        }
      }
    }
    return buildList(extractors);
  }

  async Handle_UserUpdateNetwork(args, session, _kwargs, callContext = null) {
    const planetID = this._resolvePlanetID(args, session, { allowArgs: false });
    const planetMeta = getPlanetMeta(planetID);
    const ownerID = getSessionCharacterID(session);
    const serializedChanges = unwrapMarshalValue(Array.isArray(args) ? args[0] : []);
    const commandCount = Array.isArray(serializedChanges) ? serializedChanges.length : 0;
    log.debug(
      `[PlanetMgr] UserUpdateNetwork planetID=${planetID || "unknown"} commands=${commandCount}`,
    );

    const editHash = planetCostCalculator.buildNetworkEditHash({
      planetID,
      ownerID,
      serializedChanges,
    });
    const requestScope = callContext && callContext.requestScope
      ? String(callContext.requestScope)
      : null;
    const replay = planetRuntimeStore.getNetworkEditReplay({
      planetID,
      ownerID,
      editHash,
      requestScope,
    });
    if (replay.status === "conflict") {
      throwWrappedUserError("IDEMPOTENCY_KEY_REUSED");
    }
    if (replay.status === "stale") {
      throwWrappedUserError("PlanetNetworkChanged");
    }
    if (replay.status === "replay" && replay.colony) {
      const replayColony = planetRuntimeStore.getColony(planetID, ownerID) || replay.colony;
      const replayPinIDs = new Set(
        Array.isArray(replay.receipt && replay.receipt.createdPinIDs)
          ? replay.receipt.createdPinIDs
          : [],
      );
      consumePlacedCommandCenterItems(
        replayColony,
        session,
        replayPinIDs,
        replay.receipt && replay.receipt.operationKey,
      );
      return buildSerializedColony(replayColony);
    }

    const resourceTypeIDs = getResourceTypeIDsForPlanetType(planetMeta.typeID);
    planetRuntimeStore.getOrCreatePlanetResources(planetMeta, resourceTypeIDs);
    const existingColony = planetRuntimeStore.getColony(planetID, ownerID);
    const expectedNetworkRevision = toInt(existingColony && existingColony.networkRevision, 0);
    const operationKey =
      `pi-network-edit:${planetID}:${ownerID}:revision:${expectedNetworkRevision}:${editHash}`;
    const constructionQuote = planetCostCalculator.quoteNetworkConstructionCost(
      existingColony,
      serializedChanges,
    );
    try {
      planetRuntimeStore.previewUserUpdateNetwork({
        planetID,
        ownerID,
        solarSystemID: planetMeta.solarSystemID,
        planetTypeID: planetMeta.typeID,
        planetRadius: planetMeta.radius,
        serializedChanges,
      });
    } catch (error) {
      if (error && error.machoErrorResponse) {
        throw error;
      }
      throwWrappedUserError(error && error.message ? error.message : "PlanetUpdateFailed");
    }
    const constructionDebit = await debitPIWallet({
      characterID: ownerID,
      amount: constructionQuote.amount,
      entryTypeID: JOURNAL_ENTRY_TYPE.PLANETARY_CONSTRUCTION,
      referenceID: planetID,
      ownerID2: planetID,
      description: `Planetary construction on ${getPlanetLabel(planetMeta)}`,
      idempotencyKey: `${operationKey}:wallet:debit`,
    });

    let colony;
    // Pin IDs this submit creates, post temporary-ID remap. Only these may be charged for.
    const createdPinIDs = new Set();
    try {
      colony = planetRuntimeStore.applyUserUpdateNetwork({
        planetID,
        ownerID,
        solarSystemID: planetMeta.solarSystemID,
        planetTypeID: planetMeta.typeID,
        planetRadius: planetMeta.radius,
        serializedChanges,
        editHash,
        operationKey,
        requestScope,
        expectedNetworkRevision,
        constructionCost: constructionQuote.amount,
        createdPinIDs,
      });
    } catch (error) {
      await refundPIWalletDebit(
        ownerID,
        constructionDebit,
        `Planetary construction refund on ${getPlanetLabel(planetMeta)}`,
        `${operationKey}:wallet:refund`,
      );
      if (error && error.machoErrorResponse) {
        throw error;
      }
      throwWrappedUserError(error && error.message ? error.message : "PlanetUpdateFailed");
    }

    consumePlacedCommandCenterItems(colony, session, createdPinIDs, operationKey);
    return buildSerializedColony(colony);
  }

  async Handle_UserLaunchCommodities(args, session) {
    const planetID = this._resolvePlanetID(args, session, { allowArgs: false });
    const planetMeta = getPlanetMeta(planetID);
    const ownerID = getSessionCharacterID(session);
    const commandPinID = toInt(unwrapMarshalValue(Array.isArray(args) ? args[0] : 0), 0);
    const commoditiesToLaunch = unwrapMarshalValue(Array.isArray(args) ? args[1] : {}) || {};
    log.debug(
      `[PlanetMgr] UserLaunchCommodities planetID=${planetID || "unknown"} commandPinID=${commandPinID || "unknown"}`,
    );

    const launchOptions = {
      planetID,
      ownerID,
      solarSystemID: planetMeta.solarSystemID,
      planetTypeID: planetMeta.typeID,
      commandPinID,
      commodities: commoditiesToLaunch,
      planetMeta,
    };
    const preview = planetRuntimeStore.previewLaunchCommodities(launchOptions);
    if (!preview.success) {
      throwWrappedUserError(preview.errorMsg || "CannotLaunchCommoditiesNotFound");
    }

    const exportTax = planetCostCalculator.calculateExportTax(
      preview.commandPin && preview.commandPin.typeID,
      preview.commoditiesToLaunch,
      planetCostCalculator.DEFAULT_TAX_RATE,
    );
    const taxDebit = await debitPIWallet({
      characterID: ownerID,
      amount: exportTax,
      entryTypeID: JOURNAL_ENTRY_TYPE.PLANETARY_EXPORT_TAX,
      referenceID: planetID,
      ownerID2: planetID,
      description: `Planetary export tax on ${getPlanetLabel(planetMeta)}`,
    });

    const result = planetRuntimeStore.launchCommodities(launchOptions);
    if (!result.success) {
      await refundPIWalletDebit(
        ownerID,
        taxDebit,
        `Planetary export tax refund on ${getPlanetLabel(planetMeta)}`,
      );
      throwWrappedUserError(result.errorMsg || "CannotLaunchCommoditiesNotFound");
    }

    createPhysicalLaunchContainer(result.launch, session);
    sendPlanetNotification(session, "OnRefreshPins", [[commandPinID]]);
    sendPlanetNotification(session, "OnPILaunchesChange", []);
    return result.lastLaunchTime ? BigInt(result.lastLaunchTime) : currentFileTime();
  }

  Handle_UserTransferCommodities(args, session) {
    const planetID = this._resolvePlanetID(args, session, { allowArgs: false });
    const planetMeta = getPlanetMeta(planetID);
    const ownerID = getSessionCharacterID(session);
    const pathArg = unwrapMarshalValue(Array.isArray(args) ? args[0] : []);
    const commoditiesArg = unwrapMarshalValue(Array.isArray(args) ? args[1] : {}) || {};
    log.debug(
      `[PlanetMgr] UserTransferCommodities planetID=${planetID || "unknown"} path=${Array.isArray(pathArg) ? pathArg.length : 0}`,
    );

    const result = planetRuntimeStore.transferCommodities({
      planetID,
      ownerID,
      solarSystemID: planetMeta.solarSystemID,
      planetTypeID: planetMeta.typeID,
      planetRadius: planetMeta.radius,
      path: pathArg,
      commodities: commoditiesArg,
    });
    if (!result.success) {
      throwWrappedUserError(result.errorMsg || "RouteFailedValidationExpeditedSourceNotReady");
    }

    sendPlanetNotification(session, "OnRefreshPins", [[
      result.sourcePinID,
      result.destinationPinID,
    ]]);
    return [
      result.simTime ? BigInt(result.simTime) : currentFileTime(),
      result.sourceRunTime ? BigInt(result.sourceRunTime) : currentFileTime(),
    ];
  }

  Handle_UserAbandonPlanet(args, session) {
    const planetID = this._resolvePlanetID(args, session, { allowArgs: false });
    log.debug(`[PlanetMgr] UserAbandonPlanet planetID=${planetID || "unknown"}`);
    // The command centre placed on the planet goes with the colony.
    const abandoned = planetRuntimeStore.getColony(planetID, session && session.characterID);
    for (const pin of (abandoned && Array.isArray(abandoned.pins) ? abandoned.pins : [])) {
      const pinItem = findItemById(toInt(pin && (pin.pinID ?? pin.id), 0));
      if (
        pinItem &&
        toInt(pinItem.locationID, 0) === toInt(planetID, 0) &&
        toInt(pinItem.flagID, 0) === FLAG_SPECIALIZED_COMMAND_CENTER_HOLD
      ) {
        removeInventoryItem(pinItem.itemID, { removeContents: true });
      }
    }
    const result = planetRuntimeStore.abandonColony(
      planetID,
      session && session.characterID,
    );
    sendPlanetNotification(session, "OnMajorPlanetStateUpdate", [planetID, true]);
    return result;
  }

  Handle_GetProgramResultInfo(args, session) {
    const planetID = this._resolvePlanetID(args, session, { allowArgs: false });
    const planetMeta = getPlanetMeta(planetID);
    const pinID = toInt(Array.isArray(args) && args.length > 0 ? args[0] : 0, 0);
    const resourceTypeID = toInt(Array.isArray(args) && args.length > 1 ? args[1] : 0, 0);
    const heads = unwrapMarshalValue(Array.isArray(args) && args.length > 2 ? args[2] : []);
    const headRadius = Number(
      unwrapMarshalValue(Array.isArray(args) && args.length > 3 ? args[3] : 0.01),
    ) || 0.01;

    planetRuntimeStore.getOrCreatePlanetResources(
      planetMeta,
      getResourceTypeIDsForPlanetType(planetMeta.typeID),
    );
    const colony = planetRuntimeStore.getColony(
      planetID,
      session && session.characterID,
    );
    const ecuPin = (colony && Array.isArray(colony.pins) ? colony.pins : [])
      .find((pin) => toInt(pin && pin.pinID, 0) === pinID);
    const result = planetRuntimeStore.estimateProgramResult({
      planetID,
      resourceTypeID,
      heads,
      headRadius,
      ecuTypeID: ecuPin && ecuPin.typeID,
      ecuPinID: pinID,
      otherEcuPins: colony && colony.pins,
    });
    log.debug(
      `[PlanetMgr] GetProgramResultInfo planetID=${planetID || "unknown"} resourceTypeID=${resourceTypeID || "unknown"} qty=${result.qtyToDistribute}`,
    );

    return [result.qtyToDistribute, result.cycleTime, result.numCycles];
  }

  Handle_GetMyLaunchesDetails(args, session) {
    log.debug("[PlanetMgr] GetMyLaunchesDetails");
    return buildLaunchDetailsRowset(
      planetRuntimeStore
        .listLaunchesForCharacter(session && session.characterID),
    );
  }

  Handle_DeleteLaunch(args, session) {
    const launchID = toInt(Array.isArray(args) && args.length > 0 ? args[0] : 0, 0);
    log.debug(`[PlanetMgr] DeleteLaunch launchID=${launchID || "unknown"}`);
    return planetRuntimeStore.deleteLaunch(launchID, session && session.characterID);
  }

  Handle_GMGetPlanetDiagnostics(args, session) {
    requireStaffAccount(session);
    const planetID = extractPlanetIDFromArgs(args) ||
      this._resolvePlanetID(args, session, { allowArgs: false });
    const ownerID = getOptionalOwnerID(args, 1, session);
    log.debug(
      `[PlanetMgr] GMGetPlanetDiagnostics planetID=${planetID || "all"} ownerID=${ownerID || "all"}`,
    );
    return buildKeyValFromObject(planetRuntimeStore.getPlanetDiagnostics({
      planetID,
      ownerID,
    }));
  }

  Handle_GMCleanupExpiredLaunches(args, session) {
    requireStaffAccount(session);
    const maxAgeDays = toInt(
      unwrapMarshalValue(Array.isArray(args) && args.length > 0 ? args[0] : 0),
      0,
    );
    const ownerID = getOptionalOwnerID(args, 1, session);
    const result = planetRuntimeStore.cleanupExpiredLaunches({
      maxAgeDays,
      ownerID,
    });
    log.debug(
      `[PlanetMgr] GMCleanupExpiredLaunches ownerID=${ownerID || "all"} deleted=${result.deleted}`,
    );
    if (result.deleted > 0) {
      sendPlanetNotification(session, "OnPILaunchesChange", []);
    }
    return buildKeyValFromObject(result);
  }

  Handle_GMAddCommodity(args, session) {
    requireStaffAccount(session);
    const planetID = this._resolvePlanetID(args, session, { allowArgs: false });
    const pinID = toInt(unwrapMarshalValue(Array.isArray(args) ? args[0] : 0), 0);
    const typeID = toInt(unwrapMarshalValue(Array.isArray(args) ? args[1] : 0), 0);
    const quantity = toInt(unwrapMarshalValue(Array.isArray(args) ? args[2] : 0), 0);
    const result = planetRuntimeStore.addCommodityToColonyPin({
      planetID,
      ownerID: getSessionCharacterID(session),
      pinID,
      typeID,
      quantity,
    });
    log.debug(
      `[PlanetMgr] GMAddCommodity planetID=${planetID || "unknown"} pinID=${pinID || "unknown"} typeID=${typeID || "unknown"} quantity=${quantity}`,
    );
    if (!result.success) {
      throwWrappedUserError("CustomNotify", {
        notify: `Failed to add PI commodity: ${result.errorMsg || "UNKNOWN"}`,
      });
    }
    sendPlanetNotification(session, "OnRefreshPins", [[pinID]]);
    return buildKeyValFromObject(result);
  }
}

PlanetMgrService._testing = {
  buildPlanetEntry,
  buildPlanetListForCharacter,
  buildPlanetRowsetForCharacter,
  buildLaunchDetailsRowset,
  buildPlanetInfo,
  buildResourceInfoForPlanet,
  extractPlanetIDFromValue,
  getCharacterColonies,
  getPlanetMeta,
  getResourceTypeIDsForPlanetType,
};

module.exports = PlanetMgrService;
