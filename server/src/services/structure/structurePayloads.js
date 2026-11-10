"use strict";

const path = require("path");
const log = require(path.join(__dirname, "../../utils/logger"));

const {
  buildDict,
  buildFiletimeLong,
  buildKeyVal,
  buildList,
  buildPackedRow,
  buildPackedRowDescriptor,
} = require(path.join(__dirname, "../_shared/serviceHelpers"));
const structureState = require(path.join(__dirname, "./structureState"));
const { buildNpcStationDirectoryEntry } = require(path.join(__dirname, "./npcStationDirectory"));
const {
  STRUCTURE_SERVICE_ID,
  STRUCTURE_SERVICE_STATE,
} = require(path.join(__dirname, "./structureConstants"));
const {
  SERVICE_ACCESS_SETTING_BY_ID,
  STRUCTURE_SETTING_ACCESS_KIND,
  STRUCTURE_SETTING_ID,
  getConcreteServiceIDsForMetaService,
  getStructureServiceAccessSettingID,
  getStructureSettingAccessKind,
  isStationOnlyStructureService,
  serviceOfflinesIfStructureTooClose,
} = require(path.join(__dirname, "./structureServiceAuthority"));
const {
  findServiceProximityConflict,
} = require(path.join(__dirname, "./structureServiceProximity"));
const {
  getProfileSettingValueForStructure,
  getProfileContextForStructure,
  getProfileSettingResolutionForStructure,
  structureProfileSettingAllowsSession,
} = require(path.join(__dirname, "./structureProfilesState"));
const CORE_REQUIRED_SERVICE_IDS = new Set([
  STRUCTURE_SERVICE_ID.FITTING,
  STRUCTURE_SERVICE_ID.REPAIR,
]);
const STRUCTURE_MAP_ROWSET = "carbon.common.script.sys.crowset.CRowset";
const STRUCTURE_MAP_COLUMNS = Object.freeze([
  ["groupID", 0x03],
  ["typeID", 0x03],
  ["itemID", 0x14],
  ["itemName", 0x82],
  ["locationID", 0x03],
  ["orbitID", 0x03],
  ["connector", 0x0b],
  ["x", 0x05],
  ["y", 0x05],
  ["z", 0x05],
  ["celestialIndex", 0x03],
  ["orbitIndex", 0x03],
]);

function normalizeInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function normalizePositiveInt(value, fallback = 0) {
  const numeric = normalizeInt(value, fallback);
  return numeric > 0 ? numeric : fallback;
}

function normalizeDictKey(key) {
  if (typeof key === "number") {
    return key;
  }
  const numeric = Number(key);
  return Number.isInteger(numeric) && String(numeric) === String(key) ? numeric : key;
}

function isMarshalValue(value) {
  return Boolean(value && typeof value === "object" && typeof value.type === "string");
}

function marshalValue(value) {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value === "bigint") {
    return buildFiletimeLong(value);
  }
  if (Array.isArray(value)) {
    return buildList(value.map((entry) => marshalValue(entry)));
  }
  if (isMarshalValue(value)) {
    return value;
  }
  if (typeof value === "object") {
    return buildDict(
      Object.entries(value).map(([key, entry]) => [
        normalizeDictKey(key),
        marshalValue(entry),
      ]),
    );
  }
  return value;
}

function buildKeyValFromRecord(record = {}) {
  return buildKeyVal(
    Object.entries(record || {}).map(([key, value]) => [key, marshalValue(value)]),
  );
}

function getSessionCorpID(session) {
  return normalizePositiveInt(
    session && (session.corporationID || session.corpid),
    0,
  );
}

function hasOwnerAccess(session, structure) {
  if (!structure) {
    return false;
  }
  if (structureState.hasStructureGmBypass(session)) {
    return true;
  }
  const {
    getPersistedCorporationAuthority,
    getAllianceMemberAuthority,
  } = require("../corporation/corporationAuthority");
  const corpID = getPersistedCorporationAuthority(session)?.corporationID || 0;
  const allianceID = getAllianceMemberAuthority(session)?.allianceID || 0;
  const ownerCorpID = normalizePositiveInt(structure.ownerCorpID || structure.ownerID, 0);
  const ownerAllianceID = normalizePositiveInt(structure.allianceID, 0);
  if (corpID > 0 && corpID === ownerCorpID) {
    return true;
  }
  return ownerAllianceID > 0 && allianceID > 0 && ownerAllianceID === allianceID;
}

function structureSettingAccessKindAllows(session, structure, normalizedSettingID) {
  const dockAccess = structureState.canCharacterDockAtStructure(session, structure, {
    shipTypeID: normalizePositiveInt(session && session.shipTypeID, 0) || undefined,
  }).success;

  let accessKindAllows = false;
  switch (getStructureSettingAccessKind(normalizedSettingID)) {
    case STRUCTURE_SETTING_ACCESS_KIND.ALWAYS:
      accessKindAllows = true;
      break;
    case STRUCTURE_SETTING_ACCESS_KIND.OWNER_ACCESS:
      accessKindAllows = hasOwnerAccess(session, structure);
      break;
    case STRUCTURE_SETTING_ACCESS_KIND.DOCK_ACCESS:
      accessKindAllows = dockAccess;
      break;
    case STRUCTURE_SETTING_ACCESS_KIND.OWNER_OR_DOCK_ACCESS:
      accessKindAllows = hasOwnerAccess(session, structure) || dockAccess;
      break;
    default:
      accessKindAllows = dockAccess;
      break;
  }
  return accessKindAllows;
}

function characterHasStructureSetting(session, structure, settingID, diagnostics = null) {
  const normalizedSettingID = normalizeInt(settingID, 0);
  if (!structure) {
    return false;
  }
  if (normalizedSettingID === STRUCTURE_SETTING_ID.NONE) {
    return true;
  }

  const accessKindAllows = structureSettingAccessKindAllows(session, structure, normalizedSettingID);
  if (diagnostics) {
    diagnostics.accessKindAllows = accessKindAllows;
  }
  return accessKindAllows && structureProfileSettingAllowsSession(
    structure,
    normalizedSettingID,
    { session },
  );
}

function characterHasStructureSettingForRequest(session, structure, settingID, operation, requestedStructureID) {
  const diagnostics = {};
  const allowed = characterHasStructureSetting(session, structure, settingID, diagnostics);
  if (!allowed) {
    const context = getProfileContextForStructure(structure);
    const resolution = getProfileSettingResolutionForStructure(structure, settingID, { session });
    log.debug(
      `[StructureAccess] ${operation} denied` +
      ` character=${normalizePositiveInt(session && (session.characterID || session.charid), 0)}` +
      ` corp=${getSessionCorpID(session)}` +
      ` structure=${normalizePositiveInt(structure && structure.structureID, 0) || normalizePositiveInt(requestedStructureID, 0)}` +
      ` ownerCorp=${context.ownerCorpID}` +
      ` setting=${normalizeInt(settingID, 0)}` +
      ` ownerCheck=${hasOwnerAccess(session, structure)}` +
      ` accessKindAllows=${Boolean(diagnostics.accessKindAllows)}` +
      ` requestedProfile=${context.requestedProfileID}` +
      ` resolvedProfile=${normalizePositiveInt(context.profile && context.profile.profileID, 0)}` +
      ` profileCount=${context.corporationProfiles.length}` +
      ` configured=${resolution.configured}` +
      ` matched=${resolution.matched}` +
      ` defaultOwnerCorporationFallback=${Boolean(resolution.defaultOwnerCorporationFallback)}`,
    );
  }
  return allowed;
}

function characterHasStructureService(session, structure, serviceID) {
  const normalizedServiceID = normalizePositiveInt(serviceID, 0);
  if (!structure || !normalizedServiceID) {
    return false;
  }

  if (isStationOnlyStructureService(normalizedServiceID)) {
    return false;
  }

  const concreteServiceIDs = getConcreteServiceIDsForMetaService(normalizedServiceID);
  const stateID = normalizeInt(
    structure.serviceStates && structure.serviceStates[String(normalizedServiceID)],
    STRUCTURE_SERVICE_STATE.OFFLINE,
  );
  if (concreteServiceIDs.length > 0 && stateID !== STRUCTURE_SERVICE_STATE.ONLINE) {
    return concreteServiceIDs.some((concreteServiceID) => (
      characterHasStructureService(session, structure, concreteServiceID)
    ));
  }

  if (stateID !== STRUCTURE_SERVICE_STATE.ONLINE) {
    return false;
  }
  if (
    CORE_REQUIRED_SERVICE_IDS.has(normalizedServiceID) &&
    structure.hasQuantumCore !== true
  ) {
    return false;
  }
  if (serviceOfflinesIfStructureTooClose(normalizedServiceID)) {
    const structures = structureState.listStructures({
      includeDestroyed: false,
      refresh: false,
    });
    if (findServiceProximityConflict(structure, normalizedServiceID, structures)) {
      return false;
    }
  }

  const settingID = getStructureServiceAccessSettingID(normalizedServiceID);
  return characterHasStructureSetting(session, structure, settingID);
}

function normalizeStructureServiceValue(value) {
  if (value === undefined || value === null || typeof value === "boolean") {
    return 0.0;
  }
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : value;
}

function buildAccessibleStructureServiceValue(structure, session, serviceID) {
  const settingID = getStructureServiceAccessSettingID(serviceID);
  if (!settingID || settingID === STRUCTURE_SETTING_ID.NONE) {
    return 0.0;
  }

  return normalizeStructureServiceValue(
    getProfileSettingValueForStructure(structure, settingID, {
      session,
      defaultValue: 0.0,
    }),
  );
}

function buildAccessibleStructureServices(structure, session) {
  const entries = Object.entries(structure && structure.serviceStates ? structure.serviceStates : {})
    .map(([serviceID, stateID]) => [normalizePositiveInt(serviceID, 0), normalizeInt(stateID, 0)])
    .filter(
      ([serviceID, stateID]) =>
        serviceID > 0 &&
        stateID === STRUCTURE_SERVICE_STATE.ONLINE &&
        characterHasStructureService(session, structure, serviceID),
    )
    .map(([serviceID]) => [
      serviceID,
      buildAccessibleStructureServiceValue(structure, session, serviceID),
    ])
    .sort((left, right) => left[0] - right[0]);

  return Object.fromEntries(entries);
}

function buildBasicStructureInfoPayload(structure) {
  const info = structureState.buildStructureDirectoryInfo(structure);
  return buildKeyVal([
    ["typeID", info.typeID],
    ["structureID", info.structureID],
    ["upkeepState", info.upkeepState],
    ["wars", info.wars],
    ["ownerID", info.ownerID],
    ["solarSystemID", info.solarSystemID],
    ["itemName", info.itemName],
    ["inSpace", info.inSpace],
  ]);
}

function buildStructureInfoPayload(structure, session, options = {}) {
  const info = structureState.buildStructureDirectoryInfo(structure);
  if (options.includeAccessibleServices !== false) {
    info.services = buildAccessibleStructureServices(structure, session);
  }
  return buildKeyValFromRecord(info);
}

function buildStructureInfoDict(structures = [], session, options = {}) {
  const { getPersistedCorporationAuthority } = require("../corporation/corporationAuthority");
  const corporationID = getPersistedCorporationAuthority(session)?.corporationID || 0;
  return buildDict(
    (Array.isArray(structures) ? structures : [])
      .filter((structure) => structure && normalizePositiveInt(structure.structureID, 0) > 0)
      .sort((left, right) => left.structureID - right.structureID)
      .map((structure) => [
        structure.structureID,
        corporationID > 0 && corporationID === Number(structure.ownerCorpID || structure.ownerID)
          ? buildStructureInfoPayload(structure, session, options)
          : buildBasicStructureInfoPayload(structure),
      ]),
  );
}

/**
 * structureDirectory.GetMyCharacterStructures as Tranquility answers it (recorded: LOGS/Archive/Open Structure
 * Browser.txt, 2026-07-03): a dict by structure of plain dicts, each the structure's type, number, wars, the services
 * the character may use with their setting values, its owner and its system, and no more (no reinforcement timers,
 * fuel or profile: those are the owners' management reads'); and the NPC stations of the session's region, each the
 * same way (npcStationDirectory.js).
 */
function buildCharacterStructuresDict(structures = [], stations = [], session) {
  const entries = (Array.isArray(structures) ? structures : [])
    .filter((structure) => structure && normalizePositiveInt(structure.structureID, 0) > 0)
    .sort((left, right) => left.structureID - right.structureID)
    .map((structure) => {
      const info = structureState.buildStructureDirectoryInfo(structure);
      return [
        info.structureID,
        marshalValue({
          typeID: info.typeID,
          structureID: info.structureID,
          wars: info.wars,
          services: buildAccessibleStructureServices(structure, session),
          ownerID: info.ownerID,
          solarSystemID: info.solarSystemID,
        }),
      ];
    });
  const stationEntries = (Array.isArray(stations) ? stations : []).map((station) => buildNpcStationDirectoryEntry(station));
  return buildDict([...entries, ...stationEntries]);
}

function buildStructureMapPayload(structure) {
  const [
    groupID,
    typeID,
    itemID,
    itemName,
    locationID,
    orbitID,
    connector,
    x,
    y,
    z,
    celestialIndex,
    orbitIndex,
  ] = structureState.buildStructureMapEntry(structure);

  return buildPackedRow(STRUCTURE_MAP_COLUMNS, {
    groupID,
    typeID,
    itemID,
    itemName: { type: "wstring", value: String(itemName || "") },
    locationID,
    orbitID,
    connector: Boolean(connector),
    x,
    y,
    z,
    celestialIndex,
    orbitIndex,
  });
}

function buildStructureMapList(structures = []) {
  const header = buildPackedRowDescriptor(STRUCTURE_MAP_COLUMNS);
  return {
    type: "objectex2",
    header: [
      [{ type: "token", value: STRUCTURE_MAP_ROWSET }],
      buildDict([["header", header]]),
    ],
    list: (Array.isArray(structures) ? structures : [])
      .filter((structure) => structure && normalizePositiveInt(structure.structureID, 0) > 0)
      .sort((left, right) => left.structureID - right.structureID)
      .map((structure) => buildStructureMapPayload(structure)),
    dict: [],
  };
}

function buildIDList(values = []) {
  return buildList(
    [...new Set((Array.isArray(values) ? values : []).map((value) => normalizePositiveInt(value, 0)).filter(Boolean))]
      .sort((left, right) => left - right),
  );
}

module.exports = {
  STRUCTURE_SETTING_ID,
  SERVICE_ACCESS_SETTING_BY_ID,
  marshalValue,
  buildKeyValFromRecord,
  buildAccessibleStructureServices,
  buildBasicStructureInfoPayload,
  characterHasStructureSetting,
  characterHasStructureSettingForRequest,
  characterHasStructureService,
  buildStructureInfoPayload,
  buildStructureInfoDict,
  buildCharacterStructuresDict,
  buildStructureMapPayload,
  buildStructureMapList,
  buildIDList,
};
