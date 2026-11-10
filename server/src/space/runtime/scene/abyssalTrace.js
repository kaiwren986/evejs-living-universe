"use strict";

const runtimeEntryDirname = require("path").resolve(__dirname, "../..");
const path = require("path");
const log = require(path.join(runtimeEntryDirname, "../utils/logger"));
const {
  ABYSSAL_TRACE_LIFECYCLE_PHASE,
  applyAbyssalTraceProfileToEntity,
  resolveAbyssalTraceProfile,
} = require("../../../abyssal").engineSupport.traceProfiles;
const {
  buildAbyssalTraceSessionIdentity,
  getAbyssalTracePublicationReceiptMap,
  getAbyssalTracePublicationReceipt,
  buildAbyssalTracePublicationReceipt,
  storeAbyssalTracePublicationReceipt,
  abyssalTracePublicationReceiptMatchesSession,
} = require("../../../abyssal").engineSupport.tracePublicationReceipts;
const destiny = require(path.join(runtimeEntryDirname, "./destiny/index.js"));
const {
  canSessionReceiveEntityDependentDestinyUpdate,
  isReadyForDestiny,
  sessionMatchesIdentity,
} = require("../destinyDeliveryEligibility");
const {
  roundNumber,
  toFiniteNumber,
  toInt,
} = require("../../../common/numbers");
const {
  logBubbleDebug,
} = require("../runtimeDebugInstrumentation");
const {
  SCENE_KIND_SOLAR_SYSTEM,
  buildSolarSystemSceneKey,
  getSceneKeyForSession,
  normalizeSceneText,
} = require("../sceneIdentity");

module.exports = {

evaluateAbyssalSourceTraceVisibility(
    session,
    entity,
    now = this.getCurrentSimTimeMs(),
    options = {},
  ) {
    const sourceTraceRole = normalizeSceneText(
      entity && entity.evejsAbyssalTraceRole,
      "",
    );
    if (
      !entity ||
      entity.evejsAbyssalTrace !== true ||
      sourceTraceRole !== "source-kspace-trace"
    ) {
      return null;
    }

    const traceItemID = toInt(entity.itemID, 0);
    const sourceSolarSystemID = toInt(
      entity.evejsAbyssalTraceSourceSolarSystemID,
      0,
    );
    const sourceSceneKey = normalizeSceneText(
      entity.evejsAbyssalTraceSourceSceneKey,
      "",
    );
    const sessionSceneKey = getSceneKeyForSession(session);
    const sessionSystemID = toInt(session && session._space && session._space.systemID, 0);
    const traceBubbleID = toInt(entity.bubbleID, 0);
    const egoEntity = this.getShipEntityForSession(session);
    const egoBubbleID = toInt(egoEntity && egoEntity.bubbleID, 0);
    const lifecyclePhase = normalizeSceneText(
      entity.evejsAbyssalTraceLifecyclePhase,
      "",
    ).toLowerCase();
    const lifecycleVisible =
      lifecyclePhase === ABYSSAL_TRACE_LIFECYCLE_PHASE.CREATED ||
      lifecyclePhase === ABYSSAL_TRACE_LIFECYCLE_PHASE.ACTIVE ||
      lifecyclePhase === ABYSSAL_TRACE_LIFECYCLE_PHASE.RETURNED;
    const expiresAtMs = toFiniteNumber(entity.expiresAtMs, 0);
    const unexpired = expiresAtMs <= 0 || expiresAtMs > toFiniteNumber(now, 0);
    const persistedIdentityValid = Boolean(
      entity.evejsAbyssalTracePersistedIdentityValid === true &&
      traceItemID > 0 &&
      traceItemID === toInt(entity.traceItemID, 0) &&
      traceItemID === toInt(entity.evejsAbyssalTraceItemID, 0) &&
      traceItemID === toInt(entity.evejsAbyssalTracePersistedItemID, 0) &&
      (
        toInt(entity.evejsAbyssalTracePersistedLocationID, 0) <= 0 ||
        toInt(entity.evejsAbyssalTracePersistedLocationID, 0) ===
          sourceSolarSystemID
      ) &&
      entity.persistSpaceState === true
    );
    const runtimeEntityCurrent = Boolean(
      traceItemID > 0 &&
      this.dynamicEntities instanceof Map &&
      this.dynamicEntities.get(traceItemID) === entity
    );
    const sourceSceneValid = Boolean(
      this.sceneKind === SCENE_KIND_SOLAR_SYSTEM &&
      sourceSolarSystemID > 0 &&
      sourceSolarSystemID === toInt(this.systemID, 0) &&
      sourceSceneKey === this.sceneKey &&
      sourceSceneKey === buildSolarSystemSceneKey(sourceSolarSystemID) &&
      entity.sceneKey === this.sceneKey &&
      toInt(entity.systemID, 0) === sourceSolarSystemID
    );
    const sameScene = Boolean(
      sourceSceneValid &&
      sessionSceneKey === sourceSceneKey &&
      (sessionSystemID <= 0 || sessionSystemID === sourceSolarSystemID)
    );
    const sameBubble = Boolean(
      sameScene &&
      egoEntity &&
      egoBubbleID > 0 &&
      traceBubbleID > 0 &&
      egoBubbleID === traceBubbleID
    );
    const currentAcquired = this.canSessionSeeDynamicEntity(session, entity);

    let reason = "source-trace-same-bubble";
    if (!persistedIdentityValid) {
      reason = "invalid-persisted-trace-identity";
    } else if (!runtimeEntityCurrent) {
      reason = "trace-not-current-runtime-entity";
    } else if (!sourceSceneValid) {
      reason = "invalid-source-scene";
    } else if (!sameScene) {
      reason = "session-left-source-scene";
    } else if (!lifecycleVisible) {
      reason = "trace-lifecycle-not-visible";
    } else if (!unexpired) {
      reason = "trace-expired";
    } else if (!sameBubble) {
      reason = "session-left-trace-bubble";
    }

    return {
      sourceTraceOverride: true,
      traceItemID,
      sourceTraceRole,
      sourceSolarSystemID,
      sourceSceneKey,
      sessionSceneKey,
      sessionSystemID,
      traceBubbleID,
      egoBubbleID,
      lifecyclePhase,
      lifecycleVisible,
      expiresAtMs,
      unexpired,
      persistedIdentityValid,
      runtimeEntityCurrent,
      sourceSceneValid,
      sameScene,
      sameBubble,
      currentAcquired,
      sourceTraceVisible: Boolean(
        persistedIdentityValid &&
        runtimeEntityCurrent &&
        sourceSceneValid &&
        sameScene &&
        lifecycleVisible &&
        unexpired &&
        sameBubble
      ),
      reason,
    };
  },

logAbyssalSourceTraceVisibilityAction(
    session,
    entity,
    decision,
    action,
    now = this.getCurrentSimTimeMs(),
  ) {
    if (!decision || decision.sourceTraceOverride !== true) {
      return;
    }
    const details = {
      systemID: toInt(this.systemID, 0),
      sceneKey: this.sceneKey,
      sessionCharacterID: toInt(session && session.characterID, 0),
      sessionShipID: toInt(session && session._space && session._space.shipID, 0),
      traceItemID: toInt(entity && entity.itemID, 0),
      traceTypeID: toInt(entity && entity.typeID, 0),
      traceGroupID: toInt(entity && (entity.slimGroupID ?? entity.groupID), 0),
      traceOwnerID: toInt(entity && entity.ownerID, 0),
      traceActivationState: toInt(entity && entity.activationState, -1),
      traceProfileID: normalizeSceneText(entity && entity.evejsAbyssalTraceProfileID, ""),
      lifecyclePhase: decision.lifecyclePhase,
      sourceTraceRole: decision.sourceTraceRole,
      sourceSolarSystemID: decision.sourceSolarSystemID,
      sourceSceneKey: decision.sourceSceneKey,
      sessionSceneKey: decision.sessionSceneKey,
      traceBubbleID: decision.traceBubbleID,
      egoBubbleID: decision.egoBubbleID,
      currentAcquired: decision.currentAcquired,
      desiredVisible: decision.desiredVisible,
      action: normalizeSceneText(action, "none"),
      reason: decision.reason,
      nowMs: roundNumber(toFiniteNumber(now, 0), 3),
    };
    logBubbleDebug("abyssal_trace.visibility_action", details);
    log.debug(
      `[AbyssalTraceVisibility] trace=${details.traceItemID} ` +
        `profile=${details.traceProfileID || "none"} phase=${details.lifecyclePhase || "none"} ` +
        `scene=${details.sceneKey} sourceScene=${details.sourceSceneKey || "none"} ` +
        `traceBubble=${details.traceBubbleID} egoBubble=${details.egoBubbleID} ` +
        `acquired=${details.currentAcquired} desired=${details.desiredVisible} ` +
        `action=${details.action} reason=${details.reason}`,
    );
  },

publishAbyssalTraceInitial(traceItemID, options = {}) {
    const numericTraceItemID = toInt(traceItemID, 0);
    const traceEntity = this.getEntityByID(numericTraceItemID);
    if (!traceEntity || traceEntity.evejsAbyssalTrace !== true) {
      return {
        success: false,
        errorMsg: "ABYSSAL_TRACE_ENTITY_MISSING",
        data: null,
      };
    }

    const slimEntries = destiny.buildSlimItemDict(traceEntity).entries;
    const slimByName = new Map(slimEntries.map(([name, value]) => [String(name), value]));
    const slimMetadata = {
      itemID: toInt(slimByName.get("itemID"), 0),
      typeID: toInt(slimByName.get("typeID"), 0),
      groupID: toInt(slimByName.get("groupID"), 0),
      ownerID: toInt(slimByName.get("ownerID"), 0),
      activationState: toInt(slimByName.get("activationState"), -1),
    };
    const expectedSlimMetadata = {
      itemID: numericTraceItemID,
      typeID: toInt(options.expectedTypeID, toInt(traceEntity.typeID, 0)),
      groupID: toInt(options.expectedGroupID, toInt(traceEntity.slimGroupID, 0)),
      ownerID: toInt(options.expectedOwnerID, toInt(traceEntity.ownerID, 0)),
      activationState: toInt(
        options.expectedActivationState,
        toInt(traceEntity.activationState, -1),
      ),
    };
    if (
      slimMetadata.itemID !== expectedSlimMetadata.itemID ||
      slimMetadata.typeID !== expectedSlimMetadata.typeID ||
      slimMetadata.groupID !== expectedSlimMetadata.groupID ||
      slimMetadata.ownerID !== expectedSlimMetadata.ownerID ||
      slimMetadata.activationState !== expectedSlimMetadata.activationState ||
      toInt(traceEntity.traceItemID, 0) !== numericTraceItemID
    ) {
      return {
        success: false,
        errorMsg: "ABYSSAL_TRACE_INITIAL_SLIM_INVALID",
        data: {
          traceItemID: numericTraceItemID,
          sourceBubbleID: toInt(traceEntity.bubbleID, 0),
          slimMetadata,
          expectedSlimMetadata,
          failures: ["INITIAL_SLIM_METADATA_MISMATCH"],
        },
      };
    }

    const sourceBubbleID = toInt(traceEntity.bubbleID, 0);
    if (sourceBubbleID <= 0) {
      return {
        success: false,
        errorMsg: "ABYSSAL_TRACE_BUBBLE_MISSING",
        data: {
          traceItemID: numericTraceItemID,
          sourceBubbleID,
          slimMetadata,
          failures: ["TRACE_BUBBLE_MISSING"],
        },
      };
    }

    const requiredCharacterID = toInt(options.requiredCharacterID, 0);
    const targetSession = options.targetSession || null;
    const preferredActorSession = options.actorSession || null;
    const actorSession = Array.from(this.sessions.values()).find((session) => (
      (!preferredActorSession || sessionMatchesIdentity(session, preferredActorSession)) &&
      (!targetSession || sessionMatchesIdentity(session, targetSession)) &&
      (
        requiredCharacterID <= 0 ||
        toInt(session && session.characterID, 0) === requiredCharacterID
      )
    )) || null;
    const actorReady = requiredCharacterID <= 0 ||
      Boolean(actorSession && isReadyForDestiny(actorSession));
    const failures = [];
    const publicationReceipts = [];
    let actorPublicationReceipt = null;
    let eligibleRecipients = 0;
    let publishedRecipients = 0;
    let alreadyVisibleRecipients = 0;
    let actorEligible = requiredCharacterID <= 0;
    let actorDelivered = requiredCharacterID <= 0;
    const visibilityNow = toFiniteNumber(options.nowMs, this.getCurrentSimTimeMs());

    for (const session of this.sessions.values()) {
      if (
        (targetSession && !sessionMatchesIdentity(session, targetSession)) ||
        !isReadyForDestiny(session)
      ) {
        continue;
      }
      // The trace reaches the sessions of its Grid bubble.
      const visibilityDecision = this.evaluateAbyssalSourceTraceVisibility(
        session,
        traceEntity,
        visibilityNow,
      ) || {
        desiredVisible:
          this.getGridBubbleIDForSession(session) !== null &&
          this.getGridBubbleIDForSession(session) === this.getGridBubbleIDForEntity(traceEntity),
      };
      const desiredVisible = visibilityDecision.sourceTraceOverride === true
        ? visibilityDecision.sourceTraceVisible === true
        : visibilityDecision.desiredVisible === true;
      if (!desiredVisible) {
        continue;
      }

      eligibleRecipients += 1;
      const isActor = requiredCharacterID > 0 &&
        toInt(session.characterID, 0) === requiredCharacterID;
      if (isActor) {
        actorEligible = true;
      }
      if (this.canSessionSeeDynamicEntity(session, traceEntity)) {
        alreadyVisibleRecipients += 1;
        let receipt = getAbyssalTracePublicationReceipt(
          session,
          numericTraceItemID,
        );
        if (!receipt) {
          // The client already has the trace: any stamp from now on follows
          // its AddBalls2.
          receipt = storeAbyssalTracePublicationReceipt(
            session,
            buildAbyssalTracePublicationReceipt(
              numericTraceItemID,
              session,
              this.nextDestinyStamp,
              visibilityNow,
              visibilityNow,
            ),
          );
        }
        if (receipt) {
          publicationReceipts.push(receipt);
        }
        if (isActor) {
          actorDelivered = Boolean(receipt);
          actorPublicationReceipt = receipt;
        }
        continue;
      }

      try {
        // The trace is a Ball of its Grid bubble: the next bubble update adds
        // it, at the stamp the tick being queued for carries.
        const publicationStamp = this.nextDestinyStamp;
        const receipt = storeAbyssalTracePublicationReceipt(
          session,
          buildAbyssalTracePublicationReceipt(
            numericTraceItemID,
            session,
            publicationStamp,
            visibilityNow,
            visibilityNow,
          ),
        );
        publicationReceipts.push(receipt);
        this.logAbyssalSourceTraceVisibilityAction(
          session,
          traceEntity,
          {
            ...visibilityDecision,
            currentAcquired: false,
            desiredVisible: true,
          },
          "add",
          visibilityNow,
        );
        publishedRecipients += 1;
        if (isActor) {
          actorDelivered = true;
          actorPublicationReceipt = receipt;
        }
      } catch (error) {
        failures.push(
          `DESTINY_DELIVERY_THROW:character=${toInt(session.characterID, 0)}:` +
            String(error && error.message || "unknown").slice(0, 120),
        );
      }
      if (failures.length >= 8) {
        break;
      }
    }

    if (requiredCharacterID > 0 && !actorReady) {
      failures.push(`ACTOR_NOT_READY:character=${requiredCharacterID}`);
    } else if (requiredCharacterID > 0 && !actorEligible) {
      failures.push(`ACTOR_NOT_ELIGIBLE:character=${requiredCharacterID}`);
    } else if (requiredCharacterID > 0 && !actorDelivered) {
      failures.push(`ACTOR_NOT_DELIVERED:character=${requiredCharacterID}`);
    }
    const success = failures.length === 0 && actorDelivered;
    const pending = requiredCharacterID > 0 && !actorReady;
    return {
      success,
      errorMsg: success
        ? null
        : pending
          ? "ABYSSAL_TRACE_ACTOR_NOT_READY"
          : "ABYSSAL_TRACE_INITIAL_PUBLICATION_FAILED",
      data: {
        traceEntity,
        traceItemID: numericTraceItemID,
        sourceBubbleID,
        eligibleRecipients,
        publishedRecipients,
        alreadyVisibleRecipients,
        actorDelivered,
        actorReady,
        pending,
        actorPublicationReceipt,
        publicationReceipts,
        slimMetadata,
        expectedSlimMetadata,
        failures: failures.slice(0, 8),
      },
    };
  },

sendAbyssalRoomTransferDeliveryToSession(
    session,
    sourceEntityIDs,
    destinationEntities,
    shipEntity,
    options = {},
  ) {
    if (!session || !session._space || !isReadyForDestiny(session)) {
      return {
        success: false,
        errorMsg: "DESTINY_NOT_READY",
        sourceRemoveBallsCount: 0,
        destinationAddBallsCount: 0,
        stamp: 0,
      };
    }

    const transitionStamp = this.nextDestinyStamp;
    const shipID = toInt(shipEntity && shipEntity.itemID, toInt(session._space.shipID, 0));
    const sourceIDs = [...new Set((Array.isArray(sourceEntityIDs) ? sourceEntityIDs : [])
      .map((entityID) => toInt(entityID, 0))
      .filter((entityID) => entityID > 0 && entityID !== shipID))];
    const destinationByID = new Map();
    for (const entity of Array.isArray(destinationEntities) ? destinationEntities : []) {
      const entityID = toInt(entity && entity.itemID, 0);
      if (entityID > 0 && entityID !== shipID) destinationByID.set(entityID, entity);
    }
    const destinations = [...destinationByID.values()];
    const deferredEntityCount = destinations.filter(
      (entity) => entity && entity.evejsInitialPublicationDeferred === true,
    ).length;
    // The rooms' content is not sent here: the source room's Balls left the
    // park when they were retired and the destination's joined it when they
    // were released (setAbyssalRoomEntityDeliveryState), and the ship's move
    // re-boxes it, so the next Grid bubble update removes and adds them.
    const duplicatePublicationIDs = [];
    if (shipEntity && shipID > 0) {
      this.queueCharacterHistory(session, [
        destiny.buildSetBallPositionPayload(shipID, shipEntity.position),
      ]);
    }
    const destinationDynamicEntityIDs = [];
    const destinationStaticEntityIDs = [];
    for (const entity of destinations) {
      const entityID = toInt(entity.itemID, 0);
      entity.evejsInitialPublicationDeferred = false;
      entity.evejsCommittedPublicationCount = toInt(entity.evejsCommittedPublicationCount, 0) + 1;
      if (this.dynamicEntities.has(entityID)) {
        destinationDynamicEntityIDs.push(entityID);
      } else if (this.staticEntitiesByID.has(entityID)) {
        destinationStaticEntityIDs.push(entityID);
      }
    }

    return {
      success: true,
      errorMsg: null,
      sourceRemoveBallsCount: sourceIDs.length,
      destinationAddBallsCount: destinations.length,
      sourceEntityIDs: sourceIDs,
      destinationEntityIDs: destinations.map((entity) => toInt(entity.itemID, 0)),
      destinationDynamicEntityIDs,
      destinationStaticEntityIDs,
      deferredEntityCount,
      duplicatePublicationCount: duplicatePublicationIDs.length,
      duplicatePublicationIDs,
      stamp: transitionStamp,
      sourceRemovalStamp: transitionStamp,
      movementStamp: transitionStamp,
      destinationPublicationStamp: transitionStamp,
      recipientCount: 1,
    };
  },

sendAbyssalTraceActivationBundle(traceEntity, shipEntity, presentation = {}) {
    if (!traceEntity || !shipEntity) {
      return { success: false, errorMsg: "ABYSSAL_TRACE_ENTITY_MISSING" };
    }
    const traceState = presentation.traceState || presentation;
    const capturedProfile = resolveAbyssalTraceProfile(traceState);
    const transitionPresentation =
      presentation.transitionPresentation &&
      typeof presentation.transitionPresentation === "object"
        ? presentation.transitionPresentation
        : capturedProfile &&
            capturedProfile.transitionPresentation &&
            typeof capturedProfile.transitionPresentation === "object"
          ? capturedProfile.transitionPresentation
          : null;
    const supportsActivationSlimUpdate =
      !transitionPresentation ||
      transitionPresentation.supportsActivationSlimUpdate === true;
    const supportsControllerActivation =
      !transitionPresentation ||
      transitionPresentation.supportsControllerActivation === true;
    const supportsDepartureEffect =
      !transitionPresentation ||
      transitionPresentation.supportsDepartureEffect === true;
    const actorSession = presentation.actorSession || null;
    const publicationReceipt = presentation.publicationReceipt || null;
    const publicationValidation = capturedProfile
      ? this.validateAbyssalTracePublicationReceipt(
        actorSession,
        traceEntity,
        publicationReceipt,
      )
      : { success: true, data: { publicationStamp: 0 } };
    if (!publicationValidation.success) {
      return publicationValidation;
    }
    const publicationStamp = toInt(
      publicationValidation.data && publicationValidation.data.publicationStamp,
      0,
    ) >>> 0;
    applyAbyssalTraceProfileToEntity(traceEntity, presentation.traceState || presentation);
    const activationAt = this.getCurrentSimTimeMs();
    // The activation is stamped when it is queued; the trace's AddBalls2
    // carries the stamp it was queued at or an earlier one, and in one tick
    // the bubble update's adds go out ahead of the routed list.
    const stamp = this.nextDestinyStamp;
    if (capturedProfile && stamp < publicationStamp) {
      return {
        success: false,
        errorMsg: "ABYSSAL_TRACE_ACTIVATION_ORDER_INVALID",
        data: {
          publicationStamp,
          activationStamp: stamp,
          stampDelta: stamp - publicationStamp,
        },
      };
    }
    const effectGuid = String(presentation.effectGuid || "effects.JumpOutAbyssal");
    const controllerEvent = String(presentation.controllerEvent || "Activated");
    const controllerEventArgument = toInt(presentation.controllerEventArgument, 1);
    const updates = [];
    if (supportsDepartureEffect) {
      updates.push({
        stamp,
        payload: destiny.buildOnSpecialFXPayload(
          shipEntity.itemID,
          effectGuid,
          presentation.effectOptions || {},
        ),
      });
    }
    if (supportsActivationSlimUpdate) {
      updates.push({
        stamp,
        payload: destiny.buildOnSlimItemChangePayload(
          traceEntity.itemID,
          destiny.buildSlimItemObject(traceEntity),
        ),
      });
    }
    updates.push({
      stamp,
      payload: destiny.buildStopPayload(shipEntity.itemID),
    });
    if (supportsControllerActivation) {
      updates.push({
        stamp,
        payload: destiny.buildOnClientControllerEventPayload(
          traceEntity.itemID,
          shipEntity.itemID,
          controllerEvent,
          controllerEventArgument,
        ),
      });
    }
    // Every Observer of the trace's Grid bubble gets the activation in the
    // same bubble batch; the actor is one of them. The activating RPC session
    // can briefly be absent from the scene while the client owns a
    // session-mutating JumpToAbyss call. Its publication receipt is
    // validated above and its client leaves with that call, so the
    // activation counts as delivered to it, as main (417b46cfc) counted it:
    // a refused activation fails the Abyssal entry. It is sent its own copy
    // below; the rest of the bubble gets it as usual.
    const actorHeldOutsideScene = Boolean(
      capturedProfile &&
      actorSession &&
      !(this.sessions instanceof Map && this.sessions.get(actorSession.clientID) === actorSession)
    );
    let eligibleRecipientCount = 0;
    let actorEligible = false;
    for (const recipient of this.sessions.values()) {
      if (
        !isReadyForDestiny(recipient) ||
        !canSessionReceiveEntityDependentDestinyUpdate(this, recipient, traceEntity)
      ) {
        continue;
      }
      eligibleRecipientCount += 1;
      if (actorSession && sessionMatchesIdentity(recipient, actorSession)) {
        actorEligible = true;
      }
    }
    const queuedStamp = eligibleRecipientCount > 0 || actorHeldOutsideScene
      ? this.queueBallHistory(traceEntity, updates)
      : null;
    // The held pilot still gets its own departure, as on TQ: one batch with the
    // effect, Stop and the controller event on the activation's stamp
    // (TQTranquilExotic1.txt:351). Main sent it directly too.
    if (actorHeldOutsideScene && queuedStamp !== null) {
      require(path.join(runtimeEntryDirname, "./destiny/dispatch/batchDelivery")).deliverDestinyBatches(this, [{
        kind: "character",
        sessions: [actorSession],
        state: updates.map((update) => [update.stamp, update.payload]),
        waitForBubble: false,
      }], stamp);
    }
    const recipientCount = queuedStamp === null ? 0 : eligibleRecipientCount;
    const rejectedRecipientCount = queuedStamp === null ? eligibleRecipientCount : 0;
    const actorDelivered = !capturedProfile ||
      ((actorEligible || actorHeldOutsideScene) && queuedStamp !== null);
    const actorActivationStamp = queuedStamp === null ? 0 : queuedStamp;
    const success = (recipientCount > 0 || actorHeldOutsideScene) && actorDelivered;
    const deliveredActivationStamp = success ? actorActivationStamp || stamp : 0;
    return {
      success,
      errorMsg: success
        ? null
        : recipientCount > 0
          ? "ABYSSAL_TRACE_ACTIVATION_ORDER_INVALID"
          : eligibleRecipientCount > 0
            ? "ABYSSAL_TRACE_ACTIVATION_DELIVERY_REJECTED"
            : "NO_VISIBLE_RECIPIENTS",
      data: {
        profileID: capturedProfile ? capturedProfile.traceProfileID : "",
        stamp: deliveredActivationStamp,
        initialPublicationStamp: publicationStamp,
        publicationStamp,
        activationStamp: deliveredActivationStamp,
        controllerEventStamp:
          success && supportsControllerActivation ? deliveredActivationStamp : 0,
        departureEffectStamp:
          success && supportsDepartureEffect ? deliveredActivationStamp : 0,
        stampDelta: deliveredActivationStamp > 0
          ? deliveredActivationStamp - publicationStamp
          : 0,
        activationAt,
        slimUpdateSent: success && supportsActivationSlimUpdate,
        controllerEventSent: success && supportsControllerActivation,
        departureEffectSent: success && supportsDepartureEffect,
        actorDelivered,
        recipientCount,
        eligibleRecipientCount,
        rejectedRecipientCount,
        updateOrder: updates.map((update) => update.payload[0]),
      },
    };
  },

validateAbyssalTracePublicationReceipt(
    session,
    traceEntity,
    publicationReceipt,
  ) {
    const traceItemID = toInt(traceEntity && traceEntity.itemID, 0);
    if (!session || !isReadyForDestiny(session)) {
      return { success: false, errorMsg: "ABYSSAL_TRACE_ACTOR_NOT_READY" };
    }
    if (
      !traceEntity ||
      traceEntity.evejsAbyssalTrace !== true ||
      traceItemID <= 0 ||
      toInt(publicationReceipt && publicationReceipt.traceItemID, 0) !== traceItemID ||
      !abyssalTracePublicationReceiptMatchesSession(publicationReceipt, session)
    ) {
      return { success: false, errorMsg: "ABYSSAL_TRACE_PUBLICATION_RECEIPT_INVALID" };
    }
    const storedReceipt = getAbyssalTracePublicationReceipt(session, traceItemID);
    if (
      storedReceipt &&
      String(storedReceipt.publicationToken || "") !==
        String(publicationReceipt.publicationToken || "")
    ) {
      return { success: false, errorMsg: "ABYSSAL_TRACE_PUBLICATION_RECEIPT_STALE" };
    }
    if (!canSessionReceiveEntityDependentDestinyUpdate(this, session, traceEntity)) {
      return { success: false, errorMsg: "ABYSSAL_TRACE_PUBLICATION_NOT_VISIBLE" };
    }
    return {
      success: true,
      data: {
        publicationReceipt,
        publicationStamp: toInt(publicationReceipt.addBallsStamp, 0) >>> 0,
      },
    };
  },
};
