"use strict";

const { normalizeText } = require("../domain/abyssalValueUtils");

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

// Environment object lifecycle and readiness; engine and run owners are injected.
function despawnAbyssalEnvironmentalObjectEntity({
  cleanupSuppressorControllerByRuntimeEntity,
  getPocketScene,
  cleanupSuppressorPresentationStateByEntity,
},
  pocketState,
  entityID,
  deps,
  reason = "room-transfer-environmental-object-despawn",
) {
  const numericEntityID = toInt(entityID, 0);
  const numericInstanceID = toInt(pocketState && pocketState.instanceID, 0);
  cleanupSuppressorControllerByRuntimeEntity(
    numericInstanceID,
    numericEntityID,
    reason,
  );
  const scene = getPocketScene(pocketState, deps);
  if (!scene || typeof scene.getEntityByID !== "function") {
    return {
      itemID: numericEntityID,
      failed: true,
      errorMsg: "SCENE_UNAVAILABLE",
    };
  }
  if (!scene.getEntityByID(numericEntityID)) {
    return {
      itemID: numericEntityID,
      alreadyGone: true,
    };
  }
  if (typeof scene.removeDynamicEntity !== "function") {
    return {
      itemID: numericEntityID,
      failed: true,
      errorMsg: "REMOVE_DYNAMIC_UNSUPPORTED",
    };
  }
  const removeResult = scene.removeDynamicEntity(numericEntityID, {
    broadcast: false,
    nowMs: toInt(deps.now(), 0),
    lifecycleReason: reason,
  });
  if (!removeResult || removeResult.success !== true) {
    return {
      itemID: numericEntityID,
      failed: true,
      errorMsg: normalizeText(removeResult && removeResult.errorMsg, reason),
    };
  }
  cleanupSuppressorPresentationStateByEntity(numericInstanceID, numericEntityID);
  return {
    itemID: numericEntityID,
    removed: true,
  };
}

function settleAbyssalEnvironmentalObjectDestruction({
  setPlaceholderRoomEntry,
  cloneValue,
  updatePocketState,
  buildPocketStateForCurrentRoom,
  ensureAbyssalPocketPersistenceReady,
  stopSuppressorPresentationsForPocketRun,
  cleanupSuppressorControllerByRuntimeEntity,
  cleanupSuppressorPresentationStateByEntity,
}, context, deps) {
  const {
    instanceID,
    pocketState,
    roomEntry,
    slotIndex,
    runtimeEntityID,
    typeID,
    expectedProfileID,
    roomIndex,
    cleanupReason,
  } = context;
  const destructionReceipt = {
    slot: slotIndex + 1,
    itemID: runtimeEntityID,
    typeID,
    profileID: expectedProfileID,
    destroyedAtMs: toInt(deps.now(), Date.now()),
    reason: cleanupReason,
  };
  const nextRoomState = setPlaceholderRoomEntry(pocketState, roomIndex, {
    ...roomEntry,
    environmentalObjectDestroyedReceiptsBySlot: {
      ...cloneValue(roomEntry.environmentalObjectDestroyedReceiptsBySlot || {}),
      [String(slotIndex + 1)]: destructionReceipt,
    },
  });
  const updatedPocketState = updatePocketState(instanceID, {
    ...buildPocketStateForCurrentRoom(pocketState, nextRoomState),
  }) || pocketState;
  const persistenceResult = ensureAbyssalPocketPersistenceReady(updatedPocketState, deps);
  stopSuppressorPresentationsForPocketRun(pocketState, deps, {
    roomIndex,
    runtimeEntityID,
    reason: cleanupReason,
  });
  const cleaned = cleanupSuppressorControllerByRuntimeEntity(
    instanceID,
    runtimeEntityID,
    cleanupReason,
  );
  const presentationCleaned = cleanupSuppressorPresentationStateByEntity(
    instanceID,
    runtimeEntityID,
  );
  return {
    success: true,
    handled: true,
    cleaned,
    presentationCleaned,
    destructionReceipt,
    persistenceResult,
    reason: cleaned > 0 || presentationCleaned > 0 ? cleanupReason : "ALREADY_CLEANED",
  };
}

function handleAbyssalEnvironmentalObjectDestroyed({
  getDependencies,
  getActivePocketStateByInstanceID,
  evaluateAbyssalDirectCallbackTerminalGuard,
  buildAbyssalDirectCallbackSuppressedResult,
  listSuppressorControllersForRun,
  getSuppressorPresentationState,
  listSuppressorPresentationStatesForRun,
  getPlaceholderRoomEntry,
  listUniquePositiveInts,
  getAbyssalEnvironmentalDefinition,
  resolveSuppressorSceneKey,
  getPocketScene,
  settleAbyssalEnvironmentalObjectDestruction,
},
  destroyedEnvironmentalObject = {},
  deps = getDependencies(),
) {
  const instanceID = toInt(destroyedEnvironmentalObject.instanceID, 0);
  const runtimeEntityID = toInt(
    destroyedEnvironmentalObject.itemID || destroyedEnvironmentalObject.runtimeEntityID,
    0,
  );
  const typeID = toInt(destroyedEnvironmentalObject.typeID, 0);
  const cleanupReason = normalizeText(
    destroyedEnvironmentalObject.reason,
    "entity-destroyed",
  );
  if (
    instanceID <= 0 ||
    runtimeEntityID <= 0
  ) {
    return {
      success: true,
      handled: false,
      cleaned: 0,
      reason: "ENVIRONMENTAL_MECHANICS_NOT_APPLICABLE",
    };
  }

  const pocketState = getActivePocketStateByInstanceID(instanceID);
  if (!pocketState) {
    return {
      success: true,
      handled: false,
      cleaned: 0,
      reason: "ABYSSAL_RUN_NOT_ACTIVE",
    };
  }
  const terminalGuard = evaluateAbyssalDirectCallbackTerminalGuard(
    pocketState,
    "environmental-object-destroyed",
  );
  if (terminalGuard.blocked) {
    return buildAbyssalDirectCallbackSuppressedResult(terminalGuard, {
      itemID: runtimeEntityID,
      roomIndex: toInt(destroyedEnvironmentalObject.roomIndex, 0),
      extra: { cleaned: 0 },
    });
  }
  const controllers = listSuppressorControllersForRun(instanceID)
    .filter((controller) => controller.runtimeEntityID === runtimeEntityID);
  const requestedRoomIndex = toInt(destroyedEnvironmentalObject.roomIndex, 0);
  const controller = controllers.find((entry) => (
    requestedRoomIndex <= 0 || entry.roomIndex === requestedRoomIndex
  )) || null;
  const presentationState = requestedRoomIndex > 0
    ? getSuppressorPresentationState(instanceID, requestedRoomIndex, runtimeEntityID)
    : listSuppressorPresentationStatesForRun(instanceID)
      .find((entry) => entry.runtimeEntityID === runtimeEntityID) || null;
  const roomIndex = toInt(
    controller ? controller.roomIndex : undefined,
    toInt(presentationState ? presentationState.roomIndex : undefined, requestedRoomIndex),
  );
  const roomEntry = getPlaceholderRoomEntry(pocketState, roomIndex);
  const environmentalItemIDs = listUniquePositiveInts(roomEntry.environmentalObjectItemIDs);
  const slotIndex = environmentalItemIDs.findIndex((itemID) => itemID === runtimeEntityID);
  const expectedTypeID = toInt(roomEntry.environmentalObjectTypeIDs &&
    roomEntry.environmentalObjectTypeIDs[slotIndex], 0);
  const expectedProfileID = normalizeText(roomEntry.environmentalObjectProfileIDs &&
    roomEntry.environmentalObjectProfileIDs[slotIndex], "");
  const environmentalDefinition = getAbyssalEnvironmentalDefinition(expectedProfileID);
  if (
    roomIndex <= 0 ||
    slotIndex < 0 ||
    expectedTypeID !== typeID ||
    !expectedProfileID ||
    !environmentalDefinition ||
    environmentalDefinition.destructible !== true
  ) {
    return {
      success: false,
      handled: false,
      cleaned: 0,
      errorMsg: "ABYSSAL_ENVIRONMENTAL_DESTROY_IDENTITY_MISMATCH",
    };
  }
  const expectedSceneKey = normalizeText(
    controller && controller.sceneKey,
    normalizeText(
      presentationState && presentationState.sceneKey,
      resolveSuppressorSceneKey(pocketState, getPocketScene(pocketState, deps), deps),
    ),
  );
  const destroyedSceneKey = normalizeText(
    destroyedEnvironmentalObject.sceneKey,
    expectedSceneKey,
  );
  if (destroyedSceneKey !== expectedSceneKey) {
    return {
      success: false,
      handled: false,
      cleaned: 0,
      errorMsg: "ABYSSAL_SUPPRESSOR_DESTROY_SCENE_MISMATCH",
    };
  }
  return settleAbyssalEnvironmentalObjectDestruction({
    instanceID,
    pocketState,
    roomEntry,
    slotIndex,
    runtimeEntityID,
    typeID,
    expectedProfileID,
    roomIndex,
    cleanupReason,
  }, deps);
}

function buildAbyssalEnvironmentalMaterializationReadiness({
  getDependencies,
  getPlaceholderRoomEntry,
  getPocketScene,
  listAuthoredAbyssalEnvironmentalEntries,
  listUniquePositiveInts,
  listPositiveInts,
  getAbyssalSuppressorMechanicsProfileByTypeID,
  ENVIRONMENTAL_EFFECT_KIND,
  buildAbyssalEnvironmentalSlotReadiness,
},
  pocketState,
  roomIndex,
  deps = getDependencies(),
  options = {},
) {
  const runID = toInt(pocketState && pocketState.instanceID, 0);
  const numericRoomIndex = toInt(roomIndex, 0);
  const roomEntry = getPlaceholderRoomEntry(pocketState, numericRoomIndex);
  const scene = getPocketScene(pocketState, deps);
  const authoredEntries = listAuthoredAbyssalEnvironmentalEntries(
    pocketState,
    numericRoomIndex,
    options,
  );
  const trackedItemIDs = listUniquePositiveInts(
    roomEntry && roomEntry.environmentalObjectItemIDs,
  );
  const trackedTypeIDs = listPositiveInts(
    roomEntry && roomEntry.environmentalObjectTypeIDs,
  );
  const trackedProfileIDs = Array.isArray(roomEntry && roomEntry.environmentalObjectProfileIDs)
    ? roomEntry.environmentalObjectProfileIDs.map((profileID) => normalizeText(profileID, ""))
    : [];
  const expectedProfileIDs = authoredEntries.map((entry) =>
    normalizeText(entry && entry.profileID, "")
  );
  const expectedTypeIDs = authoredEntries.map((entry) => toInt(entry && entry.typeID, 0));
  const destroyedReceiptsBySlot = roomEntry &&
    roomEntry.environmentalObjectDestroyedReceiptsBySlot &&
    typeof roomEntry.environmentalObjectDestroyedReceiptsBySlot === "object"
      ? roomEntry.environmentalObjectDestroyedReceiptsBySlot
      : {};
  const isAuthorizedDestroyedSlot = (entry, index) => {
    const receipt = destroyedReceiptsBySlot[String(index + 1)];
    return Boolean(
      receipt &&
      toInt(receipt.slot, 0) === index + 1 &&
      toInt(receipt.itemID, 0) === toInt(trackedItemIDs[index], 0) &&
      toInt(receipt.typeID, 0) === toInt(entry && entry.typeID, 0) &&
      normalizeText(receipt.profileID, "") === normalizeText(entry && entry.profileID, "") &&
      toInt(receipt.destroyedAtMs, 0) > 0
    );
  };
  const authorizedDestroyedSlotIndexes = new Set(
    authoredEntries
      .map((entry, index) => isAuthorizedDestroyedSlot(entry, index) ? index : -1)
      .filter((index) => index >= 0),
  );
  const expectedSuppressorSlots = authoredEntries
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry, index }) => {
      const profile = getAbyssalSuppressorMechanicsProfileByTypeID(
        toInt(entry && entry.typeID, 0),
      );
      return Boolean(
        entry &&
        !authorizedDestroyedSlotIndexes.has(index) &&
        entry.mechanicsEnabled === true &&
        profile &&
        profile.mechanicsEnabled === true
      );
    });
  const unresolvedAuthoredSuppressorSlots = authoredEntries
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) =>
      entry &&
      entry.mechanicsEnabled === true &&
      normalizeText(entry.effectKind, "") === ENVIRONMENTAL_EFFECT_KIND.POINT_DEFENSE &&
      !getAbyssalSuppressorMechanicsProfileByTypeID(toInt(entry.typeID, 0))
    )
    .map(({ index }) => index + 1);
  const slotReadiness = authoredEntries.map((entry, index) =>
    buildAbyssalEnvironmentalSlotReadiness(entry, index, {
      trackedItemIDs,
      deps,
      scene,
      runID,
      numericRoomIndex,
      trackedTypeIDs,
      trackedProfileIDs,
      authorizedDestroyedSlotIndexes,
    }),
  );
  const missingOrInvalidSlots = slotReadiness
    .filter((slot) => slot.ready !== true)
    .map((slot) => slot.slot);
  const expectedSuppressorIDs = expectedSuppressorSlots
    .map(({ index }) => toInt(trackedItemIDs[index], 0))
    .filter((entityID) => entityID > 0);
  const exactComposition = Boolean(
    authoredEntries.length > 0 &&
    trackedItemIDs.length === authoredEntries.length &&
    trackedTypeIDs.length === authoredEntries.length &&
    trackedProfileIDs.length === authoredEntries.length &&
    missingOrInvalidSlots.length === 0 &&
    unresolvedAuthoredSuppressorSlots.length === 0
  );
  return {
    ready: exactComposition,
    errorMsg: exactComposition
      ? ""
      : authoredEntries.length <= 0
        ? "ABYSSAL_ENVIRONMENT_PROFILE_EMPTY"
        : unresolvedAuthoredSuppressorSlots.length > 0
          ? "ABYSSAL_ENVIRONMENT_SUPPRESSOR_PROFILE_UNRESOLVED"
          : "ABYSSAL_ENVIRONMENT_MATERIALIZATION_INCOMPLETE",
    authoredCount: authoredEntries.length - authorizedDestroyedSlotIndexes.size,
    totalAuthoredCount: authoredEntries.length,
    authorizedDestroyedCount: authorizedDestroyedSlotIndexes.size,
    materializedCount: trackedItemIDs.length,
    expectedProfileIDs,
    expectedTypeIDs,
    trackedItemIDs,
    trackedTypeIDs,
    trackedProfileIDs,
    expectedSuppressorCount: expectedSuppressorSlots.length,
    expectedSuppressorIDs,
    unresolvedAuthoredSuppressorSlots,
    missingOrInvalidSlots,
    slotReadiness,
  };
}

function buildAbyssalEnvironmentalEffectReadiness({
  getDependencies,
  getPocketScene,
  buildAbyssalEnvironmentalMaterializationReadiness,
  getPlaceholderRoomEntry,
  listAuthoredAbyssalEnvironmentalEntries,
  listExactAbyssalBoundaryCompanionEntities,
  listUniquePositiveInts,
  ENVIRONMENTAL_EFFECT_KIND,
  resolveExactAbyssalRunRoomScope,
  getVectorDistance,
},
  pocketState,
  roomIndex,
  evaluationResult,
  deps = getDependencies(),
) {
  const runID = toInt(pocketState && pocketState.instanceID, 0);
  const numericRoomIndex = toInt(roomIndex, 0);
  const scene = getPocketScene(pocketState, deps);
  const materialization = buildAbyssalEnvironmentalMaterializationReadiness(
    pocketState,
    numericRoomIndex,
    deps,
  );
  const roomEntry = getPlaceholderRoomEntry(pocketState, numericRoomIndex);
  const authoredEntries = listAuthoredAbyssalEnvironmentalEntries(
    pocketState,
    numericRoomIndex,
  );
  const environmentalCompanions = listExactAbyssalBoundaryCompanionEntities(
    pocketState,
    numericRoomIndex,
    scene,
  );
  const candidateIDs = listUniquePositiveInts([
    pocketState && pocketState.shipID,
    ...(Array.isArray(roomEntry && roomEntry.hostileEntityIDs)
      ? roomEntry.hostileEntityIDs
      : []),
    ...environmentalCompanions.map((entity) => entity && entity.itemID),
  ]);
  const candidates = candidateIDs
    .map((entityID) => scene && typeof scene.getEntityByID === "function"
      ? scene.getEntityByID(entityID)
      : null)
    .filter(Boolean);
  const expectedModifierKeys = [];
  const missingModifierKeys = [];
  const staleModifierKeys = [];
  for (const [index, entry] of authoredEntries.entries()) {
    const definition = entry && entry.definition || {};
    if (
      entry &&
      entry.mechanicsEnabled === true &&
      normalizeText(entry.effectKind, "") === ENVIRONMENTAL_EFFECT_KIND.LOCALIZED_MODIFIER
    ) {
      const sourceItemID = toInt(materialization.trackedItemIDs[index], 0);
      const sourceEntity = sourceItemID > 0 && scene && typeof scene.getEntityByID === "function"
        ? scene.getEntityByID(sourceItemID)
        : null;
      const modifierKey = `abyssalEnvironmental:${runID}:${numericRoomIndex}:${sourceItemID}`;
      const affectedKinds = Array.isArray(definition.affectedEntityKinds)
        ? definition.affectedEntityKinds.map((value) => normalizeText(value, ""))
        : [];
      const radiusMeters = Number.isFinite(Number(definition.radiusMeters))
        ? Number(definition.radiusMeters)
        : 0;
      const expectedCollectionValues = Object.fromEntries(
        (Array.isArray(definition.dbuffCollectionValues)
          ? definition.dbuffCollectionValues
          : [])
          .map((value) => [toInt(value && value.collectionID, 0), Number(value && value.value)])
          .filter(([collectionID, value]) => collectionID > 0 && Number.isFinite(value)),
      );
      for (const candidate of candidates) {
        const candidateScope = resolveExactAbyssalRunRoomScope(candidate);
        const candidateInScope = Boolean(
          candidateScope &&
          candidateScope.runID === runID &&
          candidateScope.roomIndex === numericRoomIndex
        );
        const affected = affectedKinds.length <= 0 ||
          affectedKinds.includes(normalizeText(candidate && candidate.kind, ""));
        const inRange = Boolean(
          sourceEntity &&
          candidateInScope &&
          affected &&
          (radiusMeters <= 0 || getVectorDistance(sourceEntity, candidate) <= radiusMeters)
        );
        const modifier = candidate && candidate.evejsAbyssalEnvironmentalModifiers &&
          candidate.evejsAbyssalEnvironmentalModifiers[modifierKey];
        if (inRange) {
          expectedModifierKeys.push(`${toInt(candidate.itemID, 0)}:${modifierKey}`);
          const modifierCollections = modifier && modifier.dbuffCollectionValues || {};
          const collectionsReady = Object.entries(expectedCollectionValues).every(
            ([collectionID, value]) => Number(modifierCollections[collectionID]) === Number(value),
          );
          if (
            !modifier ||
            toInt(modifier.sourceItemID, 0) !== sourceItemID ||
            normalizeText(modifier.profileID, "") !== normalizeText(entry.profileID, "") ||
            !collectionsReady
          ) {
            missingModifierKeys.push(`${toInt(candidate.itemID, 0)}:${modifierKey}`);
          }
        } else if (modifier) {
          staleModifierKeys.push(`${toInt(candidate.itemID, 0)}:${modifierKey}`);
        }
      }
    }
  }
  const unresolvedCollectionIDs = listUniquePositiveInts(
    evaluationResult && evaluationResult.unresolvedCollectionIDs,
  );
  const evaluatedCount = toInt(evaluationResult && evaluationResult.evaluated, -1);
  const ready = Boolean(
    materialization.ready &&
    evaluationResult &&
    evaluationResult.skipped !== true &&
    unresolvedCollectionIDs.length === 0 &&
    evaluatedCount === materialization.authoredCount &&
    missingModifierKeys.length === 0 &&
    staleModifierKeys.length === 0
  );
  return {
    ready,
    errorMsg: ready
      ? ""
      : !materialization.ready
        ? materialization.errorMsg
        : unresolvedCollectionIDs.length > 0
          ? "ABYSSAL_ENVIRONMENT_EFFECT_COLLECTIONS_UNRESOLVED"
          : "ABYSSAL_ENVIRONMENT_EFFECTS_NOT_READY",
    evaluatedCount,
    authoredCount: materialization.authoredCount,
    candidateIDs,
    expectedModifierKeys,
    missingModifierKeys,
    staleModifierKeys,
    unresolvedCollectionIDs,
    materialization,
  };
}

function materializeAbyssalEnvironmentalBatch({
  resolveAbyssalStructureType,
  buildEnvironmentalObjectSpawnState,
  resolvePlaceholderDurationMs,
  getContentProfile,
  buildEnvironmentalObjectCustomInfo,
  cloneValue,
  toReal,
  spawnPocketDynamicInventoryEntity,
  ABYSSAL_ROOM_DELIVERY_STATE,
  syncInventoryChanges,
}, resolvedPocketState, roomIndex, roomEntry, environmentalEntries, session, deps, options) {
  const numericInstanceID = toInt(resolvedPocketState.instanceID, 0);
  const createdItemIDs = [];
  const createdTypeIDs = [];
  const profileIDs = [];
  const changes = [];
  const materializationErrors = [];
  for (const environmentalEntry of environmentalEntries) {
    const definition = environmentalEntry.definition;
    const environmentRoomProfile =
      environmentalEntry.environmentRoomProfile &&
      typeof environmentalEntry.environmentRoomProfile === "object"
        ? environmentalEntry.environmentRoomProfile
        : {};
    const typeRecord = resolveAbyssalStructureType(environmentalEntry.typeID, deps);
    if (!typeRecord) {
      materializationErrors.push(
        `slot:${toInt(environmentalEntry && environmentalEntry.slot, 0)}:TYPE_UNRESOLVED`,
      );
      continue;
    }
    const spawnState = buildEnvironmentalObjectSpawnState(
      resolvedPocketState,
      roomEntry,
      environmentalEntry,
    );
    const createResult = deps.createSpaceItemForOwner(
      resolvedPocketState.characterID,
      resolvedPocketState.solarSystemID,
      typeRecord,
      {
        itemName: normalizeText(typeRecord.name, `Abyssal Environmental Object ${environmentalEntry.slot}`),
        ...spawnState,
        createdAtMs: toInt(deps.now(), 0),
        expiresAtMs: toInt(
          resolvedPocketState &&
            resolvedPocketState.timerState &&
            resolvedPocketState.timerState.expiresAtMs,
          toInt(deps.now(), 0) + resolvePlaceholderDurationMs(getContentProfile(resolvedPocketState), deps),
        ),
        customInfo: buildEnvironmentalObjectCustomInfo(resolvedPocketState, {
          roomIndex,
          slot: environmentalEntry.slot,
          profileID: environmentalEntry.profileID,
          sourceRole: environmentalEntry.sourceRole,
          typeID: environmentalEntry.typeID,
          definition,
          dunObjectID: environmentalEntry.dunObjectID,
          dunObjectNameID: environmentalEntry.dunObjectNameID,
          dunPosition: spawnState.dunPosition,
          dunRotation: spawnState.dunRotation,
          objectiveTargetGroup: environmentalEntry.objectiveTargetGroup,
          perimeterRadius: environmentalEntry.perimeterRadius,
          presentationEnabled: environmentalEntry.presentationEnabled === true,
          mechanicsEnabled: environmentalEntry.mechanicsEnabled === true,
          environmentProfileID: environmentRoomProfile.profileID,
          layoutVariant: environmentRoomProfile.layoutVariant,
          sceneCubeResource: environmentRoomProfile.sceneCubeResource,
          volumetricCloudResource: environmentRoomProfile.volumetricCloudResource,
          nearFieldResource: environmentRoomProfile.nearFieldResource,
          lensFlareResource: environmentRoomProfile.lensFlareResource,
          gradientResource: environmentRoomProfile.gradientResource,
          transitionEffect: environmentRoomProfile.transitionEffect,
          roomLayoutProfileID: environmentRoomProfile.roomLayoutProfileID,
          identity: cloneValue(environmentalEntry.identity),
          capturedRetailObject: environmentalEntry.capturedRetailObject === true,
          deliveryState: normalizeText(roomEntry.deliveryState, ""),
          transitionToken: toInt(roomEntry.deliveryTransitionToken, 0),
          selectedRoomLayoutID: normalizeText(roomEntry.selectedRoomLayoutID, ""),
          roomOriginPosition: cloneValue(roomEntry.roomOriginPosition),
          authoredLocalPosition: {
            x: toReal(spawnState.dunPosition && spawnState.dunPosition[0], 0),
            y: toReal(spawnState.dunPosition && spawnState.dunPosition[1], 0),
            z: toReal(spawnState.dunPosition && spawnState.dunPosition[2], 0),
          },
          worldPosition: cloneValue(spawnState.position),
        }),
      },
    );
    if (!createResult || !createResult.success || !createResult.data) {
      materializationErrors.push(
        `slot:${toInt(environmentalEntry && environmentalEntry.slot, 0)}:` +
          normalizeText(createResult && createResult.errorMsg, "CREATE_FAILED"),
      );
      continue;
    }
    const environmentalItem = createResult.data;
    const spawnResult = spawnPocketDynamicInventoryEntity(
      resolvedPocketState,
      environmentalItem.itemID,
      deps,
      {
        broadcast: options.broadcast !== false,
        initialPublication: options.broadcast === false ? "deferred" : undefined,
        suppressInitialPublication: options.broadcast === false,
        runtimeEntityMetadata: options.broadcast === false
          ? {
              abyssalRunID: numericInstanceID,
              abyssalRoomIndex: roomIndex,
              abyssalRoomDeliveryState: normalizeText(
                roomEntry.deliveryState,
                ABYSSAL_ROOM_DELIVERY_STATE.PREWARMED_HIDDEN,
              ),
              evejsAbyssalRoomDeliveryState: normalizeText(
                roomEntry.deliveryState,
                ABYSSAL_ROOM_DELIVERY_STATE.PREWARMED_HIDDEN,
              ),
              abyssalSelectedRoomLayoutID: normalizeText(roomEntry.selectedRoomLayoutID, ""),
              abyssalTransitionToken: toInt(roomEntry.deliveryTransitionToken, 0),
              evejsAbyssalRoomOriginPosition: cloneValue(roomEntry.roomOriginPosition),
            }
          : undefined,
      },
    );
    if (!spawnResult || !spawnResult.success) {
      deps.removeInventoryItem(environmentalItem.itemID, { removeContents: true });
      materializationErrors.push(
        `slot:${toInt(environmentalEntry && environmentalEntry.slot, 0)}:` +
          normalizeText(spawnResult && spawnResult.errorMsg, "SPAWN_FAILED"),
      );
      continue;
    }
    createdItemIDs.push(toInt(environmentalItem.itemID, 0));
    createdTypeIDs.push(toInt(typeRecord.typeID, 0));
    profileIDs.push(normalizeText(environmentalEntry.profileID, ""));
    changes.push(...(createResult.changes || []));
  }
  if (changes.length > 0) {
    syncInventoryChanges(session, changes, deps);
  }
  return { createdItemIDs, createdTypeIDs, profileIDs, materializationErrors };
}

function rollbackPartialAbyssalEnvironmentalMaterialization({
  destroyPlaceholderTrace,
  buildAbyssalSceneDescriptor,
  getPocketScene,
  setPlaceholderRoomEntry,
  updatePocketState,
  buildPocketStateForCurrentRoom,
}, resolvedPocketState, roomIndex, roomEntry, materialization, deps) {
  const numericInstanceID = toInt(resolvedPocketState.instanceID, 0);
  const { createdItemIDs, createdTypeIDs, profileIDs, materializationErrors } = materialization;
  const cleanupFailures = [];
  for (const createdItemID of createdItemIDs) {
    const cleanupResult = destroyPlaceholderTrace(
      resolvedPocketState.solarSystemID,
      createdItemID,
      deps,
      "environmental-object-partial-rollback",
      "environmental object",
      {
        sceneDescriptor:
          buildAbyssalSceneDescriptor(resolvedPocketState, deps) || undefined,
      },
    );
    const scene = getPocketScene(resolvedPocketState, deps);
    if (
      (cleanupResult && cleanupResult.failed === true) ||
      deps.findItemById(createdItemID) ||
      (scene && typeof scene.getEntityByID === "function" && scene.getEntityByID(createdItemID))
    ) {
      cleanupFailures.push(createdItemID);
    }
  }
  const residualIndexes = createdItemIDs
    .map((itemID, index) => ({ itemID, index }))
    .filter(({ itemID }) => cleanupFailures.includes(itemID));
  const failedRoomState = setPlaceholderRoomEntry(
    resolvedPocketState,
    roomIndex,
    {
      ...roomEntry,
      environmentalObjectItemIDs: residualIndexes.map(({ itemID }) => itemID),
      environmentalObjectTypeIDs: residualIndexes.map(({ index }) => createdTypeIDs[index]),
      environmentalObjectProfileIDs: residualIndexes.map(({ index }) => profileIDs[index]),
      environmentalObjectSpawnedAtMs: 0,
      environmentalObjectLifecycleState:
        cleanupFailures.length > 0 ? "spawn_failed_cleanup_pending" : "spawn_failed",
      environmentalObjectBlockReason: "PARTIAL_MATERIALIZATION_ROLLED_BACK",
    },
  );
  return {
    success: false,
    partial: true,
    errorMsg: "ABYSSAL_ENVIRONMENT_MATERIALIZATION_INCOMPLETE",
    errors: materializationErrors,
    cleanupPendingItemIDs: cleanupFailures,
    data: updatePocketState(
      numericInstanceID,
      buildPocketStateForCurrentRoom(resolvedPocketState, failedRoomState),
    ),
  };
}

function commitAbyssalEnvironmentalMaterialization({
  setPlaceholderRoomEntry,
  UNSTABLE_ABYSSAL_DEPTHS_BOUNDARY_PROFILE,
  updatePocketState,
  buildPocketStateForCurrentRoom,
  ensureSuppressorControllersForRoom,
  evaluateEnvironmentalEffectsForPocketState,
  buildAbyssalEnvironmentalMaterializationReadiness,
  getActivePocketStateByInstanceID,
}, resolvedPocketState, roomIndex, roomEntry, roomState, materialization, deps, options) {
  const numericInstanceID = toInt(resolvedPocketState.instanceID, 0);
  const { createdItemIDs, createdTypeIDs, profileIDs } = materialization;
  const nextRoomState = setPlaceholderRoomEntry(
    resolvedPocketState,
    roomIndex,
    {
      ...roomEntry,
      environmentalObjectItemIDs: createdItemIDs,
      environmentalObjectTypeIDs: createdTypeIDs,
      environmentalObjectProfileIDs: profileIDs,
      environmentalObjectSpawnedAtMs: createdItemIDs.length > 0 ? toInt(deps.now(), 0) : 0,
      environmentalObjectLifecycleState: createdItemIDs.length > 0 ? "spawned" : "spawn_failed",
      environmentalObjectBlockReason: createdItemIDs.length > 0 ? "none" : "TYPE_OR_SPAWN_UNRESOLVED",
      perimeterRadiusMeters:
        Number(UNSTABLE_ABYSSAL_DEPTHS_BOUNDARY_PROFILE.perimeterRadiusMeters) ||
        Number(UNSTABLE_ABYSSAL_DEPTHS_BOUNDARY_PROFILE.perimeterFallbackRadiusMeters) ||
        0,
      perimeterRadiusSource: "central-boundary-profile",
      boundaryRadiusMeters:
        Number(UNSTABLE_ABYSSAL_DEPTHS_BOUNDARY_PROFILE.perimeterRadiusMeters) ||
        Number(UNSTABLE_ABYSSAL_DEPTHS_BOUNDARY_PROFILE.perimeterFallbackRadiusMeters) ||
        0,
      boundaryRadiusSource: "central-boundary-profile",
    },
  );
  const updatedPocketState = updatePocketState(numericInstanceID, {
    ...buildPocketStateForCurrentRoom(resolvedPocketState, nextRoomState),
  }) || resolvedPocketState;
  const suppressorRegistrationResults = ensureSuppressorControllersForRoom(
    updatedPocketState,
    roomIndex,
    deps,
  );
  const effectEvaluationResult = roomIndex === roomState.currentRoomIndex
    ? evaluateEnvironmentalEffectsForPocketState(
        updatedPocketState,
        deps,
        toInt(deps.now(), 0),
      )
    : null;
  const readiness = buildAbyssalEnvironmentalMaterializationReadiness(
    getActivePocketStateByInstanceID(numericInstanceID) || updatedPocketState,
    roomIndex,
    deps,
    options,
  );
  return {
    success: readiness.ready === true,
    created: readiness.ready === true,
    skipped: false,
    partial: readiness.ready !== true,
    errorMsg: readiness.ready === true ? null : readiness.errorMsg,
    data: updatedPocketState,
    readiness,
    suppressorRegistrationResults,
    effectEvaluationResult,
  };
}

function cleanupAbyssalEnvironmentalRepairArtifacts({
  destroyPlaceholderTrace,
  buildAbyssalSceneDescriptor,
  getPocketScene,
}, resolvedPocketState, trackedItemIDs, deps) {
  const staleCleanupFailures = [];
  for (const staleItemID of trackedItemIDs) {
    const cleanupResult = destroyPlaceholderTrace(
      resolvedPocketState.solarSystemID,
      staleItemID,
      deps,
      "environmental-object-repair",
      "environmental object",
      {
        sceneDescriptor:
          buildAbyssalSceneDescriptor(resolvedPocketState, deps) || undefined,
      },
    );
    const scene = getPocketScene(resolvedPocketState, deps);
    const stillPresent = Boolean(
      deps.findItemById(staleItemID) ||
      (scene && typeof scene.getEntityByID === "function" && scene.getEntityByID(staleItemID))
    );
    if ((cleanupResult && cleanupResult.failed === true) || stillPresent) {
      staleCleanupFailures.push(staleItemID);
    }
  }
  return staleCleanupFailures;
}

function buildAbyssalEnvironmentalSlotReadiness({
  readEnvironmentalObjectStateFromItem,
  resolveExactAbyssalRunRoomScope,
}, entry, index, {
  trackedItemIDs,
  deps,
  scene,
  runID,
  numericRoomIndex,
  trackedTypeIDs,
  trackedProfileIDs,
  authorizedDestroyedSlotIndexes,
}) {
  const runtimeEntityID = toInt(trackedItemIDs[index], 0);
  const item = runtimeEntityID > 0 && typeof deps.findItemById === "function"
    ? deps.findItemById(runtimeEntityID)
    : null;
  const itemState = readEnvironmentalObjectStateFromItem(item);
  const entity = runtimeEntityID > 0 && scene && typeof scene.getEntityByID === "function"
    ? scene.getEntityByID(runtimeEntityID)
    : null;
  const entityScope = resolveExactAbyssalRunRoomScope(entity);
  const expectedProfileID = normalizeText(entry && entry.profileID, "");
  const expectedTypeID = toInt(entry && entry.typeID, 0);
  const authorizedDestroyed = authorizedDestroyedSlotIndexes.has(index);
  const ready = authorizedDestroyed || Boolean(
    runtimeEntityID > 0 &&
    item &&
    itemState &&
    toInt(item.typeID, 0) === expectedTypeID &&
    toInt(itemState.instanceID, 0) === runID &&
    toInt(itemState.roomIndex, 0) === numericRoomIndex &&
    toInt(itemState.slot, 0) === index + 1 &&
    normalizeText(itemState.profileID, "") === expectedProfileID &&
    toInt(trackedTypeIDs[index], 0) === expectedTypeID &&
    normalizeText(trackedProfileIDs[index], "") === expectedProfileID &&
    entity &&
    entity.evejsAbyssalEnvironmentalObject === true &&
    toInt(entity.typeID, 0) === expectedTypeID &&
    normalizeText(entity.evejsAbyssalEnvironmentalProfileID, "") === expectedProfileID &&
    entityScope &&
    entityScope.runID === runID &&
    entityScope.roomIndex === numericRoomIndex
  );
  return {
    slot: index + 1,
    runtimeEntityID,
    expectedProfileID,
    expectedTypeID,
    itemFound: Boolean(item),
    entityFound: Boolean(entity),
    itemProfileID: normalizeText(itemState && itemState.profileID, ""),
    entityProfileID: normalizeText(
      entity && entity.evejsAbyssalEnvironmentalProfileID,
      "",
    ),
    authorizedDestroyed,
    ready,
  };
}

function ensureAbyssalEnvironmentalObjects({
  getDependencies,
  getActivePocketStateByInstanceID,
  cloneValue,
  buildPlaceholderRoomState,
  clampRoomIndex,
  getPlaceholderRoomEntry,
  listAuthoredAbyssalEnvironmentalEntries,
  listUniquePositiveInts,
  buildAbyssalEnvironmentalMaterializationReadiness,
  ensureSuppressorControllersForRoom,
  evaluateEnvironmentalEffectsForPocketState,
  setPlaceholderRoomEntry,
  updatePocketState,
  buildPocketStateForCurrentRoom,
  cleanupAbyssalEnvironmentalRepairArtifacts,
  materializeAbyssalEnvironmentalBatch,
  rollbackPartialAbyssalEnvironmentalMaterialization,
  commitAbyssalEnvironmentalMaterialization,
}, pocketState, session = null, deps = getDependencies(), options = {}) {
  const numericInstanceID = toInt(pocketState && pocketState.instanceID, 0);
  if (numericInstanceID <= 0) {
    return {
      success: false,
      errorMsg: "POCKET_STATE_MISSING",
    };
  }
  const resolvedPocketState =
    getActivePocketStateByInstanceID(numericInstanceID) || cloneValue(pocketState);
  const roomState = buildPlaceholderRoomState(resolvedPocketState);
  const roomIndex = clampRoomIndex(
    toInt(options && options.roomIndex, roomState.currentRoomIndex),
    roomState.implementedRooms,
  );
  const roomEntry = getPlaceholderRoomEntry(resolvedPocketState, roomIndex);
  const environmentalEntries = listAuthoredAbyssalEnvironmentalEntries(
    resolvedPocketState,
    roomIndex,
    options,
  );
  const expectedProfileIDs = environmentalEntries.map((entry) =>
    normalizeText(entry && entry.profileID, "")
  );
  const trackedItemIDs = listUniquePositiveInts(roomEntry.environmentalObjectItemIDs);
  const existingMaterializationReadiness =
    buildAbyssalEnvironmentalMaterializationReadiness(
      resolvedPocketState,
      roomIndex,
      deps,
      options,
    );
  const compositionMatches = existingMaterializationReadiness.ready === true;
  if (compositionMatches) {
    const suppressorRegistrationResults = ensureSuppressorControllersForRoom(
      resolvedPocketState,
      roomIndex,
      deps,
    );
    const effectEvaluationResult = roomIndex === roomState.currentRoomIndex
      ? evaluateEnvironmentalEffectsForPocketState(
          resolvedPocketState,
          deps,
          toInt(deps.now(), 0),
        )
      : null;
    return {
      success: true,
      created: false,
      data: resolvedPocketState,
      readiness: existingMaterializationReadiness,
      suppressorRegistrationResults,
      effectEvaluationResult,
    };
  }

  if (environmentalEntries.length <= 0) {
    const nextRoomState = setPlaceholderRoomEntry(
      resolvedPocketState,
      roomIndex,
      {
        ...roomEntry,
        environmentalObjectItemIDs: [],
        environmentalObjectTypeIDs: [],
        environmentalObjectProfileIDs: [],
        environmentalObjectLifecycleState: "spawn_failed",
        environmentalObjectBlockReason: "ENVIRONMENT_PROFILE_EMPTY",
      },
    );
    return {
      success: false,
      skipped: true,
      partial: false,
      errorMsg: "ABYSSAL_ENVIRONMENT_PROFILE_EMPTY",
      data: updatePocketState(numericInstanceID, buildPocketStateForCurrentRoom(resolvedPocketState, nextRoomState)),
      readiness: existingMaterializationReadiness,
    };
  }

  const staleCleanupFailures = cleanupAbyssalEnvironmentalRepairArtifacts(
    resolvedPocketState, trackedItemIDs, deps,
  );
  if (staleCleanupFailures.length > 0) {
    const failedRoomState = setPlaceholderRoomEntry(
      resolvedPocketState,
      roomIndex,
      {
        ...roomEntry,
        environmentalObjectLifecycleState: "repair_failed",
        environmentalObjectBlockReason: "STALE_ENVIRONMENT_CLEANUP_FAILED",
      },
    );
    return {
      success: false,
      partial: true,
      errorMsg: "ABYSSAL_ENVIRONMENT_STALE_CLEANUP_FAILED",
      cleanupPendingItemIDs: staleCleanupFailures,
      data: updatePocketState(
        numericInstanceID,
        buildPocketStateForCurrentRoom(resolvedPocketState, failedRoomState),
      ),
    };
  }

  const materialization = materializeAbyssalEnvironmentalBatch(
    resolvedPocketState, roomIndex, roomEntry, environmentalEntries, session, deps, options,
  );
  const { createdItemIDs, createdTypeIDs, profileIDs, materializationErrors } = materialization;

  const exactCreatedComposition = Boolean(
    materializationErrors.length === 0 &&
    createdItemIDs.length === environmentalEntries.length &&
    createdTypeIDs.length === environmentalEntries.length &&
    profileIDs.length === environmentalEntries.length &&
    profileIDs.every((profileID, index) => profileID === expectedProfileIDs[index]) &&
    createdTypeIDs.every(
      (typeID, index) => typeID === toInt(environmentalEntries[index] && environmentalEntries[index].typeID, 0),
    )
  );
  if (!exactCreatedComposition) {
    return rollbackPartialAbyssalEnvironmentalMaterialization(
      resolvedPocketState, roomIndex, roomEntry, materialization, deps,
    );
  }

  return commitAbyssalEnvironmentalMaterialization(
    resolvedPocketState, roomIndex, roomEntry, roomState, materialization, deps, options,
  );
}

function evaluateEnvironmentalEffectsForPocketState({
  getDependencies,
  getActivePocketStateByInstanceID,
  getPocketScene,
  buildPlaceholderRoomState,
  clampRoomIndex,
  getPlaceholderRoomEntry,
  listExactAbyssalBoundaryCompanionEntities,
  listUniquePositiveInts,
  listPocketHostileEntityIDs,
  evaluateAbyssalEnvironmentalEffects,
  ensureBoundaryControllerForPocketState,
  log,
  setPlaceholderRoomEntry,
  updatePocketState,
  buildPocketStateForCurrentRoom,
},
  pocketState,
  deps = getDependencies(),
  nowMs = null,
  options = {},
) {
  const resolvedPocketState =
    pocketState && pocketState.instanceID
      ? getActivePocketStateByInstanceID(pocketState.instanceID) || pocketState
      : pocketState;
  const scene = getPocketScene(resolvedPocketState, deps);
  if (!resolvedPocketState || !scene || typeof scene.getEntityByID !== "function") {
    return {
      evaluated: 0,
      skipped: true,
      errorMsg: "SCENE_UNAVAILABLE",
    };
  }
  const roomState = buildPlaceholderRoomState(resolvedPocketState);
  const evaluatedRoomIndex = clampRoomIndex(
    toInt(options && options.roomIndex, roomState.currentRoomIndex),
    roomState.implementedRooms,
  );
  const roomEntry = getPlaceholderRoomEntry(resolvedPocketState, evaluatedRoomIndex);
  const environmentalCompanions = listExactAbyssalBoundaryCompanionEntities(
    resolvedPocketState,
    evaluatedRoomIndex,
    scene,
  );
  const candidateEntities = listUniquePositiveInts([
    resolvedPocketState.shipID,
    ...listPocketHostileEntityIDs(resolvedPocketState),
    ...environmentalCompanions.map((entity) => entity && entity.itemID),
  ])
    .map((entityID) => scene.getEntityByID(entityID))
    .filter(Boolean);
  const effectiveNowMs = nowMs == null ? toInt(deps.now(), 0) : toInt(nowMs, 0);
  const result = evaluateAbyssalEnvironmentalEffects({
    pocketState: resolvedPocketState,
    roomEntry,
    scene,
    nowMs: effectiveNowMs,
    candidateEntities,
  });
  const boundaryResult = ensureBoundaryControllerForPocketState(
    resolvedPocketState,
    deps,
    effectiveNowMs,
    options && options.boundaryOptions || {},
  );
  result.boundaryController = boundaryResult && boundaryResult.success
    ? boundaryResult.data || null
    : null;
  result.boundaryControllerError = boundaryResult && boundaryResult.success === false
    ? boundaryResult.errorMsg || "ABYSSAL_BOUNDARY_CONTROLLER_UNAVAILABLE"
    : null;
  if (
    result.appliedModifiers > 0 ||
    result.removedModifiers > 0 ||
    result.dogmaStateChanges > 0 ||
    result.unresolvedCollectionIDs.length > 0
  ) {
    const status = result.unresolvedCollectionIDs.length > 0 ? "failed" : "resolved";
    log.info(
      `[AbyssalEnvironmentalModifier] run=${toInt(resolvedPocketState.instanceID, 0)} ` +
        `room=${toInt(roomEntry.roomIndex, 0)} profile=localized-environment ` +
        `evaluated=${toInt(result.evaluated, 0)} candidates=${candidateEntities.length} ` +
        `applied=${toInt(result.appliedModifiers, 0)} removed=${toInt(result.removedModifiers, 0)} ` +
        `dogmaStateChanges=${toInt(result.dogmaStateChanges, 0)} ` +
        `unresolvedCollections=${result.unresolvedCollectionIDs.length > 0 ? result.unresolvedCollectionIDs.join(",") : "none"} ` +
        `status=${status}`,
    );
  }
  const nextRoomState = setPlaceholderRoomEntry(
    resolvedPocketState,
    evaluatedRoomIndex,
    {
      ...roomEntry,
      environmentalEffectLastEvaluatedAtMs: effectiveNowMs,
      environmentalEffectEvaluationCount: toInt(roomEntry.environmentalEffectEvaluationCount, 0) + 1,
    },
  );
  updatePocketState(resolvedPocketState.instanceID, buildPocketStateForCurrentRoom(resolvedPocketState, nextRoomState));
  return result;
}

// Capture supplied capabilities once, as the original closure did. Internal
// callbacks are bound once per instance; no runtime state lives in this wiring.
function createAbyssalEnvironmentObjects({
  cleanupSuppressorControllerByRuntimeEntity,
  getPocketScene,
  cleanupSuppressorPresentationStateByEntity,
  getDependencies,
  getActivePocketStateByInstanceID,
  evaluateAbyssalDirectCallbackTerminalGuard,
  buildAbyssalDirectCallbackSuppressedResult,
  listSuppressorControllersForRun,
  getSuppressorPresentationState,
  listSuppressorPresentationStatesForRun,
  getPlaceholderRoomEntry,
  listUniquePositiveInts,
  getAbyssalEnvironmentalDefinition,
  resolveSuppressorSceneKey,
  setPlaceholderRoomEntry,
  cloneValue,
  updatePocketState,
  buildPocketStateForCurrentRoom,
  ensureAbyssalPocketPersistenceReady,
  stopSuppressorPresentationsForPocketRun,
  listAuthoredAbyssalEnvironmentalEntries,
  listPositiveInts,
  getAbyssalSuppressorMechanicsProfileByTypeID,
  ENVIRONMENTAL_EFFECT_KIND,
  readEnvironmentalObjectStateFromItem,
  resolveExactAbyssalRunRoomScope,
  listExactAbyssalBoundaryCompanionEntities,
  getVectorDistance,
  buildPlaceholderRoomState,
  clampRoomIndex,
  ensureSuppressorControllersForRoom,
  destroyPlaceholderTrace,
  buildAbyssalSceneDescriptor,
  resolveAbyssalStructureType,
  buildEnvironmentalObjectSpawnState,
  resolvePlaceholderDurationMs,
  getContentProfile,
  buildEnvironmentalObjectCustomInfo,
  toReal,
  spawnPocketDynamicInventoryEntity,
  ABYSSAL_ROOM_DELIVERY_STATE,
  syncInventoryChanges,
  UNSTABLE_ABYSSAL_DEPTHS_BOUNDARY_PROFILE,
  listPocketHostileEntityIDs,
  evaluateAbyssalEnvironmentalEffects,
  ensureBoundaryControllerForPocketState,
  log,
}) {

  const ports = {
    cleanupSuppressorControllerByRuntimeEntity,
    getPocketScene,
    cleanupSuppressorPresentationStateByEntity,
    getDependencies,
    getActivePocketStateByInstanceID,
    evaluateAbyssalDirectCallbackTerminalGuard,
    buildAbyssalDirectCallbackSuppressedResult,
    listSuppressorControllersForRun,
    getSuppressorPresentationState,
    listSuppressorPresentationStatesForRun,
    getPlaceholderRoomEntry,
    listUniquePositiveInts,
    getAbyssalEnvironmentalDefinition,
    resolveSuppressorSceneKey,
    setPlaceholderRoomEntry,
    cloneValue,
    updatePocketState,
    buildPocketStateForCurrentRoom,
    ensureAbyssalPocketPersistenceReady,
    stopSuppressorPresentationsForPocketRun,
    listAuthoredAbyssalEnvironmentalEntries,
    listPositiveInts,
    getAbyssalSuppressorMechanicsProfileByTypeID,
    ENVIRONMENTAL_EFFECT_KIND,
    readEnvironmentalObjectStateFromItem,
    resolveExactAbyssalRunRoomScope,
    listExactAbyssalBoundaryCompanionEntities,
    getVectorDistance,
    buildPlaceholderRoomState,
    clampRoomIndex,
    ensureSuppressorControllersForRoom,
    destroyPlaceholderTrace,
    buildAbyssalSceneDescriptor,
    resolveAbyssalStructureType,
    buildEnvironmentalObjectSpawnState,
    resolvePlaceholderDurationMs,
    getContentProfile,
    buildEnvironmentalObjectCustomInfo,
    toReal,
    spawnPocketDynamicInventoryEntity,
    ABYSSAL_ROOM_DELIVERY_STATE,
    syncInventoryChanges,
    UNSTABLE_ABYSSAL_DEPTHS_BOUNDARY_PROFILE,
    listPocketHostileEntityIDs,
    evaluateAbyssalEnvironmentalEffects,
    ensureBoundaryControllerForPocketState,
    log,
  };
  ports.despawnAbyssalEnvironmentalObjectEntity = despawnAbyssalEnvironmentalObjectEntity.bind(null, ports);
  ports.settleAbyssalEnvironmentalObjectDestruction = settleAbyssalEnvironmentalObjectDestruction.bind(null, ports);
  ports.handleAbyssalEnvironmentalObjectDestroyed = handleAbyssalEnvironmentalObjectDestroyed.bind(null, ports);
  ports.buildAbyssalEnvironmentalMaterializationReadiness = buildAbyssalEnvironmentalMaterializationReadiness.bind(null, ports);
  ports.buildAbyssalEnvironmentalEffectReadiness = buildAbyssalEnvironmentalEffectReadiness.bind(null, ports);
  ports.materializeAbyssalEnvironmentalBatch = materializeAbyssalEnvironmentalBatch.bind(null, ports);
  ports.rollbackPartialAbyssalEnvironmentalMaterialization = rollbackPartialAbyssalEnvironmentalMaterialization.bind(null, ports);
  ports.commitAbyssalEnvironmentalMaterialization = commitAbyssalEnvironmentalMaterialization.bind(null, ports);
  ports.cleanupAbyssalEnvironmentalRepairArtifacts = cleanupAbyssalEnvironmentalRepairArtifacts.bind(null, ports);
  ports.buildAbyssalEnvironmentalSlotReadiness = buildAbyssalEnvironmentalSlotReadiness.bind(null, ports);
  ports.ensureAbyssalEnvironmentalObjects = ensureAbyssalEnvironmentalObjects.bind(null, ports);
  ports.evaluateEnvironmentalEffectsForPocketState = evaluateEnvironmentalEffectsForPocketState.bind(null, ports);
  Object.freeze(ports);
  return Object.freeze({
    despawnAbyssalEnvironmentalObjectEntity: ports.despawnAbyssalEnvironmentalObjectEntity,
    handleAbyssalEnvironmentalObjectDestroyed: ports.handleAbyssalEnvironmentalObjectDestroyed,
    buildAbyssalEnvironmentalMaterializationReadiness: ports.buildAbyssalEnvironmentalMaterializationReadiness,
    buildAbyssalEnvironmentalEffectReadiness: ports.buildAbyssalEnvironmentalEffectReadiness,
    ensureAbyssalEnvironmentalObjects: ports.ensureAbyssalEnvironmentalObjects,
    evaluateEnvironmentalEffectsForPocketState: ports.evaluateEnvironmentalEffectsForPocketState,
  });
}

module.exports = Object.freeze({ createAbyssalEnvironmentObjects });
