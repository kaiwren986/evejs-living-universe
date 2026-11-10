"use strict";

const {
  toFiniteNumber,
} = require("../../common/numbers");

const path = require("path");

const BaseService = require(path.join(__dirname, "../baseService"));
const database = require(path.join(__dirname, "../../gameStore"));
const log = require(path.join(__dirname, "../../utils/logger"));
const { throwWrappedUserError } = require(path.join(__dirname, "../../common/machoErrors"));
const spaceRuntime = require(path.join(__dirname, "../../space/runtime"));
const worldData = require(path.join(__dirname, "../../space/worldData"));
const {
  jumpSessionToSolarSystem,
  jumpSessionViaAnsiblex,
} = require(path.join(__dirname, "../../space/transitions"));
const mobileWarpDisruptorRuntime = require(path.join(__dirname, "../ship/mobileWarpDisruptorRuntime"));
const hostileModuleRuntime = require(path.join(__dirname, "../../space/modules/hostileModuleRuntime"));
const {
  canEntitiesInteractLocally,
} = require(path.join(
  __dirname,
  "../../space/destiny/identity/interactionScope",
));
const {
  ITEM_FLAGS,
  listContainerItems,
  findItemById,
  updateInventoryItem,
  removeInventoryItem,
} = require(path.join(__dirname, "../inventory/itemStore"));
const itemCustody = require(path.join(__dirname, "../inventory/itemCustody"));
const {
  ACCOUNT_KEY,
  JOURNAL_ENTRY_TYPE,
  adjustCharacterBalanceAsync,
  applyCharacterWalletProjection,
  buildNotEnoughMoneyUserErrorValues,
  getCharacterWallet,
} = require(path.join(__dirname, "../account/walletState"));
const {
  CORPORATION_WALLET_KEY_START,
  adjustCorporationWalletDivisionBalanceAsync,
} = require(path.join(__dirname, "../corporation/corpWalletState"));
const {
  advanceSettlementSequenceWatermark,
  registerSettlementSequenceDomain,
} = require(path.join(__dirname, "../_shared/settlementSequenceWatermark"));
const {
  CHARACTERS_TABLE,
  getCharacterRecord,
  getActiveShipRecord,
  updateCharacterRecord,
} = require(path.join(__dirname, "../character/characterState"));
const sessionRegistry = require(path.join(__dirname, "../chat/sessionRegistry"));
const structureState = require(path.join(__dirname, "./structureState"));
const {
  STRUCTURE_SERVICE_ID,
  STRUCTURE_SERVICE_STATE,
} = require(path.join(__dirname, "./structureConstants"));
const {
  characterHasStructureService,
} = require(path.join(__dirname, "./structurePayloads"));
const {
  getProfileSettingValueForStructure,
} = require(path.join(__dirname, "./structureProfilesState"));
const {
  STRUCTURE_SETTING_ID,
} = require(path.join(__dirname, "./structureServiceAuthority"));
const {
  findServiceProximityConflict,
} = require(path.join(__dirname, "./structureServiceProximity"));
const {
  getCharacterTetherRestrictionState,
} = require(path.join(__dirname, "./structureTetherRestrictionState"));
const {
  TYPE_ANSIBLEX_JUMP_BRIDGE,
} = require(path.join(__dirname, "../sovereignty/sovUpgradeSupport"));

const ANSIBLEX_JUMP_RANGE_METERS = 2500;
const ANSIBLEX_ARRIVAL_CLEARANCE_METERS = 12000;
const MAX_ANSIBLEX_RANGE_LY = 5;
const MAX_ANSIBLEX_SHIP_MASS_KG = 1480000000;
const MAX_ANSIBLEX_ISK_PER_LIQUID_OZONE = 2000;
const LIGHT_YEAR_METERS = 9460730472580800;
const TYPE_LIQUID_OZONE = 16273;
const JUMP_BRIDGE_SETTLEMENT_TABLE = "jumpBridgeSettlements";
const DURABLE_SETTLEMENT_JOB_TYPE = "jump-bridge.settle";
const DURABLE_SETTLEMENT_JOB_PREFIX = "jump-bridge-settlement:";
const FUEL_ESCROW_LOCATION_BASE = 9_800_000_000;
const settlementLanes = new Map();
let durableScheduler = null;
const starbaseTravel = () => require("../starbase/starbaseTravelRuntime");
const {
  getJumpBridgeDestinationSolarSystemID,
  findReciprocalJumpBridge,
} = require("./structureJumpBridgeLinks");

function hasBridgeAccess(session, structure) {
  return structure?.legacyStarbase === true ? starbaseTravel().hasTravelAccess(session, structure)
    : characterHasStructureService(session, structure, STRUCTURE_SERVICE_ID.JUMP_BRIDGE);
}

function normalizeInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function normalizePositiveInt(value, fallback = 0) {
  const numeric = normalizeInt(value, fallback);
  return numeric > 0 ? numeric : fallback;
}

function cloneVector(value, fallback = { x: 0, y: 0, z: 0 }) {
  const source = value && typeof value === "object" ? value : fallback;
  return {
    x: toFiniteNumber(source && source.x, fallback.x),
    y: toFiniteNumber(source && source.y, fallback.y),
    z: toFiniteNumber(source && source.z, fallback.z),
  };
}

function addVectors(left, right) {
  return {
    x: toFiniteNumber(left && left.x, 0) + toFiniteNumber(right && right.x, 0),
    y: toFiniteNumber(left && left.y, 0) + toFiniteNumber(right && right.y, 0),
    z: toFiniteNumber(left && left.z, 0) + toFiniteNumber(right && right.z, 0),
  };
}

function scaleVector(vector, scalar) {
  const scale = toFiniteNumber(scalar, 0);
  return {
    x: toFiniteNumber(vector && vector.x, 0) * scale,
    y: toFiniteNumber(vector && vector.y, 0) * scale,
    z: toFiniteNumber(vector && vector.z, 0) * scale,
  };
}

function subtractVectors(left, right) {
  return {
    x: toFiniteNumber(left && left.x, 0) - toFiniteNumber(right && right.x, 0),
    y: toFiniteNumber(left && left.y, 0) - toFiniteNumber(right && right.y, 0),
    z: toFiniteNumber(left && left.z, 0) - toFiniteNumber(right && right.z, 0),
  };
}

function magnitude(vector) {
  return Math.sqrt(
    (toFiniteNumber(vector && vector.x, 0) ** 2) +
    (toFiniteNumber(vector && vector.y, 0) ** 2) +
    (toFiniteNumber(vector && vector.z, 0) ** 2),
  );
}

function normalizeVector(vector, fallback = { x: 1, y: 0, z: 0 }) {
  const source = cloneVector(vector, fallback);
  const length = magnitude(source);
  if (length <= 0) {
    return cloneVector(fallback);
  }
  return {
    x: source.x / length,
    y: source.y / length,
    z: source.z / length,
  };
}

function centerDistance(left, right) {
  return magnitude(subtractVectors(
    cloneVector(left && left.position),
    cloneVector(right && right.position),
  ));
}

function surfaceDistance(left, right) {
  return Math.max(
    0,
    centerDistance(left, right) -
      Math.max(0, toFiniteNumber(left && left.radius, 0)) -
      Math.max(0, toFiniteNumber(right && right.radius, 0)),
  );
}

function throwNotify(message) {
  throwWrappedUserError("CustomNotify", {
    notify: String(message || "The jump bridge cannot be used right now."),
  });
}

function throwNotEnoughMoney(requiredAmount, currentBalance) {
  throwWrappedUserError(
    "NotEnoughMoney",
    buildNotEnoughMoneyUserErrorValues(requiredAmount, currentBalance),
  );
}

function isAnsiblexStructure(structure) {
  return Boolean(
    structure &&
      (normalizePositiveInt(structure.typeID, 0) === TYPE_ANSIBLEX_JUMP_BRIDGE ||
        (structure.legacyStarbase === true && Number(structure.typeID) === starbaseTravel().TYPE_BRIDGE)) &&
      !structure.destroyedAt
  );
}

function isJumpBridgeServiceOnline(structure) {
  return normalizeInt(
    structure &&
      structure.serviceStates &&
      structure.serviceStates[String(STRUCTURE_SERVICE_ID.JUMP_BRIDGE)],
    STRUCTURE_SERVICE_STATE.OFFLINE,
  ) === STRUCTURE_SERVICE_STATE.ONLINE;
}

function hasJumpBridgeServiceProximityConflict(structure) {
  if (structure?.legacyStarbase === true) return false;
  if (!structure) {
    return false;
  }
  return Boolean(findServiceProximityConflict(
    structure,
    STRUCTURE_SERVICE_ID.JUMP_BRIDGE,
    structureState.listStructuresForSystem(
      normalizePositiveInt(structure.solarSystemID, 0),
      { includeDestroyed: true, refresh: false },
    ),
  ));
}

function getStructureDestinationSolarSystemID(structure) {
  if (structure?.legacyStarbase === true) return starbaseTravel().getLinkedBridge(structure)?.solarSystemID || 0;
  return getJumpBridgeDestinationSolarSystemID(structure);
}

function getStructureByID(structureID) {
  const numericStructureID = normalizePositiveInt(structureID, 0);
  return numericStructureID
    ? structureState.getStructureByID(numericStructureID, { refresh: false }) || starbaseTravel().getEndpoint(numericStructureID)
    : null;
}

function findReciprocalLinkedStructure(sourceStructure) {
  if (sourceStructure?.legacyStarbase === true) return starbaseTravel().getLinkedBridge(sourceStructure);
  return findReciprocalJumpBridge(sourceStructure, structureState.listStructures({
    includeDestroyed: false,
    refresh: false,
  }));
}

function resolveShipMassKg(shipItem, shipEntity = null) {
  const directMass = toFiniteNumber(
    shipEntity && shipEntity.mass,
    toFiniteNumber(shipItem && shipItem.mass, 0),
  );
  if (directMass > 0) {
    return directMass;
  }
  const movement = worldData.getMovementAttributesForType(
    normalizePositiveInt(shipItem && (shipItem.typeID || shipItem.shipTypeID), 0),
  );
  return Math.max(0, toFiniteNumber(movement && movement.mass, 0));
}

function resolveShipRadiusMeters(shipItem, shipEntity = null) {
  const directRadius = Math.max(
    0,
    toFiniteNumber(
      shipEntity && shipEntity.radius,
      toFiniteNumber(shipItem && (shipItem.radius || shipItem.spaceRadius), 0),
    ),
  );
  if (directRadius > 0) {
    return directRadius;
  }
  const movement = worldData.getMovementAttributesForType(
    normalizePositiveInt(shipItem && (shipItem.typeID || shipItem.shipTypeID), 0),
  );
  return Math.max(0, toFiniteNumber(movement && movement.radius, 0));
}

function getSolarSystemDistanceLy(sourceSolarSystemID, destinationSolarSystemID) {
  const sourceSystem = worldData.getSolarSystemByID(sourceSolarSystemID);
  const destinationSystem = worldData.getSolarSystemByID(destinationSolarSystemID);
  if (
    !sourceSystem ||
      !destinationSystem ||
      !sourceSystem.position ||
      !destinationSystem.position
  ) {
    return null;
  }
  const distanceMeters = magnitude(subtractVectors(
    sourceSystem.position,
    destinationSystem.position,
  ));
  return distanceMeters / LIGHT_YEAR_METERS;
}

function calculateLiquidOzoneRequired(shipMassKg, distanceLy) {
  const mass = Math.max(0, toFiniteNumber(shipMassKg, 0));
  const ly = Math.max(0, toFiniteNumber(distanceLy, 0));
  return Math.max(50, Math.ceil((mass * ly * 0.000003) + 50));
}

function normalizeJumpBridgeIskPerLiquidOzone(value) {
  const numeric = toFiniteNumber(value, 0);
  return Math.max(0, Math.min(MAX_ANSIBLEX_ISK_PER_LIQUID_OZONE, numeric));
}

function normalizeMoney(value) {
  const numeric = toFiniteNumber(value, 0);
  return Math.round(numeric * 100) / 100;
}

function getStructureOwnerCorpID(structure) {
  return normalizePositiveInt(structure && (structure.ownerCorpID || structure.ownerID), 0);
}

function getJumpBridgeIskPerLiquidOzone(structure, session) {
  return normalizeJumpBridgeIskPerLiquidOzone(
    getProfileSettingValueForStructure(
      structure,
      STRUCTURE_SETTING_ID.JUMP_BRIDGE_ACTIVATION,
      {
        session,
        defaultValue: 0,
      },
    ),
  );
}

function calculateJumpBridgeActivationFee(structure, session, liquidOzoneRequired) {
  if (structure?.legacyStarbase === true) return 0;
  const ozone = Math.max(0, normalizeInt(liquidOzoneRequired, 0));
  if (ozone <= 0) {
    return 0;
  }
  return normalizeMoney(ozone * getJumpBridgeIskPerLiquidOzone(structure, session));
}

function ensureCharacterCanPayJumpBridgeFee(session, amount) {
  const normalizedAmount = normalizeMoney(amount);
  if (!(normalizedAmount > 0)) {
    return;
  }

  const characterID = normalizePositiveInt(session && session.characterID, 0);
  const wallet = getCharacterWallet(characterID);
  const balance = normalizeMoney(wallet && wallet.balance);
  if (!wallet || balance + 0.0001 < normalizedAmount) {
    throwNotEnoughMoney(normalizedAmount, balance);
  }
}

function getStackQuantity(item) {
  if (!item) {
    return 0;
  }
  if (normalizeInt(item.singleton, 0) === 1) {
    return 1;
  }
  return Math.max(0, normalizeInt(item.stacksize ?? item.quantity, 0));
}

function listStructureLiquidOzoneStacks(structure) {
  const structureID = normalizePositiveInt(structure && structure.structureID, 0);
  if (!structureID) {
    return [];
  }
  return listContainerItems(null, structureID, structure?.legacyStarbase === true ? 0 : ITEM_FLAGS.STRUCTURE_FUEL_BAY)
    .filter((item) => (
      normalizePositiveInt(item && item.typeID, 0) === TYPE_LIQUID_OZONE &&
        (structure?.legacyStarbase !== true || Number(item.ownerID) === Number(structure.ownerID)) &&
        getStackQuantity(item) > 0
    ))
    .sort((left, right) => normalizePositiveInt(left && left.itemID, 0) -
      normalizePositiveInt(right && right.itemID, 0));
}

function sumLiquidOzoneStacks(stacks) {
  return (Array.isArray(stacks) ? stacks : [])
    .reduce((total, stack) => total + getStackQuantity(stack), 0);
}

function synchronizeStructureLiquidOzoneCounter(structureID, nextQuantity) {
  return structureState.updateStructureRecord(structureID, (current) => ({
    ...current,
    liquidOzoneQty: Math.max(0, normalizeInt(nextQuantity, 0)),
  }));
}

function consumeStructureLiquidOzone(structure, quantity) {
  const structureID = normalizePositiveInt(structure && structure.structureID, 0);
  const requiredQuantity = Math.max(0, normalizeInt(quantity, 0));
  if (!structureID || requiredQuantity <= 0) {
    return {
      success: true,
      consumedQuantity: 0,
      previousQuantity: 0,
      remainingQuantity: 0,
      changes: [],
      usedInventoryFuel: false,
    };
  }

  const fuelStacks = listStructureLiquidOzoneStacks(structure);
  const inventoryQuantity = sumLiquidOzoneStacks(fuelStacks);
  if (fuelStacks.length === 0) {
    const previousQuantity = Math.max(0, normalizeInt(structure && structure.liquidOzoneQty, 0));
    if (previousQuantity < requiredQuantity) {
      return {
        success: false,
        errorMsg: "NO_FUEL",
        previousQuantity,
        remainingQuantity: previousQuantity,
        changes: [],
        usedInventoryFuel: false,
      };
    }

    const nextQuantity = Math.max(0, previousQuantity - requiredQuantity);
    const updateResult = synchronizeStructureLiquidOzoneCounter(structureID, nextQuantity);
    if (!updateResult.success) {
      return {
        success: false,
        errorMsg: updateResult.errorMsg || "WRITE_ERROR",
        previousQuantity,
        remainingQuantity: previousQuantity,
        changes: [],
        usedInventoryFuel: false,
      };
    }

    return {
      success: true,
      consumedQuantity: requiredQuantity,
      previousQuantity,
      remainingQuantity: nextQuantity,
      changes: [],
      usedInventoryFuel: false,
    };
  }

  if (inventoryQuantity < requiredQuantity) {
    synchronizeStructureLiquidOzoneCounter(structureID, inventoryQuantity);
    return {
      success: false,
      errorMsg: "NO_FUEL",
      previousQuantity: inventoryQuantity,
      remainingQuantity: inventoryQuantity,
      changes: [],
      usedInventoryFuel: true,
    };
  }

  const changes = [];
  let remainingToConsume = requiredQuantity;
  for (const stack of fuelStacks) {
    if (remainingToConsume <= 0) {
      break;
    }
    const stackQuantity = getStackQuantity(stack);
    if (stackQuantity <= 0) {
      continue;
    }
    const consumedFromStack = Math.min(stackQuantity, remainingToConsume);
    const nextStackQuantity = stackQuantity - consumedFromStack;
    const itemID = normalizePositiveInt(stack && stack.itemID, 0);
    const writeResult = nextStackQuantity > 0
      ? updateInventoryItem(itemID, (currentItem) => ({
          ...currentItem,
          quantity: nextStackQuantity,
          stacksize: nextStackQuantity,
        }))
      : removeInventoryItem(itemID, { removeContents: false });
    if (!writeResult.success) {
      return {
        success: false,
        errorMsg: writeResult.errorMsg || "WRITE_ERROR",
        previousQuantity: inventoryQuantity,
        remainingQuantity: inventoryQuantity - (requiredQuantity - remainingToConsume),
        changes,
        usedInventoryFuel: true,
      };
    }

    if (writeResult.data && Array.isArray(writeResult.data.changes)) {
      changes.push(...writeResult.data.changes);
    } else if (writeResult.data || writeResult.previousData) {
      changes.push({
        removed: false,
        previousData: writeResult.previousData || null,
        item: writeResult.data || null,
      });
    }
    remainingToConsume -= consumedFromStack;
  }

  const remainingQuantity = Math.max(0, inventoryQuantity - requiredQuantity);
  const counterResult = synchronizeStructureLiquidOzoneCounter(structureID, remainingQuantity);
  if (!counterResult.success) {
    return {
      success: false,
      errorMsg: counterResult.errorMsg || "WRITE_ERROR",
      previousQuantity: inventoryQuantity,
      remainingQuantity,
      changes,
      usedInventoryFuel: true,
    };
  }

  return {
    success: true,
    consumedQuantity: requiredQuantity,
    previousQuantity: inventoryQuantity,
    remainingQuantity,
    changes,
    usedInventoryFuel: true,
  };
}

function buildStructureArrivalSpawnState(destinationStructure, shipItem) {
  const anchorPosition = cloneVector(destinationStructure && destinationStructure.position);
  const direction = normalizeVector(
    magnitude(anchorPosition) > 0 ? anchorPosition : { x: 1, y: 0, z: 0 },
    { x: 1, y: 0, z: 0 },
  );
  const offset =
    Math.max(0, toFiniteNumber(destinationStructure && destinationStructure.radius, 0)) +
    resolveShipRadiusMeters(shipItem) +
    ANSIBLEX_ARRIVAL_CLEARANCE_METERS;
  return {
    anchorType: "structureJumpBridge",
    anchorID: normalizePositiveInt(destinationStructure && destinationStructure.structureID, 0),
    anchorName:
      String(
        (destinationStructure && (destinationStructure.itemName || destinationStructure.name)) ||
          "Ansiblex Jump Bridge",
      ),
    direction,
    position: addVectors(anchorPosition, scaleVector(direction, offset)),
  };
}

function isCharacterWarpDisrupted(session, shipEntity = null) {
  if (require("../spaceComponents/shipLinkRestrictions").blocksShipAction(shipEntity, "blocksJumpOrDock")) return true;
  if (shipEntity && hostileModuleRuntime.isEntityWarpScrambled(shipEntity)) {
    return true;
  }
  const restrictionState = getCharacterTetherRestrictionState(
    session && session.characterID,
  );
  return Boolean(restrictionState && restrictionState.warpScrambled === true);
}

function findWarpDisruptionFieldForShip(systemID, shipEntity = null) {
  if (!shipEntity || !shipEntity.position) {
    return null;
  }
  const scene =
    spaceRuntime &&
    spaceRuntime.scenes instanceof Map
      ? spaceRuntime.scenes.get(normalizePositiveInt(systemID, 0)) || null
      : null;
  return mobileWarpDisruptorRuntime.findActiveWarpDisruptorForPosition(
    systemID,
    shipEntity.position,
    { scene, targetEntity: shipEntity },
  );
}

function cloneValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function ensureJumpBridgeSettlementRoot() {
  database.ensureTable(JUMP_BRIDGE_SETTLEMENT_TABLE);
  const result = database.read(JUMP_BRIDGE_SETTLEMENT_TABLE, "/");
  const root = result.success && result.data && typeof result.data === "object"
    ? result.data
    : {};
  return {
    ...root,
    _meta: {
      version: 1,
      nextOperationID: normalizePositiveInt(
        root._meta && root._meta.nextOperationID,
        1,
      ),
    },
    byCharacter:
      root.byCharacter && typeof root.byCharacter === "object"
        ? root.byCharacter
        : {},
  };
}

function normalizeFuelLeg(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  const legID = String(value.legID || "").trim();
  const itemID = normalizePositiveInt(value.itemID, 0);
  const ownerID = normalizePositiveInt(value.ownerID, 0);
  const quantity = Math.max(0, normalizeInt(value.quantity, 0));
  const escrowLocationID = normalizePositiveInt(value.escrowLocationID, 0);
  if (!legID || !itemID || !ownerID || !quantity || !escrowLocationID) {
    return null;
  }
  return {
    legID,
    itemID,
    ownerID,
    quantity,
    sourceFlagID: Math.max(0, normalizeInt(value.sourceFlagID, ITEM_FLAGS.STRUCTURE_FUEL_BAY)),
    escrowLocationID,
    escrowItemID: normalizePositiveInt(value.escrowItemID, 0),
    stageKey: String(value.stageKey || `${legID}:stage`),
    returnKey: String(value.returnKey || `${legID}:return`),
    commitKey: String(value.commitKey || `${legID}:commit`),
    staged: Boolean(value.staged),
    returned: Boolean(value.returned),
    committed: Boolean(value.committed),
  };
}

function normalizeJumpBridgeSettlement(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  const operationID = String(value.operationID || "").trim();
  const characterID = normalizePositiveInt(value.characterID, 0);
  const shipID = normalizePositiveInt(value.shipID, 0);
  const sourceStructureID = normalizePositiveInt(value.sourceStructureID, 0);
  const destinationStructureID = normalizePositiveInt(value.destinationStructureID, 0);
  const sourceSolarSystemID = normalizePositiveInt(value.sourceSolarSystemID, 0);
  const destinationSolarSystemID = normalizePositiveInt(
    value.destinationSolarSystemID,
    0,
  );
  if (
    !operationID || !characterID || !shipID || !sourceStructureID ||
    !destinationStructureID || !sourceSolarSystemID || !destinationSolarSystemID
  ) {
    return null;
  }
  const activationFee = normalizeMoney(value.activationFee);
  const ownerCorpID = normalizePositiveInt(value.ownerCorpID, 0);
  const fuelLegs = (Array.isArray(value.fuelLegs) ? value.fuelLegs : [])
    .map(normalizeFuelLeg)
    .filter(Boolean);
  const legacyFuel = Boolean(value.legacyFuel);
  return {
    operationID,
    operationSequence: normalizePositiveInt(value.operationSequence, 1),
    characterID,
    shipID,
    sourceStructureID,
    destinationStructureID,
    sourceSolarSystemID,
    destinationSolarSystemID,
    liquidOzoneRequired: Math.max(0, normalizeInt(value.liquidOzoneRequired, 0)),
    activationFee,
    ownerCorpID,
    arrivalSpawnState: cloneValue(value.arrivalSpawnState || {}),
    starbaseCyno: value.starbaseCyno === true,
    starbaseJumpTimers: value.starbaseJumpTimers && typeof value.starbaseJumpTimers === "object"
      ? cloneValue(value.starbaseJumpTimers) : null,
    legacyFuel,
    legacyFuelStaged: Boolean(value.legacyFuelStaged),
    legacyFuelReturned: Boolean(value.legacyFuelReturned),
    legacyFuelCommitted: Boolean(value.legacyFuelCommitted),
    fuelLegs,
    debitCommandID: String(
      value.debitCommandID || `${DURABLE_SETTLEMENT_JOB_PREFIX}${operationID}:debit`,
    ),
    creditCommandID: String(
      value.creditCommandID || `${DURABLE_SETTLEMENT_JOB_PREFIX}${operationID}:credit`,
    ),
    creditReversalCommandID: String(
      value.creditReversalCommandID ||
        `${DURABLE_SETTLEMENT_JOB_PREFIX}${operationID}:credit-reversal`,
    ),
    debitRefundCommandID: String(
      value.debitRefundCommandID ||
        `${DURABLE_SETTLEMENT_JOB_PREFIX}${operationID}:debit-refund`,
    ),
    debitApplied: activationFee <= 0 || Boolean(value.debitApplied),
    creditApplied:
      activationFee <= 0 || !ownerCorpID || Boolean(value.creditApplied),
    creditReversed: Boolean(value.creditReversed),
    debitRefunded: Boolean(value.debitRefunded),
    transitioned: Boolean(value.transitioned),
    jumpTimersApplied: Boolean(value.jumpTimersApplied),
    compensating: Boolean(value.compensating),
    compensationReason: String(value.compensationReason || ""),
    createdAt: String(value.createdAt || new Date().toISOString()),
  };
}

function writeJumpBridgeSettlementRoot(root) {
  const result = database.write(
    JUMP_BRIDGE_SETTLEMENT_TABLE,
    "/",
    root,
    { force: true },
  );
  if (!result || result.success !== true) {
    return result || { success: false, errorMsg: "JUMP_BRIDGE_SETTLEMENT_WRITE_FAILED" };
  }
  const flushResult = database.flushTableSync(JUMP_BRIDGE_SETTLEMENT_TABLE);
  return flushResult && flushResult.success
    ? { success: true }
    : flushResult || { success: false, errorMsg: "JUMP_BRIDGE_SETTLEMENT_FLUSH_FAILED" };
}

function listPendingJumpBridgeSettlements() {
  return Object.values(ensureJumpBridgeSettlementRoot().byCharacter)
    .map(normalizeJumpBridgeSettlement)
    .filter(Boolean)
    .sort((left, right) => left.operationID.localeCompare(right.operationID));
}

function getPendingJumpBridgeSettlement(operationID) {
  const normalizedID = String(operationID || "").trim();
  return listPendingJumpBridgeSettlements().find(
    (settlement) => settlement.operationID === normalizedID,
  ) || null;
}

function findPendingJumpBridgeSettlementForCharacter(characterID) {
  const root = ensureJumpBridgeSettlementRoot();
  return normalizeJumpBridgeSettlement(
    root.byCharacter[String(normalizePositiveInt(characterID, 0))],
  );
}

function updateJumpBridgeSettlement(operationID, updater) {
  const root = ensureJumpBridgeSettlementRoot();
  const entry = Object.entries(root.byCharacter).find(([, value]) =>
    value && String(value.operationID || "") === String(operationID || ""));
  if (!entry) {
    return { success: false, errorMsg: "JUMP_BRIDGE_SETTLEMENT_NOT_FOUND" };
  }
  const [characterKey, rawSettlement] = entry;
  const current = normalizeJumpBridgeSettlement(rawSettlement);
  const next = normalizeJumpBridgeSettlement(
    typeof updater === "function" ? updater(cloneValue(current)) : updater,
  );
  if (!next || next.operationID !== current.operationID) {
    return { success: false, errorMsg: "JUMP_BRIDGE_SETTLEMENT_INVALID" };
  }
  root.byCharacter[characterKey] = next;
  const result = writeJumpBridgeSettlementRoot(root);
  return result.success ? { success: true, data: cloneValue(next) } : result;
}

function removeJumpBridgeSettlement(operationID) {
  const root = ensureJumpBridgeSettlementRoot();
  const entry = Object.entries(root.byCharacter).find(([, value]) =>
    value && String(value.operationID || "") === String(operationID || ""));
  if (!entry) {
    return true;
  }
  delete root.byCharacter[entry[0]];
  return writeJumpBridgeSettlementRoot(root).success;
}

function buildFuelLegs(sourceStructure, quantity, operationID, operationSequence, sourceFuelStacks = null) {
  const requiredQuantity = Math.max(0, normalizeInt(quantity, 0));
  const stacks = sourceFuelStacks || listStructureLiquidOzoneStacks(sourceStructure);
  const inventoryQuantity = sumLiquidOzoneStacks(stacks);
  if (stacks.length === 0) {
    if (sourceFuelStacks) return requiredQuantity === 0
      ? { success: true, legacyFuel: false, fuelLegs: [] } : { success: false, errorMsg: "NO_FUEL" };
    const legacyQuantity = Math.max(
      0,
      normalizeInt(sourceStructure && sourceStructure.liquidOzoneQty, 0),
    );
    return legacyQuantity >= requiredQuantity
      ? { success: true, legacyFuel: true, fuelLegs: [] }
      : { success: false, errorMsg: "NO_FUEL" };
  }
  if (inventoryQuantity < requiredQuantity) {
    return { success: false, errorMsg: "NO_FUEL" };
  }
  const fuelLegs = [];
  let remaining = requiredQuantity;
  for (const stack of stacks) {
    if (remaining <= 0) {
      break;
    }
    const legIndex = fuelLegs.length;
    const legID = `${operationID}:fuel:${legIndex}`;
    const legQuantity = Math.min(getStackQuantity(stack), remaining);
    fuelLegs.push(normalizeFuelLeg({
      legID,
      itemID: stack.itemID,
      ownerID: stack.ownerID,
      quantity: legQuantity,
      sourceFlagID: stack.flagID,
      escrowLocationID:
        FUEL_ESCROW_LOCATION_BASE + (operationSequence * 100) + legIndex,
      stageKey: `${legID}:stage`,
      returnKey: `${legID}:return`,
      commitKey: `${legID}:commit`,
    }));
    remaining -= legQuantity;
  }
  return remaining === 0
    ? { success: true, legacyFuel: false, fuelLegs }
    : { success: false, errorMsg: "NO_FUEL" };
}

function prepareJumpBridgeSettlement(options = {}) {
  const characterID = normalizePositiveInt(options.characterID, 0);
  const existing = findPendingJumpBridgeSettlementForCharacter(characterID);
  if (existing) {
    const duplicate =
      existing.shipID === normalizePositiveInt(options.shipID, 0) &&
      existing.sourceStructureID === normalizePositiveInt(options.sourceStructureID, 0);
    return duplicate
      ? { success: true, duplicate: true, data: existing }
      : { success: false, errorMsg: "JUMP_BRIDGE_ALREADY_PENDING" };
  }
  const root = ensureJumpBridgeSettlementRoot();
  const operationSequence = root._meta.nextOperationID;
  const operationID = `${characterID}:${operationSequence}`;
  const sourceStructure = getStructureByID(options.sourceStructureID);
  const fuelPlan = buildFuelLegs(
    sourceStructure,
    options.liquidOzoneRequired,
    operationID,
    operationSequence,
    options.starbaseCyno === true ? options.sourceFuelStacks : null,
  );
  if (!fuelPlan.success) {
    return fuelPlan;
  }
  const settlement = normalizeJumpBridgeSettlement({
    operationID,
    operationSequence,
    characterID,
    shipID: options.shipID,
    sourceStructureID: options.sourceStructureID,
    destinationStructureID: options.destinationStructureID,
    sourceSolarSystemID: options.sourceSolarSystemID,
    destinationSolarSystemID: options.destinationSolarSystemID,
    liquidOzoneRequired: options.liquidOzoneRequired,
    activationFee: options.activationFee,
    ownerCorpID: options.ownerCorpID,
    arrivalSpawnState: options.arrivalSpawnState,
    starbaseCyno: options.starbaseCyno === true,
    starbaseJumpTimers: options.starbaseJumpTimers,
    legacyFuel: fuelPlan.legacyFuel,
    fuelLegs: fuelPlan.fuelLegs,
    createdAt: new Date().toISOString(),
  });
  if (!settlement) {
    return { success: false, errorMsg: "JUMP_BRIDGE_SETTLEMENT_INVALID" };
  }
  root._meta.nextOperationID = operationSequence + 1;
  root.byCharacter[String(characterID)] = settlement;
  const result = writeJumpBridgeSettlementRoot(root);
  return result.success
    ? { success: true, duplicate: false, data: cloneValue(settlement) }
    : result;
}

function runJumpBridgeSerialized(characterID, operation) {
  const laneKey = String(normalizePositiveInt(characterID, 0));
  const previous = settlementLanes.get(laneKey) || Promise.resolve();
  const current = previous.catch(() => null).then(operation);
  settlementLanes.set(laneKey, current);
  void current.finally(() => {
    if (settlementLanes.get(laneKey) === current) {
      settlementLanes.delete(laneKey);
    }
  }).catch(() => null);
  return current;
}

function durableCustodyFailure(result, fallbackError) {
  if (!result || result.success !== true) {
    return result || { success: false, errorMsg: fallbackError };
  }
  return result.durable === true
    ? null
    : { success: false, ambiguous: true, errorMsg: "ITEM_CUSTODY_NOT_DURABLE" };
}

function getCustodyResultItem(result) {
  if (result && result.data && result.data.item) {
    return result.data.item;
  }
  const changes = result && result.data && Array.isArray(result.data.changes)
    ? result.data.changes
    : [];
  return changes.map((change) => change && change.item).find(Boolean) || null;
}

function publishStarbaseFuelChanges(settlement, result) {
  if (!settlement.starbaseJumpTimers) return;
  const changes = result?.data?.changes || [];
  try {
    if (settlement.starbaseCyno) {
      const session = sessionRegistry.findSessionByCharacterID(settlement.characterID);
      require("../character/characterState").emitItemsChangedBatchForSession(session, changes);
    } else {
      require("../inventory/corporationOfficeInventoryObservers").fanStarbaseInventoryChanges(changes);
    }
  } catch (error) {
    log.warn(`[StarbaseTravel] fuel projection deferred: ${error.message}`);
  }
}

function flushStructureTable() {
  return database.flushTableSync(structureState.STRUCTURES_TABLE || "structures");
}

function synchronizeInventoryFuelCounter(settlement) {
  const structure = getStructureByID(settlement.sourceStructureID);
  // POS ozone has one authority: actual inventory stacks. Do not introduce a
  // parallel Upwell counter, including after a terminal marker hides the row.
  if (settlement.starbaseJumpTimers || structure?.legacyStarbase === true) return database.flushTableSync("items");
  const remainingQuantity = sumLiquidOzoneStacks(
    listStructureLiquidOzoneStacks(structure),
  );
  const result = synchronizeStructureLiquidOzoneCounter(
    settlement.sourceStructureID,
    remainingQuantity,
  );
  if (!result || result.success !== true) {
    return result || { success: false, errorMsg: "FUEL_COUNTER_UPDATE_FAILED" };
  }
  return flushStructureTable();
}

function mutateLegacyFuel(settlement, action) {
  let mutationError = null;
  const result = structureState.updateStructureRecord(
    settlement.sourceStructureID,
    (record) => {
      const receipts = Array.isArray(record.jumpBridgeFuelReceipts)
        ? record.jumpBridgeFuelReceipts.map((entry) => ({ ...entry }))
        : [];
      const index = receipts.findIndex(
        (entry) => String(entry.operationID || "") === settlement.operationID,
      );
      const receipt = index >= 0 ? receipts[index] : null;
      if (action === "stage") {
        if (receipt) {
          if (Number(receipt.quantity) !== settlement.liquidOzoneRequired) {
            mutationError = "IDEMPOTENCY_KEY_REUSED";
          }
          return record;
        }
        const currentQuantity = Math.max(0, normalizeInt(record.liquidOzoneQty, 0));
        if (currentQuantity < settlement.liquidOzoneRequired) {
          mutationError = "NO_FUEL";
          return record;
        }
        receipts.push({
          operationID: settlement.operationID,
          quantity: settlement.liquidOzoneRequired,
          state: "staged",
        });
        return {
          ...record,
          liquidOzoneQty: currentQuantity - settlement.liquidOzoneRequired,
          jumpBridgeFuelReceipts: receipts.slice(-256),
        };
      }
      if (!receipt) {
        mutationError = "FUEL_RECEIPT_NOT_FOUND";
        return record;
      }
      if (action === "return") {
        if (receipt.state === "returned") {
          return record;
        }
        if (receipt.state !== "staged") {
          mutationError = "FUEL_ALREADY_COMMITTED";
          return record;
        }
        receipts[index] = { ...receipt, state: "returned" };
        return {
          ...record,
          liquidOzoneQty:
            Math.max(0, normalizeInt(record.liquidOzoneQty, 0)) +
            settlement.liquidOzoneRequired,
          jumpBridgeFuelReceipts: receipts,
        };
      }
      if (receipt.state === "committed") {
        return record;
      }
      if (receipt.state !== "staged") {
        mutationError = "FUEL_ALREADY_RETURNED";
        return record;
      }
      receipts[index] = { ...receipt, state: "committed" };
      return { ...record, jumpBridgeFuelReceipts: receipts };
    },
  );
  if (mutationError) {
    return { success: false, errorMsg: mutationError };
  }
  if (!result || result.success !== true) {
    return result || { success: false, errorMsg: "FUEL_RECEIPT_WRITE_FAILED" };
  }
  return flushStructureTable();
}

async function stageJumpBridgeFuel(operationID) {
  let settlement = getPendingJumpBridgeSettlement(operationID);
  if (!settlement) {
    return { success: true, alreadySettled: true };
  }
  if (settlement.legacyFuel) {
    if (settlement.legacyFuelStaged) {
      return { success: true };
    }
    const result = mutateLegacyFuel(settlement, "stage");
    if (!result || result.success !== true) {
      return result;
    }
    return updateJumpBridgeSettlement(operationID, (current) => ({
      ...current,
      legacyFuelStaged: true,
    }));
  }
  for (const candidate of settlement.fuelLegs) {
    settlement = getPendingJumpBridgeSettlement(operationID);
    const leg = settlement && settlement.fuelLegs.find(
      (entry) => entry.legID === candidate.legID,
    );
    if (!settlement || !leg || leg.staged) {
      continue;
    }
    const result = itemCustody.transfer({
      items: { itemID: leg.itemID, quantity: leg.quantity },
      from: itemCustody.custodyRef.ownerLocation(
        leg.ownerID,
        settlement.sourceStructureID,
        leg.sourceFlagID,
      ),
      to: itemCustody.custodyRef.ownerLocation(
        leg.ownerID,
        leg.escrowLocationID,
        0,
      ),
      actor: settlement.characterID,
      reason: itemCustody.CUSTODY_REASON.JUMP_BRIDGE_FUEL_STAGE,
      idempotencyKey: leg.stageKey,
    });
    const failure = durableCustodyFailure(result, "JUMP_BRIDGE_FUEL_STAGE_FAILED");
    if (failure) {
      return failure;
    }
    publishStarbaseFuelChanges(settlement, result);
    const escrowItem = getCustodyResultItem(result);
    if (!escrowItem) {
      return { success: false, ambiguous: true, errorMsg: "FUEL_ESCROW_ITEM_MISSING" };
    }
    const checkpoint = updateJumpBridgeSettlement(operationID, (current) => ({
      ...current,
      fuelLegs: current.fuelLegs.map((entry) =>
        entry.legID === leg.legID
          ? {
              ...entry,
              staged: true,
              escrowItemID: normalizePositiveInt(escrowItem.itemID, 0),
            }
          : entry),
    }));
    if (!checkpoint.success) {
      return checkpoint;
    }
  }
  settlement = getPendingJumpBridgeSettlement(operationID);
  return synchronizeInventoryFuelCounter(settlement);
}

async function returnJumpBridgeFuel(operationID) {
  let settlement = getPendingJumpBridgeSettlement(operationID);
  if (!settlement) {
    return { success: true, alreadySettled: true };
  }
  if (settlement.legacyFuel) {
    if (!settlement.legacyFuelStaged || settlement.legacyFuelReturned) {
      return { success: true };
    }
    const result = mutateLegacyFuel(settlement, "return");
    if (!result || result.success !== true) {
      return result;
    }
    return updateJumpBridgeSettlement(operationID, (current) => ({
      ...current,
      legacyFuelReturned: true,
    }));
  }
  for (const candidate of [...settlement.fuelLegs].reverse()) {
    settlement = getPendingJumpBridgeSettlement(operationID);
    const leg = settlement && settlement.fuelLegs.find(
      (entry) => entry.legID === candidate.legID,
    );
    if (!settlement || !leg || !leg.staged || leg.returned || leg.committed) {
      continue;
    }
    if (settlement.starbaseCyno && !itemCustody.getCommittedReceipt(leg.returnKey).committed) {
      const sourceShip = findItemById(settlement.sourceStructureID);
      if (!sourceShip || Number(sourceShip.categoryID) !== 6 || Number(sourceShip.ownerID) !== leg.ownerID) {
        // Preserve escrow and the compensating journal for operator recovery;
        // a deleted/transferred ship is not a valid refund container.
        return { success: false, errorMsg: "POS_CYNO_REFUND_SOURCE_UNAVAILABLE" };
      }
    }
    const result = itemCustody.transfer({
      items: { itemID: leg.escrowItemID, quantity: leg.quantity },
      from: itemCustody.custodyRef.ownerLocation(
        leg.ownerID,
        leg.escrowLocationID,
        0,
      ),
      to: itemCustody.custodyRef.ownerLocation(
        leg.ownerID,
        settlement.sourceStructureID,
        leg.sourceFlagID,
      ),
      actor: settlement.characterID,
      reason: itemCustody.CUSTODY_REASON.JUMP_BRIDGE_FUEL_RETURN,
      idempotencyKey: leg.returnKey,
    });
    const failure = durableCustodyFailure(result, "JUMP_BRIDGE_FUEL_RETURN_FAILED");
    if (failure) {
      return failure;
    }
    publishStarbaseFuelChanges(settlement, result);
    const checkpoint = updateJumpBridgeSettlement(operationID, (current) => ({
      ...current,
      fuelLegs: current.fuelLegs.map((entry) =>
        entry.legID === leg.legID ? { ...entry, returned: true } : entry),
    }));
    if (!checkpoint.success) {
      return checkpoint;
    }
  }
  settlement = getPendingJumpBridgeSettlement(operationID);
  return synchronizeInventoryFuelCounter(settlement);
}

async function commitJumpBridgeFuel(operationID) {
  let settlement = getPendingJumpBridgeSettlement(operationID);
  if (!settlement) {
    return { success: true, alreadySettled: true };
  }
  if (settlement.legacyFuel) {
    if (settlement.legacyFuelCommitted) {
      return { success: true };
    }
    const result = mutateLegacyFuel(settlement, "commit");
    if (!result || result.success !== true) {
      return result;
    }
    return updateJumpBridgeSettlement(operationID, (current) => ({
      ...current,
      legacyFuelCommitted: true,
    }));
  }
  for (const candidate of settlement.fuelLegs) {
    settlement = getPendingJumpBridgeSettlement(operationID);
    const leg = settlement && settlement.fuelLegs.find(
      (entry) => entry.legID === candidate.legID,
    );
    if (!settlement || !leg || leg.committed) {
      continue;
    }
    const result = itemCustody.transfer({
      items: { itemID: leg.escrowItemID, quantity: leg.quantity },
      from: itemCustody.custodyRef.ownerLocation(
        leg.ownerID,
        leg.escrowLocationID,
        0,
      ),
      to: itemCustody.custodyRef.void(),
      options: { removeContents: false },
      actor: settlement.characterID,
      reason: itemCustody.CUSTODY_REASON.JUMP_BRIDGE_FUEL_COMMIT,
      idempotencyKey: leg.commitKey,
    });
    const failure = durableCustodyFailure(result, "JUMP_BRIDGE_FUEL_COMMIT_FAILED");
    if (failure) {
      return failure;
    }
    publishStarbaseFuelChanges(settlement, result);
    const checkpoint = updateJumpBridgeSettlement(operationID, (current) => ({
      ...current,
      fuelLegs: current.fuelLegs.map((entry) =>
        entry.legID === leg.legID ? { ...entry, committed: true } : entry),
    }));
    if (!checkpoint.success) {
      return checkpoint;
    }
  }
  return { success: true };
}

function commitWalletProjectionForJumpBridge(characterID) {
  const result = updateCharacterRecord(characterID, (record) => {
    applyCharacterWalletProjection(record, characterID);
    return record;
  });
  if (!result || result.success !== true) {
    return result || { success: false, errorMsg: "CHARACTER_PROJECTION_FAILED" };
  }
  return database.flushTableSync(CHARACTERS_TABLE || "characters");
}

function getJumpBridgeTransitionReceipt(settlement) {
  const matches = (receipt) => Boolean(
    receipt &&
    String(receipt.operationID || "") === settlement.operationID &&
    normalizePositiveInt(receipt.shipID, 0) === settlement.shipID &&
    normalizePositiveInt(receipt.sourceStructureID, 0) ===
      settlement.sourceStructureID &&
    normalizePositiveInt(receipt.destinationStructureID, 0) ===
      settlement.destinationStructureID &&
    normalizePositiveInt(receipt.destinationSolarSystemID, 0) ===
      settlement.destinationSolarSystemID
  );
  const character = getCharacterRecord(settlement.characterID) || {};
  if (matches(character.jumpBridgeTransitionReceipt)) {
    return character.jumpBridgeTransitionReceipt;
  }
  const ship = findItemById(settlement.shipID);
  const receipt = ship && ship.spaceState && ship.spaceState.jumpBridgeTransitionReceipt;
  return matches(receipt) ? receipt : null;
}

function canApplyJumpBridgeTransition(settlement, session) {
  if (
    !session ||
    normalizePositiveInt(session.characterID, 0) !== settlement.characterID ||
    !session._space ||
    normalizePositiveInt(session._space.systemID, 0) !== settlement.sourceSolarSystemID
  ) {
    return false;
  }
  if (settlement.starbaseCyno) return require("./structureCynoBeaconMgrService")
    .validateStarbaseCynoSettlement(settlement, session);
  const sourceStructure = getStructureByID(settlement.sourceStructureID);
  const destinationStructure = getStructureByID(settlement.destinationStructureID);
  if (
    !isAnsiblexStructure(sourceStructure) ||
    !isAnsiblexStructure(destinationStructure) ||
    !isJumpBridgeServiceOnline(sourceStructure) ||
    !isJumpBridgeServiceOnline(destinationStructure) ||
    hasJumpBridgeServiceProximityConflict(sourceStructure) ||
    hasJumpBridgeServiceProximityConflict(destinationStructure) ||
    !hasBridgeAccess(session, sourceStructure)
  ) {
    return false;
  }
  const linked = findReciprocalLinkedStructure(sourceStructure);
  if (!linked || linked.structureID !== settlement.destinationStructureID) {
    return false;
  }
  const activeShip = getActiveShipRecord(settlement.characterID);
  if (!activeShip || activeShip.itemID !== settlement.shipID) {
    return false;
  }
  const shipEntity = spaceRuntime.getEntity(session, settlement.shipID);
  const sourceEntity = spaceRuntime.getEntity(session, settlement.sourceStructureID);
  if (sourceStructure.legacyStarbase === true) {
    const shipMass = resolveShipMassKg(activeShip, shipEntity);
    const distanceLy = getSolarSystemDistanceLy(sourceStructure.solarSystemID, destinationStructure.solarSystemID);
    if (starbaseTravel().validateBridgePassenger(session, sourceStructure, destinationStructure, activeShip, shipMass) ||
        shipMass > MAX_ANSIBLEX_SHIP_MASS_KG ||
        Number(activeShip.locationID) !== settlement.sourceSolarSystemID ||
        starbaseTravel().calculateBridgeFuel(sourceStructure, shipMass, distanceLy) !== settlement.liquidOzoneRequired ||
        distanceLy !== settlement.starbaseJumpTimers?.distanceLy) return false;
  }
  return Boolean(
    shipEntity &&
    sourceEntity &&
    canEntitiesInteractLocally(shipEntity, sourceEntity) &&
    surfaceDistance(shipEntity, sourceEntity) <= ANSIBLEX_JUMP_RANGE_METERS &&
    !isCharacterWarpDisrupted(session, shipEntity) &&
    !findWarpDisruptionFieldForShip(settlement.sourceSolarSystemID, shipEntity)
  );
}

async function compensateJumpBridgeSettlement(operationID) {
  let settlement = getPendingJumpBridgeSettlement(operationID);
  if (!settlement) {
    return { success: false, compensated: true, errorMsg: "JUMP_BRIDGE_CANCELLED" };
  }
  if (settlement.transitioned || getJumpBridgeTransitionReceipt(settlement)) {
    return { success: false, errorMsg: "JUMP_BRIDGE_ALREADY_TRANSITIONED" };
  }
  if (
    settlement.creditApplied && settlement.ownerCorpID > 0 &&
    settlement.activationFee > 0 && !settlement.creditReversed
  ) {
    const result = await adjustCorporationWalletDivisionBalanceAsync(
      settlement.ownerCorpID,
      CORPORATION_WALLET_KEY_START,
      -settlement.activationFee,
      {
        description: `Cancelled Ansiblex activation at ${settlement.sourceStructureID}`,
        entryTypeID: JOURNAL_ENTRY_TYPE.STRUCTURE_GATE_JUMP,
        idempotencyKey: settlement.creditReversalCommandID,
        ownerID1: settlement.characterID,
        ownerID2: settlement.ownerCorpID,
        referenceID: settlement.sourceStructureID,
      },
      {
        commandID: settlement.creditReversalCommandID,
        source: "jump-bridge-owner-credit-reversal",
      },
    );
    if (!result || result.success !== true) {
      return result || { success: false, errorMsg: "OWNER_CREDIT_REVERSAL_FAILED" };
    }
    const checkpoint = updateJumpBridgeSettlement(operationID, (current) => ({
      ...current,
      creditReversed: true,
    }));
    if (!checkpoint.success) {
      return checkpoint;
    }
    settlement = checkpoint.data;
  }
  if (
    settlement.debitApplied && settlement.activationFee > 0 &&
    !settlement.debitRefunded
  ) {
    const result = await adjustCharacterBalanceAsync(
      settlement.characterID,
      settlement.activationFee,
      {
        accountKey: ACCOUNT_KEY.CASH,
        description: `Cancelled Ansiblex activation at ${settlement.sourceStructureID}`,
        entryTypeID: JOURNAL_ENTRY_TYPE.STRUCTURE_GATE_JUMP,
        idempotencyKey: settlement.debitRefundCommandID,
        ownerID1: settlement.ownerCorpID,
        ownerID2: settlement.characterID,
        referenceID: settlement.sourceStructureID,
      },
      {
        commandID: settlement.debitRefundCommandID,
        source: "jump-bridge-character-debit-refund",
      },
    );
    if (!result || result.success !== true) {
      return result || { success: false, errorMsg: "CHARACTER_DEBIT_REFUND_FAILED" };
    }
    const checkpoint = updateJumpBridgeSettlement(operationID, (current) => ({
      ...current,
      debitRefunded: true,
    }));
    if (!checkpoint.success) {
      return checkpoint;
    }
  }
  const fuelResult = await returnJumpBridgeFuel(operationID);
  if (!fuelResult || fuelResult.success !== true) {
    return fuelResult || { success: false, errorMsg: "FUEL_RETURN_FAILED" };
  }
  settlement = getPendingJumpBridgeSettlement(operationID);
  const projectionResult = commitWalletProjectionForJumpBridge(settlement.characterID);
  if (!projectionResult || projectionResult.success !== true) {
    return projectionResult;
  }
  const reason = settlement.compensationReason || "JUMP_BRIDGE_CANCELLED";
  if (!removeJumpBridgeSettlement(operationID)) {
    return { success: false, errorMsg: "JUMP_BRIDGE_COMPENSATION_FINALIZE_FAILED" };
  }
  return { success: false, compensated: true, errorMsg: reason };
}

function beginJumpBridgeCompensation(settlement, reason) {
  if (!settlement.compensating) {
    const checkpoint = updateJumpBridgeSettlement(
      settlement.operationID,
      (current) => ({
        ...current,
        compensating: true,
        compensationReason: String(reason || "JUMP_BRIDGE_CANCELLED"),
      }),
    );
    if (!checkpoint.success) {
      return Promise.resolve(checkpoint);
    }
  }
  return compensateJumpBridgeSettlement(settlement.operationID);
}

async function settlePendingJumpBridgeInternal(operationID, options = {}) {
  let settlement = getPendingJumpBridgeSettlement(operationID);
  if (!settlement) {
    return { success: true, alreadySettled: true };
  }
  if (settlement.compensating) {
    return compensateJumpBridgeSettlement(operationID);
  }
  const fuelResult = await stageJumpBridgeFuel(operationID);
  if (!fuelResult || fuelResult.success !== true) {
    if (fuelResult && fuelResult.ambiguous) {
      return fuelResult;
    }
    settlement = getPendingJumpBridgeSettlement(operationID);
    return beginJumpBridgeCompensation(
      settlement,
      fuelResult && fuelResult.errorMsg || "FUEL_STAGE_FAILED",
    );
  }
  settlement = getPendingJumpBridgeSettlement(operationID);
  if (!settlement.debitApplied) {
    const result = await adjustCharacterBalanceAsync(
      settlement.characterID,
      -settlement.activationFee,
      {
        accountKey: ACCOUNT_KEY.CASH,
        description: `Ansiblex activation fee at ${settlement.sourceStructureID}`,
        entryTypeID: JOURNAL_ENTRY_TYPE.STRUCTURE_GATE_JUMP,
        idempotencyKey: settlement.debitCommandID,
        ownerID1: settlement.characterID,
        ownerID2: settlement.ownerCorpID,
        referenceID: settlement.sourceStructureID,
      },
      {
        commandID: settlement.debitCommandID,
        source: "jump-bridge-character-debit",
      },
    );
    if (!result || result.success !== true) {
      if (result && result.errorMsg === "INSUFFICIENT_FUNDS") {
        return beginJumpBridgeCompensation(settlement, "INSUFFICIENT_FUNDS");
      }
      return result || { success: false, errorMsg: "CHARACTER_DEBIT_FAILED" };
    }
    const checkpoint = updateJumpBridgeSettlement(operationID, (current) => ({
      ...current,
      debitApplied: true,
    }));
    if (!checkpoint.success) {
      return checkpoint;
    }
    settlement = checkpoint.data;
  }
  if (!settlement.creditApplied) {
    const result = await adjustCorporationWalletDivisionBalanceAsync(
      settlement.ownerCorpID,
      CORPORATION_WALLET_KEY_START,
      settlement.activationFee,
      {
        description: `Ansiblex activation fee at ${settlement.sourceStructureID}`,
        entryTypeID: JOURNAL_ENTRY_TYPE.STRUCTURE_GATE_JUMP,
        idempotencyKey: settlement.creditCommandID,
        ownerID1: settlement.characterID,
        ownerID2: settlement.ownerCorpID,
        referenceID: settlement.sourceStructureID,
      },
      {
        commandID: settlement.creditCommandID,
        source: "jump-bridge-owner-credit",
      },
    );
    if (!result || result.success !== true) {
      return result || { success: false, errorMsg: "OWNER_CREDIT_FAILED" };
    }
    const checkpoint = updateJumpBridgeSettlement(operationID, (current) => ({
      ...current,
      creditApplied: true,
    }));
    if (!checkpoint.success) {
      return checkpoint;
    }
    settlement = checkpoint.data;
  }
  const projectionResult = commitWalletProjectionForJumpBridge(settlement.characterID);
  if (!projectionResult || projectionResult.success !== true) {
    return projectionResult;
  }
  let boundResult = null;
  if (!settlement.transitioned) {
    if (!getJumpBridgeTransitionReceipt(settlement)) {
      const session = options.session ||
        sessionRegistry.findSessionByCharacterID(settlement.characterID) || null;
      if (!canApplyJumpBridgeTransition(settlement, session)) {
        return beginJumpBridgeCompensation(settlement, "TRANSITION_UNAVAILABLE");
      }
      if (settlement.starbaseJumpTimers) {
        // Escrow may have waited on a persistence retry. Timers begin at this
        // transition attempt, never at preparation. A committed receipt skips
        // this checkpoint on replay, preserving the original transition time.
        const checkpoint = updateJumpBridgeSettlement(operationID, (current) => ({
          ...current, starbaseJumpTimers: { ...current.starbaseJumpTimers, nowMs: Date.now() },
        }));
        if (!checkpoint.success) return checkpoint;
        settlement = checkpoint.data;
      }
      let jumpResult;
      try {
        const transitionOptions = {
          spawnStateOverride: settlement.arrivalSpawnState,
          stargateJumpCloak: settlement.starbaseCyno !== true,
          jumpBridgeSettlementReceipt: {
            operationID: settlement.operationID,
            shipID: settlement.shipID,
            sourceStructureID: settlement.sourceStructureID,
            destinationStructureID: settlement.destinationStructureID,
            destinationSolarSystemID: settlement.destinationSolarSystemID,
          },
        };
        jumpResult = settlement.starbaseJumpTimers || settlement.starbaseCyno
          ? jumpSessionToSolarSystem(session, settlement.destinationSolarSystemID, transitionOptions)
          : await jumpSessionViaAnsiblex(session, settlement.sourceStructureID,
            settlement.destinationStructureID, settlement.destinationSolarSystemID, transitionOptions);
      } catch (error) {
        if (!settlement.starbaseJumpTimers) throw error;
        log.warn(`[StarbaseTravel] transition threw operation=${operationID}: ${error.message}`);
        jumpResult = { success: false, errorMsg: "TRANSITION_FAILED" };
      }
      if (!jumpResult || jumpResult.success !== true) {
        if (!getJumpBridgeTransitionReceipt(settlement)) {
          return beginJumpBridgeCompensation(settlement, "TRANSITION_FAILED");
        }
      } else {
        boundResult = jumpResult.data && jumpResult.data.boundResult || true;
      }
      const characterFlush = database.flushTableSync(CHARACTERS_TABLE || "characters");
      const itemFlush = database.flushTableSync("items");
      if (
        !characterFlush || characterFlush.success !== true ||
        !itemFlush || itemFlush.success !== true
      ) {
        return { success: false, errorMsg: "TRANSITION_FLUSH_FAILED" };
      }
    }
    const checkpoint = updateJumpBridgeSettlement(operationID, (current) => ({
      ...current,
      transitioned: true,
    }));
    if (!checkpoint.success) {
      return checkpoint;
    }
    settlement = checkpoint.data;
  }
  // Ansiblex travel neither applies nor clears jump-drive fatigue/cooldown.
  // Legacy POS bridges and cynos retain their durable timer receipts below.
  const commitFuelResult = await commitJumpBridgeFuel(operationID);
  if (!commitFuelResult || commitFuelResult.success !== true) {
    return commitFuelResult || { success: false, errorMsg: "FUEL_COMMIT_FAILED" };
  }
  if (settlement.starbaseJumpTimers) {
    const timerResult = require("../_shared/jumpTimerRuntime").applyJumpTimersForCharacter(settlement.characterID, {
      ...settlement.starbaseJumpTimers, idempotencyKey: `pos-bridge:${settlement.operationID}`,
      session: options.session || sessionRegistry.findSessionByCharacterID(settlement.characterID),
    });
    if (!timerResult.success) return timerResult;
    const flush = database.flushTableSync(CHARACTERS_TABLE || "characters");
    if (!flush?.success) return flush || { success: false, errorMsg: "JUMP_TIMERS_FLUSH_FAILED" };
  }
  if (settlement.starbaseCyno) {
    // Cyno settlements always carry their timers, but a damaged saved row must
    // not throw here and strand the escrowed fuel.
    const result = require("./structureCynoBeaconMgrService").applyStarbaseCynoTetherDelay(
      { characterID: settlement.characterID },
      settlement.starbaseJumpTimers?.nowMs ?? Date.now());
    if (result && !result.success) return result;
    const flushed = database.flushTableSync("structureTetherRestrictions");
    if (!flushed?.success) return flushed || { success: false, errorMsg: "TETHER_DELAY_FLUSH_FAILED" };
  }
  if (!removeJumpBridgeSettlement(operationID)) {
    return { success: false, errorMsg: "JUMP_BRIDGE_FINALIZE_FAILED" };
  }
  return { success: true, operationID, boundResult };
}

function settlePendingJumpBridge(operationID, options = {}) {
  const settlement = getPendingJumpBridgeSettlement(operationID);
  if (!settlement) {
    return Promise.resolve({ success: true, alreadySettled: true });
  }
  return runJumpBridgeSerialized(settlement.characterID, () =>
    settlePendingJumpBridgeInternal(operationID, options));
}

function buildDurableJumpBridgeSettlementJob(settlement) {
  const normalized = normalizeJumpBridgeSettlement(settlement);
  return normalized ? {
    jobID: `${DURABLE_SETTLEMENT_JOB_PREFIX}${normalized.operationID}`,
    type: DURABLE_SETTLEMENT_JOB_TYPE,
    dueAtMs: Date.now(),
    payload: { operationID: normalized.operationID },
  } : null;
}

async function schedulePendingJumpBridgeSettlement(settlement) {
  if (!durableScheduler) {
    return null;
  }
  const job = buildDurableJumpBridgeSettlementJob(settlement);
  if (job) {
    await durableScheduler.schedule(job);
  }
  return job;
}

function bindDurableScheduler(scheduler) {
  if (!scheduler || typeof scheduler.schedule !== "function") {
    throw new TypeError("jump bridge scheduler requires a schedule function");
  }
  durableScheduler = scheduler;
  return true;
}

function unbindDurableScheduler(scheduler = null) {
  if (scheduler && durableScheduler !== scheduler) {
    return false;
  }
  durableScheduler = null;
  return true;
}

async function handleDurableJumpBridgeSettlement(job = {}) {
  const operationID = String(job.payload && job.payload.operationID || "").trim();
  if (!operationID) {
    throw new Error("jump bridge settlement job is invalid");
  }
  const result = await settlePendingJumpBridge(operationID);
  if (!result || result.success !== true) {
    if (result && result.compensated === true) {
      return { operationID, compensated: true, errorMsg: result.errorMsg };
    }
    throw new Error(result && result.errorMsg || "jump bridge settlement failed");
  }
  return result;
}

// `jump-bridge-settlement:<characterID>:<operationSequence>:<leg>`. The sequence
// also places the fuel escrow, so a repeated one could hand two jumps the same
// escrow location as well as the same commandIDs.
const SEQUENCE_DOMAIN = registerSettlementSequenceDomain(
  "jump-bridge-settlement",
  /^jump-bridge-settlement:\d+:(\d+):/,
);

function advanceOperationSequenceWatermark(receiptScan) {
  return advanceSettlementSequenceWatermark({
    logTag: "[JumpBridgeSettlement]",
    counterName: "nextOperationID",
    domain: SEQUENCE_DOMAIN,
    receiptScan,
    readCounter: () => ensureJumpBridgeSettlementRoot()._meta.nextOperationID,
    writeCounter: (required) => {
      const root = ensureJumpBridgeSettlementRoot();
      if (root._meta.nextOperationID >= required) {
        return { success: true };
      }
      root._meta.nextOperationID = required;
      return writeJumpBridgeSettlementRoot(root);
    },
    pendingSequences: () =>
      listPendingJumpBridgeSettlements().map(
        (settlement) => settlement.operationSequence,
      ),
  });
}

async function reconcileDurableJumpBridgeSettlements(options = {}) {
  advanceOperationSequenceWatermark(options.receiptScan);
  const pending = listPendingJumpBridgeSettlements();
  if (!durableScheduler) {
    return { scheduled: 0, pending: pending.length };
  }
  await Promise.all(pending.map((settlement) =>
    schedulePendingJumpBridgeSettlement(settlement)));
  return { scheduled: pending.length, pending: pending.length };
}

class StructureJumpBridgeMgrService extends BaseService {
  constructor() {
    super("structureJumpBridgeMgr");
  }

  Handle_GetJbStructureDestination(args) {
    const sourceStructure = getStructureByID(Array.isArray(args) ? args[0] : null);
    if (!isAnsiblexStructure(sourceStructure)) {
      return null;
    }
    return getStructureDestinationSolarSystemID(sourceStructure) || null;
  }

  Handle_GetLinkedStructure(args) {
    const sourceStructure = getStructureByID(Array.isArray(args) ? args[0] : null);
    const linkedStructure = findReciprocalLinkedStructure(sourceStructure);
    if (!linkedStructure) {
      return null;
    }
    return [
      normalizePositiveInt(linkedStructure.structureID, 0),
      normalizePositiveInt(linkedStructure.solarSystemID, 0),
    ];
  }

  async Handle_CmdJumpThroughStructureStargate(args, session) {
    const structureID = normalizePositiveInt(Array.isArray(args) ? args[0] : null, 0);
    if (!session || !session.characterID || !session._space) {
      throwNotify("You must be in space to use a jump bridge.");
    }
    const characterID = normalizePositiveInt(session.characterID, 0);
    let settlement = findPendingJumpBridgeSettlementForCharacter(characterID);
    if (settlement) {
      if (settlement.sourceStructureID !== structureID) {
        throwNotify("Another jump bridge activation is still pending.");
      }
      const resumed = await settlePendingJumpBridge(
        settlement.operationID,
        { session },
      );
      if (!resumed || resumed.success !== true) {
        if (resumed && resumed.errorMsg === "INSUFFICIENT_FUNDS") {
          const wallet = getCharacterWallet(characterID);
          throwNotEnoughMoney(
            settlement.activationFee,
            wallet ? wallet.balance : 0,
          );
        }
        if (resumed && resumed.errorMsg === "NO_FUEL") {
          throwNotify("That jump bridge does not have enough Liquid Ozone.");
        }
        throwNotify("The jump bridge session change failed.");
      }
      return resumed.boundResult || true;
    }
    const sourceStructure = getStructureByID(structureID);
    if (!isAnsiblexStructure(sourceStructure)) {
      throwNotify("That jump bridge is no longer available.");
    }
    if (
      normalizePositiveInt(sourceStructure.solarSystemID, 0) !==
      normalizePositiveInt(session._space.systemID || session.solarsystemid2 || session.solarsystemid, 0)
    ) {
      throwNotify("You are not in the same solar system as that jump bridge.");
    }
    if (!isJumpBridgeServiceOnline(sourceStructure)) {
      throwNotify("That jump bridge service is offline.");
    }
    if (hasJumpBridgeServiceProximityConflict(sourceStructure)) {
      throwNotify("That jump bridge service is offline.");
    }
    if (!hasBridgeAccess(session, sourceStructure)) {
      throwWrappedUserError("ActivateJumpBridgeDenied");
    }

    const destinationStructure = findReciprocalLinkedStructure(sourceStructure);
    if (!destinationStructure) {
      throwNotify("That jump bridge is not linked to a reciprocal destination.");
    }
    if (!isJumpBridgeServiceOnline(destinationStructure)) {
      throwNotify("The destination jump bridge service is offline.");
    }
    if (hasJumpBridgeServiceProximityConflict(destinationStructure)) {
      throwNotify("The destination jump bridge service is offline.");
    }

    const activeShip = getActiveShipRecord(session.characterID);
    if (!activeShip) {
      throwNotify("You need an active ship to use a jump bridge.");
    }

    const shipEntity = spaceRuntime.getEntity(session, activeShip.itemID);
    const sourceEntity = spaceRuntime.getEntity(session, sourceStructure.structureID);
    if (
      !shipEntity ||
      !sourceEntity ||
      !canEntitiesInteractLocally(shipEntity, sourceEntity)
    ) {
      throwNotify("That jump bridge is not reachable from your current location.");
    }
    if (shipEntity && sourceEntity) {
      const jumpDistance = surfaceDistance(shipEntity, sourceEntity);
      if (jumpDistance > ANSIBLEX_JUMP_RANGE_METERS) {
        throwNotify("You are too far away from the jump bridge.");
      }
    }
    if (isCharacterWarpDisrupted(session, shipEntity)) {
      throwNotify("You cannot use an Ansiblex while warp disrupted.");
    }
    if (findWarpDisruptionFieldForShip(sourceStructure.solarSystemID, shipEntity)) {
      throwNotify("You cannot use an Ansiblex while inside a warp disruption field.");
    }

    const sourceSolarSystemID = normalizePositiveInt(sourceStructure.solarSystemID, 0);
    const destinationSolarSystemID = normalizePositiveInt(destinationStructure.solarSystemID, 0);
    const distanceLy = getSolarSystemDistanceLy(sourceSolarSystemID, destinationSolarSystemID);
    if (distanceLy !== null && distanceLy > MAX_ANSIBLEX_RANGE_LY + 0.000001) {
      throwNotify("That jump bridge connection is beyond the maximum Ansiblex range.");
    }

    const shipMassKg = resolveShipMassKg(activeShip, shipEntity);
    if (sourceStructure.legacyStarbase === true) {
      const error = starbaseTravel().validateBridgePassenger(session, sourceStructure, destinationStructure, activeShip, shipMassKg);
      if (error) throwNotify({
        POS_BRIDGE_SHIP_INELIGIBLE: "This ship is not eligible to use a legacy POS jump bridge.",
        POS_BRIDGE_JUMP_ACTIVATION: "Your jump activation timer has not expired.",
      }[error] || "Both POS jump bridges must be operational and permit you to use them.");
    }
    if (shipMassKg > MAX_ANSIBLEX_SHIP_MASS_KG) {
      throwNotify("Your ship is too massive to use an Ansiblex jump bridge.");
    }

    const liquidOzoneRequired = sourceStructure.legacyStarbase === true
      ? starbaseTravel().calculateBridgeFuel(sourceStructure, shipMassKg, distanceLy)
      : calculateLiquidOzoneRequired(
      shipMassKg,
      distanceLy === null ? 0 : distanceLy,
    );
    const activationFee = calculateJumpBridgeActivationFee(
      sourceStructure,
      session,
      liquidOzoneRequired,
    );
    ensureCharacterCanPayJumpBridgeFee(session, activationFee);

    const prepared = prepareJumpBridgeSettlement({
      characterID,
      shipID: activeShip.itemID,
      sourceStructureID: sourceStructure.structureID,
      destinationStructureID: destinationStructure.structureID,
      sourceSolarSystemID,
      destinationSolarSystemID,
      liquidOzoneRequired,
      activationFee,
      ownerCorpID: getStructureOwnerCorpID(sourceStructure),
      starbaseJumpTimers: sourceStructure.legacyStarbase === true ? {
        distanceLy, nowMs: Date.now(), jumpFatigueMultiplier: require("../_shared/jumpTimerRuntime").resolveJumpFatigueMultiplier(
          require("../fitting/liveFittingState").buildShipResourceState(characterID, activeShip)),
      } : null,
      arrivalSpawnState: buildStructureArrivalSpawnState(
        destinationStructure,
        activeShip,
      ),
    });
    if (!prepared.success || !prepared.data) {
      if (prepared.errorMsg === "NO_FUEL") {
        throwNotify("That jump bridge does not have enough Liquid Ozone.");
      }
      throwNotify("The jump bridge activation could not be prepared.");
    }
    settlement = prepared.data;
    void schedulePendingJumpBridgeSettlement(settlement).catch((error) => {
      log.warn(
        `[StructureJumpBridgeMgr] durable scheduling failed operation=${settlement.operationID}: ${error.message}`,
      );
    });
    const result = await settlePendingJumpBridge(
      settlement.operationID,
      { session },
    );
    if (!result || result.success !== true) {
      if (result && result.errorMsg === "INSUFFICIENT_FUNDS") {
        const wallet = getCharacterWallet(characterID);
        throwNotEnoughMoney(activationFee, wallet ? wallet.balance : 0);
      }
      if (result && result.errorMsg === "NO_FUEL") {
        throwNotify("That jump bridge does not have enough Liquid Ozone.");
      }
      log.warn(`[StructureJumpBridgeMgr] settlement failed operation=${settlement.operationID} error=${result && result.errorMsg}`);
      throwNotify("The jump bridge session change failed.");
    }

    log.info(
      `[StructureJumpBridgeMgr] char=${session.characterID} jumped source=${sourceStructure.structureID} destination=${destinationStructure.structureID} ozone=${liquidOzoneRequired} fee=${activationFee}`,
    );
    return result.boundResult || true;
  }
}

StructureJumpBridgeMgrService._testing = {
  ANSIBLEX_JUMP_RANGE_METERS,
  MAX_ANSIBLEX_RANGE_LY,
  MAX_ANSIBLEX_SHIP_MASS_KG,
  MAX_ANSIBLEX_ISK_PER_LIQUID_OZONE,
  calculateLiquidOzoneRequired,
  calculateJumpBridgeActivationFee,
  getSolarSystemDistanceLy,
  findReciprocalLinkedStructure,
  consumeStructureLiquidOzone,
  listStructureLiquidOzoneStacks,
  prepareJumpBridgeSettlement,
  stageJumpBridgeFuel,
  returnJumpBridgeFuel,
  commitJumpBridgeFuel,
};
StructureJumpBridgeMgrService.DURABLE_SETTLEMENT_JOB_TYPE =
  DURABLE_SETTLEMENT_JOB_TYPE;
StructureJumpBridgeMgrService.bindDurableScheduler = bindDurableScheduler;
StructureJumpBridgeMgrService.buildDurableJumpBridgeSettlementJob =
  buildDurableJumpBridgeSettlementJob;
StructureJumpBridgeMgrService.handleDurableJumpBridgeSettlement =
  handleDurableJumpBridgeSettlement;
StructureJumpBridgeMgrService.listPendingJumpBridgeSettlements =
  listPendingJumpBridgeSettlements;
StructureJumpBridgeMgrService.findPendingJumpBridgeSettlementForCharacter =
  findPendingJumpBridgeSettlementForCharacter;
StructureJumpBridgeMgrService.reconcileDurableJumpBridgeSettlements =
  reconcileDurableJumpBridgeSettlements;
StructureJumpBridgeMgrService.settlePendingJumpBridge = settlePendingJumpBridge;
StructureJumpBridgeMgrService.prepareJumpBridgeSettlement = prepareJumpBridgeSettlement;
StructureJumpBridgeMgrService.schedulePendingJumpBridgeSettlement = schedulePendingJumpBridgeSettlement;
StructureJumpBridgeMgrService.unbindDurableScheduler = unbindDurableScheduler;

module.exports = StructureJumpBridgeMgrService;
