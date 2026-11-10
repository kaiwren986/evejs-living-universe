"use strict";

const runtimeEntryDirname = require("path").resolve(__dirname, "../..");
const path = require("path");
const {
  seedBallSlots,
} = require(path.join(runtimeEntryDirname, "./destiny/simulation/evolve.js"));
const {
  canEntitiesInteractLocally,
  isSharedPveTarget,
  resolveEntityInteractionScope,
} = require(path.join(runtimeEntryDirname, "./destiny/identity/interactionScope.js"));
const {
  buildSuperweaponFreshAcquireFxOptions,
  prepareSuperweaponActivation,
  executeSuperweaponActivation,
  finalizeSuperweaponDeactivation,
  isSuperweaponFxReplayWindowActive,
  tickScene: tickSuperweaponScene,
  isSuperweaponMovementLocked,
  isSuperweaponJumpOrCloakLocked,
  entityHasCloakDisallowingFittedModule,
} = require(path.join(runtimeEntryDirname, "./modules/superweapons/superweaponRuntime"));
const {
  isEntityDisruptiveLanceDebuffed,
} = require(path.join(runtimeEntryDirname, "./modules/superweapons/disruptiveLanceDebuff"));
const {
  queueOrApplyMovementChange,
} = require(path.join(runtimeEntryDirname, "./destiny/commands/movementQueueing.js"));
const {
  resetEntityMotion,
} = require("../destinyMovementEngine");
const {
  persistShipEntity,
} = require("../entitySpacePersistence");
const {
  recordSessionJumpTimingTrace,
} = require("../runtimeDebugInstrumentation");
const {
  isShipMovementLockedByRuntime,
} = require("../shipActionRestrictions");
const {
  STARGATE_ACTIVATION_STATE,
  buildObserverStargateJumpFxOptions,
  coerceActivationState,
} = require("../staticSceneEntity");
const {
  magnitude,
} = require("../../../common/vector");
const { TYPE_ANSIBLEX_JUMP_BRIDGE } = require("../../../services/sovereignty/sovUpgradeSupport");

function isStructureJumpGate(entity, options) {
  return options.allowStructureGate === true && entity && entity.kind === "structure" &&
    Number(entity.typeID) === TYPE_ANSIBLEX_JUMP_BRIDGE;
}

module.exports = {

startStargateJump(session, sourceGateID, options = {}) {
    if (!session || !session._space) {
      return {
        success: false,
        errorMsg: "NOT_IN_SPACE",
      };
    }

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
    // A ship held by a link-with-ship restriction can neither jump nor dock.
    if (require("../../../services/spaceComponents/shipLinkRestrictions")
      .blocksShipAction(shipEntity, "blocksJumpOrDock")) {
      return {
        success: false,
        errorMsg: "LINK_WITH_SHIP_JUMP_DISABLED",
      };
    }
    if (isShipMovementLockedByRuntime(shipEntity, scene.getCurrentSimTimeMs())) {
      return {
        success: false,
        errorMsg: "SHIP_IMMOBILE",
      };
    }
    if (isSuperweaponJumpOrCloakLocked(shipEntity, scene.getCurrentSimTimeMs())) {
      return {
        success: false,
        errorMsg: "JUMP_COOLDOWN_ACTIVE",
      };
    }
    // Stargate use is on the Disruptive Lance debuff's list alongside warp and
    // jump drives, so a ship caught in the beam cannot gate out either.
    if (isEntityDisruptiveLanceDebuffed(shipEntity, scene.getCurrentSimTimeMs())) {
      return {
        success: false,
        errorMsg: "DISRUPTION_LANCE_DEBUFF_ACTIVE",
      };
    }

    const sourceGateEntity = scene.getEntityByID(sourceGateID);
    if (
      !sourceGateEntity ||
      (sourceGateEntity.kind !== "stargate" && !isStructureJumpGate(sourceGateEntity, options)) ||
      !canEntitiesInteractLocally(shipEntity, sourceGateEntity)
    ) {
      return {
        success: false,
        errorMsg: "STARGATE_NOT_FOUND",
      };
    }

    const currentActivationState = isStructureJumpGate(sourceGateEntity, options)
      ? (sourceGateEntity.destinationID && sourceGateEntity.targetSolarsystemID
        ? STARGATE_ACTIVATION_STATE.OPEN : null)
      : coerceActivationState(
      sourceGateEntity.activationState,
      this.resolveStargateActivationState(sourceGateEntity),
    );
    if (currentActivationState !== STARGATE_ACTIVATION_STATE.OPEN) {
      return {
        success: false,
        errorMsg: "STARGATE_NOT_ACTIVE",
      };
    }

    if (
      options.freezeMotion !== false &&
      (
        shipEntity.mode !== "STOP" ||
        magnitude(shipEntity.velocity) > 0.5
      )
    ) {
      // The ship's stop is a movement change like any other: it applies at
      // the next doPreTick, after every order queued before the jump, at the
      // stamp its Stop goes out with the JumpOut.
      queueOrApplyMovementChange(
        scene,
        shipEntity,
        "stargateJumpStop",
        scene.getCurrentSimTimeMs(),
        () => {
          resetEntityMotion(shipEntity);
          seedBallSlots(shipEntity);
          persistShipEntity(shipEntity);
        },
      );
    }

    const fxOptions = {
      ...(options.fxOptions || {}),
    };
    const graphicInfo = {
      type: "tuple",
      items: [
        Number(sourceGateEntity.destinationSolarSystemID),
        null,
      ],
    };

    const { stamp, deliveredCount, resultSessionDelivered } = scene.broadcastSpecialFx(
      shipEntity.itemID,
      "effects.JumpOut",
      {
        ...fxOptions,
        targetID: sourceGateEntity.itemID,
        graphicInfo,
        start: true,
        active: false,
        // Retail authors the gate departure as one ordinary next-history
        // action batch: JumpOut starts the tunnel and Stop retires the source
        // ball's motion at the same stamp.
        includeStopInSameUpdate: true,
        resultSession: session,
      },
      shipEntity,
    );

    recordSessionJumpTimingTrace(session, "stargate-jump-source-observer-fx", {
      sourceGateID: sourceGateEntity.itemID,
      shipID: shipEntity.itemID,
      jumpOutStamp: stamp,
      jumpOutDeliveredCount: deliveredCount,
      jumpOutResultSessionDelivered: resultSessionDelivered,
    });

    return {
      success: true,
      data: {
        shipID: shipEntity.itemID,
        sourceGateID: sourceGateEntity.itemID,
        stamp,
        deliveredCount,
        resultSessionDelivered,
      },
    };
  },

emitStargateArrivalObserverFx(session, destinationGateID, shipID, options = {}) {
    if (!session || !session._space) {
      return {
        success: false,
        errorMsg: "INVALID_SESSION",
      };
    }

    const scene = this.getSceneForSession(session);
    if (!scene) {
      return {
        success: false,
        errorMsg: "SCENE_NOT_FOUND",
      };
    }

    const destinationGateEntity = scene.getEntityByID(destinationGateID);
    const shipEntity = scene.getEntityByID(shipID);
    if (!destinationGateEntity || (destinationGateEntity.kind !== "stargate" &&
      !isStructureJumpGate(destinationGateEntity, options))) {
      return {
        success: false,
        errorMsg: "STARGATE_NOT_FOUND",
      };
    }
    if (!shipEntity) {
      return {
        success: false,
        errorMsg: "SHIP_NOT_FOUND",
      };
    }

    const jumpIn = scene.broadcastSpecialFx(
      shipEntity.itemID,
      "effects.JumpIn",
      buildObserverStargateJumpFxOptions({
        excludedSession: session,
        duration: 5000,
        ...options.jumpInOptions,
      }),
      shipEntity,
    );

    recordSessionJumpTimingTrace(session, "stargate-jump-destination-observer-fx", {
      destinationGateID: destinationGateEntity.itemID,
      shipID: shipEntity.itemID,
      jumpInStamp: jumpIn.stamp,
      jumpInDeliveredCount: jumpIn.deliveredCount,
    });

    return {
      success: true,
      data: {
        jumpInStamp: jumpIn.stamp,
        jumpInDeliveredCount: jumpIn.deliveredCount,
      },
    };
  },
};
