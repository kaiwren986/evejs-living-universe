"use strict";

const {
  cloneValue,
} = require("../../common/clone");

const path = require("node:path");

const database = require(path.join(__dirname, "../../gameStore"));
const log = require(path.join(__dirname, "../../utils/logger"));
const {
  JOURNAL_ENTRY_TYPE,
  adjustCharacterBalanceAsync,
} = require(path.join(__dirname, "../account/walletState"));
const {
  CORPORATION_WALLET_KEY_START,
  adjustCorporationWalletDivisionBalanceAsync,
} = require(path.join(__dirname, "../corporation/corpWalletState"));
const itemStore = require(path.join(__dirname, "../inventory/itemStore"));
const reprocessingItemCustody = require(path.join(
  __dirname,
  "../inventory/reprocessingItemCustody",
));
const sessionRegistry = require(path.join(__dirname, "../chat/sessionRegistry"));
const {
  fanCorporationOfficeInventoryChanges,
} = require(path.join(__dirname, "../inventory/corporationOfficeInventoryObservers"));
const {
  custodyStepChanges,
  custodyStepCommitted,
  reportSettlementRetry,
  reportUnresolvedLeg,
  resolveCustodyResultItem,
} = require(path.join(__dirname, "../_shared/settlementCustodyRecovery"));
const { publishReprocessedNotice } = require("./reprocessingNotices");
const {
  advanceSettlementSequenceWatermark,
  registerSettlementSequenceDomain,
} = require(path.join(__dirname, "../_shared/settlementSequenceWatermark"));

const TABLE_NAME = "reprocessingSettlements";
const ROOT_VERSION = 1;
const ESCROW_LOCATION_BASE = 9_400_000_000;
// Each operation parks its inputs at ESCROW_LOCATION_BASE + operationSequence.
// The next escrow family (mission rewards) starts at 9.5B, so this range is
// exclusively reprocessing's; the boot sweep scans only inside it.
const ESCROW_LOCATION_LIMIT = 9_500_000_000;
const DURABLE_SETTLEMENT_JOB_TYPE = "reprocessing.settle";
const DURABLE_SETTLEMENT_JOB_PREFIX = "reprocessing-settlement:";
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
    // Detached on purpose: gameStore.read hands back the live cache object, and
    // writeRoot's change detection compares the incoming value against that same
    // cache. Mutating it in place would make every write look like a no-op — the
    // table would stay correct in memory and never reach disk, so a settled
    // operation would come back from the dead on the next restart.
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

function getPendingReprocessingSettlement(characterID) {
  const key = String(toPositiveInt(characterID, 0));
  return cloneValue(readRoot().byCharacter[key] || null);
}

function listPendingReprocessingSettlements() {
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
    return { success: false, errorMsg: "REPROCESSING_SETTLEMENT_NOT_FOUND" };
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
    : result || { success: false, errorMsg: "REPROCESSING_SETTLEMENT_WRITE_FAILED" };
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
      `[ReprocessingSettlement] scheduling failed char=${characterID}: ${error.message}`,
    );
  });
}

function normalizeInputLeg(input, index, operationID) {
  const item = input && input.item && typeof input.item === "object"
    ? input.item
    : {};
  return {
    legID: index + 1,
    itemID: toPositiveInt(input && input.itemID, toPositiveInt(item.itemID, 0)),
    typeID: toPositiveInt(input && input.typeID, toPositiveInt(item.typeID, 0)),
    quantity: toPositiveInt(input && input.quantity, 0),
    ownerID: toPositiveInt(input && input.ownerID, toPositiveInt(item.ownerID, 0)),
    sourceLocationID: toPositiveInt(
      input && input.locationID,
      toPositiveInt(item.locationID, 0),
    ),
    sourceFlagID: toFlag(input && input.flagID, toFlag(item.flagID, 0)),
    stageKey: `${DURABLE_SETTLEMENT_JOB_PREFIX}${operationID}:input:${index + 1}:stage`,
    returnKey: `${DURABLE_SETTLEMENT_JOB_PREFIX}${operationID}:input:${index + 1}:return`,
    commitKey: `${DURABLE_SETTLEMENT_JOB_PREFIX}${operationID}:input:${index + 1}:commit`,
    staged: false,
    returned: false,
    committed: false,
    commitError: null,
    escrowItemID: 0,
    changes: [],
  };
}

function normalizeOutputLeg(output, index, operationID, target) {
  return {
    legID: index + 1,
    typeID: toPositiveInt(output && output.typeID, 0),
    quantity: toPositiveInt(output && output.quantity, 0),
    ownerID: target.ownerID,
    destinationLocationID: target.locationID,
    destinationFlagID: target.flagID,
    grantKey: `${DURABLE_SETTLEMENT_JOB_PREFIX}${operationID}:output:${index + 1}:grant`,
    deliverKey: `${DURABLE_SETTLEMENT_JOB_PREFIX}${operationID}:output:${index + 1}:deliver`,
    revokeKey: `${DURABLE_SETTLEMENT_JOB_PREFIX}${operationID}:output:${index + 1}:revoke`,
    granted: false,
    delivered: false,
    revoked: false,
    escrowItemID: 0,
    changes: [],
  };
}

function splitOutputLegs(outputs) {
  const stackLimit = toPositiveInt(
    itemStore.CLIENT_INVENTORY_STACK_LIMIT,
    2_147_483_647,
  );
  const result = [];
  for (const output of outputs) {
    const typeID = toPositiveInt(output && output.typeID, 0);
    let remaining = toPositiveInt(output && output.quantity, 0);
    while (typeID && remaining > 0) {
      const quantity = Math.min(remaining, stackLimit);
      result.push({ typeID, quantity });
      remaining -= quantity;
    }
  }
  return result;
}

function prepareReprocessingSettlement(options = {}) {
  const characterID = toPositiveInt(options.characterID, 0);
  const target = {
    ownerID: toPositiveInt(options.outputTarget && options.outputTarget.ownerID, 0),
    locationID: toPositiveInt(options.outputTarget && options.outputTarget.locationID, 0),
    flagID: toFlag(options.outputTarget && options.outputTarget.flagID, 0),
  };
  const inputs = Array.isArray(options.inputs) ? options.inputs : [];
  const outputs = Array.isArray(options.outputs) ? options.outputs : [];
  if (
    !characterID ||
    !target.ownerID ||
    !target.locationID ||
    !inputs.length
  ) {
    return { success: false, errorMsg: "INVALID_REPROCESSING_SETTLEMENT" };
  }

  const crewOrder = options.crewOrder || null;
  if (crewOrder && (!Number.isSafeInteger(crewOrder.serial) || crewOrder.serial < 1 ||
      !/^[a-f0-9]{64}$/.test(crewOrder.jobID))) return { success: false, errorMsg: "INVALID_CREW_REPROCESSING_ORDER" };
  const requestFingerprint = JSON.stringify({
    ...(crewOrder ? { crewOrder } : {}),
    characterID,
    target,
    inputs: inputs.map((entry) => ({
      itemID: toPositiveInt(entry && entry.itemID, 0),
      typeID: toPositiveInt(entry && entry.typeID, 0),
      quantity: toPositiveInt(entry && entry.quantity, 0),
      ownerID: toPositiveInt(entry && entry.ownerID, 0),
      locationID: toPositiveInt(entry && entry.locationID, 0),
      flagID: toFlag(entry && entry.flagID, 0),
    })),
    outputs: outputs.map((entry) => ({
      typeID: toPositiveInt(entry && entry.typeID, 0),
      quantity: toPositiveInt(entry && entry.quantity, 0),
    })),
    totalCost: roundMoney(options.totalCost),
    ownerCorporationID: toPositiveInt(options.ownerCorporationID, 0),
  });
  const root = readRoot();
  const key = String(characterID);
  const completed = root.crewReceipts[key];
  if (crewOrder && completed?.serial >= crewOrder.serial) {
    if (completed.serial !== crewOrder.serial || completed.jobID !== crewOrder.jobID || completed.requestFingerprint !== requestFingerprint) {
      return { success: false, errorMsg: "CREW_REPROCESSING_STALE" };
    }
    return { success: true, completed: true, duplicate: true, result: cloneValue(completed.result) };
  }
  if (crewOrder && !completed && Object.keys(root.crewReceipts).length >= 128) return { success: false, errorMsg: "CREW_REPROCESSING_CAPACITY" };
  const existing = root.byCharacter[key];
  if (existing) {
    if (existing.requestFingerprint !== requestFingerprint) {
      return { success: false, errorMsg: "REPROCESSING_ALREADY_PENDING" };
    }
    queueSettlement(characterID);
    return { success: true, duplicate: true, data: cloneValue(existing) };
  }

  const operationSequence = root.nextOperationID;
  const operationID = `${characterID}:${operationSequence}`;
  const escrowLocationID = ESCROW_LOCATION_BASE + operationSequence;
  const inputLegs = inputs.map((entry, index) =>
    normalizeInputLeg(entry, index, operationID));
  const outputLegs = splitOutputLegs(outputs)
    .map((entry, index) => normalizeOutputLeg(entry, index, operationID, target));
  if (
    inputLegs.some((leg) =>
      !leg.itemID ||
      !leg.typeID ||
      !leg.quantity ||
      !leg.ownerID ||
      !leg.sourceLocationID) ||
    outputLegs.some((leg) => !leg.typeID || !leg.quantity)
  ) {
    return { success: false, errorMsg: "INVALID_REPROCESSING_LEG" };
  }

  const totalCost = roundMoney(options.totalCost);
  const ownerCorporationID = toPositiveInt(options.ownerCorporationID, 0);
  const settlement = {
    ...(crewOrder ? { crewOrder: cloneValue(crewOrder) } : {}),
    operationID,
    operationSequence,
    requestFingerprint,
    characterID,
    escrowLocationID,
    inputLegs,
    outputLegs,
    outputTarget: target,
    totalCost,
    ownerCorporationID,
    facilityLocationID: toPositiveInt(options.facilityLocationID, 0),
    walletDescription: String(options.walletDescription || "Reprocessing tax"),
    debitCommandID: `${DURABLE_SETTLEMENT_JOB_PREFIX}${operationID}:debit`,
    refundCommandID: `${DURABLE_SETTLEMENT_JOB_PREFIX}${operationID}:refund`,
    ownerCreditCommandID: `${DURABLE_SETTLEMENT_JOB_PREFIX}${operationID}:owner-credit`,
    ownerCreditReversalCommandID:
      `${DURABLE_SETTLEMENT_JOB_PREFIX}${operationID}:owner-credit-reversal`,
    debitApplied: totalCost <= 0,
    debitRefunded: false,
    ownerCreditApplied: totalCost <= 0 || !ownerCorporationID,
    ownerCreditReversed: false,
    ownerCreditError: null,
    rejectionError: null,
    deliveryStarted: false,
    processedItemIDs: Array.isArray(options.processedItemIDs)
      ? options.processedItemIDs.map((value) => toPositiveInt(value, 0)).filter(Boolean)
      : inputLegs.map((leg) => leg.itemID),
    outputByTypeID:
      options.outputByTypeID && typeof options.outputByTypeID === "object"
        ? cloneValue(options.outputByTypeID)
        : Object.fromEntries(outputLegs.map((leg) => [leg.typeID, leg.quantity])),
    reprocessedEvents: Array.isArray(options.reprocessedEvents)
      ? cloneValue(options.reprocessedEvents)
      : [],
    inputChanges: [],
    outputChanges: [],
    createdAt: new Date().toISOString(),
  };
  root.nextOperationID = operationSequence + 1;
  root.byCharacter[key] = settlement;
  const result = writeRoot(root);
  if (!result || result.success !== true) {
    return result || { success: false, errorMsg: "REPROCESSING_SETTLEMENT_WRITE_FAILED" };
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
    return {
      success: false,
      ambiguous: true,
      errorMsg: "ITEM_CUSTODY_NOT_DURABLE",
    };
  }
  return null;
}

function getResultItem(result) {
  return resolveCustodyResultItem(result);
}

function findEscrowItem(settlement, leg, kind) {
  const ownerID = toPositiveInt(leg && leg.ownerID, 0);
  const candidates = itemStore.listContainerItems(
    ownerID,
    settlement.escrowLocationID,
    0,
  ).filter((item) =>
    toPositiveInt(item && item.typeID, 0) === toPositiveInt(leg && leg.typeID, 0));
  if (kind === "input") {
    const assigned = new Set(
      settlement.inputLegs
        .filter((entry) => entry.legID !== leg.legID)
        .map((entry) => toPositiveInt(entry.escrowItemID, 0))
        .filter(Boolean),
    );
    return candidates
      .filter((item) => !assigned.has(toPositiveInt(item.itemID, 0)))
      .sort((left, right) => Number(left.itemID) - Number(right.itemID))[0] || null;
  }
  const assigned = new Set([
    ...settlement.inputLegs.map((entry) => toPositiveInt(entry.escrowItemID, 0)),
    ...settlement.outputLegs
      .filter((entry) => entry.legID !== leg.legID)
      .map((entry) => toPositiveInt(entry.escrowItemID, 0)),
  ].filter(Boolean));
  return candidates
    .filter((item) => !assigned.has(toPositiveInt(item.itemID, 0)))
    .sort((left, right) => Number(left.itemID) - Number(right.itemID))[0] || null;
}

function buildInputClientChanges(changes, settlement, leg) {
  const normalized = Array.isArray(changes) ? changes : [];
  const result = [];
  for (const change of normalized) {
    const item = change && change.item;
    const previousData = change && (change.previousData || change.previousState);
    const isEscrowDestination = Boolean(
      item &&
        toPositiveInt(item.locationID, 0) === settlement.escrowLocationID &&
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
      result.push({
        removed: true,
        previousData: cloneValue(previousData),
        item: null,
      });
    }
  }
  return result;
}

async function compensateRejectedSettlement(characterID) {
  let settlement = getPendingReprocessingSettlement(characterID);
  if (!settlement) {
    return { success: true, alreadySettled: true };
  }
  if (settlement.deliveryStarted) {
    return { success: false, errorMsg: "REPROCESSING_DELIVERY_ALREADY_STARTED" };
  }

  for (const candidate of [...settlement.outputLegs].reverse()) {
    settlement = getPendingReprocessingSettlement(characterID);
    const leg = settlement && settlement.outputLegs.find(
      (entry) => entry.legID === candidate.legID,
    );
    if (!settlement || !leg || !leg.granted || leg.revoked) {
      continue;
    }
    const result = reprocessingItemCustody.revokeOutput({
      actorID: settlement.characterID,
      ownerID: leg.ownerID,
      itemID: leg.escrowItemID,
      quantity: leg.quantity,
      escrowLocationID: settlement.escrowLocationID,
      idempotencyKey: leg.revokeKey,
    });
    const failure = durableCustodyFailure(result, "REPROCESSING_OUTPUT_REVOKE_FAILED");
    if (failure) {
      return failure;
    }
    const checkpoint = updateSettlement(characterID, (current) => ({
      ...current,
      outputLegs: current.outputLegs.map((entry) =>
        entry.legID === leg.legID ? { ...entry, revoked: true } : entry),
    }));
    if (!checkpoint.success) {
      return checkpoint;
    }
  }

  settlement = getPendingReprocessingSettlement(characterID);
  for (const candidate of [...settlement.inputLegs].reverse()) {
    settlement = getPendingReprocessingSettlement(characterID);
    const leg = settlement && settlement.inputLegs.find(
      (entry) => entry.legID === candidate.legID,
    );
    if (!settlement || !leg || !leg.staged || leg.returned || leg.committed) {
      continue;
    }
    const result = reprocessingItemCustody.returnInput({
      actorID: settlement.characterID,
      ownerID: leg.ownerID,
      itemID: leg.escrowItemID,
      quantity: leg.quantity,
      escrowLocationID: settlement.escrowLocationID,
      destinationLocationID: leg.sourceLocationID,
      destinationFlagID: leg.sourceFlagID,
      idempotencyKey: leg.returnKey,
    });
    const failure = durableCustodyFailure(result, "REPROCESSING_INPUT_RETURN_FAILED");
    if (failure) {
      return failure;
    }
    const checkpoint = updateSettlement(characterID, (current) => ({
      ...current,
      inputLegs: current.inputLegs.map((entry) =>
        entry.legID === leg.legID ? { ...entry, returned: true } : entry),
    }));
    if (!checkpoint.success) {
      return checkpoint;
    }
  }

  settlement = getPendingReprocessingSettlement(characterID);
  if (
    settlement &&
    settlement.ownerCorporationID > 0 &&
    settlement.totalCost > 0 &&
    settlement.ownerCreditApplied &&
    !settlement.ownerCreditReversed
  ) {
    const result = await adjustCorporationWalletDivisionBalanceAsync(
      settlement.ownerCorporationID,
      CORPORATION_WALLET_KEY_START,
      -settlement.totalCost,
      {
        idempotencyKey: settlement.ownerCreditReversalCommandID,
        description: "Reprocessing tax income reversal",
        entryTypeID: JOURNAL_ENTRY_TYPE.TRANSACTION_TAX,
        ownerID1: settlement.characterID,
        ownerID2: settlement.ownerCorporationID,
        referenceID: settlement.facilityLocationID,
      },
      {
        commandID: settlement.ownerCreditReversalCommandID,
        source: "reprocessing-owner-credit-reversal",
      },
    );
    if (!result || result.success !== true) {
      return result || { success: false, errorMsg: "REPROCESSING_CREDIT_REVERSAL_FAILED" };
    }
    const checkpoint = updateSettlement(characterID, (current) => ({
      ...current,
      ownerCreditReversed: true,
    }));
    if (!checkpoint.success) {
      return checkpoint;
    }
  }

  settlement = getPendingReprocessingSettlement(characterID);
  if (
    settlement &&
    settlement.totalCost > 0 &&
    settlement.debitApplied &&
    !settlement.debitRefunded
  ) {
    const result = await adjustCharacterBalanceAsync(
      settlement.characterID,
      settlement.totalCost,
      {
        idempotencyKey: settlement.refundCommandID,
        description: "Reprocessing tax refund",
        entryTypeID: JOURNAL_ENTRY_TYPE.TRANSACTION_TAX,
        ownerID1: settlement.characterID,
        ownerID2: settlement.ownerCorporationID,
        referenceID: settlement.facilityLocationID,
      },
      {
        commandID: settlement.refundCommandID,
        source: "reprocessing-tax-refund",
      },
    );
    if (!result || result.success !== true) {
      return result || { success: false, errorMsg: "REPROCESSING_REFUND_FAILED" };
    }
    const checkpoint = updateSettlement(characterID, (current) => ({
      ...current,
      debitRefunded: true,
    }));
    if (!checkpoint.success) {
      return checkpoint;
    }
  }

  settlement = getPendingReprocessingSettlement(characterID);
  if (!settlement) {
    return { success: true, alreadySettled: true };
  }
  const errorMsg = settlement.rejectionError || "REPROCESSING_REJECTED";
  const removed = finishSettlement(settlement, { success: true, rejected: true, errorMsg });
  if (!removed.success) {
    return removed;
  }
  retireOperationReceipts(settlement);
  return { success: true, rejected: true, errorMsg };
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

function resolveNotificationItem(change) {
  if (!change || typeof change !== "object") {
    return null;
  }
  if (change.item && typeof change.item === "object") {
    return change.item;
  }
  if (change.removed === true && change.previousData) {
    return itemStore.buildRemovedItemNotificationState(change.previousData);
  }
  return null;
}

function notifyInventoryChanges(settlement, result, preferredSession = null) {
  const characterState = require(path.join(__dirname, "../character/characterState"));
  if (typeof characterState.syncInventoryItemForSession !== "function") {
    return;
  }
  const sessions = new Set();
  if (preferredSession) {
    sessions.add(preferredSession);
  }
  for (const session of sessionRegistry.getSessions()) {
    if (toPositiveInt(session && session.characterID, 0) === settlement.characterID) {
      sessions.add(session);
    }
  }
  const changes = [
    ...(result.inputChanges || []),
    ...(result.outputChanges || []),
  ];
  for (const session of sessions) {
    for (const change of changes) {
      const item = resolveNotificationItem(change);
      if (item) {
        // TQ's OnItemsChanged (plural): the client's invCache turns it into
        // OnMultipleItemChange, which recounts item goals such as the career
        // Industry part 2 "Reprocess" (the minerals in hangar or ship).
        characterState.syncInventoryItemForSession(
          session,
          item,
          change.previousData || change.previousState || {},
          { emitItemsChangedBatch: true },
        );
      }
    }
  }
  // Once per settlement, outside the loop above. Reprocessing touches a
  // corporation division at both ends -- ore drawn out of one, minerals put
  // back into one -- and only the reprocessing character was ever told.
  fanCorporationOfficeInventoryChanges(changes, {
    actorSession: preferredSession || null,
    excludeSessions: [...sessions],
  });
}

function emitCompletion(settlement, result, options = {}) {
  if (options.notifyInventory !== false) {
    notifyInventoryChanges(settlement, result, options.preferredSession || null);
  }
  for (const event of settlement.reprocessedEvents || []) {
    publishReprocessedNotice(event, {
      publishGatewayNotice: options.publishGatewayNotice,
    });
  }
}

function recordAchievementReprocessing(settlement) {
  try {
    const achievementRuntime = require(path.join(
      __dirname,
      "../achievement/achievementRuntime",
    ));
    for (const [index, event] of (settlement.reprocessedEvents || []).entries()) {
      achievementRuntime.recordReprocessing(
        toPositiveInt(event && event.characterID, toPositiveInt(settlement.characterID, 0)),
        toPositiveInt(event && event.solarSystemID, 0),
        toPositiveInt(event && event.inputTypeID, 0),
        toPositiveInt(event && event.quantity, 0),
        { eventKey: `reprocessing:${settlement.operationID}:${index}` },
      );
    }
  } catch (achievementError) {
    log.debug(
      `[ReprocessingSettlement] achievement hook failed operation=${settlement.operationID}: ${achievementError.message}`,
    );
  }
}

function buildCompletionResult(settlement) {
  return {
    operationID: settlement.operationID,
    processedItemIDs: cloneValue(settlement.processedItemIDs || []),
    outputByTypeID: cloneValue(settlement.outputByTypeID || {}),
    inputChanges: cloneValue(settlement.inputChanges || []),
    outputChanges: cloneValue(settlement.outputChanges || []),
    outputLocationID: settlement.outputTarget.locationID,
    outputFlagID: settlement.outputTarget.flagID,
    outputOwnerID: settlement.outputTarget.ownerID,
    reprocessedEvents: cloneValue(settlement.reprocessedEvents || []),
  };
}

// A definitive (non-ambiguous) input commit is checkpointed committed so the
// settlement can finish rather than wedge forever, but the row it failed to
// consume is still sitting in the per-operation escrow location. The outputs
// were granted from the full input set and delivered before this point, so that
// leftover has already been paid for in minerals -- returning it to the owner
// would double-credit them. It is consumed instead, exactly as a successful
// commit would have, so the escrow ledger does not leak. Idempotent: a drained
// location is empty on the next pass.
// Every custody receipt an operation writes is only read again while its
// settlement record exists: a replay finds the record, and a new request mints
// a new sequence. Kept after that, they only grew the receipt ledger, and a
// community save carried 100,000 of them. Called once the record is gone; a
// failed retire leaves the receipts for the boot prune.
function retireOperationReceipts(settlement) {
  const keys = [];
  for (const leg of settlement.inputLegs || []) {
    keys.push(leg.stageKey, leg.returnKey, leg.commitKey);
    const escrowItemID = toPositiveInt(leg.escrowItemID, 0);
    if (escrowItemID) {
      keys.push(
        `${DURABLE_SETTLEMENT_JOB_PREFIX}${settlement.operationID}:escrow-drain:${escrowItemID}`,
      );
    }
  }
  for (const leg of settlement.outputLegs || []) {
    keys.push(leg.grantKey, leg.deliverKey, leg.revokeKey);
  }
  try {
    const result = reprocessingItemCustody.retireReceipts(keys.filter(Boolean));
    if (!result || result.success !== true) {
      log.warn(
        `[ReprocessingSettlement] could not retire receipts operation=` +
          `${settlement.operationID}: ${(result && result.errorMsg) || "custody error"}`,
      );
    }
  } catch (error) {
    log.warn(
      `[ReprocessingSettlement] could not retire receipts operation=` +
        `${settlement.operationID}: ${error.message}`,
    );
  }
}

// The receipts of operations that finished before retireOperationReceipts
// existed, or whose retire was lost to a crash. Runs at boot before the escrow
// sweep, so the sweep receipts it drops are all from earlier processes. A throw
// at startup would stop the server booting, so failures are only logged.
function pruneFinishedOperationReceipts() {
  let result = null;
  try {
    const pendingOperationIDs = new Set(
      listPendingReprocessingSettlements().map((settlement) => String(settlement.operationID)),
    );
    result = reprocessingItemCustody.pruneReceipts((idempotencyKey) => {
      if (!idempotencyKey.startsWith(DURABLE_SETTLEMENT_JOB_PREFIX)) {
        return false;
      }
      const rest = idempotencyKey.slice(DURABLE_SETTLEMENT_JOB_PREFIX.length);
      if (rest.startsWith("escrow-sweep:")) {
        return true;
      }
      const match = /^(\d+:\d+):/.exec(rest);
      return Boolean(match) && !pendingOperationIDs.has(match[1]);
    });
  } catch (error) {
    result = { success: false, errorMsg: error.message };
  }
  if (!result || result.success !== true) {
    log.warn(
      `[ReprocessingSettlement] could not prune finished operation receipts: ` +
        `${(result && result.errorMsg) || "custody error"}`,
    );
    return 0;
  }
  return result.removed;
}

function drainOperationEscrowLeftovers(settlement) {
  const ownerIDs = new Set(
    settlement.inputLegs.map((leg) => toPositiveInt(leg.ownerID, 0)).filter(Boolean),
  );
  for (const ownerID of ownerIDs) {
    const leftovers = itemStore.listContainerItems(
      ownerID,
      settlement.escrowLocationID,
      0,
    );
    for (const item of leftovers) {
      const itemID = toPositiveInt(item && item.itemID, 0);
      const quantity = toPositiveInt(item && item.quantity, 0);
      if (!itemID || !quantity) {
        continue;
      }
      const result = reprocessingItemCustody.commitInput({
        actorID: settlement.characterID,
        ownerID,
        itemID,
        quantity,
        escrowLocationID: settlement.escrowLocationID,
        idempotencyKey:
          `${DURABLE_SETTLEMENT_JOB_PREFIX}${settlement.operationID}:escrow-drain:${itemID}`,
      });
      const failure = durableCustodyFailure(result, "REPROCESSING_ESCROW_DRAIN_FAILED");
      if (failure) {
        // Ambiguous -> let the durable retry drain it on the next pass. A
        // definitive failure is logged and left for the boot sweeper rather
        // than wedging a settlement whose money and outputs are already done.
        if (failure.ambiguous === true) {
          return failure;
        }
        log.warn(
          `[ReprocessingSettlement] could not consume stranded escrow row ` +
            `operation=${settlement.operationID} item=${itemID}: ${failure.errorMsg}`,
        );
        continue;
      }
      log.warn(
        `[ReprocessingSettlement] consumed stranded escrow row operation=` +
          `${settlement.operationID} item=${itemID} quantity=${quantity}: an input ` +
          `commit failed definitively but its output had already been delivered`,
      );
    }
  }
  return null;
}

async function settleReprocessingInternal(characterID, options = {}) {
  let settlement = getPendingReprocessingSettlement(characterID);
  if (!settlement) {
    return { success: true, alreadySettled: true, data: null };
  }
  if (settlement.rejectionError) {
    return compensateRejectedSettlement(characterID);
  }

  if (!settlement.debitApplied) {
    const result = await adjustCharacterBalanceAsync(
      settlement.characterID,
      -settlement.totalCost,
      {
        idempotencyKey: settlement.debitCommandID,
        description: settlement.walletDescription,
        entryTypeID: JOURNAL_ENTRY_TYPE.TRANSACTION_TAX,
        ownerID1: settlement.characterID,
        ownerID2: settlement.ownerCorporationID,
        referenceID: settlement.facilityLocationID,
      },
      {
        commandID: settlement.debitCommandID,
        source: "reprocessing-tax-debit",
      },
    );
    if (!result || result.success !== true) {
      const errorMsg = result && result.errorMsg || "REPROCESSING_DEBIT_FAILED";
      return DEFINITIVE_WALLET_ERRORS.has(errorMsg)
        ? rejectSettlement(characterID, errorMsg)
        : result || { success: false, errorMsg };
    }
    const checkpoint = updateSettlement(characterID, (current) => ({
      ...current,
      debitApplied: true,
    }));
    if (!checkpoint.success) {
      return checkpoint;
    }
  }

  settlement = getPendingReprocessingSettlement(characterID);
  for (const candidate of settlement.inputLegs) {
    settlement = getPendingReprocessingSettlement(characterID);
    const leg = settlement && settlement.inputLegs.find(
      (entry) => entry.legID === candidate.legID,
    );
    if (!settlement || !leg || leg.staged) {
      continue;
    }
    const result = reprocessingItemCustody.stageInput({
      actorID: settlement.characterID,
      ownerID: leg.ownerID,
      itemID: leg.itemID,
      quantity: leg.quantity,
      sourceLocationID: leg.sourceLocationID,
      sourceFlagID: leg.sourceFlagID,
      escrowLocationID: settlement.escrowLocationID,
      idempotencyKey: leg.stageKey,
    });
    const failure = durableCustodyFailure(result, "REPROCESSING_INPUT_STAGE_FAILED");
    if (failure) {
      return failure.ambiguous === true
        ? failure
        : rejectSettlement(characterID, failure.errorMsg || "INSUFFICIENT_ITEMS");
    }
    const movedItem = getResultItem(result) || findEscrowItem(settlement, leg, "input");
    if (!movedItem) {
      // The stage replayed but its row is no longer in escrow. If this leg's
      // commit already ran, the input was consumed as designed and only the
      // checkpoint was lost — record that instead of retrying a move whose
      // source no longer exists.
      if (custodyStepCommitted(leg.commitKey)) {
        const recovered = updateSettlement(characterID, (current) => ({
          ...current,
          inputLegs: current.inputLegs.map((entry) =>
            entry.legID === leg.legID
              ? { ...entry, staged: true, committed: true, commitError: null }
              : entry),
        }));
        if (!recovered.success) {
          return recovered;
        }
        continue;
      }
      reportUnresolvedLeg({
        scope: "ReprocessingSettlement",
        operationID: settlement.operationID,
        step: "input-stage",
        legID: leg.legID,
        errorMsg: "REPROCESSING_ESCROW_ITEM_UNKNOWN",
      });
      return { success: false, ambiguous: true, errorMsg: "REPROCESSING_ESCROW_ITEM_UNKNOWN" };
    }
    const checkpoint = updateSettlement(characterID, (current) => ({
      ...current,
      inputLegs: current.inputLegs.map((entry) =>
        entry.legID === leg.legID
          ? {
              ...entry,
              staged: true,
              escrowItemID: toPositiveInt(movedItem.itemID, 0),
              changes: cloneValue((result.data && result.data.changes) || []),
            }
          : entry),
      inputChanges: [
        ...(current.inputChanges || []),
        ...buildInputClientChanges(
          (result.data && result.data.changes) || [],
          settlement,
          leg,
        ),
      ],
    }));
    if (!checkpoint.success) {
      return checkpoint;
    }
  }

  settlement = getPendingReprocessingSettlement(characterID);
  for (const candidate of settlement.outputLegs) {
    settlement = getPendingReprocessingSettlement(characterID);
    const leg = settlement && settlement.outputLegs.find(
      (entry) => entry.legID === candidate.legID,
    );
    if (!settlement || !leg || leg.granted) {
      continue;
    }
    const result = reprocessingItemCustody.grantOutput({
      actorID: settlement.characterID,
      ownerID: leg.ownerID,
      typeID: leg.typeID,
      quantity: leg.quantity,
      escrowLocationID: settlement.escrowLocationID,
      idempotencyKey: leg.grantKey,
    });
    const failure = durableCustodyFailure(result, "REPROCESSING_OUTPUT_GRANT_FAILED");
    if (failure) {
      return failure.ambiguous === true
        ? failure
        : rejectSettlement(characterID, failure.errorMsg || "REPROCESSING_OUTPUT_GRANT_FAILED");
    }
    const grantedItem = getResultItem(result) || findEscrowItem(settlement, leg, "output");
    if (!grantedItem) {
      // Same recovery on the output side: a grant that replays with no row in
      // escrow, whose delivery already committed, is a finished leg with a lost
      // checkpoint. Take the client changes from the delivery receipt so the
      // player still sees the minerals land.
      if (custodyStepCommitted(leg.deliverKey)) {
        const recoveredChanges = custodyStepChanges(leg.deliverKey);
        const recovered = updateSettlement(characterID, (current) => ({
          ...current,
          deliveryStarted: true,
          outputLegs: current.outputLegs.map((entry) =>
            entry.legID === leg.legID
              ? {
                  ...entry,
                  granted: true,
                  delivered: true,
                  changes: cloneValue(recoveredChanges),
                }
              : entry),
          outputChanges: [
            ...(current.outputChanges || []),
            ...cloneValue(recoveredChanges),
          ],
        }));
        if (!recovered.success) {
          return recovered;
        }
        continue;
      }
      reportUnresolvedLeg({
        scope: "ReprocessingSettlement",
        operationID: settlement.operationID,
        step: "output-grant",
        legID: leg.legID,
        errorMsg: "REPROCESSING_OUTPUT_ITEM_UNKNOWN",
      });
      return { success: false, ambiguous: true, errorMsg: "REPROCESSING_OUTPUT_ITEM_UNKNOWN" };
    }
    const checkpoint = updateSettlement(characterID, (current) => ({
      ...current,
      outputLegs: current.outputLegs.map((entry) =>
        entry.legID === leg.legID
          ? {
              ...entry,
              granted: true,
              escrowItemID: toPositiveInt(grantedItem.itemID, 0),
            }
          : entry),
    }));
    if (!checkpoint.success) {
      return checkpoint;
    }
  }

  settlement = getPendingReprocessingSettlement(characterID);
  for (const candidate of settlement.outputLegs) {
    settlement = getPendingReprocessingSettlement(characterID);
    const leg = settlement && settlement.outputLegs.find(
      (entry) => entry.legID === candidate.legID,
    );
    if (!settlement || !leg || leg.delivered) {
      continue;
    }
    if (!settlement.deliveryStarted) {
      const started = updateSettlement(characterID, (current) => ({
        ...current,
        deliveryStarted: true,
      }));
      if (!started.success) {
        return started;
      }
      settlement = getPendingReprocessingSettlement(characterID);
    }
    const result = reprocessingItemCustody.deliverOutput({
      actorID: settlement.characterID,
      ownerID: leg.ownerID,
      itemID: leg.escrowItemID,
      quantity: leg.quantity,
      escrowLocationID: settlement.escrowLocationID,
      destinationLocationID: leg.destinationLocationID,
      destinationFlagID: leg.destinationFlagID,
      idempotencyKey: leg.deliverKey,
    });
    const failure = durableCustodyFailure(result, "REPROCESSING_OUTPUT_DELIVERY_FAILED");
    if (failure) {
      return failure;
    }
    const checkpoint = updateSettlement(characterID, (current) => ({
      ...current,
      outputLegs: current.outputLegs.map((entry) =>
        entry.legID === leg.legID
          ? {
              ...entry,
              delivered: true,
              changes: cloneValue((result.data && result.data.changes) || []),
            }
          : entry),
      outputChanges: [
        ...(current.outputChanges || []),
        ...cloneValue((result.data && result.data.changes) || []),
      ],
    }));
    if (!checkpoint.success) {
      return checkpoint;
    }
  }

  settlement = getPendingReprocessingSettlement(characterID);
  for (const candidate of settlement.inputLegs) {
    settlement = getPendingReprocessingSettlement(characterID);
    const leg = settlement && settlement.inputLegs.find(
      (entry) => entry.legID === candidate.legID,
    );
    if (!settlement || !leg || leg.committed) {
      continue;
    }
    const result = reprocessingItemCustody.commitInput({
      actorID: settlement.characterID,
      ownerID: leg.ownerID,
      itemID: leg.escrowItemID,
      quantity: leg.quantity,
      escrowLocationID: settlement.escrowLocationID,
      idempotencyKey: leg.commitKey,
    });
    const failure = durableCustodyFailure(result, "REPROCESSING_INPUT_COMMIT_FAILED");
    if (failure && failure.ambiguous === true) {
      return failure;
    }
    const checkpoint = updateSettlement(characterID, (current) => ({
      ...current,
      inputLegs: current.inputLegs.map((entry) =>
        entry.legID === leg.legID
          ? {
              ...entry,
              committed: true,
              commitError: failure ? failure.errorMsg : null,
            }
          : entry),
    }));
    if (!checkpoint.success) {
      return checkpoint;
    }
  }

  settlement = getPendingReprocessingSettlement(characterID);
  if (!settlement.ownerCreditApplied) {
    const result = await adjustCorporationWalletDivisionBalanceAsync(
      settlement.ownerCorporationID,
      CORPORATION_WALLET_KEY_START,
      settlement.totalCost,
      {
        idempotencyKey: settlement.ownerCreditCommandID,
        description: "Reprocessing tax income",
        entryTypeID: JOURNAL_ENTRY_TYPE.TRANSACTION_TAX,
        ownerID1: settlement.characterID,
        ownerID2: settlement.ownerCorporationID,
        referenceID: settlement.facilityLocationID,
      },
      {
        commandID: settlement.ownerCreditCommandID,
        source: "reprocessing-owner-credit",
      },
    );
    if (!result || result.success !== true) {
      const errorMsg = result && result.errorMsg || "REPROCESSING_OWNER_CREDIT_FAILED";
      if (!DEFINITIVE_WALLET_ERRORS.has(errorMsg)) {
        return result || { success: false, errorMsg };
      }
      const checkpoint = updateSettlement(characterID, (current) => ({
        ...current,
        ownerCreditApplied: true,
        ownerCreditError: errorMsg,
      }));
      if (!checkpoint.success) {
        return checkpoint;
      }
    } else {
      const checkpoint = updateSettlement(characterID, (current) => ({
        ...current,
        ownerCreditApplied: true,
      }));
      if (!checkpoint.success) {
        return checkpoint;
      }
    }
  }

  settlement = getPendingReprocessingSettlement(characterID);
  if (!settlement) {
    return { success: true, alreadySettled: true, data: null };
  }
  const drainFailure = drainOperationEscrowLeftovers(settlement);
  if (drainFailure) {
    return drainFailure;
  }
  const completion = buildCompletionResult(settlement);
  // The operation is already durable at this point. Record before deleting the
  // settlement so recovery can safely replay the hook; the operation-scoped
  // key in achievement state prevents cumulative progress from double-counting.
  const careerEvidence = require("../career/careerIndustrySources").recordReprocessing(settlement);
  if (!careerEvidence?.success) return careerEvidence || { success: false, errorMsg: "CAREER_REPROCESSING_FAILED" };
  recordAchievementReprocessing(settlement);
  const removed = finishSettlement(settlement, { success: true, data: completion });
  if (!removed.success) {
    return removed;
  }
  retireOperationReceipts(settlement);
  emitCompletion(settlement, completion, options);
  return { success: true, data: completion };
}

function settleReprocessingSettlement(characterID, options = {}) {
  return runSerialized(characterID, () =>
    settleReprocessingInternal(characterID, options));
}

// Completion and the producer watermark share a table transaction. The crew
// may lose its reply or restart after the native scheduler finished the job.
function finishSettlement(settlement, result) {
  const root = readRoot(), key = String(settlement.characterID);
  if (root.byCharacter[key]?.operationID !== settlement.operationID) return { success: false, errorMsg: "REPROCESSING_COMPLETION_CONFLICT" };
  if (settlement.crewOrder) {
    const custodyKeys = [...settlement.inputLegs.flatMap(leg => [leg.stageKey, leg.returnKey, leg.commitKey]),
      ...settlement.outputLegs.flatMap(leg => [leg.grantKey, leg.deliverKey, leg.revokeKey])];
    root.crewReceipts[key] = { ...settlement.crewOrder, requestFingerprint: settlement.requestFingerprint,
      operationID: settlement.operationID, custodyKeys,
      result: result.rejected ? result : { success: true, data: { operationID: settlement.operationID,
        outputByTypeID: cloneValue(settlement.outputByTypeID), processedItemIDs: cloneValue(settlement.processedItemIDs) } } };
  }
  delete root.byCharacter[key];
  return writeRoot(root);
}
function getCrewReprocessingResult(characterID, jobID, serial) {
  const receipt = readRoot().crewReceipts[String(characterID)];
  return receipt?.jobID === jobID && receipt.serial === serial ? cloneValue(receipt.result) : null;
}
function acknowledgeCrewReprocessing(characterID, jobID, serial) {
  const root = readRoot(), receipt = root.crewReceipts[String(characterID)];
  if (!receipt || receipt.jobID !== jobID || receipt.serial !== serial || root.byCharacter[String(characterID)]?.crewOrder?.jobID === jobID) {
    return { success: false, errorMsg: "CREW_REPROCESSING_ACK_CONFLICT" };
  }
  const hash = key => require("node:crypto").createHash("sha256").update(key).digest("hex");
  const keys = new Set([`crew-refine:${jobID}:reserve`, `crew-refine:${jobID}:return`,
    ...(receipt.custodyKeys || []).map(key => `item-custody:local:${hash(key)}`)]);
  const pruned = itemStore.pruneIdempotentGrantReceipts(value => keys.has(value.receiptKey));
  if (!pruned.success || !database.flushTableSync("items").success) return { success: false, errorMsg: "CREW_REPROCESSING_ACK_PENDING" };
  delete receipt.custodyKeys;
  return writeRoot(root);
}

function bindDurableScheduler(scheduler) {
  if (!scheduler || typeof scheduler.schedule !== "function") {
    throw new TypeError("reprocessing scheduler requires schedule");
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

async function handleDurableReprocessingSettlement(job = {}) {
  const characterID = toPositiveInt(job.payload && job.payload.characterID, 0);
  if (!characterID) {
    throw new Error("reprocessing settlement job is invalid");
  }
  const result = await settleReprocessingSettlement(characterID);
  if (!result || result.success !== true) {
    const errorMsg = result && result.errorMsg || "reprocessing settlement failed";
    reportSettlementRetry({
      scope: "ReprocessingSettlement",
      attempt: job.attempt,
      ownerID: characterID,
      errorMsg,
    });
    throw new Error(errorMsg);
  }
  return result;
}

// A per-operation escrow location can only be reached through its settlement
// record; once the record is gone, anything left in the range is unreachable
// forever -- no player inventory view lists it and, until this pass, no sweeper
// covered it (the market boot sweep is bounded to its own 9.2B slot). A stranded
// row is an input whose output was already delivered, so it is consumed, not
// returned. Idempotent by construction: a consumed row leaves the range, and a
// clean store sweeps nothing.
function sweepStrandedReprocessingEscrowItems() {
  const liveLocations = new Set(
    listPendingReprocessingSettlements()
      .map((settlement) => toPositiveInt(settlement.escrowLocationID, 0))
      .filter(Boolean),
  );
  let recovered = 0;
  for (const item of Object.values(itemStore.getAllItems() || {})) {
    const locationID = toPositiveInt(item && item.locationID, 0);
    if (locationID <= ESCROW_LOCATION_BASE || locationID >= ESCROW_LOCATION_LIMIT) {
      continue;
    }
    if (liveLocations.has(locationID)) {
      // A live settlement still owns this location; its own commit, drain or
      // rejection path is responsible for the row.
      continue;
    }
    const ownerID = toPositiveInt(item && item.ownerID, 0);
    const itemID = toPositiveInt(item && item.itemID, 0);
    const quantity = toPositiveInt(item && item.quantity, 0);
    if (!ownerID || !itemID || !quantity) {
      continue;
    }
    const result = reprocessingItemCustody.commitInput({
      actorID: ownerID,
      ownerID,
      itemID,
      quantity,
      escrowLocationID: locationID,
      idempotencyKey: `${DURABLE_SETTLEMENT_JOB_PREFIX}escrow-sweep:${locationID}:${itemID}`,
    });
    if (!result || result.success !== true) {
      log.warn(
        `[ReprocessingSettlement] stranded escrow sweep failed location=${locationID} ` +
          `item=${itemID}: ${(result && result.errorMsg) || "custody error"}`,
      );
      continue;
    }
    recovered += 1;
    log.warn(
      `[ReprocessingSettlement] swept stranded reprocessing escrow location=` +
        `${locationID} owner=${ownerID} item=${itemID} quantity=${quantity}`,
    );
  }
  return { recovered };
}

// `reprocessing-settlement:<characterID>:<operationSequence>:<leg>`.
const SEQUENCE_DOMAIN = registerSettlementSequenceDomain(
  "reprocessing-settlement",
  /^reprocessing-settlement:\d+:(\d+):/,
);

function advanceOperationSequenceWatermark(receiptScan) {
  return advanceSettlementSequenceWatermark({
    logTag: "[ReprocessingSettlement]",
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
      listPendingReprocessingSettlements().map(
        (settlement) => settlement.operationSequence,
      ),
  });
}

async function reconcileDurableReprocessingSettlements(options = {}) {
  advanceOperationSequenceWatermark(options.receiptScan);
  const pruned = pruneFinishedOperationReceipts();
  const pending = listPendingReprocessingSettlements();
  if (durableScheduler) {
    await Promise.all(pending.map((settlement) =>
      scheduleSettlement(settlement.characterID)));
  }
  // Runs after scheduling so every pending settlement's location is still owned
  // by a live record; whatever remains in the range then has no record to
  // reclaim it and is swept.
  const swept = sweepStrandedReprocessingEscrowItems();
  return {
    scheduled: durableScheduler ? pending.length : 0,
    pending: pending.length,
    swept: swept.recovered,
    prunedReceipts: pruned,
  };
}

module.exports = {
  getCrewReprocessingResult,
  acknowledgeCrewReprocessing,
  DURABLE_SETTLEMENT_JOB_TYPE,
  ESCROW_LOCATION_BASE,
  ESCROW_LOCATION_LIMIT,
  TABLE_NAME,
  bindDurableScheduler,
  buildSettlementJob,
  getPendingReprocessingSettlement,
  handleDurableReprocessingSettlement,
  listPendingReprocessingSettlements,
  prepareReprocessingSettlement,
  reconcileDurableReprocessingSettlements,
  settleReprocessingSettlement,
  sweepStrandedReprocessingEscrowItems,
  unbindDurableScheduler,
};
