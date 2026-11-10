"use strict";

const {
  normalizeEntityID,
} = require("../identity/entityID");
const {
  normalizeDestinyStamp,
} = require("../delivery/stamps");
const {
  buildNonEnablingMassDemotionAction,
  buildOnDockingAcceptedPayload,
  buildOnSpecialFXPayload,
  buildSetBallFreePayload,
  buildSetBallPositionPayload,
  buildSetBallVelocityPayload,
  buildSetSpeedFractionPayload,
  buildStopPayload,
} = require("../stream/actions");

const DEFAULT_STRUCTURE_DOCKING_CLOAK_EFFECT_GUID = "effects.Cloak";
const DEFAULT_STRUCTURE_DOCKING_TETHER_EFFECT_GUID = "effects.Tethering";

function resolveModeStamp(options = {}) {
  return normalizeDestinyStamp(options.stamp, 0);
}

function hasUsableModeTarget(value) {
  const normalizedTargetID = normalizeEntityID(value);
  return normalizedTargetID !== null && normalizedTargetID !== 0;
}

function defaultMagnitude(vector) {
  const x = Number(vector && vector.x) || 0;
  const y = Number(vector && vector.y) || 0;
  const z = Number(vector && vector.z) || 0;
  return Math.sqrt((x ** 2) + (y ** 2) + (z ** 2));
}

function buildTeleportStopPresentationUpdates(entity, stampValue = 0) {
  if (!entity) {
    return [];
  }

  const stamp = normalizeDestinyStamp(stampValue, 0);
  return [
    {
      stamp,
      payload: buildSetSpeedFractionPayload(entity.itemID, 0),
    },
    {
      stamp,
      payload: buildSetBallPositionPayload(entity.itemID, entity.position),
    },
    {
      stamp,
      payload: buildStopPayload(entity.itemID),
    },
    {
      stamp,
      payload: buildSetBallVelocityPayload(entity.itemID, entity.velocity),
    },
  ];
}

function buildOrdinaryDockingStopPresentationUpdates(
  entity,
  stampValue = 0,
) {
  if (!entity) {
    return [];
  }

  const stamp = normalizeDestinyStamp(stampValue, 0);
  return [
    {
      stamp,
      // Native warp dropout leaves the client ball massive. TQ's docking
      // handoff demotes it before Stop and does not inject a velocity vector;
      // SetBallVelocity would make Carbon snap the hull orientation.
      payload: buildNonEnablingMassDemotionAction(entity.itemID),
    },
    {
      stamp,
      payload: buildStopPayload(entity.itemID),
    },
  ];
}

function buildStructureDockingTransitionUpdates(
  entity,
  stampValue = 0,
  options = {},
) {
  if (!entity) {
    return [];
  }

  const stamp = normalizeDestinyStamp(stampValue, 0);
  const cloakEffectGuid =
    options.cloakEffectGuid || DEFAULT_STRUCTURE_DOCKING_CLOAK_EFFECT_GUID;
  const tetherEffectGuid =
    options.tetherEffectGuid || DEFAULT_STRUCTURE_DOCKING_TETHER_EFFECT_GUID;
  const tetherEffectOptions = options.tetherEffectOptions || {};
  return [
    {
      stamp,
      payload: buildOnSpecialFXPayload(entity.itemID, cloakEffectGuid, {
        start: true,
        active: false,
      }),
    },
    {
      stamp,
      payload: buildOnSpecialFXPayload(
        entity.itemID,
        tetherEffectGuid,
        tetherEffectOptions,
      ),
    },
    {
      stamp,
      // This is the frozen non-enabling demotion. Callers cannot promote a
      // ball or supply general massive-state policy through this planner.
      payload: buildNonEnablingMassDemotionAction(entity.itemID),
    },
    {
      stamp,
      payload: buildStopPayload(entity.itemID),
    },
  ];
}

function buildDockingAcceptedNotificationPayload(
  shipPosition,
  stationPosition,
  stationID,
) {
  return buildOnDockingAcceptedPayload(
    shipPosition,
    stationPosition,
    stationID,
  );
}

function buildSetBallFreePresentationUpdates(
  entityID,
  isFree,
  stampValue = 0,
) {
  const stamp = normalizeDestinyStamp(stampValue, 0);
  return [{
    stamp,
    payload: buildSetBallFreePayload(entityID, isFree),
  }];
}

function buildModePresentationUpdates(options = {}) {
  const entity = options.entity;
  if (!entity) {
    return [];
  }

  const destiny = options.destiny;
  if (!destiny || typeof destiny !== "object") {
    throw new TypeError("mode presentation requires Destiny payload builders");
  }

  const toInt =
    typeof options.toInt === "function"
      ? options.toInt
      : (value, fallback = 0) => {
          const numeric = Number(value);
          return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
        };
  const magnitude =
    typeof options.magnitude === "function"
      ? options.magnitude
      : defaultMagnitude;
  const getCommandDirection =
    typeof options.getCommandDirection === "function"
      ? options.getCommandDirection
      : () => entity.direction;
  const modeStamp = resolveModeStamp(options);
  const updates = [];

  switch (entity.mode) {
    case "GOTO":
      updates.push({
        stamp: modeStamp,
        payload: destiny.buildGotoDirectionPayload(
          entity.itemID,
          getCommandDirection(entity, entity.direction),
        ),
      });
      break;
    case "FOLLOW":
      // A persisted/transitional entity can briefly retain FOLLOW after its
      // target disappears. Never manufacture a FollowBall against ball zero.
      if (hasUsableModeTarget(entity.targetEntityID)) {
        updates.push({
          stamp: modeStamp,
          payload: destiny.buildFollowBallPayload(
            entity.itemID,
            entity.targetEntityID,
            entity.followRange,
          ),
        });
      }
      break;
    case "ORBIT":
      if (hasUsableModeTarget(entity.targetEntityID)) {
        updates.push({
          stamp: modeStamp,
          payload: destiny.buildOrbitPayload(
            entity.itemID,
            entity.targetEntityID,
            entity.orbitDistance,
          ),
        });
      }
      break;
    case "WARP":
      // The AddBalls carries the WARP record (goto, effectStamp, length,
      // factor); the client's Evolve runs the rest.
      break;
    default:
      break;
  }

  // A Stop keeps the fraction, so a Ball in STOP holding
  // one is not moving and gets no SetSpeedFraction; its AddBalls carries it.
  if (
    entity.mode !== "WARP" &&
    entity.mode !== "STOP" &&
    entity.speedFraction > 0
  ) {
    updates.push({
      stamp: modeStamp,
      payload: destiny.buildSetSpeedFractionPayload(
        entity.itemID,
        entity.speedFraction,
      ),
    });
  }
  if (entity.mode !== "WARP" && magnitude(entity.velocity) > 0) {
    updates.push({
      stamp: modeStamp,
      payload: destiny.buildSetBallVelocityPayload(
        entity.itemID,
        entity.velocity,
      ),
    });
  }

  return updates;
}

module.exports = {
  buildDockingAcceptedNotificationPayload,
  buildModePresentationUpdates,
  buildOrdinaryDockingStopPresentationUpdates,
  buildSetBallFreePresentationUpdates,
  buildStructureDockingTransitionUpdates,
  buildTeleportStopPresentationUpdates,
};
