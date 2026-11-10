"use strict";

const {
  toInt,
} = require("../../common/numbers");

const path = require("path");

const {
  buildDict,
  buildKeyVal,
  buildList,
  extractDictEntries,
  unwrapMarshalValue,
} = require(path.join(__dirname, "../_shared/serviceHelpers"));
const sessionRegistry = require(path.join(__dirname, "../chat/sessionRegistry"));
const {
  OWNER_SCOPE,
  canSessionAccessOwner,
  throwFittingError,
} = require(path.join(__dirname, "../../_secondary/fitting/fittingStore"));

function extractKwargValue(kwargs, key) {
  for (const [entryKey, entryValue] of extractDictEntries(kwargs)) {
    // String(entryKey) resolves a Buffer key only because Buffer.toString defaults to
    // utf8, and yields "[object Object]" for the {type, value} forms the decoder also
    // produces. See the note on accountService.extractKwarg.
    if (unwrapMarshalValue(entryKey) === String(key)) {
      return unwrapMarshalValue(entryValue);
    }
  }

  if (
    kwargs &&
    typeof kwargs === "object" &&
    Object.prototype.hasOwnProperty.call(kwargs, key)
  ) {
    return unwrapMarshalValue(kwargs[key]);
  }

  return undefined;
}

function getSessionOwnerID(session, ownerScope) {
  switch (ownerScope) {
    case OWNER_SCOPE.CORPORATION:
      return toInt(session && (session.corpid || session.corporationID), 0);
    case OWNER_SCOPE.ALLIANCE:
      return toInt(session && (session.allianceid || session.allianceID), 0);
    case OWNER_SCOPE.CHARACTER:
    default:
      return toInt(session && (session.characterID || session.charid), 0);
  }
}

function resolveRequestedOwnerID(args, session, ownerScope) {
  const requestedOwnerID = toInt(args && args[0], 0);
  return requestedOwnerID > 0
    ? requestedOwnerID
    : getSessionOwnerID(session, ownerScope);
}

function buildSaveManyResult(mappings = []) {
  return buildList(
    (Array.isArray(mappings) ? mappings : []).map((mapping) =>
      buildKeyVal([
        ["tempFittingID", toInt(mapping && mapping.tempFittingID, 0)],
        ["realFittingID", toInt(mapping && mapping.realFittingID, 0)],
      ]),
    ),
  );
}

function buildDeletedResult(fittingIDs = []) {
  return buildList(
    (Array.isArray(fittingIDs) ? fittingIDs : []).map((fittingID) => toInt(fittingID, 0)),
  );
}

function handleStoreResult(result, onSuccess = (data) => data) {
  if (!result || result.success !== true) {
    throwFittingError(result && result.errorMsg, result && result.values);
  }

  return typeof onSuccess === "function" ? onSuccess(result.data) : result.data;
}

// Owner scopes whose GetFittings is answered with a CachedMethodCallResult, and
// the client-side cache key to drop when one of their fittings changes.
//
// The client keeps two layers of fitting state and OnFittingAdded reaches only
// one of them: fittingSvc.OnFittingAdded clears fittings[ownerID], but the
// refetch that follows is answered from objectCaching.cachedMethodCalls with no
// request on the wire for the whole version-check window. fittingSvc can drop
// that second layer for exactly one method -- ClearCommunityFittingCache calls
// InvalidateCachedMethodCall('corpFittingMgr', 'GetCommunityFittings') -- and has
// no equivalent for GetFittings, so the server drops it instead, over the
// ROLE_SERVICE call the client exports for this purpose.
const CACHED_FITTING_LIST_METHODS = new Map([
  [OWNER_SCOPE.CORPORATION, { serviceName: "corpFittingMgr", method: "GetFittings" }],
]);

function invalidateClientFittingListCache(recipient, ownerScope, ownerID) {
  const target = CACHED_FITTING_LIST_METHODS.get(ownerScope);
  if (!target || toInt(ownerID, 0) <= 0) {
    return false;
  }
  if (!recipient || typeof recipient.sendClientCallRequest !== "function") {
    return false;
  }
  // Same argument shape the client cached under: GetFittings(ownerID).
  return recipient.sendClientCallRequest(
    "objectCaching",
    "InvalidateCachedMethodCall",
    [target.serviceName, target.method, toInt(ownerID, 0)],
    buildDict([["machoVersion", 1]]),
  ) !== null;
}

function notifyFittingMutation(session, notificationName, payload = [], options = {}) {
  if (!notificationName) {
    return 0;
  }
  const normalizedPayload = Array.isArray(payload) ? payload : [payload];
  const ownerScope = options && options.ownerScope;
  const ownerID = toInt(normalizedPayload[0], 0);
  const recipients = new Set();

  if (ownerScope && ownerID > 0) {
    for (const candidateSession of sessionRegistry.getSessions()) {
      if (
        canSessionAccessOwner(candidateSession, ownerID, ownerScope) &&
        typeof candidateSession.sendNotification === "function"
      ) {
        recipients.add(candidateSession);
      }
    }
  }

  if (session && typeof session.sendNotification === "function") {
    recipients.add(session);
  }

  // TQ parity: fitting-mutation notifications (OnFittingAdded/Deleted/Renamed)
  // are broadcast with idtype "charid", not "clientID".
  let sentCount = 0;
  for (const recipient of recipients) {
    // Before the notification: the notification is what makes the client refetch,
    // so the invalidation has to already be in the stream ahead of it.
    invalidateClientFittingListCache(recipient, ownerScope, ownerID);
    recipient.sendNotification(notificationName, "charid", normalizedPayload);
    sentCount += 1;
  }
  return sentCount;
}

module.exports = {
  buildDeletedResult,
  buildSaveManyResult,
  extractKwargValue,
  getSessionOwnerID,
  handleStoreResult,
  notifyFittingMutation,
  resolveRequestedOwnerID,
};
