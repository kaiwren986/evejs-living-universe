"use strict";

module.exports = {
  getMarshalDictEntry,
  getMarshalListItems,
  marshalModuleDurationWireValue,
  unwrapMarshalNumber,
};

const runtimeEntryDirname = require("path").resolve(__dirname, "..");
const path = require("path");
const {
  currentFileTime,
  buildFiletimeLong,
  buildMarshalReal,
} = require(path.join(runtimeEntryDirname, "../services/_shared/serviceHelpers"));
const {
  toFiniteNumber,
} = require("../../common/numbers");

function unwrapMarshalNumber(value, fallback = 0) {
  if (value && typeof value === "object" && value.type === "real") {
    return toFiniteNumber(value.value, fallback);
  }
  return toFiniteNumber(value, fallback);
}

function marshalModuleDurationWireValue(value) {
  if (value === undefined || value === null) {
    return value;
  }
  if (value && typeof value === "object" && value.type === "real") {
    return value;
  }

  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return value;
  }
  if (numericValue < 0) {
    return Math.trunc(numericValue);
  }
  return buildMarshalReal(numericValue, 0);
}

function getMarshalListItems(value) {
  if (Array.isArray(value)) {
    return value;
  }
  if (
    value &&
    typeof value === "object" &&
    value.type === "list" &&
    Array.isArray(value.items)
  ) {
    return value.items;
  }
  return [];
}

function getMarshalDictEntry(value, key) {
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    value.type !== "dict" &&
    Object.prototype.hasOwnProperty.call(value, key)
  ) {
    return value[key];
  }
  if (!value || value.type !== "dict" || !Array.isArray(value.entries)) {
    return undefined;
  }
  const entry = value.entries.find(
    (candidate) => Array.isArray(candidate) && candidate[0] === key,
  );
  return entry ? entry[1] : undefined;
}
