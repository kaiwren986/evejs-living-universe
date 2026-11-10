"use strict";

const { normalizeText } = require("../domain/abyssalValueUtils");

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function projectCommittedCareerOutcome(deps, instanceID) {
  // This bridge reads the durable run, so an open mutation batch cannot
  // publish uncommitted deaths. Failed consumers retain their source facts.
  try { deps.dungeonTrackingRuntime?.recordCareerAbyssalRun?.(instanceID); }
  catch (_) { /* query and terminal cleanup retry from the retained run */ }
}

function buildBatchCareerOutcomePatch(work) {
  let patch = {};
  for (const entry of work.entries) {
    if (work.results[entry.index]?.newlyRecorded !== true) continue;
    patch = { ...patch, ...(work.deps.dungeonTrackingRuntime?.buildCareerAbyssalNpcOutcome?.(
      { ...work.pocketState, ...patch }, entry.context, work.deps.now(),
    ) || {}) };
  }
  return patch;
}

function handleAbyssalNpcDestroyed(ports, destroyedNpc = {}, deps = ports.getDependencies()) {
  const work = { destroyedNpc, deps };
  for (const reconcile of [
    resolveDestroyedNpcAuthority,
    reconcileDestroyedNpcDependants,
    resolveDestroyedNpcDuplicateOrDependant,
    validateDestroyedNpcObjective,
  ]) {
    const resolved = reconcile(ports, work);
    if (resolved) return resolved;
  }
  return commitDestroyedNpcObjective(ports, work);
}

function resolveDestroyedNpcAuthority(ports, work) {
  const {
    buildAbyssalNpcDestroyedResult,
    getActivePocketStateByInstanceID,
    evaluateAbyssalDirectCallbackTerminalGuard,
    deleteObjectiveDeath,
    inspectAbyssalNpcDestructionAuthority,
    buildPlaceholderRoomState,
    getPlaceholderRoomEntry,
  } = ports;
  const {
    destroyedNpc,
    deps,
  } = work;
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
    return buildAbyssalNpcDestroyedResult("metadata-missing", {
      success: false,
      errorMsg: "ABYSSAL_NPC_DESTRUCTION_CONTEXT_MISSING",
    });
  }
  const pocketState = getActivePocketStateByInstanceID(instanceID);
  if (!pocketState) {
    return buildAbyssalNpcDestroyedResult("run-missing", {
      success: false,
      errorMsg: "ABYSSAL_RUN_NOT_FOUND",
    });
  }
  const terminalGuard = evaluateAbyssalDirectCallbackTerminalGuard(
    pocketState,
    "npc-destroyed",
  );
  if (terminalGuard.blocked) {
    deleteObjectiveDeath(instanceID, itemID);
    return buildAbyssalNpcDestroyedResult("terminal-suppressed", {
      handled: true,
    });
  }
  const authority = inspectAbyssalNpcDestructionAuthority(
    destroyedNpc,
    pocketState,
    deps,
  );
  if (!authority.valid) {
    return buildAbyssalNpcDestroyedResult("metadata-invalid", {
      success: false,
      errorMsg: `ABYSSAL_NPC_DESTRUCTION_${authority.reason}`,
    });
  }
  const roomState = buildPlaceholderRoomState(pocketState);
  const roomIndex = authority.roomIndex;
  const expectedSceneKey = authority.sceneKey;
  const actualSceneKey = authority.sceneKey;
  if (roomIndex !== toInt(roomState.currentRoomIndex, 1)) {
    return buildAbyssalNpcDestroyedResult("wrong-room", {
      success: false,
      errorMsg: "ABYSSAL_NPC_DESTRUCTION_ROOM_MISMATCH",
    });
  }
  const currentRoomEntry = getPlaceholderRoomEntry(pocketState, roomIndex);
  if (!currentRoomEntry) {
    return buildAbyssalNpcDestroyedResult("run-missing", {
      success: false,
      errorMsg: "ABYSSAL_ROOM_NOT_FOUND",
    });
  }
  Object.assign(work, { instanceID, itemID, pocketState, roomIndex, expectedSceneKey, actualSceneKey, currentRoomEntry });
  return null;
}

function reconcileDestroyedNpcDependants(ports, work) {
  const {
    buildAbyssalNpcDestroyedResult,
    reconcileControllerDependantLifecycleOnNpcDestroyed,
    cloneValue,
    listUniquePositiveInts,
    log,
    getRoomObjectiveIDSets,
  } = ports;
  const {
    deps,
    currentRoomEntry,
    itemID,
    instanceID,
    roomIndex,
  } = work;
  const npcRuntime = deps;
  const lifecycleResult = reconcileControllerDependantLifecycleOnNpcDestroyed(
    currentRoomEntry,
    itemID,
    npcRuntime,
    toInt(deps.now && deps.now(), Date.now()),
  );
  if (!lifecycleResult.success) {
    return buildAbyssalNpcDestroyedResult("dependant-deactivation-failed", {
      success: false,
      errorMsg: lifecycleResult.errorMsg,
      failures: cloneValue(lifecycleResult.data && lifecycleResult.data.failures) || [],
    });
  }
  const lifecyclePatch = {
    controllerDependantLifecycleGroups: cloneValue(
      lifecycleResult.data.controllerDependantLifecycleGroups,
    ),
    dependantInactiveNpcItemIDs: listUniquePositiveInts(
      lifecycleResult.data.dependantInactiveNpcItemIDs,
    ),
  };
  if (lifecycleResult.data.newlyInactiveNpcItemIDs.length > 0) {
    log.info(
      `[AbyssalControllerLifecycle] run=${instanceID} room=${roomIndex} ` +
        `controller=${itemID} dependantsInactive=${
          lifecycleResult.data.newlyInactiveNpcItemIDs.join(",")
        } state=dependant_inactive`,
    );
  }
  const {
    plannedObjectiveNpcItemIDs,
    materializedObjectiveNpcItemIDs,
    liveObjectiveIDs,
    destroyedObjectiveIDs,
    defeatedObjectiveItemIDs,
  } = getRoomObjectiveIDSets(currentRoomEntry);
  const destroyedDependantNpcItemIDs = listUniquePositiveInts(
    currentRoomEntry.destroyedDependantNpcItemIDs,
  );
  const trackedHostileIDs = listUniquePositiveInts(currentRoomEntry.hostileEntityIDs);
  const requiredObjectiveCount = Math.max(
    toInt(currentRoomEntry.objectiveTotal, 0),
    plannedObjectiveNpcItemIDs.length,
  );
  Object.assign(work, { lifecyclePatch, plannedObjectiveNpcItemIDs, materializedObjectiveNpcItemIDs, liveObjectiveIDs, destroyedObjectiveIDs, defeatedObjectiveItemIDs, destroyedDependantNpcItemIDs, trackedHostileIDs, requiredObjectiveCount });
  return null;
}

function resolveDestroyedNpcDuplicateOrDependant(ports, work) {
  const {
    buildAbyssalNpcDestroyedResult,
    getActivePocketStateByInstanceID,
    cloneValue,
    listUniquePositiveInts,
    runPlaceholderPocketMaintenance,
    setPlaceholderRoomEntry,
    updatePocketState,
    buildPocketStateForCurrentRoom,
    refreshAbyssalDungeonTrackingState,
  } = ports;
  const {
    destroyedObjectiveIDs,
    defeatedObjectiveItemIDs,
    itemID,
    deps,
    instanceID,
    pocketState,
    requiredObjectiveCount,
    liveObjectiveIDs,
    plannedObjectiveNpcItemIDs,
    destroyedDependantNpcItemIDs,
    trackedHostileIDs,
    roomIndex,
    currentRoomEntry,
    lifecyclePatch,
  } = work;
  if (
    destroyedObjectiveIDs.includes(itemID) ||
    defeatedObjectiveItemIDs.includes(itemID)
  ) {
    runPlaceholderPocketMaintenance(null, deps);
    const refreshedState = getActivePocketStateByInstanceID(instanceID) || pocketState;
    return buildAbyssalNpcDestroyedResult("already-notified", {
      handled: true,
      newlyRecorded: false,
      objectiveComplete: refreshedState.objectiveComplete === true,
      defeated: defeatedObjectiveItemIDs.length,
      required: requiredObjectiveCount,
      live: liveObjectiveIDs.length,
      destroyed: destroyedObjectiveIDs.length,
    });
  }
  if (!plannedObjectiveNpcItemIDs.includes(itemID)) {
    if (destroyedDependantNpcItemIDs.includes(itemID)) {
      return buildAbyssalNpcDestroyedResult("already-notified", {
        handled: true,
        newlyRecorded: false,
        objectiveComplete: pocketState.objectiveComplete === true,
        defeated: defeatedObjectiveItemIDs.length,
        required: requiredObjectiveCount,
        live: liveObjectiveIDs.length,
        destroyed: destroyedObjectiveIDs.length,
      });
    }
    if (trackedHostileIDs.includes(itemID)) {
      const nextHostileIDs = trackedHostileIDs.filter(
        (candidateID) => candidateID !== itemID,
      );
      const nextDestroyedDependantIDs = listUniquePositiveInts([
        ...destroyedDependantNpcItemIDs,
        itemID,
      ]);
      const nextRoomState = setPlaceholderRoomEntry(
        pocketState,
        roomIndex,
        {
          ...currentRoomEntry,
          ...lifecyclePatch,
          hostileEntityIDs: nextHostileIDs,
          destroyedDependantNpcItemIDs: nextDestroyedDependantIDs,
        },
      );
      updatePocketState(instanceID, {
        ...buildPocketStateForCurrentRoom(pocketState, nextRoomState),
        ...(deps.dungeonTrackingRuntime?.buildCareerAbyssalNpcOutcome?.(pocketState, work.destroyedNpc, deps.now()) || {}),
        encounterState: {
          ...cloneValue(pocketState.encounterState || {}),
          ...lifecyclePatch,
          hostileEntityIDs: nextHostileIDs,
          destroyedDependantNpcItemIDs: nextDestroyedDependantIDs,
        },
      });
      projectCommittedCareerOutcome(deps, instanceID);
      refreshAbyssalDungeonTrackingState(
        getActivePocketStateByInstanceID(instanceID) || pocketState,
        deps,
        "dependant_npc_destroyed",
      );
      return buildAbyssalNpcDestroyedResult("dependant-notified", {
        handled: true,
        newlyRecorded: true,
        objectiveComplete: pocketState.objectiveComplete === true,
        defeated: defeatedObjectiveItemIDs.length,
        required: requiredObjectiveCount,
        live: liveObjectiveIDs.length,
        destroyed: destroyedObjectiveIDs.length,
      });
    }
    return buildAbyssalNpcDestroyedResult("not-tracked", {
      success: false,
      errorMsg: "ABYSSAL_NPC_NOT_PLANNED_OBJECTIVE",
      required: requiredObjectiveCount,
      live: liveObjectiveIDs.length,
      destroyed: destroyedObjectiveIDs.length,
    });
  }
  return null;
}

function validateDestroyedNpcObjective(ports, work) {
  const {
    buildAbyssalNpcDestroyedResult,
  } = ports;
  const {
    materializedObjectiveNpcItemIDs,
    itemID,
    requiredObjectiveCount,
    liveObjectiveIDs,
    destroyedObjectiveIDs,
  } = work;
  if (!materializedObjectiveNpcItemIDs.includes(itemID)) {
    return buildAbyssalNpcDestroyedResult("not-tracked", {
      success: false,
      errorMsg: "ABYSSAL_NPC_NOT_MATERIALIZED_OBJECTIVE",
      required: requiredObjectiveCount,
      live: liveObjectiveIDs.length,
      destroyed: destroyedObjectiveIDs.length,
    });
  }
  if (!liveObjectiveIDs.includes(itemID)) {
    return buildAbyssalNpcDestroyedResult("not-tracked", {
      success: false,
      errorMsg: "ABYSSAL_NPC_NOT_LIVE_OBJECTIVE",
      required: requiredObjectiveCount,
      live: liveObjectiveIDs.length,
      destroyed: destroyedObjectiveIDs.length,
    });
  }
  return null;
}

function commitDestroyedNpcObjective(ports, work) {
  const {
    buildAbyssalNpcDestroyedResult,
    getActivePocketStateByInstanceID,
    cloneValue,
    listUniquePositiveInts,
    log,
    runPlaceholderPocketMaintenance,
    setPlaceholderRoomEntry,
    updatePocketState,
    buildPocketStateForCurrentRoom,
    refreshAbyssalDungeonTrackingState,
    recordAuditEvent,
  } = ports;
  const {
    liveObjectiveIDs,
    itemID,
    currentRoomEntry,
    defeatedObjectiveItemIDs,
    destroyedObjectiveIDs,
    pocketState,
    roomIndex,
    lifecyclePatch,
    plannedObjectiveNpcItemIDs,
    materializedObjectiveNpcItemIDs,
    requiredObjectiveCount,
    instanceID,
    deps,
    actualSceneKey,
    expectedSceneKey,
  } = work;
  const nextObjectiveIDs = liveObjectiveIDs.filter((candidateID) => candidateID !== itemID);
  const nextHostileIDs = listUniquePositiveInts(currentRoomEntry.hostileEntityIDs)
    .filter((candidateID) => candidateID !== itemID);
  const nextDefeatedIDs = listUniquePositiveInts([...defeatedObjectiveItemIDs, itemID]);
  const nextDestroyedIDs = listUniquePositiveInts([...destroyedObjectiveIDs, itemID]);
  const nextRoomState = setPlaceholderRoomEntry(
    pocketState,
    roomIndex,
    {
      ...currentRoomEntry,
      ...lifecyclePatch,
      hostileEntityIDs: nextHostileIDs,
      plannedObjectiveNpcItemIDs,
      materializedObjectiveNpcItemIDs,
      objectiveRelevantNpcItemIDs: nextObjectiveIDs,
      defeatedObjectiveItemIDs: nextDefeatedIDs,
      destroyedObjectiveIDs: nextDestroyedIDs,
      objectiveTotal: requiredObjectiveCount,
      objectiveDefeatedCount: nextDefeatedIDs.length,
    },
  );
  updatePocketState(instanceID, {
    ...buildPocketStateForCurrentRoom(pocketState, nextRoomState),
    ...(deps.dungeonTrackingRuntime?.buildCareerAbyssalNpcOutcome?.(pocketState, work.destroyedNpc, deps.now()) || {}),
    encounterState: {
      ...cloneValue(pocketState.encounterState || {}),
      ...lifecyclePatch,
      hostileEntityIDs: nextHostileIDs,
      plannedObjectiveNpcItemIDs,
      materializedObjectiveNpcItemIDs,
      objectiveRelevantNpcItemIDs: nextObjectiveIDs,
      defeatedObjectiveItemIDs: nextDefeatedIDs,
      destroyedObjectiveIDs: nextDestroyedIDs,
      objectiveTotal: requiredObjectiveCount,
      objectiveDefeatedCount: nextDefeatedIDs.length,
    },
  });
  projectCommittedCareerOutcome(deps, instanceID);
  refreshAbyssalDungeonTrackingState(
    getActivePocketStateByInstanceID(instanceID) || pocketState,
    deps,
    "objective_npc_destroyed",
  );
  recordAuditEvent("abyssal_objective_npc_destroyed", [], null, {
    instanceID,
    itemID,
    roomIndex,
    sceneKey: actualSceneKey || expectedSceneKey,
  });
  log.info(
    `[AbyssalMgr] Abyssal objective NPC destroyed ` +
      `instance=${instanceID} room=${roomIndex} npc=${itemID} ` +
      `planned=${plannedObjectiveNpcItemIDs.length} materialized=${materializedObjectiveNpcItemIDs.length} ` +
      `live=${nextObjectiveIDs.length} destroyed=${nextDestroyedIDs.length} ` +
      `sceneKey=${actualSceneKey || expectedSceneKey || "none"}`,
  );
  runPlaceholderPocketMaintenance(null, deps);
  const refreshedState = getActivePocketStateByInstanceID(instanceID) || pocketState;
  return buildAbyssalNpcDestroyedResult("notified", {
    handled: true,
    newlyRecorded: true,
    objectiveComplete: refreshedState.objectiveComplete === true,
    defeated: nextDefeatedIDs.length,
    required: requiredObjectiveCount,
    live: nextObjectiveIDs.length,
    destroyed: nextDestroyedIDs.length,
  });
}

function createAbyssalNpcDestruction(ports) {
  return {
    handleAbyssalNpcDestroyed: handleAbyssalNpcDestroyed.bind(null, ports),
    handleAbyssalNpcsDestroyed: handleAbyssalNpcsDestroyed.bind(null, ports),
  };
}

module.exports = { createAbyssalNpcDestruction };

// Keep the public Promise contract, but never yield while a mutation batch is open.
async function handleAbyssalNpcsDestroyed(ports, destroyedNpcs = [], deps = ports.getDependencies()) {
  const { buildAbyssalNpcDestroyedResult } = ports;
  const contexts = Array.isArray(destroyedNpcs)
    ? destroyedNpcs.filter((context) => context && typeof context === "object")
    : [];
  if (contexts.length === 0) {
    return {
      success: true,
      handled: true,
      results: [],
      committedRunCount: 0,
      maintenancePassCount: 0,
    };
  }
  if (contexts.length === 1) {
    const results = contexts.map((context) => handleAbyssalNpcDestroyed(ports, context, deps));
    return {
      success: results.every((result) => result && result.success !== false),
      handled: results.some((result) => result && result.handled === true),
      results,
      committedRunCount: 0,
      maintenancePassCount: contexts.length,
    };
  }
  const startedAtMs = Date.now();
  const results = new Array(contexts.length);
  const contextsByInstanceID = new Map();
  contexts.forEach((context, index) => {
    const instanceID = toInt(
      context && (context.abyssalRunID || context.instanceID || context.runID),
      0,
    );
    const itemID = toInt(
      context && (context.npcID || context.objectiveID || context.itemID || context.entityID),
      0,
    );
    if (instanceID <= 0 || itemID <= 0) {
      results[index] = buildAbyssalNpcDestroyedResult("metadata-missing", {
        success: false,
        errorMsg: "ABYSSAL_NPC_DESTRUCTION_CONTEXT_MISSING",
      });
      return;
    }
    const entries = contextsByInstanceID.get(instanceID) || [];
    entries.push({ context, index, itemID });
    contextsByInstanceID.set(instanceID, entries);
  });
  const commitFailures = [];
  const pendingMutationBatchInstanceIDs = new Set();
  let committedRunCount = 0;
  let changedRunCount = 0;
  const work = { contexts, deps, results, contextsByInstanceID, commitFailures, pendingMutationBatchInstanceIDs, startedAtMs };
  for (const [instanceID, entries] of contextsByInstanceID.entries()) {
    if (reconcileNpcBatchRun(ports, { ...work, instanceID, entries })) changedRunCount += 1;
  }
  return finishNpcBatch(ports, { ...work, changedRunCount, committedRunCount });
}

function reconcileNpcBatchRun(ports, work) {
  const {
    buildAbyssalNpcDestroyedResult,
    getActivePocketStateByInstanceID,
    evaluateAbyssalDirectCallbackTerminalGuard,
    buildPlaceholderRoomState,
    cloneValue,
    listUniquePositiveInts,
    getRoomObjectiveIDSets,
  } = ports;
  const {
    instanceID,
    entries,
    deps,
    results,
  } = work;
  const pocketState = getActivePocketStateByInstanceID(instanceID);
  if (!pocketState) {
      for (const entry of entries) {
        results[entry.index] = buildAbyssalNpcDestroyedResult("run-missing", {
          success: false,
          errorMsg: "ABYSSAL_RUN_NOT_FOUND",
        });
      }
      return false;
    }
  const terminalGuard = evaluateAbyssalDirectCallbackTerminalGuard(
      pocketState,
      "npc-destroyed-batch",
    );
  if (terminalGuard.blocked) {
      for (const entry of entries) {
        results[entry.index] = buildAbyssalNpcDestroyedResult("terminal-suppressed", {
          handled: true,
        });
      }
      return false;
    }
  const roomState = buildPlaceholderRoomState(pocketState);
  const roomIndex = roomState.currentRoomIndex;
  let workingRoomEntry = cloneValue(
      roomState.roomStatesByIndex[String(roomIndex)] || {},
    );
  const objectiveSets = getRoomObjectiveIDSets(workingRoomEntry);
  const plannedObjectiveIDs = new Set(objectiveSets.plannedObjectiveNpcItemIDs);
  const materializedObjectiveIDs = new Set(objectiveSets.materializedObjectiveNpcItemIDs);
  const liveObjectiveIDs = new Set(objectiveSets.liveObjectiveIDs);
  const destroyedObjectiveIDs = new Set(objectiveSets.destroyedObjectiveIDs);
  const defeatedObjectiveIDs = new Set(objectiveSets.defeatedObjectiveItemIDs);
  const hostileIDs = new Set(listUniquePositiveInts(workingRoomEntry.hostileEntityIDs));
  const destroyedDependantIDs = new Set(
      listUniquePositiveInts(workingRoomEntry.destroyedDependantNpcItemIDs),
    );
  const requiredObjectiveCount = Math.max(
      toInt(workingRoomEntry.objectiveTotal, 0),
      plannedObjectiveIDs.size,
    );
  let changed = false;
  Object.assign(work, { pocketState, roomIndex, workingRoomEntry, plannedObjectiveIDs, materializedObjectiveIDs, liveObjectiveIDs, destroyedObjectiveIDs, defeatedObjectiveIDs, hostileIDs, destroyedDependantIDs, requiredObjectiveCount, changed });
  for (const entry of entries) {
    work.entry = entry;
    if (inspectBatchNpcAuthority(ports, work)) continue;
    if (resolveBatchNpcDisposition(ports, work)) continue;
    recordBatchNpcObjective(ports, work);
  }
  if (!work.changed) return false;
  applyBatchRunMutation(ports, work);
  return true;
}

function inspectBatchNpcAuthority(ports, work) {
  const {
    buildAbyssalNpcDestroyedResult,
    inspectAbyssalNpcDestructionAuthority,
    reconcileControllerDependantLifecycleOnNpcDestroyed,
    cloneValue,
    listUniquePositiveInts,
  } = ports;
  const {
    entry,
    pocketState,
    deps,
    roomIndex,
    results,
    workingRoomEntry,
  } = work;
  const { context, itemID, index } = entry;
  const authority = inspectAbyssalNpcDestructionAuthority(context, pocketState, deps);
  if (!authority.valid) {
        results[index] = buildAbyssalNpcDestroyedResult("metadata-invalid", {
          success: false,
          errorMsg: `ABYSSAL_NPC_DESTRUCTION_${authority.reason}`,
        });
        return true;
      }
  if (authority.roomIndex !== roomIndex) {
        results[index] = buildAbyssalNpcDestroyedResult("wrong-room", {
          success: false,
          errorMsg: "ABYSSAL_NPC_DESTRUCTION_ROOM_MISMATCH",
        });
        return true;
      }
  const lifecycleResult = reconcileControllerDependantLifecycleOnNpcDestroyed(
        workingRoomEntry,
        itemID,
        deps,
        toInt(deps.now && deps.now(), Date.now()),
      );
  if (!lifecycleResult.success) {
        results[index] = buildAbyssalNpcDestroyedResult(
          "dependant-deactivation-failed",
          {
            success: false,
            errorMsg: lifecycleResult.errorMsg,
            failures: cloneValue(lifecycleResult.data && lifecycleResult.data.failures) || [],
          },
        );
        return true;
      }
  work.workingRoomEntry = {
        ...workingRoomEntry,
        controllerDependantLifecycleGroups: cloneValue(
          lifecycleResult.data.controllerDependantLifecycleGroups,
        ),
        dependantInactiveNpcItemIDs: listUniquePositiveInts(
          lifecycleResult.data.dependantInactiveNpcItemIDs,
        ),
      };
  Object.assign(work, { context, itemID, index, authority });
  return false;
}

function resolveBatchNpcDisposition(ports, work) {
  const {
    buildAbyssalNpcDestroyedResult,
  } = ports;
  const {
    destroyedObjectiveIDs,
    defeatedObjectiveIDs,
    itemID,
    results,
    index,
    pocketState,
    requiredObjectiveCount,
    liveObjectiveIDs,
    plannedObjectiveIDs,
    destroyedDependantIDs,
    hostileIDs,
    materializedObjectiveIDs,
  } = work;
  if (destroyedObjectiveIDs.has(itemID) || defeatedObjectiveIDs.has(itemID)) {
        results[index] = buildAbyssalNpcDestroyedResult("already-notified", {
          handled: true,
          newlyRecorded: false,
          objectiveComplete: pocketState.objectiveComplete === true,
          defeated: defeatedObjectiveIDs.size,
          required: requiredObjectiveCount,
          live: liveObjectiveIDs.size,
          destroyed: destroyedObjectiveIDs.size,
        });
        return true;
      }
  if (!plannedObjectiveIDs.has(itemID)) {
        if (destroyedDependantIDs.has(itemID)) {
          results[index] = buildAbyssalNpcDestroyedResult("already-notified", {
            handled: true,
            newlyRecorded: false,
            objectiveComplete: pocketState.objectiveComplete === true,
          });
        } else if (hostileIDs.has(itemID)) {
          hostileIDs.delete(itemID);
          destroyedDependantIDs.add(itemID);
          work.changed = true;
          results[index] = buildAbyssalNpcDestroyedResult("dependant-notified", {
            handled: true,
            newlyRecorded: true,
            objectiveComplete: pocketState.objectiveComplete === true,
            defeated: defeatedObjectiveIDs.size,
            required: requiredObjectiveCount,
            live: liveObjectiveIDs.size,
            destroyed: destroyedObjectiveIDs.size,
          });
        } else {
          results[index] = buildAbyssalNpcDestroyedResult("not-tracked", {
            success: false,
            errorMsg: "ABYSSAL_NPC_NOT_PLANNED_OBJECTIVE",
          });
        }
        return true;
      }
  if (!materializedObjectiveIDs.has(itemID)) {
        results[index] = buildAbyssalNpcDestroyedResult("not-tracked", {
          success: false,
          errorMsg: "ABYSSAL_NPC_NOT_MATERIALIZED_OBJECTIVE",
        });
        return true;
      }
  if (!liveObjectiveIDs.has(itemID)) {
        results[index] = buildAbyssalNpcDestroyedResult("not-tracked", {
          success: false,
          errorMsg: "ABYSSAL_NPC_NOT_LIVE_OBJECTIVE",
        });
        return true;
      }
  return false;
}

function recordBatchNpcObjective(ports, work) {
  const {
    buildAbyssalNpcDestroyedResult,
    recordAuditEvent,
  } = ports;
  const {
    liveObjectiveIDs,
    hostileIDs,
    defeatedObjectiveIDs,
    destroyedObjectiveIDs,
    itemID,
    results,
    index,
    requiredObjectiveCount,
    instanceID,
    roomIndex,
    authority,
  } = work;
  liveObjectiveIDs.delete(itemID);
  hostileIDs.delete(itemID);
  defeatedObjectiveIDs.add(itemID);
  destroyedObjectiveIDs.add(itemID);
  work.changed = true;
  results[index] = buildAbyssalNpcDestroyedResult("notified", {
        handled: true,
        newlyRecorded: true,
        objectiveComplete: false,
        defeated: defeatedObjectiveIDs.size,
        required: requiredObjectiveCount,
        live: liveObjectiveIDs.size,
        destroyed: destroyedObjectiveIDs.size,
      });
  recordAuditEvent("abyssal_objective_npc_destroyed", [], null, {
        instanceID,
        itemID,
        roomIndex,
        sceneKey: authority.sceneKey,
      });
}

function applyBatchRunMutation(ports, work) {
  const {
    getActivePocketStateByInstanceID,
    cloneValue,
    listUniquePositiveInts,
    setPlaceholderRoomEntry,
    updatePocketState,
    buildPocketStateForCurrentRoom,
    refreshAbyssalDungeonTrackingState,
    beginAbyssalPocketMutationBatch,
    abortAbyssalPocketMutationBatch,
    queuePendingAbyssalNpcDestroyed,
  } = ports;
  const {
    workingRoomEntry,
    hostileIDs,
    plannedObjectiveIDs,
    materializedObjectiveIDs,
    liveObjectiveIDs,
    defeatedObjectiveIDs,
    destroyedObjectiveIDs,
    destroyedDependantIDs,
    requiredObjectiveCount,
    instanceID,
    deps,
    pendingMutationBatchInstanceIDs,
    pocketState,
    roomIndex,
    commitFailures,
    entries,
    results,
  } = work;
  const nextRoomEntry = {
      ...workingRoomEntry,
      hostileEntityIDs: [...hostileIDs].sort((left, right) => left - right),
      plannedObjectiveNpcItemIDs: [...plannedObjectiveIDs].sort((left, right) => left - right),
      materializedObjectiveNpcItemIDs: [...materializedObjectiveIDs].sort((left, right) => left - right),
      objectiveRelevantNpcItemIDs: [...liveObjectiveIDs].sort((left, right) => left - right),
      defeatedObjectiveItemIDs: [...defeatedObjectiveIDs].sort((left, right) => left - right),
      destroyedObjectiveIDs: [...destroyedObjectiveIDs].sort((left, right) => left - right),
      destroyedDependantNpcItemIDs: [...destroyedDependantIDs].sort((left, right) => left - right),
      objectiveTotal: requiredObjectiveCount,
      objectiveDefeatedCount: defeatedObjectiveIDs.size,
    };
  try {
      const batchStartResult = beginAbyssalPocketMutationBatch(instanceID, deps);
      if (!batchStartResult || batchStartResult.success !== true) {
        const batchStartError = new Error(
          normalizeText(
            batchStartResult && batchStartResult.errorMsg,
            "ABYSSAL_NPC_BATCH_START_FAILED",
          ),
        );
        batchStartError.code = batchStartError.message;
        throw batchStartError;
      }
      pendingMutationBatchInstanceIDs.add(instanceID);
      const nextRoomState = setPlaceholderRoomEntry(
        pocketState,
        roomIndex,
        nextRoomEntry,
      );
      updatePocketState(instanceID, {
        ...buildPocketStateForCurrentRoom(pocketState, nextRoomState),
        ...buildBatchCareerOutcomePatch(work),
        encounterState: {
          ...cloneValue(pocketState.encounterState || {}),
          controllerDependantLifecycleGroups: cloneValue(
            nextRoomEntry.controllerDependantLifecycleGroups,
          ),
          dependantInactiveNpcItemIDs: listUniquePositiveInts(
            nextRoomEntry.dependantInactiveNpcItemIDs,
          ),
          hostileEntityIDs: nextRoomEntry.hostileEntityIDs,
          plannedObjectiveNpcItemIDs: nextRoomEntry.plannedObjectiveNpcItemIDs,
          materializedObjectiveNpcItemIDs: nextRoomEntry.materializedObjectiveNpcItemIDs,
          objectiveRelevantNpcItemIDs: nextRoomEntry.objectiveRelevantNpcItemIDs,
          defeatedObjectiveItemIDs: nextRoomEntry.defeatedObjectiveItemIDs,
          destroyedObjectiveIDs: nextRoomEntry.destroyedObjectiveIDs,
          destroyedDependantNpcItemIDs: nextRoomEntry.destroyedDependantNpcItemIDs,
          objectiveTotal: requiredObjectiveCount,
          objectiveDefeatedCount: defeatedObjectiveIDs.size,
        },
      });
      refreshAbyssalDungeonTrackingState(
        getActivePocketStateByInstanceID(instanceID) || pocketState,
        deps,
        "objective_npc_destroyed_batch",
      );
    } catch (error) {
      if (pendingMutationBatchInstanceIDs.delete(instanceID)) {
        abortAbyssalPocketMutationBatch(instanceID);
      }
      const errorMsg = normalizeText(
        error && (error.code || error.message),
        "ABYSSAL_NPC_BATCH_PERSIST_FAILED",
      );
      commitFailures.push({ instanceID, errorMsg });
      for (const entry of entries) {
        if (results[entry.index] && results[entry.index].newlyRecorded === true) {
          queuePendingAbyssalNpcDestroyed(entry.context, {
            reason: errorMsg,
            nowMs: deps.now && deps.now(),
          });
        }
      }
    }
}

function finishNpcBatch(ports, work) {
  const {
    log,
    runPlaceholderPocketMaintenance,
    abortAbyssalPocketMutationBatch,
    queuePendingAbyssalNpcDestroyed,
    commitAbyssalPocketMutationBatch,
  } = ports;
  const {
    pendingMutationBatchInstanceIDs,
    deps,
    commitFailures,
    contextsByInstanceID,
    results,
    startedAtMs,
    contexts,
    changedRunCount,
  } = work;
  let {
    committedRunCount,
  } = work;
// A batch has no asynchronous ownership token: maintenance and commits stay synchronous.
  const maintenanceRequested = pendingMutationBatchInstanceIDs.size > 0;
  let maintenanceResult;
  try {
    maintenanceResult = maintenanceRequested
      ? runPlaceholderPocketMaintenance(null, deps)
      : { success: true, skipped: true, reason: "NOT_REQUESTED" };
  } catch (error) {
    for (const instanceID of pendingMutationBatchInstanceIDs) {
      abortAbyssalPocketMutationBatch(instanceID);
    }
    throw error;
  }
  for (const instanceID of pendingMutationBatchInstanceIDs) {
    const commitResult = commitAbyssalPocketMutationBatch(instanceID, deps);
    if (commitResult && commitResult.success === true) {
      committedRunCount += 1;
      projectCommittedCareerOutcome(deps, instanceID);
      continue;
    }
    const errorMsg = normalizeText(
      commitResult && commitResult.errorMsg,
      "ABYSSAL_NPC_BATCH_PERSIST_FAILED",
    );
    commitFailures.push({ instanceID, errorMsg });
    for (const entry of contextsByInstanceID.get(instanceID) || []) {
      if (results[entry.index] && results[entry.index].newlyRecorded === true) {
        queuePendingAbyssalNpcDestroyed(entry.context, {
          reason: errorMsg,
          nowMs: deps.now && deps.now(),
        });
      }
    }
  }
  const durationMs = Math.max(0, Date.now() - startedAtMs);
  log.info(
    `[AbyssalNpcBatch] contexts=${contexts.length} runs=${contextsByInstanceID.size} ` +
      `committedRuns=${committedRunCount} commitFailures=${commitFailures.length} ` +
      `changedRuns=${changedRunCount} maintenancePasses=${maintenanceRequested ? 1 : 0} ` +
      `totalMs=${durationMs}`,
  );
  return {
    success: commitFailures.length === 0,
    handled: results.some((result) => result && result.handled === true),
    results,
    committedRunCount,
    commitFailures,
    maintenancePassCount: maintenanceRequested ? 1 : 0,
    maintenanceResult,
    durationMs,
  };
}
