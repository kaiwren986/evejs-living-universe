"use strict";

const crypto = require("node:crypto");
const path = require("path");

const database = require(path.join(__dirname, "../../gameStore"));
const log = require(path.join(__dirname, "../../utils/logger"));
const {
  getCorporationRecord,
} = require(path.join(__dirname, "./corporationState"));
const {
  cloneValue,
  ensureRuntimeInitialized,
  normalizeFiletimeString,
  normalizePositiveInteger,
  normalizeText,
  updateRuntimeState,
} = require(path.join(__dirname, "./corporationRuntimeState"));

const ALLIANCE_APPLICATION_STATE = Object.freeze({
  NEW: 1,
  ACCEPTED: 2,
  EFFECTIVE: 3,
  REJECTED: 4,
});
const ALLIANCE_APPLICATION_SCHEMA_VERSION = 1;
const ALLIANCE_APPLICATION_EFFECTIVE_DELAY_MS = 24 * 60 * 60 * 1000;
const ALLIANCE_APPLICATION_TEXT_MAX_LENGTH = 1000;
const DURABLE_EFFECTIVE_JOB_TYPE = "alliance.application.effective";
const DURABLE_EFFECTIVE_JOB_PREFIX = "alliance-application-effective:";
const FILETIME_EPOCH_OFFSET = 116444736000000000n;
const FILETIME_TICKS_PER_MS = 10000n;

const STATE_PRECEDENCE = new Map([
  [ALLIANCE_APPLICATION_STATE.NEW, 1],
  [ALLIANCE_APPLICATION_STATE.ACCEPTED, 2],
  [ALLIANCE_APPLICATION_STATE.REJECTED, 3],
  [ALLIANCE_APPLICATION_STATE.EFFECTIVE, 4],
]);

let durableScheduler = null;

function normalizeNowMs(value = Date.now()) {
  const numeric = Math.trunc(Number(value));
  return Number.isSafeInteger(numeric) && numeric >= 0 ? numeric : Date.now();
}

function normalizeOptionalMs(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  const numeric = Math.trunc(Number(value));
  return Number.isSafeInteger(numeric) && numeric >= 0 ? numeric : null;
}

function filetimeFromUnixMs(value) {
  const nowMs = normalizeNowMs(value);
  return String(BigInt(nowMs) * FILETIME_TICKS_PER_MS + FILETIME_EPOCH_OFFSET);
}

function unixMsFromFiletime(value, fallback = null) {
  try {
    const filetime = BigInt(String(value || "0"));
    if (filetime <= FILETIME_EPOCH_OFFSET) {
      return fallback;
    }
    const unixMs = Number(
      (filetime - FILETIME_EPOCH_OFFSET) / FILETIME_TICKS_PER_MS,
    );
    return Number.isSafeInteger(unixMs) && unixMs >= 0 ? unixMs : fallback;
  } catch (error) {
    return fallback;
  }
}

function normalizeState(value, fallback = ALLIANCE_APPLICATION_STATE.NEW) {
  const numeric = Math.trunc(Number(value));
  return STATE_PRECEDENCE.has(numeric) ? numeric : fallback;
}

function buildApplicationKey(allianceID, corporationID) {
  return `${Number(allianceID)}:${Number(corporationID)}`;
}

function buildLegacyApplicationID(application, allianceID, corporationID) {
  const fingerprint = [
    Number(allianceID),
    Number(corporationID),
    normalizeFiletimeString(application && application.applicationDateTime, "0"),
    normalizeText(application && application.applicationText, ""),
  ].join(":");
  return `legacy-${crypto.createHash("sha256").update(fingerprint).digest("hex").slice(0, 32)}`;
}

function normalizeApplicationID(value, fallback = "") {
  const normalized = String(value || "").trim();
  return normalized && normalized.length <= 128 ? normalized : fallback;
}

function buildEffectiveJobID(applicationID) {
  const normalizedApplicationID = normalizeApplicationID(applicationID);
  return normalizedApplicationID
    ? `${DURABLE_EFFECTIVE_JOB_PREFIX}${normalizedApplicationID}`
    : null;
}

function normalizeApplicationRecord(
  application,
  allianceID,
  corporationID,
  options = {},
) {
  const nowMs = normalizeNowMs(options.nowMs);
  const numericAllianceID = normalizePositiveInteger(allianceID, null);
  const numericCorporationID = normalizePositiveInteger(corporationID, null);
  if (!numericAllianceID || !numericCorporationID) {
    return null;
  }

  const source = application && typeof application === "object"
    ? cloneValue(application)
    : {};
  let state = normalizeState(source.state);
  let acceptedAtMs = normalizeOptionalMs(source.acceptedAtMs);
  let effectiveAtMs = normalizeOptionalMs(source.effectiveAtMs);
  let becameEffectiveAtMs = normalizeOptionalMs(source.becameEffectiveAtMs);
  const applicationDateTime = normalizeFiletimeString(
    source.applicationDateTime,
    filetimeFromUnixMs(nowMs),
  );
  const createdAtMs = normalizeOptionalMs(source.createdAtMs) ??
    unixMsFromFiletime(applicationDateTime, nowMs);

  if (options.legacy === true && state === ALLIANCE_APPLICATION_STATE.ACCEPTED) {
    const corporation = getCorporationRecord(numericCorporationID);
    if (
      corporation &&
      Number(corporation.allianceID || 0) === numericAllianceID
    ) {
      state = ALLIANCE_APPLICATION_STATE.EFFECTIVE;
      becameEffectiveAtMs = becameEffectiveAtMs ?? nowMs;
      effectiveAtMs = effectiveAtMs ?? becameEffectiveAtMs;
    }
  }

  if (state === ALLIANCE_APPLICATION_STATE.ACCEPTED) {
    acceptedAtMs = acceptedAtMs ?? nowMs;
    effectiveAtMs = effectiveAtMs ??
      acceptedAtMs + ALLIANCE_APPLICATION_EFFECTIVE_DELAY_MS;
  } else if (state === ALLIANCE_APPLICATION_STATE.EFFECTIVE) {
    becameEffectiveAtMs = becameEffectiveAtMs ?? effectiveAtMs ?? nowMs;
    effectiveAtMs = effectiveAtMs ?? becameEffectiveAtMs;
  }

  const fallbackApplicationID = buildLegacyApplicationID(
    source,
    numericAllianceID,
    numericCorporationID,
  );
  const applicationID = normalizeApplicationID(
    source.applicationID,
    fallbackApplicationID,
  );
  const effectiveJobID = state === ALLIANCE_APPLICATION_STATE.ACCEPTED
    ? normalizeApplicationID(
        source.effectiveJobID,
        buildEffectiveJobID(applicationID),
      )
    : normalizeApplicationID(source.effectiveJobID, "") || null;

  return {
    ...source,
    schemaVersion: ALLIANCE_APPLICATION_SCHEMA_VERSION,
    applicationID,
    allianceID: numericAllianceID,
    corporationID: numericCorporationID,
    applicationText: normalizeText(source.applicationText, "").slice(
      0,
      ALLIANCE_APPLICATION_TEXT_MAX_LENGTH,
    ),
    state,
    applicationDateTime,
    createdAtMs,
    updatedAtMs: normalizeOptionalMs(source.updatedAtMs) ?? createdAtMs,
    acceptedAtMs,
    effectiveAtMs,
    becameEffectiveAtMs,
    effectiveJobID,
  };
}

function chooseMigratedApplication(existing, candidate) {
  if (!existing) {
    return candidate;
  }
  if (!candidate) {
    return existing;
  }
  const existingScore = STATE_PRECEDENCE.get(existing.state) || 0;
  const candidateScore = STATE_PRECEDENCE.get(candidate.state) || 0;
  if (candidateScore !== existingScore) {
    return candidateScore > existingScore ? candidate : existing;
  }
  const existingUpdatedAt = normalizeOptionalMs(existing.updatedAtMs) || 0;
  const candidateUpdatedAt = normalizeOptionalMs(candidate.updatedAtMs) || 0;
  return candidateUpdatedAt > existingUpdatedAt ? candidate : existing;
}

function flushCanonicalState() {
  const result = database.flushTablesSync(["corporationRuntime"]);
  return result && result.success === true
    ? { success: true }
    : result || { success: false, errorMsg: "ALLIANCE_APPLICATION_FLUSH_FAILED" };
}

function ensureCanonicalApplicationsMigrated(options = {}) {
  const nowMs = normalizeNowMs(options.nowMs);
  const current = ensureRuntimeInitialized();
  const currentVersion = Math.trunc(Number(
    current && current._meta && current._meta.allianceApplicationSchemaVersion,
  ) || 0);
  if (currentVersion >= ALLIANCE_APPLICATION_SCHEMA_VERSION) {
    return {
      success: true,
      migrated: false,
      data: { imported: 0, normalized: 0, discarded: 0 },
    };
  }

  const summary = { imported: 0, normalized: 0, discarded: 0 };
  const writeResult = updateRuntimeState((runtimeTable) => {
    runtimeTable._meta = runtimeTable._meta && typeof runtimeTable._meta === "object"
      ? runtimeTable._meta
      : {};
    runtimeTable.alliances = runtimeTable.alliances &&
      typeof runtimeTable.alliances === "object"
      ? runtimeTable.alliances
      : {};
    runtimeTable.corporations = runtimeTable.corporations &&
      typeof runtimeTable.corporations === "object"
      ? runtimeTable.corporations
      : {};

    for (const [allianceKey, allianceRuntime] of Object.entries(
      runtimeTable.alliances,
    )) {
      const allianceID = normalizePositiveInteger(allianceKey, null);
      if (!allianceID || !allianceRuntime || typeof allianceRuntime !== "object") {
        continue;
      }
      allianceRuntime.applications = allianceRuntime.applications &&
        typeof allianceRuntime.applications === "object"
        ? allianceRuntime.applications
        : {};
      for (const [corporationKey, rawApplication] of Object.entries(
        allianceRuntime.applications,
      )) {
        const corporationID = normalizePositiveInteger(corporationKey, null);
        const normalized = normalizeApplicationRecord(
          rawApplication,
          allianceID,
          corporationID,
          { legacy: true, nowMs },
        );
        if (!normalized) {
          delete allianceRuntime.applications[corporationKey];
          summary.discarded += 1;
          continue;
        }
        allianceRuntime.applications[String(corporationID)] = normalized;
        if (String(corporationID) !== corporationKey) {
          delete allianceRuntime.applications[corporationKey];
        }
        summary.normalized += 1;
      }
    }

    for (const [corporationKey, corporationRuntime] of Object.entries(
      runtimeTable.corporations,
    )) {
      if (!corporationRuntime || typeof corporationRuntime !== "object") {
        continue;
      }
      const corporationID = normalizePositiveInteger(corporationKey, null);
      const legacyApplications = corporationRuntime.allianceApplications &&
        typeof corporationRuntime.allianceApplications === "object"
        ? corporationRuntime.allianceApplications
        : {};
      for (const [allianceKey, rawApplication] of Object.entries(
        legacyApplications,
      )) {
        const allianceID = normalizePositiveInteger(allianceKey, null);
        const allianceRuntime = allianceID
          ? runtimeTable.alliances[String(allianceID)]
          : null;
        if (!corporationID || !allianceRuntime) {
          summary.discarded += 1;
          continue;
        }
        allianceRuntime.applications = allianceRuntime.applications &&
          typeof allianceRuntime.applications === "object"
          ? allianceRuntime.applications
          : {};
        const candidate = normalizeApplicationRecord(
          rawApplication,
          allianceID,
          corporationID,
          { legacy: true, nowMs },
        );
        if (!candidate) {
          summary.discarded += 1;
          continue;
        }
        const applicationKey = String(corporationID);
        const existing = allianceRuntime.applications[applicationKey]
          ? normalizeApplicationRecord(
              allianceRuntime.applications[applicationKey],
              allianceID,
              corporationID,
              { legacy: true, nowMs },
            )
          : null;
        allianceRuntime.applications[applicationKey] =
          chooseMigratedApplication(existing, candidate);
        summary.imported += 1;
      }
      corporationRuntime.allianceApplications = {};
    }

    runtimeTable._meta.allianceApplicationSchemaVersion =
      ALLIANCE_APPLICATION_SCHEMA_VERSION;
    return runtimeTable;
  });
  if (!writeResult || writeResult.success !== true) {
    return writeResult || {
      success: false,
      errorMsg: "ALLIANCE_APPLICATION_MIGRATION_FAILED",
    };
  }
  const flushResult = flushCanonicalState();
  if (!flushResult.success) {
    return flushResult;
  }
  return { success: true, migrated: true, data: summary };
}

function getCanonicalTable(options = {}) {
  const migration = ensureCanonicalApplicationsMigrated(options);
  return migration && migration.success ? ensureRuntimeInitialized() : null;
}

function getAllianceApplication(allianceID, corporationID, options = {}) {
  const numericAllianceID = normalizePositiveInteger(allianceID, null);
  const numericCorporationID = normalizePositiveInteger(corporationID, null);
  if (!numericAllianceID || !numericCorporationID) {
    return null;
  }
  const runtimeTable = getCanonicalTable(options);
  const allianceRuntime = runtimeTable &&
    runtimeTable.alliances &&
    runtimeTable.alliances[String(numericAllianceID)];
  const application = allianceRuntime &&
    allianceRuntime.applications &&
    allianceRuntime.applications[String(numericCorporationID)];
  return application
    ? normalizeApplicationRecord(
        application,
        numericAllianceID,
        numericCorporationID,
        options,
      )
    : null;
}

function listAllianceApplications(allianceID, options = {}) {
  const numericAllianceID = normalizePositiveInteger(allianceID, null);
  if (!numericAllianceID) {
    return [];
  }
  const runtimeTable = getCanonicalTable(options);
  const allianceRuntime = runtimeTable &&
    runtimeTable.alliances &&
    runtimeTable.alliances[String(numericAllianceID)];
  return Object.entries(
    allianceRuntime && allianceRuntime.applications || {},
  )
    .map(([corporationID, application]) => normalizeApplicationRecord(
      application,
      numericAllianceID,
      corporationID,
      options,
    ))
    .filter(Boolean)
    .sort((left, right) => left.corporationID - right.corporationID);
}

function listCorporationAllianceApplications(corporationID, options = {}) {
  const numericCorporationID = normalizePositiveInteger(corporationID, null);
  if (!numericCorporationID) {
    return [];
  }
  const runtimeTable = getCanonicalTable(options);
  if (!runtimeTable) {
    return [];
  }
  const applications = [];
  for (const [allianceID, allianceRuntime] of Object.entries(
    runtimeTable.alliances || {},
  )) {
    const application = allianceRuntime &&
      allianceRuntime.applications &&
      allianceRuntime.applications[String(numericCorporationID)];
    if (!application) {
      continue;
    }
    const normalized = normalizeApplicationRecord(
      application,
      allianceID,
      numericCorporationID,
      options,
    );
    if (normalized) {
      applications.push(normalized);
    }
  }
  return applications.sort((left, right) => left.allianceID - right.allianceID);
}

function writeApplication(allianceID, corporationID, updater, options = {}) {
  const migration = ensureCanonicalApplicationsMigrated(options);
  if (!migration || migration.success !== true) {
    return migration || {
      success: false,
      errorMsg: "ALLIANCE_APPLICATION_MIGRATION_FAILED",
    };
  }
  const numericAllianceID = normalizePositiveInteger(allianceID, null);
  const numericCorporationID = normalizePositiveInteger(corporationID, null);
  if (!numericAllianceID || !numericCorporationID) {
    return { success: false, errorMsg: "INVALID_ALLIANCE_APPLICATION" };
  }

  let operationResult = null;
  const writeResult = updateRuntimeState((runtimeTable) => {
    const allianceRuntime = runtimeTable.alliances &&
      runtimeTable.alliances[String(numericAllianceID)];
    if (!allianceRuntime) {
      operationResult = { success: false, errorMsg: "ALLIANCE_NOT_FOUND" };
      return runtimeTable;
    }
    allianceRuntime.applications = allianceRuntime.applications &&
      typeof allianceRuntime.applications === "object"
      ? allianceRuntime.applications
      : {};
    const key = String(numericCorporationID);
    const current = allianceRuntime.applications[key]
      ? normalizeApplicationRecord(
          allianceRuntime.applications[key],
          numericAllianceID,
          numericCorporationID,
          options,
        )
      : null;
    const nextResult = updater(current, runtimeTable, allianceRuntime);
    if (!nextResult || nextResult.success !== true) {
      operationResult = nextResult || {
        success: false,
        errorMsg: "ALLIANCE_APPLICATION_UPDATE_FAILED",
      };
      return runtimeTable;
    }
    if (nextResult.remove === true) {
      delete allianceRuntime.applications[key];
      operationResult = {
        success: true,
        data: cloneValue(current),
        removed: true,
        alreadyDeleted: nextResult.alreadyDeleted === true,
      };
      return runtimeTable;
    }
    const normalized = normalizeApplicationRecord(
      nextResult.data,
      numericAllianceID,
      numericCorporationID,
      options,
    );
    if (!normalized) {
      operationResult = {
        success: false,
        errorMsg: "INVALID_ALLIANCE_APPLICATION",
      };
      return runtimeTable;
    }
    allianceRuntime.applications[key] = normalized;
    operationResult = {
      success: true,
      data: cloneValue(normalized),
      duplicate: nextResult.duplicate === true,
    };
    return runtimeTable;
  });
  if (!writeResult || writeResult.success !== true) {
    return writeResult || {
      success: false,
      errorMsg: "ALLIANCE_APPLICATION_WRITE_FAILED",
    };
  }
  if (!operationResult || operationResult.success !== true) {
    return operationResult || {
      success: false,
      errorMsg: "ALLIANCE_APPLICATION_UPDATE_FAILED",
    };
  }
  const flushResult = flushCanonicalState();
  return flushResult.success ? operationResult : flushResult;
}

function createAllianceApplication(options = {}) {
  const allianceID = normalizePositiveInteger(options.allianceID, null);
  const corporationID = normalizePositiveInteger(options.corporationID, null);
  const applicationText = normalizeText(options.applicationText, "");
  if (applicationText.length > ALLIANCE_APPLICATION_TEXT_MAX_LENGTH) {
    return { success: false, errorMsg: "APPLICATION_TEXT_TOO_LONG" };
  }
  const nowMs = normalizeNowMs(options.nowMs);
  return writeApplication(
    allianceID,
    corporationID,
    (current, runtimeTable) => {
      if (current) {
        return { success: false, errorMsg: "APPLICATION_ALREADY_EXISTS" };
      }
      return {
        success: true,
        data: {
          schemaVersion: ALLIANCE_APPLICATION_SCHEMA_VERSION,
          applicationID: crypto.randomUUID(),
          allianceID,
          corporationID,
          applicationText,
          state: ALLIANCE_APPLICATION_STATE.NEW,
          applicationDateTime: normalizeFiletimeString(
            options.applicationDateTime,
            filetimeFromUnixMs(nowMs),
          ),
          createdAtMs: nowMs,
          updatedAtMs: nowMs,
          acceptedAtMs: null,
          effectiveAtMs: null,
          becameEffectiveAtMs: null,
          effectiveJobID: null,
        },
      };
    },
    { nowMs },
  );
}

function transitionNewAllianceApplication(options = {}) {
  const desiredState = normalizeState(options.state, 0);
  if (![
    ALLIANCE_APPLICATION_STATE.ACCEPTED,
    ALLIANCE_APPLICATION_STATE.REJECTED,
  ].includes(desiredState)) {
    return { success: false, errorMsg: "ILLEGAL_APPLICATION_TRANSITION" };
  }
  const nowMs = normalizeNowMs(options.nowMs);
  const hasApplicationText = options.applicationText !== undefined;
  const applicationText = hasApplicationText
    ? normalizeText(options.applicationText, "")
    : null;
  if (
    hasApplicationText &&
    applicationText.length > ALLIANCE_APPLICATION_TEXT_MAX_LENGTH
  ) {
    return { success: false, errorMsg: "APPLICATION_TEXT_TOO_LONG" };
  }
  const result = writeApplication(
    options.allianceID,
    options.corporationID,
    (current) => {
      if (!current) {
        return { success: false, errorMsg: "APPLICATION_NOT_FOUND" };
      }
      if (current.state === desiredState) {
        return { success: true, duplicate: true, data: current };
      }
      if (current.state !== ALLIANCE_APPLICATION_STATE.NEW) {
        return { success: false, errorMsg: "ILLEGAL_APPLICATION_TRANSITION" };
      }
      const next = {
        ...current,
        applicationText: hasApplicationText
          ? applicationText
          : current.applicationText,
        state: desiredState,
        updatedAtMs: nowMs,
      };
      if (desiredState === ALLIANCE_APPLICATION_STATE.ACCEPTED) {
        next.acceptedAtMs = nowMs;
        next.effectiveAtMs = nowMs + ALLIANCE_APPLICATION_EFFECTIVE_DELAY_MS;
        next.effectiveJobID = buildEffectiveJobID(next.applicationID);
        next.effectiveTransitionStatus = "scheduled";
      } else {
        next.rejectedAtMs = nowMs;
        next.rejectionReason = normalizeText(options.reason, "");
        next.effectiveTransitionStatus = null;
      }
      return { success: true, data: next };
    },
    { nowMs },
  );
  if (
    result &&
    result.success === true &&
    result.data &&
    result.data.state === ALLIANCE_APPLICATION_STATE.ACCEPTED
  ) {
    queueEffectiveApplication(result.data);
  }
  return result;
}

function acceptAllianceApplication(options = {}) {
  return transitionNewAllianceApplication({
    ...options,
    state: ALLIANCE_APPLICATION_STATE.ACCEPTED,
  });
}

function rejectAllianceApplication(options = {}) {
  return transitionNewAllianceApplication({
    ...options,
    state: ALLIANCE_APPLICATION_STATE.REJECTED,
  });
}

function cancelAcceptedAllianceApplication(options = {}) {
  const nowMs = normalizeNowMs(options.nowMs);
  const expectedApplicationID = normalizeApplicationID(options.applicationID);
  return writeApplication(
    options.allianceID,
    options.corporationID,
    (current) => {
      if (!current) {
        return { success: false, errorMsg: "APPLICATION_NOT_FOUND" };
      }
      if (
        !expectedApplicationID ||
        current.applicationID !== expectedApplicationID
      ) {
        return { success: false, errorMsg: "STALE_APPLICATION_JOB" };
      }
      if (current.state === ALLIANCE_APPLICATION_STATE.REJECTED) {
        return { success: true, duplicate: true, data: current };
      }
      if (current.state !== ALLIANCE_APPLICATION_STATE.ACCEPTED) {
        return { success: false, errorMsg: "ILLEGAL_APPLICATION_TRANSITION" };
      }
      return {
        success: true,
        data: {
          ...current,
          state: ALLIANCE_APPLICATION_STATE.REJECTED,
          rejectedAtMs: nowMs,
          rejectionReason: normalizeText(options.reason, ""),
          effectiveTransitionStatus: "cancelled",
          updatedAtMs: nowMs,
        },
      };
    },
    { nowMs },
  );
}

function markAllianceApplicationEffective(options = {}) {
  const nowMs = normalizeNowMs(options.nowMs);
  const expectedApplicationID = normalizeApplicationID(options.applicationID);
  return writeApplication(
    options.allianceID,
    options.corporationID,
    (current) => {
      if (!current) {
        return { success: false, errorMsg: "APPLICATION_NOT_FOUND" };
      }
      if (
        !expectedApplicationID ||
        current.applicationID !== expectedApplicationID
      ) {
        return { success: false, errorMsg: "STALE_APPLICATION_JOB" };
      }
      if (current.state === ALLIANCE_APPLICATION_STATE.EFFECTIVE) {
        return { success: true, duplicate: true, data: current };
      }
      if (current.state !== ALLIANCE_APPLICATION_STATE.ACCEPTED) {
        return { success: false, errorMsg: "ILLEGAL_APPLICATION_TRANSITION" };
      }
      if (options.force !== true && nowMs < Number(current.effectiveAtMs || 0)) {
        return { success: false, errorMsg: "APPLICATION_NOT_DUE" };
      }
      return {
        success: true,
        data: {
          ...current,
          state: ALLIANCE_APPLICATION_STATE.EFFECTIVE,
          becameEffectiveAtMs: nowMs,
          effectiveDateTime: filetimeFromUnixMs(nowMs),
          effectiveTransitionStatus: "effective",
          updatedAtMs: nowMs,
        },
      };
    },
    { nowMs },
  );
}

function deferAcceptedAllianceApplication(options = {}) {
  const nowMs = normalizeNowMs(options.nowMs);
  const delayMs = Math.max(
    60_000,
    Math.trunc(Number(options.delayMs) || 60 * 60 * 1000),
  );
  const expectedApplicationID = normalizeApplicationID(options.applicationID);
  return writeApplication(
    options.allianceID,
    options.corporationID,
    (current) => {
      if (!current) {
        return { success: false, errorMsg: "APPLICATION_NOT_FOUND" };
      }
      if (
        !expectedApplicationID ||
        current.applicationID !== expectedApplicationID
      ) {
        return { success: false, errorMsg: "STALE_APPLICATION_JOB" };
      }
      if (current.state !== ALLIANCE_APPLICATION_STATE.ACCEPTED) {
        return { success: false, errorMsg: "ILLEGAL_APPLICATION_TRANSITION" };
      }
      const effectiveAtMs = nowMs + delayMs;
      return {
        success: true,
        data: {
          ...current,
          effectiveAtMs,
          effectiveJobID:
            `${DURABLE_EFFECTIVE_JOB_PREFIX}${current.applicationID}:${effectiveAtMs}`,
          effectiveTransitionStatus: "suspended",
          suspensionReason: normalizeText(options.reason, ""),
          updatedAtMs: nowMs,
        },
      };
    },
    { nowMs },
  );
}

function deleteAllianceApplication(options = {}) {
  const expectedApplicationID = normalizeApplicationID(options.applicationID);
  const allowedStates = new Set(
    Array.isArray(options.allowedStates)
      ? options.allowedStates.map((state) => normalizeState(state, 0))
      : [ALLIANCE_APPLICATION_STATE.NEW, ALLIANCE_APPLICATION_STATE.REJECTED],
  );
  return writeApplication(
    options.allianceID,
    options.corporationID,
    (current) => {
      if (!current) {
        return { success: true, remove: true, alreadyDeleted: true };
      }
      if (
        expectedApplicationID &&
        current.applicationID !== expectedApplicationID
      ) {
        return { success: false, errorMsg: "STALE_APPLICATION" };
      }
      if (!allowedStates.has(current.state)) {
        return { success: false, errorMsg: "ILLEGAL_APPLICATION_TRANSITION" };
      }
      return { success: true, remove: true };
    },
    options,
  );
}

function buildEffectiveApplicationJob(application) {
  if (
    !application ||
    application.state !== ALLIANCE_APPLICATION_STATE.ACCEPTED ||
    !normalizeApplicationID(application.applicationID)
  ) {
    return null;
  }
  const dueAtMs = normalizeOptionalMs(application.effectiveAtMs);
  if (dueAtMs === null) {
    return null;
  }
  return {
    jobID: normalizeApplicationID(
      application.effectiveJobID,
      buildEffectiveJobID(application.applicationID),
    ),
    type: DURABLE_EFFECTIVE_JOB_TYPE,
    dueAtMs,
    payload: {
      applicationID: application.applicationID,
      allianceID: application.allianceID,
      corporationID: application.corporationID,
    },
  };
}

async function scheduleEffectiveApplication(applicationOrOptions = {}) {
  const scheduler = durableScheduler;
  if (!scheduler) {
    return null;
  }
  const expectedApplicationID = normalizeApplicationID(
    applicationOrOptions.applicationID,
  );
  const application = getAllianceApplication(
    applicationOrOptions.allianceID,
    applicationOrOptions.corporationID,
  );
  if (
    !application ||
    (expectedApplicationID &&
      application.applicationID !== expectedApplicationID)
  ) {
    return null;
  }
  const job = buildEffectiveApplicationJob(application);
  if (!job) {
    return null;
  }
  await scheduler.schedule(job);
  return job;
}

function queueEffectiveApplication(application) {
  if (!durableScheduler) {
    return;
  }
  void scheduleEffectiveApplication(application).catch((error) => {
    log.warn(
      `[AllianceApplications] scheduling failed application=${application.applicationID}: ` +
        error.message,
    );
  });
}

function resolveDurableEffectiveApplication(job = {}, options = {}) {
  if (job.type !== DURABLE_EFFECTIVE_JOB_TYPE) {
    return { success: false, errorMsg: "INVALID_APPLICATION_JOB" };
  }
  const payload = job && job.payload && typeof job.payload === "object"
    ? job.payload
    : {};
  const allianceID = normalizePositiveInteger(payload.allianceID, null);
  const corporationID = normalizePositiveInteger(payload.corporationID, null);
  const applicationID = normalizeApplicationID(payload.applicationID);
  if (!allianceID || !corporationID || !applicationID) {
    return { success: false, errorMsg: "INVALID_APPLICATION_JOB" };
  }
  const application = getAllianceApplication(allianceID, corporationID, options);
  if (!application || application.applicationID !== applicationID) {
    return { success: true, stale: true, data: null };
  }
  const expectedJobID = normalizeApplicationID(
    application.effectiveJobID,
    buildEffectiveJobID(applicationID),
  );
  if (String(job.jobID || "") !== expectedJobID) {
    return { success: true, stale: true, data: application };
  }
  if (application.state === ALLIANCE_APPLICATION_STATE.EFFECTIVE) {
    return { success: true, alreadyEffective: true, data: application };
  }
  if (application.state !== ALLIANCE_APPLICATION_STATE.ACCEPTED) {
    return { success: true, stale: true, data: application };
  }
  const nowMs = normalizeNowMs(options.nowMs);
  if (nowMs < Number(application.effectiveAtMs || 0)) {
    return {
      success: false,
      errorMsg: "APPLICATION_NOT_DUE",
      data: application,
    };
  }
  return { success: true, data: application };
}

function bindDurableScheduler(scheduler) {
  if (!scheduler || typeof scheduler.schedule !== "function") {
    throw new TypeError("alliance application scheduler requires schedule");
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

async function reconcileDurableAllianceApplications() {
  const runtimeTable = getCanonicalTable();
  const pending = [];
  for (const [allianceID, allianceRuntime] of Object.entries(
    runtimeTable && runtimeTable.alliances || {},
  )) {
    for (const [corporationID, application] of Object.entries(
      allianceRuntime && allianceRuntime.applications || {},
    )) {
      const normalized = normalizeApplicationRecord(
        application,
        allianceID,
        corporationID,
      );
      if (normalized && normalized.state === ALLIANCE_APPLICATION_STATE.ACCEPTED) {
        pending.push(normalized);
      }
    }
  }
  if (!durableScheduler) {
    return { scheduled: 0, pending: pending.length };
  }
  const jobs = (await Promise.all(
    pending.map((application) => scheduleEffectiveApplication(application)),
  )).filter(Boolean);
  return { scheduled: jobs.length, pending: pending.length };
}

function handleDurableAllianceApplicationEffective(job = {}) {
  // Kept as a dynamic boundary so the canonical state repository does not
  // statically depend on notification/war/affiliation services. The durable
  // handler must complete affiliation before it exposes public state 3.
  const effectiveState = require(path.join(
    __dirname,
    "./allianceApplicationEffectiveState",
  ));
  return effectiveState.handleDurableAllianceApplicationEffective(job);
}

module.exports = {
  ALLIANCE_APPLICATION_EFFECTIVE_DELAY_MS,
  ALLIANCE_APPLICATION_SCHEMA_VERSION,
  ALLIANCE_APPLICATION_STATE,
  ALLIANCE_APPLICATION_TEXT_MAX_LENGTH,
  DURABLE_EFFECTIVE_JOB_TYPE,
  acceptAllianceApplication,
  bindDurableScheduler,
  buildEffectiveApplicationJob,
  cancelAcceptedAllianceApplication,
  createAllianceApplication,
  deferAcceptedAllianceApplication,
  deleteAllianceApplication,
  ensureCanonicalApplicationsMigrated,
  getAllianceApplication,
  handleDurableAllianceApplicationEffective,
  listAllianceApplications,
  listCorporationAllianceApplications,
  markAllianceApplicationEffective,
  reconcileDurableAllianceApplications,
  rejectAllianceApplication,
  resolveDurableEffectiveApplication,
  scheduleEffectiveApplication,
  transitionNewAllianceApplication,
  unbindDurableScheduler,
  _testing: {
    buildApplicationKey,
    buildLegacyApplicationID,
    filetimeFromUnixMs,
    normalizeApplicationRecord,
    unixMsFromFiletime,
  },
};
