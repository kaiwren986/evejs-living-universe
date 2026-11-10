"use strict";

// Adapted from Locksmith Coffee Edition (AGPL-3.0).
// Discovery's token and permanent receipt commit in one account-owner write.
// The receipt survives redemption, so retries and restarts cannot mint another
// token. projectDiscoveryGrant selects the existing durable redeem-owner saga,
// which delivers through item custody into the station chosen by the pilot.
const TABLE = "newEdenStoreRuntime";
const LOCAL_REDEEM_TOKEN_BASE = 700000000;
const RECEIPT_KEY_PATTERN = /^[A-Za-z0-9:._-]{1,96}$/;

function liveDeps() {
  return {
    database: require("../../gameStore"),
    store: require("./storeState"),
    currentFileTime: () => require("../_shared/serviceHelpers").currentFileTime(),
    now: () => Date.now(),
  };
}

const positive = (value) => Number.isSafeInteger(Number(value)) && Number(value) > 0;

// reward: { receiptKey, typeID, quantity?, label?, description?,
// blueprintRuns? } (blueprintRuns > 0 claims a copy with those runs;
// omitted claims an ordinary item). Returns
// { accountID, tokenID, duplicate } or throws; a throw after the write (the
// flush) is safe to retry, the receipt making the retry a duplicate.
function grantOnce(characterID, reward, deps = liveDeps()) {
  const key = String(reward && reward.receiptKey || "");
  const typeID = Number(reward && reward.typeID);
  const quantity = reward && reward.quantity !== undefined ? Number(reward.quantity) : 1;
  const blueprintRuns = reward && reward.blueprintRuns !== undefined ? Number(reward.blueprintRuns) : 0;
  if (!positive(characterID) || !RECEIPT_KEY_PATTERN.test(key) || !positive(typeID) || !positive(quantity) ||
      (blueprintRuns !== 0 && !positive(blueprintRuns))) {
    throw new Error("REWARD_TOKEN_INVALID");
  }
  const accountID = Number(deps.store.resolveCharacterAccountID(characterID)) || 0;
  if (!positive(accountID)) throw new Error(`REWARD_TOKEN_NO_ACCOUNT ${characterID}`);
  const account = deps.store.readRuntimeAccount(accountID);
  const receipts = account.rewardTokenReceipts || {};
  const prior = receipts[key] || null;
  let tokenID = prior ? Number(prior.tokenID) || 0 : 0;
  if (prior && (prior.typeID !== typeID || prior.quantity !== quantity ||
      prior.characterID !== Number(characterID) || (prior.blueprintRuns || 0) !== blueprintRuns)) {
    throw new Error("REWARD_TOKEN_RECEIPT_CONFLICT");
  }
  if (!prior) {
    tokenID = Math.max(LOCAL_REDEEM_TOKEN_BASE, Number(account.campaignTokenSequence) || 0, ...account.redeemTokens.flatMap((token) =>
      [Number(token.tokenID) || 0, Number(token.massTokenID) || 0])) + 1;
    if (!Number.isSafeInteger(tokenID) || tokenID > 2147483647) throw new Error("REWARD_TOKEN_ID_LIMIT");
    const token = {
      tokenID, massTokenID: tokenID, typeID, quantity,
      stationID: 0, dateTime: deps.currentFileTime().toString(), expireDateTime: "0",
      label: String(reward.label || ""), description: String(reward.description || ""),
      available: true, addedByContext: 0, addedByExtra: `reward-token:${key}`,
      projectDiscoveryGrant: {grantID:key, version:1},
      ...(blueprintRuns > 0 ? { blueprintRuns } : {}),
    };
    const result = deps.store.writeRewardAccount(accountID, {
      ...account,
      campaignTokenSequence:tokenID,
      redeemTokens: [...account.redeemTokens, token],
      rewardTokenReceipts: { ...receipts,
        [key]: { tokenID, typeID, quantity, blueprintRuns, characterID: Number(characterID), grantedAtMs: deps.now() } },
    });
    if (!result || !result.success) throw new Error(`REWARD_TOKEN_WRITE_FAILED: ${(result && result.errorMsg) || "WRITE_FAILED"}`);
  }
  // Also flush on retry: an earlier write may have landed in memory while its
  // flush failed.
  const flushed = deps.database.flushTableSync(TABLE);
  if (!flushed || !flushed.success) throw new Error(`REWARD_TOKEN_FLUSH_FAILED: ${(flushed && flushed.errorMsg) || "FLUSH_FAILED"}`);
  return { accountID, tokenID, duplicate: Boolean(prior) };
}

function hasReceipt(characterID, receiptKey, deps = liveDeps()) {
  const accountID = Number(deps.store.resolveCharacterAccountID(characterID)) || 0;
  if (!positive(accountID)) return false;
  return Boolean((deps.store.readRuntimeAccount(accountID).rewardTokenReceipts || {})[String(receiptKey)]);
}

module.exports = { LOCAL_REDEEM_TOKEN_BASE, RECEIPT_KEY_PATTERN, grantOnce, hasReceipt };
