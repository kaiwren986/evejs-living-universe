"use strict";

const path = require("path");

const {
  isNativeNpcEntity,
} = require(path.join(__dirname, "../npc/npcEquipment"));
const nativeNpcStore = require(path.join(__dirname, "../npc/nativeNpcStore"));
const {
  getFuelStorageFlagsForType,
} = require(path.join(
  __dirname,
  "../../services/inventory/fuelBayInventory",
));

function getItemStore() {
  return require(path.join(__dirname, "../../services/inventory/itemStore"));
}

function getSimulationInventoryProjection() {
  return require(path.join(
    __dirname,
    "../../services/inventory/simulationInventoryProjection",
  ));
}

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function buildFuelFlagSet(fuelTypeID, priorityFlags = []) {
  return new Set(getFuelStorageFlagsForType(fuelTypeID, priorityFlags));
}

function buildFuelFlagPriority(fuelTypeID, priorityFlags = []) {
  return new Map(
    getFuelStorageFlagsForType(fuelTypeID, priorityFlags)
      .map((flagID, index) => [flagID, index]),
  );
}

function filterNativeStacksByFuelFlags(stacks, fuelTypeID, priorityFlags = []) {
  const normalizedFuelTypeID = toInt(fuelTypeID, 0);
  const allowedFlags = buildFuelFlagSet(normalizedFuelTypeID, priorityFlags);
  if (normalizedFuelTypeID <= 0 || allowedFlags.size <= 0) {
    return [];
  }

  return (Array.isArray(stacks) ? stacks : [])
    .filter(
      (entry) =>
        toInt(entry && entry.typeID, 0) === normalizedFuelTypeID &&
        allowedFlags.has(toInt(entry && entry.flagID, 5)),
    )
    .map((entry) => ({ ...entry }));
}

function listCharacterFuelStacks(characterID, shipID, fuelTypeID, priorityFlags = []) {
  const numericCharacterID = toInt(characterID, 0);
  const numericShipID = toInt(shipID, 0);
  const normalizedFuelTypeID = toInt(fuelTypeID, 0);
  if (numericCharacterID <= 0 || numericShipID <= 0 || normalizedFuelTypeID <= 0) {
    return [];
  }

  const { listContainerItems } = getSimulationInventoryProjection();
  const stacks = [];
  for (const flagID of getFuelStorageFlagsForType(normalizedFuelTypeID, priorityFlags)) {
    const items = listContainerItems(numericCharacterID, numericShipID, flagID)
      .filter((entry) => toInt(entry && entry.typeID, 0) === normalizedFuelTypeID);
    stacks.push(...items);
  }
  return stacks;
}

function getFuelStacksForShipStorage(entity, fuelTypeID, callbacks = {}, priorityFlags = []) {
  const normalizedFuelTypeID = toInt(fuelTypeID, 0);
  if (!entity || entity.kind !== "ship" || normalizedFuelTypeID <= 0) {
    return [];
  }

  if (isNativeNpcEntity(entity)) {
    const storeItems = filterNativeStacksByFuelFlags(
      nativeNpcStore.listNativeCargoForEntity(entity.itemID),
      normalizedFuelTypeID,
      priorityFlags,
    );
    if (storeItems.length > 0) {
      return storeItems;
    }
    return filterNativeStacksByFuelFlags(
      Array.isArray(entity.nativeCargoItems) ? entity.nativeCargoItems : [],
      normalizedFuelTypeID,
      priorityFlags,
    );
  }

  const characterID =
    callbacks.resolveCharacterID &&
    typeof callbacks.resolveCharacterID === "function"
      ? callbacks.resolveCharacterID(entity)
      : 0;
  return listCharacterFuelStacks(
    characterID,
    entity.itemID,
    normalizedFuelTypeID,
    priorityFlags,
  );
}

function getFuelQuantityFromStacks(stacks = []) {
  return stacks.reduce((sum, stack) => {
    const quantity = Math.max(
      0,
      toInt(stack && (stack.quantity ?? stack.stacksize), 0),
    );
    return sum + quantity;
  }, 0);
}

function applyNativeCargoQuantity(entity, stack, nextQuantity) {
  const cargoID = toInt(stack && (stack.cargoID ?? stack.itemID), 0);
  const nextStackQuantity = Math.max(0, toInt(nextQuantity, 0));

  const cargoRecord = nativeNpcStore.listNativeCargoForEntity(entity.itemID)
    .find((entry) => toInt(entry && entry.cargoID, 0) === cargoID) || null;
  if (cargoRecord) {
    const persistResult = nextStackQuantity > 0
      ? nativeNpcStore.upsertNativeCargo({
          ...cargoRecord,
          quantity: nextStackQuantity,
        }, {
          transient: cargoRecord.transient === true,
        })
      : nativeNpcStore.removeNativeCargo(cargoRecord.cargoID);
    if (!persistResult.success) {
      return persistResult;
    }
  }

  if (Array.isArray(entity.nativeCargoItems)) {
    entity.nativeCargoItems = entity.nativeCargoItems.flatMap((entry) => {
      const entryID = toInt(entry && (entry.cargoID ?? entry.itemID), 0);
      if (entryID !== cargoID) {
        return [entry];
      }
      if (nextStackQuantity <= 0) {
        return [];
      }
      return [{
        ...entry,
        quantity: nextStackQuantity,
        stacksize: nextStackQuantity,
      }];
    });
  }

  return {
    success: true,
    data: {
      changes: [],
    },
  };
}

function restoreFuelConsumption(entity, fuelResult) {
  if (!fuelResult || fuelResult.success !== true) {
    return { success: true, changes: [] };
  }
  if (fuelResult.rollbackKind === "inventory") {
    const { restoreInventoryItemChangesAtomic } = getItemStore();
    return restoreInventoryItemChangesAtomic(fuelResult.rollbackChanges || []);
  }
  if (fuelResult.rollbackKind === "native") {
    const entityOnlySnapshots = [];
    const storedCargoIDs = [];
    for (const snapshot of fuelResult.rollbackChanges || []) {
      const cargoID = toInt(snapshot && (snapshot.cargoID ?? snapshot.itemID), 0);
      if (cargoID <= 0) {
        return { success: false, errorMsg: "FUEL_ROLLBACK_FAILED", changes: [] };
      }
      // Transient NPC fixtures can carry cargo only on the live entity. Do not
      // promote those stacks into nativeNpcStore during compensation: doing so
      // changes their authority and can leak a synthetic row into later spawns.
      if (toInt(snapshot && snapshot.entityID, 0) <= 0) {
        entityOnlySnapshots.push({ ...snapshot });
        continue;
      }
      const restoreResult = nativeNpcStore.upsertNativeCargo({
        ...snapshot,
        cargoID,
        entityID: toInt(
          snapshot && (snapshot.entityID ?? snapshot.locationID),
          toInt(entity && entity.itemID, 0),
        ),
        quantity: Math.max(
          0,
          toInt(snapshot && (snapshot.quantity ?? snapshot.stacksize), 0),
        ),
      }, {
        transient:
          snapshot && snapshot.transient === true ||
          entity && entity.transient === true,
      });
      if (!restoreResult || restoreResult.success !== true) {
        return {
          success: false,
          errorMsg: restoreResult && restoreResult.errorMsg || "FUEL_ROLLBACK_FAILED",
          changes: [],
        };
      }
      storedCargoIDs.push(cargoID);
    }
    if (entity && Array.isArray(entity.nativeCargoItems)) {
      const restoredSnapshots = [
        ...entityOnlySnapshots,
        ...nativeNpcStore.buildNativeCargoItems(entity.itemID).filter((entry) => (
          storedCargoIDs.includes(toInt(entry && (entry.cargoID ?? entry.itemID), 0))
        )),
      ];
      for (const snapshot of restoredSnapshots) {
        const cargoID = toInt(snapshot && (snapshot.cargoID ?? snapshot.itemID), 0);
        const restoredStack = {
          ...snapshot,
          quantity: Math.max(
            0,
            toInt(snapshot && (snapshot.quantity ?? snapshot.stacksize), 0),
          ),
        };
        restoredStack.stacksize = restoredStack.quantity;
        const existingIndex = entity.nativeCargoItems.findIndex((entry) => (
          toInt(entry && (entry.cargoID ?? entry.itemID), 0) === cargoID
        ));
        if (existingIndex >= 0) {
          entity.nativeCargoItems[existingIndex] = restoredStack;
        } else {
          entity.nativeCargoItems.push(restoredStack);
        }
      }
    }
    return { success: true, changes: [] };
  }
  return { success: true, changes: [] };
}

function consumeFuelFromShipStorage(entity, fuelTypeID, quantity, callbacks = {}, priorityFlags = []) {
  const normalizedFuelTypeID = toInt(fuelTypeID, 0);
  const requestedQuantity = Math.max(0, toInt(quantity, 0));
  if (!entity || normalizedFuelTypeID <= 0 || requestedQuantity <= 0) {
    return {
      success: true,
      errorMsg: null,
      changes: [],
      consumedQuantity: 0,
    };
  }

  const flagPriority = buildFuelFlagPriority(normalizedFuelTypeID, priorityFlags);
  const fuelStacks = getFuelStacksForShipStorage(
    entity,
    normalizedFuelTypeID,
    callbacks,
    priorityFlags,
  ).sort((left, right) => {
    const leftPriority = flagPriority.get(toInt(left && left.flagID, 5)) ?? Number.MAX_SAFE_INTEGER;
    const rightPriority = flagPriority.get(toInt(right && right.flagID, 5)) ?? Number.MAX_SAFE_INTEGER;
    if (leftPriority !== rightPriority) {
      return leftPriority - rightPriority;
    }
    const leftQuantity = toInt(left && (left.quantity ?? left.stacksize), 0);
    const rightQuantity = toInt(right && (right.quantity ?? right.stacksize), 0);
    return rightQuantity - leftQuantity;
  });
  if (getFuelQuantityFromStacks(fuelStacks) < requestedQuantity) {
    return {
      success: false,
      errorMsg: "NO_FUEL",
      changes: [],
    };
  }

  // Player inventory is a single authority table, so plan every source-stack
  // decrement first and publish it through one row-overlay commit. A later-row
  // write failure must not leave a partially burned activation cost.
  if (!isNativeNpcEntity(entity)) {
    const requests = [];
    let remaining = requestedQuantity;
    for (const stack of fuelStacks) {
      if (remaining <= 0) {
        break;
      }
      const stackQuantity = Math.max(
        0,
        toInt(stack && (stack.quantity ?? stack.stacksize), 0),
      );
      const consumedFromStack = Math.min(stackQuantity, remaining);
      if (consumedFromStack <= 0) {
        continue;
      }
      requests.push({
        itemID: toInt(stack && stack.itemID, 0),
        quantity: consumedFromStack,
        expectedTypeID: normalizedFuelTypeID,
        expectedOwnerID: toInt(stack && stack.ownerID, 0),
        expectedLocationID: toInt(stack && stack.locationID, 0),
        expectedFlagID: toInt(stack && stack.flagID, 5),
        expectedQuantity: stackQuantity,
      });
      remaining -= consumedFromStack;
    }
    if (remaining > 0 || requests.some((request) => request.itemID <= 0)) {
      return {
        success: false,
        errorMsg: "NO_FUEL",
        changes: [],
      };
    }
    const { consumeInventoryItemStacksAtomic } = getItemStore();
    const consumeResult = consumeInventoryItemStacksAtomic(requests);
    if (!consumeResult || consumeResult.success !== true) {
      return {
        success: false,
        errorMsg:
          consumeResult && consumeResult.errorMsg
            ? consumeResult.errorMsg
            : "NO_FUEL",
        changes: [],
      };
    }
    const changes = Array.isArray(consumeResult.changes)
      ? consumeResult.changes
      : consumeResult.data && Array.isArray(consumeResult.data.changes)
        ? consumeResult.data.changes
        : [];
    return {
      success: true,
      errorMsg: null,
      changes,
      consumedQuantity: requestedQuantity,
      rollbackKind: "inventory",
      rollbackChanges: changes,
    };
  }

  const changes = [];
  const rollbackChanges = [];
  let remaining = requestedQuantity;
  for (const stack of fuelStacks) {
    if (remaining <= 0) {
      break;
    }
    const stackQuantity = Math.max(
      0,
      toInt(stack && (stack.quantity ?? stack.stacksize), 0),
    );
    if (stackQuantity <= 0) {
      continue;
    }
    rollbackChanges.push({ ...stack });
    const nextQuantity = Math.max(
      0,
      stackQuantity - Math.min(stackQuantity, remaining),
    );
    const updateResult = applyNativeCargoQuantity(entity, stack, nextQuantity);
    if (!updateResult.success) {
      return {
        ...updateResult,
        changes,
      };
    }
    remaining -= (stackQuantity - nextQuantity);
  }

  return {
    success: remaining <= 0,
    errorMsg: remaining <= 0 ? null : "NO_FUEL",
    changes,
    consumedQuantity: requestedQuantity - Math.max(0, remaining),
    rollbackKind: "native",
    rollbackChanges,
  };
}

module.exports = {
  getFuelStacksForShipStorage,
  getFuelQuantityFromStacks,
  consumeFuelFromShipStorage,
  restoreFuelConsumption,
};
