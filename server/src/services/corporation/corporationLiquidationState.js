"use strict";

const path = require("path");

const database = require(path.join(__dirname, "../../gameStore"));
const log = require(path.join(__dirname, "../../utils/logger"));
const { findSessionByCharacterID } = require(path.join(
  __dirname,
  "../chat/sessionRegistry",
));
const { CHARACTERS_TABLE } = require(path.join(
  __dirname,
  "../character/characterState",
));
const { NOTIFICATIONS_TABLE } = require(path.join(
  __dirname,
  "../notifications/notificationState",
));
const {
  CORPORATIONS_TABLE,
  getCorporationRecord,
  setCharacterAffiliation,
} = require(path.join(__dirname, "./corporationState"));
const {
  CORPORATION_RUNTIME_TABLE,
  closeCorporationWithRuntime,
  ensureCharacterMemberState,
  getCorporationRuntime,
  normalizeInteger,
  syncMemberStateToCharacterRecord,
  updateCorporationRuntime,
} = require(path.join(__dirname, "./corporationRuntimeState"));
const {
  liquidateCorporationWalletAsync,
  notifyCorporationLiquidationWallet,
} = require(path.join(__dirname, "./corpWalletState"));
const {
  notifyCorporationLiquidationShareTransfer,
  notifyCorporationMemberChanged,
  notifyCorporationRemoved,
  refreshCharacterSession,
} = require(path.join(__dirname, "./corporationNotifications"));
const {
  notifyCorporationLiquidation,
} = require(path.join(__dirname, "./corpLifecycleNotifications"));

const TABLE_NAME = "corporationLiquidations";
const ROOT_VERSION = 1;
const DURABLE_SETTLEMENT_JOB_TYPE = "corporation.liquidate";
const DURABLE_SETTLEMENT_JOB_PREFIX = "corporation-liquidation:";
const settlementLanes = new Map();
let durableScheduler = null;

function cloneValue(value) {
  if (value === undefined || value === null) {
    return value;
  }
  return JSON.parse(JSON.stringify(
    value,
    (_key, candidate) =>
      typeof candidate === "bigint" ? candidate.toString() : candidate,
  ));
}

function normalizePositiveInteger(value) {
  const numeric = Math.trunc(Number(value) || 0);
  return numeric > 0 ? numeric : 0;
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
    pending: root.pending && typeof root.pending === "object"
      ? cloneValue(root.pending)
      : {},
  };
}

function writeRoot(root) {
  database.ensureTable(TABLE_NAME);
  const writeResult = database.write(TABLE_NAME, "/", {
    version: ROOT_VERSION,
    pending: cloneValue(root.pending || {}),
  });
  if (!writeResult || writeResult.success !== true) {
    return writeResult || { success: false, errorMsg: "WRITE_ERROR" };
  }
  const flushResult = database.flushTableSync(TABLE_NAME);
  return flushResult && flushResult.success
    ? writeResult
    : flushResult || { success: false, errorMsg: "FLUSH_ERROR" };
}

function settlementKey(corporationID) {
  return String(normalizePositiveInteger(corporationID));
}

function getPendingCorporationLiquidation(corporationID) {
  return cloneValue(readRoot().pending[settlementKey(corporationID)] || null);
}

function listPendingCorporationLiquidations() {
  return Object.values(readRoot().pending)
    .filter(Boolean)
    .map(cloneValue)
    .sort((left, right) => left.corporationID - right.corporationID);
}

function checkpointSettlement(corporationID, patch) {
  const root = readRoot();
  const key = settlementKey(corporationID);
  if (!root.pending[key]) {
    return false;
  }
  root.pending[key] = { ...root.pending[key], ...cloneValue(patch) };
  const result = writeRoot(root);
  return Boolean(result && result.success);
}

function completeSettlement(corporationID) {
  const root = readRoot();
  const key = settlementKey(corporationID);
  if (!root.pending[key]) {
    return false;
  }
  delete root.pending[key];
  const result = writeRoot(root);
  return Boolean(result && result.success);
}

function buildSettlementJob(corporationID) {
  const normalizedCorporationID = normalizePositiveInteger(corporationID);
  return normalizedCorporationID
    ? {
        jobID: `${DURABLE_SETTLEMENT_JOB_PREFIX}${normalizedCorporationID}`,
        type: DURABLE_SETTLEMENT_JOB_TYPE,
        dueAtMs: Date.now(),
        payload: { corporationID: normalizedCorporationID },
      }
    : null;
}

async function scheduleSettlement(corporationID) {
  const job = buildSettlementJob(corporationID);
  if (!job || !durableScheduler) {
    return null;
  }
  await durableScheduler.schedule(job);
  return job;
}

function queueSettlement(corporationID) {
  if (durableScheduler) {
    void scheduleSettlement(corporationID).catch((error) => {
      log.warn(
        `[CorporationLiquidation] scheduling failed corp=${corporationID}: ${error.message}`,
      );
    });
  }
}

function prepareCorporationLiquidation(options = {}) {
  const corporationID = normalizePositiveInteger(options.corporationID);
  const characterID = normalizePositiveInteger(options.characterID);
  const fallbackCorporationID = normalizePositiveInteger(
    options.fallbackCorporationID,
  );
  if (!corporationID || !characterID || !fallbackCorporationID) {
    return { success: false, errorMsg: "INVALID_LIQUIDATION" };
  }
  const root = readRoot();
  const key = settlementKey(corporationID);
  const existing = root.pending[key];
  if (existing) {
    if (
      existing.characterID !== characterID ||
      existing.fallbackCorporationID !== fallbackCorporationID
    ) {
      return { success: false, errorMsg: "LIQUIDATION_ALREADY_PENDING" };
    }
    queueSettlement(corporationID);
    return { success: true, duplicate: true, data: cloneValue(existing) };
  }

  const settlement = {
    settlementID: `corporation-liquidation:${corporationID}`,
    corporationID,
    characterID,
    fallbackCorporationID,
    createdAt: new Date().toISOString(),
    walletCommandID: `corporation-liquidation:${corporationID}:wallet`,
    walletApplied: false,
    payout: null,
    sharesApplied: false,
    sharesTransferred: 0,
    sharesToTransfer: Math.max(
      0,
      normalizeInteger(
        getCorporationRuntime(corporationID)?.shares?.[String(corporationID)],
        0,
      ),
    ),
    domainEffectsApplied: false,
    notificationApplied: false,
    previousCorporation: cloneValue(options.previousCorporation || null),
    previousFromMember: cloneValue(options.previousFromMember || null),
    previousToMember: cloneValue(options.previousToMember || null),
  };
  root.pending[key] = settlement;
  const result = writeRoot(root);
  if (!result || result.success !== true) {
    return result || { success: false, errorMsg: "LIQUIDATION_WRITE_FAILED" };
  }
  queueSettlement(corporationID);
  return { success: true, duplicate: false, data: cloneValue(settlement) };
}

function runSerialized(corporationID, operation) {
  const laneKey = settlementKey(corporationID);
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

function transferLiquidationShares(settlement) {
  const runtime = getCorporationRuntime(settlement.corporationID) || {};
  const shares = runtime.shares && typeof runtime.shares === "object"
    ? runtime.shares
    : {};
  const corporationShares = Math.max(
    0,
    normalizeInteger(shares[String(settlement.corporationID)], 0),
  );
  if (corporationShares <= 0) {
    const characterShares = Math.max(
      0,
      normalizeInteger(shares[String(settlement.characterID)], 0),
    );
    const expectedShares = Math.max(
      0,
      normalizeInteger(settlement.sharesToTransfer, 0),
    );
    return expectedShares > 0 && characterShares >= expectedShares
      ? expectedShares
      : 0;
  }
  const updateResult = updateCorporationRuntime(
    settlement.corporationID,
    (nextRuntime) => {
      nextRuntime.shares = nextRuntime.shares &&
        typeof nextRuntime.shares === "object"
        ? nextRuntime.shares
        : {};
      delete nextRuntime.shares[String(settlement.corporationID)];
      nextRuntime.shares[String(settlement.characterID)] =
        normalizeInteger(
          nextRuntime.shares[String(settlement.characterID)],
          0,
        ) + corporationShares;
      return nextRuntime;
    },
  );
  if (!updateResult || updateResult.success !== true) {
    throw new Error(updateResult && updateResult.errorMsg ||
      "corporation liquidation share transfer failed");
  }
  const flushResult = database.flushTableSync(CORPORATION_RUNTIME_TABLE);
  if (!flushResult || flushResult.success !== true) {
    throw new Error(flushResult && flushResult.errorMsg ||
      "corporation liquidation share flush failed");
  }
  return corporationShares;
}

function applyMembershipAndDeletion(settlement) {
  const targetCorporation = getCorporationRecord(
    settlement.fallbackCorporationID,
  );
  if (!targetCorporation) {
    return { success: false, errorMsg: "TARGET_CORPORATION_NOT_FOUND" };
  }
  const affiliationResult = setCharacterAffiliation(
    settlement.characterID,
    targetCorporation.corporationID,
    targetCorporation.allianceID || null,
  );
  if (!affiliationResult || affiliationResult.success !== true) {
    return affiliationResult || { success: false, errorMsg: "AFFILIATION_FAILED" };
  }

  if (getCorporationRuntime(settlement.corporationID)) {
    updateCorporationRuntime(settlement.corporationID, (runtime) => {
      if (runtime.members && typeof runtime.members === "object") {
        delete runtime.members[String(settlement.characterID)];
      }
      return runtime;
    });
  }
  ensureCharacterMemberState(
    targetCorporation.corporationID,
    settlement.characterID,
  );
  syncMemberStateToCharacterRecord(
    targetCorporation.corporationID,
    settlement.characterID,
  );

  if (getCorporationRecord(settlement.corporationID)) {
    const deleteResult = closeCorporationWithRuntime(
      settlement.corporationID,
    );
    if (!deleteResult || deleteResult.success !== true) {
      return deleteResult || { success: false, errorMsg: "DELETE_FAILED" };
    }
  }
  const flushResult = database.flushTablesSync([
    CHARACTERS_TABLE,
    CORPORATIONS_TABLE,
    CORPORATION_RUNTIME_TABLE,
  ]);
  if (!flushResult || flushResult.success !== true) {
    return flushResult || { success: false, errorMsg: "DOMAIN_FLUSH_FAILED" };
  }
  return { success: true };
}

function publishLiveEffects(settlement) {
  // TQ Resign As CEO - Corp Disbands.txt268..750: certificates, wallet,
  // liquidation message, corporation removal, HQ clear, then affiliation.
  // Keep this publication separate from the durable settlement phases above.
  notifyCorporationLiquidationShareTransfer(
    settlement.corporationID,
    settlement.characterID,
    settlement.sharesTransferred,
  );
  notifyCorporationLiquidationWallet(
    settlement.corporationID,
    settlement.characterID,
    settlement.payout,
  );
  notifyCorporationLiquidation(
    settlement.corporationID,
    settlement.characterID,
    settlement.payout,
    {
      idempotencyKey:
        `corporation-liquidation:${settlement.corporationID}:notification`,
      emitLive: true,
    },
  );
  notifyCorporationRemoved(
    settlement.corporationID,
    settlement.previousCorporation,
    { clientCharacterIDs: [settlement.characterID] },
  );
  const session = findSessionByCharacterID(settlement.characterID);
  if (session && typeof session.sendSessionChange === "function") {
    const previousHqID = session.hqID ?? null;
    if (previousHqID !== null && previousHqID !== undefined) {
      session.hqID = null;
      session.sendSessionChange({ hqID: [previousHqID, null] });
    }
  }
  // Packet724 announces just the membership/revision transition to the actor
  // before the session switch. The full new member row follows at784/787.
  notifyCorporationMemberChanged(
    settlement.fallbackCorporationID,
    settlement.characterID,
    settlement.previousFromMember,
    {
      header: ["corporationID", "startDateTime", "rowDate"],
      idTypes: ["clientID"],
      clientCharacterIDs: [settlement.characterID],
      refreshSession: false,
    },
  );
  refreshCharacterSession(settlement.characterID, {
    sessionChangeKeys: [
      "corpid",
      "corpAccountKey",
      "hqID",
      "corprole",
      "rolesAtAll",
      "rolesAtBase",
      "rolesAtHQ",
      "rolesAtOther",
    ],
    deferCorpAccountKey: true,
    clearCorpAccountKey: true,
    includeRoleChanges: true,
    suppressCorpAccountKeyWithCorpChange: false,
    selectionEvent: false,
    emitNotifications: true,
    logSelection: false,
    inventoryBootstrap: false,
  });
  notifyCorporationMemberChanged(
    settlement.fallbackCorporationID,
    settlement.characterID,
    settlement.previousToMember,
    {
      idTypes: ["corpid", "clientID"],
      clientCharacterIDs: [settlement.characterID],
      refreshSession: false,
    },
  );
  const pendingResponse = session &&
    session._pendingCorporationLiquidationResponse;
  if (pendingResponse &&
      pendingResponse.corporationID === settlement.corporationID) {
    // TQ response790 precedes the final old-member removal797. The service's
    // existing afterCallResponse hook publishes this snapshot after the reply.
    pendingResponse.memberRemoval = {
      corporationID: settlement.corporationID,
      characterID: settlement.characterID,
      previousFromMember: settlement.previousFromMember,
    };
  } else {
    // Durable recovery has no pending RPC reply to wait for.
    notifyCorporationMemberChanged(
      settlement.corporationID,
      settlement.characterID,
      settlement.previousFromMember,
      {
        nextSnapshot: null,
        idTypes: ["clientID"],
        clientCharacterIDs: [settlement.characterID],
        refreshSession: false,
      },
    );
  }
}

async function settleCorporationLiquidationInternal(corporationID) {
  let settlement = getPendingCorporationLiquidation(corporationID);
  if (!settlement) {
    return { success: true, alreadySettled: true };
  }

  if (!settlement.walletApplied) {
    const walletResult = await liquidateCorporationWalletAsync(
      settlement.corporationID,
      settlement.characterID,
      {
        description: "Corporation liquidation",
        entryTypeID: 10,
      },
      {
        commandID: settlement.walletCommandID,
        source: "corporation-liquidation",
      },
      { emitNotifications: false },
    );
    if (!walletResult || walletResult.success !== true) {
      return walletResult || { success: false, errorMsg: "WALLET_FAILED" };
    }
    if (!checkpointSettlement(settlement.corporationID, {
      walletApplied: true,
      payout: Number(walletResult.payout) || 0,
    })) {
      return { success: false, errorMsg: "WALLET_CHECKPOINT_FAILED" };
    }
  }

  settlement = getPendingCorporationLiquidation(corporationID);
  if (!settlement) {
    return { success: true, alreadySettled: true };
  }
  if (!settlement.sharesApplied) {
    const sharesTransferred = transferLiquidationShares(settlement);
    if (!checkpointSettlement(settlement.corporationID, {
      sharesApplied: true,
      sharesTransferred,
    })) {
      return { success: false, errorMsg: "SHARE_CHECKPOINT_FAILED" };
    }
  }

  settlement = getPendingCorporationLiquidation(corporationID);
  if (!settlement) {
    return { success: true, alreadySettled: true };
  }
  if (!settlement.domainEffectsApplied) {
    const effectsResult = applyMembershipAndDeletion(settlement);
    if (!effectsResult || effectsResult.success !== true) {
      return effectsResult || { success: false, errorMsg: "EFFECTS_FAILED" };
    }
    if (!checkpointSettlement(settlement.corporationID, {
      domainEffectsApplied: true,
    })) {
      return { success: false, errorMsg: "EFFECTS_CHECKPOINT_FAILED" };
    }
  }

  settlement = getPendingCorporationLiquidation(corporationID);
  if (!settlement) {
    return { success: true, alreadySettled: true };
  }
  if (!settlement.notificationApplied) {
    const notificationResult = notifyCorporationLiquidation(
      settlement.corporationID,
      settlement.characterID,
      settlement.payout,
      {
        idempotencyKey:
          `corporation-liquidation:${settlement.corporationID}:notification`,
        emitLive: false,
      },
    );
    if (!notificationResult || notificationResult.success !== true) {
      return notificationResult || {
        success: false,
        errorMsg: "NOTIFICATION_FAILED",
      };
    }
    const notificationFlush = database.flushTableSync(NOTIFICATIONS_TABLE);
    if (!notificationFlush || notificationFlush.success !== true) {
      return notificationFlush || {
        success: false,
        errorMsg: "NOTIFICATION_FLUSH_FAILED",
      };
    }
    if (!checkpointSettlement(settlement.corporationID, {
      notificationApplied: true,
    })) {
      return { success: false, errorMsg: "NOTIFICATION_CHECKPOINT_FAILED" };
    }
  }

  settlement = getPendingCorporationLiquidation(corporationID);
  if (!settlement) {
    return { success: true, alreadySettled: true };
  }
  if (!completeSettlement(settlement.corporationID)) {
    return { success: false, errorMsg: "LIQUIDATION_COMPLETION_FAILED" };
  }
  publishLiveEffects(settlement);
  return {
    success: true,
    data: {
      corporationID: settlement.corporationID,
      characterID: settlement.characterID,
      fallbackCorporationID: settlement.fallbackCorporationID,
      payout: settlement.payout,
    },
  };
}

function settleCorporationLiquidation(corporationID) {
  return runSerialized(corporationID, () =>
    settleCorporationLiquidationInternal(corporationID));
}

function bindDurableScheduler(scheduler) {
  if (!scheduler || typeof scheduler.schedule !== "function") {
    throw new TypeError("corporation liquidation scheduler requires schedule");
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

async function handleDurableCorporationLiquidation(job = {}) {
  const corporationID = normalizePositiveInteger(
    job.payload && job.payload.corporationID,
  );
  if (!corporationID) {
    throw new Error("corporation liquidation job is invalid");
  }
  const result = await settleCorporationLiquidation(corporationID);
  if (!result || result.success !== true) {
    throw new Error(result && result.errorMsg ||
      "corporation liquidation settlement failed");
  }
  return result;
}

async function reconcileDurableCorporationLiquidations() {
  const pending = listPendingCorporationLiquidations();
  if (!durableScheduler) {
    return { scheduled: 0, pending: pending.length };
  }
  await Promise.all(pending.map((settlement) =>
    scheduleSettlement(settlement.corporationID)));
  return { scheduled: pending.length, pending: pending.length };
}

module.exports = {
  DURABLE_SETTLEMENT_JOB_TYPE,
  TABLE_NAME,
  bindDurableScheduler,
  buildSettlementJob,
  getPendingCorporationLiquidation,
  handleDurableCorporationLiquidation,
  listPendingCorporationLiquidations,
  prepareCorporationLiquidation,
  reconcileDurableCorporationLiquidations,
  settleCorporationLiquidation,
  unbindDurableScheduler,
};
