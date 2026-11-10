"use strict";

const path = require("path");
const { PROXY_NODE_ID } = require(path.join(__dirname, "../../network/protocolProfile"));

const BaseService = require(path.join(__dirname, "../baseService"));
const log = require(path.join(__dirname, "../../utils/logger"));
const {
  buildBoundObjectResponse,
  buildDbIndexRowset,
  buildDbRowset,
  buildDict,
  buildFiletimeLong,
  buildKeyVal,
  buildList,
  buildPackedRow,
  buildPagedResultSet,
  buildRow,
  currentFileTime,
  extractList,
} = require(path.join(__dirname, "../_shared/serviceHelpers"));
const {
  buildCachedMethodCallResult,
} = require(path.join(__dirname, "../cache/objectCacheRuntime"));
const {
  getCharacterRecord,
  peekCharacterRecord,
} = require(path.join(__dirname, "../character/characterState"));
const {
  resolveCharacterCreationSchoolProfile,
} = require(path.join(__dirname, "../character/characterCreationData"));
const {
  buildNotEnoughMoneyUserErrorValues,
  getCharacterWallet,
} = require(path.join(__dirname, "../account/walletState"));
const {
  throwWrappedUserError,
} = require(path.join(__dirname, "../../common/machoErrors"));
const {
  getCorporationInfoRecord,
  getCorporationRecord,
  getOwnerLookupRecord,
  isNpcCorporationID,
  setCharacterAffiliation,
  NPC_STARTER_CORPORATION_ID,
} = require(path.join(__dirname, "./corporationState"));
const {
  computeCharacterCorporationMemberLimit,
  hasRoomForAnotherMember,
} = require(path.join(__dirname, "./corporationMemberLimit"));
const {
  CORP_ROLE_ACCOUNTANT,
  CORP_ROLE_CHAT_MANAGER,
  CORP_ROLE_DIRECTOR,
  CORP_ROLE_DIPLOMAT,
  CORP_ROLE_JUNIOR_ACCOUNTANT,
  CORP_ROLE_PERSONNEL_MANAGER,
  CORPORATION_WALLET_KEY_START,
  DEFAULT_STRUCTURE_REINFORCE_HOUR,
  FULL_ADMIN_ROLE_MASK,
  FULL_GRANTABLE_ROLE_MASK,
  FULL_LOCATIONAL_ROLE_MASK,
  FULL_TITLE_MASK,
  ensureCharacterMemberState,
  ensureRuntimeInitialized,
  getCorporationDivisionNames,
  getCorporationMember,
  getDirectMemberRoleMasks,
  roundMemberRowDate,
  getCorporationRuntime,
  getCorporationGrantableRoleState,
  getCorporationWalletDivisionTakeRole,
  getPageForMembers,
  listCorporationMembers,
  normalizeBoolean,
  normalizeInteger,
  normalizePositiveInteger,
  normalizeText,
  recordCorporationRoleHistory,
  toRoleMaskBigInt,
  updateCorporationRecord,
  updateCorporationRuntime,
  syncMemberStateToCharacterRecord,
} = require(path.join(__dirname, "./corporationRuntimeState"));
const {
  NO_REINFORCEMENT_WEEKDAY,
} = require(path.join(__dirname, "../structure/structureConstants"));
const { buildWarPayload } = require("./warPayloads");
const { declareWar } = require("./warDeclarationState");
const {
  corporationsWithArchivableApplications,
} = require("./applicationArchiveScope");
const {
  corporationAuthorityHasRole,
  getPersistedCorporationAuthority,
} = require(path.join(__dirname, "./corporationAuthority"));
const {
  ALLIANCE_APPLICATION_STATE,
  createAllianceApplication,
  deleteAllianceApplication,
  getAllianceApplication,
} = require(path.join(__dirname, "./allianceApplicationState"));
const {
  checkAllianceApplicationEligibility,
} = require(path.join(__dirname, "./allianceApplicationEligibility"));
const {
  buildCorporationMemberTrackingRowset,
  queryCorporationMemberIDs,
} = require(path.join(__dirname, "./corpMemberQueryState"));
const {
  getCorporationWalletBalance,
  normalizeCorporationWalletKey,
} = require(path.join(__dirname, "./corpWalletState"));
const {
  prepareCorporationLiquidation,
  settleCorporationLiquidation,
} = require(path.join(__dirname, "./corporationLiquidationState"));
const {
  prepareCorporationDividend,
  settleCorporationDividend,
} = require(path.join(__dirname, "./corporationDividendState"));
const {
  prepareCorporationFounding,
  settleCorporationFounding,
} = require(path.join(__dirname, "./corporationFoundingState"));
const {
  ALLIANCE_FOUNDING_COST,
  prepareAllianceFounding,
  settleAllianceFounding,
} = require(path.join(__dirname, "./allianceFoundingState"));
const {
  checkAllianceFormationEligibility,
  normalizeAllianceFormationOptions,
} = require(path.join(__dirname, "./allianceFormationEligibility"));
const {
  buildCorporationAllianceApplicationsIndexRowset,
} = require(path.join(__dirname, "./allianceViewState"));
const {
  CTPG_CASH,
  CTPG_SHARES,
  CTV_ADD,
  CTV_GIVE,
  CTV_REMOVE,
  CTV_SET,
  executeCorporationMemberActions,
} = require(path.join(__dirname, "./corpMemberActionState"));
const {
  getCharacterAllyBaseCost,
} = require(path.join(__dirname, "./warCostState"));
const {
  listKillmailsForCorporation,
} = require(path.join(__dirname, "../killmail/killmailState"));
const {
  sendCorporationWelcomeMailToCharacter,
} = require(path.join(__dirname, "../mail/mailState"));
const {
  buildAggressionSettingsPayload,
  readAggressionSettings,
  resolveFriendlyFireLegalAtTime,
  scheduleAggressionSettingsChange,
} = require(path.join(__dirname, "./aggressionSettingsState"));
const {
  addLabelMask,
  allocateNextLabelID,
  removeLabelMask,
  toLabelKey,
  toMarshalMaskValue,
} = require(path.join(__dirname, "./contactLabelState"));
const {
  buildAllianceApplicationSnapshot,
  buildCorporationApplicationRow,
  buildCorporationMemberSnapshot,
  buildCorporationSnapshot,
  notifyAllianceApplicationChanged,
  notifyCorporationAggressionSettingsChanged,
  notifyCorporationApplicationChanged,
  notifyCorporationChanged,
  notifyCorporationMemberChanged,
  notifyCorporationShareChanges,
  notifyCorporationTitleChanged,
  refreshCharacterCorporationRoles,
  notifyCorporationWelcomeMailChanged,
  notifyOrganizationContactsUpdated,
} = require(path.join(__dirname, "./corporationNotifications"));
const {
  notifyCorporationApplicationAccepted,
  notifyCorporationApplicationAcceptedByCharacter,
  notifyCorporationApplicationInvited,
  notifyCorporationApplicationReceived,
  notifyCorporationApplicationRejected,
  notifyCorporationApplicationRejectedByCharacter,
  notifyCorporationApplicationWithdrawn,
} = require(path.join(__dirname, "./corpApplicationNotifications"));
const {
  notifyCorporationMemberKicked,
  notifyCorporationMemberLeft,
  notifyCorporationNewCeo,
  notifyCorporationTaxRateChanged,
} = require(path.join(__dirname, "./corpLifecycleNotifications"));

const MEMBER_DBROW_COLUMNS = [
  ["characterID", 0x03],
  ["corporationID", 0x03],
  ["divisionID", 0x03],
  ["squadronID", 0x03],
  ["title", 0x82],
  ["roles", 0x14],
  ["grantableRoles", 0x14],
  ["startDateTime", 0x40],
  ["baseID", 0x03],
  ["rolesAtHQ", 0x14],
  ["grantableRolesAtHQ", 0x14],
  ["rolesAtBase", 0x14],
  ["grantableRolesAtBase", 0x14],
  ["rolesAtOther", 0x14],
  ["grantableRolesAtOther", 0x14],
  ["titleMask", 0x03],
  ["accountKey", 0x03],
  ["rowDate", 0x40],
  ["blockRoles", 0x0b],
  ["ownerName", 0x82],
];
const TITLE_DBROW_COLUMNS = [
  ["corporationID", 0x03],
  ["titleID", 0x03],
  ["titleName", 0x82],
  ["roles", 0x14],
  ["grantableRoles", 0x14],
  ["rolesAtHQ", 0x14],
  ["grantableRolesAtHQ", 0x14],
  ["rolesAtBase", 0x14],
  ["grantableRolesAtBase", 0x14],
  ["rolesAtOther", 0x14],
  ["grantableRolesAtOther", 0x14],
];
const MEMBER_ROLE_FIELD_SPECS = Object.freeze([
  { index: 4, property: "roles", allowedMask: FULL_ADMIN_ROLE_MASK, grantableProperty: "grantableRoles", grantable: false },
  { index: 5, property: "grantableRoles", allowedMask: FULL_GRANTABLE_ROLE_MASK, grantable: true },
  { index: 6, property: "rolesAtHQ", allowedMask: FULL_LOCATIONAL_ROLE_MASK, grantableProperty: "grantableRolesAtHQ", grantable: false },
  { index: 7, property: "grantableRolesAtHQ", allowedMask: FULL_LOCATIONAL_ROLE_MASK, grantable: true },
  { index: 8, property: "rolesAtBase", allowedMask: FULL_LOCATIONAL_ROLE_MASK, grantableProperty: "grantableRolesAtBase", grantable: false },
  { index: 9, property: "grantableRolesAtBase", allowedMask: FULL_LOCATIONAL_ROLE_MASK, grantable: true },
  { index: 10, property: "rolesAtOther", allowedMask: FULL_LOCATIONAL_ROLE_MASK, grantableProperty: "grantableRolesAtOther", grantable: false },
  { index: 11, property: "grantableRolesAtOther", allowedMask: FULL_LOCATIONAL_ROLE_MASK, grantable: true },
]);
const TITLE_ROLE_FIELD_SPECS = Object.freeze([
  { index: 2, property: "roles", allowedMask: FULL_GRANTABLE_ROLE_MASK },
  { index: 3, property: "grantableRoles", allowedMask: FULL_GRANTABLE_ROLE_MASK },
  { index: 4, property: "rolesAtHQ", allowedMask: FULL_LOCATIONAL_ROLE_MASK },
  { index: 5, property: "grantableRolesAtHQ", allowedMask: FULL_LOCATIONAL_ROLE_MASK },
  { index: 6, property: "rolesAtBase", allowedMask: FULL_LOCATIONAL_ROLE_MASK },
  { index: 7, property: "grantableRolesAtBase", allowedMask: FULL_LOCATIONAL_ROLE_MASK },
  { index: 8, property: "rolesAtOther", allowedMask: FULL_LOCATIONAL_ROLE_MASK },
  { index: 9, property: "grantableRolesAtOther", allowedMask: FULL_LOCATIONAL_ROLE_MASK },
]);
const BULLETIN_DBROW_COLUMNS = [
  ["bulletinID", 0x03],
  ["ownerID", 0x03],
  ["createCharacterID", 0x03],
  ["createDateTime", 0x40],
  ["editCharacterID", 0x03],
  ["editDateTime", 0x40],
  ["title", 0x82],
  ["body", 0x82],
  ["sortOrder", 0x03],
];
const LABEL_DBROW_COLUMNS = [
  ["labelID", 0x14],
  ["name", 0x82],
  ["color", 0x03],
];
const KILLMAIL_DBROW_COLUMNS = [
  ["killID", 0x03],
  ["solarSystemID", 0x03],
  ["victimCharacterID", 0x03],
  ["victimCorporationID", 0x03],
  ["victimAllianceID", 0x03],
  ["victimFactionID", 0x03],
  ["victimShipTypeID", 0x03],
  ["finalCharacterID", 0x03],
  ["finalCorporationID", 0x03],
  ["finalAllianceID", 0x03],
  ["finalFactionID", 0x03],
  ["finalShipTypeID", 0x03],
  ["finalWeaponTypeID", 0x03],
  ["killBlob", 0x82],
  ["killTime", 0x40],
  ["victimDamageTaken", 0x03],
  ["finalSecurityStatus", 0x05],
  ["finalDamageDone", 0x03],
  ["moonID", 0x03],
  ["warID", 0x03],
  ["iskLost", 0x06],
  ["bountyClaimed", 0x06],
  ["loyaltyPoints", 0x03],
  ["iskDestroyed", 0x06],
  ["killRightSupplied", 0x03],
];
const OWNER_HEADER = [
  "ownerID",
  "ownerName",
  "typeID",
  "gender",
  "ownerNameID",
];
const SHAREHOLDER_DBROW_COLUMNS = [
  ["shareholderID", 0x03],
  ["corporationID", 0x03],
  ["shareholderCorporationID", 0x03],
  ["shares", 0x14],
];
// TQ Open Wallet - Plex - Corp Wallet - Corp Transfers.txt, call2430.
const SHARE_HOLDING_DBROW_COLUMNS = [
  ["corporationID", 0x03],
  ["shares", 0x14],
];
const DEFAULT_NPC_CORPORATION_ID = NPC_STARTER_CORPORATION_ID;
const FILETIME_TICKS_PER_DAY = 24n * 60n * 60n * 10000000n;
const CORPORATION_FOUNDING_COST = 1599800;
const TICKER_SUGGESTION_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const CREATE_MEMBER_CHANGE_HEADER = [
  "grantableRolesAtOther",
  "corporationID",
  "baseID",
  "roles",
  "title",
  "accountKey",
  "grantableRoles",
  "rolesAtBase",
  "grantableRolesAtHQ",
  "ownerName",
  "startDateTime",
  "rowDate",
  "divisionID",
  "blockRoles",
  "grantableRolesAtBase",
  "titleMask",
  "rolesAtHQ",
  "characterID",
  "squadronID",
  "rolesAtOther",
];
const APPLICATION_ACCEPT_MEMBER_CHANGE_HEADER = [
  "corporationID",
  "blockRoles",
  "startDateTime",
  "rowDate",
];
const APP_STATUS_APPLIED_BY_CHARACTER = 0;
const APP_STATUS_RENEGOTIATED_BY_CHARACTER = 1;
const APP_STATUS_ACCEPTED_BY_CHARACTER = 2;
const APP_STATUS_REJECTED_BY_CHARACTER = 3;
const APP_STATUS_REJECTED_BY_CORPORATION = 4;
const APP_STATUS_RENEGOTIATED_BY_CORPORATION = 5;
const APP_STATUS_ACCEPTED_BY_CORPORATION = 6;
const APP_STATUS_WITHDRAWN_BY_CHARACTER = 7;
const APP_STATUS_INVITED_BY_CORPORATION = 8;
const TERMINAL_APPLICATION_STATUSES = new Set([
  APP_STATUS_ACCEPTED_BY_CHARACTER,
  APP_STATUS_REJECTED_BY_CHARACTER,
  APP_STATUS_REJECTED_BY_CORPORATION,
  APP_STATUS_WITHDRAWN_BY_CHARACTER,
]);

function resolveCorporationID(session) {
  return normalizePositiveInteger(
    (session && (session.corporationID || session.corpid)) || DEFAULT_NPC_CORPORATION_ID,
    DEFAULT_NPC_CORPORATION_ID,
  );
}

function resolveCharacterID(session, args) {
  return normalizePositiveInteger(
    (args && args.length > 0 && args[0]) ||
      (session && (session.characterID || session.charid)),
    0,
  );
}

function requireSessionCharacter(session) {
  const characterID = resolveCharacterID(session, []);
  const character = characterID ? peekCharacterRecord(characterID) : null;
  if (!character || character.isDeleted || character.deletedAt) {
    throwCorporationAccessDenied();
  }
  return character;
}

function requireCorporationReadAccess(corporationID, session) {
  const character = requireSessionCharacter(session);
  const corporation = getCorporationRecord(corporationID);
  if (
    !corporation || corporation.deleted ||
    Number(character.corporationID) !== Number(corporationID) ||
    (!isNpcCorporationID(corporationID) &&
      !hasPersistedCorporationMembership(corporationID, session))
  ) {
    throwCorporationAccessDenied();
  }
}

function requireCorporationShareReadAccess(corporationID, session) {
  const authority = getPersistedCorporationAuthority(session);
  if (
    !authority || Number(authority.corporationID) !== Number(corporationID) ||
    (!authority.isCEO && !authority.isDirector &&
      (authority.sessionCorporationRoles & (CORP_ROLE_ACCOUNTANT | CORP_ROLE_JUNIOR_ACCOUNTANT)) === 0n)
  ) {
    throwCorporationAccessDenied();
  }
}

function buildLong(value) {
  return {
    type: "long",
    value: toRoleMaskBigInt(value, 0n),
  };
}

function buildSuggestionVariants(baseValue, fallback) {
  const normalized = normalizeText(baseValue, "")
    .replace(/[^A-Za-z0-9]/g, "")
    .toUpperCase();
  const base = normalized.slice(0, 5) || fallback;
  const variants = [base, base.slice(0, 4), `${base.slice(0, 3)}X`]
    .map((value) => value || fallback)
    .filter(Boolean);
  return Array.from(new Set(variants));
}

function buildSuggestionObjects(baseValue, fallback, fieldName) {
  return buildSuggestionVariants(baseValue, fallback).map((value) =>
    buildKeyVal([[fieldName, value]]),
  );
}

function buildRandomTickerSuggestion() {
  let tickerName = "";
  for (let index = 0; index < 4; index += 1) {
    tickerName += TICKER_SUGGESTION_ALPHABET[
      Math.floor(Math.random() * TICKER_SUGGESTION_ALPHABET.length)
    ];
  }
  return tickerName;
}

function buildCreateCorporationMemberSnapshot(corporationID, characterID) {
  const character = getCharacterRecord(characterID) || {};
  const now = character.startDateTime || currentFileTime().toString();
  const zeroRole = buildLong(0n);
  return {
    grantableRolesAtOther: zeroRole,
    corporationID: Number(corporationID),
    baseID: null,
    roles: zeroRole,
    title: { type: "wstring", value: "" },
    accountKey: null,
    grantableRoles: zeroRole,
    rolesAtBase: zeroRole,
    grantableRolesAtHQ: zeroRole,
    ownerName: { type: "wstring", value: character.characterName || `Character ${characterID}` },
    startDateTime: buildFiletimeLong(roundMemberRowDate(now)),
    rowDate: buildFiletimeLong(roundMemberRowDate(now)),
    divisionID: null,
    blockRoles: false,
    grantableRolesAtBase: zeroRole,
    titleMask: 0,
    rolesAtHQ: zeroRole,
    characterID: Number(characterID),
    squadronID: null,
    rolesAtOther: zeroRole,
  };
}

function buildApplicationAcceptMemberSnapshot(corporationID, characterID) {
  const member = getCorporationMember(corporationID, characterID) || {};
  const character = getCharacterRecord(characterID) || {};
  const joinDate =
    member.startDate ||
    character.startDateTime ||
    character.createDateTime ||
    currentFileTime().toString();
  return {
    corporationID: Number(corporationID),
    blockRoles: false,
    startDateTime: buildFiletimeLong(roundMemberRowDate(joinDate)),
    rowDate: buildFiletimeLong(roundMemberRowDate(member.rowDate || joinDate)),
  };
}

function buildPreviousApplicationAcceptMemberSnapshot(corporationID) {
  return {
    corporationID: Number(corporationID),
    blockRoles: null,
    startDateTime: null,
    rowDate: null,
  };
}

function mapCreateCorporationError(errorMsg) {
  switch (errorMsg) {
    case "CORPORATION_NAME_TAKEN":
      return "CorpNameInvalidTaken";
    case "CORPORATION_TICKER_TAKEN":
      return "CorpTickerNameInvalidTaken";
    case "CORPORATION_NAME_REQUIRED":
      return "EnterCorporationName";
    default:
      return errorMsg || "CustomNotify";
  }
}

const ALLIANCE_FORMATION_ERROR_TEXT = Object.freeze({
  ALLIANCE_NAME_REQUIRED: "Enter an alliance name.",
  ALLIANCE_NAME_INVALID_LENGTH:
    "Alliance names must contain between 4 and 50 characters.",
  ALLIANCE_NAME_INVALID_CHARACTERS:
    "That alliance name contains unsupported characters.",
  ALLIANCE_NAME_TAKEN: "That alliance name is already in use.",
  ALLIANCE_SHORT_NAME_INVALID_LENGTH:
    "Alliance short names must contain between 1 and 5 characters.",
  ALLIANCE_SHORT_NAME_INVALID_CHARACTERS:
    "That alliance short name contains unsupported characters.",
  ALLIANCE_SHORT_NAME_TAKEN: "That alliance short name is already in use.",
  ALLIANCE_DESCRIPTION_TOO_LONG:
    "Alliance descriptions may not exceed 5,000 characters.",
  ALLIANCE_URL_TOO_LONG: "Alliance URLs may not exceed 2,048 characters.",
  CORPORATION_ALREADY_IN_ALLIANCE:
    "Your corporation is already a member of an alliance.",
  EMPIRE_CONTROL_LEVEL_REQUIRED:
    "The founding CEO must have Empire Control trained to level V.",
  ALLIANCE_FOUNDING_ALREADY_PENDING:
    "An alliance founding request is already being processed for this corporation.",
});

function throwAllianceFormationError(errorMsg) {
  if (
    errorMsg === "ALLIANCE_FOUNDER_INVALID" ||
    errorMsg === "INVALID_ALLIANCE_FOUNDER" ||
    errorMsg === "INVALID_FOUNDING_CORPORATION" ||
    errorMsg === "ALLIANCE_FOUNDER_NOT_CEO"
  ) {
    throwCorporationAccessDenied();
  }
  throwWrappedUserError("CustomNotify", {
    notify: ALLIANCE_FORMATION_ERROR_TEXT[errorMsg] ||
      "The alliance could not be created.",
  });
}

function getOwnerRecord(ownerID) {
  const character = getCharacterRecord(ownerID);
  if (character) {
    return {
      ownerID: Number(ownerID),
      ownerName: character.characterName || `Character ${ownerID}`,
      typeID: Number(character.typeID || 1373),
      gender: Number(character.gender || 0),
    };
  }
  return getOwnerLookupRecord(ownerID);
}

function memberHasActiveRoles(member) {
  if (!member) {
    return false;
  }
  return (
    toRoleMaskBigInt(member.roles, 0n) !== 0n ||
    toRoleMaskBigInt(member.grantableRoles, 0n) !== 0n ||
    toRoleMaskBigInt(member.rolesAtHQ, 0n) !== 0n ||
    toRoleMaskBigInt(member.grantableRolesAtHQ, 0n) !== 0n ||
    toRoleMaskBigInt(member.rolesAtBase, 0n) !== 0n ||
    toRoleMaskBigInt(member.grantableRolesAtBase, 0n) !== 0n ||
    toRoleMaskBigInt(member.rolesAtOther, 0n) !== 0n ||
    toRoleMaskBigInt(member.grantableRolesAtOther, 0n) !== 0n ||
    normalizeInteger(member.titleMask, 0) !== 0
  );
}

function recordMemberRoleAuditRows(corporationID, memberID, previousMember, nextMember, session) {
  if (!previousMember || !nextMember) {
    return;
  }
  const issuerID = resolveCharacterID(session, []) || -1;
  for (const [fieldName, grantable] of [
    ["roles", false],
    ["grantableRoles", true],
  ]) {
    const oldRoles = toRoleMaskBigInt(previousMember[fieldName], 0n);
    const newRoles = toRoleMaskBigInt(nextMember[fieldName], 0n);
    if (oldRoles === newRoles) {
      continue;
    }
    recordCorporationRoleHistory(corporationID, {
      charID: memberID,
      issuerID,
      oldRoles: oldRoles.toString(),
      newRoles: newRoles.toString(),
      grantable,
    });
  }
}

function resolveFallbackCorporationID(characterID) {
  const characterRecord = getCharacterRecord(characterID) || {};
  const schoolProfile = resolveCharacterCreationSchoolProfile(
    characterRecord.schoolID,
    {
      raceID: characterRecord.raceID,
      corporationID: DEFAULT_NPC_CORPORATION_ID,
    },
  );
  const schoolCorporationID = normalizePositiveInteger(
    schoolProfile.corporationID,
    null,
  );
  if (schoolCorporationID && getCorporationRecord(schoolCorporationID)) {
    return schoolCorporationID;
  }
  return DEFAULT_NPC_CORPORATION_ID;
}

function moveCharacterToCorporation(
  characterID,
  fromCorporationID,
  toCorporationID,
  options = {},
) {
  const targetCorporation = getCorporationRecord(toCorporationID);
  if (!targetCorporation) {
    return {
      success: false,
      errorMsg: "TARGET_CORPORATION_NOT_FOUND",
    };
  }
  const sourceCorporation = getCorporationRecord(fromCorporationID) || {};
  const sourceIsNpcCorporation =
    Boolean(sourceCorporation.isNPC) ||
    Number(fromCorporationID) === Number(DEFAULT_NPC_CORPORATION_ID);
  const previousFromMember = buildCorporationMemberSnapshot(
    fromCorporationID,
    characterID,
  );
  const previousFromCorporation = buildCorporationSnapshot(fromCorporationID);
  const previousToMember = buildCorporationMemberSnapshot(
    targetCorporation.corporationID,
    characterID,
  );
  const previousToCorporation = buildCorporationSnapshot(
    targetCorporation.corporationID,
  );

  const affiliationResult = setCharacterAffiliation(
    characterID,
    targetCorporation.corporationID,
    targetCorporation.allianceID || null,
  );
  if (!affiliationResult.success) {
    return affiliationResult;
  }

  // Updating the affiliation first dirties the membership index.  Runtime
  // normalization derives its members from that index, so removing this row
  // first would immediately reconstruct it from the character's old corp.
  updateCorporationRuntime(fromCorporationID, (runtime) => {
    delete runtime.members[String(characterID)];
    return runtime;
  });

  ensureCharacterMemberState(targetCorporation.corporationID, characterID);
  syncMemberStateToCharacterRecord(targetCorporation.corporationID, characterID);
  if (options.applicationAccept === true) {
    if (!sourceIsNpcCorporation) {
      notifyCorporationMemberChanged(
        fromCorporationID,
        characterID,
        previousFromMember,
        { refreshSession: false },
      );
      notifyCorporationChanged(fromCorporationID, previousFromCorporation);
    }
    notifyCorporationMemberChanged(
      targetCorporation.corporationID,
      characterID,
      buildPreviousApplicationAcceptMemberSnapshot(fromCorporationID),
      {
        header: APPLICATION_ACCEPT_MEMBER_CHANGE_HEADER,
        nextSnapshot: buildApplicationAcceptMemberSnapshot(
          targetCorporation.corporationID,
          characterID,
        ),
        idTypes: ["clientID"],
        clientCharacterIDs: [characterID],
        refreshSessionOptions: {
          // allianceid only goes out when it changed. Without it the client stays
          // outside the corporation's alliance until the pilot relogs.
          sessionChangeKeys: ["corpid", "hqID", "allianceid"],
          suppressCorpAccountKeyWithCorpChange: true,
        },
        targeted: true,
      },
    );
    notifyCorporationMemberChanged(
      targetCorporation.corporationID,
      characterID,
      null,
      {
        header: CREATE_MEMBER_CHANGE_HEADER,
        nextSnapshot: buildCreateCorporationMemberSnapshot(
          targetCorporation.corporationID,
          characterID,
        ),
        idTypes: ["corpid", "clientID"],
        clientCharacterIDs: [characterID],
        refreshSession: false,
        targeted: true,
      },
    );
  } else {
    notifyCorporationMemberChanged(
      fromCorporationID,
      characterID,
      previousFromMember,
    );
    notifyCorporationChanged(fromCorporationID, previousFromCorporation);
    notifyCorporationMemberChanged(
      targetCorporation.corporationID,
      characterID,
      previousToMember,
    );
  }
  notifyCorporationChanged(
    targetCorporation.corporationID,
    previousToCorporation,
  );
  // CharLeftCorpMsg (21): the character left the source corporation, so its
  // recruiters are told. No-ops for NPC source corporations.
  notifyCorporationMemberLeft(fromCorporationID, characterID);

  if (Number(fromCorporationID) !== Number(targetCorporation.corporationID)) {
    const targetRuntime = getCorporationRuntime(targetCorporation.corporationID) || {};
    const welcomeMailResult = sendCorporationWelcomeMailToCharacter(
      characterID,
      targetCorporation.corporationID,
      {
        corporationRecord: targetCorporation,
        body: targetRuntime.welcomeMail,
      },
    );
    if (!welcomeMailResult.success) {
      log.warn(
        `[CorpRegistry] Failed to send corporation welcome mail for char=${characterID} corp=${targetCorporation.corporationID}: ${welcomeMailResult.errorMsg}`,
      );
    }
  }

  return {
    success: true,
    data: {
      characterID,
      corporationID: targetCorporation.corporationID,
      allianceID: targetCorporation.allianceID || null,
    },
  };
}

function parsePersistedRoleMask(value) {
  try {
    if (typeof value === "bigint") {
      return value >= 0n ? value : null;
    }
    if (typeof value === "number") {
      return Number.isSafeInteger(value) && value >= 0
        ? BigInt(value)
        : null;
    }
    if (typeof value === "string") {
      const normalized = value.trim();
      return /^\d+$/.test(normalized) ? BigInt(normalized) : null;
    }
    if (
      value &&
      typeof value === "object" &&
      (value.type === "long" || value.type === "int")
    ) {
      return parsePersistedRoleMask(value.value);
    }
  } catch (_error) {
    // ignored: a mask that does not parse is no mask (null)
    return null;
  }
  return null;
}

function hasDirectorRole(roleMask) {
  return (
    typeof roleMask === "bigint" &&
    roleMask >= 0n &&
    (roleMask & CORP_ROLE_DIRECTOR) === CORP_ROLE_DIRECTOR
  );
}

function getCorporationAdministrativeAuthority(corporationID, session) {
  const characterID = resolveCharacterID(session, []);
  if (!corporationID || !characterID) {
    return null;
  }

  const corporation = getCorporationRecord(corporationID);
  const character = peekCharacterRecord(characterID);
  const member = getCorporationMember(corporationID, characterID);
  if (
    !corporation ||
    Boolean(corporation.deleted) ||
    corporation.isNPC !== false ||
    isNpcCorporationID(corporationID) ||
    !character ||
    Boolean(character.isDeleted) ||
    Boolean(character.deletedAt) ||
    Number(character.corporationID) !== Number(corporationID) ||
    !member ||
    Boolean(member.deleted) ||
    Number(member.characterID) !== Number(characterID) ||
    Number(member.corporationID) !== Number(corporationID)
  ) {
    return null;
  }

  const isCEO = Number(corporation.ceoID) === Number(characterID);
  const roles = parsePersistedRoleMask(member.roles);
  if (
    !isCEO &&
    (roles === null || (roles & ~FULL_ADMIN_ROLE_MASK) !== 0n)
  ) {
    return null;
  }
  return {
    characterID,
    isCEO,
    isDirector: hasDirectorRole(roles),
  };
}

function hasPersistedCorporationMembership(corporationID, session) {
  const characterID = resolveCharacterID(session, []);
  const corporation = getCorporationRecord(corporationID);
  const character = characterID ? peekCharacterRecord(characterID) : null;
  const member = characterID
    ? getCorporationMember(corporationID, characterID)
    : null;
  return Boolean(
    characterID &&
    corporation &&
    !corporation.deleted &&
    corporation.isNPC === false &&
    !isNpcCorporationID(corporationID) &&
    character &&
    !character.isDeleted &&
    !character.deletedAt &&
    Number(character.corporationID) === Number(corporationID) &&
    member &&
    !member.deleted &&
    Number(member.characterID) === Number(characterID) &&
    Number(member.corporationID) === Number(corporationID)
  );
}

function canAdministerCorporation(corporationID, session) {
  const authority = getCorporationAdministrativeAuthority(
    corporationID,
    session,
  );
  return Boolean(authority && (authority.isCEO || authority.isDirector));
}

function canManageCorporationBulletins(corporationID, session) {
  const authority = getPersistedCorporationAuthority(session);
  return Boolean(
    authority &&
    Number(authority.corporationID) === Number(corporationID) &&
    (
      authority.isCEO ||
      authority.isDirector ||
      (authority.sessionCorporationRoles & CORP_ROLE_CHAT_MANAGER) ===
        CORP_ROLE_CHAT_MANAGER
    )
  );
}

function canManageCorporationContacts(corporationID, session) {
  const authority = getPersistedCorporationAuthority(session);
  return Boolean(
    authority &&
    Number(authority.corporationID) === Number(corporationID) &&
    (
      authority.isCEO ||
      authority.isDirector ||
      (authority.sessionCorporationRoles & CORP_ROLE_DIPLOMAT) ===
        CORP_ROLE_DIPLOMAT
    )
  );
}

function canManageCorporationRecruitment(corporationID, session) {
  const authority = getPersistedCorporationAuthority(session);
  return Boolean(
    authority &&
    Number(authority.corporationID) === Number(corporationID) &&
    (
      authority.isCEO ||
      authority.isDirector ||
      (authority.sessionCorporationRoles & CORP_ROLE_PERSONNEL_MANAGER) ===
        CORP_ROLE_PERSONNEL_MANAGER
    )
  );
}

function requireAllianceApplicationCorporationAuthority(
  session,
  { requireCEO = false } = {},
) {
  const authority = getPersistedCorporationAuthority(session);
  if (
    !authority ||
    !authority.isDirector ||
    (requireCEO && !authority.isCEO)
  ) {
    throwCorporationAccessDenied();
  }
  return authority;
}

function validateAllianceApplicationEligibility(corporationID, allianceID) {
  const result = checkAllianceApplicationEligibility(corporationID, allianceID);
  if (result && result.success) {
    return result.data;
  }
  const errorName = result && result.errorMsg === "AGGRESSOR_WAR"
    ? "CanNotJoinAllianceWhileAgressor"
    : result && result.errorMsg === "MUTUAL_WAR"
      ? "CanNotJoinAllianceWithActiveMututalWars"
      : result && result.errorMsg === "FOREIGN_ALLY_WAR"
        ? "CanNotJoinAllianceWhileAlliedWithOthers"
        : null;
  if (errorName) {
    throwWrappedUserError(errorName, {});
  }
  throwCorporationAccessDenied();
}

function throwCorporationAccessDenied() {
  throwWrappedUserError("CrpAccessDenied", {
    reason: [101, "UI/Corporations/AccessRestrictions/InsufficientRoles"],
  });
}

function hasOptionalUpdateValue(values, index) {
  return (
    Array.isArray(values) &&
    index < values.length &&
    values[index] !== undefined &&
    values[index] !== null
  );
}

function parseInboundRoleMask(value, allowedMask) {
  const parsed = parsePersistedRoleMask(value);
  if (parsed === null || (parsed & ~allowedMask) !== 0n) {
    throwCorporationAccessDenied();
  }
  return parsed;
}

function parseInboundTitleMask(value) {
  const parsed = parsePersistedRoleMask(value);
  if (parsed === null || parsed > BigInt(FULL_TITLE_MASK)) {
    throwCorporationAccessDenied();
  }
  return Number(parsed);
}

function parseInboundBlockRoles(value) {
  if (value === true || value === false) {
    return value ? 1 : 0;
  }
  const parsed = parsePersistedRoleMask(value);
  if (parsed !== 0n && parsed !== 1n) {
    throwCorporationAccessDenied();
  }
  return Number(parsed);
}

function normalizeBulkMemberUpdateRow(rawRow) {
  const row = extractList(rawRow).slice();
  if (row.length === 0) {
    return row;
  }
  // The V24.01 roles pane sends zero placeholders for title/division/squadron.
  // They are not edits; applying them corrupts otherwise unrelated member data.
  row[1] = undefined;
  row[2] = undefined;
  row[3] = undefined;
  return row;
}

function getCurrentMemberRoleMasks(member) {
  const masks = {};
  for (const spec of MEMBER_ROLE_FIELD_SPECS) {
    masks[spec.property] = parseInboundRoleMask(
      member && member[spec.property],
      spec.allowedMask,
    );
  }
  return getDirectMemberRoleMasks(masks);
}

function prepareMemberUpdate(corporationID, rawValues, session, options = {}) {
  const values = options.bulk === true
    ? normalizeBulkMemberUpdateRow(rawValues)
    : extractList(rawValues).slice();
  const memberID = normalizePositiveInteger(values[0], null);
  const member = memberID ? getCorporationMember(corporationID, memberID) : null;
  if (!member || !hasPersistedCorporationMembership(corporationID, session)) {
    throwCorporationAccessDenied();
  }

  const corporation = getCorporationRecord(corporationID);
  const authority = getCorporationAdministrativeAuthority(corporationID, session);
  const actorID = resolveCharacterID(session, []);
  const actorIsCEO = Boolean(authority && authority.isCEO);
  const actorIsDirector = Boolean(authority && authority.isDirector);
  const actorIsAdministrator = actorIsCEO || actorIsDirector;
  const actorGrantables = getCorporationGrantableRoleState(
    corporationID,
    actorID,
  );
  const targetIsCEO =
    Number(corporation && corporation.ceoID) === Number(memberID) ||
    member.isCEO === true;
  const currentMasks = getCurrentMemberRoleMasks(member);
  const targetIsDirector = hasDirectorRole(currentMasks.roles);
  const nextValues = {};

  for (const spec of MEMBER_ROLE_FIELD_SPECS) {
    if (!hasOptionalUpdateValue(values, spec.index)) {
      continue;
    }
    nextValues[spec.property] = parseInboundRoleMask(
      values[spec.index],
      spec.allowedMask,
    );
  }
  if (hasOptionalUpdateValue(values, 1)) {
    nextValues.title = normalizeText(values[1], "").slice(0, 100);
  }
  if (hasOptionalUpdateValue(values, 2)) {
    nextValues.divisionID = normalizeInteger(values[2], 0);
  }
  if (hasOptionalUpdateValue(values, 3)) {
    nextValues.squadronID = normalizeInteger(values[3], 0);
  }
  // EditMemberDialog sends all eight masks and None for No Base; the role-only RemoveAllRoles/AllowRoles
  // calls use optional None here and a non-None blockRoles flag instead. Bulk rows keep their sentinels.
  const clearsProfileBase = options.bulk !== true && values[12] === null &&
    !hasOptionalUpdateValue(values, 14) &&
    MEMBER_ROLE_FIELD_SPECS.every((spec) => hasOptionalUpdateValue(values, spec.index));
  if (hasOptionalUpdateValue(values, 12) || clearsProfileBase) {
    nextValues.baseID = normalizePositiveInteger(values[12], null);
  }
  if (hasOptionalUpdateValue(values, 13)) {
    nextValues.titleMask = parseInboundTitleMask(values[13]);
  }
  if (hasOptionalUpdateValue(values, 14)) {
    nextValues.blockRoles = parseInboundBlockRoles(values[14]);
  }

  const changedProperties = new Set(
    Object.entries(nextValues)
      .filter(([property, nextValue]) => {
        if (MEMBER_ROLE_FIELD_SPECS.some((spec) => spec.property === property)) {
          return currentMasks[property] !== nextValue;
        }
        if (property === "blockRoles") {
          return Number(toRoleMaskBigInt(member.blockRoles, 0n) !== 0n) !== nextValue;
        }
        if (property === "titleMask") {
          return normalizeInteger(member.titleMask, 0) !== nextValue;
        }
        if (property === "baseID") {
          return normalizePositiveInteger(member.baseID, null) !== nextValue;
        }
        return member[property] !== nextValue;
      })
      .map(([property]) => property),
  );
  const isSelf = Number(actorID) === Number(memberID);
  const isSelfRoleResignation =
    isSelf &&
    !targetIsCEO &&
    nextValues.blockRoles === 1 &&
    MEMBER_ROLE_FIELD_SPECS.every(
      (spec) => Object.prototype.hasOwnProperty.call(nextValues, spec.property) &&
        nextValues[spec.property] === 0n,
    ) &&
    nextValues.titleMask === 0 &&
    [...changedProperties].every(
      (property) =>
        property === "titleMask" ||
        property === "blockRoles" ||
        MEMBER_ROLE_FIELD_SPECS.some((spec) => spec.property === property),
    );
  const isSelfAllowRoles =
    isSelf &&
    nextValues.blockRoles === 0 &&
    [...changedProperties].every((property) => property === "blockRoles");

  if (isSelfRoleResignation || isSelfAllowRoles) {
    return { corporationID, memberID, nextValues, changedProperties };
  }
  if (changedProperties.has("blockRoles")) {
    throwCorporationAccessDenied();
  }

  let nextRoles = Object.prototype.hasOwnProperty.call(nextValues, "roles")
    ? nextValues.roles
    : currentMasks.roles;
  const directorTransition =
    hasDirectorRole(currentMasks.roles) !== hasDirectorRole(nextRoles);
  if (directorTransition) {
    if (!actorIsCEO || targetIsCEO) {
      throwCorporationAccessDenied();
    }
    const promoting = hasDirectorRole(nextRoles);
    // Promotion has only the aggregate Director bit. After unchecking Director,
    // EditMemberDialog allows new role/title choices before this same Apply.
    // Missing fields still clear legacy expanded powers on a partial demotion.
    for (const spec of MEMBER_ROLE_FIELD_SPECS) {
      nextValues[spec.property] = promoting
        ? spec.property === "roles" ? CORP_ROLE_DIRECTOR : 0n
        : Object.prototype.hasOwnProperty.call(nextValues, spec.property) ? nextValues[spec.property] : 0n;
      if (currentMasks[spec.property] !== nextValues[spec.property]) {
        changedProperties.add(spec.property);
      } else {
        changedProperties.delete(spec.property);
      }
    }
    nextValues.titleMask = !promoting && Object.prototype.hasOwnProperty.call(nextValues, "titleMask")
      ? nextValues.titleMask : 0;
    if (normalizeInteger(member.titleMask, 0) !== nextValues.titleMask) {
      changedProperties.add("titleMask");
    } else {
      changedProperties.delete("titleMask");
    }
  }

  const targetBlocksRoles = toRoleMaskBigInt(member.blockRoles, 0n) !== 0n;
  for (const spec of MEMBER_ROLE_FIELD_SPECS) {
    if (!changedProperties.has(spec.property)) {
      continue;
    }
    if (targetIsCEO) {
      throwCorporationAccessDenied();
    }
    if (targetIsDirector && !directorTransition) {
      throwCorporationAccessDenied();
    }
    const nextMask = nextValues[spec.property];
    const addedMask = nextMask & ~currentMasks[spec.property];
    if (targetBlocksRoles && addedMask !== 0n) {
      throwCorporationAccessDenied();
    }
    if (directorTransition) {
      continue;
    }
    if (spec.grantable) {
      if (!actorIsAdministrator) {
        throwCorporationAccessDenied();
      }
      continue;
    }
    if (actorIsAdministrator) {
      continue;
    }
    const actorGrantableMask = actorGrantables[spec.grantableProperty] || 0n;
    const changedMask = currentMasks[spec.property] ^ nextMask;
    if ((changedMask & ~actorGrantableMask) !== 0n) {
      throwCorporationAccessDenied();
    }
    if (
      spec.property === "rolesAtBase" &&
      normalizePositiveInteger(member.baseID, null) !==
        normalizePositiveInteger(
          getCorporationMember(corporationID, actorID)?.baseID,
          null,
        )
    ) {
      throwCorporationAccessDenied();
    }
  }

  for (const property of ["title", "divisionID", "squadronID", "baseID", "titleMask"]) {
    if (!changedProperties.has(property)) {
      continue;
    }
    if (!actorIsAdministrator || (targetIsCEO && !actorIsCEO)) {
      throwCorporationAccessDenied();
    }
    if (property === "titleMask") {
      if (targetIsDirector && !directorTransition) {
        throwCorporationAccessDenied();
      }
      const oldTitleMask = normalizeInteger(member.titleMask, 0);
      if (targetBlocksRoles && (nextValues.titleMask & ~oldTitleMask) !== 0) {
        throwCorporationAccessDenied();
      }
    }
  }

  return { corporationID, memberID, nextValues, changedProperties };
}

function memberUpdateRemovesPrivileges(
  previousMember,
  nextValues,
  changedProperties,
) {
  if (!previousMember || !(changedProperties instanceof Set)) {
    return false;
  }
  const previousRoles = parseInboundRoleMask(
    previousMember.roles,
    FULL_ADMIN_ROLE_MASK,
  );
  const nextRoles = changedProperties.has("roles")
    ? nextValues.roles
    : previousRoles;
  if (!hasDirectorRole(previousRoles) && hasDirectorRole(nextRoles)) {
    // Promotion to Director expands authority even though the canonical wire
    // form clears all of the target's individual role collections.
    return false;
  }
  for (const spec of MEMBER_ROLE_FIELD_SPECS) {
    if (!changedProperties.has(spec.property)) {
      continue;
    }
    const previousMask = parseInboundRoleMask(
      previousMember[spec.property],
      spec.allowedMask,
    );
    if ((previousMask & ~nextValues[spec.property]) !== 0n) {
      return true;
    }
  }
  if (changedProperties.has("titleMask")) {
    const previousTitleMask = parseInboundTitleMask(previousMember.titleMask);
    if ((previousTitleMask & ~nextValues.titleMask) !== 0) {
      return true;
    }
  }
  return false;
}

function extendMemberRoleStasis(member) {
  const nextStasisUntil = currentFileTime() + FILETIME_TICKS_PER_DAY;
  const currentStasisUntil = parsePersistedRoleMask(member.roleStasisUntil) || 0n;
  if (nextStasisUntil > currentStasisUntil) {
    member.roleStasisUntil = nextStasisUntil.toString();
  }
}

function memberIsInRoleStasis(member) {
  const rawStasisUntil = member && member.roleStasisUntil;
  if (rawStasisUntil === undefined || rawStasisUntil === null || rawStasisUntil === "") {
    return false;
  }
  const stasisUntil = parsePersistedRoleMask(rawStasisUntil);
  // A malformed persisted authority cooldown fails closed.
  return stasisUntil === null || stasisUntil > currentFileTime();
}

function applyPreparedMemberUpdate(prepared, session) {
  const { corporationID, memberID, nextValues, changedProperties } = prepared;
  if (!(changedProperties instanceof Set) || changedProperties.size === 0) {
    return null;
  }
  const previousMemberRecord = getCorporationMember(corporationID, memberID);
  const previousMember = buildCorporationMemberSnapshot(corporationID, memberID);
  const startsRoleStasis = memberUpdateRemovesPrivileges(
    previousMemberRecord,
    nextValues,
    changedProperties,
  );
  updateCorporationRuntime(corporationID, (runtime) => {
    const member = runtime.members[String(memberID)];
    if (!member) {
      return runtime;
    }
    for (const [property, value] of Object.entries(nextValues)) {
      if (!changedProperties.has(property)) {
        continue;
      }
      member[property] = typeof value === "bigint" ? value.toString() : value;
    }
    if (startsRoleStasis) {
      extendMemberRoleStasis(member);
    }
    return runtime;
  });
  recordMemberRoleAuditRows(
    corporationID,
    memberID,
    previousMemberRecord,
    getCorporationMember(corporationID, memberID),
    session,
  );
  syncMemberStateToCharacterRecord(corporationID, memberID);
  // TQ Receiving Corp Roles.txt 553-559: the member notice is followed by
  // a role SessionChangeNotification for the already connected recipient.
  notifyCorporationMemberChanged(corporationID, memberID, previousMember);
  return null;
}

function applyPreparedMemberUpdates(preparedRows, session) {
  const changes = preparedRows.filter(
    (prepared) => prepared.changedProperties instanceof Set &&
      prepared.changedProperties.size > 0,
  );
  if (changes.length === 0) {
    return null;
  }
  const corporationID = changes[0].corporationID;
  const previousRecords = new Map();
  const previousSnapshots = new Map();
  for (const prepared of changes) {
    previousRecords.set(
      prepared.memberID,
      getCorporationMember(corporationID, prepared.memberID),
    );
    previousSnapshots.set(
      prepared.memberID,
      buildCorporationMemberSnapshot(corporationID, prepared.memberID),
    );
  }
  updateCorporationRuntime(corporationID, (runtime) => {
    for (const prepared of changes) {
      const member = runtime.members[String(prepared.memberID)];
      if (!member) {
        throwCorporationAccessDenied();
      }
      for (const [property, value] of Object.entries(prepared.nextValues)) {
        if (!prepared.changedProperties.has(property)) {
          continue;
        }
        member[property] = typeof value === "bigint" ? value.toString() : value;
      }
      if (memberUpdateRemovesPrivileges(
        previousRecords.get(prepared.memberID),
        prepared.nextValues,
        prepared.changedProperties,
      )) {
        extendMemberRoleStasis(member);
      }
    }
    return runtime;
  });
  for (const prepared of changes) {
    recordMemberRoleAuditRows(
      corporationID,
      prepared.memberID,
      previousRecords.get(prepared.memberID),
      getCorporationMember(corporationID, prepared.memberID),
      session,
    );
    syncMemberStateToCharacterRecord(corporationID, prepared.memberID);
    notifyCorporationMemberChanged(
      corporationID,
      prepared.memberID,
      previousSnapshots.get(prepared.memberID),
    );
  }
  return null;
}

function isValidTitleID(value) {
  const titleID = normalizePositiveInteger(value, null);
  return Boolean(
    titleID &&
    titleID <= 32768 &&
    (titleID & (titleID - 1)) === 0,
  );
}

function buildTitleSnapshot(titleID, title = null) {
  return {
    titleID: Number(titleID),
    titleName: normalizeText(title && title.titleName, ""),
    roles: String(toRoleMaskBigInt(title && title.roles, 0n)),
    grantableRoles: String(toRoleMaskBigInt(title && title.grantableRoles, 0n)),
    rolesAtHQ: String(toRoleMaskBigInt(title && title.rolesAtHQ, 0n)),
    grantableRolesAtHQ: String(
      toRoleMaskBigInt(title && title.grantableRolesAtHQ, 0n),
    ),
    rolesAtBase: String(toRoleMaskBigInt(title && title.rolesAtBase, 0n)),
    grantableRolesAtBase: String(
      toRoleMaskBigInt(title && title.grantableRolesAtBase, 0n),
    ),
    rolesAtOther: String(toRoleMaskBigInt(title && title.rolesAtOther, 0n)),
    grantableRolesAtOther: String(
      toRoleMaskBigInt(title && title.grantableRolesAtOther, 0n),
    ),
  };
}

function prepareTitleUpdate(corporationID, rawValues, session) {
  if (!canAdministerCorporation(corporationID, session)) {
    throwCorporationAccessDenied();
  }
  const values = extractList(rawValues);
  const titleID = normalizePositiveInteger(values[0], null);
  if (!isValidTitleID(titleID)) {
    throwCorporationAccessDenied();
  }
  const title = {
    titleID,
    titleName: normalizeText(values[1], "").slice(0, 100),
  };
  for (const spec of TITLE_ROLE_FIELD_SPECS) {
    title[spec.property] = parseInboundRoleMask(
      values[spec.index],
      spec.allowedMask,
    ).toString();
  }
  return { corporationID, titleID, title };
}

function applyPreparedTitleUpdates(corporationID, preparedRows) {
  if (preparedRows.length === 0) {
    return null;
  }
  const runtime = getCorporationRuntime(corporationID) || {};
  const previousByTitleID = new Map(
    preparedRows.map((prepared) => [
      prepared.titleID,
      buildTitleSnapshot(
        prepared.titleID,
        runtime.titles && runtime.titles[String(prepared.titleID)],
      ),
    ]),
  );
  updateCorporationRuntime(corporationID, (nextRuntime) => {
    for (const prepared of preparedRows) {
      nextRuntime.titles[String(prepared.titleID)] = prepared.title;
    }
    return nextRuntime;
  });
  const nextRuntime = getCorporationRuntime(corporationID) || {};
  for (const prepared of preparedRows) {
    notifyCorporationTitleChanged(
      corporationID,
      prepared.titleID,
      previousByTitleID.get(prepared.titleID),
      buildTitleSnapshot(
        prepared.titleID,
        nextRuntime.titles && nextRuntime.titles[String(prepared.titleID)],
      ),
    );
  }
  const changedTitleMask = preparedRows.reduce((mask, prepared) => mask | prepared.titleID, 0);
  for (const member of listCorporationMembers(corporationID)) {
    if ((normalizeInteger(member.titleMask, 0) & changedTitleMask) !== 0) {
      refreshCharacterCorporationRoles(corporationID, member.characterID);
    }
  }
  return null;
}

function prepareCorporationForResigningCeo(corporationID, characterID) {
  const corporationRecord = getCorporationRecord(corporationID);
  if (!corporationRecord || corporationRecord.isNPC) {
    return {
      success: false,
      errorMsg: "CORPORATION_NOT_FOUND",
    };
  }
  const targetCorporationID = resolveFallbackCorporationID(characterID);
  const targetCorporation = getCorporationRecord(targetCorporationID);
  if (!targetCorporation) {
    return {
      success: false,
      errorMsg: "TARGET_CORPORATION_NOT_FOUND",
    };
  }

  const previousCorporation = buildCorporationSnapshot(corporationID);
  const previousFromMember = buildCorporationMemberSnapshot(
    corporationID,
    characterID,
  );
  const previousToMember = buildCorporationMemberSnapshot(
    targetCorporation.corporationID,
    characterID,
  );

  return prepareCorporationLiquidation({
    corporationID,
    characterID,
    fallbackCorporationID: targetCorporation.corporationID,
    previousCorporation,
    previousFromMember,
    previousToMember,
  });
}

function archiveApplication(runtime, application, overrides = {}) {
  const archivedApplication = { ...application, ...overrides };
  runtime.applicationHistory = Array.isArray(runtime.applicationHistory)
    ? runtime.applicationHistory
    : [];
  runtime.applicationHistory.push({ ...archivedApplication });
  delete runtime.applications[String(application.applicationID)];
  return archivedApplication;
}

function resolveAutoArchivedApplicationStatus(application) {
  const status = Number(application && application.status);
  if (
    status === APP_STATUS_ACCEPTED_BY_CORPORATION ||
    status === APP_STATUS_INVITED_BY_CORPORATION
  ) {
    return APP_STATUS_REJECTED_BY_CHARACTER;
  }
  return APP_STATUS_WITHDRAWN_BY_CHARACTER;
}

function archiveAllActiveApplicationsForCharacter(characterID, exceptApplicationID = null) {
  const runtimeTable = ensureRuntimeInitialized();
  for (const corporationID of corporationsWithArchivableApplications(
    runtimeTable.corporations, characterID, exceptApplicationID,
  )) {
    const removedApplications = [];
    updateCorporationRuntime(corporationID, (runtime) => {
      for (const application of Object.values(runtime.applications || {})) {
        if (
          Number(application.characterID) === Number(characterID) &&
          Number(application.applicationID) !== Number(exceptApplicationID)
        ) {
          removedApplications.push(
            archiveApplication(runtime, application, {
              status: resolveAutoArchivedApplicationStatus(application),
            }),
          );
        }
      }
      return runtime;
    });
    for (const application of removedApplications) {
      notifyCorporationApplicationChanged(
        application.corporationID,
        application.characterID,
        application.applicationID,
        buildCorporationApplicationRow(application),
      );
    }
  }
}

// LabelCore._Layout/GetAsUnicode uses the client CP1252 default for byte
// strings. Corporation names and descriptions must carry Unicode on the wire.
function unicodeCorporationText(value) {
  return typeof value === "string" ? { type: "wstring", value } : value;
}

function buildCorporationKeyVal(corporationID) {
  const info = getCorporationInfoRecord(corporationID);
  if (!info) {
    return null;
  }
  const runtime = getCorporationRuntime(corporationID) || {};
  const divisionNames = getCorporationDivisionNames(corporationID);
  const header = [
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
  return buildRow(header, [
    info.corporationID,
    unicodeCorporationText(info.corporationName),
    unicodeCorporationText(info.ticker),
    unicodeCorporationText(info.tickerName || info.ticker),
    info.ceoID,
    info.creatorID,
    info.allianceID,
    info.factionID ?? null,
    info.warFactionID ?? info.factionID ?? null,
    1,
    unicodeCorporationText(info.description || ""),
    unicodeCorporationText(info.url || ""),
    info.stationID,
    info.deleted,
    info.taxRate,
    info.loyaltyPointTaxRate || 0.0,
    info.friendlyFire || 0,
    info.memberCount,
    info.memberLimit,
    info.shares,
    info.allowWar,
    info.allowedMemberRaceIDs,
    info.corporationType,
    info.minimumJoinStanding,
    info.sendCharTerminationMessage,
    info.createDate ? buildFiletimeLong(info.createDate) : null,
    info.aggressionEnableAfter ? buildFiletimeLong(info.aggressionEnableAfter) : null,
    info.aggressionDisableAfter ? buildFiletimeLong(info.aggressionDisableAfter) : null,
    runtime.applicationsEnabled || 0,
    unicodeCorporationText(divisionNames[1]),
    unicodeCorporationText(divisionNames[2]),
    unicodeCorporationText(divisionNames[3]),
    unicodeCorporationText(divisionNames[4]),
    unicodeCorporationText(divisionNames[5]),
    unicodeCorporationText(divisionNames[6]),
    unicodeCorporationText(divisionNames[7]),
    unicodeCorporationText(divisionNames[8]),
    unicodeCorporationText(divisionNames[9]),
    unicodeCorporationText(divisionNames[10]),
    unicodeCorporationText(divisionNames[11]),
    unicodeCorporationText(divisionNames[12]),
    unicodeCorporationText(divisionNames[13]),
    unicodeCorporationText(divisionNames[14]),
    info.shape1 ?? null,
    info.shape2 ?? null,
    info.shape3 ?? null,
    info.color1 ?? null,
    info.color2 ?? null,
    info.color3 ?? null,
    info.typeface ?? null,
    runtime.applicationsEnabled === 0 ? 0 : 1,
  ]);
}

function buildMemberRow(member) {
  const masks = getDirectMemberRoleMasks(member);
  const characterID = Number(member.characterID || 0);
  const characterRecord = characterID ? getCharacterRecord(characterID) || {} : {};
  const ownerRecord = getOwnerLookupRecord(characterID) || {};
  return buildPackedRow(MEMBER_DBROW_COLUMNS, {
    characterID,
    corporationID: Number(member.corporationID || 0),
    divisionID: member.divisionID ?? null,
    squadronID: member.squadronID ?? null,
    title: member.title || "",
      roles: masks.roles,
      grantableRoles: masks.grantableRoles,
    startDateTime: roundMemberRowDate(member.startDate || "0"),
    baseID: member.baseID || null,
      rolesAtHQ: masks.rolesAtHQ,
      grantableRolesAtHQ: masks.grantableRolesAtHQ,
      rolesAtBase: masks.rolesAtBase,
      grantableRolesAtBase: masks.grantableRolesAtBase,
      rolesAtOther: masks.rolesAtOther,
      grantableRolesAtOther: masks.grantableRolesAtOther,
    titleMask: Number(member.titleMask || 0),
    accountKey: member.accountKey ?? null,
    rowDate: roundMemberRowDate(member.rowDate || member.startDate || "0"),
    blockRoles: toRoleMaskBigInt(member.blockRoles, 0n) !== 0n ? 1 : 0,
    ownerName:
      characterRecord.characterName ||
      characterRecord.ownerName ||
      ownerRecord.ownerName ||
      `Character ${characterID}`,
  });
}

function buildTitleRowValues(title, corporationID) {
  return [
    Number(corporationID),
    Number(title.titleID || 0),
    title.titleName || "",
    buildLong(title.roles),
    buildLong(title.grantableRoles),
    buildLong(title.rolesAtHQ),
    buildLong(title.grantableRolesAtHQ),
    buildLong(title.rolesAtBase),
    buildLong(title.grantableRolesAtBase),
    buildLong(title.rolesAtOther),
    buildLong(title.grantableRolesAtOther),
  ];
}

function buildApplicationRow(application) {
  return buildCorporationApplicationRow(application);
}

function buildBulletinRow(bulletin) {
  return buildPackedRow(BULLETIN_DBROW_COLUMNS, {
    bulletinID: Number(bulletin.bulletinID || 0),
    ownerID: Number(bulletin.ownerID || 0),
    createCharacterID: Number(bulletin.createCharacterID || bulletin.editCharacterID || 0),
    createDateTime: bulletin.createDateTime || "0",
    editCharacterID: Number(bulletin.editCharacterID || 0),
    editDateTime: bulletin.editDateTime || "0",
    title: bulletin.title || "",
    body: bulletin.body || "",
    sortOrder: Number(bulletin.sortOrder || 0),
  });
}

function buildShareholderRow(shareholderID, corporationID, shares) {
  const character = peekCharacterRecord(shareholderID);
  return [
    shareholderID,
    corporationID,
    character ? normalizePositiveInteger(character.corporationID, null) : null,
    Number(shares || 0),
  ];
}

function roundIsk(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 0;
  }
  return Math.round(numeric * 100) / 100;
}

// CorpAllianceContactManagementWnd.Confirm sends tenths; a relationship is not an integer.
function contactStanding(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function buildContactKeyVal(contactID, contact) {
  return buildKeyVal([
    ["contactID", contactID],
    ["relationshipID", Number(contact.relationshipID || 0)],
    ["labelMask", toMarshalMaskValue(contact.labelMask)],
    ["inWatchlist", contact.inWatchlist ? 1 : 0],
  ]);
}

function buildLabelRowValues(labelID, label) {
  return [
    toMarshalMaskValue(labelID),
    label.name || "",
    label.color === null ? null : Number(label.color || 0),
  ];
}

function buildKillmailRows(records = []) {
  return buildDbRowset(
    KILLMAIL_DBROW_COLUMNS,
    records.map((record) => [
      Number(record && record.killID) || 0,
      normalizePositiveInteger(record && record.solarSystemID, null),
      normalizePositiveInteger(record && record.victimCharacterID, null),
      normalizePositiveInteger(record && record.victimCorporationID, null),
      normalizePositiveInteger(record && record.victimAllianceID, null),
      normalizePositiveInteger(record && record.victimFactionID, null),
      normalizePositiveInteger(record && record.victimShipTypeID, null),
      normalizePositiveInteger(record && record.finalCharacterID, null),
      normalizePositiveInteger(record && record.finalCorporationID, null),
      normalizePositiveInteger(record && record.finalAllianceID, null),
      normalizePositiveInteger(record && record.finalFactionID, null),
      normalizePositiveInteger(record && record.finalShipTypeID, null),
      normalizePositiveInteger(record && record.finalWeaponTypeID, null),
      normalizeText(record && record.killBlob, ""),
      buildFiletimeLong(record && record.killTime ? record.killTime : currentFileTime()),
      Math.max(0, normalizeInteger(record && record.victimDamageTaken, 0)),
      Number(record && record.finalSecurityStatus) || 0,
      Math.max(0, normalizeInteger(record && record.finalDamageDone, 0)),
      normalizePositiveInteger(record && record.moonID, null),
      normalizePositiveInteger(record && record.warID, null),
      Number(record && record.iskLost) || 0,
      Number(record && record.bountyClaimed) || 0,
      normalizeInteger(record && record.loyaltyPoints, 0),
      Number(record && record.iskDestroyed) || 0,
      normalizePositiveInteger(record && record.killRightSupplied, null),
    ]),
    "carbon.common.script.sys.crowset.CRowset",
  );
}

function buildActiveRoleErrorDetails(member) {
  const activeRoleFields = [
    "roles",
    "grantableRoles",
    "rolesAtHQ",
    "grantableRolesAtHQ",
    "rolesAtBase",
    "grantableRolesAtBase",
    "rolesAtOther",
    "grantableRolesAtOther",
  ].filter((fieldName) => toRoleMaskBigInt(member && member[fieldName], 0n) !== 0n);
  if (normalizeInteger(member && member.titleMask, 0) !== 0) {
    activeRoleFields.push("titleMask");
  }
  return buildDict([
    ["rolelist", buildList(activeRoleFields)],
  ]);
}

function buildCachedResult(result, {
  serviceName,
  method,
  args = [],
  versionCheck = "5 minutes",
  sessionInfo = null,
  sessionInfoValue = undefined,
  proxyCache = false,
} = {}) {
  return buildCachedMethodCallResult(result, {
    serviceName,
    method,
    args,
    versionCheck,
    sessionInfo,
    sessionInfoValue,
    proxyCache,
  });
}

function buildApplicationsByCharacter(runtime) {
  const entries = {};
  for (const application of Object.values(runtime.applications || {})) {
    const key = String(application.characterID);
    if (!entries[key]) {
      entries[key] = [];
    }
    entries[key].push(buildApplicationRow(application));
  }
  return buildDict(
    Object.entries(entries).map(([characterID, rows]) => [
      Number(characterID),
      buildList(rows),
    ]),
  );
}

function buildCorporationWelcomeMailPayload(runtime = {}) {
  return buildKeyVal([
    [
      "characterID",
      normalizePositiveInteger(runtime.welcomeMailCharacterID, null),
    ],
    [
      "changeDate",
      buildFiletimeLong(runtime.welcomeMailChangeDate || "0"),
    ],
    ["welcomeMail", normalizeText(runtime.welcomeMail, "")],
  ]);
}

function filterApplicationHistory(applications = [], characterID = null) {
  return applications
    .filter(
      (application) =>
        !characterID || Number(application.characterID) === Number(characterID),
    )
    .map((application) => buildApplicationRow(application));
}

function findApplicationByID(runtime, applicationID) {
  for (const application of Object.values(runtime.applications || {})) {
    if (Number(application.applicationID) === Number(applicationID)) {
      return application;
    }
  }
  return null;
}


function buildMemberTrackingRows(corporationID) {
  return buildCorporationMemberTrackingRowset(corporationID);
}

class CorpRegistryRuntimeService extends BaseService {
  constructor() {
    super("corpRegistry");
  }

  Handle_MachoResolveObject() {
    return PROXY_NODE_ID;
  }

  Handle_MachoBindObject(args, session, kwargs) {
    return buildBoundObjectResponse(this, args, session, kwargs);
  }

  /**
   * Resolve the corporation a public read call should target. The corp info
   * window binds corpRegistry to the corporation the player opened (carried as
   * the MachoBindObject parameter); honor that binding so foreign corporations
   * return their own data. Falls back to the session corporation for direct
   * (unbound) calls and for the player's own corporation window.
   */
  resolveBoundCorporationID(session) {
    const boundObjectID = session && session.currentBoundObjectID;
    if (
      boundObjectID &&
      this.serviceManager &&
      typeof this.serviceManager.getBoundObjectParams === "function"
    ) {
      const boundCorporationID = normalizePositiveInteger(
        this.serviceManager.getBoundObjectParams(boundObjectID),
        0,
      );
      if (boundCorporationID) {
        return boundCorporationID;
      }
    }
    return resolveCorporationID(session);
  }

  Handle_GetEveOwners(args, session) {
    const corporationID = this.resolveBoundCorporationID(session);
    const owners = listCorporationMembers(corporationID)
      .map((member) => getOwnerRecord(member.characterID))
      .filter(Boolean)
      .map((record) =>
        buildRow(OWNER_HEADER, [
          record.ownerID,
          record.ownerName,
          record.typeID,
          record.gender,
          null,
        ]),
      );
    return buildList(owners);
  }

  Handle_GetCorporation(args, session) {
    return buildCorporationKeyVal(this.resolveBoundCorporationID(session));
  }

  Handle_GetCorporateContacts(args, session) {
    requireCorporationReadAccess(resolveCorporationID(session), session);
    const runtime = getCorporationRuntime(resolveCorporationID(session)) || {};
    return buildDict(
      Object.entries(runtime.contacts || {}).map(([contactID, contact]) => [
        Number(contactID),
        buildContactKeyVal(Number(contactID), contact),
      ]),
    );
  }

  Handle_AddCorporateContact(args, session) {
    const corporationID = resolveCorporationID(session);
    if (!canManageCorporationContacts(corporationID, session)) {
      throwCorporationAccessDenied();
    }
    const contactID = normalizePositiveInteger(args && args[0], null);
    const relationshipID = contactStanding(args && args[1]);
    if (!contactID) {
      return null;
    }
    updateCorporationRuntime(corporationID, (runtime) => {
      // addressbookService.AddToAddressBook keeps an existing contact's labelMask on edit.
      const previous = runtime.contacts[String(contactID)];
      runtime.contacts[String(contactID)] = {
        relationshipID,
        labelMask: previous?.labelMask ?? 0,
        inWatchlist: false,
      };
      return runtime;
    });
    notifyOrganizationContactsUpdated(corporationID, [[contactID, relationshipID, null]]);
    return null;
  }

  Handle_EditCorporateContact(args, session) {
    return this.Handle_AddCorporateContact(args, session);
  }

  Handle_RemoveCorporateContacts(args, session) {
    const corporationID = resolveCorporationID(session);
    if (!canManageCorporationContacts(corporationID, session)) {
      throwCorporationAccessDenied();
    }
    const contactIDs = extractList(args && args[0]);
    updateCorporationRuntime(corporationID, (runtime) => {
      for (const contactID of contactIDs) {
        delete runtime.contacts[String(contactID)];
      }
      return runtime;
    });
    notifyOrganizationContactsUpdated(
      corporationID,
      contactIDs.map((contactID) => [Number(contactID), null, null]),
    );
    return null;
  }

  Handle_GetContactList(args, session) {
    return this.Handle_GetCorporateContacts(args, session);
  }

  Handle_EditContactsRelationshipID(args, session) {
    const corporationID = resolveCorporationID(session);
    if (!canManageCorporationContacts(corporationID, session)) {
      throwCorporationAccessDenied();
    }
    const contactIDs = extractList(args && args[0]);
    const relationshipID = contactStanding(args && args[1]);
    updateCorporationRuntime(corporationID, (runtime) => {
      for (const contactID of contactIDs) {
        if (!runtime.contacts[String(contactID)]) {
          runtime.contacts[String(contactID)] = {
            relationshipID,
            labelMask: 0,
            inWatchlist: false,
          };
        } else {
          runtime.contacts[String(contactID)].relationshipID = relationshipID;
        }
      }
      return runtime;
    });
    notifyOrganizationContactsUpdated(
      corporationID,
      contactIDs.map((contactID) => [Number(contactID), relationshipID, null]),
    );
    return null;
  }

  Handle_GetLabels(args, session) {
    requireCorporationReadAccess(resolveCorporationID(session), session);
    const runtime = getCorporationRuntime(resolveCorporationID(session)) || {};
    return buildDbIndexRowset(
      LABEL_DBROW_COLUMNS,
      Object.entries(runtime.labels || {}).map(([labelID, label]) => [
        toMarshalMaskValue(labelID),
        buildLabelRowValues(labelID, label),
      ]),
      "labelID",
    );
  }

  Handle_CreateLabel(args, session) {
    const corporationID = resolveCorporationID(session);
    if (!canManageCorporationContacts(corporationID, session)) {
      throwCorporationAccessDenied();
    }
    const name = normalizeText(args && args[0], "").trim();
    // CreateContactLabel keeps None as no color; explicit 0 is the white swatch.
    const color = args && args[1] != null ? normalizeInteger(args[1], 0) : null;
    let labelID = null;
    updateCorporationRuntime(corporationID, (runtime, corporationRecord, table) => {
      const allocation = allocateNextLabelID(
        runtime.labels || {},
        table._meta.nextLabelID,
      );
      labelID = allocation.labelID;
      table._meta.nextLabelID = allocation.nextLabelID;
      runtime.labels[allocation.labelKey] = { name, color };
      return runtime;
    });
    return labelID;
  }

  Handle_DeleteLabel(args, session) {
    const corporationID = resolveCorporationID(session);
    if (!canManageCorporationContacts(corporationID, session)) {
      throwCorporationAccessDenied();
    }
    const labelKey = toLabelKey(args && args[0], null);
    updateCorporationRuntime(corporationID, (runtime) => {
      delete runtime.labels[String(labelKey)];
      for (const contact of Object.values(runtime.contacts || {})) {
        contact.labelMask = removeLabelMask(contact.labelMask, labelKey);
      }
      return runtime;
    });
    return null;
  }

  Handle_EditLabel(args, session) {
    const corporationID = resolveCorporationID(session);
    if (!canManageCorporationContacts(corporationID, session)) {
      throwCorporationAccessDenied();
    }
    const labelKey = toLabelKey(args && args[0], null);
    // addressbookService.EditContactLabel (1001-1010): None leaves that field unchanged.
    const name = args && args[1] != null ? normalizeText(args[1], "") : undefined;
    const color = args && args[2] != null ? normalizeInteger(args[2], 0) : undefined;
    updateCorporationRuntime(corporationID, (runtime) => {
      const label = runtime.labels[String(labelKey)] || { name: "", color: 0 };
      if (name !== undefined) {
        label.name = name;
      }
      if (color !== undefined) {
        label.color = color;
      }
      runtime.labels[String(labelKey)] = label;
      return runtime;
    });
    return null;
  }

  Handle_AssignLabels(args, session) {
    const corporationID = resolveCorporationID(session);
    if (!canManageCorporationContacts(corporationID, session)) {
      throwCorporationAccessDenied();
    }
    const contactIDs = extractList(args && args[0]);
    const labelMask = toLabelKey(args && args[1], "0");
    updateCorporationRuntime(corporationID, (runtime) => {
      for (const contactID of contactIDs) {
        const key = String(contactID);
        // AssignLabelFromWnd opens AddToAddressBook separately for an absent
        // owner; a canceled management window must not create that contact.
        if (runtime.contacts[key]) {
          runtime.contacts[key].labelMask = addLabelMask(
            runtime.contacts[key].labelMask,
            labelMask,
          );
        }
      }
      return runtime;
    });
    // addressbookService.OnOrganizationContactsUpdated consumes the new mask, with no standing change.
    const contacts = getCorporationRuntime(corporationID)?.contacts || {};
    notifyOrganizationContactsUpdated(corporationID, contactIDs.filter(id => contacts[String(id)]).map(id => [
      Number(id), null, toMarshalMaskValue(contacts[String(id)].labelMask),
    ]));
    return null;
  }

  Handle_RemoveLabels(args, session) {
    const corporationID = resolveCorporationID(session);
    if (!canManageCorporationContacts(corporationID, session)) {
      throwCorporationAccessDenied();
    }
    const contactIDs = extractList(args && args[0]);
    const labelMask = toLabelKey(args && args[1], "0");
    updateCorporationRuntime(corporationID, (runtime) => {
      for (const contactID of contactIDs) {
        if (runtime.contacts[String(contactID)]) {
          runtime.contacts[String(contactID)].labelMask = removeLabelMask(
            runtime.contacts[String(contactID)].labelMask,
            labelMask,
          );
        }
      }
      return runtime;
    });
    // addressbookService.OnOrganizationContactsUpdated consumes the new mask, with no standing change.
    const contacts = getCorporationRuntime(corporationID)?.contacts || {};
    notifyOrganizationContactsUpdated(corporationID, contactIDs.filter(id => contacts[String(id)]).map(id => [
      Number(id), null, toMarshalMaskValue(contacts[String(id)].labelMask),
    ]));
    return null;
  }

  Handle_GetBulletins(args, session) {
    const corporationID = resolveCorporationID(session);
    requireCorporationReadAccess(corporationID, session);
    const runtime = getCorporationRuntime(corporationID) || {};
    return buildDbRowset(
      BULLETIN_DBROW_COLUMNS,
      (runtime.bulletins || [])
        .slice()
        .sort((left, right) => Number(left.sortOrder || 0) - Number(right.sortOrder || 0))
        .map((bulletin) => ({
          bulletinID: Number(bulletin.bulletinID || 0),
          ownerID: Number(bulletin.ownerID || corporationID),
          createCharacterID: Number(bulletin.createCharacterID || bulletin.editCharacterID || 0),
          createDateTime: bulletin.createDateTime || "0",
          editCharacterID: Number(bulletin.editCharacterID || 0),
          editDateTime: bulletin.editDateTime || "0",
          title: bulletin.title || "",
          body: bulletin.body || "",
          sortOrder: Number(bulletin.sortOrder || 0),
        })),
      "carbon.common.script.sys.crowset.CRowset",
    );
  }

  Handle_GetBulletinEntries(args, session) {
    return this.Handle_GetBulletins(args, session);
  }

  Handle_GetBulletin(args, session) {
    requireCorporationReadAccess(resolveCorporationID(session), session);
    const bulletinID = normalizePositiveInteger(args && args[0], null);
    const corporationID = resolveCorporationID(session);
    const runtime = getCorporationRuntime(corporationID) || {};
    const bulletin = (runtime.bulletins || []).find(
      (entry) => Number(entry.bulletinID) === Number(bulletinID),
    );
    return bulletin ? buildBulletinRow(bulletin) : null;
  }

  Handle_AddBulletin(args, session) {
    const corporationID = resolveCorporationID(session);
    if (!canManageCorporationBulletins(corporationID, session)) {
      throwCorporationAccessDenied();
    }
    const title = normalizeText(args && args[0], "");
    const body = normalizeText(args && args[1], "");
    const bulletinID = normalizePositiveInteger(args && args[2], null);
    const editDateTime = args && args[3] ? args[3] : null;
    let nextBulletinID = bulletinID;
    updateCorporationRuntime(corporationID, (runtime, corporationRecord, table) => {
      if (!nextBulletinID) {
        nextBulletinID = table._meta.nextBulletinID++;
      }
      const index = (runtime.bulletins || []).findIndex(
        (entry) => Number(entry.bulletinID) === Number(nextBulletinID),
      );
      const priorBulletin = index >= 0 ? runtime.bulletins[index] : null;
      const record = {
        bulletinID: nextBulletinID,
        ownerID: corporationID,
        createCharacterID: priorBulletin
          ? Number(priorBulletin.createCharacterID || priorBulletin.editCharacterID || 0)
          : resolveCharacterID(session),
        createDateTime:
          priorBulletin
            ? priorBulletin.createDateTime
            : String(currentFileTime()),
        editDateTime: editDateTime ? String(editDateTime) : String(currentFileTime()),
        editCharacterID: resolveCharacterID(session),
        title,
        body,
        sortOrder: priorBulletin ? priorBulletin.sortOrder || 0 : runtime.bulletins.length,
      };
      if (index >= 0) {
        runtime.bulletins[index] = record;
      } else {
        runtime.bulletins.push(record);
      }
      return runtime;
    });
    return nextBulletinID;
  }

  Handle_UpdateBulletin(args, session) {
    return this.Handle_AddBulletin(
      [
        args && args[1],
        args && args[2],
        args && args[0],
        args && args.length > 3 ? args[3] : null,
      ],
      session,
    );
  }

  Handle_DeleteBulletin(args, session) {
    const corporationID = resolveCorporationID(session);
    if (!canManageCorporationBulletins(corporationID, session)) {
      throwCorporationAccessDenied();
    }
    const bulletinID = normalizePositiveInteger(args && args[0], null);
    updateCorporationRuntime(corporationID, (runtime) => {
      runtime.bulletins = (runtime.bulletins || []).filter(
        (bulletin) => Number(bulletin.bulletinID) !== Number(bulletinID),
      );
      return runtime;
    });
    return null;
  }

  Handle_UpdateBulletinOrder(args, session) {
    const corporationID = resolveCorporationID(session);
    if (!canManageCorporationBulletins(corporationID, session)) {
      throwCorporationAccessDenied();
    }
    const newOrder = extractList(args && args[0]);
    updateCorporationRuntime(corporationID, (runtime) => {
      const orderMap = new Map(
        newOrder.map((bulletinID, index) => [Number(bulletinID), index]),
      );
      for (const bulletin of runtime.bulletins || []) {
        if (orderMap.has(Number(bulletin.bulletinID))) {
          bulletin.sortOrder = orderMap.get(Number(bulletin.bulletinID));
        }
      }
      runtime.bulletins.sort(
        (left, right) => Number(left.sortOrder || 0) - Number(right.sortOrder || 0),
      );
      return runtime;
    });
    return null;
  }

  Handle_GetMyApplications(args, session) {
    requireSessionCharacter(session);
    const characterID = resolveCharacterID(session, []);
    const runtimeTable = ensureRuntimeInitialized();
    const entries = [];
    for (const [corporationID, runtime] of Object.entries(runtimeTable.corporations || {})) {
      const matching = Object.values(runtime.applications || {})
        .filter((application) => Number(application.characterID) === Number(characterID))
        .map((application) => buildApplicationRow(application));
      if (matching.length > 0) {
        entries.push([Number(corporationID), buildList(matching)]);
      }
    }
    return buildDict(entries);
  }

  Handle_GetMyOldApplications(args, session) {
    requireSessionCharacter(session);
    const characterID = resolveCharacterID(session, []);
    const runtimeTable = ensureRuntimeInitialized();
    const rows = [];
    for (const runtime of Object.values(runtimeTable.corporations || {})) {
      rows.push(...filterApplicationHistory(runtime.applicationHistory || [], characterID));
    }
    return buildList(rows);
  }

  Handle_GetApplications(args, session) {
    const corporationID = resolveCorporationID(session);
    if (!canManageCorporationRecruitment(corporationID, session)) {
      throwCorporationAccessDenied();
    }
    const runtime = getCorporationRuntime(corporationID) || {};
    return buildApplicationsByCharacter(runtime);
  }

  Handle_GetOldApplications(args, session) {
    const corporationID = resolveCorporationID(session);
    if (!canManageCorporationRecruitment(corporationID, session)) {
      throwCorporationAccessDenied();
    }
    const runtime = getCorporationRuntime(corporationID) || {};
    return buildList(filterApplicationHistory(runtime.applicationHistory || []));
  }

  Handle_InsertApplication(args, session) {
    requireSessionCharacter(session);
    const corporationID = normalizePositiveInteger(args && args[0], null);
    const applicationText = normalizeText(args && args[1], "");
    const characterID = resolveCharacterID(session, []);
    let applicationID = null;
    let createdApplication = null;
    updateCorporationRuntime(corporationID, (runtime, corporationRecord, table) => {
      applicationID = table._meta.nextApplicationID++;
      createdApplication = {
        applicationID,
        corporationID,
        characterID,
        applicationText,
        status: APP_STATUS_APPLIED_BY_CHARACTER,
        applicationDateTime: String(currentFileTime()),
        customMessage: "",
        responseText: null,
        deleted: false,
      };
      runtime.applications[String(applicationID)] = createdApplication;
      return runtime;
    });
    notifyCorporationApplicationChanged(
      corporationID,
      characterID,
      applicationID,
      buildCorporationApplicationRow(createdApplication),
    );
    notifyCorporationApplicationReceived(corporationID, characterID, applicationText);
    return applicationID;
  }

  Handle_UpdateApplicationOffer(args, session) {
    requireSessionCharacter(session);
    const applicationID = normalizePositiveInteger(args && args[0], null);
    const characterID = normalizePositiveInteger(args && args[1], null);
    const corporationID = normalizePositiveInteger(args && args[2], null);
    const applicationText = normalizeText(args && args[3], "");
    const status = normalizeInteger(args && args[4], 0);
    const customMessage = normalizeText(args && args[5], "");
    const runtime = getCorporationRuntime(corporationID) || {};
    const existingApplication = findApplicationByID(runtime, applicationID);
    if (!existingApplication) {
      return null;
    }
    const applicantID = normalizePositiveInteger(
      existingApplication.characterID,
      null,
    );
    const actingCharacterID = resolveCharacterID(session, []);
    if (
      Number(existingApplication.corporationID) !== Number(corporationID) ||
      !applicantID ||
      !actingCharacterID ||
      (characterID && Number(characterID) !== Number(applicantID))
    ) {
      throwCorporationAccessDenied();
    }
    if (
      [
        APP_STATUS_RENEGOTIATED_BY_CHARACTER,
        APP_STATUS_ACCEPTED_BY_CHARACTER,
        APP_STATUS_REJECTED_BY_CHARACTER,
        APP_STATUS_WITHDRAWN_BY_CHARACTER,
      ].includes(status)
    ) {
      if (Number(actingCharacterID) !== Number(applicantID)) {
        throwCorporationAccessDenied();
      }
      if (
        status === APP_STATUS_ACCEPTED_BY_CHARACTER &&
        ![
          APP_STATUS_ACCEPTED_BY_CORPORATION,
          APP_STATUS_INVITED_BY_CORPORATION,
        ].includes(Number(existingApplication.status))
      ) {
        throwCorporationAccessDenied();
      }
    } else if (
      [
        APP_STATUS_REJECTED_BY_CORPORATION,
        APP_STATUS_RENEGOTIATED_BY_CORPORATION,
        APP_STATUS_ACCEPTED_BY_CORPORATION,
      ].includes(status)
    ) {
      if (
        !canManageCorporationRecruitment(corporationID, session) ||
        ![
          APP_STATUS_APPLIED_BY_CHARACTER,
          APP_STATUS_RENEGOTIATED_BY_CHARACTER,
          APP_STATUS_RENEGOTIATED_BY_CORPORATION,
        ].includes(Number(existingApplication.status))
      ) {
        throwCorporationAccessDenied();
      }
    } else {
      throwCorporationAccessDenied();
    }
    // Invitation acceptance must honor the same departure rules as voluntarily quitting.
    // Adapted from ciefa/evejs-ciefa-fork fedc9fdd1; validate before any state or notice changes.
    // A retained application/session must not skip the current corporation's
    // CEO, role or stasis departure restrictions using an old affiliation.
    const currentCorporationID = normalizePositiveInteger(
      requireSessionCharacter(session).corporationID,
      DEFAULT_NPC_CORPORATION_ID,
    );
    if (
      status === APP_STATUS_ACCEPTED_BY_CHARACTER &&
      currentCorporationID !== corporationID &&
      !isNpcCorporationID(currentCorporationID)
    ) {
      const [canLeave, message, values] = this.Handle_CanLeaveCurrentCorporation([], {
        ...session,
        corporationID: currentCorporationID,
        corpid: currentCorporationID,
      });
      if (!canLeave) {
        throwWrappedUserError(
          message || "CrpAccessDenied",
          values && values.type === "dict" ? Object.fromEntries(values.entries) : values,
        );
      }
    }
    // A full corporation takes no one more, checked before any state changes.
    // The client has no message of its own for this, so the reason is text.
    if (
      status === APP_STATUS_ACCEPTED_BY_CHARACTER &&
      currentCorporationID !== corporationID
    ) {
      const targetCorporation = getCorporationRecord(corporationID) || {};
      if (!hasRoomForAnotherMember(targetCorporation.memberLimit, targetCorporation.memberCount)) {
        throwWrappedUserError("CrpAccessDenied", {
          reason: `This corporation is at its member limit (${targetCorporation.memberLimit}).`,
        });
      }
    }
    let joinedCharacterID = null;
    let nextApplicationRow = null;
    let applicationFound = false;
    let applicantCharacterID = null;
    updateCorporationRuntime(corporationID, (runtime) => {
      const application = findApplicationByID(runtime, applicationID);
      if (!application) {
        return runtime;
      }
      applicationFound = true;
      applicantCharacterID = normalizePositiveInteger(application.characterID, null);
      application.applicationText = applicationText;
      application.status = status;
      application.customMessage = customMessage;
      application.responseText = customMessage;
      application.deleted = false;
      if (status === APP_STATUS_ACCEPTED_BY_CHARACTER) {
        joinedCharacterID = characterID || application.characterID;
      }
      if (TERMINAL_APPLICATION_STATUSES.has(status)) {
        const archivedApplication = archiveApplication(runtime, application);
        nextApplicationRow = buildCorporationApplicationRow(archivedApplication);
      } else {
        nextApplicationRow = buildCorporationApplicationRow(application);
      }
      return runtime;
    });
    if (applicationFound) {
      const delayApplicationChanged =
        status === APP_STATUS_ACCEPTED_BY_CHARACTER;
      if (!delayApplicationChanged) {
        notifyCorporationApplicationChanged(
          corporationID,
          applicantCharacterID || characterID,
          applicationID,
          nextApplicationRow,
        );
      }
      const notifyCharacterID = applicantCharacterID || characterID;
      if (status === APP_STATUS_ACCEPTED_BY_CORPORATION) {
        notifyCorporationApplicationAccepted(
          corporationID,
          notifyCharacterID,
          applicationText,
        );
      } else if (status === APP_STATUS_REJECTED_BY_CORPORATION) {
        notifyCorporationApplicationRejected(
          corporationID,
          notifyCharacterID,
          applicationText,
          customMessage,
        );
      } else if (status === APP_STATUS_ACCEPTED_BY_CHARACTER) {
        notifyCorporationApplicationAcceptedByCharacter(
          corporationID,
          notifyCharacterID,
          applicationText,
        );
      } else if (status === APP_STATUS_REJECTED_BY_CHARACTER) {
        notifyCorporationApplicationRejectedByCharacter(
          corporationID,
          notifyCharacterID,
          applicationText,
        );
      } else if (status === APP_STATUS_WITHDRAWN_BY_CHARACTER) {
        notifyCorporationApplicationWithdrawn(
          corporationID,
          notifyCharacterID,
          applicationText,
        );
      }
    }
    if (joinedCharacterID) {
      const currentCorporationID = normalizePositiveInteger(
        (getCharacterRecord(joinedCharacterID) || {}).corporationID,
        DEFAULT_NPC_CORPORATION_ID,
      );
      const moveResult = moveCharacterToCorporation(
        joinedCharacterID,
        currentCorporationID,
        corporationID,
        { applicationAccept: true },
      );
      if (moveResult.success) {
        archiveAllActiveApplicationsForCharacter(joinedCharacterID, applicationID);
      }
    }
    if (applicationFound && status === APP_STATUS_ACCEPTED_BY_CHARACTER) {
      notifyCorporationApplicationChanged(
        corporationID,
        applicantCharacterID || characterID,
        applicationID,
        nextApplicationRow,
      );
    }
    return null;
  }

  Handle_GetCorpWelcomeMail(args, session) {
    requireCorporationReadAccess(resolveCorporationID(session), session);
    const runtime = getCorporationRuntime(resolveCorporationID(session)) || {};
    return buildCorporationWelcomeMailPayload(runtime);
  }

  Handle_SetCorpWelcomeMail(args, session) {
    const corporationID = resolveCorporationID(session);
    if (!canManageCorporationRecruitment(corporationID, session)) {
      throwCorporationAccessDenied();
    }
    const welcomeMail = normalizeText(args && args[0], "");
    const editorCharacterID = resolveCharacterID(session, []);
    const changeDate = String(currentFileTime());
    updateCorporationRuntime(corporationID, (runtime) => {
      runtime.welcomeMail = welcomeMail;
      runtime.welcomeMailCharacterID = normalizePositiveInteger(
        editorCharacterID,
        null,
      );
      runtime.welcomeMailChangeDate = changeDate;
      return runtime;
    });
    notifyCorporationWelcomeMailChanged(
      corporationID,
      editorCharacterID,
      changeDate,
    );
    return null;
  }

  Handle_InsertInvitation(args, session) {
    const corporationID = resolveCorporationID(session);
    if (!canManageCorporationRecruitment(corporationID, session)) {
      throwCorporationAccessDenied();
    }
    requireSessionCharacter(session);
    const invokingCharacterID = resolveCharacterID(session, []);
    const characterID = normalizePositiveInteger(args && args[0], null);
    let invitationID = null;
    let applicationID = null;
    let invitationApplication = null;
    updateCorporationRuntime(corporationID, (runtime, corporationRecord, table) => {
      invitationID = table._meta.nextInvitationID++;
      applicationID = table._meta.nextApplicationID++;
      invitationApplication = {
        applicationID,
        corporationID,
        characterID,
        applicationText: "",
        status: APP_STATUS_INVITED_BY_CORPORATION,
        applicationDateTime: String(currentFileTime()),
        customMessage: "",
        responseText: "",
        deleted: false,
      };
      runtime.applications[String(applicationID)] = invitationApplication;
      runtime.invitations[String(invitationID)] = {
        invitationID,
        applicationID,
        corporationID,
        characterID,
        status: APP_STATUS_INVITED_BY_CORPORATION,
        invitationDateTime: String(currentFileTime()),
      };
      return runtime;
    });
    notifyCorporationApplicationChanged(
      corporationID,
      characterID,
      applicationID,
      buildCorporationApplicationRow(invitationApplication),
    );
    notifyCorporationApplicationInvited(
      corporationID,
      characterID,
      invokingCharacterID,
    );
    return invitationID;
  }

  Handle_GetMyOpenInvitations(args, session) {
    requireSessionCharacter(session);
    const characterID = resolveCharacterID(session, []);
    const runtimeTable = ensureRuntimeInitialized();
    const rows = [];
    for (const runtime of Object.values(runtimeTable.corporations || {})) {
      for (const application of Object.values(runtime.applications || {})) {
        if (
          Number(application.characterID) === Number(characterID) &&
          [
            APP_STATUS_ACCEPTED_BY_CORPORATION,
            APP_STATUS_INVITED_BY_CORPORATION,
          ].includes(Number(application.status))
        ) {
          rows.push(
            buildKeyVal([
              ["invitationID", application.applicationID],
              ["corporationID", application.corporationID],
              ["characterID", application.characterID],
              ["status", application.status],
              ["invitationDateTime", buildFiletimeLong(application.applicationDateTime)],
            ]),
          );
        }
      }
    }
    return buildList(rows);
  }

  Handle_GetMembersPaged(args, session) {
    const corporationID = resolveCorporationID(session);
    requireCorporationReadAccess(corporationID, session);
    const page = normalizeInteger(args && args[0], 1);
    const members = listCorporationMembers(corporationID);
    const { start, end } = getPageForMembers(page);
    return buildPagedResultSet(
      members.slice(start, end).map((member) => buildMemberRow(member)),
      members.length,
      Math.max(0, page - 1),
      end - start,
    );
  }

  Handle_GetMembersByIds(args, session) {
    const corporationID = resolveCorporationID(session);
    requireCorporationReadAccess(corporationID, session);
    const memberIDs = extractList(args && args[0]);
    return buildList(
      memberIDs
        .map((memberID) => getCorporationMember(corporationID, memberID))
        .filter(Boolean)
        .map((member) => buildMemberRow(member)),
    );
  }

  Handle_GetMember(args, session) {
    const corporationID = resolveCorporationID(session);
    requireCorporationReadAccess(corporationID, session);
    const memberID = normalizePositiveInteger(args && args[0], null);
    const member = getCorporationMember(corporationID, memberID);
    return member ? buildMemberRow(member) : null;
  }

  Handle_UpdateMember(args, session) {
    const corporationID = resolveCorporationID(session);
    return applyPreparedMemberUpdate(
      prepareMemberUpdate(corporationID, args, session),
      session,
    );
  }

  Handle_UpdateMembers(args, session) {
    const rows = extractList(args && args[0]);
    const corporationID = resolveCorporationID(session);
    const preparedRows = rows.map((row) =>
      prepareMemberUpdate(corporationID, row, session, { bulk: true }));
    const memberIDs = preparedRows.map((prepared) => prepared.memberID);
    if (new Set(memberIDs).size !== memberIDs.length) {
      throwCorporationAccessDenied();
    }
    return applyPreparedMemberUpdates(preparedRows, session);
  }

  Handle_GetMyGrantableRoles(args, session) {
    const corporationID = resolveCorporationID(session);
    requireCorporationReadAccess(corporationID, session);
    const grantables = getCorporationGrantableRoleState(
      corporationID,
      resolveCharacterID(session, []),
    );
    return [
      buildLong(grantables.grantableRoles),
      buildLong(grantables.grantableRolesAtHQ),
      buildLong(grantables.grantableRolesAtBase),
      buildLong(grantables.grantableRolesAtOther),
    ];
  }

  Handle_SetAccountKey(args, session) {
    const corporationID = resolveCorporationID(session);
    const characterID = resolveCharacterID(session, []);
    const requestedAccountKey = normalizeInteger(args && args[0], 0);
    const divisionRole = getCorporationWalletDivisionTakeRole(requestedAccountKey);
    if (!divisionRole || !corporationAuthorityHasRole(
      getPersistedCorporationAuthority(session), divisionRole,
    )) {
      throwCorporationAccessDenied();
    }
    const previousMember = buildCorporationMemberSnapshot(corporationID, characterID);
    const previousSessionAccountKey =
      session && (session.corpAccountKey ?? session.corpaccountkey ?? null);
    const accountKey = normalizeCorporationWalletKey(requestedAccountKey);
    updateCorporationRuntime(corporationID, (runtime) => {
      if (runtime.members[String(characterID)]) {
        runtime.members[String(characterID)].accountKey = accountKey;
      }
      return runtime;
    });
    notifyCorporationMemberChanged(corporationID, characterID, previousMember, {
      refreshSession: false,
    });
    if (session) {
      session.corpAccountKey = accountKey;
      session.corpaccountkey = accountKey;
      if (
        typeof session.sendSessionChange === "function" &&
        previousSessionAccountKey !== accountKey
      ) {
        session.sendSessionChange({
          corpAccountKey: [previousSessionAccountKey, accountKey],
        });
      }
    }
    return true;
  }

  Handle_ExecuteActions(args, session) {
    const corporationID = resolveCorporationID(session);
    const targetIDs = extractList(args && args[0])
      .map((value) => normalizePositiveInteger(value, null))
      .filter(Boolean);
    if (new Set(targetIDs).size !== targetIDs.length) {
      throwCorporationAccessDenied();
    }
    const actionRows = extractList(args && args[1]);
    const hasGiveAction = actionRows.some((rawAction) => {
      const values = extractList(rawAction);
      return normalizeInteger(values[0], 0) === CTV_GIVE;
    });
    const hasAdministrativeAction = actionRows.some((rawAction) => {
      const values = extractList(rawAction);
      return normalizeInteger(values[0], 0) !== CTV_GIVE;
    });
    if (hasGiveAction && hasAdministrativeAction) {
      // Cash/share grants are durably settled. Administrative patches are a
      // separate corporation-runtime write, so accepting a mixed batch would
      // allow a restart to commit only half of the request.
      throwCorporationAccessDenied();
    }
    if (hasGiveAction && !canAdministerCorporation(corporationID, session)) {
      // Exact wallet/share delegation needs TQ goldens. Until then, keep this
      // high-impact legacy bulk path behind the corporation administrator role.
      throwCorporationAccessDenied();
    }
    const simulatedRows = targetIDs.map((targetID) => {
      const member = getCorporationMember(corporationID, targetID);
      if (!member) {
        throwCorporationAccessDenied();
      }
      const masks = getDirectMemberRoleMasks(member);
      const row = [
        targetID, undefined, undefined, undefined,
        masks.roles, masks.grantableRoles,
        masks.rolesAtHQ, masks.grantableRolesAtHQ,
        masks.rolesAtBase, masks.grantableRolesAtBase,
        masks.rolesAtOther, masks.grantableRolesAtOther,
        undefined, member.titleMask, undefined,
      ];
      for (const rawAction of actionRows) {
        const values = extractList(rawAction);
        if (values.length < 3) {
          throwCorporationAccessDenied();
        }
        const verb = normalizeInteger(values[0], 0);
        const rawProperty = values[1];
        const property = normalizeText(rawProperty, "");
        const spec = MEMBER_ROLE_FIELD_SPECS.find(
          (candidate) => candidate.property === property,
        );
        if (spec) {
          const currentMask = parseInboundRoleMask(row[spec.index], spec.allowedMask);
          const actionMask = parseInboundRoleMask(values[2], spec.allowedMask);
          if (verb === CTV_ADD) row[spec.index] = currentMask | actionMask;
          else if (verb === CTV_REMOVE) row[spec.index] = currentMask & ~actionMask;
          else if (verb === CTV_SET) row[spec.index] = actionMask;
          else throwCorporationAccessDenied();
        } else if (property === "titleMask") {
          const actionMask = parseInboundTitleMask(values[2]);
          const currentMask = parseInboundTitleMask(row[13]);
          if (verb === CTV_ADD) row[13] = currentMask | actionMask;
          else if (verb === CTV_REMOVE) row[13] = currentMask & ~actionMask;
          else if (verb === CTV_SET) row[13] = actionMask;
          else throwCorporationAccessDenied();
        } else if (property === "baseID") {
          if (verb !== CTV_SET) throwCorporationAccessDenied();
          row[12] = values[2] === null ? 0 : values[2];
        } else if (
          verb !== CTV_GIVE ||
          (
            normalizeInteger(rawProperty, 0) !== CTPG_CASH &&
            normalizeInteger(rawProperty, 0) !== CTPG_SHARES
          )
        ) {
          throwCorporationAccessDenied();
        }
      }
      return prepareMemberUpdate(corporationID, row, session);
    });
    // The simulated patches are also the authority-checked write plan. Applying
    // the original bit actions would diverge for Director transitions, where TQ
    // canonicalizes every other role collection and title mask back to zero.
    if (!hasGiveAction) {
      return applyPreparedMemberUpdates(simulatedRows, session);
    }
    const giveActionRows = actionRows.filter((rawAction) => {
      const values = extractList(rawAction);
      return normalizeInteger(values[0], 0) === CTV_GIVE;
    });
    const previousMembersByID = new Map(
      targetIDs
        .filter((targetID) => targetID > 0)
        .map((targetID) => [
          targetID,
          buildCorporationMemberSnapshot(corporationID, targetID),
        ]),
    );
    const result = executeCorporationMemberActions(
      corporationID,
      args && args[0],
      giveActionRows,
      session,
    );
    const finalize = (settledResult) => {
      if (
        !settledResult ||
        settledResult.success !== true ||
        settledResult.rejected === true
      ) {
        log.warn(
          `[CorpRegistry] ExecuteActions failed for corp ${corporationID}: ` +
            `${settledResult && settledResult.errorMsg || "UNKNOWN"}`,
        );
        return null;
      }
      if (hasAdministrativeAction) {
        applyPreparedMemberUpdates(simulatedRows, session);
      }
      if (
        !settledResult.data?.notificationsHandled &&
        !hasAdministrativeAction
      ) {
        for (const targetID of settledResult.data &&
          Array.isArray(settledResult.data.targetIDs)
          ? settledResult.data.targetIDs
          : []) {
          notifyCorporationMemberChanged(
            corporationID,
            targetID,
            previousMembersByID.get(Number(targetID)) || null,
            { refreshSession: false },
          );
        }
      }
      return null;
    };
    if (result && typeof result.then === "function") {
      return result.then(finalize).catch((error) => {
        log.warn(
          `[CorpRegistry] ExecuteActions settlement deferred for corp ` +
            `${corporationID}: ${error.message}`,
        );
        return null;
      });
    }
    return finalize(result);
  }

  Handle_GetPendingAutoKicks(args, session) {
    if (!canAdministerCorporation(resolveCorporationID(session), session)) {
      throwCorporationAccessDenied();
    }
    const runtime = getCorporationRuntime(resolveCorporationID(session)) || {};
    return buildList((runtime.pendingAutoKicks || []).map((entry) => entry));
  }

  Handle_GetMemberIDsByQuery(args, session) {
    const corporationID = resolveCorporationID(session);
    requireCorporationReadAccess(corporationID, session);
    const includeImplied = normalizeBoolean(args && args[1], false);
    const searchTitles = normalizeBoolean(args && args[2], false);
    return buildList(
      queryCorporationMemberIDs(
        corporationID,
        args && args[0],
        includeImplied,
        searchTitles,
      ),
    );
  }

  Handle_GetMemberTrackingInfo(args, session) {
    const corporationID = resolveCorporationID(session);
    if (!canAdministerCorporation(corporationID, session)) {
      throwCorporationAccessDenied();
    }
    return buildCachedResult(
      buildMemberTrackingRows(corporationID),
      {
        serviceName: "corpRegistry",
        method: "GetMemberTrackingInfo",
        args: [corporationID],
        versionCheck: "5 minutes",
        sessionInfo: "corpid",
        sessionInfoValue: corporationID,
      },
    );
  }

  Handle_GetMemberTrackingInfoSimple(args, session) {
    const corporationID = resolveCorporationID(session);
    requireCorporationReadAccess(corporationID, session);
    return buildCorporationMemberTrackingRowset(corporationID, {
      includePrivateDetails: false,
    });
  }

  Handle_GetNumberOfPotentialCEOs(args, session) {
    const corporationID = resolveCorporationID(session);
    requireCorporationReadAccess(corporationID, session);
    return buildList(listCorporationMembers(corporationID).map((member) => member.characterID));
  }

  Handle_GetTitles(args, session) {
    const corporationID = resolveCorporationID(session);
    requireCorporationReadAccess(corporationID, session);
    const runtime = getCorporationRuntime(corporationID) || {};
    return buildDbIndexRowset(
      TITLE_DBROW_COLUMNS,
      Object.values(runtime.titles || {}).map((title) => [
        Number(title.titleID),
        buildTitleRowValues(title, corporationID),
      ]),
      "titleID",
    );
  }

  Handle_UpdateTitle(args, session) {
    const corporationID = resolveCorporationID(session);
    return applyPreparedTitleUpdates(
      corporationID,
      [prepareTitleUpdate(corporationID, args, session)],
    );
  }

  Handle_UpdateTitles(args, session) {
    const corporationID = resolveCorporationID(session);
    const preparedRows = extractList(args && args[0]).map((row) =>
      prepareTitleUpdate(corporationID, row, session));
    const titleIDs = preparedRows.map((prepared) => prepared.titleID);
    if (new Set(titleIDs).size !== titleIDs.length) {
      throwCorporationAccessDenied();
    }
    return applyPreparedTitleUpdates(corporationID, preparedRows);
  }

  Handle_DeleteTitle(args, session) {
    const corporationID = resolveCorporationID(session);
    const titleID = normalizePositiveInteger(args && args[0], null);
    if (
      !canAdministerCorporation(corporationID, session) ||
      !isValidTitleID(titleID)
    ) {
      throwCorporationAccessDenied();
    }
    const runtime = getCorporationRuntime(corporationID) || {};
    const previousTitle = buildTitleSnapshot(
      titleID,
      runtime.titles && runtime.titles[String(titleID)],
    );
    const affectedMembers = listCorporationMembers(corporationID)
      .filter((member) => (normalizeInteger(member.titleMask, 0) & titleID) !== 0)
      .map((member) => ({
        characterID: member.characterID,
        previous: buildCorporationMemberSnapshot(
          corporationID,
          member.characterID,
        ),
      }));
    updateCorporationRuntime(corporationID, (runtime) => {
      runtime.titles[String(titleID)] = buildTitleSnapshot(titleID);
      for (const member of Object.values(runtime.members || {})) {
        if ((normalizeInteger(member.titleMask, 0) & titleID) !== 0) {
          member.titleMask = normalizeInteger(member.titleMask, 0) & ~titleID;
          extendMemberRoleStasis(member);
        }
      }
      return runtime;
    });
    const nextRuntime = getCorporationRuntime(corporationID) || {};
    notifyCorporationTitleChanged(
      corporationID,
      titleID,
      previousTitle,
      buildTitleSnapshot(
        titleID,
        nextRuntime.titles && nextRuntime.titles[String(titleID)],
      ),
    );
    for (const affected of affectedMembers) {
      notifyCorporationMemberChanged(
        corporationID,
        affected.characterID,
        affected.previous,
      );
    }
    return null;
  }

  Handle_UpdateDivisionNames(args, session) {
    const corporationID = resolveCorporationID(session);
    // Division names are corporation details, and the client only offers the
    // edit to the CEO and directors. Without this check any member could
    // rename every hangar and wallet division from a forged call.
    if (!canAdministerCorporation(corporationID, session)) {
      throwCorporationAccessDenied();
    }
    const previousCorporation = buildCorporationSnapshot(corporationID);
    updateCorporationRuntime(corporationID, (runtime) => {
      for (let index = 0; index < 14; index += 1) {
        runtime.divisionNames[index + 1] = normalizeText(args && args[index], runtime.divisionNames[index + 1]);
      }
      return runtime;
    });
    notifyCorporationChanged(corporationID, previousCorporation);
    return null;
  }

  Handle_GetSharesByShareholder(args, session) {
    requireSessionCharacter(session);
    const corporationID = resolveCorporationID(session);
    const shareholderID =
      normalizeInteger(args && args[0], 0) === 1
        ? corporationID
        : resolveCharacterID(session, []);
    if (shareholderID === corporationID) {
      requireCorporationShareReadAccess(corporationID, session);
    }
    // bco_shares.GetSharesByShareholder(corpShares) and the wallet's Shares tab (sharesPanel.py GetScrollList): the
    // shares the character (or, with 1, its corporation) holds, a row for each corporation it holds shares in,
    // indexed by corporationID. It answered only the session's own corporation, and with nought where none were
    // held, which the tab would list as a holding of no shares in it.
    const corporations = ensureRuntimeInitialized().corporations || {};
    const rows = [];
    for (const [heldCorporationID, runtime] of Object.entries(corporations)) {
      const shares = Number(((runtime && runtime.shares) || {})[String(shareholderID)] || 0);
      if (shares > 0) rows.push([Number(heldCorporationID), shares]);
    }
    return buildDbRowset(SHARE_HOLDING_DBROW_COLUMNS, rows, "carbon.common.script.sys.crowset.CRowset");
  }

  Handle_GetShareholders(args, session) {
    const corporationID = normalizePositiveInteger(args && args[0], resolveCorporationID(session));
    const authority = getPersistedCorporationAuthority(session);
    const ownCorporation = Number(corporationID) === Number(authority && authority.corporationID);
    if (ownCorporation) {
      requireCorporationShareReadAccess(corporationID, session);
    } else if (!authority || !authority.isCEO) {
      throwCorporationAccessDenied();
    }
    const runtime = getCorporationRuntime(corporationID) || {};
    // voting._CanVote checks whether an external issuer's shareholders contain
    // the CEO's corporation. That lookup needs only its own holding, never the
    // issuer's complete private shareholder roster. An absent holding is empty.
    // Compiled CorpShareholdersPanel iterates .itervalues() and reads all four
    // certificate fields. A plain Rowset has no such iterator. There is no TQ
    // GetShareholders reply in the local corpus to pin the exact container type.
    return buildDbIndexRowset(
      SHAREHOLDER_DBROW_COLUMNS,
      Object.entries(runtime.shares || {})
        .filter(([_shareholderID, shares]) => Number(shares) > 0)
        .filter(([shareholderID]) => ownCorporation || Number(shareholderID) === Number(authority.corporationID))
        .map(([shareholderID, shares]) => [
          Number(shareholderID),
          buildShareholderRow(Number(shareholderID), corporationID, shares),
        ]),
      "shareholderID",
    );
  }

  Handle_MoveCompanyShares(args, session) {
    return this._MoveShares(args, session, true);
  }

  Handle_MovePrivateShares(args, session) {
    return this._MoveShares(args, session, false);
  }

  _MoveShares(args, session, companyShares) {
    requireSessionCharacter(session);
    const corporationID = normalizePositiveInteger(args && args[0], resolveCorporationID(session));
    const toShareholderID = normalizePositiveInteger(args && args[1], null);
    const numberOfShares = Math.max(0, normalizeInteger(args && args[2], 0));
    // GiveSharesDialog passes the issuer, while the company holding belongs to
    // session.corpid (CorpSharesPanel.GetOwnerID), which can be another corp.
    const fromShareholderID = companyShares
      ? resolveCorporationID(session) : resolveCharacterID(session, []);
    if (companyShares && !canAdministerCorporation(fromShareholderID, session)) {
      throwCorporationAccessDenied();
    }
    const previousShares = (getCorporationRuntime(corporationID) || {}).shares || {};
    const updateResult = updateCorporationRuntime(corporationID, (runtime) => {
      const currentFrom = Number((runtime.shares || {})[String(fromShareholderID)] || 0);
      const moved = Math.min(currentFrom, numberOfShares);
      runtime.shares[String(fromShareholderID)] = currentFrom - moved;
      runtime.shares[String(toShareholderID)] =
        Number(runtime.shares[String(toShareholderID)] || 0) + moved;
      return runtime;
    });
    if (updateResult && updateResult.success) {
      notifyCorporationShareChanges(
        corporationID,
        previousShares,
        (getCorporationRuntime(corporationID) || {}).shares,
        [fromShareholderID, toShareholderID],
      );
    }
    return null;
  }

  Handle_PayoutDividend(args, session) {
    const corporationID = resolveCorporationID(session);
    const authority = getCorporationAdministrativeAuthority(corporationID, session);
    // The supported client's dividend form is available only to the CEO.
    if (!authority || !authority.isCEO) {
      throwCorporationAccessDenied();
    }
    const payShareholders = normalizeInteger(args && args[0], 1) ? 1 : 0;
    const payoutAmount = roundIsk(args && args[1]);
    if (!(corporationID > 0) || !(payoutAmount > 0)) {
      return null;
    }

    const sourceBalance = getCorporationWalletBalance(
      corporationID,
      CORPORATION_WALLET_KEY_START,
    );
    if (sourceBalance + 0.0001 < payoutAmount) {
      return null;
    }

    const runtime = getCorporationRuntime(corporationID) || {};
    const weightedRecipients = [];
    if (payShareholders) {
      for (const [ownerID, shares] of Object.entries(runtime.shares || {})) {
        const numericOwnerID = Number(ownerID) || 0;
        const numericShares = Number(shares || 0);
        if (!(numericOwnerID > 0) || !(numericShares > 0)) {
          continue;
        }
        if (getCharacterRecord(numericOwnerID)) {
          weightedRecipients.push({
            kind: "character",
            ownerID: numericOwnerID,
            weight: numericShares,
          });
          continue;
        }
        if (getCorporationRecord(numericOwnerID)) {
          weightedRecipients.push({
            kind: "corporation",
            ownerID: numericOwnerID,
            weight: numericShares,
          });
        }
      }
    } else {
      for (const member of listCorporationMembers(corporationID)) {
        if (Number(member && member.characterID) > 0) {
          weightedRecipients.push({
            kind: "character",
            ownerID: Number(member.characterID),
            weight: 1,
          });
        }
      }
    }

    const totalWeight = weightedRecipients.reduce(
      (sum, recipient) => sum + Number(recipient.weight || 0),
      0,
    );
    if (!(totalWeight > 0)) {
      return null;
    }

    const allocations = [];
    let remainingAmount = payoutAmount;
    let remainingWeight = totalWeight;
    for (let index = 0; index < weightedRecipients.length; index += 1) {
      const recipient = weightedRecipients[index];
      const weight = Number(recipient.weight || 0);
      if (!(weight > 0)) {
        continue;
      }
      let amount = remainingAmount;
      if (index < weightedRecipients.length - 1 && remainingWeight > 0) {
        amount = roundIsk((payoutAmount * weight) / totalWeight);
      }
      if (amount > remainingAmount) {
        amount = remainingAmount;
      }
      remainingAmount = roundIsk(remainingAmount - amount);
      remainingWeight -= weight;
      if (amount > 0) {
        allocations.push({
          ...recipient,
          amount,
        });
      }
    }

    const prepared = prepareCorporationDividend({
      corporationID,
      totalAmount: payoutAmount,
      allocations,
      payShareholders: payShareholders === 1,
    });
    if (!prepared || prepared.success !== true) {
      return null;
    }
    return settleCorporationDividend(
      corporationID,
      prepared.data.settlementID,
    ).then((result) => {
      if (!result || result.success !== true) {
        log.warn(
          `[CorpRegistry] dividend settlement deferred corp=${corporationID} ` +
            `settlement=${prepared.data.settlementID}: ` +
            `${result && result.errorMsg || "UNKNOWN"}`,
        );
      }
      return null;
    }).catch((error) => {
      log.warn(
        `[CorpRegistry] dividend settlement deferred corp=${corporationID} ` +
          `settlement=${prepared.data.settlementID}: ${error.message}`,
      );
      return null;
    });
  }

  async Handle_CreateAlliance(args, session) {
    const authority = getPersistedCorporationAuthority(session);
    if (!authority || !authority.isCEO) {
      throwCorporationAccessDenied();
    }
    const corporationID = authority.corporationID;
    const characterID = authority.characterID;
    const allianceOptions = normalizeAllianceFormationOptions({
      name: normalizeText(args && args[0], ""),
      shortName: normalizeText(args && args[1], ""),
      description: normalizeText(args && args[2], ""),
      url: normalizeText(args && args[3], ""),
    });
    const eligibility = checkAllianceFormationEligibility({
      characterID,
      corporationID,
      allianceOptions,
    });
    if (!eligibility || eligibility.success !== true) {
      throwAllianceFormationError(
        eligibility && eligibility.errorMsg || "ALLIANCE_FORMATION_INELIGIBLE",
      );
    }
    const founderWallet = getCharacterWallet(characterID);
    if (!founderWallet || founderWallet.balance < ALLIANCE_FOUNDING_COST) {
      throwWrappedUserError(
        "NotEnoughMoney",
        buildNotEnoughMoneyUserErrorValues(
          ALLIANCE_FOUNDING_COST,
          founderWallet ? founderWallet.balance : 0,
        ),
      );
    }
    const prepared = prepareAllianceFounding({
      characterID,
      corporationID,
      allianceOptions,
    });
    if (!prepared || prepared.success !== true) {
      throwAllianceFormationError(
        prepared && prepared.errorMsg || "ALLIANCE_FOUNDING_PREPARE_FAILED",
      );
    }
    let result;
    try {
      result = await settleAllianceFounding(corporationID);
    } catch (error) {
      if (error && error.name === "MachoWrappedException") {
        throw error;
      }
      log.warn(
        `[CorpRegistry] alliance founding settlement deferred corp=${corporationID}: ` +
          `${error.message}`,
      );
      return null;
    }
    if (result && result.rejected) {
      if (result.errorMsg === "INSUFFICIENT_FUNDS") {
        throwWrappedUserError(
          "NotEnoughMoney",
          buildNotEnoughMoneyUserErrorValues(
            ALLIANCE_FOUNDING_COST,
            getCharacterWallet(characterID)?.balance || 0,
          ),
        );
      }
      throwAllianceFormationError(result.errorMsg);
    }
    if (!result || result.success !== true || !result.data?.allianceID) {
      log.warn(
        `[CorpRegistry] alliance founding settlement deferred corp=${corporationID}: ` +
          `${result && result.errorMsg || "UNKNOWN"}`,
      );
      return null;
    }
    const allianceID = result.data.allianceID;
    return allianceID;
  }

  Handle_GetAllianceApplications(args, session) {
    const authority = requireAllianceApplicationCorporationAuthority(session);
    return buildCorporationAllianceApplicationsIndexRowset(
      authority.corporationID,
    );
  }

  Handle_DeleteAllianceApplication(args, session) {
    const authority = requireAllianceApplicationCorporationAuthority(session);
    const corporationID = authority.corporationID;
    const allianceID = normalizePositiveInteger(args && args[0], null);
    const application = getAllianceApplication(allianceID, corporationID);
    if (!allianceID || !application) {
      return null;
    }
    const previousApplication = buildAllianceApplicationSnapshot(
      allianceID,
      corporationID,
    );
    const result = deleteAllianceApplication({
      allianceID,
      corporationID,
      applicationID: application.applicationID,
      allowedStates: [
        ALLIANCE_APPLICATION_STATE.NEW,
        ALLIANCE_APPLICATION_STATE.REJECTED,
      ],
    });
    if (!result || result.success !== true) {
      throwCorporationAccessDenied();
    }
    notifyAllianceApplicationChanged(allianceID, corporationID, previousApplication);
    return null;
  }

  Handle_ApplyToJoinAlliance(args, session) {
    const authority = requireAllianceApplicationCorporationAuthority(
      session,
      { requireCEO: true },
    );
    const corporationID = authority.corporationID;
    const allianceID = normalizePositiveInteger(args && args[0], null);
    const applicationText = normalizeText(args && args[1], "");
    validateAllianceApplicationEligibility(corporationID, allianceID);
    if (getAllianceApplication(allianceID, corporationID)) {
      throwWrappedUserError("CantApplyTwiceToAlliance", {});
    }
    const previousApplication = buildAllianceApplicationSnapshot(
      allianceID,
      corporationID,
    );
    const result = createAllianceApplication({
      allianceID,
      corporationID,
      applicationText,
    });
    if (!result || result.success !== true) {
      if (result && result.errorMsg === "APPLICATION_ALREADY_EXISTS") {
        throwWrappedUserError("CantApplyTwiceToAlliance", {});
      }
      throwCorporationAccessDenied();
    }
    notifyAllianceApplicationChanged(allianceID, corporationID, previousApplication);
    return null;
  }

  // "Update with my skills" (corp_dlg_editcorpdetails.UpdateWithSkills) calls
  // this with no arguments: the CEO's skills set the member limit
  // (corporationMemberLimit). The client reads the corporation again only when
  // this returns something other than None, so it answers the new limit.
  //
  // Called with an argument, it is the server's own applications switch, which
  // the client never sends; the harness's setCorporationApplicationsEnabled
  // uses it.
  Handle_UpdateCorporationAbilities(args, session) {
    const corporationID = resolveCorporationID(session);
    if (!canAdministerCorporation(corporationID, session)) {
      throwCorporationAccessDenied();
    }
    const previousCorporation = buildCorporationSnapshot(corporationID);
    if (Array.isArray(args) && args.length > 0) {
      const applicationsEnabled = normalizeBoolean(args[0], true);
      updateCorporationRuntime(corporationID, (runtime) => {
        runtime.applicationsEnabled = applicationsEnabled ? 1 : 0;
        return runtime;
      });
      notifyCorporationChanged(corporationID, previousCorporation);
      return null;
    }
    const characterID = resolveCharacterID(session, []);
    const corporationRecord = getCorporationRecord(corporationID);
    if (!corporationRecord || Number(corporationRecord.ceoID) !== Number(characterID)) {
      // The client's own CEO-only refusal (base_corporation.py:322).
      throwWrappedUserError("CrpAccessDenied", {
        reason: [101, "UI/Corporations/AccessRestrictions/OnlyForActiveCEO"],
      });
    }
    const memberLimit = computeCharacterCorporationMemberLimit(characterID);
    updateCorporationRecord(corporationID, { memberLimit });
    notifyCorporationChanged(corporationID, previousCorporation);
    return memberLimit;
  }

  Handle_UpdateLogo(args, session) {
    const corporationID = resolveCorporationID(session);
    if (!canAdministerCorporation(corporationID, session)) {
      throwCorporationAccessDenied();
    }
    const previousCorporation = buildCorporationSnapshot(corporationID);
    updateCorporationRecord(corporationID, {
      shape1: normalizePositiveInteger(args && args[0], null),
      shape2: normalizePositiveInteger(args && args[1], null),
      shape3: normalizePositiveInteger(args && args[2], null),
      color1: normalizePositiveInteger(args && args[3], null),
      color2: normalizePositiveInteger(args && args[4], null),
      color3: normalizePositiveInteger(args && args[5], null),
      typeface: normalizePositiveInteger(args && args[6], null),
    });
    notifyCorporationChanged(corporationID, previousCorporation);
    return null;
  }

  Handle_UpdateCorporation(args, session) {
    const corporationID = resolveCorporationID(session);
    if (!canAdministerCorporation(corporationID, session)) {
      throwCorporationAccessDenied();
    }
    const previousCorporation = buildCorporationSnapshot(corporationID);
    const previousTaxRate = previousCorporation
      ? Number(previousCorporation.taxRate) || 0
      : 0;
    const nextTaxRate = Number(args && args[2]) || 0;
    const previousLoyaltyPointTaxRate = previousCorporation
      ? Number(previousCorporation.loyaltyPointTaxRate) || 0
      : 0;
    const nextLoyaltyPointTaxRate = Number(args && args[4]) || 0;
    updateCorporationRecord(corporationID, {
      description: normalizeText(args && args[0], ""),
      url: normalizeText(args && args[1], ""),
      taxRate: nextTaxRate,
      loyaltyPointTaxRate: nextLoyaltyPointTaxRate,
    });
    updateCorporationRuntime(corporationID, (runtime) => {
      runtime.applicationsEnabled = args && args[3] ? 1 : 0;
      return runtime;
    });
    notifyCorporationChanged(corporationID, previousCorporation);
    // CorpTaxChangeMsg (19): only when the tax rate actually moved (the same
    // handler also persists description/url/recruitment edits). The CEO who made
    // the change is excluded.
    if (nextTaxRate !== previousTaxRate) {
      notifyCorporationTaxRateChanged(corporationID, {
        excludeCharacterID: resolveCharacterID(session, []),
        oldTaxRate: previousTaxRate,
        newTaxRate: nextTaxRate,
      });
    }
    // The LP rate gets its own message, naming LP as the currency.
    if (nextLoyaltyPointTaxRate !== previousLoyaltyPointTaxRate) {
      notifyCorporationTaxRateChanged(corporationID, {
        excludeCharacterID: resolveCharacterID(session, []),
        currency: "LP",
        oldTaxRate: previousLoyaltyPointTaxRate,
        newTaxRate: nextLoyaltyPointTaxRate,
      });
    }
    return null;
  }

  Handle_GetSuggestedTickerNames(_args) {
    return buildList([
      buildKeyVal([["tickerName", buildRandomTickerSuggestion()]]),
    ]);
  }

  Handle_GetSuggestedAllianceShortNames(args) {
    return buildList(buildSuggestionObjects(args && args[0], "ALLY", "shortName"));
  }

  Handle_AddCorporation(args, session) {
    const creatorCharacterID = resolveCharacterID(session, []);
    const creatorWallet = getCharacterWallet(creatorCharacterID);
    if (!creatorWallet || creatorWallet.balance < CORPORATION_FOUNDING_COST) {
      throwWrappedUserError(
        "NotEnoughMoney",
        buildNotEnoughMoneyUserErrorValues(
          CORPORATION_FOUNDING_COST,
          creatorWallet ? creatorWallet.balance : 0,
        ),
      );
    }
    const previousCorporationID = normalizePositiveInteger(
      (session && (session.corporationID || session.corpid)) ||
        (getCharacterRecord(creatorCharacterID) || {}).corporationID,
      null,
    );
    const previousCreatorMember = previousCorporationID
      ? buildCorporationMemberSnapshot(previousCorporationID, creatorCharacterID)
      : null;
    const previousCreatorCorporation = previousCorporationID
      ? buildCorporationSnapshot(previousCorporationID)
      : null;
    const corporationOptions = {
      name: normalizeText(args && args[0], ""),
      tickerName: normalizeText(args && args[1], ""),
      description: normalizeText(args && args[2], ""),
      url: normalizeText(args && args[3], ""),
      taxRate: Number(args && args[4]) || 0,
      shape1: args && args[5],
      shape2: args && args[6],
      shape3: args && args[7],
      color1: args && args[8],
      color2: args && args[9],
      color3: args && args[10],
      typeface: args && args[11],
      applicationsEnabled: args && args[12],
      friendlyFireEnabled: args && args[13],
      loyaltyPointTaxRate: Number(args && args[14]) || 0,
      stationID: session && (session.stationID || session.stationid),
      solarSystemID: session && (session.solarSystemID || session.solarsystemid2),
    };
    const prepared = prepareCorporationFounding({
      characterID: creatorCharacterID,
      corporationOptions,
      previousCorporationID,
      previousCreatorMember,
      previousCreatorCorporation,
    });
    if (!prepared || prepared.success !== true) {
      return null;
    }
    return settleCorporationFounding(creatorCharacterID).then((result) => {
      if (result && result.rejected) {
        if (result.errorMsg === "INSUFFICIENT_FUNDS") {
          throwWrappedUserError(
            "NotEnoughMoney",
            buildNotEnoughMoneyUserErrorValues(
              CORPORATION_FOUNDING_COST,
              getCharacterWallet(creatorCharacterID)?.balance || 0,
            ),
          );
        }
        throwWrappedUserError(mapCreateCorporationError(result.errorMsg));
      }
      if (!result || result.success !== true || !result.data?.corporationID) {
        log.warn(
          `[CorpRegistry] corporation founding settlement deferred char=${creatorCharacterID}: ` +
            `${result && result.errorMsg || "UNKNOWN"}`,
        );
        return null;
      }
      const corporationID = result.data.corporationID;
      if (previousCorporationID) {
        notifyCorporationMemberChanged(
          previousCorporationID,
          creatorCharacterID,
          previousCreatorMember,
          { refreshSession: false },
        );
        notifyCorporationChanged(previousCorporationID, previousCreatorCorporation);
      }
      notifyCorporationChanged(corporationID, null);
      notifyCorporationMemberChanged(
        corporationID,
        creatorCharacterID,
        null,
        {
          header: CREATE_MEMBER_CHANGE_HEADER,
          nextSnapshot: buildCreateCorporationMemberSnapshot(
            corporationID,
            creatorCharacterID,
          ),
          refreshSessionOptions: {
            deferCorpAccountKey: true,
            clearCorpAccountKey: true,
            suppressCorpAccountKeyWithCorpChange: true,
          },
        },
      );
      return buildCorporationKeyVal(corporationID);
    }).catch((error) => {
      if (error && error.name === "MachoWrappedException") {
        throw error;
      }
      log.warn(
        `[CorpRegistry] corporation founding settlement deferred char=${creatorCharacterID}: ` +
          `${error.message}`,
      );
      return null;
    });
  }

  Handle_GetAggressionSettings(args, session) {
    const corporationID = this.resolveBoundCorporationID(session);
    const corporationRecord = getCorporationRecord(corporationID) || {};
    return buildAggressionSettingsPayload(
      readAggressionSettings(corporationID, {
        isNpcCorporation: Boolean(corporationRecord.isNPC),
      }),
      {
        isNpcCorporation: Boolean(corporationRecord.isNPC),
      },
    );
  }

  Handle_RegisterNewAggressionSettings(args, session) {
    const corporationID = resolveCorporationID(session);
    if (!canAdministerCorporation(corporationID, session)) {
      throwCorporationAccessDenied();
    }
    const previousCorporation = buildCorporationSnapshot(corporationID);
    const corporationRecord = getCorporationRecord(corporationID) || {};
    const isNpcCorporation = Boolean(corporationRecord.isNPC);
    const desiredFriendlyFireLegal = normalizeBoolean(args && args[0], false);
    let updatedSettings = readAggressionSettings(corporationID, {
      isNpcCorporation,
    });
    updateCorporationRuntime(corporationID, (runtime) => {
      updatedSettings = scheduleAggressionSettingsChange(
        runtime && runtime.aggressionSettings,
        desiredFriendlyFireLegal,
        { isNpcCorporation },
      );
      runtime.aggressionSettings = updatedSettings;
      return runtime;
    });
    updateCorporationRecord(corporationID, {
      friendlyFire: resolveFriendlyFireLegalAtTime(updatedSettings, {
        isNpcCorporation,
      })
        ? 1
        : 0,
    });
    notifyCorporationChanged(corporationID, previousCorporation);
    const aggressionSettings = buildAggressionSettingsPayload(updatedSettings, {
      isNpcCorporation,
    });
    notifyCorporationAggressionSettingsChanged(corporationID, aggressionSettings);
    return aggressionSettings;
  }

  Handle_DoesMyCorpAcceptStructures(args, session) {
    const runtime = getCorporationRuntime(resolveCorporationID(session)) || {};
    return runtime.acceptStructures ? 1 : 0;
  }

  Handle_RegisterNewAcceptStructureSettings(args, session) {
    const corporationID = resolveCorporationID(session);
    if (!canAdministerCorporation(corporationID, session)) {
      throwCorporationAccessDenied();
    }
    const previousCorporation = buildCorporationSnapshot(corporationID);
    updateCorporationRuntime(corporationID, (runtime) => {
      runtime.acceptStructures = Boolean(args && args[0]);
      return runtime;
    });
    notifyCorporationChanged(corporationID, previousCorporation);
    return null;
  }

  Handle_DoesCorpRestrictCorpMails(args, session) {
    const runtime = getCorporationRuntime(resolveCorporationID(session)) || {};
    return runtime.restrictCorpMails ? 1 : 0;
  }

  Handle_RegisterNewCorpMailRestrictionSettings(args, session) {
    const corporationID = resolveCorporationID(session);
    if (!canAdministerCorporation(corporationID, session)) {
      throwCorporationAccessDenied();
    }
    const previousCorporation = buildCorporationSnapshot(corporationID);
    updateCorporationRuntime(corporationID, (runtime) => {
      runtime.restrictCorpMails = Boolean(args && args[0]);
      return runtime;
    });
    notifyCorporationChanged(corporationID, previousCorporation);
    return null;
  }

  Handle_GetStructureReinforceDefault(args, session) {
    const runtime = getCorporationRuntime(resolveCorporationID(session)) || {};
    // CCP client deployment and corp settings code both unpack this RPC as
    // `(reinforceWeekday, reinforceHour)`, even though the UI only uses the
    // hour picker for the current Upwell flow.
    return [
      NO_REINFORCEMENT_WEEKDAY,
      normalizeInteger(
        runtime.structureReinforceDefault,
        DEFAULT_STRUCTURE_REINFORCE_HOUR,
      ),
    ];
  }

  Handle_SetStructureReinforceDefault(args, session) {
    const corporationID = resolveCorporationID(session);
    if (!canAdministerCorporation(corporationID, session)) {
      throwCorporationAccessDenied();
    }
    const previousCorporation = buildCorporationSnapshot(corporationID);
    updateCorporationRuntime(corporationID, (runtime) => {
      runtime.structureReinforceDefault = normalizeInteger(args && args[0], 0);
      return runtime;
    });
    notifyCorporationChanged(corporationID, previousCorporation);
    return null;
  }

  Handle_CharGetAllyBaseCost(args, session) {
    return getCharacterAllyBaseCost(resolveCharacterID(session, args));
  }

  async Handle_DeclareWarAgainst(args, session) {
    return buildWarPayload(await declareWar(session, args && args[0], args && args[1]));
  }

  Handle_CanLeaveCurrentCorporation(args, session) {
    const corporationID = resolveCorporationID(session);
    const characterID = resolveCharacterID(session, []);
    const corporation = getCorporationRecord(corporationID);
    const member = getCorporationMember(corporationID, characterID);
    if (
      !corporation ||
      !member ||
      !hasPersistedCorporationMembership(corporationID, session)
    ) {
      return [0, "CrpAccessDenied", buildDict([])];
    }
    if (Number(corporation.ceoID) === Number(characterID) || member.isCEO) {
      return [0, "CrpCEOCanNotQuit", buildDict([])];
    }
    if (memberHasActiveRoles(member)) {
      return [0, "CrpCantQuitNotInStasis", buildActiveRoleErrorDetails(member)];
    }
    return [1, null, buildDict([])];
  }

  Handle_CanBeKickedOut(args, session) {
    const corporationID = resolveCorporationID(session);
    const characterID = normalizePositiveInteger(args && args[0], null);
    const corporation = getCorporationRecord(corporationID);
    const member = getCorporationMember(corporationID, characterID);
    if (!corporation || !member) {
      return 0;
    }
    if (Number(corporation.ceoID) === Number(characterID) || member.isCEO) {
      return 0;
    }
    return memberHasActiveRoles(member) || memberIsInRoleStasis(member) ? 0 : 1;
  }

  Handle_KickOutMember(args, session) {
    const corporationID = resolveCorporationID(session);
    const characterID = normalizePositiveInteger(args && args[0], null);
    const actingCharacterID = resolveCharacterID(session, []);
    const isSelf = Number(characterID) === Number(actingCharacterID);
    if (!hasPersistedCorporationMembership(corporationID, session)) {
      throwCorporationAccessDenied();
    }
    if (isSelf) {
      const [canLeave] = this.Handle_CanLeaveCurrentCorporation([], session);
      if (!canLeave) {
        return null;
      }
    } else if (!canAdministerCorporation(corporationID, session)) {
      throwCorporationAccessDenied();
    }
    if (!isSelf && !this.Handle_CanBeKickedOut([characterID], session)) {
      return null;
    }
    const result = moveCharacterToCorporation(
      characterID,
      corporationID,
      resolveFallbackCorporationID(characterID),
    );
    if (result && result.success) {
      // CorpKicked (92): tell the removed member they were kicked.
      notifyCorporationMemberKicked(corporationID, characterID);
    }
    // base_corporation.KickOut / corp_ui_home.ResignFromCorp use the session
    // change and notices; the internal affiliation result is not a wire value.
    return null;
  }

  Handle_KickOutMembers(args, session) {
    const corporationID = resolveCorporationID(session);
    if (!canAdministerCorporation(corporationID, session)) {
      throwCorporationAccessDenied();
    }
    const actingCharacterID = resolveCharacterID(session, []);
    const targetIDs = extractList(args && args[0])
      .map((characterID) => normalizePositiveInteger(characterID, null))
      .filter(Boolean);
    const kicked = [];
    const notKicked = [];
    for (const characterID of targetIDs) {
      if (
        Number(characterID) === Number(actingCharacterID) ||
        !this.Handle_CanBeKickedOut([characterID], session)
      ) {
        notKicked.push(Number(characterID));
        continue;
      }
      const result = moveCharacterToCorporation(
        characterID,
        corporationID,
        resolveFallbackCorporationID(characterID),
      );
      if (result.success) {
        kicked.push(Number(characterID));
        // CorpKicked (92): tell each removed member they were kicked.
        notifyCorporationMemberKicked(corporationID, characterID);
      } else {
        notKicked.push(Number(characterID));
      }
    }
    // The client reads results['kicked'] and results['notKicked'].
    return buildDict([
      ["kicked", buildList(kicked)],
      ["notKicked", buildList(notKicked)],
    ]);
  }

  Handle_GetMemberIDsWithMoreThanAvgShares(args, session) {
    const corporationID = resolveCorporationID(session);
    requireCorporationReadAccess(corporationID, session);
    const runtime = getCorporationRuntime(corporationID) || {};
    const members = listCorporationMembers(corporationID);
    if (!members.length) {
      return buildList([]);
    }
    const totalShares = Number(
      (runtime.shares && runtime.shares[String(corporationID)]) || 0,
    );
    const averageShares = totalShares / members.length;
    return buildList(
      members
        .filter(
          (member) =>
            Number((runtime.shares || {})[String(member.characterID)] || 0) >
            averageShares,
        )
        .map((member) => member.characterID),
    );
  }

  Handle_ResignFromCEO(args, session) {
    const corporationID = resolveCorporationID(session);
    const actingCharacterID = resolveCharacterID(session, []);
    const authority = getCorporationAdministrativeAuthority(
      corporationID,
      session,
    );
    if (!authority || !authority.isCEO) {
      throwCorporationAccessDenied();
    }
    const newCEOID = normalizePositiveInteger(args && args[0], null);
    if (newCEOID) {
      const newCeoCharacter = peekCharacterRecord(newCEOID);
      const newCeoMember = getCorporationMember(corporationID, newCEOID);
      if (
        !newCeoCharacter ||
        Boolean(newCeoCharacter.isDeleted) ||
        Boolean(newCeoCharacter.deletedAt) ||
        Number(newCeoCharacter.corporationID) !== Number(corporationID) ||
        !newCeoMember ||
        Boolean(newCeoMember.deleted) ||
        Number(newCeoMember.characterID) !== Number(newCEOID) ||
        Number(newCeoMember.corporationID) !== Number(corporationID)
      ) {
        throwCorporationAccessDenied();
      }
    }
    const members = listCorporationMembers(corporationID);
    if (newCEOID) {
      const previousCorporation = buildCorporationSnapshot(corporationID);
      const previousActingMember = buildCorporationMemberSnapshot(
        corporationID,
        actingCharacterID,
      );
      const previousNewCeoMember = buildCorporationMemberSnapshot(
        corporationID,
        newCEOID,
      );
      updateCorporationRecord(corporationID, {
        ceoID: newCEOID,
      });
      updateCorporationRuntime(corporationID, (runtime) => {
        if (runtime.members[String(actingCharacterID)]) {
          runtime.members[String(actingCharacterID)].isCEO = false;
          runtime.members[String(actingCharacterID)].roles = String(
            toRoleMaskBigInt(runtime.members[String(actingCharacterID)].roles, 0n) &
              ~CORP_ROLE_DIRECTOR,
          );
        }
        if (runtime.members[String(newCEOID)]) {
          runtime.members[String(newCEOID)].isCEO = true;
          runtime.members[String(newCEOID)].roles = String(
            toRoleMaskBigInt(runtime.members[String(newCEOID)].roles, 0n) |
              CORP_ROLE_DIRECTOR,
          );
        }
        return runtime;
      });
      syncMemberStateToCharacterRecord(corporationID, actingCharacterID);
      syncMemberStateToCharacterRecord(corporationID, newCEOID);
      notifyCorporationChanged(corporationID, previousCorporation);
      notifyCorporationMemberChanged(
        corporationID,
        actingCharacterID,
        previousActingMember,
      );
      notifyCorporationMemberChanged(
        corporationID,
        newCEOID,
        previousNewCeoMember,
      );
      // CorpNewCEOMsg (22): tell the membership the CEO changed; the resigning
      // CEO who initiated it is excluded.
      notifyCorporationNewCeo(corporationID, {
        excludeCharacterID: actingCharacterID,
      });
      return null;
    }

    if (
      members.length <= 1 &&
      members.some(
        (member) =>
          Number(member && member.characterID) === Number(actingCharacterID),
      )
    ) {
      // Register before preparation schedules durable work, so whichever
      // settlement path completes can defer only the final old-member notice.
      session._pendingCorporationLiquidationResponse = { corporationID };
      const liquidationResult = prepareCorporationForResigningCeo(
        corporationID,
        actingCharacterID,
      );
      if (!liquidationResult.success) {
        log.warn(
          `[CorpRegistry] ResignFromCEO liquidation failed for corp=${corporationID} char=${actingCharacterID}: ${liquidationResult.errorMsg || "UNKNOWN"}`,
        );
      }
      if (!liquidationResult.success) {
        return null;
      }
      return settleCorporationLiquidation(corporationID).then((result) => {
        if (!result || result.success !== true) {
          log.warn(
            `[CorpRegistry] ResignFromCEO liquidation settlement deferred ` +
              `for corp=${corporationID}: ${result && result.errorMsg || "UNKNOWN"}`,
          );
        }
        return null;
      }).catch((error) => {
        log.warn(
          `[CorpRegistry] ResignFromCEO liquidation settlement deferred ` +
            `for corp=${corporationID}: ${error.message}`,
        );
        return null;
      });
    }

    return buildList(
      members
        .map((member) => member.characterID)
        .filter((characterID) => Number(characterID) !== Number(actingCharacterID)),
    );
  }

  afterCallResponse(method, session) {
    if (method !== "ResignFromCEO" || !session) {
      return;
    }
    const pending = session._pendingCorporationLiquidationResponse;
    session._pendingCorporationLiquidationResponse = null;
    const removal = pending && pending.memberRemoval;
    if (!removal) {
      return;
    }
    // packetDispatcher sends None before calling this hook. TQ disband790/797
    // places the final old-membership removal after that acknowledgement.
    notifyCorporationMemberChanged(
      removal.corporationID,
      removal.characterID,
      removal.previousFromMember,
      {
        nextSnapshot: null,
        idTypes: ["clientID"],
        clientCharacterIDs: [removal.characterID],
        refreshSession: false,
      },
    );
  }

  afterCallFailure(method, session) {
    if (method === "ResignFromCEO" && session) {
      session._pendingCorporationLiquidationResponse = null;
    }
  }

  Handle_GetRecentKills(args, session) {
    const corporationID = resolveCorporationID(session);
    requireCorporationReadAccess(corporationID, session);
    const limit = args && args.length > 0 ? Number(args[0]) || 0 : 0;
    const rawStartKillID = args && args.length > 1 ? args[1] : null;
    const startKillID = rawStartKillID ? Number(rawStartKillID) || 0 : null;
    const rowset = buildKillmailRows(
      listKillmailsForCorporation(corporationID, "kills", {
        limit,
        startKillID,
      }),
    );
    return buildCachedResult(rowset, {
      serviceName: "corpRegistry",
      method: "GetRecentKills",
      args: [limit, rawStartKillID],
      versionCheck: "15 minutes",
      sessionInfo: "corpid",
      sessionInfoValue: corporationID,
    });
  }

  Handle_GetRecentLosses(args, session) {
    const corporationID = resolveCorporationID(session);
    requireCorporationReadAccess(corporationID, session);
    const limit = args && args.length > 0 ? Number(args[0]) || 0 : 0;
    const rawStartKillID = args && args.length > 1 ? args[1] : null;
    const startKillID = rawStartKillID ? Number(rawStartKillID) || 0 : null;
    const rowset = buildKillmailRows(
      listKillmailsForCorporation(corporationID, "losses", {
        limit,
        startKillID,
      }),
    );
    return buildCachedResult(rowset, {
      serviceName: "corpRegistry",
      method: "GetRecentLosses",
      args: [limit, rawStartKillID],
      versionCheck: "15 minutes",
      sessionInfo: "corpid",
      sessionInfoValue: corporationID,
    });
  }

  Handle_GetInfoWindowDataForChar(args, session) {
    const characterID = resolveCharacterID(session, args);
    const characterRecord = getCharacterRecord(characterID) || {};
    const corporationID = normalizePositiveInteger(characterRecord.corporationID, resolveCorporationID(session));
    const member = getCorporationMember(corporationID, characterID) || {};
    const runtime = getCorporationRuntime(corporationID) || {};
    const payload = [
      ["corpID", corporationID],
      ["allianceID", characterRecord.allianceID || null],
      ["factionID", characterRecord.factionID || null],
      ["title", member.title || ""],
    ];
    // Each of the sixteen titles the member holds (its titleMask's bit), by the title's name, and None for one it
    // does not: the client lists every one that is not None as the character's (characterInfoWindow 79 to 86), and
    // a caller that does not accept blanks words a held title with no name "Untitled N" (base_corporation 826 to 870).
    const titleMask = normalizeInteger(member.titleMask, 0);
    for (let index = 1; index <= 16; index += 1) {
      const titleID = 2 ** (index - 1);
      const titleRecord =
        runtime.titles && runtime.titles[String(titleID)]
          ? runtime.titles[String(titleID)]
          : null;
      payload.push([
        `title${index}`,
        (titleMask & titleID) !== 0 ? normalizeText(titleRecord && titleRecord.titleName, "") : null,
      ]);
    }
    return buildKeyVal(payload);
  }
}

module.exports = CorpRegistryRuntimeService;
