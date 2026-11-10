"use strict";

const { normalizeText } = require("../domain/abyssalValueUtils");

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

// Ordered room payload receipts precede visibility and optional presentation.
// The caller retains the open batch, destination activation and final commit.
function prepareAbyssalTransferDestinationDelivery({
  getPocketScene,
  setAbyssalRoomEntityDeliveryState,
  ABYSSAL_ROOM_DELIVERY_STATE,
  listAbyssalRoomBootstrapEntityIDs,
}, context) {
  const { session, deps, validation, nextRoomIndex } = context;
  let { effectivePocketState } = context;
  const deliveryScene = getPocketScene(effectivePocketState, deps);
  const deliveryShip =
    deliveryScene && typeof deliveryScene.getEntityByID === "function"
      ? deliveryScene.getEntityByID(validation.data.context.shipID)
      : null;
  const transitionToken = toInt(
    effectivePocketState && effectivePocketState.pendingTransitionState &&
      effectivePocketState.pendingTransitionState.token,
    0,
  );
  const committedStateResult = setAbyssalRoomEntityDeliveryState(
    effectivePocketState,
    nextRoomIndex,
    ABYSSAL_ROOM_DELIVERY_STATE.DELIVERY_COMMITTED,
    session,
    deps,
    { transitionToken },
  );
  effectivePocketState = committedStateResult.pocketState;
  const destinationEntityIDs = listAbyssalRoomBootstrapEntityIDs(
    effectivePocketState,
    nextRoomIndex,
  );
  const destinationEntities = destinationEntityIDs
    .map((entityID) => deliveryScene && deliveryScene.getEntityByID(entityID))
    .filter(Boolean);
  return { effectivePocketState, deliveryScene, deliveryShip, transitionToken, destinationEntityIDs, destinationEntities };
}

function sendAbyssalTransferDestinationPayload({
  normalizeAbyssalParticipantRoster,
  ABYSSAL_PARTICIPANT_STATUS,
  resolveAbyssalRosterParticipantSession,
}, {
  effectivePocketState, deliveryScene, deliveryShip, destinationEntities,
  validation, session, deps, isolatedSceneDescriptor, oldRoomEntityIDs,
}) {
  const primaryDeliveryResult =
    deliveryScene && typeof deliveryScene.sendAbyssalRoomTransferDeliveryToSession === "function"
      ? deliveryScene.sendAbyssalRoomTransferDeliveryToSession(
          session,
          oldRoomEntityIDs,
          destinationEntities,
          deliveryShip,
          {
            nowMs: toInt(deps.now(), 0),
          },
        )
      : {
          success: false,
          errorMsg: "ABYSSAL_TRANSFER_ORDERED_DELIVERY_UNSUPPORTED",
          sourceRemoveBallsCount: 0,
          destinationAddBallsCount: 0,
          stamp: 0,
        };
  const participantDeliveryResults = [];
  if (
    primaryDeliveryResult && primaryDeliveryResult.success === true &&
    deliveryScene && typeof deliveryScene.sendAbyssalRoomTransferDeliveryToSession === "function"
  ) {
    for (const participant of normalizeAbyssalParticipantRoster(effectivePocketState)) {
      if (
        participant.characterID === validation.data.context.characterID ||
        ![
          ABYSSAL_PARTICIPANT_STATUS.ACTIVE,
          ABYSSAL_PARTICIPANT_STATUS.DISCONNECTED,
        ].includes(participant.status)
      ) {
        continue;
      }
      const participantSession = resolveAbyssalRosterParticipantSession(
        effectivePocketState,
        participant,
        deps,
      );
      if (!participantSession || !participantSession._space) {
        participantDeliveryResults.push({
          characterID: participant.characterID,
          shipID: participant.shipID,
          success: true,
          deferredUntilRelog: true,
        });
        continue;
      }
      const participantSceneKey = normalizeText(
        participantSession._space.sceneKey || participantSession.spaceSceneKey,
        "",
      );
      const participantInstanceID = toInt(
        participantSession._space.instanceID,
        toInt(participantSession.spaceInstanceID, 0),
      );
      const participantShip = typeof deliveryScene.getEntityByID === "function"
        ? deliveryScene.getEntityByID(participant.shipID)
        : null;
      if (
        participantSceneKey !== isolatedSceneDescriptor.sceneKey ||
        participantInstanceID !== toInt(effectivePocketState.instanceID, 0) ||
        !participantShip
      ) {
        participantDeliveryResults.push({
          characterID: participant.characterID,
          shipID: participant.shipID,
          success: false,
          errorMsg: "ABYSSAL_PARTICIPANT_TRANSFER_DELIVERY_SCOPE_INVALID",
        });
        continue;
      }
      const participantDeliveryResult =
        deliveryScene.sendAbyssalRoomTransferDeliveryToSession(
          participantSession,
          oldRoomEntityIDs,
          destinationEntities,
          participantShip,
          {
            nowMs: toInt(deps.now(), 0),
          },
        );
      participantDeliveryResults.push({
        characterID: participant.characterID,
        shipID: participant.shipID,
        ...(participantDeliveryResult || {
          success: false,
          errorMsg: "ABYSSAL_PARTICIPANT_TRANSFER_DELIVERY_FAILED",
        }),
      });
    }
  }
  const failedParticipantDelivery = participantDeliveryResults.find(
    (result) => result.success !== true,
  );
  const deliveryResult = {
    ...(primaryDeliveryResult || {}),
    success: Boolean(
      primaryDeliveryResult && primaryDeliveryResult.success === true &&
      !failedParticipantDelivery
    ),
    errorMsg: primaryDeliveryResult && primaryDeliveryResult.success === true
      ? failedParticipantDelivery && failedParticipantDelivery.errorMsg || null
      : primaryDeliveryResult && primaryDeliveryResult.errorMsg ||
        "ABYSSAL_TRANSFER_ORDERED_DELIVERY_UNSUPPORTED",
    recipientCount:
      (primaryDeliveryResult && primaryDeliveryResult.success === true ? 1 : 0) +
      participantDeliveryResults.filter(
        (result) => result.success === true && result.deferredUntilRelog !== true,
      ).length,
    participantDeliveryResults,
  };
  return deliveryResult;
}

function recordAbyssalTransferSourceRemoval({
  listUniquePositiveInts,
  log,
  recordAbyssalEnvironmentSequenceEvent,
  advanceAbyssalRoomTransferLifecycle,
}, context) {
  const { deliveryResult, currentRoomIndex, nextRoomIndex, session, deps, recordTransferPhase } = context;
  let { effectivePocketState } = context;
  const payloadEntityIDs = listUniquePositiveInts(deliveryResult.destinationEntityIDs);
  const oldRoomRemoveBallResult = {
    removedCount: toInt(deliveryResult.sourceRemoveBallsCount, 0),
    recipientCount: deliveryResult.success
      ? Math.max(1, toInt(deliveryResult.recipientCount, 1))
      : 0,
  };
  log.info(
    `[AbyssalTransfer] old room removed run=${toInt(effectivePocketState.instanceID, 0)} ` +
      `room=${currentRoomIndex} removedCount=${oldRoomRemoveBallResult.removedCount} ` +
      `recipientCount=${oldRoomRemoveBallResult.recipientCount} ` +
      `stamp=${toInt(deliveryResult.sourceRemovalStamp, toInt(deliveryResult.stamp, 0))}`,
  );
  recordAbyssalEnvironmentSequenceEvent(
    effectivePocketState,
    session,
    nextRoomIndex,
    "old_room_remove",
    deps,
    {
      sourceRoomIndex: currentRoomIndex,
      stamp: toInt(deliveryResult.sourceRemovalStamp, toInt(deliveryResult.stamp, 0)),
    },
  );
  effectivePocketState = advanceAbyssalRoomTransferLifecycle(
    effectivePocketState,
    session,
    deps,
    "old_room_removed",
    {
      fromRoom: currentRoomIndex,
      toRoom: nextRoomIndex,
      pendingState: {
        currentPhase: "source-removal-committed",
        sourceRemoveBallsCount: toInt(deliveryResult.sourceRemoveBallsCount, 0),
        sourceRemovalStamp: toInt(
          deliveryResult.sourceRemovalStamp,
          toInt(deliveryResult.stamp, 0),
        ),
      },
    },
  );
  recordTransferPhase("destination-published", {
    scenePublications: deliveryResult.success ? 1 : 0,
    destinationAddBalls: toInt(deliveryResult.destinationAddBallsCount, 0),
    sourceRemoveBalls: toInt(deliveryResult.sourceRemoveBallsCount, 0),
  });
  return { effectivePocketState, payloadEntityIDs };
}

function validateAbyssalTransferDestinationPayload({
  getPlaceholderRoomEntry,
  listUniquePositiveInts,
  log,
  buildAbyssalDestinationRequirements,
  settleFailedAbyssalDestinationActivation,
}, {
  effectivePocketState, nextRoomIndex, currentRoomIndex, isolatedSceneDescriptor,
  deliveryShip, deliveryResult, deliveryScene, payloadEntityIDs, session, deps,
}) {
  const deliveredRoomEntry = getPlaceholderRoomEntry(effectivePocketState, nextRoomIndex);
  const markerCount = toInt(deliveredRoomEntry && deliveredRoomEntry.originMarkerItemID, 0) > 0 ? 1 : 0;
  const conduitCount = toInt(deliveredRoomEntry && deliveredRoomEntry.conduitItemID, 0) > 0 ? 1 : 0;
  const npcCount = listUniquePositiveInts(deliveredRoomEntry && deliveredRoomEntry.hostileEntityIDs).length;
  const environmentCount =
    listUniquePositiveInts(deliveredRoomEntry && deliveredRoomEntry.environmentalObjectItemIDs).length +
    listUniquePositiveInts(deliveredRoomEntry && deliveredRoomEntry.sceneryVisualEntityIDs).length +
    (toInt(deliveredRoomEntry && deliveredRoomEntry.sceneryProbeEntityID, 0) > 0 ? 1 : 0);
  log.info(
    `[AbyssalTransfer] new room delivered sceneKey=${normalizeText(isolatedSceneDescriptor.sceneKey, "none")} ` +
      `room=${nextRoomIndex} shipPresent=${Boolean(deliveryShip)} ` +
      `markerCount=${markerCount} conduitCount=${conduitCount} npcCount=${npcCount} ` +
      `environmentCount=${environmentCount} recipientCount=${toInt(deliveryResult.recipientCount, 0)} ` +
      `stamp=${toInt(deliveryResult.stamp, 0)}`,
  );
  const deliveryRequirements = buildAbyssalDestinationRequirements(
    effectivePocketState,
    nextRoomIndex,
    deliveryScene,
    deps,
  );
  const requiredDestinationEntityIDs = listUniquePositiveInts(
    deliveryRequirements.runtimeEntityIDs,
  );
  const payloadEntityIDSet = new Set(payloadEntityIDs);
  const missingFromPayload = requiredDestinationEntityIDs.filter((entityID) =>
    !payloadEntityIDSet.has(entityID)
  );
  log.info(
    `[AbyssalDestinationDelivery] run=${toInt(effectivePocketState.instanceID, 0)} ` +
      `room=${nextRoomIndex} requiredEntityCount=${requiredDestinationEntityIDs.length} ` +
      `payloadEntityCount=${payloadEntityIDs.length} ` +
      `missingFromPayload=${missingFromPayload.join(",") || "none"} ` +
      `definitionOnlyIDs=${deliveryRequirements.definitionOnlyIDs.join(",") || "none"} ` +
      `unexpectedRequiredIDs=${deliveryRequirements.unexpectedRequiredIDs.join(",") || "none"} ` +
      `shipPresent=${Boolean(deliveryShip)} ` +
      `recipientCount=${toInt(deliveryResult.recipientCount, 0)}`,
  );
  if (
    !deliveryShip ||
    !deliveryResult.success ||
    toInt(deliveryResult.recipientCount, 0) <= 0 ||
    missingFromPayload.length > 0
  ) {
    return settleFailedAbyssalDestinationActivation(
      effectivePocketState,
      session,
      deps,
      missingFromPayload.length > 0
        ? "ABYSSAL_TRANSFER_DELIVERY_PAYLOAD_INCOMPLETE"
        : deliveryResult.errorMsg || "ABYSSAL_TRANSFER_DELIVERY_FAILED",
      {
        sourceRoomIndex: currentRoomIndex,
        destinationRoomIndex: nextRoomIndex,
        missingFromPayload,
      },
    );
  }
  return { success: true, requiredDestinationEntityIDs };
}

function commitAbyssalTransferDestinationVisibility({
  markAbyssalRoomContentDelivered,
  setAbyssalRoomEntityDeliveryState,
  ABYSSAL_ROOM_DELIVERY_STATE,
  markAbyssalDungeonRoomWithoutGenericNotification,
  recordAbyssalEnvironmentSequenceEvent,
  advanceAbyssalRoomTransferLifecycle,
  log,
}, context) {
  const {
    nextRoomIndex, currentRoomIndex, payloadEntityIDs, deps, deliveryResult,
    session, transitionToken, authoredEnvironmentNotification, deliveryScene,
    destinationEntityIDs, oldRoomEntityIDs, requiredDestinationEntityIDs,
  } = context;
  let { effectivePocketState } = context;
  effectivePocketState = markAbyssalRoomContentDelivered(
    effectivePocketState,
    payloadEntityIDs,
    deps,
    { roomIndex: nextRoomIndex, recipientCount: toInt(deliveryResult.recipientCount, 0) },
  );
  const visibleStateResult = setAbyssalRoomEntityDeliveryState(
    effectivePocketState,
    nextRoomIndex,
    ABYSSAL_ROOM_DELIVERY_STATE.VISIBLE,
    session,
    deps,
    { transitionToken },
  );
  effectivePocketState = visibleStateResult.pocketState;
  if (authoredEnvironmentNotification) {
    markAbyssalDungeonRoomWithoutGenericNotification(
      deliveryScene,
      session,
      effectivePocketState,
      deps,
      nextRoomIndex,
    );
  }
  recordAbyssalEnvironmentSequenceEvent(
    effectivePocketState,
    session,
    nextRoomIndex,
    "destination_addballs",
    deps,
    {
      recipientCount: toInt(deliveryResult.recipientCount, 0),
      payloadEntityIDs,
      stamp: toInt(
        deliveryResult.destinationPublicationStamp,
        toInt(deliveryResult.stamp, 0),
      ),
    },
  );
  effectivePocketState = advanceAbyssalRoomTransferLifecycle(
    effectivePocketState,
    session,
    deps,
    "destination_delivered",
    {
      fromRoom: currentRoomIndex,
      toRoom: nextRoomIndex,
      pendingState: {
        currentPhase: "destination-presentation-delivered",
        committedRoomIndex: nextRoomIndex,
        destinationPrewarmedCount: destinationEntityIDs.length,
        destinationVisibleCount: payloadEntityIDs.length,
        destinationAddBallsCount: payloadEntityIDs.length,
        deferredInitialPublicationCount: toInt(deliveryResult.deferredEntityCount, 0),
        duplicateDestinationPublicationCount: toInt(
          deliveryResult.duplicatePublicationCount,
          0,
        ),
        destinationDeliveryStamp: toInt(
          deliveryResult.destinationPublicationStamp,
          toInt(deliveryResult.stamp, 0),
        ),
        earlyVisibilityViolationCount: visibleStateResult.earlyVisibilityViolationCount,
      },
    },
  );
  log.info(
    `[AbyssalRoomTransfer] run=${toInt(effectivePocketState.instanceID, 0)} ` +
      `token=${transitionToken || "none"} fromRoom=${currentRoomIndex} toRoom=${nextRoomIndex} ` +
      `profileID=${normalizeText(effectivePocketState.pendingTransitionState && effectivePocketState.pendingTransitionState.transitionProfileID, "none")} ` +
      `phase=destination-presentation-delivered sourceEntityCount=${oldRoomEntityIDs.length} ` +
      `destinationExpectedCount=${requiredDestinationEntityIDs.length} ` +
      `destinationPrewarmedCount=${destinationEntityIDs.length} ` +
      `destinationVisibleCount=${payloadEntityIDs.length} ` +
      `sourceRemoveBallsCount=${toInt(deliveryResult.sourceRemoveBallsCount, 0)} ` +
      `destinationAddBallsCount=${toInt(deliveryResult.destinationAddBallsCount, 0)} ` +
      `deferredEntityCount=${toInt(deliveryResult.deferredEntityCount, 0)} ` +
      `duplicatePublicationCount=${toInt(deliveryResult.duplicatePublicationCount, 0)} ` +
      `departureEffectStamp=${toInt(effectivePocketState.pendingTransitionState && effectivePocketState.pendingTransitionState.departureEffectStamp, 0)} ` +
      `notificationStamp=${toInt(effectivePocketState.pendingTransitionState && effectivePocketState.pendingTransitionState.notificationStamp, 0)} ` +
      `sourceRemovalStamp=${toInt(deliveryResult.sourceRemovalStamp, toInt(deliveryResult.stamp, 0))} ` +
      `destinationDeliveryStamp=${toInt(deliveryResult.destinationPublicationStamp, toInt(deliveryResult.stamp, 0))} ` +
      `sourceControllersPaused=true destinationControllersActive=false status=pending reason=OK`,
  );
  return { effectivePocketState };
}

function selectAbyssalTransferDestinationEnvironment({
  selectAbyssalClientEnvironmentForSession,
  OPTIONAL_CLOUD_PRESENTATION_NOT_AUTHORED,
  log,
}, {
  effectivePocketState, session, deps, nextRoomIndex, payloadEntityIDs,
}) {
  let enteringResult = selectAbyssalClientEnvironmentForSession(
    effectivePocketState,
    session,
    deps,
    "room-transfer-after-destination-addballs",
    {
      phase: "transfer",
      roomIndex: nextRoomIndex,
      deliveredEntityIDs: payloadEntityIDs,
      sequenceEvent: "entering_dungeon_notification",
    },
  );
  if (
    enteringResult.selected !== true &&
    !(
      enteringResult.skipped === true &&
      enteringResult.reason === OPTIONAL_CLOUD_PRESENTATION_NOT_AUTHORED
    )
  ) {
    enteringResult = selectAbyssalClientEnvironmentForSession(
      effectivePocketState,
      session,
      deps,
      "room-transfer-environment-bounded-retry",
      {
        phase: "transfer",
        roomIndex: nextRoomIndex,
        deliveredEntityIDs: payloadEntityIDs,
        sequenceEvent: "entering_dungeon_notification",
      },
    );
  }
  const optionalCloudNotificationSkipped = Boolean(
    enteringResult.skipped === true &&
    enteringResult.reason === OPTIONAL_CLOUD_PRESENTATION_NOT_AUTHORED
  );
  const enteringNotificationComplete = Boolean(
    enteringResult.selected === true || optionalCloudNotificationSkipped
  );
  if (optionalCloudNotificationSkipped) {
    log.info(
      `[AbyssalClientEnvironment] phase=transfer ` +
        `instance=${toInt(effectivePocketState.instanceID, 0)} room=${nextRoomIndex} ` +
        `notification=OnEnteringDungeonRoom notificationSkipped=true ` +
        `clientApplication=NOT_APPLICABLE ` +
        `reason=${OPTIONAL_CLOUD_PRESENTATION_NOT_AUTHORED}`,
    );
  }
  return { enteringResult, optionalCloudNotificationSkipped, enteringNotificationComplete };
}

function sendAbyssalTransferDestinationTracking({
  OPTIONAL_CLOUD_PRESENTATION_NOT_AUTHORED,
  sendAbyssalDungeonExitNotification,
  sendAbyssalLocationEnteredNotification,
  sendAbyssalLocationExitNotification,
}, {
  previousDungeonID, enteringNotificationComplete, session, effectivePocketState,
  nextRoomIndex, currentRoomIndex, deps, enteringResult,
}) {
  let exitResult = previousDungeonID > 0
    ? {
        sent: false,
        duplicate: false,
        skipped: false,
        reason: "ENTRY_NOTIFICATION_FAILED",
      }
    : {
        sent: false,
        duplicate: false,
        skipped: true,
        reason: OPTIONAL_CLOUD_PRESENTATION_NOT_AUTHORED,
      };
  let locationEnterResult = {
    sent: false,
    duplicate: false,
    reason: "ENTRY_NOTIFICATION_FAILED",
  };
  let locationExitResult = {
    sent: false,
    duplicate: false,
    reason: "ENTRY_NOTIFICATION_FAILED",
  };
  if (enteringNotificationComplete) {
    if (!(exitResult.sent || exitResult.duplicate || exitResult.skipped)) {
      exitResult = sendAbyssalDungeonExitNotification(
        session,
        previousDungeonID,
        {
          pocketState: effectivePocketState,
          roomIndex: nextRoomIndex,
          deps,
          sequenceEvent: "exiting_dungeon_notification",
        },
      );
    }
    if (!(exitResult.sent || exitResult.duplicate || exitResult.skipped)) {
      exitResult = sendAbyssalDungeonExitNotification(
        session,
        previousDungeonID,
        {
          pocketState: effectivePocketState,
          roomIndex: nextRoomIndex,
          deps,
          sequenceEvent: "exiting_dungeon_notification",
        },
      );
    }
    if (exitResult.sent || exitResult.duplicate || exitResult.skipped) {
      locationEnterResult = sendAbyssalLocationEnteredNotification(
        session,
        enteringResult.state,
        { phase: "transfer", deps },
      );
    }
    if (locationEnterResult.sent || locationEnterResult.duplicate) {
      locationExitResult = sendAbyssalLocationExitNotification(
        session,
        effectivePocketState.instanceID,
        currentRoomIndex,
        { phase: "transfer", deps },
      );
    }
  }
  return { exitResult, locationEnterResult, locationExitResult };
}

function commitAbyssalTransferEnvironmentDelivery({
  OPTIONAL_CLOUD_PRESENTATION_NOT_AUTHORED,
  updateAbyssalClientEnvironmentDeliveryState,
  getActivePocketStateByInstanceID,
  updatePocketState,
  cloneValue,
  log,
  advanceAbyssalRoomTransferLifecycle,
}, context) {
  const {
    enteringNotificationComplete, exitResult, locationEnterResult, locationExitResult,
    enteringResult, isolatedSceneDescriptor, nextRoomIndex, currentRoomIndex, previousDungeonID,
    deps, optionalCloudNotificationSkipped, session,
  } = context;
  let { effectivePocketState } = context;
  const environmentNotificationSent = Boolean(
    enteringNotificationComplete &&
    (exitResult.sent || exitResult.duplicate || exitResult.skipped) &&
    (locationEnterResult.sent || locationEnterResult.duplicate) &&
    (locationExitResult.sent || locationExitResult.duplicate)
  );
  const destinationSelection = enteringResult.state || {};
  const transferEnvironmentDeliveryState = {
    status: environmentNotificationSent ? "sent" : "degraded_notification_failed",
    token: 0,
    runID: toInt(destinationSelection.runID, toInt(effectivePocketState.instanceID, 0)),
    sceneKey: normalizeText(destinationSelection.sceneKey, isolatedSceneDescriptor.sceneKey),
    roomIndex: nextRoomIndex,
    profileID: normalizeText(destinationSelection.profileID, ""),
    phase: "transfer",
    previousDungeonID,
    activateNpcControllers: true,
    queuedAtMs: toInt(deps.now(), 0),
    notificationSentAtMs: environmentNotificationSent ? toInt(deps.now(), 0) : 0,
    exitNotificationSentAtMs: exitResult.sent || exitResult.duplicate ? toInt(deps.now(), 0) : 0,
    abyssalLocationEnteredSentAtMs:
      locationEnterResult.sentAtMs || (locationEnterResult.duplicate ? toInt(deps.now(), 0) : 0),
    abyssalLocationExitedSentAtMs:
      locationExitResult.sentAtMs || (locationExitResult.duplicate ? toInt(deps.now(), 0) : 0),
    confirmedAtMs: 0,
    entrySceneAttached: true,
    entrySetStateDelivered: true,
    entrySceneDelivered: true,
    entryEnvironmentSent: enteringResult.selected === true,
    optionalCloudNotificationSkipped,
    optionalCloudNotificationSkippedReason: optionalCloudNotificationSkipped
      ? OPTIONAL_CLOUD_PRESENTATION_NOT_AUTHORED
      : "",
    entryAbyssalLocationEntered:
      locationEnterResult.sent === true || locationEnterResult.duplicate === true,
    entrySplashSent: false,
    entrySplashComplete: true,
    entryNpcControllersActivated: false,
    entryNpcActivationDegraded: false,
    entryComplete: false,
    lastReadyTrigger: "room-transfer-after-destination-addballs",
    clientApplication: "UNVERIFIED",
    degradedReason: environmentNotificationSent
      ? ""
      : !enteringNotificationComplete
        ? normalizeText(enteringResult.reason, "ENTRY_NOTIFICATION_FAILED")
        : !(exitResult.sent || exitResult.duplicate || exitResult.skipped)
          ? normalizeText(exitResult.reason, "EXIT_NOTIFICATION_FAILED")
          : !(locationEnterResult.sent || locationEnterResult.duplicate)
            ? normalizeText(locationEnterResult.reason, "ABYSSAL_LOCATION_ENTER_FAILED")
            : normalizeText(locationExitResult.reason, "ABYSSAL_LOCATION_EXIT_FAILED"),
  };
  updateAbyssalClientEnvironmentDeliveryState(
    effectivePocketState,
    session,
    transferEnvironmentDeliveryState,
  );
  const notificationPocketState =
    getActivePocketStateByInstanceID(toInt(effectivePocketState.instanceID, 0)) ||
    effectivePocketState;
  effectivePocketState = updatePocketState(toInt(effectivePocketState.instanceID, 0), {
    pendingTransitionState: {
      ...cloneValue(notificationPocketState.pendingTransitionState),
      notificationSent: environmentNotificationSent,
      notificationStamp: environmentNotificationSent ? toInt(deps.now(), 0) : 0,
      destinationNotificationCommittedAtMs: environmentNotificationSent
        ? toInt(deps.now(), 0)
        : 0,
    },
  }) || effectivePocketState;
  if (!environmentNotificationSent) {
    log.warn(
      `[AbyssalClientEnvironment] phase=transfer instance=${toInt(effectivePocketState.instanceID, 0)} ` +
        `room=${nextRoomIndex} notificationSent=false clientApplication=UNVERIFIED ` +
        `delivery=DEGRADED_BOUNDED_RECOVERY reason=${transferEnvironmentDeliveryState.degradedReason}`,
    );
  }
  effectivePocketState = advanceAbyssalRoomTransferLifecycle(
    effectivePocketState,
    session,
    deps,
    "environment_notified",
    { fromRoom: currentRoomIndex, toRoom: nextRoomIndex },
  );
  return { effectivePocketState, transferEnvironmentDeliveryState };
}

function publishAbyssalTransferDestination({
  prepareAbyssalTransferDestinationDelivery,
  sendAbyssalTransferDestinationPayload,
  recordAbyssalTransferSourceRemoval,
  validateAbyssalTransferDestinationPayload,
  commitAbyssalTransferDestinationVisibility,
  selectAbyssalTransferDestinationEnvironment,
  sendAbyssalTransferDestinationTracking,
  commitAbyssalTransferEnvironmentDelivery,
  advanceAbyssalRoomTransferLifecycle,
}, context) {
  if (!context.isolatedSceneDescriptor) {
    return {
      success: true,
      effectivePocketState: context.effectivePocketState,
      deliveryScene: context.deliveryScene,
      transferEnvironmentDeliveryState: context.transferEnvironmentDeliveryState,
    };
  }
  let delivery = { ...context, ...prepareAbyssalTransferDestinationDelivery(context) };
  delivery.deliveryResult = sendAbyssalTransferDestinationPayload(delivery);
  delivery = { ...delivery, ...recordAbyssalTransferSourceRemoval(delivery) };
  const validationResult = validateAbyssalTransferDestinationPayload(delivery);
  if (!validationResult.success) return validationResult;
  delivery.requiredDestinationEntityIDs = validationResult.requiredDestinationEntityIDs;
  delivery = { ...delivery, ...commitAbyssalTransferDestinationVisibility(delivery) };
  if (context.authoredEnvironmentNotification) {
    delivery = { ...delivery, ...selectAbyssalTransferDestinationEnvironment(delivery) };
    delivery = { ...delivery, ...sendAbyssalTransferDestinationTracking(delivery) };
    delivery = { ...delivery, ...commitAbyssalTransferEnvironmentDelivery(delivery) };
  }
  delivery.effectivePocketState = advanceAbyssalRoomTransferLifecycle(
    delivery.effectivePocketState, context.session, context.deps, "room_committed",
    { fromRoom: context.currentRoomIndex, toRoom: context.nextRoomIndex },
  );
  context.recordTransferPhase("environment-notified-room-committed");
  return {
    success: true,
    effectivePocketState: delivery.effectivePocketState,
    deliveryScene: delivery.deliveryScene,
    transferEnvironmentDeliveryState: delivery.transferEnvironmentDeliveryState,
  };
}

// Capture supplied capabilities once, as the original closure did. Internal
// callbacks are bound once per instance; no runtime state lives in this wiring.
function createAbyssalRoomTransferPublication({
  getPocketScene,
  setAbyssalRoomEntityDeliveryState,
  ABYSSAL_ROOM_DELIVERY_STATE,
  listAbyssalRoomBootstrapEntityIDs,
  normalizeAbyssalParticipantRoster,
  ABYSSAL_PARTICIPANT_STATUS,
  resolveAbyssalRosterParticipantSession,
  listUniquePositiveInts,
  log,
  recordAbyssalEnvironmentSequenceEvent,
  advanceAbyssalRoomTransferLifecycle,
  getPlaceholderRoomEntry,
  buildAbyssalDestinationRequirements,
  settleFailedAbyssalDestinationActivation,
  markAbyssalRoomContentDelivered,
  markAbyssalDungeonRoomWithoutGenericNotification,
  selectAbyssalClientEnvironmentForSession,
  OPTIONAL_CLOUD_PRESENTATION_NOT_AUTHORED,
  sendAbyssalDungeonExitNotification,
  sendAbyssalLocationEnteredNotification,
  sendAbyssalLocationExitNotification,
  updateAbyssalClientEnvironmentDeliveryState,
  getActivePocketStateByInstanceID,
  updatePocketState,
  cloneValue,
}) {

  const ports = {
    getPocketScene,
    setAbyssalRoomEntityDeliveryState,
    ABYSSAL_ROOM_DELIVERY_STATE,
    listAbyssalRoomBootstrapEntityIDs,
    normalizeAbyssalParticipantRoster,
    ABYSSAL_PARTICIPANT_STATUS,
    resolveAbyssalRosterParticipantSession,
    listUniquePositiveInts,
    log,
    recordAbyssalEnvironmentSequenceEvent,
    advanceAbyssalRoomTransferLifecycle,
    getPlaceholderRoomEntry,
    buildAbyssalDestinationRequirements,
    settleFailedAbyssalDestinationActivation,
    markAbyssalRoomContentDelivered,
    markAbyssalDungeonRoomWithoutGenericNotification,
    selectAbyssalClientEnvironmentForSession,
    OPTIONAL_CLOUD_PRESENTATION_NOT_AUTHORED,
    sendAbyssalDungeonExitNotification,
    sendAbyssalLocationEnteredNotification,
    sendAbyssalLocationExitNotification,
    updateAbyssalClientEnvironmentDeliveryState,
    getActivePocketStateByInstanceID,
    updatePocketState,
    cloneValue,
  };
  ports.prepareAbyssalTransferDestinationDelivery = prepareAbyssalTransferDestinationDelivery.bind(null, ports);
  ports.sendAbyssalTransferDestinationPayload = sendAbyssalTransferDestinationPayload.bind(null, ports);
  ports.recordAbyssalTransferSourceRemoval = recordAbyssalTransferSourceRemoval.bind(null, ports);
  ports.validateAbyssalTransferDestinationPayload = validateAbyssalTransferDestinationPayload.bind(null, ports);
  ports.commitAbyssalTransferDestinationVisibility = commitAbyssalTransferDestinationVisibility.bind(null, ports);
  ports.selectAbyssalTransferDestinationEnvironment = selectAbyssalTransferDestinationEnvironment.bind(null, ports);
  ports.sendAbyssalTransferDestinationTracking = sendAbyssalTransferDestinationTracking.bind(null, ports);
  ports.commitAbyssalTransferEnvironmentDelivery = commitAbyssalTransferEnvironmentDelivery.bind(null, ports);
  ports.publishAbyssalTransferDestination = publishAbyssalTransferDestination.bind(null, ports);
  Object.freeze(ports);
  return { publishAbyssalTransferDestination: ports.publishAbyssalTransferDestination };
}

module.exports = { createAbyssalRoomTransferPublication };
