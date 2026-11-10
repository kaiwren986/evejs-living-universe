"use strict";

const { toInt, normalizeText, getObjectPosition, getVectorDistance, formatVectorForLog } = require("../domain/abyssalRuntimeValues");

function buildAbyssalWeatherDiagnostics(ports, weatherState = {}, applicationResult = {}, deps = ports.getDependencies()) {
  const {
    cloneValue,
    ABYSSAL_PLAYER_ATTRIBUTE_SOURCE_KEY,
    ABYSSAL_PLAYER_LOCATION_SOURCE_KEY,
  } = ports;
  return {
    lastAppliedAtMs: toInt(deps.now(), 0),
    playerRefreshed: applicationResult.playerRefreshed === true,
    playerRefreshReason: normalizeText(applicationResult.playerRefreshReason, "UNKNOWN"),
    playerModifierSourceRegistered: applicationResult.playerModifierSourceRegistered === true,
    playerUnsupportedEffectKeys: cloneValue(applicationResult.playerUnsupportedEffectKeys) || [],
    npcUnsupportedEffectKeys: cloneValue(applicationResult.npcUnsupportedEffectKeys) || [],
    appliedNpcCount: toInt(applicationResult.appliedNpcCount, 0),
    pendingNpcCount: toInt(applicationResult.pendingNpcCount, 0),
    pendingNpcEffectKeys: cloneValue(applicationResult.pendingNpcEffectKeys) || [],
    selectedPlayerAttributeSourceKey:
      Array.isArray(weatherState.playerShipAttributeModifierEntries) &&
        weatherState.playerShipAttributeModifierEntries.length > 0
        ? ABYSSAL_PLAYER_ATTRIBUTE_SOURCE_KEY
        : "none",
    selectedPlayerLocationSourceKey:
      Array.isArray(weatherState.playerLocationModifierSources) &&
        weatherState.playerLocationModifierSources.length > 0
        ? ABYSSAL_PLAYER_LOCATION_SOURCE_KEY
        : "none",
    cleanupExpected: true,
  };
}

function rememberAbyssalWeatherDiagnostics(ports,
  pocketState,
  weatherState = {},
  applicationResult = {},
  deps = ports.getDependencies(),
) {
  const {
    getActivePocketStateByInstanceID,
    cloneValue,
    registerPocketBestEffort,
  } = ports;
  if (!pocketState || toInt(pocketState.instanceID, 0) <= 0) {
    return pocketState;
  }
  const currentPocketState =
    getActivePocketStateByInstanceID(toInt(pocketState.instanceID, 0)) ||
    cloneValue(pocketState);
  const nextPocketState = {
    ...cloneValue(currentPocketState),
    weatherDiagnostics: buildAbyssalWeatherDiagnostics(ports, weatherState, applicationResult, deps),
  };
  const result = registerPocketBestEffort(nextPocketState, deps);
  return cloneValue(result && result.state) || nextPocketState;
}

function getEntityPassiveAttributeMap(ports, entity) {
  return entity &&
    entity.passiveDerivedState &&
    entity.passiveDerivedState.attributes &&
    typeof entity.passiveDerivedState.attributes === "object"
    ? entity.passiveDerivedState.attributes
    : null;
}

function readEntityMetric(ports, entity, options = {}) {
  const runtimeFields = Array.isArray(options.runtimeFields)
    ? options.runtimeFields
    : [];
  for (const runtimeField of runtimeFields) {
    const runtimeValue = Number(entity && entity[runtimeField]);
    if (Number.isFinite(runtimeValue)) {
      return {
        available: true,
        value: runtimeValue,
        source: `runtime.${runtimeField}`,
      };
    }
    const passiveRuntimeValue = Number(
      entity &&
        entity.passiveDerivedState &&
        entity.passiveDerivedState[runtimeField],
    );
    if (Number.isFinite(passiveRuntimeValue)) {
      return {
        available: true,
        value: passiveRuntimeValue,
        source: `passiveDerivedState.${runtimeField}`,
      };
    }
  }
  const attributeID = toInt(options.attributeID, 0);
  const attributeMap = getEntityPassiveAttributeMap(ports, entity);
  if (attributeID > 0 && attributeMap) {
    const attributeValue = Number(attributeMap[String(attributeID)]);
    if (Number.isFinite(attributeValue)) {
      return {
        available: true,
        value: attributeValue,
        source: `passiveDerived.attributes[${attributeID}]`,
      };
    }
  }
  return {
    available: false,
    reason: normalizeText(options.unavailableReason, "MISSING_RUNTIME_VALUE"),
  };
}

function formatAbyssalMetricValue(ports, value, digits = 3) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return "unavailable";
  }
  const rounded = Number(numeric.toFixed(digits));
  return Number.isInteger(rounded) ? String(rounded) : String(rounded);
}

function formatMetricReading(ports, label, reading, units = "") {
  if (!reading || reading.available !== true) {
    return `${label}: unavailable (${normalizeText(reading && reading.reason, "MISSING_RUNTIME_VALUE")})`;
  }
  return `${label}: ${formatAbyssalMetricValue(ports, reading.value)}${units} [${normalizeText(reading.source, "runtime")}]`;
}

function formatResistancePctFromResonance(ports, resonanceValue) {
  const numeric = Number(resonanceValue);
  if (!Number.isFinite(numeric)) {
    return "unavailable";
  }
  return `${formatAbyssalMetricValue(ports, (1 - numeric) * 100, 2)}%`;
}

function buildResistanceLine(ports, entity, layerLabel, damageLabel, attributeID) {
  const reading = readEntityMetric(ports, entity, {
    attributeID,
    unavailableReason: "ATTRIBUTE_NOT_PRESENT",
  });
  if (reading.available !== true) {
    return `${layerLabel} ${damageLabel}: unavailable (${normalizeText(reading.reason, "ATTRIBUTE_NOT_PRESENT")})`;
  }
  return `${layerLabel} ${damageLabel}: resonance=${formatAbyssalMetricValue(ports, reading.value, 3)} resistancePct=${formatResistancePctFromResonance(ports, reading.value)} [${normalizeText(reading.source, "runtime")}]`;
}

function buildPlayerTurretModifierLines(ports, weatherState = {}) {
  const {
    resolveAbyssalWeatherModifierPercent,
  } = ports;
  const lines = [];
  const descriptors = Array.isArray(weatherState.effectDescriptors)
    ? weatherState.effectDescriptors
    : [];
  for (const effectDescriptor of descriptors) {
    if (normalizeText(effectDescriptor && effectDescriptor.effectType, "") !== "module_location_attribute") {
      continue;
    }
    const attributeNames = Array.isArray(effectDescriptor && effectDescriptor.attributeNames)
      ? effectDescriptor.attributeNames
      : [];
    const modifierPercent = resolveAbyssalWeatherModifierPercent(
      effectDescriptor,
      weatherState,
    );
    for (const attributeName of attributeNames) {
      const normalizedAttributeName = normalizeText(attributeName, "");
      if (normalizedAttributeName === "maxRange") {
        lines.push(
          `turret optimal modifierPct: ${formatAbyssalMetricValue(ports, modifierPercent, 0)} [weather source modifier]`,
        );
      } else if (normalizedAttributeName === "falloff") {
        lines.push(
          `turret falloff modifierPct: ${formatAbyssalMetricValue(ports, modifierPercent, 0)} [weather source modifier]`,
        );
      }
    }
  }
  if (lines.length <= 0) {
    lines.push("turret optimal modifierPct: unavailable (NO_TURRET_WEATHER_MODIFIER)");
    lines.push("turret falloff modifierPct: unavailable (NO_TURRET_WEATHER_MODIFIER)");
  }
  return lines;
}

function buildAbyssalTraceStatusLines(ports, session, pocketState = null, deps = ports.getDependencies()) {
  const {
    getCharacterID,
    readTraceStateFromItem,
    getReadOnlySolarSystemScene,
  } = ports;
  const characterID = getCharacterID(session);
  const traceItemID = toInt(
    pocketState && pocketState.sourceTraceItemID,
    toInt(pocketState && pocketState.traceItemID, ports.getTraceIDForCharacter(characterID) || 0),
  );
  const cachedTraceState = traceItemID > 0
    ? ports.getTrace(traceItemID) || null
    : [...ports.listTraces()].find((state) => (
        toInt(state && state.characterID, 0) === characterID
      )) || null;
  const resolvedTraceItemID = toInt(cachedTraceState && cachedTraceState.traceItemID, traceItemID);
  const item = resolvedTraceItemID > 0 && typeof deps.findItemById === "function"
    ? deps.findItemById(resolvedTraceItemID)
    : null;
  const traceState = cachedTraceState || readTraceStateFromItem(item);
  const sourceSystemID = toInt(
    traceState && traceState.sourceSolarSystemID,
    toInt(traceState && traceState.solarSystemID, 0),
  );
  const runtime = deps;
  const sourceScene = getReadOnlySolarSystemScene(runtime, sourceSystemID);
  const runtimeEntity = sourceScene && typeof sourceScene.getEntityByID === "function"
    ? sourceScene.getEntityByID(resolvedTraceItemID)
    : null;
  const anchorPosition = getObjectPosition(traceState && traceState.sourceTracePosition);
  const currentPosition = getObjectPosition(runtimeEntity) || getObjectPosition(item && item.spaceState);
  const distanceFromAnchor = anchorPosition && currentPosition
    ? getVectorDistance(anchorPosition, currentPosition)
    : 0;
  const schedule = ports.getTraceRemovalSchedule(resolvedTraceItemID) || null;
  const expectedRunID = toInt(pocketState && pocketState.instanceID, toInt(traceState && traceState.abyssalRunID, 0));
  const ownershipRunMatch = Boolean(
    traceState &&
      toInt(traceState.characterID, 0) === characterID &&
      (
        expectedRunID <= 0 ||
        toInt(traceState.abyssalRunID, 0) === expectedRunID
      )
  );
  return [
    "Trace:",
    `  item/entity ID: ${resolvedTraceItemID}`,
    `  source system: ${sourceSystemID}`,
    `  source scene key: ${normalizeText(traceState && traceState.sourceSceneKey, "none")}`,
    `  profile ID: ${normalizeText(traceState && traceState.traceProfileID, "none")}`,
    `  lifecycle phase: ${normalizeText(traceState && traceState.lifecyclePhase, "none")}`,
    `  activation state: ${toInt(traceState && traceState.activationState, 0)}`,
    `  position: ${formatVectorForLog(currentPosition)}`,
    `  distance from recorded source position: ${distanceFromAnchor.toFixed(3)}`,
    `  runtime entity present: ${Boolean(runtimeEntity)}`,
    `  inventory item present: ${Boolean(item)}`,
    `  removal scheduled: ${Boolean(schedule || traceState && traceState.removalScheduled === true)}`,
    `  removal deadline: ${toInt(schedule && schedule.deadlineMs, toInt(traceState && traceState.removalDeadlineMs, 0))}`,
    `  ownership/run match: ${ownershipRunMatch}`,
  ];
}

function createAbyssalRuntimeDiagnostics(ports) {
  return {
    buildAbyssalWeatherDiagnostics: buildAbyssalWeatherDiagnostics.bind(null, ports),
    rememberAbyssalWeatherDiagnostics: rememberAbyssalWeatherDiagnostics.bind(null, ports),
    getEntityPassiveAttributeMap: getEntityPassiveAttributeMap.bind(null, ports),
    readEntityMetric: readEntityMetric.bind(null, ports),
    formatAbyssalMetricValue: formatAbyssalMetricValue.bind(null, ports),
    formatMetricReading: formatMetricReading.bind(null, ports),
    formatResistancePctFromResonance: formatResistancePctFromResonance.bind(null, ports),
    buildResistanceLine: buildResistanceLine.bind(null, ports),
    buildPlayerTurretModifierLines: buildPlayerTurretModifierLines.bind(null, ports),
    buildAbyssalTraceStatusLines: buildAbyssalTraceStatusLines.bind(null, ports),
  };
}

module.exports = { createAbyssalRuntimeDiagnostics };
