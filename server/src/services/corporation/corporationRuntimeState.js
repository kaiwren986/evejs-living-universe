"use strict";

const {
  cloneValue,
} = require("../../common/clone");

const path = require("path");
const { getCorporationRolesAtLocation, parseCorporationRoleMask } = require("./corporationRoleChecks");

const database = require(path.join(__dirname, "../../gameStore"));
const {
  currentFileTime,
} = require(path.join(__dirname, "../_shared/serviceHelpers"));
const {
  getStationRecord,
} = require(path.join(__dirname, "../_shared/stationStaticData"));
const {
  normalizeAggressionSettings,
} = require(path.join(__dirname, "./aggressionSettingsState"));
const {
  getAllianceCorporationIDs,
  ALLIANCES_TABLE,
  CORPORATIONS_TABLE,
  createCustomAllianceForCorporation,
  createCustomCorporation,
  ensureAlliancesInitialized,
  ensureCorporationsInitialized,
  findAllianceByExactName,
  findCorporationByName,
  findAllianceByFoundingOperationID,
  findAllianceByShortName,
  findCorporationByFoundingOperationID,
  findCorporationByTickerName,
  getAllianceRecord,
  getCharacterIDsInCorporation,
  getCorporationRecord,
  setCharacterAffiliation,
  setCorporationRecord,
  setCorporationAlliance,
} = require(path.join(__dirname, "./corporationState"));
const {
  toStoredMaskValue,
} = require(path.join(__dirname, "./contactLabelState"));

const CORPORATION_RUNTIME_TABLE = "corporationRuntime";
const RUNTIME_VERSION = 1;
const PAGE_SIZE = 50;
const CORPORATION_WALLET_KEY_START = 1000;
const MAX_TITLE_COUNT = 16;
const DEFAULT_STRUCTURE_REINFORCE_HOUR = 20;

const CORP_ROLE_DIRECTOR = 1n;
const CORP_ROLE_PERSONNEL_MANAGER = 128n;
const CORP_ROLE_ACCOUNTANT = 256n;
const CORP_ROLE_FACTORY_MANAGER = 1024n;
const CORP_ROLE_STATION_MANAGER = 2048n;
const CORP_ROLE_DELIVERIES_ALL = 2n | 4n | 8n;
const CORP_ROLE_HANGAR_CAN_TAKE_ALL =
  8192n | 16384n | 32768n | 65536n | 131072n | 262144n | 524288n;
const CORP_ROLE_HANGAR_CAN_QUERY_ALL =
  1048576n | 2097152n | 4194304n | 8388608n | 16777216n | 33554432n | 67108864n;
// One Account Take bit per corporation wallet division, in key order 1000..1006.
// This is the same table the client carries as walletConst.corpWalletRoles and the
// same one V24.01 authorizes with as
// eve.common.lib.corporations._CORP_WALLET_DIVISION_ROLES. Keep it ordered rather
// than pre-OR'd: the per-division bit is the withdrawal permission, and the combined
// mask is only ever a convenience derived from it.
const CORP_ROLE_ACCOUNT_CAN_TAKE_BY_DIVISION = [
  134217728n, 268435456n, 536870912n, 1073741824n,
  2147483648n, 4294967296n, 8589934592n,
];
const CORP_ROLE_ACCOUNT_CAN_TAKE_ALL =
  CORP_ROLE_ACCOUNT_CAN_TAKE_BY_DIVISION.reduce((mask, role) => mask | role, 0n);
const CORP_ROLE_BRAND_MANAGER = 34359738368n;
const CORP_ROLE_CONTAINER_CAN_TAKE_ALL =
  4398046511104n | 8796093022208n | 17592186044416n |
  35184372088832n | 70368744177664n | 140737488355328n |
  281474976710656n;
const CORP_ROLE_CAN_RENT_OFFICE = 562949953421312n;
const CORP_ROLE_DIPLOMAT = 17179869184n;
const CORP_ROLE_JUNIOR_ACCOUNTANT = 4503599627370496n;
const CORP_ROLE_TRADER = 18014398509481984n;
const CORP_ROLE_CHAT_MANAGER = 36028797018963968n;
const CORP_ROLE_PROJECT_MANAGER = 1152921504606846976n;
const FULL_LOCATIONAL_ROLE_MASK =
  CORP_ROLE_DELIVERIES_ALL |
  CORP_ROLE_HANGAR_CAN_TAKE_ALL |
  CORP_ROLE_HANGAR_CAN_QUERY_ALL |
  CORP_ROLE_CONTAINER_CAN_TAKE_ALL;
// V24.01 appConst.py exposes every currently assignable corporation role bit.
// Keep this explicit rather than treating an arbitrary 63-bit value as a role:
// malformed/negative masks are an authority boundary, not future-proofing.
const ALL_CORPORATION_ROLE_MASK = [
  1n, 2n, 4n, 8n, 128n, 256n, 512n, 1024n, 2048n, 4096n,
  8192n, 16384n, 32768n, 65536n, 131072n, 262144n, 524288n,
  1048576n, 2097152n, 4194304n, 8388608n, 16777216n, 33554432n,
  67108864n, 134217728n, 268435456n, 536870912n, 1073741824n,
  2147483648n, 4294967296n, 8589934592n, 17179869184n,
  34359738368n, 2199023255552n, 4398046511104n, 8796093022208n,
  17592186044416n, 35184372088832n, 70368744177664n,
  140737488355328n, 281474976710656n, 562949953421312n,
  1125899906842624n, 2251799813685248n, 4503599627370496n,
  9007199254740992n, 18014398509481984n, 36028797018963968n,
  72057594037927936n, 144115188075855872n, 288230376151711744n,
  576460752303423488n, 1152921504606846976n, 2305843009213693952n,
  4611686018427387904n,
].reduce((mask, role) => mask | role, 0n);
const FULL_ADMIN_ROLE_MASK =
  ALL_CORPORATION_ROLE_MASK & ~FULL_LOCATIONAL_ROLE_MASK;
const FULL_GRANTABLE_ROLE_MASK = FULL_ADMIN_ROLE_MASK & ~CORP_ROLE_DIRECTOR;
const FULL_TITLE_MASK = (1 << MAX_TITLE_COUNT) - 1;
const MARSHAL_TEXT_TYPES = new Set([
  "wstring",
  "string",
  "token",
  "PyWString",
  "PyString",
  "PyToken",
]);
const MARSHAL_NUMBER_TYPES = new Set([
  "int",
  "long",
  "float",
  "double",
  "bool",
  "PyInt",
  "PyLong",
  "PyFloat",
  "PyBool",
]);
let runtimeTableCache = null;
let runtimeBootstrapComplete = false;
let officesByStationCache = new Map();
let officesByInventoryIDCache = new Map();
let officesByStationCacheDirty = true;

function getCharacterState() {
  return require(path.join(__dirname, "../character/characterState"));
}

function resetRuntimeCaches() {
  runtimeTableCache = null;
  runtimeBootstrapComplete = false;
  officesByStationCache = new Map();
  officesByInventoryIDCache = new Map();
  officesByStationCacheDirty = true;
}

// The live client sends PyString/PyWString wrappers for many corp fields.
// Without unwrapping them here, custom corps persist literal "[object Object]".
function unwrapMarshalScalar(value) {
  if (value === undefined || value === null) {
    return value;
  }
  if (Buffer.isBuffer(value)) {
    return value.toString("utf8");
  }
  if (
    value &&
    typeof value === "object" &&
    (MARSHAL_TEXT_TYPES.has(value.type) || MARSHAL_NUMBER_TYPES.has(value.type))
  ) {
    return unwrapMarshalScalar(value.value);
  }
  return value;
}

function normalizeInteger(value, fallback = 0) {
  const numericValue = Number(unwrapMarshalScalar(value));
  if (!Number.isFinite(numericValue)) {
    return fallback;
  }
  return Math.trunc(numericValue);
}

function normalizeNullableInteger(value, fallback = null) {
  if (value === null) return null;
  return normalizeInteger(value, fallback);
}

function normalizePositiveInteger(value, fallback = null) {
  const numericValue = normalizeInteger(value, 0);
  return numericValue > 0 ? numericValue : fallback;
}

function normalizeBoolean(value, fallback = false) {
  if (value === undefined || value === null) {
    return fallback;
  }
  const unwrappedValue = unwrapMarshalScalar(value);
  if (typeof unwrappedValue === "string") {
    const normalizedValue = unwrappedValue.trim().toLowerCase();
    if (!normalizedValue) {
      return fallback;
    }
    if (normalizedValue === "0" || normalizedValue === "false") {
      return false;
    }
    if (normalizedValue === "1" || normalizedValue === "true") {
      return true;
    }
  }
  return Boolean(unwrappedValue);
}

function normalizeText(value, fallback = "") {
  if (value === undefined || value === null) {
    return fallback;
  }
  const unwrappedValue = unwrapMarshalScalar(value);
  if (unwrappedValue === undefined || unwrappedValue === null) {
    return fallback;
  }
  if (typeof unwrappedValue === "string") {
    return unwrappedValue;
  }
  return String(unwrappedValue);
}

function normalizeRgbColor(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  const red = normalizeInteger(value.red, null);
  const green = normalizeInteger(value.green, null);
  const blue = normalizeInteger(value.blue, null);
  if (
    red === null ||
    green === null ||
    blue === null ||
    red < 0 ||
    red > 255 ||
    green < 0 ||
    green > 255 ||
    blue < 0 ||
    blue > 255
  ) {
    return null;
  }
  return { red, green, blue };
}

function normalizeCorporationColorPalette(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  const mainColor = normalizeRgbColor(value.mainColor || value.main_color);
  if (!mainColor) {
    return null;
  }
  return {
    mainColor,
    secondaryColor: normalizeRgbColor(value.secondaryColor || value.secondary_color),
    tertiaryColor: normalizeRgbColor(value.tertiaryColor || value.tertiary_color),
    lastModifierCharacterID: normalizePositiveInteger(
      value.lastModifierCharacterID || value.last_modifier_character_id,
      null,
    ),
    lastModified: normalizeFiletimeString(value.lastModified || value.last_modified),
  };
}

function normalizeFiletimeString(value, fallback = null) {
  if (typeof value === "string" && value.trim() !== "") {
    return value;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(Math.trunc(value));
  }
  return fallback || currentFileTime().toString();
}

// All 95 non-null member rowDate values in the TQ member-change corpus are
// minute-aligned, including values on either side of the packet's timestamp.
function roundMemberRowDate(value) {
  const minute = 600000000n;
  const ticks = toRoleMaskBigInt(value, 0n);
  return ((ticks + minute / 2n) / minute) * minute;
}

function normalizeRoleMaskString(value, fallback = "0") {
  if (typeof value === "string" && value.trim() !== "") {
    return value;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? BigInt(value).toString() : "0";
  }
  return fallback;
}

// TQ GetMember/GetMemberTrackingInfo return Director=1 with the other direct masks empty; its powers are implied.
function getDirectMemberRoleMasks(member = {}) {
  const fields = ["roles", "grantableRoles", "rolesAtHQ", "grantableRolesAtHQ", "rolesAtBase", "grantableRolesAtBase", "rolesAtOther", "grantableRolesAtOther"];
  const masks = Object.fromEntries(fields.map((field) => {
    const allowed = field === "roles" ? FULL_ADMIN_ROLE_MASK
      : field === "grantableRoles" ? FULL_GRANTABLE_ROLE_MASK : FULL_LOCATIONAL_ROLE_MASK;
    return [field, parseKnownRoleMask(member[field], allowed) ?? 0n];
  }));
  if ((masks.roles & CORP_ROLE_DIRECTOR) !== 0n) {
    for (const field of fields) masks[field] = field === "roles" ? CORP_ROLE_DIRECTOR : 0n;
  }
  return masks;
}

function toRoleMaskBigInt(value, fallback = 0n) {
  try {
    if (typeof value === "bigint") {
      return value;
    }
    if (
      value &&
      typeof value === "object" &&
      (value.type === "long" || value.type === "int")
    ) {
      return toRoleMaskBigInt(value.value, fallback);
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return BigInt(Math.trunc(value));
    }
    if (typeof value === "string" && value.trim() !== "") {
      return BigInt(value);
    }
  } catch (error) {
    return fallback;
  }
  return fallback;
}

// The Account Take role that authorizes withdrawing from one wallet division.
// Returns null for anything outside 1000..1006 so a caller has to refuse an
// unrecognized key rather than read it as "no role required".
function getCorporationWalletDivisionTakeRole(accountKey) {
  const divisionIndex =
    normalizeInteger(accountKey, -1) - CORPORATION_WALLET_KEY_START;
  return CORP_ROLE_ACCOUNT_CAN_TAKE_BY_DIVISION[divisionIndex] ?? null;
}

function readTable(tableName, fallback) {
  const result = database.read(tableName, "/");
  if (!result.success || !result.data || typeof result.data !== "object") {
    return cloneValue(fallback);
  }
  return cloneValue(result.data);
}

function readTableView(tableName, fallback) {
  const result = database.read(tableName, "/");
  if (!result.success || !result.data || typeof result.data !== "object") {
    return fallback;
  }
  return result.data;
}

function writeTable(tableName, payload) {
  const writeResult = database.write(tableName, "/", cloneValue(payload));
  return {
    success: Boolean(writeResult && writeResult.success),
    errorMsg: writeResult && writeResult.errorMsg ? writeResult.errorMsg : null,
  };
}

function readCorporationTable() {
  return readTable(CORPORATIONS_TABLE, { _meta: {}, records: {} });
}

function readAllianceTable() {
  return readTable(ALLIANCES_TABLE, { _meta: {}, records: {} });
}

function buildDefaultDivisionNames() {
  const names = {};
  for (let index = 1; index <= 7; index += 1) {
    names[index] = `Division ${index}`;
    names[index + 7] = `Wallet Division ${index}`;
  }
  return names;
}

function buildDefaultTitleMap() {
  const titles = {};
  for (let index = 0; index < MAX_TITLE_COUNT; index += 1) {
    const titleID = 2 ** index;
    titles[String(titleID)] = {
      titleID,
      titleName: "",
      roles: "0",
      grantableRoles: "0",
      rolesAtHQ: "0",
      grantableRolesAtHQ: "0",
      rolesAtBase: "0",
      grantableRolesAtBase: "0",
      rolesAtOther: "0",
      grantableRolesAtOther: "0",
    };
  }
  return titles;
}

function buildDefaultWalletDivisions() {
  const divisions = {};
  for (let index = 0; index < 7; index += 1) {
    const key = CORPORATION_WALLET_KEY_START + index;
    divisions[String(key)] = {
      key,
      balance: 0,
      journal: [],
      transactions: [],
      marketTransactions: [],
    };
  }
  return divisions;
}

function buildDefaultMemberState(characterID, corporationRecord) {
  const characterState = getCharacterState();
  const getCharacterRecord =
    characterState && typeof characterState.getCharacterRecord === "function"
      ? characterState.getCharacterRecord
      : null;
  const characterRecord = getCharacterRecord ? (getCharacterRecord(characterID) || {}) : {};
  const isCEO = Number(corporationRecord && corporationRecord.ceoID) === Number(characterID);
  const roleMask = isCEO ? FULL_ADMIN_ROLE_MASK : 0n;
  const grantableRoleMask = isCEO ? FULL_GRANTABLE_ROLE_MASK : 0n;
  const locationalRoleMask = isCEO ? FULL_LOCATIONAL_ROLE_MASK : 0n;
  return {
    characterID: normalizePositiveInteger(characterID, 0) || 0,
    corporationID: normalizePositiveInteger(
      corporationRecord && corporationRecord.corporationID,
      0,
    ) || 0,
    startDate: normalizeFiletimeString(
      characterRecord.startDateTime || characterRecord.createDateTime,
    ),
    title: normalizeText(characterRecord.title, ""),
    divisionID: normalizeNullableInteger(characterRecord.divisionID),
    squadronID: normalizeNullableInteger(characterRecord.squadronID),
    roles: roleMask.toString(),
    grantableRoles: grantableRoleMask.toString(),
    rolesAtHQ: locationalRoleMask.toString(),
    grantableRolesAtHQ: locationalRoleMask.toString(),
    rolesAtBase: locationalRoleMask.toString(),
    grantableRolesAtBase: locationalRoleMask.toString(),
    rolesAtOther: locationalRoleMask.toString(),
    grantableRolesAtOther: locationalRoleMask.toString(),
    // A corporation base is assigned, not inferred from a pilot's home station.
    baseID: normalizePositiveInteger(characterRecord.baseID, null),
    titleMask: 0,
    blockRoles: null,
    // TQ post-join GetMember: player corp has no wallet selected; NPC has Master.
    accountKey: corporationRecord && corporationRecord.isNPC
      ? CORPORATION_WALLET_KEY_START : null,
    isCEO,
    lastOnline: normalizeFiletimeString(currentFileTime()),
    locationID: normalizePositiveInteger(
      characterRecord.stationID ||
        characterRecord.structureID ||
        characterRecord.solarSystemID,
      null,
    ),
    shipTypeID: normalizePositiveInteger(characterRecord.shipTypeID, null),
  };
}

function ensureMetaDefaults(meta = {}) {
  return {
    version: RUNTIME_VERSION,
    allianceApplicationSchemaVersion:
      Math.max(0, normalizeInteger(meta.allianceApplicationSchemaVersion, 0)),
    nextLabelID: toStoredMaskValue(meta.nextLabelID || 1),
    nextBulletinID: normalizePositiveInteger(meta.nextBulletinID, 1) || 1,
    nextApplicationID: normalizePositiveInteger(meta.nextApplicationID, 1) || 1,
    nextInvitationID: normalizePositiveInteger(meta.nextInvitationID, 1) || 1,
    nextRecruitmentAdID:
      normalizePositiveInteger(meta.nextRecruitmentAdID, 1) || 1,
    nextMedalID: normalizePositiveInteger(meta.nextMedalID, 1) || 1,
    nextOfficeID: normalizePositiveInteger(meta.nextOfficeID, 1) || 1,
    nextOfficeFolderID: normalizePositiveInteger(meta.nextOfficeFolderID, 1) || 1,
    nextOfficeItemID: normalizePositiveInteger(meta.nextOfficeItemID, 1) || 1,
    nextImpoundReleaseOperationID:
      normalizePositiveInteger(meta.nextImpoundReleaseOperationID, 1) || 1,
    nextOfficeRentalOperationID:
      normalizePositiveInteger(meta.nextOfficeRentalOperationID, 1) || 1,
    nextDividendSettlementID:
      normalizePositiveInteger(meta.nextDividendSettlementID, 1) || 1,
    nextBillID: normalizePositiveInteger(meta.nextBillID, 1) || 1,
    nextWarID: normalizePositiveInteger(meta.nextWarID, 1) || 1,
    nextNegotiationID: normalizePositiveInteger(meta.nextNegotiationID, 1) || 1,
    nextTreatyID: normalizePositiveInteger(meta.nextTreatyID, 1) || 1,
  };
}

function allocateRuntimeID(table, key) {
  const currentValue = normalizePositiveInteger(table._meta[key], 1) || 1;
  table._meta[key] = currentValue + 1;
  return currentValue;
}

function buildOfficeRecord(table, corporationRecord, stationID) {
  const station = getStationRecord(null, stationID);
  const stationTypeID = normalizePositiveInteger(
    station && station.stationTypeID,
    null,
  );
  return {
    corporationID: corporationRecord.corporationID,
    stationID: normalizePositiveInteger(stationID, 0) || 0,
    officeID: allocateRuntimeID(table, "nextOfficeID"),
    officeFolderID: allocateRuntimeID(table, "nextOfficeFolderID"),
    itemID: allocateRuntimeID(table, "nextOfficeItemID"),
    solarSystemID: normalizePositiveInteger(station && station.solarSystemID, null),
    typeID: stationTypeID,
    stationTypeID,
    rentalCost: Number((station && station.officeRentalCost) || 0),
    expiryDate: normalizeFiletimeString(currentFileTime()),
    impounded: false,
  };
}

function normalizeMemberState(member, corporationRecord, explicitCharacterID = null) {
  const defaultState = buildDefaultMemberState(
    explicitCharacterID !== null && explicitCharacterID !== undefined
      ? explicitCharacterID
      : member && member.characterID,
    corporationRecord,
  );
  const isCEO = Boolean(defaultState.isCEO);
  const roles = isCEO
    ? defaultState.roles
    : normalizeRoleMaskString(member && member.roles, defaultState.roles);
  const grantableRoles = isCEO
    ? defaultState.grantableRoles
    : normalizeRoleMaskString(
        member && member.grantableRoles,
        defaultState.grantableRoles,
      );
  const rolesAtHQ = isCEO
    ? defaultState.rolesAtHQ
    : normalizeRoleMaskString(
        member && member.rolesAtHQ,
        defaultState.rolesAtHQ,
      );
  const grantableRolesAtHQ = isCEO
    ? defaultState.grantableRolesAtHQ
    : normalizeRoleMaskString(
        member && member.grantableRolesAtHQ,
        defaultState.grantableRolesAtHQ,
      );
  const rolesAtBase = isCEO
    ? defaultState.rolesAtBase
    : normalizeRoleMaskString(
        member && member.rolesAtBase,
        defaultState.rolesAtBase,
      );
  const grantableRolesAtBase = isCEO
    ? defaultState.grantableRolesAtBase
    : normalizeRoleMaskString(
        member && member.grantableRolesAtBase,
        defaultState.grantableRolesAtBase,
      );
  const rolesAtOther = isCEO
    ? defaultState.rolesAtOther
    : normalizeRoleMaskString(
        member && member.rolesAtOther,
        defaultState.rolesAtOther,
      );
  const grantableRolesAtOther = isCEO
    ? defaultState.grantableRolesAtOther
    : normalizeRoleMaskString(
        member && member.grantableRolesAtOther,
        defaultState.grantableRolesAtOther,
      );
  return {
    ...defaultState,
    ...cloneValue(member || {}),
    characterID: normalizePositiveInteger(
      member && member.characterID,
      defaultState.characterID,
    ),
    corporationID: normalizePositiveInteger(
      member && member.corporationID,
      defaultState.corporationID,
    ),
    startDate: normalizeFiletimeString(
      member && member.startDate,
      defaultState.startDate,
    ),
    title: normalizeText(member && member.title, defaultState.title),
    divisionID: normalizeNullableInteger(
      member && member.divisionID,
      defaultState.divisionID,
    ),
    squadronID: normalizeNullableInteger(
      member && member.squadronID,
      defaultState.squadronID,
    ),
    roles,
    grantableRoles,
    rolesAtHQ,
    grantableRolesAtHQ,
    rolesAtBase,
    grantableRolesAtBase,
    rolesAtOther,
    grantableRolesAtOther,
    baseID: normalizePositiveInteger(
      member && member.baseID,
      // EditMemberDialog's No Base is an explicit None, not a missing legacy field.
      member && member.baseID === null ? null : defaultState.baseID,
    ),
    titleMask: normalizeInteger(
      member && member.titleMask,
      defaultState.titleMask,
    ),
    blockRoles:
      member && member.blockRoles !== undefined && member.blockRoles !== null
        ? normalizeRoleMaskString(member.blockRoles, "0")
        : null,
    accountKey: normalizeNullableInteger(
      member && member.accountKey,
      defaultState.accountKey,
    ),
    isCEO,
    lastOnline: normalizeFiletimeString(
      member && member.lastOnline,
      defaultState.lastOnline,
    ),
    locationID: normalizePositiveInteger(
      member && member.locationID,
      defaultState.locationID,
    ),
    shipTypeID: normalizePositiveInteger(
      member && member.shipTypeID,
      defaultState.shipTypeID,
    ),
  };
}

function normalizeTitleState(title, titleID) {
  return {
    titleID: normalizePositiveInteger(titleID || (title && title.titleID), 1) || 1,
    titleName: normalizeText(title && title.titleName, ""),
    roles: normalizeRoleMaskString(title && title.roles, "0"),
    grantableRoles: normalizeRoleMaskString(title && title.grantableRoles, "0"),
    rolesAtHQ: normalizeRoleMaskString(title && title.rolesAtHQ, "0"),
    grantableRolesAtHQ: normalizeRoleMaskString(
      title && title.grantableRolesAtHQ,
      "0",
    ),
    rolesAtBase: normalizeRoleMaskString(title && title.rolesAtBase, "0"),
    grantableRolesAtBase: normalizeRoleMaskString(
      title && title.grantableRolesAtBase,
      "0",
    ),
    rolesAtOther: normalizeRoleMaskString(title && title.rolesAtOther, "0"),
    grantableRolesAtOther: normalizeRoleMaskString(
      title && title.grantableRolesAtOther,
      "0",
    ),
  };
}

function normalizeCorporationRuntime(runtime, corporationRecord, table) {
  const base = runtime && typeof runtime === "object" ? cloneValue(runtime) : {};
  const hasPersistedOffices = Object.prototype.hasOwnProperty.call(base, "offices");
  const memberIDs = getCharacterIDsInCorporation(corporationRecord.corporationID);
  const members = {};
  for (const memberID of memberIDs) {
    members[String(memberID)] = normalizeMemberState(
      base.members && base.members[String(memberID)],
      corporationRecord,
      memberID,
    );
  }

  const titles = {};
  const defaultTitles = buildDefaultTitleMap();
  for (const [titleKey, defaultTitle] of Object.entries(defaultTitles)) {
    titles[titleKey] = normalizeTitleState(
      base.titles && base.titles[titleKey],
      defaultTitle.titleID,
    );
  }

  const offices = {};
  if (base.offices && typeof base.offices === "object") {
    for (const [officeKey, office] of Object.entries(base.offices)) {
      const stationID = normalizePositiveInteger(office && office.stationID, null);
      if (!stationID) {
        continue;
      }
      offices[officeKey] = {
        corporationID: corporationRecord.corporationID,
        stationID,
        leaseID: normalizePositiveInteger(office.leaseID, null),
        officeID: normalizePositiveInteger(office.officeID, null),
        officeFolderID: normalizePositiveInteger(office.officeFolderID, null),
        itemID: normalizePositiveInteger(office.itemID, null),
        solarSystemID: normalizePositiveInteger(office.solarSystemID, null),
        stationTypeID: normalizePositiveInteger(
          office.stationTypeID,
          normalizePositiveInteger(office.typeID, null),
        ),
        typeID: normalizePositiveInteger(
          office.typeID,
          normalizePositiveInteger(office.stationTypeID, null),
        ),
        rentalCost: Number(office.rentalCost || 0),
        startDate: normalizeFiletimeString(office.startDate),
        dueDate: normalizeFiletimeString(office.dueDate || office.expiryDate),
        billID: normalizePositiveInteger(office.billID, null),
        expiryDate: normalizeFiletimeString(office.expiryDate),
        impounded: normalizeBoolean(office.impounded, false),
      };
    }
  }
  if (
    !hasPersistedOffices &&
    Object.keys(offices).length === 0 &&
    normalizePositiveInteger(corporationRecord.stationID, null)
  ) {
    const office = buildOfficeRecord(
      table,
      corporationRecord,
      corporationRecord.stationID,
    );
    offices[String(office.officeID)] = office;
  }

  const divisionNames = buildDefaultDivisionNames();
  if (base.divisionNames && typeof base.divisionNames === "object") {
    for (const [key, value] of Object.entries(base.divisionNames)) {
      const index = normalizeInteger(key, 0);
      if (index >= 1 && index <= 14) {
        divisionNames[index] = normalizeText(value, divisionNames[index]);
      }
    }
  }

  const wallet = {
    divisions: buildDefaultWalletDivisions(),
    lpBalance: Number((base.wallet && base.wallet.lpBalance) || 0),
    billBalance: Number((base.wallet && base.wallet.billBalance) || 0),
    authorityReceipts: Array.isArray(base.wallet && base.wallet.authorityReceipts)
      ? cloneValue(base.wallet.authorityReceipts)
      : [],
  };
  if (
    base.wallet &&
    base.wallet.divisions &&
    typeof base.wallet.divisions === "object"
  ) {
    for (const [divisionKey, division] of Object.entries(base.wallet.divisions)) {
      if (!wallet.divisions[divisionKey]) {
        continue;
      }
      wallet.divisions[divisionKey] = {
        key: normalizeInteger(
          division && division.key,
          wallet.divisions[divisionKey].key,
        ),
        balance: Number(
          (division && division.balance) || wallet.divisions[divisionKey].balance,
        ),
        journal: Array.isArray(division && division.journal)
          ? cloneValue(division.journal)
          : [],
        transactions: Array.isArray(division && division.transactions)
          ? cloneValue(division.transactions)
          : [],
        marketTransactions: Array.isArray(division && division.marketTransactions)
          ? cloneValue(division.marketTransactions)
          : [],
        nodeGraphRewardReceipts: division?.nodeGraphRewardReceipts && typeof division.nodeGraphRewardReceipts === "object"
          ? cloneValue(division.nodeGraphRewardReceipts) : {},
        adjustmentReceipts: division?.adjustmentReceipts && typeof division.adjustmentReceipts === "object"
          ? cloneValue(division.adjustmentReceipts) : {},
      };
    }
  }

  return {
    version: RUNTIME_VERSION,
    divisionNames,
    welcomeMail: normalizeText(base.welcomeMail, ""),
    welcomeMailCharacterID: normalizePositiveInteger(
      base.welcomeMailCharacterID,
      null,
    ),
    welcomeMailChangeDate: normalizeFiletimeString(
      base.welcomeMailChangeDate,
      "0",
    ),
    applicationsEnabled:
      base.applicationsEnabled === undefined
        ? 1
        : normalizeBoolean(base.applicationsEnabled, true)
          ? 1
          : 0,
    acceptStructures: normalizeBoolean(base.acceptStructures, true),
    restrictCorpMails: normalizeBoolean(base.restrictCorpMails, false),
    structureReinforceDefault: normalizeInteger(
      base.structureReinforceDefault,
      DEFAULT_STRUCTURE_REINFORCE_HOUR,
    ),
    aggressionSettings: normalizeAggressionSettings(base.aggressionSettings, {
      isNpcCorporation: Boolean(corporationRecord && corporationRecord.isNPC),
    }),
    contacts:
      base.contacts && typeof base.contacts === "object"
        ? cloneValue(base.contacts)
        : {},
    labels:
      base.labels && typeof base.labels === "object"
        ? cloneValue(base.labels)
        : {},
    bulletins: Array.isArray(base.bulletins) ? cloneValue(base.bulletins) : [],
    members,
    titles,
    memberEventLog: Array.isArray(base.memberEventLog)
      ? cloneValue(base.memberEventLog)
      : [],
    roleHistory: Array.isArray(base.roleHistory)
      ? cloneValue(base.roleHistory)
      : [],
    applications:
      base.applications && typeof base.applications === "object"
        ? cloneValue(base.applications)
        : {},
    applicationHistory: Array.isArray(base.applicationHistory)
      ? cloneValue(base.applicationHistory)
      : [],
    invitations:
      base.invitations && typeof base.invitations === "object"
        ? cloneValue(base.invitations)
        : {},
    invitationHistory: Array.isArray(base.invitationHistory)
      ? cloneValue(base.invitationHistory)
      : [],
    shares:
      base.shares && typeof base.shares === "object"
        ? cloneValue(base.shares)
        : {
            [String(corporationRecord.corporationID)]: normalizeInteger(
              corporationRecord && corporationRecord.shares,
              1000,
            ),
          },
    medals:
      base.medals && typeof base.medals === "object"
        ? cloneValue(base.medals)
        : { medals: {}, recipientsByMedalID: {} },
    corpColorPalette: normalizeCorporationColorPalette(base.corpColorPalette),
    offices,
    impoundReleaseSettlements:
      base.impoundReleaseSettlements &&
      typeof base.impoundReleaseSettlements === "object"
        ? cloneValue(base.impoundReleaseSettlements)
        : {},
    officeRentalSettlements:
      base.officeRentalSettlements &&
      typeof base.officeRentalSettlements === "object"
        ? cloneValue(base.officeRentalSettlements)
        : {},
    dividendSettlements:
      base.dividendSettlements &&
      typeof base.dividendSettlements === "object"
        ? cloneValue(base.dividendSettlements)
        : {},
    memberActionSettlements:
      base.memberActionSettlements &&
      typeof base.memberActionSettlements === "object"
        ? cloneValue(base.memberActionSettlements)
        : {},
    lockedItemsByLocation:
      base.lockedItemsByLocation && typeof base.lockedItemsByLocation === "object"
        ? cloneValue(base.lockedItemsByLocation)
        : {},
    wallet,
    recruitmentAds:
      base.recruitmentAds && typeof base.recruitmentAds === "object"
        ? cloneValue(base.recruitmentAds)
        : {},
    allianceApplications:
      base.allianceApplications && typeof base.allianceApplications === "object"
        ? cloneValue(base.allianceApplications)
        : {},
    recentKills: Array.isArray(base.recentKills) ? cloneValue(base.recentKills) : [],
    recentLosses: Array.isArray(base.recentLosses)
      ? cloneValue(base.recentLosses)
      : [],
    pendingAutoKicks: Array.isArray(base.pendingAutoKicks)
      ? cloneValue(base.pendingAutoKicks)
      : [],
    fw:
      base.fw && typeof base.fw === "object"
        ? {
            allowedEnlistmentFactions: Array.isArray(base.fw.allowedEnlistmentFactions)
              ? cloneValue(base.fw.allowedEnlistmentFactions)
              : [],
            cooldownTimestamp:
              normalizeInteger(base.fw.cooldownTimestamp, 0) || 0,
            directEnlistment:
              base.fw.directEnlistment && typeof base.fw.directEnlistment === "object"
                ? cloneValue(base.fw.directEnlistment)
                : null,
          }
        : {
            allowedEnlistmentFactions: [],
            cooldownTimestamp: 0,
            directEnlistment: null,
          },
  };
}

function normalizeAllianceRuntime(runtime, allianceRecord) {
  const base = runtime && typeof runtime === "object" ? cloneValue(runtime) : {};
  const memberCorporationIDs = getAllianceCorporationIDs(allianceRecord.allianceID);
  const executorSupportByCorporation =
    base.executorSupportByCorporation &&
    typeof base.executorSupportByCorporation === "object"
      ? cloneValue(base.executorSupportByCorporation)
      : {};
  const memberJoinedAtByCorporation =
    base.memberJoinedAtByCorporation &&
    typeof base.memberJoinedAtByCorporation === "object"
      ? cloneValue(base.memberJoinedAtByCorporation)
      : {};
  const allianceHistoryByCorporation =
    base.allianceHistoryByCorporation &&
    typeof base.allianceHistoryByCorporation === "object"
      ? cloneValue(base.allianceHistoryByCorporation)
      : {};

  for (const corporationID of memberCorporationIDs) {
    if (
      memberJoinedAtByCorporation[String(corporationID)] === undefined ||
      memberJoinedAtByCorporation[String(corporationID)] === null
    ) {
      memberJoinedAtByCorporation[String(corporationID)] = normalizeFiletimeString(
        allianceRecord.createdAt,
        "0",
      );
    }
  }
  for (const corporationID of Object.keys(memberJoinedAtByCorporation)) {
    if (!memberCorporationIDs.includes(Number(corporationID))) {
      delete memberJoinedAtByCorporation[corporationID];
    }
  }
  if (
    allianceRecord.executorCorporationID &&
    memberCorporationIDs.includes(Number(allianceRecord.executorCorporationID)) &&
    executorSupportByCorporation[String(allianceRecord.executorCorporationID)] === undefined
  ) {
    executorSupportByCorporation[String(allianceRecord.executorCorporationID)] =
      Number(allianceRecord.executorCorporationID);
  }
  for (const corporationID of Object.keys(executorSupportByCorporation)) {
    if (!memberCorporationIDs.includes(Number(corporationID))) {
      delete executorSupportByCorporation[corporationID];
    }
  }

  return {
    version: RUNTIME_VERSION,
    contacts:
      base.contacts && typeof base.contacts === "object"
        ? cloneValue(base.contacts)
        : {},
    labels:
      base.labels && typeof base.labels === "object"
        ? cloneValue(base.labels)
        : {},
    bulletins: Array.isArray(base.bulletins) ? cloneValue(base.bulletins) : [],
    relationships:
      base.relationships && typeof base.relationships === "object"
        ? cloneValue(base.relationships)
        : {},
    applications:
      base.applications && typeof base.applications === "object"
        ? cloneValue(base.applications)
        : {},
    executorSupportByCorporation,
    executorGovernance:
      base.executorGovernance && typeof base.executorGovernance === "object"
        ? cloneValue(base.executorGovernance)
        : null,
    memberJoinedAtByCorporation,
    allianceHistoryByCorporation,
    bills: Array.isArray(base.bills) ? cloneValue(base.bills) : [],
    billBalance: Number(base.billBalance || 0),
    primeInfo: {
      currentPrimeHour: normalizeInteger(
        (base.primeInfo && base.primeInfo.currentPrimeHour) ||
          allianceRecord.currentPrimeHour,
        0,
      ),
      newPrimeHour: normalizeInteger(
        (base.primeInfo && base.primeInfo.newPrimeHour) ||
          allianceRecord.newPrimeHour ||
          allianceRecord.currentPrimeHour,
        0,
      ),
      newPrimeHourValidAfter: normalizeFiletimeString(
        base.primeInfo && base.primeInfo.newPrimeHourValidAfter,
        "0",
      ),
    },
    capitalInfo: {
      currentCapitalSystem: normalizePositiveInteger(
        (base.capitalInfo && base.capitalInfo.currentCapitalSystem) ||
          allianceRecord.currentCapital,
        null,
      ),
      newCapitalSystem: normalizePositiveInteger(
        base.capitalInfo && base.capitalInfo.newCapitalSystem,
        null,
      ),
      newCapitalSystemValidAfter: normalizeFiletimeString(
        base.capitalInfo && base.capitalInfo.newCapitalSystemValidAfter,
        "0",
      ),
    },
  };
}

function ensureRuntimeInitialized() {
  if (runtimeBootstrapComplete && runtimeTableCache) {
    return runtimeTableCache;
  }

  ensureCorporationsInitialized();
  ensureAlliancesInitialized();
  const corporationTable = readCorporationTable();
  const allianceTable = readAllianceTable();
  const runtimeTable = readTable(CORPORATION_RUNTIME_TABLE, {
    _meta: { version: RUNTIME_VERSION },
    corporations: {},
    alliances: {},
    wars: {},
    warNegotiations: {},
    mutualWarInvites: {},
    mutualWarInviteBlocks: {},
    peaceTreaties: {},
  });

  runtimeTable._meta = ensureMetaDefaults(runtimeTable._meta);
  runtimeTable.corporations =
    runtimeTable.corporations && typeof runtimeTable.corporations === "object"
      ? runtimeTable.corporations
      : {};
  runtimeTable.alliances =
    runtimeTable.alliances && typeof runtimeTable.alliances === "object"
      ? runtimeTable.alliances
      : {};
  runtimeTable.wars =
    runtimeTable.wars && typeof runtimeTable.wars === "object"
      ? runtimeTable.wars
      : {};
  runtimeTable.warNegotiations =
    runtimeTable.warNegotiations &&
    typeof runtimeTable.warNegotiations === "object"
      ? runtimeTable.warNegotiations
      : {};
  runtimeTable.mutualWarInvites =
    runtimeTable.mutualWarInvites &&
    typeof runtimeTable.mutualWarInvites === "object"
      ? runtimeTable.mutualWarInvites
      : {};
  runtimeTable.mutualWarInviteBlocks =
    runtimeTable.mutualWarInviteBlocks &&
    typeof runtimeTable.mutualWarInviteBlocks === "object"
      ? runtimeTable.mutualWarInviteBlocks
      : {};
  runtimeTable.peaceTreaties =
    runtimeTable.peaceTreaties &&
    typeof runtimeTable.peaceTreaties === "object"
      ? runtimeTable.peaceTreaties
      : {};

  for (const corporationID of Object.keys(corporationTable.records || {})) {
    const record = getCorporationRecord(corporationID);
    if (!record) {
      continue;
    }
    runtimeTable.corporations[String(record.corporationID)] =
      normalizeCorporationRuntime(
        runtimeTable.corporations[String(record.corporationID)],
        record,
        runtimeTable,
      );
  }

  for (const allianceID of Object.keys(allianceTable.records || {})) {
    const record = getAllianceRecord(allianceID);
    if (!record) {
      continue;
    }
    runtimeTable.alliances[String(record.allianceID)] = normalizeAllianceRuntime(
      runtimeTable.alliances[String(record.allianceID)],
      record,
    );
  }

  // Bootstrapping only derives runtime rows from the corporation and alliance
  // records, so a passive process can keep the result in memory and serve reads
  // from it. Writing it back is the durable owner's job; asking for it here is
  // what used to abort every read-only caller with an ownership violation.
  if (database.mayMutateTable(CORPORATION_RUNTIME_TABLE)) {
    writeTable(CORPORATION_RUNTIME_TABLE, runtimeTable);
  }
  runtimeTableCache = runtimeTable;
  runtimeBootstrapComplete = true;
  officesByStationCacheDirty = true;
  return runtimeTable;
}

function updateRuntimeState(updater) {
  const runtimeTable = ensureRuntimeInitialized();
  const nextTable =
    typeof updater === "function" ? updater(runtimeTable) || runtimeTable : runtimeTable;
  const writeResult = writeTable(CORPORATION_RUNTIME_TABLE, nextTable);
  if (writeResult && writeResult.success) {
    runtimeTableCache = nextTable;
    officesByStationCacheDirty = true;
  }
  return writeResult;
}

function getCorporationRuntime(corporationID) {
  const runtimeTable = ensureRuntimeInitialized();
  const runtime = runtimeTable.corporations[String(corporationID)];
  return runtime ? cloneValue(runtime) : null;
}

function updateCorporationRuntime(corporationID, updater) {
  return updateRuntimeState((runtimeTable) => {
    const corporationRecord = getCorporationRecord(corporationID);
    if (!corporationRecord) {
      return runtimeTable;
    }
    // A corporation made since this table was built has no runtime of its own
    // yet. Its updater is handed the runtime a corporation starts with, and not
    // nothing: an updater reads runtime.members, runtime.contacts and the rest
    // without asking whether there is a runtime (/corpcreate failed so, at the
    // first write of its founder's member state).
    const currentRuntime =
      runtimeTable.corporations[String(corporationRecord.corporationID)] ||
      normalizeCorporationRuntime(undefined, corporationRecord, runtimeTable);
    const nextRuntime =
      typeof updater === "function"
        ? updater(cloneValue(currentRuntime), corporationRecord, runtimeTable) ||
          currentRuntime
        : currentRuntime;
    const normalized = normalizeCorporationRuntime(
      nextRuntime, corporationRecord, runtimeTable,
    );
    // Persist a member revision with its row changes, not during notification
    // delivery. Presence, audit/stasis fields and other runtime data are not
    // part of the recorded twenty-field member row.
    const memberFields = [
      "characterID", "corporationID", "startDate", "title", "divisionID",
      "squadronID", "roles", "grantableRoles", "rolesAtHQ", "grantableRolesAtHQ",
      "rolesAtBase", "grantableRolesAtBase", "rolesAtOther", "grantableRolesAtOther",
      "baseID", "titleMask", "blockRoles", "accountKey",
    ];
    const rowDate = roundMemberRowDate(currentFileTime()).toString();
    for (const [memberID, member] of Object.entries(normalized.members)) {
      const previous = currentRuntime.members && currentRuntime.members[memberID];
      if (!previous || memberFields.some(field =>
        String(previous[field] ?? "") !== String(member[field] ?? ""))) {
        member.rowDate = rowDate;
      }
    }
    runtimeTable.corporations[String(corporationRecord.corporationID)] = normalized;
    return runtimeTable;
  });
}

function getAllianceRuntime(allianceID) {
  const runtimeTable = ensureRuntimeInitialized();
  const runtime = runtimeTable.alliances[String(allianceID)];
  return runtime ? cloneValue(runtime) : null;
}

function updateAllianceRuntime(allianceID, updater) {
  return updateRuntimeState((runtimeTable) => {
    const allianceRecord = getAllianceRecord(allianceID);
    if (!allianceRecord) {
      return runtimeTable;
    }
    const currentRuntime = runtimeTable.alliances[String(allianceRecord.allianceID)];
    const nextRuntime =
      typeof updater === "function"
        ? updater(cloneValue(currentRuntime), allianceRecord, runtimeTable) ||
          currentRuntime
        : currentRuntime;
    runtimeTable.alliances[String(allianceRecord.allianceID)] = normalizeAllianceRuntime(
      nextRuntime,
      allianceRecord,
    );
    return runtimeTable;
  });
}

function listCorporationMembers(corporationID) {
  const runtimeTable = ensureRuntimeInitialized();
  const runtime = runtimeTable.corporations[String(corporationID)] || null;
  const members = runtime && runtime.members ? runtime.members : {};
  return cloneValue(Object.values(members).sort(
    (left, right) => Number(left.characterID) - Number(right.characterID),
  ));
}

function getCorporationMember(corporationID, characterID) {
  const runtimeTable = ensureRuntimeInitialized();
  const runtime = runtimeTable.corporations[String(corporationID)] || null;
  if (!runtime || !runtime.members) {
    return null;
  }
  return cloneValue(runtime.members[String(characterID)] || null);
}

function recordCorporationRoleHistory(corporationID, entry = {}) {
  const numericCorporationID = normalizePositiveInteger(corporationID, null);
  const characterID = normalizePositiveInteger(entry.charID || entry.characterID, null);
  if (!numericCorporationID || !characterID) {
    return false;
  }

  updateCorporationRuntime(numericCorporationID, (runtime) => {
    const rows = Array.isArray(runtime.roleHistory)
      ? runtime.roleHistory
      : [];
    rows.push({
      changeTime: normalizeFiletimeString(entry.changeTime || currentFileTime()),
      oldRoles: normalizeRoleMaskString(entry.oldRoles, "0"),
      newRoles: normalizeRoleMaskString(entry.newRoles, "0"),
      issuerID: normalizeInteger(entry.issuerID, -1),
      corporationID: numericCorporationID,
      charID: characterID,
      grantable: normalizeBoolean(entry.grantable, false) ? 1 : 0,
    });
    runtime.roleHistory = rows.slice(-5000);
    return runtime;
  });
  return true;
}

function getCorporationDivisionNames(corporationID) {
  const runtime = getCorporationRuntime(corporationID);
  return runtime
    ? cloneValue(runtime.divisionNames || buildDefaultDivisionNames())
    : buildDefaultDivisionNames();
}

function getCorporationOffices(corporationID) {
  const runtimeTable = ensureRuntimeInitialized();
  const runtime = runtimeTable.corporations[String(corporationID)] || null;
  if (!runtime || !runtime.offices) {
    return [];
  }
  return cloneValue(Object.values(runtime.offices).sort(
    (left, right) => Number(left.stationID) - Number(right.stationID),
  ));
}

function rebuildOfficesByStationCache() {
  const runtimeTable = ensureRuntimeInitialized();
  const nextStationCache = new Map();
  const nextInventoryCache = new Map();
  for (const runtime of Object.values(runtimeTable.corporations || {})) {
    for (const office of Object.values((runtime && runtime.offices) || {})) {
      const stationID = normalizePositiveInteger(office && office.stationID, null);
      if (!stationID) {
        continue;
      }
      if (!nextStationCache.has(stationID)) {
        nextStationCache.set(stationID, []);
      }
      nextStationCache.get(stationID).push(cloneValue(office));
      for (const inventoryID of [
        normalizePositiveInteger(office && office.officeID, null),
        normalizePositiveInteger(office && office.officeFolderID, null),
        normalizePositiveInteger(office && office.itemID, null),
      ]) {
        if (!inventoryID) {
          continue;
        }
        nextInventoryCache.set(inventoryID, cloneValue(office));
      }
    }
  }
  for (const offices of nextStationCache.values()) {
    offices.sort((left, right) => Number(left.corporationID) - Number(right.corporationID));
  }
  officesByStationCache = nextStationCache;
  officesByInventoryIDCache = nextInventoryCache;
  officesByStationCacheDirty = false;
}

function getOfficesAtStation(stationID) {
  const numericStationID = normalizePositiveInteger(stationID, null);
  if (!numericStationID) {
    return [];
  }
  if (officesByStationCacheDirty) {
    rebuildOfficesByStationCache();
  }
  return cloneValue(officesByStationCache.get(numericStationID) || []);
}

function getCorporationOfficeByInventoryID(corporationID, inventoryID) {
  const numericCorporationID = normalizePositiveInteger(corporationID, null);
  const numericInventoryID = normalizePositiveInteger(inventoryID, null);
  if (!numericCorporationID || !numericInventoryID) {
    return null;
  }
  if (officesByStationCacheDirty) {
    rebuildOfficesByStationCache();
  }
  const office = officesByInventoryIDCache.get(numericInventoryID) || null;
  if (!office || Number(office.corporationID) !== Number(numericCorporationID)) {
    return null;
  }
  return cloneValue(office);
}

function getLockedItemsByLocation(corporationID, locationID) {
  const runtime = getCorporationRuntime(corporationID);
  if (!runtime || !runtime.lockedItemsByLocation) {
    return [];
  }
  const locationState = runtime.lockedItemsByLocation[String(locationID)];
  if (Array.isArray(locationState)) {
    return cloneValue(locationState);
  }
  if (locationState && typeof locationState === "object") {
    return cloneValue(
      Object.values(locationState).sort(
        (left, right) =>
          normalizePositiveInteger(left && left.itemID, 0) -
          normalizePositiveInteger(right && right.itemID, 0),
      ),
    );
  }
  return [];
}

function getLockedItemLocations(corporationID) {
  const runtime = getCorporationRuntime(corporationID);
  if (!runtime || !runtime.lockedItemsByLocation) {
    return [];
  }
  return Object.keys(runtime.lockedItemsByLocation)
    .filter((locationID) => {
      const locationState = runtime.lockedItemsByLocation[locationID];
      if (Array.isArray(locationState)) {
        return locationState.length > 0;
      }
      if (locationState && typeof locationState === "object") {
        return Object.keys(locationState).length > 0;
      }
      return false;
    })
    .map((locationID) => normalizePositiveInteger(locationID, null))
    .filter(Boolean)
    .sort((left, right) => left - right);
}

function updateCorporationRecord(corporationID, changes = {}) {
  const currentRecord = getCorporationRecord(corporationID);
  if (!currentRecord) {
    return { success: false, errorMsg: "CORPORATION_NOT_FOUND" };
  }
  return setCorporationRecord({
    ...cloneValue(currentRecord),
    ...cloneValue(changes),
    corporationID: currentRecord.corporationID,
  });
}

function deleteCorporationWithRuntime(corporationID) {
  const currentRecord = getCorporationRecord(corporationID);
  if (!currentRecord) {
    return { success: false, errorMsg: "CORPORATION_NOT_FOUND" };
  }
  const numericCorporationID = currentRecord.corporationID;
  const table = readCorporationTable();
  delete table.records[String(numericCorporationID)];
  const corporationWrite = writeTable(CORPORATIONS_TABLE, table);
  if (!corporationWrite.success) {
    return corporationWrite;
  }

  updateRuntimeState((runtimeTable) => {
    if (runtimeTable && runtimeTable.corporations) {
      delete runtimeTable.corporations[String(numericCorporationID)];
    }
    return runtimeTable;
  });

  return {
    success: true,
    data: {
      corporationID: numericCorporationID,
      corporationRecord: currentRecord,
    },
  };
}

function updateAllianceRecord(allianceID, changes = {}) {
  const currentRecord = getAllianceRecord(allianceID);
  if (!currentRecord) {
    return { success: false, errorMsg: "ALLIANCE_NOT_FOUND" };
  }
  const table = readAllianceTable();
  table.records[String(allianceID)] = {
    ...(table.records[String(allianceID)] || {}),
    ...cloneValue(currentRecord),
    ...cloneValue(changes),
    allianceID: currentRecord.allianceID,
  };
  return writeTable(ALLIANCES_TABLE, table);
}

function createCorporationWithRuntime(characterID, options = {}) {
  const name = normalizeText(options.name, "").trim();
  if (!name) {
    return {
      success: false,
      errorMsg: "CORPORATION_NAME_REQUIRED",
    };
  }
  const foundingOperationID = normalizeText(
    options.foundingOperationID,
    "",
  ).trim();
  const resumedCorporation = foundingOperationID
    ? findCorporationByFoundingOperationID(foundingOperationID)
    : null;
  if (
    !resumedCorporation &&
    (findCorporationByName(name) || findAllianceByExactName(name))
  ) {
    return {
      success: false,
      errorMsg: "CORPORATION_NAME_TAKEN",
    };
  }
  const tickerName = normalizeText(options.tickerName, "").trim();
  if (
    !resumedCorporation &&
    tickerName &&
    (findCorporationByTickerName(tickerName) ||
      findAllianceByShortName(tickerName))
  ) {
    return {
      success: false,
      errorMsg: "CORPORATION_TICKER_TAKEN",
    };
  }
  const result = resumedCorporation
    ? {
        success: true,
        duplicate: true,
        data: {
          corporationID: resumedCorporation.corporationID,
          corporationRecord: resumedCorporation,
        },
      }
    : createCustomCorporation(characterID, name, { foundingOperationID });
  if (!result.success) {
    return result;
  }
  const corporationID = result.data.corporationID;
  const affiliationResult = setCharacterAffiliation(
    characterID,
    corporationID,
    null,
  );
  if (!affiliationResult.success) {
    return affiliationResult;
  }
  const characterState = getCharacterState();
  const characterRecord =
    characterState && typeof characterState.getCharacterRecord === "function"
      ? characterState.getCharacterRecord(characterID) || {}
      : {};
  const stationID = normalizePositiveInteger(
    options.stationID,
    result.data.corporationRecord && result.data.corporationRecord.stationID,
  );
  const stationRecord = stationID ? getStationRecord(null, stationID) : null;
  const createDate = String(
    result.data.corporationRecord.createDate ||
      result.data.corporationRecord.createdAt ||
      currentFileTime(),
  );
  const updateResult = updateCorporationRecord(corporationID, {
    corporationName: name,
    tickerName: tickerName ||
      (result.data.corporationRecord && result.data.corporationRecord.tickerName),
    description: normalizeText(
      options.description,
      `Capsuleer corporation ${name}.`,
    ),
    url: normalizeText(options.url, ""),
    stationID,
    solarSystemID: normalizePositiveInteger(
      options.solarSystemID || (stationRecord && stationRecord.solarSystemID),
      result.data.corporationRecord && result.data.corporationRecord.solarSystemID,
    ),
    taxRate: Number(options.taxRate || 0),
    loyaltyPointTaxRate: Number(options.loyaltyPointTaxRate || 0),
    friendlyFire: options.friendlyFireEnabled ? 1 : 0,
    memberLimit: 20,
    allowedMemberRaceIDs: normalizePositiveInteger(characterRecord.raceID, 0) || 0,
    corporationType: 0,
    minimumJoinStanding: 0,
    sendCharTerminationMessage: true,
    createDate,
    createdAt: createDate,
    shape1:
      options.shape1 !== undefined
        ? normalizePositiveInteger(options.shape1, null)
        : result.data.corporationRecord.shape1,
    shape2:
      options.shape2 !== undefined
        ? normalizePositiveInteger(options.shape2, null)
        : result.data.corporationRecord.shape2,
    shape3:
      options.shape3 !== undefined
        ? normalizePositiveInteger(options.shape3, null)
        : result.data.corporationRecord.shape3,
    color1:
      options.color1 !== undefined
        ? normalizePositiveInteger(options.color1, null)
        : result.data.corporationRecord.color1,
    color2:
      options.color2 !== undefined
        ? normalizePositiveInteger(options.color2, null)
        : result.data.corporationRecord.color2,
    color3:
      options.color3 !== undefined
        ? normalizePositiveInteger(options.color3, null)
        : result.data.corporationRecord.color3,
    typeface:
      options.typeface !== undefined
        ? normalizePositiveInteger(options.typeface, null)
        : result.data.corporationRecord.typeface,
  });
  if (!updateResult.success) {
    return updateResult;
  }
  updateCorporationRuntime(corporationID, (runtime) => ({
    ...runtime,
    applicationsEnabled:
      options.applicationsEnabled === undefined
        ? 1
        : options.applicationsEnabled
          ? 1
          : 0,
    acceptStructures: false,
    restrictCorpMails: false,
    structureReinforceDefault: DEFAULT_STRUCTURE_REINFORCE_HOUR,
    aggressionSettings: normalizeAggressionSettings(
      options.friendlyFireEnabled
        ? { enableAfter: "0", disableAfter: null }
        : { enableAfter: null, disableAfter: createDate },
      { isNpcCorporation: false },
    ),
  }));
  return {
    success: true,
    data: {
      corporationID,
      corporationRecord: getCorporationRecord(corporationID),
      corporationRuntime: getCorporationRuntime(corporationID),
    },
  };
}

function createAllianceWithRuntime(characterID, corporationID, options = {}) {
  const name = normalizeText(options.name, "").trim();
  const foundingOperationID = normalizeText(
    options.foundingOperationID,
    "",
  ).trim();
  const resumedAlliance = foundingOperationID
    ? findAllianceByFoundingOperationID(foundingOperationID)
    : null;
  const result = createCustomAllianceForCorporation(
    characterID,
    corporationID,
    name,
    {
      shortName: normalizeText(options.shortName, "").trim().toUpperCase(),
      description: normalizeText(
        options.description,
        `Capsuleer alliance ${name}.`,
      ),
      url: normalizeText(options.url, ""),
      foundingOperationID,
    },
  );
  if (!result.success) {
    return result;
  }
  const allianceID = result.data.allianceID;
  // Ensure a runtime row (member join date and initial executor support) is
  // materialized in the same recoverable operation. Retrying a founding UUID
  // repairs affiliation and this projection without allocating another owner.
  const runtimeResult = updateAllianceRuntime(allianceID, (runtime) => runtime);
  if (!runtimeResult || runtimeResult.success !== true) {
    return runtimeResult || { success: false, errorMsg: "ALLIANCE_RUNTIME_FAILED" };
  }
  return {
    success: true,
    duplicate: Boolean(result.duplicate || resumedAlliance),
    data: {
      allianceID,
      allianceRecord: getAllianceRecord(allianceID),
      allianceRuntime: getAllianceRuntime(allianceID),
    },
  };
}

function ensureCharacterMemberState(corporationID, characterID) {
  const currentMember = getCorporationMember(corporationID, characterID);
  if (currentMember) {
    return currentMember;
  }
  updateCorporationRuntime(corporationID, (runtime, corporationRecord) => {
    runtime.members[String(characterID)] = buildDefaultMemberState(
      characterID,
      corporationRecord,
    );
    return runtime;
  });
  return getCorporationMember(corporationID, characterID);
}

function parseKnownRoleMask(value, allowedMask) {
  const roleMask = parseCorporationRoleMask(value, -1n);
  if (
    roleMask < 0n ||
    (roleMask & ~allowedMask) !== 0n
  ) {
    return null;
  }
  return roleMask;
}

function getAssignedMemberTitles(corporationID, memberState) {
  const runtime = getCorporationRuntime(corporationID) || {};
  const rawTitleMask = normalizeInteger(memberState && memberState.titleMask, 0);
  const titleMask = rawTitleMask >= 0 && (rawTitleMask & ~FULL_TITLE_MASK) === 0
    ? rawTitleMask
    : 0;
  return Object.values(runtime.titles || {}).filter((title) => {
    const titleID = normalizeInteger(title && title.titleID, 0);
    return (
      titleID > 0 &&
      (titleID & (titleID - 1)) === 0 &&
      (titleMask & titleID) === titleID
    );
  });
}

function getEffectiveMemberRoleMask(
  corporationID,
  memberState,
  propertyName,
  allowedMask,
  titleAllowedMask = allowedMask,
) {
  const directMask = parseKnownRoleMask(
    memberState && memberState[propertyName],
    allowedMask,
  );
  if (directMask === null) {
    return 0n;
  }
  let effectiveMask = directMask;
  for (const title of getAssignedMemberTitles(corporationID, memberState)) {
    const titleMask = parseKnownRoleMask(
      title && title[propertyName],
      titleAllowedMask,
    );
    if (titleMask !== null) {
      effectiveMask |= titleMask;
    }
  }
  return effectiveMask;
}

function getCorporationGrantableRoleState(corporationID, characterID) {
  const corporation = getCorporationRecord(corporationID);
  const characterState = getCharacterState();
  const character = characterState &&
    typeof characterState.peekCharacterRecord === "function"
    ? characterState.peekCharacterRecord(characterID)
    : characterState && typeof characterState.getCharacterRecord === "function"
      ? characterState.getCharacterRecord(characterID)
      : null;
  const memberState = getCorporationMember(corporationID, characterID);
  if (
    !corporation ||
    corporation.deleted ||
    corporation.isNPC !== false ||
    !character ||
    character.isDeleted || character.deletedAt ||
    Number(character.corporationID) !== Number(corporationID) ||
    !memberState ||
    memberState.deleted ||
    Number(memberState.characterID) !== Number(characterID) ||
    Number(memberState.corporationID) !== Number(corporationID)
  ) {
    return {
      grantableRoles: 0n,
      grantableRolesAtHQ: 0n,
      grantableRolesAtBase: 0n,
      grantableRolesAtOther: 0n,
    };
  }
  const directRoles = parseKnownRoleMask(
    memberState.roles,
    FULL_ADMIN_ROLE_MASK,
  );
  const isCEO =
    Number(corporation && corporation.ceoID) === Number(characterID);
  const isDirector =
    isCEO ||
    (directRoles !== null &&
      (directRoles & CORP_ROLE_DIRECTOR) === CORP_ROLE_DIRECTOR);
  if (isDirector) {
    return {
      grantableRoles: isCEO ? FULL_ADMIN_ROLE_MASK : FULL_GRANTABLE_ROLE_MASK,
      grantableRolesAtHQ: FULL_LOCATIONAL_ROLE_MASK,
      grantableRolesAtBase: FULL_LOCATIONAL_ROLE_MASK,
      grantableRolesAtOther: FULL_LOCATIONAL_ROLE_MASK,
    };
  }
  if (directRoles === null) {
    return {
      grantableRoles: 0n,
      grantableRolesAtHQ: 0n,
      grantableRolesAtBase: 0n,
      grantableRolesAtOther: 0n,
    };
  }
  return {
    grantableRoles: getEffectiveMemberRoleMask(
      corporationID,
      memberState,
      "grantableRoles",
      FULL_GRANTABLE_ROLE_MASK,
    ),
    grantableRolesAtHQ: getEffectiveMemberRoleMask(
      corporationID,
      memberState,
      "grantableRolesAtHQ",
      FULL_LOCATIONAL_ROLE_MASK,
    ),
    grantableRolesAtBase: getEffectiveMemberRoleMask(
      corporationID,
      memberState,
      "grantableRolesAtBase",
      FULL_LOCATIONAL_ROLE_MASK,
    ),
    grantableRolesAtOther: getEffectiveMemberRoleMask(
      corporationID,
      memberState,
      "grantableRolesAtOther",
      FULL_LOCATIONAL_ROLE_MASK,
    ),
  };
}

function getCorporationMemberRoleMask(corporationID, characterID) {
  const corporation = getCorporationRecord(corporationID);
  const character = getCharacterState().peekCharacterRecord(characterID);
  const member = getCorporationMember(corporationID, characterID);
  if (!corporation || corporation.deleted || corporation.isNPC !== false ||
      !character || character.isDeleted || character.deletedAt || Number(character.corporationID) !== Number(corporationID) ||
      !member || member.deleted || Number(member.characterID) !== Number(characterID) ||
      Number(member.corporationID) !== Number(corporationID)) return 0n;
  const roles = getEffectiveMemberRoleMask(corporationID, member, "roles", FULL_ADMIN_ROLE_MASK, FULL_GRANTABLE_ROLE_MASK);
  return Number(corporation.ceoID) === Number(characterID) || (roles & CORP_ROLE_DIRECTOR) !== 0n
    ? ALL_CORPORATION_ROLE_MASK : roles;
}

function getCorporationSessionRoleState(corporationID, characterID) {
  const corporation = getCorporationRecord(corporationID);
  const character = getCharacterState().peekCharacterRecord(characterID);
  const memberState = corporation && !corporation.deleted && character && !character.isDeleted && !character.deletedAt &&
    Number(character.corporationID) === Number(corporationID)
    ? ensureCharacterMemberState(corporationID, characterID) : null;
  if (!memberState || memberState.deleted) {
    return {
      corprole: 0n,
      rolesAtAll: 0n,
      rolesAtBase: 0n,
      rolesAtHQ: 0n,
      rolesAtOther: 0n,
      hqID: null,
      baseID: null,
      accountKey: CORPORATION_WALLET_KEY_START,
    };
  }
  const baseMask = getCorporationMemberRoleMask(corporationID, characterID);
  const isPlayerCorporation = corporation.isNPC === false;
  const isDirector = (baseMask & CORP_ROLE_DIRECTOR) === CORP_ROLE_DIRECTOR;
  // TQ Receiving Corp Roles.txt559 gives Director the complete assignable
  // mask in all five session fields, rather than splitting the domains here.
  const rolesAtAll = baseMask;
  const rolesForScope = (property) => isDirector
    ? ALL_CORPORATION_ROLE_MASK
    : isPlayerCorporation
      ? getEffectiveMemberRoleMask(corporationID, memberState, property, FULL_LOCATIONAL_ROLE_MASK) : 0n;
  const rolesAtBase = rolesForScope("rolesAtBase");
  const rolesAtHQ = rolesForScope("rolesAtHQ");
  const rolesAtOther = rolesForScope("rolesAtOther");
  const hqID = normalizePositiveInteger(
    corporation && corporation.stationID,
    null,
  );
  const baseID = normalizePositiveInteger(memberState.baseID, null);
  const stationID = character && character.structureID ? null : normalizePositiveInteger(character && character.stationID, null);
  return {
    corprole: getCorporationRolesAtLocation({ rolesAtAll, rolesAtHQ, rolesAtBase, rolesAtOther, hqID, baseID }, stationID),
    rolesAtAll,
    rolesAtBase,
    rolesAtHQ,
    rolesAtOther,
    hqID,
    baseID,
    accountKey: normalizeInteger(
      memberState.accountKey,
      CORPORATION_WALLET_KEY_START,
    ),
  };
}

function syncMemberStateToCharacterRecord(corporationID, characterID) {
  const memberState = getCorporationMember(corporationID, characterID);
  if (!memberState) {
    return;
  }
  const characterState = getCharacterState();
  const updateCharacterRecord =
    characterState && typeof characterState.updateCharacterRecord === "function"
      ? characterState.updateCharacterRecord
      : null;
  if (typeof updateCharacterRecord !== "function") {
    return;
  }
  updateCharacterRecord(characterID, (record) => {
    record.title = memberState.title || "";
    record.baseID = normalizePositiveInteger(memberState.baseID, null);
    record.divisionID = normalizeNullableInteger(memberState.divisionID);
    record.squadronID = normalizeNullableInteger(memberState.squadronID);
    return record;
  });
}

function getPageForMembers(pageNumber = 1) {
  const page = Math.max(1, normalizeInteger(pageNumber, 1));
  return {
    start: (page - 1) * PAGE_SIZE,
    end: page * PAGE_SIZE,
  };
}

module.exports = {
  getDirectMemberRoleMasks,
  roundMemberRowDate,
  CORPORATION_RUNTIME_TABLE,
  CORPORATION_WALLET_KEY_START,
  CORP_ROLE_DIRECTOR,
  CORP_ROLE_ACCOUNTANT,
  CORP_ROLE_BRAND_MANAGER,
  CORP_ROLE_CAN_RENT_OFFICE,
  CORP_ROLE_CHAT_MANAGER,
  CORP_ROLE_DIPLOMAT,
  CORP_ROLE_JUNIOR_ACCOUNTANT,
  CORP_ROLE_PERSONNEL_MANAGER,
  CORP_ROLE_PROJECT_MANAGER,
  CORP_ROLE_TRADER,
  ALL_CORPORATION_ROLE_MASK,
  FULL_ADMIN_ROLE_MASK,
  FULL_GRANTABLE_ROLE_MASK,
  FULL_LOCATIONAL_ROLE_MASK,
  FULL_TITLE_MASK,
  PAGE_SIZE,
  DEFAULT_STRUCTURE_REINFORCE_HOUR,
  buildDefaultDivisionNames,
  buildDefaultMemberState,
  buildDefaultTitleMap,
  cloneValue,
  createAllianceWithRuntime,
  createCorporationWithRuntime,
  deleteCorporationWithRuntime,
  ensureCharacterMemberState,
  ensureRuntimeInitialized,
  getAllianceRuntime,
  getCorporationDivisionNames,
  getCorporationMember,
  getCorporationOfficeByInventoryID,
  getCorporationOffices,
  getCorporationRuntime,
  getCorporationGrantableRoleState,
  getCorporationWalletDivisionTakeRole,
  getOfficesAtStation,
  getCorporationSessionRoleState,
  getCorporationMemberRoleMask,
  getLockedItemLocations,
  getLockedItemsByLocation,
  getPageForMembers,
  listCorporationMembers,
  normalizeFiletimeString,
  normalizeBoolean,
  normalizeInteger,
  normalizePositiveInteger,
  normalizeRoleMaskString,
  normalizeText,
  recordCorporationRoleHistory,
  setCorporationAlliance,
  syncMemberStateToCharacterRecord,
  toRoleMaskBigInt,
  updateAllianceRecord,
  updateAllianceRuntime,
  updateCorporationRecord,
  updateCorporationRuntime,
  updateRuntimeState,
  _testing: {
    resetRuntimeCaches,
  },
};
