"use strict";
const { getSessionCorporationRoleMask } = require("../corporation/corporationRoleChecks");

const path = require("path");

// Phase 0 / 0.C: insurance state via an ownership-scoped repository.
const {
  createTableRepository,
} = require(path.join(__dirname, "../../gameStore/tableRepository"));
const repo = createTableRepository("service:insurance", { strict: true });
const log = require(path.join(__dirname, "../../utils/logger"));
const { throwWrappedUserError } = require(path.join(
  __dirname,
  "../../common/machoErrors",
));
const {
  ITEM_FLAGS,
  SHIP_CATEGORY_ID,
  findShipItemById,
  getCharacterHangarShipItems,
  listContainerItems,
  listOwnedItems,
} = require(path.join(__dirname, "../inventory/itemStore"));
const {
  getCharacterRecord,
} = require(path.join(__dirname, "../character/characterState"));
const {
  getCorporationRecord,
} = require(path.join(__dirname, "../corporation/corporationState"));
const {
  getCorporationOffices,
  getCorporationOfficeByInventoryID,
} = require(path.join(__dirname, "../corporation/corporationRuntimeState"));
const {
  ACCOUNT_KEY,
  JOURNAL_ENTRY_TYPE,
  adjustCharacterBalanceAsync,
  buildNotEnoughMoneyUserErrorValues,
  getCharacterWallet,
} = require(path.join(__dirname, "../account/walletState"));
const {
  adjustCorporationWalletDivisionBalanceAsync,
  getCorporationWalletBalance,
  normalizeCorporationWalletKey,
} = require(path.join(__dirname, "../corporation/corpWalletState"));
const {
  buildFiletimeLong,
  buildKeyVal,
  currentFileTime,
  normalizeNumber,
} = require(path.join(__dirname, "../_shared/serviceHelpers"));
const {
  BASE_INSURANCE_FRACTION,
  DEFAULT_INSURANCE_FRACTION,
  centsToIsk,
  computePayoutCents,
  computePremiumCents,
  getFullInsurancePrice,
  getFullInsurancePriceCents,
  getInsurancePrices,
  getPackageByFraction,
  resolvePackageFromPremium,
} = require(path.join(__dirname, "./insurancePriceAuthority"));
const {
  INSURANCE_INVALID_REASON,
  PEND_INSURANCE_CORPORATION_ID,
  notifyInsuranceExpiration,
  notifyInsuranceInvalidated,
  notifyInsuranceIssued,
  notifyInsurancePayout,
} = require(path.join(__dirname, "./insuranceNotifications"));
const {
  ENTITY_TYPE,
} = require(path.join(__dirname, "../../space/entityConstants"));

const INSURANCE_CONTRACTS_TABLE = "insuranceContracts";
const DURABLE_SETTLEMENT_JOB_TYPE = "insurance.settle";
const INSURANCE_DURATION_TICKS = BigInt(12 * 7 * 24 * 60 * 60 * 1000) * 10000n;
const STATION_INSURANCE_SERVICE_MASK = 1048576;
const CORP_ROLE_ACCOUNTANT = 256n;
const CORP_ROLE_JUNIOR_ACCOUNTANT = 4503599627370496n;

const OWNER_KIND = Object.freeze({
  CHARACTER: "character",
  CORPORATION: "corporation",
});
const CONTRACT_STATUS = Object.freeze({
  ACTIVE: "active",
  VOID: "void",
  PAID: "paid",
});
const OPERATION_KIND = Object.freeze({
  PREMIUM: "premium",
  PAYOUT: "payout",
});
const CONTRACT_VOID_REASON = Object.freeze({
  MANUAL: "manual",
  REPLACED: "replaced",
  OWNER_CHANGED: "ownerChanged",
  CORP_HANGAR: "corpHangar",
  REPACKAGED: "repackaged",
  EXPIRED: "expired",
  NO_VALUE: "noValue",
  CONCORD: "concord",
});

let stateCache = null;
let activeContractByShipID = new Map();
let activeContractIDsByOwnerID = new Map();
let durableScheduler = null;
const operationLanes = new Map();
const shipInsuranceLanes = new Map();

function cloneValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function toPositiveInt(value, fallback = 0) {
  const numeric = Math.trunc(Number(value) || 0);
  return numeric > 0 ? numeric : fallback;
}

function toFiletimeString(value = null) {
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(Math.trunc(value));
  }
  if (typeof value === "string" && value.trim() !== "") {
    return value;
  }
  return currentFileTime().toString();
}

function compareFiletime(left, right) {
  try {
    const leftValue = BigInt(String(left || "0"));
    const rightValue = BigInt(String(right || "0"));
    if (leftValue < rightValue) {
      return -1;
    }
    if (leftValue > rightValue) {
      return 1;
    }
  } catch (error) {
    // ignored: values BigInt cannot read compare as equal (0)
    return 0;
  }
  return 0;
}

function addDurationToFiletime(startFiletime, durationTicks) {
  try {
    return (BigInt(String(startFiletime || "0")) + durationTicks).toString();
  } catch (error) {
    return (currentFileTime() + durationTicks).toString();
  }
}

function createDefaultState() {
  return {
    _meta: {
      schemaVersion: 2,
      nextContractID: 1,
    },
    contractsByShipID: {},
    contractHistoryByID: {},
    payoutLedgerByLossID: {},
    pendingOperationsByID: {},
  };
}

function normalizeContract(rawContract) {
  if (!rawContract || typeof rawContract !== "object") {
    return null;
  }

  const shipID = toPositiveInt(rawContract.shipID, 0);
  const typeID = toPositiveInt(rawContract.typeID, 0);
  const ownerID = toPositiveInt(rawContract.ownerID, 0);
  const fraction = Math.round(Number(rawContract.fraction || 0) * 10) / 10;
  if (!shipID || !typeID || !ownerID || !(fraction >= 0.5 && fraction <= 1.0)) {
    return null;
  }

  const fullInsurancePriceCents = Math.max(
    0,
    Math.round(Number(rawContract.fullInsurancePriceCents || 0)),
  );
  const packageInfo = getPackageByFraction(fraction);
  const normalized = {
    contractID: toPositiveInt(rawContract.contractID, 0),
    shipID,
    typeID,
    ownerID,
    ownerKind:
      rawContract.ownerKind === OWNER_KIND.CORPORATION
        ? OWNER_KIND.CORPORATION
        : OWNER_KIND.CHARACTER,
    insuredByCharacterID: toPositiveInt(rawContract.insuredByCharacterID, 0),
    corpAccountKey: normalizeCorporationWalletKey(rawContract.corpAccountKey || ACCOUNT_KEY.CASH),
    fraction,
    packageName:
      rawContract.packageName ||
      (packageInfo ? packageInfo.name : null),
    premiumCents: Math.max(0, Math.round(Number(rawContract.premiumCents || 0))),
    payoutCents:
      Math.max(0, Math.round(Number(rawContract.payoutCents || 0))) ||
      computePayoutCents(fullInsurancePriceCents, fraction),
    fullInsurancePriceCents,
    startDate: toFiletimeString(rawContract.startDate),
    endDate: toFiletimeString(rawContract.endDate),
    issuedAt: toFiletimeString(rawContract.issuedAt || rawContract.startDate),
    status:
      rawContract.status === CONTRACT_STATUS.PAID ||
      rawContract.status === CONTRACT_STATUS.VOID
        ? rawContract.status
        : CONTRACT_STATUS.ACTIVE,
    voidedAt: rawContract.voidedAt ? toFiletimeString(rawContract.voidedAt) : null,
    voidReason: rawContract.voidReason || null,
    paidAt: rawContract.paidAt ? toFiletimeString(rawContract.paidAt) : null,
    lossID: rawContract.lossID ? String(rawContract.lossID) : null,
    dockableLocationID: toPositiveInt(rawContract.dockableLocationID, 0),
    stationID: toPositiveInt(rawContract.stationID, 0),
    structureID: toPositiveInt(rawContract.structureID, 0),
  };
  if (!normalized.contractID) {
    normalized.contractID = shipID;
  }
  return normalized;
}

function rebuildIndexes(state) {
  activeContractByShipID = new Map();
  activeContractIDsByOwnerID = new Map();
  for (const [shipID, rawContract] of Object.entries(state.contractsByShipID || {})) {
    const contract = normalizeContract(rawContract);
    if (!contract || contract.status !== CONTRACT_STATUS.ACTIVE) {
      delete state.contractsByShipID[shipID];
      continue;
    }
    state.contractsByShipID[String(contract.shipID)] = contract;
    activeContractByShipID.set(contract.shipID, contract);
    if (!activeContractIDsByOwnerID.has(contract.ownerID)) {
      activeContractIDsByOwnerID.set(contract.ownerID, new Set());
    }
    activeContractIDsByOwnerID.get(contract.ownerID).add(contract.shipID);
  }
}

function ensureContractState() {
  if (stateCache) {
    return stateCache;
  }

  const result = repo.read(INSURANCE_CONTRACTS_TABLE, "/");
  const state =
    result.success && result.data && typeof result.data === "object"
      ? result.data
      : createDefaultState();
  let changed = false;
  if (!state._meta || typeof state._meta !== "object") {
    state._meta = createDefaultState()._meta;
    changed = true;
  }
  if (toPositiveInt(state._meta.schemaVersion, 0) < 2) {
    state._meta.schemaVersion = 2;
    changed = true;
  }
  if (!toPositiveInt(state._meta.nextContractID, 0)) {
    state._meta.nextContractID = 1;
    changed = true;
  }
  for (const key of [
    "contractsByShipID",
    "contractHistoryByID",
    "payoutLedgerByLossID",
    "pendingOperationsByID",
  ]) {
    if (!state[key] || typeof state[key] !== "object") {
      state[key] = {};
      changed = true;
    }
  }

  stateCache = state;
  rebuildIndexes(stateCache);
  if (changed) {
    persistState();
  }
  return stateCache;
}

function persistState() {
  const state = ensureContractState();
  rebuildIndexes(state);
  return repo.write(INSURANCE_CONTRACTS_TABLE, "/", state);
}

function resetInsuranceRuntimeCacheForTests() {
  stateCache = null;
  activeContractByShipID = new Map();
  activeContractIDsByOwnerID = new Map();
  operationLanes.clear();
  shipInsuranceLanes.clear();
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

function restoreStateSnapshot(snapshot) {
  stateCache = snapshot;
  rebuildIndexes(stateCache);
}

function persistStateMutation(mutate) {
  const state = ensureContractState();
  const snapshot = cloneValue(state);
  const data = mutate(state);
  const writeResult = persistState();
  if (!writeResult || !writeResult.success) {
    restoreStateSnapshot(snapshot);
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

function allocateContractID(state) {
  const nextContractID = Math.max(1, toPositiveInt(state._meta.nextContractID, 1));
  state._meta.nextContractID = nextContractID + 1;
  return nextContractID;
}

function getSessionCharacterID(session) {
  return toPositiveInt(session && (session.characterID || session.charID || session.charid), 0);
}

function getSessionCorporationID(session) {
  return toPositiveInt(session && (session.corporationID || session.corpid), 0);
}

function hasCorpInsuranceRole(session) {
  const roleMask = getSessionCorporationRoleMask(session);
  return (
    (roleMask & CORP_ROLE_ACCOUNTANT) !== 0n ||
    (roleMask & CORP_ROLE_JUNIOR_ACCOUNTANT) !== 0n
  );
}

function getSessionDockContext(session) {
  const stationID = toPositiveInt(
    session && (session.stationid || session.stationID),
    0,
  );
  const structureID = toPositiveInt(
    session && (session.structureid || session.structureID),
    0,
  );
  const dockableLocationID = stationID || structureID;
  const solarSystemID = toPositiveInt(
    session && (session.solarsystemid2 || session.solarsystemid || session.systemID),
    0,
  );
  return {
    stationID,
    structureID,
    dockableLocationID,
    solarSystemID,
  };
}

function isInsuranceServiceAvailable(session) {
  const dockContext = getSessionDockContext(session);
  if (!dockContext.dockableLocationID) {
    return false;
  }

  if (dockContext.structureID) {
    const structureState = require(path.join(
      __dirname,
      "../structure/structureState",
    ));
    const {
      STRUCTURE_SERVICE_ID,
    } = require(path.join(__dirname, "../structure/structureConstants"));
    const {
      characterHasStructureService,
    } = require(path.join(__dirname, "../structure/structurePayloads"));
    const structure = structureState.getStructureByID(dockContext.structureID, {
      refresh: false,
    });
    return characterHasStructureService(
      session,
      structure,
      STRUCTURE_SERVICE_ID.INSURANCE,
    );
  }

  const {
    buildStationServiceMask,
  } = require(path.join(__dirname, "../_shared/stationStaticData"));
  return (
    (buildStationServiceMask(session, dockContext.stationID) &
      STATION_INSURANCE_SERVICE_MASK) !==
    0
  );
}

function isCorpOfficeLocation(corporationID, locationID) {
  if (!corporationID || !locationID) {
    return false;
  }
  return Boolean(getCorporationOfficeByInventoryID(corporationID, locationID));
}

function getCorpOfficeLocationIDsAtDockable(corporationID, dockableLocationID) {
  return new Set(
    getCorporationOffices(corporationID)
      .filter((office) => Number(office.stationID) === Number(dockableLocationID))
      .flatMap((office) => [office.officeID, office.officeFolderID, office.itemID])
      .map((entry) => toPositiveInt(entry, 0))
      .filter(Boolean),
  );
}

function isShipAtDockableForInsurance(shipItem, dockContext, ownerID = 0) {
  const locationID = toPositiveInt(shipItem && shipItem.locationID, 0);
  if (!locationID || !dockContext.dockableLocationID) {
    return false;
  }
  if (locationID === dockContext.dockableLocationID) {
    return true;
  }
  if (ownerID > 0 && getCorpOfficeLocationIDsAtDockable(ownerID, dockContext.dockableLocationID).has(locationID)) {
    return true;
  }
  return false;
}

function isInsurableShipItem(shipItem) {
  return Boolean(
    shipItem &&
      toPositiveInt(shipItem.categoryID, 0) === SHIP_CATEGORY_ID &&
      normalizeNumber(shipItem.singleton, 0) === 1 &&
      getFullInsurancePriceCents(shipItem.typeID) > 0,
  );
}

function buildClientItemKeyVal(shipItem) {
  return buildKeyVal([
    ["itemID", shipItem.itemID],
    ["typeID", shipItem.typeID],
    ["ownerID", shipItem.ownerID],
    ["locationID", shipItem.locationID],
    ["flagID", shipItem.flagID],
    ["groupID", shipItem.groupID],
    ["categoryID", shipItem.categoryID],
    ["singleton", shipItem.singleton],
    ["shipName", shipItem.itemName || "Ship"],
  ]);
}

function buildClientContract(contract) {
  const normalized = normalizeContract(contract);
  if (!normalized) {
    return null;
  }
  return buildKeyVal([
    ["contractID", normalized.contractID],
    ["shipID", normalized.shipID],
    ["typeID", normalized.typeID],
    ["ownerID", normalized.ownerID],
    ["fraction", normalized.fraction],
    ["startDate", buildFiletimeLong(normalized.startDate)],
    ["endDate", buildFiletimeLong(normalized.endDate)],
  ]);
}

function listItemsToInsure(session) {
  if (!isInsuranceServiceAvailable(session)) {
    return [];
  }

  const characterID = getSessionCharacterID(session);
  const corporationID = getSessionCorporationID(session);
  const dockContext = getSessionDockContext(session);
  const seen = new Set();
  const ships = [];

  for (const ship of getCharacterHangarShipItems(characterID)) {
    if (
      !isInsurableShipItem(ship) ||
      !isShipAtDockableForInsurance(ship, dockContext, characterID)
    ) {
      continue;
    }
    seen.add(ship.itemID);
    ships.push(ship);
  }

  if (corporationID && hasCorpInsuranceRole(session)) {
    const officeLocationIDs = getCorpOfficeLocationIDsAtDockable(
      corporationID,
      dockContext.dockableLocationID,
    );
    for (const locationID of officeLocationIDs) {
      for (const item of listContainerItems(corporationID, locationID, null)) {
        if (!isInsurableShipItem(item) || seen.has(item.itemID)) {
          continue;
        }
        seen.add(item.itemID);
        ships.push(item);
      }
    }
    for (const item of listOwnedItems(corporationID)) {
      if (
        !isInsurableShipItem(item) ||
        seen.has(item.itemID) ||
        !isShipAtDockableForInsurance(item, dockContext, corporationID)
      ) {
        continue;
      }
      seen.add(item.itemID);
      ships.push(item);
    }
  }

  return ships.sort((left, right) => left.itemID - right.itemID);
}

function getActiveContractForShip(shipID, options = {}) {
  const state = ensureContractState();
  const contract = activeContractByShipID.get(toPositiveInt(shipID, 0)) || null;
  if (!contract) {
    return null;
  }
  if (compareFiletime(contract.endDate, options.nowFiletime || currentFileTime()) <= 0) {
    voidInsuranceForShip(contract.shipID, CONTRACT_VOID_REASON.EXPIRED, {
      notify: true,
      notificationKind: "expiration",
      nowFiletime: options.nowFiletime,
    });
    return null;
  }
  // Ensure the state reference is materialized before returning a clone-like shape.
  void state;
  return contract;
}

function expireContractsForOwner(ownerID, nowFiletime = currentFileTime()) {
  const shipIDs = activeContractIDsByOwnerID.get(toPositiveInt(ownerID, 0));
  if (!shipIDs || shipIDs.size === 0) {
    return 0;
  }
  let expired = 0;
  for (const shipID of [...shipIDs]) {
    const contract = activeContractByShipID.get(shipID);
    if (contract && compareFiletime(contract.endDate, nowFiletime) <= 0) {
      voidInsuranceForShip(shipID, CONTRACT_VOID_REASON.EXPIRED, {
        notify: true,
        notificationKind: "expiration",
        nowFiletime,
      });
      expired += 1;
    }
  }
  return expired;
}

function listContracts(session, isCorp = false) {
  const ownerID = isCorp ? getSessionCorporationID(session) : getSessionCharacterID(session);
  if (!ownerID) {
    return [];
  }
  if (isCorp && !hasCorpInsuranceRole(session)) {
    return [];
  }

  expireContractsForOwner(ownerID);
  const shipIDs = activeContractIDsByOwnerID.get(ownerID);
  if (!shipIDs || shipIDs.size === 0) {
    return [];
  }
  return [...shipIDs]
    .map((shipID) => activeContractByShipID.get(shipID))
    .filter(Boolean)
    .sort((left, right) => left.shipID - right.shipID)
    .map((contract) => cloneValue(contract));
}

function canSessionSeeContract(session, contract) {
  if (!contract) {
    return false;
  }
  if (contract.ownerKind === OWNER_KIND.CORPORATION) {
    return (
      contract.ownerID === getSessionCorporationID(session) &&
      hasCorpInsuranceRole(session)
    );
  }
  return contract.ownerID === getSessionCharacterID(session);
}

function getContractForShip(session, shipID) {
  const contract = getActiveContractForShip(shipID);
  return canSessionSeeContract(session, contract) ? cloneValue(contract) : null;
}

function throwNotEnoughMoney(requiredAmount, currentBalance) {
  throwWrappedUserError(
    "NotEnoughMoney",
    buildNotEnoughMoneyUserErrorValues(requiredAmount, currentBalance),
  );
}

async function debitInsurancePremium(contract, operation) {
  const amount = centsToIsk(contract.premiumCents);
  const dockableReferenceID = -Math.abs(toPositiveInt(contract.dockableLocationID, 0));
  const description = `Insurance premium for ship ${contract.shipID}`;
  const commandID = String(operation && operation.commandID || "");
  if (contract.ownerKind === OWNER_KIND.CORPORATION) {
    const accountKey = normalizeCorporationWalletKey(contract.corpAccountKey);
    return adjustCorporationWalletDivisionBalanceAsync(
      contract.ownerID,
      accountKey,
      -amount,
      {
        description,
        entryTypeID: JOURNAL_ENTRY_TYPE.INSURANCE,
        idempotencyKey: commandID,
        ownerID1: contract.ownerID,
        ownerID2: PEND_INSURANCE_CORPORATION_ID,
        referenceID: dockableReferenceID,
      },
      {
        commandID,
        idempotencyKey: commandID,
        source: "insurance-premium",
      },
    );
  }

  return adjustCharacterBalanceAsync(
    contract.ownerID,
    -amount,
    {
      description,
      entryTypeID: JOURNAL_ENTRY_TYPE.INSURANCE,
      idempotencyKey: commandID,
      ownerID1: contract.ownerID,
      ownerID2: PEND_INSURANCE_CORPORATION_ID,
      referenceID: dockableReferenceID,
    },
    {
      commandID,
      idempotencyKey: commandID,
      source: "insurance-premium",
    },
  );
}

async function creditInsurancePayout(operation) {
  const ownerKind = operation.ownerKind;
  const ownerID = operation.ownerID;
  const accountKey = operation.accountKey;
  const amountCents = operation.payoutCents;
  const typeID = operation.typeID;
  const commandID = String(operation.commandID || "");
  const amount = centsToIsk(amountCents);
  if (!(amount > 0)) {
    return { success: true, data: null };
  }
  const description = `Insurance payout for type ${typeID}`;
  if (ownerKind === OWNER_KIND.CORPORATION) {
    return adjustCorporationWalletDivisionBalanceAsync(
      ownerID,
      normalizeCorporationWalletKey(accountKey),
      amount,
      {
        description,
        entryTypeID: JOURNAL_ENTRY_TYPE.INSURANCE,
        idempotencyKey: commandID,
        ownerID1: PEND_INSURANCE_CORPORATION_ID,
        ownerID2: ownerID,
        referenceID: typeID,
      },
      {
        commandID,
        idempotencyKey: commandID,
        source: "insurance-payout",
      },
    );
  }
  return adjustCharacterBalanceAsync(
    ownerID,
    amount,
    {
      description,
      entryTypeID: JOURNAL_ENTRY_TYPE.INSURANCE,
      idempotencyKey: commandID,
      ownerID1: PEND_INSURANCE_CORPORATION_ID,
      ownerID2: ownerID,
      referenceID: typeID,
    },
    {
      commandID,
      idempotencyKey: commandID,
      source: "insurance-payout",
    },
  );
}

function buildDurableSettlementJob(operationID) {
  const normalizedOperationID = String(operationID || "").trim();
  if (!normalizedOperationID) {
    return null;
  }
  return {
    jobID: `insurance:${normalizedOperationID}:settle`,
    type: DURABLE_SETTLEMENT_JOB_TYPE,
    dueAtMs: Date.now(),
    payload: {
      operationID: normalizedOperationID,
    },
  };
}

function findPendingPremiumOperationForShip(shipID) {
  const normalizedShipID = toPositiveInt(shipID, 0);
  if (!normalizedShipID) {
    return null;
  }
  return Object.values(
    ensureContractState().pendingOperationsByID || {},
  ).find((operation) =>
    operation &&
    operation.kind === OPERATION_KIND.PREMIUM &&
    toPositiveInt(operation.contract && operation.contract.shipID, 0) ===
      normalizedShipID) || null;
}

function buildDeferredLossContext(context, shipID, typeID, nowFiletime) {
  return {
    shipID,
    itemID: shipID,
    typeID,
    ownerID: toPositiveInt(context.ownerID, 0),
    ownerCharacterID: toPositiveInt(context.ownerCharacterID, 0),
    pilotCharacterID: toPositiveInt(context.pilotCharacterID, 0),
    corporationID: toPositiveInt(context.corporationID, 0),
    systemID: toPositiveInt(context.systemID, 0),
    lossID: buildLossID(context, shipID),
    destroyedAtFiletime: nowFiletime,
    insuranceSuppressedReason:
      context.insuranceSuppressedReason ||
      context.suppressedInsuranceReason ||
      null,
    isConcordLoss: isConcordLossContext(context),
    skipInsurance: context.skipInsurance === true,
  };
}

function bindDurableScheduler(scheduler) {
  if (!scheduler || typeof scheduler.schedule !== "function") {
    throw new TypeError("insurance scheduler requires a schedule function");
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

async function schedulePendingInsuranceOperation(operationID) {
  if (!durableScheduler) {
    return null;
  }
  const job = buildDurableSettlementJob(operationID);
  if (!job) {
    return null;
  }
  await durableScheduler.schedule(job);
  return job;
}

function finalizePremiumOperation(operation) {
  const contract = normalizeContract(operation.contract);
  if (!contract) {
    return {
      success: false,
      errorMsg: "INVALID_CONTRACT",
    };
  }
  const result = persistStateMutation((state) => {
    if (operation.voidReason) {
      const voidedContract = {
        ...contract,
        status: CONTRACT_STATUS.VOID,
        voidedAt: toFiletimeString(operation.voidedAt),
        voidReason: operation.voidReason,
      };
      state.contractHistoryByID[String(contract.contractID)] = voidedContract;
      delete state.pendingOperationsByID[String(operation.operationID)];
      return voidedContract;
    }
    const replacedContractID = toPositiveInt(operation.replacedContractID, 0);
    const existing = state.contractsByShipID[String(contract.shipID)] || null;
    if (
      existing &&
      replacedContractID > 0 &&
      toPositiveInt(existing.contractID, 0) === replacedContractID
    ) {
      const voided = {
        ...existing,
        status: CONTRACT_STATUS.VOID,
        voidedAt: contract.issuedAt,
        voidReason: CONTRACT_VOID_REASON.REPLACED,
      };
      delete state.contractsByShipID[String(contract.shipID)];
      state.contractHistoryByID[String(replacedContractID)] = voided;
    }
    state.contractsByShipID[String(contract.shipID)] = contract;
    delete state.pendingOperationsByID[String(operation.operationID)];
    return contract;
  });
  if (result.success) {
    if (result.data && result.data.status === CONTRACT_STATUS.VOID) {
      notifyVoidedContract(result.data, result.data.voidReason, {
        notify: true,
      });
    } else {
      notifyInsuranceIssued(contract.insuredByCharacterID, contract);
    }
  }
  return result;
}

function finalizePayoutOperation(operation) {
  const result = persistStateMutation((state) => {
    let paidContract = null;
    const activeContract = state.contractsByShipID[String(operation.shipID)] || null;
    if (
      activeContract &&
      toPositiveInt(operation.contractID, 0) > 0 &&
      toPositiveInt(activeContract.contractID, 0) ===
        toPositiveInt(operation.contractID, 0)
    ) {
      paidContract = {
        ...activeContract,
        status: CONTRACT_STATUS.PAID,
        paidAt: operation.paidAt,
        lossID: operation.lossID,
      };
      delete state.contractsByShipID[String(operation.shipID)];
      state.contractHistoryByID[String(operation.contractID)] = paidContract;
    }
    state.payoutLedgerByLossID[String(operation.lossID)] = {
      ...state.payoutLedgerByLossID[String(operation.lossID)],
      status: "paid",
      paidAt: operation.paidAt,
    };
    delete state.pendingOperationsByID[String(operation.operationID)];
    return paidContract;
  });
  if (result.success && toPositiveInt(operation.recipientCharacterID, 0)) {
    notifyInsurancePayout(
      operation.recipientCharacterID,
      centsToIsk(operation.payoutCents),
      {
        itemID: operation.shipID,
        isDefaultPayout: !operation.contractID,
      },
    );
  }
  return result;
}

function settlePendingInsuranceOperation(operationID) {
  const normalizedOperationID = String(operationID || "").trim();
  return runSerialized(operationLanes, normalizedOperationID, async () => {
    const operation = cloneValue(
      ensureContractState().pendingOperationsByID[normalizedOperationID] || null,
    );
    if (!operation) {
      return {
        success: true,
        alreadySettled: true,
      };
    }

    if (operation.kind === OPERATION_KIND.PREMIUM) {
      const debitResult = await debitInsurancePremium(operation.contract, operation);
      if (!debitResult || !debitResult.success) {
        if (debitResult && debitResult.errorMsg === "INSUFFICIENT_FUNDS") {
          const latestOperation = cloneValue(
            ensureContractState().pendingOperationsByID[normalizedOperationID] ||
              operation,
          );
          const discardResult = persistStateMutation((state) => {
            delete state.pendingOperationsByID[normalizedOperationID];
          });
          if (!discardResult.success) {
            return discardResult;
          }
          if (latestOperation.deferredLossContext) {
            handleShipDestroyed(latestOperation.deferredLossContext);
          }
        }
        return debitResult || {
          success: false,
          errorMsg: "WALLET_DEBIT_FAILED",
        };
      }
      const latestOperation = cloneValue(
        ensureContractState().pendingOperationsByID[normalizedOperationID] ||
          operation,
      );
      const finalizeResult = finalizePremiumOperation(latestOperation);
      if (finalizeResult.success && latestOperation.deferredLossContext) {
        handleShipDestroyed(latestOperation.deferredLossContext);
      }
      return finalizeResult;
    }

    if (operation.kind === OPERATION_KIND.PAYOUT) {
      const creditResult = await creditInsurancePayout(operation);
      if (!creditResult || !creditResult.success) {
        return creditResult || {
          success: false,
          errorMsg: "WALLET_CREDIT_FAILED",
        };
      }
      return finalizePayoutOperation(operation);
    }

    return {
      success: false,
      errorMsg: "INVALID_OPERATION_KIND",
    };
  });
}

function queuePendingInsuranceOperation(operationID) {
  void schedulePendingInsuranceOperation(operationID).catch((error) => {
    log.warn(
      `[Insurance] Durable settlement scheduling failed operation=${operationID}: ${error.message}`,
    );
  });
  const settlement = settlePendingInsuranceOperation(operationID);
  void settlement.catch((error) => {
    log.warn(
      `[Insurance] Async settlement failed operation=${operationID}: ${error.message}`,
    );
  });
  return settlement;
}

async function handleDurableInsuranceSettlement(job = {}) {
  const operationID = String(job.payload && job.payload.operationID || "").trim();
  if (!operationID) {
    throw new Error("insurance settlement job is missing its operation ID");
  }
  const result = await settlePendingInsuranceOperation(operationID);
  if (!result || !result.success) {
    throw new Error(result && result.errorMsg || "insurance settlement failed");
  }
  return result;
}

async function reconcileDurableInsuranceOperations() {
  const operationIDs = Object.keys(
    ensureContractState().pendingOperationsByID || {},
  );
  if (!durableScheduler) {
    return {
      scheduled: 0,
      pending: operationIDs.length,
    };
  }
  await Promise.all(
    operationIDs.map((operationID) =>
      schedulePendingInsuranceOperation(operationID)),
  );
  return {
    scheduled: operationIDs.length,
    pending: operationIDs.length,
  };
}

async function drainPendingInsuranceOperations() {
  const operationIDs = Object.keys(
    ensureContractState().pendingOperationsByID || {},
  );
  return Promise.all(
    operationIDs.map((operationID) => settlePendingInsuranceOperation(operationID)),
  );
}

function resolveOwnerKind(ownerID, context = {}) {
  const normalizedOwnerID = toPositiveInt(ownerID, 0);
  if (!normalizedOwnerID) {
    return {
      ownerKind: null,
      ownerID: 0,
    };
  }
  if (getCharacterRecord(normalizedOwnerID)) {
    return {
      ownerKind: OWNER_KIND.CHARACTER,
      ownerID: normalizedOwnerID,
    };
  }
  if (getCorporationRecord(normalizedOwnerID)) {
    return {
      ownerKind: OWNER_KIND.CORPORATION,
      ownerID: normalizedOwnerID,
    };
  }
  const ownerCharacterID = toPositiveInt(context.ownerCharacterID, 0);
  if (ownerCharacterID && getCharacterRecord(ownerCharacterID)) {
    return {
      ownerKind: OWNER_KIND.CHARACTER,
      ownerID: ownerCharacterID,
    };
  }
  return {
    ownerKind: OWNER_KIND.CHARACTER,
    ownerID: normalizedOwnerID,
  };
}

function resolveContractRecipientCharacterID(contract, context = {}) {
  return (
    toPositiveInt(contract && contract.insuredByCharacterID, 0) ||
    toPositiveInt(context.pilotCharacterID, 0) ||
    toPositiveInt(context.ownerCharacterID, 0) ||
    (contract && contract.ownerKind === OWNER_KIND.CHARACTER
      ? toPositiveInt(contract.ownerID, 0)
      : 0)
  );
}

function insureShip(session, options = {}) {
  const itemID = toPositiveInt(options.itemID, 0);
  return runSerialized(shipInsuranceLanes, itemID, () =>
    insureShipSerialized(session, options));
}

async function insureShipSerialized(session, options = {}) {
  if (!isInsuranceServiceAvailable(session)) {
    throwWrappedUserError("InsCouldNotFindItem");
  }

  const itemID = toPositiveInt(options.itemID, 0);
  const quotedPremium = Number(options.quotedPremium);
  const isCorpItem = options.isCorpItem === true || Number(options.isCorpItem) === 1;
  const voidOld = options.voidOld === true || Number(options.voidOld) === 1;
  const ship = findShipItemById(itemID);
  if (!ship || !isInsurableShipItem(ship)) {
    throwWrappedUserError("InsCouldNotFindItem");
  }

  const characterID = getSessionCharacterID(session);
  const corporationID = getSessionCorporationID(session);
  const dockContext = getSessionDockContext(session);
  const ownerID = isCorpItem ? corporationID : characterID;
  if (!ownerID || Number(ship.ownerID) !== Number(ownerID)) {
    throwWrappedUserError("InsCouldNotFindItem");
  }
  if (isCorpItem && !hasCorpInsuranceRole(session)) {
    throwWrappedUserError("CrpAccessDenied");
  }
  if (!isShipAtDockableForInsurance(ship, dockContext, ownerID)) {
    throwWrappedUserError("InsCouldNotFindItem");
  }

  const fullInsurancePriceCents = getFullInsurancePriceCents(ship.typeID);
  const packageInfo = resolvePackageFromPremium(fullInsurancePriceCents, quotedPremium);
  if (!packageInfo) {
    throwWrappedUserError("InsCouldNotFindItem");
  }

  const existingContract = getActiveContractForShip(ship.itemID);
  if (existingContract && !voidOld) {
    throwWrappedUserError("InsureShipFailedSingleContract", {
      ownerName: existingContract.ownerID,
    });
  }
  const nowFiletime = currentFileTime().toString();
  const prepareResult = persistStateMutation((state) => {
    const contract = {
      contractID: allocateContractID(state),
      shipID: ship.itemID,
      typeID: ship.typeID,
      ownerID,
      ownerKind: isCorpItem ? OWNER_KIND.CORPORATION : OWNER_KIND.CHARACTER,
      insuredByCharacterID: characterID,
      corpAccountKey: normalizeCorporationWalletKey(
        options.corpAccountKey ||
          session && (session.corpAccountKey || session.accountKey) ||
          ACCOUNT_KEY.CASH,
      ),
      fraction: packageInfo.fraction,
      packageName: packageInfo.name,
      premiumCents: computePremiumCents(fullInsurancePriceCents, packageInfo.fraction),
      payoutCents: computePayoutCents(fullInsurancePriceCents, packageInfo.fraction),
      fullInsurancePriceCents,
      startDate: nowFiletime,
      endDate: addDurationToFiletime(nowFiletime, INSURANCE_DURATION_TICKS),
      issuedAt: nowFiletime,
      status: CONTRACT_STATUS.ACTIVE,
      voidedAt: null,
      voidReason: null,
      paidAt: null,
      lossID: null,
      dockableLocationID: dockContext.dockableLocationID,
      stationID: dockContext.stationID,
      structureID: dockContext.structureID,
    };
    const operationID = `premium:${contract.contractID}`;
    const operation = {
      operationID,
      kind: OPERATION_KIND.PREMIUM,
      commandID: `insurance:${operationID}:debit`,
      preparedAt: nowFiletime,
      replacedContractID: existingContract ? existingContract.contractID : null,
      contract,
    };
    state.pendingOperationsByID[operationID] = operation;
    return operation;
  });
  if (!prepareResult.success) {
    throwWrappedUserError("InsCouldNotFindItem");
  }

  const operation = prepareResult.data;
  const debitResult = await queuePendingInsuranceOperation(operation.operationID);
  if (!debitResult || !debitResult.success) {
    if (debitResult && debitResult.errorMsg === "INSUFFICIENT_FUNDS") {
      const currentBalance = operation.contract.ownerKind === OWNER_KIND.CORPORATION
        ? getCorporationWalletBalance(
          operation.contract.ownerID,
          operation.contract.corpAccountKey,
        )
        : (getCharacterWallet(operation.contract.ownerID) || { balance: 0 }).balance;
      throwNotEnoughMoney(
        centsToIsk(operation.contract.premiumCents),
        currentBalance,
      );
    }
    throwWrappedUserError("InsCouldNotFindItem");
  }

  if (
    debitResult.data &&
    debitResult.data.status === CONTRACT_STATUS.ACTIVE &&
    session &&
    typeof session.sendNotification === "function"
  ) {
    session.sendNotification("OnShipInsured", "clientID", []);
  }
  return null;
}

function notifyVoidedContract(contract, reason, options = {}) {
  if (options.notify === false || !contract) {
    return;
  }
  const receiverID = resolveContractRecipientCharacterID(contract, options);
  if (!receiverID) {
    return;
  }
  if (options.notificationKind === "expiration" || reason === CONTRACT_VOID_REASON.EXPIRED) {
    notifyInsuranceExpiration(receiverID, {
      typeID: contract.typeID,
    });
    return;
  }
  const notificationReason =
    reason === CONTRACT_VOID_REASON.NO_VALUE ||
    reason === CONTRACT_VOID_REASON.REPACKAGED ||
    reason === CONTRACT_VOID_REASON.CONCORD
      ? INSURANCE_INVALID_REASON.NO_VALUE
      : INSURANCE_INVALID_REASON.NOT_OWNED_BY_YOU;
  notifyInsuranceInvalidated(receiverID, notificationReason, {
    typeID: contract.typeID,
  });
}

function voidInsuranceForShip(shipID, reason = CONTRACT_VOID_REASON.MANUAL, options = {}) {
  const state = ensureContractState();
  const contract = activeContractByShipID.get(toPositiveInt(shipID, 0)) || null;
  if (!contract) {
    return {
      success: true,
      changed: false,
    };
  }

  const nowFiletime = toFiletimeString(options.nowFiletime);
  const nextContract = {
    ...contract,
    status: options.status || CONTRACT_STATUS.VOID,
    voidedAt: nowFiletime,
    voidReason: reason,
  };
  delete state.contractsByShipID[String(contract.shipID)];
  state.contractHistoryByID[String(contract.contractID)] = nextContract;
  notifyVoidedContract(nextContract, reason, options);
  const writeResult = persistState();
  return {
    success: Boolean(writeResult && writeResult.success),
    changed: true,
    data: nextContract,
  };
}

function unInsureShip(session, shipID) {
  const contract = getActiveContractForShip(shipID);
  if (!canSessionSeeContract(session, contract)) {
    throwWrappedUserError("InsCouldNotFindItem");
  }
  voidInsuranceForShip(shipID, CONTRACT_VOID_REASON.MANUAL, {
    notify: false,
  });
  return null;
}

function isConcordLossContext(context = {}) {
  const reason = String(
    context.insuranceSuppressedReason ||
      context.suppressedInsuranceReason ||
      "",
  ).trim().toLowerCase();
  if (reason === "concord" || context.isConcordLoss === true) {
    return true;
  }
  const attackerEntity = context.attackerEntity || null;
  const attackerNpcType = String(
    attackerEntity && (attackerEntity.npcEntityType || attackerEntity.entityType) || "",
  ).trim().toLowerCase();
  return attackerNpcType === ENTITY_TYPE.CONCORD;
}

function buildLossID(context, shipID) {
  if (context && context.lossID) {
    return String(context.lossID);
  }
  return `${toPositiveInt(shipID, 0)}:${toFiletimeString(context && context.destroyedAtFiletime)}`;
}

function handleShipDestroyed(context = {}) {
  const shipID = toPositiveInt(context.shipID || context.itemID, 0);
  const typeID = toPositiveInt(context.typeID, 0);
  if (!shipID || !typeID || context.skipInsurance === true) {
    return {
      success: true,
      paid: false,
      skipped: true,
    };
  }

  const nowFiletime = toFiletimeString(context.destroyedAtFiletime);
  const pendingPremium = findPendingPremiumOperationForShip(shipID);
  if (pendingPremium) {
    if (pendingPremium.deferredLossContext) {
      return {
        success: true,
        paid: false,
        pending: true,
        duplicate: true,
      };
    }
    const deferredLossContext = buildDeferredLossContext(
      context,
      shipID,
      typeID,
      nowFiletime,
    );
    const deferResult = persistStateMutation((state) => {
      const currentOperation =
        state.pendingOperationsByID[String(pendingPremium.operationID)];
      if (currentOperation) {
        currentOperation.deferredLossContext = deferredLossContext;
      }
      return currentOperation || null;
    });
    if (!deferResult.success || !deferResult.data) {
      return {
        success: false,
        errorMsg: deferResult.errorMsg || "WRITE_ERROR",
      };
    }
    queuePendingInsuranceOperation(pendingPremium.operationID);
    return {
      success: true,
      paid: false,
      pending: true,
      data: {
        lossID: deferredLossContext.lossID,
      },
    };
  }
  const activeContract = getActiveContractForShip(shipID, {
    nowFiletime,
  });
  if (isConcordLossContext(context)) {
    if (activeContract) {
      voidInsuranceForShip(shipID, CONTRACT_VOID_REASON.CONCORD, {
        notify: true,
        nowFiletime,
      });
    }
    return {
      success: true,
      paid: false,
      skipped: true,
      reason: CONTRACT_VOID_REASON.CONCORD,
    };
  }

  const fullInsurancePriceCents = activeContract
    ? Math.max(0, Math.round(Number(activeContract.fullInsurancePriceCents || 0))) ||
      getFullInsurancePriceCents(typeID)
    : getFullInsurancePriceCents(typeID);
  if (fullInsurancePriceCents <= 0) {
    if (activeContract) {
      voidInsuranceForShip(shipID, CONTRACT_VOID_REASON.NO_VALUE, {
        notify: true,
        nowFiletime,
      });
    }
    return {
      success: true,
      paid: false,
      reason: CONTRACT_VOID_REASON.NO_VALUE,
    };
  }

  const lossID = buildLossID(context, shipID);
  const state = ensureContractState();
  if (state.payoutLedgerByLossID[String(lossID)]) {
    return {
      success: true,
      paid: false,
      duplicate: true,
    };
  }

  const ownerResolution = activeContract
    ? {
        ownerKind: activeContract.ownerKind,
        ownerID: activeContract.ownerID,
      }
    : resolveOwnerKind(context.ownerID, context);
  if (!ownerResolution.ownerKind || !ownerResolution.ownerID) {
    return {
      success: true,
      paid: false,
      reason: "owner_unresolved",
    };
  }

  const fraction = activeContract ? activeContract.fraction : DEFAULT_INSURANCE_FRACTION;
  const payoutCents = activeContract
    ? Math.max(0, Math.round(Number(activeContract.payoutCents || 0))) ||
      computePayoutCents(fullInsurancePriceCents, fraction)
    : computePayoutCents(fullInsurancePriceCents, fraction);
  if (payoutCents <= 0) {
    return {
      success: true,
      paid: false,
      reason: "zero_payout",
    };
  }

  const accountKey =
    activeContract && activeContract.ownerKind === OWNER_KIND.CORPORATION
      ? activeContract.corpAccountKey
      : ACCOUNT_KEY.CASH;
  const recipientCharacterID = activeContract
    ? resolveContractRecipientCharacterID(activeContract, context)
    : ownerResolution.ownerKind === OWNER_KIND.CHARACTER
      ? ownerResolution.ownerID
      : toPositiveInt(context.pilotCharacterID || context.ownerCharacterID, 0);
  const operationID = `payout:${lossID}`;
  const prepareResult = persistStateMutation((nextState) => {
    const operation = {
      operationID,
      kind: OPERATION_KIND.PAYOUT,
      commandID: `insurance:${operationID}:credit`,
      preparedAt: nowFiletime,
      paidAt: nowFiletime,
      lossID,
      shipID,
      typeID,
      ownerID: ownerResolution.ownerID,
      ownerKind: ownerResolution.ownerKind,
      accountKey,
      fraction,
      payoutCents,
      contractID: activeContract ? activeContract.contractID : null,
      recipientCharacterID,
    };
    nextState.payoutLedgerByLossID[String(lossID)] = {
      lossID,
      shipID,
      typeID,
      ownerID: ownerResolution.ownerID,
      ownerKind: ownerResolution.ownerKind,
      fraction,
      payoutCents,
      contractID: activeContract ? activeContract.contractID : null,
      status: "pending",
      preparedAt: nowFiletime,
      paidAt: null,
    };
    nextState.pendingOperationsByID[operationID] = operation;
    return operation;
  });
  if (!prepareResult.success) {
    return {
      success: false,
      errorMsg: "WRITE_ERROR",
    };
  }

  queuePendingInsuranceOperation(operationID);

  return {
    success: true,
    paid: false,
    pending: true,
    data: {
      amount: centsToIsk(payoutCents),
      payoutCents,
      contract: null,
      fraction,
      lossID,
    },
  };
}

function handleInventoryMutation(context = {}) {
  const previousItem = context.previousItem || context.previousData || null;
  const nextItem = context.nextItem || context.item || null;
  const shipID = toPositiveInt(
    previousItem && previousItem.itemID || nextItem && nextItem.itemID,
    0,
  );
  if (!shipID) {
    return {
      success: true,
      changed: false,
    };
  }
  const contract = getActiveContractForShip(shipID);
  const pendingPremium = findPendingPremiumOperationForShip(shipID);
  const coverage = contract || pendingPremium && pendingPremium.contract || null;
  if (!coverage) {
    return {
      success: true,
      changed: false,
    };
  }

  let voidReason = null;
  if (nextItem && normalizeNumber(nextItem.singleton, 1) !== 1) {
    voidReason = CONTRACT_VOID_REASON.REPACKAGED;
  } else if (
    previousItem &&
    nextItem &&
    Number(previousItem.ownerID) !== Number(nextItem.ownerID)
  ) {
    voidReason = CONTRACT_VOID_REASON.OWNER_CHANGED;
  } else if (
    coverage.ownerKind === OWNER_KIND.CHARACTER &&
    nextItem &&
    isCorpOfficeLocation(nextItem.ownerID, nextItem.locationID)
  ) {
    voidReason = CONTRACT_VOID_REASON.CORP_HANGAR;
  }
  if (!voidReason) {
    return {
      success: true,
      changed: false,
    };
  }

  const activeResult = contract
    ? voidInsuranceForShip(shipID, voidReason, { notify: true })
    : { success: true, changed: false };
  const pendingResult = pendingPremium
    ? persistStateMutation((state) => {
      const operation =
        state.pendingOperationsByID[String(pendingPremium.operationID)];
      if (operation) {
        operation.voidReason = voidReason;
        operation.voidedAt = currentFileTime().toString();
      }
      return operation || null;
    })
    : { success: true, data: null };
  return {
    success: Boolean(activeResult.success && pendingResult.success),
    changed: Boolean(activeResult.changed || pendingResult.data),
  };
}

function handleShipRepackaged(shipID, context = {}) {
  const activeResult = voidInsuranceForShip(shipID, CONTRACT_VOID_REASON.REPACKAGED, {
    notify: true,
    ...context,
  });
  const pendingPremium = findPendingPremiumOperationForShip(shipID);
  const pendingResult = pendingPremium
    ? persistStateMutation((state) => {
      const operation =
        state.pendingOperationsByID[String(pendingPremium.operationID)];
      if (operation) {
        operation.voidReason = CONTRACT_VOID_REASON.REPACKAGED;
        operation.voidedAt = currentFileTime().toString();
      }
      return operation || null;
    })
    : { success: true, data: null };
  return {
    success: Boolean(activeResult.success && pendingResult.success),
    changed: Boolean(activeResult.changed || pendingResult.data),
    data: activeResult.data || null,
  };
}

module.exports = {
  INSURANCE_CONTRACTS_TABLE,
  DURABLE_SETTLEMENT_JOB_TYPE,
  OWNER_KIND,
  CONTRACT_STATUS,
  CONTRACT_VOID_REASON,
  BASE_INSURANCE_FRACTION,
  buildClientContract,
  buildClientItemKeyVal,
  centsToIsk,
  getActiveContractForShip,
  getContractForShip,
  getFullInsurancePrice,
  getInsurancePrices,
  handleInventoryMutation,
  handleDurableInsuranceSettlement,
  handleShipDestroyed,
  handleShipRepackaged,
  insureShip,
  isInsuranceServiceAvailable,
  listContracts,
  listItemsToInsure,
  bindDurableScheduler,
  reconcileDurableInsuranceOperations,
  resetInsuranceRuntimeCacheForTests,
  unbindDurableScheduler,
  unInsureShip,
  voidInsuranceForShip,
  _testing: {
    ensureContractState,
    drainPendingInsuranceOperations,
    expireContractsForOwner,
    hasCorpInsuranceRole,
    resolveOwnerKind,
    settlePendingInsuranceOperation,
  },
};
