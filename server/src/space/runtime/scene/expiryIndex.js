"use strict";

const runtimeEntryDirname = require("path").resolve(__dirname, "../..");
const path = require("path");
const commandBurstRuntime = require(path.join(
  runtimeEntryDirname,
  "./modules/commandBurstRuntime",
));
const {
  captureFittedGenericModuleAttributeSnapshots,
  notifyFittedGenericModuleAttributeDiffToSession,
} = require("../attributeChangeNotification");
const {
  isCommandBurstClientSynchronizedModuleItem,
  notifyCommandBurstDbuffStateToSession,
} = require("../commandBurst");
const {
  isReadyForDestiny,
} = require("../destinyDeliveryEligibility");
const {
  isInventoryBackedDynamicEntity,
  isNativeNpcWreckDynamicEntity,
} = require("../inventorySpaceEntity");
const {
  popMinHeapEntry,
  pushMinHeapEntry,
} = require("../minHeap");
const {
  toFiniteNumber,
  toInt,
} = require("../../../common/numbers");

module.exports = {

shouldIndexDynamicEntityExpiry(entity) {
    return Boolean(
      entity &&
      (isInventoryBackedDynamicEntity(entity) || isNativeNpcWreckDynamicEntity(entity)) &&
      toFiniteNumber(entity.expiresAtMs, 0) > 0
    );
  },

indexDynamicEntityExpiry(entity) {
    const entityID = toInt(entity && entity.itemID, 0);
    if (entityID <= 0) {
      return false;
    }

    if (!this.shouldIndexDynamicEntityExpiry(entity)) {
      this.dynamicEntityExpiryByID.delete(entityID);
      return false;
    }

    const expiresAtMs = toFiniteNumber(entity.expiresAtMs, 0);
    if (this.dynamicEntityExpiryByID.get(entityID) === expiresAtMs) {
      return true;
    }
    this.dynamicEntityExpiryByID.set(entityID, expiresAtMs);
    this.pushDynamicEntityExpiryHeap({
      entityID,
      expiresAtMs,
    });
    return true;
  },

unindexDynamicEntityExpiry(entityOrID) {
    const entityID =
      typeof entityOrID === "object"
        ? toInt(entityOrID && entityOrID.itemID, 0)
        : toInt(entityOrID, 0);
    if (entityID <= 0) {
      return false;
    }
    return this.dynamicEntityExpiryByID.delete(entityID);
  },

compareDynamicEntityExpiryEntries(left, right) {
    const leftExpiry = toFiniteNumber(left && left.expiresAtMs, 0);
    const rightExpiry = toFiniteNumber(right && right.expiresAtMs, 0);
    if (leftExpiry !== rightExpiry) {
      return leftExpiry - rightExpiry;
    }
    return toInt(left && left.entityID, 0) - toInt(right && right.entityID, 0);
  },

pushDynamicEntityExpiryHeap(entry) {
    if (!entry || toInt(entry.entityID, 0) <= 0) {
      return false;
    }
    return pushMinHeapEntry(
      this.dynamicEntityExpiryHeap,
      entry,
      (left, right) => this.compareDynamicEntityExpiryEntries(left, right),
    );
  },

popDynamicEntityExpiryHeap() {
    return popMinHeapEntry(
      this.dynamicEntityExpiryHeap,
      (left, right) => this.compareDynamicEntityExpiryEntries(left, right),
    );
  },

peekValidDynamicEntityExpiry() {
    while (this.dynamicEntityExpiryHeap.length > 0) {
      const entry = this.dynamicEntityExpiryHeap[0];
      const entityID = toInt(entry && entry.entityID, 0);
      const expiresAtMs = toFiniteNumber(entry && entry.expiresAtMs, 0);
      const indexedExpiry = this.dynamicEntityExpiryByID.get(entityID);
      const entity = this.dynamicEntities.get(entityID);
      if (
        indexedExpiry !== expiresAtMs ||
        !this.shouldIndexDynamicEntityExpiry(entity)
      ) {
        this.popDynamicEntityExpiryHeap();
        if (!this.shouldIndexDynamicEntityExpiry(entity)) {
          this.dynamicEntityExpiryByID.delete(entityID);
        }
        continue;
      }
      return entry;
    }
    return null;
  },

getCommandBurstExpiryTimeForEntity(entity) {
    if (!entity || toInt(entity.itemID, 0) <= 0) {
      return null;
    }
    const nextExpiryTime = commandBurstRuntime.getNextCommandBurstExpiryTime(entity);
    if (nextExpiryTime === null || nextExpiryTime === undefined) {
      return null;
    }
    const numericExpiryTime = toFiniteNumber(nextExpiryTime, NaN);
    return Number.isFinite(numericExpiryTime) && numericExpiryTime >= 0
      ? numericExpiryTime
      : null;
  },

shouldIndexCommandBurstExpiry(entity) {
    const entityID = toInt(entity && entity.itemID, 0);
    return Boolean(
      entity &&
      entityID > 0 &&
      this.dynamicEntities.get(entityID) === entity &&
      this.getCommandBurstExpiryTimeForEntity(entity) !== null
    );
  },

indexCommandBurstExpiry(entity) {
    const entityID = toInt(entity && entity.itemID, 0);
    if (entityID <= 0) {
      return false;
    }

    const expiresAtMs = this.getCommandBurstExpiryTimeForEntity(entity);
    if (
      expiresAtMs === null ||
      this.dynamicEntities.get(entityID) !== entity
    ) {
      this.commandBurstExpiryByEntityID.delete(entityID);
      return false;
    }

    if (this.commandBurstExpiryByEntityID.get(entityID) === expiresAtMs) {
      return true;
    }
    this.commandBurstExpiryByEntityID.set(entityID, expiresAtMs);
    this.pushCommandBurstExpiryHeap({
      entityID,
      expiresAtMs,
    });
    return true;
  },

unindexCommandBurstExpiry(entityOrID) {
    const entityID =
      typeof entityOrID === "object"
        ? toInt(entityOrID && entityOrID.itemID, 0)
        : toInt(entityOrID, 0);
    if (entityID <= 0) {
      return false;
    }
    return this.commandBurstExpiryByEntityID.delete(entityID);
  },

compareCommandBurstExpiryEntries(left, right) {
    const leftExpiry = toFiniteNumber(left && left.expiresAtMs, 0);
    const rightExpiry = toFiniteNumber(right && right.expiresAtMs, 0);
    if (leftExpiry !== rightExpiry) {
      return leftExpiry - rightExpiry;
    }
    return toInt(left && left.entityID, 0) - toInt(right && right.entityID, 0);
  },

pushCommandBurstExpiryHeap(entry) {
    if (!entry || toInt(entry.entityID, 0) <= 0) {
      return false;
    }
    return pushMinHeapEntry(
      this.commandBurstExpiryHeap,
      entry,
      (left, right) => this.compareCommandBurstExpiryEntries(left, right),
    );
  },

popCommandBurstExpiryHeap() {
    return popMinHeapEntry(
      this.commandBurstExpiryHeap,
      (left, right) => this.compareCommandBurstExpiryEntries(left, right),
    );
  },

peekValidCommandBurstExpiry() {
    while (this.commandBurstExpiryHeap.length > 0) {
      const entry = this.commandBurstExpiryHeap[0];
      const entityID = toInt(entry && entry.entityID, 0);
      const expiresAtMs = toFiniteNumber(entry && entry.expiresAtMs, 0);
      const indexedExpiry = this.commandBurstExpiryByEntityID.get(entityID);
      const entity = this.dynamicEntities.get(entityID);
      const currentExpiry = this.getCommandBurstExpiryTimeForEntity(entity);
      if (
        indexedExpiry !== expiresAtMs ||
        currentExpiry === null ||
        currentExpiry !== expiresAtMs ||
        !this.shouldIndexCommandBurstExpiry(entity)
      ) {
        this.popCommandBurstExpiryHeap();
        if (currentExpiry === null || this.dynamicEntities.get(entityID) !== entity) {
          this.commandBurstExpiryByEntityID.delete(entityID);
        } else if (indexedExpiry !== currentExpiry) {
          this.commandBurstExpiryByEntityID.set(entityID, currentExpiry);
          this.pushCommandBurstExpiryHeap({
            entityID,
            expiresAtMs: currentExpiry,
          });
        }
        continue;
      }
      return entry;
    }
    return null;
  },

pruneExpiredCommandBurstBuffs(now = this.getCurrentSimTimeMs()) {
    const numericNow = toFiniteNumber(now, this.getCurrentSimTimeMs());
    const nextExpiryEntry = this.peekValidCommandBurstExpiry();
    if (
      !nextExpiryEntry ||
      toFiniteNumber(nextExpiryEntry.expiresAtMs, 0) >= numericNow
    ) {
      return [];
    }

    const changedEntityIDs = [];
    while (true) {
      const entry = this.peekValidCommandBurstExpiry();
      if (!entry || toFiniteNumber(entry.expiresAtMs, 0) >= numericNow) {
        break;
      }
      this.popCommandBurstExpiryHeap();
      const entityID = toInt(entry.entityID, 0);
      const entity = this.dynamicEntities.get(entityID);
      if (!this.shouldIndexCommandBurstExpiry(entity)) {
        this.commandBurstExpiryByEntityID.delete(entityID);
        continue;
      }

      const session =
        entity && entity.session && isReadyForDestiny(entity.session)
          ? entity.session
          : null;
      const beforeModuleAttributes = session
        ? captureFittedGenericModuleAttributeSnapshots(entity, {
            session,
            // Timed inputs remain effective through their exact expiry instant.
            // Capture there so a lagged Gameplay tick can still publish the real
            // boosted -> unboosted module delta after pruning at numericNow.
            nowMs: toFiniteNumber(entry.expiresAtMs, numericNow),
            moduleFilter: isCommandBurstClientSynchronizedModuleItem,
          })
        : new Map();
      this.commandBurstExpiryByEntityID.delete(entityID);
      const commandBurstPruneResult = commandBurstRuntime.pruneExpiredCommandBursts(
        entity,
        numericNow,
      );
      this.indexCommandBurstExpiry(entity);

      if (
        commandBurstPruneResult.changed &&
        entity &&
        entity.kind === "ship"
      ) {
        this.refreshShipEntityDerivedState(entity, {
          session: entity.session || null,
          broadcast: true,
          notifyTargeting: true,
          notifyGenericModuleAttributes: false,
        });
      }
      if (
        commandBurstPruneResult.changed &&
        entity &&
        entity.session &&
        isReadyForDestiny(entity.session)
      ) {
        notifyCommandBurstDbuffStateToSession(
          this,
          entity.session,
          entity,
          numericNow,
          {
            reason: "command-burst-expire",
          },
        );
        const afterModuleAttributes = captureFittedGenericModuleAttributeSnapshots(
          entity,
          {
            session: entity.session,
            nowMs: numericNow,
            moduleFilter: isCommandBurstClientSynchronizedModuleItem,
          },
        );
        notifyFittedGenericModuleAttributeDiffToSession(
          entity.session,
          beforeModuleAttributes,
          afterModuleAttributes,
          numericNow,
        );
      }
      if (commandBurstPruneResult.changed) {
        changedEntityIDs.push(entityID);
      }
    }

    return changedEntityIDs;
  },
};
