"use strict";

const destiny = require("../index.js");
const {
  hasQueuedMovement,
  queueMovementCommand,
} = require("./movementQueueing");
const {
  isWarping,
} = require("../simulation/evolve");

function createMovementStopSpeedCommands(deps = {}) {
  const {
    addVectors,
    armMovementTrace,
    clamp,
    clearTrackingState,
    cloneVector,
    logMovementDebug,
    magnitude,
    persistShipEntity,
    roundNumber,
    scaleVector,
    MAX_SUBWARP_SPEED_FRACTION,
  } = deps;

  const commands = {
    setSpeedFraction(runtime, session, fraction) {
      const entity = runtime.getShipEntityForSession(session);
      if (!entity || entity.mode === "WARP" || entity.pendingDock) {
        return false;
      }

      const now = runtime.getCurrentSimTimeMs();
      const normalizedFraction = clamp(fraction, 0, MAX_SUBWARP_SPEED_FRACTION);
      if (queueMovementCommand(
        runtime,
        entity,
        "setSpeedFraction",
        () => commands.setSpeedFraction(runtime, session, fraction),
      )) {
        return true;
      }

      if (normalizedFraction <= 0) {
        // A pilot's SetSpeedFraction(0) is not a Stop: it stops the ship and
        // leaves the fraction at 0. A Stop keeps the fraction, so the
        // 0 is written only once the Stop has applied here, at this tick, and
        // the client is told of it with that Stop, on the same stamp, as
        // retail's Ballpark::SetSpeedFraction sets the Ball's own fraction. A
        // bare Stop still sends Stop alone.
        const stopped = runtime.stop(session);
        if (stopped) {
          entity.speedFraction = 0;
          persistShipEntity(entity);
          runtime.queueBubbleHistory([
            destiny.buildSetSpeedFractionPayload(entity.itemID, 0),
          ]);
        }
        return stopped;
      }

      entity.speedFraction = normalizedFraction;
      if (entity.speedFraction > 0 && entity.mode === "STOP") {
        entity.mode = "GOTO";
        entity.targetPoint = addVectors(
          cloneVector(entity.position),
          scaleVector(entity.direction, 1.0e16),
        );
      }
      persistShipEntity(entity);
      armMovementTrace(entity, "speed", {
        requestedSpeedFraction: roundNumber(normalizedFraction, 3),
      }, now);
      logMovementDebug("cmd.speed", entity);

      runtime.queueBubbleHistory([
        destiny.buildSetSpeedFractionPayload(
          entity.itemID,
          entity.speedFraction,
        ),
      ]);

      return true;
    },

    stopShipEntity(runtime, entityOrID, options = {}) {
      const entity =
        typeof entityOrID === "object" && entityOrID !== null
          ? entityOrID
          : runtime.getEntityByID(entityOrID);
      if (!entity || entity.pendingDock) {
        return false;
      }
      // A ship in warp cannot stop: Evolve brings it out at the drop. An
      // aligning ship stops like any other. With a movement change queued
      // for it (a teleport that ends the warp), its state at the tick
      // is not what it reads now: the Stop is queued and decided when it
      // applies.
      if (isWarping(entity) && !hasQueuedMovement(runtime, entity)) {
        logMovementDebug("cmd.stop.ignored.activeWarp", entity);
        return false;
      }
      if (queueMovementCommand(
        runtime,
        entity,
        "stop",
        () => commands.stopShipEntity(runtime, entity, options),
      )) {
        return true;
      }

      // A Stop keeps the speed fraction, as retail's Ballpark::Stop and
      // Evolve's own stopBall do, so the next Follow or Orbit flies at the
      // speed set before it. "Already stopped" is
      // read from mode and speed alone: the fraction is never a sign of motion.
      const now = runtime.getCurrentSimTimeMs();
      const wasAlreadyStopped =
        entity.mode === "STOP" &&
        magnitude(entity.velocity) < 0.1;
      entity.mode = "STOP";
      entity.targetPoint = cloneVector(entity.position);
      clearTrackingState(entity);
      persistShipEntity(entity);
      armMovementTrace(entity, "stop", {}, now);
      logMovementDebug("cmd.stop", entity);

      if (wasAlreadyStopped) {
        return true;
      }

      // TQ's CmdStop packet for the citadel-undock golden path contains only
      // Stop(shipID); SetSpeedFraction(0) is a separate command family.
      runtime.queueBubbleHistory([destiny.buildStopPayload(entity.itemID)]);

      return true;
    },

    stop(runtime, session) {
      const entity = runtime.getShipEntityForSession(session);
      return runtime.stopShipEntity(entity);
    },
  };
  return commands;
}

module.exports = {
  createMovementStopSpeedCommands,
};
