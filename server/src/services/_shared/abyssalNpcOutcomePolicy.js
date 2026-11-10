"use strict";

const {
  entityIDsEqual,
  normalizePersistentEntityID,
  toJSONSafeEntityID,
} = require("../../space/destiny/identity/entityID");

const ABYSSAL_RUN_ID_FIELDS = Object.freeze([
  "abyssalRunID",
  "evejsAbyssalInstanceID",
  "evejsAbyssalPocketInstanceID",
]);
const ABYSSAL_ROOM_INDEX_FIELDS = Object.freeze([
  "abyssalRoomIndex",
  "evejsAbyssalRoomIndex",
]);

function toPositiveInt(value) {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : null;
}

function isNpcEntity(entity) {
  const npcEntityType = String(entity && entity.npcEntityType || "")
    .trim()
    .toLowerCase();
  return Boolean(
    entity &&
      (
        entity.nativeNpc === true ||
        entity.nativeNpcOccupied === true ||
        npcEntityType === "npc" ||
        npcEntityType === "concord"
      )
  );
}

function resolveExactAliases(source, fieldNames, normalize, equals) {
  let present = false;
  let valid = true;
  let value = null;
  for (const fieldName of fieldNames) {
    if (
      !source ||
      !Object.hasOwn(source, fieldName) ||
      source[fieldName] === null ||
      source[fieldName] === undefined
    ) {
      continue;
    }
    present = true;
    const candidate = normalize(source[fieldName]);
    if (
      candidate === null ||
      (value !== null && !equals(value, candidate))
    ) {
      valid = false;
      continue;
    }
    value = candidate;
  }
  return {
    present,
    valid: Boolean(valid && (!present || value !== null)),
    value,
  };
}

function resolveExactAbyssalNpcOutcomeContext(entity = {}) {
  const npc = isNpcEntity(entity);
  const policy =
    entity &&
    entity.evejsAbyssalNpcRuntimePolicy &&
    typeof entity.evejsAbyssalNpcRuntimePolicy === "object" &&
    !Array.isArray(entity.evejsAbyssalNpcRuntimePolicy)
      ? entity.evejsAbyssalNpcRuntimePolicy
      : null;
  const run = resolveExactAliases(
    entity,
    ABYSSAL_RUN_ID_FIELDS,
    normalizePersistentEntityID,
    entityIDsEqual,
  );
  const room = resolveExactAliases(
    entity,
    ABYSSAL_ROOM_INDEX_FIELDS,
    toPositiveInt,
    (left, right) => left === right,
  );
  const explicitAbyssalNpcAuthority = Boolean(
    entity &&
      (
        entity.evejsAbyssalNpc === true ||
        String(entity.abyssalEntityRole || "").trim().toLowerCase() === "npc" ||
        String(entity.sceneKind || "").trim().toLowerCase() === "abyssal" ||
        String(entity.instanceScope || "").trim().toLowerCase() === "abyssal" ||
        String(entity.sceneKey || "").trim().toLowerCase().startsWith("abyssal-run:")
      )
  );
  const exact = Boolean(
    npc &&
      explicitAbyssalNpcAuthority &&
      policy &&
      run.present &&
      run.valid &&
      run.value !== null &&
      room.present &&
      room.valid &&
      room.value !== null
  );
  const hasAbyssalOutcomeAuthority = Boolean(
    npc &&
      (
        explicitAbyssalNpcAuthority ||
        policy ||
        run.present ||
        room.present
      )
  );
  const invalidAbyssalOutcomeAuthority = Boolean(
    hasAbyssalOutcomeAuthority && !exact
  );

  return {
    exact,
    isNpc: npc,
    hasAbyssalOutcomeAuthority,
    invalidAbyssalOutcomeAuthority,
    runID: exact ? toJSONSafeEntityID(run.value) : null,
    roomIndex: exact ? room.value : null,
    policy: policy || {},
    invalidRunAuthority: run.present && run.valid !== true,
    invalidRoomAuthority: room.present && room.valid !== true,
  };
}

function shouldSuppressResolvedAbyssalNpcOutcome(context = {}, policyField) {
  if (context.invalidAbyssalOutcomeAuthority === true) {
    return true;
  }
  return Boolean(
    context.exact === true &&
      (!policyField || (context.policy && context.policy[policyField] === true))
  );
}

function shouldSuppressAbyssalNpcOutcome(entity, policyField) {
  return shouldSuppressResolvedAbyssalNpcOutcome(
    resolveExactAbyssalNpcOutcomeContext(entity),
    policyField,
  );
}

// Retain the original export for callers introduced alongside this module.
// Invalid but present Abyssal authority is deliberately included now: treating
// malformed aliases as ordinary NPC metadata would turn an integrity failure
// into a public bounty, standing, wreck, or killmail side effect.
function shouldSuppressExactAbyssalNpcOutcome(entity, policyField) {
  return shouldSuppressAbyssalNpcOutcome(entity, policyField);
}

module.exports = {
  ABYSSAL_ROOM_INDEX_FIELDS,
  ABYSSAL_RUN_ID_FIELDS,
  isNpcEntity,
  resolveExactAbyssalNpcOutcomeContext,
  shouldSuppressAbyssalNpcOutcome,
  shouldSuppressExactAbyssalNpcOutcome,
  shouldSuppressResolvedAbyssalNpcOutcome,
};
