"use strict";

const {
  buildGotoDirectionPayload,
  buildNonEnablingMassDemotionAction,
  buildOnSpecialFXPayload,
  buildSetBallAgilityPayload,
  buildSetBallMassPayload,
  buildSetBallPositionPayload,
  buildSetBallVelocityPayload,
  buildSetMaxSpeedPayload,
} = require("../stream/actions");
const {
  normalizeDestinyStamp,
} = require("../delivery/stamps");
const {
  getEntityIDText,
} = require("../identity/entityID");
const {
  normalizeVector,
} = require("../stream/primitives");

const SHIP_PRIME_PAYLOAD_NAMES = new Set([
  "SetBallAgility",
  "SetBallMass",
  "SetMaxSpeed",
]);

function toFiniteNumber(value, fallback = 0) {
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return numeric;
  }
  const fallbackNumeric = Number(fallback);
  return Number.isFinite(fallbackNumeric) ? fallbackNumeric : 0;
}

function valuesDiffer(left, right, epsilon = 1e-9) {
  return Math.abs(
    toFiniteNumber(left, 0) - toFiniteNumber(right, 0),
  ) > epsilon;
}

function getVectorMagnitude(vector) {
  const x = toFiniteNumber(vector && vector.x, 0);
  const y = toFiniteNumber(vector && vector.y, 0);
  const z = toFiniteNumber(vector && vector.z, 0);
  return Math.sqrt((x ** 2) + (y ** 2) + (z ** 2));
}

function getUndockCommandDirection(entity) {
  const fallback = entity && entity.direction;
  if (entity && entity.targetPoint && entity.position) {
    return normalizeVector({
      x:
        toFiniteNumber(entity.targetPoint.x, 0) -
        toFiniteNumber(entity.position.x, 0),
      y:
        toFiniteNumber(entity.targetPoint.y, 0) -
        toFiniteNumber(entity.position.y, 0),
      z:
        toFiniteNumber(entity.targetPoint.z, 0) -
        toFiniteNumber(entity.position.z, 0),
    }, fallback);
  }
  return normalizeVector(fallback);
}

function buildUndockBootstrapMovementUpdates(
  entity,
  stampValue = 0,
  options = {},
) {
  if (!entity || entity.kind !== "ship") {
    return [];
  }

  const stamp = normalizeDestinyStamp(stampValue, 0);
  // TQ's undock prime, on one stamp: the ship's demotion, mass, velocity and
  // heading (all 26 station undocks in the golden logs). From a citadel it
  // opens with the ship's effects.Uncloak and its position (the log "Undock
  // citadel and stopping ship", stamp 24127). options.fromStructure: false
  // for a station's.
  const updates = options.fromStructure === false
    ? []
    : [
      {
        stamp,
        payload: buildOnSpecialFXPayload(entity.itemID, "effects.Uncloak", {
          active: false,
        }),
      },
      {
        stamp,
        payload: buildSetBallPositionPayload(entity.itemID, entity.position),
      },
    ];
  updates.push(
    {
      stamp,
      // Exact bootstrap demotion only; no caller-controlled massive state.
      payload: buildNonEnablingMassDemotionAction(entity.itemID),
    },
    {
      stamp,
      payload: buildSetBallMassPayload(entity.itemID, entity.mass),
    },
  );
  if (getVectorMagnitude(entity.velocity) > 0) {
    updates.push({
      stamp,
      payload: buildSetBallVelocityPayload(entity.itemID, entity.velocity),
    });
  }
  updates.push({
    stamp,
    payload: buildGotoDirectionPayload(
      entity.itemID,
      getUndockCommandDirection(entity),
    ),
  });
  return updates;
}

function buildShipPrimeUpdates(entity, stampValue = 0) {
  if (!entity || entity.kind !== "ship") {
    return [];
  }

  const stamp = normalizeDestinyStamp(stampValue, 0);
  return [
    {
      stamp,
      payload: buildSetBallAgilityPayload(entity.itemID, entity.inertia),
    },
    {
      stamp,
      payload: buildSetBallMassPayload(entity.itemID, entity.mass),
    },
    {
      stamp,
      payload: buildSetMaxSpeedPayload(entity.itemID, entity.maxVelocity),
    },
  ];
}

// Bootstrap and fresh acquisition need the complete physical triad. Live
// Dogma recomputation is a delta contract: repeating unchanged setters makes
// Michelle rebase the same local ship simulation without changing truth.
function buildShipPrimeDeltaUpdates(
  entity,
  previousState = {},
  stampValue = 0,
) {
  if (!entity || entity.kind !== "ship") {
    return [];
  }

  const stamp = normalizeDestinyStamp(stampValue, 0);
  const updates = [];
  if (valuesDiffer(entity.inertia, previousState.inertia)) {
    updates.push({
      stamp,
      payload: buildSetBallAgilityPayload(entity.itemID, entity.inertia),
    });
  }
  if (valuesDiffer(entity.mass, previousState.mass)) {
    updates.push({
      stamp,
      payload: buildSetBallMassPayload(entity.itemID, entity.mass),
    });
  }
  if (valuesDiffer(entity.maxVelocity, previousState.maxVelocity)) {
    updates.push({
      stamp,
      payload: buildSetMaxSpeedPayload(entity.itemID, entity.maxVelocity),
    });
  }
  return updates;
}

function buildShipPrimeUpdatesForEntities(entities, stampValue = 0) {
  const updates = [];
  for (const entity of Array.isArray(entities) ? entities : []) {
    updates.push(...buildShipPrimeUpdates(entity, stampValue));
  }
  return updates;
}

function getShipPrimeUpdateDedupeKey(update) {
  const payload = update && Array.isArray(update.payload)
    ? update.payload
    : null;
  if (
    !payload ||
    !SHIP_PRIME_PAYLOAD_NAMES.has(payload[0]) ||
    !Array.isArray(payload[1])
  ) {
    return null;
  }
  const entityIDText = getEntityIDText(payload[1][0]);
  return entityIDText === null
    ? null
    : `ship-prime:${entityIDText}:${payload[0]}`;
}

module.exports = {
  buildShipPrimeDeltaUpdates,
  buildShipPrimeUpdates,
  buildShipPrimeUpdatesForEntities,
  buildUndockBootstrapMovementUpdates,
  getShipPrimeUpdateDedupeKey,
};
