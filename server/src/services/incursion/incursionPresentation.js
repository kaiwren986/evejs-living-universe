"use strict";

const { buildDict, buildKeyVal, buildFiletimeLong } = require("../_shared/serviceHelpers");
function isEnabled(tale) {
  // The preview profile is confined to runner-attested stores. Organic admission
  // remains closed in 8C; copying a fixture into a live store cannot enable it.
  return Boolean(tale?.policy?.presentation?.enabled &&
    (!tale.policy.testOnly || process.env.EVEJS_TEST_STORE_ISOLATED === "1"));
}
function isPrepared(tale) { return isEnabled(tale) && tale.publication?.preparedRevision === tale.revision; }
function influenceData(tale) {
  return buildKeyVal([
    ["influence", tale.influence.value],
    ["lastUpdated", buildFiletimeLong(116444736000000000n + BigInt(tale.influence.lastUpdatedAtMs) * 10000n)],
    ["graceTime", tale.influence.graceMinutes], ["decayRate", tale.influence.decayPerHour],
  ]);
}
function effectDicts(tale) { return tale.policy.presentation.effects.map(effect => buildDict(Object.entries(effect))); }
function report(tale) {
  const p = tale.policy.presentation;
  return { taleID: tale.taleID, templateClassID: 2, templateNameID: p.templateNameID,
    stagingSolarSystemID: tale.placement.stagingSolarSystemID, aggressorFactionID: 500019,
    state: tale.phase, influence: tale.influence.value,
    lastUpdated: buildFiletimeLong(116444736000000000n + BigInt(tale.influence.lastUpdatedAtMs) * 10000n),
    graceTime: tale.influence.graceMinutes, decayRate: tale.influence.decayPerHour,
    hasFinalEncounter: tale.boss.available, effects: effectDicts(tale),
    rewardGroupID: tale.poolGroupID, incursedSystems: tale.placement.systems.map(row => row.solarSystemID),
    systems: tale.placement.systems.map(row => ({ locationID: row.solarSystemID, sceneType: row.sceneType })),
    severity: 4, hasChat: p.hasChat, chatAnnouncementMessageId: p.chatAnnouncementMessageId };
}
function taleKeyVal(tale, solarSystemID) {
  const p = tale.policy.presentation, role = tale.placement.systems.find(row => row.solarSystemID === solarSystemID);
  if (!role || !isPrepared(tale) || tale.terminal) return null;
  return buildKeyVal([
    ["templateClassID", 2], ["templateNameID", p.templateNameID], ["taleID", tale.taleID],
    ["locationID", solarSystemID], ["severity", role.sceneType], ["visualEffect", p.visualEffect],
    ["incursedSystems", tale.placement.systems.map(row => row.solarSystemID)],
    ["hasFinalEncounter", tale.boss.available], ["hasChat", p.hasChat],
    ["chatAnnouncementMessageId", p.chatAnnouncementMessageId],
    ["influenceData", influenceData(tale)], ["effects", effectDicts(tale)],
  ]);
}
function getTales() { return require("./incursionLifecycle").listTales().filter(isPrepared); }
function activeTales() { return getTales().filter(tale => !tale.terminal); }
function forSystem(systemID) {
  return activeTales().find(tale => tale.placement.systems.some(row => row.solarSystemID === Number(systemID))) || null;
}
function buildSystemTalesDict(systemID, taleIDs = null) {
  const observed = require("../tale/observedTaleData").buildObservedTalesDict(systemID, taleIDs);
  const selected = Array.isArray(taleIDs) && taleIDs.length ? new Set(taleIDs.map(Number)) : null;
  const dynamic = activeTales().filter(tale => (!selected || selected.has(tale.taleID)))
    .map(tale => [tale.taleID, taleKeyVal(tale, Number(systemID))]).filter(([, value]) => value);
  return buildDict([...observed.entries, ...dynamic]);
}
module.exports = { isEnabled, isPrepared, influenceData, report, taleKeyVal, getTales, activeTales, forSystem, buildSystemTalesDict };
