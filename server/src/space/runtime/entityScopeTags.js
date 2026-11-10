"use strict";

module.exports = {
  applyRuntimeDungeonTrackingState,
  applyRuntimeEntityScopeMetadata,
  applyRuntimeIdentity,
  applyRuntimeNonNegativeInt64,
  applyRuntimePersistentIdentity,
  clearPlayerShipGenericDungeonScope,
  hasRuntimePersistentIdentityValue,
  replaceRuntimeDungeonTrackingState,
  resolveEntityOwnAbyssalRunID,
  serializeRuntimeDungeonTrackingState,
  serializeRuntimeEntityScopeMetadata,
  serializeRuntimePersistentIdentity,
};

const runtimeEntryDirname = require("path").resolve(__dirname, "..");
const path = require("path");
const {
  entityIDsEqual,
  getEntityMapKey,
  normalizeEntityID,
  normalizeEntityIDSet,
  normalizeNonNegativeInt64,
  normalizePersistentEntityID,
  toJSONSafeEntityID,
} = require(path.join(runtimeEntryDirname, "./destiny/identity/entityID.js"));
const {
  canEntitiesInteractLocally,
  isSharedPveTarget,
  resolveEntityInteractionScope,
} = require(path.join(runtimeEntryDirname, "./destiny/identity/interactionScope.js"));
const {
  toFiniteNumber,
} = require("../../common/numbers");

const INVALID_RUNTIME_PERSISTENT_IDENTITY = "invalid-persistent-identity";

function hasRuntimePersistentIdentityValue(value) {
  return (
    value !== null &&
    value !== undefined &&
    String(value).trim() !== ""
  );
}

function applyRuntimeIdentity(entity, key, rawValue, normalizeIdentity) {
  if (!hasRuntimePersistentIdentityValue(rawValue)) {
    return;
  }
  const candidate = normalizeIdentity(rawValue);
  const hasExisting = hasRuntimePersistentIdentityValue(entity[key]);
  const existing = hasExisting
    ? normalizeIdentity(entity[key])
    : null;
  if (
    candidate === null ||
    (hasExisting && (
      existing === null ||
      !entityIDsEqual(existing, candidate)
    ))
  ) {
    entity[key] = INVALID_RUNTIME_PERSISTENT_IDENTITY;
    return;
  }
  entity[key] = candidate;
}

function applyRuntimePersistentIdentity(entity, key, rawValue) {
  applyRuntimeIdentity(
    entity,
    key,
    rawValue,
    normalizePersistentEntityID,
  );
}

function applyRuntimeNonNegativeInt64(entity, key, rawValue) {
  applyRuntimeIdentity(entity, key, rawValue, normalizeNonNegativeInt64);
}

function serializeRuntimePersistentIdentity(entity, key) {
  const value = toJSONSafeEntityID(entity && entity[key]);
  if (value !== null) {
    return value;
  }
  return entity && hasRuntimePersistentIdentityValue(entity[key])
    ? INVALID_RUNTIME_PERSISTENT_IDENTITY
    : null;
}

function applyRuntimeEntityScopeMetadata(entity, scopeMetadata = {}) {
  if (!entity || !scopeMetadata || typeof scopeMetadata !== "object") {
    return entity;
  }
  for (const key of [
    "airNpeOwnerCharacterID",
    "airNpeOperationID",
    "airNpeInstanceID",
    "abyssalRunID",
    "evejsAbyssalInstanceID",
    "evejsAbyssalPocketInstanceID",
    "abyssalRoomIndex",
    "evejsAbyssalRoomIndex",
    "dungeonSiteID",
    "dungeonSiteInstanceID",
  ]) {
    applyRuntimePersistentIdentity(entity, key, scopeMetadata[key]);
  }
  for (const key of [
    "airNpeBoardingShipPresentation",
    "airNpeTutorialDebris",
    "airNpeHostile",
    "dungeonMaterializedContainer",
    "dungeonMaterializedSiteContent",
    "dungeonSiteContentBonus",
    "dungeonSiteContentFailureExplodes",
    "dungeonSiteContentFailureNeverDestroys",
    "dungeonSiteContentShowsContents",
    "dungeonSiteContentFailureLocksOut",
    "dungeonSiteContentCompletesSiteOnHack",
    "dungeonSiteContentPersistsAfterResponse",
  ]) {
    if (scopeMetadata[key] === true) {
      entity[key] = true;
    }
  }
  for (const key of [
    "airNpeHostileWave",
    "dungeonEncounterKey",
    "dungeonObjectiveTargetKey",
    "dungeonSiteContentKey",
    "dungeonSiteContentRole",
    "dungeonSiteContentAnalyzer",
    "dungeonSiteContentTrigger",
    "dungeonSiteContentLootProfile",
    "dungeonSiteContentHackingDifficulty",
    "homefrontKey",
    "homefrontRole",
  ]) {
    if (Object.prototype.hasOwnProperty.call(scopeMetadata, key)) {
      const value = String(scopeMetadata[key] == null ? "" : scopeMetadata[key]).trim();
      if (value) {
        entity[key] = value;
      }
    }
  }
  for (const key of [
    "dungeonSiteContentExplicitLoot",
    "dungeonSiteContentLootTags",
  ]) {
    if (Array.isArray(scopeMetadata[key])) {
      entity[key] = scopeMetadata[key].map((entry) => (
        entry && typeof entry === "object" ? { ...entry } : entry
      ));
    }
  }
  const hackingBoard = scopeMetadata.dungeonSiteContentHackingBoard;
  if (hackingBoard && typeof hackingBoard === "object" && !Array.isArray(hackingBoard)) {
    entity.dungeonSiteContentHackingBoard = structuredClone(hackingBoard);
  }
  return entity;
}

// An Abyssal participant ship legitimately carries its own run id under the
// generic site alias: buildAbyssalParticipantRoomScopeMetadata stamps
// dungeonSiteInstanceID = runID as part of the participant room scope, and
// abyssalRunScope.ABYSSAL_RUN_SCOPE_FIELDS lists that field as a run-id alias.
// That tag is the pilot's own pocket, not a content tag leaked from a site, so
// the generic-scope clear below must not treat it as a conflict. Poisoning it
// is not a harmless over-reach: the sentinel invalidates the entity's *entire*
// interaction scope, which fails the participant scope read-back on entry
// (ABYSSAL_PARTICIPANT_RUNTIME_SCOPE_INVALID) and would also stop the pilot
// interacting with anything on the grid.
function resolveEntityOwnAbyssalRunID(entity) {
  const scope = resolveEntityInteractionScope(entity);
  return scope && scope.hasAbyssalScope === true
    ? scope.abyssalInstanceID
    : null;
}

// The AIR boarding hull (airEncounterRuntime ensure) is site content of its
// owner's own AIR instance, waiting unpiloted for its owner to board it. Its
// site scope is that instance, not a tag leaked from a site: a reload keeps
// it, or the hull is refused (scene missionAccess hasMalformedScope) and the
// tutorial cannot resume.
function isOwnAirBoardingHullScope(entity) {
  if (entity.session) {
    return false;
  }
  const airInstanceID = normalizePersistentEntityID(entity.airNpeInstanceID);
  const siteInstanceID = normalizePersistentEntityID(entity.dungeonSiteInstanceID);
  const airOwnerID = normalizePersistentEntityID(entity.airNpeOwnerCharacterID);
  return Boolean(
    airInstanceID !== null &&
    siteInstanceID !== null &&
    airOwnerID !== null &&
    entityIDsEqual(airInstanceID, siteInstanceID) &&
    entityIDsEqual(airOwnerID, normalizePersistentEntityID(entity.ownerID))
  );
}

function clearPlayerShipGenericDungeonScope(entity, options = {}) {
  if (
    !entity ||
    entity.kind !== "ship" ||
    (!entity.session && options.playerOwned !== true)
  ) {
    return entity;
  }
  if (isOwnAirBoardingHullScope(entity)) {
    return entity;
  }
  const hasGenericInstanceID = hasRuntimePersistentIdentityValue(
    entity.dungeonSiteInstanceID,
  );
  const hasGenericSiteID = hasRuntimePersistentIdentityValue(
    entity.dungeonSiteID,
  );
  const genericInstanceID = hasGenericInstanceID
    ? normalizePersistentEntityID(entity.dungeonSiteInstanceID)
    : null;
  const abyssalInstanceAliases = [
    entity.abyssalRunID,
    entity.evejsAbyssalInstanceID,
    entity.evejsAbyssalPocketInstanceID,
  ]
    .filter((value) => hasRuntimePersistentIdentityValue(value))
    .map((value) => normalizePersistentEntityID(value));
  const genericInstanceBackedByExactAbyssalScope = Boolean(
    genericInstanceID !== null &&
    abyssalInstanceAliases.length > 0 &&
    abyssalInstanceAliases.every(
      (abyssalInstanceID) =>
        abyssalInstanceID !== null &&
        entityIDsEqual(abyssalInstanceID, genericInstanceID),
    )
  );
  if (hasGenericInstanceID) {
    const currentInstanceID = normalizePersistentEntityID(
      entity.dungeonCurrentInstanceID,
    );
    if (
      !genericInstanceBackedByExactAbyssalScope &&
      (
        genericInstanceID === null ||
        currentInstanceID === null ||
        !entityIDsEqual(genericInstanceID, currentInstanceID)
      )
    ) {
      const ownAbyssalRunID = genericInstanceID === null
        ? null
        : resolveEntityOwnAbyssalRunID(entity);
      if (
        ownAbyssalRunID === null ||
        !entityIDsEqual(genericInstanceID, ownAbyssalRunID)
      ) {
        entity.dungeonCurrentInstanceID =
          INVALID_RUNTIME_PERSISTENT_IDENTITY;
      }
    }
  }
  if (hasGenericSiteID) {
    const genericSiteID = normalizePersistentEntityID(entity.dungeonSiteID);
    const currentInstanceID = normalizePersistentEntityID(
      entity.dungeonCurrentInstanceID,
    );
    const hasCurrentSiteID = hasRuntimePersistentIdentityValue(
      entity.dungeonCurrentSiteID,
    );
    const currentSiteID = hasCurrentSiteID
      ? normalizePersistentEntityID(entity.dungeonCurrentSiteID)
      : null;
    if (
      genericSiteID === null ||
      currentInstanceID === null ||
      (hasCurrentSiteID && (
        currentSiteID === null ||
        !entityIDsEqual(genericSiteID, currentSiteID)
      ))
    ) {
      entity.dungeonCurrentInstanceID =
        INVALID_RUNTIME_PERSISTENT_IDENTITY;
    }
  }
  delete entity.dungeonSiteID;
  delete entity.dungeonSiteInstanceID;
  return entity;
}

function serializeRuntimeEntityScopeMetadata(entity) {
  if (!entity || typeof entity !== "object") {
    return {};
  }
  const serialized = {};
  const isAttachedPlayerShip = entity.kind === "ship" && Boolean(entity.session);
  for (const key of [
    "airNpeOwnerCharacterID",
    "airNpeOperationID",
    "airNpeInstanceID",
    "abyssalRunID",
    "evejsAbyssalInstanceID",
    "evejsAbyssalPocketInstanceID",
    "abyssalRoomIndex",
    "evejsAbyssalRoomIndex",
    "dungeonSiteID",
    "dungeonSiteInstanceID",
  ]) {
    if (
      isAttachedPlayerShip &&
      (key === "dungeonSiteID" || key === "dungeonSiteInstanceID")
    ) {
      continue;
    }
    const value = serializeRuntimePersistentIdentity(entity, key);
    if (value !== null) {
      serialized[key] = value;
    }
  }
  for (const key of [
    "airNpeBoardingShipPresentation",
    "airNpeTutorialDebris",
    "airNpeHostile",
    "dungeonMaterializedContainer",
    "dungeonMaterializedSiteContent",
    "dungeonSiteContentBonus",
    "dungeonSiteContentFailureExplodes",
    "dungeonSiteContentFailureNeverDestroys",
    "dungeonSiteContentShowsContents",
    "dungeonSiteContentFailureLocksOut",
    "dungeonSiteContentCompletesSiteOnHack",
    "dungeonSiteContentPersistsAfterResponse",
  ]) {
    if (entity[key] === true) {
      serialized[key] = true;
    }
  }
  for (const key of [
    "airNpeHostileWave",
    "dungeonEncounterKey",
    "dungeonObjectiveTargetKey",
    "dungeonSiteContentKey",
    "dungeonSiteContentRole",
    "dungeonSiteContentAnalyzer",
    "dungeonSiteContentTrigger",
    "dungeonSiteContentLootProfile",
    "dungeonSiteContentHackingDifficulty",
    "homefrontKey",
    "homefrontRole",
  ]) {
    const value = String(entity[key] == null ? "" : entity[key]).trim();
    if (value) {
      serialized[key] = value;
    }
  }
  for (const key of [
    "dungeonSiteContentExplicitLoot",
    "dungeonSiteContentLootTags",
  ]) {
    if (Array.isArray(entity[key])) {
      serialized[key] = entity[key].map((entry) => (
        entry && typeof entry === "object" ? { ...entry } : entry
      ));
    }
  }
  const hackingBoard = entity.dungeonSiteContentHackingBoard;
  if (hackingBoard && typeof hackingBoard === "object" && !Array.isArray(hackingBoard)) {
    serialized.dungeonSiteContentHackingBoard = structuredClone(hackingBoard);
  }
  return serialized;
}

function applyRuntimeDungeonTrackingState(entity, trackingState = {}) {
  if (!entity || !trackingState || typeof trackingState !== "object") {
    return entity;
  }
  for (const key of [
    "dungeonCurrentInstanceID",
    "dungeonCurrentDungeonID",
    "dungeonCurrentSiteID",
    "dungeonCompletedNotifiedInstanceID",
  ]) {
    applyRuntimePersistentIdentity(entity, key, trackingState[key]);
  }
  applyRuntimeNonNegativeInt64(
    entity,
    "dungeonCurrentRoomID",
    trackingState.dungeonCurrentRoomID,
  );
  const roomKey = String(
    trackingState.dungeonCurrentRoomKey || "",
  ).trim();
  if (roomKey) {
    entity.dungeonCurrentRoomKey = roomKey;
  }
  const roomPosition = Array.isArray(
    trackingState.dungeonCurrentRoomPosition,
  )
    ? trackingState.dungeonCurrentRoomPosition
    : null;
  if (roomPosition && roomPosition.length >= 3) {
    entity.dungeonCurrentRoomPosition = [
      toFiniteNumber(roomPosition[0], 0),
      toFiniteNumber(roomPosition[1], 0),
      toFiniteNumber(roomPosition[2], 0),
    ];
  }
  const updatedAtMs = toFiniteNumber(
    trackingState.dungeonCurrentUpdatedAtMs,
    0,
  );
  if (updatedAtMs > 0) {
    entity.dungeonCurrentUpdatedAtMs = updatedAtMs;
  }
  return entity;
}

function replaceRuntimeDungeonTrackingState(entity, trackingState = {}) {
  if (!entity || !trackingState || typeof trackingState !== "object") {
    return entity;
  }
  for (const key of [
    "dungeonCurrentInstanceID",
    "dungeonCurrentDungeonID",
    "dungeonCurrentRoomID",
    "dungeonCurrentRoomKey",
    "dungeonCurrentRoomPosition",
    "dungeonCurrentSiteID",
    "dungeonCurrentUpdatedAtMs",
    "dungeonCompletedNotifiedInstanceID",
  ]) {
    delete entity[key];
  }
  return applyRuntimeDungeonTrackingState(entity, trackingState);
}

function serializeRuntimeDungeonTrackingState(entity) {
  if (!entity || typeof entity !== "object") {
    return {};
  }
  const serialized = {};
  for (const key of [
    "dungeonCurrentInstanceID",
    "dungeonCurrentDungeonID",
    "dungeonCurrentSiteID",
    "dungeonCompletedNotifiedInstanceID",
  ]) {
    const value = serializeRuntimePersistentIdentity(entity, key);
    if (value !== null) {
      serialized[key] = value;
    }
  }
  const roomID = normalizeNonNegativeInt64(entity.dungeonCurrentRoomID);
  if (roomID !== null) {
    serialized.dungeonCurrentRoomID = toJSONSafeEntityID(roomID);
  } else if (hasRuntimePersistentIdentityValue(entity.dungeonCurrentRoomID)) {
    serialized.dungeonCurrentRoomID = INVALID_RUNTIME_PERSISTENT_IDENTITY;
  }
  const roomKey = String(entity.dungeonCurrentRoomKey || "").trim();
  if (roomKey) {
    serialized.dungeonCurrentRoomKey = roomKey;
  }
  if (
    Array.isArray(entity.dungeonCurrentRoomPosition) &&
    entity.dungeonCurrentRoomPosition.length >= 3
  ) {
    serialized.dungeonCurrentRoomPosition = [
      toFiniteNumber(entity.dungeonCurrentRoomPosition[0], 0),
      toFiniteNumber(entity.dungeonCurrentRoomPosition[1], 0),
      toFiniteNumber(entity.dungeonCurrentRoomPosition[2], 0),
    ];
  }
  const updatedAtMs = toFiniteNumber(entity.dungeonCurrentUpdatedAtMs, 0);
  if (updatedAtMs > 0) {
    serialized.dungeonCurrentUpdatedAtMs = updatedAtMs;
  }
  return serialized;
}

Object.assign(module.exports, {
  INVALID_RUNTIME_PERSISTENT_IDENTITY,
});
