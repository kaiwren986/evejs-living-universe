"use strict";

const { normalizeText } = require("../domain/abyssalValueUtils");

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

// Ordered scene evidence, client notifications and room-controller activation.
// Session delivery state and all gameplay/persistence authorities remain injected.
function sendAbyssalLocationEnteredNotification({
  getAbyssalEnvironmentNotificationState,
  buildAbyssalLocationEnteredNotificationPayload,
  log,
  getDependencies,
  logAbyssalEnvironmentPacketComparison,
}, session, selection, options = {}) {
  const runID = toInt(selection && selection.runID, 0);
  const locationID = toInt(selection && selection.abyssalLocationID, 0);
  const nebulaGraphicID = toInt(selection && selection.nebulaGraphicID, 0);
  if (
    !session ||
    typeof session.sendNotification !== "function" ||
    runID <= 0 ||
    toInt(session.abyssalInstanceID, 0) !== runID ||
    locationID <= 0 ||
    nebulaGraphicID <= 0
  ) {
    return { sent: false, duplicate: false, reason: "ABYSSAL_LOCATION_ENTER_UNAVAILABLE" };
  }
  const state = getAbyssalEnvironmentNotificationState(session, runID);
  const enteredLocationIDs = new Set(state.enteredAbyssalLocationIDs);
  if (enteredLocationIDs.has(locationID)) {
    return { sent: false, duplicate: true, reason: "ALREADY_SENT" };
  }
  try {
    session.sendNotification(
      "OnAbyssalLocationEntered",
      "charid",
      buildAbyssalLocationEnteredNotificationPayload(selection),
      { retailBroadcastEnvelope: true },
    );
  } catch (error) {
    log.warn(
      `[AbyssalClientEnvironment] phase=${normalizeText(options.phase, "entry")} ` +
        `instance=${runID} room=${locationID} notification=OnAbyssalLocationEntered ` +
        `notificationSent=false clientApplication=UNVERIFIED ` +
        `reason=${normalizeText(error && error.message, "SEND_FAILED")}`,
    );
    return { sent: false, duplicate: false, reason: "ABYSSAL_LOCATION_ENTER_SEND_FAILED" };
  }
  const sentAtMs = toInt((options.deps || getDependencies()).now(), Date.now());
  enteredLocationIDs.add(locationID);
  session.abyssalDungeonNotificationState = {
    ...state,
    enteredAbyssalLocationIDs: [...enteredLocationIDs],
    enteredAtMsByLocation: {
      ...state.enteredAtMsByLocation,
      [locationID]: sentAtMs,
    },
  };
  if (session.abyssalClientEnvironment && typeof session.abyssalClientEnvironment === "object") {
    session.abyssalClientEnvironment = {
      ...session.abyssalClientEnvironment,
      abyssalLocationEnteredSentAtMs: sentAtMs,
      notificationRoute: "broadcast:shipid",
      notificationOuterEnvelopeMode: "retail-transfer-mode",
      companionNotificationRoute: "broadcast:charid",
      companionNotification: "OnAbyssalLocationEntered",
    };
  }
  logAbyssalEnvironmentPacketComparison(
    session,
    "OnAbyssalLocationEntered",
    "charid",
    "(dict[str,(int|str)])",
  );
  log.info(
    `[AbyssalClientEnvironment] phase=${normalizeText(options.phase, "entry")} ` +
      `instance=${runID} room=${locationID} notification=OnAbyssalLocationEntered ` +
      `notificationSent=true route=broadcast:charid outerEnvelope=retail-transfer-mode ` +
      `nebulaGraphicID=${nebulaGraphicID} clientApplication=UNVERIFIED`,
  );
  return { sent: true, duplicate: false, reason: "SENT", locationID, sentAtMs };
}

function prepareAbyssalEntryReadyContext({
  cloneValue,
  getActivePocketStateByInstanceID,
  evaluateAbyssalDirectCallbackTerminalGuard,
  buildAbyssalDirectCallbackSuppressedResult,
  buildPlaceholderRoomState,
  buildAbyssalClientEnvironmentSelection,
  getAbyssalClientEnvironmentPrerequisites,
  updateAbyssalClientEnvironmentDeliveryState,
  logAbyssalClientEnvironmentPrerequisiteFailure,
  scheduleBoundedAbyssalClientEnvironmentRetry,
  recordAbyssalEnvironmentSequenceEvent,
}, session, deps, options) {
  let pending =
    session && session.abyssalClientEnvironmentDelivery &&
    typeof session.abyssalClientEnvironmentDelivery === "object"
      ? cloneValue(session.abyssalClientEnvironmentDelivery)
      : null;
  if (!pending) {
    return { success: true, skipped: true, reason: "NO_PENDING_DELIVERY" };
  }
  if ([
    "confirmed_by_server_ordering",
    "confirmed_by_server_ordering_degraded_presentation",
  ].includes(pending.status)) {
    return { success: true, skipped: true, duplicate: true, state: pending };
  }
  const activePocketState = getActivePocketStateByInstanceID(toInt(pending.runID, 0));
  const terminalGuard = evaluateAbyssalDirectCallbackTerminalGuard(
    activePocketState,
    "entry-ready-work",
  );
  if (terminalGuard.blocked) {
    if (session && session.abyssalClientEnvironmentDelivery) {
      delete session.abyssalClientEnvironmentDelivery;
    }
    return buildAbyssalDirectCallbackSuppressedResult(terminalGuard, {
      handled: false,
      extra: { skipped: true },
    });
  }
  const currentRoomIndex = activePocketState
    ? buildPlaceholderRoomState(activePocketState).currentRoomIndex
    : 0;
  const currentSceneKey = normalizeText(
    session && (session.spaceSceneKey || (session._space && session._space.sceneKey)),
    "",
  );
  if (
    !activePocketState ||
    toInt(session && session.abyssalInstanceID, 0) !== toInt(pending.runID, 0) ||
    currentRoomIndex !== toInt(pending.roomIndex, 0) ||
    currentSceneKey !== normalizeText(pending.sceneKey, "")
  ) {
    return { success: true, skipped: true, stale: true, reason: "STALE_DELIVERY_CALLBACK" };
  }
  const trigger = normalizeText(options.trigger, pending.phase);
  const selection = buildAbyssalClientEnvironmentSelection(
    activePocketState,
    session,
    deps,
    { roomIndex: pending.roomIndex },
  );
  if (!selection) {
    return {
      success: false,
      deferred: true,
      reason: "PROFILE_OR_SCENE_NOT_APPLICABLE",
      state: pending,
    };
  }
  const prerequisites = getAbyssalClientEnvironmentPrerequisites(
    activePocketState,
    session,
    selection,
    deps,
  );
  const prerequisitesReady = Boolean(
    prerequisites.setStateDelivered === true &&
    prerequisites.egoValid === true &&
    prerequisites.roomSetStateEvidenceValid === true &&
    prerequisites.sceneAttached === true &&
    prerequisites.hostLocationValid === true &&
    prerequisites.locationIdentityValid === true &&
    prerequisites.solItemValid === true
  );
  const sceneDeliveryWasComplete = pending.entrySceneDelivered === true;
  pending = {
    ...pending,
    entrySceneAttached: prerequisites.sceneAttached === true,
    entrySetStateDelivered: prerequisites.setStateDelivered === true,
    entrySceneDelivered: prerequisitesReady,
    lastReadyTrigger: trigger,
  };
  updateAbyssalClientEnvironmentDeliveryState(activePocketState, session, pending);
  if (!prerequisitesReady) {
    logAbyssalClientEnvironmentPrerequisiteFailure(
      selection,
      prerequisites,
      pending.phase,
      trigger,
    );
    if (options.allowDelayedRetry !== false) {
      pending = scheduleBoundedAbyssalClientEnvironmentRetry(
        activePocketState,
        session,
        deps,
        pending,
      );
    }
    return {
      success: false,
      deferred: true,
      reason: "ENVIRONMENT_PREREQUISITES_NOT_READY",
      prerequisites,
      state: pending,
    };
  }
  if (!sceneDeliveryWasComplete) {
    recordAbyssalEnvironmentSequenceEvent(
      activePocketState,
      session,
      pending.roomIndex,
      "scene-delivered",
      deps,
      { trigger },
    );
  }

  return { ready: true, context: { activePocketState, pending, selection, trigger } };
}

function deliverAbyssalEntryEnvironmentStage({
  selectAbyssalClientEnvironmentForSession,
  OPTIONAL_CLOUD_PRESENTATION_NOT_AUTHORED,
  updateAbyssalClientEnvironmentDeliveryState,
  log,
  scheduleBoundedAbyssalClientEnvironmentRetry,
}, context, session, deps, options) {
  const { activePocketState, selection, trigger } = context;
  let pending = context.pending;
  let deliveryState = pending;
  if (pending.status === "pending") {
    const selectionResult = selectAbyssalClientEnvironmentForSession(
      activePocketState,
      session,
      deps,
      trigger,
      { phase: pending.phase, roomIndex: pending.roomIndex },
    );
    if (selectionResult.selected !== true) {
      const optionalCloudNotificationSkipped = Boolean(
        selectionResult.skipped === true &&
        selectionResult.reason === OPTIONAL_CLOUD_PRESENTATION_NOT_AUTHORED
      );
      const optionalEnvironmentNotificationUnavailable = [
        "ENVIRONMENT_NOTIFICATION_UNAVAILABLE",
        "ENVIRONMENT_NOTIFICATION_SEND_FAILED",
      ].includes(selectionResult.reason);
      if (optionalCloudNotificationSkipped) {
        deliveryState = {
          ...pending,
          status: "optional_cloud_notification_skipped",
          optionalCloudNotificationSkipped: true,
          optionalCloudNotificationSkippedAtMs: toInt(deps.now(), 0),
          optionalCloudNotificationSkippedReason: selectionResult.reason,
          entryEnvironmentSent: false,
        };
        updateAbyssalClientEnvironmentDeliveryState(
          activePocketState,
          session,
          deliveryState,
        );
        log.info(
          `[AbyssalClientEnvironment] phase=${normalizeText(pending.phase, "entry")} ` +
            `instance=${toInt(pending.runID, 0)} room=${toInt(pending.roomIndex, 0)} ` +
            `notification=OnEnteringDungeonRoom notificationSkipped=true ` +
            `clientApplication=NOT_APPLICABLE reason=${selectionResult.reason}`,
        );
      } else if (
        optionalEnvironmentNotificationUnavailable &&
        options.allowDelayedRetry !== false
      ) {
        pending = scheduleBoundedAbyssalClientEnvironmentRetry(
          activePocketState,
          session,
          deps,
          pending,
        );
        return {
          success: false,
          deferred: true,
          reason: selectionResult.reason,
          prerequisites: selectionResult.prerequisites,
          state: pending,
        };
      } else if (
        optionalEnvironmentNotificationUnavailable &&
        session &&
        typeof session.sendNotification === "function"
      ) {
        deliveryState = {
          ...pending,
          status: "degraded_optional_environment_notification",
          environmentNotificationDegraded: true,
          environmentNotificationDegradedAtMs: toInt(deps.now(), 0),
          environmentNotificationDegradedReason: selectionResult.reason,
          entryEnvironmentSent: false,
        };
        updateAbyssalClientEnvironmentDeliveryState(
          activePocketState,
          session,
          deliveryState,
        );
        log.warn(
          `[AbyssalClientEnvironment] phase=${normalizeText(pending.phase, "entry")} ` +
            `instance=${toInt(pending.runID, 0)} room=${toInt(pending.roomIndex, 0)} ` +
            `notificationSent=false gameplayBlocked=false ` +
            `delivery=DEGRADED_OPTIONAL_PRESENTATION reason=${selectionResult.reason}`,
        );
      } else if (!optionalCloudNotificationSkipped) {
        return {
          success: false,
          deferred: false,
          reason: selectionResult.reason,
          prerequisites: selectionResult.prerequisites,
          state: pending,
        };
      }
    } else {
      deliveryState = {
        ...pending,
        status: "sent",
        notificationSentAtMs: toInt(deps.now(), 0),
        entryEnvironmentSent: true,
      };
      updateAbyssalClientEnvironmentDeliveryState(activePocketState, session, deliveryState);
    }
  }

  return { ready: true, deliveryState };
}

function deliverAbyssalEntryLocationStage({
  sendAbyssalLocationEnteredNotification,
  scheduleBoundedAbyssalClientEnvironmentRetry,
  updateAbyssalClientEnvironmentDeliveryState,
  log,
}, context, session, deps, options, deliveryState) {
  const { activePocketState, selection } = context;
  if (deliveryState.entryAbyssalLocationEntered !== true) {
    const locationEnterResult = sendAbyssalLocationEnteredNotification(
      session,
      selection,
      { phase: deliveryState.phase, deps },
    );
    if (!(locationEnterResult.sent || locationEnterResult.duplicate)) {
      const optionalLocationNotificationUnavailable = [
        "ABYSSAL_LOCATION_ENTER_UNAVAILABLE",
        "ABYSSAL_LOCATION_ENTER_SEND_FAILED",
      ].includes(locationEnterResult.reason);
      if (
        optionalLocationNotificationUnavailable &&
        options.allowDelayedRetry !== false &&
        deliveryState.delayedRetryScheduled !== true
      ) {
        deliveryState = scheduleBoundedAbyssalClientEnvironmentRetry(
          activePocketState,
          session,
          deps,
          deliveryState,
        );
        return {
          success: false,
          deferred: true,
          reason: locationEnterResult.reason,
          state: deliveryState,
        };
      }
      if (optionalLocationNotificationUnavailable) {
        deliveryState = {
          ...deliveryState,
          environmentNotificationDegraded: true,
          locationNotificationDegraded: true,
          locationNotificationDegradedAtMs: toInt(deps.now(), 0),
          locationNotificationDegradedReason: locationEnterResult.reason,
          entryAbyssalLocationEntered: false,
        };
        updateAbyssalClientEnvironmentDeliveryState(
          activePocketState,
          session,
          deliveryState,
        );
        log.warn(
          `[AbyssalClientEnvironment] phase=${normalizeText(deliveryState.phase, "entry")} ` +
            `instance=${toInt(deliveryState.runID, 0)} ` +
            `room=${toInt(deliveryState.roomIndex, 0)} ` +
            `notification=OnAbyssalLocationEntered notificationSent=false ` +
            `gameplayBlocked=false delivery=DEGRADED_OPTIONAL_PRESENTATION ` +
            `reason=${locationEnterResult.reason}`,
        );
      } else {
        return {
          success: false,
          deferred: false,
          reason: locationEnterResult.reason || "ABYSSAL_LOCATION_ENTER_SEND_FAILED",
          state: deliveryState,
        };
      }
    } else {
      deliveryState = {
        ...deliveryState,
        entryAbyssalLocationEntered: true,
        abyssalLocationEnteredSentAtMs: toInt(
          locationEnterResult.sentAtMs,
          toInt(deps.now(), 0),
        ),
      };
      updateAbyssalClientEnvironmentDeliveryState(activePocketState, session, deliveryState);
    }
  }

  return { ready: true, deliveryState };
}

function deliverAbyssalEntryLifecycleNotifications({
  sendAbyssalExpiryDurationNotification,
  updateAbyssalClientEnvironmentDeliveryState,
  sendAbyssalDungeonExitNotification,
  refreshAbyssalDungeonTrackingState,
}, context, session, deps, deliveryState) {
  const { activePocketState } = context;
  if (
    ["entry", "relog"].includes(deliveryState.phase) &&
    deliveryState.entryExpiryDurationSent !== true
  ) {
    const expiryResult = sendAbyssalExpiryDurationNotification(
      session,
      activePocketState,
      deps,
      { phase: deliveryState.phase },
    );
    if (!(expiryResult.sent || expiryResult.duplicate)) {
      return {
        success: false,
        deferred: true,
        reason: expiryResult.reason || "EXPIRY_NOTIFICATION_SEND_FAILED",
        state: deliveryState,
      };
    }
    deliveryState = {
      ...deliveryState,
      entryExpiryDurationSent: true,
      expiryNotificationSentAtMs: toInt(
        expiryResult.sentAtMs,
        toInt(deps.now(), 0),
      ),
    };
    updateAbyssalClientEnvironmentDeliveryState(activePocketState, session, deliveryState);
  }

  if (deliveryState.previousDungeonID > 0) {
    const exitResult = sendAbyssalDungeonExitNotification(
      session,
      deliveryState.previousDungeonID,
      {
        pocketState: activePocketState,
        roomIndex: deliveryState.roomIndex,
        deps,
      },
    );
    if (!(exitResult.sent || exitResult.duplicate)) {
      return {
        success: false,
        deferred: true,
        reason: exitResult.reason || "EXIT_NOTIFICATION_SEND_FAILED",
        state: deliveryState,
      };
    }
    deliveryState = {
      ...deliveryState,
      exitNotificationSentAtMs: toInt(
        deliveryState.exitNotificationSentAtMs,
        toInt(deps.now(), 0),
      ),
    };
    updateAbyssalClientEnvironmentDeliveryState(activePocketState, session, deliveryState);
  }

  if (deliveryState.phase === "transfer") {
    refreshAbyssalDungeonTrackingState(activePocketState, deps, "room_entered");
  }

  return { ready: true, deliveryState };
}

function deliverAbyssalEntryArrivalStage({
  schedulePostSetStateAbyssalArrivalFx,
  sendOrQueueInitialAbyssalArrivalFx,
  cloneValue,
  updateAbyssalClientEnvironmentDeliveryState,
}, context, session, deps, deliveryState) {
  const { activePocketState, trigger } = context;
  if (deliveryState.phase === "entry" && deliveryState.entrySplashComplete !== true) {
    const splashResult = trigger === "beyonce-post-setstate"
      ? schedulePostSetStateAbyssalArrivalFx(
          activePocketState,
          session,
          deps,
          trigger,
        )
      : sendOrQueueInitialAbyssalArrivalFx(
          activePocketState,
          session,
          deps,
          "initial-room-after-environment",
        );
    if (splashResult && splashResult.queued === true) {
      return { success: false, deferred: true, reason: "ARRIVAL_FX_PENDING", state: deliveryState };
    }
    if (splashResult && splashResult.scheduled === true) {
      deliveryState = cloneValue(splashResult.state) || deliveryState;
    } else {
      deliveryState = {
        ...deliveryState,
        entrySplashSent: Boolean(
          splashResult && (splashResult.success === true || splashResult.duplicate === true)
        ),
        entrySplashComplete: true,
      };
      updateAbyssalClientEnvironmentDeliveryState(activePocketState, session, deliveryState);
    }
  }

  return { ready: true, deliveryState };
}

function activateAbyssalEntryNpcStage({
  activateAbyssalRoomNpcControllers,
  updateAbyssalClientEnvironmentDeliveryState,
  logAbyssalRoomContentActivated,
  getActivePocketStateByInstanceID,
  recordAbyssalEnvironmentSequenceEvent,
}, context, session, deps, deliveryState) {
  const { activePocketState } = context;
  if (
    deliveryState.activateNpcControllers === true &&
    deliveryState.entryNpcControllersActivated !== true
  ) {
    const activationResult = activateAbyssalRoomNpcControllers(
      activePocketState,
      session,
      deps,
      {
        roomIndex: deliveryState.roomIndex,
        expectPaused: true,
        allowAlreadyActive: true,
        roomActive: true,
        degradeOnFailure: false,
      },
    );
    if (!activationResult.success) {
      return {
        success: false,
        deferred: true,
        reason: activationResult.errorMsg || "ABYSSAL_NPC_ACTIVATION_FAILED",
        state: deliveryState,
      };
    }
    deliveryState = {
      ...deliveryState,
      entryNpcControllersActivated: true,
      entryNpcActivationDegraded: Boolean(
        activationResult.data && activationResult.data.degraded === true
      ),
    };
    updateAbyssalClientEnvironmentDeliveryState(activePocketState, session, deliveryState);
    logAbyssalRoomContentActivated(
      getActivePocketStateByInstanceID(toInt(activePocketState.instanceID, 0)) ||
        activePocketState,
      { roomIndex: deliveryState.roomIndex },
    );
    recordAbyssalEnvironmentSequenceEvent(
      activePocketState,
      session,
      deliveryState.roomIndex,
      "npc-activation",
      deps,
      { degraded: deliveryState.entryNpcActivationDegraded },
    );
  }

  return { ready: true, deliveryState };
}

function confirmAbyssalEntryReadyDelivery({
  activateSuppressorControllersForPocketRoom,
  getActivePocketStateByInstanceID,
  deliverSuppressorPresentationForSession,
  updateAbyssalClientEnvironmentDeliveryState,
  ensureBoundaryControllerForPocketState,
  cloneValue,
}, context, session, deps, deliveryState) {
  const { activePocketState } = context;
  activateSuppressorControllersForPocketRoom(
    getActivePocketStateByInstanceID(toInt(activePocketState.instanceID, 0)) ||
      activePocketState,
    deliveryState.roomIndex,
    deps,
  );

  deliverSuppressorPresentationForSession(
    getActivePocketStateByInstanceID(toInt(activePocketState.instanceID, 0)) ||
      activePocketState,
    session,
    deps,
    {
      roomIndex: deliveryState.roomIndex,
      reason: deliveryState.phase === "relog" ? "relog-delivered" : "room-delivered",
      allowRetry: deliveryState.phase === "relog",
    },
  );

  const confirmedState = {
    ...deliveryState,
    status: deliveryState.environmentNotificationDegraded === true
      ? "confirmed_by_server_ordering_degraded_presentation"
      : "confirmed_by_server_ordering",
    activateNpcControllers: false,
    confirmedAtMs: toInt(deps.now(), 0),
    entryComplete: true,
  };
  updateAbyssalClientEnvironmentDeliveryState(activePocketState, session, confirmedState);
  ensureBoundaryControllerForPocketState(
    getActivePocketStateByInstanceID(toInt(activePocketState.instanceID, 0)) ||
      activePocketState,
    deps,
    toInt(deps.now(), 0),
  );
  return { success: true, state: cloneValue(confirmedState) };
}

function flushPendingAbyssalEntryReadyWork({
  getDependencies,
  prepareAbyssalEntryReadyContext,
  deliverAbyssalEntryEnvironmentStage,
  deliverAbyssalEntryLocationStage,
  deliverAbyssalEntryLifecycleNotifications,
  deliverAbyssalEntryArrivalStage,
  activateAbyssalEntryNpcStage,
  confirmAbyssalEntryReadyDelivery,
},
  pocketState,
  session,
  deps = getDependencies(),
  options = {},
) {
  const contextResult = prepareAbyssalEntryReadyContext(session, deps, options);
  if (!contextResult.ready) return contextResult;
  const context = contextResult.context;

  const environmentResult = deliverAbyssalEntryEnvironmentStage(context, session, deps, options);
  if (!environmentResult.ready) return environmentResult;
  const locationResult = deliverAbyssalEntryLocationStage(
    context, session, deps, options, environmentResult.deliveryState,
  );
  if (!locationResult.ready) return locationResult;
  const lifecycleResult = deliverAbyssalEntryLifecycleNotifications(
    context, session, deps, locationResult.deliveryState,
  );
  if (!lifecycleResult.ready) return lifecycleResult;
  const arrivalResult = deliverAbyssalEntryArrivalStage(
    context, session, deps, lifecycleResult.deliveryState,
  );
  if (!arrivalResult.ready) return arrivalResult;
  const activationResult = activateAbyssalEntryNpcStage(
    context, session, deps, arrivalResult.deliveryState,
  );
  if (!activationResult.ready) return activationResult;
  return confirmAbyssalEntryReadyDelivery(context, session, deps, activationResult.deliveryState);
}

function completeAbyssalEntryReadyForSession({
  getDependencies,
  getActivePocketStateForSession,
  evaluateAbyssalDirectCallbackTerminalGuard,
  buildAbyssalDirectCallbackSuppressedResult,
  flushPendingAbyssalEntryReadyWork,
},
  session,
  deps = getDependencies(),
  trigger = "entry-ready",
) {
  const activePocketState = getActivePocketStateForSession(session);
  if (!activePocketState) {
    return { success: true, skipped: true, reason: "NO_ACTIVE_ABYSSAL_RUN" };
  }
  const terminalGuard = evaluateAbyssalDirectCallbackTerminalGuard(
    activePocketState,
    "entry-ready",
  );
  if (terminalGuard.blocked) {
    return buildAbyssalDirectCallbackSuppressedResult(terminalGuard, {
      handled: false,
      extra: { skipped: true },
    });
  }
  return flushPendingAbyssalEntryReadyWork(
    activePocketState,
    session,
    deps,
    { trigger },
  );
}

// Capture supplied capabilities once, as the original closure did. Internal
// callbacks are bound once per instance; no runtime state lives in this wiring.
function createAbyssalEntryReadiness({
  getAbyssalEnvironmentNotificationState,
  buildAbyssalLocationEnteredNotificationPayload,
  log,
  getDependencies,
  logAbyssalEnvironmentPacketComparison,
  cloneValue,
  getActivePocketStateByInstanceID,
  evaluateAbyssalDirectCallbackTerminalGuard,
  buildAbyssalDirectCallbackSuppressedResult,
  buildPlaceholderRoomState,
  buildAbyssalClientEnvironmentSelection,
  getAbyssalClientEnvironmentPrerequisites,
  updateAbyssalClientEnvironmentDeliveryState,
  logAbyssalClientEnvironmentPrerequisiteFailure,
  scheduleBoundedAbyssalClientEnvironmentRetry,
  recordAbyssalEnvironmentSequenceEvent,
  selectAbyssalClientEnvironmentForSession,
  OPTIONAL_CLOUD_PRESENTATION_NOT_AUTHORED,
  sendAbyssalExpiryDurationNotification,
  sendAbyssalDungeonExitNotification,
  refreshAbyssalDungeonTrackingState,
  schedulePostSetStateAbyssalArrivalFx,
  sendOrQueueInitialAbyssalArrivalFx,
  activateAbyssalRoomNpcControllers,
  logAbyssalRoomContentActivated,
  activateSuppressorControllersForPocketRoom,
  deliverSuppressorPresentationForSession,
  ensureBoundaryControllerForPocketState,
  getActivePocketStateForSession,
}) {

  const ports = {
    getAbyssalEnvironmentNotificationState,
    buildAbyssalLocationEnteredNotificationPayload,
    log,
    getDependencies,
    logAbyssalEnvironmentPacketComparison,
    cloneValue,
    getActivePocketStateByInstanceID,
    evaluateAbyssalDirectCallbackTerminalGuard,
    buildAbyssalDirectCallbackSuppressedResult,
    buildPlaceholderRoomState,
    buildAbyssalClientEnvironmentSelection,
    getAbyssalClientEnvironmentPrerequisites,
    updateAbyssalClientEnvironmentDeliveryState,
    logAbyssalClientEnvironmentPrerequisiteFailure,
    scheduleBoundedAbyssalClientEnvironmentRetry,
    recordAbyssalEnvironmentSequenceEvent,
    selectAbyssalClientEnvironmentForSession,
    OPTIONAL_CLOUD_PRESENTATION_NOT_AUTHORED,
    sendAbyssalExpiryDurationNotification,
    sendAbyssalDungeonExitNotification,
    refreshAbyssalDungeonTrackingState,
    schedulePostSetStateAbyssalArrivalFx,
    sendOrQueueInitialAbyssalArrivalFx,
    activateAbyssalRoomNpcControllers,
    logAbyssalRoomContentActivated,
    activateSuppressorControllersForPocketRoom,
    deliverSuppressorPresentationForSession,
    ensureBoundaryControllerForPocketState,
    getActivePocketStateForSession,
  };
  ports.sendAbyssalLocationEnteredNotification = sendAbyssalLocationEnteredNotification.bind(null, ports);
  ports.prepareAbyssalEntryReadyContext = prepareAbyssalEntryReadyContext.bind(null, ports);
  ports.deliverAbyssalEntryEnvironmentStage = deliverAbyssalEntryEnvironmentStage.bind(null, ports);
  ports.deliverAbyssalEntryLocationStage = deliverAbyssalEntryLocationStage.bind(null, ports);
  ports.deliverAbyssalEntryLifecycleNotifications = deliverAbyssalEntryLifecycleNotifications.bind(null, ports);
  ports.deliverAbyssalEntryArrivalStage = deliverAbyssalEntryArrivalStage.bind(null, ports);
  ports.activateAbyssalEntryNpcStage = activateAbyssalEntryNpcStage.bind(null, ports);
  ports.confirmAbyssalEntryReadyDelivery = confirmAbyssalEntryReadyDelivery.bind(null, ports);
  ports.flushPendingAbyssalEntryReadyWork = flushPendingAbyssalEntryReadyWork.bind(null, ports);
  ports.completeAbyssalEntryReadyForSession = completeAbyssalEntryReadyForSession.bind(null, ports);
  Object.freeze(ports);
  return {
    flushPendingAbyssalEntryReadyWork: ports.flushPendingAbyssalEntryReadyWork,
    completeAbyssalEntryReadyForSession: ports.completeAbyssalEntryReadyForSession,
    sendAbyssalLocationEnteredNotification: ports.sendAbyssalLocationEnteredNotification,
  };
}

module.exports = { createAbyssalEntryReadiness };
