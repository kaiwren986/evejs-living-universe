"use strict";

// Character state owns the frozen settlement intent. The wallet authority
// commits each leg with a permanent receipt, allowing a retry between legs.
const wallet = require("./walletState");
const corporationWallet = require("../corporation/corpWalletState");
const characters = require("../character/characterState");
const corporations = require("../corporation/corporationState");
const store = require("../../gameStore");
const { MAX_WALLET_BALANCE } = require("./walletBalanceLimit");
const money = (value) => Math.round(value * 100) / 100;

async function grantTaxedIskOnce(characterID, amount, actionKey, giverID, recovery = {}) {
  if (!Number.isSafeInteger(amount) || amount < 0 || amount > 1e9 || !Number.isSafeInteger(giverID) || giverID <= 0 || !/^nodegraph:[a-f0-9]{64}$/.test(actionKey)) return { success: false, errorMsg: "INVALID_NODEGRAPH_REWARD" };
  let record = characters.getCharacterRecord(characterID);
  if (!record) return { success: false, errorMsg: "CHARACTER_NOT_FOUND" };
  let settlement = record.nodeGraphRewardSettlements?.[actionKey];
  if (settlement && (settlement.amount !== amount || settlement.giverID !== giverID)) return { success: false, errorMsg: "IDEMPOTENCY_KEY_REUSED" };
  if (!settlement) {
    if (Object.keys(record.nodeGraphRewardSettlements || {}).length >= 8192) return { success: false, errorMsg: "NODEGRAPH_REWARD_RECEIPT_LIMIT" };
    const corporationID = Number(record.corporationID);
    const corporation = corporations.getCorporationRecord(corporationID);
    if (!corporation) return { success: false, errorMsg: "CORPORATION_NOT_FOUND" };
    const rate = Number(corporation.taxRate || 0);
    if (!Number.isFinite(rate) || rate < 0 || rate > 1) return { success: false, errorMsg: "CORPORATION_TAX_INVALID" };
    const tax = money(amount * rate);
    settlement = { amount, giverID, corporationID, rate, tax, pilotAmount: money(amount - tax) };
    const locked = characters.updateCharacterRecord(characterID, (current) => ({ ...current, nodeGraphRewardSettlements: { ...(current.nodeGraphRewardSettlements || {}), [actionKey]: settlement } }));
    if (!locked.success) return locked;
  }
  const durableIntent = store.flushTableSync("characters");
  if (!durableIntent.success) return durableIntent;
  // This job belongs to the accepted settlement, not the graph's lifetime.
  // Stop, skip and scene departure cannot strand a paid pilot leg.
  if (settlement.status !== "complete") await recovery.prepare?.(characterID, actionKey);
  record = characters.getCharacterRecord(characterID);
  const projection = require("./walletAuthorityProjection").getCharacterProjection(characterID);
  if (!(projection || record).nodeGraphWalletReceipts?.[actionKey] && wallet.getCharacterWallet(characterID).balance + settlement.pilotAmount > MAX_WALLET_BALANCE) return { success: false, errorMsg: "WALLET_LIMIT" };
  if (!corporationWallet.getCorporationWalletDivision(settlement.corporationID, 1000)?.nodeGraphRewardReceipts?.[actionKey] && corporationWallet.getCorporationWalletBalance(settlement.corporationID, 1000) + settlement.tax > MAX_WALLET_BALANCE) return { success: false, errorMsg: "CORPORATION_WALLET_LIMIT" };
  const refused = (result, leg) => {
    // A definitive capacity refusal has an authority command receipt too.
    // Persist a new attempt only after receiving that refusal; an ambiguous
    // transport failure must retain its command ID for exact replay.
    if (["WALLET_LIMIT", "NODEGRAPH_TAX_AMOUNT_INVALID"].includes(result.errorMsg)) {
      const updated = characters.updateCharacterRecord(characterID, current => {
        const settlements = { ...(current.nodeGraphRewardSettlements || {}) };
        settlements[actionKey] = { ...settlements[actionKey], [`${leg}Attempt`]: Number(settlements[actionKey][`${leg}Attempt`] || 0) + 1 };
        return { ...current, nodeGraphRewardSettlements: settlements };
      });
      if (!updated.success) return updated;
      const durable = store.flushTableSync("characters");
      if (!durable.success) return durable;
    }
    return result;
  };
  const pilot = await wallet.adjustCharacterBalanceAsync(characterID, settlement.pilotAmount, { idempotencyKey: actionKey, description: "AIR reward", entryTypeID: 11, ownerID1: giverID, ownerID2: characterID }, { commandID: `${actionKey}:pilot:${settlement.pilotAttempt || 0}` });
  if (!pilot.success) return refused(pilot, "pilot");
  const durablePilot = store.flushTableSync("characters");
  if (!durablePilot.success) return durablePilot;
  const tax = await corporationWallet.adjustCorporationWalletDivisionBalanceAsync(settlement.corporationID, 1000, settlement.tax, { nodeGraphRewardKey: actionKey, nodeGraphRewardAmount: settlement.tax, description: "AIR reward corporation tax", ownerID1: characterID }, { commandID: `${actionKey}:tax:${settlement.taxAttempt || 0}` });
  if (!tax.success) return refused(tax, "tax");
  const durableTax = store.flushTableSync("corporationRuntime");
  if (!durableTax.success) return durableTax;
  const completed = characters.updateCharacterRecord(characterID, current => ({ ...current,
    nodeGraphRewardSettlements: { ...(current.nodeGraphRewardSettlements || {}), [actionKey]: { ...current.nodeGraphRewardSettlements[actionKey], status: "complete" } },
  }));
  if (!completed.success) return completed;
  const durableCompletion = store.flushTableSync("characters");
  if (!durableCompletion.success) return durableCompletion;
  await recovery.finish?.(characterID, actionKey);
  return { success: true, duplicate: pilot.duplicate === true && tax.duplicate === true, settlement: { ...settlement, status: "complete" } };
}

module.exports = { grantTaxedIskOnce };
