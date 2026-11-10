"use strict";

// The R&D half of an agent conversation: the Start Research / Cancel Research / Buy
// Datacores buttons, and the three client dialogs they raise.
//
// The client drives none of this. agentDialogueWindow.ReconstructButtons just renders
// whatever (actionID, buttonType) pairs the server hands back, and the station
// `agents` service exports SingleChoiceBox, GetQuantity and YesNo as ROLE_SERVICE
// calls for the server to make (agents.py:54-73). So each button is a round trip:
// DoAction -> server raises a dialog -> the answer comes back -> the server acts and
// returns the next conversation.

const path = require("path");

const {
  buildDict,
} = require(path.join(__dirname, "../_shared/serviceHelpers"));
const log = require(path.join(__dirname, "../../utils/logger"));
const researchRuntime = require(path.join(__dirname, "./researchRuntime"));

// appConst.py:157-159.
const AGENT_DIALOGUE_BUTTON_REQUEST_MISSION = 2;
const AGENT_DIALOGUE_BUTTON_START_RESEARCH = 12;
const AGENT_DIALOGUE_BUTTON_CANCEL_RESEARCH = 13;
const AGENT_DIALOGUE_BUTTON_BUY_DATACORES = 14;

// The value DoAction is called back with. Kept clear of the mission tokens already
// in use (815-823) so a research reply can never be mistaken for a mission one.
const ACTION_TOKEN_START_RESEARCH = 830;
const ACTION_TOKEN_CANCEL_RESEARCH = 831;
const ACTION_TOKEN_BUY_DATACORES = 832;

const RESEARCH_ACTION_TOKENS = new Set([
  ACTION_TOKEN_START_RESEARCH,
  ACTION_TOKEN_CANCEL_RESEARCH,
  ACTION_TOKEN_BUY_DATACORES,
  AGENT_DIALOGUE_BUTTON_START_RESEARCH,
  AGENT_DIALOGUE_BUTTON_CANCEL_RESEARCH,
  AGENT_DIALOGUE_BUTTON_BUY_DATACORES,
]);

function toPositiveInteger(value, fallback = 0) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return fallback;
  }
  const normalized = Math.trunc(numericValue);
  return normalized > 0 ? normalized : fallback;
}

function buildLastActionInfo() {
  return {
    missionCompleted: null,
    missionQuit: null,
    missionCantReplay: null,
    loyaltyPoints: 0,
    missionDeclined: null,
  };
}

function buildConversation(agentSays, actions = []) {
  return {
    agentSays,
    actions,
    lastActionInfo: buildLastActionInfo(),
  };
}

function saysConversation(labelPath, kwargs = [], actions = []) {
  return buildConversation(researchRuntime.buildAgentSays(labelPath, kwargs), actions);
}

// A dialog answer arrives inside the marshalled call response, not as a bare value.
// `consumeClientCallResponse` hands back `packet.payload`, and the answer sits in a
// substream somewhere inside it -- the payload may wrap that substream in a
// `[key, substream]` pair the way the outbound path does (clientSession.js:1067), so
// the wrapper is NOT reliably a single-element list.
//
// Hence: find the innermost substream anywhere in the structure and take its value.
// Descending only single-element arrays (which an earlier version did) reads the
// pair's numeric key as the answer and silently fails every dialog.
function findSubstreamValue(value, depth = 0) {
  if (depth > 12 || value === null || typeof value !== "object") {
    return undefined;
  }
  if (value.type === "substream") {
    const inner = findSubstreamValue(value.value, depth + 1);
    return inner === undefined ? value.value : inner;
  }
  const children = Array.isArray(value)
    ? value
    : Array.isArray(value.items)
      ? value.items
      : Object.prototype.hasOwnProperty.call(value, "value")
        ? [value.value]
        : [];
  for (const child of children) {
    const found = findSubstreamValue(child, depth + 1);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

// Marshalled tuples/lists arrive as { type, items }; normalize to a plain array so
// the (ok, index) pair can be read positionally.
function toPlainValue(value, depth = 0) {
  if (depth > 12 || value === null || typeof value !== "object") {
    return value === undefined ? null : value;
  }
  // Marshalled strings arrive as Buffers.
  if (Buffer.isBuffer(value)) {
    return value.toString("utf8");
  }
  if (value.type === "Buffer" && Array.isArray(value.data)) {
    return Buffer.from(value.data).toString("utf8");
  }
  if (Array.isArray(value)) {
    return value.map((entry) => toPlainValue(entry, depth + 1));
  }
  if (Array.isArray(value.items)) {
    return value.items.map((entry) => toPlainValue(entry, depth + 1));
  }
  if (Object.prototype.hasOwnProperty.call(value, "value")) {
    return toPlainValue(value.value, depth + 1);
  }
  return value;
}

function unwrapClientResponse(clientResponse) {
  const payload = clientResponse && clientResponse.response;
  if (payload === null || payload === undefined) {
    return null;
  }
  const substream = findSubstreamValue(payload);
  return toPlainValue(substream === undefined ? payload : substream);
}

// This path is only observable in a live client, so when an answer cannot be read the
// raw shape is logged rather than silently becoming "I did not get your last
// transmission".
function describeClientResponse(clientResponse) {
  try {
    return JSON.stringify(clientResponse && clientResponse.response);
  } catch (_error) {
    // ignored: the answer's raw shape could not be serialized; the log line says so
    return "<unserializable>";
  }
}

// agents.py SingleChoiceBox returns (ret[0] == uiconst.ID_OK, ret[1]), and ret[1] is
// NOT an index: radioButtonMessageBox.py:48 gives each option
// retval = "radioboxOption%dSelected" % (index + 1), so the answer is that 1-based
// name. CCP decode it back at ccSvc.py:112 as
//   int(selection[len("radioboxOption"):-len("Selected")]) - 1
// which is what this reproduces. Verified against a live client, which answered
// "radioboxOption2Selected" for the second of three research fields.
const RADIO_OPTION_PATTERN = /^radioboxOption(\d+)Selected$/;

function readChoiceIndex(clientResponse) {
  const answer = unwrapClientResponse(clientResponse);
  if (!Array.isArray(answer) || answer.length < 2) {
    log.warn(
      `[Research] SingleChoiceBox answer not readable: ${describeClientResponse(clientResponse)}`,
    );
    return null;
  }
  // Cancelled rather than confirmed: not an error, and not logged as one.
  if (answer[0] !== true) {
    return null;
  }

  const selection = answer[1];
  if (typeof selection === "string") {
    const match = RADIO_OPTION_PATTERN.exec(selection.trim());
    if (match) {
      return Number(match[1]) - 1;
    }
  }
  // A bare integer is accepted too, so a client that answers positionally still works.
  const index = Number(selection);
  if (Number.isFinite(index)) {
    return Math.trunc(index);
  }

  log.warn(
    `[Research] SingleChoiceBox selection not understood: ${describeClientResponse(clientResponse)}`,
  );
  return null;
}

// agents.py GetQuantity returns ret.get('qty') -- or nothing, if cancelled.
function readQuantity(clientResponse) {
  const answer = unwrapClientResponse(clientResponse);
  const quantity = Number(Array.isArray(answer) ? answer[0] : answer);
  if (!Number.isFinite(quantity)) {
    log.warn(
      `[Research] GetQuantity answer not readable: ${describeClientResponse(clientResponse)}`,
    );
    return 0;
  }
  return quantity > 0 ? Math.trunc(quantity) : 0;
}

function readYesNo(clientResponse) {
  const answer = unwrapClientResponse(clientResponse);
  return answer === true || (Array.isArray(answer) && answer[0] === true);
}

// What the agent says when handling an answer failed outright. Kept here so the
// caller does not have to hand-build an agentSays and accidentally send a raw label
// path as literal text.
function buildFailureConversation() {
  return saysConversation(researchRuntime.LABEL_DATACORE_INVALID_INPUT);
}

function isResearchActionID(actionID) {
  return RESEARCH_ACTION_TOKENS.has(toPositiveInteger(actionID, 0));
}

// The buttons an R&D agent shows. Before research is started the only thing on offer
// is Start Research: "To acquire missions from a research agent, you must first
// 'hire' the agent and initiate the research process."
function buildResearchIdleActions(characterID, agentRecord) {
  if (!researchRuntime.isResearchAgent(agentRecord)) {
    return null;
  }
  if (
    researchRuntime.hasActiveProject(characterID, agentRecord && agentRecord.agentID)
  ) {
    return [
      [ACTION_TOKEN_BUY_DATACORES, AGENT_DIALOGUE_BUTTON_BUY_DATACORES],
      [ACTION_TOKEN_CANCEL_RESEARCH, AGENT_DIALOGUE_BUTTON_CANCEL_RESEARCH],
    ];
  }
  return [[ACTION_TOKEN_START_RESEARCH, AGENT_DIALOGUE_BUTTON_START_RESEARCH]];
}

function buildPostActionConversation(characterID, agentRecord, agentSays) {
  return buildConversation(
    agentSays,
    buildResearchIdleActions(characterID, agentRecord) || [],
  );
}

function planStartResearch(characterID, agentRecord) {
  const refusal = researchRuntime.getStartResearchRefusal(characterID, agentRecord);
  if (refusal) {
    return {
      kind: "conversation",
      data: saysConversation(refusal, [], []),
    };
  }

  const prompt = researchRuntime.buildFieldChoicePrompt(characterID, agentRecord);
  if (!prompt) {
    return {
      kind: "conversation",
      data: saysConversation(researchRuntime.LABEL_SKILLS_NOT_SUFFICIENT, [], []),
    };
  }

  return {
    kind: "dialog",
    method: "SingleChoiceBox",
    args: [
      prompt.title,
      prompt.body,
      { type: "list", items: prompt.choices },
      toPositiveInteger(agentRecord && agentRecord.agentID, 0),
    ],
    kwargs: buildDict([]),
    resolve: (clientResponse) => {
      const index = readChoiceIndex(clientResponse);
      // Cancelled the box: nothing was hired, so the conversation just resets.
      if (index === null || index < 0 || index >= prompt.fields.length) {
        return buildPostActionConversation(
          characterID,
          agentRecord,
          researchRuntime.buildAgentSays(researchRuntime.LABEL_DATACORE_INVALID_INPUT),
        );
      }
      const started = researchRuntime.startResearch(
        characterID,
        agentRecord,
        prompt.fields[index],
      );
      return buildPostActionConversation(
        characterID,
        agentRecord,
        researchRuntime.buildAgentSays(
          started.agentSaysLabel || researchRuntime.LABEL_SKILLS_NOT_SUFFICIENT,
        ),
      );
    },
  };
}

function planCancelResearch(characterID, agentRecord, context = {}) {
  if (
    !researchRuntime.hasActiveProject(characterID, agentRecord && agentRecord.agentID)
  ) {
    return {
      kind: "conversation",
      data: buildPostActionConversation(
        characterID,
        agentRecord,
        researchRuntime.buildAgentSays(researchRuntime.LABEL_DATACORE_INVALID_INPUT),
      ),
    };
  }

  // Which of the two cancel bodies the client shows. Resolved here rather than
  // taken from the caller: the caller had no way to know, so this was always false
  // and the mission-aware warning could never appear.
  const prompt = researchRuntime.buildCancelResearchPrompt(
    context.hasOpenMission === true ||
      researchRuntime.hasAcceptedMission(characterID, agentRecord),
  );
  return {
    kind: "dialog",
    method: "YesNo",
    args: [
      prompt.title,
      prompt.body,
      toPositiveInteger(agentRecord && agentRecord.agentID, 0),
    ],
    kwargs: buildDict([]),
    resolve: (clientResponse) => {
      if (!readYesNo(clientResponse)) {
        return buildPostActionConversation(
          characterID,
          agentRecord,
          researchRuntime.buildAgentSays(researchRuntime.LABEL_DATACORE_INVALID_INPUT),
        );
      }
      const cancelled = researchRuntime.cancelResearch(characterID, agentRecord);
      return buildPostActionConversation(
        characterID,
        agentRecord,
        researchRuntime.buildAgentSays(
          cancelled.agentSaysLabel || researchRuntime.LABEL_RESEARCH_CANCELLED,
        ),
      );
    },
  };
}

function planBuyDatacores(characterID, agentRecord, context = {}) {
  const prompt = researchRuntime.buildDatacoreQuantityPrompt(characterID, agentRecord);
  if (!prompt) {
    return {
      kind: "conversation",
      data: buildPostActionConversation(
        characterID,
        agentRecord,
        researchRuntime.buildAgentSays(researchRuntime.LABEL_DATACORE_INVALID_INPUT),
      ),
    };
  }
  if (prompt.refusalLabel) {
    return {
      kind: "conversation",
      data: buildPostActionConversation(
        characterID,
        agentRecord,
        researchRuntime.buildAgentSays(prompt.refusalLabel, prompt.refusalKwargs || []),
      ),
    };
  }

  return {
    kind: "dialog",
    method: "GetQuantity",
    args: [],
    // uix.QtyPopup(maxvalue, minvalue, setvalue, hint, caption, label, digits).
    //
    // These keywords are splatted straight into QtyPopup by agents.py GetQuantity,
    // so ONLY its parameters may be sent. In particular not agentID: GetQuantity
    // reads it for localization but never pops it, so passing it raises
    // "QtyPopup() got an unexpected keyword argument 'agentID'" and the dialog never
    // opens. Localization does not need it -- these labels take no agent arguments.
    kwargs: buildDict([
      ["maxvalue", prompt.maxQuantity],
      ["minvalue", 1],
      ["setvalue", prompt.maxQuantity],
      ["caption", prompt.caption],
      ["label", prompt.label],
      ["digits", 0],
    ]),
    // Async: the ISK leg goes through the wallet authority, which may be a separate
    // process. runResearchDialogPlan awaits this.
    resolve: async (clientResponse) => {
      const quantity = readQuantity(clientResponse);
      if (!quantity) {
        return buildPostActionConversation(
          characterID,
          agentRecord,
          researchRuntime.buildAgentSays(researchRuntime.LABEL_DATACORE_INVALID_INPUT),
        );
      }
      const purchase = await researchRuntime.buyDatacores(
        characterID,
        agentRecord,
        quantity,
        context.stationID,
      );
      return buildPostActionConversation(
        characterID,
        agentRecord,
        researchRuntime.buildAgentSays(
          purchase.agentSaysLabel || researchRuntime.LABEL_DATACORE_INVALID_INPUT,
          purchase.agentSaysKwargs || [],
        ),
      );
    },
  };
}

// Returns null when the action is not a research one, so the caller falls through to
// the ordinary mission handling untouched.
function planResearchAction(characterID, agentRecord, actionID, context = {}) {
  if (!researchRuntime.isResearchAgent(agentRecord) || !isResearchActionID(actionID)) {
    return null;
  }
  const normalizedActionID = toPositiveInteger(actionID, 0);
  if (
    normalizedActionID === ACTION_TOKEN_START_RESEARCH ||
    normalizedActionID === AGENT_DIALOGUE_BUTTON_START_RESEARCH
  ) {
    return planStartResearch(characterID, agentRecord);
  }
  if (
    normalizedActionID === ACTION_TOKEN_CANCEL_RESEARCH ||
    normalizedActionID === AGENT_DIALOGUE_BUTTON_CANCEL_RESEARCH
  ) {
    return planCancelResearch(characterID, agentRecord, context);
  }
  return planBuyDatacores(characterID, agentRecord, context);
}

module.exports = {
  ACTION_TOKEN_BUY_DATACORES,
  ACTION_TOKEN_CANCEL_RESEARCH,
  ACTION_TOKEN_START_RESEARCH,
  AGENT_DIALOGUE_BUTTON_BUY_DATACORES,
  AGENT_DIALOGUE_BUTTON_CANCEL_RESEARCH,
  AGENT_DIALOGUE_BUTTON_REQUEST_MISSION,
  AGENT_DIALOGUE_BUTTON_START_RESEARCH,
  buildFailureConversation,
  buildResearchIdleActions,
  isResearchActionID,
  planResearchAction,
  readChoiceIndex,
  readQuantity,
  readYesNo,
  unwrapClientResponse,
};
