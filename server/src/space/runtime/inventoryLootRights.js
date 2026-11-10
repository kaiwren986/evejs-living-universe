"use strict";

module.exports = {
  applyInventoryLootInfoToEntity,
  getInventoryLootInfo,
  getInventoryLootInfoInteger,
  getSessionFleetIDForLootRights,
  isInventoryLootAbandoned,
  isOwnerAnNpc,
  markInventoryEntityLootAbandoned,
  persistInventoryLootAbandoned,
  sessionHasInventoryLootRight,
  sessionMayAbandonInventoryLoot,
};

const runtimeEntryDirname = require("path").resolve(__dirname, "..");
const path = require("path");
const log = require(path.join(runtimeEntryDirname, "../utils/logger"));
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
const nativeNpcStore = require(path.join(runtimeEntryDirname, "./npc/nativeNpcStore"));
const {
  parseInventoryCustomInfo,
} = require("./inventoryCustomInfo");
const {
  isInventoryBackedDynamicEntity,
} = require("./inventorySpaceEntity");
const {
  toInt,
} = require("../../common/numbers");
const {
  lazyRequire,
} = require("./runtimeModuleBoundary");

const LOOT_CUSTOM_INFO_KEY = "evejsLoot";

// Whether a wreck/container has been abandoned by its loot-rights holder.
// Persisted in the item's customInfo (mirrors the salvage marker) so the
// relinquished loot rights survive a runtime reload.
function isInventoryLootAbandoned(item) {
  const parsed = parseInventoryCustomInfo(item);
  return Boolean(
    parsed && parsed[LOOT_CUSTOM_INFO_KEY] && parsed[LOOT_CUSTOM_INFO_KEY].abandoned,
  );
}

function getInventoryLootInfo(item) {
  const parsed = parseInventoryCustomInfo(item);
  return parsed &&
    parsed[LOOT_CUSTOM_INFO_KEY] &&
    typeof parsed[LOOT_CUSTOM_INFO_KEY] === "object"
    ? parsed[LOOT_CUSTOM_INFO_KEY]
    : {};
}

function getInventoryLootInfoInteger(item, key) {
  const info = getInventoryLootInfo(item);
  const value = toInt(info && info[key], 0);
  return value > 0 ? value : 0;
}

function applyInventoryLootInfoToEntity(entity, item) {
  if (!entity || !item) {
    return entity;
  }

  const lootInfo = getInventoryLootInfo(item);
  const corporationID = getInventoryLootInfoInteger(item, "corporationID");
  const lootRightCorpID =
    getInventoryLootInfoInteger(item, "lootRightCorpID") || corporationID;
  const allianceID = getInventoryLootInfoInteger(item, "allianceID");
  const warFactionID = getInventoryLootInfoInteger(item, "warFactionID");
  const lootRightFleetID = getInventoryLootInfoInteger(item, "lootRightFleetID");
  const lootRightsSnapshotVersion = getInventoryLootInfoInteger(
    item,
    "rightsSnapshotVersion",
  );
  const protectedPropertyCorporationID = getInventoryLootInfoInteger(
    item,
    "protectedPropertyCorporationID",
  );
  const protectedPropertyCorporationMarkerPresent =
    Object.prototype.hasOwnProperty.call(
      lootInfo,
      "protectedPropertyCorporationID",
    );

  if (corporationID > 0) {
    entity.corporationID = corporationID;
  }
  if (lootRightCorpID > 0) {
    entity.lootRightCorpID = lootRightCorpID;
  }
  if (allianceID > 0) {
    entity.allianceID = allianceID;
  }
  if (warFactionID > 0) {
    entity.warFactionID = warFactionID;
  }
  entity.lootRightFleetID = lootRightFleetID > 0 ? lootRightFleetID : null;
  entity.lootRightsSnapshotVersion = lootRightsSnapshotVersion;
  entity.protectedPropertyCorporationID =
    protectedPropertyCorporationID > 0 &&
    protectedPropertyCorporationID === toInt(item.ownerID, 0)
      ? protectedPropertyCorporationID
      : null;
  entity.protectedPropertyCorporationMarkerPresent =
    protectedPropertyCorporationMarkerPresent;
  entity.lootAbandoned = isInventoryLootAbandoned(item);
  return entity;
}

function isOwnerAnNpc(ownerID) {
  const normalizedOwnerID = toInt(ownerID, 0);
  if (normalizedOwnerID <= 0) {
    return false;
  }
  try {
    const { isNpcOwner } = lazyRequire("../services/character/standingRuntime");
    return typeof isNpcOwner === "function"
      ? Boolean(isNpcOwner(normalizedOwnerID))
      : false;
  } catch (_) {
    // ignored: no standing runtime here; the owner is not known to be an NPC (false)
    return false;
  }
}

function getSessionFleetIDForLootRights(session) {
  const directFleetID = toInt(session && (session.fleetid || session.fleetID), 0);
  if (directFleetID > 0) {
    return directFleetID;
  }

  const characterID = toInt(session && (session.characterID || session.charid), 0);
  if (characterID <= 0) {
    return 0;
  }

  try {
    const fleetRuntime = lazyRequire("../services/fleets/fleetRuntime");
    if (fleetRuntime && typeof fleetRuntime.getSessionFleetState === "function") {
      const state = fleetRuntime.getSessionFleetState(session);
      const stateFleetID = toInt(state && state.fleetid, 0);
      if (stateFleetID > 0) {
        return stateFleetID;
      }
    }
    if (fleetRuntime && typeof fleetRuntime.getFleetForCharacter === "function") {
      const fleet = fleetRuntime.getFleetForCharacter(characterID);
      const runtimeFleetID = toInt(fleet && fleet.fleetID, 0);
      if (runtimeFleetID > 0) {
        return runtimeFleetID;
      }
    }
    return toInt(
      fleetRuntime &&
      fleetRuntime.runtimeState &&
      fleetRuntime.runtimeState.characterToFleet instanceof Map
        ? fleetRuntime.runtimeState.characterToFleet.get(characterID)
        : 0,
      0,
    );
  } catch (_) {
    // ignored: no readable fleet state means no fleet (0)
    return 0;
  }
}

// Tractor beams use the same entitlement rule as manual takes, whole-container
// scoops, and MTUs. Project the live entity back into the shared descriptor
// shape instead of maintaining another copy of corporation/fleet/public rules.
function sessionHasInventoryLootRight(session, entity) {
  if (!entity || (entity.kind !== "wreck" && entity.kind !== "container")) {
    return false;
  }
  try {
    const entitlement = lazyRequire(
      "../services/_shared/spaceLootEntitlement",
    );
    if (
      !entitlement ||
      typeof entitlement.sessionHasSpaceLootRight !== "function"
    ) {
      return false;
    }
    return Boolean(entitlement.sessionHasSpaceLootRight(session, {
      itemID: toInt(entity.itemID, 0),
      ownerID: toInt(entity.ownerID, 0),
      locationID: toInt(entity.systemID ?? entity.locationID, 0),
      lootInfo: {
        rightsSnapshotVersion: toInt(
          entity.lootRightsSnapshotVersion,
          0,
        ),
        abandoned: entity.lootAbandoned === true,
        corporationID: toInt(entity.corporationID, 0),
        lootRightCorpID: toInt(entity.lootRightCorpID, 0),
        lootRightFleetID: toInt(entity.lootRightFleetID, 0) || null,
        ...(
          entity.protectedPropertyCorporationMarkerPresent === true ||
          toInt(entity.protectedPropertyCorporationID, 0) > 0
            ? {
              protectedPropertyCorporationID: toInt(
                entity.protectedPropertyCorporationID,
                0,
              ),
            }
            : {}
        ),
      },
    }));
  } catch (_) {
    // ignored: loot rights are a grant. An unavailable shared authority must not let a
    // tractor move somebody else's property.
    return false;
  }
}

// Taking from shared corporation/fleet loot is not authority to relinquish the
// owner's rights for everyone. Only the character owner may abandon
// player-owned property; NPC-owned debris is already free-for-all.
function sessionMayAbandonInventoryLoot(session, entity) {
  if (!entity || (entity.kind !== "wreck" && entity.kind !== "container")) {
    return false;
  }
  const characterID = toInt(
    session && (session.characterID || session.charid),
    0,
  );
  const ownerID = toInt(entity.ownerID, 0);
  const protectedPropertyCorporationID = toInt(
    entity.protectedPropertyCorporationID,
    0,
  );
  if (
    entity.protectedPropertyCorporationMarkerPresent === true ||
    (
      protectedPropertyCorporationID > 0 &&
      protectedPropertyCorporationID === ownerID
    )
  ) {
    return false;
  }
  return Boolean(
    (characterID > 0 && ownerID > 0 && characterID === ownerID) ||
    isOwnerAnNpc(ownerID),
  );
}

function persistInventoryLootAbandoned(itemID) {
  let updateResult = null;
  try {
    updateResult = updateInventoryItem(itemID, (currentItem) => {
      const parsed = parseInventoryCustomInfo(currentItem);
      parsed[LOOT_CUSTOM_INFO_KEY] = {
        ...(parsed[LOOT_CUSTOM_INFO_KEY] || {}),
        abandoned: true,
      };
      return {
        ...currentItem,
        customInfo: JSON.stringify(parsed),
      };
    });
  } catch (error) {
    return {
      success: false,
      errorMsg:
        String(error && error.message || "").trim() ||
        "INVENTORY_LOOT_ABANDON_WRITE_FAILED",
    };
  }
  if (!updateResult || updateResult.success !== true) {
    return {
      success: false,
      errorMsg:
        updateResult && updateResult.errorMsg ||
        "INVENTORY_LOOT_ABANDON_WRITE_FAILED",
    };
  }

  let flushResult = null;
  try {
    flushResult = lazyRequire("../gameStore").flushTableSync("items");
  } catch (error) {
    flushResult = {
      success: false,
      errorMsg:
        String(error && error.message || "").trim() ||
        "INVENTORY_LOOT_ABANDON_FLUSH_FAILED",
    };
  }
  if (flushResult && flushResult.success === true) {
    return {
      success: true,
      errorMsg: null,
      data: updateResult.data || null,
    };
  }

  // A failed durability boundary leaves the staged item row in the in-memory
  // inventory projection. Restore and synchronously persist the previous row
  // before returning failure so neither broker nor MTU authority sees the
  // abandoned marker while the live ball remains owned.
  let rollbackUpdateResult = null;
  let rollbackFlushResult = null;
  try {
    rollbackUpdateResult = updateInventoryItem(
      itemID,
      updateResult.previousData,
    );
    if (rollbackUpdateResult && rollbackUpdateResult.success === true) {
      rollbackFlushResult = lazyRequire("../gameStore").flushTableSync("items");
    }
  } catch (_error) {
    rollbackUpdateResult = rollbackUpdateResult || { success: false };
    rollbackFlushResult = rollbackFlushResult || { success: false };
  }
  return {
    success: false,
    errorMsg:
      flushResult && flushResult.errorMsg ||
      "INVENTORY_LOOT_ABANDON_FLUSH_FAILED",
    rollbackSuccess: Boolean(
      rollbackUpdateResult &&
      rollbackUpdateResult.success === true &&
      rollbackFlushResult &&
      rollbackFlushResult.success === true
    ),
  };
}

// Flip a wreck/container to abandoned and persist the marker. Returns true when
// the entity transitioned (so the caller knows to broadcast the slim change).
function markInventoryEntityLootAbandoned(entity) {
  if (!entity || entity.lootAbandoned === true) {
    return false;
  }

  if (entity.nativeNpcWreck === true) {
    let result = null;
    try {
      result = nativeNpcStore.setNativeWreckLootAbandoned(
        entity.itemID,
        true,
      );
    } catch (error) {
      log.warn(
        `[SpaceRuntime] Failed to persist abandoned loot marker for native wreck ${entity.itemID}: ${error.message}`,
      );
      return false;
    }
    if (!result || result.success !== true) {
      log.warn(
        `[SpaceRuntime] Failed to persist abandoned loot marker for native wreck ${entity.itemID}: ${
          result && result.errorMsg || "UNKNOWN_ERROR"
        }`,
      );
      return false;
    }
    entity.lootAbandoned = true;
    return true;
  }

  if (isInventoryBackedDynamicEntity(entity)) {
    const result = persistInventoryLootAbandoned(entity.itemID);
    if (!result || result.success !== true) {
      log.warn(
        `[SpaceRuntime] Failed to persist abandoned loot marker for ${entity.kind} ${entity.itemID}: ${
          result && result.errorMsg || "UNKNOWN_ERROR"
        } rollback=${result && result.rollbackSuccess === true}`,
      );
      return false;
    }
  }

  entity.lootAbandoned = true;
  return true;
}

Object.assign(module.exports, {
  LOOT_CUSTOM_INFO_KEY,
});
