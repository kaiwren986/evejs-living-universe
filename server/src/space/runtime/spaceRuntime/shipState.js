"use strict";

const runtimeEntryDirname = require("path").resolve(__dirname, "../..");
const path = require("path");
const {
  collectNumericModuleAttributeDiffs,
  resolveModuleSnapshotDirectModifierEntries,
} = require(path.join(
  runtimeEntryDirname,
  "./modules/moduleAttributeDiff",
));
const {
  captureFittedGenericModuleAttributeSnapshots,
} = require("../attributeChangeNotification");
const {
  getEntityRuntimeActiveModuleContexts,
} = require("../entityDogmaView");
const {
  getGenericModuleRuntimeAttributes,
} = require("../moduleAttributes");
const {
  roundNumber,
  toFiniteNumber,
  toInt,
} = require("../../../common/numbers");
const {
  getPropulsionModuleRuntimeAttributes,
} = require("../propulsionModule");

module.exports = {

refreshShipDerivedState(session, options = {}) {
    const scene = this.getSceneForSession(session);
    return scene
      ? scene.refreshSessionShipDerivedState(session, options)
      : {
          success: false,
          errorMsg: "SCENE_NOT_FOUND",
        };
  },

captureFittedGenericModuleAttributeState(session, options = {}) {
    const scene = this.getSceneForSession(session);
    const activeEntity = scene ? scene.getShipEntityForSession(session) : null;
    const requestedShipID = toInt(
      options.shipID,
      toInt(activeEntity && activeEntity.itemID, 0),
    );
    if (
      !activeEntity ||
      requestedShipID <= 0 ||
      toInt(activeEntity.itemID, 0) !== requestedShipID
    ) {
      return null;
    }
    return captureFittedGenericModuleAttributeSnapshots(activeEntity, {
      ...options,
      session,
    });
  },

diffFittedGenericModuleAttributeState(session, beforeSnapshots, options = {}) {
    if (!(beforeSnapshots instanceof Map)) {
      return [];
    }
    const afterSnapshots = this.captureFittedGenericModuleAttributeState(
      session,
      options,
    );
    return afterSnapshots instanceof Map
      ? collectNumericModuleAttributeDiffs(beforeSnapshots, afterSnapshots)
      : [];
  },

getShipCapacitorState(session) {
    const scene = this.getSceneForSession(session);
    return scene ? scene.getShipCapacitorState(session) : null;
  },

setShipCapacitorRatio(session, nextRatio) {
    const scene = this.getSceneForSession(session);
    return scene
      ? scene.setShipCapacitorRatio(session, nextRatio)
      : {
          success: false,
          errorMsg: "SCENE_NOT_FOUND",
        };
  },

getActiveModuleEffect(session, moduleID) {
    const scene = this.getSceneForSession(session);
    const shipEntity = scene ? scene.getShipEntityForSession(session) : null;
    if (!scene || !shipEntity) {
      return null;
    }

    return scene.getActiveModuleEffect(shipEntity.itemID, moduleID);
  },

getOverloadModuleEffect(session, moduleID) {
    const scene = this.getSceneForSession(session);
    const shipEntity = scene ? scene.getShipEntityForSession(session) : null;
    if (!scene || !shipEntity) {
      return null;
    }

    return scene.getOverloadModuleEffect(shipEntity.itemID, moduleID);
  },

overloadModule(session, moduleItem, effectID, options = {}) {
    const scene = this.getSceneForSession(session);
    return scene
      ? scene.overloadModule(session, moduleItem, effectID, options)
      : {
          success: false,
          errorMsg: "NOT_IN_SPACE",
        };
  },

stopOverloadModule(session, moduleItem, effectID, options = {}) {
    const scene = this.getSceneForSession(session);
    return scene
      ? scene.stopOverloadModule(session, moduleItem, effectID, options)
      : {
          success: false,
          errorMsg: "NOT_IN_SPACE",
        };
  },

overloadRack(session, anchorModuleItem) {
    const scene = this.getSceneForSession(session);
    return scene
      ? scene.overloadRack(session, anchorModuleItem)
      : {
          success: false,
          errorMsg: "NOT_IN_SPACE",
        };
  },

stopOverloadRack(session, anchorModuleItem) {
    const scene = this.getSceneForSession(session);
    return scene
      ? scene.stopOverloadRack(session, anchorModuleItem)
      : {
          success: false,
          errorMsg: "NOT_IN_SPACE",
        };
  },

reconcileActiveTurretWeaponBankEffects(session, shipID, moduleIDs = []) {
    const scene = this.getSceneForSession(session);
    if (!scene) {
      return {
        changed: false,
        activeModuleIDs: [],
      };
    }
    return scene.reconcileActiveTurretWeaponBankEffects(shipID, moduleIDs);
  },

getPropulsionModuleRuntimeAttributes(characterID, moduleItem, options = {}) {
    return getPropulsionModuleRuntimeAttributes(characterID, moduleItem, options);
  },

getActiveModuleContextsForEntity(entity, options = {}) {
    return getEntityRuntimeActiveModuleContexts(entity, options);
  },

getActiveModuleContextsForSession(session, options = {}) {
  const runtimeExports = require("../../runtime");
    const scene =
      runtimeExports &&
      typeof runtimeExports.getSceneForSession === "function"
        ? runtimeExports.getSceneForSession(session)
        : null;
    const entity =
      scene && typeof scene.getShipEntityForSession === "function"
        ? scene.getShipEntityForSession(session)
        : null;
    return getEntityRuntimeActiveModuleContexts(entity, options);
  },

getGenericModuleRuntimeAttributes(
    characterID,
    shipItem,
    moduleItem,
    chargeItem = null,
    weaponSnapshot = null,
    options = {},
  ) {
    return getGenericModuleRuntimeAttributes(
      characterID,
      shipItem,
      moduleItem,
      chargeItem,
      weaponSnapshot,
      options,
    );
  },

getShipAttributeSnapshot(session) {
    const scene = this.getSceneForSession(session);
    const entity = scene ? scene.getShipEntityForSession(session) : null;
    if (!entity) {
      return null;
    }

    return {
      itemID: toInt(entity.itemID, 0),
      mass: roundNumber(toFiniteNumber(entity.mass, 0), 6),
      maxVelocity: roundNumber(toFiniteNumber(entity.maxVelocity, 0), 6),
      maxLockedTargets: roundNumber(toFiniteNumber(entity.maxLockedTargets, 0), 6),
      maxTargetRange: roundNumber(toFiniteNumber(entity.maxTargetRange, 0), 6),
      cloakingTargetingDelay: roundNumber(
        toFiniteNumber(entity.cloakingTargetingDelay, 0),
        6,
      ),
      cloakStabilizationStrength: roundNumber(
        toFiniteNumber(entity.cloakStabilizationStrength, 0),
        6,
      ),
      scanResolution: roundNumber(toFiniteNumber(entity.scanResolution, 0), 6),
      signatureRadius: roundNumber(
        toFiniteNumber(entity.signatureRadius, 0),
        6,
      ),
      alignTime: roundNumber(toFiniteNumber(entity.alignTime, 0), 6),
      attributes: Object.fromEntries(
        Object.entries(
          (entity.passiveDerivedState &&
            entity.passiveDerivedState.attributes &&
            typeof entity.passiveDerivedState.attributes === "object")
            ? entity.passiveDerivedState.attributes
            : {},
        )
          .map(([attributeID, value]) => [Number(attributeID), Number(value)])
          .filter(
            ([attributeID, value]) =>
              Number.isInteger(attributeID) && Number.isFinite(value),
          ),
      ),
    };
  },
};
