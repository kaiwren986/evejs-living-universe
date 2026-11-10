"use strict";

const path = require("path");

const log = require(path.join(__dirname, "../../utils/logger"));
const {
  ITEM_FLAGS,
  createSpaceItemForOwner,
  createSpaceItemForOwnerIdempotent,
  findItemById,
  grantItemToOwnerLocation,
  grantItemToOwnerLocationIdempotent,
  listContainerItems,
  updateInventoryItem,
  updateInventoryItemsAtomic,
} = require(path.join(__dirname, "../inventory/itemStore"));
const {
  resolveItemByTypeID,
} = require(path.join(__dirname, "../inventory/itemTypeRegistry"));
const {
  resolveLocationDeathOutcome,
} = require(path.join(__dirname, "../killmail/deathOutcomeResolver"));
const structureWreckState = require(path.join(
  __dirname,
  "./structureWreckState",
));
const {
  buildStructureScatterPosition,
  getStructureSpaceDirection,
} = require(path.join(__dirname, "./structureSpaceInterop"));

const DROP_CONTAINER_TYPE_ID = 10167;

function toPositiveInt(value, fallback = 0) {
  const numeric = Math.trunc(Number(value) || 0);
  return numeric > 0 ? numeric : fallback;
}

function buildStructureLootContainerName(structure, options = {}) {
  const structureName = String(
    (structure && (structure.itemName || structure.name)) ||
      `Structure ${toPositiveInt(structure && structure.structureID, 0)}`,
  );
  const label = String(options.label || "Loot").trim();
  return `${structureName} ${label}`.trim();
}

function createStructureLootContainer(structure, index, options = {}) {
  const containerType = resolveItemByTypeID(DROP_CONTAINER_TYPE_ID);
  if (!containerType) {
    return {
      success: false,
      errorMsg: "DROP_CONTAINER_TYPE_NOT_FOUND",
    };
  }

  const ownerID = structureWreckState.resolveStructureLootOwnerID(structure);
  const solarSystemID = toPositiveInt(structure && structure.solarSystemID, 0);
  const position = buildStructureScatterPosition(structure, index, options);
  const direction = getStructureSpaceDirection(structure);
  const desiredName = buildStructureLootContainerName(structure, {
    label: options.label || "Container",
  });
  const create = options.destructionKey ? createSpaceItemForOwnerIdempotent : createSpaceItemForOwner;
  const createResult = structureWreckState.resolveStructureSpaceCreateResult(create(ownerID, solarSystemID, containerType, {
    ...(options.destructionKey ? {
      receiptKey: `${options.destructionKey}:container`,
      fingerprint: { structureID: structure.structureID, ownerID, solarSystemID, typeID: containerType.typeID },
    } : {}),
    itemName: buildStructureLootContainerName(structure, {
      label: options.label || "Container",
    }),
    position,
    direction,
    targetPoint: position,
    createdAtMs: options.nowMs ?? Date.now(),
    launcherID: toPositiveInt(structure && structure.structureID, 0),
    customInfo:
      structureWreckState.buildStructureDestructionLootCustomInfo(structure),
  }), options.destructionKey ? { typeID: containerType.typeID } : null);
  if (!createResult.success || !createResult.data) {
    return createResult;
  }

  const renameResult = updateInventoryItem(createResult.data.itemID, (currentItem) => ({
    ...currentItem,
    itemName: desiredName,
  }));
  if (!renameResult.success) {
    return renameResult;
  }

  const containerRecord = findItemById(createResult.data.itemID);
  return {
    success: true,
    data: containerRecord || createResult.data,
  };
}

function addQuantumCoreToDropLocation(structure, dropLocationID, options = {}) {
  if (!structure || structure.hasQuantumCore !== true) {
    return {
      success: true,
      data: {
        dropped: false,
      },
    };
  }

  const coreTypeID = toPositiveInt(structure.quantumCoreItemTypeID, 0);
  const coreType = resolveItemByTypeID(coreTypeID);
  if (!coreType) {
    return {
      success: false,
      errorMsg: "QUANTUM_CORE_TYPE_NOT_FOUND",
    };
  }

  const ownerID = structureWreckState.resolveStructureLootOwnerID(structure);
  const grant = options.destructionKey ? grantItemToOwnerLocationIdempotent : grantItemToOwnerLocation;
  const grantResult = grant(
    ownerID,
    dropLocationID,
    ITEM_FLAGS.HANGAR,
    coreType,
    1,
    {
      ...(options.destructionKey ? { receiptKey: `${options.destructionKey}:core` } : {}),
      itemName: coreType.name,
      singleton: 1,
    },
  );
  if (!grantResult.success) {
    return grantResult;
  }

  return {
    success: true,
    data: {
      dropped: true,
      typeID: coreType.typeID,
      name: coreType.name,
    },
  };
}

function getCorporationOfficesAtStation(stationID) {
  const corporationRuntimeState = require(path.join(
    __dirname,
    "../corporation/corporationRuntimeState",
  ));
  return typeof corporationRuntimeState.getOfficesAtStation === "function"
    ? corporationRuntimeState.getOfficesAtStation(stationID)
    : [];
}

function stageCorporationOfficeItemsForDestruction(structureID) {
  const numericStructureID = toPositiveInt(structureID, 0);
  const offices = numericStructureID > 0
    ? getCorporationOfficesAtStation(numericStructureID)
    : [];
  const itemIDs = new Set();
  for (const office of offices) {
    const corporationID = toPositiveInt(office && office.corporationID, 0);
    if (!corporationID) {
      continue;
    }
    const officeLocationIDs = [
      office.officeID,
      office.officeFolderID,
      office.itemID,
    ]
      .map((locationID) => toPositiveInt(locationID, 0))
      .filter(Boolean);
    for (const officeLocationID of officeLocationIDs) {
      for (const item of listContainerItems(corporationID, officeLocationID, null)) {
        if (toPositiveInt(item && item.locationID, 0) === officeLocationID) {
          itemIDs.add(toPositiveInt(item && item.itemID, 0));
        }
      }
    }
  }

  const stagedItemIDs = [...itemIDs].filter(Boolean).sort((left, right) => left - right);
  if (stagedItemIDs.length === 0) {
    return { success: true, offices, stagedItemIDs: [] };
  }
  const updateResult = updateInventoryItemsAtomic(
    stagedItemIDs,
    (item) => ({
      ...item,
      locationID: numericStructureID,
    }),
  );
  if (!updateResult.success) {
    return updateResult;
  }
  return { success: true, offices, stagedItemIDs };
}

function handleStructureDestroyedLoot(structure, options = {}) {
  const includeContents = options.includeStructureContents === true;
  const includeQuantumCore = options.includeQuantumCore !== false;
  const structureID = toPositiveInt(structure && structure.structureID, 0);
  const solarSystemID = toPositiveInt(structure && structure.solarSystemID, 0);
  if (!structureID || !solarSystemID) {
    return {
      success: false,
      errorMsg: "STRUCTURE_NOT_FOUND",
    };
  }

  const officeStageResult = includeContents
    ? stageCorporationOfficeItemsForDestruction(structureID)
    : { success: true, offices: [], stagedItemIDs: [] };
  if (!officeStageResult.success) {
    return officeStageResult;
  }

  const containers = [];
  let wreck = null;
  const resolvedWreckType = structureWreckState.resolveStructureWreckType(structure);
  const topLevelContents = includeContents
    ? listContainerItems(null, structureID, null)
        .filter((item) => toPositiveInt(item && item.locationID, 0) === structureID)
    : [];
  const killmailItems = [];
  const needsDropLocation = Boolean(resolvedWreckType) || topLevelContents.length > 0 || (
    includeQuantumCore &&
    structure &&
    structure.hasQuantumCore === true
  );

  if (!needsDropLocation) {
    return {
      success: true,
      data: {
        containers,
        wreck,
        spawnItemIDs: [],
      },
    };
  }

  let dropLocationResult = structureWreckState.createStructureWreck(
    structure,
    {
      nowMs: options.nowMs,
      destructionKey: options.destructionKey,
    },
  );
  let dropKind = "wreck";
  // A keyed creation may already have committed its item before a flush
  // failed. Retry that receipt instead of creating a second output kind.
  if (options.destructionKey && resolvedWreckType && !dropLocationResult.success)
    return dropLocationResult;
  if (!dropLocationResult.success || !dropLocationResult.data) {
    dropKind = "container";
    dropLocationResult = createStructureLootContainer(structure, 0, {
      label:
        includeContents === true
          ? "Destroyed Structure Container"
          : "Quantum Core Container",
      nowMs: options.nowMs,
      destructionKey: options.destructionKey,
    });
  }
  if (!dropLocationResult.success || !dropLocationResult.data) {
    return dropLocationResult;
  }

  const dropLocation = dropLocationResult.data;
  if (dropLocation.missing && (topLevelContents.length || structure.hasQuantumCore === true))
    return { success: false, errorMsg: "STRUCTURE_LOOT_DESTINATION_GONE" };
  let deathOutcome = {
    items: [],
    movedChanges: [],
    destroyChanges: [],
  };
  if (includeContents && topLevelContents.length > 0) {
    const deathOutcomeResult = resolveLocationDeathOutcome(structureID, {
      rootLootLocationID: dropLocation.itemID,
      seed: `structure:${structureID}:${String(options.nowMs || Date.now())}`,
      forceAllDropped: true,
    });
    if (!deathOutcomeResult.success || !deathOutcomeResult.data) {
      return deathOutcomeResult;
    }
    deathOutcome = deathOutcomeResult.data;
  }
  if (Array.isArray(deathOutcome.items)) {
    killmailItems.push(...deathOutcome.items);
  }
  const quantumCoreResult = includeQuantumCore
    ? addQuantumCoreToDropLocation(structure, dropLocation.itemID, options)
    : { success: true, data: { dropped: false } };
  if (!quantumCoreResult.success) {
    log.warn(
      `[StructureDestructionLoot] Failed to create quantum-core drop for structure ${structureID}: ${quantumCoreResult.errorMsg}`,
    );
  }

  if (
    quantumCoreResult.success &&
    quantumCoreResult.data &&
    quantumCoreResult.data.dropped === true &&
    toPositiveInt(quantumCoreResult.data.typeID, 0) > 0
  ) {
    killmailItems.push({
      typeID: toPositiveInt(quantumCoreResult.data.typeID, 0),
      flag: ITEM_FLAGS.HANGAR,
      singleton: 1,
      qtyDropped: 1,
      qtyDestroyed: 0,
      contents: [],
    });
  }
  const movedItemIDs = listContainerItems(null, dropLocation.itemID, null)
    .filter((item) => toPositiveInt(item && item.locationID, 0) === dropLocation.itemID)
    .map((item) => toPositiveInt(item && item.itemID, 0))
    .filter(Boolean)
    .sort((left, right) => left - right);

  if (dropKind === "wreck") {
    wreck = {
      itemID: dropLocation.itemID,
      typeID: toPositiveInt(dropLocation.typeID, 0),
      movedItemIDs,
      quantumCore:
        quantumCoreResult.success && quantumCoreResult.data
          ? quantumCoreResult.data
          : {
              dropped: false,
            },
    };
  } else {
    containers.push({
      containerID: dropLocation.itemID,
      movedItemIDs,
      quantumCore:
        quantumCoreResult.success && quantumCoreResult.data
          ? quantumCoreResult.data
          : {
              dropped: false,
            },
    });
  }

  return {
    success: true,
    data: {
      wreck,
      containers,
      lootOutcome: {
        items: killmailItems,
        movedChanges: Array.isArray(deathOutcome.movedChanges)
          ? deathOutcome.movedChanges
          : [],
        destroyChanges: Array.isArray(deathOutcome.destroyChanges)
          ? deathOutcome.destroyChanges
          : [],
        assetSafetyItems: [],
      },
      stagedCorporationOfficeItemIDs: officeStageResult.stagedItemIDs,
      corporationOffices: officeStageResult.offices,
      spawnItemIDs: [dropLocation.itemID],
    },
  };
}

module.exports = {
  createStructureLootContainer,
  handleStructureDestroyedLoot,
};
