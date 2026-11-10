"use strict";

// What a save keeps of a ship in warp, and how an older row saved in warp is
// read. A warp is not carried over a restart (doc/UPDATING.md "Ships saved
// in warp"):
//
// - a plain warp: the ship is stored stopped at its landing point, as if the
//   warp had finished;
// - a warp into a private site, or out of one (the warp names a destination
//   instance, or the ship carries a site tracker): the ship is stored
//   stopped where it is, with a savedWarpLanding record { targetPoint,
//   destinationStaticInstanceID, destinationDungeonRoomKey,
//   destinationDungeonSiteID }. Login (scene/sessions.js attachSession)
//   settles it: at the landing point with the destination's tracker when
//   the pilot may be there, where it is otherwise. A ship with no session
//   keeps the record until its pilot logs in;
// - a ship still aligning had not left: stored stopped where it is.
//
// An older row (mode WARP with main's warpState) is read by the same rule.
// Instance and site IDs fail closed: a malformed one is kept as
// "invalid-persistent-identity", which login refuses.

const path = require("path");
const {
  normalizePersistentEntityID,
  toJSONSafeEntityID,
} = require(path.join(__dirname, "../destiny/identity/entityID"));

const INVALID_PERSISTENT_IDENTITY = "invalid-persistent-identity";
const AT_REST = Object.freeze({ x: 0, y: 0, z: 0 });

function hasIdentityValue(value) {
  return value !== null && value !== undefined && String(value).trim() !== "";
}

function isFiniteVector(vector) {
  return Boolean(vector) &&
    Number.isFinite(Number(vector.x)) &&
    Number.isFinite(Number(vector.y)) &&
    Number.isFinite(Number(vector.z));
}

function copyVector(vector) {
  return { x: Number(vector.x), y: Number(vector.y), z: Number(vector.z) };
}

function normalizeIdentity(value) {
  if (!hasIdentityValue(value)) {
    return null;
  }
  const normalized = normalizePersistentEntityID(value);
  return normalized === null ? INVALID_PERSISTENT_IDENTITY : toJSONSafeEntityID(normalized);
}

// A savedWarpLanding record as stored, or null when it has no landing point.
function normalizeSavedWarpLanding(raw) {
  if (!raw || typeof raw !== "object" || !isFiniteVector(raw.targetPoint)) {
    return null;
  }
  const roomKey = String(raw.destinationDungeonRoomKey || "").trim();
  return {
    targetPoint: copyVector(raw.targetPoint),
    destinationStaticInstanceID: normalizeIdentity(raw.destinationStaticInstanceID),
    destinationDungeonRoomKey: roomKey || null,
    destinationDungeonSiteID: normalizeIdentity(raw.destinationDungeonSiteID),
  };
}

function isSiteWarp(destination, holder) {
  return hasIdentityValue(destination && destination.destinationStaticInstanceID) ||
    hasIdentityValue(holder && holder.dungeonCurrentInstanceID);
}

// What to store for a ship in mode WARP: { position, savedWarpLanding }, or
// null for any other mode. In warp, `entity.targetPoint` is the landing
// point: the goto point Evolve moved back by the warp-at range when the warp
// started (effectStamp is then the tick it entered warp on).
function describeWarpForSave(entity) {
  if (!entity || entity.mode !== "WARP") {
    return null;
  }
  const here = copyVector(entity.position);
  if (!(Number(entity.effectStamp) >= 0) || !isFiniteVector(entity.targetPoint)) {
    return { position: here, savedWarpLanding: null };
  }
  const destination = entity.warpDestination || {};
  if (isSiteWarp(destination, entity)) {
    return {
      position: here,
      savedWarpLanding: normalizeSavedWarpLanding({
        targetPoint: entity.targetPoint,
        destinationStaticInstanceID: destination.destinationStaticInstanceID,
        destinationDungeonRoomKey: destination.destinationDungeonRoomKey,
        destinationDungeonSiteID: destination.destinationDungeonSiteID,
      }),
    };
  }
  return { position: copyVector(entity.targetPoint), savedWarpLanding: null };
}

// An older row saved in warp (mode WARP, main's warpState), as this server
// stores it: stopped, at its warp's landing point for a plain warp, where it
// was with a savedWarpLanding record for a site warp, where it was for a
// warp still aligning. Any other spaceState is returned as it is.
function convertLegacySavedWarp(spaceState) {
  if (!spaceState || typeof spaceState !== "object" || spaceState.mode !== "WARP") {
    return spaceState;
  }
  const warp = spaceState.warpState && typeof spaceState.warpState === "object"
    ? spaceState.warpState
    : null;
  const converted = {
    ...spaceState,
    mode: "STOP",
    velocity: { ...AT_REST },
    speedFraction: 0,
    targetEntityID: null,
  };
  delete converted.warpState;
  delete converted.pendingWarp;
  if (!warp) {
    return converted;
  }
  if (isSiteWarp(warp, spaceState)) {
    // Main's login recovery settled a site warp at targetPoint, else at the
    // raw destination.
    const recoveryPoint = isFiniteVector(warp.targetPoint) ? warp.targetPoint : warp.rawDestination;
    if (!isFiniteVector(recoveryPoint)) {
      return converted;
    }
    converted.savedWarpLanding = normalizeSavedWarpLanding({
      targetPoint: recoveryPoint,
      destinationStaticInstanceID: warp.destinationStaticInstanceID,
      destinationDungeonRoomKey: warp.destinationDungeonRoomKey,
      destinationDungeonSiteID: warp.destinationDungeonSiteID,
    });
    return converted;
  }
  // A plain warp lands at its stop point, main's warpState.targetPoint (after
  // the warp-at range); a row without one stays where it was.
  if (isFiniteVector(warp.targetPoint)) {
    converted.position = copyVector(warp.targetPoint);
    converted.targetPoint = copyVector(warp.targetPoint);
  }
  return converted;
}

module.exports = {
  convertLegacySavedWarp,
  describeWarpForSave,
  normalizeSavedWarpLanding,
};
