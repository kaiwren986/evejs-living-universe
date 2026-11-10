"use strict";

// Adapted from Locksmith's Wars — Coffee Edition (AGPL-3.0). Keep declaration
// recovery in the existing player authorities; nation and pact hooks are omitted.
const { randomUUID } = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");
const database = require("../../gameStore");
const { throwWrappedUserError } = require("../../common/machoErrors");
const { currentFileTime } = require("../_shared/serviceHelpers");
const { requireWarAuthority } = require("./warAuthority");
const { requireOwnedWarHeadquarters } = require("./warHeadquartersAuthority");
const { getCorporationRecord, getAllianceRecord, isNpcCorporationID } = require("./corporationState");
const { cloneValue, ensureRuntimeInitialized, updateRuntimeState } = require("./corporationRuntimeState");

const TABLE = "corporationRuntime";
const WEEK = 6048000000000n;
const FEE = 100000000;
const DURABLE_DECLARATION_JOB_TYPE = "war-declaration.settle";
const lanes = new Map();
let durableScheduler = null;

function deny() { throwWrappedUserError("CrpAccessDenied"); }
function positiveID(value) {
  if (!["number", "string", "bigint"].includes(typeof value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}
function checked(result) {
  if (result?.success !== true) throw Error("WAR_DECLARATION_PERSISTENCE_PENDING");
}
function commitRuntime() { checked(database.flushTableSync(TABLE)); }
function readDeclarations() {
  commitRuntime();
  return cloneValue(ensureRuntimeInitialized().warDeclarations || {});
}
function validate(row, ownerID) {
  if (!row || row.schemaVersion !== 1 || row.ownerID !== Number(ownerID) ||
      ![row.ownerID, row.characterID, row.payerCorporationID, row.targetID].every(id => Number.isSafeInteger(id) && id > 0) ||
      row.ownerID === row.targetID || typeof row.operationID !== "string" || !row.operationID ||
      !["pending", "complete", "rejected"].includes(row.status) || typeof row.feeApplied !== "boolean" ||
      row.warHQ !== null && !positiveID(row.warHQ) ||
      row.billID !== null && !positiveID(row.billID) || row.warID !== null && !positiveID(row.warID)) {
    throw Error("WAR_DECLARATION_STATE_INVALID");
  }
  const time = BigInt(row.timeDeclared);
  if (time <= 0n || BigInt(row.dueDateTime) !== time + WEEK ||
      row.status === "complete" && (!row.feeApplied || !row.billID || !row.warID)) {
    throw Error("WAR_DECLARATION_STATE_INVALID");
  }
  return row;
}
function save(row) {
  validate(row, row.ownerID);
  checked(updateRuntimeState(table => ({ ...cloneValue(table),
    warDeclarations: { ...(table.warDeclarations || {}), [row.ownerID]: cloneValue(row) },
  })));
  commitRuntime();
  const persisted = database.readPersisted(TABLE, `/warDeclarations/${row.ownerID}`);
  if (persisted?.success !== true || !isDeepStrictEqual(persisted.data, row)) {
    throw Error("WAR_DECLARATION_NOT_DURABLE");
  }
  return row;
}
function serialized(ownerID, action) {
  const prior = lanes.get(ownerID) || Promise.resolve();
  const pending = prior.catch(() => null).then(action);
  lanes.set(ownerID, pending);
  return pending.finally(() => { if (lanes.get(ownerID) === pending) lanes.delete(ownerID); });
}
function unfinished(war, now) {
  try {
    const finish = war.timeFinished == null ? 0n : BigInt(String(war.timeFinished));
    return finish <= 0n || finish > now;
  } catch (_) { return true; }
}

function requireDeclarationTarget(ownerID, value, operations) {
  const targetID = positiveID(value);
  if (!targetID || ownerID === targetID) deny();
  const corporation = getCorporationRecord(targetID);
  const alliance = corporation ? null : getAllianceRecord(targetID);
  if (corporation) {
    if (corporation.deleted || corporation.isNPC !== false || isNpcCorporationID(targetID) ||
        positiveID(corporation.allianceID)) deny();
  } else if (!alliance || alliance.deleted || alliance.closurePendingAtMs) deny();

  const now = currentFileTime();
  for (const war of require("./warRuntimeState").listWarsForOwner(ownerID)) {
    if ([Number(war.declaredByID), Number(war.againstID)].includes(targetID) &&
        [Number(war.declaredByID), Number(war.againstID)].includes(ownerID) && unfinished(war, now)) deny();
  }
  // An opposing declaration may already have paid but not yet created its war.
  for (const [key, row] of Object.entries(operations)) {
    validate(row, key);
    if (row.status === "pending" && row.ownerID === targetID && row.targetID === ownerID) deny();
  }
  if (process.env.EVEJS_WAR_PEACE_TREATIES_ENABLED === "1") {
    for (const treaty of Object.values(ensureRuntimeInitialized().peaceTreaties || {})) {
      if (Number(treaty.ownerID) !== ownerID || Number(treaty.otherOwnerID) !== targetID) continue;
      let expiry;
      try { expiry = BigInt(String(treaty.expiryDate)); }
      catch (_) { deny(); }
      // A malformed restriction cannot authorize another declaration.
      if (expiry <= 0n || expiry > now) deny();
    }
  }
  return targetID;
}

async function schedule(row) {
  if (!durableScheduler || row.status !== "pending") return;
  await durableScheduler.schedule({
    jobID: `war-declaration:${row.operationID}`, type: DURABLE_DECLARATION_JOB_TYPE,
    dueAtMs: Date.now(), payload: { ownerID: row.ownerID, operationID: row.operationID },
  });
}

async function settleInternal(original) {
  let row = validate(original, original.ownerID);
  const warRuntime = require("./warRuntimeState");
  if (row.status === "complete") return warRuntime.getWarRecord(row.warID);
  if (row.status === "rejected") return null;
  if (!row.feeApplied) {
    const fee = await warRuntime.chargeWarDeclarationFee({
      payerCorporationID: row.payerCorporationID, againstID: row.targetID,
      commandID: `war-declaration:${row.operationID}:fee`,
    });
    if (fee?.fingerprintMismatch === true) throw Error("WAR_DECLARATION_FEE_RECEIPT_CONFLICT");
    if (fee?.success !== true) {
      if (fee?.errorMsg === "INSUFFICIENT_FUNDS") {
        save({ ...row, status: "rejected" });
        throwWrappedUserError("NotEnoughMoneyCorp", fee.userError || {});
      }
      throw Error(fee?.errorMsg || "WAR_DECLARATION_FEE_PENDING");
    }
    if (fee.data?.corporationID !== row.payerCorporationID || fee.data?.accountKey !== 1000 ||
        fee.data?.delta !== -FEE) throw Error("WAR_DECLARATION_FEE_RECEIPT_CONFLICT");
    // Local wallet commands commit in this table. In process mode the wallet
    // authority has committed its own ledger before returning the exact result.
    commitRuntime();
    row = save({ ...row, feeApplied: true });
  }
  const bill = require("../account/billRuntimeState").createBill({
    billTypeID: 4, amount: FEE, debtorID: row.ownerID, creditorID: 1000125,
    externalID: row.targetID, externalID2: -1, dueDateTime: row.dueDateTime,
    creationKey: `war-declaration:${row.operationID}:bill`, requireDurable: true,
  });
  if (!bill || row.billID && row.billID !== bill.billID) throw Error("WAR_DECLARATION_BILL_PENDING");
  if (!row.billID) row = save({ ...row, billID: bill.billID });
  const war = warRuntime.createWarRecord({
    declaredByID: row.ownerID, againstID: row.targetID, warHQ: row.warHQ,
    billID: row.billID, declaredByCharacterID: row.characterID, timeDeclared: row.timeDeclared,
    creationKey: `war-declaration:${row.operationID}:war`, requireDurable: true,
  });
  if (!war || row.warID && row.warID !== war.warID) throw Error("WAR_DECLARATION_WAR_PENDING");
  save({ ...row, warID: war.warID, status: "complete" });
  return war;
}

function declareWar(session, target, hq, { allianceOnly = false } = {}) {
  const initialAuthority = requireWarAuthority(session);
  return serialized(initialAuthority.warEntityID, async () => {
    const authority = requireWarAuthority(session);
    if (authority.warEntityID !== initialAuthority.warEntityID ||
        allianceOnly && !authority.allianceID) deny();
    const ownerID = authority.warEntityID, targetID = positiveID(target);
    if (!targetID) deny();
    // This check remains before payment, including on retries from a player.
    const warHQ = requireOwnedWarHeadquarters(authority, hq);
    const operations = readDeclarations();
    const prior = operations[ownerID] ? validate(operations[ownerID], ownerID) : null;
    const matches = prior && prior.targetID === targetID && prior.warHQ === warHQ;
    if (prior?.status === "pending") {
      if (!matches) throw Error("WAR_DECLARATION_ALREADY_PENDING");
      await schedule(prior);
      return settleInternal(prior);
    }
    if (matches && prior.status === "complete") {
      const war = require("./warRuntimeState").getWarRecord(prior.warID);
      if (!war) throw Error("WAR_DECLARATION_WAR_MISSING");
      if (unfinished(war, currentFileTime())) return war;
    }
    requireDeclarationTarget(ownerID, targetID, operations);
    const now = currentFileTime();
    const row = save({ schemaVersion: 1, operationID: randomUUID(), ownerID,
      characterID: authority.characterID, payerCorporationID: authority.corporationID,
      targetID, warHQ, timeDeclared: now.toString(), dueDateTime: (now + WEEK).toString(),
      status: "pending", feeApplied: false, billID: null, warID: null });
    await schedule(row);
    return settleInternal(row);
  });
}

function settleDeclaration(ownerID) {
  return serialized(ownerID, () => {
    const row = readDeclarations()[ownerID];
    return row ? settleInternal(validate(row, ownerID)) : null;
  });
}
function listPendingDeclarations() {
  return Object.entries(readDeclarations()).map(([key, row]) => validate(row, key))
    .filter(row => row.status === "pending");
}
function bindDurableScheduler(scheduler) {
  if (typeof scheduler?.schedule !== "function") throw TypeError("war declaration scheduler requires schedule");
  durableScheduler = scheduler;
}
function unbindDurableScheduler(scheduler = null) {
  if (!scheduler || scheduler === durableScheduler) durableScheduler = null;
}
async function reconcileDurableWarDeclarations() {
  const pending = listPendingDeclarations();
  for (const row of pending) await schedule(row);
  return { scheduled: pending.length };
}
async function handleDurableWarDeclaration(job) {
  const ownerID = positiveID(job.payload?.ownerID);
  if (!ownerID) throw Error("WAR_DECLARATION_JOB_INVALID");
  return serialized(ownerID, async () => {
    const row = readDeclarations()[ownerID];
    if (!row || row.operationID !== job.payload.operationID || row.status !== "pending") return;
    try { await settleInternal(validate(row, ownerID)); }
    catch (error) {
      if (readDeclarations()[ownerID]?.status !== "rejected") throw error;
    }
  });
}

module.exports = { declareWar, settleDeclaration, listPendingDeclarations, bindDurableScheduler,
  unbindDurableScheduler, reconcileDurableWarDeclarations, handleDurableWarDeclaration,
  DURABLE_DECLARATION_JOB_TYPE };
