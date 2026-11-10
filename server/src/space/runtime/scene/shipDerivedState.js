"use strict";

const runtimeEntryDirname = require("path").resolve(__dirname, "../..");
const path = require("path");
const {
  CAPSULE_TYPE_ID,
  CAPSULE_TYPE_ID_GOLDEN,
  ITEM_FLAGS,
  updateShipItem,
  updateInventoryItem,
  removeInventoryItem,
  getShipConditionState,
  normalizeShipConditionState,
  getItemMetadata,
  pruneExpiredSpaceItems,
} = require(path.join(runtimeEntryDirname, "../services/inventory/itemStore"));
const {
  buildShipPrimeDeltaUpdates,
} = require(path.join(
  runtimeEntryDirname,
  "./destiny/presentation/shipPrime.js",
));
const {
  applyPassiveMotionBaseCommand,
  applyPassiveMotionTimingCommand,
  applyPropulsionMotionBaseCommand,
  applyPropulsionMotionTimingCommand,
  restoreCommandedSpeedFractionCommand,
} = require(path.join(runtimeEntryDirname, "./destiny/commands/shipDerivedMotion.js"));
const { refreshControllerDroneDogma } = require("../../../services/drone/droneDogma");
const hostileModuleRuntime = require(path.join(
  runtimeEntryDirname,
  "./modules/hostileModuleRuntime",
));
const {
  collectEntityActiveSelfModifierEffectsByItemID,
  collectEntityActiveShipAttributeModifierEntries,
} = require("../activeShipModifiers");
const {
  buildEntityDerivedAttributeSnapshot,
  notifyFittedGenericModuleRangeAttributesToSession,
  notifyShipDerivedAttributesToSession,
  notifyTargetingDerivedAttributesToSession,
} = require("../attributeChangeNotification");
const {
  isReadyForDestiny,
} = require("../destinyDeliveryEligibility");
const {
  ATTRIBUTE_CAPACITOR_CAPACITY,
  ATTRIBUTE_MAX_LOCKED_TARGETS,
  ATTRIBUTE_MAX_TARGET_RANGE,
  ATTRIBUTE_MAX_VELOCITY,
  ATTRIBUTE_SCAN_RESOLUTION,
} = require("../dogmaAttributeIds");
const {
  getEntityCapacitorAmount,
  getEntityCapacitorRatio,
  persistEntityCapacitorRatio,
  setEntityCapacitorRatio,
} = require("../entityCapacitor");
const {
  getEntityRuntimeFittedItems,
  getEntityRuntimeModuleOwnerItems,
  getEntityRuntimeShipItem,
  getEntityRuntimeSkillMap,
  getShipEntityInventoryCharacterID,
} = require("../entityDogmaView");
const {
  persistDynamicEntity,
} = require("../entitySpacePersistence");
const {
  finalizeGenericModuleDeactivationWithoutSession,
  finalizePropulsionModuleDeactivationWithoutSession,
} = require("../moduleEffectShutdown");
const {
  clearPendingOverloadModuleTransition,
  stopOverloadStateForUnavailableModule,
} = require("../moduleHeat");
const {
  clamp,
  toFiniteNumber,
  toInt,
} = require("../../../common/numbers");
const {
  applyPassiveResourceStateToEntity,
  buildPassiveShipResourceState,
} = require("../passiveDerivedState");
const {
  PROPULSION_EFFECT_AFTERBURNER,
  PROPULSION_EFFECT_MICROWARPDRIVE,
  applyActivePropulsionEffectStatesToEntity,
} = require("../propulsionModule");
const {
  broadcastDamageStateChange,
} = require("../shipHealthState");
const {
  MAX_SUBWARP_SPEED_FRACTION,
  resolveNativeNpcPolicyMaxVelocityBase,
} = require("../shipMotionKinematics");
const {
  TARGETING_DERIVED_ATTRIBUTE_IDS,
  buildEntityTargetingAttributeSnapshot,
} = require("../targeting");
const {
  cloneVector,
} = require("../../../common/vector");

// The sessions that had a ship when its derived movement values began to wait
// in the Movement queue. Whoever gets the ship after that is built from the
// Ball's values until they apply (AddBalls2), so is told the new ones then.
const shipObserversBeforeMotionWait = new WeakMap();

// Each ship Ball's passive fitting, reused by every rebuild until what it is
// built from changes (buildShipResourceState, passiveFittingCache). A new Ball
// (undock, jump, boarding) starts with none.
const passiveFittingCaches = new WeakMap();

function getPassiveFittingCache(entity) {
  let cache = passiveFittingCaches.get(entity);
  if (!cache) {
    cache = {};
    passiveFittingCaches.set(entity, cache);
  }
  return cache;
}

function collectShipObserverSessions(scene, entity) {
  const observers = new Set();
  for (const session of scene.sessions.values()) {
    if (session && scene.canSessionSeeDynamicEntity(session, entity)) {
      observers.add(session);
    }
  }
  return observers;
}

module.exports = {

refreshShipEntityDerivedState(entityOrID, options = {}) {
    const entity =
      entityOrID && typeof entityOrID === "object"
        ? entityOrID
        : this.getEntityByID(toInt(entityOrID, 0));
    if (!entity || entity.kind !== "ship") {
      return {
        success: false,
        errorMsg: "SHIP_NOT_FOUND",
      };
    }

    const shipRecord = getEntityRuntimeShipItem(entity);
    if (!shipRecord) {
      return {
        success: false,
        errorMsg: "SHIP_NOT_FOUND",
      };
    }

    const previousCommandedSpeedFraction = clamp(
      toFiniteNumber(entity.speedFraction, 0),
      0,
      MAX_SUBWARP_SPEED_FRACTION,
    );
    const previousDerivedAttributeSnapshot =
      buildEntityDerivedAttributeSnapshot(entity);
    const previousTargetingSnapshot = buildEntityTargetingAttributeSnapshot(entity);
    const previousConditionState = normalizeShipConditionState(entity.conditionState);
    const previousInertia = toFiniteNumber(entity.inertia, 0);
    const previousMass = toFiniteNumber(entity.mass, 0);
    const previousMaxVelocity = toFiniteNumber(entity.maxVelocity, 0);
    const previousVelocity = cloneVector(entity.velocity);
    hostileModuleRuntime.recomputeTargetAggregateState(entity);
    const fittedItems = getEntityRuntimeFittedItems(entity);
    const session = options.session || entity.session || null;
    const validModuleOwnerIDs = new Set(
      getEntityRuntimeModuleOwnerItems(entity)
        .map((item) => toInt(item && item.itemID, 0))
        .filter((itemID) => itemID > 0),
    );
    if (entity.overloadModuleEffects instanceof Map) {
      for (const moduleID of [...entity.overloadModuleEffects.keys()]) {
        if (!validModuleOwnerIDs.has(toInt(moduleID, 0))) {
          stopOverloadStateForUnavailableModule(
            this,
            entity,
            moduleID,
            this.getCurrentSimTimeMs(),
          );
        }
      }
    }
    if (entity.pendingOverloadModuleEffects instanceof Map) {
      for (const moduleID of [...entity.pendingOverloadModuleEffects.keys()]) {
        if (!validModuleOwnerIDs.has(toInt(moduleID, 0))) {
          clearPendingOverloadModuleTransition(entity, moduleID);
        }
      }
    }
    if (entity.activeModuleEffects instanceof Map) {
      const removedEffectStates = [...entity.activeModuleEffects.values()]
        .filter((effectState) => !validModuleOwnerIDs.has(
          toInt(effectState && effectState.moduleID, 0),
        ));
      for (const effectState of removedEffectStates) {
        const moduleID = toInt(effectState && effectState.moduleID, 0);
        if (moduleID <= 0 || !entity.activeModuleEffects.has(moduleID)) {
          continue;
        }
        const effectName = String(effectState && effectState.effectName || "");
        const isPropulsionEffect =
          effectName === PROPULSION_EFFECT_AFTERBURNER ||
          effectName === PROPULSION_EFFECT_MICROWARPDRIVE;
        if (isPropulsionEffect) {
          if (session) {
            this.finalizePropulsionModuleDeactivation(session, moduleID, {
              reason: "unfit",
              nowMs: this.getCurrentSimTimeMs(),
            });
          } else {
            finalizePropulsionModuleDeactivationWithoutSession(
              this,
              entity,
              effectState,
              {
                reason: "unfit",
                nowMs: this.getCurrentSimTimeMs(),
              },
            );
          }
        } else if (session) {
          this.finalizeGenericModuleDeactivation(session, moduleID, {
            reason: "unfit",
            nowMs: this.getCurrentSimTimeMs(),
            refreshDerivedState: false,
          });
        } else {
          finalizeGenericModuleDeactivationWithoutSession(
            this,
            entity,
            effectState,
            {
              reason: "unfit",
              nowMs: this.getCurrentSimTimeMs(),
              refreshDerivedState: false,
            },
          );
        }
      }
    }
    const skillMap = getEntityRuntimeSkillMap(entity);
    // Authored capital bases win over the generic native bases: they
    // deliberately replace incomplete hull Dogma. Every other native NPC falls
    // back to the bases stamped at spawn, without which a rat whose entity type
    // has no maxTargetRange attribute is recomputed to a zero lock range and can
    // never lock anything (see applyNativeNpcHullCombatOverrides).
    const npcCombatBases =
      (
        entity.capitalNpc === true &&
        entity.capitalNpcCombatBases &&
        typeof entity.capitalNpcCombatBases === "object"
          ? entity.capitalNpcCombatBases
          : null
      ) ||
      (
        entity.nativeNpcCombatBases &&
        typeof entity.nativeNpcCombatBases === "object"
          ? entity.nativeNpcCombatBases
          : null
      );
    const npcCombatBasesMaxLockedTargets = npcCombatBases
      ? Math.max(0, toFiniteNumber(npcCombatBases.maxLockedTargets, 0))
      : 0;
    const nativeNpcPolicyMaxVelocity =
      resolveNativeNpcPolicyMaxVelocityBase(entity);
    const baseAttributeOverrides = npcCombatBases || nativeNpcPolicyMaxVelocity > 0
      ? {
        ...(npcCombatBases
          ? {
            [ATTRIBUTE_MAX_TARGET_RANGE]: Math.max(
              0,
              toFiniteNumber(npcCombatBases.maxTargetRange, 0),
            ),
            [ATTRIBUTE_SCAN_RESOLUTION]: Math.max(
              0,
              toFiniteNumber(npcCombatBases.scanResolution, 0),
            ),
            [ATTRIBUTE_CAPACITOR_CAPACITY]: Math.max(
              0,
              toFiniteNumber(npcCombatBases.capacitorCapacity, 0),
            ),
            // capitalNpcCombatBases predates this field, so only override the
            // lock slot count when a base actually carries one.
            ...(npcCombatBasesMaxLockedTargets > 0
              ? {
                [ATTRIBUTE_MAX_LOCKED_TARGETS]: npcCombatBasesMaxLockedTargets,
              }
              : {}),
          }
          : {}),
        ...(nativeNpcPolicyMaxVelocity > 0
          ? { [ATTRIBUTE_MAX_VELOCITY]: nativeNpcPolicyMaxVelocity }
          : {}),
      }
      : undefined;
    const passiveResourceState = buildPassiveShipResourceState(
      getShipEntityInventoryCharacterID(entity, 0),
      shipRecord,
      {
        fittedItems,
        skillMap,
        additionalAttributeModifierEntries:
          collectEntityActiveShipAttributeModifierEntries(
            entity,
            this.getCurrentSimTimeMs(),
          ),
        activeSelfModifierEffectsByItemID:
          collectEntityActiveSelfModifierEffectsByItemID(entity),
        baseAttributeOverrides,
        passiveFittingCache: getPassiveFittingCache(entity),
      },
    );
    // The ship's movement values change only at the next Destiny tick.
    // Unless they may change now, Dogma derives them on a
    // stand-in that reads through to the ship; everything else it derives is
    // taken at once, and the movement values are queued further down.
    const derived = this.movementChangesWait(entity)
      ? Object.create(entity)
      : entity;
    applyPassiveResourceStateToEntity(derived, passiveResourceState, {
      recalculateSpeedFraction: false,
    });
    applyActivePropulsionEffectStatesToEntity(
      derived,
      this.getCurrentSimTimeMs(),
    );

    restoreCommandedSpeedFractionCommand(
      derived,
      previousCommandedSpeedFraction,
    );
    const derivedMotion = this.captureShipMotion(derived);
    if (derived !== entity) {
      this.adoptDerivedShipState(entity, derived);
    }
    this.handleEntityTargetingAttributeChanges(entity, previousTargetingSnapshot);

    persistDynamicEntity(entity);

    refreshControllerDroneDogma(entity);

    const shouldBroadcast = options.broadcast !== false;
    const currentConditionState = normalizeShipConditionState(entity.conditionState);
    const bufferHealthRatioChanged =
      Math.abs(
        toFiniteNumber(currentConditionState.shieldCharge, 0) -
          toFiniteNumber(previousConditionState.shieldCharge, 0),
      ) > 1e-9 ||
      Math.abs(
        toFiniteNumber(currentConditionState.armorDamage, 0) -
          toFiniteNumber(previousConditionState.armorDamage, 0),
      ) > 1e-9;
    if (shouldBroadcast && bufferHealthRatioChanged) {
      broadcastDamageStateChange(
        this,
        entity,
        this.getCurrentSimTimeMs(),
      );
    }
    const shouldNotifyTargeting =
      options.notifyTargeting === true ||
      (options.notifyTargeting !== false && shouldBroadcast);
    const shouldNotifyDerivedAttributes =
      options.notifyDerivedAttributes !== false;
    const previousShipPrimeState = {
      inertia: previousInertia,
      mass: previousMass,
      maxVelocity: previousMaxVelocity,
    };
    // The new prime values go to the ship's Grid bubble history, its owner
    // included.
    const broadcastShipPrimeChanges = (previousShipPrimeState) => {
      if (!shouldBroadcast) {
        return;
      }
      const primeDeltaUpdates = buildShipPrimeDeltaUpdates(
        entity,
        previousShipPrimeState,
        this.nextDestinyStamp,
      );
      if (primeDeltaUpdates.length > 0) {
        this.queueBallHistory(entity, primeDeltaUpdates);
      }
    };
    // Observers hear of the new mass, agility and max speed when the ship
    // moves by them, at the next Destiny tick; a caller may tell them its own
    // way (shipPrimeBroadcast, given the values before).
    const tellObservers = (shipPrimeStateBefore) => {
      if (typeof options.shipPrimeBroadcast === "function") {
        options.shipPrimeBroadcast(shipPrimeStateBefore);
      } else {
        broadcastShipPrimeChanges(shipPrimeStateBefore);
      }
    };
    const motionWasWaiting = Boolean(entity.pendingShipMotion);
    const motionQueued = derived !== entity && this.queueShipMotionChange(
      entity,
      derivedMotion,
      (motionBefore) => {
        persistDynamicEntity(entity);
        const shipPrimeStateBefore = {
          inertia: toFiniteNumber(motionBefore.inertia, 0),
          mass: toFiniteNumber(motionBefore.mass, 0),
          maxVelocity: toFiniteNumber(motionBefore.maxVelocity, 0),
        };
        tellObservers(shipPrimeStateBefore);
        const observersBefore = shipObserversBeforeMotionWait.get(entity);
        shipObserversBeforeMotionWait.delete(entity);
        // As retail, every current Observer has the values once they apply:
        // a refresh that tells no one still tells those who got the ship
        // while they waited, each in its own character history.
        if (
          !shouldBroadcast &&
          typeof options.shipPrimeBroadcast !== "function" &&
          observersBefore
        ) {
          const lateObservers = [...collectShipObserverSessions(this, entity)]
            .filter((observer) => observer !== session && !observersBefore.has(observer));
          if (lateObservers.length > 0) {
            const primeDeltaUpdates = buildShipPrimeDeltaUpdates(
              entity,
              shipPrimeStateBefore,
              this.nextDestinyStamp,
            );
            for (const observer of primeDeltaUpdates.length > 0 ? lateObservers : []) {
              this.queueCharacterHistory(observer, primeDeltaUpdates);
            }
          }
        }
      },
    );
    if (motionQueued && !motionWasWaiting) {
      shipObserversBeforeMotionWait.set(
        entity,
        collectShipObserverSessions(this, entity),
      );
    }
    if (!motionQueued) {
      if (derived === entity) {
        this.dropPendingShipMotion(entity);
      }
      tellObservers(previousShipPrimeState);
    }
    if (
      shouldNotifyDerivedAttributes &&
      session &&
      isReadyForDestiny(session)
    ) {
      // Generic active modules can change authoritative ship Dogma attributes
      // without using one of the specialized targeting/propulsion presenters.
      // Send only the actual before/after delta so the client HUD follows the
      // same derived state used by combat calculations.
      notifyShipDerivedAttributesToSession(
        session,
        entity,
        previousDerivedAttributeSnapshot,
        {
          // Targeting values are owned by the specialized targeting presenter.
          // Exclude them even when that presenter is disabled for this refresh
          // so the generic lane cannot accidentally bypass its delivery contract.
          excludedAttributeIDs: TARGETING_DERIVED_ATTRIBUTE_IDS,
        },
      );
    }
    if (
      shouldNotifyTargeting &&
      session &&
      isReadyForDestiny(session)
    ) {
      notifyTargetingDerivedAttributesToSession(
        session,
        entity,
        previousTargetingSnapshot,
      );
    }
    if (
      session &&
      isReadyForDestiny(session) &&
      options.notifyGenericModuleAttributes !== false
    ) {
      notifyFittedGenericModuleRangeAttributesToSession(session, entity);
    }
    return {
      success: true,
      data: {
        entity,
        previousInertia,
        previousMass,
        previousMaxVelocity,
        previousVelocity,
      },
    };
  },

refreshSessionShipDerivedState(session, options = {}) {
    const entity = this.getShipEntityForSession(session);
    return this.refreshShipEntityDerivedState(entity, {
      ...options,
      session,
    });
  },

getShipCapacitorState(session) {
    const entity = this.getShipEntityForSession(session);
    if (!entity) {
      return null;
    }

    return {
      capacity: toFiniteNumber(entity.capacitorCapacity, 0),
      amount: getEntityCapacitorAmount(entity),
      ratio: getEntityCapacitorRatio(entity),
    };
  },

setShipCapacitorRatio(session, nextRatio) {
    const entity = this.getShipEntityForSession(session);
    if (!entity) {
      return {
        success: false,
        errorMsg: "SHIP_NOT_FOUND",
      };
    }

    setEntityCapacitorRatio(entity, nextRatio);
    persistEntityCapacitorRatio(entity);
    return {
      success: true,
      data: this.getShipCapacitorState(session),
    };
  },
};
