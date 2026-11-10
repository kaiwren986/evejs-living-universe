"use strict";

const { normalizeText } = require("../domain/abyssalValueUtils");
const {
  ABYSSAL_SURVIVOR_CONTROLLER_HANDOFF_STATUS,
  createAbyssalSurvivorControllerHandoffCoordinator,
  selectAbyssalSurvivorController,
} = require("./abyssalSurvivorControllerHandoffCoordinator");

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function buildAbyssalNpcControllerReadiness(ports, pocketState, npcID, scene, npcRuntime, options = {}) {
  const work = { pocketState, npcID, scene, npcRuntime, options };
  inspectNpcReadinessIdentity(ports, work);
  inspectNpcReadinessLifecycle(ports, work);
  resolveNpcReadinessFailure(ports, work);
  return buildNpcReadinessReceipt(ports, work);
}

function inspectNpcReadinessIdentity(ports, work) {
  const {
    resolveEntityBubbleForScene,
    getNpcWeaponModules,
    getNpcEntityMissileWeaponSource,
    buildPlaceholderRoomState,
  } = ports;
  const {
    pocketState,
    npcID,
    scene,
    npcRuntime,
    options,
  } = work;
  const entityBubble = resolveEntityBubbleForScene(scene, npcID);
  const entity = entityBubble.entity;
  const controller =
    npcRuntime && typeof npcRuntime.getControllerByEntityID === "function"
      ? npcRuntime.getControllerByEntityID(npcID)
      : null;
  const playerBubble = resolveEntityBubbleForScene(
    scene,
    options.playerEntity || options.playerID || toInt(pocketState && pocketState.shipID, 0),
  );
  const behaviorProfile =
    controller && controller.behaviorProfile && typeof controller.behaviorProfile === "object"
      ? controller.behaviorProfile
      : null;
  const effectiveWeaponModules = entity ? getNpcWeaponModules(entity) : [];
  const entityMissileWeaponSource = entity ? getNpcEntityMissileWeaponSource(entity) : null;
  const weaponCount = effectiveWeaponModules.length + (entityMissileWeaponSource ? 1 : 0);
  const actionableCapabilityIDs = [...new Set(
    (Array.isArray(entity && entity.evejsNpcCapabilities)
      ? entity.evejsNpcCapabilities
      : [])
      .map((capabilityID) => normalizeText(capabilityID, ""))
      .filter(Boolean),
  )];
  const sceneKey = normalizeText(scene && scene.sceneKey, "");
  const controllerSceneKey = normalizeText(controller && controller.sceneKey, "");
  const entitySceneKey = normalizeText(entity && entity.sceneKey, "");
  const playerSceneKey = normalizeText(playerBubble.entity && playerBubble.entity.sceneKey, "");
  const expectedRunID = toInt(pocketState && pocketState.instanceID, 0);
  const expectedRoomIndex = toInt(
    options.roomIndex,
    buildPlaceholderRoomState(pocketState).currentRoomIndex,
  );
  const entityRunID = toInt(
    entity && entity.abyssalRunID,
    toInt(
      entity && entity.evejsAbyssalInstanceID,
      toInt(entity && entity.evejsAbyssalPocketInstanceID, 0),
    ),
  );
  const entityRoomIndex = toInt(
    entity && entity.abyssalRoomIndex,
    toInt(entity && entity.evejsAbyssalRoomIndex, 0),
  );
  const controllerRunID = toInt(
    controller && controller.abyssalRunID,
    toInt(controller && controller.instanceID, 0),
  );
  const controllerRoomIndex = toInt(
    controller && controller.abyssalRoomIndex,
    toInt(controller && controller.evejsAbyssalRoomIndex, 0),
  );
  Object.assign(work, { entityBubble, entity, controller, playerBubble, behaviorProfile, effectiveWeaponModules, entityMissileWeaponSource, weaponCount, actionableCapabilityIDs, sceneKey, controllerSceneKey, entitySceneKey, playerSceneKey, expectedRunID, expectedRoomIndex, entityRunID, entityRoomIndex, controllerRunID, controllerRoomIndex });
}

function inspectNpcReadinessLifecycle(ports, work) {
  const {
    controller,
    behaviorProfile,
    sceneKey,
    entitySceneKey,
    controllerSceneKey,
    playerSceneKey,
    entityBubble,
    playerBubble,
    npcID,
    entity,
    options,
  } = work;
  const controllerPaused = Boolean(controller && (
    controller.controllerPaused === true ||
    controller.controllerLifecycleState === "materialized_paused"
  ));
  const controllerActive = Boolean(
    controller &&
      controller.controllerLifecycleState === "active" &&
      !controllerPaused,
  );
  const tickScheduled = Boolean(
    controller && Number.isFinite(Number(controller.nextThinkAtMs)),
  );
  const tickRunnable =
    controller &&
    !controllerPaused &&
    Number.isFinite(Number(controller.nextThinkAtMs)) &&
    Number(controller.nextThinkAtMs) < Number.MAX_SAFE_INTEGER;
  const movementAvailable = Boolean(
    behaviorProfile &&
    (
      normalizeText(behaviorProfile.movementMode, "") ||
      toInt(behaviorProfile.orbitDistanceMeters, 0) > 0 ||
      toInt(behaviorProfile.followRangeMeters, 0) > 0
    ),
  );
  const sameScene = Boolean(
    sceneKey &&
      entitySceneKey === sceneKey &&
      controllerSceneKey === sceneKey &&
      playerSceneKey === sceneKey,
  );
  const sameBubble = Boolean(
    entityBubble.entityBubbleID > 0 &&
      entityBubble.sceneBubbleID === entityBubble.entityBubbleID &&
      entityBubble.bubbleRegistered &&
      playerBubble.entityBubbleID > 0 &&
      playerBubble.sceneBubbleID === playerBubble.entityBubbleID &&
      playerBubble.bubbleRegistered &&
      playerBubble.entityBubbleID === entityBubble.entityBubbleID,
  );
  const controllerEntityMatches = Boolean(
    controller && toInt(controller.entityID, 0) === toInt(npcID, 0),
  );
  const controllerEntityReferenceMatches = Boolean(
    !controller ||
      !controller.entity ||
      controller.entity === entity,
  );
  const lifecycleReady = options.expectPaused === true
    ? controllerPaused || (options.allowAlreadyActive === true && controllerActive && tickRunnable)
    : controllerActive && tickRunnable;
  const roomActive = options.roomActive === true;
  Object.assign(work, { controllerPaused, controllerActive, tickScheduled, tickRunnable, movementAvailable, sameScene, sameBubble, controllerEntityMatches, controllerEntityReferenceMatches, lifecycleReady, roomActive });
}

function resolveNpcReadinessFailure(ports, work) {
  const {
    scene,
    entity,
    controller,
    controllerEntityMatches,
    controllerEntityReferenceMatches,
    entityRunID,
    expectedRunID,
    entityRoomIndex,
    expectedRoomIndex,
    controllerRunID,
    controllerRoomIndex,
    sameScene,
    tickScheduled,
    lifecycleReady,
    options,
    behaviorProfile,
    movementAvailable,
    weaponCount,
    actionableCapabilityIDs,
    entityBubble,
    playerBubble,
    sameBubble,
    roomActive,
  } = work;
  let failure = "OK";
  if (!scene) {
    failure = "SCENE_NOT_FOUND";
  } else if (!entity) {
    failure = "ENTITY_NOT_FOUND";
  } else if (!controller) {
    failure = "CONTROLLER_NOT_FOUND";
  } else if (!controllerEntityMatches) {
    failure = "CONTROLLER_ENTITY_MISMATCH";
  } else if (!controllerEntityReferenceMatches) {
    failure = "CONTROLLER_ENTITY_REFERENCE_MISMATCH";
  } else if (entityRunID !== expectedRunID) {
    failure = "ENTITY_RUN_SCOPE_MISMATCH";
  } else if (entityRoomIndex !== expectedRoomIndex) {
    failure = "ENTITY_ROOM_SCOPE_MISMATCH";
  } else if (controllerRunID !== expectedRunID) {
    failure = "CONTROLLER_RUN_SCOPE_MISMATCH";
  } else if (controllerRoomIndex > 0 && controllerRoomIndex !== expectedRoomIndex) {
    failure = "CONTROLLER_ROOM_SCOPE_MISMATCH";
  } else if (!sameScene) {
    failure = "SCENE_MISMATCH";
  } else if (!tickScheduled) {
    failure = "CONTROLLER_NOT_TICK_SCHEDULED";
  } else if (!lifecycleReady) {
    failure = options.expectPaused === true ? "CONTROLLER_NOT_PAUSED" : "CONTROLLER_NOT_ACTIVE";
  } else if (!behaviorProfile) {
    failure = "BEHAVIOR_PROFILE_UNRESOLVED";
  } else if (!movementAvailable) {
    failure = "MOVEMENT_PROFILE_UNRESOLVED";
  } else if (weaponCount <= 0 && actionableCapabilityIDs.length === 0) {
    failure = "WEAPON_SETUP_UNRESOLVED";
  } else if (entityBubble.entityBubbleID <= 0 || entityBubble.sceneBubbleID <= 0) {
    failure = "ENTITY_BUBBLE_MISSING";
  } else if (!entityBubble.bubbleRegistered) {
    failure = "BUBBLE_REGISTRY_MISMATCH";
  } else if (
    playerBubble.entityBubbleID <= 0 ||
    playerBubble.sceneBubbleID <= 0 ||
    !playerBubble.bubbleRegistered
  ) {
    failure = "PLAYER_BUBBLE_MISSING";
  } else if (!sameBubble) {
    failure = "BUBBLE_MISMATCH";
  } else if (!roomActive) {
    failure = "ROOM_NOT_ACTIVE";
  }
  Object.assign(work, { failure });
}

function buildNpcReadinessReceipt(ports, work) {
  const {
    failure,
    npcID,
    entity,
    sceneKey,
    entitySceneKey,
    controller,
    controllerSceneKey,
    expectedRunID,
    expectedRoomIndex,
    entityRunID,
    entityRoomIndex,
    controllerRunID,
    controllerRoomIndex,
    tickScheduled,
    controllerPaused,
    entityBubble,
    playerBubble,
    sameScene,
    sameBubble,
    controllerActive,
    behaviorProfile,
    weaponCount,
    actionableCapabilityIDs,
    effectiveWeaponModules,
    entityMissileWeaponSource,
    movementAvailable,
    roomActive,
  } = work;
  const ready = failure === "OK";
  return {
    npcID,
    typeID: toInt(entity && entity.typeID, 0),
    sceneKey,
    entityFound: Boolean(entity),
    entitySceneKey,
    controllerFound: Boolean(controller),
    controllerSceneKey,
    expectedRunID,
    expectedRoomIndex,
    entityRunID,
    entityRoomIndex,
    controllerRunID,
    controllerRoomIndex,
    tickScheduled,
    paused: controllerPaused,
    entityBubbleID: entityBubble.entityBubbleID,
    sceneBubbleID: entityBubble.sceneBubbleID,
    controllerBubbleID: toInt(controller && controller.bubbleID, 0),
    playerBubbleID: playerBubble.entityBubbleID,
    sameScene,
    sameBubble,
    entityRegistered: Boolean(entity),
    sceneRegistered: Boolean(entity),
    bubbleRegistered: entityBubble.bubbleRegistered,
    controllerRegistered: Boolean(controller),
    controllerTickScheduled: tickScheduled,
    controllerPaused,
    controllerActive,
    behaviorProfileID: normalizeText(controller && controller.behaviorProfileID, ""),
    behaviourProfileResolved: Boolean(behaviorProfile),
    weaponCount,
    actionableCapabilityIDs,
    effectiveWeaponModuleCount: effectiveWeaponModules.length,
    entityMissileWeaponResolved: Boolean(entityMissileWeaponSource),
    weaponProfileResolved: weaponCount > 0 || actionableCapabilityIDs.length > 0,
    movementAvailable,
    nextThinkAtMs: controller ? Number(controller.nextThinkAtMs) || 0 : 0,
    roomActive,
    ready,
    failure,
  };
}

function logAbyssalNpcReadiness(ports, readiness, options = {}) {
  const { log } = ports;
  if (readiness && readiness.ready && options.logSuccessful !== true) {
    return;
  }
  const level = readiness && readiness.ready ? "info" : "warn";
  log[level](
    `[AbyssalNpcReadiness] npc=${toInt(readiness && readiness.npcID, 0)} ` +
      `sceneKey=${normalizeText(readiness && readiness.sceneKey, "none")} ` +
      `entityFound=${Boolean(readiness && readiness.entityFound)} ` +
      `entitySceneKey=${normalizeText(readiness && readiness.entitySceneKey, "none")} ` +
      `controllerFound=${Boolean(readiness && readiness.controllerFound)} ` +
      `controllerSceneKey=${normalizeText(readiness && readiness.controllerSceneKey, "none")} ` +
      `runScope=${toInt(readiness && readiness.entityRunID, 0)}/` +
        `${toInt(readiness && readiness.controllerRunID, 0)}/` +
        `${toInt(readiness && readiness.expectedRunID, 0)} ` +
      `roomScope=${toInt(readiness && readiness.entityRoomIndex, 0)}/` +
        `${toInt(readiness && readiness.controllerRoomIndex, 0)}/` +
        `${toInt(readiness && readiness.expectedRoomIndex, 0)} ` +
      `tickScheduled=${Boolean(readiness && readiness.tickScheduled)} ` +
      `paused=${Boolean(readiness && readiness.paused)} ` +
      `entityBubbleID=${toInt(readiness && readiness.entityBubbleID, 0) || "none"} ` +
      `sceneBubbleID=${toInt(readiness && readiness.sceneBubbleID, 0) || "none"} ` +
      `controllerBubbleID=${toInt(readiness && readiness.controllerBubbleID, 0) || "none"} ` +
      `playerBubbleID=${toInt(readiness && readiness.playerBubbleID, 0) || "none"} ` +
      `sameScene=${Boolean(readiness && readiness.sameScene)} ` +
      `sameBubble=${Boolean(readiness && readiness.sameBubble)} ` +
      `ready=${Boolean(readiness && readiness.ready)} ` +
      `failure=${normalizeText(readiness && readiness.failure, "UNKNOWN")} ` +
      `attempt=${toInt(options.attempt, 1)}`,
  );

}

function logAbyssalNpcReadinessFailures(ports, readinessEntries, options = {}) {
  const { log } = ports;
  const failures = (Array.isArray(readinessEntries) ? readinessEntries : [])
    .filter((entry) => entry && entry.ready !== true);
  if (failures.length <= 0) {
    return;
  }
  const failuresByReason = {};
  for (const entry of failures) {
    const reason = normalizeText(entry.failure, "UNKNOWN");
    failuresByReason[reason] = toInt(failuresByReason[reason], 0) + 1;
  }
  const first = failures[0] || {};
  log.warn(
    `[AbyssalNpcReadiness] run=${toInt(options.runID, 0)} ` +
      `room=${toInt(options.roomIndex, 0)} attempt=${toInt(options.attempt, 1)} ` +
      `failed=${failures.length} reasons=${Object.entries(failuresByReason)
        .map(([reason, count]) => `${reason}:${count}`).join(",") || "none"} ` +
      `npcPreview=${failures.slice(0, 8).map((entry) => toInt(entry.npcID, 0)).join(",") || "none"} ` +
      `playerBubble=${toInt(first.playerBubbleID, 0)} ` +
      `npcBubblePreview=${failures.slice(0, 8).map((entry) => toInt(entry.entityBubbleID, 0)).join(",") || "none"} ` +
      `sceneKey=${normalizeText(first.sceneKey, "none")}`,
  );

}

function pauseAbyssalObjectiveControllers(ports, npcRuntime, objectiveIDs, reason) {
  for (const npcID of objectiveIDs) {
    if (npcRuntime && typeof npcRuntime.issueOrder === "function") {
      npcRuntime.issueOrder(npcID, { type: "holdFire" });
    }
    if (npcRuntime && typeof npcRuntime.pauseNpcController === "function") {
      npcRuntime.pauseNpcController(npcID, reason);
    }
  }

}

function listAbyssalNpcControllerTargetShipIDs(ports, npcRuntime, npcIDs) {
  const { listUniquePositiveInts } = ports;
  const targetShipIDs = [];
  if (!npcRuntime || typeof npcRuntime.getControllerByEntityID !== "function") {
    return targetShipIDs;
  }
  for (const npcID of listUniquePositiveInts(npcIDs)) {
    const controller = npcRuntime.getControllerByEntityID(npcID);
    if (!controller) continue;
    targetShipIDs.push(
      toInt(controller.currentTargetID, 0),
      toInt(controller.preferredTargetID, 0),
    );
  }
  return listUniquePositiveInts(targetShipIDs);

}

function reconcileAbyssalNpcControllerCombatTargets(ports, pocketState, roomIndex, scene, npcRuntime, npcIDs, options = {}) {
  const { resolveAbyssalLiveCombatParticipant, listUniquePositiveInts } = ports;
  const controllerTargetShipIDs = listAbyssalNpcControllerTargetShipIDs(ports,
    npcRuntime,
    npcIDs,
  );
  let primarySelection = resolveAbyssalLiveCombatParticipant(
    pocketState,
    scene,
    {
      roomIndex,
      preferredShipIDs: [
        ...controllerTargetShipIDs,
        ...listUniquePositiveInts(options.preferredShipIDs),
      ],
      preferredCharacterID: options.preferredCharacterID,
    },
  );
  if (!primarySelection.success) {
    return {
      success: false,
      errorMsg: primarySelection.reason,
      targetAvailable: false,
      selection: primarySelection,
      reboundNpcIDs: [],
      failedNpcIDs: [],
    };
  }
  if (!npcRuntime || typeof npcRuntime.getControllerByEntityID !== "function") {
    return {
      success: true,
      targetAvailable: true,
      selection: primarySelection,
      reboundNpcIDs: [],
      failedNpcIDs: [],
    };
  }
  const reboundNpcIDs = [];
  const failedNpcIDs = [];
  const work = { pocketState, roomIndex, scene, npcRuntime, npcIDs, options, primarySelection, reboundNpcIDs, failedNpcIDs };
  work.handoffCoordinator = buildTargetHandoffCoordinator(ports, work);
  for (const npcID of ports.listUniquePositiveInts(npcIDs)) reconcileNpcCombatTarget(ports, { ...work, npcID, selectionOwner: work });
  return {
    success: failedNpcIDs.length === 0,
    errorMsg: failedNpcIDs.length > 0
      ? "ABYSSAL_NPC_CONTROLLER_TARGET_BINDING_FAILED"
      : "",
    targetAvailable: true,
    selection: work.primarySelection,
    reboundNpcIDs,
    failedNpcIDs,
  };
}

function buildTargetHandoffCoordinator(ports, work) {
  const {
    getActivePocketStateByInstanceID,
    buildAbyssalSurvivorControllerSelectionRequest,
  } = ports;
  const {
    pocketState,
    roomIndex,
    scene,
    npcRuntime,
  } = work;
  return createAbyssalSurvivorControllerHandoffCoordinator({
      revalidateControllerSelection(revalidationRequest) {
        const currentPocketState = getActivePocketStateByInstanceID(
          toInt(revalidationRequest && revalidationRequest.instanceID, 0),
        ) || pocketState;
        return selectAbyssalSurvivorController(
          buildAbyssalSurvivorControllerSelectionRequest(
            currentPocketState,
            scene,
            {
              roomIndex,
              preferredShipIDs: [
                revalidationRequest && revalidationRequest.requestedShipID,
                work.primarySelection.shipID,
              ],
            },
          ),
        );
      },
      applyControllerHandoff(handoffRequest) {
        if (typeof npcRuntime.issueAttackOrder !== "function") {
          return {
            success: false,
            errorMsg: "ABYSSAL_NPC_CONTROLLER_ATTACK_ORDER_UNAVAILABLE",
          };
        }
        // A pilot who lost the hull flies on in the capsule, and Abyssal NPCs
        // shoot capsules: an order without the pod rule leaves them idle on it.
        return npcRuntime.issueAttackOrder(
          handoffRequest.controllerID,
          handoffRequest.successorShipID,
          { keepLock: handoffRequest.keepLock, allowPodKill: true },
        );
      },
    });
}

function reconcileNpcCombatTarget(ports, work) {
  const {
    log,
    buildAbyssalSurvivorControllerSelectionRequest,
    cloneValue,
  } = ports;
  const {
    npcID,
    npcRuntime,
    handoffCoordinator,
    pocketState,
    scene,
    roomIndex,
    reboundNpcIDs,
    failedNpcIDs,
    selectionOwner,
  } = work;
  const controller = npcRuntime.getControllerByEntityID(npcID);
    if (!controller) return;
    const oldCurrentTargetID = toInt(controller.currentTargetID, 0);
    const oldPreferredTargetID = toInt(controller.preferredTargetID, 0);
    const controllerPaused = Boolean(
      controller.controllerPaused === true ||
      controller.controllerLifecycleState === "materialized_paused",
    );
    const handoffResult = handoffCoordinator.handoffSurvivorController({
      ...buildAbyssalSurvivorControllerSelectionRequest(
        pocketState,
        scene,
        {
          roomIndex,
          preferredShipIDs: [
            oldCurrentTargetID,
            oldPreferredTargetID,
            selectionOwner.primarySelection.shipID,
          ],
        },
      ),
      controllerID: npcID,
      currentControllerShipID: oldCurrentTargetID,
      preferredControllerShipID: oldPreferredTargetID,
      controllerPaused,
      keepLock: true,
    });
    if (!handoffResult.liveControllerAvailable) {
      failedNpcIDs.push(npcID);
      return;
    }
    if (
      handoffResult.status ===
      ABYSSAL_SURVIVOR_CONTROLLER_HANDOFF_STATUS.HANDOFF_FAILED ||
      handoffResult.status ===
      ABYSSAL_SURVIVOR_CONTROLLER_HANDOFF_STATUS.INVALID_IDENTITY
    ) {
      failedNpcIDs.push(npcID);
      return;
    }
    if (handoffResult.handoffPerformed === true) {
      reboundNpcIDs.push(npcID);
      selectionOwner.primarySelection = {
        success: true,
        reason: "OK",
        roomIndex: handoffResult.roomIndex,
        participant: cloneValue(handoffResult.participant),
        characterID: handoffResult.characterID,
        shipID: handoffResult.shipID,
        shipEntity: handoffResult.controllerRef,
        candidateCharacterIDs: [...handoffResult.candidateCharacterIDs],
        candidateShipIDs: [...handoffResult.candidateShipIDs],
      };
      log.info(
        `[AbyssalNpcTarget] run=${toInt(handoffResult.instanceID, 0)} ` +
          `room=${roomIndex} npc=${npcID} ` +
          `oldCurrentShip=${oldCurrentTargetID || "none"} ` +
          `oldPreferredShip=${oldPreferredTargetID || "none"} ` +
          `newShip=${handoffResult.shipID} ` +
          `character=${handoffResult.characterID} reason=previous-participant-unusable`,
      );
    }
}

// Preserve the authoritative live-hostile roster, bounded bubble retry, and hold-fire failure path.
function activateAbyssalRoomNpcControllers(ports, pocketState, session, deps = ports.getDependencies(), options = {}) {
  const work = { pocketState, session, deps, options };
  for (const activate of [
    prepareControllerActivation,
    inspectControllerActivationReadiness,
    rejectUnreadyControllerActivation,
    executeControllerActivation,
    inspectActivatedControllers,
    rejectFailedControllerActivation,
  ]) {
    const result = activate(ports, work);
    if (result) return result;
  }
  return finishControllerActivation(ports, work);
}

function prepareControllerActivation(ports, work) {
  const {
    resolveEntityBubbleForScene,
    buildPlaceholderRoomState,
    log,
    resolveAbyssalLiveCombatParticipant,
    getPocketScene,
    getPlaceholderRoomEntry,
    listActiveAbyssalRoomNpcIDs,
    getCharacterID,
    getAbyssalParticipantRecord,
  } = ports;
  const {
    pocketState,
    session,
    deps,
    options,
  } = work;
  const activationPerfEnabled = deps && deps.abyssalTransitionPerfDiagnosticsEnabled === true;
  const npcRuntime = deps;
  const scene = getPocketScene(pocketState, deps);
  const roomState = buildPlaceholderRoomState(pocketState);
  const roomIndex = toInt(options.roomIndex, roomState.currentRoomIndex);
  const roomEntry = getPlaceholderRoomEntry(pocketState, roomIndex);
  const objectiveIDs = listActiveAbyssalRoomNpcIDs(roomEntry);
  const sessionCharacterID = getCharacterID(session);
  const sessionParticipant = getAbyssalParticipantRecord(
    pocketState,
    sessionCharacterID,
  );
  const participantSelection = resolveAbyssalLiveCombatParticipant(
    pocketState,
    scene,
    {
      roomIndex,
      preferredShipIDs: [
        ...listAbyssalNpcControllerTargetShipIDs(ports, npcRuntime, objectiveIDs),
        toInt(sessionParticipant && sessionParticipant.shipID, 0),
      ],
      preferredCharacterID: sessionCharacterID,
    },
  );
  const shipID = participantSelection.shipID;
  let playerBubble = resolveEntityBubbleForScene(scene, shipID);
  const playerShip = participantSelection.shipEntity || playerBubble.entity;
  const sceneKey = normalizeText(scene && scene.sceneKey, "");
  const roomActive = roomIndex === roomState.currentRoomIndex && (
    options.roomActive === true || toInt(roomEntry && roomEntry.enteredAtMs, 0) > 0
  );
  if (
    roomActive &&
    playerShip &&
    scene &&
    typeof scene.reboxBall === "function"
  ) {
    scene.reboxBall(playerShip);
    playerBubble = resolveEntityBubbleForScene(scene, shipID);
  }
  const playerBubbleID = playerBubble.entityBubbleID;
  const nowMs = scene && typeof scene.getCurrentSimTimeMs === "function"
    ? scene.getCurrentSimTimeMs()
    : toInt(deps.now && deps.now(), Date.now());
  const supportsControllerActivation = Boolean(
    npcRuntime &&
      typeof npcRuntime.getControllerByEntityID === "function" &&
      typeof npcRuntime.activateNpcController === "function",
  );
  if (!supportsControllerActivation) {
    if (npcRuntime && typeof npcRuntime.issueAttackOrder === "function") {
      for (const npcID of objectiveIDs) {
        npcRuntime.issueAttackOrder(npcID, shipID, {
          keepLock: true,
          allowPodKill: true,
        });
      }
    }
    log.warn(
      `[AbyssalNpcActivation] run=${toInt(pocketState && pocketState.instanceID, 0)} ` +
        `room=${roomIndex} planned=${objectiveIDs.length} controllersRegistered=unknown ` +
        `controllersActivated=0 failed=0 playerBubble=${playerBubbleID} ` +
        `npcBubble=unknown sceneKey=${sceneKey || "none"} ` +
        `reason=controller_api_unavailable compatibility=true`,
    );
    return {
      success: true,
      data: {
        readiness: [],
        activated: 0,
        compatibility: true,
      },
    };
  }
  Object.assign(work, { activationPerfEnabled, npcRuntime, scene, roomIndex, roomEntry, objectiveIDs, shipID, playerShip, sceneKey, roomActive, playerBubbleID, nowMs });
}

function inspectControllerActivationReadiness(ports, work) {
  const {
    resolveEntityBubbleForScene,
    updateAbyssalRoomNpcActivationState,
  } = ports;
  const {
    pocketState,
    roomIndex,
    roomEntry,
    nowMs,
    options,
    objectiveIDs,
    scene,
    npcRuntime,
    playerShip,
    roomActive,
    shipID,
    activationPerfEnabled,
  } = work;
  const previousAttemptCount = toInt(roomEntry && roomEntry.npcControllerActivationAttemptCount, 0);
  let activationState = updateAbyssalRoomNpcActivationState(pocketState, roomIndex, {
    npcControllerActivationState: "activating",
    npcControllerActivationAttemptCount: previousAttemptCount + 1,
    npcControllerActivationAttemptedAtMs: nowMs,
    ...(options.watchdogRetry === true
      ? {
          npcControllerWatchdogRetryAttempted: true,
          npcControllerWatchdogRetryAttemptedAtMs: nowMs,
        }
      : {}),
  });
  const buildReadiness = () => objectiveIDs.map((npcID) => (
    buildAbyssalNpcControllerReadiness(ports, activationState, npcID, scene, npcRuntime, {
      expectPaused: true,
      allowAlreadyActive: options.allowAlreadyActive === true,
      playerEntity: playerShip,
      roomIndex,
      roomActive,
    })
  ));
  let readinessPasses = 1;
  let readinessRetries = 0;
  const initialReadinessStartedAtNs = process.hrtime.bigint();
  let readiness = buildReadiness();
  if (readiness.some((entry) => !entry.ready) && scene && typeof scene.reboxBall === "function") {
    const failedEntityIDs = readiness
      .filter((entry) => !entry.ready)
      .map((entry) => entry.npcID);
    for (const entityID of new Set([shipID, ...failedEntityIDs])) {
      const entity = resolveEntityBubbleForScene(scene, entityID).entity;
      if (entity) {
        scene.reboxBall(entity);
      }
    }
    readinessPasses += 1;
    readinessRetries += 1;
    readiness = buildReadiness();
  }
  const initialReadinessDurationMs = activationPerfEnabled
    ? Number(process.hrtime.bigint() - initialReadinessStartedAtNs) / 1_000_000
    : 0;
  logAbyssalNpcReadinessFailures(ports, readiness, {
    runID: toInt(pocketState && pocketState.instanceID, 0),
    roomIndex,
    attempt: previousAttemptCount + 1,
  });
  let failedReadiness = readiness.filter((entry) => !entry.ready);
  Object.assign(work, { previousAttemptCount, activationState, readinessPasses, readinessRetries, readiness, initialReadinessDurationMs, failedReadiness });
}

function rejectUnreadyControllerActivation(ports, work) {
  const {
    degradeAbyssalRoomNpcActivation,
  } = ports;
  const {
    failedReadiness,
    options,
    readiness,
    readinessPasses,
    readinessRetries,
    initialReadinessDurationMs,
    activationState,
    session,
    deps,
    roomIndex,
    objectiveIDs,
    nowMs,
  } = work;
  if (failedReadiness.length > 0) {
    if (options.degradeOnFailure === false) {
      return {
        success: false,
        errorMsg: "ABYSSAL_NPC_CONTROLLER_NOT_READY",
        data: {
          readiness,
          readinessPasses,
          readinessRetries,
          readinessDurationMs: initialReadinessDurationMs,
          controllerActivationDurationMs: 0,
        },
      };
    }
    const degradedState = degradeAbyssalRoomNpcActivation(activationState, session, deps, {
      roomIndex,
      objectiveIDs,
      readiness,
      nowMs,
      reason: "ABYSSAL_NPC_CONTROLLER_NOT_READY",
    });
    return {
      success: true,
      data: {
        readiness,
        readinessPasses,
        readinessRetries,
        readinessDurationMs: initialReadinessDurationMs,
        controllerActivationDurationMs: 0,
        activated: 0,
        degraded: true,
        pocketState: degradedState,
      },
    };
  }
}

function executeControllerActivation(ports, work) {
  const {
    readiness,
    activationState,
    roomIndex,
    scene,
    npcRuntime,
    shipID,
    nowMs,
    objectiveIDs,
    activationPerfEnabled,
  } = work;
  let activated = 0;
  const failedActivations = [];
  const controllerActivationStartedAtNs = process.hrtime.bigint();
  for (const readinessEntry of readiness) {
    const npcID = readinessEntry.npcID;
    if (readinessEntry.controllerActive) {
      const targetResult = reconcileAbyssalNpcControllerCombatTargets(ports,
        activationState,
        roomIndex,
        scene,
        npcRuntime,
        [npcID],
        { preferredShipIDs: [shipID] },
      );
      if (!targetResult.success) {
        failedActivations.push({
          npcID,
          reason: targetResult.errorMsg || "ATTACK_ORDER_FAILED",
        });
        continue;
      }
      activated += 1;
      continue;
    }
    const activateResult =
      npcRuntime && typeof npcRuntime.activateNpcController === "function"
        ? npcRuntime.activateNpcController(npcID, nowMs)
        : null;
    if (!activateResult || activateResult.success === false) {
      failedActivations.push({
        npcID,
        reason: activateResult && activateResult.errorMsg || "ACTIVATION_UNSUPPORTED",
      });
      continue;
    }
    const attackResult = npcRuntime && typeof npcRuntime.issueAttackOrder === "function"
      ? npcRuntime.issueAttackOrder(npcID, shipID, {
        keepLock: true,
        allowPodKill: true,
      })
      : { success: false, errorMsg: "ATTACK_ORDER_UNSUPPORTED" };
    if (!attackResult || attackResult.success === false) {
      failedActivations.push({
        npcID,
        reason: attackResult && attackResult.errorMsg || "ATTACK_ORDER_FAILED",
      });
      continue;
    }
    activated += 1;
  }
  if (failedActivations.length === 0 && typeof npcRuntime.tickNpcControllersInScene === "function") {
    npcRuntime.tickNpcControllersInScene(scene, objectiveIDs, nowMs);
  }
  const controllerActivationDurationMs = activationPerfEnabled
    ? Number(process.hrtime.bigint() - controllerActivationStartedAtNs) / 1_000_000
    : 0;
  Object.assign(work, { activated, failedActivations, controllerActivationDurationMs });
}

function inspectActivatedControllers(ports, work) {
  const {
    objectiveIDs,
    activationState,
    scene,
    npcRuntime,
    playerShip,
    roomIndex,
    roomActive,
    activationPerfEnabled,
    initialReadinessDurationMs,
    pocketState,
    previousAttemptCount,
  } = work;
  const activeReadinessStartedAtNs = process.hrtime.bigint();
  const activeReadiness = objectiveIDs.map((npcID) => (
    buildAbyssalNpcControllerReadiness(ports, activationState, npcID, scene, npcRuntime, {
      playerEntity: playerShip,
      roomIndex,
      roomActive,
    })
  ));
  const activeReadinessDurationMs = activationPerfEnabled
    ? Number(process.hrtime.bigint() - activeReadinessStartedAtNs) / 1_000_000
    : 0;
  const readinessDurationMs = initialReadinessDurationMs + activeReadinessDurationMs;
  logAbyssalNpcReadinessFailures(ports, activeReadiness, {
    runID: toInt(pocketState && pocketState.instanceID, 0),
    roomIndex,
    attempt: previousAttemptCount + 1,
  });
  const failedReadiness = activeReadiness.filter((entry) => !entry.ready);
  Object.assign(work, { activeReadiness, readinessDurationMs, failedReadiness });
}

function rejectFailedControllerActivation(ports, work) {
  const {
    degradeAbyssalRoomNpcActivation,
  } = ports;
  const {
    failedActivations,
    failedReadiness,
    activeReadiness,
    npcRuntime,
    objectiveIDs,
    options,
    readinessPasses,
    readinessRetries,
    readinessDurationMs,
    controllerActivationDurationMs,
    activated,
    activationState,
    session,
    deps,
    roomIndex,
    nowMs,
  } = work;
  if (failedActivations.length > 0 || failedReadiness.length > 0) {
    const activationFailureByNpcID = new Map(
      failedActivations.map((failure) => [failure.npcID, failure]),
    );
    const combinedReadiness = activeReadiness.map((entry) => {
      const activationFailure = activationFailureByNpcID.get(entry.npcID);
      return activationFailure
        ? { ...entry, ready: false, failure: activationFailure.reason }
        : entry;
    });
    pauseAbyssalObjectiveControllers(ports,
      npcRuntime,
      objectiveIDs,
      "abyssal_room_activation_failed",
    );
    if (options.degradeOnFailure === false) {
      return {
        success: false,
        errorMsg: "ABYSSAL_NPC_ACTIVATION_FAILED",
        data: {
          readiness: combinedReadiness,
          readinessPasses,
          readinessRetries,
          readinessDurationMs,
          controllerActivationDurationMs,
          activated,
          failedActivations,
        },
      };
    }
    const degradedState = degradeAbyssalRoomNpcActivation(activationState, session, deps, {
      roomIndex,
      objectiveIDs,
      readiness: combinedReadiness,
      nowMs,
      reason: "ABYSSAL_NPC_ACTIVATION_FAILED",
    });
    return {
      success: true,
      data: {
        readiness: combinedReadiness,
        readinessPasses,
        readinessRetries,
        readinessDurationMs,
        controllerActivationDurationMs,
        activated,
        failedActivations,
        degraded: true,
        pocketState: degradedState,
      },
    };
  }
}

function finishControllerActivation(ports, work) {
  const {
    log,
    updateAbyssalRoomNpcActivationState,
    logAbyssalRoomContentActivated,
  } = ports;
  const {
    roomIndex,
    nowMs,
    activeReadiness,
    pocketState,
    objectiveIDs,
    activated,
    failedActivations,
    playerBubbleID,
    sceneKey,
    readinessPasses,
    readinessRetries,
    readinessDurationMs,
    controllerActivationDurationMs,
  } = work;
  let {
    activationState,
  } = work;
  activationState = updateAbyssalRoomNpcActivationState(activationState, roomIndex, {
    npcControllerActivationState: "active",
    npcControllerActivatedAtMs: nowMs,
    npcControllerActivationFailedNpcIDs: [],
    npcControllerActivationFailures: [],
  });
  const npcBubbleIDs = [
    ...new Set(activeReadiness.map((entry) => entry.entityBubbleID).filter((bubbleID) => bubbleID > 0)),
  ];
  log.info(
    `[AbyssalNpcActivation] run=${toInt(pocketState && pocketState.instanceID, 0)} ` +
      `room=${roomIndex} planned=${objectiveIDs.length} ` +
      `controllersRegistered=${activeReadiness.filter((entry) => entry.controllerRegistered).length} ` +
      `controllersActivated=${activated} failed=${failedActivations.length} ` +
      `playerBubble=${playerBubbleID} ` +
      `npcBubble=${npcBubbleIDs.join(",") || "none"} ` +
      `sceneKey=${sceneKey || "none"} reason=OK`,
  );
  logAbyssalRoomContentActivated(activationState, { roomIndex });
  return {
    success: true,
    errorMsg: null,
    data: {
      readiness: activeReadiness,
      readinessPasses,
      readinessRetries,
      readinessDurationMs,
      controllerActivationDurationMs,
      activated,
      failedActivations,
      pocketState: activationState,
    },
  };
}

function createAbyssalNpcControllers(ports) {
  return {
    buildAbyssalNpcControllerReadiness: buildAbyssalNpcControllerReadiness.bind(null, ports),
    logAbyssalNpcReadiness: logAbyssalNpcReadiness.bind(null, ports),
    logAbyssalNpcReadinessFailures: logAbyssalNpcReadinessFailures.bind(null, ports),
    pauseAbyssalObjectiveControllers: pauseAbyssalObjectiveControllers.bind(null, ports),
    listAbyssalNpcControllerTargetShipIDs: listAbyssalNpcControllerTargetShipIDs.bind(null, ports),
    reconcileAbyssalNpcControllerCombatTargets: reconcileAbyssalNpcControllerCombatTargets.bind(null, ports),
    activateAbyssalRoomNpcControllers: activateAbyssalRoomNpcControllers.bind(null, ports),
  };
}

module.exports = { createAbyssalNpcControllers };
