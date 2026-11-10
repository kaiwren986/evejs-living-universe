"use strict";

const { normalizeText } = require("../domain/abyssalValueUtils");

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

// Exact NPC death evidence and replay; queue storage remains in its existing registry.
function getRoomObjectiveIDSets(ports, roomEntry = {}) {
  const {
    listUniquePositiveInts,
  } = ports;
  const liveObjectiveIDs = listUniquePositiveInts(roomEntry.objectiveRelevantNpcItemIDs);
  const destroyedObjectiveIDs = listUniquePositiveInts(roomEntry.destroyedObjectiveIDs);
  const defeatedObjectiveItemIDs = listUniquePositiveInts(roomEntry.defeatedObjectiveItemIDs);
  const plannedObjectiveNpcItemIDs = listUniquePositiveInts(
    roomEntry.plannedObjectiveNpcItemIDs &&
      roomEntry.plannedObjectiveNpcItemIDs.length > 0
      ? roomEntry.plannedObjectiveNpcItemIDs
      : [
        ...liveObjectiveIDs,
        ...destroyedObjectiveIDs,
        ...defeatedObjectiveItemIDs,
      ],
  );
  const materializedObjectiveNpcItemIDs = listUniquePositiveInts(
    roomEntry.materializedObjectiveNpcItemIDs &&
      roomEntry.materializedObjectiveNpcItemIDs.length > 0
      ? roomEntry.materializedObjectiveNpcItemIDs
      : plannedObjectiveNpcItemIDs,
  );
  return {
    plannedObjectiveNpcItemIDs,
    materializedObjectiveNpcItemIDs,
    liveObjectiveIDs,
    destroyedObjectiveIDs,
    defeatedObjectiveItemIDs,
  };
}

function buildAbyssalNpcDestroyedResult(ports, result, overrides = {}) {

  return {
    success: overrides.success !== false,
    handled: overrides.handled === true,
    newlyRecorded: overrides.newlyRecorded === true,
    objectiveComplete: overrides.objectiveComplete === true,
    result,
    defeated: toInt(overrides.defeated, 0),
    required: toInt(overrides.required, 0),
    live: toInt(overrides.live, 0),
    destroyed: toInt(overrides.destroyed, 0),
    pending: overrides.pending === true,
    errorMsg: overrides.errorMsg || null,
  };
}

function inspectAbyssalNpcDestructionAuthority(ports, destroyedNpc, pocketState, deps = ports.getDependencies()) {
  const {
    buildPlaceholderRoomState,
    buildAbyssalSceneDescriptor,
  } = ports;
  if (!destroyedNpc || typeof destroyedNpc !== "object" || !pocketState) {
    return { valid: false, reason: "AUTHORITY_CONTEXT_MISSING" };
  }
  if (
    destroyedNpc.abyssalAuthorityPresent === false ||
    destroyedNpc.abyssalAuthorityValid === false
  ) {
    return {
      valid: false,
      reason: normalizeText(
        destroyedNpc.abyssalAuthorityReason,
        "UPSTREAM_AUTHORITY_INVALID",
      ),
    };
  }
  const collectAliases = (keys) => {
    let present = false;
    let invalid = false;
    const values = [];
    for (const key of keys) {
      if (!Object.prototype.hasOwnProperty.call(destroyedNpc, key)) {
        continue;
      }
      present = true;
      const value = toInt(destroyedNpc[key], 0);
      if (value <= 0) {
        invalid = true;
      } else {
        values.push(value);
      }
    }
    const distinctValues = [...new Set(values)];
    return {
      present,
      valid: present && !invalid && distinctValues.length === 1,
      value: distinctValues.length === 1 ? distinctValues[0] : 0,
      values: distinctValues,
    };
  };
  const runAuthority = collectAliases([
    "abyssalRunID",
    "evejsAbyssalInstanceID",
    "evejsAbyssalPocketInstanceID",
    "instanceID",
    "runID",
  ]);
  const roomAuthority = collectAliases([
    "abyssalRoomIndex",
    "evejsAbyssalRoomIndex",
    "roomIndex",
  ]);
  const expectedRunID = toInt(pocketState.instanceID, 0);
  const expectedRoomIndex = toInt(
    buildPlaceholderRoomState(pocketState).currentRoomIndex,
    0,
  );
  const expectedSceneDescriptor = buildAbyssalSceneDescriptor(pocketState, deps);
  const expectedSceneKey = normalizeText(
    expectedSceneDescriptor && expectedSceneDescriptor.sceneKey,
    normalizeText(pocketState.sceneKey, ""),
  );
  const sceneKeys = [
    destroyedNpc.sceneKey,
    destroyedNpc.spaceSceneKey,
    destroyedNpc.sceneDescriptor && destroyedNpc.sceneDescriptor.sceneKey,
  ]
    .filter((value) => value !== null && value !== undefined)
    .map((value) => normalizeText(value, ""));
  if (!runAuthority.valid) {
    return { valid: false, reason: "RUN_AUTHORITY_INVALID", runAuthority };
  }
  if (runAuthority.value !== expectedRunID) {
    return { valid: false, reason: "RUN_AUTHORITY_MISMATCH", runAuthority };
  }
  if (!roomAuthority.valid) {
    return { valid: false, reason: "ROOM_AUTHORITY_INVALID", roomAuthority };
  }
  if (roomAuthority.value !== expectedRoomIndex) {
    return { valid: false, reason: "ROOM_AUTHORITY_MISMATCH", roomAuthority };
  }
  if (
    !expectedSceneKey ||
    sceneKeys.length <= 0 ||
    sceneKeys.some((sceneKey) => sceneKey !== expectedSceneKey)
  ) {
    return {
      valid: false,
      reason: "SCENE_AUTHORITY_INVALID",
      expectedSceneKey,
      sceneKeys,
    };
  }
  return {
    valid: true,
    reason: "EXACT_RUN_ROOM_SCENE_AUTHORITY",
    runID: expectedRunID,
    roomIndex: expectedRoomIndex,
    sceneKey: expectedSceneKey,
  };
}

function queuePendingAbyssalNpcDestroyed(ports, destroyedNpc = {}, options = {}) {
  const {
    getDependencies,
    getActivePocketStateByInstanceID,
    evaluateAbyssalDirectCallbackTerminalGuard,
    deleteObjectiveDeath,
    setObjectiveDeath,
    cloneValue,
    log,
  } = ports;
  const instanceID = toInt(
    destroyedNpc && (
      destroyedNpc.abyssalRunID ||
      destroyedNpc.instanceID ||
      destroyedNpc.runID
    ),
    0,
  );
  const itemID = toInt(
    destroyedNpc && (
      destroyedNpc.npcID ||
      destroyedNpc.objectiveID ||
      destroyedNpc.itemID ||
      destroyedNpc.entityID
    ),
    0,
  );
  if (instanceID <= 0 || itemID <= 0) {
    return buildAbyssalNpcDestroyedResult(ports, "metadata-missing", {
      success: false,
      errorMsg: "ABYSSAL_NPC_DESTRUCTION_CONTEXT_MISSING",
    });
  }
  const pocketState = getActivePocketStateByInstanceID(instanceID);
  if (!pocketState) {
    return buildAbyssalNpcDestroyedResult(ports, "run-missing", {
      success: false,
      errorMsg: "ABYSSAL_RUN_NOT_FOUND",
    });
  }
  const terminalGuard = evaluateAbyssalDirectCallbackTerminalGuard(
    pocketState,
    "queue-pending-npc-destroyed",
  );
  if (terminalGuard.blocked) {
    deleteObjectiveDeath(instanceID, itemID);
    return buildAbyssalNpcDestroyedResult(ports, "terminal-suppressed", {
      handled: true,
      errorMsg: null,
    });
  }
  const authority = inspectAbyssalNpcDestructionAuthority(ports,
    destroyedNpc,
    pocketState,
    getDependencies(),
  );
  if (!authority.valid) {
    return buildAbyssalNpcDestroyedResult(ports, "metadata-invalid", {
      success: false,
      errorMsg: `ABYSSAL_NPC_DESTRUCTION_${authority.reason}`,
    });
  }
  setObjectiveDeath(instanceID, itemID, {
    ...cloneValue(destroyedNpc),
    npcID: itemID,
    itemID,
    abyssalRunID: instanceID,
    instanceID,
    abyssalRoomIndex: authority.roomIndex,
    roomIndex: authority.roomIndex,
    sceneKey: authority.sceneKey,
    abyssalAuthorityPresent: true,
    abyssalAuthorityValid: true,
    abyssalAuthorityReason: authority.reason,
    confirmedDestroyed: true,
    notificationPending: true,
    pendingReason: normalizeText(options.reason, "callback-error"),
    queuedAtMs: toInt(options.nowMs, toInt(getDependencies().now(), Date.now())),
  });
  if (options.suppressLog !== true) {
    log.warn(
      `[AbyssalMgr] Pending objective NPC destruction queued ` +
        `instance=${instanceID} npc=${itemID} ` +
        `room=${toInt(destroyedNpc.abyssalRoomIndex || destroyedNpc.roomIndex, 0) || "none"} ` +
        `sceneKey=${normalizeText(destroyedNpc.sceneKey, "none")} ` +
        `reason=${normalizeText(options.reason, "callback-error")}`,
    );
  }
  return buildAbyssalNpcDestroyedResult(ports, "queued-pending", {
    handled: false,
    pending: true,
  });
}

function reconcilePendingAbyssalObjectiveDeaths(ports, instanceID, deps = ports.getDependencies()) {
  const {
    getActivePocketStateByInstanceID,
    evaluateAbyssalDirectCallbackTerminalGuard,
    deleteObjectiveDeath,
    setObjectiveDeath,
    listObjectiveDeaths,
    clearObjectiveDeaths,
    handleAbyssalNpcDestroyed,
  } = ports;
  const pending = listObjectiveDeaths(instanceID);
  if (pending.length <= 0) {
    return 0;
  }
  const pocketState = getActivePocketStateByInstanceID(instanceID);
  if (!pocketState) {
    clearObjectiveDeaths(instanceID);
    return 0;
  }
  const terminalGuard = evaluateAbyssalDirectCallbackTerminalGuard(
    pocketState,
    "reconcile-pending-npc-destroyed",
  );
  if (terminalGuard.blocked) {
    clearObjectiveDeaths(instanceID);
    return 0;
  }
  let reconciledCount = 0;
  for (const [npcID, event] of pending) {
    deleteObjectiveDeath(instanceID, npcID);
    const result = handleAbyssalNpcDestroyed(
      {
        ...event,
        retryPending: true,
      },
      deps,
    );
    if (result && result.handled === true) {
      reconciledCount += 1;
    } else {
      setObjectiveDeath(instanceID, npcID, event);
    }
  }
  return reconciledCount;
}

function createAbyssalNpcDeathOperations(ports) {
  return {
    getRoomObjectiveIDSets: getRoomObjectiveIDSets.bind(null, ports),
    buildAbyssalNpcDestroyedResult: buildAbyssalNpcDestroyedResult.bind(null, ports),
    inspectAbyssalNpcDestructionAuthority: inspectAbyssalNpcDestructionAuthority.bind(null, ports),
    queuePendingAbyssalNpcDestroyed: queuePendingAbyssalNpcDestroyed.bind(null, ports),
    reconcilePendingAbyssalObjectiveDeaths: reconcilePendingAbyssalObjectiveDeaths.bind(null, ports),
  };
}

module.exports = { createAbyssalNpcDeathOperations };
