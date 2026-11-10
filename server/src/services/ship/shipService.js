"use strict";

const path = require("path");
const { PROXY_NODE_ID } = require(path.join(__dirname, "../../network/protocolProfile"));
const BaseService = require(path.join(__dirname, "../baseService"));
const log = require(path.join(__dirname, "../../utils/logger"));
const {
  resolveSessionCharacterID,
} = require(path.join(__dirname, "../_shared/sessionIdentity"));
const {
  throwWrappedUserError,
} = require(path.join(__dirname, "../../common/machoErrors"));
const {
  activateShipForSession,
  findCharacterShip,
  getActiveShipRecord,
  buildInventoryItemRow,
  emitFittingTransactionForSession,
  syncInventoryItemForSession,
} = require(path.join(__dirname, "../character/characterState"));
const {
  assembleInventoryItem,
  ensureCapsuleForCharacter,
  ITEM_FLAGS,
  findItemById,
  getShipConditionState,
  listContainerItems,
  moveItemsAndSetShipPackagingState,
  updateInventoryItem,
} = require(path.join(__dirname, "../inventory/itemStore"));
const {
  normalizeShipConfiguration,
} = require(path.join(__dirname, "./shipServiceAccess"));
const {
  undockSession,
  ejectSession,
  boardSpaceShip,
} = require(path.join(__dirname, "../../space/transitions"));
const {
  getDockedLocationID,
  isDockedSession,
} = require(path.join(__dirname, "../structure/structureLocation"));
const {
  listFittedItems,
  getFittedModuleItems,
  getTurretLikeModuleItems,
  buildModuleStatusSnapshot,
  buildChargeSublocationData,
  SLOT_FAMILY_FLAGS,
  isStrategicCruiserType,
  getSubsystemSlotFlag,
  isSubsystemCompatibleWithStrategicCruiser,
  getStrategicCruiserSubsystemStatus,
  getStrategicCruiserUseStatus,
  getMissingRequiredSkills,
} = require(path.join(__dirname, "../fitting/liveFittingState"));
const {
  buildWeaponBankStateDict,
} = require(path.join(__dirname, "../moduleGrouping/moduleGroupingRuntime"));
const {
  buildShipHeatStateDict,
  buildShipRackHeatAttributes,
} = require(path.join(__dirname, "../dogma/activationHeatState"));
const {
  buildShipConditionAttributes,
  readShipConditionAmounts,
} = require(path.join(__dirname, "../dogma/shipConditionAmounts"));
const {
  getShipFittingSnapshot,
} = require(path.join(__dirname, "../../_secondary/fitting/fittingRuntime"));
const {
  findFittingByID,
} = require(path.join(__dirname, "../../_secondary/fitting/fittingStore"));
const {
  refreshShipFittingSnapshot,
} = require(path.join(__dirname, "../../_secondary/fitting/fittingRuntime"));
const {
  buildDict,
  buildList,
  buildMarshalReal,
  unwrapMarshalValue,
} = require(path.join(__dirname, "../_shared/serviceHelpers"));
const {
  resolveItemByTypeID,
} = require(path.join(__dirname, "../inventory/itemTypeRegistry"));
const {
  DRONE_CATEGORY_ID,
  launchDronesForSession,
  scoopDrone,
  scoopDroneToCargo,
} = require(path.join(__dirname, "../drone/droneRuntime"));
const {
  jettisonItemsForSession,
} = require(path.join(__dirname, "./jettisonRuntime"));
const {
  boardStoredShipFromMaintenanceContainer,
  launchShipFromMaintenanceContainer,
  scoopShipIntoActiveShipMaintenanceBay,
  storeActiveShipInMaintenanceContainer,
} = require(path.join(__dirname, "./ejectRuntime"));
const {
  launchOrbitalsFromShip,
} = require(path.join(__dirname, "./orbitalLaunchRuntime"));
const {
  scoopMobileDepotToCargo,
  scoopMobileDepotToMobileDepotHold,
} = require(path.join(__dirname, "./mobileDepotRuntime"));
const {
  MAX_CARGO_CONTAINER_TRANSFER_DISTANCE_METERS,
  isScoopableSpaceItem,
  scoopCargoContainerToCargo,
  scoopCargoContainerToFleetHangar,
} = require(path.join(__dirname, "./cargoContainerRuntime"));
const {
  isMobileTractorUnitType,
  scoopMobileTractorUnitToCargo,
} = require(path.join(__dirname, "./mobileTractorUnitRuntime"));
const {
  getShipDirtTimestamp,
  normalizeFiletime,
  resetShipDirtTimestamp,
} = require(path.join(__dirname, "./shipDirtState"));
const {
  getItemKillCountPlayer,
} = require(path.join(__dirname, "./shipKillCounterState"));
const {
  normalizeShipNameLabel,
} = require(path.join(__dirname, "./shipNameUtils"));
const {
  buildUndockContrabandWarningArguments,
} = require(path.join(__dirname, "../security/contrabandInspectionRuntime"));
const DBTYPE_I4 = 0x03;
const DBTYPE_R8 = 0x05;
const DBTYPE_BOOL = 0x0b;
const DBTYPE_I8 = 0x14;
const FILETIME_TICKS_PER_MS = 10000n;
const FILETIME_EPOCH_OFFSET = 116444736000000000n;
const DEFAULT_FITTING_REWARD_ICON = "res:/UI/Texture/classes/Fitting/tabFittings.png";
const EXPECTED_SCOOP_REFUSALS = new Set([
  "CONTAINER_ANCHORED",
  "CONTROL_TOWER_NOT_OWNER",
  "STARBASE_STRUCTURE_NOT_OWNER",
  "STARBASE_STRUCTURE_TOO_FAR",
  "ITEM_NOT_MOBILE_DEPOT",
  "ITEM_NOT_MOBILE_TRACTOR_UNIT",
  "ITEM_NOT_SCOOPABLE_CONTAINER",
  "FLEET_HANGAR_NOT_AVAILABLE",
  "MOBILE_DEPOT_HOLD_NOT_AVAILABLE",
  "MOBILE_DEPOT_NOT_ACTIVE",
  "MOBILE_DEPOT_NOT_OWNER",
  "MOBILE_DEPOT_REINFORCED",
  "MOBILE_TRACTOR_UNIT_NOT_ACTIVE",
  "MOBILE_TRACTOR_UNIT_NOT_OWNER",
  "DRONE_CONTROLLED",
  "DRONE_SECURITY_SCOPE_MISMATCH",
  "NOT_ENOUGH_CARGO_SPACE",
  "NOT_ENOUGH_FLEET_HANGAR_SPACE",
  "NOT_ENOUGH_MOBILE_DEPOT_HOLD_SPACE",
  "SECURE_CONTAINER_PASSWORD_REQUIRED",
  "SafetyActivated",
  "STARBASE_INDUSTRY_JOBS_ACTIVE",
  "TARGET_TOO_FAR",
]);

function getActiveAbyssalShipSwapRestriction(session, action = "ship_swap") {
  if (!session || isDockedSession(session)) {
    return null;
  }
  const abyssalMgrService = require("../../abyssal").scenePolicy;
  const characterID = Number(session.characterID) || 0;
  const shipID = Number(
    session._space && session._space.shipID || session.shipID || session.shipid,
  ) || 0;
  const activeRun =
    characterID > 0 &&
    typeof abyssalMgrService.getActiveAbyssalRunForCharacterID === "function"
      ? abyssalMgrService.getActiveAbyssalRunForCharacterID(characterID)
      : null;
  const resolvedRun = activeRun || (
    shipID > 0 &&
    typeof abyssalMgrService.getActiveAbyssalRunForShipID === "function"
      ? abyssalMgrService.getActiveAbyssalRunForShipID(shipID)
      : null
  );
  const sceneKey = String(
    session._space && session._space.sceneKey || session.spaceSceneKey || "",
  ).trim();
  const sceneKeyMatch = /^abyssal-run:(\d+)$/.exec(sceneKey);
  const sceneInstanceID = Number(
    session._space && session._space.instanceID ||
      session.spaceInstanceID ||
      sceneKeyMatch && sceneKeyMatch[1] ||
      0,
  ) || 0;
  const hasAbyssalSceneAuthority = Boolean(
    String(session._space && session._space.sceneKind || "").trim() === "abyssal" ||
    sceneKeyMatch
  );
  return resolvedRun || hasAbyssalSceneAuthority
    ? {
        action,
        characterID,
        shipID,
        instanceID: resolvedRun
          ? Number(resolvedRun.instanceID) || 0
          : sceneInstanceID,
      }
    : null;
}

function assertAbyssalShipSwapAllowed(session, action) {
  const restriction = getActiveAbyssalShipSwapRestriction(session, action);
  if (!restriction) {
    return;
  }
  log.warn(
    `[AbyssalMgr] Manual ship transition blocked action=${action} ` +
      `char=${restriction.characterID} ship=${restriction.shipID} ` +
      `instance=${restriction.instanceID}`,
  );
  throwWrappedUserError("CustomNotify", {
    notify: "You cannot eject, board, launch, or store ships inside Abyssal Deadspace.",
  });
}
// An eject the space runtime refused for a reason the pilot can act on.
function throwEjectRefusal(errorMsg) {
  if (errorMsg === "SHIP_DESTRUCTION_IN_PROGRESS") {
    throwWrappedUserError("CustomNotify", { notify: "You cannot eject while your ship is being destroyed." });
  }
  if (errorMsg === "EJECT_DISALLOWED_BY_MODULE") {
    throwWrappedUserError("CustomNotify", {
      notify: "You cannot eject while your Entosis Link is active.",
    });
  }
}

const INSTANCE_ROW_DESCRIPTOR_COLUMNS = [
  ["instanceID", DBTYPE_I8],
  ["online", DBTYPE_BOOL],
  ["damage", DBTYPE_R8],
  ["charge", DBTYPE_R8],
  ["skillPoints", DBTYPE_I4],
  ["armorDamage", DBTYPE_R8],
  ["shieldCharge", DBTYPE_R8],
  ["incapacitated", DBTYPE_BOOL],
];

function buildCurrentFileTime() {
  return BigInt(Date.now()) * FILETIME_TICKS_PER_MS + FILETIME_EPOCH_OFFSET;
}

// Formats a jettison-cooldown remaining time for the ShpJettisonPending "{eta}"
// placeholder, e.g. "2 minutes and 44 seconds", "44 seconds", "1 minute".
function formatJettisonCooldownEta(retryAfterMs) {
  const totalSeconds = Math.max(1, Math.ceil((Number(retryAfterMs) || 0) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const parts = [];
  if (minutes > 0) {
    parts.push(`${minutes} minute${minutes === 1 ? "" : "s"}`);
  }
  if (seconds > 0 || minutes === 0) {
    parts.push(`${seconds} second${seconds === 1 ? "" : "s"}`);
  }
  return parts.join(" and ");
}

function normalizeMethodName(rawMethodName) {
  if (typeof rawMethodName === "string") {
    return rawMethodName;
  }

  if (Buffer.isBuffer(rawMethodName)) {
    return rawMethodName.toString("utf8");
  }

  if (rawMethodName === null || rawMethodName === undefined) {
    return "";
  }

  return String(rawMethodName);
}

function extractKwarg(kwargs, key) {
  if (!kwargs) {
    return undefined;
  }

  if (kwargs.type === "dict" && Array.isArray(kwargs.entries)) {
    // Kwarg keys can arrive as plain strings, Buffers, or marshalled string
    // objects depending on how the client encoded them. Compare on the
    // normalized string form so we don't miss (for example) a Buffer-encoded
    // "subSystems" key on strategic-cruiser AssembleShip calls, which would
    // otherwise silently drop the subsystem selection (=> MISSING_SUBSYSTEMS).
    const match = kwargs.entries.find(
      (entry) => normalizeText(entry[0], "") === key,
    );
    return match ? match[1] : undefined;
  }

  if (typeof kwargs === "object") {
    return kwargs[key];
  }

  return undefined;
}

function normalizeInteger(value, fallback = 0) {
  const unwrapped = unwrapMarshalValue(value);
  const numeric = Number(unwrapped);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function normalizeBoolean(value, fallback = false) {
  if (value === undefined) {
    return fallback;
  }
  return Boolean(unwrapMarshalValue(value));
}

function normalizeText(value, fallback = "") {
  const unwrapped = unwrapMarshalValue(value);
  if (unwrapped === null || unwrapped === undefined) {
    return fallback;
  }
  return String(unwrapped);
}

function buildFitShipsFailedInfo(failedToLoad = [], failedShipID = null) {
  const unwrappedFailedToLoad = unwrapMarshalValue(failedToLoad);
  const missingRows = Array.isArray(unwrappedFailedToLoad) ? unwrappedFailedToLoad : [];
  return buildList([
    buildList(
      missingRows
        .map((row) => {
          const values = Array.isArray(row) ? row : unwrapMarshalValue(row);
          return Array.isArray(values) && values.length >= 2
            ? {
                type: "tuple",
                items: [
                  normalizeInteger(values[0], 0),
                  normalizeInteger(values[1], 0),
                ],
              }
            : null;
        })
        .filter(Boolean),
    ),
    failedShipID === null || failedShipID === undefined
      ? null
      : normalizeInteger(failedShipID, 0),
  ]);
}

function collectMachoDictValues(rawValue) {
  if (!rawValue) {
    return [];
  }

  if (rawValue.type === "dict" && Array.isArray(rawValue.entries)) {
    return rawValue.entries.map((entry) => entry[1]);
  }

  if (typeof rawValue === "object") {
    return Object.values(rawValue);
  }

  return [];
}

class ShipService extends BaseService {
  constructor() {
    super("ship");
    this._shipConfiguration = new Map();
  }

  _getShipID(session) {
    const activeShip =
      session && session.characterID
        ? getActiveShipRecord(session.characterID)
        : null;
    return (
      (activeShip && (activeShip.itemID || activeShip.shipID)) ||
      (session && (session.activeShipID || session.shipID || session.shipid)) ||
      140000101
    );
  }

  _extractShipId(rawValue) {
    if (typeof rawValue === "number" && Number.isFinite(rawValue)) {
      return Math.trunc(rawValue);
    }

    if (typeof rawValue === "bigint") {
      return Number(rawValue);
    }

    if (typeof rawValue === "string" && rawValue.trim() !== "") {
      return Number.parseInt(rawValue, 10);
    }

    if (Buffer.isBuffer(rawValue)) {
      return Number.parseInt(rawValue.toString("utf8"), 10);
    }

    return 0;
  }

  _getInvBrokerForFitting() {
    const InvBrokerService = require(path.join(
      __dirname,
      "../inventory/invBrokerService",
    ));
    return new InvBrokerService();
  }

  _addRequiredFitType(requiredByType, typeID, quantity) {
    const normalizedTypeID = normalizeInteger(typeID, 0);
    const normalizedQuantity = Math.max(0, normalizeInteger(quantity, 0));
    if (normalizedTypeID <= 0 || normalizedQuantity <= 0) {
      return;
    }
    requiredByType.set(
      normalizedTypeID,
      (requiredByType.get(normalizedTypeID) || 0) + normalizedQuantity,
    );
  }

  _buildMultifitRequiredTypes(invBroker, fitInfo, cargoItemsByType, fitRigs) {
    const requiredByType = new Map();
    const modulesByFlag = invBroker._normalizeFitFittingModulesByFlag(fitInfo);
    for (const entry of modulesByFlag) {
      if (!fitRigs && SLOT_FAMILY_FLAGS.rig.includes(entry.flagID)) {
        continue;
      }
      this._addRequiredFitType(requiredByType, entry.typeID, 1);
    }

    for (const bucket of [
      invBroker._normalizeFitFittingQuantitiesByType(cargoItemsByType, null),
      invBroker._normalizeFitFittingQuantitiesByType(fitInfo, "dronesByType"),
      invBroker._normalizeFitFittingQuantitiesByType(fitInfo, "chargesByType"),
      invBroker._normalizeFitFittingQuantitiesByType(fitInfo, "fightersByTypeID"),
      invBroker._normalizeFitFittingQuantitiesByType(fitInfo, "iceByType"),
      invBroker._normalizeFitFittingQuantitiesByType(fitInfo, "implantsByTypeID"),
    ]) {
      for (const entry of bucket) {
        this._addRequiredFitType(requiredByType, entry.typeID, entry.quantity);
      }
    }

    return requiredByType;
  }

  // `requiredTypeIDs` are the only types the caller can use, so the source read
  // is narrowed to them. The source is usually the station hangar, which holds
  // everything the character owns there, and listContainerItems deep-clones
  // every row it returns -- without the filter a multi-fit cloned the whole
  // hangar once per ship to keep a handful of modules.
  _listMultifitSourceItems(characterID, itemLocationID, itemContainerID, requiredTypeIDs) {
    const sourceID = itemContainerID > 0 ? itemContainerID : itemLocationID;
    if (sourceID <= 0) {
      return [];
    }
    const sourceFlag = itemContainerID > 0 ? null : ITEM_FLAGS.HANGAR;
    return listContainerItems(characterID, sourceID, sourceFlag, requiredTypeIDs)
      .filter((item) => item && Number(item.itemID) > 0)
      .sort(
        (left, right) =>
          (Number(left.typeID) || 0) - (Number(right.typeID) || 0) ||
          (Number(left.itemID) || 0) - (Number(right.itemID) || 0),
      );
  }

  _buildMultifitItemsToFit(characterID, itemLocationID, itemContainerID, requiredByType) {
    const itemsByType = new Map();
    const remainingByType = new Map(requiredByType);
    for (const item of this._listMultifitSourceItems(
      characterID,
      itemLocationID,
      itemContainerID,
      requiredByType.keys(),
    )) {
      const typeID = Number(item.typeID) || 0;
      const remainingQuantity = remainingByType.get(typeID) || 0;
      if (remainingQuantity <= 0) {
        continue;
      }

      if (!itemsByType.has(typeID)) {
        itemsByType.set(typeID, []);
      }
      itemsByType.get(typeID).push(Number(item.itemID) || 0);
      const availableQuantity =
        Number(item.singleton) === 1
          ? 1
          : Math.max(1, Number(item.stacksize ?? item.quantity ?? 1) || 1);
      remainingByType.set(typeID, Math.max(0, remainingQuantity - availableQuantity));
    }

    return Object.fromEntries(
      [...itemsByType.entries()].map(([typeID, itemIDs]) => [String(typeID), itemIDs]),
    );
  }

  // Packaged ships stack, so one hangar row can carry many ships. numToFit is a
  // count of SHIPS, not of rows: the client's multi-fit window offers it from
  // fittingSvc.GetQtyInLocationByTypeIDs, which sums item.stacksize over the
  // hangar. Returning a row per ship made a stack of 7 Ventures read as 1 and
  // refused every numToFit above 1 with a phantom ship shortfall.
  //
  // singleton === 0 rather than !== 1 to match the same client count, which
  // skips a row on quantity < 0 -- true for every singleton value, not just 1.
  _listPackagedShipStacksForMultifit(characterID, itemLocationID, shipTypeID) {
    return listContainerItems(characterID, itemLocationID, ITEM_FLAGS.HANGAR, [shipTypeID])
      .filter(
        (item) =>
          item &&
          Number(item.typeID) === shipTypeID &&
          Number(item.categoryID) === 6 &&
          Number(item.singleton) === 0,
      )
      .sort((left, right) => (Number(left.itemID) || 0) - (Number(right.itemID) || 0))
      .map((item) => ({
        itemID: normalizeInteger(item.itemID, 0),
        available: Math.max(
          0,
          normalizeInteger(item.stacksize ?? item.quantity, 0),
        ),
      }))
      .filter((entry) => entry.itemID > 0 && entry.available > 0);
  }

  _setMultifitShipName(shipID, name, session = null) {
    const label = normalizeShipNameLabel(name);
    if (!label) {
      return;
    }
    const updateResult = updateInventoryItem(shipID, (currentItem) => ({
      ...currentItem,
      itemName: label,
    }));
    if (!updateResult.success) {
      log.warn(
        `[Ship] FitShips failed to label ship=${shipID}: ${updateResult.errorMsg || "UNKNOWN_ERROR"}`,
      );
      return;
    }

    const previousName = String(
      (updateResult.previousData && updateResult.previousData.itemName) || "",
    );
    if (previousName !== label) {
      syncInventoryItemForSession(session, updateResult.data, {
        itemName: updateResult.previousData && updateResult.previousData.itemName,
      });
    }
  }

  _syncRequestedOnlineModulesForUndock(session, shipID, kwargs) {
    const requestedOnlineModules = collectMachoDictValues(
      extractKwarg(kwargs, "onlineModules"),
    )
      .map((value) => this._extractShipId(value))
      .filter((value) => value > 0);

    if (requestedOnlineModules.length === 0) {
      return 0;
    }

    const requestedSet = new Set(requestedOnlineModules);
    const charID = session && session.characterID ? session.characterID : 0;
    const fittedModules = getFittedModuleItems(charID, shipID).filter(
      (item) => requestedSet.has(Number(item && item.itemID)),
    );

    let updatedCount = 0;
    for (const moduleItem of fittedModules) {
      if (moduleItem.moduleState && moduleItem.moduleState.online) {
        continue;
      }
      // A module fitted without its skills stays offline (dogmaService SetModuleOnline refuses it too).
      if (getMissingRequiredSkills(charID, moduleItem.typeID).length > 0) {
        continue;
      }

      const updateResult = updateInventoryItem(moduleItem.itemID, (currentItem) => ({
        ...currentItem,
        moduleState: {
          ...(currentItem.moduleState || {}),
          online: true,
        },
      }));

      if (updateResult.success) {
        updatedCount += 1;
      }
    }

    if (updatedCount > 0) {
      log.info(
        `[Ship] Promoted ${updatedCount} requested online module(s) before undock for ship=${shipID}`,
      );
    }

    return updatedCount;
  }

  _extractShipIds(rawValue) {
    if (Array.isArray(rawValue)) {
      return rawValue.map((entry) => this._extractShipId(entry)).filter((entry) => entry > 0);
    }

    if (rawValue && rawValue.type === "list" && Array.isArray(rawValue.items)) {
      return rawValue.items
        .map((entry) => this._extractShipId(entry))
        .filter((entry) => entry > 0);
    }

    const singleShipId = this._extractShipId(rawValue);
    return singleShipId > 0 ? [singleShipId] : [];
  }

  _normalizeFileTime(rawValue) {
    return normalizeFiletime(rawValue, null);
  }

  _getShipDirtTimestamp(shipID, options = {}) {
    const numericShipID = this._extractShipId(shipID);
    if (numericShipID <= 0) {
      return 0n;
    }

    return getShipDirtTimestamp(numericShipID, options);
  }

  _setDirtTimestamp(shipID, rawTimestamp = null, reason = "set") {
    const numericShipID = this._extractShipId(shipID);
    if (numericShipID <= 0) {
      return null;
    }

    const resetResult = resetShipDirtTimestamp(numericShipID, rawTimestamp, {
      reason,
    });
    return resetResult && resetResult.success ? resetResult.dirtTime : null;
  }

  _broadcastShipDirtSlimChange(session, shipID, dirtTime) {
    if (!session || !session._space) {
      return false;
    }

    try {
      const spaceRuntime = require(path.join(__dirname, "../../space/runtime"));
      const scene =
        typeof spaceRuntime.getSceneForSession === "function"
          ? spaceRuntime.getSceneForSession(session)
          : null;
      const entity =
        scene && typeof scene.getEntityByID === "function"
          ? scene.getEntityByID(shipID)
          : null;
      if (
        !scene ||
        !entity ||
        entity.kind !== "ship" ||
        typeof scene.broadcastSlimItemChanges !== "function"
      ) {
        return false;
      }

      entity.dirtTime = normalizeFiletime(dirtTime, 0n) || 0n;
      scene.broadcastSlimItemChanges([entity]);
      return true;
    } catch (error) {
      log.warn(`[Ship] Failed to broadcast dirt slim refresh for ship=${shipID}: ${error.message}`);
      return false;
    }
  }

  _buildActivationResponse(activeShip, session) {
    const charID = resolveSessionCharacterID(session);
    const shipID =
      (activeShip && (activeShip.itemID || activeShip.shipID)) ||
      this._getShipID(session);
    const shipCondition = getShipConditionState(activeShip);
    // The ship's own row has amounts, each stored fraction by the ship's own
    // capacity (shipConditionAmounts.js), as the dogma service's answer has them.
    const fittingSnapshot = activeShip
      ? getShipFittingSnapshot(charID, shipID, {
          shipItem: activeShip,
          reason: "ship.activation-state",
        })
      : null;
    const shipAmounts = readShipConditionAmounts(
      buildShipConditionAttributes(
        fittingSnapshot ? fittingSnapshot.shipAttributes : {},
        shipCondition,
      ),
    );
    const fittedItems = getFittedModuleItems(charID, shipID);
    const moduleEntries = fittedItems.map((item) => [
      item.itemID,
      this._buildPackedInstanceRow(buildModuleStatusSnapshot(item)),
    ]);
    const rackHeat = this._readShipRackHeat(session, activeShip, shipID);

    return [
      {
        type: "dict",
        entries: [
          [
            shipID,
            this._buildPackedInstanceRow({
              itemID: shipID,
              damage: shipAmounts.damage,
              charge: shipAmounts.charge,
              armorDamage: shipAmounts.armorDamage,
              shieldCharge: shipAmounts.shieldCharge,
              incapacitated: shipCondition.incapacitated,
            }),
          ],
          // The pilot's own row carries nothing: [charID, False, 0.0, 0.0, 0, 0.0, 0.0,
          // False] in Tranquility's Board answer ("Eject from Ship and Board ship").
          [
            charID,
            this._buildPackedInstanceRow({
              itemID: charID,
            }),
          ],
          ...moduleEntries,
        ],
      },
      this._buildChargeStateDict(charID, shipID),
      buildWeaponBankStateDict(shipID, { characterID: charID }),
      // Each rack's entry is the ship's own (activationHeatState.js): its
      // capacity, multiplier and dissipation rate from the ship's attributes, and
      // its heat the ship's heat attribute, which the dogma service's answer
      // lists among them.
      buildShipHeatStateDict(
        {
          ...(fittingSnapshot ? fittingSnapshot.shipAttributes : {}),
          ...buildShipRackHeatAttributes(rackHeat),
        },
        { timestamp: buildCurrentFileTime(), rackHeat },
      ),
    ];
  }

  // What each rack holds: the ship's own in space, and docked what was stored
  // with the ship, cooled by the time since.
  _readShipRackHeat(session, activeShip, shipID) {
    const spaceRuntime = require(path.join(__dirname, "../../space/runtime"));
    return typeof spaceRuntime.readShipRackHeat === "function"
      ? spaceRuntime.readShipRackHeat(session, activeShip || { itemID: shipID })
      : null;
  }

  _buildStatusRow({
    itemID,
    online = false,
    damage = 0.0,
    charge = 0.0,
    skillPoints = 0,
    armorDamage = 0.0,
    shieldCharge = 0.0,
    incapacitated = false,
  }) {
    return {
      type: "object",
      name: "util.Row",
      args: {
        type: "dict",
        entries: [
          [
            "header",
            [
              "instanceID",
              "online",
              "damage",
              "charge",
              "skillPoints",
              "armorDamage",
              "shieldCharge",
              "incapacitated",
            ],
          ],
          [
            "line",
            [
              itemID,
              online,
              damage,
              charge,
              skillPoints,
              armorDamage,
              shieldCharge,
              incapacitated,
            ],
          ],
        ],
      },
    };
  }

  _buildInstanceRowDescriptor() {
    return {
      type: "objectex1",
      header: [
        { type: "token", value: "blue.DBRowDescriptor" },
        [INSTANCE_ROW_DESCRIPTOR_COLUMNS],
      ],
      list: [],
      dict: [],
    };
  }

  _buildPackedInstanceRow({
    itemID,
    online = false,
    damage = 0.0,
    charge = 0.0,
    skillPoints = 0,
    armorDamage = 0.0,
    shieldCharge = 0.0,
    incapacitated = false,
  }) {
    return {
      type: "packedrow",
      header: this._buildInstanceRowDescriptor(),
      columns: INSTANCE_ROW_DESCRIPTOR_COLUMNS,
      fields: {
        instanceID: itemID,
        online,
        damage,
        charge,
        skillPoints,
        armorDamage,
        shieldCharge,
        incapacitated,
      },
    };
  }

  _buildChargeSublocationRow({
    locationID,
    flagID,
    typeID,
    quantity,
  }) {
    return {
      type: "object",
      name: "util.Row",
      args: {
        type: "dict",
        entries: [
          ["header", ["instanceID", "flagID", "typeID", "quantity"]],
          ["line", [locationID, flagID, typeID, quantity]],
        ],
      },
    };
  }

  _buildChargeStateDict(charID, shipID) {
    const chargesByFlag = buildChargeSublocationData(charID, shipID);
    // The ship is named even when nothing is loaded: Tranquility's Board answer
    // for a ship with three modules and no charges reads {shipID: {}}.
    return {
      type: "dict",
      entries: [[
        shipID,
        {
          type: "dict",
          entries: chargesByFlag.map((entry) => [
            entry.flagID,
            this._buildChargeSublocationRow({
              locationID: shipID,
              flagID: entry.flagID,
              typeID: entry.typeID,
              quantity: entry.quantity,
            }),
          ]),
        },
      ]],
    };
  }

  _normalizeShipConfiguration(rawConfiguration = {}) {
    return normalizeShipConfiguration(rawConfiguration);
  }

  _getShipConfiguration(shipID) {
    const numericShipID = this._extractShipId(shipID);
    if (!this._shipConfiguration.has(numericShipID)) {
      const shipItem = findItemById(numericShipID);
      this._shipConfiguration.set(
        numericShipID,
        this._normalizeShipConfiguration(shipItem && shipItem.shipConfiguration),
      );
    }

    return this._shipConfiguration.get(numericShipID);
  }

  _persistShipConfiguration(shipID, configuration) {
    const numericShipID = this._extractShipId(shipID);
    if (numericShipID <= 0) {
      return {
        success: false,
        errorMsg: "INVALID_SHIP_ID",
      };
    }

    const normalizedConfiguration = this._normalizeShipConfiguration(configuration);
    this._shipConfiguration.set(numericShipID, normalizedConfiguration);
    const updateResult = updateInventoryItem(numericShipID, (currentItem) => ({
      ...currentItem,
      shipConfiguration: {
        ...(currentItem.shipConfiguration || {}),
        ...normalizedConfiguration,
      },
    }));
    if (!updateResult.success) {
      log.warn(
        `[Ship] Failed to persist ship configuration shipID=${numericShipID}: ${updateResult.errorMsg || "UNKNOWN_ERROR"}`,
      );
    }
    return updateResult;
  }

  _getStrategicCruiserUseStatus(shipItem) {
    if (!shipItem || !isStrategicCruiserType(shipItem.typeID)) {
      return null;
    }
    const fittedItems = listContainerItems(null, shipItem.itemID, null);
    return getStrategicCruiserUseStatus(
      shipItem.ownerID,
      shipItem,
      fittedItems,
    );
  }

  _assertStrategicCruiserSubsystems(shipItem, sourceLabel) {
    const status = this._getStrategicCruiserUseStatus(shipItem);
    if (!status || status.complete) {
      return;
    }
    const subsystemStatus = status.subsystemStatus || {
      missingFlags: [],
      duplicateFlags: [],
      invalidItems: [],
    };
    const familyNameByFlag = new Map([
      [125, "Core"],
      [126, "Defensive"],
      [127, "Offensive"],
      [128, "Propulsion"],
    ]);
    const missingFamilies = subsystemStatus.missingFlags
      .map((flagID) => familyNameByFlag.get(flagID) || `slot ${flagID}`);
    let detail;
    if (missingFamilies.length > 0) {
      detail = ` Missing: ${missingFamilies.join(", ")}.`;
    } else if (
      subsystemStatus.duplicateFlags.length > 0 ||
      subsystemStatus.invalidItems.length > 0
    ) {
      detail = " Remove duplicate or incompatible subsystems before boarding.";
    } else {
      detail =
        " Remove modules or bay contents that exceed the selected subsystems' " +
        "slots, hardpoints, CPU, powergrid, drone bay, or fighter bay before " +
        "boarding.";
    }
    log.warn(
      `[Ship] ${sourceLabel} rejected incomplete strategic cruiser ` +
      `ship=${Number(shipItem.itemID) || 0} ` +
      `missing=${JSON.stringify(subsystemStatus.missingFlags)} ` +
      `duplicates=${JSON.stringify(subsystemStatus.duplicateFlags)} ` +
      `invalidSubsystems=${subsystemStatus.invalidItems.length} ` +
      `invalidSlots=${status.invalidRegularSlotItems.length} ` +
      `turretOverload=${status.turretOverload} ` +
      `launcherOverload=${status.launcherOverload} ` +
      `cpuOverload=${status.cpuOverload} powerOverload=${status.powerOverload} ` +
      `droneBayOverload=${status.droneBayOverload} ` +
      `fighterBayOverload=${status.fighterBayOverload}`,
    );
    throwWrappedUserError("CustomNotify", {
      notify:
        "A strategic cruiser requires one Core, Defensive, Offensive, and " +
        `Propulsion subsystem before it can be used.${detail}`,
    });
  }

  _extractSubsystemSelection(rawValue) {
    const unwrapped = unwrapMarshalValue(rawValue);
    const values = Array.isArray(unwrapped)
      ? unwrapped
      : unwrapped && typeof unwrapped === "object"
        ? Object.values(unwrapped)
        : unwrapped === null || unwrapped === undefined
          ? []
          : [unwrapped];
    return values
      .map((value) => this._extractShipId(value))
      .filter((itemID) => itemID > 0);
  }

  _buildStrategicCruiserAssemblyPlan(
    charID,
    stationID,
    shipItem,
    requestedSubsystemIDs = [],
  ) {
    if (!isStrategicCruiserType(shipItem && shipItem.typeID)) {
      return { success: true, plan: [] };
    }

    const fittedItems = listFittedItems(charID, shipItem.itemID);
    const currentStatus = getStrategicCruiserSubsystemStatus(shipItem, fittedItems);
    if (
      currentStatus.duplicateFlags.length > 0 ||
      currentStatus.invalidItems.length > 0
    ) {
      return { success: false, errorMsg: "INVALID_FITTED_SUBSYSTEMS" };
    }

    const numericRequestedIDs = (Array.isArray(requestedSubsystemIDs)
      ? requestedSubsystemIDs
      : [])
      .map((itemID) => this._extractShipId(itemID))
      .filter((itemID) => itemID > 0);
    if (new Set(numericRequestedIDs).size !== numericRequestedIDs.length) {
      return { success: false, errorMsg: "DUPLICATE_SUBSYSTEM_SELECTION" };
    }

    const selectedByFlag = new Map();
    for (const itemID of numericRequestedIDs) {
      const item = findItemById(itemID);
      const flagID = getSubsystemSlotFlag(item && item.typeID);
      if (
        !item ||
        Number(item.ownerID) !== Number(charID) ||
        Number(item.locationID) !== Number(stationID) ||
        Number(item.flagID) !== ITEM_FLAGS.HANGAR ||
        flagID <= 0 ||
        !isSubsystemCompatibleWithStrategicCruiser(item, shipItem.typeID)
      ) {
        return { success: false, errorMsg: "INVALID_SUBSYSTEM_SELECTION" };
      }
      if (
        !currentStatus.missingFlags.includes(flagID) ||
        selectedByFlag.has(flagID)
      ) {
        return { success: false, errorMsg: "DUPLICATE_SUBSYSTEM_FAMILY" };
      }
      selectedByFlag.set(flagID, item);
    }

    const plan = [];
    const prospectiveFittedItems = [...fittedItems];
    for (const flagID of currentStatus.missingFlags) {
      const selectedItem = selectedByFlag.get(flagID);
      if (!selectedItem) {
        return {
          success: false,
          errorMsg: "MISSING_SUBSYSTEMS",
          flagID,
        };
      }
      plan.push({
        item: selectedItem,
        flagID,
      });
      prospectiveFittedItems.push({
        ...selectedItem,
        locationID: shipItem.itemID,
        flagID,
      });
    }

    if (selectedByFlag.size !== currentStatus.missingFlags.length) {
      return { success: false, errorMsg: "UNEXPECTED_SUBSYSTEM_SELECTION" };
    }

    const prospectiveStatus = getStrategicCruiserSubsystemStatus(
      shipItem,
      prospectiveFittedItems,
    );
    return prospectiveStatus.complete
      ? { success: true, plan }
      : { success: false, errorMsg: "INCOMPLETE_SUBSYSTEM_PLAN" };
  }

  _assertNoPendingShipDeath(session) {
    if (require("./breacherPodDeathRuntime").isShipDeathPending(session?._space?.shipID || session?.shipID)) {
      throwWrappedUserError("CustomNotify", { notify: "The ship is being destroyed." });
    }
  }

  // A ship the pilot lacks the skills for is not boarded. The client refuses
  // for itself (station/base.py TryActivateShip, structureDocking
  // .ActivateShip: GetMissingSkills, then prompt_missing_skill_requirements);
  // what reaches the server all the same is refused with the client's own
  // ShipHasSkillPrerequisites ("Operation of {item} requires the following
  // skills: {requiredSkills}"), its requiredSkills each as
  // UI/SkillQueue/Skills/SkillNameAndLevel ("{name} : Level {amount}") joined
  // as FormatGenericList joins them.
  _assertShipSkills(session, shipTypeID) {
    const typeID = Number(shipTypeID) || 0;
    if (!session || typeID <= 0) {
      return;
    }
    const missing = getMissingRequiredSkills(session.characterID, typeID);
    if (missing.length === 0) {
      return;
    }
    const names = missing.map((requirement) => {
      const skillName = String((resolveItemByTypeID(requirement.skillTypeID) || {}).name || requirement.skillTypeID);
      return `${skillName} : Level ${requirement.requiredLevel}`;
    });
    throwWrappedUserError("ShipHasSkillPrerequisites", {
      requiredSkills: names.join(", "),
      item: typeID,
      skillCount: names.length,
    });
  }

  _activateShipById(shipID, session, sourceLabel) {
    this._assertNoPendingShipDeath(session);
    if (!session) {
      log.warn(`[Ship] ${sourceLabel} requested without a session`);
      return null;
    }

    const numericShipID = this._extractShipId(shipID);
    if (!Number.isInteger(numericShipID) || numericShipID <= 0) {
      log.warn(`[Ship] ${sourceLabel} received invalid shipID=${String(shipID)}`);
      return null;
    }

    const currentShip = getActiveShipRecord(session.characterID);
    const requestedShip = findCharacterShip(session.characterID, numericShipID);

    if (requestedShip) {
      this._assertStrategicCruiserSubsystems(requestedShip, sourceLabel);
      this._assertShipSkills(session, requestedShip.shipTypeID ?? requestedShip.typeID);
    }

    log.info(
      `[Ship] ${sourceLabel} shipID=${numericShipID} current=${currentShip ? (currentShip.itemID || currentShip.shipID) : "none"} requested=${requestedShip ? `${requestedShip.shipName}(${requestedShip.shipTypeID})` : "unknown"}`,
    );

    const activationResult = activateShipForSession(session, numericShipID, {
      emitNotifications: true,
      logSelection: true,
    });
    if (!activationResult.success) {
      log.warn(
        `[Ship] ${sourceLabel} failed for shipID=${numericShipID}: ${activationResult.errorMsg}`,
      );
      return null;
    }

    this._markDockedActiveShipVisualDirty(numericShipID);

    const activeShip = activationResult.activeShip || getActiveShipRecord(session.characterID);
    return this._buildActivationResponse(activeShip, session);
  }

  _markDockedActiveShipVisualDirty(shipID) {
    // Dirt parity is persistent per hull. Boarding/leave-ship should ensure a
    // timestamp exists for hangar presentation, not clean the ship every time.
    this._getShipDirtTimestamp(shipID, { reason: "activated" });
  }

  _leaveShip(session, shipID, sourceLabel) {
    if (!session || !session.characterID) {
      log.warn(`[Ship] ${sourceLabel} requested without a selected character`);
      return null;
    }

    const stationID = getDockedLocationID(session) || 60003760;
    const capsuleResult = ensureCapsuleForCharacter(session.characterID, stationID);
    if (!capsuleResult.success || !capsuleResult.data) {
      log.warn(`[Ship] ${sourceLabel} failed to ensure capsule`);
      return null;
    }

    const capsuleWasCreated = Boolean(
      capsuleResult.created === true ||
      (
        capsuleResult.data &&
        Array.isArray(capsuleResult.data.changes) &&
        capsuleResult.data.changes.some((change) => change && change.created === true)
      ) ||
      (
        Array.isArray(capsuleResult.changes) &&
        capsuleResult.changes.some((change) => change && change.created === true)
      ),
    );

    if (capsuleWasCreated) {
      // Treat a lazily created docked capsule like any other boardable hangar
      // ship: seed the inventory row before the shipid swap so the hangar view
      // can resolve the new active hull during ProcessActiveShipChanged.
      syncInventoryItemForSession(
        session,
        capsuleResult.data,
        {
          locationID: 0,
          flagID: 0,
          quantity: 0,
          singleton: 0,
          stacksize: 0,
        },
        {
          emitCfgLocation: true,
        },
      );
    }

    const activationResult = activateShipForSession(
      session,
      capsuleResult.data.itemID,
      {
        emitNotifications: true,
        logSelection: true,
      },
    );
    if (!activationResult.success) {
      log.warn(
        `[Ship] ${sourceLabel} failed to activate capsule: ${activationResult.errorMsg}`,
      );
      return null;
    }

    this._markDockedActiveShipVisualDirty(capsuleResult.data.itemID);

    return capsuleResult.data.itemID;
  }

  Handle_GetDirtTimestamp(args, session, kwargs) {
    const shipID = args && args.length > 0 ? args[0] : null;
    const dirtTimestamp = this._getShipDirtTimestamp(shipID, {
      createIfMissing: true,
      reason: "get",
    });
    log.debug(
      `[Ship] GetDirtTimestamp(shipID=${shipID}) -> ${String(dirtTimestamp)}`,
    );
    return dirtTimestamp;
  }

  Handle_ResetDirtTimestamp(args, session, kwargs) {
    const shipID = args && args.length > 0 ? args[0] : null;
    const numericShipID = this._extractShipId(shipID);
    const characterID =
      session && (session.characterID || session.charID || session.charid);
    if (numericShipID <= 0 || !characterID || !findCharacterShip(characterID, numericShipID)) {
      log.warn(
        `[Ship] ResetDirtTimestamp denied for shipID=${shipID}, characterID=${characterID || 0}`,
      );
      return 0n;
    }

    const dirtTimestamp = this._setDirtTimestamp(numericShipID, null, "client_clean");
    if (dirtTimestamp) {
      this._broadcastShipDirtSlimChange(session, numericShipID, dirtTimestamp);
    }
    log.debug(
      `[Ship] ResetDirtTimestamp(shipID=${shipID}) -> ${String(dirtTimestamp || 0n)}`,
    );
    return dirtTimestamp || 0n;
  }

  Handle_GetShipKillCounter(args, session, kwargs) {
    const shipID = args && args.length > 0 ? args[0] : null;
    const count = getItemKillCountPlayer(this._extractShipId(shipID));
    log.debug(`[Ship] GetShipKillCounter(shipID=${shipID}) -> ${count}`);
    return [count, 1];
  }

  Handle_GetKillCounter(args, session, kwargs) {
    const shipID = args && args.length > 0 ? args[0] : null;
    const count = getItemKillCountPlayer(this._extractShipId(shipID));
    log.debug(`[Ship] GetKillCounter(shipID=${shipID}) -> ${count}`);
    return count;
  }

  Handle_GetDisplayKillCounterValue(args, session, kwargs) {
    log.debug("[Ship] GetDisplayKillCounterValue");
    return 1;
  }

  Handle_GetFittedItems(args, session, kwargs) {
    const shipID = args && args.length > 0 ? args[0] : null;
    log.debug(`[Ship] GetFittedItems(shipID=${shipID})`);
    const charID = session && session.characterID ? session.characterID : 0;
    const resolvedShipID = this._extractShipId(shipID) || this._getShipID(session);
    return {
      type: "dict",
      entries: listFittedItems(charID, resolvedShipID).map((item) => [
        item.itemID,
        buildInventoryItemRow(item),
      ]),
    };
  }

  Handle_GetShipFittingInfo(args) {
    const fittingID = this._extractShipId(args && args[0]);
    const fitting = findFittingByID(fittingID);
    if (!fitting) {
      return [
        `Fitting ${fittingID > 0 ? fittingID : 0}`,
        DEFAULT_FITTING_REWARD_ICON,
        0,
        null,
      ];
    }

    const shipTypeID = this._extractShipId(fitting.shipTypeID);
    const shipType = shipTypeID > 0 ? resolveItemByTypeID(shipTypeID) : null;
    const name =
      fitting.nameLabel ||
      fitting.name ||
      (shipType && shipType.name ? `${shipType.name} Fitting` : `Fitting ${fittingID}`);
    const icon = fitting.icon || DEFAULT_FITTING_REWARD_ICON;
    const insurance = shipTypeID > 0 && fitting.insurance ? fitting.insurance : null;
    return [
      name,
      icon,
      shipTypeID,
      insurance,
    ];
  }

  Handle_GetModules(args, session, kwargs) {
    log.debug("[Ship] GetModules");
    const charID = session && session.characterID ? session.characterID : 0;
    const shipID = this._getShipID(session);
    return {
      type: "list",
      items: getFittedModuleItems(charID, shipID).map((item) =>
        buildInventoryItemRow(item),
      ),
    };
  }

  Handle_LaunchDrones(args, session, kwargs) {
    void kwargs;
    const launchResult = launchDronesForSession(
      session,
      args && args.length > 0 ? args[0] : [],
    );
    if (!launchResult || launchResult.success !== true) {
      log.warn(
        `[Ship] LaunchDrones failed for char=${session ? session.characterID : "?"}: ${launchResult ? launchResult.errorMsg : "UNKNOWN_ERROR"}`,
      );
      return { type: "dict", entries: [] };
    }
    return launchResult && launchResult.response && launchResult.response.type === "dict"
      ? launchResult.response
      : { type: "dict", entries: [] };
  }

  Handle_ScoopDrone(args, session, kwargs) {
    void kwargs;
    return scoopDrone(
      session,
      args && args.length > 0 ? args[0] : [],
    );
  }

  Handle_Scoop(args, session, kwargs) {
    void kwargs;
    const objectID = this._extractShipId(args && args.length > 0 ? args[0] : null);
    const password = args && args.length > 1 ? normalizeText(args[1], "") : "";
    const item = findItemById(objectID);
    const result =
      item && Number(item.categoryID) === DRONE_CATEGORY_ID
        ? scoopDroneToCargo(session, objectID)
        : item && isScoopableSpaceItem(item)
          ? scoopCargoContainerToCargo(session, objectID, password)
          : item && isMobileTractorUnitType(item)
            ? scoopMobileTractorUnitToCargo(session, objectID)
            : scoopMobileDepotToCargo(session, objectID);
    return this._handleDeployableScoopResult(
      session,
      objectID,
      result,
    );
  }

  Handle_ScoopToMobileDepotHold(args, session, kwargs) {
    void kwargs;
    const objectID = this._extractShipId(args && args.length > 0 ? args[0] : null);
    return this._handleDeployableScoopResult(
      session,
      objectID,
      scoopMobileDepotToMobileDepotHold(session, objectID),
    );
  }

  Handle_ScoopToFleetHangar(args, session, kwargs) {
    void kwargs;
    const objectID = this._extractShipId(args && args.length > 0 ? args[0] : null);
    const password = args && args.length > 1 ? normalizeText(args[1], "") : "";
    return this._handleDeployableScoopResult(
      session,
      objectID,
      scoopCargoContainerToFleetHangar(session, objectID, password),
    );
  }

  // "Recover to ship maintenance bay" on an unpiloted ship in space. The
  // scoop's own refusals are named here; the bay's rules share StoreVessel's
  // user errors.
  Handle_ScoopToSMA(args, session, kwargs) {
    void kwargs;
    const objectID = this._extractShipId(args && args.length > 0 ? args[0] : null);
    log.info(`[Ship] ScoopToSMA(objectID=${String(objectID)})`);
    const result = scoopShipIntoActiveShipMaintenanceBay(session, objectID);
    if (!result || !result.success) {
      const errorMsg = (result && result.errorMsg) || "UNKNOWN_ERROR";
      log.warn(`[Ship] ScoopToSMA failed objectID=${String(objectID)}: ${errorMsg}`);
      if (errorMsg === "TARGET_TOO_FAR") {
        this._throwScoopTooFar(session, objectID);
      }
      const scoopNotify = {
        NOT_IN_SPACE: "You must be in space to recover a ship.",
        SHIP_MAINTENANCE_BAY_NOT_AVAILABLE: "Your ship does not have a ship maintenance bay.",
        SHIP_NOT_FOUND: "That ship could not be found.",
        SHIP_IS_PILOTED: "You cannot recover a ship that is being piloted.",
        SHIP_NOT_OWNER: "You can only recover your own ships.",
        SHIP_NOT_IN_SPACE: "That ship is not in space near you.",
      }[errorMsg];
      if (scoopNotify) {
        throwWrappedUserError("CustomNotify", { notify: scoopNotify });
      }
      this._throwMaintenanceBayUserError(errorMsg);
    }
    return null;
  }

  // TargetTooFar is the module-activation message, and sent without a module
  // and a distance the client printed its raw template. Every scoop gate
  // compares the ship's hull to the object's against the client's 2,500 m
  // interaction range, so measure that distance here and name the object.
  _throwScoopTooFar(session, objectID) {
    const item = findItemById(objectID);
    const spaceRuntime = require(path.join(__dirname, "../../space/runtime"));
    const scene =
      typeof spaceRuntime.getSceneForSession === "function"
        ? spaceRuntime.getSceneForSession(session)
        : null;
    const shipID = Number(session && session._space && session._space.shipID) || 0;
    const shipEntity = scene ? spaceRuntime.getEntity(session, shipID) : null;
    const objectEntity = scene ? spaceRuntime.getEntity(session, objectID) : null;
    const actual =
      shipEntity &&
      objectEntity &&
      typeof scene.getEntitySurfaceDistance === "function"
        ? scene.getEntitySurfaceDistance(shipEntity, objectEntity)
        : null;
    if (item && Number.isFinite(actual)) {
      throwWrappedUserError("CantUseTooDistantWithType", {
        desired: MAX_CARGO_CONTAINER_TRANSFER_DISTANCE_METERS,
        actual: Math.round(actual),
        typeID: Number(item.typeID),
      });
    }
    throwWrappedUserError("GenericTooFarAway");
  }

  _handleDeployableScoopResult(session, objectID, result) {
    if (!result || !result.success) {
      const errorMsg = result ? result.errorMsg : "UNKNOWN_ERROR";
      const writeLog = EXPECTED_SCOOP_REFUSALS.has(errorMsg) ? log.debug : log.warn;
      writeLog(
        `[Ship] Scoop failed for char=${session ? session.characterID : "?"} objectID=${objectID}: ${errorMsg}`,
      );
      if (errorMsg === "TARGET_TOO_FAR") {
        this._throwScoopTooFar(session, objectID);
      }
      if (errorMsg === "NOT_ENOUGH_CARGO_SPACE") {
        throwWrappedUserError("NotEnoughCargoSpace", {});
      }
      if (errorMsg === "SECURE_CONTAINER_PASSWORD_REQUIRED") {
        throwWrappedUserError("ShpScoopSecureCC", {});
      }
      // Scooping a can you have no loot right to is theft, and green safety
      // refuses it with the same user error the item-level loot path raises.
      if (errorMsg === "SafetyActivated") {
        throwWrappedUserError("SafetyActivated", {});
      }
      let notify = "Unable to scoop this item.";
      if (errorMsg === "STARBASE_INDUSTRY_JOBS_ACTIVE") {
        notify = "Cancel or deliver the assembly array's industry jobs before scooping it.";
      } else if (errorMsg === "CONTAINER_ANCHORED") {
        notify = "This item is anchored. Unanchor it before scooping it.";
      } else if (errorMsg === "CONTROL_TOWER_NOT_OWNER") {
        notify =
          "Only a member of the owning corporation can scoop this control tower.";
      } else if (errorMsg === "STARBASE_STRUCTURE_NOT_OWNER") {
        notify =
          "Only a member of the owning corporation can scoop this starbase structure.";
      } else if (errorMsg === "STARBASE_STRUCTURE_TOO_FAR") {
        notify =
          "You must be within 2,500 meters of this starbase structure (hull to hull), " +
          "or inside its active control tower shield with shield access and unanchor permission, to scoop it.";
      } else if (errorMsg === "MOBILE_DEPOT_NOT_ACTIVE") {
        notify = "Mobile Depot is still activating.";
      } else if (errorMsg === "MOBILE_DEPOT_NOT_OWNER") {
        notify = "Only the owner can scoop this Mobile Depot.";
      } else if (errorMsg === "MOBILE_DEPOT_HOLD_NOT_AVAILABLE") {
        notify = "This ship does not have a Mobile Depot Hold.";
      } else if (errorMsg === "NOT_ENOUGH_MOBILE_DEPOT_HOLD_SPACE") {
        notify = "There is not enough room in the Mobile Depot Hold.";
      } else if (errorMsg === "FLEET_HANGAR_NOT_AVAILABLE") {
        notify = "This ship does not have a Fleet Hangar.";
      } else if (errorMsg === "NOT_ENOUGH_FLEET_HANGAR_SPACE") {
        notify = "There is not enough room in the Fleet Hangar.";
      } else if (errorMsg === "MOBILE_TRACTOR_UNIT_NOT_ACTIVE") {
        notify = "Mobile Tractor Unit is still activating.";
      } else if (errorMsg === "MOBILE_TRACTOR_UNIT_NOT_OWNER") {
        notify = "Only the owner can scoop this Mobile Tractor Unit.";
      } else if (errorMsg === "MOBILE_TRACTOR_UNIT_CONTENT_EJECTION_FAILED") {
        notify = "Unable to eject Mobile Tractor Unit contents.";
      }
      throwWrappedUserError("CustomNotify", { notify });
    }
    return Object.prototype.hasOwnProperty.call(result, "response")
      ? result.response
      : null;
  }

  Handle_Jettison(args, session, kwargs) {
    void kwargs;
    const itemIDs = this._extractShipIds(args && args.length > 0 ? args[0] : null);
    log.info(`[Ship] Jettison itemIDs=${JSON.stringify(itemIDs)}`);
    const result = jettisonItemsForSession(session, itemIDs);
    // The client unpacks this as (jettisonedToCanIDs, jettisonItemList) and
    // treats the union of both as handled — whatever is missing from the
    // request raises NotAllItemsWereJettisoned. Slot two is therefore the
    // standalone-launch list (a container launched as itself), never the
    // rejected IDs; returning rejects there would silently swallow failures.
    //
    // Tranquility answers the two as lists: ship::MachoBindObject ...
    // ('Jettison', ([itemID],), {}) answered ([itemID], []). (A plain array
    // is marshalled as a tuple.)
    const launchedItemIDs = (result && result.launchedItemIDs) || [];
    if (!result || !result.success) {
      log.warn(
        `[Ship] Jettison failed for char=${session ? session.characterID : "?"}: ${result ? result.errorMsg : "UNKNOWN_ERROR"}`,
      );
      if (result && result.errorMsg === "JETTISON_COOLDOWN") {
        // Retail shows the jettison-duct cooldown popup with the remaining time.
        throwWrappedUserError("ShpJettisonPending", {
          eta: formatJettisonCooldownEta(result.retryAfterMs),
        });
      }
      return [buildList([]), buildList(launchedItemIDs)];
    }
    return [
      buildList(result.jettisonedToCanIDs || []),
      buildList(launchedItemIDs),
    ];
  }

  Handle_LaunchFromShip(args, session, kwargs) {
    void kwargs;
    const rawItemIDs = args && args.length > 0 ? args[0] : [];
    const result = launchOrbitalsFromShip(session, rawItemIDs);
    // This legacy endpoint returns error records; Drop separately returns the
    // native per-source sequence of UserError tuples consumed by eveMisc.
    const launchErrors = ((result && result.errors) || []).map((error) => buildDict([
      ["itemID", error.itemID],
      ["errorMsg", error.errorMsg],
    ]));
    if (!result || !result.success) {
      if (result?.errors?.some(error => error.errorMsg === "ESS_DEPLOYABLE_RESTRICTED")) {
        throwWrappedUserError("CustomNotify", { notify: "Deployables must be placed at least 1,000 km from the ESS bank." });
      }
      log.warn(
        `[Ship] LaunchFromShip failed for char=${session ? session.characterID : "?"}: ${result ? result.errorMsg : "UNKNOWN_ERROR"}`,
      );
      return [[], launchErrors];
    }
    return [result.launchedItemIDs || [], launchErrors];
  }

  Handle_LaunchFromContainer(args, session, kwargs) {
    void kwargs;
    const sourceLocationID = args && args.length > 0 ? args[0] : 0;
    const itemID = args && args.length > 1 ? args[1] : 0;
    assertAbyssalShipSwapAllowed(session, "launch_from_maintenance_bay");
    const result = launchShipFromMaintenanceContainer(
      session,
      sourceLocationID,
      itemID,
    );
    if (!result || !result.success) {
      const errorMsg = result ? result.errorMsg : "UNKNOWN_ERROR";
      log.warn(
        `[Ship] LaunchFromContainer failed source=${String(sourceLocationID)} item=${String(itemID)}: ${errorMsg}`,
      );
      this._throwMaintenanceBayUserError(errorMsg, { action: "launch" });
    }
    return null;
  }

  Handle_Drop(args, session, kwargs) {
    void kwargs;
    const rawLaunchRequests = args && args.length > 0 ? args[0] : [];
    const whoseBehalfID = args && args.length > 1 ? this._extractShipId(args[1]) : 0;
    const ignoreWarning = Boolean(args && args.length > 2 ? args[2] : false);
    log.info(
      `[Ship] Drop launchRequests=${JSON.stringify(rawLaunchRequests, (k, v) => (typeof v === "bigint" ? v.toString() : v))} whoseBehalfID=${whoseBehalfID || "default"} ignoreWarning=${ignoreWarning}`,
    );

    const result = launchOrbitalsFromShip(session, rawLaunchRequests, {
      ownerID: whoseBehalfID,
      ignoreWarning,
    });
    if (!result || !result.success) {
      log.warn(
        `[Ship] Drop failed for char=${session ? session.characterID : "?"}: ${result ? result.errorMsg : "UNKNOWN_ERROR"}`,
      );
    }
    return result && result.response && result.response.type === "dict"
      ? result.response
      : { type: "dict", entries: [] };
  }

  Handle_ActivateShip(args, session, kwargs) {
    const shipID = args && args.length > 0 ? args[0] : null;
    const oldShipID = args && args.length > 1 ? args[1] : null;
    log.info(
      `[Ship] ActivateShip(shipID=${String(shipID)}, oldShipID=${String(oldShipID)})`,
    );

    return this._activateShipById(shipID, session, "ActivateShip");
  }

  Handle_AssembleShip(args, session, kwargs) {
    const shipIds = this._extractShipIds(args && args.length > 0 ? args[0] : null);
    const stationID = getDockedLocationID(session) || 0;
    const charID = session && session.characterID ? session.characterID : 0;
    const assembledIDs = [];
    const rawRequestedName = unwrapMarshalValue(
      extractKwarg(kwargs, "name") ?? (args && args.length > 1 ? args[1] : ""),
    );
    const requestedName =
      shipIds.length === 1
        ? normalizeShipNameLabel(rawRequestedName)
        : "";
    const requestedSubsystemIDs = this._extractSubsystemSelection(
      extractKwarg(kwargs, "subSystems") ??
        (args && args.length > 2 ? args[2] : null),
    );

    log.info(
      `[Ship] AssembleShip station=${stationID} shipIDs=${JSON.stringify(shipIds)}`,
    );

    for (const shipID of shipIds) {
      const shipItem = findCharacterShip(charID, shipID);
      if (!shipItem) {
        continue;
      }

      if (
        shipItem.locationID !== stationID ||
        shipItem.flagID !== ITEM_FLAGS.HANGAR ||
        shipItem.singleton === 1
      ) {
        continue;
      }

      const subsystemPlanResult = this._buildStrategicCruiserAssemblyPlan(
        charID,
        stationID,
        shipItem,
        requestedSubsystemIDs,
      );
      if (!subsystemPlanResult.success) {
        log.warn(
          `[Ship] AssembleShip refused strategic cruiser ship=${shipID}: ` +
          `${subsystemPlanResult.errorMsg}`,
        );
        continue;
      }

      const isStrategicCruiser = isStrategicCruiserType(shipItem.typeID);
      const previousFittingSnapshot = isStrategicCruiser
        ? refreshShipFittingSnapshot(charID, shipItem.itemID, {
            shipItem,
            reason: "strategic-cruiser-assembly.before",
          })
        : null;
      const assemblyResult = moveItemsAndSetShipPackagingState(
        shipItem.itemID,
        isStrategicCruiser
          ? subsystemPlanResult.plan.map((planEntry) => ({
              itemID: planEntry.item.itemID,
              destinationLocationID: shipItem.itemID,
              destinationFlagID: planEntry.flagID,
              quantity: 1,
            }))
          : [],
        false,
      );
      if (!assemblyResult.success) {
        log.warn(
          `[Ship] AssembleShip failed${isStrategicCruiser ? " atomically" : ""} ` +
          `for ${shipID}: ` +
          `${assemblyResult.errorMsg || "UNKNOWN_ERROR"}`,
        );
        continue;
      }

      let finalItem = assemblyResult.data;
      let assemblyChanges = assemblyResult.changes;
      const assembledShipID = Number(finalItem && finalItem.itemID) || shipItem.itemID;
      let namedAs = null;
      if (requestedName) {
        const labelResult = updateInventoryItem(assembledShipID, (currentItem) => ({
          ...currentItem,
          itemName: requestedName,
        }));
        if (labelResult.success) {
          finalItem = labelResult.data;
          namedAs = requestedName;
          if (assemblyChanges) {
            assemblyChanges = assemblyChanges.map((change) => (
              Number(change && change.item && change.item.itemID) === assembledShipID
                ? { ...change, item: finalItem }
                : change
            ));
          }
        } else {
          log.warn(
            `[Ship] AssembleShip failed to label ship=${shipID}: ${labelResult.errorMsg || "UNKNOWN_ERROR"}`,
          );
        }
      }

      if (isStrategicCruiser) {
        emitFittingTransactionForSession(
          session,
          assembledShipID,
          assemblyChanges,
          {
            shipItem: finalItem,
            previousSnapshot: previousFittingSnapshot,
          },
        );
      } else {
        for (const change of assemblyChanges) {
          syncInventoryItemForSession(
            session,
            change.item,
            change.previousData || {},
            { emitCfgLocation: false },
          );
        }
      }

      // A ship named as it is assembled: the name told as a naming tells it (the rename recorded on Tranquility,
      // invbroker SetLabel: OnCfgDataChanged('evelocations', [itemID, name, None, 0.0, 0.0, 0.0, None]) to the
      // character). The client's cfg.evelocations keeps the row it holds of an item until it is told otherwise, and
      // this server tells it one of every ship it syncs, a packaged one too: without this, the ship kept its type's
      // name there (uix.GetItemName), in the hangar and wherever else the client names it.
      if (namedAs && session && typeof session.sendNotification === "function") {
        session.sendNotification("OnCfgDataChanged", "charid", [
          "evelocations",
          buildList([assembledShipID, namedAs, null, buildMarshalReal(0), buildMarshalReal(0), buildMarshalReal(0), null]),
        ]);
      }

      assembledIDs.push(assembledShipID);
    }

    // The client takes the answer for the ships assembled, by their IDs, a list (invItemFunctions.AssembleShip 197 to
    // 207: each ID's inventory read for its type and the default skin put on it; AssembleAndBoardShip boards the first,
    // which is another item than the one asked where it came off a stack).
    return {
      type: "list",
      items: assembledIDs,
    };
  }

  Handle_FitShips(args, session, kwargs) {
    const charID = session && session.characterID ? session.characterID : 0;
    const shipTypeID = normalizeInteger(
      extractKwarg(kwargs, "shipTypeID") ?? (args && args.length > 0 ? args[0] : 0),
      0,
    );
    const fitInfo =
      extractKwarg(kwargs, "fitInfo") ?? (args && args.length > 1 ? args[1] : {});
    const itemLocationID = normalizeInteger(
      extractKwarg(kwargs, "itemLocationID") ??
        (args && args.length > 2 ? args[2] : getDockedLocationID(session)),
      getDockedLocationID(session) || 0,
    );
    const cargoItemsByType =
      extractKwarg(kwargs, "cargoItemsByType") ??
      (args && args.length > 3 ? args[3] : {});
    const fitRigs = normalizeBoolean(
      extractKwarg(kwargs, "fitRigs") ?? (args && args.length > 4 ? args[4] : undefined),
      true,
    );
    const fittingName = normalizeText(
      extractKwarg(kwargs, "name") ?? (args && args.length > 5 ? args[5] : ""),
      "",
    );
    const numToFit = Math.max(
      0,
      normalizeInteger(
        extractKwarg(kwargs, "numToFit") ?? (args && args.length > 6 ? args[6] : 0),
        0,
      ),
    );
    const itemContainerID = normalizeInteger(
      extractKwarg(kwargs, "itemContainerID") ??
        (args && args.length > 7 ? args[7] : 0),
      0,
    );
    if (charID <= 0 || shipTypeID <= 0 || itemLocationID <= 0 || numToFit <= 0) {
      log.warn(
        `[Ship] FitShips invalid request char=${charID} shipType=${shipTypeID} location=${itemLocationID} numToFit=${numToFit}`,
      );
      return null;
    }

    const dockedLocationID = getDockedLocationID(session) || 0;
    // The retail client only issues FitShips from the multi-fit window while
    // docked, and always sends `session.stationid or session.structureid` as
    // itemLocationID.  Treat that location as authority, not as a caller-owned
    // search root: otherwise an empty fitting skips FitFitting's source checks
    // after this method has already assembled a packaged ship found in any
    // persisted container or wreck whose itemID the caller supplied.
    if (
      !isDockedSession(session) ||
      dockedLocationID <= 0 ||
      itemLocationID !== dockedLocationID
    ) {
      log.warn(
        `[Ship] FitShips refused non-docked location char=${charID} ` +
          `requested=${itemLocationID} docked=${dockedLocationID || "none"}`,
      );
      throwWrappedUserError("CannotLoadFittingInSpace", {});
    }

    const invBroker = this._getInvBrokerForFitting();
    const requiredByType = this._buildMultifitRequiredTypes(
      invBroker,
      fitInfo,
      cargoItemsByType,
      fitRigs,
    );
    const packagedStacks = this._listPackagedShipStacksForMultifit(
      charID,
      itemLocationID,
      shipTypeID,
    );
    const availableShips = packagedStacks.reduce(
      (total, entry) => total + entry.available,
      0,
    );
    if (availableShips < numToFit) {
      return buildFitShipsFailedInfo(
        [[shipTypeID, numToFit - availableShips]],
        null,
      );
    }

    const sourceLocationID = itemContainerID > 0 ? itemContainerID : itemLocationID;
    let stackIndex = 0;
    for (let round = 0; round < numToFit; round += 1) {
      while (
        stackIndex < packagedStacks.length &&
        packagedStacks[stackIndex].available <= 0
      ) {
        stackIndex += 1;
      }
      const stack = packagedStacks[stackIndex];
      if (!stack) {
        // availableShips was counted from the same list, so this is only
        // reachable if something else consumed the hangar mid-loop.
        log.warn(
          `[Ship] FitShips ran out of packaged ships char=${charID} ` +
            `shipType=${shipTypeID} fitted=${round} numToFit=${numToFit}`,
        );
        return buildFitShipsFailedInfo([[shipTypeID, numToFit - round]], null);
      }

      // Peel exactly one ship off the stack. setShipPackagingState rewrites the
      // whole row to singleton/quantity -1, so assembling a stack of 7 left one
      // ship and destroyed the other six.
      const assembleResult = assembleInventoryItem(stack.itemID);
      if (
        !assembleResult.success ||
        !assembleResult.data ||
        !assembleResult.data.assembledItem
      ) {
        log.warn(
          `[Ship] FitShips failed to assemble ship=${stack.itemID}: ${assembleResult.errorMsg || "UNKNOWN_ERROR"}`,
        );
        return buildFitShipsFailedInfo([], stack.itemID);
      }
      stack.available -= 1;
      // A split mints a new itemID for the assembled ship and leaves the
      // remainder under the original one; the last ship out of a stack keeps it.
      const shipID = normalizeInteger(
        assembleResult.data.assembledItem.itemID,
        0,
      );
      // Both the shrunken source stack and the newly minted ship, or the client
      // keeps drawing the old stack size and never learns the new ship exists.
      for (const change of assembleResult.data.changes || []) {
        if (!change || !change.item) {
          continue;
        }
        syncInventoryItemForSession(
          session,
          change.item,
          change.previousData || {},
          {
            emitCfgLocation: false,
          },
        );
      }

      const itemsToFit = this._buildMultifitItemsToFit(
        charID,
        itemLocationID,
        itemContainerID,
        requiredByType,
      );
      const failedPayload = invBroker.Handle_FitFitting(
        [
          shipID,
          shipTypeID,
          itemsToFit,
          sourceLocationID,
          fitInfo,
          cargoItemsByType,
          fitRigs,
        ],
        session,
        null,
      );
      const failedToLoad = unwrapMarshalValue(failedPayload);
      if (Array.isArray(failedToLoad) && failedToLoad.length > 0) {
        return buildFitShipsFailedInfo(failedToLoad, shipID);
      }

      this._setMultifitShipName(shipID, fittingName, session);
    }

    return null;
  }

  Handle_LeaveShip(args, session, kwargs) {
    const shipID = args && args.length > 0 ? args[0] : null;
    log.info(`[Ship] LeaveShip(shipID=${String(shipID)})`);
    if (session && !isDockedSession(session)) {
      assertAbyssalShipSwapAllowed(session, "leave_ship");
      const transitionResult = ejectSession(session);
      if (!transitionResult.success) {
        log.warn(
          `[Ship] LeaveShip failed in space for char=${session && session.characterID}: ${transitionResult.errorMsg}`,
        );
        throwEjectRefusal(transitionResult.errorMsg);
        return null;
      }
      return null;
    }
    return this._leaveShip(session, shipID, "LeaveShip");
  }

  Handle_BoardStoredShip(args, session, kwargs) {
    this._assertNoPendingShipDeath(session);
    void kwargs;
    const structureID = args && args.length > 0 ? args[0] : null;
    const shipID = args && args.length > 1 ? args[1] : null;
    log.info(
      `[Ship] BoardStoredShip(structureID=${String(structureID)}, shipID=${String(shipID)})`,
    );

    if (session && !isDockedSession(session)) {
      assertAbyssalShipSwapAllowed(session, "board_stored_ship");
      const transitionResult = boardStoredShipFromMaintenanceContainer(
        session,
        structureID,
        shipID,
      );
      if (!transitionResult.success) {
        const errorMsg = transitionResult.errorMsg || "UNKNOWN_ERROR";
        log.warn(
          `[Ship] BoardStoredShip failed source=${String(structureID)} ship=${String(shipID)}: ${errorMsg}`,
        );
        if (errorMsg === "STRATEGIC_CRUISER_FIT_INCOMPLETE") {
          throwWrappedUserError("CustomNotify", {
            notify:
              "A strategic cruiser requires a valid Core, Defensive, Offensive, " +
              "and Propulsion subsystem fit before it can be boarded.",
          });
        }
        this._throwMaintenanceBayUserError(errorMsg);
      }
      const activeShip =
        getActiveShipRecord(session.characterID) ||
        (transitionResult.data &&
          transitionResult.data.boardResult &&
          transitionResult.data.boardResult.ship);
      return this._buildActivationResponse(activeShip, session);
    }

    return this._activateShipById(shipID, session, "BoardStoredShip");
  }

  Handle_StoreVessel(args, session, kwargs) {
    this._assertNoPendingShipDeath(session);
    void kwargs;
    const sourceLocationID = args && args.length > 0 ? args[0] : null;
    log.info(`[Ship] StoreVessel(source=${String(sourceLocationID)})`);
    if (!session || isDockedSession(session)) {
      return null;
    }
    assertAbyssalShipSwapAllowed(session, "store_vessel");

    const result = storeActiveShipInMaintenanceContainer(
      session,
      sourceLocationID,
    );
    if (!result.success) {
      const errorMsg = result.errorMsg || "UNKNOWN_ERROR";
      log.warn(
        `[Ship] StoreVessel failed source=${String(sourceLocationID)}: ${errorMsg}`,
      );
      this._throwMaintenanceBayUserError(errorMsg);
    }

    return result.data && result.data.capsule
      ? result.data.capsule.itemID
      : null;
  }

  Handle_Board(args, session, kwargs) {
    const shipID = args && args.length > 0 ? args[0] : null;
    const oldShipID = args && args.length > 1 ? args[1] : null;
    log.info(
      `[Ship] Board(shipID=${String(shipID)}, oldShipID=${String(oldShipID)})`,
    );

    if (session && !isDockedSession(session)) {
      assertAbyssalShipSwapAllowed(session, "board_space_ship");
      // A ship being destroyed is refused before anything is asked of the pilot.
      this._assertNoPendingShipDeath(session);
      const spaceShipItem = findItemById(this._extractShipId(shipID));
      if (spaceShipItem) {
        this._assertShipSkills(session, spaceShipItem.typeID);
      }
      const transitionResult = boardSpaceShip(session, shipID);
      if (!transitionResult.success) {
        log.warn(
          `[Ship] Board failed in space for shipID=${String(shipID)}: ${transitionResult.errorMsg}`,
        );
        if (transitionResult.errorMsg === "SHIP_DESTRUCTION_IN_PROGRESS") {
          throwWrappedUserError("CustomNotify", { notify: "The ship is being destroyed." });
        }
        if (transitionResult.errorMsg === "STRATEGIC_CRUISER_FIT_INCOMPLETE") {
          throwWrappedUserError("CustomNotify", {
            notify:
              "A strategic cruiser requires a valid Core, Defensive, Offensive, " +
              "and Propulsion subsystem fit before it can be boarded.",
          });
        }
        return null;
      }

      const activeShip =
        (transitionResult.data && transitionResult.data.ship) ||
        getActiveShipRecord(session.characterID);
      return this._buildActivationResponse(activeShip, session);
    }

    return this._activateShipById(shipID, session, "Board");
  }

  _throwMaintenanceBayUserError(errorMsg, options = {}) {
    const launching = options.action === "launch";
    if (
      !launching &&
      (
        errorMsg === "SHIP_MAINTENANCE_BAY_REQUIRES_ASSEMBLED_SHIP" ||
        errorMsg === "SHIP_MAINTENANCE_BAY_SHIP_TYPE_NOT_ALLOWED"
      )
    ) {
      // Direct inventory moves use NotEnoughCargoSpace for incompatible bay
      // contents. Preserve that client-facing UserError on live ship swaps.
      throwWrappedUserError("NotEnoughCargoSpace", {});
    }
    // Launches keep their own wording; the rest of the bay messages are shared.
    let notify = launching
      ? "Unable to launch this ship from the maintenance bay."
      : "Unable to use this ship maintenance bay.";
    if (errorMsg === "SHIP_NOT_ASSEMBLED") {
      notify = launching
        ? "Only assembled ships can be launched from a maintenance bay."
        : "Only assembled ships can be stored in a ship maintenance bay.";
    } else if (errorMsg === "SOURCE_NOT_SHIP_MAINTENANCE_CONTAINER") {
      notify = "That container is not a ship maintenance bay.";
    } else if (errorMsg === "SHIP_NOT_IN_SHIP_MAINTENANCE_BAY") {
      notify = "That ship is not in the ship maintenance bay.";
    } else if (errorMsg === "SOURCE_IS_ACTIVE_SHIP") {
      notify = "You cannot use your active ship as the target maintenance bay.";
    } else if (errorMsg === "SOURCE_MAINTENANCE_CONTAINER_TOO_FAR") {
      notify = "You are too far away from the ship maintenance bay.";
    } else if (errorMsg === "SHIP_MAINTENANCE_BAY_FULL") {
      notify = "There is not enough room in the ship maintenance bay.";
    } else if (errorMsg === "CANNOT_STORE_CAPSULE") {
      notify = "Capsules cannot be stored in a ship maintenance bay.";
    } else if (errorMsg === "SHIP_MAINTENANCE_BAY_CARGO_RESTRICTED") {
      notify =
        "That ship contains cargo which is not permitted in a ship " +
        "maintenance bay.";
    } else if (errorMsg === "SHIP_SERVICE_ACCESS_DENIED") {
      notify = "You do not have access to this ship maintenance bay.";
    } else if (errorMsg === "POS_MAINTENANCE_ARRAY_ACCESS_DENIED") {
      notify = "Your corporation roles or this Ship Maintenance Array's Use setting do not permit this operation.";
    } else if (errorMsg === "STARBASE_INVENTORY_OFFLINE") {
      notify = "The Ship Maintenance Array must be anchored and online before it can be used.";
    } else if (errorMsg === "STARBASE_INVENTORY_TOWER_UNAVAILABLE") {
      notify = "The Ship Maintenance Array requires its control tower to be anchored and online.";
    } else if (errorMsg === "STARBASE_INVENTORY_TOO_FAR") {
      notify = "Move within 5,000 meters of the Ship Maintenance Array, or inside its control tower's shield, to use it.";
    }
    throwWrappedUserError("CustomNotify", { notify });
  }

  Handle_Undock(args, session, kwargs) {
    const shipID = args && args.length > 0 ? args[0] : this._getShipID(session);
    const ignoreContraband = args && args.length > 1 ? Boolean(args[1]) : false;

    log.info(
      `[Ship] Undock(shipID=${String(shipID)}, ignoreContraband=${ignoreContraband})`,
    );

    const undockingShip = getActiveShipRecord(session && session.characterID);
    if (undockingShip) {
      this._assertStrategicCruiserSubsystems(undockingShip, "Undock");
    }

    this._syncRequestedOnlineModulesForUndock(session, shipID, kwargs);

    const result = undockSession(session, {
      ignoreContraband,
      warnOnContraband: true,
    });
    if (!result.success) {
      if (result.errorMsg === "SHIP_CONTRABAND_WARNING_UNDOCK") {
        // base.py _DoUndockAttempt shows this dialog and, on OK, calls Undock
        // again with ignoreContraband set. Nothing has been changed yet.
        log.info(
          `[Ship] Undock held for the contraband warning char=${session && session.characterID}`,
        );
        throwWrappedUserError(
          ...buildUndockContrabandWarningArguments(
            result.data && result.data.contraband,
          ),
        );
      }
      log.warn(
        `[Ship] Undock failed for char=${session && session.characterID}: ${result.errorMsg}`,
      );
      return null;
    }

    // The AIR tutorial creates a scene's private site (1.4 item retrieval, 2.1 mining) only
    // while the pilot is in space, and its check otherwise runs only at login or when the client
    // asks for its tutorial state. A scene that started while docked would have no site after
    // undocking, and its "Warp to Site" button would silently do nothing. The ship is in space
    // now (undockSession attached it): run the check.
    const tutorialState = require("../character/characterState")
      .getCharacterRecord(session && session.characterID)?.authoredAirTutorial;
    if (tutorialState && tutorialState.status === "active") {
      require("../npe/airNpeRuntime").ensureForSession(session).catch((error) => {
        log.warn(
          `[Ship] AIR tutorial check after undock failed for char=${session && session.characterID}: ${error.message}`,
        );
      });
    }

    // None, the bind's object beside it, as Tranquility answers every undock (twenty-six of them in the recordings:
    // ship::MachoBindObject((stationID, 15), ('Undock', ...)), retval=(<RemoteObject>, None)). The client takes no
    // answer from it (station/base.py _DoUndockAttempt, through sessionMgr.PerformSessionChange).
    return null;
  }

  Handle_Eject(args, session, kwargs) {
    log.info("[Ship] Eject()");
    if (session && !isDockedSession(session)) {
      assertAbyssalShipSwapAllowed(session, "eject");
      const transitionResult = ejectSession(session);
      if (!transitionResult.success) {
        log.warn(
          `[Ship] Eject failed in space for char=${session && session.characterID}: ${transitionResult.errorMsg}`,
        );
        throwEjectRefusal(transitionResult.errorMsg);
        return null;
      }
      return null;
    }
    return this._leaveShip(session, null, "Eject");
  }

  Handle_GetTurretModules(args, session, kwargs) {
    log.debug("[Ship] GetTurretModules");
    const charID = session && session.characterID ? session.characterID : 0;
    const shipID = this._getShipID(session);
    return {
      type: "list",
      items: getTurretLikeModuleItems(charID, shipID).map((item) => item.itemID),
    };
  }

  async Handle_SetShipPassword(args, session) {
    // playerOwned.py:182-190 invokes this on the bound active-ship service.
    const [password] = unwrapMarshalValue(args);
    const result = await require("../starbase/starbaseAccessRuntime").setShipPassword(session, password);
    if (!result.success) {
      throwWrappedUserError("CustomNotify", {
        notify: result.errorMsg === "STARBASE_PASSWORD_INVALID"
          ? "The starbase password cannot exceed 50 characters."
          : "You must be piloting a ship in space to set its starbase password.",
      });
    }
    if (result.data.superseded) {
      return null;
    }
    require("./controlTowerRuntime").refreshStarbaseHarmonicPresentation(
      result.data.shipID || this._getShipID(session),
      { harmonic: result.data.harmonic },
    );
    return null;
  }

  Handle_GetShipConfiguration(args, session, kwargs) {
    const shipID =
      args && args.length > 0 ? args[0] : this._getShipID(session);
    log.debug(`[Ship] GetShipConfiguration(shipID=${String(shipID)})`);
    const configuration = this._getShipConfiguration(shipID);
    const normalizedConfiguration = this._normalizeShipConfiguration(configuration);
    Object.assign(configuration, normalizedConfiguration);
    return {
      type: "dict",
      entries: [
        ["allowFleetSMBUsage", normalizedConfiguration.allowFleetSMBUsage],
        ["SMB_AllowFleetAccess", normalizedConfiguration.SMB_AllowFleetAccess],
        ["allowCorpSMBUsage", normalizedConfiguration.allowCorpSMBUsage],
        ["SMB_AllowCorpAccess", normalizedConfiguration.SMB_AllowCorpAccess],
        [
          "FleetHangar_AllowFleetAccess",
          normalizedConfiguration.FleetHangar_AllowFleetAccess,
        ],
        [
          "FleetHangar_AllowCorpAccess",
          normalizedConfiguration.FleetHangar_AllowCorpAccess,
        ],
      ],
    };
  }

  Handle_ConfigureShip(args, session, kwargs) {
    const configPayload =
      args && args.length > 0 && args[0] && typeof args[0] === "object"
        ? args[0]
        : null;
    const shipID = this._getShipID(session);
    const configuration = this._getShipConfiguration(shipID);

    if (configPayload && configPayload.type === "dict" && Array.isArray(configPayload.entries)) {
      for (const [rawKey, value] of configPayload.entries) {
        // Python 2 str keys normally arrive from the marshal decoder as
        // Buffers. Normalize them before comparison or every live toggle is
        // silently ignored while string-keyed unit fixtures appear to work.
        const key = normalizeText(rawKey, "");
        if (key === "allowFleetSMBUsage" || key === "SMB_AllowFleetAccess") {
          const normalizedValue = normalizeBoolean(value);
          configuration.allowFleetSMBUsage = normalizedValue;
          configuration.SMB_AllowFleetAccess = normalizedValue;
        } else if (key === "allowCorpSMBUsage" || key === "SMB_AllowCorpAccess") {
          const normalizedValue = normalizeBoolean(value);
          configuration.allowCorpSMBUsage = normalizedValue;
          configuration.SMB_AllowCorpAccess = normalizedValue;
        } else if (key === "FleetHangar_AllowFleetAccess") {
          configuration.FleetHangar_AllowFleetAccess = normalizeBoolean(value);
        } else if (key === "FleetHangar_AllowCorpAccess") {
          configuration.FleetHangar_AllowCorpAccess = normalizeBoolean(value);
        }
      }
    } else if (configPayload && typeof configPayload === "object") {
      if (
        Object.prototype.hasOwnProperty.call(configPayload, "allowFleetSMBUsage") ||
        Object.prototype.hasOwnProperty.call(configPayload, "SMB_AllowFleetAccess")
      ) {
        const normalizedValue = normalizeBoolean(
          Object.prototype.hasOwnProperty.call(configPayload, "SMB_AllowFleetAccess")
            ? configPayload.SMB_AllowFleetAccess
            : configPayload.allowFleetSMBUsage,
        );
        configuration.allowFleetSMBUsage = normalizedValue;
        configuration.SMB_AllowFleetAccess = normalizedValue;
      }
      if (
        Object.prototype.hasOwnProperty.call(configPayload, "allowCorpSMBUsage") ||
        Object.prototype.hasOwnProperty.call(configPayload, "SMB_AllowCorpAccess")
      ) {
        const normalizedValue = normalizeBoolean(
          Object.prototype.hasOwnProperty.call(configPayload, "SMB_AllowCorpAccess")
            ? configPayload.SMB_AllowCorpAccess
            : configPayload.allowCorpSMBUsage,
        );
        configuration.allowCorpSMBUsage = normalizedValue;
        configuration.SMB_AllowCorpAccess = normalizedValue;
      }
      if (Object.prototype.hasOwnProperty.call(configPayload, "FleetHangar_AllowFleetAccess")) {
        configuration.FleetHangar_AllowFleetAccess = normalizeBoolean(
          configPayload.FleetHangar_AllowFleetAccess,
        );
      }
      if (Object.prototype.hasOwnProperty.call(configPayload, "FleetHangar_AllowCorpAccess")) {
        configuration.FleetHangar_AllowCorpAccess = normalizeBoolean(
          configPayload.FleetHangar_AllowCorpAccess,
        );
      }
    }

    const normalizedConfiguration = this._normalizeShipConfiguration(configuration);
    Object.assign(configuration, normalizedConfiguration);

    this._persistShipConfiguration(shipID, configuration);

    log.debug(
      `[Ship] ConfigureShip(shipID=${String(shipID)} allowFleetSMBUsage=${configuration.allowFleetSMBUsage} SMB_AllowFleetAccess=${configuration.SMB_AllowFleetAccess} FleetHangar_AllowFleetAccess=${configuration.FleetHangar_AllowFleetAccess} allowCorpSMBUsage=${configuration.allowCorpSMBUsage} SMB_AllowCorpAccess=${configuration.SMB_AllowCorpAccess} FleetHangar_AllowCorpAccess=${configuration.FleetHangar_AllowCorpAccess})`,
    );
    return null;
  }

  async Handle_SelfDestruct(args, session) {
    const runtime = require("./selfDestructRuntime");
    const result = await runtime.startShipSelfDestruct(session, unwrapMarshalValue(args && args[0]));
    if (!result.success) throwWrappedUserError("CustomNotify", { notify: result.errorMsg });
    return null;
  }

  Handle_AbortSelfDestruct(args, session) {
    const result = require("./selfDestructRuntime").abortShipSelfDestruct(session, unwrapMarshalValue(args && args[0]));
    if (!result.success) throwWrappedUserError("CustomNotify", { notify: result.errorMsg });
    return null;
  }

  Handle_SafeLogoff(args, session, kwargs) {
    log.info(
      `[Ship] SafeLogoff requested for char=${session ? session.characterID : "?"} ship=${session ? this._getShipID(session) : "?"}`,
    );

    // The live client treats the SafeLogoff response as an iterable of failed
    // condition labels. Returning an empty list means "all checks passed".
    const result = require("./safeLogoffRuntime").prepareStart(session);
    if (!result.success) {
      log.warn(`[Ship] SafeLogoff refused: ${result.errorMsg}`);
      const messages = {
        SAFE_LOGOFF_LIVE_SESSION_REQUIRED: "Your character is no longer connected. Select your character again.",
        SAFE_LOGOFF_NOT_IN_SPACE: "You must be in space to log off safely.",
        SAFE_LOGOFF_SHIP_AUTHORITY_MISMATCH: "Your current ship is changing. Try safe logoff again.",
      };
      throwWrappedUserError("CustomNotify", { notify: messages[result.errorMsg] || "Safe logoff could not start. Try again." });
    }
    return result.data;
  }

  Handle_AbortSafeLogoff(args, session) {
    require("./safeLogoffRuntime").abort(session, { notify: false });
    return null;
  }

  Handle_MachoResolveObject(args, session, kwargs) {
    const bindParameter = args && args[0];
    void bindParameter;
    log.debug("[Ship] MachoResolveObject called");
    return PROXY_NODE_ID;
  }

  Handle_MachoBindObject(args, session, kwargs) {
    const config = require(path.join(__dirname, "../../config"));
    const bindParams = args && args.length > 0 ? args[0] : null;
    const nestedCall = args && args.length > 1 ? args[1] : null;

    log.debug(
      `[Ship] MachoBindObject args.length=${args ? args.length : 0} bindParams=${JSON.stringify(bindParams, (k, v) => (typeof v === "bigint" ? v.toString() : v))} nestedCall=${JSON.stringify(nestedCall, (k, v) => (typeof v === "bigint" ? v.toString() : Buffer.isBuffer(v) ? v.toString("utf8") : v))}`,
    );

    const boundId = config.getNextBoundId();
    const idString = `N=${PROXY_NODE_ID}:${boundId}`;
    const now = BigInt(Date.now()) * 10000n + 116444736000000000n;
    const oid = [idString, now];

    if (session) {
      if (!session._boundObjectIDs || typeof session._boundObjectIDs !== "object") {
        session._boundObjectIDs = {};
      }
      session._boundObjectIDs.ship = idString;
      session.lastBoundObjectID = idString;
    }

    let callResult = null;
    if (nestedCall && Array.isArray(nestedCall) && nestedCall.length >= 1) {
      const methodName = normalizeMethodName(nestedCall[0]);
      const callArgs = nestedCall.length > 1 ? nestedCall[1] : [];
      const callKwargs = nestedCall.length > 2 ? nestedCall[2] : null;

      log.debug(`[Ship] MachoBindObject nested call: ${methodName}`);
      callResult = this.callMethod(
        methodName,
        Array.isArray(callArgs) ? callArgs : [callArgs],
        session,
        callKwargs,
      );
    }

    return [
      {
        type: "substruct",
        value: { type: "substream", value: oid },
      },
      callResult != null ? callResult : null,
    ];
  }

  _isSafeLogoffRequest(methodName, context = {}) {
    if (methodName === "SafeLogoff") {
      return true;
    }

    if (methodName !== "MachoBindObject") {
      return false;
    }

    const nestedCall =
      context &&
      Array.isArray(context.args) &&
      context.args.length > 1
        ? context.args[1]
        : null;
    if (!Array.isArray(nestedCall) || nestedCall.length === 0) {
      return false;
    }

    return normalizeMethodName(nestedCall[0]) === "SafeLogoff";
  }

  _extractSafeLogoffFailedConditions(methodName, context = {}) {
    if (methodName === "SafeLogoff") {
      return Array.isArray(context.result) ? context.result : null;
    }

    if (methodName !== "MachoBindObject" || !Array.isArray(context.result)) {
      return null;
    }

    return Array.isArray(context.result[1]) ? context.result[1] : null;
  }

  afterCallResponse(methodName, session, context = {}) {
    if (!this._isSafeLogoffRequest(methodName, context)) {
      return;
    }

    const failedConditions = this._extractSafeLogoffFailedConditions(
      methodName,
      context,
    );
    if (!Array.isArray(failedConditions) || failedConditions.length > 0) {
      return;
    }

    require("./safeLogoffRuntime").startAfterResponse(session, failedConditions);
  }

  afterCallFailure(methodName, session, context = {}) {
    if (this._isSafeLogoffRequest(methodName, context) && session?._safeLogoff?.state === "staged")
      require("./safeLogoffRuntime").abort(session, { notify: false });
  }

}

ShipService._testing = {
  assertAbyssalShipSwapAllowed,
  getActiveAbyssalShipSwapRestriction,
};

module.exports = ShipService;
