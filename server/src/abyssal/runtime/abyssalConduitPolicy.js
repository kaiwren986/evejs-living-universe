"use strict";

const ABYSSAL_CONDUIT_DECISION_STAGE = Object.freeze({
  CONDUIT_IDENTITY: "conduitIdentity",
  AUTHORIZATION: "authorization",
  TERMINAL: "terminal",
  RUNTIME: "runtime",
  RANGE: "range",
  OBJECTIVE: "objective",
  TRANSITION: "transition",
  PROGRESSION: "progression",
});

const ABYSSAL_CONDUIT_PROGRESSION_KIND = Object.freeze({
  NEXT_ROOM: "nextRoom",
  FINAL_EXIT: "finalExit",
});

const ORDERED_DECISION_STAGES = Object.freeze([
  ABYSSAL_CONDUIT_DECISION_STAGE.CONDUIT_IDENTITY,
  ABYSSAL_CONDUIT_DECISION_STAGE.AUTHORIZATION,
  ABYSSAL_CONDUIT_DECISION_STAGE.TERMINAL,
  ABYSSAL_CONDUIT_DECISION_STAGE.RUNTIME,
  ABYSSAL_CONDUIT_DECISION_STAGE.RANGE,
  ABYSSAL_CONDUIT_DECISION_STAGE.OBJECTIVE,
  ABYSSAL_CONDUIT_DECISION_STAGE.TRANSITION,
  ABYSSAL_CONDUIT_DECISION_STAGE.PROGRESSION,
]);

function toInteger(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function normalizeText(value, fallback = "") {
  const normalized = String(value == null ? "" : value).trim();
  return normalized || fallback;
}

function buildAllowedDecision(stage, progression = null) {
  return {
    allowed: true,
    reason: "ALLOWED",
    stage,
    ...(progression ? { progression } : {}),
  };
}

function buildRejectedDecision(reason, stage, extra = null) {
  return {
    allowed: false,
    reason,
    stage,
    ...(extra && typeof extra === "object" ? extra : {}),
  };
}

function resolveThroughStage(value) {
  const normalized = normalizeText(
    value,
    ABYSSAL_CONDUIT_DECISION_STAGE.PROGRESSION,
  );
  return ORDERED_DECISION_STAGES.includes(normalized)
    ? normalized
    : ABYSSAL_CONDUIT_DECISION_STAGE.PROGRESSION;
}

function reachedThroughStage(throughStage, currentStage) {
  return ORDERED_DECISION_STAGES.indexOf(throughStage) <=
    ORDERED_DECISION_STAGES.indexOf(currentStage);
}

function isAbyssalFinalRoomIndex(input = {}) {
  const roomCount = Math.max(1, toInteger(input.roomCount, 1));
  const roomIndex = Math.min(
    roomCount,
    Math.max(1, toInteger(input.roomIndex, 1)),
  );
  return roomIndex >= roomCount;
}

function evaluateAbyssalRoomObjectiveEligibility(input = {}) {
  const blocked = Boolean(
    input.failedTimeout === true ||
      input.npcActivationDegraded === true ||
      input.roomEncounterSpawnFailed === true ||
      input.runEncounterSpawnFailed === true,
  );
  const allowed = Boolean(
    !blocked &&
      (input.objectiveComplete === true || input.allowDebugExit === true),
  );
  return allowed
    ? buildAllowedDecision(ABYSSAL_CONDUIT_DECISION_STAGE.OBJECTIVE)
    : buildRejectedDecision(
        "ABYSSAL_ROOM_OBJECTIVE_INCOMPLETE",
        ABYSSAL_CONDUIT_DECISION_STAGE.OBJECTIVE,
      );
}

function resolveAbyssalRoomProgression(input = {}) {
  const roomCount = Math.max(1, toInteger(input.roomCount, 1));
  const fromRoomIndex = Math.min(
    roomCount,
    Math.max(1, toInteger(input.currentRoomIndex, 1)),
  );
  const finalRoom = isAbyssalFinalRoomIndex({
    roomIndex: fromRoomIndex,
    roomCount,
  });
  const finalExit = Boolean(
    input.failedTimeout !== true &&
      (
        input.finalExitAvailable === true ||
        finalRoom ||
        (
          input.allowDebugExit === true &&
          input.npcActivationDegraded !== true
        ) ||
        input.terminalFailure === true
      )
  );

  if (finalExit) {
    return {
      kind: ABYSSAL_CONDUIT_PROGRESSION_KIND.FINAL_EXIT,
      activationMode: "final_exit",
      fromRoomIndex,
      toRoomIndex: 0,
      roomCount,
    };
  }
  return {
    kind: ABYSSAL_CONDUIT_PROGRESSION_KIND.NEXT_ROOM,
    activationMode: "transfer",
    fromRoomIndex,
    toRoomIndex: fromRoomIndex + 1,
    roomCount,
  };
}

function evaluateAbyssalConduitEligibility(input = {}, options = {}) {
  const throughStage = resolveThroughStage(options.throughStage);
  const conduit = input.conduit && typeof input.conduit === "object"
    ? input.conduit
    : {};

  if (conduit.stale === true) {
    return buildRejectedDecision(
      "ABYSSAL_STALE_ROOM_CONDUIT",
      ABYSSAL_CONDUIT_DECISION_STAGE.CONDUIT_IDENTITY,
    );
  }
  if (conduit.exitTracePresent !== true) {
    return buildRejectedDecision(
      "EXIT_TRACE_NOT_FOUND",
      ABYSSAL_CONDUIT_DECISION_STAGE.CONDUIT_IDENTITY,
    );
  }
  if (reachedThroughStage(
    throughStage,
    ABYSSAL_CONDUIT_DECISION_STAGE.CONDUIT_IDENTITY,
  )) {
    return buildAllowedDecision(ABYSSAL_CONDUIT_DECISION_STAGE.CONDUIT_IDENTITY);
  }

  if (input.participantAuthorized !== true) {
    return buildRejectedDecision(
      "EXIT_TRACE_OWNER_MISMATCH",
      ABYSSAL_CONDUIT_DECISION_STAGE.AUTHORIZATION,
    );
  }
  if (reachedThroughStage(
    throughStage,
    ABYSSAL_CONDUIT_DECISION_STAGE.AUTHORIZATION,
  )) {
    return buildAllowedDecision(ABYSSAL_CONDUIT_DECISION_STAGE.AUTHORIZATION);
  }

  const terminal = input.terminal && typeof input.terminal === "object"
    ? input.terminal
    : {};
  if (terminal.blocked === true) {
    return buildRejectedDecision(
      normalizeText(terminal.reason, "ABYSSAL_RUN_TERMINALLY_SETTLED"),
      ABYSSAL_CONDUIT_DECISION_STAGE.TERMINAL,
      { terminal: true, suppressed: true },
    );
  }
  if (reachedThroughStage(
    throughStage,
    ABYSSAL_CONDUIT_DECISION_STAGE.TERMINAL,
  )) {
    return buildAllowedDecision(ABYSSAL_CONDUIT_DECISION_STAGE.TERMINAL);
  }

  if (conduit.runtimeReady !== true) {
    return buildRejectedDecision(
      "ABYSSAL_CONDUIT_RUNTIME_NOT_READY",
      ABYSSAL_CONDUIT_DECISION_STAGE.RUNTIME,
    );
  }
  if (reachedThroughStage(
    throughStage,
    ABYSSAL_CONDUIT_DECISION_STAGE.RUNTIME,
  )) {
    return buildAllowedDecision(ABYSSAL_CONDUIT_DECISION_STAGE.RUNTIME);
  }

  const range = input.range && typeof input.range === "object" ? input.range : {};
  if (range.inRange !== true) {
    return buildRejectedDecision(
      "EXIT_TRACE_TOO_FAR",
      ABYSSAL_CONDUIT_DECISION_STAGE.RANGE,
    );
  }
  if (reachedThroughStage(
    throughStage,
    ABYSSAL_CONDUIT_DECISION_STAGE.RANGE,
  )) {
    return buildAllowedDecision(ABYSSAL_CONDUIT_DECISION_STAGE.RANGE);
  }

  const objectiveDecision = evaluateAbyssalRoomObjectiveEligibility(
    input.objective,
  );
  if (!objectiveDecision.allowed) {
    return objectiveDecision;
  }
  if (reachedThroughStage(
    throughStage,
    ABYSSAL_CONDUIT_DECISION_STAGE.OBJECTIVE,
  )) {
    return objectiveDecision;
  }

  const transition = input.transition && typeof input.transition === "object"
    ? input.transition
    : {};
  if (transition.pending === true) {
    return buildRejectedDecision(
      "PENDING_TRANSITION",
      ABYSSAL_CONDUIT_DECISION_STAGE.TRANSITION,
      { duplicate: true },
    );
  }
  if (reachedThroughStage(
    throughStage,
    ABYSSAL_CONDUIT_DECISION_STAGE.TRANSITION,
  )) {
    return buildAllowedDecision(ABYSSAL_CONDUIT_DECISION_STAGE.TRANSITION);
  }

  const progression = resolveAbyssalRoomProgression(input.run);
  return buildAllowedDecision(
    ABYSSAL_CONDUIT_DECISION_STAGE.PROGRESSION,
    progression,
  );
}

function evaluateAbyssalDelayedHandoffEligibility(input = {}) {
  if (input.runIdentityMatches !== true) {
    return buildRejectedDecision(
      "ABYSSAL_END_GATE_HANDOFF_RUN_IDENTITY_CHANGED",
      "handoffRunIdentity",
    );
  }
  if (
    input.validationIdentityChecked === true &&
    input.validationIdentityMatches !== true
  ) {
    return buildRejectedDecision(
      "ABYSSAL_END_GATE_HANDOFF_VALIDATION_IDENTITY_CHANGED",
      "handoffValidationIdentity",
    );
  }
  return buildAllowedDecision(
    input.validationIdentityChecked === true
      ? "handoffValidationIdentity"
      : "handoffRunIdentity",
  );
}

module.exports = {
  ABYSSAL_CONDUIT_DECISION_STAGE,
  ABYSSAL_CONDUIT_PROGRESSION_KIND,
  evaluateAbyssalConduitEligibility,
  evaluateAbyssalDelayedHandoffEligibility,
  evaluateAbyssalRoomObjectiveEligibility,
  isAbyssalFinalRoomIndex,
  resolveAbyssalRoomProgression,
};
