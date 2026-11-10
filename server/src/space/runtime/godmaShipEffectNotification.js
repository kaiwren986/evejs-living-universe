"use strict";

const { queueDogmaEvent } = require("./dogmaEvents");

module.exports = {
  buildGenericModuleEffectStateDogmaEvent,
  buildGenericModuleEffectStateNotification,
  buildGodmaShipEffectUserError,
  buildGodmaUserErrorTypeValue,
  buildModuleEffectEnvironment,
  getGodmaShipEffectErrorName,
  getGodmaShipEffectStopReason,
  logModuleEffectNotification,
  notifyGenericModuleEffectState,
  notifyModuleEffectState,
  resolveGodmaShipEffectErrorValue,
  resolveGodmaShipEffectRepeatValue,
  resolveModuleEffectChargeContext,
  resolveProjectedAttributeEffectRecord,
};

const runtimeEntryDirname = require("path").resolve(__dirname, "..");
const path = require("path");
const log = require(path.join(runtimeEntryDirname, "../utils/logger"));
const {
  getFittedModuleItems,
  listFittedItemsForLocation,
  buildSlimModuleTuples,
  buildCharacterTargetingState,
  buildChargeTupleItemID,
  buildShipResourceState,
  SLOT_FAMILY_FLAGS,
  getAttributeIDByNames,
  getEffectIDByNames,
  getTypeDogmaAttributes,
  getTypeDogmaEffects,
  getTypeEffectRecords,
  getPassiveModifierEffectRecords,
  getTypeAttributeValue,
  getEffectTypeRecord,
  getRequiredSkillRequirements,
  getLoadedChargeByFlag,
  isChargeCompatibleWithModule,
  isModuleOnline,
  isStructureDogmaHost,
  resolveDogmaSkillMapForHost,
  appendDirectModifierEntries,
  buildEffectiveItemAttributeMap,
  indexOverloadEffectRecordsByModuleID,
  buildProjectedModuleSourceAttributeMap,
} = require(path.join(runtimeEntryDirname, "../services/fitting/liveFittingState"));
const {
  currentFileTime,
  buildFiletimeLong,
  buildMarshalReal,
} = require(path.join(runtimeEntryDirname, "../services/_shared/serviceHelpers"));
const {
  notifyFittedGenericModuleModifiedAttributesToSession,
} = require("./attributeChangeNotification");
const {
  getEntityRuntimeLoadedCharge,
} = require("./entityDogmaView");
const {
  marshalModuleDurationWireValue,
} = require("./marshalWireValues");
const {
  normalizeEffectRepeatCount,
} = require("./moduleCycleSchedule");
const {
  toInt,
} = require("../../common/numbers");
const {
  getPropulsionEffectID,
} = require("./propulsionModule");
const {
  recordSessionJumpTimingTrace,
} = require("./runtimeDebugInstrumentation");
const {
  resolveSessionNotificationFileTime,
} = require("./sessionNotificationTime");
const {
  isSnapshotWeaponFamily,
} = require("./weaponSnapshot");

function resolveModuleEffectChargeContext(session, entity, effectState) {
  const shipID = toInt(entity && entity.itemID, 0);
  const moduleFlagID = toInt(effectState && effectState.moduleFlagID, 0);
  let chargeTypeID = toInt(effectState && effectState.chargeTypeID, 0);

  if (
    chargeTypeID <= 0 &&
    shipID > 0 &&
    moduleFlagID > 0
  ) {
    const loadedCharge = getEntityRuntimeLoadedCharge(
      entity,
      null,
      moduleFlagID,
    );
    chargeTypeID = toInt(loadedCharge && loadedCharge.typeID, 0);
  }

  return {
    moduleFlagID,
    chargeTypeID,
    subLocation:
      shipID > 0 && moduleFlagID > 0 && chargeTypeID > 0
        ? buildChargeTupleItemID(shipID, moduleFlagID, chargeTypeID)
        : null,
  };
}

function buildModuleEffectEnvironment(session, entity, effectState, effectID) {
  const chargeContext = resolveModuleEffectChargeContext(
    session,
    entity,
    effectState,
  );
  return {
    environment: [
      toInt(effectState && effectState.moduleID, 0),
      toInt(entity && entity.ownerID, 0),
      toInt(entity && entity.itemID, 0),
      toInt(effectState && effectState.targetID, 0) > 0
        ? toInt(effectState && effectState.targetID, 0)
        : null,
      chargeContext.subLocation,
      [],
      effectID,
      null,
    ],
    chargeContext,
  };
}

function logModuleEffectNotification(kind, active, effectState, effectID, chargeContext, environment) {
  const normalizedSubLocation = Array.isArray(chargeContext.subLocation)
    ? `(${chargeContext.subLocation.join(",")})`
    : "null";
  log.debug(
    [
      `[module-fx:${kind}]`,
      `active=${active ? 1 : 0}`,
      `moduleID=${toInt(effectState && effectState.moduleID, 0)}`,
      `moduleFlagID=${toInt(chargeContext && chargeContext.moduleFlagID, 0)}`,
      `chargeTypeID=${toInt(chargeContext && chargeContext.chargeTypeID, 0)}`,
      `targetID=${toInt(effectState && effectState.targetID, 0)}`,
      `effectID=${toInt(effectID, 0)}`,
      `subLoc=${normalizedSubLocation}`,
      `environment=${JSON.stringify(environment)}`,
    ].join(" "),
  );
}

function notifyModuleEffectState(
  session,
  entity,
  effectState,
  active,
  options = {},
) {
  if (
    !session ||
    typeof session.sendNotification !== "function" ||
    !entity ||
    !effectState
  ) {
    return false;
  }

  const effectID = getPropulsionEffectID(effectState.effectName);
  if (effectID <= 0) {
    return false;
  }

  // The event's own times, never a tick's.
  const resolveNotificationFileTime = resolveSessionNotificationFileTime;

  let when;
  if (options.whenMs != null) {
    when = resolveNotificationFileTime(session, options.whenMs);
  } else if (session && session._space && session._space.simFileTime) {
    when = resolveNotificationFileTime(session);
  } else {
    log.warn("notifyModuleEffectState: no sim time source, using wallclock fallback");
    when = currentFileTime();
  }
  const resolvedStartedAt = resolveNotificationFileTime(
    session,
    options.startTimeMs === undefined || options.startTimeMs === null
      ? effectState.startedAtMs
      : options.startTimeMs,
  );
  const durationMs = Number.isFinite(Number(effectState.durationMs))
    ? Math.max(Number(effectState.durationMs), -1)
    : -1;
  const duration = marshalModuleDurationWireValue(durationMs);
  const error = resolveGodmaShipEffectErrorValue(effectState, active, options);
  const repeat = resolveGodmaShipEffectRepeatValue(effectState, active, options, error);
  const { environment, chargeContext } = buildModuleEffectEnvironment(
    session,
    entity,
    effectState,
    effectID,
  );
  queueDogmaEvent(session, "OnGodmaShipEffect", [
    toInt(effectState.moduleID, 0),
    effectID,
    when,
    active ? 1 : 0,
    active ? 1 : 0,
    environment,
    resolvedStartedAt,
    duration,
    repeat,
    error,
  ], { time: when });
  logModuleEffectNotification(
    "propulsion",
    active,
    effectState,
    effectID,
    chargeContext,
    environment,
  );
  recordSessionJumpTimingTrace(session, "module-effect-state", {
    moduleID: toInt(effectState.moduleID, 0),
    moduleFlagID: toInt(chargeContext.moduleFlagID, 0),
    chargeTypeID: toInt(chargeContext.chargeTypeID, 0),
    chargeSubLocation: chargeContext.subLocation,
    effectName: effectState.effectName || null,
    effectID,
    active: active === true,
    when,
    startedAt: resolvedStartedAt,
    durationMs,
    repeat,
    error,
    sessionSimTimeMs: session && session._space ? session._space.simTimeMs : null,
    sessionTimeDilation:
      session && session._space ? session._space.timeDilation : null,
  });
  return true;
}

function buildGenericModuleEffectStateNotification(
  session,
  entity,
  effectState,
  active,
  options = {},
) {
  if (
    !session ||
    typeof session.sendNotification !== "function" ||
    !entity ||
    !effectState
  ) {
    return false;
  }

  const effectID = toInt(effectState.effectID, 0);
  if (effectID <= 0) {
    return false;
  }

  // The event's own times, never a tick's.
  const resolveNotificationFileTime = resolveSessionNotificationFileTime;

  let when;
  if (options.whenMs != null) {
    when = resolveNotificationFileTime(session, options.whenMs);
  } else if (session && session._space && session._space.simFileTime) {
    when = resolveNotificationFileTime(session);
  } else {
    log.warn("notifyGenericModuleEffectState: no sim time source, using wallclock fallback");
    when = currentFileTime();
  }
  const startedAt = resolveNotificationFileTime(
    session,
    options.startTimeMs === undefined || options.startTimeMs === null
      ? effectState.startedAtMs
      : options.startTimeMs,
  );
  const durationMs = Number.isFinite(Number(effectState.durationMs))
    ? Math.max(Number(effectState.durationMs), -1)
    : -1;
  const duration = marshalModuleDurationWireValue(durationMs);
  const error = resolveGodmaShipEffectErrorValue(effectState, active, options);
  const repeat = resolveGodmaShipEffectRepeatValue(effectState, active, options, error);
  const { environment, chargeContext } = buildModuleEffectEnvironment(
    session,
    entity,
    effectState,
    effectID,
  );
  const payload = [
    toInt(effectState.moduleID, 0),
    effectID,
    when,
    active ? 1 : 0,
    active ? 1 : 0,
    environment,
    startedAt,
    duration,
    repeat,
    error,
  ];
  return {
    payload,
    when,
    startedAt,
    durationMs,
    repeat,
    error,
    chargeContext,
    environment,
    effectID,
  };
}

function buildGenericModuleEffectStateDogmaEvent(
  session,
  entity,
  effectState,
  active,
  options = {},
) {
  const notification = buildGenericModuleEffectStateNotification(
    session,
    entity,
    effectState,
    active,
    options,
  );
  if (!notification) {
    return null;
  }
  return [
    ["OnGodmaShipEffect", ...notification.payload],
    notification.when,
  ];
}

// Which effect's modifierInfo decides what gets republished. An overload
// transition arrives as buildOverloadEffectState, which carries no effectRecord
// at all — but overloading a running Tracking Computer does change the strength
// it projects onto the guns, so fall back to the generic effect the module is
// still running. A module that is not cycling projects nothing and resolves to
// null, which the publisher treats as "no attributes to push".
function resolveProjectedAttributeEffectRecord(entity, effectState) {
  if (effectState && effectState.effectRecord) {
    return effectState.effectRecord;
  }
  const moduleID = toInt(effectState && effectState.moduleID, 0);
  if (moduleID <= 0 || !(entity && entity.activeModuleEffects instanceof Map)) {
    return null;
  }
  const runningEffectState = entity.activeModuleEffects.get(moduleID) || null;
  return runningEffectState && runningEffectState.effectRecord
    ? runningEffectState.effectRecord
    : null;
}

function notifyGenericModuleEffectState(
  session,
  entity,
  effectState,
  active,
  options = {},
) {
  const notification = buildGenericModuleEffectStateNotification(
    session,
    entity,
    effectState,
    active,
    options,
  );
  if (!notification) {
    return false;
  }

  queueDogmaEvent(session, "OnGodmaShipEffect", notification.payload, { time: notification.when });
  logModuleEffectNotification(
    "generic",
    active,
    effectState,
    notification.effectID,
    notification.chargeContext,
    notification.environment,
  );
  recordSessionJumpTimingTrace(session, "generic-module-effect-state", {
    moduleID: toInt(effectState.moduleID, 0),
    moduleFlagID: toInt(notification.chargeContext.moduleFlagID, 0),
    chargeTypeID: toInt(notification.chargeContext.chargeTypeID, 0),
    chargeSubLocation: notification.chargeContext.subLocation,
    effectName: effectState.effectName || null,
    effectID: notification.effectID,
    active: active === true,
    when: notification.when,
    startedAt: notification.startedAt,
    durationMs: notification.durationMs,
    repeat: notification.repeat,
    error: notification.error,
    sessionSimTimeMs: session && session._space ? session._space.simTimeMs : null,
    sessionTimeDilation:
      session && session._space ? session._space.timeDilation : null,
  });
  // Both edges of the transition, because the client needs the boosted value
  // when the module starts and the plain one when it stops. Every caller has
  // already added the effect to (or removed it from) activeModuleEffects before
  // it notifies, so the recompute below reads the post-transition rack.
  //
  // `repeatNotification` marks the OnGodmaShipEffect a *running* module re-emits
  // — at every cycle boundary, and again when a reload finishes — where nothing
  // about the rack has changed. Those must not reach the recompute: it walks
  // every online module and resolves a turret through a full
  // buildWeaponModuleSnapshot, which is not work the tick can afford once per
  // cycle per ship, and it would only republish values the client already has.
  if (options.repeatNotification !== true) {
    notifyFittedGenericModuleModifiedAttributesToSession(
      session,
      entity,
      resolveProjectedAttributeEffectRecord(entity, effectState),
      {
        whenMs: options.whenMs === undefined ? null : options.whenMs,
        sourceModuleID: toInt(effectState.moduleID, 0),
      },
    );
  }
  return true;
}

function buildGodmaUserErrorTypeValue(typeID) {
  const normalizedTypeID = toInt(typeID, 0);
  return normalizedTypeID > 0 ? [4, normalizedTypeID] : normalizedTypeID;
}

function buildGodmaShipEffectUserError(errorName, entries = []) {
  return [
    String(errorName || ""),
    {
      type: "dict",
      entries: Array.isArray(entries) ? entries : [],
    },
  ];
}

function getGodmaShipEffectStopReason(effectState, options = {}) {
  return String(
    (options && options.reason) ||
      (effectState && effectState.stopReason) ||
      "",
  );
}

function resolveGodmaShipEffectErrorValue(effectState, active, options = {}) {
  if (options && options.error !== undefined) {
    return options.error;
  }

  if (active === true || !effectState) {
    return null;
  }

  const stopReason = getGodmaShipEffectStopReason(effectState, options);
  const homefrontMessages = require("../../services/homefront/homefrontMessages");
  if (stopReason === homefrontMessages.DREAD_SIEGE_STOP_REASON) {
    return buildGodmaShipEffectUserError("CustomNotify", [
      ["notify", homefrontMessages.DREAD_SIEGE_MESSAGE],
    ]);
  }
  const moduleTypeID = toInt(effectState.typeID, 0);
  if (stopReason === "ammo" && isSnapshotWeaponFamily(effectState.weaponFamily)) {
    return buildGodmaShipEffectUserError("NoCharges", [
      ["launcher", buildGodmaUserErrorTypeValue(moduleTypeID)],
    ]);
  }
  if (stopReason === "miningDepleted") {
    return buildGodmaShipEffectUserError("MiningDronesDeactivatedAsteroidEmpty", [
      ["asteroidname", ""],
      ["modulename", buildGodmaUserErrorTypeValue(moduleTypeID)],
    ]);
  }

  return null;
}

function getGodmaShipEffectErrorName(errorValue) {
  return Array.isArray(errorValue) ? String(errorValue[0] || "") : "";
}

function resolveGodmaShipEffectRepeatValue(
  effectState,
  active,
  options = {},
  errorValue = null,
) {
  if (options && options.repeat !== undefined) {
    return options.repeat;
  }

  if (active !== true) {
    const errorName = getGodmaShipEffectErrorName(errorValue);
    if (errorName === "NoCharges") {
      return true;
    }
    if (errorName === "MiningDronesDeactivatedAsteroidEmpty") {
      return 0;
    }
    return false;
  }

  return normalizeEffectRepeatCount(effectState && effectState.repeat, -1);
}
