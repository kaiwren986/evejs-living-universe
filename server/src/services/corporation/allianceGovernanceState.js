"use strict";

const path = require("node:path");

const database = require(path.join(__dirname, "../../gameStore"));
const {
  currentFileTime,
} = require(path.join(__dirname, "../_shared/serviceHelpers"));
const {
  ALLIANCES_TABLE,
  ensureAlliancesInitialized,
  getAllianceCorporationIDs,
  getAllianceRecord,
} = require(path.join(__dirname, "./corporationState"));
const {
  CORPORATION_RUNTIME_TABLE,
  cloneValue,
  getAllianceRuntime,
  normalizePositiveInteger,
  updateAllianceRecord,
  updateAllianceRuntime,
} = require(path.join(__dirname, "./corporationRuntimeState"));

const GOVERNANCE_STATUS_ACTIVE = "active";
const GOVERNANCE_STATUS_SUSPENDED = "suspended";

function flushGovernanceTable(tableName, errorMsg) {
  const result = database.flushTableSync(tableName);
  return result && result.success === true
    ? { success: true }
    : result || { success: false, errorMsg };
}

function getMemberCorporationIDs(allianceID) {
  return getAllianceCorporationIDs(allianceID)
    .map((corporationID) => normalizePositiveInteger(corporationID, null))
    .filter(Boolean)
    .sort((left, right) => left - right);
}

function validateAllianceMembership(allianceID, corporationID) {
  const numericAllianceID = normalizePositiveInteger(allianceID, null);
  const numericCorporationID = normalizePositiveInteger(corporationID, null);
  if (!numericAllianceID || !numericCorporationID) {
    return false;
  }
  const alliance = getAllianceRecord(numericAllianceID);
  return Boolean(
    alliance &&
      !alliance.deleted &&
      getMemberCorporationIDs(numericAllianceID).includes(numericCorporationID),
  );
}

function getDeclaredExecutorSupport(allianceID, supporterCorporationID) {
  if (!validateAllianceMembership(allianceID, supporterCorporationID)) {
    return null;
  }
  const runtime = getAllianceRuntime(allianceID) || {};
  const candidateCorporationID = normalizePositiveInteger(
    runtime.executorSupportByCorporation &&
      runtime.executorSupportByCorporation[String(supporterCorporationID)],
    null,
  );
  return validateAllianceMembership(allianceID, candidateCorporationID)
    ? candidateCorporationID
    : null;
}

function buildSupportCounts(allianceID, memberCorporationIDs, supportChoices) {
  const memberSet = new Set(memberCorporationIDs);
  const counts = {};
  for (const supporterCorporationID of memberCorporationIDs) {
    const candidateCorporationID = normalizePositiveInteger(
      supportChoices && supportChoices[String(supporterCorporationID)],
      null,
    );
    if (!candidateCorporationID || !memberSet.has(candidateCorporationID)) {
      continue;
    }
    const key = String(candidateCorporationID);
    counts[key] = Number(counts[key] || 0) + 1;
  }
  return counts;
}

function chooseExecutor(
  currentExecutorCorporationID,
  requiredSupport,
  supportCounts,
) {
  const qualifying = Object.entries(supportCounts)
    .map(([corporationID, support]) => ({
      corporationID: Number(corporationID),
      support: Number(support || 0),
    }))
    .filter((entry) => entry.support >= requiredSupport)
    .sort((left, right) => {
      if (right.support !== left.support) {
        return right.support - left.support;
      }
      return left.corporationID - right.corporationID;
    });
  if (qualifying.length === 0) {
    return null;
  }
  if (qualifying.length === 1) {
    return qualifying[0].corporationID;
  }
  const highestSupport = qualifying[0].support;
  const leaders = qualifying.filter((entry) => entry.support === highestSupport);
  if (leaders.length === 1) {
    return leaders[0].corporationID;
  }
  const incumbent = leaders.find(
    (entry) =>
      Number(entry.corporationID) === Number(currentExecutorCorporationID),
  );
  return incumbent ? incumbent.corporationID : null;
}

function buildGovernanceDecision(allianceID, alliance, runtime) {
  const memberCorporationIDs = getMemberCorporationIDs(allianceID);
  const memberSet = new Set(memberCorporationIDs);
  const currentExecutorCorporationID = normalizePositiveInteger(
    alliance && alliance.executorCorporationID,
    null,
  );
  const supportCounts = buildSupportCounts(
    allianceID,
    memberCorporationIDs,
    (runtime && runtime.executorSupportByCorporation) || {},
  );
  const requiredSupport = memberCorporationIDs.length > 0
    ? Math.ceil(memberCorporationIDs.length / 2)
    : 0;
  let winnerCorporationID = null;
  if (
    alliance &&
    alliance.dictatorial &&
    currentExecutorCorporationID &&
    memberSet.has(currentExecutorCorporationID)
  ) {
    winnerCorporationID = currentExecutorCorporationID;
  } else if (requiredSupport > 0) {
    winnerCorporationID = chooseExecutor(
      currentExecutorCorporationID,
      requiredSupport,
      supportCounts,
    );
  }
  return {
    memberCorporationIDs,
    currentExecutorCorporationID,
    supportCounts,
    requiredSupport,
    winnerCorporationID,
    persistedExecutorCorporationID:
      winnerCorporationID ||
      (memberSet.has(currentExecutorCorporationID)
        ? currentExecutorCorporationID
        : null),
  };
}

function recomputeAllianceExecutor(allianceID) {
  const numericAllianceID = normalizePositiveInteger(allianceID, null);
  const alliance = getAllianceRecord(numericAllianceID);
  if (!numericAllianceID || !alliance || alliance.deleted) {
    return { success: false, errorMsg: "ALLIANCE_NOT_FOUND" };
  }
  const runtime = getAllianceRuntime(numericAllianceID) || {};
  const decision = buildGovernanceDecision(
    numericAllianceID,
    alliance,
    runtime,
  );
  const {
    currentExecutorCorporationID,
    memberCorporationIDs,
    persistedExecutorCorporationID,
    requiredSupport,
    supportCounts,
    winnerCorporationID,
  } = decision;
  const recomputedAt = String(currentFileTime());
  const provisionalStatus = {
    status: GOVERNANCE_STATUS_SUSPENDED,
    activeExecutorCorporationID: null,
    displayedExecutorCorporationID: currentExecutorCorporationID,
    requiredSupport,
    memberCorporationCount: memberCorporationIDs.length,
    supportCounts,
    lastRecomputedAt: recomputedAt,
    recomputePending: true,
    pendingExecutorCorporationID: persistedExecutorCorporationID,
  };
  const provisionalWrite = updateAllianceRuntime(
    numericAllianceID,
    (nextRuntime) => {
      nextRuntime.executorGovernance = cloneValue(provisionalStatus);
      return nextRuntime;
    },
  );
  if (!provisionalWrite || provisionalWrite.success !== true) {
    return provisionalWrite || {
      success: false,
      errorMsg: "ALLIANCE_GOVERNANCE_WRITE_FAILED",
    };
  }
  const provisionalFlush = flushGovernanceTable(
    CORPORATION_RUNTIME_TABLE,
    "ALLIANCE_GOVERNANCE_FLUSH_FAILED",
  );
  if (!provisionalFlush.success) {
    return provisionalFlush;
  }
  if (
    Number(persistedExecutorCorporationID || 0) !==
    Number(currentExecutorCorporationID || 0)
  ) {
    const allianceWrite = updateAllianceRecord(numericAllianceID, {
      executorCorporationID: persistedExecutorCorporationID,
    });
    if (!allianceWrite || allianceWrite.success !== true) {
      return allianceWrite || {
        success: false,
        errorMsg: "ALLIANCE_EXECUTOR_WRITE_FAILED",
      };
    }
  }
  const allianceFlush = flushGovernanceTable(
    ALLIANCES_TABLE,
    "ALLIANCE_EXECUTOR_FLUSH_FAILED",
  );
  if (!allianceFlush.success) {
    return allianceFlush;
  }

  const displayedExecutorCorporationID = persistedExecutorCorporationID;
  const status = {
    status: winnerCorporationID
      ? GOVERNANCE_STATUS_ACTIVE
      : GOVERNANCE_STATUS_SUSPENDED,
    activeExecutorCorporationID: winnerCorporationID || null,
    displayedExecutorCorporationID,
    requiredSupport,
    memberCorporationCount: memberCorporationIDs.length,
    supportCounts,
    lastRecomputedAt: recomputedAt,
    recomputePending: false,
    pendingExecutorCorporationID: null,
  };
  const runtimeWrite = updateAllianceRuntime(numericAllianceID, (nextRuntime) => {
    nextRuntime.executorGovernance = cloneValue(status);
    return nextRuntime;
  });
  if (!runtimeWrite || runtimeWrite.success !== true) {
    return runtimeWrite || {
      success: false,
      errorMsg: "ALLIANCE_GOVERNANCE_WRITE_FAILED",
    };
  }
  const finalFlush = flushGovernanceTable(
    CORPORATION_RUNTIME_TABLE,
    "ALLIANCE_GOVERNANCE_FLUSH_FAILED",
  );
  if (!finalFlush.success) {
    updateAllianceRuntime(numericAllianceID, (nextRuntime) => {
      nextRuntime.executorGovernance = cloneValue(provisionalStatus);
      return nextRuntime;
    });
    return finalFlush;
  }
  return {
    success: true,
    data: {
      ...status,
      executorChanged:
        Number(persistedExecutorCorporationID || 0) !==
        Number(currentExecutorCorporationID || 0),
      previousExecutorCorporationID: currentExecutorCorporationID,
    },
  };
}

function declareExecutorSupport(
  allianceID,
  supporterCorporationID,
  candidateCorporationID,
) {
  const numericAllianceID = normalizePositiveInteger(allianceID, null);
  const numericSupporterCorporationID = normalizePositiveInteger(
    supporterCorporationID,
    null,
  );
  const numericCandidateCorporationID = normalizePositiveInteger(
    candidateCorporationID,
    null,
  );
  const alliance = getAllianceRecord(numericAllianceID);
  if (
    !alliance ||
    alliance.deleted ||
    !validateAllianceMembership(
      numericAllianceID,
      numericSupporterCorporationID,
    ) ||
    !validateAllianceMembership(
      numericAllianceID,
      numericCandidateCorporationID,
    )
  ) {
    return { success: false, errorMsg: "INVALID_EXECUTOR_SUPPORT" };
  }
  if (
    alliance.dictatorial &&
    Number(numericCandidateCorporationID) !==
      Number(alliance.executorCorporationID)
  ) {
    return { success: false, errorMsg: "DICTATORIAL_ALLIANCE" };
  }
  const supportWrite = updateAllianceRuntime(numericAllianceID, (runtime) => {
    runtime.executorSupportByCorporation =
      runtime.executorSupportByCorporation &&
      typeof runtime.executorSupportByCorporation === "object"
        ? runtime.executorSupportByCorporation
        : {};
    runtime.executorSupportByCorporation[
      String(numericSupporterCorporationID)
    ] = numericCandidateCorporationID;
    runtime.executorGovernance = {
      ...(runtime.executorGovernance &&
      typeof runtime.executorGovernance === "object"
        ? runtime.executorGovernance
        : {}),
      status: GOVERNANCE_STATUS_SUSPENDED,
      activeExecutorCorporationID: null,
      lastRecomputedAt: String(currentFileTime()),
      recomputePending: true,
    };
    return runtime;
  });
  if (!supportWrite || supportWrite.success !== true) {
    return supportWrite || {
      success: false,
      errorMsg: "EXECUTOR_SUPPORT_WRITE_FAILED",
    };
  }
  const supportFlush = flushGovernanceTable(
    CORPORATION_RUNTIME_TABLE,
    "EXECUTOR_SUPPORT_FLUSH_FAILED",
  );
  if (!supportFlush.success) {
    return supportFlush;
  }
  const recomputed = recomputeAllianceExecutor(numericAllianceID);
  if (!recomputed || recomputed.success !== true) {
    return recomputed;
  }
  return {
    success: true,
    data: {
      ...recomputed.data,
      allianceID: numericAllianceID,
      supporterCorporationID: numericSupporterCorporationID,
      candidateCorporationID: numericCandidateCorporationID,
    },
  };
}

function cleanupAllianceGovernanceForDeparture(
  allianceID,
  departingCorporationID,
) {
  const numericAllianceID = normalizePositiveInteger(allianceID, null);
  const numericDepartingCorporationID = normalizePositiveInteger(
    departingCorporationID,
    null,
  );
  if (!numericAllianceID || !numericDepartingCorporationID) {
    return { success: false, errorMsg: "INVALID_ALLIANCE_MEMBER" };
  }
  const cleanupWrite = updateAllianceRuntime(numericAllianceID, (runtime) => {
    const supportChoices =
      runtime.executorSupportByCorporation &&
      typeof runtime.executorSupportByCorporation === "object"
        ? runtime.executorSupportByCorporation
        : {};
    delete supportChoices[String(numericDepartingCorporationID)];
    for (const [supporterCorporationID, candidateCorporationID] of
      Object.entries(supportChoices)) {
      if (
        Number(candidateCorporationID) === Number(numericDepartingCorporationID)
      ) {
        supportChoices[supporterCorporationID] = null;
      }
    }
    runtime.executorSupportByCorporation = supportChoices;
    runtime.executorGovernance = {
      ...(runtime.executorGovernance &&
      typeof runtime.executorGovernance === "object"
        ? runtime.executorGovernance
        : {}),
      status: GOVERNANCE_STATUS_SUSPENDED,
      activeExecutorCorporationID: null,
      lastRecomputedAt: String(currentFileTime()),
      recomputePending: true,
    };
    return runtime;
  });
  if (!cleanupWrite || cleanupWrite.success !== true) {
    return cleanupWrite || {
      success: false,
      errorMsg: "ALLIANCE_GOVERNANCE_CLEANUP_FAILED",
    };
  }
  const cleanupFlush = flushGovernanceTable(
    CORPORATION_RUNTIME_TABLE,
    "ALLIANCE_GOVERNANCE_CLEANUP_FLUSH_FAILED",
  );
  if (!cleanupFlush.success) {
    return cleanupFlush;
  }
  return recomputeAllianceExecutor(numericAllianceID);
}

function getAllianceExecutorStatus(allianceID) {
  const numericAllianceID = normalizePositiveInteger(allianceID, null);
  const alliance = getAllianceRecord(numericAllianceID);
  if (!numericAllianceID || !alliance || alliance.deleted) {
    return null;
  }
  const runtime = getAllianceRuntime(numericAllianceID) || {};
  const persisted = runtime.executorGovernance;
  if (persisted && typeof persisted === "object") {
    const decision = buildGovernanceDecision(
      numericAllianceID,
      alliance,
      runtime,
    );
    const activeExecutorCorporationID = normalizePositiveInteger(
      persisted.activeExecutorCorporationID,
      null,
    );
    const active =
      persisted.recomputePending !== true &&
      persisted.status === GOVERNANCE_STATUS_ACTIVE &&
      Number(activeExecutorCorporationID || 0) ===
        Number(decision.winnerCorporationID || 0) &&
      Number(activeExecutorCorporationID || 0) ===
        Number(alliance.executorCorporationID || 0) &&
      validateAllianceMembership(numericAllianceID, activeExecutorCorporationID);
    return {
      ...cloneValue(persisted),
      status: active
        ? GOVERNANCE_STATUS_ACTIVE
        : GOVERNANCE_STATUS_SUSPENDED,
      activeExecutorCorporationID: active
        ? activeExecutorCorporationID
        : null,
    };
  }

  // Existing persisted alliances predate the governance checkpoint. Preserve
  // their executor until the first support or membership transition creates a
  // canonical support result; this is a migration bridge, not a vote result.
  const legacyExecutorCorporationID = normalizePositiveInteger(
    alliance.executorCorporationID,
    null,
  );
  const legacyActive = validateAllianceMembership(
    numericAllianceID,
    legacyExecutorCorporationID,
  );
  return {
    status: legacyActive
      ? GOVERNANCE_STATUS_ACTIVE
      : GOVERNANCE_STATUS_SUSPENDED,
    activeExecutorCorporationID: legacyActive
      ? legacyExecutorCorporationID
      : null,
    displayedExecutorCorporationID: legacyExecutorCorporationID,
    requiredSupport: Math.ceil(getMemberCorporationIDs(numericAllianceID).length / 2),
    memberCorporationCount: getMemberCorporationIDs(numericAllianceID).length,
    supportCounts: {},
    lastRecomputedAt: null,
    legacyFallback: true,
  };
}

function needsGovernanceReconciliation(allianceID, alliance, runtime) {
  const persisted = runtime && runtime.executorGovernance;
  if (!persisted || typeof persisted !== "object") {
    return false;
  }
  const decision = buildGovernanceDecision(allianceID, alliance, runtime);
  const expectedStatus = decision.winnerCorporationID
    ? GOVERNANCE_STATUS_ACTIVE
    : GOVERNANCE_STATUS_SUSPENDED;
  const persistedActiveExecutorCorporationID = normalizePositiveInteger(
    persisted.activeExecutorCorporationID,
    null,
  );
  return Boolean(
    persisted.recomputePending === true ||
      persisted.status !== expectedStatus ||
      Number(persistedActiveExecutorCorporationID || 0) !==
        Number(decision.winnerCorporationID || 0) ||
      Number(alliance.executorCorporationID || 0) !==
        Number(decision.persistedExecutorCorporationID || 0)
  );
}

function reconcileAllianceGovernance() {
  const allianceTable = ensureAlliancesInitialized();
  const results = [];
  for (const alliance of Object.values(allianceTable.records || {})) {
    const allianceID = normalizePositiveInteger(
      alliance && alliance.allianceID,
      null,
    );
    if (!allianceID || alliance.deleted) {
      continue;
    }
    const runtime = getAllianceRuntime(allianceID) || {};
    if (!needsGovernanceReconciliation(allianceID, alliance, runtime)) {
      continue;
    }
    const result = recomputeAllianceExecutor(allianceID);
    results.push({ allianceID, ...result });
  }
  const failed = results.filter((result) => result.success !== true).length;
  return {
    success: failed === 0,
    reconciled: results.length - failed,
    failed,
    results,
  };
}

function getActiveExecutorCorporationID(allianceID) {
  const status = getAllianceExecutorStatus(allianceID);
  return status && status.status === GOVERNANCE_STATUS_ACTIVE
    ? normalizePositiveInteger(status.activeExecutorCorporationID, null)
    : null;
}

module.exports = {
  GOVERNANCE_STATUS_ACTIVE,
  GOVERNANCE_STATUS_SUSPENDED,
  cleanupAllianceGovernanceForDeparture,
  declareExecutorSupport,
  getActiveExecutorCorporationID,
  getAllianceExecutorStatus,
  getDeclaredExecutorSupport,
  reconcileAllianceGovernance,
  recomputeAllianceExecutor,
  validateAllianceMembership,
};
