"use strict";

// Targeting in the dogma service: locking and unlocking targets (AddTarget, CancelAddTarget,
// RemoveTarget, RemoveTargets, ClearTargets), the lists of what the ship has locked and what has
// locked it (GetTargets, GetTargeters), and the targets of a starbase a pilot controls, locked on
// its behalf (AddTargetOBO, RemoveTargetOBO). The locks themselves live in the space runtime and
// the starbase control runtime. These are DogmaService methods, moved here as they were;
// dogmaService.js puts them back on the class prototype, so `this` is the service.

const path = require("path");
const log = require(path.join(__dirname, "../../../utils/logger"));
const {
  extractList,
} = require(path.join(__dirname, "../../_shared/serviceHelpers"));
const spaceRuntime = require(path.join(__dirname, "../../../space/runtime"));

module.exports = {
  _buildTargetIDList(targetIDs = []) {
    return {
      type: "list",
      items: (Array.isArray(targetIDs) ? targetIDs : [])
        .map((targetID) => Number(targetID) || 0)
        .filter((targetID) => targetID > 0),
    };
  },

  Handle_AddTargetOBO(args, session) {
    const control = require("../../starbase/starbaseControlRuntime");
    const result = control.addTargetOBO(session, Number(args && args[0]), Number(args && args[1]));
    if (!result.success && !String(result.errorMsg || "").startsWith("STARBASE_")) {
      this._throwTargetingUserError(result.errorMsg, result.data || {});
    }
    const data = control.requireStarbaseControlResult(result);
    return [data && data.pending ? 1 : 0, this._buildTargetIDList(data && data.targets || [])];
  },

  Handle_RemoveTargetOBO(args, session) {
    const control = require("../../starbase/starbaseControlRuntime");
    control.requireStarbaseControlResult(control.removeTargetOBO(session, Number(args && args[0]), Number(args && args[1])));
    return null;
  },

  Handle_AddTarget(args, session) {
    const targetID = args && args.length > 0 ? Number(args[0]) || 0 : 0;
    log.debug(`[DogmaIM] AddTarget targetID=${targetID}`);
    const result = spaceRuntime.addTarget(session, targetID);
    if (!result || !result.success) {
      const errorData =
        result && result.data && typeof result.data === "object"
          ? { ...result.data }
          : {};
      if (errorData.targetTypeID === undefined && targetID > 0) {
        const scene =
          session && typeof spaceRuntime.getSceneForSession === "function"
            ? spaceRuntime.getSceneForSession(session)
            : null;
        const targetEntity =
          scene && typeof scene.getEntityByID === "function"
            ? scene.getEntityByID(targetID)
            : null;
        if (targetEntity && Number(targetEntity.typeID) > 0) {
          errorData.targetTypeID = Number(targetEntity.typeID) || 0;
        }
      }
      this._throwTargetingUserError(result && result.errorMsg, errorData);
    }
    const shipID = Number(
      session && session._space && session._space.shipID ||
      session && (session.activeShipID || session.shipID || session.shipid),
    ) || 0;
    if (shipID > 0 && session && typeof session.sendNotification === "function") {
      session.sendNotification("OnInvulnCancelled", "shipid", [shipID]);
    }
    return [
      result.data && result.data.pending ? 1 : 0,
      this._buildTargetIDList(
        (result.data && result.data.targets) || spaceRuntime.getTargets(session),
      ),
    ];
  },

  Handle_CancelAddTarget(args, session) {
    const targetID = args && args.length > 0 ? Number(args[0]) || 0 : 0;
    log.debug(`[DogmaIM] CancelAddTarget targetID=${targetID}`);
    spaceRuntime.cancelAddTarget(session, targetID, {
      notifySelf: false,
    });
    return null;
  },

  Handle_RemoveTarget(args, session) {
    const targetID = args && args.length > 0 ? Number(args[0]) || 0 : 0;
    log.debug(`[DogmaIM] RemoveTarget targetID=${targetID}`);
    spaceRuntime.removeTarget(session, targetID, {
      notifySelf: true,
      notifyTarget: true,
    });
    return null;
  },

  Handle_RemoveTargets(args, session) {
    const rawTargetIDs = args && args.length > 0 ? args[0] : [];
    const targetIDs = extractList(rawTargetIDs)
      .map((targetID) => Number(targetID) || 0)
      .filter((targetID) => targetID > 0);
    log.debug(`[DogmaIM] RemoveTargets count=${targetIDs.length}`);
    spaceRuntime.removeTargets(session, targetIDs, {
      notifySelf: true,
      notifyTarget: true,
    });
    return null;
  },

  Handle_ClearTargets(args, session) {
    log.debug("[DogmaIM] ClearTargets");
    spaceRuntime.clearTargets(session, {
      notifySelf: true,
      notifyTarget: true,
    });
    return null;
  },

  Handle_GetTargets(args, session) {
    log.debug("[DogmaIM] GetTargets");
    return this._buildTargetIDList(spaceRuntime.getTargets(session));
  },

  Handle_GetTargeters(args, session) {
    log.debug("[DogmaIM] GetTargeters");
    return this._buildTargetIDList(spaceRuntime.getTargeters(session));
  },
};
