"use strict";

const {
  toInt,
  toNumber,
} = require("../../common/numbers");

const path = require("path");

// Memoized resolver for lazy (circular-dependency-safe) requires that run on the
// fighter tick path. require(path.join(__dirname, id)) costs ~1.8us/call even
// when cached (path rebuild + resolver lookup); caching the resolved reference
// drops it to a ~4ns Map lookup. Safe because the targets assign module.exports
// once at load (or mutate it in place), so the cached reference never goes stale.
const _lazyModuleCache = new Map();
function lazyRequire(relativeId) {
  let resolved = _lazyModuleCache.get(relativeId);
  if (resolved === undefined) {
    resolved = require(path.join(__dirname, relativeId));
    _lazyModuleCache.set(relativeId, resolved);
  }
  return resolved;
}

const log = require(path.join(__dirname, "../../utils/logger"));
const {
  findSessionByCharacterID,
} = require(path.join(__dirname, "../chat/sessionRegistry"));
const {
  ITEM_FLAGS,
  getInventoryItemUnitVolume,
  mergeItemStacks,
  normalizeShipConditionState,
  updateInventoryItem,
} = require(path.join(__dirname, "../inventory/itemStore"));
const {
  findItemById,
  listContainerItems,
} = require(path.join(__dirname, "../inventory/simulationInventoryProjection"));
const itemCustody = require(path.join(__dirname, "../inventory/itemCustody"));
const structureState = require(path.join(__dirname, "../structure/structureState"));
const {
  buildEffectiveItemAttributeMap,
  getAttributeIDByNames,
  getShipBaseAttributeValue,
  getTypeAttributeValue,
} = require(path.join(__dirname, "../fitting/liveFittingState"));
const {
  getShipFittingSnapshot,
} = require(path.join(__dirname, "../../_secondary/fitting/fittingRuntime"));
const {
  buildList,
  buildDict,
} = require(path.join(__dirname, "../_shared/serviceHelpers"));
const {
  buildUserErrorPayload,
  throwWrappedUserError,
} = require(path.join(__dirname, "../../common/machoErrors"));
const {
  ABILITY_SLOT_IDS,
  TARGET_MODE_UNTARGETED,
  TARGET_MODE_ITEMTARGETED,
  TARGET_MODE_POINTTARGETED,
  getFighterAbilityMetaForSlot,
} = require(path.join(__dirname, "./fighterAbilities"));
const {
  FIGHTER_CATEGORY_ID,
  FIGHTER_TUBE_FLAGS,
  buildInventorySquadronSize,
  canLoadFighterTypeIntoHostTube,
  isFighterItemRecord,
  isFighterTubeFlag,
} = require(path.join(__dirname, "./fighterInventory"));
const {
  resolveFighterOperationalAttributes,
  resolveFighterAbilitySnapshot,
} = require(path.join(__dirname, "./fighterDogma"));
const {
  applyDamageToEntity,
  normalizeDamageVector,
  sumDamageVector,
  hasDamageableHealth,
} = require(path.join(__dirname, "../../space/combat/damage"));
const {
  resolveMissileAppliedDamage,
} = require(path.join(__dirname, "../../space/combat/missiles/missileSolver"));
const crimewatchState = require(path.join(__dirname, "../security/crimewatchState"));
const jammerModuleRuntime = require(path.join(
  __dirname,
  "../../space/modules/jammerModuleRuntime",
));
const hostileModuleRuntime = require(path.join(
  __dirname,
  "../../space/modules/hostileModuleRuntime",
));
const {
  entityIDsEqual,
  normalizeNonNegativeInt64,
  normalizePersistentEntityID,
  toJSONSafeEntityID,
} = require(path.join(__dirname, "../../space/destiny/identity/entityID"));
const {
  isSharedPveTarget,
} = require(path.join(
  __dirname,
  "../../space/destiny/identity/interactionScope",
));
const {
  resolveAbyssalPlayerLaunchScope,
  sessionClaimsAbyssalScene,
} = require(path.join(__dirname, "../_shared/abyssalPlayerLaunchScope"));
const {
  getSceneSurfaceDistance,
} = require(path.join(
  __dirname,
  "../../space/destiny/authority/sceneRangeDecision",
));

const {
  applyFighterPassiveMaxVelocityCommand,
  applyFighterMobilityMaxVelocityCommand,
  createFighterOperationalMotionCommand,
  applyFighterUtilityTeleportMotionCommand,
  applyFighterGotoPointCommand,
  captureFighterMaxVelocityPresentation,
} = require(path.join(__dirname, "../../space/destiny/commands/fighter.js"));
const {
  queueMovementCommand,
  queueOrApplyMovementChange,
} = require(path.join(__dirname, "../../space/destiny/commands/movementQueueing.js"));
const {
  isWarping,
} = require(path.join(__dirname, "../../space/destiny/simulation/evolve.js"));

const FIGHTER_EWAR_FAMILY_CONFIG = Object.freeze({
  fighterabilitywarpdisruption: Object.freeze({
    strengthAttribute: "fighterAbilityWarpDisruptionPointStrength",
    optimalAttribute: "fighterAbilityWarpDisruptionRange",
    falloffAttribute: null,
  }),
  fighterabilityenergyneutralizer: Object.freeze({
    strengthAttribute: "fighterAbilityEnergyNeutralizerAmount",
    optimalAttribute: "fighterAbilityEnergyNeutralizerOptimalRange",
    falloffAttribute: "fighterAbilityEnergyNeutralizerFalloffRange",
  }),
  fighterabilitystasiswebifier: Object.freeze({
    strengthAttribute: "fighterAbilityStasisWebifierSpeedPenalty",
    optimalAttribute: "fighterAbilityStasisWebifierOptimalRange",
    falloffAttribute: "fighterAbilityStasisWebifierFalloffRange",
  }),
});

const MOVEMENT_COMMAND_ORBIT = "ORBIT";
const MOVEMENT_COMMAND_FOLLOW = "FOLLOW";
const MOVEMENT_COMMAND_STOP = "STOP";
const MOVEMENT_COMMAND_GOTO_POINT = "GOTO_POINT";

const TUBE_STATE_EMPTY = "EMPTY";
const TUBE_STATE_READY = "READY";
const TUBE_STATE_INSPACE = "INSPACE";
const TUBE_STATE_RECALLING = "RECALLING";
const TUBE_STATE_LANDING = "LANDING";

const DEFAULT_FIGHTER_ORBIT_DISTANCE_METERS = 1500;
const FIGHTER_RECOVERY_DISTANCE_METERS = 5000;
// Recall flies squadrons at the controller's hull. A follow stops just short of
// its range and trails a moving target, so following at the recovery distance
// would leave the squadron holding just outside it and never landing.
const FIGHTER_RECALL_APPROACH_DISTANCE_METERS = 0;
const FIGHTER_RECALL_WARP_MINIMUM_DISTANCE_METERS = 150_000;
const ATTRIBUTE_STRUCTURE_HP = getAttributeIDByNames("hp", "structureHP") || 9;
const ATTRIBUTE_MASS = getAttributeIDByNames("mass") || 4;
const ATTRIBUTE_MAX_VELOCITY = getAttributeIDByNames("maxVelocity") || 37;
const ATTRIBUTE_SIGNATURE_RADIUS = getAttributeIDByNames("signatureRadius") || 552;
const ATTRIBUTE_FIGHTER_SQUADRON_ORBIT_RANGE =
  getAttributeIDByNames("fighterSquadronOrbitRange") || 2223;
const ATTRIBUTE_SHIELD_RECHARGE_RATE =
  getAttributeIDByNames("shieldRechargeRate") || 479;
const ATTRIBUTE_SHIELD_CAPACITY = getAttributeIDByNames("shieldCapacity") || 263;
const ATTRIBUTE_ARMOR_HP = getAttributeIDByNames("armorHP") || 265;
const ATTRIBUTE_AGILITY = getAttributeIDByNames("agility") || 70;
const DEFAULT_FIGHTER_LAUNCH_OFFSET_METERS = 150;
const FIGHTER_MOBILITY_EFFECT_FAMILIES = new Set([
  "fighterabilityafterburner",
  "fighterabilitymicrowarpdrive",
  "fighterabilitymicrojumpdrive",
  "fighterabilityevasivemaneuvers",
]);

const PLAYER_COMPANION_AIR_SCOPE_ID_FIELDS = Object.freeze([
  "airNpeOwnerCharacterID",
  "airNpeOperationID",
  "airNpeInstanceID",
]);
const PLAYER_COMPANION_ABYSSAL_SCOPE_ID_FIELDS = Object.freeze([
  "abyssalRunID",
  "evejsAbyssalInstanceID",
  "evejsAbyssalPocketInstanceID",
]);
const PLAYER_COMPANION_ABYSSAL_ROOM_INDEX_FIELDS = Object.freeze([
  "abyssalRoomIndex",
  "evejsAbyssalRoomIndex",
]);
const PLAYER_COMPANION_INVALID_SCOPE_SENTINEL =
  "invalid-player-companion-scope";

function buildPlayerCompanionScopeMetadata(controllerEntity = null) {
  if (!controllerEntity || typeof controllerEntity !== "object") {
    return {};
  }

  const metadata = {};
  for (const key of PLAYER_COMPANION_AIR_SCOPE_ID_FIELDS) {
    const rawValue = controllerEntity[key];
    if (rawValue === undefined || rawValue === null) {
      continue;
    }
    const value = normalizePersistentEntityID(rawValue);
    if (value !== null) {
      metadata[key] = toJSONSafeEntityID(value);
    } else {
      metadata[key] = PLAYER_COMPANION_INVALID_SCOPE_SENTINEL;
    }
  }
  for (const key of PLAYER_COMPANION_ABYSSAL_SCOPE_ID_FIELDS) {
    const rawValue = controllerEntity[key];
    if (rawValue === undefined || rawValue === null) {
      continue;
    }
    const value = normalizePersistentEntityID(rawValue);
    metadata[key] = value !== null
      ? toJSONSafeEntityID(value)
      : PLAYER_COMPANION_INVALID_SCOPE_SENTINEL;
  }
  for (const key of PLAYER_COMPANION_ABYSSAL_ROOM_INDEX_FIELDS) {
    const rawValue = controllerEntity[key];
    if (rawValue === undefined || rawValue === null) {
      continue;
    }
    const value = toInt(rawValue, 0);
    metadata[key] = value > 0
      ? value
      : PLAYER_COMPANION_INVALID_SCOPE_SENTINEL;
  }

  // dungeonCurrentInstanceID is the player ship's sole accepted site truth.
  // The child receives the matching presentation scope without introducing a
  // dungeonSiteInstanceID truth field on the controller.
  const dungeonSiteInstanceID = normalizePersistentEntityID(
    controllerEntity.dungeonCurrentInstanceID,
  );
  if (dungeonSiteInstanceID !== null) {
    metadata.dungeonSiteInstanceID = toJSONSafeEntityID(
      dungeonSiteInstanceID,
    );
  }
  if (
    getPlayerCompanionSecurityScope(controllerEntity, {
      controller: true,
    }).invalid === true
  ) {
    metadata.dungeonSiteInstanceID =
      PLAYER_COMPANION_INVALID_SCOPE_SENTINEL;
  }
  return metadata;
}

function applyPlayerCompanionScopeMetadata(entity, source = null) {
  if (!entity || !source || typeof source !== "object") {
    return entity;
  }
  for (const key of [
    ...PLAYER_COMPANION_AIR_SCOPE_ID_FIELDS,
    ...PLAYER_COMPANION_ABYSSAL_SCOPE_ID_FIELDS,
    ...PLAYER_COMPANION_ABYSSAL_ROOM_INDEX_FIELDS,
    "dungeonSiteInstanceID",
  ]) {
    const rawValue = source[key];
    if (rawValue === undefined || rawValue === null) {
      continue;
    }
    const value = normalizePersistentEntityID(rawValue);
    if (value !== null) {
      const hasExistingValue = Object.hasOwn(entity, key) &&
        entity[key] !== null &&
        entity[key] !== undefined;
      const existingValue = hasExistingValue
        ? normalizePersistentEntityID(entity[key])
        : null;
      if (
        hasExistingValue &&
        (
          existingValue === null ||
          !entityIDsEqual(existingValue, value)
        )
      ) {
        entity[key] = PLAYER_COMPANION_INVALID_SCOPE_SENTINEL;
        entity.playerCompanionScopeInvalid = true;
      } else {
        entity[key] = value;
      }
    } else {
      entity[key] = PLAYER_COMPANION_INVALID_SCOPE_SENTINEL;
      entity.playerCompanionScopeInvalid = true;
    }
  }
  return entity;
}

function serializePlayerCompanionScopeMetadata(entity = null) {
  if (!entity || typeof entity !== "object") {
    return {};
  }
  const metadata = {};
  for (const key of [
    ...PLAYER_COMPANION_AIR_SCOPE_ID_FIELDS,
    ...PLAYER_COMPANION_ABYSSAL_SCOPE_ID_FIELDS,
    ...PLAYER_COMPANION_ABYSSAL_ROOM_INDEX_FIELDS,
    "dungeonSiteInstanceID",
  ]) {
    const rawValue = entity[key];
    if (rawValue === undefined || rawValue === null) {
      continue;
    }
    const value = normalizePersistentEntityID(rawValue);
    if (value !== null) {
      metadata[key] = toJSONSafeEntityID(value);
    } else {
      metadata[key] = PLAYER_COMPANION_INVALID_SCOPE_SENTINEL;
    }
  }
  return metadata;
}

function getPlayerCompanionSecurityScope(entity = null, options = {}) {
  const scope = {
    invalid: Boolean(entity && entity.playerCompanionScopeInvalid === true),
  };
  const isController = options.controller === true;
  const isPlayerShipController = Boolean(
    isController &&
    entity &&
    entity.kind === "ship",
  );
  const rawSiteInstanceID = entity && entity.dungeonSiteInstanceID;
  const rawCurrentInstanceID = entity && entity.dungeonCurrentInstanceID;
  const rawDungeonSiteID = entity && entity.dungeonSiteID;
  const rawCurrentSiteID = entity && entity.dungeonCurrentSiteID;
  const siteInstanceID = normalizePersistentEntityID(rawSiteInstanceID);
  const currentInstanceID = normalizePersistentEntityID(rawCurrentInstanceID);
  let abyssalInstanceID = null;
  let abyssalInstancePresent = false;
  for (const key of PLAYER_COMPANION_ABYSSAL_SCOPE_ID_FIELDS) {
    const rawValue = entity && entity[key];
    if (rawValue === undefined || rawValue === null) {
      continue;
    }
    abyssalInstancePresent = true;
    const value = normalizePersistentEntityID(rawValue);
    if (
      value === null ||
      (abyssalInstanceID !== null && !entityIDsEqual(abyssalInstanceID, value))
    ) {
      scope.invalid = true;
      continue;
    }
    abyssalInstanceID = value;
  }
  let abyssalRoomIndex = null;
  let abyssalRoomPresent = false;
  for (const key of PLAYER_COMPANION_ABYSSAL_ROOM_INDEX_FIELDS) {
    const rawValue = entity && entity[key];
    if (rawValue === undefined || rawValue === null) {
      continue;
    }
    abyssalRoomPresent = true;
    const value = toInt(rawValue, 0);
    if (
      value <= 0 ||
      (abyssalRoomIndex !== null && abyssalRoomIndex !== value)
    ) {
      scope.invalid = true;
      continue;
    }
    abyssalRoomIndex = value;
  }
  const hasDungeonSiteID = Boolean(
    entity &&
    Object.hasOwn(entity, "dungeonSiteID") &&
    rawDungeonSiteID !== undefined &&
    rawDungeonSiteID !== null,
  );
  const hasCurrentSiteID = Boolean(
    entity &&
    Object.hasOwn(entity, "dungeonCurrentSiteID") &&
    rawCurrentSiteID !== undefined &&
    rawCurrentSiteID !== null,
  );
  const dungeonSiteID = normalizePersistentEntityID(rawDungeonSiteID);
  const currentSiteID = normalizePersistentEntityID(rawCurrentSiteID);
  let hasPlayerDungeonTrackingContext = false;
  if (entity && entity.kind === "ship") {
    for (const [key, normalizeIdentity] of [
      ["dungeonCurrentDungeonID", normalizePersistentEntityID],
      ["dungeonCurrentRoomID", normalizeNonNegativeInt64],
      ["dungeonCurrentSiteID", normalizePersistentEntityID],
    ]) {
      const rawValue = entity && entity[key];
      if (
        rawValue === undefined ||
        rawValue === null
      ) {
        continue;
      }
      hasPlayerDungeonTrackingContext = true;
      if (normalizeIdentity(rawValue) === null) {
        scope.invalid = true;
      }
    }
    hasPlayerDungeonTrackingContext = Boolean(
      hasPlayerDungeonTrackingContext ||
      String(entity.dungeonCurrentRoomKey || "").trim() ||
      Array.isArray(entity.dungeonCurrentRoomPosition)
    );
  }
  if (
    (rawSiteInstanceID !== undefined &&
      rawSiteInstanceID !== null &&
      siteInstanceID === null) ||
    (rawCurrentInstanceID !== undefined &&
      rawCurrentInstanceID !== null &&
      currentInstanceID === null) ||
    (siteInstanceID !== null &&
      currentInstanceID !== null &&
      !entityIDsEqual(siteInstanceID, currentInstanceID)) ||
    (isPlayerShipController &&
      siteInstanceID !== null &&
      currentInstanceID === null) ||
    (entity && entity.kind === "ship" &&
      currentInstanceID === null &&
      hasPlayerDungeonTrackingContext)
  ) {
    scope.invalid = true;
  }
  const dungeonInstanceID = isPlayerShipController
    ? currentInstanceID
    : siteInstanceID !== null
      ? siteInstanceID
      : entity && entity.kind === "ship"
        ? currentInstanceID
        : null;
  if (
    dungeonInstanceID !== null &&
    abyssalInstanceID !== null &&
    !entityIDsEqual(dungeonInstanceID, abyssalInstanceID)
  ) {
    scope.invalid = true;
  }
  scope.dungeonSiteInstanceID = dungeonInstanceID !== null
    ? dungeonInstanceID
    : abyssalInstanceID;
  scope.abyssalInstanceID = abyssalInstanceID;
  scope.abyssalRoomIndex = abyssalRoomIndex;
  if (
    hasDungeonSiteID &&
    (
      dungeonSiteID === null ||
      scope.dungeonSiteInstanceID === null ||
      (
        isController &&
        entity &&
        entity.kind === "ship" &&
        hasCurrentSiteID &&
        (
          currentSiteID === null ||
          !entityIDsEqual(dungeonSiteID, currentSiteID)
        )
      )
    )
  ) {
    scope.invalid = true;
  }
  for (const key of PLAYER_COMPANION_AIR_SCOPE_ID_FIELDS) {
    const rawValue = entity && entity[key];
    const value = normalizePersistentEntityID(rawValue);
    if (rawValue !== undefined && rawValue !== null && value === null) {
      scope.invalid = true;
    }
    scope[key] = value;
  }
  scope.effectiveInstanceID =
    scope.dungeonSiteInstanceID ?? scope.airNpeInstanceID;
  const hasDungeonScopeMarker = Boolean(
    entity && (
      entity.dungeonMaterializedContainer === true ||
      entity.dungeonMaterializedSiteContent === true ||
      entity.dungeonSiteContentBonus === true ||
      entity.dungeonSiteContentFailureExplodes === true ||
      entity.dungeonSiteContentPersistsAfterResponse === true ||
      [
        "dungeonEncounterKey",
        "dungeonSiteContentKey",
        "dungeonSiteContentRole",
        "dungeonSiteContentAnalyzer",
        "dungeonSiteContentTrigger",
        "dungeonSiteContentLootProfile",
        "dungeonSiteContentHackingDifficulty",
      ].some((key) => String(entity[key] || "").trim()) ||
      Array.isArray(entity.dungeonSiteContentExplicitLoot) ||
      Array.isArray(entity.dungeonSiteContentLootTags)
    )
  );
  const hasAirScopeMarker = Boolean(
    entity && (
      entity.airNpeBoardingShipPresentation === true ||
      entity.airNpeTutorialDebris === true ||
      entity.airNpeHostile === true ||
      String(entity.airNpeHostileWave || "").trim()
    )
  );
  if (
    (hasDungeonScopeMarker && scope.dungeonSiteInstanceID === null) ||
    (abyssalInstancePresent && abyssalInstanceID === null) ||
    (abyssalRoomPresent && (
      abyssalRoomIndex === null ||
      abyssalInstanceID === null
    )) ||
    (
      hasAirScopeMarker &&
      scope.airNpeInstanceID === null &&
      scope.airNpeOwnerCharacterID === null
    ) ||
    (scope.effectiveInstanceID === null &&
    (
      scope.airNpeOwnerCharacterID !== null ||
      scope.airNpeOperationID !== null
    ))
  ) {
    scope.invalid = true;
  }
  return scope;
}

function resolveExactCompanionActorCharacterID(entity = null, session = null) {
  let resolvedCharacterID = null;
  let invalid = false;
  const candidates = [];
  if (session && typeof session === "object") {
    for (const key of ["characterID", "charID", "charid"]) {
      if (Object.hasOwn(session, key)) {
        candidates.push(session[key]);
      }
    }
  }
  if (entity && typeof entity === "object") {
    for (const key of ["characterID", "pilotCharacterID"]) {
      if (Object.hasOwn(entity, key)) {
        candidates.push(entity[key]);
      }
    }
    if (entity.kind === "ship" && Object.hasOwn(entity, "ownerID")) {
      candidates.push(entity.ownerID);
    }
  }
  for (const rawValue of candidates) {
    if (
      rawValue === undefined ||
      rawValue === null ||
      String(rawValue).trim() === ""
    ) {
      continue;
    }
    const value = normalizePersistentEntityID(rawValue);
    if (
      value === null ||
      (resolvedCharacterID !== null &&
        !entityIDsEqual(resolvedCharacterID, value))
    ) {
      invalid = true;
      continue;
    }
    resolvedCharacterID = value;
  }
  return { invalid, value: resolvedCharacterID };
}

function dungeonInstanceScopesAreCompatible(
  scene,
  visibilitySession,
  companionScope,
  targetScope,
) {
  const companionDungeonInstanceID = companionScope.effectiveInstanceID;
  const targetDungeonInstanceID = targetScope.effectiveInstanceID;
  if (
    companionDungeonInstanceID === null &&
    targetDungeonInstanceID === null
  ) {
    return true;
  }
  if (
    companionDungeonInstanceID !== null &&
    targetDungeonInstanceID !== null
  ) {
    return entityIDsEqual(
      companionDungeonInstanceID,
      targetDungeonInstanceID,
    );
  }

  const scopedScope = companionDungeonInstanceID !== null
    ? companionScope
    : targetScope;
  const scopedInstanceID = companionDungeonInstanceID !== null
    ? companionDungeonInstanceID
    : targetDungeonInstanceID;
  if (
    scopedScope.dungeonSiteInstanceID === null ||
    !entityIDsEqual(scopedScope.dungeonSiteInstanceID, scopedInstanceID) ||
    !scene ||
    !visibilitySession ||
    typeof scene.resolveDungeonInstanceVisibilityForSession !== "function"
  ) {
    return false;
  }

  try {
    const resolution = scene.resolveDungeonInstanceVisibilityForSession(
      visibilitySession,
      scopedInstanceID,
    );
    return Boolean(resolution && resolution.isPrivate === false);
  } catch (_error) {
    // ignored: an unreadable dungeon visibility is not public, so the scopes are not compatible (fail closed)
    return false;
  }
}

function playerCompanionTargetScopeIsCompatible(
  companionScope,
  targetScope,
  controllerEntity,
  targetEntity,
  session,
  scene,
  visibilitySession,
) {
  if (
    !companionScope ||
    !targetScope ||
    companionScope.invalid === true ||
    targetScope.invalid === true
  ) {
    return false;
  }

  if (!abyssalRunRoomScopesExactlyMatch(companionScope, targetScope)) {
    return false;
  }

  // Site ownership is not target ownership.  Fighters follow the same shared
  // rat/resource policy as drones, while AIR and Abyssal remain isolated.
  const sharedPveTarget = isSharedPveTarget(targetEntity) &&
    companionScope.airNpeOperationID === null &&
    companionScope.airNpeInstanceID === null &&
    companionScope.airNpeOwnerCharacterID === null &&
    targetScope.airNpeOperationID === null &&
    targetScope.airNpeInstanceID === null &&
    targetScope.airNpeOwnerCharacterID === null;
  if (!sharedPveTarget && !dungeonInstanceScopesAreCompatible(
    scene,
    visibilitySession,
    companionScope,
    targetScope,
  )) {
    return false;
  }

  for (const key of ["airNpeOperationID", "airNpeInstanceID"]) {
    const companionValue = companionScope[key];
    const targetValue = targetScope[key];
    if (
      companionValue !== null &&
      targetValue !== null &&
      !entityIDsEqual(companionValue, targetValue)
    ) {
      return false;
    }
  }

  const companionOwnerCharacterID = companionScope.airNpeOwnerCharacterID;
  const targetOwnerCharacterID = targetScope.airNpeOwnerCharacterID;
  if (
    companionOwnerCharacterID !== null &&
    targetOwnerCharacterID !== null
  ) {
    return entityIDsEqual(
      companionOwnerCharacterID,
      targetOwnerCharacterID,
    );
  }

  if (companionOwnerCharacterID !== null) {
    const targetActor = resolveExactCompanionActorCharacterID(
      targetEntity,
      targetEntity && targetEntity.session,
    );
    if (targetActor.invalid) {
      return false;
    }
    if (
      targetActor.value !== null &&
      !entityIDsEqual(companionOwnerCharacterID, targetActor.value)
    ) {
      return false;
    }
    if (targetEntity && targetEntity.kind === "ship" && targetActor.value === null) {
      return false;
    }
  }

  if (targetOwnerCharacterID !== null) {
    const controllerActor = resolveExactCompanionActorCharacterID(
      controllerEntity,
      session || (controllerEntity && controllerEntity.session),
    );
    if (
      controllerActor.invalid ||
      controllerActor.value === null ||
      !entityIDsEqual(targetOwnerCharacterID, controllerActor.value)
    ) {
      return false;
    }
  }

  return true;
}

function abyssalRunRoomScopesExactlyMatch(leftScope, rightScope) {
  const leftRunID = leftScope && leftScope.abyssalInstanceID != null
    ? leftScope.abyssalInstanceID
    : null;
  const rightRunID = rightScope && rightScope.abyssalInstanceID != null
    ? rightScope.abyssalInstanceID
    : null;
  const leftRoomIndex = toInt(leftScope && leftScope.abyssalRoomIndex, 0);
  const rightRoomIndex = toInt(rightScope && rightScope.abyssalRoomIndex, 0);
  const hasAbyssalScope = Boolean(
    leftRunID !== null ||
    rightRunID !== null ||
    leftRoomIndex > 0 ||
    rightRoomIndex > 0
  );
  if (!hasAbyssalScope) {
    return true;
  }
  return Boolean(
    leftRunID !== null &&
    rightRunID !== null &&
    entityIDsEqual(leftRunID, rightRunID) &&
    leftRoomIndex > 0 &&
    rightRoomIndex > 0 &&
    leftRoomIndex === rightRoomIndex
  );
}

function securityScopesExactlyMatch(leftScope, rightScope) {
  if (
    !leftScope ||
    !rightScope ||
    leftScope.invalid === true ||
    rightScope.invalid === true
  ) {
    return false;
  }
  if (!abyssalRunRoomScopesExactlyMatch(leftScope, rightScope)) {
    return false;
  }
  for (const key of [
    "dungeonSiteInstanceID",
    ...PLAYER_COMPANION_AIR_SCOPE_ID_FIELDS,
  ]) {
    const left = leftScope && leftScope[key];
    const right = rightScope && rightScope[key];
    if (left === null && right === null) {
      continue;
    }
    if (left === null || right === null || !entityIDsEqual(left, right)) {
      return false;
    }
  }
  return true;
}

function hasPlayerCompanionSecurityScope(scope) {
  return Boolean(
    scope && (
      scope.invalid === true ||
      [
        "dungeonSiteInstanceID",
        ...PLAYER_COMPANION_AIR_SCOPE_ID_FIELDS,
      ].some((key) => scope[key] !== null)
    ),
  );
}

function canPlayerCompanionActOnTarget(
  scene,
  session,
  companionEntity,
  controllerEntity,
  targetEntity,
) {
  if (!scene || !companionEntity || !controllerEntity || !targetEntity) {
    return false;
  }

  const companionScope = getPlayerCompanionSecurityScope(companionEntity);
  const controllerScope = getPlayerCompanionSecurityScope(controllerEntity, {
    controller: true,
  });
  const targetScope = getPlayerCompanionSecurityScope(targetEntity);
  const isPlayerShipController = Boolean(
    controllerEntity.kind === "ship",
  );
  const controllerSession =
    session || resolveFighterControllerSession(companionEntity, controllerEntity);
  const effectiveSession =
    controllerSession || (!isPlayerShipController && targetEntity.session) || null;
  if (
    !securityScopesExactlyMatch(companionScope, controllerScope) ||
    !playerCompanionTargetScopeIsCompatible(
      companionScope,
      targetScope,
      controllerEntity,
      targetEntity,
      session,
      scene,
      effectiveSession,
    )
  ) {
    return false;
  }

  const visibilityGate = scene.canSessionSeeDungeonScopedEntity;
  if (typeof visibilityGate !== "function") {
    return ![
      companionScope,
      controllerScope,
      targetScope,
    ].some(hasPlayerCompanionSecurityScope);
  }

  if (!effectiveSession) {
    return (
      !isPlayerShipController &&
      !controllerScope.invalid
    );
  }
  try {
    return (
      visibilityGate.call(scene, effectiveSession, companionEntity) === true &&
      visibilityGate.call(scene, effectiveSession, targetEntity) === true
    );
  } catch (_error) {
    // ignored: a visibility check that throws does not let the fighter act on the target (fail closed)
    return false;
  }
}

function getCharacterStateService() {
  return lazyRequire("../character/characterState");
}

function getStructureTetherRestrictionState() {
  return lazyRequire("../structure/structureTetherRestrictionState");
}

function resolveActiveShipRecord(characterID) {
  const characterState = getCharacterStateService();
  return characterState && typeof characterState.getActiveShipRecord === "function"
    ? characterState.getActiveShipRecord(characterID)
    : null;
}

function resolveControlledStructureRecord(session) {
  const structureID = toInt(
    session && (session.structureID || session.structureid),
    0,
  );
  const shipID = toInt(session && (session.shipID || session.shipid), 0);
  if (structureID <= 0 || shipID !== structureID) {
    return null;
  }
  return buildStructureFighterHostRecord(structureID);
}

// A structure has no item row, so a squadron it controls needs its host built
// from structure state, including after the gunner has released control.
function resolveFighterControllerRecord(controllerID) {
  return findItemById(controllerID) || buildStructureFighterHostRecord(toInt(controllerID, 0));
}

function buildStructureFighterHostRecord(structureID) {
  if (structureID <= 0) {
    return null;
  }
  const structure = structureState.getStructureByID(structureID, {
    refresh: false,
  });
  if (!structure) {
    return null;
  }

  return {
    itemID: structureID,
    typeID: toInt(structure.typeID, 0),
    ownerID: toInt(structure.ownerCorpID || structure.ownerID, 0),
    locationID: structureID,
    flagID: 0,
    groupID: toInt(structure.groupID, 0),
    categoryID: 65,
    itemName: String(structure.itemName || structure.name || "Structure"),
    spaceState: {
      systemID: toInt(structure.solarSystemID, 0),
    },
    controlledStructure: true,
  };
}

function syncInventoryItemForCharacterSession(session, item, previousData, options = {}) {
  const characterState = getCharacterStateService();
  if (!characterState || typeof characterState.syncInventoryItemForSession !== "function") {
    return false;
  }
  return characterState.syncInventoryItemForSession(
    session,
    item,
    previousData,
    options,
  );
}

function round6(value) {
  return Number(toNumber(value, 0).toFixed(6));
}

function isStructureControllerRecord(controller) {
  return Boolean(
    controller && (
      controller.controlledStructure === true ||
      controller.kind === "structure" ||
      toInt(controller.categoryID, 0) === 65
    ),
  );
}

function resolveControllerOwnerCharacterID(controller, fallbackCharacterID = 0) {
  return toInt(
    (
      controller &&
      controller.session &&
      (controller.session.characterID || controller.session.charid)
    ) ||
      (
        controller &&
        (
          controller.pilotCharacterID ??
          controller.characterID ??
          controller.ownerID
        )
      ) ||
      fallbackCharacterID,
    0,
  );
}

function setFightersLaunchedTetherRestriction(characterID, fightersLaunched, scene) {
  const numericCharacterID = toInt(characterID, 0);
  if (numericCharacterID <= 0) {
    return false;
  }

  try {
    const tetherRestrictions = getStructureTetherRestrictionState();
    const result = tetherRestrictions.setCharacterTetherRestrictionFlags(
      numericCharacterID,
      {
        fightersLaunched: fightersLaunched === true,
      },
      {
        nowMs:
          scene && typeof scene.getCurrentSimTimeMs === "function"
            ? scene.getCurrentSimTimeMs()
            : Date.now(),
      },
    );
    return Boolean(result && result.success);
  } catch (error) {
    log.warn(
      `[FighterRuntime] Failed to update launched-fighter tether restriction for char=${numericCharacterID}: ${error && error.message ? error.message : error}`,
    );
    return false;
  }
}

function syncFightersLaunchedTetherRestriction(
  scene,
  controller,
  fallbackCharacterID = 0,
) {
  if (!scene || !controller || isStructureControllerRecord(controller)) {
    return false;
  }

  const controllerID = toInt(controller.itemID, 0);
  const characterID = resolveControllerOwnerCharacterID(
    controller,
    fallbackCharacterID,
  );
  if (controllerID <= 0 || characterID <= 0) {
    return false;
  }

  const hasLaunchedFighters = listControlledFighterEntities(scene, controllerID)
    .some((entity) => (
      isFighterEntity(entity) &&
      toInt(entity.controllerID, 0) === controllerID
    ));
  return setFightersLaunchedTetherRestriction(
    characterID,
    hasLaunchedFighters,
    scene,
  );
}

function cloneVector(source = null, fallback = { x: 0, y: 0, z: 0 }) {
  return {
    x: toNumber(source && source.x, fallback.x),
    y: toNumber(source && source.y, fallback.y),
    z: toNumber(source && source.z, fallback.z),
  };
}

function addVectors(left, right) {
  return {
    x: toNumber(left && left.x, 0) + toNumber(right && right.x, 0),
    y: toNumber(left && left.y, 0) + toNumber(right && right.y, 0),
    z: toNumber(left && left.z, 0) + toNumber(right && right.z, 0),
  };
}

function subtractVectors(left, right) {
  return {
    x: toNumber(left && left.x, 0) - toNumber(right && right.x, 0),
    y: toNumber(left && left.y, 0) - toNumber(right && right.y, 0),
    z: toNumber(left && left.z, 0) - toNumber(right && right.z, 0),
  };
}

function scaleVector(vector, scalar) {
  return {
    x: toNumber(vector && vector.x, 0) * toNumber(scalar, 0),
    y: toNumber(vector && vector.y, 0) * toNumber(scalar, 0),
    z: toNumber(vector && vector.z, 0) * toNumber(scalar, 0),
  };
}

function magnitude(vector) {
  const resolved = cloneVector(vector);
  return Math.sqrt(
    (resolved.x * resolved.x) +
    (resolved.y * resolved.y) +
    (resolved.z * resolved.z),
  );
}

function normalizeVector(vector, fallback = { x: 1, y: 0, z: 0 }) {
  const resolved = cloneVector(vector, fallback);
  const length = magnitude(resolved);
  if (length <= 0) {
    return cloneVector(fallback);
  }
  return scaleVector(resolved, 1 / length);
}

function distance(left, right) {
  return magnitude(subtractVectors(left, right));
}

function surfaceDistance(
  leftEntity,
  rightEntity,
  scene = null,
  nowMs = null,
  reason = "fighter-surface-distance",
) {
  return getSceneSurfaceDistance(scene, leftEntity, rightEntity, {
    nowMs,
    reason,
  });
}

function buildPerpendicular(vector) {
  const normalized = normalizeVector(vector, { x: 1, y: 0, z: 0 });
  if (Math.abs(normalized.x) < 0.5 && Math.abs(normalized.y) < 0.5) {
    return normalizeVector({ x: 0, y: 1, z: 0 });
  }
  return normalizeVector({ x: -normalized.y, y: normalized.x, z: 0 });
}

function listify(rawValue) {
  if (Array.isArray(rawValue)) {
    return rawValue;
  }
  if (rawValue && rawValue.type === "list" && Array.isArray(rawValue.items)) {
    return rawValue.items;
  }
  return rawValue === null || rawValue === undefined ? [] : [rawValue];
}

// The client sends fighter move and ability points as an (x, y, z) tuple,
// which arrives as an array (a list as {type: "list", items}). {x, y, z} is
// accepted too. Returns null unless all three coordinates are finite.
function normalizeFighterCommandPoint(rawPoint) {
  const isSequence =
    Array.isArray(rawPoint) ||
    Boolean(rawPoint && rawPoint.type === "list" && Array.isArray(rawPoint.items));
  const [x, y, z] = isSequence
    ? listify(rawPoint).map(Number)
    : rawPoint && typeof rawPoint === "object"
      ? [Number(rawPoint.x), Number(rawPoint.y), Number(rawPoint.z)]
      : [];
  return Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)
    ? { x, y, z }
    : null;
}

function normalizeFighterIDList(rawValue) {
  return listify(rawValue)
    .map((value) => toInt(value, 0))
    .filter((value, index, values) => value > 0 && values.indexOf(value) === index);
}

function normalizeTubeFlagList(rawValue) {
  return listify(rawValue)
    .map((value) => toInt(value, 0))
    .filter((value, index, values) => (
      isFighterTubeFlag(value) &&
      values.indexOf(value) === index
    ));
}

function buildPerFighterResultEntries(rawFighterIDs, errors = []) {
  const fighterIDs = normalizeFighterIDList(rawFighterIDs);
  const errorsByFighterID = new Map();
  for (const entry of Array.isArray(errors) ? errors : []) {
    if (!Array.isArray(entry) || entry.length < 1) {
      continue;
    }
    const fighterID = toInt(entry[0], 0);
    if (fighterID <= 0 || errorsByFighterID.has(fighterID)) {
      continue;
    }
    errorsByFighterID.set(
      fighterID,
      entry.length > 1 ? entry[1] ?? null : null,
    );
  }
  return fighterIDs.map((fighterID) => [
    fighterID,
    errorsByFighterID.has(fighterID)
      ? errorsByFighterID.get(fighterID)
      : null,
  ]);
}

function getRuntime() {
  return lazyRequire("../../space/runtime");
}

function cloneAbilityState(state = null) {
  if (!state || typeof state !== "object") {
    return null;
  }

  const cloned = {};
  for (const key of [
    "activeSinceMs",
    "durationMs",
    "activeUntilMs",
    "cooldownStartMs",
    "cooldownEndMs",
    "remainingChargeCount",
    "targetID",
    "firedAtActivation",
  ]) {
    const value = state[key];
    if (value === undefined || value === null) {
      continue;
    }
    cloned[key] = value;
  }
  if (state.targetPoint && typeof state.targetPoint === "object") {
    cloned.targetPoint = cloneVector(state.targetPoint);
  }

  return Object.keys(cloned).length > 0 ? cloned : null;
}

function cloneAbilityStates(rawStates) {
  if (!rawStates || typeof rawStates !== "object") {
    return {};
  }

  const cloned = {};
  for (const slotID of ABILITY_SLOT_IDS) {
    const state = cloneAbilityState(rawStates[slotID]);
    if (state) {
      cloned[slotID] = state;
    }
  }
  return cloned;
}

function getEntityAbilityStates(entity) {
  if (!entity || typeof entity !== "object") {
    return {};
  }

  if (!entity.fighterAbilityStates || typeof entity.fighterAbilityStates !== "object") {
    entity.fighterAbilityStates = {};
  }
  return entity.fighterAbilityStates;
}

function getEntityAbilityState(entity, slotID) {
  const numericSlotID = toInt(slotID, -1);
  return getEntityAbilityStates(entity)[numericSlotID] || null;
}

function setEntityAbilityState(entity, slotID, nextState) {
  const numericSlotID = toInt(slotID, -1);
  if (!ABILITY_SLOT_IDS.includes(numericSlotID)) {
    return null;
  }

  const abilityStates = getEntityAbilityStates(entity);
  const normalizedState = cloneAbilityState(nextState);
  if (normalizedState) {
    abilityStates[numericSlotID] = normalizedState;
  } else {
    delete abilityStates[numericSlotID];
  }
  return abilityStates[numericSlotID] || null;
}

function clearEntityAbilityStates(entity) {
  if (entity && typeof entity === "object") {
    entity.fighterAbilityStates = {};
  }
}

function normalizeEffectFamily(value) {
  return String(value || "").trim().toLowerCase();
}

function isMobilityAbilitySnapshot(abilityMeta) {
  return FIGHTER_MOBILITY_EFFECT_FAMILIES.has(
    normalizeEffectFamily(
      abilityMeta && (
        abilityMeta.normalizedEffectFamily ||
        abilityMeta.effectFamily
      ),
    ),
  );
}

function isJammerAbilitySnapshot(abilityMeta) {
  return normalizeEffectFamily(
    abilityMeta && (
      abilityMeta.normalizedEffectFamily ||
      abilityMeta.effectFamily
    ),
  ) === "fighterabilityecm";
}

function resolveFighterRuntimeItemRecord(fighterItemOrEntity) {
  const sourceRecord =
    fighterItemOrEntity && typeof fighterItemOrEntity === "object"
      ? fighterItemOrEntity
      : { typeID: fighterItemOrEntity };
  return sourceRecord &&
    !sourceRecord.customInfo &&
    toInt(sourceRecord.itemID, 0) > 0
      ? findItemById(sourceRecord.itemID) || sourceRecord
      : sourceRecord;
}

function resolveFighterPassiveMaxVelocity(entity) {
  const cached = toNumber(entity && entity.baseMaxVelocity, NaN);
  if (Number.isFinite(cached) && cached > 0) {
    return cached;
  }

  const itemRecord = resolveFighterRuntimeItemRecord(entity);
  const typeID = toInt(itemRecord && itemRecord.typeID, toInt(entity && entity.typeID, 0));
  const attributes = buildEffectiveItemAttributeMap(itemRecord || typeID);
  const resolved = Math.max(
    1,
    toNumber(
      attributes[ATTRIBUTE_MAX_VELOCITY] ?? getTypeAttributeValue(typeID, "maxVelocity"),
      entity && entity.maxVelocity,
    ),
  );
  if (entity && typeof entity === "object") {
    applyFighterPassiveMaxVelocityCommand({
      fighterEntity: entity,
      baseMaxVelocity: resolved,
    });
  }
  return resolved;
}

function resolveFighterPassiveSignatureRadius(entity) {
  const cached = toNumber(entity && entity.baseSignatureRadius, NaN);
  if (Number.isFinite(cached) && cached > 0) {
    return cached;
  }

  const itemRecord = resolveFighterRuntimeItemRecord(entity);
  const typeID = toInt(itemRecord && itemRecord.typeID, toInt(entity && entity.typeID, 0));
  const attributes = buildEffectiveItemAttributeMap(itemRecord || typeID);
  const resolved = Math.max(
    1,
    toNumber(
      attributes[ATTRIBUTE_SIGNATURE_RADIUS] ?? getTypeAttributeValue(typeID, "signatureRadius"),
      entity && entity.signatureRadius,
    ),
  );
  if (entity && typeof entity === "object") {
    entity.baseSignatureRadius = resolved;
  }
  return resolved;
}

function emitFighterMaxVelocityUpdate(scene, fighterEntity, nowMs) {
  if (!scene || !isFighterEntity(fighterEntity)) {
    return false;
  }

  const presentation = captureFighterMaxVelocityPresentation({
    scene,
    fighterEntity,
    nowMs,
  });
  scene.queueBubbleHistory(presentation.buildUpdates());
  return true;
}

function syncFighterMobilityAbilityState(
  scene,
  fighterEntity,
  controllerEntity = null,
  nowMs = scene && typeof scene.getCurrentSimTimeMs === "function"
    ? scene.getCurrentSimTimeMs()
    : Date.now(),
) {
  if (!isFighterEntity(fighterEntity)) {
    return false;
  }

  const rawAbilityStates =
    fighterEntity && fighterEntity.fighterAbilityStates &&
    typeof fighterEntity.fighterAbilityStates === "object"
      ? fighterEntity.fighterAbilityStates
      : null;
  const hasAbilityState = rawAbilityStates && Object.keys(rawAbilityStates).length > 0;
  const wasMobilityModified = fighterEntity.fighterMobilityRuntimeActive === true;
  const passiveAttributeChanged = controllerEntity
    ? applyFighterOperationalEntityAttributes(fighterEntity, controllerEntity)
    : false;
  if (!hasAbilityState && !wasMobilityModified) {
    if (passiveAttributeChanged) {
      emitFighterMaxVelocityUpdate(scene, fighterEntity, nowMs);
    }
    return passiveAttributeChanged;
  }

  const passiveMaxVelocity = resolveFighterPassiveMaxVelocity(fighterEntity);
  const passiveSignatureRadius = resolveFighterPassiveSignatureRadius(fighterEntity);
  let nextMaxVelocity = passiveMaxVelocity;
  let nextSignatureRadius = passiveSignatureRadius;
  let hasActiveMobilityEffect = false;

  if (controllerEntity && hasAbilityState) {
    for (const slotID of ABILITY_SLOT_IDS) {
      const abilityState = getEntityAbilityState(fighterEntity, slotID);
      if (!abilityState || toNumber(abilityState.activeUntilMs, 0) <= nowMs) {
        continue;
      }

      const abilityMeta = resolveFighterAbilitySnapshot(
        fighterEntity,
        controllerEntity,
        slotID,
      ) || getFighterAbilityMetaForSlot(fighterEntity.typeID, slotID);
      if (!isMobilityAbilitySnapshot(abilityMeta)) {
        continue;
      }

      hasActiveMobilityEffect = true;
      const speedMultiplier =
        1 + (Math.max(-99.999, toNumber(abilityMeta && abilityMeta.speedBonusPercent, 0)) / 100);
      const signatureMultiplier =
        1 + (toNumber(abilityMeta && abilityMeta.signatureRadiusBonusPercent, 0) / 100);
      nextMaxVelocity = Math.max(1, nextMaxVelocity * Math.max(0.00001, speedMultiplier));
      nextSignatureRadius = Math.max(1, nextSignatureRadius * Math.max(0.00001, signatureMultiplier));
    }
  }

  nextMaxVelocity = round6(nextMaxVelocity);
  nextSignatureRadius = round6(nextSignatureRadius);

  const maxVelocityChanged = Math.abs(
    toNumber(fighterEntity.maxVelocity, passiveMaxVelocity) - nextMaxVelocity,
  ) > 1e-6;
  const signatureRadiusChanged = Math.abs(
    toNumber(fighterEntity.signatureRadius, passiveSignatureRadius) - nextSignatureRadius,
  ) > 1e-6;
  applyFighterMobilityMaxVelocityCommand({
    fighterEntity,
    maxVelocity: nextMaxVelocity,
  });
  fighterEntity.signatureRadius = nextSignatureRadius;
  fighterEntity.fighterMobilityRuntimeActive = hasActiveMobilityEffect;

  if (maxVelocityChanged) {
    emitFighterMaxVelocityUpdate(scene, fighterEntity, nowMs);
  }

  return maxVelocityChanged || signatureRadiusChanged;
}

function getEffectiveAbilityDurationMs(abilityMeta) {
  return Math.max(1, toInt(abilityMeta && abilityMeta.durationMs, 1));
}

function getEffectiveAbilityCooldownMs(abilityMeta) {
  const cooldownMs = abilityMeta && abilityMeta.cooldownMs;
  if (cooldownMs === null || cooldownMs === undefined) {
    return null;
  }
  const numericCooldownMs = toNumber(cooldownMs, NaN);
  return Number.isFinite(numericCooldownMs) && numericCooldownMs > 0
    ? Math.max(1, Math.round(numericCooldownMs))
    : null;
}

function getEffectiveAbilityChargeCount(abilityMeta) {
  const chargeCount = abilityMeta && abilityMeta.chargeCount;
  if (chargeCount === null || chargeCount === undefined) {
    return null;
  }
  const numericChargeCount = toInt(chargeCount, -1);
  return numericChargeCount >= 0 ? numericChargeCount : null;
}

function getEffectiveAbilityRearmTimeMs(abilityMeta) {
  const rearmTimeMs = abilityMeta && abilityMeta.rearmTimeMs;
  if (rearmTimeMs === null || rearmTimeMs === undefined) {
    return null;
  }
  const numericRearmTimeMs = toNumber(rearmTimeMs, NaN);
  return Number.isFinite(numericRearmTimeMs) && numericRearmTimeMs > 0
    ? Math.max(1, Math.round(numericRearmTimeMs))
    : null;
}

function usesContinuousAbilityCycle(abilityMeta) {
  return (
    abilityMeta &&
    abilityMeta.isOffensive === true &&
    getEffectiveAbilityChargeCount(abilityMeta) === null &&
    getEffectiveAbilityCooldownMs(abilityMeta) === null
  );
}

function getAbilityStateChargeCount(abilityState, abilityMeta) {
  const rawExplicitCount =
    abilityState && Object.prototype.hasOwnProperty.call(abilityState, "remainingChargeCount")
      ? abilityState.remainingChargeCount
      : undefined;
  const explicitCount =
    rawExplicitCount === null || rawExplicitCount === undefined
      ? NaN
      : Number(rawExplicitCount);
  if (Number.isFinite(explicitCount) && explicitCount >= 0) {
    return Math.max(0, Math.trunc(explicitCount));
  }
  const abilityChargeCount = getEffectiveAbilityChargeCount(abilityMeta);
  return abilityChargeCount === null ? null : abilityChargeCount;
}

function clearAbilityActiveWindow(nextState) {
  if (!nextState || typeof nextState !== "object") {
    return nextState;
  }
  delete nextState.activeSinceMs;
  delete nextState.durationMs;
  delete nextState.activeUntilMs;
  delete nextState.firedAtActivation;
  delete nextState.targetID;
  delete nextState.targetPoint;
  return nextState;
}

function refreshAbilityCharges(entity, slotID, abilityMeta, nowMs) {
  const maxChargeCount = getEffectiveAbilityChargeCount(abilityMeta);
  const rearmTimeMs = getEffectiveAbilityRearmTimeMs(abilityMeta);
  let abilityState = getEntityAbilityState(entity, slotID);
  if (
    !abilityState ||
    maxChargeCount === null ||
    rearmTimeMs === null ||
    rearmTimeMs <= 0
  ) {
    return abilityState;
  }

  const currentChargeCount = getAbilityStateChargeCount(abilityState, abilityMeta);
  if (currentChargeCount === null || currentChargeCount >= maxChargeCount) {
    if (
      currentChargeCount !== null &&
      currentChargeCount >= maxChargeCount &&
      toNumber(abilityState.cooldownEndMs, 0) > 0
    ) {
      const nextState = {
        ...abilityState,
        remainingChargeCount: maxChargeCount,
      };
      delete nextState.cooldownStartMs;
      delete nextState.cooldownEndMs;
      setEntityAbilityState(entity, slotID, nextState);
      abilityState = getEntityAbilityState(entity, slotID);
    }
    return abilityState;
  }

  let cooldownEndMs = toNumber(abilityState.cooldownEndMs, 0);
  if (cooldownEndMs <= 0 || cooldownEndMs > nowMs) {
    return abilityState;
  }

  const elapsedSinceReadyMs = Math.max(0, nowMs - cooldownEndMs);
  const restoredCharges = Math.floor(elapsedSinceReadyMs / rearmTimeMs) + 1;
  const nextChargeCount = Math.min(maxChargeCount, currentChargeCount + restoredCharges);
  const nextState = {
    ...abilityState,
    remainingChargeCount: nextChargeCount,
  };
  if (nextChargeCount >= maxChargeCount) {
    delete nextState.cooldownStartMs;
    delete nextState.cooldownEndMs;
  } else {
    const restoredWindowEndMs = cooldownEndMs + (restoredCharges * rearmTimeMs);
    nextState.cooldownStartMs = restoredWindowEndMs;
    nextState.cooldownEndMs = restoredWindowEndMs + rearmTimeMs;
  }
  setEntityAbilityState(entity, slotID, nextState);
  return getEntityAbilityState(entity, slotID);
}

function translateAbilityTimeForSession(scene, session, rawTimeMs) {
  const normalizedTimeMs = toNumber(rawTimeMs, 0);
  if (
    scene &&
    session &&
    typeof scene.getCurrentSessionFileTime === "function"
  ) {
    return scene.getCurrentSessionFileTime(session, normalizedTimeMs);
  }
  return normalizedTimeMs;
}

function buildCooldownPayload(scene, session, abilityState) {
  if (!abilityState || typeof abilityState !== "object") {
    return null;
  }

  const cooldownStartMs = toNumber(abilityState.cooldownStartMs, 0);
  const cooldownEndMs = toNumber(abilityState.cooldownEndMs, 0);
  if (cooldownStartMs <= 0 || cooldownEndMs <= cooldownStartMs) {
    return null;
  }

  return buildList([
    translateAbilityTimeForSession(scene, session, cooldownStartMs),
    translateAbilityTimeForSession(scene, session, cooldownEndMs),
  ]);
}

function buildFighterAbilitySlotStatesPayload(
  fighterEntity = null,
  session = null,
  scene = null,
  nowMs = scene && typeof scene.getCurrentSimTimeMs === "function"
    ? scene.getCurrentSimTimeMs()
    : Date.now(),
) {
  const chargeEntries = [];
  const cooldownEntries = [];
  const numericNowMs = toNumber(nowMs, Date.now());

  for (const slotID of ABILITY_SLOT_IDS) {
    const abilityState = getEntityAbilityState(fighterEntity, slotID);
    const abilityMeta = getFighterAbilityMetaForSlot(
      fighterEntity && fighterEntity.typeID,
      slotID,
    );
    const remainingChargeCount = getAbilityStateChargeCount(
      abilityState,
      abilityMeta,
    );
    if (remainingChargeCount !== null) {
      chargeEntries.push([slotID, remainingChargeCount]);
    }

    if (
      abilityState &&
      toNumber(abilityState.cooldownEndMs, 0) > numericNowMs
    ) {
      const cooldownPayload = buildCooldownPayload(scene, session, abilityState);
      if (cooldownPayload) {
        cooldownEntries.push([slotID, cooldownPayload]);
      }
    }
  }

  return buildList([
    buildDict(chargeEntries),
    buildDict(cooldownEntries),
  ]);
}

function buildFighterError(message) {
  return buildUserErrorPayload("CustomNotify", {
    notify: String(message || ""),
  });
}

function buildFighterUserError(message, values = {}) {
  return buildUserErrorPayload(
    String(message || ""),
    values && typeof values === "object" ? values : {},
  );
}

function getSceneSecurityClass(scene) {
  const security = Math.max(
    0,
    Math.min(1, toNumber(scene && scene.system && scene.system.security, 0)),
  );
  if (security <= 0) {
    return 0;
  }
  if (security < 0.45) {
    return 1;
  }
  return 2;
}

function buildAbilityViolatesSafetyError(fighterEntity, abilityMeta) {
  return buildFighterUserError("CannotActivateAbilityViolatesSafety", {
    fighterTypeID: toInt(fighterEntity && fighterEntity.typeID, 0),
    abilityNameID: toInt(abilityMeta && abilityMeta.displayNameID, 0),
  });
}

function getRequiredSafetyLevelForFighterAttack(
  scene,
  fighterEntity,
  targetEntity,
  nowMs,
  controllerEntity = null,
) {
  const evaluation = evaluateFighterOffensiveAggression(
    scene,
    fighterEntity,
    controllerEntity,
    targetEntity,
    nowMs,
  );
  return toInt(
    evaluation && evaluation.data && evaluation.data.requiredSafetyLevel,
    crimewatchState.SAFETY_LEVEL_FULL,
  );
}

function isKamikazeAbility(abilityMeta) {
  return normalizeEffectFamily(abilityMeta && abilityMeta.effectFamily) ===
    "fighterabilitykamikaze";
}

function isLaunchBombAbility(abilityMeta) {
  return normalizeEffectFamily(abilityMeta && abilityMeta.effectFamily) ===
    "fighterabilitylaunchbomb";
}

function buildAbilitySafetyRestrictionError(
  scene,
  fighterEntity,
  controllerEntity,
  abilityMeta,
  targetEntity,
  nowMs,
) {
  if (!abilityMeta || abilityMeta.isOffensive !== true || !targetEntity) {
    return null;
  }

  const evaluation = evaluateFighterOffensiveAggression(
    scene,
    fighterEntity,
    controllerEntity,
    targetEntity,
    nowMs,
  );
  if (!evaluation || evaluation.success !== true) {
    return buildAbilityViolatesSafetyError(fighterEntity, abilityMeta);
  }
  return null;
}

function buildAbilityRequiresTargetError(fighterEntity, abilityMeta) {
  return buildFighterUserError("CannotActivateAbilityRequiresTarget", {
    fighterTypeID: toInt(fighterEntity && fighterEntity.typeID, 0),
    abilityNameID: toInt(abilityMeta && abilityMeta.displayNameID, 0),
  });
}

function buildAbilitySecurityRestrictionError(scene, abilityMeta) {
  const securityClass = getSceneSecurityClass(scene);
  if (securityClass === 2 && abilityMeta && abilityMeta.disallowInHighSec) {
    return buildFighterUserError("CantInHighSecSpace", {});
  }
  if (securityClass === 1 && abilityMeta && abilityMeta.disallowInLowSec) {
    return buildFighterUserError("CantInEmpireSpace", {});
  }
  return null;
}

function resolveSquadronSize(itemOrEntity) {
  if (!itemOrEntity || typeof itemOrEntity !== "object") {
    return 0;
  }
  if (toInt(itemOrEntity.squadronSize, 0) > 0) {
    return toInt(itemOrEntity.squadronSize, 0);
  }
  return buildInventorySquadronSize(itemOrEntity);
}

function isFighterEntity(entity) {
  return Boolean(entity && entity.kind === "fighter");
}

function serializeFighterSpaceState(entity) {
  return {
    systemID: toInt(entity && entity.systemID, 0),
    position: cloneVector(entity && entity.position),
    velocity: cloneVector(entity && entity.velocity),
    direction: cloneVector(entity && entity.direction, { x: 1, y: 0, z: 0 }),
    targetPoint: cloneVector(entity && entity.targetPoint, entity && entity.position),
    speedFraction: Math.max(0, Math.min(1, toNumber(entity && entity.speedFraction, 0))),
    mode: String(entity && entity.mode || "STOP"),
    targetEntityID: toInt(entity && entity.targetEntityID, 0) || null,
    followRange: Math.max(0, toNumber(entity && entity.followRange, 0)),
    orbitDistance: Math.max(0, toNumber(entity && entity.orbitDistance, 0)),
    orbitNormal: cloneVector(entity && entity.orbitNormal, buildPerpendicular(entity && entity.direction)),
    orbitSign: toNumber(entity && entity.orbitSign, 1) < 0 ? -1 : 1,
    effectStamp: 0,
    warpDestination: null,
    ...serializePlayerCompanionScopeMetadata(entity),
  };
}

function serializeFighterRuntimeState(entity) {
  const tubeFlagID = toInt(entity && entity.tubeFlagID, 0);
  const controllerID = toInt(entity && entity.controllerID, 0);
  const controllerOwnerID = toInt(entity && entity.controllerOwnerID, 0);
  const abilityStates = cloneAbilityStates(entity && entity.fighterAbilityStates);
  if (
    tubeFlagID <= 0 &&
    controllerID <= 0 &&
    controllerOwnerID <= 0 &&
    Object.keys(abilityStates).length === 0
  ) {
    return null;
  }

  const serialized = {
    tubeFlagID: tubeFlagID > 0 ? tubeFlagID : null,
    controllerID: controllerID > 0 ? controllerID : null,
    controllerOwnerID: controllerOwnerID > 0 ? controllerOwnerID : null,
  };
  if (Object.keys(abilityStates).length > 0) {
    serialized.abilityStates = abilityStates;
  }
  return serialized;
}

// options.keepMotion: a presentation refresh of a fighter already in the
// scene (every AddBalls and slim build) leaves its motion values alone
// (only the Movement queue and Evolve write them). They come from its
// controller (the operational attributes), and re-deriving them here from the
// item reset them to the type's base until the next fighter tick put them
// back, in the middle of a tick.
function hydrateFighterEntityFromItem(entity, itemRecord = null, options = {}) {
  if (!entity) {
    return entity;
  }
  const keepMotion =
    options && options.keepMotion === true &&
    Number.isFinite(Number(entity.maxVelocity));

  const item = itemRecord || findItemById(entity.itemID) || null;
  if (!item || !isFighterItemRecord(item)) {
    return entity;
  }

  const persistedPosition = item.spaceState && item.spaceState.position;
  const hasPersistedPosition =
    persistedPosition &&
    Number.isFinite(Number(persistedPosition.x)) &&
    Number.isFinite(Number(persistedPosition.y)) &&
    Number.isFinite(Number(persistedPosition.z));

  const typeID = toInt(item.typeID, toInt(entity.typeID, 0));
  const attributes = buildEffectiveItemAttributeMap(item);
  const mass = Math.max(
    1,
    toNumber(
      attributes[ATTRIBUTE_MASS] ?? getTypeAttributeValue(typeID, "mass"),
      entity.mass || 1,
    ),
  );
  const inertia = Math.max(
    0.05,
    toNumber(
      attributes[ATTRIBUTE_AGILITY] ?? getTypeAttributeValue(typeID, "agility"),
      entity.inertia || 0.1,
    ),
  );
  const maxVelocity = Math.max(
    1,
    toNumber(
      attributes[ATTRIBUTE_MAX_VELOCITY] ?? getTypeAttributeValue(typeID, "maxVelocity"),
      entity.maxVelocity || 1,
    ),
  );
  const signatureRadius = Math.max(
    1,
    toNumber(
      attributes[ATTRIBUTE_SIGNATURE_RADIUS] ?? getTypeAttributeValue(typeID, "signatureRadius"),
      entity.signatureRadius || 1,
    ),
  );
  const fighterState =
    item && item.fighterState && typeof item.fighterState === "object"
      ? item.fighterState
      : null;

  entity.kind = "fighter";
  applyPlayerCompanionScopeMetadata(entity, item);
  applyPlayerCompanionScopeMetadata(entity, item && item.spaceState);
  entity.typeID = typeID;
  entity.groupID = toInt(item.groupID, toInt(entity.groupID, 0));
  entity.categoryID = FIGHTER_CATEGORY_ID;
  entity.ownerID = toInt(item.ownerID, toInt(entity.ownerID, 0));
  entity.itemName = String(item.itemName || entity.itemName || "Fighter");
  if (!keepMotion) {
    entity.mass = mass;
    entity.inertia = inertia;
    entity.baseMaxVelocity = maxVelocity;
    entity.maxVelocity = maxVelocity;
    entity.alignTime = inertia * Math.log(4);
    entity.maxAccelerationTime = inertia;
    entity.agilitySeconds = Math.max((mass * inertia) / 1000000, 0.05);
  }
  entity.baseSignatureRadius = signatureRadius;
  entity.signatureRadius = signatureRadius;
  entity.launcherID = toInt(item.launcherID, toInt(entity.launcherID, 0)) || null;
  entity.controllerID = toInt(
    fighterState && fighterState.controllerID,
    entity.launcherID || entity.controllerID || 0,
  ) || null;
  entity.controllerOwnerID = toInt(
    fighterState && fighterState.controllerOwnerID,
    entity.ownerID,
  );
  entity.tubeFlagID = toInt(
    fighterState && fighterState.tubeFlagID,
    entity.tubeFlagID,
  ) || null;
  entity.fighterAbilityStates = cloneAbilityStates(
    fighterState && fighterState.abilityStates,
  );
  entity.squadronSize = resolveSquadronSize(item);
  entity.maxSquadronSize = Math.max(
    entity.squadronSize,
    toInt(getTypeAttributeValue(typeID, "fighterSquadronMaxSize"), 0),
  );
  entity.persistSpaceState = true;
  if (!(entity.lockedTargets instanceof Map)) {
    entity.lockedTargets = new Map();
  }
  if (!(entity.pendingTargetLocks instanceof Map)) {
    entity.pendingTargetLocks = new Map();
  }
  if (!(entity.targetedBy instanceof Set)) {
    entity.targetedBy = new Set();
  }
  if (!(entity.activeModuleEffects instanceof Map)) {
    entity.activeModuleEffects = new Map();
  }
  if (!(entity.moduleReactivationLocks instanceof Map)) {
    entity.moduleReactivationLocks = new Map();
  }
  if (!entity.mode) {
    entity.mode = "STOP";
  }
  if (!entity.direction) {
    entity.direction = { x: 1, y: 0, z: 0 };
  }
  if (!entity.position && hasPersistedPosition) {
    entity.position = cloneVector(persistedPosition);
  }
  if (!entity.velocity) {
    entity.velocity = { x: 0, y: 0, z: 0 };
  }
  if (!entity.targetPoint && entity.position) {
    entity.targetPoint = cloneVector(entity.position);
  }
  return entity;
}

function applyFighterOperationalEntityAttributes(fighterEntity, controllerEntity = null) {
  if (!isFighterEntity(fighterEntity) || !controllerEntity) {
    return false;
  }
  const attributes = resolveFighterOperationalAttributes(fighterEntity, controllerEntity);
  if (!attributes || Object.keys(attributes).length <= 0) {
    return false;
  }

  const previousMaxVelocity = toNumber(fighterEntity.maxVelocity, 0);
  const previousSignatureRadius = toNumber(fighterEntity.signatureRadius, 0);
  const previousPassiveMaxVelocity = toNumber(
    fighterEntity.baseMaxVelocity,
    previousMaxVelocity,
  );
  const previousPassiveSignatureRadius = toNumber(
    fighterEntity.baseSignatureRadius,
    previousSignatureRadius,
  );
  const mass = Math.max(
    1,
    toNumber(attributes[ATTRIBUTE_MASS], fighterEntity.mass || 1),
  );
  const inertia = Math.max(
    0.05,
    toNumber(attributes[ATTRIBUTE_AGILITY], fighterEntity.inertia || 0.1),
  );
  const maxVelocity = Math.max(
    1,
    toNumber(attributes[ATTRIBUTE_MAX_VELOCITY], fighterEntity.maxVelocity || 1),
  );
  const signatureRadius = Math.max(
    1,
    toNumber(
      attributes[ATTRIBUTE_SIGNATURE_RADIUS],
      fighterEntity.signatureRadius || 1,
    ),
  );

  const operationalMotionCommand = createFighterOperationalMotionCommand({
    fighterEntity,
    mass,
    inertia,
    maxVelocity,
    alignTime: inertia * Math.log(4),
    maxAccelerationTime: inertia,
    agilitySeconds: Math.max((mass * inertia) / 1000000, 0.05),
  });
  operationalMotionCommand.applyBaseState();
  fighterEntity.baseSignatureRadius = signatureRadius;
  if (fighterEntity.fighterMobilityRuntimeActive !== true) {
    operationalMotionCommand.applyLiveMaxVelocity();
    fighterEntity.signatureRadius = signatureRadius;
  }
  operationalMotionCommand.applyAgilityState();
  fighterEntity.shieldCapacity = Math.max(
    0,
    toNumber(attributes[ATTRIBUTE_SHIELD_CAPACITY], fighterEntity.shieldCapacity || 0),
  );
  fighterEntity.shieldRechargeRate = Math.max(
    0,
    toNumber(
      attributes[ATTRIBUTE_SHIELD_RECHARGE_RATE],
      fighterEntity.shieldRechargeRate || 0,
    ),
  );
  fighterEntity.armorHP = Math.max(
    0,
    toNumber(attributes[ATTRIBUTE_ARMOR_HP], fighterEntity.armorHP || 0),
  );
  fighterEntity.structureHP = Math.max(
    0,
    toNumber(attributes[ATTRIBUTE_STRUCTURE_HP], fighterEntity.structureHP || 0),
  );
  fighterEntity.passiveDerivedState = {
    ...(fighterEntity.passiveDerivedState || {}),
    attributes: { ...attributes },
  };
  return (
    Math.abs(previousPassiveMaxVelocity - maxVelocity) > 1e-6 ||
    Math.abs(previousPassiveSignatureRadius - signatureRadius) > 1e-6
  );
}

function persistFighterEntityState(entity) {
  if (!isFighterEntity(entity)) {
    return false;
  }

  const squadronSize = Math.max(0, resolveSquadronSize(entity));
  const singleton = squadronSize <= 1 ? 1 : 0;
  const quantity = singleton === 1 ? 1 : squadronSize;

  const result = updateInventoryItem(entity.itemID, (currentItem) => ({
    ...currentItem,
    locationID: toInt(entity.systemID, toInt(currentItem.locationID, 0)),
    flagID: 0,
    singleton,
    quantity,
    stacksize: quantity,
    launcherID: toInt(entity.launcherID ?? entity.controllerID, 0) || null,
    spaceState: serializeFighterSpaceState(entity),
    fighterState: serializeFighterRuntimeState(entity),
    conditionState: normalizeShipConditionState(entity.conditionState),
  }));

  if (!result.success) {
    log.warn(
      `[FighterRuntime] Failed to persist fighter ${entity.itemID}: ${result.errorMsg}`,
    );
  }
  return result.success;
}

function clearFighterCommandState(entity) {
  if (!entity) {
    return;
  }

  entity.fighterCommand = null;
  entity.fighterRecallTubeFlagID = null;
}

function resolveRuntimeSceneForSession(runtime, session, systemID = 0) {
  if (!runtime) {
    return null;
  }
  const sessionScene =
    session && typeof runtime.getSceneForSession === "function"
      ? runtime.getSceneForSession(session)
      : null;
  if (sessionScene || sessionClaimsAbyssalScene(session)) {
    return sessionScene;
  }
  return (
    typeof runtime.ensureScene === "function"
      ? runtime.ensureScene(toInt(systemID, 0))
      : null
  );
}

function getShipStateForSession(session) {
  const characterID = toInt(session && (session.characterID || session.charid), 0);
  if (characterID <= 0) {
    return null;
  }

  const shipRecord =
    resolveControlledStructureRecord(session) ||
    resolveActiveShipRecord(characterID);
  const systemID = toInt(
    session && session._space && session._space.systemID,
    toInt(shipRecord && shipRecord.spaceState && shipRecord.spaceState.systemID, 0),
  );
  if (!shipRecord || systemID <= 0) {
    return null;
  }

  const runtime = getRuntime();
  const scene = resolveRuntimeSceneForSession(runtime, session, systemID);
  if (
    scene &&
    shipRecord.controlledStructure &&
    typeof scene.syncStructureEntitiesFromState === "function"
  ) {
    scene.syncStructureEntitiesFromState({ broadcast: false });
  }
  const shipEntity = scene ? scene.getEntityByID(shipRecord.itemID) : null;
  if (!scene || !shipEntity) {
    return null;
  }

  return {
    characterID,
    shipRecord,
    shipEntity,
    scene,
  };
}

function getSceneFighterEntities(scene) {
  if (!scene || !(scene.dynamicEntities instanceof Map) || scene.dynamicEntities.size === 0) {
    return [];
  }

  if (scene.fighterEntityIDs instanceof Set && scene.fighterEntityIDs.size > 0) {
    return [...scene.fighterEntityIDs]
      .map((entityID) => scene.dynamicEntities.get(entityID) || null)
      .filter(Boolean);
  }

  const fighters = [];
  for (const entity of scene.dynamicEntities.values()) {
    if (isFighterEntity(entity)) {
      fighters.push(entity);
    }
  }
  return fighters;
}

function listControlledFighterEntities(scene, shipID) {
  const numericShipID = toInt(shipID, 0);
  return getSceneFighterEntities(scene)
    .filter((entity) => toInt(entity.controllerID, 0) === numericShipID);
}

function buildFightersInSpaceRowsForShip(scene, shipID) {
  return listControlledFighterEntities(scene, shipID)
    .filter((entity) => isFighterTubeFlag(entity.tubeFlagID))
    .sort((left, right) => (
      toInt(left && left.tubeFlagID, 0) - toInt(right && right.tubeFlagID, 0)
    ))
    .map((entity) => [
      toInt(entity.tubeFlagID, 0),
      toInt(entity.itemID, 0),
      toInt(entity.typeID, 0),
      resolveSquadronSize(entity),
    ]);
}

function buildAbilityStateEntriesForShip(scene, shipID, session = null) {
  const nowMs =
    scene && typeof scene.getCurrentSimTimeMs === "function"
      ? scene.getCurrentSimTimeMs()
      : Date.now();
  return listControlledFighterEntities(scene, shipID)
    .map((entity) => [
      toInt(entity.itemID, 0),
      buildFighterAbilitySlotStatesPayload(entity, session, scene, nowMs),
    ])
    .filter((entry) => entry[0] > 0);
}

function syncInventoryChangesToSession(session, changes = []) {
  if (!session) {
    return;
  }

  for (const change of Array.isArray(changes) ? changes : []) {
    if (!change || !change.item) {
      continue;
    }

    syncInventoryItemForCharacterSession(
      session,
      change.item,
      change.previousData || {},
      { emitCfgLocation: true },
    );
  }
}

function getShipTubeItem(shipRecord, tubeFlagID) {
  if (!shipRecord || !isFighterTubeFlag(tubeFlagID)) {
    return null;
  }

  const contents = listContainerItems(
    toInt(shipRecord.ownerID, 0),
    shipRecord.itemID,
    tubeFlagID,
  )
    .filter(Boolean)
    .sort((left, right) => toInt(left && left.itemID, 0) - toInt(right && right.itemID, 0));

  return contents[0] || null;
}

function listShipTubeItems(shipRecord, options = {}) {
  if (!shipRecord) {
    return [];
  }

  const excludeItemID = toInt(options.excludeItemID, 0);
  const items = [];
  for (const tubeFlagID of FIGHTER_TUBE_FLAGS) {
    for (const item of listContainerItems(
      toInt(shipRecord.ownerID, 0),
      shipRecord.itemID,
      tubeFlagID,
    )) {
      if (item && (!excludeItemID || toInt(item.itemID, 0) !== excludeItemID)) {
        items.push(item);
      }
    }
  }

  return items;
}

function getOwnerSession(shipRecord, fallbackSession = null) {
  const ownerSession = findSessionByCharacterID(toInt(shipRecord && shipRecord.ownerID, 0));
  return ownerSession || fallbackSession || null;
}

function sendNotification(session, name, payload) {
  if (!session || typeof session.sendNotification !== "function") {
    return false;
  }

  session.sendNotification(name, "clientID", payload);
  return true;
}

function queueNotification(session, name, payload) {
  if (!session || typeof session.sendNotification !== "function") {
    return false;
  }

  setImmediate(() => {
    if (!session || typeof session.sendNotification !== "function") {
      return;
    }
    session.sendNotification(name, "clientID", payload);
  });
  return true;
}

function notifyTubeContent(session, tubeFlagID, fighterItemOrEntity) {
  return sendNotification(session, "OnFighterTubeContentUpdate", [
    toInt(tubeFlagID, 0),
    toInt(fighterItemOrEntity && fighterItemOrEntity.itemID, 0),
    toInt(fighterItemOrEntity && fighterItemOrEntity.typeID, 0),
    resolveSquadronSize(fighterItemOrEntity),
  ]);
}

function notifyTubeEmpty(session, tubeFlagID) {
  return sendNotification(session, "OnFighterTubeContentEmpty", [
    toInt(tubeFlagID, 0),
  ]);
}

function notifyTubeState(session, tubeFlagID, stateID, userError = null) {
  return sendNotification(session, "OnFighterTubeTaskStatus", [
    toInt(tubeFlagID, 0),
    String(stateID || ""),
    null,
    null,
    userError,
  ]);
}

function notifyFighterAdded(session, scene, fighterEntity) {
  if (!isFighterEntity(fighterEntity)) {
    return false;
  }

  return sendNotification(session, "OnFighterAddedToController", [
    toInt(fighterEntity.itemID, 0),
    toInt(fighterEntity.typeID, 0),
    toInt(fighterEntity.tubeFlagID, 0),
    resolveSquadronSize(fighterEntity),
    buildFighterAbilitySlotStatesPayload(fighterEntity, session, scene),
  ]);
}

function notifyFighterRemoved(session, fighterID, tubeFlagID) {
  return sendNotification(session, "OnFighterRemovedFromController", [
    toInt(fighterID, 0),
    toInt(tubeFlagID, 0),
  ]);
}

function notifyAbilityActivated(session, scene, fighterEntity, slotID, abilityState) {
  if (!isFighterEntity(fighterEntity)) {
    return false;
  }

  const payload = [
    toInt(fighterEntity.itemID, 0),
    toInt(slotID, 0),
    abilityState && Number.isFinite(Number(abilityState.remainingChargeCount))
      ? toInt(abilityState.remainingChargeCount, 0)
      : null,
    translateAbilityTimeForSession(
      scene,
      session,
      abilityState && abilityState.activeSinceMs,
    ),
    Math.max(1, toInt(abilityState && abilityState.durationMs, 1)),
    buildCooldownPayload(scene, session, abilityState),
  ];
  return sendNotification(session, "OnFighterAbilitySlotActivated", payload);
}

function queueAbilityActivated(session, scene, fighterEntity, slotID, abilityState) {
  if (!isFighterEntity(fighterEntity)) {
    return false;
  }

  const payload = [
    toInt(fighterEntity.itemID, 0),
    toInt(slotID, 0),
    abilityState && Number.isFinite(Number(abilityState.remainingChargeCount))
      ? toInt(abilityState.remainingChargeCount, 0)
      : null,
    translateAbilityTimeForSession(
      scene,
      session,
      abilityState && abilityState.activeSinceMs,
    ),
    Math.max(1, toInt(abilityState && abilityState.durationMs, 1)),
    buildCooldownPayload(scene, session, abilityState),
  ];
  return queueNotification(session, "OnFighterAbilitySlotActivated", payload);
}

function notifyAbilityDeactivated(session, fighterID, slotID, failureReason = null) {
  return sendNotification(session, "OnFighterAbilitySlotDeactivated", [
    toInt(fighterID, 0),
    toInt(slotID, 0),
    failureReason,
  ]);
}

function queueAbilityDeactivated(session, fighterID, slotID, failureReason = null) {
  return queueNotification(session, "OnFighterAbilitySlotDeactivated", [
    toInt(fighterID, 0),
    toInt(slotID, 0),
    failureReason,
  ]);
}

function notifySquadronSizeChanged(session, fighterID, squadronSize) {
  return sendNotification(session, "OnInSpaceSquadronSizeChanged", [
    toInt(fighterID, 0),
    Math.max(0, toInt(squadronSize, 0)),
  ]);
}

function emitFighterAbilityActivationFx(scene, fighterEntity, slotID, abilityMeta, abilityState) {
  if (
    !scene ||
    !isFighterEntity(fighterEntity) ||
    !abilityMeta ||
    abilityMeta.isOffensive === true ||
    !abilityMeta.effectGuid
  ) {
    return false;
  }

  const pseudoModuleItem = buildFighterPseudoModuleItem(fighterEntity, slotID);
  scene.broadcastSpecialFx(
    fighterEntity.itemID,
    abilityMeta.effectGuid,
    {
      moduleID: pseudoModuleItem.itemID,
      moduleTypeID: pseudoModuleItem.typeID,
      targetID: toInt(abilityState && abilityState.targetID, 0) || null,
      isOffensive: false,
      start: true,
      active: true,
      duration: getEffectiveAbilityDurationMs(abilityMeta),
      repeat: 1,
    },
    fighterEntity,
  );
  return true;
}

function buildFighterPseudoModuleItem(fighterEntity, slotID = 0) {
  return {
    itemID: toInt(fighterEntity && fighterEntity.itemID, 0),
    typeID: toInt(fighterEntity && fighterEntity.typeID, 0),
    groupID: toInt(fighterEntity && fighterEntity.groupID, 0),
    flagID: Math.max(0, toInt(slotID, 0)),
    locationID: toInt(fighterEntity && fighterEntity.itemID, 0),
    singleton: 1,
    quantity: 1,
    stacksize: 1,
    itemName: String(fighterEntity && fighterEntity.itemName || "Fighter"),
    moduleState: {
      isOnline: true,
      isActive: true,
    },
  };
}

function resolveFighterControllerSession(fighterEntity, controllerEntity = null) {
  if (
    controllerEntity &&
    controllerEntity.session &&
    typeof controllerEntity.session.sendNotification === "function"
  ) {
    return controllerEntity.session;
  }

  const controllerCharacterID = toInt(
    controllerEntity &&
      (
        controllerEntity.session &&
        controllerEntity.session.characterID
      ) ||
      controllerEntity &&
      (
        controllerEntity.pilotCharacterID ??
        controllerEntity.characterID
      ) ||
      fighterEntity &&
      (
        fighterEntity.controllerOwnerID ??
        fighterEntity.ownerID
      ),
    0,
  );
  if (controllerCharacterID <= 0) {
    return null;
  }
  return findSessionByCharacterID(controllerCharacterID) || null;
}

function buildFighterCombatSourceEntity(fighterEntity, controllerEntity = null) {
  if (!fighterEntity) {
    return null;
  }

  const controllerSession = resolveFighterControllerSession(
    fighterEntity,
    controllerEntity,
  );
  const controllerCharacterID = toInt(
    controllerEntity &&
      (
        controllerEntity.session &&
        controllerEntity.session.characterID
      ) ||
      controllerEntity &&
      (
        controllerEntity.pilotCharacterID ??
        controllerEntity.characterID
      ) ||
      fighterEntity.controllerOwnerID ||
      fighterEntity.ownerID,
    0,
  );
  return {
    ...fighterEntity,
    session: controllerSession,
    characterID: controllerCharacterID || toInt(fighterEntity.characterID, 0) || null,
    pilotCharacterID:
      controllerCharacterID || toInt(fighterEntity.pilotCharacterID, 0) || null,
  };
}

function buildFighterCrimewatchSourceEntity(
  fighterEntity,
  controllerEntity = null,
) {
  const fighterCombatSource = buildFighterCombatSourceEntity(
    fighterEntity,
    controllerEntity,
  );
  if (!fighterCombatSource) {
    return null;
  }
  // Crimewatch belongs to the controlling pilot/hull, not to each individual
  // squadron ball. Use the same attributed source for safety evaluation and
  // consequence commit so the two phases cannot disagree about the attacker.
  return {
    ...fighterCombatSource,
    itemID: toInt(
      controllerEntity && controllerEntity.itemID,
      toInt(fighterCombatSource.itemID, 0),
    ),
    position:
      controllerEntity && controllerEntity.position ||
      fighterCombatSource.position,
    direction:
      controllerEntity && controllerEntity.direction ||
      fighterCombatSource.direction,
  };
}

function evaluateFighterOffensiveAggression(
  scene,
  fighterEntity,
  controllerEntity,
  targetEntity,
  nowMs,
) {
  if (
    !scene ||
    !targetEntity ||
    !crimewatchState ||
    typeof crimewatchState.evaluateOffensiveAggression !== "function"
  ) {
    return { success: false, errorMsg: "CRIMEWATCH_AGGRESSION_FAILED" };
  }
  const sourceEntity = buildFighterCrimewatchSourceEntity(
    fighterEntity,
    controllerEntity,
  );
  if (!sourceEntity) {
    return { success: false, errorMsg: "FIGHTER_CONTROLLER_NOT_FOUND" };
  }
  try {
    const evaluation = crimewatchState.evaluateOffensiveAggression(
      scene,
      sourceEntity,
      targetEntity,
      nowMs,
    );
    return evaluation;
  } catch (error) {
    log.warn(
      `[FighterRuntime] Crimewatch evaluation failed: ${
        error && error.message || error || "UNKNOWN_ERROR"
      }`,
    );
    return { success: false, errorMsg: "CRIMEWATCH_AGGRESSION_FAILED" };
  }
}

function getFighterOrbitDistance(fighterItemOrTypeID) {
  const itemRecord = resolveFighterRuntimeItemRecord(fighterItemOrTypeID);
  const typeID = toInt(itemRecord && itemRecord.typeID, toInt(fighterItemOrTypeID, 0));
  const attributes = buildEffectiveItemAttributeMap(itemRecord || typeID);
  return Math.max(
    DEFAULT_FIGHTER_ORBIT_DISTANCE_METERS,
    toNumber(
      attributes[ATTRIBUTE_FIGHTER_SQUADRON_ORBIT_RANGE] ??
        getTypeAttributeValue(typeID, "fighterSquadronOrbitRange"),
      DEFAULT_FIGHTER_ORBIT_DISTANCE_METERS,
    ),
  );
}

function syncFighterOffensiveMovement(
  scene,
  fighterEntity,
  targetEntity,
  abilitySnapshot,
  nowMs = null,
) {
  if (!scene || !fighterEntity || !targetEntity || !abilitySnapshot) {
    return false;
  }
  // A target whose warp has started gets no movement order from the attack:
  // Destiny stopped the squadron at the warp start (StopAllFollowers in
  // RealWarp), and the lost-target rule leaves it there; the ability itself ends
  // when the target leaves the squadron's Grid bubble. Re-issuing the Follow
  // chased the warping target until the follower clean-up stopped it again. A
  // target still aligning is chased as normal until its warp starts.
  if (isWarping(targetEntity)) {
    return false;
  }

  const preferredOrbitDistance = getFighterOrbitDistance(fighterEntity);
  const desiredAttackRange = Math.max(
    preferredOrbitDistance,
    toNumber(abilitySnapshot.rangeMeters, 0),
  );
  const chaseRange = Math.max(
    desiredAttackRange,
    desiredAttackRange + Math.max(0, toNumber(abilitySnapshot.falloffMeters, 0)),
  );
  const currentSurfaceDistance = surfaceDistance(
    fighterEntity,
    targetEntity,
    scene,
    nowMs,
    "fighter-offensive-movement",
  );

  if (currentSurfaceDistance > chaseRange + 1) {
    scene.followShipEntity(
      fighterEntity,
      targetEntity.itemID,
      desiredAttackRange,
      { broadcast: true },
    );
    return false;
  }

  scene.orbitShipEntity(
    fighterEntity,
    targetEntity.itemID,
    preferredOrbitDistance,
    { broadcast: true },
  );
  return currentSurfaceDistance <= chaseRange + 1;
}

function buildCombinedFighterDamageResult(passes, rawDamage, fighterEntity, destroyed) {
  const combinedPerLayer = new Map([
    ["shield", 0],
    ["armor", 0],
    ["structure", 0],
  ]);

  for (const pass of passes) {
    const resultData = pass && pass.resultData ? pass.resultData : null;
    for (const layerEntry of Array.isArray(resultData && resultData.perLayer)
      ? resultData.perLayer
      : []) {
      const layerName = String(layerEntry && layerEntry.layer || "");
      if (!combinedPerLayer.has(layerName)) {
        continue;
      }
      combinedPerLayer.set(
        layerName,
        combinedPerLayer.get(layerName) + toNumber(layerEntry && layerEntry.appliedEffective, 0),
      );
    }
  }

  return {
    success: true,
    data: {
      rawDamage: normalizeDamageVector(rawDamage),
      perLayer: [...combinedPerLayer.entries()].map(([layer, appliedEffective]) => ({
        layer,
        appliedEffective,
      })),
      beforeConditionState:
        passes.length > 0
          ? {
              ...(passes[0].beforeConditionState || {}),
            }
          : normalizeShipConditionState(fighterEntity && fighterEntity.conditionState),
      afterConditionState: normalizeShipConditionState(
        fighterEntity && fighterEntity.conditionState,
      ),
      destroyed: destroyed === true,
    },
  };
}

function applyDamageToFighterSquadron(scene, fighterEntity, rawDamage, whenMs = null) {
  void scene;
  void whenMs;

  if (!isFighterEntity(fighterEntity)) {
    return null;
  }

  let remainingDamage = normalizeDamageVector(rawDamage);
  if (sumDamageVector(remainingDamage) <= 0) {
    return {
      damageResult: {
        success: true,
        data: {
          rawDamage: remainingDamage,
          perLayer: [],
          beforeConditionState: normalizeShipConditionState(fighterEntity.conditionState),
          afterConditionState: normalizeShipConditionState(fighterEntity.conditionState),
          destroyed: false,
        },
      },
      beforeSquadronSize: resolveSquadronSize(fighterEntity),
      afterSquadronSize: resolveSquadronSize(fighterEntity),
      squadronSizeChanged: false,
    };
  }

  const beforeSquadronSize = resolveSquadronSize(fighterEntity);
  let currentSquadronSize = beforeSquadronSize;
  const passes = [];

  while (currentSquadronSize > 0 && sumDamageVector(remainingDamage) > 0) {
    const beforeConditionState = normalizeShipConditionState(
      fighterEntity.conditionState,
    );
    const passResult = applyDamageToEntity(fighterEntity, remainingDamage);
    if (!passResult || passResult.success !== true || !passResult.data) {
      return {
        damageResult: passResult,
        beforeSquadronSize,
        afterSquadronSize: currentSquadronSize,
        squadronSizeChanged: false,
      };
    }

    passes.push({
      beforeConditionState,
      resultData: passResult.data,
    });
    remainingDamage = normalizeDamageVector(passResult.data.remainingRaw);

    if (passResult.data.destroyed !== true) {
      break;
    }

    currentSquadronSize -= 1;
    if (currentSquadronSize <= 0) {
      break;
    }

    fighterEntity.conditionState = normalizeShipConditionState(null);
  }

  fighterEntity.squadronSize = Math.max(0, currentSquadronSize);

  return {
    damageResult: buildCombinedFighterDamageResult(
      passes,
      rawDamage,
      fighterEntity,
      currentSquadronSize <= 0,
    ),
    beforeSquadronSize,
    afterSquadronSize: currentSquadronSize,
    squadronSizeChanged: currentSquadronSize !== beforeSquadronSize,
  };
}

function handleFighterPostDamage(scene, fighterEntity, damageResult, options = {}) {
  if (!scene || !isFighterEntity(fighterEntity) || !damageResult || damageResult.success !== true) {
    return false;
  }

  persistFighterEntityState(fighterEntity);
  const beforeSquadronSize = Math.max(0, toInt(options.beforeSquadronSize, resolveSquadronSize(fighterEntity)));
  const afterSquadronSize = resolveSquadronSize(fighterEntity);
  if (afterSquadronSize === beforeSquadronSize || afterSquadronSize <= 0) {
    return false;
  }

  const ownerSession = resolveFighterControllerSession(fighterEntity, options.controllerEntity || null);
  notifySquadronSizeChanged(ownerSession, fighterEntity.itemID, afterSquadronSize);
  scene.broadcastSlimItemChanges([fighterEntity]);
  return true;
}

function handleFighterDestroyed(scene, fighterEntity) {
  if (!scene || !isFighterEntity(fighterEntity)) {
    return false;
  }

  const controllerID = toInt(fighterEntity.controllerID, 0);
  const controllerEntity = controllerID > 0 ? scene.getEntityByID(controllerID) : null;
  removeAllFighterEwarEffects(scene, fighterEntity, controllerEntity);
  const controllerOwnerID = toInt(fighterEntity.controllerOwnerID, 0);
  const ownerSession = resolveFighterControllerSession(fighterEntity, controllerEntity);
  let notified = false;
  if (ownerSession && toInt(fighterEntity.tubeFlagID, 0) > 0) {
    notified = notifyFighterRemoved(
      ownerSession,
      fighterEntity.itemID,
      fighterEntity.tubeFlagID,
    );
  }
  const synced = controllerEntity
    ? syncFightersLaunchedTetherRestriction(
      scene,
      controllerEntity,
      controllerOwnerID,
    )
    : false;
  return notified || synced;
}

function executeFighterOffensiveCycle(scene, fighterEntity, controllerEntity, slotID, abilityState, nowMs) {
  const runtime = getRuntime();
  const droneInterop =
    runtime && runtime.droneInterop && typeof runtime.droneInterop === "object"
      ? runtime.droneInterop
      : null;
  if (!scene || !isFighterEntity(fighterEntity) || !controllerEntity || !droneInterop) {
    return { continueActive: false, deactivate: true };
  }

  const snapshot = resolveFighterAbilitySnapshot(
    fighterEntity,
    controllerEntity,
    slotID,
  );
  if (!snapshot || !snapshot.offensiveKind) {
    return { continueActive: false, deactivate: true };
  }

  const targetID = toInt(abilityState && abilityState.targetID, 0);
  const targetEntity = targetID > 0 ? scene.getEntityByID(targetID) : null;
  if (
    !targetEntity ||
    !hasDamageableHealth(targetEntity) ||
    !canPlayerCompanionActOnTarget(
      scene,
      null,
      fighterEntity,
      controllerEntity,
      targetEntity,
    )
  ) {
    return { continueActive: false, deactivate: true };
  }

  syncFighterOffensiveMovement(
    scene,
    fighterEntity,
    targetEntity,
    snapshot,
    nowMs,
  );
  const rangeGate = Math.max(
    0,
    toNumber(snapshot.rangeMeters, 0) + Math.max(0, toNumber(snapshot.falloffMeters, 0)),
  );
  if (
    rangeGate > 0 &&
    surfaceDistance(
      fighterEntity,
      targetEntity,
      scene,
      nowMs,
      "fighter-offensive-cycle",
    ) > rangeGate + 1
  ) {
    return { continueActive: true, deactivate: false };
  }

  const pseudoModuleItem = buildFighterPseudoModuleItem(fighterEntity, slotID);
  const combatSourceEntity = buildFighterCombatSourceEntity(
    fighterEntity,
    controllerEntity,
  ) || fighterEntity;
  let shotDamage = null;
  let hitQuality = 0;
  let appliedDamageAmount = 0;
  let damageResult = null;
  let destroyResult = null;
  let sourceDestroyed = false;

  if (snapshot.effectGuid) {
    scene.broadcastSpecialFx(
      fighterEntity.itemID,
      snapshot.effectGuid,
      {
        moduleID: pseudoModuleItem.itemID,
        moduleTypeID: pseudoModuleItem.typeID,
        targetID: targetEntity.itemID,
        isOffensive: true,
        start: true,
        active: false,
        duration: getEffectiveAbilityDurationMs(snapshot),
        repeat: 1,
      },
      fighterEntity,
    );
  }

  let weaponDamageResult = null;
  if (snapshot.offensiveKind === "turret") {
    const shotResult = droneInterop.resolveTurretShot({
      attackerEntity: fighterEntity,
      targetEntity,
      weaponSnapshot: {
        rawShotDamage: snapshot.rawShotDamage,
        trackingSpeed: snapshot.trackingSpeed,
        optimalSigRadius: snapshot.optimalSigRadius,
        optimalRange: snapshot.rangeMeters,
        falloff: snapshot.falloffMeters,
      },
    });
    shotDamage = shotResult && shotResult.shotDamage ? shotResult.shotDamage : null;
    hitQuality = droneInterop.getCombatMessageHitQuality(shotResult);
    if (shotResult && shotResult.hit === true) {
      weaponDamageResult = droneInterop.applyWeaponDamageToTarget(
        scene,
        combatSourceEntity,
        targetEntity,
        shotResult.shotDamage,
        nowMs,
      );
      damageResult = weaponDamageResult && weaponDamageResult.damageResult
        ? weaponDamageResult.damageResult
        : null;
      destroyResult = weaponDamageResult && weaponDamageResult.destroyResult
        ? weaponDamageResult.destroyResult
        : null;
    }
  } else if (snapshot.offensiveKind === "missile") {
    const missileDamageResult = ["npc","core","bonus"].includes(targetEntity.fabricatorRole) && require("../seasons/fabricatorModel").SPACE_SUPERIORITY_TYPES.has(Number(fighterEntity.typeID))
      ? {appliedDamage:snapshot.rawShotDamage} : resolveMissileAppliedDamage({
      rawShotDamage: snapshot.rawShotDamage,
      explosionRadius: snapshot.explosionRadius,
      explosionVelocity: snapshot.explosionVelocity,
      damageReductionFactor: snapshot.damageReductionFactor,
      damageReductionSensitivity: snapshot.damageReductionSensitivity,
    }, targetEntity);
    shotDamage = missileDamageResult && missileDamageResult.appliedDamage
      ? missileDamageResult.appliedDamage
      : null;
    hitQuality = sumDamageVector(shotDamage) > 0 ? 4 : 0;
    if (sumDamageVector(shotDamage) > 0) {
      weaponDamageResult = droneInterop.applyWeaponDamageToTarget(
        scene,
        combatSourceEntity,
        targetEntity,
        shotDamage,
        nowMs,
      );
      damageResult = weaponDamageResult && weaponDamageResult.damageResult
        ? weaponDamageResult.damageResult
        : null;
      destroyResult = weaponDamageResult && weaponDamageResult.destroyResult
        ? weaponDamageResult.destroyResult
        : null;
    }
  } else if (snapshot.offensiveKind === "kamikaze") {
    shotDamage = snapshot.rawShotDamage;
    hitQuality = sumDamageVector(shotDamage) > 0 ? 4 : 0;
    if (sumDamageVector(shotDamage) > 0) {
      weaponDamageResult = droneInterop.applyWeaponDamageToTarget(
        scene,
        combatSourceEntity,
        targetEntity,
        shotDamage,
        nowMs,
        { destructionReason: "fighter-kamikaze" },
      );
      damageResult = weaponDamageResult && weaponDamageResult.damageResult
        ? weaponDamageResult.damageResult
        : null;
      destroyResult = weaponDamageResult && weaponDamageResult.destroyResult
        ? weaponDamageResult.destroyResult
        : null;
    }

    // Kamikaze spends the entire squadron after its delayed impact. Route the
    // self-destruction through the normal combat path so inventory removal,
    // controller updates, and fighter cleanup are identical to enemy fire.
    const selfDestruction = droneInterop.applyWeaponDamageToTarget(
      scene,
      combatSourceEntity,
      fighterEntity,
      {
        em: Number.MAX_SAFE_INTEGER,
        thermal: Number.MAX_SAFE_INTEGER,
        kinetic: Number.MAX_SAFE_INTEGER,
        explosive: Number.MAX_SAFE_INTEGER,
      },
      nowMs,
      { destructionReason: "fighter-kamikaze" },
    );
    sourceDestroyed = Boolean(
      selfDestruction &&
      selfDestruction.destroyResult &&
      selfDestruction.destroyResult.success === true,
    );
  }

  appliedDamageAmount = droneInterop.getAppliedDamageAmount(damageResult);
  if (appliedDamageAmount > 0) {
    droneInterop.noteKillmailDamage(
      combatSourceEntity,
      targetEntity,
      appliedDamageAmount,
      {
        whenMs: nowMs,
        weaponSnapshot: {
          ...snapshot,
          moduleTypeID: pseudoModuleItem.typeID,
        },
        moduleItem: pseudoModuleItem,
        chargeItem: null,
      },
    );
  }
  if (destroyResult && destroyResult.success === true) {
    droneInterop.recordKillmailFromDestruction(targetEntity, destroyResult, {
      attackerEntity: combatSourceEntity,
      victimSession: weaponDamageResult && weaponDamageResult.victimSession,
      whenMs: nowMs,
      weaponSnapshot: {
        ...snapshot,
        moduleTypeID: pseudoModuleItem.typeID,
      },
      moduleItem: pseudoModuleItem,
      chargeItem: null,
    });
  }

  droneInterop.notifyWeaponDamageMessages(
    combatSourceEntity,
    targetEntity,
    pseudoModuleItem,
    shotDamage,
    appliedDamageAmount,
    hitQuality,
  );

  return {
    continueActive: usesContinuousAbilityCycle(snapshot),
    deactivate: false,
    sourceDestroyed,
  };
}

function executeFighterBombCycle(scene, fighterEntity, controllerEntity, slotID, abilityState, nowMs) {
  const runtime = getRuntime();
  const droneInterop =
    runtime && runtime.droneInterop && typeof runtime.droneInterop === "object"
      ? runtime.droneInterop
      : null;
  const targetPoint = abilityState && abilityState.targetPoint;
  if (
    !scene ||
    !isFighterEntity(fighterEntity) ||
    !controllerEntity ||
    !droneInterop ||
    !targetPoint ||
    typeof targetPoint !== "object"
  ) {
    return { continueActive: false, deactivate: true };
  }

  const bombTypeID = toInt(
    getTypeAttributeValue(fighterEntity.typeID, "fighterAbilityLaunchBombType"),
    0,
  );
  if (bombTypeID <= 0) {
    return { continueActive: false, deactivate: true };
  }
  const blastRangeMeters = Math.max(
    0,
    toNumber(
      getTypeAttributeValue(bombTypeID, "empFieldRange") ||
        getTypeAttributeValue(bombTypeID, "explosionRange"),
      0,
    ),
  );
  const damageVector = {
    em: Math.max(0, toNumber(getTypeAttributeValue(bombTypeID, "emDamage"), 0)),
    thermal: Math.max(0, toNumber(getTypeAttributeValue(bombTypeID, "thermalDamage"), 0)),
    kinetic: Math.max(0, toNumber(getTypeAttributeValue(bombTypeID, "kineticDamage"), 0)),
    explosive: Math.max(0, toNumber(getTypeAttributeValue(bombTypeID, "explosiveDamage"), 0)),
  };
  if (blastRangeMeters <= 0 || sumDamageVector(damageVector) <= 0) {
    return { continueActive: false, deactivate: true };
  }

  const combatSourceEntity = buildFighterCombatSourceEntity(
    fighterEntity,
    controllerEntity,
  ) || fighterEntity;
  const pseudoModuleItem = buildFighterPseudoModuleItem(fighterEntity, slotID);
  for (const targetEntity of scene.dynamicEntities.values()) {
    if (
      !targetEntity ||
      toInt(targetEntity.itemID, 0) === toInt(fighterEntity.itemID, 0) ||
      !hasDamageableHealth(targetEntity) ||
      distance(targetEntity.position, targetPoint) > blastRangeMeters
    ) {
      continue;
    }

    const weaponDamageResult = droneInterop.applyWeaponDamageToTarget(
      scene,
      combatSourceEntity,
      targetEntity,
      damageVector,
      nowMs,
      { destructionReason: "fighter-bomb" },
    );
    const appliedDamageAmount = droneInterop.getAppliedDamageAmount(
      weaponDamageResult && weaponDamageResult.damageResult,
    );
    if (appliedDamageAmount > 0) {
      droneInterop.noteKillmailDamage(
        combatSourceEntity,
        targetEntity,
        appliedDamageAmount,
        {
          whenMs: nowMs,
          weaponSnapshot: {
            effectFamily: "fighterAbilityLaunchBomb",
            moduleTypeID: pseudoModuleItem.typeID,
            rawShotDamage: damageVector,
          },
          moduleItem: pseudoModuleItem,
          chargeItem: null,
        },
      );
    }
    if (
      weaponDamageResult &&
      weaponDamageResult.destroyResult &&
      weaponDamageResult.destroyResult.success === true
    ) {
      droneInterop.recordKillmailFromDestruction(
        targetEntity,
        weaponDamageResult.destroyResult,
        {
          attackerEntity: combatSourceEntity,
          victimSession: weaponDamageResult.victimSession,
          whenMs: nowMs,
          weaponSnapshot: {
            effectFamily: "fighterAbilityLaunchBomb",
            moduleTypeID: pseudoModuleItem.typeID,
            rawShotDamage: damageVector,
          },
          moduleItem: pseudoModuleItem,
          chargeItem: null,
        },
      );
    }
    droneInterop.notifyWeaponDamageMessages(
      combatSourceEntity,
      targetEntity,
      pseudoModuleItem,
      damageVector,
      appliedDamageAmount,
      appliedDamageAmount > 0 ? 4 : 0,
    );
  }

  return { continueActive: false, deactivate: false };
}

function buildFighterJammerRuntimeCallbacks(scene) {
  return {
    getEntityByID(entityID) {
      return scene && typeof scene.getEntityByID === "function"
        ? scene.getEntityByID(entityID)
        : null;
    },
    isEntityLockedTarget() {
      return true;
    },
    getEntitySurfaceDistance(sourceEntity, targetEntity) {
      return surfaceDistance(
        sourceEntity,
        targetEntity,
        scene,
        scene && scene.simTimeMs,
        "fighter-jammer-cycle",
      );
    },
    clearOutgoingTargetLocksExcept(targetEntity, allowedTargetIDs, options = {}) {
      return scene && typeof scene.clearOutgoingTargetLocksExcept === "function"
        ? scene.clearOutgoingTargetLocksExcept(targetEntity, allowedTargetIDs, options)
        : {
          clearedTargetIDs: [],
          cancelledPendingIDs: [],
        };
    },
    random() {
      return scene && typeof scene.__jammerRandom === "function"
        ? Number(scene.__jammerRandom()) || 0
        : Math.random();
    },
  };
}

function getFighterEwarConfig(abilityMeta) {
  return FIGHTER_EWAR_FAMILY_CONFIG[
    normalizeEffectFamily(
      abilityMeta && (
        abilityMeta.normalizedEffectFamily ||
        abilityMeta.effectFamily
      ),
    )
  ] || null;
}

function buildFighterEwarEffectState(
  fighterEntity,
  targetEntity,
  slotID,
  snapshot,
  definition,
  strengthValue,
  optimalRangeMeters,
  falloffMeters,
) {
  const pseudoModuleItem = buildFighterPseudoModuleItem(fighterEntity, slotID);
  const isWarpPoint =
    definition.family === hostileModuleRuntime.HOSTILE_FAMILY_DISRUPT ||
    definition.family === hostileModuleRuntime.HOSTILE_FAMILY_SCRAM;
  return {
    moduleID: pseudoModuleItem.itemID,
    typeID: pseudoModuleItem.typeID,
    groupID: pseudoModuleItem.groupID,
    effectID: toInt(snapshot && snapshot.effectID, 0),
    targetID: toInt(targetEntity && targetEntity.itemID, 0),
    hostileModuleEffect: true,
    hostileFamily: definition.family,
    hostileJammingType: definition.jammingType,
    hostileModifierAttributeID: toInt(definition.modifierAttributeID, 0),
    hostileModifierOperation:
      definition.modifierOperation === undefined
        ? -1
        : definition.modifierOperation,
    hostileResistanceAttributeID: toInt(definition.resistanceAttributeID, 0),
    hostileStrengthValue: strengthValue,
    hostileWarpScrambleStrength: isWarpPoint ? Math.max(0, strengthValue) : 0,
    hostileStackingPenalized: definition.stackingPenalized === true,
    hostileAffectsTargetDerivedState: definition.affectsTargetDerivedState === true,
    hostileBlocksMicrowarpdrive: definition.blocksMicrowarpdrive === true,
    hostileBlocksMicroJumpDrive: definition.blocksMicroJumpDrive === true,
    hostileMaxRangeMeters: optimalRangeMeters,
    hostileFalloffMeters: falloffMeters,
    durationMs: Math.max(1, toNumber(snapshot && snapshot.durationMs, 1000)),
  };
}

function refreshFighterEwarTargetDerivedState(scene, targetEntity, aggregateChanged) {
  if (
    aggregateChanged === true &&
    targetEntity &&
    typeof scene.refreshShipEntityDerivedState === "function"
  ) {
    scene.refreshShipEntityDerivedState(targetEntity, {
      session: targetEntity.session || null,
      broadcast: true,
      notifyTargeting: true,
    });
  }
}

function removeFighterEwarEffect(
  scene,
  fighterEntity,
  controllerEntity,
  slotID,
  abilityState,
) {
  if (!scene || !fighterEntity || !abilityState) {
    return false;
  }
  const snapshot = resolveFighterAbilitySnapshot(
    fighterEntity,
    controllerEntity,
    slotID,
  ) || getFighterAbilityMetaForSlot(fighterEntity.typeID, slotID);
  const ewarConfig = getFighterEwarConfig(snapshot);
  if (!ewarConfig) {
    return false;
  }
  const targetEntity = scene.getEntityByID(toInt(abilityState.targetID, 0));
  if (!targetEntity) {
    return false;
  }
  const definition = hostileModuleRuntime.resolveHostileDefinition({
    name: normalizeEffectFamily(snapshot.effectFamily),
  });
  if (!definition) {
    return false;
  }
  const effectState = buildFighterEwarEffectState(
    fighterEntity,
    targetEntity,
    slotID,
    snapshot,
    definition,
    0,
    0,
    0,
  );
  const removeResult = hostileModuleRuntime.removeHostileModuleState({
    targetEntity,
    sourceEntity: fighterEntity,
    effectState,
  });
  refreshFighterEwarTargetDerivedState(
    scene,
    targetEntity,
    Boolean(
      removeResult &&
      removeResult.data &&
      removeResult.data.aggregateChanged,
    ),
  );
  return Boolean(
    removeResult &&
    removeResult.success &&
    removeResult.data &&
    removeResult.data.removedRecord,
  );
}

function removeAllFighterEwarEffects(scene, fighterEntity, controllerEntity) {
  let removedAny = false;
  for (const slotID of ABILITY_SLOT_IDS) {
    const abilityState = getEntityAbilityState(fighterEntity, slotID);
    removedAny = removeFighterEwarEffect(
      scene,
      fighterEntity,
      controllerEntity,
      slotID,
      abilityState,
    ) || removedAny;
  }
  return removedAny;
}

function executeFighterUtilityCycle(scene, fighterEntity, controllerEntity, slotID, abilityState, nowMs) {
  if (!scene || !isFighterEntity(fighterEntity)) {
    return { continueActive: false, deactivate: true };
  }
  const runtime = getRuntime();

  const snapshot = resolveFighterAbilitySnapshot(
    fighterEntity,
    controllerEntity,
    slotID,
  ) || getFighterAbilityMetaForSlot(fighterEntity.typeID, slotID);
  if (!snapshot) {
    return { continueActive: false, deactivate: true };
  }

  if (
    normalizeEffectFamily(snapshot.normalizedEffectFamily || snapshot.effectFamily) ===
      "fighterabilitymicrojumpdrive" &&
    abilityState &&
    abilityState.targetPoint
  ) {
    const targetPoint = cloneVector(abilityState.targetPoint, fighterEntity.position);
    const jumpDirection = normalizeVector(
      subtractVectors(targetPoint, fighterEntity.position),
      fighterEntity.direction,
    );
    // The jump and the motion it leaves the fighter with are one movement
    // change, applied together at the next Destiny tick.
    queueOrApplyMovementChange(scene, fighterEntity, "fighterMicroJump", null, () => {
      scene.teleportDynamicEntityToPoint(fighterEntity, targetPoint, {
        direction: jumpDirection,
        refreshOwnerSession: true,
      });
      applyFighterUtilityTeleportMotionCommand({
        fighterEntity,
        direction: jumpDirection,
        targetPoint,
        cloneTargetPoint: cloneVector,
      });
      persistFighterEntityState(fighterEntity);
    });
  }

  if (
    normalizeEffectFamily(snapshot.normalizedEffectFamily || snapshot.effectFamily) ===
      "fighterabilityecm"
  ) {
    const targetID = toInt(abilityState && abilityState.targetID, 0);
    const targetEntity = targetID > 0 ? scene.getEntityByID(targetID) : null;
    if (
      !targetEntity ||
      targetEntity.kind !== "ship" ||
      !hasDamageableHealth(targetEntity) ||
      !canPlayerCompanionActOnTarget(
        scene,
        null,
        fighterEntity,
        controllerEntity,
        targetEntity,
      )
    ) {
      return { continueActive: false, deactivate: true };
    }

    syncFighterOffensiveMovement(scene, fighterEntity, targetEntity, {
      rangeMeters: snapshot.jammerOptimalRangeMeters || snapshot.rangeMeters || 0,
      falloffMeters: snapshot.jammerFalloffMeters || snapshot.falloffMeters || 0,
    }, nowMs);
    const rangeGate = Math.max(
      0,
      toNumber(snapshot.jammerOptimalRangeMeters || snapshot.rangeMeters, 0) +
        Math.max(0, toNumber(snapshot.jammerFalloffMeters || snapshot.falloffMeters, 0)),
    );
    if (
      rangeGate > 0 &&
      surfaceDistance(
        fighterEntity,
        targetEntity,
        scene,
        nowMs,
        "fighter-jammer-range",
      ) > rangeGate + 1
    ) {
      return { continueActive: true, deactivate: false };
    }

    const pseudoModuleItem = buildFighterPseudoModuleItem(fighterEntity, slotID);
    if (snapshot.effectGuid) {
      scene.broadcastSpecialFx(
        fighterEntity.itemID,
        snapshot.effectGuid,
        {
          moduleID: pseudoModuleItem.itemID,
          moduleTypeID: pseudoModuleItem.typeID,
          targetID: targetEntity.itemID,
          isOffensive: true,
          start: true,
          active: false,
          duration: Math.max(1, toNumber(snapshot.durationMs, 1_000)),
          repeat: 1,
        },
        fighterEntity,
      );
    }
    const effectState = {
      moduleID: pseudoModuleItem.itemID,
      targetID: targetEntity.itemID,
      hostileJammingType: jammerModuleRuntime.ECM_JAMMING_TYPE,
      jammerModuleEffect: true,
      jammerStrengthBySensorType: snapshot.jammerStrengthBySensorType || {},
      jammerMaxRangeMeters: Math.max(
        0,
        toNumber(snapshot.jammerOptimalRangeMeters, toNumber(snapshot.rangeMeters, 0)),
      ),
      jammerFalloffMeters: Math.max(
        0,
        toNumber(snapshot.jammerFalloffMeters, toNumber(snapshot.falloffMeters, 0)),
      ),
      durationMs: Math.max(1, toNumber(snapshot.durationMs, 1000)),
      jamDurationMs: Math.max(
        1,
        toNumber(snapshot.jammerDurationMs, toNumber(snapshot.durationMs, 1000)),
      ),
      nextCycleAtMs: Math.max(0, toNumber(nowMs, Date.now())) + Math.max(
        1,
        toNumber(snapshot.durationMs, 1000),
      ),
    };
    const cycleResult = jammerModuleRuntime.executeJammerModuleCycle({
      scene,
      entity: fighterEntity,
      effectState,
      nowMs,
      callbacks: buildFighterJammerRuntimeCallbacks(scene),
    });
    if (
      cycleResult.success &&
      runtime &&
      typeof runtime.applyJammerCyclePresentation === "function"
    ) {
      runtime.applyJammerCyclePresentation(
        scene,
        fighterEntity,
        effectState,
        nowMs,
        cycleResult,
      );
    }
    return {
      continueActive: false,
      deactivate: true,
    };
  }

  const effectFamily = normalizeEffectFamily(
    snapshot.normalizedEffectFamily || snapshot.effectFamily,
  );
  const ewarConfig = getFighterEwarConfig(snapshot);
  if (ewarConfig) {
    const targetID = toInt(abilityState && abilityState.targetID, 0);
    const targetEntity = targetID > 0 ? scene.getEntityByID(targetID) : null;
    if (
      !targetEntity ||
      targetEntity.kind !== "ship" ||
      !hasDamageableHealth(targetEntity) ||
      !canPlayerCompanionActOnTarget(
        scene,
        null,
        fighterEntity,
        controllerEntity,
        targetEntity,
      )
    ) {
      return { continueActive: false, deactivate: true };
    }

    const fighterTypeID = toInt(fighterEntity.typeID, 0);
    const optimalRangeMeters = Math.max(
      0,
      toNumber(
        getTypeAttributeValue(fighterTypeID, ewarConfig.optimalAttribute),
        toNumber(snapshot.rangeMeters, 0),
      ),
    );
    const falloffMeters = ewarConfig.falloffAttribute
      ? Math.max(
        0,
        toNumber(
          getTypeAttributeValue(fighterTypeID, ewarConfig.falloffAttribute),
          0,
        ),
      )
      : 0;
    const strengthValue = toNumber(
      getTypeAttributeValue(fighterTypeID, ewarConfig.strengthAttribute),
      0,
    );
    const definition = hostileModuleRuntime.resolveHostileDefinition({
      name: effectFamily,
    });
    if (!definition || strengthValue === 0) {
      return { continueActive: false, deactivate: true };
    }

    syncFighterOffensiveMovement(scene, fighterEntity, targetEntity, {
      rangeMeters: optimalRangeMeters,
      falloffMeters,
    }, nowMs);
    const rangeGate = optimalRangeMeters + falloffMeters;
    if (
      rangeGate > 0 &&
      surfaceDistance(
        fighterEntity,
        targetEntity,
        scene,
        nowMs,
        "fighter-ewar-range",
      ) > rangeGate + 1
    ) {
      return { continueActive: true, deactivate: false };
    }

    const pseudoModuleItem = buildFighterPseudoModuleItem(fighterEntity, slotID);
    const effectState = buildFighterEwarEffectState(
      fighterEntity,
      targetEntity,
      slotID,
      snapshot,
      definition,
      strengthValue,
      optimalRangeMeters,
      falloffMeters,
    );
    if (snapshot.effectGuid) {
      scene.broadcastSpecialFx(
        fighterEntity.itemID,
        snapshot.effectGuid,
        {
          moduleID: pseudoModuleItem.itemID,
          moduleTypeID: pseudoModuleItem.typeID,
          targetID: targetEntity.itemID,
          isOffensive: true,
          start: true,
          active: false,
          duration: effectState.durationMs,
          repeat: 1,
        },
        fighterEntity,
      );
    }

    const hostileCallbacks = {
      ...(runtime && typeof runtime.buildHostileModuleRuntimeCallbacks === "function"
        ? runtime.buildHostileModuleRuntimeCallbacks(scene)
        : {}),
      isEntityLockedTarget: () => true,
      getEntitySurfaceDistance: (sourceEntity, otherEntity) =>
        surfaceDistance(
          sourceEntity,
          otherEntity,
          scene,
          nowMs,
          "fighter-hostile-module-cycle",
        ),
    };
    const cycleResult = hostileModuleRuntime.executeHostileModuleCycle({
      scene,
      entity: fighterEntity,
      effectState,
      nowMs,
      callbacks: hostileCallbacks,
    });
    if (cycleResult && cycleResult.success) {
      if (
        crimewatchState &&
        typeof crimewatchState.refreshLimitedEngagementForCombatEntities ===
          "function"
      ) {
        try {
          crimewatchState.refreshLimitedEngagementForCombatEntities(
            buildFighterCombatSourceEntity(fighterEntity, controllerEntity),
            cycleResult.data && cycleResult.data.targetEntity,
            nowMs,
          );
        } catch (error) {
          log.warn(
            `[FighterRuntime] Limited engagement refresh failed: ${
              error && error.message || error || "UNKNOWN_ERROR"
            }`,
          );
        }
      }
      refreshFighterEwarTargetDerivedState(
        scene,
        cycleResult.data && cycleResult.data.targetEntity,
        Boolean(cycleResult.data && cycleResult.data.aggregateChanged),
      );
      return { continueActive: true, deactivate: false };
    }
    return { continueActive: false, deactivate: true };
  }

  return {
    continueActive: false,
    deactivate: true,
  };
}

function buildFighterLaunchSpaceState(
  shipEntity,
  launchIndex = 0,
  systemID = 0,
  launchScopeMetadata = {},
) {
  const shipDirection = normalizeVector(shipEntity && shipEntity.direction, { x: 1, y: 0, z: 0 });
  const lateralDirection = buildPerpendicular(shipDirection);
  const launchDistance =
    Math.max(toNumber(shipEntity && shipEntity.radius, 0), 1) +
    DEFAULT_FIGHTER_LAUNCH_OFFSET_METERS;
  const lateralOffset = (launchIndex % FIGHTER_TUBE_FLAGS.length) * 60;
  const signedSide = launchIndex % 2 === 0 ? 1 : -1;
  const position = addVectors(
    addVectors(
      cloneVector(shipEntity && shipEntity.position),
      scaleVector(shipDirection, launchDistance),
    ),
    scaleVector(lateralDirection, lateralOffset * signedSide),
  );

  return {
    systemID:
      toInt(shipEntity && shipEntity.systemID, 0) || toInt(systemID, 0),
    position,
    velocity: { x: 0, y: 0, z: 0 },
    direction: shipDirection,
    targetPoint: cloneVector(position),
    speedFraction: 0,
    mode: "STOP",
    targetEntityID: null,
    followRange: 0,
    orbitDistance: 0,
    orbitNormal: buildPerpendicular(shipDirection),
    orbitSign: 1,
    effectStamp: 0,
    warpDestination: null,
    ...buildPlayerCompanionScopeMetadata(shipEntity),
    ...(launchScopeMetadata && typeof launchScopeMetadata === "object"
      ? launchScopeMetadata
      : {}),
  };
}

function buildFighterRecoveryItemPatch(item = null) {
  return {
    launcherID: item && item.launcherID || null,
    spaceState: item && item.spaceState || null,
    fighterState: item && item.fighterState || null,
  };
}

function rollbackFighterToTube(itemID, shipRecord, tubeFlagID, sourceItem = null) {
  const currentItem = findItemById(itemID);
  const shipID = toInt(shipRecord && shipRecord.itemID, 0);
  if (!currentItem || shipID <= 0) {
    return { success: false, errorMsg: "FIGHTER_LAUNCH_ROLLBACK_SOURCE_INVALID" };
  }
  const ownerID = toInt(currentItem.ownerID, toInt(shipRecord && shipRecord.ownerID, 0));
  return itemCustody.transfer({
    items: { itemID },
    from: itemCustody.custodyRef.inSpace(
      ownerID,
      toInt(currentItem.locationID, 0),
      currentItem.spaceState || null,
    ),
    to: itemCustody.custodyRef.shipBay(ownerID, shipID, tubeFlagID),
    reason: itemCustody.CUSTODY_REASON.FIGHTER_LAUNCH_ROLLBACK,
    actor: ownerID || null,
    idempotencyKey:
      `fighter-launch-rollback:${toInt(itemID, 0)}:` +
      `${toInt(currentItem.locationID, 0)}:${shipID}:${toInt(tubeFlagID, 0)}`,
    options: {
      destinationItemPatch: buildFighterRecoveryItemPatch(sourceItem),
    },
  });
}

function launchFightersFromTubes(session, rawTubeFlagIDs) {
  const shipState = getShipStateForSession(session);
  const errors = [];
  if (!shipState) {
    return { success: false, errors };
  }

  const { characterID, shipRecord, shipEntity, scene } = shipState;
  const tubeFlagIDs = normalizeTubeFlagList(rawTubeFlagIDs);
  if (
    getPlayerCompanionSecurityScope(shipEntity, {
      controller: true,
    }).invalid === true
  ) {
    for (const tubeFlagID of tubeFlagIDs) {
      errors.push([
        tubeFlagID,
        buildFighterError(
          "Unable to launch fighters while the controller's private-site scope is invalid.",
        ),
      ]);
    }
    return { success: false, errors };
  }
  const launchScope = resolveAbyssalPlayerLaunchScope(
    session,
    shipEntity,
    scene,
  );
  if (launchScope.valid !== true) {
    for (const tubeFlagID of tubeFlagIDs) {
      errors.push([
        tubeFlagID,
        buildFighterError(
          "Unable to launch fighters while the Abyssal room scope is unresolved.",
        ),
      ]);
    }
    return { success: false, errors };
  }
  const ownerSession = getOwnerSession(shipRecord, session);
  let launchIndex = 0;

  for (const tubeFlagID of tubeFlagIDs) {
    const fighterItem = getShipTubeItem(shipRecord, tubeFlagID);
    if (!fighterItem || !isFighterItemRecord(fighterItem)) {
      errors.push([tubeFlagID, buildFighterError("No fighter squadron is loaded in that launch tube.")]);
      continue;
    }
    if (
      !canLoadFighterTypeIntoHostTube(
        shipRecord.typeID,
        fighterItem.typeID,
        tubeFlagID,
        listShipTubeItems(shipRecord, { excludeItemID: fighterItem.itemID }),
      )
    ) {
      errors.push([tubeFlagID, buildFighterError("That fighter squadron cannot launch from that tube.")]);
      continue;
    }
    if (
      listControlledFighterEntities(scene, shipRecord.itemID).some(
        (entity) => toInt(entity.tubeFlagID, 0) === tubeFlagID,
      )
    ) {
      errors.push([tubeFlagID, buildFighterError("That launch tube already has an in-space squadron.")]);
      continue;
    }

    const fighterOwnerID = toInt(fighterItem.ownerID, characterID);
    const moveResult = itemCustody.transfer({
      items: { itemID: fighterItem.itemID },
      from: itemCustody.custodyRef.shipBay(
        fighterOwnerID,
        shipRecord.itemID,
        tubeFlagID,
      ),
      to: itemCustody.custodyRef.inSpace(
        fighterOwnerID,
        scene.systemID,
      ),
      reason: itemCustody.CUSTODY_REASON.FIGHTER_LAUNCH,
      actor: characterID,
      idempotencyKey:
        `fighter-launch:${fighterItem.itemID}:` +
        `${shipRecord.itemID}:${tubeFlagID}:${scene.systemID}`,
    });
    if (!moveResult.success) {
      errors.push([tubeFlagID, buildFighterError("Unable to launch fighters from that tube.")]);
      continue;
    }

    syncInventoryChangesToSession(ownerSession, moveResult.data && moveResult.data.changes);
    const updateResult = updateInventoryItem(fighterItem.itemID, (currentItem) => ({
      ...currentItem,
      launcherID: shipRecord.itemID,
      spaceState: buildFighterLaunchSpaceState(
        shipEntity,
        launchIndex,
        scene.systemID,
        launchScope.metadata,
      ),
      fighterState: {
        tubeFlagID,
        controllerID: shipRecord.itemID,
        controllerOwnerID: characterID,
      },
    }));
    if (!updateResult.success) {
      rollbackFighterToTube(fighterItem.itemID, shipRecord, tubeFlagID, fighterItem);
      errors.push([tubeFlagID, buildFighterError("Unable to finalize fighter launch state.")]);
      continue;
    }

    const spawnResult = getRuntime().spawnDynamicInventoryEntity(
      scene.sceneDescriptor || scene.systemID,
      fighterItem.itemID,
      {
        sceneDescriptor: scene.sceneDescriptor || undefined,
        broadcast: true,
        excludedSession: null,
      },
    );
    if (!spawnResult.success || !spawnResult.data || !spawnResult.data.entity) {
      rollbackFighterToTube(fighterItem.itemID, shipRecord, tubeFlagID, fighterItem);
      errors.push([tubeFlagID, buildFighterError("Unable to materialize the launched fighter squadron in space.")]);
      continue;
    }

    const fighterEntity = hydrateFighterEntityFromItem(
      spawnResult.data.entity,
      updateResult.data,
    );
    applyPlayerCompanionScopeMetadata(
      fighterEntity,
      launchScope.metadata,
    );
    fighterEntity.launcherID = shipRecord.itemID;
    fighterEntity.controllerID = shipRecord.itemID;
    fighterEntity.controllerOwnerID = characterID;
    fighterEntity.tubeFlagID = tubeFlagID;
    fighterEntity.squadronSize = resolveSquadronSize(updateResult.data);
    applyFighterOperationalEntityAttributes(fighterEntity, shipEntity);
    clearFighterCommandState(fighterEntity);
    scene.orbitShipEntity(
      fighterEntity,
      shipRecord.itemID,
      DEFAULT_FIGHTER_ORBIT_DISTANCE_METERS,
      { broadcast: true },
    );
    persistFighterEntityState(fighterEntity);

    notifyTubeEmpty(ownerSession, tubeFlagID);
    notifyFighterAdded(ownerSession, scene, fighterEntity);
    notifyTubeState(ownerSession, tubeFlagID, TUBE_STATE_INSPACE);
    if (!shipRecord.controlledStructure) {
      setFightersLaunchedTetherRestriction(characterID, true, scene);
    }
    launchIndex += 1;
  }

  return {
    success: errors.length === 0,
    errors,
  };
}

function restoreFighterSceneEntity(scene, itemID) {
  const numericItemID = toInt(itemID, 0);
  if (!scene || numericItemID <= 0) {
    return { success: false, errorMsg: "INVALID_FIGHTER_SCENE_RESTORE" };
  }
  const existingEntity = scene.getEntityByID(numericItemID);
  if (existingEntity) {
    return { success: true, data: { entity: existingEntity } };
  }
  const item = findItemById(numericItemID);
  if (!item || toInt(item.locationID, 0) !== toInt(scene.systemID, 0)) {
    return { success: false, errorMsg: "FIGHTER_SCENE_RESTORE_SOURCE_INVALID" };
  }
  const spawnResult = getRuntime().spawnDynamicInventoryEntity(
    scene.sceneDescriptor || scene.systemID,
    numericItemID,
    {
      sceneDescriptor: scene.sceneDescriptor || undefined,
      broadcast: true,
      excludedSession: null,
    },
  );
  if (!spawnResult || !spawnResult.success || !spawnResult.data || !spawnResult.data.entity) {
    return spawnResult || { success: false, errorMsg: "FIGHTER_SCENE_RESTORE_FAILED" };
  }
  hydrateFighterEntityFromItem(spawnResult.data.entity, item);
  return spawnResult;
}

function getFighterInventoryVolume(item) {
  return Math.max(0, getInventoryItemUnitVolume(item)) *
    buildInventorySquadronSize(item);
}

function getFighterBayCapacity(characterID, shipRecord) {
  const shipID = toInt(shipRecord && shipRecord.itemID, 0);
  const typeID = toInt(shipRecord && shipRecord.typeID, 0);
  const baseCapacity = Math.max(
    0,
    toNumber(getShipBaseAttributeValue(typeID, "fighterCapacity"), 0),
  );
  // A controlled Upwell structure has no fitting-derived resource state to read,
  // so it keeps the hull attribute the same way invBroker resolves a structure
  // fighter bay.
  if (toInt(characterID, 0) <= 0 || shipID <= 0 || shipRecord.controlledStructure) {
    return baseCapacity;
  }

  const fittingSnapshot = getShipFittingSnapshot(characterID, shipID, {
    shipItem: shipRecord,
    reason: "fighter.baycapacity",
  });
  const derivedCapacity = Number(
    fittingSnapshot &&
    fittingSnapshot.resourceState &&
    fittingSnapshot.resourceState.fighterCapacity,
  );
  return Number.isFinite(derivedCapacity)
    ? Math.max(0, derivedCapacity)
    : baseCapacity;
}

// Landing a squadron in a tube is gated by tube occupancy, but the fighter bay
// itself is a dogma-limited volume and itemCustody enforces none of it. Without
// this an abandoned squadron can be scooped into a bay that is already full,
// over and over.
function getAvailableFighterBayVolume(characterID, shipRecord) {
  const shipID = toInt(shipRecord && shipRecord.itemID, 0);
  if (shipID <= 0) {
    return 0;
  }

  // Owner is deliberately left open: anything parked in the bay occupies it,
  // whoever it belongs to.
  const usedVolume = listContainerItems(null, shipID, ITEM_FLAGS.FIGHTER_BAY)
    .reduce((sum, item) => sum + getFighterInventoryVolume(item), 0);
  return Number(
    (getFighterBayCapacity(characterID, shipRecord) - usedVolume).toFixed(6),
  );
}

function recoverFighterInventory(scene, shipRecord, fighterEntity, toFlagID) {
  const itemID = toInt(fighterEntity && fighterEntity.itemID, 0);
  const sourceItem = findItemById(itemID);
  if (
    !sourceItem ||
    toInt(sourceItem.locationID, 0) !== toInt(scene && scene.systemID, 0) ||
    toInt(sourceItem.flagID, 0) !== 0
  ) {
    return { success: false, errorMsg: "FIGHTER_INVENTORY_SOURCE_INVALID" };
  }

  const removeResult = scene.removeDynamicEntity(itemID, {
    broadcast: true,
    persistSpaceState: false,
  });
  if (!removeResult || !removeResult.success) {
    return removeResult || { success: false, errorMsg: "REMOVE_FAILED" };
  }

  const sourceOwnerID = toInt(sourceItem.ownerID, 0);
  const destinationOwnerID = toInt(shipRecord && shipRecord.ownerID, sourceOwnerID);
  const capture = sourceOwnerID !== destinationOwnerID;
  const custodyResult = itemCustody.transfer({
    items: { itemID },
    from: itemCustody.custodyRef.inSpace(
      sourceOwnerID,
      toInt(scene.systemID, 0),
      sourceItem.spaceState || null,
    ),
    to: itemCustody.custodyRef.shipBay(
      destinationOwnerID,
      toInt(shipRecord && shipRecord.itemID, 0),
      toFlagID,
    ),
    reason: capture
      ? itemCustody.CUSTODY_REASON.FIGHTER_CAPTURE
      : itemCustody.CUSTODY_REASON.FIGHTER_RECOVER,
    actor: destinationOwnerID || null,
    idempotencyKey:
      `${capture ? "fighter-capture" : "fighter-recover"}:` +
      `${itemID}:${toInt(shipRecord && shipRecord.itemID, 0)}:${toInt(toFlagID, 0)}`,
    options: {
      destinationItemPatch: buildFighterRecoveryItemPatch(),
    },
  });
  if (!custodyResult || !custodyResult.success) {
    const restoreResult = restoreFighterSceneEntity(scene, itemID);
    return restoreResult.success
      ? custodyResult || { success: false, errorMsg: "FIGHTER_RECOVERY_FAILED" }
      : {
          success: false,
          errorMsg: "FIGHTER_RECOVERY_ROLLBACK_FAILED",
          data: { restoreResult, cause: custodyResult || null },
        };
  }
  return custodyResult;
}

function landFighterToTube(scene, shipRecord, fighterEntity, fallbackSession = null) {
  if (!scene || !shipRecord || !isFighterEntity(fighterEntity)) {
    return { success: false, errorMsg: "INVALID_FIGHTER_RECOVERY" };
  }

  const tubeFlagID = toInt(
    fighterEntity.tubeFlagID,
    toInt(fighterEntity.fighterRecallTubeFlagID, 0),
  );
  if (!isFighterTubeFlag(tubeFlagID)) {
    return { success: false, errorMsg: "INVALID_TUBE" };
  }
  const occupiedTubeItem = getShipTubeItem(shipRecord, tubeFlagID);
  if (occupiedTubeItem && toInt(occupiedTubeItem.itemID, 0) !== toInt(fighterEntity.itemID, 0)) {
    return { success: false, errorMsg: "TUBE_OCCUPIED" };
  }

  const ownerSession = getOwnerSession(shipRecord, fallbackSession);
  removeAllFighterEwarEffects(
    scene,
    fighterEntity,
    scene.getEntityByID(toInt(shipRecord.itemID, 0)),
  );
  notifyTubeState(ownerSession, tubeFlagID, TUBE_STATE_LANDING);
  const bayUpdateResult = recoverFighterInventory(
    scene,
    shipRecord,
    fighterEntity,
    tubeFlagID,
  );
  if (!bayUpdateResult.success) {
    return bayUpdateResult;
  }

  const recoveredItem = bayUpdateResult.data && bayUpdateResult.data.item;
  const changes = bayUpdateResult.data && bayUpdateResult.data.changes || [];

  notifyFighterRemoved(ownerSession, fighterEntity.itemID, tubeFlagID);
  syncInventoryChangesToSession(ownerSession, changes);
  notifyTubeContent(ownerSession, tubeFlagID, recoveredItem);
  notifyTubeState(ownerSession, tubeFlagID, TUBE_STATE_READY);
  syncFightersLaunchedTetherRestriction(scene, shipRecord);
  return {
    success: true,
    data: {
      tubeFlagID,
      fighterID: fighterEntity.itemID,
    },
  };
}

function recallFightersToTubes(session, rawFighterIDs) {
  const shipState = getShipStateForSession(session);
  const fighterIDs = normalizeFighterIDList(rawFighterIDs);
  const errors = [];
  if (!shipState) {
    return {
      success: false,
      errors,
      entries: buildPerFighterResultEntries(fighterIDs, errors),
    };
  }

  const { shipRecord, scene } = shipState;
  const ownerSession = getOwnerSession(shipRecord, session);
  const controllerEntity = scene.getEntityByID(shipRecord.itemID) || null;
  for (const fighterID of fighterIDs) {
    const fighterEntity = scene.getEntityByID(fighterID);
    if (!isFighterEntity(fighterEntity) || toInt(fighterEntity.controllerID, 0) !== toInt(shipRecord.itemID, 0)) {
      errors.push([fighterID, buildFighterError("That fighter squadron is not currently controlled by this ship.")]);
      continue;
    }
    if (
      !securityScopesExactlyMatch(
        getPlayerCompanionSecurityScope(fighterEntity),
        getPlayerCompanionSecurityScope(controllerEntity, { controller: true }),
      )
    ) {
      errors.push([fighterID, buildFighterError("That fighter squadron is not in this private-site room.")]);
      continue;
    }

    const tubeFlagID = toInt(fighterEntity.tubeFlagID, 0);
    if (!isFighterTubeFlag(tubeFlagID)) {
      errors.push([fighterID, buildFighterError("That fighter squadron has no valid originating launch tube.")]);
      continue;
    }
    const occupiedTubeItem = getShipTubeItem(shipRecord, tubeFlagID);
    if (occupiedTubeItem && toInt(occupiedTubeItem.itemID, 0) !== fighterID) {
      errors.push([fighterID, buildFighterError("That launch tube is already occupied.")]);
      continue;
    }

    for (const slotID of ABILITY_SLOT_IDS) {
      const abilityState = getEntityAbilityState(fighterEntity, slotID);
      if (!abilityState) {
        continue;
      }
      const abilityMeta =
        resolveFighterAbilitySnapshot(fighterEntity, controllerEntity, slotID) ||
        getFighterAbilityMetaForSlot(fighterEntity.typeID, slotID);
      if (isMobilityAbilitySnapshot(abilityMeta)) {
        continue;
      }
      removeFighterEwarEffect(
        scene,
        fighterEntity,
        controllerEntity,
        slotID,
        abilityState,
      );
      setEntityAbilityState(fighterEntity, slotID, null);
      notifyAbilityDeactivated(ownerSession, fighterEntity.itemID, slotID, null);
    }

    fighterEntity.fighterCommand = "RECALL_TUBE";
    fighterEntity.fighterRecallTubeFlagID = tubeFlagID;
    scene.followShipEntity(
      fighterEntity,
      shipRecord.itemID,
      FIGHTER_RECALL_APPROACH_DISTANCE_METERS,
      { broadcast: true },
    );
    syncFighterMobilityAbilityState(
      scene,
      fighterEntity,
      controllerEntity,
      scene.getCurrentSimTimeMs(),
    );
    persistFighterEntityState(fighterEntity);
    notifyTubeState(ownerSession, tubeFlagID, TUBE_STATE_RECALLING);
  }

  return {
    success: errors.length === 0,
    errors,
    entries: buildPerFighterResultEntries(fighterIDs, errors),
  };
}

function queueControlledFightersReturnToTubes(scene, controllerEntity, options = {}) {
  if (!scene || !controllerEntity) {
    return {
      success: false,
      queuedCount: 0,
    };
  }

  const controllerID = toInt(controllerEntity.itemID, 0);
  if (controllerID <= 0) {
    return {
      success: false,
      queuedCount: 0,
    };
  }

  const shipRecord = options.shipRecord || resolveFighterControllerRecord(controllerID) || null;
  const ownerSession =
    Object.prototype.hasOwnProperty.call(options, "ownerSession")
      ? options.ownerSession
      : resolveFighterControllerSession(null, controllerEntity);
  let queuedCount = 0;

  for (const fighterEntity of listControlledFighterEntities(scene, controllerID)) {
    if (
      !securityScopesExactlyMatch(
        getPlayerCompanionSecurityScope(fighterEntity),
        getPlayerCompanionSecurityScope(controllerEntity, { controller: true }),
      )
    ) {
      continue;
    }
    const tubeFlagID = toInt(
      fighterEntity.tubeFlagID,
      toInt(fighterEntity.fighterRecallTubeFlagID, 0),
    );
    if (!isFighterTubeFlag(tubeFlagID)) {
      continue;
    }
    const occupiedTubeItem = shipRecord ? getShipTubeItem(shipRecord, tubeFlagID) : null;
    if (
      occupiedTubeItem &&
      toInt(occupiedTubeItem.itemID, 0) !== toInt(fighterEntity.itemID, 0)
    ) {
      continue;
    }

    fighterEntity.fighterCommand = "RECALL_TUBE";
    fighterEntity.fighterRecallTubeFlagID = tubeFlagID;
    removeAllFighterEwarEffects(scene, fighterEntity, controllerEntity);
    clearEntityAbilityStates(fighterEntity);
    scene.followShipEntity(
      fighterEntity,
      controllerID,
      FIGHTER_RECALL_APPROACH_DISTANCE_METERS,
      { broadcast: true },
    );
    syncFighterMobilityAbilityState(
      scene,
      fighterEntity,
      controllerEntity,
      toNumber(
        options.nowMs,
        scene.getCurrentSimTimeMs && scene.getCurrentSimTimeMs(),
      ),
    );
    persistFighterEntityState(fighterEntity);
    notifyTubeState(ownerSession, tubeFlagID, TUBE_STATE_RECALLING);
    queuedCount += 1;
  }

  return {
    success: true,
    queuedCount,
  };
}

function buildAbilityError(message) {
  return buildFighterError(message);
}

function resolveAbilityTargetEntity(scene, rawTargetID) {
  const targetID = toInt(rawTargetID, 0);
  if (targetID <= 0 || !scene) {
    return null;
  }
  return scene.getEntityByID(targetID) || null;
}

function validateAbilityActivation(
  scene,
  session,
  fighterEntity,
  controllerEntity,
  abilityMeta,
  rawTarget,
  nowMs,
) {
  if (!scene || !isFighterEntity(fighterEntity) || !abilityMeta) {
    return {
      success: false,
      error: buildAbilityError("That fighter ability cannot be activated right now."),
    };
  }
  if (
    !controllerEntity ||
    !securityScopesExactlyMatch(
      getPlayerCompanionSecurityScope(fighterEntity),
      getPlayerCompanionSecurityScope(controllerEntity, { controller: true }),
    )
  ) {
    return {
      success: false,
      error: buildAbilityError("That fighter squadron is not in this private-site room."),
    };
  }

  const securityRestrictionError = buildAbilitySecurityRestrictionError(scene, abilityMeta);
  if (securityRestrictionError) {
    return {
      success: false,
      error: securityRestrictionError,
    };
  }

  switch (abilityMeta.targetMode) {
    case TARGET_MODE_UNTARGETED:
      return { success: true, targetID: null };
    case TARGET_MODE_ITEMTARGETED: {
      if (rawTarget === null || rawTarget === undefined || rawTarget === 0) {
        return {
          success: false,
          error: buildAbilityRequiresTargetError(fighterEntity, abilityMeta),
        };
      }
      const targetEntity = resolveAbilityTargetEntity(scene, rawTarget);
      if (!targetEntity) {
        return {
          success: false,
          error: buildAbilityError("That fighter ability requires a valid target."),
        };
      }
      if (
        !canPlayerCompanionActOnTarget(
          scene,
          session,
          fighterEntity,
          controllerEntity,
          targetEntity,
        )
      ) {
        return {
          success: false,
          error: buildAbilityError("That fighter cannot see the selected target."),
        };
      }
      const safetyRestrictionError = buildAbilitySafetyRestrictionError(
        scene,
        fighterEntity,
        controllerEntity,
        abilityMeta,
        targetEntity,
        nowMs,
      );
      if (safetyRestrictionError) {
        return {
          success: false,
          error: safetyRestrictionError,
        };
      }
      if (
        abilityMeta.rangeMeters > 0 &&
        surfaceDistance(
          fighterEntity,
          targetEntity,
          scene,
          nowMs,
          "fighter-ability-activation",
        ) > abilityMeta.rangeMeters
      ) {
        return {
          success: false,
          error: buildAbilityError("That target is outside fighter ability range."),
        };
      }
      return {
        success: true,
        targetID: toInt(targetEntity.itemID, 0),
      };
    }
    case TARGET_MODE_POINTTARGETED: {
      const targetPoint = normalizeFighterCommandPoint(rawTarget);
      if (!targetPoint) {
        return {
          success: false,
          error: buildAbilityError("That fighter ability requires a target point."),
        };
      }
      if (
        abilityMeta.rangeMeters > 0 &&
        distance(fighterEntity.position, targetPoint) > abilityMeta.rangeMeters + 1
      ) {
        return {
          success: false,
          error: buildAbilityError("That target point is outside fighter ability range."),
        };
      }
      return {
        success: true,
        targetID: null,
        targetPoint,
      };
    }
    default:
      return {
        success: false,
        error: buildAbilityError("That fighter ability uses an unsupported target mode."),
      };
  }
}

function recordFighterOffensiveAggression(
  scene,
  fighterEntity,
  controllerEntity,
  targetEntity,
  nowMs,
) {
  if (
    !scene ||
    !targetEntity ||
    !crimewatchState ||
    typeof crimewatchState.recordHighSecCriminalAggression !== "function"
  ) {
    return { success: true };
  }
  const sourceEntity = buildFighterCrimewatchSourceEntity(
    fighterEntity,
    controllerEntity,
  );
  if (!sourceEntity) {
    return { success: false, errorMsg: "FIGHTER_CONTROLLER_NOT_FOUND" };
  }
  try {
    return crimewatchState.recordHighSecCriminalAggression(
      scene,
      sourceEntity,
      targetEntity,
      nowMs,
    );
  } catch (error) {
    log.warn(
      `[FighterRuntime] Crimewatch aggression failed: ${
        error && error.message || error || "UNKNOWN_ERROR"
      }`,
    );
    return { success: false, errorMsg: "CRIMEWATCH_AGGRESSION_FAILED" };
  }
}

function activateAbilitySlots(session, rawFighterIDs, rawAbilitySlotID, rawTarget = null) {
  const shipState = getShipStateForSession(session);
  const fighterIDs = normalizeFighterIDList(rawFighterIDs);
  const errors = [];
  if (!shipState) {
    return {
      success: false,
      errors,
      entries: buildPerFighterResultEntries(fighterIDs, errors),
    };
  }

  const { shipRecord, shipEntity, scene } = shipState;
  const ownerSession = getOwnerSession(shipRecord, session);
  const abilitySlotID = toInt(rawAbilitySlotID, -1);
  const nowMs = scene.getCurrentSimTimeMs();

  if (!ABILITY_SLOT_IDS.includes(abilitySlotID)) {
    for (const fighterID of fighterIDs) {
      errors.push([fighterID, buildAbilityError("That fighter ability slot is invalid.")]);
    }
    return {
      success: false,
      errors,
      entries: buildPerFighterResultEntries(fighterIDs, errors),
    };
  }

  for (const fighterID of fighterIDs) {
    const fighterEntity = scene.getEntityByID(fighterID);
    if (!isFighterEntity(fighterEntity) || toInt(fighterEntity.controllerID, 0) !== toInt(shipRecord.itemID, 0)) {
      errors.push([fighterID, buildAbilityError("That fighter squadron is not currently controlled by this ship.")]);
      continue;
    }

    const abilityMeta =
      resolveFighterAbilitySnapshot(
        fighterEntity,
        shipEntity,
        abilitySlotID,
      ) ||
      getFighterAbilityMetaForSlot(fighterEntity.typeID, abilitySlotID);
    if (!abilityMeta) {
      errors.push([fighterID, buildAbilityError("That fighter has no ability in the requested slot.")]);
      continue;
    }

    let existingState = refreshAbilityCharges(
      fighterEntity,
      abilitySlotID,
      abilityMeta,
      nowMs,
    );
    if (existingState && toNumber(existingState.activeUntilMs, 0) > nowMs) {
      errors.push([fighterID, buildAbilityError("That fighter ability is already active.")]);
      continue;
    }

    const abilityChargeCount = getEffectiveAbilityChargeCount(abilityMeta);
    const remainingChargeCount = getAbilityStateChargeCount(
      existingState,
      abilityMeta,
    );
    const cooldownIsActive =
      existingState &&
      toNumber(existingState.cooldownStartMs, 0) <= nowMs &&
      toNumber(existingState.cooldownEndMs, 0) > nowMs;
    if (
      abilityChargeCount === null &&
      cooldownIsActive
    ) {
      errors.push([fighterID, buildAbilityError("That fighter ability is still on cooldown.")]);
      continue;
    }
    if (
      abilityChargeCount !== null &&
      remainingChargeCount !== null &&
      remainingChargeCount <= 0
    ) {
      errors.push([fighterID, buildAbilityError("That fighter ability is still on cooldown.")]);
      continue;
    }

    const validation = validateAbilityActivation(
      scene,
      session,
      fighterEntity,
      shipEntity,
      abilityMeta,
      rawTarget,
      nowMs,
    );
    if (!validation.success) {
      errors.push([fighterID, validation.error]);
      continue;
    }

    if (abilityMeta.isOffensive === true && validation.targetID) {
      const targetEntity = scene.getEntityByID(validation.targetID);
      const aggressionResult = recordFighterOffensiveAggression(
        scene,
        fighterEntity,
        shipEntity,
        targetEntity,
        nowMs,
      );
      if (!aggressionResult || aggressionResult.success !== true) {
        errors.push([
          fighterID,
          buildAbilityError(
            "Crimewatch could not authorize that fighter attack.",
          ),
        ]);
        continue;
      }
    }

    const durationMs = getEffectiveAbilityDurationMs(abilityMeta);
    const cooldownMs = getEffectiveAbilityCooldownMs(abilityMeta);
    const rearmTimeMs = getEffectiveAbilityRearmTimeMs(abilityMeta);
    const nextState = {
      ...(existingState || {}),
      activeSinceMs: nowMs,
      durationMs,
      activeUntilMs: nowMs + durationMs,
      targetID: validation.targetID,
    };
    delete nextState.firedAtActivation;
    if (validation.targetPoint) {
      nextState.targetPoint = cloneVector(validation.targetPoint);
    } else {
      delete nextState.targetPoint;
    }
    if (abilityChargeCount !== null) {
      nextState.remainingChargeCount = Math.max(
        0,
        (remainingChargeCount === null ? abilityChargeCount : remainingChargeCount) - 1,
      );
      if (rearmTimeMs !== null) {
        nextState.cooldownStartMs = nowMs + durationMs;
        nextState.cooldownEndMs = nowMs + durationMs + rearmTimeMs;
      } else {
        delete nextState.cooldownStartMs;
        delete nextState.cooldownEndMs;
      }
    } else if (cooldownMs !== null) {
      nextState.cooldownStartMs = nowMs + durationMs;
      nextState.cooldownEndMs = nowMs + durationMs + cooldownMs;
    } else {
      delete nextState.cooldownStartMs;
      delete nextState.cooldownEndMs;
    }
    setEntityAbilityState(fighterEntity, abilitySlotID, nextState);
    const activeAbilityState = getEntityAbilityState(fighterEntity, abilitySlotID);
    emitFighterAbilityActivationFx(
      scene,
      fighterEntity,
      abilitySlotID,
      abilityMeta,
      activeAbilityState,
    );
    if (isMobilityAbilitySnapshot(abilityMeta)) {
      syncFighterMobilityAbilityState(
        scene,
        fighterEntity,
        shipEntity,
        nowMs,
      );
    } else if (getFighterEwarConfig(abilityMeta)) {
      const initialCycle = executeFighterUtilityCycle(
        scene,
        fighterEntity,
        shipEntity,
        abilitySlotID,
        activeAbilityState,
        nowMs,
      );
      if (!initialCycle || initialCycle.deactivate === true) {
        removeFighterEwarEffect(
          scene,
          fighterEntity,
          shipEntity,
          abilitySlotID,
          activeAbilityState,
        );
        clearAbilityActiveWindow(activeAbilityState);
        setEntityAbilityState(fighterEntity, abilitySlotID, activeAbilityState);
      }
    } else if (
      abilityMeta.isOffensive === true &&
      !isJammerAbilitySnapshot(abilityMeta) &&
      !usesContinuousAbilityCycle(abilityMeta) &&
      !isKamikazeAbility(abilityMeta) &&
      !isLaunchBombAbility(abilityMeta)
    ) {
      const immediateResult = executeFighterOffensiveCycle(
        scene,
        fighterEntity,
        shipEntity,
        abilitySlotID,
        activeAbilityState,
        nowMs,
      );
      if (!immediateResult || immediateResult.continueActive !== true) {
        setEntityAbilityState(fighterEntity, abilitySlotID, {
          ...activeAbilityState,
          firedAtActivation: true,
        });
      }
    }
    persistFighterEntityState(fighterEntity);
    queueAbilityActivated(
      ownerSession,
      scene,
      fighterEntity,
      abilitySlotID,
      activeAbilityState,
    );
  }

  return {
    success: errors.length === 0,
    errors,
    entries: buildPerFighterResultEntries(fighterIDs, errors),
  };
}

function deactivateAbilitySlots(session, rawFighterIDs, rawAbilitySlotID) {
  const shipState = getShipStateForSession(session);
  const fighterIDs = normalizeFighterIDList(rawFighterIDs);
  const errors = [];
  if (!shipState) {
    return {
      success: false,
      errors,
      entries: buildPerFighterResultEntries(fighterIDs, errors),
    };
  }

  const { shipRecord, shipEntity, scene } = shipState;
  const ownerSession = getOwnerSession(shipRecord, session);
  const abilitySlotID = toInt(rawAbilitySlotID, -1);
  const nowMs = scene.getCurrentSimTimeMs();

  if (!ABILITY_SLOT_IDS.includes(abilitySlotID)) {
    for (const fighterID of fighterIDs) {
      errors.push([fighterID, buildAbilityError("That fighter ability slot is invalid.")]);
    }
    return {
      success: false,
      errors,
      entries: buildPerFighterResultEntries(fighterIDs, errors),
    };
  }

  for (const fighterID of fighterIDs) {
    const fighterEntity = scene.getEntityByID(fighterID);
    if (!isFighterEntity(fighterEntity) || toInt(fighterEntity.controllerID, 0) !== toInt(shipRecord.itemID, 0)) {
      errors.push([fighterID, buildAbilityError("That fighter squadron is not currently controlled by this ship.")]);
      continue;
    }

    const abilityMeta =
      resolveFighterAbilitySnapshot(
        fighterEntity,
        shipEntity,
        abilitySlotID,
      ) ||
      getFighterAbilityMetaForSlot(fighterEntity.typeID, abilitySlotID);
    let existingState = refreshAbilityCharges(
      fighterEntity,
      abilitySlotID,
      abilityMeta,
      nowMs,
    );
    if (!existingState || toNumber(existingState.activeUntilMs, 0) <= nowMs) {
      errors.push([fighterID, buildAbilityError("That fighter ability is not currently active.")]);
      continue;
    }

    const nextState = {
      ...existingState,
      cooldownStartMs: getEffectiveAbilityCooldownMs(abilityMeta) !== null
        ? nowMs
        : existingState.cooldownStartMs,
      cooldownEndMs: getEffectiveAbilityCooldownMs(abilityMeta) !== null
        ? nowMs + getEffectiveAbilityCooldownMs(abilityMeta)
        : existingState.cooldownEndMs,
    };
    removeFighterEwarEffect(
      scene,
      fighterEntity,
      shipEntity,
      abilitySlotID,
      existingState,
    );
    clearAbilityActiveWindow(nextState);
    if (toNumber(nextState.cooldownEndMs, 0) <= nowMs) {
      delete nextState.cooldownStartMs;
      delete nextState.cooldownEndMs;
    }
    setEntityAbilityState(fighterEntity, abilitySlotID, nextState);
    if (isMobilityAbilitySnapshot(abilityMeta)) {
      syncFighterMobilityAbilityState(
        scene,
        fighterEntity,
        shipEntity,
        nowMs,
      );
    }
    persistFighterEntityState(fighterEntity);
    queueAbilityDeactivated(ownerSession, fighterEntity.itemID, abilitySlotID, null);
  }

  return {
    success: errors.length === 0,
    errors,
    entries: buildPerFighterResultEntries(fighterIDs, errors),
  };
}

// A GotoPoint is a movement order like any other: it
// waits in the Movement queue and applies at the next doPreTick, in call
// order with the fighter's other orders, from the fighter's state then.
function issueFighterGotoPoint(scene, fighterEntity, point) {
  if (!fighterEntity) {
    return false;
  }
  if (queueMovementCommand(
    scene,
    fighterEntity,
    "fighterGotoPoint",
    () => issueFighterGotoPoint(scene, fighterEntity, point),
  )) {
    return true;
  }
  const normalizedPoint = cloneVector(point, fighterEntity && fighterEntity.position);
  const direction = normalizeVector(
    subtractVectors(normalizedPoint, fighterEntity.position),
    fighterEntity.direction,
  );

  const gotoPointCommand = applyFighterGotoPointCommand({
    fighterEntity,
    targetPoint: normalizedPoint,
    direction,
  });
  if (!gotoPointCommand.applied) {
    return false;
  }
  persistFighterEntityState(fighterEntity);
  scene.queueBubbleHistory(
    gotoPointCommand.buildPresentationUpdates({ stamp: scene.nextDestinyStamp }),
  );
  return true;
}

function executeMovementCommandOnFighters(session, rawFighterIDs, command, ...args) {
  const shipState = getShipStateForSession(session);
  if (!shipState) {
    return false;
  }

  const { shipRecord, shipEntity, scene } = shipState;
  const ownerSession = getOwnerSession(shipRecord, session);
  const fighterIDs = normalizeFighterIDList(rawFighterIDs);
  const normalizedCommand = String(command || "").trim().toUpperCase();
  let movedAny = false;

  for (const fighterID of fighterIDs) {
    const fighterEntity = scene.getEntityByID(fighterID);
    if (!isFighterEntity(fighterEntity) || toInt(fighterEntity.controllerID, 0) !== toInt(shipRecord.itemID, 0)) {
      continue;
    }
    if (
      !securityScopesExactlyMatch(
        getPlayerCompanionSecurityScope(fighterEntity),
        getPlayerCompanionSecurityScope(shipEntity, { controller: true }),
      )
    ) {
      continue;
    }

    const canceledRecallTubeFlagID =
      fighterEntity.fighterCommand === "RECALL_TUBE"
        ? toInt(
          fighterEntity.fighterRecallTubeFlagID,
          toInt(fighterEntity.tubeFlagID, 0),
        )
        : 0;
    clearFighterCommandState(fighterEntity);
    if (isFighterTubeFlag(canceledRecallTubeFlagID)) {
      notifyTubeState(ownerSession, canceledRecallTubeFlagID, TUBE_STATE_INSPACE);
    }
    switch (normalizedCommand) {
      case MOVEMENT_COMMAND_ORBIT: {
        const targetID = toInt(args[0], 0);
        const orbitDistance = Math.max(
          0,
          toNumber(args[1], DEFAULT_FIGHTER_ORBIT_DISTANCE_METERS),
        );
        if (!scene.getEntityByID(targetID)) {
          break;
        }
        scene.orbitShipEntity(fighterEntity, targetID, orbitDistance, {
          broadcast: true,
        });
        persistFighterEntityState(fighterEntity);
        movedAny = true;
        break;
      }
      case MOVEMENT_COMMAND_FOLLOW: {
        const targetID = toInt(args[0], 0);
        const followRange = Math.max(0, toNumber(args[1], 0));
        if (!scene.getEntityByID(targetID)) {
          break;
        }
        scene.followShipEntity(fighterEntity, targetID, followRange, {
          broadcast: true,
        });
        persistFighterEntityState(fighterEntity);
        movedAny = true;
        break;
      }
      case MOVEMENT_COMMAND_STOP:
        scene.stopShipEntity(fighterEntity, {
          allowSessionOwned: true,
        });
        persistFighterEntityState(fighterEntity);
        movedAny = true;
        break;
      case MOVEMENT_COMMAND_GOTO_POINT: {
        const point = normalizeFighterCommandPoint(args[0]);
        if (point) {
          movedAny = issueFighterGotoPoint(scene, fighterEntity, point) || movedAny;
        }
        break;
      }
      default:
        break;
    }
  }

  return movedAny;
}

function commandAbandonFighter(session, rawFighterID) {
  const shipState = getShipStateForSession(session);
  if (!shipState) {
    return false;
  }

  const { shipRecord, scene } = shipState;
  let abandonedAny = false;
  const ownerSession = getOwnerSession(shipRecord, session);

  for (const fighterID of normalizeFighterIDList(rawFighterID)) {
    const fighterEntity = scene.getEntityByID(fighterID);
    if (!isFighterEntity(fighterEntity) || toInt(fighterEntity.controllerID, 0) !== toInt(shipRecord.itemID, 0)) {
      continue;
    }
    abandonedAny = abandonFighterInSpace(scene, fighterEntity, {
      ownerSession,
      controllerEntity: scene.getEntityByID(shipRecord.itemID) || null,
      nowMs: scene.getCurrentSimTimeMs(),
    }) || abandonedAny;
  }

  return abandonedAny;
}

function abandonFighterInSpace(scene, fighterEntity, options = {}) {
  if (!scene || !isFighterEntity(fighterEntity)) {
    return false;
  }

  const previousControllerID = toInt(fighterEntity.controllerID, 0);
  const previousControllerOwnerID = toInt(fighterEntity.controllerOwnerID, 0);
  const previousControllerEntity =
    options.controllerEntity ||
    (previousControllerID > 0 ? scene.getEntityByID(previousControllerID) : null);
  const ownerSession =
    Object.prototype.hasOwnProperty.call(options, "ownerSession")
      ? options.ownerSession
      : resolveFighterControllerSession(
        fighterEntity,
        previousControllerEntity,
      );
  const tubeFlagID = toInt(fighterEntity.tubeFlagID, 0);
  if (typeof scene.stopShipEntity === "function" && options.stopMovement !== false) {
    scene.stopShipEntity(fighterEntity, {
      allowSessionOwned: true,
      broadcast: options.broadcastMovement !== false,
    });
  }
  fighterEntity.launcherID = null;
  removeAllFighterEwarEffects(
    scene,
    fighterEntity,
    previousControllerEntity,
  );
  fighterEntity.controllerID = null;
  fighterEntity.controllerOwnerID = 0;
  fighterEntity.tubeFlagID = null;
  clearEntityAbilityStates(fighterEntity);
  clearFighterCommandState(fighterEntity);
  syncFighterMobilityAbilityState(
    scene,
    fighterEntity,
    null,
    toNumber(
      options.nowMs,
      scene.getCurrentSimTimeMs && scene.getCurrentSimTimeMs(),
    ),
  );
  persistFighterEntityState(fighterEntity);
  if (options.notify !== false) {
    notifyFighterRemoved(ownerSession, fighterEntity.itemID, tubeFlagID);
    if (isFighterTubeFlag(tubeFlagID)) {
      notifyTubeState(ownerSession, tubeFlagID, TUBE_STATE_EMPTY);
    }
  }
  if (previousControllerEntity) {
    syncFightersLaunchedTetherRestriction(
      scene,
      previousControllerEntity,
      previousControllerOwnerID,
    );
  }
  return true;
}

function handleControllerLost(scene, controllerEntity, options = {}) {
  if (!scene || !controllerEntity) {
    return {
      success: false,
      releasedCount: 0,
      recoveredCount: 0,
    };
  }

  const controllerID = toInt(controllerEntity.itemID, 0);
  if (controllerID <= 0) {
    return {
      success: false,
      releasedCount: 0,
      recoveredCount: 0,
    };
  }

  const ownerSession =
    Object.prototype.hasOwnProperty.call(options, "ownerSession")
      ? options.ownerSession
      : resolveFighterControllerSession(null, controllerEntity);
  const shipRecord =
    options.shipRecord ||
    findItemById(controllerID) ||
    null;
  const requestedEntityIDs = Array.isArray(options.entityIDs)
    ? new Set(normalizeFighterIDList(options.entityIDs))
    : null;
  let releasedCount = 0;
  let recoveredCount = 0;

  for (const fighterEntity of listControlledFighterEntities(scene, controllerID)) {
    if (requestedEntityIDs && !requestedEntityIDs.has(toInt(fighterEntity.itemID, 0))) {
      continue;
    }
    if (
      options.attemptTubeRecovery === true &&
      shipRecord &&
      isFighterTubeFlag(fighterEntity.tubeFlagID) &&
      surfaceDistance(
        fighterEntity,
        controllerEntity,
        scene,
        toNumber(options.nowMs, scene.simTimeMs),
        "fighter-controller-loss-recovery",
      ) <= FIGHTER_RECOVERY_DISTANCE_METERS
    ) {
      const landResult = landFighterToTube(scene, shipRecord, fighterEntity, ownerSession);
      if (landResult && landResult.success === true) {
        releasedCount += 1;
        recoveredCount += 1;
        continue;
      }
    }

    if (abandonFighterInSpace(scene, fighterEntity, {
      ...options,
      ownerSession,
      controllerEntity,
    })) {
      releasedCount += 1;
    }
  }

  return {
    success: true,
    releasedCount,
    recoveredCount,
  };
}

function scoopAbandonedFighterFromSpace(session, rawFighterID, rawToFlagID) {
  const shipState = getShipStateForSession(session);
  if (!shipState) {
    return false;
  }

  const { shipRecord, shipEntity, scene } = shipState;
  const fighterID = toInt(rawFighterID, 0);
  const toFlagID = toInt(rawToFlagID, ITEM_FLAGS.FIGHTER_BAY);
  const fighterEntity = scene.getEntityByID(fighterID);
  if (!isFighterEntity(fighterEntity)) {
    return false;
  }
  if (toInt(fighterEntity.controllerID, 0) > 0) {
    return false;
  }
  if (
    !securityScopesExactlyMatch(
      getPlayerCompanionSecurityScope(fighterEntity),
      getPlayerCompanionSecurityScope(shipEntity, { controller: true }),
    )
  ) {
    return false;
  }
  if (
    toFlagID !== ITEM_FLAGS.FIGHTER_BAY &&
    !isFighterTubeFlag(toFlagID)
  ) {
    return false;
  }
  if (
    isFighterTubeFlag(toFlagID) &&
    getShipTubeItem(shipRecord, toFlagID)
  ) {
    return false;
  }
  if (
    surfaceDistance(
      fighterEntity,
      shipEntity,
      scene,
      scene.simTimeMs,
      "fighter-scoop",
    ) > FIGHTER_RECOVERY_DISTANCE_METERS
  ) {
    return false;
  }

  const sourceItem = findItemById(toInt(fighterEntity.itemID, 0));
  if (
    toFlagID === ITEM_FLAGS.FIGHTER_BAY &&
    getFighterInventoryVolume(sourceItem) >
      getAvailableFighterBayVolume(shipState.characterID, shipRecord) + 1e-7
  ) {
    throwWrappedUserError("NotEnoughFighterBaySpace", {});
  }

  const ownerSession = getOwnerSession(shipRecord, session);
  const updateResult = recoverFighterInventory(
    scene,
    shipRecord,
    fighterEntity,
    toFlagID,
  );
  if (!updateResult.success) {
    return false;
  }

  const recoveredItem = updateResult.data && updateResult.data.item;
  const changes = [
    ...(updateResult.data && updateResult.data.changes || []),
  ];
  if (toFlagID === ITEM_FLAGS.FIGHTER_BAY) {
    const mergeTarget = listContainerItems(
      toInt(shipRecord.ownerID, 0),
      shipRecord.itemID,
      ITEM_FLAGS.FIGHTER_BAY,
    ).find((item) => (
      toInt(item.itemID, 0) !== toInt(fighterEntity.itemID, 0) &&
      toInt(item.typeID, 0) === toInt(fighterEntity.typeID, 0) &&
      toInt(item.ownerID, 0) === toInt(shipRecord.ownerID, 0)
    ));
    if (mergeTarget) {
      const mergeResult = mergeItemStacks(fighterEntity.itemID, mergeTarget.itemID);
      if (mergeResult.success) {
        changes.push(...(mergeResult.data && mergeResult.data.changes || []));
      }
    }
  }

  syncInventoryChangesToSession(ownerSession, changes);
  if (isFighterTubeFlag(toFlagID)) {
    notifyTubeContent(ownerSession, toFlagID, recoveredItem);
    notifyTubeState(ownerSession, toFlagID, TUBE_STATE_READY);
  }
  return true;
}

function syncFighterRecallTravel(scene, fighterEntity, controllerEntity, recallDistance) {
  const mode = String(fighterEntity.mode || "").trim().toUpperCase();
  if (mode === "WARP") {
    return;
  }

  if (
    recallDistance > FIGHTER_RECALL_WARP_MINIMUM_DISTANCE_METERS &&
    typeof scene.warpDynamicEntityToPoint === "function"
  ) {
    const warpResult = scene.warpDynamicEntityToPoint(
      fighterEntity,
      cloneVector(controllerEntity.position),
      {
        ignoreWarpDisruptionField: true,
        warpSpeedAU: 3,
      },
    );
    if (warpResult && warpResult.success) {
      persistFighterEntityState(fighterEntity);
      return;
    }
  }

  if (
    mode !== "FOLLOW" ||
    toInt(fighterEntity.targetEntityID, 0) !== toInt(controllerEntity.itemID, 0) ||
    Math.abs(
      toNumber(fighterEntity.followRange, 0) - FIGHTER_RECALL_APPROACH_DISTANCE_METERS,
    ) >= 1
  ) {
    const followed = scene.followShipEntity(
      fighterEntity,
      controllerEntity.itemID,
      FIGHTER_RECALL_APPROACH_DISTANCE_METERS,
      { broadcast: true },
    );
    if (!followed) {
      issueFighterGotoPoint(scene, fighterEntity, controllerEntity.position);
    }
    persistFighterEntityState(fighterEntity);
  }
}

function tickScene(scene, now) {
  const numericNow = toNumber(
    now,
    scene && typeof scene.getCurrentSimTimeMs === "function"
      ? scene.getCurrentSimTimeMs()
      : Date.now(),
  );

  for (const fighterEntity of getSceneFighterEntities(scene)) {
    const controllerID = toInt(fighterEntity.controllerID, 0);
    const controllerEntity = controllerID > 0 ? scene.getEntityByID(controllerID) : null;
    const controllerScopeMismatch = Boolean(
      controllerEntity &&
      !securityScopesExactlyMatch(
        getPlayerCompanionSecurityScope(fighterEntity),
        getPlayerCompanionSecurityScope(controllerEntity, { controller: true }),
      )
    );
    if ((controllerID > 0 && !controllerEntity) || controllerScopeMismatch) {
      abandonFighterInSpace(scene, fighterEntity, {
        notify: true,
        stopMovement: true,
        nowMs: numericNow,
      });
      continue;
    }

    if (controllerEntity) {
      let abilityStateChanged = false;
      const ownerSession =
        findSessionByCharacterID(toInt(fighterEntity.controllerOwnerID, 0)) ||
        resolveFighterControllerSession(fighterEntity, controllerEntity);
      syncFighterMobilityAbilityState(
        scene,
        fighterEntity,
        controllerEntity,
        numericNow,
      );
      for (const slotID of ABILITY_SLOT_IDS) {
        const persistedAbilityState = getEntityAbilityState(fighterEntity, slotID);
        if (!persistedAbilityState) {
          continue;
        }

        const abilityMeta =
          resolveFighterAbilitySnapshot(
            fighterEntity,
            controllerEntity,
            slotID,
          ) ||
          getFighterAbilityMetaForSlot(fighterEntity.typeID, slotID);
        if (!abilityMeta) {
          setEntityAbilityState(fighterEntity, slotID, null);
          syncFighterMobilityAbilityState(
            scene,
            fighterEntity,
            controllerEntity,
            numericNow,
          );
          abilityStateChanged = true;
          continue;
        }

        const scopedTargetID = toInt(
          persistedAbilityState.targetID,
          0,
        );
        if (scopedTargetID > 0) {
          const scopedTargetEntity = scene.getEntityByID(scopedTargetID);
          if (
            !scopedTargetEntity ||
            !canPlayerCompanionActOnTarget(
              scene,
              ownerSession,
              fighterEntity,
              controllerEntity,
              scopedTargetEntity,
            )
          ) {
            removeFighterEwarEffect(
              scene,
              fighterEntity,
              controllerEntity,
              slotID,
              persistedAbilityState,
            );
            const revokedState = {
              ...persistedAbilityState,
            };
            const hadActiveWindow =
              toNumber(revokedState.activeUntilMs, 0) > 0;
            clearAbilityActiveWindow(revokedState);
            setEntityAbilityState(
              fighterEntity,
              slotID,
              Object.keys(revokedState).length > 0 ? revokedState : null,
            );
            if (hadActiveWindow) {
              notifyAbilityDeactivated(
                ownerSession,
                fighterEntity.itemID,
                slotID,
                null,
              );
            }
            abilityStateChanged = true;
            continue;
          }
        }

        const previousStateSignature = JSON.stringify(persistedAbilityState || null);
        let abilityState = refreshAbilityCharges(
          fighterEntity,
          slotID,
          abilityMeta,
          numericNow,
        );
        if (JSON.stringify(abilityState || null) !== previousStateSignature) {
          abilityStateChanged = true;
        }
        if (!abilityState) {
          continue;
        }

        const isActive = toNumber(abilityState.activeUntilMs, 0) > numericNow;
        if (isActive) {
          continue;
        }

        if (toNumber(abilityState.activeUntilMs, 0) > 0) {
          const cycleResult =
            abilityState.firedAtActivation === true
            ? { continueActive: false, deactivate: true }
            : isLaunchBombAbility(abilityMeta)
            ? executeFighterBombCycle(
              scene,
              fighterEntity,
              controllerEntity,
              slotID,
              abilityState,
              numericNow,
            )
            : getFighterEwarConfig(abilityMeta)
            ? executeFighterUtilityCycle(
              scene,
              fighterEntity,
              controllerEntity,
              slotID,
              abilityState,
              numericNow,
            )
            : abilityMeta &&
              (abilityMeta.isOffensive === true || isKamikazeAbility(abilityMeta)) &&
              !isJammerAbilitySnapshot(abilityMeta)
            ? executeFighterOffensiveCycle(
              scene,
              fighterEntity,
              controllerEntity,
              slotID,
              abilityState,
              numericNow,
            )
            : executeFighterUtilityCycle(
              scene,
              fighterEntity,
              controllerEntity,
              slotID,
              abilityState,
              numericNow,
            );
          if (cycleResult && cycleResult.sourceDestroyed === true) {
            break;
          }
          const nextState = {
            ...abilityState,
          };
          clearAbilityActiveWindow(nextState);
          if (cycleResult && cycleResult.continueActive === true) {
            nextState.activeSinceMs = numericNow;
            nextState.durationMs = getEffectiveAbilityDurationMs(abilityMeta);
            nextState.activeUntilMs = numericNow + getEffectiveAbilityDurationMs(abilityMeta);
            if (toInt(abilityState.targetID, 0) > 0) {
              nextState.targetID = toInt(abilityState.targetID, 0);
            }
            if (abilityState.targetPoint) {
              nextState.targetPoint = cloneVector(abilityState.targetPoint);
            }
          } else {
            removeFighterEwarEffect(
              scene,
              fighterEntity,
              controllerEntity,
              slotID,
              abilityState,
            );
            notifyAbilityDeactivated(ownerSession, fighterEntity.itemID, slotID, null);
          }

          const maxChargeCount = getEffectiveAbilityChargeCount(abilityMeta);
          if (
            maxChargeCount !== null &&
            getAbilityStateChargeCount(nextState, abilityMeta) >= maxChargeCount &&
            toNumber(nextState.cooldownEndMs, 0) <= numericNow
          ) {
            delete nextState.remainingChargeCount;
            delete nextState.cooldownStartMs;
            delete nextState.cooldownEndMs;
          } else if (toNumber(nextState.cooldownEndMs, 0) <= numericNow) {
            delete nextState.cooldownStartMs;
            delete nextState.cooldownEndMs;
          }
          setEntityAbilityState(
            fighterEntity,
            slotID,
            Object.keys(nextState).length > 0 ? nextState : null,
          );
          if (isMobilityAbilitySnapshot(abilityMeta)) {
            syncFighterMobilityAbilityState(
              scene,
              fighterEntity,
              controllerEntity,
              numericNow,
            );
          }
          abilityStateChanged = true;
          continue;
        }

        const maxChargeCount = getEffectiveAbilityChargeCount(abilityMeta);
        if (
          maxChargeCount !== null &&
          getAbilityStateChargeCount(abilityState, abilityMeta) >= maxChargeCount &&
          toNumber(abilityState.cooldownEndMs, 0) <= numericNow
        ) {
          setEntityAbilityState(fighterEntity, slotID, null);
          abilityStateChanged = true;
        } else if (
          maxChargeCount === null &&
          toNumber(abilityState.cooldownEndMs, 0) <= numericNow
        ) {
          setEntityAbilityState(fighterEntity, slotID, null);
          abilityStateChanged = true;
        }
      }

      if (
        abilityStateChanged &&
        scene.getEntityByID(toInt(fighterEntity.itemID, 0)) === fighterEntity
      ) {
        persistFighterEntityState(fighterEntity);
      }
    }

    if (fighterEntity.fighterCommand !== "RECALL_TUBE" || !controllerEntity) {
      continue;
    }

    const recallDistance = surfaceDistance(
      fighterEntity,
      controllerEntity,
      scene,
      numericNow,
      "fighter-recall",
    );
    if (recallDistance > FIGHTER_RECOVERY_DISTANCE_METERS) {
      syncFighterRecallTravel(
        scene,
        fighterEntity,
        controllerEntity,
        recallDistance,
      );
      continue;
    }

    const shipRecord = resolveFighterControllerRecord(controllerEntity.itemID);
    if (!shipRecord) {
      continue;
    }

    landFighterToTube(scene, shipRecord, fighterEntity, findSessionByCharacterID(
      toInt(shipRecord.ownerID, 0),
    ));
  }
}

module.exports = {
  FIGHTER_CATEGORY_ID,
  MOVEMENT_COMMAND_ORBIT,
  MOVEMENT_COMMAND_FOLLOW,
  MOVEMENT_COMMAND_STOP,
  MOVEMENT_COMMAND_GOTO_POINT,
  DEFAULT_FIGHTER_ORBIT_DISTANCE_METERS,
  FIGHTER_RECOVERY_DISTANCE_METERS,
  FIGHTER_RECALL_APPROACH_DISTANCE_METERS,
  isFighterEntity,
  resolveFighterPassiveMaxVelocity,
  resolveFighterPassiveSignatureRadius,
  getFighterOrbitDistance,
  hydrateFighterEntityFromItem,
  applyDamageToFighterSquadron,
  handleFighterPostDamage,
  handleFighterDestroyed,
  buildFighterAbilitySlotStatesPayload,
  buildFightersInSpaceRowsForShip,
  buildAbilityStateEntriesForShip,
  launchFightersFromTubes,
  recallFightersToTubes,
  queueControlledFightersReturnToTubes,
  activateAbilitySlots,
  deactivateAbilitySlots,
  executeMovementCommandOnFighters,
  commandAbandonFighter,
  handleControllerLost,
  getAvailableFighterBayVolume,
  getFighterInventoryVolume,
  scoopAbandonedFighterFromSpace,
  tickScene,
  _testing: {
    buildAbilitySafetyRestrictionError,
    canPlayerCompanionActOnTarget,
    evaluateFighterOffensiveAggression,
    getRequiredSafetyLevelForFighterAttack,
    recordFighterOffensiveAggression,
    resolveRuntimeSceneForSession,
    serializePlayerCompanionScopeMetadata,
  },
};
