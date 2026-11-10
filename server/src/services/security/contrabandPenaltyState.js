"use strict";

const {
  cloneValue,
} = require("../../common/clone");

const crypto = require("node:crypto");
const path = require("node:path");
const { isDeepStrictEqual } = require("node:util");

const database = require(path.join(__dirname, "../../gameStore"));
const log = require(path.join(__dirname, "../../utils/logger"));
const {
  JOURNAL_ENTRY_TYPE,
  adjustCharacterBalanceAsync,
  getCharacterWallet,
} = require(path.join(__dirname, "../account/walletState"));
const {
  EVENT_STANDING_CONTRABAND_TRAFFICKING,
  applyStandingChanges,
} = require(path.join(__dirname, "../character/standingRuntime"));
const sessionRegistry = require(path.join(__dirname, "../chat/sessionRegistry"));
const itemStore = require(path.join(__dirname, "../inventory/itemStore"));
const contrabandItemCustody = require(path.join(
  __dirname,
  "../inventory/contrabandItemCustody",
));

const TABLE_NAME = "contrabandPenalties";
const ROOT_VERSION = 1;
const DURABLE_SETTLEMENT_JOB_TYPE = "contraband.penalty-settle";
const DURABLE_SETTLEMENT_JOB_PREFIX = "contraband-penalty:";
const settlementLanes = new Map();
let durableScheduler = null;

function toPositiveInt(value, fallback = 0) {
  const numeric = Math.trunc(Number(value) || 0);
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : fallback;
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
    // Detached: gameStore.read returns the live cache object, and writeRoot's
    // change detection compares against that same object. Mutating it in place
    // makes every write look unchanged, so the table stays right in memory and
    // never reaches disk.
    byOperationID:
      root.byOperationID && typeof root.byOperationID === "object"
        ? cloneValue(root.byOperationID)
        : {},
  };
}

function writeRoot(root) {
  database.ensureTable(TABLE_NAME);
  const result = database.write(TABLE_NAME, "/", {
    version: ROOT_VERSION,
    byOperationID: cloneValue(root.byOperationID || {}),
  });
  if (!result || result.success !== true) {
    return result || { success: false, errorMsg: "WRITE_ERROR" };
  }
  const flushResult = database.flushTableSync(TABLE_NAME);
  return flushResult && flushResult.success
    ? result
    : flushResult || { success: false, errorMsg: "FLUSH_ERROR" };
}

function getPendingContrabandPenalty(operationID) {
  const key = String(operationID || "").trim();
  return cloneValue(readRoot().byOperationID[key] || null);
}

function listPendingContrabandPenalties() {
  return Object.values(readRoot().byOperationID)
    .filter((settlement) => settlement && !settlement.completed && !(
      settlement.deferConfiscation === true &&
      settlement.confiscationDisposition === "pending" &&
      settlement.walletApplied && settlement.standingApplied
    ))
    .map(cloneValue)
    .sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)));
}

function updateSettlement(operationID, updater) {
  const root = readRoot();
  const key = String(operationID || "").trim();
  const current = root.byOperationID[key];
  if (!current) {
    return { success: false, errorMsg: "PENALTY_NOT_FOUND" };
  }
  const next = typeof updater === "function"
    ? updater(cloneValue(current))
    : current;
  if (next === null) {
    delete root.byOperationID[key];
  } else {
    root.byOperationID[key] = cloneValue(next);
  }
  const result = writeRoot(root);
  return result && result.success
    ? { success: true, data: cloneValue(next) }
    : result || { success: false, errorMsg: "PENALTY_WRITE_FAILED" };
}

function buildSettlementJob(operationID) {
  const key = String(operationID || "").trim();
  return key
    ? {
        jobID: `${DURABLE_SETTLEMENT_JOB_PREFIX}${key}`,
        type: DURABLE_SETTLEMENT_JOB_TYPE,
        dueAtMs: Date.now(),
        payload: { operationID: key },
      }
    : null;
}

async function scheduleSettlement(operationID) {
  const job = buildSettlementJob(operationID);
  if (!job || !durableScheduler) {
    return null;
  }
  await durableScheduler.schedule(job);
  return job;
}

function queueSettlement(operationID) {
  if (!durableScheduler) {
    return;
  }
  void scheduleSettlement(operationID).catch((error) => {
    log.warn(
      `[ContrabandPenalty] scheduling failed operation=${operationID}: ${error.message}`,
    );
  });
}

function normalizeEntry(entry, index, operationID) {
  const item = entry && entry.item && typeof entry.item === "object"
    ? entry.item
    : {};
  const itemID = toPositiveInt(entry && entry.itemID, toPositiveInt(item.itemID, 0));
  const quantity = toPositiveInt(entry && entry.quantity, 0);
  return {
    legID: index + 1,
    itemID,
    typeID: toPositiveInt(entry && entry.typeID, toPositiveInt(item.typeID, 0)),
    quantity,
    locationID: toPositiveInt(item.locationID, 0),
    flagID: Math.max(0, Math.trunc(Number(item.flagID) || 0)),
    previousData: cloneValue(item),
    ...(Number.isSafeInteger(item.inventoryCustodyRevision) && item.inventoryCustodyRevision >= 0
      ? { observedCustodyRevision: item.inventoryCustodyRevision } : {}),
    confiscateKey: `contraband-penalty:${operationID}:item:${index + 1}`,
    applied: false,
    failed: false,
    errorMsg: null,
    changes: [],
  };
}

function prepareContrabandPenalty(options = {}) {
  const characterID = toPositiveInt(options.characterID, 0);
  const shipID = toPositiveInt(options.shipID, 0);
  const authority = options.authority && typeof options.authority === "object"
    ? cloneValue(options.authority)
    : null;
  const entries = Array.isArray(options.entries) ? options.entries : [];
  const totalFine = roundMoney(options.totalFine);
  const standingLoss = Math.max(0, Number(options.standingLoss) || 0);
  if (!characterID || !shipID || !authority || !entries.length) {
    return { success: false, errorMsg: "INVALID_CONTRABAND_PENALTY" };
  }

  const operationID = options.operationID === undefined
    ? crypto.randomUUID()
    : String(options.operationID || "").trim();
  if (!operationID || operationID.length > 512) {
    return { success: false, errorMsg: "INVALID_CONTRABAND_OPERATION_ID" };
  }
  const itemLegs = entries.map((entry, index) =>
    normalizeEntry(entry, index, operationID));
  if (itemLegs.some((leg) => !leg.itemID || !leg.quantity || !leg.locationID)) {
    return { success: false, errorMsg: "INVALID_CONTRABAND_ITEM" };
  }
  const requestFingerprint = {
    characterID, shipID, authority, itemLegs, totalFine, standingLoss,
    disableDerivedStandings: options.disableDerivedStandings !== false,
    deferConfiscation: options.deferConfiscation === true,
  };
  const root = readRoot();
  const existing = root.byOperationID[operationID];
  if (existing) {
    return isDeepStrictEqual(existing.requestFingerprint, requestFingerprint)
      ? { success: true, duplicate: true, data: cloneValue(existing) }
      : { success: false, errorMsg: "CONTRABAND_OPERATION_MISMATCH" };
  }
  const wallet = getCharacterWallet(characterID);
  const chargedFine = wallet
    ? roundMoney(Math.min(Math.max(0, Number(wallet.balance) || 0), totalFine))
    : 0;
  const settlement = {
    operationID,
    characterID,
    shipID,
    authority,
    entries: entries.map((entry) => ({
      itemID: toPositiveInt(entry && entry.itemID, 0),
      typeID: toPositiveInt(entry && entry.typeID, 0),
      quantity: toPositiveInt(entry && entry.quantity, 0),
      fine: roundMoney(entry && entry.fine),
      standingLoss: Math.max(0, Number(entry && entry.standingLoss) || 0),
    })),
    itemLegs,
    requestFingerprint: cloneValue(requestFingerprint),
    deferConfiscation: options.deferConfiscation === true,
    confiscationDisposition: options.deferConfiscation === true ? "pending" : "requested",
    totalFine,
    predictedChargedFine: chargedFine,
    actualChargedFine: null,
    standingLoss,
    disableDerivedStandings: options.disableDerivedStandings !== false,
    walletCommandID: `contraband-penalty:${operationID}:wallet`,
    standingKey: `contraband-penalty:${operationID}:standing`,
    walletApplied: false,
    walletResult: null,
    walletError: null,
    standingApplied: false,
    standingResult: null,
    createdAt: new Date().toISOString(),
  };
  root.byOperationID[operationID] = settlement;
  const result = writeRoot(root);
  if (!result || result.success !== true) {
    return result || { success: false, errorMsg: "PENALTY_WRITE_FAILED" };
  }
  queueSettlement(operationID);
  return { success: true, data: cloneValue(settlement) };
}

function runSerialized(operationID, operation) {
  const laneKey = String(operationID || "").trim();
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

function notifyInventoryChanges(characterID, changes = []) {
  const normalizedChanges = Array.isArray(changes) ? changes : [];
  if (!normalizedChanges.length) {
    return;
  }
  const characterState = require(path.join(
    __dirname,
    "../character/characterState",
  ));
  if (typeof characterState.syncInventoryItemForSession !== "function") {
    return;
  }
  for (const session of sessionRegistry.getSessions()) {
    if (toPositiveInt(session && session.characterID, 0) !== characterID) {
      continue;
    }
    for (const change of normalizedChanges) {
      const item = resolveNotificationItem(change);
      if (item) {
        characterState.syncInventoryItemForSession(
          session,
          item,
          change.previousData || change.previousState || {},
        );
      }
    }
  }
}

function buildPenaltyResult(settlement) {
  const changes = settlement.itemLegs.flatMap((leg) => leg.changes || []);
  const removedItems = changes
    .filter((change) => change && change.removed === true && change.previousData)
    .map((change) => cloneValue(change.previousData));
  const removalErrors = settlement.itemLegs
    .filter((leg) => leg.failed)
    .map((leg) => ({ itemID: leg.itemID, errorMsg: leg.errorMsg }));
  const chargedFine = roundMoney(settlement.actualChargedFine || 0);
  return {
    operationID: settlement.operationID,
    pending: false,
    sanctionsCommitted: settlement.walletApplied && settlement.standingApplied,
    awaitingConfiscation: settlement.deferConfiscation === true &&
      settlement.confiscationDisposition === "pending",
    confiscationDisposition: settlement.confiscationDisposition || "requested",
    removedItems,
    removedChanges: changes,
    removalErrors,
    walletResult: cloneValue(settlement.walletResult),
    standingResult: cloneValue(settlement.standingResult),
    totalFine: settlement.totalFine,
    chargedFine,
    unpaidFine: roundMoney(settlement.totalFine - chargedFine),
    standingLoss: settlement.standingLoss,
  };
}

function settleItemLegs(operationID) {
  let settlement = getPendingContrabandPenalty(operationID);
  if (!settlement) {
    return { success: true, alreadySettled: true };
  }

  for (const candidate of settlement.itemLegs) {
    settlement = getPendingContrabandPenalty(operationID);
    let leg = settlement && settlement.itemLegs.find(
      (entry) => entry.legID === candidate.legID,
    );
    if (!settlement || !leg || leg.applied || leg.failed || leg.skipped) {
      continue;
    }
    if (settlement.deferConfiscation === true) {
      // An accepted decision freezes approval, not future replacement cargo.
      // Replan only after the custody owner confirms no command committed;
      // uncertain receipts must retain the frozen command for recovery.
      const receipt = contrabandItemCustody.getConfiscationReceipt(leg.confiscateKey);
      if (receipt.success === false) return receipt;
      if (!receipt.committed) {
        const limit = Math.min(leg.confiscationLimit ?? leg.quantity,
          leg.effectiveConfiscationLimit ?? leg.confiscationLimit ?? leg.quantity);
        if (limit === 0) {
          const skipped = updateSettlement(operationID, (record) => ({
            ...record,
            itemLegs: record.itemLegs.map((entry) => entry.legID === leg.legID
              ? { ...entry, confiscationQuantity: 0, skipped: true }
              : entry),
          }));
          if (!skipped.success) return skipped;
          continue;
        }
        const current = contrabandItemCustody.revalidateItem({
          characterID: settlement.characterID,
          itemID: leg.itemID,
          typeID: leg.typeID,
          locationID: leg.locationID,
          flagID: leg.flagID,
          quantity: limit,
          singleton: leg.previousData.singleton,
          observedCustodyRevision: leg.observedCustodyRevision,
        });
        const lineageGap = current.errorMsg === "CONTRABAND_CUSTODY_REVISION_MISMATCH";
        const planned = updateSettlement(operationID, (record) => ({
          ...record,
          itemLegs: record.itemLegs.map((entry) => entry.legID === leg.legID
            ? {
                ...entry,
                confiscationQuantity: current.success ? current.data.quantity : 0,
                failed: !current.success && !lineageGap,
                errorMsg: current.success || lineageGap ? null : current.errorMsg,
                ...(lineageGap ? { effectiveConfiscationLimit: 0, skipped: true, lineageGap: true } : {}),
              }
            : entry),
        }));
        if (!planned.success) return planned;
        leg = planned.data.itemLegs.find((entry) => entry.legID === leg.legID);
        if (leg.failed || leg.skipped) continue;
      }
    }
    const result = contrabandItemCustody.confiscateItem({
      operationID,
      characterID: settlement.characterID,
      itemID: leg.itemID,
      locationID: leg.locationID,
      flagID: leg.flagID,
      typeID: leg.typeID,
      singleton: leg.previousData.singleton,
      observedCustodyRevision: leg.observedCustodyRevision,
      quantity: leg.confiscationQuantity ?? leg.quantity,
      idempotencyKey: leg.confiscateKey,
    });
    if (!result || result.success !== true || result.durable !== true) {
      const ambiguous = Boolean(
        result && (result.ambiguous === true || result.success === true),
      );
      if (ambiguous || result && result.retryable === true) {
        return {
          ...(result || {}),
          success: false,
          ambiguous,
          retryable: true,
          errorMsg: result && result.errorMsg || "CONFISCATION_NOT_DURABLE",
        };
      }
      const checkpoint = updateSettlement(operationID, (current) => ({
        ...current,
        itemLegs: current.itemLegs.map((entry) =>
          entry.legID === leg.legID
            ? {
                ...entry,
                failed: true,
                errorMsg: result && result.errorMsg || "REMOVE_ERROR",
              }
            : entry),
      }));
      if (!checkpoint.success) {
        return checkpoint;
      }
      continue;
    }
    const checkpoint = updateSettlement(operationID, (current) => ({
      ...current,
      itemLegs: current.itemLegs.map((entry) =>
        entry.legID === leg.legID
          ? {
              ...entry,
              applied: true,
              changes: cloneValue((
                result.data &&
                Array.isArray(result.data.changes) &&
                result.data.changes.length > 0
              )
                ? result.data.changes
                : result.duplicate === true && result.data && result.data.receipt
                  ? result.data.receipt.resultData && result.data.receipt.resultData.changes || []
                  : []),
            }
          : entry),
    }));
    if (!checkpoint.success) {
      return checkpoint;
    }
  }
  return { success: true };
}

async function settleContrabandPenaltyInternal(operationID) {
  let settlement = getPendingContrabandPenalty(operationID);
  if (!settlement) {
    return { success: true, alreadySettled: true };
  }
  if (settlement.completed) {
    return { success: true, alreadySettled: true, data: buildPenaltyResult(settlement) };
  }
  if (settlement.deferConfiscation !== true) {
    const confiscation = settleItemLegs(operationID);
    if (!confiscation.success) return confiscation;
  }

  settlement = getPendingContrabandPenalty(operationID);
  if (!settlement) {
    return { success: true, alreadySettled: true };
  }
  if (!settlement.walletApplied) {
    let walletResult = null;
    let walletError = null;
    let actualChargedFine = 0;
    if (settlement.predictedChargedFine > 0) {
      walletResult = await adjustCharacterBalanceAsync(
        settlement.characterID,
        -settlement.predictedChargedFine,
        {
          idempotencyKey: settlement.walletCommandID,
          // refContrabandFine (51): the client names it "Contraband Fine" and words it by its own message. As
          // ADMIN_ADJUSTMENT (refGMCashTransfer, 3) it read "GM [factionID] issued transaction between ...".
          entryTypeID: JOURNAL_ENTRY_TYPE.CONTRABAND_FINE,
          referenceID: toPositiveInt(settlement.authority.factionID, 0),
          ownerID2: toPositiveInt(settlement.authority.factionID, 0),
          reason: "Contraband fine",
          description: `Contraband fine in ${
            settlement.authority.solarSystemName ||
              settlement.authority.solarSystemID
          }`,
        },
        {
          commandID: settlement.walletCommandID,
          source: "contraband-penalty",
        },
      );
      if (!walletResult || walletResult.success !== true) {
        walletError = walletResult && walletResult.errorMsg || "WALLET_DEBIT_FAILED";
        if (!["INSUFFICIENT_FUNDS", "CHARACTER_NOT_FOUND"].includes(walletError)) {
          return walletResult || { success: false, errorMsg: walletError };
        }
      } else {
        actualChargedFine = roundMoney(
          Math.abs(Number(walletResult.delta) || settlement.predictedChargedFine),
        );
      }
    }
    const checkpoint = updateSettlement(operationID, (current) => ({
      ...current,
      walletApplied: true,
      walletResult: cloneValue(walletResult),
      walletError,
      actualChargedFine,
    }));
    if (!checkpoint.success) {
      return checkpoint;
    }
  }

  settlement = getPendingContrabandPenalty(operationID);
  if (!settlement) {
    return { success: true, alreadySettled: true };
  }
  if (!settlement.standingApplied) {
    let standingResult = null;
    if (settlement.standingLoss > 0) {
      standingResult = applyStandingChanges(
        settlement.characterID,
        [{
          ownerID: toPositiveInt(settlement.authority.factionID, 0),
          rawChange: -settlement.standingLoss,
          applySocial: false,
          eventTypeID: EVENT_STANDING_CONTRABAND_TRAFFICKING,
          msg: "Contraband trafficking",
          // The client words the transaction by the faction that fined it and where (eveFormat.py
          // FmtStandingTransaction: int_1 the faction, int_2 the location, "someone" and "somewhere" for none).
          int_1: toPositiveInt(settlement.authority.factionID, 0) || null,
          int_2: toPositiveInt(settlement.authority.solarSystemID, 0) || null,
          int_3: null,
        }],
        {
          disableDerived: settlement.disableDerivedStandings !== false,
          idempotencyKey: settlement.standingKey,
        },
      );
      if (!standingResult || standingResult.success !== true) {
        return standingResult || {
          success: false,
          errorMsg: "STANDING_CHANGE_FAILED",
        };
      }
      const flushResult = database.flushTableSync("characters");
      if (!flushResult || flushResult.success !== true) {
        return flushResult || {
          success: false,
          errorMsg: "STANDING_CHANGE_FLUSH_FAILED",
        };
      }
    }
    const checkpoint = updateSettlement(operationID, (current) => ({
      ...current,
      standingApplied: true,
      standingResult: cloneValue(standingResult),
    }));
    if (!checkpoint.success) {
      return checkpoint;
    }
  }

  settlement = getPendingContrabandPenalty(operationID);
  if (!settlement) {
    return { success: true, alreadySettled: true };
  }
  if (settlement.deferConfiscation === true && settlement.confiscationDisposition === "pending") {
    return { success: true, data: buildPenaltyResult(settlement) };
  }
  if (settlement.deferConfiscation === true && settlement.confiscationDisposition === "requested") {
    const confiscation = settleItemLegs(operationID);
    if (!confiscation.success) return confiscation;
    settlement = getPendingContrabandPenalty(operationID);
  }
  const penalty = buildPenaltyResult(settlement);
  if (settlement.deferConfiscation === true) {
    // Inventory deltas can be resent safely. Finish only after the session
    // refresh succeeds, so a thrown notification leaves this receipt retryable.
    notifyInventoryChanges(settlement.characterID, penalty.removedChanges);
  }
  const completed = updateSettlement(operationID, (current) =>
    current.deferConfiscation === true
      ? { ...current, completed: true, completedAt: new Date().toISOString() }
      : null);
  if (!completed.success) {
    return completed;
  }
  if (settlement.deferConfiscation !== true) {
    notifyInventoryChanges(settlement.characterID, penalty.removedChanges);
  }
  return { success: true, data: penalty };
}

function settleContrabandPenalty(operationID) {
  return runSerialized(operationID, () =>
    settleContrabandPenaltyInternal(operationID));
}

function commitConfiscationDisposition(operationID, disposition, options = {}) {
  return runSerialized(operationID, async () => {
    const settlement = getPendingContrabandPenalty(operationID);
    if (!settlement || settlement.deferConfiscation !== true) {
      return { success: false, errorMsg: "DEFERRED_CONTRABAND_PENALTY_NOT_FOUND" };
    }
    if (settlement.confiscationDisposition !== "pending" &&
      settlement.confiscationDisposition !== disposition) {
      return { success: false, errorMsg: "CONTRABAND_CONFISCATION_DECISION_CONFLICT" };
    }
    let limits = null;
    if (disposition === "requested") {
      const supplied = options.quantitiesByItemID;
      if (supplied !== undefined && (!supplied || typeof supplied !== "object" || Array.isArray(supplied))) {
        return { success: false, errorMsg: "INVALID_CONTRABAND_CONFISCATION_LIMIT" };
      }
      if (supplied && Object.keys(supplied).some((key) =>
        !settlement.itemLegs.some((leg) => String(leg.itemID) === key))) {
        return { success: false, errorMsg: "INVALID_CONTRABAND_CONFISCATION_LIMIT" };
      }
      limits = settlement.itemLegs.map((leg) => {
        const limit = supplied && Object.prototype.hasOwnProperty.call(supplied, leg.itemID)
          ? supplied[leg.itemID]
          : leg.confiscationLimit ?? leg.quantity;
        return { legID: leg.legID, limit };
      });
      if (limits.some(({ legID, limit }) => !Number.isSafeInteger(limit) || limit < 0 ||
        limit > settlement.itemLegs.find((leg) => leg.legID === legID).quantity)) {
        return { success: false, errorMsg: "INVALID_CONTRABAND_CONFISCATION_LIMIT" };
      }
      if (settlement.confiscationDisposition === "requested" && limits.some(({ legID, limit }) => {
        const leg = settlement.itemLegs.find((entry) => entry.legID === legID);
        return limit !== (leg.confiscationLimit ?? leg.quantity);
      })) {
        return { success: false, errorMsg: "CONTRABAND_CONFISCATION_LIMIT_MISMATCH" };
      }
    }
    if (!settlement.completed && settlement.confiscationDisposition !== disposition) {
      const decision = updateSettlement(operationID, (current) => ({
        ...current, confiscationDisposition: disposition,
        itemLegs: limits ? current.itemLegs.map((leg) => ({
          ...leg, confiscationLimit: limits.find((entry) => entry.legID === leg.legID).limit,
        })) : current.itemLegs,
      }));
      if (!decision.success) return decision;
    }
    queueSettlement(operationID);
    return settleContrabandPenaltyInternal(operationID);
  });
}

function requestContrabandConfiscation(operationID, options = {}) {
  return commitConfiscationDisposition(operationID, "requested", options);
}

function updateContrabandConfiscationLimits(operationID, quantitiesByItemID, revisionsByItemID) {
  const settlement = getPendingContrabandPenalty(operationID);
  if (!settlement || settlement.deferConfiscation !== true) {
    return { success: false, errorMsg: "DEFERRED_CONTRABAND_PENALTY_NOT_FOUND" };
  }
  if (!quantitiesByItemID || typeof quantitiesByItemID !== "object" || Array.isArray(quantitiesByItemID) ||
    Object.keys(quantitiesByItemID).some((key) => !settlement.itemLegs.some((leg) => String(leg.itemID) === key)) ||
    settlement.itemLegs.some((leg) => Object.prototype.hasOwnProperty.call(quantitiesByItemID, leg.itemID) &&
      (!Number.isSafeInteger(quantitiesByItemID[leg.itemID]) || quantitiesByItemID[leg.itemID] < 0 ||
        quantitiesByItemID[leg.itemID] > leg.quantity))) {
    return { success: false, errorMsg: "INVALID_CONTRABAND_CONFISCATION_LIMIT" };
  }
  if (revisionsByItemID !== undefined && (!revisionsByItemID || typeof revisionsByItemID !== "object" ||
    Array.isArray(revisionsByItemID) || Object.keys(revisionsByItemID).some((key) =>
      !settlement.itemLegs.some((leg) => String(leg.itemID) === key) ||
      !Number.isSafeInteger(revisionsByItemID[key]) || revisionsByItemID[key] < 0))) {
    return { success: false, errorMsg: "INVALID_CONTRABAND_CUSTODY_REVISION" };
  }
  if (settlement.confiscationDisposition === "waived") {
    return { success: false, errorMsg: "CONTRABAND_CONFISCATION_DECISION_CONFLICT" };
  }
  if (settlement.completed) return { success: true, alreadySettled: true, data: settlement };
  // This synchronous owner mutation can run from the inventory observer before
  // an independently queued penalty retry. Every updater re-reads current state,
  // so an awaited wallet receipt or another leg checkpoint preserves this cap.
  return updateSettlement(operationID, (current) => ({
    ...current,
    itemLegs: current.itemLegs.map((leg) => ({
      ...leg,
      effectiveConfiscationLimit: Math.min(leg.effectiveConfiscationLimit ?? leg.confiscationLimit ?? leg.quantity,
        leg.confiscationLimit ?? leg.quantity,
        quantitiesByItemID[leg.itemID] ?? leg.effectiveConfiscationLimit ?? leg.confiscationLimit ?? leg.quantity),
      ...(revisionsByItemID && Object.prototype.hasOwnProperty.call(revisionsByItemID, leg.itemID)
        ? { observedCustodyRevision: Math.max(leg.observedCustodyRevision ?? 0, revisionsByItemID[leg.itemID]) } : {}),
    })),
  }));
}

function finishContrabandPenaltyWithoutConfiscation(operationID) {
  return commitConfiscationDisposition(operationID, "waived");
}

function bindDurableScheduler(scheduler) {
  if (!scheduler || typeof scheduler.schedule !== "function") {
    throw new TypeError("Contraband penalty scheduler requires schedule");
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

async function handleDurableContrabandPenalty(job = {}) {
  const operationID = String(job.payload && job.payload.operationID || "").trim();
  if (!operationID) {
    throw new Error("Contraband penalty job is invalid");
  }
  const result = await settleContrabandPenalty(operationID);
  if (!result || result.success !== true) {
    throw new Error(result && result.errorMsg || "Contraband penalty failed");
  }
  return result;
}

async function reconcileDurableContrabandPenalties() {
  const pending = listPendingContrabandPenalties();
  if (!durableScheduler) {
    return { scheduled: 0, pending: pending.length };
  }
  await Promise.all(pending.map((settlement) =>
    scheduleSettlement(settlement.operationID)));
  return { scheduled: pending.length, pending: pending.length };
}

module.exports = {
  DURABLE_SETTLEMENT_JOB_TYPE,
  TABLE_NAME,
  bindDurableScheduler,
  buildSettlementJob,
  getPendingContrabandPenalty,
  finishContrabandPenaltyWithoutConfiscation,
  handleDurableContrabandPenalty,
  listPendingContrabandPenalties,
  prepareContrabandPenalty,
  reconcileDurableContrabandPenalties,
  requestContrabandConfiscation,
  settleContrabandPenalty,
  unbindDurableScheduler,
  updateContrabandConfiscationLimits,
};
