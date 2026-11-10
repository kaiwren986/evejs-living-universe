"use strict";

const runtimeEntryDirname = require("path").resolve(__dirname, "../..");
const path = require("path");
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
  canEntitiesInteractLocally,
  isSharedPveTarget,
  resolveEntityInteractionScope,
} = require(path.join(runtimeEntryDirname, "./destiny/identity/interactionScope.js"));
const gridBubbles = require(path.join(runtimeEntryDirname, "./destiny/visibility/gridBubbles.js"));
const {
  buildNonEnablingMassDemotionAction, // INTERIM: until Collision handling in Evolve
} = require(path.join(runtimeEntryDirname, "./destiny/stream/actions.js")); // INTERIM: until Collision handling in Evolve
const {
  buildCloakBallPresentationUpdates,
  buildCloakDeliveryPresentationUpdates,
  buildDbuffPresentationUpdates,
  buildOwnerUncloakPresentationUpdates,
  buildUncloakDeliveryPresentationUpdates,
} = require(path.join(
  runtimeEntryDirname,
  "./destiny/presentation/specialFxPayloads.js",
));
const {
  isReadyForDestiny,
} = require("../destinyDeliveryEligibility");
const {
  getOwningSessionForEntity,
} = require("../entityOwnerSession");
const {
  finalizeGenericModuleDeactivationWithoutSession,
} = require("../moduleEffectShutdown");
const {
  clamp,
  roundNumber,
  toFiniteNumber,
  toInt,
} = require("../../../common/numbers");
const {
  FILETIME_TICKS_PER_MS,
} = require("../runtimeClock");
const {
  resolveSessionNotificationFileTime,
} = require("../sessionNotificationTime");
const {
  queueDogmaEventPairs,
} = require("../dogmaEvents");
const {
  CLOAK_ACTIVATION_DBUFF_COLLECTION_ID,
  CLOAK_RENDER_EFFECT_DURATION_MS,
  CLOAK_RENDER_EFFECT_GUID,
  DEFAULT_CLOAK_STABILIZATION_DURATION_MS,
  DEFAULT_STARGATE_JUMP_CLOAK_DURATION_MS,
  DESTINY_CLOAK_MODE_NORMAL,
  MIN_CLOAKING_DISTANCE_METERS,
  UNCLOAK_RENDER_EFFECT_GUID,
  buildCloakModuleActivationDogmaEvents,
  clearStargateJumpCloakState,
  demoteEntityMassiveState,
  findActiveCloakingModuleEffectState,
  hasFiniteEntityPosition,
  isDecloakProximityExemptEntity,
  isEntityCloaked,
  isEntityNormalCloaked,
  isEntityRemoteDecloakImmune,
  isEntityStargateJumpCloaked,
  isEntityWarpBlockedByCloak,
  isEntityWarpSafeCloakedInFlight,
  restoreEntityMassiveState,
  setEntityCloakStabilizationState,
} = require("../shipCloak");
const {
  getShipDogmaMotionValue,
} = require("../pendingShipMotion");

module.exports = {

sendStargateJumpCloakUpdated(entity, options = {}) {
    const session =
      entity &&
      entity.session &&
      entity.session.socket &&
      !entity.session.socket.destroyed
        ? entity.session
        : getOwningSessionForEntity(this, entity);
    if (!session || typeof session.sendNotification !== "function") {
      return false;
    }

    const now = Math.max(
      0,
      toFiniteNumber(options.nowMs, this.getCurrentSimTimeMs()),
    );
    const durationMs = Math.max(
      0,
      toFiniteNumber(
        entity && entity.stargateJumpCloakDurationMs,
        DEFAULT_STARGATE_JUMP_CLOAK_DURATION_MS,
      ),
    );
    const untilMs = Math.max(
      now,
      toFiniteNumber(entity && entity.stargateJumpCloakUntilMs, now + durationMs),
    );
    const endTime = this.getCurrentSessionFileTime(session, untilMs);
    const duration = BigInt(Math.trunc(durationMs)) * FILETIME_TICKS_PER_MS;
    session.sendNotification("OnJumpCloakUpdated", "shipid", [
      toInt(entity && entity.itemID, 0),
      endTime,
      duration,
    ]);
    return true;
  },

sendStargateJumpCloakCancelled(entity) {
    const session =
      entity &&
      entity.session &&
      entity.session.socket &&
      !entity.session.socket.destroyed
        ? entity.session
        : getOwningSessionForEntity(this, entity);
    if (!session || typeof session.sendNotification !== "function") {
      return false;
    }

    session.sendNotification("OnJumpCloakCancelled", "shipid", [
      toInt(entity && entity.itemID, 0),
    ]);
    session.sendNotification("OnInvulnCancelled", "shipid", [
      toInt(entity && entity.itemID, 0),
    ]);
    return true;
  },

// The owner's Dogma events of a cloak device's activation (its
// OnGodmaShipEffect and the attribute changes, in the client's order),
// collected for the next doPostTick, and its cloak
// stabilization dbuff, a Gameplay event about its ship.
sendOwnerCloakActivationDogma(
    session,
    entity,
    effectState,
    options = {},
  ) {
    if (!session || !isReadyForDestiny(session) || !entity || !effectState) {
      return false;
    }

    const now = Math.max(
      0,
      toFiniteNumber(options.nowMs, this.getCurrentSimTimeMs()),
    );
    const previousMaxVelocity = toFiniteNumber(
      options.previousMaxVelocity,
      Number.NaN,
    );
    const dogmaEvents = buildCloakModuleActivationDogmaEvents(
      session,
      entity,
      effectState,
      {
        whenMs: now,
        startTimeMs: now,
        previousMaxVelocity,
        currentMaxVelocity: getShipDogmaMotionValue(entity, "maxVelocity"),
        duplicateMaxVelocity: true,
        previousCloakStabilizationStrength:
          options.previousCloakStabilizationStrength,
        currentCloakStabilizationStrength:
          options.currentCloakStabilizationStrength,
        repeatCurrentCloakStabilizationStrength: true,
      },
    );
    const dbuffExpiryFileTime = resolveSessionNotificationFileTime(
      session,
      now + DEFAULT_CLOAK_STABILIZATION_DURATION_MS,
    );
    this.queueBallHistory(
      entity,
      buildDbuffPresentationUpdates({
        stamp: this.historyStamp(),
        entityID: entity.itemID,
        dbuffState: [
          [CLOAK_ACTIVATION_DBUFF_COLLECTION_ID, [1.0, dbuffExpiryFileTime]],
        ],
      }),
    );
    queueDogmaEventPairs(session, dogmaEvents);
    return true;
  },

// The owner's new speed limit at a cloak device's activation: about the
// cloaked ship, so its owner only.
sendOwnerCloakActivationPresentation(
    session,
    entity,
    effectState,
  ) {
    if (!session || !isReadyForDestiny(session) || !entity || !effectState) {
      return false;
    }

    const entityID = toInt(entity.itemID, 0);
    if (entityID <= 0) {
      return false;
    }
    this.queueBallHistory(entity, buildOwnerUncloakPresentationUpdates({
      stamp: this.historyStamp(),
      entityID,
      includeRenderFx: false,
      maxSpeed: getShipDogmaMotionValue(entity, "maxVelocity"),
    }));
    return true;
  },

// A cloak, as retail reads it: one Ballpark action, queued
// at the call with the next stamp. doPreTick applies it with the list,
// before the bubble update, so that update lists the Ball nowhere: a Ball
// changing bubble is never added to its new bubble. The cloak effect, then
// CloakBall, go to the bubble the Ball was in when the cloak was asked for
// (retail's cloak_ball keeps the old bubble, _actions.py:600-639), routed
// after the update; every Observer of that bubble gets both in its bubble
// batch, the effect first. An owner whose own Ball's bubble is another one
// (it is the Ball changing bubble) gets both in its character history. A
// cloak undone before it applies (dropQueuedCloakChanges) sends neither.
// From then on what is queued about the Ball reaches only its owner
// (scene/destinyHistory.js). No spacing is put between the effect and the
// cloak (the published Destiny has none).
cloakEntity(entityOrID, options = {}) {
    const entity =
      entityOrID && typeof entityOrID === "object"
        ? entityOrID
        : this.getEntityByID(entityOrID);
    const entityID = toInt(entity && entity.itemID, 0);
    if (
      entityID <= 0 ||
      !(this.dynamicEntities instanceof Map) ||
      !this.dynamicEntities.has(entityID)
    ) {
      return {
        success: false,
        errorMsg: "DYNAMIC_ENTITY_NOT_FOUND",
      };
    }

    const cloakBubble = options.cloakBubble !== undefined
      ? options.cloakBubble
      : gridBubbles.committedBubbleOf(this.getGridBubbles(), getEntityMapKey(entityID));
    if (this.queueCloakChange(
      entity,
      () => this.cloakEntity(entity, {
        ...options,
        nowMs: undefined,
        cloakBubble,
      }),
    )) {
      return {
        success: true,
        queued: true,
        data: {
          entity,
        },
      };
    }

    const now = toFiniteNumber(options.nowMs, this.getCurrentSimTimeMs());
    const cloakMode = clamp(
      toInt(options.cloakMode, DESTINY_CLOAK_MODE_NORMAL),
      1,
      255,
    );
    const hasConfiguredUncloakRange =
      options.uncloakRange !== undefined ||
      options.uncloakRangeMeters !== undefined;
    const defaultUncloakRange =
      cloakMode === DESTINY_CLOAK_MODE_NORMAL
        ? MIN_CLOAKING_DISTANCE_METERS
        : 0;
    const configuredUncloakRange = hasConfiguredUncloakRange
      ? (options.uncloakRange ?? options.uncloakRangeMeters)
      : defaultUncloakRange;
    const uncloakRange = Math.max(
      0,
      toFiniteNumber(configuredUncloakRange, defaultUncloakRange),
    );
    // The bubble update after this cloak lists the Ball nowhere; an Observer
    // whose client was told about it and that leaves its bubble in the same
    // update still drops it (scene/visibility.js updateGridBubbles).
    if (!isEntityCloaked(entity)) {
      if (!(this._gridBubbleCloakedSinceUpdate instanceof Set)) {
        this._gridBubbleCloakedSinceUpdate = new Set();
      }
      this._gridBubbleCloakedSinceUpdate.add(getEntityMapKey(entityID));
    }
    // CloakBall's StopAllFollowers, before the Ball is cloaked: a
    // missile or an interactive orbiter flies on along its velocity, every
    // other follower stops; every client's CloakBall does the same.
    const followers = this.stopAllFollowers(entity);
    const redirectedFollowerIDs = followers.redirected;
    const stoppedFollowerIDs = followers.stopped;
    entity.isCloaked = cloakMode;
    entity.cloakMode = cloakMode;
    entity.cloaked = true;
    entity.uncloakRangeMeters = uncloakRange;
    const cloakStabilizationDurationMs =
      cloakMode === DESTINY_CLOAK_MODE_NORMAL
        ? Math.max(
            0,
            toFiniteNumber(
              options.cloakStabilizationDurationMs,
              DEFAULT_CLOAK_STABILIZATION_DURATION_MS,
            ),
          )
        : 0;
    setEntityCloakStabilizationState(
      entity,
      cloakStabilizationDurationMs > 0 ? now + cloakStabilizationDurationMs : 0,
      now,
    );
    // Carried to the uncloak, which is where the sensor recalibration starts.
    // Only a device cloak has one; a stargate jump cloak does not.
    entity.cloakTargetingDelayMs =
      cloakMode === DESTINY_CLOAK_MODE_NORMAL
        ? Math.max(0, toFiniteNumber(options.targetingDelayMs, 0))
        : 0;
    clearStargateJumpCloakState(entity);
    demoteEntityMassiveState(entity);

    const stamp = this.historyStamp();
    const hasCloakBubble = cloakBubble !== null && cloakBubble !== undefined;
    // The owner's batches this tick are its own Ball's bubble's, the one this
    // tick's bubble update commits for it: when that is not the cloak's
    // bubble, the owner hears of its cloak in its character history.
    const ownerSession = entity.session && isReadyForDestiny(entity.session)
      ? entity.session
      : null;
    const ownerOutsideCloakBubble = hasCloakBubble && ownerSession !== null &&
      this.getGridBubbleIDForSession(ownerSession) !== cloakBubble;
    if (options.cloakSpecialFx !== false) {
      const effectUpdates = buildCloakDeliveryPresentationUpdates({
        stamp,
        entityID,
        includeCloakBall: false,
        includeRenderFx: true,
        renderFxGuid: CLOAK_RENDER_EFFECT_GUID,
        renderFxOptions: {
          start: true,
          active: false,
          duration: CLOAK_RENDER_EFFECT_DURATION_MS,
        },
      });
      this.queueBallHistory(entity, effectUpdates, hasCloakBubble ? { bubble: cloakBubble } : {});
      if (ownerOutsideCloakBubble) {
        this.queueCharacterHistory(ownerSession, effectUpdates);
      }
    }
    const cloakBallUpdates = buildCloakBallPresentationUpdates({
      stamp,
      entityID,
      cloakMode,
      uncloakRange,
    });
    let deliveredCount = 0;
    if (hasCloakBubble) {
      this.queueBallHistory(entity, cloakBallUpdates, { bubble: cloakBubble });
      deliveredCount = this.listDestinyBatchObservers()
        .filter((observer) => observer.bubble === cloakBubble).length;
      if (ownerOutsideCloakBubble && this.queueCharacterHistory(ownerSession, cloakBallUpdates) !== null) {
        deliveredCount += 1;
      }
    } else if (entity.session && this.queueCharacterHistory(entity.session, cloakBallUpdates) !== null) {
      // A Ball no Observer was told about yet: only its owner has it.
      deliveredCount = 1;
    }
    if (options.ownerSetMaxSpeed === true) {
      this.queueBallHistory(entity, buildOwnerUncloakPresentationUpdates({
        stamp,
        entityID,
        includeRenderFx: false,
        maxSpeed: getShipDogmaMotionValue(entity, "maxVelocity"),
      }));
    }

    return {
      success: true,
      data: {
        entity,
        cloakMode,
        uncloakRange,
        cloakStabilizationUntilMs: entity.cloakStabilizationUntilMs || 0,
        deliveredCount,
        redirectedFollowerIDs,
        stoppedFollowerIDs,
      },
    };
  },

// An uncloak, as retail reads it (_ticker.py:138-162): its
// owner gets UncloakBall in its character history; every other Observer
// whose client is told about the Ball's Grid bubble gets the Ball back as
// an AddBallsToPark at the front of its character history, and no
// UncloakBall; the uncloak effect goes to the bubble's history at the same
// stamp, so every Observer applies it after the add.
uncloakEntity(entityOrID, options = {}) {
    const entity =
      entityOrID && typeof entityOrID === "object"
        ? entityOrID
        : this.getEntityByID(entityOrID);
    const entityID = toInt(entity && entity.itemID, 0);
    if (
      entityID <= 0 ||
      !(this.dynamicEntities instanceof Map) ||
      !this.dynamicEntities.has(entityID)
    ) {
      return {
        success: false,
        errorMsg: "DYNAMIC_ENTITY_NOT_FOUND",
      };
    }

    // Uncloaking before a queued cloak applied undoes the cloak instead.
    if (this.dropQueuedCloakChanges(entity) > 0 && !isEntityCloaked(entity)) {
      return {
        success: true,
        data: {
          entity,
          cancelledQueuedCloak: true,
        },
      };
    }

    const now = toFiniteNumber(options.nowMs, this.getCurrentSimTimeMs());
    const wasCloaked = isEntityCloaked(entity);
    const wasNormalCloaked = isEntityNormalCloaked(entity);
    const wasStargateJumpCloaked = isEntityStargateJumpCloaked(entity);
    entity.isCloaked = 0;
    entity.cloakMode = 0;
    entity.cloaked = false;
    entity.uncloakRangeMeters = 0;
    // The cloak made the Ball non-massive (CloakBall); UncloakBall makes it
    // massive again, or no missile could hit it again.
    restoreEntityMassiveState(entity);
    setEntityCloakStabilizationState(entity, 0, now);
    // The sensor recalibration starts here, on every way a device cloak can
    // end: switched off, decloaked by proximity, or pinged off by a Mobile
    // Observatory. A stargate jump cloak carries no delay.
    const cloakTargetingDelayMs = Math.max(
      0,
      toFiniteNumber(entity.cloakTargetingDelayMs, 0),
    );
    entity.cloakTargetingDelayMs = 0;
    if (wasNormalCloaked && !wasStargateJumpCloaked && cloakTargetingDelayMs > 0) {
      entity.decloakTargetingBlockedUntilMs = now + cloakTargetingDelayMs;
    }
    clearStargateJumpCloakState(entity);

    const stamp = this.historyStamp();
    let ownerDelivered = false;
    const ownerSession =
      entity.session && isReadyForDestiny(entity.session)
        ? entity.session
        : null;
    if (ownerSession) {
      this.queueCharacterHistory(ownerSession, buildUncloakDeliveryPresentationUpdates({
        stamp,
        entityID,
        includeRenderFx: false,
        includeMaxSpeed: options.ownerSetMaxSpeed === true,
        maxSpeed: getShipDogmaMotionValue(entity, "maxVelocity"),
      }));
      // INTERIM: until Collision handling in Evolve. The
      // INTERIM: client's UncloakBall makes the ship massive (carbon-
      // INTERIM: destiny v2.1.1 Ballpark.cpp L5280) and it would
      // INTERIM: bounce off a station Server flies it through; the
      // INTERIM: demotion right after it, on its stamp, keeps it light.
      if (entity.kind === "ship") { // INTERIM: until Collision handling in Evolve
        this.queueCharacterHistory(ownerSession, [{ stamp, payload: buildNonEnablingMassDemotionAction(entityID) }]); // INTERIM: until Collision handling in Evolve
      } // INTERIM: until Collision handling in Evolve
      ownerDelivered = true;
    }

    // The others' AddBallsToPark, in front of their character histories.
    const acquireResult = this.acquireDynamicEntitiesForRelevantSessions(
      [entity],
      {
        nowMs: now,
      },
    );
    if (options.uncloakSpecialFx !== false && options.ownerUncloakSpecialFx !== false) {
      this.queueBallHistory(entity, buildCloakDeliveryPresentationUpdates({
        stamp,
        entityID,
        includeCloakBall: false,
        includeRenderFx: true,
        renderFxGuid: UNCLOAK_RENDER_EFFECT_GUID,
        renderFxOptions: {
          start: true,
          active: false,
          duration: CLOAK_RENDER_EFFECT_DURATION_MS,
        },
      }));
    }
    let jumpCloakCancelNotified = false;
    if (
      wasStargateJumpCloaked &&
      options.notifyJumpCloakCancelled !== false
    ) {
      jumpCloakCancelNotified = this.sendStargateJumpCloakCancelled(entity);
    }

    return {
      success: true,
      data: {
        entity,
        wasCloaked,
        wasStargateJumpCloaked,
        jumpCloakCancelNotified,
        ownerDelivered,
        observerDeliveredSessionCount:
          acquireResult && acquireResult.deliveredSessionCount
            ? acquireResult.deliveredSessionCount
            : 0,
        observerDeliveredEntityCount:
          acquireResult && acquireResult.deliveredEntityCount
            ? acquireResult.deliveredEntityCount
            : 0,
      },
    };
  },

notifyCloakModuleForceDeactivated(
    entity,
    triggerEntity,
    surfaceDistanceMeters,
    reason = "proximity",
    options = {},
  ) {
    const session =
      entity && entity.session && isReadyForDestiny(entity.session)
        ? entity.session
        : getOwningSessionForEntity(this, entity);
    if (!session || typeof session.sendNotification !== "function") {
      return false;
    }

    const normalizedReason = String(reason || "proximity");
    if (normalizedReason === "proximity") {
      session.sendNotification("OnCloakModuleForceDeactivated", "shipid", [
        "CloakDeactivatedByProximityToType",
        {
          type: "dict",
          entries: [
            ["proximityTypeID", toInt(triggerEntity && triggerEntity.typeID, 0)],
          ],
        },
      ]);
      return true;
    }

    const triggerName = String(
      (triggerEntity && (
        triggerEntity.itemName ||
        triggerEntity.typeName ||
        triggerEntity.groupName
      )) ||
        "an object",
    );
    session.sendNotification("OnCloakModuleForceDeactivated", "shipid", [
      "CustomNotify",
      {
        type: "dict",
        entries: [
          [
            "notify",
            options.notifyText ||
              `Your cloak has been deactivated because ${triggerName} came within ` +
                `${MIN_CLOAKING_DISTANCE_METERS} meters.`,
          ],
          ["decloakReason", normalizedReason],
          ["itemID", toInt(triggerEntity && triggerEntity.itemID, 0)],
          [
            "distanceMeters",
            roundNumber(
              Math.max(0, toFiniteNumber(surfaceDistanceMeters, 0)),
              3,
            ),
          ],
        ],
      },
    ]);
    return true;
  },

findCloakProximityTrigger(
    entity,
    rangeMeters = MIN_CLOAKING_DISTANCE_METERS,
  ) {
    const entityID = toInt(entity && entity.itemID, 0);
    if (
      entityID <= 0 ||
      !hasFiniteEntityPosition(entity)
    ) {
      return null;
    }

    const range = Math.max(
      0,
      toFiniteNumber(rangeMeters, MIN_CLOAKING_DISTANCE_METERS),
    );
    if (range <= 0) {
      return null;
    }

    // Only the cloaked Ball's own Grid bubble is scanned.
    const bubbleID = this.getGridBubbleIDForEntity(entity);
    const candidates = bubbleID === null
      ? []
      : this.getEntitiesInGridBubble(bubbleID);
    let bestTrigger = null;
    let bestSurfaceDistance = Infinity;
    for (const candidate of candidates) {
      const candidateID = toInt(candidate && candidate.itemID, 0);
      if (
        candidateID <= 0 ||
        candidateID === entityID ||
        !hasFiniteEntityPosition(candidate) ||
        isDecloakProximityExemptEntity(candidate) ||
        !canEntitiesInteractLocally(entity, candidate)
      ) {
        continue;
      }

      const surfaceDistance = this.getEntitySurfaceDistance(entity, candidate);
      if (
        surfaceDistance <= range &&
        surfaceDistance < bestSurfaceDistance
      ) {
        bestTrigger = candidate;
        bestSurfaceDistance = surfaceDistance;
      }
    }

    if (!bestTrigger) {
      return null;
    }

    return {
      triggerEntity: bestTrigger,
      surfaceDistanceMeters: bestSurfaceDistance,
      rangeMeters: range,
    };
  },

isEntityWarpBlockedByCloak(entity) {
    return isEntityWarpBlockedByCloak(entity);
  },

findNormalCloakProximityTrigger(entity) {
    if (!isEntityNormalCloaked(entity)) {
      return null;
    }
    if (isEntityWarpSafeCloakedInFlight(entity)) {
      return null;
    }

    const uncloakRange = Math.max(
      0,
      toFiniteNumber(entity && entity.uncloakRangeMeters, 0),
    );
    return this.findCloakProximityTrigger(entity, uncloakRange);
  },

forceDecloakEntity(entityOrID, triggerEntity = null, options = {}) {
    const entity =
      entityOrID && typeof entityOrID === "object"
        ? entityOrID
        : this.getEntityByID(entityOrID);
    const entityID = toInt(entity && entity.itemID, 0);
    if (entityID <= 0 || !isEntityCloaked(entity)) {
      return {
        success: false,
        errorMsg: "ENTITY_NOT_CLOAKED",
      };
    }

    const now = toFiniteNumber(options.nowMs, this.getCurrentSimTimeMs());
    const reason = String(options.reason || "forced");
    const activeCloakEffect = findActiveCloakingModuleEffectState(entity);
    const ownerSession =
      entity && entity.session && isReadyForDestiny(entity.session)
        ? entity.session
        : getOwningSessionForEntity(this, entity);
    let moduleDeactivated = false;
    let uncloakResult = null;
    let notified = false;
    if (options.notify !== false && reason === "proximity") {
      notified = this.notifyCloakModuleForceDeactivated(
        entity,
        triggerEntity,
        toFiniteNumber(options.surfaceDistanceMeters, 0),
        reason,
        {
          notifyText: options.notifyText,
        },
      );
    }
    if (activeCloakEffect && ownerSession) {
      uncloakResult = this.finalizeGenericModuleDeactivation(
        ownerSession,
        activeCloakEffect.moduleID,
        {
          reason,
          nowMs: now,
        },
      );
      moduleDeactivated = Boolean(uncloakResult && uncloakResult.success);
    } else if (activeCloakEffect) {
      const deactivateResult = finalizeGenericModuleDeactivationWithoutSession(
        this,
        entity,
        activeCloakEffect,
        {
          reason,
          nowMs: now,
        },
      );
      moduleDeactivated = Boolean(deactivateResult && deactivateResult.success);
      uncloakResult = isEntityCloaked(entity)
        ? this.uncloakEntity(entity, { nowMs: now })
        : deactivateResult;
    } else {
      uncloakResult = this.uncloakEntity(entity, {
        nowMs: now,
      });
    }

    if (!uncloakResult || !uncloakResult.success) {
      return uncloakResult || {
        success: false,
        errorMsg: "DECLOAK_FAILED",
      };
    }

    if (options.notify !== false && !notified) {
      notified = this.notifyCloakModuleForceDeactivated(
        entity,
        triggerEntity,
        toFiniteNumber(options.surfaceDistanceMeters, 0),
        reason,
        {
          notifyText: options.notifyText,
        },
      );
    }

    return {
      success: true,
      data: {
        entityID,
        triggerEntityID: toInt(triggerEntity && triggerEntity.itemID, 0),
        moduleDeactivated,
        notified,
        reason,
      },
    };
  },

processEntityCloakProximityDecloak(entity, nowMs = this.getCurrentSimTimeMs()) {
    if (!isEntityNormalCloaked(entity)) {
      return null;
    }
    const now = toFiniteNumber(nowMs, this.getCurrentSimTimeMs());
    const trigger = this.findNormalCloakProximityTrigger(entity);
    if (!trigger) {
      return null;
    }

    const activeCloakEffect = findActiveCloakingModuleEffectState(entity);
    const ownerSession =
      entity && entity.session && isReadyForDestiny(entity.session)
        ? entity.session
        : getOwningSessionForEntity(this, entity);
    let moduleDeactivated = false;
    let uncloakResult = null;
    const notified = this.notifyCloakModuleForceDeactivated(
      entity,
      trigger.triggerEntity,
      trigger.surfaceDistanceMeters,
      "proximity",
    );
    if (activeCloakEffect && ownerSession) {
      uncloakResult = this.finalizeGenericModuleDeactivation(
        ownerSession,
        activeCloakEffect.moduleID,
        {
          reason: "proximity",
          nowMs: now,
        },
      );
      moduleDeactivated = Boolean(uncloakResult && uncloakResult.success);
    } else {
      uncloakResult = this.uncloakEntity(entity, {
        nowMs: now,
      });
    }
    if (!uncloakResult || !uncloakResult.success) {
      return null;
    }

    return {
      entityID: toInt(entity && entity.itemID, 0),
      triggerEntityID: toInt(
        trigger.triggerEntity && trigger.triggerEntity.itemID,
        0,
      ),
      surfaceDistanceMeters: trigger.surfaceDistanceMeters,
      rangeMeters: trigger.rangeMeters,
      moduleDeactivated,
      notified,
    };
  },

processSessionShipCloakProximityDecloak(session, nowMs = this.getCurrentSimTimeMs()) {
    const entity = this.getShipEntityForSession(session);
    return this.processEntityCloakProximityDecloak(entity, nowMs);
  },

processRemoteDecloakPing(triggerEntity = null, options = {}) {
    if (!(this.dynamicEntities instanceof Map) || this.dynamicEntities.size === 0) {
      return {
        candidateEntityIDs: [],
        immuneEntityIDs: [],
        decloakedEntityIDs: [],
        events: [],
      };
    }

    const now = toFiniteNumber(options.nowMs, this.getCurrentSimTimeMs());
    const probability = clamp(toFiniteNumber(options.probability, 1), 0, 1);
    const randomFn = typeof options.randomFn === "function"
      ? options.randomFn
      : Math.random;
    const triggerEntityID = toInt(triggerEntity && triggerEntity.itemID, 0);
    const reason = String(options.reason || "remoteDecloakPing");
    const notifyText =
      options.notifyText ||
      "Your cloak has been deactivated by a Mobile Observatory decloaking ping.";
    const candidateEntityIDs = [];
    const immuneEntityIDs = [];
    const decloakedEntityIDs = [];
    const events = [];

    for (const entity of [...this.dynamicEntities.values()]) {
      const entityID = toInt(entity && entity.itemID, 0);
      if (
        entityID <= 0 ||
        entityID === triggerEntityID ||
        !isEntityNormalCloaked(entity)
      ) {
        continue;
      }

      candidateEntityIDs.push(entityID);
      if (isEntityRemoteDecloakImmune(entity, now)) {
        immuneEntityIDs.push(entityID);
        continue;
      }
      const roll = clamp(toFiniteNumber(randomFn(), 0), 0, 1);
      if (probability < 1 && roll >= probability) {
        continue;
      }

      const result = this.forceDecloakEntity(entity, triggerEntity, {
        nowMs: now,
        reason,
        notifyText,
        surfaceDistanceMeters: 0,
      });
      if (!result || !result.success) {
        continue;
      }
      const event = {
        entityID,
        triggerEntityID,
        moduleDeactivated: Boolean(result.data && result.data.moduleDeactivated),
        notified: Boolean(result.data && result.data.notified),
        reason,
      };
      decloakedEntityIDs.push(entityID);
      events.push(event);
    }

    return {
      candidateEntityIDs,
      immuneEntityIDs,
      decloakedEntityIDs,
      events,
    };
  },

processCloakProximityDecloaks(nowMs = this.getCurrentSimTimeMs()) {
    if (!(this.dynamicEntities instanceof Map) || this.dynamicEntities.size === 0) {
      return {
        decloakedEntityIDs: [],
        events: [],
      };
    }

    const now = toFiniteNumber(nowMs, this.getCurrentSimTimeMs());
    const candidates = [...this.dynamicEntities.values()]
      .filter((entity) => isEntityNormalCloaked(entity));
    const decloakedEntityIDs = [];
    const events = [];
    for (const entity of candidates) {
      const event = this.processEntityCloakProximityDecloak(entity, now);
      if (!event) {
        continue;
      }

      decloakedEntityIDs.push(event.entityID);
      events.push(event);
    }

    return {
      decloakedEntityIDs,
      events,
    };
  },

cancelStargateJumpCloak(entityOrSession, reason = "cancelled", options = {}) {
    const entity =
      entityOrSession && entityOrSession._space
        ? this.getShipEntityForSession(entityOrSession)
        : (
            entityOrSession && typeof entityOrSession === "object"
              ? entityOrSession
              : this.getEntityByID(entityOrSession)
          );
    if (!isEntityStargateJumpCloaked(entity)) {
      return {
        success: false,
        errorMsg: "JUMP_CLOAK_NOT_ACTIVE",
      };
    }

    const result = this.uncloakEntity(entity, {
      nowMs: options.nowMs ?? this.getCurrentSimTimeMs(),
      reason,
      ownerUncloakSpecialFx: options.ownerUncloakSpecialFx !== false,
    });
    if (result && result.success && result.data) {
      result.data.reason = String(reason || "cancelled");
    }
    return result;
  },

processStargateJumpCloakExpirations(nowMs = this.getCurrentSimTimeMs()) {
    if (!(this.dynamicEntities instanceof Map) || this.dynamicEntities.size === 0) {
      return {
        expiredEntityIDs: [],
      };
    }

    const now = Math.max(0, toFiniteNumber(nowMs, this.getCurrentSimTimeMs()));
    const expiredEntityIDs = [];
    for (const entity of [...this.dynamicEntities.values()]) {
      if (!isEntityStargateJumpCloaked(entity)) {
        continue;
      }
      const untilMs = toFiniteNumber(entity.stargateJumpCloakUntilMs, 0);
      if (untilMs <= 0 || now < untilMs) {
        continue;
      }
      const result = this.cancelStargateJumpCloak(entity, "expired", {
        nowMs: now,
      });
      if (result && result.success) {
        expiredEntityIDs.push(toInt(entity.itemID, 0));
      }
    }

    return {
      expiredEntityIDs,
    };
  },
};
