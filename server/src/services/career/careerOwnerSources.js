"use strict";

// Read committed domain evidence. Native requests never supply these facts.
const database = require("../../gameStore");
const { resolveItemByTypeID } = require("../inventory/itemTypeRegistry");
function persisted(table, context) {
  if (context && Object.hasOwn(context, table)) return context[table];
  const result = database.readPersisted(table, "/");
  if (!result?.success) throw new Error(result?.errorMsg || "CAREER_SOURCE_UNAVAILABLE");
  const data = result.data || {};
  if (context) context[table] = data;
  return data;
}
function filetime(value) {
  try {
    const time = Number((BigInt(value || 0) - 116444736000000000n) / 10000n);
    return Number.isSafeInteger(time) && time > 0 ? time : 0;
  }
  catch (_) { return 0; }
}
function identity(value) { const id = Number(value); return Number.isSafeInteger(id) && id > 0 ? id : 0; }
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
    const jobs = Object.values(persisted("industryJobs", context).jobs || {}).filter(job =>
      identity(job.jobID) && Number(job.installerID) === characterID && Number(job.status) === 101 &&
      job.installationPending !== true && Number(job.activityID) === source.activityID &&
      (!source.productGroupID || Number(resolveItemByTypeID(Number(job.productTypeID))?.groupID) === source.productGroupID));
    return { kind: source.kind, id: `industry-delivery:${source.activityID}:${source.productGroupID || 0}:v1`,
      progress: new Set(jobs.map(job => identity(job.jobID)).filter(Boolean)).size,
      updatedAtMs: jobs.reduce((latest, job) => Math.max(latest, filetime(job.deliveredAt)), 0) };
  }
  if (source.kind === "npc-kills") {
    const kills = Object.values(persisted("killmails", context).records || {}).filter(kill =>
      identity(kill.killID) && kill.careerNpcShip === true &&
      [undefined, null, 0, "0"].includes(kill.victimCharacterID) && Number(kill.finalCharacterID) === characterID &&
      Number(resolveItemByTypeID(Number(kill.victimShipTypeID))?.categoryID) === 11);
    // Private NPCs intentionally have no public killmail. Their immutable run
    // outcomes feed a separate total, independent of the smaller hull goals.
    const privateKills = require("./careerEventLedger").observe(characterID, "abyssal:npc-kills", record);
    return { kind: source.kind, id: "npc-kills:v1",
      progress: new Set(kills.map(kill => identity(kill.killID)).filter(Boolean)).size + privateKills.progress,
      updatedAtMs: Math.max(privateKills.updatedAtMs, kills.reduce((latest, kill) => Math.max(latest, filetime(kill.killTime)), 0)) };
  }
  if (source.kind === "module-hacks") return require("./careerHackingEvidence").observe(characterID, source);
  return null;
}
module.exports = { observe };
