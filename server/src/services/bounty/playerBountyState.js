"use strict";

const path = require("path");
const crypto = require("crypto");

// Phase 0 / 0.C: bounty domain state via an ownership-scoped repository.
const {
  createTableRepository,
} = require(path.join(__dirname, "../../gameStore/tableRepository"));
const repo = createTableRepository("service:bounty", { strict: true });
const log = require(path.join(__dirname, "../../utils/logger"));
const {
  currentFileTime,
} = require(path.join(__dirname, "../_shared/serviceHelpers"));
const {
  adjustCharacterBalanceAsync,
  JOURNAL_ENTRY_TYPE,
} = require(path.join(__dirname, "../account/walletState"));
const {
  getCharacterRecord,
} = require(path.join(__dirname, "../character/characterState"));
const {
  isNpcEntity,
} = require(path.join(__dirname, "../_shared/abyssalNpcOutcomePolicy"));

const TABLE_NAME = "playerBounties";
const DURABLE_PAYOUT_JOB_TYPE = "player-bounty.payout";
const DURABLE_PAYOUT_JOB_PREFIX = "player-bounty:";
let durableScheduler = null;
const payoutLanes = new Map();

const OWNER_KIND = Object.freeze({
  CHARACTER: "character",
  CORPORATION: "corporation",
  ALLIANCE: "alliance",
  UNKNOWN: "unknown",
});

const OWNER_RANGES = Object.freeze({
  CHARACTER_GEN2_MIN: 90000000,
  CHARACTER_GEN2_MAX: 97999999,
  CHARACTER_GEN3_MIN: 2100000000,
  CHARACTER_GEN3_MAX: 2129999999,
  CORPORATION_MIN: 98000000,
  CORPORATION_MAX: 98999999,
  ALLIANCE_MIN: 99000000,
  ALLIANCE_MAX: 99999999,
});

const MINIMUM_BOUNTY_BY_KIND = Object.freeze({
  [OWNER_KIND.CHARACTER]: 1000000,
  [OWNER_KIND.CORPORATION]: 20000000,
  [OWNER_KIND.ALLIANCE]: 100000000,
});
const PLAYER_BOUNTY_PAYOUT_LOSS_RATIO = 0.2;

function cloneValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function toInteger(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function normalizeMoney(value, fallback = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.round(numeric * 100) / 100;
}

function emptyState() {
  return {
    nextContributionID: 1,
    pools: {},
    contributions: {},
    hunterStats: emptyHunterStats(),
    payoutsByID: {},
  };
}

function emptyHunterStats() {
  return {
    [OWNER_KIND.CHARACTER]: {},
    [OWNER_KIND.CORPORATION]: {},
    [OWNER_KIND.ALLIANCE]: {},
  };
}

function normalizeHunterStat(stat = {}, ownerKind = OWNER_KIND.UNKNOWN) {
  const bountyHunterID = toInteger(stat.bountyHunterID ?? stat.ownerID, 0);
  return {
    bountyHunterID,
    ownerKind,
    corporationID: toInteger(stat.corporationID, 0) || null,
    allianceID: toInteger(stat.allianceID, 0) || null,
    bountiesClaimed: Math.max(0, normalizeMoney(stat.bountiesClaimed, 0)),
    numberOfKills: Math.max(0, toInteger(stat.numberOfKills, 0)),
    updatedAt: String(stat.updatedAt || currentFileTime()),
  };
}

function normalizeHunterStats(rawStats = {}) {
  const normalized = emptyHunterStats();
  for (const ownerKind of [
    OWNER_KIND.CHARACTER,
    OWNER_KIND.CORPORATION,
    OWNER_KIND.ALLIANCE,
  ]) {
    const bucket = rawStats && rawStats[ownerKind] && typeof rawStats[ownerKind] === "object"
      ? rawStats[ownerKind]
      : {};
    for (const [bountyHunterID, stat] of Object.entries(bucket)) {
      const normalizedStat = normalizeHunterStat(
        {
          ...stat,
          bountyHunterID: stat && stat.bountyHunterID !== undefined
            ? stat.bountyHunterID
            : bountyHunterID,
        },
        ownerKind,
      );
      if (normalizedStat.bountyHunterID > 0) {
        normalized[ownerKind][String(normalizedStat.bountyHunterID)] = normalizedStat;
      }
    }
  }
  return normalized;
}

function normalizePayoutRecord(record = {}, fallbackPayoutID = "") {
  const payoutID = String(record.payoutID || fallbackPayoutID || "").trim();
  return {
    payoutID,
    status: record.status === "paid" ? "paid" : "pending",
    hunterCharacterID: toInteger(record.hunterCharacterID, 0),
    amount: Math.max(0, normalizeMoney(record.amount, 0)),
    lossValue: Math.max(0, normalizeMoney(record.lossValue, 0)),
    capAmount: Math.max(0, normalizeMoney(record.capAmount, 0)),
    allocations: Array.isArray(record.allocations)
      ? record.allocations
        .map((allocation) => ({
          targetID: toInteger(allocation && allocation.targetID, 0),
          amount: Math.max(0, normalizeMoney(allocation && allocation.amount, 0)),
        }))
        .filter((allocation) => allocation.targetID > 0 && allocation.amount > 0)
      : [],
    ownerID2: toInteger(record.ownerID2, 0),
    referenceID: toInteger(record.referenceID, 0),
    commandID: String(
      record.commandID || `${DURABLE_PAYOUT_JOB_PREFIX}${payoutID}:credit`,
    ).trim(),
    claimFingerprint: String(record.claimFingerprint || "").trim(),
    createdAt: String(record.createdAt || currentFileTime()),
    paidAt: record.paidAt ? String(record.paidAt) : null,
  };
}

function normalizePayoutRecords(rawPayouts = {}) {
  const normalized = {};
  for (const [payoutID, record] of Object.entries(
    rawPayouts && typeof rawPayouts === "object" ? rawPayouts : {},
  )) {
    const payout = normalizePayoutRecord(record, payoutID);
    if (
      payout.payoutID &&
      payout.hunterCharacterID > 0 &&
      payout.amount > 0 &&
      payout.commandID
    ) {
      normalized[payout.payoutID] = payout;
    }
  }
  return normalized;
}

function normalizeState(rawState = {}) {
  const state = rawState && typeof rawState === "object"
    ? cloneValue(rawState)
    : {};
  const normalized = emptyState();
  normalized.nextContributionID = Math.max(
    1,
    toInteger(state.nextContributionID, 1),
  );
  normalized.pools = state.pools && typeof state.pools === "object"
    ? state.pools
    : {};
  normalized.contributions =
    state.contributions && typeof state.contributions === "object"
      ? state.contributions
      : {};
  normalized.hunterStats = normalizeHunterStats(state.hunterStats);
  normalized.payoutsByID = normalizePayoutRecords(state.payoutsByID);
  return normalized;
}

function readState() {
  const result = repo.read(TABLE_NAME, "/");
  if (!result.success) {
    return emptyState();
  }
  return normalizeState(result.data);
}

function writeState(state) {
  return repo.write(TABLE_NAME, "/", normalizeState(state));
}

function flushStateDurably() {
  const result = repo.flushTableSync(TABLE_NAME);
  return result && result.success === true
    ? result
    : {
      success: false,
      errorMsg: result && result.errorMsg || "PLAYER_BOUNTY_FLUSH_FAILED",
    };
}

function runSerializedPayout(payoutID, operation) {
  const laneKey = String(payoutID || "").trim();
  const previous = payoutLanes.get(laneKey) || Promise.resolve();
  const current = previous.catch(() => null).then(operation);
  payoutLanes.set(laneKey, current);
  void current.finally(() => {
    if (payoutLanes.get(laneKey) === current) {
      payoutLanes.delete(laneKey);
    }
  }).catch(() => null);
  return current;
}

function buildDurablePayoutJob(payout) {
  const normalized = normalizePayoutRecord(payout);
  if (
    !normalized.payoutID ||
    normalized.status !== "pending" ||
    normalized.hunterCharacterID <= 0 ||
    !(normalized.amount > 0)
  ) {
    return null;
  }
  return {
    jobID: `${DURABLE_PAYOUT_JOB_PREFIX}${normalized.payoutID}:payout`,
    type: DURABLE_PAYOUT_JOB_TYPE,
    dueAtMs: Date.now(),
    payload: {
      payoutID: normalized.payoutID,
    },
  };
}

async function scheduleDurablePayout(payout) {
  if (!durableScheduler) {
    return null;
  }
  const job = buildDurablePayoutJob(payout);
  if (!job) {
    return null;
  }
  await durableScheduler.schedule(job);
  return job;
}

function queueDurablePayout(payout) {
  if (!durableScheduler) {
    return Promise.resolve(null);
  }
  const promise = scheduleDurablePayout(payout);
  void promise.catch((error) => {
    log.warn(
      `[PlayerBounty] Durable payout scheduling failed payout=${String(payout && payout.payoutID || "")}: ${error.message}`,
    );
  });
  return promise;
}

function bindDurableScheduler(scheduler) {
  if (!scheduler || typeof scheduler.schedule !== "function") {
    throw new TypeError("player bounty scheduler requires a schedule function");
  }
  durableScheduler = scheduler;
  return true;
}

function unbindDurableScheduler(scheduler = null) {
  if (scheduler && scheduler !== durableScheduler) {
    return false;
  }
  durableScheduler = null;
  payoutLanes.clear();
  return true;
}

function listPendingPayouts() {
  const state = readState();
  return Object.values(state.payoutsByID || {})
    .map((payout) => normalizePayoutRecord(payout))
    .filter((payout) => payout.status === "pending")
    .sort((left, right) => left.payoutID.localeCompare(right.payoutID));
}

async function reconcileDurablePayouts() {
  if (!durableScheduler) {
    return { scheduled: 0, pending: listPendingPayouts().length };
  }
  const pending = listPendingPayouts();
  for (const payout of pending) {
    await scheduleDurablePayout(payout);
  }
  return { scheduled: pending.length, pending: pending.length };
}

function readCorporationRecord(corporationID) {
  const recordsResult = repo.read("corporations", "/records");
  if (recordsResult.success && recordsResult.data) {
    const record = recordsResult.data[String(corporationID)];
    if (record) {
      return record;
    }
  }

  const directResult = repo.read("corporations", `/${corporationID}`);
  return directResult.success ? directResult.data : null;
}

function readAllianceRecord(allianceID) {
  const recordsResult = repo.read("alliances", "/records");
  if (recordsResult.success && recordsResult.data) {
    const record = recordsResult.data[String(allianceID)];
    if (record) {
      return record;
    }
  }

  const directResult = repo.read("alliances", `/${allianceID}`);
  return directResult.success ? directResult.data : null;
}

function isInRange(value, min, max) {
  return value >= min && value <= max;
}

function inferOwnerKind(ownerID) {
  const numericOwnerID = toInteger(ownerID, 0);
  if (numericOwnerID <= 0) {
    return OWNER_KIND.UNKNOWN;
  }

  if (getCharacterRecord(numericOwnerID)) {
    return OWNER_KIND.CHARACTER;
  }
  if (readCorporationRecord(numericOwnerID)) {
    return OWNER_KIND.CORPORATION;
  }
  if (readAllianceRecord(numericOwnerID)) {
    return OWNER_KIND.ALLIANCE;
  }
  if (
    isInRange(
      numericOwnerID,
      OWNER_RANGES.CHARACTER_GEN2_MIN,
      OWNER_RANGES.CHARACTER_GEN2_MAX,
    ) ||
    isInRange(
      numericOwnerID,
      OWNER_RANGES.CHARACTER_GEN3_MIN,
      OWNER_RANGES.CHARACTER_GEN3_MAX,
    )
  ) {
    return OWNER_KIND.CHARACTER;
  }
  if (
    isInRange(
      numericOwnerID,
      OWNER_RANGES.CORPORATION_MIN,
      OWNER_RANGES.CORPORATION_MAX,
    )
  ) {
    return OWNER_KIND.CORPORATION;
  }
  if (
    isInRange(
      numericOwnerID,
      OWNER_RANGES.ALLIANCE_MIN,
      OWNER_RANGES.ALLIANCE_MAX,
    )
  ) {
    return OWNER_KIND.ALLIANCE;
  }
  return OWNER_KIND.UNKNOWN;
}

function getMinimumBountyAmount(ownerID) {
  return MINIMUM_BOUNTY_BY_KIND[inferOwnerKind(ownerID)] || 0;
}

function resolveOwnerAffiliation(ownerID) {
  const targetID = toInteger(ownerID, 0);
  const targetKind = inferOwnerKind(targetID);
  let corporationID = null;
  let allianceID = null;

  if (targetKind === OWNER_KIND.CHARACTER) {
    const characterRecord = getCharacterRecord(targetID);
    corporationID =
      toInteger(characterRecord && characterRecord.corporationID, 0) || null;
    allianceID =
      toInteger(characterRecord && characterRecord.allianceID, 0) || null;
  } else if (targetKind === OWNER_KIND.CORPORATION) {
    corporationID = targetID;
    const corporationRecord = readCorporationRecord(targetID);
    allianceID =
      toInteger(corporationRecord && corporationRecord.allianceID, 0) || null;
  } else if (targetKind === OWNER_KIND.ALLIANCE) {
    allianceID = targetID;
  }

  return {
    targetID,
    targetKind,
    corporationID,
    allianceID,
  };
}

function normalizePool(pool = {}) {
  const targetID = toInteger(pool.targetID, 0);
  const affiliation = resolveOwnerAffiliation(targetID);
  return {
    ...affiliation,
    bounty: Math.max(0, normalizeMoney(pool.bounty, 0)),
    updatedAt: String(pool.updatedAt || currentFileTime()),
  };
}

function getPool(state = null, targetID = null) {
  let sourceState = state;
  let sourceTargetID = targetID;
  if (sourceTargetID === null || sourceTargetID === undefined) {
    sourceTargetID = sourceState;
    sourceState = readState();
  }
  if (!sourceState || typeof sourceState !== "object") {
    sourceState = readState();
  }
  const numericTargetID = toInteger(sourceTargetID, 0);
  if (numericTargetID <= 0) {
    return normalizePool({ targetID: numericTargetID, bounty: 0 });
  }
  return normalizePool(
    sourceState.pools[String(numericTargetID)] || {
      targetID: numericTargetID,
      bounty: 0,
    },
  );
}

function listPools(options = {}) {
  const state = options.state || readState();
  return Object.values(state.pools || {})
    .map((pool) => normalizePool(pool))
    .filter((pool) => pool.targetID > 0 && pool.bounty > 0);
}

function listPoolsByKind(ownerKind, options = {}) {
  return listPools(options)
    .filter((pool) => pool.targetKind === ownerKind)
    .sort((left, right) => right.bounty - left.bounty || left.targetID - right.targetID);
}

function listContributionsForContributor(contributorID, options = {}) {
  const numericContributorID = toInteger(contributorID, 0);
  if (numericContributorID <= 0) {
    return [];
  }
  const state = options.state || readState();
  return Object.values(state.contributions || {})
    .filter(
      (contribution) =>
        toInteger(contribution && contribution.contributorID, 0) ===
        numericContributorID,
    )
    .map((contribution) => ({
      ...resolveOwnerAffiliation(contribution.targetID),
      contributionID: toInteger(contribution.contributionID, 0),
      contributorID: numericContributorID,
      amount: Math.max(0, normalizeMoney(contribution.amount, 0)),
      createdAt: String(contribution.createdAt || currentFileTime()),
    }))
    .filter((contribution) => contribution.contributionID > 0)
    .sort((left, right) => right.contributionID - left.contributionID);
}

function listBountyHuntersByKind(ownerKind, options = {}) {
  const state = options.state || readState();
  const bucket =
    state.hunterStats &&
    state.hunterStats[ownerKind] &&
    typeof state.hunterStats[ownerKind] === "object"
      ? state.hunterStats[ownerKind]
      : {};
  return Object.values(bucket)
    .map((stat) => normalizeHunterStat(stat, ownerKind))
    .filter((stat) => stat.bountyHunterID > 0 && stat.bountiesClaimed > 0)
    .sort(
      (left, right) =>
        right.bountiesClaimed - left.bountiesClaimed ||
        right.numberOfKills - left.numberOfKills ||
        left.bountyHunterID - right.bountyHunterID,
    )
    .map((stat, index) => ({
      ...stat,
      rowNumber: index + 1,
    }));
}

function collectVictimBountyPools(state, victim = {}) {
  const targetIDs = [
    victim.victimCharacterID,
    victim.characterID,
    victim.victimCorporationID,
    victim.corporationID,
    victim.victimAllianceID,
    victim.allianceID,
  ]
    .map((value) => toInteger(value, 0))
    .filter((value, index, values) => value > 0 && values.indexOf(value) === index);

  return targetIDs
    .map((targetID) => getPool(state, targetID))
    .filter((pool) => pool.targetID > 0 && pool.bounty > 0);
}

function allocatePayoutAcrossPools(pools, payoutAmount) {
  const totalBounty = normalizeMoney(
    pools.reduce((sum, pool) => sum + Math.max(0, normalizeMoney(pool.bounty, 0)), 0),
    0,
  );
  let remainingPayout = Math.min(normalizeMoney(payoutAmount, 0), totalBounty);
  const allocations = [];

  pools.forEach((pool) => {
    if (remainingPayout <= 0) {
      return;
    }
    const poolBounty = Math.max(0, normalizeMoney(pool.bounty, 0));
    const amount = normalizeMoney(Math.min(poolBounty, remainingPayout), 0);
    if (amount > 0) {
      allocations.push({
        targetID: pool.targetID,
        amount,
      });
      remainingPayout = normalizeMoney(remainingPayout - amount, 0);
    }
  });

  return allocations.filter((allocation) => allocation.amount > 0);
}

function buildHunterIdentity(hunterCharacterID) {
  const characterID = toInteger(hunterCharacterID, 0);
  const characterRecord = characterID > 0 ? getCharacterRecord(characterID) : null;
  return {
    characterID,
    corporationID:
      toInteger(characterRecord && characterRecord.corporationID, 0) || null,
    allianceID:
      toInteger(characterRecord && characterRecord.allianceID, 0) || null,
  };
}

function incrementHunterStat(state, ownerKind, bountyHunterID, amount, affiliation = {}) {
  const numericBountyHunterID = toInteger(bountyHunterID, 0);
  const normalizedAmount = normalizeMoney(amount, 0);
  if (numericBountyHunterID <= 0 || !(normalizedAmount > 0)) {
    return;
  }

  if (!state.hunterStats || typeof state.hunterStats !== "object") {
    state.hunterStats = emptyHunterStats();
  }
  if (!state.hunterStats[ownerKind]) {
    state.hunterStats[ownerKind] = {};
  }

  const currentStat = normalizeHunterStat(
    state.hunterStats[ownerKind][String(numericBountyHunterID)] || {
      bountyHunterID: numericBountyHunterID,
    },
    ownerKind,
  );
  state.hunterStats[ownerKind][String(numericBountyHunterID)] = {
    ...currentStat,
    bountyHunterID: numericBountyHunterID,
    corporationID:
      toInteger(affiliation.corporationID, 0) ||
      currentStat.corporationID ||
      null,
    allianceID:
      toInteger(affiliation.allianceID, 0) ||
      currentStat.allianceID ||
      null,
    bountiesClaimed: normalizeMoney(currentStat.bountiesClaimed + normalizedAmount, 0),
    numberOfKills: currentStat.numberOfKills + 1,
    updatedAt: String(currentFileTime()),
  };
}

function recordHunterPayout(state, hunterCharacterID, payoutAmount) {
  const hunter = buildHunterIdentity(hunterCharacterID);
  if (hunter.characterID <= 0 || !(normalizeMoney(payoutAmount, 0) > 0)) {
    return;
  }

  incrementHunterStat(
    state,
    OWNER_KIND.CHARACTER,
    hunter.characterID,
    payoutAmount,
    {
      corporationID: hunter.corporationID,
      allianceID: hunter.allianceID,
    },
  );
  if (hunter.corporationID) {
    incrementHunterStat(
      state,
      OWNER_KIND.CORPORATION,
      hunter.corporationID,
      payoutAmount,
      {
        corporationID: hunter.corporationID,
        allianceID: hunter.allianceID,
      },
    );
  }
  if (hunter.allianceID) {
    incrementHunterStat(
      state,
      OWNER_KIND.ALLIANCE,
      hunter.allianceID,
      payoutAmount,
      {
        allianceID: hunter.allianceID,
      },
    );
  }
}

function buildPayoutClaimFingerprint({
  hunterCharacterID,
  victim = {},
  iskLost,
  referenceID,
}) {
  return JSON.stringify({
    hunterCharacterID: toInteger(hunterCharacterID, 0),
    victimCharacterID: toInteger(
      victim.victimCharacterID ?? victim.characterID,
      0,
    ),
    victimCorporationID: toInteger(
      victim.victimCorporationID ?? victim.corporationID,
      0,
    ),
    victimAllianceID: toInteger(
      victim.victimAllianceID ?? victim.allianceID,
      0,
    ),
    iskLost: normalizeMoney(iskLost, 0),
    referenceID: toInteger(referenceID, 0),
  });
}

function buildPayoutDescription(payout) {
  return JSON.stringify({
    playerBounty: true,
    payoutID: payout.payoutID,
    targetIDs: payout.allocations.map((allocation) => allocation.targetID),
    iskLost: payout.lossValue,
    capAmount: payout.capAmount,
  });
}

function settlePendingPayout(payoutID) {
  const normalizedPayoutID = String(payoutID || "").trim();
  return runSerializedPayout(normalizedPayoutID, async () => {
    const initialState = readState();
    const payout = normalizePayoutRecord(
      initialState.payoutsByID[normalizedPayoutID],
      normalizedPayoutID,
    );
    if (!payout.payoutID || !(payout.amount > 0)) {
      return { success: true, alreadySettled: true, missing: true };
    }
    if (payout.status === "paid") {
      return { success: true, alreadySettled: true, data: payout };
    }

    const creditResult = await adjustCharacterBalanceAsync(
      payout.hunterCharacterID,
      payout.amount,
      {
        entryTypeID: JOURNAL_ENTRY_TYPE.NPC_BOUNTY_PRIZE,
        description: buildPayoutDescription(payout),
        idempotencyKey: payout.commandID,
        ownerID1: payout.hunterCharacterID,
        ownerID2: payout.ownerID2,
        referenceID: payout.referenceID || payout.hunterCharacterID,
      },
      {
        commandID: payout.commandID,
        idempotencyKey: payout.commandID,
        source: "player-bounty-payout",
      },
    );
    if (!creditResult || creditResult.success !== true) {
      return creditResult || {
        success: false,
        errorMsg: "PLAYER_BOUNTY_CREDIT_FAILED",
      };
    }

    const latestState = readState();
    const latestPayout = normalizePayoutRecord(
      latestState.payoutsByID[normalizedPayoutID],
      normalizedPayoutID,
    );
    if (!latestPayout.payoutID) {
      throw new Error(`player bounty payout ${normalizedPayoutID} was lost`);
    }
    if (latestPayout.status !== "paid") {
      latestState.payoutsByID[normalizedPayoutID] = {
        ...latestPayout,
        status: "paid",
        paidAt: String(currentFileTime()),
      };
      const writeResult = writeState(latestState);
      if (!writeResult || writeResult.success !== true) {
        throw new Error(
          writeResult && writeResult.errorMsg ||
            `player bounty payout ${normalizedPayoutID} checkpoint failed`,
        );
      }
      const flushResult = flushStateDurably();
      if (!flushResult.success) {
        throw new Error(flushResult.errorMsg);
      }
    }
    return {
      success: true,
      alreadySettled: false,
      data: normalizePayoutRecord(
        readState().payoutsByID[normalizedPayoutID],
        normalizedPayoutID,
      ),
    };
  });
}

async function handleDurablePayout(job) {
  const payoutID = String(
    job && job.payload && job.payload.payoutID || "",
  ).trim();
  if (!payoutID) {
    throw new Error("player bounty payout job is missing its payout ID");
  }
  const payoutBefore = readState().payoutsByID[payoutID];
  if (!payoutBefore || payoutBefore.status === "paid") {
    return { payoutID, alreadySettled: true };
  }
  const result = await settlePendingPayout(payoutID);
  if (!result || result.success !== true) {
    throw new Error(
      result && result.errorMsg ||
        `player bounty payout ${payoutID} remains pending`,
    );
  }
  const settled = normalizePayoutRecord(readState().payoutsByID[payoutID]);
  if (settled.status !== "paid") {
    throw new Error(`player bounty payout ${payoutID} remains pending`);
  }
  return {
    payoutID,
    alreadySettled: Boolean(result.alreadySettled),
    amount: settled.amount,
  };
}

function claimBountyPayout({
  victim = {},
  victimEntity = null,
  iskLost = 0,
  hunterCharacterID = 0,
  payoutID = null,
  ownerID2 = 0,
  referenceID = 0,
} = {}) {
  const numericHunterCharacterID = toInteger(hunterCharacterID, 0);
  const victimCharacterID = toInteger(
    victim.victimCharacterID ?? victim.characterID,
    0,
  );
  if (isNpcEntity(victimEntity || victim)) {
    return {
      eligible: false,
      amount: 0,
      reason: "NPC_VICTIM",
    };
  }
  if (
    numericHunterCharacterID <= 0 ||
    !getCharacterRecord(numericHunterCharacterID) ||
    (victimCharacterID > 0 && numericHunterCharacterID === victimCharacterID)
  ) {
    return {
      eligible: false,
      amount: 0,
      reason: "NO_ELIGIBLE_HUNTER",
    };
  }

  const normalizedPayoutID = String(payoutID || crypto.randomUUID()).trim();
  const normalizedReferenceID =
    toInteger(referenceID, 0) ||
    toInteger(victimEntity && victimEntity.itemID, 0) ||
    victimCharacterID ||
    numericHunterCharacterID;
  const claimFingerprint = buildPayoutClaimFingerprint({
    hunterCharacterID: numericHunterCharacterID,
    victim,
    iskLost,
    referenceID: normalizedReferenceID,
  });
  const state = readState();
  const existingPayout = state.payoutsByID[normalizedPayoutID];
  if (existingPayout) {
    const normalizedExisting = normalizePayoutRecord(
      existingPayout,
      normalizedPayoutID,
    );
    if (
      normalizedExisting.claimFingerprint &&
      normalizedExisting.claimFingerprint !== claimFingerprint
    ) {
      return {
        eligible: false,
        amount: 0,
        reason: "PAYOUT_ID_REUSED",
      };
    }
    return {
      eligible: true,
      duplicate: true,
      payoutID: normalizedExisting.payoutID,
      payoutStatus: normalizedExisting.status,
      amount: normalizedExisting.amount,
      lossValue: normalizedExisting.lossValue,
      capAmount: normalizedExisting.capAmount,
      allocations: cloneValue(normalizedExisting.allocations),
    };
  }

  const cappedByLoss = normalizeMoney(
    Math.max(0, normalizeMoney(iskLost, 0)) * PLAYER_BOUNTY_PAYOUT_LOSS_RATIO,
    0,
  );
  if (!(cappedByLoss > 0)) {
    return {
      eligible: false,
      amount: 0,
      reason: "NO_LOSS_VALUE",
    };
  }

  const pools = collectVictimBountyPools(state, victim);
  if (pools.length <= 0) {
    return {
      eligible: false,
      amount: 0,
      reason: "NO_BOUNTY_POOL",
    };
  }

  const totalBounty = normalizeMoney(
    pools.reduce((sum, pool) => sum + Math.max(0, normalizeMoney(pool.bounty, 0)), 0),
    0,
  );
  const payoutAmount = normalizeMoney(Math.min(cappedByLoss, totalBounty), 0);
  const allocations = allocatePayoutAcrossPools(pools, payoutAmount);
  if (allocations.length <= 0) {
    return {
      eligible: false,
      amount: 0,
      reason: "NO_ALLOCATION",
    };
  }

  const previousState = cloneValue(state);
  const now = String(currentFileTime());
  for (const allocation of allocations) {
    const pool = getPool(state, allocation.targetID);
    const nextBounty = normalizeMoney(
      Math.max(0, normalizeMoney(pool.bounty, 0) - allocation.amount),
      0,
    );
    state.pools[String(allocation.targetID)] = {
      ...pool,
      bounty: nextBounty,
      updatedAt: now,
    };
  }
  recordHunterPayout(state, numericHunterCharacterID, payoutAmount);

  const settledAmount = normalizeMoney(
    allocations.reduce((sum, allocation) => sum + allocation.amount, 0),
    0,
  );
  const payout = normalizePayoutRecord({
    payoutID: normalizedPayoutID,
    hunterCharacterID: numericHunterCharacterID,
    amount: settledAmount,
    lossValue: normalizeMoney(iskLost, 0),
    capAmount: cappedByLoss,
    allocations,
    ownerID2:
      toInteger(ownerID2, 0) ||
      victimCharacterID ||
      toInteger(victim.victimCorporationID ?? victim.corporationID, 0) ||
      toInteger(victim.victimAllianceID ?? victim.allianceID, 0),
    referenceID: normalizedReferenceID,
    claimFingerprint,
    createdAt: now,
  });
  state.payoutsByID[normalizedPayoutID] = payout;

  const writeResult = writeState(state);
  if (!writeResult || !writeResult.success) {
    return {
      eligible: false,
      amount: 0,
      reason: writeResult && writeResult.errorMsg || "WRITE_ERROR",
    };
  }
  const flushResult = flushStateDurably();
  if (!flushResult.success) {
    writeState(previousState);
    flushStateDurably();
    return {
      eligible: false,
      amount: 0,
      reason: flushResult.errorMsg,
    };
  }
  queueDurablePayout(payout);

  return {
    eligible: true,
    duplicate: false,
    payoutID: normalizedPayoutID,
    payoutStatus: "pending",
    amount: settledAmount,
    lossValue: normalizeMoney(iskLost, 0),
    capAmount: cappedByLoss,
    allocations,
  };
}

function placeBounty({ targetID, amount, contributorID }) {
  const numericTargetID = toInteger(targetID, 0);
  const numericContributorID = toInteger(contributorID, 0);
  const normalizedAmount = normalizeMoney(amount, 0);
  const minimumAmount = getMinimumBountyAmount(numericTargetID);
  if (numericTargetID <= 0 || inferOwnerKind(numericTargetID) === OWNER_KIND.UNKNOWN) {
    return {
      success: false,
      errorMsg: "INVALID_TARGET",
      minimumAmount,
    };
  }
  if (!(normalizedAmount > 0) || normalizedAmount < minimumAmount) {
    return {
      success: false,
      errorMsg: "AMOUNT_TOO_LOW",
      minimumAmount,
    };
  }
  if (numericContributorID <= 0) {
    return {
      success: false,
      errorMsg: "CHARACTER_NOT_FOUND",
      minimumAmount,
    };
  }

  const state = readState();
  const contributionID = Math.max(1, toInteger(state.nextContributionID, 1));
  const now = String(currentFileTime());
  const affiliation = resolveOwnerAffiliation(numericTargetID);
  const currentPool = getPool(state, numericTargetID);
  const nextPool = {
    ...affiliation,
    bounty: normalizeMoney(currentPool.bounty + normalizedAmount, 0),
    updatedAt: now,
  };
  const contribution = {
    ...affiliation,
    contributionID,
    contributorID: numericContributorID,
    amount: normalizedAmount,
    createdAt: now,
  };

  state.nextContributionID = contributionID + 1;
  state.pools[String(numericTargetID)] = nextPool;
  state.contributions[String(contributionID)] = contribution;

  const writeResult = writeState(state);
  if (!writeResult.success) {
    return writeResult;
  }

  return {
    success: true,
    pool: normalizePool(nextPool),
    contribution,
  };
}

function resetStateForTests(nextState = emptyState()) {
  payoutLanes.clear();
  return writeState(normalizeState(nextState));
}

module.exports = {
  DURABLE_PAYOUT_JOB_TYPE,
  TABLE_NAME,
  OWNER_KIND,
  bindDurableScheduler,
  buildDurablePayoutJob,
  getMinimumBountyAmount,
  inferOwnerKind,
  resolveOwnerAffiliation,
  getPool,
  listPools,
  listPoolsByKind,
  listContributionsForContributor,
  listBountyHuntersByKind,
  listPendingPayouts,
  claimBountyPayout,
  handleDurablePayout,
  placeBounty,
  reconcileDurablePayouts,
  settlePendingPayout,
  unbindDurableScheduler,
  _testing: {
    emptyState,
    readState,
    writeState,
    resetStateForTests,
  },
};
