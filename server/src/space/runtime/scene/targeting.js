"use strict";

const { queueDogmaEvent } = require("../dogmaEvents");
const { buildPythonSet } = require("../../../services/_shared/serviceHelpers");

const runtimeEntryDirname = require("path").resolve(__dirname, "../..");
const path = require("path");
const starbaseDefenseRuntime = require("../../../services/starbase/starbaseDefenseRuntime");
const {
  canEntitiesInteractLocally,
  isSharedPveTarget,
  resolveEntityInteractionScope,
} = require(path.join(runtimeEntryDirname, "./destiny/identity/interactionScope.js"));
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
const hostileModuleRuntime = require(path.join(
  runtimeEntryDirname,
  "./modules/hostileModuleRuntime",
));
const jammerModuleRuntime = require(path.join(
  runtimeEntryDirname,
  "./modules/jammerModuleRuntime",
));
const {
  isEntityInActiveWarp,
} = require(path.join(runtimeEntryDirname, "./destiny/simulation/warpPhase"));
const structureTethering = require(path.join(
  runtimeEntryDirname,
  "./structureTethering",
));
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
  resolveAutoTargetingMissileNpcPackKey,
} = require("../autoTargetingMissiles");
const {
  isReadyForDestiny,
} = require("../destinyDeliveryEligibility");
const {
  getEntitySurfaceDistance,
} = require("../entityDistance");
const {
  getShipEntityInventoryCharacterID,
} = require("../entityDogmaView");
const {
  finalizeGenericModuleDeactivationWithoutSession,
} = require("../moduleEffectShutdown");
const {
  clamp,
  toFiniteNumber,
  toInt,
} = require("../../../common/numbers");
const {
  lazyRequire,
} = require("../runtimeModuleBoundary");
const {
  isEntityCloaked,
  isEntityModuleCloaked,
} = require("../shipCloak");
const {
  broadcastDamageStateChange,
} = require("../shipHealthState");
const {
  breakEntityStructureTether,
} = require("../structureTether");
const {
  TARGETING_CLIENT_FALLBACK_LOCK_MS,
  TARGET_LOSS_REASON_ATTEMPT_CANCELLED,
  TARGET_LOSS_REASON_EXPLODING,
  TARGET_LOSS_REASON_WARPING_OUT,
  buildEntityTargetingAttributeSnapshot,
  computeTargetLockDurationMs,
  ensureEntityTargetingState,
  isNonTargetableSceneryEntity,
} = require("../targeting");
const {
  breakEntityTimedInvulnerability,
  isEntityUndockInvulnerable,
} = require("../timedInvulnerability");
const {
  isOffensiveWeaponFamily,
} = require("../weaponSnapshot");

module.exports = {

allocateTargetSequence() {
    const sequence = toInt(this.nextTargetSequence, 1);
    this.nextTargetSequence = sequence + 1;
    return sequence;
  },

getEntityTargetingStats(entity) {
    if (!entity) {
      return null;
    }

    const numericCharID = getShipEntityInventoryCharacterID(entity, 0);
    const normalizedEntityID = toInt(entity.itemID, 0);
    const targetLockSuppressed = hostileModuleRuntime.isTargetLockSuppressed(entity);
    if (normalizedEntityID > 0 && this._tickTargetingStatsCache instanceof Map) {
      const cached = this._tickTargetingStatsCache.get(normalizedEntityID) || null;
      if (
        cached &&
        cached.targetLockSuppressed === targetLockSuppressed
      ) {
        return cached;
      }
    }
    const characterTargetingState =
      numericCharID > 0
        ? buildCharacterTargetingState(numericCharID)
        : { maxLockedTargets: toInt(entity.maxLockedTargets, 0) };
    const shipMaxLockedTargets = Math.max(0, toInt(entity.maxLockedTargets, 0));
    const characterMaxLockedTargets = Math.max(
      0,
      toInt(characterTargetingState.maxLockedTargets, shipMaxLockedTargets),
    );
    const effectiveMaxLockedTargets = targetLockSuppressed
      ? 0
      : shipMaxLockedTargets > 0 && characterMaxLockedTargets > 0
        ? Math.min(shipMaxLockedTargets, characterMaxLockedTargets)
        : Math.max(shipMaxLockedTargets, characterMaxLockedTargets);

    const targetingStats = {
      maxTargetRange: Math.max(0, toFiniteNumber(entity.maxTargetRange, 0)),
      shipMaxLockedTargets,
      characterMaxLockedTargets,
      effectiveMaxLockedTargets,
      targetLockSuppressed,
      scanResolution: Math.max(0, toFiniteNumber(entity.scanResolution, 0)),
      cloakingTargetingDelay: Math.max(
        0,
        toFiniteNumber(entity.cloakingTargetingDelay, 0),
      ),
    };
    if (normalizedEntityID > 0 && this._tickTargetingStatsCache instanceof Map) {
      this._tickTargetingStatsCache.set(normalizedEntityID, targetingStats);
    }
    return targetingStats;
  },

getTargetsForEntity(entity) {
    const state = ensureEntityTargetingState(entity);
    if (!state) {
      return [];
    }

    return [...state.lockedTargets.values()]
      .sort(
        (left, right) =>
          toInt(left && left.sequence, 0) - toInt(right && right.sequence, 0) ||
          toInt(left && left.targetID, 0) - toInt(right && right.targetID, 0),
      )
      .map((entry) => toInt(entry && entry.targetID, 0))
      .filter((targetID) => targetID > 0);
  },

getTargetersForEntity(entity) {
    const state = ensureEntityTargetingState(entity);
    if (!state) {
      return [];
    }

    return [...state.targetedBy]
      .map((sourceID) => toInt(sourceID, 0))
      .filter((sourceID) => sourceID > 0)
      .sort((left, right) => left - right);
  },

getSortedPendingTargetLocks(entity) {
    const state = ensureEntityTargetingState(entity);
    if (!state) {
      return [];
    }

    return [...state.pendingTargetLocks.values()].sort(
      (left, right) =>
        toFiniteNumber(left && left.completeAtMs, 0) -
          toFiniteNumber(right && right.completeAtMs, 0) ||
        toInt(left && left.sequence, 0) - toInt(right && right.sequence, 0),
    );
  },

notifyTargetEvent(session, what, targetID = null, reason = null) {
    if (!session || typeof session.sendNotification !== "function") {
      return false;
    }

    const payload = [String(what || "")];
    if (targetID !== null && targetID !== undefined) {
      payload.push(toInt(targetID, 0));
    }
    if (reason !== null && reason !== undefined) {
      payload.push(String(reason));
    }

    // A locker that explodes is told to its target at once, on its own: TQ
    // sends OnTarget('otherlost', id, 'Exploding') as a plain notification,
    // before the tick of the RemoveBalls (golden log TheBlockadeLevel1 line
    // 32182, all 94 in the mission logs). Every other OnTarget is a Dogma
    // event. If an OnTarget about that ship still waits for the batch, the
    // loss queues behind it: the client keeps a targeter whose otheradd comes
    // after its ball is gone (targetMgr.py OnTargetByOther).
    const sourceID = toInt(targetID, 0);
    if (
      what === "otherlost" &&
      reason === TARGET_LOSS_REASON_EXPLODING &&
      !(typeof this.hasQueuedDogmaEvent === "function" && this.hasQueuedDogmaEvent(
        session,
        (event) => event[0] === "OnTarget" && toInt(event[2], 0) === sourceID,
      ))
    ) {
      session.sendNotification("OnTarget", "shipid", payload);
      return true;
    }
    queueDogmaEvent(session, "OnTarget", payload, { idType: "shipid" });
    return true;
  },

notifyTargetLockFailure(session, targetID, options = {}) {
    if (!session) {
      return false;
    }

    const normalizedTargetID = toInt(targetID, 0);
    if (normalizedTargetID <= 0) {
      return false;
    }

    let notified = false;
    if (typeof session.sendServiceNotification === "function") {
      session.sendServiceNotification("target", "FailLockTarget", [
        normalizedTargetID,
      ]);
      notified = true;
    }

    let targetEventNotified = false;
    if (!notified || options.emitTargetLossEvent === true) {
      targetEventNotified = this.notifyTargetEvent(
        session,
        "lost",
        normalizedTargetID,
        TARGET_LOSS_REASON_ATTEMPT_CANCELLED,
      );
    }
    return notified || targetEventNotified;
  },

getTargetLockRangeDecision(sourceEntity, targetEntity, targetingStats = null) {
    if (!sourceEntity || !targetEntity) {
      return {
        desiredRange: 0,
        actualDistance: Infinity,
        projected: false,
      };
    }

    const resolvedTargetingStats =
      targetingStats || this.getEntityTargetingStats(sourceEntity);
    const desiredRange = Math.max(
      0,
      toFiniteNumber(
        resolvedTargetingStats && resolvedTargetingStats.maxTargetRange,
        0,
      ),
    );

    // The lock range is checked against the live surface distance, the Balls
    // as the last Evolve left them (no command-time projection),
    // for every lock source, drones included.
    const projectedDistanceMeters = toFiniteNumber(
      this.getEntitySurfaceDistance(sourceEntity, targetEntity),
      Number.NaN,
    );
    const resolvedDistanceMeters = Number.isFinite(projectedDistanceMeters)
      ? projectedDistanceMeters
      : getEntitySurfaceDistance(sourceEntity, targetEntity);
    return {
      desiredRange,
      actualDistance: resolvedDistanceMeters,
      projected: Number.isFinite(projectedDistanceMeters),
    };
  },

isTargetLockRangeValid(sourceEntity, targetEntity, targetingStats = null) {
    const rangeDecision = this.getTargetLockRangeDecision(
      sourceEntity,
      targetEntity,
      targetingStats,
    );
    return (
      rangeDecision.desiredRange > 0 &&
      rangeDecision.actualDistance < rangeDecision.desiredRange
    );
  },

validateTargetLockRequest(session, sourceEntity, targetEntity, options = {}) {
    if ((!session || !session._space) && !sourceEntity) {
      return {
        success: false,
        errorMsg: "NOT_IN_SPACE",
      };
    }
    if (!sourceEntity) {
      return {
        success: false,
        errorMsg: "SHIP_NOT_FOUND",
      };
    }
    if (!targetEntity) {
      return {
        success: false,
        errorMsg: "TARGET_NOT_FOUND",
      };
    }
    if (!canEntitiesInteractLocally(sourceEntity, targetEntity)) {
      return {
        success: false,
        errorMsg: "TARGET_NOT_FOUND",
      };
    }
    // Native NPC pseudo-sessions reuse the player ship API, but they are not
    // player visibility principals. Once NPC combat selection has admitted an
    // attached player as a local target, session presentation must not veto
    // that lock. All target-state and range checks below still apply normally.
    const nativeNpcTargetingPlayer = Boolean(
      sourceEntity.nativeNpc === true &&
      targetEntity.kind === "ship" &&
      targetEntity.session &&
      toInt(targetEntity.session.characterID, 0) > 0
    );
    // Nor does it veto the AIR fleet battle: the ships of one pilot's AIR site are all scoped to
    // that pilot, never to an NPC session (airCombatPolicy).
    const airFleetBattleLock = require("../../combat/airCombatPolicy").isBattleShot(sourceEntity, targetEntity);
    if (
      session &&
      !nativeNpcTargetingPlayer &&
      !airFleetBattleLock &&
      !this.canSessionSeeDungeonScopedEntity(session, targetEntity)
    ) {
      return {
        success: false,
        errorMsg: "TARGET_NOT_FOUND",
      };
    }
    if (isEntityCloaked(targetEntity)) {
      return {
        success: false,
        errorMsg: "TARGET_NOT_FOUND",
      };
    }
    if (structureTethering.isEntityStructureTethered(targetEntity)) {
      return {
        success: false,
        errorMsg: "TARGET_TETHERED",
      };
    }
    // Undock invulnerability is a LOCK refusal, exactly like the tether above —
    // not a damage shield. A ship still inside its grace cannot be locked, so in
    // practice nothing that needs a lock can reach it, while smartbombs and
    // other unlocked area effects land normally the way they do on TQ.
    if (isEntityUndockInvulnerable(targetEntity, this.getCurrentSimTimeMs())) {
      return {
        success: false,
        errorMsg: "TARGET_INVULNERABLE",
      };
    }
    if (toInt(sourceEntity.itemID, 0) === toInt(targetEntity.itemID, 0)) {
      return {
        success: false,
        errorMsg: "TARGET_SELF",
      };
    }
    if (isNonTargetableSceneryEntity(targetEntity)) {
      return {
        success: false,
        errorMsg: "TARGET_NOT_TARGETABLE",
        data: {
          targetTypeID: toInt(targetEntity.slimTypeID, toInt(targetEntity.typeID, 0)),
        },
      };
    }
    if (
      jammerModuleRuntime.isEntityJammed(
        sourceEntity,
        this.getCurrentSimTimeMs(),
      ) &&
      jammerModuleRuntime.canEntityLockTargetWhileJammed(
        sourceEntity,
        targetEntity.itemID,
        this.getCurrentSimTimeMs(),
      ) !== true
    ) {
      return {
        success: false,
        errorMsg: "TARGET_JAMMED",
      };
    }
    if (isEntityInActiveWarp(sourceEntity)) {
      return {
        success: false,
        errorMsg: "SOURCE_WARPING",
      };
    }
    if (isEntityInActiveWarp(targetEntity)) {
      return {
        success: false,
        errorMsg: "TARGET_WARPING",
      };
    }
    // "While the cloak is active the ship cannot target anything", and after it
    // drops the sensors take `cloakingTargetingDelay` to recalibrate — 30 s on a
    // Prototype, 20 s on an Improved, 10 s on a Covert Ops, zero on a Stealth
    // Bomber or a Black Ops. Both are the same rule seen at two moments, so both
    // live here, which is the one gate every lock goes through: manual
    // `addTarget`, an Auto Targeting System's `requestModuleTargetLock`, and the
    // per-tick `validateEntityTargetLocks` sweep that also tears down a lock the
    // ship is no longer allowed to hold. Gate cloak is deliberately excluded: it
    // is not a device and carries no recalibration.
    // https://wiki.eveuniversity.org/Cloaking
    if (isEntityModuleCloaked(sourceEntity)) {
      return {
        success: false,
        errorMsg: "SOURCE_CLOAKED",
      };
    }
    if (
      toFiniteNumber(sourceEntity.decloakTargetingBlockedUntilMs, 0) >
        this.getCurrentSimTimeMs()
    ) {
      return {
        success: false,
        errorMsg: "SENSORS_RECALIBRATING",
      };
    }
    const targetingStats = this.getEntityTargetingStats(sourceEntity);
    const rangeDecision = this.getTargetLockRangeDecision(
      sourceEntity,
      targetEntity,
      targetingStats,
    );
    if (
      rangeDecision.desiredRange <= 0 ||
      !Number.isFinite(rangeDecision.actualDistance) ||
      rangeDecision.actualDistance >= rangeDecision.desiredRange
    ) {
      return {
        success: false,
        errorMsg: "TARGET_OUT_OF_RANGE",
        data: {
          targetTypeID: toInt(targetEntity.typeID, 0),
          sourceTypeID: toInt(sourceEntity.typeID, 0),
          rangeDecision,
        },
      };
    }

    if (!targetingStats || targetingStats.effectiveMaxLockedTargets <= 0) {
      return {
        success: false,
        errorMsg: "TARGET_LOCK_LIMIT_REACHED",
        data: {
          limit: targetingStats ? targetingStats.effectiveMaxLockedTargets : 0,
        },
      };
    }

    if (options.ignoreCapacity !== true) {
      const state = ensureEntityTargetingState(sourceEntity);
      const totalTargets =
        state.lockedTargets.size + state.pendingTargetLocks.size;
      if (totalTargets >= targetingStats.effectiveMaxLockedTargets) {
        return {
          success: false,
          errorMsg: "TARGET_LOCK_LIMIT_REACHED",
          data: {
            limit: targetingStats.effectiveMaxLockedTargets,
          },
        };
      }
    }

    return {
      success: true,
      data: {
        targetingStats,
      },
    };
  },

rebasePendingTargetLock(sourceEntity, pendingLock, targetEntity, now = this.getCurrentSimTimeMs()) {
    if (!sourceEntity || !pendingLock || !targetEntity) {
      return null;
    }

    const oldDurationMs = Math.max(
      1,
      toFiniteNumber(pendingLock.totalDurationMs, TARGETING_CLIENT_FALLBACK_LOCK_MS),
    );
    const nowMs = toFiniteNumber(now, this.getCurrentSimTimeMs());
    const elapsedMs = clamp(
      nowMs - toFiniteNumber(pendingLock.requestedAtMs, nowMs),
      0,
      oldDurationMs,
    );
    const progressRatio = clamp(elapsedMs / oldDurationMs, 0, 1);
    const newDurationMs = computeTargetLockDurationMs(sourceEntity, targetEntity);

    pendingLock.totalDurationMs = newDurationMs;
    pendingLock.requestedAtMs = nowMs - (newDurationMs * progressRatio);
    pendingLock.completeAtMs = pendingLock.requestedAtMs + newDurationMs;
    return pendingLock;
  },

rebasePendingTargetLocksForSource(sourceEntity, now = this.getCurrentSimTimeMs()) {
    const state = ensureEntityTargetingState(sourceEntity);
    if (!state) {
      return;
    }

    for (const pendingLock of state.pendingTargetLocks.values()) {
      const targetEntity = this.getEntityByID(pendingLock.targetID);
      if (!targetEntity) {
        continue;
      }
      this.rebasePendingTargetLock(sourceEntity, pendingLock, targetEntity, now);
    }
  },

rebaseIncomingPendingTargetLocksForTarget(targetEntity, now = this.getCurrentSimTimeMs()) {
    if (!targetEntity) {
      return;
    }

    const targetID = toInt(targetEntity.itemID, 0);
    if (targetID <= 0) {
      return;
    }

    for (const sourceEntity of this.dynamicEntities.values()) {
      const sourceState = ensureEntityTargetingState(sourceEntity);
      if (!sourceState) {
        continue;
      }
      const pendingLock = sourceState.pendingTargetLocks.get(targetID) || null;
      if (!pendingLock) {
        continue;
      }
      this.rebasePendingTargetLock(sourceEntity, pendingLock, targetEntity, now);
    }
  },

cancelPendingTargetLock(sourceEntity, targetEntityID, options = {}) {
    const sourceState = ensureEntityTargetingState(sourceEntity);
    if (!sourceState) {
      return false;
    }

    const normalizedTargetID = toInt(targetEntityID, 0);
    if (!sourceState.pendingTargetLocks.has(normalizedTargetID)) {
      return false;
    }

    sourceState.pendingTargetLocks.delete(normalizedTargetID);
    if (options.notifySelf !== false && starbaseDefenseRuntime.isStarbaseBattery(sourceEntity)) {
      lazyRequire("../services/starbase/starbaseControlRuntime").notifyStarbaseTargetEvent(
        sourceEntity, "lost", normalizedTargetID, options.reason ?? TARGET_LOSS_REASON_ATTEMPT_CANCELLED);
    }
    if (options.notifySelf !== false && sourceEntity && sourceEntity.session) {
      this.notifyTargetLockFailure(sourceEntity.session, normalizedTargetID, {
        emitTargetLossEvent: options.emitTargetLossEvent === true,
      });
    }
    return true;
  },

finalizeTargetLock(sourceEntity, targetEntity, options = {}) {
    const sourceState = ensureEntityTargetingState(sourceEntity);
    const targetState = ensureEntityTargetingState(targetEntity);
    if (!sourceState || !targetState) {
      return {
        success: false,
        errorMsg: "TARGET_NOT_FOUND",
      };
    }

    const targetID = toInt(targetEntity.itemID, 0);
    const pendingLock =
      options.pendingLock || sourceState.pendingTargetLocks.get(targetID) || null;
    const validation = this.validateTargetLockRequest(
      sourceEntity && sourceEntity.session,
      sourceEntity,
      targetEntity,
      {
        ignoreCapacity: true,
      },
    );
    if (!validation.success) {
      if (pendingLock) {
        sourceState.pendingTargetLocks.delete(targetID);
      }
      return validation;
    }

    const targetingStats = validation.data.targetingStats;
    if (sourceState.lockedTargets.has(targetID)) {
      if (pendingLock) {
        sourceState.pendingTargetLocks.delete(targetID);
      }
      return {
        success: true,
        data: {
          pending: false,
          targets: this.getTargetsForEntity(sourceEntity),
        },
      };
    }
    if (sourceState.lockedTargets.size >= targetingStats.effectiveMaxLockedTargets) {
      if (pendingLock) {
        sourceState.pendingTargetLocks.delete(targetID);
      }
      return {
        success: false,
        errorMsg: "TARGET_LOCK_LIMIT_REACHED",
      };
    }

    if (pendingLock) {
      sourceState.pendingTargetLocks.delete(targetID);
    }

    const sourceID = toInt(sourceEntity.itemID, 0);
    sourceState.lockedTargets.set(targetID, {
      targetID,
      sequence: toInt(pendingLock && pendingLock.sequence, 0) || this.allocateTargetSequence(),
      acquiredAtMs: toFiniteNumber(options.nowMs, this.getCurrentSimTimeMs()),
    });
    require("../../../services/ship/safeLogoffRuntime").handleIncomingTarget(sourceEntity, targetEntity);
    targetState.targetedBy.add(sourceID);
    if (starbaseDefenseRuntime.isStarbaseBattery(sourceEntity)) {
      lazyRequire("../services/starbase/starbaseControlRuntime").notifyStarbaseTargetEvent(
        sourceEntity, "add", targetID);
      if (hasDamageableHealth(targetEntity)) {
        broadcastDamageStateChange(this, targetEntity,
          toFiniteNumber(options.nowMs, this.getCurrentSimTimeMs()));
      }
    }

    if (sourceEntity.session) {
      this.notifyTargetEvent(sourceEntity.session, "add", targetID);
      if (targetEntity.kind === "station" || hasDamageableHealth(targetEntity)) {
        broadcastDamageStateChange(
          this,
          targetEntity,
          toFiniteNumber(options.nowMs, this.getCurrentSimTimeMs()),
        );
      }
    }
    // A Passive Targeter's whole purpose is that the ship it is pointed at is
    // never told. Everything else about the lock is ordinary, so only the
    // outbound notice is withheld.
    if (
      targetEntity.session &&
      targetEntity.session !== sourceEntity.session &&
      options.suppressTargetNotice !== true
    ) {
      this.notifyTargetEvent(targetEntity.session, "otheradd", sourceID);
    }

    return {
      success: true,
      data: {
        pending: false,
        targets: this.getTargetsForEntity(sourceEntity),
        targetNoticeSuppressed: options.suppressTargetNotice === true,
      },
    };
  },

removeLockedTarget(sourceEntity, targetEntityID, options = {}) {
    const sourceState = ensureEntityTargetingState(sourceEntity);
    if (!sourceState) {
      return false;
    }

    const normalizedTargetID = toInt(targetEntityID, 0);
    if (!sourceState.lockedTargets.has(normalizedTargetID)) {
      return false;
    }

    sourceState.lockedTargets.delete(normalizedTargetID);
    this.stopTargetedModuleEffects(sourceEntity, normalizedTargetID, {
      reason: options.reason ?? "target",
      nowMs: options.nowMs,
      miningDepletionSourceEntityID: options.miningDepletionSourceEntityID,
      miningDepletionModuleID: options.miningDepletionModuleID,
    });
    const targetEntity = this.getEntityByID(normalizedTargetID);
    if (targetEntity) {
      ensureEntityTargetingState(targetEntity).targetedBy.delete(
        toInt(sourceEntity && sourceEntity.itemID, 0),
      );
    }

    if (options.notifySelf !== false && sourceEntity && sourceEntity.session) {
      this.notifyTargetEvent(
        sourceEntity.session,
        "lost",
        normalizedTargetID,
        options.reason ?? null,
      );
    }
    if (options.notifySelf !== false && starbaseDefenseRuntime.isStarbaseBattery(sourceEntity)) {
      lazyRequire("../services/starbase/starbaseControlRuntime").notifyStarbaseTargetEvent(
        sourceEntity, "lost", normalizedTargetID, options.reason ?? null);
    }
    if (
      options.notifyTarget !== false &&
      targetEntity &&
      targetEntity.session &&
      targetEntity.session !== sourceEntity.session
    ) {
      // `targetNoticeReason` is said to the ship that was locked alone: the reason a lock on it ended where the
      // locking ship's own notice has none known (Tranquility's 'WarpingOut' to a ship gone into warp).
      this.notifyTargetEvent(
        targetEntity.session,
        "otherlost",
        sourceEntity.itemID,
        options.targetNoticeReason ?? options.reason ?? null,
      );
    }

    return true;
  },

stopTargetedModuleEffects(sourceEntity, targetEntityID, options = {}) {
    if (
      !sourceEntity ||
      !(sourceEntity.activeModuleEffects instanceof Map)
    ) {
      return 0;
    }

    const normalizedTargetID = toInt(targetEntityID, 0);
    if (normalizedTargetID <= 0) {
      return 0;
    }

    const stopReason = String(options.reason || "target");
    const miningDepletionSourceEntityID = toInt(
      options.miningDepletionSourceEntityID,
      0,
    );
    const miningDepletionModuleID = toInt(options.miningDepletionModuleID, 0);
    const stopTimeMs = Math.max(
      0,
      toFiniteNumber(options.nowMs, this.getCurrentSimTimeMs()),
    );
    const lostTargetEntity = this.getEntityByID(normalizedTargetID);
    let stoppedCount = 0;

    for (const effectState of [...sourceEntity.activeModuleEffects.values()]) {
      if (!effectState || toInt(effectState.targetID, 0) !== normalizedTargetID) {
        continue;
      }

      // A fired superweapon owns its whole cycle, including the cooldown.
      // Target death, unlocking, or leaving the grid must not release that
      // cycle (titan doomsdays have no separate reactivation delay). The
      // dedicated damage tick handles a missing target without firing again.
      if (effectState.superweaponEffect === true) {
        continue;
      }

      const moduleID = toInt(effectState.moduleID, 0);
      if (moduleID <= 0) {
        continue;
      }

      const effectStopReason =
        miningDepletionSourceEntityID > 0 &&
        miningDepletionModuleID > 0 &&
        toInt(sourceEntity && sourceEntity.itemID, 0) === miningDepletionSourceEntityID &&
        moduleID === miningDepletionModuleID
          ? "miningDepleted"
          : stopReason;
      if (
        effectState.autoTargetingMissileEffect === true &&
        effectStopReason === TARGET_LOSS_REASON_EXPLODING
      ) {
        // FOF launchers are allowed to find another direct aggressor on their
        // next cycle, or another member of the destroyed NPC's exact authored
        // pack. Keep that authority on this effect rather than in a scene-wide
        // cache, and never infer a pack from grid/faction membership.
        const hostilePackKey = resolveAutoTargetingMissileNpcPackKey(
          lostTargetEntity,
        );
        if (hostilePackKey) {
          effectState.autoTargetingMissileHostilePackKey = hostilePackKey;
        }
        effectState.targetID = 0;
        continue;
      }
      // A weapon whose target dies rides out the cycle it has already paid for,
      // so the cycle ring runs to the end of its sweep and the reactivation
      // delay starts at the boundary rather than at the moment of death. FOF
      // launchers are exempted from the immediate stop a few lines above, so
      // the engine already treats "the target died" as something a launcher
      // rides through; this is the same rule for ordinary weapons. Every other
      // stop reason -- a cancelled lock, a depleted mining target, propulsion
      // and remote-assistance modules -- still stops the module where it is.
      //
      // Deferring is what the effect needs rather than a later stop timestamp:
      // the finalize helpers drop the effect from activeModuleEffects at once,
      // which takes the ring with it however the stop time is recorded. Only
      // effects with a session defer, because a ring vanishing mid-sweep and a
      // reactivation delay starting early are both things only a player sees.
      const usesCycleBoundary =
        effectStopReason === TARGET_LOSS_REASON_EXPLODING &&
        isOffensiveWeaponFamily(effectState.weaponFamily);
      let stopResult = null;
      if (sourceEntity.session && isReadyForDestiny(sourceEntity.session)) {
        stopResult = usesCycleBoundary
          ? this.deactivateGenericModule(
              sourceEntity.session,
              moduleID,
              {
                reason: effectStopReason,
                deferUntilCycle: true,
              },
            )
          : effectState.isGeneric
          ? this.finalizeGenericModuleDeactivation(
              sourceEntity.session,
              moduleID,
              {
                reason: effectStopReason,
                nowMs: stopTimeMs,
              },
            )
          : this.finalizePropulsionModuleDeactivation(
              sourceEntity.session,
              moduleID,
              {
                reason: effectStopReason,
                nowMs: stopTimeMs,
              },
            );
      } else {
        stopResult = effectState.isGeneric === true
          ? finalizeGenericModuleDeactivationWithoutSession(
              this,
              sourceEntity,
              effectState,
              {
                reason: effectStopReason,
                nowMs: stopTimeMs,
              },
            )
          : (() => {
              sourceEntity.activeModuleEffects.delete(moduleID);
              if (!(sourceEntity.moduleReactivationLocks instanceof Map)) {
                sourceEntity.moduleReactivationLocks = new Map();
              }
              sourceEntity.moduleReactivationLocks.set(
                moduleID,
                stopTimeMs + Math.max(0, toFiniteNumber(effectState.reactivationDelayMs, 0)),
              );
              effectState.deactivatedAtMs = stopTimeMs;
              effectState.deactivationRequestedAtMs = 0;
              effectState.deactivateAtMs = 0;
              effectState.stopReason = effectStopReason;

              if (effectState.guid) {
                this.broadcastSpecialFx(
                  sourceEntity.itemID,
                  effectState.guid,
                  {
                    moduleID: effectState.moduleID,
                    moduleTypeID: effectState.typeID,
                    targetID: effectState.targetID || null,
                    chargeTypeID: effectState.chargeTypeID || null,
                    isOffensive: isOffensiveWeaponFamily(effectState.weaponFamily),
                    start: false,
                    active: false,
                    duration: effectState.durationMs,
                  },
                  sourceEntity,
                );
              }

              return { success: true };
            })();
      }

      if (stopResult && stopResult.success) {
        stoppedCount += 1;
      }
    }

    return stoppedCount;
  },

clearOutgoingTargetLocks(sourceEntity, options = {}) {
    const sourceState = ensureEntityTargetingState(sourceEntity);
    if (!sourceState) {
      return {
        clearedTargetIDs: [],
        cancelledPendingIDs: [],
      };
    }

    const notifySelf = options.notifySelf !== false;
    const notifyTarget = options.notifyTarget !== false;
    const cancelledPendingIDs = [...sourceState.pendingTargetLocks.keys()]
      .map((targetID) => toInt(targetID, 0))
      .filter((targetID) => targetID > 0);
    for (const pendingTargetID of cancelledPendingIDs) {
      this.cancelPendingTargetLock(sourceEntity, pendingTargetID, {
        notifySelf,
        reason: options.pendingReason ?? TARGET_LOSS_REASON_ATTEMPT_CANCELLED,
      });
    }

    const clearedTargetIDs = this.getTargetsForEntity(sourceEntity);
    const sourceID = toInt(sourceEntity && sourceEntity.itemID, 0);
    for (const targetID of clearedTargetIDs) {
      sourceState.lockedTargets.delete(targetID);
      this.stopTargetedModuleEffects(sourceEntity, targetID, {
        reason: options.activeReason ?? "target",
        nowMs: options.nowMs,
        miningDepletionSourceEntityID: options.miningDepletionSourceEntityID,
        miningDepletionModuleID: options.miningDepletionModuleID,
      });
      const targetEntity = this.getEntityByID(targetID);
      if (!targetEntity) {
        continue;
      }
      ensureEntityTargetingState(targetEntity).targetedBy.delete(sourceID);
      if (
        notifyTarget &&
        targetEntity.session &&
        targetEntity.session !== sourceEntity.session
      ) {
        this.notifyTargetEvent(
          targetEntity.session,
          "otherlost",
          sourceID,
          options.activeReason ?? null,
        );
      }
    }

    if (notifySelf && clearedTargetIDs.length > 0 && sourceEntity && sourceEntity.session) {
      // With `selfClearReason` the clear names the pilot's ship and why, as Tranquility's does ('clear', ship,
      // 'WarpingOut'); without it, as before.
      if (options.selfClearReason) {
        this.notifyTargetEvent(sourceEntity.session, "clear", sourceID, options.selfClearReason);
      } else {
        this.notifyTargetEvent(sourceEntity.session, "clear");
      }
    }
    if (notifySelf && clearedTargetIDs.length > 0 && starbaseDefenseRuntime.isStarbaseBattery(sourceEntity)) {
      lazyRequire("../services/starbase/starbaseControlRuntime").notifyStarbaseTargetEvent(sourceEntity, "clear");
    }

    return {
      clearedTargetIDs,
      cancelledPendingIDs,
    };
  },

clearOutgoingTargetLocksExcept(sourceEntity, allowedTargetIDs, options = {}) {
    const sourceState = ensureEntityTargetingState(sourceEntity);
    if (!sourceState) {
      return {
        clearedTargetIDs: [],
        cancelledPendingIDs: [],
      };
    }

    const allowedTargetIDSet = new Set(
      [...(allowedTargetIDs instanceof Set ? allowedTargetIDs : [])]
        .map((targetID) => toInt(targetID, 0))
        .filter((targetID) => targetID > 0),
    );
    const notifySelf = options.notifySelf !== false;
    const notifyTarget = options.notifyTarget !== false;
    const cancelledPendingIDs = [];
    for (const pendingTargetID of [...sourceState.pendingTargetLocks.keys()]) {
      const normalizedTargetID = toInt(pendingTargetID, 0);
      if (normalizedTargetID <= 0 || allowedTargetIDSet.has(normalizedTargetID)) {
        continue;
      }
      if (this.cancelPendingTargetLock(sourceEntity, normalizedTargetID, {
        notifySelf,
        reason: options.pendingReason ?? TARGET_LOSS_REASON_ATTEMPT_CANCELLED,
        // ECM arrives asynchronously while the client may be maintaining both
        // an overview spinner and a world-space target bracket. The target
        // service failure closes the request lane; OnTarget "lost" closes the
        // state lane so neither presentation can remain stuck indefinitely.
        emitTargetLossEvent: true,
      })) {
        cancelledPendingIDs.push(normalizedTargetID);
      }
    }

    // A jam clears the victim's locks with one OnTargetClear(set of the
    // targets to keep), not a loss per target: TQ packs it into the event list
    // with OnCombatMessage('OnECMJamDefender', ...) ahead of OnJamStart (golden
    // log TheBlockadeLevel1), and the client clears every other target itself
    // (targetMgr.OnTargetClear).
    const targetClearEvent = options.targetClearEvent === true;
    const clearedTargetIDs = [];
    for (const targetID of this.getTargetsForEntity(sourceEntity)) {
      const normalizedTargetID = toInt(targetID, 0);
      if (normalizedTargetID <= 0 || allowedTargetIDSet.has(normalizedTargetID)) {
        continue;
      }
      if (this.removeLockedTarget(sourceEntity, normalizedTargetID, {
        notifySelf: targetClearEvent ? false : notifySelf,
        notifyTarget,
        reason: options.activeReason ?? "target",
        nowMs: options.nowMs,
      })) {
        clearedTargetIDs.push(normalizedTargetID);
      }
    }

    if (targetClearEvent && notifySelf && sourceEntity && sourceEntity.session) {
      queueDogmaEvent(sourceEntity.session, "OnTargetClear", [
        buildPythonSet([...allowedTargetIDSet]),
      ]);
      if (Array.isArray(options.combatMessage)) {
        queueDogmaEvent(sourceEntity.session, "OnCombatMessage", options.combatMessage);
      }
    }

    return {
      clearedTargetIDs,
      cancelledPendingIDs,
    };
  },

clearAllTargetingForEntity(entity, options = {}) {
    if (!entity) {
      return {
        clearedTargetIDs: [],
        cancelledPendingIDs: [],
      };
    }

    const reason = options.reason ?? TARGET_LOSS_REASON_ATTEMPT_CANCELLED;
    const outgoingResult = this.clearOutgoingTargetLocks(entity, {
      notifySelf: options.notifySelf !== false,
      notifyTarget: options.notifyTarget !== false,
      activeReason: reason === TARGET_LOSS_REASON_EXPLODING ? TARGET_LOSS_REASON_EXPLODING : null,
      pendingReason: reason,
      nowMs: options.nowMs,
      miningDepletionSourceEntityID: options.miningDepletionSourceEntityID,
      miningDepletionModuleID: options.miningDepletionModuleID,
    });

    const normalizedEntityID = toInt(entity.itemID, 0);
    const activeReason =
      reason === TARGET_LOSS_REASON_EXPLODING
        ? TARGET_LOSS_REASON_EXPLODING
        : null;
    for (const sourceEntity of this.dynamicEntities.values()) {
      if (!sourceEntity || toInt(sourceEntity.itemID, 0) === normalizedEntityID) {
        continue;
      }

      const sourceState = ensureEntityTargetingState(sourceEntity);
      if (!sourceState) {
        continue;
      }

      if (sourceState.pendingTargetLocks.has(normalizedEntityID)) {
        this.cancelPendingTargetLock(sourceEntity, normalizedEntityID, {
          notifySelf: true,
          reason,
        });
      }
      if (sourceState.lockedTargets.has(normalizedEntityID)) {
        this.removeLockedTarget(sourceEntity, normalizedEntityID, {
          notifySelf: true,
          notifyTarget: false,
          reason: activeReason,
          nowMs: options.nowMs,
          miningDepletionSourceEntityID: options.miningDepletionSourceEntityID,
          miningDepletionModuleID: options.miningDepletionModuleID,
        });
        continue;
      }

      // Destroyed targets must also stop any targeted module effect that still
      // points at them, even if the targeting map already drifted earlier.
      this.stopTargetedModuleEffects(sourceEntity, normalizedEntityID, {
        reason: activeReason,
        nowMs: options.nowMs,
        miningDepletionSourceEntityID: options.miningDepletionSourceEntityID,
        miningDepletionModuleID: options.miningDepletionModuleID,
      });
    }

    ensureEntityTargetingState(entity).targetedBy.clear();
    return outgoingResult;
  },

enforceEntityTargetCap(entity) {
    const state = ensureEntityTargetingState(entity);
    if (!state) {
      return;
    }
    if (state.lockedTargets.size === 0 && state.pendingTargetLocks.size === 0) {
      return;
    }

    const targetingStats = this.getEntityTargetingStats(entity);
    const maximumTargets = Math.max(
      0,
      toInt(
        targetingStats && targetingStats.effectiveMaxLockedTargets,
        0,
      ),
    );

    const pendingLocksDescending = [...state.pendingTargetLocks.values()].sort(
      (left, right) => toInt(right && right.sequence, 0) - toInt(left && left.sequence, 0),
    );
    while (
      state.lockedTargets.size + state.pendingTargetLocks.size > maximumTargets &&
      pendingLocksDescending.length > 0
    ) {
      const pendingLock = pendingLocksDescending.shift();
      if (!pendingLock || !state.pendingTargetLocks.has(pendingLock.targetID)) {
        continue;
      }
      this.cancelPendingTargetLock(entity, pendingLock.targetID, {
        notifySelf: true,
        reason: TARGET_LOSS_REASON_ATTEMPT_CANCELLED,
      });
    }

    const activeLocksDescending = [...state.lockedTargets.values()].sort(
      (left, right) => toInt(right && right.sequence, 0) - toInt(left && left.sequence, 0),
    );
    while (
      state.lockedTargets.size > maximumTargets &&
      activeLocksDescending.length > 0
    ) {
      const lockState = activeLocksDescending.shift();
      if (!lockState || !state.lockedTargets.has(lockState.targetID)) {
        continue;
      }
      this.removeLockedTarget(entity, lockState.targetID, {
        notifySelf: true,
        reason: null,
      });
    }
  },

validateEntityTargetLocks(entity, now = this.getCurrentSimTimeMs()) {
    const state = ensureEntityTargetingState(entity);
    if (!state) {
      return;
    }
    if (state.lockedTargets.size === 0 && state.pendingTargetLocks.size === 0) {
      return;
    }

    if (isEntityInActiveWarp(entity)) {
      this.clearOutgoingTargetLocks(entity, {
        notifySelf: true,
        notifyTarget: true,
        activeReason: null,
        pendingReason: TARGET_LOSS_REASON_ATTEMPT_CANCELLED,
        selfClearReason: TARGET_LOSS_REASON_WARPING_OUT,
      });
      return;
    }

    this.enforceEntityTargetCap(entity);

    for (const pendingLock of this.getSortedPendingTargetLocks(entity)) {
      if (!state.pendingTargetLocks.has(pendingLock.targetID)) {
        continue;
      }

      const targetEntity = this.getEntityByID(pendingLock.targetID);
      const validation = this.validateTargetLockRequest(
        entity.session,
        entity,
        targetEntity,
        {
          ignoreCapacity: true,
        },
      );
      if (!validation.success) {
        this.cancelPendingTargetLock(entity, pendingLock.targetID, {
          notifySelf: true,
          reason: TARGET_LOSS_REASON_ATTEMPT_CANCELLED,
        });
        continue;
      }

      const targetingStats = validation.data.targetingStats;
      if (state.lockedTargets.size >= targetingStats.effectiveMaxLockedTargets) {
        this.cancelPendingTargetLock(entity, pendingLock.targetID, {
          notifySelf: true,
          reason: TARGET_LOSS_REASON_ATTEMPT_CANCELLED,
        });
        continue;
      }

      if (toFiniteNumber(pendingLock.completeAtMs, 0) > now) {
        continue;
      }

      const finalizeResult = this.finalizeTargetLock(entity, targetEntity, {
        pendingLock,
        nowMs: now,
        suppressTargetNotice: pendingLock.suppressTargetNotice === true,
      });
      if (!finalizeResult.success) {
        this.cancelPendingTargetLock(entity, pendingLock.targetID, {
          notifySelf: true,
          reason: TARGET_LOSS_REASON_ATTEMPT_CANCELLED,
        });
      }
    }

    for (const targetID of this.getTargetsForEntity(entity)) {
      if (!state.lockedTargets.has(targetID)) {
        continue;
      }

      const targetEntity = this.getEntityByID(targetID);
      const validation = this.validateTargetLockRequest(
        entity.session,
        entity,
        targetEntity,
        {
          ignoreCapacity: true,
        },
      );
      if (!validation.success) {
        this.removeLockedTarget(entity, targetID, {
          notifySelf: true,
          reason:
            validation.errorMsg === "TARGET_NOT_FOUND"
              ? TARGET_LOSS_REASON_ATTEMPT_CANCELLED
              : null,
          // The ship gone into warp is told why ('otherlost', 'WarpingOut'); the locking ship's own 'lost' as before.
          targetNoticeReason:
            validation.errorMsg === "TARGET_WARPING" ? TARGET_LOSS_REASON_WARPING_OUT : undefined,
        });
      }
    }

    this.enforceEntityTargetCap(entity);
  },

validateAllTargetLocks(now = this.getCurrentSimTimeMs()) {
    for (const entity of this.dynamicEntities.values()) {
      if (
        !(entity && entity.lockedTargets instanceof Map && entity.lockedTargets.size > 0) &&
        !(entity && entity.pendingTargetLocks instanceof Map && entity.pendingTargetLocks.size > 0)
      ) {
        continue;
      }
      this.validateEntityTargetLocks(entity, now);
    }
  },

handleEntityTargetingAttributeChanges(entity, previousSnapshot, now = this.getCurrentSimTimeMs()) {
    if (!entity || !previousSnapshot) {
      return buildEntityTargetingAttributeSnapshot(entity);
    }

    const currentSnapshot = buildEntityTargetingAttributeSnapshot(entity);
    if (currentSnapshot.scanResolution !== previousSnapshot.scanResolution) {
      this.rebasePendingTargetLocksForSource(entity, now);
    }
    if (currentSnapshot.signatureRadius !== previousSnapshot.signatureRadius) {
      this.rebaseIncomingPendingTargetLocksForTarget(entity, now);
    }

    this.enforceEntityTargetCap(entity);
    this.validateEntityTargetLocks(entity, now);
    return currentSnapshot;
  },

addTarget(session, targetEntityID) {
    const sourceEntity = this.getShipEntityForSession(session);
    const targetEntity = this.getEntityByID(targetEntityID);
    const sourceState = ensureEntityTargetingState(sourceEntity);
    const normalizedTargetID = toInt(targetEntityID, 0);
    if (!sourceEntity || !sourceState) {
      return {
        success: false,
        errorMsg: "NOT_IN_SPACE",
      };
    }

    if (sourceState.lockedTargets.has(normalizedTargetID)) {
      return {
        success: true,
        data: {
          pending: false,
          targets: this.getTargetsForEntity(sourceEntity),
        },
      };
    }
    if (sourceState.pendingTargetLocks.has(normalizedTargetID)) {
      return {
        success: true,
        data: {
          pending: true,
          targets: this.getTargetsForEntity(sourceEntity),
        },
      };
    }

    breakEntityStructureTether(this, sourceEntity, {
      nowMs: this.getCurrentSimTimeMs(),
      reason: "TARGET_LOCK_ATTEMPT",
    });
    const validation = this.validateTargetLockRequest(session, sourceEntity, targetEntity);
    if (!validation.success) {
      return validation;
    }

    // A validated lock request gives up the grace. Keep this after validation
    // so malformed, missing, cross-scene, or otherwise rejected targets cannot
    // consume protection without committing a targeting action.
    breakEntityTimedInvulnerability(sourceEntity, { trigger: "targeting" });

    const now = this.getCurrentSimTimeMs();
    const lockDurationMs = computeTargetLockDurationMs(sourceEntity, targetEntity);
    if (lockDurationMs <= 1) {
      return this.finalizeTargetLock(sourceEntity, targetEntity, {
        nowMs: now,
      });
    }

    sourceState.pendingTargetLocks.set(normalizedTargetID, {
      targetID: normalizedTargetID,
      sequence: this.allocateTargetSequence(),
      requestedAtMs: now,
      completeAtMs: now + lockDurationMs,
      totalDurationMs: lockDurationMs,
    });
    require("../../../services/ship/safeLogoffRuntime").handleIncomingTarget(sourceEntity, targetEntity);

    return {
      success: true,
      data: {
        pending: true,
        targets: this.getTargetsForEntity(sourceEntity),
        lockDurationMs,
      },
    };
  },

// A lock a module asked for rather than the player: Auto Targeting Systems
  // sweeping hostiles, and Passive Targeters, which lock without telling the
  // ship they are pointed at. It is deliberately the same pipeline as
  // addTarget — same validation, same scan-resolution delay, same capacity —
  // so a module can never acquire something a manual lock would have refused.
  requestModuleTargetLock(sourceEntity, targetEntity, options = {}) {
    const sourceState = ensureEntityTargetingState(sourceEntity);
    if (!sourceState || !targetEntity) {
      return { success: false, errorMsg: "TARGET_NOT_FOUND" };
    }

    const targetID = toInt(targetEntity.itemID, 0);
    if (targetID <= 0) {
      return { success: false, errorMsg: "TARGET_NOT_FOUND" };
    }
    if (sourceState.lockedTargets.has(targetID)) {
      return { success: true, data: { pending: false, alreadyLocked: true } };
    }
    if (sourceState.pendingTargetLocks.has(targetID)) {
      return { success: true, data: { pending: true, alreadyLocked: false } };
    }

    const suppressTargetNotice = options.suppressTargetNotice === true;
    const validation = this.validateTargetLockRequest(
      sourceEntity.session || null,
      sourceEntity,
      targetEntity,
    );
    if (!validation.success) {
      return validation;
    }

    const now = toFiniteNumber(options.nowMs, this.getCurrentSimTimeMs());
    const lockDurationMs = computeTargetLockDurationMs(sourceEntity, targetEntity);
    if (lockDurationMs <= 1) {
      return this.finalizeTargetLock(sourceEntity, targetEntity, {
        nowMs: now,
        suppressTargetNotice,
      });
    }

    sourceState.pendingTargetLocks.set(targetID, {
      targetID,
      sequence: this.allocateTargetSequence(),
      requestedAtMs: now,
      completeAtMs: now + lockDurationMs,
      totalDurationMs: lockDurationMs,
      suppressTargetNotice,
    });
    require("../../../services/ship/safeLogoffRuntime").handleIncomingTarget(sourceEntity, targetEntity);

    return {
      success: true,
      data: { pending: true, lockDurationMs },
    };
  },

requestAutoTargetLock(sourceEntity, targetEntity, options = {}) {
    return this.requestModuleTargetLock(sourceEntity, targetEntity, {
      ...options,
      suppressTargetNotice: false,
    });
  },

cancelAddTarget(session, targetEntityID, options = {}) {
    const sourceEntity = this.getShipEntityForSession(session);
    if (!sourceEntity) {
      return {
        success: false,
        errorMsg: "NOT_IN_SPACE",
      };
    }

    const cancelled = this.cancelPendingTargetLock(sourceEntity, targetEntityID, {
      notifySelf: options.notifySelf === true,
      reason: options.reason ?? TARGET_LOSS_REASON_ATTEMPT_CANCELLED,
    });
    return {
      success: true,
      data: {
        cancelled,
        targets: this.getTargetsForEntity(sourceEntity),
      },
    };
  },

removeTarget(session, targetEntityID, options = {}) {
    const sourceEntity = this.getShipEntityForSession(session);
    if (!sourceEntity) {
      return {
        success: false,
        errorMsg: "NOT_IN_SPACE",
      };
    }

    const removed = this.removeLockedTarget(sourceEntity, targetEntityID, {
      notifySelf: options.notifySelf !== false,
      notifyTarget: options.notifyTarget !== false,
      reason: options.reason ?? null,
    });
    return {
      success: true,
      data: {
        removed,
        targets: this.getTargetsForEntity(sourceEntity),
      },
    };
  },

removeTargets(session, targetEntityIDs = [], options = {}) {
    const removedTargetIDs = [];
    for (const targetEntityID of targetEntityIDs) {
      const result = this.removeTarget(session, targetEntityID, options);
      if (result.success && result.data && result.data.removed) {
        removedTargetIDs.push(toInt(targetEntityID, 0));
      }
    }

    return {
      success: true,
      data: {
        removedTargetIDs,
      },
    };
  },

clearTargets(session, options = {}) {
    const sourceEntity = this.getShipEntityForSession(session);
    if (!sourceEntity) {
      return {
        success: false,
        errorMsg: "NOT_IN_SPACE",
      };
    }

    const result = this.clearOutgoingTargetLocks(sourceEntity, {
      notifySelf: options.notifySelf !== false,
      notifyTarget: options.notifyTarget !== false,
      activeReason: options.reason ?? null,
      pendingReason: TARGET_LOSS_REASON_ATTEMPT_CANCELLED,
    });
    return {
      success: true,
      data: result,
    };
  },

getTargets(session) {
    return this.getTargetsForEntity(this.getShipEntityForSession(session));
  },

getTargeters(session) {
    return this.getTargetersForEntity(this.getShipEntityForSession(session));
  },
};
