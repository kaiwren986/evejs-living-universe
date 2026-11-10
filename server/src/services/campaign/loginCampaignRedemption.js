"use strict";
const database = require("../../gameStore");
const store = require("../newEdenStore/storeState");
const runtime = require("./loginCampaignRuntime");
const { fingerprint } = require("./loginCampaignCatalog");
const characters = require("../character/characterState");
const items = require("../inventory/itemStore");
const custody = require("../inventory/itemCustody");
const { createDurableSchedulerBinding } = require("../_shared/durableSchedulerBinding");
const binding = createDurableSchedulerBinding(), lanes = new Map();
const JOB_TYPE = "campaign.redeem";
function exclusive(accountID, work) {
  const previous = lanes.get(accountID) || Promise.resolve();
  const next = previous.catch(() => {}).then(work);
  lanes.set(accountID, next);
  return next.finally(() => { if (lanes.get(accountID) === next) lanes.delete(accountID); });
}
function check(result) { if (!result?.success) throw new Error(result?.errorMsg || "CAMPAIGN_DELIVERY_FAILED"); return result; }
function enqueue(accountID, id) {
  return binding.get()?.schedule({ jobID: id, type: JOB_TYPE, dueAtMs: Date.now(), payload: { accountID, id } });
}
function notify(operation, session) {
  const { getCharacterSessions } = require("../raffles/raffleInventory");
  for (const target of getCharacterSessions(operation.characterID, { includeSession: session })) {
    const changes = (operation.result?.changes || []).map(change => {
      const current = items.findItemById(change.item.itemID);
      return { ...change, item: current && Number(current.ownerID) === operation.characterID
        ? current : items.buildRemovedItemNotificationState(change.item) };
    });
    characters.emitItemsChangedBatchForSession(target, changes);
    if (operation.result?.skillpoints) require("../skills/training/skillQueueNotifications").notifyFreeSkillPointsChanged(operation.characterID,
      characters.getCharacterRecord(operation.characterID).freeSkillPoints);
  }
  runtime.notify(session || { userid: operation.accountID });
}
async function settleUnlocked(accountID, id, session) {
  let account = store.readRuntimeAccount(accountID), operation = account.campaignRedemptions?.[id];
  if (!operation) throw new Error("CAMPAIGN_REDEMPTION_NOT_FOUND");
  runtime.flush();
  if (operation.state === "completed") return { success: true, duplicate: true, data: operation.result };
  const character = characters.getCharacterRecord(operation.characterID);
  if (!character || Number(character.accountId) !== accountID) throw new Error("CAMPAIGN_REDEMPTION_OWNER_CHANGED");
  const token = operation.token;
  const sp = require("../user/userService").getSkillPointRedeemAmount(token.typeID) * token.quantity;
  const result = { items: [], changes: [], skillpoints: 0, isk: 0 };
  const expert = require("../skills/expertSystems/expertSystemCatalog").getExpertSystemByTypeID(token.typeID);
  if (expert) {
    check(require("../skills/expertSystems/expertSystemRuntime").installExpertSystemForCharacter(operation.characterID, token.typeID,
      { idempotencyKey: id, durationDays: Math.max(1, Number(expert.durationDays) || 7) * token.quantity,
        sourceItemID: token.tokenID, grantReason: "redeem", session }));
  } else if (sp) {
    check(require("../skills/skillState").grantFreeSkillPointsOnce(operation.characterID, sp, id));
    result.skillpoints = sp;
  } else if (token.typeID === 52996) {
    const credit = await require("../account/walletState").adjustCharacterBalanceAsync(operation.characterID, token.quantity,
      { idempotencyKey: id, referenceID: token.tokenID, description: "Login campaign reward", requireExactCredit: true },
      { source: "campaign-redemption", commandID: `${id}:isk:${operation.attempt || 0}` });
    if (!credit?.success) {
      if (credit?.errorMsg === "WALLET_LIMIT") {
        account = store.readRuntimeAccount(accountID);
        account.campaignRedemptions[id].attempt = (operation.attempt || 0) + 1;
        runtime.save(accountID, account);
      }
      check(credit);
    }
    result.isk = token.quantity;
  } else if (token.typeID === 73277) {
    const lp = require("../corporation/lpWalletState");
    check(lp.adjustCharacterWalletLPBalanceDurable(operation.characterID, lp.EVERMARK_ISSUER_CORP_ID, token.quantity,
      { idempotencyKey: id, reason: "Login campaign reward" }));
  } else {
    const type = items.getItemMetadata(token.typeID);
    const transfer = check(custody.transfer({ items: { typeID: token.typeID, quantity: token.quantity,
      options: { singleton: Number(type.categoryID) === 9 ? token.blueprintRuns > 0 ? 2 : 1 : 0,
        customInfo: token.label || "Login campaign reward" } },
      to: custody.custodyRef.ownerLocation(operation.characterID, operation.destinationID, items.ITEM_FLAGS.HANGAR),
      actor: operation.characterID, reason: custody.CUSTODY_REASON.CAMPAIGN_REWARD_GRANT, idempotencyKey: id }));
    if (!transfer.durable) throw new Error("CAMPAIGN_ITEM_GRANT_NOT_DURABLE");
    result.items = transfer.data.items || [];
    result.changes = transfer.data.changes || [];
    if (Number(type.categoryID) === 9) {
      const industry = require("../industry/industryRuntimeState");
      for (const item of result.items) {
        const stored = database.read("industryBlueprintState", `/records/${item.itemID}`).data;
        if (stored?.campaignGrantID === id) continue;
        if (!stored || token.blueprintRuns > 0) {
          check(industry.initializeBlueprintState(item.itemID, { typeID: token.typeID, original: token.blueprintRuns <= 0,
            runsRemaining: token.blueprintRuns, materialEfficiency: token.blueprintMaterialLevel,
            timeEfficiency: token.blueprintProductivityLevel }));
        }
        check(industry.updateBlueprintState(item.itemID, state => ({ ...state, campaignGrantID: id })));
      }
      check(database.flushTableSync("industryBlueprintState"));
    }
  }
  // Read afresh after async money I/O: a different campaign may have queued a
  // reward meanwhile. Never restore the caller's old queue/account snapshot.
  account = store.readRuntimeAccount(accountID);
  operation = { ...account.campaignRedemptions[id], state: "completed", result };
  account.campaignRedemptions[id] = operation;
  account.redeemTokens = account.redeemTokens.filter(candidate => candidate.campaignGrant?.grantID !== token.campaignGrant.grantID);
  runtime.save(accountID, account);
  notify(operation, session);
  return { success: true, duplicate: false, data: result };
}
function settle(accountID, id) { return exclusive(accountID, () => settleUnlocked(accountID, id)); }
function redeem(accountID, token, characterID, destinationID, session) {
  return exclusive(accountID, async () => {
    const id = `campaign:${fingerprint([accountID, token.campaignGrant.grantID])}`;
    const account = store.readRuntimeAccount(accountID), existing = account.campaignRedemptions?.[id];
    if (existing) {
      if (existing.characterID !== characterID) return { success: false, errorMsg: "CAMPAIGN_REDEMPTION_BOUND_TO_CHARACTER" };
      return settleUnlocked(accountID, id, session);
    }
    const current = account.redeemTokens.find(candidate => candidate.tokenID === token.tokenID && candidate.campaignGrant?.grantID === token.campaignGrant.grantID);
    const character = characters.getCharacterRecord(characterID);
    if (!current || !character || Number(character.accountId) !== accountID) return { success: false, errorMsg: "CAMPAIGN_REDEMPTION_UNAUTHORIZED" };
    const sp = require("../user/userService").getSkillPointRedeemAmount(current.typeID) * current.quantity;
    if (sp > 10000000 || current.soulbound || current.available === false) return { success: false, errorMsg: "CAMPAIGN_REWARD_UNSUPPORTED" };
    const virtual = sp > 0 || [52996, 73277].includes(current.typeID) || require("../skills/expertSystems/expertSystemCatalog").isExpertSystemType(current.typeID);
    if (!virtual && !destinationID) return { success: false, errorMsg: "RedeemNoDestination" };
    account.campaignRedemptions ||= {};
    if (Object.keys(account.campaignRedemptions).length >= 8192) return { success: false, errorMsg: "CAMPAIGN_REDEMPTION_LIMIT" };
    account.campaignRedemptions[id] = { id, state: "pending", accountID, characterID, destinationID,
      token: current, attempt: 0 };
    runtime.save(accountID, account);
    if (binding.get()) await enqueue(accountID, id);
    return settleUnlocked(accountID, id, session);
  });
}
async function reconcile() {
  const root = database.read("newEdenStoreRuntime", "/");
  if (!root.success) throw new Error(root.errorMsg);
  for (const [key, account] of Object.entries(root.data?.accounts || {})) for (const operation of Object.values(account.campaignRedemptions || {})) {
    if (operation.state !== "pending") continue;
    if (Number(key) !== operation.accountID) throw new Error("CAMPAIGN_REDEMPTION_IDENTITY_MISMATCH");
    if (binding.get()) await enqueue(operation.accountID, operation.id);
    else await settle(operation.accountID, operation.id);
  }
}
module.exports = { JOB_TYPE, redeem, settle, reconcile, bindDurableScheduler: binding.bind,
  unbindDurableScheduler: binding.unbind, handleJob: job => settle(job.payload.accountID, job.payload.id) };
