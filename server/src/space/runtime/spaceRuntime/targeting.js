"use strict";


module.exports = {

addTarget(session, targetEntityID) {
    const scene = this.getSceneForSession(session);
    return scene
      ? scene.addTarget(session, targetEntityID)
      : {
          success: false,
          errorMsg: "NOT_IN_SPACE",
        };
  },

cancelAddTarget(session, targetEntityID, options = {}) {
    const scene = this.getSceneForSession(session);
    return scene
      ? scene.cancelAddTarget(session, targetEntityID, options)
      : {
          success: false,
          errorMsg: "NOT_IN_SPACE",
        };
  },

removeTarget(session, targetEntityID, options = {}) {
    const scene = this.getSceneForSession(session);
    return scene
      ? scene.removeTarget(session, targetEntityID, options)
      : {
          success: false,
          errorMsg: "NOT_IN_SPACE",
        };
  },

removeTargets(session, targetEntityIDs = [], options = {}) {
    const scene = this.getSceneForSession(session);
    return scene
      ? scene.removeTargets(session, targetEntityIDs, options)
      : {
          success: false,
          errorMsg: "NOT_IN_SPACE",
        };
  },

clearTargets(session, options = {}) {
    const scene = this.getSceneForSession(session);
    return scene
      ? scene.clearTargets(session, options)
      : {
          success: false,
          errorMsg: "NOT_IN_SPACE",
        };
  },

getTargets(session) {
    const scene = this.getSceneForSession(session);
    return scene ? scene.getTargets(session) : [];
  },

getTargeters(session) {
    const scene = this.getSceneForSession(session);
    return scene ? scene.getTargeters(session) : [];
  },
};
