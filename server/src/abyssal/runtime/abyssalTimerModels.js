"use strict";
const { toInt, normalizeText, toBool } = require("../domain/abyssalRuntimeValues");

function resolveConfiguredAbyssalDurationMs(ports, contentProfile = null, deps = ports.getDependencies()) {
  const {
    ABYSS_RUN_DURATION_MS,
  } = ports;
  const overrideDurationMs = toInt(
    deps && deps.abyssalPlaceholderDurationMs,
    0,
  );
  if (overrideDurationMs > 0) {
    return overrideDurationMs;
  }
  return Math.max(1, toInt(contentProfile && contentProfile.timerDurationMs, ABYSS_RUN_DURATION_MS));
}

function resolveConfiguredUnusedTraceDurationMs(ports, deps = ports.getDependencies()) {
  const {
    ABYSS_UNUSED_TRACE_DURATION_MS,
  } = ports;
  const overrideDurationMs = toInt(
    deps && deps.abyssalUnusedTraceDurationMs,
    0,
  );
  return overrideDurationMs > 0
    ? overrideDurationMs
    : ABYSS_UNUSED_TRACE_DURATION_MS;
}

function resolveConfiguredAbyssalReturnProtectionDurationMs(ports, deps = ports.getDependencies()) {
  const {
    ABYSS_RETURN_PROTECTION_DURATION_MS,
  } = ports;
  const overrideDurationMs = toInt(
    deps && deps.abyssalReturnProtectionDurationMs,
    -1,
  );
  return overrideDurationMs >= 0
    ? overrideDurationMs
    : ABYSS_RETURN_PROTECTION_DURATION_MS;
}

function getAbyssalTimeoutPolicy(ports) {
  const {
    ABYSSAL_TIMEOUT_MODE,
  } = ports;
  return {
    lethalTimeoutEnabled: true,
    mode: ABYSSAL_TIMEOUT_MODE.LETHAL,
  };
}

function resolvePlaceholderDurationMs(ports, source = null, deps = ports.getDependencies()) {
  const {
    getContentProfile,
  } = ports;
  return resolveConfiguredAbyssalDurationMs(ports,
    getContentProfile(source) || source,
    deps,
  );
}

function getAbyssalTimeoutState(ports, pocketState, deps = ports.getDependencies()) {
  const {
    hasFailedTimeoutOutcome,
    ABYSSAL_TIMEOUT_MODE,
    ABYSSAL_TIMEOUT_POD_STATUS,
  } = ports;
  const policy = getAbyssalTimeoutPolicy(ports, deps);
  const timeoutState =
    pocketState && pocketState.timeoutState && typeof pocketState.timeoutState === "object"
      ? pocketState.timeoutState
      : {};
  const failedTimeout = hasFailedTimeoutOutcome(pocketState);
  return {
    mode: failedTimeout
      ? ABYSSAL_TIMEOUT_MODE.LETHAL
      : normalizeText(timeoutState.mode, policy.mode),
    lethalTimeoutEnabled: failedTimeout
      ? true
      : toBool(timeoutState.lethalTimeoutEnabled, policy.lethalTimeoutEnabled),
    shipDestroyed: timeoutState.shipDestroyed === true,
    podDestroyed: timeoutState.podDestroyed === true,
    cleanupTriggered: timeoutState.cleanupTriggered === true,
    reason: normalizeText(timeoutState.reason, ""),
    podDestructionReason: normalizeText(
      timeoutState.podDestructionReason,
      ABYSSAL_TIMEOUT_POD_STATUS.NO_SAFE_HOOK,
    ),
    expiredAtMs: toInt(
      timeoutState.expiredAtMs,
      toInt(pocketState && pocketState.failedAtMs, 0),
    ),
    pendingWarningReason: normalizeText(timeoutState.pendingWarningReason, ""),
    pendingWarningAtMs: toInt(timeoutState.pendingWarningAtMs, 0),
  };
}

function buildPlaceholderTimerState(ports, pocketState, deps = ports.getDependencies()) {
  const preparedAtMs = toInt(deps.now(), 0);
  const durationMs = resolvePlaceholderDurationMs(ports, pocketState, deps);
  const provisionalExpiresAtMs = preparedAtMs + durationMs;
  return {
    preparedAtMs,
    startedAtMs: 0,
    durationMs,
    expiresAtMs: provisionalExpiresAtMs,
    anchorState: "pending_room1_entry_notification",
    anchoredAtMs: 0,
    anchorPhase: "entry-admission-pending-client-handoff",
    anchorReason: "awaiting-first-successful-expiry-notification-handoff",
    provisionalStartedAtMs: preparedAtMs,
    provisionalExpiresAtMs,
    expired: false,
    expiryLoggedAtMs: 0,
  };
}

function createAbyssalTimerModels(ports) {
  return {
    resolveConfiguredAbyssalDurationMs: resolveConfiguredAbyssalDurationMs.bind(null, ports),
    resolveConfiguredUnusedTraceDurationMs: resolveConfiguredUnusedTraceDurationMs.bind(null, ports),
    resolveConfiguredAbyssalReturnProtectionDurationMs: resolveConfiguredAbyssalReturnProtectionDurationMs.bind(null, ports),
    getAbyssalTimeoutPolicy: getAbyssalTimeoutPolicy.bind(null, ports),
    resolvePlaceholderDurationMs: resolvePlaceholderDurationMs.bind(null, ports),
    getAbyssalTimeoutState: getAbyssalTimeoutState.bind(null, ports),
    buildPlaceholderTimerState: buildPlaceholderTimerState.bind(null, ports),
  };
}

module.exports = { createAbyssalTimerModels };
