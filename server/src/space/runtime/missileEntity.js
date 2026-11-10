"use strict";

module.exports = {
  buildMissileDynamicEntity,
  buildMissileLaunchModuleList,
  resolveMissileBallRadius,
  resolveMissileFlightDynamics,
  resolveMissileLaunchPosition,
  resolveMissileLauncherPresentationLayout,
  applyMissileHit,
  removeMissileWithoutHit,
};

const runtimeEntryDirname = require("path").resolve(__dirname, "..");
const path = require("path");
const log = require("../../utils/logger");

const {
  recordSuppressorMissileImpactBlocked,
  recordSuppressorMissileNormalImpact,
} = require("../../abyssal").engineSupport.suppressorDiagnostics;
const {
  resolveItemByTypeID,
} = require(path.join(runtimeEntryDirname, "../services/inventory/itemTypeRegistry"));
const {
  entityIDsEqual,
  getEntityMapKey,
  normalizeEntityID,
  normalizeEntityIDSet,
  normalizeNonNegativeInt64,
  normalizePersistentEntityID,
  toJSONSafeEntityID,
} = require(path.join(runtimeEntryDirname, "./destiny/identity/entityID.js"));
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
  applyDamageToEntity,
  applyResolvedDamageAmountToEntity,
  buildLiveDamageState,
  hasDamageableHealth,
  getEntityCurrentHealthLayers,
  getEntityMaxHealthLayers,
  sumDamageVector,
} = require(path.join(runtimeEntryDirname, "./combat/damage"));
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
  estimateMissileEffectiveRange,
  resolveMissileClientVisualProfile,
  estimateMissileFlightBudgetMs,
  resolveMissileAppliedDamage,
} = require(path.join(runtimeEntryDirname, "./combat/missiles/missileSolver"));
const {
  noteDamage: noteKillmailDamage,
  resolveHighestDamageAttacker,
  enqueueKillmailFromDestruction: recordKillmailFromDestruction,
  recoverPendingKillmailWork,
} = require(path.join(runtimeEntryDirname, "./combat/killmailTracker"));
const {
  getAppliedDamageAmount,
  notifyWeaponDamageMessages,
} = require("./combatDamageMessages");
const {
  getEntityRuntimeFittedItems,
  getEntityRuntimeLoadedCharge,
  getEntityRuntimeModuleItem,
} = require("./entityDogmaView");
const {
  applyRuntimeEntityScopeMetadata,
} = require("./entityScopeTags");
const {
  buildMissileLaunchPresentationSnapshot,
} = require("./firstSightPresentation");
const {
  clamp,
  roundNumber,
  toFiniteNumber,
  toInt,
} = require("../../common/numbers");
const {
  logMissileDebug,
  normalizeTraceValue,
  summarizeMissileEntity,
  summarizeRuntimeEntityForMissileDebug,
  summarizeVector,
} = require("./runtimeDebugInstrumentation");
const {
  allocateRuntimeEntityID,
} = require("./runtimeEntityIdentity");
const {
  deriveAgilitySeconds,
  deriveOfficialTauSeconds,
} = require("./shipMotionKinematics");
const {
  applyWeaponDamageToTarget,
} = require("./targetDamageApplication");
const {
  DEFAULT_RIGHT,
  DEFAULT_UP,
  addVectors,
  buildPerpendicular,
  cloneVector,
  crossProduct,
  normalizeVector,
  scaleVector,
  subtractVectors,
} = require("../../common/vector");
const {
  isDefenderMissileTargetForSource,
} = require("./weaponSnapshot");

// How many Destiny ticks a missile's Ball outlives its hit: retail's
// RemoveBall(id, delay), the Ball moribund, stopped and non-massive in the
// meantime, so its RemoveBalls reaches Observers at N + 1 + delay for a hit
// decided in Evolve N, after each client's own collision has drawn the
// explosion (the removal's DoFinalCleanup clears the missile model, collided
// or not). A client shows a hit decided at sweep fraction s reaching its
// target s seconds into the tick after its Evolve N, so its warhead has
// delay + 1 - s seconds, less its own lag: a far-range hit (s about 0.94)
// had only about 1.06 s with a delay of 1, and the shooter's client lost
// about 1 explosion in 13. The value was found in play (1 at first, then
// 2): no published source gives retail's.
const MISSILE_HIT_REMOVAL_DELAY_TICKS = 2;

// The missile's follow range: minus both radii, so EvolveMissile's standoff
// (follow range plus both radii) is zero and it steers at the led point.
function resolveMissileFollowRange(missileRadius, targetRadius) {
  return -(
    Math.max(0, toFiniteNumber(missileRadius, 0)) +
    Math.max(0, toFiniteNumber(targetRadius, 0))
  );
}

let nextMissileLaunchTraceID = 1;

// getEntitySurfaceDistance is defined at ~line 5283 (uses getEntityTargetingRadius)

function buildMissileLaunchModuleList(moduleItem, options = {}) {
  if (Array.isArray(options.launchModules) && options.launchModules.length > 0) {
    return options.launchModules
      .map((value) => toInt(value, 0))
      .filter((value) => value >= 0);
  }

  const moduleID = toInt(moduleItem && moduleItem.itemID, 0);
  return moduleID > 0 ? [moduleID] : [0];
}

function resolveMissileLauncherPresentationLayout(entity, moduleItem = null) {
  const normalizedModuleID = toInt(moduleItem && moduleItem.itemID, 0);
  const normalizedFlagID = toInt(moduleItem && moduleItem.flagID, 0);
  const orderedLaunchers = getEntityRuntimeFittedItems(entity)
    .filter((candidate) => (
      resolveWeaponFamily(
        candidate,
        getEntityRuntimeLoadedCharge(entity, candidate),
      ) === "missileLauncher"
    ))
    .sort((left, right) => (
      toInt(left && left.flagID, 0) - toInt(right && right.flagID, 0) ||
      toInt(left && left.itemID, 0) - toInt(right && right.itemID, 0)
    ));

  let launcherIndex = orderedLaunchers.findIndex((candidate) => (
    toInt(candidate && candidate.itemID, 0) === normalizedModuleID
  ));
  if (launcherIndex < 0 && normalizedFlagID > 0) {
    launcherIndex = orderedLaunchers.findIndex((candidate) => (
      toInt(candidate && candidate.flagID, 0) === normalizedFlagID
    ));
  }
  if (launcherIndex < 0) {
    launcherIndex = Math.max(0, normalizedFlagID > 0 ? normalizedFlagID - 27 : 0);
  }

  return {
    index: launcherIndex,
    count: Math.max(orderedLaunchers.length, launcherIndex + 1, 1),
  };
}

function resolveMissileLaunchPosition(
  attackerEntity,
  targetEntity,
  moduleItem = null,
) {
  const shipPosition = cloneVector(attackerEntity && attackerEntity.position);
  if (!attackerEntity) {
    return shipPosition;
  }

  const targetDirection = normalizeVector(
    subtractVectors(targetEntity && targetEntity.position, shipPosition),
    DEFAULT_RIGHT,
  );
  // Keep the synthetic muzzle offset aligned to the actual firing solution.
  // Using the hull's travel heading here leaks sideways ship motion into the
  // live missile ball and produces the lateral launch wobble the client does
  // not show.
  const shipForward = normalizeVector(
    targetDirection,
    targetDirection,
  );
  const shipRight = buildPerpendicular(shipForward);
  const shipUp = normalizeVector(
    crossProduct(shipRight, shipForward),
    DEFAULT_UP,
  );
  const radius = Math.max(1, toFiniteNumber(attackerEntity && attackerEntity.radius, 0));
  const { index, count } = resolveMissileLauncherPresentationLayout(
    attackerEntity,
    moduleItem,
  );
  const centeredIndex = index - ((count - 1) / 2);
  const forwardOffsetMeters = clamp(radius * 0.45, 12, 90);
  const lateralStepMeters = clamp(radius * 0.28, 10, 55);
  const verticalStepMeters = clamp(radius * 0.08, 0, 16);
  const rowIndex = Math.floor(index / 2);
  const verticalOffsetMeters =
    rowIndex <= 0
      ? 0
      : ((rowIndex % 2 === 0 ? 1 : -1) * verticalStepMeters * rowIndex);

  return addVectors(
    shipPosition,
    addVectors(
      scaleVector(shipForward, forwardOffsetMeters),
      addVectors(
        scaleVector(shipRight, centeredIndex * lateralStepMeters),
        scaleVector(shipUp, verticalOffsetMeters),
      ),
    ),
  );
}

function resolveMissileBallRadius(chargeTypeID, chargeItem = null) {
  const chargeType =
    chargeTypeID > 0
      ? resolveItemByTypeID(chargeTypeID)
      : null;
  const authoredRadius = Math.max(
    0,
    toFiniteNumber(
      chargeItem && chargeItem.radius,
      toFiniteNumber(chargeType && chargeType.radius, 0),
    ),
  );
  return authoredRadius > 0 ? authoredRadius : 1;
}

function resolveMissileFlightDynamics(chargeTypeID, chargeItem = null) {
  const chargeType =
    chargeTypeID > 0
      ? resolveItemByTypeID(chargeTypeID)
      : null;
  const authoredMass = Math.max(
    0,
    toFiniteNumber(
      chargeItem && chargeItem.mass,
      toFiniteNumber(chargeType && chargeType.mass, 0),
    ),
  );
  const missileInertia = Math.max(
    0,
    toFiniteNumber(
      getTypeAttributeValue(chargeTypeID, "agility"),
      0,
    ),
  );
  const resolvedMass = authoredMass > 0 ? authoredMass : 1;
  const resolvedInertia = missileInertia > 0 ? missileInertia : 0.1;
  const officialTauSeconds = deriveOfficialTauSeconds(
    resolvedMass,
    resolvedInertia,
  );
  return {
    mass: resolvedMass,
    inertia: resolvedInertia,
    agilitySeconds:
      officialTauSeconds > 0
        ? officialTauSeconds
        : deriveAgilitySeconds(0, 0, resolvedMass, resolvedInertia),
  };
}

function buildMissileDynamicEntity(
  attackerEntity,
  targetEntity,
  weaponSnapshot,
  launchTimeMs,
  options = {},
) {
  if (!attackerEntity || !targetEntity || !weaponSnapshot) {
    return null;
  }

  const launchPosition = resolveMissileLaunchPosition(
    attackerEntity,
    targetEntity,
    options.moduleItem,
  );
  const direction = normalizeVector(
    subtractVectors(targetEntity.position, launchPosition),
    attackerEntity.direction,
  );
  const maxVelocity = Math.max(
    0,
    toFiniteNumber(weaponSnapshot.maxVelocity, 0),
  );
  const chargeTypeID = toInt(weaponSnapshot.chargeTypeID, 0);
  const missileRadius = resolveMissileBallRadius(
    chargeTypeID,
    options.chargeItem,
  );
  const launchAtMs = Math.max(0, toFiniteNumber(launchTimeMs, 0));
  // CCP's `spaceObject.Missile._GetTimeToTarget` uses the live surface ETA to
  // decide whether the missile visually spreads (`doSpread`) and a separate
  // averaged surface/center time for the Trinity missile model.
  const visualProfile = resolveMissileClientVisualProfile(
    launchPosition,
    targetEntity.position,
    Math.max(0, toFiniteNumber(targetEntity.radius, 0)),
    maxVelocity,
  );
  const missileDynamics = resolveMissileFlightDynamics(
    chargeTypeID,
    options.chargeItem,
  );
  // A missile is a Ball in MISSILE mode: GotoThrust at its speed fraction,
  // so it flies at its max speed from its first Evolve.
  const initialSpeedFraction = maxVelocity > 0 ? 1 : 0;
  const initialVelocity =
    visualProfile.doSpread
      ? { x: 0, y: 0, z: 0 }
      : scaleVector(direction, maxVelocity);

  const missileEntity = {
    debugLaunchTraceID: nextMissileLaunchTraceID++,
    itemID: allocateRuntimeEntityID(),
    kind: "missile",
    systemID: toInt(attackerEntity.systemID, 0),
    ownerID: toInt(attackerEntity.ownerID, 0),
    corporationID: toInt(attackerEntity.corporationID, 0),
    allianceID: toInt(attackerEntity.allianceID, 0),
    warFactionID: toInt(attackerEntity.warFactionID, 0),
    typeID: chargeTypeID,
    groupID: toInt(options.chargeItem && options.chargeItem.groupID, 0),
    categoryID: toInt(options.chargeItem && options.chargeItem.categoryID, 8),
    itemName: String(
      options.chargeItem && options.chargeItem.itemName ||
      "Missile",
    ),
    radius: missileRadius,
    position: launchPosition,
    velocity: initialVelocity,
    direction,
    targetPoint: cloneVector(targetEntity.position),
    mode: "MISSILE",
    // Retail TQ presents live missile balls as FREE|MASSIVE and repeats the
    // massive state in LaunchMissile's fifth field. The native client consumes
    // this missile-specific state; Eve.js still adds no general server collision
    // solver, and DEC-001 continues to exclude ship collision response.
    isMassive: true,
    massive: true,
    targetEntityID: toInt(targetEntity.itemID, 0),
    followRange: resolveMissileFollowRange(
      missileRadius,
      toFiniteNumber(targetEntity.radius, 0),
    ),
    maxVelocity,
    speedFraction: initialSpeedFraction,
    mass: missileDynamics.mass,
    inertia: missileDynamics.inertia,
    agilitySeconds: missileDynamics.agilitySeconds,
    launchedAtMs: launchAtMs,
    // It flies no Evolve whose end passes it.
    expiresAtMs: Math.max(0, launchAtMs + estimateMissileFlightBudgetMs(
      weaponSnapshot,
      toFiniteNumber(attackerEntity.radius, 0),
    )),
    clientDoSpread: visualProfile.doSpread,
    sourceShipID: toInt(attackerEntity.itemID, 0),
    fireShowID: attackerEntity.fireShowID || null,
    launchModules: buildMissileLaunchModuleList(
      options.moduleItem,
      options,
    ),
    missileSnapshot: weaponSnapshot,
    sourceModuleTypeID: toInt(options.moduleItem && options.moduleItem.typeID, 0),
    sourceModuleID: toInt(options.moduleItem && options.moduleItem.itemID, 0),
  };
  applyRuntimeEntityScopeMetadata(missileEntity, attackerEntity);
  if (
    normalizePersistentEntityID(missileEntity.dungeonSiteInstanceID) === null
  ) {
    const attackerCurrentDungeonInstanceID = normalizePersistentEntityID(
      attackerEntity.dungeonCurrentInstanceID,
    );
    if (attackerCurrentDungeonInstanceID !== null) {
      missileEntity.dungeonSiteInstanceID = attackerCurrentDungeonInstanceID;
      missileEntity.dungeonMaterializedSiteContent = true;
    }
  }
  missileEntity.launchPresentationSnapshot =
    buildMissileLaunchPresentationSnapshot(missileEntity);
  // A breacher pod is one only once breacherPods captures it;
  // one it refuses is not launched.
  if (
    weaponSnapshot.family === "breacherPodLauncher" &&
    !require("../combat/breacherPods").captureProjectile(
      missileEntity,
      attackerEntity,
      targetEntity,
      weaponSnapshot,
    )
  ) {
    return null;
  }
  return missileEntity;
}

function resolveMissileModuleItem(attackerEntity, missileEntity) {
  return attackerEntity && toInt(missileEntity.sourceModuleID, 0) > 0
    ? getEntityRuntimeModuleItem(attackerEntity, toInt(missileEntity.sourceModuleID, 0))
    : {
        itemID: toInt(missileEntity.sourceModuleID, 0),
        typeID: toInt(missileEntity.sourceModuleTypeID, toInt(missileEntity.typeID, 0)),
      };
}

// The interim missile hit, until Collision
// handling in Evolve: Evolve's pass 3 found the missile's segment between its
// two committed slots meets its target's, and this applies the hit at once,
// at retail's dispatch site. The damage, its killmail notes and its damage
// messages happen here; the missile is removed with TQ's
// TerminalPlayDestructionEffect(missile, None) (missileHitExplodes), moribund for
// MISSILE_HIT_REMOVAL_DELAY_TICKS, so its removal reaches Observers at
// N + 1 + that delay; a destroyed target is removed with its
// own effect, moribund until the next sweep, so it reaches them at N + 1.
// After the guard, the cases go in order: a
// breacher pod registers its impact in place of damage; a defender meeting
// another source's missile-kind Ball (a bomb included) removes it at once,
// with no damage, and is kept for the delay like any hit; a festival
// firework does no damage; any other missile does damage.
// Whether a hit missile's removal carries its explosion: TQ sends
// TerminalPlayDestructionEffect(missile, None), the client's default
// explosion, with the RemoveBall. Main left it off a doSpread missile, whose
// warhead visual an explosion clears before it reaches the target (the
// client's Missile.Release), and so does this.
function missileHitExplodes(missileEntity) {
  return Boolean(missileEntity) && missileEntity.clientDoSpread !== true;
}

function applyMissileHit(scene, missileEntity, targetEntity, options = {}) {
  const nowMs = toFiniteNumber(options.nowMs, scene && scene.getCurrentSimTimeMs());
  if (!scene || !missileEntity || !targetEntity) {
    return { impact: false };
  }
  if (
    missileEntity.evejsAbyssalSuppressorDestroyed === true ||
    missileEntity.destroyed === true ||
    missileEntity.removed === true
  ) {
    recordSuppressorMissileImpactBlocked(missileEntity);
    return { impact: false };
  }
  if (missileEntity.breacherPodProjectile === true) {
    return applyBreacherPodHit(scene, missileEntity, targetEntity, nowMs, options);
  }
  const attackerEntity = scene.getEntityByID(missileEntity.sourceShipID);
  const moduleItem = resolveMissileModuleItem(attackerEntity, missileEntity);
  const defenderIntercept =
    isDefenderMissileWeaponSnapshot(missileEntity.missileSnapshot) &&
    isDefenderMissileTargetForSource(missileEntity.sourceShipID, targetEntity);
  recordSuppressorMissileNormalImpact(missileEntity);
  if (defenderIntercept) {
    logMissileDebug("missile.lifecycle", () => ({
      sceneSystemID: scene.systemID,
      outcome: "defender-intercept",
      missile: summarizeMissileEntity(missileEntity),
      target: summarizeMissileEntity(targetEntity),
      sweep: normalizeTraceValue(options.sweep || null),
    }));
    scene.unregisterDynamicEntity(targetEntity, {
      nowMs,
    });
    scene.unregisterDynamicEntity(missileEntity, {
      nowMs,
      delay: MISSILE_HIT_REMOVAL_DELAY_TICKS,
      missileHitExplosion: missileHitExplodes(missileEntity),
    });
    return { impact: true, intercept: true };
  }
  // A festival launcher's firework is cosmetic: it enters no damage, repair,
  // killmail or settlement owner, even on a target already at zero health.
  if (
    missileEntity.missileSnapshot &&
    missileEntity.missileSnapshot.family === "festivalLauncher"
  ) {
    logMissileDebug("missile.lifecycle", () => ({
      sceneSystemID: scene.systemID,
      outcome: "firework",
      missile: summarizeMissileEntity(missileEntity),
      target: summarizeRuntimeEntityForMissileDebug(targetEntity),
      sweep: normalizeTraceValue(options.sweep || null),
    }));
    scene.unregisterDynamicEntity(missileEntity, {
      nowMs,
      delay: MISSILE_HIT_REMOVAL_DELAY_TICKS,
      missileHitExplosion: missileHitExplodes(missileEntity),
    });
    return { impact: true, damageResult: null, destroyResult: null };
  }
  if (!hasDamageableHealth(targetEntity)) {
    scene.unregisterDynamicEntity(missileEntity, {
      nowMs,
      delay: MISSILE_HIT_REMOVAL_DELAY_TICKS,
      missileHitExplosion: missileHitExplodes(missileEntity),
    });
    return { impact: true, damageResult: null, destroyResult: null };
  }
  const impactResult = resolveMissileAppliedDamage(
    missileEntity.missileSnapshot,
    targetEntity,
  );
  const weaponDamageResult = applyWeaponDamageToTarget(
    scene,
    attackerEntity,
    targetEntity,
    impactResult.appliedDamage,
    nowMs,
  );
  const appliedDamageAmount = getAppliedDamageAmount(weaponDamageResult.damageResult);
  if (appliedDamageAmount > 0) {
    noteKillmailDamage(attackerEntity, targetEntity, appliedDamageAmount, {
      whenMs: nowMs,
      weaponSnapshot: missileEntity.missileSnapshot,
      moduleItem,
    });
  }
  if (weaponDamageResult.destroyResult && weaponDamageResult.destroyResult.success) {
    recordKillmailFromDestruction(targetEntity, weaponDamageResult.destroyResult, {
      attackerEntity,
      victimSession: weaponDamageResult.victimSession,
      whenMs: nowMs,
      weaponSnapshot: missileEntity.missileSnapshot,
      moduleItem,
    });
  }
  notifyWeaponDamageMessages(
    attackerEntity,
    targetEntity,
    moduleItem,
    impactResult.appliedDamage,
    appliedDamageAmount,
    sumDamageVector(impactResult.appliedDamage) > 0 ? 3 : 0,
    {
      isBanked:
        missileEntity.missileSnapshot &&
        missileEntity.missileSnapshot.isBanked === true,
    },
  );
  logMissileDebug("missile.lifecycle", () => ({
    sceneSystemID: scene.systemID,
    outcome: "impact",
    missile: summarizeMissileEntity(missileEntity),
    target: summarizeRuntimeEntityForMissileDebug(targetEntity),
    attacker: summarizeRuntimeEntityForMissileDebug(attackerEntity),
    sweep: normalizeTraceValue(options.sweep || null),
    appliedDamage: normalizeTraceValue(impactResult.appliedDamage),
    appliedDamageAmount: roundNumber(appliedDamageAmount, 6),
  }));
  scene.unregisterDynamicEntity(missileEntity, {
    nowMs,
    delay: MISSILE_HIT_REMOVAL_DELAY_TICKS,
    missileHitExplosion: missileHitExplodes(missileEntity),
  });
  return {
    impact: true,
    damageResult: weaponDamageResult.damageResult,
    destroyResult: weaponDamageResult.destroyResult,
  };
}

// A breacher pod's hit: its damage over time, which
// breacherPods registers, replaces damage, whatever the target. The pod is
// removed as any hit is, and not persisted. A `retry` (the damage over time
// failed to persist) keeps the paid impact in breacherPods, which retries it
// each scene tick; the pod still goes.
function applyBreacherPodHit(scene, pod, targetEntity, nowMs, options) {
  const registration = require("../combat/breacherPods").registerImpact(
    scene,
    pod,
    targetEntity,
    nowMs,
  );
  if (registration && registration.retry) {
    log.warn(
      `[Breacher] Impact of pod ${pod.itemID} on ${targetEntity.itemID} will be retried: ` +
      `${registration.errorMsg || "its damage over time did not persist"}`,
    );
  }
  logMissileDebug("missile.lifecycle", () => ({
    sceneSystemID: scene.systemID,
    outcome: "breacher-impact",
    missile: summarizeMissileEntity(pod),
    target: summarizeRuntimeEntityForMissileDebug(targetEntity),
    sweep: normalizeTraceValue(options.sweep || null),
    registration: normalizeTraceValue(registration),
  }));
  scene.unregisterDynamicEntity(pod, {
    nowMs,
    delay: MISSILE_HIT_REMOVAL_DELAY_TICKS,
    persistSpaceState: false,
  });
  return {
    impact: Boolean(registration && registration.success),
    damageResult: null,
    destroyResult: null,
  };
}

// A missile Evolve removes without a hit: its flight time is up or
// its target is gone. No explosion. A bomb detonates where Evolve has it,
// and its detonation removes it; a breacher pod is removed
// without being persisted.
function removeMissileWithoutHit(scene, missileEntity, options = {}) {
  if (!scene || !missileEntity) {
    return false;
  }
  const nowMs = toFiniteNumber(options.nowMs, scene.getCurrentSimTimeMs());
  logMissileDebug("missile.lifecycle", () => ({
    sceneSystemID: scene.systemID,
    outcome: String(options.reason || "expired"),
    missile: summarizeMissileEntity(missileEntity),
  }));
  if (missileEntity.bombRuntimeEntity === true) {
    require("../modules/bombRuntime").detonateBombEntity(scene, missileEntity, nowMs);
    return true;
  }
  scene.unregisterDynamicEntity(
    missileEntity,
    missileEntity.breacherPodProjectile === true
      ? { nowMs, persistSpaceState: false }
      : { nowMs },
  );
  return true;
}

Object.assign(module.exports, {
  MISSILE_HIT_REMOVAL_DELAY_TICKS,
  nextMissileLaunchTraceID,
});
