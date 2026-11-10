"use strict";

const ABYSSAL_PARTICIPANT_DESTRUCTION_KIND = Object.freeze({
  HULL: "hull",
  POD: "pod",
});

function toPositiveInteger(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.trunc(numeric) : 0;
}

function normalizeErrorMessage(value, fallback) {
  const normalized = String(value || "").trim();
  return normalized || fallback;
}

function resolveSessionActiveShipID(session) {
  return toPositiveInteger(
    session && session._space && session._space.shipID ||
    session && session.shipid ||
    session && session.shipID,
  );
}

function createAbyssalParticipantDestructionExecutor(dependencies = {}) {
  const destroySessionShip = dependencies.destroySessionShip;

  function executePhysicalDestruction(request, destructionKind, fallbackErrorMsg) {
    const normalizedRequest = request && typeof request === "object" ? request : {};
    const expectedShipID = toPositiveInteger(normalizedRequest.expectedShipID);
    const suppliedPhysicalResult = normalizedRequest.physicalResult || null;

    if (normalizedRequest.alreadyDestroyed === true) {
      return {
        success: true,
        attempted: false,
        executed: false,
        alreadyDestroyed: true,
        destructionKind,
        expectedShipID,
        physicalResult: suppliedPhysicalResult,
        errorMsg: "",
      };
    }

    if (typeof destroySessionShip !== "function") {
      const physicalResult = {
        success: false,
        errorMsg: "SHIP_DESTRUCTION_HOOK_UNAVAILABLE",
      };
      return {
        success: false,
        attempted: false,
        executed: false,
        alreadyDestroyed: false,
        destructionKind,
        expectedShipID,
        physicalResult,
        errorMsg: physicalResult.errorMsg,
      };
    }

    const activeShipID = resolveSessionActiveShipID(normalizedRequest.session);
    if (
      expectedShipID > 0 &&
      activeShipID > 0 &&
      activeShipID !== expectedShipID
    ) {
      const physicalResult = {
        success: false,
        errorMsg: "EXPECTED_ABYSSAL_SHIP_ID_MISMATCH",
        expectedShipID,
        activeShipID,
      };
      return {
        success: false,
        attempted: false,
        executed: false,
        alreadyDestroyed: false,
        destructionKind,
        expectedShipID,
        physicalResult,
        errorMsg: physicalResult.errorMsg,
      };
    }

    const destructionContext =
      normalizedRequest.destructionContext &&
      typeof normalizedRequest.destructionContext === "object"
        ? normalizedRequest.destructionContext
        : {};
    const destructionOptions = { ...destructionContext };

    let physicalResult = null;
    try {
      physicalResult = destroySessionShip(
        normalizedRequest.session || null,
        destructionOptions,
      );
    } catch (error) {
      physicalResult = {
        success: false,
        errorMsg: normalizeErrorMessage(error && error.message, fallbackErrorMsg),
      };
    }

    const success = Boolean(physicalResult && physicalResult.success === true);
    return {
      success,
      attempted: true,
      executed: success,
      alreadyDestroyed: false,
      destructionKind,
      expectedShipID,
      physicalResult,
      errorMsg: success
        ? ""
        : normalizeErrorMessage(
            physicalResult && physicalResult.errorMsg,
            fallbackErrorMsg,
          ),
    };
  }

  return Object.freeze({
    executeHullDestruction(request = {}) {
      return executePhysicalDestruction(
        request,
        ABYSSAL_PARTICIPANT_DESTRUCTION_KIND.HULL,
        "SHIP_DESTRUCTION_REQUEST_FAILED",
      );
    },
    executePodDestruction(request = {}) {
      return executePhysicalDestruction(
        request,
        ABYSSAL_PARTICIPANT_DESTRUCTION_KIND.POD,
        "POD_DESTRUCTION_REQUEST_FAILED",
      );
    },
  });
}

module.exports = {
  ABYSSAL_PARTICIPANT_DESTRUCTION_KIND,
  createAbyssalParticipantDestructionExecutor,
};
