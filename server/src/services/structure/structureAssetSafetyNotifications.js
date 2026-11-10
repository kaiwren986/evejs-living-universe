"use strict";

const path = require("path");
const sessionRegistry = require(path.join(__dirname, "../chat/sessionRegistry"));
const { unwrapMarshalValue } = require(path.join(__dirname, "../_shared/serviceHelpers"));

function normalizeInt(value, fallback = 0) {
  const numeric = Number(unwrapMarshalValue(value));
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function normalizePositiveInt(value, fallback = 0) {
  const numeric = normalizeInt(value, fallback);
  return numeric > 0 ? numeric : fallback;
}

function getSessionCharacterID(session) {
  return normalizePositiveInt(
    session && (session.characterID || session.charID || session.charid || session.userid),
    0,
  );
}

function getSessionCorporationID(session) {
  return normalizePositiveInt(
    session && (session.corporationID || session.corpid),
    0,
  );
}

function getNotificationTargets(ownerKind, ownerID, fallbackSession = null) {
  const normalizedOwnerKind = String(ownerKind || "char").trim().toLowerCase() === "corp"
    ? "corp"
    : "char";
  const normalizedOwnerID = normalizePositiveInt(ownerID, 0);
  const targets = new Set();

  if (fallbackSession) {
    targets.add(fallbackSession);
  }

  for (const session of sessionRegistry.getSessions()) {
    const sessionOwnerID = normalizedOwnerKind === "corp"
      ? getSessionCorporationID(session)
      : getSessionCharacterID(session);
    if (sessionOwnerID === normalizedOwnerID) {
      targets.add(session);
    }
  }

  return [...targets].filter(
    (session) => session && typeof session.sendNotification === "function",
  );
}

function notifyAssetSafetyCreated(session, wrap) {
  if (!wrap) {
    return;
  }

  const ownerID = normalizePositiveInt(wrap.ownerID, 0);
  const solarSystemID = normalizePositiveInt(wrap.solarSystemID, 0);
  const sourceStructureID = normalizePositiveInt(wrap.sourceStructureID, 0);
  for (const targetSession of getNotificationTargets(wrap.ownerKind, ownerID, session)) {
    targetSession.sendNotification("OnAssetSafetyCreated", "clientID", [
      ownerID,
      solarSystemID,
      sourceStructureID,
    ]);
  }
}

function notifyAssetSafetyDelivered(session, wrap) {
  if (!wrap) {
    return;
  }

  const ownerID = normalizePositiveInt(wrap.ownerID, 0);
  for (const targetSession of getNotificationTargets(wrap.ownerKind, ownerID, session)) {
    targetSession.sendNotification("OnAssetSafetyDelivered", "clientID", [
      ownerID,
    ]);
  }
}

module.exports = { notifyAssetSafetyCreated, notifyAssetSafetyDelivered };
