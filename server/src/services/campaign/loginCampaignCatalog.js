"use strict";
const { createHash } = require("node:crypto");
const config = require("../../config");
const database = require("../../gameStore");
const { validateLoginCampaigns } = require("../../config/loginCampaigns");
const { resolveItemByTypeID } = require("../inventory/itemTypeRegistry");
const election = require("./gallenteElectionLoginRewards.json");
const schedule = require("../seasons/eventSchedule");
const DAY_MS = 86400000, PYTHON_ORDINAL = 719163;
const fingerprint = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function validateRewards(row) {
  for (const reward of row.rewards || row.days.flatMap(day => [day.alpha, day.omega])) {
    const type = resolveItemByTypeID(reward.typeID);
    if (!type || !Number.isSafeInteger(reward.quantity) || reward.quantity < 1) throw new Error(`Invalid campaign reward ${reward.typeID}`);
    const sp = require("../user/userService").getSkillPointRedeemAmount(reward.typeID) * reward.quantity;
    if (sp > 10000000) throw new Error(`Campaign reward ${reward.typeID} exceeds supported fulfillment limits`);
    if ((reward.blueprintRuns || reward.blueprintMaterialLevel || reward.blueprintProductivityLevel) && Number(type.categoryID) !== 9) throw new Error("Campaign blueprint metadata on a non-blueprint");
    if (reward.blueprintRuns && reward.quantity !== 1) throw new Error("Campaign blueprint copies must have quantity 1");
    if (!reward.blueprintRuns && (reward.blueprintMaterialLevel || reward.blueprintProductivityLevel)) throw new Error("Researched original blueprints are not a supported campaign reward");
  }
  return { ...row, fingerprint: fingerprint(row) };
}
function list() {
  const definitions = validateLoginCampaigns(config.loginCampaigns || []);
  const legacyRewards = Array.isArray(config.dailyLoginRewards) && config.dailyLoginRewards.length
    ? config.dailyLoginRewards : [{ typeID: 49810, quantity: 1 }];
  const daily = validateRewards({ id: 2187, version: 1, kind: "daily", legacy: true,
    enabled: config.dailyLoginRewardsEnabled !== false, audience: "all", priority: -1001,
    repeat: true, turnoverHourUTC: 11, graceDays: 0, startsAtMs: 0, endsAtMs: 8640000000000000,
    rewards: Array.from({ length: 15 }, (_, i) => ({ ...legacyRewards[i % legacyRewards.length] })) });
  const event = schedule.get(schedule.LOGIN);
  const seasonal = { id: election.campaignID, version: 1, kind: "seasonal", legacy: true,
    enabled: config.campaignTrailEnabled === true && event?.enabled === true,
    audience: "all", priority: 0, repeat: false, turnoverHourUTC: 11, graceDays: 0,
    startsAtMs: event?.startsAtMs || 0, endsAtMs: event?.endsAtMs || 0,
    days: election.days, retroClaim: election.retroClaim };
  const rows = definitions.map(row => validateRewards({ ...row,
    startsAtMs: Date.parse(row.startsAt), endsAtMs: Date.parse(row.endsAt),
    ...(row.kind === "seasonal" ? { days: election.days, retroClaim: election.retroClaim } : {}) }));
  if (!rows.some(row => row.id === election.campaignID)) rows.push(validateRewards(seasonal));
  return [daily, ...rows].sort((a, b) => b.priority - a.priority || a.id - b.id);
}
function ordinal(nowMs, row) { return Math.floor((nowMs - row.turnoverHourUTC * 3600000) / DAY_MS) + PYTHON_ORDINAL; }
function active(row, nowMs) { return row.enabled && nowMs >= row.startsAtMs && nowMs < row.endsAtMs + row.graceDays * DAY_MS; }
function eligibility(row, accountID, nowMs, enrolled = false) {
  if (row.audience === "all") return { eligible: true, source: "all" };
  if (row.audience !== "rookie") {
    const grade = new (require("../subscription/subscriptionMgrService"))().Handle_GetCloneGrade([], { userid: accountID });
    return { eligible: grade === (row.audience === "omega" ? 1 : 0), source: "clone-grade", grade };
  }
  if (enrolled) return { eligible: true, source: "earned-enrollment" };
  // Use the oldest actual character, so creating an alt does not reset age.
  const dates = Object.values(database.read("characters", "/").data || {}).filter(character => Number(character.accountId) === accountID)
    .map(character => { try { return Number((BigInt(character.createDateTime) - 116444736000000000n) / 10000n); } catch (_) { return NaN; } })
    .filter(value => Number.isFinite(value) && value <= nowMs);
  const createdAtMs = dates.length ? Math.min(...dates) : null;
  return { eligible: createdAtMs !== null && nowMs - createdAtMs < row.rookieMaxAgeDays * DAY_MS,
    source: "oldest-character", createdAtMs };
}
function select(kind, accountID, nowMs, progress = {}) {
  if (!Number.isSafeInteger(accountID) || accountID <= 0) return null;
  return list().find(row => row.kind === kind && active(row, nowMs) && eligibility(row, accountID, nowMs,
    Boolean(progress[`${row.id}:${row.version}`]?.eligibility?.eligible)).eligible) || null;
}
module.exports = { DAY_MS, PYTHON_ORDINAL, fingerprint, list, select, ordinal, active, eligibility };
