"use strict";

// Pure configuration validation: it must not import the game store at startup.
function validateLoginCampaigns(value) {
  if (!Array.isArray(value) || value.length > 64) throw new Error("loginCampaigns must be an array of at most 64 campaigns");
  const ids = new Set();
  return value.map(row => {
    if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error("Invalid login campaign");
    const allowed = ["id", "version", "kind", "enabled", "startsAt", "endsAt", "graceDays", "turnoverHourUTC", "audience", "rookieMaxAgeDays", "repeat", "rewards", "priority"];
    if (Object.keys(row).some(key => !allowed.includes(key))) throw new Error("Unknown login campaign option");
    if (!Number.isSafeInteger(row.id) || row.id <= 0 || row.id === 2187 || ids.has(row.id)) throw new Error("Campaign IDs must be unique positive integers; 2187 is reserved");
    ids.add(row.id);
    if (!Number.isInteger(row.version) || row.version < 1 || !["daily", "seasonal"].includes(row.kind)) throw new Error("Campaign kind/version required");
    if (typeof row.enabled !== "boolean") throw new Error("Campaign enabled must be boolean");
    if (row.kind === "seasonal" && row.id !== 2356) throw new Error("Seasonal campaign is not verified in the supported client's catalog");
    for (const name of ["startsAt", "endsAt"]) {
      if (typeof row[name] !== "string" || !/Z$/.test(row[name]) || !Number.isFinite(Date.parse(row[name])) ||
          new Date(row[name]).toISOString().slice(0, 19) !== row[name].slice(0, 19)) throw new Error(`Campaign ${name} must be a valid ISO UTC timestamp`);
    }
    if (Date.parse(row.endsAt) <= Date.parse(row.startsAt)) throw new Error("Campaign endsAt must follow startsAt");
    const next = { graceDays: 0, turnoverHourUTC: 11, audience: "all", repeat: false, priority: 0, ...row };
    if (!Number.isInteger(next.turnoverHourUTC) || next.turnoverHourUTC < 0 || next.turnoverHourUTC > 23 ||
        !Number.isInteger(next.graceDays) || next.graceDays < 0 || next.graceDays > 30 ||
        !Number.isInteger(next.priority) || Math.abs(next.priority) > 1000 || typeof next.repeat !== "boolean") throw new Error("Invalid campaign reset, grace, priority or repeat policy");
    if (!["all", "alpha", "omega", "rookie"].includes(next.audience)) throw new Error("Invalid campaign audience");
    if (next.audience === "rookie" && (!Number.isInteger(next.rookieMaxAgeDays) || next.rookieMaxAgeDays < 1 || next.rookieMaxAgeDays > 365)) throw new Error("Rookie campaign requires rookieMaxAgeDays from 1 to 365");
    if (next.kind === "seasonal") {
      if (next.rewards || next.repeat || next.audience !== "all" || next.turnoverHourUTC !== 11) throw new Error("Seasonal rewards and reset come from the verified client catalog");
    } else {
      if (!Array.isArray(next.rewards) || next.rewards.length < 1 || next.rewards.length > 365) throw new Error("Daily campaigns require 1 to 365 rewards");
      next.rewards = next.rewards.map(reward => {
        if (!reward || Object.keys(reward).some(key => !["typeID", "quantity", "blueprintRuns", "blueprintMaterialLevel", "blueprintProductivityLevel"].includes(key))) throw new Error("Invalid campaign reward fields");
        if (!Number.isInteger(reward.typeID) || reward.typeID <= 0 || !Number.isInteger(reward.quantity) || reward.quantity < 1 || reward.quantity > 2147483647) throw new Error("Invalid campaign reward typeID/quantity");
        for (const key of ["blueprintRuns", "blueprintMaterialLevel", "blueprintProductivityLevel"]) {
          if (reward[key] !== undefined && (!Number.isInteger(reward[key]) || reward[key] < 0 || reward[key] > (key === "blueprintRuns" ? 1000000 : key === "blueprintMaterialLevel" ? 10 : 20))) throw new Error("Invalid campaign blueprint metadata");
        }
        return { ...reward };
      });
    }
    return next;
  });
}
module.exports = { validateLoginCampaigns };
