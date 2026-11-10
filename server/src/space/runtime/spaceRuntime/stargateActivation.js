"use strict";

const {
  toInt,
} = require("../../../common/numbers");
const {
  keepsAllStargatesActiveDuringLazyLoading,
} = require("../startupPreloadPlan");
const {
  STARGATE_ACTIVATION_STATE,
  STARGATE_ACTIVATION_TRANSITION_MS,
  coerceStableActivationState,
} = require("../staticSceneEntity");

module.exports = {

getSolarSystemStargateActivationState(systemID) {
    const numericSystemID = toInt(systemID, 0);
    if (!numericSystemID) {
      return STARGATE_ACTIVATION_STATE.CLOSED;
    }
    if (this.solarSystemGateActivationOverrides.has(numericSystemID)) {
      return this.solarSystemGateActivationOverrides.get(numericSystemID);
    }
    if (keepsAllStargatesActiveDuringLazyLoading()) {
      return STARGATE_ACTIVATION_STATE.OPEN;
    }
    if (this._garbageCollectedSolarSystemIDs.has(numericSystemID)) {
      return STARGATE_ACTIVATION_STATE.OPEN;
    }
    return this.isSolarSystemSceneLoaded(numericSystemID)
      ? STARGATE_ACTIVATION_STATE.OPEN
      : STARGATE_ACTIVATION_STATE.CLOSED;
  },

resolveStargateActivationState(stargate) {
    const numericGateID = toInt(stargate && stargate.itemID, 0);
    if (numericGateID && this.stargateActivationOverrides.has(numericGateID)) {
      return this.stargateActivationOverrides.get(numericGateID);
    }

    const destinationSystemID = toInt(
      stargate && stargate.destinationSolarSystemID,
      0,
    );
    if (destinationSystemID) {
      return this.getSolarSystemStargateActivationState(destinationSystemID);
    }

    return coerceStableActivationState(
      stargate && stargate.activationState,
      STARGATE_ACTIVATION_STATE.CLOSED,
    );
  },

refreshStargateActivationStates(options = {}) {
    const targetGateID = toInt(options.targetGateID, 0);
    const targetSystemID = toInt(options.targetSystemID, 0);
    const now = Date.now();
    const animateOpenTransitions =
      options.animateOpenTransitions !== false && options.broadcast !== false;
    const changedByScene = new Map();

    for (const scene of this.scenes.values()) {
      for (const entity of scene.staticEntities) {
        if (entity.kind !== "stargate") {
          continue;
        }
        if (targetGateID && toInt(entity.itemID, 0) !== targetGateID) {
          continue;
        }
        if (
          targetSystemID &&
          toInt(entity.destinationSolarSystemID, 0) !== targetSystemID
        ) {
          continue;
        }

        const nextActivationState = this.resolveStargateActivationState(entity);
        const currentStableActivationState = coerceStableActivationState(
          entity.activationState,
          STARGATE_ACTIVATION_STATE.CLOSED,
        );
        if (currentStableActivationState === nextActivationState) {
          continue;
        }

        if (
          animateOpenTransitions &&
          currentStableActivationState === STARGATE_ACTIVATION_STATE.CLOSED &&
          nextActivationState === STARGATE_ACTIVATION_STATE.OPEN
        ) {
          entity.activationState = STARGATE_ACTIVATION_STATE.ACTIVATING;
          entity.activationTransitionAtMs =
            now + STARGATE_ACTIVATION_TRANSITION_MS;
        } else {
          entity.activationState = nextActivationState;
          entity.activationTransitionAtMs = 0;
        }
        if (!changedByScene.has(scene)) {
          changedByScene.set(scene, []);
        }
        changedByScene.get(scene).push(entity);
      }
    }

    if (options.broadcast !== false) {
      for (const [scene, entities] of changedByScene.entries()) {
        scene.broadcastSlimItemChanges(entities);
      }
    }

    return [...changedByScene.entries()].flatMap(([scene, entities]) =>
      entities.map((entity) => ({
        systemID: scene.systemID,
        itemID: entity.itemID,
        activationState: entity.activationState,
      })),
    );
  },

setSolarSystemStargateActivationState(systemID, activationState, options = {}) {
    const numericSystemID = toInt(systemID, 0);
    if (!numericSystemID) {
      return [];
    }

    if (activationState === undefined || activationState === null) {
      this.solarSystemGateActivationOverrides.delete(numericSystemID);
    } else {
      this.solarSystemGateActivationOverrides.set(
        numericSystemID,
        coerceStableActivationState(
          activationState,
          STARGATE_ACTIVATION_STATE.CLOSED,
        ),
      );
    }

    return this.refreshStargateActivationStates({
      broadcast: options.broadcast !== false,
      targetSystemID: numericSystemID,
    });
  },

setStargateActivationState(stargateID, activationState, options = {}) {
    const numericStargateID = toInt(stargateID, 0);
    if (!numericStargateID) {
      return [];
    }

    if (activationState === undefined || activationState === null) {
      this.stargateActivationOverrides.delete(numericStargateID);
    } else {
      this.stargateActivationOverrides.set(
        numericStargateID,
        coerceStableActivationState(
          activationState,
          STARGATE_ACTIVATION_STATE.CLOSED,
        ),
      );
    }

    return this.refreshStargateActivationStates({
      broadcast: options.broadcast !== false,
      targetGateID: numericStargateID,
    });
  },
};
