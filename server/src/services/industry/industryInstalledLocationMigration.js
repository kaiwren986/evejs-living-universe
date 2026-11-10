"use strict";

const {
  toInt,
} = require("../../common/numbers");

const {
  INDUSTRY_INSTALLED_LOCATION_ID,
} = require("./industryConstants");

const TARGET_SCHEMA_VERSION = 1;

function cloneValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function hasOwn(value, key) {
  return Boolean(
    value &&
    typeof value === "object" &&
    Object.prototype.hasOwnProperty.call(value, key),
  );
}

function throwMigrationRefusal(report, issues) {
  const preview = issues.slice(0, 5).map((issue) => (
    `${issue.jobKey}:${issue.reason}`
  )).join(", ");
  const error = new Error(
    "Industry installed-location migration refused corrupt or ambiguous jobs" +
      (preview ? ` (${preview})` : ""),
  );
  error.code = "INDUSTRY_INSTALLED_LOCATION_MIGRATION_REFUSED";
  error.report = { ...report, issues: cloneValue(issues) };
  throw error;
}

function buildIndustryInstalledLocationMigration(table = {}) {
  const nextState = cloneValue(table && typeof table === "object" ? table : {});
  nextState._meta = nextState._meta && typeof nextState._meta === "object"
    ? nextState._meta
    : {};
  nextState.jobs = nextState.jobs && typeof nextState.jobs === "object"
    ? nextState.jobs
    : {};

  const sourceVersion = Math.max(
    0,
    toInt(nextState._meta.installedLocationSchemaVersion, 0),
  );
  const report = {
    sourceVersion,
    targetVersion: TARGET_SCHEMA_VERSION,
    totalJobs: Object.keys(nextState.jobs).length,
    canonicalJobs: 0,
    missingJobs: 0,
    migratedJobs: 0,
    changed: false,
  };
  if (sourceVersion > TARGET_SCHEMA_VERSION) {
    const error = new Error(
      `Industry installed-location schema ${sourceVersion} is newer than supported ${TARGET_SCHEMA_VERSION}`,
    );
    error.code = "INDUSTRY_INSTALLED_LOCATION_SCHEMA_UNSUPPORTED";
    error.report = report;
    throw error;
  }

  const issues = [];
  for (const [jobKey, job] of Object.entries(nextState.jobs)) {
    if (!job || typeof job !== "object" || Array.isArray(job)) {
      issues.push({ jobKey, reason: "INVALID_JOB_RECORD" });
      continue;
    }
    if (hasOwn(job, "installedLocationID")) {
      if (toInt(job.installedLocationID, 0) !== INDUSTRY_INSTALLED_LOCATION_ID) {
        issues.push({
          jobKey,
          reason: "EXPLICIT_LOCATION_INVALID",
          installedLocationID: job.installedLocationID,
        });
      } else {
        report.canonicalJobs += 1;
      }
      continue;
    }

    report.missingJobs += 1;
    if (sourceVersion >= TARGET_SCHEMA_VERSION) {
      issues.push({ jobKey, reason: "MARKED_SCHEMA_JOB_MISSING_LOCATION" });
      continue;
    }
    if (
      hasOwn(job, "installationOperationID") ||
      hasOwn(job, "installationPending")
    ) {
      issues.push({ jobKey, reason: "ASYNC_INSTALL_JOB_MISSING_LOCATION" });
      continue;
    }

    const keyJobID = toInt(jobKey, 0);
    const jobID = toInt(job.jobID, 0);
    if (keyJobID <= 0 || jobID <= 0 || keyJobID !== jobID) {
      issues.push({ jobKey, reason: "JOB_IDENTITY_MISMATCH", jobID });
      continue;
    }
    if (
      toInt(job.blueprintID, 0) <= 0 ||
      toInt(job.blueprintTypeID, 0) <= 0 ||
      toInt(job.ownerID, 0) <= 0
    ) {
      issues.push({ jobKey, reason: "BLUEPRINT_IDENTITY_INVALID" });
      continue;
    }

    job.installedLocationID = INDUSTRY_INSTALLED_LOCATION_ID;
    report.migratedJobs += 1;
  }

  if (issues.length > 0) {
    throwMigrationRefusal(report, issues);
  }

  nextState._meta.installedLocationSchemaVersion = TARGET_SCHEMA_VERSION;
  report.changed = (
    report.migratedJobs > 0 ||
    sourceVersion !== TARGET_SCHEMA_VERSION
  );
  return { nextState, report };
}

module.exports = {
  TARGET_SCHEMA_VERSION,
  buildIndustryInstalledLocationMigration,
};
