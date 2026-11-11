"use strict";

const runtimeEntryDirname = require("path").resolve(__dirname, "../..");
const path = require("path");
const {
  canEntitiesInteractLocally,
  isSharedPveTarget,
  resolveEntityInteractionScope,
} = require(path.join(runtimeEntryDirname, "./destiny/identity/interactionScope.js"));
const {
  ABYSSAL_TELEPORT_TRANSITION_BYPASS,
} = require("../abyssalRoomEntity");
const {
  resolveAbyssalTeleportRestriction,
  resolveAbyssalWarpActivationRestriction,
} = require("../activationSpaceRestrictions");
const {
} = require("../destinyDeliveryEligibility");
const {
  markInventoryEntityLootAbandoned,
  sessionMayAbandonInventoryLoot,
} = require("../inventoryLootRights");
const {
  toInt,
} = require("../../../common/numbers");

module.exports = {

ensureInitialBallpark(session, options = {}) {
    const scene = this.getSceneForSession(session);
    return scene ? scene.ensureInitialBallpark(session, options) : false;
  },

gotoDirection(session, direction, options = {}) {
    const scene = this.getSceneForSession(session);
    return scene ? scene.gotoDirection(session, direction, options) : false;
  },

gotoPoint(session, point, options = {}) {
    const scene = this.getSceneForSession(session);
    return scene ? scene.gotoPoint(session, point, options) : false;
  },

alignTo(session, targetEntityID) {
    const scene = this.getSceneForSession(session);
    return scene ? scene.alignTo(session, targetEntityID) : false;
  },

followBall(session, targetEntityID, range, options = {}) {
    const scene = this.getSceneForSession(session);
    return scene ? scene.followBall(session, targetEntityID, range, options) : false;
  },

// Living Universe: send a native NPC hull to a point (the powered undock run).
gotoDynamicEntityPoint(systemID, entityOrID, point, options = {}) {
    const scene = this.ensureScene(systemID);
    return scene
      ? scene.gotoDynamicEntityPoint(entityOrID, point, options)
      : false;
  },

followDynamicEntity(systemID, entityOrID, targetEntityID, range, options = {}) {
    const scene = this.ensureScene(systemID);
    return scene ? scene.followShipEntity(entityOrID, targetEntityID, range, options) : false;
  },

orbit(session, targetEntityID, distanceValue, options = {}) {
    const scene = this.getSceneForSession(session);
    return scene ? scene.orbit(session, targetEntityID, distanceValue, options) : false;
  },

orbitDynamicEntity(systemID, entityOrID, targetEntityID, distanceValue, options = {}) {
    const scene = this.ensureScene(systemID);
    return scene ? scene.orbitShipEntity(entityOrID, targetEntityID, distanceValue, options) : false;
  },

associateSuccessfulFleetWarpFollower(
    leaderSession,
    followerSession,
    commandToken,
    options = {},
  ) {
    const scene = this.getSceneForSession(leaderSession);
    return scene &&
      typeof scene.associateSuccessfulFleetWarpFollower === "function"
      ? scene.associateSuccessfulFleetWarpFollower(
          leaderSession,
          followerSession,
          commandToken,
          options,
        )
      : false;
  },

// Brackets a fleet warp follower's warp order, so the leader sees the
// follower align (the scene's isEntityJoiningSessionFleetWarp).
noteJoiningFleetWarp(leaderSession, followerSession, commandToken) {
    const scene = this.getSceneForSession(leaderSession);
    const leaderEntity = scene ? scene.getShipEntityForSession(leaderSession) : null;
    const followerEntity = scene ? scene.getShipEntityForSession(followerSession) : null;
    if (!commandToken || !leaderEntity || !followerEntity) {
      return false;
    }
    scene.noteJoiningFleetWarp(commandToken, leaderEntity, followerEntity);
    return true;
  },

noteJoinedFleetWarp(leaderSession, followerSession, commandToken) {
    const scene = this.getSceneForSession(leaderSession);
    const followerEntity = scene ? scene.getShipEntityForSession(followerSession) : null;
    if (followerEntity) {
      scene.noteJoinedFleetWarp(commandToken, followerEntity);
    }
  },

warpToEntity(session, targetEntityID, options = {}) {
    const abyssalWarpRestriction =
      resolveAbyssalWarpActivationRestriction(session);
    if (abyssalWarpRestriction && abyssalWarpRestriction.blocked) {
      return {
        success: false,
        errorMsg: abyssalWarpRestriction.errorMsg,
        data: abyssalWarpRestriction,
      };
    }
    const scene = this.getSceneForSession(session);
    return scene
      ? scene.warpToEntity(session, targetEntityID, options)
      : { success: false, errorMsg: "NOT_IN_SPACE" };
  },

warpToPoint(session, point, options = {}) {
    const abyssalWarpRestriction =
      resolveAbyssalWarpActivationRestriction(session);
    if (abyssalWarpRestriction && abyssalWarpRestriction.blocked) {
      return {
        success: false,
        errorMsg: abyssalWarpRestriction.errorMsg,
        data: abyssalWarpRestriction,
      };
    }
    const scene = this.getSceneForSession(session);
    return scene
      ? scene.warpToPoint(session, point, options)
      : { success: false, errorMsg: "NOT_IN_SPACE" };
  },

warpDynamicEntityToPoint(systemID, entityOrID, point, options = {}) {
    const scene = this.ensureScene(systemID);
    return scene
      ? scene.warpDynamicEntityToPoint(entityOrID, point, options)
      : { success: false, errorMsg: "SCENE_NOT_FOUND" };
  },

forceStartPendingWarp(systemID, entityOrID, options = {}) {
    const scene = this.ensureScene(systemID);
    return scene
      ? scene.forceStartPendingWarp(entityOrID, options)
      : { success: false, errorMsg: "SCENE_NOT_FOUND" };
  },

startSessionlessWarpIngress(systemID, entityOrID, point, options = {}) {
    const scene = this.ensureScene(systemID);
    return scene
      ? scene.startSessionlessWarpIngress(entityOrID, point, options)
      : { success: false, errorMsg: "SCENE_NOT_FOUND" };
  },

teleportSessionShipToPoint(session, point, options = {}) {
    const abyssalRestriction = resolveAbyssalTeleportRestriction(
      session,
      null,
      this.getSceneForSession(session),
      options,
    );
    if (abyssalRestriction) {
      return {
        success: false,
        errorMsg: abyssalRestriction.errorMsg,
        data: abyssalRestriction,
      };
    }
    const scene = this.getSceneForSession(session);
    return scene
      ? scene.teleportDynamicEntityToPoint(
        session && session._space ? session._space.shipID : null,
        point,
        {
          ...options,
          refreshOwnerSession: options.refreshOwnerSession !== false,
        },
      )
      : { success: false, errorMsg: "NOT_IN_SPACE" };
  },

teleportSessionShipForAbyssalTransition(session, point, options = {}) {
    const scene = this.getSceneForSession(session);
    return scene
      ? scene.teleportDynamicEntityToPoint(
        session && session._space ? session._space.shipID : null,
        point,
        {
          ...options,
          refreshOwnerSession: options.refreshOwnerSession !== false,
          [ABYSSAL_TELEPORT_TRANSITION_BYPASS]: true,
        },
      )
      : { success: false, errorMsg: "NOT_IN_SPACE" };
  },

teleportDynamicEntityToPoint(systemID, entityOrID, point, options = {}) {
    const scene = this.ensureScene(systemID);
    return scene
      ? scene.teleportDynamicEntityToPoint(entityOrID, point, options)
      : { success: false, errorMsg: "SCENE_NOT_FOUND" };
  },

setSpeedFraction(session, fraction) {
    const scene = this.getSceneForSession(session);
    return scene ? scene.setSpeedFraction(session, fraction) : false;
  },

stop(session) {
    const scene = this.getSceneForSession(session);
    return scene ? scene.stop(session) : false;
  },

// Relinquish loot rights on one or more wrecks/containers (the server side of
  // the client's "Abandon Wreck" / "Abandon All Wrecks" menu, dispatched via
  // remoteBallpark.CmdAbandonLoot). The client already filters the id list to
  // entities it believes the pilot has loot rights to; we re-validate here.
  abandonInventoryLootForSession(session, itemIDs) {
    const scene = this.getSceneForSession(session);
    if (!scene) {
      return {
        success: false,
        errorMsg: "SCENE_NOT_FOUND",
      };
    }
    const shipEntity = scene.getShipEntityForSession(session);
    if (!shipEntity) {
      return {
        success: false,
        errorMsg: "SHIP_NOT_FOUND",
      };
    }

    const requestedIDs = Array.isArray(itemIDs)
      ? itemIDs
      : itemIDs === null || itemIDs === undefined
        ? []
        : [itemIDs];
    const abandoned = [];
    const changedEntities = [];

    for (const rawID of requestedIDs) {
      const entityID = toInt(rawID, 0);
      if (entityID <= 0) {
        continue;
      }
      const entity = scene.getEntityByID(entityID);
      if (
        !entity ||
        (entity.kind !== "wreck" && entity.kind !== "container") ||
        !canEntitiesInteractLocally(shipEntity, entity) ||
        entity.lootAbandoned === true
      ) {
        continue;
      }
      if (!sessionMayAbandonInventoryLoot(session, entity)) {
        continue;
      }
      if (markInventoryEntityLootAbandoned(entity)) {
        abandoned.push(entityID);
        changedEntities.push(entity);
      }
    }

    if (changedEntities.length > 0) {
      scene.broadcastSlimItemChanges(changedEntities);
    }

    return {
      success: true,
      data: {
        abandoned,
        requestedCount: requestedIDs.length,
        abandonedCount: abandoned.length,
      },
    };
  },

stopDynamicEntity(systemID, entityOrID, options = {}) {
    const scene = this.ensureScene(systemID);
    return scene ? scene.stopShipEntity(entityOrID, options) : false;
  },
};
