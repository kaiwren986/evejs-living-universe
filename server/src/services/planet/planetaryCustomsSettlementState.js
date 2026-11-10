"use strict";

const {
  cloneValue,
} = require("../../common/clone");

const path = require("path");

const database = require(path.join(__dirname, "../../gameStore"));
const log = require(path.join(__dirname, "../../utils/logger"));
const {
  adjustCharacterBalanceAsync,
} = require(path.join(__dirname, "../account/walletState"));
const itemStore = require(path.join(__dirname, "../inventory/itemStore"));
const {
  custodyStepCommitted,
  reportSettlementRetry,
  reportUnresolvedLeg,
  resolveCustodyResultItem,
} = require(path.join(__dirname, "../_shared/settlementCustodyRecovery"));
const planetaryCustomsItemCustody = require(path.join(
  __dirname,
  "../inventory/planetaryCustomsItemCustody",
));
const sessionRegistry = require(path.join(__dirname, "../chat/sessionRegistry"));
const {
  emitItemsChangedBatchForSession,
} = require(path.join(__dirname, "../character/characterState"));
const planetRuntimeStore = require("./planetRuntimeStore");
const {
  advanceSettlementSequenceWatermark,
  registerSettlementSequenceDomain,
} = require(path.join(__dirname, "../_shared/settlementSequenceWatermark"));

const TABLE_NAME = "planetaryCustomsSettlements";
const ROOT_VERSION = 1;
const ESCROW_LOCATION_BASE = 9_600_000_000;
const DURABLE_SETTLEMENT_JOB_TYPE = "planet.customs-settle";
const DURABLE_SETTLEMENT_JOB_PREFIX = "planet-customs:";
const DEFINITIVE_WALLET_ERRORS = new Set([
  "CHARACTER_NOT_FOUND",
  "INSUFFICIENT_FUNDS",
  "INVALID_AMOUNT",
]);
const settlementLanes = new Map();
let durableScheduler = null;

function toPositiveInt(value, fallback = 0) {
  const numeric = Math.trunc(Number(value) || 0);
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : fallback;
}

function toFlag(value, fallback = 0) {
  const numeric = Math.trunc(Number(value));
  return Number.isInteger(numeric) && numeric >= 0 ? numeric : fallback;
}

function roundMoney(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function normalizeCommodities(value) {
  return Object.fromEntries(
    Object.entries(value && typeof value === "object" ? value : {})
      .map(([rawTypeID, rawQuantity]) => [
        toPositiveInt(rawTypeID, 0),
        toPositiveInt(rawQuantity, 0),
      ])
      .filter(([typeID, quantity]) => typeID && quantity)
      .sort(([left], [right]) => left - right)
      .map(([typeID, quantity]) => [String(typeID), quantity]),
  );
}

function buildImportManifest(importInputs) {
  const manifest = {};
  for (const entry of importInputs) {
    const typeID = toPositiveInt(entry && entry.typeID, 0);
    const quantity = toPositiveInt(entry && entry.quantity, 0);
    if (typeID && quantity) {
      manifest[String(typeID)] = (manifest[String(typeID)] || 0) + quantity;
    }
  }
  return normalizeCommodities(manifest);
}

function readRoot() {
  database.ensureTable(TABLE_NAME);
  const result = database.read(TABLE_NAME, "/");
  const root = result && result.success && result.data &&
    typeof result.data === "object"
    ? result.data
    : {};
  return {
    version: ROOT_VERSION,
    nextOperationID: toPositiveInt(root.nextOperationID, 1),
    // Detached: gameStore.read returns the live cache object, and writeRoot's
    // change detection compares against that same object. Mutating it in place
    // makes every write look unchanged, so the table stays right in memory and
    // never reaches disk.
    byCharacter:
      root.byCharacter && typeof root.byCharacter === "object"
        ? cloneValue(root.byCharacter)
        : {},
  };
}

function writeRoot(root) {
  database.ensureTable(TABLE_NAME);
  const result = database.write(TABLE_NAME, "/", {
    version: ROOT_VERSION,
    nextOperationID: toPositiveInt(root.nextOperationID, 1),
    byCharacter: cloneValue(root.byCharacter || {}),
  });
  if (!result || result.success !== true) {
    return result || { success: false, errorMsg: "WRITE_ERROR" };
  }
  const flushResult = database.flushTableSync(TABLE_NAME);
  return flushResult && flushResult.success
    ? result
    : flushResult || { success: false, errorMsg: "FLUSH_ERROR" };
}

function getPendingPlanetaryCustomsSettlement(characterID) {
  const key = String(toPositiveInt(characterID, 0));
  return cloneValue(readRoot().byCharacter[key] || null);
}

function listPendingPlanetaryCustomsSettlements() {
  return Object.values(readRoot().byCharacter)
    .filter(Boolean)
    .map(cloneValue)
    .sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)));
}

function updateSettlement(characterID, updater) {
  const root = readRoot();
  const key = String(toPositiveInt(characterID, 0));
  const current = root.byCharacter[key];
  if (!current) {
    return { success: false, errorMsg: "PLANET_CUSTOMS_SETTLEMENT_NOT_FOUND" };
  }
  const next = typeof updater === "function"
    ? updater(cloneValue(current))
    : current;
  if (next === null) {
    delete root.byCharacter[key];
  } else {
    root.byCharacter[key] = cloneValue(next);
  }
  const result = writeRoot(root);
  return result && result.success
    ? { success: true, data: cloneValue(next) }
    : result || { success: false, errorMsg: "PLANET_CUSTOMS_SETTLEMENT_WRITE_FAILED" };
}

function buildSettlementJob(characterID) {
  const normalizedCharacterID = toPositiveInt(characterID, 0);
  return normalizedCharacterID
    ? {
        jobID: `${DURABLE_SETTLEMENT_JOB_PREFIX}${normalizedCharacterID}`,
        type: DURABLE_SETTLEMENT_JOB_TYPE,
        dueAtMs: Date.now(),
        payload: { characterID: normalizedCharacterID },
      }
    : null;
}

async function scheduleSettlement(characterID) {
  const job = buildSettlementJob(characterID);
  if (!job || !durableScheduler) {
    return null;
  }
  await durableScheduler.schedule(job);
  return job;
}

function queueSettlement(characterID) {
  if (!durableScheduler) {
    return;
  }
  void scheduleSettlement(characterID).catch((error) => {
    log.warn(
      `[PlanetaryCustomsSettlement] scheduling failed char=${characterID}: ${error.message}`,
    );
  });
}

function normalizeImportLeg(input, index, operationID) {
  return {
    legID: index + 1,
    itemID: toPositiveInt(input && input.itemID, 0),
    typeID: toPositiveInt(input && input.typeID, 0),
    quantity: toPositiveInt(input && input.quantity, 0),
    ownerID: toPositiveInt(input && input.ownerID, 0),
    sourceLocationID: toPositiveInt(input && input.locationID, 0),
    sourceFlagID: toFlag(input && input.flagID, 0),
    stageKey: `${DURABLE_SETTLEMENT_JOB_PREFIX}${operationID}:import:${index + 1}:stage`,
    returnKey: `${DURABLE_SETTLEMENT_JOB_PREFIX}${operationID}:import:${index + 1}:return`,
    commitKey: `${DURABLE_SETTLEMENT_JOB_PREFIX}${operationID}:import:${index + 1}:commit`,
    staged: false,
    returned: false,
    committed: false,
    commitError: null,
    escrowItemID: 0,
  };
}

function normalizeExportLeg(output, index, operationID, target) {
  return {
    legID: index + 1,
    typeID: toPositiveInt(output && output.typeID, 0),
    quantity: toPositiveInt(output && output.quantity, 0),
    ownerID: target.ownerID,
    destinationLocationID: target.locationID,
    destinationFlagID: target.flagID,
    grantKey: `${DURABLE_SETTLEMENT_JOB_PREFIX}${operationID}:export:${index + 1}:grant`,
    deliverKey: `${DURABLE_SETTLEMENT_JOB_PREFIX}${operationID}:export:${index + 1}:deliver`,
    revokeKey: `${DURABLE_SETTLEMENT_JOB_PREFIX}${operationID}:export:${index + 1}:revoke`,
    granted: false,
    delivered: false,
    revoked: false,
    escrowItemID: 0,
  };
}

function splitExportLegs(exportCommodities) {
  const stackLimit = toPositiveInt(
    itemStore.CLIENT_INVENTORY_STACK_LIMIT,
    2_147_483_647,
  );
  const result = [];
  for (const [rawTypeID, rawQuantity] of Object.entries(exportCommodities || {})) {
    const typeID = toPositiveInt(rawTypeID, 0);
    let remaining = toPositiveInt(rawQuantity, 0);
    while (typeID && remaining > 0) {
      const quantity = Math.min(remaining, stackLimit);
      result.push({ typeID, quantity });
      remaining -= quantity;
    }
  }
  return result;
}

// The tax's second party is the corporation that owns the customs office, never the office: the client primes both
// owner columns with cfg.eveowners and names them as sender and receiver (transactionsPanel.py 131 to 134, 198 to
// 201), and the transaction row carries ownerID2 as an int32, which an office's item ID overflows. A settlement
// prepared before the owner was kept reads it from the office.
function resolveCustomsTaxOwnerID(settlement) {
  const kept = toPositiveInt(settlement && settlement.customsOfficeOwnerID, 0);
  if (kept) {
    return kept;
  }
  return toPositiveInt(
    require("./planetOrbitalState").peekOrbitalOwnerID(settlement && settlement.customsOfficeID),
    0,
  );
}

function buildWalletLegs(operationID, importTax, exportTax, planetID) {
  const legs = [];
  const normalizedImportTax = roundMoney(importTax);
  const normalizedExportTax = roundMoney(exportTax);
  if (normalizedImportTax > 0) {
    legs.push({
      amount: normalizedImportTax,
      entryTypeID: 96,
      referenceID: planetID,
      description: "Planetary import tax",
    });
  }
  if (normalizedExportTax > 0) {
    const first = roundMoney(normalizedExportTax / 2);
    const second = roundMoney(normalizedExportTax - first);
    for (const amount of [first, second]) {
      if (amount > 0) {
        legs.push({
          amount,
          entryTypeID: 97,
          referenceID: planetID,
          description: "Planetary export tax",
        });
      }
    }
  }
  return legs.map((leg, index) => ({
    ...leg,
    legID: index + 1,
    debitCommandID: `${DURABLE_SETTLEMENT_JOB_PREFIX}${operationID}:tax:${index + 1}:debit`,
    refundCommandID: `${DURABLE_SETTLEMENT_JOB_PREFIX}${operationID}:tax:${index + 1}:refund`,
    applied: false,
    refunded: false,
    result: null,
  }));
}

function preparePlanetaryCustomsSettlement(options = {}) {
  const characterID = toPositiveInt(options.characterID, 0);
  const planetID = toPositiveInt(options.planetID, 0);
  const spaceportPinID = toPositiveInt(options.spaceportPinID, 0);
  const customsOfficeID = toPositiveInt(options.customsOfficeID, 0);
  const importInputs = (Array.isArray(options.importInputs) ? options.importInputs : [])
    .map((entry) => ({
      itemID: toPositiveInt(entry && entry.itemID, 0),
      typeID: toPositiveInt(entry && entry.typeID, 0),
      quantity: toPositiveInt(entry && entry.quantity, 0),
      ownerID: toPositiveInt(entry && entry.ownerID, characterID),
      locationID: toPositiveInt(entry && entry.locationID, customsOfficeID),
      flagID: toFlag(entry && entry.flagID, itemStore.ITEM_FLAGS.HANGAR),
    }));
  const importCommodities = normalizeCommodities(options.importCommodities);
  const exportCommodities = normalizeCommodities(options.exportCommodities);
  if (!characterID || !planetID || !spaceportPinID || !customsOfficeID) {
    return { success: false, errorMsg: "INVALID_PLANET_CUSTOMS_SETTLEMENT" };
  }
  if (
    new Set(importInputs.map((entry) => entry.itemID)).size !== importInputs.length ||
    importInputs.some((entry) =>
      !entry.itemID ||
      !entry.typeID ||
      !entry.quantity ||
      entry.ownerID !== characterID ||
      entry.locationID !== customsOfficeID ||
      entry.flagID !== itemStore.ITEM_FLAGS.HANGAR) ||
    JSON.stringify(buildImportManifest(importInputs)) !== JSON.stringify(importCommodities)
  ) {
    return { success: false, errorMsg: "INVALID_PLANET_CUSTOMS_IMPORT_MANIFEST" };
  }
  const requestFingerprint = JSON.stringify({
    characterID,
    planetID,
    spaceportPinID,
    customsOfficeID,
    importInputs,
    importCommodities,
    exportCommodities,
    importTax: roundMoney(options.importTax),
    exportTax: roundMoney(options.exportTax),
    taxRate: Number(options.taxRate) || 0,
  });
  const root = readRoot();
  const key = String(characterID);
  const existing = root.byCharacter[key];
  if (existing) {
    if (existing.requestFingerprint !== requestFingerprint) {
      return { success: false, errorMsg: "PLANET_CUSTOMS_ALREADY_PENDING" };
    }
    queueSettlement(characterID);
    return { success: true, duplicate: true, data: cloneValue(existing) };
  }

  const operationSequence = root.nextOperationID;
  const operationID = `${characterID}:${operationSequence}`;
  const importEscrowLocationID = ESCROW_LOCATION_BASE + (operationSequence * 2);
  const exportEscrowLocationID = importEscrowLocationID + 1;
  const target = {
    ownerID: characterID,
    locationID: customsOfficeID,
    flagID: itemStore.ITEM_FLAGS.HANGAR,
  };
  const importLegs = importInputs.map((entry, index) =>
    normalizeImportLeg(entry, index, operationID));
  const exportLegs = splitExportLegs(exportCommodities).map((entry, index) =>
    normalizeExportLeg(entry, index, operationID, target));
  if (
    importLegs.some((leg) =>
      !leg.itemID ||
      !leg.typeID ||
      !leg.quantity ||
      !leg.ownerID ||
      !leg.sourceLocationID) ||
    exportLegs.some((leg) => !leg.typeID || !leg.quantity)
  ) {
    return { success: false, errorMsg: "INVALID_PLANET_CUSTOMS_LEG" };
  }
  const settlement = {
    operationID,
    operationSequence,
    requestFingerprint,
    characterID,
    planetID,
    spaceportPinID,
    customsOfficeID,
    customsOfficeOwnerID: toPositiveInt(options.customsOfficeOwnerID, 0),
    importEscrowLocationID,
    exportEscrowLocationID,
    importCommodities,
    exportCommodities,
    importLegs,
    exportLegs,
    walletLegs: buildWalletLegs(
      operationID,
      options.importTax,
      options.exportTax,
      planetID,
    ),
    planetCommandID: `${DURABLE_SETTLEMENT_JOB_PREFIX}${operationID}:planet-apply`,
    planetApplied: false,
    planetResult: null,
    rejectionError: null,
    importChanges: [],
    exportChanges: [],
    createdAt: new Date().toISOString(),
  };
  root.nextOperationID = operationSequence + 1;
  root.byCharacter[key] = settlement;
  const result = writeRoot(root);
  if (!result || result.success !== true) {
    return result || { success: false, errorMsg: "PLANET_CUSTOMS_SETTLEMENT_WRITE_FAILED" };
  }
  queueSettlement(characterID);
  return { success: true, duplicate: false, data: cloneValue(settlement) };
}

function runSerialized(characterID, operation) {
  const laneKey = String(toPositiveInt(characterID, 0));
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
  if (result.durable !== true) {
    return { success: false, ambiguous: true, errorMsg: "ITEM_CUSTODY_NOT_DURABLE" };
  }
  return null;
}

function getResultItem(result) {
  const resolved = resolveCustodyResultItem(result);
  if (resolved) {
    return resolved;
  }
  const changes = getCustodyChanges(result);
  return changes.map((change) => change && change.item).find(Boolean) || null;
}

function getCustodyChanges(result) {
  const data = result && result.data;
  if (!data) {
    return [];
  }
  if (Array.isArray(data.changes) && data.changes.length > 0) {
    return data.changes;
  }
  return Array.isArray(data.committedChanges) ? data.committedChanges : [];
}

function getImportEscrowLocationID(settlement) {
  return toPositiveInt(
    settlement && settlement.importEscrowLocationID,
    toPositiveInt(settlement && settlement.escrowLocationID, 0),
  );
}

function getExportEscrowLocationID(settlement) {
  return toPositiveInt(
    settlement && settlement.exportEscrowLocationID,
    toPositiveInt(settlement && settlement.escrowLocationID, 0),
  );
}

function findEscrowItem(settlement, leg, kind) {
  const candidates = itemStore.listContainerItems(
    toPositiveInt(leg && leg.ownerID, 0),
    kind === "import"
      ? getImportEscrowLocationID(settlement)
      : getExportEscrowLocationID(settlement),
    0,
  ).filter((item) =>
    toPositiveInt(item && item.typeID, 0) === toPositiveInt(leg && leg.typeID, 0));
  const assigned = new Set([
    ...settlement.importLegs
      .filter((entry) => kind !== "import" || entry.legID !== leg.legID)
      .map((entry) => toPositiveInt(entry.escrowItemID, 0)),
    ...settlement.exportLegs
      .filter((entry) => kind !== "export" || entry.legID !== leg.legID)
      .map((entry) => toPositiveInt(entry.escrowItemID, 0)),
  ].filter(Boolean));
  return candidates
    .filter((item) => !assigned.has(toPositiveInt(item.itemID, 0)))
    .sort((left, right) => Number(left.itemID) - Number(right.itemID))[0] || null;
}

function buildImportClientChanges(changes, settlement, leg) {
  const result = [];
  for (const change of Array.isArray(changes) ? changes : []) {
    const item = change && change.item;
    const previousData = change && (change.previousData || change.previousState);
    const isEscrowDestination = Boolean(
      item &&
        toPositiveInt(item.locationID, 0) === getImportEscrowLocationID(settlement) &&
        toFlag(item.flagID, 0) === 0
    );
    if (!isEscrowDestination) {
      result.push(cloneValue(change));
      continue;
    }
    if (
      previousData &&
      toPositiveInt(previousData.itemID, 0) === leg.itemID &&
      toPositiveInt(item.itemID, 0) === leg.itemID
    ) {
      result.push({ removed: true, previousData: cloneValue(previousData),
        item: itemStore.buildRemovedItemNotificationState(previousData) });
    }
  }
  return result;
}

function buildExportClientChanges(changes, settlement) {
  return (Array.isArray(changes) ? changes : [])
    .filter((change) => change && change.item &&
      toPositiveInt(change.item.locationID, 0) === settlement.customsOfficeID)
    .map((change) => ({
      ...cloneValue(change),
      previousData: {
        ...cloneValue(change.previousData || change.previousState || {}),
        locationID: settlement.spaceportPinID,
      },
    }));
}

async function compensateRejectedSettlement(characterID) {
  let settlement = getPendingPlanetaryCustomsSettlement(characterID);
  if (!settlement) {
    return { success: true, alreadySettled: true };
  }
  if (settlement.planetApplied) {
    return { success: false, errorMsg: "PLANET_CUSTOMS_ALREADY_APPLIED" };
  }

  for (const candidate of [...settlement.exportLegs].reverse()) {
    settlement = getPendingPlanetaryCustomsSettlement(characterID);
    const leg = settlement && settlement.exportLegs.find(
      (entry) => entry.legID === candidate.legID,
    );
    if (!settlement || !leg || !leg.granted || leg.revoked || leg.delivered) {
      continue;
    }
    const result = planetaryCustomsItemCustody.revokeExport({
      actorID: settlement.characterID,
      ownerID: leg.ownerID,
      itemID: leg.escrowItemID,
      quantity: leg.quantity,
      escrowLocationID: getExportEscrowLocationID(settlement),
      idempotencyKey: leg.revokeKey,
    });
    const failure = durableCustodyFailure(result, "PLANET_CUSTOMS_EXPORT_REVOKE_FAILED");
    if (failure) {
      return failure;
    }
    const checkpoint = updateSettlement(characterID, (current) => ({
      ...current,
      exportLegs: current.exportLegs.map((entry) =>
        entry.legID === leg.legID ? { ...entry, revoked: true } : entry),
    }));
    if (!checkpoint.success) {
      return checkpoint;
    }
  }

  settlement = getPendingPlanetaryCustomsSettlement(characterID);
  for (const candidate of [...settlement.importLegs].reverse()) {
    settlement = getPendingPlanetaryCustomsSettlement(characterID);
    const leg = settlement && settlement.importLegs.find(
      (entry) => entry.legID === candidate.legID,
    );
    if (!settlement || !leg || !leg.staged || leg.returned || leg.committed) {
      continue;
    }
    const result = planetaryCustomsItemCustody.returnImport({
      actorID: settlement.characterID,
      ownerID: leg.ownerID,
      itemID: leg.escrowItemID,
      quantity: leg.quantity,
      escrowLocationID: getImportEscrowLocationID(settlement),
      destinationLocationID: leg.sourceLocationID,
      destinationFlagID: leg.sourceFlagID,
      idempotencyKey: leg.returnKey,
    });
    const failure = durableCustodyFailure(result, "PLANET_CUSTOMS_IMPORT_RETURN_FAILED");
    if (failure) {
      return failure;
    }
    const checkpoint = updateSettlement(characterID, (current) => ({
      ...current,
      importLegs: current.importLegs.map((entry) =>
        entry.legID === leg.legID ? { ...entry, returned: true } : entry),
    }));
    if (!checkpoint.success) {
      return checkpoint;
    }
  }

  settlement = getPendingPlanetaryCustomsSettlement(characterID);
  for (const candidate of [...settlement.walletLegs].reverse()) {
    settlement = getPendingPlanetaryCustomsSettlement(characterID);
    const leg = settlement && settlement.walletLegs.find(
      (entry) => entry.legID === candidate.legID,
    );
    if (!settlement || !leg || !leg.applied || leg.refunded) {
      continue;
    }
    const result = await adjustCharacterBalanceAsync(
      settlement.characterID,
      leg.amount,
      {
        idempotencyKey: leg.refundCommandID,
        entryTypeID: leg.entryTypeID,
        referenceID: leg.referenceID,
        ownerID1: settlement.characterID,
        ownerID2: resolveCustomsTaxOwnerID(settlement),
        description: "Planetary import/export tax refund",
      },
      {
        commandID: leg.refundCommandID,
        source: "planet-customs-tax-refund",
      },
    );
    if (!result || result.success !== true) {
      return result || { success: false, errorMsg: "PLANET_CUSTOMS_REFUND_FAILED" };
    }
    const checkpoint = updateSettlement(characterID, (current) => ({
      ...current,
      walletLegs: current.walletLegs.map((entry) =>
        entry.legID === leg.legID ? { ...entry, refunded: true } : entry),
    }));
    if (!checkpoint.success) {
      return checkpoint;
    }
  }

  settlement = getPendingPlanetaryCustomsSettlement(characterID);
  const errorMsg = settlement && settlement.rejectionError || "PLANET_CUSTOMS_REJECTED";
  const removed = updateSettlement(characterID, () => null);
  return removed.success
    ? { success: true, rejected: true, errorMsg }
    : removed;
}

async function rejectSettlement(characterID, errorMsg) {
  const checkpoint = updateSettlement(characterID, (current) => ({
    ...current,
    rejectionError: current.rejectionError || errorMsg,
  }));
  if (!checkpoint.success) {
    return checkpoint;
  }
  return compensateRejectedSettlement(characterID);
}

function emitCompletion(settlement, completion, options = {}) {
  if (options.notify === false) {
    return;
  }
  const sessions = new Set();
  if (options.preferredSession) {
    sessions.add(options.preferredSession);
  }
  for (const session of sessionRegistry.getSessions()) {
    if (toPositiveInt(session && session.characterID, 0) === settlement.characterID) {
      sessions.add(session);
    }
  }
  for (const session of sessions) {
    if (typeof session.sendNotification === "function") {
      session.sendNotification(
        "OnMajorPlanetStateUpdate",
        "charid",
        [settlement.planetID],
      );
      session.sendNotification(
        "OnRefreshPins",
        "clientID",
        [[settlement.spaceportPinID]],
      );
    }
    emitItemsChangedBatchForSession(
      session,
      [...completion.importChanges, ...completion.exportChanges],
    );
  }
}

function buildCompletionResult(settlement) {
  return {
    operationID: settlement.operationID,
    planetID: settlement.planetID,
    spaceportPinID: settlement.spaceportPinID,
    customsOfficeID: settlement.customsOfficeID,
    importChanges: cloneValue(settlement.importChanges || []),
    exportChanges: cloneValue(settlement.exportChanges || []),
    planetResult: cloneValue(settlement.planetResult || null),
  };
}

async function settlePlanetaryCustomsInternal(characterID, options = {}) {
  let settlement = getPendingPlanetaryCustomsSettlement(characterID);
  if (!settlement) {
    return { success: true, alreadySettled: true, data: null };
  }
  if (settlement.rejectionError) {
    return compensateRejectedSettlement(characterID);
  }

  for (const candidate of settlement.walletLegs) {
    settlement = getPendingPlanetaryCustomsSettlement(characterID);
    const leg = settlement && settlement.walletLegs.find(
      (entry) => entry.legID === candidate.legID,
    );
    if (!settlement || !leg || leg.applied) {
      continue;
    }
    const result = await adjustCharacterBalanceAsync(
      settlement.characterID,
      -leg.amount,
      {
        idempotencyKey: leg.debitCommandID,
        entryTypeID: leg.entryTypeID,
        referenceID: leg.referenceID,
        ownerID1: settlement.characterID,
        ownerID2: resolveCustomsTaxOwnerID(settlement),
        description: leg.description,
      },
      {
        commandID: leg.debitCommandID,
        source: "planet-customs-tax-debit",
      },
    );
    if (!result || result.success !== true) {
      const errorMsg = result && result.errorMsg || "PLANET_CUSTOMS_DEBIT_FAILED";
      return DEFINITIVE_WALLET_ERRORS.has(errorMsg)
        ? rejectSettlement(characterID, errorMsg)
        : result || { success: false, errorMsg };
    }
    const checkpoint = updateSettlement(characterID, (current) => ({
      ...current,
      walletLegs: current.walletLegs.map((entry) =>
        entry.legID === leg.legID
          ? { ...entry, applied: true, result: cloneValue(result) }
          : entry),
    }));
    if (!checkpoint.success) {
      return checkpoint;
    }
  }

  settlement = getPendingPlanetaryCustomsSettlement(characterID);
  for (const candidate of settlement.importLegs) {
    settlement = getPendingPlanetaryCustomsSettlement(characterID);
    const leg = settlement && settlement.importLegs.find(
      (entry) => entry.legID === candidate.legID,
    );
    if (!settlement || !leg || leg.staged) {
      continue;
    }
    const result = planetaryCustomsItemCustody.stageImport({
      actorID: settlement.characterID,
      ownerID: leg.ownerID,
      itemID: leg.itemID,
      quantity: leg.quantity,
      sourceLocationID: leg.sourceLocationID,
      sourceFlagID: leg.sourceFlagID,
      escrowLocationID: getImportEscrowLocationID(settlement),
      idempotencyKey: leg.stageKey,
    });
    const failure = durableCustodyFailure(result, "PLANET_CUSTOMS_IMPORT_STAGE_FAILED");
    if (failure) {
      return failure.ambiguous === true
        ? failure
        : rejectSettlement(characterID, "CannotImportCommoditiesNotFound");
    }
    const movedItem = getResultItem(result) || findEscrowItem(settlement, leg, "import");
    if (!movedItem) {
      // A staged row that is no longer in escrow, whose commit already ran, is a
      // finished leg with a lost checkpoint — not work to retry.
      if (custodyStepCommitted(leg.commitKey)) {
        const recovered = updateSettlement(characterID, (current) => ({
          ...current,
          importLegs: current.importLegs.map((entry) =>
            entry.legID === leg.legID
              ? { ...entry, staged: true, committed: true }
              : entry),
        }));
        if (!recovered.success) {
          return recovered;
        }
        continue;
      }
      reportUnresolvedLeg({
        scope: "PlanetaryCustomsSettlement",
        operationID: settlement.operationID,
        step: "import-stage",
        legID: leg.legID,
        errorMsg: "PLANET_CUSTOMS_IMPORT_ESCROW_UNKNOWN",
      });
      return { success: false, ambiguous: true, errorMsg: "PLANET_CUSTOMS_IMPORT_ESCROW_UNKNOWN" };
    }
    const checkpoint = updateSettlement(characterID, (current) => ({
      ...current,
      importLegs: current.importLegs.map((entry) =>
        entry.legID === leg.legID
          ? { ...entry, staged: true, escrowItemID: toPositiveInt(movedItem.itemID, 0) }
          : entry),
      importChanges: [
        ...(current.importChanges || []),
        ...buildImportClientChanges(
          getCustodyChanges(result),
          settlement,
          leg,
        ),
      ],
    }));
    if (!checkpoint.success) {
      return checkpoint;
    }
  }

  settlement = getPendingPlanetaryCustomsSettlement(characterID);
  for (const candidate of settlement.exportLegs) {
    settlement = getPendingPlanetaryCustomsSettlement(characterID);
    const leg = settlement && settlement.exportLegs.find(
      (entry) => entry.legID === candidate.legID,
    );
    if (!settlement || !leg || leg.granted) {
      continue;
    }
    const result = planetaryCustomsItemCustody.grantExport({
      actorID: settlement.characterID,
      ownerID: leg.ownerID,
      typeID: leg.typeID,
      quantity: leg.quantity,
      escrowLocationID: getExportEscrowLocationID(settlement),
      idempotencyKey: leg.grantKey,
    });
    const failure = durableCustodyFailure(result, "PLANET_CUSTOMS_EXPORT_GRANT_FAILED");
    if (failure) {
      return failure.ambiguous === true
        ? failure
        : rejectSettlement(characterID, "CannotExportCommodities");
    }
    const grantedItem = getResultItem(result) || findEscrowItem(settlement, leg, "export");
    if (!grantedItem) {
      if (custodyStepCommitted(leg.deliverKey)) {
        const recovered = updateSettlement(characterID, (current) => ({
          ...current,
          exportLegs: current.exportLegs.map((entry) =>
            entry.legID === leg.legID
              ? { ...entry, granted: true, delivered: true }
              : entry),
        }));
        if (!recovered.success) {
          return recovered;
        }
        continue;
      }
      reportUnresolvedLeg({
        scope: "PlanetaryCustomsSettlement",
        operationID: settlement.operationID,
        step: "export-grant",
        legID: leg.legID,
        errorMsg: "PLANET_CUSTOMS_EXPORT_ESCROW_UNKNOWN",
      });
      return { success: false, ambiguous: true, errorMsg: "PLANET_CUSTOMS_EXPORT_ESCROW_UNKNOWN" };
    }
    const checkpoint = updateSettlement(characterID, (current) => ({
      ...current,
      exportLegs: current.exportLegs.map((entry) =>
        entry.legID === leg.legID
          ? { ...entry, granted: true, escrowItemID: toPositiveInt(grantedItem.itemID, 0) }
          : entry),
    }));
    if (!checkpoint.success) {
      return checkpoint;
    }
  }

  settlement = getPendingPlanetaryCustomsSettlement(characterID);
  if (!settlement.planetApplied) {
    const result = planetRuntimeStore.applySpaceportImportExport({
      planetID: settlement.planetID,
      ownerID: settlement.characterID,
      spaceportPinID: settlement.spaceportPinID,
      importCommodities: settlement.importCommodities,
      exportCommodities: settlement.exportCommodities,
      idempotencyKey: settlement.planetCommandID,
    });
    if (!result || result.success !== true) {
      if (result && result.ambiguous === true) {
        return result;
      }
      return rejectSettlement(
        characterID,
        result && result.errorMsg || "PLANET_CUSTOMS_APPLY_FAILED",
      );
    }
    const checkpoint = updateSettlement(characterID, (current) => ({
      ...current,
      planetApplied: true,
      planetResult: cloneValue(result.data || result),
    }));
    if (!checkpoint.success) {
      return checkpoint;
    }
  }

  settlement = getPendingPlanetaryCustomsSettlement(characterID);
  for (const candidate of settlement.exportLegs) {
    settlement = getPendingPlanetaryCustomsSettlement(characterID);
    const leg = settlement && settlement.exportLegs.find(
      (entry) => entry.legID === candidate.legID,
    );
    if (!settlement || !leg || leg.delivered) {
      continue;
    }
    const result = planetaryCustomsItemCustody.deliverExport({
      actorID: settlement.characterID,
      ownerID: leg.ownerID,
      itemID: leg.escrowItemID,
      quantity: leg.quantity,
      escrowLocationID: getExportEscrowLocationID(settlement),
      destinationLocationID: leg.destinationLocationID,
      destinationFlagID: leg.destinationFlagID,
      idempotencyKey: leg.deliverKey,
    });
    const failure = durableCustodyFailure(result, "PLANET_CUSTOMS_EXPORT_DELIVERY_FAILED");
    if (failure) {
      return failure;
    }
    const checkpoint = updateSettlement(characterID, (current) => ({
      ...current,
      exportLegs: current.exportLegs.map((entry) =>
        entry.legID === leg.legID ? { ...entry, delivered: true } : entry),
      exportChanges: [
        ...(current.exportChanges || []),
        ...buildExportClientChanges(getCustodyChanges(result), settlement),
      ],
    }));
    if (!checkpoint.success) {
      return checkpoint;
    }
  }

  settlement = getPendingPlanetaryCustomsSettlement(characterID);
  for (const candidate of settlement.importLegs) {
    settlement = getPendingPlanetaryCustomsSettlement(characterID);
    const leg = settlement && settlement.importLegs.find(
      (entry) => entry.legID === candidate.legID,
    );
    if (!settlement || !leg || leg.committed) {
      continue;
    }
    const result = planetaryCustomsItemCustody.commitImport({
      actorID: settlement.characterID,
      ownerID: leg.ownerID,
      itemID: leg.escrowItemID,
      quantity: leg.quantity,
      escrowLocationID: getImportEscrowLocationID(settlement),
      idempotencyKey: leg.commitKey,
    });
    const failure = durableCustodyFailure(result, "PLANET_CUSTOMS_IMPORT_COMMIT_FAILED");
    if (failure) {
      return failure;
    }
    const checkpoint = updateSettlement(characterID, (current) => ({
      ...current,
      importLegs: current.importLegs.map((entry) =>
        entry.legID === leg.legID
          ? {
              ...entry,
              committed: true,
              commitError: null,
            }
          : entry),
    }));
    if (!checkpoint.success) {
      return checkpoint;
    }
  }

  // The tax is the office owner's income: a player corporation's office or
  // skyhook pays it into that corporation's master wallet with the same journal
  // type (EVE University, Customs Office: "taxes go to the owning
  // corporation"). InterBus and other NPC owners keep it out of the economy.
  // It runs once the transfer has committed, so a rejected transfer never
  // credits the owner.
  const ownerID = resolveCustomsTaxOwnerID(settlement);
  const { isNpcCorporationID } = require(path.join(__dirname, "../corporation/corporationState"));
  if (ownerID && !isNpcCorporationID(ownerID)) {
    const corpWallet = require(path.join(__dirname, "../corporation/corpWalletState"));
    for (const candidate of settlement.walletLegs) {
      settlement = getPendingPlanetaryCustomsSettlement(characterID);
      const leg = settlement && settlement.walletLegs.find(
        (entry) => entry.legID === candidate.legID,
      );
      if (!settlement || !leg || !leg.applied || leg.ownerCredited) {
        continue;
      }
      const creditCommandID = String(leg.debitCommandID).replace(/:debit$/, ":owner-credit");
      const result = await corpWallet.adjustCorporationWalletDivisionBalanceAsync(
        ownerID,
        corpWallet.CORPORATION_WALLET_KEY_START,
        leg.amount,
        {
          idempotencyKey: creditCommandID,
          entryTypeID: leg.entryTypeID,
          referenceID: leg.referenceID,
          ownerID1: settlement.characterID,
          ownerID2: ownerID,
          description: leg.description,
          requireExactCredit: true,
        },
        { commandID: creditCommandID, source: "planet-customs-tax-owner-credit" },
      );
      if (!result || result.success !== true) {
        const errorMsg = result && result.errorMsg || "PLANET_CUSTOMS_OWNER_CREDIT_FAILED";
        if (errorMsg !== "WALLET_LIMIT") {
          return result || { success: false, errorMsg };
        }
        log.warn(`[PlanetaryCustoms] Owner ${ownerID} wallet is full; tax leg ${leg.legID} not credited`);
      }
      const checkpoint = updateSettlement(characterID, (current) => ({
        ...current,
        walletLegs: current.walletLegs.map((entry) =>
          entry.legID === leg.legID ? { ...entry, ownerCredited: true } : entry),
      }));
      if (!checkpoint.success) {
        return checkpoint;
      }
    }
  }

  settlement = getPendingPlanetaryCustomsSettlement(characterID);
  const completion = buildCompletionResult(settlement);
  const removed = updateSettlement(characterID, () => null);
  if (!removed.success) {
    return removed;
  }
  emitCompletion(settlement, completion, options);
  return { success: true, data: completion };
}

function settlePlanetaryCustomsSettlement(characterID, options = {}) {
  return runSerialized(characterID, () =>
    settlePlanetaryCustomsInternal(characterID, options));
}

function bindDurableScheduler(scheduler) {
  if (!scheduler || typeof scheduler.schedule !== "function") {
    throw new TypeError("planetary customs scheduler requires schedule");
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

async function handleDurablePlanetaryCustomsSettlement(job = {}) {
  const characterID = toPositiveInt(job.payload && job.payload.characterID, 0);
  if (!characterID) {
    throw new Error("planetary customs settlement job is invalid");
  }
  const result = await settlePlanetaryCustomsSettlement(characterID);
  if (!result || result.success !== true) {
    const errorMsg = result && result.errorMsg || "planetary customs settlement failed";
    reportSettlementRetry({
      scope: "PlanetaryCustomsSettlement",
      attempt: job.attempt,
      ownerID: characterID,
      errorMsg,
    });
    throw new Error(errorMsg);
  }
  return result;
}

// `planet-customs:<characterID>:<operationSequence>:<leg>`.
const SEQUENCE_DOMAIN = registerSettlementSequenceDomain(
  "planet-customs",
  /^planet-customs:\d+:(\d+):/,
);

function advanceOperationSequenceWatermark(receiptScan) {
  return advanceSettlementSequenceWatermark({
    logTag: "[PlanetaryCustomsSettlement]",
    counterName: "nextOperationID",
    domain: SEQUENCE_DOMAIN,
    receiptScan,
    readCounter: () => readRoot().nextOperationID,
    writeCounter: (required) => {
      const root = readRoot();
      if (root.nextOperationID >= required) {
        return { success: true };
      }
      root.nextOperationID = required;
      return writeRoot(root);
    },
    pendingSequences: () =>
      listPendingPlanetaryCustomsSettlements().map(
        (settlement) => settlement.operationSequence,
      ),
  });
}

async function reconcileDurablePlanetaryCustomsSettlements(options = {}) {
  advanceOperationSequenceWatermark(options.receiptScan);
  const pending = listPendingPlanetaryCustomsSettlements();
  if (!durableScheduler) {
    return { scheduled: 0, pending: pending.length };
  }
  await Promise.all(pending.map((settlement) =>
    scheduleSettlement(settlement.characterID)));
  return { scheduled: pending.length, pending: pending.length };
}

module.exports = {
  DURABLE_SETTLEMENT_JOB_TYPE,
  ESCROW_LOCATION_BASE,
  TABLE_NAME,
  bindDurableScheduler,
  buildSettlementJob,
  getPendingPlanetaryCustomsSettlement,
  handleDurablePlanetaryCustomsSettlement,
  listPendingPlanetaryCustomsSettlements,
  preparePlanetaryCustomsSettlement,
  reconcileDurablePlanetaryCustomsSettlements,
  settlePlanetaryCustomsSettlement,
  unbindDurableScheduler,
};
