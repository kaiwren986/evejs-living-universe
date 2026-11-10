"use strict";

const { normalizeText } = require("../domain/abyssalValueUtils");

// Existing participant, controller and maintenance authorities remain injected.
function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function normalizeAbyssalMaintenanceDiagnosticText(ports, value, fallback = "") {
  return normalizeText(value, fallback)
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .slice(0, 512);
}

function recordAbyssalMaintenanceFailure(ports,
  instanceID,
  pocketState,
  error,
  operation,
) {
  const {
    recordAuditEvent,
    log,
    getRunByInstanceID,
  } = ports;
  const numericInstanceID = toInt(instanceID, 0);
  const authoritativePocketState = numericInstanceID > 0
    ? getRunByInstanceID(numericInstanceID) || pocketState
    : pocketState;
  const pendingTransitionState =
    authoritativePocketState &&
    authoritativePocketState.pendingTransitionState &&
    typeof authoritativePocketState.pendingTransitionState === "object"
      ? authoritativePocketState.pendingTransitionState
      : {};
  const timerState =
    authoritativePocketState &&
    authoritativePocketState.timerState &&
    typeof authoritativePocketState.timerState === "object"
      ? authoritativePocketState.timerState
      : {};
  const diagnostic = {
    operation: normalizeAbyssalMaintenanceDiagnosticText(ports,
      operation,
      "placeholder-pocket-maintenance",
    ),
    instanceID: numericInstanceID,
    characterID: toInt(authoritativePocketState && authoritativePocketState.characterID, 0),
    roomIndex: toInt(
      authoritativePocketState &&
        authoritativePocketState.roomState &&
        authoritativePocketState.roomState.currentRoomIndex,
      toInt(authoritativePocketState && authoritativePocketState.currentRoomIndex, 0),
    ),
    state: normalizeAbyssalMaintenanceDiagnosticText(ports,
      authoritativePocketState && authoritativePocketState.runOutcome,
      normalizeAbyssalMaintenanceDiagnosticText(ports,
        authoritativePocketState && authoritativePocketState.timerFailureState,
        normalizeAbyssalMaintenanceDiagnosticText(ports, timerState.status, "active"),
      ),
    ),
    lifecycleState: normalizeAbyssalMaintenanceDiagnosticText(ports,
      authoritativePocketState && authoritativePocketState.lifecycleState,
      normalizeAbyssalMaintenanceDiagnosticText(ports,
        pendingTransitionState.lifecycleState,
        normalizeAbyssalMaintenanceDiagnosticText(ports,
          pendingTransitionState.status,
          "active",
        ),
      ),
    ),
    errorName: normalizeAbyssalMaintenanceDiagnosticText(ports,
      error && error.name,
      "Error",
    ),
    errorMessage: normalizeAbyssalMaintenanceDiagnosticText(ports,
      error && error.message,
      "ABYSSAL_MAINTENANCE_FAILURE",
    ),
  };
  recordAuditEvent("abyssal_placeholder_maintenance_failed", [], null, diagnostic);
  log.error(
    `[AbyssalMaintenance] operation=${diagnostic.operation} ` +
      `run=${diagnostic.instanceID || "none"} char=${diagnostic.characterID || "none"} ` +
      `room=${diagnostic.roomIndex || "none"} state=${diagnostic.state} ` +
      `lifecycle=${diagnostic.lifecycleState} errorName=${diagnostic.errorName} ` +
      `error=${diagnostic.errorMessage}`,
  );
}

function clearPlaceholderPocketMaintenance(ports, deps = ports.getDependencies()) {
  const {
    cancelMaintenanceTimerHandle,
  } = ports;
  return cancelMaintenanceTimerHandle(
    deps && deps.clearScheduledTimeout,
  );
}

function purgePlaceholderPocket(ports, instanceID, deps, reason = "cleanup") {
  const {
    log,
    cleanupBoundaryControllersForRun,
    cleanupSuppressorControllersForRun,
    cleanupSuppressorPresentationStatesForRun,
    clearSuppressorDebugForRun,
    unregisterPocket,
    formatVectorForLog,
    getSpatialReservation,
    releaseSpatialReservation,
  } = ports;
  const numericInstanceID = toInt(instanceID, 0);
  try {
    const reservation = getSpatialReservation(numericInstanceID);
    cleanupBoundaryControllersForRun(numericInstanceID, reason);
    cleanupSuppressorControllersForRun(numericInstanceID, reason);
    cleanupSuppressorPresentationStatesForRun(numericInstanceID);
    clearSuppressorDebugForRun(numericInstanceID);
    if (deps.dungeonRuntime && typeof deps.dungeonRuntime.purgeInstance === "function") {
      deps.dungeonRuntime.purgeInstance(numericInstanceID);
    }
    unregisterPocket(numericInstanceID);
    const releaseResult = reservation
      ? releaseSpatialReservation(numericInstanceID, {
          hostSystemID: reservation.hostSystemID,
          slotID: reservation.slotID,
        })
      : { success: true, alreadyReleased: true };
    if (!releaseResult || releaseResult.success !== true) {
      throw new Error(normalizeText(
        releaseResult && releaseResult.errorMsg,
        "ABYSSAL_SPATIAL_RESERVATION_RELEASE_FAILED",
      ));
    }
    if (reservation) {
      log.info(
        `[AbyssalSpatialReservation] run=${numericInstanceID} ` +
          `host=${reservation.hostSystemID} slot=${reservation.slotID} ` +
          `origin=${formatVectorForLog(reservation.spatialOrigin)} ` +
          `scene=${reservation.sceneID} reason=${reason} state=released`,
      );
    }
    return true;
  } catch (error) {
    log.warn(
      `[AbyssalMgr] Failed to purge Abyssal run instance=${numericInstanceID} reason=${reason} error=${error.message}`,
    );
    return false;
  }
}

function createAbyssalMaintenanceControl(ports) {
  return {
    normalizeAbyssalMaintenanceDiagnosticText: normalizeAbyssalMaintenanceDiagnosticText.bind(null, ports),
    recordAbyssalMaintenanceFailure: recordAbyssalMaintenanceFailure.bind(null, ports),
    clearPlaceholderPocketMaintenance: clearPlaceholderPocketMaintenance.bind(null, ports),
    purgePlaceholderPocket: purgePlaceholderPocket.bind(null, ports),
  };
}

module.exports = { createAbyssalMaintenanceControl };
