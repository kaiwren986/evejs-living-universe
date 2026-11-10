"use strict";

const path = require("path");

const BaseService = require(path.join(__dirname, "../baseService"));
const log = require(path.join(__dirname, "../../utils/logger"));
const { declareWar } = require("./warDeclarationState");
const {
  resolveSessionCharacterID,
} = require(path.join(__dirname, "../_shared/sessionIdentity"));
const {
  throwWrappedUserError,
} = require(path.join(__dirname, "../../common/machoErrors"));
const {
  getCharacterRecord,
} = require(path.join(__dirname, "../character/characterState"));
const {
  buildBoundObjectResponse,
  buildDict,
  buildFiletimeLong,
  buildKeyVal,
  buildList,
  buildPackedRow,
  buildRow,
  buildRowset,
  currentFileTime,
  extractDictEntries,
  extractList,
  normalizeNumber,
  resolveBoundNodeId,
} = require(path.join(__dirname, "../_shared/serviceHelpers"));
const { strVal } = require(path.join(
  __dirname,
  "../../network/tcp/utils/marshal",
));
const {
  getAllianceCorporationIDs,
  getAllianceOwnerRecord,
  getAllianceRecord,
  getCharacterIDsInCorporation,
  getCorporationRecord,
  getOwnerLookupRecord,
} = require(path.join(__dirname, "./corporationState"));
const {
  CORP_ROLE_ACCOUNTANT,
  CORP_ROLE_DIRECTOR,
  CORP_ROLE_JUNIOR_ACCOUNTANT,
  ensureRuntimeInitialized,
  getAllianceRuntime,
  getCorporationWalletDivisionTakeRole,
  normalizeInteger,
  normalizePositiveInteger,
  normalizeText,
  updateAllianceRecord,
  updateAllianceRuntime,
} = require(path.join(__dirname, "./corporationRuntimeState"));
const { buildWarPayload } = require("./warPayloads");
const {
  processDueWarBills,
} = require(path.join(__dirname, "./warRuntimeState"));
const {
  getCorporationWalletBalance,
} = require(path.join(__dirname, "./corpWalletState"));
const {
  buildAllianceApplicationsIndexRowset,
  buildCorporationAllianceHistoryRowset,
  buildAllianceMembersRowset,
  buildAllianceMembersIndexRowset,
  getAllianceMembersOlderThan,
  getDaysInAlliance,
} = require(path.join(__dirname, "./allianceViewState"));
const {
  declareExecutorSupport,
} = require(path.join(__dirname, "./allianceGovernanceState"));
const {
  prepareAllianceDeparture,
  resumePendingSovCustody,
  settleAllianceDeparture,
} = require(path.join(__dirname, "./allianceDepartureState"));
const {
  BILL_TYPE_ALLIANCE_MAINTENANCE,
  getBillRecord,
  listBillsForCreditor,
  listUnpaidBillsForDebtor,
  payBillFromCorporation,
} = require(path.join(__dirname, "../account/billRuntimeState"));
const {
  processDueAllianceMaintenanceBills,
} = require(path.join(__dirname, "./allianceMaintenanceBilling"));
const {
  getWarPermitStatusForOwner,
} = require(path.join(__dirname, "./warPermitState"));
const {
  addLabelMask,
  allocateNextLabelID,
  removeLabelMask,
  toLabelKey,
  toMarshalMaskValue,
} = require(path.join(__dirname, "./contactLabelState"));
const {
  cancelAllianceCapitalTransition: cancelSovereigntyCapitalTransition,
  getAllianceCapitalInfo: getSovereigntyAllianceCapitalInfo,
  getAlliancePrimeInfo: getSovereigntyAlliancePrimeInfo,
  getAllianceSovereigntyRows,
  getSystemState: getSovereigntySystemState,
  setAllianceCapitalSystem: setSovereigntyAllianceCapitalSystem,
  setAlliancePrimeHour: setSovereigntyAlliancePrimeHour,
} = require(path.join(__dirname, "../sovereignty/sovState"));
const {
  buildAllianceCapitalInfoPayload,
  buildAlliancePrimeInfoPayload,
  buildAllianceSovereigntyRowsPayload,
} = require(path.join(__dirname, "../sovereignty/sovPayloads"));
const {
  buildAllianceApplicationSnapshot,
  buildAllianceMemberSnapshot,
  buildAllianceRelationshipSnapshot,
  notifyAllianceApplicationChanged,
  notifyAllianceChanged,
  notifyAllianceMemberChanged,
  notifyAllianceRelationshipChanged,
  notifyOrganizationContactsUpdated,
} = require(path.join(__dirname, "./corporationNotifications"));
const {
  getAllianceDirectorAuthority,
  getAllianceExecutorRoleAuthority,
  getAllianceMemberAuthority,
  getAllianceRoleAuthority,
  corporationAuthorityHasRole,
  sessionHasGmlRole,
} = require(path.join(__dirname, "./corporationAuthority"));
const {
  ALLIANCE_APPLICATION_STATE,
  acceptAllianceApplication,
  getAllianceApplication,
  rejectAllianceApplication,
} = require(path.join(__dirname, "./allianceApplicationState"));
const {
  checkAllianceApplicationEligibility,
} = require(path.join(__dirname, "./allianceApplicationEligibility"));

const ALLIANCE_ROW_HEADER = [
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
const OWNER_HEADER = [
  "ownerID",
  "ownerName",
  "typeID",
  "gender",
  "ownerNameID",
];
const BULLETIN_DBROW_COLUMNS = [
  ["bulletinID", 0x03],
  ["ownerID", 0x03],
  ["createDateTime", 0x40],
  ["editDateTime", 0x40],
  ["editCharacterID", 0x03],
  ["title", 0x82],
  ["body", 0x82],
  ["sortOrder", 0x03],
];
const CORP_ROLE_DIPLOMAT = 17179869184n;

function resolveAllianceIDFromArgs(args, session) {
  const firstArg = args && args.length > 0 ? args[0] : null;
  const firstList = extractList(firstArg);
  if (firstList.length > 0) {
    return normalizePositiveInteger(firstList[0], null);
  }
  const explicitAllianceID = normalizePositiveInteger(firstArg, null);
  if (explicitAllianceID) {
    return explicitAllianceID;
  }
  return normalizePositiveInteger(
    session && (session.allianceID || session.allianceid),
    null,
  );
}

function resolveAllianceIDFromSession(session) {
  return normalizePositiveInteger(
    session && (session.allianceID || session.allianceid),
    null,
  );
}

function throwAllianceAccessDenied() {
  throwWrappedUserError("CrpAccessDenied", {
    reason: [101, "UI/Corporations/AccessRestrictions/InsufficientRoles"],
  });
}

function requireAllianceDirector(session) {
  const authority = getAllianceDirectorAuthority(session);
  if (!authority) {
    throwAllianceAccessDenied();
  }
  return authority;
}

function requireAllianceMember(session) {
  const authority = getAllianceMemberAuthority(session);
  if (!authority) {
    throwAllianceAccessDenied();
  }
  return authority;
}

function requireAllianceRole(session, ...roleMasks) {
  const authority = roleMasks
    .map((roleMask) => getAllianceRoleAuthority(session, null, roleMask))
    .find(Boolean);
  if (!authority) {
    throwAllianceAccessDenied();
  }
  return authority;
}

function requireAllianceExecutorRole(session, ...roleMasks) {
  const authority = roleMasks
    .map((roleMask) =>
      getAllianceExecutorRoleAuthority(session, null, roleMask),
    )
    .find(Boolean);
  if (!authority) {
    throwAllianceAccessDenied();
  }
  return authority;
}

function requireAllianceExecutorDirector(session) {
  return requireAllianceExecutorRole(session, CORP_ROLE_DIRECTOR);
}

function throwAllianceApplicationEligibilityError(result) {
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
  throwAllianceAccessDenied();
}

function decideAllianceApplication(
  allianceID,
  corporationID,
  applicationText,
  state,
) {
  const application = getAllianceApplication(allianceID, corporationID);
  if (!application || application.state !== ALLIANCE_APPLICATION_STATE.NEW) {
    throwAllianceAccessDenied();
  }
  if (state === ALLIANCE_APPLICATION_STATE.ACCEPTED) {
    const eligibility = checkAllianceApplicationEligibility(
      corporationID,
      allianceID,
    );
    if (!eligibility || eligibility.success !== true) {
      throwAllianceApplicationEligibilityError(eligibility);
    }
  } else if (state !== ALLIANCE_APPLICATION_STATE.REJECTED) {
    throwAllianceAccessDenied();
  }

  const previousApplication = buildAllianceApplicationSnapshot(
    allianceID,
    corporationID,
  );
  const transition = state === ALLIANCE_APPLICATION_STATE.ACCEPTED
    ? acceptAllianceApplication({
        allianceID,
        corporationID,
        applicationText,
      })
    : rejectAllianceApplication({
        allianceID,
        corporationID,
        applicationText,
      });
  if (!transition || transition.success !== true) {
    throwAllianceAccessDenied();
  }
  notifyAllianceApplicationChanged(
    allianceID,
    corporationID,
    previousApplication,
  );
  return null;
}

function buildAllianceSummary(allianceRecord) {
  const resolvedAllianceRecord =
    allianceRecord && typeof allianceRecord === "object"
      ? allianceRecord
      : getAllianceRecord(normalizePositiveInteger(allianceRecord, null));
  if (!resolvedAllianceRecord) {
    return null;
  }
  const sovPrimeInfo = getSovereigntyAlliancePrimeInfo(resolvedAllianceRecord.allianceID);
  const sovCapitalInfo = getSovereigntyAllianceCapitalInfo(
    resolvedAllianceRecord.allianceID,
  );
  const executorCorporationID = normalizePositiveInteger(
    resolvedAllianceRecord.executorCorporationID,
    null,
  );
  const executorCorporation = executorCorporationID
    ? getCorporationRecord(executorCorporationID)
    : null;
  const hasExplicitAllowWar =
    Object.prototype.hasOwnProperty.call(resolvedAllianceRecord, "allowWar") &&
    resolvedAllianceRecord.allowWar !== undefined &&
    resolvedAllianceRecord.allowWar !== null;
  return {
    allianceID: resolvedAllianceRecord.allianceID,
    allianceName:
      resolvedAllianceRecord.allianceName ||
      `Alliance ${resolvedAllianceRecord.allianceID}`,
    shortName: resolvedAllianceRecord.shortName || "ALLY",
    executorCorpID: executorCorporationID,
    creatorCorpID: normalizePositiveInteger(
      resolvedAllianceRecord.creatorCorpID || resolvedAllianceRecord.executorCorporationID,
      null,
    ),
    creatorCharID: normalizePositiveInteger(
      resolvedAllianceRecord.creatorCharID || resolvedAllianceRecord.creatorID,
      null,
    ),
    warFactionID: normalizePositiveInteger(
      resolvedAllianceRecord.warFactionID,
      normalizePositiveInteger(executorCorporation && executorCorporation.factionID, null),
    ),
    description: resolvedAllianceRecord.description || "",
    url:
      typeof resolvedAllianceRecord.url === "string" &&
      resolvedAllianceRecord.url.trim() === ""
        ? null
        : resolvedAllianceRecord.url || null,
    startDate: buildFiletimeLong(resolvedAllianceRecord.createdAt || 0n),
    memberCount: getAllianceCorporationIDs(resolvedAllianceRecord.allianceID).reduce(
      (count, corporationID) => count + getCharacterIDsInCorporation(corporationID).length,
      0,
    ),
    dictatorial: resolvedAllianceRecord.dictatorial ? 1 : 0,
    allowWar: hasExplicitAllowWar
      ? resolvedAllianceRecord.allowWar
        ? 1
        : 0
      : getWarPermitStatusForOwner(resolvedAllianceRecord.allianceID),
    currentCapital: sovCapitalInfo.currentCapitalSystem || null,
    currentPrimeHour: sovPrimeInfo.currentPrimeHour || 0,
    newPrimeHour: sovPrimeInfo.newPrimeHour || 0,
    newPrimeHourValidAfter: buildFiletimeLong(sovPrimeInfo.newPrimeHourValidAfter || "0"),
    deleted: resolvedAllianceRecord.deleted ? 1 : 0,
  };
}

function buildAllianceRowPayload(allianceRecord) {
  const summary = buildAllianceSummary(allianceRecord);
  return buildRow(ALLIANCE_ROW_HEADER, [
    summary.allianceID,
    summary.allianceName,
    summary.shortName,
    summary.executorCorpID,
    summary.creatorCorpID,
    summary.creatorCharID,
    summary.warFactionID,
    summary.description,
    summary.url,
    summary.startDate,
    summary.memberCount,
    summary.dictatorial,
    summary.allowWar,
    summary.currentCapital,
    summary.currentPrimeHour,
    summary.newPrimeHour,
    summary.newPrimeHourValidAfter,
    summary.deleted,
  ]);
}

function buildAllianceKeyValPayload(allianceRecord) {
  const summary = buildAllianceSummary(allianceRecord);
  const sovCapitalInfo = getSovereigntyAllianceCapitalInfo(allianceRecord.allianceID);
  return buildKeyVal(
    ALLIANCE_ROW_HEADER.map((fieldName) => [fieldName, summary[fieldName]]).concat([
      ["__header__", ALLIANCE_ROW_HEADER],
      ["currentCapitalSystem", summary.currentCapital],
      [
        "newCapitalSystem",
        sovCapitalInfo.newCapitalSystem || null,
      ],
      [
        "newCapitalSystemValidAfter",
        buildFiletimeLong(sovCapitalInfo.newCapitalSystemValidAfter || "0"),
      ],
    ]),
  );
}

function buildBulletinRow(bulletin) {
  return buildPackedRow(BULLETIN_DBROW_COLUMNS, {
    bulletinID: Number(bulletin.bulletinID || 0),
    ownerID: Number(bulletin.ownerID || 0),
    createDateTime: bulletin.createDateTime || "0",
    editDateTime: bulletin.editDateTime || "0",
    editCharacterID: Number(bulletin.editCharacterID || 0),
    title: bulletin.title || "",
    body: bulletin.body || "",
    sortOrder: Number(bulletin.sortOrder || 0),
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
  return getAllianceOwnerRecord(ownerID) || getOwnerLookupRecord(ownerID);
}

function buildBillPayload(bill) {
  return buildKeyVal([
    ["billID", Number(bill && bill.billID ? bill.billID : 0)],
    ["billTypeID", Number(bill && bill.billTypeID ? bill.billTypeID : 0)],
    ["amount", Number(bill && bill.amount ? bill.amount : 0)],
    ["interest", Number(bill && bill.interest ? bill.interest : 0)],
    ["debtorID", Number(bill && bill.debtorID ? bill.debtorID : 0)],
    ["creditorID", Number(bill && bill.creditorID ? bill.creditorID : 0)],
    [
      "dueDateTime",
      buildFiletimeLong(bill && bill.dueDateTime ? bill.dueDateTime : "0"),
    ],
    ["paid", bill && bill.paid ? 1 : 0],
    [
      "paidDateTime",
      bill && bill.paidDateTime ? buildFiletimeLong(bill.paidDateTime) : null,
    ],
    ["paidByOwnerID", Number(bill && bill.paidByOwnerID ? bill.paidByOwnerID : 0)],
    [
      "externalID",
      bill && bill.externalID !== undefined && bill.externalID !== null
        ? Number(bill.externalID)
        : -1,
    ],
    [
      "externalID2",
      bill && bill.externalID2 !== undefined && bill.externalID2 !== null
        ? Number(bill.externalID2)
        : -1,
    ],
  ]);
}

function extractKwargValue(kwargs, key) {
  for (const [entryKey, entryValue] of extractDictEntries(kwargs)) {
    // `fromAccountKey` is outside the marshal string table, so it arrives as a raw
    // Buffer. Comparing it raw dropped the kwarg and the alliance wallet division
    // fell back to the default -- the same defect as the corporation wallet one.
    // See the note on accountService.extractKwarg.
    if (strVal(entryKey) === key) {
      return entryValue;
    }
  }
  return undefined;
}

class AllianceRegistryRuntimeService extends BaseService {
  constructor() {
    super("allianceRegistry");
  }

  Handle_IsAllianceLocal(args, session) {
    return getAllianceRecord(resolveAllianceIDFromArgs(args, session)) ? 1 : 0;
  }

  Handle_MachoResolveObject(args, session) {
    return getAllianceRecord(resolveAllianceIDFromArgs(args, session))
      ? resolveBoundNodeId()
      : null;
  }

  Handle_MachoBindObject(args, session, kwargs) {
    const allianceID = resolveAllianceIDFromArgs(args, session);
    return getAllianceRecord(allianceID)
      ? buildBoundObjectResponse(this, args, session, kwargs)
      : null;
  }

  Handle_GetAlliance(args, session) {
    const alliance = getAllianceRecord(resolveAllianceIDFromArgs(args, session));
    return alliance ? buildAllianceKeyValPayload(alliance) : null;
  }

  Handle_GetAlliancePublicInfo(args, session) {
    const alliance = getAllianceRecord(resolveAllianceIDFromArgs(args, session));
    return alliance ? buildAllianceKeyValPayload(alliance) : null;
  }

  Handle_GetRankedAlliances(args) {
    const maxLen = Math.max(0, normalizeNumber(args && args[0], 100));
    const runtimeTable = ensureRuntimeInitialized();
    const items = Object.keys(runtimeTable.alliances || {})
      .map((allianceID) => getAllianceRecord(allianceID))
      .filter((alliance) => alliance && !alliance.deleted)
      .slice(0, maxLen || undefined)
      .map((alliance) => buildAllianceRowPayload(alliance));
    return buildList(items);
  }

  Handle_GetAllianceMembers(args, session) {
    const allianceID = resolveAllianceIDFromArgs(args, session);
    return buildAllianceMembersRowset(allianceID);
  }

  Handle_GetMembers(args, session) {
    const authority = requireAllianceMember(session);
    return buildAllianceMembersIndexRowset(
      authority.allianceID,
      authority.corporationID,
    );
  }

  Handle_GetEmploymentRecord(args, session) {
    const corporationID = normalizePositiveInteger(args && args[0], null);
    if (getCorporationRecord(corporationID)) {
      return buildCorporationAllianceHistoryRowset(corporationID);
    }

    const alliance = getAllianceRecord(resolveAllianceIDFromArgs(args, session));
    return buildRowset(
      ["allianceID", "startDate", "deleted"],
      alliance
        ? [buildList([
            alliance.allianceID,
            buildFiletimeLong(alliance.createdAt),
            alliance.deleted ? 1 : 0,
          ])]
        : [],
      "eve.common.script.sys.rowset.Rowset",
    );
  }

  Handle_UpdateAlliance(args, session) {
    const authority = requireAllianceExecutorDirector(session);
    const allianceID = authority.allianceID;
    const description = normalizeText(args && args[0], "");
    const url = normalizeText(args && args[1], "");
    if (description.length > 5000 || url.length > 2048) {
      throwAllianceAccessDenied();
    }
    const previousAlliance = buildAllianceSummary(allianceID);
    updateAllianceRecord(allianceID, {
      description,
      url,
    });
    notifyAllianceChanged(allianceID, previousAlliance);
    return null;
  }

  Handle_GetApplications(args, session) {
    const authority = requireAllianceExecutorDirector(session);
    return buildAllianceApplicationsIndexRowset(authority.allianceID);
  }

  Handle_UpdateApplication(args, session) {
    const authority = requireAllianceExecutorDirector(session);
    const allianceID = authority.allianceID;
    const corporationID = normalizePositiveInteger(args && args[0], null);
    const applicationText = normalizeText(args && args[1], "");
    const state = normalizeInteger(args && args[2], 0);
    return decideAllianceApplication(
      allianceID,
      corporationID,
      applicationText,
      state,
    );
  }

  Handle_GMForceAcceptApplication(args, session) {
    if (!sessionHasGmlRole(session)) {
      throwAllianceAccessDenied();
    }
    const allianceID = resolveAllianceIDFromSession(session);
    const corporationID = normalizePositiveInteger(args && args[0], null);
    const application = getAllianceApplication(allianceID, corporationID);
    return decideAllianceApplication(
      allianceID,
      corporationID,
      application && application.applicationText || "",
      ALLIANCE_APPLICATION_STATE.ACCEPTED,
    );
  }

  Handle_DeclareExecutorSupport(args, session) {
    const authority = requireAllianceDirector(session);
    const allianceID = authority.allianceID;
    const chosenExecutorCorporationID = normalizePositiveInteger(args && args[0], null);
    const supporterCorporationID = authority.corporationID;
    const alliance = getAllianceRecord(allianceID);
    if (
      !chosenExecutorCorporationID ||
      !getAllianceCorporationIDs(allianceID).includes(chosenExecutorCorporationID) ||
      (alliance &&
        alliance.dictatorial &&
        Number(chosenExecutorCorporationID) !==
          Number(alliance.executorCorporationID))
    ) {
      throwAllianceAccessDenied();
    }
    const previousMember = buildAllianceMemberSnapshot(
      allianceID,
      supporterCorporationID,
    );
    const previousAlliance = buildAllianceSummary(allianceID);
    const supportResult = declareExecutorSupport(
      allianceID,
      supporterCorporationID,
      chosenExecutorCorporationID,
    );
    if (!supportResult || supportResult.success !== true) {
      throwAllianceAccessDenied();
    }
    notifyAllianceMemberChanged(allianceID, supporterCorporationID, previousMember);
    notifyAllianceChanged(allianceID, previousAlliance);
    const custodyResult = resumePendingSovCustody(allianceID);
    if (custodyResult && custodyResult.success !== true) {
      log.warn(
        `[AllianceRegistry] pending sovereignty custody repair failed ` +
        `alliance=${allianceID}: ${custodyResult.errorMsg || "unknown"}`,
      );
    }
    return null;
  }

  async Handle_DeleteMember(args, session) {
    const authority = requireAllianceDirector(session);
    const allianceID = authority.allianceID;
    const corporationID = normalizePositiveInteger(args && args[0], null);
    if (!getAllianceCorporationIDs(allianceID).includes(corporationID)) {
      throwAllianceAccessDenied();
    }
    if (Number(corporationID) !== Number(authority.corporationID)) {
      if (!getAllianceExecutorRoleAuthority(
        session,
        allianceID,
        CORP_ROLE_DIRECTOR,
      )) {
        throwAllianceAccessDenied();
      }
    }
    const prepareResult = prepareAllianceDeparture({
      allianceID,
      corporationID,
      actorCharacterID: resolveSessionCharacterID(session),
      actorCorporationID: authority.corporationID,
      mode: Number(corporationID) === Number(authority.corporationID)
        ? "self-leave"
        : "executor-kick",
    });
    if (!prepareResult || prepareResult.success !== true) {
      throwAllianceAccessDenied();
    }
    const settlementResult = await settleAllianceDeparture(
      prepareResult.data.operationID,
    );
    if (!settlementResult || settlementResult.success !== true) {
      log.warn(
        `[AllianceRegistry] departure settlement failed alliance=${allianceID} ` +
        `corporation=${corporationID}: ` +
        `${settlementResult && settlementResult.errorMsg || "unknown"}`,
      );
      throwAllianceAccessDenied();
    }
    return null;
  }

  Handle_GetAllianceContacts(args, session) {
    const authority = requireAllianceMember(session);
    const runtime = getAllianceRuntime(authority.allianceID) || {};
    return buildDict(
      Object.entries(runtime.contacts || {}).map(([contactID, contact]) => [
        Number(contactID),
        buildKeyVal([
          ["contactID", Number(contactID)],
          ["relationshipID", Number(contact.relationshipID || 0)],
          ["labelMask", toMarshalMaskValue(contact.labelMask)],
        ]),
      ]),
    );
  }

  Handle_GetContactList(args, session) {
    return this.Handle_GetAllianceContacts(args, session);
  }

  Handle_AddAllianceContact(args, session) {
    const authority = requireAllianceExecutorRole(
      session,
      CORP_ROLE_DIRECTOR,
      CORP_ROLE_DIPLOMAT,
    );
    const allianceID = authority.allianceID;
    const contactID = normalizePositiveInteger(args && args[0], null);
    // CorpAllianceContactManagementWnd.Confirm sends tenths, not integers.
    const relationshipID = normalizeNumber(args && args[1], 0);
    updateAllianceRuntime(allianceID, (runtime) => {
      const previous = runtime.contacts[String(contactID)];
      runtime.contacts[String(contactID)] = {
        relationshipID,
        // addressbookService.AddToAddressBook retains labels when editing.
        labelMask: previous?.labelMask ?? 0,
      };
      return runtime;
    });
    notifyOrganizationContactsUpdated(allianceID, [[contactID, relationshipID, null]]);
    return null;
  }

  Handle_EditAllianceContact(args, session) {
    return this.Handle_AddAllianceContact(args, session);
  }

  Handle_RemoveAllianceContacts(args, session) {
    const authority = requireAllianceExecutorRole(
      session,
      CORP_ROLE_DIRECTOR,
      CORP_ROLE_DIPLOMAT,
    );
    const allianceID = authority.allianceID;
    const contactIDs = extractList(args && args[0]);
    updateAllianceRuntime(allianceID, (runtime) => {
      for (const contactID of contactIDs) {
        delete runtime.contacts[String(contactID)];
      }
      return runtime;
    });
    notifyOrganizationContactsUpdated(
      allianceID,
      contactIDs.map((contactID) => [Number(contactID), null, null]),
    );
    return null;
  }

  Handle_EditContactsRelationshipID(args, session) {
    const authority = requireAllianceExecutorRole(
      session,
      CORP_ROLE_DIRECTOR,
      CORP_ROLE_DIPLOMAT,
    );
    const allianceID = authority.allianceID;
    const contactIDs = extractList(args && args[0]);
    const relationshipID = normalizeNumber(args && args[1], 0);
    updateAllianceRuntime(allianceID, (runtime) => {
      for (const contactID of contactIDs) {
        runtime.contacts[String(contactID)] = {
          ...(runtime.contacts[String(contactID)] || {}),
          relationshipID,
        };
      }
      return runtime;
    });
    notifyOrganizationContactsUpdated(
      allianceID,
      contactIDs.map((contactID) => [Number(contactID), relationshipID, null]),
    );
    return null;
  }

  Handle_GetLabels(args, session) {
    const authority = requireAllianceMember(session);
    const runtime = getAllianceRuntime(authority.allianceID) || {};
    return buildDict(
      Object.entries(runtime.labels || {}).map(([labelID, label]) => [
        toMarshalMaskValue(labelID),
        buildKeyVal([
          ["labelID", toMarshalMaskValue(labelID)],
          ["name", label.name || ""],
          ["color", label.color === null ? null : Number(label.color || 0)],
        ]),
      ]),
    );
  }

  Handle_CreateLabel(args, session) {
    const authority = requireAllianceExecutorRole(
      session,
      CORP_ROLE_DIRECTOR,
      CORP_ROLE_DIPLOMAT,
    );
    const allianceID = authority.allianceID;
    const name = normalizeText(args && args[0], "");
    // CreateContactLabel keeps None as no color; explicit 0 is the white swatch.
    const color = args && args[1] != null ? normalizeInteger(args[1], 0) : null;
    let labelID = null;
    updateAllianceRuntime(allianceID, (runtime, allianceRecord, table) => {
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
    const authority = requireAllianceExecutorRole(
      session,
      CORP_ROLE_DIRECTOR,
      CORP_ROLE_DIPLOMAT,
    );
    const allianceID = authority.allianceID;
    const labelKey = toLabelKey(args && args[0], null);
    updateAllianceRuntime(allianceID, (runtime) => {
      delete runtime.labels[String(labelKey)];
      for (const contact of Object.values(runtime.contacts || {})) {
        contact.labelMask = removeLabelMask(contact.labelMask, labelKey);
      }
      return runtime;
    });
    return null;
  }

  Handle_EditLabel(args, session) {
    const authority = requireAllianceExecutorRole(
      session,
      CORP_ROLE_DIRECTOR,
      CORP_ROLE_DIPLOMAT,
    );
    const allianceID = authority.allianceID;
    const labelKey = toLabelKey(args && args[0], null);
    // addressbookService.EditContactLabel 1001-1010: None keeps that field.
    const name = args && args[1] != null ? normalizeText(args[1], "") : undefined;
    const color = args && args[2] != null ? normalizeInteger(args[2], 0) : undefined;
    updateAllianceRuntime(allianceID, (runtime) => {
      const label = runtime.labels[String(labelKey)] || { name: "", color: 0 };
      if (name !== undefined) label.name = name;
      if (color !== undefined) label.color = color;
      runtime.labels[String(labelKey)] = label;
      return runtime;
    });
    return null;
  }

  Handle_AssignLabels(args, session) {
    const authority = requireAllianceExecutorRole(
      session,
      CORP_ROLE_DIRECTOR,
      CORP_ROLE_DIPLOMAT,
    );
    const allianceID = authority.allianceID;
    const contactIDs = extractList(args && args[0]);
    const labelMask = toLabelKey(args && args[1], "0");
    updateAllianceRuntime(allianceID, (runtime) => {
      for (const contactID of contactIDs) {
        // AssignLabelFromWnd 1094-1117 opens Add separately for a missing
        // contact; canceling it must leave that owner outside the address book.
        const contact = runtime.contacts[String(contactID)];
        if (contact) contact.labelMask = addLabelMask(contact.labelMask, labelMask);
      }
      return runtime;
    });
    // OnOrganizationContactsUpdated 157-191 consumes a mask-only tuple.
    const contacts = getAllianceRuntime(allianceID)?.contacts || {};
    notifyOrganizationContactsUpdated(allianceID, contactIDs.filter(id => contacts[String(id)]).map(id => [
      Number(id), null, toMarshalMaskValue(contacts[String(id)].labelMask),
    ]));
    return null;
  }

  Handle_RemoveLabels(args, session) {
    const authority = requireAllianceExecutorRole(
      session,
      CORP_ROLE_DIRECTOR,
      CORP_ROLE_DIPLOMAT,
    );
    const allianceID = authority.allianceID;
    const contactIDs = extractList(args && args[0]);
    const labelMask = toLabelKey(args && args[1], "0");
    updateAllianceRuntime(allianceID, (runtime) => {
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
    const contacts = getAllianceRuntime(allianceID)?.contacts || {};
    notifyOrganizationContactsUpdated(allianceID, contactIDs.filter(id => contacts[String(id)]).map(id => [
      Number(id), null, toMarshalMaskValue(contacts[String(id)].labelMask),
    ]));
    return null;
  }

  Handle_GetBulletins(args, session) {
    const authority = requireAllianceMember(session);
    const runtime = getAllianceRuntime(authority.allianceID) || {};
    return buildList(
      (runtime.bulletins || [])
        .slice()
        .sort((left, right) => Number(left.sortOrder || 0) - Number(right.sortOrder || 0))
        .map((bulletin) => buildBulletinRow(bulletin)),
    );
  }

  Handle_GetBulletinEntries(args, session) {
    return this.Handle_GetBulletins(args, session);
  }

  Handle_GetBulletin(args, session) {
    const allianceID = requireAllianceMember(session).allianceID;
    const bulletinID = normalizePositiveInteger(args && args[0], null);
    const runtime = getAllianceRuntime(allianceID) || {};
    const bulletin = (runtime.bulletins || []).find(
      (entry) => Number(entry.bulletinID) === Number(bulletinID),
    );
    if (!bulletin) {
      return null;
    }
    return buildBulletinRow(bulletin);
  }

  Handle_AddBulletin(args, session) {
    const allianceID = requireAllianceDirector(session).allianceID;
    const title = normalizeText(args && args[0], "");
    const body = normalizeText(args && args[1], "");
    let bulletinID = normalizePositiveInteger(args && args[2], null);
    updateAllianceRuntime(allianceID, (runtime, allianceRecord, table) => {
      if (!bulletinID) {
        bulletinID = table._meta.nextBulletinID++;
      }
      const index = (runtime.bulletins || []).findIndex(
        (entry) => Number(entry.bulletinID) === Number(bulletinID),
      );
      const record = {
        bulletinID,
        ownerID: allianceID,
        createDateTime:
          index >= 0 ? runtime.bulletins[index].createDateTime : String(currentFileTime()),
        editDateTime: args && args[3] ? String(args[3]) : String(currentFileTime()),
        editCharacterID: session && (session.characterID || session.charid),
        title,
        body,
        sortOrder: index >= 0 ? runtime.bulletins[index].sortOrder || 0 : runtime.bulletins.length,
      };
      if (index >= 0) {
        runtime.bulletins[index] = record;
      } else {
        runtime.bulletins.push(record);
      }
      return runtime;
    });
    return bulletinID;
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
    const allianceID = requireAllianceDirector(session).allianceID;
    const bulletinID = normalizePositiveInteger(args && args[0], null);
    updateAllianceRuntime(allianceID, (runtime) => {
      runtime.bulletins = (runtime.bulletins || []).filter(
        (bulletin) => Number(bulletin.bulletinID) !== Number(bulletinID),
      );
      return runtime;
    });
    return null;
  }

  Handle_UpdateBulletinOrder(args, session) {
    const allianceID = requireAllianceDirector(session).allianceID;
    const newOrder = extractList(args && args[0]);
    updateAllianceRuntime(allianceID, (runtime) => {
      const orderMap = new Map(newOrder.map((bulletinID, index) => [Number(bulletinID), index]));
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

  Handle_GetRelationships(args, session) {
    const authority = requireAllianceMember(session);
    const runtime = getAllianceRuntime(authority.allianceID) || {};
    return buildDict(
      Object.entries(runtime.relationships || {}).map(([ownerID, relationship]) => [
        Number(ownerID),
        relationship,
      ]),
    );
  }

  Handle_SetRelationship(args, session) {
    const allianceID = requireAllianceExecutorDirector(session).allianceID;
    const relationship = normalizeInteger(args && args[0], 0);
    const toID = normalizePositiveInteger(args && args[1], null);
    const previousRelationship = buildAllianceRelationshipSnapshot(allianceID, toID);
    updateAllianceRuntime(allianceID, (runtime) => {
      runtime.relationships[String(toID)] = relationship;
      return runtime;
    });
    notifyAllianceRelationshipChanged(allianceID, toID, previousRelationship);
    return null;
  }

  Handle_DeleteRelationship(args, session) {
    const allianceID = requireAllianceExecutorDirector(session).allianceID;
    const toID = normalizePositiveInteger(args && args[0], null);
    const previousRelationship = buildAllianceRelationshipSnapshot(allianceID, toID);
    updateAllianceRuntime(allianceID, (runtime) => {
      delete runtime.relationships[String(toID)];
      return runtime;
    });
    notifyAllianceRelationshipChanged(allianceID, toID, previousRelationship);
    return null;
  }

  Handle_GetPrimeTimeInfo(args, session) {
    const authority = requireAllianceMember(session);
    return buildAlliancePrimeInfoPayload(
      getSovereigntyAlliancePrimeInfo(authority.allianceID),
    );
  }

  Handle_SetPrimeHour(args, session) {
    const allianceID = requireAllianceExecutorDirector(session).allianceID;
    const hour = normalizeInteger(args && args[0], -1);
    if (hour < 0 || hour > 23) {
      throwAllianceAccessDenied();
    }
    const previousAlliance = buildAllianceSummary(allianceID);
    setSovereigntyAlliancePrimeHour(allianceID, hour);
    notifyAllianceChanged(allianceID, previousAlliance);
    return null;
  }

  Handle_GetCapitalSystemInfo(args, session) {
    const authority = requireAllianceMember(session);
    return buildAllianceCapitalInfoPayload(
      getSovereigntyAllianceCapitalInfo(authority.allianceID),
    );
  }

  Handle_GetAllianceSovereigntyStructuresInfo(args, session) {
    const authority = requireAllianceMember(session);
    return buildAllianceSovereigntyRowsPayload(
      getAllianceSovereigntyRows(authority.allianceID),
    );
  }

  Handle_SetCapitalSystem(args, session) {
    const allianceID = requireAllianceExecutorDirector(session).allianceID;
    const solarSystemID = normalizePositiveInteger(args && args[0], null);
    const system = getSovereigntySystemState(solarSystemID);
    if (
      !system ||
      Number(system.allianceID) !== Number(allianceID) ||
      !normalizePositiveInteger(system.infrastructureHubID, null)
    ) {
      throwAllianceAccessDenied();
    }
    const previousAlliance = buildAllianceSummary(allianceID);
    setSovereigntyAllianceCapitalSystem(allianceID, solarSystemID);
    notifyAllianceChanged(allianceID, previousAlliance);
    return null;
  }

  Handle_CancelCapitalSystemTransition(args, session) {
    const allianceID = requireAllianceExecutorDirector(session).allianceID;
    const previousAlliance = buildAllianceSummary(allianceID);
    cancelSovereigntyCapitalTransition(allianceID);
    notifyAllianceChanged(allianceID, previousAlliance);
    return null;
  }

  Handle_GetBills(args, session) {
    const authority = requireAllianceRole(
      session,
      CORP_ROLE_ACCOUNTANT,
      CORP_ROLE_JUNIOR_ACCOUNTANT,
    );
    return buildList(
      listUnpaidBillsForDebtor(authority.allianceID).map((bill) =>
        buildBillPayload(bill),
      ),
    );
  }

  Handle_GetBillsReceivable(args, session) {
    const authority = requireAllianceRole(
      session,
      CORP_ROLE_ACCOUNTANT,
      CORP_ROLE_JUNIOR_ACCOUNTANT,
    );
    return buildList(
      listBillsForCreditor(authority.allianceID).map((bill) =>
        buildBillPayload(bill),
      ),
    );
  }

  Handle_GetBillBalance(args, session) {
    const authority = requireAllianceRole(
      session,
      CORP_ROLE_ACCOUNTANT,
      CORP_ROLE_JUNIOR_ACCOUNTANT,
    );
    const accountKey = normalizePositiveInteger(
      session && (session.corpAccountKey || session.corpaccountkey),
      1000,
    );
    return getCorporationWalletBalance(authority.corporationID, accountKey);
  }

  async Handle_PayBill(args, session, kwargs) {
    const authority = requireAllianceExecutorRole(
      session,
      CORP_ROLE_ACCOUNTANT,
    );
    const billID = normalizePositiveInteger(args && args[0], null);
    const accountKey = normalizePositiveInteger(
      extractKwargValue(kwargs, "fromAccountKey") ??
        (args && args[1]) ??
        1000,
      1000,
    );
    const billBeforePayment = getBillRecord(billID);
    const takeRole = getCorporationWalletDivisionTakeRole(accountKey);
    if (
      !billBeforePayment ||
      Number(billBeforePayment.debtorID) !== Number(authority.allianceID) ||
      !takeRole ||
      !corporationAuthorityHasRole(authority, takeRole)
    ) {
      throwAllianceAccessDenied();
    }
    const payment = await payBillFromCorporation(
      billID,
      authority.corporationID,
      accountKey,
    );
    if (!payment || payment.success !== true) {
      if (payment && payment.errorMsg === "INSUFFICIENT_FUNDS") {
        throwWrappedUserError("NotEnoughMoney", {});
      }
      throwAllianceAccessDenied();
    }
    await processDueWarBills({ billID, session });
    const bill = getBillRecord(billID);
    if (
      bill &&
      Number(bill.billTypeID) === BILL_TYPE_ALLIANCE_MAINTENANCE
    ) {
      await processDueAllianceMaintenanceBills({ billID, session });
    }
    return null;
  }

  async Handle_DeclareWarAgainst(args, session) {
    return buildWarPayload(await declareWar(session, args && args[0], args && args[1], { allianceOnly: true }));
  }

  Handle_GetDaysInAlliance(args, session) {
    const allianceID = resolveAllianceIDFromArgs(args, session);
    const corporationID = normalizePositiveInteger(args && args[1], null);
    return getDaysInAlliance(allianceID, corporationID);
  }

  Handle_GetAllianceMembersOlderThan(args, session) {
    const allianceID = resolveAllianceIDFromArgs(args, session);
    const minimumDays = normalizeInteger(args && args[1], 0);
    return buildList(getAllianceMembersOlderThan(allianceID, minimumDays));
  }

  Handle_GetEveOwners(args) {
    const ownerIDs = extractList(args && args[0])
      .map((ownerID) => getOwnerRecord(ownerID))
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
    return buildList(ownerIDs);
  }
}

module.exports = AllianceRegistryRuntimeService;
