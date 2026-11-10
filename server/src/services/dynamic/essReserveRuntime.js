"use strict";

const { randomUUID } = require("node:crypto");
const repository = require("./essRepository");
const banks = require("./dynamicResourceState");
const eligibility = require("./essEligibility");
const custody = require("../inventory/itemCustody");
const inventory = require("../inventory/itemStore");
const { resolveSessionCharacterID } = require("../_shared/sessionIdentity");
const BOND_TYPES = [55932, 55933, 55930, 55931];
function coordinator() { return require("./essSettlementRuntime"); }
function filetime(ms) { return (BigInt(Math.trunc(ms)) * 10000n + 116444736000000000n).toString(); }
function notifyItems(characterID, result) {
  // Replays also repair a lost notification, using current custody rather than
  // the historical item location/quantity stored in the grant receipt.
  const changes = (result.data?.changes || []).map(change => ({ ...change,
    item: inventory.findItemById(change.item?.itemID) || change.item }));
  require("../raffles/raffleInventory").notifyInventoryChangesToCharacter(characterID, changes);
}
function pulsePayout(pulse, total, settings = banks.DEFAULT_DYNAMIC_RESOURCE_SETTINGS) {
  if (pulse < 1 || pulse > total) return 0;
  // dynamicresources/common/ess/formulas.py, build 3396210. Policy parameters
  // are server settings; the formula itself is shipped in the client.
  const size = total / settings.reserveWindowAccessFactor;
  return Math.round((settings.reserveBankMaxPayout * (pulse < size
    ? (pulse / size) ** settings.reservePayoutExponentLead
    : (size / pulse) ** settings.reservePayoutExponentTail) + settings.reservePayoutPaddingValue) * 100);
}
function bondPlan(amountCents) {
  let remaining = amountCents;
  const denominations = BOND_TYPES.map(typeID => ({ typeID, value: coordinator().cents(inventory.getItemMetadata(typeID)?.basePrice || 0) }))
    .sort((a, b) => b.value - a.value);
  if (denominations.some(row => row.value <= 0)) throw new Error("ESS_BOND_AUTHORITY_UNAVAILABLE");
  const grants = [];
  for (const bond of denominations) {
    const quantity = Math.floor(remaining / bond.value);
    if (quantity) { grants.push({ typeID: bond.typeID, quantity }); remaining -= quantity * bond.value; }
  }
  return { grants, amount: amountCents - remaining };
}
function settleUnlock(id) {
  const op = repository.read().unlocks[id];
  if (!op || op.state !== "prepared") return op;
  const result = custody.transfer({ items: { itemID: op.itemID, quantity: 1 },
    from: custody.custodyRef.ownerLocation(op.characterID, op.shipID, inventory.ITEM_FLAGS.CARGO_HOLD),
    to: custody.custodyRef.void(), actor: op.characterID,
    reason: custody.CUSTODY_REASON.ESS_KEY_CONSUME, idempotencyKey: id });
  if (!result.success) {
    if (result.ambiguous) throw new Error(result.errorMsg || "ESS_KEY_CUSTODY_PENDING");
    repository.mutate(root => { Object.assign(root.unlocks[id], { state: "refused", errorMsg: result.errorMsg }); });
    return repository.read().unlocks[id];
  }
  repository.mutate(root => {
    const bank = root.systems[op.systemID];
    if (bank.reserveWindowID !== id) throw new Error("ESS_RESERVE_WINDOW_CONFLICT");
    root.unlocks[id].state = "opened";
    Object.assign(bank, { reserveBankPulsesTotal: op.pulses, reserveBankPulsesRemaining: op.pulses,
      reserveUnlockerCharacterID: op.characterID, reserveBankLastPulseInitiated: filetime(op.startedAtMs), nextPulseAtMs: op.startedAtMs + banks.DEFAULT_DYNAMIC_RESOURCE_SETTINGS.reservePulseIntervalSeconds * 1000,
      reserveLinkedCharacterIDs: [], reserveLinks: {} });
  });
  notifyItems(op.characterID, result);
  coordinator().changed(op.systemID);
  return repository.read().unlocks[id];
}
function requestUnlock(session, keyTypeID) {
  const systemID = banks.getSystemIDFromSession(session), characterID = resolveSessionCharacterID(session);
  return coordinator().runSerialized(async () => {
    await coordinator().maintainSystem(systemID);
    const bank = banks.getSystemState(systemID), shipID = eligibility.getSessionShipID(session);
    if (!characterID || eligibility.validateEssLinkEligibility(session, bank, "reserve")) return { success: false, errorMsg: "ESS_LINK_FORBIDDEN" };
    if (bank.reserveBankPulsesRemaining > 0) return { success: false, errorMsg: "ESS_RESERVE_ALREADY_OPEN" };
    if (!banks.listReserveKeyTypeIDsForSystem(systemID).includes(keyTypeID)) return { success: false, errorMsg: "ESS_KEY_WRONG_REGION" };
    const ship = inventory.findItemById(shipID);
    if (!ship || Number(ship.ownerID) !== characterID || Number(ship.flagID) !== 0 || Number(ship.locationID) !== systemID) return { success: false, errorMsg: "ESS_SHIP_NOT_CONTROLLED" };
    const key = inventory.listContainerItems(characterID, shipID, inventory.ITEM_FLAGS.CARGO_HOLD, [keyTypeID])
      .filter(item => Number(item.quantity) >= 1).sort((a, b) => Number(a.itemID) - Number(b.itemID))[0];
    if (!key) return { success: false, errorMsg: "ESS_KEY_NOT_IN_CARGO" };
    const id = `ess:key:${randomUUID()}`;
    repository.mutate(root => {
      root.unlocks[id] = { id, state: "prepared", characterID, systemID, shipID, itemID: Number(key.itemID), keyTypeID,
        pulses: banks.getReserveKeyTotalPulses(keyTypeID), startedAtMs: banks.now() };
      root.systems[systemID].reserveWindowID = id;
    });
    const result = settleUnlock(id);
    await coordinator().scheduleSystem(systemID);
    return { success: result?.state === "opened", errorMsg: result?.errorMsg, state: banks.getSystemState(systemID) };
  });
}
function link(session) {
  const systemID = banks.getSystemIDFromSession(session), characterID = resolveSessionCharacterID(session);
  return coordinator().runSerialized(async () => {
    await coordinator().maintainSystem(systemID);
    const bank = banks.getSystemState(systemID);
    const errorMsg = eligibility.validateEssLinkEligibility(session, bank, "reserve");
    if (errorMsg || !bank?.reserveBankPulsesRemaining) return { success: false, errorMsg: errorMsg || "ESS_RESERVE_CLOSED" };
    bank.reserveLinkedCharacterIDs.add(characterID);
    bank.reserveLinks ||= {};
    bank.reserveLinks[characterID] = { ...coordinator().createLinkIdentity(session), shipID: eligibility.getSessionShipID(session), clientID: Number(session.clientID || session.clientId || 0) };
    banks.saveSystemState(bank);
    await coordinator().scheduleSystem(systemID);
    return { success: true, state: bank };
  });
}
function preparePulse(systemID) {
  return repository.mutate(root => {
    const bank = root.systems[systemID], pulse = bank.reserveBankPulsesTotal - bank.reserveBankPulsesRemaining + 1;
    const id = `${bank.reserveWindowID}:pulse:${pulse}`;
    if (root.settlements[id]) return id;
    const linked = [...bank.reserveLinkedCharacterIDs].sort((a, b) => a - b);
    const budget = Math.min(coordinator().cents(bank.reserveValue), pulsePayout(pulse, bank.reserveBankPulsesTotal));
    let amount = 0;
    const payments = linked.map((characterID, index) => {
      const share = Math.floor(budget / linked.length) + (index < budget % linked.length ? 1 : 0);
      const plan = bondPlan(share); amount += plan.amount;
      return { characterID, shipID: bank.reserveLinks[characterID].shipID, ...plan };
    });
    root.settlements[id] = { id, systemID, kind: "reserve", state: "prepared", payments, amount, createdAtMs: bank.nextPulseAtMs };
    bank.reserveValue = (coordinator().cents(bank.reserveValue) - amount) / 100;
    bank.reserveBankPulsesRemaining--;
    bank.reserveBankLastPulseInitiated = filetime(bank.nextPulseAtMs);
    bank.nextPulseAtMs += banks.DEFAULT_DYNAMIC_RESOURCE_SETTINGS.reservePulseIntervalSeconds * 1000;
    return id;
  });
}
function deliver(op) {
  for (const payment of op.payments) for (const grant of payment.grants) {
    const result = custody.transfer({ items: { ...grant, options: { singleton: 0 } },
      to: custody.custodyRef.ownerLocation(payment.characterID, payment.shipID, inventory.ITEM_FLAGS.CARGO_HOLD),
      actor: payment.characterID, reason: custody.CUSTODY_REASON.ESS_BOND_GRANT,
      idempotencyKey: `${op.id}:bond:${payment.characterID}:${grant.typeID}` });
    repository.check(result); notifyItems(payment.characterID, result);
  }
  repository.mutate(root => {
    if (root.settlements[op.id].state === "completed") return;
    root.settlements[op.id].state = "completed";
    const bank = root.systems[op.systemID];
    const rows = op.payments.filter(payment => payment.amount).map(payment => ({ characterID: payment.characterID, amount: payment.amount / 100, lastTheft: filetime(op.createdAtMs) }));
    bank.theftHistoryReserve = [...rows, ...(bank.theftHistoryReserve || [])].slice(0, 50);
  });
  coordinator().changed(op.systemID);
}
async function maintain(systemID) {
  let bank = banks.getSystemState(systemID);
  if (!bank) return;
  const op = repository.read().unlocks[bank.reserveWindowID];
  if (op?.state === "prepared") settleUnlock(op.id);
  bank = banks.getSystemState(systemID);
  for (const characterID of bank.reserveLinkedCharacterIDs) {
    const link = bank.reserveLinks?.[characterID];
    if (!link || !coordinator().liveLink(systemID, characterID, link.shipID, link.clientID, link)) coordinator().disconnect(systemID, "reserve", characterID, coordinator().linkDisconnectReason(characterID, link?.shipID));
  }
  bank = banks.getSystemState(systemID);
  while (bank.reserveBankPulsesRemaining > 0 && bank.nextPulseAtMs <= banks.now()) {
    const id = preparePulse(systemID);
    deliver(repository.read().settlements[id]);
    bank = banks.getSystemState(systemID);
  }
  if (bank.reserveBankPulsesRemaining === 0 && bank.reserveLinkedCharacterIDs.size) {
    for (const characterID of bank.reserveLinkedCharacterIDs) coordinator().disconnect(systemID, "reserve", characterID, 0);
  }
}
async function scheduleSystem(bank) {
  const owner = coordinator();
  if (bank.reserveBankPulsesRemaining > 0 && bank.nextPulseAtMs) {
    await owner.schedule(bank.solarSystemID, "pulse", bank.nextPulseAtMs, bank.reserveWindowID);
    if (bank.reserveLinkedCharacterIDs.size) await owner.schedule(bank.solarSystemID, "reserve-links", Math.min(banks.now() + 1000, bank.nextPulseAtMs), bank.reserveWindowID);
  }
  const op = repository.read().unlocks[bank.reserveWindowID];
  if (op?.state === "prepared") await owner.schedule(bank.solarSystemID, "unlock", banks.now(), op.id);
}
module.exports = { requestUnlock, link, settleUnlock, deliver, maintain, scheduleSystem, pulsePayout, bondPlan };
