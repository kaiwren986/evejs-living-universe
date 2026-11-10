"use strict";

const path = require("path");

const sessionRegistry = require(path.join(__dirname, "../chat/sessionRegistry"));
const log = require(path.join(__dirname, "../../utils/logger"));

function toPositiveInteger(value, fallback = 0) {
  const numeric = Math.trunc(Number(value) || 0);
  return numeric > 0 ? numeric : fallback;
}

function getSessionOwnerIDs(session) {
  if (!session) {
    return [];
  }
  return [...new Set([
    toPositiveInteger(session.characterID || session.charID || session.charid, 0),
    toPositiveInteger(session.corporationID || session.corpid || session.corpID, 0),
    toPositiveInteger(session.allianceID || session.allianceid, 0),
  ].filter((ownerID) => ownerID > 0))];
}

function sessionMatchesOwner(session, ownerID) {
  const numericOwnerID = toPositiveInteger(ownerID, 0);
  return numericOwnerID > 0 && getSessionOwnerIDs(session).includes(numericOwnerID);
}

function getOwnerSessions(ownerID, options = {}) {
  const numericOwnerID = toPositiveInteger(ownerID, 0);
  if (!numericOwnerID) {
    return [];
  }

  const sessions = [];
  const seen = new Set();
  const addSession = (session) => {
    if (
      !session ||
      seen.has(session) ||
      (session.socket && session.socket.destroyed) ||
      typeof session.sendNotification !== "function" ||
      !sessionMatchesOwner(session, numericOwnerID)
    ) {
      return;
    }
    seen.add(session);
    sessions.push(session);
  };

  for (const session of sessionRegistry.getSessions()) {
    addSession(session);
  }
  for (const session of Array.isArray(options.extraSessions) ? options.extraSessions : []) {
    addSession(session);
  }
  return sessions;
}

function sendOwnerEvent(ownerID, eventName, payload, options = {}) {
  let delivered = 0;
  for (const session of getOwnerSessions(ownerID, options)) {
    try {
      session.sendNotification(eventName, "clientID", Array.isArray(payload) ? payload : []);
      delivered += 1;
    } catch (error) {
      log.warn(
        `[ContractNotifications] ${eventName} delivery failed owner=${toPositiveInteger(ownerID, 0)}: ${error.message}`,
      );
    }
  }
  return delivered;
}

function getContractID(contract) {
  return toPositiveInteger(contract && contract.contractID, 0);
}

function notifyContractCreated(contract, sourceSession = null) {
  return sendOwnerEvent(
    contract && contract.issuerID,
    "OnContractCreated",
    [],
    { extraSessions: [sourceSession] },
  );
}

function notifyContractAssigned(contract, sourceSession = null) {
  const contractID = getContractID(contract);
  const assigneeID = toPositiveInteger(contract && contract.assigneeID, 0);
  if (!contractID || !assigneeID) {
    return 0;
  }
  return sendOwnerEvent(
    assigneeID,
    "OnContractAssigned",
    [contractID],
    { extraSessions: [sourceSession] },
  );
}

function notifyContractAccepted(contract, sourceSession = null) {
  const contractID = getContractID(contract);
  if (!contractID) {
    return 0;
  }
  return sendOwnerEvent(
    contract && contract.issuerID,
    "OnContractAccepted",
    [contractID],
    { extraSessions: [sourceSession] },
  );
}

function notifyContractCompleted(contract, sourceSession = null) {
  const contractID = getContractID(contract);
  if (!contractID) {
    return 0;
  }
  return sendOwnerEvent(
    contract && contract.issuerID,
    "OnContractCompleted",
    [contractID],
    { extraSessions: [sourceSession] },
  );
}

function notifyContractOutbid(contract, previousBidderID, sourceSession = null) {
  return sendOwnerEvent(previousBidderID, "OnContractOutbid", [getContractID(contract)], { extraSessions: [sourceSession] });
}

function notifyContractBuyout(contract, sourceSession = null) {
  return sendOwnerEvent(contract && (contract.forCorp ? contract.issuerCorpID : contract.issuerID), "OnContractBuyout", [getContractID(contract)], { extraSessions: [sourceSession] });
}

function notifyContractRejected(contract, sourceSession = null) {
  const contractID = getContractID(contract);
  if (!contractID) {
    return 0;
  }
  return sendOwnerEvent(
    contract && contract.issuerID,
    "OnContractRejected",
    [contractID],
    { extraSessions: [sourceSession] },
  );
}

function notifyContractFailed(contract, actorSide, sourceSession = null) {
  const contractID = getContractID(contract);
  if (!contractID || !["acceptor", "issuer"].includes(actorSide)) {
    return 0;
  }
  const recipientID = actorSide === "issuer"
    ? toPositiveInteger(contract && contract.acceptorID, 0)
    : toPositiveInteger(contract && contract.issuerID, 0);
  return sendOwnerEvent(
    recipientID,
    "OnContractFailed",
    [contractID],
    { extraSessions: [sourceSession] },
  );
}

module.exports = {
  notifyContractOutbid,
  notifyContractBuyout,
  notifyContractAccepted,
  notifyContractAssigned,
  notifyContractCompleted,
  notifyContractCreated,
  notifyContractFailed,
  notifyContractRejected,
};
