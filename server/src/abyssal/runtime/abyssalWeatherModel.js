"use strict";

const { normalizeText } = require("../domain/abyssalValueUtils");

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

// Weather selection/state projection and Dogma modifier descriptions. Engine
// application and run authority are separate; catalog/value policies are explicit.
function getWeatherProfile({
  getContentProfile,
  cloneValue,
}, source) {
  const contentProfile = getContentProfile(source) || source;
  return contentProfile && contentProfile.weatherProfile && typeof contentProfile.weatherProfile === "object"
    ? cloneValue(contentProfile.weatherProfile)
    : null;
}

function getStoredWeatherState({
  cloneValue,
}, source) {
  return source && source.weatherState && typeof source.weatherState === "object"
    ? cloneValue(source.weatherState)
    : null;
}

function cloneWeatherEffectDescriptors({
  getWeatherProfile,
  cloneValue,
}, source) {
  const weatherProfile = getWeatherProfile(source) || {};
  return Array.isArray(weatherProfile.effectDescriptors)
    ? cloneValue(weatherProfile.effectDescriptors)
    : [];
}

function resolveAbyssalWeatherStrengthSelection({
  normalizeLowerText,
  resolveDarkWeatherSelection,
  ABYSSAL_WEATHER_PRESENTATION_STAGES_BY_TYPE,
}, source, overrides = {}) {
  const tier = Math.max(0, toInt(source && source.tier, 1));
  const weatherType = normalizeLowerText(source && source.weatherType, "unknown");
  const strengthSelection = resolveDarkWeatherSelection({
    tier,
    filamentTypeID: toInt(source && source.filamentTypeID, 0),
    definitionID: normalizeText(source && source.definitionID, ""),
    traceItemID: toInt(overrides && overrides.traceItemID, 0),
    runID: toInt(overrides && (overrides.runID || overrides.instanceID), 0),
    selectionSeed:
      overrides && (overrides.weatherSelectionSeed ?? overrides.selectionSeed),
    weatherStage: toInt(overrides && overrides.weatherStage, 0),
  });
  if (weatherType === "dark") {
    return {
      ...strengthSelection,
      weatherType,
    };
  }
  const strengthPercent = tier <= 3 ? 30 : 50;
  const authoredWeatherBallTypeID = toInt(
    source && source.authoredWeatherBallTypeID,
    0,
  );
  if (
    authoredWeatherBallTypeID > 0 &&
    tier !== 0 &&
    source && source.tier1AbyssalSpaceTelemetryEnabled !== true &&
    source.tier2AbyssalSpaceTelemetryEnabled !== true &&
    source.tier3AbyssalSpaceTelemetryEnabled !== true &&
    source.tier4AbyssalSpaceTelemetryEnabled !== true &&
    source.tier5AbyssalSpaceTelemetryEnabled !== true &&
    source.tier6AbyssalSpaceTelemetryEnabled !== true
  ) {
    return {
      weatherType,
      tier,
      stage: 0,
      typeID: authoredWeatherBallTypeID,
      name: normalizeText(source && source.weatherName, ""),
      selectionSeed: 0,
      selectionModel: "retail-derived-authored-presentation",
      allowedStages: [],
      penaltyPercent: strengthPercent,
      bonusPercent: 50,
    };
  }
  const presentation = (
    ABYSSAL_WEATHER_PRESENTATION_STAGES_BY_TYPE[weatherType] || []
  ).find((entry) => toInt(entry && entry.stage, 0) === strengthSelection.stage);
  return {
    ...strengthSelection,
    weatherType,
    typeID: toInt(presentation && presentation.typeID, 0),
    name: normalizeText(presentation && presentation.name, ""),
  };
}

function resolveDeterministicAbyssalWeatherStrengthPercent({
  resolveAbyssalWeatherStrengthSelection,
}, source, overrides = {}) {
  return toInt(
    resolveAbyssalWeatherStrengthSelection(source, overrides).penaltyPercent,
    0,
  );
}

function resolveAbyssalWeatherStrengthBandKey({
  resolveAbyssalWeatherStrengthSelection,
  normalizeLowerText,
}, source, selection = null) {
  const resolvedSelection = selection ||
    resolveAbyssalWeatherStrengthSelection(source);
  return `${normalizeLowerText(resolvedSelection && resolvedSelection.weatherType, "unknown")}_` +
    `stage_${toInt(resolvedSelection.stage, 0)}_` +
    `penalty_${toInt(resolvedSelection.penaltyPercent, 0)}_` +
    `bonus_${toInt(resolvedSelection.bonusPercent, 0)}`;
}

function buildAbyssalWeatherDirectModifierEntry({
  DOGMA_OP_POST_PERCENT,
}, attributeID, percentValue) {
  return {
    modifiedAttributeID: toInt(attributeID, 0),
    operation: DOGMA_OP_POST_PERCENT,
    value: Number(percentValue) || 0,
    stackingPenalized: false,
  };
}

function resolveAbyssalWeatherModifierPercent({}, effectDescriptor = {}, weatherStrength = 0) {
  const fallbackStrength = typeof weatherStrength === "object"
    ? toInt(weatherStrength && weatherStrength.strengthPercent, 0)
    : toInt(weatherStrength, 0);
  const penaltyStrength = Math.max(
    0,
    typeof weatherStrength === "object"
      ? toInt(weatherStrength && weatherStrength.penaltyStrengthPercent, fallbackStrength)
      : fallbackStrength,
  );
  const bonusStrength = Math.max(
    0,
    typeof weatherStrength === "object"
      ? toInt(weatherStrength && weatherStrength.bonusStrengthPercent, fallbackStrength)
      : fallbackStrength,
  );
  const strengthRole = normalizeText(effectDescriptor && effectDescriptor.strengthRole, "bonus");
  if (strengthRole === "bonus_inverted") {
    return -bonusStrength;
  }
  return strengthRole === "penalty"
    ? penaltyStrength
    : bonusStrength;
}

function buildAbyssalWeatherShipAttributeModifierEntries({
  resolveAbyssalWeatherModifierPercent,
  ABYSSAL_WEATHER_SHIP_ATTRIBUTE_NAME_TO_ID,
  buildAbyssalWeatherDirectModifierEntry,
}, weatherState, targetKind = "player") {
  const descriptors = Array.isArray(weatherState && weatherState.effectDescriptors)
    ? weatherState.effectDescriptors
    : [];
  const supportedEntries = [];
  const appliedEffectKeys = [];
  const skippedEffectKeys = [];
  const strengthPercent = toInt(weatherState && weatherState.strengthPercent, 0);

  for (const effectDescriptor of descriptors) {
    const appliesTo = Array.isArray(effectDescriptor && effectDescriptor.appliesTo)
      ? effectDescriptor.appliesTo.map((entry) => normalizeText(entry, ""))
      : [];
    if (
      appliesTo.length > 0 &&
      !appliesTo.includes(normalizeText(targetKind, "player"))
    ) {
      continue;
    }
    if (normalizeText(effectDescriptor && effectDescriptor.effectType, "") !== "ship_attribute") {
      continue;
    }
    const attributeNames = Array.isArray(effectDescriptor && effectDescriptor.attributeNames)
      ? effectDescriptor.attributeNames
      : [];
    const modifierPercent = resolveAbyssalWeatherModifierPercent(effectDescriptor, weatherState);
    const entriesBefore = supportedEntries.length;
    for (const attributeName of attributeNames) {
      const attributeID = ABYSSAL_WEATHER_SHIP_ATTRIBUTE_NAME_TO_ID[String(attributeName || "").trim()] || 0;
      if (attributeID <= 0) {
        continue;
      }
      supportedEntries.push(buildAbyssalWeatherDirectModifierEntry(attributeID, modifierPercent));
    }
    if (supportedEntries.length > entriesBefore) {
      appliedEffectKeys.push(normalizeText(effectDescriptor && effectDescriptor.effectID, ""));
    } else {
      skippedEffectKeys.push(normalizeText(effectDescriptor && effectDescriptor.effectID, ""));
    }
  }

  return {
    modifierEntries: supportedEntries,
    appliedEffectKeys: appliedEffectKeys.filter(Boolean),
    skippedEffectKeys: skippedEffectKeys.filter(Boolean),
  };
}

function buildAbyssalWeatherLocationModifierSources({
  ABYSSAL_WEATHER_TURRET_GROUP_IDS,
  resolveAbyssalWeatherModifierPercent,
  ATTRIBUTE_MAX_RANGE,
  ATTRIBUTE_FALLOFF,
  ABYSSAL_WEATHER_SYNTHETIC_ATTRIBUTE_RANGE_PERCENT,
  DOGMA_OP_POST_PERCENT,
}, weatherState, targetKind = "player") {
  const descriptors = Array.isArray(weatherState && weatherState.effectDescriptors)
    ? weatherState.effectDescriptors
    : [];
  const modifierInfo = [];
  const appliedEffectKeys = [];
  const skippedEffectKeys = [];
  const strengthPercent = toInt(weatherState && weatherState.strengthPercent, 0);

  for (const effectDescriptor of descriptors) {
    const appliesTo = Array.isArray(effectDescriptor && effectDescriptor.appliesTo)
      ? effectDescriptor.appliesTo.map((entry) => normalizeText(entry, ""))
      : [];
    if (
      appliesTo.length > 0 &&
      !appliesTo.includes(normalizeText(targetKind, "player"))
    ) {
      continue;
    }
    if (normalizeText(effectDescriptor && effectDescriptor.effectType, "") !== "module_location_attribute") {
      continue;
    }
    const attributeNames = Array.isArray(effectDescriptor && effectDescriptor.attributeNames)
      ? effectDescriptor.attributeNames
      : [];
    const groupIDs = Array.isArray(effectDescriptor && effectDescriptor.groupIDs)
      ? effectDescriptor.groupIDs
      : ABYSSAL_WEATHER_TURRET_GROUP_IDS;
    const modifierPercent = resolveAbyssalWeatherModifierPercent(effectDescriptor, weatherState);
    const before = modifierInfo.length;
    for (const attributeName of attributeNames) {
      const normalizedAttributeName = String(attributeName || "").trim();
      let modifiedAttributeID = 0;
      if (normalizedAttributeName === "maxRange") {
        modifiedAttributeID = ATTRIBUTE_MAX_RANGE;
      } else if (normalizedAttributeName === "falloff") {
        modifiedAttributeID = ATTRIBUTE_FALLOFF;
      }
      if (modifiedAttributeID <= 0) {
        continue;
      }
      for (const groupID of groupIDs) {
        modifierInfo.push({
          func: "LocationModifier",
          domain: "shipID",
          groupID: toInt(groupID, 0),
          modifiedAttributeID,
          modifyingAttributeID: ABYSSAL_WEATHER_SYNTHETIC_ATTRIBUTE_RANGE_PERCENT,
          operation: DOGMA_OP_POST_PERCENT,
        });
      }
    }
    if (modifierInfo.length > before) {
      appliedEffectKeys.push(normalizeText(effectDescriptor && effectDescriptor.effectID, ""));
    } else {
      skippedEffectKeys.push(normalizeText(effectDescriptor && effectDescriptor.effectID, ""));
    }
  }

  if (modifierInfo.length <= 0) {
    return {
      sources: [],
      appliedEffectKeys: [],
      skippedEffectKeys: skippedEffectKeys.filter(Boolean),
    };
  }

  return {
    sources: [{
      sourceKind: "abyssalWeather",
      sourceAttributes: {
        [ABYSSAL_WEATHER_SYNTHETIC_ATTRIBUTE_RANGE_PERCENT]: -Math.max(0, strengthPercent),
      },
      sourceEffects: [{
        name: "abyssalWeatherLocationEffect",
        modifierInfo,
      }],
    }],
    appliedEffectKeys: appliedEffectKeys.filter(Boolean),
    skippedEffectKeys: skippedEffectKeys.filter(Boolean),
  };
}

function listAbyssalWeatherResonancePenaltyEntries({
  ABYSSAL_WEATHER_SHIP_ATTRIBUTE_NAME_TO_ID,
  resolveAbyssalWeatherModifierPercent,
}, weatherState, targetKind = "player") {
  const descriptors = Array.isArray(weatherState && weatherState.effectDescriptors)
    ? weatherState.effectDescriptors
    : [];
  const entries = [];
  const normalizedTargetKind = normalizeText(targetKind, "player");
  const strengthPercent = toInt(weatherState && weatherState.strengthPercent, 0);

  for (const effectDescriptor of descriptors) {
    const appliesTo = Array.isArray(effectDescriptor && effectDescriptor.appliesTo)
      ? effectDescriptor.appliesTo.map((entry) => normalizeText(entry, ""))
      : [];
    if (
      appliesTo.length > 0 &&
      !appliesTo.includes(normalizedTargetKind)
    ) {
      continue;
    }
    if (
      normalizeText(effectDescriptor && effectDescriptor.effectType, "") !== "ship_attribute" ||
      normalizeText(effectDescriptor && effectDescriptor.strengthRole, "") !== "penalty"
    ) {
      continue;
    }
    const attributeNames = Array.isArray(effectDescriptor && effectDescriptor.attributeNames)
      ? effectDescriptor.attributeNames
      : [];
    for (const attributeName of attributeNames) {
      const normalizedAttributeName = String(attributeName || "").trim();
      if (!normalizedAttributeName.endsWith("DamageResonance")) {
        continue;
      }
      const attributeID = ABYSSAL_WEATHER_SHIP_ATTRIBUTE_NAME_TO_ID[normalizedAttributeName] || 0;
      if (attributeID <= 0) {
        continue;
      }
      entries.push({
        effectID: normalizeText(effectDescriptor && effectDescriptor.effectID, ""),
        attributeID,
        modifierPercent: resolveAbyssalWeatherModifierPercent(effectDescriptor, weatherState),
      });
    }
  }

  return entries;
}

function seedMissingAbyssalResonanceBaseAttributes({
  listAbyssalWeatherResonancePenaltyEntries,
}, attributeMap, weatherState, targetKind = "player") {
  if (!attributeMap || typeof attributeMap !== "object") {
    return [];
  }
  const seededEffectKeys = [];
  for (const entry of listAbyssalWeatherResonancePenaltyEntries(weatherState, targetKind)) {
    if (!Number.isFinite(Number(attributeMap[entry.attributeID]))) {
      attributeMap[entry.attributeID] = 1;
      seededEffectKeys.push(entry.effectID);
    }
  }
  return [...new Set(seededEffectKeys.filter(Boolean))];
}

function repairAppliedAbyssalResonanceAttributes({
  listAbyssalWeatherResonancePenaltyEntries,
  round6,
  toReal,
},
  attributeMap,
  sourceAttributes,
  weatherState,
  targetKind = "player",
) {
  if (!attributeMap || typeof attributeMap !== "object") {
    return [];
  }
  const source = sourceAttributes && typeof sourceAttributes === "object"
    ? sourceAttributes
    : {};
  const repairedEffectKeys = [];
  for (const entry of listAbyssalWeatherResonancePenaltyEntries(weatherState, targetKind)) {
    const sourceValue = Number(source[entry.attributeID]);
    if (Number.isFinite(sourceValue)) {
      continue;
    }
    const currentValue = Number(attributeMap[entry.attributeID]);
    if (Number.isFinite(currentValue) && currentValue > 0) {
      continue;
    }
    attributeMap[entry.attributeID] = round6(1 * (1 + (toReal(entry.modifierPercent, 0) / 100)));
    repairedEffectKeys.push(entry.effectID);
  }
  return [...new Set(repairedEffectKeys.filter(Boolean))];
}

function buildAbyssalWeatherState({
  getStoredWeatherState,
  resolveAbyssalWeatherStrengthSelection,
  cloneWeatherEffectDescriptors,
  buildAbyssalWeatherShipAttributeModifierEntries,
  buildAbyssalWeatherLocationModifierSources,
  toReal,
  cloneValue,
  resolveAbyssalWeatherStrengthBandKey,
}, contentProfile, overrides = {}) {
  const existingState = getStoredWeatherState(overrides) || null;
  if (existingState) {
    return existingState;
  }
  if (!contentProfile) {
    return null;
  }

  const weatherSelection = resolveAbyssalWeatherStrengthSelection(
    contentProfile,
    overrides,
  );
  const strengthPercent = Math.max(0, toInt(weatherSelection.penaltyPercent, 0));
  const penaltyStrengthPercent = strengthPercent;
  const bonusStrengthPercent = Math.max(
    0,
    toInt(weatherSelection.bonusPercent, strengthPercent),
  );
  const effectDescriptors = cloneWeatherEffectDescriptors(contentProfile);
  const modifierWeatherState = {
    effectDescriptors,
    strengthPercent,
    penaltyStrengthPercent,
    bonusStrengthPercent,
  };
  const playerDirect = buildAbyssalWeatherShipAttributeModifierEntries(
    modifierWeatherState,
    "player",
  );
  const npcDirect = buildAbyssalWeatherShipAttributeModifierEntries(
    modifierWeatherState,
    "npc",
  );
  const playerLocation = buildAbyssalWeatherLocationModifierSources(
    modifierWeatherState,
    "player",
  );
  const npcLocation = buildAbyssalWeatherLocationModifierSources(
    modifierWeatherState,
    "npc",
  );
  const appliedEffectKeys = [
    ...new Set([
      ...playerDirect.appliedEffectKeys,
      ...npcDirect.appliedEffectKeys,
      ...playerLocation.appliedEffectKeys,
      ...npcLocation.appliedEffectKeys,
    ].filter(Boolean)),
  ];
  const skippedEffectKeys = [
    ...new Set([
      ...playerDirect.skippedEffectKeys,
      ...npcDirect.skippedEffectKeys,
      ...playerLocation.skippedEffectKeys,
      ...npcLocation.skippedEffectKeys,
    ].filter(Boolean)),
  ];

  return {
    weatherType: normalizeText(contentProfile && contentProfile.weatherType, "unknown"),
    weatherName: normalizeText(contentProfile && contentProfile.weatherName, "Unknown Weather"),
    tier: Math.max(0, toInt(contentProfile && contentProfile.tier, 1)),
    penaltyBandLabel: normalizeText(
      contentProfile &&
        contentProfile.weatherProfile &&
        contentProfile.weatherProfile.penaltyBandLabel,
      "",
    ),
    bonusText: normalizeText(
      contentProfile &&
        contentProfile.weatherProfile &&
        contentProfile.weatherProfile.bonusText,
      "",
    ),
    penaltyText: normalizeText(
      contentProfile &&
        contentProfile.weatherProfile &&
        contentProfile.weatherProfile.penaltyText,
      "",
    ),
    deterministicPlaceholder: toInt(weatherSelection.typeID, 0) <= 0,
    deterministicPerRunSelection:
      weatherSelection.selectionModel === "deterministic-per-run-weighted",
    strengthPercent,
    penaltyStrengthPercent,
    bonusStrengthPercent,
    weatherStage: toInt(weatherSelection.stage, 0),
    weatherTypeID: toInt(weatherSelection.typeID, 0),
    weatherPresentationName: normalizeText(weatherSelection.name, ""),
    weatherSelectionSeed: toInt(weatherSelection.selectionSeed, 0) >>> 0,
    weatherSelectionRoll: toReal(weatherSelection.selectionRoll, 0),
    weatherSelectionWeights: Array.isArray(weatherSelection.selectionWeights)
      ? cloneValue(weatherSelection.selectionWeights)
      : [],
    weatherSelectionModel: normalizeText(weatherSelection.selectionModel, ""),
    allowedWeatherStages: Array.isArray(weatherSelection.allowedStages)
      ? cloneValue(weatherSelection.allowedStages)
      : [],
    strengthBandKey: resolveAbyssalWeatherStrengthBandKey(
      contentProfile,
      weatherSelection,
    ),
    effectDescriptors,
    playerShipAttributeModifierEntries: cloneValue(playerDirect.modifierEntries),
    npcShipAttributeModifierEntries: cloneValue(npcDirect.modifierEntries),
    playerLocationModifierSources: cloneValue(playerLocation.sources),
    npcLocationModifierSources: cloneValue(npcLocation.sources),
    appliedEffectKeys,
    skippedEffectKeys,
    playerAppliedEffectKeys: [
      ...new Set([...playerDirect.appliedEffectKeys, ...playerLocation.appliedEffectKeys]),
    ],
    playerSkippedEffectKeys: [
      ...new Set([...playerDirect.skippedEffectKeys, ...playerLocation.skippedEffectKeys]),
    ],
    npcAppliedEffectKeys: [
      ...new Set([...npcDirect.appliedEffectKeys, ...npcLocation.appliedEffectKeys]),
    ],
    npcSkippedEffectKeys: [
      ...new Set([...npcDirect.skippedEffectKeys, ...npcLocation.skippedEffectKeys]),
    ],
  };
}

function getResolvedWeatherState({
  getStoredWeatherState,
  getContentProfile,
  buildAbyssalWeatherState,
}, source) {
  const stored = getStoredWeatherState(source);
  if (stored) {
    return stored;
  }
  const contentProfile = getContentProfile(source) || source;
  return buildAbyssalWeatherState(contentProfile);
}

// Capture supplied capabilities once, as the original closure did. Internal
// callbacks are bound once per instance; no runtime state lives in this wiring.
function createAbyssalWeatherModel({
  getContentProfile,
  cloneValue,
  normalizeLowerText,
  resolveDarkWeatherSelection,
  toReal,
  round6,
  ABYSSAL_WEATHER_PRESENTATION_STAGES_BY_TYPE,
  DOGMA_OP_POST_PERCENT,
  ABYSSAL_WEATHER_SHIP_ATTRIBUTE_NAME_TO_ID,
  ABYSSAL_WEATHER_TURRET_GROUP_IDS,
  ATTRIBUTE_MAX_RANGE,
  ATTRIBUTE_FALLOFF,
  ABYSSAL_WEATHER_SYNTHETIC_ATTRIBUTE_RANGE_PERCENT,
}) {

  const ports = {
    getContentProfile,
    cloneValue,
    normalizeLowerText,
    resolveDarkWeatherSelection,
    toReal,
    round6,
    ABYSSAL_WEATHER_PRESENTATION_STAGES_BY_TYPE,
    DOGMA_OP_POST_PERCENT,
    ABYSSAL_WEATHER_SHIP_ATTRIBUTE_NAME_TO_ID,
    ABYSSAL_WEATHER_TURRET_GROUP_IDS,
    ATTRIBUTE_MAX_RANGE,
    ATTRIBUTE_FALLOFF,
    ABYSSAL_WEATHER_SYNTHETIC_ATTRIBUTE_RANGE_PERCENT,
  };
  ports.getWeatherProfile = getWeatherProfile.bind(null, ports);
  ports.getStoredWeatherState = getStoredWeatherState.bind(null, ports);
  ports.cloneWeatherEffectDescriptors = cloneWeatherEffectDescriptors.bind(null, ports);
  ports.resolveAbyssalWeatherStrengthSelection = resolveAbyssalWeatherStrengthSelection.bind(null, ports);
  ports.resolveDeterministicAbyssalWeatherStrengthPercent = resolveDeterministicAbyssalWeatherStrengthPercent.bind(null, ports);
  ports.resolveAbyssalWeatherStrengthBandKey = resolveAbyssalWeatherStrengthBandKey.bind(null, ports);
  ports.buildAbyssalWeatherDirectModifierEntry = buildAbyssalWeatherDirectModifierEntry.bind(null, ports);
  ports.resolveAbyssalWeatherModifierPercent = resolveAbyssalWeatherModifierPercent.bind(null, ports);
  ports.buildAbyssalWeatherShipAttributeModifierEntries = buildAbyssalWeatherShipAttributeModifierEntries.bind(null, ports);
  ports.buildAbyssalWeatherLocationModifierSources = buildAbyssalWeatherLocationModifierSources.bind(null, ports);
  ports.listAbyssalWeatherResonancePenaltyEntries = listAbyssalWeatherResonancePenaltyEntries.bind(null, ports);
  ports.seedMissingAbyssalResonanceBaseAttributes = seedMissingAbyssalResonanceBaseAttributes.bind(null, ports);
  ports.repairAppliedAbyssalResonanceAttributes = repairAppliedAbyssalResonanceAttributes.bind(null, ports);
  ports.buildAbyssalWeatherState = buildAbyssalWeatherState.bind(null, ports);
  ports.getResolvedWeatherState = getResolvedWeatherState.bind(null, ports);
  Object.freeze(ports);
  return Object.freeze({
    getWeatherProfile: ports.getWeatherProfile,
    getStoredWeatherState: ports.getStoredWeatherState,
    cloneWeatherEffectDescriptors: ports.cloneWeatherEffectDescriptors,
    resolveAbyssalWeatherStrengthSelection: ports.resolveAbyssalWeatherStrengthSelection,
    resolveDeterministicAbyssalWeatherStrengthPercent: ports.resolveDeterministicAbyssalWeatherStrengthPercent,
    resolveAbyssalWeatherStrengthBandKey: ports.resolveAbyssalWeatherStrengthBandKey,
    buildAbyssalWeatherDirectModifierEntry: ports.buildAbyssalWeatherDirectModifierEntry,
    resolveAbyssalWeatherModifierPercent: ports.resolveAbyssalWeatherModifierPercent,
    buildAbyssalWeatherShipAttributeModifierEntries: ports.buildAbyssalWeatherShipAttributeModifierEntries,
    buildAbyssalWeatherLocationModifierSources: ports.buildAbyssalWeatherLocationModifierSources,
    listAbyssalWeatherResonancePenaltyEntries: ports.listAbyssalWeatherResonancePenaltyEntries,
    seedMissingAbyssalResonanceBaseAttributes: ports.seedMissingAbyssalResonanceBaseAttributes,
    repairAppliedAbyssalResonanceAttributes: ports.repairAppliedAbyssalResonanceAttributes,
    buildAbyssalWeatherState: ports.buildAbyssalWeatherState,
    getResolvedWeatherState: ports.getResolvedWeatherState,
  });
}

module.exports = { createAbyssalWeatherModel };
