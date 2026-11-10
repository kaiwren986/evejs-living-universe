"use strict";
const { getSessionCorporationRoleMask, getCorporationRolesAtLocation } = require("../corporation/corporationRoleChecks");

/**
 * Inventory Broker Service (invbroker)
 *
 * Handles inventory/item queries from the client.
 * Called after character selection to load inventory data.
 */

const path = require("path");
const { resolveDataRootPath } = require(path.join(__dirname, "../../config/dataRoot"));
const { PROXY_NODE_ID } = require(path.join(__dirname, "../../network/protocolProfile"));
const BaseService = require(path.join(__dirname, "../baseService"));
const log = require(path.join(__dirname, "../../utils/logger"));
const rotatingLog = require(path.join(__dirname, "../../utils/rotatingLog"));
const {
  resolveSessionCharacterID,
} = require(path.join(__dirname, "../_shared/sessionIdentity"));
const { toClientSafeDisplayName } = require(path.join(
  __dirname,
  "../_shared/clientNameUtils",
));
const { throwWrappedUserError } = require(path.join(
  __dirname,
  "../../common/machoErrors",
));
const { resolveShipByTypeID } = require(path.join(
  __dirname,
  "../chat/shipTypeRegistry",
));
const {
  getCharacterShips,
  getCharacterRecord,
  findCharacterShip,
  getActiveShipRecord,
  shouldFlushDeferredDockedShipSessionChange,
  flushDeferredDockedShipSessionChange,
  completeDockedFittingBootstrap,
  syncInventoryItemForSession,
  syncShipFittingStateForSession,
  emitItemsChangedBatchForSession,
  emitFittingTransactionForSession,
  buildInventoryDogmaPrimeEntry,
  buildLocationChangePayload,
  isItemNamingChange,
} = require(path.join(__dirname, "../character/characterState"));
const {
  ITEM_MOVE_ERROR,
  ITEM_FLAGS,
  CLIENT_INVENTORY_STACK_LIMIT,
  FIGHTER_TUBE_FLAGS,
  buildCreatedItemNotificationPreviousState,
  buildRemovedItemNotificationState,
  listContainerItems,
  findItemById,
  findShipItemById,
  findStarbaseItemById,
  getItemMetadata,
  hasStarbaseItems,
  getInventoryItemUnitVolume,
  grantItemToCharacterLocation,
  isStackableInventoryItem,
  takeItemTypeFromCharacterLocation,
  updateInventoryItem,
  validateItemMoveToLocation,
  createInventoryMoveBatch,
} = require(path.join(__dirname, "./itemStore"));
const invBrokerItemCustody = require(path.join(__dirname, "./invBrokerItemCustody"));
const { getRescueDestination, limitRescueCargoQuantity } = require("./missionRescueCargo");
const fracturedLegacyCargo = require("./fracturedLegacyCargo");
const incursionCargo = require("../incursion/incursionCargo");
const incursionFactoryCustody = require("./incursionFactoryCustody");
const deliveryItemCustody = require(path.join(__dirname, "./deliveryItemCustody"));
const itemCustody = require(path.join(__dirname, "./itemCustody"));
const hackingContainerState = require(path.join(
  __dirname,
  "../exploration/hackingContainerState",
));
const {
  registerCorporationOfficeObserverSource,
} = require(path.join(__dirname, "./corporationOfficeInventoryObservers"));
const {
  CORP_ROLE_ACCOUNTANT,
  CORP_ROLE_DIRECTOR,
  CORP_ROLE_JUNIOR_ACCOUNTANT,
  CORP_ROLE_PROJECT_MANAGER,
  CORP_ROLE_TRADER,
  getCorporationOfficeByInventoryID,
  getCorporationOffices,
} = require(path.join(__dirname, "../corporation/corporationRuntimeState"));
const {
  resolveItemByTypeID,
} = require(path.join(__dirname, "./itemTypeRegistry"));
const {
  isShipFittingFlag,
  listFittedItems,
  listFittedItemsForLocation,
  selectAutoFitFlagForType,
  validateFitForShip,
  resolveFitOnlineState,
  getShipBaseAttributeValue,
  getTypeAttributeValue,
  getTypeDogmaAttributes,
  getLoadedChargeByFlag,
  getFittedModuleByFlag,
  getLoadedChargeItems,
  buildChargeTupleItemID,
  getModuleChargeCapacity,
  isChargeCompatibleWithModule,
  SLOT_FAMILY_FLAGS,
  getRequiredSlotFamily,
  getSlotFlagsForFamily,
  getShipHardpointCounts,
  getFittedEffectSlotsUsed,
  getItemEffectSlotUsage,
  typeHasEffectName,
  isStrategicCruiserType,
} = require(path.join(__dirname, "../fitting/liveFittingState"));
const {
  getShipFittingSnapshot,
  getCargoOverflowWithoutItems,
} = require(path.join(__dirname, "../../_secondary/fitting/fittingRuntime"));
const {
  clearModuleFromBanksAndNotify,
  getMasterModuleID: getWeaponBankMasterModuleID,
  notifyWeaponBanksChanged,
  getShipWeaponBanks,
} = require(path.join(__dirname, "../moduleGrouping/moduleGroupingRuntime"));
const {
  MINING_SHIP_BAY_FLAGS,
  isItemTypeAllowedInHoldFlag,
  getShipHoldCapacityByFlag,
} = require(path.join(__dirname, "../mining/miningInventory"));
const {
  isFuelBayFlag,
  isStructureFuelBayFlag,
  isFuelBayCompatibleItem,
  isStructureFuelBayCompatibleItem,
  getFuelBayCapacity,
  STRUCTURE_FUEL_BAY_FLAG,
  TYPE_UPWELL_AUTO_MOON_MINER,
} = require(path.join(__dirname, "./fuelBayInventory"));
const {
  getFleetHangarCapacity,
} = require(path.join(__dirname, "./fleetHangarInventory"));
const sessionRegistry = require(path.join(__dirname, "../chat/sessionRegistry"));
const {
  SPECIAL_SHIP_HOLD_FLAGS,
  isSpecialShipHoldFlag,
  isGenericSpecialShipHoldFlag,
  isSpecialShipHoldItemAllowed,
  getSpecialShipHoldRestrictionMessage,
  getSpecialShipHoldCapacity,
} = require(path.join(__dirname, "./specialShipHoldRegistry"));
const {
  validateShipMaintenanceBayItem,
} = require(path.join(__dirname, "./shipMaintenanceBayInventory"));
const {
  canLoadFighterTypeIntoHostTube,
  isDroneItemRecord,
  isFighterItemRecord,
  isFighterTubeFlag,
  listHostFighterOccupancy,
} = require(path.join(__dirname, "../fighter/fighterInventory"));
const runtime = require(path.join(__dirname, "../../space/runtime"));
const {
  SCENE_KIND_SOLAR_SYSTEM,
  buildSolarSystemSceneKey,
  normalizeSceneDescriptor,
} = require("../../space/runtime/sceneIdentity");
const starbaseInventoryRuntime = require("../starbase/starbaseInventoryRuntime");
const starbaseProcessingInventory = require("../starbase/starbaseProcessingInventory");
const worldData = require(path.join(__dirname, "../../space/worldData"));
const nativeNpcStore = require(path.join(__dirname, "../../space/npc/nativeNpcStore"));
const { isMaterializedMissionCargoContainer } = require("./materializedMissionCargoContainer");
const nativeNpcWreckService = require(path.join(__dirname, "../../space/npc/nativeNpcWreckService"));
const {
  canEntitiesInteractLocally,
  resolveEntityInteractionScope,
} = require(path.join(
  __dirname,
  "../../space/destiny/identity/interactionScope",
));
const {
  maybeExpireEmptySpaceContainer,
} = require(path.join(__dirname, "../ship/jettisonRuntime"));
const {
  isCargoContainerType,
  isSecureCargoContainerType,
  isStationOnlyCargoContainerType,
  getSecureContainerState,
  stripLegacySecureContainerStateFromCustomInfo,
  touchAnchoredCargoContainerContents,
  GROUP_AUDIT_LOG_SECURE_CONTAINER,
  SCC_PASSWORD_TYPE_GENERAL,
  SCC_PASSWORD_TYPE_CONFIG,
  ALSC_PASSWORD_NEEDED_TO_OPEN,
  ALSC_LOCK_ADDED_ITEMS,
  ALSC_CONFIG_MASK,
  SECURE_CONTAINER_PASSWORD_MAX_LENGTH,
  MAX_CARGO_CONTAINER_TRANSFER_DISTANCE_METERS,
  isStarbaseCorporateHangarArrayType,
} = require(path.join(__dirname, "../ship/cargoContainerRuntime"));
const {
  evaluateCumulativeCapacity,
  isDisposableJetcanRecord,
} = require(path.join(__dirname, "./cargoLootAuthority"));
const {
  buildSpaceLootSourceFromItem,
  commitSpaceLootTheft,
  compensateSpaceLootTheft,
  evaluateSpaceLootAccess,
  recordSpaceLootTheft,
  sessionHasSpaceLootRight,
} = require(path.join(__dirname, "../_shared/spaceLootEntitlement"));
const dungeonUniverseSiteService = require(path.join(
  __dirname,
  "../dungeon/dungeonUniverseSiteService",
));
const {
  DEFAULT_STATION,
  getStationRecord,
} = require(path.join(__dirname, "../_shared/stationStaticData"));
const structureState = require(path.join(
  __dirname,
  "../structure/structureState",
));
const assetSafetyState = require(path.join(
  __dirname,
  "../structure/structureAssetSafetyState",
));
const {
  STRUCTURE_FAMILY,
  STRUCTURE_SERVICE_ID,
  STRUCTURE_STATE,
} = require(path.join(__dirname, "../structure/structureConstants"));
const {
  isStructureServiceSlotFlag,
  syncStructureServiceModuleState,
  tryAutoOnlineFittedStructureServiceModule,
} = require(path.join(__dirname, "../structure/structureServiceModules"));
const {
  buildCrpAccessDeniedInsufficientRolesValues,
  characterCanDisableStructureServiceModule,
  isStructureReactionServiceModuleType,
  STRUCTURE_SETTING_ID,
} = require(path.join(__dirname, "../structure/structureServiceAuthority"));
const {
  canTakeFromCorporationHangarDivision,
} = require(path.join(__dirname, "../industry/industryAccess"));
const {
  canTakeFromCorporationHangarForInventory,
} = require(path.join(__dirname, "./invBroker/corporationHangarTakeAccess"));
const {
  characterHasStructureSetting,
  characterHasStructureService,
} = require(path.join(__dirname, "../structure/structurePayloads"));
const {
  cancelIndustryJobsForRemovedServiceModule,
} = require(path.join(__dirname, "../structure/structureIndustryJobs"));
const {
  getCharacterSkills,
  SKILL_FLAG_ID,
} = require(path.join(__dirname, "../skills/skillState"));
const {
  describeSessionHydrationState,
} = require(path.join(__dirname, "../chat/commandSessionEffects"));
const {
  getDockedLocationID,
  isDockedSession,
} = require(path.join(__dirname, "../structure/structureLocation"));
const {
  buildDict,
  buildList,
  buildObjectEx1,
  buildPackedRow,
  buildPackedRowDescriptor,
  buildMarshalReal,
  currentFileTime,
  normalizeBigInt,
  unwrapMarshalValue,
} = require(path.join(__dirname, "../_shared/serviceHelpers"));
const { strVal } = require(path.join(
  __dirname,
  "../../network/tcp/utils/marshal",
));
const planetStaticData = require(path.join(
  __dirname,
  "../planet/planetStaticData",
));
const planetOrbitalState = require(path.join(
  __dirname,
  "../planet/planetOrbitalState",
));
const fleetRuntime = require(path.join(__dirname, "../fleets/fleetRuntime"));
const {
  MOBILE_DEPOT_CARGO_ACCESS_RANGE_METERS,
  MOBILE_DEPOT_FITTING_RANGE_METERS,
  validateMobileDepotCargoAccess,
  validateMobileDepotFittingAccess,
} = require(path.join(__dirname, "../ship/mobileDepotRuntime"));
const {
  MOBILE_TRACTOR_UNIT_SCOOP_RANGE_METERS,
  validateMobileTractorUnitCargoAccess,
} = require(path.join(__dirname, "../ship/mobileTractorUnitRuntime"));
const {
  SHIP_FITTING_SERVICE_RANGE_METERS,
  isShipMaintenanceArraySource,
  isShipMaintenanceBaySource,
  validateMaintenanceFittingServiceAccess,
} = require(path.join(__dirname, "../ship/ejectRuntime"));
const {
  isShipServiceFlag,
  validateShipServiceAccess,
} = require(path.join(__dirname, "../ship/shipServiceAccess"));
const {
  normalizeShipNameLabel,
} = require(path.join(__dirname, "../ship/shipNameUtils"));

const inventoryDebugPath = resolveDataRootPath("logs", "inventory-debug.log");

const ALSC_AUDIT_LOG_RETENTION_TICKS = 21n * 24n * 60n * 60n * 10000000n;
const ALSC_AUDIT_LOG_MAX_ENTRIES = 10000;
const ALSC_ACTION_SET_NAME = 3;
const ALSC_ACTION_LOCK = 7;
const CONTAINER_HANGAR_ID = 10004;
const CONTAINER_CORP_MARKET_ID = 10012;
const CONTAINER_STRUCTURE_ID = 10014;
const CONTAINER_CAPSULEER_DELIVERIES_ID = 10015;
const CHARACTER_TYPE_ID = 1373;
const CHARACTER_GROUP_ID = 1;
const CHARACTER_CATEGORY_ID = 3;
const STATION_TYPE_ID = DEFAULT_STATION.stationTypeID;
const STATION_GROUP_ID = 15;
const STATION_CATEGORY_ID = 3;
const STATION_OWNER_ID = DEFAULT_STATION.ownerID;
const CATEGORY_DEPLOYABLE = 22;
const GROUP_MOBILE_TRACTOR_UNIT = 1250;
const PLASTIC_WRAP_TYPE_ID = 3468;
const USER_ERROR_FORMAT_GROUP_ID = 7; // eveexceptions.const.UE_GROUPID
const INVENTORY_ROW_HEADER = {
  type: "list",
  items: [
    "itemID",
    "typeID",
    "ownerID",
    "locationID",
    "flagID",
    "quantity",
    "groupID",
    "categoryID",
    "customInfo",
    "stacksize",
    "singleton",
  ],
};
const INVENTORY_ROW_DESCRIPTOR_COLUMNS = [
  ["itemID", 20],
  ["typeID", 3],
  ["ownerID", 3],
  ["locationID", 20],
  ["flagID", 2],
  ["quantity", 3],
  ["groupID", 3],
  ["categoryID", 3],
  ["customInfo", 129],
];
const INVENTORY_ROW_DESCRIPTOR_VIRTUAL_COLUMNS = [
  ["stacksize", { type: "token", value: "eve.common.script.sys.eveCfg.StackSize" }],
  ["singleton", { type: "token", value: "eve.common.script.sys.eveCfg.Singleton" }],
];
const CHARGE_SUBLOCATION_ROW_DESCRIPTOR_COLUMNS = [
  ["itemID", 129],
  ["typeID", 3],
  ["ownerID", 3],
  ["locationID", 20],
  ["flagID", 2],
  ["quantity", 3],
  ["groupID", 3],
  ["categoryID", 3],
  ["customInfo", 129],
];
const SHIP_BAY_FLAGS = new Set([
  ITEM_FLAGS.HANGAR,
  ITEM_FLAGS.CARGO_HOLD,
  ITEM_FLAGS.FUEL_BAY,
  ITEM_FLAGS.DRONE_BAY,
  ITEM_FLAGS.FIGHTER_BAY,
  ITEM_FLAGS.SHIP_HANGAR,
  ITEM_FLAGS.FLEET_HANGAR,
  ITEM_FLAGS.MOBILE_DEPOT_HOLD,
  ITEM_FLAGS.SPECIALIZED_COMMAND_CENTER_HOLD,
  ITEM_FLAGS.COLONY_RESOURCES_HOLD,
  ...FIGHTER_TUBE_FLAGS,
  ...MINING_SHIP_BAY_FLAGS,
  ...SPECIAL_SHIP_HOLD_FLAGS,
]);
const CORP_HANGAR_FLAGS = new Set([115, 116, 117, 118, 119, 120, 121, 184]);
const CORP_HANGAR_QUERY_ROLE_BY_FLAG = new Map([
  [115, 1048576n],
  [116, 2097152n],
  [117, 4194304n],
  [118, 8388608n],
  [119, 16777216n],
  [120, 33554432n],
  [121, 67108864n],
]);
const CORP_HANGAR_BROADCAST_IDTYPE = "*corpid&corprole&solarsystemid";
const {
  buildOwnerTransferIdempotencyKey,
} = require(path.join(__dirname, "./invBroker/ownerTransferIdempotencyKey"));

const OFFICE_TYPE_ID = 27;
const OFFICE_GROUP_ID = 16;
const OFFICE_CATEGORY_ID = 3;
const FLAG_OFFICE_FOLDER = 2;
const STRUCTURE_DEED_GROUP_ID = 4086;
const MOBILE_DEPOT_GROUP_ID = 1246;
const MOBILE_DEPOT_HOLD_CAPACITY_ATTRIBUTE = "specialMobileDepotHoldCapacity";
const TYPE_STANDUP_MOON_DRILL = 45009;
const SECURITY_CLASS_ZERO_SEC = 0;
const SECURITY_CLASS_LOW_SEC = 1;
const SECURITY_CLASS_HIGH_SEC = 2;
const ATTRIBUTE_DISALLOW_IN_EMPIRE_SPACE = "disallowInEmpireSpace";
const ATTRIBUTE_DISALLOW_IN_HIGH_SEC = "disallowInHighSec";
const INTEGRATED_STRUCTURE_SERVICE_MODULE_TYPE_IDS = new Set([
  35912,
  35913,
  35914,
  82941,
]);
const CHARGE_CATEGORY_ID = 8;
const SHIP_CATEGORY_ID = 6;
const STRUCTURE_CATEGORY_ID = 65;
const IN_SPACE_FITTING_ACCESS_ERROR_PRIORITY = Object.freeze({
  POS_MAINTENANCE_ARRAY_ACCESS_DENIED: 70,
  MOBILE_DEPOT_REINFORCED: 60,
  TARGET_TOO_FAR: 50,
  MOBILE_DEPOT_NOT_ACTIVE: 40,
  MOBILE_DEPOT_NOT_IN_SPACE: 30,
  MOBILE_DEPOT_STATE_NOT_FOUND: 20,
  MOBILE_DEPOT_NOT_OWNER: 10,
  MOBILE_DEPOT_FITTING_SERVICE_NOT_AVAILABLE: 5,
  IN_SPACE_FITTING_SERVICE_NOT_AVAILABLE: 5,
});
const FLAG_MOON_MATERIAL_BAY = 186;
const ATTRIBUTE_OUTPUT_MOON_MATERIAL_BAY_CAPACITY = 5693;
const CORP_ROLE_STATION_MANAGER = 2048n;
const STRUCTURE_OWNER_BAY_FLAGS = new Set([
  ITEM_FLAGS.CARGO_HOLD,
  ITEM_FLAGS.FIGHTER_BAY,
  ...FIGHTER_TUBE_FLAGS,
  ...SLOT_FAMILY_FLAGS.low,
  ...SLOT_FAMILY_FLAGS.med,
  ...SLOT_FAMILY_FLAGS.high,
  ...SLOT_FAMILY_FLAGS.rig,
  ...SLOT_FAMILY_FLAGS.subsystem,
  ...SLOT_FAMILY_FLAGS.service,
  ITEM_FLAGS.STRUCTURE_DEED,
  STRUCTURE_FUEL_BAY_FLAG,
]);
const STRUCTURE_UNANCHOR_HULL_MARKER_PATTERN =
  /^evejs:structure-unanchor:hull:(\d+)$/;
const STRUCTURE_UNANCHOR_CONTAINER_MARKER_PATTERN =
  /^evejs:structure-unanchor:(?:fittings:(\d+)(?::core-complete)?|assets:(\d+):owner:\d+|office:(\d+):office:\d+)$/;

function isUnanchoredStructureHullInventoryRecord(item) {
  const markerMatch = STRUCTURE_UNANCHOR_HULL_MARKER_PATTERN.exec(
    String(item && item.customInfo || ""),
  );
  return Boolean(
    item &&
    markerMatch &&
    Number(item.typeID) > 0 &&
    Number(markerMatch[1]) > 0 &&
    Number(item.categoryID) === STRUCTURE_CATEGORY_ID &&
    Number(item.singleton) === 1 &&
    Number(item.launcherID) === Number(markerMatch[1])
  );
}

function isDirectSpaceUnanchoredStructureHullInventoryRecord(item) {
  const locationID = Number(item && item.locationID) || 0;
  return Boolean(
    isUnanchoredStructureHullInventoryRecord(item) &&
    locationID > 0 &&
    Number(item.flagID) === 0 &&
    item.spaceState &&
    Number(item.spaceState.systemID) === locationID
  );
}

function getStructureUnanchorContainerSourceStructureID(item) {
  const markerMatch = STRUCTURE_UNANCHOR_CONTAINER_MARKER_PATTERN.exec(
    String(item && item.customInfo || ""),
  );
  if (!markerMatch) {
    return 0;
  }
  return markerMatch
    .slice(1)
    .map((value) => Number(value) || 0)
    .find((value) => value > 0) || 0;
}

function isMobileDepotItemRecord(item) {
  if (!item) {
    return false;
  }
  const typeRecord = resolveItemByTypeID(item.typeID) || {};
  return Number(item.groupID || typeRecord.groupID) === MOBILE_DEPOT_GROUP_ID;
}

function appendInventoryDebug(entry) {
  if (!log.isVerboseDebugEnabled()) {
    return;
  }
  try {
    rotatingLog.append(inventoryDebugPath, `[${new Date().toISOString()}] ${entry}\n`);
  } catch (error) {
    log.warn(`[InvBroker] Failed to write inventory debug log: ${error.message}`);
  }
}

// Loading a charge into a fitting slot is dogma's contract, not a plain
// inventory move (see _emitFittedChargeLoadChanges). Reuse dogmaService's
// notification helpers rather than restating them here so the two entry points
// cannot drift. Lazily required: dogmaService is loaded on demand, mirroring
// scanMgrService's dogmaNotificationHelper, and the constructor is side-effect
// free (super("dogmaIM") only).
let dogmaChargeNotificationHelper = null;
function getDogmaChargeNotificationHelper() {
  if (!dogmaChargeNotificationHelper) {
    const DogmaService = require(path.join(__dirname, "../dogma/dogmaService"));
    dogmaChargeNotificationHelper = new DogmaService();
  }
  return dogmaChargeNotificationHelper;
}

class InvBrokerService extends BaseService {
  constructor() {
    super("invbroker");
    this._boundContexts = new Map();
    // The corporation office fan-out walks this instance's bound contexts, so
    // the writers outside invbroker can only publish through a live instance.
    registerCorporationOfficeObserverSource(this);
    this._startAssetSafetyRecovery();
  }

  _getStationId(session) {
    return getDockedLocationID(session) || 0;
  }

  _isUnanchoredStructureHullInventoryID(inventoryID) {
    const numericInventoryID = this._normalizeInventoryId(inventoryID, 0);
    return (
      numericInventoryID > 0 &&
      isUnanchoredStructureHullInventoryRecord(
        findItemById(numericInventoryID),
      )
    );
  }

  _throwUnanchoredStructureHullInventoryError() {
    throwWrappedUserError("CustomNotify", {
      notify:
        "An unanchored structure hull is a scoopable item, not a cargo container. " +
        "While it is in space, move within range and use Scoop to Cargo Hold.",
    });
  }

  _getPendingStructureUnanchorContainerAncestor(itemOrItemID) {
    let currentItem =
      itemOrItemID && typeof itemOrItemID === "object"
        ? itemOrItemID
        : findItemById(this._normalizeInventoryId(itemOrItemID, 0));
    const seen = new Set();

    while (currentItem) {
      const currentItemID = this._normalizeInventoryId(currentItem.itemID, 0);
      if (currentItemID > 0 && seen.has(currentItemID)) {
        break;
      }
      if (currentItemID > 0) {
        seen.add(currentItemID);
      }

      const structureID =
        getStructureUnanchorContainerSourceStructureID(currentItem);
      if (
        structureID > 0 &&
        structureState.getStructureByID(structureID, { refresh: false })
      ) {
        return currentItem;
      }

      const parentID = this._normalizeInventoryId(currentItem.locationID, 0);
      if (parentID <= 0 || seen.has(parentID)) {
        break;
      }
      currentItem = findItemById(parentID);
    }

    return null;
  }

  _isPendingStructureUnanchorContainerInventoryID(inventoryID) {
    return Boolean(
      this._getPendingStructureUnanchorContainerAncestor(inventoryID),
    );
  }

  _throwPendingStructureUnanchorContainerInventoryError() {
    throwWrappedUserError("CustomNotify", {
      notify:
        "This unanchor container is still being finalized. " +
        "Wait for the structure unanchor to complete before opening or moving it.",
    });
  }

  _getCharacterId(session) {
    return resolveSessionCharacterID(session);
  }

  _getCorporationId(session) {
    return (
      (session && (session.corporationID || session.corpid)) ||
      0
    );
  }

  _getSessionCorpRoleMask(session) {
    return getSessionCorporationRoleMask(session);
  }

  _canQueryCorporationHangarFlag(session, flagID) {
    const numericFlag = this._normalizeInventoryId(flagID, 0);
    const requiredRole = CORP_HANGAR_QUERY_ROLE_BY_FLAG.get(numericFlag);
    if (!requiredRole) {
      return true;
    }
    const roleMask = this._getSessionCorpRoleMask(session);
    return (
      (roleMask & CORP_ROLE_DIRECTOR) === CORP_ROLE_DIRECTOR ||
      (roleMask & requiredRole) === requiredRole
    );
  }

  _canQueryStarbaseCorporationHangarFlag(session, hangarArray, flagID) {
    const numericFlag = this._normalizeInventoryId(flagID, 0);
    const requiredRole = CORP_HANGAR_QUERY_ROLE_BY_FLAG.get(numericFlag);
    const corporationID = this._normalizeInventoryId(
      this._getCorporationId(session),
      0,
    );
    if (
      !requiredRole ||
      !hangarArray ||
      corporationID <= 0 ||
      this._normalizeInventoryId(hangarArray.ownerID, 0) !== corporationID
    ) {
      return false;
    }
    const roleMask = getCorporationRolesAtLocation(session, 0);
    return (
      (roleMask & CORP_ROLE_DIRECTOR) === CORP_ROLE_DIRECTOR ||
      (roleMask & requiredRole) === requiredRole
    );
  }

  _listStarbaseCorporationHangarItems(session, hangarArray, requestedFlag = null) {
    if (
      !isStarbaseCorporateHangarArrayType(hangarArray) ||
      this._getSpaceContainerScopeAccessError(session, hangarArray.itemID)
    ) {
      return [];
    }
    const numericFlag = requestedFlag === null || requestedFlag === undefined
      ? null
      : this._normalizeInventoryId(requestedFlag, 0);
    if (
      numericFlag !== null &&
      !this._canQueryStarbaseCorporationHangarFlag(
        session,
        hangarArray,
        numericFlag,
      )
    ) {
      return [];
    }
    const corporationID = this._normalizeInventoryId(hangarArray.ownerID, 0);
    return listContainerItems(null, hangarArray.itemID, numericFlag)
      .filter((item) => this._canQueryStarbaseCorporationHangarFlag(
        session,
        hangarArray,
        item.flagID,
      ))
      // Builds written before POS division custody was implemented can contain
      // personally-owned rows. They are still corporation-hangar deposits: show
      // the client the corporate owner now, and the withdrawal path below applies
      // the same division Take role before handing the item back to the pilot.
      .map((item) => (
        this._normalizeInventoryId(item.ownerID, 0) === corporationID
          ? item
          : { ...item, ownerID: corporationID }
      ));
  }

  _getCorporationOffice(session, inventoryID = null) {
    const corporationID = this._getCorporationId(session);
    const numericInventoryID = this._normalizeInventoryId(inventoryID, 0);
    if (corporationID <= 0 || numericInventoryID <= 0) {
      return null;
    }

    return getCorporationOfficeByInventoryID(corporationID, numericInventoryID);
  }

  _getCorporationOfficeAtLocation(session, locationID = null) {
    const corporationID = this._getCorporationId(session);
    const numericLocationID = this._normalizeInventoryId(locationID, 0);
    if (corporationID <= 0 || numericLocationID <= 0) {
      return null;
    }

    return getCorporationOffices(corporationID).find(
      (office) =>
        this._normalizeInventoryId(office && office.stationID, 0) === numericLocationID &&
        !office.impounded,
    ) || null;
  }

  _getCorporationOfficeForItemLocation(session, locationID = null) {
    return this._getCorporationOfficeForItemLocationByCorporation(
      this._getCorporationId(session),
      locationID,
    );
  }

  // The corporationID-keyed half of the lookup above. Settlements that write a
  // corporation hangar without an acting session -- an industry job delivered
  // by a scheduler, a contract settled after the issuer logged off -- know the
  // owning corporation but have no session to read it from.
  _getCorporationOfficeForItemLocationByCorporation(
    corporationID,
    locationID = null,
  ) {
    const numericCorporationID = this._normalizeInventoryId(corporationID, 0);
    const numericLocationID = this._normalizeInventoryId(locationID, 0);
    if (numericCorporationID <= 0 || numericLocationID <= 0) {
      return null;
    }

    return getCorporationOffices(numericCorporationID).find((office) => {
      if (!office || office.impounded) {
        return false;
      }
      return [
        office.officeID,
        office.officeFolderID,
        office.itemID,
      ].some(
        (candidateID) =>
          this._normalizeInventoryId(candidateID, 0) === numericLocationID,
      );
    }) || null;
  }

  _getDirectLocalCorporationHangarItemContext(session, item) {
    if (!session || !item || !isDockedSession(session)) {
      return null;
    }

    const corporationID = this._normalizeInventoryId(
      this._getCorporationId(session),
      0,
    );
    const ownerID = this._normalizeInventoryId(item.ownerID, 0);
    const itemLocationID = this._normalizeInventoryId(item.locationID, 0);
    const flagID = this._normalizeInventoryId(item.flagID, 0);
    const dockedLocationID = this._normalizeInventoryId(
      this._getStationId(session),
      0,
    );
    if (
      corporationID <= 0 ||
      ownerID !== corporationID ||
      dockedLocationID <= 0 ||
      !CORP_HANGAR_QUERY_ROLE_BY_FLAG.has(flagID)
    ) {
      return null;
    }

    const office = this._getCorporationOfficeForItemLocation(
      session,
      itemLocationID,
    );
    const stationID = this._normalizeInventoryId(
      office && office.stationID,
      0,
    );
    if (!office || office.impounded || stationID !== dockedLocationID) {
      return null;
    }

    return {
      corporationID,
      office,
      stationID,
      flagID,
      takeAllowed: canTakeFromCorporationHangarDivision(
        session,
        corporationID,
        stationID,
        flagID,
      ) === true,
    };
  }

  // A station container has no owner partition of its own: its contents are
  // addressed by container ID.  For a container parked in an office division,
  // that must not bypass the division that contains it.  Resolve the first
  // corporation-division ancestor so reads, withdrawals, and deposits all use
  // the same ownership and role boundary.
  _getCorporationOfficeDivisionAncestorContext(session, item) {
    if (!item || typeof item !== "object") {
      return null;
    }

    const divisionAncestor = this._getInventoryItemAncestorChain(item.itemID)
      .find((ancestor) => this._isCorporationHangarFlag(ancestor && ancestor.flagID));
    if (!divisionAncestor) {
      return null;
    }

    const corporationID = this._normalizeInventoryId(
      this._getCorporationId(session),
      0,
    );
    const ancestorOwnerID = this._normalizeInventoryId(
      divisionAncestor.ownerID,
      0,
    );
    const office = corporationID > 0 && ancestorOwnerID === corporationID
      ? this._getCorporationOfficeForItemLocation(
          session,
          divisionAncestor.locationID,
        )
      : null;
    const stationID = this._normalizeInventoryId(office && office.stationID, 0);
    return {
      corporationID,
      office,
      stationID,
      flagID: this._normalizeInventoryId(divisionAncestor.flagID, 0),
      divisionAncestor,
      accessAllowed: Boolean(office && stationID > 0),
    };
  }

  _getCorporationOfficeDivisionDestinationContext(session, destination) {
    const destinationLocationID = this._normalizeInventoryId(
      destination && destination.locationID,
      0,
    );
    if (destinationLocationID <= 0) {
      return null;
    }

    const directOffice = this._getCorporationOffice(session, destinationLocationID);
    if (
      directOffice &&
      this._isCorporationHangarFlag(destination && destination.flagID)
    ) {
      return {
        corporationID: this._normalizeInventoryId(this._getCorporationId(session), 0),
        office: directOffice,
        stationID: this._normalizeInventoryId(directOffice.stationID, 0),
        flagID: this._normalizeInventoryId(destination.flagID, 0),
        divisionAncestor: null,
        accessAllowed: true,
      };
    }

    return this._getCorporationOfficeDivisionAncestorContext(
      session,
      findItemById(destinationLocationID),
    );
  }

  _hasLocalCorporationOfficeDivisionQueryAccess(session, context) {
    return Boolean(
      context &&
      context.accessAllowed &&
      isDockedSession(session) &&
      context.stationID === this._normalizeInventoryId(this._getStationId(session), 0) &&
      this._canQueryCorporationHangarFlag(session, context.flagID),
    );
  }

  _ensureCorporationOfficeDivisionDestinationAccess(session, destination) {
    const context = this._getCorporationOfficeDivisionDestinationContext(
      session,
      destination,
    );
    if (!context) {
      return null;
    }
    if (!this._hasLocalCorporationOfficeDivisionQueryAccess(session, context)) {
      throwWrappedUserError(
        "CrpAccessDenied",
        buildCrpAccessDeniedInsufficientRolesValues(),
      );
    }
    return context;
  }

  _getGenericContainerContentsOwnerID(session, containerRecord) {
    const characterID = this._getCharacterId(session);
    if (!containerRecord) {
      return characterID;
    }

    const typeRecord = resolveItemByTypeID(containerRecord.typeID) || {};
    const categoryID = this._normalizeInventoryId(
      containerRecord.categoryID ?? typeRecord.categoryID,
      0,
    );
    // Same rule as the generic-container branch of _resolveContainerItems: a
    // plain container's contents are matched on locationID alone in retail
    // (invControllers.py BaseCelestialContainer.IsItemHere:1272), so the View
    // Contents window must not narrow them to the session character either.
    // Only ships and structures, whose bays really are addressed per owner,
    // keep an owner. This used to answer characterID for a docked personal
    // container and hid corporation-owned rows stored inside it.
    if (categoryID !== SHIP_CATEGORY_ID && categoryID !== STRUCTURE_CATEGORY_ID) {
      return null;
    }

    const corporationID = this._normalizeInventoryId(this._getCorporationId(session), 0);
    const containerOwnerID = this._normalizeInventoryId(containerRecord.ownerID, 0);
    return corporationID > 0 && containerOwnerID === corporationID
      ? corporationID
      : characterID;
  }

  // The access half of the rule above. Because a plain container's contents are
  // matched on locationID alone, the ownership test on the container itself is
  // the whole of the access decision — so it has to be complete.
  //
  // A container sitting at flagHangar is in somebody's personal hangar, and
  // retail reaches one only through invCtrl.StationItems, whose IsItemHere
  // (invControllers.py:1149) pins item.ownerID == session.charid. Keying the
  // test on the *reader's* docked station instead let any pilot docked at some
  // other station, or undocked entirely, bind the container by itemID and read
  // every row inside it; the container's own hangar placement is what decides,
  // not where the reader happens to be standing.
  //
  // Containers in space — jettisoned cans, anchored containers — carry flagNone
  // rather than flagHangar and are deliberately left open: retail serves those
  // through BaseCelestialContainer to anyone in range. Ships and structures keep
  // their own owner-scoped bay paths, exactly as
  // _getGenericContainerContentsOwnerID leaves them alone.
  _getPersonalHangarContainerAccessError(session, containerRecord) {
    if (!containerRecord) {
      return null;
    }
    if (
      this._normalizeInventoryId(containerRecord.flagID, 0) !== ITEM_FLAGS.HANGAR
    ) {
      return null;
    }
    const typeRecord = resolveItemByTypeID(containerRecord.typeID) || {};
    const categoryID = this._normalizeInventoryId(
      containerRecord.categoryID ?? typeRecord.categoryID,
      0,
    );
    if (categoryID === SHIP_CATEGORY_ID || categoryID === STRUCTURE_CATEGORY_ID) {
      return null;
    }
    const containerOwnerID = this._normalizeInventoryId(containerRecord.ownerID, 0);
    return containerOwnerID === this._getCharacterId(session)
      ? null
      : "CONTAINER_NOT_OWNED";
  }

  _getInventoryItemAncestorChain(itemID) {
    const chain = [];
    const seen = new Set();
    let currentID = this._normalizeInventoryId(itemID, 0);

    while (currentID > 0 && !seen.has(currentID) && chain.length < 128) {
      seen.add(currentID);
      const item = findItemById(currentID);
      if (!item) {
        break;
      }
      chain.push(item);
      currentID = this._normalizeInventoryId(item.locationID, 0);
    }
    return chain;
  }

  _getSecureContainerPasswordFields(passwordType) {
    return passwordType === SCC_PASSWORD_TYPE_CONFIG
      ? {
          passwordKey: "configPassword",
          revisionKey: "configPasswordRevision",
        }
      : {
          passwordKey: "generalPassword",
          revisionKey: "generalPasswordRevision",
        };
  }

  _readSecureContainerState(item) {
    const source =
      item &&
      item.secureContainerState &&
      typeof item.secureContainerState === "object" &&
      !Array.isArray(item.secureContainerState)
        ? item.secureContainerState
        : {};
    const resolvedState = getSecureContainerState(item);
    const canonicalSource = { ...source };
    delete canonicalSource.password;
    return {
      ...canonicalSource,
      anchored: Boolean(resolvedState && resolvedState.anchored),
      generalPassword: String(
        resolvedState && resolvedState.generalPassword || "",
      ).slice(0, SECURE_CONTAINER_PASSWORD_MAX_LENGTH),
      configPassword: String(
        resolvedState && resolvedState.configPassword || "",
      ).slice(0, SECURE_CONTAINER_PASSWORD_MAX_LENGTH),
      generalPasswordRevision: Math.max(
        0,
        Math.trunc(
          Number(resolvedState && resolvedState.generalPasswordRevision) || 0,
        ),
      ),
      configPasswordRevision: Math.max(
        0,
        Math.trunc(
          Number(resolvedState && resolvedState.configPasswordRevision) || 0,
        ),
      ),
      alscConfig:
        Math.max(
          0,
          Math.trunc(Number(resolvedState && resolvedState.alscConfig) || 0),
        ) & ALSC_CONFIG_MASK,
    };
  }

  _updateSecureContainerState(itemID, updater) {
    return updateInventoryItem(itemID, (currentItem) => {
      const currentState = this._readSecureContainerState(currentItem);
      const nextState =
        typeof updater === "function"
          ? updater({ ...currentState })
          : updater;
      return {
        ...currentItem,
        customInfo: stripLegacySecureContainerStateFromCustomInfo(
          currentItem.customInfo,
        ),
        secureContainerState:
          nextState && typeof nextState === "object"
            ? nextState
            : currentState,
      };
    });
  }

  _getSecureContainerAuthorizationStore(session, create = false) {
    if (!session || typeof session !== "object") {
      return null;
    }
    if (
      session._secureContainerAuthorizations &&
      typeof session._secureContainerAuthorizations === "object"
    ) {
      return session._secureContainerAuthorizations;
    }
    if (!create) {
      return null;
    }
    Object.defineProperty(session, "_secureContainerAuthorizations", {
      configurable: true,
      enumerable: false,
      value: Object.create(null),
      writable: true,
    });
    return session._secureContainerAuthorizations;
  }

  _getSecureContainerAuthorizationKey(itemID, passwordType) {
    return `${this._normalizeInventoryId(itemID, 0)}:${passwordType}`;
  }

  _isSecureContainerPasswordAuthorized(session, item, passwordType) {
    const store = this._getSecureContainerAuthorizationStore(session, false);
    if (!store || !item) {
      return false;
    }
    const state = this._readSecureContainerState(item);
    const { revisionKey } = this._getSecureContainerPasswordFields(passwordType);
    const key = this._getSecureContainerAuthorizationKey(
      item.itemID,
      passwordType,
    );
    return Number(store[key]) === Number(state[revisionKey]);
  }

  _isSecureContainerPasswordProtectionActive(item, state = null) {
    if (!item) {
      return false;
    }
    const secureState = state || this._readSecureContainerState(item);
    return Boolean(
      secureState.anchored || isStationOnlyCargoContainerType(item),
    );
  }

  _secureContainerNeedsGeneralPassword(item) {
    if (!item) {
      return false;
    }
    const state = this._readSecureContainerState(item);
    if (
      !state.generalPassword ||
      !this._isSecureContainerPasswordProtectionActive(item, state)
    ) {
      return false;
    }
    if (
      this._normalizeInventoryId(item.groupID, 0) ===
      GROUP_AUDIT_LOG_SECURE_CONTAINER
    ) {
      return (state.alscConfig & ALSC_PASSWORD_NEEDED_TO_OPEN) !== 0;
    }
    return true;
  }

  _getSecureContainerGeneralAccessError(session, containerID) {
    for (const item of this._getInventoryItemAncestorChain(containerID)) {
      if (
        !isSecureCargoContainerType(item) ||
        !this._secureContainerNeedsGeneralPassword(item)
      ) {
        continue;
      }
      if (
        !this._isSecureContainerPasswordAuthorized(
          session,
          item,
          SCC_PASSWORD_TYPE_GENERAL,
        )
      ) {
        return "SCGeneralPasswordRequired";
      }
    }
    return null;
  }

  _ensureSecureContainerGeneralAccess(session, containerID) {
    const errorMsg = this._getSecureContainerGeneralAccessError(
      session,
      containerID,
    );
    if (errorMsg) {
      throwWrappedUserError(errorMsg);
    }
  }

  _ensureSecureContainerTransferAccess(session, sourceItem, destination) {
    this._ensureAuditContainerItemUnlocked(sourceItem);
    this._ensureSecureContainerGeneralAccess(
      session,
      sourceItem && sourceItem.locationID,
    );
    this._ensureSecureContainerGeneralAccess(
      session,
      destination && destination.locationID,
    );
  }

  _isWreckInventoryItem(item) {
    if (!item) {
      return false;
    }
    const metadata = getItemMetadata(item.typeID, item.itemName);
    const groupName = String(
      item.groupName || metadata && metadata.groupName || "",
    ).trim().toLowerCase();
    return groupName === "wreck";
  }

  _isCargoContainerInventoryItem(item) {
    if (!item) {
      return false;
    }
    if (isCargoContainerType(item)) {
      return true;
    }
    const metadata = getItemMetadata(item.typeID, item.itemName);
    return isCargoContainerType(metadata);
  }

  // Secure and audit-log containers are not loot-right sources: the client's
  // crimewatch only treats wrecks, cargo, freight and spew containers as theft
  // (crimewatch/const.py containerGroupsWithLootRights). Their password is what
  // guards them.
  _isSecureCargoContainerInventoryItem(item) {
    if (!item) {
      return false;
    }
    if (isSecureCargoContainerType(item)) {
      return true;
    }
    return isSecureCargoContainerType(getItemMetadata(item.typeID, item.itemName));
  }

  _isSpaceContainerLikeInventoryItem(item) {
    if (!item) {
      return false;
    }

    // Native cargo hulls are containers by persisted materialization contract,
    // even when their unchanged type belongs to a collidable-structure group.
    if (isMaterializedMissionCargoContainer(item) || incursionFactoryCustody.isFactory(item)) return true;

    const metadata = getItemMetadata(item.typeID, item.itemName);
    // Type metadata is authoritative when it is present. Some old persisted
    // rows carry a stale categoryID (including categoryShip on type 23 cans),
    // so consulting both values would turn a known container into a ship.
    const metadataCategoryID = this._normalizeInventoryId(
      metadata && metadata.categoryID,
      0,
    );
    const categoryID = metadataCategoryID > 0
      ? metadataCategoryID
      : this._normalizeInventoryId(item.categoryID, 0);
    if ([
      SHIP_CATEGORY_ID,
      STRUCTURE_CATEGORY_ID,
      CATEGORY_DEPLOYABLE,
    ].includes(categoryID)) {
      return false;
    }
    if (this._isCargoContainerInventoryItem(item)) {
      return true;
    }

    const metadataGroupName = String(
      metadata && metadata.groupName || "",
    ).trim().toLowerCase();
    const groupName = metadataGroupName || String(
      item.groupName || "",
    ).trim().toLowerCase();
    const runtimeKind = String(
      item.kind || item.entityKind || "",
    ).trim().toLowerCase();
    return groupName.includes("container") || runtimeKind === "container";
  }

  _isProtectedPlayerSpaceLootInventoryItem(item) {
    if (
      !item ||
      this._readAbyssalRewardContainerState(item) ||
      this._isMobileTractorUnitInventoryItem(item) ||
      this._isSecureCargoContainerInventoryItem(item)
    ) {
      return false;
    }

    return (
      this._isSpaceContainerLikeInventoryItem(item) ||
      this._isWreckInventoryItem(item)
    );
  }

  _isWreckInventoryDestination(destinationLocationID) {
    const numericDestinationLocationID = this._normalizeInventoryId(
      destinationLocationID,
      0,
    );
    if (numericDestinationLocationID <= 0) {
      return false;
    }

    if (this._getNativeWreckRecord(numericDestinationLocationID)) {
      return true;
    }

    return this._isWreckInventoryItem(
      findItemById(numericDestinationLocationID),
    );
  }

  // A mobile tractor unit fills itself from the wrecks it pulls in; retail has
  // no way to put anything into one by hand. Its inventory binds like any other
  // space container though, so without this the client would happily drag cargo
  // into a deployed unit - anyone's deployed unit, since nothing on the Add
  // path reads the destination's owner.
  _isMobileTractorUnitInventoryItem(item) {
    if (!item) {
      return false;
    }
    const metadata = getItemMetadata(item.typeID, item.itemName);
    const isMobileTractorUnitGroup = (categoryID, groupID) => (
      this._normalizeInventoryId(categoryID, 0) === CATEGORY_DEPLOYABLE &&
      this._normalizeInventoryId(groupID, 0) === GROUP_MOBILE_TRACTOR_UNIT
    );
    return Boolean(
      isMobileTractorUnitGroup(item.categoryID, item.groupID) ||
        isMobileTractorUnitGroup(
          metadata && metadata.categoryID,
          metadata && metadata.groupID,
        ),
    );
  }

  _isMobileTractorUnitInventoryDestination(destinationLocationID) {
    const numericDestinationLocationID = this._normalizeInventoryId(
      destinationLocationID,
      0,
    );
    if (numericDestinationLocationID <= 0) {
      return false;
    }
    return this._isMobileTractorUnitInventoryItem(
      findItemById(numericDestinationLocationID),
    );
  }

  _ensureItemMoveInvariant(sourceItemDescriptor, destination) {
    const factorySource = findItemById(sourceItemDescriptor?.item?.locationID);
    if (incursionFactoryCustody.isFactory(factorySource) && !require("../incursion/incursionFactory").canWithdraw(factorySource)) {
      throwWrappedUserError("CustomNotify", { notify: "The MTAC factory is no longer active." });
    }
    if (incursionFactoryCustody.isFactory(findItemById(destination?.locationID))) {
      throwWrappedUserError("CustomNotify", { notify: "The MTAC factory is withdrawal-only." });
    }
    const processingDeposit = starbaseProcessingInventory.validateProcessingDeposit(sourceItemDescriptor?.item, destination);
    if (!processingDeposit.success) this._throwSpaceContainerScopeAccessError(processingDeposit.errorMsg);
    const towerDeposit = starbaseInventoryRuntime.validateTowerBayDeposit(sourceItemDescriptor?.item, destination);
    if (!towerDeposit.success) this._throwSpaceContainerScopeAccessError(towerDeposit.errorMsg);
    const starbaseDeposit = starbaseInventoryRuntime.validateMaintenanceDeposit(
      sourceItemDescriptor && sourceItemDescriptor.item, destination,
    );
    if (!starbaseDeposit.success) this._throwSpaceContainerScopeAccessError(starbaseDeposit.errorMsg);
    const batteryDeposit = starbaseInventoryRuntime.validateBatteryAmmoDeposit(
      sourceItemDescriptor && sourceItemDescriptor.item, destination,
    );
    if (!batteryDeposit.success) this._throwSpaceContainerScopeAccessError(batteryDeposit.errorMsg);
    if (this._isWreckInventoryDestination(destination && destination.locationID)) {
      throwWrappedUserError("CustomNotify", {
        notify: "Wrecks are loot-only. Items cannot be moved into a wreck.",
      });
    }

    if (
      this._isMobileTractorUnitInventoryDestination(
        destination && destination.locationID,
      )
    ) {
      throwWrappedUserError("CustomNotify", {
        notify:
          "Mobile Tractor Units are loot-only. Items cannot be moved into one.",
      });
    }

    const customsOffice = this._getPlanetaryCustomsOfficeRecord(
      destination && destination.locationID,
    );
    if (
      customsOffice &&
      sourceItemDescriptor &&
      sourceItemDescriptor.item &&
      !planetStaticData.canPutTypeInCustomsOffice(
        sourceItemDescriptor.item.typeID,
      )
    ) {
      throwWrappedUserError("CustomNotify", {
        notify: "Only commodities accepted by a Customs Office may be moved there.",
      });
    }

    if (
      !sourceItemDescriptor ||
      sourceItemDescriptor.sourceKind !== "inventory" ||
      !sourceItemDescriptor.item ||
      !destination
    ) {
      return;
    }

    const validation = validateItemMoveToLocation(
      sourceItemDescriptor.item.itemID,
      destination.locationID,
    );
    if (validation.success) {
      return;
    }

    const notify =
      validation.errorMsg === ITEM_MOVE_ERROR.CYCLE
        ? "An item cannot be moved into itself or one of its contents."
        : validation.errorMsg === ITEM_MOVE_ERROR.CONTAINER_NESTING
          ? "A cargo container cannot be placed inside another cargo container."
          : validation.errorMsg === ITEM_MOVE_ERROR.CONTAINER_NOT_ASSEMBLED
            ? "That container has to be assembled before it can hold anything."
            : "That inventory move is not valid.";
    throwWrappedUserError("CustomNotify", { notify });
  }

  _preflightMultiAddTransferGuards(
    session,
    boundContext,
    itemIDs,
    sourceLocationID,
    requestedFlag,
    explicitFlagProvided,
    fittedItemsSnapshot,
    requestedQuantity = null,
  ) {
    const batteryMoves = [];
    const processingMoves = [];
    const towerMoves = [];
    for (const itemID of itemIDs) {
      const sourceItemDescriptor = this._findTransferSourceItem(
        itemID,
        sourceLocationID,
      );
      if (
        !sourceItemDescriptor ||
        !sourceItemDescriptor.item ||
        !this._isTransferSourceLocationMatch(
          sourceItemDescriptor,
          sourceLocationID,
        )
      ) {
        continue;
      }

      const destination = this._resolveDestinationForMove(
        session,
        boundContext,
        sourceItemDescriptor.item,
        requestedFlag,
        explicitFlagProvided,
        fittedItemsSnapshot,
      );
      if (!destination) {
        continue;
      }
      // Null for every destination that is not a starbase structure.
      const starbaseDestination = findStarbaseItemById(destination.locationID);
      if (starbaseInventoryRuntime.isBatteryAmmoInventory(starbaseDestination)) {
        batteryMoves.push({ item: sourceItemDescriptor.item, destination,
          quantity: this._resolveMoveQuantity(sourceItemDescriptor.item, destination, requestedQuantity) });
      }
      if (starbaseProcessingInventory.isProcessingStorage(starbaseDestination)) {
        processingMoves.push({ item: sourceItemDescriptor.item, destination,
          quantity: this._resolveMoveQuantity(sourceItemDescriptor.item, destination, requestedQuantity) });
      }
      if (starbaseInventoryRuntime.isTowerBay(starbaseDestination)) {
        towerMoves.push({ item: sourceItemDescriptor.item, destination,
          quantity: this._resolveMoveQuantity(sourceItemDescriptor.item, destination, requestedQuantity) });
      }

      if (!this._canTakeFromCorporationHangarSourceAncestry(session, sourceItemDescriptor)) {
        throwWrappedUserError(
          "CrpAccessDenied",
          buildCrpAccessDeniedInsufficientRolesValues(),
        );
      }
      this._ensureCorporationOfficeDivisionDestinationAccess(session, destination);

      this._ensureSecureContainerTransferAccess(
        session,
        sourceItemDescriptor.item,
        destination,
      );
      this._ensureItemMoveInvariant(sourceItemDescriptor, destination);
      const mobileDepotAccess = this._validateMobileDepotCargoTransferAccess(
        session,
        sourceItemDescriptor.item,
        destination,
      );
      if (!mobileDepotAccess.success) {
        log.debug(
          `[InvBroker] MultiAdd preflight rejected itemID=${itemID} mobileDepot=${mobileDepotAccess.containerID} error=${mobileDepotAccess.errorMsg}`,
        );
        this._throwMobileDepotCargoAccessError(
          mobileDepotAccess.errorMsg,
          mobileDepotAccess.side,
        );
      }
      const mobileTractorUnitAccess =
        this._validateMobileTractorUnitCargoTransferAccess(
          session,
          sourceItemDescriptor.item,
          destination,
        );
      if (!mobileTractorUnitAccess.success) {
        log.debug(
          `[InvBroker] MultiAdd preflight rejected itemID=${itemID} mobileTractorUnit=${mobileTractorUnitAccess.containerID} error=${mobileTractorUnitAccess.errorMsg}`,
        );
        this._throwMobileTractorUnitCargoAccessError(
          mobileTractorUnitAccess.errorMsg,
          mobileTractorUnitAccess.side,
        );
      }
      const spaceContainerScopeAccess =
        this._validateAuthoritativeSpaceContainerScopeTransferAccess(
          session,
          sourceItemDescriptor,
          destination.locationID,
        );
      if (!spaceContainerScopeAccess.success) {
        log.debug(
          `[InvBroker] MultiAdd preflight rejected itemID=${itemID} spaceContainer=${spaceContainerScopeAccess.containerID} error=${spaceContainerScopeAccess.errorMsg}`,
        );
        this._throwSpaceContainerScopeAccessError(
          spaceContainerScopeAccess.errorMsg,
          spaceContainerScopeAccess.side === "destination" ? "add" : "loot",
        );
      }
      const abyssalRewardAccess =
        this._validateAuthoritativeAbyssalRewardTransferAccess(
          session,
          sourceItemDescriptor,
        );
      if (!abyssalRewardAccess.success) {
        log.debug(
          `[InvBroker] MultiAdd preflight rejected itemID=${itemID} abyssalRewardContainer=${abyssalRewardAccess.containerID} error=${abyssalRewardAccess.errorMsg}`,
        );
        this._throwSpaceContainerScopeAccessError();
      }
    }
    const batteryBatch = starbaseInventoryRuntime.validateBatteryAmmoBatch(batteryMoves);
    const processingBatch = starbaseProcessingInventory.validateProcessingBatch(processingMoves);
    if (!processingBatch.success) this._throwSpaceContainerScopeAccessError(processingBatch.errorMsg);
    const towerBatch = starbaseInventoryRuntime.validateTowerBayBatch(towerMoves);
    if (!towerBatch.success) this._throwSpaceContainerScopeAccessError(towerBatch.errorMsg);
    if (!batteryBatch.success) this._throwSpaceContainerScopeAccessError(batteryBatch.errorMsg);
  }

  _isAuditLogSecureContainerRecord(item) {
    return Boolean(
      item &&
      this._normalizeInventoryId(item.groupID, 0) ===
        GROUP_AUDIT_LOG_SECURE_CONTAINER,
    );
  }

  _normalizeSecureContainerAuditLog(state, nowFiletime = currentFileTime()) {
    const cutoff = nowFiletime - ALSC_AUDIT_LOG_RETENTION_TICKS;
    const entries = [];
    for (const rawEntry of Array.isArray(state && state.auditLog)
      ? state.auditLog
      : []) {
      if (!rawEntry || typeof rawEntry !== "object") {
        continue;
      }
      const logID = Math.max(
        0,
        Math.trunc(Number(rawEntry.logID) || 0),
      );
      const actionID = Math.max(
        0,
        Math.trunc(Number(rawEntry.actionID) || 0),
      );
      const logDate = normalizeBigInt(rawEntry.logDate, 0n);
      if (
        logID <= 0 ||
        actionID <= 0 ||
        logDate <= 0n ||
        logDate < cutoff
      ) {
        continue;
      }
      entries.push({
        logID,
        inventoryMgrLocationID: this._normalizeInventoryId(
          rawEntry.inventoryMgrLocationID,
          0,
        ),
        locationID: this._normalizeInventoryId(rawEntry.locationID, 0),
        flagID: this._normalizeInventoryId(rawEntry.flagID, 0),
        actionID,
        arg1: Math.trunc(Number(rawEntry.arg1) || 0),
        arg2: Math.trunc(Number(rawEntry.arg2) || 0),
        logDate: logDate.toString(),
        actorID: this._normalizeInventoryId(rawEntry.actorID, 0),
        status: Boolean(rawEntry.status),
      });
    }
    entries.sort(
      (left, right) =>
        left.logID - right.logID ||
        String(left.logDate).localeCompare(String(right.logDate)),
    );
    return entries.slice(-ALSC_AUDIT_LOG_MAX_ENTRIES);
  }

  _buildSecureContainerAuditEntry(
    container,
    session,
    actionID,
    arg1 = 0,
    arg2 = 0,
    status = true,
  ) {
    return {
      inventoryMgrLocationID: this._resolveInventoryRootLocationID(container),
      locationID: this._normalizeInventoryId(container && container.locationID, 0),
      flagID: this._normalizeInventoryId(container && container.flagID, 0),
      actionID: Math.max(0, Math.trunc(Number(actionID) || 0)),
      arg1: Math.trunc(Number(arg1) || 0),
      arg2: Math.trunc(Number(arg2) || 0),
      logDate: currentFileTime().toString(),
      actorID: this._normalizeInventoryId(this._getCharacterId(session), 0),
      status: Boolean(status),
    };
  }

  _appendSecureContainerAuditEntriesToState(
    container,
    state,
    rawEntries,
  ) {
    if (!this._isAuditLogSecureContainerRecord(container)) {
      return state;
    }
    const auditLog = this._normalizeSecureContainerAuditLog(state);
    const highestLogID = auditLog.reduce(
      (highest, entry) => Math.max(highest, entry.logID),
      0,
    );
    let nextAuditLogID = Math.max(
      highestLogID + 1,
      Math.trunc(Number(state && state.nextAuditLogID) || 1),
      1,
    );
    for (const rawEntry of Array.isArray(rawEntries)
      ? rawEntries
      : [rawEntries]) {
      if (
        !rawEntry ||
        Math.max(0, Math.trunc(Number(rawEntry.actionID) || 0)) <= 0
      ) {
        continue;
      }
      auditLog.push({
        ...rawEntry,
        logID: nextAuditLogID,
        logDate: normalizeBigInt(
          rawEntry.logDate,
          currentFileTime(),
        ).toString(),
      });
      nextAuditLogID += 1;
    }
    return {
      ...state,
      auditLog: auditLog.slice(-ALSC_AUDIT_LOG_MAX_ENTRIES),
      nextAuditLogID,
    };
  }

  _appendSecureContainerAuditEntries(container, session, entries) {
    if (!this._isAuditLogSecureContainerRecord(container)) {
      return null;
    }
    return this._updateSecureContainerState(
      container.itemID,
      (currentState) =>
        this._appendSecureContainerAuditEntriesToState(
          container,
          currentState,
          (Array.isArray(entries) ? entries : [entries]).map((entry) => (
            entry && entry.actionID
              ? {
                  ...entry,
                  actorID:
                    entry.actorID ??
                    this._normalizeInventoryId(this._getCharacterId(session), 0),
                  logDate: entry.logDate || currentFileTime().toString(),
                }
              : entry
          )),
        ),
    );
  }

  _ensureAuditContainerItemUnlocked(item) {
    if (
      item &&
      this._normalizeInventoryId(item.flagID, 0) === ITEM_FLAGS.LOCKED
    ) {
      throwWrappedUserError("ItemIsLocked");
    }
  }

  _normalizeAuditContainerMoveDestination(destination) {
    if (!destination) {
      return destination;
    }
    const container = findItemById(destination.locationID);
    if (!this._isAuditLogSecureContainerRecord(container)) {
      return destination;
    }
    const state = this._readSecureContainerState(container);
    const destinationFlagID = this._normalizeInventoryId(
      destination.flagID,
      ITEM_FLAGS.UNLOCKED,
    );
    return {
      ...destination,
      flagID:
        (state.alscConfig & ALSC_LOCK_ADDED_ITEMS) !== 0
          ? ITEM_FLAGS.LOCKED
          : destinationFlagID === ITEM_FLAGS.LOCKED ||
              destinationFlagID === ITEM_FLAGS.UNLOCKED
            ? destinationFlagID
            : ITEM_FLAGS.UNLOCKED,
    };
  }

  _recordAuditContainerAutoLockMove(session, destination, moveResult) {
    if (
      !moveResult ||
      !moveResult.success ||
      !destination ||
      this._normalizeInventoryId(destination.flagID, 0) !== ITEM_FLAGS.LOCKED
    ) {
      return moveResult;
    }
    const container = findItemById(destination.locationID);
    if (!this._isAuditLogSecureContainerRecord(container)) {
      return moveResult;
    }
    const state = this._readSecureContainerState(container);
    if ((state.alscConfig & ALSC_LOCK_ADDED_ITEMS) === 0) {
      return moveResult;
    }
    const movedItems = new Map();
    for (const change of moveResult.data && Array.isArray(moveResult.data.changes)
      ? moveResult.data.changes
      : []) {
      const item = change && change.item;
      if (
        item &&
        this._normalizeInventoryId(item.locationID, 0) ===
          this._normalizeInventoryId(container.itemID, 0) &&
        this._normalizeInventoryId(item.flagID, 0) === ITEM_FLAGS.LOCKED
      ) {
        movedItems.set(this._normalizeInventoryId(item.itemID, 0), item);
      }
    }
    if (movedItems.size === 0) {
      return moveResult;
    }
    this._appendSecureContainerAuditEntries(
      container,
      session,
      [...movedItems.values()].map((item) =>
        this._buildSecureContainerAuditEntry(
          container,
          session,
          ALSC_ACTION_LOCK,
          item.typeID,
          Math.max(1, this._getStackableQuantity(item)),
          true,
        ),
      ),
    );
    return moveResult;
  }

  _isCorporationHangarFlag(flagID) {
    return CORP_HANGAR_FLAGS.has(this._normalizeInventoryId(flagID, 0));
  }

  _isInventoryBindFlag(flagID) {
    const numericFlag = this._normalizeInventoryId(flagID, 0);
    return (
      numericFlag > 0 &&
      (
        SHIP_BAY_FLAGS.has(numericFlag) ||
        isShipFittingFlag(numericFlag) ||
        this._isStructureOwnerBayFlag(numericFlag) ||
        this._isMoonMaterialBayFlag(numericFlag) ||
        this._isCorporationHangarFlag(numericFlag)
      )
    );
  }

  _getShipId(session) {
    const charId = this._getCharacterId(session);
    const activeShip = getActiveShipRecord(charId);
    return (
      (activeShip && activeShip.shipID) ||
      (session && (session.activeShipID || session.shipID || session.shipid)) ||
      140000101
    );
  }

  _getShipTypeId(session) {
    const charId = this._getCharacterId(session);
    const activeShip = getActiveShipRecord(charId);
    const shipTypeID = activeShip ? activeShip.shipTypeID : (
      session && Number.isInteger(session.shipTypeID) ? session.shipTypeID : null
    );
    return shipTypeID && shipTypeID > 0 ? shipTypeID : 606;
  }

  _getStoredShips(session) {
    const charId = this._getCharacterId(session);
    return getCharacterShips(charId);
  }

  _describeValue(value, depth = 0, keyName = "") {
    const normalizedKeyName = String(keyName || "").toLowerCase();
    if (
      normalizedKeyName.includes("password") ||
      normalizedKeyName === "custominfo" ||
      normalizedKeyName === "securecontainerstate"
    ) {
      return "<redacted>";
    }

    if (depth > 4) {
      return "<max-depth>";
    }

    if (value === null || value === undefined) {
      return value;
    }

    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      return value;
    }

    if (typeof value === "bigint") {
      return value.toString();
    }

    if (Buffer.isBuffer(value)) {
      return `<Buffer:${value.toString("utf8")}>`;
    }

    if (Array.isArray(value)) {
      return value.map((entry) => this._describeValue(entry, depth + 1));
    }

    if (typeof value === "object") {
      const summary = {};
      for (const [key, entryValue] of Object.entries(value)) {
        summary[key] = this._describeValue(entryValue, depth + 1, key);
      }
      return summary;
    }

    return String(value);
  }

  _traceInventory(method, session, payload = {}) {
    if (!log.isVerboseDebugEnabled()) {
      return;
    }
    const entry = {
      method,
      charId: this._getCharacterId(session),
      stationId: this._getStationId(session),
      activeShipId: this._getShipId(session),
      boundContext: this._getBoundContext(session),
      spaceHydrationState: session && session._space
        ? describeSessionHydrationState(session)
        : null,
      ...payload,
    };
    appendInventoryDebug(JSON.stringify(this._describeValue(entry)));
  }

  _summarizeInventoryRowsForLog(items, limit = 12) {
    const safeItems = Array.isArray(items) ? items.filter(Boolean) : [];
    const summary = {
      total: safeItems.length,
      cargo: 0,
      modules: 0,
      charges: 0,
      drones: 0,
      others: 0,
      preview: [],
    };

    for (const item of safeItems) {
      const itemID = this._normalizeInventoryId(item && item.itemID, 0);
      const flagID = this._normalizeInventoryId(item && item.flagID, 0);
      const typeID = this._normalizeInventoryId(item && item.typeID, 0);
      const groupID = this._normalizeInventoryId(item && item.groupID, 0);
      const categoryID = this._normalizeInventoryId(item && item.categoryID, 0);
      const quantity = Number(item && (item.stacksize ?? item.quantity) || 0);

      if (flagID === ITEM_FLAGS.CARGO_HOLD) {
        summary.cargo += 1;
      }
      if (categoryID === 7) {
        summary.modules += 1;
      } else if (categoryID === 8) {
        summary.charges += 1;
      } else if (categoryID === 18) {
        summary.drones += 1;
      } else if (categoryID !== 0) {
        summary.others += 1;
      }

      if (summary.preview.length < limit) {
        summary.preview.push(
          `${itemID}:${flagID}:${typeID}:${groupID}:${categoryID}:${quantity}`,
        );
      }
    }

    return summary;
  }

  _rememberBoundContext(oidString, context) {
    if (!oidString) {
      return;
    }

    this._boundContexts.set(oidString, {
      inventoryID: context.inventoryID ?? null,
      locationID: context.locationID ?? null,
      flagID: context.flagID ?? null,
      kind: context.kind || "inventory",
      ownerID: context.ownerID ?? null,
    });
  }

  _rememberSessionBoundContext(session, oidString, context, boundAtFileTime) {
    if (!session || !oidString) {
      return;
    }

    if (!session._boundObjectState || typeof session._boundObjectState !== "object") {
      session._boundObjectState = {};
    }

    const inventoryID = this._normalizeInventoryId(
      context && context.inventoryID,
      0,
    );
    const flagID =
      context && context.flagID !== null && context.flagID !== undefined
        ? this._normalizeInventoryId(context.flagID, 0)
        : "all";
    const kind = context && context.kind ? context.kind : "inventory";
    session._boundObjectState[
      `invbroker:${kind}:${inventoryID || "unknown"}:${flagID}:${oidString}`
    ] = {
      objectID: oidString,
      boundAtFileTime:
        boundAtFileTime || BigInt(Date.now()) * 10000n + 116444736000000000n,
    };
  }

  _getBoundContext(session) {
    if (!session || !session.currentBoundObjectID) {
      return null;
    }

    return this._boundContexts.get(session.currentBoundObjectID) || null;
  }

  _extractBoundObjectId(value) {
    if (!value) {
      return null;
    }

    if (Array.isArray(value)) {
      for (const entry of value) {
        const boundId = this._extractBoundObjectId(entry);
        if (boundId) {
          return boundId;
        }
      }
      return null;
    }

    if (
      value &&
      value.type === "substruct" &&
      value.value &&
      value.value.type === "substream" &&
      Array.isArray(value.value.value) &&
      value.value.value.length > 0
    ) {
      return value.value.value[0] || null;
    }

    return null;
  }

  _hasLoginInventoryBootstrapPending(session) {
    if (!session) {
      return false;
    }

    return (
      session._loginInventoryBootstrapPending === true ||
      (session._space &&
        session._space.loginInventoryBootstrapPending === true)
    );
  }

  _clearLoginInventoryBootstrapPending(session) {
    if (!session) {
      return;
    }

    session._loginInventoryBootstrapPending = false;
    if (session._space) {
      session._space.loginInventoryBootstrapPending = false;
    }
  }

  _markLoginShipInventoryListed(session) {
    if (!session || !session._space) {
      return;
    }

    session._space.loginShipInventoryListed = true;
  }

  _buildBayDogmaBootstrapKey(items = [], attributesByItemID = new Map()) {
    const normalizedItems = Array.isArray(items) ? items : [];
    if (normalizedItems.length <= 0) {
      return "";
    }

    return normalizedItems
      .map((item) => {
        const itemID = this._normalizeInventoryId(item && item.itemID, 0);
        const stacksize = Math.max(0, Number(item && item.stacksize) || 0);
        const attributes = attributesByItemID.get(itemID) || {};
        const attributeKey = Object.entries(attributes)
          .map(([attributeID, value]) => [
            this._normalizeInventoryId(attributeID, 0),
            Number(value),
          ])
          .filter(([attributeID, value]) => attributeID > 0 && Number.isFinite(value))
          .sort(([left], [right]) => left - right)
          .map(([attributeID, value]) => `${attributeID}=${Number(value).toFixed(6)}`)
          .join(",");
        return `${itemID}:${stacksize}:${attributeKey}`;
      })
      .sort()
      .join("|");
  }

  _resolveDroneBayDogmaAttributes(session, item, boundContext) {
    // Bay listing primes must carry the same operational (skill/ship/module)
    // attribute map the dogma query path serves — including the live
    // active-module effects (e.g. the Industrial Core), which previously
    // never reached this prime because the controller entity was built with
    // an empty effect map.
    const {
      resolveDroneTooltipAttributes,
    } = require(path.join(__dirname, "../drone/droneDogma"));
    const itemLocationID = this._normalizeInventoryId(item && item.locationID, 0);
    const fallbackShipID = this._normalizeInventoryId(
      (boundContext && boundContext.inventoryID) ||
        (session && session._space && session._space.shipID) ||
        this._getShipId(session),
      0,
    );
    return resolveDroneTooltipAttributes(item, session, {
      controllerShipID: itemLocationID > 0 ? 0 : fallbackShipID,
      characterID: this._normalizeInventoryId(this._getCharacterId(session), 0),
    });
  }

  // Drones this ship has in space were moved out of the drone bay flag on
  // launch, so listing the bay reports their volume as free. It is not: the bay
  // owes every drone it has out a berth. Bill that reserve the way TQ's drone
  // bay does, or the freed volume can be refilled from cargo and the drones
  // then have nowhere to land.
  _getLaunchedDroneReservedBayVolume(session, shipRecord) {
    const shipID = this._normalizeInventoryId(shipRecord && shipRecord.itemID, 0);
    const ownerID = this._normalizeInventoryId(
      (shipRecord && shipRecord.ownerID) || this._getCharacterId(session),
      0,
    );
    const systemID = this._normalizeInventoryId(
      (session && (
        session.solarsystemid2 ||
        session.solarsystemid ||
        (session._space && session._space.systemID)
      )) ||
        (shipRecord && shipRecord.spaceState && shipRecord.spaceState.systemID) ||
        0,
      0,
    );
    if (shipID <= 0 || ownerID <= 0 || systemID <= 0) {
      return 0;
    }

    const {
      getLaunchedDroneReservedBayVolume,
    } = require(path.join(__dirname, "../drone/droneRuntime"));
    return Number(
      getLaunchedDroneReservedBayVolume(shipID, systemID, ownerID),
    ) || 0;
  }

  _primeInSpaceBayDogmaItems(session, boundContext, flagID, items = []) {
    if (
      !session ||
      !session._space ||
      typeof session.sendNotification !== "function" ||
      !this._isActiveInSpaceShipInventory(session, boundContext)
    ) {
      return false;
    }

    const numericFlagID = this._normalizeInventoryId(flagID, 0);
    if (numericFlagID !== ITEM_FLAGS.DRONE_BAY) {
      return false;
    }

    const normalizedItems = (Array.isArray(items) ? items : []).filter(
      (item) =>
        item &&
        this._normalizeInventoryId(item.locationID, 0) ===
          this._normalizeInventoryId(boundContext && boundContext.inventoryID, 0) &&
        this._normalizeInventoryId(item.flagID, 0) === numericFlagID,
    );

    if (!session._space.inventoryBayDogmaBootstrapKeys) {
      session._space.inventoryBayDogmaBootstrapKeys = Object.create(null);
    }

    const attributesByItemID = new Map();
    for (const item of normalizedItems) {
      const itemID = this._normalizeInventoryId(item && item.itemID, 0);
      const attributes = this._resolveDroneBayDogmaAttributes(
        session,
        item,
        boundContext,
      );
      if (itemID > 0 && attributes && typeof attributes === "object") {
        attributesByItemID.set(itemID, attributes);
      }
    }

    const nextBootstrapKey = this._buildBayDogmaBootstrapKey(
      normalizedItems,
      attributesByItemID,
    );
    const previousBootstrapKey =
      session._space.inventoryBayDogmaBootstrapKeys[numericFlagID] || "";
    if (previousBootstrapKey === nextBootstrapKey) {
      return false;
    }

    for (const item of normalizedItems) {
      const itemID = this._normalizeInventoryId(item && item.itemID, 0);
      const primeEntry = buildInventoryDogmaPrimeEntry(item, {
        description: "drone",
        includeTypeAttributes: true,
        attributeOverrides: attributesByItemID.get(itemID) || {},
      });
      if (primeEntry) {
        session.sendNotification("OnGodmaPrimeItem", "clientID", [
          this._normalizeInventoryId(boundContext && boundContext.inventoryID, 0),
          primeEntry,
        ]);
      }
      syncInventoryItemForSession(
        session,
        item,
        {
          locationID: item.locationID,
          flagID: item.flagID,
          quantity: item.quantity,
          singleton: item.singleton,
          stacksize: item.stacksize,
        },
        {
          emitCfgLocation: false,
        },
      );
    }

    session._space.inventoryBayDogmaBootstrapKeys[numericFlagID] =
      nextBootstrapKey;
    return normalizedItems.length > 0;
  }

  _isChargeTupleItemID(value) {
    return (
      Array.isArray(value) &&
      value.length === 3 &&
      value.every((entry) => this._normalizeInventoryId(entry, 0) > 0)
    );
  }

  // Which inventory listings may trade their real fitted charge rows for
  // (shipID, flagID, chargeTypeID) tuples. The tuple is a godma sublocation,
  // and godma primes exactly three locations — session.charid, session.shipid
  // and session.structureid (tools/ClientCodeGrabber/Latest
  // eve/client/script/environment/godma.py ProcessAllInfo -> PrimeLocation;
  // ForcePrimeLocation only ever takes [session.shipid]). invCache.List and
  // invCache.ListByFlags overlay sublocations behind
  // `if godmaSM.IsLocationLoaded(self.itemID)`, so for any other ship that
  // branch is dead and a tuple row resolves to nothing at all.
  //
  // Tuples elsewhere would be wrong rather than merely useless: invCache
  // .MultiMerge hands every tuple sourceID to
  // dogmaLocation.UnloadAmmoToContainer(eveCfg.GetActiveShip(), ...), so
  // dragging ammo out of a hangar ship's launcher would unload the ACTIVE ship.
  //
  // Docked counts as owning it. Retail's fitted-charge identity is the tuple in
  // both states — golden log "Topping Up Ammo from cargo direct to fitting
  // while docked" carries no real charge itemID anywhere in its 1073 lines.
  _ownsLoadedChargeTupleIdentity(session, boundContext, requestedFlag) {
    return (
      this._isActiveShipInventory(session, boundContext) &&
      requestedFlag === null
    );
  }

  _buildActiveShipLoadedChargeTupleRows(session, boundContext, requestedFlag) {
    if (
      !this._ownsLoadedChargeTupleIdentity(session, boundContext, requestedFlag)
    ) {
      return [];
    }

    const shipID = this._normalizeInventoryId(
      boundContext && boundContext.inventoryID,
      0,
    );
    const charID = this._getCharacterId(session);
    if (shipID <= 0 || charID <= 0) {
      return [];
    }

    return getLoadedChargeItems(charID, shipID)
      .filter((item) => (
        item &&
        this._normalizeInventoryId(item.locationID, 0) === shipID &&
        isShipFittingFlag(item.flagID) &&
        this._normalizeInventoryId(item.categoryID, 0) === 8
      ))
      .sort((left, right) => (
        this._normalizeInventoryId(left && left.flagID, 0) -
          this._normalizeInventoryId(right && right.flagID, 0) ||
        this._normalizeInventoryId(left && left.typeID, 0) -
          this._normalizeInventoryId(right && right.typeID, 0) ||
        this._normalizeInventoryId(left && left.itemID, 0) -
          this._normalizeInventoryId(right && right.itemID, 0)
      ))
      .map((item) => {
        const quantity = Math.max(
          0,
          Number(item.stacksize ?? item.quantity ?? 0) || 0,
        );
        return {
          itemID: buildChargeTupleItemID(shipID, item.flagID, item.typeID),
          typeID: this._normalizeInventoryId(item.typeID, 0),
          ownerID: this._normalizeInventoryId(item.ownerID, charID),
          locationID: shipID,
          flagID: this._normalizeInventoryId(item.flagID, 0),
          quantity,
          groupID: this._normalizeInventoryId(item.groupID, 0),
          categoryID: 8,
          customInfo: item.customInfo === undefined ? "" : item.customInfo,
          singleton: Number(item.singleton) === 1 ? 1 : 0,
          stacksize: quantity,
        };
      })
      .filter((item) => (
        this._isChargeTupleItemID(item.itemID) &&
        item.typeID > 0 &&
        item.flagID > 0
      ));
  }

  _mergeActiveShipLoadedChargeTupleRows(
    session,
    boundContext,
    requestedFlag,
    items = [],
  ) {
    const sourceItems = Array.isArray(items) ? items : [];
    // The strip and the replacement move together. Stripping a listing this
    // service will not then supply tuples for is what made a second hangar
    // ship's loaded charges vanish: the predicate below matches any bound ship
    // inventory, while the tuple builder answers only for the active ship.
    if (
      !this._ownsLoadedChargeTupleIdentity(session, boundContext, requestedFlag)
    ) {
      return sourceItems;
    }

    const activeShipID = this._normalizeInventoryId(
      boundContext && boundContext.inventoryID,
      0,
    );
    const baseItems = sourceItems.filter((item) => !(
      activeShipID > 0 &&
      item &&
      this._normalizeInventoryId(item.locationID, 0) === activeShipID &&
      this._normalizeInventoryId(item.categoryID, 0) === 8 &&
      isShipFittingFlag(item.flagID)
    ));
    const tupleRows = this._buildActiveShipLoadedChargeTupleRows(
      session,
      boundContext,
      requestedFlag,
    );
    if (tupleRows.length === 0) {
      return baseItems;
    }

    const seenTupleKeys = new Set(
      baseItems
        .map((item) => item && item.itemID)
        .filter((itemID) => this._isChargeTupleItemID(itemID))
        .map((itemID) => itemID
          .map((entry) => this._normalizeInventoryId(entry, 0))
          .join(":")),
    );
    const mergedRows = [...baseItems];
    for (const tupleRow of tupleRows) {
      const tupleKey = tupleRow.itemID.join(":");
      if (seenTupleKeys.has(tupleKey)) {
        continue;
      }
      seenTupleKeys.add(tupleKey);
      mergedRows.push(tupleRow);
    }
    return mergedRows;
  }

  _isActiveShipInventory(session, boundContext) {
    if (
      !session ||
      !boundContext ||
      boundContext.kind !== "shipInventory"
    ) {
      return false;
    }

    const activeShipID = this._normalizeInventoryId(
      (session._space && session._space.shipID) ||
        session.activeShipID ||
        session.shipID ||
        session.shipid ||
        this._getShipId(session),
      0,
    );
    const boundInventoryID = this._normalizeInventoryId(
      boundContext.inventoryID,
      0,
    );

    return activeShipID > 0 && boundInventoryID === activeShipID;
  }

  _isActiveInSpaceShipInventory(session, boundContext) {
    if (
      !this._isActiveShipInventory(session, boundContext) ||
      !session ||
      isDockedSession(session)
    ) {
      return false;
    }

    return true;
  }

  _shouldPrimeLoginShipInventoryBootstrap(session, boundContext, options = {}) {
    void session;
    void boundContext;
    void options;
    return false;
  }

  _primeDeferredSpaceBallparkVisuals(
    session,
    boundContext = null,
    options = {},
  ) {
    if (
      !this._isActiveInSpaceShipInventory(session, boundContext) ||
      !session ||
      !session._space
    ) {
      return false;
    }

    if (
      session._space.initialBallparkVisualsSent === true ||
      session._space.initialStateSent === true
    ) {
      return false;
    }

    // Direct login keeps restore-time attach as "no bootstrap yet" so the
    // packaged client can finish spinning up Michelle/GameUI first. Once the
    // active ship inventory is already being bound, it is safe to seed just
    // the AddBalls2 visual half early, while still leaving the authoritative
    // SetState for the later beyonce bind.
    if (session._space.beyonceBound !== true) {
      session._space.deferInitialBallparkStateUntilBind = true;
    }

    const startedAtMs = Date.now();
    const primed = runtime.ensureInitialBallpark(session, {
      allowDeferredJumpBootstrapVisuals: true,
    });
    const elapsedMs = Date.now() - startedAtMs;
    if (
      runtime &&
      typeof runtime.recordSessionJumpTimingTrace === "function"
    ) {
      runtime.recordSessionJumpTimingTrace(
        session,
        "invbroker-prime-deferred-ballpark",
        {
          primed: primed === true,
          elapsedMs,
          reason:
            typeof options.reason === "string" && options.reason.trim().length > 0
              ? options.reason.trim()
              : "unknown",
          beyonceBound: session._space.beyonceBound === true,
        },
      );
    }
    if (primed) {
      log.debug(
        `[InvBroker] Primed deferred ballpark visuals source=${
          typeof options.reason === "string" && options.reason.trim().length > 0
            ? options.reason.trim()
            : "unknown"
        } ${describeSessionHydrationState(session)}`,
      );
    }
    if (elapsedMs >= 100) {
      log.info(
        `[InvBroker] Deferred ballpark prime source=${
          typeof options.reason === "string" && options.reason.trim().length > 0
            ? options.reason.trim()
            : "unknown"
        } took ${elapsedMs}ms primed=${primed ? 1 : 0}`,
      );
    }
    return primed;
  }

  _primePendingSpaceShipInventoryBootstrap(
    session,
    boundContext = null,
    options = {},
  ) {
    if (!session || !session._space) {
      return;
    }

    session._space.loginShipInventoryPrimed = true;
    this._primeDeferredSpaceBallparkVisuals(session, boundContext, {
      reason:
        typeof options.reason === "string" && options.reason.trim().length > 0
          ? options.reason.trim()
          : "shipInventoryPrime",
    });
  }

  _isInitialLoginSpaceShipInventoryList(session, boundContext) {
    if (
      !session ||
      !this._hasLoginInventoryBootstrapPending(session) ||
      !this._isActiveShipInventory(session, boundContext) ||
      isDockedSession(session)
    ) {
      return false;
    }

    return true;
  }

  _makeBoundSubstruct(context, session = null) {
    if (
      this._isUnanchoredStructureHullInventoryID(
        context && context.inventoryID,
      )
    ) {
      this._throwUnanchoredStructureHullInventoryError();
    }
    if (
      this._isPendingStructureUnanchorContainerInventoryID(
        context && context.inventoryID,
      )
    ) {
      this._throwPendingStructureUnanchorContainerInventoryError();
    }
    const config = require(path.join(__dirname, "../../config"));
    const boundId = config.getNextBoundId();
    const idString = `N=${PROXY_NODE_ID}:${boundId}`;
    const now = BigInt(Date.now()) * 10000n + 116444736000000000n;

    this._rememberBoundContext(idString, context);
    this._rememberSessionBoundContext(session, idString, context, now);

    return {
      type: "substruct",
      value: {
        type: "substream",
        value: [idString, now],
      },
    };
  }

  _getShipMetadata(session, shipTypeID = null, shipName = null) {
    const resolvedShipTypeID = shipTypeID || this._getShipTypeId(session);
    return (
      resolveShipByTypeID(resolvedShipTypeID) || {
        typeID: resolvedShipTypeID,
        name: shipName || (session && session.shipName) || "Ship",
        groupID: 25,
        categoryID: 6,
      }
    );
  }

  _extractKwarg(kwargs, key) {
    if (!kwargs || typeof kwargs !== "object") return undefined;

    if (Object.prototype.hasOwnProperty.call(kwargs, key)) {
      return kwargs[key];
    }

    if (kwargs.type === "dict" && Array.isArray(kwargs.entries)) {
      for (const [k, v] of kwargs.entries) {
        // This was already unwrapping the Buffer form by hand -- correct, and the only
        // one of the eleven hand-rolled kwarg lookups in the tree that was. Routed
        // through the codec's own strVal so there is one normalizer to keep right,
        // and so it also covers the wstring/token forms the decoder can produce.
        if (strVal(k) === key) {
          return v;
        }
      }
    }

    return undefined;
  }

  _normalizeInventoryId(value, fallback = 0) {
    const numericValue = Number(value);
    return Number.isFinite(numericValue) ? Math.trunc(numericValue) : fallback;
  }

  _normalizeFlagList(value) {
    if (Array.isArray(value)) {
      return value
        .map((entry) => this._normalizeInventoryId(entry, NaN))
        .filter(Number.isFinite);
    }

    if (value && value.type === "list" && Array.isArray(value.items)) {
      return value.items
        .map((entry) => this._normalizeInventoryId(entry, NaN))
        .filter(Number.isFinite);
    }

    return [];
  }

  _normalizeItemIdList(value) {
    if (Array.isArray(value)) {
      return value
        .map((entry) => this._normalizeInventoryId(entry, NaN))
        .filter(Number.isFinite)
        .filter((entry) => entry > 0);
    }

    if (value && value.type === "list" && Array.isArray(value.items)) {
      return value.items
        .map((entry) => this._normalizeInventoryId(entry, NaN))
        .filter(Number.isFinite)
        .filter((entry) => entry > 0);
    }

    const numericValue = this._normalizeInventoryId(value, 0);
    return numericValue > 0 ? [numericValue] : [];
  }

  _normalizeMergeOps(value) {
    const rawOps =
      Array.isArray(value)
        ? value
        : value && value.type === "list" && Array.isArray(value.items)
          ? value.items
          : [];

    return rawOps
      .map((entry) => {
        const tuple = Array.isArray(entry)
          ? entry
          : entry && entry.type === "tuple" && Array.isArray(entry.items)
            ? entry.items
            : [];
        if (tuple.length < 2) {
          return null;
        }

        const sourceItemID = this._normalizeInventoryId(tuple[0], 0);
        const destinationItemID = this._normalizeInventoryId(tuple[1], 0);
        const quantity = this._normalizeQuantityArg(tuple[2]);
        if (sourceItemID <= 0 || destinationItemID <= 0) {
          return null;
        }

        return {
          sourceItemID,
          destinationItemID,
          quantity,
        };
      })
      .filter(Boolean);
  }

  _normalizeQuantityArg(value) {
    if (value === undefined || value === null) {
      return null;
    }

    const numericValue = Number(value);
    if (!Number.isFinite(numericValue)) {
      return null;
    }

    const normalizedValue = Math.trunc(numericValue);
    return normalizedValue > 0 ? normalizedValue : null;
  }

  _emitSetLabelCfgDataChanged(session, itemID, label) {
    if (!session || typeof session.sendNotification !== "function") {
      return;
    }

    session.sendNotification("OnCfgDataChanged", "charid", [
      "evelocations",
      buildList([
        itemID,
        toClientSafeDisplayName(label, `Item ${itemID}`),
        null,
        // The place nought as Tranquility sends it, real numbers (a whole number is otherwise sent as an integer).
        buildMarshalReal(0),
        buildMarshalReal(0),
        buildMarshalReal(0),
        null,
      ]),
    ]);
  }

  _refreshRenamedShipPresentation(session, item) {
    if (!session || !session._space) {
      return;
    }
    const scene = runtime.getSceneForSession(session);
    const entity = scene && scene.getEntityByID(item.itemID);
    if (!entity || entity.kind !== "ship") {
      return;
    }
    entity.itemName = item.itemName;
    entity.slimName = item.itemName;
    scene.broadcastSlimItemChanges([entity]);
  }

  _refreshRenamedCargoContainerPresentation(session, item) {
    if (
      !isCargoContainerType(item) ||
      this._normalizeInventoryId(item && item.flagID, -1) !== 0 ||
      !item.spaceState
    ) {
      return;
    }

    const itemSystemID = this._normalizeInventoryId(
      item.spaceState.systemID,
      this._normalizeInventoryId(item.locationID, 0),
    );
    const scene = runtime.getSceneForSession(session);
    if (
      itemSystemID <= 0 ||
      !scene ||
      this._normalizeInventoryId(scene.systemID, 0) !== itemSystemID ||
      !scene.getEntityByID(item.itemID)
    ) {
      return;
    }

    const refreshResult = scene.refreshInventoryBackedEntityPresentation(
      item.itemID,
    );
    if (
      !refreshResult ||
      (
        refreshResult.success !== true &&
        refreshResult.errorMsg !== "DYNAMIC_ENTITY_NOT_FOUND"
      )
    ) {
      log.warn(
        `[InvBroker] SetLabel persisted container=${item.itemID} but live presentation refresh failed: ` +
        `${refreshResult && refreshResult.errorMsg || "UNKNOWN_ERROR"}`,
      );
    }
  }

  _resolveMoveQuantity(item, destination, requestedQuantity = null) {
    if (this._isStructureCoreInstallMove(item, destination)) {
      return 1;
    }

    // CCP's "Fit to Active Ship" path sends Add/MultiAdd with flagAutoFit and
    // no explicit qty, and a slot drag fits one module. For a stackable source
    // item, fitting splits off a single unit into the ship slot and leaves the
    // remainder of the stack in the source container.
    //
    // This clamp deliberately runs BEFORE the explicit-qty passthrough: a
    // fitting slot holds exactly one assembled module, so an Add carrying
    // qty=N would consume N units to produce one fitted module and destroy the
    // rest. Fit one, keep the remainder — there is no client gesture that
    // means "fit five modules into this one slot".
    if (
      item &&
      Number(item.singleton) !== 1 &&
      Number(item.categoryID) !== CHARGE_CATEGORY_ID &&
      destination &&
      isShipFittingFlag(destination.flagID)
    ) {
      return 1;
    }

    return requestedQuantity;
  }

  _resolveAppliedMoveQuantity(item, destination, requestedQuantity = null, session = null) {
    const resolvedQuantity = this._resolveMoveQuantity(
      item,
      destination,
      requestedQuantity,
    );
    const appliedQuantity = resolvedQuantity !== null && resolvedQuantity !== undefined
      ? Math.max(1, Number(resolvedQuantity) || 1)
      : !item ? 0 : Number(item.singleton) === 1
        ? 1 : Math.max(1, Number(item.stacksize ?? item.quantity ?? 1) || 1);
    const rescueDestination = session && destination
      ? getRescueDestination(session, findItemById(destination.locationID)) : null;
    return limitRescueCargoQuantity(rescueDestination, item, appliedQuantity);
  }

  _getStackableQuantity(item) {
    if (!item) {
      return 0;
    }
    return Number(item.singleton) === 1
      ? 1
      : Math.max(0, Number(item.stacksize ?? item.quantity ?? 0) || 0);
  }

  _tryLoadChargeFromInventoryAdd(
    session,
    sourceItemDescriptor,
    destination,
    requestedQuantity = null,
    options = {},
  ) {
    const sourceItem = sourceItemDescriptor && sourceItemDescriptor.item
      ? sourceItemDescriptor.item
      : null;
    if (
      !sourceItem ||
      this._normalizeInventoryId(sourceItem.categoryID, 0) !== CHARGE_CATEGORY_ID ||
      !destination ||
      !isShipFittingFlag(destination.flagID)
    ) {
      return { handled: false };
    }

    const charID = this._getCharacterId(session);
    const shipID = this._normalizeInventoryId(destination.locationID, 0);
    const flagID = this._normalizeInventoryId(destination.flagID, 0);
    const moduleItem = getFittedModuleByFlag(charID, shipID, flagID);
    const chargeTypeID = this._normalizeInventoryId(sourceItem.typeID, 0);
    if (
      charID <= 0 ||
      shipID <= 0 ||
      flagID <= 0 ||
      !moduleItem ||
      chargeTypeID <= 0 ||
      !isChargeCompatibleWithModule(moduleItem.typeID, chargeTypeID)
    ) {
      return { handled: false };
    }

    const existingCharge = getLoadedChargeByFlag(charID, shipID, flagID);
    const existingChargeTypeID = this._normalizeInventoryId(
      existingCharge && existingCharge.typeID,
      0,
    );
    if (existingCharge && existingChargeTypeID !== chargeTypeID) {
      return { handled: false };
    }

    const moduleCapacity = Math.max(
      1,
      getModuleChargeCapacity(moduleItem.typeID, chargeTypeID),
    );
    const existingQuantity = this._getStackableQuantity(existingCharge);
    // Snapshot the slot BEFORE the move so the caller can publish the charge
    // tuple's attribute 805 delta, the only thing that refreshes a slot count.
    const chargeTransition = {
      charID,
      shipID,
      flagID,
      moduleItem,
      previousChargeState: {
        typeID: existingChargeTypeID,
        quantity: existingQuantity,
      },
      previousChargeItem: existingCharge ? { ...existingCharge } : null,
    };
    const neededQuantity = Math.max(0, moduleCapacity - existingQuantity);
    if (neededQuantity <= 0) {
      return {
        handled: true,
        success: true,
        data: {
          quantity: 0,
          changes: [],
          loadedChargeItemID: existingCharge ? existingCharge.itemID : null,
        },
      };
    }

    const availableQuantity = this._getStackableQuantity(sourceItem);
    const requestedLimit =
      requestedQuantity === null || requestedQuantity === undefined
        ? availableQuantity
        : Math.max(1, Number(requestedQuantity) || 1);
    const moveQuantity = Math.min(
      neededQuantity,
      availableQuantity,
      requestedLimit,
    );
    if (moveQuantity <= 0) {
      return {
        handled: true,
        success: false,
        errorMsg: "INSUFFICIENT_ITEMS",
      };
    }

    // A charge load writes the item itself instead of going through
    // _moveSourceItemToDestination, so it answers to the same custody check,
    // after every more specific refusal has had its say.
    this._ensureInventoryCustodyTransferAccess(
      session,
      sourceItemDescriptor,
      destination,
    );

    if (typeof options.beforeCommit === "function") {
      options.beforeCommit({
        quantity: moveQuantity,
        sourceItem,
        destination,
      });
    }

    const moveResult = existingCharge
      ? invBrokerItemCustody.mergeStacks({
          sourceItem,
          destinationItem: existingCharge,
          quantity: moveQuantity,
          actor: charID,
        })
      : Number(sourceItem.ownerID) === Number(charID)
        ? invBrokerItemCustody.moveItem({
            item: sourceItem,
            ownerID: charID,
            locationID: shipID,
            flagID,
            quantity: moveQuantity,
            actor: charID,
          })
        : deliveryItemCustody.transferItem({
            item: sourceItem,
            ownerID: charID,
            locationID: shipID,
            flagID,
            quantity: moveQuantity,
            actor: charID,
            reason: itemCustody.CUSTODY_REASON.INV_BROKER_OWNER_TRANSFER,
            idempotencyKey: buildOwnerTransferIdempotencyKey(),
          });
    if (!moveResult || !moveResult.success) {
      return {
        handled: true,
        success: false,
        errorMsg: moveResult && moveResult.errorMsg
          ? moveResult.errorMsg
          : "MOVE_FAILED",
      };
    }

    const loadedChargeItemID = existingCharge
      ? existingCharge.itemID
      : this._resolveMovedItemID(moveResult, sourceItem.itemID, destination) ||
        sourceItem.itemID;

    return {
      handled: true,
      success: true,
      data: {
        quantity: moveQuantity,
        changes: (moveResult.data && moveResult.data.changes) || [],
        loadedChargeItemID,
        chargeTransition,
      },
    };
  }

  _isStructureDeedDestination(destination) {
    return (
      this._normalizeInventoryId(destination && destination.flagID, 0) ===
      ITEM_FLAGS.STRUCTURE_DEED
    );
  }

  _isStructureDeedBaySource(item) {
    return (
      this._normalizeInventoryId(item && item.flagID, 0) ===
        ITEM_FLAGS.STRUCTURE_DEED &&
      Boolean(this._getStructureForInventoryID(item && item.locationID))
    );
  }

  _validateStructureDeedBaySourceMove(item) {
    if (!this._isStructureDeedBaySource(item)) {
      return { success: true };
    }
    return {
      success: false,
      errorMsg: "CustomNotify",
      values: {
        notify: "Installed Quantum Cores cannot be moved from a structure.",
      },
    };
  }

  _isStructureOwnerBayFlag(flagID) {
    return STRUCTURE_OWNER_BAY_FLAGS.has(this._normalizeInventoryId(flagID, 0));
  }

  _isMoonMaterialBayFlag(flagID) {
    return (
      this._normalizeInventoryId(flagID, 0) === FLAG_MOON_MATERIAL_BAY
    );
  }

  _getStructureInventoryOwnerID(structure) {
    return this._normalizeInventoryId(
      structure && (structure.ownerCorpID || structure.ownerID),
      0,
    );
  }

  _getStructureForInventoryID(inventoryID) {
    const structureID = this._normalizeInventoryId(inventoryID, 0);
    return structureID > 0
      ? structureState.getStructureByID(structureID, { refresh: false })
      : null;
  }

  _isAutoMoonMinerStructure(structure) {
    return (
      this._normalizeInventoryId(structure && structure.typeID, 0) ===
      TYPE_UPWELL_AUTO_MOON_MINER
    );
  }

  _isAutoMoonMinerReinforced(structure) {
    const stateID = this._normalizeInventoryId(structure && structure.state, 0);
    return (
      stateID === STRUCTURE_STATE.ARMOR_REINFORCE ||
      stateID === STRUCTURE_STATE.HULL_REINFORCE
    );
  }

  _getStructureDisplayName(structure, structureID) {
    return (
      structure &&
      (structure.itemName || structure.name || structure.structureName)
    ) || `Structure ${this._normalizeInventoryId(structureID, 0)}`;
  }

  _throwAutoMoonMinerAccessDenied(structure, structureID) {
    throwWrappedUserError("AccessToAutoMoonMinerDenied", {
      structureName: this._getStructureDisplayName(structure, structureID),
    });
  }

  _getSessionCorpID(session) {
    return this._normalizeInventoryId(
      session && (session.corporationID || session.corpid),
      0,
    );
  }

  _normalizeCorpRoleBitfield(value) {
    if (typeof value === "bigint") {
      return value;
    }
    const numeric = Number(value);
    return BigInt(
      Number.isFinite(numeric) && numeric > 0 ? Math.trunc(numeric) : 0,
    );
  }

  _hasStationManagerRole(session) {
    const roleValue = getSessionCorporationRoleMask(session);
    return (
      this._normalizeCorpRoleBitfield(roleValue) & CORP_ROLE_STATION_MANAGER
    ) === CORP_ROLE_STATION_MANAGER;
  }

  _hasAutoMoonMinerOwnerStationManagerAccess(session, structure) {
    const ownerCorpID = this._getStructureInventoryOwnerID(structure);
    return (
      ownerCorpID > 0 &&
      this._getSessionCorpID(session) === ownerCorpID &&
      this._hasStationManagerRole(session)
    );
  }

  _ensureCanAccessMoonMaterialBay(session, structure, structureID) {
    const hasAccess = this._isAutoMoonMinerStructure(structure) && (
      this._hasAutoMoonMinerOwnerStationManagerAccess(session, structure) ||
      characterHasStructureSetting(
        session,
        structure,
        STRUCTURE_SETTING_ID.AUTOMOONMINING,
      )
    );
    if (
      !this._isAutoMoonMinerStructure(structure) ||
      !hasAccess ||
      this._isAutoMoonMinerReinforced(structure)
    ) {
      this._throwAutoMoonMinerAccessDenied(structure, structureID);
    }
    return true;
  }

  _getMoonMaterialBayCapacity(structure) {
    const attributes = getTypeDogmaAttributes(structure && structure.typeID) || {};
    const capacity = Number(
      attributes[ATTRIBUTE_OUTPUT_MOON_MATERIAL_BAY_CAPACITY] ??
      attributes[String(ATTRIBUTE_OUTPUT_MOON_MATERIAL_BAY_CAPACITY)] ??
      0,
    );
    return Number.isFinite(capacity) && capacity > 0 ? capacity : 0;
  }

  _getStructureFighterBayCapacity(structure) {
    const capacity = Number(
      getShipBaseAttributeValue(
        structure && structure.typeID,
        "fighterCapacity",
      ),
    );
    return Number.isFinite(capacity) && capacity > 0 ? capacity : 0;
  }

  _validateMoonMaterialBayDestination(session, destination) {
    if (!destination || !this._isMoonMaterialBayFlag(destination.flagID)) {
      return { success: true };
    }
    const structureID = this._normalizeInventoryId(destination.locationID, 0);
    const structure = this._getStructureForInventoryID(structureID);
    this._ensureCanAccessMoonMaterialBay(session, structure, structureID);
    return { success: false, errorMsg: "OUTPUT_ONLY" };
  }

  _validateMoonMaterialBaySourceAccess(session, sourceItem) {
    if (!sourceItem || !this._isMoonMaterialBayFlag(sourceItem.flagID)) {
      return { success: true };
    }
    const structureID = this._normalizeInventoryId(sourceItem.locationID, 0);
    const structure = this._getStructureForInventoryID(structureID);
    this._ensureCanAccessMoonMaterialBay(session, structure, structureID);
    return { success: true };
  }

  _isControlledStructureInventoryID(session, inventoryID) {
    const structureID = this._normalizeInventoryId(inventoryID, 0);
    if (structureID <= 0) {
      return false;
    }

    const sessionStructureID = this._normalizeInventoryId(
      session && (session.structureID || session.structureid),
      0,
    );
    const sessionShipID = this._normalizeInventoryId(
      session && (session.shipID || session.shipid),
      0,
    );
    return (
      sessionStructureID === structureID &&
      sessionShipID === structureID &&
      Boolean(this._getStructureForInventoryID(structureID))
    );
  }

  _usesControlledStructureInventorySemantics(
    session,
    requestedFlag,
    boundContext,
  ) {
    // Retail keeps the same station-hangar inventory remote across TakeControl:
    // only shipid changes to the structure before the fitting window calls
    // List(None). Preserve that retained remote while control is still exact.
    // The binding only speaks for control while control lasts; once the pilot
    // lets go it lists like any other docked view.
    if (boundContext?.kind === "controlledStructureInventory") {
      return this._isSessionControllingStructure(
        session,
        boundContext.inventoryID,
      );
    }

    // Boarding a non-dockable FLEX from space keeps a remote too: the one the
    // client opened on the structure from its ship to fuel it (a "container"
    // bind). invCache keys it on the structure and the board leaves locationid
    // alone, so clientDogmaLocation.LoadItemsInLocation lists the fitting
    // through it.
    return Boolean(
      requestedFlag === null &&
      boundContext &&
      (boundContext.kind === "stationHangar" || boundContext.kind === "container") &&
      this._isControlledStructureInventoryID(
        session,
        boundContext.inventoryID,
      )
    );
  }

  _getStructureForDeedDestination(destination) {
    if (!this._isStructureDeedDestination(destination)) {
      return null;
    }

    return this._getStructureForInventoryID(destination.locationID);
  }

  _getStructureForOwnerBayDestination(destination) {
    if (!destination || !this._isStructureOwnerBayFlag(destination.flagID)) {
      return null;
    }
    return this._getStructureForInventoryID(destination.locationID);
  }

  _getRequiredStructureCoreTypeID(structure) {
    if (!structure) {
      return 0;
    }

    const explicitCoreTypeID = this._normalizeInventoryId(
      structure.quantumCoreItemTypeID,
      0,
    );
    if (explicitCoreTypeID > 0) {
      return explicitCoreTypeID;
    }

    const typeRecord =
      typeof structureState.getStructureTypeByID === "function"
        ? structureState.getStructureTypeByID(structure.typeID)
        : null;
    return this._normalizeInventoryId(
      typeRecord && typeRecord.defaultQuantumCoreTypeID,
      0,
    );
  }

  _isStructureCoreInstallMove(item, destination) {
    return Boolean(
      item &&
      this._isStructureDeedDestination(destination) &&
      this._normalizeInventoryId(item.groupID, 0) === STRUCTURE_DEED_GROUP_ID
    );
  }

  _validateStructureCoreInstallMove(item, destination) {
    if (!this._isStructureDeedDestination(destination)) {
      return { success: true };
    }

    const structure = this._getStructureForDeedDestination(destination);
    if (!structure || !this._isStructureCoreInstallMove(item, destination)) {
      return { success: false, errorMsg: "NoSpaceForThat" };
    }

    const expectedCoreTypeID = this._getRequiredStructureCoreTypeID(structure);
    const itemTypeID = this._normalizeInventoryId(item && item.typeID, 0);
    if (expectedCoreTypeID > 0 && itemTypeID !== expectedCoreTypeID) {
      return {
        success: false,
        errorMsg: "CustomNotify",
        values: {
          notify: `This structure requires core type ${expectedCoreTypeID}.`,
        },
      };
    }

    const existingDeedItems = listContainerItems(
      null,
      structure.structureID,
      ITEM_FLAGS.STRUCTURE_DEED,
    ).filter(
      (existingItem) =>
        this._normalizeInventoryId(existingItem && existingItem.itemID, 0) !==
        this._normalizeInventoryId(item && item.itemID, 0),
    );
    if (structure.hasQuantumCore === true || existingDeedItems.length > 0) {
      return {
        success: false,
        errorMsg: "CustomNotify",
        values: {
          notify: "This structure already has a Quantum Core installed.",
        },
      };
    }

    return { success: true, structure, expectedCoreTypeID };
  }

  _syncStructureCoreInstall(_session, item, destination) {
    if (!this._isStructureCoreInstallMove(item, destination)) {
      return null;
    }

    const structure = this._getStructureForDeedDestination(destination);
    if (!structure) {
      return null;
    }

    const result = structureState.setStructureQuantumCoreInstalled(
      structure.structureID,
      true,
    );
    if (!result.success) {
      log.warn(
        `[InvBroker] structure core install state update failed structure=${structure.structureID} error=${result.errorMsg || "UNKNOWN"}`,
      );
      return result;
    }

    const updatedStructure = result.data || structure;
    const solarSystemID = this._normalizeInventoryId(
      updatedStructure.solarSystemID || structure.solarSystemID,
      0,
    );
    if (solarSystemID > 0) {
      runtime.syncStructureSceneState(solarSystemID, {
        reason: "structureCoreInstall",
      });
    }
    return result;
  }

  _syncStructureServiceModuleMove(session, sourceItem, destination) {
    const touchedStructureIDs = new Set();
    const sourceFlagID = this._normalizeInventoryId(sourceItem && sourceItem.flagID, 0);
    const sourceLocationID = this._normalizeInventoryId(sourceItem && sourceItem.locationID, 0);
    const destinationFlagID = this._normalizeInventoryId(destination && destination.flagID, 0);
    const destinationLocationID = this._normalizeInventoryId(destination && destination.locationID, 0);

    if (isStructureServiceSlotFlag(sourceFlagID) && sourceLocationID > 0) {
      touchedStructureIDs.add(sourceLocationID);
    }
    const removedFromSourceServiceSlots =
      isStructureServiceSlotFlag(sourceFlagID) &&
      sourceLocationID > 0 &&
      !(
        isStructureServiceSlotFlag(destinationFlagID) &&
        destinationLocationID === sourceLocationID
      );
    if (removedFromSourceServiceSlots) {
      const cancelResult = cancelIndustryJobsForRemovedServiceModule(
        sourceLocationID,
        sourceItem && sourceItem.typeID,
        {
          session,
          completedCharacterID: this._normalizeInventoryId(
            session && (session.characterID || session.charid),
            0,
          ),
          excludedItemID: this._normalizeInventoryId(sourceItem && sourceItem.itemID, 0),
        },
      );
      if (cancelResult && cancelResult.success === false) {
        log.warn(
          `[InvBroker] structure service module removal job cancel failed structure=${sourceLocationID} item=${sourceItem && sourceItem.itemID || 0} error=${cancelResult.errorMsg || "UNKNOWN"}`,
        );
        const rollbackResult = updateInventoryItem(
          this._normalizeInventoryId(sourceItem && sourceItem.itemID, 0),
          (current) => ({
            ...current,
            locationID: sourceLocationID,
            flagID: sourceFlagID,
          }),
        );
        return {
          success: false,
          errorMsg: rollbackResult.success
            ? cancelResult.errorMsg || "INDUSTRY_JOB_CANCEL_FAILED"
            : "STRUCTURE_SERVICE_MODULE_MOVE_ROLLBACK_FAILED",
          rolledBack: rollbackResult.success === true,
        };
      }
      if (
        cancelResult &&
        Array.isArray(cancelResult.unbackedServiceIDs) &&
        cancelResult.unbackedServiceIDs.includes(STRUCTURE_SERVICE_ID.MEDICAL)
      ) {
        const {
          removeJumpClonesAtStructure,
        } = require(path.join(__dirname, "../station/jumpCloneRuntime"));
        const cloneCleanupResult = removeJumpClonesAtStructure(sourceLocationID, {
          reason: "structureCloneServiceRemoved",
          destroyerID: this._normalizeInventoryId(
            session && (session.characterID || session.charid),
            0,
          ),
        });
        if (!cloneCleanupResult || cloneCleanupResult.success !== true) {
          log.warn(
            `[InvBroker] structure clone cleanup failed structure=${sourceLocationID} item=${sourceItem && sourceItem.itemID || 0} error=${cloneCleanupResult && cloneCleanupResult.errorMsg || "UNKNOWN"}`,
          );
        } else if (cloneCleanupResult.removedCloneCount > 0) {
          log.info(
            `[InvBroker] removed ${cloneCleanupResult.removedCloneCount} structure jump clones after cloning service removal structure=${sourceLocationID}`,
          );
        }
      }
    }
    if (isStructureServiceSlotFlag(destinationFlagID) && destinationLocationID > 0) {
      touchedStructureIDs.add(destinationLocationID);
      const movedItemID = this._normalizeInventoryId(sourceItem && sourceItem.itemID, 0);
      const movedItem = movedItemID > 0 ? findItemById(movedItemID) : null;
      if (
        movedItem &&
        this._normalizeInventoryId(movedItem.locationID, 0) === destinationLocationID &&
        this._normalizeInventoryId(movedItem.flagID, 0) === destinationFlagID
      ) {
        const autoOnlineResult = tryAutoOnlineFittedStructureServiceModule(
          destinationLocationID,
          movedItem,
        );
        if (
          autoOnlineResult &&
          autoOnlineResult.success === true &&
          Array.isArray(autoOnlineResult.changes) &&
          autoOnlineResult.changes.length > 0
        ) {
          this._emitInventoryMoveChanges(session, autoOnlineResult.changes);
        } else if (
          autoOnlineResult &&
          autoOnlineResult.success !== true &&
          ![
            "NOT_ENOUGH_FUEL",
            "STRUCTURE_DAMAGED",
            "STRUCTURE_SERVICE_REQUIRES_SOV_UPGRADE",
          ].includes(
            String(autoOnlineResult.errorMsg || ""),
          )
        ) {
          log.warn(
            `[InvBroker] structure service module auto-online failed structure=${destinationLocationID} item=${movedItemID} error=${autoOnlineResult.errorMsg || "UNKNOWN"}`,
          );
        }
      }
    }

    for (const structureID of touchedStructureIDs) {
      const result = syncStructureServiceModuleState(structureID);
      if (!result || result.success !== true) {
        log.warn(
          `[InvBroker] structure service module sync failed structure=${structureID} error=${result && result.errorMsg || "UNKNOWN"}`,
        );
        continue;
      }
      if (Array.isArray(result.fuelCycleChanges) && result.fuelCycleChanges.length > 0) {
        this._emitInventoryMoveChanges(session, result.fuelCycleChanges);
      }
      if (result.data && result.data.solarSystemID) {
        runtime.syncStructureSceneState(result.data.solarSystemID, {
          reason: "structureServiceModuleMove",
        });
      }
    }
    return { success: true };
  }

  // After a ship module lands in a fitting slot, leave it OFFLINE when the ship
  // cannot supply its CPU/powergrid (counting the modules already online). This
  // mirrors the live server: an over-budget module is fitted offline, not left
  // online over budget. Modules that fit keep the implicit-online default.
  // Structure service modules have their own fuel-gated auto-online path.
  // Returns the inventory changes for the offline stamp (empty when none), so
  // callers can order them after the move change they belong to.
  _resolveShipModuleFitOnlineChanges(session, sourceItem, destination) {
    const destinationFlagID = this._normalizeInventoryId(destination && destination.flagID, 0);
    const destinationLocationID = this._normalizeInventoryId(
      destination && destination.locationID,
      0,
    );
    if (
      destinationLocationID <= 0 ||
      !isShipFittingFlag(destinationFlagID) ||
      isStructureServiceSlotFlag(destinationFlagID)
    ) {
      return [];
    }

    const charID = this._getCharacterId(session);
    // Scope to the acting character's own ship; structure hosts and other-owned
    // hosts are intentionally excluded.
    const shipRecord = findCharacterShip(charID, destinationLocationID);
    if (!shipRecord) {
      return [];
    }

    const movedItemID = this._normalizeInventoryId(sourceItem && sourceItem.itemID, 0);
    const movedItem = movedItemID > 0 ? findItemById(movedItemID) : null;
    if (
      !movedItem ||
      this._normalizeInventoryId(movedItem.locationID, 0) !== destinationLocationID ||
      this._normalizeInventoryId(movedItem.flagID, 0) !== destinationFlagID
    ) {
      return [];
    }

    const fittedItems = listFittedItems(charID, destinationLocationID);
    const decision = resolveFitOnlineState(charID, shipRecord, movedItem, fittedItems);
    if (!decision.applies || decision.online !== false) {
      return [];
    }

    const alreadyOffline =
      movedItem.moduleState && movedItem.moduleState.online === false;
    if (alreadyOffline) {
      return [];
    }

    const updateResult = updateInventoryItem(movedItemID, (currentItem) => ({
      ...currentItem,
      moduleState: {
        ...(currentItem.moduleState || {}),
        online: false,
      },
    }));
    if (!updateResult || updateResult.success !== true) {
      log.warn(
        `[InvBroker] ship module fit auto-offline failed ship=${destinationLocationID} item=${movedItemID} reason=${decision.reason || "UNKNOWN"} error=${updateResult && updateResult.errorMsg || "UNKNOWN"}`,
      );
      return [];
    }

    log.debug(
      `[InvBroker] fitted module left offline ship=${destinationLocationID} item=${movedItemID} reason=${decision.reason || "UNKNOWN"}`,
    );
    return [
      {
        previousData: updateResult.previousData || movedItem,
        item: updateResult.data,
      },
    ];
  }

  _isLootContainerEntity(session, entityID) {
    const numericEntityID = this._normalizeInventoryId(entityID, 0);
    if (numericEntityID <= 0) {
      return false;
    }

    const scene = runtime.getSceneForSession(session);
    const entity = scene && scene.getEntityByID(numericEntityID);
    return Boolean(
      entity && (entity.kind === "container" || entity.kind === "wreck")
    );
  }

  _isFleetLootSource(session, sourceItemDescriptor, sourceLocationID = 0) {
    if (!sourceItemDescriptor || !sourceItemDescriptor.item) {
      return false;
    }

    if (sourceItemDescriptor.sourceKind === "nativeWreck") {
      return true;
    }

    const itemLocationID = this._normalizeInventoryId(
      sourceItemDescriptor.item.locationID,
      0,
    );
    if (this._isLootContainerEntity(session, itemLocationID)) {
      return true;
    }

    const explicitSourceLocationID = this._normalizeInventoryId(
      sourceLocationID,
      0,
    );
    return explicitSourceLocationID > 0
      ? this._isLootContainerEntity(session, explicitSourceLocationID)
      : false;
  }

  _appendFleetLootEntry(
    session,
    fleetLootEntries,
    sourceItemDescriptor,
    sourceLocationID,
    destination,
    requestedQuantity,
  ) {
    if (
      !Array.isArray(fleetLootEntries) ||
      !this._isFleetLootSource(session, sourceItemDescriptor, sourceLocationID)
    ) {
      return;
    }

    const item =
      sourceItemDescriptor && sourceItemDescriptor.item
        ? sourceItemDescriptor.item
        : null;
    const typeID = this._normalizeInventoryId(item && item.typeID, 0);
    const quantity = this._resolveAppliedMoveQuantity(
      item,
      destination,
      requestedQuantity,
    );
    if (typeID <= 0 || quantity <= 0) {
      return;
    }

    fleetLootEntries.push({
      typeID,
      quantity,
    });
  }

  _emitFleetLootEvents(session, fleetLootEntries = []) {
    if (!Array.isArray(fleetLootEntries) || fleetLootEntries.length <= 0) {
      return;
    }

    fleetRuntime.recordLootEventsForSession(session, fleetLootEntries);
  }

  _destinationUsesCapacity(
    boundContext,
    destination,
    destinationRecord = destination && findStarbaseItemById(destination.locationID),
  ) {
    if (!boundContext || !destination) {
      return false;
    }
    if (starbaseInventoryRuntime.isBatteryAmmoInventory(destinationRecord)) return true;
    if (starbaseProcessingInventory.isProcessingStorage(destinationRecord)) return true;

    if (
      boundContext.kind === "shipInventory" &&
      isShipFittingFlag(destination.flagID)
    ) {
      return false;
    }

    if (
      boundContext.kind === "controlledStructureInventory" &&
      this._isStructureOwnerBayFlag(destination.flagID)
    ) {
      return true;
    }

    // A structure's fighter bay has a real capacity whichever binding reaches
    // it. Docked in the structure, the client opens the bay through the hangar
    // binding, so that route has to count the same.
    if (
      this._normalizeInventoryId(destination.flagID, 0) === ITEM_FLAGS.FIGHTER_BAY &&
      this._getStructureForInventoryID(destination.locationID)
    ) {
      return true;
    }

    // A client can also reach a ship or a container by binding [itemID, flag]
    // directly instead of opening it with GetInventoryFromId. The hold is the
    // same hold either way, so it has to count the same: without this a
    // 3,900 m3 hauler took 5,000 m3 of ore through the direct bind.
    if (boundContext.kind === "boundInventory") {
      const inventoryID = this._normalizeInventoryId(boundContext.inventoryID, 0);
      if (inventoryID > 0 && findShipItemById(inventoryID)) {
        return !isShipFittingFlag(destination.flagID);
      }
      return this._isCargoContainerInventoryItem(findItemById(inventoryID));
    }

    return (
      boundContext.kind === "shipInventory" ||
      boundContext.kind === "container"
    );
  }

  _getMoveCapacityError(boundContext, destination, item) {
    if (
      boundContext &&
      boundContext.kind === "shipInventory" &&
      Number(destination && destination.flagID) === ITEM_FLAGS.DRONE_BAY
    ) {
      return "NotEnoughDroneBaySpace";
    }

    if (
      boundContext &&
      boundContext.kind === "shipInventory" &&
      Number(destination && destination.flagID) === ITEM_FLAGS.FIGHTER_BAY
    ) {
      return "NotEnoughFighterBaySpace";
    }

    if (
      boundContext &&
      Number(destination && destination.flagID) === ITEM_FLAGS.FIGHTER_BAY
    ) {
      return "NotEnoughFighterBaySpace";
    }

    if (
      boundContext &&
      boundContext.kind === "shipInventory" &&
      isShipFittingFlag(Number(destination && destination.flagID)) &&
      Number(item && item.categoryID) === 8
    ) {
      return "NotEnoughChargeSpace";
    }

    if (boundContext && boundContext.kind === "container") {
      return "NoSpaceForThat";
    }

    return "NotEnoughCargoSpace";
  }

  _getMobileDepotCargoAccessError(session, containerID) {
    const numericContainerID = this._normalizeInventoryId(containerID, 0);
    if (numericContainerID <= 0) {
      return null;
    }

    const containerRecord = findItemById(numericContainerID);
    if (!isMobileDepotItemRecord(containerRecord)) {
      return null;
    }

    const accessResult = validateMobileDepotCargoAccess(session, containerRecord);
    return accessResult && accessResult.success
      ? null
      : accessResult.errorMsg || "ACCESS_DENIED";
  }

  _getMobileTractorUnitCargoAccessError(session, containerID) {
    const numericContainerID = this._normalizeInventoryId(containerID, 0);
    if (numericContainerID <= 0) {
      return null;
    }

    const containerRecord = findItemById(numericContainerID);
    if (!this._isMobileTractorUnitInventoryItem(containerRecord)) {
      return null;
    }

    const accessResult = validateMobileTractorUnitCargoAccess(
      session,
      containerRecord,
    );
    return accessResult && accessResult.success
      ? null
      : accessResult.errorMsg || "ACCESS_DENIED";
  }

  _getCustomsOfficeLocalScopeAccessError(session, scene, ship, office) {
    if (
      !ship || !office || !canEntitiesInteractLocally(ship, office) ||
      (typeof scene.canSessionSeeDungeonScopedEntity === "function" &&
        !scene.canSessionSeeDungeonScopedEntity(session, office))
    ) {
      return "CUSTOMS_OFFICE_NOT_AVAILABLE";
    }
    return null;
  }

  _getCustomsOfficePresenceAccessError(session, office, scene = runtime.getSceneForSession(session)) {
    if (!office) return null;
    if (isDockedSession(session)) return "CUSTOMS_OFFICE_DOCKED";
    const systemID = this._normalizeInventoryId(session && session._space && session._space.systemID, 0);
    const shipID = this._normalizeInventoryId(session && session._space && session._space.shipID, 0);
    if (!systemID || !shipID || systemID !== this._normalizeInventoryId(office.solarSystemID, 0) ||
      this._hasAbyssalScopeSignal(session)) {
      return "CUSTOMS_OFFICE_NOT_IN_SYSTEM";
    }
    if (scene) {
      const descriptor = normalizeSceneDescriptor(scene.sceneDescriptor || scene);
      const publicSceneKey = buildSolarSystemSceneKey(systemID);
      if (!descriptor || descriptor.sceneKind !== SCENE_KIND_SOLAR_SYSTEM ||
        descriptor.solarSystemID !== systemID || Number(scene.systemID) !== systemID ||
        (scene.sceneKind && scene.sceneKind !== SCENE_KIND_SOLAR_SYSTEM) ||
        (scene.sceneKey && scene.sceneKey !== publicSceneKey) ||
        this._hasAbyssalScopeSignal(scene)) {
        return "CUSTOMS_OFFICE_NOT_IN_SYSTEM";
      }
      const ship = typeof scene.getEntityByID === "function" && scene.getEntityByID(shipID);
      // PI is allowed across the public system, even when the office has not
      // been delivered to the client. Its persisted record still identifies
      // the public target for the AIR/Abyssal interaction boundary.
      const orbital = typeof scene.getEntityByID === "function" && scene.getEntityByID(Number(office.itemID));
      return this._getCustomsOfficeLocalScopeAccessError(session, scene, ship, orbital || office);
    }
    return null;
  }

  _getCustomsOfficeTransferAccessError(session, containerID) {
    if (!planetOrbitalState.mayResolveOrbitalID(containerID)) return null;
    const office = planetOrbitalState.resolveOrbitalOrDefaultByID(
      this._normalizeInventoryId(containerID, 0),
    );
    if (!office || ![planetOrbitalState.GROUP_PLANETARY_CUSTOMS_OFFICES,
      planetOrbitalState.GROUP_ORBITAL_SKYHOOK].includes(Number(office.groupID))) return null;
    if (!planetOrbitalState.isCustomsInventoryOrbitalRecord(office)) {
      return "CUSTOMS_OFFICE_NOT_AVAILABLE";
    }
    const scene = runtime.getSceneForSession(session);
    const presenceError = this._getCustomsOfficePresenceAccessError(session, office, scene);
    if (presenceError) return presenceError;
    // Use the exact session scene: a numeric system ID alone is insufficient
    // authority for isolated scenes sharing a host location.
    const shipID = this._normalizeInventoryId(session._space.shipID, 0);
    const ship = scene && scene.getEntityByID(shipID);
    const orbital = scene && scene.getEntityByID(Number(office.itemID));
    if (!ship || !orbital || ![ship, orbital].every((entity) => entity.position &&
      ["x", "y", "z"].every((axis) => Number.isFinite(Number(entity.position[axis]))))) {
      return "CUSTOMS_OFFICE_NOT_AVAILABLE";
    }
    const scopeError = this._getCustomsOfficeLocalScopeAccessError(session, scene, ship, orbital);
    if (scopeError) return scopeError;
    if (this._isActiveShipCloaked(session, shipID)) return "CUSTOMS_OFFICE_CLOAKED";
    const distance = Math.hypot(...["x", "y", "z"].map((axis) =>
      Number(ship.position[axis]) - Number(orbital.position[axis]))) -
      Math.max(0, Number(ship.radius) || 0) - Math.max(0, Number(orbital.radius) || 0);
    return distance > MAX_CARGO_CONTAINER_TRANSFER_DISTANCE_METERS
      ? "CUSTOMS_OFFICE_TOO_FAR" : null;
  }

  _getSpaceContainerScopeAccessError(session, containerID, options = {}) {
    const numericContainerID = this._normalizeInventoryId(containerID, 0);
    if (numericContainerID <= 0) {
      return null;
    }
    if (options.customsMutation === true) {
      const customsError = this._getCustomsOfficeTransferAccessError(session, numericContainerID);
      if (customsError) return customsError;
    }

    const systemID = this._normalizeInventoryId(
      session && session._space && session._space.systemID,
      0,
    );
    const shipID = this._normalizeInventoryId(
      session && session._space && session._space.shipID,
      0,
    );
    const containerRecord = this._getSpaceScopeInventoryRecord(numericContainerID);
    if (require("../sovereignty/skyhookRaidRuntime").isSealedRaidContainer(containerRecord)) return "CONTAINER_NOT_VISIBLE";
    const analysisBeacon = require("../ship/mobileAnalysisBeaconRuntime");
    const analysisBeaconState = analysisBeacon.getMobileAnalysisBeaconStateFromItem(containerRecord);
    const analysisBeaconError = analysisBeacon.getBeaconCargoAccessError(session, containerRecord);
    if (analysisBeaconError) return analysisBeaconError;
    const isPersistedSpaceItem = this._isPersistedSpaceInventoryRecord(containerRecord);
    const isStarbaseCorporateHangar =
      isStarbaseCorporateHangarArrayType(containerRecord);
    if (starbaseInventoryRuntime.isTowerBay(containerRecord)) {
      const access = starbaseInventoryRuntime.validateTowerBayAccess(session, containerRecord,
        options.towerManagementRead === true ? "view" : "viewput");
      return access.success ? null : access.errorMsg;
    }
    if (starbaseProcessingInventory.isProcessingStorage(containerRecord)) {
      const access = starbaseProcessingInventory.validateProcessingAccess(session, containerRecord);
      return access.success ? null : access.errorMsg;
    }
    if (starbaseInventoryRuntime.isBatteryAmmoInventory(containerRecord)) {
      const access = starbaseInventoryRuntime.validateBatteryAmmoInventoryAccess(session, containerRecord);
      return access.success ? null : access.errorMsg;
    }
    if (starbaseInventoryRuntime.isMaintenanceArray(containerRecord)) {
      const access = starbaseInventoryRuntime.validateMaintenanceInventoryAccess(session, containerRecord);
      return access.success ? null : access.errorMsg;
    }
    if (isStarbaseCorporateHangar) {
      if (this._normalizeInventoryId(containerRecord.ownerID, 0) !==
          this._normalizeInventoryId(this._getCorporationId(session), 0)) {
        return "CONTAINER_NOT_VISIBLE";
      }
      const access = starbaseInventoryRuntime.validateStarbaseInventoryAccess(session, containerRecord);
      if (access.success) return null;
      return ({
        STARBASE_INVENTORY_OFFLINE: "STARBASE_CORPORATE_HANGAR_OFFLINE",
        STARBASE_INVENTORY_TOO_FAR: "STARBASE_CORPORATE_HANGAR_TOO_FAR",
        STARBASE_INVENTORY_TOWER_UNAVAILABLE: "STARBASE_CORPORATE_HANGAR_TOWER_UNAVAILABLE",
      })[access.errorMsg] || "CONTAINER_NOT_VISIBLE";
    }
    const nativeWreckRecord = this._getNativeWreckRecord(numericContainerID);
    const isNativeWreck = Boolean(nativeWreckRecord);
    const isProtectedSpaceInventoryItem = Boolean(
      isPersistedSpaceItem &&
      (
        this._isSpaceContainerLikeInventoryItem(containerRecord) ||
        this._isWreckInventoryItem(containerRecord) ||
        this._isMobileTractorUnitInventoryItem(containerRecord) ||
        analysisBeaconState
      )
    );
    const requiresExactScenePresence = Boolean(
      this._hasAbyssalScopeSignal(session) ||
      this._hasAbyssalScopeSignal(containerRecord) ||
      this._hasAbyssalScopeSignal(nativeWreckRecord)
    );
    const requiresVisibleSpaceEntity = Boolean(
      isNativeWreck ||
      isProtectedSpaceInventoryItem ||
      (requiresExactScenePresence && isPersistedSpaceItem)
    );
    if (systemID <= 0 || shipID <= 0) {
      return requiresVisibleSpaceEntity
        ? "CONTAINER_NOT_VISIBLE"
        : null;
    }

    // Inventory authority must follow the session's exact scene descriptor.
    // Abyssal runs can share a numeric host location, so ensureScene(systemID)
    // would inspect the public host scene and silently authorize a container
    // that belongs to another isolated run.
    const scene =
      runtime.getSceneForSession(session) ||
      (!requiresExactScenePresence ? runtime.ensureScene(systemID) : null);
    const targetEntity = scene && scene.getEntityByID(numericContainerID);
    if (!targetEntity) {
      return requiresVisibleSpaceEntity
        ? "CONTAINER_NOT_VISIBLE"
        : null;
    }
    const targetIsMobileTractorUnit = Boolean(
      this._isMobileTractorUnitInventoryItem(containerRecord) &&
      targetEntity.kind === "deployable"
    );
    if (
      targetEntity.kind !== "container" &&
      targetEntity.kind !== "wreck" &&
      !targetIsMobileTractorUnit &&
      !analysisBeaconState
    ) {
      return null;
    }
    if (
      typeof scene.canSessionSeeDungeonScopedEntity === "function" &&
      !scene.canSessionSeeDungeonScopedEntity(session, targetEntity)
    ) {
      return "CONTAINER_NOT_VISIBLE";
    }

    const shipEntity = scene.getEntityByID(shipID);
    if (!shipEntity || !canEntitiesInteractLocally(shipEntity, targetEntity)) {
      return "CONTAINER_NOT_VISIBLE";
    }
    if (isPersistedSpaceItem || isNativeWreck) {
      const shipPosition = shipEntity.position;
      const targetPosition = targetEntity.position;
      const hasFinitePosition = (position) => Boolean(
        position &&
        Number.isFinite(Number(position.x)) &&
        Number.isFinite(Number(position.y)) &&
        Number.isFinite(Number(position.z))
      );
      if (!hasFinitePosition(shipPosition) || !hasFinitePosition(targetPosition)) {
        return "CONTAINER_NOT_VISIBLE";
      }
      const dx = Number(shipPosition.x) - Number(targetPosition.x);
      const dy = Number(shipPosition.y) - Number(targetPosition.y);
      const dz = Number(shipPosition.z) - Number(targetPosition.z);
      // Measure hull to hull, as the client does. Open Cargo flies the ship in
      // only until the ball's surfaceDist (both radii off) drops under 2,500 m
      // and then sends the open (autopilot.InInteractionRange). Measuring from
      // the ship's centre refused every pilot the client had just put in range
      // for the length of their own radius, and the client then drew the
      // refusal as a raw template. The scoop gate measures the same way.
      const surfaceDistance =
        typeof scene.getEntitySurfaceDistance === "function"
          ? scene.getEntitySurfaceDistance(shipEntity, targetEntity)
          : Math.max(
            0,
            Math.hypot(dx, dy, dz) -
              Math.max(0, Number(shipEntity.radius) || 0) -
              Math.max(0, Number(targetEntity.radius) || 0),
          );
      if (!Number.isFinite(surfaceDistance)) {
        return "CONTAINER_NOT_VISIBLE";
      }
      if (surfaceDistance > Number(MAX_CARGO_CONTAINER_TRANSFER_DISTANCE_METERS || 2_500)) {
        return "CONTAINER_TOO_FAR";
      }
    }
    // Inventory bindings may outlive a failed or interrupted attempt. Check the
    // authoritative scene entity for every read and transfer, rather than
    // trusting the client's cached inventory or an earlier successful bind.
    // Cargo scanners read through their own scanner callbacks and do not use
    // this inventory admission path.
    if (
      hackingContainerState.isHackable(targetEntity) &&
      hackingContainerState.getState(targetEntity) !== 2
    ) {
      return "CONTAINER_NOT_HACKED";
    }
    return null;
  }

  _getSpaceScopeInventoryRecord(inventoryID) {
    return findItemById(this._normalizeInventoryId(inventoryID, 0));
  }

  _hasAbyssalScopeSignal(source) {
    if (!source || typeof source !== "object" || Array.isArray(source)) {
      return false;
    }

    const candidates = [source];
    if (
      source.spaceState &&
      typeof source.spaceState === "object" &&
      !Array.isArray(source.spaceState)
    ) {
      candidates.push(source.spaceState);
    }
    if (source._space && typeof source._space === "object" && !Array.isArray(source._space)) {
      candidates.push(source._space);
    }
    const customInfo = String(source.customInfo || "").trim();
    if (customInfo) {
      try {
        const parsedCustomInfo = JSON.parse(customInfo);
        if (parsedCustomInfo && typeof parsedCustomInfo === "object") {
          candidates.push(parsedCustomInfo);
          for (const value of Object.values(parsedCustomInfo)) {
            if (value && typeof value === "object" && !Array.isArray(value)) {
              candidates.push(value);
            }
          }
        }
      } catch (_) {
        // ignored: opaque legacy customInfo does not create Abyssal scope authority.
      }
    }

    return candidates.some((candidate) => {
      const scope = resolveEntityInteractionScope(candidate);
      return Boolean(
        scope && (scope.hasAbyssalScope || scope.hasAbyssalRoomScope) ||
        String(candidate.sceneKind || "").trim().toLowerCase() === "abyssal" ||
        String(candidate.instanceScope || "").trim().toLowerCase() === "abyssal" ||
        String(candidate.sceneKey || "").trim().toLowerCase().startsWith("abyssal-run:")
      );
    });
  }

  _isPersistedSpaceInventoryRecord(item) {
    if (
      !item ||
      this._normalizeInventoryId(item.flagID, -1) !== 0 ||
      !item.spaceState ||
      typeof item.spaceState !== "object"
    ) {
      return false;
    }

    const locationID = this._normalizeInventoryId(item.locationID, 0);
    return Boolean(
      locationID > 0 &&
      this._normalizeInventoryId(item.spaceState.systemID, 0) === locationID
    );
  }

  _getAuthoritativeTransferSourceLocationID(sourceItemDescriptor) {
    if (!sourceItemDescriptor || !sourceItemDescriptor.item) {
      return 0;
    }
    if (sourceItemDescriptor.sourceKind === "nativeWreck") {
      return this._normalizeInventoryId(
        sourceItemDescriptor.wreckItem && sourceItemDescriptor.wreckItem.wreckID,
        0,
      );
    }
    return this._normalizeInventoryId(sourceItemDescriptor.item.locationID, 0);
  }

  _getAuthoritativeTransferSourceContainerIDs(sourceItemDescriptor) {
    const sourceContainerIDs = [];
    const seen = new Set();
    const addSourceContainerID = (value) => {
      const numericValue = this._normalizeInventoryId(value, 0);
      if (numericValue > 0 && !seen.has(numericValue)) {
        seen.add(numericValue);
        sourceContainerIDs.push(numericValue);
      }
      return numericValue;
    };

    if (!sourceItemDescriptor || !sourceItemDescriptor.item) {
      return sourceContainerIDs;
    }
    if (sourceItemDescriptor.sourceKind === "nativeWreck") {
      addSourceContainerID(
        sourceItemDescriptor.wreckItem && sourceItemDescriptor.wreckItem.wreckID,
      );
      return sourceContainerIDs;
    }

    let currentItem = sourceItemDescriptor.item;
    if (this._isPersistedSpaceInventoryRecord(currentItem)) {
      addSourceContainerID(currentItem.itemID);
    }
    while (currentItem) {
      const parentID = this._normalizeInventoryId(currentItem.locationID, 0);
      if (parentID <= 0 || seen.has(parentID)) {
        break;
      }
      addSourceContainerID(parentID);
      const parentItem = this._getSpaceScopeInventoryRecord(parentID);
      if (!parentItem) {
        break;
      }
      currentItem = parentItem;
    }
    return sourceContainerIDs;
  }

  _validateAuthoritativeSpaceContainerScopeTransferAccess(
    session,
    sourceItemDescriptor,
    destinationContainerID,
  ) {
    const sourceContainerIDs = this._getAuthoritativeTransferSourceContainerIDs(sourceItemDescriptor);
    for (const containerID of sourceContainerIDs) {
      const tower = findStarbaseItemById(containerID);
      if (starbaseProcessingInventory.isProcessingStorage(tower)) {
        const access = starbaseProcessingInventory.validateProcessingAccess(session, tower, "viewputtake");
        if (!access.success) return { ...access, containerID };
        if (Number(sourceItemDescriptor.item.flagID) !== starbaseProcessingInventory.getProcessingFlag(tower) ||
            Number(sourceItemDescriptor.item.ownerID) !== Number(tower.ownerID)) {
          return { success: false, errorMsg: "STARBASE_PROCESSING_INVALID_ITEM", containerID };
        }
      }
      if (starbaseInventoryRuntime.isTowerBay(tower)) {
        const access = starbaseInventoryRuntime.validateTowerBayAccess(session, tower, "viewputtake");
        if (!access.success) return { ...access, containerID };
        const errorMsg = require("../starbase/starbaseReinforcementRuntime")
          .validateTowerBayMutation(tower, sourceItemDescriptor.item.flagID);
        if (errorMsg) return { success: false, errorMsg, containerID };
      }
      if (starbaseInventoryRuntime.isBatteryAmmoInventory(tower)) {
        const access = starbaseInventoryRuntime.validateBatteryAmmoInventoryAccess(session, containerID, "viewputtake");
        if (!access.success) return { ...access, containerID };
      }
      if (starbaseInventoryRuntime.isMaintenanceArray(tower)) {
        const access = starbaseInventoryRuntime.validateMaintenanceInventoryAccess(session, containerID, "viewputtake");
        if (!access.success) return { ...access, containerID };
      }
    }
    const containers = [
      ...sourceContainerIDs.map((containerID) => ["source", containerID]),
      ["destination", destinationContainerID],
    ];
    for (const [side, containerID] of containers) {
      const accessError = this._getSpaceContainerScopeAccessError(
        session,
        containerID,
        { customsMutation: true },
      );
      if (accessError) {
        return {
          success: false,
          errorMsg: accessError,
          containerID: this._normalizeInventoryId(containerID, 0),
          side,
        };
      }
    }
    return { success: true };
  }

  _readAbyssalRewardContainerState(containerRecord) {
    if (!containerRecord || typeof containerRecord !== "object") {
      return null;
    }
    let customInfo = null;
    try {
      customInfo = JSON.parse(String(containerRecord.customInfo || ""));
    } catch (_) {
      // ignored: a container whose customInfo is not JSON has no Abyssal reward state (null)
      return null;
    }
    const state = customInfo && (
      customInfo.evejsAbyssalRewardCache ||
      customInfo.evejsAbyssalExtractionNode
    );
    if (!state || typeof state !== "object" || Array.isArray(state)) {
      return null;
    }
    const role = String(state.role || state.abyssalEntityRole || "")
      .trim()
      .toLowerCase();
    return role === "cache_loot_container" ||
      role === "extraction_node_loot_container" ||
      role === "reward_wreck"
      ? state
      : null;
  }

  _getAbyssalRewardContainerAccessError(session, containerID) {
    const numericContainerID = this._normalizeInventoryId(containerID, 0);
    const containerRecord = numericContainerID > 0
      ? this._getSpaceScopeInventoryRecord(numericContainerID)
      : null;
    const rewardState = this._readAbyssalRewardContainerState(containerRecord);
    if (!rewardState) {
      return null;
    }

    const deliveryState = String(rewardState.deliveryState || "")
      .trim()
      .toLowerCase();
    if (
      rewardState.presentationEnabled === false ||
      rewardState.mechanicsEnabled === false ||
      rewardState.lootable === false ||
      rewardState.isLootable === false ||
      rewardState.rewardSuppressed === true ||
      (deliveryState && deliveryState !== "visible")
    ) {
      return "ABYSSAL_REWARD_NOT_LOOTABLE";
    }

    const characterID = this._normalizeInventoryId(this._getCharacterId(session), 0);
    const beneficiaryCharacterID = this._normalizeInventoryId(
      rewardState.characterID,
      0,
    );
    const participantCharacterIDs = new Set(
      (Array.isArray(rewardState.participantCharacterIDs)
        ? rewardState.participantCharacterIDs
        : [])
        .map((participantCharacterID) =>
          this._normalizeInventoryId(participantCharacterID, 0)
        )
        .filter((participantCharacterID) => participantCharacterID > 0),
    );
    const staticallyAuthorizedParticipant = Boolean(
      characterID > 0 &&
      (
        beneficiaryCharacterID === characterID ||
        participantCharacterIDs.has(characterID)
      )
    );

    const scene = runtime.getSceneForSession(session);
    const entity = scene && scene.getEntityByID(numericContainerID);
    const entityArtifactState = entity && entity.evejsAbyssalArtifactState;
    const entityDeliveryState = String(
      entity && (
        entity.abyssalRoomDeliveryState ||
        entity.evejsAbyssalRoomDeliveryState ||
        (entityArtifactState && entityArtifactState.deliveryState) ||
        ""
      ),
    ).trim().toLowerCase();
    if (
      entity && (
        entity.lootable === false ||
        entity.isLootable === false ||
        entity.abyssalRewardSuppressed === true ||
        entity.evejsAbyssalRewardSuppressed === true ||
        (entityDeliveryState && entityDeliveryState !== "visible")
      )
    ) {
      return "ABYSSAL_REWARD_NOT_LOOTABLE";
    }

    // The manager owns the durable suppression claim. Consult it lazily so
    // inventory initialization does not introduce a module-load cycle.
    try {
      const AbyssalMgrService = require("../../abyssal").scenePolicy;
      const shipID = this._normalizeInventoryId(this._getShipId(session), 0);
      const characterPocketState =
        (
          characterID > 0 &&
          typeof AbyssalMgrService.getActiveAbyssalRunForCharacterID === "function" &&
          AbyssalMgrService.getActiveAbyssalRunForCharacterID(characterID)
        ) || null;
      const shipPocketState =
        (
          shipID > 0 &&
          typeof AbyssalMgrService.getActiveAbyssalRunForShipID === "function" &&
          AbyssalMgrService.getActiveAbyssalRunForShipID(shipID)
        ) || null;
      // Ship scope may locate state for a character already authorized by the
      // reward metadata, but it cannot establish character identity. A stale
      // ship binding must never authorize a different pilot.
      const pocketState = characterPocketState || (
        staticallyAuthorizedParticipant ? shipPocketState : null
      );
      const expectedInstanceID = this._normalizeInventoryId(rewardState.instanceID, 0);
      const activeInstanceID = this._normalizeInventoryId(
        pocketState && pocketState.instanceID,
        0,
      );
      const durablyAuthorizedParticipant = Boolean(
        expectedInstanceID > 0 &&
        this._normalizeInventoryId(
          characterPocketState && characterPocketState.instanceID,
          0,
        ) === expectedInstanceID
      );
      if (
        beneficiaryCharacterID > 0 &&
        characterID > 0 &&
        !staticallyAuthorizedParticipant &&
        !durablyAuthorizedParticipant
      ) {
        return "CONTAINER_NOT_VISIBLE";
      }
      if (
        expectedInstanceID > 0 &&
        activeInstanceID > 0 &&
        expectedInstanceID !== activeInstanceID
      ) {
        return "CONTAINER_NOT_VISIBLE";
      }
      const roomStatesByIndex =
        pocketState && pocketState.roomState &&
        pocketState.roomState.roomStatesByIndex &&
        typeof pocketState.roomState.roomStatesByIndex === "object"
          ? pocketState.roomState.roomStatesByIndex
          : {};
      const suppressionPending = Object.values(roomStatesByIndex).some((roomEntry) =>
        Array.isArray(roomEntry && roomEntry.rewardSuppressionPendingRemovalItemIDs) &&
        roomEntry.rewardSuppressionPendingRemovalItemIDs.some(
          (itemID) => this._normalizeInventoryId(itemID, 0) === numericContainerID,
        ),
      );
      if (suppressionPending) {
        return "ABYSSAL_REWARD_SUPPRESSION_PENDING";
      }
    } catch (error) {
      log.debug(
        `[InvBroker] Abyssal reward policy lookup unavailable container=${numericContainerID} error=${error.message}`,
      );
      return "ABYSSAL_REWARD_POLICY_UNAVAILABLE";
    }

    return null;
  }

  _validateAuthoritativeAbyssalRewardTransferAccess(
    session,
    sourceItemDescriptor,
  ) {
    for (const containerID of this._getAuthoritativeTransferSourceContainerIDs(
      sourceItemDescriptor,
    )) {
      const accessError = this._getAbyssalRewardContainerAccessError(
        session,
        containerID,
      );
      if (accessError) {
        return {
          success: false,
          errorMsg: accessError,
          containerID: this._normalizeInventoryId(containerID, 0),
        };
      }
    }
    return { success: true };
  }

  _validateDeclaredTransferSourceAccess(
    session,
    sourceItemDescriptor,
    sourceLocationID,
    destinationContainerID = 0,
  ) {
    if (!sourceItemDescriptor || !sourceItemDescriptor.item) {
      return { success: false, errorMsg: "SOURCE_ITEM_NOT_FOUND" };
    }
    const declaredSourceLocationID = this._normalizeInventoryId(sourceLocationID, 0);
    if (
      declaredSourceLocationID <= 0 ||
      !this._isTransferSourceLocationMatch(
        sourceItemDescriptor,
        declaredSourceLocationID,
      )
    ) {
      return { success: false, errorMsg: "SOURCE_LOCATION_MISMATCH" };
    }
    const scopeAccess = this._validateAuthoritativeSpaceContainerScopeTransferAccess(
      session,
      sourceItemDescriptor,
      destinationContainerID,
    );
    if (!scopeAccess.success) {
      return scopeAccess;
    }
    return this._validateAuthoritativeAbyssalRewardTransferAccess(
      session,
      sourceItemDescriptor,
    );
  }

  _validateSpaceContainerScopeTransferAccess(
    session,
    sourceContainerID,
    destinationContainerID,
  ) {
    for (const containerID of [sourceContainerID, destinationContainerID]) {
      const accessError = this._getSpaceContainerScopeAccessError(
        session,
        containerID,
        { customsMutation: true },
      );
      if (accessError) {
        return {
          success: false,
          errorMsg: accessError,
          containerID: this._normalizeInventoryId(containerID, 0),
        };
      }
    }
    return { success: true };
  }

  _isKnownInventoryAncestorRoot(session, locationID) {
    const numericLocationID = this._normalizeInventoryId(locationID, 0);
    if (numericLocationID <= 0) {
      return false;
    }
    const sessionRootIDs = [
      this._getCharacterId(session),
      this._getCorporationId(session),
      this._getStationId(session),
      this._getShipId(session),
      session && (session.activeShipID ?? session.shipID ?? session.shipid),
      session && session._space && session._space.shipID,
      session && (session.locationID ?? session.locationid),
      session && (session.structureID ?? session.structureid),
      session && (session.solarsystemid2 ?? session.solarsystemid),
      session && session._space && session._space.systemID,
    ].map((value) => this._normalizeInventoryId(value, 0));
    if (sessionRootIDs.includes(numericLocationID)) {
      return true;
    }
    return Boolean(
      worldData.getStationByID(numericLocationID) ||
      worldData.getSolarSystemByID(numericLocationID) ||
      this._getCorporationOffice(session, numericLocationID) ||
      this._getStructureForInventoryID(numericLocationID) ||
      this._getNativeWreckRecord(numericLocationID)
    );
  }

  _resolveInventoryTransferAncestorChain(session, startLocationID) {
    const chain = [];
    const seen = new Set();
    let currentID = this._normalizeInventoryId(startLocationID, 0);
    if (currentID <= 0) {
      return {
        success: false,
        errorMsg: "INVENTORY_ANCESTOR_NOT_FOUND",
        containerID: currentID,
        chain,
      };
    }

    while (chain.length < 128) {
      if (seen.has(currentID)) {
        return {
          success: false,
          errorMsg: "INVENTORY_ANCESTOR_CYCLE",
          containerID: currentID,
          chain,
        };
      }
      seen.add(currentID);

      // A Customs Office is the root of its depositor-scoped inventory.  A
      // synthesized InterBus office has no item row at all, while an anchored
      // POCO's row is located on a planet (which is not an inventory root).
      // Treating the live office itself as the root makes both forms usable by
      // the same Add ancestry guard without admitting arbitrary planet IDs.
      if (this._getPlanetaryCustomsOfficeRecord(currentID)) {
        return {
          success: true,
          rootLocationID: currentID,
          chain,
        };
      }

      const item = findItemById(currentID);
      if (!item) {
        return this._isKnownInventoryAncestorRoot(session, currentID)
          ? {
              success: true,
              rootLocationID: currentID,
              chain,
            }
          : {
              success: false,
              errorMsg: "INVENTORY_ANCESTOR_NOT_FOUND",
              containerID: currentID,
              chain,
            };
      }
      chain.push(item);

      const parentID = this._normalizeInventoryId(item.locationID, 0);
      if (parentID <= 0) {
        return {
          success: false,
          errorMsg: "INVENTORY_ANCESTOR_NOT_FOUND",
          containerID: parentID,
          chain,
        };
      }
      currentID = parentID;
    }

    return {
      success: false,
      errorMsg: "INVENTORY_ANCESTOR_CYCLE",
      containerID: currentID,
      chain,
    };
  }

  _validateDeployableCargoTransferAncestorAccess(
    session,
    sourceItem,
    destination,
    getAccessError,
  ) {
    const sourceContainerID = this._normalizeInventoryId(
      sourceItem && sourceItem.locationID,
      0,
    );
    const destinationContainerID = this._normalizeInventoryId(
      destination && destination.locationID,
      0,
    );
    // The side says whether the refused container is being taken from or put
    // into, which is the difference between the client's two messages.
    for (const [side, startLocationID] of [
      ["source", sourceContainerID],
      ["destination", destinationContainerID],
    ]) {
      const ancestry = this._resolveInventoryTransferAncestorChain(
        session,
        startLocationID,
      );
      if (!ancestry.success) {
        return ancestry;
      }
      for (const ancestor of ancestry.chain) {
        const containerID = this._normalizeInventoryId(
          ancestor && ancestor.itemID,
          0,
        );
        const accessError = getAccessError(containerID);
        if (accessError) {
          return {
            success: false,
            errorMsg: accessError,
            containerID,
            side,
          };
        }
      }
    }
    return { success: true };
  }

  _validateMobileDepotCargoTransferAccess(session, sourceItem, destination) {
    return this._validateDeployableCargoTransferAncestorAccess(
      session,
      sourceItem,
      destination,
      (containerID) => this._getMobileDepotCargoAccessError(
        session,
        containerID,
      ),
    );
  }

  _validateMobileTractorUnitCargoTransferAccess(
    session,
    sourceItem,
    destination,
  ) {
    return this._validateDeployableCargoTransferAncestorAccess(
      session,
      sourceItem,
      destination,
      (containerID) => this._getMobileTractorUnitCargoAccessError(
        session,
        containerID,
      ),
    );
  }

  _getShipServiceAccessError(session, shipID, flagID) {
    const numericFlagID = this._normalizeInventoryId(flagID, 0);
    if (!isShipServiceFlag(numericFlagID)) {
      return null;
    }

    const shipRecord =
      findShipItemById(this._normalizeInventoryId(shipID, 0)) ||
      findItemById(this._normalizeInventoryId(shipID, 0));
    if (!shipRecord || Number(shipRecord.categoryID) !== 6) {
      return null;
    }

    const accessResult = validateShipServiceAccess(
      session,
      shipRecord,
      numericFlagID,
    );
    return accessResult && accessResult.success
      ? null
      : accessResult.errorMsg || "SHIP_SERVICE_ACCESS_DENIED";
  }

  _validateShipServiceTransferAccess(session, sourceItem, destination) {
    const sourceLocationID = this._normalizeInventoryId(
      sourceItem && sourceItem.locationID,
      0,
    );
    const sourceFlagID = this._normalizeInventoryId(
      sourceItem && sourceItem.flagID,
      0,
    );
    const sourceAccessError = this._getShipServiceAccessError(
      session,
      sourceLocationID,
      sourceFlagID,
    );
    if (sourceAccessError) {
      return {
        success: false,
        errorMsg: sourceAccessError,
        shipID: sourceLocationID,
      };
    }

    const destinationLocationID = this._normalizeInventoryId(
      destination && destination.locationID,
      0,
    );
    const destinationFlagID = this._normalizeInventoryId(
      destination && destination.flagID,
      0,
    );
    const destinationAccessError = this._getShipServiceAccessError(
      session,
      destinationLocationID,
      destinationFlagID,
    );
    if (destinationAccessError) {
      return {
        success: false,
        errorMsg: destinationAccessError,
        shipID: destinationLocationID,
      };
    }

    return { success: true };
  }

  _throwShipServiceAccessError(errorMsg) {
    const notifyByError = {
      SHIP_SERVICE_ACCESS_DENIED:
        "You do not have access to this ship service bay.",
    };

    throwWrappedUserError("CustomNotify", {
      notify:
        notifyByError[errorMsg] ||
        "Unable to access this ship service bay.",
    });
  }

  // TargetTooFar is the module-activation message ("... too far away to use
  // your {module} on"), so a cargo refusal sent with it reached the client as
  // raw template text. These are the client's container messages; a take is
  // the default because FitFitting only ever takes.
  _throwMobileDepotCargoAccessError(errorMsg, side = "source") {
    if (errorMsg === "TARGET_TOO_FAR") {
      throwWrappedUserError(
        side === "destination" ? "NotCloseEnoughToAdd" : "NotCloseEnoughToLoot",
        { maxdist: MOBILE_DEPOT_CARGO_ACCESS_RANGE_METERS },
      );
    }

    const notifyByError = {
      INVALID_SESSION: "You must be in space in your active ship to access this Mobile Depot.",
      ITEM_NOT_FOUND: "Unable to find this Mobile Depot.",
      MOBILE_DEPOT_STATE_NOT_FOUND: "This Mobile Depot is not deployed.",
      MOBILE_DEPOT_NOT_IN_SPACE: "This Mobile Depot is not deployed in space.",
      MOBILE_DEPOT_NOT_OWNER: "Only the owner can access this Mobile Depot.",
      MOBILE_DEPOT_NOT_ACTIVE: "This Mobile Depot is still activating.",
    };

    throwWrappedUserError("CustomNotify", {
      notify: notifyByError[errorMsg] || "Unable to access this Mobile Depot.",
    });
  }

  _throwMobileTractorUnitCargoAccessError(errorMsg, side = "source") {
    if (errorMsg === "TARGET_TOO_FAR") {
      throwWrappedUserError(
        side === "destination" ? "NotCloseEnoughToAdd" : "NotCloseEnoughToLoot",
        { maxdist: MOBILE_TRACTOR_UNIT_SCOOP_RANGE_METERS },
      );
    }

    const notifyByError = {
      INVALID_SESSION:
        "You must be in space in your active ship to access this Mobile Tractor Unit.",
      ITEM_NOT_FOUND: "Unable to find this Mobile Tractor Unit.",
      MOBILE_TRACTOR_UNIT_STATE_NOT_FOUND:
        "This Mobile Tractor Unit is not deployed.",
      MOBILE_TRACTOR_UNIT_NOT_IN_SPACE:
        "This Mobile Tractor Unit is not deployed in space.",
      MOBILE_TRACTOR_UNIT_NOT_OWNER:
        "Only the owner can access this Mobile Tractor Unit.",
    };

    throwWrappedUserError("CustomNotify", {
      notify:
        notifyByError[errorMsg] ||
        "Unable to access this Mobile Tractor Unit.",
    });
  }

  _throwSpaceContainerScopeAccessError(errorMsg = "", action = "loot") {
    if (errorMsg === "CONTAINER_NOT_HACKED") {
      throwWrappedUserError("CustomNotify", {
        notify: "Hack this container successfully before accessing its contents.",
      });
    }
    const processingMessage = starbaseProcessingInventory.getProcessingErrorMessage(errorMsg);
    if (processingMessage) throwWrappedUserError("CustomNotify", { notify: processingMessage });
    const maintenanceErrors = {
      STARBASE_INVENTORY_OFFLINE: "The starbase array must be anchored and online before it can be accessed.",
      STARBASE_INVENTORY_TOWER_UNAVAILABLE: "This starbase array requires its anchored control tower to be online.",
      STARBASE_INVENTORY_TOO_FAR: "Move within this starbase array's operational range, or inside its control tower's shield, to access it.",
      STARBASE_MAINTENANCE_ACCESS_DENIED: "Your corporation's starbase inventory permissions do not allow this operation.",
      STARBASE_MAINTENANCE_ASSEMBLED_SHIP_REQUIRED: "Only assembled ships other than capsules can be placed in a Ship Maintenance Array.",
      STARBASE_MAINTENANCE_USE_STORE_VESSEL: "Use Store Vessel to place your current ship into the Ship Maintenance Array.",
      STARBASE_BATTERY_INCOMPATIBLE_CHARGE: "Only compatible ammunition can be placed in this battery's ammunition bay.",
      STARBASE_BATTERY_MIXED_CHARGES: "Unload the current ammunition before loading a different ammunition type.",
      STARBASE_BATTERY_SINGLE_ACTIVE_CRYSTAL: "A laser battery can have only one active crystal. Put spare crystals in Crystal Storage.",
      STARBASE_BATTERY_AMMO_CAPACITY: "There is not enough space in this battery's ammunition bay.",
      CONTROL_TOWER_REINFORCED: "The control tower is reinforced. Its fuel and Strontium bays cannot be changed until reinforcement ends.",
      CONTROL_TOWER_STRONTIUM_SHIELD_TOO_LOW: "The control tower's shields must be at least 50% before Strontium can be added or removed.",
      CONTROL_TOWER_INVALID_BAY_ITEM: "Only Strontium Clathrates may be placed in the Strontium bay; Strontium cannot be placed in the fuel bay.",
      CONTROL_TOWER_BAY_ACCESS_DENIED: "Your corporation roles and starbase access settings do not permit access to this control tower's bay.",
      CONTROL_TOWER_BAY_CAPACITY: "There is not enough space in this control tower bay.",
    };
    if (maintenanceErrors[errorMsg]) throwWrappedUserError("CustomNotify", { notify: maintenanceErrors[errorMsg] });
    // "Too far away" and "no such item" are different answers, and only one of
    // them tells a player what to do. Everything else stays FakeItemNotFound,
    // which is the right answer for a container the session should not be able
    // to see at all.
    // TargetTooFar is the module-activation message ("... too far away to use
    // your {module} on"), so a container refusal sent with it reached the
    // client as raw template text. These are the client's container messages.
    if (["CONTAINER_TOO_FAR", "CUSTOMS_OFFICE_TOO_FAR"].includes(String(errorMsg || "").trim())) {
      const messageByAction = {
        open: "NotCloseEnoughToOpen",
        add: "NotCloseEnoughToAdd",
      };
      throwWrappedUserError(
        messageByAction[action] || "NotCloseEnoughToLoot",
        { maxdist: Number(MAX_CARGO_CONTAINER_TRANSFER_DISTANCE_METERS || 2_500) },
      );
    }
    const customsErrors = {
      CUSTOMS_OFFICE_DOCKED: "Undock before moving goods through a Customs Office.",
      CUSTOMS_OFFICE_NOT_IN_SYSTEM: "You must be in the same solar system as the Customs Office.",
      CUSTOMS_OFFICE_CLOAKED: "You cannot move goods through a Customs Office while cloaked.",
      CUSTOMS_OFFICE_NOT_AVAILABLE: "This Customs Office is not available in your current space scene.",
    };
    if (customsErrors[errorMsg]) throwWrappedUserError("CustomNotify", { notify: customsErrors[errorMsg] });
    if (String(errorMsg || "").trim() === "STARBASE_CORPORATE_HANGAR_TOO_FAR") {
      throwWrappedUserError("CustomNotify", {
        notify:
          "Move within this Corporate Hangar Array's operational range, or inside its control tower's shield, to access it.",
      });
    }
    if (String(errorMsg || "").trim() === "STARBASE_CORPORATE_HANGAR_OFFLINE") {
      throwWrappedUserError("CustomNotify", {
        notify:
          "The Corporate Hangar Array must be anchored and online before it can be accessed.",
      });
    }
    if (String(errorMsg || "").trim() === "STARBASE_CORPORATE_HANGAR_TOWER_UNAVAILABLE") {
      throwWrappedUserError("CustomNotify", {
        notify: "This Corporate Hangar Array requires its anchored control tower to be online before it can be accessed.",
      });
    }
    throwWrappedUserError("FakeItemNotFound");
  }

  _isActiveShipCloaked(session, shipID = 0) {
    const numericShipID = this._normalizeInventoryId(
      shipID || (session && session._space && session._space.shipID) || this._getShipId(session),
      0,
    );
    if (!session || !session._space || numericShipID <= 0) {
      return false;
    }

    const entity = runtime.getEntity(session, numericShipID);
    if (!entity) {
      return false;
    }

    return (
      entity.cloaked === true ||
      this._normalizeInventoryId(entity.cloakMode, 0) > 0 ||
      this._normalizeInventoryId(entity.isCloaked, 0) > 0 ||
      this._normalizeInventoryId(entity.cloakState, 0) > 0
    );
  }

  _isInSpaceRefitMove(session, shipRecord, item, destination) {
    if (
      !session ||
      isDockedSession(session) ||
      !shipRecord ||
      !item ||
      this._normalizeInventoryId(item.categoryID, 0) === CHARGE_CATEGORY_ID
    ) {
      return false;
    }

    const activeShipID = this._normalizeInventoryId(
      (session._space && session._space.shipID) ||
        session.activeShipID ||
        session.shipID ||
        session.shipid ||
        this._getShipId(session),
      0,
    );
    const shipID = this._normalizeInventoryId(shipRecord.itemID, 0);
    if (activeShipID <= 0 || shipID <= 0 || activeShipID !== shipID) {
      return false;
    }

    const sourceIsFitted = (
      this._normalizeInventoryId(item.locationID, 0) === shipID &&
      isShipFittingFlag(item.flagID)
    );
    const destinationIsFitted = (
      destination &&
      this._normalizeInventoryId(destination.locationID, 0) === shipID &&
      isShipFittingFlag(destination.flagID)
    );

    return sourceIsFitted || destinationIsFitted;
  }

  _getMobileDepotFittingServiceAccess(session, candidateItems = null) {
    const systemID = this._normalizeInventoryId(
      session && session._space && session._space.systemID,
      this._normalizeInventoryId(
        session && (session.solarsystemid2 || session.solarsystemid),
        0,
      ),
    );
    if (systemID <= 0) {
      return {
        success: false,
        errorMsg: "INVALID_SESSION",
      };
    }

    const depots = (
      Array.isArray(candidateItems)
        ? candidateItems
        : listContainerItems(null, systemID, 0)
    )
      .filter((item) => isMobileDepotItemRecord(item))
      .sort((left, right) => (
        this._normalizeInventoryId(left && left.itemID, 0) -
        this._normalizeInventoryId(right && right.itemID, 0)
      ));
    let bestError = depots.length > 0
      ? "MOBILE_DEPOT_FITTING_SERVICE_NOT_AVAILABLE"
      : "MOBILE_DEPOT_FITTING_SERVICE_NOT_FOUND";
    let tooFar = null;
    for (const depot of depots) {
      const accessResult = validateMobileDepotFittingAccess(session, depot);
      if (accessResult && accessResult.success) {
        return accessResult;
      }

      const errorMsg =
        accessResult && accessResult.errorMsg
          ? accessResult.errorMsg
          : "MOBILE_DEPOT_FITTING_SERVICE_NOT_AVAILABLE";
      if (errorMsg === "TARGET_TOO_FAR") {
        tooFar = this._getNearerTooFarFittingProvider(
          session,
          depot,
          MOBILE_DEPOT_FITTING_RANGE_METERS,
          tooFar,
        );
      }
      if (
        (IN_SPACE_FITTING_ACCESS_ERROR_PRIORITY[errorMsg] || 0) >
        (IN_SPACE_FITTING_ACCESS_ERROR_PRIORITY[bestError] || 0)
      ) {
        bestError = errorMsg;
      }
    }

    return {
      success: false,
      errorMsg: bestError,
      tooFar: bestError === "TARGET_TOO_FAR" ? tooFar : null,
    };
  }

  // The provider a refit was refused for range by, as the client's
  // CantUseTooDistantWithType wants it: its type, its range, and how far the
  // ship's hull is from its hull. Of several, the one the ship is nearest to
  // reaching. A provider without a ball in the session's scene cannot be
  // measured and is skipped.
  _getNearerTooFarFittingProvider(session, provider, desired, nearest = null) {
    const actual = this._getActiveShipSurfaceDistance(
      session,
      provider && provider.itemID,
    );
    if (
      actual === null ||
      (nearest && nearest.actual - nearest.desired <= actual - desired)
    ) {
      return nearest;
    }
    return {
      typeID: this._normalizeInventoryId(provider.typeID, 0),
      desired,
      actual,
    };
  }

  _getActiveShipSurfaceDistance(session, targetID) {
    const shipID = this._normalizeInventoryId(
      session && session._space && session._space.shipID,
      0,
    );
    const numericTargetID = this._normalizeInventoryId(targetID, 0);
    const scene = shipID > 0 && numericTargetID > 0
      ? runtime.getSceneForSession(session)
      : null;
    const shipEntity = scene ? runtime.getEntity(session, shipID) : null;
    const targetEntity = scene ? runtime.getEntity(session, numericTargetID) : null;
    if (!shipEntity || !targetEntity) {
      return null;
    }
    const surfaceDistance =
      typeof scene.getEntitySurfaceDistance === "function"
        ? scene.getEntitySurfaceDistance(shipEntity, targetEntity)
        : Math.max(
          0,
          Math.hypot(
            Number(shipEntity.position && shipEntity.position.x) -
              Number(targetEntity.position && targetEntity.position.x),
            Number(shipEntity.position && shipEntity.position.y) -
              Number(targetEntity.position && targetEntity.position.y),
            Number(shipEntity.position && shipEntity.position.z) -
              Number(targetEntity.position && targetEntity.position.z),
          ) -
            Math.max(0, Number(shipEntity.radius) || 0) -
            Math.max(0, Number(targetEntity.radius) || 0),
        );
    return Number.isFinite(surfaceDistance) ? surfaceDistance : null;
  }

  _getMaintenanceFittingServiceAccess(session, candidateItems = []) {
    const candidates = [];
    const seenItemIDs = new Set();
    for (const item of candidateItems) {
      const itemID = this._normalizeInventoryId(item && item.itemID, 0);
      if (
        itemID <= 0 ||
        seenItemIDs.has(itemID) ||
        (!isShipMaintenanceBaySource(item) && !isShipMaintenanceArraySource(item))
      ) {
        continue;
      }
      seenItemIDs.add(itemID);
      candidates.push(item);
    }
    candidates.sort((left, right) => (
      this._normalizeInventoryId(left && left.itemID, 0) -
      this._normalizeInventoryId(right && right.itemID, 0)
    ));

    if (candidates.length === 0) {
      return {
        success: false,
        errorMsg: "IN_SPACE_FITTING_SERVICE_NOT_FOUND",
        providerFound: false,
      };
    }

    let bestError = "IN_SPACE_FITTING_SERVICE_NOT_AVAILABLE";
    let tooFar = null;
    for (const candidate of candidates) {
      const accessResult = validateMaintenanceFittingServiceAccess(
        session,
        candidate,
      );
      if (accessResult && accessResult.success) {
        return {
          ...accessResult,
          providerFound: true,
        };
      }
      log.debug(
        `[InvBroker] In-space fitting provider rejected caller=${this._normalizeInventoryId(session && (session.characterID ?? session.charid), 0)} ` +
          `itemID=${this._normalizeInventoryId(candidate.itemID, 0)} ` +
          `typeID=${this._normalizeInventoryId(candidate.typeID, 0)} ` +
          `ownerID=${this._normalizeInventoryId(candidate.ownerID, 0)} ` +
          `provider=${isShipMaintenanceBaySource(candidate) ? "ship-maintenance-bay" : "pos-maintenance-array"} ` +
          `error=${accessResult && accessResult.errorMsg ? accessResult.errorMsg : "UNKNOWN_ERROR"}`,
      );
      if (
        accessResult &&
        accessResult.errorMsg === "SOURCE_MAINTENANCE_CONTAINER_TOO_FAR"
      ) {
        bestError = "TARGET_TOO_FAR";
        tooFar = this._getNearerTooFarFittingProvider(
          session,
          candidate,
          SHIP_FITTING_SERVICE_RANGE_METERS,
          tooFar,
        );
      } else if (
        accessResult &&
        accessResult.errorMsg === "POS_MAINTENANCE_ARRAY_ACCESS_DENIED" &&
        this._normalizeInventoryId(candidate.ownerID, 0) ===
          this._normalizeInventoryId(this._getCorporationId(session), 0)
      ) {
        // A nearby array whose configured Use permission rejects the caller is
        // more relevant than an unrelated maintenance-bay ship being distant.
        bestError = "POS_MAINTENANCE_ARRAY_ACCESS_DENIED";
      }
    }

    return {
      success: false,
      errorMsg: bestError,
      providerFound: true,
      tooFar: bestError === "TARGET_TOO_FAR" ? tooFar : null,
    };
  }

  _getShipMaintenanceBayFittingServiceAccess(session, shipRecord) {
    const candidates = [];
    if (isShipMaintenanceBaySource(shipRecord)) {
      candidates.push(shipRecord);
    }

    const scene = runtime.getSceneForSession(session);
    const entities = scene && typeof scene.getDynamicEntities === "function"
      ? scene.getDynamicEntities()
      : [];
    for (const entity of entities) {
      if (
        !entity ||
        (entity.kind !== "ship" &&
          this._normalizeInventoryId(entity.categoryID, 0) !== SHIP_CATEGORY_ID)
      ) {
        continue;
      }
      const candidate = findShipItemById(entity.itemID);
      if (isShipMaintenanceBaySource(candidate)) {
        candidates.push(candidate);
      }
    }

    return this._getMaintenanceFittingServiceAccess(session, candidates);
  }

  _getInSpaceFittingServiceAccess(session, shipRecord) {
    const systemID = this._normalizeInventoryId(
      session && session._space && session._space.systemID,
      this._normalizeInventoryId(
        session && (session.solarsystemid2 || session.solarsystemid),
        0,
      ),
    );
    if (systemID <= 0) {
      return {
        success: false,
        errorMsg: "INVALID_SESSION",
      };
    }

    // Most fleet refits are provided by a nearby maintenance-bay ship. Check
    // the exact session scene first so that success does not clone every
    // top-level inventory row in the solar system on each fitted item move.
    const shipAccess = this._getShipMaintenanceBayFittingServiceAccess(
      session,
      shipRecord,
    );
    if (shipAccess.success) {
      return shipAccess;
    }

    const systemItems = listContainerItems(null, systemID, 0);
    const posAccess = this._getMaintenanceFittingServiceAccess(
      session,
      systemItems.filter((item) => isShipMaintenanceArraySource(item)),
    );
    if (posAccess.success) {
      return posAccess;
    }

    const depots = systemItems.filter((item) => isMobileDepotItemRecord(item));
    const depotAccess = this._getMobileDepotFittingServiceAccess(session, depots);
    if (depotAccess.success) {
      return depotAccess;
    }

    const failedProviderAccess = [];
    if (depots.length > 0) {
      failedProviderAccess.push(depotAccess);
    }
    if (shipAccess.providerFound) {
      failedProviderAccess.push(shipAccess);
    }
    if (posAccess.providerFound) {
      failedProviderAccess.push(posAccess);
    }
    if (failedProviderAccess.length > 0) {
      return failedProviderAccess.reduce((bestAccess, access) => {
        const bestPriority = IN_SPACE_FITTING_ACCESS_ERROR_PRIORITY[
          bestAccess && bestAccess.errorMsg
        ] || 0;
        const accessPriority = IN_SPACE_FITTING_ACCESS_ERROR_PRIORITY[
          access && access.errorMsg
        ] || 0;
        return accessPriority > bestPriority ? access : bestAccess;
      });
    }

    return {
      success: false,
      errorMsg: "IN_SPACE_FITTING_SERVICE_NOT_FOUND",
    };
  }

  _validateInSpaceFittingServiceAccess(session, shipRecord, item, destination) {
    if (!this._isInSpaceRefitMove(session, shipRecord, item, destination)) {
      return { success: true };
    }

    if (this._isActiveShipCloaked(session, shipRecord.itemID)) {
      return {
        success: false,
        errorMsg: "IN_SPACE_FITTING_SERVICE_CLOAKED",
      };
    }

    return this._getInSpaceFittingServiceAccess(session, shipRecord);
  }

  _isDockedStructureRefitMove(session, shipRecord, item, destination) {
    if (
      !session ||
      !isDockedSession(session) ||
      !shipRecord ||
      !item ||
      this._normalizeInventoryId(item.categoryID, 0) === CHARGE_CATEGORY_ID
    ) {
      return false;
    }

    const structureID = this._normalizeInventoryId(
      session.structureID || session.structureid,
      0,
    );
    if (structureID <= 0) {
      return false;
    }

    const shipID = this._normalizeInventoryId(shipRecord.itemID, 0);
    if (shipID <= 0 || this._normalizeInventoryId(shipRecord.categoryID, 0) !== 6) {
      return false;
    }

    const sourceIsFitted = (
      this._normalizeInventoryId(item.locationID, 0) === shipID &&
      isShipFittingFlag(item.flagID)
    );
    const destinationIsFitted = (
      destination &&
      this._normalizeInventoryId(destination.locationID, 0) === shipID &&
      isShipFittingFlag(destination.flagID)
    );

    return sourceIsFitted || destinationIsFitted;
  }

  _validateDockedStructureFittingServiceAccess(session, shipRecord, item, destination) {
    if (!this._isDockedStructureRefitMove(session, shipRecord, item, destination)) {
      return { success: true };
    }

    const structureID = this._normalizeInventoryId(
      session.structureID || session.structureid,
      0,
    );
    const structure = this._getStructureForInventoryID(structureID);
    if (characterHasStructureService(session, structure, STRUCTURE_SERVICE_ID.FITTING)) {
      return { success: true };
    }

    return {
      success: false,
      errorMsg: "StructureDockingDenied",
      structureID,
    };
  }

  _throwDockedStructureFittingAccessError(errorMsg) {
    throwWrappedUserError(errorMsg || "StructureDockingDenied");
  }

  // TargetTooFar is the module-activation message, and sent without a module
  // and a distance the client printed its raw template. A refusal that knows
  // which provider was out of range names it, its range and the distance;
  // one that measured nothing can only say the ship is too far.
  _throwInSpaceFittingAccessError(errorMsg, tooFar = null) {
    if (errorMsg === "TARGET_TOO_FAR") {
      if (tooFar) {
        throwWrappedUserError("CantUseTooDistantWithType", {
          desired: tooFar.desired,
          actual: Math.round(tooFar.actual),
          typeID: tooFar.typeID,
        });
      }
      throwWrappedUserError("GenericTooFarAway");
    }

    const notifyByError = {
      INVALID_SESSION: "You must be in space in your active ship to use a fitting service.",
      MOBILE_DEPOT_NOT_ACTIVE: "This Mobile Depot is still activating.",
      MOBILE_DEPOT_REINFORCED: "This Mobile Depot is reinforced and cannot provide fitting service.",
      POS_MAINTENANCE_ARRAY_ACCESS_DENIED:
        "Your corporation roles or this Ship Maintenance Array's Use setting do not permit this operation.",
      IN_SPACE_FITTING_SERVICE_CLOAKED: "You cannot refit in space while cloaked.",
      IN_SPACE_FITTING_SERVICE_NOT_FOUND:
        `You must be within ${MOBILE_DEPOT_FITTING_RANGE_METERS} meters of an active Mobile Depot you own, or within ${SHIP_FITTING_SERVICE_RANGE_METERS} meters of an accessible maintenance-bay ship or array, to refit in space.`,
      IN_SPACE_FITTING_SERVICE_NOT_AVAILABLE:
        "No accessible in-space fitting service is currently available.",
      MOBILE_DEPOT_FITTING_SERVICE_NOT_FOUND:
        `You must be within ${MOBILE_DEPOT_FITTING_RANGE_METERS} meters of an active Mobile Depot you own to refit in space.`,
      MOBILE_DEPOT_FITTING_SERVICE_NOT_AVAILABLE:
        `You must be within ${MOBILE_DEPOT_FITTING_RANGE_METERS} meters of an active Mobile Depot you own to refit in space.`,
    };

    throwWrappedUserError("CustomNotify", {
      notify:
        notifyByError[errorMsg] ||
        "Unable to access an in-space fitting service.",
    });
  }

  _getItemMoveVolume(item, quantity) {
    const numericQuantity = Math.max(1, Number(quantity) || 0);
    const unitVolume = Math.max(0, getInventoryItemUnitVolume(item));
    return unitVolume * numericQuantity;
  }

  // A fitted module or rig that enlarges the cargo hold may not be unfitted or
  // destroyed while the hold carries more than the ship would be left with.
  // Returns the numbers when the change must be refused, otherwise null.
  // addedCargoVolume is cargo the same change puts in the hold, such as the
  // module itself when it is unfitted to cargo. A caller that already holds the
  // ship's fitting from before the change passes it as fittingSnapshot.
  _getCargoOverflowWithoutFittedItems(
    session,
    shipRecord,
    leavingItems,
    addedCargoVolume = 0,
    fittingSnapshot = null,
  ) {
    const shipID = this._normalizeInventoryId(shipRecord && shipRecord.itemID, 0);
    const leavingItemIDs = (Array.isArray(leavingItems) ? leavingItems : [])
      .filter((item) => (
        item &&
        this._normalizeInventoryId(item.locationID, 0) === shipID &&
        isShipFittingFlag(item.flagID) &&
        this._normalizeInventoryId(item.categoryID, 0) !== CHARGE_CATEGORY_ID
      ))
      .map((item) => this._normalizeInventoryId(item.itemID, 0));
    if (shipID <= 0 || leavingItemIDs.length === 0) {
      return null;
    }
    return getCargoOverflowWithoutItems(
      fittingSnapshot ||
        getShipFittingSnapshot(
          this._resolveShipDogmaCharacterID(session, shipRecord),
          shipID,
          {
            shipItem: shipRecord,
            reason: "invbroker.unfit-capacity",
          },
        ),
      leavingItemIDs,
      addedCargoVolume,
    );
  }

  // The same question for one item moved out of a fitting slot.
  _getUnfitCargoOverflow(session, item, destination) {
    if (!item || !isShipFittingFlag(item.flagID)) {
      return null;
    }
    const shipRecord = findShipItemById(
      this._normalizeInventoryId(item.locationID, 0),
    );
    if (!shipRecord) {
      return null;
    }
    const staysOnShip =
      this._normalizeInventoryId(destination && destination.locationID, 0) ===
      this._normalizeInventoryId(shipRecord.itemID, 0);
    if (staysOnShip && isShipFittingFlag(destination.flagID)) {
      // A move between slots keeps the item fitted.
      return null;
    }
    const goesToCargo =
      staysOnShip &&
      this._normalizeInventoryId(destination.flagID, 0) === ITEM_FLAGS.CARGO_HOLD;
    return this._getCargoOverflowWithoutFittedItems(
      session,
      shipRecord,
      [item],
      goesToCargo ? this._getItemMoveVolume(item, 1) : 0,
    );
  }

  // The retail key for this refusal is unverified, so it is a plain notify and
  // never the capacity-retry key, which makes the client ask for a quantity.
  _throwUnfitCargoOverflowUserError(overflow) {
    const cubicMetres = (value) => Number((Number(value) || 0).toFixed(2));
    throwWrappedUserError("CustomNotify", {
      notify:
        "That cannot be removed while the cargo hold is this full. The hold " +
        `carries ${cubicMetres(overflow && overflow.used)} m3 and the ship ` +
        `would be left with room for ${cubicMetres(overflow && overflow.capacityAfter)} m3. ` +
        "Move some cargo out first.",
    });
  }

  // additionalRequiredVolume is space already promised to earlier stacks of
  // the same batch that have not moved yet.
  _checkCapacityForMove(
    session,
    boundContext,
    destination,
    item,
    requestedQuantity = null,
    additionalRequiredVolume = 0,
  ) {
    // Every use below is a starbase check, so ordinary destinations skip the copy.
    const destinationRecord = destination && findStarbaseItemById(destination.locationID);
    // Dispatch by the persisted destination, before generic capacity shortcuts:
    // specialized bays must reject invalid deposits even when capacity is zero.
    let deposit;
    if (starbaseInventoryRuntime.isTowerBay(destinationRecord)) {
      deposit = starbaseInventoryRuntime.validateTowerBayDeposit(item, destination, requestedQuantity);
    } else if (starbaseInventoryRuntime.isBatteryAmmoInventory(destinationRecord)) {
      deposit = starbaseInventoryRuntime.validateBatteryAmmoDeposit(item, destination, requestedQuantity);
    } else if (starbaseProcessingInventory.isProcessingStorage(destinationRecord)) {
      deposit = starbaseProcessingInventory.validateProcessingDeposit(item, destination, requestedQuantity);
    }
    if (deposit && !deposit.success) this._throwSpaceContainerScopeAccessError(deposit.errorMsg);
    if (
      !item ||
      !boundContext ||
      !destination ||
      !this._destinationUsesCapacity(boundContext, destination, destinationRecord)
    ) {
      return { success: true };
    }

    const currentLocationID = this._normalizeInventoryId(item.locationID, 0);
    const currentFlagID = this._normalizeInventoryId(item.flagID, 0);
    if (isStarbaseCorporateHangarArrayType(destinationRecord) &&
        currentLocationID === this._normalizeInventoryId(destination.locationID, 0)) {
      // Moving between divisions does not consume any more shared array space.
      return { success: true };
    }
    if (
      currentLocationID === this._normalizeInventoryId(destination.locationID, 0) &&
      currentFlagID === this._normalizeInventoryId(destination.flagID, 0)
    ) {
      return { success: true };
    }

    const availableQuantity =
      Number(item.singleton) === 1
        ? 1
        : Math.max(1, Number(item.stacksize ?? item.quantity ?? 1) || 1);
    const resolvedQuantity = this._resolveMoveQuantity(
      item,
      destination,
      requestedQuantity,
    );
    const rescueDestination = getRescueDestination(session, findItemById(destination.locationID));
    const moveQuantity = limitRescueCargoQuantity(rescueDestination, item,
      resolvedQuantity === null || resolvedQuantity === undefined
        ? availableQuantity
        : Math.max(1, Number(resolvedQuantity) || 1));
    const requiredVolume =
      (moveQuantity > 0 ? this._getItemMoveVolume(item, moveQuantity) : 0) +
      Math.max(0, Number(additionalRequiredVolume) || 0);
    if (requiredVolume <= 0) {
      return { success: true };
    }

    const capacityInfo = this._calculateCapacity(
      session,
      boundContext,
      destination.flagID,
    );
    const capacity = Number(
      capacityInfo &&
      capacityInfo.args &&
      capacityInfo.args.type === "dict" &&
      Array.isArray(capacityInfo.args.entries)
        ? (
            capacityInfo.args.entries.find(([key]) => key === "capacity") || []
          )[1]
        : 0,
    ) || 0;
    const used = Number(
      capacityInfo &&
      capacityInfo.args &&
      capacityInfo.args.type === "dict" &&
      Array.isArray(capacityInfo.args.entries)
        ? (
            capacityInfo.args.entries.find(([key]) => key === "used") || []
          )[1]
        : 0,
    ) || 0;
    const free = Math.max(0, capacity - used);

    if (requiredVolume <= free + 1e-7) {
      return { success: true };
    }

    return {
      success: false,
      errorMsg: this._getMoveCapacityError(boundContext, destination, item),
      free,
      requiredVolume,
    };
  }

  _isSpaceLootMultiAddSource(session, sourceLocationID) {
    const numericSourceLocationID = this._normalizeInventoryId(
      sourceLocationID,
      0,
    );
    if (numericSourceLocationID <= 0) {
      return false;
    }

    if (this._getNativeWreckRecord(numericSourceLocationID)) {
      return true;
    }

    const sourceContainer = findItemById(numericSourceLocationID);
    if (!sourceContainer) {
      return false;
    }

    return Boolean(
      this._isMobileTractorUnitInventoryItem(sourceContainer) ||
        isDisposableJetcanRecord(sourceContainer) ||
        this._isLootContainerEntity(session, numericSourceLocationID),
    );
  }

  _preflightSpaceLootMultiAddCapacity(
    session,
    boundContext,
    itemIDs,
    sourceLocationID,
    requestedFlag,
    explicitFlagProvided,
    requestedQuantity,
    fittedItemsSnapshot = null,
  ) {
    if (
      !this._isSpaceLootMultiAddSource(session, sourceLocationID) ||
      !Array.isArray(itemIDs) ||
      itemIDs.length <= 0
    ) {
      return { handled: false, success: true };
    }

    const activeShipID = this._normalizeInventoryId(this._getShipId(session), 0);
    if (activeShipID <= 0) {
      return { handled: false, success: true };
    }

    let requiredVolume = 0;
    let representativeItem = null;

    for (const itemID of itemIDs) {
      const sourceItemDescriptor = this._findTransferSourceItem(
        itemID,
        sourceLocationID,
      );
      const item =
        sourceItemDescriptor && sourceItemDescriptor.item
          ? sourceItemDescriptor.item
          : null;
      if (!item || !sourceItemDescriptor) {
        // Loot windows can legitimately submit a row that another transfer has
        // already consumed.  Missing identities contribute no volume; let the
        // main MultiAdd loop record the skip while still moving and publishing
        // every authoritative row that remains.  Location mismatches below stay
        // batch-fatal so a mixed-source request cannot move partially.
        continue;
      }
      if (
        !this._isTransferSourceLocationMatch(
          sourceItemDescriptor,
          sourceLocationID,
        )
      ) {
        return {
          handled: true,
          success: false,
          errorMsg: "SOURCE_LOCATION_MISMATCH",
          item,
        };
      }

      const destination = this._resolveDestinationForMove(
        session,
        boundContext,
        item,
        requestedFlag,
        explicitFlagProvided,
        fittedItemsSnapshot,
      );
      if (
        !destination ||
        this._normalizeInventoryId(destination.locationID, 0) !==
          activeShipID ||
        this._normalizeInventoryId(destination.flagID, 0) !==
          ITEM_FLAGS.CARGO_HOLD
      ) {
        return { handled: false, success: true };
      }

      const currentLocationID = this._normalizeInventoryId(item.locationID, 0);
      const currentFlagID = this._normalizeInventoryId(item.flagID, 0);
      if (
        currentLocationID === activeShipID &&
        currentFlagID === ITEM_FLAGS.CARGO_HOLD
      ) {
        continue;
      }

      const appliedQuantity = this._resolveAppliedMoveQuantity(
        item,
        destination,
        requestedQuantity,
      );
      requiredVolume += this._getItemMoveVolume(item, appliedQuantity);
      representativeItem = representativeItem || item;
    }

    if (requiredVolume <= 0 || !representativeItem) {
      return { handled: true, success: true };
    }

    const capacityInfo = this._calculateCapacity(
      session,
      boundContext,
      ITEM_FLAGS.CARGO_HOLD,
    );
    const capacityEntries =
      capacityInfo &&
      capacityInfo.args &&
      capacityInfo.args.type === "dict" &&
      Array.isArray(capacityInfo.args.entries)
        ? capacityInfo.args.entries
        : [];
    const capacity =
      Number(
        (capacityEntries.find(([key]) => key === "capacity") || [])[1],
      ) || 0;
    const used =
      Number((capacityEntries.find(([key]) => key === "used") || [])[1]) || 0;
    const capacityCheck = evaluateCumulativeCapacity({
      capacity,
      used,
      requiredVolume,
    });

    if (capacityCheck.success) {
      return {
        handled: true,
        success: true,
        free: capacityCheck.free,
        requiredVolume: capacityCheck.requiredVolume,
        item: representativeItem,
      };
    }

    return {
      handled: true,
      success: false,
      errorMsg: "NotEnoughCargoSpace",
      free: capacityCheck.free,
      requiredVolume: capacityCheck.requiredVolume,
      item: representativeItem,
    };
  }

  _buildCapacityMoveUserErrorValues(capacityCheck, item) {
    const available = Number(
      Number(capacityCheck && capacityCheck.free || 0).toFixed(6),
    );
    const volume = Number(
      Number(capacityCheck && capacityCheck.requiredVolume || 0).toFixed(6),
    );
    if (String(capacityCheck && capacityCheck.errorMsg || "") === "NotEnoughCargoSpace") {
      return { available, volume };
    }
    return {
      type: Number(item && item.typeID) || 0,
      free: available,
      required: volume,
    };
  }

  _getShipInventoryRecord(session, boundContext) {
    const inventoryID = this._normalizeInventoryId(
      boundContext && boundContext.inventoryID,
      0,
    );
    if (inventoryID <= 0) {
      return null;
    }

    const charId = this._getCharacterId(session);
    return (
      findCharacterShip(charId, inventoryID) ||
      findShipItemById(inventoryID) ||
      null
    );
  }

  _resolveShipDogmaCharacterID(session, shipRecord) {
    const shipID = this._normalizeInventoryId(shipRecord && shipRecord.itemID, 0);
    const sessionCharacterID = this._getCharacterId(session);
    const sessionShipID = this._normalizeInventoryId(
      session && (
        (session._space && session._space.shipID) ||
        session.activeShipID ||
        session.shipID ||
        session.shipid
      ),
      0,
    );
    if (sessionCharacterID > 0 && sessionShipID === shipID) {
      return sessionCharacterID;
    }

    const spaceEntity =
      session && session._space && shipID > 0
        ? runtime.getEntity(session, shipID)
        : null;
    const activePilotCharacterID = this._normalizeInventoryId(
      spaceEntity && (spaceEntity.pilotCharacterID || spaceEntity.characterID),
      0,
    );
    if (activePilotCharacterID > 0) {
      return activePilotCharacterID;
    }

    const ownerID = this._normalizeInventoryId(shipRecord && shipRecord.ownerID, 0);
    if (ownerID > 0 && getCharacterRecord(ownerID)) {
      return ownerID;
    }
    // The hull is not the caller's active ship, has no in-space pilot, and its
    // owner is not a player character (a corporation, or an unresolved owner).
    // An unpiloted hull applies no pilot skills, so EVE derives its bays from
    // base ship attributes. Return the no-character sentinel 0, which makes
    // getShipFittingSnapshot resolve an empty skill map (no skills, no
    // implants) and therefore base attributes. Falling back to the requesting
    // session here would let every derived-capacity flag (cargo, drone, fuel,
    // fleet hangar, mining/special holds) vary by whoever happens to be looking.
    return 0;
  }

  _getStructureFitHostRecord(session, structureID) {
    const numericStructureID = this._normalizeInventoryId(structureID, 0);
    return numericStructureID > 0
      ? this._buildStructureItemOverrides(session, numericStructureID)
      : null;
  }

  _isStructureFitHostRecord(fitHostRecord) {
    return (
      this._normalizeInventoryId(fitHostRecord && fitHostRecord.categoryID, 0) ===
      STRUCTURE_CATEGORY_ID
    );
  }

  _listFittedItemsForFitHost(session, fitHostRecord) {
    if (!fitHostRecord) {
      return [];
    }
    const fitHostID = this._normalizeInventoryId(fitHostRecord.itemID, 0);
    return this._isStructureFitHostRecord(fitHostRecord)
      ? listFittedItemsForLocation(fitHostID)
      : listFittedItems(this._getCharacterId(session), fitHostID);
  }

  _isAutoFitRequested(explicitFlagValue, explicitFlagProvided) {
    if (!explicitFlagProvided) {
      return false;
    }

    const numericFlag = this._normalizeInventoryId(explicitFlagValue, 0);
    if (
      isShipFittingFlag(numericFlag) ||
      SHIP_BAY_FLAGS.has(numericFlag) ||
      this._isStructureOwnerBayFlag(numericFlag) ||
      this._isMoonMaterialBayFlag(numericFlag) ||
      numericFlag === ITEM_FLAGS.STRUCTURE_DEED
    ) {
      return false;
    }

    return true;
  }

  _diagnoseAutoFitFailure(fitHostRecord, item, fittedItems = []) {
    if (!fitHostRecord || !item) {
      return { success: false, errorMsg: "NO_SUITABLE_FIT_SLOT" };
    }

    const family = getRequiredSlotFamily(item.typeID);
    if (!family) {
      return { success: false, errorMsg: "TYPE_NOT_FITTABLE" };
    }

    const currentFittedItems = Array.isArray(fittedItems) ? fittedItems : [];
    const fitHostID = this._normalizeInventoryId(fitHostRecord.itemID, 0);
    const hardpointCounts = getShipHardpointCounts(
      fitHostRecord.typeID,
      currentFittedItems,
      fitHostID,
    );
    for (const hardpoint of [
      {
        effectName: "turretFitted",
        count: hardpointCounts.turret,
        errorMsg: "NO_TURRET_HARDPOINTS",
        countKey: "turretHardpoints",
        usedKey: "usedTurrets",
      },
      {
        effectName: "launcherFitted",
        count: hardpointCounts.launcher,
        errorMsg: "NO_LAUNCHER_HARDPOINTS",
        countKey: "launcherHardpoints",
        usedKey: "usedLaunchers",
      },
    ]) {
      if (!typeHasEffectName(item.typeID, hardpoint.effectName)) {
        continue;
      }
      const used = getFittedEffectSlotsUsed(currentFittedItems, hardpoint.effectName);
      if (used + getItemEffectSlotUsage(item, hardpoint.effectName) > hardpoint.count) {
        return {
          success: false,
          errorMsg: hardpoint.errorMsg,
          data: {
            [hardpoint.countKey]: hardpoint.count,
            [hardpoint.usedKey]: used,
          },
        };
      }
    }

    const candidateFlags = getSlotFlagsForFamily(
      family,
      fitHostRecord.typeID,
      currentFittedItems,
      fitHostID,
    );
    if (candidateFlags.length === 0) {
      return {
        success: false,
        errorMsg: "NO_FITTING_SLOTS_FOR_FAMILY",
        data: { family },
      };
    }

    const occupiedFlags = new Set(
      currentFittedItems
        .map((fittedItem) => this._normalizeInventoryId(fittedItem && fittedItem.flagID, 0))
        .filter((flagID) => flagID > 0),
    );
    if (candidateFlags.every((flagID) => occupiedFlags.has(flagID))) {
      return {
        success: false,
        errorMsg: "NO_FREE_FITTING_SLOTS_FOR_FAMILY",
        data: { family },
      };
    }

    return { success: false, errorMsg: "NO_SUITABLE_FIT_SLOT" };
  }

  _resolveDestinationForMove(
    session,
    boundContext,
    item,
    requestedFlag,
    explicitFlagProvided,
    fittedItemsOverride = null,
  ) {
    if (
      this._isUnanchoredStructureHullInventoryID(
        boundContext && boundContext.inventoryID,
      )
    ) {
      this._throwUnanchoredStructureHullInventoryError();
    }
    if (
      this._isPendingStructureUnanchorContainerInventoryID(
        boundContext && boundContext.inventoryID,
      )
    ) {
      this._throwPendingStructureUnanchorContainerInventoryError();
    }
    const shipRecord = this._getShipInventoryRecord(session, boundContext);
    const fitHostRecord = shipRecord || this._getStructureFitHostRecord(
      session,
      boundContext && boundContext.inventoryID,
    );
    const numericRequestedFlag =
      requestedFlag === undefined || requestedFlag === null
        ? null
        : this._normalizeInventoryId(requestedFlag, 0);
    const isExplicitFitMove =
      numericRequestedFlag !== null && isShipFittingFlag(numericRequestedFlag);
    const isAutoFitMove = this._isAutoFitRequested(
      requestedFlag,
      explicitFlagProvided,
    );

    if (!shipRecord && (!fitHostRecord || (!isExplicitFitMove && !isAutoFitMove))) {
      const containerID = this._normalizeInventoryId(boundContext && boundContext.inventoryID, 0);
      if (isStarbaseCorporateHangarArrayType(findStarbaseItemById(containerID)) &&
          !starbaseInventoryRuntime.CORPORATE_HANGAR_FLAGS.has(Number(requestedFlag))) {
        throwWrappedUserError("CustomNotify", { notify: "Select a corporation hangar division before moving items into this array." });
      }
      return {
        locationID: this._normalizeInventoryId(
          boundContext && boundContext.inventoryID,
          this._getStationId(session),
        ),
        flagID: requestedFlag ?? ITEM_FLAGS.HANGAR,
      };
    }

    const currentFittedItems =
      Array.isArray(fittedItemsOverride) && fittedItemsOverride.length >= 0
        ? fittedItemsOverride
        : this._listFittedItemsForFitHost(session, fitHostRecord);

    if (isExplicitFitMove) {
      return {
        locationID: fitHostRecord.itemID,
        flagID: numericRequestedFlag,
      };
    }

    if (isAutoFitMove) {
      const autoFitFlag = selectAutoFitFlagForType(
        fitHostRecord,
        currentFittedItems,
        item && item.typeID,
      );
      if (autoFitFlag) {
        return {
          locationID: fitHostRecord.itemID,
          flagID: autoFitFlag,
        };
      }

      return null;
    }

    return {
      locationID: shipRecord.itemID,
      flagID:
        numericRequestedFlag ??
        this._normalizeInventoryId(
          boundContext && boundContext.flagID,
          ITEM_FLAGS.CARGO_HOLD,
        ),
    };
  }

  _canSessionObserveSpaceContainerInventory(
    session,
    inventoryID,
    expectedScene = null,
  ) {
    const numericInventoryID = this._normalizeInventoryId(inventoryID, 0);
    const systemID = this._normalizeInventoryId(
      session && session._space && session._space.systemID,
      0,
    );
    const shipID = this._normalizeInventoryId(
      session && session._space && session._space.shipID,
      0,
    );
    if (numericInventoryID <= 0 || systemID <= 0 || shipID <= 0) {
      return false;
    }

    const scene = runtime.getSceneForSession(session);
    if (!scene || (expectedScene && scene !== expectedScene)) {
      return false;
    }
    const entity =
      typeof scene.getEntityByID === "function"
        ? scene.getEntityByID(numericInventoryID)
        : null;
    const containerRecord = findItemById(numericInventoryID);
    const isStarbaseStorage = starbaseInventoryRuntime.isStarbaseStorage(containerRecord);
    if (
      !entity ||
      (
        entity.kind !== "container" &&
        entity.kind !== "wreck" &&
        !(isStarbaseStorage && entity.kind === "starbase")
      )
    ) {
      return false;
    }
    if (
      this._getSpaceContainerScopeAccessError(session, numericInventoryID) ||
      this._getSecureContainerGeneralAccessError(session, numericInventoryID) ||
      this._getMobileDepotCargoAccessError(session, numericInventoryID)
    ) {
      return false;
    }

    return !this._getPersonalHangarContainerAccessError(
      session,
      containerRecord,
    );
  }

  _markCurrentBoundLiveInventoryListAuthorized(
    session,
    boundContext,
    requestedFlags = [],
  ) {
    if (
      !session ||
      !boundContext ||
      !["container", "shipInventory"].includes(boundContext.kind) ||
      typeof session.currentBoundObjectID !== "string" ||
      !session._boundObjectState ||
      typeof session._boundObjectState !== "object"
    ) {
      return false;
    }
    const objectID = session.currentBoundObjectID;
    const registeredContext = this._boundContexts.get(objectID) || null;
    const inventoryID = this._normalizeInventoryId(boundContext.inventoryID, 0);
    if (
      !registeredContext ||
      registeredContext.kind !== boundContext.kind ||
      this._normalizeInventoryId(registeredContext.inventoryID, 0) !==
        inventoryID
    ) {
      return false;
    }

    let liveInventoryUpdatesFlagIDs = null;
    if (boundContext.kind === "container") {
      if (!this._canSessionObserveSpaceContainerInventory(session, inventoryID)) {
        return false;
      }
    } else {
      liveInventoryUpdatesFlagIDs = [
        ...new Set(
          (Array.isArray(requestedFlags) ? requestedFlags : [requestedFlags])
            .map((flagID) => this._normalizeInventoryId(flagID, 0))
            .filter((flagID) => (
              isShipServiceFlag(flagID) &&
              !this._getShipServiceAccessError(session, inventoryID, flagID)
            )),
        ),
      ];
      if (liveInventoryUpdatesFlagIDs.length === 0) {
        return false;
      }
    }

    for (const state of Object.values(session._boundObjectState)) {
      if (!state || state.objectID !== objectID) {
        continue;
      }
      state.liveInventoryUpdatesAuthorized = true;
      state.liveInventoryUpdatesInventoryID = inventoryID;
      state.liveInventoryUpdatesFlagIDs = liveInventoryUpdatesFlagIDs === null
        ? null
        : [
            ...new Set([
              ...(state.liveInventoryUpdatesFlagIDs || []),
              ...liveInventoryUpdatesFlagIDs,
            ]),
          ];
      return true;
    }
    return false;
  }

  _getSessionBoundContainerInventoryIDs(session) {
    const inventoryIDs = new Set();
    if (
      !session ||
      !session._boundObjectState ||
      typeof session._boundObjectState !== "object"
    ) {
      return inventoryIDs;
    }

    for (const state of Object.values(session._boundObjectState)) {
      if (
        !state ||
        state.liveInventoryUpdatesAuthorized !== true ||
        typeof state.objectID !== "string"
      ) {
        continue;
      }
      const context = this._boundContexts.get(state.objectID) || null;
      if (!context || context.kind !== "container") {
        continue;
      }
      const inventoryID = this._normalizeInventoryId(context.inventoryID, 0);
      if (
        inventoryID > 0 &&
        this._normalizeInventoryId(
          state.liveInventoryUpdatesInventoryID,
          0,
        ) === inventoryID
      ) {
        inventoryIDs.add(inventoryID);
      }
    }
    return inventoryIDs;
  }

  _getSessionBoundShipServiceInventoryScopes(session) {
    const scopes = [];
    if (
      !session ||
      !session._boundObjectState ||
      typeof session._boundObjectState !== "object"
    ) {
      return scopes;
    }

    const seen = new Set();
    for (const state of Object.values(session._boundObjectState)) {
      if (
        !state ||
        state.liveInventoryUpdatesAuthorized !== true ||
        typeof state.objectID !== "string"
      ) {
        continue;
      }
      const context = this._boundContexts.get(state.objectID) || null;
      if (!context || context.kind !== "shipInventory") {
        continue;
      }
      const inventoryID = this._normalizeInventoryId(context.inventoryID, 0);
      if (
        inventoryID <= 0 ||
        this._normalizeInventoryId(
          state.liveInventoryUpdatesInventoryID,
          0,
        ) !== inventoryID
      ) {
        continue;
      }
      for (const rawFlagID of state.liveInventoryUpdatesFlagIDs || []) {
        const flagID = this._normalizeInventoryId(rawFlagID, 0);
        const key = `${inventoryID}:${flagID}`;
        if (
          !seen.has(key) &&
          isShipServiceFlag(flagID) &&
          !this._getShipServiceAccessError(session, inventoryID, flagID)
        ) {
          seen.add(key);
          scopes.push({ inventoryID, flagID });
        }
      }
    }
    return scopes;
  }

  _markCurrentBoundCorporationOfficeListAuthorized(
    session,
    boundContext,
    requestedFlags = null,
  ) {
    if (
      !session ||
      !boundContext ||
      boundContext.kind !== "corpOffice" ||
      typeof session.currentBoundObjectID !== "string" ||
      !session._boundObjectState ||
      typeof session._boundObjectState !== "object"
    ) {
      return false;
    }

    const objectID = session.currentBoundObjectID;
    const registeredContext = this._boundContexts.get(objectID) || null;
    const office = this._getCorporationOffice(
      session,
      boundContext.inventoryID,
    );
    const officeID = this._normalizeInventoryId(office && office.officeID, 0);
    if (
      !registeredContext ||
      registeredContext.kind !== "corpOffice" ||
      officeID <= 0 ||
      office.impounded ||
      this._normalizeInventoryId(registeredContext.inventoryID, 0) !== officeID ||
      this._normalizeInventoryId(office.stationID, 0) !==
        this._normalizeInventoryId(this._getStationId(session), 0)
    ) {
      return false;
    }

    const rawFlags = requestedFlags === null || requestedFlags === undefined
      ? [...CORP_HANGAR_FLAGS]
      : Array.isArray(requestedFlags)
        ? requestedFlags
        : [requestedFlags];
    const authorizedFlags = rawFlags
      .map((flagID) => this._normalizeInventoryId(flagID, 0))
      .filter(
        (flagID) =>
          this._isCorporationHangarFlag(flagID) &&
          this._canQueryCorporationHangarFlag(session, flagID),
      );
    if (authorizedFlags.length === 0) {
      return false;
    }

    for (const state of Object.values(session._boundObjectState)) {
      if (!state || state.objectID !== objectID) {
        continue;
      }
      const retainedFlags = new Set(
        Array.isArray(state.liveCorporationOfficeInventoryFlags)
          ? state.liveCorporationOfficeInventoryFlags
          : [],
      );
      for (const flagID of authorizedFlags) {
        retainedFlags.add(flagID);
      }
      state.liveCorporationOfficeInventoryAuthorized = true;
      state.liveCorporationOfficeInventoryID = officeID;
      state.liveCorporationOfficeInventoryFlags = [...retainedFlags].sort(
        (left, right) => left - right,
      );
      return true;
    }
    return false;
  }

  _getSessionBoundCorporationOfficeSubscriptions(session) {
    const subscriptions = new Map();
    if (
      !session ||
      !session._boundObjectState ||
      typeof session._boundObjectState !== "object"
    ) {
      return subscriptions;
    }

    for (const state of Object.values(session._boundObjectState)) {
      if (
        !state ||
        state.liveCorporationOfficeInventoryAuthorized !== true ||
        typeof state.objectID !== "string"
      ) {
        continue;
      }
      const context = this._boundContexts.get(state.objectID) || null;
      if (!context || context.kind !== "corpOffice") {
        continue;
      }
      const officeID = this._normalizeInventoryId(context.inventoryID, 0);
      if (
        officeID <= 0 ||
        this._normalizeInventoryId(
          state.liveCorporationOfficeInventoryID,
          0,
        ) !== officeID
      ) {
        continue;
      }
      if (!subscriptions.has(officeID)) {
        subscriptions.set(officeID, new Set());
      }
      for (const flagID of Array.isArray(
        state.liveCorporationOfficeInventoryFlags,
      )
        ? state.liveCorporationOfficeInventoryFlags
        : []) {
        const numericFlag = this._normalizeInventoryId(flagID, 0);
        if (this._isCorporationHangarFlag(numericFlag)) {
          subscriptions.get(officeID).add(numericFlag);
        }
      }
    }
    return subscriptions;
  }

  _canSessionObserveCorporationOfficeInventory(session, officeID, flagID) {
    const office = this._getCorporationOffice(session, officeID);
    return Boolean(
      office &&
      !office.impounded &&
      this._normalizeInventoryId(office.officeID, 0) ===
        this._normalizeInventoryId(officeID, 0) &&
      this._normalizeInventoryId(office.stationID, 0) ===
        this._normalizeInventoryId(this._getStationId(session), 0) &&
      this._isCorporationHangarFlag(flagID) &&
      this._canQueryCorporationHangarFlag(session, flagID)
    );
  }

  _projectCorporationOfficeInventoryChange(
    change,
    canSeePrevious,
    canSeeCurrent,
  ) {
    if (!change || !change.item || (!canSeePrevious && !canSeeCurrent)) {
      return null;
    }
    if (canSeePrevious && canSeeCurrent) {
      return change;
    }
    // A full move row exposes its current endpoint and its old-value dictionary
    // exposes the previous one. Rebuild the normal boundary notification when
    // only one endpoint is visible so neither half names the hidden division.
    if (canSeePrevious) {
      const previousData = change.previousData || {};
      const removedItem = buildRemovedItemNotificationState(previousData);
      return removedItem
        ? {
            removed: true,
            previousData,
            item: removedItem,
          }
        : null;
    }

    return {
      created: true,
      removed: false,
      previousData: buildCreatedItemNotificationPreviousState(
        change.item,
        change.item.flagID,
        change.item.ownerID,
      ),
      item: change.item,
    };
  }

  _emitInventoryChangesToBoundCorporationOfficeObservers(
    actorSession,
    changes = [],
    options = {},
  ) {
    // options.corporationID lets a caller that owns no acting session name the
    // corporation directly. The observer half below is unaffected: every role
    // and office check there still runs against the OBSERVER's own session, so
    // naming the corporation here widens who can publish, never who can see.
    const corporationID = this._normalizeInventoryId(
      options.corporationID || this._getCorporationId(actorSession),
      0,
    );
    if (corporationID <= 0) {
      return 0;
    }

    const clientChanges = (Array.isArray(changes) ? changes : [])
      .map((change) => this._sanitizeSecureContainerClientChange(change))
      .filter(Boolean);
    const changesByOfficeID = new Map();
    for (const change of clientChanges) {
      const visibilityByOfficeID = new Map();
      for (const [side, itemState] of [
        ["currentFlagID", change.item],
        ["previousFlagID", change.previousData],
      ]) {
        const flagID = this._normalizeInventoryId(
          itemState && itemState.flagID,
          0,
        );
        if (
          this._normalizeInventoryId(itemState && itemState.ownerID, 0) !==
            corporationID ||
          !this._isCorporationHangarFlag(flagID)
        ) {
          continue;
        }
        const office = this._getCorporationOfficeForItemLocationByCorporation(
          corporationID,
          itemState && itemState.locationID,
        );
        const officeID = this._normalizeInventoryId(office && office.officeID, 0);
        if (officeID <= 0) {
          continue;
        }
        if (!visibilityByOfficeID.has(officeID)) {
          visibilityByOfficeID.set(officeID, {
            currentFlagID: 0,
            previousFlagID: 0,
          });
        }
        visibilityByOfficeID.get(officeID)[side] = flagID;
      }
      for (const [officeID, visibility] of visibilityByOfficeID) {
        if (!changesByOfficeID.has(officeID)) {
          changesByOfficeID.set(officeID, new Map());
        }
        changesByOfficeID.get(officeID).set(change, visibility);
      }
    }
    if (changesByOfficeID.size === 0) {
      return 0;
    }

    // Writers that already synced every one of the acting character's clients
    // (industry, reprocessing) name them all here; a writer that synced only
    // the acting session names just that one, and its other clients are
    // ordinary observers.
    const excludedSessions = new Set(
      Array.isArray(options.excludeSessions) ? options.excludeSessions : [],
    );
    if (actorSession) {
      excludedSessions.add(actorSession);
    }
    let recipientCount = 0;
    for (const observerSession of sessionRegistry.getSessions()) {
      if (
        !observerSession ||
        excludedSessions.has(observerSession) ||
        typeof observerSession.sendNotification !== "function"
      ) {
        continue;
      }
      const subscriptions =
        this._getSessionBoundCorporationOfficeSubscriptions(observerSession);
      const observerChanges = [];
      const seenChanges = new Set();
      for (const [officeID, subscribedFlags] of subscriptions) {
        const officeChanges = changesByOfficeID.get(officeID);
        if (!officeChanges) {
          continue;
        }
        for (const [change, visibility] of officeChanges) {
          const canObserveFlag = (flagID) =>
            subscribedFlags.has(flagID) &&
            this._canSessionObserveCorporationOfficeInventory(
              observerSession,
              officeID,
              flagID,
            );
          const canSeePrevious = canObserveFlag(
            visibility.previousFlagID,
          );
          const canSeeCurrent = canObserveFlag(
            visibility.currentFlagID,
          );
          const projectedChange = this._projectCorporationOfficeInventoryChange(
            change,
            canSeePrevious,
            canSeeCurrent,
          );
          if (projectedChange && !seenChanges.has(change)) {
            seenChanges.add(change);
            observerChanges.push(projectedChange);
          }
        }
      }
      if (observerChanges.length === 0) {
        continue;
      }

      if (options.emitItemsChangedBatch === true) {
        emitItemsChangedBatchForSession(observerSession, observerChanges, {
          maxRowsPerNotification: options.maxRowsPerNotification,
        });
      } else {
        for (const change of observerChanges) {
          syncInventoryItemForSession(
            observerSession,
            change.item,
            change.previousData || {},
            { emitCfgLocation: true },
          );
        }
      }
      recipientCount += 1;
    }
    return recipientCount;
  }

  // An inventory List is only the initial snapshot. Once an authorized List
  // marks its retained bound object, the same-scene session must receive row
  // deltas that enter or leave it. This covers celestial containers and shared
  // ship service bays such as a Fleet Hangar. Bound-object release removes the
  // subscription state, so this fanout naturally stops when the window closes.
  _emitInventoryChangesToBoundSpaceObservers(
    actorSession,
    changes = [],
    options = {},
  ) {
    try {
      starbaseInventoryRuntime.notifyControlledBatteryInventoryChanges(
        actorSession, Array.isArray(changes) ? changes : [], getDogmaChargeNotificationHelper());
    } catch (error) {
      // A failed presentation callback must not turn a committed inventory move
      // into an apparent transaction failure. The next control prime repairs it.
      log.warn(`[InvBroker] Battery inventory HUD refresh failed: ${error.message}`);
    }
    if (!actorSession || !actorSession._space) {
      return 0;
    }
    const scene = runtime.getSceneForSession(actorSession);
    if (
      !scene ||
      !scene.sessions ||
      typeof scene.sessions.values !== "function" ||
      typeof scene.getEntityByID !== "function"
    ) {
      return 0;
    }

    const clientChanges = (Array.isArray(changes) ? changes : [])
      .map((change) => this._sanitizeSecureContainerClientChange(change))
      .filter(Boolean);
    if (clientChanges.length === 0) {
      return 0;
    }

    const changesByInventoryID = new Map();
    const starbaseChanges = new Set(clientChanges.filter((change) =>
      [change.item, change.previousData].some((state) =>
        state && starbaseInventoryRuntime.isStarbaseStorage(findStarbaseItemById(state.locationID)))));
    for (const change of clientChanges) {
      const locationIDs = new Set([
        this._normalizeInventoryId(change.item && change.item.locationID, 0),
        this._normalizeInventoryId(
          change.previousData && change.previousData.locationID,
          0,
        ),
      ]);
      for (const inventoryID of locationIDs) {
        if (inventoryID <= 0) {
          continue;
        }
        const entity = scene.getEntityByID(inventoryID);
        if (
          !entity ||
          (
            !["container", "wreck", "ship"].includes(entity.kind) &&
            !(
              entity.kind === "starbase" &&
              starbaseInventoryRuntime.isStarbaseStorage(findStarbaseItemById(inventoryID))
            )
          )
        ) {
          continue;
        }
        if (!changesByInventoryID.has(inventoryID)) {
          changesByInventoryID.set(inventoryID, []);
        }
        changesByInventoryID.get(inventoryID).push(change);
      }
    }
    if (changesByInventoryID.size === 0) {
      return 0;
    }

    let recipientCount = 0;
    for (const observerSession of scene.sessions.values()) {
      if (
        !observerSession ||
        (observerSession === actorSession && options.includeActor !== true) ||
        (Array.isArray(options.excludeSessions) && options.excludeSessions.includes(observerSession)) ||
        typeof observerSession.sendNotification !== "function"
      ) {
        continue;
      }
      const observedInventoryIDs = this._getSessionBoundContainerInventoryIDs(
        observerSession,
      );
      const observedShipServiceScopes =
        this._getSessionBoundShipServiceInventoryScopes(observerSession);
      const observerChanges = [];
      const seenChanges = new Set();
      const starbaseVisibility = new Map();
      for (const inventoryID of observedInventoryIDs) {
        const inventoryChanges = changesByInventoryID.get(inventoryID);
        if (
          !inventoryChanges ||
          !this._canSessionObserveSpaceContainerInventory(
            observerSession,
            inventoryID,
            scene,
          )
        ) {
          continue;
        }
        // Only starbase changes need the container row, and it is the same row
        // for every change here. findItemById returns a deep copy, so read it
        // once, and only when a starbase change needs it.
        let hangar;
        for (const change of inventoryChanges) {
          if (starbaseChanges.has(change)) {
            if (hangar === undefined) hangar = findItemById(inventoryID);
            const canSee = (state) => Boolean(state && Number(state.locationID) === inventoryID &&
              (!starbaseInventoryRuntime.isBatteryAmmoInventory(hangar) ||
                starbaseInventoryRuntime.isBatteryAmmoFlag(hangar, state.flagID)) &&
              (!starbaseInventoryRuntime.isTowerBay(hangar) || [0, 122].includes(Number(state.flagID))) &&
              (!starbaseProcessingInventory.isProcessingStorage(hangar) ||
                (Number(state.flagID) === starbaseProcessingInventory.getProcessingFlag(hangar) &&
                 Number(state.ownerID) === Number(hangar.ownerID))) &&
              (!isStarbaseCorporateHangarArrayType(hangar) ||
                this._canQueryStarbaseCorporationHangarFlag(observerSession, hangar, state.flagID)));
            const visibility = starbaseVisibility.get(change) || { previous: false, current: false };
            visibility.previous ||= canSee(change.previousData);
            visibility.current ||= canSee(change.item);
            starbaseVisibility.set(change, visibility);
            continue;
          }
          if (!seenChanges.has(change)) {
            seenChanges.add(change);
            observerChanges.push(change);
          }
        }
      }
      for (const { inventoryID, flagID } of observedShipServiceScopes) {
        const inventoryChanges = changesByInventoryID.get(inventoryID);
        if (!inventoryChanges) {
          continue;
        }
        for (const change of inventoryChanges) {
          const entersObservedBay = Boolean(
            change.item &&
            this._normalizeInventoryId(change.item.locationID, 0) === inventoryID &&
            this._normalizeInventoryId(change.item.flagID, 0) === flagID
          );
          const leavesObservedBay = Boolean(
            change.previousData &&
            this._normalizeInventoryId(change.previousData.locationID, 0) === inventoryID &&
            this._normalizeInventoryId(change.previousData.flagID, 0) === flagID
          );
          if (starbaseChanges.has(change)) {
            const visibility = starbaseVisibility.get(change) || { previous: false, current: false };
            visibility.previous ||= leavesObservedBay;
            visibility.current ||= entersObservedBay;
            starbaseVisibility.set(change, visibility);
            continue;
          }
          if ((entersObservedBay || leavesObservedBay) && !seenChanges.has(change)) {
            seenChanges.add(change);
            observerChanges.push(change);
          }
        }
      }
      // inventorysvc.py:66-74 reconstructs the old row from the change dict;
      // invControllers.py:868-871 requires division Query access to show it.
      // Combine authorized container and ship-bay views BEFORE projecting:
      // either endpoint can be private, and a second subscription must not
      // bypass projection or emit a second, contradictory row for the move.
      for (const [change, visibility] of starbaseVisibility) {
        const projected = this._projectCorporationOfficeInventoryChange(
          change, visibility.previous, visibility.current,
        );
        if (projected) observerChanges.push(projected);
      }
      if (observerChanges.length === 0) {
        continue;
      }

      if (options.emitItemsChangedBatch === true) {
        emitItemsChangedBatchForSession(observerSession, observerChanges, {
          maxRowsPerNotification: options.maxRowsPerNotification,
        });
      } else {
        for (const change of observerChanges) {
          syncInventoryItemForSession(
            observerSession,
            change.item,
            change.previousData || {},
            { emitCfgLocation: true },
          );
        }
      }
      recipientCount += 1;
    }
    return recipientCount;
  }

  _emitInventoryMoveChanges(session, changes = [], options = {}) {
    const normalizedChanges = Array.isArray(changes) ? changes : [];
    this._touchAnchoredCargoContainerLifetimes(session, normalizedChanges);
    const clientChanges = normalizedChanges
      .map((change) => this._sanitizeSecureContainerClientChange(change))
      .filter(Boolean);
    // Single Add/merge transfers need the same footer refresh as MultiAdd.
    // Keep the existing relocation and ship-label side effects of item sync;
    // observers still receive only their authorized endpoint projections.
    const touchesStarbaseStorage = normalizedChanges.some((change) =>
      [change && change.item, change && change.previousData].some((state) =>
        state && starbaseInventoryRuntime.isStarbaseStorage(findStarbaseItemById(state.locationID))));

    if (options.emitItemsChangedBatch === true) {
      emitItemsChangedBatchForSession(session, clientChanges, {
        idType: options.idType,
        locationContext: options.locationContext,
        maxRowsPerNotification: options.maxRowsPerNotification,
      });
      if (options.emitCfgLocation === true) {
        for (const change of clientChanges) {
          const item = change && change.item;
          // As a single sync tells it: only a ship the change names (isItemNamingChange).
          if (!item || Number(item.categoryID) !== SHIP_CATEGORY_ID || !isItemNamingChange(item, change.previousData)) {
            continue;
          }
          session.sendNotification("OnCfgDataChanged", "charid", [
            "evelocations",
            buildLocationChangePayload(session, item),
          ]);
        }
      }
      this._emitInventoryChangesToBoundSpaceObservers(session, clientChanges, {
        emitItemsChangedBatch: true,
        maxRowsPerNotification: options.maxRowsPerNotification,
      });
      this._emitInventoryChangesToBoundCorporationOfficeObservers(
        session,
        clientChanges,
        {
          emitItemsChangedBatch: true,
          maxRowsPerNotification: options.maxRowsPerNotification,
        },
      );
      this._refreshDockedFittingState(session, normalizedChanges);
      return;
    }

    for (const change of clientChanges) {
      if (!change || !change.item) {
        continue;
      }

      syncInventoryItemForSession(
        session,
        change.item,
        change.previousData || {},
        {
          emitCfgLocation: true,
          // announceItemsChanged: the mover's own copy as TQ's OnItemsChanged, keeping the
          // per-item side effects; the client recounts item goals only on its
          // OnMultipleItemChange (career Industry part 5: "Retrieve" the crate into cargo).
          emitItemsChangedBatch: touchesStarbaseStorage || options.announceItemsChanged === true,
        },
      );
    }

    this._emitInventoryChangesToBoundSpaceObservers(session, clientChanges, {
      emitItemsChangedBatch: touchesStarbaseStorage,
    });
    this._emitInventoryChangesToBoundCorporationOfficeObservers(
      session,
      clientChanges,
      { emitItemsChangedBatch: touchesStarbaseStorage },
    );

    this._refreshDockedFittingState(session, normalizedChanges);
  }

  // Loading a charge into a fitting slot has a different client contract from
  // the plain inventory move _emitInventoryMoveChanges publishes. A fitted
  // charge has no real itemID as far as the client is concerned: the row that
  // carries the new count is the (shipID, flagID, chargeTypeID) tuple's
  // attribute 805, not an OnItemChange on the charge item.
  //
  // Golden "Topping Up Ammo from cargo direct to fitting while docked.txt"
  // (retail TQ, player DOCKED at station 60011734):
  //   line 294  OnItemChange on the real SOURCE stack (917 -> 894)
  //   line 350  OnModuleAttributeChange (1054768634001L, 28, 222), 805, 57 -> 80
  //   line 357  godma "... value I had was 57" — the tuple key was already held
  // and the whole 1073-line docked trace carries no real itemID for the loaded
  // charge at all. Emitting one hands the client an identity its invCache and
  // godma were never primed with, which GetAllInfo and List both deny exists.
  //
  // dogmaService.Handle_LoadAmmo already publishes exactly that shape, so
  // delegate to its helpers instead of restating the contract here.
  _emitFittedChargeLoadChanges(session, changes = [], chargeTransition = null) {
    const normalizedChanges = Array.isArray(changes) ? changes : [];
    this._touchAnchoredCargoContainerLifetimes(session, normalizedChanges);
    const clientChanges = normalizedChanges
      .map((change) => this._sanitizeSecureContainerClientChange(change))
      .filter(Boolean);

    const dogma = getDogmaChargeNotificationHelper();
    // _syncInventoryChanges runs _filterInventoryChangesForClient (which strips
    // the fitted-charge row and retires the consumed source stack) and then its
    // own _refreshDockedFittingState, so this must not also call ours.
    dogma._syncInventoryChanges(session, clientChanges);

    if (!chargeTransition) {
      return;
    }
    const { charID, shipID, flagID } = chargeTransition;
    const nextChargeState = dogma._captureChargeStateSnapshot(
      charID,
      shipID,
      flagID,
    );
    const nextChargeItem = dogma._captureChargeItemSnapshot(
      charID,
      shipID,
      flagID,
    );
    dogma._notifyChargeQuantityTransition(
      session,
      charID,
      shipID,
      flagID,
      chargeTransition.previousChargeState,
      nextChargeState,
      {
        previousChargeItem: chargeTransition.previousChargeItem,
        nextChargeItem,
      },
    );
    dogma._notifyWeaponModuleAttributeTransition(
      session,
      chargeTransition.moduleItem,
      chargeTransition.previousChargeItem,
      nextChargeItem,
    );
  }

  _touchAnchoredCargoContainerLifetimes(session, changes = []) {
    const removedItemIDs = new Set(
      (Array.isArray(changes) ? changes : [])
        .filter((change) => change && change.removed === true)
        .map((change) => this._normalizeInventoryId(
          change.previousData && change.previousData.itemID,
          0,
        ))
        .filter((itemID) => itemID > 0),
    );
    const containerIDs = new Set();
    for (const change of Array.isArray(changes) ? changes : []) {
      const previousItem =
        change && (change.previousData || change.previousState);
      const currentItem = change && (change.item || change.currentData);
      for (const candidate of [previousItem, currentItem]) {
        const locationID = this._normalizeInventoryId(
          candidate && candidate.locationID,
          0,
        );
        // A removed container cannot have its lifetime extended. Skipping it
        // also prevents a deep bulk delete from issuing one dead-container
        // lookup for every level after the atomic commit.
        if (locationID > 0 && !removedItemIDs.has(locationID)) {
          containerIDs.add(locationID);
        }
      }
    }
    if (containerIDs.size <= 0) {
      return [];
    }

    const nowMs = runtime.getSimulationTimeMsForSession(
      session,
      Date.now(),
    );
    const touched = [];
    for (const containerID of containerIDs) {
      const result = touchAnchoredCargoContainerContents(containerID, {
        nowMs,
        refreshPresentation: true,
      });
      if (result.success && result.changed) {
        touched.push(containerID);
      }
    }
    return touched;
  }

  _isMtuSpaceComponentLootMove(session, sourceLocationID, destination) {
    const sourceContainer = findItemById(sourceLocationID);
    return Boolean(
      this._isMobileTractorUnitInventoryItem(sourceContainer) &&
      destination &&
      this._normalizeInventoryId(destination.locationID, 0) === this._normalizeInventoryId(this._getShipId(session), 0) &&
      this._normalizeInventoryId(destination.flagID, 0) === ITEM_FLAGS.CARGO_HOLD
    );
  }

  // Space loot sources a pilot can drag items out of: deployed cargo
  // containers/jetcans and wrecks. Wrecks arrive in two flavors - ordinary
  // inventory rows and native NPC wreck records with no itemStore row - and
  // both stamp the killer as their owner, so both answer to the same loot
  // rights as a container. Returns the normalized descriptor the entitlement
  // rules consume, or null when this move is not a space loot take at all.
  _buildPlayerSpaceLootSource(session, sourceLocationID) {
    const numericSourceLocationID = this._normalizeInventoryId(
      sourceLocationID,
      0,
    );
    if (numericSourceLocationID <= 0) {
      return null;
    }

    const sourceItem = findItemById(numericSourceLocationID);
    if (sourceItem) {
      const isContainerSource = this._isSpaceContainerLikeInventoryItem(sourceItem);
      if (!isContainerSource && !this._isWreckInventoryItem(sourceItem)) {
        return null;
      }
      const sessionSystemID = this._normalizeInventoryId(
        session &&
          session._space &&
          session._space.systemID,
        this._normalizeInventoryId(
          session && (session.solarsystemid2 ?? session.solarsystemid),
          0,
        ),
      );
      const isSpaceLootSource = Boolean(
        this._normalizeInventoryId(sourceItem.flagID, -1) === 0 &&
        sourceItem.spaceState &&
        this._normalizeInventoryId(sourceItem.locationID, 0) ===
          sessionSystemID &&
        this._normalizeInventoryId(
          sourceItem.spaceState.systemID,
          0,
        ) === sessionSystemID
      );
      if (!isSpaceLootSource) {
        return null;
      }
      return {
        ...buildSpaceLootSourceFromItem(sourceItem),
        kind: isContainerSource ? "container" : "wreck",
      };
    }

    // Native NPC wrecks live outside itemStore, so there is no row to gate on
    // flag/spaceState here. The transfer path validates scene presence and
    // range separately, while the service-owned record is authoritative for
    // loot rights even across scene rematerialization.
    const nativeWreckRecord = this._getNativeWreckRecord(
      numericSourceLocationID,
    );
    if (!nativeWreckRecord) {
      return null;
    }
    return {
      itemID: numericSourceLocationID,
      kind: "wreck",
      ownerID: this._normalizeInventoryId(nativeWreckRecord.ownerID, 0),
      locationID: this._normalizeInventoryId(nativeWreckRecord.systemID, 0),
      lootInfo: {
        rightsSnapshotVersion: this._normalizeInventoryId(
          nativeWreckRecord.lootRightsSnapshotVersion,
          0,
        ),
        abandoned: nativeWreckRecord.lootAbandoned === true,
        corporationID: this._normalizeInventoryId(
          nativeWreckRecord.corporationID,
          0,
        ),
        lootRightCorpID: this._normalizeInventoryId(
          nativeWreckRecord.lootRightCorpID,
          0,
        ),
        lootRightFleetID: this._normalizeInventoryId(
          nativeWreckRecord.lootRightFleetID,
          0,
        ) || null,
      },
    };
  }

  // Kept container-only: this drives the client-facing move emission shape,
  // which wreck loot has always taken through the ordinary path.
  _isPlayerSpaceContainerLootMove(
    session,
    sourceLocationID,
    destination,
  ) {
    if (!destination) {
      return false;
    }
    const lootSource = this._buildPlayerSpaceLootSource(
      session,
      sourceLocationID,
    );
    return Boolean(
      lootSource &&
      lootSource.kind === "container" &&
      this._isInventoryDestinationInsideActiveShip(session, destination)
    );
  }

  _isInventoryDestinationInsideActiveShip(session, destination) {
    if (!destination) {
      return false;
    }

    const activeShipID = this._normalizeInventoryId(
      this._getShipId(session),
      0,
    );
    const destinationLocationID = this._normalizeInventoryId(
      destination.locationID,
      0,
    );
    const destinationFlagID = this._normalizeInventoryId(
      destination.flagID,
      0,
    );
    if (activeShipID <= 0 || destinationLocationID <= 0) {
      return false;
    }
    if (destinationLocationID === activeShipID) {
      return (
        SHIP_BAY_FLAGS.has(destinationFlagID) ||
        isShipFittingFlag(destinationFlagID)
      );
    }

    return this._getInventoryItemAncestorChain(destinationLocationID).some(
      (item) =>
        this._normalizeInventoryId(item && item.locationID, 0) ===
          activeShipID &&
        SHIP_BAY_FLAGS.has(
          this._normalizeInventoryId(item && item.flagID, 0),
        ),
    );
  }

  _evaluatePlayerSpaceContainerLootMove(
    session,
    sourceLocationID,
    destination,
  ) {
    if (!destination) {
      return {
        handled: false,
        success: true,
      };
    }
    const numericSourceLocationID = this._normalizeInventoryId(
      sourceLocationID,
      0,
    );
    const destinationLocationID = this._normalizeInventoryId(
      destination.locationID,
      0,
    );
    const destinationRemainsInsideSource = Boolean(
      numericSourceLocationID > 0 &&
      destinationLocationID > 0 &&
      (
        destinationLocationID === numericSourceLocationID ||
        this._getInventoryItemAncestorChain(destinationLocationID).some(
          (item) =>
            this._normalizeInventoryId(item && item.itemID, 0) ===
              numericSourceLocationID,
        )
      )
    );
    if (destinationRemainsInsideSource) {
      return {
        handled: false,
        success: true,
      };
    }
    const lootSource = this._buildPlayerSpaceLootSource(
      session,
      numericSourceLocationID,
    );
    if (
      !lootSource ||
      this._isSecureCargoContainerInventoryItem(findItemById(lootSource.itemID))
    ) {
      return {
        handled: false,
        success: true,
      };
    }

    const access = evaluateSpaceLootAccess(session, lootSource, {
      scene:
        runtime && typeof runtime.getSceneForSession === "function"
          ? runtime.getSceneForSession(session)
          : null,
    });
    return {
      handled: true,
      success: access.success,
      errorMsg: access.success
        ? undefined
        : (access.errorMsg || "SafetyActivated"),
      requiresSuspectTimer: access.requiresSuspectTimer,
      lootSource,
      access,
    };
  }

  _sessionHasPlayerSpaceContainerLootRight(session, containerItem) {
    if (!containerItem) {
      return false;
    }
    return sessionHasSpaceLootRight(
      session,
      buildSpaceLootSourceFromItem(containerItem),
    );
  }

  _settlePlayerSpaceContainerTheft(session, evaluation) {
    if (!evaluation || !evaluation.handled || !evaluation.access) {
      return { success: true, applied: false, errorMsg: null };
    }

    const result = recordSpaceLootTheft(session, evaluation.access, {
      scene:
        runtime && typeof runtime.getSceneForSession === "function"
          ? runtime.getSceneForSession(session)
          : null,
    });
    if (result.errorMsg) {
      log.warn(
        `[InvBroker] Failed to apply space-loot theft consequence char=${this._getCharacterId(session)} ` +
          `source=${evaluation.lootSource && evaluation.lootSource.itemID} error=${result.errorMsg}`,
      );
      return {
        success: false,
        applied: false,
        errorMsg: result.errorMsg,
      };
    }
    return {
      success: true,
      applied: result.applied,
      errorMsg: null,
      receipt: result.receipt || null,
    };
  }

  _ensurePlayerSpaceContainerTheftSettled(session, evaluation) {
    const settlement = this._settlePlayerSpaceContainerTheft(
      session,
      evaluation,
    );
    if (!settlement.success) {
      throwWrappedUserError("CustomNotify", {
        notify: "Unable to record the Crimewatch consequence. Please try again.",
      });
    }
    return settlement;
  }

  _commitPlayerSpaceContainerTheft(session, settlement) {
    if (!settlement || !settlement.receipt) {
      return { success: true, applied: false, errorMsg: null };
    }
    const result = commitSpaceLootTheft(session, settlement, {
      scene:
        runtime && typeof runtime.getSceneForSession === "function"
          ? runtime.getSceneForSession(session)
          : null,
    });
    if (result.errorMsg) {
      // Custody is already durable. A prepared receipt is itself an active,
      // persisted suspect contribution, so a commit-marker failure must never
      // trigger compensation or make the successful take appear unflagged.
      log.warn(
        `[InvBroker] Space-loot theft receipt remains prepared after custody ` +
          `char=${this._getCharacterId(session)} receipt=${settlement.receipt.receiptID || "unknown"} ` +
          `error=${result.errorMsg}`,
      );
      return { success: false, applied: false, errorMsg: result.errorMsg };
    }
    return { success: true, applied: result.applied, errorMsg: null };
  }

  _compensatePlayerSpaceContainerTheft(session, settlement) {
    if (!settlement || !settlement.receipt) {
      return { success: true, applied: false, errorMsg: null };
    }
    const result = compensateSpaceLootTheft(session, settlement, {
      scene:
        runtime && typeof runtime.getSceneForSession === "function"
          ? runtime.getSceneForSession(session)
          : null,
    });
    if (result.errorMsg) {
      // Failed compensation is fail-closed: the operation still fails, and the
      // prepared contribution deliberately remains active and durable.
      log.warn(
        `[InvBroker] Failed to compensate rejected space-loot custody ` +
          `char=${this._getCharacterId(session)} receipt=${settlement.receipt.receiptID || "unknown"} ` +
          `error=${result.errorMsg}`,
      );
      return { success: false, applied: false, errorMsg: result.errorMsg };
    }
    return { success: true, applied: result.applied, errorMsg: null };
  }

  _buildShipCargoLocationContext(session, destination) {
    const shipID = this._normalizeInventoryId(
      this._getShipId(session),
      destination && destination.locationID,
    );
    return ["Ship", shipID, "ShipCargo"];
  }

  _emitMtuSpaceComponentLootEvents(session, sourceLocationID, destination, lootedItems = []) {
    if (!session || typeof session.sendNotification !== "function") {
      return false;
    }
    const shipID = this._normalizeInventoryId(
      destination && destination.locationID,
      this._getShipId(session),
    );
    const flagID = this._normalizeInventoryId(
      destination && destination.flagID,
      ITEM_FLAGS.CARGO_HOLD,
    );
    session.sendNotification("OnClientEvent_MoveFromCargoToHangar", "clientID", [
      sourceLocationID,
      shipID,
      flagID,
    ]);
    const rows = (Array.isArray(lootedItems) ? lootedItems : [])
      .map((item) => this._buildInventoryItemOverrides(session, item))
      .filter(Boolean)
      .map((overrides) => this._buildInvRow(session, overrides));
    session.sendNotification("OnWreckLootAll", "clientID", [
      ["SpaceComponentInventory", sourceLocationID],
      rows,
    ]);
    return true;
  }

  _emitPlayerSpaceContainerLootEvents(
    session,
    sourceLocationID,
    destination,
    lootedItems = [],
  ) {
    if (!session || typeof session.sendNotification !== "function") {
      return false;
    }
    const shipID = this._normalizeInventoryId(
      destination && destination.locationID,
      this._getShipId(session),
    );
    const flagID = this._normalizeInventoryId(
      destination && destination.flagID,
      ITEM_FLAGS.CARGO_HOLD,
    );
    session.sendNotification("OnClientEvent_MoveFromCargoToHangar", "clientID", [
      sourceLocationID,
      shipID,
      flagID,
    ]);
    // OnWreckLootAll dismisses the floating-cargo loot window. Only send it once
    // the container is actually empty; on a partial loot the window must stay
    // open over the items that remain.
    if (listContainerItems(null, sourceLocationID, null).length > 0) {
      return true;
    }
    const rows = (Array.isArray(lootedItems) ? lootedItems : [])
      .map((item) => this._buildInventoryItemOverrides(session, item))
      .filter(Boolean)
      .map((overrides) => this._buildInvRow(session, overrides));
    session.sendNotification("OnWreckLootAll", "clientID", [
      ["ItemFloatingCargo", sourceLocationID],
      rows,
    ]);
    return true;
  }

  _classifyCorpStructureHangarMove(session, change) {
    const item = change && change.item ? change.item : null;
    const previous = change && (change.previousData || change.previousState)
      ? (change.previousData || change.previousState)
      : null;
    if (!item || !previous) {
      return null;
    }

    const characterID = this._normalizeInventoryId(this._getCharacterId(session), 0);
    const corporationID = this._normalizeInventoryId(this._getCorporationId(session), 0);
    if (characterID <= 0 || corporationID <= 0) {
      return null;
    }

    const previousOwnerID = this._normalizeInventoryId(previous.ownerID, 0);
    const currentOwnerID = this._normalizeInventoryId(item.ownerID, 0);
    const previousLocationID = this._normalizeInventoryId(previous.locationID, 0);
    const currentLocationID = this._normalizeInventoryId(item.locationID, 0);
    const previousFlagID = this._normalizeInventoryId(previous.flagID, 0);
    const currentFlagID = this._normalizeInventoryId(item.flagID, 0);

    const previousOffice = this._getCorporationOfficeForItemLocation(
      session,
      previousLocationID,
    );
    const currentOffice = this._getCorporationOfficeForItemLocation(
      session,
      currentLocationID,
    );
    const previousStructure = this._getStructureForInventoryID(previousLocationID);
    const currentStructure = this._getStructureForInventoryID(currentLocationID);

    if (
      previousOwnerID === corporationID &&
      currentOwnerID === characterID &&
      previousOffice &&
      this._isCorporationHangarFlag(previousFlagID) &&
      currentFlagID === ITEM_FLAGS.HANGAR &&
      currentStructure
    ) {
      return {
        order: ["charid", CORP_HANGAR_BROADCAST_IDTYPE],
        locationContext: [
          "Structure",
          currentLocationID,
          "StructureItemHangar",
        ],
      };
    }

    if (
      previousOwnerID === characterID &&
      currentOwnerID === corporationID &&
      previousFlagID === ITEM_FLAGS.HANGAR &&
      previousStructure &&
      currentOffice &&
      this._isCorporationHangarFlag(currentFlagID)
    ) {
      return {
        order: [CORP_HANGAR_BROADCAST_IDTYPE, "charid"],
        locationContext: null,
      };
    }

    return null;
  }

  _emitCorpStructureHangarMoveChanges(session, changes = []) {
    const normalizedChanges = (Array.isArray(changes) ? changes : []).filter(
      (change) => change && change.item,
    );
    if (normalizedChanges.length !== 1) {
      return false;
    }

    const change = normalizedChanges[0];
    const classification = this._classifyCorpStructureHangarMove(session, change);
    if (!classification) {
      return false;
    }
    const clientChange = this._sanitizeSecureContainerClientChange(change);

    for (const idType of classification.order) {
      emitItemsChangedBatchForSession(session, [clientChange], {
        idType,
        locationContext: classification.locationContext,
      });
    }
    this._refreshDockedFittingState(session, normalizedChanges);
    return true;
  }

  _emitStructureCoreInstallMoveChanges(
    session,
    changes = [],
    destination = null,
    sourceItem = null,
  ) {
    const normalizedChanges = (Array.isArray(changes) ? changes : []).filter(
      (change) => change && change.item,
    );
    const deedChanges = normalizedChanges.filter((change) => (
      this._normalizeInventoryId(change.item.locationID, 0) ===
        this._normalizeInventoryId(destination && destination.locationID, 0) &&
      this._normalizeInventoryId(change.item.flagID, 0) ===
        ITEM_FLAGS.STRUCTURE_DEED
    ));
    if (deedChanges.length === 0) {
      return false;
    }

    const deedItem = deedChanges[0].item;
    const previousOwnerID = this._normalizeInventoryId(
      sourceItem && sourceItem.ownerID,
      this._getCharacterId(session),
    );
    const previousLocationID = this._normalizeInventoryId(
      sourceItem && sourceItem.locationID,
      0,
    );
    const previousFlagID = this._normalizeInventoryId(
      sourceItem && sourceItem.flagID,
      ITEM_FLAGS.HANGAR,
    );
    const changeEntries = [];
    if (
      previousOwnerID > 0 &&
      previousOwnerID !== this._normalizeInventoryId(deedItem.ownerID, 0)
    ) {
      changeEntries.push([2, previousOwnerID]);
    }
    if (
      previousLocationID > 0 &&
      previousLocationID !== this._normalizeInventoryId(deedItem.locationID, 0)
    ) {
      changeEntries.push([3, previousLocationID]);
    }
    if (previousFlagID !== this._normalizeInventoryId(deedItem.flagID, 0)) {
      changeEntries.push([4, previousFlagID]);
    }
    const changeDict = {
      type: "dict",
      entries: changeEntries,
    };

    for (const idType of ["shipid", "charid"]) {
      emitItemsChangedBatchForSession(session, deedChanges, {
        idType,
        changeDict,
      });
    }
    this._refreshDockedFittingState(session, normalizedChanges);

    if (session && typeof session.sendNotification === "function") {
      const structureID = this._normalizeInventoryId(
        destination && destination.locationID,
        0,
      );
      session.sendNotification("OnClientEvent_MoveFromCargoToHangar", "clientID", [
        structureID,
        structureID,
        ITEM_FLAGS.STRUCTURE_DEED,
      ]);
    }
    return true;
  }

  _primeDroneBayDogmaForFittingChanges(session, changes = []) {
    if (!Array.isArray(changes) || changes.length === 0) {
      return false;
    }

    const shipIDs = new Set();
    for (const change of changes) {
      if (!change || !change.item) {
        continue;
      }
      const item = change.item;
      const previous = change.previousData || change.previousState || {};
      const currentFlagID = this._normalizeInventoryId(item.flagID, 0);
      const previousFlagID = this._normalizeInventoryId(previous.flagID, 0);
      if (
        currentFlagID !== ITEM_FLAGS.DRONE_BAY &&
        previousFlagID !== ITEM_FLAGS.DRONE_BAY
      ) {
        continue;
      }
      const shipID = this._normalizeInventoryId(
        currentFlagID === ITEM_FLAGS.DRONE_BAY
          ? item.locationID
          : previous.locationID,
        0,
      );
      if (shipID > 0) {
        shipIDs.add(shipID);
      }
    }

    let primed = false;
    for (const shipID of shipIDs) {
      const shipContext = {
        kind: "shipInventory",
        inventoryID: shipID,
        flagID: ITEM_FLAGS.DRONE_BAY,
      };
      const droneBayItems = this._resolveContainerItems(
        session,
        ITEM_FLAGS.DRONE_BAY,
        shipContext,
      );
      primed = this._primeInSpaceBayDogmaItems(
        session,
        shipContext,
        ITEM_FLAGS.DRONE_BAY,
        droneBayItems,
      ) || primed;
    }

    return primed;
  }

  _captureFittingModuleAttributeState(session, shipID) {
    if (typeof runtime.captureFittedGenericModuleAttributeState !== "function") {
      return null;
    }
    try {
      return runtime.captureFittedGenericModuleAttributeState(session, {
        shipID,
        includeOfflineModules: true,
      });
    } catch (error) {
      log.warn(
        `[InvBroker] Fitting module attribute baseline capture failed char=${this._getCharacterId(session)} ship=${this._normalizeInventoryId(shipID, 0)} error=${error && error.message ? error.message : String(error)}`,
      );
      return null;
    }
  }

  _diffFittingModuleAttributeState(session, shipID, beforeSnapshots) {
    if (
      !(beforeSnapshots instanceof Map) ||
      typeof runtime.diffFittedGenericModuleAttributeState !== "function"
    ) {
      return [];
    }
    try {
      return runtime.diffFittedGenericModuleAttributeState(
        session,
        beforeSnapshots,
        {
          shipID,
          includeOfflineModules: true,
        },
      );
    } catch (error) {
      log.warn(
        `[InvBroker] Fitting module attribute refresh failed after commit char=${this._getCharacterId(session)} ship=${this._normalizeInventoryId(shipID, 0)} error=${error && error.message ? error.message : String(error)}`,
      );
      return [];
    }
  }

  // TQ-parity emission for fit/unfit moves: lock -> OnMultiEvent(dogma recalc) ->
  // OnItemsChanged -> unlock, delegated to characterState. Replaces the legacy
  // per-item OnItemChange + _refreshDockedFittingState path on the fitting
  // handlers. See doc/PARITY_FITTING_NOTIFICATION_SEQUENCE.md.
  // Returns the number of client-visible row deltas actually emitted. Callers
  // that counted a move must treat 0 as an invariant violation and say so: a
  // committed move the client is never told about looks like a dead drag.
  _emitFittingMoveChanges(session, changes = [], options = {}) {
    const normalized = (Array.isArray(changes) ? changes : []).filter(
      (change) => change && change.item,
    );
    if (normalized.length === 0) {
      return 0;
    }
    // Dedupe exact row deltas while preserving TQ's packaged-module sequence:
    // singleton conversion in cargo first, then the actual slot move. Folded-in
    // online-state changes carry no client-visible row delta and are skipped.
    const deduped = [];
    const seenRowDeltas = new Set();
    for (const change of normalized) {
      const itemID = this._normalizeInventoryId(change.item.itemID, 0);
      if (itemID <= 0) {
        continue;
      }
      const previous = change.previousData || change.previousState || {};
      const signatureParts = [
        itemID,
        this._normalizeInventoryId(previous.ownerID, 0),
        this._normalizeInventoryId(previous.locationID, 0),
        this._normalizeInventoryId(previous.flagID, -1),
        this._normalizeInventoryId(previous.quantity, 0),
        this._normalizeInventoryId(previous.stacksize, 0),
        this._normalizeInventoryId(previous.singleton, -1),
        this._normalizeInventoryId(change.item.ownerID, 0),
        this._normalizeInventoryId(change.item.locationID, 0),
        this._normalizeInventoryId(change.item.flagID, -1),
        this._normalizeInventoryId(change.item.quantity, 0),
        this._normalizeInventoryId(change.item.stacksize, 0),
        this._normalizeInventoryId(change.item.singleton, -1),
      ];
      const hasRowDelta =
        signatureParts[1] !== signatureParts[7] ||
        signatureParts[2] !== signatureParts[8] ||
        signatureParts[3] !== signatureParts[9] ||
        signatureParts[4] !== signatureParts[10] ||
        signatureParts[5] !== signatureParts[11] ||
        signatureParts[6] !== signatureParts[12];
      if (!hasRowDelta) {
        continue;
      }
      const signature = signatureParts.join(":");
      if (!seenRowDeltas.has(signature)) {
        seenRowDeltas.add(signature);
        deduped.push(change);
      }
    }
    if (deduped.length === 0) {
      return 0;
    }
    // A skipped online-state change still decides how the client is told about the fit: the module's
    // last state in this batch (a fit left offline for CPU, powergrid or missing skills is followed by
    // its offline stamp). The move is emitted with that state, so the client does not show the module
    // online and take the pilot's next click on it as "take offline".
    const finalItemByID = new Map();
    for (const change of normalized) {
      const itemID = this._normalizeInventoryId(change.item.itemID, 0);
      if (itemID > 0) finalItemByID.set(itemID, change.item);
    }
    for (let index = 0; index < deduped.length; index += 1) {
      const itemID = this._normalizeInventoryId(deduped[index].item.itemID, 0);
      const finalItem = finalItemByID.get(itemID);
      if (finalItem && finalItem !== deduped[index].item && finalItem.moduleState) {
        deduped[index] = {
          ...deduped[index],
          item: { ...deduped[index].item, moduleState: { ...finalItem.moduleState } },
        };
      }
    }
    this._primeDroneBayDogmaForFittingChanges(session, deduped);

    let fittingShipID = 0;
    for (const change of deduped) {
      const previous = change.previousData || change.previousState || {};
      if (isShipFittingFlag(change.item.flagID)) {
        fittingShipID = this._normalizeInventoryId(change.item.locationID, 0);
        break;
      }
      if (isShipFittingFlag(previous.flagID)) {
        fittingShipID = this._normalizeInventoryId(previous.locationID, 0);
        break;
      }
    }
    if (fittingShipID <= 0) {
      fittingShipID = this._normalizeInventoryId(
        (session &&
          (session.activeShipID || session.shipID || session.shipid)) ||
          this._getShipId(session),
        0,
      );
    }

    const dependentModuleAttributeDiffs = this._diffFittingModuleAttributeState(
      session,
      fittingShipID,
      options.previousModuleAttributeSnapshots,
    );
    // Left to itself, emitFittingTransactionForSession peeks the cached fitting
    // snapshot for the "before" side of its attribute deltas. That only holds
    // while nothing reads the snapshot mid-transaction — and a batch that also
    // fills the drone bay or cargo hold does exactly that, because the capacity
    // check for a non-fitting destination rebuilds and re-caches the snapshot
    // from the already-fitted ship. The peek then diffs the post-fit state
    // against itself and the client never hears about the rig-boosted
    // powerOutput. Callers that captured the ship's state before their first
    // mutation hand it over here instead.
    // Only honour it for this batch's own ship: a structure fit host resolves a
    // fittingShipID other than the caller's ship record, and diffing against a
    // foreign ship would be worse than the peek.
    const previousShipFittingSnapshot =
      options.previousShipFittingSnapshot &&
      this._normalizeInventoryId(
        options.previousShipFittingSnapshot.shipID,
        0,
      ) === fittingShipID
        ? options.previousShipFittingSnapshot
        : null;
    emitFittingTransactionForSession(session, fittingShipID, deduped, {
      dependentModuleAttributeDiffs,
      previousSnapshot: previousShipFittingSnapshot,
    });
    this._refreshBallparkShipPresentation(session, deduped);
    this._refreshBallparkInventoryPresentation(session, deduped);
    return deduped.length;
  }

  _maybeCompleteMaterializedDungeonSitesForSources(session, sourceContainerIDs = []) {
    if (!session || !session._space || !Array.isArray(sourceContainerIDs)) {
      return;
    }
    const scene = runtime.getSceneForSession(session);
    if (!scene) {
      return;
    }
    const nowMs = Date.now();
    for (const containerID of new Set(sourceContainerIDs.map((value) => this._normalizeInventoryId(value, 0)))) {
      if (containerID <= 0) {
        continue;
      }
      dungeonUniverseSiteService.maybeCompleteMaterializedDataRelicSiteForContainerID(
        scene,
        containerID,
        {
          broadcast: true,
          excludedSession: null,
          nowMs,
          session,
        },
      );
    }
  }

  _refreshDockedFittingState(session, changes = []) {
    if (
      !session ||
      !isDockedSession(session) ||
      !Array.isArray(changes) ||
      changes.length === 0
    ) {
      return;
    }

    const activeShipID = this._normalizeInventoryId(
      session.activeShipID || session.shipID || session.shipid,
      0,
    );
    if (activeShipID <= 0) {
      return;
    }

    const touchesFittingState = changes.some((change) => {
      if (!change || !change.item) {
        return false;
      }

      const previousState = change.previousData || change.previousState || {};
      const previousLocationID = this._normalizeInventoryId(
        previousState.locationID,
        0,
      );
      const previousFlagID = this._normalizeInventoryId(
        previousState.flagID,
        0,
      );
      const nextLocationID = this._normalizeInventoryId(
        change.item.locationID,
        0,
      );
      const nextFlagID = this._normalizeInventoryId(
        change.item.flagID,
        0,
      );

      if (
        previousLocationID !== activeShipID &&
        nextLocationID !== activeShipID
      ) {
        return false;
      }

      return (
        isShipFittingFlag(previousFlagID) ||
        isShipFittingFlag(nextFlagID)
      );
    });

    if (!touchesFittingState) {
      return;
    }

    syncShipFittingStateForSession(session, activeShipID, {
      includeOfflineModules: true,
      includeCharges: true,
      emitChargeInventoryRows: false,
    });
  }

  _refreshBallparkShipPresentation(session, changes = []) {
    if (!session || !session._space) {
      return;
    }

    const activeShipID = this._normalizeInventoryId(
      session._space.shipID || this._getShipId(session),
      0,
    );
    if (activeShipID <= 0) {
      return;
    }

    const touchesFittingState = (change) => {
      if (!change) {
        return false;
      }

      const previousLocationID = this._normalizeInventoryId(
        change.previousData && change.previousData.locationID,
        0,
      );
      const previousFlagID = this._normalizeInventoryId(
        change.previousData && change.previousData.flagID,
        0,
      );
      const nextLocationID = this._normalizeInventoryId(
        change.item && change.item.locationID,
        0,
      );
      const nextFlagID = this._normalizeInventoryId(
        change.item && change.item.flagID,
        0,
      );

      if (
        previousLocationID !== activeShipID &&
        nextLocationID !== activeShipID
      ) {
        return false;
      }

      return (
        isShipFittingFlag(previousFlagID) ||
        isShipFittingFlag(nextFlagID)
      );
    };

    if (!changes.some((change) => touchesFittingState(change))) {
      return;
    }

    const scene = runtime.getSceneForSession(session);
    if (!scene) {
      return;
    }

    runtime.refreshShipDerivedState(session, {
      broadcast: true,
    });

    const shipEntity = scene.getEntityByID(activeShipID);
    if (!shipEntity) {
      return;
    }

    scene.broadcastSlimItemChanges([shipEntity]);
  }

  _refreshBallparkInventoryPresentation(session, changes = []) {
    if (!session || !session._space || !Array.isArray(changes) || changes.length === 0) {
      return;
    }

    const scene = runtime.getSceneForSession(session);
    if (!scene) {
      return;
    }

    const affectedEntityIDs = new Set();
    const collectEntityID = (value) => {
      const numericID = this._normalizeInventoryId(value, 0);
      if (numericID <= 0) {
        return;
      }
      const entity = scene.getEntityByID(numericID);
      if (entity && (entity.kind === "container" || entity.kind === "wreck")) {
        affectedEntityIDs.add(numericID);
      }
    };

    for (const change of changes) {
      if (!change) {
        continue;
      }
      collectEntityID(change.item && change.item.itemID);
      collectEntityID(change.item && change.item.locationID);
      collectEntityID(change.previousData && change.previousData.locationID);
    }

    for (const entityID of affectedEntityIDs) {
      const entity = scene.getEntityByID(entityID);
      if (entity && entity.nativeNpcWreck === true) {
        nativeNpcWreckService.refreshNativeWreckRuntimeEntity(
          session._space.systemID,
          entityID,
          { broadcast: true },
        );
      } else if (
        typeof scene.refreshInventoryBackedEntityPresentation === "function"
      ) {
        // The session may be inside an isolated Abyssal scene whose synthetic
        // locationID is not a globally addressable solar-system scene. Refresh
        // the entity through the exact authoritative scene resolved above so
        // Loot All can publish the wreck's isEmpty transition.
        scene.refreshInventoryBackedEntityPresentation(
          entityID,
          { broadcast: true },
        );
      }
    }
  }

  _validateFittingMove(session, shipRecord, item, destination, fittedItemsSnapshot = null) {
    const integratedServiceModuleValidation =
      this._validateIntegratedStructureServiceModuleFit(item, destination);
    if (!integratedServiceModuleValidation.success) {
      return integratedServiceModuleValidation;
    }
    if (
      !shipRecord ||
      !item ||
      !destination ||
      destination.locationID !== shipRecord.itemID ||
      !isShipFittingFlag(destination.flagID)
    ) {
      return { success: true };
    }

    const securityClassValidation =
      this._validateStructureServiceModuleSecurityClass(item, destination);
    if (!securityClassValidation.success) {
      return securityClassValidation;
    }

    const structureReactionValidation =
      this._validateStructureReactionServiceModuleFit(item, destination);
    if (!structureReactionValidation.success) {
      return structureReactionValidation;
    }

    const moonDrillValidation =
      this._validateStructureMoonDrillServiceModuleFit(item, destination);
    if (!moonDrillValidation.success) {
      return moonDrillValidation;
    }

    return validateFitForShip(
      this._getCharacterId(session),
      shipRecord,
      item,
      destination.flagID,
      fittedItemsSnapshot,
    );
  }

  _validateShipBayMove(session, shipRecord, item, destination) {
    if (
      !shipRecord ||
      !item ||
      !destination ||
      destination.locationID !== shipRecord.itemID
    ) {
      return { success: true };
    }

    const destinationFlagID = this._normalizeInventoryId(destination.flagID, 0);
    const rejectItem = (userMessage) => ({
      success: false,
      errorMsg: "SHIP_BAY_ITEM_NOT_ALLOWED",
      userMessage,
    });

    // An assembled hull is its own inventory container. It may enter a ship
    // maintenance bay or fleet hangar, but it cannot become ordinary ship
    // cargo; only the packaged (singleton 0) hull is cargo.
    if (
      destinationFlagID === ITEM_FLAGS.CARGO_HOLD &&
      Number(item.categoryID) === 6 &&
      Number(item.singleton) === 1
    ) {
      return {
        success: false,
        errorMsg: "ASSEMBLED_SHIP_CARGO_NOT_ALLOWED",
      };
    }

    if (destinationFlagID === ITEM_FLAGS.SHIP_HANGAR) {
      const maintenanceBayValidation = validateShipMaintenanceBayItem(
        shipRecord,
        item,
        {
          // V24.01 inventoryrestrictions/common/checks.py:46-47 applies the
          // AllowedInSMACargoHolds type list to everything carried by the ship,
          // including its specialized holds. Fitted modules, rigs, charges,
          // and drones are members of that list and therefore remain attached.
          contents: listContainerItems(null, item.itemID),
        },
      );
      if (maintenanceBayValidation.success) {
        return { success: true };
      }
      if (
        maintenanceBayValidation.errorMsg ===
        "SHIP_MAINTENANCE_BAY_CARGO_RESTRICTED"
      ) {
        return maintenanceBayValidation;
      }
      return {
        success: false,
        // Current direct inventory moves use this retail UserError when the
        // item itself is not eligible for the bay. Cargo-policy failures keep
        // their explanatory notification from the shared validator.
        errorMsg: "NotEnoughCargoSpace",
      };
    }

    if (isFuelBayFlag(destinationFlagID)) {
      return isFuelBayCompatibleItem(item)
        ? { success: true }
        : rejectItem("Only ice products can be placed in the Fuel Bay.");
    }

    if (destinationFlagID === ITEM_FLAGS.DRONE_BAY) {
      return isDroneItemRecord(item)
        ? { success: true }
        : rejectItem("Only drones can be placed in the Drone Bay.");
    }

    if (destinationFlagID === ITEM_FLAGS.FIGHTER_BAY) {
      return isFighterItemRecord(item)
        ? { success: true }
        : rejectItem("Only fighters can be placed in the Fighter Bay.");
    }

    if (isFighterTubeFlag(destinationFlagID)) {
      if (!isFighterItemRecord(item)) {
        return rejectItem("Only fighters can be placed in a Fighter Launch Tube.");
      }

      const destinationOccupants = listContainerItems(
        this._getCharacterId(session),
        shipRecord.itemID,
        destinationFlagID,
      ).filter(
        (existingItem) =>
          Number(existingItem && existingItem.itemID) !== Number(item.itemID),
      );
      if (destinationOccupants.length > 0) {
        return {
          success: false,
          errorMsg: "NotEnoughCargoSpace",
        };
      }

      const occupiedTubeItems = listHostFighterOccupancy(shipRecord.itemID, { excludeItemID: item.itemID });
      if (
        !canLoadFighterTypeIntoHostTube(
          shipRecord.typeID,
          item.typeID,
          destinationFlagID,
          occupiedTubeItems,
        )
      ) {
        return rejectItem("That fighter is not compatible with this Fighter Launch Tube.");
      }

      return { success: true };
    }

    if (destinationFlagID === ITEM_FLAGS.MOBILE_DEPOT_HOLD) {
      const holdCapacity = Number(
        getShipBaseAttributeValue(
          shipRecord.typeID,
          MOBILE_DEPOT_HOLD_CAPACITY_ATTRIBUTE,
        ),
      ) || 0;
      return holdCapacity > 0 && isMobileDepotItemRecord(item)
        ? { success: true }
        : rejectItem("Only Mobile Depots can be placed in the Mobile Depot Hold.");
    }

    if (isGenericSpecialShipHoldFlag(destinationFlagID)) {
      const holdCapacity = getSpecialShipHoldCapacity(
        null,
        shipRecord.typeID,
        destinationFlagID,
        getShipBaseAttributeValue,
      );
      return holdCapacity > 0 &&
        isSpecialShipHoldItemAllowed(item, destinationFlagID) === true
        ? { success: true }
        : rejectItem(getSpecialShipHoldRestrictionMessage(destinationFlagID));
    }

    if (!MINING_SHIP_BAY_FLAGS.includes(destinationFlagID)) {
      return { success: true };
    }

    return isItemTypeAllowedInHoldFlag(item, destinationFlagID)
      ? { success: true }
      : rejectItem({
          [ITEM_FLAGS.GENERAL_MINING_HOLD]:
            "Only ore, ice, and gas can be placed in the Mining Hold.",
          [ITEM_FLAGS.SPECIALIZED_GAS_HOLD]:
            "Only gas can be placed in the Gas Hold.",
          [ITEM_FLAGS.SPECIALIZED_ICE_HOLD]:
            "Only ice can be placed in the Ice Hold.",
          [ITEM_FLAGS.SPECIALIZED_ASTEROID_HOLD]:
            "Only ore can be placed in the Asteroid Hold.",
        }[destinationFlagID] || "That item cannot be placed in this mining hold.");
  }

  _throwShipBayMoveUserError(validation, item) {
    if (validation && validation.errorMsg === "ASSEMBLED_SHIP_CARGO_NOT_ALLOWED") {
      // Screenshot-confirmed title/body. Latest player_messaging/client/
      // dialog_handler.py:87-88 supports this OK/info modal. The native retail
      // key is unverified; never use the capacity-retry key for this refusal.
      throwWrappedUserError("OwnerPopup", {
        title: "Not enough space",
        body: "Assembled ships don't fit in cargo.<br><br>Try repackaging them first.",
      });
    }
    if (validation && validation.userMessage) {
      throwWrappedUserError("CustomNotify", {
        notify: String(validation.userMessage),
      });
    }
    throwWrappedUserError(
      String(validation && validation.errorMsg || "SHIP_BAY_ITEM_NOT_ALLOWED"),
      { type: Number(item && item.typeID) || 0 },
    );
  }

  _validateStructureOwnerBayMove(item, destination) {
    const structure = this._getStructureForOwnerBayDestination(destination);
    if (!structure) {
      return { success: true };
    }

    if (isStructureFuelBayFlag(destination.flagID)) {
      return isStructureFuelBayCompatibleItem(item, structure.typeID)
        ? { success: true }
        : {
            success: false,
            errorMsg: "NotEnoughCargoSpace",
          };
    }

    const destinationFlagID = this._normalizeInventoryId(destination.flagID, 0);
    if (destinationFlagID === ITEM_FLAGS.FIGHTER_BAY) {
      return isFighterItemRecord(item)
        ? { success: true }
        : {
            success: false,
            errorMsg: "NotEnoughFighterBaySpace",
          };
    }

    if (isFighterTubeFlag(destinationFlagID)) {
      if (!isFighterItemRecord(item)) {
        return {
          success: false,
          errorMsg: "NotEnoughFighterBaySpace",
        };
      }

      const structureOwnerID = this._getStructureInventoryOwnerID(structure);
      const destinationOccupants = listContainerItems(
        structureOwnerID,
        structure.structureID,
        destinationFlagID,
      ).filter(
        (existingItem) =>
          Number(existingItem && existingItem.itemID) !== Number(item.itemID),
      );
      if (destinationOccupants.length > 0) {
        return {
          success: false,
          errorMsg: "NotEnoughFighterBaySpace",
        };
      }

      const occupiedTubeItems = listHostFighterOccupancy(structure.structureID, { excludeItemID: item.itemID });
      if (
        !canLoadFighterTypeIntoHostTube(
          structure.typeID,
          item.typeID,
          destinationFlagID,
          occupiedTubeItems,
        )
      ) {
        return {
          success: false,
          errorMsg: "NotEnoughFighterBaySpace",
        };
      }
    }

    return { success: true };
  }

  _validateStructureServiceModuleRemovalAccess(session, item, destination) {
    const sourceFlagID = this._normalizeInventoryId(item && item.flagID, 0);
    const sourceLocationID = this._normalizeInventoryId(item && item.locationID, 0);
    if (!isStructureServiceSlotFlag(sourceFlagID) || sourceLocationID <= 0) {
      return { success: true };
    }

    const destinationFlagID = this._normalizeInventoryId(
      destination && destination.flagID,
      0,
    );
    const destinationLocationID = this._normalizeInventoryId(
      destination && destination.locationID,
      0,
    );
    if (
      isStructureServiceSlotFlag(destinationFlagID) &&
      destinationLocationID === sourceLocationID
    ) {
      return { success: true };
    }

    const structure = this._getStructureForInventoryID(sourceLocationID);
    if (
      structure &&
      !characterCanDisableStructureServiceModule(session, item, structure)
    ) {
      return {
        success: false,
        errorMsg: "CRP_ACCESS_DENIED",
        structureID: sourceLocationID,
      };
    }

    return { success: true };
  }

  _isHighSecurityStructureSystem(structure) {
    const system = worldData.getSolarSystemByID(structure && structure.solarSystemID);
    const security = Number(system && system.security);
    return Number.isFinite(security) && security >= 0.45;
  }

  _getStructureSystemSecurityClass(structure) {
    const system = worldData.getSolarSystemByID(structure && structure.solarSystemID);
    const security = Number(system && system.security);
    if (!Number.isFinite(security)) {
      return SECURITY_CLASS_ZERO_SEC;
    }
    if (security <= 0) {
      return SECURITY_CLASS_ZERO_SEC;
    }
    if (security < 0.45) {
      return SECURITY_CLASS_LOW_SEC;
    }
    return SECURITY_CLASS_HIGH_SEC;
  }

  _validateStructureServiceModuleSecurityClass(item, destination) {
    if (
      !item ||
      !destination ||
      !isStructureServiceSlotFlag(destination.flagID)
    ) {
      return { success: true };
    }

    const structure = this._getStructureForInventoryID(destination.locationID);
    if (!structure) {
      return { success: true };
    }

    const securityClass = this._getStructureSystemSecurityClass(structure);
    const disallowedInEmpire =
      Number(getTypeAttributeValue(item.typeID, ATTRIBUTE_DISALLOW_IN_EMPIRE_SPACE)) > 0;
    if (securityClass >= SECURITY_CLASS_LOW_SEC && disallowedInEmpire) {
      return {
        success: false,
        errorMsg: "MODULE_DISALLOWED_IN_EMPIRE",
      };
    }

    const disallowedInHighSec =
      Number(getTypeAttributeValue(item.typeID, ATTRIBUTE_DISALLOW_IN_HIGH_SEC)) > 0;
    if (securityClass >= SECURITY_CLASS_HIGH_SEC && disallowedInHighSec) {
      return {
        success: false,
        errorMsg: "MODULE_DISALLOWED_IN_HIGHSEC",
      };
    }

    return { success: true };
  }

  _validateStructureReactionServiceModuleFit(item, destination) {
    if (
      !item ||
      !destination ||
      !isStructureServiceSlotFlag(destination.flagID) ||
      !isStructureReactionServiceModuleType(item.typeID)
    ) {
      return { success: true };
    }

    const structure = this._getStructureForInventoryID(destination.locationID);
    if (!structure) {
      return { success: false, errorMsg: "STRUCTURE_NOT_FOUND" };
    }

    if (structure.structureFamily !== STRUCTURE_FAMILY.REFINERY) {
      return {
        success: false,
        errorMsg: "REACTION_MODULE_REQUIRES_REFINERY",
      };
    }

    if (this._isHighSecurityStructureSystem(structure)) {
      return {
        success: false,
        errorMsg: "REACTION_MODULE_BANNED_IN_HIGHSEC",
      };
    }

    return { success: true };
  }

  _validateStructureMoonDrillServiceModuleFit(item, destination) {
    if (
      !item ||
      !destination ||
      !isStructureServiceSlotFlag(destination.flagID) ||
      Number(item.typeID) !== TYPE_STANDUP_MOON_DRILL
    ) {
      return { success: true };
    }

    const structure = this._getStructureForInventoryID(destination.locationID);
    if (!structure) {
      return { success: false, errorMsg: "STRUCTURE_NOT_FOUND" };
    }

    if (structure.structureFamily !== STRUCTURE_FAMILY.REFINERY) {
      return {
        success: false,
        errorMsg: "MOON_DRILL_REQUIRES_REFINERY",
      };
    }

    const devFlags =
      structure.devFlags && typeof structure.devFlags === "object"
        ? structure.devFlags
        : {};
    const verifiedBeaconID = Number(devFlags.moonMiningBeaconID || 0);
    if (
      devFlags.moonMiningLocationVerified !== true ||
      !Number.isFinite(verifiedBeaconID) ||
      verifiedBeaconID <= 0
    ) {
      return {
        success: false,
        errorMsg: "MOON_DRILL_REQUIRES_MOON_MINING_LOCATION",
      };
    }

    return { success: true };
  }

  _validateIntegratedStructureServiceModuleFit(item, destination) {
    if (
      !item ||
      !destination ||
      !INTEGRATED_STRUCTURE_SERVICE_MODULE_TYPE_IDS.has(Number(item.typeID))
    ) {
      return { success: true };
    }

    const sourceStructure = isStructureServiceSlotFlag(item.flagID)
      ? this._getStructureForInventoryID(item.locationID)
      : null;
    if (!isStructureServiceSlotFlag(destination.flagID) &&
        (!sourceStructure || sourceStructure.destroyedAt)) {
      return { success: true };
    }

    return {
      success: false,
      errorMsg: "STRUCTURE_SERVICE_MODULE_IS_INTEGRATED",
    };
  }

  _throwFittingMoveUserError(fitValidation, shipRecord = null, item = null) {
    const errorMsg = String((fitValidation && fitValidation.errorMsg) || "");
    const data =
      fitValidation && fitValidation.data && typeof fitValidation.data === "object"
        ? fitValidation.data
        : {};
    const hostLabel = Number(shipRecord && shipRecord.categoryID) === STRUCTURE_CATEGORY_ID
      ? "structure"
      : "ship";
    if (errorMsg === "REACTION_MODULE_BANNED_IN_HIGHSEC") {
      throwWrappedUserError("CantInHighSecSpace");
    }
    if (errorMsg === "MODULE_DISALLOWED_IN_EMPIRE") {
      throwWrappedUserError("CantInEmpireSpace");
    }
    if (errorMsg === "MODULE_DISALLOWED_IN_HIGHSEC") {
      throwWrappedUserError("CantInHighSecSpace");
    }
    if (errorMsg === "NO_TURRET_HARDPOINTS") {
      throwWrappedUserError("CustomNotify", {
        notify: Number(data.turretHardpoints) > 0
          ? `All turret hardpoints on this ${hostLabel} are already in use.`
          : `This ${hostLabel} has no turret hardpoints.`,
      });
    }
    if (errorMsg === "NO_LAUNCHER_HARDPOINTS") {
      throwWrappedUserError("CustomNotify", {
        notify: Number(data.launcherHardpoints) > 0
          ? `All launcher hardpoints on this ${hostLabel} are already in use.`
          : `This ${hostLabel} has no launcher hardpoints.`,
      });
    }
    if (errorMsg === "SLOT_OCCUPIED") {
      throwWrappedUserError("CustomNotify", {
        notify: "That fitting slot is already occupied.",
      });
    }
    if (errorMsg === "SKILL_REQUIRED") {
      // The client's own refusal of a fit the pilot lacks the skills for:
      // FittingHasSkillPrerequisites ("To fit and use that item requires
      // having learned the following skills: {requiredSkills}"), with what
      // clientDogmaLocation.CheckSkillRequirementsForType gives it when it
      // raises it itself (for a charge): each missing skill as
      // UI/SkillQueue/Skills/SkillNameAndLevel ("{name} : Level {amount}"),
      // the list joined as FormatGenericList joins it, the item's type, and
      // how many. It was a CustomNotify of this server's own words.
      const missing = Array.isArray(data.missingSkills) && data.missingSkills.length > 0
        ? data.missingSkills
        : [{ skillTypeID: data.skillTypeID, requiredLevel: data.requiredLevel }];
      const names = missing.map((requirement) => {
        const skillTypeID = Number(requirement && requirement.skillTypeID) || 0;
        const skillName = String((resolveItemByTypeID(skillTypeID) || {}).name || skillTypeID);
        return `${skillName} : Level ${Number(requirement && requirement.requiredLevel) || 0}`;
      });
      throwWrappedUserError("FittingHasSkillPrerequisites", {
        requiredSkills: names.join(", "),
        item: Number(item && item.typeID) || 0,
        skillCount: names.length,
      });
    }
    if (
      errorMsg === "NO_FITTING_SLOTS_FOR_FAMILY" ||
      errorMsg === "NO_FREE_FITTING_SLOTS_FOR_FAMILY"
    ) {
      const familyLabel = {
        high: "high-power",
        med: "medium-power",
        low: "low-power",
        rig: "rig",
        subsystem: "subsystem",
        service: "service",
      }[String(data.family || "")] || "suitable fitting";
      throwWrappedUserError("CustomNotify", {
        notify: errorMsg === "NO_FITTING_SLOTS_FOR_FAMILY"
          ? `This ${hostLabel} has no ${familyLabel} slots.`
          : `All ${familyLabel} slots on this ${hostLabel} are already occupied.`,
      });
    }
    if (errorMsg === "REACTION_MODULE_REQUIRES_REFINERY") {
      throwWrappedUserError("ModuleFitFailed", {
        moduleName: [
          USER_ERROR_FORMAT_GROUP_ID,
          Number(item && item.groupID) || 0,
        ],
        reason: "",
      });
    }
    if (
      errorMsg === "MOON_DRILL_REQUIRES_REFINERY" ||
      errorMsg === "MOON_DRILL_REQUIRES_MOON_MINING_LOCATION" ||
      errorMsg === "STRUCTURE_SERVICE_MODULE_IS_INTEGRATED" ||
      errorMsg === "INVALID_SHIP_TYPE" ||
      errorMsg === "INVALID_SHIP_GROUP" ||
      errorMsg === "RIG_SIZE_MISMATCH" ||
      errorMsg === "INSUFFICIENT_CALIBRATION"
    ) {
      throwWrappedUserError("ModuleFitFailed", {
        moduleName: [
          USER_ERROR_FORMAT_GROUP_ID,
          Number(item && item.groupID) || 0,
        ],
        reason: "",
      });
    }
    if (errorMsg === "MAX_GROUP_FITTED") {
      const typeRecord = resolveItemByTypeID(item && item.typeID);
      throwWrappedUserError("CantFitTooManyByGroup", {
        ship: Number(data.shipTypeID ?? (shipRecord && shipRecord.typeID)) || 0,
        module: Number(data.moduleTypeID ?? (item && item.typeID)) || 0,
        groupName:
          data.groupName ||
          (item && item.groupName) ||
          (typeRecord && typeRecord.groupName) ||
          "",
        noOfModules: Number(data.noOfModules ?? data.maxGroupFitted) || 0,
        noOfModulesFitted:
          Number(data.noOfModulesFitted ?? data.existingGroupCount) || 0,
      });
    }
    if (errorMsg === "MAX_TYPE_FITTED") {
      throwWrappedUserError("CantFitTooManyByType", {
        ship: Number(data.shipTypeID ?? (shipRecord && shipRecord.typeID)) || 0,
        module: Number(data.moduleTypeID ?? (item && item.typeID)) || 0,
        noOfModules: Number(data.noOfModules ?? data.maxTypeFitted) || 0,
        noOfModulesFitted:
          Number(data.noOfModulesFitted ?? data.existingTypeCount) || 0,
      });
    }
    return false;
  }

  // A MultiAdd that moved nothing must not answer a successful empty response.
  // Raise the UserError Handle_Add raises for whichever condition blocked the
  // first item, and a plain notify for the conditions where Add has none.
  _throwMultiAddZeroMoveUserError(firstSkip) {
    const reason = String((firstSkip && firstSkip.reason) || "");
    const errorMsg = String((firstSkip && firstSkip.errorMsg) || "");
    const item = (firstSkip && firstSkip.item) || null;
    const typeID = Number(item && item.typeID) || 0;

    if (reason === "NO_SUITABLE_DESTINATION") {
      // Handle_Add raises ModuleFitFailed when _resolveDestinationForMove
      // returns nothing.
      throwWrappedUserError("ModuleFitFailed", {
        moduleName: typeID,
        reason: "No suitable slot available",
      });
    }
    if (
      errorMsg &&
      (reason === "SHIP_BAY_REJECTED" || reason === "STRUCTURE_OWNER_BAY_REJECTED")
    ) {
      // Handle_Add raises the validation's own errorMsg for both bay checks.
      if (reason === "SHIP_BAY_REJECTED" && firstSkip.validation) {
        this._throwShipBayMoveUserError(firstSkip.validation, item);
      }
      throwWrappedUserError(errorMsg, { type: typeID });
    }
    if (reason === "UNFIT_CARGO_OVERFLOW" && firstSkip.validation) {
      this._throwUnfitCargoOverflowUserError(firstSkip.validation);
    }

    throwWrappedUserError("CustomNotify", {
      notify: "None of the selected items could be moved.",
    });
  }

  _resolveMovedItemID(moveResult, originalItemID, destination) {
    // An audit-log secure container stores what it is handed at flagLocked or
    // flagUnlocked, so the flag a caller asked for is not the flag the row lands
    // on. _moveSourceItemToDestination applies that rewrite to its own copy of
    // the destination, which left every caller here holding the pre-rewrite flag
    // and comparing a stored 64 against a requested 0 — so Handle_Add answered
    // null for a move into a station container that had plainly succeeded.
    const effectiveDestination =
      this._normalizeAuditContainerMoveDestination(destination);
    const destinationLocationID = this._normalizeInventoryId(
      effectiveDestination && effectiveDestination.locationID,
      0,
    );
    const destinationFlagID = this._normalizeInventoryId(
      effectiveDestination && effectiveDestination.flagID,
      0,
    );

    for (const change of (moveResult && moveResult.data && moveResult.data.changes) || []) {
      if (
        !change ||
        !change.item ||
        Number(change.item.itemID) === Number(originalItemID)
      ) {
        continue;
      }

      if (
        this._normalizeInventoryId(change.item.locationID, 0) === destinationLocationID &&
        this._normalizeInventoryId(change.item.flagID, 0) === destinationFlagID
      ) {
        return Number(change.item.itemID) || null;
      }
    }

    const originalMovedItem = findItemById(
      this._normalizeInventoryId(originalItemID, 0),
    );
    if (
      originalMovedItem &&
      this._normalizeInventoryId(originalMovedItem.locationID, 0) === destinationLocationID &&
      this._normalizeInventoryId(originalMovedItem.flagID, 0) === destinationFlagID
    ) {
      return this._normalizeInventoryId(originalMovedItem.itemID, null);
    }

    return null;
  }

  _getNativeWreckRecord(inventoryID) {
    const numericInventoryID = this._normalizeInventoryId(inventoryID, 0);
    if (numericInventoryID <= 0) {
      return null;
    }

    return nativeNpcStore.getNativeWreck(numericInventoryID) || null;
  }

  _buildNativeWreckItemOverrides(_session, inventoryID) {
    return nativeNpcStore.buildNativeWreckInventoryItem(
      this._normalizeInventoryId(inventoryID, 0),
    );
  }

  // Rigs on ordinary hulls cannot be removed and returned to inventory — the
  // only way to clear one is DestroyFitting, which destroys it. Strategic
  // cruisers (T3) retain their reusable rigs instead: like RepackageItems'
  // canReturnRigs rule, a rig taken off a T3 fit is an ordinary unfit rather
  // than being destroyed. True when the item sits in a rig slot of a hull that
  // keeps the old destroy-only rule.
  _isRigHeldBySlot(item) {
    if (!item || !SLOT_FAMILY_FLAGS.rig.includes(Number(item.flagID))) {
      return false;
    }
    const rigHostShip = findItemById(Number(item.locationID));
    const rigHostShipTypeID = Number(rigHostShip && rigHostShip.typeID) || 0;
    return !isStrategicCruiserType(rigHostShipTypeID);
  }

  _findTransferSourceItem(itemID, sourceLocationID = 0) {
    const numericItemID = this._normalizeInventoryId(itemID, 0);
    if (numericItemID <= 0) {
      return null;
    }

    const inventoryItem = findItemById(numericItemID);
    if (inventoryItem) {
      return {
        sourceKind: "inventory",
        item: inventoryItem,
      };
    }

    const wreckItem = nativeNpcStore.getNativeWreckItem(numericItemID);
    if (!wreckItem) {
      return null;
    }

    const normalizedSourceLocationID = this._normalizeInventoryId(sourceLocationID, 0);
    if (
      normalizedSourceLocationID > 0 &&
      this._normalizeInventoryId(wreckItem.wreckID, 0) !== normalizedSourceLocationID
    ) {
      return null;
    }

    const wreckItemOverrides = nativeNpcStore.buildNativeWreckContents(wreckItem.wreckID)
      .find((entry) => this._normalizeInventoryId(entry && entry.itemID, 0) === numericItemID) || null;
    return {
      sourceKind: "nativeWreck",
      item: wreckItemOverrides,
      wreckItem,
    };
  }

  _isTransferSourceLocationMatch(sourceItemDescriptor, sourceLocationID = 0) {
    const requestedSourceLocationID = this._normalizeInventoryId(sourceLocationID, 0);
    if (requestedSourceLocationID <= 0) {
      return true;
    }

    if (!sourceItemDescriptor) {
      return false;
    }

    if (sourceItemDescriptor.sourceKind !== "inventory") {
      return true;
    }

    const item = sourceItemDescriptor.item;
    const directLocationID = this._normalizeInventoryId(item && item.locationID, 0);
    if (directLocationID === requestedSourceLocationID) {
      return true;
    }

    return this._resolveInventoryRootLocationID(item) === requestedSourceLocationID;
  }

  _resolveInventoryRootLocationID(itemOrItemID) {
    let currentItem =
      itemOrItemID && typeof itemOrItemID === "object"
        ? itemOrItemID
        : this._getSpaceScopeInventoryRecord(
            this._normalizeInventoryId(itemOrItemID, 0),
          );
    const seen = new Set();

    while (currentItem) {
      const currentItemID = this._normalizeInventoryId(currentItem.itemID, 0);
      const locationID = this._normalizeInventoryId(currentItem.locationID, 0);
      if (locationID <= 0) {
        return 0;
      }

      if (seen.has(currentItemID)) {
        return locationID;
      }
      seen.add(currentItemID);

      const parentItem = this._getSpaceScopeInventoryRecord(locationID);
      if (!parentItem) {
        return locationID;
      }
      currentItem = parentItem;
    }

    return 0;
  }

  _canTakeFromCorporationHangarSource(session, sourceItemDescriptor) {
    const item = sourceItemDescriptor && sourceItemDescriptor.item
      ? sourceItemDescriptor.item
      : null;
    if (!item || sourceItemDescriptor.sourceKind !== "inventory") {
      return true;
    }
    // Only a starbase hangar division can sit above this item, so skip the
    // ancestor walk on servers that have no starbase structures at all.
    const starbaseDivisionAncestor = hasStarbaseItems() &&
      this._getInventoryItemAncestorChain(item.itemID).find((ancestor) =>
        Number(ancestor.itemID) !== Number(item.itemID) &&
        this._isCorporationHangarFlag(ancestor.flagID) &&
        isStarbaseCorporateHangarArrayType(findStarbaseItemById(ancestor.locationID)));
    if (starbaseDivisionAncestor) {
      return this._canTakeFromCorporationHangarSource(session, { sourceKind: "inventory", item: starbaseDivisionAncestor });
    }

    const corporationID = this._normalizeInventoryId(this._getCorporationId(session), 0);
    if (corporationID <= 0 || !this._isCorporationHangarFlag(item.flagID)) {
      return true;
    }

    const starbaseCorporateHangar = findStarbaseItemById(
      this._normalizeInventoryId(item.locationID, 0),
    );
    if (
      isStarbaseCorporateHangarArrayType(starbaseCorporateHangar) &&
      this._normalizeInventoryId(starbaseCorporateHangar.ownerID, 0) ===
        corporationID
    ) {
      const roleMask = getCorporationRolesAtLocation(session, 0);
      if ((roleMask & CORP_ROLE_DIRECTOR) === CORP_ROLE_DIRECTOR) return true;
      return canTakeFromCorporationHangarForInventory(
        session,
        corporationID,
        this._normalizeInventoryId(
          starbaseCorporateHangar.spaceState &&
            starbaseCorporateHangar.spaceState.systemID,
          starbaseCorporateHangar.locationID,
        ),
        item.flagID,
      );
    }

    if (this._normalizeInventoryId(item.ownerID, 0) !== corporationID) {
      return true;
    }

    const office = this._getCorporationOfficeForItemLocation(
      session,
      item.locationID,
    );
    if (!office) {
      return false;
    }

    return canTakeFromCorporationHangarForInventory(
      session,
      corporationID,
      this._normalizeInventoryId(office.stationID, office.officeID),
      item.flagID,
    );
  }

  _canTakeFromCorporationHangarSourceAncestry(session, sourceItemDescriptor) {
    const item = sourceItemDescriptor && sourceItemDescriptor.item;
    if (!item) {
      return this._canTakeFromCorporationHangarSource(
        session,
        sourceItemDescriptor,
      );
    }
    const context = this._getCorporationOfficeDivisionAncestorContext(session, item);
    if (context && isStarbaseCorporateHangarArrayType(
      findItemById(context.divisionAncestor.locationID),
    )) {
      // A POS division is not a station office. Its enclosing division still
      // requires Take, while authoritative source checks enforce POS range.
      return this._canTakeFromCorporationHangarSource(session, sourceItemDescriptor);
    }
    if (context) {
      return Boolean(
        context.accessAllowed &&
        canTakeFromCorporationHangarForInventory(
          session,
          context.corporationID,
          context.stationID,
          context.flagID,
        ),
      );
    }
    return this._canTakeFromCorporationHangarSource(
      session,
      sourceItemDescriptor,
    );
  }

  // A pilot only reaches inventory where they are, and only the parts of it
  // the client lets them open. Walk up from where an item sits, or where it is
  // headed, to the location that holds it, and refuse what the client could
  // never have shown this pilot:
  // - a station or structure hangar lists only the pilot's own rows
  //   (invControllers.py StationItems.IsItemHere tests ownerID == charid);
  // - another pilot's ship opens only through its fleet hangar or maintenance
  //   bay (ShipFleetHangar, ShipMaintenanceBay), never its cargo;
  // - structure bays open only while docked in the structure
  //   (StructureContainer.IsInRange) and belong to its owning corporation;
  // - Corp Deliveries needs Accountant or Trader to take and adds Junior
  //   Accountant to view (itemLocking.py _CanTakeFromDeliveries, invWindow.py
  //   StationCorpDeliveries.Open); Capsuleer Deliveries needs Project Manager
  //   (invWindow.py CapsuleerDeliveries.Open); neither accepts drops
  //   (acceptsDrops = False). A Director holds every role.
  // Range, loot rights, secure-container passwords and corporation division
  // roles keep their own checks; this only adds what those never covered.
  // direction is "take" for a move's source, "put" for its destination and
  // "view" for a listing. Returns null when allowed, or the denial.
  _getInventoryCustodyAccessError(session, start, options = {}) {
    const direction = options.direction || "take";
    const characterID = this._normalizeInventoryId(this._getCharacterId(session), 0);
    const corporationID = this._normalizeInventoryId(this._getCorporationId(session), 0);
    const dockedLocationID = this._normalizeInventoryId(this._getStationId(session), 0);
    // The session's own ship is where the pilot is, whichever record names it.
    const sessionShipIDs = new Set(
      [
        this._getShipId(session),
        session && session.activeShipID,
        session && session.shipID,
        session && session.shipid,
        session && session._space && session._space.shipID,
      ]
        .map((shipID) => this._normalizeInventoryId(shipID, 0))
        .filter((shipID) => shipID > 0),
    );
    const systemID = this._normalizeInventoryId(
      session && (
        (session._space && session._space.systemID) ||
        session.solarsystemid2 ||
        session.solarsystemid
      ),
      0,
    );
    const deny = (errorMsg, details = {}) => ({ errorMsg, ...details });
    if (direction === "take" && isFighterItemRecord(start) &&
        Number(start.flagID) === 0 && start.spaceState &&
        Number(start.fighterState?.controllerID) > 0) {
      return deny("FIGHTER_RECALL_REQUIRED", {
        notify: "Recall the fighter squadron to its launch tube before moving it through inventory.",
      });
    }
    let locationID = this._normalizeInventoryId(start && start.locationID, 0);
    let flagID = this._normalizeInventoryId(start && start.flagID, 0);
    let heldItemID = this._normalizeInventoryId(start && start.itemID, 0);
    let heldOwnerID = this._normalizeInventoryId(start && start.ownerID, 0);
    const visited = new Set();

    while (locationID > 0) {
      if (visited.has(locationID) || visited.size >= 64) {
        return deny("INVENTORY_LOCATION_CYCLE");
      }
      visited.add(locationID);

      if (locationID === characterID) {
        return null;
      }

      // The active ship is where the pilot is, docked or in space.
      if (sessionShipIDs.has(locationID)) {
        return null;
      }

      if (this._getPlanetaryCustomsOfficeRecord(locationID)) {
        // Customs office storage is partitioned by depositor.
        return heldItemID > 0 && heldOwnerID !== characterID
          ? deny("CUSTOMS_OFFICE_NOT_DEPOSITOR")
          : null;
      }

      const ship = findShipItemById(locationID);
      if (ship) {
        const shipOwnerID = this._normalizeInventoryId(ship.ownerID, 0);
        const ownShip =
          shipOwnerID === characterID ||
          (corporationID > 0 && shipOwnerID === corporationID);
        if (!ownShip) {
          // Only a fleet hangar or maintenance bay is shared. The ship service
          // check that guards a bay directly keeps its own refusal; anything
          // nested deeper inside the bay is checked here.
          if (!isShipServiceFlag(flagID)) {
            return deny("SHIP_PRIVATE_BAY");
          }
          return visited.size > 1 &&
            this._getShipServiceAccessError(session, locationID, flagID)
            ? deny("SHIP_SERVICE_ACCESS_DENIED")
            : null;
        }
        if (this._isPersistedSpaceInventoryRecord(ship)) {
          // A ship in space answers to the space range and visibility checks.
          return null;
        }
        heldItemID = locationID;
        heldOwnerID = shipOwnerID;
        flagID = this._normalizeInventoryId(ship.flagID, 0);
        locationID = this._normalizeInventoryId(ship.locationID, 0);
        continue;
      }

      const structure = this._getStructureForInventoryID(locationID);
      if (
        structure ||
        locationID === dockedLocationID ||
        worldData.getStationByID(locationID)
      ) {
        if (structure && this._isMoonMaterialBayFlag(flagID)) {
          // The moon material bay opens from space near the drill, under its
          // own access check.
          return null;
        }
        if (locationID !== dockedLocationID) {
          return deny("INVENTORY_LOCATION_REMOTE");
        }
        if (
          flagID === ITEM_FLAGS.CORP_DELIVERIES ||
          flagID === ITEM_FLAGS.CAPSULEER_DELIVERIES
        ) {
          if (direction === "put") {
            return deny("DELIVERIES_NOT_STORAGE", {
              notify: "Deliveries hangars do not accept items.",
            });
          }
          if (heldItemID > 0 && heldOwnerID !== corporationID) {
            return deny("DELIVERIES_NOT_CORPORATION");
          }
          const requiredRoles = flagID === ITEM_FLAGS.CAPSULEER_DELIVERIES
            ? CORP_ROLE_PROJECT_MANAGER
            : direction === "view"
              ? CORP_ROLE_ACCOUNTANT | CORP_ROLE_JUNIOR_ACCOUNTANT | CORP_ROLE_TRADER
              : CORP_ROLE_ACCOUNTANT | CORP_ROLE_TRADER;
          return this._sessionHasCorporationRole(session, requiredRoles)
            ? null
            : deny("DELIVERIES_ROLE_MISSING", { crpAccessDenied: true });
        }
        if (
          structure &&
          (this._isStructureOwnerBayFlag(flagID) || isShipFittingFlag(flagID))
        ) {
          // A pilot controlling the structure was authorized when they took
          // control. Otherwise only a known, different corporation is refused;
          // the fitting and role checks decide the rest.
          const structureOwnerID = this._getStructureInventoryOwnerID(structure);
          return corporationID > 0 &&
            structureOwnerID > 0 &&
            structureOwnerID !== corporationID &&
            !this._isSessionControllingStructure(session, locationID)
            ? deny("STRUCTURE_BAY_NOT_OWNED")
            : null;
        }
        if (
          heldItemID > 0 &&
          heldOwnerID !== characterID &&
          !sessionShipIDs.has(heldItemID)
        ) {
          return deny("INVENTORY_NOT_OWNED");
        }
        return null;
      }

      const office = this._getCorporationOfficeForItemLocation(session, locationID);
      if (office) {
        // The division's roles are the corporation hangar rules' to decide; the
        // office itself has to be where the pilot is docked.
        return this._normalizeInventoryId(office.stationID, 0) === dockedLocationID
          ? null
          : deny("INVENTORY_LOCATION_REMOTE");
      }

      const container = findItemById(locationID);
      if (
        container &&
        planetOrbitalState.isCustomsInventoryOrbitalRecord(container)
      ) {
        // An anchored customs office is an item row on its planet. Its storage is
        // partitioned by depositor, the same as an office with an orbital record.
        return heldItemID > 0 && heldOwnerID !== characterID
          ? deny("CUSTOMS_OFFICE_NOT_DEPOSITOR")
          : null;
      }
      if (container && this._isPersistedSpaceInventoryRecord(container)) {
        if (require("../ship/mobileAnalysisBeaconRuntime").getMobileAnalysisBeaconStateFromItem(container)) {
          if (direction === "put") return deny("CONTAINER_READ_ONLY");
          const errorMsg = this._getSpaceContainerScopeAccessError(session, container.itemID);
          return errorMsg ? deny(errorMsg) : null;
        }
        // Containers, wrecks and deployables in space keep their own range,
        // visibility, room and loot-right checks.
        return null;
      }
      if (container) {
        heldItemID = locationID;
        heldOwnerID = this._normalizeInventoryId(container.ownerID, 0);
        flagID = this._normalizeInventoryId(container.flagID, 0);
        locationID = this._normalizeInventoryId(container.locationID, 0);
        continue;
      }

      if (
        (systemID > 0 && locationID === systemID) ||
        this._getNativeWreckRecord(locationID)
      ) {
        // Anything else in space keeps its own range, visibility and loot
        // checks.
        return null;
      }
      return deny(
        worldData.getSolarSystemByID(locationID)
          ? "INVENTORY_LOCATION_REMOTE"
          : "INVENTORY_LOCATION_UNKNOWN",
      );
    }

    return deny("INVENTORY_LOCATION_UNKNOWN");
  }

  // Control is the session's own state: its structure and its ship are both the
  // structure. It lapses the moment the pilot releases control.
  _isSessionControllingStructure(session, structureID) {
    const numericStructureID = this._normalizeInventoryId(structureID, 0);
    return (
      numericStructureID > 0 &&
      this._normalizeInventoryId(
        session && (session.structureID || session.structureid),
        0,
      ) === numericStructureID &&
      this._normalizeInventoryId(
        session && (session.shipID || session.shipid),
        0,
      ) === numericStructureID
    );
  }

  _sessionHasCorporationRole(session, requiredRoleMask) {
    const roleMask = this._getSessionCorpRoleMask(session);
    return (
      (roleMask & CORP_ROLE_DIRECTOR) === CORP_ROLE_DIRECTOR ||
      (roleMask & requiredRoleMask) !== 0n
    );
  }

  // Throws the refusal the client expects when a move's source or destination
  // is outside what this pilot may reach. Native wreck loot is not inventory
  // yet and keeps its own loot rules.
  _ensureInventoryCustodyTransferAccess(session, sourceItemDescriptor, destination) {
    if (!sourceItemDescriptor || sourceItemDescriptor.sourceKind !== "inventory") {
      return;
    }
    const sourceItem = sourceItemDescriptor.item;
    const denial =
      this._getInventoryCustodyAccessError(session, sourceItem, {
        direction: "take",
      }) ||
      this._getInventoryCustodyAccessError(
        session,
        {
          locationID: destination && destination.locationID,
          flagID: destination && destination.flagID,
        },
        { direction: "put" },
      );
    if (!denial) {
      return;
    }
    log.debug(
      "[InvBroker] Move refused itemID=" +
        this._normalizeInventoryId(sourceItem && sourceItem.itemID, 0) +
        " source=" + (sourceItem && sourceItem.locationID) + ":" +
        (sourceItem && sourceItem.flagID) +
        " destination=" + (destination && destination.locationID) + ":" +
        (destination && destination.flagID) +
        " error=" + denial.errorMsg,
    );
    if (denial.crpAccessDenied) {
      throwWrappedUserError(
        "CrpAccessDenied",
        buildCrpAccessDeniedInsufficientRolesValues(),
      );
    }
    if (denial.notify) {
      throwWrappedUserError("CustomNotify", { notify: denial.notify });
    }
    throwWrappedUserError("FakeItemNotFound");
  }

  _canBatchOrdinaryCargoMove(sourceItemDescriptor, destination) {
    const item = sourceItemDescriptor && sourceItemDescriptor.item;
    if (!item || sourceItemDescriptor.sourceKind !== "inventory" || !destination) return false;
    destination = this._normalizeAuditContainerMoveDestination(destination);
    const sourceFlag = this._normalizeInventoryId(item.flagID, 0);
    const destinationFlag = this._normalizeInventoryId(destination.flagID, 0);
    // These paths publish or persist dependent state before the batch finalizer.
    // Keep their existing fences, including native wreck source retirement.
    return Number(item.categoryID) !== 6 &&
      !isShipFittingFlag(sourceFlag) && !isShipFittingFlag(destinationFlag) &&
      !isStructureServiceSlotFlag(sourceFlag) && !isStructureServiceSlotFlag(destinationFlag) &&
      destinationFlag !== ITEM_FLAGS.LOCKED &&
      !this._isStructureCoreInstallMove(item, destination);
  }

  _flushInventoryMoveBatchOrThrow(result) {
    if (result && result.success) return;
    log.warn(`[InvBroker] inventory move batch could not become durable: ${result && result.errorMsg || "FLUSH_ERROR"}`);
    throwWrappedUserError("CustomNotify", {
      notify: "Unable to durably save the inventory transfer. Please retry or refresh your inventory.",
    });
  }

  _moveSourceItemToDestination(session, sourceItemDescriptor, destination, quantity = null, inventoryMoveBatch = undefined) {
    if (!sourceItemDescriptor || !sourceItemDescriptor.item || !destination) {
      return {
        success: false,
        errorMsg: "ITEM_NOT_FOUND",
      };
    }

    destination = this._normalizeAuditContainerMoveDestination(destination);
    const sourceItem = sourceItemDescriptor.item;
    const rescueSource = getRescueDestination(session, findItemById(sourceItem.locationID));
    if (rescueSource && sourceItem.typeID === rescueSource.policy.typeID) {
      return { success: false, errorMsg: "RESCUE_CARGO_DELIVERED" };
    }
    if (isDirectSpaceUnanchoredStructureHullInventoryRecord(sourceItem)) {
      return {
        success: false,
        errorMsg: "UNANCHORED_STRUCTURE_HULL_REQUIRES_SCOOP",
      };
    }
    if (this._getPendingStructureUnanchorContainerAncestor(sourceItem)) {
      return {
        success: false,
        errorMsg: "STRUCTURE_UNANCHOR_CONTAINER_PENDING",
      };
    }
    if (
      this._isPendingStructureUnanchorContainerInventoryID(
        destination.locationID,
      )
    ) {
      return {
        success: false,
        errorMsg: "STRUCTURE_UNANCHOR_CONTAINER_PENDING",
      };
    }
    this._ensureItemMoveInvariant(sourceItemDescriptor, destination);
    this._ensureSecureContainerTransferAccess(
      session,
      sourceItem,
      destination,
    );
    this._ensureInventoryCustodyTransferAccess(
      session,
      sourceItemDescriptor,
      destination,
    );
    const groupingContext = {
      shipID: this._normalizeInventoryId(sourceItem.locationID, 0),
      moduleID: this._normalizeInventoryId(sourceItem.itemID, 0),
      wasGrouped:
        Number(sourceItem.categoryID) === 7 &&
        isShipFittingFlag(sourceItem.flagID) &&
        getWeaponBankMasterModuleID(
          this._normalizeInventoryId(sourceItem.locationID, 0),
          this._normalizeInventoryId(sourceItem.itemID, 0),
        ) > 0,
    };

    const rescueDestination = getRescueDestination(session, findItemById(destination.locationID));
    const isRescueCargo = rescueDestination && sourceItem.typeID === rescueDestination.policy.typeID;
    // A native wreck transfers to the pilot, so it cannot hand over: loot to the ship first.
    if (isRescueCargo && sourceItemDescriptor.sourceKind === "nativeWreck") {
      throwWrappedUserError("CustomNotify", { notify: "Loot this cargo into your ship first, then hand it over." });
    }
    if (isRescueCargo) {
      // Final read after existing access/custody checks; zero must never reach
      // an item owner where it could be interpreted as a whole-stack request.
      quantity = limitRescueCargoQuantity(rescueDestination, sourceItem, quantity);
      if (quantity <= 0) return { success: false, errorMsg: "RESCUE_CARGO_QUANTITY_SATISFIED" };
    }
    if (sourceItemDescriptor.sourceKind === "nativeWreck") {
      return this._recordAuditContainerAutoLockMove(
        session,
        destination,
        nativeNpcWreckService.transferNativeWreckItemToCharacterLocation({
          characterID: this._getCharacterId(session),
          wreckID: this._normalizeInventoryId(
            sourceItemDescriptor.wreckItem && sourceItemDescriptor.wreckItem.wreckID,
            0,
          ),
          wreckItemID: this._normalizeInventoryId(
            sourceItemDescriptor.wreckItem && sourceItemDescriptor.wreckItem.wreckItemID,
            0,
          ),
          destinationLocationID: this._normalizeInventoryId(destination.locationID, 0),
          destinationFlagID: this._normalizeInventoryId(destination.flagID, ITEM_FLAGS.HANGAR),
          quantity,
        }),
      );
    }

    const moveInventoryItem = (
      destinationOwnerID,
      destinationLocationID,
      destinationFlagID,
    ) => (
      Number(destinationOwnerID) === Number(sourceItem.ownerID)
        ? invBrokerItemCustody.moveItem({
            item: sourceItem,
            ownerID: destinationOwnerID,
            locationID: destinationLocationID,
            flagID: destinationFlagID,
            quantity,
            actor: this._getCharacterId(session),
            inventoryMoveBatch,
          })
        : deliveryItemCustody.transferItem({
            item: sourceItem,
            ownerID: destinationOwnerID,
            locationID: destinationLocationID,
            flagID: destinationFlagID,
            quantity,
            actor: this._getCharacterId(session),
            inventoryMoveBatch,
            reason: itemCustody.CUSTODY_REASON.INV_BROKER_OWNER_TRANSFER,
            idempotencyKey: buildOwnerTransferIdempotencyKey(),
          })
    );

    const corporationDestinationContext =
      this._getCorporationOfficeDivisionDestinationContext(session, destination);
    if (corporationDestinationContext && corporationDestinationContext.accessAllowed) {
      const transferResult = moveInventoryItem(
        corporationDestinationContext.corporationID,
        this._normalizeInventoryId(destination.locationID, 0),
        destination.flagID,
      );
      return this._recordAuditContainerAutoLockMove(
        session,
        destination,
        this._applyModuleGroupingMoveCleanup(
          session,
          sourceItemDescriptor,
          destination,
          transferResult,
          groupingContext,
        ),
      );
    }

    if (isRescueCargo) {
      return moveInventoryItem(rescueDestination.item.ownerID, destination.locationID, 0);
    }
    const starbaseCorporateHangarDestination = findItemById(
      this._normalizeInventoryId(destination.locationID, 0),
    );
    if (starbaseInventoryRuntime.isBatteryAmmoInventory(starbaseCorporateHangarDestination) ||
        starbaseProcessingInventory.isProcessingStorage(starbaseCorporateHangarDestination) ||
        starbaseInventoryRuntime.isTowerBay(starbaseCorporateHangarDestination)) {
      return moveInventoryItem(starbaseCorporateHangarDestination.ownerID,
        starbaseCorporateHangarDestination.itemID, destination.flagID);
    }
    if (
      isStarbaseCorporateHangarArrayType(starbaseCorporateHangarDestination) &&
      CORP_HANGAR_QUERY_ROLE_BY_FLAG.has(
        this._normalizeInventoryId(destination.flagID, 0),
      ) &&
      this._normalizeInventoryId(starbaseCorporateHangarDestination.ownerID, 0) ===
        this._normalizeInventoryId(this._getCorporationId(session), 0)
    ) {
      const transferResult = moveInventoryItem(
        starbaseCorporateHangarDestination.ownerID,
        starbaseCorporateHangarDestination.itemID,
        destination.flagID,
      );
      return this._recordAuditContainerAutoLockMove(
        session,
        destination,
        this._applyModuleGroupingMoveCleanup(
          session,
          sourceItemDescriptor,
          destination,
          transferResult,
          groupingContext,
        ),
      );
    }

    const structureDestination = this._getStructureForOwnerBayDestination(destination);
    const structureOwnerID = this._getStructureInventoryOwnerID(structureDestination);
    if (structureDestination && structureOwnerID > 0) {
      const transferResult = moveInventoryItem(
        structureOwnerID,
        this._normalizeInventoryId(structureDestination.structureID, 0),
        destination.flagID,
      );
      return this._recordAuditContainerAutoLockMove(
        session,
        destination,
        this._applyModuleGroupingMoveCleanup(
          session,
          sourceItemDescriptor,
          destination,
          transferResult,
          groupingContext,
        ),
      );
    }

    const shipDestinationOwnerID = this._resolveInventoryItemShipDestinationOwnerID(
      session,
      sourceItemDescriptor,
      destination,
    );
    if (shipDestinationOwnerID > 0) {
      const transferResult = moveInventoryItem(
        shipDestinationOwnerID,
        this._normalizeInventoryId(destination.locationID, 0),
        destination.flagID,
      );
      return this._recordAuditContainerAutoLockMove(
        session,
        destination,
        this._applyModuleGroupingMoveCleanup(
          session,
          sourceItemDescriptor,
          destination,
          transferResult,
          groupingContext,
        ),
      );
    }

    if (
      this._shouldTransferInventoryItemToCharacterOwnedDestination(
        session,
        sourceItemDescriptor,
        destination,
      )
    ) {
      const transferResult = moveInventoryItem(
        this._getCharacterId(session),
        this._normalizeInventoryId(destination.locationID, 0),
        destination.flagID,
      );
      return this._recordAuditContainerAutoLockMove(
        session,
        destination,
        this._applyModuleGroupingMoveCleanup(
          session,
          sourceItemDescriptor,
          destination,
          transferResult,
          groupingContext,
        ),
      );
    }

    const moveResult = moveInventoryItem(
      sourceItem.ownerID,
      destination.locationID,
      destination.flagID,
    );
    this._moveAttachedLoadedChargeWithModule(
      session,
      sourceItemDescriptor.item,
      destination,
      moveResult,
    );
    return this._recordAuditContainerAutoLockMove(
      session,
      destination,
      this._applyModuleGroupingMoveCleanup(
        session,
        sourceItemDescriptor,
        destination,
        moveResult,
        groupingContext,
      ),
    );
  }

  // Taking from a corporation hangar division hands property over, it does not
  // lend it: whatever a pilot is allowed to pull out of a division and put in
  // their own space becomes theirs. The take is already decided above —
  // _canTakeFromCorporationHangarSource throws CrpAccessDenied when the roles do
  // not allow it — and that decision is the whole of the authority, so this only
  // has to recognise a corporation-division source and a destination the
  // character owns.
  //
  // "Their own space" is the personal hangar (the station or structure
  // inventory itself) and any container the character owns. It used to be the
  // personal hangar alone, so 4,812 Zydrine dragged from division 1 straight
  // into a personally owned Station Warehouse Container went on owning the
  // corporation (docs/ErrorWatch/2026-08-10T13-24-16-114Z.md), and no later
  // drag could heal it either: once the item sits in the container its source is
  // no longer a division, so this predicate never fires again.
  //
  // Ship destinations are deliberately absent: _resolveInventoryItemShipDestinationOwnerID
  // runs before this and already re-owns anything landing in a bay or a fitting
  // slot. The reverse direction is untouched too — a personally owned item moved
  // into a division is claimed by the corporation-office branch above, which runs
  // first.
  _shouldTransferInventoryItemToCharacterOwnedDestination(session, sourceItemDescriptor, destination) {
    const sourceItem = sourceItemDescriptor && sourceItemDescriptor.item
      ? sourceItemDescriptor.item
      : null;
    if (
      !sourceItem ||
      !destination ||
      sourceItemDescriptor.sourceKind !== "inventory"
    ) {
      return false;
    }

    const characterID = this._getCharacterId(session);
    const destinationLocationID = this._normalizeInventoryId(destination.locationID, 0);
    if (
      characterID <= 0 ||
      destinationLocationID <= 0 ||
      this._normalizeInventoryId(sourceItem.ownerID, 0) === characterID
    ) {
      return false;
    }

    if (
      this._shouldTransferControlledStructureOwnerBayItemToPersonalHangar(
        session,
        sourceItem,
        destination,
      )
    ) {
      return true;
    }
    // Neutral factory stock is acquired by the pilot when looted, including
    // directly into a nearby jetcan. Earlier destination branches retain the
    // ownership rules for corporation bays and other pilots' ship holds.
    if (sourceItem.typeID === 3501 && incursionFactoryCustody.isFactory(findItemById(sourceItem.locationID))) return true;
    if (starbaseInventoryRuntime.isBatteryAmmoInventory(findItemById(sourceItem.locationID)) ||
        starbaseProcessingInventory.isProcessingStorage(findItemById(sourceItem.locationID)) ||
        starbaseInventoryRuntime.isTowerBay(findItemById(sourceItem.locationID))) {
      return this._isCharacterOwnedMoveDestination(session, destination);
    }

    // Resolve the enclosing division, not just the item's own slot: a stack
    // inside a container parked in a division sits at the container with flag
    // 0, and the take check already walks up to the division to authorize it.
    const divisionContext =
      this._getCorporationOfficeDivisionAncestorContext(session, sourceItem);
    const corporationDivisionSource = Boolean(
      divisionContext && divisionContext.accessAllowed
    );
    // Corp and Capsuleer Deliveries hand property over the same way; the take
    // itself was authorized by the custody check.
    const corporationDeliveriesSource = Boolean(
      [ITEM_FLAGS.CORP_DELIVERIES, ITEM_FLAGS.CAPSULEER_DELIVERIES].includes(
        this._normalizeInventoryId(sourceItem.flagID, 0),
      ) &&
      this._normalizeInventoryId(sourceItem.ownerID, 0) ===
        this._normalizeInventoryId(this._getCorporationId(session), 0) &&
      this._normalizeInventoryId(sourceItem.locationID, 0) ===
        this._normalizeInventoryId(this._getStationId(session), 0)
    );
    if (!corporationDivisionSource && !corporationDeliveriesSource) {
      return false;
    }

    return this._isCharacterOwnedMoveDestination(session, destination);
  }

  _shouldTransferControlledStructureOwnerBayItemToPersonalHangar(
    session,
    sourceItem,
    destination,
  ) {
    const destinationLocationID = this._normalizeInventoryId(
      destination && destination.locationID,
      0,
    );
    if (
      this._normalizeInventoryId(destination && destination.flagID, 0) !==
        ITEM_FLAGS.HANGAR ||
      this._normalizeInventoryId(sourceItem && sourceItem.locationID, 0) !==
        destinationLocationID ||
      !this._isStructureOwnerBayFlag(sourceItem && sourceItem.flagID) ||
      !this._isControlledStructureInventoryID(session, destinationLocationID)
    ) {
      return false;
    }

    const structure = this._getStructureForInventoryID(destinationLocationID);
    return (
      this._normalizeInventoryId(sourceItem && sourceItem.ownerID, 0) ===
      this._getStructureInventoryOwnerID(structure)
    );
  }

  _isCharacterOwnedMoveDestination(session, destination) {
    const characterID = this._getCharacterId(session);
    const destinationLocationID = this._normalizeInventoryId(
      destination && destination.locationID,
      0,
    );
    const destinationFlagID = this._normalizeInventoryId(
      destination && destination.flagID,
      0,
    );
    if (characterID <= 0 || destinationLocationID <= 0) {
      return false;
    }

    if (
      destinationFlagID === ITEM_FLAGS.HANGAR &&
      (
        destinationLocationID === this._getStationId(session) ||
        Boolean(this._getStructureForInventoryID(destinationLocationID))
      )
    ) {
      return true;
    }

    const destinationRecord = findItemById(destinationLocationID);
    if (
      !destinationRecord ||
      this._normalizeInventoryId(destinationRecord.ownerID, 0) !== characterID
    ) {
      return false;
    }

    // A container the character happens to own but that is parked inside the
    // corporation's own hangar division is the corporation's space, not theirs.
    // The deposit rule above gives the corporation everything placed in a
    // division, and re-owning through a container left sitting there would undo
    // it without the item ever leaving the division.
    return !this._getInventoryItemAncestorChain(destinationLocationID).some(
      (ancestor) =>
        this._isCorporationHangarFlag(ancestor && ancestor.flagID) &&
        Boolean(
          this._getCorporationOfficeForItemLocation(
            session,
            ancestor && ancestor.locationID,
          ),
        ),
    );
  }

  // The fleet hangar is the one ship bay retail hands over wholesale. A pilot
  // who does not own the ship may deposit into it under
  // FleetHangar_Allow{Fleet,Corp}Access, and the client addresses that
  // destination slot with the container's ownerID rather than session.charid —
  // invControllers.py:516 uses session.charid only for flag 4 and
  // self.GetOwnerID() (the ship's owner) for every other bay — then warns the
  // depositor the move is one way, the same warning it raises for a corp hangar
  // deposit where ownership plainly changes hands (invControllers.py:1597,
  // which triggers precisely on flagFleetHangar with ownerID != session.charid).
  // The Ship Maintenance Bay is deliberately excluded: a ship ferried in a
  // carrier stays its owner's, and the client's one-way warning never names
  // flag 90.
  _isGuestShipServiceOwnershipDestination(session, destinationShipID, destinationFlagID) {
    return (
      this._normalizeInventoryId(destinationFlagID, 0) === ITEM_FLAGS.FLEET_HANGAR &&
      !this._getShipServiceAccessError(
        session,
        destinationShipID,
        destinationFlagID,
      )
    );
  }

  // Resolves the owner an item lands under once it reaches a ship bay, or 0 when
  // the move leaves ownership alone. The caller routes a non-zero result through
  // moveInventoryItem, which mints a per-operation owner-transfer idempotency key
  // whenever the destination owner differs from the source owner.
  _resolveInventoryItemShipDestinationOwnerID(session, sourceItemDescriptor, destination) {
    const sourceItem = sourceItemDescriptor && sourceItemDescriptor.item
      ? sourceItemDescriptor.item
      : null;
    if (
      !sourceItem ||
      !destination ||
      sourceItemDescriptor.sourceKind !== "inventory"
    ) {
      return 0;
    }

    const characterID = this._getCharacterId(session);
    const destinationLocationID = this._normalizeInventoryId(destination.locationID, 0);
    const destinationFlagID = this._normalizeInventoryId(destination.flagID, 0);
    if (
      characterID <= 0 ||
      destinationLocationID <= 0 ||
      (!SHIP_BAY_FLAGS.has(destinationFlagID) && !isShipFittingFlag(destinationFlagID))
    ) {
      return 0;
    }

    const destinationShip = findShipItemById(destinationLocationID);
    const destinationShipOwnerID = this._normalizeInventoryId(
      destinationShip && destinationShip.ownerID,
      0,
    );
    if (destinationShipOwnerID <= 0) {
      return 0;
    }
    if (
      destinationShipOwnerID !== characterID &&
      !this._isGuestShipServiceOwnershipDestination(
        session,
        destinationLocationID,
        destinationFlagID,
      )
    ) {
      return 0;
    }

    return this._normalizeInventoryId(sourceItem.ownerID, 0) === destinationShipOwnerID
      ? 0
      : destinationShipOwnerID;
  }

  _moveAttachedLoadedChargeWithModule(session, sourceItem, destination, moveResult) {
    if (
      !moveResult ||
      !moveResult.success ||
      !sourceItem ||
      !destination ||
      Number(sourceItem.categoryID) !== 7
    ) {
      return;
    }

    const sourceShipID = this._normalizeInventoryId(sourceItem.locationID, 0);
    const sourceFlagID = this._normalizeInventoryId(sourceItem.flagID, 0);
    if (sourceShipID <= 0 || !isShipFittingFlag(sourceFlagID)) {
      return;
    }

    const destinationLocationID = this._normalizeInventoryId(destination.locationID, 0);
    const destinationFlagID = this._normalizeInventoryId(destination.flagID, 0);
    if (destinationLocationID === sourceShipID && destinationFlagID === sourceFlagID) {
      return;
    }

    const loadedCharge = getLoadedChargeByFlag(
      this._getCharacterId(session),
      sourceShipID,
      sourceFlagID,
    );
    if (!loadedCharge) {
      return;
    }

    const chargeMoveResult = invBrokerItemCustody.moveItem({
      item: loadedCharge,
      locationID: destinationLocationID,
      flagID: destinationFlagID,
      actor: this._getCharacterId(session),
    });
    if (!chargeMoveResult || !chargeMoveResult.success) {
      log.warn(
        `[InvBroker] Failed to move attached charge itemID=${loadedCharge.itemID} ` +
        `moduleID=${sourceItem.itemID} destination=${destinationLocationID}:${destinationFlagID} ` +
        `error=${chargeMoveResult && chargeMoveResult.errorMsg || "UNKNOWN"}`,
      );
      return;
    }

    if (!moveResult.data) {
      moveResult.data = {};
    }
    if (!Array.isArray(moveResult.data.changes)) {
      moveResult.data.changes = [];
    }
    moveResult.data.changes.push(
      ...((chargeMoveResult.data && chargeMoveResult.data.changes) || []),
    );
  }

  _applyModuleGroupingMoveCleanup(
    session,
    sourceItemDescriptor,
    destination,
    moveResult,
    groupingContext = null,
  ) {
    if (
      !moveResult ||
      !moveResult.success ||
      !sourceItemDescriptor ||
      !sourceItemDescriptor.item
    ) {
      return moveResult;
    }

    const sourceItem = sourceItemDescriptor.item;
    const sourceShipID = this._normalizeInventoryId(sourceItem.locationID, 0);
    const sourceFlagID = this._normalizeInventoryId(sourceItem.flagID, 0);
    const destinationLocationID = this._normalizeInventoryId(destination.locationID, 0);
    const destinationFlagID = this._normalizeInventoryId(destination.flagID, 0);
    const movedOutOfShipFitting =
      Number(sourceItem.categoryID) === 7 &&
      isShipFittingFlag(sourceFlagID) &&
      (
        destinationLocationID !== sourceShipID ||
        !isShipFittingFlag(destinationFlagID)
      );
    if (!movedOutOfShipFitting) {
      return moveResult;
    }

    clearModuleFromBanksAndNotify(
      session,
      sourceShipID,
      [sourceItem.itemID],
      {
        characterID: this._getCharacterId(session),
      },
    );
    if (groupingContext && groupingContext.wasGrouped) {
      notifyWeaponBanksChanged(
        session,
        groupingContext.shipID,
        getShipWeaponBanks(groupingContext.shipID, {
          characterID: this._getCharacterId(session),
        }),
      );
    }
    return moveResult;
  }

  _buildCharacterItemOverrides(session) {
    const charId = this._getCharacterId(session);
    return {
      itemID: charId,
      typeID: CHARACTER_TYPE_ID,
      ownerID: charId,
      locationID: this._getShipId(session) || this._getStationId(session),
      flagID: 0,
      quantity: -1,
      groupID: CHARACTER_GROUP_ID,
      categoryID: CHARACTER_CATEGORY_ID,
      customInfo: "",
      singleton: 1,
      stacksize: 1,
    };
  }

  _findCharacterSkillRecord(session, itemID) {
    const charId = this._getCharacterId(session);
    const numericItemId = this._normalizeInventoryId(itemID, 0);
    if (numericItemId <= 0) {
      return null;
    }

    return (
      getCharacterSkills(charId).find((skill) => skill.itemID === numericItemId) ||
      null
    );
  }

  _buildSkillItemOverrides(skillRecord) {
    if (!skillRecord) {
      return null;
    }

    return {
      itemID: skillRecord.itemID,
      typeID: skillRecord.typeID,
      ownerID: skillRecord.ownerID,
      locationID: skillRecord.locationID,
      flagID: skillRecord.flagID ?? SKILL_FLAG_ID,
      quantity: -1,
      groupID: skillRecord.groupID,
      categoryID: skillRecord.categoryID,
      customInfo: "",
      singleton: 1,
      stacksize: 1,
    };
  }

  _sanitizeSecureContainerClientItem(itemRecord, typeSource = itemRecord) {
    if (!itemRecord || typeof itemRecord !== "object") {
      return itemRecord;
    }
    if (!isSecureCargoContainerType(typeSource)) {
      return itemRecord;
    }
    const clientItem = { ...itemRecord };
    clientItem.customInfo = stripLegacySecureContainerStateFromCustomInfo(
      itemRecord.customInfo,
    );
    delete clientItem.secureContainerState;
    return clientItem;
  }

  _sanitizeSecureContainerClientChange(change) {
    if (!change || !change.item) {
      return null;
    }
    const sanitized = {
      ...change,
      item: this._sanitizeSecureContainerClientItem(change.item),
    };
    if (change.previousData && typeof change.previousData === "object") {
      sanitized.previousData = this._sanitizeSecureContainerClientItem(
        change.previousData,
        change.item,
      );
    }
    if (change.previousState && typeof change.previousState === "object") {
      sanitized.previousState = this._sanitizeSecureContainerClientItem(
        change.previousState,
        change.item,
      );
    }
    return sanitized;
  }

  _buildInventoryItemOverrides(session, itemRecord) {
    if (!itemRecord || typeof itemRecord !== "object") {
      return null;
    }

    // A skill in the character's brain (flagSkill, as skillState.buildSkillRecord keeps it) is listed as the client
    // has it: one assembled item. A skill book in a hangar, a hold or a container is an item like any other, a stack
    // of as many as it holds (itemCheckers.IsSkillBook is its category alone; IsStacked, stacksize > 1, offers its
    // Split Stack).
    if (
      Number(itemRecord.categoryID) === 16 &&
      Number(itemRecord.flagID ?? SKILL_FLAG_ID) === SKILL_FLAG_ID
    ) {
      return this._buildSkillItemOverrides(itemRecord);
    }
    const clientItemRecord = this._sanitizeSecureContainerClientItem(
      itemRecord,
    );

    const rawItemID = itemRecord.itemID ?? itemRecord.shipID;
    const itemID = this._isChargeTupleItemID(rawItemID)
      ? rawItemID.map((entry) => this._normalizeInventoryId(entry, 0))
      : this._normalizeInventoryId(rawItemID, 0);
    const typeID = this._normalizeInventoryId(
      itemRecord.typeID ?? itemRecord.shipTypeID,
      0,
    );
    if (
      (
        Array.isArray(itemID)
          ? !this._isChargeTupleItemID(itemID)
          : itemID <= 0
      ) ||
      typeID <= 0
    ) {
      return null;
    }

    const singleton =
      itemRecord.singleton === null || itemRecord.singleton === undefined
        ? Number(itemRecord.categoryID) === 6
          ? 1
          : 0
        : itemRecord.singleton;
    const quantity =
      itemRecord.quantity === null || itemRecord.quantity === undefined
        ? Number(singleton) === 1
            ? -1
            : 1
        : itemRecord.quantity;
    const stacksize =
      itemRecord.stacksize === null || itemRecord.stacksize === undefined
        ? Number(singleton) === 1
          ? 1
          : quantity
        : itemRecord.stacksize;

    return {
      itemID,
      typeID,
      shipName: itemRecord.shipName || itemRecord.itemName || null,
      ownerID: this._normalizeInventoryId(
        itemRecord.ownerID,
        this._getCharacterId(session),
      ),
      locationID: this._normalizeInventoryId(
        itemRecord.locationID,
        this._getStationId(session),
      ),
      flagID: this._normalizeInventoryId(itemRecord.flagID, 0),
      quantity,
      groupID: this._normalizeInventoryId(itemRecord.groupID, 0),
      categoryID: this._normalizeInventoryId(itemRecord.categoryID, 0),
      customInfo:
        clientItemRecord.customInfo === undefined
          ? ""
          : clientItemRecord.customInfo,
      singleton,
      stacksize,
    };
  }

  _buildStationItemOverrides(session, overrideStationID = null) {
    const station = getStationRecord(session, overrideStationID);
    const stationID = this._normalizeInventoryId(station.stationID, this._getStationId(session));
    return {
      itemID: stationID,
      typeID: this._normalizeInventoryId(station.stationTypeID, STATION_TYPE_ID),
      ownerID: this._normalizeInventoryId(
        station.ownerID || station.corporationID,
        STATION_OWNER_ID,
      ),
      locationID: stationID,
      flagID: 0,
      quantity: 1,
      groupID: STATION_GROUP_ID,
      categoryID: STATION_CATEGORY_ID,
      customInfo: "",
      singleton: 1,
      stacksize: 1,
    };
  }

  _buildStructureItemOverrides(session, overrideStructureID = null) {
    const structureID = this._normalizeInventoryId(
      overrideStructureID ?? this._getStationId(session),
      0,
    );
    if (structureID <= 0) {
      return null;
    }

    const structure = structureState.getStructureByID(structureID, {
      refresh: false,
    });
    if (!structure) {
      return null;
    }

    const structureTypeID = this._normalizeInventoryId(structure.typeID, 0);
    const structureType = resolveItemByTypeID(structureTypeID) || {};
    const solarSystemID = this._normalizeInventoryId(
      structure.solarSystemID ??
        structure.solarsystemID ??
        (session && (session.solarsystemid2 ?? session.solarsystemid)),
      0,
    );
    return {
      itemID: this._normalizeInventoryId(structure.structureID, structureID),
      typeID: structureTypeID,
      ownerID: this._normalizeInventoryId(
        structure.ownerCorpID || structure.ownerID,
        this._getCharacterId(session),
      ),
      locationID: this._normalizeInventoryId(
        solarSystemID,
        structureID,
      ),
      flagID: 0,
      quantity: -1,
      groupID: this._normalizeInventoryId(structureType.groupID, 0),
      categoryID: STRUCTURE_CATEGORY_ID,
      customInfo: "",
      singleton: 1,
      stacksize: 1,
    };
  }

  _getCharacterContainerItems(session, requestedFlag = null) {
    const numericFlag =
      requestedFlag === null || requestedFlag === undefined
        ? null
        : this._normalizeInventoryId(requestedFlag, 0);

    return getCharacterSkills(this._getCharacterId(session)).filter((skill) => {
      if (numericFlag === null || numericFlag === 0) {
        return true;
      }

      return this._normalizeInventoryId(skill.flagID, 0) === numericFlag;
    });
  }

  _listCorporationOfficeItems(session, office, requestedFlag = null) {
    if (!office) {
      return [];
    }

    const corporationID = this._getCorporationId(session);
    const numericFlag =
      requestedFlag === null || requestedFlag === undefined
        ? null
        : this._normalizeInventoryId(requestedFlag, 0);
    const locationIDs = new Set(
      [
        this._normalizeInventoryId(office.officeID, 0),
        this._normalizeInventoryId(office.officeFolderID, 0),
        this._normalizeInventoryId(office.itemID, 0),
      ].filter((locationID) => locationID > 0),
    );
    const seenItemIDs = new Set();
    const items = [];

    if (numericFlag !== null && !this._canQueryCorporationHangarFlag(session, numericFlag)) {
      return [];
    }

    for (const locationID of locationIDs) {
      for (const item of listContainerItems(corporationID, locationID, numericFlag)) {
        const itemID = this._normalizeInventoryId(item && item.itemID, 0);
        if (itemID <= 0 || seenItemIDs.has(itemID)) {
          continue;
        }
        if (!this._canQueryCorporationHangarFlag(session, item && item.flagID)) {
          continue;
        }
        seenItemIDs.add(itemID);
        items.push(item);
      }
    }

    return items.sort(
      (left, right) =>
        this._normalizeInventoryId(left && left.flagID, 0) -
          this._normalizeInventoryId(right && right.flagID, 0) ||
        this._normalizeInventoryId(left && left.typeID, 0) -
          this._normalizeInventoryId(right && right.typeID, 0) ||
        this._normalizeInventoryId(left && left.itemID, 0) -
          this._normalizeInventoryId(right && right.itemID, 0),
    );
  }

  _buildCorporationOfficeItemOverrides(session, office) {
    if (!office) {
      return null;
    }

    return {
      itemID: this._normalizeInventoryId(
        office.itemID,
        this._normalizeInventoryId(office.officeID, 0),
      ),
      typeID: OFFICE_TYPE_ID,
      ownerID: this._getCorporationId(session),
      locationID: this._normalizeInventoryId(
        office.stationID,
        this._getStationId(session),
      ),
      flagID: FLAG_OFFICE_FOLDER,
      quantity: -1,
      groupID: OFFICE_GROUP_ID,
      categoryID: OFFICE_CATEGORY_ID,
      customInfo: null,
      singleton: 1,
      stacksize: 1,
    };
  }

  _getDeliveredPersonalAssetSafetyWrapItem(session, inventoryID) {
    const item = assetSafetyState.getDeliveredPersonalWrapItem(inventoryID);
    return item && item.ownerID === this._getCharacterId(session) &&
      item.locationID === this._getStationId(session)
      ? item
      : null;
  }

  _buildContainerItemOverrides(session, inventoryID) {
    const numericInventoryID = this._normalizeInventoryId(inventoryID);
    const charId = this._getCharacterId(session);
    const stationId = this._getStationId(session);
    const shipRecord =
      findCharacterShip(charId, numericInventoryID) ||
      findShipItemById(numericInventoryID);
    const genericItemRecord =
      shipRecord || findItemById(numericInventoryID);
    const ancestorWrap = this._getAssetSafetyAncestorWrap(numericInventoryID);
    if (ancestorWrap && !this._getAccessibleAssetSafetyInventoryWrap(session, numericInventoryID)) {
      throwWrappedUserError("FakeItemNotFound");
    }

    if (genericItemRecord) {
      return this._buildInventoryItemOverrides(session, genericItemRecord);
    }

    const wrap = assetSafetyState.getWrapByID(numericInventoryID, { refresh: false });
    if (wrap?.deliverySaga?.deliveryMode === "wrapped") {
      const wrapItem = this._getDeliveredAssetSafetyWrapItem(session, numericInventoryID);
      if (!wrapItem) {
        throwWrappedUserError("FakeItemNotFound");
      }
      return this._buildInventoryItemOverrides(session, wrapItem);
    }

    const corporationOffice = this._getCorporationOffice(
      session,
      numericInventoryID,
    );
    if (corporationOffice) {
      return this._buildCorporationOfficeItemOverrides(session, corporationOffice);
    }

    const nativeWreckRecord = this._getNativeWreckRecord(numericInventoryID);
    if (nativeWreckRecord) {
      return this._buildNativeWreckItemOverrides(session, numericInventoryID);
    }

    if (numericInventoryID === charId) {
      return this._buildCharacterItemOverrides(session);
    }

    if (numericInventoryID === stationId || numericInventoryID === 0) {
      if (
        Number(session && (session.structureID || session.structureid)) > 0
      ) {
        return (
          this._buildStructureItemOverrides(session, stationId) ||
          this._buildStationItemOverrides(session, stationId)
        );
      }
      return this._buildStationItemOverrides(session, stationId);
    }

    const stationItem = this._buildStationItemOverrides(session, stationId);
    return {
      itemID: numericInventoryID,
      typeID: stationItem.typeID,
      ownerID: this._getCharacterId(session),
      locationID: stationId,
      flagID: 0,
      quantity: 1,
      groupID: STATION_GROUP_ID,
      categoryID: STATION_CATEGORY_ID,
      customInfo: "",
      singleton: 1,
      stacksize: 1,
    };
  }

  _resolveContainerItems(session, requestedFlag, boundContext) {
    if (boundContext?.kind === "incursionCargoReceiver") return [];
    if (boundContext?.kind === "fracturedLegacyReceiver") {
      return requestedFlag === null || requestedFlag === undefined || Number(requestedFlag) === ITEM_FLAGS.CARGO_HOLD
        ? fracturedLegacyCargo.listReceived(session, boundContext.inventoryID) : [];
    }
    const stationId = this._getStationId(session);
    const charId = this._getCharacterId(session);
    const numericFlag =
      requestedFlag === null || requestedFlag === undefined
        ? null
        : this._normalizeInventoryId(requestedFlag, 0);
    const containerID = boundContext && Number(boundContext.inventoryID)
      ? Number(boundContext.inventoryID)
      : stationId;
    const useControlledStructureSemantics =
      this._usesControlledStructureInventorySemantics(
        session,
        requestedFlag,
        boundContext,
      );

    // An unanchored hull exposes no inventory, and a container still mid-unanchor
    // must refuse rather than serve a half-migrated view.
    if (this._isUnanchoredStructureHullInventoryID(containerID)) {
      return [];
    }
    if (this._isPendingStructureUnanchorContainerInventoryID(containerID)) {
      this._throwPendingStructureUnanchorContainerInventoryError();
    }
    this._ensureSecureContainerGeneralAccess(session, containerID);

    const safetyWrap = assetSafetyState.getWrapByID(containerID, { refresh: false });
    if (safetyWrap?.deliverySaga?.deliveryMode === "wrapped") {
      // Corporate controller first List()s all divisions, then List(flag=115
      // etc.) per child. This view grants no corporate withdrawal authority.
      return this._getDeliveredAssetSafetyWrapItem(session, containerID)
        ? listContainerItems(safetyWrap.ownerID, containerID, numericFlag)
        : [];
    }

    const ancestorWrap = this._getAssetSafetyAncestorWrap(containerID);
    if (ancestorWrap) {
      // Native nested nodes bind the real container, while removal tax is
      // quoted on its enclosing wrap. Both owners need this local checked view.
      return this._getAccessibleAssetSafetyInventoryWrap(session, containerID)
        ? listContainerItems(null, containerID, numericFlag) : [];
    }

    const customsOffice = this._getPlanetaryCustomsOfficeRecord(containerID);
    if (customsOffice) {
      const customsFlag = numericFlag === null || numericFlag === 0
        ? ITEM_FLAGS.HANGAR
        : numericFlag;
      if (customsFlag !== ITEM_FLAGS.HANGAR) {
        return [];
      }
      // Retail Customs Office inventory is partitioned by depositor.  Rows
      // belonging to another character neither list nor consume this caller's
      // independent 35,000 m3 pool.
      return listContainerItems(charId, containerID, ITEM_FLAGS.HANGAR);
    }

    if (containerID === charId) {
      return this._getCharacterContainerItems(session, numericFlag);
    }

    if (
      boundContext &&
      (boundContext.kind === "corpDeliveries" || boundContext.kind === "capsuleerDeliveries")
    ) {
      const expectedFlag =
        boundContext.kind === "capsuleerDeliveries"
          ? ITEM_FLAGS.CAPSULEER_DELIVERIES
          : ITEM_FLAGS.CORP_DELIVERIES;
      const requestedDeliveryFlag = numericFlag === null || numericFlag === 0
        ? expectedFlag
        : numericFlag;
      if (requestedDeliveryFlag !== expectedFlag) {
        return [];
      }
      if (
        this._getInventoryCustodyAccessError(
          session,
          {
            locationID: this._normalizeInventoryId(boundContext.locationID, stationId),
            flagID: expectedFlag,
          },
          { direction: "view" },
        )
      ) {
        return [];
      }
      return listContainerItems(
        this._getCorporationId(session),
        this._normalizeInventoryId(boundContext.locationID, stationId),
        expectedFlag,
      );
    }

    const corporationOffice = this._getCorporationOffice(session, containerID);
    if (corporationOffice) {
      return this._listCorporationOfficeItems(
        session,
        corporationOffice,
        numericFlag,
      );
    }

    const starbaseCorporateHangar = findItemById(containerID);
    if (starbaseProcessingInventory.isProcessingStorage(starbaseCorporateHangar)) {
      const access = starbaseProcessingInventory.validateProcessingAccess(session, starbaseCorporateHangar);
      if (!access.success) this._throwSpaceContainerScopeAccessError(access.errorMsg);
      const flag = starbaseProcessingInventory.getProcessingFlag(starbaseCorporateHangar);
      if (numericFlag !== null && numericFlag !== flag) return [];
      return listContainerItems(starbaseCorporateHangar.ownerID, containerID, flag);
    }
    if (starbaseInventoryRuntime.isTowerBay(starbaseCorporateHangar)) {
      const access = starbaseInventoryRuntime.validateTowerBayAccess(session, starbaseCorporateHangar, "view");
      if (!access.success) this._throwSpaceContainerScopeAccessError(access.errorMsg);
      if (numericFlag !== null && ![0, 122].includes(numericFlag)) return [];
      return listContainerItems(null, containerID, numericFlag).filter((item) => [0, 122].includes(item.flagID));
    }
    if (starbaseInventoryRuntime.isBatteryAmmoInventory(starbaseCorporateHangar)) {
      const access = starbaseInventoryRuntime.validateBatteryAmmoInventoryAccess(session, starbaseCorporateHangar);
      if (!access.success) this._throwSpaceContainerScopeAccessError(access.errorMsg);
      if (numericFlag !== null && !starbaseInventoryRuntime.isBatteryAmmoFlag(starbaseCorporateHangar, numericFlag)) return [];
      return listContainerItems(null, containerID, numericFlag).filter((item) =>
        starbaseInventoryRuntime.isBatteryAmmoFlag(starbaseCorporateHangar, item.flagID));
    }
    if (isStarbaseCorporateHangarArrayType(starbaseCorporateHangar)) {
      return this._listStarbaseCorporationHangarItems(
        session,
        starbaseCorporateHangar,
        numericFlag,
      );
    }

    if (containerID === stationId) {
      if (numericFlag === assetSafetyState.ASSET_SAFETY_FLAG_ID) {
        return [...assetSafetyState.listWrapsForOwner("char", charId, {
          includeDelivered: true,
          refresh: false,
        }), ...assetSafetyState.listWrapsForOwner("corp", this._getCorporationId(session), {
          includeDelivered: true,
          refresh: false,
        })].map((wrap) => this._getDeliveredAssetSafetyWrapItem(session, wrap.assetWrapID))
          .filter(Boolean)
          .concat(listContainerItems(charId, stationId, numericFlag));
      }
      const structureContainer = this._getStructureForInventoryID(containerID);
      const structureOwnerID = this._getStructureInventoryOwnerID(structureContainer);
      if (this._isMoonMaterialBayFlag(numericFlag)) {
        this._ensureCanAccessMoonMaterialBay(
          session,
          structureContainer,
          containerID,
        );
        return listContainerItems(null, containerID, numericFlag);
      }
      if (
        structureContainer &&
        structureOwnerID > 0 &&
        (this._isStructureOwnerBayFlag(numericFlag) || isShipFittingFlag(numericFlag)) &&
        this._normalizeInventoryId(this._getCorporationId(session), 0) > 0 &&
        structureOwnerID !== this._normalizeInventoryId(this._getCorporationId(session), 0) &&
        !this._isSessionControllingStructure(session, containerID)
      ) {
        // Structure bays and fitting belong to the owning corporation.
        return [];
      }
      if (
        structureContainer &&
        structureOwnerID > 0 &&
        useControlledStructureSemantics
      ) {
        if (numericFlag === null || isShipFittingFlag(numericFlag)) {
          return listContainerItems(structureOwnerID, containerID, numericFlag);
        }
        if (this._isStructureOwnerBayFlag(numericFlag)) {
          return listContainerItems(structureOwnerID, containerID, numericFlag);
        }
        return listContainerItems(null, containerID, numericFlag);
      }
      if (
        structureContainer &&
        structureOwnerID > 0 &&
        this._isStructureOwnerBayFlag(numericFlag)
      ) {
        return listContainerItems(structureOwnerID, containerID, numericFlag);
      }

      return listContainerItems(
        charId,
        stationId,
        numericFlag === null || numericFlag === 0
          ? ITEM_FLAGS.HANGAR
          : numericFlag,
      );
    }

    const structureContainer = this._getStructureForInventoryID(containerID);
    const structureOwnerID = this._getStructureInventoryOwnerID(structureContainer);
    if (this._isMoonMaterialBayFlag(numericFlag)) {
      this._ensureCanAccessMoonMaterialBay(
        session,
        structureContainer,
        containerID,
      );
      return listContainerItems(null, containerID, numericFlag);
    }
    if (
      structureContainer &&
      structureOwnerID > 0 &&
      (this._isStructureOwnerBayFlag(numericFlag) || isShipFittingFlag(numericFlag)) &&
      this._normalizeInventoryId(this._getCorporationId(session), 0) > 0 &&
      structureOwnerID !== this._normalizeInventoryId(this._getCorporationId(session), 0) &&
      !this._isSessionControllingStructure(session, containerID)
    ) {
      // Structure bays and fitting belong to the owning corporation.
      return [];
    }
    if (
      structureContainer &&
      structureOwnerID > 0 &&
      useControlledStructureSemantics
    ) {
      if (numericFlag === null || isShipFittingFlag(numericFlag)) {
        return listContainerItems(structureOwnerID, containerID, numericFlag);
      }
      if (this._isStructureOwnerBayFlag(numericFlag)) {
        return listContainerItems(structureOwnerID, containerID, numericFlag);
      }
      return listContainerItems(null, containerID, numericFlag);
    }
    if (
      structureContainer &&
      structureOwnerID > 0 &&
      this._isStructureOwnerBayFlag(numericFlag)
    ) {
      return listContainerItems(structureOwnerID, containerID, numericFlag);
    }

    const shipContainerRecord = findShipItemById(containerID);
    if (shipContainerRecord && isShipServiceFlag(numericFlag)) {
      const accessError = this._getShipServiceAccessError(
        session,
        containerID,
        numericFlag,
      );
      if (accessError) {
        log.debug(
          `[InvBroker] Ship service bay list denied ship=${containerID} flag=${numericFlag} error=${accessError}`,
        );
        return [];
      }

      // A ship service bay is one shared pool, not a set of per-depositor
      // sub-pools. Retail lists flags 90/155 on location+flag alone
      // (invControllers.py ShipMaintenanceBay/ShipFleetHangar inherit the
      // owner-blind IsItemHere, while every genuinely per-owner container in
      // that file spells out an ownerID test) and sums used volume over every
      // row regardless of owner, with the single owner-based exclusion hard
      // scoped to customs offices (invCache.py). Filtering to the session
      // character hid fleet-mate deposits from the ship's own pilot, and because
      // _calculateCapacity sums this very list, it let the owner validate
      // against an undercount and physically overfill the bay past its
      // capacity — guests, who already listed unfiltered, saw the real total.
      return listContainerItems(null, containerID, numericFlag);
    }

    const genericContainerRecord = findItemById(containerID);
    if (genericContainerRecord && !findShipItemById(containerID)) {
      const corporationContainerContext =
        this._getCorporationOfficeDivisionAncestorContext(
          session,
          genericContainerRecord,
        );
      if (
        corporationContainerContext &&
        !this._hasLocalCorporationOfficeDivisionQueryAccess(
          session,
          corporationContainerContext,
        )
      ) {
        return [];
      }
      if (this._getSpaceContainerScopeAccessError(session, containerID)) {
        return [];
      }
      const mobileDepotAccessError = this._getMobileDepotCargoAccessError(
        session,
        containerID,
      );
      if (mobileDepotAccessError) {
        log.debug(
          `[InvBroker] Mobile Depot cargo list denied container=${containerID} error=${mobileDepotAccessError}`,
        );
        return [];
      }
      const mobileTractorUnitAccessError =
        this._getMobileTractorUnitCargoAccessError(session, containerID);
      if (mobileTractorUnitAccessError) {
        log.debug(
          `[InvBroker] Mobile Tractor Unit cargo list denied container=${containerID} error=${mobileTractorUnitAccessError}`,
        );
        return [];
      }
      if (
        this._getPersonalHangarContainerAccessError(
          session,
          genericContainerRecord,
        )
      ) {
        return [];
      }
      if (
        this._getInventoryCustodyAccessError(
          session,
          { locationID: containerID, flagID: null },
          { direction: "view" },
        )
      ) {
        return [];
      }
      // A container's contents belong to the container, not to whoever opened
      // it — the owner test above is the whole of the access decision, and once
      // it passes the listing owes the client every row physically inside.
      // Retail draws that line explicitly: invCtrl.StationContainer inherits
      // BaseCelestialContainer.IsItemHere (invControllers.py:1272), which tests
      // `item.locationID == self.itemID` and nothing else, while every
      // genuinely per-owner controller in that file spells an ownerID test out
      // (invCtrl.StationItems:1149, invCtrl.BaseCorpContainer:867).
      //
      // Narrowing to the session character hid rows the character does not own
      // but legitimately stores here: minerals taken from a corporation hangar
      // division into a personal container keep the corporation as ownerID, and
      // the container then listed empty at every flag, through a relog, with
      // the row intact in the store. _calculateCapacity sums this same list, so
      // the undercount also let the container be filled past its capacity —
      // the identical fault already fixed for ship service bays above.
      return listContainerItems(null, containerID, numericFlag);
    }

    const nativeWreckRecord = this._getNativeWreckRecord(containerID);
    if (nativeWreckRecord) {
      if (this._getSpaceContainerScopeAccessError(session, containerID)) {
        return [];
      }
      return nativeNpcStore.buildNativeWreckContents(containerID);
    }

    return listContainerItems(
      this._getCharacterId(session),
      containerID,
      numericFlag,
    );
  }

  _buildCapacityInfo(capacity, used) {
    return {
      type: "object",
      name: "util.KeyVal",
      args: {
        type: "dict",
        entries: [
          ["capacity", Number(capacity)],
          ["used", Number(used)],
        ],
      },
    };
  }

  _buildInventoryRowDescriptor(
    columns = INVENTORY_ROW_DESCRIPTOR_COLUMNS,
    virtualColumns = INVENTORY_ROW_DESCRIPTOR_VIRTUAL_COLUMNS,
  ) {
    return buildPackedRowDescriptor(columns, virtualColumns);
  }

  _calculateCapacity(session, boundContext, requestedFlag = null) {
    if (incursionFactoryCustody.isFactory(findItemById(boundContext?.inventoryID))) {
      if (requestedFlag != null && Number(requestedFlag) !== ITEM_FLAGS.CARGO_HOLD) return this._buildCapacityInfo(0, 0);
      const used = listContainerItems(null, boundContext.inventoryID, null).reduce((sum, item) => sum + getInventoryItemUnitVolume(item) * item.quantity, 0);
      return this._buildCapacityInfo(7500, used);
    }
    if (boundContext?.kind === "incursionCargoReceiver") {
      if (requestedFlag !== null && Number(requestedFlag) !== ITEM_FLAGS.CARGO_HOLD) return this._buildCapacityInfo(0, 0);
      const result = incursionCargo.capacity(session, boundContext.inventoryID);
      return this._buildCapacityInfo(result.capacity, result.used);
    }
    if (boundContext?.kind === "fracturedLegacyReceiver") {
      const received = fracturedLegacyCargo.listReceived(session, boundContext.inventoryID);
      return this._buildCapacityInfo(4000, received.reduce((sum, item) => sum + Number(item.quantity), 0));
    }
    if (
      this._isUnanchoredStructureHullInventoryID(
        boundContext && boundContext.inventoryID,
      )
    ) {
      return this._buildCapacityInfo(0, 0);
    }
    if (
      this._isPendingStructureUnanchorContainerInventoryID(
        boundContext && boundContext.inventoryID,
      )
    ) {
      this._throwPendingStructureUnanchorContainerInventoryError();
    }
    const numericFlag =
      requestedFlag === null || requestedFlag === undefined
        ? boundContext && boundContext.flagID !== null && boundContext.flagID !== undefined
          ? Number(boundContext.flagID)
          : null
        : Number(requestedFlag);
    const capacityInventoryID = this._normalizeInventoryId(
      boundContext && boundContext.inventoryID,
      0,
    );
    const capacityStarbaseCorporateHangar = findItemById(capacityInventoryID);
    // Deposit does not require Query access, but capacity still has to count the
    // physical contents of the division. Otherwise a deposit-only member could
    // repeatedly validate against an empty view and overfill the shared array.
    const items = isStarbaseCorporateHangarArrayType(
      capacityStarbaseCorporateHangar,
    ) && !this._getSpaceContainerScopeAccessError(session, capacityInventoryID)
      ? listContainerItems(null, capacityInventoryID, null)
      : this._resolveContainerItems(session, requestedFlag, boundContext);
    let used = items.reduce((sum, item) => {
      if (!item) {
        return sum;
      }
      const units =
        Number(item.singleton) === 1
          ? 1
          : Math.max(0, Number(item.stacksize ?? item.quantity ?? 0) || 0);
      const volume = Math.max(0, getInventoryItemUnitVolume(item));
      return sum + (volume * units);
    }, 0);
    // Show Info calls GetInventoryFromId(wrapID).GetCapacity().used for a
    // Plastic Wrap. Courier contents are held in contract escrow rather than
    // as inventory children of the wrap, so the encoded item volume is the
    // authoritative occupied volume for a courier package with no inventory
    // children. Other wraps keep the normal calculation from their contents.
    if (
      Number(capacityStarbaseCorporateHangar && capacityStarbaseCorporateHangar.typeID) === PLASTIC_WRAP_TYPE_ID &&
      Number(capacityStarbaseCorporateHangar.singleton) === 1 &&
      Object.prototype.hasOwnProperty.call(capacityStarbaseCorporateHangar, "plasticWrapVolume") &&
      !this._getSpaceContainerScopeAccessError(session, capacityInventoryID) &&
      !this._getPersonalHangarContainerAccessError(session, capacityStarbaseCorporateHangar) &&
      !this._getInventoryCustodyAccessError(
        session,
        { locationID: capacityInventoryID, flagID: null },
        { direction: "view" },
      ) &&
      listContainerItems(null, capacityInventoryID, null).length === 0
    ) {
      used = Math.max(0, getInventoryItemUnitVolume(capacityStarbaseCorporateHangar));
    }
    if (starbaseInventoryRuntime.isBatteryAmmoInventory(capacityStarbaseCorporateHangar)) {
      return this._buildCapacityInfo(
        starbaseInventoryRuntime.getBatteryAmmoCapacity(capacityStarbaseCorporateHangar, numericFlag), used,
      );
    }
    if (starbaseProcessingInventory.isProcessingStorage(capacityStarbaseCorporateHangar)) {
      return this._buildCapacityInfo(starbaseProcessingInventory.getProcessingCapacity(
        capacityStarbaseCorporateHangar, numericFlag ?? starbaseProcessingInventory.getProcessingFlag(capacityStarbaseCorporateHangar)), used);
    }
    if (starbaseInventoryRuntime.isTowerBay(capacityStarbaseCorporateHangar)) {
      return this._buildCapacityInfo(starbaseInventoryRuntime.getTowerBayCapacity(capacityStarbaseCorporateHangar, numericFlag), used);
    }
    let capacity = 1000000.0;
    let reservedVolume = 0;
    if (this._isMoonMaterialBayFlag(numericFlag)) {
      const structure = this._getStructureForInventoryID(
        boundContext && boundContext.inventoryID,
      );
      return this._buildCapacityInfo(
        this._getMoonMaterialBayCapacity(structure),
        used,
      );
    }
    const structureForFighterBayCapacity =
      Number(numericFlag) === ITEM_FLAGS.FIGHTER_BAY
        ? this._getStructureForInventoryID(boundContext && boundContext.inventoryID)
        : null;
    if (structureForFighterBayCapacity) {
      return this._buildCapacityInfo(
        this._getStructureFighterBayCapacity(structureForFighterBayCapacity),
        used,
      );
    }
    const shipRecord = this._getShipInventoryRecord(session, boundContext);
    if (shipRecord) {
      const requiresDerivedShipState =
        numericFlag === ITEM_FLAGS.CARGO_HOLD ||
        numericFlag === ITEM_FLAGS.DRONE_BAY ||
        numericFlag === ITEM_FLAGS.FIGHTER_BAY ||
        numericFlag === ITEM_FLAGS.FLEET_HANGAR ||
        isFuelBayFlag(numericFlag) ||
        MINING_SHIP_BAY_FLAGS.includes(numericFlag) ||
        isSpecialShipHoldFlag(numericFlag);
      const fittingSnapshot = requiresDerivedShipState
        ? getShipFittingSnapshot(
            this._resolveShipDogmaCharacterID(session, shipRecord),
            shipRecord.itemID,
            {
              shipItem: shipRecord,
              reason: "invbroker.capacity",
            },
          )
        : null;
      const resourceState = fittingSnapshot && fittingSnapshot.resourceState
        ? fittingSnapshot.resourceState
        : {};

      if (numericFlag === ITEM_FLAGS.CARGO_HOLD) {
        capacity = Number(resourceState.cargoCapacity) || 0;
      } else if (isFuelBayFlag(numericFlag)) {
        capacity = Number(getFuelBayCapacity(resourceState)) || 0;
      } else if (MINING_SHIP_BAY_FLAGS.includes(numericFlag)) {
        capacity = Number(getShipHoldCapacityByFlag(resourceState, numericFlag)) || 0;
      } else if (numericFlag === ITEM_FLAGS.DRONE_BAY) {
        const derivedCapacity = Number(resourceState.droneCapacity);
        capacity = Number.isFinite(derivedCapacity)
          ? derivedCapacity
          : Number(
              getShipBaseAttributeValue(shipRecord.typeID, "droneCapacity"),
            ) || 0;
        reservedVolume = this._getLaunchedDroneReservedBayVolume(
          session,
          shipRecord,
        );
      } else if (numericFlag === ITEM_FLAGS.FIGHTER_BAY) {
        const derivedCapacity = Number(resourceState.fighterCapacity);
        capacity = Number.isFinite(derivedCapacity)
          ? derivedCapacity
          : Number(
              getShipBaseAttributeValue(shipRecord.typeID, "fighterCapacity"),
            ) || 0;
      } else if (numericFlag === ITEM_FLAGS.SHIP_HANGAR) {
        capacity = Number(
          getShipBaseAttributeValue(shipRecord.typeID, "shipMaintenanceBayCapacity"),
        ) || 0;
      } else if (numericFlag === ITEM_FLAGS.FLEET_HANGAR) {
        capacity = Number(getFleetHangarCapacity(resourceState)) || 0;
      } else if (numericFlag === ITEM_FLAGS.MOBILE_DEPOT_HOLD) {
        capacity = Number(
          getShipBaseAttributeValue(
            shipRecord.typeID,
            MOBILE_DEPOT_HOLD_CAPACITY_ATTRIBUTE,
          ),
        ) || 0;
      } else if (isGenericSpecialShipHoldFlag(numericFlag)) {
        capacity = Number(
          getSpecialShipHoldCapacity(
            resourceState,
            shipRecord.typeID,
            numericFlag,
            getShipBaseAttributeValue,
          ),
        ) || 0;
      }
    } else if (boundContext && boundContext.kind === "container") {
      const containerRecord = findItemById(
        this._normalizeInventoryId(boundContext.inventoryID, 0),
      );
      const nativeWreckRecord =
        containerRecord ? null : this._getNativeWreckRecord(boundContext.inventoryID);
      // A default Customs Office is synthesized per planet and never
      // materializes an item row (c15fd45c), so both lookups above miss it and
      // its capacity would fall through to the unbounded initializer - while an
      // otherwise identical player-anchored POCO enforces the 35,000 m3 its item
      // row carries from invTypes 2233. Resolve the orbital's own type so both
      // flavours enforce the same static-data capacity.
      const customsOfficeRecord =
        containerRecord || nativeWreckRecord
          ? null
          : this._getPlanetaryCustomsOfficeRecord(boundContext.inventoryID);
      const containerMetadata = getItemMetadata(
        (containerRecord && containerRecord.typeID) ||
          (nativeWreckRecord && nativeWreckRecord.typeID) ||
          (customsOfficeRecord && customsOfficeRecord.typeID),
        (containerRecord && containerRecord.itemName) ||
          (nativeWreckRecord && nativeWreckRecord.itemName) ||
          (customsOfficeRecord && customsOfficeRecord.itemName),
      );
      capacity =
        Number(containerRecord && containerRecord.capacity) ||
        Number(nativeWreckRecord && nativeWreckRecord.capacity) ||
        Number(containerMetadata && containerMetadata.capacity) ||
        capacity;
    } else if (
      this._isStructureOwnerBayFlag(numericFlag) &&
      this._getStructureForInventoryID(boundContext && boundContext.inventoryID)
    ) {
      // An Upwell structure is not a ship, so none of the ship-shaped fallbacks
      // below describe its bays. The moon-material and fighter-bay branches
      // above already resolve the two structure bays the SDE gives a capacity
      // attribute; every other owner bay - Item Hangar, structure cargo, the
      // Fuel Bay, fitting and fighter-tube slots, the Quantum Core slot - has no
      // capacity attribute on a category-65 hull and is unbounded in retail
      // (doc/PARITY_FEATURE_ROADMAP.md records CCP's "same unlimited fuel bay"
      // for Ansiblex ozone/fuel-block storage). Keeping the unbounded default
      // here stops flagCargo on a controlled structure from borrowing the ship
      // "no ship record" 5000 m3 cargo fallback, which made the same bay report
      // 5000 while docked and unbounded from an undocked container bind.
      capacity = 1000000.0;
    } else if (numericFlag === ITEM_FLAGS.CARGO_HOLD) {
      capacity = 5000.0;
    } else if (isFuelBayFlag(numericFlag)) {
      capacity = 0.0;
    } else if (MINING_SHIP_BAY_FLAGS.includes(numericFlag)) {
      capacity = 0.0;
    } else if (numericFlag === ITEM_FLAGS.DRONE_BAY) {
      capacity = 0.0;
    } else if (numericFlag === ITEM_FLAGS.FIGHTER_BAY) {
      capacity = 0.0;
    } else if (numericFlag === ITEM_FLAGS.SHIP_HANGAR) {
      capacity = 1000000.0;
    } else if (numericFlag === ITEM_FLAGS.FLEET_HANGAR) {
      capacity = 0.0;
    } else if (numericFlag === ITEM_FLAGS.MOBILE_DEPOT_HOLD) {
      capacity = 0.0;
    } else if (isGenericSpecialShipHoldFlag(numericFlag)) {
      capacity = 0.0;
    }

    return this._buildCapacityInfo(capacity, used + reservedVolume);
  }

  _buildInvRow(session, overrides = {}) {
    const shipMetadata = this._getShipMetadata(
      session,
      overrides.typeID ?? null,
      overrides.shipName ?? null,
    );
    const itemID = overrides.itemID ?? this._getShipId(session);
    const typeID = overrides.typeID ?? shipMetadata.typeID;
    const ownerID = overrides.ownerID ?? this._getCharacterId(session);
    const locationID = overrides.locationID ?? this._getStationId(session);
    const flagID = overrides.flagID ?? 4; // station hangar
    const singleton = overrides.singleton ?? 1;
    const quantity = overrides.quantity ?? (singleton === 2 ? -2 : singleton === 1 ? -1 : 1);
    const stacksize =
      overrides.stacksize ?? (singleton > 0 ? 1 : quantity);
    const groupID = overrides.groupID ?? shipMetadata.groupID;
    const categoryID = overrides.categoryID ?? shipMetadata.categoryID;
    const customInfo = Object.prototype.hasOwnProperty.call(overrides, "customInfo")
      ? overrides.customInfo
      : "";

    // Keep DBRowDescriptor-compatible order first, then convenience attrs.
    return [
      itemID,
      typeID,
      ownerID,
      locationID,
      flagID,
      quantity,
      groupID,
      categoryID,
      customInfo,
      stacksize,
      singleton,
    ];
  }

  _buildInvItem(session, overrides = {}) {
    const row = this._buildInvRow(session, overrides);
    const header = [
      "itemID",
      "typeID",
      "ownerID",
      "locationID",
      "flagID",
      "quantity",
      "groupID",
      "categoryID",
      "customInfo",
      "stacksize",
      "singleton",
    ];

    return {
      type: "object",
      name: "util.Row",
      args: {
        type: "dict",
        entries: [
          ["header", header],
          ["line", row],
        ],
      },
    };
  }

  _itemOverridesFromId(session, itemID) {
    const id = Number.isInteger(itemID) ? itemID : Number(itemID);
    const charId = this._getCharacterId(session);
    const skillRecord = this._findCharacterSkillRecord(session, id);
    if (skillRecord) {
      return this._buildSkillItemOverrides(skillRecord);
    }

    const shipRecord =
      findCharacterShip(charId, id) ||
      findShipItemById(id);
    if (shipRecord) {
      return {
        itemID: shipRecord.itemID,
        typeID: shipRecord.typeID,
        shipName: shipRecord.itemName,
        ownerID: shipRecord.ownerID,
        locationID: shipRecord.locationID,
        flagID: shipRecord.flagID,
        quantity: shipRecord.quantity,
        groupID: shipRecord.groupID,
        categoryID: shipRecord.categoryID,
        customInfo:
          shipRecord.customInfo === undefined ? "" : shipRecord.customInfo,
        singleton: shipRecord.singleton,
        stacksize: shipRecord.stacksize,
      };
    }

    const genericItem = findItemById(id);
    if (genericItem) {
      return {
        itemID: genericItem.itemID,
        typeID: genericItem.typeID,
        ownerID: genericItem.ownerID,
        locationID: genericItem.locationID,
        flagID: genericItem.flagID,
        quantity: genericItem.quantity,
        groupID: genericItem.groupID,
        categoryID: genericItem.categoryID,
        customInfo:
          genericItem.customInfo === undefined ? "" : genericItem.customInfo,
        singleton: genericItem.singleton,
        stacksize: genericItem.stacksize,
      };
    }

    const shipID = this._getShipId(session);
    const shipMetadata = this._getShipMetadata(session);
    return {
      itemID: Number.isInteger(id) ? id : shipID,
      typeID: shipMetadata.typeID,
      ownerID: this._getCharacterId(session),
      locationID: this._getStationId(session),
      flagID: 4,
      quantity: -1,
      groupID: shipMetadata.groupID,
      categoryID: shipMetadata.categoryID,
      customInfo: "",
      singleton: 1,
      stacksize: 1,
    };
  }

  Handle_GetInventory(args, session) {
    const containerID = args && args.length > 0 ? args[0] : null;
    const numericContainerID =
      containerID === null || containerID === undefined
        ? this._getStationId(session)
        : this._normalizeInventoryId(containerID);
    const stationId = this._getStationId(session);
    if (
      numericContainerID === CONTAINER_CORP_MARKET_ID ||
      numericContainerID === CONTAINER_CAPSULEER_DELIVERIES_ID
    ) {
      const isCapsuleerDeliveries =
        numericContainerID === CONTAINER_CAPSULEER_DELIVERIES_ID;
      this._traceInventory("GetInventory", session, { args });
      log.debug("[InvBroker] GetInventory corp deliveries");
      return this._makeBoundSubstruct({
        inventoryID: stationId,
        locationID: stationId,
        flagID: isCapsuleerDeliveries
          ? ITEM_FLAGS.CAPSULEER_DELIVERIES
          : ITEM_FLAGS.CORP_DELIVERIES,
        kind: isCapsuleerDeliveries ? "capsuleerDeliveries" : "corpDeliveries",
        ownerID: this._getCorporationId(session),
      }, session);
    }
    const isStructureDocked =
      Number(session && (session.structureID || session.structureid)) > 0;
    const isStationHangar =
      numericContainerID === stationId ||
      numericContainerID === CONTAINER_HANGAR_ID ||
      (isStructureDocked &&
        (
          numericContainerID === CONTAINER_STRUCTURE_ID
        )) ||
      numericContainerID === ITEM_FLAGS.HANGAR;
    this._traceInventory("GetInventory", session, { args });
    log.debug("[InvBroker] GetInventory");
    return this._makeBoundSubstruct({
      inventoryID: isStationHangar ? stationId : numericContainerID,
      locationID: isStationHangar ? stationId : numericContainerID,
      flagID: isStationHangar ? ITEM_FLAGS.HANGAR : null,
      kind: isStationHangar ? "stationHangar" : "inventory",
    }, session);
  }

  _buildInventoryRowset(lines) {
    return {
      type: "object",
      name: "eve.common.script.sys.rowset.Rowset",
      args: {
        type: "dict",
        entries: [
          ["header", INVENTORY_ROW_HEADER],
          ["RowClass", { type: "token", value: "util.Row" }],
          [
            "lines",
            {
              type: "list",
              items: lines,
            },
          ],
        ],
      },
    };
  }

  _buildInventoryRemoteList(itemOverrides = []) {
    return {
      type: "list",
      items: itemOverrides.map((overrides) =>
        this._buildInventoryPackedRow(overrides)),
    };
  }

  _buildInventoryRemoteSet(itemOverrides = []) {
    return buildObjectEx1("__builtin__.set", [
      buildList(
        itemOverrides.map((overrides) =>
          this._buildInventoryPackedRow(overrides)),
      ),
    ]);
  }

  _buildInventoryPackedRow(overrides = {}) {
    const fields = {
      itemID: overrides.itemID,
      typeID: overrides.typeID,
      ownerID: overrides.ownerID,
      locationID: overrides.locationID,
      flagID: overrides.flagID,
      quantity: overrides.quantity,
      groupID: overrides.groupID,
      categoryID: overrides.categoryID,
      customInfo: overrides.customInfo === undefined ? "" : overrides.customInfo,
      stacksize: overrides.stacksize,
      singleton: overrides.singleton,
    };
    if (this._isChargeTupleItemID(overrides.itemID)) {
      return buildPackedRow(
        CHARGE_SUBLOCATION_ROW_DESCRIPTOR_COLUMNS,
        fields,
        INVENTORY_ROW_DESCRIPTOR_VIRTUAL_COLUMNS,
      );
    }
    return buildPackedRow(
      INVENTORY_ROW_DESCRIPTOR_COLUMNS,
      fields,
      INVENTORY_ROW_DESCRIPTOR_VIRTUAL_COLUMNS,
    );
  }

  _buildInvKeyVal(session, overrides = {}) {
    const row = this._buildInvRow(session, overrides);
    const [
      itemID,
      typeID,
      ownerID,
      locationID,
      flagID,
      quantity,
      groupID,
      categoryID,
      customInfo,
      stacksize,
      singleton,
    ] = row;

    return {
      type: "object",
      name: "util.KeyVal",
      args: {
        type: "dict",
        entries: [
          ["itemID", itemID],
          ["typeID", typeID],
          ["ownerID", ownerID],
          ["locationID", locationID],
          ["flagID", flagID],
          ["quantity", quantity],
          ["groupID", groupID],
          ["categoryID", categoryID],
          ["customInfo", customInfo],
          ["stacksize", stacksize],
          ["singleton", singleton],
        ],
      },
    };
  }

  // A default Customs Office is synthesized per planet and carries no item row
  // until something actually happens to it (see ensureRuntimeOrbitalRecord in
  // planetOrbitalState), so findItemById can never see one.  The inventory bind
  // still has to recognise it: the client opens the import/export window with
  // GetInventoryFromId(customsOfficeID), and without this the whole feature dies
  // on FakeItemNotFound before the window is ever built.
  _getPlanetaryCustomsOfficeRecord(inventoryID) {
    const numericInventoryID = this._normalizeInventoryId(inventoryID, 0);
    if (numericInventoryID <= 0) {
      return null;
    }

    if (!planetOrbitalState.mayResolveOrbitalID(numericInventoryID)) return null;

    const record = planetOrbitalState.resolveOrbitalOrDefaultByID(
      numericInventoryID,
    );
    if (!record) {
      return null;
    }
    // Only Customs Offices hold cargo.  A gantry or construction platform has no
    // inventory, and a destroyed office is a tombstone rather than a bindable
    // target — both should keep failing the way they do today.
    if (!planetOrbitalState.isCustomsInventoryOrbitalRecord(record)) {
      return null;
    }
    return record;
  }

  Handle_GetInventoryFromId(args, session, kwargs) {
    const itemid = args && args.length > 0 ? args[0] : 0;
    const numericItemId = this._normalizeInventoryId(itemid);
    const charId = this._getCharacterId(session);
    const stationId = this._getStationId(session);
    const boundContext = this._getBoundContext(session);
    if (incursionCargo.isReceiver(session, numericItemId)) {
      if (!incursionCargo.resolveReceiver(session, numericItemId)) throwWrappedUserError("FakeItemNotFound");
      return this._makeBoundSubstruct({ inventoryID: numericItemId,
        locationID: Number(session._space?.systemID || session.solarsystemid),
        flagID: ITEM_FLAGS.CARGO_HOLD, kind: "incursionCargoReceiver" }, session);
    }
    if (fracturedLegacyCargo.isReceiver(session, numericItemId)) {
      if (!fracturedLegacyCargo.resolveReceiver(session, numericItemId)) throwWrappedUserError("FakeItemNotFound");
      return this._makeBoundSubstruct({ inventoryID: numericItemId,
        locationID: Number(session._space?.systemID || session.solarsystemid),
        flagID: ITEM_FLAGS.CARGO_HOLD, kind: "fracturedLegacyReceiver" }, session);
    }
    const inventoryTrade = this._getTradeInventoryService()?.getInventoryTrade(numericItemId, session);
    if (inventoryTrade) {
      return this._makeBoundSubstruct({ inventoryID: numericItemId,
        locationID: inventoryTrade.dockedLocationID, flagID: ITEM_FLAGS.HANGAR, kind: "tradeInventory" }, session);
    }
    const corporationOffice = this._getCorporationOffice(session, numericItemId);
    const boundShip =
      findCharacterShip(charId, numericItemId) ||
      findShipItemById(numericItemId);
    const genericItem = findItemById(numericItemId);
    const deliveredSafetyWrapItem = this._getDeliveredAssetSafetyWrapItem(session, numericItemId);
    const ancestorSafetyWrap = this._getAssetSafetyAncestorWrap(numericItemId);
    if (ancestorSafetyWrap && !this._getAccessibleAssetSafetyInventoryWrap(session, numericItemId)) {
      throwWrappedUserError("FakeItemNotFound");
    }
    const nativeWreckRecord = this._getNativeWreckRecord(numericItemId);
    const structureInventory = this._getStructureForInventoryID(numericItemId);
    const isControlledStructureInventory =
      this._isControlledStructureInventoryID(session, numericItemId);
    const isKnownInventoryTarget = Boolean(
      boundShip ||
        genericItem ||
        deliveredSafetyWrapItem ||
        nativeWreckRecord ||
        structureInventory ||
        corporationOffice ||
        isControlledStructureInventory ||
        (charId > 0 && numericItemId === charId) ||
        (stationId > 0 && numericItemId === stationId) ||
        // Deliberately last: a default Customs Office has no item row, so every
        // source above misses it.  Leaving the registry probe on the tail of the
        // disjunction keeps it off the common ship/station/container binds.
        this._getPlanetaryCustomsOfficeRecord(numericItemId),
    );
    if (!isKnownInventoryTarget) {
      this._traceInventory("GetInventoryFromIdNotFound", session, {
        args,
        itemid: numericItemId,
      });
      // Sites contain decorative copies of real containers (the AIR item-retrieval site has
      // three "[AIR] Bowhead Wreck", only one with cargo). FakeItemNotFound reaches the player
      // as "The item is no longer within your reach", which reads as "too far away".
      const scene = numericItemId > 0 ? runtime.getSceneForSession(session) : null;
      const scenery = scene && (
        (scene.staticEntitiesByID && scene.staticEntitiesByID.get(numericItemId)) ||
        scene.getEntityByID(numericItemId)
      );
      if (scenery && scenery.dungeonMaterializedEnvironment === true) {
        const name = String(scenery.slimName || scenery.itemName || "").trim() || "This object";
        throwWrappedUserError("CustomNotify", {
          notify: `${name} is part of the site's scenery and holds no cargo. ` +
            "Look for another one: a wreck you can open has \"Open Cargo\" in its right-click menu.",
        });
      }
      throwWrappedUserError("FakeItemNotFound");
    }
    if (ancestorSafetyWrap) {
      return this._makeBoundSubstruct({ inventoryID: numericItemId,
        locationID: deliveredSafetyWrapItem?.locationID || ancestorSafetyWrap.destinationID,
        flagID: null, kind: "container" }, session);
    }
    const corporationContainerContext =
      this._getCorporationOfficeDivisionAncestorContext(session, genericItem);
    if (
      corporationContainerContext &&
      !this._hasLocalCorporationOfficeDivisionQueryAccess(
        session,
        corporationContainerContext,
      )
    ) {
      throwWrappedUserError("FakeItemNotFound");
    }
    const spaceScopeError = this._getSpaceContainerScopeAccessError(session, numericItemId, { towerManagementRead: true });
    if (spaceScopeError) {
      this._throwSpaceContainerScopeAccessError(spaceScopeError, "open");
    }
    // A site guide may have something to say about this container (the exploration tour's
    // Exploration Supplies); that must never keep the pilot from opening it.
    try {
      require(path.join(__dirname, "../dungeon/dungeonTrackingRuntime")).onSiteContainerOpened(session, numericItemId);
    } catch (error) {
      log.warn(`[InvBroker] site guide on container open failed itemID=${numericItemId}: ${error && error.message}`);
    }
    const mobileTractorUnitOpenError =
      this._getMobileTractorUnitCargoAccessError(session, numericItemId);
    if (mobileTractorUnitOpenError === "TARGET_TOO_FAR") {
      throwWrappedUserError("NotCloseEnoughToOpen", {
        maxdist: MOBILE_TRACTOR_UNIT_SCOOP_RANGE_METERS,
      });
    }
    if (mobileTractorUnitOpenError) {
      throwWrappedUserError("FakeItemNotFound");
    }
    const explicitLocationID =
      this._extractKwarg(kwargs, "locationID") ??
      (args && args.length > 2 ? args[2] : undefined);
    const normalizedExplicitLocationID =
      explicitLocationID === undefined || explicitLocationID === null
        ? 0
        : this._normalizeInventoryId(explicitLocationID);
    const inheritedLocationID =
      boundContext &&
      boundContext.locationID !== null &&
      boundContext.locationID !== undefined
        ? this._normalizeInventoryId(boundContext.locationID)
        : 0;
    const shipLocationID = boundShip
      ? this._normalizeInventoryId(boundShip.locationID)
      : 0;
    const resolvedLocationID =
      corporationOffice
        ? this._normalizeInventoryId(corporationOffice.officeID, numericItemId)
        :
      normalizedExplicitLocationID > 0
        ? normalizedExplicitLocationID
        : boundShip && inheritedLocationID > 0
          ? inheritedLocationID
          : shipLocationID > 0
            ? shipLocationID
            : numericItemId === stationId
              ? stationId
              : itemid;
    this._traceInventory("GetInventoryFromId", session, { args });
    log.debug(
      `[InvBroker] GetInventoryFromId(itemid=${itemid}, locationID=${resolvedLocationID})`,
    );
    const result = this._makeBoundSubstruct({
      inventoryID: corporationOffice
        ? this._normalizeInventoryId(corporationOffice.officeID, numericItemId)
        : itemid,
      locationID: resolvedLocationID,
      flagID:
        isControlledStructureInventory
          ? null
          :
        numericItemId === charId
          ? null
          :
        corporationOffice
          ? null
          :
        numericItemId === stationId
          ? ITEM_FLAGS.HANGAR
          : boundShip
            ? ITEM_FLAGS.CARGO_HOLD
            : null,
      kind:
        isControlledStructureInventory
          ? "controlledStructureInventory"
          :
        numericItemId === charId
          ? "characterInventory"
          :
        corporationOffice
          ? "corpOffice"
          :
        numericItemId === stationId
          ? "stationHangar"
          : boundShip
            ? "shipInventory"
            : "container",
    }, session);
    if (boundShip) {
      log.debug(
        `[InvBroker] shipInventory bind shipID=${numericItemId} ` +
        `activeShip=${Number(this._getShipId(session)) === numericItemId} ` +
        `stationID=${stationId} locationID=${resolvedLocationID} ` +
        `${describeSessionHydrationState(session, numericItemId)}`,
      );
    }
    return result;
  }

  Handle_SetLabel(args, session) {
    this._traceInventory("SetLabel", session, { args });
    const itemID = this._normalizeInventoryId(
      unwrapMarshalValue(args && args.length > 0 ? args[0] : 0),
      0,
    );
    const item = findItemById(itemID);
    if (!item) {
      log.warn(`[InvBroker] SetLabel failed for missing item=${itemID}`);
      return null;
    }
    if (this._getPendingStructureUnanchorContainerAncestor(item)) {
      this._throwPendingStructureUnanchorContainerInventoryError();
    }

    const characterID = resolveSessionCharacterID(session);
    if (characterID <= 0) {
      return null;
    }
    const itemOwnerID = this._normalizeInventoryId(item.ownerID, 0);
    const isCargoContainer = isCargoContainerType(item);
    if (itemOwnerID !== characterID) {
      const corporationID = this._normalizeInventoryId(
        this._getCorporationId(session),
        0,
      );
      if (
        !isCargoContainer ||
        this._normalizeInventoryId(item.singleton, 0) !== 1 ||
        corporationID <= 0 ||
        itemOwnerID !== corporationID
      ) {
        throwWrappedUserError("ItemNotYours");
      }

      const corporationHangarContext =
        this._getDirectLocalCorporationHangarItemContext(session, item);
      if (!corporationHangarContext) {
        return null;
      }
      if (!corporationHangarContext.takeAllowed) {
        throwWrappedUserError(
          "CrpAccessDenied",
          buildCrpAccessDeniedInsufficientRolesValues(),
        );
      }
    }

    const rawLabel = unwrapMarshalValue(args && args.length > 1 ? args[1] : "");
    const label =
      Number(item.categoryID) === 6
        ? normalizeShipNameLabel(rawLabel)
        : String(rawLabel ?? "")
          .replace(/[\r\n]+/g, " ")
          .trim()
          .slice(0, 100);
    if (!label) {
      log.debug(`[InvBroker] SetLabel ignored empty label for item=${itemID}`);
      return null;
    }

    // Retail's three-week audit-log rule gates REPACKAGING, not renaming.
    // UI/Messages/270/CanNotRepackageALSCBody is titled "Cannot Repackage" and
    // reads "The Audit Log Secure Container can not be repackaged as it has a
    // log entry that is less than three weeks old" -- three weeks being
    // ALSC_AUDIT_LOG_RETENTION_TICKS above. That rule is enforced in its proper
    // place in station/repackagingSupport.js. It was also applied here, where
    // retail has no counterpart, so this handler refused a legitimate rename.
    //
    // Nothing in the client refuses a rename over an audit log. OfferSetName
    // (menucheckers/itemCheckers.py) gates on singleton, pilot location,
    // container group, orbital and a content-compliance typeID list -- and it
    // offers the entry for an ALSC in a corp office specifically, since
    // playerDeployedContainers holds groupAuditLogSecureContainer and
    // IsInPilotLocation accepts IsInLocalCorpOffice. Retail's whole SetName
    // refusal vocabulary is type, piloting, anchoring and access
    // (SetNameInvalidBody, SetNameShipMustBePilotBody,
    // SetNameObjectMustBeAnchoredInSpaceBody, SetNameNotYourStuffBody); there
    // is no message for an audit log or for container contents, so there is no
    // refusal for this handler to express.
    //
    // The refusal was self-triggering and silent as well. The update below
    // appends an ALSC_ACTION_SET_NAME entry, so the FIRST rename wrote the very
    // entry that made every later one fail, and the handler answered null,
    // which the client reads as success. A container could be named once and
    // then never again until the log aged out.
    //
    // Renaming stays logged -- retail records the action, it just does not
    // block it -- which the update below still does.
    const isAuditLogSecureContainer =
      this._isAuditLogSecureContainerRecord(item);

    const updateResult = updateInventoryItem(itemID, (currentItem) => {
      const updatedItem = {
        ...currentItem,
        itemName: label,
      };
      if (isAuditLogSecureContainer) {
        updatedItem.secureContainerState =
          this._appendSecureContainerAuditEntriesToState(
            currentItem,
            this._readSecureContainerState(currentItem),
            this._buildSecureContainerAuditEntry(
              currentItem,
              session,
              ALSC_ACTION_SET_NAME,
            ),
          );
      }
      return updatedItem;
    });
    if (!updateResult.success) {
      log.warn(
        `[InvBroker] SetLabel failed for item=${itemID}: ${updateResult.errorMsg || "UNKNOWN_ERROR"}`,
      );
      return null;
    }

    const updatedItem = updateResult.data || {
      ...item,
      itemName: label,
    };
    const sessionShipIDs = [
      this._getShipId(session),
      session && session.activeShipID,
      session && session.shipID,
      session && session.shipid,
    ].map((value) => this._normalizeInventoryId(value, 0));
    if (sessionShipIDs.includes(itemID)) {
      session.shipName = label;
      if (session._space && typeof session._space === "object") {
        session._space.shipName = label;
      }
    }

    if (isCargoContainer) {
      syncInventoryItemForSession(
        session,
        this._sanitizeSecureContainerClientItem(updatedItem),
        this._sanitizeSecureContainerClientItem(
          updateResult.previousData || item,
          updatedItem,
        ),
        { emitCfgLocation: false },
      );
    }
    if (Number(updatedItem.categoryID) === 6 || isCargoContainer) {
      this._emitSetLabelCfgDataChanged(session, itemID, label);
    }
    if (Number(updatedItem.categoryID) === 6) {
      this._refreshRenamedShipPresentation(session, updatedItem);
    }
    if (isCargoContainer) {
      this._refreshRenamedCargoContainerPresentation(session, updatedItem);
    }

    log.debug(`[InvBroker] SetLabel item=${itemID} label=${label}`);
    return null;
  }

  // The client hands this an invItem row, not an ID: invCache.ValidateItemCanBeOpened
  // forwards the row it already holds. Accept every shape the marshaller can
  // produce for one — packed row, util.Row/KeyVal, dict, bare ID.
  _extractInventoryItemIDArgument(value) {
    if (value === null || value === undefined) {
      return 0;
    }
    if (typeof value === "number" || typeof value === "bigint" || typeof value === "string") {
      return this._normalizeInventoryId(value, 0);
    }
    if (value.type === "packedrow" && value.fields) {
      return this._normalizeInventoryId(value.fields.itemID, 0);
    }
    if (value.type === "object" && value.args) {
      return this._extractInventoryItemIDArgument(value.args);
    }
    if (value.type === "dict" && Array.isArray(value.entries)) {
      for (const entry of value.entries) {
        if (Array.isArray(entry) && String(entry[0]) === "itemID") {
          return this._normalizeInventoryId(entry[1], 0);
        }
      }
      // util.Row marshals as {header:[...], line:[...]}.
      const values = Object.fromEntries(
        value.entries.filter((entry) => Array.isArray(entry)),
      );
      const header = values.header && values.header.items
        ? values.header.items
        : values.header;
      const line = values.line && values.line.items ? values.line.items : values.line;
      if (Array.isArray(header) && Array.isArray(line)) {
        const index = header.indexOf("itemID");
        if (index >= 0) {
          return this._normalizeInventoryId(line[index], 0);
        }
      }
      return 0;
    }
    if (typeof value === "object" && value.itemID !== undefined) {
      return this._normalizeInventoryId(value.itemID, 0);
    }
    return 0;
  }

  // invWindow._IsCurrentInventoryValid (invWindow.py:416) routes the selected
  // node through invCache.ValidateItemCanBeOpened (invCache.py:434), which asks
  // the inventory manager about cargo containers only and swallows any failure
  // into False. An unhandled method answered None, so the window judged every
  // selected cargo container invalid and dropped currInvID on construction
  // (invWindow.py:205) and on every session change (invWindow.py:1146, 1220).
  //
  // The answer is the access half of _resolveContainerItems: the same gates,
  // reported instead of applied. Nothing is thrown — the caller turns a throw
  // into False, and a container that merely wants its password is still one the
  // player may open.
  Handle_ValidateItemCanBeOpened(args, session) {
    const itemID = this._extractInventoryItemIDArgument(
      args && args.length > 0 ? args[0] : null,
    );
    this._traceInventory("ValidateItemCanBeOpened", session, { itemID });
    log.debug(`[InvBroker] ValidateItemCanBeOpened(itemID=${itemID})`);
    if (itemID <= 0) {
      // Retail's own fallback when it cannot ask: invCache returns True.
      return true;
    }
    if (
      this._isUnanchoredStructureHullInventoryID(itemID) ||
      this._isPendingStructureUnanchorContainerInventoryID(itemID)
    ) {
      return false;
    }
    const containerRecord = findItemById(itemID);
    if (!containerRecord) {
      return false;
    }
    const corporationContainerContext =
      this._getCorporationOfficeDivisionAncestorContext(session, containerRecord);
    if (
      corporationContainerContext &&
      !this._hasLocalCorporationOfficeDivisionQueryAccess(
        session,
        corporationContainerContext,
      )
    ) {
      return false;
    }
    if (this._getSpaceContainerScopeAccessError(session, itemID)) {
      return false;
    }
    if (this._getMobileDepotCargoAccessError(session, itemID)) {
      return false;
    }
    if (this._getMobileTractorUnitCargoAccessError(session, itemID)) {
      return false;
    }
    const stationId = this._getStationId(session);
    const isDockedPersonalContainer =
      stationId > 0 &&
      this._normalizeInventoryId(containerRecord.locationID, 0) === stationId &&
      this._normalizeInventoryId(containerRecord.flagID, 0) === ITEM_FLAGS.HANGAR;
    if (
      isDockedPersonalContainer &&
      this._normalizeInventoryId(containerRecord.ownerID, 0) !==
        this._getCharacterId(session)
    ) {
      return false;
    }
    return true;
  }

  Handle_ValidateItemListCanBeOpened(args, session) {
    this._traceInventory("ValidateItemListCanBeOpened", session, { args });
    log.debug("[InvBroker] ValidateItemListCanBeOpened");
    const itemIDs = this._normalizeItemIdList(
      args && args.length > 0 ? args[0] : [],
    );
    if (
      itemIDs.some((itemID) =>
        this._isUnanchoredStructureHullInventoryID(itemID),
      )
    ) {
      this._throwUnanchoredStructureHullInventoryError();
    }
    if (
      itemIDs.some((itemID) =>
        this._isPendingStructureUnanchorContainerInventoryID(itemID),
      )
    ) {
      this._throwPendingStructureUnanchorContainerInventoryError();
    }
    return [];
  }

  Handle_List(args, session, kwargs) {
    if (this._getBoundContext(session)?.kind === "tradeInventory") return this._dispatchTradeInventory("List", args, session, kwargs);
    const argFlag = args && args.length > 0 ? args[0] : null;
    const kwFlag = this._extractKwarg(kwargs, "flag");
    const boundContext = this._getBoundContext(session);
    const hasArgFlag = Boolean(args && args.length > 0);
    const hasKwFlag = kwFlag !== undefined;
    const explicitFlagProvided = hasKwFlag || hasArgFlag;
    const explicitNullFlag =
      (hasKwFlag && kwFlag === null) ||
      (hasArgFlag && argFlag === null);
    const initialLoginSpaceShipInventoryList =
      this._isInitialLoginSpaceShipInventoryList(session, boundContext);
    if (initialLoginSpaceShipInventoryList) {
      this._clearLoginInventoryBootstrapPending(session);
      this._primePendingSpaceShipInventoryBootstrap(session, boundContext, {
        reason: "invbroker.List.initialPrime",
      });
    }
    const suppressInitialLoginShipList = false;
    if (suppressInitialLoginShipList) {
      this._traceInventory("ListLoginBootstrapSuppressed", session, {
        args,
        kwargs,
        boundContext,
      });
      log.debug(
        `[InvBroker] Suppressing initial login-in-space ship List(flag=None) for ship=${boundContext && boundContext.inventoryID}`,
      );
      return this._buildInventoryRowset([]);
    }
    const inSpaceShipInventory =
      boundContext?.kind === "shipInventory" &&
      !this._getStationId(session);
    const requestedFlag =
      boundContext?.kind === "shipInventory" &&
      (
        explicitNullFlag ||
        (!explicitFlagProvided && !inSpaceShipInventory)
      )
        ? null
        : hasKwFlag
          ? kwFlag
          : hasArgFlag
            ? argFlag
            : boundContext?.flagID ?? null;
    this._traceInventory("List", session, {
      args,
      kwargs,
      requestedFlag,
    });
    log.debug(
      `[InvBroker] List (inventory contents) flag=${requestedFlag} bound=${JSON.stringify(boundContext)}`,
    );

    const itemsForContainer = this._mergeActiveShipLoadedChargeTupleRows(
      session,
      boundContext,
      requestedFlag,
      this._resolveContainerItems(
        session,
        requestedFlag,
        boundContext,
      ),
    );
    // The first in-space ship List of a session is the login bootstrap. The
    // client has bound the ship inventory by then, but its godma has not
    // necessarily primed the ship location yet — that happens in godma
    // ProcessAllInfo -> PrimeLocation off GetAllInfo, and a HUD poll such as
    // GetAvailableTurretSlots can beat it. tools/ClientCodeGrabber/Latest
    // eve/client/script/environment/godma.py OnGodmaPrimeItem logs an error and
    // invents an empty location set for any prime that lands on a location it
    // has not primed, so the login list stays a pure row delivery. The loaded
    // charge tuples already follow that rule; the drone bay has to as well. The
    // bay is primed on the next list — skipping the call leaves the bay
    // bootstrap key unwritten, so the fitting window's own drone bay list still
    // gets its dogma.
    if (!initialLoginSpaceShipInventoryList) {
      this._primeInSpaceBayDogmaItems(
        session,
        boundContext,
        ITEM_FLAGS.DRONE_BAY,
        itemsForContainer,
      );
    }
    const dockedShipDefaultList = Boolean(
      boundContext &&
      boundContext.kind === "shipInventory" &&
      requestedFlag === null &&
      this._getStationId(session) > 0
    );
    const controlledStructureDefaultList = Boolean(
      requestedFlag === null &&
      this._usesControlledStructureInventorySemantics(
        session,
        requestedFlag,
        boundContext,
      )
    );
    const itemOverrides = itemsForContainer
      .map((item) => this._buildInventoryItemOverrides(session, item))
      .filter(Boolean)
      .map((overrides) => {
        if (controlledStructureDefaultList) {
          return { ...overrides, customInfo: "" };
        }
        if (
          dockedShipDefaultList &&
          Number(overrides.categoryID) !== 1 &&
          overrides.customInfo === ""
        ) {
          return { ...overrides, customInfo: null };
        }
        return overrides;
      });

    log.debug(`[InvBroker] List ships=${itemOverrides.length}`);
    if (boundContext && boundContext.kind === "shipInventory") {
      const listSummary = this._summarizeInventoryRowsForLog(itemsForContainer);
      log.debug(
        `[InvBroker] shipInventory List summary shipID=${Number(boundContext.inventoryID) || 0} ` +
        `requestedFlag=${requestedFlag === null ? "None" : requestedFlag} ` +
        `initialLogin=${initialLoginSpaceShipInventoryList} ` +
        `total=${listSummary.total} cargo=${listSummary.cargo} modules=${listSummary.modules} ` +
        `charges=${listSummary.charges} drones=${listSummary.drones} others=${listSummary.others} ` +
        `preview=${listSummary.preview.join("|")} ` +
        `${describeSessionHydrationState(session, boundContext.inventoryID)}`,
      );
    }
    this._traceInventory("ListResult", session, {
      requestedFlag,
      count: itemOverrides.length,
      firstLine: itemOverrides[0] || null,
    });
    // Tranquility answers a List with a flag as a Python set, rows or none (55 of 55 in its recordings: set([]) and
    // set([<DBRow ...>, ...])); the client's inventory cache takes either (invCacheContainer.List iterates it).
    const shouldReturnPythonSet =
      (requestedFlag !== null && requestedFlag !== undefined) ||
      dockedShipDefaultList;
    const result = shouldReturnPythonSet
      ? this._buildInventoryRemoteSet(itemOverrides)
      : this._buildInventoryRemoteList(itemOverrides);
    // A bind alone is not an inventory subscription: secure containers,
    // Mobile Depots and shared ship service bays perform their real
    // authorization during List. Only retain live row eligibility after that
    // List completed; fanout repeats the checks in case access later changes.
    this._markCurrentBoundLiveInventoryListAuthorized(
      session,
      boundContext,
      [requestedFlag],
    );
    this._markCurrentBoundCorporationOfficeListAuthorized(
      session,
      boundContext,
      requestedFlag,
    );
    if (
      this._shouldPrimeLoginShipInventoryBootstrap(session, boundContext, {
        initialLoginSpaceShipInventoryList,
        requestedFlag,
      })
    ) {
      this._primePendingSpaceShipInventoryBootstrap(session, boundContext, {
        requestedFlag,
        reason: "invbroker.List.postResult",
      });
    }
    return result;
  }

  Handle_ListByFlags(args, session, kwargs) {
    if (this._getBoundContext(session)?.kind === "tradeInventory") return this._dispatchTradeInventory("ListByFlags", args, session, kwargs);
    const boundContext = this._getBoundContext(session);
    const rawFlags =
      (args && args.length > 0 ? args[0] : null) ??
      this._extractKwarg(kwargs, "flags") ??
      [];
    const requestedFlags = this._normalizeFlagList(rawFlags);
    const seenItemIds = new Set();
    const itemOverrides = [];
    const dogmaPrimeItems = [];

    this._traceInventory("ListByFlags", session, {
      args,
      kwargs,
      requestedFlags,
    });
    log.debug(
      `[InvBroker] ListByFlags(flags=${requestedFlags.join(",")}) bound=${JSON.stringify(boundContext)}`,
    );

    for (const requestedFlag of requestedFlags) {
      const resolvedItems = this._resolveContainerItems(
        session,
        requestedFlag,
        boundContext,
      );
      dogmaPrimeItems.push(...resolvedItems);
      // Same fitted-charge identity as Handle_List: real charge rows are
      // stripped and replaced with (shipID, flagID, chargeTypeID) tuples. This
      // IS reachable for the active ship while docked — the retail hangar ship
      // card (eve/client/script/ui/shared/itemShip.py ShipItemIcon._update_items,
      // whose _should_display returns True for session.shipid) calls
      // ListByFlags with the ship's fitting flags, as does
      // inventoryutil.client.inventory.is_item_in_current_ship.
      //
      // Leaving the real row here is not merely inconsistent, it duplicates the
      // slot: invCache.ListByFlags caches every returned row by itemID and THEN
      // overlays godma's sublocations by tuple itemID, so both land in
      // cachedItems and both come back from the filter. _get_type_quantities_in_location
      // sums stacksize over that rowset, so a docked ammo count reads double.
      //
      // The tuple builder answers for the whole ship (requestedFlag null), so
      // narrow its rows to the flag being listed.
      //
      // ShipItemIcon lists other hangar ships too, and those keep their real
      // fitted charge rows: _ownsLoadedChargeTupleIdentity leaves any
      // non-active ship's listing untouched, so the merge is a no-op there.
      const itemsForFlag = this._mergeActiveShipLoadedChargeTupleRows(
        session,
        boundContext,
        null,
        resolvedItems,
      ).filter((item) => (
        !this._isChargeTupleItemID(item && item.itemID) ||
        this._normalizeInventoryId(item.flagID, 0) === requestedFlag
      ));
      for (const item of itemsForFlag) {
        const rawItemID = item.itemID || item.shipID;
        // Tuple itemIDs are fresh arrays every call, so a Set of raw values can
        // never dedupe them. Key on their contents instead.
        const seenKey = this._isChargeTupleItemID(rawItemID)
          ? `tuple:${rawItemID.map((entry) => this._normalizeInventoryId(entry, 0)).join(":")}`
          : rawItemID;
        if (seenItemIds.has(seenKey)) {
          continue;
        }

        seenItemIds.add(seenKey);
        const itemOverridesForRecord = this._buildInventoryItemOverrides(
          session,
          item,
        );
        if (itemOverridesForRecord) {
          itemOverrides.push(itemOverridesForRecord);
        }
      }
    }
    this._primeInSpaceBayDogmaItems(
      session,
      boundContext,
      ITEM_FLAGS.DRONE_BAY,
      dogmaPrimeItems,
    );

    this._traceInventory("ListByFlagsResult", session, {
      requestedFlags,
      count: itemOverrides.length,
      firstLine: itemOverrides[0] || null,
    });
    // Tranquility answers ListByFlags as a Python set, as it answers a flagged List.
    const result = this._buildInventoryRemoteSet(itemOverrides);
    this._markCurrentBoundLiveInventoryListAuthorized(
      session,
      boundContext,
      requestedFlags,
    );
    this._markCurrentBoundCorporationOfficeListAuthorized(
      session,
      boundContext,
      requestedFlags,
    );
    if (
      this._shouldPrimeLoginShipInventoryBootstrap(session, boundContext, {
        requestedFlags,
      })
    ) {
      this._primePendingSpaceShipInventoryBootstrap(session, boundContext, {
        requestedFlags,
        reason: "invbroker.ListByFlags.postResult",
      });
    }
    return result;
  }

  Handle_GetItem(args, session) {
    if (this._getBoundContext(session)?.kind === "tradeInventory") return this._dispatchTradeInventory("GetItem", args, session);
    const boundContext = this._getBoundContext(session);
    if (boundContext?.kind === "incursionCargoReceiver") {
      const item = incursionCargo.receiverItem(session, boundContext.inventoryID);
      return item ? this._buildInvItem(session, item) : null;
    }
    if (boundContext?.kind === "fracturedLegacyReceiver") {
      const item = fracturedLegacyCargo.receiverItem(session, boundContext.inventoryID);
      return item ? this._buildInvItem(session, item) : null;
    }
    const itemID =
      args && args.length > 0
        ? args[0]
        : boundContext && boundContext.inventoryID
          ? boundContext.inventoryID
          : this._getShipId(session);
    this._traceInventory("GetItem", session, {
      args,
      resolvedItemID: itemID,
    });
    log.debug(`[InvBroker] GetItem(itemID=${itemID})`);

    const numericItemID = this._normalizeInventoryId(itemID);
    if (
      this._isPendingStructureUnanchorContainerInventoryID(numericItemID)
    ) {
      this._throwPendingStructureUnanchorContainerInventoryError();
    }
    const isCharacterItem = numericItemID === this._getCharacterId(session);
    const skillRecord = this._findCharacterSkillRecord(session, numericItemID);
    const shipRecord = findCharacterShip(
      this._getCharacterId(session),
      numericItemID,
    );
    const overrides = isCharacterItem
      ? this._buildCharacterItemOverrides(session)
      : shipRecord || skillRecord
        ? this._itemOverridesFromId(session, numericItemID)
        : this._buildContainerItemOverrides(session, numericItemID);

    return this._buildInvItem(session, overrides);
  }

  Handle_GetItemByID(args, session) {
    return this.Handle_GetItem(args, session);
  }

  Handle_GetItems(args, session) {
    const ids = args && args.length > 0 && Array.isArray(args[0]) ? args[0] : [];
    this._traceInventory("GetItems", session, { args });
    log.debug(`[InvBroker] GetItems(count=${ids.length})`);
    if (
      ids.some((itemID) =>
        this._isPendingStructureUnanchorContainerInventoryID(itemID),
      )
    ) {
      this._throwPendingStructureUnanchorContainerInventoryError();
    }

    const items = ids.map((id) =>
      this._buildInvItem(session, this._itemOverridesFromId(session, id)),
    );
    return { type: "list", items };
  }

  _extractCrystalDamageItemIDs(rawValue) {
    const unwrapped = unwrapMarshalValue(rawValue);
    const itemIDs = new Set();
    const visit = (value) => {
      if (value === null || value === undefined) {
        return;
      }
      if (Array.isArray(value)) {
        for (const entry of value) {
          visit(entry);
        }
        return;
      }
      if (value instanceof Set) {
        for (const entry of value) {
          visit(entry);
        }
        return;
      }
      const numericValue = Number(value);
      if (Number.isFinite(numericValue) && numericValue > 0) {
        itemIDs.add(Math.trunc(numericValue));
      }
    };
    visit(unwrapped);
    return [...itemIDs];
  }

  _getCrystalDamageRatioForItem(item, characterID) {
    if (!item || typeof item !== "object") {
      return null;
    }
    if (Number(item.ownerID) !== Number(characterID)) {
      return null;
    }
    if (Number(getTypeAttributeValue(item.typeID, "crystalsGetDamaged")) <= 0) {
      return null;
    }
    return require("../dogma/crystalDurability").crystalDamageRatio(
      item, Number(getTypeAttributeValue(item.typeID, "hp")),
    );
  }

  Handle_GetDamageForCrystals(args, session) {
    const rawCrystalIDs = args && args.length > 0 ? args[0] : [];
    const crystalIDs = this._extractCrystalDamageItemIDs(rawCrystalIDs);
    const characterID = this._getCharacterId(session);
    this._traceInventory("GetDamageForCrystals", session, {
      count: crystalIDs.length,
    });

    return buildDict(
      crystalIDs
        .map((itemID) => {
          const damageRatio = this._getCrystalDamageRatioForItem(
            findItemById(itemID),
            characterID,
          );
          return damageRatio === null ? null : [itemID, damageRatio];
        })
        .filter(Boolean),
    );
  }

  Handle_GetSelfInvItem(args, session) {
    if (this._getBoundContext(session)?.kind === "tradeInventory") return this._dispatchTradeInventory("GetSelfInvItem", args, session);
    const boundContext = this._getBoundContext(session);
    const inventoryID =
      boundContext && boundContext.inventoryID !== null && boundContext.inventoryID !== undefined
        ? boundContext.inventoryID
        : this._getShipId(session);
    if (this._isPendingStructureUnanchorContainerInventoryID(inventoryID)) {
      this._throwPendingStructureUnanchorContainerInventoryError();
    }
    const overrides = this._getStructureForInventoryID(inventoryID)
      ? this._buildStructureItemOverrides(session, inventoryID)
      : this._buildContainerItemOverrides(session, inventoryID);
    this._traceInventory("GetSelfInvItem", session, { args });
    log.debug("[InvBroker] GetSelfInvItem");
    this._traceInventory("GetSelfInvItemResult", session, {
      inventoryID,
      overrides,
    });
    if (
      this._shouldPrimeLoginShipInventoryBootstrap(session, boundContext, {
        requestedFlag: null,
      })
    ) {
      this._primePendingSpaceShipInventoryBootstrap(session, boundContext, {
        requestedFlag: null,
        reason: "invbroker.GetSelfInvItem",
      });
    }
    return this._buildInventoryPackedRow(overrides);
  }

  Handle_GetContainerContents(args, session) {
    const containerID =
      args && args.length > 0 ? args[0] : this._getStationId(session);
    const locationID = args && args.length > 1 ? args[1] : containerID;
    const numericContainerID = this._normalizeInventoryId(containerID);
    const safetyWrap = this._getAssetSafetyAncestorWrap(numericContainerID);
    if (safetyWrap) {
      const items = this._getAccessibleAssetSafetyInventoryWrap(session, numericContainerID)
        ? listContainerItems(null, numericContainerID, null) : [];
      return this._buildInventoryRowset(items.map(item =>
        this._buildInvRow(session, this._buildInventoryItemOverrides(session, item))));
    }
    const stationId = this._getStationId(session);
    const corporationOffice = this._getCorporationOffice(session, numericContainerID);
    const genericContainerRecord = findItemById(numericContainerID);
    const corporationContainerContext =
      this._getCorporationOfficeDivisionAncestorContext(
        session,
        genericContainerRecord,
      );
    this._ensureSecureContainerGeneralAccess(session, numericContainerID);
    const mobileDepotAccessError = this._getMobileDepotCargoAccessError(
      session,
      numericContainerID,
    );
    const mobileTractorUnitAccessError =
      this._getMobileTractorUnitCargoAccessError(session, numericContainerID);
    const scopeAccessError = this._getSpaceContainerScopeAccessError(
      session,
      numericContainerID,
    );
    // View Contents reads the same rows List() serves, so it needs the same
    // ownership gate — without it the window answered a full listing of any
    // character's hangar container to anyone who named its itemID.
    const personalHangarAccessError = corporationOffice
      ? null
      : this._getPersonalHangarContainerAccessError(
          session,
          genericContainerRecord,
        );
    const corporationContainerAccessError =
      corporationContainerContext &&
      !this._hasLocalCorporationOfficeDivisionQueryAccess(
        session,
        corporationContainerContext,
      );
    this._traceInventory("GetContainerContents", session, { args });
    log.debug(
      `[InvBroker] GetContainerContents(containerID=${numericContainerID}, locationID=${locationID})`,
    );
    if (this._isUnanchoredStructureHullInventoryID(numericContainerID)) {
      return this._buildInventoryRowset([]);
    }
    if (
      this._isPendingStructureUnanchorContainerInventoryID(numericContainerID)
    ) {
      this._throwPendingStructureUnanchorContainerInventoryError();
    }
    if (mobileDepotAccessError) {
      log.debug(
        `[InvBroker] Mobile Depot contents denied container=${numericContainerID} error=${mobileDepotAccessError}`,
      );
    }
    if (mobileTractorUnitAccessError) {
      log.debug(
        `[InvBroker] Mobile Tractor Unit contents denied container=${numericContainerID} error=${mobileTractorUnitAccessError}`,
      );
    }
    if (personalHangarAccessError) {
      log.debug(
        `[InvBroker] Hangar container contents denied container=${numericContainerID} error=${personalHangarAccessError}`,
      );
    }

    const nativeWreckRecord = this._getNativeWreckRecord(numericContainerID);
    const items =
      mobileDepotAccessError ||
        mobileTractorUnitAccessError ||
        scopeAccessError ||
        personalHangarAccessError ||
        corporationContainerAccessError
        ? []
        :
      numericContainerID === this._getCharacterId(session)
        ? this._getCharacterContainerItems(session, null)
        :
      corporationOffice
        ? this._listCorporationOfficeItems(session, corporationOffice, null)
        :
      isStarbaseCorporateHangarArrayType(genericContainerRecord)
        ? this._listStarbaseCorporationHangarItems(
            session,
            genericContainerRecord,
            null,
          )
        :
      numericContainerID === stationId
        ? listContainerItems(
            this._getCharacterId(session),
            stationId,
            ITEM_FLAGS.HANGAR,
          )
        : nativeWreckRecord
          ? nativeNpcStore.buildNativeWreckContents(numericContainerID)
        : isMobileDepotItemRecord(genericContainerRecord)
          ? listContainerItems(
              null,
              numericContainerID,
              null,
            )
        : listContainerItems(
            this._getGenericContainerContentsOwnerID(session, genericContainerRecord),
            numericContainerID,
            null,
          );

    this._traceInventory("GetContainerContentsResult", session, {
      containerID: numericContainerID,
      count: items.length,
      firstItem: items[0] || null,
    });
    return this._buildInventoryRowset(
      items
        .map((item) => this._buildInventoryItemOverrides(session, item))
        .filter(Boolean)
        .map((overrides) => this._buildInvRow(session, overrides)),
    );
  }

  Handle_GetCapacity(args, session, kwargs) {
    const boundContext = this._getBoundContext(session);
    if (boundContext) {
      this._ensureSecureContainerGeneralAccess(
        session,
        boundContext.inventoryID,
      );
    }
    const requestedFlag =
      (args && args.length > 0 ? args[0] : null) ??
      this._extractKwarg(kwargs, "flag") ??
      (boundContext ? boundContext.flagID : null);
    this._traceInventory("GetCapacity", session, {
      args,
      kwargs,
      requestedFlag,
    });
    log.debug(
      `[InvBroker] GetCapacity(flag=${String(requestedFlag)}) bound=${JSON.stringify(boundContext)}`,
    );
    return this._calculateCapacity(session, boundContext, requestedFlag);
  }

  Handle_StackAll(args, session, kwargs) {
    this._traceInventory("StackAll", session, { args, kwargs });
    const boundContext = this._getBoundContext(session);
    const requestedFlag =
      (args && args.length > 0 ? args[0] : null) ??
      this._extractKwarg(kwargs, "flag") ??
      (boundContext ? boundContext.flagID : null);
    const containerID = this._normalizeInventoryId(
      boundContext && boundContext.inventoryID,
      this._getStationId(session),
    );
    this._ensureSecureContainerGeneralAccess(session, containerID);
    const customsError = this._getCustomsOfficeTransferAccessError(session, containerID);
    if (customsError) this._throwSpaceContainerScopeAccessError(customsError);
    const flagID =
      requestedFlag === null || requestedFlag === undefined
        ? boundContext && boundContext.flagID !== null && boundContext.flagID !== undefined
          ? this._normalizeInventoryId(boundContext.flagID, ITEM_FLAGS.HANGAR)
          : ITEM_FLAGS.HANGAR
        : this._normalizeInventoryId(requestedFlag, ITEM_FLAGS.HANGAR);
    const stackEveryFlag = requestedFlag === null || requestedFlag === undefined;
    const boundContainer = findItemById(containerID);
    const isContainerBinding = Boolean(boundContext && (
      boundContext.kind === "container" ||
      (boundContext.kind === "inventory" && boundContainer &&
        !findShipItemById(containerID))
    ));
    if (isContainerBinding) {
      if (
        boundContainer &&
        this._isPersistedSpaceInventoryRecord(boundContainer) &&
        this._isProtectedPlayerSpaceLootInventoryItem(boundContainer) &&
        !this._sessionHasPlayerSpaceContainerLootRight(session, boundContainer)
      ) {
        return null;
      }
    }
    const items = this._resolveContainerItems(session, stackEveryFlag ? null : flagID, {
      ...(boundContext || {}),
      inventoryID: containerID,
    })
      // Only genuinely stackable rows take part, as candidates AND as merge
      // destinations. Blueprint copies (singleton 2) share their typeID with
      // the original, so leaving them in let one click fold a hangar's copies
      // into a packaged stack; excluding them also stops the lowest-itemID
      // destination pick from landing on a copy and blocking the real stacks.
      .filter(
        (item) =>
          isStackableInventoryItem(item) &&
          this._normalizeInventoryId(item.flagID, 0) !== ITEM_FLAGS.LOCKED,
      )
      .sort((left, right) => (Number(left.itemID) || 0) - (Number(right.itemID) || 0));
    const stacksByType = new Map();
    const allChanges = [];
    const stackNotifications = [];
    let mergedCount = 0;

    log.debug(
      `[InvBroker] StackAll container=${containerID} flag=${stackEveryFlag ? "all" : flagID} count=${items.length}`,
    );

    for (const item of items) {
      // Keyed by owner as well as type because custody refuses a cross-owner
      // merge outright. A container can hold rows from several owners — a ship
      // service bay lists every depositor's rows now, and a guest has always
      // seen them — and keying on type alone let the lowest-itemID row claim the
      // type and silently strand every other owner's stacks unmerged.
      const itemFlag = this._normalizeInventoryId(item.flagID, 0);
      // Flag 0 and hangar are one compartment in a general container.
      const compartmentFlag = isContainerBinding && itemFlag === 0
        ? ITEM_FLAGS.HANGAR : itemFlag;
      const stackKey = `${this._normalizeInventoryId(item.typeID, 0)}:` +
        `${this._normalizeInventoryId(item.ownerID, 0)}:${compartmentFlag}`;
      if (!stacksByType.has(stackKey)) {
        stacksByType.set(stackKey, item.itemID);
        continue;
      }

      const destinationItemID = stacksByType.get(stackKey);
      const mergeResult = invBrokerItemCustody.mergeStacks({
        sourceItem: item,
        destinationItem: findItemById(destinationItemID),
        actor: this._getCharacterId(session),
      });
      if (!mergeResult.success) {
        continue;
      }

      mergedCount += 1;
      const mergeChanges = (mergeResult.data && mergeResult.data.changes) || [];
      allChanges.push(...mergeChanges);
      // Recorded StackAll consumes the source first at junk location10,
      // retaining its quantity. MultiMerge's quantity-zero row is a different
      // contract; keep both projections local to their respective handlers.
      for (const itemID of [item.itemID, destinationItemID]) {
        const change = mergeChanges.find(entry => entry.item.itemID === itemID);
        if (!change) continue;
        const isSource = itemID === item.itemID;
        stackNotifications.push({
          change: isSource && change.removed
            ? { ...change, item: { ...change.previousData, locationID: 10 } }
            : change,
          locationContext: !isSource && boundContext?.kind === "stationHangar" &&
            this._getStructureForInventoryID(containerID) &&
            Number(change.item.ownerID) === this._getCharacterId(session) &&
            Number(change.item.flagID) === ITEM_FLAGS.HANGAR
              ? ["Structure", containerID, "StructureItemHangar"]
              : null,
        });
      }
    }

    if (mergedCount <= 0) {
      return null;
    }

    for (const { change, locationContext } of stackNotifications) {
      this._emitInventoryMoveChanges(session, [change], {
        emitItemsChangedBatch: true,
        idType: "charid",
        locationContext,
      });
    }
    this._refreshBallparkShipPresentation(session, allChanges);
    this._refreshBallparkInventoryPresentation(session, allChanges);
    return null;
  }

  Handle_MultiMerge(args, session, kwargs) {
    this._traceInventory("MultiMerge", session, { args, kwargs });
    const ops = this._normalizeMergeOps(args && args.length > 0 ? args[0] : []);
    // This synchronous merge caller cannot settle Add's async safety charge.
    // Require the explicit recovery move first, rather than start an unawaited
    // withdrawal or merge directly across the wrap's custody boundary.
    if (this._hasAssetSafetyRecoverySource(ops.flatMap((op) => [op.sourceItemID, op.destinationItemID]))) {
      throwWrappedUserError("CustomNotify", {
        notify: "Recover asset safety items to a personal inventory before merging stacks.",
      });
    }
    const sourceContainerID = this._normalizeInventoryId(
      args && args.length > 1 ? args[1] : 0,
      0,
    );
    const boundContext = this._getBoundContext(session);
    const boundInventoryID = this._normalizeInventoryId(
      boundContext && boundContext.inventoryID,
      0,
    );
    if (boundContext) {
      this._ensureSecureContainerGeneralAccess(
        session,
        boundContext.inventoryID,
      );
    }
    this._ensureSecureContainerGeneralAccess(session, sourceContainerID);
    if (
      this._getMobileTractorUnitCargoAccessError(session, boundInventoryID) ||
      this._getMobileTractorUnitCargoAccessError(session, sourceContainerID)
    ) {
      return null;
    }
    const allChanges = [];
    let mergedCount = 0;

    log.debug(
      `[InvBroker] MultiMerge opCount=${ops.length} sourceContainerID=${sourceContainerID}`,
    );

    if (
      !boundContext ||
      boundInventoryID <= 0 ||
      sourceContainerID <= 0 ||
      this._isPendingStructureUnanchorContainerInventoryID(sourceContainerID)
    ) {
      if (!boundContext || boundInventoryID <= 0 || sourceContainerID <= 0) {
        return null;
      }
      this._throwPendingStructureUnanchorContainerInventoryError();
    }
    const currentDockedLocationID = this._normalizeInventoryId(
      this._getStationId(session),
      0,
    );
    const currentCorporationOffice = boundContext.kind === "corpOffice"
      ? this._getCorporationOfficeAtLocation(session, currentDockedLocationID)
      : null;
    if (
      (
        boundContext.kind === "stationHangar" &&
        (
          currentDockedLocationID <= 0 ||
          boundInventoryID !== currentDockedLocationID
        )
      ) ||
      (
        boundContext.kind === "corpOffice" &&
        (
          !currentCorporationOffice ||
          this._normalizeInventoryId(currentCorporationOffice.officeID, 0) !==
            boundInventoryID
        )
      )
    ) {
      return null;
    }
    // Every bay of a ship shares one binding. The client caches inventories by
    // itemID alone (invCache.GetInventoryFromId) and opens each bay through that
    // one entry, while GetInventoryFromId binds a ship with the cargo flag. The
    // bay a merge happens in therefore comes from the stacks, not the binding.
    // A pilot who reaches someone else's ship through a ship service is held to
    // the service bays, which the per-stack check below enforces.
    let shipServiceBaysOnly = false;
    if (boundContext.kind === "shipInventory") {
      const boundShip = findShipItemById(boundInventoryID);
      const boundShipOwnerID = this._normalizeInventoryId(
        boundShip && boundShip.ownerID,
        0,
      );
      const characterID = this._normalizeInventoryId(this._getCharacterId(session), 0);
      const corporationID = this._normalizeInventoryId(this._getCorporationId(session), 0);
      const activeShipID = this._normalizeInventoryId(this._getShipId(session), 0);
      const dockedShipIsLocal = Boolean(
        isDockedSession(session) &&
        currentDockedLocationID > 0 &&
        this._normalizeInventoryId(boundShip && boundShip.locationID, 0) ===
          currentDockedLocationID
      );
      const directShipAccess = Boolean(
        [characterID, corporationID].includes(boundShipOwnerID) &&
        (dockedShipIsLocal || activeShipID === boundInventoryID)
      );
      const remoteShipServicePossible = Boolean(
        !isDockedSession(session) &&
        activeShipID !== boundInventoryID
      );
      if (!boundShip || (!directShipAccess && !remoteShipServicePossible)) {
        return null;
      }
      shipServiceBaysOnly = !directShipAccess;
    }
    if (boundContext.kind === "container") {
      const boundContainer = findItemById(boundInventoryID);
      const rewardContainerState = this._readAbyssalRewardContainerState(
        boundContainer,
      );
      if (!boundContainer) {
        return null;
      }
      if (
        this._getInventoryCustodyAccessError(
          session,
          { locationID: boundInventoryID, flagID: null },
          { direction: "view" },
        )
      ) {
        return null;
      }
      if (!this._isPersistedSpaceInventoryRecord(boundContainer)) {
        const containerOwnerID = this._normalizeInventoryId(
          boundContainer.ownerID,
          0,
        );
        const characterID = this._normalizeInventoryId(this._getCharacterId(session), 0);
        const corporationID = this._normalizeInventoryId(this._getCorporationId(session), 0);
        if (
          !rewardContainerState &&
          ![characterID, corporationID].includes(containerOwnerID)
        ) {
          return null;
        }
        const containerAncestorChain = this._getInventoryItemAncestorChain(
          boundInventoryID,
        );
        const activeShipID = this._normalizeInventoryId(this._getShipId(session), 0);
        const containerRootLocationID = this._resolveInventoryRootLocationID(
          boundContainer,
        );
        const rootCorporationOffice = this._getCorporationOfficeForItemLocation(
          session,
          containerRootLocationID,
        );
        const accessibleAtDockedLocation = Boolean(
          currentDockedLocationID > 0 &&
          (
            containerRootLocationID === currentDockedLocationID ||
            this._normalizeInventoryId(
              rootCorporationOffice && rootCorporationOffice.stationID,
              0,
            ) === currentDockedLocationID
          )
        );
        const accessibleInActiveShip = Boolean(
          activeShipID > 0 &&
          containerAncestorChain.some((ancestor) =>
            this._normalizeInventoryId(ancestor && ancestor.itemID, 0) === activeShipID,
          )
        );
        if (!accessibleAtDockedLocation && !accessibleInActiveShip) {
          return null;
        }
      } else if (
        this._isProtectedPlayerSpaceLootInventoryItem(boundContainer) &&
        !this._sessionHasPlayerSpaceContainerLootRight(session, boundContainer)
      ) {
        return null;
      }
    }
    const preparedOps = [];
    const reservedSourceQuantities = new Map();
    const reservedDestinationQuantities = new Map();
    const reservedVolumeByDestinationFlag = new Map();
    let isLootMerge = false;
    for (const op of ops) {
      // The client offers a merge for a stack dropped from any other bay or
      // container, a native NPC wreck included (invControllers.py
      // BaseInvContainer.MultiMerge), so the source is looked up the way Add
      // looks it up.
      const sourceItemDescriptor = this._findTransferSourceItem(
        op.sourceItemID,
        sourceContainerID,
      );
      const sourceItem = sourceItemDescriptor && sourceItemDescriptor.item;
      const destinationItem = findItemById(op.destinationItemID);
      const destinationItemDescriptor = destinationItem
        ? { sourceKind: "inventory", item: destinationItem }
        : null;
      if (!sourceItem || !destinationItemDescriptor) {
        return null;
      }
      const sourceIsInventoryItem = sourceItemDescriptor.sourceKind === "inventory";
      const sourceLocationID = this._normalizeInventoryId(sourceItem.locationID, 0);
      const sourceFlagID = this._normalizeInventoryId(sourceItem.flagID, 0);
      const destinationLocationID = this._normalizeInventoryId(
        destinationItem.locationID,
        0,
      );
      const destinationFlagID = this._normalizeInventoryId(destinationItem.flagID, 0);
      const sameHold = Boolean(
        sourceIsInventoryItem &&
        sourceLocationID === destinationLocationID &&
        sourceFlagID === destinationFlagID
      );
      if (
        (sourceIsInventoryItem && sourceLocationID !== sourceContainerID) ||
        destinationLocationID !== boundInventoryID
      ) {
        log.debug(
          `[InvBroker] MultiMerge rejected source=${op.sourceItemID} destination=${op.destinationItemID} error=CONTAINER_MISMATCH`,
        );
        return null;
      }
      if (shipServiceBaysOnly) {
        if (
          !isShipServiceFlag(destinationFlagID) ||
          this._getShipServiceAccessError(
            session,
            boundInventoryID,
            destinationFlagID,
          )
        ) {
          return null;
        }
      } else if (
        boundContext.kind !== "shipInventory" &&
        boundContext.flagID !== null &&
        boundContext.flagID !== undefined &&
        destinationFlagID !== this._normalizeInventoryId(boundContext.flagID, 0)
      ) {
        return null;
      }
      const characterID = this._normalizeInventoryId(this._getCharacterId(session), 0);
      const corporationID = this._normalizeInventoryId(this._getCorporationId(session), 0);
      // A stack dropped in from elsewhere is taken through Add below, and Add
      // owns every rule for taking an item. Only the stacks already in this
      // inventory answer to its ownership here.
      const heldStacks = sameHold ? [sourceItem, destinationItem] : [destinationItem];
      if (
        (
          ["stationHangar", "characterInventory"].includes(boundContext.kind) &&
          heldStacks.some((stackItem) =>
            this._normalizeInventoryId(stackItem.ownerID, 0) !== characterID
          )
        ) ||
        (
          boundContext.kind === "corpOffice" &&
          heldStacks.some((stackItem) =>
            this._normalizeInventoryId(stackItem.ownerID, 0) !== corporationID ||
            !this._canQueryCorporationHangarFlag(session, stackItem.flagID)
          )
        )
      ) {
        return null;
      }
      this._ensureAuditContainerItemUnlocked(sourceItem);
      this._ensureAuditContainerItemUnlocked(destinationItem);
      this._ensureSecureContainerGeneralAccess(
        session,
        sourceItem && sourceItem.locationID,
      );
      this._ensureSecureContainerGeneralAccess(
        session,
        destinationItem && destinationItem.locationID,
      );
      if (
        this._getPendingStructureUnanchorContainerAncestor(sourceItem) ||
        this._getPendingStructureUnanchorContainerAncestor(destinationItem)
      ) {
        this._throwPendingStructureUnanchorContainerInventoryError();
      }
      const sourceAccess = this._validateDeclaredTransferSourceAccess(
        session,
        sourceItemDescriptor,
        sourceContainerID,
        destinationItem.locationID,
      );
      this._ensureInventoryCustodyTransferAccess(session, sourceItemDescriptor, {
        locationID: destinationItem.locationID, flagID: destinationItem.flagID,
      });
      const destinationAccess = this._validateDeclaredTransferSourceAccess(
        session,
        destinationItemDescriptor,
        boundInventoryID,
        sourceItem.locationID,
      );
      if (!sourceAccess.success || !destinationAccess.success) {
        const failedAccess = !sourceAccess.success ? sourceAccess : destinationAccess;
        log.debug(
          `[InvBroker] MultiMerge rejected source=${op.sourceItemID} destination=${op.destinationItemID} container=${failedAccess.containerID || 0} error=${failedAccess.errorMsg}`,
        );
        if (
          failedAccess.errorMsg === "CONTAINER_NOT_VISIBLE" ||
          failedAccess.errorMsg === "CONTAINER_TOO_FAR" ||
          failedAccess.errorMsg === "CONTAINER_NOT_HACKED" ||
          String(failedAccess.errorMsg || "").startsWith("CUSTOMS_OFFICE_") ||
          String(failedAccess.errorMsg || "").startsWith("ABYSSAL_REWARD_")
        ) {
          let failedSide = failedAccess.side || "source";
          // The destination ancestry check reverses the two stacks. Restore
          // the user's transfer direction before choosing the refusal text.
          if (sourceAccess.success) {
            failedSide = failedSide === "source" ? "destination" : "source";
          }
          this._throwSpaceContainerScopeAccessError(
            failedAccess.errorMsg,
            failedSide === "destination" ? "add" : "loot",
          );
        }
        return null;
      }
      let moveQuantity = null;
      if (!sameHold) {
        // Loaded charges never take this path: the client unloads them itself
        // (invCache.MultiMerge hands their tuple IDs to UnloadAmmoToContainer),
        // and a fitting slot holds no stack to drop onto.
        if (
          isShipFittingFlag(sourceFlagID) ||
          isShipFittingFlag(destinationFlagID) ||
          !isStackableInventoryItem(sourceItem) ||
          !isStackableInventoryItem(destinationItem) ||
          this._normalizeInventoryId(sourceItem.typeID, 0) !==
            this._normalizeInventoryId(destinationItem.typeID, 0)
        ) {
          log.debug(
            `[InvBroker] MultiMerge rejected source=${op.sourceItemID} destination=${op.destinationItemID} error=STACK_REQUIRED`,
          );
          continue;
        }
        const reservedSourceQuantity =
          reservedSourceQuantities.get(op.sourceItemID) || 0;
        const reservedDestinationQuantity =
          reservedDestinationQuantities.get(op.destinationItemID) || 0;
        const availableSourceQuantity = Math.max(
          0,
          this._getStackableQuantity(sourceItem) - reservedSourceQuantity,
        );
        // A merge never grows a stack past the client's stack limit, so only
        // what the destination stack can still take is moved.
        const destinationStackRoom = Math.max(
          0,
          CLIENT_INVENTORY_STACK_LIMIT -
            this._getStackableQuantity(destinationItem) -
            reservedDestinationQuantity,
        );
        moveQuantity = Math.min(
          op.quantity === null ? availableSourceQuantity : op.quantity,
          availableSourceQuantity,
          destinationStackRoom,
        );
        if (moveQuantity <= 0) {
          continue;
        }
        // Check the whole drop against the hold before anything moves. On a
        // single stack the client answers a capacity error with a quantity
        // prompt and merges what fits (BaseInvContainer.MultiMerge).
        const destination = {
          locationID: boundInventoryID,
          flagID: destinationFlagID,
        };
        const reservedVolume =
          reservedVolumeByDestinationFlag.get(destinationFlagID) || 0;
        const capacityCheck = this._checkCapacityForMove(
          session,
          boundContext,
          destination,
          sourceItem,
          moveQuantity,
          reservedVolume,
        );
        if (!capacityCheck.success) {
          log.debug(
            `[InvBroker] MultiMerge rejected source=${op.sourceItemID} destination=${op.destinationItemID} error=${capacityCheck.errorMsg}`,
          );
          throwWrappedUserError(
            capacityCheck.errorMsg,
            this._buildCapacityMoveUserErrorValues(capacityCheck, sourceItem),
          );
        }
        reservedSourceQuantities.set(
          op.sourceItemID,
          reservedSourceQuantity + moveQuantity,
        );
        reservedDestinationQuantities.set(
          op.destinationItemID,
          reservedDestinationQuantity + moveQuantity,
        );
        reservedVolumeByDestinationFlag.set(
          destinationFlagID,
          reservedVolume + this._getItemMoveVolume(sourceItem, moveQuantity),
        );
      }
      if (!sameHold && !isLootMerge) {
        // A stack dragged out of a player space container into the ship is
        // relocated there by Handle_Add, which announces the arrival over the
        // shipid OnItemsChanged loot-move channel. Latch that so the finally
        // block announces the merge — including the consumed source's removal —
        // over the same channel. A clientID OnItemChange removal never
        // reconciles the shipid arrival, so the client keeps drawing the
        // phantom source stack until a full refetch.
        isLootMerge = this._isPlayerSpaceContainerLootMove(
          session,
          sourceContainerID,
          { locationID: destinationLocationID, flagID: destinationFlagID },
        );
      }
      preparedOps.push({ ...op, sameHold, moveQuantity });
    }

    const sameHoldOnly = preparedOps.every((op) => op.sameHold);
    const sameHoldNotifications = [];
    try {
      for (const op of preparedOps) {
        let sourceItem = null;
        let mergeQuantity = op.quantity;
        if (op.sameHold) {
          sourceItem = findItemById(op.sourceItemID);
        } else {
          const dropTarget = findItemById(op.destinationItemID);
          if (!dropTarget) {
            continue;
          }
          // Moving the dropped stack is an ordinary Add into the destination
          // bay, so corporation roles, loot rights and Crimewatch, bay
          // restrictions and capacity apply exactly as they do to any drop.
          const movedItemID = this.Handle_Add(
            [op.sourceItemID, sourceContainerID],
            session,
            { flag: dropTarget.flagID, qty: op.moveQuantity },
          );
          sourceItem = movedItemID ? findItemById(movedItemID) : null;
          mergeQuantity = Math.min(
            op.moveQuantity,
            this._getStackableQuantity(sourceItem),
          );
        }
        const destinationItem = findItemById(op.destinationItemID);
        if (!sourceItem || !destinationItem) {
          continue;
        }
        // Refuse the pair outright when either side is individually identified.
        // The store refuses too, but naming it here keeps the reason in the log
        // instead of surfacing as a silent merge failure.
        if (
          !isStackableInventoryItem(sourceItem) ||
          !isStackableInventoryItem(destinationItem)
        ) {
          log.debug(
            `[InvBroker] MultiMerge rejected source=${op.sourceItemID} destination=${op.destinationItemID} error=STACK_REQUIRED`,
          );
          continue;
        }

        const mergeResult = invBrokerItemCustody.mergeStacks({
          sourceItem,
          destinationItem,
          quantity: mergeQuantity,
          actor: this._getCharacterId(session),
        });
        if (!mergeResult.success) {
          continue;
        }

        mergedCount += 1;
        const mergeChanges = (mergeResult.data && mergeResult.data.changes) || [];
        allChanges.push(...mergeChanges);
        if (sameHoldOnly) {
          // Unknown Events Level 2.txt129838/129843: same-hold merges announce
          // the source first, at its original custody with zero remaining
          // stack size when consumed. Keep the store's shared removal policy
          // unchanged for other inventory operations.
          for (const itemID of [op.sourceItemID, op.destinationItemID]) {
            const change = mergeChanges.find((entry) => entry.item.itemID === itemID);
            if (!change) {
              continue;
            }
            const isSource = itemID === op.sourceItemID;
            sameHoldNotifications.push({
              change: isSource && change.removed
                ? {
                    ...change,
                    item: { ...change.previousData, quantity: 0, stacksize: 0 },
                  }
                : change,
              locationContext: !isSource && boundContext.kind === "stationHangar"
                ? ["Station", boundInventoryID, "StationItems"]
                : null,
            });
          }
        }
      }
    } finally {
      // Add announces each stack it moves as it goes, so the merges finished
      // before a later drop throws must be announced too.
      if (mergedCount > 0) {
        if (sameHoldOnly) {
          for (const { change, locationContext } of sameHoldNotifications) {
            this._emitInventoryMoveChanges(session, [change], {
              emitItemsChangedBatch: true,
              idType: "charid",
              locationContext,
            });
          }
        } else if (isLootMerge) {
          // Match Handle_Add's loot-move channel so the source's arrival and
          // its post-merge removal reconcile on the same shipid inventory cache.
          this._emitInventoryMoveChanges(session, allChanges, {
            emitItemsChangedBatch: true,
            idType: "shipid",
            locationContext: this._buildShipCargoLocationContext(session, {
              locationID: boundInventoryID,
            }),
          });
        } else {
          this._emitInventoryMoveChanges(session, allChanges, { announceItemsChanged: true });
        }
        this._refreshBallparkShipPresentation(session, allChanges);
        this._refreshBallparkInventoryPresentation(session, allChanges);
      }
    }
    return null;
  }

  Handle_Add(args, session, kwargs) {
    if (this._getBoundContext(session)?.kind === "tradeInventory") return this._dispatchTradeInventory("Add", args, session, kwargs);
    this._traceInventory("Add", session, { args, kwargs });
    const boundContext = this._getBoundContext(session);
    const itemID = this._normalizeInventoryId(args && args.length > 0 ? args[0] : 0, 0);
    const sourceLocationID = this._normalizeInventoryId(
      args && args.length > 1 ? args[1] : 0,
      0,
    );
    const explicitFlagValue = this._extractKwarg(kwargs, "flag");
    const explicitFlagProvided = explicitFlagValue !== undefined;
    const requestedFlag =
      explicitFlagProvided
        ? this._normalizeInventoryId(explicitFlagValue, 0)
        : boundContext && boundContext.flagID !== null && boundContext.flagID !== undefined
          ? this._normalizeInventoryId(boundContext.flagID, 0)
          : null;
    const quantity = this._normalizeQuantityArg(
      this._extractKwarg(kwargs, "qty") ?? this._extractKwarg(kwargs, "quantity"),
    );
    const sourceItemDescriptor = this._findTransferSourceItem(itemID, sourceLocationID);
    const item = sourceItemDescriptor && sourceItemDescriptor.item
      ? sourceItemDescriptor.item
      : null;
    const fleetLootEntries = [];

    log.debug(
      `[InvBroker] Add itemID=${itemID} source=${sourceLocationID} requestedFlag=${String(requestedFlag)} bound=${JSON.stringify(boundContext)}`,
    );

    if (!boundContext || !item || !sourceItemDescriptor) {
      return null;
    }

    if (!this._isTransferSourceLocationMatch(sourceItemDescriptor, sourceLocationID)) {
      log.debug(
        `[InvBroker] Add rejected itemID=${itemID} source=${sourceLocationID} error=SOURCE_LOCATION_MISMATCH`,
      );
      return null;
    }
    // The scientist's cargo is a handover into NPC custody, never player loot.
    if (fracturedLegacyCargo.isReceiver(session, item.locationID)) return null;
    if (incursionCargo.isReceiver(session, item.locationID)) return null;
    if (boundContext.kind === "incursionCargoReceiver" || incursionCargo.isReceiver(session, boundContext.inventoryID)) {
      if (Number(requestedFlag) === ITEM_FLAGS.CARGO_HOLD) incursionCargo.tryDeliver(session, boundContext.inventoryID, item, quantity);
      return null;
    }
    if (boundContext.kind === "fracturedLegacyReceiver") {
      const result = Number(requestedFlag) === ITEM_FLAGS.CARGO_HOLD
        ? fracturedLegacyCargo.tryDeliver(session, boundContext.inventoryID, item, quantity) : null;
      if (result?.success) this._emitInventoryMoveChanges(session, result.changes, { emitItemsChangedBatch: true });
      return null;
    }
    if (this._hasAssetSafetyRecoverySource([itemID])) {
      return this._recoverAssetSafetyItems(session, boundContext, [itemID], sourceLocationID,
        quantity, requestedFlag, explicitFlagProvided, true);
    }
    const homefrontDelivery =
      require("../homefront/homefrontHooks").cargo.tryDeliver(
        session,
        boundContext.inventoryID,
        item,
        quantity,
      );
    if (homefrontDelivery) {
      if (homefrontDelivery.success)
        this._emitInventoryMoveChanges(session, homefrontDelivery.changes, {
          emitItemsChangedBatch: true,
        });
      return null;
    }
    if (isDirectSpaceUnanchoredStructureHullInventoryRecord(item)) {
      this._throwUnanchoredStructureHullInventoryError();
    }
    if (this._getPendingStructureUnanchorContainerAncestor(item)) {
      this._throwPendingStructureUnanchorContainerInventoryError();
    }

    // Availability and range are independent of POS division roles. Recheck
    // retained POS sources before roles, preserving other inventories' order.
    const hasStarbaseSource = this._getAuthoritativeTransferSourceContainerIDs(
      sourceItemDescriptor,
    ).some((containerID) => starbaseInventoryRuntime.isStarbaseStorage(findItemById(containerID)));
    if (hasStarbaseSource) {
      const sourceSpaceContainerScopeAccess =
        this._validateAuthoritativeSpaceContainerScopeTransferAccess(
          session,
          sourceItemDescriptor,
          0,
        );
      if (!sourceSpaceContainerScopeAccess.success) {
        log.debug(
          `[InvBroker] Add rejected itemID=${itemID} spaceContainer=${sourceSpaceContainerScopeAccess.containerID} error=${sourceSpaceContainerScopeAccess.errorMsg}`,
        );
        this._throwSpaceContainerScopeAccessError(
          sourceSpaceContainerScopeAccess.errorMsg,
          sourceSpaceContainerScopeAccess.side === "destination" ? "add" : "loot",
        );
      }
    }

    if (!this._canTakeFromCorporationHangarSourceAncestry(session, sourceItemDescriptor)) {
      log.debug(
        `[InvBroker] Add rejected itemID=${itemID} source=${sourceLocationID} error=CORP_HANGAR_TAKE_DENIED`,
      );
      throwWrappedUserError(
        "CrpAccessDenied",
        buildCrpAccessDeniedInsufficientRolesValues(),
      );
    }

    this._validateMoonMaterialBaySourceAccess(session, item);

    // The move is refused silently for a rig its hull will not give back.
    if (this._isRigHeldBySlot(item)) {
      log.debug(
        `[InvBroker] Add rejected itemID=${itemID} — item is a rig in slot flagID=${item.flagID} and cannot be unfit to inventory`,
      );
      return null;
    }

    const destination = this._resolveDestinationForMove(
      session,
      boundContext,
      item,
      requestedFlag,
      explicitFlagProvided,
    );
    if (!destination) {
      log.debug(
        `[InvBroker] Add rejected itemID=${itemID} source=${sourceLocationID} requestedFlag=${String(requestedFlag)} error=NO_SUITABLE_FIT_SLOT`,
      );
      const noDestinationShipRecord = this._getShipInventoryRecord(
        session,
        boundContext,
      );
      const noDestinationFitHost = noDestinationShipRecord ||
        this._getStructureFitHostRecord(
          session,
          boundContext && boundContext.inventoryID,
        );
      if (noDestinationFitHost) {
        this._throwFittingMoveUserError(
          this._diagnoseAutoFitFailure(
            noDestinationFitHost,
            item,
            this._listFittedItemsForFitHost(session, noDestinationFitHost),
          ),
          noDestinationFitHost,
          item,
        );
      }
      throwWrappedUserError("ModuleFitFailed", {
        moduleName: Number(item.typeID) || 0,
        reason: "No suitable slot available",
      });
    }
    this._ensureCorporationOfficeDivisionDestinationAccess(session, destination);
    this._ensureItemMoveInvariant(sourceItemDescriptor, destination);
    this._ensureSecureContainerTransferAccess(session, item, destination);
    const moonMaterialBayDestination = this._validateMoonMaterialBayDestination(
      session,
      destination,
    );
    if (!moonMaterialBayDestination.success) {
      log.debug(
        `[InvBroker] Add rejected itemID=${itemID} destination=${destination.locationID}:${destination.flagID} error=${moonMaterialBayDestination.errorMsg}`,
      );
      return null;
    }
    const shipServiceAccess = this._validateShipServiceTransferAccess(
      session,
      item,
      destination,
    );
    if (!shipServiceAccess.success) {
      log.debug(
        `[InvBroker] Add rejected itemID=${itemID} shipService=${shipServiceAccess.shipID} error=${shipServiceAccess.errorMsg}`,
      );
      this._throwShipServiceAccessError(shipServiceAccess.errorMsg);
    }
    const mobileDepotAccess = this._validateMobileDepotCargoTransferAccess(
      session,
      item,
      destination,
    );
    if (!mobileDepotAccess.success) {
      log.debug(
        `[InvBroker] Add rejected itemID=${itemID} mobileDepot=${mobileDepotAccess.containerID} error=${mobileDepotAccess.errorMsg}`,
      );
      this._throwMobileDepotCargoAccessError(
        mobileDepotAccess.errorMsg,
        mobileDepotAccess.side,
      );
    }
    const mobileTractorUnitAccess =
      this._validateMobileTractorUnitCargoTransferAccess(
        session,
        item,
        destination,
      );
    if (!mobileTractorUnitAccess.success) {
      log.debug(
        `[InvBroker] Add rejected itemID=${itemID} mobileTractorUnit=${mobileTractorUnitAccess.containerID} error=${mobileTractorUnitAccess.errorMsg}`,
      );
      this._throwMobileTractorUnitCargoAccessError(
        mobileTractorUnitAccess.errorMsg,
        mobileTractorUnitAccess.side,
      );
    }
    const spaceContainerScopeAccess =
      this._validateAuthoritativeSpaceContainerScopeTransferAccess(
        session,
        sourceItemDescriptor,
        destination.locationID,
      );
    if (!spaceContainerScopeAccess.success) {
      log.debug(
        `[InvBroker] Add rejected itemID=${itemID} spaceContainer=${spaceContainerScopeAccess.containerID} error=${spaceContainerScopeAccess.errorMsg}`,
      );
      this._throwSpaceContainerScopeAccessError(
        spaceContainerScopeAccess.errorMsg,
        spaceContainerScopeAccess.side === "destination" ? "add" : "loot",
      );
    }
    const abyssalRewardAccess =
      this._validateAuthoritativeAbyssalRewardTransferAccess(
        session,
        sourceItemDescriptor,
      );
    if (!abyssalRewardAccess.success) {
      log.debug(
        `[InvBroker] Add rejected itemID=${itemID} abyssalRewardContainer=${abyssalRewardAccess.containerID} error=${abyssalRewardAccess.errorMsg}`,
      );
      this._throwSpaceContainerScopeAccessError();
    }
    const shipRecord = this._getShipInventoryRecord(session, boundContext);
    const fitHostRecord = shipRecord || this._getStructureFitHostRecord(
      session,
      boundContext && boundContext.inventoryID,
    );
    const fittingServiceAccess = this._validateInSpaceFittingServiceAccess(
      session,
      shipRecord,
      item,
      destination,
    );
    if (!fittingServiceAccess.success) {
      log.debug(
        `[InvBroker] Add rejected itemID=${itemID} destination=${destination.locationID}:${destination.flagID} error=${fittingServiceAccess.errorMsg}`,
      );
      this._throwInSpaceFittingAccessError(
        fittingServiceAccess.errorMsg,
        fittingServiceAccess.tooFar,
      );
    }
    const dockedStructureFittingAccess = this._validateDockedStructureFittingServiceAccess(
      session,
      shipRecord,
      item,
      destination,
    );
    if (!dockedStructureFittingAccess.success) {
      log.debug(
        `[InvBroker] Add rejected itemID=${itemID} structure=${dockedStructureFittingAccess.structureID} destination=${destination.locationID}:${destination.flagID} error=${dockedStructureFittingAccess.errorMsg}`,
      );
      this._throwDockedStructureFittingAccessError(dockedStructureFittingAccess.errorMsg);
    }
    const structureDeedBaySourceValidation =
      this._validateStructureDeedBaySourceMove(item);
    if (!structureDeedBaySourceValidation.success) {
      log.debug(
        `[InvBroker] Add rejected itemID=${itemID} source=${item.locationID}:${item.flagID} error=${structureDeedBaySourceValidation.errorMsg}`,
      );
      throwWrappedUserError(
        structureDeedBaySourceValidation.errorMsg,
        structureDeedBaySourceValidation.values || {
          type: Number(item.typeID) || 0,
        },
      );
    }
    const authoritativeSourceLocationID =
      this._getAuthoritativeTransferSourceLocationID(sourceItemDescriptor);
    const playerSpaceContainerLootEvaluation =
      this._evaluatePlayerSpaceContainerLootMove(
        session,
        authoritativeSourceLocationID,
        destination,
      );
    if (!playerSpaceContainerLootEvaluation.success) {
      throwWrappedUserError(
        playerSpaceContainerLootEvaluation.errorMsg || "SafetyActivated",
        {},
      );
    }
    let chargeTheftSettlement = null;
    let chargeLoadResult = null;
    try {
      chargeLoadResult = this._tryLoadChargeFromInventoryAdd(
        session,
        sourceItemDescriptor,
        destination,
        quantity,
        {
          beforeCommit: () => {
            chargeTheftSettlement =
              this._ensurePlayerSpaceContainerTheftSettled(
                session,
                playerSpaceContainerLootEvaluation,
              );
            return chargeTheftSettlement;
          },
        },
      );
    } catch (error) {
      this._compensatePlayerSpaceContainerTheft(
        session,
        chargeTheftSettlement,
      );
      throw error;
    }
    if (chargeLoadResult.handled) {
      if (!chargeLoadResult.success) {
        this._compensatePlayerSpaceContainerTheft(
          session,
          chargeTheftSettlement,
        );
        log.warn(
          `[InvBroker] Add charge load failed itemID=${itemID} destination=${destination.locationID}:${destination.flagID} error=${chargeLoadResult.errorMsg}`,
        );
        return null;
      }

      this._commitPlayerSpaceContainerTheft(
        session,
        chargeTheftSettlement,
      );

      const chargeChanges =
        chargeLoadResult.data && Array.isArray(chargeLoadResult.data.changes)
          ? chargeLoadResult.data.changes
          : [];
      if (chargeChanges.length > 0) {
        this._appendFleetLootEntry(
          session,
          fleetLootEntries,
          sourceItemDescriptor,
          sourceLocationID,
          destination,
          chargeLoadResult.data.quantity,
        );
        this._emitFittedChargeLoadChanges(
          session,
          chargeChanges,
          chargeLoadResult.data.chargeTransition || null,
        );
        this._emitInventoryChangesToBoundSpaceObservers(
          session,
          chargeChanges,
          { emitItemsChangedBatch: true },
        );
        this._refreshBallparkShipPresentation(session, chargeChanges);
        this._refreshBallparkInventoryPresentation(session, chargeChanges);
        this._emitFleetLootEvents(session, fleetLootEntries);
        const sourceContainerIDs = [
          ...new Set(
            chargeChanges
              .filter((c) => c && c.previousData && Number(c.previousData.locationID) > 0)
              .map((c) => Number(c.previousData.locationID)),
          ),
        ];
        for (const cid of sourceContainerIDs) {
          maybeExpireEmptySpaceContainer(session, cid);
        }
        this._maybeCompleteMaterializedDungeonSitesForSources(session, sourceContainerIDs);
      }
      return chargeLoadResult.data && chargeLoadResult.data.loadedChargeItemID
        ? chargeLoadResult.data.loadedChargeItemID
        : null;
    }
    const fitValidation = this._validateFittingMove(
      session,
      fitHostRecord,
      item,
      destination,
      fitHostRecord
        ? this._listFittedItemsForFitHost(session, fitHostRecord)
        : null,
    );
    if (!fitValidation.success) {
      require("../nodegraph/nodeGraphEvents").publish(session, "inventory.fitting-refused", {
        itemID: item.itemID, typeID: item.typeID, shipID: fitHostRecord?.itemID,
        reason: fitValidation.errorMsg,
      });
      log.debug(
        `[InvBroker] Add rejected itemID=${itemID} destination=${destination.locationID}:${destination.flagID} error=${fitValidation.errorMsg}`,
      );
      this._throwFittingMoveUserError(fitValidation, fitHostRecord, item);
      return null;
    }
    const structureCoreValidation = this._validateStructureCoreInstallMove(
      item,
      destination,
    );
    if (!structureCoreValidation.success) {
      throwWrappedUserError(
        structureCoreValidation.errorMsg,
        structureCoreValidation.values || {
          type: Number(item.typeID) || 0,
        },
      );
    }
    const shipBayValidation = this._validateShipBayMove(
      session,
      shipRecord,
      item,
      destination,
    );
    if (!shipBayValidation.success) {
      log.debug(
        `[InvBroker] Add rejected itemID=${itemID} destination=${destination.locationID}:${destination.flagID} error=${shipBayValidation.errorMsg}`,
      );
      this._throwShipBayMoveUserError(shipBayValidation, item);
    }
    const structureOwnerBayValidation = this._validateStructureOwnerBayMove(
      item,
      destination,
    );
    if (!structureOwnerBayValidation.success) {
      throwWrappedUserError(structureOwnerBayValidation.errorMsg, {
        type: Number(item.typeID) || 0,
      });
    }
    const structureServiceModuleRemovalAccess =
      this._validateStructureServiceModuleRemovalAccess(
        session,
        item,
        destination,
      );
    if (!structureServiceModuleRemovalAccess.success) {
      log.debug(
        `[InvBroker] Add rejected itemID=${itemID} structure=${structureServiceModuleRemovalAccess.structureID || 0} error=${structureServiceModuleRemovalAccess.errorMsg}`,
      );
      throwWrappedUserError(
        "CrpAccessDenied",
        buildCrpAccessDeniedInsufficientRolesValues(),
      );
    }
    const unfitCargoOverflow = this._getUnfitCargoOverflow(
      session,
      item,
      destination,
    );
    if (unfitCargoOverflow) {
      log.debug(
        `[InvBroker] Add rejected itemID=${itemID} — unfitting it would leave the cargo hold at ${unfitCargoOverflow.used} of ${unfitCargoOverflow.capacityAfter}`,
      );
      this._throwUnfitCargoOverflowUserError(unfitCargoOverflow);
    }
    const appliedQuantity = this._resolveAppliedMoveQuantity(
      item,
      destination,
      quantity,
      session,
    );
    const capacityCheck = this._checkCapacityForMove(
      session,
      boundContext,
      destination,
      item,
      appliedQuantity,
    );
    if (!capacityCheck.success) {
      log.debug(
        `[InvBroker] Add rejected itemID=${itemID} destination=${destination.locationID}:${destination.flagID} error=${capacityCheck.errorMsg}`,
      );
      if (capacityCheck.errorMsg === "NotEnoughCargoSpace") {
        throwWrappedUserError(
          "NotEnoughCargoSpace",
          this._buildCapacityMoveUserErrorValues(capacityCheck, item),
        );
      }
      throwWrappedUserError(
        capacityCheck.errorMsg,
        this._buildCapacityMoveUserErrorValues(capacityCheck, item),
      );
    }
    const isFittingMove =
      isShipFittingFlag(destination.flagID) || isShipFittingFlag(item.flagID);
    const previousModuleAttributeSnapshots =
      isFittingMove
        ? this._captureFittingModuleAttributeState(
            session,
            this._getShipId(session),
          )
        : null;
    const theftSettlement = this._ensurePlayerSpaceContainerTheftSettled(
      session,
      playerSpaceContainerLootEvaluation,
    );
    let moveResult = null;
    try {
      moveResult = this._moveSourceItemToDestination(
        session,
        sourceItemDescriptor,
        destination,
        appliedQuantity,
      );
    } catch (error) {
      this._compensatePlayerSpaceContainerTheft(session, theftSettlement);
      throw error;
    }
    if (!moveResult.success) {
      this._compensatePlayerSpaceContainerTheft(session, theftSettlement);
      log.warn(
        `[InvBroker] Add failed itemID=${itemID} destination=${destination.locationID}:${destination.flagID} error=${moveResult.errorMsg}`,
      );
      return null;
    }
    const serviceModuleMoveResult = this._syncStructureServiceModuleMove(
      session,
      item,
      destination,
    );
    if (!serviceModuleMoveResult.success) {
      this._compensatePlayerSpaceContainerTheft(session, theftSettlement);
      throwWrappedUserError("CustomNotify", {
        notify: serviceModuleMoveResult.rolledBack
          ? "The service module could not be removed because its industry jobs could not be cancelled."
          : "The service module move could not be completed safely.",
      });
    }
    this._commitPlayerSpaceContainerTheft(session, theftSettlement);
    this._appendFleetLootEntry(
      session,
      fleetLootEntries,
      sourceItemDescriptor,
      sourceLocationID,
      destination,
      appliedQuantity,
    );
    const isStructureCoreInstallMove = this._isStructureCoreInstallMove(
      item,
      destination,
    );
    // Fit (dest is a slot) or unfit (source was a slot) → TQ transaction path;
    // everything else stays on the legacy per-item move emission.
    const isMtuSpaceComponentLootMove =
      this._isMtuSpaceComponentLootMove(session, sourceLocationID, destination);
    const isPlayerSpaceContainerLootMove =
      this._isPlayerSpaceContainerLootMove(
        session,
        sourceLocationID,
        destination,
      );
    if (isFittingMove) {
      const fittingChanges = [
        ...((moveResult.data && moveResult.data.changes) || []),
        ...this._resolveShipModuleFitOnlineChanges(session, item, destination),
      ];
      this._emitFittingMoveChanges(
        session,
        fittingChanges,
        { previousModuleAttributeSnapshots },
      );
      this._emitInventoryChangesToBoundSpaceObservers(
        session,
        fittingChanges,
        { emitItemsChangedBatch: true },
      );
    } else {
      const moveChanges = (moveResult.data && moveResult.data.changes) || [];
      const emittedCorpStructureMove =
        this._emitCorpStructureHangarMoveChanges(session, moveChanges);
      const emittedStructureCoreMove =
        !emittedCorpStructureMove &&
        isStructureCoreInstallMove &&
        this._emitStructureCoreInstallMoveChanges(
          session,
          moveChanges,
          destination,
          item,
        );
      if (!emittedCorpStructureMove && !emittedStructureCoreMove) {
        const emitItemsChangedBatch =
          isMtuSpaceComponentLootMove ||
          isPlayerSpaceContainerLootMove ||
          Number(destination.flagID) === ITEM_FLAGS.SPECIALIZED_PLANETARY_COMMODITIES_HOLD;
        this._emitInventoryMoveChanges(session, moveChanges, {
          emitItemsChangedBatch,
          announceItemsChanged: true,
          idType:
            isPlayerSpaceContainerLootMove
              ? "shipid"
              : isMtuSpaceComponentLootMove
                ? "charid"
                : undefined,
          locationContext:
            isMtuSpaceComponentLootMove ||
            isPlayerSpaceContainerLootMove
            ? this._buildShipCargoLocationContext(session, destination)
            : undefined,
        });
      } else {
        this._emitInventoryChangesToBoundSpaceObservers(
          session,
          moveChanges,
          { emitItemsChangedBatch: true },
        );
      }
      this._refreshBallparkShipPresentation(session, moveChanges);
      this._refreshBallparkInventoryPresentation(session, moveChanges);
      this._emitInventoryMoveChanges(
        session,
        this._resolveShipModuleFitOnlineChanges(session, item, destination),
      );
    }
    if (isStructureCoreInstallMove) {
      this._syncStructureCoreInstall(session, item, destination);
    }
    this._emitFleetLootEvents(session, fleetLootEntries);
    if (isMtuSpaceComponentLootMove) {
      this._emitMtuSpaceComponentLootEvents(session, sourceLocationID, destination, [item]);
    }
    if (isPlayerSpaceContainerLootMove) {
      this._emitPlayerSpaceContainerLootEvents(
        session,
        sourceLocationID,
        destination,
        [item],
      );
    }
    const sourceContainerIDs = [
      ...new Set(
        ((moveResult.data && moveResult.data.changes) || [])
          .filter((c) => c && c.previousData && Number(c.previousData.locationID) > 0)
          .map((c) => Number(c.previousData.locationID)),
      ),
    ];
    // If the source was a temporary space container, despawn it when empty.
    for (const cid of sourceContainerIDs) {
      maybeExpireEmptySpaceContainer(session, cid);
    }
    this._maybeCompleteMaterializedDungeonSitesForSources(session, sourceContainerIDs);
    // Rescue handover keeps NPC custody at flag0 even when Add was asked
    // for cargo flag5. Resolve the actual delivered split, as for audit cans.
    const rescueResultDestination = getRescueDestination(
      session, findItemById(destination.locationID),
    );
    const resultDestination = rescueResultDestination &&
      item.typeID === rescueResultDestination.policy.typeID
      ? { ...destination, flagID: 0 } : destination;
    return this._resolveMovedItemID(moveResult, itemID, resultDestination);
  }

  // MultiAdd is the client's Loot All gesture, so it owes the loot window the
  // same supplementary events Handle_Add sends — but once for the batch, not
  // once per item. The decompiled retail client in tools/ClientCodeGrabber
  // scatters them exactly that way: invControllers.ShipCargo.AddItems fires a
  // single OnClientEvent_MoveFromCargoToHangar off the MultiAdd return value,
  // and invControllers.BaseCelestialContainer.LootAll then fires a single
  // OnWreckLootAll carrying every item it asked for. Enc464's golden trace
  // shows that pair, in that order, keyed ('ItemFloatingCargo', containerID).
  //
  // Partial batches follow the single-item path: report the move whenever an
  // item moved, but close a floating-cargo window only when its container is
  // empty. An ABORTED batch publishes neither event — retail's UserError
  // propagates out of AddItems before either scatter can run, and OnWreckLootAll
  // closes the loot window, which must stay open over the rows that never moved.
  _emitMultiAddLootWindowEvents(session, context = {}) {
    if (context.aborted) {
      return;
    }
    const mtuLoot = context.mtuLoot;
    if (mtuLoot && mtuLoot.items.length > 0) {
      this._emitMtuSpaceComponentLootEvents(
        session,
        context.sourceLocationID,
        mtuLoot.destination,
        mtuLoot.items,
      );
    }
    const spaceContainerLoot = context.spaceContainerLoot;
    if (spaceContainerLoot && spaceContainerLoot.items.length > 0) {
      this._emitPlayerSpaceContainerLootEvents(
        session,
        context.sourceLocationID,
        spaceContainerLoot.destination,
        spaceContainerLoot.items,
      );
    }
  }

  // Publishes everything a MultiAdd batch has already committed. MultiAdd
  // persists each item as it goes, so this must also run when the batch is cut
  // short by a UserError (capacity, access) — otherwise the rows that did move
  // are live in the store with the client still drawing them in the source.
  _finalizeMultiAddBatch(session, allChanges, fleetLootEntries, context = {}) {
    const emittedCount = this._emitFittingMoveChanges(session, allChanges, {
      previousModuleAttributeSnapshots:
        context.previousModuleAttributeSnapshots,
      previousShipFittingSnapshot: context.previousShipFittingSnapshot,
    });
    const movedCount = Number(context.movedCount) || 0;
    // Charge loads published their own rows inside the loop through
    // _emitFittedChargeLoadChanges (dd1d81f6): the fitted-charge identity is
    // denied by GetAllInfo/List, so they deliberately owe this batch no row
    // delta and must not trip the invariant below.
    const chargeLoadCount = Number(context.chargeLoadCount) || 0;
    if (movedCount - chargeLoadCount > 0 && emittedCount <= 0) {
      // Invariant: a counted move owes the client at least one row delta.
      // Reaching here means the batch mutated the store and told nobody, which
      // is indistinguishable from a dead drag in the UI. Warn (never debug) —
      // this is the signature of a move that silently did nothing.
      log.warn(
        `[InvBroker] MultiAdd emitted no client change despite moved=${movedCount}/${Number(context.batchSize) || 0} ` +
          `source=${context.sourceLocationID} destination=${context.destinationInventoryID}:${String(context.destinationFlagID)} ` +
          `changes=${Array.isArray(allChanges) ? allChanges.length : 0} ` +
          `withItem=${(Array.isArray(allChanges) ? allChanges : []).filter((change) => change && change.item).length} ` +
          `reason=${Array.isArray(allChanges) && allChanges.length > 0 ? "no-row-delta (items already at destination?)" : "empty-change-list"}` +
          `${context.aborted ? " aborted=true" : ""}`,
      );
    }
    // Charge-load rows never enter allChanges, but their source stacks still
    // emptied a container and still moved a ballpark-backed inventory.
    const chargeLoadChanges = Array.isArray(context.chargeLoadChanges)
      ? context.chargeLoadChanges
      : [];
    const settledChanges = chargeLoadChanges.length > 0
      ? [...(Array.isArray(allChanges) ? allChanges : []), ...chargeLoadChanges]
      : (Array.isArray(allChanges) ? allChanges : []);
    this._emitInventoryChangesToBoundSpaceObservers(session, settledChanges, {
      emitItemsChangedBatch: true,
    });
    this._emitInventoryChangesToBoundCorporationOfficeObservers(
      session,
      settledChanges,
      { emitItemsChangedBatch: true },
    );
    // MultiAdd is the client's Loot All path. Refresh affected space-backed
    // containers after the batch has committed so emptied wrecks publish the
    // same isEmpty=true OnSlimItemChange transition as single-item Add.
    this._refreshBallparkShipPresentation(session, settledChanges);
    this._refreshBallparkInventoryPresentation(session, settledChanges);
    this._emitFleetLootEvents(session, fleetLootEntries);
    this._emitMultiAddLootWindowEvents(session, context);
    // If any source was a temporary space container, despawn it when now empty.
    const sourceContainerIDs = new Set(
      settledChanges
        .filter((c) => c && c.previousData && Number(c.previousData.locationID) > 0)
        .map((c) => Number(c.previousData.locationID)),
    );
    for (const cid of sourceContainerIDs) {
      maybeExpireEmptySpaceContainer(session, cid);
    }
    this._maybeCompleteMaterializedDungeonSitesForSources(session, [...sourceContainerIDs]);
    return emittedCount;
  }

  Handle_MultiAdd(args, session, kwargs) {
    if (this._getBoundContext(session)?.kind === "tradeInventory") return this._dispatchTradeInventory("MultiAdd", args, session, kwargs);
    this._traceInventory("MultiAdd", session, { args, kwargs });
    const boundContext = this._getBoundContext(session);
    const itemIDs = [
      ...new Set(
        this._normalizeItemIdList(args && args.length > 0 ? args[0] : []),
      ),
    ];
    const sourceLocationID = this._normalizeInventoryId(
      args && args.length > 1 ? args[1] : 0,
      0,
    );
    const explicitFlagValue = this._extractKwarg(kwargs, "flag");
    const explicitFlagProvided = explicitFlagValue !== undefined;
    const requestedFlag =
      explicitFlagProvided
        ? this._normalizeInventoryId(explicitFlagValue, 0)
        : boundContext && boundContext.flagID !== null && boundContext.flagID !== undefined
          ? this._normalizeInventoryId(boundContext.flagID, 0)
          : null;
    const quantity = this._normalizeQuantityArg(
      this._extractKwarg(kwargs, "qty") ?? this._extractKwarg(kwargs, "quantity"),
    );
    if (this._hasAssetSafetyRecoverySource(itemIDs)) {
      return this._recoverAssetSafetyItems(session, boundContext, itemIDs, sourceLocationID,
        quantity, requestedFlag, explicitFlagProvided, false);
    }
    const shipRecord = this._getShipInventoryRecord(session, boundContext);
    const fitHostRecord = shipRecord || this._getStructureFitHostRecord(
      session,
      boundContext && boundContext.inventoryID,
    );
    const fittedItemsSnapshot = fitHostRecord
      ? this._listFittedItemsForFitHost(session, fitHostRecord)
        .map((item) => ({ ...item }))
      : [];
    const allChanges = [];
    const fleetLootEntries = [];
    // Charge loads publish themselves through _emitFittedChargeLoadChanges, so
    // their rows stay out of allChanges and ride here instead for the batch's
    // post-commit bookkeeping.
    const chargeLoadChanges = [];
    // Loot classified exactly as Handle_Add classifies it, accumulated so the
    // finalizer can send one loot-window event pair for the whole Loot All.
    const mtuLoot = { destination: null, items: [] };
    const spaceContainerLoot = { destination: null, items: [] };
    let movedCount = 0;
    let chargeLoadCount = 0;
    let firstFitValidationFailure = null;
    let previousModuleAttributeSnapshots = null;
    let previousShipFittingSnapshot = null;
    let attemptedModuleAttributeCapture = false;
    // Handle_Add logs or throws on every condition that stops a transfer.
    // MultiAdd used to `continue` past most of them with nothing recorded, so a
    // batch could drop every item and still answer a successful empty response.
    // Record each skip here and report the batch once, below.
    const skipReasons = [];
    let firstSkip = null;
    const recordSkip = (skippedItemID, reason, context = {}) => {
      const skipErrorMsg = context.errorMsg ? String(context.errorMsg) : "";
      skipReasons.push(
        `${skippedItemID}:${reason}${skipErrorMsg ? `(${skipErrorMsg})` : ""}`,
      );
      firstSkip = firstSkip || {
        itemID: skippedItemID,
        reason,
        errorMsg: skipErrorMsg,
        item: context.item || null,
        validation: context.validation || null,
      };
    };

    log.debug(
      `[InvBroker] MultiAdd itemCount=${itemIDs.length} source=${sourceLocationID} requestedFlag=${String(requestedFlag)} bound=${JSON.stringify(boundContext)}`,
    );

    if (!boundContext || itemIDs.length === 0) {
      return null;
    }
    if (
      boundContext.kind === "fracturedLegacyReceiver" || boundContext.kind === "incursionCargoReceiver" ||
      incursionCargo.isReceiver(session, boundContext.inventoryID) ||
      require("../homefront/homefrontHooks").cargo.isReceiver(
        session,
        boundContext.inventoryID,
      )
    ) {
      for (const itemID of itemIDs)
        this.Handle_Add([itemID, sourceLocationID], session, kwargs);
      return null;
    }
    this._ensureSecureContainerGeneralAccess(
      session,
      boundContext.inventoryID,
    );
    for (const itemID of itemIDs) {
      const sourceItemDescriptor = this._findTransferSourceItem(
        itemID,
        sourceLocationID,
      );
      if (!sourceItemDescriptor || !sourceItemDescriptor.item) {
        continue;
      }
      this._ensureSecureContainerGeneralAccess(
        session,
        sourceItemDescriptor.item.locationID,
      );
    }

    // Resolve and validate every transfer before the first per-item mutation.
    // This keeps locked audit-container contents and invalid container trees
    // from partially applying a MultiAdd batch.
    this._preflightMultiAddTransferGuards(
      session,
      boundContext,
      itemIDs,
      sourceLocationID,
      requestedFlag,
      explicitFlagProvided,
      fittedItemsSnapshot,
      quantity,
    );

    // Loot All must be capacity-atomic. MultiAdd persists each successful item
    // immediately, so an item-by-item capacity check can otherwise throw after
    // earlier rows have already moved. Preflight the cumulative active-ship
    // cargo volume before the first mutation.
    const lootCapacityPreflight = this._preflightSpaceLootMultiAddCapacity(
      session,
      boundContext,
      itemIDs,
      sourceLocationID,
      requestedFlag,
      explicitFlagProvided,
      quantity,
      fittedItemsSnapshot,
    );
    if (lootCapacityPreflight.handled && !lootCapacityPreflight.success) {
      log.debug(
        `[InvBroker] MultiAdd rejected loot batch source=${sourceLocationID} destination=${this._getShipId(session)}:${ITEM_FLAGS.CARGO_HOLD} error=${lootCapacityPreflight.errorMsg} required=${lootCapacityPreflight.requiredVolume} free=${lootCapacityPreflight.free}`,
      );
      if (
        lootCapacityPreflight.errorMsg === "SOURCE_ITEM_NOT_FOUND" ||
        lootCapacityPreflight.errorMsg === "SOURCE_LOCATION_MISMATCH"
      ) {
        return null;
      }
      throwWrappedUserError(
        lootCapacityPreflight.errorMsg,
        this._buildCapacityMoveUserErrorValues(
          lootCapacityPreflight,
          lootCapacityPreflight.item,
        ),
      );
    }

    for (const itemID of itemIDs) {
      const sourceItemDescriptor = this._findTransferSourceItem(
        itemID,
        sourceLocationID,
      );
      if (
        sourceItemDescriptor &&
        sourceItemDescriptor.item &&
        this._isTransferSourceLocationMatch(
          sourceItemDescriptor,
          sourceLocationID,
        ) &&
        isDirectSpaceUnanchoredStructureHullInventoryRecord(
          sourceItemDescriptor.item,
        )
      ) {
        this._throwUnanchoredStructureHullInventoryError();
      }
      if (
        sourceItemDescriptor &&
        sourceItemDescriptor.item &&
        this._isTransferSourceLocationMatch(
          sourceItemDescriptor,
          sourceLocationID,
        ) &&
        this._getPendingStructureUnanchorContainerAncestor(
          sourceItemDescriptor.item,
        )
      ) {
        this._throwPendingStructureUnanchorContainerInventoryError();
      }
    }

    // Explicit capability passed only to local cargo custody. No unrelated
    // grant or cross-table wreck transfer can accidentally join this request.
    const inventoryMoveBatch = createInventoryMoveBatch();
    let batchError = null;
    let durabilityResult;
    try {
      for (const itemID of itemIDs) {
        const sourceItemDescriptor = this._findTransferSourceItem(itemID, sourceLocationID);
        const item = sourceItemDescriptor && sourceItemDescriptor.item
          ? sourceItemDescriptor.item
          : null;
        if (!item || !sourceItemDescriptor) {
          recordSkip(itemID, "SOURCE_ITEM_NOT_FOUND");
          continue;
        }
        if (
          !this._isTransferSourceLocationMatch(
            sourceItemDescriptor,
            sourceLocationID,
          )
        ) {
          recordSkip(itemID, "SOURCE_LOCATION_MISMATCH", { item });
          continue;
        }

        this._validateMoonMaterialBaySourceAccess(session, item);

        // Same rule as Handle_Add: a batch move must not carry a rig out of a
        // hull that only lets it be destroyed.
        if (this._isRigHeldBySlot(item)) {
          recordSkip(itemID, "RIG_HELD_BY_SLOT", { item });
          continue;
        }

        const destination = this._resolveDestinationForMove(
          session,
          boundContext,
          item,
          requestedFlag,
          explicitFlagProvided,
          fittedItemsSnapshot,
        );
        if (!destination) {
          const autoFitFailure = this._diagnoseAutoFitFailure(
            fitHostRecord,
            item,
            fittedItemsSnapshot,
          );
          firstFitValidationFailure = firstFitValidationFailure || {
            fitValidation: autoFitFailure,
            fitHostRecord,
            item,
          };
          recordSkip(itemID, "NO_SUITABLE_DESTINATION", {
            item,
            errorMsg: autoFitFailure.errorMsg,
          });
          continue;
        }
        if (!this._canTakeFromCorporationHangarSourceAncestry(session, sourceItemDescriptor)) {
          recordSkip(itemID, "CORP_HANGAR_TAKE_DENIED", { item });
          continue;
        }
        this._ensureCorporationOfficeDivisionDestinationAccess(session, destination);
        this._ensureSecureContainerTransferAccess(
          session,
          item,
          destination,
        );
        this._ensureItemMoveInvariant(sourceItemDescriptor, destination);
        const moonMaterialBayDestination = this._validateMoonMaterialBayDestination(
          session,
          destination,
        );
        if (!moonMaterialBayDestination.success) {
          log.debug(
            `[InvBroker] MultiAdd rejected itemID=${itemID} destination=${destination.locationID}:${destination.flagID} error=${moonMaterialBayDestination.errorMsg}`,
          );
          recordSkip(itemID, "MOON_MATERIAL_BAY_DESTINATION_REJECTED", {
            item,
            errorMsg: moonMaterialBayDestination.errorMsg,
          });
          continue;
        }
        const shipServiceAccess = this._validateShipServiceTransferAccess(
          session,
          item,
          destination,
        );
        if (!shipServiceAccess.success) {
          log.debug(
            `[InvBroker] MultiAdd rejected itemID=${itemID} shipService=${shipServiceAccess.shipID} error=${shipServiceAccess.errorMsg}`,
          );
          if (movedCount > 0) {
            recordSkip(itemID, "SHIP_SERVICE_ACCESS_DENIED", {
              item,
              errorMsg: shipServiceAccess.errorMsg,
            });
            continue;
          }
          this._throwShipServiceAccessError(shipServiceAccess.errorMsg);
        }
        const mobileDepotAccess = this._validateMobileDepotCargoTransferAccess(
          session,
          item,
          destination,
        );
        if (!mobileDepotAccess.success) {
          log.debug(
            `[InvBroker] MultiAdd rejected itemID=${itemID} mobileDepot=${mobileDepotAccess.containerID} error=${mobileDepotAccess.errorMsg}`,
          );
          this._throwMobileDepotCargoAccessError(
            mobileDepotAccess.errorMsg,
            mobileDepotAccess.side,
          );
        }
        const mobileTractorUnitAccess =
          this._validateMobileTractorUnitCargoTransferAccess(
            session,
            item,
            destination,
          );
        if (!mobileTractorUnitAccess.success) {
          log.debug(
            `[InvBroker] MultiAdd rejected itemID=${itemID} mobileTractorUnit=${mobileTractorUnitAccess.containerID} error=${mobileTractorUnitAccess.errorMsg}`,
          );
          this._throwMobileTractorUnitCargoAccessError(
            mobileTractorUnitAccess.errorMsg,
            mobileTractorUnitAccess.side,
          );
        }
        const fittingServiceAccess = this._validateInSpaceFittingServiceAccess(
          session,
          shipRecord,
          item,
          destination,
        );
        if (!fittingServiceAccess.success) {
          log.debug(
            `[InvBroker] MultiAdd rejected itemID=${itemID} destination=${destination.locationID}:${destination.flagID} error=${fittingServiceAccess.errorMsg}`,
          );
          this._throwInSpaceFittingAccessError(
            fittingServiceAccess.errorMsg,
            fittingServiceAccess.tooFar,
          );
        }
        const dockedStructureFittingAccess = this._validateDockedStructureFittingServiceAccess(
          session,
          shipRecord,
          item,
          destination,
        );
        if (!dockedStructureFittingAccess.success) {
          log.debug(
            `[InvBroker] MultiAdd rejected itemID=${itemID} structure=${dockedStructureFittingAccess.structureID} destination=${destination.locationID}:${destination.flagID} error=${dockedStructureFittingAccess.errorMsg}`,
          );
          if (movedCount > 0) {
            recordSkip(itemID, "DOCKED_STRUCTURE_FITTING_DENIED", {
              item,
              errorMsg: dockedStructureFittingAccess.errorMsg,
            });
            continue;
          }
          this._throwDockedStructureFittingAccessError(dockedStructureFittingAccess.errorMsg);
        }
        const authoritativeSourceLocationID =
          this._getAuthoritativeTransferSourceLocationID(sourceItemDescriptor);
        const playerSpaceContainerLootEvaluation =
          this._evaluatePlayerSpaceContainerLootMove(
            session,
            authoritativeSourceLocationID,
            destination,
          );
        if (!playerSpaceContainerLootEvaluation.success) {
          throwWrappedUserError(
            playerSpaceContainerLootEvaluation.errorMsg || "SafetyActivated",
            {},
          );
        }
        const canBatchCargo = this._canBatchOrdinaryCargoMove(sourceItemDescriptor, destination);
        if (!canBatchCargo) {
          this._flushInventoryMoveBatchOrThrow(inventoryMoveBatch.flush());
        }
        let chargeTheftSettlement = null;
        let chargeLoadResult = null;
        try {
          chargeLoadResult = this._tryLoadChargeFromInventoryAdd(
            session,
            sourceItemDescriptor,
            destination,
            quantity,
            {
              beforeCommit: () => {
                chargeTheftSettlement =
                  this._ensurePlayerSpaceContainerTheftSettled(
                    session,
                    playerSpaceContainerLootEvaluation,
                  );
                return chargeTheftSettlement;
              },
            },
          );
        } catch (error) {
          this._compensatePlayerSpaceContainerTheft(
            session,
            chargeTheftSettlement,
          );
          throw error;
        }
        if (chargeLoadResult.handled) {
          if (!chargeLoadResult.success) {
            this._compensatePlayerSpaceContainerTheft(
              session,
              chargeTheftSettlement,
            );
            log.debug(
              `[InvBroker] MultiAdd charge load rejected itemID=${itemID} destination=${destination.locationID}:${destination.flagID} error=${chargeLoadResult.errorMsg}`,
            );
            recordSkip(itemID, "CHARGE_LOAD_FAILED", {
              item,
              errorMsg: chargeLoadResult.errorMsg,
            });
            continue;
          }

          this._commitPlayerSpaceContainerTheft(
            session,
            chargeTheftSettlement,
          );

          const chargeChanges =
            chargeLoadResult.data && Array.isArray(chargeLoadResult.data.changes)
              ? chargeLoadResult.data.changes
              : [];
          if (chargeChanges.length <= 0) {
            recordSkip(itemID, "CHARGE_LOAD_NO_CHANGES", { item });
            continue;
          }

          this._appendFleetLootEntry(
            session,
            fleetLootEntries,
            sourceItemDescriptor,
            sourceLocationID,
            destination,
            chargeLoadResult.data.quantity,
          );
          // Same contract as Handle_Add (dd1d81f6): a fitting-slot charge owes
          // the client the source-stack decrement and the charge tuple's
          // attribute 805, never a real fitted-charge row. Batching these into
          // allChanges published that denied identity and dropped the tuple
          // entirely, so they are published here and kept out of allChanges.
          this._emitFittedChargeLoadChanges(
            session,
            chargeChanges,
            chargeLoadResult.data.chargeTransition || null,
          );
          movedCount += 1;
          chargeLoadCount += 1;
          chargeLoadChanges.push(...chargeChanges);
          continue;
        }
        const fitValidation = this._validateFittingMove(
          session,
          fitHostRecord,
          item,
          destination,
          fittedItemsSnapshot,
        );
        if (!fitValidation.success) {
          firstFitValidationFailure =
            firstFitValidationFailure || { fitValidation, fitHostRecord, item };
          recordSkip(itemID, "FIT_VALIDATION_FAILED", {
            item,
            errorMsg: fitValidation.errorMsg,
          });
          continue;
        }
        const structureCoreValidation = this._validateStructureCoreInstallMove(
          item,
          destination,
        );
        if (!structureCoreValidation.success) {
          if (movedCount > 0) {
            recordSkip(itemID, "STRUCTURE_CORE_INSTALL_REJECTED", {
              item,
              errorMsg: structureCoreValidation.errorMsg,
            });
            continue;
          }
          throwWrappedUserError(
            structureCoreValidation.errorMsg,
            structureCoreValidation.values || {
              type: Number(item.typeID) || 0,
            },
          );
        }
        const shipBayValidation = this._validateShipBayMove(
          session,
          shipRecord,
          item,
          destination,
        );
        if (!shipBayValidation.success) {
          recordSkip(itemID, "SHIP_BAY_REJECTED", {
            item,
            errorMsg: shipBayValidation.errorMsg,
            validation: shipBayValidation,
          });
          continue;
        }
        const structureOwnerBayValidation = this._validateStructureOwnerBayMove(
          item,
          destination,
        );
        if (!structureOwnerBayValidation.success) {
          recordSkip(itemID, "STRUCTURE_OWNER_BAY_REJECTED", {
            item,
            errorMsg: structureOwnerBayValidation.errorMsg,
          });
          continue;
        }
        const structureServiceModuleRemovalAccess =
          this._validateStructureServiceModuleRemovalAccess(
            session,
            item,
            destination,
          );
        if (!structureServiceModuleRemovalAccess.success) {
          log.debug(
            `[InvBroker] MultiAdd rejected itemID=${itemID} structure=${structureServiceModuleRemovalAccess.structureID || 0} error=${structureServiceModuleRemovalAccess.errorMsg}`,
          );
          if (movedCount > 0) {
            recordSkip(itemID, "STRUCTURE_SERVICE_MODULE_REMOVAL_DENIED", {
              item,
              errorMsg: structureServiceModuleRemovalAccess.errorMsg,
            });
            continue;
          }
          throwWrappedUserError(
            "CrpAccessDenied",
            buildCrpAccessDeniedInsufficientRolesValues(),
          );
        }
        const unfitCargoOverflow = this._getUnfitCargoOverflow(
          session,
          item,
          destination,
        );
        if (unfitCargoOverflow) {
          recordSkip(itemID, "UNFIT_CARGO_OVERFLOW", {
            item,
            validation: unfitCargoOverflow,
          });
          continue;
        }
        const appliedQuantity = this._resolveAppliedMoveQuantity(
          item,
          destination,
          quantity,
          session,
        );
        const capacityCheck = this._checkCapacityForMove(
          session,
          boundContext,
          destination,
          item,
          appliedQuantity,
        );
        if (!capacityCheck.success) {
          log.debug(
            `[InvBroker] MultiAdd rejected itemID=${itemID} destination=${destination.locationID}:${destination.flagID} error=${capacityCheck.errorMsg}`,
          );
          if (capacityCheck.errorMsg === "NotEnoughCargoSpace") {
            throwWrappedUserError(
              "NotEnoughCargoSpace",
              this._buildCapacityMoveUserErrorValues(capacityCheck, item),
            );
          }
          throwWrappedUserError(
            capacityCheck.errorMsg,
            this._buildCapacityMoveUserErrorValues(capacityCheck, item),
          );
        }
        const isFittingMove =
          isShipFittingFlag(destination.flagID) || isShipFittingFlag(item.flagID);
        if (!attemptedModuleAttributeCapture && isFittingMove) {
          attemptedModuleAttributeCapture = true;
          previousModuleAttributeSnapshots = this._captureFittingModuleAttributeState(
            session,
            this._getShipId(session),
          );
          // Same pre-transaction requirement as FitFitting, for the same
          // reason: this loop runs _checkCapacityForMove per item, so a
          // multi-selection that mixes slots with a cargo or drone bay leaves a
          // post-fit snapshot in the cache from the second iteration on, and
          // the peek would diff it against itself. Captured lazily on the first
          // fitting move — a pure cargo drag never touches a slot and must not
          // pay for a forced snapshot rebuild.
          previousShipFittingSnapshot = getShipFittingSnapshot(
            this._getCharacterId(session),
            isShipFittingFlag(destination.flagID)
              ? this._normalizeInventoryId(destination.locationID, 0)
              : this._normalizeInventoryId(item.locationID, 0),
            {
              shipItem: fitHostRecord,
              forceRefresh: true,
              reason: "invbroker.multi-add.before",
            },
          );
        }
        const theftSettlement = this._ensurePlayerSpaceContainerTheftSettled(
          session,
          playerSpaceContainerLootEvaluation,
        );
        const moveBatch = canBatchCargo && !theftSettlement.receipt
          ? inventoryMoveBatch : undefined;
        let moveResult = null;
        try {
          if (!moveBatch) {
            this._flushInventoryMoveBatchOrThrow(inventoryMoveBatch.flush());
          }
          moveResult = this._moveSourceItemToDestination(
            session,
            sourceItemDescriptor,
            destination,
            appliedQuantity,
            moveBatch,
          );
        } catch (error) {
          this._compensatePlayerSpaceContainerTheft(session, theftSettlement);
          throw error;
        }
        if (!moveResult.success) {
          this._compensatePlayerSpaceContainerTheft(session, theftSettlement);
          // Parity with Handle_Add, which warns on this exact condition.
          log.warn(
            `[InvBroker] MultiAdd move failed itemID=${itemID} destination=${destination.locationID}:${destination.flagID} error=${moveResult.errorMsg}`,
          );
          recordSkip(itemID, "MOVE_FAILED", {
            item,
            errorMsg: moveResult.errorMsg,
          });
          continue;
        }
        const serviceModuleMoveResult = this._syncStructureServiceModuleMove(
          session,
          item,
          destination,
        );
        if (!serviceModuleMoveResult.success) {
          this._compensatePlayerSpaceContainerTheft(session, theftSettlement);
          recordSkip(itemID, "INDUSTRY_JOB_CANCEL_FAILED", {
            item,
            errorMsg: serviceModuleMoveResult.errorMsg,
          });
          continue;
        }
        this._commitPlayerSpaceContainerTheft(session, theftSettlement);
        this._appendFleetLootEntry(
          session,
          fleetLootEntries,
          sourceItemDescriptor,
          sourceLocationID,
          destination,
          appliedQuantity,
        );
        movedCount += 1;
        allChanges.push(...(moveResult.data.changes || []));
        // Classified post-commit on the same two rules Handle_Add uses, while
        // the source container is still alive — the finalizer expires it.
        // `item` is the pre-move record, which is what the loot rows carry.
        if (this._isMtuSpaceComponentLootMove(session, sourceLocationID, destination)) {
          mtuLoot.destination = mtuLoot.destination || destination;
          mtuLoot.items.push(item);
        }
        if (
          this._isPlayerSpaceContainerLootMove(session, sourceLocationID, destination)
        ) {
          spaceContainerLoot.destination = spaceContainerLoot.destination || destination;
          spaceContainerLoot.items.push(item);
        }
        this._syncStructureCoreInstall(session, item, destination);
        allChanges.push(
          ...this._resolveShipModuleFitOnlineChanges(session, item, destination),
        );
        if (
          fitHostRecord &&
          destination.locationID === fitHostRecord.itemID &&
          isShipFittingFlag(destination.flagID)
        ) {
          const movedItemID =
            this._resolveMovedItemID(moveResult, itemID, destination) || itemID;
          const movedItem = findItemById(movedItemID) || item;
          fittedItemsSnapshot.push({
            itemID: movedItemID,
            typeID: movedItem.typeID,
            flagID: destination.flagID,
            locationID: fitHostRecord.itemID,
            categoryID: movedItem.categoryID,
            groupID: movedItem.groupID,
          });
        }
      }
    } catch (error) {
      batchError = error;
    } finally {
      // Accepted prior moves still commit on a later capacity/access refusal.
      // Close even when no row moved, and never publish pending work as durable.
      durabilityResult = inventoryMoveBatch.commit();
      // Every skip inside the loop is silent on its own. Emit one line for the
      // whole batch so a drag that drops items still names each item and why.
      // This sits in a finally so a mid-loop UserError (capacity, access) does
      // not discard the reasons collected for the items ahead of it.
      if (skipReasons.length > 0) {
        log.warn(
          `[InvBroker] MultiAdd skipped ${skipReasons.length}/${itemIDs.length} moved=${movedCount} source=${sourceLocationID} requestedFlag=${String(requestedFlag)} bound=${boundContext.inventoryID}:${String(boundContext.flagID)} reasons=[${skipReasons.join(", ")}]`,
        );
      }
    }

    this._flushInventoryMoveBatchOrThrow(durabilityResult);
    if (batchError) {
      if (movedCount > 0) {
        this._finalizeMultiAddBatch(session, allChanges, fleetLootEntries, {
          movedCount, chargeLoadCount, chargeLoadChanges, mtuLoot, spaceContainerLoot,
          batchSize: itemIDs.length, sourceLocationID,
          destinationInventoryID: boundContext.inventoryID,
          destinationFlagID: requestedFlag, previousModuleAttributeSnapshots,
          previousShipFittingSnapshot, aborted: true,
        });
      }
      throw batchError;
    }

    if (movedCount <= 0) {
      this._throwFittingMoveUserError(
        firstFitValidationFailure && firstFitValidationFailure.fitValidation,
        firstFitValidationFailure && firstFitValidationFailure.fitHostRecord,
        firstFitValidationFailure && firstFitValidationFailure.item,
      );
      // _throwFittingMoveUserError only throws on a matched errorMsg; called
      // with nulls it falls through. Reaching `return null` here answers
      // CallRsp(None) — a successful empty response the client discards without
      // showing anything, so a batch that moved nothing looked like it worked.
      this._throwMultiAddZeroMoveUserError(firstSkip);
      return null;
    }

    this._finalizeMultiAddBatch(session, allChanges, fleetLootEntries, {
      movedCount,
      chargeLoadCount,
      chargeLoadChanges,
      mtuLoot,
      spaceContainerLoot,
      batchSize: itemIDs.length,
      sourceLocationID,
      destinationInventoryID: boundContext.inventoryID,
      destinationFlagID: requestedFlag,
      previousModuleAttributeSnapshots,
      previousShipFittingSnapshot,
    });
    return true;
  }

  _listShipInventoryFlagContents(session, flagID) {
    const boundContext = this._getBoundContext(session);
    const shipInventoryID =
      boundContext && boundContext.kind === "shipInventory"
        ? this._normalizeInventoryId(boundContext.inventoryID, this._getShipId(session))
        : this._getShipId(session);

    if (shipInventoryID <= 0) {
      return this._buildInventoryRemoteList([]);
    }

    const shipContext = {
      ...(boundContext || {}),
      kind: "shipInventory",
      inventoryID: shipInventoryID,
      flagID,
    };
    const itemsForFlag = this._resolveContainerItems(
      session,
      flagID,
      shipContext,
    );
    this._primeInSpaceBayDogmaItems(
      session,
      shipContext,
      flagID,
      itemsForFlag,
    );
    const itemOverrides = itemsForFlag
      .map((item) => this._buildInventoryItemOverrides(session, item))
      .filter(Boolean);

    return this._buildInventoryRemoteList(itemOverrides);
  }

  _listStructureInventoryFlagContents(session, flagID) {
    const boundContext = this._getBoundContext(session);
    const structureID = this._normalizeInventoryId(
      boundContext && boundContext.inventoryID,
      0,
    );
    const structure = this._getStructureForInventoryID(structureID);
    if (!structure) {
      return null;
    }

    const structureContext = {
      ...(boundContext || {}),
      inventoryID: structureID,
      locationID: structureID,
      flagID,
    };
    const itemsForFlag = this._resolveContainerItems(
      session,
      flagID,
      structureContext,
    );
    const itemOverrides = itemsForFlag
      .map((item) => this._buildInventoryItemOverrides(session, item))
      .filter(Boolean);

    return this._buildInventoryRemoteList(itemOverrides);
  }

  Handle_ListDroneBay(args, session, kwargs) {
    this._traceInventory("ListDroneBay", session, { args, kwargs });
    log.debug("[InvBroker] ListDroneBay");
    return this._listShipInventoryFlagContents(session, ITEM_FLAGS.DRONE_BAY);
  }

  Handle_ListFighterBay(args, session, kwargs) {
    this._traceInventory("ListFighterBay", session, { args, kwargs });
    log.debug("[InvBroker] ListFighterBay");
    return this._listShipInventoryFlagContents(session, ITEM_FLAGS.FIGHTER_BAY);
  }

  Handle_ListFuelBay(args, session, kwargs) {
    this._traceInventory("ListFuelBay", session, { args, kwargs });
    log.debug("[InvBroker] ListFuelBay");
    const structureFuelBay = this._listStructureInventoryFlagContents(
      session,
      STRUCTURE_FUEL_BAY_FLAG,
    );
    if (structureFuelBay) {
      return structureFuelBay;
    }
    return this._listShipInventoryFlagContents(session, ITEM_FLAGS.FUEL_BAY);
  }

  Handle_GetItemDescriptor(args, session) {
    this._traceInventory("GetItemDescriptor", session, { args });
    log.debug("[InvBroker] GetItemDescriptor");
    return this._buildInventoryRowDescriptor();
  }

  Handle_GetAvailableTurretSlots(args, session) {
    this._traceInventory("GetAvailableTurretSlots", session, { args });
    log.debug(
      `[InvBroker] GetAvailableTurretSlots ${describeSessionHydrationState(session)}`,
    );
    this._primeDeferredSpaceBallparkVisuals(
      session,
      this._getBoundContext(session),
      {
        reason: "GetAvailableTurretSlots",
      },
    );
    const charId = Number(
      session && (session.characterID || session.charid || session.userid),
    ) || 0;
    const shipID = Number(
      session && (session.shipID || session.shipid || session.activeShipID),
    ) || 0;
    const shipRecord =
      (charId > 0 && shipID > 0 ? findCharacterShip(charId, shipID) : null) ||
      (charId > 0 ? getActiveShipRecord(charId) : null) ||
      (shipID > 0 ? findShipItemById(shipID) : null);
    if (!shipRecord) {
      return 0;
    }

    const fittingSnapshot = getShipFittingSnapshot(charId, shipRecord.itemID, {
      shipItem: shipRecord,
      reason: "invbroker.turret-slots",
    });
    const resourceState = fittingSnapshot && fittingSnapshot.resourceState
      ? fittingSnapshot.resourceState
      : {};
    return Math.max(0, Number(resourceState && resourceState.turretSlotsLeft) || 0);
  }

  Handle_MachoResolveObject(args, session, kwargs) {
    const bindParameter = args && args[0];
    void bindParameter;
    this._traceInventory("MachoResolveObject", session, { args, kwargs });
    log.debug("[InvBroker] MachoResolveObject called");
    return PROXY_NODE_ID;
  }

  Handle_MachoBindObject(args, session, kwargs) {
    const config = require(path.join(__dirname, "../../config"));
    const bindParams = args && args.length > 0 ? args[0] : null;
    const nestedCall = args && args.length > 1 ? args[1] : null;
    const rawNestedMethod =
      nestedCall && Array.isArray(nestedCall) && nestedCall.length >= 1
        ? nestedCall[0]
        : null;
    const nestedMethodName =
      typeof rawNestedMethod === "string"
        ? rawNestedMethod
        : Buffer.isBuffer(rawNestedMethod)
          ? rawNestedMethod.toString("utf8")
          : rawNestedMethod &&
              typeof rawNestedMethod === "object" &&
              typeof rawNestedMethod.value === "string"
            ? rawNestedMethod.value
            : rawNestedMethod === null || rawNestedMethod === undefined
              ? null
              : String(rawNestedMethod);
    const sensitiveNestedCall =
      nestedMethodName === "SetPassword" ||
      nestedMethodName === "EnterPassword";
    const loggedNestedCall = sensitiveNestedCall
      ? [nestedMethodName, "<redacted>"]
      : nestedCall;
    const loggedArgs = sensitiveNestedCall
      ? [bindParams, loggedNestedCall]
      : args;
    const loggedKwargs = sensitiveNestedCall ? null : kwargs;
    const inventoryID =
      Array.isArray(bindParams) && bindParams.length > 0
        ? bindParams[0]
        : bindParams;
    if (this._isUnanchoredStructureHullInventoryID(inventoryID)) {
      this._throwUnanchoredStructureHullInventoryError();
    }
    if (this._isPendingStructureUnanchorContainerInventoryID(inventoryID)) {
      this._throwPendingStructureUnanchorContainerInventoryError();
    }

    log.debug(
      `[InvBroker] MachoBindObject args.length=${args ? args.length : 0} bindParams=${JSON.stringify(bindParams, (k, v) => (typeof v === "bigint" ? v.toString() : v))} nestedCall=${JSON.stringify(loggedNestedCall, (k, v) => (typeof v === "bigint" ? v.toString() : Buffer.isBuffer(v) ? v.toString("utf8") : v))} kwargs=${JSON.stringify(loggedKwargs, (k, v) => (typeof v === "bigint" ? v.toString() : Buffer.isBuffer(v) ? v.toString("utf8") : v))}`,
    );
    this._traceInventory("MachoBindObject", session, {
      args: loggedArgs,
      kwargs: loggedKwargs,
      bindParams,
      nestedCall: loggedNestedCall,
    });

    const boundId = config.getNextBoundId();
    const idString = `N=${PROXY_NODE_ID}:${boundId}`;
    const now = BigInt(Date.now()) * 10000n + 116444736000000000n;
    const oid = [idString, now];
    const requestedFlag =
      Array.isArray(bindParams) && bindParams.length > 1
        ? this._normalizeInventoryId(bindParams[1], 0)
        : null;

    const initialBoundContext = {
      inventoryID,
      locationID: inventoryID,
      flagID: this._isInventoryBindFlag(requestedFlag) ? requestedFlag : null,
      kind: "boundInventory",
    };
    if (incursionCargo.isReceiver(session, inventoryID)) {
      if (!incursionCargo.resolveReceiver(session, inventoryID)) throwWrappedUserError("FakeItemNotFound");
      initialBoundContext.kind = "incursionCargoReceiver";
      initialBoundContext.locationID = Number(session._space?.systemID || session.solarsystemid);
      initialBoundContext.flagID = ITEM_FLAGS.CARGO_HOLD;
    }
    this._rememberBoundContext(idString, initialBoundContext);
    this._rememberSessionBoundContext(session, idString, initialBoundContext, now);

    let callResult = null;
    if (nestedCall && Array.isArray(nestedCall) && nestedCall.length >= 1) {
      const methodName = nestedMethodName;
      const callArgs = nestedCall.length > 1 ? nestedCall[1] : [];
      const callKwargs = nestedCall.length > 2 ? nestedCall[2] : null;

      log.debug(`[InvBroker] MachoBindObject nested call: ${methodName}`);
      const previousBoundObjectID = session
        ? session.currentBoundObjectID
        : null;
      try {
        if (session) {
          session.currentBoundObjectID = idString;
        }
        callResult = this.callMethod(
          methodName,
          Array.isArray(callArgs) ? callArgs : [callArgs],
          session,
          callKwargs,
        );
        const nestedBoundId = this._extractBoundObjectId(callResult);
        const nestedBoundContext = nestedBoundId
          ? this._boundContexts.get(nestedBoundId) || null
          : null;
        if (nestedBoundContext) {
          this._rememberBoundContext(idString, nestedBoundContext);
          this._rememberSessionBoundContext(session, idString, nestedBoundContext, now);
        }
      } finally {
        if (session) {
          session.currentBoundObjectID = previousBoundObjectID || null;
        }
      }
    }

    return [
      {
        type: "substruct",
        value: { type: "substream", value: oid },
      },
      callResult != null ? callResult : null,
    ];
  }

  afterCallResponse(method, session) {
    if (!session) {
      return;
    }

    if (method === "GetAvailableTurretSlots") {
      return;
    }

    if (
      method === "GetInventoryFromId" ||
      method === "List" ||
      method === "GetSelfInvItem"
    ) {
      completeDockedFittingBootstrap(session, {
        trigger: `invbroker.${method}`,
      });
    }

    if (
      method !== "List" &&
      method !== "GetSelfInvItem"
    ) {
      return;
    }
    const boundContext = this._getBoundContext(session);
    if (!boundContext || boundContext.kind !== "stationHangar") {
      return;
    }

    if (!shouldFlushDeferredDockedShipSessionChange(session, method)) {
      return;
    }

    flushDeferredDockedShipSessionChange(session, {
      trigger: `invbroker.${method}`,
    });
  }
}

// Methods that belong to a system of their own live in ./invBroker/<system>.js and are put back
// on the prototype here, non-enumerable like the class's own methods.
function attachInvBrokerMethods(methods) {
  for (const [name, method] of Object.entries(methods)) {
    Object.defineProperty(InvBrokerService.prototype, name, {
      value: method,
      writable: true,
      configurable: true,
    });
  }
}

attachInvBrokerMethods(require(path.join(__dirname, "./invBroker/fittingOperations")));
attachInvBrokerMethods(require(path.join(__dirname, "./invBroker/secureContainers")));
attachInvBrokerMethods(require(path.join(__dirname, "./invBroker/corporationDelivery")));
attachInvBrokerMethods(require(path.join(__dirname, "./invBroker/trash")));
attachInvBrokerMethods(require(path.join(__dirname, "./invBroker/packaging")));
attachInvBrokerMethods(require(path.join(__dirname, "./invBroker/planetaryImportExport")));
attachInvBrokerMethods(require(path.join(__dirname, "./invBroker/assetSafetyRecovery")));
attachInvBrokerMethods(require(path.join(__dirname, "./invBroker/tradeInventory")));
attachInvBrokerMethods(require(path.join(__dirname, "./invBroker/plexVault")));

module.exports = InvBrokerService;
