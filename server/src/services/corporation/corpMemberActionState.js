"use strict";

const crypto = require("node:crypto");
const path = require("path");

const database = require(path.join(__dirname, "../../gameStore"));
const log = require(path.join(__dirname, "../../utils/logger"));
const {
  extractList,
} = require(path.join(__dirname, "../_shared/serviceHelpers"));
const {
  CORPORATION_WALLET_KEY_START,
  distributeCorporationWalletAsync,
  getCorporationWalletBalance,
  normalizeCorporationWalletKey,
} = require(path.join(__dirname, "./corpWalletState"));
const {
  CORPORATION_RUNTIME_TABLE,
  ensureRuntimeInitialized,
  getCorporationMember,
  getCorporationRuntime,
  normalizeInteger,
  normalizePositiveInteger,
  normalizeText,
  syncMemberStateToCharacterRecord,
  toRoleMaskBigInt,
  updateCorporationRuntime,
} = require(path.join(__dirname, "./corporationRuntimeState"));
const {
  buildCorporationMemberSnapshot,
  notifyCorporationMemberChanged,
  notifyCorporationShareChanges,
} = require(path.join(__dirname, "./corporationNotifications"));

const CTV_ADD = 1;
const CTV_REMOVE = 2;
const CTV_SET = 3;
const CTV_GIVE = 4;
const CTPG_CASH = 6;
const CTPG_SHARES = 7;
const DURABLE_SETTLEMENT_JOB_TYPE = "corporation.member-action-settle";
const DURABLE_SETTLEMENT_JOB_PREFIX = "corporation-member-action:";
const settlementLanes = new Map();
let durableScheduler = null;

const ROLE_MASK_PROPERTIES = new Set([
  "roles",
  "rolesAtHQ",
  "rolesAtBase",
  "rolesAtOther",
  "grantableRoles",
  "grantableRolesAtHQ",
  "grantableRolesAtBase",
  "grantableRolesAtOther",
]);

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

function flushRuntime() {
  const result = database.flushTableSync(CORPORATION_RUNTIME_TABLE);
  return Boolean(result && result.success);
}

function normalizePersistedAction(action) {
  if (!action) {
    return null;
  }
  return {
    verb: normalizeInteger(action.verb, 0),
    property: action.property,
    value: ROLE_MASK_PROPERTIES.has(action.property)
      ? toRoleMaskBigInt(action.value, 0n).toString()
      : normalizeInteger(action.value, 0),
  };
}

function buildCashPlan(targetIDs, actions) {
  let amountPerTarget = 0;
  for (const action of actions) {
    if (action && action.verb === CTV_GIVE && action.property === CTPG_CASH) {
      amountPerTarget += Math.max(0, normalizeInteger(action.value, 0));
    }
  }
  return {
    amountPerTarget,
    totalAmount: amountPerTarget * targetIDs.length,
    allocations: amountPerTarget > 0
      ? targetIDs.map((targetID) => ({
          kind: "character",
          ownerID: targetID,
          amount: amountPerTarget,
        }))
      : [],
  };
}

function calculateShareGrantTotal(targetIDs, actions) {
  return actions.reduce((total, action) => {
    if (!action || action.verb !== CTV_GIVE || action.property !== CTPG_SHARES) {
      return total;
    }
    return total + (
      Math.max(0, normalizeInteger(action.value, 0)) * targetIDs.length
    );
  }, 0);
}

function getPendingCorporationMemberAction(corporationID, settlementID) {
  const runtime = getCorporationRuntime(corporationID);
  return cloneValue(
    runtime && runtime.memberActionSettlements &&
      runtime.memberActionSettlements[String(settlementID)] || null,
  );
}

function listPendingCorporationMemberActions() {
  const table = ensureRuntimeInitialized();
  const pending = [];
  for (const runtime of Object.values(table.corporations || {})) {
    for (const settlement of Object.values(
      runtime && runtime.memberActionSettlements || {},
    )) {
      if (settlement) {
        pending.push(cloneValue(settlement));
      }
    }
  }
  return pending.sort((left, right) =>
    String(left.settlementID).localeCompare(String(right.settlementID)));
}

function updateSettlement(corporationID, settlementID, updater) {
  let nextSettlement = null;
  const result = updateCorporationRuntime(corporationID, (runtime) => {
    runtime.memberActionSettlements = runtime.memberActionSettlements &&
      typeof runtime.memberActionSettlements === "object"
      ? runtime.memberActionSettlements
      : {};
    const key = String(settlementID);
    const current = runtime.memberActionSettlements[key];
    if (!current) {
      return runtime;
    }
    const next = typeof updater === "function"
      ? updater(cloneValue(current))
      : current;
    if (next === null) {
      delete runtime.memberActionSettlements[key];
    } else {
      runtime.memberActionSettlements[key] = cloneValue(next);
      nextSettlement = cloneValue(next);
    }
    return runtime;
  });
  if (!result || result.success !== true || !flushRuntime()) {
    return { success: false, errorMsg: "MEMBER_ACTION_WRITE_FAILED" };
  }
  return { success: true, data: nextSettlement };
}

function buildSettlementJob(corporationID, settlementID) {
  const normalizedCorporationID = normalizePositiveInteger(corporationID, 0);
  const normalizedSettlementID = normalizeText(settlementID, "").trim();
  return normalizedCorporationID && normalizedSettlementID
    ? {
        jobID: `${DURABLE_SETTLEMENT_JOB_PREFIX}${normalizedSettlementID}`,
        type: DURABLE_SETTLEMENT_JOB_TYPE,
        dueAtMs: Date.now(),
        payload: {
          corporationID: normalizedCorporationID,
          settlementID: normalizedSettlementID,
        },
      }
    : null;
}

async function scheduleSettlement(corporationID, settlementID) {
  const job = buildSettlementJob(corporationID, settlementID);
  if (!job || !durableScheduler) {
    return null;
  }
  await durableScheduler.schedule(job);
  return job;
}

function queueSettlement(corporationID, settlementID) {
  if (!durableScheduler) {
    return;
  }
  void scheduleSettlement(corporationID, settlementID).catch((error) => {
    log.warn(
      `[CorporationMemberAction] scheduling failed settlement=${settlementID}: ` +
        error.message,
    );
  });
}

function normalizeActionProperty(rawProperty) {
  if (
    typeof rawProperty === "number" ||
    typeof rawProperty === "bigint" ||
    (rawProperty &&
      typeof rawProperty === "object" &&
      (rawProperty.type === "int" || rawProperty.type === "long"))
  ) {
    return normalizeInteger(rawProperty, 0);
  }
  return normalizeText(rawProperty, "");
}

function normalizeActionRow(rawAction) {
  const values = extractList(rawAction);
  if (values.length < 3) {
    return null;
  }
  return {
    verb: normalizeInteger(values[0], 0),
    property: normalizeActionProperty(values[1]),
    value: values[2],
  };
}

function normalizeTargetIDs(rawTargetIDs, corporationID) {
  const uniqueTargetIDs = [];
  const seenTargetIDs = new Set();
  for (const rawTargetID of extractList(rawTargetIDs)) {
    const targetID = normalizePositiveInteger(rawTargetID, null);
    if (!targetID || seenTargetIDs.has(targetID)) {
      continue;
    }
    if (!getCorporationMember(corporationID, targetID)) {
      continue;
    }
    seenTargetIDs.add(targetID);
    uniqueTargetIDs.push(targetID);
  }
  return uniqueTargetIDs;
}

function applyMaskAction(currentValue, verb, value) {
  const currentMask = toRoleMaskBigInt(currentValue, 0n);
  const actionMask = toRoleMaskBigInt(value, 0n);
  if (verb === CTV_ADD) {
    return currentMask | actionMask;
  }
  if (verb === CTV_REMOVE) {
    return currentMask & ~actionMask;
  }
  if (verb === CTV_SET) {
    return actionMask;
  }
  return currentMask;
}

function applyIntegerMaskAction(currentValue, verb, value) {
  const currentMask = normalizeInteger(currentValue, 0);
  const actionMask = normalizeInteger(value, 0);
  if (verb === CTV_ADD) {
    return currentMask | actionMask;
  }
  if (verb === CTV_REMOVE) {
    return currentMask & ~actionMask;
  }
  if (verb === CTV_SET) {
    return actionMask;
  }
  return currentMask;
}

function resolveSourceWalletKey(session, corporationID) {
  const sessionAccountKey = normalizePositiveInteger(
    session && (session.corpAccountKey || session.corpaccountkey),
    null,
  );
  if (sessionAccountKey) {
    return normalizeCorporationWalletKey(sessionAccountKey);
  }
  const actingCharacterID = normalizePositiveInteger(
    session && (session.characterID || session.charid),
    null,
  );
  const actingMember = actingCharacterID
    ? getCorporationMember(corporationID, actingCharacterID)
    : null;
  return normalizeCorporationWalletKey(
    actingMember && actingMember.accountKey
      ? actingMember.accountKey
      : CORPORATION_WALLET_KEY_START,
  );
}

function preflightActionGrants(corporationID, targetIDs, actions, walletKey) {
  let totalCashRequired = 0;
  let totalSharesRequired = 0;
  for (const action of actions) {
    if (!action || action.verb !== CTV_GIVE) {
      continue;
    }
    if (action.property === CTPG_CASH) {
      const amount = Math.max(0, normalizeInteger(action.value, 0));
      totalCashRequired += amount * targetIDs.length;
      continue;
    }
    if (action.property === CTPG_SHARES) {
      const shares = Math.max(0, normalizeInteger(action.value, 0));
      totalSharesRequired += shares * targetIDs.length;
    }
  }

  if (totalCashRequired > 0) {
    const walletBalance = getCorporationWalletBalance(corporationID, walletKey);
    if (walletBalance + 0.0001 < totalCashRequired) {
      return {
        success: false,
        errorMsg: "INSUFFICIENT_FUNDS",
      };
    }
  }

  if (totalSharesRequired > 0) {
    const runtime = getCorporationRuntime(corporationID) || {};
    const availableShares = normalizeInteger(
      runtime.shares && runtime.shares[String(corporationID)],
      0,
    );
    if (availableShares < totalSharesRequired) {
      return {
        success: false,
        errorMsg: "INSUFFICIENT_SHARES",
      };
    }
  }

  return {
    success: true,
  };
}

function applyAdministrativeMemberChanges(
  corporationID,
  targetIDs,
  actions,
  options = {},
) {
  const touchedMembers = new Set();
  let shareChanges = null;
  const settlementID = normalizeText(options.settlementID, "").trim();
  const result = updateCorporationRuntime(corporationID, (runtime) => {
    runtime.members =
      runtime.members && typeof runtime.members === "object" ? runtime.members : {};
    runtime.shares =
      runtime.shares && typeof runtime.shares === "object" ? runtime.shares : {};
    runtime.memberActionSettlements = runtime.memberActionSettlements &&
      typeof runtime.memberActionSettlements === "object"
      ? runtime.memberActionSettlements
      : {};
    const settlement = settlementID
      ? runtime.memberActionSettlements[settlementID]
      : null;
    if (settlementID && (!settlement || settlement.administrativeApplied)) {
      return runtime;
    }
    // Snapshot at the actual write, after any awaited wallet work. The native
    // wallet's SharesPanel.OnShareChange rereads holdings when a grant lands.
    const beforeShares = cloneValue(runtime.shares);

    for (const targetID of targetIDs) {
      const member = runtime.members[String(targetID)];
      if (!member) {
        continue;
      }
      for (const action of actions) {
        if (!action || action.verb === CTV_GIVE) {
          continue;
        }
        if (ROLE_MASK_PROPERTIES.has(action.property)) {
          member[action.property] = applyMaskAction(
            member[action.property],
            action.verb,
            action.value,
          ).toString();
          touchedMembers.add(targetID);
          continue;
        }
        if (action.property === "titleMask") {
          member.titleMask = applyIntegerMaskAction(
            member.titleMask,
            action.verb,
            action.value,
          );
          touchedMembers.add(targetID);
          continue;
        }
        if (action.property === "baseID" && action.verb === CTV_SET) {
          member.baseID = normalizePositiveInteger(action.value, null);
          touchedMembers.add(targetID);
        }
      }
    }

    for (const action of actions) {
      if (!action || action.verb !== CTV_GIVE || action.property !== CTPG_SHARES) {
        continue;
      }
      const sharesPerTarget = Math.max(0, normalizeInteger(action.value, 0));
      if (sharesPerTarget <= 0) {
        continue;
      }
      for (const targetID of targetIDs) {
        runtime.shares[String(corporationID)] =
          normalizeInteger(runtime.shares[String(corporationID)], 0) - sharesPerTarget;
        runtime.shares[String(targetID)] =
          normalizeInteger(runtime.shares[String(targetID)], 0) + sharesPerTarget;
      }
    }

    shareChanges = { before: beforeShares, after: cloneValue(runtime.shares) };
    if (settlement) {
      runtime.memberActionSettlements[settlementID] = {
        ...settlement,
        administrativeApplied: true,
        // Persist the delta with the applied checkpoint so retries do not
        // recalculate it from later allocations or apply the grant twice.
        shareChanges,
      };
    }

    return runtime;
  });

  if (!result || result.success !== true) {
    return result || { success: false, errorMsg: "MEMBER_ACTION_APPLY_FAILED" };
  }

  if (options.syncCharacters !== false) {
    for (const targetID of touchedMembers) {
      syncMemberStateToCharacterRecord(corporationID, targetID);
    }
  }
  return {
    success: true,
    data: {
      touchedMemberIDs: [...touchedMembers],
      shareChanges,
    },
  };
}

function prepareCorporationMemberAction(options = {}) {
  const corporationID = normalizePositiveInteger(options.corporationID, 0);
  const targetIDs = (Array.isArray(options.targetIDs) ? options.targetIDs : [])
    .map((targetID) => normalizePositiveInteger(targetID, 0))
    .filter(Boolean);
  const actions = (Array.isArray(options.actions) ? options.actions : [])
    .map(normalizePersistedAction)
    .filter(Boolean);
  const walletKey = normalizeCorporationWalletKey(options.walletKey);
  const cashPlan = buildCashPlan(targetIDs, actions);
  if (
    !corporationID ||
    targetIDs.length === 0 ||
    actions.length === 0 ||
    !(cashPlan.totalAmount > 0)
  ) {
    return { success: false, errorMsg: "INVALID_MEMBER_ACTION" };
  }

  const requestFingerprint = JSON.stringify({ targetIDs, actions, walletKey });
  const runtime = getCorporationRuntime(corporationID);
  if (!runtime) {
    return { success: false, errorMsg: "CORPORATION_NOT_FOUND" };
  }
  const existingSettlements = Object.values(
    runtime.memberActionSettlements || {},
  ).filter(Boolean);
  if (existingSettlements.length > 0) {
    const duplicate = existingSettlements.find(
      (settlement) => settlement.requestFingerprint === requestFingerprint,
    );
    if (!duplicate) {
      return { success: false, errorMsg: "MEMBER_ACTION_ALREADY_PENDING" };
    }
    queueSettlement(corporationID, duplicate.settlementID);
    return { success: true, duplicate: true, data: cloneValue(duplicate) };
  }

  const preflight = preflightActionGrants(
    corporationID,
    targetIDs,
    actions,
    walletKey,
  );
  if (!preflight.success) {
    return preflight;
  }

  const settlementID = crypto.randomUUID();
  const settlement = {
    settlementID,
    corporationID,
    targetIDs,
    actions,
    walletKey,
    totalAmount: cashPlan.totalAmount,
    allocations: cashPlan.allocations,
    reservedShares: calculateShareGrantTotal(targetIDs, actions),
    previousMembersByID: Object.fromEntries(targetIDs.map((targetID) => [
      String(targetID),
      cloneValue(buildCorporationMemberSnapshot(corporationID, targetID)),
    ])),
    requestFingerprint,
    walletCommandID: `corporation-member-action:${settlementID}:wallet`,
    walletApplied: false,
    administrativeApplied: false,
    charactersSynchronized: false,
    createdAt: new Date().toISOString(),
  };
  const writeResult = updateCorporationRuntime(corporationID, (nextRuntime) => {
    nextRuntime.memberActionSettlements = nextRuntime.memberActionSettlements &&
      typeof nextRuntime.memberActionSettlements === "object"
      ? nextRuntime.memberActionSettlements
      : {};
    nextRuntime.memberActionSettlements[settlementID] = cloneValue(settlement);
    return nextRuntime;
  });
  if (!writeResult || writeResult.success !== true || !flushRuntime()) {
    return { success: false, errorMsg: "MEMBER_ACTION_WRITE_FAILED" };
  }
  queueSettlement(corporationID, settlementID);
  return { success: true, duplicate: false, data: cloneValue(settlement) };
}

function runSerialized(corporationID, operation) {
  const laneKey = String(normalizePositiveInteger(corporationID, 0));
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

const DEFINITIVE_WALLET_ERRORS = new Set([
  "CORPORATION_NOT_FOUND",
  "INSUFFICIENT_FUNDS",
  "INVALID_DISTRIBUTION",
  "RECIPIENT_NOT_FOUND",
]);

async function settleCorporationMemberActionInternal(
  corporationID,
  settlementID,
) {
  let settlement = getPendingCorporationMemberAction(
    corporationID,
    settlementID,
  );
  if (!settlement) {
    return { success: true, alreadySettled: true };
  }

  if (!settlement.walletApplied) {
    const walletResult = await distributeCorporationWalletAsync(
      settlement.corporationID,
      settlement.walletKey,
      settlement.totalAmount,
      settlement.allocations,
      {
        entryTypeID: 10,
        sourceOwnerID2: 0,
        referenceID: settlement.corporationID,
        debitDescription: "Corporation member cash grants",
        creditDescription:
          `Corporation member grant from ${settlement.corporationID}`,
      },
      {
        commandID: settlement.walletCommandID,
        source: "corporation-member-action",
      },
    );
    if (!walletResult || walletResult.success !== true) {
      const errorMsg = walletResult && walletResult.errorMsg || "WALLET_FAILED";
      if (DEFINITIVE_WALLET_ERRORS.has(errorMsg)) {
        const removed = updateSettlement(
          corporationID,
          settlementID,
          () => null,
        );
        return removed.success
          ? { success: true, rejected: true, errorMsg }
          : removed;
      }
      return walletResult || { success: false, errorMsg };
    }
    const checkpoint = updateSettlement(
      corporationID,
      settlementID,
      (current) => ({ ...current, walletApplied: true }),
    );
    if (!checkpoint.success) {
      return checkpoint;
    }
  }

  settlement = getPendingCorporationMemberAction(corporationID, settlementID);
  if (!settlement) {
    return { success: true, alreadySettled: true };
  }
  if (!settlement.administrativeApplied) {
    const applyResult = applyAdministrativeMemberChanges(
      settlement.corporationID,
      settlement.targetIDs,
      settlement.actions,
      { settlementID: settlement.settlementID, syncCharacters: false },
    );
    if (!applyResult.success || !flushRuntime()) {
      return applyResult.success
        ? { success: false, errorMsg: "MEMBER_ACTION_FLUSH_FAILED" }
        : applyResult;
    }
  }

  settlement = getPendingCorporationMemberAction(corporationID, settlementID);
  if (!settlement) {
    return { success: true, alreadySettled: true };
  }
  if (!settlement.charactersSynchronized) {
    for (const targetID of settlement.targetIDs) {
      syncMemberStateToCharacterRecord(settlement.corporationID, targetID);
    }
    const flushResult = database.flushTableSync("characters");
    if (!flushResult || flushResult.success !== true) {
      return flushResult || {
        success: false,
        errorMsg: "MEMBER_CHARACTER_SYNC_FAILED",
      };
    }
    const checkpoint = updateSettlement(
      corporationID,
      settlementID,
      (current) => ({ ...current, charactersSynchronized: true }),
    );
    if (!checkpoint.success) {
      return checkpoint;
    }
  }

  settlement = getPendingCorporationMemberAction(corporationID, settlementID);
  if (!settlement) {
    return { success: true, alreadySettled: true };
  }
  const completed = updateSettlement(corporationID, settlementID, () => null);
  if (!completed.success) {
    return completed;
  }
  if (settlement.shareChanges) {
    notifyCorporationShareChanges(
      settlement.corporationID,
      settlement.shareChanges.before,
      settlement.shareChanges.after,
      [settlement.corporationID, ...settlement.targetIDs],
    );
  }
  for (const targetID of settlement.targetIDs) {
    notifyCorporationMemberChanged(
      settlement.corporationID,
      targetID,
      settlement.previousMembersByID &&
        settlement.previousMembersByID[String(targetID)] || null,
      { refreshSession: false },
    );
  }
  return {
    success: true,
    data: {
      corporationID: settlement.corporationID,
      targetIDs: cloneValue(settlement.targetIDs),
      walletKey: settlement.walletKey,
      settlementID: settlement.settlementID,
      notificationsHandled: true,
    },
  };
}

function settleCorporationMemberAction(corporationID, settlementID) {
  return runSerialized(corporationID, () =>
    settleCorporationMemberActionInternal(corporationID, settlementID));
}

function bindDurableScheduler(scheduler) {
  if (!scheduler || typeof scheduler.schedule !== "function") {
    throw new TypeError("corporation member-action scheduler requires schedule");
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

async function handleDurableCorporationMemberAction(job = {}) {
  const corporationID = normalizePositiveInteger(
    job.payload && job.payload.corporationID,
    0,
  );
  const settlementID = normalizeText(
    job.payload && job.payload.settlementID,
    "",
  ).trim();
  if (!corporationID || !settlementID) {
    throw new Error("corporation member-action job is invalid");
  }
  const result = await settleCorporationMemberAction(
    corporationID,
    settlementID,
  );
  if (!result || result.success !== true) {
    throw new Error(
      result && result.errorMsg || "corporation member-action settlement failed",
    );
  }
  return result;
}

async function reconcileDurableCorporationMemberActions() {
  const pending = listPendingCorporationMemberActions();
  if (!durableScheduler) {
    return { scheduled: 0, pending: pending.length };
  }
  await Promise.all(pending.map((settlement) =>
    scheduleSettlement(settlement.corporationID, settlement.settlementID)));
  return { scheduled: pending.length, pending: pending.length };
}

function executeCorporationMemberActions(corporationID, rawTargetIDs, rawActions, session) {
  const targetIDs = normalizeTargetIDs(rawTargetIDs, corporationID);
  if (targetIDs.length === 0) {
    return {
      success: true,
      data: {
        targetIDs: [],
      },
    };
  }

  const actions = extractList(rawActions)
    .map((action) => normalizeActionRow(action))
    .filter(Boolean);
  if (actions.length === 0) {
    return {
      success: true,
      data: {
        targetIDs,
      },
    };
  }

  const walletKey = resolveSourceWalletKey(session, corporationID);
  const runtime = getCorporationRuntime(corporationID) || {};
  if (Object.values(runtime.memberActionSettlements || {}).some(Boolean)) {
    const cashPlan = buildCashPlan(targetIDs, actions);
    if (!(cashPlan.totalAmount > 0)) {
      return { success: false, errorMsg: "MEMBER_ACTION_ALREADY_PENDING" };
    }
  }

  const cashPlan = buildCashPlan(targetIDs, actions);
  if (cashPlan.totalAmount > 0) {
    const prepared = prepareCorporationMemberAction({
      corporationID,
      targetIDs,
      actions,
      walletKey,
    });
    if (!prepared.success) {
      return prepared;
    }
    return settleCorporationMemberAction(
      corporationID,
      prepared.data.settlementID,
    );
  }

  const preflight = preflightActionGrants(
    corporationID,
    targetIDs,
    actions,
    walletKey,
  );
  if (!preflight.success) {
    return preflight;
  }
  const administrativeResult = applyAdministrativeMemberChanges(
    corporationID,
    targetIDs,
    actions,
  );
  if (!administrativeResult.success) {
    return administrativeResult;
  }

  const shareChanges = administrativeResult.data.shareChanges;
  notifyCorporationShareChanges(
    corporationID,
    shareChanges && shareChanges.before,
    shareChanges && shareChanges.after,
    [corporationID, ...targetIDs],
  );

  return {
    success: true,
    data: {
      corporationID,
      targetIDs,
      walletKey,
    },
  };
}

module.exports = {
  CTPG_CASH,
  CTPG_SHARES,
  CTV_ADD,
  CTV_GIVE,
  CTV_REMOVE,
  CTV_SET,
  DURABLE_SETTLEMENT_JOB_TYPE,
  bindDurableScheduler,
  buildSettlementJob,
  executeCorporationMemberActions,
  getPendingCorporationMemberAction,
  handleDurableCorporationMemberAction,
  listPendingCorporationMemberActions,
  prepareCorporationMemberAction,
  reconcileDurableCorporationMemberActions,
  settleCorporationMemberAction,
  unbindDurableScheduler,
};
