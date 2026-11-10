"use strict";

const { normalizeText } = require("../domain/abyssalValueUtils");

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

const ABYSSAL_NPC_CONTROLLER_DEFAULT_COMBAT_TICK_INTERVAL_MS = 250;
const ABYSSAL_NPC_CONTROLLER_MIN_COMBAT_TICK_INTERVAL_MS = 50;
// Preserve the existing missed-cadence budget and fixed startup grace.
const ABYSSAL_NPC_CONTROLLER_MISSED_TICK_ALLOWANCE = 30;
const ABYSSAL_NPC_CONTROLLER_STARTUP_GRACE_MS =
  ABYSSAL_NPC_CONTROLLER_DEFAULT_COMBAT_TICK_INTERVAL_MS * ABYSSAL_NPC_CONTROLLER_MISSED_TICK_ALLOWANCE;

function resolveAbyssalNpcControllerExpectedCombatTickIntervalMs(controller, scene) {
  const behaviorIntervalMs = Object.prototype.hasOwnProperty.call(
    controller && controller.behaviorOverrides || {},
    "thinkIntervalMs",
  )
    ? Number(controller.behaviorOverrides.thinkIntervalMs)
    : Number(controller && controller.behaviorProfile && controller.behaviorProfile.thinkIntervalMs);
  const sceneTickIntervalMs = Number(scene && scene._tickIntervalMs);
  return Math.max(
    ABYSSAL_NPC_CONTROLLER_MIN_COMBAT_TICK_INTERVAL_MS,
    Number.isFinite(behaviorIntervalMs)
      ? behaviorIntervalMs
      : ABYSSAL_NPC_CONTROLLER_DEFAULT_COMBAT_TICK_INTERVAL_MS,
    Number.isFinite(sceneTickIntervalMs) ? sceneTickIntervalMs : 0,
  );
}

function resolveAbyssalNpcControllerStaleThresholdMs(controller, scene) {
  return resolveAbyssalNpcControllerExpectedCombatTickIntervalMs(controller, scene) *
    ABYSSAL_NPC_CONTROLLER_MISSED_TICK_ALLOWANCE;
}

function getControllerHeartbeatAtMs(controller) {
  // Keep combat-only controllers compatible while measuring successful idle
  // thinks separately from engagement. Neither activation nor a watchdog poll
  // manufactures a heartbeat.
  return Math.max(
    toInt(controller && controller.lastBehaviorTickAtMs, 0),
    toInt(controller && controller.lastCombatTickAtMs, 0),
  );
}

function resolveAbyssalNpcControllerLiveness(controller, scene, nowMs) {
  if (!controller) {
    return { state: "missing", lastCombatTickAtMs: 0, lastControllerTickAtMs: 0, tickAgeMs: 0, thresholdMs: 0 };
  }
  if (
    controller.controllerPaused === true ||
    controller.controllerLifecycleState === "materialized_paused"
  ) {
    return { state: "paused", lastCombatTickAtMs: 0, lastControllerTickAtMs: 0, tickAgeMs: 0, thresholdMs: 0 };
  }
  const thresholdMs = resolveAbyssalNpcControllerStaleThresholdMs(controller, scene);
  const activatedAtMs = toInt(controller.activatedAtMs, 0);
  const lastCombatTickAtMs = toInt(controller.lastCombatTickAtMs, 0);
  const lastControllerTickAtMs = getControllerHeartbeatAtMs(controller);
  if (lastControllerTickAtMs <= 0) {
    const startupThresholdMs = ABYSSAL_NPC_CONTROLLER_STARTUP_GRACE_MS;
    const tickAgeMs = activatedAtMs > 0
      ? Math.max(0, toInt(nowMs, 0) - activatedAtMs)
      : 0;
    return {
      state: activatedAtMs > 0 && tickAgeMs >= startupThresholdMs
        ? "stalled_startup"
        : "startup",
      activatedAtMs,
      lastCombatTickAtMs,
      lastControllerTickAtMs,
      tickAgeMs,
      thresholdMs: startupThresholdMs,
    };
  }
  const tickAgeMs = Math.max(0, toInt(nowMs, 0) - lastControllerTickAtMs);
  return {
    state: tickAgeMs > thresholdMs ? "stalled" : "healthy",
    activatedAtMs,
    lastCombatTickAtMs,
    lastControllerTickAtMs,
    tickAgeMs,
    thresholdMs,
  };
}

function clearAbyssalNpcControllerWatchdogRearmState(controller) {
  if (!controller) return;
  controller.abyssalWatchdogRearmAttemptedAtMs = 0;
  controller.abyssalWatchdogRearmBaselineCombatTickAtMs = 0;
  controller.abyssalWatchdogRearmReason = "";
}

function resolveCurrentAbyssalNpcWatchdogRoomAuthority(ports, pocketState, roomIndex) {
  const {
    getActivePocketStateByInstanceID,
    buildPlaceholderRoomState,
    getPlaceholderRoomEntry,
    hasTerminalFailureOutcome,
    normalizeLowerText,
  } = ports;
  const currentPocketState = getActivePocketStateByInstanceID(
    toInt(pocketState && pocketState.instanceID, 0),
  ) || pocketState;
  const currentRoomState = buildPlaceholderRoomState(currentPocketState);
  const currentRoomEntry = getPlaceholderRoomEntry(currentPocketState, roomIndex);
  return {
    pocketState: currentPocketState,
    roomEntry: currentRoomEntry,
    required: Boolean(
      currentPocketState &&
      !hasTerminalFailureOutcome(currentPocketState) &&
      currentRoomState.currentRoomIndex === roomIndex &&
      currentRoomEntry &&
      currentRoomEntry.objectiveComplete !== true &&
      normalizeLowerText(currentRoomEntry.npcControllerActivationState, "") === "active"
    ),
  };
}

// Each pass uses current ownership; retry evidence stays on the existing controllers.
function runAbyssalNpcControllerWatchdog(ports, pocketState, roomEntry, scene, deps, nowMs) {
  const work = { pocketState, roomEntry, scene, deps, nowMs };
  for (const inspect of [prepareWatchdogPass, inspectWatchdogReadiness, inspectWatchdogLiveness, retryUnavailableControllers]) {
    const result = inspect(ports, work);
    if (result) return result;
  }
  if (work.staleControllerIDs.length > 0) return rearmStalledControllers(ports, work);
  return {
    success: true,
    ...(work.recoveredControllerIDs.length > 0
      ? { recovered: ports.listUniquePositiveInts(work.recoveredControllerIDs) } : {}),
  };
}

function prepareWatchdogPass(ports, work) {
  const {
    getActivePocketStateByInstanceID,
    buildPlaceholderRoomState,
    getPlaceholderRoomEntry,
    usesIsolatedAbyssalScene,
    listUniquePositiveInts,
    areAllEnteredAbyssalParticipantsTerminal,
    pauseAbyssalObjectiveControllers,
  } = ports;
  const { scene, deps, nowMs } = work;
  let { pocketState, roomEntry } = work;
  const refreshedPocketState = getActivePocketStateByInstanceID(
    toInt(pocketState && pocketState.instanceID, 0),
  ) || pocketState;
  const refreshedRoomState = buildPlaceholderRoomState(refreshedPocketState);
  const refreshedRoomEntry = getPlaceholderRoomEntry(
    refreshedPocketState,
    toInt(roomEntry && roomEntry.roomIndex, refreshedRoomState.currentRoomIndex),
  );
  pocketState = refreshedPocketState;
  roomEntry = refreshedRoomEntry || roomEntry;
  if (
    !usesIsolatedAbyssalScene(pocketState, deps) ||
    roomEntry.objectiveComplete === true ||
    roomEntry.npcControllerActivationState === "degraded"
  ) {
    return { success: true, skipped: true };
  }
  const npcRuntime = deps;
  const roomIndex = toInt(
    roomEntry.roomIndex,
    buildPlaceholderRoomState(pocketState).currentRoomIndex,
  );
  const inactiveDependantIDs = new Set(
    listUniquePositiveInts(roomEntry.dependantInactiveNpcItemIDs),
  );
  const objectiveIDs = listUniquePositiveInts(
    roomEntry.hostileEntityIDs,
  ).filter((npcID) => !inactiveDependantIDs.has(npcID));
  if (objectiveIDs.length <= 0) {
    return { success: true, skipped: true };
  }
  if (areAllEnteredAbyssalParticipantsTerminal(pocketState)) {
    pauseAbyssalObjectiveControllers(
      npcRuntime,
      objectiveIDs,
      "abyssal_all_participants_terminal",
    );
    return { success: true, skipped: true, terminalParticipants: true };
  }
  Object.assign(work, { pocketState, roomEntry, npcRuntime, roomIndex, objectiveIDs });
}

function inspectWatchdogReadiness(ports, work) {
  const {
    normalizeLowerText,
    listUniquePositiveInts,
    reconcileAbyssalNpcControllerCombatTargets,
    buildAbyssalNpcControllerReadiness,
    degradeAbyssalRoomNpcActivation,
  } = ports;
  const { pocketState, roomEntry, scene, deps, nowMs, npcRuntime, roomIndex, objectiveIDs } = work;
  const targetBinding = reconcileAbyssalNpcControllerCombatTargets(
    pocketState,
    roomIndex,
    scene,
    npcRuntime,
    objectiveIDs,
  );
  const shipID = toInt(
    targetBinding && targetBinding.selection && targetBinding.selection.shipID,
    0,
  );
  const targetBindingFailedIDs = new Set(
    listUniquePositiveInts(targetBinding && targetBinding.failedNpcIDs),
  );
  const controllersExpectedActive = normalizeLowerText(
    roomEntry.npcControllerActivationState,
    "",
  ) === "active";
  const controllerReadiness = objectiveIDs.map((npcID) => {
    const readiness = buildAbyssalNpcControllerReadiness(
      pocketState,
      npcID,
      scene,
      npcRuntime,
      {
        expectPaused: !controllersExpectedActive,
        allowAlreadyActive: true,
        playerID: shipID,
        roomIndex,
        roomActive: true,
      },
    );
    return targetBindingFailedIDs.has(npcID)
      ? {
          ...readiness,
          ready: false,
          failure: "CONTROLLER_TARGET_BINDING_FAILED",
        }
      : readiness;
  });
  if (
    !scene ||
    !npcRuntime ||
    typeof npcRuntime.getControllerByEntityID !== "function"
  ) {
    const degradedState = degradeAbyssalRoomNpcActivation(
      pocketState,
      null,
      deps,
      {
        roomIndex,
        objectiveIDs,
        readiness: controllerReadiness,
        nowMs,
        reason: !scene
          ? "ABYSSAL_NPC_WATCHDOG_SCENE_UNAVAILABLE"
          : "ABYSSAL_NPC_WATCHDOG_RUNTIME_UNAVAILABLE",
      },
    );
    return { success: true, degraded: true, data: degradedState };
  }
  Object.assign(work, { shipID, controllersExpectedActive, controllerReadiness });
}

function inspectWatchdogLiveness(ports, work) {
  const { log } = ports;
  const { pocketState, roomEntry, scene, nowMs, npcRuntime, roomIndex, objectiveIDs, controllersExpectedActive, controllerReadiness } = work;
  const unavailableControllerIDs = controllerReadiness
  .filter((entry) => entry.ready !== true)
  .map((entry) => entry.npcID);
  const staleControllerIDs = [];
  const controllerLivenessByNpcID = new Map();
  const recoveredControllerIDs = [];
  for (const npcID of objectiveIDs) {
    const controller = npcRuntime.getControllerByEntityID(npcID);
    const readiness = controllerReadiness.find((entry) => entry.npcID === npcID);
    if (!readiness || readiness.ready !== true) {
      log.warn(
        `[NpcControllerWatchdog] npc=${npcID} run=${toInt(pocketState && pocketState.instanceID, 0)} ` +
          `room=${roomIndex} state=controller_unavailable ` +
          `failure=${normalizeText(readiness && readiness.failure, "CONTROLLER_READINESS_UNKNOWN")} ` +
          `action=${roomEntry.npcControllerWatchdogRetryAttempted === true ? "failed" : "retry_activation"}`,
      );
      continue;
    }
    if (!controllersExpectedActive) continue;
    const liveness = resolveAbyssalNpcControllerLiveness(controller, scene, nowMs);
    controllerLivenessByNpcID.set(npcID, liveness);
    const priorRearmAttemptAtMs = toInt(
      controller && controller.abyssalWatchdogRearmAttemptedAtMs,
      0,
    );
    const priorRearmBaselineTickAtMs = toInt(
      controller && controller.abyssalWatchdogRearmBaselineCombatTickAtMs,
      0,
    );
    if (
      priorRearmAttemptAtMs > 0 &&
      liveness.lastControllerTickAtMs > priorRearmBaselineTickAtMs
    ) {
      clearAbyssalNpcControllerWatchdogRearmState(controller);
      recoveredControllerIDs.push(npcID);
      log.info(
        `[NpcControllerWatchdog] npc=${npcID} run=${toInt(pocketState && pocketState.instanceID, 0)} ` +
          `room=${roomIndex} state=recovered lastTickAt=${liveness.lastControllerTickAtMs} ` +
          `baselineTickAt=${priorRearmBaselineTickAtMs || "none"} ` +
          `rearmAttempt=1 action=healthy`,
      );
      continue;
    }
    if (liveness.state === "stalled_startup" || liveness.state === "stalled") {
      staleControllerIDs.push(npcID);
    }
  }
  Object.assign(work, { unavailableControllerIDs, staleControllerIDs, controllerLivenessByNpcID, recoveredControllerIDs });
}

function retryUnavailableControllers(ports, work) {
  const { buildAbyssalNpcControllerReadiness, degradeAbyssalRoomNpcActivation, activateAbyssalRoomNpcControllers } = ports;
  const { pocketState, roomEntry, scene, deps, nowMs, npcRuntime, roomIndex, objectiveIDs, unavailableControllerIDs, shipID } = work;
  if (unavailableControllerIDs.length > 0) {
    if (roomEntry.npcControllerWatchdogRetryAttempted !== true) {
      return activateAbyssalRoomNpcControllers(pocketState, null, deps, {
        roomIndex,
        roomActive: true,
        expectPaused: true,
        allowAlreadyActive: true,
        watchdogRetry: true,
      });
    }
    const readiness = objectiveIDs.map((npcID) => {
      const entry = buildAbyssalNpcControllerReadiness(
        pocketState,
        npcID,
        scene,
        npcRuntime,
        {
          expectPaused: true,
          allowAlreadyActive: true,
          playerID: shipID,
          roomIndex,
          roomActive: true,
        },
      );
      return unavailableControllerIDs.includes(npcID)
        ? {
            ...entry,
            ready: false,
            failure: normalizeText(entry.failure, "WATCHDOG_CONTROLLER_UNAVAILABLE"),
          }
        : entry;
    });
    const degradedState = degradeAbyssalRoomNpcActivation(pocketState, null, deps, {
      roomIndex,
      objectiveIDs,
      readiness,
      nowMs,
      reason: "ABYSSAL_NPC_WATCHDOG_CONTROLLER_UNAVAILABLE",
    });
    return { success: true, degraded: true, data: degradedState };
  }
}

function rearmStalledControllers(ports, work) {
  const result = rejectRepeatedStall(ports, work);
  if (result) return result;
  Object.assign(work, { rearmFailures: [], rearmedControllerIDs: [], rearmBaselinesByNpcID: new Map() });
  for (const npcID of work.staleControllerIDs) {
    const rearmResult = rearmStalledController(ports, { ...work, npcID });
    if (rearmResult) return rearmResult;
  }
  return rejectFailedRearm(ports, work) || finishWatchdogRearm(ports, work);
}

function rejectRepeatedStall(ports, work) {
  const { buildAbyssalNpcControllerReadiness, degradeAbyssalRoomNpcActivation, log } = ports;
  const {
    pocketState,
    roomEntry,
    scene,
    deps,
    nowMs,
    npcRuntime,
    roomIndex,
    objectiveIDs,
    staleControllerIDs,
    controllerLivenessByNpcID,
    recoveredControllerIDs,
    shipID,
  } = work;
  const alreadyRearmed = [];
  for (const npcID of staleControllerIDs) {
    const controller = npcRuntime.getControllerByEntityID(npcID);
    const rearmAttemptedAtMs = toInt(
      controller && controller.abyssalWatchdogRearmAttemptedAtMs,
      0,
    );
    if (rearmAttemptedAtMs <= 0) continue;
    const baselineTickAtMs = toInt(
      controller && controller.abyssalWatchdogRearmBaselineCombatTickAtMs,
      0,
    );
    const currentLastTickAtMs = getControllerHeartbeatAtMs(controller);
    // Revalidate forward progress immediately before fail-closed degradation.
    // A natural scene tick can resume after the watchdog's stale snapshot.
    if (currentLastTickAtMs > baselineTickAtMs) {
      clearAbyssalNpcControllerWatchdogRearmState(controller);
      recoveredControllerIDs.push(npcID);
      log.info(
        `[NpcControllerWatchdog] npc=${npcID} run=${toInt(pocketState && pocketState.instanceID, 0)} ` +
          `room=${roomIndex} state=recovered lastTickAt=${currentLastTickAtMs} ` +
          `baselineTickAt=${baselineTickAtMs || "none"} ` +
          `rearmAttempt=1 action=healthy`,
      );
      continue;
    }
    alreadyRearmed.push(npcID);
  }
  if (alreadyRearmed.length > 0) {
    const roomAuthority = resolveCurrentAbyssalNpcWatchdogRoomAuthority(ports,
      pocketState,
      roomIndex,
    );
    if (!roomAuthority.required) {
      return {
        success: true,
        skipped: true,
        retired: Boolean(roomAuthority.roomEntry && roomAuthority.roomEntry.objectiveComplete),
      };
    }
    const readiness = objectiveIDs.map((npcID) => {
      const entry = buildAbyssalNpcControllerReadiness(
        roomAuthority.pocketState,
        npcID,
        scene,
        npcRuntime,
        { playerID: shipID, roomIndex, roomActive: true },
      );
      const liveness = controllerLivenessByNpcID.get(npcID);
      return alreadyRearmed.includes(npcID)
        ? {
            ...entry,
            ready: false,
            failure: liveness && liveness.lastControllerTickAtMs > 0
              ? "WATCHDOG_STALE_COMBAT_TICK"
              : "WATCHDOG_NO_COMBAT_TICK",
          }
        : entry;
    });
    for (const npcID of alreadyRearmed) {
      const liveness = resolveAbyssalNpcControllerLiveness(
        npcRuntime.getControllerByEntityID(npcID),
        scene,
        nowMs,
      );
      log.warn(
        `[NpcControllerWatchdog] npc=${npcID} run=${toInt(roomAuthority.pocketState.instanceID, 0)} ` +
          `room=${roomIndex} state=${liveness.lastControllerTickAtMs > 0 ? "stalled" : "active_no_tick"} ` +
          `lastTickAgeMs=${liveness.tickAgeMs} thresholdMs=${liveness.thresholdMs} ` +
          `rearmAttempt=1 action=degrade`,
      );
    }
    const degradedState = degradeAbyssalRoomNpcActivation(roomAuthority.pocketState, null, deps, {
      roomIndex,
      objectiveIDs,
      readiness,
      nowMs,
      reason: alreadyRearmed.some((npcID) => {
        const liveness = controllerLivenessByNpcID.get(npcID);
        return liveness && liveness.lastControllerTickAtMs > 0;
      })
        ? "ABYSSAL_NPC_WATCHDOG_STALE_COMBAT_TICK"
        : "ABYSSAL_NPC_WATCHDOG_NO_COMBAT_TICK",
    });
    return { success: true, degraded: true, data: degradedState };
  }
}

function rearmStalledController(ports, work) {
  const { log, resolveAbyssalLiveCombatParticipant } = ports;
  const {
    npcID,
    pocketState,
    scene,
    nowMs,
    npcRuntime,
    roomIndex,
    recoveredControllerIDs,
    rearmFailures,
    rearmedControllerIDs,
    rearmBaselinesByNpcID,
    shipID,
  } = work;
  if (recoveredControllerIDs.includes(npcID)) return;
  const controller = npcRuntime.getControllerByEntityID(npcID);
  const roomAuthority = resolveCurrentAbyssalNpcWatchdogRoomAuthority(ports,
    pocketState,
    roomIndex,
  );
  if (!roomAuthority.required) {
    return {
      success: true,
      skipped: true,
      retired: Boolean(roomAuthority.roomEntry && roomAuthority.roomEntry.objectiveComplete),
    };
  }
  const currentLiveness = resolveAbyssalNpcControllerLiveness(
    controller,
    scene,
    nowMs,
  );
  if (
    currentLiveness.state !== "stalled_startup" &&
    currentLiveness.state !== "stalled"
  ) {
    if (currentLiveness.state === "healthy") {
      recoveredControllerIDs.push(npcID);
    }
    return;
  }
  const preRearmPocketState = roomAuthority.pocketState;
  const preRearmSelection = resolveAbyssalLiveCombatParticipant(
    preRearmPocketState,
    scene,
    {
      roomIndex,
      preferredShipIDs: [
        toInt(controller && controller.currentTargetID, 0),
        toInt(controller && controller.preferredTargetID, 0),
        shipID,
      ],
    },
  );
  if (!preRearmSelection.success) {
    rearmFailures.push({ npcID, failure: preRearmSelection.reason });
    return;
  }
  const baselineTickAtMs = currentLiveness.lastControllerTickAtMs;
  controller.abyssalWatchdogRearmAttemptedAtMs = nowMs;
  // Retain the existing retry-state field for controller/test compatibility;
  // its baseline now covers completed idle thinks as well as combat.
  controller.abyssalWatchdogRearmBaselineCombatTickAtMs = baselineTickAtMs;
  controller.abyssalWatchdogRearmReason = currentLiveness.state;
  rearmBaselinesByNpcID.set(npcID, {
    controller,
    baselineTickAtMs,
  });
  const activateResult = typeof npcRuntime.activateNpcController === "function"
  ? npcRuntime.activateNpcController(npcID, nowMs)
  : null;
  const postActivateAuthority = resolveCurrentAbyssalNpcWatchdogRoomAuthority(ports,
    pocketState,
    roomIndex,
  );
  if (!postActivateAuthority.required) {
    return {
      success: true,
      skipped: true,
      retired: Boolean(
        postActivateAuthority.roomEntry && postActivateAuthority.roomEntry.objectiveComplete
      ),
    };
  }
  const postActivatePocketState = postActivateAuthority.pocketState;
  const postActivateSelection = resolveAbyssalLiveCombatParticipant(
    postActivatePocketState,
    scene,
    {
      roomIndex,
      preferredShipIDs: [preRearmSelection.shipID],
    },
  );
  let attackResult = null;
  if (
    activateResult &&
    activateResult.success &&
    postActivateSelection.success &&
    typeof npcRuntime.issueAttackOrder === "function"
  ) {
    // The participant's ship may be the capsule it flies on in; Abyssal NPCs shoot it.
    attackResult = npcRuntime.issueAttackOrder(
      npcID,
      postActivateSelection.shipID,
      { keepLock: true, allowPodKill: true },
    );
  }
  if (
    !activateResult ||
    activateResult.success === false ||
    !postActivateSelection.success ||
    !attackResult ||
    attackResult.success === false
  ) {
    rearmFailures.push({
      npcID,
      failure: !postActivateSelection.success
        ? postActivateSelection.reason
        : normalizeText(
            activateResult && activateResult.errorMsg,
            normalizeText(
              attackResult && attackResult.errorMsg,
              "WATCHDOG_REARM_FAILED",
            ),
          ),
    });
  } else {
    rearmedControllerIDs.push(npcID);
  }
  log.warn(
    `[NpcControllerWatchdog] npc=${npcID} run=${toInt(pocketState && pocketState.instanceID, 0)} ` +
      `room=${roomIndex} state=${currentLiveness.state === "stalled" ? "stalled" : "active_no_tick"} ` +
      `lastTickAgeMs=${currentLiveness.tickAgeMs} thresholdMs=${currentLiveness.thresholdMs} ` +
      `rearmAttempt=1 action=${activateResult && activateResult.success && postActivateSelection.success &&
        attackResult && attackResult.success ? "rearmed" : "failed"}`,
  );
}

function rejectFailedRearm(ports, work) {
  const {
    areAllEnteredAbyssalParticipantsTerminal,
    pauseAbyssalObjectiveControllers,
    buildAbyssalNpcControllerReadiness,
    degradeAbyssalRoomNpcActivation,
  } = ports;
  const { pocketState, scene, deps, nowMs, npcRuntime, roomIndex, objectiveIDs, rearmFailures, shipID } = work;
  if (rearmFailures.length > 0) {
    const latestAuthority = resolveCurrentAbyssalNpcWatchdogRoomAuthority(ports,
      pocketState,
      roomIndex,
    );
    const latestPocketState = latestAuthority.pocketState;
    if (!latestAuthority.required) {
      return {
        success: true,
        skipped: true,
        retired: Boolean(latestAuthority.roomEntry && latestAuthority.roomEntry.objectiveComplete),
      };
    }
    if (areAllEnteredAbyssalParticipantsTerminal(latestPocketState)) {
      pauseAbyssalObjectiveControllers(
        npcRuntime,
        objectiveIDs,
        "abyssal_all_participants_terminal",
      );
      return { success: true, skipped: true, terminalParticipants: true };
    }
    const failedByNpcID = new Map(
      rearmFailures.map((failure) => [failure.npcID, failure.failure]),
    );
    const readiness = objectiveIDs.map((npcID) => {
      const entry = buildAbyssalNpcControllerReadiness(
        latestPocketState,
        npcID,
        scene,
        npcRuntime,
        { playerID: shipID, roomIndex, roomActive: true },
      );
      return failedByNpcID.has(npcID)
        ? { ...entry, ready: false, failure: failedByNpcID.get(npcID) }
        : entry;
    });
    const degradedState = degradeAbyssalRoomNpcActivation(
      latestPocketState,
      null,
      deps,
      {
        roomIndex,
        objectiveIDs,
        readiness,
        nowMs,
        reason: "ABYSSAL_NPC_WATCHDOG_REARM_FAILED",
      },
    );
    return { success: true, degraded: true, data: degradedState };
  }
}

function finishWatchdogRearm(ports, work) {
  const { listUniquePositiveInts, log } = ports;
  const { pocketState, scene, nowMs, npcRuntime, roomIndex, recoveredControllerIDs, rearmedControllerIDs, rearmBaselinesByNpcID } = work;
  if (
    rearmedControllerIDs.length > 0 &&
    typeof npcRuntime.tickNpcControllersInScene === "function"
  ) {
    npcRuntime.tickNpcControllersInScene(scene, rearmedControllerIDs, nowMs);
  }
  const stillRearmingControllerIDs = [];
  for (const npcID of rearmedControllerIDs) {
    const rearmBaseline = rearmBaselinesByNpcID.get(npcID);
    const controller = npcRuntime.getControllerByEntityID(npcID);
    const currentLastTickAtMs = getControllerHeartbeatAtMs(controller);
    if (
      rearmBaseline &&
      controller === rearmBaseline.controller &&
      currentLastTickAtMs > rearmBaseline.baselineTickAtMs
    ) {
      clearAbyssalNpcControllerWatchdogRearmState(controller);
      recoveredControllerIDs.push(npcID);
      log.info(
        `[NpcControllerWatchdog] npc=${npcID} run=${toInt(pocketState && pocketState.instanceID, 0)} ` +
          `room=${roomIndex} state=recovered lastTickAt=${currentLastTickAtMs} ` +
          `baselineTickAt=${rearmBaseline.baselineTickAtMs || "none"} ` +
          `rearmAttempt=1 action=healthy`,
      );
    } else {
      stillRearmingControllerIDs.push(npcID);
    }
  }
  return {
    success: true,
    rearmed: rearmedControllerIDs,
    ...(recoveredControllerIDs.length > 0
      ? { recovered: listUniquePositiveInts(recoveredControllerIDs) }
      : {}),
    ...(stillRearmingControllerIDs.length > 0
      ? { rearming: stillRearmingControllerIDs }
      : {}),
  };
}

function createAbyssalNpcWatchdog(ports) {
  return { runAbyssalNpcControllerWatchdog: runAbyssalNpcControllerWatchdog.bind(null, ports) };
}

module.exports = {
  createAbyssalNpcWatchdog,
  resolveAbyssalNpcControllerExpectedCombatTickIntervalMs,
  resolveAbyssalNpcControllerStaleThresholdMs,
  resolveAbyssalNpcControllerLiveness,
};
