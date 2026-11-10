"use strict";

// Read committed domain evidence. Native requests never supply these facts.
const database = require("../../gameStore");
const { resolveItemByTypeID } = require("../inventory/itemTypeRegistry");
function filetime(value) {
  try {
    const time = Number((BigInt(value || 0) - 116444736000000000n) / 10000n);
    return Number.isSafeInteger(time) && time > 0 ? time : 0;
  }
  catch (_) { return 0; }
}
function identity(value) { const id = Number(value); return Number.isSafeInteger(id) && id > 0 ? id : 0; }
function industryEvidence(characterID, context) {
  const evidence = context.careerIndustryEvidence ||= new Map();
  if (evidence.has(characterID)) return evidence.get(characterID);
  const result = database.readPersistedIndustryJobsForCharacter(characterID);
  if (!result?.success) throw new Error(result?.errorMsg || "CAREER_SOURCE_UNAVAILABLE");
  const metrics = new Map();
  for (const job of Object.values(result.data || {})) {
    const jobID = identity(job?.jobID);
    if (!jobID || Number(job.installerID) !== characterID || Number(job.status) !== 101 ||
        job.installationPending === true) continue;
    const activity = Number(job.activityID);
    const group = Number(resolveItemByTypeID(Number(job.productTypeID))?.groupID);
    for (const key of new Set([`${activity}:0`, `${activity}:${group}`])) {
      let metric = metrics.get(key);
      if (!metric) metrics.set(key, (metric = { ids: new Set(), updatedAtMs: 0 }));
      metric.ids.add(jobID);
      metric.updatedAtMs = Math.max(metric.updatedAtMs, filetime(job.deliveredAt));
    }
  }
  evidence.set(characterID, metrics);
  return metrics;
}
function observe(characterID, record, definition, context = {}) {
  characterID = identity(characterID);
  if (!characterID) return null;
  const source = definition.source;
  if (source.kind === "career-event") return require("./careerEventLedger").observe(characterID, source.metric, record);
  if (source.kind === "visited-regions") return require("./careerExplorationSources").observe(characterID, record, definition, context);
  if (source.kind === "mission-evidence") return require("./careerMissionSources").observe(characterID, record, definition, context);
  if (source.kind === "corporation-standing") return require("./careerStandingSources").observe(characterID, record, definition, context);
  if (source.kind === "mail-sent") return require("./careerSocialSources").observe(characterID, record, definition, context);
  if (["combat-kills", "fw-membership"].includes(source.kind))
    return require("./careerCombatSources").observe(characterID, record, definition, context);
  if (source.kind === "mining-units") {
    const totals = context.miningTotals ||= require("../mining/miningLedgerState").getCareerOreQuantities(characterID);
    return { kind: source.kind, id: `mining-units:${source.oreGroupID}:v1`,
      progress: Number(totals.quantities[String(source.oreGroupID)]) || 0, updatedAtMs: totals.updatedAtMs || 0 };
  }
  if (source.kind === "industry-delivery") {
    const metric = typeof source.activityID === "number" && (!source.productGroupID || typeof source.productGroupID === "number")
      ? industryEvidence(characterID, context).get(`${source.activityID}:${source.productGroupID || 0}`)
      : null;
    return { kind: source.kind, id: `industry-delivery:${source.activityID}:${source.productGroupID || 0}:v1`,
      progress: metric?.ids.size || 0, updatedAtMs: metric?.updatedAtMs || 0 };
  }
  if (source.kind === "project-discovery-samples") {
    // Qualified normal submissions and accepted correct tutorial classifications,
    // committed with the project's own progress; old excluded work is not backfilled.
    const project = record?.projectDiscovery;
    return { kind: source.kind, id: "project-discovery-samples:v1",
      progress: Number.isSafeInteger(project?.samplesSubmitted) ? project.samplesSubmitted : 0,
      updatedAtMs: Number(project?.samplesSubmittedAtMs) || 0 };
  }
  if (source.kind === "npc-kills") {
    return require("./careerCombatSources").observeNpcKills(characterID, record, context);
  }
  if (source.kind === "module-hacks") return require("./careerHackingEvidence").observe(characterID, source);
  return null;
}
module.exports = { observe };
