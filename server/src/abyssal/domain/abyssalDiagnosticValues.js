"use strict";

const ABYSSAL_AUDIT_MAX_STRING_LENGTH = 4_096;
const ABYSSAL_AUDIT_MAX_DEPTH = 12;
const ABYSSAL_AUDIT_MAX_COLLECTION_ENTRIES = 256;
const ABYSSAL_AUDIT_REDACTED_KEY_PATTERN =
  /(authorization|cookie|password|secret|sessiontoken|access_token)/i;

function toInteger(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function normalizeText(value, fallback = "") {
  const normalized = String(value == null ? "" : value).trim();
  return normalized || fallback;
}

function cloneAbyssalAuditArgs(args) {
  return Array.isArray(args) ? args.slice() : [];
}

function sanitizeAbyssalAuditValue(value, depth = 0, seen = new WeakSet()) {
  if (value === null || value === undefined) {
    return value ?? null;
  }
  if (typeof value === "string") {
    return value.length > ABYSSAL_AUDIT_MAX_STRING_LENGTH
      ? `${value.slice(0, ABYSSAL_AUDIT_MAX_STRING_LENGTH)}...[truncated]`
      : value;
  }
  if (["number", "boolean"].includes(typeof value)) {
    return value;
  }
  if (depth >= ABYSSAL_AUDIT_MAX_DEPTH) {
    return "[MAX_DEPTH]";
  }
  if (typeof value !== "object") {
    return String(value);
  }
  if (seen.has(value)) {
    return "[CIRCULAR]";
  }
  seen.add(value);
  if (Array.isArray(value)) {
    return value
      .slice(0, ABYSSAL_AUDIT_MAX_COLLECTION_ENTRIES)
      .map((entry) => sanitizeAbyssalAuditValue(entry, depth + 1, seen));
  }
  const sanitized = {};
  for (const [key, entryValue] of Object.entries(value)
    .slice(0, ABYSSAL_AUDIT_MAX_COLLECTION_ENTRIES)) {
    if (ABYSSAL_AUDIT_REDACTED_KEY_PATTERN.test(key)) {
      sanitized[key] = "[REDACTED]";
      continue;
    }
    sanitized[key] = sanitizeAbyssalAuditValue(entryValue, depth + 1, seen);
  }
  return sanitized;
}

function normalizeAbyssalBootstrapMode(value, session = null) {
  const requested = normalizeText(value, "");
  if (["fresh-entry", "active-bind", "relog-recovery"].includes(requested)) {
    return requested;
  }
  if (normalizeText(session && session._abyssalBootstrapMode, "") === "relog-recovery") {
    return "relog-recovery";
  }
  return session && session._space && session._space.initialStateSent === true
    ? "active-bind"
    : "fresh-entry";
}

function buildAbyssalBootstrapDiagnosticFields(state, mode) {
  return {
    mode,
    runID: toInteger(state && state.descriptor && state.descriptor.instanceID, 0),
    roomIndex: toInteger(state && state.currentRoomIndex, 0),
    sceneKey: normalizeText(state && state.actualSceneKey, ""),
    egoID: toInteger(state && state.shipEntity && state.shipEntity.itemID, 0),
    setStateSlimCount: toInteger(state && state.setStateSlimCount, 0),
    participantShipCount: toInteger(state && state.participantShipCount, 0),
    visibleRoomEntityCount: toInteger(state && state.visibleRoomEntityCount, 0),
    expectedRoomEntityCount: toInteger(state && state.expectedRoomEntityCount, 0),
    stalePriorRoomEntityCount: toInteger(state && state.stalePriorRoomEntityCount, 0),
    foreignRunEntityCount: toInteger(state && state.foreignRunEntityCount, 0),
    recipientMember: state && state.recipientMember === true,
    layoutMatches: state && state.layoutMatches === true,
    setStatePreviouslyDelivered: state && state.setStatePreviouslyDelivered === true,
    validationReason: normalizeText(state && state.reason, "VALIDATION_NOT_RUN"),
  };
}

module.exports = {
  ABYSSAL_AUDIT_MAX_COLLECTION_ENTRIES,
  ABYSSAL_AUDIT_MAX_DEPTH,
  ABYSSAL_AUDIT_MAX_STRING_LENGTH,
  buildAbyssalBootstrapDiagnosticFields,
  cloneAbyssalAuditArgs,
  normalizeAbyssalBootstrapMode,
  sanitizeAbyssalAuditValue,
};
