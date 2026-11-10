"use strict";
const { toInt, normalizeLowerText } = require("../domain/abyssalRuntimeValues");

function getCharacterID(ports, session = null) {
  return toInt(
    session &&
      (
        session.characterID ||
        session.charid ||
        session.characterId
      ),
    0,
  );
}

function getSessionContext(ports, session = null) {
  const characterID = getCharacterID(ports, session);
  const corporationID = toInt(
    session && (session.corporationID || session.corpid),
    characterID,
  );
  const shipID = toInt(
    session && session._space && session._space.shipID,
    toInt(session && (session.shipID || session.shipid || session.activeShipID), 0),
  );
  const systemID = toInt(
    session && session._space && session._space.systemID,
    toInt(session && (session.solarsystemid2 || session.solarsystemid), 0),
  );
  const fleetID = toInt(
    session && (session.fleetid || session.fleetID),
    0,
  );
  const instanceID = toInt(
    session && (
      session.abyssalInstanceID ||
      session.instanceID ||
      session.dungeonInstanceID ||
      (session._space && session._space.instanceID)
    ),
    0,
  );

  return {
    characterID,
    corporationID,
    shipID,
    systemID,
    fleetID,
    instanceID,
  };
}

function getAbyssalAuditMaximumAgeMs(ports) {
  const {
    ABYSSAL_AUDIT_DEFAULT_MAX_AGE_MS,
  } = ports;
  return Math.max(
    60_000,
    toInt(
      ports.getAuditMaximumAgeMs(),
      ABYSSAL_AUDIT_DEFAULT_MAX_AGE_MS,
    ),
  );
}

function pruneExpiredAbyssalAuditEvents(ports, nowMs) {
  const cutoffMs = nowMs - getAbyssalAuditMaximumAgeMs(ports);
  ports.pruneAuditEvents(cutoffMs);
}

function recordAuditEvent(ports, kind, args = [], session = null, details = {}) {
  const {
    sanitizeAbyssalAuditValue,
    cloneArgs,
    ABYSSAL_AUDIT_MAX_EVENT_BYTES,
    ABYSSAL_AUDIT_REJECTION_AGGREGATION_WINDOW_MS,
    ABYSSAL_AUDIT_MAX_EVENTS,
  } = ports;
  const timestamp = Date.now();
  pruneExpiredAbyssalAuditEvents(ports, timestamp);
  let event = {
    kind,
    args: sanitizeAbyssalAuditValue(cloneArgs(args)),
    characterID: getCharacterID(ports, session) || null,
    details: sanitizeAbyssalAuditValue(details),
    timestamp,
  };
  const serializedSizeBytes = Buffer.byteLength(JSON.stringify(event), "utf8");
  if (serializedSizeBytes > ABYSSAL_AUDIT_MAX_EVENT_BYTES) {
    event = {
      ...event,
      args: [],
      details: {
        truncated: true,
        originalSerializedSizeBytes: serializedSizeBytes,
        detailKeys:
          details && typeof details === "object" ? Object.keys(details).slice(0, 64) : [],
      },
    };
    ports.incrementAuditMetric("eventsTruncated");
  }
  if (normalizeLowerText(kind, "").includes("rejected")) {
    const aggregationKey = JSON.stringify([
      event.kind,
      event.characterID,
      event.args,
      event.details,
    ]);
    const aggregated = ports.updateLatestAuditEvent(
      (entry) =>
        entry &&
        entry.aggregationKey === aggregationKey &&
        timestamp - toInt(entry.lastTimestamp, entry.timestamp) <=
          ABYSSAL_AUDIT_REJECTION_AGGREGATION_WINDOW_MS,
      (entry) => {
        entry.repeatedCount = Math.max(1, toInt(entry.repeatedCount, 1)) + 1;
        entry.lastTimestamp = timestamp;
      },
    );
    if (aggregated) {
      ports.incrementAuditMetric("repeatedFailuresAggregated");
      return;
    }
    event.aggregationKey = aggregationKey;
    event.repeatedCount = 1;
    event.lastTimestamp = timestamp;
  }
  ports.appendAuditEvent(event, ABYSSAL_AUDIT_MAX_EVENTS);
}

function createAbyssalSessionAudit(ports) {
  return {
    getCharacterID: getCharacterID.bind(null, ports),
    getSessionContext: getSessionContext.bind(null, ports),
    getAbyssalAuditMaximumAgeMs: getAbyssalAuditMaximumAgeMs.bind(null, ports),
    pruneExpiredAbyssalAuditEvents: pruneExpiredAbyssalAuditEvents.bind(null, ports),
    recordAuditEvent: recordAuditEvent.bind(null, ports),
  };
}

module.exports = { createAbyssalSessionAudit };
