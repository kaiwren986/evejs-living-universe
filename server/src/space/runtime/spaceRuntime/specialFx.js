"use strict";

const runtimeEntryDirname = require("path").resolve(__dirname, "../..");
const path = require("path");
const {
  isReadyForDestiny,
} = require("../destinyDeliveryEligibility");
const {
  buildSpecialFxDestinyUpdates,
} = require("../moduleSpecialFx");
const {
  toInt,
} = require("../../../common/numbers");
const {
  DEBUG_TEST_AUTO_TARGET_DEFAULT_RANGE_METERS,
  resolveDebugTestNearestStationTarget,
} = require("../runtimeDebugInstrumentation");

module.exports = {

playSpecialFx(session, guid, options = {}) {
    if (!session || !session._space) {
      return {
        success: false,
        errorMsg: "NOT_IN_SPACE",
      };
    }

    if (!isReadyForDestiny(session)) {
      return {
        success: false,
        errorMsg: "DESTINY_NOT_READY",
      };
    }

    const scene = this.getSceneForSession(session);
    if (!scene) {
      return {
        success: false,
        errorMsg: "SCENE_NOT_FOUND",
      };
    }

    const {
      shipID: requestedShipID = null,
      debugAutoTarget = null,
      debugAutoTargetRangeMeters = DEBUG_TEST_AUTO_TARGET_DEFAULT_RANGE_METERS,
      debugOnly = false,
      includeStopInSameUpdate = false,
      ...fxOptions
    } = options || {};
    const shipID = Number(requestedShipID || session._space.shipID || 0) || 0;
    if (!shipID) {
      return {
        success: false,
        errorMsg: "SHIP_NOT_FOUND",
      };
    }

    const entity = scene.getEntityByID(shipID);
    if (!entity) {
      return {
        success: false,
        errorMsg: "SHIP_NOT_FOUND",
      };
    }

    const resolvedFxOptions = { ...fxOptions };
    let debugAutoTargetResult = null;
    const hasExplicitTargetID = Number(resolvedFxOptions.targetID || 0) > 0;
    if (!hasExplicitTargetID && debugAutoTarget === "nearest_station") {
      debugAutoTargetResult = resolveDebugTestNearestStationTarget(
        scene,
        entity,
        debugAutoTargetRangeMeters,
      );
      if (debugAutoTargetResult.success) {
        resolvedFxOptions.targetID = debugAutoTargetResult.data.target.itemID;
      } else {
        const stopLikeRequest =
          resolvedFxOptions.start === false || resolvedFxOptions.active === false;
        if (!stopLikeRequest) {
          return {
            success: false,
            errorMsg: debugAutoTargetResult.errorMsg,
            data: {
              ...(debugAutoTargetResult.data || {}),
              debugAutoTarget,
              debugOnly,
            },
          };
        }
      }
    }

    const stamp = scene.queueCharacterHistory(session, buildSpecialFxDestinyUpdates(
      shipID,
      guid,
      resolvedFxOptions,
      scene.nextDestinyStamp,
      includeStopInSameUpdate,
    ));
    return {
      success: true,
      data: {
        autoTarget:
          debugAutoTargetResult && debugAutoTargetResult.success
            ? {
                mode: debugAutoTarget,
                maxRangeMeters: debugAutoTargetResult.data.maxRangeMeters,
                distanceMeters: debugAutoTargetResult.data.nearestDistanceMeters,
                targetID: debugAutoTargetResult.data.target.itemID,
                targetName:
                  debugAutoTargetResult.data.target.itemName ||
                  `station ${debugAutoTargetResult.data.target.itemID}`,
              }
            : null,
        debugOnly,
        guid: String(guid || ""),
        shipID,
        stamp,
        departureEffectSent: true,
        departureEffectStamp: stamp,
      },
    };
  },

stopSpecialFx(session, guid, options = {}) {
    if (!session || !session._space) {
      return {
        success: false,
        errorMsg: "NOT_IN_SPACE",
      };
    }
    if (!isReadyForDestiny(session)) {
      return {
        success: false,
        errorMsg: "DESTINY_NOT_READY",
      };
    }
    const scene = this.getSceneForSession(session);
    if (!scene) {
      return {
        success: false,
        errorMsg: "SCENE_NOT_FOUND",
      };
    }
    const sourceID = toInt(
      options && (options.sourceID || options.shipID || options.entityID),
      0,
    );
    if (sourceID <= 0 || !scene.getEntityByID(sourceID)) {
      return {
        success: false,
        errorMsg: "SHIP_NOT_FOUND",
      };
    }
    const effectName = String(guid || "").trim();
    if (!effectName || typeof session.sendNotification !== "function") {
      return {
        success: false,
        errorMsg: "SPECIAL_FX_REMOVE_UNAVAILABLE",
      };
    }
    try {
      // The retail teardown is a client OnRemoveFX scatter with precisely the
      // effect GUID and source ball ID. Use the normal notification marshal
      // path; do not invent a second destiny-action tuple for this event.
      session.sendNotification("OnRemoveFX", "clientID", [effectName, sourceID]);
    } catch (error) {
      return {
        success: false,
        errorMsg: String(error && error.message || "SPECIAL_FX_REMOVE_FAILED"),
      };
    }
    return {
      success: true,
      data: {
        effectName,
        sourceID,
        notification: "OnRemoveFX",
        payload: [effectName, sourceID],
      },
    };
  },
};
