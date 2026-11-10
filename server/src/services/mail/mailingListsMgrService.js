"use strict";

const path = require("path");

const BaseService = require(path.join(__dirname, "../baseService"));
const {
  buildDict,
  buildKeyVal,
  buildList,
  extractDictEntries,
  extractList,
  normalizeNumber,
  normalizeText,
} = require(path.join(__dirname, "../_shared/serviceHelpers"));
const {
  clearMailingListEntityAccess,
  clearMailingListWelcomeMail,
  createMailingList,
  deleteMailingList,
  getJoinedMailingLists,
  getMailingListInfo,
  getMailingListMembers,
  getMailingListSettings,
  getMailingListWelcomeMail,
  joinMailingList,
  leaveMailingList,
  removeMailingListMembers,
  saveMailingListWelcomeMail,
  sendMailingListWelcomeMail,
  setMailingListDefaultAccess,
  setMailingListEntitiesAccess,
  setMailingListMembersClear,
  setMailingListMembersMuted,
  setMailingListMembersOperator,
} = require(path.join(__dirname, "./mailState"));
const { throwWrappedUserError } = require(path.join(
  __dirname,
  "../../common/machoErrors",
));

/**
 * A mailing list's call refused with the client's own dialog for it (the install's MailingList* dialogs, each by what
 * it says): a list not there, MailingListNoSuchList ("Can't find the specified mailing list."); a full one,
 * MailingListFull; a join not allowed, MailingListCantJoin; the owner leaving, MailingListCantRemoveOwner; a delete
 * by other than the owner, MailingListCantDeleteNotOwner; a kick by other than an operator or the owner,
 * MailingListNotOperator. `refusals` names the dialog for each of the call's reasons; any other is let be, as before.
 */
function refuseMailingListCall(result, refusals) {
  const dialog = result && result.success === false ? refusals[result.errorMsg] : undefined;
  if (dialog) {
    throwWrappedUserError(dialog);
  }
}

function resolveSessionCharacterID(session) {
  return Number(
    session &&
      (session.characterID || session.charID || session.charid || 0),
  ) || 0;
}

function normalizePositiveInteger(value, fallback = 0) {
  const numericValue = Math.trunc(normalizeNumber(value, fallback));
  return numericValue > 0 ? numericValue : fallback;
}

function buildMailingListInfoKeyVal(summary) {
  if (!summary || typeof summary !== "object") {
    return null;
  }
  return buildKeyVal([
    ["id", normalizePositiveInteger(summary.id, 0)],
    ["name", normalizeText(summary.name, "")],
    ["displayName", normalizeText(summary.displayName, "")],
    ["isMuted", Boolean(summary.isMuted)],
    ["isOperator", Boolean(summary.isOperator)],
    ["isOwner", Boolean(summary.isOwner)],
  ]);
}

function buildMailingListDict(records = {}) {
  return buildDict(
    Object.entries(records || {}).map(([listID, summary]) => [
      normalizePositiveInteger(listID, 0),
      buildMailingListInfoKeyVal(summary),
    ]),
  );
}

function buildMailingListSettingsKeyVal(settings) {
  if (!settings || typeof settings !== "object") {
    return null;
  }
  return buildKeyVal([
    ["defaultAccess", Math.trunc(normalizeNumber(settings.defaultAccess, 0))],
    [
      "defaultMemberAccess",
      Math.trunc(normalizeNumber(settings.defaultMemberAccess, 0)),
    ],
    ["cost", Math.max(0, Math.trunc(normalizeNumber(settings.cost, 0)))],
    [
      "access",
      buildDict(
        Object.entries(settings.access || {}).map(([entityID, accessLevel]) => [
          normalizePositiveInteger(entityID, 0),
          Math.trunc(normalizeNumber(accessLevel, 0)),
        ]),
      ),
    ],
  ]);
}

function buildWelcomeMailRows(rows = []) {
  return buildList(
    (Array.isArray(rows) ? rows : []).map((row) =>
      buildKeyVal([
        ["title", normalizeText(row && row.title, "")],
        ["body", normalizeText(row && row.body, "")],
      ]),
    ),
  );
}

function normalizeAccessByEntityID(value) {
  return Object.fromEntries(
    extractDictEntries(value).map(([entityID, accessLevel]) => [
      normalizePositiveInteger(entityID, 0),
      Math.trunc(normalizeNumber(accessLevel, 0)),
    ]),
  );
}

class MailingListsMgrService extends BaseService {
  constructor() {
    super("mailingListsMgr");
  }

  Handle_GetJoinedLists(args, session) {
    return buildMailingListDict(
      getJoinedMailingLists(resolveSessionCharacterID(session)),
    );
  }

  Handle_GetInfo(args, session) {
    return buildMailingListInfoKeyVal(
      getMailingListInfo(args && args[0], {
        characterID: resolveSessionCharacterID(session),
      }),
    );
  }

  Handle_Create(args, session) {
    const result = createMailingList(
      resolveSessionCharacterID(session),
      args && args[0],
      args && args[1],
      args && args[2],
      args && args[3],
    );
    // Create's return is used as a list ID by mailingListsSvc, even for None.
    // Refuse a taken name before the client adds it to its joined-list cache.
    refuseMailingListCall(result, {
      MAILING_LIST_EXISTS: "MailingListNameTaken",
    });
    return result.success ? result.listID : null;
  }

  Handle_Join(args, session) {
    const result = joinMailingList(
      resolveSessionCharacterID(session),
      args && args[0],
    );
    // The client takes the answer for the list (mailingListsSvc.JoinMailingList: myMailingLists[ret.id] = ret).
    refuseMailingListCall(result, {
      MAILING_LIST_NOT_FOUND: "MailingListNoSuchList",
      MAILING_LIST_FULL: "MailingListFull",
      MAILING_LIST_ACCESS_DENIED: "MailingListCantJoin",
    });
    return result.success ? buildMailingListInfoKeyVal(result.list) : null;
  }

  Handle_Leave(args, session) {
    refuseMailingListCall(leaveMailingList(resolveSessionCharacterID(session), args && args[0]), {
      MAILING_LIST_NOT_FOUND: "MailingListNoSuchList",
      OWNER_CANNOT_LEAVE: "MailingListCantRemoveOwner",
    });
    return null;
  }

  Handle_Delete(args, session) {
    refuseMailingListCall(deleteMailingList(resolveSessionCharacterID(session), args && args[0]), {
      MAILING_LIST_NOT_FOUND: "MailingListNoSuchList",
      MAILING_LIST_ACCESS_DENIED: "MailingListCantDeleteNotOwner",
    });
    return null;
  }

  Handle_KickMembers(args, session) {
    refuseMailingListCall(removeMailingListMembers(
      resolveSessionCharacterID(session),
      args && args[0],
      args && args[1],
    ), {
      MAILING_LIST_ACCESS_DENIED: "MailingListNotOperator",
    });
    return null;
  }

  Handle_GetMembers(args, session) {
    const members = getMailingListMembers(args && args[0], {
      characterID: resolveSessionCharacterID(session),
    });
    return buildDict(
      Object.entries(members).map(([memberID, accessLevel]) => [
        normalizePositiveInteger(memberID, 0),
        Math.trunc(normalizeNumber(accessLevel, 0)),
      ]),
    );
  }

  Handle_SetEntitiesAccess(args, session) {
    setMailingListEntitiesAccess(
      resolveSessionCharacterID(session),
      args && args[0],
      normalizeAccessByEntityID(args && args[1]),
    );
    return null;
  }

  Handle_ClearEntityAccess(args, session) {
    clearMailingListEntityAccess(
      resolveSessionCharacterID(session),
      args && args[0],
      args && args[1],
    );
    return null;
  }

  Handle_SetMembersMuted(args, session) {
    setMailingListMembersMuted(
      resolveSessionCharacterID(session),
      args && args[0],
      extractList(args && args[1]),
    );
    return null;
  }

  Handle_SetMembersOperator(args, session) {
    setMailingListMembersOperator(
      resolveSessionCharacterID(session),
      args && args[0],
      extractList(args && args[1]),
    );
    return null;
  }

  Handle_SetMembersClear(args, session) {
    setMailingListMembersClear(
      resolveSessionCharacterID(session),
      args && args[0],
      extractList(args && args[1]),
    );
    return null;
  }

  Handle_SetDefaultAccess(args, session) {
    setMailingListDefaultAccess(
      resolveSessionCharacterID(session),
      args && args[0],
      args && args[1],
      args && args[2],
      args && args[3],
    );
    return null;
  }

  Handle_GetSettings(args, session) {
    return buildMailingListSettingsKeyVal(
      getMailingListSettings(args && args[0], {
        characterID: resolveSessionCharacterID(session),
      }),
    );
  }

  Handle_GetWelcomeMail(args, session) {
    return buildWelcomeMailRows(
      getMailingListWelcomeMail(args && args[0], {
        characterID: resolveSessionCharacterID(session),
      }),
    );
  }

  Handle_SaveWelcomeMail(args, session) {
    saveMailingListWelcomeMail(
      resolveSessionCharacterID(session),
      args && args[0],
      args && args[1],
      args && args[2],
    );
    return null;
  }

  Handle_SendWelcomeMail(args, session) {
    const result = sendMailingListWelcomeMail(
      resolveSessionCharacterID(session),
      args && args[0],
      args && args[1],
      args && args[2],
    );
    return result.success ? result.messageID || null : null;
  }

  Handle_ClearWelcomeMail(args, session) {
    clearMailingListWelcomeMail(
      resolveSessionCharacterID(session),
      args && args[0],
    );
    return null;
  }
}

module.exports = MailingListsMgrService;
