"use strict";

const crypto = require("crypto");

const WORMHOLE_ENDPOINT_ID_BASE = 9_920_000_000_000;
const TARGET_VERSION = 4;

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function cloneValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function getPairState(pair) {
  return String(pair && pair.state || "").trim().toLowerCase();
}

function getPairKind(pair) {
  return String(pair && pair.kind || "static").trim().toLowerCase() || "static";
}

function buildActiveTopologyDigest(state = {}) {
  const activePairs = Object.values(state.pairsByID || {})
    .filter((pair) => getPairState(pair) === "active")
    .sort((left, right) => toInt(left && left.pairID, 0) - toInt(right && right.pairID, 0));
  return crypto.createHash("sha256").update(JSON.stringify(activePairs)).digest("hex");
}

function validatePairIdentity(pairsByID = {}) {
  const pairIDs = new Set();
  const endpointIDs = new Set();
  let maxPairID = 0;
  let maxEndpointSequence = 0;
  for (const [pairKey, pair] of Object.entries(pairsByID || {})) {
    const pairID = Math.max(0, toInt(pair && pair.pairID, toInt(pairKey, 0)));
    if (pairID <= 0) {
      throw new Error(`Invalid wormhole pair ID at key ${pairKey}`);
    }
    if (pairIDs.has(pairID)) {
      throw new Error(`Duplicate wormhole pair ID ${pairID}`);
    }
    pairIDs.add(pairID);
    maxPairID = Math.max(maxPairID, pairID);
    for (const endpoint of [pair && pair.source, pair && pair.destination]) {
      const endpointID = Math.max(0, toInt(endpoint && endpoint.endpointID, 0));
      if (endpointID <= 0) {
        throw new Error(`Pair ${pairID} has an invalid endpoint ID`);
      }
      if (endpointIDs.has(endpointID)) {
        throw new Error(`Duplicate wormhole endpoint ID ${endpointID}`);
      }
      endpointIDs.add(endpointID);
      maxEndpointSequence = Math.max(
        maxEndpointSequence,
        endpointID > WORMHOLE_ENDPOINT_ID_BASE
          ? endpointID - WORMHOLE_ENDPOINT_ID_BASE
          : endpointID,
      );
    }
  }
  return { maxEndpointSequence, maxPairID };
}

function shouldRetainCollapsedRandomPair(pair, nowMs, respawnDelayMs) {
  if (getPairKind(pair) !== "random" || getPairState(pair) === "active") {
    return false;
  }
  const collapseAtMs = Math.max(0, toInt(pair && pair.collapseAtMs, 0));
  return collapseAtMs > 0 && respawnDelayMs > 0 &&
    (collapseAtMs + respawnDelayMs) > nowMs;
}

function buildWormholeRuntimeV4Migration(state = {}, options = {}) {
  const input = cloneValue(state || {});
  const nowMs = Math.max(0, toInt(options.nowMs, Date.now()));
  const respawnDelayMs = Math.max(
    0,
    toInt(options.wanderingRespawnDelaySeconds, 60),
  ) * 1000;
  const identity = validatePairIdentity(input.pairsByID || {});
  const beforeDigest = buildActiveTopologyDigest(input);
  const pairsByID = {};
  const report = {
    sourceVersion: Math.max(0, toInt(input.version, 0)),
    targetVersion: TARGET_VERSION,
    totalPairsBefore: Object.keys(input.pairsByID || {}).length,
    activePairsPreserved: 0,
    collapsedCooldownPairsPreserved: 0,
    collapsedPairsRemoved: 0,
    polarizationCharactersRemoved: 0,
    polarizationEndpointsRemoved: 0,
    staticSlotsRepaired: 0,
    nextPairSequenceBefore: Math.max(1, toInt(input.nextPairSequence, 1)),
    nextEndpointSequenceBefore: Math.max(1, toInt(input.nextEndpointSequence, 1)),
  };

  for (const [pairKey, pair] of Object.entries(input.pairsByID || {})) {
    const pairID = Math.max(0, toInt(pair && pair.pairID, toInt(pairKey, 0)));
    if (getPairState(pair) === "active") {
      pairsByID[String(pairID)] = pair;
      report.activePairsPreserved += 1;
    } else if (shouldRetainCollapsedRandomPair(pair, nowMs, respawnDelayMs)) {
      pairsByID[String(pairID)] = pair;
      report.collapsedCooldownPairsPreserved += 1;
    } else {
      report.collapsedPairsRemoved += 1;
    }
  }

  const staticSlotsByKey = {};
  for (const [slotKey, slot] of Object.entries(input.staticSlotsByKey || {})) {
    const nextSlot = { ...slot };
    const activePairID = Math.max(0, toInt(nextSlot.activePairID, 0));
    const activePair = pairsByID[String(activePairID)];
    if (activePairID > 0 && (!activePair || getPairState(activePair) !== "active")) {
      nextSlot.activePairID = 0;
      report.staticSlotsRepaired += 1;
    }
    staticSlotsByKey[slotKey] = nextSlot;
  }

  const polarizationByCharacter = {};
  for (const [characterID, endpoints] of Object.entries(
    input.polarizationByCharacter || {},
  )) {
    const retainedEndpoints = {};
    for (const [endpointID, record] of Object.entries(endpoints || {})) {
      if (Math.max(0, toInt(record && record.endAtMs, 0)) > nowMs) {
        retainedEndpoints[endpointID] = record;
      } else {
        report.polarizationEndpointsRemoved += 1;
      }
    }
    if (Object.keys(retainedEndpoints).length > 0) {
      polarizationByCharacter[characterID] = retainedEndpoints;
    } else {
      report.polarizationCharactersRemoved += 1;
    }
  }

  const nextState = {
    ...input,
    version: TARGET_VERSION,
    nextPairSequence: Math.max(
      report.nextPairSequenceBefore,
      identity.maxPairID + 1,
    ),
    nextEndpointSequence: Math.max(
      report.nextEndpointSequenceBefore,
      identity.maxEndpointSequence + 1,
    ),
    pairsByID,
    staticSlotsByKey,
    polarizationByCharacter,
  };
  report.nextPairSequenceAfter = nextState.nextPairSequence;
  report.nextEndpointSequenceAfter = nextState.nextEndpointSequence;
  report.totalPairsAfter = Object.keys(pairsByID).length;
  report.activeTopologyDigestBefore = beforeDigest;
  report.activeTopologyDigestAfter = buildActiveTopologyDigest(nextState);
  if (report.activeTopologyDigestAfter !== beforeDigest) {
    throw new Error("Active wormhole topology changed during migration planning");
  }

  return { nextState, report };
}

module.exports = {
  TARGET_VERSION,
  WORMHOLE_ENDPOINT_ID_BASE,
  buildActiveTopologyDigest,
  buildWormholeRuntimeV4Migration,
  validatePairIdentity,
};
