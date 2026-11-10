"use strict";

module.exports = {
  buildStructureObserverSpaceState,
  captureUncontrolledStaticStructureDogmaState,
  clearControlledStaticStructureDogmaHostIdentity,
  getControlledStaticStructureDogmaHosts,
  hydrateControlledStaticStructureDogmaHost,
  isControlledStaticStructureHostForSession,
  prepareControlledStaticStructureDogmaHost,
  refreshControlledStaticStructureBaseline,
  restoreObjectShallowSnapshot,
};

const runtimeEntryDirname = require("path").resolve(__dirname, "..");
const path = require("path");
const {
  CAPSULE_TYPE_ID,
  CAPSULE_TYPE_ID_GOLDEN,
  ITEM_FLAGS,
  updateShipItem,
  updateInventoryItem,
  removeInventoryItem,
  getShipConditionState,
  normalizeShipConditionState,
  getItemMetadata,
  pruneExpiredSpaceItems,
} = require(path.join(runtimeEntryDirname, "../services/inventory/itemStore"));
const {
  getFittedModuleItems,
  listFittedItemsForLocation,
  buildSlimModuleTuples,
  buildCharacterTargetingState,
  buildChargeTupleItemID,
  buildShipResourceState,
  SLOT_FAMILY_FLAGS,
  getAttributeIDByNames,
  getEffectIDByNames,
  getTypeDogmaAttributes,
  getTypeDogmaEffects,
  getTypeEffectRecords,
  getPassiveModifierEffectRecords,
  getTypeAttributeValue,
  getEffectTypeRecord,
  getRequiredSkillRequirements,
  getLoadedChargeByFlag,
  isChargeCompatibleWithModule,
  isModuleOnline,
  isStructureDogmaHost,
  resolveDogmaSkillMapForHost,
  appendDirectModifierEntries,
  buildEffectiveItemAttributeMap,
  indexOverloadEffectRecordsByModuleID,
  buildProjectedModuleSourceAttributeMap,
} = require(path.join(runtimeEntryDirname, "../services/fitting/liveFittingState"));
const {
  currentFileTime,
  buildFiletimeLong,
  buildMarshalReal,
} = require(path.join(runtimeEntryDirname, "../services/_shared/serviceHelpers"));
const wormholeEnvironmentRuntime = require(path.join(
  runtimeEntryDirname,
  "../services/exploration/wormholes/wormholeEnvironmentRuntime",
));
const {
  getEntityCapacitorRatio,
} = require("./entityCapacitor");
const {
  buildRuntimeShipItemFromEntity,
  getEntityRuntimeFittedItems,
} = require("./entityDogmaView");
const {
  toFiniteNumber,
  toInt,
} = require("../../common/numbers");
const {
  applyPassiveResourceStateToEntity,
  buildPassiveShipResourceState,
} = require("./passiveDerivedState");
const {
  getSceneKeyForSession,
  normalizeSceneText,
} = require("./sceneIdentity");
const {
  ensureEntityTargetingState,
} = require("./targeting");
function buildStructureObserverSpaceState(
  scene,
  structureID,
  previousState = null,
) {
  const baseState =
    previousState && typeof previousState === "object"
      ? previousState
      : {};
  return {
    systemID: Number(scene && scene.systemID) || 0,
    // ensureInitialBallpark() compares session._space.sceneKey against the
    // scene's own key directly (not via getSceneKeyForSession's fallback), so an
    // observer state without a scene key is rejected as belonging to a foreign
    // scene and the structure ball park is never delivered.
    sceneKey: (scene && scene.sceneKey) || "",
    sceneKind: scene && scene.sceneKind,
    instanceID: scene && scene.instanceID,
    shipID: Number(structureID) || 0,
    observerKind: "structure",
    beyonceBound: true,
    initialStateSent: baseState.initialStateSent === true,
    initialBallparkVisualsSent: baseState.initialBallparkVisualsSent === true,
    initialBallparkClockSynced: baseState.initialBallparkClockSynced === true,
    initialBallparkBootstrapInProgress: false,
    pendingBallparkBind: baseState.pendingBallparkBind === true,
    deferInitialBallparkClockUntilBind: false,
    deferInitialBallparkStateUntilBind: false,
    pendingUndockMovement: false,
    clockOffsetMs: toFiniteNumber(baseState.clockOffsetMs, 0),
    timeDilation:
      scene && typeof scene.getTimeDilation === "function"
        ? scene.getTimeDilation()
        : 1,
    simTimeMs:
      scene && typeof scene.getCurrentSimTimeMs === "function"
        ? scene.getCurrentSimTimeMs()
        : Date.now(),
    simFileTime:
      scene && typeof scene.getCurrentFileTime === "function"
        ? scene.getCurrentFileTime()
        : currentFileTime(),
  };
}

function prepareControlledStaticStructureDogmaHost(scene, session, entity) {
  if (
    !scene ||
    !session ||
    !entity ||
    entity.kind !== "structure" ||
    !(scene.staticEntitiesByID instanceof Map) ||
    scene.staticEntitiesByID.get(toInt(entity.itemID, 0)) !== entity
  ) {
    return null;
  }

  const characterID = toInt(session.characterID || session.charid, 0);
  const shipItem = buildRuntimeShipItemFromEntity(entity);
  const fittedItems = getEntityRuntimeFittedItems(entity);
  const skillMap = resolveDogmaSkillMapForHost(characterID, shipItem, {});
  const passiveResourceState = buildPassiveShipResourceState(
    characterID,
    shipItem,
    {
      fittedItems,
      skillMap,
      additionalAttributeModifierEntries:
        wormholeEnvironmentRuntime.collectShipAttributeModifierEntriesForSystem(
          scene.systemID,
        ),
    },
  );

  return {
    scene,
    session,
    entity,
    structureID: toInt(entity.itemID, 0),
    characterID,
    fittedItems,
    skillMap,
    passiveResourceState,
  };
}

function restoreObjectShallowSnapshot(target, snapshot) {
  if (!target || !snapshot) {
    return;
  }
  for (const key of Object.keys(target)) {
    if (!Object.prototype.hasOwnProperty.call(snapshot, key)) {
      delete target[key];
    }
  }
  Object.assign(target, snapshot);
}

const CONTROLLED_STRUCTURE_DOGMA_BASELINE_FIELDS = Object.freeze([
  "passiveDerivedState",
  "mass",
  "inertia",
  "maxVelocity",
  "alignTime",
  "agilitySeconds",
  "warpSpeedAU",
  "maxTargetRange",
  "maxLockedTargets",
  "signatureRadius",
  "cloakingTargetingDelay",
  "cloakStabilizationUntilMs",
  "cloakStabilizationStrength",
  "scanResolution",
  "capacitorCapacity",
  "capacitorRechargeRate",
  "shieldCapacity",
  "shieldRechargeRate",
  "armorHP",
  "structureHP",
]);

function captureUncontrolledStaticStructureDogmaState(entity) {
  return {
    hadFittedItems: Object.prototype.hasOwnProperty.call(entity, "fittedItems"),
    fittedItems: entity.fittedItems,
    hadSkillMap: Object.prototype.hasOwnProperty.call(entity, "skillMap"),
    skillMap: entity.skillMap,
    fields: Object.fromEntries(CONTROLLED_STRUCTURE_DOGMA_BASELINE_FIELDS.map(
      (key) => [
        key,
        {
          present: Object.prototype.hasOwnProperty.call(entity, key),
          value: entity[key],
        },
      ],
    )),
  };
}

function refreshControlledStaticStructureBaseline(entity, canonicalEntity) {
  const previousIdentity = entity && entity._controlledStructureRuntimeIdentity;
  if (!previousIdentity || !canonicalEntity) {
    return;
  }
  entity._controlledStructureRuntimeIdentity = {
    ...previousIdentity,
    corporationID: canonicalEntity.corporationID,
    allianceID: canonicalEntity.allianceID,
    uncontrolledDogmaState:
      captureUncontrolledStaticStructureDogmaState(canonicalEntity),
  };
}

function hydrateControlledStaticStructureDogmaHost(
  scene,
  session,
  entity,
  options = {},
) {
  const preparation =
    options.preparation &&
    options.preparation.scene === scene &&
    options.preparation.session === session &&
    options.preparation.entity === entity &&
    toInt(options.preparation.structureID, 0) === toInt(entity && entity.itemID, 0)
      ? options.preparation
      : prepareControlledStaticStructureDogmaHost(scene, session, entity);
  if (!preparation) {
    return null;
  }

  const previousEntityState = { ...entity };
  const previousCapacitorRatio = getEntityCapacitorRatio(entity);
  const {
    characterID,
    fittedItems,
    skillMap,
    passiveResourceState,
  } = preparation;

  try {
    if (!entity._controlledStructureRuntimeIdentity) {
      entity._controlledStructureRuntimeIdentity = {
        corporationID: entity.corporationID,
        allianceID: entity.allianceID,
        characterID: entity.characterID,
        pilotCharacterID: entity.pilotCharacterID,
        session: entity.session || null,
        uncontrolledDogmaState:
          captureUncontrolledStaticStructureDogmaState(entity),
      };
    }
    entity.session = session;
    entity.characterID = characterID;
    entity.pilotCharacterID = characterID;
    entity.fittedItems = fittedItems.map((item) => ({ ...item }));
    entity.skillMap = skillMap;
    if (passiveResourceState) {
      applyPassiveResourceStateToEntity(entity, passiveResourceState, {
        recalculateSpeedFraction: false,
      });
    }
    entity.capacitorChargeRatio = previousCapacitorRatio;
    entity.conditionState = normalizeShipConditionState({
      ...(entity.conditionState || {}),
      charge: previousCapacitorRatio,
    });
    ensureEntityTargetingState(entity);
    if (!(entity.activeModuleEffects instanceof Map)) {
      entity.activeModuleEffects = new Map();
    }
    if (!(entity.moduleReactivationLocks instanceof Map)) {
      entity.moduleReactivationLocks = new Map();
    }
    return entity;
  } catch (error) {
    restoreObjectShallowSnapshot(entity, previousEntityState);
    throw error;
  }
}

function clearControlledStaticStructureDogmaHostIdentity(session, entity) {
  if (!entity || entity.kind !== "structure") {
    return;
  }
  if (entity.session === session) {
    const previousIdentity = entity._controlledStructureRuntimeIdentity || {};
    const previousDogmaState = previousIdentity.uncontrolledDogmaState || {};
    const controlledConditionState = normalizeShipConditionState(
      entity.conditionState,
    );
    const controlledArmorHP = Math.max(0, toFiniteNumber(entity.armorHP, 0));
    const absoluteArmorDamage = controlledArmorHP > 0
      ? controlledArmorHP * Math.max(
          0,
          toFiniteNumber(controlledConditionState.armorDamage, 0),
        )
      : null;
    const liveCapacitorRatio = getEntityCapacitorRatio(entity);
    for (const [key, snapshot] of Object.entries(previousDogmaState.fields || {})) {
      if (snapshot && snapshot.present) {
        entity[key] = snapshot.value;
      } else {
        delete entity[key];
      }
    }
    if (previousDogmaState.hadFittedItems) {
      entity.fittedItems = previousDogmaState.fittedItems;
    } else {
      delete entity.fittedItems;
    }
    if (previousDogmaState.hadSkillMap) {
      entity.skillMap = previousDogmaState.skillMap;
    } else {
      delete entity.skillMap;
    }
    const canonicalArmorHP = Math.max(0, toFiniteNumber(entity.armorHP, 0));
    entity.capacitorChargeRatio = liveCapacitorRatio;
    entity.conditionState = normalizeShipConditionState({
      ...controlledConditionState,
      armorDamage:
        absoluteArmorDamage !== null && canonicalArmorHP > 0
          ? absoluteArmorDamage / canonicalArmorHP
          : controlledConditionState.armorDamage,
      charge: liveCapacitorRatio,
    });
    entity.session = previousIdentity.session || null;
    entity.characterID = previousIdentity.characterID;
    entity.pilotCharacterID = previousIdentity.pilotCharacterID;
    entity.corporationID = previousIdentity.corporationID;
    entity.allianceID = previousIdentity.allianceID;
    delete entity._controlledStructureRuntimeIdentity;
  }
}

function isControlledStaticStructureHostForSession(scene, session, entity) {
  if (
    !scene ||
    !session ||
    !session._space ||
    !entity ||
    entity.kind !== "structure" ||
    !(scene.staticEntitiesByID instanceof Map)
  ) {
    return false;
  }

  const structureID = toInt(entity.itemID, 0);
  return Boolean(
    structureID > 0 &&
      scene.staticEntitiesByID.get(structureID) === entity &&
      normalizeSceneText(session._space.observerKind, "") === "structure" &&
      getSceneKeyForSession(session) === normalizeSceneText(scene.sceneKey, "") &&
      toInt(session._space.shipID, 0) === structureID &&
      toInt(session.shipID || session.shipid, 0) === structureID &&
      toInt(session.structureID || session.structureid, 0) === structureID
  );
}

function getControlledStaticStructureDogmaHosts(scene) {
  if (!scene || !(scene.sessions instanceof Map)) {
    return [];
  }

  const hosts = new Set();
  for (const session of scene.sessions.values()) {
    const structureID = toInt(session && session._space && session._space.shipID, 0);
    const entity =
      structureID > 0 && scene.staticEntitiesByID instanceof Map
        ? scene.staticEntitiesByID.get(structureID) || null
        : null;
    if (isControlledStaticStructureHostForSession(scene, session, entity)) {
      hosts.add(entity);
    }
  }
  return [...hosts];
}

Object.assign(module.exports, {
  CONTROLLED_STRUCTURE_DOGMA_BASELINE_FIELDS,
});
