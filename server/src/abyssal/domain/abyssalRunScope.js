"use strict";

// Shared "which run and room is this entity in?" resolution.
//
// Both mechanics controllers carried a byte-identical copy of
// resolveExactPositiveScopeAliases plus the two field lists. The rule it encodes
// is subtle enough that two drifting copies would be a real hazard: an entity may
// carry the run id under any of five aliases and the room index under either of
// two, on the entity itself or on its spaceState, and the scope is only valid if
// every alias that is present agrees on one positive value. A conflict is not
// "pick one" - it invalidates the scope, because acting on a half-identified
// entity would apply Abyssal mechanics to the wrong run.
//
// Scope: this module covers scope resolution only. The controllers' lifecycle
// functions (clearControllerTimer, normalizeCallbacks, cleanupController,
// register/activate/snapshot) look similar but are NOT interchangeable - they
// reset different state, take different callback sets, and return different
// contracts. See doc/abyssal/target-architecture.md for the registry that
// eventually unifies them.

const ABYSSAL_RUN_SCOPE_FIELDS = Object.freeze([
  "abyssalRunID",
  "evejsAbyssalInstanceID",
  "evejsAbyssalPocketInstanceID",
  "dungeonCurrentInstanceID",
  "dungeonSiteInstanceID",
]);

const ABYSSAL_ROOM_SCOPE_FIELDS = Object.freeze([
  "abyssalRoomIndex",
  "evejsAbyssalRoomIndex",
]);

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

// Returns { present, valid, value }.
//   present - at least one alias carried a non-null value
//   valid   - every alias present agreed on the same positive integer
//   value   - that integer, or 0
function resolveExactPositiveScopeAliases(entity, fieldNames) {
  const containers = entity && typeof entity === "object"
    ? [
        entity,
        entity.spaceState && typeof entity.spaceState === "object"
          ? entity.spaceState
          : null,
      ].filter(Boolean)
    : [];
  let value = 0;
  let present = false;
  for (const container of containers) {
    for (const fieldName of fieldNames) {
      if (
        !Object.hasOwn(container, fieldName) ||
        container[fieldName] === null ||
        container[fieldName] === undefined
      ) {
        continue;
      }
      present = true;
      const candidate = toInt(container[fieldName], 0);
      if (candidate <= 0 || (value > 0 && candidate !== value)) {
        return { present, valid: false, value: 0 };
      }
      value = candidate;
    }
  }
  return {
    present,
    valid: present && value > 0,
    value,
  };
}

// Rich form: always returns an object, so a caller can distinguish "no scope
// claimed at all" from "scope claimed but contradictory". The suppressor
// controller needs that distinction; the boundary controller does not.
function resolveAbyssalRunRoomScope(entity) {
  const run = resolveExactPositiveScopeAliases(entity, ABYSSAL_RUN_SCOPE_FIELDS);
  const room = resolveExactPositiveScopeAliases(entity, ABYSSAL_ROOM_SCOPE_FIELDS);
  return {
    present: run.present || room.present,
    valid: run.valid && room.valid,
    runID: run.value,
    roomIndex: room.value,
  };
}

// Strict form: null unless a complete, agreed scope is present. Callers that
// only ever act on a fully-identified entity want this one.
function resolveExactAbyssalRunRoomScopeOrNull(entity) {
  const scope = resolveAbyssalRunRoomScope(entity);
  return scope.valid ? { runID: scope.runID, roomIndex: scope.roomIndex } : null;
}

module.exports = {
  ABYSSAL_RUN_SCOPE_FIELDS,
  ABYSSAL_ROOM_SCOPE_FIELDS,
  resolveExactPositiveScopeAliases,
  resolveAbyssalRunRoomScope,
  resolveExactAbyssalRunRoomScopeOrNull,
};
