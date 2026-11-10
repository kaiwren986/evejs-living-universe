"use strict";

const { createHash } = require("node:crypto");
const database = require("../../gameStore");
const characters = require("../character/characterState");
const store = require("../newEdenStore/storeState");
const { getWallclockNowMs } = require("../../space/runtime/runtimeClock");
const { resolveItemByTypeID } = require("../inventory/itemTypeRegistry");
const settlement = require("./careerRewardSettlement");

const MAX_CLAIMS = 8192;
const MAX_QUANTITY = 2147483647;
const lanes = new Map();
let noticePublisher = null;
const clone = value => JSON.parse(JSON.stringify(value));
const receiptID = value => `career:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
const claimID = (characterID, goalID, label) => receiptID([characterID, goalID, label]);
const semanticClaimID = (characterID, symbol, label) => receiptID([characterID, "semantic-v2", symbol, label]);
const failure = errorMsg => ({ success: false, errorMsg });
const now = () => Math.max(1, Math.trunc(getWallclockNowMs()));
function check(result) {
  if (!result?.success) throw new Error(result?.errorMsg || "CAREER_REWARD_FAILED");
  return result;
}
function flush() { check(database.flushTableSync("newEdenStoreRuntime")); }
function createClaimSnapshot(characterID) {
  const character = characters.getCharacterRecord(characterID);
  const claims = character ? store.readRuntimeAccount(Number(character.accountId)).careerProgramClaims || {} : {};
  const catalog = require("./careerCatalog"), bySymbol = new Map(), byGoal = new Map(), byGoalV2 = new Map();
  const legacySymbols = new Map();
  for (const definition of catalog.list()) for (const id of catalog.legacyIDsForSymbol(definition.symbol)) {
    legacySymbols.set(id, definition.symbol);
  }
  const add = (index, key, receipt) => {
    if (!index.has(key) || receipt.state === "completed" && index.get(key).state !== "completed") index.set(key, receipt);
  };
  for (const receipt of Object.values(claims)) {
    if (receipt?.characterID !== characterID) continue;
    add(byGoal, JSON.stringify([receipt.goalID, receipt.label]), receipt);
    if (Number(receipt.semanticVersion) >= 2) add(byGoalV2, JSON.stringify([receipt.goalID, receipt.label]), receipt);
    const symbol = receipt.goalSymbol || (Number(receipt.semanticVersion || 1) < 2 ? legacySymbols.get(receipt.goalID) : null);
    if (symbol) add(bySymbol, JSON.stringify([symbol, receipt.label]), receipt);
  }
  return { characterID, bySymbol, byGoal, byGoalV2 };
}
function getClaim(characterID, goalID, label, snapshot = createClaimSnapshot(characterID)) {
  if (snapshot.characterID !== characterID) return null;
  const catalog = require("./careerCatalog"), definition = catalog.get(goalID);
  if (definition?.symbol && Number(catalog.semanticVersion) >= 2) {
    const receipt = snapshot.bySymbol.get(JSON.stringify([definition.symbol, label]));
    return receipt ? clone(receipt) : null;
  }
  const matches = [goalID, ...(catalog.aliasesFor?.(goalID) || [])]
    .map(id => snapshot.byGoal.get(JSON.stringify([id, label]))).filter(Boolean);
  const newer = [goalID, ...(catalog.aliasesFor?.(goalID) || [])]
    .map(id => snapshot.byGoalV2.get(JSON.stringify([id, label]))).filter(Boolean);
  const eligible = !definition && newer.length ? newer : matches;
  const receipt = eligible.find(row => row.state === "completed") || eligible[0];
  return receipt ? clone(receipt) : null;
}
function exclusive(accountID, work) {
  const previous = lanes.get(accountID) || Promise.resolve();
  const next = previous.catch(() => {}).then(work);
  lanes.set(accountID, next);
  return next.finally(() => { if (lanes.get(accountID) === next) lanes.delete(accountID); });
}
function setNoticePublisher(publisher) {
  if (publisher !== null && typeof publisher !== "function") throw new TypeError("Career notice publisher must be a function or null");
  const previous = noticePublisher;
  noticePublisher = publisher;
  return previous;
}
function notify(operation, session) {
  try {
    const items = require("../inventory/itemStore");
    for (const target of require("../raffles/raffleInventory").getCharacterSessions(operation.characterID, { includeSession: session })) {
      const changes = (operation.result?.changes || []).map(change => {
        const current = items.findItemById(change.item.itemID);
        return { ...change, item: current && Number(current.ownerID) === operation.characterID
          ? current : items.buildRemovedItemNotificationState(change.item) };
      });
      characters.emitItemsChangedBatchForSession(target, changes);
    }
    if (noticePublisher) noticePublisher(operation);
  } catch (error) {
    // A disconnected UI cannot turn a durable reward into a failed claim.
    require("../../utils/logger").warn(`[Career] reward notification failed: ${error.message}`);
  }
}
function nativeRewards(definition, label, _raceID = 0) {
  const rewards = (definition.rewards || []).filter(reward => reward.label === label);
  if (!rewards.length || rewards.length > 32) return null;
  const entries = [];
  for (const reward of rewards) {
    if (reward.kind === "isk") {
      if (!Number.isSafeInteger(reward.amount) || reward.amount <= 0 || reward.amount > MAX_QUANTITY) return null;
      entries.push({ kind: "isk", amount: reward.amount });
    } else if (reward.kind === "sp") {
      if (!Number.isSafeInteger(reward.amount) || reward.amount <= 0 || reward.amount > 10000000) return null;
      entries.push({ kind: "sp", amount: reward.amount });
    } else if (reward.kind === "item") {
      // The reward is the physical crate or expert-system token. The native
      // crate/activation service owns its later consumption, not the claim.
      if (!Number.isSafeInteger(reward.typeID) || !resolveItemByTypeID(reward.typeID) ||
          !Number.isSafeInteger(reward.quantity) || reward.quantity <= 0 || reward.quantity > MAX_QUANTITY ||
          [52996, 54652, 54653, 73277, 34133, 63188].includes(reward.typeID)) return null;
      if (Number(resolveItemByTypeID(reward.typeID).categoryID) === 9 &&
          (!Number.isSafeInteger(reward.blueprintRuns) || reward.blueprintRuns <= 0 ||
           !Number.isInteger(reward.materialEfficiency) || reward.materialEfficiency < 0 || reward.materialEfficiency > 10 ||
           !Number.isInteger(reward.timeEfficiency) || reward.timeEfficiency < 0 || reward.timeEfficiency > 20)) return null;
      entries.push({ kind: "item", typeID: reward.typeID, quantity: reward.quantity,
        ...(reward.blueprintRuns ? { blueprintRuns: reward.blueprintRuns, materialEfficiency: reward.materialEfficiency, timeEfficiency: reward.timeEfficiency } : {}) });
    } else return null;
  }
  return { rewards: clone(rewards), entries };
}
function claim(characterID, goalID, label, session) {
  if (!Number.isSafeInteger(characterID) || characterID <= 0 || typeof goalID !== "string" ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(goalID) ||
      ![1, 2].includes(label)) return Promise.resolve(failure("CAREER_CLAIM_INVALID"));
  const initialCharacter = characters.getCharacterRecord(characterID);
  const accountID = Number(initialCharacter?.accountId);
  if (!initialCharacter || !Number.isSafeInteger(accountID) || accountID <= 0) return Promise.resolve(failure("CHARACTER_NOT_FOUND"));
  return exclusive(accountID, async () => {
    const character = characters.getCharacterRecord(characterID);
    if (!character || Number(character.accountId) !== accountID) return failure("CAREER_CLAIM_OWNER_CHANGED");
    const account = store.readRuntimeAccount(accountID);
    const existing = getClaim(characterID, goalID, label);
    if (existing) {
      if (existing.characterID !== characterID || existing.accountID !== accountID) return failure("CAREER_CLAIM_OWNER_CHANGED");
      // A failed flush acknowledgement may leave the complete checkpoint in
      // memory. Recommit it before duplicate success; never recreate its tokens.
      flush();
      if (existing.deliveryMode === "earning-character") return settlement.settle(accountID, existing.id, session);
      return { success: true, duplicate: true, data: clone(existing) };
    }
    const catalog = require("./careerCatalog"), definition = catalog.get(goalID);
    if (!definition || !Number.isSafeInteger(definition.target) || definition.target <= 0) return failure("CAREER_GOAL_NOT_FOUND");
    const progress = require("./careerProgress").get(characterID, definition.id);
    if (!progress || progress.progress < definition.target || !Number.isSafeInteger(progress.completedAtMs) || progress.completedAtMs <= 0) {
      return failure("CAREER_GOAL_NOT_COMPLETE");
    }
    if (label === 2 && require("../subscription/subscriptionState").getSubscriptionState(accountID).cloneGrade !== 1) {
      return failure("CAREER_OMEGA_REQUIRED");
    }
    const mapped = nativeRewards(definition, label, Number(character.raceID) || 0);
    if (!mapped) return failure("CAREER_REWARD_UNSUPPORTED");
    if (Object.keys(account.careerProgramClaims || {}).length >= MAX_CLAIMS) return failure("CAREER_CLAIM_LIMIT");
    const destination = settlement.destination(character, mapped.entries, characterID);
    if (!destination) return failure("CAREER_REWARD_DESTINATION_UNAVAILABLE");
    const id = definition.symbol && Number(catalog.semanticVersion) >= 2
      ? semanticClaimID(characterID, definition.symbol, label) : claimID(characterID, definition.id, label);
    const operation = { id, state: "pending", deliveryMode: "earning-character", characterID, accountID, goalID: definition.id,
      goalSymbol: definition.symbol || null, catalogVersion: catalog.contentVersion || null,
      semanticVersion: Number(catalog.semanticVersion) || 1, label,
      rewards: mapped.rewards, entries: mapped.entries, destination, completedAtMs: progress.completedAtMs, claimedAtMs: now() };
    account.careerProgramClaims ||= {};
    account.careerProgramClaims[id] = operation;
    // Persist immutable intent before any independently idempotent owner effect.
    check(store.writeRewardAccount(accountID, account));
    flush();
    await settlement.enqueue(accountID, id);
    return settlement.settle(accountID, id, session);
  });
}
async function drain() { await Promise.allSettled([...lanes.values()]); await settlement.drain(); }

module.exports = { claimID, semanticClaimID, createClaimSnapshot, getClaim, claim, drain, setNoticePublisher, notifyCompleted: notify };
