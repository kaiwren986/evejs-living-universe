"use strict";

const { normalizeText } = require("../domain/abyssalValueUtils");

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

// Exact run/room weather authority, application and removal. The engine owns
// derived state and scenes; injected run owners retain lifecycle/persistence state.
function getAbyssalWeatherRemovalState({
  cloneValue,
}, pocketState) {
  return pocketState &&
    pocketState.weatherRemovalState &&
    typeof pocketState.weatherRemovalState === "object"
    ? cloneValue(pocketState.weatherRemovalState)
    : null;
}

function isExactAbyssalWeatherRemovalClaim({
  getAbyssalWeatherRemovalState,
  normalizeLowerText,
}, pocketState, removalState = null) {
  const state = removalState || getAbyssalWeatherRemovalState(pocketState);
  return Boolean(
    state &&
    ["pending", "completed"].includes(normalizeLowerText(state.status, "")) &&
    toInt(state.instanceID, 0) === toInt(pocketState && pocketState.instanceID, 0) &&
    toInt(state.shipID, 0) === toInt(pocketState && pocketState.shipID, 0) &&
    toInt(state.characterID, 0) === toInt(pocketState && pocketState.characterID, 0) &&
    toInt(state.instanceID, 0) > 0 &&
    toInt(state.shipID, 0) > 0
  );
}

function getActiveWeatherStateForShipID({
  getActivePocketStateForShipID,
  isExactAbyssalWeatherRemovalClaim,
  getResolvedWeatherState,
}, shipID) {
  const pocketState = getActivePocketStateForShipID(shipID);
  if (!pocketState) {
    return null;
  }
  return isExactAbyssalWeatherRemovalClaim(pocketState)
    ? null
    : getResolvedWeatherState(pocketState);
}

function resolveExactAbyssalWeatherContextForEntity({
  resolveExactAbyssalRunRoomScope,
  getActivePocketStateByInstanceID,
  buildPlaceholderRoomState,
  isRetainedAbyssalPlayerCompanion,
  inspectAbyssalPlayerCreatedObjectAuthority,
}, entity, pocketState = null) {
  if (!entity || typeof entity !== "object") {
    return null;
  }
  const exactScope = resolveExactAbyssalRunRoomScope(entity);
  if (!exactScope) {
    return null;
  }
  const resolvedPocketState = pocketState ||
    getActivePocketStateByInstanceID(exactScope.runID);
  const runID = toInt(resolvedPocketState && resolvedPocketState.instanceID, 0);
  if (runID <= 0 || exactScope.runID !== runID) {
    return null;
  }
  const roomIndex = toInt(
    buildPlaceholderRoomState(resolvedPocketState).currentRoomIndex,
    0,
  );
  if (roomIndex <= 0 || exactScope.roomIndex !== roomIndex) {
    return null;
  }
  const participant =
    toInt(entity.itemID, 0) === toInt(resolvedPocketState.shipID, 0);
  const playerCompanionCandidate = Boolean(
    !participant && isRetainedAbyssalPlayerCompanion([entity])
  );
  const playerCompanionAuthority = playerCompanionCandidate
    ? inspectAbyssalPlayerCreatedObjectAuthority(resolvedPocketState, [entity])
    : null;
  if (
    playerCompanionCandidate &&
    !(playerCompanionAuthority && playerCompanionAuthority.authorized === true)
  ) {
    return null;
  }
  const playerCompanion = Boolean(
    playerCompanionCandidate &&
    playerCompanionAuthority &&
    playerCompanionAuthority.authorized === true
  );
  return {
    exactScope,
    pocketState: resolvedPocketState,
    participant,
    playerCompanion,
  };
}

function getActiveWeatherStateForEntity({
  resolveExactAbyssalWeatherContextForEntity,
  isExactAbyssalWeatherRemovalClaim,
  getResolvedWeatherState,
}, entity) {
  const context = resolveExactAbyssalWeatherContextForEntity(entity);
  if (!context) {
    return null;
  }
  return isExactAbyssalWeatherRemovalClaim(context.pocketState)
    ? null
    : getResolvedWeatherState(context.pocketState);
}

function collectAbyssalShipAttributeModifierEntriesForShipID({
  getActiveWeatherStateForShipID,
  cloneValue,
  ABYSSAL_PLAYER_ATTRIBUTE_SOURCE_KEY,
}, shipID) {
  const weatherState = getActiveWeatherStateForShipID(shipID);
  return weatherState && Array.isArray(weatherState.playerShipAttributeModifierEntries)
    ? weatherState.playerShipAttributeModifierEntries.map((entry) => ({
        ...cloneValue(entry),
        modifierSourceKey: ABYSSAL_PLAYER_ATTRIBUTE_SOURCE_KEY,
      }))
    : [];
}

function collectAbyssalNpcShipAttributeModifierEntriesForEntity({
  getActiveWeatherStateForEntity,
  cloneValue,
}, entity) {
  if (!entity || entity.nativeNpc !== true) {
    return [];
  }
  const weatherState = getActiveWeatherStateForEntity(entity);
  return weatherState && Array.isArray(weatherState.npcShipAttributeModifierEntries)
    ? weatherState.npcShipAttributeModifierEntries.map((entry) => ({
        ...cloneValue(entry),
        modifierSourceKey: "abyssalWeather:npcShipAttributeModifierEntries",
      }))
    : [];
}

function collectAbyssalLocationModifierSourcesForShipID({
  getActiveWeatherStateForShipID,
  cloneValue,
}, shipID) {
  const weatherState = getActiveWeatherStateForShipID(shipID);
  return weatherState && Array.isArray(weatherState.playerLocationModifierSources)
    ? cloneValue(weatherState.playerLocationModifierSources)
    : [];
}

function collectAbyssalLocationModifierSourcesForEntity({
  resolveExactAbyssalWeatherContextForEntity,
  isExactAbyssalWeatherRemovalClaim,
  getResolvedWeatherState,
  cloneValue,
}, entity) {
  const context = resolveExactAbyssalWeatherContextForEntity(entity);
  const weatherState = context && !isExactAbyssalWeatherRemovalClaim(context.pocketState)
    ? getResolvedWeatherState(context.pocketState)
    : null;
  const targetSources = context && (context.participant || context.playerCompanion)
    ? weatherState && weatherState.playerLocationModifierSources
    : weatherState && weatherState.npcLocationModifierSources;
  return Array.isArray(targetSources)
    ? cloneValue(targetSources)
    : [];
}

function captureNpcWeatherBaseState({
  cloneValue,
}, entity) {
  const passiveDerivedState =
    entity && entity.passiveDerivedState && typeof entity.passiveDerivedState === "object"
      ? entity.passiveDerivedState
      : {};
  return {
    maxVelocity: Number(entity && entity.maxVelocity) || 0,
    scanResolution: Number(entity && entity.scanResolution) || 0,
    capacitorCapacity: Number(entity && entity.capacitorCapacity) || 0,
    capacitorRechargeRate: Number(entity && entity.capacitorRechargeRate) || 0,
    shieldCapacity: Number(entity && entity.shieldCapacity) || 0,
    shieldRechargeRate: Number(entity && entity.shieldRechargeRate) || 0,
    armorHP: Number(entity && entity.armorHP) || 0,
    structureHP: Number(entity && entity.structureHP) || 0,
    passiveDerivedState: cloneValue(passiveDerivedState),
    passiveAttributes:
      passiveDerivedState.attributes && typeof passiveDerivedState.attributes === "object"
        ? cloneValue(passiveDerivedState.attributes)
        : {},
  };
}

function applyNpcWeatherSummaryField({}, entity, nextAttributes, attributeName, attributeID, fallbackField = null) {
  const numericValue = Number(nextAttributes && nextAttributes[String(attributeID)]);
  if (Number.isFinite(numericValue)) {
    entity[attributeName] = numericValue;
    if (entity.passiveDerivedState && typeof entity.passiveDerivedState === "object") {
      entity.passiveDerivedState[attributeName] = numericValue;
    }
    return true;
  }
  if (fallbackField && Number.isFinite(Number(entity && entity[fallbackField]))) {
    entity[attributeName] = Number(entity[fallbackField]);
    return true;
  }
  return false;
}

function applyNpcWeatherAttributeSummaries({
  applyNpcWeatherSummaryField,
  ATTRIBUTE_MAX_VELOCITY,
  ATTRIBUTE_SCAN_RESOLUTION,
  ATTRIBUTE_CAPACITOR_RECHARGE_RATE,
  ATTRIBUTE_SHIELD_CAPACITY,
  ATTRIBUTE_ARMOR_HP,
  ABYSSAL_WEATHER_SHIP_ATTRIBUTE_NAME_TO_ID,
}, entity, baseAttributes, weatherState) {
  const effectKeys = [];
  const pendingEffectKeys = [];
  if (
    weatherState.npcAppliedEffectKeys.includes("max_velocity_bonus") &&
    applyNpcWeatherSummaryField(entity, baseAttributes, "maxVelocity", ATTRIBUTE_MAX_VELOCITY, "maxVelocity")
  ) {
    effectKeys.push("max_velocity_bonus");
  }
  if (
    weatherState.npcAppliedEffectKeys.includes("scan_resolution_bonus") &&
    applyNpcWeatherSummaryField(entity, baseAttributes, "scanResolution", ATTRIBUTE_SCAN_RESOLUTION, "scanResolution")
  ) {
    effectKeys.push("scan_resolution_bonus");
  }
  if (
    weatherState.npcAppliedEffectKeys.includes("capacitor_recharge_bonus") &&
    applyNpcWeatherSummaryField(entity, baseAttributes, "capacitorRechargeRate", ATTRIBUTE_CAPACITOR_RECHARGE_RATE, "capacitorRechargeRate")
  ) {
    effectKeys.push("capacitor_recharge_bonus");
  }
  if (
    weatherState.npcAppliedEffectKeys.includes("shield_hp_bonus") &&
    applyNpcWeatherSummaryField(entity, baseAttributes, "shieldCapacity", ATTRIBUTE_SHIELD_CAPACITY, "shieldCapacity")
  ) {
    effectKeys.push("shield_hp_bonus");
  }
  if (
    weatherState.npcAppliedEffectKeys.includes("armor_hp_bonus") &&
    applyNpcWeatherSummaryField(entity, baseAttributes, "armorHP", ATTRIBUTE_ARMOR_HP, "armorHP")
  ) {
    effectKeys.push("armor_hp_bonus");
  }

  const resonanceEffectIDs = [
    "em_resist_penalty",
    "kinetic_resist_penalty",
    "thermal_resist_penalty",
    "explosive_resist_penalty",
  ];
  for (const resonanceEffectID of resonanceEffectIDs) {
    if (weatherState.npcAppliedEffectKeys.includes(resonanceEffectID)) {
      const descriptor = weatherState.effectDescriptors.find(
        (entry) => normalizeText(entry && entry.effectID, "") === resonanceEffectID,
      );
      const attributeNames = Array.isArray(descriptor && descriptor.attributeNames)
        ? descriptor.attributeNames
        : [];
      const supported = attributeNames.some(
        (attributeName) => ABYSSAL_WEATHER_SHIP_ATTRIBUTE_NAME_TO_ID[String(attributeName || "").trim()] > 0,
      );
      if (supported) {
        effectKeys.push(resonanceEffectID);
      }
    }
  }

  for (const effectID of weatherState.npcAppliedEffectKeys) {
    if (!effectKeys.includes(effectID) && !pendingEffectKeys.includes(effectID)) {
      if (effectID.startsWith("turret_")) {
        effectKeys.push(effectID);
      } else {
        pendingEffectKeys.push(effectID);
      }
    }
  }
  return { effectKeys, pendingEffectKeys };
}

function applyAbyssalWeatherToNpcEntity({
  resolveExactAbyssalWeatherContextForEntity,
  isExactAbyssalWeatherRemovalClaim,
  getResolvedWeatherState,
  captureNpcWeatherBaseState,
  cloneValue,
  seedMissingAbyssalResonanceBaseAttributes,
  applyModifierGroups,
  applyNpcWeatherAttributeSummaries,
}, entity, pocketState = null) {
  if (!entity || typeof entity !== "object") {
    return {
      applied: false,
      effectKeys: [],
      pendingEffectKeys: [],
    };
  }

  const context = resolveExactAbyssalWeatherContextForEntity(entity, pocketState);
  if (!context) {
    return {
      applied: false,
      effectKeys: [],
      pendingEffectKeys: [],
      reason: "ABYSSAL_WEATHER_SCOPE_MISMATCH",
    };
  }
  const weatherState = isExactAbyssalWeatherRemovalClaim(context.pocketState)
    ? null
    : getResolvedWeatherState(context.pocketState);
  if (!weatherState) {
    return {
      applied: false,
      effectKeys: [],
      pendingEffectKeys: [],
    };
  }

  const existingWeatherState =
    entity.evejsAbyssalWeatherState &&
    typeof entity.evejsAbyssalWeatherState === "object"
      ? entity.evejsAbyssalWeatherState
      : null;
  if (
    entity.evejsAbyssalWeatherBaseState &&
    existingWeatherState &&
    toInt(existingWeatherState.runID, 0) === context.exactScope.runID &&
    toInt(existingWeatherState.roomIndex, 0) === context.exactScope.roomIndex &&
    normalizeText(existingWeatherState.weatherType, "") ===
      normalizeText(weatherState.weatherType, "") &&
    toInt(existingWeatherState.weatherStage, 0) === toInt(weatherState.weatherStage, 0) &&
    toInt(existingWeatherState.weatherTypeID, 0) === toInt(weatherState.weatherTypeID, 0) &&
    toInt(existingWeatherState.penaltyStrengthPercent, 0) ===
      toInt(weatherState.penaltyStrengthPercent, toInt(weatherState.strengthPercent, 0)) &&
    toInt(existingWeatherState.bonusStrengthPercent, 0) ===
      toInt(weatherState.bonusStrengthPercent, toInt(weatherState.strengthPercent, 0))
  ) {
    const effectKeys = Array.isArray(existingWeatherState.effectKeys)
      ? existingWeatherState.effectKeys
      : [];
    const pendingEffectKeys = Array.isArray(existingWeatherState.pendingEffectKeys)
      ? existingWeatherState.pendingEffectKeys
      : [];
    return {
      applied: effectKeys.length > 0,
      alreadyApplied: true,
      effectKeys: [...effectKeys],
      pendingEffectKeys: [...pendingEffectKeys],
    };
  }

  if (!entity.evejsAbyssalWeatherBaseState) {
    entity.evejsAbyssalWeatherBaseState = captureNpcWeatherBaseState(entity);
  }
  const baseState = entity.evejsAbyssalWeatherBaseState;
  const baseAttributes = cloneValue(baseState.passiveAttributes || {});
  const appliedDirect = Array.isArray(weatherState.npcShipAttributeModifierEntries)
    ? weatherState.npcShipAttributeModifierEntries
    : [];
  seedMissingAbyssalResonanceBaseAttributes(baseAttributes, weatherState, "npc");

  if (Object.keys(baseAttributes).length > 0 && appliedDirect.length > 0) {
    applyModifierGroups(baseAttributes, appliedDirect);
  }

  if (!entity.passiveDerivedState || typeof entity.passiveDerivedState !== "object") {
    entity.passiveDerivedState = cloneValue(baseState.passiveDerivedState || {});
  }
  entity.passiveDerivedState.attributes = baseAttributes;

  const { effectKeys, pendingEffectKeys } = applyNpcWeatherAttributeSummaries(
    entity, baseAttributes, weatherState,
  );

  entity.evejsAbyssalWeatherState = {
    runID: context.exactScope.runID,
    roomIndex: context.exactScope.roomIndex,
    weatherType: weatherState.weatherType,
    strengthPercent: weatherState.strengthPercent,
    penaltyStrengthPercent: toInt(
      weatherState.penaltyStrengthPercent,
      toInt(weatherState.strengthPercent, 0),
    ),
    bonusStrengthPercent: toInt(
      weatherState.bonusStrengthPercent,
      toInt(weatherState.strengthPercent, 0),
    ),
    weatherStage: toInt(weatherState.weatherStage, 0),
    weatherTypeID: toInt(weatherState.weatherTypeID, 0),
    effectKeys: [...new Set(effectKeys)],
    pendingEffectKeys: [...new Set(pendingEffectKeys)],
  };

  return {
    applied: effectKeys.length > 0,
    effectKeys: [...new Set(effectKeys)],
    pendingEffectKeys: [...new Set(pendingEffectKeys)],
  };
}

function refreshAbyssalPlayerShipWeather({
  getDependencies,
  cloneValue,
  collectAbyssalShipAttributeModifierEntriesForShipID,
  getActiveWeatherStateForShipID,
  repairAppliedAbyssalResonanceAttributes,
}, session, deps = getDependencies(), options = {}) {
  const runtime = deps;
  if (!session) {
    return {
      refreshed: false,
      reason: "NO_ACTIVE_SESSION",
    };
  }
  if (!runtime) {
    return {
      refreshed: false,
      reason: "NO_RUNTIME",
    };
  }
  const shipID = toInt(
    session && session._space && session._space.shipID,
    toInt(session && (session.shipID || session.shipid), 0),
  );
  const scene =
    typeof runtime.getSceneForSession === "function"
      ? runtime.getSceneForSession(session)
      : null;
  const scenePresent = Boolean(scene);
  const shipEntity = scene && typeof scene.getShipEntityForSession === "function"
    ? scene.getShipEntityForSession(session)
    : null;
  const shipEntityPresent = Boolean(shipEntity);
  const preRefreshAttributes =
    shipEntity &&
    shipEntity.passiveDerivedState &&
    shipEntity.passiveDerivedState.attributes &&
    typeof shipEntity.passiveDerivedState.attributes === "object"
      ? cloneValue(shipEntity.passiveDerivedState.attributes)
      : {};
  const modifierEntries = shipID > 0
    ? collectAbyssalShipAttributeModifierEntriesForShipID(shipID)
    : [];
  const modifierSourceRegistered = modifierEntries.length > 0;
  const weatherState = shipID > 0 ? getActiveWeatherStateForShipID(shipID) : null;
  const refreshFn =
    typeof runtime.refreshShipDerivedState === "function"
      ? runtime.refreshShipDerivedState.bind(runtime)
      : (
        typeof runtime.refreshSessionShipDerivedState === "function"
          ? runtime.refreshSessionShipDerivedState.bind(runtime)
          : null
      );
  if (!refreshFn) {
    return {
      refreshed: false,
      reason: "REFRESH_NOT_SUPPORTED",
      diagnostics: {
        shipID,
        scenePresent,
        shipEntityPresent,
        modifierSourceRegistered,
      },
    };
  }
  const refreshResult = refreshFn(session, {
    notifyTargeting: true,
    notifyGenericModuleAttributes: true,
    ...(options && typeof options === "object" ? options : {}),
  });
  const refreshed = Boolean(refreshResult && refreshResult.success);
  const repairedPlayerResonanceEffects =
    refreshed &&
    weatherState &&
    shipEntity &&
    shipEntity.passiveDerivedState &&
    shipEntity.passiveDerivedState.attributes &&
    typeof shipEntity.passiveDerivedState.attributes === "object"
      ? repairAppliedAbyssalResonanceAttributes(
          shipEntity.passiveDerivedState.attributes,
          preRefreshAttributes,
          weatherState,
          "player",
        )
      : [];
  let reason = "REFRESH_OK";
  if (!refreshed) {
    const errorMsg = normalizeText(refreshResult && refreshResult.errorMsg, "");
    if (errorMsg) {
      reason = errorMsg;
    } else if (!scenePresent) {
      reason = "NO_RUNTIME_SCENE";
    } else if (!shipEntityPresent) {
      reason = "NO_RUNTIME_ENTITY";
    } else if (!modifierSourceRegistered) {
      reason = "NO_MODIFIER_SOURCE";
    } else {
      reason = "REFRESH_FAILED";
    }
  }
  return {
    refreshed,
    reason,
    refreshResult,
    diagnostics: {
      shipID,
      scenePresent,
      shipEntityPresent,
      modifierSourceRegistered,
      refreshCalled: true,
      repairedPlayerResonanceEffects,
      refreshMethod:
        typeof runtime.refreshShipDerivedState === "function"
          ? "refreshShipDerivedState"
          : "refreshSessionShipDerivedState",
    },
  };
}

function repairActiveAbyssalNpcWeather({
  getDependencies,
  getPocketScene,
  listPocketHostileEntityIDs,
  applyAbyssalWeatherToNpcEntity,
}, pocketState, deps = getDependencies()) {
  const scene = getPocketScene(pocketState, deps);
  const hostileEntityIDs = listPocketHostileEntityIDs(pocketState);
  if (!scene || typeof scene.getEntityByID !== "function" || hostileEntityIDs.length <= 0) {
    return {
      appliedNpcCount: 0,
      pendingNpcCount: 0,
    };
  }

  let appliedNpcCount = 0;
  let pendingNpcCount = 0;
  const pendingEffectKeys = [];
  for (const hostileEntityID of hostileEntityIDs) {
    const entity = scene.getEntityByID(hostileEntityID);
    if (!entity) {
      continue;
    }
    const applyResult = applyAbyssalWeatherToNpcEntity(entity, pocketState);
    if (applyResult.applied) {
      appliedNpcCount += 1;
    }
    if (Array.isArray(applyResult.pendingEffectKeys) && applyResult.pendingEffectKeys.length > 0) {
      pendingNpcCount += 1;
      pendingEffectKeys.push(...applyResult.pendingEffectKeys);
    }
  }
  return {
    appliedNpcCount,
    pendingNpcCount,
    pendingEffectKeys: [...new Set(pendingEffectKeys.filter(Boolean))],
  };
}

function buildAbyssalWeatherModifierEntrySignature({
  ABYSSAL_PLAYER_ATTRIBUTE_SOURCE_KEY,
}, entry) {
  const modifiedAttributeID = toInt(entry && entry.modifiedAttributeID, 0);
  const operation = toInt(entry && entry.operation, -1);
  const value = Number(entry && entry.value);
  const modifierSourceKey = normalizeText(entry && entry.modifierSourceKey, "");
  if (
    modifiedAttributeID <= 0 ||
    operation < 0 ||
    !Number.isFinite(value) ||
    modifierSourceKey !== ABYSSAL_PLAYER_ATTRIBUTE_SOURCE_KEY
  ) {
    return "";
  }
  return [
    modifierSourceKey,
    modifiedAttributeID,
    operation,
    value,
    entry && entry.stackingPenalized === true ? 1 : 0,
  ].join(":");
}

function findUnappliedAbyssalWeatherSourceAttributeIDs({
  buildAbyssalWeatherModifierEntrySignature,
},
  sourceEntries,
  appliedAttributeModifierEntries,
) {
  const availableSignatures = new Map();
  for (const appliedEntry of Array.isArray(appliedAttributeModifierEntries)
    ? appliedAttributeModifierEntries
    : []) {
    const signature = buildAbyssalWeatherModifierEntrySignature(appliedEntry);
    if (!signature) {
      continue;
    }
    availableSignatures.set(signature, toInt(availableSignatures.get(signature), 0) + 1);
  }

  const unappliedAttributeIDs = [];
  for (const sourceEntry of Array.isArray(sourceEntries) ? sourceEntries : []) {
    const signature = buildAbyssalWeatherModifierEntrySignature(sourceEntry);
    const availableCount = signature ? toInt(availableSignatures.get(signature), 0) : 0;
    if (availableCount <= 0) {
      unappliedAttributeIDs.push(toInt(sourceEntry && sourceEntry.modifiedAttributeID, 0));
      continue;
    }
    availableSignatures.set(signature, availableCount - 1);
  }
  return [...new Set(unappliedAttributeIDs.filter((attributeID) => attributeID > 0))];
}

function verifyAbyssalPlayerWeatherDerivedState({
  getDependencies,
  buildPlaceholderRoomState,
  getPocketScene,
  resolveExactAbyssalRunRoomScope,
  collectAbyssalShipAttributeModifierEntriesForShipID,
  getEntityPassiveAttributeMap,
  findUnappliedAbyssalWeatherSourceAttributeIDs,
},
  pocketState,
  session,
  deps = getDependencies(),
) {
  const shipID = toInt(
    session && session._space && session._space.shipID,
    toInt(session && (session.shipID || session.shipid || session.activeShipID), 0),
  );
  const roomIndex = buildPlaceholderRoomState(pocketState).currentRoomIndex;
  const scene = getPocketScene(pocketState, deps);
  const shipEntity = scene && typeof scene.getEntityByID === "function"
    ? scene.getEntityByID(shipID)
    : null;
  const exactScope = resolveExactAbyssalRunRoomScope(shipEntity);
  const sourceEntries = collectAbyssalShipAttributeModifierEntriesForShipID(shipID);
  const attributeMap = getEntityPassiveAttributeMap(shipEntity);
  // Passive derivation records which sources actually participated. Top-level
  // ship fields are live aggregates and may legitimately include propulsion or
  // hostile runtime effects layered on after this weather-owned state.
  const appliedAttributeModifierEntries =
    shipEntity &&
    shipEntity.passiveDerivedState &&
    Array.isArray(shipEntity.passiveDerivedState.appliedAttributeModifierEntries)
      ? shipEntity.passiveDerivedState.appliedAttributeModifierEntries
      : [];
  const missingAttributeIDs = [...new Set(sourceEntries
    .map((entry) => toInt(entry && entry.modifiedAttributeID, 0))
    .filter((attributeID) =>
      attributeID <= 0 || !Number.isFinite(Number(attributeMap && attributeMap[attributeID]))
    ))];
  const unappliedSourceAttributeIDs = findUnappliedAbyssalWeatherSourceAttributeIDs(
    sourceEntries,
    appliedAttributeModifierEntries,
  );
  const verified = Boolean(
    shipID > 0 &&
    shipEntity &&
    exactScope &&
    exactScope.runID === toInt(pocketState && pocketState.instanceID, 0) &&
    exactScope.roomIndex === roomIndex &&
    sourceEntries.length > 0 &&
    attributeMap &&
    missingAttributeIDs.length === 0 &&
    unappliedSourceAttributeIDs.length === 0 &&
    session &&
    toInt(session.abyssalInstanceID, 0) === toInt(pocketState && pocketState.instanceID, 0) &&
    toInt(session.abyssalRoomIndex, 0) === roomIndex
  );
  return {
    verified,
    shipID,
    roomIndex,
    shipEntityPresent: Boolean(shipEntity),
    attributeMapPresent: Boolean(attributeMap),
    sessionRunID: toInt(session && session.abyssalInstanceID, 0),
    sessionRoomIndex: toInt(session && session.abyssalRoomIndex, 0),
    sourceEntryCount: sourceEntries.length,
    missingAttributeIDs,
    unappliedSourceAttributeIDs,
    exactScope: exactScope || null,
  };
}

function logResolvedAbyssalWeather({
  getResolvedWeatherState,
  log,
}, contentProfile, context = {}) {
  if (!contentProfile) {
    return;
  }
  const weatherState = getResolvedWeatherState({
    contentProfile,
    weatherState: context.weatherState,
  }) || {};
  log.info(
    `[AbyssalMgr] Abyssal weather resolved char=${toInt(context.characterID, 0)} ` +
      `trace=${toInt(context.traceItemID, 0)} instance=${toInt(context.instanceID, 0)} ` +
      `type=${normalizeText(weatherState.weatherType, "unknown")} ` +
      `name="${normalizeText(weatherState.weatherName, "Unknown Weather")}" ` +
      `tier=${toInt(weatherState.tier, 1)} ` +
      `band=${normalizeText(weatherState.penaltyBandLabel, "Unknown")} ` +
      `stage=${toInt(weatherState.weatherStage, 0)} ` +
      `weatherTypeID=${toInt(weatherState.weatherTypeID, 0)} ` +
      `penaltyPct=${toInt(weatherState.penaltyStrengthPercent, toInt(weatherState.strengthPercent, 0))} ` +
      `bonusPct=${toInt(weatherState.bonusStrengthPercent, toInt(weatherState.strengthPercent, 0))} ` +
      `selectionModel=${normalizeText(weatherState.weatherSelectionModel, "n/a")} ` +
      `deterministic=${weatherState.deterministicPlaceholder === true || weatherState.deterministicPerRunSelection === true} ` +
      `bonus="${normalizeText(weatherState.bonusText, "n/a")}" ` +
      `penalty="${normalizeText(weatherState.penaltyText, "n/a")}" ` +
      `effects=${normalizeText(weatherState.appliedEffectKeys && weatherState.appliedEffectKeys.join(","), "none")} ` +
      `skipped=${normalizeText(weatherState.skippedEffectKeys && weatherState.skippedEffectKeys.join(","), "none")} ` +
      `playerEffects=${normalizeText(weatherState.playerAppliedEffectKeys && weatherState.playerAppliedEffectKeys.join(","), "none")} ` +
      `playerUnsupported=${normalizeText(weatherState.playerSkippedEffectKeys && weatherState.playerSkippedEffectKeys.join(","), "none")} ` +
      `npcEffects=${normalizeText(weatherState.npcAppliedEffectKeys && weatherState.npcAppliedEffectKeys.join(","), "none")} ` +
      `npcUnsupported=${normalizeText(weatherState.npcSkippedEffectKeys && weatherState.npcSkippedEffectKeys.join(","), "none")}`,
  );
}

function logAppliedAbyssalWeather({
  getResolvedWeatherState,
  buildRoomLogContext,
  getDependencies,
  log,
}, pocketState, applicationResult = {}, context = {}) {
  const weatherState = getResolvedWeatherState(pocketState) || {};
  const roomLogContext = buildRoomLogContext(pocketState, getDependencies(), context);
  const playerApplied = applicationResult.playerRefreshed === true &&
    applicationResult.playerDerivedEffectsVerified === true;
  const status =
    playerApplied &&
    toInt(applicationResult.pendingNpcCount, 0) <= 0
      ? "applied"
      : (
        playerApplied ||
        toInt(applicationResult.appliedNpcCount, 0) > 0
      )
        ? "partially_applied"
        : "log_only";
  log.info(
    `[AbyssalMgr] Abyssal weather ${status} char=${roomLogContext.characterID} ship=${roomLogContext.shipID} ` +
      `instance=${toInt(pocketState && pocketState.instanceID, 0)} trace=${toInt(pocketState && pocketState.traceItemID, 0)} ` +
      `type=${normalizeText(weatherState.weatherType, "unknown")} ` +
      `stage=${toInt(weatherState.weatherStage, 0)} weatherTypeID=${toInt(weatherState.weatherTypeID, 0)} ` +
      `penaltyPct=${toInt(weatherState.penaltyStrengthPercent, toInt(weatherState.strengthPercent, 0))} ` +
      `bonusPct=${toInt(weatherState.bonusStrengthPercent, toInt(weatherState.strengthPercent, 0))} ` +
      `playerEffects=${normalizeText(weatherState.playerAppliedEffectKeys && weatherState.playerAppliedEffectKeys.join(","), "none")} ` +
      `playerUnsupported=${normalizeText(applicationResult.playerUnsupportedEffectKeys && applicationResult.playerUnsupportedEffectKeys.join(","), "none")} ` +
      `npcEffects=${normalizeText(weatherState.npcAppliedEffectKeys && weatherState.npcAppliedEffectKeys.join(","), "none")} ` +
      `npcUnsupported=${normalizeText(applicationResult.npcUnsupportedEffectKeys && applicationResult.npcUnsupportedEffectKeys.join(","), "none")} ` +
      `playerModifierSourceRegistered=${applicationResult.playerModifierSourceRegistered === true} ` +
      `playerRefreshed=${applicationResult.playerRefreshed === true} ` +
      `playerDerivedVerified=${applicationResult.playerDerivedEffectsVerified === true} ` +
      `playerDerivedSourceCount=${toInt(
        applicationResult.playerDerivedVerification &&
          applicationResult.playerDerivedVerification.sourceEntryCount,
        0,
      )} ` +
      `playerDerivedRoom=${toInt(
        applicationResult.playerDerivedVerification &&
          applicationResult.playerDerivedVerification.roomIndex,
        0,
      )} ` +
      `playerDerivedScope=${normalizeText(
        applicationResult.playerDerivedVerification &&
          applicationResult.playerDerivedVerification.exactScope &&
          `${applicationResult.playerDerivedVerification.exactScope.runID}:` +
          `${applicationResult.playerDerivedVerification.exactScope.roomIndex}`,
        "none",
      )} ` +
      `playerDerivedSession=${toInt(
        applicationResult.playerDerivedVerification &&
          applicationResult.playerDerivedVerification.sessionRunID,
        0,
      )}:${toInt(
        applicationResult.playerDerivedVerification &&
          applicationResult.playerDerivedVerification.sessionRoomIndex,
        0,
      )} ` +
      `playerDerivedMissingAttributes=${normalizeText(
        applicationResult.playerDerivedVerification &&
          applicationResult.playerDerivedVerification.missingAttributeIDs &&
          applicationResult.playerDerivedVerification.missingAttributeIDs.join(","),
        "none",
      )} ` +
      `playerDerivedUnappliedSources=${normalizeText(
        applicationResult.playerDerivedVerification &&
          applicationResult.playerDerivedVerification.unappliedSourceAttributeIDs &&
          applicationResult.playerDerivedVerification.unappliedSourceAttributeIDs.join(","),
        "none",
      )} ` +
      `playerRefreshReason=${normalizeText(applicationResult.playerRefreshReason, "n/a")} ` +
      `appliedNpcCount=${toInt(applicationResult.appliedNpcCount, 0)} ` +
      `pendingNpcCount=${toInt(applicationResult.pendingNpcCount, 0)} ` +
      `pendingNpcEffects=${normalizeText(applicationResult.pendingNpcEffectKeys && applicationResult.pendingNpcEffectKeys.join(","), "none")}`,
  );
}

function applyAbyssalWeatherToRun({
  getDependencies,
  getActivePocketStateByInstanceID,
  cloneValue,
  refreshAbyssalPlayerShipWeather,
  repairActiveAbyssalNpcWeather,
  getResolvedWeatherState,
  verifyAbyssalPlayerWeatherDerivedState,
  rememberAbyssalWeatherDiagnostics,
  logAppliedAbyssalWeather,
  getCharacterID,
}, pocketState, session = null, deps = getDependencies(), options = {}) {
  const resolvedPocketState = pocketState && pocketState.instanceID
    ? getActivePocketStateByInstanceID(pocketState.instanceID) || cloneValue(pocketState)
    : null;
  if (!resolvedPocketState) {
    return {
      applied: false,
      playerRefreshed: false,
      appliedNpcCount: 0,
      pendingNpcCount: 0,
    };
  }

  const playerRefresh = options.refreshPlayerShip === false
    ? { refreshed: false }
    : refreshAbyssalPlayerShipWeather(session, deps, {
        notifyTargeting: options.emitNotifications !== false,
        notifyGenericModuleAttributes: options.emitNotifications !== false,
      });
  const npcRepair = options.applyNpcWeather === false
    ? { appliedNpcCount: 0, pendingNpcCount: 0 }
    : repairActiveAbyssalNpcWeather(resolvedPocketState, deps);
  const weatherState = getResolvedWeatherState(resolvedPocketState) || {};
  const playerDerivedVerification = playerRefresh.refreshed === true
    ? verifyAbyssalPlayerWeatherDerivedState(resolvedPocketState, session, deps)
    : {
        verified: false,
        sourceEntryCount: 0,
        missingAttributeIDs: [],
        unappliedSourceAttributeIDs: [],
      };
  const npcUnsupportedEffectKeys = [
    ...new Set([
      ...(Array.isArray(weatherState.npcSkippedEffectKeys) ? weatherState.npcSkippedEffectKeys : []),
      ...(Array.isArray(npcRepair.pendingEffectKeys) ? npcRepair.pendingEffectKeys : []),
    ].filter(Boolean)),
  ];
  const result = {
    applied: playerRefresh.refreshed === true || npcRepair.appliedNpcCount > 0,
    playerRefreshed: playerRefresh.refreshed === true,
    playerRefreshReason: normalizeText(playerRefresh.reason, "UNKNOWN"),
    playerModifierSourceRegistered:
      Boolean(
        playerRefresh &&
        playerRefresh.diagnostics &&
        playerRefresh.diagnostics.modifierSourceRegistered,
      ),
    playerDerivedEffectsVerified: playerDerivedVerification.verified === true,
    playerDerivedVerification,
    playerUnsupportedEffectKeys: Array.isArray(weatherState.playerSkippedEffectKeys)
      ? cloneValue(weatherState.playerSkippedEffectKeys)
      : [],
    appliedNpcCount: npcRepair.appliedNpcCount,
    pendingNpcCount: npcRepair.pendingNpcCount,
    pendingNpcEffectKeys: Array.isArray(npcRepair.pendingEffectKeys)
      ? cloneValue(npcRepair.pendingEffectKeys)
      : [],
    npcUnsupportedEffectKeys,
  };
  rememberAbyssalWeatherDiagnostics(resolvedPocketState, weatherState, result, deps);
  logAppliedAbyssalWeather(resolvedPocketState, result, {
    characterID: getCharacterID(session),
    shipID: toInt(
      session && session._space && session._space.shipID,
      toInt(session && (session.shipID || session.shipid || session.activeShipID), 0),
    ),
    reason: normalizeText(options.reason, "runtime-refresh"),
  });
  return result;
}

function isAbyssalWeatherApplicationReady({}, applicationResult) {
  return Boolean(
    applicationResult &&
    applicationResult.playerModifierSourceRegistered === true &&
    applicationResult.playerRefreshed === true &&
    applicationResult.playerDerivedEffectsVerified === true &&
    toInt(applicationResult.pendingNpcCount, 0) === 0
  );
}

function resolveAbyssalWeatherRemovalRuntimeSession({
  getDependencies,
  getCharacterID,
},
  pocketState,
  explicitSession = null,
  deps = getDependencies(),
) {
  const expectedShipID = toInt(pocketState && pocketState.shipID, 0);
  const expectedCharacterID = toInt(pocketState && pocketState.characterID, 0);
  const expectedSystemID = toInt(pocketState && pocketState.sourceSolarSystemID, 0);
  const shipItem =
    expectedShipID > 0 && typeof deps.findItemById === "function"
      ? deps.findItemById(expectedShipID)
      : null;
  const shipSystemID = toInt(
    shipItem && shipItem.spaceState && shipItem.spaceState.systemID,
    toInt(shipItem && shipItem.locationID, 0),
  );
  const shipOwnerID = toInt(shipItem && shipItem.ownerID, 0);
  const runtime = deps;
  if (
    !runtime ||
    typeof runtime.getSceneForSession !== "function" ||
    expectedShipID <= 0 ||
    expectedCharacterID <= 0 ||
    expectedSystemID <= 0 ||
    !shipItem ||
    shipSystemID !== expectedSystemID ||
    (shipOwnerID > 0 && shipOwnerID !== expectedCharacterID)
  ) {
    return null;
  }

  const resolveExactCandidate = (candidate, source) => {
    const candidateShipID = toInt(
      candidate && candidate._space && candidate._space.shipID,
      toInt(candidate && (candidate.shipID || candidate.shipid), 0),
    );
    const candidateSystemID = toInt(
      candidate && candidate._space && candidate._space.systemID,
      toInt(candidate && (candidate.solarsystemid2 || candidate.solarsystemid), 0),
    );
    if (
      !candidate ||
      getCharacterID(candidate) !== expectedCharacterID ||
      candidateShipID !== expectedShipID ||
      candidateSystemID !== expectedSystemID
    ) {
      return null;
    }
    const scene = runtime.getSceneForSession(candidate);
    const shipEntity =
      scene && typeof scene.getShipEntityForSession === "function"
        ? scene.getShipEntityForSession(candidate)
        : null;
    if (!shipEntity || toInt(shipEntity.itemID, 0) !== expectedShipID) {
      return null;
    }
    return {
      session: candidate,
      source,
    };
  };

  const explicitResult = resolveExactCandidate(explicitSession, "explicit");
  if (explicitResult) {
    return explicitResult;
  }
  const sessionRegistry = deps;
  const registeredSession =
    sessionRegistry && typeof sessionRegistry.findSessionByCharacterID === "function"
      ? sessionRegistry.findSessionByCharacterID(expectedCharacterID)
      : null;
  const registeredResult = resolveExactCandidate(registeredSession, "registry");
  if (registeredResult) {
    return registeredResult;
  }

  const sceneKey = normalizeText(
    shipItem && shipItem.spaceState && shipItem.spaceState.sceneKey,
    `solar-system:${expectedSystemID}`,
  );
  return resolveExactCandidate(
    {
      characterID: expectedCharacterID,
      shipID: expectedShipID,
      solarsystemid: expectedSystemID,
      solarsystemid2: expectedSystemID,
      spaceSceneKey: sceneKey,
      _abyssalWeatherRemovalSurrogate: true,
      _space: {
        shipID: expectedShipID,
        systemID: expectedSystemID,
        locationID: expectedSystemID,
        sceneKey,
      },
    },
    "runtime-surrogate",
  );
}

function verifyAbyssalPlayerWeatherRemoval({
  getDependencies,
  collectAbyssalShipAttributeModifierEntriesForShipID,
  collectAbyssalLocationModifierSourcesForShipID,
  getEntityPassiveAttributeMap,
  ABYSSAL_PLAYER_ATTRIBUTE_SOURCE_KEY,
  getCharacterID,
  isExactAbyssalWeatherRemovalClaim,
},
  pocketState,
  session,
  refreshResult,
  deps = getDependencies(),
) {
  const runtime = deps;
  const expectedShipID = toInt(pocketState && pocketState.shipID, 0);
  const sessionShipID = toInt(
    session && session._space && session._space.shipID,
    toInt(session && (session.shipID || session.shipid), 0),
  );
  const scene = runtime && session && typeof runtime.getSceneForSession === "function"
    ? runtime.getSceneForSession(session)
    : null;
  const shipEntity = scene && typeof scene.getShipEntityForSession === "function"
    ? scene.getShipEntityForSession(session)
    : null;
  const directSources = expectedShipID > 0
    ? collectAbyssalShipAttributeModifierEntriesForShipID(expectedShipID)
    : [];
  const locationSources = expectedShipID > 0
    ? collectAbyssalLocationModifierSourcesForShipID(expectedShipID)
    : [];
  const attributeMap = getEntityPassiveAttributeMap(shipEntity);
  const appliedAttributeModifierEntries =
    shipEntity &&
    shipEntity.passiveDerivedState &&
    Array.isArray(shipEntity.passiveDerivedState.appliedAttributeModifierEntries)
      ? shipEntity.passiveDerivedState.appliedAttributeModifierEntries
      : [];
  const staleAppliedSourceAttributeIDs = [...new Set(appliedAttributeModifierEntries
    .filter((entry) =>
      normalizeText(entry && entry.modifierSourceKey, "") ===
        ABYSSAL_PLAYER_ATTRIBUTE_SOURCE_KEY
    )
    .map((entry) => toInt(entry && entry.modifiedAttributeID, 0))
    .filter((attributeID) => attributeID > 0))];
  const exactIdentity = Boolean(
    expectedShipID > 0 &&
    sessionShipID === expectedShipID &&
    shipEntity &&
    toInt(shipEntity.itemID, 0) === expectedShipID &&
    session &&
    getCharacterID(session) === toInt(pocketState && pocketState.characterID, 0)
  );
  const expectedShipPresented = Boolean(
    shipEntity && toInt(shipEntity.itemID, 0) === expectedShipID,
  );
  // A ship nobody presents any more, with no modifier source left on its
  // item, has nothing to refresh: the pilot's hull or capsule died in the run,
  // or the ship sits docked. The next load derives it from the clean item.
  // The claim still has to be the pilot's own ship, or a ship that is gone.
  const expectedShipItem = expectedShipID > 0 && typeof runtime.findItemById === "function"
    ? runtime.findItemById(expectedShipID)
    : null;
  const expectedShipOwnedOrGone = !expectedShipItem ||
    toInt(expectedShipItem.ownerID, 0) === toInt(pocketState && pocketState.characterID, 0);
  const verifiedWithoutPresentation = Boolean(
    isExactAbyssalWeatherRemovalClaim(pocketState) &&
    !expectedShipPresented &&
    expectedShipOwnedOrGone &&
    directSources.length === 0 &&
    locationSources.length === 0
  );
  const verified = verifiedWithoutPresentation || Boolean(
    isExactAbyssalWeatherRemovalClaim(pocketState) &&
    refreshResult &&
    refreshResult.refreshed === true &&
    exactIdentity &&
    directSources.length === 0 &&
    locationSources.length === 0 &&
    attributeMap &&
    staleAppliedSourceAttributeIDs.length === 0
  );
  return {
    verified,
    verifiedWithoutPresentation,
    exactIdentity,
    expectedShipID,
    sessionShipID,
    shipEntityPresent: Boolean(shipEntity),
    directSourceCount: directSources.length,
    locationSourceCount: locationSources.length,
    derivedAttributeCount: attributeMap ? Object.keys(attributeMap).length : 0,
    staleAppliedSourceAttributeIDs,
  };
}

function removeAbyssalWeatherFromRun({
  getDependencies,
  isExactAbyssalWeatherRemovalClaim,
  resolveAbyssalWeatherRemovalRuntimeSession,
  refreshAbyssalPlayerShipWeather,
  verifyAbyssalPlayerWeatherRemoval,
  log,
}, pocketState, session = null, deps = getDependencies(), options = {}) {
  const exactRemovalClaim = isExactAbyssalWeatherRemovalClaim(pocketState);
  const removalRuntimeSession = exactRemovalClaim
    ? resolveAbyssalWeatherRemovalRuntimeSession(pocketState, session, deps)
    : null;
  const refreshResult = exactRemovalClaim && removalRuntimeSession
    ? refreshAbyssalPlayerShipWeather(removalRuntimeSession.session, deps, {
        broadcast:
          removalRuntimeSession.source === "runtime-surrogate"
            ? false
            : options.broadcast !== false,
      })
    : {
        refreshed: false,
        reason: exactRemovalClaim
          ? "NO_EXACT_KSPACE_RUNTIME_SHIP"
          : "WEATHER_REMOVAL_NOT_STAGED",
      };
  const verification = verifyAbyssalPlayerWeatherRemoval(
    pocketState,
    removalRuntimeSession && removalRuntimeSession.session,
    refreshResult,
    deps,
  );
  log.info(
    `[AbyssalMgr] Abyssal weather ${verification.verified ? "removed" : "removal pending"} char=${toInt(pocketState && pocketState.characterID, 0)} ` +
      `ship=${toInt(pocketState && pocketState.shipID, 0)} instance=${toInt(pocketState && pocketState.instanceID, 0)} ` +
      `trace=${toInt(pocketState && pocketState.traceItemID, 0)} refreshed=${refreshResult.refreshed === true} ` +
      `verified=${verification.verified === true} directSources=${verification.directSourceCount} ` +
      `locationSources=${verification.locationSourceCount} refreshReason=${normalizeText(refreshResult.reason, "UNKNOWN")} ` +
      `reason=${normalizeText(options.reason, "cleanup")}`,
  );
  return {
    ...refreshResult,
    verified: verification.verified === true,
    verification,
    runtimeSessionSource: normalizeText(
      removalRuntimeSession && removalRuntimeSession.source,
      "none",
    ),
  };
}

// Capture supplied capabilities once, as the original closure did. Internal
// callbacks are bound once per instance; no runtime state lives in this wiring.
function createAbyssalWeatherRuntime({
  getDependencies,
  cloneValue,
  normalizeLowerText,
  getActivePocketStateForShipID,
  getResolvedWeatherState,
  resolveExactAbyssalRunRoomScope,
  getActivePocketStateByInstanceID,
  buildPlaceholderRoomState,
  isRetainedAbyssalPlayerCompanion,
  inspectAbyssalPlayerCreatedObjectAuthority,
  ABYSSAL_PLAYER_ATTRIBUTE_SOURCE_KEY,
  seedMissingAbyssalResonanceBaseAttributes,
  applyModifierGroups,
  ATTRIBUTE_MAX_VELOCITY,
  ATTRIBUTE_SCAN_RESOLUTION,
  ATTRIBUTE_CAPACITOR_RECHARGE_RATE,
  ATTRIBUTE_SHIELD_CAPACITY,
  ATTRIBUTE_ARMOR_HP,
  ABYSSAL_WEATHER_SHIP_ATTRIBUTE_NAME_TO_ID,
  repairAppliedAbyssalResonanceAttributes,
  getPocketScene,
  listPocketHostileEntityIDs,
  getEntityPassiveAttributeMap,
  log,
  buildRoomLogContext,
  rememberAbyssalWeatherDiagnostics,
  getCharacterID,
}) {

  const ports = {
    getDependencies,
    cloneValue,
    normalizeLowerText,
    getActivePocketStateForShipID,
    getResolvedWeatherState,
    resolveExactAbyssalRunRoomScope,
    getActivePocketStateByInstanceID,
    buildPlaceholderRoomState,
    isRetainedAbyssalPlayerCompanion,
    inspectAbyssalPlayerCreatedObjectAuthority,
    ABYSSAL_PLAYER_ATTRIBUTE_SOURCE_KEY,
    seedMissingAbyssalResonanceBaseAttributes,
    applyModifierGroups,
    ATTRIBUTE_MAX_VELOCITY,
    ATTRIBUTE_SCAN_RESOLUTION,
    ATTRIBUTE_CAPACITOR_RECHARGE_RATE,
    ATTRIBUTE_SHIELD_CAPACITY,
    ATTRIBUTE_ARMOR_HP,
    ABYSSAL_WEATHER_SHIP_ATTRIBUTE_NAME_TO_ID,
    repairAppliedAbyssalResonanceAttributes,
    getPocketScene,
    listPocketHostileEntityIDs,
    getEntityPassiveAttributeMap,
    log,
    buildRoomLogContext,
    rememberAbyssalWeatherDiagnostics,
    getCharacterID,
  };
  ports.getAbyssalWeatherRemovalState = getAbyssalWeatherRemovalState.bind(null, ports);
  ports.isExactAbyssalWeatherRemovalClaim = isExactAbyssalWeatherRemovalClaim.bind(null, ports);
  ports.getActiveWeatherStateForShipID = getActiveWeatherStateForShipID.bind(null, ports);
  ports.resolveExactAbyssalWeatherContextForEntity = resolveExactAbyssalWeatherContextForEntity.bind(null, ports);
  ports.getActiveWeatherStateForEntity = getActiveWeatherStateForEntity.bind(null, ports);
  ports.collectAbyssalShipAttributeModifierEntriesForShipID = collectAbyssalShipAttributeModifierEntriesForShipID.bind(null, ports);
  ports.collectAbyssalNpcShipAttributeModifierEntriesForEntity = collectAbyssalNpcShipAttributeModifierEntriesForEntity.bind(null, ports);
  ports.collectAbyssalLocationModifierSourcesForShipID = collectAbyssalLocationModifierSourcesForShipID.bind(null, ports);
  ports.collectAbyssalLocationModifierSourcesForEntity = collectAbyssalLocationModifierSourcesForEntity.bind(null, ports);
  ports.captureNpcWeatherBaseState = captureNpcWeatherBaseState.bind(null, ports);
  ports.applyNpcWeatherSummaryField = applyNpcWeatherSummaryField.bind(null, ports);
  ports.applyNpcWeatherAttributeSummaries = applyNpcWeatherAttributeSummaries.bind(null, ports);
  ports.applyAbyssalWeatherToNpcEntity = applyAbyssalWeatherToNpcEntity.bind(null, ports);
  ports.refreshAbyssalPlayerShipWeather = refreshAbyssalPlayerShipWeather.bind(null, ports);
  ports.repairActiveAbyssalNpcWeather = repairActiveAbyssalNpcWeather.bind(null, ports);
  ports.buildAbyssalWeatherModifierEntrySignature = buildAbyssalWeatherModifierEntrySignature.bind(null, ports);
  ports.findUnappliedAbyssalWeatherSourceAttributeIDs = findUnappliedAbyssalWeatherSourceAttributeIDs.bind(null, ports);
  ports.verifyAbyssalPlayerWeatherDerivedState = verifyAbyssalPlayerWeatherDerivedState.bind(null, ports);
  ports.logResolvedAbyssalWeather = logResolvedAbyssalWeather.bind(null, ports);
  ports.logAppliedAbyssalWeather = logAppliedAbyssalWeather.bind(null, ports);
  ports.applyAbyssalWeatherToRun = applyAbyssalWeatherToRun.bind(null, ports);
  ports.isAbyssalWeatherApplicationReady = isAbyssalWeatherApplicationReady.bind(null, ports);
  ports.resolveAbyssalWeatherRemovalRuntimeSession = resolveAbyssalWeatherRemovalRuntimeSession.bind(null, ports);
  ports.verifyAbyssalPlayerWeatherRemoval = verifyAbyssalPlayerWeatherRemoval.bind(null, ports);
  ports.removeAbyssalWeatherFromRun = removeAbyssalWeatherFromRun.bind(null, ports);
  Object.freeze(ports);
  return Object.freeze({
    getAbyssalWeatherRemovalState: ports.getAbyssalWeatherRemovalState,
    isExactAbyssalWeatherRemovalClaim: ports.isExactAbyssalWeatherRemovalClaim,
    getActiveWeatherStateForShipID: ports.getActiveWeatherStateForShipID,
    resolveExactAbyssalWeatherContextForEntity: ports.resolveExactAbyssalWeatherContextForEntity,
    getActiveWeatherStateForEntity: ports.getActiveWeatherStateForEntity,
    collectAbyssalShipAttributeModifierEntriesForShipID: ports.collectAbyssalShipAttributeModifierEntriesForShipID,
    collectAbyssalNpcShipAttributeModifierEntriesForEntity: ports.collectAbyssalNpcShipAttributeModifierEntriesForEntity,
    collectAbyssalLocationModifierSourcesForShipID: ports.collectAbyssalLocationModifierSourcesForShipID,
    collectAbyssalLocationModifierSourcesForEntity: ports.collectAbyssalLocationModifierSourcesForEntity,
    captureNpcWeatherBaseState: ports.captureNpcWeatherBaseState,
    applyNpcWeatherSummaryField: ports.applyNpcWeatherSummaryField,
    applyAbyssalWeatherToNpcEntity: ports.applyAbyssalWeatherToNpcEntity,
    refreshAbyssalPlayerShipWeather: ports.refreshAbyssalPlayerShipWeather,
    repairActiveAbyssalNpcWeather: ports.repairActiveAbyssalNpcWeather,
    buildAbyssalWeatherModifierEntrySignature: ports.buildAbyssalWeatherModifierEntrySignature,
    findUnappliedAbyssalWeatherSourceAttributeIDs: ports.findUnappliedAbyssalWeatherSourceAttributeIDs,
    verifyAbyssalPlayerWeatherDerivedState: ports.verifyAbyssalPlayerWeatherDerivedState,
    logResolvedAbyssalWeather: ports.logResolvedAbyssalWeather,
    logAppliedAbyssalWeather: ports.logAppliedAbyssalWeather,
    applyAbyssalWeatherToRun: ports.applyAbyssalWeatherToRun,
    isAbyssalWeatherApplicationReady: ports.isAbyssalWeatherApplicationReady,
    resolveAbyssalWeatherRemovalRuntimeSession: ports.resolveAbyssalWeatherRemovalRuntimeSession,
    verifyAbyssalPlayerWeatherRemoval: ports.verifyAbyssalPlayerWeatherRemoval,
    removeAbyssalWeatherFromRun: ports.removeAbyssalWeatherFromRun,
  });
}

module.exports = { createAbyssalWeatherRuntime };
