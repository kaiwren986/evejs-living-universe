"use strict";

const {
  round6,
  toFiniteNumber,
  toInt,
} = require("../../common/numbers");

const path = require("path");

const {
  createTableRepository,
} = require(path.join(__dirname, "../../gameStore/tableRepository"));
const log = require(path.join(__dirname, "../../utils/logger"));

const {
  throwWrappedUserError,
} = require(path.join(__dirname, "../../common/machoErrors"));
const standingRuntime = require(path.join(
  __dirname,
  "../character/standingRuntime",
));
const {
  getCharacterRecord,
} = require(path.join(__dirname, "../character/characterState"));
const {
  getDockedLocationID,
  getDockedLocationKind,
} = require(path.join(__dirname, "../structure/structureLocation"));
const {
  getStationRecord,
  getStationServiceAccessRule,
} = require(path.join(__dirname, "../_shared/stationStaticData"));
const {
  getStructureByID,
  isDockingServiceOnline,
} = require(path.join(__dirname, "../structure/structureState"));
const {
  STRUCTURE_SERVICE_ID,
  STRUCTURE_SERVICE_STATE,
} = require(path.join(__dirname, "../structure/structureConstants"));
const {
  characterHasStructureService,
} = require(path.join(__dirname, "../structure/structurePayloads"));
const {
  buildEffectiveItemAttributeMap,
  getAttributeIDByNames,
  getFittedModuleItems,
} = require(path.join(__dirname, "../fitting/liveFittingState"));
const {
  adjustCharacterBalanceAsync,
  buildNotEnoughMoneyUserErrorValues,
  getCharacterWallet,
  JOURNAL_ENTRY_TYPE,
} = require(path.join(__dirname, "../account/walletState"));
const {
  adjustCorporationWalletDivisionBalanceAsync,
} = require(path.join(__dirname, "../corporation/corpWalletState"));
const {
  advanceSettlementSequenceWatermark,
  registerSettlementSequenceDomain,
} = require(path.join(__dirname, "../_shared/settlementSequenceWatermark"));
const {
  getFacilityTaxRate,
} = require(path.join(__dirname, "../industry/industryFacilityState"));
const {
  findItemById,
  ITEM_FLAGS,
  listContainerItems,
  normalizeShipConditionState,
  updateInventoryItem,
  updateShipItem,
} = require(path.join(__dirname, "../inventory/itemStore"));
const {
  resolveItemByTypeID,
} = require(path.join(__dirname, "../inventory/itemTypeRegistry"));
const {
  getAdjustedAveragePrice,
} = require(path.join(__dirname, "../reprocessing/reprocessingStaticData"));

const CATEGORY_SHIP = 6;
const CATEGORY_MODULE = 7;
const CATEGORY_DRONE = 18;
const CATEGORY_DEPLOYABLE = 22;
const CATEGORY_STARBASE = 23;
const CATEGORY_STRUCTURE_MODULE = 66;

const GROUP_CARGO_CONTAINER = 12;
const GROUP_TOOL = 332;
const GROUP_SECURE_CARGO_CONTAINER = 340;
const GROUP_AUDIT_LOG_SECURE_CONTAINER = 448;
const GROUP_FREIGHT_CONTAINER = 649;

const REPAIR_SERVICE_ID = 13;
const STRUCTURE_REPAIR_SERVICE_ID = STRUCTURE_SERVICE_ID.REPAIR;
const STATION_REPAIR_COST_MULTIPLIER = 0.1;
const AIR_TRADE_HUB_TYPE_ID = 92885;
const DOCKED_SHIP_REPAIR_ALIAS_OFFSET = 4_000_000_000_000_000;
const REPAIR_OPERATIONS_TABLE = "repairOperations";
const DURABLE_SETTLEMENT_JOB_TYPE = "repair.settle";
const repairRepo = createTableRepository("service:repair", { strict: true });
let repairOperationStateCache = null;
let durableScheduler = null;
const repairOperationLanes = new Map();
const repairRequestLanes = new Map();

const REPAIRABLE_GROUP_IDS = new Set([
  GROUP_CARGO_CONTAINER,
  GROUP_SECURE_CARGO_CONTAINER,
  GROUP_AUDIT_LOG_SECURE_CONTAINER,
  GROUP_FREIGHT_CONTAINER,
  GROUP_TOOL,
]);

const REPAIRABLE_CATEGORY_IDS = new Set([
  CATEGORY_DEPLOYABLE,
  CATEGORY_SHIP,
  CATEGORY_DRONE,
  CATEGORY_STARBASE,
  CATEGORY_MODULE,
  CATEGORY_STRUCTURE_MODULE,
]);

function getFallbackRepairBasePrice(item) {
  const itemType = resolveItemByTypeID(toInt(item && item.typeID, 0));
  const categoryID = toInt(
    item && item.categoryID !== undefined
      ? item.categoryID
      : itemType && itemType.categoryID,
    0,
  );
  const volume = Math.max(
    0,
    toFiniteNumber(
      item && item.volume !== undefined ? item.volume : itemType && itemType.volume,
      0,
    ),
  );

  if (categoryID === CATEGORY_SHIP) {
    return Math.max(10000, volume > 0 ? volume : 0);
  }
  if (categoryID === CATEGORY_MODULE || categoryID === CATEGORY_STRUCTURE_MODULE) {
    return Math.max(1000, volume > 0 ? volume * 100 : 0);
  }
  if (categoryID === CATEGORY_DRONE) {
    return Math.max(500, volume > 0 ? volume * 100 : 0);
  }
  return Math.max(100, volume > 0 ? volume * 25 : 0);
}

function round2(value) {
  return Number(toFiniteNumber(value, 0).toFixed(2));
}

function cloneValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function createDefaultRepairOperationState() {
  return {
    _meta: {
      schemaVersion: 1,
      nextOperationID: 1,
    },
    operationsByID: {},
  };
}

function ensureRepairOperationState() {
  if (repairOperationStateCache) {
    return repairOperationStateCache;
  }
  const result = repairRepo.read(REPAIR_OPERATIONS_TABLE, "/");
  const state =
    result.success && result.data && typeof result.data === "object"
      ? result.data
      : createDefaultRepairOperationState();
  let changed = false;
  if (!state._meta || typeof state._meta !== "object") {
    state._meta = createDefaultRepairOperationState()._meta;
    changed = true;
  }
  if (toInt(state._meta.nextOperationID, 0) <= 0) {
    state._meta.nextOperationID = 1;
    changed = true;
  }
  if (!state.operationsByID || typeof state.operationsByID !== "object") {
    state.operationsByID = {};
    changed = true;
  }
  repairOperationStateCache = state;
  if (changed) {
    repairRepo.write(REPAIR_OPERATIONS_TABLE, "/", state);
  }
  return repairOperationStateCache;
}

function persistRepairOperationState() {
  return repairRepo.write(
    REPAIR_OPERATIONS_TABLE,
    "/",
    ensureRepairOperationState(),
  );
}

function persistRepairOperationMutation(mutate) {
  const state = ensureRepairOperationState();
  const snapshot = cloneValue(state);
  const data = mutate(state);
  const writeResult = persistRepairOperationState();
  if (!writeResult || !writeResult.success) {
    repairOperationStateCache = snapshot;
    return {
      success: false,
      errorMsg: writeResult && writeResult.errorMsg || "WRITE_ERROR",
    };
  }
  return {
    success: true,
    data,
  };
}

function runSerialized(lanes, key, operation) {
  const laneKey = String(key || "");
  const previous = lanes.get(laneKey) || Promise.resolve();
  const current = previous.catch(() => null).then(operation);
  lanes.set(laneKey, current);
  void current.finally(() => {
    if (lanes.get(laneKey) === current) {
      lanes.delete(laneKey);
    }
  }).catch(() => null);
  return current;
}

function resetRepairOperationStateForTests() {
  repairOperationStateCache = null;
  repairOperationLanes.clear();
  repairRequestLanes.clear();
}

function clampRatio(value, fallback = 0) {
  return Math.max(0, Math.min(1, toFiniteNumber(value, fallback)));
}

function normalizeModuleConditionState(item) {
  const moduleState =
    item && item.moduleState && typeof item.moduleState === "object"
      ? item.moduleState
      : {};

  return {
    damage: clampRatio(moduleState.damage, 0),
    charge: clampRatio(moduleState.charge, 0),
    armorDamage: clampRatio(moduleState.armorDamage, 0),
    shieldCharge: clampRatio(moduleState.shieldCharge, 1),
    incapacitated: moduleState.incapacitated === true,
  };
}

function normalizeRepairConditionState(item) {
  if (item && item.conditionState && typeof item.conditionState === "object") {
    return normalizeShipConditionState(item.conditionState);
  }
  return normalizeModuleConditionState(item);
}

function isRepairableInventoryItem(item) {
  if (!item || typeof item !== "object") {
    return false;
  }
  if (!item.singleton) {
    return false;
  }

  const groupID = toInt(item.groupID, 0);
  const categoryID = toInt(item.categoryID, 0);
  return (
    REPAIRABLE_GROUP_IDS.has(groupID) ||
    REPAIRABLE_CATEGORY_IDS.has(categoryID)
  );
}

function getItemDockedAncestorInfo(item) {
  const chain = [];
  let current = item && typeof item === "object" ? item : null;
  const seen = new Set();

  while (current && toInt(current.itemID, 0) > 0 && !seen.has(toInt(current.itemID, 0))) {
    chain.push(current);
    seen.add(toInt(current.itemID, 0));
    const parent = findItemById(current.locationID);
    if (!parent) {
      break;
    }
    current = parent;
  }

  const leaf = chain[0] || item || null;
  const rootItem = chain.length > 0 ? chain[chain.length - 1] : null;
  const rootLocationID = toInt(
    rootItem ? rootItem.locationID : leaf && leaf.locationID,
    0,
  );

  return {
    chain,
    leaf,
    rootItem,
    rootLocationID,
  };
}

function isItemAccessibleForRepair(item, context) {
  if (!item || !context) {
    return false;
  }
  if (!isRepairableInventoryItem(item)) {
    return false;
  }
  if (toInt(item.ownerID, 0) !== toInt(context.characterID, 0)) {
    return false;
  }

  const ancestorInfo = getItemDockedAncestorInfo(item);
  return ancestorInfo.rootLocationID === toInt(context.dockedLocationID, 0);
}

function isItemDirectlyInPersonalHangar(item, context) {
  if (!item || !context) {
    return false;
  }
  return (
    isRepairableInventoryItem(item) &&
    toInt(item.ownerID, 0) === toInt(context.characterID, 0) &&
    toInt(item.locationID, 0) === toInt(context.dockedLocationID, 0) &&
    toInt(item.flagID, 0) === ITEM_FLAGS.HANGAR
  );
}

function getRepairAttributeValue(attributes, ...names) {
  for (const name of names) {
    const attributeID = getAttributeIDByNames(name);
    if (!attributeID || !attributes || attributes[attributeID] === undefined) {
      continue;
    }
    const numericValue = Number(attributes[attributeID]);
    if (Number.isFinite(numericValue)) {
      return numericValue;
    }
  }
  return 0;
}

function getItemHealthSnapshot(item) {
  const conditionState = normalizeRepairConditionState(item);
  // A mutated (abyssal) item carries a result typeID that holds almost no dogma
  // of its own: hp, armorHP and shieldCapacity come from the source type the
  // mutaplasmid was applied to, with any rolled values layered over it. Reading
  // the item's effective attribute map instead of its raw type keeps damaged
  // abyssal gear quotable — a plain type lookup reports zero max health, which
  // drops the item out of the repair list entirely.
  const attributes = buildEffectiveItemAttributeMap(item);
  const shieldCapacity = Math.max(
    0,
    toFiniteNumber(getRepairAttributeValue(attributes, "shieldCapacity"), 0),
  );
  const armorHP = Math.max(
    0,
    toFiniteNumber(getRepairAttributeValue(attributes, "armorHP"), 0),
  );
  const structureHP = Math.max(
    0,
    toFiniteNumber(getRepairAttributeValue(attributes, "hp", "structureHP"), 0),
  );

  const shieldDamage = shieldCapacity * (1 - clampRatio(conditionState.shieldCharge, 1));
  const armorDamage = armorHP * clampRatio(conditionState.armorDamage, 0);
  const structureDamage = structureHP * clampRatio(conditionState.damage, 0);
  const maxHealth = shieldCapacity + armorHP + structureHP;
  const damage = shieldDamage + armorDamage + structureDamage;

  return {
    conditionState,
    shieldCapacity,
    armorHP,
    structureHP,
    shieldDamage,
    armorDamage,
    structureDamage,
    maxHealth,
    damage,
  };
}

function getStructureRepairTaxRate(context) {
  if (!context || context.dockedKind !== "structure") {
    return 0;
  }

  return Math.max(
    0,
    toFiniteNumber(
      getFacilityTaxRate(
        context.dockedLocationID,
        context.structure
          ? {
              facilityID: context.dockedLocationID,
              ownerID: toInt(
                context.structure.ownerCorpID || context.structure.ownerID,
                0,
              ),
              tax: 0,
            }
          : {
              facilityID: context.dockedLocationID,
              ownerID: toInt(context.stationRecord && context.stationRecord.ownerID, 0),
              tax: 0,
            },
      ),
      0,
    ),
  );
}

function getRepairCostProfile(item, context) {
  const health = getItemHealthSnapshot(item);
  const maxHealth = Math.max(0, toFiniteNumber(health.maxHealth, 0));
  if (!(maxHealth > 0)) {
    return {
      maxHealth: 0,
      damage: 0,
      baseUnitCost: 0,
      unitCost: 0,
      structureTaxRate: 0,
    };
  }

  const staticBasePrice = Math.max(
    0,
    toFiniteNumber(getAdjustedAveragePrice(item.typeID), 0),
  );
  const basePrice =
    staticBasePrice > 0 ? staticBasePrice : getFallbackRepairBasePrice(item);
  const baseUnitCost = basePrice > 0
    ? (basePrice * STATION_REPAIR_COST_MULTIPLIER) / maxHealth
    : 0;
  // Upwell repair services do not charge for repairs. Keep all client-facing
  // price components at zero as well as the eventual settlement charge so the
  // quote window and the committed repair agree.
  if (context && context.dockedKind === "structure") {
    return {
      ...health,
      basePrice,
      baseUnitCost: 0,
      unitCost: 0,
      structureTaxRate: 0,
    };
  }
  const structureTaxRate = getStructureRepairTaxRate(context);

  return {
    ...health,
    basePrice,
    baseUnitCost: round6(baseUnitCost),
    unitCost: round6(baseUnitCost),
    structureTaxRate,
  };
}

function buildQuoteRecord(item, context) {
  if (!item || !context || !isItemAccessibleForRepair(item, context)) {
    return null;
  }

  const costProfile = getRepairCostProfile(item, context);
  if (!(costProfile.maxHealth > 0) || !(costProfile.damage > 0)) {
    return null;
  }

  return {
    itemID: toInt(item.itemID, 0),
    typeID: toInt(item.typeID, 0),
    groupID: toInt(item.groupID, 0),
    categoryID: toInt(item.categoryID, 0),
    damage: round6(costProfile.damage),
    maxHealth: round6(costProfile.maxHealth),
    costToRepairOneUnitOfDamage: round6(costProfile.unitCost),
    structureTaxRate: round6(costProfile.structureTaxRate),
    baseCostToRepairOneUnitOfDamage: round6(costProfile.baseUnitCost),
  };
}

function shouldAliasDockedShipRepairQuote(context, session) {
  return (
    context &&
    context.dockedKind === "station" &&
    toInt(context.stationRecord && context.stationRecord.stationTypeID, 0) ===
      AIR_TRADE_HUB_TYPE_ID &&
    toInt(session && (session.shipid || session.shipID || session.activeShipID), 0) > 0
  );
}

function encodeDockedShipRepairQuoteItemID(itemID) {
  const numericItemID = toInt(itemID, 0);
  if (numericItemID <= 0) {
    return 0;
  }

  return DOCKED_SHIP_REPAIR_ALIAS_OFFSET + numericItemID;
}

function decodeDockedShipRepairQuoteItemID(itemID) {
  const numericItemID = toInt(itemID, 0);
  if (numericItemID < DOCKED_SHIP_REPAIR_ALIAS_OFFSET) {
    return numericItemID;
  }

  return numericItemID - DOCKED_SHIP_REPAIR_ALIAS_OFFSET;
}

function resolveQuotedRepairItemID(session, context, itemID) {
  const numericItemID = toInt(itemID, 0);
  if (numericItemID <= 0) {
    return 0;
  }

  const activeShipID = toInt(
    session && (session.shipid || session.shipID || session.activeShipID),
    0,
  );
  if (
    activeShipID > 0 &&
    shouldAliasDockedShipRepairQuote(context, session) &&
    numericItemID === activeShipID
  ) {
    return encodeDockedShipRepairQuoteItemID(numericItemID);
  }

  return numericItemID;
}

function resolveRepairContext(session) {
  const characterID = toInt(
    session && (session.characterID || session.charid),
    0,
  );
  if (characterID <= 0) {
    return {
      success: false,
      errorMsg: "CHARACTER_NOT_FOUND",
    };
  }

  const dockedLocationID = toInt(getDockedLocationID(session), 0);
  if (dockedLocationID <= 0) {
    return {
      success: false,
      errorMsg: "NOT_DOCKED",
    };
  }

  const dockedKind = getDockedLocationKind(session);
  const stationRecord = getStationRecord(session, dockedLocationID);
  const structure =
    dockedKind === "structure"
      ? getStructureByID(dockedLocationID, { refresh: false })
      : null;

  if (dockedKind === "structure") {
    if (
      !characterHasStructureService(
        session,
        structure,
        STRUCTURE_REPAIR_SERVICE_ID,
      )
    ) {
      return {
        success: false,
        errorMsg: structure && isDockingServiceOnline(structure) && structure.hasQuantumCore === true &&
          Number(structure.serviceStates && structure.serviceStates[String(STRUCTURE_REPAIR_SERVICE_ID)]) === STRUCTURE_SERVICE_STATE.ONLINE
          ? "REPAIR_ACCESS_DENIED"
          : "REPAIR_OFFLINE",
      };
    }
  }

  const standingInfo = standingRuntime.getCharacterEffectiveStanding(
    characterID,
    stationRecord && stationRecord.ownerID,
  );

  return {
    success: true,
    data: {
      characterID,
      dockedLocationID,
      dockedKind,
      stationRecord,
      structure,
      standing: toFiniteNumber(standingInfo && standingInfo.standing, 0),
    },
  };
}

function throwRepairError(errorMsg, values = {}) {
  switch (String(errorMsg || "")) {
    case "CHARACTER_NOT_FOUND":
      throwWrappedUserError("CustomNotify", {
        notify: "Select a character before using repair services.",
      });
      break;
    case "NOT_DOCKED":
      throwWrappedUserError("CustomNotify", {
        notify: "You must be docked to use repair services.",
      });
      break;
    case "REPAIR_OFFLINE":
      throwWrappedUserError("CustomNotify", {
        notify: "The repair service is offline at this structure.",
      });
      break;
    case "REPAIR_ACCESS_DENIED":
      throwWrappedUserError("CustomNotify", {
        notify: "You do not have access to the repair service at this structure.",
      });
      break;
    case "REPAIR_STATION_ONLY":
      throwWrappedUserError("CustomNotify", {
        notify: "This repair call is only valid while docked in a station.",
      });
      break;
    case "REPAIR_STRUCTURE_ONLY":
      throwWrappedUserError("CustomNotify", {
        notify: "This repair call is only valid while docked in a structure.",
      });
      break;
    case "MODULE_PARTIAL_REPAIR":
      throwWrappedUserError("CustomNotify", {
        notify: "Modules must be repaired in full.",
      });
      break;
    case "INSUFFICIENT_FUNDS":
      throwWrappedUserError(
        "NotEnoughMoney",
        buildNotEnoughMoneyUserErrorValues(
          values.amount,
          values.balance,
        ),
      );
      break;
    default:
      throwWrappedUserError("CustomNotify", {
        notify:
          typeof values.notify === "string" && values.notify.trim() !== ""
            ? values.notify
            : "Repair service failed.",
      });
      break;
  }
}

function enforceRepairAccess(context) {
  if (!context) {
    throwRepairError("NOT_DOCKED");
  }

  if (context.dockedKind !== "station") {
    return;
  }

  const rule = getStationServiceAccessRule(
    REPAIR_SERVICE_ID,
    context.stationRecord && context.stationRecord.ownerID,
  );
  const minimumStanding = toFiniteNumber(rule && rule.minimumStanding, 0);
  if (minimumStanding !== 0 && toFiniteNumber(context.standing, 0) < minimumStanding) {
    throwWrappedUserError("CustomNotify", {
      notify: "Your standings are too low to access this service.",
    });
  }

  const character = getCharacterRecord(context.characterID) || {};
  const securityStatus = toFiniteNumber(
    character.securityStatus ?? character.securityRating,
    0,
  );
  const minimumCharSecurity = toFiniteNumber(rule && rule.minimumCharSecurity, 0);
  const maximumCharSecurity = toFiniteNumber(rule && rule.maximumCharSecurity, 0);

  if (minimumCharSecurity !== 0 && securityStatus < minimumCharSecurity) {
    throwWrappedUserError("CustomNotify", {
      notify: "Your security status is too low to access this service.",
    });
  }
  if (maximumCharSecurity !== 0 && securityStatus > maximumCharSecurity) {
    throwWrappedUserError("CustomNotify", {
      notify: "Your security status is too high to access this service.",
    });
  }
}

function resolveQuoteItem(session, context, itemReference) {
  const itemID = toInt(itemReference && (itemReference.itemID ?? itemReference), 0);
  if (itemID <= 0) {
    return null;
  }

  const item = findItemById(itemID);
  if (!item || !isItemAccessibleForRepair(item, context)) {
    return null;
  }

  const ancestorInfo = getItemDockedAncestorInfo(item);
  const rootItem = ancestorInfo.rootItem;
  if (
    rootItem &&
    rootItem.itemID !== item.itemID &&
    toInt(rootItem.itemID, 0) > 0 &&
    isItemDirectlyInPersonalHangar(rootItem, context) &&
    session &&
    session._requestedRepairQuoteItemIDs instanceof Set &&
    session._requestedRepairQuoteItemIDs.has(toInt(rootItem.itemID, 0))
  ) {
    return {
      item,
      suppressAsNestedDuplicate: true,
    };
  }

  return {
    item,
    suppressAsNestedDuplicate: false,
  };
}

// The client only offers a repair quote on items sitting directly in the
// personal hangar (menucheckers OfferRepairItems), so drones parked in a ship's
// drone bay can never be selected on their own. They only reach the repair shop
// when the server expands the selected hangar ship into its repairable contents,
// exactly like the fitted modules do.
function getRepairableShipBayItems(context, shipItem) {
  const shipID = toInt(shipItem && shipItem.itemID, 0);
  if (shipID <= 0) {
    return [];
  }

  return listContainerItems(
    toInt(context && context.characterID, 0),
    shipID,
    ITEM_FLAGS.DRONE_BAY,
  ).filter((item) => isRepairableInventoryItem(item));
}

function buildQuoteGroupForRequestedItem(session, context, itemReference) {
  const resolved = resolveQuoteItem(session, context, itemReference);
  const requestedItemID = toInt(itemReference && (itemReference.itemID ?? itemReference), 0);
  if (!resolved || !resolved.item || requestedItemID <= 0) {
    return {
      requestedItemID,
      rows: [],
    };
  }

  if (resolved.suppressAsNestedDuplicate) {
    return {
      requestedItemID,
      rows: [],
    };
  }

  const rows = [];
  const seen = new Set();
  const pushQuoteForItem = (candidate) => {
    const quote = buildQuoteRecord(candidate, context);
    const actualItemID = toInt(candidate && candidate.itemID, 0);
    if (!quote || actualItemID <= 0 || seen.has(actualItemID)) {
      return;
    }
    seen.add(actualItemID);
    quote.itemID = resolveQuotedRepairItemID(session, context, actualItemID);
    rows.push(quote);
  };

  const item = resolved.item;
  if (
    toInt(item.categoryID, 0) === CATEGORY_SHIP &&
    isItemDirectlyInPersonalHangar(item, context)
  ) {
    pushQuoteForItem(item);
    for (const moduleItem of getFittedModuleItems(context.characterID, item.itemID)) {
      pushQuoteForItem(moduleItem);
    }
    for (const bayItem of getRepairableShipBayItems(context, item)) {
      pushQuoteForItem(bayItem);
    }
  } else {
    pushQuoteForItem(item);
  }

  return {
    requestedItemID,
    rows,
  };
}

function buildRepairQuotesForSelection(session, itemReferences = []) {
  const contextResult = resolveRepairContext(session);
  if (!contextResult.success || !contextResult.data) {
    return contextResult;
  }

  const context = contextResult.data;
  enforceRepairAccess(context);

  session._requestedRepairQuoteItemIDs = new Set(
    (Array.isArray(itemReferences) ? itemReferences : [])
      .map((itemReference) => toInt(itemReference && (itemReference.itemID ?? itemReference), 0))
      .filter((itemID) => itemID > 0),
  );

  const groupedQuotes = new Map();
  for (const itemReference of Array.isArray(itemReferences) ? itemReferences : []) {
    const { requestedItemID, rows } = buildQuoteGroupForRequestedItem(
      session,
      context,
      itemReference,
    );
    if (requestedItemID <= 0 || groupedQuotes.has(requestedItemID)) {
      continue;
    }
    groupedQuotes.set(requestedItemID, rows);
  }

  delete session._requestedRepairQuoteItemIDs;

  return {
    success: true,
    data: {
      context,
      groupedQuotes,
    },
  };
}

function buildLegacyDamageReportsForSelection(session, itemReferences = []) {
  const quoteResult = buildRepairQuotesForSelection(session, itemReferences);
  if (!quoteResult.success || !quoteResult.data) {
    return quoteResult;
  }

  const reportsByItemID = new Map();
  for (const [itemID, rows] of quoteResult.data.groupedQuotes.entries()) {
    reportsByItemID.set(itemID, {
      discount: "0%",
      serviceCharge: "0%",
      playerStanding: toFiniteNumber(quoteResult.data.context.standing, 0),
      lines: rows,
    });
  }

  return {
    success: true,
    data: {
      context: quoteResult.data.context,
      reportsByItemID,
    },
  };
}

function resolveRepairExecutionItem(context, itemReference) {
  const itemID = decodeDockedShipRepairQuoteItemID(
    itemReference && (itemReference.itemID ?? itemReference),
  );
  if (itemID <= 0) {
    return null;
  }

  const item = findItemById(itemID);
  if (!item || !isItemAccessibleForRepair(item, context)) {
    return null;
  }
  return item;
}

function buildRepairExecutionTargets(context, itemReferences = []) {
  const targets = [];
  const seen = new Set();

  for (const itemReference of Array.isArray(itemReferences) ? itemReferences : []) {
    const item = resolveRepairExecutionItem(context, itemReference);
    const itemID = toInt(item && item.itemID, 0);
    if (!item || itemID <= 0 || seen.has(itemID)) {
      continue;
    }

    const quote = buildQuoteRecord(item, context);
    seen.add(itemID);
    if (!quote) {
      continue;
    }

    targets.push({
      itemID,
      item,
      quote,
      fullCost: Math.ceil(toFiniteNumber(quote.damage, 0)) * toFiniteNumber(quote.costToRepairOneUnitOfDamage, 0),
    });
  }

  return targets;
}

function applyRepairToHealthSnapshot(snapshot, repairAmount) {
  const remainingRepair = Math.max(0, toFiniteNumber(repairAmount, 0));
  let remaining = remainingRepair;

  const repairStructure = Math.min(snapshot.structureDamage, remaining);
  remaining -= repairStructure;
  const repairArmor = Math.min(snapshot.armorDamage, remaining);
  remaining -= repairArmor;
  const repairShield = Math.min(snapshot.shieldDamage, remaining);

  const nextStructureDamage = Math.max(0, snapshot.structureDamage - repairStructure);
  const nextArmorDamage = Math.max(0, snapshot.armorDamage - repairArmor);
  const nextShieldDamage = Math.max(0, snapshot.shieldDamage - repairShield);

  return {
    damage:
      snapshot.structureHP > 0
        ? clampRatio(nextStructureDamage / snapshot.structureHP, 0)
        : 0,
    armorDamage:
      snapshot.armorHP > 0
        ? clampRatio(nextArmorDamage / snapshot.armorHP, 0)
        : 0,
    shieldCharge:
      snapshot.shieldCapacity > 0
        ? clampRatio(1 - nextShieldDamage / snapshot.shieldCapacity, 1)
        : 1,
  };
}

function buildRepairStatePatch(item, repairAmount) {
  const snapshot = getItemHealthSnapshot(item);
  const nextState = applyRepairToHealthSnapshot(snapshot, repairAmount);
  const usesConditionState =
    (item && item.conditionState && typeof item.conditionState === "object") ||
    toInt(item && item.categoryID, 0) === CATEGORY_SHIP ||
    toInt(item && item.categoryID, 0) === CATEGORY_DRONE;

  if (usesConditionState) {
    return {
      conditionState: normalizeShipConditionState({
        ...(item.conditionState || {}),
        damage: nextState.damage,
        armorDamage: nextState.armorDamage,
        shieldCharge: nextState.shieldCharge,
      }),
    };
  }

  return {
    moduleState: {
      ...(item.moduleState || {}),
      damage: nextState.damage,
      armorDamage: nextState.armorDamage,
      shieldCharge: nextState.shieldCharge,
      incapacitated: false,
    },
  };
}

function buildRepairTargetPatches(repairPlan = []) {
  const targets = [];
  for (const planEntry of Array.isArray(repairPlan) ? repairPlan : []) {
    const itemID = toInt(planEntry && planEntry.itemID, 0);
    const currentItem = findItemById(itemID);
    if (!currentItem || !(toFiniteNumber(planEntry.repairAmount, 0) > 0)) {
      continue;
    }
    targets.push({
      itemID,
      categoryID: toInt(currentItem.categoryID, 0),
      patch: buildRepairStatePatch(currentItem, planEntry.repairAmount),
    });
  }
  return targets;
}

function applyRepairTargetPatches(targetPatches = []) {
  const changes = [];
  for (const target of Array.isArray(targetPatches) ? targetPatches : []) {
    const itemID = toInt(target && target.itemID, 0);
    const currentItem = findItemById(itemID);
    if (!currentItem || !target.patch || typeof target.patch !== "object") {
      continue;
    }
    const updateResult =
      toInt(target.categoryID, 0) === CATEGORY_SHIP
        ? updateShipItem(itemID, (existingItem) => ({
            ...existingItem,
            ...cloneValue(target.patch),
          }))
        : updateInventoryItem(itemID, (existingItem) => ({
            ...existingItem,
            ...cloneValue(target.patch),
          }));
    if (updateResult && updateResult.success) {
      changes.push({
        previousData: updateResult.previousData || {},
        item: updateResult.data,
      });
    }
  }
  return changes;
}

function buildStructureRepairTax(context, chargeAmount) {
  if (!context || context.dockedKind !== "structure") {
    return null;
  }

  const structureTaxRate = getStructureRepairTaxRate(context);
  if (!(structureTaxRate > 0)) {
    return null;
  }

  const ownerCorporationID = toInt(
    context.structure && (context.structure.ownerCorpID || context.structure.ownerID),
    0,
  );
  if (ownerCorporationID <= 0) {
    return null;
  }

  const taxCredit = round2(
    toFiniteNumber(chargeAmount, 0) * (structureTaxRate / (1 + structureTaxRate)),
  );
  if (!(taxCredit > 0)) {
    return null;
  }

  return {
    amount: taxCredit,
    ownerCorporationID,
  };
}

function buildDurableRepairSettlementJob(operationID) {
  const normalizedOperationID = String(operationID || "").trim();
  if (!normalizedOperationID) {
    return null;
  }
  return {
    jobID: `${normalizedOperationID}:settle`,
    type: DURABLE_SETTLEMENT_JOB_TYPE,
    dueAtMs: Date.now(),
    payload: {
      operationID: normalizedOperationID,
    },
  };
}

function bindDurableScheduler(scheduler) {
  if (!scheduler || typeof scheduler.schedule !== "function") {
    throw new TypeError("repair scheduler requires a schedule function");
  }
  durableScheduler = scheduler;
  return true;
}

function unbindDurableScheduler(scheduler = null) {
  if (scheduler && scheduler !== durableScheduler) {
    return false;
  }
  durableScheduler = null;
  return true;
}

async function schedulePendingRepairOperation(operationID) {
  if (!durableScheduler) {
    return null;
  }
  const job = buildDurableRepairSettlementJob(operationID);
  if (!job) {
    return null;
  }
  await durableScheduler.schedule(job);
  return job;
}

async function debitRepairOperation(operation) {
  if (!(operation.chargedAmount > 0)) {
    return { success: true, data: null };
  }
  return adjustCharacterBalanceAsync(
    operation.characterID,
    -operation.chargedAmount,
    {
      description: "Repair service charge",
      idempotencyKey: operation.debitCommandID,
      ownerID1: operation.characterID,
      ownerID2: operation.serviceOwnerID,
      referenceID: operation.dockedLocationID,
      entryTypeID: JOURNAL_ENTRY_TYPE.TRANSACTION_TAX,
    },
    {
      commandID: operation.debitCommandID,
      idempotencyKey: operation.debitCommandID,
      source: "repair.charge",
    },
  );
}

async function creditRepairTaxOperation(operation) {
  if (!(operation.taxCredit > 0) || !operation.taxOwnerCorporationID) {
    return { success: true, data: null };
  }
  return adjustCorporationWalletDivisionBalanceAsync(
    operation.taxOwnerCorporationID,
    1000,
    operation.taxCredit,
    {
      description: "Repair service tax income",
      idempotencyKey: operation.taxCommandID,
      ownerID1: operation.characterID,
      ownerID2: operation.taxOwnerCorporationID,
      referenceID: operation.dockedLocationID,
      entryTypeID: JOURNAL_ENTRY_TYPE.TRANSACTION_TAX,
    },
    {
      commandID: operation.taxCommandID,
      idempotencyKey: operation.taxCommandID,
      source: "repair.tax-credit",
    },
  );
}

function settlePendingRepairOperation(operationID) {
  const normalizedOperationID = String(operationID || "").trim();
  return runSerialized(repairOperationLanes, normalizedOperationID, async () => {
    const operation = cloneValue(
      ensureRepairOperationState().operationsByID[normalizedOperationID] || null,
    );
    if (!operation) {
      return {
        success: true,
        alreadySettled: true,
        data: { changes: [] },
      };
    }

    const debitResult = await debitRepairOperation(operation);
    if (!debitResult || !debitResult.success) {
      if (debitResult && debitResult.errorMsg === "INSUFFICIENT_FUNDS") {
        const discardResult = persistRepairOperationMutation((state) => {
          delete state.operationsByID[normalizedOperationID];
        });
        if (!discardResult.success) {
          return discardResult;
        }
      }
      return debitResult || {
        success: false,
        errorMsg: "WALLET_DEBIT_FAILED",
      };
    }

    const changes = applyRepairTargetPatches(operation.targetPatches);
    const taxResult = await creditRepairTaxOperation(operation);
    if (!taxResult || !taxResult.success) {
      return {
        success: true,
        pending: true,
        errorMsg: taxResult && taxResult.errorMsg || "TAX_CREDIT_FAILED",
        data: {
          changes,
          chargedAmount: operation.chargedAmount,
          totalFullCost: operation.totalFullCost,
          repairedItemIDs: operation.targetPatches.map((target) => target.itemID),
        },
      };
    }

    const finalizeResult = persistRepairOperationMutation((state) => {
      delete state.operationsByID[normalizedOperationID];
    });
    if (!finalizeResult.success) {
      return finalizeResult;
    }
    return {
      success: true,
      data: {
        changes,
        chargedAmount: operation.chargedAmount,
        totalFullCost: operation.totalFullCost,
        repairedItemIDs: operation.targetPatches.map((target) => target.itemID),
      },
    };
  });
}

function queuePendingRepairOperation(operationID) {
  void schedulePendingRepairOperation(operationID).catch((error) => {
    log.warn(
      `[RepairRuntime] Durable settlement scheduling failed operation=${operationID}: ${error.message}`,
    );
  });
  const settlement = settlePendingRepairOperation(operationID);
  void settlement.catch((error) => {
    log.warn(
      `[RepairRuntime] Async settlement failed operation=${operationID}: ${error.message}`,
    );
  });
  return settlement;
}

async function handleDurableRepairSettlement(job = {}) {
  const operationID = String(job.payload && job.payload.operationID || "").trim();
  if (!operationID) {
    throw new Error("repair settlement job is missing its operation ID");
  }
  const result = await settlePendingRepairOperation(operationID);
  if (!result || !result.success || result.pending) {
    throw new Error(result && result.errorMsg || "repair settlement failed");
  }
  return result;
}

// `repair:<operationSequence>:<leg>`. The operationID is `repair:<sequence>`,
// and the same string keys the pending operation in operationsByID.
const SEQUENCE_DOMAIN = registerSettlementSequenceDomain(
  "repair",
  /^repair:(\d+):/,
);

function advanceOperationSequenceWatermark(receiptScan) {
  return advanceSettlementSequenceWatermark({
    logTag: "[RepairRuntime]",
    counterName: "nextOperationID",
    domain: SEQUENCE_DOMAIN,
    receiptScan,
    readCounter: () => ensureRepairOperationState()._meta.nextOperationID,
    writeCounter: (required) => persistRepairOperationMutation((state) => {
      state._meta.nextOperationID = Math.max(
        toInt(state._meta.nextOperationID, 1),
        required,
      );
      return state._meta.nextOperationID;
    }),
    pendingSequences: () =>
      Object.keys(ensureRepairOperationState().operationsByID || {})
        .map((operationID) => Number(String(operationID).split(":")[1])),
  });
}

async function reconcileDurableRepairOperations(options = {}) {
  advanceOperationSequenceWatermark(options.receiptScan);
  const operationIDs = Object.keys(
    ensureRepairOperationState().operationsByID || {},
  );
  if (!durableScheduler) {
    return { scheduled: 0, pending: operationIDs.length };
  }
  await Promise.all(
    operationIDs.map((operationID) => schedulePendingRepairOperation(operationID)),
  );
  return { scheduled: operationIDs.length, pending: operationIDs.length };
}

async function settlePendingRepairsForCharacter(characterID) {
  const normalizedCharacterID = toInt(characterID, 0);
  const operationIDs = Object.values(
    ensureRepairOperationState().operationsByID || {},
  )
    .filter((operation) =>
      toInt(operation && operation.characterID, 0) === normalizedCharacterID)
    .map((operation) => String(operation.operationID || ""))
    .filter(Boolean);
  for (const operationID of operationIDs) {
    const result = await settlePendingRepairOperation(operationID);
    if (!result || !result.success) {
      return result || { success: false, errorMsg: "REPAIR_RECOVERY_FAILED" };
    }
  }
  return { success: true };
}

async function executeRepairPlan(context, targets, options = {}) {
  const stationCall = options.stationCall === true;
  const payment = Math.max(0, toFiniteNumber(options.payment, 0));
  const allowPartial = stationCall === true;

  const hasModule = targets.some(
    (target) => toInt(target && target.quote && target.quote.categoryID, 0) === CATEGORY_MODULE,
  );
  const totalFullCost = round2(
    targets.reduce((sum, target) => sum + toFiniteNumber(target && target.fullCost, 0), 0),
  );

  // The client pays the plain sum of ceil(damage) * unit cost over its quote
  // rows. Only the total is settled in cents, so compare it in cents: rounding
  // row by row made a full payment look a fraction of a cent short.
  const paidInFull = !allowPartial || round2(payment) >= totalFullCost;

  if (allowPartial && hasModule && !paidInFull) {
    return {
      success: false,
      errorMsg: "MODULE_PARTIAL_REPAIR",
    };
  }

  let remainingBudget = allowPartial ? Math.min(payment, totalFullCost) : totalFullCost;
  const repairPlan = [];

  for (const target of targets) {
    const unitCost = Math.max(
      0,
      toFiniteNumber(target && target.quote && target.quote.costToRepairOneUnitOfDamage, 0),
    );
    const damage = Math.max(
      0,
      toFiniteNumber(target && target.quote && target.quote.damage, 0),
    );
    if (!(damage > 0)) {
      continue;
    }

    if (!(unitCost > 0)) {
      repairPlan.push({
        itemID: toInt(target.itemID, 0),
        repairAmount: damage,
        chargeAmount: 0,
      });
      continue;
    }

    const fullCost = Math.max(0, toFiniteNumber(target.fullCost, 0));
    const chargeAmount = paidInFull ? fullCost : Math.min(remainingBudget, fullCost);
    if (!(chargeAmount > 0)) {
      continue;
    }

    // Paying the complete quoted price repairs the complete health snapshot.
    // Quoted HP is rounded to six decimals and the client prices whole HP, so
    // dividing the price back by unitCost can otherwise leave fractional damage and
    // repeatedly charge a pilot who requests a full repair.
    const repairAmount = chargeAmount >= fullCost
      ? getItemHealthSnapshot(target.item).damage
      : Math.min(damage, chargeAmount / unitCost);
    remainingBudget = Math.max(0, remainingBudget - chargeAmount);
    if (!(repairAmount > 0)) {
      continue;
    }

    repairPlan.push({
      itemID: toInt(target.itemID, 0),
      repairAmount,
      chargeAmount,
    });
  }

  const chargedAmount = round2(
    repairPlan.reduce(
      (sum, entry) => sum + toFiniteNumber(entry && entry.chargeAmount, 0),
      0,
    ),
  );

  if (!(repairPlan.length > 0)) {
    return {
      success: true,
      data: {
        totalFullCost,
        chargedAmount: 0,
        changes: [],
      },
    };
  }

  if (chargedAmount > 0) {
    const wallet = getCharacterWallet(context.characterID);
    const currentBalance = toFiniteNumber(wallet && wallet.balance, 0);
    if (chargedAmount - currentBalance > 0.0001) {
      return {
        success: false,
        errorMsg: "INSUFFICIENT_FUNDS",
        errorValues: buildNotEnoughMoneyUserErrorValues(
          chargedAmount,
          currentBalance,
        ),
      };
    }
  }

  const targetPatches = buildRepairTargetPatches(repairPlan);
  const tax = buildStructureRepairTax(context, chargedAmount);
  const prepareResult = persistRepairOperationMutation((state) => {
    const nextOperationID = Math.max(1, toInt(state._meta.nextOperationID, 1));
    state._meta.nextOperationID = nextOperationID + 1;
    const operationID = `repair:${nextOperationID}`;
    const operation = {
      operationID,
      preparedAt: Date.now(),
      characterID: context.characterID,
      dockedLocationID: context.dockedLocationID,
      serviceOwnerID: toInt(
        context.structure
          ? context.structure.ownerCorpID || context.structure.ownerID
          : context.stationRecord && context.stationRecord.ownerID,
        0,
      ),
      chargedAmount,
      totalFullCost,
      taxCredit: tax ? tax.amount : 0,
      taxOwnerCorporationID: tax ? tax.ownerCorporationID : 0,
      debitCommandID: `${operationID}:charge`,
      taxCommandID: `${operationID}:tax-credit`,
      targetPatches,
    };
    state.operationsByID[operationID] = operation;
    return operation;
  });
  if (!prepareResult.success) {
    return prepareResult;
  }

  const settlementResult = await queuePendingRepairOperation(
    prepareResult.data.operationID,
  );
  if (
    settlementResult &&
    settlementResult.success === false &&
    settlementResult.errorMsg === "INSUFFICIENT_FUNDS"
  ) {
    const wallet = getCharacterWallet(context.characterID);
    return {
      ...settlementResult,
      errorValues: buildNotEnoughMoneyUserErrorValues(
        chargedAmount,
        toFiniteNumber(wallet && wallet.balance, 0),
      ),
    };
  }
  return settlementResult;
}

function repairItemsInStation(session, itemReferences = [], payment = null) {
  return runSerialized(repairRequestLanes, session && session.characterID, async () => {
    const contextResult = resolveRepairContext(session);
    if (!contextResult.success || !contextResult.data) {
      return contextResult;
    }

    const context = contextResult.data;
    if (context.dockedKind !== "station") {
      return {
        success: false,
        errorMsg: "REPAIR_STATION_ONLY",
      };
    }

    enforceRepairAccess(context);
    const recoveryResult = await settlePendingRepairsForCharacter(
      context.characterID,
    );
    if (!recoveryResult.success) {
      return recoveryResult;
    }
    const targets = buildRepairExecutionTargets(context, itemReferences);
    return executeRepairPlan(context, targets, {
      stationCall: true,
      payment:
        payment === null || payment === undefined
          ? targets.reduce((sum, target) =>
            sum + toFiniteNumber(target && target.fullCost, 0), 0)
          : payment,
    });
  });
}

function repairItemsInStructure(session, itemReferences = []) {
  return runSerialized(repairRequestLanes, session && session.characterID, async () => {
    const contextResult = resolveRepairContext(session);
    if (!contextResult.success || !contextResult.data) {
      return contextResult;
    }

    const context = contextResult.data;
    if (context.dockedKind !== "structure") {
      return {
        success: false,
        errorMsg: "REPAIR_STRUCTURE_ONLY",
      };
    }

    const recoveryResult = await settlePendingRepairsForCharacter(
      context.characterID,
    );
    if (!recoveryResult.success) {
      return recoveryResult;
    }
    const targets = buildRepairExecutionTargets(context, itemReferences);
    return executeRepairPlan(context, targets, {
      stationCall: false,
    });
  });
}

module.exports = {
  REPAIR_OPERATIONS_TABLE,
  DURABLE_SETTLEMENT_JOB_TYPE,
  REPAIR_SERVICE_ID,
  STRUCTURE_REPAIR_SERVICE_ID,
  STATION_REPAIR_COST_MULTIPLIER,
  isRepairableInventoryItem,
  resolveRepairContext,
  buildRepairQuotesForSelection,
  buildLegacyDamageReportsForSelection,
  bindDurableScheduler,
  handleDurableRepairSettlement,
  reconcileDurableRepairOperations,
  repairItemsInStation,
  repairItemsInStructure,
  resetRepairOperationStateForTests,
  throwRepairError,
  unbindDurableScheduler,
  _testing: {
    ensureRepairOperationState,
    executeRepairPlan,
    settlePendingRepairOperation,
  },
};
