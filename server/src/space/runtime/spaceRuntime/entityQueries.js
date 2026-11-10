"use strict";

const runtimeEntryDirname = require("path").resolve(__dirname, "../..");
const path = require("path");
const microJumpDriveRuntime = require(path.join(
  runtimeEntryDirname,
  "./modules/microJumpDriveRuntime",
));
const {
  serializeSpaceState,
} = require("../entitySpacePersistence");
const {
  buildMicroJumpDriveRuntimeCallbacks,
} = require("../moduleRuntimeCallbacks");
const {
  toFiniteNumber,
  toInt,
} = require("../../../common/numbers");
const {
  healShipResourcesForSession,
} = require("../shipHealthState");
const {
  readEntityRackHeat,
  readStoredShipRackHeat,
  repairEntityFittedModules,
  resetEntityRackHeat,
} = require("../moduleHeat");

module.exports = {

getEntity(session, entityID) {
    const scene = this.getSceneForSession(session);
    return scene ? scene.getEntityByID(entityID) : null;
  },

// What each rack of a ship in the session's scene holds and what is heating
// it, by the rack's heat attribute; null when the ship is not there (a docked
// session has no scene).
getShipRackHeat(session, shipID) {
    return readEntityRackHeat(this.getEntity(session, shipID));
  },

// What each rack of a ship holds, wherever the ship is: its entity's in the
// session's scene, and otherwise what was stored with the ship (shipItem is
// its stored record), cooled to nowMs: the wall clock's now where none is
// given, and one time for everything that goes into one answer. Null for a
// cold ship that is not in the scene.
readShipRackHeat(session, shipItem, nowMs = Date.now()) {
    const shipID = toInt(shipItem && (shipItem.itemID || shipItem.shipID), 0);
    return (
      (shipID > 0 ? this.getShipRackHeat(session, shipID) : null) ||
      readStoredShipRackHeat(shipItem, nowMs)
    );
  },

// A Mobile Micro Jump Unit's jump, once its spool completes (from
// tickSceneFeatures): the cycle a ship's Micro Jump Drive runs. Its move is a
// teleport, which waits in the Movement queue for the next Destiny tick's
// doPreTick: nothing here
// writes the ship's position.
executeMobileMicroJumpForShip(session, unitID, options = {}) {
    const scene = this.getSceneForSession(session);
    if (!scene) {
      return {
        success: false,
        errorMsg: "SCENE_NOT_FOUND",
      };
    }

    const entity = scene.getShipEntityForSession(session);
    if (!entity || entity.kind !== "ship") {
      return {
        success: false,
        errorMsg: "SHIP_NOT_FOUND",
      };
    }

    const effectState = {
      moduleID: toInt(unitID, 0),
      typeID: toInt(options.typeID, 0),
      microJumpDriveEffect: true,
      microJumpDistanceMeters: Math.max(
        0,
        toFiniteNumber(options.jumpDistanceMeters, 100_000),
      ),
      microJumpJumpFxGuid: "effects.MicroJumpDriveJump",
    };

    return microJumpDriveRuntime.executeMicroJumpDriveCycle({
      scene,
      entity,
      effectState,
      nowMs: scene.getCurrentSimTimeMs(),
      callbacks: buildMicroJumpDriveRuntimeCallbacks(scene),
    });
  },

getBubbleIDForEntity(session, entityID) {
    const entity = this.getEntity(session, entityID);
    const bubbleID = toInt(entity && entity.bubbleID, 0);
    return bubbleID > 0 ? bubbleID : null;
  },

healSessionShipResources(session, options = {}) {
    const shipID = toInt(
      session &&
        session._space &&
        session._space.shipID,
      0,
    );
    if (!shipID) {
      return {
        success: false,
        errorMsg: "SHIP_NOT_FOUND",
      };
    }

    const scene = this.getSceneForSession(session);
    if (!scene) {
      return {
        success: false,
        errorMsg: "SCENE_NOT_FOUND",
      };
    }

    const entity = scene.getEntityByID(shipID);
    if (!entity || entity.kind !== "ship") {
      return {
        success: false,
        errorMsg: "SHIP_NOT_FOUND",
      };
    }

    const result = healShipResourcesForSession(session, scene, entity, options);
    if (!result || result.success !== true) {
      return result;
    }

    const repairedModuleIDs = repairEntityFittedModules(entity, {
      session,
      whenMs: result.data && result.data.whenMs,
    });
    const rackHeatReset = resetEntityRackHeat(
      scene,
      entity,
      result.data && result.data.whenMs,
    );
    return {
      ...result,
      data: {
        ...(result.data || {}),
        repairedModuleIDs,
        rackHeatReset,
      },
    };
  },

getEntitySpaceStateSnapshot(session, entityID) {
    const entity = this.getEntity(session, entityID);
    return entity ? serializeSpaceState(entity) : null;
  },

getBubbleForSession(session) {
    const scene = this.getSceneForSession(session);
    return scene ? scene.getBubbleForSession(session) : null;
  },

getSessionsInBubble(systemID, bubbleID) {
    const scene = this.ensureScene(systemID);
    return scene ? scene.getSessionsInBubble(bubbleID) : [];
  },

getDynamicEntitiesInBubble(systemID, bubbleID) {
    const scene = this.ensureScene(systemID);
    return scene ? scene.getDynamicEntitiesInBubble(bubbleID) : [];
  },

getShipsInBubble(systemID, bubbleID) {
    const scene = this.ensureScene(systemID);
    return scene ? scene.getShipsInBubble(bubbleID) : [];
  },

broadcastDestinyUpdatesToBubble(systemID, bubbleID, updates, options = {}) {
    const scene = this.ensureScene(systemID);
    return scene
      ? scene.broadcastDestinyUpdatesToBubble(bubbleID, updates, options)
      : { deliveredCount: 0 };
  },
};
