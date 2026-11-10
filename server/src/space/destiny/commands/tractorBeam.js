"use strict";

const {
  buildFollowBallPayload,
  buildSetBallFreePayload,
  buildSetBallMassPayload,
  buildSetBallPositionPayload,
  buildSetBallVelocityPayload,
  buildSetMaxSpeedPayload,
  buildSetSpeedFractionPayload,
  buildStopPayload,
} = require("../stream/actions");

function toFiniteNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function cloneVector(source = null, fallback = { x: 0, y: 0, z: 0 }) {
  return {
    x: toFiniteNumber(source && source.x, fallback.x),
    y: toFiniteNumber(source && source.y, fallback.y),
    z: toFiniteNumber(source && source.z, fallback.z),
  };
}

function captureFittedTractorPresentation({
  scene,
  nowMs,
} = {}) {
  return scene.nextDestinyStamp;
}

function applyTractorStopCommand({
  targetEntity,
  restoreMaxVelocity,
} = {}) {
  if (!targetEntity) {
    return {
      applied: false,
      buildRestoreSpeedUpdates: () => [],
      buildStopUpdates: () => [],
    };
  }

  const restoredSpeed = Math.max(0, toFiniteNumber(restoreMaxVelocity, 0));
  targetEntity.maxVelocity = restoredSpeed;
  targetEntity.speedFraction = 0;
  targetEntity.mode = "STOP";
  targetEntity.targetPoint = cloneVector(targetEntity.position);
  targetEntity.velocity = { x: 0, y: 0, z: 0 };

  return {
    applied: true,
    buildRestoreSpeedUpdates({ stamp } = {}) {
      return [
        {
          stamp,
          payload: buildSetMaxSpeedPayload(targetEntity.itemID, restoredSpeed),
        },
        {
          stamp,
          payload: buildSetSpeedFractionPayload(targetEntity.itemID, 0),
        },
      ];
    },
    buildStopUpdates({ stamp, includePosition = false } = {}) {
      const updates = [];
      if (includePosition === true) {
        updates.push({
          stamp,
          payload: buildSetBallPositionPayload(targetEntity.itemID, targetEntity.position),
        });
      }
      updates.push(
        {
          stamp,
          payload: buildSetBallVelocityPayload(targetEntity.itemID, targetEntity.velocity),
        },
        {
          stamp,
          payload: buildStopPayload(targetEntity.itemID),
        },
      );
      return updates;
    },
  };
}

function applyTractorActivationCommand({
  sourceEntity,
  targetEntity,
  tractorSpeedMetersPerSecond,
  followRangeMeters,
} = {}) {
  if (!sourceEntity || !targetEntity) {
    return { applied: false, buildPresentationUpdates: () => [] };
  }

  const tractorSpeed = Math.max(0, toFiniteNumber(tractorSpeedMetersPerSecond, 0));
  const followRange = Math.max(0, toFiniteNumber(followRangeMeters, 0));
  targetEntity.mass = 10;
  targetEntity.maxVelocity = tractorSpeed;
  targetEntity.speedFraction = 1;
  targetEntity.mode = "FOLLOW";
  targetEntity.targetEntityID = sourceEntity.itemID;
  targetEntity.followRange = followRange;

  return {
    applied: true,
    buildPresentationUpdates({ stamp } = {}) {
      // TQ's order, SetMaxSpeed twice: SetMaxSpeed, SetBallFree,
      // SetBallMass, SetMaxSpeed, SetSpeedFraction, FollowBall (golden log
      // "Jettison cargo - target - tractor beam - loot all" line 2582, stamp
      // 24231). They are not consecutive, so retail's history keeps both
      // (_actions.py _add_to_system_history), and michelle applies both.
      return [
        {
          stamp,
          payload: buildSetMaxSpeedPayload(targetEntity.itemID, tractorSpeed),
        },
        {
          stamp,
          payload: buildSetBallFreePayload(targetEntity.itemID, true),
        },
        {
          stamp,
          payload: buildSetBallMassPayload(targetEntity.itemID, 10),
        },
        {
          stamp,
          payload: buildSetMaxSpeedPayload(targetEntity.itemID, tractorSpeed),
        },
        {
          stamp,
          payload: buildSetSpeedFractionPayload(targetEntity.itemID, 1),
        },
        {
          stamp,
          payload: buildFollowBallPayload(
            targetEntity.itemID,
            sourceEntity.itemID,
            followRange,
          ),
        },
      ];
    },
  };
}

module.exports = {
  captureFittedTractorPresentation,
  applyTractorActivationCommand,
  applyTractorStopCommand,
};
