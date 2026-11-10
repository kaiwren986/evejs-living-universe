"use strict";

const path = require("node:path");

const database = require(path.join(__dirname, "../../gameStore"));
const {
  getAllianceRecord,
  getCorporationRecord,
  setCorporationAlliance,
} = require(path.join(__dirname, "./corporationState"));
const {
  recordAllianceMemberJoin,
} = require(path.join(__dirname, "./allianceViewState"));
const {
  recomputeAllianceExecutor,
} = require(path.join(__dirname, "./allianceGovernanceState"));
const {
  updateAllianceRuntime,
} = require(path.join(__dirname, "./corporationRuntimeState"));
const {
  handleCorporationJoinedAlliance,
} = require(path.join(__dirname, "./warRuntimeState"));
const {
  buildAllianceApplicationSnapshot,
  buildAllianceMemberSnapshot,
  buildAllianceSummary,
  buildCorporationSnapshot,
  notifyAllianceApplicationChanged,
  notifyAllianceChanged,
  notifyAllianceMemberChanged,
  notifyCorporationChanged,
} = require(path.join(__dirname, "./corporationNotifications"));
const {
  ALLIANCE_APPLICATION_STATE,
  cancelAcceptedAllianceApplication,
  deferAcceptedAllianceApplication,
  markAllianceApplicationEffective,
  resolveDurableEffectiveApplication,
  scheduleEffectiveApplication,
} = require(path.join(__dirname, "./allianceApplicationState"));
const {
  checkAllianceApplicationEligibility,
} = require(path.join(__dirname, "./allianceApplicationEligibility"));

const EFFECTIVE_RECHECK_DELAY_MS = 60 * 60 * 1000;
const DURABLE_BIGINT_MARKER = "__evejsDurableBigInt";
const effectiveLanes = new Map();

function encodeDurableSnapshot(value) {
  if (value === undefined || value === null) {
    return value;
  }
  return JSON.parse(JSON.stringify(value, (_key, candidate) =>
    typeof candidate === "bigint"
      ? { [DURABLE_BIGINT_MARKER]: candidate.toString() }
      : candidate));
}

function decodeDurableSnapshot(value) {
  if (value === undefined || value === null) {
    return value;
  }
  return JSON.parse(JSON.stringify(value), (_key, candidate) => {
    if (
      candidate &&
      typeof candidate === "object" &&
      Object.keys(candidate).length === 1 &&
      typeof candidate[DURABLE_BIGINT_MARKER] === "string"
    ) {
      return BigInt(candidate[DURABLE_BIGINT_MARKER]);
    }
    return candidate;
  });
}

function captureEffectiveNotificationBefore(application) {
  return encodeDurableSnapshot({
    application: buildAllianceApplicationSnapshot(
      application.allianceID,
      application.corporationID,
    ),
    allianceMember: buildAllianceMemberSnapshot(
      application.allianceID,
      application.corporationID,
    ),
    alliance: buildAllianceSummary(application.allianceID),
    corporation: buildCorporationSnapshot(application.corporationID),
  });
}

function runSerialized(corporationID, operation) {
  const laneKey = String(corporationID);
  const previous = effectiveLanes.get(laneKey) || Promise.resolve();
  const current = previous.catch(() => null).then(operation);
  effectiveLanes.set(laneKey, current);
  void current.finally(() => {
    if (effectiveLanes.get(laneKey) === current) {
      effectiveLanes.delete(laneKey);
    }
  }).catch(() => null);
  return current;
}

function flushAffiliationTables() {
  const result = database.flushTablesSync([
    "alliances",
    "corporations",
    "characters",
  ]);
  return result && result.success === true
    ? { success: true }
    : result || { success: false, errorMsg: "ALLIANCE_AFFILIATION_FLUSH_FAILED" };
}

function flushAllianceRuntime() {
  const result = database.flushTableSync("corporationRuntime");
  return result && result.success === true
    ? { success: true }
    : result || { success: false, errorMsg: "ALLIANCE_RUNTIME_FLUSH_FAILED" };
}

function updateEffectiveCheckpoint(application, changes = {}) {
  let updated = null;
  const writeResult = updateAllianceRuntime(application.allianceID, (runtime) => {
    const current = runtime.applications &&
      runtime.applications[String(application.corporationID)];
    if (!current || current.applicationID !== application.applicationID) {
      return runtime;
    }
    updated = { ...current, ...changes };
    runtime.applications[String(application.corporationID)] = updated;
    return runtime;
  });
  if (!writeResult || writeResult.success !== true || !updated) {
    return writeResult && writeResult.success !== true
      ? writeResult
      : { success: false, errorMsg: "APPLICATION_CHECKPOINT_FAILED" };
  }
  const flushResult = flushAllianceRuntime();
  return flushResult.success
    ? { success: true, data: updated }
    : flushResult;
}

function rejectTerminalApplication(application, reason) {
  const previous = buildAllianceApplicationSnapshot(
    application.allianceID,
    application.corporationID,
  );
  const result = cancelAcceptedAllianceApplication({
    allianceID: application.allianceID,
    corporationID: application.corporationID,
    applicationID: application.applicationID,
    reason,
  });
  if (result && result.success) {
    notifyAllianceApplicationChanged(
      application.allianceID,
      application.corporationID,
      previous,
    );
  }
  return result;
}

async function suspendWarBlockedApplication(application, reason) {
  const deferred = deferAcceptedAllianceApplication({
    allianceID: application.allianceID,
    corporationID: application.corporationID,
    applicationID: application.applicationID,
    delayMs: EFFECTIVE_RECHECK_DELAY_MS,
    reason,
  });
  if (!deferred || deferred.success !== true) {
    return deferred || { success: false, errorMsg: "APPLICATION_DEFER_FAILED" };
  }
  await scheduleEffectiveApplication(deferred.data);
  return { success: true, suspended: true, data: deferred.data };
}

async function settleEffectiveApplication(job, options = {}) {
  const resolution = resolveDurableEffectiveApplication(job, options);
  if (!resolution || resolution.success !== true) {
    return resolution || { success: false, errorMsg: "APPLICATION_RESOLVE_FAILED" };
  }
  if (resolution.stale) {
    if (
      resolution.data &&
      resolution.data.state === ALLIANCE_APPLICATION_STATE.ACCEPTED
    ) {
      await scheduleEffectiveApplication(resolution.data);
    }
    return { success: true, stale: true };
  }

  const application = resolution.data;
  if (!application) {
    return { success: true, stale: true };
  }
  const alliance = getAllianceRecord(application.allianceID);
  const corporation = getCorporationRecord(application.corporationID);
  if (!alliance || alliance.deleted || !corporation || corporation.deleted) {
    const rejected = rejectTerminalApplication(application, "OWNER_DELETED");
    return rejected && rejected.success
      ? { success: true, rejected: true }
      : rejected;
  }
  if (alliance.closurePendingAtMs) {
    const rejected = rejectTerminalApplication(application, "ALLIANCE_CLOSING");
    return rejected && rejected.success
      ? { success: true, rejected: true }
      : rejected;
  }

  const currentAllianceID = Number(corporation.allianceID || 0) || null;
  if (currentAllianceID && currentAllianceID !== application.allianceID) {
    const rejected = rejectTerminalApplication(application, "JOINED_OTHER_ALLIANCE");
    return rejected && rejected.success
      ? { success: true, rejected: true }
      : rejected;
  }

  if (!currentAllianceID) {
    const eligibility = checkAllianceApplicationEligibility(
      application.corporationID,
      application.allianceID,
    );
    if (!eligibility || eligibility.success !== true) {
      if (
        eligibility && [
          "MUTUAL_WAR",
          "AGGRESSOR_WAR",
          "FOREIGN_ALLY_WAR",
        ].includes(eligibility.errorMsg)
      ) {
        return suspendWarBlockedApplication(
          application,
          eligibility.errorMsg,
        );
      }
      const rejected = rejectTerminalApplication(
        application,
        eligibility && eligibility.errorMsg || "NO_LONGER_ELIGIBLE",
      );
      return rejected && rejected.success
        ? { success: true, rejected: true }
        : rejected;
    }
  }

  let effectiveApplication = application;
  if (!effectiveApplication.notificationBefore) {
    // Persist the exact old wire snapshots before affiliation changes any owner
    // state. A retry after a crash must not rebuild these from the already-
    // Effective records or it will emit empty change dictionaries.
    const checkpoint = updateEffectiveCheckpoint(effectiveApplication, {
      notificationBefore: captureEffectiveNotificationBefore(application),
      notificationBeforeCapturedAtMs: Number(options.nowMs || Date.now()),
    });
    if (!checkpoint.success) {
      return checkpoint;
    }
    effectiveApplication = checkpoint.data;
  }
  const notificationBefore = decodeDurableSnapshot(
    effectiveApplication.notificationBefore,
  ) || {};

  // Re-run the idempotent affiliation write even when the corporation record
  // already points at the target. A prior attempt can fail after writing the
  // alliance/corporation rows but before updating every character; retry must
  // repair that partial state before the application becomes Effective.
  const affiliation = setCorporationAlliance(
    application.corporationID,
    application.allianceID,
  );
  if (!affiliation || affiliation.success !== true) {
    return affiliation || { success: false, errorMsg: "AFFILIATION_FAILED" };
  }
  const affiliationFlush = flushAffiliationTables();
  if (!affiliationFlush.success) {
    return affiliationFlush;
  }

  if (application.state !== ALLIANCE_APPLICATION_STATE.EFFECTIVE) {
    const marked = markAllianceApplicationEffective({
      allianceID: application.allianceID,
      corporationID: application.corporationID,
      applicationID: application.applicationID,
      force: true,
      nowMs: options.nowMs,
    });
    if (!marked || marked.success !== true) {
      return marked || { success: false, errorMsg: "APPLICATION_MARK_FAILED" };
    }
    effectiveApplication = marked.data;
  }
  const membershipWrite = recordAllianceMemberJoin(
    application.allianceID,
    application.corporationID,
    effectiveApplication.effectiveDateTime || application.applicationDateTime,
  );
  if (!membershipWrite || membershipWrite.success !== true) {
    return membershipWrite || {
      success: false,
      errorMsg: "ALLIANCE_MEMBER_HISTORY_WRITE_FAILED",
    };
  }
  const governanceWrite = recomputeAllianceExecutor(application.allianceID);
  if (!governanceWrite || governanceWrite.success !== true) {
    return governanceWrite || {
      success: false,
      errorMsg: "ALLIANCE_GOVERNANCE_WRITE_FAILED",
    };
  }
  const runtimeFlush = flushAllianceRuntime();
  if (!runtimeFlush.success) {
    return runtimeFlush;
  }

  if (!effectiveApplication.warSideEffectsComplete) {
    handleCorporationJoinedAlliance({
      corporationID: application.corporationID,
      allianceID: application.allianceID,
    });
    const checkpoint = updateEffectiveCheckpoint(effectiveApplication, {
      warSideEffectsComplete: true,
      warSideEffectsCompletedAtMs: Number(options.nowMs || Date.now()),
    });
    if (!checkpoint.success) {
      return checkpoint;
    }
    effectiveApplication = checkpoint.data;
  }
  if (!effectiveApplication.notificationsComplete) {
    notifyAllianceApplicationChanged(
      application.allianceID,
      application.corporationID,
      notificationBefore.application || null,
    );
    notifyAllianceMemberChanged(
      application.allianceID,
      application.corporationID,
      notificationBefore.allianceMember || null,
    );
    notifyAllianceChanged(
      application.allianceID,
      notificationBefore.alliance || null,
    );
    notifyCorporationChanged(
      application.corporationID,
      notificationBefore.corporation || null,
    );
    const checkpoint = updateEffectiveCheckpoint(effectiveApplication, {
      notificationsComplete: true,
      notificationsCompletedAtMs: Number(options.nowMs || Date.now()),
    });
    if (!checkpoint.success) {
      return checkpoint;
    }
    effectiveApplication = checkpoint.data;
  }
  return { success: true, data: effectiveApplication };
}

function handleDurableAllianceApplicationEffective(job = {}, options = {}) {
  const corporationID = Number(job && job.payload && job.payload.corporationID);
  if (!Number.isSafeInteger(corporationID) || corporationID <= 0) {
    return Promise.reject(new Error("alliance application job is invalid"));
  }
  return runSerialized(corporationID, async () => {
    const result = await settleEffectiveApplication(job, options);
    if (!result || result.success !== true) {
      throw new Error(result && result.errorMsg ||
        "alliance application effective transition failed");
    }
    return result;
  });
}

module.exports = {
  EFFECTIVE_RECHECK_DELAY_MS,
  handleDurableAllianceApplicationEffective,
  settleEffectiveApplication,
  _testing: {
    decodeDurableSnapshot,
    encodeDurableSnapshot,
    resetEffectiveLanes() {
      effectiveLanes.clear();
    },
  },
};
