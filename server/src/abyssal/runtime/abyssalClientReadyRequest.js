"use strict";

const { normalizeText } = require("../domain/abyssalValueUtils");
const { runAfterSessionSetState } = require("./abyssalSetStateDelivery");

// Per-request orchestration; the RPC service supplies its own activation callback.
function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function prepareClientReadyRequest(ports, session) {
  const {
    getDependencies,
    getSessionContext,
    reconcileAbyssalFilamentCompensationsForSession,
    log,
    resetPersistedAbyssalRunsAfterServerRestart,
    runPlaceholderPocketMaintenance,
    ensureSystemStalePlaceholderCleanup,
    settlePendingAbyssalReturnProtectionForSession,
    settlePendingAbyssalSuspectReturnForSession,
    routeAbyssalSessionStateForBeyonce,
    ensureClientReadyBallparkPrimed,
  } = ports;
  const deps = getDependencies();
  const context = getSessionContext(session);
  const filamentCompensationReconcileResult =
    reconcileAbyssalFilamentCompensationsForSession(session, deps);
  if (
    filamentCompensationReconcileResult &&
    filamentCompensationReconcileResult.success !== true &&
    filamentCompensationReconcileResult.skipped !== true
  ) {
    log.warn(
      `[AbyssalFilamentCompensation] client-ready reconcile failed ` +
        `character=${context.characterID} ` +
        `reason=${normalizeText(
          filamentCompensationReconcileResult.errorMsg,
          "PENDING_CLAIM_RECONCILE_FAILED",
        )}`,
    );
  }
  resetPersistedAbyssalRunsAfterServerRestart(context.systemID, deps, "server-restart-reset", session);
  runPlaceholderPocketMaintenance(null, deps);
  ensureSystemStalePlaceholderCleanup(context.systemID, deps, "client-ready");
  settlePendingAbyssalReturnProtectionForSession(session, deps);
  settlePendingAbyssalSuspectReturnForSession(session, deps);
  const recoveryResult = routeAbyssalSessionStateForBeyonce(session, deps);
  const refreshedContext = getSessionContext(session);
  const bootstrapMode = normalizeText(recoveryResult && recoveryResult.route, "") === "fresh-entry"
    ? "fresh-entry"
    : normalizeText(recoveryResult && recoveryResult.route, "") === "relog-recovery"
      ? "relog-recovery"
      : "active-bind";
  const ballparkPrimeResult = ensureClientReadyBallparkPrimed(
    session,
    deps,
    refreshedContext,
    { mode: bootstrapMode },
  );
  return { deps, filamentCompensationReconcileResult, recoveryResult, refreshedContext,
    bootstrapMode, ballparkPrimeResult };
}

function completeClientReadyDelivery(ports, session, request, scheduleAutomaticTraceActivation) {
  const {
    log,
    completeAbyssalKSpaceArrivalForSession,
    getActivePocketStateForSession,
    completeAbyssalEntryReadyForSession,
    flushPendingInitialAbyssalArrivalFx,
    getActiveTraceStateForCharacterID,
    ensureSourceTraceRuntime,
    publishSourceTraceInitial,
    resolveAbyssalTraceAutomaticActivationDelayMs,
    resolveAbyssalTraceProfile,
    persistAbyssalTracePublicationState,
  } = ports;
  const { deps, refreshedContext, bootstrapMode, ballparkPrimeResult } = request;
  if (session && session._abyssalKSpaceArrival && ballparkPrimeResult.primed === true) {
    completeAbyssalKSpaceArrivalForSession(
      session,
      deps,
      "client-ready-reconciliation",
    );
  }
  let clientEnvironmentDeliveryResult = null;
  const activePocketState = getActivePocketStateForSession(session);
  if (activePocketState && ballparkPrimeResult.primed === true) {
    clientEnvironmentDeliveryResult = completeAbyssalEntryReadyForSession(
      session,
      deps,
      bootstrapMode === "fresh-entry"
        ? "beyonce-post-setstate"
        : "client-ready-after-bootstrap",
    );
    if (clientEnvironmentDeliveryResult.reason === "NO_PENDING_DELIVERY") {
      flushPendingInitialAbyssalArrivalFx(
        activePocketState,
        session,
        deps,
        "client-ready-after-bootstrap",
      );
    }
  }
  if (!activePocketState && ballparkPrimeResult.primed === true) {
    const activeTraceState = getActiveTraceStateForCharacterID(
      refreshedContext.characterID,
      deps,
    );
    if (
      activeTraceState &&
      toInt(activeTraceState.sourceSolarSystemID, 0) === refreshedContext.systemID
    ) {
      const runtimeResult = ensureSourceTraceRuntime(activeTraceState, deps);
      if (runtimeResult.success) {
        const publicationResult = publishSourceTraceInitial(activeTraceState, deps, {
          reason: "client-ready",
          targetSession: session,
        });
        const traceActivationDelayMs = activeTraceState.activateForFleet === true
          ? null
          : resolveAbyssalTraceAutomaticActivationDelayMs(
            resolveAbyssalTraceProfile(activeTraceState),
          );
        if (publicationResult && publicationResult.success) {
          const publicationPersistResult = persistAbyssalTracePublicationState(
            activeTraceState,
            publicationResult,
            deps,
          );
          if (!publicationPersistResult.success) {
            log.warn(
              `[AbyssalTracePublication] trace=${toInt(activeTraceState.traceItemID, 0)} ` +
                `status=failed reason=${normalizeText(
                  publicationPersistResult.errorMsg,
                  "CLIENT_READY_RECEIPT_PERSIST_FAILED",
                )}`,
            );
          } else if (traceActivationDelayMs != null) {
            scheduleAutomaticTraceActivation(
              publicationPersistResult.state,
              session,
              deps,
              { resume: true },
            );
          }
        }
      }
    }
  }
  return clientEnvironmentDeliveryResult;
}

function reportClientReadyRequest(ports, args, session, request, clientEnvironmentDeliveryResult) {
  const {
    log,
    recordAuditEvent,
  } = ports;
  const { filamentCompensationReconcileResult, recoveryResult, refreshedContext, ballparkPrimeResult } = request;
  if (ballparkPrimeResult.attempted) {
    const message =
      `[AbyssalMgr] ClientIsReady ballpark bootstrap ` +
      `characterID=${ballparkPrimeResult.characterID} ` +
      `shipID=${ballparkPrimeResult.shipID} ` +
      `solarSystemID=${ballparkPrimeResult.solarSystemID} ` +
      `sceneFound=${ballparkPrimeResult.sceneFound} ` +
      `sessionAttached=${ballparkPrimeResult.sessionAttached} ` +
      `shipEntityFound=${ballparkPrimeResult.shipEntityFound} ` +
      `shipRegisteredDynamic=${ballparkPrimeResult.shipRegisteredDynamic} ` +
      `bubbleAssigned=${ballparkPrimeResult.bubbleAssigned} ` +
      `visibleDynamicCount=${ballparkPrimeResult.visibleDynamicCount} ` +
      `recipientCount=${ballparkPrimeResult.recipientCount} ` +
      `primed=${ballparkPrimeResult.primed} ` +
      `reason=${ballparkPrimeResult.reason}`;
    if (ballparkPrimeResult.primed) {
      log.info(message);
    } else {
      log.warn(message);
    }
  }
  recordAuditEvent("abyssal_client_is_ready", args, session, {
    systemID: refreshedContext.systemID,
    instanceID: toInt(session && session.abyssalInstanceID, 0),
    recovery: {
      recovered: Boolean(recoveryResult && recoveryResult.recovered === true),
      evacuated: Boolean(recoveryResult && recoveryResult.evacuated === true),
      reason: recoveryResult && recoveryResult.reason || null,
    },
    filamentCompensation: {
      success: filamentCompensationReconcileResult &&
        filamentCompensationReconcileResult.success === true,
      attempted: toInt(
        filamentCompensationReconcileResult &&
          filamentCompensationReconcileResult.attempted,
        0,
      ),
      refunded: toInt(
        filamentCompensationReconcileResult &&
          filamentCompensationReconcileResult.refunded,
        0,
      ),
    },
    ballparkPrime: {
      attempted: ballparkPrimeResult.attempted,
      primed: ballparkPrimeResult.primed,
      reason: ballparkPrimeResult.reason,
    },
    clientEnvironmentDelivery: clientEnvironmentDeliveryResult
      ? {
          success: clientEnvironmentDeliveryResult.success === true,
          skipped: clientEnvironmentDeliveryResult.skipped === true,
          reason: clientEnvironmentDeliveryResult.reason || null,
          status: clientEnvironmentDeliveryResult.state &&
            clientEnvironmentDeliveryResult.state.status || null,
        }
      : null,
  });
}

// The delivery reaches the client after its SetState: a bootstrap that only
// requested it delivers right after the batch that carries it
// (abyssalSetStateDelivery.js).
function handleAbyssalClientReady(ports, args, session, scheduleAutomaticTraceActivation) {
  const request = prepareClientReadyRequest(ports, session);
  const deliver = () => {
    const delivery = completeClientReadyDelivery(ports, session, request, scheduleAutomaticTraceActivation);
    reportClientReadyRequest(ports, args, session, request, delivery);
  };
  if (request.ballparkPrimeResult.primed === true) {
    runAfterSessionSetState(request.deps, session, deliver);
  } else {
    deliver();
  }
  return null;
}

function createAbyssalClientReadyRequest(ports) {
  return { handleAbyssalClientReady: handleAbyssalClientReady.bind(null, ports) };
}

module.exports = { createAbyssalClientReadyRequest };
