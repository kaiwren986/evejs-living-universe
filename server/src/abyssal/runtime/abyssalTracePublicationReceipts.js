"use strict";

// Receipts proving an Abyssal filament trace was actually published to a specific
// client, on a specific ship, in a specific scene.
//
// WHY RECEIPTS EXIST
//
// A trace is a physical object the client must have received via AddBalls before
// the server may treat it as visible. If the session changed underneath - the
// pilot reshipped, jumped, relogged, or the scene was rebuilt - the old
// publication is void and the trace has to be re-sent. A receipt captures enough
// session identity to detect exactly that.
//
// The identity comparison is therefore deliberately strict: client, character,
// ship, system must all match. The only field allowed to be absent is sceneKey,
// because receipts written before a scene key existed must still validate.
//
// PURITY: this module holds no state of its own. Receipts live on the caller's
// session object (session._space.abyssalTracePublicationReceiptsByID), so the
// module imports nothing and stays outside the space/runtime <-> abyssal cycle.

const RECEIPT_MAP_KEY = "abyssalTracePublicationReceiptsByID";

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function readSceneKey(session) {
  return String(
    session && session._space && session._space.sceneKey ||
    session && session.spaceSceneKey ||
    "",
  );
}

// The identity a receipt is validated against. Every field here is part of the
// "is this publication still valid?" question - adding a field makes receipts
// stricter, removing one makes them staler.
function buildAbyssalTraceSessionIdentity(session) {
  return {
    clientID: toInt(session && (session.clientID ?? session.clientId), 0),
    characterID: toInt(session && session.characterID, 0),
    shipID: toInt(session && session._space && session._space.shipID, 0),
    systemID: toInt(session && session._space && session._space.systemID, 0),
    sceneKey: readSceneKey(session),
  };
}

// Receipts hang off the live session rather than a module-level map so they die
// with the session and cannot leak across logins.
function getAbyssalTracePublicationReceiptMap(session, create = false) {
  if (!session || !session._space) {
    return null;
  }
  if (session._space[RECEIPT_MAP_KEY] instanceof Map) {
    return session._space[RECEIPT_MAP_KEY];
  }
  if (!create) {
    return null;
  }
  const receipts = new Map();
  session._space[RECEIPT_MAP_KEY] = receipts;
  return receipts;
}

function getAbyssalTracePublicationReceipt(session, traceItemID) {
  const receipts = getAbyssalTracePublicationReceiptMap(session, false);
  return receipts ? receipts.get(toInt(traceItemID, 0)) || null : null;
}

function buildAbyssalTracePublicationReceipt(
  traceItemID,
  session,
  addBallsStamp,
  queuedAt,
  writtenAt,
  status = "complete",
) {
  const numericTraceItemID = toInt(traceItemID, 0);
  // Destiny stamps are unsigned 32-bit on the wire; coerce so a receipt written
  // from a signed value still compares equal to one read back off the client.
  const numericStamp = toInt(addBallsStamp, 0) >>> 0;
  const sessionIdentity = buildAbyssalTraceSessionIdentity(session);
  return {
    traceID: numericTraceItemID,
    // Both spellings are emitted because call sites read either.
    traceItemID: numericTraceItemID,
    sessionIdentity,
    destinationNodeOrClientID: sessionIdentity.clientID,
    addBallsStamp: numericStamp,
    queuedAt: toInt(queuedAt, 0),
    writtenAt: toInt(writtenAt, 0),
    publicationToken: `${numericTraceItemID}:${sessionIdentity.clientID}:${numericStamp}`,
    status,
  };
}

function storeAbyssalTracePublicationReceipt(session, receipt) {
  const traceItemID = toInt(receipt && (receipt.traceID ?? receipt.traceItemID), 0);
  const receipts = getAbyssalTracePublicationReceiptMap(session, true);
  if (!receipts || traceItemID <= 0) {
    return null;
  }
  const storedReceipt = { ...receipt, traceID: traceItemID, traceItemID };
  receipts.set(traceItemID, storedReceipt);
  return storedReceipt;
}

// A receipt only counts if it completed AND every identity field still matches.
// An incomplete receipt is never a match - a queued-but-unwritten publication
// must not suppress a re-send.
function abyssalTracePublicationReceiptMatchesSession(receipt, session) {
  if (!receipt || receipt.status !== "complete" || !session || !session._space) {
    return false;
  }
  const expected = receipt.sessionIdentity || {};
  const current = buildAbyssalTraceSessionIdentity(session);
  const expectedSceneKey = String(expected.sceneKey || "");
  return (
    toInt(expected.clientID, 0) > 0 &&
    toInt(expected.clientID, 0) === current.clientID &&
    toInt(expected.characterID, 0) === current.characterID &&
    toInt(expected.shipID, 0) === current.shipID &&
    toInt(expected.systemID, 0) === current.systemID &&
    // Only sceneKey tolerates absence, so receipts written before scene keys
    // existed still validate. Every other field must match exactly.
    (!expectedSceneKey || expectedSceneKey === current.sceneKey)
  );
}

module.exports = {
  RECEIPT_MAP_KEY,
  buildAbyssalTraceSessionIdentity,
  getAbyssalTracePublicationReceiptMap,
  getAbyssalTracePublicationReceipt,
  buildAbyssalTracePublicationReceipt,
  storeAbyssalTracePublicationReceipt,
  abyssalTracePublicationReceiptMatchesSession,
};
