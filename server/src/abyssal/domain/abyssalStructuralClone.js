"use strict";

const { toInt, normalizeText } = require("./abyssalRuntimeValues");

// Structural compatibility is intentionally distinct from the catalogue JSON clone:
// undefined becomes null, non-object values retain identity, ancestor cycles are cut,
// and immutable authored content-profile identities are retained. Guard logging is
// bounded by the existing diagnostics owner supplied by the composition root.
const CLONE_VALUE_MAX_DEPTH = 64;
const CLONE_VALUE_MAX_NODES = 200000;
const CLONE_VALUE_MAX_GUARD_LOGS = 20;

function reportCloneValueGuard(ports, guard, path) {
  if (!ports.consumeCloneValueGuardLog(CLONE_VALUE_MAX_GUARD_LOGS)) {
    return;
  }
  const callSite = String(
    (new Error("cloneValue guard").stack || ""),
  )
    .split("\n")
    .slice(2, 8)
    .map((line) => line.trim())
    .join(" <- ");
  ports.log.warn(
    `[AbyssalClone] guard=${guard} path=${path || "<root>"} ` +
      `maxDepth=${CLONE_VALUE_MAX_DEPTH} maxNodes=${CLONE_VALUE_MAX_NODES} ` +
      `callSite=${callSite}`,
  );
}

function cloneValueGuarded(ports, value, depth, ancestors, budget, path) {
  if (value === null || value === undefined) {
    return value ?? null;
  }
  const valueType = typeof value;
  if (
    valueType === "string" ||
    valueType === "number" ||
    valueType === "boolean"
  ) {
    return value;
  }
  if (valueType !== "object") {
    // Functions, symbols and bigints are handed back by reference, matching the
    // previous trailing `return value`.
    return value;
  }
  if (
    (path === "contentProfile" || path.endsWith(".contentProfile")) &&
    toInt(value.filamentTypeID, 0) > 0 &&
    normalizeText(value.definitionID, "") &&
    normalizeText(value.hullMode, "") &&
    toInt(value.abyssalContentProfileReferenceSchemaVersion, 0) <= 0
  ) {
    // Authored filament definitions are immutable catalogue objects. Preserve
    // their identity while cloning mutable run state; deep-copying the Tier 6
    // empirical outcome catalogue on every mutation creates gigabytes of
    // short-lived objects and can starve the persistence-owner heartbeat.
    return value;
  }
  if (ancestors.has(value)) {
    reportCloneValueGuard(ports, "cycle", path);
    return null;
  }
  if (depth >= CLONE_VALUE_MAX_DEPTH) {
    reportCloneValueGuard(ports, "depth", path);
    return null;
  }
  if (budget.nodes >= CLONE_VALUE_MAX_NODES) {
    reportCloneValueGuard(ports, "nodes", path);
    return null;
  }
  budget.nodes += 1;
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const clonedArray = new Array(value.length);
      for (let index = 0; index < value.length; index += 1) {
        clonedArray[index] = cloneValueGuarded(ports,
          value[index],
          depth + 1,
          ancestors,
          budget,
          `${path}[${index}]`,
        );
      }
      return clonedArray;
    }
    // Object.fromEntries rather than assignment so a "__proto__" key keeps
    // cloning to an own property instead of reassigning the prototype, exactly
    // as the previous implementation did.
    const clonedEntries = [];
    for (const entryKey of Object.keys(value)) {
      clonedEntries.push([
        entryKey,
        cloneValueGuarded(ports,
          value[entryKey],
          depth + 1,
          ancestors,
          budget,
          path ? `${path}.${entryKey}` : entryKey,
        ),
      ]);
    }
    return Object.fromEntries(clonedEntries);
  } finally {
    ancestors.delete(value);
  }
}

function cloneValue(ports, value) {
  if (value === null || value === undefined) {
    return value ?? null;
  }
  if (typeof value !== "object") {
    return value;
  }
  return cloneValueGuarded(ports, value, 0, new Set(), { nodes: 0 }, "");
}

function createAbyssalStructuralClone(ports) {
  return { cloneValue: cloneValue.bind(null, ports) };
}

module.exports = { createAbyssalStructuralClone };
