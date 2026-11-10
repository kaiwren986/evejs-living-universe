"use strict";

const path = require("path");
const { isDeepStrictEqual } = require("node:util");

// Phase 0 / 0.C pilot: this domain reaches gameStore through an ownership-scoped
// repository instead of the raw store. In strict mode a write to any table this
// service does not own throws immediately; it owns only `notifications`. Reads
// (incl. the cross-domain `characters` read) pass through unrestricted.
const {
  createTableRepository,
} = require(path.join(__dirname, "../../gameStore/tableRepository"));
const repo = createTableRepository("service:notifications", { strict: true });
const sessionRegistry = require(path.join(__dirname, "../chat/sessionRegistry"));
const {
  buildDbRowset,
  buildDict,
  buildFiletimeLong,
  buildKeyVal,
  buildList,
  buildMarshalReal,
  normalizeNumber,
  normalizeText,
} = require(path.join(__dirname, "../_shared/serviceHelpers"));
const {
  NOTIFICATION_TYPE,
} = require(path.join(__dirname, "./notificationConstants"));
const { notificationDataYaml } = require(path.join(__dirname, "./notificationYaml"));

const NOTIFICATIONS_TABLE = "notifications";

function currentFileTimeString() {
  return (BigInt(Date.now()) * 10000n + 116444736000000000n).toString();
}

function toPositiveInteger(value, fallback = 0) {
  const numericValue = Math.trunc(normalizeNumber(value, fallback));
  return numericValue > 0 ? numericValue : fallback;
}

function cloneValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function createDefaultState() {
  return {
    _meta: {
      nextNotificationID: 1,
    },
    boxes: {},
  };
}

function normalizeNotificationData(value) {
  if (value === undefined || value === null) {
    return {};
  }

  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => normalizeNotificationData(entry));
  }

  if (value && typeof value === "object") {
    return cloneValue(value);
  }

  return String(value);
}

function ensureNotificationShape(record, notificationID, receiverID) {
  if (!record || typeof record !== "object") {
    return null;
  }

  const normalizedNotificationID = toPositiveInteger(
    record.notificationID || notificationID,
    0,
  );
  const normalizedReceiverID = toPositiveInteger(
    record.receiverID || receiverID,
    0,
  );
  if (normalizedNotificationID <= 0 || normalizedReceiverID <= 0) {
    return null;
  }

  record.notificationID = normalizedNotificationID;
  record.typeID = toPositiveInteger(record.typeID, 0);
  record.senderID = Math.trunc(normalizeNumber(record.senderID, 0));
  record.receiverID = normalizedReceiverID;
  record.processed = record.processed === true;
  record.created = normalizeText(record.created, "") || currentFileTimeString();
  record.groupID =
    record.groupID == null ? null : toPositiveInteger(record.groupID, 0) || null;
  const idempotencyKey = normalizeText(record.idempotencyKey, "").trim();
  if (idempotencyKey) {
    record.idempotencyKey = idempotencyKey;
  } else {
    delete record.idempotencyKey;
  }
  record.data = normalizeNotificationData(record.data);
  return record;
}

function ensureNotificationBox(state, characterID) {
  const key = String(toPositiveInteger(characterID, 0));
  if (!state.boxes[key] || typeof state.boxes[key] !== "object") {
    state.boxes[key] = {
      byID: {},
      order: [],
    };
  }

  const box = state.boxes[key];
  if (!box.byID || typeof box.byID !== "object") {
    box.byID = {};
  }
  if (!Array.isArray(box.order)) {
    box.order = [];
  }

  // A new-mail notification (notificationTypeNewMailFrom) is the client's own: its mail service makes it from the
  // OnMailSent it is sent (mailSvc.py OnMailSent, 1119 to 1153, OnNewMailReceived and GetMailNotification, 1197 to
  // 1219: notificationID 123, its data the mail's KeyVal, which the notification center reads by attribute,
  // notificationEntry.py data['msg'].read and .messageID), and one that came while the pilot was away is told by
  // its own mail summary at the login (GetMailPopupOnCharacterLogin, 1227 to 1233). The server keeps none; those an
  // older EveJS kept are let go here.
  for (const [notificationID, record] of Object.entries(box.byID)) {
    if (record && toPositiveInteger(record.typeID, 0) === NOTIFICATION_TYPE.NEW_MAIL_FROM) {
      delete box.byID[notificationID];
    }
  }

  const dedupedOrder = [];
  const seenIDs = new Set();
  for (const notificationID of box.order) {
    const numericNotificationID = toPositiveInteger(notificationID, 0);
    if (!numericNotificationID || seenIDs.has(numericNotificationID)) {
      continue;
    }
    const normalizedRecord = ensureNotificationShape(
      box.byID[String(numericNotificationID)],
      numericNotificationID,
      key,
    );
    if (!normalizedRecord) {
      delete box.byID[String(numericNotificationID)];
      continue;
    }
    box.byID[String(numericNotificationID)] = normalizedRecord;
    dedupedOrder.push(numericNotificationID);
    seenIDs.add(numericNotificationID);
  }

  for (const [notificationID, record] of Object.entries(box.byID)) {
    const normalizedRecord = ensureNotificationShape(record, notificationID, key);
    if (!normalizedRecord) {
      delete box.byID[notificationID];
      continue;
    }
    const numericNotificationID = normalizedRecord.notificationID;
    box.byID[String(numericNotificationID)] = normalizedRecord;
    if (!seenIDs.has(numericNotificationID)) {
      dedupedOrder.push(numericNotificationID);
      seenIDs.add(numericNotificationID);
    }
  }

  dedupedOrder.sort((left, right) => right - left);
  box.order = dedupedOrder;
  return box;
}

function getMutableState() {
  const result = repo.read(NOTIFICATIONS_TABLE, "/");
  let state =
    result.success && result.data && typeof result.data === "object"
      ? result.data
      : null;

  if (!state) {
    state = createDefaultState();
    repo.write(NOTIFICATIONS_TABLE, "/", state);
    return state;
  }

  let mutated = false;
  if (!state._meta || typeof state._meta !== "object") {
    state._meta = { nextNotificationID: 1 };
    mutated = true;
  }
  const nextNotificationID = toPositiveInteger(state._meta.nextNotificationID, 1);
  if (nextNotificationID !== state._meta.nextNotificationID) {
    state._meta.nextNotificationID = nextNotificationID;
    mutated = true;
  }
  if (!state.boxes || typeof state.boxes !== "object") {
    state.boxes = {};
    mutated = true;
  }

  for (const characterID of Object.keys(state.boxes)) {
    const before = JSON.stringify(state.boxes[characterID]);
    ensureNotificationBox(state, characterID);
    if (JSON.stringify(state.boxes[characterID]) !== before) {
      mutated = true;
    }
  }

  if (mutated) {
    repo.write(NOTIFICATIONS_TABLE, "/", state);
  }
  return state;
}

function persistState(state) {
  return repo.write(NOTIFICATIONS_TABLE, "/", state);
}

function allocateNotificationID(state) {
  const nextNotificationID = toPositiveInteger(state._meta.nextNotificationID, 1);
  state._meta.nextNotificationID = nextNotificationID + 1;
  return nextNotificationID;
}

function marshalNotificationValue(value) {
  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "bigint") {
    return buildFiletimeLong(value);
  }

  if (Buffer.isBuffer(value)) {
    return value;
  }

  if (Array.isArray(value)) {
    return buildList(value.map((entry) => marshalNotificationValue(entry)));
  }

  if (value && typeof value === "object") {
    if (Object.prototype.hasOwnProperty.call(value, "type")) {
      return value;
    }

    return buildDict(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        marshalNotificationValue(entryValue),
      ]),
    );
  }

  return String(value);
}

function buildNotificationDataPayload(record) {
  if (!record || typeof record !== "object") {
    return buildDict([]);
  }

  if (
    toPositiveInteger(record.typeID, 0) === NOTIFICATION_TYPE.STANDINGS_DECREASED &&
    Array.isArray(record.data)
  ) {
    return buildList(record.data.map((row) => buildList(
      (Array.isArray(row) ? row : []).map((value, index) => (
        index < 2
          ? Math.trunc(normalizeNumber(value, 0))
          : buildMarshalReal(value)
      )),
    )));
  }

  return marshalNotificationValue(record.data);
}

function hasNotificationDataPayload(dataPayload) {
  if (dataPayload === null || dataPayload === undefined) {
    return false;
  }
  if (
    dataPayload &&
    dataPayload.type === "dict" &&
    Array.isArray(dataPayload.entries) &&
    dataPayload.entries.length === 0
  ) {
    return false;
  }
  if (
    dataPayload &&
    dataPayload.type === "list" &&
    Array.isArray(dataPayload.items) &&
    dataPayload.items.length === 0
  ) {
    return false;
  }
  return true;
}

function buildNotificationDTO(record) {
  return buildKeyVal([
    ["notificationID", toPositiveInteger(record && record.notificationID, 0)],
    ["typeID", toPositiveInteger(record && record.typeID, 0)],
    ["senderID", Math.trunc(normalizeNumber(record && record.senderID, 0))],
    ["receiverID", toPositiveInteger(record && record.receiverID, 0)],
    ["processed", record && record.processed === true],
    ["created", buildFiletimeLong(record && record.created ? record.created : currentFileTimeString())],
    ["data", buildNotificationDataPayload(record)],
  ]);
}

// notificationMgr's reads as Tranquility answers them (its recordings: GetAllNotifications(fromID=0) at a login,
// GetUnprocessed() and GetByGroupID(3) as the notification window opens): a carbon CRowset whose header is a
// blue.DBRowDescriptor of these eight columns, each row a DBRow, its data the notification's data as YAML text
// ([2413004682L, 85, 2124515671L, 2124515671L, False, 134275840800000000L, u'amount: 4899887.0\ncorpID: ...', False]).
// The client reads each row's attributes (Notification.FromDTO) and loads the text (TryUnYamlNotificationData).
const NOTIFICATION_DBROW_COLUMNS = Object.freeze([
  ["notificationID", 0x14],
  ["typeID", 0x03],
  ["senderID", 0x14],
  ["receiverID", 0x14],
  ["processed", 0x0b],
  ["created", 0x40],
  ["data", 0x82],
  ["deleted", 0x0b],
]);

/** The data a row's YAML is written from: as kept, the NPC standings' amounts floats as the notice sends them. */
function notificationYamlSource(record) {
  if (
    toPositiveInteger(record && record.typeID, 0) === NOTIFICATION_TYPE.STANDINGS_DECREASED &&
    Array.isArray(record.data)
  ) {
    return record.data.map((row) => (Array.isArray(row) ? row : []).map((value, index) => (
      index < 2 ? Math.trunc(normalizeNumber(value, 0)) : { type: "real", value: normalizeNumber(value, 0) }
    )));
  }
  return record && record.data !== undefined ? record.data : {};
}

function buildNotificationRowset(records = []) {
  return buildDbRowset(
    NOTIFICATION_DBROW_COLUMNS,
    records.map((record) => ({
      notificationID: toPositiveInteger(record && record.notificationID, 0),
      typeID: toPositiveInteger(record && record.typeID, 0),
      senderID: Math.trunc(normalizeNumber(record && record.senderID, 0)),
      receiverID: toPositiveInteger(record && record.receiverID, 0),
      processed: Boolean(record && record.processed === true),
      created: buildFiletimeLong(record && record.created ? record.created : currentFileTimeString()),
      data: { type: "wstring", value: notificationDataYaml(notificationYamlSource(record)) },
      deleted: false,
    })),
    "carbon.common.script.sys.crowset.CRowset",
  );
}

function getAllNotificationRows(characterID, options = {}) {
  return buildNotificationRowset(listNotifications(characterID, { fromID: options.fromID }));
}

function getNotificationRowsByGroupID(characterID, groupID) {
  return buildNotificationRowset(listNotifications(characterID, { groupID }));
}

function getUnprocessedNotificationRows(characterID) {
  return buildNotificationRowset(listNotifications(characterID, { processed: false }));
}

function listNotifications(characterID, options = {}) {
  const numericCharacterID = toPositiveInteger(characterID, 0);
  if (numericCharacterID <= 0) {
    return [];
  }

  const state = getMutableState();
  const box = ensureNotificationBox(state, numericCharacterID);
  const fromID = toPositiveInteger(options.fromID, 0);
  const groupID =
    options.groupID == null ? null : toPositiveInteger(options.groupID, 0) || null;
  const processed =
    typeof options.processed === "boolean" ? options.processed : null;

  const results = [];
  for (const notificationID of box.order) {
    if (fromID > 0 && notificationID <= fromID) {
      continue;
    }
    const record = box.byID[String(notificationID)];
    if (!record || typeof record !== "object") {
      continue;
    }
    if (groupID != null && toPositiveInteger(record.groupID, 0) !== groupID) {
      continue;
    }
    if (processed != null && Boolean(record.processed) !== processed) {
      continue;
    }
    results.push(record);
  }

  return results;
}

function getAllNotifications(characterID, options = {}) {
  return listNotifications(characterID, {
    fromID: options.fromID,
  }).map((record) => buildNotificationDTO(record));
}

function getNotificationsByGroupID(characterID, groupID) {
  return listNotifications(characterID, {
    groupID,
  }).map((record) => buildNotificationDTO(record));
}

function getUnprocessedNotifications(characterID) {
  return listNotifications(characterID, {
    processed: false,
  }).map((record) => buildNotificationDTO(record));
}

function getUnprocessedNotificationCount(characterID) {
  return listNotifications(characterID, {
    processed: false,
  }).length;
}

function getCharacterSessions(characterID, options = {}) {
  const numericCharacterID = toPositiveInteger(characterID, 0);
  const excludedSession = options.excludeSession || null;
  if (numericCharacterID <= 0) {
    return [];
  }

  const sessions = [];
  const seen = new Set();
  const addSession = (session) => {
    if (!session || session === excludedSession) {
      return;
    }
    const sessionCharacterID = toPositiveInteger(
      session.characterID || session.charID || session.charid,
      0,
    );
    if (
      sessionCharacterID !== numericCharacterID ||
      seen.has(session) ||
      (session.socket && session.socket.destroyed)
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

function sendNotificationReceivedEvent(record, options = {}) {
  if (!record || typeof record !== "object") {
    return;
  }

  for (const session of getCharacterSessions(record.receiverID, options)) {
    if (!session || typeof session.sendNotification !== "function") {
      continue;
    }
    const payload = [
      toPositiveInteger(record.notificationID, 0),
      toPositiveInteger(record.typeID, 0),
      Math.trunc(normalizeNumber(record.senderID, 0)),
      buildFiletimeLong(record.created || currentFileTimeString()),
    ];
    const dataPayload = buildNotificationDataPayload(record);
    if (hasNotificationDataPayload(dataPayload)) {
      payload.push(dataPayload);
    }
    session.sendNotification("OnNotificationReceived", "clientID", payload);
  }
}

function sendNotificationDeletedEvent(characterID, notificationIDs, options = {}) {
  const normalizedIDs = (Array.isArray(notificationIDs) ? notificationIDs : [])
    .map((notificationID) => toPositiveInteger(notificationID, 0))
    .filter((notificationID) => notificationID > 0);
  if (normalizedIDs.length === 0) {
    return;
  }

  for (const session of getCharacterSessions(characterID, options)) {
    if (!session || typeof session.sendNotification !== "function") {
      continue;
    }
    session.sendNotification("OnNotificationDeleted", "clientID", [
      normalizedIDs,
    ]);
  }
}

function persistDurableNotification(state, record) {
  // Reused keys must write too: a previous rejected write can leave the
  // cache containing a row which has never reached storage.
  if (persistState(state)?.success !== true ||
      repo.flushTableSync(NOTIFICATIONS_TABLE)?.success !== true) {
    return { success: false, errorMsg: "NOTIFICATION_PERSISTENCE_PENDING" };
  }
  const persisted = require(path.join(__dirname, "../../gameStore")).readPersisted(
    NOTIFICATIONS_TABLE, `/boxes/${record.receiverID}/byID/${record.notificationID}`,
  );
  return persisted?.success === true && isDeepStrictEqual(persisted.data, record)
    ? null : { success: false, errorMsg: "NOTIFICATION_NOT_DURABLE" };
}

function publishDurableNotification(state, record, options) {
  const failure = persistDurableNotification(state, record);
  if (failure) return failure;
  if (options.emitLive !== false && record.liveEmitted !== true) {
    sendNotificationReceivedEvent(record, {
      excludeSession: options.excludeSession || null,
      extraSessions: options.extraSessions || [],
    });
    record.liveEmitted = true;
    return persistDurableNotification(state, record);
  }
  return null;
}

function createNotification(characterID, options = {}) {
  const numericCharacterID = toPositiveInteger(characterID, 0);
  const typeID = toPositiveInteger(options.typeID, 0);
  if (numericCharacterID <= 0 || typeID <= 0) {
    return { success: false, errorMsg: "INVALID_NOTIFICATION" };
  }

  const state = getMutableState();
  const box = ensureNotificationBox(state, numericCharacterID);
  const idempotencyKey = normalizeText(options.idempotencyKey, "").trim();
  if (idempotencyKey) {
    const existing = Object.values(box.byID || {}).find(
      (record) => record && record.idempotencyKey === idempotencyKey,
    );
    if (existing) {
      // A retry must not write a second row - but the live event is a separate
      // question from the row. The settlement paths deliberately split the two:
      // they write the record inside the durable transaction with
      // emitLive:false, then emit once it has committed with emitLive:true,
      // under one idempotency key. Returning early without emitting left that
      // second call doing nothing at all, so a corporation dividend or
      // liquidation never reached a connected client live - the player saw it
      // only on their next notification fetch.
      //
      // Gated on whether the event has ever been sent for this record, not on
      // the caller's flag alone: replaying a durable job re-runs its
      // emitLive:true call too, and a replay must stay silent rather than
      // deliver the same notice to the client twice.
      if (options.requireDurable === true) {
        const failure = publishDurableNotification(state, existing, options);
        if (failure) return failure;
      } else if (options.emitLive === true && existing.liveEmitted !== true) {
        sendNotificationReceivedEvent(existing, {
          excludeSession: options.excludeSession || null,
          extraSessions: options.extraSessions || [],
        });
        existing.liveEmitted = true;
        persistState(state);
      }
      return {
        success: true,
        notificationID: existing.notificationID,
        record: buildNotificationDTO(existing),
        reused: true,
      };
    }
  }
  const notificationID = allocateNotificationID(state);
  // Durable callers first commit an undelivered row, then publish and record
  // delivery. Other callers retain their existing single-write behavior.
  // The flag is server-side bookkeeping and is absent from the client DTO.
  const willEmitLive = options.emitLive !== false;
  const record = ensureNotificationShape({
    notificationID,
    liveEmitted: options.requireDurable === true ? false : willEmitLive,
    typeID,
    senderID: Math.trunc(normalizeNumber(options.senderID, 0)),
    receiverID: numericCharacterID,
    processed: options.processed === true,
    created: normalizeText(options.created, "") || currentFileTimeString(),
    groupID:
      options.groupID == null
        ? null
        : toPositiveInteger(options.groupID, 0) || null,
    idempotencyKey: idempotencyKey || undefined,
    data: options.data,
  }, notificationID, numericCharacterID);

  box.byID[String(notificationID)] = record;
  if (!box.order.includes(notificationID)) {
    box.order.unshift(notificationID);
  }

  const writeResult = persistState(state);
  if (!writeResult || !writeResult.success) {
    return { success: false, errorMsg: "WRITE_ERROR" };
  }
  if (options.requireDurable === true) {
    const failure = publishDurableNotification(state, record, options);
    if (failure) return failure;
  } else if (willEmitLive) {
    sendNotificationReceivedEvent(record, {
      excludeSession: options.excludeSession || null,
      extraSessions: options.extraSessions || [],
    });
  }

  return {
    success: true,
    notificationID,
    record: buildNotificationDTO(record),
  };
}

function mutateProcessed(characterID, notificationIDs, processed) {
  const numericCharacterID = toPositiveInteger(characterID, 0);
  if (numericCharacterID <= 0) {
    return { success: false, errorMsg: "INVALID_CHARACTER" };
  }

  const normalizedIDs = [...new Set(
    (Array.isArray(notificationIDs) ? notificationIDs : [])
      .map((notificationID) => toPositiveInteger(notificationID, 0))
      .filter((notificationID) => notificationID > 0),
  )];
  if (normalizedIDs.length === 0) {
    return { success: true, changedNotificationIDs: [] };
  }

  const state = getMutableState();
  const box = ensureNotificationBox(state, numericCharacterID);
  const changedNotificationIDs = [];
  for (const notificationID of normalizedIDs) {
    const record = box.byID[String(notificationID)];
    if (!record || record.processed === processed) {
      continue;
    }
    record.processed = processed;
    changedNotificationIDs.push(notificationID);
  }

  if (changedNotificationIDs.length === 0) {
    return { success: true, changedNotificationIDs: [] };
  }

  const writeResult = persistState(state);
  if (!writeResult || !writeResult.success) {
    return { success: false, errorMsg: "WRITE_ERROR" };
  }

  return { success: true, changedNotificationIDs };
}

function markAsProcessed(characterID, notificationIDs) {
  return mutateProcessed(characterID, notificationIDs, true);
}

function markGroupAsProcessed(characterID, groupID) {
  const records = listNotifications(characterID, { groupID, processed: false });
  return markAsProcessed(
    characterID,
    records.map((record) => record.notificationID),
  );
}

function markAllAsProcessed(characterID) {
  const records = listNotifications(characterID, { processed: false });
  return markAsProcessed(
    characterID,
    records.map((record) => record.notificationID),
  );
}

function deleteNotificationIDs(characterID, notificationIDs, options = {}) {
  const numericCharacterID = toPositiveInteger(characterID, 0);
  if (numericCharacterID <= 0) {
    return { success: false, errorMsg: "INVALID_CHARACTER" };
  }

  const normalizedIDs = [...new Set(
    (Array.isArray(notificationIDs) ? notificationIDs : [])
      .map((notificationID) => toPositiveInteger(notificationID, 0))
      .filter((notificationID) => notificationID > 0),
  )];
  if (normalizedIDs.length === 0) {
    return { success: true, changedNotificationIDs: [] };
  }

  const state = getMutableState();
  const box = ensureNotificationBox(state, numericCharacterID);
  const changedNotificationIDs = [];
  for (const notificationID of normalizedIDs) {
    if (!box.byID[String(notificationID)]) {
      continue;
    }
    delete box.byID[String(notificationID)];
    changedNotificationIDs.push(notificationID);
  }

  if (changedNotificationIDs.length === 0) {
    return { success: true, changedNotificationIDs: [] };
  }

  box.order = box.order.filter(
    (notificationID) => !changedNotificationIDs.includes(notificationID),
  );

  const writeResult = persistState(state);
  if (!writeResult || !writeResult.success) {
    return { success: false, errorMsg: "WRITE_ERROR" };
  }

  if (options.emitLive !== false) {
    sendNotificationDeletedEvent(numericCharacterID, changedNotificationIDs, {
      excludeSession: options.excludeSession || null,
    });
  }

  return { success: true, changedNotificationIDs };
}

function deleteNotifications(characterID, notificationIDs, options = {}) {
  return deleteNotificationIDs(characterID, notificationIDs, options);
}

function deleteGroupNotifications(characterID, groupID, options = {}) {
  const records = listNotifications(characterID, { groupID });
  return deleteNotificationIDs(
    characterID,
    records.map((record) => record.notificationID),
    options,
  );
}

function deleteAllNotifications(characterID, options = {}) {
  const records = listNotifications(characterID, {});
  return deleteNotificationIDs(
    characterID,
    records.map((record) => record.notificationID),
    options,
  );
}

function logNotificationInteraction() {
  return null;
}

module.exports = {
  NOTIFICATIONS_TABLE,
  createNotification,
  deleteAllNotifications,
  deleteGroupNotifications,
  deleteNotifications,
  getAllNotificationRows,
  getAllNotifications,
  getNotificationRowsByGroupID,
  getNotificationsByGroupID,
  getUnprocessedNotificationCount,
  getUnprocessedNotificationRows,
  getUnprocessedNotifications,
  logNotificationInteraction,
  markAllAsProcessed,
  markAsProcessed,
  markGroupAsProcessed,
};
