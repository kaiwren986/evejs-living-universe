"use strict";

const {
  toFiniteNumber,
} = require("../../common/numbers");

const path = require("path");

const log = require(path.join(__dirname, "../../utils/logger"));
const {
  buildFiletimeLong,
} = require(path.join(__dirname, "./serviceHelpers"));
const {
  getCharacterRecord,
  updateCharacterRecord,
} = require(path.join(__dirname, "../character/characterState"));

const ATTRIBUTE_JUMP_FATIGUE_MULTIPLIER = 1971;
const ATTRIBUTE_JUMP_THROUGH_FATIGUE_MULTIPLIER = 1972;
const ADDITIONAL_DISTANCE = 1.0;
const ACTIVATION_SECONDS_PER_DISTANCE = 60;
const FATIGUE_SECONDS_PER_DISTANCE = 600;
const FATIGUE_MAX_SECONDS = 18000;
const FATIGUE_RATIO = ACTIVATION_SECONDS_PER_DISTANCE / FATIGUE_SECONDS_PER_DISTANCE;
const ACTIVATION_MAX_SECONDS = FATIGUE_MAX_SECONDS * FATIGUE_RATIO;
const FILETIME_EPOCH_OFFSET = 116444736000000000n;
const FILETIME_TICKS_PER_MS = 10000n;

function normalizePositiveInt(value, fallback = 0) {
  const numeric = Math.trunc(toFiniteNumber(value, fallback));
  return numeric > 0 ? numeric : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function msToFiletimeString(ms) {
  const normalizedMs = Math.max(0, Math.trunc(toFiniteNumber(ms, Date.now())));
  return (
    BigInt(normalizedMs) * FILETIME_TICKS_PER_MS +
    FILETIME_EPOCH_OFFSET
  ).toString();
}

function filetimeToMs(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  try {
    const filetime =
      typeof value === "bigint"
        ? value
        : value && typeof value === "object" && value.type === "long"
          ? BigInt(String(value.value || "0"))
          : BigInt(String(value));
    if (filetime <= FILETIME_EPOCH_OFFSET) {
      return null;
    }
    return Number((filetime - FILETIME_EPOCH_OFFSET) / FILETIME_TICKS_PER_MS);
  } catch (error) {
    // ignored: an unreadable FILETIME gives no time (null)
    return null;
  }
}

function normalizeTimerValue(value, nowMs) {
  const ms = filetimeToMs(value);
  if (ms === null || ms <= nowMs) {
    return null;
  }
  return String(value && typeof value === "object" && value.type === "long"
    ? value.value
    : value);
}

function resolveJumpFatigueMultiplier(resourceState) {
  const attributes =
    resourceState &&
    resourceState.attributes &&
    typeof resourceState.attributes === "object"
      ? resourceState.attributes
      : {};
  const multiplier = toFiniteNumber(attributes[ATTRIBUTE_JUMP_FATIGUE_MULTIPLIER], 1);
  return multiplier > 0 ? multiplier : 1;
}

// 1972 `jumpThroughFatigueMultiplier` is the *provider* half of the pair, and it
// is contributed by the ship holding the bridge open, not by the ship using it:
// "Multiplier for jump fatigue distance, applied to characters going through a
// bridge provided by this type." Exactly six published types declare it — the
// six Black Ops battleships, all at 0.25 — so its reach is the covert bridge and
// nothing else. A titan or Rorqual bridge declares none and leaves its
// passengers on their own 1971 alone.
function resolveJumpThroughFatigueMultiplier(resourceState) {
  const attributes =
    resourceState &&
    resourceState.attributes &&
    typeof resourceState.attributes === "object"
      ? resourceState.attributes
      : {};
  const multiplier = toFiniteNumber(
    attributes[ATTRIBUTE_JUMP_THROUGH_FATIGUE_MULTIPLIER],
    1,
  );
  return multiplier > 0 ? multiplier : 1;
}

function getStoredJumpTimers(characterID) {
  const record = getCharacterRecord(characterID);
  if (!record) {
    return null;
  }
  const timers =
    record.jumpTimers &&
    typeof record.jumpTimers === "object" &&
    !Array.isArray(record.jumpTimers)
      ? record.jumpTimers
      : {};
  return {
    jumpActivation:
      timers.jumpActivation ||
      timers.jumpActivationExpireDate ||
      record.jumpActivation ||
      record.jumpActivationExpireDate ||
      null,
    jumpFatigue:
      timers.jumpFatigue ||
      timers.jumpFatigueExpireDate ||
      record.jumpFatigue ||
      record.jumpFatigueExpireDate ||
      null,
    lastUpdated:
      timers.lastUpdated ||
      timers.lastUpdateDate ||
      record.jumpTimersLastUpdated ||
      record.lastJumpTimerUpdate ||
      null,
  };
}

function getActiveJumpTimers(characterID, options = {}) {
  const nowMs = Math.max(0, Math.trunc(toFiniteNumber(options.nowMs, Date.now())));
  const normalizedCharacterID = normalizePositiveInt(characterID, 0);
  if (normalizedCharacterID <= 0) {
    return {
      jumpActivation: null,
      jumpFatigue: null,
      lastUpdated: null,
    };
  }
  const stored = getStoredJumpTimers(normalizedCharacterID);
  if (!stored) {
    return {
      jumpActivation: null,
      jumpFatigue: null,
      lastUpdated: null,
    };
  }
  const jumpActivation = normalizeTimerValue(stored.jumpActivation, nowMs);
  const jumpFatigue = normalizeTimerValue(stored.jumpFatigue, nowMs);
  const lastUpdated = jumpActivation || jumpFatigue
    ? String(stored.lastUpdated || msToFiletimeString(nowMs))
    : null;
  return {
    jumpActivation,
    jumpFatigue,
    lastUpdated,
  };
}

function buildClientJumpTimerTuple(characterID, options = {}) {
  const timers = getActiveJumpTimers(characterID, options);
  return [
    timers.jumpActivation ? buildFiletimeLong(timers.jumpActivation) : null,
    timers.jumpFatigue ? buildFiletimeLong(timers.jumpFatigue) : null,
    timers.lastUpdated ? buildFiletimeLong(timers.lastUpdated) : null,
  ];
}

function hasActiveJumpActivation(characterID, options = {}) {
  const timers = getActiveJumpTimers(characterID, options);
  return Boolean(timers.jumpActivation);
}

function calculateJumpTimers(options = {}) {
  const nowMs = Math.max(0, Math.trunc(toFiniteNumber(options.nowMs, Date.now())));
  const distanceLy = Math.max(0, toFiniteNumber(options.distanceLy, 0));
  const jumpFatigueMultiplier = Math.max(
    0,
    toFiniteNumber(options.jumpFatigueMultiplier, 1),
  ) || 1;
  const previousFatigueMs = filetimeToMs(options.previousJumpFatigue);
  const remainingFatigueSeconds =
    previousFatigueMs === null
      ? 0
      : Math.max(0, (previousFatigueMs - nowMs) / 1000);
  const distanceFactor = ADDITIONAL_DISTANCE + distanceLy * jumpFatigueMultiplier;
  const fatigueMinSeconds = distanceFactor * FATIGUE_SECONDS_PER_DISTANCE;
  const fatigueSeconds = clamp(
    remainingFatigueSeconds * distanceFactor,
    fatigueMinSeconds,
    FATIGUE_MAX_SECONDS,
  );
  const activationSeconds = clamp(
    Math.max(
      ADDITIONAL_DISTANCE * ACTIVATION_SECONDS_PER_DISTANCE,
      distanceFactor * ACTIVATION_SECONDS_PER_DISTANCE,
      remainingFatigueSeconds * FATIGUE_RATIO,
    ),
    ADDITIONAL_DISTANCE * ACTIVATION_SECONDS_PER_DISTANCE,
    ACTIVATION_MAX_SECONDS,
  );
  const lastUpdated = msToFiletimeString(nowMs);
  return {
    jumpActivation: msToFiletimeString(nowMs + activationSeconds * 1000),
    jumpFatigue: msToFiletimeString(nowMs + fatigueSeconds * 1000),
    lastUpdated,
    activationSeconds,
    fatigueSeconds,
    distanceFactor,
  };
}

function sendJumpTimerUpdate(session, timers) {
  if (!session || typeof session.sendNotification !== "function") {
    return false;
  }
  session.sendNotification("OnJumpTimersUpdated", "clientID", [
    timers && timers.jumpActivation ? buildFiletimeLong(timers.jumpActivation) : null,
    timers && timers.jumpFatigue ? buildFiletimeLong(timers.jumpFatigue) : null,
    timers && timers.lastUpdated ? buildFiletimeLong(timers.lastUpdated) : null,
  ]);
  return true;
}

function applyJumpTimersForCharacter(characterID, options = {}) {
  const normalizedCharacterID = normalizePositiveInt(characterID, 0);
  if (normalizedCharacterID <= 0) {
    return {
      success: false,
      errorMsg: "INVALID_CHARACTER",
    };
  }
  const idempotencyKey = String(options.idempotencyKey || "");
  const stored = getCharacterRecord(normalizedCharacterID)?.jumpTimers;
  const appliedOperations = [...new Set([...(Array.isArray(stored?.appliedOperations) ? stored.appliedOperations : []),
    ...(stored?.idempotencyKey ? [stored.idempotencyKey] : [])])];
  if (idempotencyKey && appliedOperations.includes(idempotencyKey)) {
    if (options.session) sendJumpTimerUpdate(options.session, stored);
    return { success: true, duplicate: true, timers: stored };
  }
  // A character has at most one pending bridge settlement, so read that one
  // directly instead of normalizing every pending settlement on each jump.
  const pendingOperation = appliedOperations.length
    ? require("../structure/structureJumpBridgeMgrService")
      .findPendingJumpBridgeSettlementForCharacter(normalizedCharacterID)?.operationID
    : null;
  const retainedOperations = appliedOperations.filter((key) => key === `pos-bridge:${pendingOperation}`);
  const nowMs = Math.max(0, Math.trunc(toFiniteNumber(options.nowMs, Date.now())));
  const currentTimers = getActiveJumpTimers(normalizedCharacterID, { nowMs });
  const timers = calculateJumpTimers({
    distanceLy: options.distanceLy,
    jumpFatigueMultiplier: options.jumpFatigueMultiplier,
    nowMs,
    previousJumpFatigue: currentTimers.jumpFatigue,
  });
  // Ordinary jumps retain POS receipts. Keep recent receipts plus any
  // still-pending settlement even if unrelated timer updates intervene.
  const nextAppliedOperations = [...new Set([...retainedOperations,
    ...appliedOperations.slice(-7), ...(idempotencyKey ? [idempotencyKey] : [])])];
  const updateResult = updateCharacterRecord(normalizedCharacterID, (record) => {
    const {
      appliedOperations: _previousAppliedOperations,
      ...previousTimers
    } = record && record.jumpTimers && typeof record.jumpTimers === "object"
      ? record.jumpTimers
      : {};
    return {
      ...record,
      jumpTimers: {
        ...previousTimers,
        jumpActivation: timers.jumpActivation,
        jumpFatigue: timers.jumpFatigue,
        lastUpdated: timers.lastUpdated,
        ...(idempotencyKey ? { idempotencyKey } : {}),
        // Pilots who never made a POS jump carry no receipt list at all.
        ...(nextAppliedOperations.length ? { appliedOperations: nextAppliedOperations } : {}),
      },
    };
  });
  if (!updateResult.success) {
    return {
      success: false,
      errorMsg: updateResult.errorMsg || "WRITE_ERROR",
    };
  }
  if (options.session) {
    sendJumpTimerUpdate(options.session, timers);
  }
  return {
    success: true,
    timers,
  };
}

function applyJumpTimersForSession(session, options = {}) {
  return applyJumpTimersForCharacter(session && session.characterID, {
    ...options,
    session,
  });
}

function applyJumpTimersBestEffort(session, options = {}) {
  const result = applyJumpTimersForSession(session, options);
  if (!result.success) {
    log.warn(
      `[JumpTimers] failed to apply jump timers char=${session && session.characterID} ` +
        `error=${result.errorMsg || "UNKNOWN"}`,
    );
  }
  return result;
}

module.exports = {
  ACTIVATION_MAX_SECONDS,
  ACTIVATION_SECONDS_PER_DISTANCE,
  ADDITIONAL_DISTANCE,
  ATTRIBUTE_JUMP_FATIGUE_MULTIPLIER,
  ATTRIBUTE_JUMP_THROUGH_FATIGUE_MULTIPLIER,
  FATIGUE_MAX_SECONDS,
  FATIGUE_RATIO,
  FATIGUE_SECONDS_PER_DISTANCE,
  applyJumpTimersBestEffort,
  applyJumpTimersForCharacter,
  applyJumpTimersForSession,
  buildClientJumpTimerTuple,
  calculateJumpTimers,
  getActiveJumpTimers,
  hasActiveJumpActivation,
  resolveJumpFatigueMultiplier,
  resolveJumpThroughFatigueMultiplier,
};
