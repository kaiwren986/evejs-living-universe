"use strict";

const { TABLE, readStaticTable } = require("../_shared/referenceData");
const { resolveItemByTypeID } = require("../inventory/itemTypeRegistry");
const { getTypeList } = require("../inventory/typeListAuthority");
const { getWallclockNowMs } = require("../../space/runtime/runtimeClock");
const { buildDict, buildKeyVal, buildList, buildObjectEx1 } = require("../_shared/serviceHelpers");
const log = require("../../utils/logger");

const snapshots = new WeakMap();
const positive = (value) => Number.isSafeInteger(value) && value > 0;
const nonnegative = (value) => Number.isSafeInteger(value) && value >= 0;
const OPTIONAL_LIST_FIELDS = ["bannedModulesTypeListID", "limitedAmountOfModulesTypeListID"];
const LABEL_FIELDS = ["eventNameID", "eventDescriptionID", "filamentDescriptionID",
  "restrictionsDescriptionID", "rewardsHintID", "shipRestrictionsHintID", "rulesHintID"];

// The target client changes event dates at downtime: start inclusive, end
// exclusive, both at 11:00 UTC. Invalid calendar days never roll into a month.
function parseEventDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number(value.slice(0, 4)) < 1) return null;
  const ms = Date.parse(value + "T11:00:00.000Z");
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value ? ms : null;
}
function duplicateIDs(rows, field) {
  const seen = new Set(), duplicates = new Set();
  for (const row of rows) if (positive(row?.[field])) {
    if (seen.has(row[field])) duplicates.add(row[field]);
    seen.add(row[field]);
  }
  return duplicates;
}
function validateMatch(row) {
  if (!row || !positive(row.matchTypeID) || !positive(row.filamentTypeID) ||
    resolveItemByTypeID(row.filamentTypeID)?.groupID !== 4050 ||
    ![row.fleetSize, row.numberOfFleets, row.minimumQueueSizeMultiplier, row.shipRestrictions,
      row.provingGroundLootTableID].every(positive) || !getTypeList(row.shipRestrictions) ||
    ![row.moduleAndImplantMetaLevelRestrictions, row.maxOfShipTypeRestriction,
      row.maxOfShipGroupRestriction, row.numberOfLimitedModules].every(nonnegative) ||
    !LABEL_FIELDS.every((field) => positive(row[field])) ||
    !OPTIONAL_LIST_FIELDS.every((field) => row[field] == null || (positive(row[field]) && getTypeList(row[field]))) ||
    !Array.isArray(row.rewards) || !row.rewards.every((reward) => positive(reward?.typeID) &&
      positive(reward.amount) && resolveItemByTypeID(reward.typeID))) return null;
  return { ...structuredClone(row), bannedModulesTypeListID: row.bannedModulesTypeListID ?? null,
    limitedAmountOfModulesTypeListID: row.limitedAmountOfModulesTypeListID ?? null };
}
function buildSnapshot(payload) {
  const matches = Array.isArray(payload.matchTypes) ? payload.matchTypes : [];
  const dates = Array.isArray(payload.eventSchedules) ? payload.eventSchedules : [];
  const duplicateMatches = duplicateIDs(matches, "matchTypeID");
  const duplicateSchedules = duplicateIDs(dates, "scheduleID");
  const matchMap = new Map(), events = [], rejected = [];
  for (const row of matches) {
    const match = validateMatch(row);
    if (!match || duplicateMatches.has(match.matchTypeID)) rejected.push({ kind: "match", id: row?.matchTypeID ?? null });
    else matchMap.set(match.matchTypeID, match);
  }
  for (const row of dates) {
    const startAtMs = parseEventDate(row?.startDate), endAtMs = parseEventDate(row?.endDate);
    const match = matchMap.get(row?.matchTypeID);
    if (!positive(row?.scheduleID) || duplicateSchedules.has(row.scheduleID) || !match ||
      startAtMs === null || endAtMs === null || endAtMs <= startAtMs ||
      ![0, 1].includes(row.QA) || !["ccp", "optic"].includes(row.region)) {
      rejected.push({ kind: "schedule", id: row?.scheduleID ?? null }); continue;
    }
    events.push({ ...match, scheduleID: row.scheduleID, startDate: row.startDate,
      endDate: row.endDate, region: row.region, QA: row.QA, startAtMs, endAtMs });
  }
  events.sort((a, b) => a.startAtMs - b.startAtMs || a.scheduleID - b.scheduleID);
  if (rejected.length) log.warn(`[PvpFilaments] Rejected ${rejected.length} invalid or duplicate authored records`);
  return { events, rejected };
}
function snapshot() {
  const payload = readStaticTable(TABLE.CLIENT_PVP_FILAMENTS);
  if (!snapshots.has(payload)) snapshots.set(payload, buildSnapshot(payload));
  return snapshots.get(payload);
}
function listAllEvents() {
  return structuredClone(snapshot().events.filter((event) => event.region === "ccp"));
}
function isEventActive(event, nowMs = getWallclockNowMs()) {
  // QA is catalog provenance, never an always-on production admission bypass.
  return Boolean(event && event.region === "ccp" && event.QA === 0 &&
    Number.isFinite(nowMs) && event.startAtMs <= nowMs && nowMs < event.endAtMs);
}
function listActiveEvents(nowMs = getWallclockNowMs()) {
  return listAllEvents().filter((event) => isEventActive(event, nowMs));
}
function getMostRecentEvent(nowMs = getWallclockNowMs()) {
  return listAllEvents().filter((event) => event.QA === 0 && event.endAtMs <= nowMs)
    .sort((a, b) => b.endAtMs - a.endAtMs || b.scheduleID - a.scheduleID)[0] || null;
}
function getNextEventDate(nowMs = getWallclockNowMs()) {
  return listAllEvents().find((event) => event.QA === 0 && event.endAtMs > nowMs)?.startDate || null;
}
function getActiveEventByFilamentTypeID(typeID, nowMs = getWallclockNowMs()) {
  if (!positive(typeID)) return null;
  return listActiveEvents(nowMs).find((event) => event.filamentTypeID === typeID) || null;
}
function getEvent(matchTypeID, scheduleID) {
  if (!positive(matchTypeID) || !positive(scheduleID)) return null;
  return listAllEvents().find((event) => event.matchTypeID === matchTypeID && event.scheduleID === scheduleID) || null;
}
function buildPythonDate(value) {
  if (parseEventDate(value) === null) return null;
  const [year, month, day] = value.split("-").map(Number);
  // A datetime.date the way the client's own marshal writes one: the class by
  // name and its four state bytes, which the client passes back to the class.
  return buildObjectEx1("datetime.date", [
    { type: "bytes", value: Buffer.from([year >>> 8, year & 255, month, day]) },
  ]);
}
function buildEventPayload(event) {
  return buildKeyVal([
    ...["matchTypeID", "scheduleID", "filamentTypeID", "numberOfFleets", "fleetSize", "shipRestrictions",
      ...LABEL_FIELDS, "QA", "moduleAndImplantMetaLevelRestrictions", "maxOfShipTypeRestriction",
      "maxOfShipGroupRestriction", "minimumQueueSizeMultiplier", "provingGroundLootTableID",
      ...OPTIONAL_LIST_FIELDS, "numberOfLimitedModules"].map((field) => [field, event[field]]),
    ["rewards", buildList(event.rewards.map((reward) => buildKeyVal([["typeID", reward.typeID], ["amount", reward.amount]])))],
    ["startDate", buildPythonDate(event.startDate)], ["endDate", buildPythonDate(event.endDate)],
  ]);
}
function buildEventDict(events) {
  return buildDict(events.map((event) => [`${event.matchTypeID}_${event.scheduleID}`, buildEventPayload(event)]));
}
module.exports = { parseEventDate, isEventActive, listAllEvents, listActiveEvents, getMostRecentEvent,
  getNextEventDate, getActiveEventByFilamentTypeID, getEvent, buildPythonDate, buildEventPayload, buildEventDict,
  getDiagnostics: () => structuredClone(snapshot().rejected),
  _testing: { buildSnapshot } };
