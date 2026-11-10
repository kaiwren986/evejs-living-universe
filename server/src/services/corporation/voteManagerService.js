"use strict";

const path = require("path");
const { getPersistedCorporationAuthority } = require("./corporationAuthority");
const { getCharacterRecord } = require("../character/characterState");
const { findItemById } = require("../inventory/itemStore");
const { getCorporationOfficeByInventoryID } = require("./corporationRuntimeState");
const { throwWrappedUserError } = require("../../common/machoErrors");

const BaseService = require(path.join(__dirname, "../baseService"));
const {
  buildDbRowset,
  buildDict,
  buildFiletimeLong,
  buildKeyVal,
  buildList,
  unwrapMarshalValue,
} = require(path.join(__dirname, "../_shared/serviceHelpers"));
const {
  VOTECASE_STATUS_ALL,
  VOTECASE_STATUS_CLOSED,
  VOTECASE_STATUS_OPEN,
  activateSanctionedAction,
  canRunForCEO,
  canViewVotes,
  canVote,
  castVote,
  createVoteCase,
  getVoteCase,
  getVoteCaseStatus,
  listSanctionedActions,
  listVoteCaseOptions,
  listVoteCasesByCorporation,
  listVotesByVoteCase,
  voteCEO,
  voteWar,
  voteShares,
  voteGeneral,
  voteKickMember,
  voteItemLockdown,
  voteItemUnlock,
} = require(path.join(__dirname, "./voteRuntimeState"));
const {
  notifySanctionedActionChanged,
  notifyVoteCaseChanged,
  notifyVoteCast,
} = require(path.join(__dirname, "./corporationNotifications"));

const FILETIME_EPOCH_OFFSET = 116444736000000000n;
const FILETIME_TICKS_PER_MS = 10000n;
// setTimeout's largest delay. Longer waits re-arm when they fire.
const MAX_TIMER_DELAY_MS = 2_147_000_000;
const voteCloseTimers = new Map();

function fileTimeToUnixMs(fileTime) {
  try {
    return Number((BigInt(String(fileTime || "0")) - FILETIME_EPOCH_OFFSET) / FILETIME_TICKS_PER_MS);
  } catch (_error) {
    return 0;
  }
}

// A vote case closes when its end date passes; nothing writes at that moment,
// so tell online members then. Their cached case list is bucketed by status
// and the closed case's sanctioned action becomes available. Timers are armed
// when a case is created and whenever a corporation's case list is read, which
// covers cases left open across a restart for every client that has the list.
function armVoteCaseCloseTimer(voteCase) {
  const corporationID = Number(voteCase && voteCase.corporationID) || 0;
  const voteCaseID = Number(voteCase && voteCase.voteCaseID) || 0;
  if (!corporationID || !voteCaseID || getVoteCaseStatus(voteCase) !== VOTECASE_STATUS_OPEN) {
    return false;
  }
  const key = `${corporationID}:${voteCaseID}`;
  if (voteCloseTimers.has(key)) {
    return false;
  }
  const delayMs = Math.max(0, fileTimeToUnixMs(voteCase.endDateTime) - Date.now());
  const timer = setTimeout(() => {
    voteCloseTimers.delete(key);
    const current = getVoteCase(corporationID, voteCaseID);
    if (!current) {
      return;
    }
    if (getVoteCaseStatus(current) === VOTECASE_STATUS_OPEN) {
      armVoteCaseCloseTimer(current);
      return;
    }
    notifyVoteCaseChanged(corporationID, voteCaseID);
    notifySanctionedActionChanged(corporationID, voteCaseID);
  }, Math.min(delayMs + 1000, MAX_TIMER_DELAY_MS));
  if (timer && typeof timer.unref === "function") {
    timer.unref();
  }
  voteCloseTimers.set(key, timer);
  return true;
}

function clearVoteCaseCloseTimersForTests() {
  for (const timer of voteCloseTimers.values()) {
    clearTimeout(timer);
  }
  voteCloseTimers.clear();
}

const VOTE_CASE_HEADER = [
  "voteCaseID",
  "voteCaseText",
  "description",
  "corporationID",
  "createdByCharacterID",
  "voteType",
  "startDateTime",
  "endDateTime",
  "processed",
];
const VOTE_CASE_DBROW_COLUMNS = [
  ["voteCaseID", 0x03],
  ["voteCaseText", 0x82],
  ["description", 0x82],
  ["corporationID", 0x03],
  ["createdByCharacterID", 0x03],
  ["voteType", 0x11],
  ["startDateTime", 0x40],
  ["endDateTime", 0x40],
  ["processed", 0x0b],
];
const MAX_CLOSED_VOTES_FETCHED = 20;
const VOTE_OPTION_HEADER = [
  "optionID",
  "optionText",
  "parameter",
  "parameter1",
  "parameter2",
  "votesFor",
];
const VOTE_HEADER = ["voteCaseID", "characterID", "optionID", "castDateTime", "voteWeight"];

function resolveCorporationID(args, session) {
  return (
    (args && args.length > 0 && Number(args[0])) ||
    (session && (session.corporationID || session.corpid)) ||
    0
  );
}

function requireVoteReadAuthority(corporationID, session) {
  if (!canViewVotes(corporationID, session)) throwWrappedUserError("CrpAccessDenied");
}

function buildVoteCaseRowset(voteCases = []) {
  return buildDbRowset(
    VOTE_CASE_DBROW_COLUMNS,
    voteCases.map((voteCase) =>
      [
        Number(voteCase.voteCaseID || 0),
        voteCase.voteCaseText || "",
        voteCase.description || "",
        Number(voteCase.corporationID || 0),
        Number(voteCase.createdByCharacterID || 0),
        Number(voteCase.voteType || 0),
        buildFiletimeLong(voteCase.startDateTime || 0),
        buildFiletimeLong(voteCase.endDateTime || 0),
        voteCase.processed ? 1 : 0,
      ],
    ),
    "carbon.common.script.sys.crowset.CRowset",
  );
}

function buildVoteOptions(options = []) {
  return buildList(
    options.map((option) =>
      buildKeyVal([
        ["optionID", Number(option.optionID || 0)],
        ["optionText", option.optionText || ""],
        ["parameter", Number(option.parameter || 0)],
        ["parameter1", Number(option.parameter1 || 0)],
        ["parameter2", Number(option.parameter2 || 0)],
        ["votesFor", Number(option.votesFor || 0)],
      ]),
    ),
  );
}

function buildVotes(votes = []) {
  return buildList(
    votes.map((vote) =>
      buildKeyVal([
        ["voteCaseID", Number(vote.voteCaseID || 0)],
        ["characterID", Number(vote.characterID || 0)],
        ["optionID", Number(vote.optionID || 0)],
        ["castDateTime", buildFiletimeLong(vote.castDateTime || 0)],
        ["voteWeight", Number(vote.voteWeight || 0)],
      ]),
    ),
  );
}

function buildSanctionedAction(action) {
  return buildKeyVal([
    ["voteCaseID", Number(action.voteCaseID || 0)],
    ["voteType", Number(action.voteType || 0)],
    ["optionID", Number(action.optionID || 0)],
    ["parameter", Number(action.parameter || 0)],
    ["parameter1", Number(action.parameter1 || 0)],
    ["parameter2", Number(action.parameter2 || 0)],
    ["expires", buildFiletimeLong(action.expires || 0)],
    ["actedUpon", Number(action.actedUpon || 0)],
    ["inEffect", Number(action.inEffect || 0)],
    [
      "timeActedUpon",
      action.timeActedUpon ? buildFiletimeLong(action.timeActedUpon) : null,
    ],
    [
      "timeRescended",
      action.timeRescended ? buildFiletimeLong(action.timeRescended) : null,
    ],
  ]);
}

class VoteManagerService extends BaseService {
  constructor() {
    super("voteManager");
  }

  Handle_GetVoteCasesByCorporation(args, session) {
    const corporationID = resolveCorporationID(args, session);
    requireVoteReadAuthority(corporationID, session);
    const requestedStatus =
      args && args.length > 1 ? Number(args[1]) || VOTECASE_STATUS_ALL : VOTECASE_STATUS_ALL;
    const allVoteCases = listVoteCasesByCorporation(corporationID);
    const openVoteCases = allVoteCases.filter(
      (voteCase) => getVoteCaseStatus(voteCase) === VOTECASE_STATUS_OPEN,
    );
    for (const voteCase of openVoteCases) {
      armVoteCaseCloseTimer(voteCase);
    }
    const closedVoteCases = allVoteCases.filter(
      (voteCase) => !openVoteCases.some((openVoteCase) => openVoteCase.voteCaseID === voteCase.voteCaseID),
    ).slice(0, MAX_CLOSED_VOTES_FETCHED);

    const byStatus = buildDict([
      [VOTECASE_STATUS_OPEN, buildVoteCaseRowset(openVoteCases)],
      [VOTECASE_STATUS_CLOSED, buildVoteCaseRowset(closedVoteCases)],
    ]);
    if (requestedStatus === VOTECASE_STATUS_OPEN) {
      return buildDict([[VOTECASE_STATUS_OPEN, buildVoteCaseRowset(openVoteCases)]]);
    }
    if (requestedStatus === VOTECASE_STATUS_CLOSED) {
      return buildDict([[VOTECASE_STATUS_CLOSED, buildVoteCaseRowset(closedVoteCases)]]);
    }
    return byStatus;
  }

  Handle_GetVoteCase(args, session) {
    const corporationID = resolveCorporationID(args, session);
    requireVoteReadAuthority(corporationID, session);
    const voteCaseID = args && args.length > 1 ? Number(args[1]) || 0 : 0;
    const voteCase = getVoteCase(corporationID, voteCaseID);
    if (!voteCase) {
      return null;
    }
    return buildKeyVal([
      ["voteCaseID", Number(voteCase.voteCaseID || 0)],
      ["corporationID", Number(voteCase.corporationID || 0)],
      ["voteType", Number(voteCase.voteType || 0)],
      ["voteCaseText", voteCase.voteCaseText || ""],
      ["description", voteCase.description || ""],
      ["startDateTime", buildFiletimeLong(voteCase.startDateTime || 0)],
      ["endDateTime", buildFiletimeLong(voteCase.endDateTime || 0)],
      ["createdByCharacterID", Number(voteCase.createdByCharacterID || 0)],
    ]);
  }

  Handle_GetVoteCaseOptions(args, session) {
    const corporationID = resolveCorporationID(args, session);
    requireVoteReadAuthority(corporationID, session);
    const voteCaseID = args && args.length > 1 ? Number(args[1]) || 0 : 0;
    return buildVoteOptions(listVoteCaseOptions(corporationID, voteCaseID));
  }

  Handle_GetVotes(args, session) {
    const voteCaseID = args && args.length > 0 ? Number(args[0]) || 0 : 0;
    const corporationID =
      resolveCorporationID(
        [session && (session.corporationID || session.corpid)],
        session,
      ) || 0;
    const characterID =
      (session && (session.characterID || session.charid)) || 0;
    return buildVotes(
      listVotesByVoteCase(corporationID, voteCaseID).filter(
        (vote) => Number(vote.characterID) === Number(characterID),
      ),
    );
  }

  Handle_CanViewVotes(args, session) {
    const corporationID = resolveCorporationID(args, session);
    return canViewVotes(corporationID, session);
  }

  Handle_CanVote(args, session) {
    const corporationID = resolveCorporationID(args, session);
    return canVote(corporationID, session);
  }

  Handle_CanRunForCEO(args, session) {
    const corporationID = resolveCorporationID([], session);
    return canRunForCEO(corporationID, session);
  }

  Handle_InsertVoteCase(args, session) {
    const characterID = (session && (session.characterID || session.charid)) || 0;
    const corporationID = resolveCorporationID([], session);
    const authority = getPersistedCorporationAuthority(session);
    const voteCaseText = args && args.length > 0 ? args[0] : "";
    const description = args && args.length > 1 ? args[1] : "";
    const voteType = args && args.length > 2 ? Number(unwrapMarshalValue(args[2])) : voteGeneral;
    // Authorization and persistence must use the same discriminator. The state
    // layer truncates numeric inputs; a fractional type must not skip CEO/item
    // preflight here and then become that privileged vote type when stored.
    if (!Number.isSafeInteger(voteType) || ![
      voteCEO, voteWar, voteShares, voteKickMember, voteGeneral, voteItemLockdown, voteItemUnlock,
    ].includes(voteType)) throwWrappedUserError("CrpAccessDenied");
    const options = args && args.length > 3 ? args[3] : [];
    const duration = args && args.length > 4 ? args[4] : 1;
    const candidateID = Number(options && options[2]) || 0;
    if (!authority || authority.corporationID !== Number(corporationID) ||
        (Number(voteType) === voteCEO
          ? (!canRunForCEO(corporationID, session) || candidateID !== Number(characterID))
          : !authority.isDirector)) {
      throwWrappedUserError("CrpAccessDenied");
    }
    if ([voteCEO, voteKickMember].includes(Number(voteType))) {
      const target = getCharacterRecord(candidateID);
      if (!target || Number(target.corporationID) !== Number(corporationID)) {
        throwWrappedUserError("CrpAccessDenied");
      }
    }
    if ([voteItemLockdown, voteItemUnlock].includes(Number(voteType))) {
      const item = findItemById(candidateID);
      const office = item && getCorporationOfficeByInventoryID(corporationID, item.locationID);
      if (!item || Number(item.ownerID) !== Number(corporationID) ||
          Number(item.typeID) !== Number(options[3]) ||
          (Number(item.locationID) !== Number(options[4]) && Number(office && office.stationID) !== Number(options[4]))) {
        throwWrappedUserError("CrpAccessDenied");
      }
    }
    const voteCase = createVoteCase(
      corporationID,
      characterID,
      voteCaseText,
      description,
      voteType,
      Array.isArray(options) ? options : [],
      duration,
    );
    if (voteCase) {
      // The client does not add its own new case to its cache; every member,
      // the creator included, learns of it from this event.
      notifyVoteCaseChanged(corporationID, voteCase.voteCaseID);
      armVoteCaseCloseTimer(voteCase);
    }
    return voteCase ? Number(voteCase.voteCaseID || 0) : null;
  }

  Handle_InsertVote(args, session) {
    const corporationID = args && args.length > 0 ? Number(args[0]) || 0 : 0;
    const voteCaseID = args && args.length > 1 ? Number(args[1]) || 0 : 0;
    const optionID = args && args.length > 2 ? Number(args[2]) || 0 : 0;
    const result = castVote(corporationID, voteCaseID, session, optionID);
    if (result && result.success) {
      notifyVoteCast(corporationID, voteCaseID);
    }
    return null;
  }

  Handle_GetCorpSanctionedActions(args, session) {
    const corporationID = resolveCorporationID([], session);
    requireVoteReadAuthority(corporationID, session);
    return buildDict(
      listSanctionedActions(corporationID).map((action) => [
        Number(action.voteCaseID || 0),
        buildSanctionedAction(action),
      ]),
    );
  }

  Handle_ActivateSanctionedAction(args, session) {
    const authority = getPersistedCorporationAuthority(session);
    if (!authority || !authority.isCEO) throwWrappedUserError("CrpAccessDenied");
    const voteCaseID = args && args.length > 0 ? Number(args[0]) || 0 : 0;
    const corporationID = resolveCorporationID([], session);
    const result = activateSanctionedAction(corporationID, voteCaseID);
    if (result && result.success) {
      notifySanctionedActionChanged(corporationID, voteCaseID);
    }
    return null;
  }

  Handle_ActOnSanctionedAction(args, session) {
    return this.Handle_ActivateSanctionedAction(args, session);
  }
}

module.exports = VoteManagerService;
VoteManagerService._testing = { armVoteCaseCloseTimer, clearVoteCaseCloseTimersForTests };
