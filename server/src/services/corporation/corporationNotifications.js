"use strict";

const {
  cloneValue,
} = require("../../common/clone");

const path = require("path");
const { getCorporationRolesAtLocation } = require("./corporationRoleChecks");
const { buildWarPayload, buildWarSnapshot } = require("./warPayloads");
const log = require(path.join(__dirname, "../../utils/logger"));

const {
  buildFiletimeLong,
  buildList,
  buildPackedRow,
  buildPythonSet,
  currentFileTime,
} = require(path.join(__dirname, "../_shared/serviceHelpers"));
const {
  getAllianceCorporationIDs,
  getAllianceRecord,
  getCorporationInfoRecord,
  getCorporationRecord,
  getOwnerLookupRecord,
} = require(path.join(__dirname, "./corporationState"));
const {
  CORPORATION_WALLET_KEY_START,
  CORP_ROLE_ACCOUNTANT,
  CORP_ROLE_DIRECTOR,
  CORP_ROLE_JUNIOR_ACCOUNTANT,
  getAllianceRuntime,
  getCorporationDivisionNames,
  getCorporationMember,
  getCorporationMemberRoleMask,
  getCorporationWalletDivisionTakeRole,
  getDirectMemberRoleMasks,
  getCorporationRuntime,
  getCorporationSessionRoleState,
  listCorporationMembers,
  normalizePositiveInteger,
  toRoleMaskBigInt,
  roundMemberRowDate,
} = require(path.join(__dirname, "./corporationRuntimeState"));
const {
  getWarPermitStatusForOwner,
} = require(path.join(__dirname, "./warPermitState"));
const {
  getAllianceCapitalInfo: getSovereigntyAllianceCapitalInfo,
  getAlliancePrimeInfo: getSovereigntyAlliancePrimeInfo,
} = require(path.join(__dirname, "../sovereignty/sovState"));
const {
  getSessions,
  findSessionByCharacterID,
} = require(path.join(__dirname, "../chat/sessionRegistry"));
const {
  getDockedLocationID,
  getDockedLocationKind,
  getSessionStationID,
} = require(path.join(__dirname, "../structure/structureLocation"));
const {
  getAllianceExecutorDirectorAuthority,
  getAllianceMemberAuthority,
  getPersistedCorporationAuthority,
} = require(path.join(__dirname, "./corporationAuthority"));
const {
  getAllianceApplication,
} = require(path.join(__dirname, "./allianceApplicationState"));
const {
  toPublicSolarSystemID,
} = require("../../abyssal").engineSupport.hostLocation;

const OFFICE_TYPE_ID = 27;
const OFFICE_GROUP_ID = 16;
const OFFICE_CATEGORY_ID = 3;
const LOCATION_JUNKYARD = 10;
const FLAG_OFFICE_FOLDER = 2;
const FLAG_IMPOUNDED = 6;
const CORP_ROLE_PERSONNEL_MANAGER = 128n;
// walletSvc.OnShareChange uses compiled walletUtil.HaveAccessToCorpWallet:
// accountants, junior accountants, or any accessible wallet division.
const CORPORATION_SHARE_VIEW_ROLES = Array.from({ length: 7 }, (_, index) =>
  getCorporationWalletDivisionTakeRole(CORPORATION_WALLET_KEY_START + index)
).reduce((mask, role) => mask | role, CORP_ROLE_ACCOUNTANT | CORP_ROLE_JUNIOR_ACCOUNTANT);
const INVENTORY_ROW_DESCRIPTOR_COLUMNS = [
  ["itemID", 20],
  ["typeID", 3],
  ["ownerID", 3],
  ["locationID", 20],
  ["flagID", 2],
  ["quantity", 3],
  ["groupID", 3],
  ["categoryID", 3],
  ["customInfo", 129],
];
const INVENTORY_ROW_DESCRIPTOR_VIRTUAL_COLUMNS = [
  ["stacksize", { type: "token", value: "eve.common.script.sys.eveCfg.StackSize" }],
  ["singleton", { type: "token", value: "eve.common.script.sys.eveCfg.Singleton" }],
];

function getCharacterStateService() {
  return require(path.join(__dirname, "../character/characterState"));
}

function applyCharacterRecordToSession(session, characterID, options = {}) {
  const characterState = getCharacterStateService();
  return characterState && typeof characterState.applyCharacterToSession === "function"
    ? characterState.applyCharacterToSession(session, characterID, options)
    : { success: false, errorMsg: "CHARACTER_STATE_UNAVAILABLE" };
}

const CORPORATION_HEADER = [
  "corporationID",
  "corporationName",
  "ticker",
  "tickerName",
  "ceoID",
  "creatorID",
  "allianceID",
  "factionID",
  "warFactionID",
  "membership",
  "description",
  "url",
  "stationID",
  "deleted",
  "taxRate",
  "loyaltyPointTaxRate",
  "friendlyFire",
  "memberCount",
  "memberLimit",
  "shares",
  "allowWar",
  "allowedMemberRaceIDs",
  "corporationType",
  "minimumJoinStanding",
  "sendCharTerminationMessage",
  "createDate",
  "aggressionEnableAfter",
  "aggressionDisableAfter",
  "applicationsEnabled",
  "division1",
  "division2",
  "division3",
  "division4",
  "division5",
  "division6",
  "division7",
  "walletDivision1",
  "walletDivision2",
  "walletDivision3",
  "walletDivision4",
  "walletDivision5",
  "walletDivision6",
  "walletDivision7",
  "shape1",
  "shape2",
  "shape3",
  "color1",
  "color2",
  "color3",
  "typeface",
  "isRecruiting",
];

const CORPORATION_MEMBER_HEADER = [
  "characterID",
  "corporationID",
  "startDateTime",
  "title",
  "divisionID",
  "squadronID",
  "roles",
  "grantableRoles",
  "rolesAtHQ",
  "grantableRolesAtHQ",
  "rolesAtBase",
  "grantableRolesAtBase",
  "rolesAtOther",
  "grantableRolesAtOther",
  "baseID",
  "titleMask",
  "blockRoles",
  "accountKey",
  "rowDate",
  "ownerName",
];
const CORPORATION_TITLE_HEADER = [
  "titleID",
  "titleName",
  "roles",
  "grantableRoles",
  "rolesAtHQ",
  "grantableRolesAtHQ",
  "rolesAtBase",
  "grantableRolesAtBase",
  "rolesAtOther",
  "grantableRolesAtOther",
];

const SHAREHOLDER_CHANGE_HEADER = [
  "corporationID",
  "shareholderCorporationID",
  "shareholderID",
  "shares",
];

const CORPORATION_APPLICATION_HEADER = [
  "applicationID",
  "corporationID",
  "characterID",
  "applicationText",
  "status",
  "applicationDateTime",
  "deleted",
  "responseText",
];
const CORPORATION_APPLICATION_DBROW_COLUMNS = [
  ["applicationID", 0x03],
  ["corporationID", 0x03],
  ["characterID", 0x03],
  ["applicationText", 0x82],
  ["status", 0x11],
  ["applicationDateTime", 0x40],
  ["deleted", 0x0b],
  ["responseText", 0x81],
];

const ALLIANCE_HEADER = [
  "allianceID",
  "allianceName",
  "shortName",
  "executorCorpID",
  "creatorCorpID",
  "creatorCharID",
  "warFactionID",
  "description",
  "url",
  "startDate",
  "memberCount",
  "dictatorial",
  "allowWar",
  "currentCapital",
  "currentPrimeHour",
  "newPrimeHour",
  "newPrimeHourValidAfter",
  "deleted",
];

const ALLIANCE_MEMBER_HEADER = [
  "corporationID",
  "allianceID",
  "chosenExecutorID",
  "startDate",
  "deleted",
];

const ALLIANCE_APPLICATION_HEADER = [
  "allianceID",
  "corporationID",
  "applicationText",
  "state",
  "applicationDateTime",
];

const ALLIANCE_RELATIONSHIP_HEADER = [
  "toID",
  "relationship",
];

function buildLong(value) {
  return {
    type: "long",
    value: toRoleMaskBigInt(value, 0n),
  };
}

function normalizeValueForCompare(value) {
  if (value === undefined) {
    return null;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeValueForCompare(entry));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entryValue]) => [
        key,
        normalizeValueForCompare(entryValue),
      ]),
    );
  }
  return value;
}

function areValuesEqual(left, right) {
  return JSON.stringify(normalizeValueForCompare(left)) ===
    JSON.stringify(normalizeValueForCompare(right));
}

function buildChangeDict(beforeSnapshot, afterSnapshot, header = null) {
  const before = beforeSnapshot && typeof beforeSnapshot === "object"
    ? beforeSnapshot
    : null;
  const after = afterSnapshot && typeof afterSnapshot === "object"
    ? afterSnapshot
    : null;
  if (!before && !after) {
    return {
      type: "dict",
      entries: [],
    };
  }
  const columns = Array.isArray(header) && header.length > 0
    ? header
    : Array.from(
        new Set([
          ...Object.keys(before || {}),
          ...Object.keys(after || {}),
        ]),
      );
  const entries = [];
  for (const columnName of columns) {
    const oldValue = before ? before[columnName] : null;
    const newValue = after ? after[columnName] : null;
    if (before && after && areValuesEqual(oldValue, newValue)) {
      continue;
    }
    entries.push([columnName, [oldValue ?? null, newValue ?? null]]);
  }
  return {
    type: "dict",
    entries,
  };
}

function buildCorporationSnapshot(corporationID) {
  const info = getCorporationInfoRecord(corporationID);
  if (!info) {
    return null;
  }
  const runtime = getCorporationRuntime(corporationID) || {};
  const divisionNames = getCorporationDivisionNames(corporationID);
  return {
    corporationID: info.corporationID,
    corporationName: info.corporationName,
    ticker: info.ticker,
    tickerName: info.tickerName || info.ticker,
    ceoID: info.ceoID,
    creatorID: info.creatorID,
    allianceID: info.allianceID,
    factionID: info.factionID ?? null,
    warFactionID: info.warFactionID ?? info.factionID ?? null,
    membership: 1,
    description: info.description || "",
    url: info.url || "",
    stationID: info.stationID,
    deleted: info.deleted,
    taxRate: info.taxRate,
    loyaltyPointTaxRate: info.loyaltyPointTaxRate || 0.0,
    friendlyFire: info.friendlyFire || 0,
    memberCount: info.memberCount,
    memberLimit: info.memberLimit,
    shares: info.shares,
    allowWar: info.allowWar,
    allowedMemberRaceIDs: info.allowedMemberRaceIDs,
    corporationType: info.corporationType,
    minimumJoinStanding: info.minimumJoinStanding,
    sendCharTerminationMessage: info.sendCharTerminationMessage,
    createDate: info.createDate ? buildFiletimeLong(info.createDate) : null,
    aggressionEnableAfter: info.aggressionEnableAfter
      ? buildFiletimeLong(info.aggressionEnableAfter)
      : null,
    aggressionDisableAfter: info.aggressionDisableAfter
      ? buildFiletimeLong(info.aggressionDisableAfter)
      : null,
    applicationsEnabled: runtime.applicationsEnabled || 0,
    division1: divisionNames[1],
    division2: divisionNames[2],
    division3: divisionNames[3],
    division4: divisionNames[4],
    division5: divisionNames[5],
    division6: divisionNames[6],
    division7: divisionNames[7],
    walletDivision1: divisionNames[8],
    walletDivision2: divisionNames[9],
    walletDivision3: divisionNames[10],
    walletDivision4: divisionNames[11],
    walletDivision5: divisionNames[12],
    walletDivision6: divisionNames[13],
    walletDivision7: divisionNames[14],
    shape1: info.shape1 ?? null,
    shape2: info.shape2 ?? null,
    shape3: info.shape3 ?? null,
    color1: info.color1 ?? null,
    color2: info.color2 ?? null,
    color3: info.color3 ?? null,
    typeface: info.typeface ?? null,
    isRecruiting: runtime.applicationsEnabled === 0 ? 0 : 1,
  };
}

function buildCorporationMemberSnapshot(corporationID, characterID) {
  const member = getCorporationMember(corporationID, characterID);
  if (!member) {
    return null;
  }
  const masks = getDirectMemberRoleMasks(member);
  const character = getCharacterStateService().getCharacterRecord(characterID) || {};
  const owner = getOwnerLookupRecord(characterID) || {};
  return {
    characterID: member.characterID,
    corporationID: member.corporationID,
    startDateTime: buildFiletimeLong(roundMemberRowDate(member.startDate)),
    title: { type: "wstring", value: member.title || "" },
    divisionID: member.divisionID ?? null,
    squadronID: member.squadronID ?? null,
    roles: buildLong(masks.roles),
    grantableRoles: buildLong(masks.grantableRoles),
    rolesAtHQ: buildLong(masks.rolesAtHQ),
    grantableRolesAtHQ: buildLong(masks.grantableRolesAtHQ),
    rolesAtBase: buildLong(masks.rolesAtBase),
    grantableRolesAtBase: buildLong(masks.grantableRolesAtBase),
    rolesAtOther: buildLong(masks.rolesAtOther),
    grantableRolesAtOther: buildLong(masks.grantableRolesAtOther),
    baseID: member.baseID || null,
    titleMask: member.titleMask || 0,
    blockRoles: toRoleMaskBigInt(member.blockRoles, 0n) !== 0n,
    accountKey: member.accountKey ?? null,
    rowDate: buildFiletimeLong(roundMemberRowDate(member.rowDate || member.startDate)),
    ownerName: { type: "wstring", value: character.characterName || character.ownerName || owner.ownerName || `Character ${characterID}` },
  };
}

function buildCorporationApplicationRow(application = null) {
  if (!application) {
    return null;
  }
  const responseText = Object.prototype.hasOwnProperty.call(application, "responseText")
    ? application.responseText
    : application.customMessage
      ? application.customMessage
      : null;
  return buildPackedRow(CORPORATION_APPLICATION_DBROW_COLUMNS, {
    applicationID: Number(application.applicationID || 0),
    corporationID: Number(application.corporationID || 0),
    characterID: Number(application.characterID || 0),
    // TQ Applying and accepting a corp invite.txt1382 explicitly marshals
    // Unicode here. DBRow::Read/Get preserves the text object's native type;
    // the WSTR descriptor alone does not convert a Python byte string.
    applicationText: { type: "wstring", value: application.applicationText || "" },
    status: Number(application.status || 0),
    applicationDateTime: buildFiletimeLong(application.applicationDateTime || "0"),
    deleted: Boolean(application.deleted),
    responseText,
  });
}

function buildAllianceSummary(allianceID) {
  const allianceRecord = getAllianceRecord(allianceID);
  if (!allianceRecord) {
    return null;
  }
  const runtime = getAllianceRuntime(allianceID) || {};
  const sovPrimeInfo = getSovereigntyAlliancePrimeInfo(allianceID);
  const sovCapitalInfo = getSovereigntyAllianceCapitalInfo(allianceID);
  const executorCorporationID = normalizePositiveInteger(
    allianceRecord.executorCorporationID,
    null,
  );
  const executorCorporation = executorCorporationID
    ? getCorporationRecord(executorCorporationID)
    : null;
  const hasExplicitAllowWar =
    Object.prototype.hasOwnProperty.call(allianceRecord, "allowWar") &&
    allianceRecord.allowWar !== undefined &&
    allianceRecord.allowWar !== null;
  return {
    allianceID: allianceRecord.allianceID,
    allianceName: allianceRecord.allianceName || `Alliance ${allianceRecord.allianceID}`,
    shortName: allianceRecord.shortName || "ALLY",
    executorCorpID: executorCorporationID,
    creatorCorpID: normalizePositiveInteger(
      allianceRecord.creatorCorpID || allianceRecord.executorCorporationID,
      null,
    ),
    creatorCharID: normalizePositiveInteger(
      allianceRecord.creatorCharID || allianceRecord.creatorID,
      null,
    ),
    warFactionID: normalizePositiveInteger(
      allianceRecord.warFactionID,
      normalizePositiveInteger(executorCorporation && executorCorporation.factionID, null),
    ),
    description: allianceRecord.description || "",
    url: allianceRecord.url || "",
    startDate: buildFiletimeLong(allianceRecord.createdAt || 0n),
    memberCount: getAllianceCorporationIDs(allianceRecord.allianceID).reduce(
      (count, corporationID) => count + listCorporationMembers(corporationID).length,
      0,
    ),
    dictatorial: allianceRecord.dictatorial ? 1 : 0,
    allowWar: hasExplicitAllowWar
      ? allianceRecord.allowWar
        ? 1
        : 0
      : getWarPermitStatusForOwner(allianceRecord.allianceID),
    currentCapital: sovCapitalInfo.currentCapitalSystem || null,
    currentPrimeHour: sovPrimeInfo.currentPrimeHour || 0,
    newPrimeHour: sovPrimeInfo.newPrimeHour || 0,
    newPrimeHourValidAfter: buildFiletimeLong(sovPrimeInfo.newPrimeHourValidAfter || "0"),
    deleted: allianceRecord.deleted ? 1 : 0,
  };
}

function buildAllianceMemberSnapshot(allianceID, corporationID) {
  const alliance = getAllianceRecord(allianceID);
  if (!alliance) {
    return null;
  }
  const memberCorporationIDs = new Set(getAllianceCorporationIDs(allianceID));
  if (!memberCorporationIDs.has(Number(corporationID))) {
    return null;
  }
  const runtime = getAllianceRuntime(allianceID) || {};
  const joinedAt =
    runtime.memberJoinedAtByCorporation &&
    runtime.memberJoinedAtByCorporation[String(corporationID)]
      ? runtime.memberJoinedAtByCorporation[String(corporationID)]
      : String(alliance.createdAt || currentFileTime());
  return {
    corporationID: Number(corporationID),
    allianceID,
    chosenExecutorID: normalizePositiveInteger(
      runtime.executorSupportByCorporation &&
        runtime.executorSupportByCorporation[String(corporationID)],
      null,
    ),
    startDate: buildFiletimeLong(joinedAt),
    deleted: 0,
  };
}

function buildAllianceApplicationSnapshot(allianceID, corporationID) {
  const application = getAllianceApplication(allianceID, corporationID);
  if (!application) {
    return null;
  }
  return {
    allianceID: Number(application.allianceID || allianceID),
    corporationID: Number(corporationID),
    applicationText: application.applicationText || "",
    state: Number(application.state || 0),
    applicationDateTime: buildFiletimeLong(application.applicationDateTime || "0"),
  };
}

function buildAllianceRelationshipSnapshot(allianceID, toID) {
  const runtime = getAllianceRuntime(allianceID) || {};
  if (
    !runtime.relationships ||
    !Object.prototype.hasOwnProperty.call(runtime.relationships, String(toID))
  ) {
    return null;
  }
  return {
    toID: Number(toID),
    relationship: Number(runtime.relationships[String(toID)] || 0),
  };
}

function buildWarOwnerIDs(war = null) {
  const ownerIDs = new Set();
  if (!war) {
    return [];
  }
  const declaredByID = normalizePositiveInteger(war.declaredByID, null);
  const againstID = normalizePositiveInteger(war.againstID, null);
  if (declaredByID) {
    ownerIDs.add(declaredByID);
  }
  if (againstID) {
    ownerIDs.add(againstID);
  }
  for (const allyID of Object.keys(war.allies || {})) {
    const numericAllyID = normalizePositiveInteger(allyID, null);
    if (numericAllyID) {
      ownerIDs.add(numericAllyID);
    }
  }
  return [...ownerIDs].sort((left, right) => left - right);
}

function getSessionCharacterID(session) {
  return normalizePositiveInteger(
    session && (session.characterID || session.charid),
    null,
  );
}

function getSessionCorporationID(session) {
  return normalizePositiveInteger(
    session && (session.corporationID || session.corpid),
    null,
  );
}

function sendNotificationToAllSessions(notifyType, idType, payloadTuple = []) {
  for (const session of getSessions()) {
    try {
      session.sendNotification(notifyType, idType, payloadTuple);
    } catch (error) {
      // Keep parity notifications non-fatal on the write path.
      log.debug(`[CorporationNotifications] ${notifyType} to client ${session.clientID} failed: ${error && error.message}`);
    }
  }
}

// To the sessions docked in a station or a structure.
function sendNotificationToDockedSessions(
  locationID,
  notifyType,
  idType,
  payloadTuple = [],
) {
  const numericLocationID = normalizePositiveInteger(locationID, null);
  if (!numericLocationID) {
    return;
  }
  for (const session of getSessions()) {
    if (Number(getDockedLocationID(session)) !== Number(numericLocationID)) {
      continue;
    }
    try {
      session.sendNotification(notifyType, idType, payloadTuple);
    } catch (error) {
      // Keep parity notifications non-fatal on the write path.
      log.debug(`[CorporationNotifications] ${notifyType} to client ${session.clientID} failed: ${error && error.message}`);
    }
  }
}

function sendNotificationToCharacterIDs(
  characterIDs,
  notifyType,
  idType,
  payloadTuple = [],
) {
  const recipients = new Set(
    (Array.isArray(characterIDs) ? characterIDs : [characterIDs])
      .map((characterID) => normalizePositiveInteger(characterID, null))
      .filter((characterID) => characterID !== null),
  );
  if (recipients.size <= 0) {
    return;
  }
  for (const session of getSessions()) {
    if (!recipients.has(getSessionCharacterID(session))) {
      continue;
    }
    try {
      session.sendNotification(notifyType, idType, payloadTuple);
    } catch (error) {
      // Keep parity notifications non-fatal on the write path.
      log.debug(`[CorporationNotifications] ${notifyType} to client ${session.clientID} failed: ${error && error.message}`);
    }
  }
}

function sendNotificationToCorporationSessions(
  corporationID,
  notifyType,
  idType,
  payloadTuple = [],
) {
  const numericCorporationID = normalizePositiveInteger(corporationID, null);
  if (!numericCorporationID) {
    return;
  }
  for (const session of getSessions()) {
    const authority = getPersistedCorporationAuthority(session);
    if (!authority || Number(authority.corporationID) !== Number(numericCorporationID)) {
      continue;
    }
    try {
      session.sendNotification(notifyType, idType, payloadTuple);
    } catch (error) {
      // Keep parity notifications non-fatal on the write path.
      log.debug(`[CorporationNotifications] ${notifyType} to client ${session.clientID} failed: ${error && error.message}`);
    }
  }
}

/**
 * addressbookService.OnOrganizationContactsUpdated(ownerID, updates) (157 to 191): the corporation's or the
 * alliance's contacts changed, told to every session of that owner's members, the writer's among them (the client
 * changes what it keeps of them at this word alone). Each update is (contactID, level, labelMask): a standing set is
 * (contactID, relationshipID, None), a contact taken away (contactID, None, None).
 */
function notifyOrganizationContactsUpdated(ownerID, updates) {
  const numericOwnerID = normalizePositiveInteger(ownerID, null);
  const rows = (Array.isArray(updates) ? updates : []).filter((update) => Array.isArray(update) && update.length === 3);
  if (!numericOwnerID || rows.length <= 0) {
    return;
  }
  const payload = [numericOwnerID, rows];
  for (const session of getSessions()) {
    const authority = getPersistedCorporationAuthority(session);
    const corporationMember = Boolean(authority && authority.corporationID === numericOwnerID);
    const allianceMember = !corporationMember && getAllianceMemberAuthority(session, numericOwnerID);
    if (!corporationMember && !allianceMember) {
      continue;
    }
    try {
      // To the corporation's members as the corporation's, to the alliance's as the alliance's.
      const idType = corporationMember ? "corpid" : "allianceid";
      session.sendNotification("OnOrganizationContactsUpdated", idType, payload);
    } catch (error) {
      // Keep parity notifications non-fatal on the write path.
      log.debug(`[CorporationNotifications] OnOrganizationContactsUpdated to client ${session.clientID} failed: ${error && error.message}`);
    }
  }
}

function corporationMemberCanProcessApplications(member) {
  if (!member) {
    return false;
  }
  const roleMask = getCorporationMemberRoleMask(member.corporationID, member.characterID);
  return (
    (roleMask & CORP_ROLE_DIRECTOR) === CORP_ROLE_DIRECTOR ||
    (roleMask & CORP_ROLE_PERSONNEL_MANAGER) === CORP_ROLE_PERSONNEL_MANAGER
  );
}

function resolveApplicationChangeRecipientIDs(corporationID, applicantID) {
  const recipientIDs = new Set();
  const numericApplicantID = normalizePositiveInteger(applicantID, null);
  if (numericApplicantID) {
    recipientIDs.add(numericApplicantID);
  }

  const info = getCorporationInfoRecord(corporationID);
  const ceoID = normalizePositiveInteger(info && info.ceoID, null);
  if (ceoID) {
    recipientIDs.add(ceoID);
  }

  for (const member of listCorporationMembers(corporationID)) {
    const characterID = normalizePositiveInteger(member && member.characterID, null);
    if (!characterID || !corporationMemberCanProcessApplications(member)) {
      continue;
    }
    recipientIDs.add(characterID);
  }
  return [...recipientIDs];
}

function refreshCharacterSession(characterID, options = {}) {
  const session = findSessionByCharacterID(characterID);
  if (!session) {
    return;
  }
  try {
    applyCharacterRecordToSession(session, Number(characterID), {
      selectionEvent: false,
      emitNotifications: true,
      includeRoleChanges: true,
      logSelection: false,
      inventoryBootstrap: false,
      ...(options && typeof options === "object" ? options : {}),
    });
  } catch (error) {
    // Session refresh is best-effort only.
    log.debug(`[CorporationNotifications] session refresh for character ${characterID} failed: ${error && error.message}`);
  }
}

function refreshCharacterCorporationRoles(corporationID, characterID) {
  try {
    const session = findSessionByCharacterID(characterID);
    const authority = session && getPersistedCorporationAuthority(session);
    if (!authority || Number(authority.corporationID) !== Number(corporationID)) return false;
    const next = getCorporationSessionRoleState(corporationID, characterID);
    // Recompose against the active session's location, not a possibly older
    // persisted ship/location record. A role grant must not bootstrap inventory,
    // reset a live movement, or select a corporation wallet for the player.
    next.corprole = getCorporationRolesAtLocation(next,
      getDockedLocationKind(session) === "station" ? getSessionStationID(session) : 0);
    const changes = {};
    for (const field of ["corprole", "rolesAtAll", "rolesAtHQ", "rolesAtBase", "rolesAtOther", "hqID", "baseID"]) {
      const previous = session[field] ?? null;
      session[field] = next[field];
      if (previous !== next[field]) changes[field] = [previous, next[field]];
    }
    if (Object.keys(changes).length && typeof session.sendSessionChange === "function") {
      session.sendSessionChange(changes);
    }
    return true;
  } catch (error) {
    log.debug(`[CorporationNotifications] role refresh for character ${characterID} failed: ${error && error.message}`);
    return false;
  }
}

function notifyCorporationChanged(corporationID, previousSnapshot = null) {
  const nextSnapshot = buildCorporationSnapshot(corporationID);
  const change = buildChangeDict(previousSnapshot, nextSnapshot, CORPORATION_HEADER);
  if (change.entries.length <= 0) {
    return;
  }
  // TQ broadcasts a corporation's change as clientID (golden log "Create
  // Corp"); its removal also goes to corpid (notifyCorporationRemoved).
  sendNotificationToAllSessions("OnCorporationChanged", "clientID", [
    Number(corporationID),
    change,
  ]);
}

function notifyCorporationRemoved(corporationID, previousSnapshot = null, options = {}) {
  const numericCorporationID = normalizePositiveInteger(corporationID, null);
  if (!numericCorporationID) {
    return;
  }
  const change = buildChangeDict(previousSnapshot, null, CORPORATION_HEADER);
  if (change.entries.length <= 0) {
    return;
  }
  const payloadTuple = [numericCorporationID, change];
  sendNotificationToAllSessions(
    "OnCorporationChanged",
    "corpid",
    payloadTuple,
  );
  const clientCharacterIDs = Array.isArray(options.clientCharacterIDs)
    ? options.clientCharacterIDs
    : [];
  if (clientCharacterIDs.length > 0) {
    sendNotificationToCharacterIDs(
      clientCharacterIDs,
      "OnCorporationChanged",
      "clientID",
      payloadTuple,
    );
  }
}

function notifyShareChange(idType, shareholderID, corporationID, beforeSnapshot, afterSnapshot, options = {}) {
  const numericShareholderID = normalizePositiveInteger(shareholderID, null);
  const numericCorporationID = normalizePositiveInteger(corporationID, null);
  if (!numericShareholderID || !numericCorporationID) {
    return;
  }
  const change = buildChangeDict(
    beforeSnapshot,
    afterSnapshot,
    SHAREHOLDER_CHANGE_HEADER,
  );
  if (change.entries.length <= 0) {
    return;
  }
  const payloadTuple = [
    numericShareholderID,
    numericCorporationID,
    change,
  ];
  if (idType === "charid") {
    sendNotificationToCharacterIDs(
      options.clientCharacterIDs || [numericShareholderID],
      "OnShareChange",
      idType,
      payloadTuple,
    );
    return;
  }
  // The corporate shareholder owns this holding; broadcasting it to the issuer
  // or an unrelated corporation corrupts bco_shares' own corpShares cache.
  // Match the server-owned session selector, including liquidation's old session
  // before its affiliation refresh; persisted membership is already gone then.
  for (const session of getSessions()) {
    if (getSessionCorporationID(session) !== numericShareholderID ||
        (toRoleMaskBigInt(session.corprole, 0n) & CORPORATION_SHARE_VIEW_ROLES) === 0n) continue;
    try { session.sendNotification("OnShareChange", idType, payloadTuple); }
    catch (error) { log.debug(`[CorporationNotifications] OnShareChange to client ${session.clientID} failed: ${error && error.message}`); }
  }
}

function buildShareSnapshot(corporationID, shareholderID, shares) {
  if (!(Number(shares) > 0)) return null;
  const character = getCharacterStateService().peekCharacterRecord(shareholderID);
  return {
    corporationID: Number(corporationID),
    shareholderCorporationID: character
      ? normalizePositiveInteger(character.corporationID, null) : null,
    shareholderID: Number(shareholderID),
    shares: buildLong(shares),
  };
}

function notifyCorporationShareChanges(corporationID, beforeShares, afterShares, holderOrder = []) {
  const before = beforeShares || {}, after = afterShares || {};
  const holders = new Set([...holderOrder.map(String), ...Object.keys(before), ...Object.keys(after)]);
  for (const holder of holders) {
    const shareholderID = normalizePositiveInteger(holder, null);
    if (!shareholderID) continue;
    const character = getCharacterStateService().peekCharacterRecord(shareholderID);
    notifyShareChange(
      character ? "charid" : "*corpid&corprole",
      shareholderID,
      corporationID,
      buildShareSnapshot(corporationID, shareholderID, before[holder]),
      buildShareSnapshot(corporationID, shareholderID, after[holder]),
    );
  }
}

function notifyCorporationLiquidationShareTransfer(corporationID, characterID, shares) {
  const numericCorporationID = normalizePositiveInteger(corporationID, null);
  const numericCharacterID = normalizePositiveInteger(characterID, null);
  const normalizedShares = Math.max(0, Number(shares) || 0);
  if (!numericCorporationID || !numericCharacterID || normalizedShares <= 0) {
    return;
  }
  notifyShareChange(
    "*corpid&corprole",
    numericCorporationID,
    numericCorporationID,
    {
      corporationID: numericCorporationID,
      shareholderID: numericCorporationID,
      shares: buildLong(normalizedShares),
    },
    null,
  );
  notifyShareChange(
    "charid",
    numericCharacterID,
    numericCorporationID,
    null,
    {
      corporationID: numericCorporationID,
      shareholderCorporationID: numericCorporationID,
      shareholderID: numericCharacterID,
      shares: buildLong(normalizedShares),
    },
    { clientCharacterIDs: [numericCharacterID] },
  );
}

function notifyCorporationMemberChanged(
  corporationID,
  characterID,
  previousSnapshot = null,
  options = {},
) {
  const nextSnapshot = Object.prototype.hasOwnProperty.call(options, "nextSnapshot")
    ? options.nextSnapshot
    : buildCorporationMemberSnapshot(corporationID, characterID);
  const change = buildChangeDict(
    previousSnapshot,
    nextSnapshot,
    options.header || CORPORATION_MEMBER_HEADER,
  );
  if (change.entries.length <= 0) {
    return;
  }
  const payloadTuple = [
    Number(corporationID),
    Number(characterID),
    change,
  ];
  const idTypes = new Set(
    Array.isArray(options.idTypes) && options.idTypes.length > 0
      ? options.idTypes
      : ["corpid", "clientID"],
  );
  for (const idType of idTypes) {
    if (idType === "clientID") {
      sendNotificationToCharacterIDs(
        options.clientCharacterIDs || [characterID],
        "OnCorporationMemberChanged",
        idType,
        payloadTuple,
      );
    } else if (idType === "corpid" && options.broadcast !== true) {
      sendNotificationToCorporationSessions(
        corporationID,
        "OnCorporationMemberChanged",
        idType,
        payloadTuple,
      );
    } else {
      sendNotificationToAllSessions(
        "OnCorporationMemberChanged",
        idType,
        payloadTuple,
      );
    }
  }
  if (options.refreshSession !== false) {
    // Affiliation changes still need the full character refresh. An update to
    // an existing member only changes corporation roles and base/HQ state.
    const sameCorporation = previousSnapshot && nextSnapshot &&
      Number(previousSnapshot.corporationID) === Number(nextSnapshot.corporationID);
    if (sameCorporation) {
      refreshCharacterCorporationRoles(corporationID, characterID);
    } else {
      refreshCharacterSession(characterID, options.refreshSessionOptions);
    }
  }
}

function toNonNegativeRoleMask(value) {
  const roleMask = toRoleMaskBigInt(value, -1n);
  return roleMask >= 0n ? roleMask : 0n;
}

function refreshCorporationHeadquartersSessions(
  corporationID,
  headquartersID,
) {
  const numericCorporationID = normalizePositiveInteger(corporationID, null);
  const numericHeadquartersID = normalizePositiveInteger(headquartersID, null);
  if (!numericCorporationID || !numericHeadquartersID) {
    return 0;
  }

  let refreshedSessionCount = 0;
  for (const session of getSessions()) {
    if (Number(getSessionCorporationID(session)) !== numericCorporationID) {
      continue;
    }
    const authority = getPersistedCorporationAuthority(session);
    if (
      !authority ||
      Number(authority.corporationID) !== numericCorporationID
    ) {
      continue;
    }
    const characterID = getSessionCharacterID(session);
    if (!characterID) {
      continue;
    }
    try {
      const previousHeadquartersID = normalizePositiveInteger(
        session.hqID,
        null,
      );
      const previousCorporationRole = toNonNegativeRoleMask(session.corprole);
      const stationID = getDockedLocationKind(session) === "station"
        ? getSessionStationID(session)
        : 0;
      const baseID = normalizePositiveInteger(session.baseID, null);
      const nextCorporationRole = getCorporationRolesAtLocation({ ...session, hqID: numericHeadquartersID, baseID }, stationID);
      const changes = {};

      session.hqID = numericHeadquartersID;
      session.corprole = nextCorporationRole;
      if (previousHeadquartersID !== numericHeadquartersID) {
        changes.hqID = [previousHeadquartersID, numericHeadquartersID];
      }
      if (previousCorporationRole !== nextCorporationRole) {
        changes.corprole = [previousCorporationRole, nextCorporationRole];
      }
      if (
        Object.keys(changes).length > 0 &&
        typeof session.sendSessionChange === "function"
      ) {
        session.sendSessionChange(changes);
      }
      refreshedSessionCount += 1;
    } catch (error) {
      // Session refresh is best-effort only; the durable corporation write and
      // cache notification must not be rolled back by a disconnecting client.
      log.debug(`[CorporationNotifications] session refresh for client ${session.clientID} failed: ${error && error.message}`);
    }
  }
  return refreshedSessionCount;
}

/**
 * svc.corpvotes (voting.py 77 to 105) caches vote cases, votes and sanctioned
 * actions for the session and drops them only on these events, even after the
 * member's own create or cast. All three carry (corporationID, voteCaseID).
 * No retail capture exists; corpid matches the other corporation fan-outs.
 */
function notifyVoteCaseChanged(corporationID, voteCaseID) {
  sendVoteNotification("OnVoteCaseChanged", corporationID, voteCaseID);
}

function notifyVoteCast(corporationID, voteCaseID) {
  sendVoteNotification("OnVoteCast", corporationID, voteCaseID);
}

function notifySanctionedActionChanged(corporationID, voteCaseID) {
  sendVoteNotification("OnSanctionedActionChanged", corporationID, voteCaseID);
}

function sendVoteNotification(notifyType, corporationID, voteCaseID) {
  const numericCorporationID = normalizePositiveInteger(corporationID, null);
  const numericVoteCaseID = normalizePositiveInteger(voteCaseID, null);
  if (!numericCorporationID || !numericVoteCaseID) {
    return;
  }
  sendNotificationToCorporationSessions(
    numericCorporationID,
    notifyType,
    "corpid",
    [numericCorporationID, numericVoteCaseID],
  );
}

function notifyCorporationTitleChanged(
  corporationID,
  titleID,
  previousSnapshot = null,
  nextSnapshot = null,
) {
  const normalizeTitleSnapshot = (snapshot) => {
    if (!snapshot || typeof snapshot !== "object") {
      return snapshot;
    }
    const nextSnapshot = { ...snapshot };
    for (const property of [
      "roles",
      "grantableRoles",
      "rolesAtHQ",
      "grantableRolesAtHQ",
      "rolesAtBase",
      "grantableRolesAtBase",
      "rolesAtOther",
      "grantableRolesAtOther",
    ]) {
      nextSnapshot[property] = buildLong(snapshot[property]);
    }
    return nextSnapshot;
  };
  const change = buildChangeDict(
    normalizeTitleSnapshot(previousSnapshot),
    normalizeTitleSnapshot(nextSnapshot),
    CORPORATION_TITLE_HEADER,
  );
  if (change.entries.length <= 0) {
    return;
  }
  sendNotificationToCorporationSessions(
    corporationID,
    "OnTitleChanged",
    "corpid",
    [Number(corporationID), Number(titleID), change],
  );
}

function notifyCorporationApplicationChanged(
  corporationID,
  applicantID,
  applicationID,
  applicationRow = null,
) {
  sendNotificationToCharacterIDs(
    resolveApplicationChangeRecipientIDs(corporationID, applicantID),
    "OnCorporationApplicationChanged",
    "clientID",
    [
      Number(corporationID),
      Number(applicantID),
      Number(applicationID),
      applicationRow || null,
    ],
  );
}

function notifyCorporationWelcomeMailChanged(corporationID, characterID, changeDate = null) {
  sendNotificationToCorporationSessions(corporationID, "OnCorporationWelcomeMailChanged", "ownerid", [
    Number(characterID || 0),
    buildFiletimeLong(changeDate || currentFileTime()),
  ]);
}

// The client's crimewatch service keeps its corporation's aggression settings
// and asks for them again only when its corporation changes; this notice,
// with the settings as its one argument, is how a change reaches the kept copy.
function notifyCorporationAggressionSettingsChanged(corporationID, aggressionSettings) {
  sendNotificationToCorporationSessions(
    corporationID,
    "OnCorpAggressionSettingsChange",
    "corpid",
    [aggressionSettings],
  );
}

function notifyCorporationRecruitmentAdChanged() {
  sendNotificationToAllSessions("OnCorporationRecruitmentAdChanged", "ownerid", []);
}

function notifyAllianceChanged(allianceID, previousSnapshot = null) {
  const nextSnapshot = buildAllianceSummary(allianceID);
  const change = buildChangeDict(previousSnapshot, nextSnapshot, ALLIANCE_HEADER);
  if (change.entries.length <= 0) {
    return;
  }
  sendNotificationToAllSessions("OnAllianceChanged", "ownerid", [
    Number(allianceID),
    change,
  ]);
}

function notifyAllianceMemberChanged(allianceID, corporationID, previousSnapshot = null) {
  const nextSnapshot = buildAllianceMemberSnapshot(allianceID, corporationID);
  for (const session of getSessions()) {
    const authority = getAllianceMemberAuthority(session, allianceID);
    if (!authority) {
      continue;
    }
    const revealSupport =
      Number(authority.corporationID) === Number(corporationID);
    const visiblePrevious = previousSnapshot
      ? {
          ...previousSnapshot,
          chosenExecutorID: revealSupport
            ? previousSnapshot.chosenExecutorID
            : null,
        }
      : null;
    const visibleNext = nextSnapshot
      ? {
          ...nextSnapshot,
          chosenExecutorID: revealSupport ? nextSnapshot.chosenExecutorID : null,
        }
      : null;
    const change = buildChangeDict(
      visiblePrevious,
      visibleNext,
      ALLIANCE_MEMBER_HEADER,
    );
    if (change.entries.length <= 0) {
      continue;
    }
    try {
      session.sendNotification("OnAllianceMemberChanged", "ownerid", [
        Number(allianceID),
        Number(corporationID),
        change,
      ]);
    } catch (error) {
      // Keep parity notifications non-fatal on the write path.
      log.debug(`[CorporationNotifications] OnAllianceMemberChanged to client ${session.clientID} failed: ${error && error.message}`);
    }
  }
}

function notifyAllianceApplicationChanged(allianceID, corporationID, previousSnapshot = null) {
  const nextSnapshot = buildAllianceApplicationSnapshot(allianceID, corporationID);
  const change = buildChangeDict(
    previousSnapshot,
    nextSnapshot,
    ALLIANCE_APPLICATION_HEADER,
  );
  if (change.entries.length <= 0) {
    return;
  }
  const payloadTuple = [Number(allianceID), Number(corporationID), change];
  for (const session of getSessions()) {
    const corporationAuthority = getPersistedCorporationAuthority(session);
    const isApplicantAdministrator = Boolean(
      corporationAuthority &&
      Number(corporationAuthority.corporationID) === Number(corporationID) &&
      corporationAuthority.isDirector
    );
    const isAllianceDirector = Boolean(
      getAllianceExecutorDirectorAuthority(session, allianceID),
    );
    if (!isApplicantAdministrator && !isAllianceDirector) {
      continue;
    }
    try {
      session.sendNotification(
        "OnAllianceApplicationChanged",
        "ownerid",
        payloadTuple,
      );
    } catch (error) {
      // Keep parity notifications non-fatal on the write path.
      log.debug(`[CorporationNotifications] OnAllianceApplicationChanged to client ${session.clientID} failed: ${error && error.message}`);
    }
  }
}

function notifyAllianceRelationshipChanged(allianceID, toID, previousSnapshot = null) {
  const nextSnapshot = buildAllianceRelationshipSnapshot(allianceID, toID);
  const change = buildChangeDict(
    previousSnapshot,
    nextSnapshot,
    ALLIANCE_RELATIONSHIP_HEADER,
  );
  if (change.entries.length <= 0) {
    return;
  }
  for (const session of getSessions()) {
    if (!getAllianceMemberAuthority(session, allianceID)) {
      continue;
    }
    try {
      session.sendNotification("OnAllianceRelationshipChanged", "ownerid", [
        Number(allianceID),
        Number(toID),
        change,
      ]);
    } catch (error) {
      // Keep parity notifications non-fatal on the write path.
      log.debug(`[CorporationNotifications] OnAllianceRelationshipChanged to client ${session.clientID} failed: ${error && error.message}`);
    }
  }
}

function notifyWarChanged(previousWar = null, nextWar = null) {
  const war = nextWar || previousWar;
  if (!war) {
    return;
  }
  const previousSnapshot = buildWarSnapshot(previousWar);
  const nextSnapshot = buildWarSnapshot(nextWar);
  const ownerIDs = buildWarOwnerIDs(war);
  const change = buildChangeDict(
    previousSnapshot,
    nextSnapshot,
    null,
  );
  if (change.entries.length <= 0) {
    return;
  }
  // The owners go as a set: structureDirectory.py OnWarChanged does
  // `ownerIDs & {session.corpid, session.allianceid}`, which a tuple fails.
  sendNotificationToAllSessions("OnWarChanged", "ownerid", [
    buildWarPayload(war),
    buildPythonSet(ownerIDs),
    change,
  ]);
}

function resolveOfficeNotificationItemID(officeOrID) {
  if (officeOrID && typeof officeOrID === "object") {
    return normalizePositiveInteger(
      officeOrID.itemID,
      normalizePositiveInteger(officeOrID.officeID, 0),
    );
  }
  return normalizePositiveInteger(officeOrID, 0);
}

function buildOfficeJunkyardItemRow(corporationID, office) {
  return buildPackedRow(
    INVENTORY_ROW_DESCRIPTOR_COLUMNS,
    {
      itemID: resolveOfficeNotificationItemID(office),
      typeID: OFFICE_TYPE_ID,
      ownerID: Number(corporationID) || 0,
      locationID: LOCATION_JUNKYARD,
      flagID: FLAG_IMPOUNDED,
      quantity: -1,
      groupID: OFFICE_GROUP_ID,
      categoryID: OFFICE_CATEGORY_ID,
      customInfo: null,
      stacksize: 1,
      singleton: 1,
    },
    INVENTORY_ROW_DESCRIPTOR_VIRTUAL_COLUMNS,
  );
}

function buildOfficeStationItemRow(corporationID, office) {
  return buildPackedRow(
    INVENTORY_ROW_DESCRIPTOR_COLUMNS,
    {
      itemID: resolveOfficeNotificationItemID(office),
      typeID: OFFICE_TYPE_ID,
      ownerID: Number(corporationID) || 0,
      locationID: normalizePositiveInteger(office && office.stationID, 0),
      flagID: FLAG_OFFICE_FOLDER,
      quantity: -1,
      groupID: OFFICE_GROUP_ID,
      categoryID: OFFICE_CATEGORY_ID,
      customInfo: null,
      stacksize: 1,
      singleton: 1,
    },
    INVENTORY_ROW_DESCRIPTOR_VIRTUAL_COLUMNS,
  );
}

function notifyOfficeRentItemChange(corporationID, office) {
  const stationID = normalizePositiveInteger(office && office.stationID, 0);
  const officeItemID = resolveOfficeNotificationItemID(office);
  if (!stationID || !officeItemID) {
    return;
  }
  sendNotificationToAllSessions("OnItemsChanged", "*stationid&corpid", [
    buildList([buildOfficeStationItemRow(corporationID, office)]),
    {
      type: "dict",
      entries: [[3, 0]],
    },
    null,
  ]);
}

function notifyOfficeUnrentItemChange(corporationID, office) {
  const stationID = normalizePositiveInteger(office && office.stationID, 0);
  const officeItemID = resolveOfficeNotificationItemID(office);
  if (!stationID || !officeItemID) {
    return;
  }
  sendNotificationToAllSessions("OnItemsChanged", "*stationid&corpid", [
    buildList([buildOfficeJunkyardItemRow(corporationID, office)]),
    {
      type: "dict",
      entries: [
        [3, stationID],
        [4, FLAG_OFFICE_FOLDER],
      ],
    },
    null,
  ]);
}

// Tranquility's notice of an office rented or given up comes twice, addressed
// by stationid and then by corpid (both recordings of an office have it so),
// each carrying (corporationID, officeID). A notice so addressed goes to the
// clients whose session has that station, or that corporation: machoNet finds
// them by the address's idtype and its list of IDs (machoNet.py,
// FindClientsAndHoles). So: once to those docked where the office is, and once
// to the corporation's.
//
// Of the two values the corporation is an integer and the office a long, as
// the recorded client printed them: (98838096, 1054768634001L). An office's ID
// here may be a small number, which would go as an integer: a BigInt is a long
// to the marshaller.
function notifyOfficeRentalChange(corporationID, officeOrID) {
  const payload = [
    Number(corporationID),
    BigInt(resolveOfficeNotificationItemID(officeOrID) || 0),
  ];
  const officeLocationID =
    officeOrID && typeof officeOrID === "object" ? officeOrID.stationID : null;
  sendNotificationToDockedSessions(
    officeLocationID,
    "OnOfficeRentalChange",
    "stationid",
    payload,
  );
  sendNotificationToCorporationSessions(
    corporationID,
    "OnOfficeRentalChange",
    "corpid",
    payload,
  );
}

function notifyCorporationMedalAdded(corporationID, medalID) {
  // medals.OnCorporationMedalAdded reads args[0] to invalidate recipients and
  // refreshes session.corpid's catalogue. The exact TQ mask/extra args are
  // unrecorded; target current corporation sessions with the consumed medal ID.
  sendNotificationToCorporationSessions(
    corporationID,
    "OnCorporationMedalAdded",
    "corpid",
    [Number(medalID)],
  );
}

function notifyMedalIssued(characterIDs) {
  // medals.OnMedalIssued(*args) ignores the payload and invalidates the
  // recipient's GetMedalsReceived cache, then updates DecorationsPanel.
  // No TQ award capture establishes payload bytes or a broader fanout.
  sendNotificationToCharacterIDs(
    characterIDs,
    "OnMedalIssued",
    "clientID",
    [],
  );
}

function notifyOfficeBillRefresh(corporationID) {
  sendNotificationToCorporationSessions(
    corporationID,
    "OnBillReceived",
    "*corpid&corprole",
    [],
  );
}

function notifyLockedItemChange(itemID, ownerID, locationID, isLocked) {
  // Native ItemLocking consumes this four-argument event to invalidate its
  // location cache, then scatters the three-argument UI event locally.
  const payload = [
    Number(itemID || 0),
    Number(ownerID || 0),
    Number(locationID || 0),
    Boolean(isLocked),
  ];
  if (getCorporationRecord(ownerID)) {
    const { canReadLockedItem } = require("./itemLockingService");
    for (const session of getSessions()) {
      if (!canReadLockedItem(session, ownerID, locationID, itemID)) continue;
      try {
        session.sendNotification("OnLockedItemChange", "ownerid", payload);
      } catch (error) {
        log.debug(`[CorporationNotifications] OnLockedItemChange to client ${session.clientID} failed: ${error && error.message}`);
      }
    }
  } else {
    sendNotificationToCharacterIDs([ownerID], "OnLockedItemChange", "ownerid", payload);
  }
}

module.exports = {
  ALLIANCE_APPLICATION_HEADER,
  ALLIANCE_HEADER,
  ALLIANCE_MEMBER_HEADER,
  ALLIANCE_RELATIONSHIP_HEADER,
  CORPORATION_APPLICATION_HEADER,
  CORPORATION_APPLICATION_DBROW_COLUMNS,
  CORPORATION_HEADER,
  CORPORATION_MEMBER_HEADER,
  CORPORATION_TITLE_HEADER,
  buildAllianceApplicationSnapshot,
  buildAllianceMemberSnapshot,
  buildAllianceRelationshipSnapshot,
  buildAllianceSummary,
  buildChangeDict,
  buildCorporationApplicationRow,
  buildCorporationMemberSnapshot,
  buildCorporationSnapshot,
  buildWarPayload,
  buildWarSnapshot,
  notifyAllianceApplicationChanged,
  notifyAllianceChanged,
  notifyAllianceMemberChanged,
  notifyAllianceRelationshipChanged,
  notifyCorporationAggressionSettingsChanged,
  notifyCorporationApplicationChanged,
  notifyCorporationChanged,
  notifyCorporationLiquidationShareTransfer,
  notifyCorporationMedalAdded,
  notifyCorporationShareChanges,
  notifyCorporationMemberChanged,
  notifyCorporationTitleChanged,
  notifySanctionedActionChanged,
  notifyVoteCaseChanged,
  notifyVoteCast,
  notifyCorporationRecruitmentAdChanged,
  notifyCorporationRemoved,
  notifyCorporationWelcomeMailChanged,
  notifyLockedItemChange,
  notifyMedalIssued,
  notifyOrganizationContactsUpdated,
  notifyOfficeBillRefresh,
  notifyOfficeRentItemChange,
  notifyOfficeRentalChange,
  notifyOfficeUnrentItemChange,
  notifyWarChanged,
  refreshCharacterSession,
  refreshCharacterCorporationRoles,
  refreshCorporationHeadquartersSessions,
};
