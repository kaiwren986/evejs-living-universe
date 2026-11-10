"use strict";

const ABYSSAL_SURVIVOR_CONTROLLER_HANDOFF_STATUS = Object.freeze({
  HANDOFF: "handoff",
  CURRENT_CONTROLLER_RETAINED: "current_controller_retained",
  HANDOFF_UNNECESSARY: "handoff_unnecessary",
  SURVIVOR_WITHOUT_LIVE_CONTROLLER: "survivor_without_live_controller",
  NO_SURVIVOR: "no_survivor",
  INVALID_IDENTITY: "invalid_identity",
  HANDOFF_FAILED: "handoff_failed",
});

const SURVIVING_PARTICIPANT_STATUSES = new Set([
  "active",
  "disconnected",
  "admitting",
]);

const LIVE_CONTROLLER_PARTICIPANT_STATUSES = new Set([
  "active",
  "disconnected",
]);

function toInteger(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function normalizeText(value, fallback = "") {
  const normalized = String(value == null ? "" : value).trim();
  return normalized || fallback;
}

function listUniquePositiveIntegers(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => toInteger(value, 0))
    .filter((value) => value > 0))];
}

function normalizeParticipant(participant) {
  if (!participant || typeof participant !== "object") return null;
  const characterID = toInteger(participant.characterID, 0);
  const shipID = toInteger(participant.shipID, 0);
  if (characterID <= 0) return null;
  return {
    characterID,
    shipID,
    role: normalizeText(participant.role, "member").toLowerCase() === "owner"
      ? "owner"
      : "member",
    status: normalizeText(participant.status, "reserved").toLowerCase(),
    currentRoomIndex: toInteger(participant.currentRoomIndex, 0),
    destroyedAtMs: toInteger(participant.destroyedAtMs, 0),
    exitedAtMs: toInteger(participant.exitedAtMs, 0),
    controllerAuthority:
      participant.controllerAuthority &&
      typeof participant.controllerAuthority === "object"
        ? participant.controllerAuthority
        : null,
  };
}

function compareParticipants(left, right) {
  if (left.role !== right.role) return left.role === "owner" ? -1 : 1;
  return left.characterID - right.characterID;
}

function controllerAuthorityMatches(
  authority,
  participant,
  instanceID,
  roomIndex,
  sceneKey,
) {
  if (!authority || authority.available !== true) return false;
  if (authority.registered !== true || authority.destroyed === true) return false;
  if (authority.incapacitated === true) return false;
  if (toInteger(authority.instanceID, 0) !== instanceID) return false;
  if (toInteger(authority.roomIndex, 0) !== roomIndex) return false;
  if (toInteger(authority.shipID, 0) !== participant.shipID) return false;
  const authorityCharacterID = toInteger(authority.characterID, 0);
  if (
    authorityCharacterID > 0 &&
    authorityCharacterID !== participant.characterID
  ) {
    return false;
  }
  const authoritySceneKey = normalizeText(authority.sceneKey, "");
  return !sceneKey || authoritySceneKey === sceneKey;
}

function buildSelectionResult({
  status,
  reason,
  instanceID,
  roomIndex,
  sceneKey,
  ownerCharacterID,
  survivorCharacterIDs = [],
  candidates = [],
  selected = null,
}) {
  const authority = selected && selected.controllerAuthority;
  return {
    status,
    reason,
    success: Boolean(selected),
    survivorExists: survivorCharacterIDs.length > 0,
    liveControllerAvailable: Boolean(selected),
    instanceID,
    roomIndex,
    sceneKey,
    ownerCharacterID,
    survivorCharacterIDs: [...survivorCharacterIDs],
    candidateCharacterIDs: candidates.map((candidate) => candidate.characterID),
    candidateShipIDs: candidates.map((candidate) => candidate.shipID),
    participant: selected
      ? {
          characterID: selected.characterID,
          shipID: selected.shipID,
          role: selected.role,
          status: selected.status,
          currentRoomIndex: selected.currentRoomIndex,
          destroyedAtMs: selected.destroyedAtMs,
          exitedAtMs: selected.exitedAtMs,
        }
      : null,
    characterID: selected ? selected.characterID : 0,
    shipID: selected ? selected.shipID : 0,
    controllerRef: authority && authority.controllerRef || null,
  };
}

function selectAbyssalSurvivorController(request = {}) {
  const instanceID = toInteger(request.instanceID, 0);
  const roomIndex = toInteger(request.roomIndex, 0);
  const sceneKey = normalizeText(request.sceneKey, "");
  const ownerCharacterID = toInteger(request.ownerCharacterID, 0);
  const excludedCharacterID = toInteger(request.excludedCharacterID, 0);
  if (instanceID <= 0 || roomIndex <= 0 || ownerCharacterID <= 0) {
    return buildSelectionResult({
      status: ABYSSAL_SURVIVOR_CONTROLLER_HANDOFF_STATUS.INVALID_IDENTITY,
      reason: "ABYSSAL_SURVIVOR_CONTROLLER_REQUEST_IDENTITY_INVALID",
      instanceID,
      roomIndex,
      sceneKey,
      ownerCharacterID,
    });
  }

  const participants = (Array.isArray(request.participants)
    ? request.participants
    : [])
    .map(normalizeParticipant)
    .filter(Boolean)
    .sort(compareParticipants);
  const survivors = participants.filter((participant) =>
    participant.characterID !== excludedCharacterID &&
    SURVIVING_PARTICIPANT_STATUSES.has(participant.status) &&
    participant.destroyedAtMs <= 0 &&
    participant.exitedAtMs <= 0
  );
  const survivorCharacterIDs = survivors.map((participant) =>
    participant.characterID
  );
  if (survivors.length <= 0) {
    return buildSelectionResult({
      status: ABYSSAL_SURVIVOR_CONTROLLER_HANDOFF_STATUS.NO_SURVIVOR,
      reason: "ABYSSAL_SURVIVOR_CONTROLLER_NO_SURVIVOR",
      instanceID,
      roomIndex,
      sceneKey,
      ownerCharacterID,
    });
  }

  const liveStatusParticipants = survivors.filter((participant) =>
    participant.shipID > 0 &&
    participant.currentRoomIndex === roomIndex &&
    LIVE_CONTROLLER_PARTICIPANT_STATUSES.has(participant.status)
  );
  const candidates = liveStatusParticipants.filter((participant) =>
    controllerAuthorityMatches(
      participant.controllerAuthority,
      participant,
      instanceID,
      roomIndex,
      sceneKey,
    )
  );
  if (candidates.length <= 0) {
    const identityMismatch = liveStatusParticipants.some((participant) =>
      participant.controllerAuthority &&
      participant.controllerAuthority.available === true
    );
    return buildSelectionResult({
      status: identityMismatch
        ? ABYSSAL_SURVIVOR_CONTROLLER_HANDOFF_STATUS.INVALID_IDENTITY
        : ABYSSAL_SURVIVOR_CONTROLLER_HANDOFF_STATUS
          .SURVIVOR_WITHOUT_LIVE_CONTROLLER,
      reason: identityMismatch
        ? "ABYSSAL_SURVIVOR_CONTROLLER_IDENTITY_MISMATCH"
        : "ABYSSAL_SURVIVOR_CONTROLLER_UNAVAILABLE",
      instanceID,
      roomIndex,
      sceneKey,
      ownerCharacterID,
      survivorCharacterIDs,
    });
  }

  let selected = null;
  for (const preferredShipID of listUniquePositiveIntegers(
    request.preferredShipIDs,
  )) {
    selected = candidates.find((candidate) =>
      candidate.shipID === preferredShipID
    ) || null;
    if (selected) break;
  }
  const preferredCharacterID = toInteger(request.preferredCharacterID, 0);
  if (!selected && preferredCharacterID > 0) {
    selected = candidates.find((candidate) =>
      candidate.characterID === preferredCharacterID
    ) || null;
  }
  selected = selected || candidates[0];

  return buildSelectionResult({
    status: "controller_selected",
    reason: "OK",
    instanceID,
    roomIndex,
    sceneKey,
    ownerCharacterID,
    survivorCharacterIDs,
    candidates,
    selected,
  });
}

function buildHandoffResult(selection, patch = {}) {
  return {
    ...selection,
    handoffPerformed: false,
    controllerRetained: false,
    applyAttempted: false,
    applyResult: null,
    previousControllerShipID: 0,
    previousPreferredControllerShipID: 0,
    ...patch,
  };
}

function createAbyssalSurvivorControllerHandoffCoordinator(
  dependencies = {},
) {
  const { revalidateControllerSelection, applyControllerHandoff } = dependencies;
  if (typeof revalidateControllerSelection !== "function") {
    throw new TypeError("revalidateControllerSelection dependency is required");
  }
  if (typeof applyControllerHandoff !== "function") {
    throw new TypeError("applyControllerHandoff dependency is required");
  }

  function handoffSurvivorController(request = {}) {
    const initialSelection = selectAbyssalSurvivorController(request);
    if (!initialSelection.liveControllerAvailable) {
      return buildHandoffResult(initialSelection);
    }

    const previousControllerShipID = toInteger(
      request.currentControllerShipID,
      0,
    );
    const previousPreferredControllerShipID = toInteger(
      request.preferredControllerShipID,
      0,
    );
    const hasExistingController = previousControllerShipID > 0 ||
      previousPreferredControllerShipID > 0;
    if (!hasExistingController) {
      return buildHandoffResult(initialSelection, {
        status: ABYSSAL_SURVIVOR_CONTROLLER_HANDOFF_STATUS.HANDOFF_UNNECESSARY,
        reason: "ABYSSAL_SURVIVOR_CONTROLLER_NOT_YET_BOUND",
        previousControllerShipID,
        previousPreferredControllerShipID,
      });
    }

    const alreadyBound =
      previousPreferredControllerShipID === initialSelection.shipID &&
      (
        request.controllerPaused === true ||
        previousControllerShipID === initialSelection.shipID
      );
    if (alreadyBound) {
      return buildHandoffResult(initialSelection, {
        status:
          ABYSSAL_SURVIVOR_CONTROLLER_HANDOFF_STATUS
            .CURRENT_CONTROLLER_RETAINED,
        reason: "ABYSSAL_SURVIVOR_CONTROLLER_ALREADY_CURRENT",
        controllerRetained: true,
        previousControllerShipID,
        previousPreferredControllerShipID,
      });
    }

    const revalidatedSelection = revalidateControllerSelection({
      controllerID: toInteger(request.controllerID, 0),
      instanceID: initialSelection.instanceID,
      roomIndex: initialSelection.roomIndex,
      sceneKey: initialSelection.sceneKey,
      ownerCharacterID: initialSelection.ownerCharacterID,
      requestedCharacterID: initialSelection.characterID,
      requestedShipID: initialSelection.shipID,
    });
    if (
      !revalidatedSelection ||
      revalidatedSelection.instanceID !== initialSelection.instanceID ||
      revalidatedSelection.roomIndex !== initialSelection.roomIndex ||
      normalizeText(revalidatedSelection.sceneKey, "") !==
        initialSelection.sceneKey ||
      revalidatedSelection.ownerCharacterID !== initialSelection.ownerCharacterID ||
      revalidatedSelection.liveControllerAvailable !== true
    ) {
      const failedSelection = revalidatedSelection &&
        typeof revalidatedSelection === "object"
        ? revalidatedSelection
        : buildSelectionResult({
            status:
              ABYSSAL_SURVIVOR_CONTROLLER_HANDOFF_STATUS.INVALID_IDENTITY,
            reason: "ABYSSAL_SURVIVOR_CONTROLLER_REVALIDATION_FAILED",
            instanceID: initialSelection.instanceID,
            roomIndex: initialSelection.roomIndex,
            sceneKey: initialSelection.sceneKey,
            ownerCharacterID: initialSelection.ownerCharacterID,
            survivorCharacterIDs: initialSelection.survivorCharacterIDs,
          });
      return buildHandoffResult(failedSelection, {
        status: failedSelection.status ===
          ABYSSAL_SURVIVOR_CONTROLLER_HANDOFF_STATUS.NO_SURVIVOR
          ? failedSelection.status
          : failedSelection.status ===
              ABYSSAL_SURVIVOR_CONTROLLER_HANDOFF_STATUS
                .SURVIVOR_WITHOUT_LIVE_CONTROLLER
            ? failedSelection.status
            : ABYSSAL_SURVIVOR_CONTROLLER_HANDOFF_STATUS.INVALID_IDENTITY,
        reason: normalizeText(
          failedSelection.reason,
          "ABYSSAL_SURVIVOR_CONTROLLER_REVALIDATION_FAILED",
        ),
        previousControllerShipID,
        previousPreferredControllerShipID,
      });
    }

    const applyRequest = {
      controllerID: toInteger(request.controllerID, 0),
      instanceID: revalidatedSelection.instanceID,
      roomIndex: revalidatedSelection.roomIndex,
      sceneKey: revalidatedSelection.sceneKey,
      ownerCharacterID: revalidatedSelection.ownerCharacterID,
      previousControllerShipID,
      previousPreferredControllerShipID,
      successorCharacterID: revalidatedSelection.characterID,
      successorShipID: revalidatedSelection.shipID,
      controllerRef: revalidatedSelection.controllerRef,
      keepLock: request.keepLock !== false,
    };
    const applyResult = applyControllerHandoff(applyRequest);
    if (!applyResult || applyResult.success === false) {
      return buildHandoffResult(revalidatedSelection, {
        status: ABYSSAL_SURVIVOR_CONTROLLER_HANDOFF_STATUS.HANDOFF_FAILED,
        reason: normalizeText(
          applyResult && applyResult.errorMsg,
          "ABYSSAL_SURVIVOR_CONTROLLER_HANDOFF_FAILED",
        ),
        applyAttempted: true,
        applyResult: applyResult || null,
        previousControllerShipID,
        previousPreferredControllerShipID,
      });
    }

    return buildHandoffResult(revalidatedSelection, {
      status: ABYSSAL_SURVIVOR_CONTROLLER_HANDOFF_STATUS.HANDOFF,
      reason: "OK",
      handoffPerformed: true,
      applyAttempted: true,
      applyResult,
      previousControllerShipID,
      previousPreferredControllerShipID,
    });
  }

  return Object.freeze({ handoffSurvivorController });
}

module.exports = {
  ABYSSAL_SURVIVOR_CONTROLLER_HANDOFF_STATUS,
  LIVE_CONTROLLER_PARTICIPANT_STATUSES,
  SURVIVING_PARTICIPANT_STATUSES,
  createAbyssalSurvivorControllerHandoffCoordinator,
  selectAbyssalSurvivorController,
};
