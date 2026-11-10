"use strict";

const path = require("path");

const BaseService = require(path.join(__dirname, "../baseService"));
const config = require(path.join(__dirname, "../../config"));
const { PROXY_NODE_ID } = require(path.join(__dirname, "../../network/protocolProfile"));
const log = require(path.join(__dirname, "../../utils/logger"));
const {
  buildDict,
  currentFileTime,
  normalizeText,
  resolveBoundNodeId,
} = require(path.join(__dirname, "../_shared/serviceHelpers"));
const {
  listAgents,
  listAgentsAsBuilt,
  getAgentByID,
} = require(path.join(__dirname, "./agentAuthority"));
const {
  getEpicArcMessageMaps,
  listDisabledMissionIDs,
} = require(path.join(__dirname, "./missionAuthority"));
const {
  resolveDungeonShipRestrictions,
} = require(path.join(__dirname, "../dungeon/dungeonShipRestrictionResolver"));
const {
  buildCachedMethodCallResult,
} = require(path.join(__dirname, "../cache/objectCacheRuntime"));
const {
  buildDeferredCallResponse,
} = require(path.join(__dirname, "../../network/callResponseControl"));
const spaceRuntime = require(path.join(__dirname, "../../space/runtime"));
const worldData = require(path.join(__dirname, "../../space/worldData"));
const {
  warpFleetFollowers,
} = require(path.join(__dirname, "../fleets/fleetWarpFollowers"));
const {
  throwWarpFailureUserError,
} = require(path.join(__dirname, "../ship/warpFailureUserError"));
const {
  throwWrappedUserError,
} = require(path.join(__dirname, "../../common/machoErrors"));
const bookmarkRuntime = require(path.join(
  __dirname,
  "../bookmark/bookmarkRuntimeState",
));
const agentMissionRuntime = require(path.join(
  __dirname,
  "./agentMissionRuntime",
));
const researchDialogue = require(path.join(__dirname, "./researchDialogue"));

function normalizePositiveInteger(value, fallback = 0) {
  const numericValue = Number(value);
  if (!Number.isInteger(numericValue) || numericValue <= 0) {
    return fallback;
  }
  return numericValue;
}

function buildMutableClientRowset(header = [], rows = []) {
  return {
    type: "object",
    name: "eve.common.script.sys.rowset.Rowset",
    args: {
      type: "dict",
      entries: [
        ["header", { type: "list", items: header }],
        ["RowClass", { type: "token", value: "util.Row" }],
        [
          "lines",
          {
            type: "list",
            items: rows.map((line) => ({
              type: "list",
              items: Array.isArray(line) ? line : [],
            })),
          },
        ],
      ],
    },
  };
}

function buildMarshalTuple(items = []) {
  return {
    type: "tuple",
    items: Array.isArray(items) ? items : [items],
  };
}

function normalizeMarshalTuple(value, fallback = [null, null]) {
  if (value && value.type === "tuple") {
    return value;
  }
  if (Array.isArray(value)) {
    return buildMarshalTuple(value);
  }
  return buildMarshalTuple(fallback);
}

function buildDoActionResponsePayload(result) {
  const payload = result && result.data ? result.data : null;
  const agentSays = normalizeMarshalTuple(payload
    ? payload.agentSays
    : ["This agent is unavailable.", null]);
  const actions = normalizeArrayLike(payload ? payload.actions : []).map(
    (action) => toMarshalSafe(normalizeMarshalTuple(action, [])),
  );
  return buildMarshalTuple([
    buildMarshalTuple([
      toMarshalSafe(agentSays),
      {
        type: "list",
        items: actions,
      },
    ]),
    toMarshalSafe(payload ? payload.lastActionInfo : {}),
  ]);
}

// DoAction's answer for a doAgentAction result, which settles later when it is a promise.
function answerDoAction(result) {
  return result && typeof result.then === "function"
    ? result.then((settledResult) => buildDoActionResponsePayload(settledResult))
    : buildDoActionResponsePayload(result);
}

function normalizeArrayLike(value) {
  if (Array.isArray(value)) {
    return value;
  }
  if (value && Array.isArray(value.items)) {
    return value.items;
  }
  if (value && typeof value[Symbol.iterator] === "function") {
    return [...value];
  }
  if (value && typeof value.length === "number") {
    try {
      return Array.from(value);
    } catch (_error) {
      // ignored: a value Array.from cannot copy gives an empty list
      return [];
    }
  }
  return [];
}

function toMarshalSafe(value) {
  if (value === null || value === undefined) {
    return null;
  }

  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint" ||
    Buffer.isBuffer(value)
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    return {
      type: "list",
      items: value.map((entry) => toMarshalSafe(entry)),
    };
  }

  if (
    typeof value === "object" &&
    ["tuple", "list", "set"].includes(value.type) &&
    Array.isArray(value.items)
  ) {
    return {
      ...value,
      items: value.items.map((entry) => toMarshalSafe(entry)),
    };
  }

  if (
    typeof value === "object" &&
    value.type === "dict" &&
    Array.isArray(value.entries)
  ) {
    return {
      ...value,
      entries: value.entries.map(([entryKey, entryValue]) => [
        toMarshalSafe(entryKey),
        toMarshalSafe(entryValue),
      ]),
    };
  }

  if (typeof value === "object" && value.type) {
    return value;
  }

  if (typeof value === "object") {
    return {
      type: "dict",
      entries: Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        toMarshalSafe(entryValue),
      ]),
    };
  }

  return String(value);
}

function buildNumericKeyDict(source = {}) {
  return buildDict(
    Object.entries(source || {})
      .map(([key, value]) => [normalizePositiveInteger(key, 0), toMarshalSafe(value)])
      .filter(([key]) => key > 0),
  );
}

function buildNestedEpicArcMessageDict() {
  if (buildNestedEpicArcMessageDict._cache) {
    return buildNestedEpicArcMessageDict._cache;
  }

  buildNestedEpicArcMessageDict._cache = buildDict(
    Object.entries(getEpicArcMessageMaps() || {}).map(([messageType, missionMap]) => [
      messageType,
      buildNumericKeyDict(missionMap),
    ]),
  );
  return buildNestedEpicArcMessageDict._cache;
}

buildNestedEpicArcMessageDict._cache = null;

function filterMissionJournalToAgent(journalDetails, agentID) {
  const normalizedAgentID = normalizePositiveInteger(agentID, 0);
  if (!normalizedAgentID || !Array.isArray(journalDetails)) {
    return Array.isArray(journalDetails) ? journalDetails : [[], []];
  }
  return journalDetails.map((bucket, bucketIndex) => (
    Array.isArray(bucket)
      // Mission rows put agentID at index 4, while Browser Research rows put
      // it first: (agentID, field, RP/day, points, level, quality, station).
      // A bound R&D agent must retain its own project in the second bucket.
      ? bucket.filter((row) => Array.isArray(row) && normalizePositiveInteger(
        row[bucketIndex === 1 ? 0 : 4],
        0,
      ) === normalizedAgentID)
      : []
  ));
}

// Raises one of the station `agents` service's ROLE_SERVICE dialogs (SingleChoiceBox,
// GetQuantity, YesNo) and answers DoAction with whatever the plan makes of the reply.
// Same deferred shape as the decline confirmation.
function runResearchDialogPlan(plan, session) {
  return buildDeferredCallResponse(async ({
    dispatcher,
    packet,
    responseServiceName,
    responsePerfMeta,
  }) => {
    const respond = (conversation) => {
      dispatcher._sendCallResponse(
        packet,
        buildDoActionResponsePayload({ success: true, data: conversation }),
        session,
        responseServiceName,
        responsePerfMeta,
      );
    };

    dispatcher._sendCallResponse(
      packet,
      buildMarshalTuple([]),
      session,
      responseServiceName,
      responsePerfMeta,
      {
        // Same provisional shape as the decline and quit confirmations above: TQ
        // answers this one as the direct empty tuple, not wrapped in a substream.
        wrapResultInSubstream: false,
        namedPayloadEntries: [
          [
            "provisional",
            [86400, "OnAgentProvisionalResponse", buildMarshalTuple([])],
          ],
        ],
      },
    );

    // A throw in here would leave the conversation window reloading forever, because
    // the real response is only ever sent from this callback. Always answer.
    const settle = async (clientResponse) => {
      try {
        respond(await plan.resolve(clientResponse));
      } catch (error) {
        log.warn(
          `[Research] ${plan.method} handling failed: ${error && error.message}`,
        );
        respond(researchDialogue.buildFailureConversation());
      }
    };

    const sent = session && typeof session.sendClientCallRequest === "function"
      ? session.sendClientCallRequest("agents", plan.method, plan.args, plan.kwargs, {
        machoTimeout: 86400,
        onResponse: settle,
      })
      : null;
    // No dialog could be raised (socket gone): answer with the conversation the
    // player would have seen had they dismissed it, rather than hanging the call.
    if (sent === null) {
      await settle(null);
    }
  }, { reason: `agent-research-${plan.method}` });
}

function buildMissionJournalDetailsPayload(journalDetails) {
  const buckets = Array.isArray(journalDetails) ? journalDetails : [[], []];
  return buildMarshalTuple(
    buckets.map((bucket) => ({
      type: "list",
      items: normalizeArrayLike(bucket).map((row) => buildMarshalTuple(
        normalizeArrayLike(row).map((field) => toMarshalSafe(field)),
      )),
    })),
  );
}

/** agentMgr.GetAgents' table as last made, and the agents' list it was made of (listAgentsAsBuilt). */
let agentsTable = null;
let agentsTableOf = null;

function resetNestedEpicArcMessageDictCacheForTests() {
  buildNestedEpicArcMessageDict._cache = null;
}

function buildNestedEpicArcMessageDictUncached() {
  return buildDict(
    Object.entries(getEpicArcMessageMaps() || {}).map(([messageType, missionMap]) => [
      messageType,
      buildNumericKeyDict(missionMap),
    ]),
  );
}

function normalizeMissionLocationRole(locationType) {
  switch (normalizeText(locationType, "").toLowerCase()) {
    case "objective":
      return "objective";
    case "dungeon":
      return "dungeon";
    case "objective.source":
      return "source";
    case "objective.destination":
      return "destination";
    case "agenthomebase":
      return "agenthomebase";
    default:
      return "";
  }
}

function sendAgentAdded(session, agentID) {
  if (!session || typeof session.sendNotification !== "function") {
    return false;
  }

  const normalizedAgentID = normalizePositiveInteger(agentID, 0);
  if (!normalizedAgentID) {
    return false;
  }

  session.sendNotification("OnAgentAdded", "charid", [normalizedAgentID]);
  return true;
}

function sendAgentDeclineConfirmation(
  session,
  agentID,
  whenFileTime = currentFileTime(),
  options = {},
) {
  if (!session || typeof session.sendClientCallRequest !== "function") {
    return false;
  }

  const normalizedAgentID = normalizePositiveInteger(agentID, 0);
  if (!normalizedAgentID) {
    return false;
  }

  return session.sendClientCallRequest(
    "agents",
    "YesNo",
    [
      [
        "UI/Agents/StandardMission/DeclineMissionTitle",
        buildDict([]),
      ],
      [
        "UI/Agents/StandardMission/DeclineMessage",
        buildDict([["when", whenFileTime || currentFileTime()]]),
      ],
      normalizedAgentID,
      4802,
      "AgtDeclineMission",
    ],
    buildDict([["machoVersion", 1]]),
    {
      machoTimeout: 86400,
      onResponse:
        typeof options.onResponse === "function"
          ? options.onResponse
          : null,
    },
  ) !== null;
}

const AGENT_QUIT_CONFIRMATION = Object.freeze({
  title: "UI/Agents/StandardMission/QuitMissionTitle",
  body: "UI/Agents/StandardMission/QuitMissionMessage",
  suppressID: "AgtQuitMission",
});

function sendAgentQuitConfirmation(
  session,
  agentID,
  missionRecord,
  options = {},
) {
  if (!session || typeof session.sendClientCallRequest !== "function") {
    return false;
  }

  const normalizedAgentID = normalizePositiveInteger(agentID, 0);
  if (!normalizedAgentID || !missionRecord || typeof missionRecord !== "object") {
    return false;
  }

  return session.sendClientCallRequest(
    "agents",
    "YesNo",
    [
      [AGENT_QUIT_CONFIRMATION.title, buildDict([])],
      [AGENT_QUIT_CONFIRMATION.body, buildDict([])],
      normalizedAgentID,
      missionRecord.contentID,
      AGENT_QUIT_CONFIRMATION.suppressID,
    ],
    buildDict([["machoVersion", 1]]),
    {
      machoTimeout: 86400,
      onResponse:
        typeof options.onResponse === "function"
          ? options.onResponse
          : null,
    },
  ) !== null;
}

// The share prompt's suppress ID: the box shows retail's "Remember my preference" checkbox
// and the client answers a remembered decision under it without a window.
const FLEET_SHARE_SUPPRESS_ID = "AgtShare";

// Raises the share prompt (agents.SingleChoiceBox, agents.py L439-L467): the title string,
// the body tuple and a list of the two choice tuples. A null suppressID raises it with no
// checkbox. True when the request went out; false when no window could be raised.
function sendFleetSharePrompt(session, agentID, prompt, suppressID, onResponse) {
  if (!session || typeof session.sendClientCallRequest !== "function") {
    return false;
  }
  return session.sendClientCallRequest(
    "agents",
    "SingleChoiceBox",
    [
      prompt.title,
      prompt.body,
      { type: "list", items: prompt.choices },
      agentID,
      prompt.contentID,
      suppressID,
    ],
    buildDict([["machoVersion", 1]]),
    {
      machoTimeout: 86400,
      onResponse,
    },
  ) !== null;
}

// DoAction for a turn-in the pilot's fleet could share (doc/FLEET_SHARES.md → Fleet-share
// prompt): answers provisionally, asks, and turns the mission in shared or kept by the
// answer. A remembered Cancel or Close asks once more without the checkbox; anything else
// turns nothing in and answers the conversation as it stands. A late answer counts only for
// the mission it was asked about, still turned in by the same action, and DoAction always
// answers. `agentID` is the bound agent's; the box carries the completing mission's
// (`prompt.agentID`), which for a referral is another agent's.
function runFleetSharePrompt(session, characterID, agentID, actionID, prompt) {
  const askedTurnIn = prompt.turnIn;
  return buildDeferredCallResponse(async ({
    dispatcher,
    packet,
    responseServiceName,
    responsePerfMeta,
  }) => {
    dispatcher._sendCallResponse(
      packet,
      buildMarshalTuple([]),
      session,
      responseServiceName,
      responsePerfMeta,
      {
        // The decline and quit confirmations' provisional shape.
        wrapResultInSubstream: false,
        namedPayloadEntries: [
          [
            "provisional",
            [86400, "OnAgentProvisionalResponse", buildMarshalTuple([])],
          ],
        ],
      },
    );

    let answered = false;
    const respond = (result) => {
      if (answered) {
        return;
      }
      answered = true;
      dispatcher._sendCallResponse(
        packet,
        buildDoActionResponsePayload(result),
        session,
        responseServiceName,
        responsePerfMeta,
      );
    };
    // The conversation as it stands, for whoever the session now holds; nothing turned in,
    // not even the referral that opening the conversation would carry out.
    const respondAsItStands = async () => {
      try {
        respond(await agentMissionRuntime.doAgentAction(
          normalizePositiveInteger(session && session.characterID, 0),
          agentID,
          null,
          { session, completeNothing: true },
        ));
      } catch (error) {
        log.warn(
          `[AgentMgr] Fleet-share conversation failed char=${characterID} agent=${agentID}: ` +
            `${error && error.message}`,
        );
        respond(null);
      }
    };
    // The same pilot, and the same mission (agent, sequence and contentID) as was asked
    // about, still ready to turn in by the same action: the same kind of turn-in, leading
    // to the same next mission.
    const askedMissionStillMatches = () => {
      if (normalizePositiveInteger(session && session.characterID, 0) !== characterID) {
        return false;
      }
      const currentTurnIn = agentMissionRuntime.getMissionTurnIn(characterID, agentID, actionID);
      return Boolean(
        askedTurnIn &&
        currentTurnIn &&
        currentTurnIn.kind === askedTurnIn.kind &&
        currentTurnIn.agentID === askedTurnIn.agentID &&
        currentTurnIn.missionSequence === askedTurnIn.missionSequence &&
        normalizeText(currentTurnIn.contentID, "") === normalizeText(askedTurnIn.contentID, "") &&
        normalizeText(currentTurnIn.nextMissionID, "") ===
          normalizeText(askedTurnIn.nextMissionID, ""),
      );
    };

    let raise = null;
    const handleAnswer = async (clientResponse, suppressID) => {
      try {
        const answer = agentMissionRuntime.readFleetShareAnswer(clientResponse);
        const missionMatches = askedMissionStillMatches();
        log.info(
          `[AgentMgr] Fleet-share answer char=${characterID} agent=${agentID} ` +
            `answer=${answer} suppressID=${suppressID || "none"} missionMatches=${missionMatches}`,
        );
        if (!missionMatches) {
          await respondAsItStands();
          return;
        }
        if (answer === "share" || answer === "keep") {
          respond(await agentMissionRuntime.doAgentAction(
            characterID,
            agentID,
            actionID,
            { share: answer === "share" },
          ));
          return;
        }
        if (answer === "no-preference" && suppressID !== null) {
          await raise(null);
          return;
        }
        await respondAsItStands();
      } catch (error) {
        log.warn(
          `[AgentMgr] Fleet-share answer handling failed char=${characterID} agent=${agentID}: ` +
            `${error && error.message}`,
        );
        await respondAsItStands();
      }
    };
    raise = async (suppressID) => {
      let sent = false;
      try {
        sent = sendFleetSharePrompt(
          session,
          prompt.agentID,
          prompt,
          suppressID,
          (clientResponse) => handleAnswer(clientResponse, suppressID),
        );
      } catch (error) {
        log.warn(
          `[AgentMgr] Fleet-share prompt failed char=${characterID} agent=${agentID}: ` +
            `${error && error.message}`,
        );
      }
      // No window could be raised (the socket gone): a cancel.
      if (!sent) {
        await respondAsItStands();
      }
    };
    await raise(FLEET_SHARE_SUPPRESS_ID);
  }, { reason: "agent-fleet-share-prompt" });
}

function isSessionAtAgentLocation(session, agentID) {
  const agentRecord = getAgentByID(normalizePositiveInteger(agentID, 0));
  if (!session || !agentRecord) {
    return false;
  }
  const stationID = normalizePositiveInteger(agentRecord.stationID, 0);
  if (stationID) {
    return normalizePositiveInteger(session.stationid, 0) === stationID;
  }
  const solarSystemID = normalizePositiveInteger(agentRecord.solarSystemID, 0);
  return solarSystemID > 0 &&
    normalizePositiveInteger(session.locationid, 0) === solarSystemID;
}

function buildPointTarget(position, locationID, metadata = {}) {
  if (!position || typeof position !== "object") {
    return null;
  }
  const x = Number(position.x);
  const y = Number(position.y);
  const z = Number(position.z);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
    return null;
  }
  return {
    kind: "point",
    point: { x, y, z },
    locationID: normalizePositiveInteger(locationID, 0),
    metadata: {
      ...(metadata && typeof metadata === "object" ? metadata : {}),
    },
  };
}

function buildTargetFromLocationWrap(locationWrap) {
  if (!locationWrap || typeof locationWrap !== "object") {
    return null;
  }
  const staticTarget = bookmarkRuntime.resolveStaticBookmarkTarget(
    normalizePositiveInteger(locationWrap.locationID, 0),
  );
  if (staticTarget) {
    return {
      kind: "item",
      itemID: normalizePositiveInteger(staticTarget.itemID, 0),
      locationID: normalizePositiveInteger(staticTarget.locationID, 0),
      metadata: {},
    };
  }
  return buildPointTarget(
    locationWrap,
    normalizePositiveInteger(locationWrap.solarsystemID, 0) ||
      normalizePositiveInteger(locationWrap.locationID, 0),
  );
}

function deleteBookmarkForCharacter(characterID, bookmarkID) {
  const bookmarkInfo = bookmarkRuntime.getBookmarkForCharacter(characterID, bookmarkID);
  if (!bookmarkInfo || !bookmarkInfo.folder) {
    return;
  }
  try {
    bookmarkRuntime.deleteBookmarks(characterID, bookmarkInfo.folder.folderID, [bookmarkID]);
  } catch (_error) {
    // ignored: best-effort cleanup only.
  }
}

function isCurrentMissionBookmarkTarget(bookmarkTarget, role, missionRecord, missionAgentID) {
  if (!bookmarkTarget || !bookmarkTarget.bookmark) {
    return false;
  }
  const metadata =
    bookmarkTarget.metadata && typeof bookmarkTarget.metadata === "object"
      ? bookmarkTarget.metadata
      : {};
  if (normalizeText(metadata.role, "") !== role) {
    return false;
  }

  const bookmarkAgentID = normalizePositiveInteger(
    metadata.referringAgentID || metadata.agentID,
    0,
  );
  if (bookmarkAgentID > 0 && bookmarkAgentID !== missionAgentID) {
    return false;
  }

  if (role === "dungeon") {
    const expectedMissionSiteID = normalizePositiveInteger(
      missionRecord && missionRecord.missionSiteID,
      0,
    );
    const expectedMissionInstanceID = normalizePositiveInteger(
      missionRecord && missionRecord.dungeonInstanceID,
      0,
    );
    const bookmarkMissionSiteID = normalizePositiveInteger(metadata.missionSiteID, 0);
    const bookmarkMissionInstanceID = normalizePositiveInteger(
      metadata.missionInstanceID,
      0,
    );
    if (expectedMissionSiteID > 0 && bookmarkMissionSiteID !== expectedMissionSiteID) {
      return false;
    }
    if (
      expectedMissionInstanceID > 0 &&
      bookmarkMissionInstanceID !== expectedMissionInstanceID
    ) {
      return false;
    }
    return normalizePositiveInteger(bookmarkTarget.locationID, 0) ===
      normalizePositiveInteger(missionRecord && missionRecord.missionSystemID, 0);
  }

  if (role === "source") {
    return normalizePositiveInteger(bookmarkTarget.locationID, 0) === normalizePositiveInteger(
      missionRecord &&
        missionRecord.pickupLocation &&
        (missionRecord.pickupLocation.solarsystemID || missionRecord.pickupLocation.locationID),
      0,
    );
  }

  if (role === "destination") {
    return normalizePositiveInteger(bookmarkTarget.locationID, 0) === normalizePositiveInteger(
      missionRecord &&
        missionRecord.dropoffLocation &&
        (missionRecord.dropoffLocation.solarsystemID || missionRecord.dropoffLocation.locationID),
      0,
    );
  }

  if (role === "objective") {
    const objectiveLocation = missionRecord && missionRecord.dropoffLocation;
    const expectedSystemID = normalizePositiveInteger(
      objectiveLocation && (objectiveLocation.solarsystemID || objectiveLocation.locationID),
      0,
    );
    if (
      expectedSystemID <= 0 ||
      normalizePositiveInteger(bookmarkTarget.locationID, 0) !== expectedSystemID
    ) {
      return false;
    }

    const expectedItemID = normalizePositiveInteger(
      objectiveLocation && objectiveLocation.locationID,
      0,
    );
    const bookmarkItemID = normalizePositiveInteger(
      bookmarkTarget.bookmark && bookmarkTarget.bookmark.itemID,
      0,
    );
    return (
      expectedItemID <= 0 ||
      expectedItemID === expectedSystemID ||
      bookmarkItemID <= 0 ||
      bookmarkItemID === expectedItemID
    );
  }

  if (role === "agenthomebase") {
    return true;
  }

  return false;
}

function resolveMissionLocationTarget(characterID, agentID, locationType, referringAgentID = 0) {
  const role = normalizeMissionLocationRole(locationType);
  const boundAgentID = normalizePositiveInteger(agentID, 0);
  const missionAgentID = normalizePositiveInteger(referringAgentID, 0) || boundAgentID;
  if (!role) {
    return null;
  }

  // Only an accepted mission has locations to warp to: the client holds agent
  // bookmarks for accepted missions only, so an offered mission (the next part a
  // turn-in rolls into) or a finished one leads nowhere.
  const storedMissionRecord = missionAgentID > 0
    ? (
      agentMissionRuntime.getMissionRecord(characterID, missionAgentID) ||
      null
    )
    : null;
  const missionRecord = storedMissionRecord &&
    normalizeText(storedMissionRecord.runtimeStatus, "").toLowerCase() === "accepted"
    ? storedMissionRecord
    : null;

  if (missionRecord && missionRecord.bookmarkIDsByRole && typeof missionRecord.bookmarkIDsByRole === "object") {
    const bookmarkID = normalizePositiveInteger(missionRecord.bookmarkIDsByRole[role], 0);
    if (bookmarkID > 0) {
      const bookmarkTarget = bookmarkRuntime.resolveBookmarkTarget(bookmarkID);
      if (isCurrentMissionBookmarkTarget(bookmarkTarget, role, missionRecord, missionAgentID)) {
        return bookmarkTarget;
      }
      deleteBookmarkForCharacter(characterID, bookmarkID);
    }
  }

  if (role === "agenthomebase") {
    return buildTargetFromLocationWrap(
      agentMissionRuntime.getAgentLocationWrap(missionAgentID || boundAgentID),
    );
  }

  if (!missionRecord) {
    return null;
  }

  if (role === "source") {
    return buildTargetFromLocationWrap(missionRecord.pickupLocation || null);
  }

  if (role === "destination") {
    return buildTargetFromLocationWrap(missionRecord.dropoffLocation || null);
  }

  if (role === "objective") {
    return buildTargetFromLocationWrap(
      missionRecord.dropoffLocation ||
        agentMissionRuntime.getAgentLocationWrap(missionAgentID || boundAgentID),
    );
  }

  if (role === "dungeon") {
    return buildPointTarget(
      missionRecord.missionPosition,
      missionRecord.missionSystemID,
      {
        missionInstanceID: normalizePositiveInteger(missionRecord.dungeonInstanceID, 0) || null,
        missionSiteID: normalizePositiveInteger(missionRecord.missionSiteID, 0) || null,
      },
    );
  }

  return null;
}

class AgentMgrService extends BaseService {
  constructor() {
    super("agentMgr");
    this._boundContexts = new Map();
  }

  _rememberBoundContext(oidString, agentID) {
    if (!oidString || !agentID) {
      return;
    }
    this._boundContexts.set(oidString, {
      agentID: normalizePositiveInteger(agentID, 0),
    });
  }

  _resolveBoundAgentID(session, fallback = 0) {
    if (session && session.currentBoundObjectID) {
      const boundContext =
        this._boundContexts.get(session.currentBoundObjectID) || null;
      if (boundContext && boundContext.agentID) {
        return boundContext.agentID;
      }
    }
    return normalizePositiveInteger(fallback, 0);
  }

  _buildBoundResponse(agentID, session, nestedCall = null) {
    const boundId = config.getNextBoundId();
    const idString = `N=${PROXY_NODE_ID}:${boundId}`;
    const oid = [idString, currentFileTime()];
    this._rememberBoundContext(idString, agentID);

    if (session) {
      if (!session._boundObjectIDs || typeof session._boundObjectIDs !== "object") {
        session._boundObjectIDs = {};
      }
      session._boundObjectIDs[this.name] = idString;
      session.lastBoundObjectID = idString;
    }

    let callResult = null;
    if (Array.isArray(nestedCall) && nestedCall.length > 0) {
      const methodName = normalizeText(nestedCall[0], "");
      const callArgs = nestedCall.length > 1 ? nestedCall[1] : [];
      const callKwargs = nestedCall.length > 2 ? nestedCall[2] : null;
      const previousBoundObjectID = session ? session.currentBoundObjectID : null;
      try {
        if (session) {
          session.currentBoundObjectID = idString;
        }
        callResult = this.callMethod(
          methodName,
          Array.isArray(callArgs) ? callArgs : [callArgs],
          session,
          callKwargs,
        );
      } finally {
        if (session) {
          session.currentBoundObjectID = previousBoundObjectID || null;
        }
      }
    }

    return [
      {
        type: "substruct",
        value: {
          type: "substream",
          value: oid,
        },
      },
      callResult != null ? callResult : null,
    ];
  }

  Handle_MachoResolveObject(args) {
    const bindParameter = args && args[0];
    void bindParameter;
    return resolveBoundNodeId();
  }

  Handle_MachoBindObject(args, session) {
    const bindParams = args && args.length > 0 ? args[0] : null;
    const nestedCall = args && args.length > 1 ? args[1] : null;
    const agentID = normalizePositiveInteger(
      Array.isArray(bindParams) ? bindParams[0] : bindParams,
      0,
    );
    return this._buildBoundResponse(agentID, session, nestedCall);
  }

  Handle_GetAgents() {
    log.debug("[AgentMgrService] GetAgents");
    // The table is the same for every pilot and every asking: made once for each build of the agents' cache, and
    // answered as made. Made afresh at each asking it took the server 32 ms, every call that came in behind it
    // waiting (a pilot's login asks it among its first calls). Tranquility answers it as a cached object, kept
    // for the run (versionCheck "run"), which the client fetches once from objectCaching.
    const agents = listAgentsAsBuilt();
    if (agentsTableOf !== agents) {
      agentsTable = this._buildAgentsTable(agents);
      agentsTableOf = agents;
    }
    return agentsTable;
  }

  _buildAgentsTable(agents) {
    return buildMutableClientRowset(
      [
        "agentID",
        "agentTypeID",
        "divisionID",
        "level",
        "stationID",
        "corporationID",
        "isLocatorAgent",
        "isInSpace",
        "careerID",
        "importantMission",
        "missionKind",
        "missionTypeLabel",
        "specialityID",
        "stationTypeID",
        "bloodlineID",
      ],
      agents.map((agentRecord) => [
        normalizePositiveInteger(agentRecord && agentRecord.agentID, 0),
        normalizePositiveInteger(agentRecord && agentRecord.agentTypeID, 0),
        normalizePositiveInteger(agentRecord && agentRecord.divisionID, 0),
        normalizePositiveInteger(agentRecord && agentRecord.level, 1),
        normalizePositiveInteger(agentRecord && agentRecord.stationID, 0) || null,
        normalizePositiveInteger(agentRecord && agentRecord.corporationID, 0),
        agentRecord && agentRecord.isLocator === true,
        agentRecord && agentRecord.isInSpace === true,
        normalizePositiveInteger(agentRecord && agentRecord.careerID, 0) || null,
        agentRecord && agentRecord.importantMission === true,
        normalizeText(agentRecord && agentRecord.missionKind, ""),
        normalizeText(agentRecord && agentRecord.missionTypeLabel, ""),
        normalizePositiveInteger(agentRecord && agentRecord.specialityID, 0) || null,
        normalizePositiveInteger(agentRecord && agentRecord.stationTypeID, 0) || null,
        normalizePositiveInteger(agentRecord && agentRecord.bloodlineID, 0) || null,
      ]),
    );
  }

  Handle_GetSolarSystemOfAgent(args) {
    const agentID = normalizePositiveInteger(args && args[0], 0);
    return agentMissionRuntime.getSolarSystemOfAgent(agentID);
  }

  Handle_GetCompletedCareerAgentIDs(args, session) {
    const agentIDs = normalizeArrayLike(args && args[0]);
    return buildNumericKeyDict(
      agentMissionRuntime.getCompletedCareerAgentMap(
        normalizePositiveInteger(session && session.characterID, 0),
        agentIDs,
      ),
    );
  }

  Handle_GetDisabledMissions() {
    return toMarshalSafe(listDisabledMissionIDs());
  }

  Handle_GetAgentStaticInfo(args, session) {
    const agentID = normalizePositiveInteger(args && args[0], 0);
    const agentRecord = getAgentByID(agentID);
    if (agentRecord) {
      sendAgentAdded(session, agentID);
    }
    return toMarshalSafe(agentRecord);
  }

  Handle_GetStaticBlob() {
    return "";
  }

  Handle_GetMyJournalDetails(args, session) {
    const journalDetails = agentMissionRuntime.getJournalDetails(
      normalizePositiveInteger(session && session.characterID, 0),
    );
    const boundAgentID = this._resolveBoundAgentID(session, 0);
    return buildMissionJournalDetailsPayload(
      boundAgentID > 0
        ? filterMissionJournalToAgent(journalDetails, boundAgentID)
        : journalDetails,
    );
  }

  Handle_GetPlausibleMissionIDs(args) {
    return toMarshalSafe(
      agentMissionRuntime.getPlausibleMissionIDs(
        normalizePositiveInteger(args && args[0], 0),
      ),
    );
  }

  Handle_GetMyEpicArcStatus(args, session) {
    return agentMissionRuntime.getMyEpicArcStatus(
      normalizePositiveInteger(session && session.characterID, 0),
    );
  }

  Handle_GetMessagesForEpicArcMissions() {
    return buildCachedMethodCallResult(
      buildNestedEpicArcMessageDict(),
      {
        serviceName: this.name,
        method: "GetMessagesForEpicArcMissions",
        versionCheck: "never",
        proxyCache: true,
      },
    );
  }

  Handle_DoAction(args, session) {
    const agentID = this._resolveBoundAgentID(session);
    const actionID = args && args.length > 0 ? args[0] : null;
    const normalizedActionID = agentMissionRuntime.normalizeAgentDialogueActionID(actionID);
    // A site guide (Rulie Isoryn in the exploration tour) says the text of the pilot's site room.
    const guideTextID = actionID === null || actionID === undefined
      ? require(path.join(__dirname, "../dungeon/dungeonTrackingRuntime")).guideTextForSession(session, agentID)
      : null;
    if (guideTextID) {
      return buildDoActionResponsePayload({ success: true, data: {
        agentSays: [guideTextID, null],
        actions: [],
        lastActionInfo: { missionCompleted: null, missionQuit: null, missionCantReplay: null, loyaltyPoints: 0, missionDeclined: null },
      } });
    }
    const researchPlan = researchDialogue.planResearchAction(
      normalizePositiveInteger(session && session.characterID, 0),
      getAgentByID(agentID),
      actionID,
      { stationID: normalizePositiveInteger(session && session.stationid, 0) },
    );
    if (researchPlan && researchPlan.kind === "dialog") {
      return runResearchDialogPlan(researchPlan, session);
    }
    if (researchPlan && researchPlan.kind === "conversation") {
      return buildDoActionResponsePayload({ success: true, data: researchPlan.data });
    }
    if (
      normalizedActionID ===
      agentMissionRuntime.AGENT_DIALOGUE_BUTTON_DECLINE
    ) {
      return buildDeferredCallResponse(async ({
        dispatcher,
        packet,
        responseServiceName,
        responsePerfMeta,
      }) => {
        dispatcher._sendCallResponse(
          packet,
          buildMarshalTuple([]),
          session,
          responseServiceName,
          responsePerfMeta,
          {
            wrapResultInSubstream: false,
            namedPayloadEntries: [
              [
                "provisional",
                [86400, "OnAgentProvisionalResponse", buildMarshalTuple([])],
              ],
            ],
          },
        );
        const sent = sendAgentDeclineConfirmation(session, agentID, currentFileTime(), {
          onResponse: (clientResponse) => {
            const confirmed = clientResponse && clientResponse.response === true;
            // The client draws whatever DoAction answers (agentDialogueWindow.py
            // _GetConversation). Anything but a confirmed Yes leaves the offer alone, so
            // answer with the conversation as it stands, not the "unavailable" fallback.
            const finalResult = confirmed
              ? agentMissionRuntime.doAgentAction(
                normalizePositiveInteger(session && session.characterID, 0),
                agentID,
                actionID,
              )
              : agentMissionRuntime.doAgentAction(
                normalizePositiveInteger(session && session.characterID, 0),
                agentID,
                null,
                { session, completeNothing: true },
              );
            dispatcher._sendCallResponse(
              packet,
              buildDoActionResponsePayload(finalResult),
              session,
              responseServiceName,
              responsePerfMeta,
            );
          },
        });
        if (!sent) {
          const finalResult = agentMissionRuntime.doAgentAction(
            normalizePositiveInteger(session && session.characterID, 0),
            agentID,
            actionID,
          );
          dispatcher._sendCallResponse(
            packet,
            buildDoActionResponsePayload(finalResult),
            session,
            responseServiceName,
            responsePerfMeta,
          );
        }
      }, { reason: "agent-decline-confirmation" });
    }
    const characterID = normalizePositiveInteger(session && session.characterID, 0);
    // A turn-in a fleet member could share asks the pilot first; with no prompt the
    // mission is turned in at once, unshared, below.
    let fleetSharePrompt = null;
    try {
      fleetSharePrompt = agentMissionRuntime.getFleetSharePrompt(characterID, agentID, actionID);
    } catch (error) {
      log.warn(
        `[AgentMgr] Fleet-share prompt check failed char=${characterID} agent=${agentID}: ` +
          `${error && error.message}`,
      );
      // The conversation as it stands, nothing turned in; it may settle later (a referred
      // mission's), as the turn-in below may.
      const currentConversation = agentMissionRuntime.doAgentAction(
        characterID,
        agentID,
        null,
        { session, completeNothing: true },
      );
      return answerDoAction(currentConversation);
    }
    if (fleetSharePrompt) {
      return runFleetSharePrompt(session, characterID, agentID, actionID, fleetSharePrompt);
    }
    const activeMission = normalizedActionID === agentMissionRuntime.AGENT_DIALOGUE_BUTTON_QUIT
      ? agentMissionRuntime.getMissionRecord(characterID, agentID)
      : null;
    if (
      activeMission &&
      normalizeText(activeMission.runtimeStatus, "").toLowerCase() ===
        agentMissionRuntime.AGENT_MISSION_ACCEPTED &&
      !isSessionAtAgentLocation(session, agentID)
    ) {
      // The current client omits Quit away from the issuing agent and has an explicit
      // CantQuitRemotely warning. A forged button token must not bypass that UI contract.
      const currentConversation = agentMissionRuntime.doAgentAction(
        characterID,
        agentID,
        null,
        { completeNothing: true },
      );
      return buildDoActionResponsePayload(currentConversation);
    }
    if (
      activeMission &&
      normalizeText(activeMission.runtimeStatus, "").toLowerCase() ===
        agentMissionRuntime.AGENT_MISSION_ACCEPTED
    ) {
      return buildDeferredCallResponse(async ({
        dispatcher,
        packet,
        responseServiceName,
        responsePerfMeta,
      }) => {
        dispatcher._sendCallResponse(
          packet,
          buildMarshalTuple([]),
          session,
          responseServiceName,
          responsePerfMeta,
          {
            wrapResultInSubstream: false,
            namedPayloadEntries: [
              [
                "provisional",
                [86400, "OnAgentProvisionalResponse", buildMarshalTuple([])],
              ],
            ],
          },
        );
        const sent = sendAgentQuitConfirmation(session, agentID, activeMission, {
          onResponse: (clientResponse) => {
            const confirmed = clientResponse && clientResponse.response === true;
            const sessionCharacterID = normalizePositiveInteger(
              session && session.characterID,
              0,
            );
            const sameCharacter = sessionCharacterID === characterID;
            const currentMission = confirmed
              ? agentMissionRuntime.getMissionRecord(characterID, agentID)
              : null;
            const missionStillMatches = Boolean(
              currentMission &&
              normalizeText(currentMission.runtimeStatus, "").toLowerCase() ===
                agentMissionRuntime.AGENT_MISSION_ACCEPTED &&
              normalizePositiveInteger(currentMission.missionSequence, 0) ===
                normalizePositiveInteger(activeMission.missionSequence, 0) &&
              normalizeText(currentMission.contentID, "") ===
                normalizeText(activeMission.contentID, ""),
            );
            const atAgentLocation = isSessionAtAgentLocation(session, agentID);
            const confirmationStillMatches =
              missionStillMatches && sameCharacter && atAgentLocation;
            log.info(
              `[AgentMgr] Quit confirmation char=${characterID} agent=${agentID} ` +
              `responseType=${clientResponse ? typeof clientResponse.response : "missing"} ` +
              `confirmed=${Boolean(confirmed)} sameCharacter=${sameCharacter} ` +
              `missionMatches=${missionStillMatches} atAgentLocation=${atAgentLocation}`,
            );
            // A YesNo response can arrive much later. Only the exact mission shown in the
            // warning may be cancelled; never apply an old confirmation to a newer offer.
            let finalResult = null;
            if (confirmed && confirmationStillMatches) {
              finalResult = agentMissionRuntime.doAgentAction(
                characterID,
                agentID,
                actionID,
                { deferQuitNotification: true },
              );
            } else if (sameCharacter) {
              finalResult = agentMissionRuntime.doAgentAction(
                characterID,
                agentID,
                null,
                { session, completeNothing: true },
              );
            }
            const missionWasQuit = Boolean(
              finalResult &&
              finalResult.data &&
              finalResult.data.lastActionInfo &&
              finalResult.data.lastActionInfo.missionQuit === true,
            );
            dispatcher._sendCallResponse(
              packet,
              buildDoActionResponsePayload(finalResult),
              session,
              responseServiceName,
              responsePerfMeta,
            );
            if (missionWasQuit) {
              agentMissionRuntime.notifyMissionQuit(characterID, agentID);
            }
          },
        });
        if (!sent) {
          // A cancellation must never be committed when the warning could not be shown.
          const finalResult = agentMissionRuntime.doAgentAction(
            characterID,
            agentID,
            null,
            { completeNothing: true },
          );
          dispatcher._sendCallResponse(
            packet,
            buildDoActionResponsePayload(finalResult),
            session,
            responseServiceName,
            responsePerfMeta,
          );
        }
      }, { reason: "agent-quit-confirmation" });
    }
    const result = agentMissionRuntime.doAgentAction(
      characterID,
      agentID,
      actionID,
    );
    return answerDoAction(result);
  }

  Handle_GetMissionBriefingInfo(args, session) {
    return toMarshalSafe(
      agentMissionRuntime.getMissionBriefingInfo(
        normalizePositiveInteger(session && session.characterID, 0),
        this._resolveBoundAgentID(session),
      ),
    );
  }

  Handle_GetMissionJournalInfo(args, session) {
    return toMarshalSafe(
      agentMissionRuntime.getMissionJournalInfo(
        normalizePositiveInteger(session && session.characterID, 0),
        this._resolveBoundAgentID(session),
      ),
    );
  }

  Handle_GetMissionObjectiveInfo(args, session) {
    return toMarshalSafe(
      agentMissionRuntime.getMissionObjectiveInfo(
        normalizePositiveInteger(session && session.characterID, 0),
        this._resolveBoundAgentID(session),
      ),
    );
  }

  Handle_GetMissionKeywords(args, session) {
    return toMarshalSafe(
      agentMissionRuntime.getMissionKeywords(
        normalizePositiveInteger(session && session.characterID, 0),
        this._resolveBoundAgentID(session),
        args && args.length > 0 ? args[0] : null,
      ),
    );
  }

  Handle_RemoveOfferFromJournal(args, session) {
    return agentMissionRuntime.removeOfferFromJournal(
      normalizePositiveInteger(session && session.characterID, 0),
      this._resolveBoundAgentID(session),
    );
  }

  Handle_GetAgentLocationWrap(args, session) {
    return toMarshalSafe(
      agentMissionRuntime.getAgentLocationWrap(
        this._resolveBoundAgentID(session),
      ),
    );
  }

  Handle_GetInfoServiceDetails(args, session) {
    return toMarshalSafe(
      agentMissionRuntime.getInfoServiceDetails(
        normalizePositiveInteger(session && session.characterID, 0),
        this._resolveBoundAgentID(session),
      ),
    );
  }

  Handle_GetStandingGainsForMission(args, session) {
    const agentID = this._resolveBoundAgentID(session);
    return buildNumericKeyDict(
      agentMissionRuntime.getStandingGainsForMission(
        normalizePositiveInteger(session && session.characterID, 0),
        agentID,
        args && args.length > 0 ? args[0] : null,
      ),
    );
  }

  Handle_GetDungeonShipRestrictions(args) {
    // Client: GetAgentMoniker(agentID).GetDungeonShipRestrictions(dungeonID[, gateID]). The UI reads
    // restrictions['restrictedShipTypes'] to grey out barred ships (returning null here would raise a
    // client TypeError for any restricted mission). Enforcement is separate (keeperService gate).
    const dungeonID = Array.isArray(args) && args.length > 0 ? args[0] : null;
    const gateID = Array.isArray(args) && args.length > 1 ? args[1] : null;
    return resolveDungeonShipRestrictions(dungeonID, gateID);
  }

  Handle_GetEntryPoint(args, session) {
    const characterID = normalizePositiveInteger(session && session.characterID, 0);
    const agentID = this._resolveBoundAgentID(session);
    const target = resolveMissionLocationTarget(characterID, agentID, "dungeon");
    if (!target || target.kind !== "point") {
      return null;
    }
    return [target.point.x, target.point.y, target.point.z];
  }

  Handle_GotoLocation(args, session) {
    const characterID = normalizePositiveInteger(session && session.characterID, 0);
    const agentID = this._resolveBoundAgentID(session);
    const locationType = args && args.length > 0 ? args[0] : null;
    const referringAgentID = args && args.length > 2 ? args[2] : 0;
    const target = resolveMissionLocationTarget(
      characterID,
      agentID,
      locationType,
      referringAgentID,
    );
    if (!target) {
      return null;
    }
    if (target.kind === "item" && normalizePositiveInteger(target.itemID, 0) > 0) {
      spaceRuntime.followBall(session, normalizePositiveInteger(target.itemID, 0), 0);
      return null;
    }
    if (target.kind === "point" && target.point) {
      spaceRuntime.gotoPoint(session, target.point, {
        commandSource: "AgentGotoLocation",
      });
    }
    return null;
  }

  // Client: movementFunctions.WarpToBookmark / WarpFleetToBookmark call
  // GetAgentMoniker(agentID).WarpToLocation(locationType, locationNumber,
  // warpRange, fleet, referringAgentID, GetFormationSettings()) for an agent
  // location bookmark, in place of michelle.CmdWarpToStuff. "Warp Fleet" to a
  // mission site therefore arrives here with fleet=True, and pulls the fleet
  // as CmdWarpToStuff's fleet warp does.
  Handle_WarpToLocation(args, session) {
    const fleetWarpRequested = Boolean(args && args.length > 3 ? args[3] : false);
    const formationSettings = args && args.length > 5 ? args[5] : null;
    // CmdWarpToStuff ignores any order while the commander is already in warp
    // (it answers ShipInWarp) and so pulls no one; neither does this, whether
    // the warp is a repeat (a redundant result) or one somewhere else.
    const commanderWasWarping = fleetWarpRequested && this._isSessionShipWarping(session);
    const result = this._warpToMissionLocation(args, session);
    if (
      fleetWarpRequested &&
      !commanderWasWarping &&
      result &&
      result.success === true &&
      result.redundant !== true
    ) {
      warpFleetFollowers(session, result, {
        minimumRange: Number(args && args.length > 2 ? args[2] : 0) || 0,
        formationSettings,
      });
    }
    if (!result) {
      // No location to go to (no accepted mission, or a stale bookmark): the
      // client's own BookmarkNotAvailable, "This location is no longer
      // available..." (dialogs.static.json 7326, message 551311).
      log.warn(
        `[AgentWarp] WarpToLocation found no location for char=${session && session.characterID}`,
      );
      throwWrappedUserError("BookmarkNotAvailable");
    }
    if (result.success !== true) {
      // A refused warp tells the pilot why, as CmdWarpToStuff does, instead of
      // leaving the ship where it is with nothing said.
      const errorMsg = result.errorMsg || "WARP_REFUSED";
      log.warn(
        `[AgentWarp] WarpToLocation failed for char=${session && session.characterID}: ${errorMsg}`,
      );
      throwWarpFailureUserError(errorMsg);
    }
    return null;
  }

  _isSessionShipWarping(session) {
    const scene = spaceRuntime.getSceneForSession(session);
    const entity =
      scene && typeof scene.getShipEntityForSession === "function"
        ? scene.getShipEntityForSession(session)
        : null;
    return Boolean(entity && entity.mode === "WARP");
  }

  // The commander's own warp for WarpToLocation; returns the warp result, or
  // null when there was nothing to warp to (WarpToLocation refuses that).
  _warpToMissionLocation(args, session) {
    const characterID = normalizePositiveInteger(session && session.characterID, 0);
    const agentID = this._resolveBoundAgentID(session);
    const locationType = args && args.length > 0 ? args[0] : null;
    const warpRange = Number(args && args.length > 2 ? args[2] : 0) || 0;
    const referringAgentID = args && args.length > 4 ? args[4] : 0;
    const target = resolveMissionLocationTarget(
      characterID,
      agentID,
      locationType,
      referringAgentID,
    );
    if (!target) {
      return null;
    }
    // A location in another solar system is no warp target: its coordinates mean
    // nothing in the pilot's own system.
    const sessionSystemID = normalizePositiveInteger(
      session && (session.solarsystemid2 || session.solarsystemid),
      0,
    );
    const targetSystemID = normalizePositiveInteger(target.locationID, 0);
    if (sessionSystemID > 0 && targetSystemID > 0 && targetSystemID !== sessionSystemID) {
      return { success: false, errorMsg: "WARP_TARGET_NOT_IN_SYSTEM" };
    }
    // This is the warp path the retail client actually uses for agent-mission bookmarks
    // (movementFunctions.WarpToBookmark -> agents.WarpToLocation, NOT beyonce CmdWarpToStuff).
    // For a deadspace combat mission ("dungeon" role) the target is a point carrying the mission's
    // instanceID. Materialize the mission site (acceleration gate + encounters) here, before warping,
    // so its contents exist when the player lands — then warp to the materialized site beacon. Without
    // this the player warped to empty deadspace coords with nothing spawned.
    const missionInstanceID = normalizePositiveInteger(
      target.metadata && target.metadata.missionInstanceID,
      0,
    );
    if (missionInstanceID > 0) {
      const siteEntityID = this._materializeMissionSiteForWarp(
        session,
        characterID,
        locationType,
        missionInstanceID,
      );
      if (siteEntityID > 0) {
        return spaceRuntime.warpToEntity(session, siteEntityID, {
          minimumRange: warpRange,
          stopDistance: warpRange,
          destinationStaticInstanceID: missionInstanceID,
        });
      }
      if (target.kind === "point" && target.point) {
        return spaceRuntime.warpToPoint(session, target.point, {
          minimumRange: warpRange,
          stopDistance: warpRange,
          destinationStaticInstanceID: missionInstanceID,
        });
      }
      log.warn(
        `[AgentWarp] Refusing item WarpToLocation fallback without materialized site char=${characterID} instance=${missionInstanceID}`,
      );
      return null;
    }
    if (target.kind === "item" && normalizePositiveInteger(target.itemID, 0) > 0) {
      return spaceRuntime.warpToEntity(session, normalizePositiveInteger(target.itemID, 0), {
        minimumRange: warpRange,
        stopDistance: warpRange,
      });
    }
    if (target.kind === "point" && target.point) {
      return spaceRuntime.warpToPoint(session, target.point, {
        minimumRange: warpRange,
        stopDistance: warpRange,
      });
    }
    return null;
  }

  // Materialize an accepted combat mission's deadspace site (gate + encounters) into the player's
  // current scene and return the site beacon entity id to warp to (0 if it could not be built).
  _materializeMissionSiteForWarp(session, characterID, locationType, missionInstanceID) {
    try {
      const scene = spaceRuntime.getSceneForSession(session);
      if (!scene) {
        log.warn(
          `[AgentWarp] WarpToLocation no scene for char=${characterID} instance=${missionInstanceID}`,
        );
        return 0;
      }
      const dungeonUniverseSiteService = require(path.join(
        __dirname,
        "../dungeon/dungeonUniverseSiteService",
      ));
      const materialized = dungeonUniverseSiteService.ensureSiteContentsMaterialized(
        scene,
        { instanceID: missionInstanceID },
        { spawnEncounters: true, broadcast: true, session },
      );
      const siteEntityID = materialized && materialized.success === true && materialized.data
        ? normalizePositiveInteger(materialized.data.siteID, 0)
        : 0;
      const matData = (materialized && materialized.data) || {};
      const matCounts = matData.contentSummary || {};
      log.info(
        `[AgentWarp] WarpToLocation char=${characterID} role=${normalizeText(locationType, "?")} ` +
        `instance=${missionInstanceID} -> site=${siteEntityID} ` +
        `ok=${Boolean(materialized && materialized.success === true)} ` +
        `rockEntities=${matData.miningRockEntityCount} rockDistM=${matData.firstRockDistanceMeters} ` +
        `rocksSpawnedThisCall=${matCounts.miningRocksSpawned} env=${matCounts.environmentPropsSpawned} ` +
        `obj=${matCounts.objectivesSpawned} gates=${matCounts.gatesSpawned} enc=${matCounts.encountersSpawned} ` +
        `alreadyMat=${matData.alreadyMaterialized} err=${normalizeText(materialized && materialized.errorMsg, "")}`,
      );
      return siteEntityID;
    } catch (error) {
      log.warn(
        `[AgentWarp] WarpToLocation materialize failed char=${characterID} instance=${missionInstanceID}: ${error.message}`,
      );
      return 0;
    }
  }

  Handle_WarpToAgentInSpace(args, session) {
    const agentID = this._resolveBoundAgentID(
      session,
      args && args.length > 0 ? args[0] : 0,
    );
    if (!agentID) {
      return null;
    }

    const locationWrap = agentMissionRuntime.getAgentLocationWrap(agentID);
    if (
      !locationWrap ||
      worldData.getStationByID(
        normalizePositiveInteger(locationWrap.locationID, 0),
      )
    ) {
      return null;
    }

    const pointTarget = buildPointTarget(
      locationWrap,
      normalizePositiveInteger(locationWrap.solarsystemID, 0) ||
        normalizePositiveInteger(locationWrap.locationID, 0),
    );
    if (pointTarget) {
      spaceRuntime.warpToPoint(session, pointTarget.point, {
        minimumRange: 0,
        stopDistance: 0,
        commandSource: "AgentWarpToAgentInSpace",
      });
      return null;
    }
    if (normalizeText(locationWrap.locationType, "").toLowerCase() === "agentinspace") {
      return null;
    }

    const target = buildTargetFromLocationWrap(locationWrap);
    if (!target) {
      return null;
    }
    if (target.kind === "item" && normalizePositiveInteger(target.itemID, 0) > 0) {
      spaceRuntime.warpToEntity(session, normalizePositiveInteger(target.itemID, 0), {
        minimumRange: 0,
        commandSource: "AgentWarpToAgentInSpace",
      });
      return null;
    }
    return null;
  }

  Handle_GetReplayTimestamp(args, session) {
    return agentMissionRuntime.getReplayTimestamp(
      normalizePositiveInteger(session && session.characterID, 0),
      this._resolveBoundAgentID(session),
    );
  }

  Handle_IsCheatingWithAgent() {
    return false;
  }

  Handle_ShouldAlwaysAllowReplay() {
    return false;
  }

  Handle_GetAgentByID(args, session) {
    const agentID = normalizePositiveInteger(args && args[0], 0);
    const agentRecord = getAgentByID(agentID);
    if (agentRecord) {
      sendAgentAdded(session, agentID);
    }
    return toMarshalSafe(agentRecord);
  }
}

AgentMgrService._testing = {
  ...(AgentMgrService._testing || {}),
  sendAgentAdded,
  sendAgentDeclineConfirmation,
  sendAgentQuitConfirmation,
  isSessionAtAgentLocation,
};

module.exports = AgentMgrService;
