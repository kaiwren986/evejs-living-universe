"use strict";

module.exports = {
  buildActiveSpecialFxEffectStateEntriesForSetState,
  buildCloakModuleSpecialFxTimingOptions,
  buildFreshAcquireActiveSpecialFxReplayUpdates,
  buildMiningSpecialFxTimingOptions,
  buildSpecialFxEffectStateReplayKey,
  filterSetStateDuplicateSpecialFxReplayUpdates,
  resolveSpecialFxRepeatCount,
  shouldReplayActiveSpecialFxForFreshAcquire,
};

const runtimeEntryDirname = require("path").resolve(__dirname, "..");
const path = require("path");
const {
  buildActiveSpecialFxEffectStateEntriesForSetState:
    buildActiveSpecialFxEffectStateEntriesForSetStatePlan,
  buildFreshAcquireActiveSpecialFxReplayUpdates:
    buildFreshAcquireActiveSpecialFxReplayUpdatesPlan,
  shouldReplayActiveSpecialFxForFreshAcquire:
    shouldReplayActiveSpecialFxForFreshAcquirePlan,
} = require(path.join(
  runtimeEntryDirname,
  "./destiny/presentation/activeSpecialFxReplay.js",
));
const {
  currentFileTime,
  buildFiletimeLong,
  buildMarshalReal,
} = require(path.join(runtimeEntryDirname, "../services/_shared/serviceHelpers"));
const {
  buildWeaponModuleSnapshot,
  isChargeOptionalTurretWeapon,
  isMissileWeaponFamily,
  isVortonWeaponFamily,
  isTurretCycleWeaponFamily,
  isDefenderMissileWeaponSnapshot,
  resolveWeaponFamily,
  resolveWeaponSpecialFxGUID,
} = require(path.join(runtimeEntryDirname, "./combat/weaponDogma"));
const {
  buildSuperweaponFreshAcquireFxOptions,
  prepareSuperweaponActivation,
  executeSuperweaponActivation,
  finalizeSuperweaponDeactivation,
  isSuperweaponFxReplayWindowActive,
  tickScene: tickSuperweaponScene,
  isSuperweaponMovementLocked,
  isSuperweaponJumpOrCloakLocked,
  entityHasCloakDisallowingFittedModule,
} = require(path.join(runtimeEntryDirname, "./modules/superweapons/superweaponRuntime"));
const {
  normalizeEffectRepeatCount,
} = require("./moduleCycleSchedule");
const {
  buildGenericModuleSpecialFxGraphicInfo,
  buildSpecialFxPayloadsForEntity,
} = require("./moduleSpecialFx");
const {
  toFiniteNumber,
} = require("../../common/numbers");
const {
  FILETIME_TICKS_PER_MS,
  toFileTimeFromMs,
} = require("./runtimeClock");
const {
  isCloakingModuleEffectState,
} = require("./shipCloak");
const {
  isOffensiveWeaponFamily,
} = require("./weaponSnapshot");

const SPECIAL_FX_REPEAT_WINDOW_MS = 12 * 60 * 60 * 1000;

const FRESH_ACQUIRE_REPLAYABLE_STATEFUL_SELF_BUFF_GUIDS = new Set([
  "effects.SiegeMode",
]);

function resolveSpecialFxRepeatCount(effectState, fallbackRepeat = null) {
  if (effectState && effectState.miningEffect === true) {
    // The activate verb often carries repeat=1 for mining modules, but the
    // beam presentation is continuous. If we honor that explicit repeat on the
    // FX payload, observers see exactly one cycle of beam and then it expires
    // even though the server keeps mining. Mining beams therefore always use a
    // long replay window instead of the client-supplied repeat count.
    const durationMs = Math.max(1, toFiniteNumber(effectState.durationMs, 1000));
    return Math.max(1, Math.ceil(SPECIAL_FX_REPEAT_WINDOW_MS / durationMs));
  }

  const explicitRepeat = normalizeEffectRepeatCount(
    effectState && effectState.repeat,
    null,
  );
  if (explicitRepeat !== null) {
    return explicitRepeat;
  }

  if (
    !effectState ||
    (
      !isTurretCycleWeaponFamily(effectState.weaponFamily) &&
      !isMissileWeaponFamily(effectState.weaponFamily)
    )
  ) {
    return fallbackRepeat;
  }

  const durationMs = Math.max(1, toFiniteNumber(effectState.durationMs, 1000));
  return Math.max(1, Math.ceil(SPECIAL_FX_REPEAT_WINDOW_MS / durationMs));
}

function buildMiningSpecialFxTimingOptions(
  effectState,
  nowMs,
  options = {},
) {
  if (!effectState || effectState.miningEffect !== true) {
    return {};
  }

  const startedAtMs = toFiniteNumber(effectState.startedAtMs, nowMs);
  const elapsedTicks = Math.max(
    0,
    Math.round(
      (toFiniteNumber(nowMs, startedAtMs) - startedAtMs) *
        Number(FILETIME_TICKS_PER_MS),
    ),
  );
  return {
    repeat: resolveSpecialFxRepeatCount(effectState),
    startTime: toFileTimeFromMs(startedAtMs, currentFileTime()),
    timeFromStart: options.includeElapsed === true ? elapsedTicks : 0,
  };
}

function buildCloakModuleSpecialFxTimingOptions(
  effectState,
  nowMs,
  options = {},
) {
  if (!isCloakingModuleEffectState(effectState)) {
    return {};
  }

  const startedAtMs = toFiniteNumber(effectState.startedAtMs, nowMs);
  const elapsedTicks = Math.max(
    0,
    Math.round(
      (toFiniteNumber(nowMs, startedAtMs) - startedAtMs) *
        Number(FILETIME_TICKS_PER_MS),
    ),
  );
  return {
    repeat: 0,
    startTime: toFileTimeFromMs(startedAtMs, currentFileTime()),
    timeFromStart: options.includeElapsed === true ? elapsedTicks : 0,
  };
}

function shouldReplayActiveSpecialFxForFreshAcquire(effectState, nowMs = Date.now()) {
  return shouldReplayActiveSpecialFxForFreshAcquirePlan(effectState, {
    isOffensiveWeaponFamily,
    isSuperweaponFxReplayWindowActive,
    nowMs,
    replayableStatefulSelfBuffGuids:
      FRESH_ACQUIRE_REPLAYABLE_STATEFUL_SELF_BUFF_GUIDS,
    toFiniteNumber,
  });
}

function buildFreshAcquireActiveSpecialFxReplayUpdates(
  entities,
  stamp,
  nowMs = Date.now(),
  options = {},
) {
  return buildFreshAcquireActiveSpecialFxReplayUpdatesPlan({
    buildGenericModuleSpecialFxGraphicInfo,
    buildSpecialFxPayloadsForEntity,
    buildSuperweaponFreshAcquireFxOptions,
    entities,
    isOffensiveWeaponFamily,
    isSuperweaponFxReplayWindowActive,
    nowMs,
    replayableStatefulSelfBuffGuids:
      FRESH_ACQUIRE_REPLAYABLE_STATEFUL_SELF_BUFF_GUIDS,
    resolveSpecialFxRepeatCount,
    scene: options.scene || null,
    stamp,
    toFiniteNumber,
  });
}

function buildActiveSpecialFxEffectStateEntriesForSetState(
  scene,
  entities,
  nowMs = Date.now(),
) {
  return buildActiveSpecialFxEffectStateEntriesForSetStatePlan({
    buildGenericModuleSpecialFxGraphicInfo,
    buildMiningSpecialFxTimingOptions,
    buildSpecialFxPayloadsForEntity,
    buildSuperweaponFreshAcquireFxOptions,
    entities,
    isOffensiveWeaponFamily,
    isSuperweaponFxReplayWindowActive,
    nowMs,
    replayableStatefulSelfBuffGuids:
      FRESH_ACQUIRE_REPLAYABLE_STATEFUL_SELF_BUFF_GUIDS,
    resolveSpecialFxRepeatCount,
    scene,
    toFiniteNumber,
  });
}

function buildSpecialFxEffectStateReplayKey(args) {
  if (!Array.isArray(args)) {
    return null;
  }
  return [
    args[0],
    args[1],
    args[2],
    args[3],
    args[4],
    args[5],
    args[7],
    args[8],
  ].map((value) => String(value ?? "")).join("|");
}

function filterSetStateDuplicateSpecialFxReplayUpdates(updates, effectStateEntries) {
  if (
    !Array.isArray(updates) ||
    updates.length === 0 ||
    !Array.isArray(effectStateEntries) ||
    effectStateEntries.length === 0
  ) {
    return Array.isArray(updates) ? updates : [];
  }

  const setStateKeys = new Set(
    effectStateEntries
      .map((entry) => buildSpecialFxEffectStateReplayKey(entry))
      .filter((key) => key),
  );
  if (setStateKeys.size === 0) {
    return updates;
  }

  return updates.filter((update) => {
    const payload = update && update.payload;
    if (
      !Array.isArray(payload) ||
      payload[0] !== "OnSpecialFX" ||
      !Array.isArray(payload[1])
    ) {
      return true;
    }
    const key = buildSpecialFxEffectStateReplayKey(payload[1]);
    return !key || !setStateKeys.has(key);
  });
}

Object.assign(module.exports, {
  FRESH_ACQUIRE_REPLAYABLE_STATEFUL_SELF_BUFF_GUIDS,
  SPECIAL_FX_REPEAT_WINDOW_MS,
});
