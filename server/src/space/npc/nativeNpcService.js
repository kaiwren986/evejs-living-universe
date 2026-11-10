"use strict";

const {
  toFiniteNumber,
} = require("../../common/numbers");

const path = require("path");

const log = require(path.join(__dirname, "../../utils/logger"));
const spaceRuntime = require(path.join(__dirname, "../runtime"));
const {
  resolveItemByTypeID,
} = require(path.join(__dirname, "../../services/inventory/itemTypeRegistry"));
const {
  normalizeModuleState,
  getTypeAttributeValue,
  typeHasEffectName,
} = require(path.join(__dirname, "../../services/fitting/liveFittingState"));
const {
  selectAutoFitFlagForNpcModuleType,
  isNpcChargeCompatibleWithModule,
  resolveNpcPropulsionEffectName,
  NPC_ENABLE_FITTED_PROPULSION_MODULES,
} = require(path.join(__dirname, "./npcCapabilityResolver"));
const {
  buildNpcDefinition,
  resolveNpcProfile,
} = require(path.join(__dirname, "./npcData"));
const {
  validateNpcHardwareDefinition,
} = require(path.join(__dirname, "./npcHardwareCatalog"));
const {
  resolveNpcSpawnGroupPlan,
} = require(path.join(__dirname, "./npcSelection"));
const {
  registerController,
  getControllerByEntityID,
  unregisterController,
} = require(path.join(__dirname, "./npcRegistry"));
const {
  tickScene: tickBehaviorScene,
  normalizeBehaviorOverrides,
} = require(path.join(__dirname, "./npcBehaviorLoop"));
const {
  cloneVector,
  normalizeVector,
  resolveAnchor,
  buildSpawnStateForDefinition,
} = require(path.join(__dirname, "./npcAnchors"));
const {
  buildNpcEntityIdentity,
} = require(path.join(__dirname, "./npcPresentation"));
const nativeNpcStore = require(path.join(__dirname, "./nativeNpcStore"));
const {
  isDestructibleNpcSentry,
  isEmpireSentry,
  EMPIRE_SENTRY_TYPE_IDS,
  STATIONARY_SENTRY_BEHAVIOR_OVERRIDES,
  buildNpcSentryBehaviorOverrides,
  applyStationaryNpcSentryState,
  applyNpcSentryRuntimePolicy,
} = require(path.join(__dirname, "./npcSentryPolicy"));
const {
  ENTITY_TYPE,
} = require(path.join(__dirname, "../entityConstants"));

// Only materializeEmpireSentry may reuse an existing scenery Ball's identity.
const EMPIRE_SENTRY_MATERIALIZATION = Symbol("empireSentryMaterialization");

const ABYSSAL_RUN_SCOPE_FIELDS = Object.freeze([
  "abyssalRunID",
  "evejsAbyssalInstanceID",
  "evejsAbyssalPocketInstanceID",
  "dungeonCurrentInstanceID",
  "dungeonSiteInstanceID",
]);
const ABYSSAL_ROOM_SCOPE_FIELDS = Object.freeze([
  "abyssalRoomIndex",
  "evejsAbyssalRoomIndex",
]);

function toPositiveInt(value, fallback = 0) {
  const numeric = Math.trunc(Number(value) || 0);
  return numeric > 0 ? numeric : fallback;
}

function cloneValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function shouldSuppressNativeNpcSlimName(identity, options = {}) {
  if (options.suppressSlimName === true) {
    return true;
  }
  if (
    options.suppressSlimName === false ||
    Object.prototype.hasOwnProperty.call(options, "slimNameOverride")
  ) {
    return false;
  }

  const slimTypeID = toPositiveInt(identity && identity.slimTypeID, 0);
  const slimType = slimTypeID > 0 ? resolveItemByTypeID(slimTypeID) : null;
  const canonicalTypeName = String(slimType && slimType.name || "").trim();
  const intendedSlimName = String(identity && identity.slimName || "").trim();
  // Canonical type names belong to client data and should be localized there.
  return canonicalTypeName !== "" && intendedSlimName === canonicalTypeName;
}

function isDamageableChargeType(itemType) {
  return (
    toPositiveInt(itemType && itemType.categoryID, 0) === 8 &&
    Number(getTypeAttributeValue(itemType && itemType.typeID, "crystalsGetDamaged")) > 0
  );
}

function resolveNativeCargoSingleton(itemType, authoredSingleton) {
  if (authoredSingleton !== true) {
    return false;
  }
  if (toPositiveInt(itemType && itemType.categoryID, 0) === 8) {
    return isDamageableChargeType(itemType);
  }
  return true;
}

function isTransientStartupControllerRecord(entityRecord, controllerRecord) {
  if (!entityRecord || !controllerRecord) {
    return false;
  }

  const startupRuleID = String(controllerRecord.startupRuleID || "").trim();
  const operatorKind = String(controllerRecord.operatorKind || "").trim();
  return (
    (entityRecord.transient === true || controllerRecord.transient === true) &&
    (startupRuleID !== "" || operatorKind !== "")
  );
}

function buildDescriptorVirtualAnchor(descriptor = {}) {
  return {
    kind: String(descriptor.kind || "coordinates"),
    itemID: toPositiveInt(
      descriptor.itemID || descriptor.entityID || descriptor.anchorID,
      0,
    ),
    itemName: String(descriptor.name || descriptor.itemName || "Custom Anchor"),
    position: cloneVector(descriptor.position),
    direction: normalizeVector(
      descriptor.direction,
      { x: 1, y: 0, z: 0 },
    ),
    radius: Math.max(0, toFiniteNumber(descriptor.radius, 0)),
  };
}

function isCoordinateAnchorDescriptor(descriptor = {}) {
  const kind = String(descriptor && descriptor.kind || "")
    .trim()
    .toLowerCase();
  return kind === "coordinates" || Boolean(descriptor && descriptor.position);
}

function buildSceneContextFields(scene, fallbackSystemID = 0) {
  return {
    systemID: toPositiveInt(scene && scene.systemID, fallbackSystemID),
    sceneDescriptor: scene && scene.sceneDescriptor || null,
    sceneKey: String(scene && scene.sceneKey || ""),
    sceneKind: String(scene && scene.sceneKind || ""),
    instanceID: toPositiveInt(scene && scene.instanceID, 0),
    locationID: toPositiveInt(scene && scene.locationID, fallbackSystemID),
  };
}

function listScopeContainers(record) {
  if (!record || typeof record !== "object") {
    return [];
  }
  return [
    record,
    record.spaceState && typeof record.spaceState === "object"
      ? record.spaceState
      : null,
  ].filter(Boolean);
}

function resolveExactPositiveClaims(sources, fieldNames) {
  let value = 0;
  let present = false;
  const values = new Set();
  for (const source of sources) {
    if (!source || typeof source !== "object") {
      continue;
    }
    for (const fieldName of fieldNames) {
      if (
        !Object.hasOwn(source, fieldName) ||
        source[fieldName] === null ||
        source[fieldName] === undefined
      ) {
        continue;
      }
      present = true;
      const candidate = toPositiveInt(source[fieldName], 0);
      if (candidate <= 0) {
        return { present, valid: false, value: 0, values: [...values] };
      }
      values.add(candidate);
      if (value > 0 && candidate !== value) {
        return { present, valid: false, value: 0, values: [...values] };
      }
      value = candidate;
    }
  }
  return {
    present,
    valid: present && value > 0,
    value,
    values: [...values],
  };
}

function resolveExactTextClaims(sources, fieldNames, options = {}) {
  let value = "";
  let present = false;
  const values = new Set();
  for (const source of sources) {
    if (!source || typeof source !== "object") {
      continue;
    }
    for (const fieldName of fieldNames) {
      if (
        !Object.hasOwn(source, fieldName) ||
        source[fieldName] === null ||
        source[fieldName] === undefined
      ) {
        continue;
      }
      let candidate = String(source[fieldName]).trim();
      if (!candidate) {
        continue;
      }
      if (options.lowercase === true) {
        candidate = candidate.toLowerCase();
      }
      present = true;
      values.add(candidate);
      if (value && candidate !== value) {
        return { present, valid: false, value: "", values: [...values] };
      }
      value = candidate;
    }
  }
  return {
    present,
    valid: present && value !== "",
    value,
    values: [...values],
  };
}

function resolveNativeNpcAbyssalDestructionAuthority(
  runtimeEntity,
  controller,
  scene,
  options = {},
) {
  const source = runtimeEntity && typeof runtimeEntity === "object"
    ? runtimeEntity
    : {};
  const controllerRecord = controller && typeof controller === "object"
    ? controller
    : {};
  const sceneRecord = scene && typeof scene === "object"
    ? scene
    : {};
  const sourceContainers = listScopeContainers(source);
  const controllerContainers = listScopeContainers(controllerRecord);
  const sceneDescriptor = sceneRecord.sceneDescriptor &&
      typeof sceneRecord.sceneDescriptor === "object"
    ? sceneRecord.sceneDescriptor
    : null;
  const optionSceneDescriptor = options.sceneDescriptor &&
      typeof options.sceneDescriptor === "object"
    ? options.sceneDescriptor
    : null;
  const actualSceneSources = [sceneRecord, sceneDescriptor].filter(Boolean);
  const allAuthoritySources = [
    ...sourceContainers,
    ...controllerContainers,
    sceneRecord,
    sceneDescriptor,
    optionSceneDescriptor,
  ].filter(Boolean);

  // NPC-owned run and room tags are mandatory. Scene/controller context may
  // corroborate those tags, but it must never supply missing objective scope.
  const sourceRun = resolveExactPositiveClaims(
    sourceContainers,
    ABYSSAL_RUN_SCOPE_FIELDS,
  );
  const sourceRoom = resolveExactPositiveClaims(
    sourceContainers,
    ABYSSAL_ROOM_SCOPE_FIELDS,
  );
  const allRun = resolveExactPositiveClaims(
    allAuthoritySources,
    [...ABYSSAL_RUN_SCOPE_FIELDS, "runID", "instanceID"],
  );
  const allRoom = resolveExactPositiveClaims(
    [
      ...sourceContainers,
      ...controllerContainers,
      options,
    ],
    [...ABYSSAL_ROOM_SCOPE_FIELDS, "roomIndex"],
  );
  const actualSceneRun = resolveExactPositiveClaims(
    actualSceneSources,
    [...ABYSSAL_RUN_SCOPE_FIELDS, "runID", "instanceID"],
  );
  const actualSceneKeys = resolveExactTextClaims(actualSceneSources, ["sceneKey"]);
  const allSceneKeys = resolveExactTextClaims(allAuthoritySources, ["sceneKey"]);
  const actualSceneKinds = resolveExactTextClaims(
    actualSceneSources,
    ["sceneKind"],
    { lowercase: true },
  );
  const allSceneKinds = resolveExactTextClaims(
    allAuthoritySources,
    ["sceneKind", "instanceScope"],
    { lowercase: true },
  );
  const hasAbyssalSignal = Boolean(
    sourceRun.present ||
    sourceRoom.present ||
    source.evejsAbyssalNpc === true ||
    allSceneKinds.values.includes("abyssal") ||
    allSceneKeys.values.some((sceneKey) => sceneKey.startsWith("abyssal-run:"))
  );
  const invalid = (reason) => ({
    present: hasAbyssalSignal,
    valid: false,
    reason,
    runID: 0,
    roomIndex: 0,
    sceneKey: String(sceneRecord.sceneKey || sceneDescriptor && sceneDescriptor.sceneKey || ""),
  });

  if (!hasAbyssalSignal) {
    return invalid("ABYSSAL_AUTHORITY_MISSING");
  }
  if (!sourceRun.valid) {
    return invalid(
      sourceRun.present
        ? "ABYSSAL_RUN_SCOPE_INVALID"
        : "ABYSSAL_RUN_SCOPE_MISSING",
    );
  }
  if (!sourceRoom.valid) {
    return invalid(
      sourceRoom.present
        ? "ABYSSAL_ROOM_SCOPE_INVALID"
        : "ABYSSAL_ROOM_SCOPE_MISSING",
    );
  }
  if (!allRun.valid || allRun.value !== sourceRun.value) {
    return invalid("ABYSSAL_RUN_AUTHORITY_CONFLICT");
  }
  if (!allRoom.valid || allRoom.value !== sourceRoom.value) {
    return invalid("ABYSSAL_ROOM_AUTHORITY_CONFLICT");
  }

  const expectedSceneKey = `abyssal-run:${sourceRun.value}`;
  if (
    !actualSceneRun.valid ||
    actualSceneRun.value !== sourceRun.value ||
    !actualSceneKeys.valid ||
    actualSceneKeys.value !== expectedSceneKey ||
    !actualSceneKinds.valid ||
    actualSceneKinds.value !== "abyssal"
  ) {
    return invalid("ABYSSAL_SCENE_AUTHORITY_INVALID");
  }
  if (
    !allSceneKeys.valid ||
    allSceneKeys.value !== expectedSceneKey ||
    !allSceneKinds.valid ||
    allSceneKinds.value !== "abyssal"
  ) {
    return invalid("ABYSSAL_SCENE_AUTHORITY_CONFLICT");
  }

  return {
    present: true,
    valid: true,
    reason: "EXACT_ABYSSAL_RUN_ROOM_SCENE_AUTHORITY",
    runID: sourceRun.value,
    roomIndex: sourceRoom.value,
    sceneKey: expectedSceneKey,
  };
}

function captureNativeNpcDestructionContext(entityID, controller, runtimeEntity, scene, options = {}) {
  const source = runtimeEntity && typeof runtimeEntity === "object"
    ? runtimeEntity
    : {};
  const controllerRecord = controller && typeof controller === "object"
    ? controller
    : {};
  const sceneRecord = scene && typeof scene === "object"
    ? scene
    : {};
  const npcID = toPositiveInt(entityID, toPositiveInt(source.itemID, 0));
  const abyssalAuthority = resolveNativeNpcAbyssalDestructionAuthority(
    source,
    controllerRecord,
    sceneRecord,
    options,
  );
  const abyssalRunID = abyssalAuthority.valid ? abyssalAuthority.runID : 0;
  const abyssalRoomIndex = abyssalAuthority.valid ? abyssalAuthority.roomIndex : 0;
  return Object.freeze({
    npcID,
    entityID: npcID,
    itemID: npcID,
    sceneKey: abyssalAuthority.sceneKey,
    sceneKind: abyssalAuthority.valid ? "abyssal" : String(sceneRecord.sceneKind || ""),
    abyssalRunID,
    instanceID: abyssalRunID,
    abyssalRoomIndex,
    roomIndex: abyssalRoomIndex,
    instanceScope: abyssalAuthority.valid ? "abyssal" : "",
    abyssalAuthorityPresent: abyssalAuthority.present,
    abyssalAuthorityValid: abyssalAuthority.valid,
    abyssalAuthorityReason: abyssalAuthority.reason,
    objectiveID: npcID,
    objectiveRequired: source.evejsAbyssalObjectiveRelevant !== false,
    typeID: toPositiveInt(source.typeID, 0),
    destructionReason: String(options.destructionReason || "combat"),
  });
}

function normalizeNpcObjectiveNotificationResult(result, fallback = "not-tracked") {
  if (result && typeof result === "object") {
    return {
      handled: result.handled === true || result.success === true,
      newlyRecorded: result.newlyRecorded === true,
      objectiveComplete: result.objectiveComplete === true,
      result: String(result.result || result.status || (result.duplicate === true ? "already-notified" : fallback)),
      pending: result.pending === true,
      errorMsg: result.errorMsg || null,
    };
  }
  if (result === true) {
    return {
      handled: true,
      newlyRecorded: true,
      objectiveComplete: false,
      result: "notified",
      pending: false,
      errorMsg: null,
    };
  }
  return {
    handled: false,
    newlyRecorded: false,
    objectiveComplete: false,
    result: fallback,
    pending: false,
    errorMsg: null,
  };
}

function validateStoredNativeControllerSceneAuthority(
  scene,
  entityRecord,
  controllerRecord,
) {
  if (!scene || !entityRecord || !controllerRecord) {
    return {
      success: false,
      errorMsg: "NPC_SCENE_AUTHORITY_INVALID",
    };
  }
  const records = [entityRecord, controllerRecord];
  const sceneKeyClaims = resolveExactTextClaims(records, ["sceneKey"]);
  const sceneKindClaims = resolveExactTextClaims(
    records,
    ["sceneKind"],
    { lowercase: true },
  );
  const instanceClaims = resolveExactPositiveClaims(records, ["instanceID"]);
  const locationClaims = resolveExactPositiveClaims(
    records,
    ["locationID", "systemID"],
  );
  const sceneKey = String(scene.sceneKey || "").trim();
  const sceneKind = String(scene.sceneKind || "").trim().toLowerCase();
  const sceneInstanceID = toPositiveInt(scene.instanceID, 0);
  const sceneLocationID = toPositiveInt(scene.locationID, toPositiveInt(scene.systemID, 0));
  const hasAbyssalClaim = Boolean(
    sceneKind === "abyssal" ||
    sceneKindClaims.values.includes("abyssal") ||
    sceneKeyClaims.values.some((value) => value.startsWith("abyssal-run:"))
  );
  const invalid = () => ({
    success: false,
    errorMsg: "NPC_SCENE_AUTHORITY_INVALID",
  });

  if (
    sceneKeyClaims.present &&
    (!sceneKeyClaims.valid || sceneKeyClaims.value !== sceneKey)
  ) {
    return invalid();
  }
  if (
    sceneKindClaims.present &&
    (!sceneKindClaims.valid || sceneKindClaims.value !== sceneKind)
  ) {
    return invalid();
  }
  if (
    locationClaims.present &&
    (!locationClaims.valid || locationClaims.value !== sceneLocationID)
  ) {
    return invalid();
  }
  if (!hasAbyssalClaim) {
    return { success: true, errorMsg: null };
  }
  if (
    sceneKind !== "abyssal" ||
    !sceneKeyClaims.valid ||
    !sceneKindClaims.valid ||
    !instanceClaims.valid ||
    instanceClaims.value !== sceneInstanceID ||
    sceneKeyClaims.value !== `abyssal-run:${sceneInstanceID}`
  ) {
    return invalid();
  }
  for (const record of records) {
    if (
      String(record.sceneKey || "").trim() !== sceneKey ||
      String(record.sceneKind || "").trim().toLowerCase() !== "abyssal" ||
      toPositiveInt(record.instanceID, 0) !== sceneInstanceID
    ) {
      return invalid();
    }
  }
  return { success: true, errorMsg: null };
}

function logNpcObjectiveNotificationDiagnostic(context, notificationResult, options = {}) {
  const callbackAvailable = typeof options.notifyNpcDestroyed === "function";
  log.info(
    `[NpcDestruction] objective notification ` +
      `npc=${toPositiveInt(context && context.npcID, 0)} ` +
      `runID=${toPositiveInt(context && context.abyssalRunID, 0) || "none"} ` +
      `room=${toPositiveInt(context && context.abyssalRoomIndex, 0) || "none"} ` +
      `sceneKey=${String(context && context.sceneKey || "none")} ` +
      `authority=${String(context && context.abyssalAuthorityReason || "none")} ` +
      `objectiveTracked=${notificationResult.handled === true} ` +
      `callbackAvailable=${callbackAvailable} ` +
      `result=${notificationResult.result} ` +
      `reason=${String(context && context.destructionReason || "combat")}`,
  );
}

function buildStoredControllerDebugContext(entityRecord, controllerRecord) {
  return {
    entityID: toPositiveInt(
      controllerRecord && controllerRecord.entityID,
      toPositiveInt(entityRecord && entityRecord.entityID, 0),
    ),
    systemID: toPositiveInt(
      controllerRecord && controllerRecord.systemID,
      toPositiveInt(entityRecord && entityRecord.systemID, 0),
    ),
    startupRuleID: String(controllerRecord && controllerRecord.startupRuleID || "").trim() || null,
    operatorKind: String(controllerRecord && controllerRecord.operatorKind || "").trim() || null,
    profileID: String(controllerRecord && controllerRecord.profileID || "").trim() || null,
    loadoutID: String(entityRecord && entityRecord.loadoutID || "").trim() || null,
    behaviorProfileID: String(entityRecord && entityRecord.behaviorProfileID || "").trim() || null,
    entityType: String(controllerRecord && controllerRecord.entityType || "").trim().toLowerCase() || null,
  };
}

function pruneInvalidStoredStartupController(entityRecord, controllerRecord) {
  const context = buildStoredControllerDebugContext(entityRecord, controllerRecord);
  const removeResult = nativeNpcStore.removeNativeEntityCascade(context.entityID);
  if (!removeResult.success) {
    return {
      success: false,
      errorMsg: removeResult.errorMsg || "NPC_INVALID_STARTUP_CONTROLLER_PRUNE_FAILED",
    };
  }

  log.warn(
    `[NativeNpc] Pruned invalid transient startup controller ` +
      `entity=${context.entityID} system=${context.systemID} ` +
      `rule=${context.startupRuleID || "-"} operator=${context.operatorKind || "-"} ` +
      `profile=${context.profileID || "-"} loadout=${context.loadoutID || "-"} ` +
      `behavior=${context.behaviorProfileID || "-"} type=${context.entityType || "-"}: ` +
      `NPC_DEFINITION_INCOMPLETE`,
  );

  return {
    success: true,
    data: {
      entity: null,
      controller: null,
      prunedInvalidStoredController: true,
      ...context,
    },
  };
}

function normalizeExplicitFlagList(moduleEntry, quantity) {
  const explicitFlags = Array.isArray(moduleEntry && moduleEntry.flagIDs)
    ? moduleEntry.flagIDs
    : (
      moduleEntry && moduleEntry.flagID !== undefined && moduleEntry.flagID !== null
        ? [moduleEntry.flagID]
        : []
    );
  const normalizedFlags = explicitFlags
    .map((value) => toPositiveInt(value, 0))
    .filter((value) => value > 0);
  if (normalizedFlags.length <= 0) {
    return [];
  }
  if (normalizedFlags.length >= quantity) {
    return normalizedFlags.slice(0, quantity);
  }
  const nextFlags = [...normalizedFlags];
  while (nextFlags.length < quantity) {
    nextFlags.push(nextFlags[nextFlags.length - 1]);
  }
  return nextFlags;
}

function countExplicitFlagAssignments(moduleEntry) {
  const explicitFlags = Array.isArray(moduleEntry && moduleEntry.flagIDs)
    ? moduleEntry.flagIDs
    : (
      moduleEntry && moduleEntry.flagID !== undefined && moduleEntry.flagID !== null
        ? [moduleEntry.flagID]
        : []
    );
  return explicitFlags
    .map((value) => toPositiveInt(value, 0))
    .filter((value) => value > 0)
    .length;
}

function resolveAuthoredModuleQuantity(moduleEntry) {
  const explicitFlagCount = countExplicitFlagAssignments(moduleEntry);
  const authoredQuantity = toPositiveInt(moduleEntry && moduleEntry.quantity, 0);
  return Math.max(1, authoredQuantity, explicitFlagCount);
}

const TRANSIENT_CONCORD_TARGETING_RANGE_METERS = 250_000;
const MIN_NATIVE_NPC_LOCK_SLOTS = 1;

function applyTransientConcordCombatOverrides(entity, entityRecord) {
  if (
    !entity ||
    entity.kind !== "ship" ||
    !entityRecord ||
    entityRecord.transient !== true ||
    String(entityRecord.npcEntityType || "").trim().toLowerCase() !== ENTITY_TYPE.CONCORD
  ) {
    return entity;
  }

  // Scan resolution stays the type's own: Captain 1,000 and Commander 60 are what
  // make the Captains disable first and the Commander's kill come later.
  entity.maxTargetRange = Math.max(
    toFiniteNumber(entity.maxTargetRange, 0),
    TRANSIENT_CONCORD_TARGETING_RANGE_METERS,
  );
  entity.cloakingTargetingDelay = 0;
  if (entity.passiveDerivedState && typeof entity.passiveDerivedState === "object") {
    entity.passiveDerivedState.maxTargetRange = entity.maxTargetRange;
    entity.passiveDerivedState.cloakingTargetingDelay = 0;
  }
  return entity;
}

function applyCapitalNpcCombatOverrides(entity, entityRecord, definition) {
  if (
    !entity ||
    entity.kind !== "ship" ||
    !entityRecord ||
    entityRecord.capitalNpc !== true
  ) {
    return entity;
  }

  const behaviorProfile = definition && definition.behaviorProfile &&
    typeof definition.behaviorProfile === "object"
    ? definition.behaviorProfile
    : {};
  const aggressionRangeMeters = Math.max(
    0,
    toFiniteNumber(behaviorProfile.aggressionRangeMeters, 0),
  );
  if (aggressionRangeMeters > 0) {
    entity.maxTargetRange = Math.max(
      toFiniteNumber(entity.maxTargetRange, 0),
      aggressionRangeMeters,
    );
  }

  const supportHullTypeID = toPositiveInt(
    definition &&
    definition.profile &&
    definition.profile.titanSuperweaponHullTypeID,
    0,
  );
  if (supportHullTypeID > 0) {
    entity.capacitorCapacity = Math.max(
      toFiniteNumber(entity.capacitorCapacity, 0),
      toFiniteNumber(getTypeAttributeValue(supportHullTypeID, "capacitorCapacity"), 0),
    );
    entity.scanResolution = Math.max(
      toFiniteNumber(entity.scanResolution, 0),
      toFiniteNumber(getTypeAttributeValue(supportHullTypeID, "scanResolution"), 0),
    );
    entity.maxTargetRange = Math.max(
      toFiniteNumber(entity.maxTargetRange, 0),
      toFiniteNumber(getTypeAttributeValue(supportHullTypeID, "maxTargetRange"), 0),
    );
  }

  if (entity.passiveDerivedState && typeof entity.passiveDerivedState === "object") {
    entity.passiveDerivedState.maxTargetRange = entity.maxTargetRange;
    entity.passiveDerivedState.scanResolution = entity.scanResolution;
    entity.passiveDerivedState.capacitorCapacity = entity.capacitorCapacity;
  }
  return entity;
}

function applyNativeNpcHullCombatOverrides(entity, entityRecord, definition) {
  if (
    !entity ||
    entity.kind !== "ship" ||
    !entityRecord ||
    String(entityRecord.npcEntityType || "").trim().toLowerCase() !== ENTITY_TYPE.NPC
  ) {
    return entity;
  }

  const behaviorProfile = definition && definition.behaviorProfile &&
    typeof definition.behaviorProfile === "object"
    ? definition.behaviorProfile
    : {};
  const shipTypeID = toPositiveInt(entityRecord.typeID, 0);
  const dogmaScanResolution = Math.max(
    0,
    toFiniteNumber(getTypeAttributeValue(shipTypeID, "scanResolution"), 0),
  );
  const dogmaTargetRange = Math.max(
    0,
    toFiniteNumber(getTypeAttributeValue(shipTypeID, "maxTargetRange"), 0),
  );
  const dogmaMaxLockedTargets = Math.max(
    MIN_NATIVE_NPC_LOCK_SLOTS,
    toPositiveInt(getTypeAttributeValue(shipTypeID, "maxLockedTargets"), 0),
  );
  const dogmaCapacitorCapacity = Math.max(
    0,
    toFiniteNumber(getTypeAttributeValue(shipTypeID, "capacitorCapacity"), 0),
  );
  const dogmaEntitySuperweaponRange = Math.max(
    0,
    toFiniteNumber(getTypeAttributeValue(shipTypeID, "entitySuperWeaponMaxRange"), 0),
  );
  const dogmaEntitySuperweaponFalloff = Math.max(
    0,
    toFiniteNumber(getTypeAttributeValue(shipTypeID, "entitySuperWeaponFallOff"), 0),
  );
  const aggressionRangeMeters = Math.max(
    0,
    toFiniteNumber(behaviorProfile.aggressionRangeMeters, 0),
  );

  entity.scanResolution = Math.max(
    toFiniteNumber(entity.scanResolution, 0),
    dogmaScanResolution,
  );
  entity.maxTargetRange = Math.max(
    toFiniteNumber(entity.maxTargetRange, 0),
    dogmaTargetRange,
    dogmaEntitySuperweaponRange + dogmaEntitySuperweaponFalloff,
    aggressionRangeMeters,
  );
  entity.maxLockedTargets = Math.max(
    toPositiveInt(entity.maxLockedTargets, 0),
    dogmaMaxLockedTargets,
  );
  entity.capacitorCapacity = Math.max(
    toFiniteNumber(entity.capacitorCapacity, 0),
    dogmaCapacitorCapacity,
  );
  if (typeHasEffectName(shipTypeID, "entitySuperWeapon")) {
    entity.component_turboshield = 0;
  }

  if (entity.passiveDerivedState && typeof entity.passiveDerivedState === "object") {
    entity.passiveDerivedState.scanResolution = entity.scanResolution;
    entity.passiveDerivedState.maxTargetRange = entity.maxTargetRange;
    entity.passiveDerivedState.maxLockedTargets = entity.maxLockedTargets;
    entity.passiveDerivedState.capacitorCapacity = entity.capacitorCapacity;
  }
  // Rat entity types carry no maxTargetRange (attribute 76) and sometimes no
  // maxLockedTargets in the SDE — they use entityAttackRange instead — so a
  // later refreshShipEntityDerivedState recomputes both as 0 and overwrites the
  // values resolved above. isTargetLockRangeValid then refuses every lock with
  // TARGET_OUT_OF_RANGE before it ever measures distance, leaving the rat
  // orbiting its target forever without firing. Preserve the resolved bases so
  // the refresh feeds them back through Dogma, where sensor damping still
  // scales them.
  entity.nativeNpcCombatBases = {
    maxTargetRange: Math.max(0, toFiniteNumber(entity.maxTargetRange, 0)),
    scanResolution: Math.max(0, toFiniteNumber(entity.scanResolution, 0)),
    maxLockedTargets: Math.max(0, toPositiveInt(entity.maxLockedTargets, 0)),
    capacitorCapacity: Math.max(0, toFiniteNumber(entity.capacitorCapacity, 0)),
  };
  if (entity.capitalNpc === true) {
    // These authored capital values replace zero or incomplete hull Dogma
    // bases. Runtime recomputes feed them into Dogma before hostile modifiers
    // are applied, so dampening and capacitor effects still scale them.
    entity.capitalNpcCombatBases = {
      maxTargetRange: Math.max(0, toFiniteNumber(entity.maxTargetRange, 0)),
      scanResolution: Math.max(0, toFiniteNumber(entity.scanResolution, 0)),
      capacitorCapacity: Math.max(0, toFiniteNumber(entity.capacitorCapacity, 0)),
    };
  }
  return entity;
}

function isNativeAmbientRuleOptions(options = {}) {
  const entityType = String(options.entityType || "").trim().toLowerCase();
  const behaviorOverrides = normalizeBehaviorOverrides(options.behaviorOverrides);
  const targetPreference = String(
    behaviorOverrides.targetPreference || "preferredTargetThenNearestPlayer",
  ).trim().toLowerCase();
  return (
    entityType === ENTITY_TYPE.CONCORD &&
    behaviorOverrides.autoAggro === false &&
    behaviorOverrides.autoActivateWeapons === false &&
    targetPreference === "none"
  );
}

function resolveNativeSpawnContextForSystem(systemID, options = {}) {
  const numericSystemID = toPositiveInt(systemID, 0);
  if (!numericSystemID) {
    return {
      success: false,
      errorMsg: "SOLAR_SYSTEM_NOT_FOUND",
    };
  }

  const descriptorScene =
    options.sceneDescriptor && typeof spaceRuntime.ensureScene === "function"
      ? spaceRuntime.ensureScene(options.sceneDescriptor)
      : null;
  const sceneContextFields = buildSceneContextFields(descriptorScene, numericSystemID);
  const anchorEntity = options.anchorEntity || null;
  if (anchorEntity && anchorEntity.position) {
    return {
      success: true,
      data: {
        systemID: sceneContextFields.systemID || numericSystemID,
        scene: descriptorScene || spaceRuntime.ensureScene(numericSystemID),
        anchorEntity,
        preferredTargetID: toPositiveInt(options.preferredTargetID, 0),
        anchorKind: String(anchorEntity.kind || "anchor"),
        anchorLabel: String(anchorEntity.itemName || anchorEntity.slimName || "Anchor"),
        ...sceneContextFields,
      },
    };
  }

  const anchorDescriptor = options.anchorDescriptor || null;
  if (!anchorDescriptor) {
    return {
      success: false,
      errorMsg: "ANCHOR_REQUIRED",
    };
  }

  if (descriptorScene && isCoordinateAnchorDescriptor(anchorDescriptor)) {
    const anchor = buildDescriptorVirtualAnchor(anchorDescriptor);
    return {
      success: true,
      data: {
        systemID: sceneContextFields.systemID || numericSystemID,
        scene: descriptorScene,
        anchorEntity: anchor,
        preferredTargetID: toPositiveInt(options.preferredTargetID, 0),
        anchorKind: String(anchor.kind || anchorDescriptor.kind || "anchor"),
        anchorLabel: String(
          anchor.itemName ||
            anchorDescriptor.name ||
            anchorDescriptor.nameQuery ||
            "Anchor",
        ),
        ...sceneContextFields,
      },
    };
  }

  const anchorResult = resolveAnchor(numericSystemID, anchorDescriptor);
  if (!anchorResult.success || !anchorResult.data || !anchorResult.data.anchor) {
    return anchorResult;
  }
  const resolvedSceneContextFields = buildSceneContextFields(
    descriptorScene || anchorResult.data.scene,
    numericSystemID,
  );

  return {
    success: true,
    data: {
      systemID: resolvedSceneContextFields.systemID || numericSystemID,
      scene: descriptorScene || anchorResult.data.scene,
      anchorEntity: anchorResult.data.anchor,
      preferredTargetID: toPositiveInt(options.preferredTargetID, 0),
      anchorKind: String(anchorResult.data.anchor.kind || anchorDescriptor.kind || "anchor"),
      anchorLabel: String(
        anchorResult.data.anchor.itemName ||
          anchorDescriptor.name ||
          anchorDescriptor.nameQuery ||
          "Anchor",
      ),
      ...resolvedSceneContextFields,
    },
  };
}

function buildNativeModuleRecords(entityRecord, definition, options = {}) {
  const authoredLoadout = definition && definition.loadout && typeof definition.loadout === "object"
    ? definition.loadout
    : {};
  const transient = options.transient === true;
  const shipLike = {
    typeID: entityRecord.typeID,
  };
  const authoredModules = Array.isArray(authoredLoadout.modules)
    ? authoredLoadout.modules
    : [];
  const moduleRecords = [];

  for (const moduleEntry of authoredModules) {
    if (
      NPC_ENABLE_FITTED_PROPULSION_MODULES !== true &&
      resolveNpcPropulsionEffectName({
        typeID: toPositiveInt(moduleEntry && moduleEntry.typeID, 0),
        npcCapabilityTypeID: toPositiveInt(moduleEntry && moduleEntry.npcCapabilityTypeID, 0),
      })
    ) {
      continue;
    }

    const quantity = resolveAuthoredModuleQuantity(moduleEntry);
    const moduleType = resolveItemByTypeID(toPositiveInt(moduleEntry && moduleEntry.typeID, 0));
    const npcCapabilityTypeID = toPositiveInt(
      moduleEntry && moduleEntry.npcCapabilityTypeID,
      0,
    );
    if (!moduleType) {
      return {
        success: false,
        errorMsg: "NPC_NATIVE_MODULE_TYPE_NOT_FOUND",
      };
    }
    if (npcCapabilityTypeID > 0 && !resolveItemByTypeID(npcCapabilityTypeID)) {
      return {
        success: false,
        errorMsg: "NPC_NATIVE_CAPABILITY_TYPE_NOT_FOUND",
      };
    }

    const explicitFlags = normalizeExplicitFlagList(moduleEntry, quantity);
    for (let index = 0; index < quantity; index += 1) {
      const flagID = explicitFlags[index] || selectAutoFitFlagForNpcModuleType(
        shipLike,
        moduleRecords.map((moduleRecord) => ({
          itemID: moduleRecord.moduleID,
          flagID: moduleRecord.flagID,
          typeID: moduleRecord.typeID,
          npcCapabilityTypeID: moduleRecord.npcCapabilityTypeID,
          groupID: moduleRecord.groupID,
          categoryID: moduleRecord.categoryID,
        })),
        {
          typeID: moduleType.typeID,
          npcCapabilityTypeID,
        },
      );
      if (!flagID) {
        return {
          success: false,
          errorMsg: "NPC_NATIVE_NO_FREE_SLOT",
        };
      }

      const moduleIDResult = nativeNpcStore.allocateModuleID({
        transient,
      });
      if (!moduleIDResult.success || !moduleIDResult.data) {
        return moduleIDResult;
      }

      const moduleRecord = {
        moduleID: moduleIDResult.data,
        entityID: entityRecord.entityID,
        ownerID: entityRecord.ownerID,
        typeID: moduleType.typeID,
        groupID: toPositiveInt(moduleType.groupID, 0),
        categoryID: toPositiveInt(moduleType.categoryID, 0),
        itemName: String(moduleType.name || ""),
        flagID,
        singleton: true,
        transient,
        ...(npcCapabilityTypeID > 0
          ? {
              npcCapabilityTypeID,
            }
          : {}),
        moduleState: normalizeModuleState({
          online: true,
          damage: 0,
          charge: 0,
          armorDamage: 0,
          shieldCharge: 0,
          incapacitated: false,
        }),
      };
      const upsertResult = nativeNpcStore.upsertNativeModule(moduleRecord, {
        transient,
      });
      if (!upsertResult.success) {
        return upsertResult;
      }
      moduleRecords.push(moduleRecord);
    }
  }

  return {
    success: true,
    data: moduleRecords,
  };
}

function buildNativeCargoRecords(entityRecord, moduleRecords, definition, options = {}) {
  const authoredCharges = Array.isArray(
    definition && definition.loadout && definition.loadout.charges,
  )
    ? definition.loadout.charges
    : [];
  const transient = options.transient === true;
  const cargoRecords = [];

  for (const chargeEntry of authoredCharges) {
    const chargeType = resolveItemByTypeID(toPositiveInt(chargeEntry && chargeEntry.typeID, 0));
    if (!chargeType) {
      return {
        success: false,
        errorMsg: "NPC_NATIVE_CHARGE_TYPE_NOT_FOUND",
      };
    }

    const quantityPerModule = Math.max(
      1,
      toPositiveInt(chargeEntry && chargeEntry.quantityPerModule, 1),
    );
    for (const moduleRecord of moduleRecords) {
      if (!isNpcChargeCompatibleWithModule(moduleRecord, chargeType.typeID)) {
        continue;
      }

      const cargoIDResult = nativeNpcStore.allocateCargoID({
        transient,
      });
      if (!cargoIDResult.success || !cargoIDResult.data) {
        return cargoIDResult;
      }

      const singleton = resolveNativeCargoSingleton(
        chargeType,
        chargeEntry && chargeEntry.singleton === true,
      );
      const cargoRecord = {
        cargoID: cargoIDResult.data,
        entityID: entityRecord.entityID,
        ownerID: entityRecord.ownerID,
        moduleID: moduleRecord.moduleID,
        typeID: chargeType.typeID,
        groupID: toPositiveInt(chargeType.groupID, 0),
        categoryID: toPositiveInt(chargeType.categoryID, 0),
        itemName: String(chargeType.name || ""),
        quantity: quantityPerModule,
        singleton,
        moduleState:
          singleton
            ? normalizeModuleState({
                online: true,
                damage: 0,
                charge: 0,
                armorDamage: 0,
                shieldCharge: 0,
                incapacitated: false,
              })
            : null,
        transient,
      };
      const upsertResult = nativeNpcStore.upsertNativeCargo(cargoRecord, {
        transient,
      });
      if (!upsertResult.success) {
        return upsertResult;
      }
      cargoRecords.push(cargoRecord);
    }
  }

  const authoredCargo = Array.isArray(
    definition && definition.loadout && definition.loadout.cargo,
  )
    ? definition.loadout.cargo
    : [];
  for (const cargoEntry of authoredCargo) {
    const cargoType = resolveItemByTypeID(toPositiveInt(cargoEntry && cargoEntry.typeID, 0));
    if (!cargoType) {
      return {
        success: false,
        errorMsg: "NPC_NATIVE_CARGO_TYPE_NOT_FOUND",
      };
    }

    const cargoIDResult = nativeNpcStore.allocateCargoID({
      transient,
    });
    if (!cargoIDResult.success || !cargoIDResult.data) {
      return cargoIDResult;
    }

    const quantity = Math.max(1, toPositiveInt(cargoEntry && cargoEntry.quantity, 1));
    const singleton = resolveNativeCargoSingleton(
      cargoType,
      cargoEntry && cargoEntry.singleton === true,
    );
    const cargoRecord = {
      cargoID: cargoIDResult.data,
      entityID: entityRecord.entityID,
      ownerID: entityRecord.ownerID,
      moduleID: 0,
      typeID: cargoType.typeID,
      groupID: toPositiveInt(cargoType.groupID, 0),
      categoryID: toPositiveInt(cargoType.categoryID, 0),
      itemName: String(cargoType.name || ""),
      quantity,
      singleton,
      flagID: Math.max(5, toPositiveInt(cargoEntry && cargoEntry.flagID, 5)),
      moduleState: singleton
        ? normalizeModuleState({
          online: true,
          damage: 0,
          charge: 0,
          armorDamage: 0,
          shieldCharge: 0,
          incapacitated: false,
        })
        : null,
      transient,
    };
    const upsertResult = nativeNpcStore.upsertNativeCargo(cargoRecord, {
      transient,
    });
    if (!upsertResult.success) {
      return upsertResult;
    }
    cargoRecords.push(cargoRecord);
  }

  return {
    success: true,
    data: cargoRecords,
  };
}

function resolveNativeRuntimeKind(options = {}) {
  const explicitRuntimeKind = String(options.runtimeKind || "").trim();
  if (explicitRuntimeKind) {
    return explicitRuntimeKind;
  }
  return isNativeAmbientRuleOptions(options) ? "nativeAmbient" : "nativeCombat";
}

function buildNativeControllerRecord(context, definition, entityRecord, spawnState, options = {}) {
  const runtimeKind = resolveNativeRuntimeKind(options);
  const controllerPaused = options.controllerPaused === true || options.startPaused === true;
  const nextThinkAtMs =
    runtimeKind === "nativeAmbient" ||
      options.skipInitialBehaviorTick === true ||
      controllerPaused
      ? Number.MAX_SAFE_INTEGER
      : 0;
  return {
    entityID: entityRecord.entityID,
    systemID: entityRecord.systemID,
    sceneKey: entityRecord.sceneKey || context.sceneKey || "",
    sceneKind: entityRecord.sceneKind || context.sceneKind || "",
    instanceID: toPositiveInt(entityRecord.instanceID, toPositiveInt(context.instanceID, 0)),
    locationID: toPositiveInt(entityRecord.locationID, toPositiveInt(context.locationID, entityRecord.systemID)),
    profileID: definition.profile.profileID,
    loadoutID: definition.loadout.loadoutID,
    behaviorProfileID: definition.behaviorProfile.behaviorProfileID,
    lootTableID: definition.lootTable ? definition.lootTable.lootTableID : null,
    definitionSnapshot: definition ? cloneValue(definition) : null,
    behaviorOverrides: normalizeBehaviorOverrides(
      isDestructibleNpcSentry(entityRecord)
        ? buildNpcSentryBehaviorOverrides(options.behaviorOverrides)
        : options.behaviorOverrides,
    ),
    preferredTargetID: toPositiveInt(options.preferredTargetID, toPositiveInt(context.preferredTargetID, 0)),
    currentTargetID: 0,
    selectionKind: String(options.selectionKind || "").trim() || null,
    selectionID: String(options.selectionID || "").trim() || null,
    selectionName: String(options.selectionName || "").trim() || null,
    spawnGroupID: String(options.spawnGroupID || "").trim() || null,
    spawnSiteID: String(options.spawnSiteID || "").trim() || null,
    startupRuleID: String(options.startupRuleID || "").trim() || null,
    operatorKind: String(options.operatorKind || "").trim() || null,
    entityType: entityRecord.npcEntityType,
    transient: options.transient === true,
    runtimeKind,
    controllerPaused,
    controllerLifecycleState: controllerPaused ? "materialized_paused" : "active",
    pausedReason: controllerPaused
      ? String(options.controllerPausedReason || "abyssal_room_prewarm").trim() || "abyssal_room_prewarm"
      : "",
    startupSlotIndex: Math.max(0, Math.trunc(Number(options.startupSlotIndex) || 0)),
    anchorKind: String(options.anchorKind || context.anchorKind || "anchor"),
    anchorID: toPositiveInt(
      options.anchorID,
      toPositiveInt(context.anchorEntity && context.anchorEntity.itemID, 0),
    ),
    anchorName: String(
      options.anchorName ||
        context.anchorLabel ||
        (context.anchorEntity && context.anchorEntity.itemName) ||
        "Anchor",
    ),
    homePosition: cloneVector(spawnState && spawnState.position),
    homeDirection: cloneVector(
      spawnState && spawnState.direction,
      { x: 1, y: 0, z: 0 },
    ),
    nextThinkAtMs,
    lastHomeCommandAtMs: 0,
    lastHomeDirection: null,
    returningHome: false,
  };
}

function buildNativeRuntimeShipSpec(entityRecord) {
  return {
    itemID: entityRecord.entityID,
    typeID: entityRecord.typeID,
    groupID: entityRecord.groupID,
    categoryID: entityRecord.categoryID,
    itemName: entityRecord.itemName,
    radius: entityRecord.radius,
    ownerID: entityRecord.ownerID,
    characterID: 0,
    pilotCharacterID: 0,
    corporationID: entityRecord.corporationID,
    allianceID: entityRecord.allianceID,
    warFactionID: entityRecord.warFactionID,
    securityStatus: entityRecord.securityStatus,
    bounty: entityRecord.bounty,
    npcEntityType: entityRecord.npcEntityType,
    capitalNpc: entityRecord.capitalNpc === true,
    capitalClassID: entityRecord.capitalClassID || null,
    capitalRarity: entityRecord.capitalRarity || null,
    nativeNpc: true,
    ...(entityRecord.empireSentry === true ? { empireSentry: true } : {}),
    nativeNpcOccupied: true,
    transient: entityRecord.transient === true,
    selectionKind: entityRecord.selectionKind || null,
    selectionID: entityRecord.selectionID || null,
    selectionName: entityRecord.selectionName || null,
    spawnGroupID: entityRecord.spawnGroupID || null,
    spawnSiteID: entityRecord.spawnSiteID || null,
    startupRuleID: entityRecord.startupRuleID || null,
    operatorKind: entityRecord.operatorKind || null,
    sceneKey: entityRecord.sceneKey || null,
    sceneKind: entityRecord.sceneKind || null,
    instanceID: toPositiveInt(entityRecord.instanceID, 0),
    locationID: toPositiveInt(entityRecord.locationID, entityRecord.systemID),
    anchorKind: entityRecord.anchorKind || null,
    anchorID: entityRecord.anchorID || null,
    anchorName: entityRecord.anchorName || null,
    conditionState: cloneValue(entityRecord.conditionState || {}),
    spaceState: {
      position: cloneVector(entityRecord.position),
      velocity: cloneVector(entityRecord.velocity),
      direction: cloneVector(entityRecord.direction, { x: 1, y: 0, z: 0 }),
      targetPoint: cloneVector(entityRecord.targetPoint || entityRecord.position),
      mode: String(entityRecord.mode || "STOP"),
      speedFraction: toFiniteNumber(entityRecord.speedFraction, 0),
      targetEntityID: toPositiveInt(entityRecord.targetEntityID, 0),
      followRange: Math.max(0, toFiniteNumber(entityRecord.followRange, 0)),
      orbitDistance: Math.max(0, toFiniteNumber(entityRecord.orbitDistance, 0)),
      maxVelocity: Math.max(0, toFiniteNumber(entityRecord.maxVelocity, 0)),
    },
    fittedItems: nativeNpcStore.buildNativeFittedItems(entityRecord.entityID),
    nativeCargoItems: nativeNpcStore.buildNativeCargoItems(entityRecord.entityID),
    slimTypeID: entityRecord.slimTypeID,
    slimGroupID: entityRecord.slimGroupID,
    slimCategoryID: entityRecord.slimCategoryID,
    slimName: entityRecord.slimName,
    suppressSlimName: entityRecord.suppressSlimName === true,
    nameID: toPositiveInt(entityRecord.nameID, 0) || null,
    hostileResponseThreshold: entityRecord.hostileResponseThreshold,
    friendlyResponseThreshold: entityRecord.friendlyResponseThreshold,
    modules: nativeNpcStore.buildNativeSlimModuleTuples(entityRecord.entityID),
  };
}

function applyNativeRuntimeNpcPresentation(entity, entityRecord, definition = null) {
  if (!entity || entity.kind !== "ship" || !entityRecord) {
    return entity;
  }
  entity.nativeNpc = true;
  if (entityRecord.empireSentry === true) entity.empireSentry = true;
  entity.nativeNpcOccupied = true;
  entity.selectionKind = entityRecord.selectionKind || null;
  entity.selectionID = entityRecord.selectionID || null;
  entity.selectionName = entityRecord.selectionName || null;
  entity.spawnGroupID = entityRecord.spawnGroupID || null;
  entity.spawnSiteID = entityRecord.spawnSiteID || null;
  entity.startupRuleID = entityRecord.startupRuleID || null;
  entity.operatorKind = entityRecord.operatorKind || null;
  if (entityRecord.sceneKey) {
    entity.sceneKey = entityRecord.sceneKey;
  }
  if (entityRecord.sceneKind) {
    entity.sceneKind = entityRecord.sceneKind;
  }
  if (toPositiveInt(entityRecord.instanceID, 0) > 0) {
    entity.instanceScope = entityRecord.sceneKind || entity.instanceScope || null;
    entity.abyssalRunID = toPositiveInt(entityRecord.instanceID, 0);
  }
  entity.anchorKind = entityRecord.anchorKind || null;
  entity.anchorID = entityRecord.anchorID || null;
  entity.anchorName = entityRecord.anchorName || null;
  entity.characterID = 0;
  entity.pilotCharacterID = 0;
  entity.ownerID = entityRecord.ownerID;
  entity.corporationID = entityRecord.corporationID;
  entity.allianceID = entityRecord.allianceID;
  entity.warFactionID = entityRecord.warFactionID;
  entity.slimTypeID = entityRecord.slimTypeID;
  entity.slimGroupID = entityRecord.slimGroupID;
  entity.slimCategoryID = entityRecord.slimCategoryID;
  entity.slimName = entityRecord.slimName;
  entity.suppressSlimName = entityRecord.suppressSlimName === true;
  entity.nameID = toPositiveInt(entityRecord.nameID, 0) || null;
  entity.securityStatus = entityRecord.securityStatus;
  entity.bounty = entityRecord.bounty;
  entity.npcEntityType = entityRecord.npcEntityType;
  entity.capitalNpc = entityRecord.capitalNpc === true;
  entity.capitalClassID = entityRecord.capitalClassID || null;
  entity.capitalRarity = entityRecord.capitalRarity || null;
  entity.hostileResponseThreshold = entityRecord.hostileResponseThreshold;
  entity.friendlyResponseThreshold = entityRecord.friendlyResponseThreshold;
  entity.transient = entityRecord.transient === true;
  if (toPositiveInt(entityRecord.targetEntityID, 0) > 0) {
    entity.targetEntityID = toPositiveInt(entityRecord.targetEntityID, 0);
  }
  if (toFiniteNumber(entityRecord.followRange, 0) > 0) {
    entity.followRange = toFiniteNumber(entityRecord.followRange, 0);
  }
  if (toFiniteNumber(entityRecord.orbitDistance, 0) > 0) {
    entity.orbitDistance = toFiniteNumber(entityRecord.orbitDistance, 0);
  }
  if (toFiniteNumber(entityRecord.maxVelocity, 0) > 0) {
    entity.maxVelocity = toFiniteNumber(entityRecord.maxVelocity, 0);
  }
  entity.fittedItems = nativeNpcStore.buildNativeFittedItems(entityRecord.entityID);
  entity.nativeCargoItems = nativeNpcStore.buildNativeCargoItems(entityRecord.entityID);
  entity.modules = nativeNpcStore.buildNativeSlimModuleTuples(entityRecord.entityID);
  const presentedEntity = applyNativeNpcHullCombatOverrides(
    applyCapitalNpcCombatOverrides(
      applyTransientConcordCombatOverrides(entity, entityRecord),
      entityRecord,
      definition,
    ),
    entityRecord,
    definition,
  );
  return applyNpcSentryRuntimePolicy(presentedEntity);
}

function resolveIdleOrbitDistance(entity, controller, anchorEntity, behaviorProfile) {
  const explicitDistance = Math.max(
    0,
    toFiniteNumber(behaviorProfile && behaviorProfile.idleAnchorOrbitDistanceMeters, 0),
  );
  if (explicitDistance > 0) {
    return explicitDistance;
  }

  const homePosition = controller && controller.homePosition;
  if (homePosition && anchorEntity && anchorEntity.position) {
    const dx = toFiniteNumber(homePosition.x, 0) - toFiniteNumber(anchorEntity.position.x, 0);
    const dy = toFiniteNumber(homePosition.y, 0) - toFiniteNumber(anchorEntity.position.y, 0);
    const dz = toFiniteNumber(homePosition.z, 0) - toFiniteNumber(anchorEntity.position.z, 0);
    const surfaceDistance = Math.max(
      0,
      Math.sqrt((dx ** 2) + (dy ** 2) + (dz ** 2)) -
        toFiniteNumber(entity && entity.radius, 0) -
        toFiniteNumber(anchorEntity && anchorEntity.radius, 0),
    );
    if (surfaceDistance > 0) {
      return surfaceDistance;
    }
  }

  return Math.max(
    2_500,
    toFiniteNumber(behaviorProfile && behaviorProfile.orbitDistanceMeters, 0),
  );
}

function syncNativeAmbientIdleState(scene, entity, controller, definition) {
  const behaviorProfile = {
    ...(definition && definition.behaviorProfile || {}),
    ...normalizeBehaviorOverrides(controller && controller.behaviorOverrides),
  };
  if (behaviorProfile.idleAnchorOrbit !== true) {
    return false;
  }

  const anchorID = toPositiveInt(controller && controller.anchorID, 0);
  if (!anchorID || anchorID === toPositiveInt(entity && entity.itemID, 0)) {
    return false;
  }
  const anchorEntity = scene && scene.getEntityByID(anchorID);
  if (!anchorEntity) {
    return false;
  }

  const orbitDistance = resolveIdleOrbitDistance(
    entity,
    controller,
    anchorEntity,
    behaviorProfile,
  );
  if (orbitDistance <= 0) {
    return false;
  }

  return spaceRuntime.orbitDynamicEntity(
    scene.systemID,
    entity.itemID,
    anchorEntity.itemID,
    orbitDistance,
  ) === true;
}

// Captured noncombat companions use the existing idle orbit owner so its next
// AI think cannot undo the scene's command. Transient anchor IDs are rebound
// by the dungeon after cold materialization, never promoted to new inventory.
function setDungeonCompanionOrbit(entity, target, options = {}) {
  const instanceID = toPositiveInt(entity?.dungeonSiteInstanceID, 0);
  const scene = spaceRuntime.findSceneContainingDynamicEntity(entity?.itemID);
  const controller = getControllerByEntityID(entity?.itemID);
  const record = nativeNpcStore.getNativeEntity(entity?.itemID);
  const range = Number(options.rangeMeters), speed = Number(options.speedFraction ?? 1);
  if (!instanceID || entity?.nativeNpc !== true || !scene || !controller || !record ||
      scene.getEntityByID(entity.itemID) !== entity || scene.getEntityByID(target?.itemID) !== target ||
      Number(target?.dungeonSiteInstanceID) !== instanceID || Number(record.dungeonSiteInstanceID) !== instanceID ||
      Number(record.systemID) !== Number(scene.systemID) || entity.itemID === target?.itemID ||
      !Number.isFinite(range) || range <= 0 || !Number.isFinite(speed) || speed <= 0 || speed > 1) {
    return { success: false, errorMsg: "DUNGEON_COMPANION_ORBIT_SCOPE_INVALID" };
  }
  if (entity.mode === "WARP") return { success: false, errorMsg: "DUNGEON_COMPANION_IN_WARP" };
  const samePolicy = controller.anchorID === target.itemID && controller.behaviorOverrides?.idleAnchorOrbit === true &&
    controller.behaviorOverrides.idleAnchorOrbitDistanceMeters === range;
  if (!samePolicy || !["ORBIT", "FOLLOW"].includes(entity.mode) || Number(entity.targetEntityID) !== Number(target.itemID) ||
      Math.abs(Number(entity.speedFraction) - speed) > 1e-6) {
    if (!scene.orbitShipEntity(entity, target.itemID, range, { speedFraction: speed })) {
      return { success: false, errorMsg: "DUNGEON_COMPANION_ORBIT_REFUSED" };
    }
  }
  controller.anchorID = target.itemID;
  entity.anchorID = target.itemID;
  controller.behaviorOverrides = { ...controller.behaviorOverrides, idleAnchorOrbit: true,
    idleAnchorOrbitDistanceMeters: range, returnToHomeWhenIdle: false,
    autoAggro: false, autoActivateWeapons: false };
  controller.manualOrder = null;
  controller.currentTargetID = 0;
  controller.preferredTargetID = 0;
  controller.returningHome = false;
  return { success: true, duplicate: samePolicy };
}

function registerNativeRuntimeController(entityRecord, controllerRecord, definition) {
  const runtimeKind = String(controllerRecord && controllerRecord.runtimeKind || "nativeAmbient").trim() || "nativeAmbient";
  return registerController({
    ...cloneValue(controllerRecord),
    behaviorProfile: cloneValue(definition && definition.behaviorProfile || {}),
    behaviorOverrides: normalizeBehaviorOverrides(
      isDestructibleNpcSentry(entityRecord) || isEmpireSentry(entityRecord)
        ? buildNpcSentryBehaviorOverrides(controllerRecord.behaviorOverrides)
        : controllerRecord.behaviorOverrides,
    ),
    preferredTargetID: toPositiveInt(controllerRecord.preferredTargetID, 0),
    currentTargetID: toPositiveInt(controllerRecord.currentTargetID, 0),
    ownerCharacterID: 0,
    entityType: entityRecord.npcEntityType,
    capitalNpc: entityRecord.capitalNpc === true,
    capitalClassID: entityRecord.capitalClassID || null,
    capitalRarity: entityRecord.capitalRarity || null,
    runtimeKind,
    controllerPaused: controllerRecord && controllerRecord.controllerPaused === true,
    controllerLifecycleState:
      String(controllerRecord && controllerRecord.controllerLifecycleState || "").trim() ||
      (controllerRecord && controllerRecord.controllerPaused === true ? "materialized_paused" : "active"),
    pausedReason: String(controllerRecord && controllerRecord.pausedReason || "").trim(),
    nextThinkAtMs:
      runtimeKind === "nativeAmbient"
        ? Number.MAX_SAFE_INTEGER
        : Math.max(0, toFiniteNumber(controllerRecord && controllerRecord.nextThinkAtMs, 0)),
    manualOrder: null,
    lastHomeCommandAtMs: 0,
    lastHomeDirection: null,
    returningHome: false,
  });
}

function materializeNativeRuntimeEntity(scene, entityRecord, controllerRecord, definition, options = {}) {
  const storedScopeResolution = nativeNpcStore.validateStoredEntityScopeMetadata(
    entityRecord,
  );
  if (!storedScopeResolution.success) {
    return {
      success: false,
      errorMsg: storedScopeResolution.errorMsg,
    };
  }
  const runtimeKind = String(controllerRecord && controllerRecord.runtimeKind || "nativeAmbient").trim() || "nativeAmbient";
  const existingEntity = scene.getEntityByID(entityRecord.entityID);
  const scopeResolution = existingEntity
    ? nativeNpcStore.resolveStoredEntityScopeMetadata([
        entityRecord,
        existingEntity,
      ])
    : storedScopeResolution;
  if (!scopeResolution.success) {
    return {
      success: false,
      errorMsg: scopeResolution.errorMsg,
    };
  }
  // Older saved civilians can still have the default hostile NPC presentation.
  const friendlyPresentation = require("../../services/incursion/incursionFriendlyActors").npcPresentationOverrides(entityRecord) ||
    require("../../services/dungeon/careerLessonRuntime").npcPresentationOverrides(entityRecord);
  if (friendlyPresentation) entityRecord = { ...entityRecord, ...friendlyPresentation };
  const entityScopeMetadata = scopeResolution.data.metadata;
  if (existingEntity) {
    const controller = registerNativeRuntimeController(entityRecord, controllerRecord, definition);
    applyNativeRuntimeNpcPresentation(existingEntity, entityRecord, definition);
    if (typeof spaceRuntime.applyRuntimeEntityScopeMetadata === "function") {
      spaceRuntime.applyRuntimeEntityScopeMetadata(
        existingEntity,
        entityScopeMetadata,
      );
    }
    if (runtimeKind === "nativeAmbient") {
      syncNativeAmbientIdleState(scene, existingEntity, controller, definition);
    }
    return {
      success: true,
      data: {
        entity: existingEntity,
        controller,
      },
    };
  }

  // Native birth remains durable at its intended landing pose. Only the live
  // projection starts off-grid; a cold recovery can then recover the same NPC
  // at its destination without recreating its birth or replaying its arrival.
  const warpLanding = options.warpIn === true ? cloneVector(entityRecord.position) : null;
  const warpOrigin = warpLanding
    ? require("./npcWarpOrigins").findSafeWarpOriginAnchor(scene, entityRecord)
    : null;
  const spawnResult = spaceRuntime.spawnDynamicShip(
    scene.sceneDescriptor || scene.systemID,
    buildNativeRuntimeShipSpec(entityRecord),
    {
      sceneDescriptor: scene.sceneDescriptor || undefined,
      persistSpaceState: false,
      broadcast: warpLanding ? false : options.broadcast !== false,
      initialPublication: options.initialPublication,
      suppressInitialPublication: options.suppressInitialPublication === true,
      runtimeEntityMetadata: warpLanding ? {
        ...options.runtimeEntityMetadata,
        position: warpOrigin.position,
        velocity: { x: 0, y: 0, z: 0 },
        direction: warpOrigin.direction,
        targetPoint: warpOrigin.position,
        mode: "STOP",
        speedFraction: 0,
        nativeNpcInitialWarpLanding: { position: warpLanding, pending: true },
      } : options.runtimeEntityMetadata,
      excludedSession: options.excludedSession || null,
      entityScopeMetadata,
    },
  );
  if (!spawnResult.success || !spawnResult.data || !spawnResult.data.entity) {
    return {
      success: false,
      errorMsg: spawnResult.errorMsg || "NPC_NATIVE_RUNTIME_SPAWN_FAILED",
    };
  }

  const entity = applyNativeRuntimeNpcPresentation(
    spawnResult.data.entity,
    entityRecord,
    definition,
  );
  const controller = registerNativeRuntimeController(entityRecord, controllerRecord, definition);
  if (runtimeKind === "nativeAmbient") {
    syncNativeAmbientIdleState(scene, entity, controller, definition);
  }
  let warpIngress;
  if (warpLanding) {
    const removeFailedProjection = (failure) => {
      if (scene.getEntityByID(entity.itemID) === entity) {
        scene.removeDynamicEntity(entity.itemID, { broadcast: false, persistSpaceState: false });
        unregisterController(entity.itemID);
      }
      if (typeof options.onWarpInRefused === "function") options.onWarpInRefused(failure);
    };
    let warpResult;
    try {
      warpResult = require("./npcRuntime").warpToPoint(entity.itemID, warpLanding, {
        forceImmediateStart: true,
        useNativeWarpProfile: true,
        suppressCompletionStopUpdates: true,
        stopDistance: 0,
        onRefusedWhenApplied: removeFailedProjection,
      });
    } catch (error) {
      warpResult = { success: false, errorMsg: error.message || "NPC_WARP_INGRESS_FAILED" };
    }
    if (!warpResult.success) {
      removeFailedProjection(warpResult);
      return warpResult;
    }
    // Keep the identity of this ingress, not just a destination that a later
    // AI warp might also use. A queued order has no destination object yet.
    entity.nativeNpcInitialWarpLanding.pending = entity.mode !== "WARP";
    entity.nativeNpcInitialWarpLanding.warpDestination = entity.warpDestination;
    warpIngress = warpResult.data;
  }
  return {
    success: true,
    data: {
      entity,
      controller,
      ...(warpIngress ? { warpIngress } : {}),
    },
  };
}

function materializeStoredNativeController(scene, entityID, options = {}) {
  if (!scene) {
    return {
      success: false,
      errorMsg: "SCENE_NOT_FOUND",
    };
  }

  const normalizedEntityID = toPositiveInt(entityID, 0);
  if (!normalizedEntityID) {
    return {
      success: false,
      errorMsg: "NPC_NOT_FOUND",
    };
  }
  const entityRecord = nativeNpcStore.getNativeEntity(normalizedEntityID);
  if (entityRecord?.nativeDeathWreck) {
    const settled = require("./nativeNpcDeathWrecks").settle(scene, entityRecord);
    return settled.success
      ? { success: true, data: { entity: null, controller: null, retired: true } }
      : settled;
  }
  const controllerRecord = nativeNpcStore.getNativeController(normalizedEntityID);
  if (!entityRecord || !controllerRecord) {
    return {
      success: false,
      errorMsg: "NPC_NOT_FOUND",
    };
  }
  if (isRequiredActorRecord(entityRecord)) {
    const instance = require("../../services/dungeon/dungeonRuntime").getInstance(entityRecord.dungeonSiteInstanceID);
    const retired = instance?.spawnState?.requiredActorRetirements?.[entityRecord.dungeonSiteContentKey];
    if (!instance || entityRecord.dungeonSiteContentRole !== REQUIRED_ACTOR_ACTIVE ||
        retired || Number(entityRecord.conditionState?.damage) >= 1) {
      return { success: false, errorMsg: "REQUIRED_ACTOR_NOT_ACTIVE" };
    }
  }
  const sceneAuthority = validateStoredNativeControllerSceneAuthority(
    scene,
    entityRecord,
    controllerRecord,
  );
  if (!sceneAuthority.success) {
    return sceneAuthority;
  }
  const scopeResolution = nativeNpcStore.validateStoredEntityScopeMetadata(
    entityRecord,
  );
  if (!scopeResolution.success) {
    return {
      success: false,
      errorMsg: scopeResolution.errorMsg,
    };
  }

  const definition =
    buildNpcDefinition(controllerRecord.profileID) ||
    (
      controllerRecord.definitionSnapshot &&
      typeof controllerRecord.definitionSnapshot === "object"
        ? cloneValue(controllerRecord.definitionSnapshot)
        : null
    );
  if (!definition) {
    if (isTransientStartupControllerRecord(entityRecord, controllerRecord)) {
      return pruneInvalidStoredStartupController(entityRecord, controllerRecord);
    }
    return {
      success: false,
      errorMsg: "NPC_DEFINITION_INCOMPLETE",
    };
  }

  return materializeNativeRuntimeEntity(
    scene,
    entityRecord,
    controllerRecord,
    definition,
    options,
  );
}

function buildStoredEntityRecordFromRuntimeEntity(entityRecord, runtimeEntity) {
  // A scene can be collected during the initial ingress. The native store
  // does not serialize the Destiny warp curve, so persisting its off-grid
  // intermediate pose would strand this NPC after the next materialization.
  const ingress = runtimeEntity?.nativeNpcInitialWarpLanding;
  const destination = runtimeEntity?.warpDestination;
  const sameQueuedDestination = ingress?.pending && destination &&
    ["x", "y", "z"].every(axis => destination.targetPoint?.[axis] === ingress.position[axis]);
  const initialWarp = ingress && (runtimeEntity.mode === "WARP" &&
    (ingress.warpDestination === destination || sameQueuedDestination) ||
    ingress.pending && runtimeEntity.mode === "STOP" && !destination);
  const warpLanding = initialWarp ? ingress.position : null;
  return {
    ...cloneValue(entityRecord || {}),
    position: cloneVector(warpLanding || runtimeEntity && runtimeEntity.position),
    velocity: warpLanding ? { x: 0, y: 0, z: 0 } : cloneVector(runtimeEntity && runtimeEntity.velocity),
    direction: normalizeVector(
      runtimeEntity && runtimeEntity.direction,
      entityRecord && entityRecord.direction,
    ),
    targetPoint: cloneVector(
      warpLanding || runtimeEntity && runtimeEntity.targetPoint,
      runtimeEntity && runtimeEntity.position,
    ),
    mode: warpLanding ? "STOP" : String(
      (runtimeEntity && runtimeEntity.mode) ||
        (entityRecord && entityRecord.mode) ||
        "STOP",
    ),
    speedFraction: warpLanding ? 0 : toFiniteNumber(
      runtimeEntity && runtimeEntity.speedFraction,
      entityRecord && entityRecord.speedFraction,
    ),
    conditionState: cloneValue(
      (runtimeEntity && runtimeEntity.conditionState) ||
        (entityRecord && entityRecord.conditionState) ||
        {},
    ),
  };
}

function buildStoredControllerRecordFromRuntimeController(controllerRecord, runtimeController) {
  const runtimeKind =
    String(
      (runtimeController && runtimeController.runtimeKind) ||
        (controllerRecord && controllerRecord.runtimeKind) ||
        "nativeAmbient",
    ).trim() || "nativeAmbient";
  return {
    ...cloneValue(controllerRecord || {}),
    definitionSnapshot:
      runtimeController && runtimeController.definitionSnapshot
        ? cloneValue(runtimeController.definitionSnapshot)
        : cloneValue(controllerRecord && controllerRecord.definitionSnapshot || null),
    behaviorOverrides: normalizeBehaviorOverrides(
      (runtimeController && runtimeController.behaviorOverrides) ||
        (controllerRecord && controllerRecord.behaviorOverrides),
    ),
    preferredTargetID: toPositiveInt(
      runtimeController && runtimeController.preferredTargetID,
      toPositiveInt(controllerRecord && controllerRecord.preferredTargetID, 0),
    ),
    currentTargetID: toPositiveInt(
      runtimeController && runtimeController.currentTargetID,
      0,
    ),
    preferredTargetOwnerID: toPositiveInt(
      runtimeController && runtimeController.preferredTargetOwnerID,
      toPositiveInt(controllerRecord && controllerRecord.preferredTargetOwnerID, 0),
    ),
    lastAggressorID: toPositiveInt(
      runtimeController && runtimeController.lastAggressorID,
      toPositiveInt(controllerRecord && controllerRecord.lastAggressorID, 0),
    ),
    lastAggressorOwnerID: toPositiveInt(
      runtimeController && runtimeController.lastAggressorOwnerID,
      toPositiveInt(controllerRecord && controllerRecord.lastAggressorOwnerID, 0),
    ),
    lastAggressedAtMs: Math.max(
      0,
      toFiniteNumber(
        runtimeController && runtimeController.lastAggressedAtMs,
        controllerRecord && controllerRecord.lastAggressedAtMs,
      ),
    ),
    drifterCombatState:
      runtimeController && runtimeController.drifterCombatState
        ? cloneValue(runtimeController.drifterCombatState)
        : cloneValue(controllerRecord && controllerRecord.drifterCombatState || null),
    runtimeKind,
    homePosition: cloneVector(
      runtimeController && runtimeController.homePosition,
      controllerRecord && controllerRecord.homePosition,
    ),
    homeDirection: cloneVector(
      runtimeController && runtimeController.homeDirection,
      controllerRecord && controllerRecord.homeDirection
        ? controllerRecord.homeDirection
        : { x: 1, y: 0, z: 0 },
    ),
    nextThinkAtMs:
      runtimeKind === "nativeAmbient"
        ? Number.MAX_SAFE_INTEGER
        : Math.max(
            0,
            toFiniteNumber(
              runtimeController && runtimeController.nextThinkAtMs,
              controllerRecord && controllerRecord.nextThinkAtMs,
            ),
          ),
    lastHomeCommandAtMs: toFiniteNumber(
      runtimeController && runtimeController.lastHomeCommandAtMs,
      controllerRecord && controllerRecord.lastHomeCommandAtMs,
    ),
    lastHomeDirection:
      runtimeController && runtimeController.lastHomeDirection
        ? cloneVector(runtimeController.lastHomeDirection)
        : cloneValue(controllerRecord && controllerRecord.lastHomeDirection),
    returningHome: runtimeController && runtimeController.returningHome === true,
    manualOrder:
      runtimeController && runtimeController.manualOrder
        ? cloneValue(runtimeController.manualOrder)
        : null,
  };
}

const REQUIRED_ACTOR_PREPARING = "required_actor_preparing";
const REQUIRED_ACTOR_ACTIVE = "required_actor";

// The admitted encounter assigns this binding at birth. Unrelated native NPCs
// retain their existing persistence lifecycle and never acquire this outbox.
function bindNpcOperation(entity, operationID) {
  const database = require("../../gameStore");
  const stored = nativeNpcStore.getNativeEntity(entity?.itemID);
  if (!entity?.nativeNpc || !stored || !/^[A-Za-z0-9:_-]{1,180}$/.test(operationID || "") ||
      !(Number(entity.dungeonSiteInstanceID) > 0) || !entity.dungeonSiteContentKey ||
      Number(stored.typeID) !== Number(entity.typeID) ||
      Number(stored.dungeonSiteInstanceID) !== Number(entity.dungeonSiteInstanceID) ||
      stored.dungeonSiteContentKey !== entity.dungeonSiteContentKey ||
      stored.incursionOperationID && stored.incursionOperationID !== operationID) {
    return { success: false, errorMsg: "INCURSION_NPC_BINDING_MISMATCH" };
  }
  const result = nativeNpcStore.upsertNativeEntity({ ...buildStoredEntityRecordFromRuntimeEntity(stored, entity),
    incursionOperationID: operationID, transient: false }, { transient: false });
  if (!result.success) return result;
  database.setTransientPath("npcEntities", `/entities/${entity.itemID}`, false);
  const flushed = database.flushTableSync("npcEntities");
  if (!flushed.success) return { ...flushed, errorMsg: "INCURSION_NPC_BINDING_PENDING" };
  entity.incursionOperationID = operationID;
  return { success: true, durable: true };
}

function commitIncursionDamageOutcome({ scene, entity, sourceEntity, event, previousConditionState } = {}) {
  if (!entity?.incursionOperationID) return { success: true, handled: false };
  const database = require("../../gameStore"), carrier = require("../../services/inventory/incursionCombatOutcomes");
  let accepted = false;
  const refuse = errorMsg => {
    if (!accepted && previousConditionState) entity.conditionState = cloneValue(previousConditionState);
    return { success: false, handled: true, accepted, errorMsg };
  };
  try {
    if (!previousConditionState) return refuse("INCURSION_NPC_HEALTH_PREIMAGE_REQUIRED");
    const normalized = carrier.normalizeEvent({ ...event, destroyed: Number(entity.conditionState?.damage) >= 1 });
    if (normalized.kind !== "damage" || normalized.operationID !== entity.incursionOperationID ||
        Number(entity.dungeonSiteInstanceID) !== normalized.instanceID ||
        Number(entity.itemID) !== normalized.targetEntityID || Number(entity.typeID) !== normalized.targetTypeID ||
        entity.dungeonSiteContentKey !== normalized.targetKey || normalized.targetCharacterID !== 0) {
      return refuse("INCURSION_NPC_OUTCOME_SCOPE_MISMATCH");
    }
    const key = carrier.storageKey(normalized.eventID), raw = database.read("npcEntities", "/");
    if (!raw.success) return refuse(raw.errorMsg);
    const root = raw.data, ledger = root.incursionOutcomes || {}, existing = ledger[key];
    if (existing) {
      if (!require("node:util").isDeepStrictEqual(existing.event, normalized)) return refuse("INCURSION_COMBAT_OUTCOME_CONFLICT");
      accepted = true;
      const live = nativeNpcStore.getNativeEntity(entity.itemID);
      entity.conditionState = cloneValue(live?.conditionState || existing.conditionState);
      const flushed = database.flushTableSync("npcEntities");
      return { success: true, handled: true, accepted: true, duplicate: true,
        durable: flushed.success === true, pending: flushed.success !== true, receipt: cloneValue(existing) };
    }
    const stored = nativeNpcStore.getNativeEntity(entity.itemID);
    if (!entity.nativeNpc || !stored || stored.incursionOperationID !== normalized.operationID ||
        Number(stored.typeID) !== normalized.targetTypeID || Number(stored.dungeonSiteInstanceID) !== normalized.instanceID ||
        stored.dungeonSiteContentKey !== normalized.targetKey || stored.transient !== false ||
        database.isTransientPath("npcEntities", `/entities/${entity.itemID}`)) return refuse("INCURSION_NPC_OUTCOME_OWNER_MISMATCH");
    if (normalized.deathPosition && ["x", "y", "z"].some(axis => normalized.deathPosition[axis] !== entity.position?.[axis]))
      return refuse("INCURSION_DEATH_POSITION_MISMATCH");
    if (stored.incursionDeathEventID) {
      // A retry of the original event returned above. A new event ID cannot
      // create another wreck for an already committed native death.
      entity.conditionState = cloneValue(stored.conditionState);
      return { success: false, handled: true, accepted: false, errorMsg: "INCURSION_NPC_DEATH_ALREADY_COMMITTED" };
    }
    const outcomeCount = Object.values(ledger).filter(row => row.event?.operationID === normalized.operationID).length;
    if (outcomeCount >= 65536)
      return refuse("INCURSION_COMBAT_OUTCOME_CAPACITY");
    // Same-tick kills need the health owner's commit order, not event-ID or
    // projection order, to locate the last destroyed member of a drop group.
    const after = buildStoredEntityRecordFromRuntimeEntity(stored, entity);
    const deathWreckPlan = require("./incursionDeathWrecks").prepare({ scene, entity, sourceEntity, stored: after, event: normalized });
    const receipt = { version: 1, event: normalized, acknowledged: false, conditionState: cloneValue(entity.conditionState),
      ...(deathWreckPlan ? { deathWreckPlan } : {}),
      ...(normalized.deathPosition ? { ordinal: outcomeCount + 1 } : {}) };
    const next = { ...root, entities: { ...root.entities,
      [entity.itemID]: { ...after, ...(deathWreckPlan ? { incursionDeathEventID: normalized.eventID } : {}) } },
    incursionOutcomes: { ...ledger, [key]: receipt } };
    const saved = database.write("npcEntities", "/", next, { knownChangedPaths: [`/entities/${entity.itemID}`, `/incursionOutcomes/${key}`] });
    if (!saved.success) return refuse(saved.errorMsg || "INCURSION_COMBAT_WRITE_FAILED");
    accepted = true;
    const flushed = database.flushTableSync("npcEntities");
    return { success: true, handled: true, accepted: true, duplicate: false,
      durable: flushed.success === true, pending: flushed.success !== true, receipt: cloneValue(receipt) };
  } catch (error) {
    if (accepted) return { success: true, handled: true, accepted: true, durable: false, pending: true, errorMsg: error.message };
    return refuse(error.message);
  }
}

function isRequiredActorRecord(record) {
  return record?.transient === false && record.dungeonMaterializedSiteContent === true &&
    [REQUIRED_ACTOR_PREPARING, REQUIRED_ACTOR_ACTIVE].includes(record.dungeonSiteContentRole);
}

// The same native-NPC table owns the support cadence, frozen pulse recipients
// and their HP. Retaining only the latest cycle per source bounds this journal;
// old cycle callbacks are fenced, and offline time never queues a heal backlog.
function readNativeNpcAbilityState(entityID) {
  const result = require("../../gameStore").read("npcEntities", `/nativeAbilityState/${Number(entityID)}`);
  return result.success && result.data ? cloneValue(result.data) : null;
}
function reserveNativeNpcAbilityCycle({ scene, source, effectID, nowMs, targetIDs = [], random = Math.random } = {}) {
  const policy = require("./nativeNpcAbilities"), database = require("../../gameStore");
  try {
    if (!policy.live(source) || !source.nativeNpc || scene?.getEntityByID?.(source.itemID) !== source ||
        !Number.isSafeInteger(nowMs) || nowMs <= 0) throw new Error("NPC_ABILITY_SOURCE_INVALID");
    const inputs = effectID === 3855 ? policy.shieldInputs(source)
      : effectID === 4656 ? policy.ecmInputs(source, policy.bossPlayers(scene, source).length) : null;
    if (!inputs) throw new Error("NPC_ABILITY_POLICY_INVALID");
    const raw = database.read("npcEntities", "/");
    if (!raw.success) throw new Error(raw.errorMsg);
    const root = raw.data, stored = root.entities?.[source.itemID];
    if (!stored || stored.transient === true) return { success: true, handled: false, inputs };
    if (Number(stored.typeID) !== Number(source.typeID) || Number(stored.systemID) !== Number(scene.systemID) ||
        Number(stored.dungeonSiteInstanceID || 0) !== Number(source.dungeonSiteInstanceID || 0)) throw new Error("NPC_ABILITY_OWNER_MISMATCH");
    const states = root.nativeAbilityState || {}, state = cloneValue(states[source.itemID] || {});
    const key = String(effectID), prior = state[key];
    if (prior && (prior.version !== inputs.version || prior.typeID !== Number(source.typeID))) throw new Error("NPC_ABILITY_IDENTITY_CONFLICT");
    if (prior && (nowMs < prior.nextAtMs || nowMs <= prior.atMs)) {
      const sameCycle = nowMs === prior.atMs;
      const flushed = database.flushTableSync("npcEntities");
      return { success: true, handled: true, durable: flushed.success === true,
        pending: flushed.success !== true, duplicate: !sameCycle, cycle: sameCycle ? cloneValue(prior) : null, inputs };
    }
    if (effectID === 3855 && (!Array.isArray(targetIDs) || targetIDs.length > inputs.maxTargets ||
        new Set(targetIDs).size !== targetIDs.length || targetIDs.some(id => !Number.isSafeInteger(id) || id <= 0 ||
          !policy.shieldEligible(source, scene.getEntityByID(id), inputs)))) throw new Error("NPC_SHIELD_RECIPIENTS_INVALID");
    // The first ECM activation only arms its interval. Subsequent reservations
    // occur before lock-break publication. A crash can skip a transient burst,
    // but cannot restart its timer or replay a catch-up storm on reconnect.
    const armedOnly = effectID === 4656 && !prior;
    const fired = !armedOnly && (inputs.chance >= 1 || inputs.chance > 0 && Number(random()) < inputs.chance);
    const cycle = { version: inputs.version, typeID: Number(source.typeID), effectID, atMs: nowMs,
      nextAtMs: nowMs + inputs.durationMs, fired, armedOnly,
      targetIDs: effectID === 3855 && fired ? [...targetIDs] : [], applied: {} };
    state[key] = cycle;
    const saved = database.write("npcEntities", "/", { ...root, nativeAbilityState: { ...states, [source.itemID]: state } },
      { knownChangedPaths: [`/nativeAbilityState/${source.itemID}`] });
    if (!saved.success) throw new Error(saved.errorMsg || "NPC_ABILITY_WRITE_FAILED");
    const flushed = database.flushTableSync("npcEntities");
    return { success: true, handled: true, durable: flushed.success === true, pending: flushed.success !== true,
      duplicate: false, inputs, cycle: cloneValue(cycle) };
  } catch (error) { return { success: false, handled: true, errorMsg: error.message }; }
}
function commitNativeNpcShieldRepair({ scene, source, target, cycleAtMs, previousConditionState } = {}) {
  const database = require("../../gameStore");
  let accepted = false;
  try {
    const policy = require("./nativeNpcAbilities"), inputs = policy.shieldInputs(source);
    if (!inputs || !policy.live(source) || !policy.live(target) || !target?.nativeNpc || !previousConditionState ||
        scene?.getEntityByID?.(source.itemID) !== source || scene?.getEntityByID?.(target.itemID) !== target ||
        !policy.sameScope(source, target)) throw new Error("NPC_SHIELD_REPAIR_SCOPE_INVALID");
    const raw = database.read("npcEntities", "/");
    if (!raw.success) throw new Error(raw.errorMsg);
    const root = raw.data, sourceRecord = root.entities?.[source.itemID], stored = root.entities?.[target.itemID];
    if (!sourceRecord || sourceRecord.transient === true || !stored || stored.transient === true) return { success: true, handled: false };
    if (Number(sourceRecord.typeID) !== Number(source.typeID) || Number(sourceRecord.systemID) !== Number(scene.systemID) ||
        Number(sourceRecord.dungeonSiteInstanceID || 0) !== Number(source.dungeonSiteInstanceID || 0)) throw new Error("NPC_SHIELD_REPAIR_SOURCE_MISMATCH");
    const state = root.nativeAbilityState?.[source.itemID], cycle = state?.[3855];
    if (!cycle || cycle.version !== inputs.version || cycle.typeID !== Number(source.typeID) || !cycle.fired ||
        cycle.atMs !== cycleAtMs || !cycle.targetIDs.includes(Number(target.itemID))) {
      // A completed newer pulse is a fence, never permission to apply an old HP
      // preimage. Restore the current owner state rather than a stale caller.
      target.conditionState = cloneValue(stored.conditionState);
      return { success: true, handled: true, duplicate: true, durable: true };
    }
    if (cycle.applied[target.itemID]) {
      target.conditionState = cloneValue(stored.conditionState);
      const flushed = database.flushTableSync("npcEntities");
      return { success: true, handled: true, duplicate: true, durable: flushed.success === true, pending: !flushed.success };
    }
    if (Number(stored.typeID) !== Number(target.typeID) || Number(stored.systemID) !== Number(scene.systemID) ||
        Number(stored.dungeonSiteInstanceID || 0) !== Number(target.dungeonSiteInstanceID || 0)) throw new Error("NPC_SHIELD_REPAIR_OWNER_MISMATCH");
    const before = Number(previousConditionState.shieldCharge), after = Number(target.conditionState?.shieldCharge);
    const capacity = Number(target.shieldCapacity), healed = (after - before) * capacity;
    if (!Number.isFinite(healed) || !(before >= 0 && before <= 1) || healed < -0.000001 || healed > inputs.amount + 0.000001 ||
        before >= 1 - inputs.damageThreshold || after > 1 ||
        ["armorDamage", "damage"].some(key => target.conditionState?.[key] !== previousConditionState[key])) throw new Error("NPC_SHIELD_REPAIR_AMOUNT_INVALID");
    const nextState = cloneValue(state);
    nextState[3855].applied[target.itemID] = { amount: Math.max(0, healed), atMs: cycleAtMs };
    const saved = database.write("npcEntities", "/", { ...root,
      entities: { ...root.entities, [target.itemID]: buildStoredEntityRecordFromRuntimeEntity(stored, target) },
      nativeAbilityState: { ...root.nativeAbilityState, [source.itemID]: nextState } },
    { knownChangedPaths: [`/entities/${target.itemID}`, `/nativeAbilityState/${source.itemID}`] });
    if (!saved.success) throw new Error(saved.errorMsg || "NPC_SHIELD_REPAIR_WRITE_FAILED");
    accepted = true;
    const flushed = database.flushTableSync("npcEntities");
    return { success: true, handled: true, accepted, duplicate: false, durable: flushed.success === true, pending: !flushed.success };
  } catch (error) {
    if (!accepted && target && previousConditionState) target.conditionState = cloneValue(previousConditionState);
    return { success: accepted, handled: true, accepted, pending: accepted, durable: false, errorMsg: error.message };
  }
}
function commitIncursionLogisticsRepair(request, calculate) {
  let accepted = false, held = false;
  const presentation = require("../../services/incursion/incursionRepairPresentation");
  try {
    const database = require("../../gameStore"), support = require("../../services/incursion/incursionLogisticsSupport");
    const scope = support.validateRequest(request);
    if (scope.pulse.domain !== "npc") throw new Error("INCURSION_SUPPORT_HEALTH_DOMAIN_INVALID");
    const raw = database.read("npcEntities", "/"); if (!raw.success) throw new Error(raw.errorMsg);
    const root = raw.data, ledger = root.incursionSupportHealth || {}, current = root.entities?.[request.targetID];
    const result = support.healthCommit(request, ledger[request.sourceKey], snapshot => {
      if (!current || Number(current.conditionState?.damage) >= 1 || current.transient !== false || Number(current.typeID) !== snapshot.typeID || Number(current.ownerID) !== snapshot.ownerID ||
          Number(current.systemID) !== scope.instance.solarSystemID || current.incursionOperationID !== scope.operation.identity.operationID ||
          current.dungeonMaterializedSiteContent !== true || current.dungeonSiteContentRole !== "required_actor" ||
          Number(current.dungeonSiteID) !== Number(scope.instance.metadata.siteID) ||
          current.dungeonSiteContentKey !== snapshot.actorKey || Number(current.dungeonSiteInstanceID) !== scope.instance.instanceID ||
          database.isTransientPath("npcEntities", `/entities/${request.targetID}`)) return { skipped: true };
      return calculate(current);
    });
    if (result.skipped) return { success: true, durable: true, skipped: true };
    if (!result.duplicate) {
      presentation.hold(request, scope.target, result.receipt.before); held = true;
      const saved = database.write("npcEntities", "/", { ...root,
        entities: { ...root.entities, [request.targetID]: { ...current, conditionState: cloneValue(result.receipt.after) } },
        incursionSupportHealth: { ...ledger, [request.sourceKey]: result.state } },
      { knownChangedPaths: [`/entities/${request.targetID}`, `/incursionSupportHealth/${request.sourceKey}`] });
      if (!saved.success) throw new Error(saved.errorMsg || "INCURSION_SUPPORT_HEALTH_WRITE_FAILED");
    }
    accepted = true;
    const flushed = database.flushTableSync("npcEntities");
    if (flushed.success) presentation.release(request);
    return { success: true, accepted, duplicate: result.duplicate, durable: flushed.success === true, pending: flushed.success !== true, receipt: result.receipt };
  } catch (error) { return { success: accepted, accepted, pending: accepted, errorMsg: error.message }; }
  finally { if (held && !accepted) presentation.release(request); }
}

function consumeNativeNpcBurst({ scene, source, cycleAtMs } = {}) {
  try {
    const database = require("../../gameStore"), policy = require("./nativeNpcAbilities");
    if (!policy.bossEnabled(source) || !policy.live(source) || scene?.getEntityByID?.(source.itemID) !== source) throw new Error("NPC_BURST_SOURCE_INVALID");
    const raw = database.read("npcEntities", "/");
    if (!raw.success) throw new Error(raw.errorMsg);
    const root = raw.data, state = root.nativeAbilityState?.[source.itemID], cycle = state?.[4656];
    if (!cycle || cycle.version !== policy.BOSS_VERSION || cycle.atMs !== cycleAtMs || !cycle.fired || cycle.published) {
      return { success: true, duplicate: true, consumed: false };
    }
    const next = cloneValue(state); next[4656].published = true;
    const saved = database.write("npcEntities", "/", { ...root,
      nativeAbilityState: { ...root.nativeAbilityState, [source.itemID]: next } },
    { knownChangedPaths: [`/nativeAbilityState/${source.itemID}`] });
    if (!saved.success) throw new Error(saved.errorMsg);
    const flushed = database.flushTableSync("npcEntities");
    return { success: flushed.success === true, consumed: flushed.success === true,
      pending: flushed.success !== true, errorMsg: flushed.success ? undefined : "NPC_BURST_COMMIT_PENDING" };
  } catch (error) { return { success: false, consumed: false, errorMsg: error.message }; }
}

// Only the dungeon owner assigns this scoped role to declared required arc
// actors. Health remains owned by native NPC rows, not inventory ships.
function persistRequiredDungeonActor(entity, options = {}) {
  const entityID = toPositiveInt(entity?.itemID, 0);
  const record = nativeNpcStore.getNativeEntity(entityID);
  const storedController = nativeNpcStore.getNativeController(entityID);
  const scene = spaceRuntime.findSceneContainingDynamicEntity(entityID);
  if (!isRequiredActorRecord(record) || !storedController || storedController.transient === true ||
      !scene || scene.getEntityByID(entityID) !== entity || entity.nativeNpc !== true ||
      record.dungeonSiteContentRole !== entity.dungeonSiteContentRole ||
      Number(record.typeID) !== Number(entity.typeID) ||
      Number(record.dungeonSiteInstanceID) !== Number(entity.dungeonSiteInstanceID) ||
      Number(record.dungeonSiteID) !== Number(entity.dungeonSiteID) ||
      record.dungeonSiteContentKey !== entity.dungeonSiteContentKey ||
      record.dungeonSiteContentRole === REQUIRED_ACTOR_PREPARING && options.birth !== true) {
    return { success: false, errorMsg: "REQUIRED_ACTOR_OWNER_MISMATCH" };
  }
  if (record.dungeonSiteContentRole === REQUIRED_ACTOR_ACTIVE && Number(entity.conditionState?.damage) >= 1) {
    // Commit the existing required-actor terminal journal before making fatal
    // native health durable. Cold recovery may finish deletion from this proof;
    // an absent or merely damaged native row never supplies a death receipt.
    const retirement = retireRequiredDungeonActor(entity, "destroyed", scene.getCurrentSimTimeMs());
    if (!retirement.success) return retirement;
  }
  const entityResult = nativeNpcStore.upsertNativeEntity(
    buildStoredEntityRecordFromRuntimeEntity(record, entity), { transient: false });
  if (!entityResult.success) return entityResult;
  const controllerResult = nativeNpcStore.upsertNativeController(
    buildStoredControllerRecordFromRuntimeController(storedController,
      getControllerByEntityID(entityID) || storedController), { transient: false });
  if (!controllerResult.success) return controllerResult;
  const tables = ["npcEntities", "npcRuntimeControllers"];
  if (options.birth === true) tables.push("npcModules", "npcCargo");
  const flushed = require("../../gameStore").flushTablesSync(tables);
  if (!flushed.success) return { ...flushed, errorMsg: "REQUIRED_ACTOR_NATIVE_FLUSH_PENDING" };
  if (options.birth === true) {
    // A preparing row is not proof of a completed native birth. Promote only
    // after its whole native bundle is durable, before encounter publication.
    const activated = nativeNpcStore.upsertNativeEntity({
      ...nativeNpcStore.getNativeEntity(entityID), dungeonSiteContentRole: REQUIRED_ACTOR_ACTIVE,
    }, { transient: false });
    if (!activated.success) return activated;
    const committed = require("../../gameStore").flushTableSync("npcEntities");
    if (!committed.success) return committed;
    entity.dungeonSiteContentRole = REQUIRED_ACTOR_ACTIVE;
  }
  return { success: true, durable: true };
}

function retireRequiredDungeonActor(entityOrRecord, reason, nowMs = Date.now()) {
  const entityID = toPositiveInt(entityOrRecord?.itemID || entityOrRecord?.entityID, 0);
  const record = nativeNpcStore.getNativeEntity(entityID);
  if (!isRequiredActorRecord(record)) return { success: true, handled: false };
  const runtime = require("../../services/dungeon/dungeonRuntime");
  const instance = runtime.getInstance(record.dungeonSiteInstanceID);
  if (!instance || Number(instance.solarSystemID) !== Number(record.systemID) ||
      Number(instance.metadata?.siteID) !== Number(record.dungeonSiteID)) {
    return { success: false, errorMsg: "REQUIRED_ACTOR_INSTANCE_MISMATCH" };
  }
  const retired = { ...(instance.spawnState?.requiredActorRetirements || {}) };
  const existing = retired[record.dungeonSiteContentKey];
  if (existing && Number(existing.entityID) !== entityID) return { success: false, errorMsg: "REQUIRED_ACTOR_KEY_REUSED" };
  retired[record.dungeonSiteContentKey] = existing || { entityID, typeID: record.typeID,
    contentKey: record.dungeonSiteContentKey, reason, retiredAtMs: Math.max(1, Number(nowMs) || Date.now()) };
  try {
    runtime.mergeSpawnState(instance.instanceID, { requiredActorRetirements: retired },
      { durable: true, force: true, nowMs });
    return { success: true, handled: true };
  } catch (error) { return { success: false, errorMsg: error.message || "REQUIRED_ACTOR_RETIREMENT_PENDING" }; }
}

function dematerializeNativeController(controller, options = {}) {
  const entityID = toPositiveInt(
    controller && (controller.entityID || controller.itemID),
    0,
  );
  const systemID = toPositiveInt(controller && controller.systemID, 0);
  if (!entityID || !systemID) {
    return {
      success: false,
      errorMsg: "NPC_NOT_FOUND",
    };
  }

  const scene = spaceRuntime.ensureScene(systemID);
  const runtimeEntity = scene ? scene.getEntityByID(entityID) : null;
  const runtimeController = getControllerByEntityID(entityID) || controller || null;
  if (options.persistState !== false) {
    const storedEntityRecord = nativeNpcStore.getNativeEntity(entityID);
    const transient = !isRequiredActorRecord(storedEntityRecord) && storedEntityRecord?.transient !== false;
    if (storedEntityRecord && runtimeEntity) {
      nativeNpcStore.upsertNativeEntity(
        buildStoredEntityRecordFromRuntimeEntity(storedEntityRecord, runtimeEntity),
        {
          transient,
        },
      );
    }

    const storedControllerRecord = nativeNpcStore.getNativeController(entityID);
    if (storedControllerRecord) {
      nativeNpcStore.upsertNativeController(
        buildStoredControllerRecordFromRuntimeController(
          storedControllerRecord,
          runtimeController,
        ),
        {
          transient,
        },
      );
    }
  }

  if (options.persistState !== false && runtimeEntity?.dungeonSiteContentRole === REQUIRED_ACTOR_ACTIVE) {
    const persisted = persistRequiredDungeonActor(runtimeEntity);
    if (!persisted.success) return persisted;
  }
  if (runtimeEntity) {
    spaceRuntime.removeDynamicEntity(systemID, entityID, {
      allowSessionOwned: true,
      broadcast: options.broadcast === true,
    });
  }
  unregisterController(entityID);
  return {
    success: true,
    data: {
      entityID,
      systemID,
      removedRuntimeEntity: Boolean(runtimeEntity),
    },
  };
}

function spawnNativeNpcEntityInContext(context, definition, options = {}) {
  const scopeResolution = nativeNpcStore.validateStoredEntityScopeMetadata(
    options.entityScopeMetadata,
  );
  if (!scopeResolution.success) {
    return {
      success: false,
      errorMsg: scopeResolution.errorMsg,
    };
  }
  const scene = context && context.scene
    ? context.scene
    : spaceRuntime.ensureScene(toPositiveInt(context && context.systemID, 0));
  if (!scene) {
    return {
      success: false,
      errorMsg: "SCENE_NOT_FOUND",
    };
  }

  const scenery = options[EMPIRE_SENTRY_MATERIALIZATION];
  if (scenery && (options.transient !== true ||
      scenery.kind !== "sentryGun" ||
      !EMPIRE_SENTRY_TYPE_IDS.has(Number(scenery.typeID)) ||
      Number(definition?.profile?.shipTypeID) !== Number(scenery.typeID) ||
      !Number.isSafeInteger(scenery.itemID) || scenery.itemID < 8_420_000_000_000_000 ||
      scenery.itemID >= 8_440_000_000_000_000 ||
      scene.staticEntitiesByID?.get(scenery.itemID) !== scenery ||
      scene.dynamicEntities?.has(scenery.itemID) ||
      nativeNpcStore.getNativeEntity(scenery.itemID))) {
    return { success: false, errorMsg: "EMPIRE_SENTRY_IDENTITY_INVALID" };
  }

  const hardwareValidation = validateNpcHardwareDefinition(definition);
  if (!hardwareValidation.success) {
    return hardwareValidation;
  }

  const spawnState = buildSpawnStateForDefinition(
    context && context.anchorEntity,
    definition,
    options,
  );
  const identity = buildNpcEntityIdentity(definition, {
    itemName: String(definition.profile.shipNameTemplate || definition.profile.name || "NPC"),
  });
  const ownerIDOverride = toPositiveInt(options.ownerIDOverride, 0);
  const hasSlimNameOverride = Object.prototype.hasOwnProperty.call(options, "slimNameOverride");
  const suppressSlimName = shouldSuppressNativeNpcSlimName(identity, options);
  const slimName = suppressSlimName
    ? ""
    : hasSlimNameOverride
      ? String(options.slimNameOverride || "")
      : identity.slimName;
  const nameIDOverride = toPositiveInt(options.nameIDOverride ?? options.nameID, 0);
  const entityIDResult = scenery
    ? { success: true, data: scenery.itemID }
    : nativeNpcStore.allocateEntityID({ transient: options.transient === true });
  if (!entityIDResult.success || !entityIDResult.data) {
    return entityIDResult;
  }

  const entityRecord = {
    entityID: entityIDResult.data,
    systemID: scene.systemID,
    sceneKey: String(scene.sceneKey || context.sceneKey || ""),
    sceneKind: String(scene.sceneKind || context.sceneKind || ""),
    instanceID: toPositiveInt(scene.instanceID, toPositiveInt(context.instanceID, 0)),
    locationID: toPositiveInt(
      scene.locationID,
      toPositiveInt(context.locationID, scene.systemID),
    ),
    profileID: definition.profile.profileID,
    loadoutID: definition.loadout.loadoutID,
    behaviorProfileID: definition.behaviorProfile.behaviorProfileID,
    lootTableID: definition.lootTable ? definition.lootTable.lootTableID : null,
    entityType: identity.npcEntityType,
    typeID: identity.typeID,
    groupID: identity.groupID,
    categoryID: identity.categoryID,
    itemName: String(definition.profile.shipNameTemplate || definition.profile.name || "NPC"),
    radius: identity.radius,
    slimTypeID: identity.slimTypeID,
    slimGroupID: identity.slimGroupID,
    slimCategoryID: identity.slimCategoryID,
    slimName,
    suppressSlimName,
    nameID: nameIDOverride || null,
    // fallbackOwnerID: the spawner's owner for a profile that names none (the ambient entity
    // profiles); the client counts an NPC as a hostile target only with an NPC owner.
    ownerID: ownerIDOverride || identity.ownerID || toPositiveInt(options.fallbackOwnerID, 0),
    corporationID: identity.corporationID,
    allianceID: identity.allianceID,
    warFactionID: identity.warFactionID,
    securityStatus: identity.securityStatus,
    bounty: identity.bounty,
    npcEntityType: identity.npcEntityType,
    capitalNpc: definition.profile.capitalNpc === true,
    capitalClassID: String(definition.profile.capitalClassID || "").trim() || null,
    capitalRarity: String(definition.profile.capitalRarity || "").trim() || null,
    hostileResponseThreshold: identity.hostileResponseThreshold,
    friendlyResponseThreshold: identity.friendlyResponseThreshold,
    nativeNpc: true,
    ...(scenery ? { empireSentry: true } : {}),
    nativeNpcOccupied: true,
    transient: options.transient === true,
    selectionKind: String(options.selectionKind || "").trim() || null,
    selectionID: String(options.selectionID || "").trim() || null,
    selectionName: String(options.selectionName || "").trim() || null,
    spawnGroupID: String(options.spawnGroupID || "").trim() || null,
    spawnSiteID: String(options.spawnSiteID || "").trim() || null,
    startupRuleID: String(options.startupRuleID || "").trim() || null,
    operatorKind: String(options.operatorKind || "").trim() || null,
    anchorKind: String(options.anchorKind || context.anchorKind || "anchor"),
    anchorID: toPositiveInt(
      options.anchorID,
      toPositiveInt(context && context.anchorEntity && context.anchorEntity.itemID, 0),
    ),
    anchorName: String(
      options.anchorName ||
        context.anchorLabel ||
        (context.anchorEntity && context.anchorEntity.itemName) ||
        "Anchor",
    ),
    createdAtMs: scene.getCurrentSimTimeMs(),
    position: cloneVector(spawnState.position),
    velocity: cloneVector(spawnState.velocity),
    direction: normalizeVector(
      spawnState.direction,
      { x: 1, y: 0, z: 0 },
    ),
    targetPoint: cloneVector(spawnState.targetPoint || spawnState.position),
    mode: String(spawnState.mode || "STOP"),
    speedFraction: toFiniteNumber(spawnState.speedFraction, 0),
    targetEntityID: toPositiveInt(spawnState.targetEntityID, 0),
    followRange: Math.max(0, toFiniteNumber(spawnState.followRange, 0)),
    orbitDistance: Math.max(0, toFiniteNumber(spawnState.orbitDistance, 0)),
    maxVelocity: Math.max(0, toFiniteNumber(spawnState.maxVelocity, 0)),
    conditionState: {
      damage: 0,
      charge: 1,
      armorDamage: 0,
      shieldCharge: 1,
      incapacitated: false,
    },
    ...scopeResolution.data.metadata,
  };
  Object.assign(entityRecord, require("../../services/incursion/incursionFriendlyActors").npcPresentationOverrides(entityRecord),
    require("../../services/dungeon/careerLessonRuntime").npcPresentationOverrides(entityRecord));
  if (scenery) {
    entityRecord.radius = scenery.radius;
    entityRecord.bounty = 0;
    entityRecord.lootTableID = null;
  }
  if (isDestructibleNpcSentry(entityRecord) || isEmpireSentry(entityRecord)) {
    entityRecord.nativeNpcSentry = true;
    applyStationaryNpcSentryState(entityRecord);
  }
  const entityWriteResult = nativeNpcStore.upsertNativeEntity(entityRecord, {
    transient: options.transient === true,
  });
  if (!entityWriteResult.success) {
    return entityWriteResult;
  }

  const moduleResult = buildNativeModuleRecords(entityRecord, definition, options);
  if (!moduleResult.success) {
    nativeNpcStore.removeNativeEntityCascade(entityRecord.entityID);
    return moduleResult;
  }

  const cargoResult = buildNativeCargoRecords(
    entityRecord,
    moduleResult.data || [],
    definition,
    options,
  );
  if (!cargoResult.success) {
    nativeNpcStore.removeNativeEntityCascade(entityRecord.entityID);
    return cargoResult;
  }

  const controllerRecord = buildNativeControllerRecord(
    context,
    definition,
    entityRecord,
    spawnState,
    options,
  );
  const controllerWriteResult = nativeNpcStore.upsertNativeController(controllerRecord, {
    transient: options.transient === true,
  });
  if (!controllerWriteResult.success) {
    nativeNpcStore.removeNativeEntityCascade(entityRecord.entityID);
    return controllerWriteResult;
  }

  let materializeResult = {
    success: true,
    data: {
      entity: null,
      controller: null,
    },
  };
  if (options.materializeRuntime !== false) {
    try {
      if (scenery) {
        const removal = scene.removeStaticEntity(scenery.itemID, { broadcast: false });
        if (!removal.success) {
          nativeNpcStore.removeNativeEntityCascade(entityRecord.entityID);
          return removal;
        }
      }
      materializeResult = materializeNativeRuntimeEntity(
        scene,
        entityRecord,
        controllerRecord,
        definition,
        options,
      );
    } catch (error) {
      if (!scenery) throw error;
      materializeResult = { success: false,
        errorMsg: error.message || "EMPIRE_SENTRY_MATERIALIZATION_FAILED" };
    }
    if (!materializeResult.success || !materializeResult.data) {
      nativeNpcStore.removeNativeEntityCascade(entityRecord.entityID);
      if (scenery) {
        // A failed promotion must leave the original public scenery available.
        unregisterController(scenery.itemID);
        if (scene.dynamicEntities.has(scenery.itemID)) {
          scene.removeDynamicEntity(scenery.itemID, { broadcast: false });
        }
        scene.addStaticEntity(scenery);
      }
      return materializeResult;
    }

    if (scenery && scenery.targetedBy instanceof Set) {
      // Promotion keeps the same Ball: existing observers' incoming locks must
      // keep the matching reverse index on its new native runtime host.
      materializeResult.data.entity.targetedBy = scenery.targetedBy;
    }
    if (
      options.skipInitialBehaviorTick !== true &&
      options.deferInitialBehaviorTick !== true
    ) {
      tickBehaviorScene(
        scene,
        scene.getCurrentSimTimeMs(),
      );
    }
  }

  return {
    success: true,
    data: {
      entity: materializeResult.data.entity,
      controller: materializeResult.data.controller,
      virtualizedRuntime: options.materializeRuntime === false,
      entityRecord,
      shipItem: null,
      modules: moduleResult.data || [],
      fittedModules: moduleResult.data || [],
      cargo: cargoResult.data || [],
      lootEntries: [],
      definition,
    },
  };
}

function materializeEmpireSentry(scene, scenery) {
  if (!scene || !scenery) return { success: false, errorMsg: "EMPIRE_SENTRY_NOT_FOUND" };
  const existing = scene.dynamicEntities?.get(scenery.itemID);
  if (existing && isEmpireSentry(existing) && existing.nativeNpc === true) {
    return { success: true, data: { entity: existing,
      controller: getControllerByEntityID(existing.itemID), duplicate: true } };
  }
  if (scenery.empireSentry !== true || scenery.kind !== "sentryGun" ||
      !EMPIRE_SENTRY_TYPE_IDS.has(Number(scenery.typeID)) ||
      scene.staticEntitiesByID?.get(scenery.itemID) !== scenery) {
    return { success: false, errorMsg: "EMPIRE_SENTRY_IDENTITY_INVALID" };
  }
  const type = resolveItemByTypeID(scenery.typeID);
  const profile = type && resolveNpcProfile(type.name);
  const definition = profile?.success && buildNpcDefinition(profile.data.profileID);
  if (!definition || Number(definition.profile.shipTypeID) !== Number(scenery.typeID)) {
    return { success: false, errorMsg: "EMPIRE_SENTRY_PROFILE_MISSING" };
  }
  definition.profile = { ...definition.profile,
    corporationID: toPositiveInt(scenery.corporationID, 0),
    factionID: toPositiveInt(scenery.factionID, 0),
    entityType: ENTITY_TYPE.NPC, securityStatus: 0, bounty: 0,
    hostileResponseThreshold: -11, friendlyResponseThreshold: -11,
    preferredTargetMode: "none" };
  definition.behaviorProfile = { ...definition.behaviorProfile,
    ...STATIONARY_SENTRY_BEHAVIOR_OVERRIDES,
    autoAggro: false, autoActivateWeapons: true, allowPodKill: false,
    allowTargetSwitching: false, leashRangeMeters: 0 };
  definition.lootTable = null;
  const metadata = { empireSentry: true };
  for (const key of ["empireSentryAnchorID", "empireSentryAnchorKind", "staticVisibilityScope",
    "suppressSlimName", "suppressSlimCorporationID", "suppressSlimDunRotation",
    "destinyBootstrapDelivery", "destinyBallMode", "destinyForceFree", "destinyBallFlags",
    "dunRotation", "graphicID", "slimGraphicID"]) {
    if (Object.hasOwn(scenery, key)) metadata[key] = scenery[key];
  }
  const runtimeState = require("../runtime/state");
  const previousRuntimeEntityID = runtimeState.nextRuntimeEntityID;
  try {
    return spawnNativeNpcEntityInContext({ scene, systemID: scene.systemID,
      anchorEntity: scenery, anchorKind: scenery.empireSentryAnchorKind || "sentry",
      anchorLabel: scenery.itemName || "Empire Sentry" }, definition, {
      [EMPIRE_SENTRY_MATERIALIZATION]: scenery,
      transient: true, runtimeKind: "nativeCombat", broadcast: false,
      skipInitialBehaviorTick: true, suppressInitialPublication: true,
      ownerIDOverride: scenery.ownerID, suppressSlimName: scenery.suppressSlimName !== false,
      preferredTargetID: 0, behaviorOverrides: definition.behaviorProfile,
      anchorID: scenery.empireSentryAnchorID || 0,
      anchorKind: scenery.empireSentryAnchorKind || "sentry",
      runtimeEntityMetadata: metadata,
      spawnStateOverride: { position: scenery.position, direction: scenery.direction,
        velocity: { x: 0, y: 0, z: 0 }, mode: "STOP", maxVelocity: 0 },
    });
  } finally {
    // Reusing a reserved scenery ID must not advance ordinary runtime allocation.
    // Preserve any nested allocation should a future spawn hook actually make one.
    if (runtimeState.nextRuntimeEntityID === scenery.itemID + 1) {
      runtimeState.nextRuntimeEntityID = previousRuntimeEntityID;
    }
  }
}

function spawnNativeDefinitionsInContext(context, selectionResult, options = {}) {
  const spawned = [];
  let partialFailure = null;
  const scene = context && context.scene
    ? context.scene
    : spaceRuntime.ensureScene(toPositiveInt(context && context.systemID, 0));
  const definitions = Array.isArray(
    selectionResult &&
      selectionResult.data &&
      selectionResult.data.definitions,
  )
    ? selectionResult.data.definitions
    : [];

  for (let index = 0; index < definitions.length; index += 1) {
    const spawnResult = spawnNativeNpcEntityInContext(
      context,
      definitions[index],
      {
        ...options,
        broadcast: false,
        deferInitialBehaviorTick: true,
        batchIndex: index + 1,
        batchTotal: definitions.length,
        selectionKind: String(options.selectionKind || (
          selectionResult.data && selectionResult.data.selectionKind
        ) || "").trim() || null,
        selectionID: String(options.selectionID || (
          selectionResult.data && selectionResult.data.selectionID
        ) || "").trim() || null,
        selectionName: String(options.selectionName || (
          selectionResult.data && selectionResult.data.selectionName
        ) || "").trim() || null,
      },
    );
    if (!spawnResult.success || !spawnResult.data) {
      partialFailure = {
        failedAt: index + 1,
        errorMsg: spawnResult.errorMsg || "NPC_NATIVE_SPAWN_FAILED",
      };
      break;
    }
    spawned.push(spawnResult.data);
  }

  if (spawned.length === 0) {
    return {
      success: false,
      errorMsg: partialFailure ? partialFailure.errorMsg : "NPC_NATIVE_SPAWN_FAILED",
      suggestions: selectionResult && selectionResult.suggestions
        ? selectionResult.suggestions
        : [],
    };
  }

  if (scene && options.broadcast !== false) {
    scene.broadcastAddBalls(
      spawned
        .map((entry) => entry && entry.entity)
        .filter(Boolean),
      options.excludedSession || null,
      {
        freshAcquire: true,
        publisherPath: "nativeNpcService.spawnNativeDefinitionsInContext",
      },
    );
  }

  if (
    scene &&
    options.materializeRuntime !== false &&
    options.skipInitialBehaviorTick !== true &&
    options.deferGroupBehaviorTick !== true
  ) {
    tickBehaviorScene(
      scene,
      scene.getCurrentSimTimeMs(),
    );
  }

  return {
    success: true,
    data: {
      selectionKind: String(options.selectionKind || (selectionResult.data && selectionResult.data.selectionKind) || "").trim() || null,
      selectionID: String(options.selectionID || (selectionResult.data && selectionResult.data.selectionID) || "").trim() || null,
      selectionName: String(options.selectionName || (selectionResult.data && selectionResult.data.selectionName) || "").trim() || null,
      requestedAmount: definitions.length,
      spawned,
      partialFailure,
    },
    suggestions: selectionResult && selectionResult.suggestions
      ? selectionResult.suggestions
      : [],
  };
}

function spawnNativeNpcEntityInSystem(systemID, options = {}) {
  const contextResult = resolveNativeSpawnContextForSystem(systemID, options);
  if (!contextResult.success || !contextResult.data) {
    return contextResult;
  }

  const profileResolution = resolveNpcProfile(
    options.profileQuery,
    String(options.fallbackProfileID || ""),
  );
  if (!profileResolution.success || !profileResolution.data) {
    return {
      success: false,
      errorMsg: profileResolution.errorMsg || "NPC_PROFILE_NOT_FOUND",
      suggestions: profileResolution.suggestions || [],
    };
  }

  const definition = buildNpcDefinition(profileResolution.data.profileID);
  if (!definition) {
    return {
      success: false,
      errorMsg: "NPC_DEFINITION_INCOMPLETE",
    };
  }

  return spawnNativeNpcEntityInContext(contextResult.data, definition, {
    ...options,
    selectionKind: "profile",
    selectionID: definition.profile.profileID,
    selectionName: definition.profile.name || definition.profile.profileID,
    entityType: options.entityType || definition.profile.entityType,
    anchorKind: contextResult.data.anchorKind,
    anchorName: contextResult.data.anchorLabel,
    anchorID: toPositiveInt(contextResult.data.anchorEntity && contextResult.data.anchorEntity.itemID, 0),
  });
}

function spawnNativeNpcGroupInSystem(systemID, options = {}) {
  const contextResult = resolveNativeSpawnContextForSystem(systemID, options);
  if (!contextResult.success || !contextResult.data) {
    return contextResult;
  }

  const groupResult = resolveNpcSpawnGroupPlan(
    options.spawnGroupQuery || options.groupQuery,
    {
      entityType: String(options.entityType || ENTITY_TYPE.NPC),
      fallbackSpawnGroupID: String(options.fallbackSpawnGroupID || ""),
    },
  );
  if (!groupResult.success || !groupResult.data) {
    return groupResult;
  }

  return spawnNativeDefinitionsInContext(contextResult.data, groupResult, {
    ...options,
    selectionKind: "group",
    selectionID: groupResult.data.selectionID,
    selectionName: groupResult.data.selectionName,
    spawnGroupID: groupResult.data.selectionID,
    anchorKind: contextResult.data.anchorKind,
    anchorName: contextResult.data.anchorLabel,
    anchorID: toPositiveInt(contextResult.data.anchorEntity && contextResult.data.anchorEntity.itemID, 0),
  });
}

function cleanupStaleNativeStartupControllers(scene) {
  if (!scene) {
    return [];
  }
  const removed = [];

  for (const controllerRecord of nativeNpcStore.listNativeControllersForSystem(scene.systemID)) {
    const startupRuleID = String(controllerRecord && controllerRecord.startupRuleID || "").trim();
    if (!startupRuleID) {
      continue;
    }

    const destroyResult = destroyNativeNpcController({
      entityID: controllerRecord.entityID,
      systemID: controllerRecord.systemID,
    });
    if (!destroyResult.success) {
      continue;
    }
    removed.push({
      entityID: controllerRecord.entityID,
      startupRuleID,
      transient: controllerRecord.transient === true,
    });
  }

  return removed;
}

function destroyNativeNpcController(controller, options = {}) {
  const entityID = toPositiveInt(
    controller && (
      controller.entityID ||
      controller.itemID
    ),
    0,
  );
  const systemID = toPositiveInt(controller && controller.systemID, 0);
  if (!entityID || !systemID) {
    return {
      success: false,
      errorMsg: "NPC_NOT_FOUND",
    };
  }

  const sceneDescriptor =
    options.sceneDescriptor ||
    (
      controller && controller.sceneKind && controller.sceneKey
        ? {
          sceneKey: controller.sceneKey,
          sceneKind: controller.sceneKind,
          instanceID: controller.instanceID,
          locationID: controller.locationID || systemID,
          solarSystemID: controller.locationID || systemID,
        }
        : null
    );
  const scene =
    options.scene ||
    (
      sceneDescriptor && typeof spaceRuntime.getSceneByDescriptor === "function"
        ? spaceRuntime.getSceneByDescriptor(sceneDescriptor)
        : null
    ) ||
    (
      typeof spaceRuntime.findSceneContainingDynamicEntity === "function"
        ? spaceRuntime.findSceneContainingDynamicEntity(entityID)
        : null
    ) ||
    spaceRuntime.ensureScene(systemID);
  const deathRecord = nativeNpcStore.getNativeEntity(entityID);
  if (deathRecord?.nativeDeathWreck) {
    // Suppressing new wrecks during beacon cleanup must still finish an
    // already accepted death and publish its original earned wreck.
    return require("./nativeNpcDeathWrecks").settle(scene, deathRecord);
  }
  const runtimeEntity = scene ? scene.getEntityByID(entityID) : null;
  const destructionContext = captureNativeNpcDestructionContext(
    entityID,
    controller,
    runtimeEntity,
    scene,
    options,
  );
  if (runtimeEntity && (runtimeEntity.destructionState === "destroyed" || runtimeEntity.destroyed === true)) {
    const alreadyResult = normalizeNpcObjectiveNotificationResult(null, "already-destroyed");
    logNpcObjectiveNotificationDiagnostic(destructionContext, alreadyResult, options);
    return {
      success: true,
      data: {
        entityID,
        systemID,
        removedFighterCount: 0,
        removedRuntimeEntity: false,
        alreadyDestroyed: true,
        objectiveNotificationResult: alreadyResult,
      },
    };
  }
  // A completed AIR escape belongs to the lesson journal before the transient
  // NPC can disappear. Combat uses a synthetic destruction controller; explicit
  // broadcast/admin destruction must not become a cinematic departure receipt.
  if (runtimeEntity?.nativeNpc === true && runtimeEntity.airEncounterSlot === "escort:0" &&
      runtimeEntity.airNpeOwnerCharacterID > 0 && getControllerByEntityID(entityID) === controller &&
      controller.manualOrder?.type === "warpOff" && controller.warpOffOrdered === true && controller.warpOffSeenLeaving === true &&
      String(runtimeEntity.mode || "").toUpperCase() !== "WARP" && !scene.hasQueuedMovementChange(runtimeEntity) &&
      runtimeEntity.destroying !== true && runtimeEntity.destructionState !== "destroying" &&
      options.broadcast !== true && options.suppressWreck !== true && options.destructionReason == null) {
    try {
      require("../../services/npe/airFleetBattle").recordCompletedDeparture(scene, runtimeEntity, controller);
    } catch (error) {
      // WarpOff's caller ignores a refused destroy result. The live registered
      // controller is still enumerated on later ticks: use its normal scheduling
      // owner to defer this retry, without a timer or an exception escaping tickScene.
      require("./npcService").scheduleNpcController(entityID, scene.getCurrentSimTimeMs() +
        Math.max(50, toFiniteNumber(controller.behaviorProfile?.thinkIntervalMs, 250)));
      log.warn(`[AirFleetBattle] ${entityID} departure commit refused: ${error.message}`);
      return { success: false, errorMsg: "AIR_DEPARTURE_COMMIT_FAILED", cause: error.message };
    }
  }
  const retirement = retireRequiredDungeonActor(runtimeEntity || nativeNpcStore.getNativeEntity(entityID),
    "destroyed", options.nowMs);
  if (!retirement.success) return retirement;
  if (runtimeEntity) {
    runtimeEntity.destructionState = "destroying";
    runtimeEntity.destroying = true;
    runtimeEntity.destroyingAtMs = Date.now();
    log.info(
      `[NpcDestruction] npc=${entityID} sceneKey=${scene && scene.sceneKey || "unknown"} ` +
        `state=destroying suppressWreck=${options.suppressWreck === true}`,
    );
  }
  let removedFighterCount = 0;
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
      runtimeEntity || { itemID: entityID },
      controller,
      {
        removeContents: options.removeContents !== false,
      },
    );
    removedFighterCount = Number(
      cleanupResult &&
      cleanupResult.success &&
      cleanupResult.data &&
      cleanupResult.data.destroyedCount,
    ) || 0;
  }
  let sceneRemoved = false;
  if (runtimeEntity) {
    const removeResult = spaceRuntime.removeDynamicEntity(
      scene && scene.sceneDescriptor || sceneDescriptor || systemID,
      entityID,
      {
        sceneDescriptor: scene && scene.sceneDescriptor || sceneDescriptor || undefined,
        allowSessionOwned: true,
        broadcast: options.broadcast === true,
        excludedSession: options.excludedSession || null,
        nowMs: options.nowMs,
        terminalDestructionEffectID: options.terminalDestructionEffectID,
      },
    );
    sceneRemoved = Boolean(removeResult && removeResult.success === true);
    runtimeEntity.destructionState = "destroyed";
    runtimeEntity.destroying = false;
    runtimeEntity.destroyed = true;
    runtimeEntity.destroyedAtMs = Date.now();
  }

  unregisterController(entityID);
  const retired = nativeNpcStore.removeNativeEntityCascade(entityID);
  if (!retired.success) return retired;
  let objectiveNotificationResult = normalizeNpcObjectiveNotificationResult(null, "not-tracked");
  if (destructionContext.abyssalAuthorityValid !== true) {
    objectiveNotificationResult = normalizeNpcObjectiveNotificationResult(
      null,
      destructionContext.abyssalAuthorityPresent === true
        ? "metadata-invalid"
        : "metadata-missing",
    );
  } else if (typeof options.notifyNpcDestroyed !== "function") {
    objectiveNotificationResult = normalizeNpcObjectiveNotificationResult(null, "callback-missing");
  } else {
    try {
      objectiveNotificationResult = normalizeNpcObjectiveNotificationResult(
        options.notifyNpcDestroyed(destructionContext),
        "notified",
      );
    } catch (error) {
      objectiveNotificationResult = {
        handled: false,
        newlyRecorded: false,
        objectiveComplete: false,
        result: "callback-error",
        pending: false,
        errorMsg: error && error.message || "UNKNOWN_ERROR",
      };
      log.warn(
        `[NpcDestruction] Abyssal objective notify failed npc=${entityID} ` +
          `runID=${destructionContext.abyssalRunID || "none"} ` +
          `room=${destructionContext.abyssalRoomIndex || "none"} ` +
          `sceneKey=${destructionContext.sceneKey || "none"} ` +
          `reason=${objectiveNotificationResult.errorMsg}`,
      );
    }
  }
  logNpcObjectiveNotificationDiagnostic(destructionContext, objectiveNotificationResult, options);
  log.info(
    `[NpcDestruction] npc=${entityID} state=destroyed ` +
      `sceneRemoved=${sceneRemoved} controllerRemoved=true ` +
      `removeBallsRecipients=${sceneRemoved ? 1 : 0} objectiveNotified=${objectiveNotificationResult.handled === true}`,
  );
  return {
    success: true,
    data: {
      entityID,
      systemID,
      removedFighterCount,
      removedRuntimeEntity: Boolean(runtimeEntity),
      sceneRemoved,
      controllerRemoved: true,
      objectiveNotified: objectiveNotificationResult.handled === true,
      objectiveNotificationResult,
      destructionContext,
    },
  };
}

module.exports = {
  commitIncursionLogisticsRepair,
  materializeEmpireSentry,
  bindNpcOperation,
  commitIncursionDamageOutcome,
  readNativeNpcAbilityState,
  reserveNativeNpcAbilityCycle,
  commitNativeNpcShieldRepair,
  consumeNativeNpcBurst,
  isNativeAmbientRuleOptions,
  setDungeonCompanionOrbit,
  persistRequiredDungeonActor,
  retireRequiredDungeonActor,
  materializeStoredNativeController,
  dematerializeNativeController,
  spawnNativeDefinitionsInContext,
  spawnNativeNpcEntityInContext,
  spawnNativeNpcEntityInSystem,
  spawnNativeNpcGroupInSystem,
  cleanupStaleNativeStartupControllers,
  destroyNativeNpcController,
  __testing: {
    applyNativeNpcHullCombatOverrides,
    shouldSuppressNativeNpcSlimName,
  },
};
