"use strict";

const runtimeEntryDirname = require("path").resolve(__dirname, "../..");
const path = require("path");
const log = require(path.join(runtimeEntryDirname, "../utils/logger"));
const {
  canEntitiesInteractLocally,
  isSharedPveTarget,
  resolveEntityInteractionScope,
} = require(path.join(runtimeEntryDirname, "./destiny/identity/interactionScope.js"));
const {
  buildFleetWarpCommandAssociationPlan,
  clearFleetWarpCommandAssociation,
  commitFleetWarpCommandAssociationPlan,
  getFleetWarpCommandAssociation,
  haveSameFleetWarpCommandAssociation,
  isFleetWarpInProgress,
} = require(path.join(
  runtimeEntryDirname,
  "../services/fleets/fleetWarpCommandAssociation.js",
));
const {
  buildDockingAcceptedNotificationPayload,
  buildOrdinaryDockingStopPresentationUpdates,
  buildTeleportStopPresentationUpdates,
} = require(path.join(
  runtimeEntryDirname,
  "./destiny/presentation/mode.js",
));
const {
  applyPendingDockStateCommand,
} = require(path.join(runtimeEntryDirname, "./destiny/commands/docking.js"));
const {
  applyTeleportRelocationMotionCommand,
} = require(path.join(runtimeEntryDirname, "./destiny/commands/teleport.js"));
const {
  isAligningForWarp,
  setBallPosition,
  setBallVelocity,
} = require(path.join(runtimeEntryDirname, "./destiny/simulation/evolve.js"));
const hostileModuleRuntime = require(path.join(
  runtimeEntryDirname,
  "./modules/hostileModuleRuntime",
));
const {
  ABYSSAL_TELEPORT_TRANSITION_BYPASS,
} = require("../abyssalRoomEntity");
const {
  resolveAbyssalTeleportRestriction,
  resolveAbyssalWarpActivationRestriction,
} = require("../activationSpaceRestrictions");
const {
  resolveSessionCrimewatchDockingRestriction,
} = require("../crimewatchAdapter");
const {
} = require("../destinyDeliveryEligibility");
const {
  dispatchAlignTo,
  dispatchFollowBall,
  dispatchFollowShipEntity,
  dispatchForceStartPendingWarp,
  dispatchGotoDirection,
  dispatchGotoPoint,
  dispatchIndependentWarpWithFleetAssociationRetirement,
  dispatchOrbit,
  dispatchOrbitShipEntity,
  dispatchSetSpeedFraction,
  dispatchStartSessionlessWarpIngress,
  dispatchStop,
  dispatchStopShipEntity,
  dispatchStopWarpScrambledAlign,
  dispatchStopWarpDisruptedAlign,
  dispatchWarpDynamicEntityToPoint,
  dispatchWarpToEntity,
  dispatchWarpToPoint,
  isInvalidDestinyFollowOrbitCommand,
  resetEntityMotion,
  resetEntityMotionForHardRelocation,
} = require("../destinyMovementEngine");
const {
  persistDynamicEntity,
  persistShipEntity,
} = require("../entitySpacePersistence");
const {
  hasPostMicroJumpWarpScramble,
} = require("../microJumpDriveEligibility");
const {
  toFiniteNumber,
  toInt,
} = require("../../../common/numbers");
const {
  STRANDED_DESTINY_SESSION_RECOVERY_MS,
  STRANDED_DESTINY_SESSION_SWEEP_INTERVAL_MS,
  logMovementDebug,
} = require("../runtimeDebugInstrumentation");
const {
  lazyRequire,
} = require("../runtimeModuleBoundary");
const {
  hasActiveShipDockingDisallowedEffect,
  isShipMovementLockedByRuntime,
  isShipWarpDisabledByRuntime,
} = require("../shipActionRestrictions");
const {
  demoteEntityMassiveState,
} = require("../shipCloak");
const {
  STATION_DOCK_ACCEPT_DELAY_MS,
  buildDockingDebugState,
  canShipDockAtStation,
} = require("../stationDockingGeometry");
const {
  buildStructureDockingTransitionUpdates,
} = require("../structureTether");
const {
  breakEntityTimedInvulnerability,
} = require("../timedInvulnerability");
const {
  cloneVector,
  normalizeVector,
} = require("../../../common/vector");

const { WARP_TRANSMISSION_RECEIPT } = require(path.join(runtimeEntryDirname, "./destiny/commands/warpTransmissionReceipt"));

module.exports = {

cancelStargateJumpCloakAfterCommand(session, commandResult, reason) {
    const succeeded =
      commandResult === true ||
      (
        commandResult &&
        typeof commandResult === "object" &&
        commandResult.success !== false
      );
    if (!succeeded) {
      return commandResult;
    }
    this.cancelStargateJumpCloak(session, reason, {
      nowMs: this.getCurrentSimTimeMs(),
    });
    return commandResult;
  },

// Flying the ship gives up the undock grace — INCLUDING ordering it to stop.
  //
  // Called from every pilot movement command once that command has cleared its
  // "can this ship move at all" guards, so a command the runtime refuses (mid
  // warp, docking, immobilised) never costs the pilot their invulnerability.
  breakUndockInvulnerabilityForPilotCommand(session) {
    return breakEntityTimedInvulnerability(this.getShipEntityForSession(session), {
      trigger: "movement",
    });
  },

cancelStargateJumpCloakBeforePilotCommand(session, reason, options = {}) {
    return this.cancelStargateJumpCloak(session, reason, {
      nowMs: toFiniteNumber(options.nowMs, this.getCurrentSimTimeMs()),
    });
  },

gotoDirection(session, direction, options = {}) {
    const entity = this.getShipEntityForSession(session);
    if (
      !entity ||
      entity.mode === "WARP" ||
      entity.pendingDock ||
      isShipMovementLockedByRuntime(entity, this.getCurrentSimTimeMs())
    ) {
      return false;
    }
    this.cancelStargateJumpCloakBeforePilotCommand(session, "movement");
    const result = dispatchGotoDirection(this, session, direction, options);
    this.cancelStargateJumpCloakAfterCommand(session, result, "movement");
    if (result) {
      this.breakUndockInvulnerabilityForPilotCommand(session);
      this.retireInactiveFleetWarpCommandAssociation(entity);
      this.processSessionShipCloakProximityDecloak(session);
    }
    return result;
  },

gotoPoint(session, point, options = {}) {
    const entity = this.getShipEntityForSession(session);
    if (
      !entity ||
      entity.mode === "WARP" ||
      entity.pendingDock ||
      isShipMovementLockedByRuntime(entity, this.getCurrentSimTimeMs())
    ) {
      return false;
    }
    this.cancelStargateJumpCloakBeforePilotCommand(session, "movement");
    const result = dispatchGotoPoint(this, session, point, options);
    this.cancelStargateJumpCloakAfterCommand(session, result, "movement");
    if (result) {
      this.breakUndockInvulnerabilityForPilotCommand(session);
      this.retireInactiveFleetWarpCommandAssociation(entity);
      this.processSessionShipCloakProximityDecloak(session);
    }
    return result;
  },

alignTo(session, targetEntityID) {
    const entity = this.getShipEntityForSession(session);
    const target = this.getEntityByID(targetEntityID);
    if (
      !entity ||
      !target ||
      entity.mode === "WARP" ||
      entity.pendingDock ||
      isShipMovementLockedByRuntime(entity, this.getCurrentSimTimeMs())
    ) {
      return false;
    }
    this.cancelStargateJumpCloakBeforePilotCommand(session, "movement");
    const result = dispatchAlignTo(this, session, targetEntityID);
    this.cancelStargateJumpCloakAfterCommand(session, result, "movement");
    if (result) {
      this.breakUndockInvulnerabilityForPilotCommand(session);
      this.retireInactiveFleetWarpCommandAssociation(entity);
      this.processSessionShipCloakProximityDecloak(session);
    }
    return result;
  },

// Living Universe: send a native NPC hull to a point (the powered undock run).
gotoDynamicEntityPoint(entityOrID, point, options = {}) {
    const entity =
      entityOrID && typeof entityOrID === "object"
        ? entityOrID
        : this.getEntityByID(entityOrID);
    if (
      !entity ||
      entity.nativeNpc !== true ||
      (entity.kind !== "ship" && entity.kind !== "fighter") ||
      entity.mode === "WARP" ||
      entity.pendingDock ||
      !point ||
      !["x", "y", "z"].every((axis) => Number.isFinite(Number(point[axis])))
    ) {
      return false;
    }
    return require("../destinyMovementEngine").dispatchGotoPointEntity(
      this,
      entity,
      point,
      options,
    );
  },

followShipEntity(entityOrID, targetEntityID, range = 0, options = {}) {
    return dispatchFollowShipEntity(
      this,
      entityOrID,
      targetEntityID,
      range,
      options,
    );
  },

followBall(session, targetEntityID, range = 0, options = {}) {
    const entity = this.getShipEntityForSession(session);
    const target = this.getEntityByID(targetEntityID);
    if (
      isInvalidDestinyFollowOrbitCommand(entity, target, range) ||
      isShipMovementLockedByRuntime(entity, this.getCurrentSimTimeMs())
    ) {
      return false;
    }
    this.cancelStargateJumpCloakBeforePilotCommand(session, "movement");
    const result = dispatchFollowBall(this, session, targetEntityID, range, options);
    this.cancelStargateJumpCloakAfterCommand(session, result, "movement");
    if (result) {
      this.breakUndockInvulnerabilityForPilotCommand(session);
      this.retireInactiveFleetWarpCommandAssociation(entity);
      this.processSessionShipCloakProximityDecloak(session);
    }
    return result;
  },

orbitShipEntity(entityOrID, targetEntityID, distanceValue = 0, options = {}) {
    return dispatchOrbitShipEntity(
      this,
      entityOrID,
      targetEntityID,
      distanceValue,
      options,
    );
  },

orbit(session, targetEntityID, distanceValue = 0, options = {}) {
    const entity = this.getShipEntityForSession(session);
    const target = this.getEntityByID(targetEntityID);
    if (
      isInvalidDestinyFollowOrbitCommand(entity, target, distanceValue) ||
      isShipMovementLockedByRuntime(entity, this.getCurrentSimTimeMs())
    ) {
      return false;
    }
    this.cancelStargateJumpCloakBeforePilotCommand(session, "movement");
    const result = dispatchOrbit(this, session, targetEntityID, distanceValue, options);
    this.cancelStargateJumpCloakAfterCommand(session, result, "movement");
    if (result) {
      this.breakUndockInvulnerabilityForPilotCommand(session);
      this.retireInactiveFleetWarpCommandAssociation(entity);
      this.processSessionShipCloakProximityDecloak(session);
    }
    return result;
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
    const entity = this.getShipEntityForSession(session);
    if (isShipWarpDisabledByRuntime(entity, this.getCurrentSimTimeMs())) {
      return {
        success: false,
        errorMsg: "SHIP_IMMOBILE",
      };
    }
    const targetEntity = this.getEntityByID(targetEntityID);
    if (targetEntity && targetEntity.kind === "wormhole") {
      try {
        const wormholeRuntime = lazyRequire("../services/exploration/wormholes/wormholeRuntime");
        wormholeRuntime.markWarpInitiated(targetEntityID, this.getCurrentSimTimeMs());
        wormholeRuntime.syncSceneEntities(this, this.getCurrentSimTimeMs());
      } catch (error) {
        log.warn(
          `[SpaceRuntime] Wormhole warp pre-activation failed for system=${this.systemID} target=${targetEntityID}: ${error.message}`,
        );
      }
    }
    return dispatchIndependentWarpWithFleetAssociationRetirement(
      entity,
      () => {
        const result = dispatchWarpToEntity(
          this,
          session,
          targetEntityID,
          options,
        );
        if (result && result.success === true) {
          // Warp is movement too, but downstream target/range/dungeon checks
          // must succeed before the protection is consumed.
          this.breakUndockInvulnerabilityForPilotCommand(session);
        }
        return this.cancelStargateJumpCloakAfterCommand(
          session,
          result,
          "warp",
        );
      },
    );
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
    const entity = this.getShipEntityForSession(session);
    if (isShipWarpDisabledByRuntime(entity, this.getCurrentSimTimeMs())) {
      return {
        success: false,
        errorMsg: "SHIP_IMMOBILE",
      };
    }
    if (this.isShipWarpScrambled(entity)) {
      return {
        success: false,
        errorMsg: "WARP_SCRAMBLED",
      };
    }
    return dispatchIndependentWarpWithFleetAssociationRetirement(
      entity,
      () => {
        const result = dispatchWarpToPoint(this, session, point, {
          ...options, [WARP_TRANSMISSION_RECEIPT]: {},
        });
        lazyRequire("../services/dungeon/dungeonTrackingRuntime")
          .notifyAcceptedDungeonWarp(this, session, result);
        if (result && result.success === true) {
          this.breakUndockInvulnerabilityForPilotCommand(session);
        }
        return this.cancelStargateJumpCloakAfterCommand(
          session,
          result,
          "warp",
        );
      },
    );
  },

warpDynamicEntityToPoint(entityOrID, point, options = {}) {
    const entity =
      typeof entityOrID === "object" && entityOrID !== null
        ? entityOrID
        : this.getEntityByID(entityOrID);
    return dispatchIndependentWarpWithFleetAssociationRetirement(
      entity,
      () => {
        const result = dispatchWarpDynamicEntityToPoint(this, entityOrID, point, {
          ...options, [WARP_TRANSMISSION_RECEIPT]: {},
        });
        lazyRequire("../services/dungeon/dungeonTrackingRuntime")
          .notifyAcceptedDungeonWarp(this, options.session || (entity && entity.session), result);
        return result;
      },
    );
  },

forceStartPendingWarp(entityOrID, options = {}) {
    return dispatchForceStartPendingWarp(this, entityOrID, options);
  },

startSessionlessWarpIngress(entityOrID, point, options = {}) {
    return dispatchStartSessionlessWarpIngress(this, entityOrID, point, options);
  },

teleportDynamicEntityToPoint(entityOrID, point, options = {}) {
    const entity =
      typeof entityOrID === "object" && entityOrID !== null
        ? entityOrID
        : this.getEntityByID(entityOrID);
    const abyssalRestriction = resolveAbyssalTeleportRestriction(
      entity && entity.session,
      entity,
      this,
      options,
    );
    if (abyssalRestriction) {
      return {
        success: false,
        errorMsg: abyssalRestriction.errorMsg,
        data: abyssalRestriction,
      };
    }
    if (!entity || !this.dynamicEntities.has(entity.itemID)) {
      return {
        success: false,
        errorMsg: "DYNAMIC_ENTITY_NOT_FOUND",
      };
    }
    // Refused now rather than at the tick that would apply it: a queued
    // teleport answers success.
    if (
      !point ||
      !Number.isFinite(Number(point.x)) ||
      !Number.isFinite(Number(point.y)) ||
      !Number.isFinite(Number(point.z))
    ) {
      return {
        success: false,
        errorMsg: "INVALID_TELEPORT_POINT",
      };
    }
    // A position set is movement: it waits in the Movement queue. An abyssal
    // room transition moves the pilot between rooms, as a jump would, and
    // happens at once.
    if (
      options[ABYSSAL_TELEPORT_TRANSITION_BYPASS] !== true &&
      this.queueMovementChange(
        entity,
        "teleport",
        () => this.teleportDynamicEntityToPoint(entity, point, options),
      )
    ) {
      return {
        success: true,
        queued: true,
        data: {
          entity,
        },
      };
    }

    // Movement queue admission is unchanged. At actual application, commit
    // a durable native wreck's primary pose before changing or publishing its
    // Ball. The inventory persister intentionally excludes native wrecks.
    if (entity.nativeNpcWreck === true) {
      const relocated = { position: cloneVector(entity.position), direction: cloneVector(entity.direction) };
      applyTeleportRelocationMotionCommand(relocated, point,
        options.direction ? options : { ...options, direction: entity.direction || { x: 1, y: 0, z: 0 } },
        cloneVector, normalizeVector);
      const saved = require("../../npc/nativeNpcStore").setNativeWreckPosition(
        entity.itemID, relocated.position, { systemID: this.systemID, direction: relocated.direction });
      if (!saved.success) return saved;
    }

    const now = this.getCurrentSimTimeMs();
    const movementStamp = this.nextDestinyStamp;
    clearFleetWarpCommandAssociation(entity);
    if (entity.session?._safeLogoff) require("../../../services/ship/safeLogoffRuntime").abort(entity.session);
    // No direction given: the Ball keeps its heading.
    applyTeleportRelocationMotionCommand(
      entity,
      point,
      options.direction
        ? options
        : { ...options, direction: entity.direction || { x: 1, y: 0, z: 0 } },
      cloneVector,
      normalizeVector,
    );
    resetEntityMotionForHardRelocation(entity);
    const teleportPositionCommit = this.positionAuthority.commitEntity(entity, {
      atSimTimeMs: now,
      reason: "teleport-relocation",
    });
    if (!teleportPositionCommit.available) {
      return {
        success: false,
        errorMsg: "INVALID_DYNAMIC_ENTITY_POSITION",
        data: { reason: teleportPositionCommit.reason },
      };
    }
    // SetBallPosition and SetBallVelocity write both slots.
    setBallPosition(entity, entity.position);
    setBallVelocity(entity, entity.velocity);
    // A teleport is a move: the Ball is re-boxed, and a Grid bubble change
    // reaches Observers at the next bubble update.
    this.reboxBall(entity);
    persistDynamicEntity(entity);

    this.queueBubbleHistory(
      buildTeleportStopPresentationUpdates(entity, movementStamp),
    );

    return {
      success: true,
      data: {
        entity,
        stamp: movementStamp,
      },
    };
  },

setSpeedFraction(session, fraction) {
    const entity = this.getShipEntityForSession(session);
    if (
      !entity ||
      entity.mode === "WARP" ||
      entity.pendingDock ||
      isShipMovementLockedByRuntime(entity, this.getCurrentSimTimeMs())
    ) {
      return false;
    }
    this.cancelStargateJumpCloakBeforePilotCommand(session, "movement");
    const result = dispatchSetSpeedFraction(this, session, fraction);
    this.cancelStargateJumpCloakAfterCommand(session, result, "movement");
    if (result) {
      this.breakUndockInvulnerabilityForPilotCommand(session);
      this.retireInactiveFleetWarpCommandAssociation(entity);
      this.processSessionShipCloakProximityDecloak(session);
    }
    return result;
  },

stopShipEntity(entityOrID, options = {}) {
    return dispatchStopShipEntity(this, entityOrID, options);
  },

// The scramble gate on a warp: an incoming scramble or point, or a
// capital Micro Jump Field Generator's post-jump scramble. Asked when a warp
// is ordered, when the queued warp applies, and while a ship aligns.
isShipWarpScrambled(entity) {
    return Boolean(
      entity &&
      (
        hostileModuleRuntime.isEntityWarpScrambled(entity) ||
        require("../../../services/dynamic/essFieldRuntime").isEntityWarpBlocked(this, entity) ||
        hasPostMicroJumpWarpScramble(entity, this.getCurrentSimTimeMs())
      ),
    );
  },

// Stops `entity` at the next Destiny tick when it is aligning for warp under a
// scramble (destiny/commands/warpCommands.js stopWarpScrambledAlign).
stopWarpScrambledAlign(entity) {
    return dispatchStopWarpScrambledAlign(this, entity);
  },

// The align gate, at the top of every Destiny tick's doPreTick, before the
// queue applies (runtime/destinyTick.js): every ship still aligning for warp
// is stopped when it is scrambled or inside an active interdiction
// sphere. The Stops are queued here and apply with the rest of this
// tick's queue, before this tick's Evolve. Retail runs DoPreTick before every
// Evolve, each tick of a catch-up batch included (Ballpark.cpp L289-296 at
// v2.1.1), so every tick of a batch is gated, and a sphere raised at
// any time before the tick counts.
gateAligningWarps() {
    for (const entity of [...this.dynamicEntities.values()]) {
      if (
        isAligningForWarp(entity) &&
        this.dynamicEntities.get(entity.itemID) === entity &&
        !this.stopWarpScrambledAlign(entity)
      ) {
        this.stopWarpDisruptedAlign(entity);
      }
    }
  },

// Stops `entity` at the next Destiny tick when it is aligning for warp inside
// an active interdiction sphere (destiny/commands/warpCommands.js
// stopWarpDisruptedAlign).
stopWarpDisruptedAlign(entity) {
    return dispatchStopWarpDisruptedAlign(this, entity);
  },

stop(session) {
    const entity = this.getShipEntityForSession(session);
    if (
      !entity ||
      entity.pendingDock ||
      (entity.mode === "WARP" && Number(entity.effectStamp) >= 0)
    ) {
      return false;
    }
    this.cancelStargateJumpCloakBeforePilotCommand(session, "movement");
    const result = dispatchStop(this, session);
    this.cancelStargateJumpCloakAfterCommand(session, result, "movement");
    if (result) {
      this.breakUndockInvulnerabilityForPilotCommand(session);
      this.retireInactiveFleetWarpCommandAssociation(entity);
      this.processSessionShipCloakProximityDecloak(session);
    }
    return result;
  },

isDockingDisallowedByModules(session) {
    const entity = this.getShipEntityForSession(session);
    return hasActiveShipDockingDisallowedEffect(entity);
  },

acceptDocking(session, stationID) {
    const entity = this.getShipEntityForSession(session);
    const station = this.getEntityByID(stationID);
    const nowMs = this.getCurrentSimTimeMs();
    if (
      !entity ||
      !station ||
      (station.kind !== "station" && station.kind !== "structure") ||
      !canEntitiesInteractLocally(entity, station)
    ) {
      return {
        success: false,
        errorMsg: "STATION_NOT_FOUND",
      };
    }
    if (hasActiveShipDockingDisallowedEffect(entity)) {
      return {
        success: false,
        errorMsg: "DOCKING_DISALLOWED_BY_MODULE",
      };
    }
    if (isShipMovementLockedByRuntime(entity, nowMs)) {
      return {
        success: false,
        errorMsg: "SHIP_IMMOBILE",
      };
    }
    const crimewatchDockingRestriction =
      resolveSessionCrimewatchDockingRestriction(session, nowMs);
    if (crimewatchDockingRestriction) {
      return {
        success: false,
        errorMsg: crimewatchDockingRestriction,
      };
    }

    if (
      entity.pendingDock &&
      Number(entity.pendingDock.stationID || 0) === station.itemID
    ) {
      return {
        success: true,
        data: {
          acceptedAtFileTime: entity.pendingDock.acceptedAtFileTime,
          pending: true,
        },
      };
    }

    if (!canShipDockAtStation(entity, station)) {
      return {
        success: false,
        errorMsg: "DOCKING_APPROACH_REQUIRED",
      };
    }
    if (station.kind === "structure") {
      const structureTetherRestrictionState = lazyRequire("../services/structure/structureTetherRestrictionState");
      const restriction = structureTetherRestrictionState.getCharacterStructureDockingRestriction(
        session && session.characterID,
        nowMs,
        {
          session,
        },
      );
      if (restriction.restricted) {
        return {
          success: false,
          errorMsg: restriction.reason || "STRUCTURE_DOCKING_RESTRICTED",
        };
      }
    }

    // The dock acceptance stops the ship through the Movement queue, as any
    // Stop: it applies at the next Destiny tick, and Evolve brings the ship
    // to rest. The dock itself is a gameplay timer (the Gameplay tick
    // completes it).
    const applyDockingStop = () => {
      resetEntityMotion(entity);
      demoteEntityMassiveState(entity);
      const stamp = this.nextDestinyStamp;
      const acceptanceUpdates = station.kind === "structure"
        ? buildStructureDockingTransitionUpdates(entity, station, stamp)
        : buildOrdinaryDockingStopPresentationUpdates(entity, stamp);
      this.queueBubbleHistory(acceptanceUpdates);
    };
    if (!this.queueMovementChange(entity, "dockingStop", applyDockingStop)) {
      applyDockingStop();
    }
    applyPendingDockStateCommand(entity, {
      stationID: station.itemID,
      acceptedAtMs: nowMs,
      completeAtMs: nowMs + STATION_DOCK_ACCEPT_DELAY_MS,
      acceptedAtFileTime: this.getCurrentFileTime(),
    });
    persistShipEntity(entity);
    logMovementDebug("dock.accepted", entity, {
      stationID: station.itemID,
      dockingState: buildDockingDebugState(entity, station),
    });

    if (session && typeof session.sendNotification === "function") {
      const dockingAcceptedPayload = buildDockingAcceptedNotificationPayload(
        entity.position,
        station.position,
        station.itemID,
      );
      session.sendNotification(
        "OnDockingAccepted",
        "charid",
        dockingAcceptedPayload,
      );
    }

    return {
      success: true,
      data: {
        acceptedAtFileTime: entity.pendingDock.acceptedAtFileTime,
      },
    };
  },

// A dock asked for from out of docking range of a station.
  //
  // Tranquility answers that CmdDock with the user error DockingApproach, sends
  // the ship one GotoPoint at the station's own position, and accepts the dock
  // itself when the ship has flown in. Counted in the retail client's logs:
  // nine docks so answered, each followed by that GotoPoint (four different
  // stations, the point the station's position every time), all nine accepted
  // 1.2 to 9.0 seconds on, seven of them with no second CmdDock from the client.
  //
  // So the approach is a flight at the station's centre and not a follow that
  // holds off at docking range. A follow to the edge of the range comes to rest
  // on the edge: within one tick's flight of its point, Carbon's homing law
  // scales a ball's thrust by the fourth power of the distance left. A capsule
  // so flown was measured 20 m outside the range, closing at 0.03 m/s, 200
  // seconds after it was ordered.
  startStationDockingApproach(session, stationID) {
    const entity = this.getShipEntityForSession(session);
    const station = this.getEntityByID(stationID);
    if (!entity || !station || station.kind !== "station") {
      return false;
    }
    // The docking target rides the GotoPoint: its queued
    // apply clears the ship's tracking state and then names the station, so
    // the target survives the apply. Any later order that clears tracking
    // state (a heading, an approach, an orbit, a stop, a warp, another
    // GotoPoint) clears it again, and that is what cancels the approach.
    if (!this.gotoPoint(session, station.position, {
      dockingTargetID: station.itemID,
    })) {
      return false;
    }
    if (!(this._stationDockingApproaches instanceof Map)) {
      this._stationDockingApproaches = new Map();
    }
    this._stationDockingApproaches.set(entity, {
      session,
      stationID: station.itemID,
    });
    logMovementDebug("dock.approach", entity, {
      stationID: station.itemID,
      dockingState: buildDockingDebugState(entity, station),
    });
    return true;
  },

// The docking approaches whose ship has flown into docking range since the
  // last look, taken off the scene's list: an approach has one arrival, whether
  // or not the dock is then accepted. Ranges are read on positions as of the
  // last Evolve.
  //
  // An approach stands only while the pilot who asked still flies the ship, no
  // dock is pending, the station is still there, and the ship still names the
  // station as its docking target. That target is set by the GotoPoint's
  // queued apply, so while a movement change still waits for the ship the
  // approach stands without it and is not looked at for arrival. A movement
  // order applied later clears the target, so a cancelled approach is dropped
  // here and can never dock the ship later. Dropping an approach writes
  // nothing to the ship: its movement changes only through the Movement queue.
  takeArrivedStationDockingApproaches() {
    const approaches = this._stationDockingApproaches;
    if (!(approaches instanceof Map) || approaches.size === 0) {
      return [];
    }
    const arrived = [];
    for (const [entity, approach] of approaches) {
      const station = this.getEntityByID(approach.stationID);
      const queued = this.hasQueuedMovementChange(entity);
      const namesStation =
        Number(entity.dockingTargetID || 0) === Number(approach.stationID);
      const stands =
        Boolean(station) &&
        (queued || namesStation) &&
        !entity.pendingDock &&
        entity.session === approach.session &&
        this.getShipEntityForSession(approach.session) === entity;
      if (!stands) {
        approaches.delete(entity);
        continue;
      }
      if (queued || !canShipDockAtStation(entity, station)) {
        continue;
      }
      approaches.delete(entity);
      arrived.push({
        session: approach.session,
        stationID: approach.stationID,
      });
    }
    return arrived;
  },

// Backstop for sessions whose initial destiny bootstrap never completed.
  // While `session._space.initialStateSent` is false every destiny send path
  // early-returns, so the scene keeps simulating the ship while telling the
  // client nothing: no error, no warning, and the player just sees a frozen
  // ship. The known paths force their own bootstrap, but a path that queues no
  // bind wait at all leaves the session silently stranded until the player
  // touches the controls, so sweep for it here.
  sweepStrandedDestinySessions(wallclockNowMs) {
    const sweepNowMs = toFiniteNumber(wallclockNowMs, 0);
    if (
      Number.isFinite(this._lastStrandedSessionSweepAtMs) &&
      sweepNowMs - this._lastStrandedSessionSweepAtMs <
        STRANDED_DESTINY_SESSION_SWEEP_INTERVAL_MS
    ) {
      return;
    }
    this._lastStrandedSessionSweepAtMs = sweepNowMs;

    for (const session of this.sessions.values()) {
      const space = session && session._space;
      if (!space) {
        continue;
      }
      if (space.initialStateSent === true) {
        space.strandedDestinyFirstSeenAtMs = null;
        continue;
      }
      if (space.initialBallparkBootstrapInProgress === true) {
        continue;
      }
      if (!session.socket || session.socket.destroyed) {
        continue;
      }
      if (!Number.isFinite(space.strandedDestinyFirstSeenAtMs)) {
        space.strandedDestinyFirstSeenAtMs = sweepNowMs;
        continue;
      }
      const strandedForMs = sweepNowMs - space.strandedDestinyFirstSeenAtMs;
      if (strandedForMs < STRANDED_DESTINY_SESSION_RECOVERY_MS) {
        continue;
      }

      if (space.strandedDestinyRecoveryLogged !== true) {
        space.strandedDestinyRecoveryLogged = true;
        log.warn(
          `[SpaceBootstrap] Session has been unable to receive destiny updates for ` +
            `${Math.round(strandedForMs / 1000)}s and is being recovered: ` +
            `clientID=${session.clientID} char=${toInt(session.characterID, 0)} ` +
            `ship=${toInt(space.shipID, 0)} systemID=${toInt(this.systemID, 0)} ` +
            `beyonceBound=${space.beyonceBound === true}`,
        );
      }
      this.ensureInitialBallpark(session, {
        allowDeferredJumpBootstrapVisuals: false,
        force: true,
      });
    }
  },
};
