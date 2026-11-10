"use strict";

const database = require("../../gameStore");
const store = require("../newEdenStore/storeState");
const { currentFileTime } = require("../_shared/serviceHelpers");
const catalog = require("./campaignTrailCatalog");
const TABLE = "newEdenStoreRuntime";

// The receipt and redeem token share one durable account write. Receipts remain
// after redemption, so retries (including after a process restart) cannot mint
// another ship if saving the character's progress was interrupted.
function grantOnce(session, characterID, reward) {
  const accountID = Number(session.userid || session.userID || session.accountID ||
    store.resolveCharacterAccountID(characterID));
  if (!Number.isSafeInteger(accountID) || accountID <= 0) return false;
  const account = store.readRuntimeAccount(accountID);
  const key = `${catalog.SEASON_ID}:${characterID}:${reward.receiptKey ?? reward.points}`;
  if (!account.campaignTrailRewards[key]) {
    const tokenID = Math.max(700000000, ...account.redeemTokens.flatMap((token) =>
      [Number(token.tokenID) || 0, Number(token.massTokenID) || 0])) + 1;
    const token = {
      tokenID, massTokenID: null, typeID: reward.typeID, quantity: reward.quantity ?? 1,
      stationID: 0, dateTime: currentFileTime().toString(), expireDateTime: "0",
      label: reward.label || `Campaign Trail: ${reward.points} points`,
      description: `${reward.name} reward for earning ${reward.points} Campaign Trail points.`,
      available: true, addedByContext: 0, addedByExtra: null,
    };
    const result = store.writeRewardAccount(accountID, {
      ...account,
      redeemTokens: [...account.redeemTokens, token],
      campaignTrailRewards: { ...account.campaignTrailRewards, [key]: { tokenID, typeID: reward.typeID } },
    });
    store.resetStoreCaches();
    if (!result.success) throw new Error(`Campaign Trail reward write failed: ${result.errorMsg}`);
  }
  // Also flush on retry: a previous write may have succeeded in memory while
  // its flush failed. Never mark the character reward delivered before this.
  const flushed = database.flushTableSync(TABLE);
  if (!flushed.success) throw new Error(`Campaign Trail reward flush failed: ${flushed.errorMsg}`);
  return true;
}

function hasReceipt(session, characterID, reward) {
  const accountID = Number(session.userid || session.userID || session.accountID || store.resolveCharacterAccountID(characterID));
  if (!Number.isSafeInteger(accountID) || accountID <= 0) return false;
  const key = `${catalog.SEASON_ID}:${characterID}:${reward.receiptKey ?? reward.points}`;
  return Boolean(store.readRuntimeAccount(accountID).campaignTrailRewards[key]);
}
module.exports = { grantOnce, hasReceipt };
