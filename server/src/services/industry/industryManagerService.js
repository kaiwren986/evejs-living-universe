"use strict";

const path = require("path");

const BaseService = require(path.join(__dirname, "../baseService"));
const {
  buildDict,
  buildList,
  unwrapMarshalValue,
} = require(path.join(__dirname, "../_shared/serviceHelpers"));
const {
  buildJobPayload,
  parseIndustryRequest,
} = require(path.join(__dirname, "./industryPayloads"));
const {
  INDUSTRY_ACTIVITY,
} = require(path.join(__dirname, "./industryConstants"));
const {
  resolveIndustrySlotUsage,
} = require(path.join(__dirname, "./industryRestrictions"));
const {
  cancelIndustryJob,
  deliverIndustryJob,
  getJobByID,
  getJobCountsByInstaller,
  installIndustryJob,
  listJobsByOwner,
  sessionCanAccessIndustryOwner,
} = require(path.join(__dirname, "./industryRuntimeState"));

function toInt(value, fallback = 0) {
  const numeric = Number(unwrapMarshalValue(value));
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function normalizeCompleteManyJobs(rawJobs) {
  const jobs = unwrapMarshalValue(rawJobs);
  return Array.isArray(jobs) ? jobs : [];
}

function extractCompleteManyJobID(entry) {
  const normalized = unwrapMarshalValue(entry);
  if (Array.isArray(normalized)) {
    return toInt(normalized[0], 0);
  }
  if (normalized && typeof normalized === "object") {
    return toInt(normalized.jobID, 0);
  }
  return toInt(normalized, 0);
}

function canViewStarbaseJob(session, job) {
  // Role masks remain governed by the shared industry access rule. POS jobs
  // additionally require current persisted membership, matching facility and
  // blueprint reads even if a departed pilot retains an old session snapshot.
  return !job.starbaseTowerID || require("./starbaseIndustryRuntime")
    .canAccessArray(session, { ownerID: job.ownerID });
}

class IndustryManagerService extends BaseService {
  constructor() {
    super("industryManager");
  }

  Handle_GetJob(args, session) {
    const jobID = args && args.length > 0 ? args[0] : null;
    const job = getJobByID(jobID);
    return buildJobPayload(
      job &&
      job.installationPending !== true &&
      canViewStarbaseJob(session, job) &&
      sessionCanAccessIndustryOwner(session, job.ownerID)
        ? job
        : {},
    );
  }

  Handle_GetJobsByOwner(args, session) {
    const ownerID = args && args.length > 0 ? args[0] : null;
    const includeCompleted = Boolean(args && args.length > 1 ? args[1] : false);
    if (!sessionCanAccessIndustryOwner(session, ownerID)) {
      return buildList([]);
    }
    return buildList(
      listJobsByOwner(ownerID, includeCompleted)
        .filter((job) => canViewStarbaseJob(session, job))
        .map((job) => buildJobPayload(job)),
    );
  }

  async Handle_InstallJob(args, session) {
    const request = parseIndustryRequest(args && args.length > 0 ? args[0] : null);
    const result = await installIndustryJob(session, request);
    return result && result.data ? result.data.jobID : null;
  }

  Handle_CompleteJob(args, session) {
    const jobID = args && args.length > 0 ? args[0] : null;
    const result = deliverIndustryJob(session, jobID);
    return result && result.data ? buildJobPayload(result.data) : null;
  }

  Handle_CompleteManyJobs(args, session) {
    const jobs = normalizeCompleteManyJobs(
      args && args.length > 0 ? args[0] : [],
    );
    const delivered = [];
    for (const entry of jobs) {
      const jobID = extractCompleteManyJobID(entry);
      if (jobID <= 0) {
        continue;
      }
      const result = deliverIndustryJob(session, jobID);
      if (result && result.data) {
        delivered.push(buildJobPayload(result.data));
      }
    }
    return buildList(delivered);
  }

  Handle_CancelJob(args, session) {
    const jobID = args && args.length > 0 ? args[0] : null;
    const result = cancelIndustryJob(session, jobID);
    return result && result.data ? buildJobPayload(result.data) : null;
  }

  Handle_GetJobCounts(args, session) {
    const sessionCharacterID = toInt(
      session && (session.characterID || session.charid),
      0,
    );
    const requestedInstallerID = args && args.length > 0
      ? toInt(args[0], 0)
      : sessionCharacterID;
    if (
      sessionCharacterID <= 0 ||
      requestedInstallerID !== sessionCharacterID
    ) {
      return buildDict([]);
    }
    const jobCounts = getJobCountsByInstaller(sessionCharacterID);
    return buildDict(
      Object.values(INDUSTRY_ACTIVITY).map((activityID) => [
        activityID,
        resolveIndustrySlotUsage(activityID, jobCounts),
      ]),
    );
  }
}

module.exports = IndustryManagerService;
