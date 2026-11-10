"use strict";

const { createHash } = require("node:crypto");
const database = require("../../gameStore");
const characters = require("../character/characterState");
const store = require("../newEdenStore/storeState");
const { getWallclockNowMs } = require("../../space/runtime/runtimeClock");
const { resolveItemByTypeID } = require("../inventory/itemTypeRegistry");
const { currentFileTime } = require("../_shared/serviceHelpers");

const MAX_CLAIMS = 8192;
const MAX_QUANTITY = 2147483647;
const lanes = new Map();
let noticePublisher = null;
const clone = value => JSON.parse(JSON.stringify(value));
const receiptID = value => `career:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
const claimID = (characterID, goalID, label) => receiptID([characterID, goalID, label]);
const failure = errorMsg => ({ success: false, errorMsg });
const now = () => Math.max(1, Math.trunc(getWallclockNowMs()));
function check(result) {
  if (!result?.success) throw new Error(result?.errorMsg || "CAREER_REWARD_FAILED");
  return result;
}
function flush() { check(database.flushTableSync("newEdenStoreRuntime")); }
function getClaim(characterID, goalID, label) {
  const character = characters.getCharacterRecord(characterID);
  if (!character) return null;
  const operation = store.readRuntimeAccount(Number(character.accountId)).careerProgramClaims?.[claimID(characterID, goalID, label)];
  return operation && operation.characterID === characterID ? clone(operation) : null;
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
    const sameAccountSession = Number(session?.userid || session?.userID || session?.accountID) === operation.accountID;
    require("../campaign/loginCampaignRuntime").notify(sameAccountSession ? session : { userid: operation.accountID });
    if (noticePublisher) noticePublisher(operation);
  } catch (error) {
    // A disconnected UI cannot turn a durable queue receipt into a failed claim.
    require("../../utils/logger").warn(`[Career] reward queue notification failed: ${error.message}`);
  }
}
function nativeRewards(definition, label) {
  const rewards = (definition.rewards || []).filter(reward => reward.label === label);
  if (!rewards.length || rewards.length > 32) return null;
  const entries = [];
  const user = require("../user/userService");
  for (const reward of rewards) {
    if (reward.kind === "isk") {
      if (!Number.isSafeInteger(reward.amount) || reward.amount <= 0 || reward.amount > MAX_QUANTITY || !resolveItemByTypeID(52996)) return null;
      entries.push({ typeID: 52996, quantity: reward.amount });
    } else if (reward.kind === "sp") {
      if (!Number.isSafeInteger(reward.amount) || reward.amount <= 0 || reward.amount > 10000000) return null;
      const thousand = user.getSkillPointRedeemAmount(54652), twentyFiveHundred = user.getSkillPointRedeemAmount(54653);
      if (thousand !== 1000 || twentyFiveHundred !== 2500 || !resolveItemByTypeID(54652) || !resolveItemByTypeID(54653)) return null;
      // Use real client token types. A value that cannot be represented exactly
      // is unsupported; never round an economic award or invent a virtual item.
      if (reward.amount % thousand === 0) entries.push({ typeID: 54652, quantity: reward.amount / thousand });
      else if (reward.amount >= twentyFiveHundred && (reward.amount - twentyFiveHundred) % thousand === 0) {
        entries.push({ typeID: 54653, quantity: 1 });
        if (reward.amount > twentyFiveHundred) entries.push({ typeID: 54652, quantity: (reward.amount - twentyFiveHundred) / thousand });
      } else return null;
    } else if (reward.kind === "item") {
      if (!Number.isSafeInteger(reward.typeID) || !resolveItemByTypeID(reward.typeID) ||
          !Number.isSafeInteger(reward.quantity) || reward.quantity <= 0 || reward.quantity > MAX_QUANTITY ||
          user.getSkillPointRedeemAmount(reward.typeID) || [52996, 73277, 34133, 63188].includes(reward.typeID) ||
          require("../skills/expertSystems/expertSystemCatalog").isExpertSystemType(reward.typeID)) return null;
      entries.push({ typeID: reward.typeID, quantity: reward.quantity });
    } else return null;
  }
  return { rewards: clone(rewards), entries };
}
function nextTokenID(account) {
  let highest = Math.max(700000000, Number(account.campaignTokenSequence) || 0);
  for (const token of account.redeemTokens || []) highest = Math.max(highest, Number(token.tokenID) || 0, Number(token.massTokenID) || 0);
  const id = highest + 1;
  if (!Number.isSafeInteger(id) || id > MAX_QUANTITY) throw new Error("CAMPAIGN_TOKEN_ID_LIMIT");
  account.campaignTokenSequence = id;
  return id;
}
function claim(characterID, goalID, label, session) {
  if (!Number.isSafeInteger(characterID) || characterID <= 0 || typeof goalID !== "string" ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(goalID) ||
      ![1, 2].includes(label)) return Promise.resolve(failure("CAREER_CLAIM_INVALID"));
  const initialCharacter = characters.getCharacterRecord(characterID);
  const accountID = Number(initialCharacter?.accountId);
  if (!initialCharacter || !Number.isSafeInteger(accountID) || accountID <= 0) return Promise.resolve(failure("CHARACTER_NOT_FOUND"));
  return exclusive(accountID, () => {
    const character = characters.getCharacterRecord(characterID);
    if (!character || Number(character.accountId) !== accountID) return failure("CAREER_CLAIM_OWNER_CHANGED");
    const id = claimID(characterID, goalID, label), account = store.readRuntimeAccount(accountID);
    const existing = account.careerProgramClaims?.[id];
    if (existing) {
      if (existing.characterID !== characterID || existing.accountID !== accountID) return failure("CAREER_CLAIM_OWNER_CHANGED");
      // A failed flush acknowledgement may leave the complete checkpoint in
      // memory. Recommit it before duplicate success; never recreate its tokens.
      flush();
      return { success: true, duplicate: true, data: clone(existing) };
    }
    const definition = require("./careerCatalog").get(goalID);
    if (!definition || !Number.isSafeInteger(definition.target) || definition.target <= 0) return failure("CAREER_GOAL_NOT_FOUND");
    const progress = require("./careerProgress").get(characterID, goalID);
    if (!progress || progress.progress < definition.target || !Number.isSafeInteger(progress.completedAtMs) || progress.completedAtMs <= 0) {
      return failure("CAREER_GOAL_NOT_COMPLETE");
    }
    if (label === 2 && require("../subscription/subscriptionState").getSubscriptionState(accountID).cloneGrade !== 1) {
      return failure("CAREER_OMEGA_REQUIRED");
    }
    const mapped = nativeRewards(definition, label);
    if (!mapped) return failure("CAREER_REWARD_UNSUPPORTED");
    if (Object.keys(account.careerProgramClaims || {}).length >= MAX_CLAIMS) return failure("CAREER_CLAIM_LIMIT");
    const tokens = mapped.entries.map((entry, index) => ({ ...entry, tokenID: nextTokenID(account), massTokenID: 0,
      blueprintRuns: 0, blueprintMaterialLevel: 0, blueprintProductivityLevel: 0,
      stationID: 0, dateTime: currentFileTime().toString(), expireDateTime: "0", available: true,
      label: "AIR Career Program reward", description: "AIR Career Program reward",
      campaignGrant: { grantID: receiptID([id, index]) } }));
    const operation = { id, state: "completed", characterID, accountID, goalID, label,
      rewards: mapped.rewards, completedAtMs: progress.completedAtMs, claimedAtMs: now(), result: { tokens } };
    account.careerProgramClaims ||= {};
    account.careerProgramClaims[id] = operation;
    account.redeemTokens.push(...tokens);
    // Queue and permanent claim receipt share the existing account owner and a
    // single durable checkpoint. Delivery starts only at native userSvc redeem.
    check(store.writeRewardAccount(accountID, account));
    flush();
    notify(operation, session);
    return { success: true, duplicate: false, data: clone(operation) };
  });
}
async function drain() { await Promise.allSettled([...lanes.values()]); }

module.exports = { claimID, getClaim, claim, drain, setNoticePublisher };
