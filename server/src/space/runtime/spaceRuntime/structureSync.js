"use strict";

const {
  toInt,
} = require("../../../common/numbers");
const {
  syncRuntimeStructureStateChanges,
} = require("../structureLifecycleFanout");

module.exports = {

syncStructureSceneState(systemID, options = {}) {
    const numericSystemID = toInt(systemID, 0);
    const scene = this.scenes.get(numericSystemID);
    if (!scene) {
      return {
        success: true,
        data: {
          added: [],
          updated: [],
        },
      };
    }

    return {
      success: true,
      data: scene.syncStructureEntitiesFromState(options),
    };
  },

handleStructureStateChange(changePayload = {}) {
    return syncRuntimeStructureStateChanges(this, changePayload);
  },
};
