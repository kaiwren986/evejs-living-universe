"use strict";

const {
  toInt,
} = require("../../common/numbers");

const path = require("path");

const database = require(path.join(__dirname, "../../gameStore"));
const log = require(path.join(__dirname, "../../utils/logger"));
const {
  createUuidString,
} = require(path.join(
  __dirname,
  "../../_secondary/express/gatewayServices/gatewayServiceHelpers",
));
const {
  CATEGORY,
  DAILY_ROTATION_SIZE,
  DAILY_TEMPLATE_BY_KEY,
  BONUS_TEMPLATE,
  BONUS_TARGET_DAILY_COMPLETIONS,
  EVERMARK_ISSUER_CORP_ID,
  EM_PAID_COMPLETION_COST_FIRST,
  EM_PAID_COMPLETION_COST_SECOND,
  MAX_PAID_COMPLETIONS_PER_DAY,
  grantableRewardsForTemplate,
  pickDailyTemplateKeys,
  MONTHLY_MILESTONE_TARGETS,
  MONTHLY_MILESTONES,
  MONTHLY_MILESTONE_BY_KEY,
  grantableRewardForMilestone,
} = require("./dailyGoalsCatalog");

const MONTHLY_AUTO_CLAIM_AFTER_MS = 30 * 24 * 60 * 60 * 1000; // auto-claim after 30 days

const TABLE_NAME = "dailyGoals";
const ROOT_VERSION = 2;
const DOWNTIME_HOUR_UTC = 11; // daily goals roll over at the 11:00 UTC downtime
const DAY_MS = 24 * 60 * 60 * 1000;
const DURABLE_REWARD_JOB_TYPE = "daily-goal.reward-settle";
const DURABLE_REWARD_JOB_PREFIX = "daily-goal-reward:";
const rewardSettlementLanes = new Map();
let durableScheduler = null;
let nowMsOverride = null;

// Daily goals normally use wall-clock milliseconds. The narrowly-scoped
// override lets the gameplay harness drive rollover and monthly milestones
// without moving process-wide Date.now(), which also governs the persistence
// lease used by the game store.
function getNowMs() {
  const overridden = nowMsOverride ? Number(nowMsOverride()) : NaN;
  return Number.isFinite(overridden) ? Math.trunc(overridden) : Date.now();
}

function setNowMsOverride(override) {
  nowMsOverride = typeof override === "function" ? override : null;
}

function resetNowMsOverride() {
  nowMsOverride = null;
}

// The gateway service registers a publisher so state changes can push client
// notices (progressed / completed / redeemed / current-goals). Kept as an
// injected callback to avoid a state <-> gateway require cycle and so the proto
// encoding stays in the gateway layer.
let noticePublisher = null;

function registerNoticePublisher(publisher) {
  noticePublisher = typeof publisher === "function" ? publisher : null;
}

function publishNotice(characterID, event) {
  if (!noticePublisher) {
    return;
  }
  try {
    noticePublisher(characterID, event);
  } catch (error) {
    log.debug(
      `[DailyGoals] notice publish failed char=${characterID} kind=${event && event.kind}: ${error.message}`,
    );
  }
}

function templateForKey(key) {
  if (key === BONUS_TEMPLATE.key) {
    return BONUS_TEMPLATE;
  }
  return DAILY_TEMPLATE_BY_KEY[key] || null;
}

function readRoot() {
  const result = database.read(TABLE_NAME, "/");
  if (!result.success || !result.data || typeof result.data !== "object") {
    return {
      version: ROOT_VERSION,
      byCharacter: {},
      monthly: {},
      rewardSettlements: {},
    };
  }
  const data = result.data;
  if (!data.byCharacter || typeof data.byCharacter !== "object") {
    data.byCharacter = {};
  }
  if (!data.monthly || typeof data.monthly !== "object") {
    data.monthly = {};
  }
  if (!data.rewardSettlements || typeof data.rewardSettlements !== "object") {
    data.rewardSettlements = {};
  }
  return data;
}

function writeRoot(root, options = {}) {
  const result = database.write(
    TABLE_NAME,
    "/",
    { ...root, version: ROOT_VERSION },
  );
  if (!result.success) {
    return result;
  }
  const pendingIDs = Object.keys(root.rewardSettlements || {});
  if (options.flush === true || pendingIDs.length > 0) {
    const flushResult = database.flushTableSync(TABLE_NAME);
    if (!flushResult || !flushResult.success) {
      return flushResult || { success: false, errorMsg: "FLUSH_ERROR" };
    }
  }
  if (options.queueRewards !== false && pendingIDs.length > 0) {
    for (const settlementID of pendingIDs) {
      queueRewardSettlement(settlementID);
    }
  }
  return result;
}

// Current daily period boundaries, anchored to the 11:00 UTC downtime.
function currentPeriod(nowMs = getNowMs()) {
  const now = new Date(nowMs);
  const boundary = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    DOWNTIME_HOUR_UTC,
    0,
    0,
    0,
  );
  let activeAfterMs;
  let activeUntilMs;
  if (nowMs >= boundary) {
    activeAfterMs = boundary;
    activeUntilMs = boundary + DAY_MS;
  } else {
    activeAfterMs = boundary - DAY_MS;
    activeUntilMs = boundary;
  }
  return {
    periodKey: String(activeAfterMs),
    activeAfterMs,
    activeUntilMs,
  };
}

function generatePeriodState(period) {
  const dailyKeys = pickDailyTemplateKeys(period.periodKey, DAILY_ROTATION_SIZE);
  return {
    periodKey: period.periodKey,
    activeAfterMs: period.activeAfterMs,
    activeUntilMs: period.activeUntilMs,
    // How many daily goals have been completed by paying Evermarks today (max 2).
    paidCompletions: 0,
    goals: dailyKeys.map((templateKey) => ({
      uuid: createUuidString(),
      templateKey,
      progress: 0,
      completed: false,
      redeemed: false,
      paidCompletion: false,
      completedAtMs: 0,
    })),
    bonus: {
      uuid: createUuidString(),
      templateKey: BONUS_TEMPLATE.key,
      progress: 0,
      completed: false,
      redeemed: false,
      completedAtMs: 0,
    },
  };
}

// Ensures the character has a state for the current daily period, regenerating
// (new rotation) when the period has rolled over. Returns { root, entry } so
// callers can mutate and persist in one pass.
function ensureCurrentState(characterID, nowMs = getNowMs()) {
  const charKey = String(toInt(characterID));
  const root = readRoot();
  const period = currentPeriod(nowMs);
  const existing = root.byCharacter[charKey];
  if (existing && existing.periodKey === period.periodKey) {
    return { root, entry: existing, regenerated: false };
  }
  const entry = generatePeriodState(period);
  root.byCharacter[charKey] = entry;
  return { root, entry, regenerated: true };
}

function allGoalObjects(entry) {
  return [...entry.goals, entry.bonus];
}

function findGoalObject(entry, uuid) {
  const normalized = String(uuid || "").toLowerCase();
  return (
    allGoalObjects(entry).find(
      (goal) => String(goal.uuid).toLowerCase() === normalized,
    ) || null
  );
}

function describeGoal(entry, goal) {
  const template = templateForKey(goal.templateKey);
  return {
    uuid: goal.uuid,
    template,
    category: template && template.isBonus ? CATEGORY.DAILY_BONUS : CATEGORY.DAILY,
    target: template ? template.target : 0,
    progress: toInt(goal.progress),
    completed: Boolean(goal.completed),
    redeemed: Boolean(goal.redeemed),
    paidCompletion: Boolean(goal.paidCompletion),
    activeAfterMs: entry.activeAfterMs,
    activeUntilMs: entry.activeUntilMs,
  };
}

// ---- reward granting -------------------------------------------------------

function getWalletState() {
  return require(path.join(__dirname, "../account/walletState"));
}

function getCharacterState() {
  return require(path.join(__dirname, "../character/characterState"));
}

function getSkillQueueNotifications() {
  return require(path.join(
    __dirname,
    "../skills/training/skillQueueNotifications",
  ));
}

function getLpWalletState() {
  return require(path.join(__dirname, "../corporation/lpWalletState"));
}

// Evermarks are LP under the Evermark issuer corp.
function getEvermarkBalance(characterID) {
  try {
    return (
      getLpWalletState().getCharacterWalletLPBalance(
        toInt(characterID),
        EVERMARK_ISSUER_CORP_ID,
      ) || 0
    );
  } catch (error) {
    // ignored: an unreadable LP wallet shows an Evermark balance of 0
    return 0;
  }
}

function grantEvermarks(characterID, amount, idempotencyKey) {
  const normalizedAmount = Math.max(0, toInt(amount));
  if (!(normalizedAmount > 0)) {
    return { success: true, skipped: true };
  }
  const result = getLpWalletState().adjustCharacterWalletLPBalance(
    toInt(characterID),
    EVERMARK_ISSUER_CORP_ID,
    normalizedAmount,
    {
      changeType: "daily_goal_reward",
      idempotencyKey,
    },
  );
  if (result && result.success) {
    const flushResult = database.flushTableSync("lpWallets");
    if (!flushResult || !flushResult.success) {
      return flushResult || { success: false, errorMsg: "FLUSH_ERROR" };
    }
  }
  return result;
}

// Spends Evermarks; returns true only if the debit succeeded.
function spendEvermarks(characterID, amount) {
  if (!(amount > 0)) {
    return true;
  }
  try {
    const result = getLpWalletState().adjustCharacterWalletLPBalance(
      toInt(characterID),
      EVERMARK_ISSUER_CORP_ID,
      -amount,
      { changeType: "daily_goal_paid_completion" },
    );
    return Boolean(result && result.success);
  } catch (error) {
    log.warn(
      `[DailyGoals] Evermark spend failed char=${characterID} amount=${amount}: ${error.message}`,
    );
    return false;
  }
}

async function grantIsk(characterID, amount, settlement) {
  const normalizedAmount = Math.max(0, Number(amount) || 0);
  if (!(normalizedAmount > 0)) {
    return { success: true, skipped: true };
  }
  return getWalletState().adjustCharacterBalanceAsync(
    characterID,
    normalizedAmount,
    {
      description: settlement.description || "AIR Daily Goal reward",
      idempotencyKey: settlement.walletCommandID,
    },
    {
      commandID: settlement.walletCommandID,
      idempotencyKey: settlement.walletCommandID,
      source: "daily-goal-reward",
    },
  );
}

function grantSkillPoints(characterID, amount, idempotencyKey) {
  const normalizedAmount = Math.max(0, toInt(amount));
  if (!(normalizedAmount > 0)) {
    return { success: true, skipped: true };
  }
  let duplicate = false;
  let keyConflict = false;
  const characterState = getCharacterState();
  const result = characterState.updateCharacterRecord(
    characterID,
    (record) => {
      const receipts =
        record.dailyGoalRewardReceipts &&
        typeof record.dailyGoalRewardReceipts === "object"
          ? { ...record.dailyGoalRewardReceipts }
          : {};
      const existing = receipts[idempotencyKey];
      if (existing) {
        duplicate = true;
        keyConflict = toInt(existing.amount) !== normalizedAmount;
        return record;
      }
      receipts[idempotencyKey] = {
        amount: normalizedAmount,
        appliedAtMs: getNowMs(),
      };
      return {
        ...record,
        freeSkillPoints:
          Math.max(0, toInt(record.freeSkillPoints, 0)) + normalizedAmount,
        dailyGoalRewardReceipts: receipts,
      };
    },
  );
  if (!result || !result.success) {
    return result || { success: false, errorMsg: "SKILL_POINT_GRANT_FAILED" };
  }
  if (keyConflict) {
    return { success: false, errorMsg: "IDEMPOTENCY_KEY_REUSED" };
  }
  const flushResult = database.flushTableSync(
    characterState.CHARACTERS_TABLE || "characters",
  );
  if (!flushResult || !flushResult.success) {
    return flushResult || { success: false, errorMsg: "FLUSH_ERROR" };
  }
  if (!duplicate) {
    const newTotal = Math.max(
      0,
      toInt(result.data && result.data.freeSkillPoints, 0),
    );
    getSkillQueueNotifications().notifyFreeSkillPointsChanged(
      characterID,
      newTotal,
    );
  }
  return { ...result, duplicate };
}

function buildRewardSettlementID(kind, characterID, rewardUUID) {
  return `${String(kind || "reward")}:${toInt(characterID)}:${String(rewardUUID || "")}`;
}

function prepareRewardSettlement(root, options = {}) {
  root.rewardSettlements =
    root.rewardSettlements && typeof root.rewardSettlements === "object"
      ? root.rewardSettlements
      : {};
  const settlementID = buildRewardSettlementID(
    options.kind,
    options.characterID,
    options.rewardUUID,
  );
  const existing = root.rewardSettlements[settlementID];
  if (existing) {
    return { settlementID, settlement: existing, created: false };
  }
  const isk = Math.max(0, Number(options.isk) || 0);
  const skillPoints = Math.max(0, toInt(options.skillPoints));
  const evermarks = Math.max(0, toInt(options.evermarks));
  const settlement = {
    settlementID,
    kind: String(options.kind || "reward"),
    characterID: toInt(options.characterID),
    rewardUUID: String(options.rewardUUID || ""),
    sourceKey: String(options.sourceKey || ""),
    description: String(options.description || "AIR Daily Goal reward"),
    isk,
    skillPoints,
    evermarks,
    iskApplied: isk <= 0,
    skillPointsApplied: skillPoints <= 0,
    evermarksApplied: evermarks <= 0,
    walletCommandID: `${DURABLE_REWARD_JOB_PREFIX}${settlementID}:isk`,
    skillPointReceiptID: `${DURABLE_REWARD_JOB_PREFIX}${settlementID}:sp`,
    evermarkReceiptID: `${DURABLE_REWARD_JOB_PREFIX}${settlementID}:evermarks`,
    createdAtMs: getNowMs(),
  };
  root.rewardSettlements[settlementID] = settlement;
  return { settlementID, settlement, created: true };
}

function prepareDailyGoalReward(root, characterID, goal) {
  if (!goal || goal.redeemed) {
    return null;
  }
  const template = templateForKey(goal.templateKey);
  if (!template) {
    return null;
  }
  const grant = grantableRewardsForTemplate(template);
  const prepared = prepareRewardSettlement(root, {
    kind: "daily",
    characterID,
    rewardUUID: goal.uuid,
    sourceKey: template.key,
    description: `AIR Daily Goal reward: ${template.key}`,
    ...grant,
  });
  goal.redeemed = true;
  return prepared;
}

function prepareMonthlyMilestoneReward(
  root,
  characterID,
  milestone,
  milestoneState,
  nowMs,
) {
  if (!milestone || !milestoneState || milestoneState.claimed) {
    return null;
  }
  const grant = grantableRewardForMilestone(milestone);
  const prepared = prepareRewardSettlement(root, {
    kind: "monthly",
    characterID,
    rewardUUID: milestoneState.uuid,
    sourceKey: milestone.key,
    description: `AIR Monthly Goal reward: ${milestone.key}`,
    ...grant,
  });
  milestoneState.claimed = true;
  milestoneState.claimedAtMs = nowMs;
  return prepared;
}

function buildRewardSettlementJob(settlementID) {
  const normalizedID = String(settlementID || "").trim();
  return normalizedID
    ? {
        jobID: `${DURABLE_REWARD_JOB_PREFIX}${normalizedID}`,
        type: DURABLE_REWARD_JOB_TYPE,
        dueAtMs: getNowMs(),
        payload: { settlementID: normalizedID },
      }
    : null;
}

function listPendingRewardSettlements() {
  return Object.values(readRoot().rewardSettlements || {})
    .filter(Boolean)
    .map((settlement) => JSON.parse(JSON.stringify(settlement)))
    .sort((left, right) =>
      String(left.settlementID).localeCompare(String(right.settlementID)));
}

function runRewardSettlementSerialized(settlementID, operation) {
  const laneKey = String(settlementID || "");
  const previous = rewardSettlementLanes.get(laneKey) || Promise.resolve();
  const current = previous.catch(() => null).then(operation);
  rewardSettlementLanes.set(laneKey, current);
  void current.finally(() => {
    if (rewardSettlementLanes.get(laneKey) === current) {
      rewardSettlementLanes.delete(laneKey);
    }
  }).catch(() => null);
  return current;
}

function checkpointRewardSettlement(settlementID, patch) {
  const root = readRoot();
  const current = root.rewardSettlements[String(settlementID || "")];
  if (!current) {
    return false;
  }
  root.rewardSettlements[String(settlementID)] = {
    ...current,
    ...patch,
  };
  const writeResult = writeRoot(root, { flush: true, queueRewards: false });
  return Boolean(writeResult && writeResult.success);
}

function completeRewardSettlement(settlement) {
  const root = readRoot();
  if (!root.rewardSettlements[settlement.settlementID]) {
    return false;
  }
  delete root.rewardSettlements[settlement.settlementID];
  const writeResult = writeRoot(root, { flush: true, queueRewards: false });
  if (!writeResult || !writeResult.success) {
    return false;
  }
  log.info(
    `[DailyGoals] reward settled char=${settlement.characterID} ` +
      `source=${settlement.sourceKey} isk=${settlement.isk} ` +
      `sp=${settlement.skillPoints} em=${settlement.evermarks}`,
  );
  publishNotice(settlement.characterID, {
    kind: "redeemed",
    uuid: settlement.rewardUUID,
  });
  return true;
}

async function settlePendingRewardInternal(settlementID) {
  let root = readRoot();
  let settlement = root.rewardSettlements[String(settlementID || "")];
  if (!settlement) {
    return { success: true, alreadySettled: true };
  }
  settlement = JSON.parse(JSON.stringify(settlement));

  if (!settlement.iskApplied) {
    const iskResult = await grantIsk(
      settlement.characterID,
      settlement.isk,
      settlement,
    );
    if (!iskResult || iskResult.success !== true) {
      return iskResult || { success: false, errorMsg: "ISK_GRANT_FAILED" };
    }
    if (!checkpointRewardSettlement(settlement.settlementID, { iskApplied: true })) {
      return { success: false, errorMsg: "ISK_CHECKPOINT_FAILED" };
    }
  }

  root = readRoot();
  settlement = root.rewardSettlements[settlement.settlementID];
  if (!settlement) {
    return { success: true, alreadySettled: true };
  }
  settlement = JSON.parse(JSON.stringify(settlement));
  if (!settlement.skillPointsApplied) {
    const skillPointResult = grantSkillPoints(
      settlement.characterID,
      settlement.skillPoints,
      settlement.skillPointReceiptID,
    );
    if (!skillPointResult || skillPointResult.success !== true) {
      return skillPointResult || {
        success: false,
        errorMsg: "SKILL_POINT_GRANT_FAILED",
      };
    }
    if (!checkpointRewardSettlement(
      settlement.settlementID,
      { skillPointsApplied: true },
    )) {
      return { success: false, errorMsg: "SKILL_POINT_CHECKPOINT_FAILED" };
    }
  }

  root = readRoot();
  settlement = root.rewardSettlements[settlement.settlementID];
  if (!settlement) {
    return { success: true, alreadySettled: true };
  }
  settlement = JSON.parse(JSON.stringify(settlement));
  if (!settlement.evermarksApplied) {
    const evermarkResult = grantEvermarks(
      settlement.characterID,
      settlement.evermarks,
      settlement.evermarkReceiptID,
    );
    if (!evermarkResult || evermarkResult.success !== true) {
      return evermarkResult || {
        success: false,
        errorMsg: "EVERMARK_GRANT_FAILED",
      };
    }
    if (!checkpointRewardSettlement(
      settlement.settlementID,
      { evermarksApplied: true },
    )) {
      return { success: false, errorMsg: "EVERMARK_CHECKPOINT_FAILED" };
    }
  }

  root = readRoot();
  settlement = root.rewardSettlements[settlement.settlementID];
  if (!settlement) {
    return { success: true, alreadySettled: true };
  }
  settlement = JSON.parse(JSON.stringify(settlement));
  if (!completeRewardSettlement(settlement)) {
    return { success: false, errorMsg: "REWARD_COMPLETION_FAILED" };
  }
  return { success: true, data: { settlementID: settlement.settlementID } };
}

function settlePendingReward(settlementID) {
  return runRewardSettlementSerialized(settlementID, () =>
    settlePendingRewardInternal(settlementID));
}

async function scheduleRewardSettlement(settlementID) {
  const job = buildRewardSettlementJob(settlementID);
  if (!job || !durableScheduler) {
    return null;
  }
  await durableScheduler.schedule(job);
  return job;
}

function queueRewardSettlement(settlementID) {
  if (durableScheduler) {
    void scheduleRewardSettlement(settlementID).catch((error) => {
      log.warn(
        `[DailyGoals] reward scheduling failed id=${settlementID}: ${error.message}`,
      );
    });
    return;
  }
  void settlePendingReward(settlementID).then((result) => {
    if (!result || result.success !== true) {
      log.warn(
        `[DailyGoals] reward settlement deferred id=${settlementID}: ` +
          `${result && result.errorMsg || "UNKNOWN"}`,
      );
    }
  }).catch((error) => {
    log.warn(
      `[DailyGoals] reward settlement deferred id=${settlementID}: ${error.message}`,
    );
  });
}

function bindDurableScheduler(scheduler) {
  if (!scheduler || typeof scheduler.schedule !== "function") {
    throw new TypeError("daily goal scheduler requires a schedule function");
  }
  durableScheduler = scheduler;
  return true;
}

function unbindDurableScheduler(scheduler = null) {
  if (scheduler && durableScheduler !== scheduler) {
    return false;
  }
  durableScheduler = null;
  return true;
}

async function handleDurableRewardSettlement(job = {}) {
  const settlementID = String(job.payload && job.payload.settlementID || "").trim();
  if (!settlementID) {
    throw new Error("daily goal reward job is invalid");
  }
  const result = await settlePendingReward(settlementID);
  if (!result || result.success !== true) {
    throw new Error(result && result.errorMsg || "daily goal reward settlement failed");
  }
  return result;
}

async function reconcileDurableRewardSettlements() {
  const pending = listPendingRewardSettlements();
  if (!durableScheduler) {
    return { scheduled: 0, pending: pending.length };
  }
  await Promise.all(pending.map((settlement) =>
    scheduleRewardSettlement(settlement.settlementID)));
  return { scheduled: pending.length, pending: pending.length };
}

function completeGoal(characterID, entry, goal, nowMs) {
  if (goal.completed) {
    return;
  }
  goal.completed = true;
  goal.completedAtMs = nowMs;
  publishNotice(characterID, { kind: "completed", uuid: goal.uuid });
}

// Recomputes the completion-bonus progress from the number of completed daily
// goals and fires its completion when the threshold is reached. On the bonus
// completing, credits one day toward the Monthly Reward Track. The bonus reward
// is NOT granted here — like every other daily goal it waits for the player to
// claim it from the goals window.
function updateBonusProgress(characterID, root, entry, nowMs) {
  const bonus = entry.bonus;
  if (!bonus) {
    return;
  }
  const completedDailies = entry.goals.filter((goal) => goal.completed).length;
  const nextProgress = Math.min(BONUS_TARGET_DAILY_COMPLETIONS, completedDailies);
  if (nextProgress !== toInt(bonus.progress)) {
    bonus.progress = nextProgress;
    publishNotice(characterID, {
      kind: "progressed",
      uuid: bonus.uuid,
      currentProgress: nextProgress,
    });
  }
  if (nextProgress >= BONUS_TARGET_DAILY_COMPLETIONS && !bonus.completed) {
    completeGoal(characterID, entry, bonus, nowMs);
    creditMonthlyBonusDay(root, characterID, entry, nowMs);
  }
}

// ---- Monthly Reward Track --------------------------------------------------

function getNewEdenStoreState() {
  return require(path.join(__dirname, "../newEdenStore/storeState"));
}

// True if the character's account currently holds an active Omega license.
// Defensive: any lookup failure is treated as Alpha.
function characterHasOmega(characterID) {
  try {
    const storeState = getNewEdenStoreState();
    const accountID = storeState.resolveCharacterAccountID(toInt(characterID));
    const omegaState = storeState.resolveOmegaLicenseState(accountID);
    return Boolean(omegaState && omegaState.hasLicense);
  } catch (error) {
    // ignored: any lookup failure is treated as Alpha (false), as the comment above says
    return false;
  }
}

// The month a goal-day belongs to (anchored to the period start, so the goal-day
// that begins at the final downtime of a month still counts toward that month
// until the first downtime of the next). Month resets at the first downtime of
// the new month, matching CCP.
function monthContext(nowMs = getNowMs()) {
  const period = currentPeriod(nowMs);
  const start = new Date(period.activeAfterMs);
  const year = start.getUTCFullYear();
  const month = start.getUTCMonth();
  return {
    monthKey: `${year}-${String(month + 1).padStart(2, "0")}`,
    monthStartMs: Date.UTC(year, month, 1, DOWNTIME_HOUR_UTC, 0, 0, 0),
    monthEndMs: Date.UTC(year, month + 1, 1, DOWNTIME_HOUR_UTC, 0, 0, 0),
  };
}

function generateMonthlyState(context) {
  const milestones = {};
  for (const milestone of MONTHLY_MILESTONES) {
    milestones[milestone.key] = {
      uuid: createUuidString(),
      earnedAtMs: 0,
      claimed: false,
      claimedAtMs: 0,
    };
  }
  return {
    monthKey: context.monthKey,
    monthStartMs: context.monthStartMs,
    monthEndMs: context.monthEndMs,
    bonusDays: 0,
    countedPeriods: [],
    milestones,
  };
}

// Grants earned-but-unclaimed milestones that are due: forced at month rollover,
// or 30 days after being earned (CCP auto-claims unclaimed rewards after 30
// days). Omega milestones are only auto-claimed for Omega characters.
function autoClaimDueMilestones(root, characterID, state, nowMs, force = false) {
  let changed = false;
  const hasOmega = characterHasOmega(characterID);
  for (const milestone of MONTHLY_MILESTONES) {
    const milestoneState = state.milestones[milestone.key];
    if (!milestoneState || !milestoneState.earnedAtMs || milestoneState.claimed) {
      continue;
    }
    const due =
      force || nowMs - toInt(milestoneState.earnedAtMs) >= MONTHLY_AUTO_CLAIM_AFTER_MS;
    if (!due) {
      continue;
    }
    if (milestone.omega && !hasOmega) {
      continue;
    }
    changed = Boolean(prepareMonthlyMilestoneReward(
      root,
      characterID,
      milestone,
      milestoneState,
      nowMs,
    )) || changed;
  }
  return changed;
}

// Ensures the character's monthly state is for the current month, rolling over
// (and auto-claiming the prior month's earned-unclaimed rewards) when the month
// changes. Returns { state, changed }.
function ensureMonthlyState(root, characterID, nowMs = getNowMs()) {
  const charKey = String(toInt(characterID));
  const context = monthContext(nowMs);
  const existing = root.monthly[charKey];
  if (existing && existing.monthKey === context.monthKey) {
    return { state: existing, changed: false };
  }
  if (existing) {
    autoClaimDueMilestones(root, characterID, existing, nowMs, true);
  }
  const state = generateMonthlyState(context);
  root.monthly[charKey] = state;
  return { state, changed: true };
}

// Counts one day toward the Monthly Reward Track (called when the daily bonus
// completes). Deduplicated per daily period so a day is only counted once, and
// marks any newly-reached milestones as earned (reward is claimed separately).
function creditMonthlyBonusDay(root, characterID, entry, nowMs) {
  const { state } = ensureMonthlyState(root, characterID, nowMs);
  const periodKey = entry.periodKey;
  if (state.countedPeriods.includes(periodKey)) {
    return;
  }
  state.countedPeriods.push(periodKey);
  const previousBonusDays = toInt(state.bonusDays);
  state.bonusDays = previousBonusDays + 1;
  for (const milestone of MONTHLY_MILESTONES) {
    const milestoneState = state.milestones[milestone.key];
    if (!milestoneState) {
      continue;
    }
    // The client draws the track from the final Alpha milestone's cached
    // progress. Completion notices alone leave its segments stale until day
    // 12. Push each changed milestone before its completion notice, but do not
    // resend capped progress: the client treats that as newly claimable.
    const progress = Math.min(milestone.target, state.bonusDays);
    if (progress !== Math.min(milestone.target, previousBonusDays)) {
      publishNotice(characterID, {
        kind: "progressed",
        uuid: milestoneState.uuid,
        currentProgress: progress,
      });
    }
    if (!milestoneState.earnedAtMs && state.bonusDays >= milestone.target) {
      milestoneState.earnedAtMs = nowMs;
      publishNotice(characterID, { kind: "completed", uuid: milestoneState.uuid });
    }
  }
  log.info(
    `[DailyGoals] monthly bonus day char=${characterID} month=${state.monthKey} ` +
      `days=${state.bonusDays}`,
  );
}

function describeMilestone(state, milestone) {
  const milestoneState = state.milestones[milestone.key];
  return {
    uuid: milestoneState.uuid,
    milestone,
    target: milestone.target,
    omega: Boolean(milestone.omega),
    progress: Math.min(milestone.target, toInt(state.bonusDays)),
    bonusDays: toInt(state.bonusDays),
    earned: Boolean(milestoneState.earnedAtMs),
    claimed: Boolean(milestoneState.claimed),
    monthStartMs: state.monthStartMs,
    monthEndMs: state.monthEndMs,
  };
}

function findMilestoneByUuid(state, uuid) {
  const normalized = String(uuid || "").toLowerCase();
  for (const milestone of MONTHLY_MILESTONES) {
    const milestoneState = state.milestones[milestone.key];
    if (milestoneState && String(milestoneState.uuid).toLowerCase() === normalized) {
      return { milestone, milestoneState };
    }
  }
  return null;
}

// ---- public API ------------------------------------------------------------

// Returns descriptors for the character's current daily goals plus the bonus.
function getCurrentGoals(characterID, nowMs = getNowMs()) {
  const { root, entry, regenerated } = ensureCurrentState(characterID, nowMs);
  if (regenerated) {
    writeRoot(root);
  }
  return allGoalObjects(entry).map((goal) => describeGoal(entry, goal));
}

function getGoal(characterID, uuid, nowMs = getNowMs()) {
  const { root, entry, regenerated } = ensureCurrentState(characterID, nowMs);
  if (regenerated) {
    writeRoot(root);
  }
  const goal = findGoalObject(entry, uuid);
  return goal ? describeGoal(entry, goal) : null;
}

function getCurrentPeriod(nowMs = getNowMs()) {
  return currentPeriod(nowMs);
}

// Applies an increment to one goal, emitting a progress notice and completing it
// when the target is reached. Returns true if this call completed the goal.
function applyGoalProgress(numericCharacterID, entry, goal, template, increment, nowMs) {
  const previous = toInt(goal.progress);
  goal.progress = Math.min(template.target, previous + increment);
  if (goal.progress !== previous) {
    publishNotice(numericCharacterID, {
      kind: "progressed",
      uuid: goal.uuid,
      currentProgress: goal.progress,
    });
  }
  if (goal.progress >= template.target && !goal.completed) {
    // Daily goals are claimed by the player (the card's Claim button sends a
    // RedeemRequest), so completion does not auto-grant — the reward is granted
    // on redeem. The daily-completion bonus follows the same rule; see
    // updateBonusProgress.
    completeGoal(numericCharacterID, entry, goal, nowMs);
    return true;
  }
  return false;
}

// Advances progress for every active daily goal whose activity kind matches.
// `amount` is added to progress (1 per kill, units mined, LP earned, ...).
function recordActivity(characterID, activityKind, amount = 1, nowMs = getNowMs()) {
  const numericCharacterID = toInt(characterID);
  const increment = toInt(amount, 0);
  if (!numericCharacterID || !activityKind || increment <= 0) {
    return { matched: 0, completed: 0 };
  }
  const { root, entry } = ensureCurrentState(numericCharacterID, nowMs);
  let matched = 0;
  let completedNow = 0;

  for (const goal of entry.goals) {
    const template = templateForKey(goal.templateKey);
    if (!template || template.activityKind !== activityKind || goal.completed) {
      continue;
    }
    matched += 1;
    if (applyGoalProgress(numericCharacterID, entry, goal, template, increment, nowMs)) {
      completedNow += 1;
    }
  }

  if (completedNow > 0) {
    updateBonusProgress(numericCharacterID, root, entry, nowMs);
  }

  if (matched > 0) {
    writeRoot(root);
  }
  return { matched, completed: completedNow };
}

// De-duplicated progress: each distinct `uniqueKey` counts at most once toward
// the goal (e.g. one credit per cosmic signature resolved to 100%, regardless of
// how many times a re-scan re-reports it). Per-goal seen keys are persisted and
// reset with the daily rollover.
function recordUniqueActivity(characterID, activityKind, uniqueKey, nowMs = getNowMs()) {
  const numericCharacterID = toInt(characterID);
  const key = String(uniqueKey == null ? "" : uniqueKey).trim();
  if (!numericCharacterID || !activityKind || !key) {
    return { matched: 0, completed: 0, credited: false };
  }
  const { root, entry } = ensureCurrentState(numericCharacterID, nowMs);
  let matched = 0;
  let completedNow = 0;
  let credited = false;

  for (const goal of entry.goals) {
    const template = templateForKey(goal.templateKey);
    if (!template || template.activityKind !== activityKind || goal.completed) {
      continue;
    }
    matched += 1;
    const seen = Array.isArray(goal.seenKeys) ? goal.seenKeys : [];
    if (seen.includes(key)) {
      continue;
    }
    goal.seenKeys = [...seen, key];
    credited = true;
    if (applyGoalProgress(numericCharacterID, entry, goal, template, 1, nowMs)) {
      completedNow += 1;
    }
  }

  if (completedNow > 0) {
    updateBonusProgress(numericCharacterID, root, entry, nowMs);
  }

  if (credited) {
    writeRoot(root);
  }
  return { matched, completed: completedNow, credited };
}

function redeemGoal(characterID, uuid, nowMs = getNowMs()) {
  const numericCharacterID = toInt(characterID);
  const { root, entry } = ensureCurrentState(numericCharacterID, nowMs);
  const goal = findGoalObject(entry, uuid);
  if (!goal) {
    return { success: false, errorMsg: "GOAL_NOT_FOUND" };
  }
  if (!goal.completed) {
    return { success: false, errorMsg: "GOAL_NOT_COMPLETED" };
  }
  const prepared = prepareDailyGoalReward(root, numericCharacterID, goal);
  if (prepared) {
    const writeResult = writeRoot(root, { flush: true });
    if (!writeResult || !writeResult.success) {
      return { success: false, errorMsg: "REWARD_INTENT_WRITE_FAILED" };
    }
  } else {
    // Already redeemed (a re-claim, or an evermarks-paid completion): still emit
    // a redeemed notice so the client's claim button resolves instead of hanging.
    publishNotice(numericCharacterID, { kind: "redeemed", uuid: goal.uuid });
  }
  return { success: true, granted: Boolean(prepared) };
}

function redeemAll(characterID, nowMs = getNowMs()) {
  const numericCharacterID = toInt(characterID);
  const { root, entry } = ensureCurrentState(numericCharacterID, nowMs);
  let granted = 0;
  for (const goal of allGoalObjects(entry)) {
    if (goal.completed && !goal.redeemed) {
      if (prepareDailyGoalReward(root, numericCharacterID, goal)) {
        granted += 1;
      }
    }
  }
  if (granted > 0) {
    const writeResult = writeRoot(root, { flush: true });
    if (!writeResult || !writeResult.success) {
      return { success: false, errorMsg: "REWARD_INTENT_WRITE_FAILED" };
    }
  }
  return { success: true, granted };
}

// ---- Evermarks-paid completion ---------------------------------------------

// Evermark cost of the next paid completion today, or null if the daily cap
// (2 paid completions) is already reached.
function evermarkCostForNextPaidCompletion(entry) {
  const paid = toInt(entry.paidCompletions);
  if (paid >= MAX_PAID_COMPLETIONS_PER_DAY) {
    return null;
  }
  return paid === 0
    ? EM_PAID_COMPLETION_COST_FIRST
    : EM_PAID_COMPLETION_COST_SECOND;
}

// Completes a daily goal by paying Evermarks (2,500 EM for the first, 4,500 EM
// for the second, max 2 per day). The completion counts toward the daily bonus
// but grants no per-goal reward (it is not marked redeemable).
function payForCompletion(characterID, uuid, nowMs = getNowMs()) {
  const numericCharacterID = toInt(characterID);
  const { root, entry } = ensureCurrentState(numericCharacterID, nowMs);
  const goal = findGoalObject(entry, uuid);
  if (!goal || goal.templateKey === BONUS_TEMPLATE.key) {
    return { success: false, errorMsg: "GOAL_NOT_FOUND" };
  }
  if (goal.completed) {
    return { success: false, errorMsg: "ALREADY_COMPLETE" };
  }
  const cost = evermarkCostForNextPaidCompletion(entry);
  if (cost === null) {
    return { success: false, errorMsg: "MAX_PAID_COMPLETIONS" };
  }
  const balance = getEvermarkBalance(numericCharacterID);
  if (balance < cost) {
    return { success: false, errorMsg: "INSUFFICIENT_EVERMARKS", cost, balance };
  }
  if (!spendEvermarks(numericCharacterID, cost)) {
    return { success: false, errorMsg: "INSUFFICIENT_EVERMARKS", cost, balance };
  }
  entry.paidCompletions = toInt(entry.paidCompletions) + 1;
  goal.paidCompletion = true;
  // Mark redeemed so a later Redeem call can't also hand out the per-goal reward.
  goal.redeemed = true;
  completeGoal(numericCharacterID, entry, goal, nowMs);
  updateBonusProgress(numericCharacterID, root, entry, nowMs);
  writeRoot(root);
  log.info(
    `[DailyGoals] paid completion char=${numericCharacterID} goal=${goal.templateKey} cost=${cost}EM`,
  );
  return { success: true, cost };
}

// ---- monthly public API ----------------------------------------------------

// Descriptors for the 8 Monthly Reward Track milestones (4 Alpha + 4 Omega),
// with the character's current monthly progress. Applies any due auto-claims.
function getMonthlyMilestones(characterID, nowMs = getNowMs()) {
  const root = readRoot();
  const { state, changed } = ensureMonthlyState(root, characterID, nowMs);
  const claimedChanged = autoClaimDueMilestones(
    root,
    characterID,
    state,
    nowMs,
    false,
  );
  if (changed || claimedChanged) {
    writeRoot(root);
  }
  return MONTHLY_MILESTONES.map((milestone) => describeMilestone(state, milestone));
}

function getMonthlyMilestone(characterID, uuid, nowMs = getNowMs()) {
  const root = readRoot();
  const { state, changed } = ensureMonthlyState(root, characterID, nowMs);
  if (changed) {
    writeRoot(root);
  }
  const found = findMilestoneByUuid(state, uuid);
  return found ? describeMilestone(state, found.milestone) : null;
}

// Claims a single earned monthly milestone reward. Omega milestones require an
// Omega license. Idempotent for already-claimed milestones.
function claimMonthlyMilestone(characterID, uuid, nowMs = getNowMs()) {
  const numericCharacterID = toInt(characterID);
  const root = readRoot();
  const { state, changed } = ensureMonthlyState(
    root,
    numericCharacterID,
    nowMs,
  );
  const found = findMilestoneByUuid(state, uuid);
  if (!found) {
    if (changed) {
      writeRoot(root);
    }
    return { success: false, errorMsg: "MILESTONE_NOT_FOUND" };
  }
  const { milestone, milestoneState } = found;
  if (!milestoneState.earnedAtMs) {
    if (changed) {
      writeRoot(root);
    }
    return { success: false, errorMsg: "NOT_EARNED" };
  }
  if (milestoneState.claimed) {
    if (changed) {
      writeRoot(root);
    }
    return { success: true, granted: false };
  }
  if (milestone.omega && !characterHasOmega(numericCharacterID)) {
    if (changed) {
      writeRoot(root);
    }
    return { success: false, errorMsg: "OMEGA_REQUIRED" };
  }
  const prepared = prepareMonthlyMilestoneReward(
    root,
    numericCharacterID,
    milestone,
    milestoneState,
    nowMs,
  );
  const writeResult = writeRoot(root, { flush: true });
  if (!prepared || !writeResult || !writeResult.success) {
    return { success: false, errorMsg: "REWARD_INTENT_WRITE_FAILED" };
  }
  return { success: true, granted: true };
}

// Claims every earned, unclaimed, claimable monthly milestone.
function claimAllMonthlyMilestones(characterID, nowMs = getNowMs()) {
  const numericCharacterID = toInt(characterID);
  const root = readRoot();
  const { state, changed } = ensureMonthlyState(
    root,
    numericCharacterID,
    nowMs,
  );
  const hasOmega = characterHasOmega(numericCharacterID);
  let granted = 0;
  for (const milestone of MONTHLY_MILESTONES) {
    const milestoneState = state.milestones[milestone.key];
    if (!milestoneState || !milestoneState.earnedAtMs || milestoneState.claimed) {
      continue;
    }
    if (milestone.omega && !hasOmega) {
      continue;
    }
    if (prepareMonthlyMilestoneReward(
      root,
      numericCharacterID,
      milestone,
      milestoneState,
      nowMs,
    )) {
      granted += 1;
    }
  }
  if (granted > 0 || changed) {
    const writeResult = writeRoot(root, { flush: true });
    if (!writeResult || !writeResult.success) {
      return { success: false, errorMsg: "REWARD_INTENT_WRITE_FAILED" };
    }
  }
  return { success: true, granted };
}

module.exports = {
  CATEGORY,
  DURABLE_REWARD_JOB_TYPE,
  bindDurableScheduler,
  buildRewardSettlementJob,
  handleDurableRewardSettlement,
  registerNoticePublisher,
  getCurrentGoals,
  getGoal,
  getCurrentPeriod,
  recordActivity,
  recordUniqueActivity,
  redeemGoal,
  redeemAll,
  payForCompletion,
  getMonthlyMilestones,
  getMonthlyMilestone,
  claimMonthlyMilestone,
  claimAllMonthlyMilestones,
  listPendingRewardSettlements,
  reconcileDurableRewardSettlements,
  settlePendingReward,
  unbindDurableScheduler,
};
module.exports._testing = {
  setNowMsOverride,
  resetNowMsOverride,
  currentPeriod,
  monthContext,
  ensureCurrentState,
  ensureMonthlyState,
  templateForKey,
  characterHasOmega,
  buildRewardSettlementID,
  prepareRewardSettlement,
  TABLE_NAME,
};
