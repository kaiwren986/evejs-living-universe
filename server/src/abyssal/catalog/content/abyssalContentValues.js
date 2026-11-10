"use strict";

function normalizeStringArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((entry) => String(entry || "")).filter(Boolean);
}

function toInteger(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function getCharacterID(session = null) {
  return toInteger(
    session &&
      (
        session.characterID ||
        session.charid ||
        session.characterId
      ),
    0,
  );
}

function cloneArgs(args) {
  return Array.isArray(args) ? args.slice() : [];
}

function normalizeHullMode(value) {
  return String(value || "").trim().toLowerCase();
}

function toBoolean(value, fallback = false) {
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

function normalizeIntegerArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => toInteger(entry, 0))
    .filter((entry) => entry > 0);
}

module.exports = { normalizeStringArray, toInteger, toBoolean, normalizeIntegerArray, normalizeHullMode, getCharacterID, cloneArgs };
