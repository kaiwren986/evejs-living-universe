"use strict";

const { normalizeText } = require("../domain/abyssalValueUtils");

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

// Materialize only the exact resolved encounter supplied by the content authority.
// Runtime, scene, weather and persistence ownership stay with injected ports.
function rollbackAbyssalEncounterSpawnEntries({
  listUniquePositiveInts,
  log,
}, entries, deps, reason) {
  const entityIDs = listUniquePositiveInts(
    (Array.isArray(entries) ? entries : []).map((entry) =>
      entry && entry.entity ? entry.entity.itemID : entry && entry.itemID
    ),
  );
  const npcService = deps;
  const failedEntityIDs = [];
  for (const entityID of entityIDs) {
    const destroyResult =
      npcService && typeof npcService.destroyNpcControllerByEntityID === "function"
        ? npcService.destroyNpcControllerByEntityID(entityID, {
            removeContents: true,
            suppressWreck: true,
            reason: normalizeText(reason, "abyssal-encounter-spawn-rollback"),
          })
        : { success: false, errorMsg: "NPC_DESTROY_UNSUPPORTED" };
    if (!destroyResult || destroyResult.success !== true) {
      failedEntityIDs.push(entityID);
    }
  }
  if (entityIDs.length > 0) {
    log.warn(
      `[AbyssalEncounterSpawnRollback] attempted=${entityIDs.length} ` +
        `failed=${failedEntityIDs.length} ids=${entityIDs.join(",")} ` +
        `reason=${normalizeText(reason, "abyssal-encounter-spawn-rollback")}`,
    );
  }
  return {
    success: failedEntityIDs.length === 0,
    entityIDs,
    failedEntityIDs,
  };
}

function rollbackSpawnedAbyssalNpcEntries({}, npcRuntime, spawnedEntries, reason) {
  if (!npcRuntime || typeof npcRuntime.despawn !== "function") {
    return [];
  }
  return (Array.isArray(spawnedEntries) ? spawnedEntries : [])
    .map((entry) => toInt(entry && entry.entity && entry.entity.itemID, 0))
    .filter((itemID) => itemID > 0)
    .map((itemID) => ({
      itemID,
      result: npcRuntime.despawn(itemID, {
        reason: normalizeText(reason, "abyssal_spawn_rollback"),
      }),
    }));
}

function materializeControllerDependantLifecycle({
  listUniquePositiveInts,
}, npcProfile, spawnedEntries) {
  const authoredGroups =
    npcProfile &&
      npcProfile.authoredObjective &&
      Array.isArray(npcProfile.authoredObjective.controllerGroups)
      ? npcProfile.authoredObjective.controllerGroups
      : [];
  if (authoredGroups.length <= 0) {
    return {
      success: true,
      data: {
        controllerDependantLifecycleGroups: [],
        dependantInactiveNpcItemIDs: [],
        destroyedDependantNpcItemIDs: [],
      },
    };
  }

  const runtimeEntriesByAuthoredID = new Map();
  for (const entry of Array.isArray(spawnedEntries) ? spawnedEntries : []) {
    const authoredID = normalizeText(
      entry && entry.npcEntry && entry.npcEntry.npcEntryID,
      "",
    );
    const itemID = toInt(entry && entry.entity && entry.entity.itemID, 0);
    if (!authoredID || itemID <= 0) {
      continue;
    }
    const existing = runtimeEntriesByAuthoredID.get(authoredID) || [];
    existing.push(entry);
    runtimeEntriesByAuthoredID.set(authoredID, existing);
  }

  const unresolvedReferences = [];
  const resolveUniqueRuntimeEntry = (authoredID, field) => {
    const normalizedAuthoredID = normalizeText(authoredID, "");
    const matches = runtimeEntriesByAuthoredID.get(normalizedAuthoredID) || [];
    if (matches.length !== 1) {
      unresolvedReferences.push({
        field,
        authoredEntityID: normalizedAuthoredID,
        matchCount: matches.length,
      });
      return null;
    }
    return matches[0];
  };

  const lifecycleGroups = authoredGroups.map((group, groupIndex) => {
    const relationshipID = normalizeText(
      group && group.relationshipID,
      `controller-group-${groupIndex + 1}`,
    );
    const controllerEntry = resolveUniqueRuntimeEntry(
      group && group.controllerEntityID,
      `${relationshipID}.controllerEntityID`,
    );
    const dependantEntries = (
      Array.isArray(group && group.dependantEntityIDs)
        ? group.dependantEntityIDs
        : []
    ).map((dependantEntityID, dependantIndex) => resolveUniqueRuntimeEntry(
      dependantEntityID,
      `${relationshipID}.dependantEntityIDs[${dependantIndex}]`,
    ));
    return {
      relationshipID,
      controllerAuthoredEntityID: normalizeText(group && group.controllerEntityID, ""),
      controllerNpcItemID: toInt(
        controllerEntry && controllerEntry.entity && controllerEntry.entity.itemID,
        0,
      ),
      dependantAuthoredEntityIDs: (
        Array.isArray(group && group.dependantEntityIDs)
          ? group.dependantEntityIDs
          : []
      ).map((entry) => normalizeText(entry, "")).filter(Boolean),
      dependantNpcItemIDs: listUniquePositiveInts(
        dependantEntries.map((entry) => entry && entry.entity && entry.entity.itemID),
      ),
      lossBehavior: normalizeText(group && group.lossBehavior, ""),
      autoRemoveDependants: group && group.autoRemoveDependants === true,
      provenance: normalizeText(group && group.provenance, ""),
      controllerActive: true,
      controllerDestroyedAtMs: 0,
    };
  });

  if (unresolvedReferences.length > 0) {
    return {
      success: false,
      errorMsg: "ABYSSAL_CONTROLLER_DEPENDANT_LINK_UNRESOLVED",
      data: {
        unresolvedReferences,
      },
    };
  }

  for (const entry of Array.isArray(spawnedEntries) ? spawnedEntries : []) {
    const itemID = toInt(entry && entry.entity && entry.entity.itemID, 0);
    const entity = entry && entry.entity;
    if (!entity || itemID <= 0) {
      continue;
    }
    const controllerRelationships = lifecycleGroups
      .filter((group) => group.controllerNpcItemID === itemID)
      .map((group) => group.relationshipID);
    const dependantRelationships = lifecycleGroups
      .filter((group) => group.dependantNpcItemIDs.includes(itemID))
      .map((group) => group.relationshipID);
    entity.evejsAbyssalControllerRelationshipIDs = controllerRelationships;
    entity.evejsAbyssalDependantRelationshipIDs = dependantRelationships;
    entity.evejsAbyssalDependantControllerItemIDs = listUniquePositiveInts(
      lifecycleGroups
        .filter((group) => group.dependantNpcItemIDs.includes(itemID))
        .map((group) => group.controllerNpcItemID),
    );
    if (dependantRelationships.length > 0) {
      entity.evejsNpcControllerLifecycleState = "dependant_active";
    }
  }

  return {
    success: true,
    data: {
      controllerDependantLifecycleGroups: lifecycleGroups,
      dependantInactiveNpcItemIDs: [],
      destroyedDependantNpcItemIDs: [],
    },
  };
}

function createAbyssalNpcMaterializationPhaseRecorder({
  log,
}, pocketState, deps) {
  const encounterPerfEnabled = deps && deps.abyssalTransitionPerfDiagnosticsEnabled === true;
  const encounterStartedAtNs = process.hrtime.bigint();
  let encounterLastPhaseAtNs = encounterStartedAtNs;
  const recordEncounterPhase = (phase, details = {}) => {
    if (!encounterPerfEnabled) return;
    const nowNs = process.hrtime.bigint();
    const detailText = Object.entries(details)
      .map(([key, value]) => `${key}=${String(value)}`)
      .join(" ");
    log.info(
      `[AbyssalTransitionPerf] run=${toInt(pocketState && pocketState.instanceID, 0)} ` +
        `flow=encounter-build room=${toInt(details.room, 0)} ` +
        `phase=${phase} phaseMs=${(Number(nowNs - encounterLastPhaseAtNs) / 1_000_000).toFixed(3)} ` +
        `totalMs=${(Number(nowNs - encounterStartedAtNs) / 1_000_000).toFixed(3)} ` +
        detailText,
    );
    encounterLastPhaseAtNs = nowNs;
  };
  return recordEncounterPhase;
}

function resolveAbyssalNpcMaterializationContext({
  usesIsolatedAbyssalScene,
  buildAbyssalSceneDescriptor,
  getContentProfile,
  buildPlaceholderRoomState,
  getPlaceholderRoomEntry,
  getPocketScene,
  resolveAbyssalLiveCombatParticipant,
  getCharacterID,
  resolveRoomNpcProfileForSpawn,
  hasPrewarmedAbyssalEncounter,
  log,
  getNpcRuntimePolicy,
}, pocketState, session, deps, recordEncounterPhase) {
  const npcRuntime = deps;
  if (!npcRuntime || typeof npcRuntime.spawnBatchInSystem !== "function") {
    return {
      success: false,
      errorMsg: "NPC_RUNTIME_UNAVAILABLE",
    };
  }
  const sceneDescriptor = usesIsolatedAbyssalScene(pocketState, deps)
    ? buildAbyssalSceneDescriptor(pocketState, deps)
    : null;
  const contentProfile = getContentProfile(pocketState);
  const roomState = buildPlaceholderRoomState(pocketState);
  const currentRoomEntry = getPlaceholderRoomEntry(pocketState, roomState.currentRoomIndex);
  const scene = getPocketScene(pocketState, deps);
  const combatParticipant = resolveAbyssalLiveCombatParticipant(
    pocketState,
    scene,
    {
      roomIndex: roomState.currentRoomIndex,
      preferredCharacterID: getCharacterID(session),
    },
  );
  const combatParticipantShipID = toInt(combatParticipant.shipID, 0);
  const npcProfile = resolveRoomNpcProfileForSpawn(pocketState, roomState.currentRoomIndex, deps, {
    prewarmed: hasPrewarmedAbyssalEncounter(currentRoomEntry),
  });
  if (npcProfile && npcProfile.errorMsg) {
    return {
      success: false,
      errorMsg: npcProfile.errorMsg,
    };
  }
  if (!npcProfile || !Array.isArray(npcProfile.npcEntries) || npcProfile.npcEntries.length <= 0) {
    return {
      success: false,
      errorMsg: "NPC_PROFILE_MISSING",
    };
  }
  recordEncounterPhase("profile-resolution", {
    room: roomState.currentRoomIndex,
    tier: toInt(contentProfile && contentProfile.tier, -1),
    weather: normalizeText(contentProfile && contentProfile.weatherType, "unknown"),
    family: normalizeText(npcProfile.sourceSpawnFamily, "unknown"),
    npcCount: toInt(npcProfile.amount, 0),
  });
  log.info(
    `[AbyssalMgr] NPC profile resolved char=${pocketState.characterID} ` +
      `instance=${pocketState.instanceID} trace=${pocketState.traceItemID} ` +
      `room=${roomState.currentRoomIndex}/${roomState.implementedRooms} ` +
      `profile=${normalizeText(npcProfile.profileQuery, "unknown")} ` +
      `runtime=${normalizeText(npcProfile.runtimeKind, "unknown")} ` +
      `amount=${toInt(npcProfile.amount, 0)} ` +
      `suppressBounty=${getNpcRuntimePolicy(contentProfile).suppressBounty === true} ` +
      `suppressWreck=${getNpcRuntimePolicy(contentProfile).suppressWreck === true} ` +
      `suppressStandings=${getNpcRuntimePolicy(contentProfile).suppressStandings === true}`,
  );
  log.info(
    `[AbyssalMgr] Abyssal encounter selected ` +
      `instance=${toInt(pocketState && pocketState.instanceID, 0)} ` +
      `tier=${toInt(contentProfile && contentProfile.tier, -1)} ` +
      `theme=${normalizeText(npcProfile.encounterTheme, normalizeText(npcProfile.factionTheme, "unknown"))} ` +
      `room=${toInt(roomState.currentRoomIndex, 0)} ` +
      `weather=${normalizeText(contentProfile && contentProfile.weatherType, "unknown")} ` +
      `profileID=${normalizeText(npcProfile.encounterProfileID, "unknown")} ` +
      `profileName="${normalizeText(npcProfile.encounterName, "unknown")}" ` +
      `npcCount=${toInt(npcProfile.amount, 0)} ` +
      `droneCount=${toInt(npcProfile.encounterDroneCount, 0)} ` +
      `shipCount=${toInt(npcProfile.encounterShipCount, 0)} ` +
      `escortTypeID=${toInt(npcProfile.encounterEscortTypeID, 0)} ` +
      `objectiveCount=${toInt(npcProfile.objectiveCount, toInt(npcProfile.amount, 0))} ` +
      `prewarmed=${hasPrewarmedAbyssalEncounter(currentRoomEntry)}`,
  );
  return {
    success: true,
    data: { pocketState, sceneDescriptor, contentProfile, roomState, currentRoomEntry, scene, combatParticipantShipID, npcProfile, roomIndex: roomState.currentRoomIndex },
  };
}

function buildAbyssalNpcMaterializationSpawnOptions({
  cloneValue,
  ABYSSAL_ROOM_ENTITY_ROLES,
  ABYSSAL_ROOM_DELIVERY_STATE,
  resolveRoomOriginPosition,
}, context, npcEntry, requestedCount, countIndex, spawnPosition, conduitState, shipDirection, options) {
  const { pocketState, sceneDescriptor, currentRoomEntry, combatParticipantShipID, roomIndex } = context;
  const capturedRetailCombat =
    npcEntry && npcEntry.capturedRetailCombat && typeof npcEntry.capturedRetailCombat === "object"
      ? npcEntry.capturedRetailCombat
      : null;
  const authoredBehaviorOverrides =
    npcEntry && npcEntry.behaviorOverrides && typeof npcEntry.behaviorOverrides === "object"
      ? npcEntry.behaviorOverrides
      : null;
  const behaviorOverrides =
    authoredBehaviorOverrides || capturedRetailCombat
      ? {
          ...(authoredBehaviorOverrides ? cloneValue(authoredBehaviorOverrides) : {}),
          ...(capturedRetailCombat
            ? {
                movementMode: normalizeText(capturedRetailCombat.movementMode, "orbit"),
                orbitDistanceMeters: Math.max(
                  0,
                  Number(capturedRetailCombat.orbitDistanceMeters) || 0,
                ),
                followRangeMeters: Math.max(
                  0,
                  Number(capturedRetailCombat.followRangeMeters) || 0,
                ),
                autoActivateWeapons: capturedRetailCombat.autoActivateWeapons !== false,
              }
            : {}),
        }
      : undefined;
  return {
    profileQuery: npcEntry.profileQuery,
    amount: 1,
    logAmount: requestedCount,
    suppressSpawnLog: countIndex > 0,
    transient: true,
    preferPools: true,
    runtimeKind: normalizeText(npcEntry && npcEntry.runtimeKind, "nativeCombat"),
    controllerPaused: Boolean(sceneDescriptor),
    controllerPausedReason: options.prewarm === true
      ? "abyssal_room_prewarm"
      : "abyssal_room_activation_pending",
    preferredTargetID: combatParticipantShipID,
    behaviorOverrides,
    sceneDescriptor: sceneDescriptor || undefined,
    broadcast: options.prewarm !== true,
    initialPublication: options.prewarm === true ? "deferred" : undefined,
    suppressInitialPublication: options.prewarm === true,
    runtimeEntityMetadata: {
      // Run and room identity is not a prewarm detail. Target locking runs
      // through canSessionSeeDungeonScopedEntity, whose Abyssal branch
      // refuses the request unless BOTH sides can prove which room they
      // occupy. A hostile spawned on the live path without a room index can
      // therefore never lock the player, and orbits it without ever firing.
      abyssalRunID: toInt(pocketState && pocketState.instanceID, 0),
      abyssalRoomIndex: roomIndex,
      abyssalEntityRole: ABYSSAL_ROOM_ENTITY_ROLES.NPC,
      // Delivery state stays prewarm-only: those values are what
      // isAbyssalRoomEntityDeliveryHidden keys on to hide an entity.
      ...(options.prewarm === true
        ? {
          abyssalRoomDeliveryState: normalizeText(
            currentRoomEntry.deliveryState,
            ABYSSAL_ROOM_DELIVERY_STATE.PREWARMED_HIDDEN,
          ),
          evejsAbyssalRoomDeliveryState: normalizeText(
            currentRoomEntry.deliveryState,
            ABYSSAL_ROOM_DELIVERY_STATE.PREWARMED_HIDDEN,
          ),
          abyssalSelectedRoomLayoutID: normalizeText(currentRoomEntry.selectedRoomLayoutID, ""),
          abyssalTransitionToken: toInt(currentRoomEntry.deliveryTransitionToken, 0),
          evejsAbyssalRoomOriginPosition: resolveRoomOriginPosition(pocketState, roomIndex),
          evejsAbyssalAuthoredLocalPosition: npcEntry && npcEntry.capturedRoomRelativePosition
            ? cloneValue(npcEntry.capturedRoomRelativePosition)
            : null,
        }
        : {}),
    },
    anchorDescriptor: {
      kind: "coordinates",
      position: conduitState.position,
      direction: shipDirection,
      name: "Abyssal Placeholder Encounter Anchor",
    },
    spawnStateOverride: {
      position: spawnPosition,
      velocity: { x: 0, y: 0, z: 0 },
      direction: shipDirection,
      targetPoint: spawnPosition,
      mode: "STOP",
      speedFraction: 0,
    },
  };
}

function materializeAbyssalNpcEntries({
  buildRoomConduitState,
  normalizeDirection,
  buildAbyssalNpcSpawnPosition,
  cloneValue,
  buildAbyssalNpcMaterializationSpawnOptions,
  rollbackAbyssalEncounterSpawnEntries,
}, context, deps, options) {
  const { pocketState, npcProfile, roomIndex } = context;
  const npcRuntime = deps;
  const conduitState = buildRoomConduitState(pocketState, roomIndex);
  const shipDirection = normalizeDirection(conduitState.direction, { x: 1, y: 0, z: 0 });
  const spawnedEntries = [];
  const spawnedEntityIDs = new Set();
  const spawnProfileIDs = [];
  const spawnPositions = [];
  let primarySpawnPosition = null;
  let spawnOrdinal = 0;
  for (const npcEntry of npcProfile.npcEntries) {
    const requestedCount = Math.max(1, toInt(npcEntry && npcEntry.count, 1));
    for (let countIndex = 0; countIndex < requestedCount; countIndex += 1) {
      const spawnPosition = buildAbyssalNpcSpawnPosition({
        pocketState,
        roomIndex,
        npcProfile,
        npcEntry,
        spawnOrdinal,
        existingPositions: spawnPositions,
        deps,
      });
      spawnOrdinal += 1;
      spawnPositions.push(spawnPosition);
      if (!primarySpawnPosition) {
        primarySpawnPosition = cloneValue(spawnPosition);
      }
      const spawnResult = npcRuntime.spawnBatchInSystem(
        pocketState.solarSystemID,
        buildAbyssalNpcMaterializationSpawnOptions(
          context, npcEntry, requestedCount, countIndex, spawnPosition, conduitState, shipDirection, options,
        ),
      );
      const validSpawnedEntries =
        spawnResult &&
        spawnResult.data &&
        Array.isArray(spawnResult.data.spawned)
          ? spawnResult.data.spawned.filter((entry) => entry && entry.entity)
          : [];
      if (!(spawnResult && spawnResult.success) || validSpawnedEntries.length !== 1) {
        const rollbackResult = rollbackAbyssalEncounterSpawnEntries(
          [...spawnedEntries, ...validSpawnedEntries],
          deps,
          "abyssal-encounter-spawn-cardinality-mismatch",
        );
        return {
          success: false,
          errorMsg:
            spawnResult && spawnResult.success
              ? "ABYSSAL_ENCOUNTER_SPAWN_CARDINALITY_MISMATCH"
              : spawnResult && spawnResult.errorMsg || "PLACEHOLDER_ENCOUNTER_SPAWN_FAILED",
          suggestions: spawnResult && spawnResult.suggestions || [],
          rollbackResult,
        };
      }
      const spawnedEntityID = toInt(validSpawnedEntries[0].entity.itemID, 0);
      if (
        spawnedEntityID <= 0 ||
        spawnedEntityIDs.has(spawnedEntityID)
      ) {
        const rollbackResult = rollbackAbyssalEncounterSpawnEntries(
          [...spawnedEntries, ...validSpawnedEntries],
          deps,
          "abyssal-encounter-spawn-identity-mismatch",
        );
        return {
          success: false,
          errorMsg: "ABYSSAL_ENCOUNTER_SPAWN_IDENTITY_MISMATCH",
          suggestions: [],
          rollbackResult,
        };
      }
      spawnedEntityIDs.add(spawnedEntityID);
      spawnProfileIDs.push(normalizeText(npcEntry && npcEntry.profileQuery, ""));
      spawnedEntries.push(...validSpawnedEntries.map((entry) => ({
        npcEntry: {
          ...cloneValue(npcEntry),
          encounterProfileID: normalizeText(npcProfile.encounterProfileID, ""),
        },
        entity: entry.entity,
      })));
    }
  }
  return { success: true, data: { spawnedEntries, spawnOrdinal, spawnProfileIDs, primarySpawnPosition } };
}

function validateAbyssalNpcMaterializationRoster({
  rollbackAbyssalEncounterSpawnEntries,
  materializeControllerDependantLifecycle,
  cloneValue,
}, npcProfile, spawnedEntries, spawnOrdinal, deps) {
  const hostileEntityIDs = spawnedEntries
    .map((entry) => toInt(entry && entry.entity && entry.entity.itemID, 0))
    .filter((value) => value > 0);
  const objectiveRelevantNpcItemIDs = spawnedEntries
    .filter((entry) => entry && entry.npcEntry && entry.npcEntry.objectiveRelevant !== false)
    .map((entry) => toInt(entry && entry.entity && entry.entity.itemID, 0))
    .filter((value) => value > 0);
  if (hostileEntityIDs.length <= 0 || hostileEntityIDs.length !== spawnOrdinal) {
    const rollbackResult = rollbackAbyssalEncounterSpawnEntries(
      spawnedEntries,
      deps,
      "abyssal-encounter-spawn-roster-mismatch",
    );
    return {
      success: false,
      errorMsg: hostileEntityIDs.length <= 0
        ? "PLACEHOLDER_ENCOUNTER_SPAWN_FAILED"
        : "ABYSSAL_ENCOUNTER_SPAWN_ROSTER_MISMATCH",
      suggestions: [],
      rollbackResult,
    };
  }
  if (objectiveRelevantNpcItemIDs.length <= 0) {
    const rollbackResult = rollbackAbyssalEncounterSpawnEntries(
      spawnedEntries,
      deps,
      "abyssal-encounter-zero-objective-hostiles",
    );
    return {
      success: false,
      errorMsg: "ABYSSAL_ENCOUNTER_ZERO_OBJECTIVE_HOSTILES",
      suggestions: [],
      rollbackResult,
    };
  }
  const lifecycleResult = materializeControllerDependantLifecycle(
    npcProfile,
    spawnedEntries,
  );
  if (!lifecycleResult.success) {
    const rollbackResult = rollbackAbyssalEncounterSpawnEntries(
      spawnedEntries,
      deps,
      "abyssal-controller-dependant-link-rollback",
    );
    return {
      success: false,
      errorMsg: lifecycleResult.errorMsg,
      suggestions: [],
      data: cloneValue(lifecycleResult.data),
      rollbackResult,
    };
  }
  return { success: true, data: { hostileEntityIDs, objectiveRelevantNpcItemIDs, lifecycleResult } };
}

function validateAbyssalNpcMaterializationScene({
  collectAbyssalNpcSceneRegistrationDiagnostics,
  rollbackAbyssalEncounterSpawnEntries,
  log,
  formatAbyssalNpcSceneRegistrationDiagnostics,
}, context, spawnedEntries, roster, deps) {
  const { pocketState, sceneDescriptor, scene, roomIndex } = context;
  const { hostileEntityIDs, objectiveRelevantNpcItemIDs } = roster;
  let registeredControllerCount = 0;
  if (sceneDescriptor) {
    const registrationDiagnostics = collectAbyssalNpcSceneRegistrationDiagnostics(
      scene,
      sceneDescriptor,
      hostileEntityIDs,
      deps,
    );
    if (!registrationDiagnostics.success) {
      const rollbackResult = rollbackAbyssalEncounterSpawnEntries(
        spawnedEntries,
        deps,
        "abyssal-encounter-scene-ownership-mismatch",
      );
      log.warn(
        `[AbyssalScene] NPC scene ownership validation failed ` +
          `instance=${toInt(pocketState && pocketState.instanceID, 0)} ` +
          `sceneKey=${normalizeText(sceneDescriptor.sceneKey, "n/a")} ` +
          formatAbyssalNpcSceneRegistrationDiagnostics(registrationDiagnostics.diagnostics),
      );
      return {
        success: false,
        errorMsg: "ABYSSAL_NPC_SCENE_OWNERSHIP_MISMATCH",
        suggestions: [],
        rollbackResult,
      };
    }
    log.info(
      `[AbyssalScene] NPCs materialized in run scene ` +
        `instance=${toInt(pocketState && pocketState.instanceID, 0)} ` +
        `sceneKey=${normalizeText(sceneDescriptor.sceneKey, "n/a")} ` +
        `hostiles=${hostileEntityIDs.length} objectives=${objectiveRelevantNpcItemIDs.length}`,
    );
    registeredControllerCount = Math.max(
      0,
      hostileEntityIDs.length - registrationDiagnostics.diagnostics.controllerMissing.length,
    );
    log.info(
      `[NpcControllerBatch] run=${toInt(pocketState && pocketState.instanceID, 0)} ` +
        `room=${roomIndex} planned=${hostileEntityIDs.length} ` +
        `registered=${registeredControllerCount} ` +
        `tickScheduled=${hostileEntityIDs.length - registrationDiagnostics.diagnostics.controllerTickMissing.length} ` +
        `paused=${hostileEntityIDs.length - registrationDiagnostics.diagnostics.controllerNotPaused.length} ` +
        `destinationReadinessDeferred=true`,
    );
  }
  return { success: true, registeredControllerCount };
}

function applyAbyssalNpcMaterializationMetadata({
  applyAbyssalNpcRuntimeMetadata,
}, context, spawnedEntries, hostileEntityIDs, npcRuntimePolicy) {
  const { pocketState, scene, roomState, contentProfile } = context;
  let bountySuppressedCount = 0;
  let weatherAppliedCount = 0;
  let weatherPendingCount = 0;
  const spawnedEntityByID = new Map(
    spawnedEntries
      .filter((entry) => entry && entry.entity && typeof entry.entity === "object")
      .map((entry) => [toInt(entry.entity.itemID, 0), entry]),
  );
  for (const hostileEntityID of hostileEntityIDs) {
    const entitiesToUpdate = [];
    const spawnedEntityEntry = spawnedEntityByID.get(hostileEntityID) || null;
    const spawnedEntity = spawnedEntityEntry && spawnedEntityEntry.entity || null;
    const sceneEntity =
      scene && typeof scene.getEntityByID === "function"
        ? scene.getEntityByID(hostileEntityID)
        : null;
    if (spawnedEntity) {
      entitiesToUpdate.push(spawnedEntity);
    }
    if (sceneEntity && sceneEntity !== spawnedEntity) {
      entitiesToUpdate.push(sceneEntity);
    }
    if (entitiesToUpdate.length <= 0) {
      continue;
    }
    let trackedBountySuppressed = false;
    let trackedWeatherApplied = false;
    let trackedWeatherPending = false;
    for (const entity of entitiesToUpdate) {
      const applyResult = applyAbyssalNpcRuntimeMetadata(
        entity,
        pocketState,
        npcRuntimePolicy,
        roomState,
        contentProfile,
        spawnedEntityEntry && spawnedEntityEntry.npcEntry,
      );
      trackedBountySuppressed = trackedBountySuppressed || applyResult.bountySuppressed === true;
      trackedWeatherApplied = trackedWeatherApplied || applyResult.weatherApplied === true;
      trackedWeatherPending = trackedWeatherPending || applyResult.weatherPending === true;
    }
    if (trackedBountySuppressed) {
      bountySuppressedCount += 1;
    }
    if (trackedWeatherApplied) {
      weatherAppliedCount += 1;
    }
    if (trackedWeatherPending) {
      weatherPendingCount += 1;
    }
  }
  return { bountySuppressedCount, weatherAppliedCount, weatherPendingCount };
}

function orderAbyssalMaterializedNpcAttacks({
  log,
}, context, hostileEntityIDs, npcRuntime) {
  const { pocketState, sceneDescriptor, combatParticipantShipID } = context;
  if (
    !sceneDescriptor &&
    combatParticipantShipID > 0 &&
    typeof npcRuntime.issueAttackOrder === "function"
  ) {
    for (const hostileEntityID of hostileEntityIDs) {
      // Abyssal NPCs shoot capsules (the order's own pod rule is the one followed).
      const attackResult = npcRuntime.issueAttackOrder(
        hostileEntityID,
        combatParticipantShipID,
        {
          keepLock: true,
          allowPodKill: true,
        },
      );
      if (!attackResult || attackResult.success === false) {
        log.warn(
          `[AbyssalMgr] Abyssal encounter attack order failed instance=${pocketState.instanceID} ` +
            `hostile=${hostileEntityID} target=${combatParticipantShipID || "none"} reason=${
              attackResult && attackResult.errorMsg || "UNKNOWN"
            }`,
        );
      }
    }
  }
}

function buildAbyssalNpcMaterializationResult({
  cloneValue,
}, npcProfile, construction, roster, npcRuntimePolicy, metadata) {
  const { spawnProfileIDs, primarySpawnPosition } = construction;
  const { hostileEntityIDs, objectiveRelevantNpcItemIDs, lifecycleResult } = roster;
  const { bountySuppressedCount, weatherAppliedCount, weatherPendingCount } = metadata;
  return {
    success: true,
    data: {
      spawnMode: "npc",
      hostileEntityIDs,
      plannedObjectiveNpcItemIDs: objectiveRelevantNpcItemIDs,
      materializedObjectiveNpcItemIDs: objectiveRelevantNpcItemIDs,
      objectiveRelevantNpcItemIDs,
      controllerDependantLifecycleGroups:
        lifecycleResult.data.controllerDependantLifecycleGroups,
      dependantInactiveNpcItemIDs:
        lifecycleResult.data.dependantInactiveNpcItemIDs,
      destroyedDependantNpcItemIDs:
        lifecycleResult.data.destroyedDependantNpcItemIDs,
      encounterProfileID: normalizeText(npcProfile.encounterProfileID, ""),
      encounterName: normalizeText(npcProfile.encounterName, ""),
      encounterTheme: normalizeText(npcProfile.encounterTheme, ""),
      encounterFactionTheme: normalizeText(npcProfile.factionTheme, ""),
      encounterWeatherTheme: normalizeText(npcProfile.weatherTheme, ""),
      rewardProfileOverride: cloneValue(npcProfile.rewardProfileOverride),
      cacheProfileOverride: cloneValue(npcProfile.cacheProfileOverride),
      observedObjectEntries: cloneValue(npcProfile.observedObjectEntries) || [],
      sourceModelID: normalizeText(npcProfile.sourceModelID, ""),
      sourceVariantID: normalizeText(npcProfile.sourceVariantID, ""),
      sourceSpawnID: normalizeText(npcProfile.sourceSpawnID, ""),
      sourceSpawnFamily: normalizeText(npcProfile.sourceSpawnFamily, ""),
      sourceObservationCount: Math.max(0, toInt(npcProfile.sourceObservationCount, 0)),
      sourceEvidenceAuthority: normalizeText(npcProfile.sourceEvidenceAuthority, ""),
      encounterAuthority: cloneValue(npcProfile.encounterAuthority),
      resolvedNpcEntries: cloneValue(npcProfile.npcEntries),
      objectiveTotal: objectiveRelevantNpcItemIDs.length,
      encounterDroneCount: toInt(npcProfile.encounterDroneCount, 0),
      encounterShipCount: toInt(npcProfile.encounterShipCount, 0),
      encounterEscortTypeID: toInt(npcProfile.encounterEscortTypeID, 0),
      rewardMultiplier: Number(npcProfile.rewardMultiplier) || 1,
      rewardQuantityBonus: toInt(npcProfile.rewardQuantityBonus, 0),
      spawnRadiusMeters: toInt(npcProfile.spawnRadiusMeters, 0),
      spawnJitterMeters: toInt(npcProfile.spawnJitterMeters, 0),
      spawnProfileID: normalizeText(npcProfile.profileQuery, ""),
      spawnProfileIDs,
      spawnPosition: primarySpawnPosition || { x: 0, y: 0, z: 0 },
      spawnedCount: hostileEntityIDs.length,
      npcRuntimePolicy,
      bountySuppressedCount,
      weatherAppliedCount,
      weatherPendingCount,
    },
  };
}

function spawnPlaceholderEncounter({
  getDependencies,
  createAbyssalNpcMaterializationPhaseRecorder,
  resolveAbyssalNpcMaterializationContext,
  materializeAbyssalNpcEntries,
  validateAbyssalNpcMaterializationRoster,
  getNpcRuntimePolicy,
  validateAbyssalNpcMaterializationScene,
  applyAbyssalNpcMaterializationMetadata,
  orderAbyssalMaterializedNpcAttacks,
  buildAbyssalNpcMaterializationResult,
}, pocketState, session, deps = getDependencies(), options = {}) {
  const recordEncounterPhase = createAbyssalNpcMaterializationPhaseRecorder(pocketState, deps);
  const contextResult = resolveAbyssalNpcMaterializationContext(pocketState, session, deps, recordEncounterPhase);
  if (!contextResult.success) return contextResult;
  const context = contextResult.data;
  const { roomIndex, npcProfile } = context;
  const constructionResult = materializeAbyssalNpcEntries(context, deps, options);
  if (!constructionResult.success) return constructionResult;
  const construction = constructionResult.data;
  const { spawnedEntries, spawnOrdinal } = construction;
  recordEncounterPhase("npc-construction", {
    room: roomIndex,
    npcCount: spawnOrdinal,
    sceneObjects: spawnedEntries.length,
    controllerCreations: spawnedEntries.length,
  });
  const rosterResult = validateAbyssalNpcMaterializationRoster(npcProfile, spawnedEntries, spawnOrdinal, deps);
  if (!rosterResult.success) return rosterResult;
  const roster = rosterResult.data;
  const { hostileEntityIDs } = roster;
  const npcRuntimePolicy = getNpcRuntimePolicy(pocketState);
  const registrationResult = validateAbyssalNpcMaterializationScene(context, spawnedEntries, roster, deps);
  if (!registrationResult.success) return registrationResult;
  recordEncounterPhase("scene-registration-readiness", {
    room: roomIndex,
    npcCount: hostileEntityIDs.length,
    readinessAttempts: 0,
    controllerRegistered: registrationResult.registeredControllerCount,
    bubbleMismatch: 0,
  });
  const metadata = applyAbyssalNpcMaterializationMetadata(context, spawnedEntries, hostileEntityIDs, npcRuntimePolicy);
  recordEncounterPhase("runtime-metadata-weather-initialization", {
    room: roomIndex,
    npcCount: hostileEntityIDs.length,
    weatherApplied: metadata.weatherAppliedCount,
    weatherPending: metadata.weatherPendingCount,
    bountySuppressed: metadata.bountySuppressedCount,
  });
  orderAbyssalMaterializedNpcAttacks(context, hostileEntityIDs, deps);
  return buildAbyssalNpcMaterializationResult(npcProfile, construction, roster, npcRuntimePolicy, metadata);
}

function buildPlaceholderEncounterState({
  getDependencies,
  spawnPlaceholderEncounter,
  log,
  buildPlaceholderRoomState,
  cloneValue,
}, pocketState, session, deps = getDependencies(), options = {}) {
  const encounterResult = spawnPlaceholderEncounter(pocketState, session, deps, options);
  if (!encounterResult.success) {
    log.warn(
      `[AbyssalMgr] Abyssal encounter spawn failed char=${pocketState.characterID} ` +
        `instance=${pocketState.instanceID} reason=${encounterResult.errorMsg || "UNKNOWN"} ` +
        `conduitFailClosed=true`,
    );
    return {
      spawnMode: "degraded",
      hostileEntityIDs: [],
      objectiveComplete: false,
      objectiveCompletedAtMs: 0,
      allowDebugExit: false,
      encounterSpawnFailed: true,
      encounterSpawnError: encounterResult.errorMsg || "PLACEHOLDER_ENCOUNTER_SPAWN_FAILED",
      encounterSpawnedAtMs: toInt(deps.now(), 0),
      encounterProfileID: "",
      encounterName: "",
      encounterTheme: "",
      encounterFactionTheme: "",
      encounterWeatherTheme: "",
      resolvedNpcEntries: [],
      spawnedNpcItemIDs: [],
      plannedObjectiveNpcItemIDs: [],
      materializedObjectiveNpcItemIDs: [],
      objectiveRelevantNpcItemIDs: [],
      controllerDependantLifecycleGroups: [],
      dependantInactiveNpcItemIDs: [],
      destroyedDependantNpcItemIDs: [],
      destroyedObjectiveIDs: [],
      defeatedObjectiveItemIDs: [],
      objectiveTotal: 0,
      objectiveDefeatedCount: 0,
      encounterDroneCount: 0,
      encounterShipCount: 0,
      encounterEscortTypeID: 0,
    };
  }
  log.info(
    `[AbyssalMgr] Abyssal encounter spawned char=${pocketState.characterID} ` +
      `instance=${pocketState.instanceID} room=${toInt(buildPlaceholderRoomState(pocketState).currentRoomIndex, 1)} ` +
      `hostiles=${encounterResult.data.hostileEntityIDs.join(",")} ` +
      `mode=${encounterResult.data.spawnMode} profile=${encounterResult.data.spawnProfileID}`,
  );
  return {
    spawnMode: encounterResult.data.spawnMode,
    hostileEntityIDs: encounterResult.data.hostileEntityIDs,
    spawnedNpcItemIDs: cloneValue(encounterResult.data.hostileEntityIDs),
    plannedObjectiveNpcItemIDs: cloneValue(encounterResult.data.plannedObjectiveNpcItemIDs),
    materializedObjectiveNpcItemIDs: cloneValue(encounterResult.data.materializedObjectiveNpcItemIDs),
    objectiveRelevantNpcItemIDs: cloneValue(encounterResult.data.objectiveRelevantNpcItemIDs),
    controllerDependantLifecycleGroups: cloneValue(
      encounterResult.data.controllerDependantLifecycleGroups,
    ) || [],
    dependantInactiveNpcItemIDs: cloneValue(
      encounterResult.data.dependantInactiveNpcItemIDs,
    ) || [],
    destroyedDependantNpcItemIDs: cloneValue(
      encounterResult.data.destroyedDependantNpcItemIDs,
    ) || [],
    destroyedObjectiveIDs: [],
    defeatedObjectiveItemIDs: [],
    objectiveTotal: toInt(encounterResult.data.objectiveTotal, 0),
    objectiveDefeatedCount: 0,
    objectiveComplete: false,
    objectiveCompletedAtMs: 0,
    allowDebugExit: false,
    encounterSpawnFailed: false,
    encounterSpawnError: null,
    encounterSpawnedAtMs: toInt(deps.now(), 0),
    encounterProfileID: normalizeText(encounterResult.data.encounterProfileID, ""),
    encounterName: normalizeText(encounterResult.data.encounterName, ""),
    encounterTheme: normalizeText(encounterResult.data.encounterTheme, ""),
    encounterFactionTheme: normalizeText(encounterResult.data.encounterFactionTheme, ""),
    encounterWeatherTheme: normalizeText(encounterResult.data.encounterWeatherTheme, ""),
    rewardProfileOverride: cloneValue(encounterResult.data.rewardProfileOverride),
    cacheProfileOverride: cloneValue(encounterResult.data.cacheProfileOverride),
    observedObjectEntries: cloneValue(encounterResult.data.observedObjectEntries) || [],
    sourceModelID: normalizeText(encounterResult.data.sourceModelID, ""),
    sourceVariantID: normalizeText(encounterResult.data.sourceVariantID, ""),
    sourceSpawnID: normalizeText(encounterResult.data.sourceSpawnID, ""),
    sourceSpawnFamily: normalizeText(encounterResult.data.sourceSpawnFamily, ""),
    sourceObservationCount: Math.max(
      0,
      toInt(encounterResult.data.sourceObservationCount, 0),
    ),
    sourceEvidenceAuthority: normalizeText(
      encounterResult.data.sourceEvidenceAuthority,
      "",
    ),
    encounterAuthority: cloneValue(encounterResult.data.encounterAuthority),
    resolvedNpcEntries: cloneValue(encounterResult.data.resolvedNpcEntries) || [],
    encounterDroneCount: toInt(encounterResult.data.encounterDroneCount, 0),
    encounterShipCount: toInt(encounterResult.data.encounterShipCount, 0),
    encounterEscortTypeID: toInt(encounterResult.data.encounterEscortTypeID, 0),
    rewardMultiplier: Number(encounterResult.data.rewardMultiplier) || 1,
    rewardQuantityBonus: toInt(encounterResult.data.rewardQuantityBonus, 0),
    spawnRadiusMeters: toInt(encounterResult.data.spawnRadiusMeters, 0),
    spawnJitterMeters: toInt(encounterResult.data.spawnJitterMeters, 0),
    encounterSpawnProfileID: encounterResult.data.spawnProfileID,
    encounterSpawnProfileIDs: cloneValue(encounterResult.data.spawnProfileIDs) || [],
    encounterSpawnPosition: cloneValue(encounterResult.data.spawnPosition),
    npcRuntimePolicy: cloneValue(encounterResult.data.npcRuntimePolicy) || null,
    bountySuppressedCount: toInt(encounterResult.data.bountySuppressedCount, 0),
    weatherAppliedCount: toInt(encounterResult.data.weatherAppliedCount, 0),
    weatherPendingCount: toInt(encounterResult.data.weatherPendingCount, 0),
  };
}

function destroyPocketEncounterEntities({
  getDependencies,
  listAllPocketHostileEntityIDs,
}, pocketState, deps = getDependencies()) {
  const npcService = deps;
  if (!npcService || typeof npcService.destroyNpcControllerByEntityID !== "function") {
    return [];
  }
  const destroyed = [];
  for (const hostileEntityID of listAllPocketHostileEntityIDs(pocketState)) {
    const destroyResult = npcService.destroyNpcControllerByEntityID(hostileEntityID, {
      removeContents: true,
    });
    if (destroyResult && destroyResult.success) {
      destroyed.push(hostileEntityID);
    }
  }
  return destroyed;
}

// Capture supplied capabilities once, as the original closure did. Internal
// callbacks are bound once per instance; no runtime state lives in this wiring.
function createAbyssalNpcMaterialization({
  listUniquePositiveInts,
  log,
  usesIsolatedAbyssalScene,
  buildAbyssalSceneDescriptor,
  getContentProfile,
  buildPlaceholderRoomState,
  getPlaceholderRoomEntry,
  getPocketScene,
  resolveAbyssalLiveCombatParticipant,
  getCharacterID,
  resolveRoomNpcProfileForSpawn,
  hasPrewarmedAbyssalEncounter,
  getNpcRuntimePolicy,
  cloneValue,
  ABYSSAL_ROOM_ENTITY_ROLES,
  ABYSSAL_ROOM_DELIVERY_STATE,
  resolveRoomOriginPosition,
  buildRoomConduitState,
  normalizeDirection,
  buildAbyssalNpcSpawnPosition,
  collectAbyssalNpcSceneRegistrationDiagnostics,
  formatAbyssalNpcSceneRegistrationDiagnostics,
  applyAbyssalNpcRuntimeMetadata,
  getDependencies,
  listAllPocketHostileEntityIDs,
}) {

  const ports = {
    listUniquePositiveInts,
    log,
    usesIsolatedAbyssalScene,
    buildAbyssalSceneDescriptor,
    getContentProfile,
    buildPlaceholderRoomState,
    getPlaceholderRoomEntry,
    getPocketScene,
    resolveAbyssalLiveCombatParticipant,
    getCharacterID,
    resolveRoomNpcProfileForSpawn,
    hasPrewarmedAbyssalEncounter,
    getNpcRuntimePolicy,
    cloneValue,
    ABYSSAL_ROOM_ENTITY_ROLES,
    ABYSSAL_ROOM_DELIVERY_STATE,
    resolveRoomOriginPosition,
    buildRoomConduitState,
    normalizeDirection,
    buildAbyssalNpcSpawnPosition,
    collectAbyssalNpcSceneRegistrationDiagnostics,
    formatAbyssalNpcSceneRegistrationDiagnostics,
    applyAbyssalNpcRuntimeMetadata,
    getDependencies,
    listAllPocketHostileEntityIDs,
  };
  ports.rollbackAbyssalEncounterSpawnEntries = rollbackAbyssalEncounterSpawnEntries.bind(null, ports);
  ports.rollbackSpawnedAbyssalNpcEntries = rollbackSpawnedAbyssalNpcEntries.bind(null, ports);
  ports.materializeControllerDependantLifecycle = materializeControllerDependantLifecycle.bind(null, ports);
  ports.createAbyssalNpcMaterializationPhaseRecorder = createAbyssalNpcMaterializationPhaseRecorder.bind(null, ports);
  ports.resolveAbyssalNpcMaterializationContext = resolveAbyssalNpcMaterializationContext.bind(null, ports);
  ports.buildAbyssalNpcMaterializationSpawnOptions = buildAbyssalNpcMaterializationSpawnOptions.bind(null, ports);
  ports.materializeAbyssalNpcEntries = materializeAbyssalNpcEntries.bind(null, ports);
  ports.validateAbyssalNpcMaterializationRoster = validateAbyssalNpcMaterializationRoster.bind(null, ports);
  ports.validateAbyssalNpcMaterializationScene = validateAbyssalNpcMaterializationScene.bind(null, ports);
  ports.applyAbyssalNpcMaterializationMetadata = applyAbyssalNpcMaterializationMetadata.bind(null, ports);
  ports.orderAbyssalMaterializedNpcAttacks = orderAbyssalMaterializedNpcAttacks.bind(null, ports);
  ports.buildAbyssalNpcMaterializationResult = buildAbyssalNpcMaterializationResult.bind(null, ports);
  ports.spawnPlaceholderEncounter = spawnPlaceholderEncounter.bind(null, ports);
  ports.buildPlaceholderEncounterState = buildPlaceholderEncounterState.bind(null, ports);
  ports.destroyPocketEncounterEntities = destroyPocketEncounterEntities.bind(null, ports);
  Object.freeze(ports);
  return {
    rollbackAbyssalEncounterSpawnEntries: ports.rollbackAbyssalEncounterSpawnEntries,
    rollbackSpawnedAbyssalNpcEntries: ports.rollbackSpawnedAbyssalNpcEntries,
    materializeControllerDependantLifecycle: ports.materializeControllerDependantLifecycle,
    spawnPlaceholderEncounter: ports.spawnPlaceholderEncounter,
    buildPlaceholderEncounterState: ports.buildPlaceholderEncounterState,
    destroyPocketEncounterEntities: ports.destroyPocketEncounterEntities,
  };
}

module.exports = { createAbyssalNpcMaterialization };
