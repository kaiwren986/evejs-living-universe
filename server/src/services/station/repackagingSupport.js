"use strict";

const path = require("path");

const log = require(path.join(__dirname, "../../utils/logger"));
const {
  extractDictEntries,
  extractList,
  currentFileTime,
  normalizeNumber,
  normalizeText,
  unwrapMarshalValue,
} = require(path.join(__dirname, "../_shared/serviceHelpers"));
const { throwWrappedUserError } = require(path.join(__dirname, "../../common/machoErrors"));
const {
  ITEM_FLAGS,
  SHIP_CATEGORY_ID,
  findItemById,
  getActiveShipItem,
  listContainerItems,
  moveItemsAndSetShipPackagingState,
  setItemPackagingState,
  setShipPackagingState,
  updateInventoryItem,
} = require(path.join(__dirname, "../inventory/itemStore"));
const {
  CARGO_CONTAINER_FAMILY,
  GROUP_AUDIT_LOG_SECURE_CONTAINER,
  getCargoContainerFamily,
  isCargoContainerType,
} = require(path.join(__dirname, "../ship/cargoContainerRuntime"));
const {
  getCorporationOfficeByInventoryID,
  getCorporationOffices,
  getLockedItemsByLocation,
} = require(path.join(__dirname, "../corporation/corporationRuntimeState"));
const {
  BLUEPRINT_CATEGORY_ID,
  CORP_HANGAR_FLAGS,
  CORP_HANGAR_QUERY_ROLE_BY_FLAG,
  CORP_HANGAR_TAKE_ROLE_BY_FLAG,
} = require(path.join(__dirname, "../industry/industryConstants"));
const {
  getSessionCorporationID,
  rolesAtLocation,
} = require(path.join(__dirname, "../industry/industryAccess"));
const {
  getDockedLocationID,
} = require(path.join(__dirname, "../structure/structureLocation"));
const {
  emitFittingTransactionForSession,
  syncInventoryItemForSession,
} = require(path.join(__dirname, "../character/characterState"));
const {
  fanCorporationOfficeInventoryChanges,
} = require(path.join(__dirname, "../inventory/corporationOfficeInventoryObservers"));
const {
  SLOT_FAMILY_FLAGS,
  isStrategicCruiserType,
} = require(path.join(__dirname, "../fitting/liveFittingState"));
const {
  refreshShipFittingSnapshot,
} = require(path.join(__dirname, "../../_secondary/fitting/fittingRuntime"));

const AUDIT_LOG_ACTION_REPACKAGE = 2;
const AUDIT_LOG_RETENTION_TICKS = 21n * 24n * 60n * 60n * 10000000n;
const AUDIT_LOG_MAX_ENTRIES = 10000;
const CORP_ROLE_DIRECTOR = 1n;
const CORP_ROLE_EQUIPMENT_CONFIG = 2199023255552n;
const CORP_CONTAINER_TAKE_ROLE_BY_FLAG = Object.freeze(
  Object.fromEntries(
    CORP_HANGAR_FLAGS.map((flagID, index) => [
      flagID,
      1n << BigInt(42 + index),
    ]),
  ),
);

function isAuditLogSecureContainer(item) {
  return (
    normalizeNumber(item && item.groupID, 0) ===
    GROUP_AUDIT_LOG_SECURE_CONTAINER
  );
}

function getRecentAuditLogEntries(item, nowFiletime = currentFileTime()) {
  const state =
    item &&
    item.secureContainerState &&
    typeof item.secureContainerState === "object" &&
    !Array.isArray(item.secureContainerState)
      ? item.secureContainerState
      : {};
  const cutoff = nowFiletime - AUDIT_LOG_RETENTION_TICKS;
  return (Array.isArray(state.auditLog) ? state.auditLog : []).filter((entry) => {
    try {
      return BigInt(String(entry && entry.logDate || "0")) >= cutoff;
    } catch (error) {
      // ignored: an audit entry with an unreadable date is not retained (false)
      return false;
    }
  });
}

function recordBlockedAuditContainerRepackage(item, characterID, stationID) {
  const nowFiletime = currentFileTime();
  return updateInventoryItem(item.itemID, (currentItem) => {
    const state =
      currentItem.secureContainerState &&
      typeof currentItem.secureContainerState === "object" &&
      !Array.isArray(currentItem.secureContainerState)
        ? currentItem.secureContainerState
        : {};
    const auditLog = getRecentAuditLogEntries(currentItem, nowFiletime);
    const highestLogID = auditLog.reduce(
      (highest, entry) =>
        Math.max(highest, normalizeNumber(entry && entry.logID, 0)),
      0,
    );
    const nextAuditLogID = Math.max(
      highestLogID + 1,
      normalizeNumber(state.nextAuditLogID, 1),
      1,
    );
    auditLog.push({
      logID: nextAuditLogID,
      inventoryMgrLocationID: stationID,
      locationID: normalizeNumber(currentItem.locationID, stationID),
      flagID: normalizeNumber(currentItem.flagID, ITEM_FLAGS.HANGAR),
      actionID: AUDIT_LOG_ACTION_REPACKAGE,
      arg1: 0,
      arg2: 0,
      logDate: nowFiletime.toString(),
      actorID: characterID,
      status: false,
    });
    return {
      ...currentItem,
      secureContainerState: {
        ...state,
        auditLog: auditLog.slice(-AUDIT_LOG_MAX_ENTRIES),
        nextAuditLogID: nextAuditLogID + 1,
      },
    };
  });
}

function extractTupleValues(value) {
  if (Array.isArray(value)) {
    return value;
  }

  if (value && value.type === "tuple" && Array.isArray(value.items)) {
    return value.items;
  }

  if (value && value.type === "list" && Array.isArray(value.items)) {
    return value.items;
  }

  return [];
}

function extractRepackageRequests(rawValue) {
  const requests = [];
  for (const [stationKey, shipList] of extractDictEntries(rawValue)) {
    const stationID = normalizeNumber(stationKey, 0);
    for (const tupleValue of extractList(shipList)) {
      const tupleItems = extractTupleValues(tupleValue);
      const itemID = normalizeNumber(tupleItems[0], 0);
      const itemStationID = normalizeNumber(tupleItems[1], stationID);
      if (itemID > 0 && itemStationID > 0) {
        requests.push({
          itemID,
          stationID: itemStationID,
        });
      }
    }
  }

  return requests;
}

function getCorporationOfficeForLocator(
  corporationID,
  locatorID,
  lookupContext = null,
) {
  const numericCorporationID = normalizeNumber(corporationID, 0);
  const numericLocatorID = normalizeNumber(locatorID, 0);
  if (numericCorporationID <= 0 || numericLocatorID <= 0) {
    return null;
  }

  const cacheKey = `${numericCorporationID}:${numericLocatorID}`;
  const officeCache = lookupContext && lookupContext.officeByLocator;
  if (officeCache instanceof Map && officeCache.has(cacheKey)) {
    return officeCache.get(cacheKey);
  }

  const directOffice = getCorporationOfficeByInventoryID(
    numericCorporationID,
    numericLocatorID,
  );
  if (directOffice) {
    if (officeCache instanceof Map) {
      officeCache.set(cacheKey, directOffice);
    }
    return directOffice;
  }

  const stationMatches = getCorporationOffices(numericCorporationID).filter(
    (office) => normalizeNumber(office && office.stationID, 0) === numericLocatorID,
  );
  const resolvedOffice = stationMatches.length === 1 ? stationMatches[0] : null;
  if (officeCache instanceof Map) {
    officeCache.set(cacheKey, resolvedOffice);
  }
  return resolvedOffice;
}

function getLockedItemIDsAtLocation(
  corporationID,
  locationID,
  lookupContext = null,
) {
  const numericCorporationID = normalizeNumber(corporationID, 0);
  const numericLocationID = normalizeNumber(locationID, 0);
  if (numericCorporationID <= 0 || numericLocationID <= 0) {
    return new Set();
  }

  const cacheKey = `${numericCorporationID}:${numericLocationID}`;
  const lockCache = lookupContext && lookupContext.lockedItemIDsByLocation;
  if (lockCache instanceof Map && lockCache.has(cacheKey)) {
    return lockCache.get(cacheKey);
  }

  const itemIDs = new Set(
    getLockedItemsByLocation(numericCorporationID, numericLocationID)
      .map((entry) => normalizeNumber(entry && entry.itemID, 0))
      .filter((itemID) => itemID > 0),
  );
  if (lockCache instanceof Map) {
    lockCache.set(cacheKey, itemIDs);
  }
  return itemIDs;
}

function isSameCorporationOffice(leftOffice, rightOffice) {
  if (!leftOffice || !rightOffice) {
    return false;
  }
  if (
    normalizeNumber(leftOffice.corporationID, 0) !==
      normalizeNumber(rightOffice.corporationID, 0) ||
    normalizeNumber(leftOffice.stationID, 0) !==
      normalizeNumber(rightOffice.stationID, 0)
  ) {
    return false;
  }

  return ["officeID", "officeFolderID", "itemID"].some((key) => {
    const leftID = normalizeNumber(leftOffice[key], 0);
    return leftID > 0 && leftID === normalizeNumber(rightOffice[key], 0);
  });
}

function hasPositiveStateValue(state, key) {
  const value = Number(state && state[key]);
  return Number.isFinite(value) && value > 0;
}

function getUnsafeCorporationRepackageState(
  item,
  {
    resetsContainerState = false,
  } = {},
) {
  const moduleState =
    item && item.moduleState && typeof item.moduleState === "object"
      ? item.moduleState
      : null;
  if (
    hasPositiveStateValue(moduleState, "damage") ||
    hasPositiveStateValue(moduleState, "armorDamage") ||
    Boolean(moduleState && moduleState.incapacitated)
  ) {
    return "module is damaged";
  }
  if (
    moduleState &&
    [
      "serviceFuelOnlineAt",
      "serviceFuelLastCycleAt",
      "serviceFuelNextCycleAt",
    ].some((key) => moduleState[key] !== null && moduleState[key] !== undefined)
  ) {
    return "module has active service state";
  }

  const conditionState =
    item && item.conditionState && typeof item.conditionState === "object"
      ? item.conditionState
      : null;
  if (
    hasPositiveStateValue(conditionState, "damage") ||
    hasPositiveStateValue(conditionState, "armorDamage") ||
    (
      conditionState &&
      Number.isFinite(Number(conditionState.shieldCharge)) &&
      Number(conditionState.shieldCharge) < 1
    ) ||
    Boolean(conditionState && conditionState.incapacitated)
  ) {
    return "item is damaged";
  }
  if (
    normalizeNumber(item && item.launcherID, 0) > 0 ||
    (item && item.spaceState && typeof item.spaceState === "object") ||
    Number(item && item.spaceRadius) > 0
  ) {
    return "item still has deployed runtime state";
  }
  for (const key of [
    "fighterState",
    "mobileDepotState",
    "shipConfiguration",
    "dunRotation",
  ]) {
    if (item && item[key] && typeof item[key] === "object") {
      return `item has unsupported ${key}`;
    }
  }
  if (
    !resetsContainerState &&
    normalizeText(item && item.customInfo, "") !== ""
  ) {
    return "item has custom per-instance data";
  }
  if (
    item &&
    item.clientCustomInfo !== null &&
    item.clientCustomInfo !== undefined
  ) {
    return "item has client-specific per-instance data";
  }
  if (item && item.expiresAtMs !== null && item.expiresAtMs !== undefined) {
    return "item has an expiry state";
  }

  return "";
}

function getCorporationHangarRepackageAccess(
  session,
  request,
  item,
  dockedLocationID,
  lookupContext = null,
) {
  const corporationID = getSessionCorporationID(session);
  if (
    corporationID <= 0 ||
    normalizeNumber(item && item.ownerID, 0) !== corporationID
  ) {
    return { allowed: false, reason: "item is not owned by the session corporation" };
  }

  const isCorporationShip =
    normalizeNumber(item && item.categoryID, 0) === SHIP_CATEGORY_ID;
  if (isCorporationShip) {
    // Ship cosmetics, logo fittings, and cached configuration are keyed by the
    // singleton item ID. Do not make corporation ships stackable until those
    // external records can be cleared in the same transaction.
    return { allowed: false, reason: "corporation ship repackaging is not supported" };
  }
  if (normalizeNumber(item && item.categoryID, 0) === BLUEPRINT_CATEGORY_ID) {
    return { allowed: false, reason: "corporation blueprint repackaging is not supported" };
  }
  const isCorporationContainer = isCargoContainerType(item);
  const unsafeState = getUnsafeCorporationRepackageState(item, {
    resetsContainerState: isCorporationContainer,
  });
  if (unsafeState) {
    return { allowed: false, reason: unsafeState };
  }

  const flagID = normalizeNumber(item && item.flagID, 0);
  if (!CORP_HANGAR_FLAGS.includes(flagID)) {
    return { allowed: false, reason: `flag ${flagID} is not a corporation division` };
  }

  const itemOffice = getCorporationOfficeForLocator(
    corporationID,
    item && item.locationID,
    lookupContext,
  );
  const requestOffice = getCorporationOfficeForLocator(
    corporationID,
    request && request.stationID,
    lookupContext,
  );
  if (!isSameCorporationOffice(itemOffice, requestOffice)) {
    return { allowed: false, reason: "request and item do not resolve to the same office" };
  }
  if (Boolean(itemOffice.impounded)) {
    return { allowed: false, reason: "corporation office is impounded" };
  }
  if (normalizeNumber(itemOffice.stationID, 0) !== dockedLocationID) {
    return { allowed: false, reason: "corporation office is not at the current docked location" };
  }

  const itemID = normalizeNumber(item && item.itemID, 0);
  const lockLocationIDs = new Set(
    [
      item && item.locationID,
      itemOffice.officeID,
      itemOffice.officeFolderID,
      itemOffice.itemID,
      itemOffice.stationID,
    ]
      .map((value) => normalizeNumber(value, 0))
      .filter((value) => value > 0),
  );
  const isVoteLocked = [...lockLocationIDs].some((locationID) =>
    getLockedItemIDsAtLocation(
      corporationID,
      locationID,
      lookupContext,
    ).has(itemID));
  if (isVoteLocked) {
    return { allowed: false, reason: "corporation item is locked by vote" };
  }

  const queryRole = CORP_HANGAR_QUERY_ROLE_BY_FLAG[flagID];
  const takeRole = CORP_HANGAR_TAKE_ROLE_BY_FLAG[flagID];
  const roles = rolesAtLocation(session, itemOffice.stationID);
  const isDirector = (roles & CORP_ROLE_DIRECTOR) === CORP_ROLE_DIRECTOR;
  if (
    !isDirector &&
    (
      !queryRole ||
      !takeRole ||
      (roles & queryRole) !== queryRole ||
      (roles & takeRole) !== takeRole
    )
  ) {
    return { allowed: false, reason: `missing Query or Take access for division flag ${flagID}` };
  }

  if (isCorporationContainer) {
    const containerTakeRole = CORP_CONTAINER_TAKE_ROLE_BY_FLAG[flagID];
    if (
      !isDirector &&
      (
        !containerTakeRole ||
        (roles & containerTakeRole) !== containerTakeRole
      )
    ) {
      return { allowed: false, reason: `missing Container Take access for division flag ${flagID}` };
    }

    const containerFamily = getCargoContainerFamily(item);
    const isSecureContainer =
      containerFamily === CARGO_CONTAINER_FAMILY.SECURE ||
      containerFamily === CARGO_CONTAINER_FAMILY.AUDIT_LOG_SECURE;
    if (
      isSecureContainer &&
      (roles & CORP_ROLE_DIRECTOR) !== CORP_ROLE_DIRECTOR &&
      (roles & CORP_ROLE_EQUIPMENT_CONFIG) !== CORP_ROLE_EQUIPMENT_CONFIG
    ) {
      return { allowed: false, reason: "missing Config Equipment access for secure container" };
    }
  }

  return {
    allowed: true,
    office: itemOffice,
    resetsContainerState: isCorporationContainer,
  };
}

function isPersonalHangarRepackageRequest(item, request, charID, dockedLocationID) {
  return Boolean(item) &&
    normalizeNumber(request && request.stationID, 0) === dockedLocationID &&
    normalizeNumber(item.ownerID, 0) === charID &&
    normalizeNumber(item.locationID, 0) === dockedLocationID &&
    normalizeNumber(item.flagID, 0) === ITEM_FLAGS.HANGAR;
}

function repackageItemsForSession(session, requests, sourceLabel = "RepackagingSvc", options = {}) {
  const dockedLocationID = normalizeNumber(getDockedLocationID(session), 0);
  const charID = normalizeNumber(session && session.characterID, 0);
  const activeShip = charID > 0 ? getActiveShipItem(charID) : null;
  const decodedOptions = unwrapMarshalValue(options) || {};
  const destroyable = decodedOptions.destroyable === true || decodedOptions.destroyable === 1;
  // The client retries the entire request with destroyable=True after this
  // prompt. Preflight before any changes so declining leaves every hull intact.
  if (charID > 0 && !destroyable) {
    for (const request of requests) {
      const ship = findItemById(request.itemID);
      if (
        !isPersonalHangarRepackageRequest(ship, request, charID, dockedLocationID) ||
        normalizeNumber(ship.categoryID, 0) !== SHIP_CATEGORY_ID ||
        normalizeNumber(ship.singleton, 0) !== 1 ||
        (activeShip && normalizeNumber(activeShip.itemID, 0) === normalizeNumber(ship.itemID, 0)) ||
        isStrategicCruiserType(ship.typeID)
      ) {
        continue;
      }
      const contents = listContainerItems(null, ship.itemID, null);
      if (
        contents.every((item) => normalizeNumber(item.ownerID, 0) === charID) &&
        contents.some((item) => SLOT_FAMILY_FLAGS.rig.includes(normalizeNumber(item.flagID, 0)))
      ) {
        throwWrappedUserError("ConfirmRepackageSomethingWithUpgrades", {});
      }
    }
  }
  const corporationLookupContext = {
    officeByLocator: new Map(),
    lockedItemIDsByLocation: new Map(),
  };
  // Collected across the request loop and published once at the end: a
  // repackage rewrites a corporation hangar item in place -- a fitted ship
  // becomes a packaged hull, a damaged module resets -- and the other members
  // watching that division were told none of it.
  const repackagedChanges = [];

  log.info(
    `[${sourceLabel}] RepackageItems location=${dockedLocationID} requests=${JSON.stringify(requests)}`,
  );

  for (const request of requests) {
    if (charID <= 0) {
      continue;
    }

    const item = findItemById(request.itemID);
    if (!item) {
      continue;
    }

    const isPersonalHangarItem = isPersonalHangarRepackageRequest(
      item, request, charID, dockedLocationID,
    );
    const corporationAccess = isPersonalHangarItem
      ? null
      : getCorporationHangarRepackageAccess(
          session,
          request,
          item,
          dockedLocationID,
          corporationLookupContext,
        );
    if (!isPersonalHangarItem && !corporationAccess.allowed) {
      log.debug(
        `[${sourceLabel}] Refusing to repackage item ${item.itemID}: ${corporationAccess.reason}`,
      );
      continue;
    }
    if (
      isAuditLogSecureContainer(item) &&
      getRecentAuditLogEntries(item).length > 0
    ) {
      const logResult = recordBlockedAuditContainerRepackage(
        item,
        charID,
        dockedLocationID,
      );
      if (!logResult.success) {
        log.warn(
          `[${sourceLabel}] Failed to record blocked audit-container repackage ` +
          `item=${item.itemID}: ${normalizeText(logResult.errorMsg, "WRITE_ERROR")}`,
        );
      }
      log.debug(
        `[${sourceLabel}] Refusing to repackage audit container ${item.itemID} ` +
        "with a retained audit log",
      );
      continue;
    }

    const isShip = normalizeNumber(item.categoryID, 0) === SHIP_CATEGORY_ID;
    let updateResult;
    let offloadingContents = false;

    if (isShip) {
      if (normalizeNumber(item.singleton, 0) !== 1) {
        log.debug(
          `[${sourceLabel}] Refusing to repackage ship ${item.itemID}: already stackable`,
        );
        continue;
      }
      if (
        activeShip &&
        normalizeNumber(activeShip.itemID, 0) === normalizeNumber(item.itemID, 0)
      ) {
        log.debug(
          `[${sourceLabel}] Refusing to repackage active ship ${item.itemID}`,
        );
        continue;
      }

      const nestedItems = listContainerItems(null, item.itemID, null);
      let contentMoveRequests = [];
      const destroyItemIDs = [];
      if (nestedItems.length > 0) {
        // Ordinary fitted rigs are destroyed after confirmation; strategic
        // cruisers retain their reusable rigs. Hidden ship-mode records are
        // runtime state, not goods to return to the hangar.
        const canOffload = nestedItems.every(
          (nestedItem) =>
            normalizeNumber(nestedItem && nestedItem.ownerID, 0) === charID,
        );
        if (!canOffload) {
          log.debug(
            `[${sourceLabel}] Refusing to repackage item ${item.itemID} with ${nestedItems.length} contained items`,
          );
          continue;
        }
        const canReturnRigs = isStrategicCruiserType(item.typeID);
        contentMoveRequests = nestedItems
          .sort(
            (left, right) =>
              normalizeNumber(left && left.itemID, 0) -
              normalizeNumber(right && right.itemID, 0),
          )
          .filter((nestedItem) => {
            const flagID = normalizeNumber(nestedItem.flagID, 0);
            if (
              flagID === ITEM_FLAGS.HIDDEN_MODIFIERS ||
              (!canReturnRigs && SLOT_FAMILY_FLAGS.rig.includes(flagID))
            ) {
              destroyItemIDs.push(nestedItem.itemID);
              return false;
            }
            return true;
          })
          .map((nestedItem) => ({
            itemID: nestedItem.itemID,
            destinationLocationID: dockedLocationID,
            destinationFlagID: ITEM_FLAGS.HANGAR,
          }));
      }

      offloadingContents = contentMoveRequests.length > 0 || destroyItemIDs.length > 0;
      const previousFittingSnapshot = offloadingContents
        ? refreshShipFittingSnapshot(charID, item.itemID, {
            shipItem: item,
            reason: "repackage-offload.before",
          })
        : null;
      updateResult = offloadingContents
        ? moveItemsAndSetShipPackagingState(
            item.itemID,
            contentMoveRequests,
            true,
            { destroyItemIDs },
          )
        : setShipPackagingState(item.itemID, true);
      if (!updateResult.success) {
        log.warn(
          `[${sourceLabel}] Failed to ${offloadingContents ? "atomically offload/" : ""}` +
          `repackage ship ${item.itemID}: ` +
          `${normalizeText(updateResult.errorMsg, "WRITE_ERROR")}`,
        );
        continue;
      }
      if (offloadingContents) {
        emitFittingTransactionForSession(
          session,
          item.itemID,
          updateResult.changes,
          {
            shipItem: updateResult.data,
            previousSnapshot: previousFittingSnapshot,
          },
        );
      }
    } else {
      const nestedItems = listContainerItems(null, item.itemID, null);
      if (nestedItems.length > 0) {
        log.debug(
          `[${sourceLabel}] Refusing to repackage item ${item.itemID} with ${nestedItems.length} contained items`,
        );
        continue;
      }
      if (normalizeNumber(item.singleton, 0) !== 1) {
        log.debug(
          `[${sourceLabel}] Refusing to repackage item ${item.itemID}: already stackable`,
        );
        continue;
      }

      updateResult = setItemPackagingState(item.itemID, true, {
        resetInstanceState: Boolean(corporationAccess && corporationAccess.allowed),
      });
      if (!updateResult.success) {
        log.warn(
          `[${sourceLabel}] Failed to repackage item ${item.itemID}: ${normalizeText(updateResult.errorMsg, "WRITE_ERROR")}`,
        );
        continue;
      }
    }

    if (!isShip || !offloadingContents) {
      const previousState = {
        locationID: updateResult.previousData.locationID,
        flagID: updateResult.previousData.flagID,
        quantity: updateResult.previousData.quantity,
        singleton: updateResult.previousData.singleton,
        stacksize: updateResult.previousData.stacksize,
      };
      syncInventoryItemForSession(
        session,
        updateResult.data,
        previousState,
        {
          emitCfgLocation: false,
        },
      );
      repackagedChanges.push({
        item: updateResult.data,
        previousData: {
          ...previousState,
          ownerID: updateResult.previousData.ownerID,
        },
      });
    }
  }

  fanCorporationOfficeInventoryChanges(repackagedChanges, {
    actorSession: session || null,
  });
}

module.exports = {
  extractRepackageRequests,
  repackageItemsForSession,
};
