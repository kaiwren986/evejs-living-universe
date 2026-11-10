"use strict";

const runtime = require("../runtime/abyssalManagerRuntime");
const runtimeFacade = require("../runtime/abyssalRuntimeFacade");
const BaseService = runtime.BaseService;

class AbyssalMgrService extends runtime.BaseService {
  constructor() {
    super("abyssalMgr");
    this._automaticTraceActivationTraceID = 0;
  }

  callMethod(method, args, session, kwargs) {
    const normalizedMethod = runtime.BaseService.normalizeMethodName(method);
    if (!runtime.ABYSSAL_MGR_CLIENT_RPC_METHODS.has(normalizedMethod)) {
      runtime.log.warn(
        `[AbyssalMgr] Rejected non-client RPC method=${JSON.stringify(normalizedMethod)} ` +
          `character=${(0, runtime.getCharacterID)(session)}`,
      );
      return null;
    }
    return super.callMethod(normalizedMethod, args, session, kwargs);
  }

  _runAutomaticTraceActivation(session, traceItemID) {
    const previousTraceItemID = this._automaticTraceActivationTraceID;
    this._automaticTraceActivationTraceID = (0, runtime.toInt)(traceItemID, 0);
    try {
      return this.Handle_AbyssalEntranceGateActivation([traceItemID], session);
    } finally {
      this._automaticTraceActivationTraceID = previousTraceItemID;
    }
  }

  _scheduleAutomaticTraceActivation(traceState, session, deps, options = {}) {
    return (0, runtime.schedulePendingAbyssalTraceActivation)(
      traceState,
      session,
      (activationSession, traceItemID) =>
        this._runAutomaticTraceActivation(activationSession, traceItemID),
      deps,
      options,
    );
  }

  Handle_AbyssalEntranceDeployment(args, session) {
    return (0, runtime.handleAbyssalEntranceDeployment)(
      args, session, (...values) => this._scheduleAutomaticTraceActivation(...values),
    );
  }

  Handle_AbyssalEntranceGateActivation(args, session) {
    return (0, runtime.handleAbyssalEntranceGateActivation)(args, session, this._automaticTraceActivationTraceID);
  }

  Handle_AbyssalGateActivation(args, session) {
    const deps = (0, runtime.getDependencies)();
    const validation = (0, runtime.validateAbyssalExitTraceActivation)(args, session, deps);
    const canRouteToEndGate =
      validation.success ||
      validation.errorMsg === "ABYSSAL_ROOM_OBJECTIVE_INCOMPLETE" ||
      validation.errorMsg === "ABYSSAL_ROOM_ENVIRONMENTAL_MECHANICS_BLOCKED" ||
      validation.errorMsg === "ABYSSAL_ROOM_PROGRESSION_BLOCKED_TIMEOUT" ||
      validation.errorMsg === "EXIT_TRACE_TOO_FAR" ||
      validation.errorMsg === "EXIT_TRACE_OWNER_MISMATCH";
    if (canRouteToEndGate) {
      (0, runtime.recordAuditEvent)("abyssal_gate_activation_routed_to_end_gate", args, session, {
        instanceID: validation.data && validation.data.pocketState
          ? validation.data.pocketState.instanceID
          : null,
        markerItemID: validation.data && validation.data.markerItemID || (0, runtime.toInt)(args && args[0], 0),
        activationMode: validation.data && validation.data.activationMode || null,
        validationError: validation.errorMsg || null,
      });
      runtime.log.info(
        `[AbyssalMgr] AbyssalGateActivation routed to end-gate handler ` +
          `char=${(0, runtime.getCharacterID)(session)} marker=${(0, runtime.toInt)(args && args[0], 0)} ` +
          `mode=${validation.data && validation.data.activationMode || "validation-error"} ` +
          `validation=${validation.errorMsg || "OK"}`,
      );
      return this.Handle_AbyssalEndGateActivation(args, session);
    }
    (0, runtime.recordAuditEvent)("abyssal_gate_activation_rejected", args, session);
    runtime.log.debug(
      `[AbyssalMgr] AbyssalGateActivation rejected reason=${validation.errorMsg || "UNKNOWN"}`,
    );
    (0, runtime.throwGateRejected)();
  }

  Handle_AbyssalEndGateActivation(args, session) {
    return (0, runtime.handleAbyssalEndGateActivation)(args, session);
  }

  Handle_ClientIsReady(args, session) {
    return (0, runtime.handleAbyssalClientReady)(
      args, session, (...values) => this._scheduleAutomaticTraceActivation(...values),
    );
  }
}

for (const propertyName of Reflect.ownKeys(runtimeFacade)) {
  if (propertyName === "ABYSSAL_INTERNAL_BYPASS") {
    Object.defineProperty(AbyssalMgrService, propertyName, {
      value: runtimeFacade[propertyName],
    });
    continue;
  }
  Object.defineProperty(AbyssalMgrService, propertyName, {
    configurable: true,
    enumerable: true,
    get() {
      return runtimeFacade[propertyName];
    },
    set(value) {
      runtimeFacade[propertyName] = value;
    },
  });
}

module.exports = AbyssalMgrService;
