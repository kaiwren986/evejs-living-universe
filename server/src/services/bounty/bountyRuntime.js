"use strict";

const {
  toFiniteNumber,
} = require("../../common/numbers");
const { cloneValue } = require("../../common/clone");

const path = require("path");
const { performance } = require("perf_hooks");

const log = require(path.join(__dirname, "../../utils/logger"));

// Phase 0 / 0.C: bounty domain state via an ownership-scoped repository.
const {
  createTableRepository,
} = require(path.join(__dirname, "../../gameStore/tableRepository"));
const repo = createTableRepository("service:bounty", { strict: true });
const sessionRegistry = require(path.join(__dirname, "../chat/sessionRegistry"));
const {
  JOURNAL_ENTRY_TYPE,
  adjustCharacterBalanceAsync,
} = require(path.join(__dirname, "../account/walletState"));
const {
  buildKeyVal,
} = require(path.join(__dirname, "../_shared/serviceHelpers"));
const {
  resolveExactAbyssalNpcOutcomeContext,
  shouldSuppressResolvedAbyssalNpcOutcome,
} = require(path.join(__dirname, "../_shared/abyssalNpcOutcomePolicy"));
const {
  ENTITY_TYPE,
} = require(path.join(__dirname, "../../space/entityConstants"));

const PENDING_TABLE_NAME = "pendingNpcBounties";
const ess = require("../dynamic/essSettlementRuntime");
const bountyBootID = require("node:crypto").randomUUID();
let recordedEvents = {};
const DURABLE_PAYOUT_JOB_TYPE = "npc-bounty.payout";
const DURABLE_PAYOUT_JOB_PREFIX = "npc-bounty:";

const FILETIME_EPOCH_OFFSET = 116444736000000000n;
const FILETIME_TICKS_PER_MS = 10000n;
const DEFAULT_PAYOUT_INTERVAL_MS = 20 * 60 * 1000;
const ATTRIBUTE_FAST_TALK_PERCENTAGE = 359;
const SECURITY_STATUS_RECOVERY_MODIFIER_PER_ISK = 1 / 100_000_000;
const SECURITY_STATUS_RECOVERY_MODIFIER_CAP = 0.0025;
const SECURITY_STATUS_RECOVERY_ROUND_DIGITS = 4;

let payoutIntervalMs = DEFAULT_PAYOUT_INTERVAL_MS;
let nowProvider = () => Date.now();
let timerEnabled = true;
let payoutTimer = null;
let payoutFlushPromise = null;
let nextDueAtMs = Number.POSITIVE_INFINITY;
let durableScheduler = null;
let durableScheduleLane = Promise.resolve();
let durableSchedulerGeneration = 0;
let persistenceEnabled = true;
let persistenceLoaded = false;
let pendingPersistenceRollback = null;
let characterStateModule = null;
let crimewatchStateModule = null;
let standingRuntimeModule = null;
let corporationTaxModule = null;
let corpWalletStateModule = null;
let securityTaxModule = null;
let fleetShareModule = null;
const ESS_FUNDING_FIELDS = Object.freeze(["essMainBankAmount", "reserveBankAmount", "grossAmount"]);

const bucketsByKey = new Map();
// NPC item ID -> keys of the buckets that recorded it, so a kill's once-only
// check reads only those buckets. A hint: findBucketBySourceReference confirms
// each key against the bucket itself, so a bucket removed, rolled back or
// reloaded leaves only stale keys behind, which it drops.
const bucketKeysBySourceReference = new Map();

function getCharacterStateModule() {
  if (!characterStateModule) {
    characterStateModule = require(path.join(__dirname, "../character/characterState"));
  }
  return characterStateModule;
}

function getCrimewatchStateModule() {
  if (!crimewatchStateModule) {
    crimewatchStateModule = require(path.join(__dirname, "../security/crimewatchState"));
  }
  return crimewatchStateModule;
}

function getCorporationTaxModule() {
  if (!corporationTaxModule) {
    corporationTaxModule = require(path.join(__dirname, "../corporation/corporationTax"));
  }
  return corporationTaxModule;
}

function getSecurityTaxModule() {
  if (!securityTaxModule) {
    securityTaxModule = require(path.join(__dirname, "../security/securityTax"));
  }
  return securityTaxModule;
}

function getCorpWalletStateModule() {
  if (!corpWalletStateModule) {
    corpWalletStateModule = require(path.join(__dirname, "../corporation/corpWalletState"));
  }
  return corpWalletStateModule;
}

// Fleet share → Bounty sharers, Even split.
function getFleetShareModule() {
  if (!fleetShareModule) {
    fleetShareModule = require(path.join(__dirname, "../fleetShare/fleetShare"));
  }
  return fleetShareModule;
}

function getStandingRuntimeModule() {
  if (!standingRuntimeModule) {
    standingRuntimeModule = require(path.join(__dirname, "../character/standingRuntime"));
  }
  return standingRuntimeModule;
}

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function toPositiveInt(value, fallback = null) {
  const numeric = toInt(value, 0);
  return numeric > 0 ? numeric : fallback;
}

function normalizeMoney(value, fallback = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.round(numeric * 100) / 100;
}

function roundNumber(value, digits = 6) {
  const numeric = toFiniteNumber(value, 0);
  const factor = 10 ** Math.max(0, Math.trunc(toFiniteNumber(digits, 0)));
  return Math.round(numeric * factor) / factor;
}

function formatFiletime(whenMs) {
  const normalizedWhenMs = Number.isFinite(Number(whenMs))
    ? Math.trunc(Number(whenMs))
    : nowProvider();
  return (
    BigInt(normalizedWhenMs) * FILETIME_TICKS_PER_MS +
    FILETIME_EPOCH_OFFSET
  ).toString();
}

function resolvePayoutAtMs(nowMs = nowProvider()) {
  const interval = Math.max(1, toInt(payoutIntervalMs, DEFAULT_PAYOUT_INTERVAL_MS));
  const normalizedNowMs = Number.isFinite(Number(nowMs))
    ? Math.trunc(Number(nowMs))
    : nowProvider();
  return normalizedNowMs + interval;
}

function buildBucketKey(characterID, solarSystemID, payoutTime) {
  return `${toPositiveInt(characterID, 0) || 0}:${toPositiveInt(solarSystemID, 0) || 0}:${String(payoutTime || "")}`;
}

function findActivePayoutAtMsForCharacter(characterID, nowMs = nowProvider()) {
  const normalizedCharacterID = toPositiveInt(characterID, 0) || 0;
  const normalizedNowMs = Number.isFinite(Number(nowMs))
    ? Math.trunc(Number(nowMs))
    : nowProvider();
  if (normalizedCharacterID <= 0) {
    return null;
  }

  let activePayoutAtMs = Number.POSITIVE_INFINITY;
  for (const bucket of bucketsByKey.values()) {
    if (
      bucket &&
      toPositiveInt(bucket.characterID, 0) === normalizedCharacterID &&
      toFiniteNumber(bucket.payoutAtMs, 0) > normalizedNowMs &&
      toFiniteNumber(bucket.payoutAtMs, 0) < activePayoutAtMs
    ) {
      activePayoutAtMs = toFiniteNumber(bucket.payoutAtMs, 0);
    }
  }

  return Number.isFinite(activePayoutAtMs) ? activePayoutAtMs : null;
}

function resolvePayoutAtMsForCharacter(characterID, nowMs = nowProvider()) {
  return findActivePayoutAtMsForCharacter(characterID, nowMs) || resolvePayoutAtMs(nowMs);
}

function isNpcVictim(entity) {
  if (!entity) {
    return false;
  }
  const npcEntityType = String(entity.npcEntityType || "").trim().toLowerCase();
  return (
    entity.nativeNpc === true ||
    entity.nativeNpcOccupied === true ||
    npcEntityType === ENTITY_TYPE.NPC ||
    npcEntityType === ENTITY_TYPE.CONCORD
  );
}

function isPlayerVictim(entity) {
  if (isNpcVictim(entity)) {
    return false;
  }
  return toPositiveInt(entity && (entity.pilotCharacterID ?? entity.characterID), null) !== null;
}

function resolveAttackerCharacterID(finalAttacker = {}, context = {}) {
  const attacker = finalAttacker || {};
  const candidates = [
    context.characterID,
    attacker.characterID,
    attacker.charID,
    attacker.charid,
    attacker.pilotCharacterID,
    attacker.ownerCharacterID,
    attacker.controllerOwnerID,
    attacker.sourceOwnerID,
    attacker.session && attacker.session.characterID,
    attacker.session && attacker.session.charID,
    attacker.session && attacker.session.charid,
  ];
  for (const candidate of candidates) {
    const characterID = toPositiveInt(candidate, null);
    if (characterID) {
      return characterID;
    }
  }
  return null;
}

function resolveAuthoredMultiplier(entity = {}, context = {}) {
  const candidates = [
    context.bountyPayoutMultiplier,
    context.bountyPayOutMultiplier,
    entity.bountyPayoutMultiplier,
    entity.bountyPayOutMultiplier,
    entity.spawnBountyPayoutMultiplier,
    entity.spawnBountyPayOutMultiplier,
  ];
  for (const candidate of candidates) {
    const numeric = Number(candidate);
    if (Number.isFinite(numeric) && numeric >= 0) {
      return numeric;
    }
  }
  return 1;
}

function resolveSolarSystemBountyMultiplier(solarSystemID, _context = {}) {
  const dbs = require("../dynamic/dynamicBountyRuntime");
  dbs.ensureSystem(solarSystemID);
  return dbs.getOutput(solarSystemID).output;
}

function resolveEssBountySplit(solarSystemID, amount, context = {}) {
  if (context.scene) require("../dynamic/dynamicResourceState").ensureAuthoredEss(context.scene);
  return ess.splitBounty(solarSystemID, amount);
}

function resolveCharacterRecord(characterID) {
  const characterState = getCharacterStateModule();
  return characterState && typeof characterState.getCharacterRecord === "function"
    ? characterState.getCharacterRecord(characterID)
    : null;
}

function resolveExplicitSecurityStatusRecoveryModifier(victimEntity = {}, context = {}) {
  const candidates = [
    context.securityStatusRecoveryModifier,
    context.securityStatusGainModifier,
    victimEntity.securityStatusRecoveryModifier,
    victimEntity.securityStatusGainModifier,
  ];
  for (const candidate of candidates) {
    const numeric = Number(candidate);
    if (Number.isFinite(numeric) && numeric >= 0) {
      return numeric;
    }
  }
  return null;
}

function resolveSecurityStatusRecoveryBaseModifier(victimEntity = {}, resolution = {}, context = {}) {
  const explicitModifier = resolveExplicitSecurityStatusRecoveryModifier(victimEntity, context);
  if (explicitModifier !== null) {
    return explicitModifier;
  }

  const amount = Math.max(0, normalizeMoney(resolution && resolution.amount, 0));
  if (!(amount > 0)) {
    return 0;
  }
  return Math.min(
    SECURITY_STATUS_RECOVERY_MODIFIER_CAP,
    amount * SECURITY_STATUS_RECOVERY_MODIFIER_PER_ISK,
  );
}

function resolveFastTalkSecurityStatusMultiplier(characterID) {
  const standingRuntime = getStandingRuntimeModule();
  if (
    !standingRuntime ||
    typeof standingRuntime.getCharacterSocialAttribute !== "function"
  ) {
    return 1;
  }
  const multiplier = toFiniteNumber(
    standingRuntime.getCharacterSocialAttribute(
      characterID,
      ATTRIBUTE_FAST_TALK_PERCENTAGE,
      1,
    ),
    1,
  );
  return Math.max(0, multiplier);
}

function findSessionForCharacter(characterID, finalAttacker = {}, context = {}) {
  const directSession =
    context.session ||
    context.attackerSession ||
    finalAttacker.session ||
    null;
  if (
    directSession &&
    toPositiveInt(
      directSession.characterID ?? directSession.charID ?? directSession.charid,
      0,
    ) === characterID
  ) {
    return directSession;
  }

  if (typeof sessionRegistry.findSessionByCharacterID === "function") {
    return sessionRegistry.findSessionByCharacterID(characterID) || null;
  }

  return sessionRegistry
    .getSessions()
    .find((session) =>
      toPositiveInt(session && (session.characterID ?? session.charID ?? session.charid), 0) ===
        characterID
    ) || null;
}

function buildSecurityStatusRecoveryResult({
  applied = false,
  reason = "NOT_APPLIED",
  characterID = 0,
  previousSecurityStatus = 0,
  nextSecurityStatus = previousSecurityStatus,
  baseModifier = 0,
  fastTalkMultiplier = 1,
  modifier = 0,
} = {}) {
  return {
    applied,
    reason,
    characterID: toPositiveInt(characterID, 0) || 0,
    previousSecurityStatus: roundNumber(previousSecurityStatus, SECURITY_STATUS_RECOVERY_ROUND_DIGITS),
    nextSecurityStatus: roundNumber(nextSecurityStatus, SECURITY_STATUS_RECOVERY_ROUND_DIGITS),
    deltaSecurityStatus: roundNumber(
      toFiniteNumber(nextSecurityStatus, 0) - toFiniteNumber(previousSecurityStatus, 0),
      SECURITY_STATUS_RECOVERY_ROUND_DIGITS,
    ),
    baseModificationPercent: roundNumber(toFiniteNumber(baseModifier, 0) * 100, 6),
    fastTalkMultiplier: roundNumber(fastTalkMultiplier, 6),
    modificationPercent: roundNumber(toFiniteNumber(modifier, 0) * 100, 6),
  };
}

function applySecurityStatusRecovery(characterID, victimEntity, finalAttacker, resolution, context = {}) {
  const normalizedCharacterID = toPositiveInt(characterID, 0);
  if (!normalizedCharacterID || context.applySecurityStatusRecovery === false) {
    return null;
  }

  if (!resolveCharacterRecord(normalizedCharacterID)) {
    return null;
  }

  const baseModifier = resolveSecurityStatusRecoveryBaseModifier(victimEntity, resolution, context);
  const fastTalkMultiplier = resolveFastTalkSecurityStatusMultiplier(normalizedCharacterID);
  const modifier = baseModifier * fastTalkMultiplier;
  const crimewatchState = getCrimewatchStateModule();
  const previousSecurityStatus = crimewatchState.getCharacterSecurityStatus(normalizedCharacterID, 0);
  if (!(modifier > 0)) {
    return buildSecurityStatusRecoveryResult({
      reason: "NO_RECOVERY_MODIFIER",
      characterID: normalizedCharacterID,
      previousSecurityStatus,
      baseModifier,
      fastTalkMultiplier,
      modifier,
    });
  }

  const maxSecurityStatus = toFiniteNumber(crimewatchState.SECURITY_STATUS_MAX, 10);
  const nextSecurityStatus = Math.min(
    maxSecurityStatus,
    previousSecurityStatus + ((maxSecurityStatus - previousSecurityStatus) * modifier),
  );
  if (
    Number(roundNumber(nextSecurityStatus, SECURITY_STATUS_RECOVERY_ROUND_DIGITS)) ===
      Number(roundNumber(previousSecurityStatus, SECURITY_STATUS_RECOVERY_ROUND_DIGITS))
  ) {
    return buildSecurityStatusRecoveryResult({
      reason: "SECURITY_STATUS_CEILING_REACHED",
      characterID: normalizedCharacterID,
      previousSecurityStatus,
      nextSecurityStatus: previousSecurityStatus,
      baseModifier,
      fastTalkMultiplier,
      modifier,
    });
  }

  const updateResult = crimewatchState.setCharacterSecurityStatus(
    normalizedCharacterID,
    nextSecurityStatus,
    {
      scene: context.scene || finalAttacker.scene || null,
      entity: context.entity || finalAttacker.entity || finalAttacker.attackerEntity || null,
      session: findSessionForCharacter(normalizedCharacterID, finalAttacker, context),
      now: context.nowMs,
    },
  );
  if (!updateResult || updateResult.success !== true) {
    return buildSecurityStatusRecoveryResult({
      reason: updateResult && updateResult.errorMsg ? updateResult.errorMsg : "WRITE_ERROR",
      characterID: normalizedCharacterID,
      previousSecurityStatus,
      nextSecurityStatus: previousSecurityStatus,
      baseModifier,
      fastTalkMultiplier,
      modifier,
    });
  }

  return buildSecurityStatusRecoveryResult({
    applied: true,
    reason: "APPLIED",
    characterID: normalizedCharacterID,
    previousSecurityStatus:
      updateResult.data && updateResult.data.previousSecurityStatus !== undefined
        ? updateResult.data.previousSecurityStatus
        : previousSecurityStatus,
    nextSecurityStatus:
      updateResult.data && updateResult.data.securityStatus !== undefined
        ? updateResult.data.securityStatus
        : nextSecurityStatus,
    baseModifier,
    fastTalkMultiplier,
    modifier,
  });
}

function resolveNpcBountyAmount(victimEntity = {}, context = {}) {
  if (!victimEntity || isPlayerVictim(victimEntity)) {
    return {
      eligible: false,
      amount: 0,
      baseAmount: 0,
      isModified: false,
    };
  }

  const baseAmount = Math.max(0, normalizeMoney(victimEntity.bounty, 0));
  if (baseAmount <= 0) {
    return {
      eligible: false,
      amount: 0,
      baseAmount,
      isModified: false,
    };
  }

  const abyssalContext = resolveExactAbyssalNpcOutcomeContext(victimEntity);
  if (shouldSuppressResolvedAbyssalNpcOutcome(
    abyssalContext,
    "suppressBounty",
  )) {
    return {
      eligible: false,
      amount: 0,
      baseAmount,
      isModified: true,
      reason: abyssalContext.invalidAbyssalOutcomeAuthority
        ? "ABYSSAL_NPC_AUTHORITY_INVALID"
        : "ABYSSAL_NPC_POLICY",
      abyssalRunID: abyssalContext.runID,
      abyssalRoomIndex: abyssalContext.roomIndex,
    };
  }

  const solarSystemID = toPositiveInt(
    context.solarSystemID,
    toPositiveInt(victimEntity.systemID, 0),
  ) || 0;
  const authoredMultiplier = resolveAuthoredMultiplier(victimEntity, context);
  const solarSystemMultiplier = resolveSolarSystemBountyMultiplier(solarSystemID, context);
  const incursionMultiplier = require("../incursion/incursionSystemEffects").bountyMultiplier(solarSystemID);
  const grossAmount = normalizeMoney(baseAmount * authoredMultiplier * solarSystemMultiplier * incursionMultiplier, 0);
  const split = resolveEssBountySplit(solarSystemID, grossAmount, context);
  const amount = Math.max(0, normalizeMoney(split.playerAmount, 0));

  return {
    eligible: amount > 0,
    amount,
    baseAmount,
    grossAmount,
    solarSystemID,
    authoredMultiplier,
    solarSystemMultiplier,
    ...(incursionMultiplier !== 1 ? { incursionMultiplier } : {}),
    essMainBankAmount: normalizeMoney(split.essMainBankAmount, 0),
    reserveBankAmount: normalizeMoney(split.reserveBankAmount, 0),
    securityTaxAmount: normalizeMoney(split.securityTaxAmount, 0),
    isModified:
      normalizeMoney(baseAmount, 0) !== amount ||
      authoredMultiplier !== 1 ||
      solarSystemMultiplier !== 1 ||
      normalizeMoney(split.essMainBankAmount, 0) > 0 ||
      normalizeMoney(split.reserveBankAmount, 0) > 0 ||
      normalizeMoney(split.securityTaxAmount, 0) > 0,
  };
}

function notifyBountyAdded(characterID, payload) {
  const sessions = sessionRegistry
    .getSessions()
    .filter((session) => Number((session && session.characterID) || 0) === Number(characterID || 0));

  // OnBountyAddedToPayout ships a util.KeyVal on the wire (per golden-log
  // parity), not a bare JS object — the marshaller rejects untyped objects.
  // `payoutTime` is a win32 FILETIME beyond the JS safe-integer range, so send
  // it as an int64 long rather than a string.
  const wirePayload = buildKeyVal([
    ["enemyTypeID", toInt(payload && payload.enemyTypeID, 0)],
    ["amount", toInt(payload && payload.amount, 0)],
    ["payoutTime", { type: "long", value: String((payload && payload.payoutTime) || "0") }],
    ["isModified", Boolean(payload && payload.isModified)],
  ]);

  for (const session of sessions) {
    if (session && typeof session.sendNotification === "function") {
      session.sendNotification("OnBountyAddedToPayout", "charid", [wirePayload]);
    }
  }
}

function clearTimer() {
  if (payoutTimer) {
    clearTimeout(payoutTimer);
    payoutTimer = null;
  }
}

function buildDurablePayoutJobID(bucketKey) {
  return `${DURABLE_PAYOUT_JOB_PREFIX}${String(bucketKey || "")}`;
}

const durableScheduledBucketKeys = new Set();

function scheduleDurableBucket(bucket, scheduler = durableScheduler) {
  if (!scheduler || !bucket) {
    return Promise.resolve(null);
  }
  return scheduler.schedule({
    jobID: buildDurablePayoutJobID(bucket.key),
    type: DURABLE_PAYOUT_JOB_TYPE,
    dueAtMs: bucket.payoutAtMs,
    payload: { bucketKey: bucket.key },
  });
}

function queueDurableBucket(bucket) {
  if (
    !durableScheduler ||
    !bucket ||
    durableScheduledBucketKeys.has(bucket.key)
  ) {
    return;
  }
  const scheduler = durableScheduler;
  const generation = durableSchedulerGeneration;
  durableScheduledBucketKeys.add(bucket.key);
  durableScheduleLane = durableScheduleLane.then(async () => {
    if (
      scheduler !== durableScheduler ||
      generation !== durableSchedulerGeneration
    ) {
      durableScheduledBucketKeys.delete(bucket.key);
      return;
    }
    try {
      await scheduleDurableBucket(bucket, scheduler);
    } catch (error) {
      if (generation === durableSchedulerGeneration) {
        durableScheduledBucketKeys.delete(bucket.key);
      }
      log.warn(
        `[BountyRuntime] durable payout scheduling failed bucket=${bucket.key}: ${error.message}`,
      );
    }
  });
}

function refreshNextDueAt() {
  nextDueAtMs = Number.POSITIVE_INFINITY;
  for (const bucket of bucketsByKey.values()) {
    if (bucket.payoutAtMs < nextDueAtMs) {
      nextDueAtMs = bucket.payoutAtMs;
    }
  }
}

function scheduleTimer() {
  clearTimer();
  if (durableScheduler || !timerEnabled || !Number.isFinite(nextDueAtMs)) {
    return;
  }
  const delayMs = Math.max(1, nextDueAtMs - nowProvider());
  payoutTimer = setTimeout(() => {
    payoutTimer = null;
    flushDuePayouts().catch((error) => {
      log.warn(`[BountyRuntime] payout flush failed: ${error.message}`);
    });
  }, delayMs);
  if (typeof payoutTimer.unref === "function") {
    payoutTimer.unref();
  }
}

function noteBucketDueAt(payoutAtMs) {
  if (payoutAtMs < nextDueAtMs) {
    nextDueAtMs = payoutAtMs;
    scheduleTimer();
  }
}

function getOrCreateBucket(characterID, solarSystemID, payoutAtMs) {
  const payoutTime = formatFiletime(payoutAtMs);
  const key = buildBucketKey(characterID, solarSystemID, payoutTime);
  const existing = bucketsByKey.get(key);
  if (existing) {
    return existing;
  }

  const bucket = {
    key,
    characterID,
    solarSystemID,
    payoutAtMs,
    payoutTime,
    amount: 0,
    essFunding: { essMainBankAmount: 0, reserveBankAmount: 0, grossAmount: 0 },
    securityTaxAmount: 0,
    kills: 0,
    npcTypes: {},
    sourceReferences: [],
    corporationTax: null,
  };
  bucketsByKey.set(key, bucket);
  noteBucketDueAt(payoutAtMs);
  return bucket;
}

function addToBucket(bucket, award = {}) {
  bucket.amount = normalizeMoney(bucket.amount + normalizeMoney(award.amount, 0), 0);
  bucket.essFunding ||= { essMainBankAmount: 0, reserveBankAmount: 0, grossAmount: 0 };
  for (const key of ["essMainBankAmount", "reserveBankAmount", "grossAmount"]) bucket.essFunding[key] = normalizeMoney(bucket.essFunding[key] + (award[key] || 0));
  bucket.securityTaxAmount = normalizeMoney(
    normalizeMoney(bucket.securityTaxAmount, 0) + normalizeMoney(award.securityTaxAmount, 0),
    0,
  );
  bucket.kills += 1;

  const typeID = toPositiveInt(award.enemyTypeID, 0) || 0;
  if (typeID > 0) {
    bucket.npcTypes[String(typeID)] = (toInt(bucket.npcTypes[String(typeID)], 0) || 0) + 1;
  }

  // The kill's NPC item ID, uncapped, in the final-blow pilot's bucket: it is
  // the once-per-kill mark. A sharer's bucket keeps only its first, the
  // journal's reference (resolveBountyJournalReferenceID), so a fleet kill
  // does not grow every member's stored bucket.
  const sourceReference = toPositiveInt(award.referenceID, null);
  if (
    sourceReference &&
    (award.marksKill !== false || bucket.sourceReferences.length === 0)
  ) {
    bucket.sourceReferences.push(sourceReference);
    indexSourceReference(sourceReference, bucket.key);
  }
}

function indexSourceReference(referenceID, bucketKey) {
  const normalizedReferenceID = toPositiveInt(referenceID, null);
  if (!normalizedReferenceID) {
    return;
  }
  let keys = bucketKeysBySourceReference.get(normalizedReferenceID);
  if (!keys) {
    keys = new Set();
    bucketKeysBySourceReference.set(normalizedReferenceID, keys);
  }
  keys.add(bucketKey);
}

// The bucket a kill is already recorded in, preferring the given pilot's own
// when several recipients' buckets hold it.
function findBucketBySourceReference(referenceID, preferredCharacterID = 0) {
  const normalizedReferenceID = toPositiveInt(referenceID, null);
  if (!normalizedReferenceID) {
    return null;
  }

  const keys = bucketKeysBySourceReference.get(normalizedReferenceID);
  if (!keys) {
    return null;
  }
  let found = null;
  for (const key of [...keys]) {
    const bucket = bucketsByKey.get(key);
    if (
      !bucket ||
      !Array.isArray(bucket.sourceReferences) ||
      !bucket.sourceReferences.some(
        (sourceReference) => toPositiveInt(sourceReference, null) === normalizedReferenceID,
      )
    ) {
      keys.delete(key);
      continue;
    }
    if (bucket.characterID === preferredCharacterID) {
      return bucket;
    }
    found = found || bucket;
  }
  if (keys.size === 0) {
    bucketKeysBySourceReference.delete(normalizedReferenceID);
  }
  return found;
}

// NPC bounty kill's parts: the final-blow pilot alone without a scene or a
// Grid bubble; otherwise Fleet share's Bounty sharers, divided by Even split to
// the cent. The first part is always the final-blow pilot's.
function resolveBountyParts(characterID, amount, context = {}) {
  const alone = [{ characterID, amount }];
  const { scene, gridBubbleID } = context;
  if (!scene || gridBubbleID === null || gridBubbleID === undefined || gridBubbleID === "") {
    return alone;
  }
  try {
    const fleetShare = getFleetShareModule();
    const sharers = fleetShare.resolveBountySharers(characterID, { scene, gridBubbleID });
    if (!Array.isArray(sharers) || sharers.length <= 1 || sharers[0] !== characterID) {
      return alone;
    }
    const parts = fleetShare.splitEvenly(amount, sharers, "cent");
    return Array.isArray(parts) && parts.length === sharers.length ? parts : alone;
  } catch (error) {
    log.warn(
      `[BountyRuntime] fleet share failed char=${characterID}; paying the final blow alone: ${error.message}`,
    );
    return alone;
  }
}

// ESS's cut comes off the whole bounty before the split, and it diverts
// part of each earner's bounty, so each recipient's part carries an even part of
// that funding, keeping the totals and making each sharer a bank contributor.
function splitEssFunding(resolution, recipientIDs) {
  const whole = Object.fromEntries(ESS_FUNDING_FIELDS.map((field) => [field, resolution[field] || 0]));
  if (recipientIDs.length <= 1) {
    return recipientIDs.map(() => whole);
  }
  const { splitEvenly } = getFleetShareModule();
  const fieldParts = ESS_FUNDING_FIELDS.map((field) => splitEvenly(whole[field], recipientIDs, "cent"));
  return recipientIDs.map((_recipientID, index) =>
    Object.fromEntries(ESS_FUNDING_FIELDS.map((field, fieldIndex) => [field, fieldParts[fieldIndex][index].amount])));
}

// What the ESS leaves the players of a kill, before CONCORD's Safe Security
// share: what fleet shares divide.
function untaxedBountyAmount(resolution) {
  return normalizeMoney(
    normalizeMoney(resolution.amount, 0) + normalizeMoney(resolution.securityTaxAmount, 0),
    0,
  );
}

// One recipient's part of a kill, less CONCORD's Safe Security share of that
// part. Each part is taxed on its own, rounded to the cent, as each recipient's
// mission reward is: every part is its own journal entry, and the client reads
// each entry's gross and tax on its own (_GetDerivedSecurityTaxTransaction).
// A kill paid to one pilot keeps the tax the ESS split already worked out.
function taxBountyPart(resolution, solarSystemID, gross, alone) {
  const wholeTax = normalizeMoney(resolution.securityTaxAmount, 0);
  if (!(wholeTax > 0)) {
    return { amount: gross, securityTaxAmount: 0 };
  }
  if (alone) {
    return { amount: normalizeMoney(resolution.amount, 0), securityTaxAmount: wholeTax };
  }
  const { tax } = getSecurityTaxModule().computeNpcBountySecurityTax(solarSystemID, gross);
  return { amount: normalizeMoney(gross - tax, 0), securityTaxAmount: normalizeMoney(tax, 0) };
}

function serializeBucket(bucket) {
  return {
    key: bucket.key,
    characterID: bucket.characterID,
    solarSystemID: bucket.solarSystemID,
    payoutAtMs: bucket.payoutAtMs,
    payoutTime: bucket.payoutTime,
    amount: bucket.amount,
    essFunding: bucket.essFunding ? { ...bucket.essFunding } : null,
    securityTaxAmount: bucket.securityTaxAmount,
    kills: bucket.kills,
    npcTypes: { ...bucket.npcTypes },
    sourceReferences: [...bucket.sourceReferences],
    corporationTax: bucket.corporationTax ? { ...bucket.corporationTax } : null,
  };
}

function ensurePendingTable() {
  if (typeof repo.ensureTable === "function") {
    repo.ensureTable(PENDING_TABLE_NAME);
  }
}

// A bounty and its permanent source receipt cross one durable table fence.
// Only those paths are copied/written; paid history never joins an ordinary
// accrual snapshot. Compensate both cache and disk if that fence is refused.
function persistPendingChanges(changes) {
  const recovery = retryPendingRollback();
  if (!recovery.success) return recovery;
  if (!persistenceEnabled) {
    return { success: true };
  }
  const previous = [];
  let createdEventCollection = false;
  try {
    ensurePendingTable();
    if (changes.some((change) => change.path.startsWith("/__events/"))) {
      const events = repo.read(PENDING_TABLE_NAME, "/__events");
      if (!events.success && events.errorMsg !== "ENTRY_NOT_FOUND") return events;
      createdEventCollection = !events.success;
    }
    for (const change of changes) {
      const before = repo.read(PENDING_TABLE_NAME, change.path);
      if (!before.success && before.errorMsg !== "ENTRY_NOT_FOUND") return before;
      previous.push({ path: change.path, exists: before.success, value: cloneValue(before.data) });
    }
  } catch (error) {
    return { success: false, errorMsg: error.message || "BOUNTY_PENDING_READ_FAILED" };
  }

  let failure;
  try {
    for (const change of changes) {
      const result = change.remove
        ? repo.remove(PENDING_TABLE_NAME, change.path)
        : repo.write(PENDING_TABLE_NAME, change.path, cloneValue(change.value));
      if (!result?.success && !(change.remove && result?.errorMsg === "ENTRY_NOT_FOUND")) {
        failure = result || { success: false, errorMsg: "BOUNTY_PENDING_WRITE_FAILED" };
        break;
      }
    }
    if (!failure) {
      const flushed = repo.flushTableSync(PENDING_TABLE_NAME);
      if (flushed?.success) return flushed;
      failure = flushed || { success: false, errorMsg: "BOUNTY_PENDING_FLUSH_FAILED" };
    }
  } catch (error) {
    failure = { success: false, errorMsg: error.message || "BOUNTY_PENDING_COMMIT_FAILED" };
  }

  pendingPersistenceRollback = { previous, createdEventCollection };
  const rollback = retryPendingRollback();
  return { ...failure, success: false, rollback };
}

// A refused compensation must remain an owner obligation. Otherwise a later
// payout window could accept the same source while its first bucket survives.
function retryPendingRollback() {
  if (!pendingPersistenceRollback) return { success: true, errors: [] };
  const debt = pendingPersistenceRollback;
  const { previous, createdEventCollection } = debt;
  const rollbackErrors = [];
  // Row restoration can itself fail. Hold every automatic/explicit table flush
  // until all preimages have been staged, so a background worker cannot publish
  // a bucket without its receipt while the owner is waiting to recover.
  if (!debt.releaseFlush) {
    try {
      if (typeof repo.holdTableFlush !== "function") throw new Error("BOUNTY_FLUSH_HOLD_UNAVAILABLE");
      debt.releaseFlush = repo.holdTableFlush(PENDING_TABLE_NAME);
      if (typeof debt.releaseFlush !== "function") throw new Error("BOUNTY_FLUSH_HOLD_UNAVAILABLE");
    } catch (error) {
      return { success: false, errorMsg: "BOUNTY_PENDING_ROLLBACK_REQUIRED", errors: [error.message] };
    }
  }
  for (const before of [...previous].reverse()) {
    try {
      const restored = before.exists
        ? repo.write(PENDING_TABLE_NAME, before.path, cloneValue(before.value), { force: true })
        : repo.remove(PENDING_TABLE_NAME, before.path);
      if (!restored?.success && !(restored?.errorMsg === "ENTRY_NOT_FOUND" && !before.exists)) {
        rollbackErrors.push(restored?.errorMsg || "BOUNTY_ROLLBACK_FAILED");
      }
    } catch (error) { rollbackErrors.push(error.message); }
  }
  if (createdEventCollection) {
    try {
      const removed = repo.remove(PENDING_TABLE_NAME, "/__events");
      if (!removed?.success && removed?.errorMsg !== "ENTRY_NOT_FOUND") rollbackErrors.push(removed?.errorMsg || "BOUNTY_ROLLBACK_FAILED");
    } catch (error) { rollbackErrors.push(error.message); }
  }
  // Never commit a partial compensation. The durable transaction must remain
  // either the accepted bucket/receipt pair or the complete preimage.
  if (rollbackErrors.length === 0) {
    try {
      debt.releaseFlush();
      debt.releaseFlush = null;
      const flushed = repo.flushTableSync(PENDING_TABLE_NAME);
      if (!flushed?.success) rollbackErrors.push(flushed?.errorMsg || "BOUNTY_ROLLBACK_FLUSH_FAILED");
    } catch (error) { rollbackErrors.push(error.message); }
  }
  if (rollbackErrors.length === 0) pendingPersistenceRollback = null;
  return {
    success: rollbackErrors.length === 0,
    errorMsg: rollbackErrors.length > 0 ? "BOUNTY_PENDING_ROLLBACK_REQUIRED" : undefined,
    errors: rollbackErrors,
  };
}

// Every recipient's bucket and the kill's one receipt cross the same fence, so
// a fleet kill is recorded for all of them or none. The receipt names the
// final-blow pilot's bucket.
function pendingAccrualChanges(buckets, receiptBucket, eventID) {
  const changes = buckets.map((bucket) => ({ path: `/${bucket.key}`, value: serializeBucket(bucket) }));
  if (eventID) {
    // Store paths do not escape slash-containing keys. Preserve those uncommon
    // legacy identifiers through the collection path, without renaming receipts.
    changes.push(String(eventID).includes("/")
      ? { path: "/__events", value: { ...recordedEvents, [eventID]: receiptBucket.key } }
      : { path: `/__events/${eventID}`, value: receiptBucket.key });
  }
  return changes;
}

function loadPersistedBuckets() {
  const recovery = retryPendingRollback();
  if (!recovery.success) throw new Error(recovery.errorMsg);
  ensurePendingTable();
  const result = repo.read(PENDING_TABLE_NAME, "/");
  if (!result?.success) {
    throw new Error(result?.errorMsg || "BOUNTY_PENDING_READ_FAILED");
  }
  if (!result.data || typeof result.data !== "object") {
    persistenceLoaded = true;
    return;
  }
  recordedEvents = { ...(result.data.__events || {}) };
  for (const [key, raw] of Object.entries(result.data)) {
    if (!raw || typeof raw !== "object") {
      continue;
    }
    const characterID = toPositiveInt(raw.characterID, 0) || 0;
    const amount = normalizeMoney(raw.amount, 0);
    if (!(characterID > 0) || !(amount > 0)) {
      continue;
    }
    const payoutAtMs = toFiniteNumber(raw.payoutAtMs, 0);
    bucketsByKey.set(key, {
      key,
      characterID,
      solarSystemID: toPositiveInt(raw.solarSystemID, 0) || 0,
      payoutAtMs,
      payoutTime: String(raw.payoutTime || formatFiletime(payoutAtMs)),
      amount,
      essFunding: raw.essFunding ? { ...raw.essFunding } : null,
      // Absent on a bucket persisted before the Safe Security tax, which
      // withheld nothing.
      securityTaxAmount: normalizeMoney(raw.securityTaxAmount, 0),
      kills: Math.max(0, toInt(raw.kills, 0)),
      npcTypes:
        raw.npcTypes && typeof raw.npcTypes === "object" ? { ...raw.npcTypes } : {},
      sourceReferences: Array.isArray(raw.sourceReferences)
        ? [...raw.sourceReferences]
        : [],
      // Absent on a bucket persisted before Corporation tax, and on one whose
      // payout was never attempted: the split is locked in on the next attempt.
      corporationTax:
        raw.corporationTax && typeof raw.corporationTax === "object"
          ? { ...raw.corporationTax }
          : null,
    });
    for (const sourceReference of bucketsByKey.get(key).sourceReferences) {
      indexSourceReference(sourceReference, key);
    }
  }
  persistenceLoaded = true;
  refreshNextDueAt();
  scheduleTimer();
}

function ensureLoaded() {
  const recovery = retryPendingRollback();
  if (!recovery.success) throw new Error(recovery.errorMsg);
  if (persistenceLoaded || !persistenceEnabled) {
    return;
  }
  loadPersistedBuckets();
}

function recordNpcBountyKill(victimEntity = {}, finalAttacker = {}, context = {}) {
  ensureLoaded();
  const characterID = resolveAttackerCharacterID(finalAttacker, context);
  if (!characterID) {
    return null;
  }

  const resolution = resolveNpcBountyAmount(victimEntity, context);
  if (!resolution.eligible) {
    return null;
  }

  const solarSystemID = toPositiveInt(
    resolution.solarSystemID,
    toPositiveInt(victimEntity && victimEntity.systemID, 0),
  ) || 0;
  const enemyTypeID = toPositiveInt(victimEntity && victimEntity.typeID, 0) || 0;
  const referenceID = toPositiveInt(victimEntity && victimEntity.itemID, null);
  const eventID = context.bountyEventID || victimEntity._bountyEventID || (referenceID ? `${bountyBootID}:${solarSystemID}:${referenceID}` : null);
  if (eventID && recordedEvents[eventID]) return { ...resolution, characterID, alreadyRecorded: true };
  const existingReferenceBucket = findBucketBySourceReference(referenceID, characterID);
  const existingPayload = existingReferenceBucket
    ? {
        enemyTypeID,
        amount: resolution.amount,
        payoutTime: existingReferenceBucket.payoutTime,
        isModified: Boolean(resolution.isModified),
      }
    : null;
  if (existingReferenceBucket) {
    return {
      ...resolution,
      characterID,
      solarSystemID,
      payoutAtMs: existingReferenceBucket.payoutAtMs,
      payoutTime: existingReferenceBucket.payoutTime,
      bucketKey: existingReferenceBucket.key,
      notification: existingPayload,
      alreadyRecorded: true,
      securityStatusRecovery: null,
    };
  }

  // Each part joins its recipient's own payout for this system. Schedule it
  // against the wall clock (not sim time) so a persisted bucket stays
  // comparable after a restart, when the scene's sim clock resets. A pilot's
  // first kill starts their payout window; later kills and shares before the
  // bucket comes due reuse that same payout time instead of snapping to a
  // cluster-wide wall-clock boundary. A given payoutAtMs is the final-blow
  // pilot's alone.
  const nowMs = nowProvider();
  const parts = resolveBountyParts(characterID, untaxedBountyAmount(resolution), context)
    .map((part) => ({
      characterID: toPositiveInt(part && part.characterID, 0),
      amount: normalizeMoney(part && part.amount, 0),
    }))
    .filter((part) => part.characterID && part.amount > 0)
    .map((part, _index, all) => ({
      characterID: part.characterID,
      ...taxBountyPart(resolution, solarSystemID, part.amount, all.length === 1),
    }));
  const essParts = splitEssFunding(resolution, parts.map((part) => part.characterID));
  const shares = [];
  for (const [index, { characterID: recipientID, amount, securityTaxAmount }] of parts.entries()) {
    const payoutAtMs = recipientID === characterID && Number.isFinite(Number(context.payoutAtMs))
      ? Math.trunc(Number(context.payoutAtMs))
      : resolvePayoutAtMsForCharacter(recipientID, nowMs);
    const bucketKey = buildBucketKey(recipientID, solarSystemID, formatFiletime(payoutAtMs));
    const existed = bucketsByKey.has(bucketKey);
    const bucket = getOrCreateBucket(recipientID, solarSystemID, payoutAtMs);
    const beforeBucket = serializeBucket(bucket);
    addToBucket(bucket, {
      ...essParts[index],
      amount,
      securityTaxAmount,
      enemyTypeID,
      referenceID,
      marksKill: recipientID === characterID,
    });
    shares.push({ characterID: recipientID, amount, bucket, existed, beforeBucket });
  }
  // Even split gives the final-blow pilot the first part and the remainder,
  // so theirs is never zero.
  const { bucket } = shares.find((share) => share.characterID === characterID) || shares[0];
  const saved = persistPendingChanges(pendingAccrualChanges(
    shares.map((share) => share.bucket),
    bucket,
    eventID,
  ));
  if (!saved?.success) {
    for (const share of shares) {
      if (share.existed) Object.assign(share.bucket, share.beforeBucket);
      else bucketsByKey.delete(share.bucket.key);
    }
    refreshNextDueAt();
    scheduleTimer();
    throw new Error(saved?.errorMsg || "BOUNTY_ACCRUAL_NOT_DURABLE");
  }
  if (eventID) recordedEvents[eventID] = bucket.key;
  if (eventID) victimEntity._bountyEventID = eventID;

  let payload = null;
  for (const share of shares) {
    queueDurableBucket(share.bucket);
    const sharePayload = {
      enemyTypeID,
      amount: share.amount,
      payoutTime: share.bucket.payoutTime,
      isModified: Boolean(resolution.isModified),
    };
    if (share.characterID === characterID) {
      payload = sharePayload;
    }
    notifyBountyAdded(share.characterID, sharePayload);
  }
  // Advance the "Destroy N non-capsuleers" AIR daily goal on each fresh NPC
  // kill. Lazy-required and fully defensive so daily-goal bookkeeping can never
  // disrupt bounty payouts.
  try {
    require(path.join(
      __dirname,
      "../dailyGoals/dailyGoalsState",
    )).recordActivity(characterID, "kill_npc", 1);
  } catch (dailyGoalError) {
    log.debug(
      `[BountyRuntime] daily-goal kill_npc hook failed char=${characterID}: ${dailyGoalError.message}`,
    );
  }
  const securityStatusRecovery = applySecurityStatusRecovery(
    characterID,
    victimEntity,
    finalAttacker,
    resolution,
    context,
  );

  return {
    ...resolution,
    characterID,
    solarSystemID,
    payoutAtMs: bucket.payoutAtMs,
    payoutTime: bucket.payoutTime,
    bucketKey: bucket.key,
    notification: payload,
    shares: shares.map((share) => ({
      characterID: share.characterID,
      amount: share.amount,
      payoutTime: share.bucket.payoutTime,
      bucketKey: share.bucket.key,
    })),
    securityStatusRecovery,
  };
}

function buildWalletDescription(bucket) {
  const npcTypeLines = Object.entries(bucket.npcTypes || {})
    .map(([typeID, count]) => [
      toPositiveInt(typeID, 0) || 0,
      Math.max(0, toInt(count, 0)),
    ])
    .filter(([typeID, count]) => typeID > 0 && count > 0)
    .sort((left, right) => left[0] - right[0])
    .map(([typeID, count]) => `  ${typeID}: ${count}`);

  const lines = ["NBL:"];
  if (npcTypeLines.length > 0) {
    lines.push(...npcTypeLines);
  } else {
    lines[0] = "NBL: {}";
  }
  lines.push(`solarSystemID: ${toPositiveInt(bucket.solarSystemID, 0) || 0}`);
  lines.push(`kills: ${Math.max(0, toInt(bucket.kills, 0))}`);
  return lines.join("\n");
}

function resolveSingleVictimTypeID(bucket) {
  const entries = Object.entries(bucket && bucket.npcTypes || {})
    .map(([typeID, count]) => [
      toPositiveInt(typeID, 0) || 0,
      Math.max(0, toInt(count, 0)),
    ])
    .filter(([typeID, count]) => typeID > 0 && count > 0);
  return entries.length === 1 && entries[0][1] === 1 ? entries[0][0] : null;
}

function resolveBountyJournalReferenceID(bucket) {
  if (Math.max(0, toInt(bucket && bucket.kills, 0)) <= 1) {
    return (
      resolveSingleVictimTypeID(bucket) ||
      toPositiveInt(bucket && bucket.sourceReferences && bucket.sourceReferences[0], 0) ||
      -1
    );
  }
  return (
    toPositiveInt(bucket && bucket.solarSystemID, 0) ||
    toPositiveInt(bucket && bucket.sourceReferences && bucket.sourceReferences[0], 0) ||
    -1
  );
}

// Corporation tax is set by the member's corporation when the payout settles,
// not when the kills happened. The split is locked in and persisted on the
// first payout attempt, before any credit: a retry must present the member's
// wallet the same amount and description under the same idempotency key, and
// must pay the corporation the member was taxed for.
function lockInCorporationTax(bucket) {
  if (bucket.corporationTax) {
    return { success: true, data: bucket.corporationTax };
  }
  const corporationTax = getCorporationTaxModule();
  const profile = corporationTax.resolveCorporationTaxProfile(bucket.characterID);
  const split = corporationTax.computeCorporationTax(
    profile,
    corporationTax.CORPORATION_TAX_CURRENCY.ISK,
    bucket.amount,
  );
  bucket.corporationTax = {
    corporationID: split.corporationID,
    isNPC: profile.isNPC,
    taxRate: profile.taxRate,
    gross: split.gross,
    tax: split.tax,
    net: split.net,
    credit: split.credit,
  };
  const persisted = persistPendingChanges([{ path: `/${bucket.key}`, value: serializeBucket(bucket) }]);
  if (!persisted || persisted.success !== true) {
    bucket.corporationTax = null;
    return { success: false, errorMsg: "BOUNTY_TAX_SPLIT_NOT_PERSISTED" };
  }
  return { success: true, data: bucket.corporationTax };
}

async function creditCorporationTax(bucket, split) {
  const corpWalletState = getCorpWalletStateModule();
  const corporationTaxKey = `${buildDurablePayoutJobID(bucket.key)}:corp-tax`;
  const result = await corpWalletState.adjustCorporationWalletDivisionBalanceAsync(
    split.corporationID,
    corpWalletState.CORPORATION_WALLET_KEY_START,
    split.tax,
    {
      idempotencyKey: corporationTaxKey,
      description: "Corporation tax on pirate bounties",
      ownerID1: bucket.characterID,
      ownerID2: split.corporationID,
      referenceID: resolveBountyJournalReferenceID(bucket),
      entryTypeID: JOURNAL_ENTRY_TYPE.CORPORATION_TAX_NPC_BOUNTIES,
    },
    {
      commandID: corporationTaxKey,
      source: "npc-bounty-corporation-tax",
    },
  );
  if (result && result.success === true) {
    return result;
  }
  const errorMsg = result && result.errorMsg || "BOUNTY_CORP_TAX_FAILED";
  if (!getCorporationTaxModule().isUnpayableCorporationTaxError(errorMsg)) {
    return result || { success: false, errorMsg };
  }
  // The member already paid it, so the tax becomes a sink.
  log.warn(
    `[BountyRuntime] corporation ${split.corporationID} could not receive the ` +
      `bounty tax for bucket=${bucket.key}: ${errorMsg}`,
  );
  return { success: true, sink: true };
}

// Two idempotent credits: the member's net on the existing payout key, then
// the corporation's tax on a derived key. The caller removes the bucket only
// once both succeeded; a retry replays both against the locked-in split.
async function payoutBucket(bucket) {
  if (!bucket || !(bucket.amount > 0) || !(bucket.characterID > 0)) {
    return {
      success: false,
      errorMsg: "INVALID_BOUNTY_BUCKET",
    };
  }

  const locked = lockInCorporationTax(bucket);
  if (!locked.success) {
    return locked;
  }
  const split = locked.data;
  // The tax keys are merged into the NBL: description, never replacing it, so
  // the client still lists the killed NPCs on hover. CONCORD's Safe Security
  // share was withheld kill by kill, before the corporation's rate, so the
  // gross the client shows is the payout plus both taxes.
  const corporationTaxed = split.tax > 0
    ? getCorporationTaxModule().buildCorporationTaxDescription(
      JOURNAL_ENTRY_TYPE.CORPORATION_TAX_NPC_BOUNTIES,
      split.corporationID,
      split.tax,
      { into: buildWalletDescription(bucket) },
    )
    : buildWalletDescription(bucket);
  const securityTaxAmount = normalizeMoney(bucket.securityTaxAmount, 0);
  const description = securityTaxAmount > 0
    ? getSecurityTaxModule().buildSecurityTaxDescription(
      "grossBountyAmount",
      normalizeMoney(bucket.amount + securityTaxAmount, 0),
      securityTaxAmount,
      { into: corporationTaxed },
    )
    : corporationTaxed;
  const memberResult = await adjustCharacterBalanceAsync(bucket.characterID, split.net, {
    entryTypeID: bucket.kills > 1
      ? JOURNAL_ENTRY_TYPE.NPC_BOUNTY_PRIZES
      : JOURNAL_ENTRY_TYPE.NPC_BOUNTY_PRIZE,
    description,
    ownerID1: bucket.characterID,
    ownerID2: bucket.characterID,
    referenceID: resolveBountyJournalReferenceID(bucket),
    idempotencyKey: buildDurablePayoutJobID(bucket.key),
  });
  if (!memberResult || memberResult.success !== true) return memberResult;
  // The pending record already freezes the split. Funding is receipt-backed and
  // must finish even when the corporation has no tax credit to receive.
  await ess.fundBounty(buildDurablePayoutJobID(bucket.key), bucket.solarSystemID, bucket.characterID, bucket.essFunding || { grossAmount: bucket.amount });
  if (split.credit) {
    const corporationResult = await creditCorporationTax(bucket, split);
    if (!corporationResult || corporationResult.success !== true) return corporationResult;
  }
  // AIR's captured bounty counters advance by journal gross, before personal
  // security/corporation taxes. ESS bank funding is outside this journal sum.
  const amountCents = Math.round(normalizeMoney(bucket.amount + securityTaxAmount, 0) * 100);
  if (amountCents > 0) {
    const ledger = require("../career/careerEventLedger");
    let event = { kind: "economy", action: "bounty-earned", amountCents,
      id: buildDurablePayoutJobID(bucket.key) };
    const character = resolveCharacterRecord(bucket.characterID);
    const staged = ledger.stageCharacter(character, bucket.characterID, event);
    if (!staged.success) {
      // An older pending payout may already have committed its net-valued
      // receipt. Recognize that exact receipt without backfilling or paying
      // again; unrelated conflicts remain failures.
      const legacy = { ...event, amountCents: Math.round(split.net * 100) };
      const previous = staged.errorMsg === "CAREER_EVENT_RECEIPT_CONFLICT" &&
        legacy.amountCents > 0 && legacy.amountCents !== amountCents
        ? ledger.stageCharacter(character, bucket.characterID, legacy) : null;
      if (!previous?.success || previous.data.duplicate !== true) return staged;
      event = legacy;
    }
    const career = ledger.record(bucket.characterID, event);
    if (!career.success) return career;
  }
  return memberResult;
}

async function flushDuePayoutsUnlocked(nowMs = nowProvider()) {
  ensureLoaded();
  if (nowMs < nextDueAtMs) {
    return {
      flushed: 0,
      amount: 0,
      due: false,
    };
  }

  let flushed = 0;
  let amount = 0;
  const results = [];
  for (const [key, bucket] of bucketsByKey.entries()) {
    if (bucket.payoutAtMs > nowMs) {
      continue;
    }
    let result;
    try {
      result = await payoutBucket(bucket);
    } catch (error) {
      result = { success: false, errorMsg: error && error.message ? error.message : "PAYOUT_THREW" };
    }
    if (result && result.success === true) {
      const removed = persistPendingChanges([{ path: `/${key}`, remove: true }]);
      if (!removed?.success) result = { success: false, errorMsg: removed?.errorMsg || "BOUNTY_PENDING_REMOVE_NOT_DURABLE" };
    }
    results.push({
      key,
      result,
      amount: bucket.amount,
      kills: bucket.kills,
    });
    if (result && result.success === true) {
      // Only drop the pending entry once the credit is confirmed. A failed
      // payout (or a thrown error) leaves the bucket in place to retry on the
      // next tick instead of silently destroying the ISK.
      bucketsByKey.delete(key);
      durableScheduledBucketKeys.delete(key);
      flushed += 1;
      amount = normalizeMoney(amount + bucket.amount, 0);
    }
  }

  refreshNextDueAt();
  scheduleTimer();
  return {
    flushed,
    amount,
    due: true,
    results,
  };
}

function flushDuePayouts(nowMs = nowProvider()) {
  if (payoutFlushPromise) {
    return payoutFlushPromise;
  }
  payoutFlushPromise = flushDuePayoutsUnlocked(nowMs).finally(() => {
    payoutFlushPromise = null;
  });
  return payoutFlushPromise;
}

function tickScene(_scene, _nowMs) {
  if (durableScheduler) {
    return null;
  }
  // Driven from the space-runtime scene tick so payouts do not depend solely on
  // a single in-process timer. Wall-clock based so it stays correct across
  // restarts and regardless of the scene's sim clock.
  return flushDuePayouts(nowProvider());
}

function bindDurableScheduler(scheduler) {
  if (!scheduler || typeof scheduler.schedule !== "function") {
    throw new TypeError("NPC bounty scheduler requires a schedule function");
  }
  clearTimer();
  durableSchedulerGeneration += 1;
  durableScheduler = scheduler;
  durableScheduledBucketKeys.clear();
  ensureLoaded();
  return true;
}

async function reconcileDurableScheduler() {
  if (!durableScheduler) {
    return { scheduled: 0 };
  }
  ensureLoaded();
  const buckets = Array.from(bucketsByKey.values());
  for (const bucket of buckets) {
    await scheduleDurableBucket(bucket, durableScheduler);
    durableScheduledBucketKeys.add(bucket.key);
  }
  return { scheduled: buckets.length };
}

async function attachDurableScheduler(scheduler) {
  bindDurableScheduler(scheduler);
  return reconcileDurableScheduler();
}

function detachDurableScheduler(scheduler = null) {
  if (scheduler && durableScheduler !== scheduler) {
    return false;
  }
  durableSchedulerGeneration += 1;
  durableScheduler = null;
  durableScheduledBucketKeys.clear();
  clearTimer();
  return true;
}

function listPendingBuckets() {
  ensureLoaded();
  return Array.from(bucketsByKey.values()).map((bucket) => ({
    ...bucket,
    npcTypes: { ...bucket.npcTypes },
    sourceReferences: [...bucket.sourceReferences],
  }));
}

function resetForTests() {
  pendingPersistenceRollback?.releaseFlush?.();
  pendingPersistenceRollback = null;
  recordedEvents = {};
  clearTimer();
  durableSchedulerGeneration += 1;
  durableScheduler = null;
  durableScheduledBucketKeys.clear();
  durableScheduleLane = Promise.resolve();
  bucketsByKey.clear();
  bucketKeysBySourceReference.clear();
  payoutIntervalMs = DEFAULT_PAYOUT_INTERVAL_MS;
  nowProvider = () => Date.now();
  timerEnabled = true;
  nextDueAtMs = Number.POSITIVE_INFINITY;
  fleetShareModule = null;
  // Tests opt into persistence explicitly so the default in-memory suites do
  // not read or write the shared pendingNpcBounties table.
  persistenceEnabled = false;
  persistenceLoaded = true;
}

function configureForTests(options = {}) {
  if (Number.isFinite(Number(options.payoutIntervalMs))) {
    payoutIntervalMs = Math.max(1, Math.trunc(Number(options.payoutIntervalMs)));
  }
  if (typeof options.nowProvider === "function") {
    nowProvider = options.nowProvider;
  }
  if (options.timerEnabled !== undefined) {
    timerEnabled = options.timerEnabled === true;
  }
  if (options.fleetShare) {
    fleetShareModule = options.fleetShare;
  }
  if (options.persistenceEnabled !== undefined) {
    persistenceEnabled = options.persistenceEnabled === true;
    // Force a reload from the table the next time it is needed.
    persistenceLoaded = !persistenceEnabled;
  }
  scheduleTimer();
}

function benchmarkAccrual(count = 1000) {
  resetForTests();
  configureForTests({
    timerEnabled: false,
    nowProvider: () => 1_000,
    payoutIntervalMs: DEFAULT_PAYOUT_INTERVAL_MS,
  });
  const started = performance.now();
  for (let index = 0; index < count; index += 1) {
    recordNpcBountyKill(
      {
        itemID: 90_000_000 + index,
        typeID: 16994,
        bounty: 1000,
        systemID: 30000142,
      },
      {
        characterID: 99_000_001,
      },
      {
        nowMs: 1_000,
      },
    );
  }
  return {
    count,
    elapsedMs: performance.now() - started,
    pendingBuckets: bucketsByKey.size,
  };
}

function benchmarkBucketAggregation(count = 1000) {
  resetForTests();
  configureForTests({
    timerEnabled: false,
    nowProvider: () => 1_000,
    payoutIntervalMs: DEFAULT_PAYOUT_INTERVAL_MS,
  });
  const bucket = getOrCreateBucket(99_000_001, 30000142, resolvePayoutAtMs(1_000));
  const started = performance.now();
  for (let index = 0; index < count; index += 1) {
    addToBucket(bucket, {
      amount: 1000,
      enemyTypeID: 16994,
      referenceID: 90_000_000 + index,
    });
  }
  return {
    count,
    elapsedMs: performance.now() - started,
    pendingBuckets: bucketsByKey.size,
    amount: bucket.amount,
  };
}

module.exports = {
  DEFAULT_PAYOUT_INTERVAL_MS,
  DURABLE_PAYOUT_JOB_TYPE,
  PENDING_TABLE_NAME,
  formatFiletime,
  resolvePayoutAtMs,
  resolveNpcBountyAmount,
  recordNpcBountyKill,
  flushDuePayouts,
  tickScene,
  listPendingBuckets,
  bindDurableScheduler,
  reconcileDurableScheduler,
  attachDurableScheduler,
  detachDurableScheduler,
  benchmarkAccrual,
  benchmarkBucketAggregation,
  _testing: {
    resetForTests,
    configureForTests,
    buildBucketKey,
    buildDurablePayoutJobID,
    buildWalletDescription,
    loadPersistedBuckets,
    persistPendingChanges,
  },
};
