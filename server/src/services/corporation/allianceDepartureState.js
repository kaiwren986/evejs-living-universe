"use strict";

const crypto = require("node:crypto");
const path = require("node:path");

const config = require(path.join(__dirname, "../../config"));
const database = require(path.join(__dirname, "../../gameStore"));
const log = require(path.join(__dirname, "../../utils/logger"));
const {
  getNextClusterDowntimeAtMs,
} = require(path.join(__dirname, "../_shared/clusterDowntime"));
const {
  buildAllianceMemberSnapshot,
  buildAllianceSummary,
  buildCorporationSnapshot,
  notifyAllianceChanged,
  notifyAllianceMemberChanged,
  notifyCorporationChanged,
} = require(path.join(__dirname, "./corporationNotifications"));
const {
  cleanupAllianceGovernanceForDeparture,
  getActiveExecutorCorporationID,
} = require(path.join(__dirname, "./allianceGovernanceState"));
const {
  getAllianceMembershipStartFiletime,
  recordAllianceMemberLeave,
  removeAllianceCorporationState,
} = require(path.join(__dirname, "./allianceViewState"));
const {
  getAllianceCorporationIDs,
  getAllianceRecord,
  getCorporationRecord,
  setCorporationAlliance,
} = require(path.join(__dirname, "./corporationState"));
const {
  updateAllianceRecord,
  updateAllianceRuntime,
} = require(path.join(__dirname, "./corporationRuntimeState"));
const {
  buildAllianceWarInheritancePlan,
  handleAllianceClosed,
  inheritAllianceWarsForCorporation,
} = require(path.join(__dirname, "./allianceWarInheritance"));
const {
  getCorporationWarPermitStatus,
} = require(path.join(__dirname, "./warPermitState"));

const TABLE_NAME = "allianceDepartures";
const ROOT_VERSION = 1;
const DURABLE_DEPARTURE_JOB_TYPE = "alliance.member-departure";
const DURABLE_CLOSURE_JOB_TYPE = "alliance.close";
const DURABLE_DEPARTURE_JOB_PREFIX = "alliance-departure:";
const DURABLE_CLOSURE_JOB_PREFIX = "alliance-closure:";
const FILETIME_EPOCH_OFFSET = 116444736000000000n;
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

function normalizeNowMs(value = Date.now()) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : Date.now();
}

function filetimeFromMs(value = Date.now()) {
  return (
    BigInt(normalizeNowMs(value)) * 10000n + FILETIME_EPOCH_OFFSET
  ).toString();
}

function emptyRoot() {
  return {
    version: ROOT_VERSION,
    departuresByOperationID: {},
    activeDepartureByCorporationID: {},
    closuresByAllianceID: {},
    pendingSovTransfersByAllianceID: {},
  };
}

function normalizePendingSovTransfers(value) {
  const normalized = {};
  if (!value || typeof value !== "object") {
    return normalized;
  }
  for (const [allianceID, stored] of Object.entries(value)) {
    if (!stored || typeof stored !== "object") {
      continue;
    }
    // Migrate the original single-receipt shape without losing an in-flight
    // custody transfer after an upgrade.
    if (stored.operationID) {
      normalized[allianceID] = {
        [String(stored.operationID)]: cloneValue(stored),
      };
      continue;
    }
    const transfers = {};
    for (const [operationID, pending] of Object.entries(stored)) {
      if (!pending || typeof pending !== "object" || !pending.operationID) {
        continue;
      }
      transfers[String(operationID)] = cloneValue(pending);
    }
    if (Object.keys(transfers).length > 0) {
      normalized[allianceID] = transfers;
    }
  }
  return normalized;
}

function readRoot() {
  database.ensureTable(TABLE_NAME);
  const result = database.read(TABLE_NAME, "/");
  const stored = result && result.success && result.data &&
    typeof result.data === "object"
    ? cloneValue(result.data)
    : {};
  return {
    ...emptyRoot(),
    ...stored,
    version: ROOT_VERSION,
    departuresByOperationID:
      stored.departuresByOperationID &&
      typeof stored.departuresByOperationID === "object"
        ? stored.departuresByOperationID
        : {},
    activeDepartureByCorporationID:
      stored.activeDepartureByCorporationID &&
      typeof stored.activeDepartureByCorporationID === "object"
        ? stored.activeDepartureByCorporationID
        : {},
    closuresByAllianceID:
      stored.closuresByAllianceID &&
      typeof stored.closuresByAllianceID === "object"
        ? stored.closuresByAllianceID
        : {},
    pendingSovTransfersByAllianceID:
      stored.pendingSovTransfersByAllianceID &&
      typeof stored.pendingSovTransfersByAllianceID === "object"
        ? normalizePendingSovTransfers(stored.pendingSovTransfersByAllianceID)
        : {},
  };
}

function writeRoot(root) {
  database.ensureTable(TABLE_NAME);
  const writeResult = database.write(TABLE_NAME, "/", {
    ...emptyRoot(),
    ...cloneValue(root),
    version: ROOT_VERSION,
  });
  if (!writeResult || writeResult.success !== true) {
    return writeResult || { success: false, errorMsg: "WRITE_ERROR" };
  }
  const flushResult = database.flushTableSync(TABLE_NAME);
  return flushResult && flushResult.success === true
    ? writeResult
    : flushResult || { success: false, errorMsg: "FLUSH_ERROR" };
}

function updateRoot(updater) {
  const root = readRoot();
  const next = typeof updater === "function"
    ? updater(root) || root
    : root;
  const result = writeRoot(next);
  return result && result.success === true
    ? { success: true, data: cloneValue(next) }
    : result || { success: false, errorMsg: "ALLIANCE_DEPARTURE_WRITE_FAILED" };
}

function updateDeparture(operationID, updater) {
  const normalizedOperationID = String(operationID || "").trim();
  if (!normalizedOperationID) {
    return { success: false, errorMsg: "INVALID_DEPARTURE_OPERATION" };
  }
  let updated = null;
  const result = updateRoot((root) => {
    const current = root.departuresByOperationID[normalizedOperationID];
    if (!current) {
      return root;
    }
    updated = typeof updater === "function"
      ? updater(cloneValue(current), root) || current
      : current;
    root.departuresByOperationID[normalizedOperationID] = cloneValue(updated);
    return root;
  });
  if (!updated) {
    return { success: false, errorMsg: "ALLIANCE_DEPARTURE_NOT_FOUND" };
  }
  return result.success
    ? { success: true, data: cloneValue(updated) }
    : result;
}

function updateClosure(allianceID, updater) {
  const numericAllianceID = normalizePositiveInteger(allianceID);
  if (!numericAllianceID) {
    return { success: false, errorMsg: "INVALID_ALLIANCE" };
  }
  let updated = null;
  const result = updateRoot((root) => {
    const current = root.closuresByAllianceID[String(numericAllianceID)];
    if (!current) {
      return root;
    }
    updated = typeof updater === "function"
      ? updater(cloneValue(current), root) || current
      : current;
    root.closuresByAllianceID[String(numericAllianceID)] = cloneValue(updated);
    return root;
  });
  if (!updated) {
    return { success: false, errorMsg: "ALLIANCE_CLOSURE_NOT_FOUND" };
  }
  return result.success
    ? { success: true, data: cloneValue(updated) }
    : result;
}

function getAllianceDeparture(operationID) {
  return cloneValue(
    readRoot().departuresByOperationID[String(operationID || "").trim()] || null,
  );
}

function getAllianceClosure(allianceID) {
  const root = readRoot();
  const numericAllianceID = normalizePositiveInteger(allianceID);
  if (numericAllianceID) {
    return cloneValue(
      root.closuresByAllianceID[String(numericAllianceID)] || null,
    );
  }
  const closureID = String(allianceID || "").trim();
  return cloneValue(
    Object.values(root.closuresByAllianceID).find(
      (closure) => closure && closure.closureID === closureID,
    ) || null,
  );
}

function getClosureByID(closureID) {
  const normalizedClosureID = String(closureID || "").trim();
  if (!normalizedClosureID) {
    return null;
  }
  return cloneValue(
    Object.values(readRoot().closuresByAllianceID).find(
      (closure) => closure && closure.closureID === normalizedClosureID,
    ) || null,
  );
}

function getSupersedingClosure(closureID, allianceID = null) {
  const normalizedClosureID = String(closureID || "").trim();
  const numericAllianceID = normalizePositiveInteger(
    allianceID || normalizedClosureID.split("-", 1)[0],
  );
  if (!normalizedClosureID || !numericAllianceID) {
    return null;
  }
  const current = getAllianceClosure(numericAllianceID);
  return current && current.closureID !== normalizedClosureID
    ? current
    : null;
}

function listPendingAllianceDepartures() {
  return Object.values(readRoot().departuresByOperationID)
    .filter((departure) => departure && !["complete", "cancelled"].includes(
      departure.status,
    ))
    .map(cloneValue);
}

function listPendingAllianceClosures() {
  return Object.values(readRoot().closuresByAllianceID)
    .filter((closure) => closure && ["preparing", "scheduled", "settling"].includes(
      closure.status,
    ))
    .map(cloneValue);
}

function buildDepartureOperationID(options = {}) {
  const allianceID = normalizePositiveInteger(options.allianceID);
  const corporationID = normalizePositiveInteger(options.corporationID);
  const membershipStartFiletime = String(
    options.membershipStartFiletime || "0",
  );
  if (!allianceID || !corporationID || membershipStartFiletime === "0") {
    return null;
  }
  const digest = crypto.createHash("sha256").update(
    `${allianceID}:${corporationID}:${membershipStartFiletime}`,
  ).digest("hex").slice(0, 24);
  return `${allianceID}-${corporationID}-${digest}`;
}

function buildDepartureJob(departureOrID) {
  const departure = departureOrID && typeof departureOrID === "object"
    ? cloneValue(departureOrID)
    : getAllianceDeparture(departureOrID);
  return departure
    ? {
        jobID: `${DURABLE_DEPARTURE_JOB_PREFIX}${departure.operationID}`,
        type: DURABLE_DEPARTURE_JOB_TYPE,
        dueAtMs: Number(departure.effectiveAtMs || departure.requestedAtMs),
        payload: { operationID: departure.operationID },
      }
    : null;
}

function buildClosureJob(closureOrID) {
  const closure = typeof closureOrID === "object"
    ? cloneValue(closureOrID)
    : getClosureByID(closureOrID) || getAllianceClosure(closureOrID);
  return closure
    ? {
        jobID: `${DURABLE_CLOSURE_JOB_PREFIX}${closure.closureID}`,
        type: DURABLE_CLOSURE_JOB_TYPE,
        dueAtMs: Number(closure.dueAtMs),
        payload: {
          closureID: closure.closureID,
          allianceID: closure.allianceID,
        },
      }
    : null;
}

async function scheduleJob(job) {
  if (!job || !durableScheduler) {
    return null;
  }
  await durableScheduler.schedule(job);
  return job;
}

function queueJob(job) {
  if (!job || !durableScheduler) {
    return;
  }
  void scheduleJob(job).catch((error) => {
    log.warn(`[AllianceDeparture] scheduling failed job=${job.jobID}: ${error.message}`);
  });
}

function getSovereigntyLifecycle() {
  try {
    return require(path.join(
      __dirname,
      "../sovereignty/allianceSovereigntyLifecycle",
    ));
  } catch (error) {
    if (error && error.code === "MODULE_NOT_FOUND") {
      return null;
    }
    throw error;
  }
}

function buildSovereigntyPlan(allianceID, corporationID) {
  const lifecycle = getSovereigntyLifecycle();
  if (!lifecycle ||
      typeof lifecycle.buildAllianceSovereigntyDeparturePlan !== "function") {
    return null;
  }
  return lifecycle.buildAllianceSovereigntyDeparturePlan({
    allianceID,
    corporationID,
  });
}

function prepareAllianceDeparture(options = {}) {
  const allianceID = normalizePositiveInteger(options.allianceID);
  const corporationID = normalizePositiveInteger(options.corporationID);
  const actorCharacterID = normalizePositiveInteger(options.actorCharacterID);
  const actorCorporationID = normalizePositiveInteger(
    options.actorCorporationID,
  );
  const mode = options.mode === "executor-kick"
    ? "executor-kick"
    : "self-leave";
  const nowMs = normalizeNowMs(
    options.requestedAtMs !== undefined
      ? options.requestedAtMs
      : options.nowMs,
  );
  const alliance = getAllianceRecord(allianceID);
  const corporation = getCorporationRecord(corporationID);
  if (!alliance || alliance.deleted || !corporation) {
    return { success: false, errorMsg: "ALLIANCE_MEMBER_NOT_FOUND" };
  }
  if (
    Number(corporation.allianceID || 0) !== allianceID ||
    !getAllianceCorporationIDs(allianceID).includes(corporationID)
  ) {
    return { success: false, errorMsg: "ALLIANCE_MEMBER_NOT_FOUND" };
  }

  const membershipStartFiletime = String(
    getAllianceMembershipStartFiletime(allianceID, corporationID),
  );
  const operationID = buildDepartureOperationID({
    allianceID,
    corporationID,
    membershipStartFiletime,
  });
  if (!operationID) {
    return { success: false, errorMsg: "INVALID_ALLIANCE_MEMBERSHIP" };
  }
  const requestFingerprint = JSON.stringify({
    allianceID,
    corporationID,
    membershipStartFiletime,
    actorCharacterID: actorCharacterID || null,
    actorCorporationID: actorCorporationID || null,
    mode,
  });
  const root = readRoot();
  const activeOperationID = root.activeDepartureByCorporationID[
    String(corporationID)
  ];
  if (activeOperationID) {
    const active = root.departuresByOperationID[activeOperationID];
    if (!active || active.requestFingerprint !== requestFingerprint) {
      return { success: false, errorMsg: "ALLIANCE_DEPARTURE_ALREADY_PENDING" };
    }
    queueJob(buildDepartureJob(active.operationID));
    return { success: true, duplicate: true, data: cloneValue(active) };
  }
  if (root.departuresByOperationID[operationID]) {
    return {
      success: true,
      duplicate: true,
      data: cloneValue(root.departuresByOperationID[operationID]),
    };
  }

  const leaveFiletime = filetimeFromMs(nowMs);
  const departure = {
    schemaVersion: 1,
    operationID,
    requestFingerprint,
    allianceID,
    corporationID,
    actorCharacterID: actorCharacterID || null,
    actorCorporationID: actorCorporationID || null,
    mode,
    membershipStartFiletime,
    requestedAtMs: nowMs,
    effectiveAtMs: nowMs,
    leaveFiletime,
    expectedMemberCorporationIDs: getAllianceCorporationIDs(allianceID),
    sourceExecutorCorporationID:
      normalizePositiveInteger(alliance.executorCorporationID) || null,
    notificationBefore: {
      member: buildAllianceMemberSnapshot(allianceID, corporationID),
      alliance: buildAllianceSummary(allianceID),
      corporation: buildCorporationSnapshot(corporationID),
    },
    sovereigntyPlan: buildSovereigntyPlan(allianceID, corporationID),
    warPlan: buildAllianceWarInheritancePlan({
      allianceID,
      corporationID,
      nowFiletime: leaveFiletime,
    }),
    postDepartureWarEligible: Boolean(
      getCorporationWarPermitStatus(corporationID),
    ),
    sovereigntyResult: null,
    governanceResult: null,
    warResult: null,
    closureID: null,
    checkpoints: {
      historyRecorded: false,
      affiliationCleared: false,
      governanceRecomputed: false,
      sovereigntySettled: false,
      warsInherited: false,
      closurePrepared: false,
      notificationsComplete: false,
    },
    status: "prepared",
    completedAtMs: null,
  };
  root.departuresByOperationID[operationID] = departure;
  root.activeDepartureByCorporationID[String(corporationID)] = operationID;
  const result = writeRoot(root);
  if (!result || result.success !== true) {
    return result || { success: false, errorMsg: "ALLIANCE_DEPARTURE_WRITE_FAILED" };
  }
  queueJob(buildDepartureJob(operationID));
  return { success: true, duplicate: false, data: cloneValue(departure) };
}

function runSerialized(laneID, operation) {
  const laneKey = String(laneID || "");
  const active = settlementLanes.get(laneKey);
  if (active) {
    return active.then(operation, operation);
  }
  const current = Promise.resolve().then(operation);
  settlementLanes.set(laneKey, current);
  void current.finally(() => {
    if (settlementLanes.get(laneKey) === current) {
      settlementLanes.delete(laneKey);
    }
  }).catch(() => null);
  return current;
}

function flushTables(tables, errorMsg) {
  const result = database.flushTablesSync(tables);
  return result && result.success === true
    ? { success: true }
    : result || { success: false, errorMsg };
}

function checkpointDeparture(operationID, changes) {
  return updateDeparture(operationID, (current) => ({
    ...current,
    ...cloneValue(changes),
    checkpoints: {
      ...(current.checkpoints || {}),
      ...(changes && changes.checkpoints || {}),
    },
  }));
}

function activatePreparedClosure(closureID) {
  const closure = getClosureByID(closureID);
  if (!closure) {
    return { success: false, errorMsg: "ALLIANCE_CLOSURE_NOT_FOUND" };
  }
  const alliance = getAllianceRecord(closure.allianceID);
  if (!alliance || alliance.deleted) {
    return { success: false, errorMsg: "INVALID_ALLIANCE_CLOSURE" };
  }
  const pendingWrite = updateAllianceRecord(closure.allianceID, {
    closurePendingAtMs: closure.scheduledAtMs,
    closureDueAtMs: closure.dueAtMs,
    closureReason: closure.reason,
    closureID: closure.closureID,
    closureTriggerID: closure.triggerOperationID,
    closureRequireEmpty: closure.requireEmpty,
  });
  if (!pendingWrite || pendingWrite.success !== true) {
    return pendingWrite || {
      success: false,
      errorMsg: "ALLIANCE_CLOSURE_WRITE_FAILED",
    };
  }
  const allianceFlush = flushTables(
    ["alliances"],
    "ALLIANCE_CLOSURE_FLUSH_FAILED",
  );
  if (!allianceFlush.success) {
    return allianceFlush;
  }
  const activated = updateClosure(closure.allianceID, (current) => ({
    ...current,
    pendingFieldsApplied: true,
    pendingFieldsAppliedAtMs: normalizeNowMs(),
    status: current.status === "preparing" ? "scheduled" : current.status,
  }));
  return activated.success
    ? { success: true, data: activated.data }
    : activated;
}

function prepareAllianceClosure(options = {}) {
  const allianceID = normalizePositiveInteger(options.allianceID);
  const reason = String(options.reason || "").trim();
  const triggerID = String(options.triggerID || "").trim();
  const requireEmpty = options.requireEmpty !== false;
  const nowMs = normalizeNowMs(options.nowMs);
  const alliance = getAllianceRecord(allianceID);
  if (!allianceID || !alliance || alliance.deleted || !reason || !triggerID) {
    return { success: false, errorMsg: "INVALID_ALLIANCE_CLOSURE" };
  }
  if (requireEmpty && getAllianceCorporationIDs(allianceID).length > 0) {
    return { success: false, errorMsg: "ALLIANCE_NOT_EMPTY" };
  }
  const existing = getAllianceClosure(allianceID);
  if (
    existing &&
    existing.triggerOperationID === triggerID &&
    existing.reason === reason &&
    existing.requireEmpty === requireEmpty &&
    ["preparing", "scheduled", "settling", "complete"].includes(existing.status)
  ) {
    if (existing.status === "preparing" || existing.pendingFieldsApplied !== true) {
      const activation = activatePreparedClosure(existing.closureID);
      if (!activation.success) {
        return activation;
      }
      queueJob(buildClosureJob(activation.data));
      return {
        success: true,
        duplicate: true,
        closureID: activation.data.closureID,
        data: activation.data,
      };
    }
    return {
      success: true,
      duplicate: true,
      closureID: existing.closureID,
      data: existing,
    };
  }
  const dueAtMs = getNextClusterDowntimeAtMs(
    nowMs,
    config.clusterDowntimeStarts,
  );
  const closureDigest = crypto.createHash("sha256").update(
    `${allianceID}:${reason}:${triggerID}`,
  ).digest("hex").slice(0, 24);
  const closureID = `${allianceID}-${closureDigest}`;
  const closure = {
    schemaVersion: 1,
    closureID,
    allianceID,
    reason,
    triggerOperationID: triggerID,
    requireEmpty,
    expectedEmptySinceFiletime:
      options.expectedEmptySinceFiletime == null
        ? null
        : String(options.expectedEmptySinceFiletime),
    scheduledAtMs: nowMs,
    dueAtMs,
    notificationBefore: {
      alliance: buildAllianceSummary(allianceID),
    },
    sovereigntyPlan: buildSovereigntyPlan(allianceID, null),
    sovereigntyResult: null,
    droppedSystemIDs: [],
    sovereigntyDropped: false,
    applicationsClosed: false,
    warsClosed: false,
    tombstoned: false,
    notificationsComplete: false,
    pendingFieldsApplied: false,
    status: "preparing",
    completedAtMs: null,
  };
  const write = updateRoot((root) => {
    root.closuresByAllianceID[String(allianceID)] = cloneValue(closure);
    return root;
  });
  if (!write.success) {
    return write;
  }
  const activation = activatePreparedClosure(closureID);
  if (!activation.success) {
    // The receipt was flushed first, so startup reconciliation or the durable
    // handler can finish the cross-table pending marker without orphaning the
    // alliance in an unrecoverable closing state.
    queueJob(buildClosureJob(closure));
    return activation;
  }
  const activatedClosure = activation.data;
  queueJob(buildClosureJob(activatedClosure));
  return {
    success: true,
    duplicate: false,
    closureID,
    data: activatedClosure,
  };
}

function prepareClosureForEmptyAlliance(departure, nowMs) {
  return prepareAllianceClosure({
    allianceID: departure.allianceID,
    reason: "last-member-left",
    triggerID: departure.operationID,
    requireEmpty: true,
    expectedEmptySinceFiletime: departure.leaveFiletime,
    nowMs,
  });
}

function settleDepartureSovereignty(departure, remainingMemberCorporationIDs) {
  if (!departure.sovereigntyPlan ||
      !Array.isArray(departure.sovereigntyPlan.systems) ||
      departure.sovereigntyPlan.systems.length === 0) {
    return { success: true, data: { transferred: 0, skipped: true } };
  }
  if (remainingMemberCorporationIDs.length === 0) {
    return { success: true, data: { transferred: 0, deferredToClosure: true } };
  }
  const executorCorporationID = getActiveExecutorCorporationID(
    departure.allianceID,
  );
  if (!executorCorporationID) {
    const write = updateRoot((root) => {
      const allianceKey = String(departure.allianceID);
      const pendingByOperation =
        root.pendingSovTransfersByAllianceID[allianceKey] &&
        typeof root.pendingSovTransfersByAllianceID[allianceKey] === "object"
          ? root.pendingSovTransfersByAllianceID[allianceKey]
          : {};
      pendingByOperation[String(departure.operationID)] = {
        operationID: departure.operationID,
        allianceID: departure.allianceID,
        fromCorporationID: departure.corporationID,
        plan: cloneValue(departure.sovereigntyPlan),
        createdAtMs: Date.now(),
        status: "awaiting-executor",
      };
      root.pendingSovTransfersByAllianceID[allianceKey] = pendingByOperation;
      return root;
    });
    return write.success
      ? { success: true, awaitingExecutor: true, data: { transferred: 0 } }
      : write;
  }
  const lifecycle = getSovereigntyLifecycle();
  if (!lifecycle ||
      typeof lifecycle.transferAllianceSovereigntyOwnership !== "function") {
    return { success: false, errorMsg: "SOVEREIGNTY_LIFECYCLE_UNAVAILABLE" };
  }
  const result = lifecycle.transferAllianceSovereigntyOwnership({
    operationID: departure.operationID,
    allianceID: departure.allianceID,
    fromCorporationID: departure.corporationID,
    toCorporationID: executorCorporationID,
    plan: departure.sovereigntyPlan,
  });
  if (!result || result.success !== true) {
    return result || { success: false, errorMsg: "SOVEREIGNTY_TRANSFER_FAILED" };
  }
  const flush = flushTables(
    ["sovereignty", "structures"],
    "SOVEREIGNTY_TRANSFER_FLUSH_FAILED",
  );
  return flush.success ? result : flush;
}

async function settleAllianceDepartureInternal(operationID, options = {}) {
  let departure = getAllianceDeparture(operationID);
  if (!departure) {
    return { success: false, errorMsg: "ALLIANCE_DEPARTURE_NOT_FOUND" };
  }
  if (departure.status === "complete") {
    return { success: true, alreadySettled: true, data: departure };
  }
  if (departure.status === "cancelled") {
    return { success: true, stale: true, cancelled: true, data: departure };
  }
  const nowMs = normalizeNowMs(options.nowMs);
  if (nowMs < Number(departure.effectiveAtMs || 0)) {
    return { success: false, errorMsg: "ALLIANCE_DEPARTURE_NOT_DUE" };
  }
  const currentCorporation = getCorporationRecord(departure.corporationID);
  const currentAllianceID = normalizePositiveInteger(
    currentCorporation && currentCorporation.allianceID,
  );
  const currentMembershipStartFiletime = currentAllianceID === departure.allianceID
    ? String(getAllianceMembershipStartFiletime(
        departure.allianceID,
        departure.corporationID,
      ))
    : null;
  if (
    (currentAllianceID && currentAllianceID !== departure.allianceID) ||
    (currentAllianceID === departure.allianceID &&
      currentMembershipStartFiletime !== String(departure.membershipStartFiletime))
  ) {
    const cancelled = updateDeparture(operationID, (current, root) => {
      delete root.activeDepartureByCorporationID[String(current.corporationID)];
      return {
        ...current,
        status: "cancelled",
        cancelReason: "membership-epoch-changed",
        cancelledAtMs: nowMs,
      };
    });
    return cancelled.success
      ? { success: true, stale: true, cancelled: true, data: cancelled.data }
      : cancelled;
  }
  if (departure.status === "awaiting-executor") {
    const resumed = resumePendingSovCustody(departure.allianceID);
    if (!resumed.success || resumed.awaitingExecutor) {
      return { success: true, awaitingExecutor: true, data: departure };
    }
    const completed = checkpointDeparture(operationID, {
      status: "complete",
      completedAtMs: nowMs,
    });
    return completed.success
      ? { success: true, data: completed.data }
      : completed;
  }

  if (departure.status === "prepared") {
    const settling = checkpointDeparture(operationID, { status: "settling" });
    if (!settling.success) {
      return settling;
    }
    departure = settling.data;
  }

  if (!departure.checkpoints.historyRecorded) {
    const corporation = getCorporationRecord(departure.corporationID);
    if (Number(corporation && corporation.allianceID || 0) === departure.allianceID) {
      const historyResult = recordAllianceMemberLeave(
        departure.allianceID,
        departure.corporationID,
        departure.leaveFiletime,
      );
      if (!historyResult || historyResult.success !== true) {
        return historyResult || { success: false, errorMsg: "ALLIANCE_HISTORY_WRITE_FAILED" };
      }
      const historyFlush = flushTables(
        ["corporationRuntime"],
        "ALLIANCE_HISTORY_FLUSH_FAILED",
      );
      if (!historyFlush.success) {
        return historyFlush;
      }
    }
    const checkpoint = checkpointDeparture(operationID, {
      checkpoints: { historyRecorded: true },
    });
    if (!checkpoint.success) {
      return checkpoint;
    }
    departure = checkpoint.data;
  }

  if (!departure.checkpoints.affiliationCleared) {
    const corporation = getCorporationRecord(departure.corporationID);
    const currentAllianceID = normalizePositiveInteger(
      corporation && corporation.allianceID,
    );
    if (currentAllianceID && currentAllianceID !== departure.allianceID) {
      return { success: false, errorMsg: "ALLIANCE_MEMBERSHIP_CHANGED" };
    }
    // Run the affiliation command even when the corporation row already says
    // unaffiliated. A crash can happen after that row is written but before all
    // character rows are repaired; the idempotent retry must finish the fanout.
    const affiliation = setCorporationAlliance(departure.corporationID, null);
    if (!affiliation || affiliation.success !== true) {
      return affiliation || { success: false, errorMsg: "ALLIANCE_AFFILIATION_WRITE_FAILED" };
    }
    const affiliationFlush = flushTables(
      ["alliances", "corporations", "characters"],
      "ALLIANCE_AFFILIATION_FLUSH_FAILED",
    );
    if (!affiliationFlush.success) {
      return affiliationFlush;
    }
    const checkpoint = checkpointDeparture(operationID, {
      checkpoints: { affiliationCleared: true },
    });
    if (!checkpoint.success) {
      return checkpoint;
    }
    departure = checkpoint.data;
  }

  if (!departure.checkpoints.governanceRecomputed) {
    const memberStateCleanup = removeAllianceCorporationState(
      departure.allianceID,
      departure.corporationID,
    );
    if (!memberStateCleanup || memberStateCleanup.success !== true) {
      return memberStateCleanup || {
        success: false,
        errorMsg: "ALLIANCE_MEMBER_STATE_CLEANUP_FAILED",
      };
    }
    const governance = cleanupAllianceGovernanceForDeparture(
      departure.allianceID,
      departure.corporationID,
    );
    if (!governance || governance.success !== true) {
      return governance || { success: false, errorMsg: "ALLIANCE_GOVERNANCE_FAILED" };
    }
    const runtimeFlush = flushTables(
      ["corporationRuntime", "alliances"],
      "ALLIANCE_GOVERNANCE_FLUSH_FAILED",
    );
    if (!runtimeFlush.success) {
      return runtimeFlush;
    }
    const checkpoint = checkpointDeparture(operationID, {
      governanceResult: governance.data || null,
      checkpoints: { governanceRecomputed: true },
    });
    if (!checkpoint.success) {
      return checkpoint;
    }
    departure = checkpoint.data;
  }

  const remainingMemberCorporationIDs = getAllianceCorporationIDs(
    departure.allianceID,
  );
  if (!departure.checkpoints.sovereigntySettled) {
    const sovereignty = settleDepartureSovereignty(
      departure,
      remainingMemberCorporationIDs,
    );
    if (!sovereignty || sovereignty.success !== true) {
      return sovereignty || { success: false, errorMsg: "SOVEREIGNTY_TRANSFER_FAILED" };
    }
    const checkpoint = checkpointDeparture(operationID, {
      sovereigntyResult: sovereignty.data || null,
      awaitingExecutor: sovereignty.awaitingExecutor === true,
      checkpoints: { sovereigntySettled: true },
    });
    if (!checkpoint.success) {
      return checkpoint;
    }
    departure = checkpoint.data;
  }

  if (!departure.checkpoints.warsInherited) {
    const inheritance = inheritAllianceWarsForCorporation({
      operationID: departure.operationID,
      allianceID: departure.allianceID,
      corporationID: departure.corporationID,
      plan: departure.warPlan,
      nowFiletime: departure.leaveFiletime,
      postDepartureWarEligible:
        departure.postDepartureWarEligible === true,
    });
    if (!inheritance || inheritance.success !== true) {
      return inheritance || {
        success: false,
        errorMsg: "ALLIANCE_WAR_INHERITANCE_FAILED",
      };
    }
    const checkpoint = checkpointDeparture(operationID, {
      warResult: inheritance.data || null,
      checkpoints: { warsInherited: true },
    });
    if (!checkpoint.success) {
      return checkpoint;
    }
    departure = checkpoint.data;
  }

  if (!departure.checkpoints.closurePrepared) {
    let closure = null;
    if (
      remainingMemberCorporationIDs.length === 0 &&
      options.suppressClosure !== true
    ) {
      const closureResult = prepareClosureForEmptyAlliance(departure, nowMs);
      if (!closureResult || closureResult.success !== true) {
        return closureResult || { success: false, errorMsg: "ALLIANCE_CLOSURE_FAILED" };
      }
      closure = closureResult.data;
    }
    const checkpoint = checkpointDeparture(operationID, {
      closureID: closure && closure.closureID || null,
      checkpoints: { closurePrepared: true },
    });
    if (!checkpoint.success) {
      return checkpoint;
    }
    departure = checkpoint.data;
  }

  if (!departure.checkpoints.notificationsComplete) {
    // Legacy live events have no acknowledgement or idempotency token. Persist
    // an at-most-once dispatch fence before sending so a crash/retry cannot
    // duplicate membership events. A crash in the narrow post-fence/pre-send
    // window may lose the live hint; durable owner state and relog caches remain
    // authoritative.
    const checkpoint = checkpointDeparture(operationID, {
      notificationDeliveryPolicy: "at-most-once",
      notificationsDispatchStartedAtMs: nowMs,
      checkpoints: { notificationsComplete: true },
    });
    if (!checkpoint.success) {
      return checkpoint;
    }
    departure = checkpoint.data;
    const before = departure.notificationBefore || {};
    notifyAllianceMemberChanged(
      departure.allianceID,
      departure.corporationID,
      before.member || null,
    );
    notifyAllianceChanged(departure.allianceID, before.alliance || null);
    notifyCorporationChanged(
      departure.corporationID,
      before.corporation || null,
    );
  }

  const awaitingExecutor = Boolean(
    departure.awaitingExecutor &&
    readRoot().pendingSovTransfersByAllianceID[String(departure.allianceID)]?.[
      String(departure.operationID)
    ],
  );
  const completed = updateDeparture(operationID, (current, root) => {
    delete root.activeDepartureByCorporationID[String(current.corporationID)];
    return {
      ...current,
      status: awaitingExecutor ? "awaiting-executor" : "complete",
      completedAtMs: nowMs,
    };
  });
  return completed.success
    ? {
        success: true,
        awaitingExecutor,
        data: completed.data,
      }
    : completed;
}

function settleAllianceDeparture(operationID, options = {}) {
  const departure = getAllianceDeparture(operationID);
  if (!departure) {
    return Promise.resolve({
      success: false,
      errorMsg: "ALLIANCE_DEPARTURE_NOT_FOUND",
    });
  }
  return runSerialized(`alliance:${departure.allianceID}`, () =>
    settleAllianceDepartureInternal(operationID, options));
}

function clearPendingClosureFields(allianceID) {
  return updateAllianceRecord(allianceID, {
    closurePendingAtMs: null,
    closureDueAtMs: null,
    closureReason: null,
    closureID: null,
    closureTriggerID: null,
    closureRequireEmpty: null,
  });
}

function alliancePendingClosureMatches(alliance, closure) {
  return Boolean(
    alliance &&
    !alliance.deleted &&
    Number(alliance.closurePendingAtMs) === Number(closure.scheduledAtMs) &&
    Number(alliance.closureDueAtMs) === Number(closure.dueAtMs) &&
    String(alliance.closureReason || "") === String(closure.reason || "") &&
    String(alliance.closureID || "") === String(closure.closureID || "") &&
    String(alliance.closureTriggerID || "") ===
      String(closure.triggerOperationID || "") &&
    Boolean(alliance.closureRequireEmpty) === Boolean(closure.requireEmpty)
  );
}

function allianceTombstoneMatchesClosure(alliance, closure) {
  return Boolean(
    alliance &&
    alliance.deleted &&
    String(alliance.closedByClosureID || "") === String(closure.closureID || "") &&
    String(alliance.closedByClosureTriggerID || "") ===
      String(closure.triggerOperationID || "")
  );
}

async function settleClosureMemberDepartures(closure, nowMs) {
  const alliance = getAllianceRecord(closure.allianceID);
  const executorCorporationID = normalizePositiveInteger(
    alliance && alliance.executorCorporationID,
  );
  const memberCorporationIDs = getAllianceCorporationIDs(closure.allianceID)
    .sort((left, right) => {
      if (left === executorCorporationID) {
        return 1;
      }
      if (right === executorCorporationID) {
        return -1;
      }
      return left - right;
    });
  const settledOperationIDs = [];
  for (const corporationID of memberCorporationIDs) {
    let operationID = readRoot().activeDepartureByCorporationID[
      String(corporationID)
    ] || null;
    if (operationID) {
      const activeResult = await settleAllianceDepartureInternal(operationID, {
        nowMs,
        suppressClosure: true,
      });
      if (!activeResult || activeResult.success !== true) {
        return activeResult || {
          success: false,
          errorMsg: "ALLIANCE_CLOSURE_MEMBER_DEPARTURE_FAILED",
        };
      }
    }
    if (
      Number(getCorporationRecord(corporationID)?.allianceID || 0) !==
      closure.allianceID
    ) {
      if (operationID) {
        settledOperationIDs.push(operationID);
      }
      continue;
    }
    const prepared = prepareAllianceDeparture({
      allianceID: closure.allianceID,
      corporationID,
      actorCharacterID: null,
      actorCorporationID: null,
      mode: "self-leave",
      requestedAtMs: nowMs,
    });
    if (!prepared || prepared.success !== true) {
      return prepared || {
        success: false,
        errorMsg: "ALLIANCE_CLOSURE_MEMBER_PREPARE_FAILED",
      };
    }
    operationID = prepared.data.operationID;
    const settled = await settleAllianceDepartureInternal(operationID, {
      nowMs,
      suppressClosure: true,
    });
    if (!settled || settled.success !== true) {
      return settled || {
        success: false,
        errorMsg: "ALLIANCE_CLOSURE_MEMBER_DEPARTURE_FAILED",
      };
    }
    settledOperationIDs.push(operationID);
  }
  return { success: true, data: { settledOperationIDs } };
}

async function settleAllianceClosureInternal(closureID, options = {}) {
  let closure = getClosureByID(closureID);
  if (!closure) {
    return { success: false, errorMsg: "ALLIANCE_CLOSURE_NOT_FOUND" };
  }
  if (closure.status === "complete" || closure.status === "cancelled") {
    return { success: true, alreadySettled: true, data: closure };
  }
  if (closure.status === "preparing" || closure.pendingFieldsApplied !== true) {
    const activation = activatePreparedClosure(closure.closureID);
    if (!activation || activation.success !== true) {
      return activation || {
        success: false,
        errorMsg: "ALLIANCE_CLOSURE_ACTIVATION_FAILED",
      };
    }
    closure = activation.data;
  }
  const nowMs = normalizeNowMs(options.nowMs);
  if (nowMs < Number(closure.dueAtMs)) {
    return { success: true, pending: true, data: closure, closure };
  }
  const alliance = getAllianceRecord(closure.allianceID);
  const ownedTombstone = allianceTombstoneMatchesClosure(alliance, closure);
  if (!ownedTombstone && !alliancePendingClosureMatches(alliance, closure)) {
    const stale = updateClosure(closure.allianceID, (current) => ({
      ...current,
      status: "cancelled",
      cancelledAtMs: nowMs,
      cancelReason: "closure-fingerprint-changed",
    }));
    return stale.success
      ? { success: true, stale: true, cancelled: true, data: stale.data }
      : stale;
  }
  if (!ownedTombstone &&
    closure.requireEmpty !== false &&
    getAllianceCorporationIDs(closure.allianceID).length > 0
  ) {
    const clearResult = clearPendingClosureFields(closure.allianceID);
    if (!clearResult || clearResult.success !== true) {
      return clearResult || { success: false, errorMsg: "ALLIANCE_CLOSURE_CANCEL_FAILED" };
    }
    const flush = flushTables(["alliances"], "ALLIANCE_CLOSURE_CANCEL_FLUSH_FAILED");
    if (!flush.success) {
      return flush;
    }
    const cancelled = updateClosure(closure.allianceID, (current) => ({
      ...current,
      status: "cancelled",
      cancelledAtMs: nowMs,
      cancelReason: "alliance-no-longer-empty",
    }));
    return cancelled.success
      ? { success: true, cancelled: true, data: cancelled.data }
      : cancelled;
  }
  if (!ownedTombstone &&
    closure.requireEmpty === false &&
    getAllianceCorporationIDs(closure.allianceID).length > 0
  ) {
    const memberDepartures = await settleClosureMemberDepartures(
      closure,
      nowMs,
    );
    if (!memberDepartures || memberDepartures.success !== true) {
      return memberDepartures || {
        success: false,
        errorMsg: "ALLIANCE_CLOSURE_MEMBER_DEPARTURES_FAILED",
      };
    }
    const checkpoint = updateClosure(closure.allianceID, (current) => ({
      ...current,
      memberDeparturesComplete: true,
      memberDepartureOperationIDs:
        memberDepartures.data.settledOperationIDs,
    }));
    if (!checkpoint.success) {
      return checkpoint;
    }
    closure = checkpoint.data;
  }
  if (closure.status === "scheduled") {
    const settling = updateClosure(closure.allianceID, (current) => ({
      ...current,
      status: "settling",
    }));
    if (!settling.success) {
      return settling;
    }
    closure = settling.data;
  }

  if (ownedTombstone && !closure.tombstoned) {
    const checkpoint = updateClosure(closure.allianceID, (current) => ({
      ...current,
      tombstoned: true,
      tombstoneRecoveredAtMs: nowMs,
    }));
    if (!checkpoint.success) {
      return checkpoint;
    }
    closure = checkpoint.data;
  }

  if (!closure.sovereigntyPlanFinalized) {
    const checkpoint = updateClosure(closure.allianceID, (current) => ({
      ...current,
      sovereigntyPlan: buildSovereigntyPlan(closure.allianceID, null),
      sovereigntyPlanFinalized: true,
      sovereigntyPlanFinalizedAtMs: nowMs,
    }));
    if (!checkpoint.success) {
      return checkpoint;
    }
    closure = checkpoint.data;
  }

  if (!closure.sovereigntyDropped) {
    const lifecycle = getSovereigntyLifecycle();
    if (closure.sovereigntyPlan && lifecycle &&
        typeof lifecycle.dropAllianceSovereigntyClaims === "function") {
      const drop = lifecycle.dropAllianceSovereigntyClaims({
        operationID: closure.closureID,
        allianceID: closure.allianceID,
        plan: closure.sovereigntyPlan,
        reason: closure.reason,
      });
      if (!drop || drop.success !== true) {
        return drop || { success: false, errorMsg: "SOVEREIGNTY_DROP_FAILED" };
      }
      const flush = flushTables(
        ["sovereignty", "structures"],
        "SOVEREIGNTY_DROP_FLUSH_FAILED",
      );
      if (!flush.success) {
        return flush;
      }
      const checkpoint = updateClosure(closure.allianceID, (current) => ({
        ...current,
        sovereigntyResult: drop.data || null,
        droppedSystemIDs: Array.isArray(drop.data && drop.data.droppedSystemIDs)
          ? cloneValue(drop.data.droppedSystemIDs)
          : [],
        sovereigntyDropped: true,
      }));
      if (!checkpoint.success) {
        return checkpoint;
      }
      closure = checkpoint.data;
    } else {
      const checkpoint = updateClosure(closure.allianceID, (current) => ({
        ...current,
        sovereigntyDropped: true,
        sovereigntyResult: { dropped: 0, skipped: true },
      }));
      if (!checkpoint.success) {
        return checkpoint;
      }
      closure = checkpoint.data;
    }
  }

  if (!closure.applicationsClosed) {
    const applicationWrite = updateAllianceRuntime(
      closure.allianceID,
      (runtime) => {
        runtime.applications = {};
        return runtime;
      },
    );
    if (!applicationWrite || applicationWrite.success !== true) {
      return applicationWrite || { success: false, errorMsg: "ALLIANCE_APPLICATION_CLOSE_FAILED" };
    }
    const flush = flushTables(
      ["corporationRuntime"],
      "ALLIANCE_APPLICATION_CLOSE_FLUSH_FAILED",
    );
    if (!flush.success) {
      return flush;
    }
    const checkpoint = updateClosure(closure.allianceID, (current) => ({
      ...current,
      applicationsClosed: true,
    }));
    if (!checkpoint.success) {
      return checkpoint;
    }
    closure = checkpoint.data;
  }

  if (!closure.warsClosed) {
    const warResult = handleAllianceClosed({
      operationID: closure.closureID,
      allianceID: closure.allianceID,
      nowFiletime: filetimeFromMs(nowMs),
    });
    if (!warResult || warResult.success !== true) {
      return warResult || {
        success: false,
        errorMsg: "ALLIANCE_CLOSURE_WARS_FAILED",
      };
    }
    const checkpoint = updateClosure(closure.allianceID, (current) => ({
      ...current,
      warsClosed: true,
      warResult: warResult.data || null,
    }));
    if (!checkpoint.success) {
      return checkpoint;
    }
    closure = checkpoint.data;
  }

  if (!closure.tombstoned) {
    const tombstone = updateAllianceRecord(closure.allianceID, {
      deleted: 1,
      closedAt: filetimeFromMs(nowMs),
      closedAtMs: nowMs,
      closureReason: closure.reason,
      closurePendingAtMs: null,
      closureDueAtMs: null,
      closureID: null,
      closureTriggerID: null,
      closureRequireEmpty: null,
      closedByClosureID: closure.closureID,
      closedByClosureTriggerID: closure.triggerOperationID,
      executorCorporationID: null,
      memberCorporationIDs: [],
    });
    if (!tombstone || tombstone.success !== true) {
      return tombstone || { success: false, errorMsg: "ALLIANCE_TOMBSTONE_FAILED" };
    }
    const flush = flushTables(["alliances"], "ALLIANCE_TOMBSTONE_FLUSH_FAILED");
    if (!flush.success) {
      return flush;
    }
    const checkpoint = updateClosure(closure.allianceID, (current) => ({
      ...current,
      tombstoned: true,
    }));
    if (!checkpoint.success) {
      return checkpoint;
    }
    closure = checkpoint.data;
  }

  if (!closure.notificationsComplete) {
    const checkpoint = updateClosure(closure.allianceID, (current) => ({
      ...current,
      notificationDeliveryPolicy: "at-most-once",
      notificationsDispatchStartedAtMs: nowMs,
      notificationsComplete: true,
    }));
    if (!checkpoint.success) {
      return checkpoint;
    }
    closure = checkpoint.data;
    notifyAllianceChanged(
      closure.allianceID,
      closure.notificationBefore && closure.notificationBefore.alliance || null,
    );
  }

  const completed = updateClosure(closure.allianceID, (current, root) => {
    delete root.pendingSovTransfersByAllianceID[String(current.allianceID)];
    return {
      ...current,
      status: "complete",
      completedAtMs: nowMs,
    };
  });
  return completed.success
    ? {
        success: true,
        complete: true,
        data: completed.data,
        closure: completed.data,
      }
    : completed;
}

function settleAllianceClosure(closureID, options = {}) {
  const closure = getClosureByID(closureID) || getAllianceClosure(closureID);
  if (!closure) {
    const superseding = getSupersedingClosure(closureID);
    if (superseding) {
      return Promise.resolve({
        success: true,
        stale: true,
        supersededByClosureID: superseding.closureID,
      });
    }
    return Promise.resolve({ success: false, errorMsg: "ALLIANCE_CLOSURE_NOT_FOUND" });
  }
  return runSerialized(`alliance:${closure.allianceID}`, () =>
    settleAllianceClosureInternal(closure.closureID, options));
}

function resumePendingSovCustody(allianceID) {
  const numericAllianceID = normalizePositiveInteger(allianceID);
  const root = readRoot();
  const pendingByOperation =
    root.pendingSovTransfersByAllianceID[String(numericAllianceID)];
  const pendingTransfers = Object.values(
    pendingByOperation && typeof pendingByOperation === "object"
      ? pendingByOperation
      : {},
  ).sort((left, right) =>
    Number(left && left.createdAtMs || 0) - Number(right && right.createdAtMs || 0) ||
    String(left && left.operationID || "").localeCompare(
      String(right && right.operationID || ""),
    ));
  if (pendingTransfers.length === 0) {
    return { success: true, resumed: false };
  }
  const executorCorporationID = getActiveExecutorCorporationID(numericAllianceID);
  if (!executorCorporationID) {
    return { success: true, resumed: false, awaitingExecutor: true };
  }
  const lifecycle = getSovereigntyLifecycle();
  if (!lifecycle ||
      typeof lifecycle.transferAllianceSovereigntyOwnership !== "function") {
    return { success: false, errorMsg: "SOVEREIGNTY_LIFECYCLE_UNAVAILABLE" };
  }
  const results = [];
  for (const pending of pendingTransfers) {
    const transfer = lifecycle.transferAllianceSovereigntyOwnership({
      operationID: pending.operationID,
      allianceID: pending.allianceID,
      fromCorporationID: pending.fromCorporationID,
      toCorporationID: executorCorporationID,
      plan: pending.plan,
    });
    if (!transfer || transfer.success !== true) {
      return transfer || { success: false, errorMsg: "SOVEREIGNTY_TRANSFER_FAILED" };
    }
    const flush = flushTables(
      ["sovereignty", "structures"],
      "SOVEREIGNTY_TRANSFER_FLUSH_FAILED",
    );
    if (!flush.success) {
      return flush;
    }
    const write = updateRoot((nextRoot) => {
      const allianceKey = String(numericAllianceID);
      const nextPending = nextRoot.pendingSovTransfersByAllianceID[allianceKey];
      if (nextPending && typeof nextPending === "object") {
        delete nextPending[String(pending.operationID)];
        if (Object.keys(nextPending).length === 0) {
          delete nextRoot.pendingSovTransfersByAllianceID[allianceKey];
        }
      }
      const departure = nextRoot.departuresByOperationID[pending.operationID];
      if (departure) {
        departure.status = "complete";
        departure.awaitingExecutor = false;
        departure.sovereigntyResult = transfer.data || null;
      }
      return nextRoot;
    });
    if (!write.success) {
      return write;
    }
    results.push({
      operationID: pending.operationID,
      data: transfer.data || null,
    });
  }
  return {
    success: true,
    resumed: true,
    resumedCount: results.length,
    data: results,
  };
}

function bindDurableScheduler(scheduler) {
  if (!scheduler || typeof scheduler.schedule !== "function") {
    throw new TypeError("alliance departure scheduler requires schedule");
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

async function handleDurableAllianceDeparture(job = {}) {
  const operationID = String(job.payload && job.payload.operationID || "").trim();
  const expected = buildDepartureJob(operationID);
  if (!expected || job.type !== DURABLE_DEPARTURE_JOB_TYPE ||
      String(job.jobID || "") !== expected.jobID) {
    throw new Error("alliance departure job is stale or invalid");
  }
  const result = await settleAllianceDeparture(operationID, {
    nowMs: Math.max(Date.now(), Number(expected.dueAtMs)),
  });
  if (!result || result.success !== true) {
    throw new Error(result && result.errorMsg || "alliance departure failed");
  }
  return result;
}

async function handleDurableAllianceClosure(job = {}) {
  const closureID = String(job.payload && job.payload.closureID || "").trim();
  const expected = buildClosureJob(closureID);
  const allianceID = normalizePositiveInteger(
    job.payload && job.payload.allianceID,
  );
  if (
    !expected &&
    job.type === DURABLE_CLOSURE_JOB_TYPE &&
    String(job.jobID || "") === `${DURABLE_CLOSURE_JOB_PREFIX}${closureID}` &&
    getSupersedingClosure(closureID, allianceID)
  ) {
    return { success: true, stale: true };
  }
  if (!expected || job.type !== DURABLE_CLOSURE_JOB_TYPE ||
      String(job.jobID || "") !== expected.jobID) {
    throw new Error("alliance closure job is stale or invalid");
  }
  const result = await settleAllianceClosure(closureID, {
    nowMs: Math.max(Date.now(), Number(expected.dueAtMs)),
  });
  if (!result || result.success !== true) {
    throw new Error(result && result.errorMsg || "alliance closure failed");
  }
  return result;
}

async function reconcileDurableAllianceDepartures() {
  const departures = listPendingAllianceDepartures();
  const closures = listPendingAllianceClosures();
  for (let index = 0; index < closures.length; index += 1) {
    const closure = closures[index];
    if (closure.status !== "preparing" && closure.pendingFieldsApplied === true) {
      continue;
    }
    const activation = activatePreparedClosure(closure.closureID);
    if (activation && activation.success === true) {
      closures[index] = activation.data;
      continue;
    }
    log.warn(
      `[AllianceDeparture] closure activation repair failed ` +
      `alliance=${closure.allianceID}: ${activation && activation.errorMsg || "unknown"}`,
    );
  }
  for (const allianceID of Object.keys(
    readRoot().pendingSovTransfersByAllianceID,
  )) {
    const result = resumePendingSovCustody(allianceID);
    if (!result.success) {
      log.warn(
        `[AllianceDeparture] pending sovereignty custody repair failed ` +
        `alliance=${allianceID}: ${result.errorMsg}`,
      );
    }
  }
  if (durableScheduler) {
    await Promise.all([
      ...departures
        .filter((departure) => departure.status !== "awaiting-executor")
        .map((departure) => scheduleJob(buildDepartureJob(departure.operationID))),
      ...closures.map((closure) => scheduleJob(buildClosureJob(closure))),
    ]);
  }
  return {
    scheduledDepartures: departures.filter(
      (departure) => departure.status !== "awaiting-executor",
    ).length,
    scheduledClosures: closures.length,
    scheduled:
      departures.filter((departure) => departure.status !== "awaiting-executor").length +
      closures.length,
  };
}

module.exports = {
  DURABLE_CLOSURE_JOB_TYPE,
  DURABLE_DEPARTURE_JOB_TYPE,
  TABLE_NAME,
  bindDurableScheduler,
  buildClosureJob,
  buildDepartureJob,
  buildDepartureOperationID,
  getAllianceClosure,
  getAllianceDeparture,
  handleDurableAllianceClosure,
  handleDurableAllianceDeparture,
  listPendingAllianceClosures,
  listPendingAllianceDepartures,
  prepareAllianceDeparture,
  prepareAllianceClosure,
  reconcileDurableAllianceDepartures,
  resumePendingSovCustody,
  settleAllianceClosure,
  settleAllianceDeparture,
  unbindDurableScheduler,
};
