"use strict";

const {
  getAbyssalSuppressorPresentationProfileByTypeID,
  validateAbyssalSuppressorPresentationProfile,
} = require("../../catalog/abyssalSuppressorPresentationProfile");
const {
  normalizeText,
} = require("../../domain/abyssalValueUtils");

const MAX_START_ATTEMPTS_PER_SESSION = 2;
const ABYSSAL_SESSION_RUN_SCOPE_FIELDS = Object.freeze([
  "abyssalInstanceID",
  "abyssalRunID",
  "evejsAbyssalInstanceID",
  "evejsAbyssalPocketInstanceID",
  "dungeonCurrentInstanceID",
  "dungeonSiteInstanceID",
  "spaceInstanceID",
  "instanceID",
]);
const ABYSSAL_SESSION_ROOM_SCOPE_FIELDS = Object.freeze([
  "abyssalRoomIndex",
  "evejsAbyssalRoomIndex",
]);
const statesByKey = new Map();
let sessionTokens = new WeakMap();
let nextSessionToken = 1;

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function buildStateKey(runID, roomIndex, runtimeEntityID) {
  return `run:${toInt(runID, 0)}:room:${toInt(roomIndex, 0)}:entity:${toInt(runtimeEntityID, 0)}`;
}

function getSessionToken(session) {
  if (!session || typeof session !== "object") return "session:none";
  let token = sessionTokens.get(session);
  if (!token) {
    token = `session:${nextSessionToken++}`;
    sessionTokens.set(session, token);
  }
  return token;
}

function getCharacterID(session) {
  return toInt(session && (session.characterID || session.charid || session.characterId), 0);
}

function getClientID(session) {
  return toInt(session && session.clientID, 0);
}

function resolveExactPositiveAliases(sources, fieldNames) {
  let value = 0;
  let present = false;
  for (const source of sources) {
    if (!source || typeof source !== "object") continue;
    for (const fieldName of fieldNames) {
      if (
        !Object.hasOwn(source, fieldName) ||
        source[fieldName] === null ||
        source[fieldName] === undefined
      ) {
        continue;
      }
      present = true;
      const candidate = toInt(source[fieldName], 0);
      if (candidate <= 0 || (value > 0 && candidate !== value)) {
        return { present, valid: false, value: 0 };
      }
      value = candidate;
    }
  }
  return { present, valid: present && value > 0, value };
}

function resolveExactSceneKey(sources) {
  let value = "";
  let present = false;
  for (const source of sources) {
    if (!source || typeof source !== "object") continue;
    for (const fieldName of ["spaceSceneKey", "sceneKey"]) {
      if (
        !Object.hasOwn(source, fieldName) ||
        source[fieldName] === null ||
        source[fieldName] === undefined
      ) {
        continue;
      }
      const candidate = normalizeText(source[fieldName], "");
      if (!candidate) continue;
      present = true;
      if (value && candidate !== value) {
        return { present, valid: false, value: "" };
      }
      value = candidate;
    }
  }
  return { present, valid: present && value !== "", value };
}

function resolveExactSessionAbyssalScope(session) {
  const sessionSpace = session && session._space && typeof session._space === "object"
    ? session._space
    : null;
  const sources = [
    session,
    sessionSpace,
    session && session.sceneDescriptor,
    sessionSpace && sessionSpace.sceneDescriptor,
  ].filter((source) => source && typeof source === "object");
  return {
    run: resolveExactPositiveAliases(sources, ABYSSAL_SESSION_RUN_SCOPE_FIELDS),
    room: resolveExactPositiveAliases(
      [session, sessionSpace].filter(Boolean),
      ABYSSAL_SESSION_ROOM_SCOPE_FIELDS,
    ),
    scene: resolveExactSceneKey(sources),
  };
}

function nowFromCallbacks(callbacks = {}) {
  return toInt(
    typeof callbacks.now === "function" ? callbacks.now() : Date.now(),
    Date.now(),
  );
}

function emitLifecycle(callbacks, state, recipient, lifecycleState, reason, extra = {}) {
  if (typeof callbacks.logLifecycle !== "function") return;
  callbacks.logLifecycle({
    runID: state.runID,
    roomIndex: state.roomIndex,
    runtimeEntityID: state.runtimeEntityID,
    characterID: toInt(recipient && recipient.characterID, 0),
    effectName: state.profile.effectName,
    state: lifecycleState,
    reason: normalizeText(reason, "none"),
    ...extra,
  });
}

function warnOnce(callbacks, state, recipient, phase, reason) {
  const warningField = phase === "start" ? "startWarningEmitted" : "stopWarningEmitted";
  if (!recipient || recipient[warningField] === true) return;
  recipient[warningField] = true;
  if (typeof callbacks.warn === "function") {
    callbacks.warn({
      runID: state.runID,
      roomIndex: state.roomIndex,
      runtimeEntityID: state.runtimeEntityID,
      characterID: recipient.characterID,
      effectName: state.profile.effectName,
      phase,
      reason: normalizeText(reason, "unknown"),
    });
  }
}

function snapshotRecipient(recipient) {
  return {
    token: recipient.token,
    characterID: recipient.characterID,
    clientID: recipient.clientID,
    effectSent: recipient.effectSent,
    effectActive: recipient.effectActive,
    startAttemptCount: recipient.startAttemptCount,
    startCount: recipient.startCount,
    stopAttemptCount: recipient.stopAttemptCount,
    stopCount: recipient.stopCount,
    lastEffectStartedAt: recipient.lastEffectStartedAt,
    lastEffectStoppedAt: recipient.lastEffectStoppedAt,
    lastEffectStopReason: recipient.lastEffectStopReason,
    lastFailureReason: recipient.lastFailureReason,
  };
}

function snapshotState(state) {
  if (!state) return null;
  const recipients = [...state.recipients.values()].map(snapshotRecipient);
  return {
    key: state.key,
    runID: state.runID,
    roomIndex: state.roomIndex,
    runtimeEntityID: state.runtimeEntityID,
    typeID: state.typeID,
    sceneKey: state.sceneKey,
    entityMaterialized: state.entityMaterialized,
    effectDefinitionReady: state.effectDefinitionReady,
    effectProfileID: state.profile.profileID,
    effectName: state.profile.effectName,
    effectConfigured: state.effectConfigured,
    effectSent: state.effectStartCount > 0,
    effectActive: recipients.some((recipient) => recipient.effectActive === true),
    effectStartCount: state.effectStartCount,
    effectStopCount: state.effectStopCount,
    effectStartAttemptCount: state.effectStartAttemptCount,
    effectStopAttemptCount: state.effectStopAttemptCount,
    lastEffectStartedAt: state.lastEffectStartedAt,
    lastEffectStoppedAt: state.lastEffectStoppedAt,
    lastEffectStopReason: state.lastEffectStopReason,
    effectRecipientCount: recipients.filter((recipient) => recipient.effectSent).length,
    activeEffectRecipientCount: recipients.filter((recipient) => recipient.effectActive).length,
    effectRecipients: recipients,
  };
}

function registerSuppressorPresentationState(options = {}) {
  const runID = toInt(options.runID, 0);
  const roomIndex = toInt(options.roomIndex, 0);
  const runtimeEntityID = toInt(options.runtimeEntityID, 0);
  const typeID = toInt(options.typeID, 0);
  const sceneKey = normalizeText(options.sceneKey, "");
  const profile = getAbyssalSuppressorPresentationProfileByTypeID(typeID);
  const profileValidation = validateAbyssalSuppressorPresentationProfile(profile);
  if (
    runID <= 0 || roomIndex <= 0 || runtimeEntityID <= 0 ||
    sceneKey !== `abyssal-run:${runID}` ||
    !profileValidation.success
  ) {
    return {
      success: false,
      errorMsg: profileValidation.errorMsg || "ABYSSAL_SUPPRESSOR_FX_CONTEXT_INVALID",
    };
  }
  const key = buildStateKey(runID, roomIndex, runtimeEntityID);
  const existing = statesByKey.get(key);
  if (existing) {
    existing.entityMaterialized = options.entityMaterialized !== false;
    existing.sceneKey = sceneKey;
    return { success: true, created: false, data: snapshotState(existing) };
  }
  const state = {
    key,
    runID,
    roomIndex,
    runtimeEntityID,
    typeID,
    sceneKey,
    profile,
    entityMaterialized: options.entityMaterialized !== false,
    effectDefinitionReady: true,
    effectConfigured: true,
    effectStartCount: 0,
    effectStopCount: 0,
    effectStartAttemptCount: 0,
    effectStopAttemptCount: 0,
    lastEffectStartedAt: 0,
    lastEffectStoppedAt: 0,
    lastEffectStopReason: "",
    recipients: new Map(),
  };
  statesByKey.set(key, state);
  return { success: true, created: true, data: snapshotState(state) };
}

function getOrCreateRecipient(state, session) {
  const token = getSessionToken(session);
  let recipient = state.recipients.get(token);
  if (!recipient) {
    recipient = {
      token,
      session,
      characterID: getCharacterID(session),
      clientID: getClientID(session),
      effectSent: false,
      effectActive: false,
      startAttemptCount: 0,
      startCount: 0,
      stopAttemptCount: 0,
      stopCount: 0,
      lastEffectStartedAt: 0,
      lastEffectStoppedAt: 0,
      lastEffectStopReason: "",
      lastFailureReason: "",
      startWarningEmitted: false,
      stopWarningEmitted: false,
    };
    state.recipients.set(token, recipient);
  } else {
    recipient.session = session;
    recipient.characterID = getCharacterID(session);
    recipient.clientID = getClientID(session);
  }
  return recipient;
}

function validateStartContext(state, session, options) {
  if (!state || !session || !session._space) return "session-disconnected";
  const sessionScope = resolveExactSessionAbyssalScope(session);
  if (!sessionScope.run.valid || sessionScope.run.value !== state.runID) {
    return "wrong-run";
  }
  if (!sessionScope.scene.valid || sessionScope.scene.value !== state.sceneKey) {
    return "wrong-scene";
  }
  if (
    !sessionScope.room.valid ||
    sessionScope.room.value !== state.roomIndex ||
    toInt(options.currentRoomIndex, 0) !== state.roomIndex
  ) {
    return "wrong-room";
  }
  if (options.ballDelivered !== true) return "ball-not-delivered";
  if (options.roomVisible !== true) return "room-not-visible";
  if (options.entityActive !== true) return "entity-not-active";
  if (state.entityMaterialized !== true || state.effectConfigured !== true) {
    return "effect-not-configured";
  }
  return "";
}

function startSuppressorPresentationForSession(options = {}) {
  const state = statesByKey.get(buildStateKey(
    options.runID,
    options.roomIndex,
    options.runtimeEntityID,
  ));
  const callbacks = options.callbacks || {};
  const contextError = validateStartContext(state, options.session, options);
  if (contextError) {
    if (state) {
      emitLifecycle(callbacks, state, null, "skipped", contextError);
    }
    return { success: false, skipped: true, errorMsg: contextError };
  }
  const recipient = getOrCreateRecipient(state, options.session);
  if (recipient.effectActive === true) {
    emitLifecycle(callbacks, state, recipient, "skipped", "duplicate");
    return { success: true, duplicate: true, data: snapshotState(state) };
  }
  if (
    recipient.startAttemptCount > 0 &&
    options.allowRetry !== true
  ) {
    emitLifecycle(callbacks, state, recipient, "skipped", "duplicate-failed-attempt");
    return { success: false, skipped: true, errorMsg: "FX_START_RETRY_NOT_ALLOWED" };
  }
  if (recipient.startAttemptCount >= MAX_START_ATTEMPTS_PER_SESSION) {
    emitLifecycle(callbacks, state, recipient, "skipped", "retry-exhausted");
    return { success: false, skipped: true, errorMsg: "FX_START_RETRY_EXHAUSTED" };
  }
  recipient.startAttemptCount += 1;
  state.effectStartAttemptCount += 1;
  let result = null;
  try {
    result = typeof callbacks.sendStart === "function"
      ? callbacks.sendStart({ state: snapshotState(state), profile: state.profile, session: options.session })
      : { success: false, errorMsg: "FX_START_SENDER_UNAVAILABLE" };
  } catch (error) {
    result = { success: false, errorMsg: normalizeText(error && error.message, "FX_START_FAILED") };
  }
  if (!result || result.success !== true) {
    recipient.lastFailureReason = normalizeText(result && result.errorMsg, "FX_START_FAILED");
    warnOnce(callbacks, state, recipient, "start", recipient.lastFailureReason);
    emitLifecycle(callbacks, state, recipient, "failed", recipient.lastFailureReason);
    return { success: false, errorMsg: recipient.lastFailureReason, data: snapshotState(state) };
  }
  const startedAt = nowFromCallbacks(callbacks);
  recipient.effectSent = true;
  recipient.effectActive = true;
  recipient.startCount += 1;
  recipient.lastEffectStartedAt = startedAt;
  recipient.lastFailureReason = "";
  state.effectStartCount += 1;
  state.lastEffectStartedAt = startedAt;
  emitLifecycle(callbacks, state, recipient, "started", normalizeText(options.reason, "room-delivered"));
  return { success: true, data: snapshotState(state), sendResult: result };
}

function stopRecipient(state, recipient, callbacks, reason, notifyClient) {
  if (!recipient.effectActive) {
    emitLifecycle(callbacks, state, recipient, "skipped", "duplicate");
    return { success: true, duplicate: true };
  }
  recipient.stopAttemptCount += 1;
  state.effectStopAttemptCount += 1;
  let result = { success: true, skippedNotification: true };
  if (notifyClient !== false) {
    try {
      result = typeof callbacks.sendStop === "function"
        ? callbacks.sendStop({ state: snapshotState(state), profile: state.profile, session: recipient.session })
        : { success: false, errorMsg: "FX_STOP_SENDER_UNAVAILABLE" };
    } catch (error) {
      result = { success: false, errorMsg: normalizeText(error && error.message, "FX_STOP_FAILED") };
    }
  }
  const stoppedAt = nowFromCallbacks(callbacks);
  recipient.effectActive = false;
  recipient.lastEffectStoppedAt = stoppedAt;
  recipient.lastEffectStopReason = normalizeText(reason, "cleanup");
  state.lastEffectStoppedAt = stoppedAt;
  state.lastEffectStopReason = recipient.lastEffectStopReason;
  if (result && result.success === true && notifyClient !== false) {
    recipient.stopCount += 1;
    state.effectStopCount += 1;
    emitLifecycle(callbacks, state, recipient, "stopped", recipient.lastEffectStopReason);
    return { success: true, sendResult: result };
  }
  if (notifyClient === false) {
    emitLifecycle(callbacks, state, recipient, "stopped", recipient.lastEffectStopReason, {
      notificationSkipped: true,
    });
    return { success: true, notificationSkipped: true };
  }
  recipient.lastFailureReason = normalizeText(result && result.errorMsg, "FX_STOP_FAILED");
  warnOnce(callbacks, state, recipient, "stop", recipient.lastFailureReason);
  emitLifecycle(callbacks, state, recipient, "failed", recipient.lastFailureReason);
  return { success: false, errorMsg: recipient.lastFailureReason };
}

function stopSuppressorPresentationForSession(options = {}) {
  const state = statesByKey.get(buildStateKey(
    options.runID,
    options.roomIndex,
    options.runtimeEntityID,
  ));
  if (!state) return { success: true, alreadyGone: true };
  const recipient = state.recipients.get(getSessionToken(options.session));
  if (!recipient) return { success: true, alreadyGone: true };
  const result = stopRecipient(
    state,
    recipient,
    options.callbacks || {},
    options.reason,
    options.notifyClient,
  );
  return { ...result, data: snapshotState(state) };
}

function stopSuppressorPresentationsForRun(options = {}) {
  const runID = toInt(options.runID, 0);
  const roomIndex = options.roomIndex == null ? null : toInt(options.roomIndex, 0);
  const runtimeEntityID = options.runtimeEntityID == null
    ? null
    : toInt(options.runtimeEntityID, 0);
  const results = [];
  for (const state of statesByKey.values()) {
    if (
      state.runID !== runID ||
      (roomIndex !== null && state.roomIndex !== roomIndex) ||
      (runtimeEntityID !== null && state.runtimeEntityID !== runtimeEntityID)
    ) {
      continue;
    }
    for (const recipient of state.recipients.values()) {
      results.push(stopRecipient(
        state,
        recipient,
        options.callbacks || {},
        options.reason,
        options.notifyClient,
      ));
    }
  }
  return results;
}

function cleanupSuppressorPresentationStateByEntity(runID, runtimeEntityID) {
  let removed = 0;
  for (const [key, state] of [...statesByKey.entries()]) {
    if (
      state.runID === toInt(runID, 0) &&
      state.runtimeEntityID === toInt(runtimeEntityID, 0)
    ) {
      statesByKey.delete(key);
      removed += 1;
    }
  }
  return removed;
}

function cleanupSuppressorPresentationStatesForRun(runID) {
  let removed = 0;
  for (const [key, state] of [...statesByKey.entries()]) {
    if (state.runID === toInt(runID, 0)) {
      statesByKey.delete(key);
      removed += 1;
    }
  }
  return removed;
}

function getSuppressorPresentationState(runID, roomIndex, runtimeEntityID) {
  return snapshotState(statesByKey.get(buildStateKey(runID, roomIndex, runtimeEntityID)));
}

function listSuppressorPresentationStatesForRun(runID, roomIndex = null) {
  return [...statesByKey.values()]
    .filter((state) => (
      state.runID === toInt(runID, 0) &&
      (roomIndex == null || state.roomIndex === toInt(roomIndex, 0))
    ))
    .map(snapshotState)
    .sort((left, right) => (
      left.roomIndex - right.roomIndex ||
      left.runtimeEntityID - right.runtimeEntityID
    ));
}

function resetSuppressorPresentationStatesForTests() {
  statesByKey.clear();
  sessionTokens = new WeakMap();
  nextSessionToken = 1;
}

module.exports = {
  MAX_START_ATTEMPTS_PER_SESSION,
  buildStateKey,
  cleanupSuppressorPresentationStateByEntity,
  cleanupSuppressorPresentationStatesForRun,
  getSuppressorPresentationState,
  listSuppressorPresentationStatesForRun,
  registerSuppressorPresentationState,
  resetSuppressorPresentationStatesForTests,
  startSuppressorPresentationForSession,
  stopSuppressorPresentationForSession,
  stopSuppressorPresentationsForRun,
};
