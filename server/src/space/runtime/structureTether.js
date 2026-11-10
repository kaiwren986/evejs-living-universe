"use strict";

module.exports = {
  breakEntityStructureTether,
  breakStructureTethersForStructure,
  broadcastStructureTetherFx,
  buildStructureDockingTransitionUpdates,
  buildStructureTetherFxOptions,
  buildStructureTetherGraphicInfo,
  buildStructureTetherRepairFxOptions,
  getStructureTetherFxTargetID,
  getStructureTetherRepairFxGuids,
  repairEntityDroneBayOnTetherEngage,
  repairEntityOnTetherEngage,
  resolveSceneStructureTetherCandidate,
  resolveStructureTetherFxEntity,
  sendStructureTetherFxToSession,
  syncEntityStructureTetherState,
  tickSceneStructureTethers,
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
  findItemById,
  findShipItemById,
  listContainerItems,
  listSystemSpaceItems,
  warmSimulationInventoryProjection,
} = require(path.join(
  runtimeEntryDirname,
  "../services/inventory/simulationInventoryProjection",
));
const {
  buildStructureDockingTransitionUpdates:
    buildStructureDockingTransitionPresentationUpdates,
} = require(path.join(
  runtimeEntryDirname,
  "./destiny/presentation/mode.js",
));
const {
  hasDestinyStamp,
  resolveOptionalDestinyStamp,
} = require(path.join(runtimeEntryDirname, "./destiny/delivery/stamps.js"));
const structureTethering = require(path.join(
  runtimeEntryDirname,
  "./structureTethering",
));
const destiny = require(path.join(runtimeEntryDirname, "./destiny/index.js"));
const {
  notifyCapacitorChangeToSession,
} = require("./attributeChangeNotification");
const {
  getCharacterStateService,
} = require("./characterStateBridge");
const {
  getEntityCapacitorAmount,
  persistEntityCapacitorRatio,
  setEntityCapacitorRatio,
} = require("./entityCapacitor");
const {
  getEntitySurfaceDistance,
} = require("./entityDistance");
const {
  persistDynamicEntity,
} = require("./entitySpacePersistence");
const {
  repairEntityFittedModules,
} = require("./moduleHeat");
const {
  toFiniteNumber,
  toInt,
} = require("../../common/numbers");
const {
  lazyRequire,
} = require("./runtimeModuleBoundary");
const {
  broadcastDamageStateChange,
  buildShipHealthTransitionResult,
  notifyShipHealthAttributesToSession,
} = require("./shipHealthState");
const {
  getDroneCategoryID,
} = require("./squadronRuntimeBridge");
const {
  ensureEntityTargetingState,
} = require("./targeting");
const {
  hasPendingTimedInvulnerabilityCancellation,
  isEntityUndockInvulnerable,
} = require("./timedInvulnerability");
const shipCloakModule = require("./shipCloak");

function repairEntityDroneBayOnTetherEngage(entity, options = {}) {
  if (!entity || entity.kind !== "ship") {
    return [];
  }

  const shipID = toInt(entity.itemID, 0);
  if (shipID <= 0) {
    return [];
  }

  const session = options.session || entity.session || null;
  const repairedDroneIDs = [];
  const characterState = session ? getCharacterStateService() : null;
  const droneBayItems = listContainerItems(null, shipID, ITEM_FLAGS.DRONE_BAY);
  for (const droneItem of droneBayItems) {
    if (!droneItem || toInt(droneItem.categoryID, 0) !== getDroneCategoryID()) {
      continue;
    }

    const previousConditionState = normalizeShipConditionState(
      droneItem.conditionState,
    );
    const needsRepair =
      previousConditionState.damage > 0 ||
      previousConditionState.armorDamage > 0 ||
      previousConditionState.shieldCharge < 1 ||
      previousConditionState.incapacitated === true;
    if (!needsRepair) {
      continue;
    }

    const updateResult = updateInventoryItem(droneItem.itemID, (currentItem) => ({
      ...currentItem,
      conditionState: normalizeShipConditionState({
        ...(currentItem.conditionState || {}),
        damage: 0,
        armorDamage: 0,
        shieldCharge: 1,
        charge: 1,
        incapacitated: false,
      }),
    }));
    if (!updateResult || updateResult.success !== true) {
      continue;
    }

    const updatedDroneItem = updateResult.data;
    if (
      session &&
      updatedDroneItem &&
      characterState &&
      typeof characterState.syncDamageStateAttributesForSession === "function"
    ) {
      characterState.syncDamageStateAttributesForSession(
        session,
        updatedDroneItem,
        droneItem,
      );
    }
    repairedDroneIDs.push(toInt(droneItem.itemID, 0));
  }

  return repairedDroneIDs;
}

function repairEntityOnTetherEngage(scene, entity, nowMs = null) {
  if (!scene || !entity || entity.kind !== "ship") {
    return {
      repairedShip: false,
      repairedModules: [],
      repairedDrones: [],
      rechargedCapacitor: false,
    };
  }

  const whenMs = Math.max(0, toFiniteNumber(nowMs, scene.getCurrentSimTimeMs()));
  const previousConditionState = normalizeShipConditionState(entity.conditionState);
  const previousCapacitorAmount = getEntityCapacitorAmount(entity);
  const nextConditionState = normalizeShipConditionState({
    ...previousConditionState,
    damage: 0,
    armorDamage: 0,
    shieldCharge: 1,
    charge: 1,
    incapacitated: false,
  });
  const repairedShip =
    nextConditionState.damage !== previousConditionState.damage ||
    nextConditionState.armorDamage !== previousConditionState.armorDamage ||
    nextConditionState.shieldCharge !== previousConditionState.shieldCharge;
  entity.conditionState = nextConditionState;
  setEntityCapacitorRatio(entity, 1);
  persistEntityCapacitorRatio(entity);
  const rechargedCapacitor = getEntityCapacitorAmount(entity) > previousCapacitorAmount + 1e-6;
  const repairedModules = repairEntityFittedModules(entity, {
    session: entity.session || null,
    whenMs,
  });
  const repairedDrones = repairEntityDroneBayOnTetherEngage(entity, {
    session: entity.session || null,
  });

  if (
    repairedShip ||
    rechargedCapacitor ||
    repairedModules.length > 0 ||
    repairedDrones.length > 0
  ) {
    persistDynamicEntity(entity);
  }
  if (repairedShip) {
    if (entity.session) {
      notifyShipHealthAttributesToSession(
        entity.session,
        entity,
        buildShipHealthTransitionResult(entity, previousConditionState),
        whenMs,
      );
    }
    broadcastDamageStateChange(scene, entity, whenMs);
  }
  if (rechargedCapacitor && entity.session) {
    notifyCapacitorChangeToSession(
      entity.session,
      entity,
      whenMs,
      previousCapacitorAmount,
    );
  }

  return {
    repairedShip,
    repairedModules,
    repairedDrones,
    rechargedCapacitor,
  };
}

function breakEntityStructureTether(scene, entity, options = {}) {
  if (!scene || !structureTethering.isEntityStructureTethered(entity)) {
    return false;
  }

  const structureID = toInt(entity.structureTether && entity.structureTether.structureID, 0);
  const cleared = structureTethering.clearEntityStructureTether(
    entity,
    options.nowMs || scene.getCurrentSimTimeMs(),
    options.reason || null,
  );
  if (!cleared) {
    return false;
  }

  const tetherFxOptions = {};
  if (Object.prototype.hasOwnProperty.call(options, "resultSession")) {
    tetherFxOptions.resultSession = options.resultSession;
  }
  broadcastStructureTetherFx(
    scene,
    entity,
    structureID,
    false,
    tetherFxOptions,
  );
  return true;
}

function breakStructureTethersForStructure(scene, structureID, options = {}) {
  if (!scene) {
    return 0;
  }

  const targetStructureID = toInt(structureID, 0);
  if (targetStructureID <= 0) {
    return 0;
  }

  let brokenCount = 0;
  for (const entity of scene.dynamicEntities.values()) {
    if (
      !structureTethering.isEntityStructureTethered(entity) ||
      toInt(entity.structureTether && entity.structureTether.structureID, 0) !== targetStructureID
    ) {
      continue;
    }
    if (breakEntityStructureTether(scene, entity, options)) {
      brokenCount += 1;
    }
  }
  return brokenCount;
}

function resolveSceneStructureTetherCandidate(scene, entity, nowMs) {
  // A ship keeps its tether ineligibility until the client has actually been
  // told invulnerability ended, not merely until the deadline lapses. The
  // scene tether sweep runs on its own timer, so without the pending-timer
  // check it can engage the tether - and broadcast the tether FX - in the gap
  // between the deadline expiring and the cancellation timer sending
  // OnInvulnCancelled. That shows the client a tether while it still believes
  // the ship is invulnerable. The cancellation path clears the timer before it
  // re-syncs the tether, so the tether engages there in the right order.
  if (
    isEntityUndockInvulnerable(entity, nowMs) ||
    hasPendingTimedInvulnerabilityCancellation(entity)
  ) {
    return {
      eligible: false,
      reason: "UNDOCK_INVULNERABILITY",
      structure: null,
    };
  }
  return structureTethering.resolveEligibleTetherStructure(
    scene,
    entity,
    nowMs,
    {
      getLockedTargetCount(targetEntity) {
        return ensureEntityTargetingState(targetEntity).lockedTargets.size;
      },
      getPendingTargetLockCount(targetEntity) {
        return ensureEntityTargetingState(targetEntity).pendingTargetLocks.size;
      },
      getTargetedByCount(targetEntity) {
        return ensureEntityTargetingState(targetEntity).targetedBy.size;
      },
      getSurfaceDistance(sourceEntity, targetEntity) {
        return getEntitySurfaceDistance(sourceEntity, targetEntity);
      },
    },
  );
}

function resolveStructureTetherFxEntity(scene, structureOrID) {
  if (structureOrID && typeof structureOrID === "object") {
    return structureOrID;
  }
  return scene && typeof scene.getEntityByID === "function"
    ? scene.getEntityByID(toInt(structureOrID, 0))
    : null;
}

function getStructureTetherFxTargetID(structureOrID) {
  return toInt(
    structureOrID && typeof structureOrID === "object"
      ? structureOrID.itemID || structureOrID.structureID
      : structureOrID,
    0,
  );
}

function buildStructureTetherGraphicInfo(structureOrID, options = {}) {
  if (Object.prototype.hasOwnProperty.call(options, "graphicInfo")) {
    return options.graphicInfo;
  }

  const structureRadius = toFiniteNumber(
    options.targetRadius,
    toFiniteNumber(structureOrID && structureOrID.radius, 0),
  );
  const tetherRange = toFiniteNumber(
    options.tetheringRange,
    toFiniteNumber(structureOrID && structureOrID.tetheringRange, 0),
  );
  const linkBarrier = toFiniteNumber(
    options.linkBarrier,
    structureRadius + tetherRange,
  );
  const entries = [];
  if (structureRadius > 0) {
    entries.push(["targetRadius", structureRadius]);
  }
  if (linkBarrier > 0) {
    entries.push(["linkBarrier", linkBarrier]);
  }
  return destiny.buildGraphicInfoDict(entries);
}

function buildStructureTetherFxOptions(structureOrID, active, options = {}) {
  const fxOptions = { ...options };
  delete fxOptions.targetRadius;
  delete fxOptions.tetheringRange;
  delete fxOptions.linkBarrier;
  delete fxOptions.graphicInfo;

  return {
    targetID: getStructureTetherFxTargetID(structureOrID) || null,
    start: active === true,
    active: active === true,
    duration: active === true ? structureTethering.TETHER_LINK_DURATION_MS : -1,
    graphicInfo: buildStructureTetherGraphicInfo(structureOrID, options),
    ...fxOptions,
  };
}

function buildStructureDockingTransitionUpdates(entity, structureOrID, stamp) {
  const CLOAK_RENDER_EFFECT_GUID = shipCloakModule.CLOAK_RENDER_EFFECT_GUID;
  const entityID = toInt(entity && entity.itemID, 0);
  if (entityID <= 0) {
    return [];
  }

  return buildStructureDockingTransitionPresentationUpdates(
    { itemID: entityID },
    stamp,
    {
      cloakEffectGuid: CLOAK_RENDER_EFFECT_GUID,
      tetherEffectGuid: structureTethering.TETHER_FX_GUID,
      tetherEffectOptions: {
        targetID: getStructureTetherFxTargetID(structureOrID) || null,
        start: false,
        active: true,
        duration: structureTethering.TETHER_LINK_DURATION_MS,
        graphicInfo: buildStructureTetherGraphicInfo(structureOrID),
      },
    },
  );
}

function buildStructureTetherRepairFxOptions(active, options = {}) {
  const fxOptions = { ...options };
  delete fxOptions.targetID;
  delete fxOptions.graphicInfo;
  delete fxOptions.repairEffectMode;
  delete fxOptions.tetherRepairEffectMode;

  return {
    targetID: null,
    start: active === true,
    active: active === true,
    duration:
      active === true ? structureTethering.TETHER_REPAIR_DURATION_MS : -1,
    repeat: active === true ? structureTethering.TETHER_REPAIR_REPEAT : null,
    graphicInfo: destiny.buildGraphicInfoDict([]),
    ...fxOptions,
  };
}

function getStructureTetherRepairFxGuids(structureOrID, options = {}) {
  const mode =
    options.repairEffectMode ||
    options.tetherRepairEffectMode ||
    (
      structureOrID &&
      typeof structureOrID === "object" &&
      (
        structureOrID.tetherRepairEffectMode ||
        structureOrID.tetherRepairEffect ||
        structureOrID.repairEffectMode
      )
    ) ||
    structureTethering.TETHER_REPAIR_EFFECT_MODE.GENERIC;
  return structureTethering.getTetherRepairFxGuids(mode);
}

function broadcastStructureTetherFx(
  scene,
  entity,
  structureOrID,
  active,
  options = {},
) {
  if (!scene || !entity) {
    return {
      deliveredCount: 0,
      stamp: null,
    };
  }

  const structureEntity =
    resolveStructureTetherFxEntity(scene, structureOrID) || structureOrID;
  const repairGuids = getStructureTetherRepairFxGuids(
    structureEntity,
    options,
  );
  const repairResults = repairGuids.map((repairGuid) =>
    scene.broadcastSpecialFx(
      entity.itemID,
      repairGuid,
      buildStructureTetherRepairFxOptions(active, options),
      entity,
    ),
  );
  const linkResult = scene.broadcastSpecialFx(
    entity.itemID,
    structureTethering.TETHER_FX_GUID,
    buildStructureTetherFxOptions(structureEntity, active, options),
    entity,
  );
  const repairStampResult = repairResults.find((result) => (
    result && hasDestinyStamp(result.stamp)
  ));

  return {
    deliveredCount:
      repairResults.reduce(
        (total, result) =>
          total + toInt(result && result.deliveredCount, 0),
        0,
      ) + toInt(linkResult && linkResult.deliveredCount, 0),
    stamp: resolveOptionalDestinyStamp(
      linkResult && linkResult.stamp,
      repairStampResult && repairStampResult.stamp,
    ),
  };
}

function sendStructureTetherFxToSession(
  scene,
  session,
  entity,
  structureOrID,
  active,
  options = {},
) {
  if (!scene || !session || !entity) {
    return {
      delivered: false,
      stamp: null,
    };
  }

  const structureEntity =
    resolveStructureTetherFxEntity(scene, structureOrID) || structureOrID;
  const repairResults = options.suppressRepairFx === true
    ? []
    : getStructureTetherRepairFxGuids(
        structureEntity,
        options,
      ).map((repairGuid) =>
        scene.sendSpecialFxToSession(
          session,
          entity.itemID,
          repairGuid,
          buildStructureTetherRepairFxOptions(active, options),
          entity,
        ),
      );
  const linkResult = scene.sendSpecialFxToSession(
    session,
    entity.itemID,
    structureTethering.TETHER_FX_GUID,
    buildStructureTetherFxOptions(structureEntity, active, options),
    entity,
  );
  const repairStampResult = repairResults.find((result) => (
    result && hasDestinyStamp(result.stamp)
  ));

  return {
    delivered:
      repairResults.some((result) => result && result.delivered) ||
      Boolean(linkResult && linkResult.delivered),
    stamp: resolveOptionalDestinyStamp(
      linkResult && linkResult.stamp,
      repairStampResult && repairStampResult.stamp,
    ),
  };
}

function syncEntityStructureTetherState(scene, entity, options = {}) {
  if (!scene || !entity || entity.kind !== "ship" || !entity.session) {
    return {
      active: false,
      changed: false,
      fxReplayed: false,
      repaired: null,
      structureID: 0,
      reason: "ENTITY_NOT_ELIGIBLE",
    };
  }

  const now = Math.max(
    0,
    toFiniteNumber(
      options.nowMs,
      scene.getCurrentSimTimeMs(),
    ),
  );
  const candidate = resolveSceneStructureTetherCandidate(scene, entity, now);
  const currentTetherStructureID = toInt(
    entity.structureTether && entity.structureTether.structureID,
    0,
  );
  let changed = false;
  let fxReplayed = false;
  let repaired = null;

  if (
    structureTethering.isEntityStructureTethered(entity) &&
    (
      !candidate.eligible ||
      toInt(candidate.structure && candidate.structure.itemID, 0) !== currentTetherStructureID
    )
  ) {
    changed = breakEntityStructureTether(scene, entity, {
      nowMs: now,
      reason: candidate.reason || "TETHER_INVALID",
    }) || changed;
  }

  if (
    !structureTethering.isEntityStructureTethered(entity) &&
    candidate.eligible &&
    candidate.structure
  ) {
    structureTethering.startEntityStructureTether(entity, candidate.structure, now);
    changed = true;
    if (options.repairOnEngage !== false) {
      repaired = repairEntityOnTetherEngage(scene, entity, now);
    }
    if (options.broadcastFx !== false) {
      broadcastStructureTetherFx(scene, entity, candidate.structure, true);
    }
  }

  // A damaged drone can be recalled after its controller has already acquired
  // tether. Keep applying the repair contract while tether remains active, not
  // only on the transition that first established it.
  if (
    repaired === null &&
    options.repairOnEngage !== false &&
    structureTethering.isEntityStructureTethered(entity)
  ) {
    repaired = repairEntityOnTetherEngage(scene, entity, now);
  }

  if (
    options.replayFx !== false &&
    options.replaySession &&
    structureTethering.isEntityStructureTethered(entity) &&
    (
      options.forceReplayFx === true ||
      changed
    )
  ) {
    const replayStructureID = toInt(
      entity.structureTether && entity.structureTether.structureID,
      toInt(candidate.structure && candidate.structure.itemID, 0),
    );
    const replayStructure =
      resolveStructureTetherFxEntity(scene, replayStructureID) ||
      candidate.structure ||
      replayStructureID;
    const replayResult = sendStructureTetherFxToSession(
      scene,
      options.replaySession,
      entity,
      replayStructure,
      true,
      {
        suppressRepairFx: options.suppressRepairFx === true,
      },
    );
    fxReplayed = replayResult.delivered === true;
  }

  return {
    active: structureTethering.isEntityStructureTethered(entity),
    changed,
    fxReplayed,
    repaired,
    structureID: toInt(entity.structureTether && entity.structureTether.structureID, 0),
    reason: candidate.reason || null,
  };
}

function tickSceneStructureTethers(scene, nowMs = null) {
  if (!scene) {
    return [];
  }

  const now = Math.max(0, toFiniteNumber(nowMs, scene.getCurrentSimTimeMs()));
  const structureTetherRestrictionState = lazyRequire("../services/structure/structureTetherRestrictionState");
  structureTetherRestrictionState.pruneExpiredCharacterTetherRestrictions(now);
  const tethered = [];
  for (const entity of scene.dynamicEntities.values()) {
    if (!entity || entity.kind !== "ship" || !entity.session) {
      continue;
    }
    const tetherResult = syncEntityStructureTetherState(scene, entity, {
      nowMs: now,
      broadcastFx: true,
      repairOnEngage: true,
    });
    if (tetherResult.active) {
      tethered.push(entity.itemID);
    }
  }

  return tethered;
}
