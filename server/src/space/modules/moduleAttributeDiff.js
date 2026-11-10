"use strict";

function toInt(value, fallback = 0) {
  const numeric = Math.trunc(Number(value) || 0);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function numericValuesEqual(left, right) {
  const numericLeft = Number(left);
  const numericRight = Number(right);
  if (!Number.isFinite(numericLeft) || !Number.isFinite(numericRight)) {
    return Object.is(left, right);
  }
  const scale = Math.max(1, Math.abs(numericLeft), Math.abs(numericRight));
  return Math.abs(numericLeft - numericRight) <= scale * 1e-9;
}

function resolveModuleSnapshotDirectModifierEntries(entity, moduleItem, options = {}) {
  const collector = options.collectModifierEntriesForItem;
  if (typeof collector !== "function") {
    return [];
  }
  const nowMs = Number(options.nowMs);
  const entries = collector(
    entity,
    moduleItem,
    Number.isFinite(nowMs) ? nowMs : Date.now(),
  );
  return Array.isArray(entries) ? entries : [];
}

function collectNumericModuleAttributeDiffs(beforeSnapshots, afterSnapshots) {
  const before = beforeSnapshots instanceof Map ? beforeSnapshots : new Map();
  const after = afterSnapshots instanceof Map ? afterSnapshots : new Map();
  const diffs = [];
  const moduleIDs = [...new Set([...before.keys(), ...after.keys()])]
    .map((value) => toInt(value, 0))
    .filter((value) => value > 0)
    .sort((left, right) => left - right);

  for (const moduleID of moduleIDs) {
    const beforeAttributes = before.get(moduleID) instanceof Map
      ? before.get(moduleID)
      : new Map();
    const afterAttributes = after.get(moduleID) instanceof Map
      ? after.get(moduleID)
      : new Map();
    const attributeIDs = [...new Set([
      ...beforeAttributes.keys(),
      ...afterAttributes.keys(),
    ])]
      .map((value) => toInt(value, 0))
      .filter((value) => value > 0)
      .sort((left, right) => left - right);

    for (const attributeID of attributeIDs) {
      const oldValue = beforeAttributes.get(attributeID);
      const newValue = afterAttributes.get(attributeID);
      if (
        !Number.isFinite(Number(oldValue)) ||
        !Number.isFinite(Number(newValue)) ||
        numericValuesEqual(oldValue, newValue)
      ) {
        continue;
      }
      diffs.push({
        moduleID,
        attributeID,
        oldValue: Number(oldValue),
        newValue: Number(newValue),
      });
    }
  }

  return diffs;
}

module.exports = {
  collectNumericModuleAttributeDiffs,
  numericValuesEqual,
  resolveModuleSnapshotDirectModifierEntries,
};
