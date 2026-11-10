"use strict";

const {
  toFiniteNumber,
} = require("../../common/numbers");

const path = require("path");

const log = require(path.join(__dirname, "../../utils/logger"));
const spaceRuntime = require(path.join(__dirname, "../runtime"));
const worldData = require(path.join(__dirname, "../worldData"));
const spatialTrace = require(path.join(__dirname, "../../network/spatialTrace"));
const {
  ITEM_FLAGS,
  createSpaceItemForOwner,
  getItemMetadata,
  removeInventoryItem,
} = require(path.join(__dirname, "../../services/inventory/itemStore"));
const itemCustody = require(path.join(
  __dirname,
  "../../services/inventory/itemCustody",
));
const {
  getSpaceDebrisLifetimeMs,
} = require(path.join(__dirname, "../../services/inventory/spaceDebrisState"));
const {
  resolveItemByName,
  resolveItemByTypeID,
} = require(path.join(__dirname, "../../services/inventory/itemTypeRegistry"));
const {
  getTypeAttributeValue,
} = require(path.join(__dirname, "../../services/fitting/liveFittingState"));
const {
  getNpcLootTable,
} = require(path.join(__dirname, "./npcData"));
const {
  rollNpcLootEntries,
} = require(path.join(__dirname, "./npcLoot"));
const {
  getControllerByEntityID,
  unregisterController,
} = require(path.join(__dirname, "./npcRegistry"));
const nativeNpcStore = require(path.join(__dirname, "./nativeNpcStore"));
const {
  buildDunRotationFromDirection,
  resolveEntityWreckType,
} = require(path.join(__dirname, "../wreckUtils"));
const {
  buildChildEntityScopeMetadata,
  canEntitiesInteractLocally,
  resolveEntityInteractionScope,
} = require(path.join(__dirname, "../destiny/identity/interactionScope"));
const {
  LOOT_CUSTOM_INFO_KEY,
  LOOT_RIGHTS_SNAPSHOT_VERSION,
  buildSpaceLootRightsSnapshot,
} = require(path.join(
  __dirname,
  "../../services/_shared/spaceLootEntitlement",
));
const {
  getNpcEntityMissileWeaponSource,
} = require(path.join(__dirname, "./npcEquipment"));
const {
  isDestructibleNpcSentry,
  resolveNpcSentryAmmoNames,
  rollNpcSentryAmmoDrop,
} = require(path.join(__dirname, "./npcSentryPolicy"));
const DESTRUCTION_EFFECT_EXPLOSION = 3;
const NPC_SENTRY_AMMO_CONTAINER_TYPE_NAME = "Cargo Container";

function toPositiveInt(value, fallback = 0) {
  const numeric = Math.trunc(Number(value) || 0);
  return numeric > 0 ? numeric : fallback;
}

function cloneValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function cloneVector(vector, fallback = { x: 0, y: 0, z: 0 }) {
  return {
    x: toFiniteNumber(vector && vector.x, fallback.x),
    y: toFiniteNumber(vector && vector.y, fallback.y),
    z: toFiniteNumber(vector && vector.z, fallback.z),
  };
}

function hasExplicitOption(options, key) {
  return Boolean(
    options && Object.prototype.hasOwnProperty.call(options, key)
  );
}

function buildNativeRecordSceneDescriptor(record) {
  if (!record || typeof record !== "object") {
    return null;
  }
  const sceneKey = String(record.sceneKey || "").trim();
  const sceneKind = String(record.sceneKind || "").trim().toLowerCase();
  const hasAbyssalSceneSignal = Boolean(
    sceneKind === "abyssal" || sceneKey.startsWith("abyssal-run:")
  );
  if (hasAbyssalSceneSignal) {
    return spaceRuntime.normalizeSceneDescriptor({
      sceneKind: "abyssal",
      sceneKey: sceneKey || undefined,
      instanceID: toPositiveInt(
        record.instanceID,
        toPositiveInt(
          record.abyssalRunID,
          toPositiveInt(
            record.evejsAbyssalInstanceID,
            toPositiveInt(record.evejsAbyssalPocketInstanceID, 0),
          ),
        ),
      ),
      locationID: toPositiveInt(
        record.locationID,
        toPositiveInt(record.systemID, 0),
      ),
      sourceSolarSystemID: toPositiveInt(record.sourceSolarSystemID, 0),
    });
  }

  const systemID = toPositiveInt(
    record.systemID,
    toPositiveInt(record.locationID, 0),
  );
  if (systemID <= 0) {
    return null;
  }
  return spaceRuntime.normalizeSceneDescriptor({
    sceneKind: "solarSystem",
    sceneKey: sceneKey || undefined,
    solarSystemID: systemID,
    locationID: systemID,
  });
}

function resolveNativeWreckScene(wreckRecord, options = {}) {
  const recordDescriptor = buildNativeRecordSceneDescriptor(wreckRecord);
  const resolveDescriptorScene = (rawDescriptor) => {
    const descriptor = spaceRuntime.normalizeSceneDescriptor(rawDescriptor);
    if (!descriptor) {
      return null;
    }
    if (
      recordDescriptor &&
      descriptor.sceneKey !== recordDescriptor.sceneKey
    ) {
      return null;
    }
    const existing = spaceRuntime.getSceneByDescriptor(descriptor);
    if (existing) {
      return existing;
    }
    // Private scenes are lifecycle-owned by the active Abyssal run. A wreck
    // record must never recreate an orphaned run scene on its own.
    return descriptor.sceneKind === "abyssal"
      ? null
      : spaceRuntime.ensureScene(descriptor);
  };

  if (hasExplicitOption(options, "scene")) {
    const scene = options.scene;
    if (!scene || !scene.sceneDescriptor) {
      return null;
    }
    return resolveDescriptorScene(scene.sceneDescriptor) === scene
      ? scene
      : null;
  }
  if (hasExplicitOption(options, "sceneDescriptor")) {
    return resolveDescriptorScene(options.sceneDescriptor);
  }
  if (recordDescriptor) {
    return resolveDescriptorScene(recordDescriptor);
  }
  return null;
}

function resolveNativeNpcDestructionScene(systemID, shipEntity, options = {}) {
  const entityID = toPositiveInt(shipEntity && shipEntity.itemID, 0);
  const containsExactEntity = (scene) => Boolean(
    scene &&
    entityID > 0 &&
    typeof scene.getEntityByID === "function" &&
    scene.getEntityByID(entityID) === shipEntity
  );

  if (hasExplicitOption(options, "scene")) {
    return containsExactEntity(options.scene) ? options.scene : null;
  }
  if (hasExplicitOption(options, "sceneDescriptor")) {
    const scene = options.sceneDescriptor
      ? spaceRuntime.getSceneByDescriptor(options.sceneDescriptor)
      : null;
    return containsExactEntity(scene) ? scene : null;
  }

  const entityDescriptor = buildNativeRecordSceneDescriptor(shipEntity);
  if (entityDescriptor) {
    const scene = spaceRuntime.getSceneByDescriptor(entityDescriptor);
    if (containsExactEntity(scene)) {
      return scene;
    }
    if (entityDescriptor.sceneKind === "abyssal") {
      return null;
    }
  }
  const discoveredScene = typeof spaceRuntime.findSceneContainingDynamicEntity === "function"
    ? spaceRuntime.findSceneContainingDynamicEntity(entityID)
    : null;
  if (containsExactEntity(discoveredScene)) {
    return discoveredScene;
  }
  const numericScene = spaceRuntime.ensureScene(toPositiveInt(systemID, 0));
  return containsExactEntity(numericScene) ? numericScene : null;
}

function resolveNativeWreckScopeMetadata(wreckRecord, runtimeEntity = null) {
  const nativeScopeResolution = nativeNpcStore.resolveStoredEntityScopeMetadata(
    runtimeEntity ? [wreckRecord, runtimeEntity] : [wreckRecord],
    { projectAirInstanceToDungeonSite: true },
  );
  if (!nativeScopeResolution.success) {
    return nativeScopeResolution;
  }
  const recordInteractionScope = resolveEntityInteractionScope(wreckRecord);
  const runtimeInteractionScope = runtimeEntity
    ? resolveEntityInteractionScope(runtimeEntity)
    : null;
  if (
    !recordInteractionScope.valid ||
    runtimeInteractionScope && !runtimeInteractionScope.valid ||
    runtimeEntity && !canEntitiesInteractLocally(wreckRecord, runtimeEntity)
  ) {
    return {
      success: false,
      errorMsg: "NPC_PRIVATE_SCOPE_INVALID",
    };
  }
  return {
    success: true,
    errorMsg: null,
    data: {
      metadata: {
        ...nativeScopeResolution.data.metadata,
        ...buildChildEntityScopeMetadata(wreckRecord),
      },
    },
  };
}

function normalizeWreckSingleton(value) {
  if (Number(value) === 2) return 2;
  return value === true || Number(value) === 1;
}

function buildNativeWreckRuntimeEntity(wreckRecord, options = {}) {
  const scopeResolution = resolveNativeWreckScopeMetadata(wreckRecord);
  if (!scopeResolution.success) {
    return null;
  }
  const entityScopeMetadata = scopeResolution.data.metadata;
  const wreckItemRecord = nativeNpcStore.buildNativeWreckInventoryItem(
    wreckRecord && wreckRecord.wreckID,
  );
  if (!wreckItemRecord) {
    return null;
  }

  const entity = spaceRuntime.buildRuntimeSpaceEntityFromItemRecord(
    wreckItemRecord,
    toPositiveInt(wreckRecord && wreckRecord.systemID, 0),
    toFiniteNumber(options.nowMs, Date.now()),
    { entityScopeMetadata },
  );
  if (!entity) {
    return null;
  }

  entity.persistSpaceState = false;
  entity.lastPersistAt = 0;
  entity.spaceState = cloneValue(wreckItemRecord.spaceState || entity.spaceState || null);
  entity.conditionState = cloneValue(
    wreckItemRecord.conditionState || entity.conditionState || null,
  );
  entity.createdAtMs = toFiniteNumber(wreckRecord && wreckRecord.createdAtMs, 0) || null;
  entity.expiresAtMs = toFiniteNumber(wreckRecord && wreckRecord.expiresAtMs, 0) || null;
  entity.isEmpty =
    nativeNpcStore.listNativeWreckItemsForWreck(
      toPositiveInt(wreckRecord && wreckRecord.wreckID, 0),
    ).length === 0;
  entity.launcherID = toPositiveInt(wreckRecord && wreckRecord.launcherID, 0) || null;
  const sourceTypeID = toPositiveInt(wreckRecord && wreckRecord.sourceTypeID, 0);
  if (sourceTypeID > 0) {
    entity.nameID = [
      "UI/Inflight/WreckNameTypeID",
      {
        WreckTypeID: sourceTypeID,
      },
    ];
  }
  entity.corporationID = toPositiveInt(wreckRecord && wreckRecord.corporationID, 0);
  entity.allianceID = toPositiveInt(wreckRecord && wreckRecord.allianceID, 0);
  entity.warFactionID = toPositiveInt(wreckRecord && wreckRecord.warFactionID, 0);
  entity.securityStatus = toFiniteNumber(wreckRecord && wreckRecord.securityStatus, 0);
  entity.lootRightCorpID = toPositiveInt(
    wreckRecord && wreckRecord.lootRightCorpID,
    toPositiveInt(wreckRecord && wreckRecord.corporationID, 0),
  );
  entity.lootRightsSnapshotVersion = toPositiveInt(
    wreckRecord && wreckRecord.lootRightsSnapshotVersion,
    0,
  );
  entity.lootRightFleetID = toPositiveInt(
    wreckRecord && wreckRecord.lootRightFleetID,
    0,
  ) || null;
  entity.lootAbandoned = Boolean(
    wreckRecord && wreckRecord.lootAbandoned === true,
  );
  entity.dunRotation =
    Array.isArray(wreckRecord && wreckRecord.dunRotation)
      ? cloneValue(wreckRecord.dunRotation)
      : null;
  entity.nativeNpcWreck = true;
  if (typeof spaceRuntime.applyRuntimeEntityScopeMetadata === "function") {
    spaceRuntime.applyRuntimeEntityScopeMetadata(entity, entityScopeMetadata);
  }
  entity.transient = wreckRecord && wreckRecord.transient === true;
  if (wreckRecord && wreckRecord.salvaged === true) {
    entity.kind = "container";
    entity.salvaged = true;
    entity.salvageComplete = true;
  }
  return entity;
}

function buildNativeWreckItemRecord(wreckRecord, itemType, options = {}) {
  const singleton = normalizeWreckSingleton(options.singleton);
  const quantity = singleton ? 1 : Math.max(1, toPositiveInt(options.quantity, 1));
  const metadata = getItemMetadata(itemType && itemType.typeID, itemType && itemType.name);
  const wreckItemIDResult = nativeNpcStore.allocateWreckItemID({
    transient: wreckRecord.transient === true,
  });
  if (!wreckItemIDResult.success || !wreckItemIDResult.data) {
    return wreckItemIDResult;
  }

  return {
    success: true,
    data: {
      wreckItemID: wreckItemIDResult.data,
      wreckID: wreckRecord.wreckID,
      ownerID: wreckRecord.ownerID,
      locationID: wreckRecord.wreckID,
      flagID: ITEM_FLAGS.HANGAR,
      typeID: toPositiveInt(itemType && itemType.typeID, 0),
      groupID: toPositiveInt(metadata && metadata.groupID, 0),
      categoryID: toPositiveInt(metadata && metadata.categoryID, 0),
      itemName: String(itemType && itemType.name || metadata && metadata.name || "Item"),
      quantity,
      singleton,
      customInfo: "",
      moduleState: options.moduleState ? cloneValue(options.moduleState) : null,
      ...(options.blueprintState ? { blueprintState: cloneValue(options.blueprintState) } : {}),
      sourceKind: String(options.sourceKind || "loot"),
      moduleID: toPositiveInt(options.moduleID, 0),
      volume: toFiniteNumber(metadata && metadata.volume, 0),
      transient: wreckRecord.transient === true,
    },
  };
}

function buildNativeLootWreckItems(wreckRecord, lootEntries) {
  const items = [];
  for (const lootEntry of lootEntries) {
    const copyCount = lootEntry.singleton === 2 ? lootEntry.quantity : 1;
    for (let index = 0; index < copyCount; index += 1) {
      const result = buildNativeWreckItemRecord(wreckRecord, lootEntry.itemType, {
        quantity: lootEntry.quantity,
        singleton: lootEntry.singleton,
        blueprintState: lootEntry.blueprintStates && lootEntry.blueprintStates[index] || lootEntry.blueprintState,
        sourceKind: "loot",
      });
      if (!result.success || !result.data) return result;
      items.push(result.data);
    }
  }
  return { success: true, data: items };
}

function refreshNativeWreckRuntimeEntity(systemID, wreckID, options = {}) {
  const normalizedSystemID = toPositiveInt(systemID, 0);
  const normalizedWreckID = toPositiveInt(wreckID, 0);
  if (!normalizedSystemID || !normalizedWreckID) {
    return {
      success: false,
      errorMsg: "WRECK_NOT_FOUND",
    };
  }

  const wreckRecord = nativeNpcStore.getNativeWreck(normalizedWreckID);
  if (!wreckRecord) {
    return {
      success: false,
      errorMsg: "WRECK_NOT_FOUND",
    };
  }
  const scopeResolution = resolveNativeWreckScopeMetadata(wreckRecord);
  if (!scopeResolution.success) {
    return {
      success: false,
      errorMsg: scopeResolution.errorMsg,
    };
  }

  const scene = resolveNativeWreckScene(wreckRecord, options);
  const entity = scene ? scene.getEntityByID(normalizedWreckID) : null;
  if (!scene || !entity) {
    return {
      success: false,
      errorMsg: "WRECK_NOT_FOUND",
    };
  }
  const runtimeScopeResolution = resolveNativeWreckScopeMetadata(
    wreckRecord,
    entity,
  );
  if (!runtimeScopeResolution.success) {
    return {
      success: false,
      errorMsg: runtimeScopeResolution.errorMsg,
    };
  }
  const entityScopeMetadata = runtimeScopeResolution.data.metadata;

  entity.itemName = String(wreckRecord.itemName || entity.itemName || "Wreck");
  entity.isEmpty = nativeNpcStore.listNativeWreckItemsForWreck(normalizedWreckID).length === 0;
  entity.lootAbandoned = wreckRecord.lootAbandoned === true;
  if (typeof spaceRuntime.applyRuntimeEntityScopeMetadata === "function") {
    spaceRuntime.applyRuntimeEntityScopeMetadata(entity, entityScopeMetadata);
  }
  if (options.broadcast === true) {
    scene.broadcastSlimItemChanges([entity]);
  }

  return {
    success: true,
    data: {
      scene,
      entity,
      wreckRecord,
    },
  };
}

function spawnNativeWreck(systemID, wreckID, options = {}) {
  const wreckRecord = nativeNpcStore.getNativeWreck(wreckID);
  if (!wreckRecord) {
    return {
      success: false,
      errorMsg: "WRECK_NOT_FOUND",
    };
  }
  const scopeResolution = resolveNativeWreckScopeMetadata(wreckRecord);
  if (!scopeResolution.success) {
    return {
      success: false,
      errorMsg: scopeResolution.errorMsg,
    };
  }

  const scene = resolveNativeWreckScene(wreckRecord, options);
  if (!scene) {
    return {
      success: false,
      errorMsg: "SCENE_NOT_FOUND",
    };
  }

  const existingEntity = scene.getEntityByID(wreckRecord.wreckID);
  if (existingEntity && existingEntity.nativeNpcWreck === true) {
    return refreshNativeWreckRuntimeEntity(scene.systemID, wreckRecord.wreckID, {
      ...options,
      scene,
    });
  }

  const entity = buildNativeWreckRuntimeEntity(wreckRecord, {
    nowMs:
      typeof scene.getCurrentSimTimeMs === "function"
        ? scene.getCurrentSimTimeMs()
        : Date.now(),
  });
  if (!entity) {
    return {
      success: false,
      errorMsg: "WRECK_BUILD_FAILED",
    };
  }
  const spawnOptions = {
    ...options,
  };
  const broadcastOptions =
    options.broadcastOptions && typeof options.broadcastOptions === "object"
      ? { ...options.broadcastOptions }
      : {};
  if (broadcastOptions.freshAcquire === undefined) {
    // Native NPC wrecks are the follow-on to an already visible explosion /
    // RemoveBalls handoff, just like the player-ship /deathtest path. Using the
    // lighter immediate lane avoids bootstrap-acquire backsteps that make the
    // wreck disappear until the next full scene refresh.
    broadcastOptions.freshAcquire = false;
  }
  if (Object.keys(broadcastOptions).length > 0) {
    spawnOptions.broadcastOptions = broadcastOptions;
  }
  return scene.spawnDynamicEntity(entity, spawnOptions);
}

function restoreMiningCargoWrecksForScene(scene) {
  let restored = 0;
  const nowMs = Math.max(Date.now(), Number(scene?.getCurrentSimTimeMs?.() || 0));
  for (const record of nativeNpcStore.listNativeWrecks()) {
    if (!record.miningCargoTransferKey || Number(record.systemID) !== Number(scene?.systemID)) continue;
    const descriptor = buildNativeRecordSceneDescriptor(record);
    if (!descriptor || descriptor.sceneKey !== scene.sceneKey) continue;
    if (Number(record.expiresAtMs) <= nowMs) {
      const removed = nativeNpcStore.removeNativeWreckCascade(record.wreckID);
      if (!removed.success) return removed;
      continue;
    }
    const result = spawnNativeWreck(scene.systemID, record.wreckID, { scene, broadcast: false });
    if (!result.success) return result;
    restored++;
  }
  return { success: true, restored };
}

function destroyNativeWreck(wreckID, options = {}) {
  const wreckRecord = nativeNpcStore.getNativeWreck(wreckID);
  if (!wreckRecord) {
    return {
      success: false,
      errorMsg: "WRECK_NOT_FOUND",
    };
  }

  const scene = resolveNativeWreckScene(wreckRecord, options);
  const runtimeEntity = scene ? scene.getEntityByID(wreckRecord.wreckID) : null;
  if (scene && runtimeEntity) {
    const removeResult = spaceRuntime.removeDynamicEntity(
      scene.sceneDescriptor || scene.systemID,
      wreckRecord.wreckID,
      {
        sceneDescriptor: scene.sceneDescriptor || undefined,
        allowSessionOwned: true,
        broadcast: options.broadcast === true,
        excludedSession: options.excludedSession || null,
        nowMs: options.nowMs,
      },
    );
    if (!removeResult.success) {
      return removeResult;
    }
  } else if (
    (hasExplicitOption(options, "scene") || hasExplicitOption(options, "sceneDescriptor")) &&
    !scene
  ) {
    return {
      success: false,
      errorMsg: "SCENE_NOT_FOUND",
    };
  }
  nativeNpcStore.removeNativeWreckCascade(wreckRecord.wreckID);
  return {
    success: true,
    data: {
      wreckID: wreckRecord.wreckID,
    },
  };
}

function transferNativeWreckItemToCharacterLocation(options = {}) {
  const characterID = toPositiveInt(options.characterID, 0);
  const wreckID = toPositiveInt(options.wreckID, 0);
  const wreckItemID = toPositiveInt(options.wreckItemID, 0);
  const destinationLocationID = toPositiveInt(options.destinationLocationID, 0);
  const destinationFlagID = toPositiveInt(options.destinationFlagID, ITEM_FLAGS.HANGAR);
  if (!characterID || !wreckID || !wreckItemID || !destinationLocationID) {
    return {
      success: false,
      errorMsg: "ITEM_NOT_FOUND",
    };
  }

  const transferResult = itemCustody.transfer({
    items: {
      itemID: wreckItemID,
      quantity: options.quantity,
    },
    from: itemCustody.custodyRef.nativeWreck(wreckID),
    to: itemCustody.custodyRef.ownerLocation(
      characterID,
      destinationLocationID,
      destinationFlagID,
    ),
    reason: itemCustody.CUSTODY_REASON.NATIVE_WRECK_LOOT,
    actor: characterID,
    idempotencyKey: options.idempotencyKey,
  });
  if (!transferResult.success) {
    return transferResult;
  }

  const wreckRecord = nativeNpcStore.getNativeWreck(wreckID);
  if (wreckRecord) {
    refreshNativeWreckRuntimeEntity(wreckRecord.systemID, wreckRecord.wreckID);
  }
  return transferResult;
}

function resolveNpcSentryAmmoCandidates(shipEntity) {
  const missileSource = getNpcEntityMissileWeaponSource(shipEntity);
  const missileType = missileSource
    ? resolveItemByTypeID(missileSource.chargeTypeID)
    : null;
  const candidateNames = resolveNpcSentryAmmoNames(shipEntity, {
    missileGroupName: missileType && missileType.groupName,
    optimalSigRadius: getTypeAttributeValue(
      shipEntity && shipEntity.typeID,
      "optimalSigRadius",
    ),
  });
  const candidates = candidateNames
    .map((itemName) => resolveItemByName(itemName))
    .filter((resolution) => resolution && resolution.success && resolution.match)
    .map((resolution) => resolution.match);
  if (candidates.length > 0 || !missileType) {
    return candidates;
  }
  // Event and advanced launchers do not always have four standard damage-name
  // siblings. Their loaded SDE charge remains authoritative and compatible.
  return [missileType];
}

function buildNpcSentryAmmoContainerCustomInfo(shipEntity, options = {}) {
  return JSON.stringify({
    [LOOT_CUSTOM_INFO_KEY]: buildSpaceLootRightsSnapshot({
      corporationID: toPositiveInt(
        options.corporationID,
        toPositiveInt(shipEntity && shipEntity.corporationID, 0),
      ),
      lootRightCorpID: toPositiveInt(
        options.corporationID,
        toPositiveInt(shipEntity && shipEntity.corporationID, 0),
      ),
      allianceID: toPositiveInt(
        options.allianceID,
        toPositiveInt(shipEntity && shipEntity.allianceID, 0),
      ),
      warFactionID: toPositiveInt(
        options.warFactionID,
        toPositiveInt(shipEntity && shipEntity.warFactionID, 0),
      ),
      fleetID: toPositiveInt(options.fleetID, 0),
    }),
  });
}

function createNpcSentryAmmoContainer(scene, shipEntity, ammoType, options = {}) {
  const containerResolution = resolveItemByName(NPC_SENTRY_AMMO_CONTAINER_TYPE_NAME);
  const containerType = containerResolution && containerResolution.success
    ? containerResolution.match
    : null;
  const ownerID = toPositiveInt(
    options.ownerCharacterID || options.characterID || options.killerCharacterID,
    toPositiveInt(shipEntity && shipEntity.ownerID, 0),
  );
  if (!scene || !shipEntity || !ammoType || !containerType || ownerID <= 0) {
    return null;
  }

  const nowMs = scene.getCurrentSimTimeMs();
  const createResult = createSpaceItemForOwner(
    ownerID,
    scene.systemID,
    containerType,
    {
      itemName: NPC_SENTRY_AMMO_CONTAINER_TYPE_NAME,
      customInfo: buildNpcSentryAmmoContainerCustomInfo(shipEntity, options),
      position: cloneVector(shipEntity.position),
      velocity: { x: 0, y: 0, z: 0 },
      direction: cloneVector(shipEntity.direction, { x: 1, y: 0, z: 0 }),
      targetPoint: cloneVector(shipEntity.position),
      mode: "STOP",
      speedFraction: 0,
      createdAtMs: nowMs,
      expiresAtMs: nowMs + getSpaceDebrisLifetimeMs(),
      transient: shipEntity.transient === true,
    },
  );
  const container = createResult && createResult.success ? createResult.data : null;
  if (!container) {
    return null;
  }

  // Minted through item custody like every other owner-changing move in this
  // file. The reason is not durable, so this is the same owner grant as before.
  const ammoResult = itemCustody.transfer({
    items: {
      itemType: ammoType,
      quantity: 100,
      options: {
        singleton: false,
        transient: shipEntity.transient === true,
      },
    },
    to: itemCustody.custodyRef.ownerLocation(ownerID, container.itemID, 0),
    reason: itemCustody.CUSTODY_REASON.NPC_SENTRY_AMMO_DROP,
    actor: ownerID,
    idempotencyKey: `npc-sentry-ammo:${container.itemID}`,
  });
  if (!ammoResult || ammoResult.success !== true) {
    removeInventoryItem(container.itemID, { removeContents: true });
    return null;
  }

  const spawnResult = spaceRuntime.spawnDynamicInventoryEntity(
    scene.sceneDescriptor || scene.systemID,
    container.itemID,
    {
      sceneDescriptor: scene.sceneDescriptor || undefined,
      broadcast: false,
    },
  );
  const entity = spawnResult && spawnResult.success && spawnResult.data
    ? spawnResult.data.entity
    : null;
  if (!entity) {
    removeInventoryItem(container.itemID, { removeContents: true });
    return null;
  }
  if (typeof spaceRuntime.applyRuntimeEntityScopeMetadata === "function") {
    spaceRuntime.applyRuntimeEntityScopeMetadata(
      entity,
      buildChildEntityScopeMetadata(shipEntity),
    );
  }
  entity.lootRightCorpID = toPositiveInt(
    options.corporationID,
    toPositiveInt(shipEntity.corporationID, 0),
  );
  entity.lootRightFleetID = toPositiveInt(options.fleetID, 0) || null;
  entity.lootRightsSnapshotVersion = LOOT_RIGHTS_SNAPSHOT_VERSION;
  entity.lootAbandoned = false;
  scene.broadcastAddBalls([entity], null, { freshAcquire: true });
  return {
    container,
    entity,
    ammoType,
    quantity: 100,
  };
}

function notifyDungeonEncounterEntityDestroyed(scene, shipEntity, nowMs) {
  try {
    const dungeonUniverseSiteService = require(path.join(
      __dirname,
      "../../services/dungeon/dungeonUniverseSiteService",
    ));
    if (
      dungeonUniverseSiteService &&
      typeof dungeonUniverseSiteService.handleEncounterEntityDestroyed === "function"
    ) {
      dungeonUniverseSiteService.handleEncounterEntityDestroyed(scene, shipEntity, {
        nowMs,
      });
    }
  } catch (error) {
    // Dungeon progression is best-effort; destruction must still complete.
    log.debug(`[NativeNpcWreck] dungeon progression for destroyed entity ${shipEntity && shipEntity.itemID} failed: ${error && error.message}`);
  }
}

function destroyNativeNpcSentryEntity(systemID, shipEntity, options = {}) {
  const scene = resolveNativeNpcDestructionScene(systemID, shipEntity, options);
  if (!scene) {
    return {
      success: false,
      errorMsg: "SHIP_SCENE_NOT_FOUND",
    };
  }
  const nowMs = scene.getCurrentSimTimeMs();
  const ammoCandidates = resolveNpcSentryAmmoCandidates(shipEntity);
  const drop = rollNpcSentryAmmoDrop(shipEntity, {
    ammoNames: ammoCandidates.map((entry) => entry.name),
    random: options.random,
    chance: options.sentryAmmoDropChance,
  });
  const ammoType = drop
    ? ammoCandidates.find((entry) => entry.name === drop.itemName) || null
    : null;
  const nativeNpcService = require(path.join(__dirname, "./nativeNpcService"));
  const destroyResult = nativeNpcService.destroyNativeNpcController({
    entityID: shipEntity.itemID,
    itemID: shipEntity.itemID,
    systemID,
  }, {
    ...options,
    scene,
    sceneDescriptor: scene.sceneDescriptor || options.sceneDescriptor,
    broadcast: true,
    suppressWreck: true,
  });
  if (!destroyResult || destroyResult.success !== true) {
    return destroyResult || {
      success: false,
      errorMsg: "NPC_NOT_FOUND",
    };
  }

  const ammoDrop = ammoType
    ? createNpcSentryAmmoContainer(scene, shipEntity, ammoType, options)
    : null;
  notifyDungeonEncounterEntityDestroyed(scene, shipEntity, nowMs);
  return {
    success: true,
    data: {
      ...(destroyResult.data || {}),
      shipID: toPositiveInt(shipEntity.itemID, 0),
      wreck: null,
      wreckSuppressed: true,
      nativeNpc: true,
      sentry: true,
      ammoDrop: ammoDrop
        ? {
            containerID: ammoDrop.container.itemID,
            typeID: ammoDrop.ammoType.typeID,
            itemName: ammoDrop.ammoType.name,
            quantity: ammoDrop.quantity,
          }
        : null,
      lootOutcome: {
        items: ammoDrop
          ? [{
              typeID: ammoDrop.ammoType.typeID,
              itemName: ammoDrop.ammoType.name,
              quantity: ammoDrop.quantity,
            }]
          : [],
      },
      changes: [],
    },
  };
}

function destroyNativeNpcEntityWithWreck(systemID, shipEntity, options = {}) {
  const normalizedSystemID = toPositiveInt(systemID, 0);
  const entityID = toPositiveInt(shipEntity && shipEntity.itemID, 0);
  if (!normalizedSystemID || !entityID || !shipEntity || shipEntity.kind !== "ship") {
    return {
      success: false,
      errorMsg: "SHIP_NOT_FOUND",
    };
  }
  if (isDestructibleNpcSentry(shipEntity)) {
    return destroyNativeNpcSentryEntity(normalizedSystemID, shipEntity, options);
  }

  const recoveredMining = require("../../services/mining/miningCargoCommits").reconcileActor(entityID);
  if (!recoveredMining.success) return recoveredMining;
  const previousMiningTransfer = nativeNpcStore.getMiningCargoWreckTransfer(entityID, shipEntity.transient === true);
  if (previousMiningTransfer) {
    const recovered = nativeNpcStore.commitMiningCargoWreckTransfer({ entityID, transient: shipEntity.transient === true });
    if (!recovered.success) return recovered;
    const scene = resolveNativeNpcDestructionScene(normalizedSystemID, shipEntity, options);
    if (!scene) return { success: false, errorMsg: "SHIP_SCENE_NOT_FOUND" };
    if (scene.getEntityByID(entityID)) spaceRuntime.removeDynamicEntity(scene.sceneDescriptor || normalizedSystemID, entityID, { allowSessionOwned: false });
    unregisterController(entityID);
    if (!scene.getEntityByID(recovered.data.wreck.wreckID)) {
      const spawned = spawnNativeWreck(normalizedSystemID, recovered.data.wreck.wreckID, { scene });
      if (!spawned.success) return spawned;
    }
    return { success: true, duplicate: true, data: { wreck: recovered.data.wreck, shipID: entityID,
      wreckItems: nativeNpcStore.listNativeWreckItemsForWreck(recovered.data.wreck.wreckID) } };
  }
  const miningCargoRows = nativeNpcStore.listNativeCargoForEntity(entityID).filter(row => row.miningRevision > 0);
  const hasMiningCargo = miningCargoRows.length > 0;
  const nativeEntityRecord = nativeNpcStore.getNativeEntity(entityID);
  const wreckType = resolveEntityWreckType({
    nativeNpc: true,
    profileID: nativeEntityRecord && nativeEntityRecord.profileID,
    shipTypeID: shipEntity && shipEntity.typeID,
    itemName: shipEntity && shipEntity.itemName,
    groupName: nativeEntityRecord && nativeEntityRecord.slimGroupName,
    classID:
      (nativeEntityRecord && nativeEntityRecord.capitalClassID) ||
      (shipEntity && shipEntity.capitalClassID),
    factionName: nativeEntityRecord && nativeEntityRecord.factionName,
    npcEntityType: nativeEntityRecord && nativeEntityRecord.npcEntityType,
    capitalNpc:
      (nativeEntityRecord && nativeEntityRecord.capitalNpc === true) ||
      (shipEntity && shipEntity.capitalNpc === true),
  });
  if (!wreckType) {
    return {
      success: false,
      errorMsg: "WRECK_TYPE_NOT_FOUND",
    };
  }
  const scopeResolution = nativeNpcStore.resolveStoredEntityScopeMetadata(
    [nativeEntityRecord, shipEntity],
    { projectAirInstanceToDungeonSite: true },
  );
  if (!scopeResolution.success) {
    return {
      success: false,
      errorMsg: scopeResolution.errorMsg,
    };
  }

  const interactionScope = resolveEntityInteractionScope(shipEntity);
  if (!interactionScope.valid) {
    return {
      success: false,
      errorMsg: "NPC_PRIVATE_SCOPE_INVALID",
    };
  }

  const scene = resolveNativeNpcDestructionScene(
    normalizedSystemID,
    shipEntity,
    options,
  );
  if (!scene) {
    return {
      success: false,
      errorMsg: "SHIP_SCENE_NOT_FOUND",
    };
  }

  const nowMs = scene.getCurrentSimTimeMs();
  const controller = getControllerByEntityID(entityID);
  let destroyedFighterCount = 0;
  if (
    scene &&
    controller &&
    Array.isArray(
      controller.behaviorProfile &&
      controller.behaviorProfile.capitalFighterWingTypeIDs,
    )
  ) {
    const {
      resetNpcSupercarrierWing,
    } = require(path.join(
      __dirname,
      "../../services/fighter/npc/npcSupercarrierDirector",
    ));
    const cleanupResult = resetNpcSupercarrierWing(
      scene,
      shipEntity,
      controller,
      {
        removeContents: options.removeContents !== false,
      },
    );
    destroyedFighterCount = Number(
      cleanupResult &&
      cleanupResult.success &&
      cleanupResult.data &&
      cleanupResult.data.destroyedCount,
    ) || 0;
  }
  const wreckIDResult = nativeNpcStore.allocateWreckID({
    transient: shipEntity.transient === true && !hasMiningCargo,
  });
  if (!wreckIDResult.success || !wreckIDResult.data) {
    return wreckIDResult;
  }
  const entityScopeMetadata = {
    ...scopeResolution.data.metadata,
    ...buildChildEntityScopeMetadata(shipEntity),
  };
  const sceneDescriptor = scene.sceneDescriptor || null;

  let wreckRecord = {
    wreckID: wreckIDResult.data,
    sourceEntityID: entityID,
    systemID: normalizedSystemID,
    sceneKey: String(scene.sceneKey || ""),
    sceneKind: String(scene.sceneKind || ""),
    instanceID: toPositiveInt(scene.instanceID, 0),
    locationID: toPositiveInt(scene.locationID, normalizedSystemID),
    sourceSolarSystemID: toPositiveInt(scene.sourceSolarSystemID, 0),
    instanceScope: scene.sceneKind === "abyssal" ? "abyssal" : undefined,
    profileID: nativeEntityRecord && nativeEntityRecord.profileID || null,
    loadoutID: nativeEntityRecord && nativeEntityRecord.loadoutID || null,
    lootTableID: nativeEntityRecord && nativeEntityRecord.lootTableID || null,
    npcEntityType: nativeEntityRecord && nativeEntityRecord.npcEntityType || null,
    typeID: toPositiveInt(wreckType.typeID, 0),
    groupID: toPositiveInt(wreckType.groupID, 0),
    categoryID: toPositiveInt(wreckType.categoryID, 0),
    itemName: String(wreckType.name || "Wreck"),
    sourceTypeID: toPositiveInt(
      shipEntity && shipEntity.slimTypeID,
      toPositiveInt(shipEntity && shipEntity.typeID, 0),
    ),
    ownerID: toPositiveInt(
      options.ownerCharacterID ||
        options.characterID ||
        options.killerCharacterID,
      toPositiveInt(shipEntity.ownerID, 0),
    ),
    corporationID: toPositiveInt(
      options.corporationID,
      toPositiveInt(shipEntity.corporationID, 0),
    ),
    allianceID: toPositiveInt(
      options.allianceID,
      toPositiveInt(shipEntity.allianceID, 0),
    ),
    warFactionID: toPositiveInt(
      options.warFactionID,
      toPositiveInt(shipEntity.warFactionID, 0),
    ),
    securityStatus: toFiniteNumber(shipEntity.securityStatus, 0),
    lootRightCorpID: toPositiveInt(
      options.corporationID,
      toPositiveInt(shipEntity.corporationID, 0),
    ),
    lootRightsSnapshotVersion: LOOT_RIGHTS_SNAPSHOT_VERSION,
    lootRightFleetID: toPositiveInt(options.fleetID, 0) || null,
    lootAbandoned: false,
    position: cloneVector(shipEntity.position),
    velocity: { x: 0, y: 0, z: 0 },
    direction: cloneVector(shipEntity.direction, { x: 1, y: 0, z: 0 }),
    targetPoint: cloneVector(shipEntity.position),
    mode: "STOP",
    speedFraction: 0,
    radius: Math.max(0, toFiniteNumber(shipEntity.radius, 0)),
    createdAtMs: nowMs,
    expiresAtMs: nowMs + getSpaceDebrisLifetimeMs(),
    launcherID: entityID,
    dunRotation: buildDunRotationFromDirection(shipEntity.direction),
    transient: shipEntity.transient === true && !hasMiningCargo,
    ...entityScopeMetadata,
    conditionState: {
      damage: 0,
      charge: 1,
      armorDamage: 0,
      shieldCharge: 0,
      incapacitated: false,
    },
  };
  const manifestItems = [];
  const cargoDrops = nativeNpcStore.buildNativeCargoItems(entityID);
  for (const cargoEntry of cargoDrops) {
    const itemType = resolveItemByTypeID(cargoEntry.typeID) || {
      typeID: cargoEntry.typeID,
      name: cargoEntry.itemName,
    };
    const wreckItemResult = buildNativeWreckItemRecord(wreckRecord, itemType, {
      quantity: cargoEntry.quantity,
      singleton: cargoEntry.singleton,
      moduleState: cargoEntry.moduleState,
      blueprintState: cargoEntry.blueprintState,
      moduleID: cargoEntry.moduleID,
      sourceKind: "cargo",
    });
    if (!wreckItemResult.success || !wreckItemResult.data) {
      nativeNpcStore.removeNativeWreckCascade(wreckRecord.wreckID);
      return wreckItemResult;
    }
    manifestItems.push(wreckItemResult.data);
  }

  const lootTable = nativeEntityRecord && nativeEntityRecord.lootTableID
    ? getNpcLootTable(nativeEntityRecord.lootTableID)
    : null;
  const system = worldData.getSolarSystemByID(normalizedSystemID);
  const security = Number(system && (system.securityStatus ?? system.security));
  const rolledLootEntries = rollNpcLootEntries(lootTable, {
    random: options.random,
    source: {
      npcTypeID: wreckRecord.sourceTypeID,
      npcTypeName: nativeEntityRecord && nativeEntityRecord.itemName || shipEntity.itemName,
      profileID: nativeEntityRecord && nativeEntityRecord.profileID,
      lootTableID: nativeEntityRecord && nativeEntityRecord.lootTableID,
      factionName: nativeEntityRecord && nativeEntityRecord.factionName,
      siteID: nativeEntityRecord && nativeEntityRecord.dungeonSiteID || shipEntity.dungeonSiteID ||
        nativeEntityRecord && nativeEntityRecord.operatorKind !== "asteroidBeltRat" && nativeEntityRecord.spawnSiteID,
      securityClass: normalizedSystemID >= 31_000_000 && normalizedSystemID <= 31_999_999
        ? "wormhole" : !system || !Number.isFinite(security)
          ? null : security <= 0 ? "nullsec" : security < 0.45 ? "lowsec" : "highsec",
    },
  });
  const lootItemsResult = buildNativeLootWreckItems(wreckRecord, rolledLootEntries);
  if (!lootItemsResult.success) {
    nativeNpcStore.removeNativeWreckCascade(wreckRecord.wreckID);
    return lootItemsResult;
  }
  manifestItems.push(...lootItemsResult.data);

  if (hasMiningCargo) {
    const transfer = nativeNpcStore.commitMiningCargoWreckTransfer({ entityID,
      transient: shipEntity.transient === true, wreck: wreckRecord, items: manifestItems, cargo: miningCargoRows });
    if (!transfer.success) return transfer;
    wreckRecord = transfer.data.wreck;
  } else {
    const written = nativeNpcStore.upsertNativeWreck(wreckRecord, { transient: wreckRecord.transient });
    if (!written.success) return written;
    for (const item of manifestItems) {
      const result = nativeNpcStore.upsertNativeWreckItem(item, { transient: wreckRecord.transient });
      if (!result.success) { nativeNpcStore.removeNativeWreckCascade(wreckRecord.wreckID); return result; }
    }
  }
  spatialTrace.recordWreckRecordCreated(scene, wreckRecord, {
    persistenceKind: wreckRecord.transient ? "native-transient-record" : "native-persisted-record",
  });

  const removeResult = spaceRuntime.removeDynamicEntity(
    sceneDescriptor || normalizedSystemID,
    entityID,
    {
      sceneDescriptor: sceneDescriptor || undefined,
      allowSessionOwned: false,
      terminalDestructionEffectID: DESTRUCTION_EFFECT_EXPLOSION,
    },
  );
  if (!removeResult.success) {
    if (!hasMiningCargo) nativeNpcStore.removeNativeWreckCascade(wreckRecord.wreckID);
    return removeResult;
  }

  unregisterController(entityID);
  nativeNpcStore.removeNativeEntityCascade(entityID);

  const wreckSpawnResult = spawnNativeWreck(
    normalizedSystemID,
    wreckRecord.wreckID,
    {
      scene,
    },
  );
  if (!wreckSpawnResult.success) {
    return wreckSpawnResult;
  }

  // Pass the entity object (not just the ID) so objective/fetch-trigger matching can
  // use its typeID/nameID/dunObjectID — required for dungeon-fetch trigger kills.
  notifyDungeonEncounterEntityDestroyed(scene, shipEntity || entityID, nowMs);

  return {
    success: true,
    data: {
      wreck: wreckRecord,
      shipID: entityID,
      destroyedFighterCount,
      wreckItems: nativeNpcStore.listNativeWreckItemsForWreck(wreckRecord.wreckID),
      rolledLootEntries: rolledLootEntries.map((entry) => ({
        typeID: entry.typeID,
        name: entry.name,
        quantity: entry.quantity,
      })),
    },
  };
}

module.exports = {
  buildNativeWreckRuntimeEntity,
  refreshNativeWreckRuntimeEntity,
  spawnNativeWreck,
  restoreMiningCargoWrecksForScene,
  destroyNativeWreck,
  transferNativeWreckItemToCharacterLocation,
  destroyNativeNpcEntityWithWreck,
  _testing: {
    resolveNpcSentryAmmoCandidates,
    buildNativeLootWreckItems,
  },
};
