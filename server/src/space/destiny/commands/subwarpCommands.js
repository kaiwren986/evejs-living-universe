"use strict";

const destiny = require("../index.js");
const {
  queueMovementCommand,
} = require("./movementQueueing");

function createMovementSubwarpCommands(deps = {}) {
  const {
    addVectors,
    armMovementTrace,
    buildDirectedMovementUpdates,
    buildPointMovementUpdates,
    buildPerpendicular,
    clearTrackingState,
    cloneVector,
    crossProduct,
    directionsNearlyMatch,
    getShipDockingDistanceToStation,
    getTargetMotionPosition,
    logMovementDebug,
    normalizeVector,
    persistShipEntity,
    roundNumber,
    scaleVector,
    subtractVectors,
    summarizeVector,
    toFiniteNumber,
    toInt,
    DEFAULT_UP,
  } = deps;

  const MAX_EXPLICIT_SPEED_FRACTION = 1.0;
  const SPEED_FRACTION_EPSILON = 0.000001;

  function resolveExplicitSpeedFraction(options = {}) {
    if (
      !options ||
      !Object.prototype.hasOwnProperty.call(options, "speedFraction") ||
      !Number.isFinite(Number(options.speedFraction))
    ) {
      return {
        explicit: false,
        value: null,
      };
    }

    return {
      explicit: true,
      value: Math.min(
        MAX_EXPLICIT_SPEED_FRACTION,
        Math.max(0, Number(options.speedFraction)),
      ),
    };
  }

  // A command's updates go to its Ball's Grid bubble history, stamped when
  // they are queued, unless the caller tells no one.
  function queueSubwarpMovement(runtime, options, buildUpdates) {
    if (options && options.broadcast === false) {
      return;
    }
    const updates = buildUpdates(runtime.nextDestinyStamp);
    if (Array.isArray(updates) && updates.length > 0) {
      runtime.queueBubbleHistory(updates);
    }
  }

  // Speed of a movement order: retail's GotoPoint, and GotoDirection
  // with it, keeps the fraction the ship holds and turns only a fraction of
  // exactly 0 into full speed. Mode STOP alone does not.
  function takesFullSpeedFromZero(entity) {
    return !(toFiniteNumber(entity.speedFraction, 0) > 0);
  }

  // The station a docking approach flies to, or null.
  function resolveDockingTargetID(options = {}) {
    const dockingTargetID = Number(options && options.dockingTargetID);
    return Number.isFinite(dockingTargetID) && dockingTargetID > 0
      ? dockingTargetID
      : null;
  }

  function speedFractionsMatch(left, right) {
    return Math.abs(toFiniteNumber(left, 0) - toFiniteNumber(right, 0)) <=
      SPEED_FRACTION_EPSILON;
  }

  // TQ adjusts the speed of a standing Follow/Orbit with a bare
  // SetSpeedFraction; the command itself is never re-sent unless the target or
  // range actually changes (salvage golden tick 62674 and Rouvenor tick 49989
  // both cruise-down mid-orbit with no Orbit re-issue). Re-sending the command
  // forces the client to synchronise + rebase and re-solve the maneuver from
  // its current ball state, which reads as a jolt on every drone propulsion
  // regime toggle.
  function applyStandingCommandSpeedFraction(
    runtime,
    entity,
    fraction,
    now,
    options = {},
    commandLabel = "movement",
  ) {
    entity.speedFraction = fraction;
    persistShipEntity(entity);
    armMovementTrace(entity, "speed", {
      requestedSpeedFraction: roundNumber(fraction, 3),
    }, now);
    logMovementDebug(`cmd.${commandLabel}.speedFraction`, entity, {
      requestedSpeedFraction: roundNumber(fraction, 3),
    });

    queueSubwarpMovement(runtime, options, (stamp) => [
      {
        stamp,
        payload: destiny.buildSetSpeedFractionPayload(
          entity.itemID,
          entity.speedFraction,
        ),
      },
    ]);

    return true;
  }

  function gotoPointEntity(runtime, entity, point, options = {}) {
    if (queueMovementCommand(
      runtime,
      entity,
      "gotoPoint",
      () => gotoPointEntity(runtime, entity, point, options),
    )) {
      return true;
    }
    const now = runtime.getCurrentSimTimeMs();
    const commandPoint = cloneVector(point, entity.position);
    const commandDirection = normalizeVector(
      subtractVectors(commandPoint, entity.position),
      entity.direction,
    );
    const speedFractionChanged = takesFullSpeedFromZero(entity);
    clearTrackingState(entity);
    entity.dockingTargetID = resolveDockingTargetID(options);
    entity.targetPoint = commandPoint;
    if (speedFractionChanged) {
      entity.speedFraction = 1.0;
    }
    entity.mode = "GOTO";
    persistShipEntity(entity);
    armMovementTrace(entity, "gotoPoint", {
      commandDirection: summarizeVector(commandDirection),
      commandPoint: summarizeVector(commandPoint),
    }, now);
    logMovementDebug("cmd.gotoPoint", entity, {
      commandDirection: summarizeVector(commandDirection),
      commandPoint: summarizeVector(commandPoint),
    });

    queueSubwarpMovement(runtime, options, (stamp) => buildPointMovementUpdates(
      entity,
      commandPoint,
      speedFractionChanged,
      stamp,
    ));

    return true;
  }

  function isFiniteFollowOrbitRange(value) {
    return Number.isFinite(Number(value));
  }

  function isCloakedFollowOrbitTarget(target) {
    return toInt(
      target && (
        target.isCloaked ??
        target.cloakMode ??
        target.cloaked
      ),
      0,
    ) > 0;
  }

  function isMoribundFollowOrbitTarget(target) {
    return Boolean(
      target &&
        (
          target.isMoribund === true ||
          target.moribund === true ||
          target.destroyed === true ||
          target.isDestroyed === true ||
          target.pendingRemoval === true ||
          target.removed === true ||
          toInt(target.destroyedAt, 0) > 0 ||
          toInt(target.removedAt, 0) > 0
        ),
    );
  }

  function isDifferentFollowOrbitBubble(entity, target) {
    const entityBubbleID = toInt(entity && entity.bubbleID, 0);
    const targetBubbleID = toInt(target && target.bubbleID, 0);
    return (
      entityBubbleID > 0 &&
      targetBubbleID > 0 &&
      entityBubbleID !== targetBubbleID
    );
  }

  function isInvalidFollowOrbitTarget(entity, target) {
    return (
      !entity ||
      !target ||
      entity.itemID === target.itemID ||
      entity.mode === "WARP" ||
      entity.pendingDock ||
      isMoribundFollowOrbitTarget(target) ||
      isDifferentFollowOrbitBubble(entity, target) ||
      isCloakedFollowOrbitTarget(target)
    );
  }

  const commands = {
    gotoDirection(runtime, session, direction, options = {}) {
      const entity = runtime.getShipEntityForSession(session);
      if (
        !entity ||
        entity.mode === "WARP" ||
        entity.pendingDock
      ) {
        return false;
      }
      if (queueMovementCommand(
        runtime,
        entity,
        "gotoDirection",
        () => commands.gotoDirection(runtime, session, direction, options),
      )) {
        return true;
      }

      const now = runtime.getCurrentSimTimeMs();
      const commandDirection = normalizeVector(direction, entity.direction);
      const currentGotoDirection =
        entity.mode === "GOTO" &&
        entity.targetEntityID === null &&
        entity.targetPoint
          ? normalizeVector(
              subtractVectors(entity.targetPoint, entity.position),
              entity.direction,
            )
          : null;
      const speedFractionChanged = takesFullSpeedFromZero(entity);
      // The Movement queue applies commands in order, so a repeat of the
      // order the ship already flies is a no-op. A heading always replaces
      // a docking approach.
      if (
        !speedFractionChanged &&
        !entity.dockingTargetID &&
        currentGotoDirection &&
        directionsNearlyMatch(currentGotoDirection, commandDirection)
      ) {
        logMovementDebug("cmd.goto.duplicate", entity, {
          commandDirection: summarizeVector(commandDirection),
        });
        return true;
      }
      clearTrackingState(entity);
      entity.targetPoint = addVectors(
        cloneVector(entity.position),
        scaleVector(commandDirection, 1.0e16),
      );
      if (speedFractionChanged) {
        entity.speedFraction = 1.0;
      }
      entity.mode = "GOTO";
      persistShipEntity(entity);
      armMovementTrace(entity, "goto", {
        commandDirection: summarizeVector(commandDirection),
      }, now);
      logMovementDebug("cmd.goto", entity, {
        commandDirection: summarizeVector(commandDirection),
      });

      queueSubwarpMovement(runtime, options, (stamp) => buildDirectedMovementUpdates(
        entity,
        commandDirection,
        speedFractionChanged,
        stamp,
      ));

      return true;
    },

    gotoPoint(runtime, session, point, options = {}) {
      const entity = runtime.getShipEntityForSession(session);
      if (
        !entity ||
        entity.mode === "WARP" ||
        entity.pendingDock
      ) {
        return false;
      }
      return gotoPointEntity(runtime, entity, point, options);
    },

    alignTo(runtime, session, targetEntityID) {
      const entity = runtime.getShipEntityForSession(session);
      const target = runtime.getEntityByID(targetEntityID);
      if (
        !entity ||
        !target ||
        entity.mode === "WARP" ||
        entity.pendingDock
      ) {
        return false;
      }
      if (queueMovementCommand(
        runtime,
        entity,
        "alignTo",
        () => commands.alignTo(runtime, session, targetEntityID),
      )) {
        return true;
      }

      const now = runtime.getCurrentSimTimeMs();
      const alignTargetPosition = getTargetMotionPosition(target);
      const commandDirection = normalizeVector(
        subtractVectors(alignTargetPosition, entity.position),
        entity.direction,
      );
      clearTrackingState(entity);
      entity.targetPoint = addVectors(
        cloneVector(entity.position),
        scaleVector(commandDirection, 1.0e16),
      );
      const previousSpeedFraction = entity.speedFraction;
      entity.speedFraction = previousSpeedFraction > 0 ? previousSpeedFraction : 0.75;
      const speedFractionChanged =
        Math.abs(entity.speedFraction - previousSpeedFraction) > 0.000001;
      entity.mode = "GOTO";
      persistShipEntity(entity);
      armMovementTrace(entity, "align", {
        commandDirection: summarizeVector(commandDirection),
        alignTargetID: target.itemID,
        alignTargetPosition: summarizeVector(alignTargetPosition),
      }, now);
      logMovementDebug("cmd.align", entity, {
        commandDirection: summarizeVector(commandDirection),
        alignTargetID: target.itemID,
        alignTargetPosition: summarizeVector(alignTargetPosition),
      });

      const movementStamp = runtime.nextDestinyStamp;
      const updates = buildDirectedMovementUpdates(
        entity,
        commandDirection,
        speedFractionChanged,
        movementStamp,
      );

      runtime.queueBubbleHistory(updates);

      return true;
    },

    followShipEntity(runtime, entityOrID, targetEntityID, range = 0, options = {}) {
      const entity =
        typeof entityOrID === "object" && entityOrID !== null
          ? entityOrID
          : runtime.getEntityByID(entityOrID);
      const target = runtime.getEntityByID(targetEntityID);
      if (
        !isFiniteFollowOrbitRange(range) ||
        isInvalidFollowOrbitTarget(entity, target)
      ) {
        return false;
      }
      if (queueMovementCommand(
        runtime,
        entity,
        "followBall",
        () => commands.followShipEntity(runtime, entity, targetEntityID, range, options),
      )) {
        return true;
      }

      const now = runtime.getCurrentSimTimeMs();
      const explicitDockingTargetID =
        (target.kind === "station" || target.kind === "structure") &&
        Number(options.dockingTargetID || 0) === target.itemID
          ? target.itemID
          : null;
      const preservedDockingTargetID =
        explicitDockingTargetID === null &&
        (target.kind === "station" || target.kind === "structure") &&
        Number(entity.targetEntityID || 0) === target.itemID &&
        Number(entity.dockingTargetID || 0) === target.itemID
          ? target.itemID
          : null;
      const dockingTargetID = explicitDockingTargetID || preservedDockingTargetID;
      const normalizedRange = Math.max(0, toFiniteNumber(range, 0));
      const requestedSpeedFraction = resolveExplicitSpeedFraction(options);
      if (
        entity.mode === "FOLLOW" &&
        entity.targetEntityID === target.itemID &&
        entity.dockingTargetID === dockingTargetID &&
        Math.abs(toFiniteNumber(entity.followRange, 0) - normalizedRange) < 1 &&
        (
          !requestedSpeedFraction.explicit ||
          speedFractionsMatch(
            entity.speedFraction,
            requestedSpeedFraction.value,
          )
        )
      ) {
        logMovementDebug("cmd.follow.duplicate", entity, {
          followTargetID: target.itemID,
          followRange: roundNumber(normalizedRange),
          dockingTargetID: dockingTargetID || 0,
          requestedSpeedFraction: requestedSpeedFraction.explicit
            ? requestedSpeedFraction.value
            : null,
        });
        return true;
      }
      // A bare retune of the standing Follow is a SetSpeedFraction alone.
      if (
        requestedSpeedFraction.explicit &&
        entity.mode === "FOLLOW" &&
        entity.targetEntityID === target.itemID &&
        entity.dockingTargetID === dockingTargetID &&
        Math.abs(toFiniteNumber(entity.followRange, 0) - normalizedRange) < 1
      ) {
        return applyStandingCommandSpeedFraction(
          runtime,
          entity,
          requestedSpeedFraction.value,
          now,
          options,
          "follow",
        );
      }

      const followTargetPosition = getTargetMotionPosition(target, {
        useDockPosition: dockingTargetID === target.itemID,
        shipTypeID: entity.typeID,
        selectionKey: entity.itemID,
      });
      clearTrackingState(entity);
      entity.mode = "FOLLOW";
      entity.targetEntityID = target.itemID;
      entity.dockingTargetID = dockingTargetID;
      entity.followRange = normalizedRange;
      entity.targetPoint = followTargetPosition;
      const previousSpeedFraction = entity.speedFraction;
      entity.speedFraction = requestedSpeedFraction.explicit
        ? requestedSpeedFraction.value
        : previousSpeedFraction > 0
          ? previousSpeedFraction
          : 1;
      const speedFractionChanged =
        !speedFractionsMatch(entity.speedFraction, previousSpeedFraction);
      persistShipEntity(entity);
      armMovementTrace(entity, "follow", {
        followTargetID: target.itemID,
        followRange: roundNumber(entity.followRange),
        followTargetPosition: summarizeVector(followTargetPosition),
        dockingTargetID: dockingTargetID || 0,
        preservedDockingTargetID: preservedDockingTargetID || 0,
      }, now);
      logMovementDebug("cmd.follow", entity, {
        followTargetID: target.itemID,
        followRange: roundNumber(entity.followRange),
        followTargetKind: target.kind,
        followTargetPosition: summarizeVector(followTargetPosition),
        explicitDockingTargetID: explicitDockingTargetID || 0,
        preservedDockingTargetID: preservedDockingTargetID || 0,
        dockPosition:
          (target.kind === "station" || target.kind === "structure") && target.dockPosition
            ? summarizeVector(target.dockPosition)
            : null,
        dockingDistance:
          (target.kind === "station" || target.kind === "structure")
            ? roundNumber(getShipDockingDistanceToStation(entity, target))
            : null,
      });

      queueSubwarpMovement(runtime, options, (stamp) => {
        const updates = [
          {
            stamp,
            payload: destiny.buildFollowBallPayload(
              entity.itemID,
              target.itemID,
              entity.followRange,
            ),
          },
        ];
        if (speedFractionChanged) {
          updates.push({
            stamp,
            payload: destiny.buildSetSpeedFractionPayload(
              entity.itemID,
              entity.speedFraction,
            ),
          });
        }
        return updates;
      });

      return true;
    },

    followBall(runtime, session, targetEntityID, range = 0, options = {}) {
      const entity = runtime.getShipEntityForSession(session);
      return runtime.followShipEntity(entity, targetEntityID, range, options);
    },

    orbitShipEntity(runtime, entityOrID, targetEntityID, distanceValue = 0, options = {}) {
      const entity =
        typeof entityOrID === "object" && entityOrID !== null
          ? entityOrID
          : runtime.getEntityByID(entityOrID);
      const target = runtime.getEntityByID(targetEntityID);
      if (
        !isFiniteFollowOrbitRange(distanceValue) ||
        isInvalidFollowOrbitTarget(entity, target)
      ) {
        return false;
      }
      if (queueMovementCommand(
        runtime,
        entity,
        "orbit",
        () => commands.orbitShipEntity(runtime, entity, targetEntityID, distanceValue, options),
      )) {
        return true;
      }

      const now = runtime.getCurrentSimTimeMs();
      const normalizedDistance = Math.max(0, toFiniteNumber(distanceValue, 0));
      const requestedSpeedFraction = resolveExplicitSpeedFraction(options);
      if (
        entity.mode === "ORBIT" &&
        (
          requestedSpeedFraction.explicit
            ? speedFractionsMatch(
                entity.speedFraction,
                requestedSpeedFraction.value,
              )
            : entity.speedFraction > 0
        ) &&
        entity.targetEntityID === target.itemID &&
        Math.abs(toFiniteNumber(entity.orbitDistance, 0) - normalizedDistance) < 1
      ) {
        logMovementDebug("cmd.orbit.duplicate", entity, {
          orbitTargetID: target.itemID,
          orbitDistance: roundNumber(normalizedDistance),
          requestedSpeedFraction: requestedSpeedFraction.explicit
            ? requestedSpeedFraction.value
            : null,
        });
        return true;
      }
      // A bare retune of the standing Orbit is a SetSpeedFraction alone.
      if (
        requestedSpeedFraction.explicit &&
        entity.mode === "ORBIT" &&
        entity.targetEntityID === target.itemID &&
        Math.abs(toFiniteNumber(entity.orbitDistance, 0) - normalizedDistance) < 1
      ) {
        return applyStandingCommandSpeedFraction(
          runtime,
          entity,
          requestedSpeedFraction.value,
          now,
          options,
          "orbit",
        );
      }
      const radial = normalizeVector(
        subtractVectors(entity.position, target.position),
        buildPerpendicular(entity.direction),
      );

      clearTrackingState(entity);
      entity.mode = "ORBIT";
      entity.targetEntityID = target.itemID;
      entity.orbitDistance = normalizedDistance;
      entity.orbitNormal = normalizeVector(
        crossProduct(radial, DEFAULT_UP),
        buildPerpendicular(radial),
      );
      entity.orbitSign = 1;
      entity.targetPoint = cloneVector(target.position);
      const previousSpeedFraction = entity.speedFraction;
      entity.speedFraction = requestedSpeedFraction.explicit
        ? requestedSpeedFraction.value
        : previousSpeedFraction > 0
          ? previousSpeedFraction
          : 1;
      const speedFractionChanged =
        !speedFractionsMatch(entity.speedFraction, previousSpeedFraction);
      persistShipEntity(entity);
      armMovementTrace(entity, "orbit", {
        orbitTargetID: target.itemID,
        orbitDistance: roundNumber(entity.orbitDistance),
        orbitTargetPosition: summarizeVector(target.position),
      }, now);
      logMovementDebug("cmd.orbit", entity, {
        orbitTargetID: target.itemID,
        orbitDistance: roundNumber(entity.orbitDistance),
        orbitTargetPosition: summarizeVector(target.position),
      });

      queueSubwarpMovement(runtime, options, (stamp) => {
        const updates = [
          {
            stamp,
            payload: destiny.buildOrbitPayload(
              entity.itemID,
              target.itemID,
              entity.orbitDistance,
            ),
          },
        ];
        if (speedFractionChanged) {
          updates.push({
            stamp,
            payload: destiny.buildSetSpeedFractionPayload(
              entity.itemID,
              entity.speedFraction,
            ),
          });
        }
        return updates;
      });

      return true;
    },

    orbit(runtime, session, targetEntityID, distanceValue = 0, options = {}) {
      const entity = runtime.getShipEntityForSession(session);
      return runtime.orbitShipEntity(
        entity,
        targetEntityID,
        distanceValue,
        options,
      );
    },
  };
  Object.defineProperty(commands, "gotoPointEntity", {
    value: gotoPointEntity,
    enumerable: false,
  });
  return commands;
}

module.exports = {
  createMovementSubwarpCommands,
};
