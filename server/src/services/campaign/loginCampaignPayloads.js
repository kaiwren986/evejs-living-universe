"use strict";
const { buildKeyVal, buildDict, buildFiletimeLong } = require("../_shared/serviceHelpers");
const catalog = require("./loginCampaignCatalog");
function reward(value, day, row) {
  return buildKeyVal([
    ["typeID", value.typeID], ["blueprintProductivityLevel", value.blueprintProductivityLevel ?? null],
    ["blueprintMaterialLevel", value.blueprintMaterialLevel ?? null],
    ["labelMessageID", row.id === 2187 ? 598040 + day : 598041],
    ["tier", day === row.rewards.length ? 4 : 1], ["quantity", value.quantity], ["icon", null],
    ...(value.blueprintRuns ? [["blueprintRuns", value.blueprintRuns]] : []),
  ]);
}
function daily(model, nowMs) {
  if (!model) return null;
  const { row, progress } = model, day = progress.day || 0, length = row.rewards.length;
  const currentOrdinal = catalog.ordinal(nowMs, row);
  const claimed = progress.lastOrdinal !== null && progress.lastOrdinal >= currentOrdinal;
  const exhausted = !row.repeat && day >= length;
  const startMs = (currentOrdinal - catalog.PYTHON_ORDINAL) * catalog.DAY_MS + row.turnoverHourUTC * 3600000;
  const nextMs = exhausted ? row.endsAtMs + row.graceDays * catalog.DAY_MS : claimed
    ? (Math.max(currentOrdinal, progress.lastOrdinal) + 1 - catalog.PYTHON_ORDINAL) * catalog.DAY_MS + row.turnoverHourUTC * 3600000
    : startMs;
  return { staticData: buildKeyVal([
    ["campaign_duration", length], ["subtitleMessageID", 598039], ["campaign_id", row.id], ["titleMessageID", 598040],
    ["is_rookie_campaign", row.legacy || row.audience === "rookie"],
    ["windowHeaderBackgroundNarrow", "res:/UI/Texture/classes/LoginCampaign/backgrounds/dliBackground.png"],
    ["windowHeaderBackgroundWide", "res:/UI/Texture/classes/LoginCampaign/backgrounds/dliBackground.png"],
    ["item_rewards_by_day", buildDict(row.rewards.map((value, index) => [index + 1, reward(value, index + 1, row)]))],
  ]), bucket: buildKeyVal([["bucketID", 4], ["fill_level", day / length], ["next_fill_level", Math.min(day + 1, length) / length]]),
  item: buildKeyVal([["next_reward_index", day >= length && row.repeat ? 1 : day + 1],
    ["num_claimed_rewards", day], ["next_reward_timestamp", buildFiletimeLong(BigInt(nextMs) * 10000n + 116444736000000000n)]]) };
}
function dailyState(model, nowMs) {
  const payload = daily(model, nowMs);
  return payload ? buildKeyVal([["static_data", payload.staticData], ["bucket_progress", payload.bucket], ["item_progress", payload.item]]) : null;
}
function dailyClaim(model, nowMs) {
  if (!model) return null;
  const payload = daily(model, nowMs);
  return [reward(model.grants[0].reward, model.progress.day, model.row), payload.item, null, payload.bucket];
}
function seasonalTuple(model) {
  return model ? [model.row.id,
    Math.floor((model.row.endsAtMs + model.row.graceDays * catalog.DAY_MS) / catalog.DAY_MS) + catalog.PYTHON_ORDINAL,
    `${String(model.row.turnoverHourUTC).padStart(2, "0")}:00:00`,
    Math.max(0, model.row.days.length - Object.keys(model.progress.history).length)] : [null, null, null, null];
}
module.exports = { daily, dailyState, dailyClaim, seasonalTuple };
