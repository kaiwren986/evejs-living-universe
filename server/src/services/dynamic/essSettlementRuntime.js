"use strict";

const { createDurableSchedulerBinding } = require("../_shared/durableSchedulerBinding");
const repository = require("./essRepository");
const state = require("./dynamicResourceState");
const { buildDict } = require("../_shared/serviceHelpers");
const { createHash, randomUUID } = require("node:crypto");
const LINK_OWNER_ID = randomUUID(), spaceAttachments = new WeakMap();
function createLinkIdentity(session) {
  const attachment = session?._space;
  if (!attachment || typeof attachment !== "object") return null;
  if (!spaceAttachments.has(attachment)) spaceAttachments.set(attachment, randomUUID());
  return { ownerInstanceID: LINK_OWNER_ID, attachmentID: spaceAttachments.get(attachment) };
}
const binding = createDurableSchedulerBinding();
const JOB_TYPE = "ess.settlement";
let lane = Promise.resolve();
function cents(amount) {
  const value = Math.round(Number(amount) * 100);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("ESS_AMOUNT_INVALID");
  return value;
}
function notify(systemID, name, payload, characterID = 0) {
  for (const session of require("../chat/sessionRegistry").getSessions()) {
    if (Number(session.solarsystemid2 || session.solarsystemid) !== Number(systemID) ||
        characterID && Number(session.characterID || session.charid) !== characterID) continue;
    try { session.sendNotification?.(name, "clientID", payload); }
    catch (_error) { /* State and receipts remain authoritative after disconnect. */ }
  }
}
function changed(systemID) {
  notify(systemID, "OnSystemESSDataChanged", [systemID, state.buildEssDataPayload(state.getSystemState(systemID))]);
}
function splitBounty(systemID, gross) {
  const total = cents(gross), bank = state.getSystemState(systemID);
  if (!bank?.essID) return { playerAmount: total / 100, essMainBankAmount: 0, reserveBankAmount: 0 };
  const cut = Math.round(total * state.DEFAULT_DYNAMIC_RESOURCE_SETTINGS.bountiesCut);
  const main = Math.round(cut * state.DEFAULT_DYNAMIC_RESOURCE_SETTINGS.mainBankPayRatio);
  return { playerAmount: (total - cut) / 100, essMainBankAmount: main / 100, reserveBankAmount: (cut - main) / 100 };
}
async function schedule(systemID, kind, dueAtMs, generation = "") {
  if (!binding.get()) return;
  await binding.get().schedule({ jobID: `ess:${systemID}:${kind}:${generation}:${dueAtMs}`, type: JOB_TYPE,
    dueAtMs, payload: { systemID, kind, generation } });
}
async function scheduleSystem(systemID) {
  const bank = state.getSystemState(systemID);
  if (!bank) return;
  if (bank.autopayAtMs) await schedule(systemID, "autopay", bank.autopayAtMs);
  await require("./essReserveRuntime").scheduleSystem(bank);
  await require("./dynamicBountyRuntime").scheduleSystem(bank);
  if (bank.mainBankLink) await schedule(systemID, "link", Math.min(state.now() + 1000,
    filetimeMs(bank.mainBankLink.completesAt)), bank.mainBankLink.linkID);
}
function filetimeMs(value) { return Number((BigInt(value) - 116444736000000000n) / 10000n); }
async function fundBounty(receiptID, systemID, characterID, amounts) {
  const main = cents(amounts.essMainBankAmount || 0), reserve = cents(amounts.reserveBankAmount || 0);
  const dbs = require("./dynamicBountyRuntime");
  dbs.ensureSystem(systemID);
  if (!main && !reserve && !dbs.eligible(systemID)) return;
  const gross = cents(amounts.grossAmount ?? (main + reserve) / 100);
  const fingerprint = createHash("sha256").update(JSON.stringify([systemID, characterID, main, reserve, gross])).digest("hex");
  const legacyFingerprint = createHash("sha256").update(JSON.stringify([systemID, characterID, main, reserve])).digest("hex");
  repository.mutate(root => {
    const prior = root.funding[receiptID];
    if (prior) {
      if (typeof prior === "string" ? prior !== legacyFingerprint : prior.fingerprint !== fingerprint) throw new Error("ESS_FUNDING_RECEIPT_CONFLICT");
      return;
    }
    if (main || reserve) {
      const bank = root.systems[systemID];
      if (!bank?.essID) throw new Error("ESS_FUNDING_BANK_MISSING");
      bank.mainValue = cents((cents(bank.mainValue) + main) / 100) / 100;
      bank.reserveValue = cents((cents(bank.reserveValue) + reserve) / 100) / 100;
      bank.contributors ||= {};
      bank.contributors[characterID] = (bank.contributors[characterID] || 0) + main;
      if (main && !bank.autopayAtMs) bank.autopayAtMs = state.now() + state.DEFAULT_DYNAMIC_RESOURCE_SETTINGS.autopaymentIntervalSeconds * 1000;
    }
    dbs.recordPaid(root, systemID, gross);
    root.funding[receiptID] = { fingerprint, grossCents: gross };
  });
  await scheduleSystem(systemID);
  changed(systemID);
}
function disconnect(systemID, bankName, characterID, reason = state.UNLINKED_PROXIMITY) {
  const bank = state.getSystemState(systemID);
  if (!bank) return;
  const link = bank.mainBankLink;
  if (bankName === "main") {
    if (!link || link.characterID !== characterID) return;
    bank.mainBankLink = null;
  } else { bank.reserveLinkedCharacterIDs.delete(characterID); if (bank.reserveLinks) delete bank.reserveLinks[characterID]; }
  state.saveSystemState(bank);
  notify(systemID, bankName === "main" ? "OnMainBankPlayerLinkDisconnected" : "OnReserveBankPlayerLinkDisconnected", [buildDict([
    ["solarSystemID", systemID], ["linkID", link?.linkID || ""], ["characterID", characterID], ["reason", reason],
  ])], bankName === "reserve" ? characterID : 0);
  changed(systemID);
}
function linkDisconnectReason(characterID, shipID) {
  const session = require("../chat/sessionRegistry").findSessionByCharacterID(characterID);
  const currentShipID = require("./essEligibility").getSessionShipID(session);
  return currentShipID && currentShipID !== shipID ? state.UNLINKED_SHIP_CHANGE : state.UNLINKED_PROXIMITY;
}
function liveLink(systemID, characterID, shipID, clientID = 0, identity = null) {
  if (identity?.ownerInstanceID !== LINK_OWNER_ID) return false;
  const session = require("../chat/sessionRegistry").findSessionByCharacterID(characterID);
  if (!session || state.getSystemIDFromSession(session) !== systemID || clientID && Number(session.clientID || session.clientId) !== clientID) return false;
  if (identity.attachmentID !== createLinkIdentity(session)?.attachmentID) return false;
  return !require("./essEligibility").validatePresence(session, state.getSystemState(systemID), shipID);
}
function prepareMain(systemID, kind) {
  return repository.mutate(root => {
    const bank = root.systems[systemID];
    if (!bank) return null;
    const link = bank.mainBankLink;
    const id = kind === "theft" ? `ess:${systemID}:theft:${link?.linkID}` : `ess:${systemID}:autopay:${bank.autopayAtMs}`;
    if (root.settlements[id]) return id;
    const amount = cents(bank.mainValue);
    const payments = kind === "theft"
      ? [{ characterID: link.characterID, cents: amount }]
      : Object.entries(bank.contributors || {}).sort(([a], [b]) => Number(a) - Number(b)).map(([characterID, value]) => ({ characterID: Number(characterID), cents: value }));
    if (payments.reduce((sum, entry) => sum + entry.cents, 0) !== amount) throw new Error("ESS_CONTRIBUTOR_CONSERVATION_FAILED");
    root.settlements[id] = { id, systemID, kind, state: "prepared", payments, amount, link, createdAtMs: state.now() };
    bank.mainValue = 0; bank.contributors = {}; bank.autopayAtMs = null;
    if (kind === "theft") bank.mainBankLink = null;
    return id;
  });
}
async function deliver(id) {
  const op = repository.read().settlements[id];
  if (!op || op.state === "completed") return;
  if (op.kind === "reserve") return require("./essReserveRuntime").deliver(op);
  const wallet = require("../account/walletState");
  for (const payment of op.payments) {
    if (!payment.cents) continue;
    const key = `${id}:credit:${payment.characterID}`;
    const result = await wallet.adjustCharacterBalanceAsync(payment.characterID, payment.cents / 100, {
      idempotencyKey: key, entryTypeID: wallet.JOURNAL_ENTRY_TYPE.ESS_MAIN_BANK_AUTOPAYMENT,
      description: op.kind === "theft" ? "ESS main bank theft" : "ESS main bank contributor payout",
      ownerID1: payment.characterID, ownerID2: op.systemID, referenceID: op.systemID,
    }, { commandID: key, source: "ess" });
    repository.check(result);
  }
  repository.mutate(root => {
    root.settlements[id].state = "completed";
    if (op.kind === "theft") {
      const bank = root.systems[op.systemID];
      bank.theftHistoryMain = [{ characterID: op.link.characterID, amount: op.amount / 100,
        linkID: op.link.linkID, lastTheft: (BigInt(op.createdAtMs) * 10000n + 116444736000000000n).toString() }, ...(bank.theftHistoryMain || [])].slice(0, 50);
    }
  });
  if (op.kind === "theft") notify(op.systemID, "OnMainBankPlayerHackSuccess", [buildDict([
    ["solarSystemID", op.systemID], ["linkID", op.link.linkID], ["characterID", op.link.characterID],
  ])]);
  changed(op.systemID);
}
async function maintain(systemID) {
  for (const op of Object.values(repository.read().settlements)) if (op.systemID === systemID && op.state !== "completed") await deliver(op.id);
  require("./dynamicBountyRuntime").maintain(systemID);
  await require("./essReserveRuntime").maintain(systemID);
  let bank = state.getSystemState(systemID);
  if (!bank) return;
  if (bank.mainBankLink && !liveLink(systemID, bank.mainBankLink.characterID, bank.mainBankLink.shipID, bank.mainBankLink.clientID, bank.mainBankLink)) disconnect(systemID, "main", bank.mainBankLink.characterID, linkDisconnectReason(bank.mainBankLink.characterID, bank.mainBankLink.shipID));
  bank = state.getSystemState(systemID);
  const theftDue = bank.mainBankLink ? filetimeMs(bank.mainBankLink.completesAt) : Infinity;
  const autopayDue = bank.autopayAtMs || Infinity;
  if (Math.min(theftDue, autopayDue) <= state.now()) {
    const kind = autopayDue <= theftDue ? "autopay" : "theft";
    const id = prepareMain(systemID, kind);
    await deliver(id);
    // A due autopayment must not leave a second due theft waiting for a query.
    if (kind === "autopay" && theftDue <= state.now()) { const next = prepareMain(systemID, "theft"); await deliver(next); }
  }
  await scheduleSystem(systemID);
}
function runSerialized(callback) {
  const work = lane.catch(() => {}).then(callback);
  lane = work; return work;
}
function handleJob(job) { return runSerialized(() => maintain(Number(job.payload.systemID))); }
async function reconcile() {
  // Scene-dependent links do not survive a missing pilot on cold start;
  // prepared rewards and contributor payouts recover independently.
  require("./dynamicBountyRuntime").recoverLosses();
  for (const bank of state.listSystemStates()) {
    await schedule(bank.solarSystemID, "recover", state.now());
  }
}
module.exports = { JOB_TYPE, splitBounty, fundBounty, scheduleSystem, handleJob, reconcile, disconnect, changed,
  bindDurableScheduler: binding.bind, unbindDurableScheduler: binding.unbind, drain: () => lane,
  linkDisconnectReason, createLinkIdentity, getScheduler: binding.get, runSerialized, synchronize: systemID => runSerialized(() => maintain(systemID)), maintainSystem: maintain, liveLink, schedule, cents,
  setNowProvider: state.setNowProvider, _testing: { cents, filetimeMs } };
