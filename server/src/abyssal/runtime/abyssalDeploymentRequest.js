"use strict";

const { normalizeText } = require("../domain/abyssalValueUtils");

// Client envelopes remain unchanged; each request owns its activation callback.
function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function validateDeploymentRequest(ports, args, session) {
  const {
    getDependencies,
    validateAbyssalEntranceDeployment,
    recordAuditEvent,
    log,
    getCharacterID,
    throwCustomNotify,
    ABYSS_ERROR_KIND,
    ABYSS_UNSUPPORTED_FILAMENT_NOTIFY,
    buildAbyssalSecurityRestrictionNotify,
    throwAbyssError,
    buildAbyssErrorFromValidationError,
  } = ports;
  const deps = getDependencies();
  const validation = validateAbyssalEntranceDeployment(args, session, deps);
  if (!validation.success) {
    recordAuditEvent("abyssal_entrance_deployment_validation_rejected", args, session, {
      error: validation.error,
    });
    log.info(
      `[AbyssalMgr] Entrance deployment rejected char=${getCharacterID(session)} code=${validation.error.code} details=${JSON.stringify(validation.error.details)}`,
    );
    if (
      validation.error &&
      validation.error.details &&
      String(validation.error.details.reason || "").startsWith("ACTIVE_")
    ) {
      log.info(
        `[AbyssalMgr] Active run rejected char=${getCharacterID(session)} reason=${validation.error.details.reason}`,
      );
      throwCustomNotify("An Abyssal run is already active.");
    }
    if (
      validation.error &&
      validation.error.kind === ABYSS_ERROR_KIND.UNSUPPORTED_FILAMENT_DEFINITION
    ) {
      throwCustomNotify(ABYSS_UNSUPPORTED_FILAMENT_NOTIFY);
    }
    if (validation.error) {
      const securityNotify = buildAbyssalSecurityRestrictionNotify(validation.error.details);
      if (securityNotify) {
        throwCustomNotify(securityNotify);
      }
    }
    throwAbyssError(buildAbyssErrorFromValidationError(validation.error));
  }
  return { deps, validation };
}

function deployRequestedTrace(ports, args, session, request) {
  const {
    recordAuditEvent,
    log,
    throwCustomNotify,
    throwAbyssError,
    deployPlaceholderTrace,
    ABYSS_ERROR,
    hasPendingDeployment,
    beginPendingDeployment,
    endPendingDeployment,
  } = ports;
  const { deps, validation } = request;
  const deployingCharacterID = toInt(validation.data.context.characterID, 0);
  if (hasPendingDeployment(deployingCharacterID)) {
    throwCustomNotify("An Abyssal Trace deployment is already in progress.");
  }
  beginPendingDeployment(deployingCharacterID);
  let deployResult;
  try {
    deployResult = deployPlaceholderTrace(validation, session, deps);
  } finally {
    endPendingDeployment(deployingCharacterID);
  }
  if (!deployResult.success) {
    recordAuditEvent("abyssal_entrance_deployment_trace_failed", args, session, {
      errorMsg: deployResult.errorMsg,
      filamentItemID: validation.data.filamentItem.itemID,
      shipTypeID: validation.data.shipItem.typeID,
    });
    log.warn(
      `[AbyssalMgr] Entrance deployment failed char=${validation.data.context.characterID} filament=${validation.data.filamentItem.itemID} system=${validation.data.context.systemID} reason=${deployResult.errorMsg}`,
    );
    throwAbyssError([[ABYSS_ERROR.TRACE_CREATION_FAILED, []]]);
  }
  return deployResult;
}

function finishDeploymentRequest(ports, args, session, request, deployResult, scheduleAutomaticTraceActivation) {
  const {
    recordAuditEvent,
    log,
    throwAbyssError,
    ABYSS_ERROR,
    buildAbyssalSuspectFlagResult,
    recordAndLogAbyssalSuspectFlagOutcome,
    scheduleCreatedAbyssalTraceExpiry,
    compensateFailedAbyssalDeployment,
  } = ports;
  const { deps, validation } = request;
  const traceState = deployResult.data.state;
  const suspectResult = buildAbyssalSuspectFlagResult(validation, {
    reason: validation.data.securityPolicy &&
      validation.data.securityPolicy.suspectRequired === true
      ? "DEFERRED_UNTIL_RETURN"
      : "NOT_REQUIRED",
  });
  recordAndLogAbyssalSuspectFlagOutcome(
    suspectResult,
    args,
    session,
    traceState.traceItemID,
  );
  recordAuditEvent("abyssal_entrance_deployment_placeholder_created", args, session, {
    traceItemID: traceState.traceItemID,
    shipClass: traceState.shipClass,
    requiredFilaments: traceState.requiredFilaments,
    filamentTypeID: traceState.filamentTypeID,
    activateForFleet: traceState.activateForFleet,
  });
  let automaticActivationResult = {
    success: true,
    scheduled: false,
    skipped: true,
    reason: "MANUAL_SMALL_HULL_TRACE_ACTIVATION_REQUIRED",
  };
  if (traceState.activateForFleet !== true) {
    try {
      automaticActivationResult = scheduleAutomaticTraceActivation(
        traceState,
        session,
        deps,
      );
    } catch (error) {
      automaticActivationResult = {
        success: false,
        errorMsg: normalizeText(
          error && error.message,
          "TRACE_ACTIVATION_SCHEDULING_FAILED",
        ),
      };
    }
  }
  const expiryScheduleResult = automaticActivationResult.success
    ? scheduleCreatedAbyssalTraceExpiry(
        traceState,
        deps,
        "unused-created-trace-expired",
      )
    : { success: false, scheduled: false, skipped: true };
  if (!automaticActivationResult.success || !expiryScheduleResult.success) {
    const schedulingErrorMsg = normalizeText(
      automaticActivationResult.success
        ? expiryScheduleResult.errorMsg
        : automaticActivationResult.errorMsg,
      automaticActivationResult.success
        ? "TRACE_EXPIRY_SCHEDULING_FAILED"
        : "TRACE_ACTIVATION_SCHEDULING_FAILED",
    );
    const compensationResult = compensateFailedAbyssalDeployment(
      validation,
      deployResult.data.consumeResult,
      traceState,
      session,
      deps,
      schedulingErrorMsg,
    );
    recordAuditEvent("abyssal_entrance_deployment_schedule_failed", args, session, {
      traceItemID: traceState.traceItemID,
      errorMsg: schedulingErrorMsg,
      automaticActivationScheduled: automaticActivationResult.success === true,
      expiryScheduled: expiryScheduleResult.success === true,
      refunded: compensationResult.refunded === true,
      invalidationMode: compensationResult.invalidationResult &&
        compensationResult.invalidationResult.invalidationMode || null,
    });
    throwAbyssError([[ABYSS_ERROR.TRACE_CREATION_FAILED, []]]);
  }
  log.info(
    `[AbyssalMgr] Abyssal trace deployed char=${traceState.characterID} traceID=${traceState.traceItemID} ship=${traceState.shipID} class=${traceState.shipClass} filaments=${traceState.requiredFilaments} system=${traceState.solarSystemID}`,
  );
  return null;
}

function handleAbyssalEntranceDeployment(ports, args, session, scheduleAutomaticTraceActivation) {
  const request = validateDeploymentRequest(ports, args, session);
  const deployResult = deployRequestedTrace(ports, args, session, request);
  return finishDeploymentRequest(ports, args, session, request, deployResult, scheduleAutomaticTraceActivation);
}

function createAbyssalDeploymentRequest(ports) {
  return { handleAbyssalEntranceDeployment: handleAbyssalEntranceDeployment.bind(null, ports) };
}

module.exports = { createAbyssalDeploymentRequest };
