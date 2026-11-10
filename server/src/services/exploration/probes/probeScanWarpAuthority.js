"use strict";

const {
  toInt,
} = require("../../../common/numbers");

const path = require("path");

const {
  normalizePersistentEntityID,
} = require(path.join(
  __dirname,
  "../../../space/destiny/identity/entityID.js",
));

const completedScanBySession = new WeakMap();

function normalizeSystemID(value) {
  return Math.max(0, toInt(value, 0));
}

function resolveSessionSystemID(session) {
  return normalizeSystemID(
    session && (session.solarsystemid2 || session.solarsystemid),
  );
}

function normalizeTargetKey(value) {
  const persistentID = normalizePersistentEntityID(value);
  if (persistentID !== null) {
    return `entity:${persistentID.toString()}`;
  }
  const text = String(value == null ? "" : value).trim().toUpperCase();
  return text ? `signature:${text}` : null;
}

function normalizePoint(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  const source = Array.isArray(value)
    ? { x: value[0], y: value[1], z: value[2] }
    : value;
  const point = {
    x: Number(source.x),
    y: Number(source.y),
    z: Number(source.z),
  };
  return Object.values(point).every(Number.isFinite) ? point : null;
}

function normalizeWarpTarget(target) {
  if (!target || typeof target !== "object" || Array.isArray(target)) {
    return null;
  }
  const key = normalizeTargetKey(target.targetID);
  const point = normalizePoint(target.point || target.position);
  if (!key || !point) {
    return null;
  }
  const instanceID = normalizePersistentEntityID(
    target.destinationStaticInstanceID ?? target.instanceID,
  );
  const roomKey = String(
    target.destinationDungeonRoomKey ?? target.roomKey ?? "",
  ).trim() || null;
  const siteID = normalizePersistentEntityID(
    target.destinationDungeonSiteID ?? target.siteID,
  );
  return {
    destinationDungeonRoomKey: roomKey,
    destinationDungeonSiteID: siteID,
    destinationStaticInstanceID: instanceID,
    point,
    targetID: target.targetID,
  };
}

// A fresh completed scan replaces the prior result set. This prevents a caller
// from manufacturing numeric scan warps and keeps scan authority scoped to the
// exact session and solar system in which the 100% result was produced.
function recordCompletedScan(session, scanResult) {
  if (!session || typeof session !== "object") {
    return false;
  }
  const systemID = normalizeSystemID(
    scanResult && scanResult.systemID,
  ) || resolveSessionSystemID(session);
  const targetsByKey = new Map();
  const rawTargets = Array.isArray(scanResult && scanResult.perfectWarpTargets)
    ? scanResult.perfectWarpTargets
    : [];
  for (const rawTarget of rawTargets) {
    const target = normalizeWarpTarget(rawTarget);
    const key = target && normalizeTargetKey(target.targetID);
    if (target && key) {
      targetsByKey.set(key, target);
    }
  }
  completedScanBySession.set(session, {
    systemID,
    targetsByKey,
  });
  return true;
}

function resolveCompletedScanWarpTarget(session, targetID, options = {}) {
  if (!session || typeof session !== "object") {
    return null;
  }
  const state = completedScanBySession.get(session);
  const key = normalizeTargetKey(targetID);
  const systemID = normalizeSystemID(options.systemID) || resolveSessionSystemID(session);
  if (!state || !key || systemID <= 0 || state.systemID !== systemID) {
    return null;
  }
  const target = state.targetsByKey.get(key);
  return target
    ? {
        ...target,
        point: { ...target.point },
      }
    : null;
}

function clearSession(session) {
  return Boolean(session && completedScanBySession.delete(session));
}

module.exports = {
  clearSession,
  recordCompletedScan,
  resolveCompletedScanWarpTarget,
};
