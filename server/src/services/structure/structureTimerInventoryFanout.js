"use strict";

/**
 * Tells clients about structure bay rows that the hourly structure timer
 * changed.
 *
 * The structure timer (structureState.tickStructures) burns service-module
 * fuel, FLEX built-in fuel and Metenox fuel and magmatic gas, and lands
 * Metenox moon material in the output bay. Those item writes happen with no
 * player call, so nobody else publishes them. The client keeps a container's
 * rows from its first List and only revises them from OnItemsChanged
 * (invCache.py:219), so without this the fuel bay never drains and Metenox
 * output never appears until relog.
 *
 * Audience and idtype follow the retail capture of a citadel fuel charge
 * (golden log "Citadel Take Control - Load Fuel - Fit service ...", lines
 * 10386-10414): the same row went out once with idtype shipid (the pilot
 * controlling the structure) and once with idtype *solarsystemid&corpid (the
 * owner corporation's members in that system). That capture is the online
 * charge; no hourly charge was captured, so the hourly shape is assumed to be
 * the same. Each session here receives one copy.
 *
 * A service module the timer turned offline for lack of fuel is also told to
 * the controlling pilot the way a manual offline is (moduleOperation.js
 * SetModuleOnlineState): its isOnline attribute and the stop of its online
 * effect, in one OnMultiEvent. Structure service state itself already reaches
 * docked sessions as OnStructureServiceChanged through the structure change
 * listeners.
 */

const path = require("path");
const log = require(path.join(__dirname, "../../utils/logger"));

const FILETIME_EPOCH_OFFSET = 116444736000000000n;
const FALLBACK_ATTRIBUTE_IS_ONLINE = 2;
const FALLBACK_EFFECT_ONLINE = 16;

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function getSessionShipID(session) {
  return toInt(session && (session.shipID || session.shipid), 0);
}

function getSessionCorporationID(session) {
  return toInt(session && (session.corporationID || session.corpid), 0);
}

function getSessionSolarSystemID(session) {
  return toInt(
    session && (
      session.solarsystemid2 ||
      session.solarsystemid ||
      (session._space && session._space.systemID)
    ),
    0,
  );
}

function getSessionCharacterID(session) {
  return toInt(session && (session.characterID || session.charid), 0);
}

function getStructureOwnerCorporationID(structure) {
  return toInt(
    structure && (structure.ownerCorpID || structure.ownerID || structure.corporationID),
    0,
  );
}

function normalizeChanges(changes) {
  return (Array.isArray(changes) ? changes : [])
    .filter((change) => change && change.item && typeof change.item === "object")
    .map((change) => ({
      item: change.item,
      previousData: change.previousData || change.previousState || {},
    }));
}

function sessionFileTime(session) {
  const fallback = BigInt(Date.now()) * 10000n + FILETIME_EPOCH_OFFSET;
  if (!session || !session._space) {
    return fallback;
  }
  try {
    const runtime = require(path.join(__dirname, "../../space/runtime"));
    if (typeof runtime.getSimulationFileTimeForSession === "function") {
      return runtime.getSimulationFileTimeForSession(session, fallback);
    }
  } catch (_error) {
    // Fall back to wall-clock time; the event order is what matters here.
  }
  return fallback;
}

function resolveDogmaIDs() {
  let isOnlineAttributeID = FALLBACK_ATTRIBUTE_IS_ONLINE;
  let onlineEffectID = FALLBACK_EFFECT_ONLINE;
  try {
    const fitting = require(path.join(__dirname, "../fitting/liveFittingState"));
    isOnlineAttributeID = fitting.getAttributeIDByNames("isOnline") || isOnlineAttributeID;
  } catch (_error) {
    // Static dogma is unavailable in some isolated tests; the IDs are fixed.
  }
  try {
    const { EFFECT_ONLINE } = require(path.join(__dirname, "../dogma/dogmaService/shared"));
    onlineEffectID = EFFECT_ONLINE || onlineEffectID;
  } catch (_error) {
    // As above.
  }
  return { isOnlineAttributeID, onlineEffectID };
}

function sendServiceModulesOfflined(session, structureID, moduleIDs) {
  const ids = [...new Set((Array.isArray(moduleIDs) ? moduleIDs : [])
    .map((moduleID) => toInt(moduleID, 0))
    .filter((moduleID) => moduleID > 0))];
  if (ids.length === 0) {
    return false;
  }
  const {
    buildModuleAttributeChangeEvent,
    buildGodmaShipEffectEvent,
    sendOnMultiEvent,
  } = require(path.join(__dirname, "../_shared/godmaMultiEvent"));
  const { isOnlineAttributeID, onlineEffectID } = resolveDogmaIDs();
  const characterID = getSessionCharacterID(session);
  const time = sessionFileTime(session);
  const subEvents = [];
  for (const moduleID of ids) {
    subEvents.push(
      buildModuleAttributeChangeEvent(characterID, moduleID, isOnlineAttributeID, 0, 1, time),
      buildGodmaShipEffectEvent(moduleID, characterID, structureID, onlineEffectID, time, {
        isStart: 0,
        shouldStart: 0,
      }),
    );
  }
  return sendOnMultiEvent(session, subEvents, time);
}

/**
 * @param {object} structure          the structure row after the timer pass
 * @param {object[]} changes          inventory changes the timer made in its bays
 * @param {object} [options]
 * @param {number[]} [options.offlinedModuleIDs] service modules the timer offlined
 * @param {object[]} [options.sessions] sessions to consider (defaults to all)
 * @returns {{controllerCount: number, corporationCount: number}}
 */
function publishStructureTimerInventoryChanges(structure, changes = [], options = {}) {
  const result = { controllerCount: 0, corporationCount: 0 };
  const structureID = toInt(structure && structure.structureID, 0);
  if (structureID <= 0) {
    return result;
  }
  const rows = normalizeChanges(changes);
  const offlinedModuleIDs = Array.isArray(options.offlinedModuleIDs)
    ? options.offlinedModuleIDs
    : [];
  if (rows.length === 0 && offlinedModuleIDs.length === 0) {
    return result;
  }
  const solarSystemID = toInt(structure.solarSystemID, 0);
  const ownerCorporationID = getStructureOwnerCorporationID(structure);
  const sessions = Array.isArray(options.sessions)
    ? options.sessions
    : require(path.join(__dirname, "../chat/sessionRegistry")).getSessions();
  const { emitItemsChangedBatchForSession } = require(path.join(
    __dirname,
    "../character/characterState",
  ));

  for (const session of sessions) {
    if (!session || typeof session.sendNotification !== "function") {
      continue;
    }
    try {
      if (getSessionShipID(session) === structureID) {
        if (rows.length > 0) {
          emitItemsChangedBatchForSession(session, rows, { idType: "shipid" });
        }
        sendServiceModulesOfflined(session, structureID, offlinedModuleIDs);
        result.controllerCount += 1;
        continue;
      }
      if (
        rows.length > 0 &&
        ownerCorporationID > 0 &&
        solarSystemID > 0 &&
        getSessionCorporationID(session) === ownerCorporationID &&
        getSessionSolarSystemID(session) === solarSystemID
      ) {
        emitItemsChangedBatchForSession(session, rows, { idType: "*solarsystemid&corpid" });
        result.corporationCount += 1;
      }
    } catch (error) {
      // The item writes are already committed; one bad connection must not
      // stop the timer pass or the next session's update.
      log.warn(
        `[StructureTimerInventory] fan-out failed structure=${structureID}: ${error && error.message}`,
      );
    }
  }
  return result;
}

module.exports = {
  publishStructureTimerInventoryChanges,
};
