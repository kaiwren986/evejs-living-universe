"use strict";

const { buildDict, buildList } = require("../_shared/serviceHelpers");
const { resolveSessionCharacterID } = require("../_shared/sessionIdentity");
const sessionRegistry = require("../chat/sessionRegistry");

const CUSTOMS_CONFIRMATION_MESSAGE_ID = "ChtCustomsConfiscationConfirmation2";
const CUSTOMS_NOTIFICATION_TYPE_ID = 33;
const NPC_STANDINGS_LOST_NOTIFICATION_TYPE_ID = 3001;

// Client-call correlation is transport state, not case authority. Durable case
// decisions, scene validation and deadlines belong to customsInspectionRuntime.
const pendingBySession = new WeakMap();

function promptError(code, reason = code) {
  const error = new Error(String(reason));
  error.code = code;
  return error;
}

function getLostList(record) {
  return Array.isArray(record && record.lostList) ? record.lostList : [];
}

function buildConfiscationDialogArguments(record) {
  // The client's cfg.__prepdict converts each tuple (formatType, value, value2)
  // through FormatConvert: UE_LIST (103), UE_TYPEIDANDQUANTITY (24) and
  // UE_OWNERID (2). A plain JS array marshals as a tuple, which is what those
  // typed values must be. But FormatConvert treats a typed value whose value
  // is itself a tuple as one nested typed value, so the entries of the UE_LIST
  // value must be a Python list (buildList), never a plain array.
  return [
    CUSTOMS_CONFIRMATION_MESSAGE_ID,
    buildDict([
      ["contraband", [103, buildList(getLostList(record).map((entry) => [
        24,
        Number(entry.typeID),
        Number(entry.quantity),
      ])), "<br>"]],
      ["empire", [2, Number(record.factionID)]],
    ]),
  ];
}

function buildCustomsNotificationData(record) {
  const division = Number(record.standingDivision);
  return {
    securityLevel: Number(record.securityLevel),
    shouldAttack: record.shouldAttack === true ? 1 : null,
    standingDivision: Number.isFinite(division) && division > 0 ? division : 5.0,
    shouldConfiscate: record.shouldConfiscate === true ? 1 : null,
    factionID: Number(record.factionID),
    solarSystemID: Number(record.systemID),
    lostList: getLostList(record).map((entry) => ({
      penalty: Number(entry.penalty) || 0,
      typeID: Number(entry.typeID),
      fine: Number(entry.fine) || 0,
      quantity: Number(entry.quantity) || 0,
    })),
  };
}

function buildNpcStandingsLostData(standingResult) {
  const result = standingResult && standingResult.data || standingResult;
  return (result && result.appliedChanges || []).map((entry) => [
    Number(entry.fromID),
    Number(entry.toID),
    Number(entry.rawChange),
    -1.0,
    1.0,
    Number(entry.standing),
  ]);
}

function getCharacterSession(characterID) {
  return sessionRegistry.findSessionByCharacterID(Number(characterID)) || null;
}

function isOwningSession(session, record) {
  const characterID = Number(record && record.characterID);
  return Number.isSafeInteger(characterID) && characterID > 0 &&
    resolveSessionCharacterID(session) === characterID;
}

function sendCustomsRemoteMessage(record, messageID, session = null) {
  const recipient = session || getCharacterSession(record.characterID);
  if (!isOwningSession(recipient, record) || !recipient.socket ||
      recipient.socket.destroyed || typeof recipient.sendNotification !== "function") {
    return false;
  }
  recipient.sendNotification("OnRemoteMessage", "clientID", [
    String(messageID),
    buildDict([
      ["owner", Number(record.characterID)],
      ["faction", [2, Number(record.factionID)]],
    ]),
  ]);
  return true;
}

/**
 * Ask through the native exported XmppChat service. It returns a boolean, not
 * an ID_YES integer. The owning case runtime must persist/revalidate the answer
 * and cancel this call when its durable deadline or scene lifetime ends.
 */
function promptCase(session, record) {
  if (!isOwningSession(session, record)) {
    return Promise.reject(promptError("CUSTOMS_PROMPT_NOT_OWNER"));
  }
  const caseID = String(record && record.caseID || "").trim();
  if (!caseID) {
    return Promise.reject(promptError("CUSTOMS_PROMPT_CASE_REQUIRED"));
  }
  if (!session.socket || session.socket.destroyed ||
      typeof session.sendClientCallRequest !== "function") {
    return Promise.reject(promptError("CUSTOMS_PROMPT_UNAVAILABLE"));
  }
  let pending = pendingBySession.get(session);
  if (!pending) {
    pending = new Map();
    pendingBySession.set(session, pending);
  }
  if (pending.has(caseID)) {
    return pending.get(caseID).promise;
  }

  let resolveAnswer;
  let rejectAnswer;
  const promise = new Promise((resolve, reject) => {
    resolveAnswer = resolve;
    rejectAnswer = reject;
  });
  const entry = { promise, callID: null, settled: false, cancel: null };
  pending.set(caseID, entry);
  const settle = (error, answer) => {
    if (entry.settled) {
      return;
    }
    entry.settled = true;
    pending.delete(caseID);
    if (entry.callID !== null && session._pendingClientCallRequests) {
      session._pendingClientCallRequests.delete(entry.callID);
    }
    if (error) rejectAnswer(error);
    else resolveAnswer(answer);
  };
  entry.cancel = (reason) => settle(promptError("CUSTOMS_PROMPT_CANCELLED", reason));

  try {
    entry.callID = session.sendClientCallRequest(
      "XmppChat",
      "AskYesNoQuestion",
      buildConfiscationDialogArguments(record),
      buildDict([["machoVersion", 1]]),
      {
        machoTimeout: Number(record.configSnapshot && record.configSnapshot.promptTimeoutSeconds) || 30,
        onResponse(response) {
          if (!isOwningSession(session, record)) {
            settle(promptError("CUSTOMS_PROMPT_NOT_OWNER"));
          } else if (!response || typeof response.response !== "boolean") {
            settle(promptError("CUSTOMS_PROMPT_INVALID_ANSWER"));
          } else {
            settle(null, response.response);
          }
        },
      },
    );
    if (entry.callID === null) {
      settle(promptError("CUSTOMS_PROMPT_UNAVAILABLE"));
    }
  } catch (error) {
    settle(error);
  }
  return promise;
}

function cancelCasePrompt(session, caseID, reason = "case-ended") {
  const pending = session && pendingBySession.get(session);
  const entry = pending && pending.get(String(caseID));
  if (!entry) {
    return false;
  }
  entry.cancel(reason);
  return true;
}

module.exports = {
  CUSTOMS_CONFIRMATION_MESSAGE_ID,
  CUSTOMS_NOTIFICATION_TYPE_ID,
  NPC_STANDINGS_LOST_NOTIFICATION_TYPE_ID,
  buildConfiscationDialogArguments,
  buildCustomsNotificationData,
  buildNpcStandingsLostData,
  getCharacterSession,
  sendCustomsRemoteMessage,
  promptCase,
  cancelCasePrompt,
};
