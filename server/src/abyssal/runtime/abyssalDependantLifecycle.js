"use strict";

// Stateless operations; persistence, runtime and scheduling remain owned by injected ports.
function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function reconcileControllerDependantLifecycleOnNpcDestroyed(ports,
  roomEntry,
  destroyedNpcItemID,
  npcRuntime,
  nowMs,
) {
  const {
    cloneValue,
    listUniquePositiveInts,
  } = ports;
  const lifecycleGroups = Array.isArray(
    roomEntry && roomEntry.controllerDependantLifecycleGroups,
  )
    ? cloneValue(roomEntry.controllerDependantLifecycleGroups)
    : [];
  const inactiveDependantIDs = new Set(
    listUniquePositiveInts(roomEntry && roomEntry.dependantInactiveNpcItemIDs),
  );
  const affectedDependantIDs = new Set();
  let controllerMatched = false;
  for (const group of lifecycleGroups) {
    if (toInt(group && group.controllerNpcItemID, 0) !== destroyedNpcItemID) {
      continue;
    }
    controllerMatched = true;
    group.controllerActive = false;
    group.controllerDestroyedAtMs = Math.max(0, toInt(nowMs, 0));
    for (const dependantNpcItemID of listUniquePositiveInts(
      group && group.dependantNpcItemIDs,
    )) {
      affectedDependantIDs.add(dependantNpcItemID);
    }
  }

  if (!controllerMatched) {
    return {
      success: true,
      data: {
        controllerDependantLifecycleGroups: lifecycleGroups,
        dependantInactiveNpcItemIDs: [...inactiveDependantIDs],
        newlyInactiveNpcItemIDs: [],
      },
    };
  }

  const newlyInactiveNpcItemIDs = [];
  const failures = [];
  for (const dependantNpcItemID of affectedDependantIDs) {
    const hasAnotherActiveController = lifecycleGroups.some((group) =>
      group &&
      group.controllerActive !== false &&
      listUniquePositiveInts(group.dependantNpcItemIDs).includes(dependantNpcItemID)
    );
    if (hasAnotherActiveController || inactiveDependantIDs.has(dependantNpcItemID)) {
      continue;
    }
    const deactivateResult =
      npcRuntime && typeof npcRuntime.deactivateNpcControllerCombat === "function"
        ? npcRuntime.deactivateNpcControllerCombat(dependantNpcItemID, {
            reason: "abyssal_controller_destroyed",
            lifecycleState: "dependant_inactive",
            nowMs,
          })
        : {
            success: false,
            errorMsg: "NPC_CONTROLLER_COMBAT_DEACTIVATION_UNAVAILABLE",
          };
    if (!deactivateResult || deactivateResult.success === false) {
      failures.push({
        npcItemID: dependantNpcItemID,
        errorMsg:
          deactivateResult && deactivateResult.errorMsg ||
          "NPC_CONTROLLER_COMBAT_DEACTIVATION_FAILED",
      });
      continue;
    }
    inactiveDependantIDs.add(dependantNpcItemID);
    newlyInactiveNpcItemIDs.push(dependantNpcItemID);
  }

  return {
    success: failures.length === 0,
    errorMsg:
      failures.length > 0
        ? "ABYSSAL_DEPENDANT_COMBAT_DEACTIVATION_FAILED"
        : null,
    data: {
      controllerDependantLifecycleGroups: lifecycleGroups,
      dependantInactiveNpcItemIDs: [...inactiveDependantIDs].sort(
        (left, right) => left - right,
      ),
      newlyInactiveNpcItemIDs,
      failures,
    },
  };
}

function createAbyssalDependantLifecycle(ports) {
  return {
    reconcileControllerDependantLifecycleOnNpcDestroyed: reconcileControllerDependantLifecycleOnNpcDestroyed.bind(null, ports),
  };
}

module.exports = { createAbyssalDependantLifecycle };
