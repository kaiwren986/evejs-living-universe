"use strict";

const path = require("path");

const database = require(path.join(__dirname, "../../gameStore"));

const {
  currentFileTime,
} = require(path.join(__dirname, "../_shared/serviceHelpers"));
const {
  cloneValue,
  CORPORATION_RUNTIME_TABLE,
  ensureRuntimeInitialized,
  normalizeBoolean,
  normalizeInteger,
  normalizePositiveInteger,
  normalizeText,
  updateRuntimeState,
} = require(path.join(__dirname, "./corporationRuntimeState"));
const {
  createWarSurrenderNotifications,
  getWarRecord,
  updateWarRecord,
} = require(path.join(__dirname, "./warRuntimeState"));
const {
  getCharacterAllyBaseCost,
  resolveWarEntityWalletOwner,
  settleWarEntityTransferAsync,
} = require(path.join(__dirname, "./warCostState"));
const {
  getCorporationWalletBalance,
} = require(path.join(__dirname, "./corpWalletState"));
const warNotificationCenter = require(path.join(
  __dirname,
  "./warNotificationCenter",
));

const FILETIME_TICKS_PER_HOUR = 36000000000n;
const FILETIME_TICKS_PER_DAY = 864000000000n;
const FILETIME_TICKS_PER_WEEK = FILETIME_TICKS_PER_DAY * 7n;

const WAR_NEGOTIATION_TYPE_ALLY_OFFER = 0;
const WAR_NEGOTIATION_TYPE_SURRENDER_OFFER = 2;

const WAR_NEGOTIATION_STATE_NEW = 0;
const WAR_NEGOTIATION_STATE_ACCEPTED = 1;
const WAR_NEGOTIATION_STATE_DECLINED = 2;
const WAR_NEGOTIATION_STATE_RETRACTED = 3;

const PEACE_REASON_UNDEFINED = 0;
const PEACE_REASON_WAR_SURRENDER = 4;
const DURABLE_SETTLEMENT_JOB_TYPE = "war-negotiation.settle";
const DURABLE_SETTLEMENT_JOB_PREFIX = "war-negotiation-settle:";
const settlementLanes = new Map();
let durableScheduler = null;

function ensureRuntimeRoots(runtimeTable) {
  runtimeTable.warNegotiations =
    runtimeTable.warNegotiations &&
    typeof runtimeTable.warNegotiations === "object"
      ? runtimeTable.warNegotiations
      : {};
  runtimeTable.mutualWarInviteBlocks =
    runtimeTable.mutualWarInviteBlocks &&
    typeof runtimeTable.mutualWarInviteBlocks === "object"
      ? runtimeTable.mutualWarInviteBlocks
      : {};
  runtimeTable.peaceTreaties =
    runtimeTable.peaceTreaties && typeof runtimeTable.peaceTreaties === "object"
      ? runtimeTable.peaceTreaties
      : {};
  runtimeTable._meta.nextNegotiationID =
    normalizePositiveInteger(runtimeTable._meta && runtimeTable._meta.nextNegotiationID, 1) ||
    1;
  runtimeTable._meta.nextTreatyID =
    normalizePositiveInteger(runtimeTable._meta && runtimeTable._meta.nextTreatyID, 1) || 1;
  return runtimeTable;
}

function getNegotiationRecord(warNegotiationID) {
  const runtimeTable = ensureRuntimeRoots(ensureRuntimeInitialized());
  const record =
    runtimeTable.warNegotiations &&
    runtimeTable.warNegotiations[String(warNegotiationID)];
  return record ? cloneValue(record) : null;
}

function listNegotiationsForOwner(ownerID) {
  const numericOwnerID = normalizePositiveInteger(ownerID, null);
  if (!numericOwnerID) {
    return [];
  }
  const runtimeTable = ensureRuntimeRoots(ensureRuntimeInitialized());
  return Object.values(runtimeTable.warNegotiations || {})
    .filter(
      (entry) =>
        Number(entry && entry.negotiationState) === WAR_NEGOTIATION_STATE_NEW &&
        (Number(entry && entry.ownerID1) === numericOwnerID ||
          Number(entry && entry.ownerID2) === numericOwnerID ||
          Number(entry && entry.declaredByID) === numericOwnerID ||
          Number(entry && entry.againstID) === numericOwnerID),
    )
    .map((entry) => cloneValue(entry))
    .sort((left, right) => Number(right.warNegotiationID) - Number(left.warNegotiationID));
}

function createPeaceTreaty({ warID, ownerID, otherOwnerID, peaceReason = PEACE_REASON_UNDEFINED } = {}) {
  const numericOwnerID = normalizePositiveInteger(ownerID, null);
  const numericOtherOwnerID = normalizePositiveInteger(otherOwnerID, null);
  const numericWarID = normalizePositiveInteger(warID, null);
  if (!numericOwnerID || !numericOtherOwnerID || !numericWarID) {
    return null;
  }

  const existing = Object.values(
    ensureRuntimeRoots(ensureRuntimeInitialized()).peaceTreaties || {},
  ).find((treaty) =>
    normalizePositiveInteger(treaty && treaty.warID, 0) === numericWarID &&
    normalizePositiveInteger(treaty && treaty.ownerID, 0) === numericOwnerID &&
    normalizePositiveInteger(treaty && treaty.otherOwnerID, 0) === numericOtherOwnerID &&
    normalizeInteger(treaty && treaty.peaceReason, PEACE_REASON_UNDEFINED) ===
      normalizeInteger(peaceReason, PEACE_REASON_UNDEFINED));
  if (existing) {
    return normalizePositiveInteger(existing.treatyID, null);
  }

  let nextTreatyID = null;
  updateRuntimeState((runtimeTable) => {
    ensureRuntimeRoots(runtimeTable);
    nextTreatyID = runtimeTable._meta.nextTreatyID;
    runtimeTable._meta.nextTreatyID += 1;
    const now = currentFileTime();
    runtimeTable.peaceTreaties[String(nextTreatyID)] = {
      treatyID: nextTreatyID,
      warID: numericWarID,
      ownerID: numericOwnerID,
      otherOwnerID: numericOtherOwnerID,
      peaceReason: normalizeInteger(peaceReason, PEACE_REASON_UNDEFINED),
      createdDate: now.toString(),
      expiryDate: (now + FILETIME_TICKS_PER_WEEK * 2n).toString(),
    };
    return runtimeTable;
  });
  return nextTreatyID;
}

function createWarNegotiation({
  warID,
  warNegotiationTypeID,
  ownerID1,
  ownerID2,
  declaredByID,
  againstID,
  iskValue = 0,
  description = "",
  ownerID1AccountKey = 1000,
  createdByCharacterID = null,
} = {}) {
  const numericWarID = normalizePositiveInteger(warID, null);
  const numericOwnerID1 = normalizePositiveInteger(ownerID1, null);
  const numericOwnerID2 = normalizePositiveInteger(ownerID2, null);
  if (!numericWarID || !numericOwnerID1 || !numericOwnerID2) {
    return null;
  }

  let nextNegotiationID = null;
  updateRuntimeState((runtimeTable) => {
    ensureRuntimeRoots(runtimeTable);
    nextNegotiationID = runtimeTable._meta.nextNegotiationID;
    runtimeTable._meta.nextNegotiationID += 1;
    runtimeTable.warNegotiations[String(nextNegotiationID)] = {
      warNegotiationID: nextNegotiationID,
      warID: numericWarID,
      warNegotiationTypeID: normalizeInteger(
        warNegotiationTypeID,
        WAR_NEGOTIATION_TYPE_ALLY_OFFER,
      ),
      ownerID1: numericOwnerID1,
      ownerID2: numericOwnerID2,
      declaredByID: normalizePositiveInteger(declaredByID, 0) || 0,
      againstID: normalizePositiveInteger(againstID, 0) || 0,
      iskValue: Number(iskValue || 0),
      ownerID1AccountKey: normalizeInteger(ownerID1AccountKey, 1000),
      description: normalizeText(description, ""),
      negotiationState: WAR_NEGOTIATION_STATE_NEW,
      createdDateTime: currentFileTime().toString(),
      timeAccepted: null,
      timeDeclined: null,
      timeRetracted: null,
    };
    return runtimeTable;
  });

  const createdNegotiation = getNegotiationRecord(nextNegotiationID);
  if (createdNegotiation) {
    if (
      normalizeInteger(createdNegotiation.warNegotiationTypeID, -1) ===
      WAR_NEGOTIATION_TYPE_ALLY_OFFER
    ) {
      warNotificationCenter.notifyAllyOfferCreated(createdNegotiation, {
        characterID: createdByCharacterID,
      });
    } else if (
      normalizeInteger(createdNegotiation.warNegotiationTypeID, -1) ===
      WAR_NEGOTIATION_TYPE_SURRENDER_OFFER
    ) {
      warNotificationCenter.notifySurrenderOffered(createdNegotiation, {
        characterID: createdByCharacterID,
      });
    }
  }
  return createdNegotiation;
}

function updateWarNegotiation(warNegotiationID, updater) {
  const numericNegotiationID = normalizePositiveInteger(warNegotiationID, null);
  if (!numericNegotiationID) {
    return null;
  }
  updateRuntimeState((runtimeTable) => {
    ensureRuntimeRoots(runtimeTable);
    const currentRecord = runtimeTable.warNegotiations[String(numericNegotiationID)];
    if (!currentRecord) {
      return runtimeTable;
    }
    runtimeTable.warNegotiations[String(numericNegotiationID)] =
      typeof updater === "function"
        ? updater(cloneValue(currentRecord)) || currentRecord
        : currentRecord;
    return runtimeTable;
  });
  return getNegotiationRecord(numericNegotiationID);
}

function resolveSessionCharacterID(session) {
  const numeric = Number(session && (session.characterID || session.charid));
  return Number.isInteger(numeric) && numeric > 0 ? numeric : 0;
}

/** The alliance (when present) or corporation entitled to act in a war negotiation. */
function resolveSessionWarEntityID(session) {
  const numeric = Number(
    session && (
      session.allianceID ||
      session.allianceid ||
      session.corporationID ||
      session.corpid
    ),
  );
  return Number.isInteger(numeric) && numeric > 0 ? numeric : 0;
}

function resolveSessionAccountKey(session) {
  const numeric = Number(
    session && (session.corpAccountKey || session.corpaccountkey),
  );
  if (Number.isInteger(numeric) && numeric >= 1000 && numeric <= 1006) {
    return numeric;
  }
  return 1000;
}

function countExistingAllyContracts(war, currentTime) {
  return Object.values((war && war.allies) || {}).filter((ally) => {
    try {
      return BigInt(String(ally && ally.timeFinished ? ally.timeFinished : "0")) > currentTime;
    } catch (error) {
      // ignored: an unreadable finish time counts as an ended contract
      return false;
    }
  }).length;
}

function flushNegotiationState() {
  database.flushTableAsync(CORPORATION_RUNTIME_TABLE);
}

function runSettlementSerialized(warNegotiationID, operation) {
  const laneKey = String(normalizePositiveInteger(warNegotiationID, 0));
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

function buildSettlementJob(warNegotiationID) {
  const numericNegotiationID = normalizePositiveInteger(warNegotiationID, 0);
  return numericNegotiationID > 0 ? {
    jobID: `${DURABLE_SETTLEMENT_JOB_PREFIX}${numericNegotiationID}`,
    type: DURABLE_SETTLEMENT_JOB_TYPE,
    dueAtMs: Date.now(),
    payload: { warNegotiationID: numericNegotiationID },
  } : null;
}

async function scheduleSettlement(warNegotiationID) {
  if (!durableScheduler) {
    return null;
  }
  const job = buildSettlementJob(warNegotiationID);
  if (job) {
    await durableScheduler.schedule(job);
  }
  return job;
}

function writeSettlement(warNegotiationID, settlement) {
  const updated = updateWarNegotiation(warNegotiationID, (record) => ({
    ...record,
    walletSettlement: settlement ? cloneValue(settlement) : null,
  }));
  flushNegotiationState();
  return updated;
}

function checkpointSettlement(warNegotiationID, patch) {
  let checkpointed = false;
  const updated = updateWarNegotiation(warNegotiationID, (record) => {
    if (!record.walletSettlement) {
      return record;
    }
    checkpointed = true;
    return {
      ...record,
      walletSettlement: {
        ...record.walletSettlement,
        ...cloneValue(patch),
      },
    };
  });
  if (checkpointed) {
    flushNegotiationState();
  }
  return checkpointed ? updated : null;
}

function isDefinitiveWalletRejection(result) {
  return Boolean(result && [
    "INSUFFICIENT_FUNDS",
    "CORPORATION_NOT_FOUND",
    "WAR_ENTITY_NOT_FOUND",
  ].includes(result.errorMsg));
}

function prepareAllySettlement(negotiation, session) {
  if (negotiation.walletSettlement) {
    return negotiation.walletSettlement;
  }
  const war = getWarRecord(negotiation.warID);
  if (!war || negotiation.negotiationState !== WAR_NEGOTIATION_STATE_NEW) {
    return null;
  }
  const acceptedAt = currentFileTime();
  const payerOwnerID =
    normalizePositiveInteger(negotiation.ownerID2, null) ||
    normalizePositiveInteger(negotiation.againstID, null);
  const acceptingCharacterID = resolveSessionCharacterID(session);
  const accountKey = resolveSessionAccountKey(session);
  const payerWallet = resolveWarEntityWalletOwner(payerOwnerID);
  const allyWallet = resolveWarEntityWalletOwner(negotiation.ownerID1);
  if (!payerWallet || !allyWallet) {
    return null;
  }
  const existingAllyCount = countExistingAllyContracts(war, acceptedAt);
  const allyBaseCost = getCharacterAllyBaseCost(acceptingCharacterID);
  const concordFee = existingAllyCount > 0
    ? allyBaseCost * 2 ** Math.min(existingAllyCount - 1, 20)
    : 0;
  const transferAmount = Math.max(0, Number(negotiation.iskValue || 0));
  if (
    getCorporationWalletBalance(payerWallet.walletCorporationID, accountKey) +
      0.0001 <
    transferAmount + concordFee
  ) {
    return null;
  }
  const naturalEnd = acceptedAt + FILETIME_TICKS_PER_WEEK * 2n;
  const warFinish = war.timeFinished ? BigInt(String(war.timeFinished)) : null;
  const settlement = {
    kind: "ally",
    warNegotiationID: negotiation.warNegotiationID,
    payerOwnerID,
    receiverOwnerID: negotiation.ownerID1,
    payerWalletCorporationID: payerWallet.walletCorporationID,
    receiverWalletCorporationID: allyWallet.walletCorporationID,
    accountKey,
    transferAmount,
    concordFee,
    walletApplied: concordFee <= 0 && transferAmount <= 0,
    effectsApplied: false,
    acceptedAt: acceptedAt.toString(),
    allyStartAt: (acceptedAt + 4n * FILETIME_TICKS_PER_HOUR).toString(),
    allyFinishAt:
      warFinish && warFinish < naturalEnd ? warFinish.toString() : naturalEnd.toString(),
    acceptingCharacterID,
    walletCommandID: `war-negotiation:${negotiation.warNegotiationID}:wallet`,
  };
  writeSettlement(negotiation.warNegotiationID, settlement);
  return settlement;
}

function prepareSurrenderSettlement(negotiation, session) {
  if (negotiation.walletSettlement) {
    return negotiation.walletSettlement;
  }
  if (negotiation.negotiationState !== WAR_NEGOTIATION_STATE_NEW) {
    return null;
  }
  const payerWallet = resolveWarEntityWalletOwner(negotiation.ownerID1);
  const receiverWallet = resolveWarEntityWalletOwner(negotiation.ownerID2);
  const accountKey = normalizeInteger(negotiation.ownerID1AccountKey, 1000);
  const transferAmount = Math.max(0, Number(negotiation.iskValue || 0));
  if (transferAmount > 0 && (!payerWallet || !receiverWallet)) {
    return null;
  }
  if (
    transferAmount > 0 &&
    getCorporationWalletBalance(payerWallet.walletCorporationID, accountKey) +
      0.0001 <
    transferAmount
  ) {
    return null;
  }
  const settlement = {
    kind: "surrender",
    warNegotiationID: negotiation.warNegotiationID,
    payerOwnerID: negotiation.ownerID1,
    receiverOwnerID: negotiation.ownerID2,
    payerWalletCorporationID: payerWallet && payerWallet.walletCorporationID || 0,
    receiverWalletCorporationID:
      receiverWallet && receiverWallet.walletCorporationID || 0,
    accountKey,
    transferAmount,
    concordFee: 0,
    walletApplied: transferAmount <= 0,
    effectsApplied: false,
    acceptedAt: currentFileTime().toString(),
    acceptingCharacterID: resolveSessionCharacterID(session),
    walletCommandID: `war-negotiation:${negotiation.warNegotiationID}:wallet`,
  };
  writeSettlement(negotiation.warNegotiationID, settlement);
  return settlement;
}

function applyAllySettlementEffects(negotiation, settlement) {
  if (!settlement.effectsApplied) {
    updateWarRecord(negotiation.warID, (war) => {
      war.allies = war.allies && typeof war.allies === "object" ? war.allies : {};
      war.allies[String(negotiation.ownerID1)] = {
        allyID: normalizePositiveInteger(negotiation.ownerID1, 0) || 0,
        timeStarted: settlement.allyStartAt,
        timeFinished: settlement.allyFinishAt,
      };
      return war;
    });
    updateWarNegotiation(negotiation.warNegotiationID, (record) => ({
      ...record,
      negotiationState: WAR_NEGOTIATION_STATE_ACCEPTED,
      timeAccepted: settlement.acceptedAt,
      walletSettlement: {
        ...record.walletSettlement,
        effectsApplied: true,
      },
    }));
    flushNegotiationState();
  }
  const acceptedNegotiation = getNegotiationRecord(negotiation.warNegotiationID);
  const acceptedWar = getWarRecord(negotiation.warID);
  warNotificationCenter.notifyAllyAccepted(acceptedNegotiation, {
    characterID: settlement.acceptingCharacterID,
    time: settlement.acceptedAt,
    idempotencyKeyPrefix:
      `war-negotiation:${negotiation.warNegotiationID}:ally-accepted`,
  });
  warNotificationCenter.notifyAllyJoinedWar(acceptedWar, negotiation.ownerID1, {
    startTime: settlement.allyStartAt,
    idempotencyKeyPrefix:
      `war-negotiation:${negotiation.warNegotiationID}:ally-joined`,
  });
}

function applySurrenderSettlementEffects(negotiation, settlement) {
  if (!settlement.effectsApplied) {
    updateWarRecord(negotiation.warID, (war) => ({
      ...war,
      timeFinished: settlement.acceptedAt,
    }));
    createPeaceTreaty({
      warID: negotiation.warID,
      ownerID: negotiation.declaredByID,
      otherOwnerID: negotiation.againstID,
      peaceReason: PEACE_REASON_WAR_SURRENDER,
    });
    createPeaceTreaty({
      warID: negotiation.warID,
      ownerID: negotiation.againstID,
      otherOwnerID: negotiation.declaredByID,
      peaceReason: PEACE_REASON_WAR_SURRENDER,
    });
    updateWarNegotiation(negotiation.warNegotiationID, (record) => ({
      ...record,
      negotiationState: WAR_NEGOTIATION_STATE_ACCEPTED,
      timeAccepted: settlement.acceptedAt,
      walletSettlement: {
        ...record.walletSettlement,
        effectsApplied: true,
      },
    }));
    flushNegotiationState();
  }
  const acceptedNegotiation = getNegotiationRecord(negotiation.warNegotiationID);
  const acceptedWar = getWarRecord(negotiation.warID);
  warNotificationCenter.notifyAcceptedSurrender(acceptedNegotiation, {
    characterID: settlement.acceptingCharacterID,
    idempotencyKeyPrefix:
      `war-negotiation:${negotiation.warNegotiationID}:surrender-accepted`,
  });
  createWarSurrenderNotifications(acceptedWar, {
    idempotencyKeyPrefix:
      `war-negotiation:${negotiation.warNegotiationID}:war-surrender`,
  });
}

async function settlePendingWarNegotiationInternal(warNegotiationID) {
  let negotiation = getNegotiationRecord(warNegotiationID);
  if (!negotiation || !negotiation.walletSettlement) {
    return { success: true, alreadySettled: true, data: { negotiation } };
  }
  let settlement = cloneValue(negotiation.walletSettlement);
  if (!settlement.walletApplied) {
    const walletResult = await settleWarEntityTransferAsync({
      fromOwnerID: settlement.payerOwnerID,
      toOwnerID: settlement.receiverOwnerID,
      fromWalletCorporationID: settlement.payerWalletCorporationID,
      toWalletCorporationID: settlement.receiverWalletCorporationID,
      amount: settlement.transferAmount,
      fromAccountKey: settlement.accountKey,
      description:
        settlement.kind === "ally"
          ? `War ally fee for war ${negotiation.warID}`
          : `War surrender fee for war ${negotiation.warID}`,
      additionalDebitAmount: settlement.concordFee,
      additionalDebitOptions: {
        entryTypeID: 10,
        ownerID1: settlement.payerOwnerID,
        ownerID2: 1000125,
        description: `CONCORD ally registration fee for war ${negotiation.warID}`,
      },
      commandID: settlement.walletCommandID,
    });
    if (!walletResult || walletResult.success !== true) {
      if (isDefinitiveWalletRejection(walletResult)) {
        writeSettlement(warNegotiationID, null);
      }
      return walletResult || { success: false, errorMsg: "WALLET_TRANSFER_FAILED" };
    }
    if (!checkpointSettlement(warNegotiationID, { walletApplied: true })) {
      return { success: false, errorMsg: "WALLET_CHECKPOINT_FAILED" };
    }
    settlement.walletApplied = true;
  }

  negotiation = getNegotiationRecord(warNegotiationID);
  settlement = cloneValue(negotiation.walletSettlement);
  if (settlement.kind === "ally") {
    applyAllySettlementEffects(negotiation, settlement);
  } else if (settlement.kind === "surrender") {
    applySurrenderSettlementEffects(negotiation, settlement);
  } else {
    return { success: false, errorMsg: "INVALID_SETTLEMENT_KIND" };
  }
  writeSettlement(warNegotiationID, null);
  return {
    success: true,
    data: { negotiation: getNegotiationRecord(warNegotiationID) },
  };
}

function settlePendingWarNegotiation(warNegotiationID) {
  return runSettlementSerialized(warNegotiationID, () =>
    settlePendingWarNegotiationInternal(warNegotiationID));
}

async function acceptAllyNegotiation(warNegotiationID, session = null) {
  const result = await runSettlementSerialized(warNegotiationID, async () => {
    const negotiation = getNegotiationRecord(warNegotiationID);
    if (
      !negotiation ||
      normalizeInteger(negotiation.warNegotiationTypeID, -1) !==
        WAR_NEGOTIATION_TYPE_ALLY_OFFER
    ) {
      return { success: false, errorMsg: "NEGOTIATION_NOT_FOUND" };
    }
    // The defender in ownerID2 chooses whether to hire the offered ally. The
    // mercenary in ownerID1 may read its outgoing offer, but cannot use that
    // to spend the defender's wallet and join the war by itself.
    if (
      resolveSessionWarEntityID(session) !==
      normalizePositiveInteger(negotiation.ownerID2, 0)
    ) {
      return { success: false, errorMsg: "NEGOTIATION_ACCESS_DENIED" };
    }
    if (!prepareAllySettlement(negotiation, session)) {
      return { success: false, errorMsg: "NEGOTIATION_NOT_PAYABLE" };
    }
    void scheduleSettlement(warNegotiationID).catch(() => null);
    return settlePendingWarNegotiationInternal(warNegotiationID);
  });
  return result && result.success && result.data
    ? result.data.negotiation
    : null;
}

async function acceptSurrender(warNegotiationID, session = null) {
  const result = await runSettlementSerialized(warNegotiationID, async () => {
    const negotiation = getNegotiationRecord(warNegotiationID);
    if (
      !negotiation ||
      normalizeInteger(negotiation.warNegotiationTypeID, -1) !==
        WAR_NEGOTIATION_TYPE_SURRENDER_OFFER
    ) {
      return { success: false, errorMsg: "NEGOTIATION_NOT_FOUND" };
    }
    // A surrender is an offer to ownerID2. The offering side may read its
    // outgoing negotiation, but it must not be able to accept its own offer
    // and unilaterally end the war.
    if (
      resolveSessionWarEntityID(session) !==
      normalizePositiveInteger(negotiation.ownerID2, 0)
    ) {
      return { success: false, errorMsg: "NEGOTIATION_ACCESS_DENIED" };
    }
    if (!prepareSurrenderSettlement(negotiation, session)) {
      return { success: false, errorMsg: "NEGOTIATION_NOT_PAYABLE" };
    }
    void scheduleSettlement(warNegotiationID).catch(() => null);
    return settlePendingWarNegotiationInternal(warNegotiationID);
  });
  return result && result.success && result.data
    ? result.data.negotiation
    : null;
}

function listPendingWarNegotiationSettlements() {
  const runtimeTable = ensureRuntimeRoots(ensureRuntimeInitialized());
  return Object.values(runtimeTable.warNegotiations || {})
    .filter((negotiation) => negotiation && negotiation.walletSettlement)
    .map((negotiation) => cloneValue(negotiation))
    .sort((left, right) =>
      Number(left.warNegotiationID) - Number(right.warNegotiationID));
}

function bindDurableScheduler(scheduler) {
  if (!scheduler || typeof scheduler.schedule !== "function") {
    throw new TypeError("war negotiation scheduler requires a schedule function");
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

async function handleDurableWarNegotiationSettlement(job = {}) {
  const warNegotiationID = normalizePositiveInteger(
    job.payload && job.payload.warNegotiationID,
    0,
  );
  if (!warNegotiationID) {
    throw new Error("war negotiation settlement job is invalid");
  }
  const result = await settlePendingWarNegotiation(warNegotiationID);
  if (!result || result.success !== true) {
    const current = getNegotiationRecord(warNegotiationID);
    if (!current || !current.walletSettlement) {
      return { warNegotiationID, paymentRejected: true };
    }
    throw new Error(
      result && result.errorMsg || "war negotiation settlement failed",
    );
  }
  return result;
}

async function reconcileDurableWarNegotiations() {
  const pending = listPendingWarNegotiationSettlements();
  if (!durableScheduler) {
    return { scheduled: 0, pending: pending.length };
  }
  await Promise.all(pending.map((negotiation) =>
    scheduleSettlement(negotiation.warNegotiationID)));
  return { scheduled: pending.length, pending: pending.length };
}

function setMutualWarInviteBlocked(ownerID, blocked) {
  const numericOwnerID = normalizePositiveInteger(ownerID, null);
  if (!numericOwnerID) {
    return;
  }
  updateRuntimeState((runtimeTable) => {
    ensureRuntimeRoots(runtimeTable);
    runtimeTable.mutualWarInviteBlocks[String(numericOwnerID)] = normalizeBoolean(blocked, false)
      ? 1
      : 0;
    return runtimeTable;
  });
}

function isMutualWarInviteBlocked(ownerID) {
  const numericOwnerID = normalizePositiveInteger(ownerID, null);
  if (!numericOwnerID) {
    return false;
  }
  const runtimeTable = ensureRuntimeRoots(ensureRuntimeInitialized());
  return Boolean(runtimeTable.mutualWarInviteBlocks[String(numericOwnerID)]);
}

function listPeaceTreatiesForOwner(ownerID) {
  const numericOwnerID = normalizePositiveInteger(ownerID, null);
  if (!numericOwnerID) {
    return { outgoing: [], incoming: [] };
  }
  const runtimeTable = ensureRuntimeRoots(ensureRuntimeInitialized());
  const now = currentFileTime();
  const allTreaties = Object.values(runtimeTable.peaceTreaties || {}).map((entry) =>
    cloneValue(entry),
  ).filter((entry) => {
    try {
      return BigInt(String(entry && entry.expiryDate ? entry.expiryDate : "0")) > now;
    } catch (_error) {
      // ignored: an unreadable expiry counts as an expired treaty
      return false;
    }
  });
  return {
    outgoing: allTreaties
      .filter((entry) => Number(entry.ownerID) === numericOwnerID)
      .sort((left, right) => Number(right.treatyID) - Number(left.treatyID)),
    incoming: allTreaties
      .filter((entry) => Number(entry.otherOwnerID) === numericOwnerID)
      .sort((left, right) => Number(right.treatyID) - Number(left.treatyID)),
  };
}

module.exports = {
  DURABLE_SETTLEMENT_JOB_TYPE,
  WAR_NEGOTIATION_TYPE_ALLY_OFFER,
  WAR_NEGOTIATION_TYPE_SURRENDER_OFFER,
  WAR_NEGOTIATION_STATE_NEW,
  WAR_NEGOTIATION_STATE_ACCEPTED,
  WAR_NEGOTIATION_STATE_DECLINED,
  WAR_NEGOTIATION_STATE_RETRACTED,
  PEACE_REASON_UNDEFINED,
  PEACE_REASON_WAR_SURRENDER,
  acceptAllyNegotiation,
  acceptSurrender,
  bindDurableScheduler,
  buildSettlementJob,
  createPeaceTreaty,
  createWarNegotiation,
  ensureRuntimeRoots,
  getNegotiationRecord,
  handleDurableWarNegotiationSettlement,
  isMutualWarInviteBlocked,
  listNegotiationsForOwner,
  listPendingWarNegotiationSettlements,
  listPeaceTreatiesForOwner,
  reconcileDurableWarNegotiations,
  setMutualWarInviteBlocked,
  settlePendingWarNegotiation,
  unbindDurableScheduler,
  updateWarNegotiation,
};
