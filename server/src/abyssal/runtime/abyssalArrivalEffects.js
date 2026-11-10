"use strict";

const { normalizeText } = require("../domain/abyssalValueUtils");

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function sendOrQueueInitialAbyssalArrivalFx(ports,
  pocketState,
  session,
  deps = ports.getDependencies(),
  reason = "initial-room-entry",
) {
  const {
    buildPlaceholderRoomState,
    maybeSendAbyssalArrivalFx,
    updateAbyssalTransitionFxState,
    log,
  } = ports;
  const roomIndex = buildPlaceholderRoomState(pocketState).currentRoomIndex;
  const currentState =
    pocketState && pocketState.transitionClientFxState &&
    typeof pocketState.transitionClientFxState === "object"
      ? pocketState.transitionClientFxState
      : {};
  if (toInt(currentState.initialArrivalSentRoomIndex, 0) === roomIndex) {
    return { success: true, skipped: true, duplicate: true };
  }
  const result = maybeSendAbyssalArrivalFx(pocketState, session, deps, reason);
  const destinyNotReady = normalizeText(result && result.errorMsg, "") === "DESTINY_NOT_READY";
  updateAbyssalTransitionFxState(pocketState, {
    initialArrivalPendingRoomIndex: destinyNotReady ? roomIndex : 0,
    initialArrivalPendingReason: destinyNotReady ? normalizeText(reason, "initial-room-entry") : "",
    initialArrivalSentRoomIndex: result && result.success ? roomIndex : 0,
    initialArrivalSentAtMs: result && result.success ? toInt(deps.now(), 0) : 0,
  });
  if (destinyNotReady) {
    log.info(
      `[AbyssalMgr] Abyssal initial arrival FX queued instance=${toInt(pocketState && pocketState.instanceID, 0)} ` +
        `room=${roomIndex} reason=DESTINY_NOT_READY`,
    );
  }
  return {
    ...result,
    queued: destinyNotReady,
  };
}

function flushPendingInitialAbyssalArrivalFx(ports,
  pocketState,
  session,
  deps = ports.getDependencies(),
  reason = "client-ready",
) {
  const {

  } = ports;
  const currentState =
    pocketState && pocketState.transitionClientFxState &&
    typeof pocketState.transitionClientFxState === "object"
      ? pocketState.transitionClientFxState
      : {};
  if (toInt(currentState.initialArrivalPendingRoomIndex, 0) <= 0) {
    return { success: true, skipped: true };
  }
  return sendOrQueueInitialAbyssalArrivalFx(ports, pocketState, session, deps, reason);
}

function schedulePostSetStateAbyssalArrivalFx(ports,
  pocketState,
  session,
  deps = ports.getDependencies(),
  reason = "beyonce-post-setstate",
) {
  const {
    buildPlaceholderRoomState,
    updateAbyssalTransitionFxState,
    log,
    cloneValue,
    ABYSSAL_BEYONCE_POST_SETSTATE_ARRIVAL_FX_DELAY_MS,
    updateAbyssalClientEnvironmentDeliveryState,
    getActivePocketStateByInstanceID,
  } = ports;
  const deliveryState =
    session && session.abyssalClientEnvironmentDelivery &&
    typeof session.abyssalClientEnvironmentDelivery === "object"
      ? cloneValue(session.abyssalClientEnvironmentDelivery)
      : null;
  if (!deliveryState) {
    return { success: false, errorMsg: "DELIVERY_STATE_UNAVAILABLE" };
  }
  if (deliveryState.entrySplashSent === true || deliveryState.entrySplashComplete === true) {
    return { success: true, duplicate: true, state: deliveryState };
  }
  if (deliveryState.entrySplashScheduled === true) {
    return { success: true, duplicate: true, scheduled: true, state: deliveryState };
  }
  if (!deps || typeof deps.scheduleTimeout !== "function") {
    return sendOrQueueInitialAbyssalArrivalFx(ports, pocketState, session, deps, reason);
  }

  const token = toInt(deliveryState.token, 0);
  const runID = toInt(deliveryState.runID, toInt(pocketState && pocketState.instanceID, 0));
  const roomIndex = toInt(
    deliveryState.roomIndex,
    buildPlaceholderRoomState(pocketState).currentRoomIndex,
  );
  const sceneKey = normalizeText(deliveryState.sceneKey, "");
  const scheduledState = {
    ...deliveryState,
    entrySplashScheduled: true,
    entrySplashScheduledAtMs: toInt(deps.now(), 0),
    entrySplashDelayMs: ABYSSAL_BEYONCE_POST_SETSTATE_ARRIVAL_FX_DELAY_MS,
  };
  updateAbyssalClientEnvironmentDeliveryState(pocketState, session, scheduledState);
  updateAbyssalTransitionFxState(pocketState, {
    initialArrivalScheduledRoomIndex: roomIndex,
    initialArrivalScheduledAtMs: toInt(deps.now(), 0),
    initialArrivalScheduledReason: normalizeText(reason, "beyonce-post-setstate"),
  });

  deps.scheduleTimeout(() => {
    const current =
      session && session.abyssalClientEnvironmentDelivery &&
      typeof session.abyssalClientEnvironmentDelivery === "object"
        ? cloneValue(session.abyssalClientEnvironmentDelivery)
        : null;
    const activePocketState = getActivePocketStateByInstanceID(runID);
    const currentRoomIndex = activePocketState
      ? buildPlaceholderRoomState(activePocketState).currentRoomIndex
      : 0;
    const currentSceneKey = normalizeText(
      session && (session.spaceSceneKey || (session._space && session._space.sceneKey)),
      "",
    );
    if (
      !current ||
      !activePocketState ||
      current.entrySplashScheduled !== true ||
      toInt(current.token, 0) !== token ||
      toInt(current.runID, 0) !== runID ||
      toInt(session && session.abyssalInstanceID, 0) !== runID ||
      toInt(current.roomIndex, 0) !== roomIndex ||
      currentRoomIndex !== roomIndex ||
      normalizeText(current.sceneKey, "") !== sceneKey ||
      currentSceneKey !== sceneKey
    ) {
      return;
    }

    const result = sendOrQueueInitialAbyssalArrivalFx(ports,
      activePocketState,
      session,
      deps,
      `${normalizeText(reason, "beyonce-post-setstate")}-delayed`,
    );
    const queued = result && result.queued === true;
    const completedState = {
      ...current,
      entrySplashScheduled: false,
      entrySplashSent: Boolean(
        result && (result.success === true || result.duplicate === true)
      ),
      entrySplashComplete: !queued,
      entrySplashCompletedAtMs: !queued ? toInt(deps.now(), 0) : 0,
    };
    updateAbyssalClientEnvironmentDeliveryState(
      activePocketState,
      session,
      completedState,
    );
    const pocketStateAfterArrival =
      getActivePocketStateByInstanceID(runID) || activePocketState;
    updateAbyssalTransitionFxState(pocketStateAfterArrival, {
      initialArrivalScheduledRoomIndex: 0,
      initialArrivalScheduledReason: "",
    });
    log.info(
      `[AbyssalMgr] Abyssal delayed arrival FX instance=${runID} room=${roomIndex} ` +
        `delayMs=${ABYSSAL_BEYONCE_POST_SETSTATE_ARRIVAL_FX_DELAY_MS} ` +
        `status=${result && result.success ? "SENT" : normalizeText(result && result.errorMsg, queued ? "DESTINY_NOT_READY" : "SEND_FAILED")}`,
    );
  }, ABYSSAL_BEYONCE_POST_SETSTATE_ARRIVAL_FX_DELAY_MS);

  log.info(
    `[AbyssalMgr] Abyssal arrival FX scheduled instance=${runID} room=${roomIndex} ` +
      `reason=${normalizeText(reason, "beyonce-post-setstate")} ` +
      `delayMs=${ABYSSAL_BEYONCE_POST_SETSTATE_ARRIVAL_FX_DELAY_MS}`,
  );
  return { success: true, scheduled: true, state: cloneValue(scheduledState) };
}

function createAbyssalArrivalEffects(ports) {
  return {
    sendOrQueueInitialAbyssalArrivalFx: sendOrQueueInitialAbyssalArrivalFx.bind(null, ports),
    flushPendingInitialAbyssalArrivalFx: flushPendingInitialAbyssalArrivalFx.bind(null, ports),
    schedulePostSetStateAbyssalArrivalFx: schedulePostSetStateAbyssalArrivalFx.bind(null, ports),
  };
}

module.exports = { createAbyssalArrivalEffects };
