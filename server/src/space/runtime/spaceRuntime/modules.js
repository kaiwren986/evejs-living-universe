"use strict";


module.exports = {

activatePropulsionModule(session, moduleItem, effectName, options = {}) {
    const scene = this.getSceneForSession(session);
    return scene
      ? scene.activatePropulsionModule(session, moduleItem, effectName, options)
      : {
          success: false,
          errorMsg: "NOT_IN_SPACE",
        };
  },

deactivatePropulsionModule(session, moduleID, options = {}) {
    const scene = this.getSceneForSession(session);
    return scene
      ? scene.deactivatePropulsionModule(session, moduleID, options)
      : {
          success: false,
          errorMsg: "NOT_IN_SPACE",
        };
  },

activateGenericModule(session, moduleItem, effectName, options = {}) {
    const scene = this.getSceneForSession(session);
    return scene
      ? scene.activateGenericModule(session, moduleItem, effectName, options)
      : { success: false, errorMsg: "NOT_IN_SPACE" };
  },

deactivateGenericModule(session, moduleID, options = {}) {
    const scene = this.getSceneForSession(session);
    return scene
      ? scene.deactivateGenericModule(session, moduleID, options)
      : { success: false, errorMsg: "NOT_IN_SPACE" };
  },

deactivateAllActiveModules(session, options = {}) {
    const scene = this.getSceneForSession(session);
    return scene
      ? scene.deactivateAllActiveModules(session, options)
      : { success: false, errorMsg: "NOT_IN_SPACE" };
  },
};
