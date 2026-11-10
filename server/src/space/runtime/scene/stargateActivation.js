"use strict";

const {
  toFiniteNumber,
} = require("../../../common/numbers");
const {
  STARGATE_ACTIVATION_STATE,
} = require("../staticSceneEntity");

module.exports = {

settleTransientStargateActivationStates(now) {
    const changed = [];
    for (const entity of this.staticEntities) {
      if (entity.kind !== "stargate") {
        continue;
      }
      if (entity.activationState !== STARGATE_ACTIVATION_STATE.ACTIVATING) {
        continue;
      }
      if (toFiniteNumber(entity.activationTransitionAtMs, 0) > now) {
        continue;
      }
      entity.activationState = STARGATE_ACTIVATION_STATE.OPEN;
      entity.activationTransitionAtMs = 0;
      changed.push(entity);
    }
    return changed;
  },
};
