"use strict";

module.exports = {
  consumeEntityCapacitor,
  getEntityCapacitorAmount,
  getEntityCapacitorRatio,
  persistEntityCapacitorRatio,
  setEntityCapacitorRatio,
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
const structureState = require(path.join(
  runtimeEntryDirname,
  "../services/structure/structureState",
));
const {
  clamp,
  toFiniteNumber,
  toInt,
} = require("../../common/numbers");

function getEntityCapacitorRatio(entity) {
  return clamp(toFiniteNumber(entity && entity.capacitorChargeRatio, 1), 0, 1);
}

function setEntityCapacitorRatio(entity, nextRatio) {
  if (!entity) {
    return 0;
  }
  entity.capacitorChargeRatio = clamp(toFiniteNumber(nextRatio, 0), 0, 1);
  if (entity.kind === "ship") {
    entity.conditionState = normalizeShipConditionState({
      ...(entity.conditionState || {}),
      charge: entity.capacitorChargeRatio,
    });
  }
  return entity.capacitorChargeRatio;
}

function getEntityCapacitorAmount(entity) {
  return (
    toFiniteNumber(entity && entity.capacitorCapacity, 0) *
    getEntityCapacitorRatio(entity)
  );
}

function persistEntityCapacitorRatio(entity) {
  if (!entity) {
    return false;
  }

  const nextRatio = getEntityCapacitorRatio(entity);
  if (entity.kind === "structure") {
    const structureID = toInt(entity.itemID, 0);
    if (structureID <= 0) {
      return false;
    }
    const result = structureState.updateStructureRecord(
      structureID,
      (currentStructure) => ({
        ...currentStructure,
        conditionState: {
          ...(currentStructure.conditionState || {}),
          charge: nextRatio,
        },
      }),
      // The live entity already owns this exact capacitor transition. Emitting
      // the generic structure-change listener here would synchronously rebuild
      // the static host from its unpiloted snapshot in the middle of module
      // activation/recharge. Persist quietly; unrelated structure changes still
      // flow through the normal live sync path below.
      { emitLive: false },
    );
    return Boolean(result && result.success);
  }

  if (entity.kind !== "ship" || entity.persistSpaceState !== true) {
    return false;
  }
  if (!findShipItemById(entity.itemID)) {
    entity.persistSpaceState = false;
    return false;
  }

  const result = updateShipItem(entity.itemID, (currentItem) => ({
    ...currentItem,
    conditionState: {
      ...(currentItem.conditionState || {}),
      charge: nextRatio,
    },
  }));
  return Boolean(result && result.success);
}

function consumeEntityCapacitor(entity, amount) {
  const requestedAmount = Math.max(0, toFiniteNumber(amount, 0));
  const capacitorCapacity = Math.max(
    toFiniteNumber(entity && entity.capacitorCapacity, 0),
    0,
  );
  if (!entity || capacitorCapacity <= 0) {
    return requestedAmount <= 0;
  }

  const currentAmount = getEntityCapacitorAmount(entity);
  if (requestedAmount > currentAmount + 1e-6) {
    return false;
  }

  setEntityCapacitorRatio(entity, (currentAmount - requestedAmount) / capacitorCapacity);
  persistEntityCapacitorRatio(entity);
  return true;
}
