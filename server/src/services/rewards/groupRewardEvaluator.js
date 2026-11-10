"use strict";

// Verified grouprewards/__init__.py and data.py contract from build3396210.
// Security bands here name reward criteria, never the unrelated system-class enum.
const REWARD_TYPE = Object.freeze({ LP: 1, ISK: 2, CORPORATION_STANDINGS: 3, FACTION_STANDINGS: 4 });
const SECURITY_CRITERIA = Object.freeze({ ALL: 0, HIGH: 1, LOW: 2, NULL: 3, SAFE: 4 });
const SECURITY_BANDS = Object.freeze({ high: 1, low: 2, null: 3, safe: 4 });
const TIMINGS = new Set(["immediate", "delayed", "all"]);
function fail(code) { const error = new Error(code); error.code = code; throw error; }
const integer = value => Number.isSafeInteger(value) && value >= 0;
const positive = value => integer(value) && value > 0;

function validateRewardTable(table) {
  if (!table || !Object.values(REWARD_TYPE).includes(table.rewardType) ||
      !Object.values(SECURITY_CRITERIA).includes(table.securityCriteria) ||
      typeof table.delayed !== "boolean" || !Array.isArray(table.entries) || !table.entries.length) fail("GROUP_REWARD_TABLE_INVALID");
  let previous = -1;
  for (const entry of table.entries) {
    if (!entry || !integer(entry.playerCount) || entry.playerCount <= previous || !integer(entry.quantity)) fail("GROUP_REWARD_ENTRIES_INVALID");
    previous = entry.playerCount;
  }
  return table;
}

function validateRewardGroup(group) {
  if (!group || !positive(group.groupRewardID) || !positive(group.rewardingNpcCorporationID) ||
      !positive(group.lpLogTypeNameID) || typeof group.name !== "string" || !group.name.trim() ||
      !Array.isArray(group.tables) || !group.tables.length ||
      !Number.isFinite(group.minimumContribution) || group.minimumContribution < 0 ||
      !Number.isFinite(group.damageContributionMultiplier) || group.damageContributionMultiplier < 0 ||
      !Number.isFinite(group.repairContributionMultiplier) || group.repairContributionMultiplier < 0) fail("GROUP_REWARD_INVALID");
  const bindings = new Set();
  for (const table of group.tables) {
    validateRewardTable(table);
    const key = `${table.rewardType}:${table.delayed}:${table.securityCriteria}`;
    if (bindings.has(key)) fail("GROUP_REWARD_BINDING_DUPLICATE");
    bindings.add(key);
  }
  // ALL plus a specific band would expose two amounts for the same reward leg.
  // This reviewed adapter refuses ambiguous bindings instead of summing them.
  for (const table of group.tables) if (table.securityCriteria !== SECURITY_CRITERIA.ALL &&
      bindings.has(`${table.rewardType}:${table.delayed}:0`)) fail("GROUP_REWARD_BINDING_AMBIGUOUS");
  return group;
}

function lookupRewardQuantity(table, playerCount) {
  validateRewardTable(table);
  if (!integer(playerCount)) fail("GROUP_REWARD_PLAYER_COUNT_INVALID");
  let quantity = 0;
  // The native consumer chooses the preceding breakpoint. It never interpolates.
  for (const entry of table.entries) {
    if (entry.playerCount > playerCount) break;
    quantity = entry.quantity;
  }
  return quantity;
}

function evaluateGroupReward(group, { playerCount, securityBand, timing = "all" } = {}) {
  validateRewardGroup(group);
  if (!integer(playerCount)) fail("GROUP_REWARD_PLAYER_COUNT_INVALID");
  if (!Object.hasOwn(SECURITY_BANDS, securityBand)) fail("GROUP_REWARD_SECURITY_INVALID");
  if (!TIMINGS.has(timing)) fail("GROUP_REWARD_TIMING_INVALID");
  const tables = group.tables.map((table, tableIndex) => ({ table, tableIndex })).filter(({ table }) =>
    (table.securityCriteria === SECURITY_CRITERIA.ALL || table.securityCriteria === SECURITY_BANDS[securityBand]) &&
    (timing === "all" || table.delayed === (timing === "delayed")));
  if (!tables.length) fail("GROUP_REWARD_TABLE_UNAVAILABLE");
  return tables.map(({ table, tableIndex }) => ({
    groupRewardID: group.groupRewardID,
    tableIndex,
    tableKey: `${group.groupRewardID}:${tableIndex}`,
    rewardingNpcCorporationID: group.rewardingNpcCorporationID,
    lpLogTypeNameID: group.lpLogTypeNameID,
    rewardType: table.rewardType,
    securityCriteria: table.securityCriteria,
    delayed: table.delayed,
    quantity: lookupRewardQuantity(table, playerCount),
  }));
}

module.exports = { REWARD_TYPE, SECURITY_CRITERIA, SECURITY_BANDS, validateRewardTable,
  validateRewardGroup, lookupRewardQuantity, evaluateGroupReward };
