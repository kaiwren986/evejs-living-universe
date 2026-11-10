"use strict";

module.exports = {
  applyAssistanceCycleRuntimeSnapshot,
  applyHostileCycleRuntimeSnapshot,
  applyJammerCycleRuntimeSnapshot,
  applySalvagerCycleRuntimeSnapshot,
  resolveAssistanceCycleRuntimeSnapshot,
  resolveHostileCycleRuntimeSnapshot,
  resolveJammerCycleRuntimeSnapshot,
  resolveSalvagerCycleRuntimeSnapshot,
};

const runtimeEntryDirname = require("path").resolve(__dirname, "..");
const path = require("path");
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
const commandBurstRuntime = require(path.join(
  runtimeEntryDirname,
  "./modules/commandBurstRuntime",
));
const {
  collectNumericModuleAttributeDiffs,
  resolveModuleSnapshotDirectModifierEntries,
} = require(path.join(
  runtimeEntryDirname,
  "./modules/moduleAttributeDiff",
));
const assistanceModuleRuntime = require(path.join(
  runtimeEntryDirname,
  "./modules/assistanceModuleRuntime",
));
const hostileModuleRuntime = require(path.join(
  runtimeEntryDirname,
  "./modules/hostileModuleRuntime",
));
const jammerModuleRuntime = require(path.join(
  runtimeEntryDirname,
  "./modules/jammerModuleRuntime",
));
const salvagerRuntime = require(path.join(
  runtimeEntryDirname,
  "./modules/salvagerRuntime",
));
const {
  getEntityRuntimeActiveModuleContexts,
  getEntityRuntimeFittedItems,
  getEntityRuntimeLoadedCharge,
  getEntityRuntimeShipItem,
  getEntityRuntimeSkillMap,
} = require("./entityDogmaView");
const {
  buildAssistanceModuleRuntimeCallbacks,
  buildHostileModuleRuntimeCallbacks,
  buildJammerModuleRuntimeCallbacks,
  buildSalvagerRuntimeCallbacks,
} = require("./moduleRuntimeCallbacks");
const {
  toFiniteNumber,
  toInt,
} = require("../../common/numbers");

function resolveAssistanceCycleRuntimeSnapshot(
  scene,
  entity,
  moduleItem,
  effectState,
  nowMs,
) {
  const shipItem = getEntityRuntimeShipItem(entity);
  const effectRecord =
    effectState && effectState.effectRecord
      ? effectState.effectRecord
      : getEffectTypeRecord(effectState && effectState.effectID);
  if (!scene || !entity || !moduleItem || !shipItem || !effectRecord) {
    return {
      matched: true,
      success: false,
      errorMsg: "UNSUPPORTED_MODULE",
    };
  }

  return assistanceModuleRuntime.resolveAssistanceModuleActivation({
    scene,
    entity,
    moduleItem,
    effectRecord,
    chargeItem: getEntityRuntimeLoadedCharge(entity, moduleItem),
    shipItem,
    skillMap: getEntityRuntimeSkillMap(entity),
    fittedItems: getEntityRuntimeFittedItems(entity),
    activeModuleContexts: getEntityRuntimeActiveModuleContexts(entity, {
      excludeModuleID: moduleItem.itemID,
      includeOverloadModuleID: moduleItem.itemID,
    }),
    additionalDirectModifierEntries:
      resolveModuleSnapshotDirectModifierEntries(entity, moduleItem, {
        nowMs,
        collectModifierEntriesForItem:
          commandBurstRuntime.collectModifierEntriesForItem,
      }),
    options: {
      targetID: effectState && effectState.targetID,
    },
    callbacks: buildAssistanceModuleRuntimeCallbacks(scene),
  });
}

function applyAssistanceCycleRuntimeSnapshot(effectState, snapshotData) {
  if (!effectState || !snapshotData) {
    return false;
  }

  const runtimeAttrs = snapshotData.runtimeAttrs || null;
  const statePatch = snapshotData.effectStatePatch || null;
  if (!runtimeAttrs || !statePatch) {
    return false;
  }

  effectState.capNeed = Math.max(
    0,
    toFiniteNumber(runtimeAttrs.capNeed, effectState.capNeed),
  );
  effectState.durationMs = Math.max(
    1,
    toFiniteNumber(runtimeAttrs.durationMs, effectState.durationMs),
  );
  effectState.durationAttributeID = Math.max(
    0,
    toInt(runtimeAttrs.durationAttributeID, effectState.durationAttributeID),
  );
  effectState.genericAttributeOverrides =
    runtimeAttrs.attributeOverrides &&
    typeof runtimeAttrs.attributeOverrides === "object"
      ? { ...runtimeAttrs.attributeOverrides }
      : null;

  // Preserve the caller's finite repeat/deactivation lifecycle while replacing
  // all assistance values that should take effect on the next cycle.
  for (const [key, value] of Object.entries(statePatch)) {
    if (key !== "repeat") {
      effectState[key] = value;
    }
  }
  return true;
}

function resolveJammerCycleRuntimeSnapshot(
  scene,
  entity,
  moduleItem,
  effectState,
  nowMs,
) {
  const shipItem = getEntityRuntimeShipItem(entity);
  const effectRecord =
    effectState && effectState.effectRecord
      ? effectState.effectRecord
      : getEffectTypeRecord(effectState && effectState.effectID);
  if (!scene || !entity || !moduleItem || !shipItem || !effectRecord) {
    return {
      matched: true,
      success: false,
      errorMsg: "UNSUPPORTED_MODULE",
    };
  }

  return jammerModuleRuntime.resolveJammerModuleActivation({
    scene,
    entity,
    moduleItem,
    effectRecord,
    chargeItem: getEntityRuntimeLoadedCharge(entity, moduleItem),
    shipItem,
    skillMap: getEntityRuntimeSkillMap(entity),
    fittedItems: getEntityRuntimeFittedItems(entity),
    activeModuleContexts: getEntityRuntimeActiveModuleContexts(entity, {
      excludeModuleID: moduleItem.itemID,
      includeOverloadModuleID: moduleItem.itemID,
    }),
    additionalDirectModifierEntries:
      resolveModuleSnapshotDirectModifierEntries(entity, moduleItem, {
        nowMs,
        collectModifierEntriesForItem:
          commandBurstRuntime.collectModifierEntriesForItem,
      }),
    options: {
      targetID: effectState && effectState.targetID,
    },
    callbacks: buildJammerModuleRuntimeCallbacks(scene),
  });
}

function applyJammerCycleRuntimeSnapshot(effectState, snapshotData) {
  if (!effectState || !snapshotData) {
    return false;
  }

  const runtimeAttrs = snapshotData.runtimeAttrs || null;
  const statePatch = snapshotData.effectStatePatch || null;
  if (!runtimeAttrs || !statePatch) {
    return false;
  }

  effectState.capNeed = Math.max(
    0,
    toFiniteNumber(runtimeAttrs.capNeed, effectState.capNeed),
  );
  effectState.durationMs = Math.max(
    1,
    toFiniteNumber(runtimeAttrs.durationMs, effectState.durationMs),
  );
  effectState.durationAttributeID = Math.max(
    0,
    toInt(runtimeAttrs.durationAttributeID, effectState.durationAttributeID),
  );
  effectState.genericAttributeOverrides =
    runtimeAttrs.attributeOverrides &&
    typeof runtimeAttrs.attributeOverrides === "object"
      ? { ...runtimeAttrs.attributeOverrides }
      : null;

  // Keep the caller's finite repeat/deactivation lifecycle while adopting the
  // authoritative ECM envelope and racial strengths at the next cycle.
  for (const [key, value] of Object.entries(statePatch)) {
    if (key !== "repeat") {
      effectState[key] = value;
    }
  }
  return true;
}

function resolveSalvagerCycleRuntimeSnapshot(
  scene,
  entity,
  moduleItem,
  effectState,
  nowMs,
) {
  const shipItem = getEntityRuntimeShipItem(entity);
  const effectRecord =
    effectState && effectState.effectRecord
      ? effectState.effectRecord
      : getEffectTypeRecord(effectState && effectState.effectID);
  if (!scene || !entity || !moduleItem || !shipItem || !effectRecord) {
    return {
      matched: true,
      success: false,
      errorMsg: "UNSUPPORTED_MODULE",
    };
  }

  return salvagerRuntime.resolveSalvagerActivation({
    scene,
    entity,
    moduleItem,
    effectRecord,
    chargeItem: getEntityRuntimeLoadedCharge(entity, moduleItem),
    shipItem,
    skillMap: getEntityRuntimeSkillMap(entity),
    fittedItems: getEntityRuntimeFittedItems(entity),
    activeModuleContexts: getEntityRuntimeActiveModuleContexts(entity, {
      excludeModuleID: moduleItem.itemID,
      includeOverloadModuleID: moduleItem.itemID,
    }),
    additionalDirectModifierEntries:
      resolveModuleSnapshotDirectModifierEntries(entity, moduleItem, {
        nowMs,
        collectModifierEntriesForItem:
          commandBurstRuntime.collectModifierEntriesForItem,
      }),
    options: {
      targetID: effectState && effectState.targetID,
    },
    callbacks: buildSalvagerRuntimeCallbacks(scene),
  });
}

function applySalvagerCycleRuntimeSnapshot(effectState, snapshotData) {
  if (!effectState || !snapshotData) {
    return false;
  }

  const runtimeAttrs = snapshotData.runtimeAttrs || null;
  const statePatch = snapshotData.effectStatePatch || null;
  if (!runtimeAttrs || !statePatch) {
    return false;
  }

  effectState.capNeed = Math.max(
    0,
    toFiniteNumber(runtimeAttrs.capNeed, effectState.capNeed),
  );
  effectState.durationMs = Math.max(
    1,
    toFiniteNumber(runtimeAttrs.durationMs, effectState.durationMs),
  );
  effectState.durationAttributeID = Math.max(
    0,
    toInt(runtimeAttrs.durationAttributeID, effectState.durationAttributeID),
  );
  effectState.genericAttributeOverrides =
    runtimeAttrs.attributeOverrides &&
    typeof runtimeAttrs.attributeOverrides === "object"
      ? { ...runtimeAttrs.attributeOverrides }
      : null;

  for (const [key, value] of Object.entries(statePatch)) {
    if (key !== "repeat") {
      effectState[key] = value;
    }
  }
  return true;
}

function resolveHostileCycleRuntimeSnapshot(
  scene,
  entity,
  moduleItem,
  effectState,
  nowMs,
) {
  const shipItem = getEntityRuntimeShipItem(entity);
  const effectRecord =
    effectState && effectState.effectRecord
      ? effectState.effectRecord
      : getEffectTypeRecord(effectState && effectState.effectID);
  if (!scene || !entity || !moduleItem || !shipItem || !effectRecord) {
    return {
      matched: true,
      success: false,
      errorMsg: "UNSUPPORTED_MODULE",
    };
  }

  return hostileModuleRuntime.resolveHostileModuleActivation({
    scene,
    entity,
    moduleItem,
    effectRecord,
    chargeItem: getEntityRuntimeLoadedCharge(entity, moduleItem),
    shipItem,
    skillMap: getEntityRuntimeSkillMap(entity),
    fittedItems: getEntityRuntimeFittedItems(entity),
    activeModuleContexts: getEntityRuntimeActiveModuleContexts(entity, {
      excludeModuleID: moduleItem.itemID,
      includeOverloadModuleID: moduleItem.itemID,
    }),
    additionalDirectModifierEntries:
      resolveModuleSnapshotDirectModifierEntries(entity, moduleItem, {
        nowMs,
        collectModifierEntriesForItem:
          commandBurstRuntime.collectModifierEntriesForItem,
      }),
    options: {
      targetID: effectState && effectState.targetID,
    },
    callbacks: buildHostileModuleRuntimeCallbacks(scene),
  });
}

function applyHostileCycleRuntimeSnapshot(effectState, snapshotData) {
  if (!effectState || !snapshotData) {
    return false;
  }

  const runtimeAttrs = snapshotData.runtimeAttrs || null;
  const statePatch = snapshotData.effectStatePatch || null;
  if (!runtimeAttrs || !statePatch) {
    return false;
  }

  effectState.capNeed = Math.max(
    0,
    toFiniteNumber(runtimeAttrs.capNeed, effectState.capNeed),
  );
  effectState.durationMs = Math.max(
    1,
    toFiniteNumber(runtimeAttrs.durationMs, effectState.durationMs),
  );
  effectState.durationAttributeID = Math.max(
    0,
    toInt(runtimeAttrs.durationAttributeID, effectState.durationAttributeID),
  );
  effectState.genericAttributeOverrides =
    runtimeAttrs.attributeOverrides &&
    typeof runtimeAttrs.attributeOverrides === "object"
      ? { ...runtimeAttrs.attributeOverrides }
      : null;

  // Keep the existing lifecycle/deactivation request while adopting the
  // authoritative range, strength, falloff, and target modifiers for the next
  // hostile cycle.
  for (const [key, value] of Object.entries(statePatch)) {
    if (key !== "repeat") {
      effectState[key] = value;
    }
  }
  return true;
}
