"use strict";

const {
  cloneValue,
} = require("../../common/clone");

const path = require("path");

const database = require(path.join(__dirname, "../../gameStore"));
const log = require(path.join(__dirname, "../../utils/logger"));
const deliveryItemCustody = require(path.join(
  __dirname,
  "../inventory/deliveryItemCustody",
));
const {
  NOTIFICATION_GROUP,
  NOTIFICATION_TYPE,
} = require(path.join(__dirname, "../notifications/notificationConstants"));
const {
  createNotification,
} = require(path.join(__dirname, "../notifications/notificationState"));
const structureState = require(path.join(__dirname, "./structureState"));
const runtimeState = require(path.join(__dirname, "./structureDeliveryRuntimeState"));

let faultInjector = null;

function toPositiveInt(value, fallback = 0) {
  const numeric = Math.trunc(Number(value) || 0);
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : fallback;
}

function injectFault(point, operation) {
  if (typeof faultInjector === "function") {
    faultInjector(point, cloneValue(operation));
  }
}

function persistOperation(operation) {
  operation.updatedAt = new Date().toISOString();
  return runtimeState.putOperationDurable(operation);
}

function summarizeDeliveredTypes(legs) {
  const quantitiesByTypeID = new Map();
  for (const leg of Array.isArray(legs) ? legs : []) {
    if (!leg || leg.status !== "committed" || !leg.deliveredItem) {
      continue;
    }
    const typeID = toPositiveInt(leg.deliveredItem.typeID, 0);
    const quantity = toPositiveInt(leg.deliveredItem.quantity, 0);
    if (!typeID || !quantity) {
      continue;
    }
    quantitiesByTypeID.set(typeID, (quantitiesByTypeID.get(typeID) || 0) + quantity);
  }
  return [...quantitiesByTypeID.entries()]
    .sort(([leftTypeID], [rightTypeID]) => leftTypeID - rightTypeID)
    .map(([typeID, quantity]) => [quantity, typeID]);
}

function createOperation(input = {}) {
  const allocation = runtimeState.allocateOperationIDDurable();
  if (!allocation || allocation.success !== true) {
    return allocation || {
      success: false,
      errorMsg: "STRUCTURE_DELIVERY_OPERATION_ALLOCATION_FAILED",
    };
  }
  const operationID = toPositiveInt(allocation.operationID, 0);
  const operationKey = `structure-delivery:${operationID}`;
  const operation = {
    schemaVersion: 1,
    operationID,
    operationKey,
    kind: String(input.kind || "delivery"),
    status: "pending",
    actorCharacterID: toPositiveInt(input.actorCharacterID, 0),
    structureID: toPositiveInt(input.structureID, 0),
    notificationContext: input.notificationContext
      ? cloneValue(input.notificationContext)
      : null,
    notificationStatus: "pending",
    legs: (Array.isArray(input.legs) ? input.legs : []).map((leg, index) => ({
      sourceItem: cloneValue(leg.sourceItem),
      destination: cloneValue(leg.destination),
      reason: String(leg.reason || ""),
      deliveredItem: leg.deliveredItem ? cloneValue(leg.deliveredItem) : null,
      fuelQuantity: toPositiveInt(leg.fuelQuantity, 0),
      idempotencyKey: `${operationKey}:item:${index}`,
      fuelIdempotencyKey: `${operationKey}:fuel:${index}`,
      status: "pending",
      fuelStatus: toPositiveInt(leg.fuelQuantity, 0) > 0 ? "pending" : "not-required",
    })),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const persistResult = persistOperation(operation);
  return persistResult && persistResult.success
    ? { success: true, operation }
    : persistResult || {
        success: false,
        errorMsg: "STRUCTURE_DELIVERY_OPERATION_WRITE_FAILED",
      };
}

function executeOperation(operation) {
  const changes = [];
  const movedItemIDs = [];
  for (const leg of operation.legs || []) {
    if (leg.status === "pending") {
      const moveResult = deliveryItemCustody.transferItem({
        item: leg.sourceItem,
        ownerID: leg.destination.ownerID,
        locationID: leg.destination.locationID,
        flagID: leg.destination.flagID,
        actor: operation.actorCharacterID,
        reason: leg.reason,
        idempotencyKey: leg.idempotencyKey,
      });
      if (!moveResult || moveResult.success !== true) {
        if (moveResult && moveResult.ambiguous === true) {
          return { ...moveResult, pending: true, changes, movedItemIDs };
        }
        leg.status = "skipped";
        leg.errorMsg = moveResult && moveResult.errorMsg || "DELIVERY_CUSTODY_FAILED";
        const skipPersistResult = persistOperation(operation);
        if (!skipPersistResult || skipPersistResult.success !== true) {
          return {
            ...(skipPersistResult || {
              success: false,
              errorMsg: "STRUCTURE_DELIVERY_OPERATION_WRITE_FAILED",
            }),
            pending: true,
            changes,
            movedItemIDs,
          };
        }
        continue;
      }
      injectFault("after-item-custody", operation);
      leg.status = "committed";
      changes.push(...cloneValue(moveResult.data && moveResult.data.changes || []));
      const persistResult = persistOperation(operation);
      if (!persistResult || persistResult.success !== true) {
        return {
          ...(persistResult || {
            success: false,
            errorMsg: "STRUCTURE_DELIVERY_OPERATION_WRITE_FAILED",
          }),
          pending: true,
          changes,
          movedItemIDs,
        };
      }
    }

    if (leg.status !== "committed") {
      continue;
    }
    movedItemIDs.push(toPositiveInt(leg.sourceItem && leg.sourceItem.itemID, 0));
    if (leg.fuelStatus === "pending") {
      const fuelResult = structureState.incrementStructureLiquidOzoneIdempotent(
        operation.structureID,
        leg.fuelQuantity,
        leg.fuelIdempotencyKey,
      );
      if (!fuelResult || fuelResult.success !== true) {
        return {
          ...(fuelResult || {
            success: false,
            errorMsg: "STRUCTURE_DELIVERY_FUEL_UPDATE_FAILED",
          }),
          pending: true,
          changes,
          movedItemIDs,
        };
      }
      injectFault("after-fuel-update", operation);
      leg.fuelStatus = "committed";
      const persistResult = persistOperation(operation);
      if (!persistResult || persistResult.success !== true) {
        return {
          ...(persistResult || {
            success: false,
            errorMsg: "STRUCTURE_DELIVERY_OPERATION_WRITE_FAILED",
          }),
          pending: true,
          changes,
          movedItemIDs,
        };
      }
    }
  }

  const notificationContext = operation.notificationContext;
  const deliveredTypeSummary = summarizeDeliveredTypes(operation.legs);
  if (
    notificationContext &&
    operation.notificationStatus !== "committed" &&
    deliveredTypeSummary.length > 0
  ) {
    const notificationResult = createNotification(
      notificationContext.recipientCharacterID,
      {
        typeID: NOTIFICATION_TYPE.STRUCTURE_ITEMS_DELIVERED,
        senderID: notificationContext.senderCharacterID,
        groupID: NOTIFICATION_GROUP.MISC,
        processed: false,
        idempotencyKey: `${operation.operationKey}:notification`,
        data: {
          ...cloneValue(notificationContext.baseData || {}),
          charID: notificationContext.senderCharacterID,
          listOfTypesAndQty: deliveredTypeSummary,
        },
        emitLive: false,
      },
    );
    if (!notificationResult || notificationResult.success !== true) {
      return {
        ...(notificationResult || {
          success: false,
          errorMsg: "STRUCTURE_DELIVERY_NOTIFICATION_FAILED",
        }),
        pending: true,
        changes,
        movedItemIDs,
      };
    }
    const flushResult = database.flushTableSync("notifications");
    if (!flushResult || flushResult.success !== true) {
      return {
        success: false,
        pending: true,
        ambiguous: true,
        errorMsg: flushResult && flushResult.errorMsg || "DELIVERY_NOTIFICATION_FLUSH_FAILED",
        changes,
        movedItemIDs,
      };
    }
    injectFault("after-notification", operation);
    operation.notificationStatus = "committed";
    const persistResult = persistOperation(operation);
    if (!persistResult || persistResult.success !== true) {
      return {
        ...(persistResult || {
          success: false,
          errorMsg: "STRUCTURE_DELIVERY_OPERATION_WRITE_FAILED",
        }),
        pending: true,
        changes,
        movedItemIDs,
      };
    }
  }

  operation.status = "completed";
  const completionResult = persistOperation(operation);
  if (!completionResult || completionResult.success !== true) {
    return {
      ...(completionResult || {
        success: false,
        errorMsg: "STRUCTURE_DELIVERY_OPERATION_WRITE_FAILED",
      }),
      pending: true,
      changes,
      movedItemIDs,
    };
  }
  const retireResult = runtimeState.removeOperationDurable(operation.operationID);
  if (!retireResult || retireResult.success !== true) {
    log.warn(
      `[StructureDelivery] Failed to retire operation ${operation.operationID}: ` +
        `${retireResult && retireResult.errorMsg || "unknown persistence error"}`,
    );
  }
  return {
    success: true,
    changes,
    movedItemIDs: [...new Set(movedItemIDs.filter(Boolean))],
  };
}

function createAndExecuteOperation(input) {
  const createResult = createOperation(input);
  if (!createResult.success) {
    return createResult;
  }
  return executeOperation(createResult.operation);
}

function recoverPendingOperations() {
  const results = [];
  for (const operation of runtimeState.listOperations()) {
    if (operation.status === "completed") {
      runtimeState.removeOperationDurable(operation.operationID);
      continue;
    }
    const result = executeOperation(operation);
    results.push({ operationID: operation.operationID, result });
    if (!result || result.success !== true) {
      log.error(
        `[StructureDelivery] Recovery remains pending for operation ` +
          `${operation.operationID}: ${result && result.errorMsg || "unknown recovery error"}`,
      );
    }
  }
  return results;
}

module.exports = {
  createAndExecuteOperation,
  recoverPendingOperations,
  _testing: {
    setFaultInjector(handler) {
      faultInjector = typeof handler === "function" ? handler : null;
    },
    clearFaultInjector() {
      faultInjector = null;
    },
  },
};
