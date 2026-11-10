"use strict";

const { queueDogmaEvent } = require("./dogmaEvents");

module.exports = {
  buildAttributeChange,
  buildEntityDerivedAttributeSnapshot,
  buildFittedGenericModuleAttributeDiffChanges,
  captureFittedGenericModuleAttributeSnapshots,
  collectProjectedFittedModuleAttributeIDs,
  isDogmaFileTimeAttribute,
  isModuleTimingAttribute,
  marshalRuntimeAttributeChangeValue,
  notifyAttributeChanges,
  notifyCapacitorChangeToSession,
  notifyFittedGenericModuleAttributeDiffToSession,
  notifyFittedGenericModuleModifiedAttributesToSession,
  notifyFittedGenericModuleRangeAttributesToSession,
  notifyGenericDerivedAttributesToSession,
  notifyPropulsionDerivedAttributesToSession,
  notifyShipDerivedAttributesToSession,
  notifyTargetingDerivedAttributesToSession,
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
const commandBurstRuntime = require(path.join(
  runtimeEntryDirname,
  "./modules/commandBurstRuntime",
));
const {
  collectNumericModuleAttributeDiffs,
  resolveModuleSnapshotDirectModifierEntries,
} = require(path.join(
  runtimeEntryDirname,
  "./modules/moduleAttributeDiff",
));
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
  ATTRIBUTE_DAMAGE_MULTIPLIER_BONUS_CURRENT,
  ATTRIBUTE_DAMAGE_MULTIPLIER_BONUS_MAX_TIMESTAMP,
  isPrecursorTurretFamily,
  initializePrecursorTurretEffectState,
  synchronizePrecursorTurretEffectState,
  advancePrecursorTurretSpool,
  resetPrecursorTurretSpool,
  buildPrecursorTurretGraphicInfo,
  applyPrecursorTurretSpoolToSnapshot,
} = require(path.join(runtimeEntryDirname, "./combat/precursorTurrets"));
const {
  collectEntityWormholeLocationModifierSources,
} = require("./activeShipModifiers");
const {
  ATTRIBUTE_CHARGE,
  ATTRIBUTE_CLOAKING_TARGETING_DELAY,
  ATTRIBUTE_MASS,
  ATTRIBUTE_MAX_LOCKED_TARGETS,
  ATTRIBUTE_MAX_TARGET_RANGE,
  ATTRIBUTE_MAX_VELOCITY,
  ATTRIBUTE_SCAN_RESOLUTION,
  ATTRIBUTE_SHIP_SHIELD_CHARGE,
  ATTRIBUTE_SIGNATURE_RADIUS,
} = require("./dogmaAttributeIds");
const {
  getEntityCapacitorRatio,
} = require("./entityCapacitor");
const {
  getEntityRuntimeActiveModuleContexts,
  getEntityRuntimeFittedItems,
  getEntityRuntimeLoadedCharge,
  getEntityRuntimeShipItem,
  getEntityRuntimeSkillMap,
  getShipEntityInventoryCharacterID,
} = require("./entityDogmaView");
const {
  marshalModuleDurationWireValue,
} = require("./marshalWireValues");
const {
  getGenericModuleRuntimeAttributes,
} = require("./moduleAttributes");
const {
  isMiningModuleItem,
} = require("./moduleHeat");
const {
  clamp,
  roundNumber,
  toFiniteNumber,
  toInt,
} = require("../../common/numbers");
const {
  getShipDogmaMotionValue,
} = require("./pendingShipMotion");
const {
  resolveSessionNotificationFileTime,
} = require("./sessionNotificationTime");
const {
  buildEntityTargetingAttributeSnapshot,
} = require("./targeting");
const {
  isSnapshotWeaponFamily,
} = require("./weaponSnapshot");
const moduleAttributesModule = require("./moduleAttributes");

const ATTRIBUTE_DAMAGE_MULTIPLIER_BONUS_MAX_TIMESTAMP_RUNTIME =
  ATTRIBUTE_DAMAGE_MULTIPLIER_BONUS_MAX_TIMESTAMP;

function notifyAttributeChanges(session, changes = []) {
  if (
    !session ||
    typeof session.sendNotification !== "function" ||
    !Array.isArray(changes) ||
    changes.length === 0
  ) {
    return false;
  }

  queueDogmaEvent(session, "OnModuleAttributeChanges", [{
    type: "list",
    items: changes,
  }]);
  return true;
}

function isModuleTimingAttribute(attributeID) {
  const MODULE_ATTRIBUTE_DURATION = moduleAttributesModule.MODULE_ATTRIBUTE_DURATION;
  const MODULE_ATTRIBUTE_SPEED = moduleAttributesModule.MODULE_ATTRIBUTE_SPEED;
  const normalizedAttributeID = toInt(attributeID, 0);
  return (
    normalizedAttributeID === MODULE_ATTRIBUTE_DURATION ||
    normalizedAttributeID === MODULE_ATTRIBUTE_SPEED
  );
}

function isDogmaFileTimeAttribute(attributeID) {
  return toInt(attributeID, 0) === ATTRIBUTE_DAMAGE_MULTIPLIER_BONUS_MAX_TIMESTAMP_RUNTIME;
}

function marshalRuntimeAttributeChangeValue(session, attributeID, value) {
  const normalizedAttributeID = toInt(attributeID, 0);
  if (isModuleTimingAttribute(normalizedAttributeID)) {
    return marshalModuleDurationWireValue(value);
  }
  if (isDogmaFileTimeAttribute(normalizedAttributeID)) {
    const numericValue = Number(value);
    if (!Number.isFinite(numericValue) || numericValue <= 0) {
      return 0;
    }
    return resolveSessionNotificationFileTime(session, numericValue);
  }
  return Number.isFinite(Number(value))
    ? Number(value)
    : value;
}

function buildAttributeChange(
  session,
  itemID,
  attributeID,
  newValue,
  oldValue = null,
  when = null,
) {
  let resolvedWhen;
  if (when != null) {
    resolvedWhen = when;
  } else if (session && session._space && session._space.simFileTime) {
    // Use the live session clock when a scene is available instead of the
    // last cached _space.simFileTime snapshot so HUD timers do not drift when
    // notifications are emitted between Gameplay ticks.
    resolvedWhen = resolveSessionNotificationFileTime(session);
  } else {
    log.warn("buildAttributeChange: no sim time source, using wallclock fallback");
    resolvedWhen = currentFileTime();
  }
  const normalizedAttributeID = toInt(attributeID, 0);
  // TQ parity: singular inner tuple tag + trailing time.
  return [
    "OnModuleAttributeChange",
    toInt(session && session.characterID, 0),
    itemID,
    normalizedAttributeID,
    resolvedWhen,
    marshalRuntimeAttributeChangeValue(session, normalizedAttributeID, newValue),
    oldValue == null
      ? oldValue
      : marshalRuntimeAttributeChangeValue(session, normalizedAttributeID, oldValue),
    resolvedWhen,
  ];
}

function buildEntityDerivedAttributeSnapshot(entity) {
  const attributes =
    entity &&
    entity.passiveDerivedState &&
    entity.passiveDerivedState.attributes &&
    typeof entity.passiveDerivedState.attributes === "object"
      ? entity.passiveDerivedState.attributes
      : null;
  if (!attributes) {
    return null;
  }

  const snapshot = Object.fromEntries(
    Object.entries(attributes)
      .map(([attributeID, value]) => [toInt(attributeID, 0), Number(value)])
      .filter(
        ([attributeID, value]) =>
          attributeID > 0 && Number.isFinite(value),
      ),
  );

  // shieldCharge is a ChargedAttribute: when shield capacity changes, the
  // percentage stays constant while the absolute charge scales with the new
  // maximum. Include that absolute amount in the same derived-state snapshot
  // so capacity buffs publish both halves of the client Dogma transition.
  const shieldCapacity = Math.max(
    0,
    toFiniteNumber(entity && entity.shieldCapacity, 0),
  );
  const shieldChargeRatio = clamp(
    toFiniteNumber(
      entity && entity.conditionState && entity.conditionState.shieldCharge,
      0,
    ),
    0,
    1,
  );
  snapshot[ATTRIBUTE_SHIP_SHIELD_CHARGE] = roundNumber(
    shieldCapacity * shieldChargeRatio,
    6,
  );

  return snapshot;
}

function notifyShipDerivedAttributesToSession(
  session,
  entity,
  previousSnapshot,
  options = {},
) {
  if (
    !session ||
    !entity ||
    !previousSnapshot ||
    Object.keys(previousSnapshot).length === 0
  ) {
    return false;
  }

  const shipID = toInt(entity.itemID, 0);
  const currentSnapshot = buildEntityDerivedAttributeSnapshot(entity);
  if (shipID <= 0 || !currentSnapshot) {
    return false;
  }

  const excludedAttributeIDs = options.excludedAttributeIDs instanceof Set
    ? options.excludedAttributeIDs
    : new Set(
        Array.isArray(options.excludedAttributeIDs)
          ? options.excludedAttributeIDs.map((attributeID) => toInt(attributeID, 0))
          : [],
      );
  let timestamp;
  if (options.whenMs != null) {
    timestamp = resolveSessionNotificationFileTime(session, options.whenMs);
  } else if (session && session._space && session._space.simFileTime) {
    timestamp = resolveSessionNotificationFileTime(session);
  } else {
    log.warn("notifyShipDerivedAttributesToSession: no sim time source, using wallclock fallback");
    timestamp = currentFileTime();
  }

  const attributeChanges = [];
  const candidateAttributeIDs = new Set([
    ...Object.keys(previousSnapshot).map((attributeID) => toInt(attributeID, 0)),
    ...Object.keys(currentSnapshot).map((attributeID) => toInt(attributeID, 0)),
  ]);
  for (const attributeID of [...candidateAttributeIDs].sort((left, right) => left - right)) {
    if (attributeID <= 0 || excludedAttributeIDs.has(attributeID)) {
      continue;
    }

    const nextValue = Number(currentSnapshot[attributeID]);
    if (!Number.isFinite(nextValue)) {
      continue;
    }
    const hasPreviousValue = Object.prototype.hasOwnProperty.call(
      previousSnapshot,
      attributeID,
    );
    const previousValue = hasPreviousValue
      ? Number(previousSnapshot[attributeID])
      : null;
    if (
      hasPreviousValue &&
      Number.isFinite(previousValue) &&
      nextValue === previousValue
    ) {
      continue;
    }

    attributeChanges.push(
      buildAttributeChange(
        session,
        shipID,
        attributeID,
        nextValue,
        Number.isFinite(previousValue) ? previousValue : null,
        timestamp,
      ),
    );
  }

  return notifyAttributeChanges(session, attributeChanges);
}

function notifyCapacitorChangeToSession(
  session,
  entity,
  whenMs = null,
  previousChargeAmount = null,
) {
  if (
    !session ||
    typeof session.sendNotification !== "function" ||
    !entity
  ) {
    return;
  }

  const capacitorCapacity = Math.max(
    toFiniteNumber(entity.capacitorCapacity, 0),
    0,
  );
  const chargeAmount = Number(
    (capacitorCapacity * getEntityCapacitorRatio(entity)).toFixed(6),
  );
  const shipID = toInt(entity.itemID, 0);
  let when;
  if (whenMs != null) {
    when = resolveSessionNotificationFileTime(session, whenMs);
  } else if (session && session._space && session._space.simFileTime) {
    when = resolveSessionNotificationFileTime(session);
  } else {
    log.warn("notifyCapacitorChangeToSession: no sim time source, using wallclock fallback");
    when = currentFileTime();
  }
  const hasExplicitPreviousChargeAmount =
    previousChargeAmount !== null &&
    previousChargeAmount !== undefined &&
    Number.isFinite(Number(previousChargeAmount));
  const normalizedPreviousChargeAmount = hasExplicitPreviousChargeAmount
    ? Number(Number(previousChargeAmount).toFixed(6))
    : Number.isFinite(Number(entity._lastCapNotifiedAmount))
      ? Number(Number(entity._lastCapNotifiedAmount).toFixed(6))
      : chargeAmount;

  notifyAttributeChanges(session, [buildAttributeChange(
    session,
    shipID,
    ATTRIBUTE_CHARGE,
    chargeAmount,
    normalizedPreviousChargeAmount,
    when,
  )]);
  entity._lastCapNotifiedAmount = chargeAmount;
}

function notifyPropulsionDerivedAttributesToSession(
  session,
  entity,
  effectState,
  whenMs = null,
) {
  const MODULE_ATTRIBUTE_CAPACITOR_NEED = moduleAttributesModule.MODULE_ATTRIBUTE_CAPACITOR_NEED;
  const MODULE_ATTRIBUTE_DURATION = moduleAttributesModule.MODULE_ATTRIBUTE_DURATION;
  const MODULE_ATTRIBUTE_SPEED_FACTOR = moduleAttributesModule.MODULE_ATTRIBUTE_SPEED_FACTOR;
  if (
    !session ||
    !entity ||
    !effectState
  ) {
    return false;
  }

  const changes = [];
  let timestamp;
  if (whenMs != null) {
    timestamp = resolveSessionNotificationFileTime(session, whenMs);
  } else if (session && session._space && session._space.simFileTime) {
    timestamp = resolveSessionNotificationFileTime(session);
  } else {
    log.warn("notifyPropulsionDerivedAttributesToSession: no sim time source, using wallclock fallback");
    timestamp = currentFileTime();
  }
  const moduleID = toInt(effectState.moduleID, 0);
  const shipID = toInt(entity.itemID, 0);

  if (moduleID > 0) {
    changes.push(
      buildAttributeChange(
        session,
        moduleID,
        MODULE_ATTRIBUTE_SPEED_FACTOR,
        roundNumber(toFiniteNumber(effectState.speedFactor, 0), 6),
        null,
        timestamp,
      ),
      buildAttributeChange(
        session,
        moduleID,
        MODULE_ATTRIBUTE_CAPACITOR_NEED,
        roundNumber(toFiniteNumber(effectState.capNeed, 0), 6),
        null,
        timestamp,
      ),
      buildAttributeChange(
        session,
        moduleID,
        MODULE_ATTRIBUTE_DURATION,
        roundNumber(toFiniteNumber(effectState.durationMs, 0), 3),
        null,
        timestamp,
      ),
    );
  }

  if (shipID > 0) {
    changes.push(
      buildAttributeChange(
        session,
        shipID,
        ATTRIBUTE_MASS,
        roundNumber(toFiniteNumber(getShipDogmaMotionValue(entity, "mass"), 0), 6),
        null,
        timestamp,
      ),
      buildAttributeChange(
        session,
        shipID,
        ATTRIBUTE_MAX_VELOCITY,
        roundNumber(toFiniteNumber(getShipDogmaMotionValue(entity, "maxVelocity"), 0), 6),
        null,
        timestamp,
      ),
      buildAttributeChange(
        session,
        shipID,
        ATTRIBUTE_SIGNATURE_RADIUS,
        roundNumber(toFiniteNumber(entity.signatureRadius, 0), 6),
        null,
        timestamp,
      ),
    );
  }

  return notifyAttributeChanges(session, changes);
}

function notifyGenericDerivedAttributesToSession(
  session,
  effectState,
  whenMs = null,
) {
  const ATTRIBUTE_MAX_RANGE = moduleAttributesModule.ATTRIBUTE_MAX_RANGE;
  const MODULE_ATTRIBUTE_CAPACITOR_NEED = moduleAttributesModule.MODULE_ATTRIBUTE_CAPACITOR_NEED;
  const MODULE_ATTRIBUTE_DURATION = moduleAttributesModule.MODULE_ATTRIBUTE_DURATION;
  if (!session || !effectState) {
    return false;
  }

  const moduleID = toInt(effectState.moduleID, 0);
  const durationAttributeID = toInt(
    effectState.durationAttributeID,
    MODULE_ATTRIBUTE_DURATION,
  );
  if (moduleID <= 0) {
    return false;
  }

  let timestamp;
  if (whenMs != null) {
    timestamp = resolveSessionNotificationFileTime(session, whenMs);
  } else if (session && session._space && session._space.simFileTime) {
    timestamp = resolveSessionNotificationFileTime(session);
  } else {
    log.warn("notifyGenericDerivedAttributesToSession: no sim time source, using wallclock fallback");
    timestamp = currentFileTime();
  }

  const changes = [
    buildAttributeChange(
      session,
      moduleID,
      MODULE_ATTRIBUTE_CAPACITOR_NEED,
      roundNumber(toFiniteNumber(effectState.capNeed, 0), 6),
      null,
      timestamp,
    ),
  ];

  if (durationAttributeID > 0) {
    changes.push(
      buildAttributeChange(
        session,
        moduleID,
        durationAttributeID,
        roundNumber(toFiniteNumber(effectState.durationMs, 0), 3),
        null,
        timestamp,
      ),
    );
  }

  const maxRangeValue = toFiniteNumber(
    effectState.genericAttributeOverrides &&
      effectState.genericAttributeOverrides[ATTRIBUTE_MAX_RANGE],
    Number.NaN,
  );
  if (Number.isFinite(maxRangeValue)) {
    changes.push(
      buildAttributeChange(
        session,
        moduleID,
        ATTRIBUTE_MAX_RANGE,
        roundNumber(maxRangeValue, 6),
        null,
        timestamp,
      ),
    );
  }

  const currentSpoolBonus = toFiniteNumber(
    effectState.genericAttributeOverrides &&
      effectState.genericAttributeOverrides[ATTRIBUTE_DAMAGE_MULTIPLIER_BONUS_CURRENT],
    Number.NaN,
  );
  if (Number.isFinite(currentSpoolBonus)) {
    changes.push(
      buildAttributeChange(
        session,
        moduleID,
        ATTRIBUTE_DAMAGE_MULTIPLIER_BONUS_CURRENT,
        roundNumber(currentSpoolBonus, 6),
        null,
        timestamp,
      ),
    );
  }

  const maxTimestampMs = toFiniteNumber(
    effectState.genericAttributeOverrides &&
      effectState.genericAttributeOverrides[ATTRIBUTE_DAMAGE_MULTIPLIER_BONUS_MAX_TIMESTAMP_RUNTIME],
    Number.NaN,
  );
  if (Number.isFinite(maxTimestampMs)) {
    changes.push(
      buildAttributeChange(
        session,
        moduleID,
        ATTRIBUTE_DAMAGE_MULTIPLIER_BONUS_MAX_TIMESTAMP_RUNTIME,
        Math.max(0, roundNumber(maxTimestampMs, 3)),
        null,
        timestamp,
      ),
    );
  }

  return notifyAttributeChanges(session, changes);
}

function notifyFittedGenericModuleRangeAttributesToSession(
  session,
  entity,
  whenMs = null,
) {
  const ATTRIBUTE_MAX_RANGE = moduleAttributesModule.ATTRIBUTE_MAX_RANGE;
  if (!session || !entity || entity.kind !== "ship") {
    return false;
  }

  const shipItem = getEntityRuntimeShipItem(entity);
  if (!shipItem) {
    return false;
  }

  let timestamp;
  if (whenMs != null) {
    timestamp = resolveSessionNotificationFileTime(session, whenMs);
  } else if (session && session._space && session._space.simFileTime) {
    timestamp = resolveSessionNotificationFileTime(session);
  } else {
    log.warn("notifyFittedGenericModuleRangeAttributesToSession: no sim time source, using wallclock fallback");
    timestamp = currentFileTime();
  }

  const characterID = getShipEntityInventoryCharacterID(entity, toInt(session.characterID, 0));
  const fittedItems = getEntityRuntimeFittedItems(entity);
  const skillMap = getEntityRuntimeSkillMap(entity);
  const snapshotNowMs = whenMs == null
    ? toFiniteNumber(
        session && session._space && session._space.simTimeMs,
        Date.now(),
      )
    : toFiniteNumber(whenMs, Date.now());
  const changes = [];

  for (const moduleItem of fittedItems) {
    if (!moduleItem || !isModuleOnline(moduleItem)) {
      continue;
    }

    const chargeItem = getEntityRuntimeLoadedCharge(entity, moduleItem);
    const weaponFamily = resolveWeaponFamily(moduleItem, chargeItem);
    if (isSnapshotWeaponFamily(weaponFamily)) {
      continue;
    }

    const runtimeAttrs = getGenericModuleRuntimeAttributes(
      characterID,
      shipItem,
      moduleItem,
      chargeItem,
      null,
      {
        skillMap,
        fittedItems,
        activeModuleContexts: getEntityRuntimeActiveModuleContexts(entity, {
          excludeModuleID: toInt(moduleItem.itemID, 0),
          includeOverloadModuleID: toInt(moduleItem.itemID, 0),
        }),
        additionalLocationModifierSources: isStructureDogmaHost(shipItem)
          ? []
          : collectEntityWormholeLocationModifierSources(entity),
        additionalDirectModifierEntries: isMiningModuleItem(moduleItem)
          ? resolveModuleSnapshotDirectModifierEntries(entity, moduleItem, {
              nowMs: snapshotNowMs,
              collectModifierEntriesForItem:
                commandBurstRuntime.collectModifierEntriesForItem,
            })
          : [],
      },
    );
    const maxRangeValue = toFiniteNumber(
      runtimeAttrs &&
        runtimeAttrs.attributeOverrides &&
        runtimeAttrs.attributeOverrides[ATTRIBUTE_MAX_RANGE],
      Number.NaN,
    );
    if (!Number.isFinite(maxRangeValue)) {
      continue;
    }

    changes.push(buildAttributeChange(
      session,
      toInt(moduleItem.itemID, 0),
      ATTRIBUTE_MAX_RANGE,
      roundNumber(maxRangeValue, 6),
      null,
      timestamp,
    ));
  }

  return notifyAttributeChanges(session, changes);
}

// The modifier funcs that project a running module's Dogma onto the OTHER items
// on the same ship: the Tracking Computer's gunnery triple, Bastion's large
// turret rows, a Missile Guidance Computer's launcher rows, a Sensor Booster's
// scan rows. Deliberately the same four names liveFittingState's location
// collector accepts, and deliberately without ItemModifier — those rows rewrite
// the hull (or the module itself) and already reach the client through
// notifyShipDerivedAttributesToSession / notifyGenericDerivedAttributesToSession.
const PROJECTED_FITTED_MODULE_MODIFIER_FUNCS = new Set([
  "LocationRequiredSkillModifier",
  "LocationGroupModifier",
  "LocationModifier",
  "OwnerRequiredSkillModifier",
]);

function collectProjectedFittedModuleAttributeIDs(effectRecord) {
  const attributeIDs = new Set();
  if (!effectRecord || !Array.isArray(effectRecord.modifierInfo)) {
    return attributeIDs;
  }

  for (const modifierInfo of effectRecord.modifierInfo) {
    if (
      !modifierInfo ||
      !PROJECTED_FITTED_MODULE_MODIFIER_FUNCS.has(String(modifierInfo.func || ""))
    ) {
      continue;
    }
    const attributeID = toInt(modifierInfo.modifiedAttributeID, 0);
    if (attributeID > 0) {
      attributeIDs.add(attributeID);
    }
  }
  return attributeIDs;
}

// godma fills attributesByItemAttribute — the map the in-space module button
// tooltip reads — only from OnModuleAttributeChange pushes, so an attribute the
// server never republishes stays at whatever the fitting screen last said. That
// left a pilot reading idle optimal/falloff/tracking off his guns for as long as
// a Tracking Computer or a Bastion was running. Publish the current value of
// exactly the attributes the effect's own modifiers target, on every fitted
// module they can reach, whenever the effect starts or stops.
//
// Unlike notifyFittedGenericModuleRangeAttributesToSession this does not skip
// the snapshot weapon families: turrets and launchers are what these boosters
// exist to modify.
function notifyFittedGenericModuleModifiedAttributesToSession(
  session,
  entity,
  effectRecord,
  options = {},
) {
  if (
    !session ||
    typeof session.sendNotification !== "function" ||
    !entity ||
    entity.kind !== "ship"
  ) {
    return false;
  }

  // The gate that keeps this off the hot path: a weapon's own firing effect
  // carries no modifierInfo at all, so an activating turret pays for one empty
  // Set and never reaches the recompute below.
  const targetAttributeIDs = collectProjectedFittedModuleAttributeIDs(effectRecord);
  if (targetAttributeIDs.size === 0) {
    return false;
  }

  const shipItem = getEntityRuntimeShipItem(entity);
  if (!shipItem) {
    return false;
  }

  const whenMs = options.whenMs == null ? null : options.whenMs;
  let timestamp;
  if (whenMs != null) {
    timestamp = resolveSessionNotificationFileTime(session, whenMs);
  } else if (session && session._space && session._space.simFileTime) {
    timestamp = resolveSessionNotificationFileTime(session);
  } else {
    log.warn("notifyFittedGenericModuleModifiedAttributesToSession: no sim time source, using wallclock fallback");
    timestamp = currentFileTime();
  }

  const sourceModuleID = toInt(options.sourceModuleID, 0);
  const characterID = getShipEntityInventoryCharacterID(entity, toInt(session.characterID, 0));
  const fittedItems = getEntityRuntimeFittedItems(entity);
  const skillMap = getEntityRuntimeSkillMap(entity);
  const snapshotNowMs = whenMs == null
    ? toFiniteNumber(
        session && session._space && session._space.simTimeMs,
        Date.now(),
      )
    : toFiniteNumber(whenMs, Date.now());
  const changes = [];

  for (const moduleItem of fittedItems) {
    const moduleID = toInt(moduleItem && moduleItem.itemID, 0);
    if (
      moduleID <= 0 ||
      moduleID === sourceModuleID ||
      !isModuleOnline(moduleItem)
    ) {
      continue;
    }

    const chargeItem = getEntityRuntimeLoadedCharge(entity, moduleItem);
    // Resolved exactly the way captureFittedGenericModuleAttributeSnapshots
    // resolves it, so the values published here and the values the fit/unfit
    // diff lane publishes cannot drift apart.
    const runtimeAttrs = getGenericModuleRuntimeAttributes(
      characterID,
      shipItem,
      moduleItem,
      chargeItem,
      null,
      {
        skillMap,
        fittedItems,
        activeModuleContexts: getEntityRuntimeActiveModuleContexts(entity, {
          excludeModuleID: moduleID,
          includeOverloadModuleID: moduleID,
        }),
        additionalLocationModifierSources: isStructureDogmaHost(shipItem)
          ? []
          : collectEntityWormholeLocationModifierSources(entity),
        additionalDirectModifierEntries:
          resolveModuleSnapshotDirectModifierEntries(entity, moduleItem, {
            nowMs: snapshotNowMs,
            collectModifierEntriesForItem:
              commandBurstRuntime.collectModifierEntriesForItem,
          }),
      },
    );
    const attributeOverrides =
      runtimeAttrs &&
      runtimeAttrs.attributeOverrides &&
      typeof runtimeAttrs.attributeOverrides === "object"
        ? runtimeAttrs.attributeOverrides
        : null;
    if (!attributeOverrides) {
      continue;
    }

    for (const attributeID of targetAttributeIDs) {
      // A type only lists the attributes it declares, so an absent one means
      // the effect's row had nothing on this module to modify — a launcher is
      // not moved by a gunnery row, and publishing a value for it would invent
      // an attribute the client never had.
      const value = toFiniteNumber(attributeOverrides[attributeID], Number.NaN);
      if (!Number.isFinite(value)) {
        continue;
      }
      changes.push(buildAttributeChange(
        session,
        moduleID,
        attributeID,
        roundNumber(value, 6),
        null,
        timestamp,
      ));
    }
  }

  return notifyAttributeChanges(session, changes);
}

function captureFittedGenericModuleAttributeSnapshots(
  entity,
  options = {},
) {
  const snapshots = new Map();
  if (!entity || entity.kind !== "ship") {
    return snapshots;
  }

  const shipItem = getEntityRuntimeShipItem(entity);
  if (!shipItem) {
    return snapshots;
  }

  const session = options.session || entity.session || null;
  const moduleFilter = typeof options.moduleFilter === "function"
    ? options.moduleFilter
    : null;
  const includeOfflineModules = options.includeOfflineModules === true;
  const characterID = getShipEntityInventoryCharacterID(
    entity,
    toInt(session && session.characterID, 0),
  );
  const fittedItems = getEntityRuntimeFittedItems(entity);
  const skillMap = getEntityRuntimeSkillMap(entity);
  const snapshotNowMs = toFiniteNumber(
    options.nowMs,
    session && session._space
      ? toFiniteNumber(session._space.simTimeMs, Date.now())
      : Date.now(),
  );

  for (const moduleItem of fittedItems) {
    const moduleID = toInt(moduleItem && moduleItem.itemID, 0);
    if (
      moduleID <= 0 ||
      (!includeOfflineModules && !isModuleOnline(moduleItem)) ||
      (moduleFilter && moduleFilter(moduleItem, entity) !== true)
    ) {
      continue;
    }

    const chargeItem = getEntityRuntimeLoadedCharge(entity, moduleItem);
    const runtimeAttrs = getGenericModuleRuntimeAttributes(
      characterID,
      shipItem,
      moduleItem,
      chargeItem,
      null,
      {
        skillMap,
        fittedItems,
        activeModuleContexts: getEntityRuntimeActiveModuleContexts(entity, {
          excludeModuleID: moduleID,
          includeOverloadModuleID: moduleID,
        }),
        additionalLocationModifierSources: isStructureDogmaHost(shipItem)
          ? []
          : collectEntityWormholeLocationModifierSources(entity),
        additionalDirectModifierEntries:
          resolveModuleSnapshotDirectModifierEntries(entity, moduleItem, {
            nowMs: snapshotNowMs,
            collectModifierEntriesForItem:
              commandBurstRuntime.collectModifierEntriesForItem,
          }),
      },
    );
    const effectiveAttributes = new Map();
    for (const [attributeID, rawValue] of Object.entries(
      runtimeAttrs && runtimeAttrs.attributeOverrides
        ? runtimeAttrs.attributeOverrides
        : {},
    )) {
      const numericAttributeID = toInt(attributeID, 0);
      const numericValue = Number(rawValue);
      if (numericAttributeID > 0 && Number.isFinite(numericValue)) {
        effectiveAttributes.set(numericAttributeID, numericValue);
      }
    }
    if (effectiveAttributes.size > 0) {
      snapshots.set(moduleID, effectiveAttributes);
    }
  }

  return snapshots;
}

function buildFittedGenericModuleAttributeDiffChanges(
  session,
  beforeSnapshots,
  afterSnapshots,
  whenMs = null,
) {
  const timestamp = whenMs == null
    ? resolveSessionNotificationFileTime(session)
    : resolveSessionNotificationFileTime(session, whenMs);
  return collectNumericModuleAttributeDiffs(beforeSnapshots, afterSnapshots)
    .map((diff) => buildAttributeChange(
      session,
      diff.moduleID,
      diff.attributeID,
      roundNumber(diff.newValue, 6),
      roundNumber(diff.oldValue, 6),
      timestamp,
    ));
}

function notifyFittedGenericModuleAttributeDiffToSession(
  session,
  beforeSnapshots,
  afterSnapshots,
  whenMs = null,
) {
  const changes = buildFittedGenericModuleAttributeDiffChanges(
    session,
    beforeSnapshots,
    afterSnapshots,
    whenMs,
  );
  return {
    sent: notifyAttributeChanges(session, changes),
    changeCount: changes.length,
    changes,
  };
}

function notifyTargetingDerivedAttributesToSession(
  session,
  entity,
  previousSnapshot,
  whenMs = null,
) {
  if (!session || !entity || !previousSnapshot) {
    return false;
  }

  let timestamp;
  if (whenMs != null) {
    timestamp = resolveSessionNotificationFileTime(session, whenMs);
  } else if (session && session._space && session._space.simFileTime) {
    timestamp = resolveSessionNotificationFileTime(session);
  } else {
    log.warn("notifyTargetingDerivedAttributesToSession: no sim time source, using wallclock fallback");
    timestamp = currentFileTime();
  }

  const shipID = toInt(entity.itemID, 0);
  if (shipID <= 0) {
    return false;
  }

  const currentSnapshot = buildEntityTargetingAttributeSnapshot(entity);
  const attributeChanges = [];
  const candidates = [
    [ATTRIBUTE_MAX_TARGET_RANGE, currentSnapshot.maxTargetRange, previousSnapshot.maxTargetRange],
    [ATTRIBUTE_MAX_LOCKED_TARGETS, currentSnapshot.maxLockedTargets, previousSnapshot.maxLockedTargets],
    [ATTRIBUTE_SIGNATURE_RADIUS, currentSnapshot.signatureRadius, previousSnapshot.signatureRadius],
    [ATTRIBUTE_CLOAKING_TARGETING_DELAY, currentSnapshot.cloakingTargetingDelay, previousSnapshot.cloakingTargetingDelay],
    [ATTRIBUTE_SCAN_RESOLUTION, currentSnapshot.scanResolution, previousSnapshot.scanResolution],
  ];

  for (const [attributeID, nextValue, previousValue] of candidates) {
    if (Number(nextValue) === Number(previousValue)) {
      continue;
    }

    attributeChanges.push(
      buildAttributeChange(
        session,
        shipID,
        attributeID,
        nextValue,
        previousValue,
        timestamp,
      ),
    );
  }

  return notifyAttributeChanges(session, attributeChanges);
}

Object.assign(module.exports, {
  ATTRIBUTE_DAMAGE_MULTIPLIER_BONUS_MAX_TIMESTAMP_RUNTIME,
  PROJECTED_FITTED_MODULE_MODIFIER_FUNCS,
});
