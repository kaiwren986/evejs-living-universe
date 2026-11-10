"use strict";

// Keeps the client's system-wide effect HUD in step with the solar system the
// pilot is in. Retail sends one OnSystemWideEffectStart(effectID, sourceItemID,
// sourceTypeID) per effect on arrival and a matching OnSystemWideEffectStop on
// departure, idtype charid (LOGS\Tutorial\wh.lsw, nulldone.lsw;
// LOGS\Abyssal\TQCalmAbysaal1.txt lines 786 and 203918, where an incursion
// effect stops on Abyssal entry and starts again on return). Retail never
// sends OnUpdateSystemWideEffectsInfo as a notification; that scatter comes
// from GetAllInfo's systemWideEffectsOnShip, and the client only applies it
// when the dict is non-empty (godma.py), so an empty GetAllInfo never clears
// a stale effect. Every space arrival runs this diff, whatever the route.

const path = require("path");

const {
  getSystemEnvironmentDescriptor,
  EFFECT_BEACON_ITEM_ID_BASE,
} = require(path.join(__dirname, "./wormholeEnvironmentRuntime"));

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

// The same (effectID, sourceItemID, sourceTypeID) triples that
// buildSystemWideEffectsPayloadForSystem puts in the GetAllInfo dict.
function collectSystemWideEffectTriples(systemID) {
  const descriptor = getSystemEnvironmentDescriptor(toInt(systemID, 0));
  if (!descriptor || toInt(descriptor.environmentEffectTypeID, 0) <= 0) {
    return [];
  }
  const sourceItemID = EFFECT_BEACON_ITEM_ID_BASE + toInt(descriptor.systemID, 0);
  const sourceTypeID = toInt(descriptor.environmentEffectTypeID, 0);
  const effectIDs = [...new Set(
    (Array.isArray(descriptor.sourceEffects) ? descriptor.sourceEffects : [])
      .map((effectRecord) => toInt(effectRecord && effectRecord.effectID, 0))
      .filter((effectID) => effectID > 0),
  )].sort((left, right) => left - right);
  return effectIDs.map((effectID) => [effectID, sourceItemID, sourceTypeID]);
}

function tripleKey(triple) {
  return `${triple[0]}:${triple[1]}:${triple[2]}`;
}

function getSentTriples(session) {
  return session && Array.isArray(session._systemWideEffectsSent)
    ? session._systemWideEffectsSent
    : [];
}

// GetAllInfo replaced the client's dict with this system's effects (the client
// ignores an empty dict, so only a non-empty one changes what it holds).
function recordSessionSystemWideEffectsFromAllInfo(session, systemID) {
  if (!session) {
    return false;
  }
  const triples = collectSystemWideEffectTriples(systemID);
  if (triples.length === 0) {
    return false;
  }
  session._systemWideEffectsSent = triples;
  return true;
}

// systemID 0 (or any system without an environment, Abyssal pockets included)
// stops everything the client was told about.
function syncSessionSystemWideEffects(session, systemID) {
  if (!session || typeof session.sendNotification !== "function") {
    return { stopped: 0, started: 0 };
  }
  const previous = getSentTriples(session);
  const next = collectSystemWideEffectTriples(systemID);
  const nextKeys = new Set(next.map(tripleKey));
  const previousKeys = new Set(previous.map(tripleKey));

  let stopped = 0;
  for (const triple of previous) {
    if (nextKeys.has(tripleKey(triple))) {
      continue;
    }
    session.sendNotification("OnSystemWideEffectStop", "charid", [...triple]);
    stopped += 1;
  }
  let started = 0;
  for (const triple of next) {
    if (previousKeys.has(tripleKey(triple))) {
      continue;
    }
    session.sendNotification("OnSystemWideEffectStart", "charid", [...triple]);
    started += 1;
  }
  session._systemWideEffectsSent = next;
  return { stopped, started };
}

module.exports = {
  collectSystemWideEffectTriples,
  recordSessionSystemWideEffectsFromAllInfo,
  syncSessionSystemWideEffects,
};
