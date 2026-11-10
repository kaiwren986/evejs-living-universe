"use strict";

const runtime = require("../runtime/abyssalManagerRuntime");

function activateEntranceTrace(args, session) {
  return runtime.handleAbyssalEntranceGateActivation(args, session, 0);
}

function activateEndGate(args, session) {
  return runtime.handleAbyssalEndGateActivation(args, session);
}

function activateGate(args, session) {
  const deps = runtime.getDependencies();
  const validation = runtime.validateAbyssalExitTraceActivation(args, session, deps);
  const canRouteToEndGate =
    validation.success ||
    validation.errorMsg === "ABYSSAL_ROOM_OBJECTIVE_INCOMPLETE" ||
    validation.errorMsg === "ABYSSAL_ROOM_ENVIRONMENTAL_MECHANICS_BLOCKED" ||
    validation.errorMsg === "ABYSSAL_ROOM_PROGRESSION_BLOCKED_TIMEOUT" ||
    validation.errorMsg === "EXIT_TRACE_TOO_FAR" ||
    validation.errorMsg === "EXIT_TRACE_OWNER_MISMATCH";
  if (canRouteToEndGate) {
    runtime.recordAuditEvent("abyssal_gate_activation_routed_to_end_gate", args, session, {
      instanceID: validation.data && validation.data.pocketState
        ? validation.data.pocketState.instanceID
        : null,
      markerItemID: validation.data && validation.data.markerItemID || runtime.toInt(args && args[0], 0),
      activationMode: validation.data && validation.data.activationMode || null,
      validationError: validation.errorMsg || null,
    });
    runtime.log.info(
      `[AbyssalMgr] AbyssalGateActivation routed to end-gate handler ` +
        `char=${runtime.getCharacterID(session)} marker=${runtime.toInt(args && args[0], 0)} ` +
        `mode=${validation.data && validation.data.activationMode || "validation-error"} ` +
        `validation=${validation.errorMsg || "OK"}`,
    );
    return activateEndGate(args, session);
  }
  runtime.recordAuditEvent("abyssal_gate_activation_rejected", args, session);
  runtime.log.debug(
    `[AbyssalMgr] AbyssalGateActivation rejected reason=${validation.errorMsg || "UNKNOWN"}`,
  );
  runtime.throwGateRejected();
}

module.exports = Object.freeze({
  activateEndGate,
  activateEntranceTrace,
  activateGate,
});
