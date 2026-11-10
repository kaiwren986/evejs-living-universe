"use strict";

const repository = require("./essRepository");
const banks = require("./dynamicResourceState");
const policy = require("./dynamicBountyPolicy");
const { buildDict } = require("../_shared/serviceHelpers");
const queued = new WeakMap();
function settings() { return { ...banks.DEFAULT_DYNAMIC_RESOURCE_SETTINGS, ...policy.CONTROL_SETTINGS }; }
function eligible(systemID) {
  const system = banks.getStaticSolarSystem(systemID);
  // Published DBS coverage includes lowsec. Wormholes, private hosts and
  // Pochven do not inherit this ordinary-space policy from negative security.
  return Boolean(system && Number(system.solarSystemID) < 31000000 && Number(system.solarSystemID) >= 30000000 &&
    Number(system.regionID) !== 10000070 && Number(system.security) < 0.45);
}
function project(bank, now = banks.now()) {
  if (!bank?.dbs?.active) return bank;
  const next = structuredClone(bank), model = next.dbs, config = settings();
  const target = Math.max(model.periodIndex, Math.floor((now - model.activatedAtMs) / (config.timeIntervalSeconds * 1000)));
  let cursor = model.periodIndex, output = policy.clamp(Number(next.currentOutput), config);
  for (const index of Object.keys(model.periods).map(Number).filter(index => index >= cursor && index < target).sort((a, b) => a - b)) {
    output = policy.idle(output, index - cursor, config);
    output = policy.step(output, model.periods[index], config);
    delete model.periods[index]; cursor = index + 1;
  }
  output = policy.idle(output, target - cursor, config);
  next.currentOutput = Number(output.toFixed(12)); model.periodIndex = target;
  model.nextAtMs = model.activatedAtMs + (target + 1) * config.timeIntervalSeconds * 1000;
  return next;
}
function getOutput(systemID) {
  if (!eligible(systemID)) return { output: 1, active: false };
  const bank = banks.getSystemState(systemID);
  return { output: bank?.dbs?.active ? project(bank).currentOutput : settings().equilibriumValue, active: true };
}
function queueSystem(bank) {
  const owner = require("./essSettlementRuntime"), scheduler = owner.getScheduler();
  if (!scheduler || !bank?.dbs?.active) return;
  let boundaries = queued.get(scheduler);
  if (!boundaries) { boundaries = new Set(); queued.set(scheduler, boundaries); }
  const key = `${bank.solarSystemID}:${bank.dbs.nextAtMs}`;
  if (boundaries.has(key)) return;
  boundaries.add(key);
  void scheduleSystem(bank).catch(error => {
    boundaries.delete(key);
    require("../../utils/logger").warn(`[DBS] scheduling system=${bank.solarSystemID}: ${error.message}`);
  });
}
function ensureSystem(systemID) {
  if (!eligible(systemID)) return null;
  let bank = banks.getSystemState(systemID);
  if (!bank?.dbs?.active) {
    const records = require("../killmail/killmailState").getAllKillmailRecords();
    const at = banks.now();
    bank = banks.setSystemState(systemID, { ...bank, currentOutput: policy.clamp(Number(bank?.currentOutput || settings().equilibriumValue), settings()),
      dbs: { active: true, activatedAtMs: at, activationKillID: records.reduce((max, record) => Math.max(max, Number(record.killID) || 0), 0),
        periodIndex: 0, nextAtMs: at + settings().timeIntervalSeconds * 1000, periods: {} } });
  }
  queueSystem(bank); return bank;
}
function addInput(bank, kind, amountCents, atMs) {
  const model = bank.dbs;
  const period = Math.max(model.periodIndex, Math.floor((atMs - model.activatedAtMs) / (settings().timeIntervalSeconds * 1000)));
  const input = model.periods[period] ||= { paidCents: 0, lossCents: 0 };
  const total = input[kind] + amountCents;
  if (!Number.isSafeInteger(total) || total < 0) throw new Error("DBS_INPUT_OVERFLOW");
  input[kind] = total;
}
function recordPaid(root, systemID, grossCents) {
  const bank = root.systems[systemID];
  if (bank?.dbs?.active) addInput(bank, "paidCents", grossCents, banks.now());
}
function qualifyingLoss(record) {
  if (!record || !(record.victimCharacterID > 0) || !(record.finalCharacterID > 0) ||
      Number(record.victimCharacterID) === Number(record.finalCharacterID) || !(record.iskLost > 0) || !eligible(record.solarSystemID)) return false;
  const type = require("../inventory/itemStore").getItemMetadata(record.victimShipTypeID);
  return Number(type?.categoryID) === 6 && Number(type?.groupID) !== 29;
}
function stampLossRecord(record) {
  if (!qualifyingLoss(record)) return;
  ensureSystem(record.solarSystemID);
  record.dbsInputAtMs ??= banks.now();
}
function recordLoss(record) {
  if (!qualifyingLoss(record)) return false;
  const bank = banks.getSystemState(record.solarSystemID);
  if (!bank?.dbs?.active || Number(record.killID) <= bank.dbs.activationKillID) return false;
  const id = String(record.killID);
  if (repository.read().losses[id]) return false;
  repository.mutate(root => {
    if (root.losses[id]) return;
    const value = require("./essSettlementRuntime").cents(record.iskLost);
    addInput(root.systems[record.solarSystemID], "lossCents", value, Number(record.dbsInputAtMs || banks.now()));
    root.losses[id] = { systemID: Number(record.solarSystemID), cents: value };
  });
  queueSystem(banks.getSystemState(record.solarSystemID)); return true;
}
function recoverLosses(systemID = null) {
  const root = repository.read();
  const active = Object.values(root.systems).filter(bank => bank.dbs?.active && (!systemID || Number(bank.solarSystemID) === Number(systemID)));
  if (!active.length) return;
  const watermark = Math.min(...active.map(bank => bank.dbs.activationKillID));
  for (const record of require("../killmail/killmailState").getAllKillmailRecords()) {
    if (Number(record.killID) > watermark && !root.losses[String(record.killID)] && (!systemID || Number(record.solarSystemID) === Number(systemID))) recordLoss(record);
  }
}
function maintain(systemID) {
  let bank = banks.getSystemState(systemID);
  if (!bank?.dbs?.active || bank.dbs.nextAtMs > banks.now()) return;
  recoverLosses(systemID);
  bank = banks.getSystemState(systemID);
  banks.saveSystemState(project(bank));
  require("./essSettlementRuntime").changed(systemID);
  for (const session of require("../chat/sessionRegistry").getSessions()) if (banks.getSystemIDFromSession(session) === Number(systemID)) {
    try { session.sendNotification?.("OnSystemDynamicBountyStateChanged", "clientID", [Number(systemID), require("../_shared/serviceHelpers").buildMarshalReal(banks.getSystemState(systemID).currentOutput)]); } catch (_error) { /* Reconnect reads the committed multiplier. */ }
  }
}
async function scheduleSystem(bank) {
  if (bank?.dbs?.active) await require("./essSettlementRuntime").schedule(bank.solarSystemID, "dbs", bank.dbs.nextAtMs, String(bank.dbs.activatedAtMs));
}
function buildMapPayload() {
  const { readStaticRows, TABLE } = require("../_shared/referenceData");
  const states = new Map(banks.listSystemStates().map(bank => [Number(bank.solarSystemID), bank]));
  return buildDict(readStaticRows(TABLE.SOLAR_SYSTEMS).filter(system => Number(system.solarSystemID) < 31000000 &&
    Number(system.solarSystemID) >= 30000000 && Number(system.regionID) !== 10000070 && Number(system.security) < 0.45)
    .map(system => { const bank = states.get(Number(system.solarSystemID)); return [Number(system.solarSystemID), bank?.dbs?.active ? project(bank).currentOutput : settings().equilibriumValue]; }));
}
module.exports = { eligible, ensureSystem, getOutput, project, recordPaid, qualifyingLoss, stampLossRecord, recordLoss, recoverLosses, maintain, scheduleSystem, buildMapPayload };
