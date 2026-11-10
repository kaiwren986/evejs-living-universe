"use strict";

// The wire end of a Destiny tick's doPostTick: the batches the one stamped list
// built (destiny/batching/destinyHistory.js takeBatches), sent in retail's
// order, character singlecasts then bubble narrowcasts
// (_parkupdatebatcher.py:55-125). Every Destiny update Server sends leaves
// here.
//
// The wire tuple is (state, waitForBubble): retail's server also sends
// ClientUpdateCountThisTick, which its network layer consumes before Python;
// Server has no such layer, and the client would read a third element as
// dogmaMessages, so the count stays planner metadata. A character batch
// carries a third element only when it has Dogma messages to deliver; a
// bubble batch never does. An Observer with Dogma messages and no
// character batch gets them as one OnMultiEvent, sent here after the batches:
// no Dogma event leaves anywhere else.
//
// A Grid bubble's batch is one object, encoded once and sent to each of its
// Observers (clientSession.js encodeNotificationPayload and
// sendEncodedNotification); the per-session envelope is all that differs. It
// carries no Dogma, so nothing in it is converted per recipient.
//
// A Character batch's Dogma part and a direct OnMultiEvent have one
// recipient: each passes once through Client session's
// toWireNotificationPayload("OnMultiEvent", ...) with that recipient's
// reader, so its attribute changes go out in the client's wire types, before
// the one encode. The
// tuple handed to the session for its logs is the one given, unconverted.
//
// A send that throws is logged, and the other sessions still get theirs.
// A session that missed a batch (its send threw, or the batch could not be
// encoded) is reported back: its client no longer has what the server
// thinks it has, and the scene gives it a fresh SetState.
//
// The sync ledger and the spatial trace record each batch, behind the
// diagnostics gate.

const path = require("path");
const log = require(path.join(__dirname, "../../../utils/logger"));
// The network session class, loaded on first send (it pulls in the store).
let ClientSession = null;
function encodeNotificationPayload(tuple) {
  ClientSession = ClientSession || require(path.join(__dirname, "../../../network/clientSession"));
  return ClientSession.encodeNotificationPayload(tuple);
}
const {
  toWireNotificationPayload,
} = require(path.join(__dirname, "../../../network/attributeChangeWireValues"));
const {
  isLedgerFileEnabled,
  recordSyncLedgerEvent,
  summarizeDestinyUpdates,
} = require(path.join(__dirname, "../../../network/syncLedger"));
const spatialTrace = require(path.join(__dirname, "../../../network/spatialTrace"));
const {
  buildDestinyUpdatePayload,
} = require(path.join(__dirname, "../stream/statePayloads"));
const {
  extractPayloadEntityIDs,
} = require(path.join(__dirname, "../protocol/payloadIdentity"));
const {
  buildOnMultiEventPayloadFromPairs,
} = require(path.join(__dirname, "../../../services/_shared/godmaMultiEvent"));

const {
  DESTINY_NOTIFICATION_ID_TYPE,
  DESTINY_NOTIFICATION_NAME,
} = require(path.join(__dirname, "../delivery/michelleContract"));

function logFailedSend(what, session, error) {
  const characterID = session ? session.characterID ?? session.charid ?? null : null;
  const clientID = session ? session.clientID ?? null : null;
  log.warn(
    `[DestinyBatch] ${what} to char=${characterID} client=${clientID} failed: ` +
    `${error && error.stack ? error.stack : error}`,
  );
}

// `payload` (a Character batch's Dogma part, or an OnMultiEvent tuple) as
// `session`'s client reads it: each attribute change's values in their wire
// types, with `session`'s own reader for the character's own five.
// A copy; `payload` is kept.
function toSessionWire(session, payload) {
  const readOwnAttributes = typeof session.readOwnCharacterAttributes === "function"
    ? () => session.readOwnCharacterAttributes()
    : null;
  return toWireNotificationPayload("OnMultiEvent", payload, { readOwnAttributes });
}

// Sends one `notifyType` notification to `session`: encoded by `encode()`,
// called only when the session takes encoded payloads, else as `tuple`
// through sendNotification. `tuple` is the payload as given, for the
// session's logs. True once sent.
function sendNotice(session, notifyType, encode, tuple) {
  if (typeof session.sendEncodedNotification === "function") {
    session.sendEncodedNotification(notifyType, DESTINY_NOTIFICATION_ID_TYPE, encode(), tuple);
  } else if (typeof session.sendNotification === "function") {
    session.sendNotification(notifyType, DESTINY_NOTIFICATION_ID_TYPE, tuple);
  } else {
    return false;
  }
  return true;
}

// One Destiny batch, already encoded, to one session, a throw logged rather
// than passed on.
function trySendEncoded(session, encoded, tuple) {
  try {
    return sendNotice(session, DESTINY_NOTIFICATION_NAME, () => encoded, tuple);
  } catch (error) {
    logFailedSend("Destiny batch", session, error);
    return false;
  }
}

// One Observer's Dogma events when it has no character batch: one
// OnMultiEvent, the (event, time) pairs godma.OnMultiEvent reads
// (godma.py:206-252), converted for `session` before its one encode. A send
// that throws is logged and counts as not sent.
function sendDogmaMultiEvent(session, events) {
  if (!session || !Array.isArray(events) || events.length === 0) {
    return false;
  }
  try {
    const tuple = buildOnMultiEventPayloadFromPairs(events);
    return sendNotice(
      session,
      "OnMultiEvent",
      () => encodeNotificationPayload(toSessionWire(session, tuple)),
      tuple,
    );
  } catch (error) {
    logFailedSend("OnMultiEvent", session, error);
    return false;
  }
}

function recordBatch(scene, delivery, details) {
  if (isLedgerFileEnabled()) {
    for (const session of delivery.sessions) {
      recordSyncLedgerEvent(session, "destiny.batch.sent", {
        kind: "destiny",
        batch: delivery.kind,
        // Retail's ClientUpdateCountThisTick (ONE or TWO): this Observer's
        // DoDestinyUpdates this tick. For the ledger only, never sent.
        clientUpdateCountThisTick: details.characterSessions.has(session) &&
          (delivery.kind === "bubble" || delivery.waitForBubble === true)
          ? 2
          : 1,
        stamp: details.stamp,
        bubbleID: delivery.bubble === undefined ? null : delivery.bubble,
        waitForBubble: delivery.waitForBubble,
        recipients: delivery.sessions.length,
        dogmaMessageCount: Array.isArray(delivery.dogma) ? delivery.dogma.length : 0,
        updates: summarizeDestinyUpdates(details.updates),
      });
    }
  }
  if (spatialTrace.isEnabled()) {
    spatialTrace.recordDestinyBatch(scene, {
      batch: delivery.kind,
      bubbleID: delivery.bubble,
      sessions: delivery.sessions,
      waitForBubble: delivery.waitForBubble,
      destinyStamp: details.stamp,
      simulationTimeMs: scene && typeof scene.getCurrentSimTimeMs === "function"
        ? scene.getCurrentSimTimeMs()
        : null,
      actionCount: details.updates.length,
      encodedByteLength: details.encoded.length,
      entityIds: details.updates.flatMap((update) => extractPayloadEntityIDs(update.payload)),
    });
  }
}

// Sends `deliveries` (takeBatches' order) for Destiny tick `stamp`, then
// `multiEvents` (takeBatches' [{ session, events }]). Returns { batches,
// encodes, sends, multiEvents, failedSessions }; `sends` counts the sends
// that went out, `failedSessions` the sessions that missed a batch.
//
// A Character batch goes to its one Observer, its Dogma part converted for
// that Observer before the encode. A Grid bubble batch goes, as the same
// bytes, to each of its Observers.
function deliverDestinyBatches(scene, deliveries, stamp, multiEvents = []) {
  const result = { batches: 0, encodes: 0, sends: 0, multiEvents: 0, failedSessions: [] };
  const failed = new Set();
  const characterSessions = new Set(deliveries
    .filter((delivery) => delivery.kind === "character")
    .flatMap((delivery) => delivery.sessions));
  for (const delivery of deliveries) {
    const sessions = delivery.sessions.filter(Boolean);
    if (sessions.length === 0 || delivery.state.length === 0) {
      continue;
    }
    const isCharacter = delivery.kind === "character";
    const recipients = isCharacter ? [sessions[0]] : sessions;
    const updates = delivery.state.map(([entryStamp, payload]) => ({ stamp: entryStamp, payload }));
    const waitForBubble = delivery.waitForBubble === true;
    const dogma = isCharacter && Array.isArray(delivery.dogma) && delivery.dogma.length > 0
      ? delivery.dogma
      : null;
    let tuple;
    let encoded;
    try {
      tuple = buildDestinyUpdatePayload(updates, waitForBubble, dogma);
      encoded = encodeNotificationPayload(dogma
        ? buildDestinyUpdatePayload(updates, waitForBubble, toSessionWire(recipients[0], dogma))
        : tuple);
    } catch (error) {
      logFailedSend(
        isCharacter ? "Character batch" : `Grid bubble ${delivery.bubble} batch`,
        isCharacter ? recipients[0] : null,
        error,
      );
      for (const session of recipients) {
        failed.add(session);
      }
      continue;
    }
    result.batches += 1;
    result.encodes += 1;
    recordBatch(scene, { ...delivery, sessions: recipients }, { stamp, updates, encoded, characterSessions });
    for (const session of recipients) {
      if (trySendEncoded(session, encoded, tuple)) {
        result.sends += 1;
      } else {
        failed.add(session);
      }
    }
  }
  for (const entry of Array.isArray(multiEvents) ? multiEvents : []) {
    if (entry && sendDogmaMultiEvent(entry.session, entry.events)) {
      result.multiEvents += 1;
    }
  }
  result.failedSessions = [...failed];
  return result;
}

module.exports = {
  deliverDestinyBatches,
  sendDogmaMultiEvent,
};
