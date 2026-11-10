"use strict";

const {
  cloneValue,
} = require("../../common/clone");

const path = require("node:path");

const database = require(path.join(__dirname, "../../gameStore"));
const log = require(path.join(__dirname, "../../utils/logger"));
const {
  adjustCharacterBalanceAsync,
} = require(path.join(__dirname, "../account/walletState"));
const {
  adjustCorporationWalletDivisionBalanceAsync,
  normalizeCorporationWalletKey,
} = require(path.join(__dirname, "../corporation/corpWalletState"));
const itemStore = require(path.join(__dirname, "../inventory/itemStore"));
const {
  custodyStepCommitted,
  reportSettlementRetry,
  reportUnresolvedLeg,
  resolveCustodyResultItem,
} = require(path.join(__dirname, "../_shared/settlementCustodyRecovery"));
const {
  advanceSettlementSequenceWatermark,
  registerSettlementSequenceDomain,
} = require(path.join(__dirname, "../_shared/settlementSequenceWatermark"));
const industryInstallItemCustody = require(path.join(
  __dirname,
  "../inventory/industryInstallItemCustody",
));
const {
  INDUSTRY_INSTALLED_LOCATION_ID,
} = require(path.join(__dirname, "./industryConstants"));

const TABLE_NAME = "industryInstallSettlements";
const ROOT_VERSION = 1;
const ESCROW_LOCATION_BASE = 9_700_000_000;
const DURABLE_SETTLEMENT_JOB_TYPE = "industry.install-settle";
const DURABLE_SETTLEMENT_JOB_PREFIX = "industry-install:";
const DEFINITIVE_WALLET_ERRORS = new Set([
  "CHARACTER_NOT_FOUND",
  "CORPORATION_NOT_FOUND",
  "INSUFFICIENT_FUNDS",
  "INVALID_AMOUNT",
  "INVALID_WALLET_KEY",
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
    crewReceipts: cloneValue(root.crewReceipts || {}),
  };
}

function writeRoot(root) {
  database.ensureTable(TABLE_NAME);
  const result = database.write(TABLE_NAME, "/", {
    version: ROOT_VERSION,
    nextOperationID: toPositiveInt(root.nextOperationID, 1),
    byCharacter: cloneValue(root.byCharacter || {}),
    crewReceipts: cloneValue(root.crewReceipts || {}),
  });
  if (!result || result.success !== true) {
    return result || { success: false, errorMsg: "WRITE_ERROR" };
  }
  const flushResult = database.flushTableSync(TABLE_NAME);
  return flushResult && flushResult.success
    ? result
    : flushResult || { success: false, errorMsg: "FLUSH_ERROR" };
}

function getPendingIndustryInstallSettlement(characterID) {
  return cloneValue(
    readRoot().byCharacter[String(toPositiveInt(characterID, 0))] || null,
  );
}

function listPendingIndustryInstallSettlements() {
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
    return { success: false, errorMsg: "INDUSTRY_INSTALL_SETTLEMENT_NOT_FOUND" };
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
    : result || { success: false, errorMsg: "INDUSTRY_INSTALL_SETTLEMENT_WRITE_FAILED" };
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
      `[IndustryInstallSettlement] scheduling failed char=${characterID}: ${error.message}`,
    );
  });
}

function normalizeMaterialLeg(input, index, operationID) {
  return {
    legID: index + 1,
    itemID: toPositiveInt(input && input.itemID, 0),
    typeID: toPositiveInt(input && input.typeID, 0),
    quantity: toPositiveInt(input && input.quantity, 0),
    ownerID: toPositiveInt(input && input.ownerID, 0),
    sourceLocationID: toPositiveInt(input && input.locationID, 0),
    sourceFlagID: toFlag(input && input.flagID, 0),
    stageKey: `${DURABLE_SETTLEMENT_JOB_PREFIX}${operationID}:material:${index + 1}:stage`,
    returnKey: `${DURABLE_SETTLEMENT_JOB_PREFIX}${operationID}:material:${index + 1}:return`,
    commitKey: `${DURABLE_SETTLEMENT_JOB_PREFIX}${operationID}:material:${index + 1}:commit`,
    staged: false,
    returned: false,
    committed: false,
    escrowItemID: 0,
  };
}

function normalizeBlueprintLeg(input, operationID) {
  return {
    itemID: toPositiveInt(input && input.itemID, 0),
    typeID: toPositiveInt(input && input.typeID, 0),
    quantity: 1,
    ownerID: toPositiveInt(input && input.ownerID, 0),
    sourceLocationID: toPositiveInt(input && input.locationID, 0),
    sourceFlagID: toFlag(input && input.flagID, 0),
    sourceSnapshot: cloneValue(input && input.sourceSnapshot || null),
    stageKey: `${DURABLE_SETTLEMENT_JOB_PREFIX}${operationID}:blueprint:stage`,
    returnKey: `${DURABLE_SETTLEMENT_JOB_PREFIX}${operationID}:blueprint:return`,
    installKey: `${DURABLE_SETTLEMENT_JOB_PREFIX}${operationID}:blueprint:install`,
    staged: false,
    returned: false,
    installed: false,
    escrowItemID: 0,
  };
}

function prepareIndustryInstallSettlement(options = {}) {
  const characterID = toPositiveInt(options.characterID, 0);
  const ownerID = toPositiveInt(options.ownerID, 0);
  const ownerKind = options.ownerKind === "corporation" ? "corporation" : "character";
  const payerOwnerID = toPositiveInt(options.payerOwnerID ?? ownerID, 0);
  const requestedPayerKind = options.payerKind ?? ownerKind;
  const payerKind = requestedPayerKind === "corporation" || requestedPayerKind === "character"
    ? requestedPayerKind
    : null;
  const jobID = toPositiveInt(options.jobID, 0);
  const accountKey = normalizeCorporationWalletKey(options.accountKey);
  const jobRecord = cloneValue(options.jobRecord || null);
  const quote = cloneValue(options.quote || null);
  const materialInputs = Array.isArray(options.materialInputs)
    ? options.materialInputs
    : [];
  const blueprintInput = options.blueprintInput || {};
  const totalCost = roundMoney(options.totalCost);
  const clientRequestFingerprint = String(options.clientRequestFingerprint || "");
  if (
    !characterID ||
    !ownerID ||
    !payerOwnerID ||
    !payerKind ||
    !jobID ||
    !jobRecord ||
    !quote ||
    toPositiveInt(jobRecord.installedLocationID, 0) !==
      INDUSTRY_INSTALLED_LOCATION_ID ||
    (ownerKind === "character" && ownerID !== characterID) ||
    (payerKind === "character" && payerOwnerID !== characterID) ||
    totalCost < 0
  ) {
    return { success: false, errorMsg: "INVALID_INDUSTRY_INSTALL_SETTLEMENT" };
  }

  const normalizedMaterials = materialInputs.map((entry) => ({
    itemID: toPositiveInt(entry && entry.itemID, 0),
    typeID: toPositiveInt(entry && entry.typeID, 0),
    quantity: toPositiveInt(entry && entry.quantity, 0),
    ownerID: toPositiveInt(entry && entry.ownerID, ownerID),
    locationID: toPositiveInt(entry && entry.locationID, 0),
    flagID: toFlag(entry && entry.flagID, 0),
  }));
  const normalizedBlueprint = {
    itemID: toPositiveInt(blueprintInput.itemID, 0),
    typeID: toPositiveInt(blueprintInput.typeID, 0),
    ownerID: toPositiveInt(blueprintInput.ownerID, ownerID),
    locationID: toPositiveInt(blueprintInput.locationID, 0),
    flagID: toFlag(blueprintInput.flagID, 0),
    sourceSnapshot: cloneValue(blueprintInput.sourceSnapshot || null),
  };
  if (
    normalizedMaterials.some((entry) =>
      !entry.itemID ||
      !entry.typeID ||
      !entry.quantity ||
      entry.ownerID !== ownerID ||
      !entry.locationID) ||
    new Set(normalizedMaterials.map((entry) => entry.itemID)).size !==
      normalizedMaterials.length ||
    !normalizedBlueprint.itemID ||
    !normalizedBlueprint.typeID ||
    normalizedBlueprint.ownerID !== ownerID ||
    !normalizedBlueprint.locationID ||
    !normalizedBlueprint.sourceSnapshot
  ) {
    return { success: false, errorMsg: "INVALID_INDUSTRY_INSTALL_CUSTODY" };
  }

  const requestFingerprint = JSON.stringify({
    characterID,
    ownerID,
    ownerKind,
    payerOwnerID,
    payerKind,
    accountKey,
    jobID,
    totalCost,
    materials: normalizedMaterials,
    blueprint: {
      itemID: normalizedBlueprint.itemID,
      typeID: normalizedBlueprint.typeID,
      ownerID: normalizedBlueprint.ownerID,
      locationID: normalizedBlueprint.locationID,
      flagID: normalizedBlueprint.flagID,
    },
    jobRecord,
    clientRequestFingerprint,
  });
  const legacyRequestFingerprint = JSON.stringify({
    characterID,
    ownerID,
    ownerKind,
    accountKey,
    jobID,
    totalCost,
    materials: normalizedMaterials,
    blueprint: {
      itemID: normalizedBlueprint.itemID,
      typeID: normalizedBlueprint.typeID,
      ownerID: normalizedBlueprint.ownerID,
      locationID: normalizedBlueprint.locationID,
      flagID: normalizedBlueprint.flagID,
    },
    jobRecord,
    clientRequestFingerprint,
  });
  const root = readRoot();
  const key = String(characterID);
  const crewOrder = options.crewOrder || null;
  if (crewOrder && (!/^[a-f0-9]{64}$/.test(crewOrder.jobID) || !Number.isSafeInteger(crewOrder.serial) || crewOrder.serial < 1)) {
    return { success: false, errorMsg: "CREW_MANUFACTURING_ORDER_INVALID" };
  }
  const completed = root.crewReceipts[key];
  if (crewOrder && completed?.serial >= crewOrder.serial) {
    if (completed.serial !== crewOrder.serial || completed.jobID !== crewOrder.jobID || completed.requestFingerprint !== requestFingerprint) return { success: false, errorMsg: "CREW_MANUFACTURING_STALE" };
    return { success: true, completed: true, duplicate: true, result: cloneValue(completed.result) };
  }
  if (crewOrder && !completed && Object.keys(root.crewReceipts).length >= 128) return { success: false, errorMsg: "CREW_MANUFACTURING_CAPACITY" };
  const existing = root.byCharacter[key];
  if (existing) {
    const legacyFingerprintMatches =
      existing.payerOwnerID == null &&
      existing.payerKind == null &&
      payerOwnerID === ownerID &&
      payerKind === ownerKind &&
      existing.requestFingerprint === legacyRequestFingerprint;
    if (
      existing.requestFingerprint !== requestFingerprint &&
      !legacyFingerprintMatches
    ) {
      return { success: false, errorMsg: "INDUSTRY_INSTALL_ALREADY_PENDING" };
    }
    queueSettlement(characterID);
    return { success: true, duplicate: true, data: cloneValue(existing) };
  }

  const operationSequence = root.nextOperationID;
  const operationID = `${characterID}:${operationSequence}`;
  const materialEscrowLocationID = ESCROW_LOCATION_BASE + (operationSequence * 2);
  const blueprintEscrowLocationID = materialEscrowLocationID + 1;
  const settlement = {
    ...(crewOrder ? { crewOrder: cloneValue(crewOrder) } : {}),
    operationID,
    operationSequence,
    requestFingerprint,
    clientRequestFingerprint,
    characterID,
    ownerID,
    ownerKind,
    payerOwnerID,
    payerKind,
    accountKey,
    jobID,
    jobRecord: {
      ...jobRecord,
      jobID,
      installationOperationID: operationID,
      installationPending: true,
    },
    quote,
    totalCost,
    walletDescription: String(
      options.walletDescription || `Industry job ${jobID} installation`,
    ),
    debitCommandID: `${DURABLE_SETTLEMENT_JOB_PREFIX}${operationID}:wallet:debit`,
    refundCommandID: `${DURABLE_SETTLEMENT_JOB_PREFIX}${operationID}:wallet:refund`,
    walletApplied: false,
    walletRefunded: false,
    walletResult: null,
    materialEscrowLocationID,
    blueprintEscrowLocationID,
    materialLegs: normalizedMaterials.map((entry, index) =>
      normalizeMaterialLeg(entry, index, operationID)),
    blueprintLeg: normalizeBlueprintLeg(normalizedBlueprint, operationID),
    installationPrepared: false,
    installationFinalized: false,
    rejectionError: null,
    materialChanges: [],
    blueprintChanges: [],
    createdAt: new Date().toISOString(),
  };
  root.nextOperationID = operationSequence + 1;
  root.byCharacter[key] = settlement;
  const result = writeRoot(root);
  if (!result || result.success !== true) {
    return result || { success: false, errorMsg: "INDUSTRY_INSTALL_SETTLEMENT_WRITE_FAILED" };
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

function getResultItem(result) {
  const resolved = resolveCustodyResultItem(result);
  if (resolved) {
    return resolved;
  }
  return getCustodyChanges(result)
    .map((change) => change && change.item)
    .find(Boolean) || null;
}

function findEscrowItem(settlement, leg, kind) {
  const locationID = kind === "blueprint"
    ? settlement.blueprintEscrowLocationID
    : settlement.materialEscrowLocationID;
  const assigned = new Set(
    settlement.materialLegs
      .filter((entry) => kind !== "material" || entry.legID !== leg.legID)
      .map((entry) => toPositiveInt(entry.escrowItemID, 0))
      .filter(Boolean),
  );
  if (kind !== "blueprint") {
    assigned.add(toPositiveInt(settlement.blueprintLeg.escrowItemID, 0));
  }
  return itemStore.listContainerItems(leg.ownerID, locationID, 0)
    .filter((item) =>
      toPositiveInt(item && item.typeID, 0) === leg.typeID &&
      !assigned.has(toPositiveInt(item && item.itemID, 0)))
    .sort((left, right) => Number(left.itemID) - Number(right.itemID))[0] || null;
}

function buildMaterialClientChanges(changes, settlement, leg) {
  const result = [];
  for (const change of Array.isArray(changes) ? changes : []) {
    const item = change && change.item;
    const previousData = change && (change.previousData || change.previousState);
    const isEscrowDestination = Boolean(
      item &&
      toPositiveInt(item.locationID, 0) === settlement.materialEscrowLocationID &&
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
      result.push({ removed: true, previousData: cloneValue(previousData), item: null });
    }
  }
  return result;
}

function getIndustryRuntime() {
  return require(path.join(__dirname, "./industryRuntimeState"));
}

async function adjustSettlementWallet(settlement, delta, commandID, source) {
  const payerOwnerID = toPositiveInt(
    settlement && (settlement.payerOwnerID ?? settlement.ownerID),
    0,
  );
  const requestedPayerKind = settlement && (settlement.payerKind ?? settlement.ownerKind);
  const payerKind = requestedPayerKind === "corporation" || requestedPayerKind === "character"
    ? requestedPayerKind
    : null;
  if (!payerOwnerID || !payerKind) {
    return { success: false, errorMsg: "INVALID_INDUSTRY_INSTALL_PAYER" };
  }
  const options = {
    idempotencyKey: commandID,
    description: settlement.walletDescription,
    ownerID1: payerOwnerID,
    ownerID2: settlement.characterID,
    referenceID: settlement.jobID,
  };
  if (payerKind === "corporation") {
    return adjustCorporationWalletDivisionBalanceAsync(
      payerOwnerID,
      settlement.accountKey,
      delta,
      options,
      { commandID, source },
    );
  }
  return adjustCharacterBalanceAsync(
    payerOwnerID,
    delta,
    options,
    { commandID, source },
  );
}

/**
 * The cross-check executeIdempotently asks of callers who need more than its
 * WARN: does the result it handed back actually move the amount we asked for?
 *
 * It only applies to a result the authority tagged as answering a commandID
 * whose stored fingerprint differed. Two things produce that tag. A replay of
 * *this* operation whose payload shape changed underneath it -- benign, and the
 * amounts agree, because it is the same debit. Or a commandID collision, where
 * the receipt belongs to an unrelated operation entirely: then the amounts
 * disagree, no money moved, and treating the success at face value installs the
 * job without charging anyone.
 *
 * advanceOperationSequenceWatermark is what stops the collision being mintable,
 * and it runs at every startup. This is the backstop for when it could not do
 * its job -- most plausibly a receipt-table read that failed and was reported as
 * "no records", which leaves the watermark at zero and advances nothing.
 *
 * Returns null when the result is trustworthy.
 */
function debitAnsweredFromAnotherOperation(result, totalCost) {
  if (!result || result.success !== true || result.fingerprintMismatch !== true) {
    return null;
  }
  // A character adjust reports its delta at the top level; a corporation one
  // nests it under `data`. Reading only the first shape would classify every
  // corporation-payer install as a collision.
  const rawDelta = Number.isFinite(Number(result.delta))
    ? Number(result.delta)
    : Number(result.data && result.data.delta);
  const expected = roundMoney(-totalCost);
  const paid = roundMoney(rawDelta);
  // Half a cent: money is stored rounded to two decimals, so anything finer is
  // the same number, and a receipt that paid a different amount is precisely
  // the signal being looked for.
  if (Number.isFinite(paid) && Math.abs(paid - expected) < 0.005) {
    return null;
  }
  return { expected, paid: Number.isFinite(paid) ? paid : null };
}

async function compensateRejectedSettlement(characterID) {
  let settlement = getPendingIndustryInstallSettlement(characterID);
  if (!settlement) {
    return { success: true, alreadySettled: true };
  }
  if (settlement.installationPrepared) {
    return { success: false, errorMsg: "INDUSTRY_INSTALL_ALREADY_PREPARED" };
  }

  const blueprint = settlement.blueprintLeg;
  if (blueprint.staged && !blueprint.returned && !blueprint.installed) {
    const result = industryInstallItemCustody.returnBlueprint({
      actorID: settlement.characterID,
      ownerID: blueprint.ownerID,
      itemID: blueprint.escrowItemID,
      quantity: 1,
      escrowLocationID: settlement.blueprintEscrowLocationID,
      destinationLocationID: blueprint.sourceLocationID,
      destinationFlagID: blueprint.sourceFlagID,
      idempotencyKey: blueprint.returnKey,
    });
    const failure = durableCustodyFailure(result, "INDUSTRY_BLUEPRINT_RETURN_FAILED");
    if (failure) {
      return failure;
    }
    const checkpoint = updateSettlement(characterID, (current) => ({
      ...current,
      blueprintLeg: { ...current.blueprintLeg, returned: true },
    }));
    if (!checkpoint.success) {
      return checkpoint;
    }
  }

  settlement = getPendingIndustryInstallSettlement(characterID);
  for (const candidate of [...settlement.materialLegs].reverse()) {
    settlement = getPendingIndustryInstallSettlement(characterID);
    const leg = settlement && settlement.materialLegs.find(
      (entry) => entry.legID === candidate.legID,
    );
    if (!settlement || !leg || !leg.staged || leg.returned || leg.committed) {
      continue;
    }
    const result = industryInstallItemCustody.returnMaterial({
      actorID: settlement.characterID,
      ownerID: leg.ownerID,
      itemID: leg.escrowItemID,
      quantity: leg.quantity,
      escrowLocationID: settlement.materialEscrowLocationID,
      destinationLocationID: leg.sourceLocationID,
      destinationFlagID: leg.sourceFlagID,
      idempotencyKey: leg.returnKey,
    });
    const failure = durableCustodyFailure(result, "INDUSTRY_MATERIAL_RETURN_FAILED");
    if (failure) {
      return failure;
    }
    const checkpoint = updateSettlement(characterID, (current) => ({
      ...current,
      materialLegs: current.materialLegs.map((entry) =>
        entry.legID === leg.legID ? { ...entry, returned: true } : entry),
    }));
    if (!checkpoint.success) {
      return checkpoint;
    }
  }

  settlement = getPendingIndustryInstallSettlement(characterID);
  if (settlement.walletApplied && !settlement.walletRefunded && settlement.totalCost > 0) {
    const result = await adjustSettlementWallet(
      settlement,
      settlement.totalCost,
      settlement.refundCommandID,
      "industry-install-refund",
    );
    if (!result || result.success !== true) {
      return result || { success: false, errorMsg: "INDUSTRY_INSTALL_REFUND_FAILED" };
    }
    const checkpoint = updateSettlement(characterID, (current) => ({
      ...current,
      walletRefunded: true,
    }));
    if (!checkpoint.success) {
      return checkpoint;
    }
  }

  settlement = getPendingIndustryInstallSettlement(characterID);
  const errorMsg = settlement && settlement.rejectionError || "INDUSTRY_INSTALL_REJECTED";
  const removed = finishCrewAwareSettlement(settlement, { success: true, rejected: true, errorMsg });
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

async function settleIndustryInstallInternal(characterID, options = {}) {
  let settlement = getPendingIndustryInstallSettlement(characterID);
  if (!settlement) {
    return { success: true, alreadySettled: true, data: null };
  }
  if (settlement.rejectionError) {
    return compensateRejectedSettlement(characterID);
  }

  if (!settlement.walletApplied && settlement.totalCost > 0) {
    const result = await adjustSettlementWallet(
      settlement,
      -settlement.totalCost,
      settlement.debitCommandID,
      "industry-install-debit",
    );
    const collision = debitAnsweredFromAnotherOperation(result, settlement.totalCost);
    if (collision) {
      log.err(
        `[IndustryInstallSettlement] operation=${settlement.operationID} debit ` +
          `commandID=${settlement.debitCommandID} was answered from a receipt that ` +
          `moved ${collision.paid} ISK, not the ${collision.expected} this job costs. ` +
          `The commandID belongs to a different operation, so nothing was charged. ` +
          `Rejecting the install rather than running the job for free; the counter ` +
          `that mints these IDs is repeating and needs advanceOperationSequenceWatermark ` +
          `to run (or to have run) at startup`,
      );
      return rejectSettlement(characterID, "INDUSTRY_INSTALL_DEBIT_COLLIDED");
    }
    if (!result || result.success !== true) {
      const errorMsg = result && result.errorMsg || "INDUSTRY_INSTALL_DEBIT_FAILED";
      return DEFINITIVE_WALLET_ERRORS.has(errorMsg)
        ? rejectSettlement(characterID, errorMsg)
        : result || { success: false, errorMsg };
    }
    const checkpoint = updateSettlement(characterID, (current) => ({
      ...current,
      walletApplied: true,
      walletResult: cloneValue(result),
    }));
    if (!checkpoint.success) {
      return checkpoint;
    }
  }

  settlement = getPendingIndustryInstallSettlement(characterID);
  for (const candidate of settlement.materialLegs) {
    settlement = getPendingIndustryInstallSettlement(characterID);
    const leg = settlement && settlement.materialLegs.find(
      (entry) => entry.legID === candidate.legID,
    );
    if (!settlement || !leg || leg.staged) {
      continue;
    }
    const result = industryInstallItemCustody.stageMaterial({
      actorID: settlement.characterID,
      ownerID: leg.ownerID,
      itemID: leg.itemID,
      quantity: leg.quantity,
      sourceLocationID: leg.sourceLocationID,
      sourceFlagID: leg.sourceFlagID,
      escrowLocationID: settlement.materialEscrowLocationID,
      idempotencyKey: leg.stageKey,
    });
    const failure = durableCustodyFailure(result, "INDUSTRY_MATERIAL_STAGE_FAILED");
    if (failure) {
      return failure.ambiguous === true
        ? failure
        : rejectSettlement(characterID, "MISSING_MATERIAL");
    }
    const movedItem = getResultItem(result) || findEscrowItem(settlement, leg, "material");
    if (!movedItem) {
      // A staged row that is no longer in escrow, whose commit already ran, is a
      // finished leg with a lost checkpoint — not work to retry.
      if (custodyStepCommitted(leg.commitKey)) {
        const recovered = updateSettlement(characterID, (current) => ({
          ...current,
          materialLegs: current.materialLegs.map((entry) =>
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
        scope: "IndustryInstallSettlement",
        operationID: settlement.operationID,
        step: "material-stage",
        legID: leg.legID,
        errorMsg: "INDUSTRY_MATERIAL_ESCROW_UNKNOWN",
      });
      return { success: false, ambiguous: true, errorMsg: "INDUSTRY_MATERIAL_ESCROW_UNKNOWN" };
    }
    const checkpoint = updateSettlement(characterID, (current) => ({
      ...current,
      materialLegs: current.materialLegs.map((entry) =>
        entry.legID === leg.legID
          ? { ...entry, staged: true, escrowItemID: toPositiveInt(movedItem.itemID, 0) }
          : entry),
      materialChanges: [
        ...(current.materialChanges || []),
        ...buildMaterialClientChanges(getCustodyChanges(result), settlement, leg),
      ],
    }));
    if (!checkpoint.success) {
      return checkpoint;
    }
  }

  settlement = getPendingIndustryInstallSettlement(characterID);
  if (!settlement.blueprintLeg.staged) {
    const leg = settlement.blueprintLeg;
    const result = industryInstallItemCustody.stageBlueprint({
      actorID: settlement.characterID,
      ownerID: leg.ownerID,
      itemID: leg.itemID,
      quantity: 1,
      sourceLocationID: leg.sourceLocationID,
      sourceFlagID: leg.sourceFlagID,
      escrowLocationID: settlement.blueprintEscrowLocationID,
      idempotencyKey: leg.stageKey,
    });
    const failure = durableCustodyFailure(result, "INDUSTRY_BLUEPRINT_STAGE_FAILED");
    if (failure) {
      return failure.ambiguous === true
        ? failure
        : rejectSettlement(characterID, "BLUEPRINT_NOT_FOUND");
    }
    const movedItem = getResultItem(result) || findEscrowItem(settlement, leg, "blueprint");
    if (!movedItem) {
      if (custodyStepCommitted(leg.installKey)) {
        const recovered = updateSettlement(characterID, (current) => ({
          ...current,
          blueprintLeg: {
            ...current.blueprintLeg,
            staged: true,
            installed: true,
          },
        }));
        if (!recovered.success) {
          return recovered;
        }
      } else {
        reportUnresolvedLeg({
          scope: "IndustryInstallSettlement",
          operationID: settlement.operationID,
          step: "blueprint-stage",
          errorMsg: "INDUSTRY_BLUEPRINT_ESCROW_UNKNOWN",
        });
        return { success: false, ambiguous: true, errorMsg: "INDUSTRY_BLUEPRINT_ESCROW_UNKNOWN" };
      }
    } else {
      const checkpoint = updateSettlement(characterID, (current) => ({
        ...current,
        blueprintLeg: {
          ...current.blueprintLeg,
          staged: true,
          escrowItemID: toPositiveInt(movedItem.itemID, 0),
        },
      }));
      if (!checkpoint.success) {
        return checkpoint;
      }
    }
  }

  settlement = getPendingIndustryInstallSettlement(characterID);
  if (!settlement.installationPrepared) {
    const result = getIndustryRuntime().persistPreparedIndustryInstall(settlement);
    if (!result || result.success !== true) {
      if (result && result.ambiguous === true) {
        return result;
      }
      return rejectSettlement(
        characterID,
        result && result.errorMsg || "INDUSTRY_INSTALL_PREPARE_FAILED",
      );
    }
    const checkpoint = updateSettlement(characterID, (current) => ({
      ...current,
      installationPrepared: true,
    }));
    if (!checkpoint.success) {
      return checkpoint;
    }
  }

  settlement = getPendingIndustryInstallSettlement(characterID);
  for (const candidate of settlement.materialLegs) {
    settlement = getPendingIndustryInstallSettlement(characterID);
    const leg = settlement && settlement.materialLegs.find(
      (entry) => entry.legID === candidate.legID,
    );
    if (!settlement || !leg || leg.committed) {
      continue;
    }
    const result = industryInstallItemCustody.commitMaterial({
      actorID: settlement.characterID,
      ownerID: leg.ownerID,
      itemID: leg.escrowItemID,
      quantity: leg.quantity,
      escrowLocationID: settlement.materialEscrowLocationID,
      idempotencyKey: leg.commitKey,
    });
    const failure = durableCustodyFailure(result, "INDUSTRY_MATERIAL_COMMIT_FAILED");
    if (failure) {
      return failure;
    }
    const checkpoint = updateSettlement(characterID, (current) => ({
      ...current,
      materialLegs: current.materialLegs.map((entry) =>
        entry.legID === leg.legID ? { ...entry, committed: true } : entry),
    }));
    if (!checkpoint.success) {
      return checkpoint;
    }
  }

  settlement = getPendingIndustryInstallSettlement(characterID);
  if (!settlement.blueprintLeg.installed) {
    const leg = settlement.blueprintLeg;
    const result = industryInstallItemCustody.installBlueprint({
      actorID: settlement.characterID,
      ownerID: leg.ownerID,
      itemID: leg.escrowItemID,
      quantity: 1,
      escrowLocationID: settlement.blueprintEscrowLocationID,
      destinationLocationID: toPositiveInt(
        settlement.jobRecord && settlement.jobRecord.installedLocationID,
        0,
      ),
      destinationFlagID: leg.sourceFlagID,
      idempotencyKey: leg.installKey,
    });
    const failure = durableCustodyFailure(result, "INDUSTRY_BLUEPRINT_INSTALL_FAILED");
    if (failure) {
      return failure;
    }
    const sourceSnapshot = cloneValue(leg.sourceSnapshot);
    const checkpoint = updateSettlement(characterID, (current) => ({
      ...current,
      blueprintLeg: { ...current.blueprintLeg, installed: true },
      blueprintChanges: [{
        removed: false,
        previousData: sourceSnapshot,
        item: { ...sourceSnapshot, locationID: 6 },
      }],
    }));
    if (!checkpoint.success) {
      return checkpoint;
    }
  }

  settlement = getPendingIndustryInstallSettlement(characterID);
  if (!settlement.installationFinalized) {
    const result = getIndustryRuntime().finalizePreparedIndustryInstall(settlement);
    if (!result || result.success !== true) {
      return result || { success: false, ambiguous: true, errorMsg: "INDUSTRY_INSTALL_FINALIZE_FAILED" };
    }
    const checkpoint = updateSettlement(characterID, (current) => ({
      ...current,
      installationFinalized: true,
    }));
    if (!checkpoint.success) {
      return checkpoint;
    }
  }

  settlement = getPendingIndustryInstallSettlement(characterID);
  const completion = {
    operationID: settlement.operationID,
    characterID: settlement.characterID,
    ownerID: settlement.ownerID,
    jobID: settlement.jobID,
    quote: cloneValue(settlement.quote),
    jobRecord: cloneValue(settlement.jobRecord),
    materialChanges: cloneValue(settlement.materialChanges || []),
    blueprintChanges: cloneValue(settlement.blueprintChanges || []),
  };
  const removed = finishCrewAwareSettlement(settlement, { success: true, data: { jobID: settlement.jobID } });
  if (!removed.success) {
    return removed;
  }
  try {
    getIndustryRuntime().publishPreparedIndustryInstall(settlement, options);
  } catch (error) {
    log.warn(
      `[IndustryInstallSettlement] publication failed job=${settlement.jobID}: ${error.message}`,
    );
  }
  return { success: true, data: completion };
}

function settleIndustryInstallSettlement(characterID, options = {}) {
  return runSerialized(characterID, () =>
    settleIndustryInstallInternal(characterID, options));
}

function finishCrewAwareSettlement(settlement, result) {
  const root = readRoot(), key = String(settlement.characterID);
  if (root.byCharacter[key]?.operationID !== settlement.operationID) return { success: false, errorMsg: "INDUSTRY_INSTALL_COMPLETION_CONFLICT" };
  if (settlement.crewOrder) root.crewReceipts[key] = { ...settlement.crewOrder, requestFingerprint: settlement.requestFingerprint,
    result, custodyKeys: [...settlement.materialLegs.flatMap(leg => [leg.stageKey, leg.commitKey, leg.returnKey]),
      settlement.blueprintLeg.stageKey, settlement.blueprintLeg.installKey, settlement.blueprintLeg.returnKey] };
  delete root.byCharacter[key]; return writeRoot(root);
}
function getCrewIndustryInstallResult(characterID, crewOrder) {
  const receipt = readRoot().crewReceipts[String(characterID)];
  return receipt?.jobID === crewOrder.jobID && receipt.serial === crewOrder.serial ? cloneValue(receipt.result) : null;
}
function acknowledgeCrewIndustryInstall(characterID, crewOrder) {
  const root = readRoot(), receipt = root.crewReceipts[String(characterID)];
  if (!receipt || receipt.jobID !== crewOrder.jobID || receipt.serial !== crewOrder.serial ||
      root.byCharacter[String(characterID)]?.crewOrder?.jobID === crewOrder.jobID) return { success: false, errorMsg: "CREW_MANUFACTURING_ACK_CONFLICT" };
  const hash = key => require("node:crypto").createHash("sha256").update(key).digest("hex");
  const keys = new Set((receipt.custodyKeys || []).map(key => `item-custody:local:${hash(key)}`));
  const pruned = itemStore.pruneIdempotentGrantReceipts(value => keys.has(value.receiptKey));
  if (!pruned.success || !database.flushTableSync("items").success) return { success: false, errorMsg: "CREW_MANUFACTURING_ACK_PENDING" };
  delete receipt.custodyKeys; return writeRoot(root);
}

function bindDurableScheduler(scheduler) {
  if (!scheduler || typeof scheduler.schedule !== "function") {
    throw new TypeError("industry install scheduler requires schedule");
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

async function handleDurableIndustryInstallSettlement(job = {}) {
  const characterID = toPositiveInt(job.payload && job.payload.characterID, 0);
  if (!characterID) {
    throw new Error("industry install settlement job is invalid");
  }
  const result = await settleIndustryInstallSettlement(characterID);
  if (!result || result.success !== true) {
    const errorMsg = result && result.errorMsg || "industry install settlement failed";
    reportSettlementRetry({
      scope: "IndustryInstallSettlement",
      attempt: job.attempt,
      ownerID: characterID,
      errorMsg,
    });
    throw new Error(errorMsg);
  }
  return result;
}

// `industry-install:<characterID>:<operationSequence>:wallet:debit` -- see
// normalizeMaterialLeg and the settlement's debitCommandID for every leg that
// shares the sequence.
const SEQUENCE_DOMAIN = registerSettlementSequenceDomain(
  "industry-install",
  /^industry-install:\d+:(\d+):/,
);

function advanceOperationSequenceWatermark(receiptScan) {
  return advanceSettlementSequenceWatermark({
    logTag: "[IndustryInstallSettlement]",
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
      listPendingIndustryInstallSettlements().map(
        (settlement) => settlement.operationSequence,
      ),
  });
}

async function reconcileDurableIndustryInstallSettlements(options = {}) {
  advanceOperationSequenceWatermark(options.receiptScan);
  const pending = listPendingIndustryInstallSettlements();
  if (!durableScheduler) {
    return { scheduled: 0, pending: pending.length };
  }
  await Promise.all(pending.map((settlement) =>
    scheduleSettlement(settlement.characterID)));
  return { scheduled: pending.length, pending: pending.length };
}

module.exports = {
  getCrewIndustryInstallResult,
  acknowledgeCrewIndustryInstall,
  DURABLE_SETTLEMENT_JOB_TYPE,
  ESCROW_LOCATION_BASE,
  TABLE_NAME,
  bindDurableScheduler,
  buildSettlementJob,
  getPendingIndustryInstallSettlement,
  handleDurableIndustryInstallSettlement,
  listPendingIndustryInstallSettlements,
  prepareIndustryInstallSettlement,
  reconcileDurableIndustryInstallSettlements,
  settleIndustryInstallSettlement,
  unbindDurableScheduler,
};
