"use strict";

const { createHash } = require("node:crypto");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// These are protocol career IDs. The client's internal career path IDs differ.
const GROUPS = Object.freeze({
  1: ["CareerAgentMissions", "Scanning", "Hacking", "AdvancedHacking", "Wormholes", "GasSites", "CombatSites", "Navigation", "AdvancedNavigation", "ProjectDiscovery"],
  2: ["IndustrialistCareerAgentsMissions", "Market", "Salvage", "ResourceHarvesting", "Refining", "Manufacturing", "DistributionAgent", "MiningAgent", "Research"],
  3: ["CareerAgentMissions", "SecurityAgent", "AbyssalDeadspace", "Combat", "Bounties", "CombatSites", "EpicArc", "Market", "Standings", "LoyaltyPoints"],
  4: ["CareerAgentMissions", "Social", "ElectronicWarfare", "Combat", "PvP", "CapacitorWarfare", "FactionWarfare", "Support", "Destruction", "Duels"],
});
function authoredGoalID(symbol) {
  if (typeof symbol !== "string" || !/^[A-Za-z][A-Za-z0-9]{0,95}$/.test(symbol)) throw new Error("Invalid authored career symbol");
  const hash = createHash("sha256").update(`evejs:air-career-program:v1:${symbol}`).digest();
  // UUIDv8 identifies a project-owned, application-defined SHA-256 identity.
  hash[6] = (hash[6] & 15) | 128;
  hash[8] = (hash[8] & 63) | 128;
  const hex = hash.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function integer(value, name, maximum = 0xffffffff) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error(`Invalid career ${name}`);
  return value;
}
function freeze(value) {
  if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
function sourceSupported(row) {
  const source = row.source;
  if (source?.kind === "tutorial-completed") return row.target === 1;
  if (source?.kind === "achievement") return require("./careerGameplaySources").isSupportedAchievementSource(source);
  if (source?.kind === "career-points") return Number.isInteger(source.career) && source.career >= 0 && source.career <= 4 && row.points === 0;
  if (source?.kind === "career-event") return require("./careerEventLedger").supports(source);
  if (source?.kind === "visited-regions") return require("./careerExplorationSources").supports(source);
  if (source?.kind === "mission-evidence") return require("./careerMissionSources").supports(source);
  if (source?.kind === "corporation-standing") return row.target === 1 && require("./careerStandingSources").supports(source);
  if (source?.kind === "mail-sent") return row.target === 1 && require("./careerSocialSources").supports(source);
  if (["combat-kills", "fw-membership"].includes(source?.kind)) return (
    (source.kind !== "fw-membership" || row.target === 1) && require("./careerCombatSources").supports(source));
  if (source?.kind === "npc-kills") return true;
  if (source?.kind === "module-hacks") return source.securityClass === undefined || ["low", "null", "wormhole"].includes(source.securityClass);
  if (source?.kind === "mining-units") return [457, 458, 459, 460, 462].includes(source.oreGroupID);
  if (source?.kind === "industry-delivery") return [1, 3, 4, 5].includes(source.activityID) &&
    (source.productGroupID === undefined || [25, 26, 31, 420].includes(source.productGroupID));
  return false;
}
function checkCompleteProgram(rows) {
  const symbols = new Set();
  for (const row of rows) {
    if (row.id !== authoredGoalID(row.symbol) || symbols.has(row.symbol)) throw new Error("Invalid authored career identity");
    symbols.add(row.symbol);
    if (row.source.kind === "tutorial-completed") throw new Error("No verified tutorial career goal localization");
    if (row.source.kind === "career-points") {
      if (row.group || row.points !== 0 || row.source.career !== row.career || row.subtype !== "OVERALL_GOAL")
        throw new Error("Invalid career points goal");
    } else if (!row.group || row.points <= 0 || row.subtype !== "CAREER_PATH_GOAL" || !row.auraTextID)
      throw new Error("Invalid playable career activity");
  }
  for (const career of [1, 2, 3, 4]) {
    const activities = rows.filter(row => row.career === career && row.source.kind !== "career-points");
    // Additional activities provide alternative ways to graduate. Preserve the
    // original activities' points and earned claims instead of redistributing
    // their rewards every time another working mechanic gains an AIR adapter.
    if (!activities.length || activities.reduce((sum, row) => sum + row.points, 0) < 750)
      throw new Error("Career activities must offer at least 750 points");
    const headers = rows.filter(row => row.career === career && row.source.kind === "career-points");
    if (headers.length !== 1 || headers[0].target !== 750) throw new Error("Career graduation header required");
  }
  const overall = rows.filter(row => row.career === 0);
  if (overall.length !== 4 || overall.some(row => row.source.kind !== "career-points") ||
      JSON.stringify(overall.map(row => row.target).sort((a, b) => a - b)) !== "[750,1500,2250,3000]")
    throw new Error("Overall career milestones required");
}
function createCatalog(definitions, { completeProgram = false } = {}) {
  if (!Array.isArray(definitions) || definitions.length > 1024) throw new Error("Invalid career catalog");
  const seen = new Set();
  const rows = definitions.map(input => {
    const row = structuredClone(input);
    if (!UUID.test(row.id) || seen.has(row.id)) throw new Error("Invalid or duplicate career goal ID");
    seen.add(row.id);
    integer(row.target, "target"); integer(row.nameMessageID, "name"); integer(row.descriptionMessageID, "description");
    if (!Number.isInteger(row.career) || row.career < 0 || row.career > 4 ||
        !Number.isInteger(row.points) || row.points < 0 || row.points > 0xffffffff) throw new Error("Invalid career classification");
    if (!sourceSupported(row)) throw new Error("Unsupported career progress source");
    if (row.group !== undefined && !GROUPS[row.career]?.includes(row.group)) throw new Error("Unknown native career group");
    if (row.subtype !== undefined && !["CAREER_PATH_GOAL", "OVERALL_GOAL"].includes(row.subtype)) throw new Error("Invalid career subtype");
    if (row.threat !== undefined && (!Number.isInteger(row.threat) || row.threat < 0 || row.threat > 3)) throw new Error("Invalid career threat");
    for (const field of ["order", "duration"]) if (row[field] !== undefined && (!Number.isInteger(row[field]) || row[field] < 0 || row[field] > 0xffffffff)) throw new Error(`Invalid career ${field}`);
    for (const field of ["auraTextID", "agencyLinkTextID"]) if (row[field] !== undefined) integer(row[field], field);
    if (row.agencyScreen !== undefined && !/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(row.agencyScreen)) throw new Error("Invalid career agency screen");
    if (!Array.isArray(row.rewards) || row.rewards.length > 32) throw new Error("Invalid career rewards");
    for (const reward of row.rewards) {
      if (![1, 2].includes(reward.label)) throw new Error("Invalid career reward label");
      if (reward.kind === "sp") {
        integer(reward.amount, "SP", 10000000);
        if (reward.amount % 1000 !== 0 && !(reward.amount >= 2500 && reward.amount % 1000 === 500))
          throw new Error("Career SP amount cannot be represented by native redemption tokens");
      }
      else if (reward.kind === "isk") integer(reward.amount, "ISK", 2147483647);
      else if (reward.kind === "item") { integer(reward.typeID, "item type"); integer(reward.quantity, "item quantity", 1000000000); }
      else throw new Error("Unsupported career reward");
    }
    for (const label of [1, 2]) if (row.rewards.filter(reward => reward.label === label && reward.kind === "sp")
      .reduce((sum, reward) => sum + reward.amount, 0) > 10000000) throw new Error("Career SP bundle exceeds grant capacity");
    return freeze(row);
  });
  if (completeProgram) checkCompleteProgram(rows);
  const list = Object.freeze(rows), byID = new Map(rows.map(row => [row.id, row]));
  return { list: () => list, get: id => byID.get(id) || null };
}
const content = require("./careerCatalog.data.json");
const catalog = createCatalog(content.goals, { completeProgram: content.goals.length > 0 });
module.exports = { ...catalog, createCatalog, authoredGoalID, contentVersion: content.contentVersion || null };
