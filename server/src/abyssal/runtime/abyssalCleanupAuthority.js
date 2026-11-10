"use strict";

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

// Read-only cleanup inspection: canonical run/room identity is authoritative;
// legacy run-only records still require their historical proximity guard.
function listPocketCleanupAnchors({
  buildPlaceholderRoomState,
  getObjectPosition,
}, pocketState) {
  const anchors = [];
  if (!pocketState) {
    return anchors;
  }

  const roomState = buildPlaceholderRoomState(pocketState);
  for (const roomEntry of Object.values(roomState.roomStatesByIndex || {})) {
    const anchor = getObjectPosition(roomEntry && roomEntry.roomOriginPosition);
    if (anchor) {
      anchors.push({
        roomIndex: toInt(roomEntry && roomEntry.roomIndex, 0),
        position: anchor,
      });
    }
  }

  const pocketAnchor = getObjectPosition(pocketState.pocketPosition);
  if (pocketAnchor) {
    anchors.push({ roomIndex: 0, position: pocketAnchor });
  }
  return anchors;
}

function isItemWithinPocketCleanupAnchors({
  getObjectPosition,
  getVectorDistance,
  PLACEHOLDER_ROOM_CLEANUP_RADIUS_METERS,
}, item, anchors) {
  const itemPosition = getObjectPosition(item);
  if (!itemPosition || !Array.isArray(anchors) || anchors.length === 0) {
    return false;
  }
  return anchors.some((anchor) =>
    getVectorDistance(itemPosition, getObjectPosition(anchor && anchor.position)) <=
      PLACEHOLDER_ROOM_CLEANUP_RADIUS_METERS);
}

function inspectResidualPocketItemAuthority({
  parseCustomInfo,
  buildPlaceholderRoomState,
  isItemWithinPocketCleanupAnchors,
}, item, pocketState, cleanupAnchors) {
  const expectedRunID = toInt(pocketState && pocketState.instanceID, 0);
  const runAliases = [];
  const roomAliases = [];
  let invalidRunAlias = false;
  let invalidRoomAlias = false;
  const collectAlias = (source, key, target, invalidSetter) => {
    if (!source || typeof source !== "object" || !Object.prototype.hasOwnProperty.call(source, key)) {
      return;
    }
    const value = toInt(source[key], 0);
    if (value > 0) {
      target.push(value);
    } else {
      invalidSetter();
    }
  };
  const collectTopLevelAliases = (source) => {
    for (const key of ["abyssalRunID", "evejsAbyssalInstanceID", "evejsAbyssalPocketInstanceID"]) {
      collectAlias(source, key, runAliases, () => { invalidRunAlias = true; });
    }
    for (const key of ["abyssalRoomIndex", "evejsAbyssalRoomIndex"]) {
      collectAlias(source, key, roomAliases, () => { invalidRoomAlias = true; });
    }
  };
  collectTopLevelAliases(item);
  collectTopLevelAliases(item && item.spaceState);

  const parsedCustomInfo = parseCustomInfo(item && item.customInfo);
  for (const [key, state] of Object.entries(parsedCustomInfo || {})) {
    if (!String(key).startsWith("evejsAbyssal") || !state || typeof state !== "object") {
      continue;
    }
    for (const aliasKey of [
      "instanceID",
      "runID",
      "abyssalRunID",
      "evejsAbyssalInstanceID",
      "evejsAbyssalPocketInstanceID",
    ]) {
      collectAlias(state, aliasKey, runAliases, () => { invalidRunAlias = true; });
    }
    for (const aliasKey of ["roomIndex", "abyssalRoomIndex", "evejsAbyssalRoomIndex"]) {
      collectAlias(state, aliasKey, roomAliases, () => { invalidRoomAlias = true; });
    }
  }

  const distinctRunIDs = [...new Set(runAliases)];
  const distinctRoomIndexes = [...new Set(roomAliases)];
  if (invalidRunAlias || distinctRunIDs.length === 0) {
    return {
      authorized: false,
      reason: invalidRunAlias ? "INVALID_RUN_ALIAS" : "UNTAGGED_RUN",
      runIDs: distinctRunIDs,
      roomIndexes: distinctRoomIndexes,
    };
  }
  if (distinctRunIDs.length !== 1) {
    return {
      authorized: false,
      reason: "CONFLICTING_RUN_ALIASES",
      runIDs: distinctRunIDs,
      roomIndexes: distinctRoomIndexes,
    };
  }
  if (distinctRunIDs[0] !== expectedRunID) {
    return {
      authorized: false,
      reason: "FOREIGN_RUN",
      runIDs: distinctRunIDs,
      roomIndexes: distinctRoomIndexes,
    };
  }
  if (invalidRoomAlias || distinctRoomIndexes.length > 1) {
    return {
      authorized: false,
      reason: invalidRoomAlias ? "INVALID_ROOM_ALIAS" : "CONFLICTING_ROOM_ALIASES",
      runIDs: distinctRunIDs,
      roomIndexes: distinctRoomIndexes,
    };
  }
  if (distinctRoomIndexes.length === 1) {
    const roomState = buildPlaceholderRoomState(pocketState);
    const knownRoomIndexes = new Set(
      [
        ...Object.values(roomState.roomStatesByIndex || {})
          .map((roomEntry) => toInt(roomEntry && roomEntry.roomIndex, 0)),
        ...Array.from(
          { length: Math.max(0, toInt(roomState.implementedRooms, 0)) },
          (_, index) => index + 1,
        ),
      ].filter((roomIndex) => roomIndex > 0),
    );
    if (!knownRoomIndexes.has(distinctRoomIndexes[0])) {
      return {
        authorized: false,
        reason: "UNKNOWN_ROOM",
        runIDs: distinctRunIDs,
        roomIndexes: distinctRoomIndexes,
      };
    }
    // Canonical run + room identity is the deletion authority. Player-created
    // objects (notably corpses and scanner probes) can drift or be launched far
    // outside an authored room anchor, so position must not veto exact scope.
    return {
      authorized: true,
      reason: "EXACT_RUN_ROOM_AUTHORITY",
      runIDs: distinctRunIDs,
      roomIndexes: distinctRoomIndexes,
      canonical: true,
    };
  }
  // Old records did not persist a room identity. Keep their historical
  // collision guard: exact run-only metadata is insufficient without a pocket
  // anchor match.
  if (!isItemWithinPocketCleanupAnchors(item, cleanupAnchors)) {
    return {
      authorized: false,
      reason: "LEGACY_RUN_ANCHOR_REQUIRED",
      runIDs: distinctRunIDs,
      roomIndexes: distinctRoomIndexes,
    };
  }
  return {
    authorized: true,
    reason: "LEGACY_RUN_ANCHOR_AUTHORITY",
    runIDs: distinctRunIDs,
    roomIndexes: distinctRoomIndexes,
    canonical: false,
  };
}

function createAbyssalCleanupAuthority({
  buildPlaceholderRoomState,
  getObjectPosition,
  getVectorDistance,
  PLACEHOLDER_ROOM_CLEANUP_RADIUS_METERS,
  parseCustomInfo,
}) {

  const ports = {
    buildPlaceholderRoomState,
    getObjectPosition,
    getVectorDistance,
    PLACEHOLDER_ROOM_CLEANUP_RADIUS_METERS,
    parseCustomInfo,
  };
  ports.listPocketCleanupAnchors = listPocketCleanupAnchors.bind(null, ports);
  ports.isItemWithinPocketCleanupAnchors = isItemWithinPocketCleanupAnchors.bind(null, ports);
  ports.inspectResidualPocketItemAuthority = inspectResidualPocketItemAuthority.bind(null, ports);
  Object.freeze(ports);
  return { listPocketCleanupAnchors: ports.listPocketCleanupAnchors, isItemWithinPocketCleanupAnchors: ports.isItemWithinPocketCleanupAnchors, inspectResidualPocketItemAuthority: ports.inspectResidualPocketItemAuthority };
}

module.exports = { createAbyssalCleanupAuthority };
