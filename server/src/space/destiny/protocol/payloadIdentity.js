"use strict";

const {
  entityIDsEqual,
  normalizeEntityID: normalizeExactEntityID,
} = require("../identity/entityID");
const {
  getCanonicalPayloadName,
  isDestinyPayload,
} = require("./payloads");

// These are only action shapes whose first argument is the acted-on ball.
// Aggregate stream actions and bubble identifiers deliberately do not appear.
// Legacy general massive-state actions are diagnostic input, not a routing
// source, so they are deliberately absent as well.
const PRIMARY_ENTITY_ARGUMENT_COUNTS = Object.freeze({
  AddBall: 17,
  CloakBall: 3,
  EntityWarpIn: 5,
  FollowBall: 3,
  GotoDirection: 4,
  GotoPoint: 4,
  LaunchMissile: 5,
  OnDamageStateChange: 2,
  OnDbuffUpdated: 2,
  OnDroneStateChange: 1,
  OnSlimItemChange: 2,
  OnSpecialFX: 14,
  Orbit: 3,
  RemoveBall: 1,
  RemoveGlobalBall: 1,
  SetBallAgility: 2,
  SetBallAngularAgility: 2,
  SetBallAngularVelocity: 4,
  SetBallFree: 2,
  SetBallHarmonic: 5,
  SetBallInteractive: 2,
  SetBallMass: 2,
  SetBallPosition: 4,
  SetBallRadius: 2,
  SetBallRotation: 5,
  SetBallTroll: 2,
  SetBallVelocity: 4,
  SetMaxAngularSpeed: 2,
  SetMaxAngularVelocity: 4,
  SetMaxSpeed: 2,
  SetSpeedFraction: 2,
  Stop: 1,
  TerminalPlayDestructionEffect: 2,
  UncloakBall: 1,
  WarpTo: 6,
});

const PRIMARY_ENTITY_PAYLOAD_NAMES = Object.freeze(
  Object.keys(PRIMARY_ENTITY_ARGUMENT_COUNTS),
);

function getPayloadPrimaryEntityID(payload, options = {}) {
  if (!isDestinyPayload(payload)) {
    return null;
  }

  const name = getCanonicalPayloadName(payload);
  const minimumArgumentCount = name === null
    ? undefined
    : PRIMARY_ENTITY_ARGUMENT_COUNTS[name];
  if (minimumArgumentCount === undefined) {
    return null;
  }

  try {
    const args = payload[1];
    if (args.length !== minimumArgumentCount) {
      return null;
    }
    const customNormalizer = (
      options &&
      typeof options === "object" &&
      typeof options.normalizeEntityID === "function"
    )
      ? options.normalizeEntityID
      : null;
    const normalizedCandidate = customNormalizer
      ? customNormalizer(args[0])
      : args[0];
    const entityID = normalizeExactEntityID(normalizedCandidate);
    return entityID === 0 || entityID === 0n ? null : entityID;
  } catch (_error) {
    // ignored: an unreadable payload has no primary entity (null)
    return null;
  }
}

function extractPayloadPrimaryEntityID(payload, options = {}) {
  return getPayloadPrimaryEntityID(payload, options);
}

function getPayloadPrimaryEntityIDOr(
  payload,
  fallback = 0,
  options = {},
) {
  const entityID = getPayloadPrimaryEntityID(payload, options);
  return entityID === null ? fallback : entityID;
}

function payloadHasPrimaryEntity(payload) {
  return getPayloadPrimaryEntityID(payload) !== null;
}

function payloadTargetsEntity(payload, entityID) {
  const primaryEntityID = getPayloadPrimaryEntityID(payload);
  const targetEntityID = normalizeExactEntityID(entityID);
  return (
    primaryEntityID !== null &&
    targetEntityID !== null &&
    targetEntityID !== 0 &&
    targetEntityID !== 0n &&
    entityIDsEqual(primaryEntityID, targetEntityID)
  );
}

function normalizeMarshalList(value) {
  if (Array.isArray(value)) {
    return value;
  }
  return value && value.type === "list" && Array.isArray(value.items)
    ? value.items
    : [];
}

function getMarshalDictEntry(value, key) {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  try {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      return value[key];
    }
    if (Array.isArray(value.entries)) {
      const entry = value.entries.find(
        (candidate) => Array.isArray(candidate) && candidate[0] === key,
      );
      if (entry) {
        return entry[1];
      }
    }
    if (value.args && typeof value.args === "object") {
      return getMarshalDictEntry(value.args, key);
    }
  } catch (_error) {
    // ignored: an unreadable dict has no entry for the key
    return undefined;
  }
  return undefined;
}

function getAddBallsSlimEntityID(slimEntry) {
  const slimItem = Array.isArray(slimEntry) ? slimEntry[0] : slimEntry;
  const entityID = normalizeExactEntityID(
    getMarshalDictEntry(slimItem, "itemID"),
  );
  return entityID === 0 || entityID === 0n ? null : entityID;
}

function extractAddBallsPayloadEntityIDs(args) {
  const entityIDs = new Set();
  for (const batchEntry of Array.isArray(args) ? args : []) {
    if (!Array.isArray(batchEntry)) {
      continue;
    }
    for (const slimEntry of normalizeMarshalList(batchEntry[1])) {
      const entityID = getAddBallsSlimEntityID(slimEntry);
      if (entityID !== null) {
        entityIDs.add(entityID);
      }
    }
  }
  return [...entityIDs];
}

// Every Ball a payload names. A PackagedAction (a Grid bubble's shared
// entered and left lists) names the Balls of the actions packed in it.
function extractPayloadEntityIDs(payload, depth = 0) {
  if (Array.isArray(payload) && payload[0] === "PackagedAction" && depth < 4) {
    const { inspectPackagedActionPayload } = require("../batching/packagedAction");
    const packaged = inspectPackagedActionPayload(payload);
    if (!packaged) {
      return [];
    }
    const entityIDs = new Set();
    for (const action of packaged.actions) {
      const inner = action && action[1];
      const innerPayload = Array.isArray(inner) && Buffer.isBuffer(inner[0])
        ? [inner[0].toString("utf8"), inner[1]]
        : inner;
      for (const entityID of extractPayloadEntityIDs(innerPayload, depth + 1)) {
        entityIDs.add(entityID);
      }
    }
    return [...entityIDs];
  }
  if (!isDestinyPayload(payload)) {
    return [];
  }
  const name = getCanonicalPayloadName(payload);
  const args = payload[1];
  if (name === "AddBalls2") {
    return extractAddBallsPayloadEntityIDs(args);
  }
  if (name === "RemoveBalls") {
    const entityIDs = new Set();
    for (const candidate of normalizeMarshalList(args[0])) {
      const entityID = normalizeExactEntityID(candidate);
      if (entityID !== null && entityID !== 0 && entityID !== 0n) {
        entityIDs.add(entityID);
      }
    }
    return [...entityIDs];
  }
  const primaryEntityID = getPayloadPrimaryEntityID(payload);
  return primaryEntityID === null ? [] : [primaryEntityID];
}

module.exports = {
  PRIMARY_ENTITY_ARGUMENT_COUNTS,
  PRIMARY_ENTITY_PAYLOAD_NAMES,
  extractPayloadEntityIDs,
  extractPayloadPrimaryEntityID,
  getPayloadPrimaryEntityID,
  getPayloadPrimaryEntityIDOr,
  payloadHasPrimaryEntity,
  payloadTargetsEntity,
};
