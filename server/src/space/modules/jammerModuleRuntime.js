"use strict";

const {
  toFiniteNumber,
  toInt,
} = require("../../common/numbers");

const path = require("path");

const {
  getAttributeIDByNames,
  getDogmaAttributeDefaultValue,
} = require(path.join(__dirname, "../../services/fitting/liveFittingState"));
const {
  buildLiveModuleAttributeMap,
} = require(path.join(__dirname, "./liveModuleAttributes"));
const {
  applyActiveImplantLocationModifiersToAttributes,
  getActiveImplantLocationModifierSources,
  getActiveImplantShipModifierEntries,
} = require(path.join(
  __dirname,
  "../../services/dogma/implants/activeImplantModifiers",
));
const {
  canEntitiesInteractLocally,
} = require(path.join(__dirname, "../destiny/identity/interactionScope"));

const ATTRIBUTE_CAPACITOR_NEED = getAttributeIDByNames("capacitorNeed") || 6;
const ATTRIBUTE_DURATION = getAttributeIDByNames("duration") || 73;
const ATTRIBUTE_SPEED = getAttributeIDByNames("speed") || 51;
const ATTRIBUTE_MAX_RANGE = getAttributeIDByNames("maxRange") || 54;
const ATTRIBUTE_ECM_BURST_RANGE = getAttributeIDByNames("ecmBurstRange") || 142;
const ATTRIBUTE_FALLOFF_EFFECTIVENESS =
  getAttributeIDByNames("falloffEffectiveness") || 2044;
const ATTRIBUTE_ECM_RANGE_FALLOFF = getAttributeIDByNames("ECMRangeFalloff") || 953;
const ATTRIBUTE_MAX_GROUP_ACTIVE = getAttributeIDByNames("maxGroupActive") || 763;
const ATTRIBUTE_REACTIVATION_DELAY =
  getAttributeIDByNames("moduleReactivationDelay", "reactivationDelay") || 669;
const ATTRIBUTE_SCAN_GRAVIMETRIC_STRENGTH_BONUS =
  getAttributeIDByNames("scanGravimetricStrengthBonus") || 238;
const ATTRIBUTE_SCAN_LADAR_STRENGTH_BONUS =
  getAttributeIDByNames("scanLadarStrengthBonus") || 239;
const ATTRIBUTE_SCAN_MAGNETOMETRIC_STRENGTH_BONUS =
  getAttributeIDByNames("scanMagnetometricStrengthBonus") || 240;
const ATTRIBUTE_SCAN_RADAR_STRENGTH_BONUS =
  getAttributeIDByNames("scanRadarStrengthBonus") || 241;
const ATTRIBUTE_SCAN_GRAVIMETRIC_STRENGTH =
  getAttributeIDByNames("scanGravimetricStrength") || 211;
const ATTRIBUTE_SCAN_LADAR_STRENGTH =
  getAttributeIDByNames("scanLadarStrength") || 209;
const ATTRIBUTE_SCAN_MAGNETOMETRIC_STRENGTH =
  getAttributeIDByNames("scanMagnetometricStrength") || 210;
const ATTRIBUTE_SCAN_RADAR_STRENGTH =
  getAttributeIDByNames("scanRadarStrength") || 208;
const ATTRIBUTE_ECM_RESISTANCE = getAttributeIDByNames("ECMResistance") || 2253;

const ECM_FAMILY = "ecmJammer";
const ECM_BURST_FAMILY = "ecmBurstJammer";
const ECM_JAMMING_TYPE = "electronic";
const PERSISTENT_SPECIAL_FX_WINDOW_MS = 12 * 60 * 60 * 1000;

const SENSOR_PROFILES = Object.freeze([
  Object.freeze({
    sensorType: "gravimetric",
    sensorStrengthAttributeID: ATTRIBUTE_SCAN_GRAVIMETRIC_STRENGTH,
    jammerStrengthAttributeID: ATTRIBUTE_SCAN_GRAVIMETRIC_STRENGTH_BONUS,
  }),
  Object.freeze({
    sensorType: "ladar",
    sensorStrengthAttributeID: ATTRIBUTE_SCAN_LADAR_STRENGTH,
    jammerStrengthAttributeID: ATTRIBUTE_SCAN_LADAR_STRENGTH_BONUS,
  }),
  Object.freeze({
    sensorType: "magnetometric",
    sensorStrengthAttributeID: ATTRIBUTE_SCAN_MAGNETOMETRIC_STRENGTH,
    jammerStrengthAttributeID: ATTRIBUTE_SCAN_MAGNETOMETRIC_STRENGTH_BONUS,
  }),
  Object.freeze({
    sensorType: "radar",
    sensorStrengthAttributeID: ATTRIBUTE_SCAN_RADAR_STRENGTH,
    jammerStrengthAttributeID: ATTRIBUTE_SCAN_RADAR_STRENGTH_BONUS,
  }),
]);

const JAMMER_EFFECT_DEFINITIONS_BY_NAME = Object.freeze({
  remoteecmfalloff: Object.freeze({
    family: ECM_FAMILY,
    jammingType: ECM_JAMMING_TYPE,
  }),
  entityecmfalloff: Object.freeze({
    family: ECM_FAMILY,
    jammingType: ECM_JAMMING_TYPE,
  }),
  npcremoteecm: Object.freeze({
    family: ECM_FAMILY,
    jammingType: ECM_JAMMING_TYPE,
  }),
  behaviorecm: Object.freeze({
    family: ECM_FAMILY,
    jammingType: ECM_JAMMING_TYPE,
  }),
  structureeweffectjam: Object.freeze({
    family: ECM_FAMILY,
    jammingType: ECM_JAMMING_TYPE,
  }),
  structuremoduleeffectecm: Object.freeze({
    family: ECM_FAMILY,
    jammingType: ECM_JAMMING_TYPE,
  }),
  ecmburstjammer: Object.freeze({
    family: ECM_BURST_FAMILY,
    jammingType: ECM_JAMMING_TYPE,
    burst: true,
    breakLocksOnly: true,
  }),
  ecmburstjammerqa: Object.freeze({
    family: ECM_BURST_FAMILY,
    jammingType: ECM_JAMMING_TYPE,
    burst: true,
    breakLocksOnly: true,
  }),
});

function isCloakedTargetEntity(entity) {
  return toInt(
    entity && (
      entity.isCloaked ??
      entity.cloakMode ??
      entity.cloaked
    ),
    0,
  ) > 0;
}

function roundNumber(value, digits = 6) {
  return Number(toFiniteNumber(value, 0).toFixed(digits));
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, toFiniteNumber(value, min)));
}

function normalizeEffectName(effectRecord) {
  return String(effectRecord && effectRecord.name || "").trim().toLowerCase();
}

function resolveJammerDefinition(effectRecord) {
  return JAMMER_EFFECT_DEFINITIONS_BY_NAME[normalizeEffectName(effectRecord)] || null;
}

// Shared with the NPC approach gate; preserve the effect's own falloff before ECM fallback.
// Adapted from ciefa/evejs-ciefa-fork 97cf914b9 (EVE-198).
function resolveJammerReach(effectRecord, attributeMap) {
  return {
    range: getPreferredAttributeValue(
      attributeMap,
      [effectRecord && effectRecord.rangeAttributeID, ATTRIBUTE_MAX_RANGE],
      0,
    ),
    falloff: getPreferredAttributeValue(
      attributeMap,
      [effectRecord && effectRecord.falloffAttributeID, ATTRIBUTE_ECM_RANGE_FALLOFF, ATTRIBUTE_FALLOFF_EFFECTIVENESS],
      0,
    ),
  };
}

function hasUsableJammerStrength(attributeMap) {
  return SENSOR_PROFILES.some((sensorProfile) => (
    toFiniteNumber(
      attributeMap && attributeMap[sensorProfile.jammerStrengthAttributeID],
      0,
    ) > 0
  ));
}

function resolveSourceCharacterID(entity) {
  return toInt(
    entity && (
      entity.characterID ??
      entity.pilotCharacterID ??
      (entity.session && (entity.session.characterID || entity.session.charid))
    ),
    0,
  );
}

function resolvePersistentRepeat(durationMs) {
  const cycleMs = Math.max(1, toFiniteNumber(durationMs, 1000));
  return Math.max(1, Math.ceil(PERSISTENT_SPECIAL_FX_WINDOW_MS / cycleMs));
}

// Same shape as `hostileModuleRuntime#getPreferredAttributeValue`: take the first
// candidate the module's attribute map actually carries a FINITE value on, and say
// which one that was. The live map materializes no SDE defaults, so "absent" and
// "declared zero" are different answers and the caller needs both.
function getPreferredAttributeValue(attributeMap, preferredAttributeIDs = [], fallback = 0) {
  for (const attributeID of preferredAttributeIDs) {
    const numericAttributeID = toInt(attributeID, 0);
    if (numericAttributeID <= 0) {
      continue;
    }
    const value = toFiniteNumber(attributeMap && attributeMap[numericAttributeID], NaN);
    if (Number.isFinite(value)) {
      return {
        value,
        attributeID: numericAttributeID,
      };
    }
  }
  return {
    value: toFiniteNumber(fallback, 0),
    attributeID: 0,
  };
}

function resolveEffectiveEcmBurstRange(moduleAttributes, moduleItem, characterID) {
  const baseBurstRange = Math.max(
    0,
    roundNumber(toFiniteNumber(moduleAttributes[ATTRIBUTE_ECM_BURST_RANGE], 0), 3),
  );
  if (baseBurstRange <= 0 || toInt(characterID, 0) <= 0) {
    return baseBurstRange;
  }

  const maxRangeAlias = applyActiveImplantLocationModifiersToAttributes(
    {
      [ATTRIBUTE_MAX_RANGE]: baseBurstRange,
    },
    moduleItem,
    characterID,
  );
  return Math.max(
    0,
    roundNumber(toFiniteNumber(maxRangeAlias[ATTRIBUTE_MAX_RANGE], baseBurstRange), 3),
  );
}

function buildJammedStateKey(sourceBallID, moduleID, targetBallID) {
  return [
    toInt(sourceBallID, 0),
    toInt(moduleID, 0),
    toInt(targetBallID, 0),
  ].join(":");
}

function ensureEntityJammedState(targetEntity, create = false) {
  if (!targetEntity || typeof targetEntity !== "object") {
    return null;
  }
  if (!targetEntity.jammerModuleState && create) {
    targetEntity.jammerModuleState = {
      activeJams: new Map(),
      allowedTargetIDs: new Set(),
      jammedUntilMs: 0,
      aggregateSignature: "",
    };
  }
  return targetEntity.jammerModuleState &&
    targetEntity.jammerModuleState.activeJams instanceof Map &&
    targetEntity.jammerModuleState.allowedTargetIDs instanceof Set
    ? targetEntity.jammerModuleState
    : null;
}

function getEntityPassiveAttributeValue(entity, attributeID, fallback = 0) {
  const attributes =
    entity &&
    entity.passiveDerivedState &&
    entity.passiveDerivedState.attributes &&
    typeof entity.passiveDerivedState.attributes === "object"
      ? entity.passiveDerivedState.attributes
      : null;
  const numericAttributeID = toInt(attributeID, 0);
  if (attributes && Number.isFinite(Number(attributes[numericAttributeID]))) {
    return Number(attributes[numericAttributeID]);
  }
  return toFiniteNumber(fallback, 0);
}

function resolveTargetSensorProfile(targetEntity) {
  let strongestProfile = null;

  for (const sensorProfile of SENSOR_PROFILES) {
    const sensorStrength = Math.max(
      0,
      roundNumber(
        getEntityPassiveAttributeValue(
          targetEntity,
          sensorProfile.sensorStrengthAttributeID,
          0,
        ),
        6,
      ),
    );
    if (sensorStrength <= 0) {
      continue;
    }
    if (!strongestProfile || sensorStrength > strongestProfile.sensorStrength) {
      strongestProfile = {
        sensorType: sensorProfile.sensorType,
        sensorStrength,
        sensorStrengthAttributeID: sensorProfile.sensorStrengthAttributeID,
        jammerStrengthAttributeID: sensorProfile.jammerStrengthAttributeID,
      };
    }
  }

  return strongestProfile;
}

// `ECMResistance` (2253) is unit 108, an INVERSE absolute percent — the SDE's own
// unit description is "Used for resistance. 0.0 = 100% 1.0 = 0%", its attribute
// description is "Resistance to ECM. 0 gives Immunity.", and its defaultValue is 1.
// The value therefore IS the multiplier, and the only two published readings of it
// are "absent" (an ordinary ship, no resistance) and 0.00001 (immune).
//
// Reading it as a 0–100 percentage and inverting it did two wrong things at once:
// every immune hull in the game — the 0.00001 an Upwell structure, a Monitor and
// any capital in Siege / Triage / an Industrial Core carries — came out at
// 1 − 0.00001/100 ≈ 0.9999999 and was jammable at full strength, and an absent
// value defaulted to 0, which only looked right because 1 − 0 happens to be 1.
// `assistanceModuleRuntime#resolveRemoteAssistanceMultiplier` reads its own
// unit-108 resistance attributes the right way round; this is the same shape.
function resolveTargetEcmResistanceMultiplier(targetEntity) {
  const declaredDefault = Number(getDogmaAttributeDefaultValue(ATTRIBUTE_ECM_RESISTANCE));
  const fallback = Number.isFinite(declaredDefault) ? declaredDefault : 1;
  return roundNumber(clamp(
    getEntityPassiveAttributeValue(targetEntity, ATTRIBUTE_ECM_RESISTANCE, fallback),
    0,
    1,
  ), 6);
}

// `toFiniteNumber(Infinity, 0)` is 0, so folding the range read straight into
// it collapsed an unmeasurable distance to POINT BLANK — full jam strength at
// any range, the fail-open mirror of the tractor beam's fail-closed bug. Keep
// the two cases it conflated apart. A wired reader that answers non-finite means
// the pair genuinely cannot be measured this tick, and a jam that cannot be
// placed has to be refused rather than applied at zero metres. An absent reader
// says something different: every production caller wires one, so only a harness
// that does not gate on range at all reaches that branch, and it keeps the old
// zero.
function readCallbackSurfaceDistanceMeters(callbacks, sourceEntity, targetEntity) {
  if (!callbacks || typeof callbacks.getEntitySurfaceDistance !== "function") {
    return 0;
  }
  const reported = Number(
    callbacks.getEntitySurfaceDistance(sourceEntity, targetEntity),
  );
  return Number.isFinite(reported) ? Math.max(0, reported) : Number.NaN;
}

function resolveJammerRangeMultiplier(effectState, sourceEntity, targetEntity, callbacks = {}) {
  const surfaceDistance = readCallbackSurfaceDistanceMeters(
    callbacks,
    sourceEntity,
    targetEntity,
  );
  if (!Number.isFinite(surfaceDistance)) {
    return {
      success: false,
      errorMsg: "TARGET_OUT_OF_RANGE",
      stopReason: "target",
      surfaceDistance: Infinity,
    };
  }
  const optimalRangeMeters = Math.max(
    0,
    toFiniteNumber(effectState && effectState.jammerMaxRangeMeters, 0),
  );
  const falloffMeters = Math.max(
    0,
    toFiniteNumber(effectState && effectState.jammerFalloffMeters, 0),
  );

  if (surfaceDistance <= optimalRangeMeters + 1) {
    return {
      success: true,
      multiplier: 1,
      surfaceDistance,
    };
  }
  if (falloffMeters <= 0) {
    return {
      success: false,
      errorMsg: "TARGET_OUT_OF_RANGE",
      stopReason: "target",
      surfaceDistance,
    };
  }

  const distanceIntoFalloff = surfaceDistance - optimalRangeMeters;
  if (distanceIntoFalloff > falloffMeters + 1) {
    return {
      success: false,
      errorMsg: "TARGET_OUT_OF_RANGE",
      stopReason: "target",
      surfaceDistance,
    };
  }

  const normalizedDistance = distanceIntoFalloff / Math.max(falloffMeters, 1);
  return {
    success: true,
    multiplier: roundNumber(0.5 ** (normalizedDistance ** 2), 6),
    surfaceDistance,
  };
}

function resolveJammerChance(effectState, targetEntity, rangeMultiplier) {
  const sensorProfile = resolveTargetSensorProfile(targetEntity);
  if (!sensorProfile || sensorProfile.sensorStrength <= 0) {
    return {
      sensorProfile: null,
      jammerStrength: 0,
      jamChance: 0,
    };
  }

  const strengthBySensorType =
    effectState &&
    effectState.jammerStrengthBySensorType &&
    typeof effectState.jammerStrengthBySensorType === "object"
      ? effectState.jammerStrengthBySensorType
      : {};
  const jammerStrength = Math.max(
    0,
    toFiniteNumber(strengthBySensorType[sensorProfile.sensorType], 0),
  );
  if (jammerStrength <= 0) {
    return {
      sensorProfile,
      jammerStrength: 0,
      jamChance: 0,
    };
  }

  const resistanceMultiplier = resolveTargetEcmResistanceMultiplier(targetEntity);
  const jamChance = clamp(
    (jammerStrength / Math.max(sensorProfile.sensorStrength, 1e-6)) *
      Math.max(rangeMultiplier, 0) *
      Math.max(resistanceMultiplier, 0),
    0,
    1,
  );

  return {
    sensorProfile,
    jammerStrength: roundNumber(jammerStrength, 6),
    jamChance: roundNumber(jamChance, 6),
  };
}

function buildJamRecord(
  sourceEntity,
  effectState,
  targetEntity,
  nowMs,
  sensorProfile,
  jammerStrength,
  jamChance,
) {
  return Object.freeze({
    key: buildJammedStateKey(
      sourceEntity && sourceEntity.itemID,
      effectState && effectState.moduleID,
      targetEntity && targetEntity.itemID,
    ),
    sourceBallID: toInt(sourceEntity && sourceEntity.itemID, 0),
    moduleID: toInt(effectState && effectState.moduleID, 0),
    targetBallID: toInt(targetEntity && targetEntity.itemID, 0),
    startedAtMs: Math.max(0, toFiniteNumber(nowMs, Date.now())),
    expiresAtMs: Math.max(
      0,
      toFiniteNumber(nowMs, Date.now()) +
        Math.max(
          1,
          toFiniteNumber(
            effectState && (
              effectState.jamDurationMs ??
              effectState.durationMs
            ),
            1000,
          ),
        ),
    ),
    jammingType: ECM_JAMMING_TYPE,
    sensorType: sensorProfile ? String(sensorProfile.sensorType || "") : "",
    sensorStrength: roundNumber(sensorProfile && sensorProfile.sensorStrength, 6),
    jammerStrength: roundNumber(jammerStrength, 6),
    jamChance: roundNumber(jamChance, 6),
  });
}

function buildAggregateSignature(activeRecords, allowedTargetIDs, jammedUntilMs) {
  return JSON.stringify({
    activeRecords: (Array.isArray(activeRecords) ? activeRecords : []).map((record) => ({
      sourceBallID: toInt(record && record.sourceBallID, 0),
      moduleID: toInt(record && record.moduleID, 0),
      targetBallID: toInt(record && record.targetBallID, 0),
      expiresAtMs: toInt(record && record.expiresAtMs, 0),
      sensorType: String(record && record.sensorType || ""),
      jamChance: roundNumber(record && record.jamChance, 6),
    })),
    allowedTargetIDs: [...(allowedTargetIDs instanceof Set ? allowedTargetIDs : new Set())]
      .map((value) => toInt(value, 0))
      .filter((value) => value > 0)
      .sort((left, right) => left - right),
    jammedUntilMs: toInt(jammedUntilMs, 0),
  });
}

function recomputeEntityJammedState(targetEntity, nowMs = Date.now()) {
  const jammedState = ensureEntityJammedState(targetEntity, false);
  if (!jammedState) {
    return {
      changed: false,
      jammed: false,
      jammedUntilMs: 0,
      allowedTargetIDs: new Set(),
    };
  }

  const resolvedNowMs = Math.max(0, toFiniteNumber(nowMs, Date.now()));
  const activeRecords = [];
  const allowedTargetIDs = new Set();
  let jammedUntilMs = 0;

  for (const [key, record] of [...jammedState.activeJams.entries()]) {
    if (
      !record ||
      toFiniteNumber(record.expiresAtMs, 0) <= resolvedNowMs
    ) {
      jammedState.activeJams.delete(key);
      continue;
    }
    activeRecords.push(record);
    const sourceBallID = toInt(record.sourceBallID, 0);
    if (sourceBallID > 0) {
      allowedTargetIDs.add(sourceBallID);
    }
    jammedUntilMs = Math.max(jammedUntilMs, toFiniteNumber(record.expiresAtMs, 0));
  }

  const nextSignature = buildAggregateSignature(activeRecords, allowedTargetIDs, jammedUntilMs);
  const changed = nextSignature !== String(jammedState.aggregateSignature || "");
  jammedState.allowedTargetIDs = allowedTargetIDs;
  jammedState.jammedUntilMs = jammedUntilMs;
  jammedState.aggregateSignature = nextSignature;
  return {
    changed,
    jammed: activeRecords.length > 0 && jammedUntilMs > resolvedNowMs,
    jammedUntilMs,
    allowedTargetIDs,
  };
}

function isEntityJammed(targetEntity, nowMs = Date.now()) {
  return recomputeEntityJammedState(targetEntity, nowMs).jammed === true;
}

function canEntityLockTargetWhileJammed(targetEntity, requestedTargetID, nowMs = Date.now()) {
  const recomputeResult = recomputeEntityJammedState(targetEntity, nowMs);
  if (recomputeResult.jammed !== true) {
    return true;
  }
  return recomputeResult.allowedTargetIDs.has(toInt(requestedTargetID, 0));
}

function getActiveJammerSourceIDs(targetEntity, nowMs = Date.now()) {
  return new Set(recomputeEntityJammedState(targetEntity, nowMs).allowedTargetIDs);
}

function getExistingJamRecord(targetEntity, sourceEntity, effectState) {
  const jammedState = ensureEntityJammedState(targetEntity, false);
  if (!jammedState) {
    return null;
  }
  return jammedState.activeJams.get(buildJammedStateKey(
    sourceEntity && sourceEntity.itemID,
    effectState && effectState.moduleID,
    targetEntity && targetEntity.itemID,
  )) || null;
}

function upsertJamRecord(targetEntity, record) {
  const jammedState = ensureEntityJammedState(targetEntity, true);
  const previousRecord = jammedState.activeJams.get(record.key) || null;
  jammedState.activeJams.set(record.key, record);
  return {
    previousRecord,
    record,
  };
}

function removeJamRecord(targetEntity, sourceEntity, effectState) {
  const jammedState = ensureEntityJammedState(targetEntity, false);
  if (!jammedState) {
    return null;
  }
  const key = buildJammedStateKey(
    sourceEntity && sourceEntity.itemID,
    effectState && effectState.moduleID,
    targetEntity && targetEntity.itemID,
  );
  const existingRecord = jammedState.activeJams.get(key) || null;
  if (!existingRecord) {
    return null;
  }
  jammedState.activeJams.delete(key);
  return existingRecord;
}

function resolveJammerModuleActivation({
  scene,
  entity,
  moduleItem,
  effectRecord,
  chargeItem = null,
  shipItem,
  skillMap = null,
  fittedItems = null,
  activeModuleContexts = null,
  additionalDirectModifierEntries = null,
  options = {},
  callbacks = {},
} = {}) {
  const definition = resolveJammerDefinition(effectRecord);
  if (!definition) {
    return { matched: false };
  }

  if (!scene || !entity || !moduleItem || !shipItem) {
    return {
      matched: true,
      success: false,
      errorMsg: "UNSUPPORTED_MODULE",
    };
  }

  const characterID = resolveSourceCharacterID(entity);
  const moduleAttributes = buildLiveModuleAttributeMap(
    shipItem,
    moduleItem,
    chargeItem,
    skillMap,
    fittedItems,
    activeModuleContexts,
    {
      additionalLocationModifierSources:
        characterID > 0
          ? getActiveImplantLocationModifierSources(characterID)
          : [],
      additionalShipModifierEntries:
        characterID > 0
          ? getActiveImplantShipModifierEntries(characterID)
          : [],
      additionalDirectModifierEntries: Array.isArray(
        additionalDirectModifierEntries,
      )
        ? additionalDirectModifierEntries
        : [],
    },
  );
  if (!moduleAttributes) {
    return {
      matched: true,
      success: false,
      errorMsg: "UNSUPPORTED_MODULE",
    };
  }

  // The cycle is the effect record's business, not this lane's. `remoteECMFalloff`,
  // `structureModuleEffectECM` and both burst jammers name 73 themselves, so a player
  // ECM module, a Standup ECM and a Burst Jammer read exactly what they read before.
  // `entityECMFalloff` names 929 `ECMDuration`, `behaviorECM` names 2531 and
  // `NPCRemoteECM` names 1658 — attributes those rats declare and this lane never
  // looked at, which is why an ECM rat ran on its TURRET cycle (51 `speed`) or, when
  // it declared neither 73 nor 51, on a 1 ms cycle.
  const durationResolution = getPreferredAttributeValue(
    moduleAttributes,
    [
      effectRecord && effectRecord.durationAttributeID,
      ATTRIBUTE_DURATION,
      ATTRIBUTE_SPEED,
    ],
    0,
  );
  const rawDurationMs = durationResolution.value;
  const durationAttributeID =
    durationResolution.attributeID > 0 ? durationResolution.attributeID : ATTRIBUTE_SPEED;

  // Capacitor discharge belongs to the effect record for the same reason as range and cycle.
  // Player ECM, Standup ECM and both burst effects bind ordinary capacitorNeed (6), so this is
  // identical for them. `behaviorECM` binds 2534 `behaviorECMDischarge`; records with no binding
  // retain attribute 6 as the compatibility fallback.
  const dischargeResolution = getPreferredAttributeValue(
    moduleAttributes,
    [
      effectRecord && effectRecord.dischargeAttributeID,
      ATTRIBUTE_CAPACITOR_NEED,
    ],
    0,
  );
  const capNeed = Math.max(0, roundNumber(dischargeResolution.value, 6));

  const jammerStrengthBySensorType = Object.freeze({
    gravimetric: roundNumber(
      toFiniteNumber(moduleAttributes[ATTRIBUTE_SCAN_GRAVIMETRIC_STRENGTH_BONUS], 0),
      6,
    ),
    ladar: roundNumber(
      toFiniteNumber(moduleAttributes[ATTRIBUTE_SCAN_LADAR_STRENGTH_BONUS], 0),
      6,
    ),
    magnetometric: roundNumber(
      toFiniteNumber(moduleAttributes[ATTRIBUTE_SCAN_MAGNETOMETRIC_STRENGTH_BONUS], 0),
      6,
    ),
    radar: roundNumber(
      toFiniteNumber(moduleAttributes[ATTRIBUTE_SCAN_RADAR_STRENGTH_BONUS], 0),
      6,
    ),
  });
  const jammerMaxStrength = Math.max(
    0,
    ...Object.values(jammerStrengthBySensorType).map((value) => toFiniteNumber(value, 0)),
  );
  if (jammerMaxStrength <= 0) {
    return {
      matched: true,
      success: false,
      errorMsg: "UNSUPPORTED_MODULE",
    };
  }
  const effectiveBurstRangeMeters =
    definition.burst === true
      ? resolveEffectiveEcmBurstRange(moduleAttributes, moduleItem, characterID)
      : 0;
  if (definition.burst === true && effectiveBurstRangeMeters > 0) {
    moduleAttributes[ATTRIBUTE_ECM_BURST_RANGE] = effectiveBurstRangeMeters;
  }

  // Reach comes off the effect record too, for the same reason the cycle does. The two
  // player-facing records (`remoteECMFalloff`, `structureModuleEffectECM`) name 54 and
  // 2044 themselves, so every ECM module and every Standup ECM resolves exactly what it
  // resolved before; the NPC records name their own attributes and stop borrowing the
  // rat's gun.
  //
  // The 953 candidate is the SDE's own omission, not an invention. `entityECMFalloff`
  // (6695) is a FALLOFF effect with a null `falloffAttributeID`, while its sibling
  // `concordTargetJam` (3710) — same family, same three attributes — binds
  // range 936 / falloff 953 / duration 929. 953 is `ECMRangeFalloff`. It is tried only
  // after the record's own binding, so it can never displace 2044 on a module whose
  // record names 2044, and the only records that reach it are the three with no falloff
  // binding at all: `entityECMFalloff`, `ECMBurstJammer` and `NPCRemoteECM`. Of the 95
  // hull types carrying 6695 exactly one declares 953 and declares it as 0, and no burst
  // jammer or `NPCRemoteECM` carrier declares it — so this candidate moves nothing except
  // the attribute-only entity-ECM rats, which is where it is needed.
  const { range: rangeResolution, falloff: falloffResolution } = resolveJammerReach(
    effectRecord,
    moduleAttributes,
  );

  const effectStatePatch = {
    jammerModuleEffect: definition.burst !== true,
    jammerBurstEffect: definition.burst === true,
    jammerFamily: definition.family,
    hostileJammingType: String(definition.jammingType || ECM_JAMMING_TYPE),
    jammerMaxRangeMeters: Math.max(0, roundNumber(rangeResolution.value, 3)),
    jammerFalloffMeters: Math.max(0, roundNumber(falloffResolution.value, 3)),
    jammerBurstRadiusMeters: Math.max(
      0,
      roundNumber(toFiniteNumber(moduleAttributes[ATTRIBUTE_ECM_BURST_RANGE], 0), 3),
    ),
    jammerBreakLocksOnly: definition.breakLocksOnly === true,
    jammerStrengthBySensorType,
    jammerMaxStrength: roundNumber(jammerMaxStrength, 6),
    forceFreshAcquireSpecialFxReplay: true,
    repeat: resolvePersistentRepeat(rawDurationMs),
  };

  if (definition.burst === true) {
    return {
      matched: true,
      success: true,
      data: {
        targetEntity: null,
        offensiveActivation: true,
        runtimeAttrs: {
          capNeed,
          durationMs: Math.max(1, roundNumber(rawDurationMs, 3)),
          durationAttributeID,
          reactivationDelayMs: Math.max(
            0,
            roundNumber(toFiniteNumber(moduleAttributes[ATTRIBUTE_REACTIVATION_DELAY], 0), 3),
          ),
          maxGroupActive: Math.max(0, toInt(moduleAttributes[ATTRIBUTE_MAX_GROUP_ACTIVE], 0)),
          weaponFamily: null,
          attributeOverrides: {
            ...moduleAttributes,
          },
        },
        effectStatePatch,
      },
    };
  }

  const normalizedTargetID = toInt(options.targetID, 0);
  if (normalizedTargetID <= 0) {
    return {
      matched: true,
      success: false,
      errorMsg: "TARGET_REQUIRED",
    };
  }

  const targetEntity =
    callbacks.getEntityByID && typeof callbacks.getEntityByID === "function"
      ? callbacks.getEntityByID(normalizedTargetID)
      : scene.getEntityByID(normalizedTargetID);
  if (
    !targetEntity ||
    targetEntity.kind !== "ship" ||
    !canEntitiesInteractLocally(entity, targetEntity)
  ) {
    return {
      matched: true,
      success: false,
      errorMsg: "TARGET_NOT_FOUND",
    };
  }
  if (isCloakedTargetEntity(targetEntity)) {
    return {
      matched: true,
      success: false,
      errorMsg: "TARGET_NOT_FOUND",
    };
  }

  if (
    !callbacks.isEntityLockedTarget ||
    callbacks.isEntityLockedTarget(entity, normalizedTargetID) !== true
  ) {
    return {
      matched: true,
      success: false,
      errorMsg: "TARGET_NOT_LOCKED",
    };
  }

  const rangeResult = resolveJammerRangeMultiplier(
    effectStatePatch,
    entity,
    targetEntity,
    callbacks,
  );
  if (!rangeResult.success) {
    return {
      matched: true,
      success: false,
      errorMsg: rangeResult.errorMsg || "TARGET_OUT_OF_RANGE",
    };
  }

  return {
    matched: true,
    success: true,
    data: {
      targetEntity,
      runtimeAttrs: {
        capNeed,
        durationMs: Math.max(1, roundNumber(rawDurationMs, 3)),
        durationAttributeID,
        reactivationDelayMs: Math.max(
          0,
          roundNumber(toFiniteNumber(moduleAttributes[ATTRIBUTE_REACTIVATION_DELAY], 0), 3),
        ),
        maxGroupActive: Math.max(0, toInt(moduleAttributes[ATTRIBUTE_MAX_GROUP_ACTIVE], 0)),
        weaponFamily: null,
        attributeOverrides: {
          ...moduleAttributes,
        },
      },
      offensiveActivation: true,
      effectStatePatch,
    },
  };
}

function listJammerBurstTargets(scene, sourceEntity, effectState, callbacks = {}) {
  if (!scene || !sourceEntity || !effectState) {
    return [];
  }

  const radiusMeters = Math.max(
    0,
    toFiniteNumber(effectState && effectState.jammerBurstRadiusMeters, 0),
  );
  if (radiusMeters <= 0) {
    return [];
  }

  const targets = [];
  for (const targetEntity of scene.dynamicEntities.values()) {
    if (
      !targetEntity ||
      targetEntity === sourceEntity ||
      targetEntity.kind !== "ship" ||
      isCloakedTargetEntity(targetEntity) ||
      !canEntitiesInteractLocally(sourceEntity, targetEntity)
    ) {
      continue;
    }
    const surfaceDistance = readCallbackSurfaceDistanceMeters(
      callbacks,
      sourceEntity,
      targetEntity,
    );
    // A burst sweeps every hull in a radius, so an unmeasurable candidate that
    // fell through to 0 metres was jammed by every burst regardless of where it
    // actually was. Skip it instead: absent geometry is not proof of proximity.
    if (!Number.isFinite(surfaceDistance) || surfaceDistance > radiusMeters + 1) {
      continue;
    }
    targets.push(targetEntity);
  }
  return targets;
}

function removeJammerModuleState({
  targetEntity,
  sourceEntity,
  effectState,
  nowMs = Date.now(),
} = {}) {
  if (!targetEntity || !sourceEntity || !effectState) {
    return {
      success: false,
      errorMsg: "UNSUPPORTED_MODULE",
    };
  }

  const removedRecord = removeJamRecord(targetEntity, sourceEntity, effectState);
  const recomputeResult = recomputeEntityJammedState(targetEntity, nowMs);
  return {
    success: true,
    data: {
      removedRecord,
      targetEntity,
      jamStateChanged: recomputeResult.changed,
      jammed: recomputeResult.jammed,
      allowedTargetIDs: recomputeResult.allowedTargetIDs,
    },
  };
}

// How a successful jam clears the victim's locks: one OnTargetClear naming
// the targets it may keep, and the OnECMJamDefender combat log line naming
// the jammer, as TQ packs them ahead of OnJamStart (golden log
// TheBlockadeLevel1: ('OnTargetClear', set([jammer])), ('OnCombatMessage',
// 'OnECMJamDefender', {'type': jammerTypeID, 'specialObject': jammerID})).
function buildJamLockClearOptions(jammerEntity) {
  return {
    notifySelf: true,
    notifyTarget: true,
    activeReason: "target",
    pendingReason: "target",
    targetClearEvent: true,
    combatMessage: [
      "OnECMJamDefender",
      {
        type: "dict",
        entries: [
          ["type", toInt(jammerEntity && jammerEntity.typeID, 0)],
          ["specialObject", toInt(jammerEntity && jammerEntity.itemID, 0)],
        ],
      },
    ],
  };
}

function applyJammerModuleState({
  targetEntity,
  sourceEntity,
  effectState,
  nowMs = Date.now(),
  callbacks = {},
  rangeMultiplier = 1,
} = {}) {
  if (!targetEntity || !sourceEntity || !effectState) {
    return {
      success: false,
      errorMsg: "UNSUPPORTED_MODULE",
    };
  }

  if (
    callbacks.recordOffensiveAggression &&
    typeof callbacks.recordOffensiveAggression === "function"
  ) {
    callbacks.recordOffensiveAggression(sourceEntity, targetEntity, nowMs);
  }

  const previousRecord = removeJamRecord(targetEntity, sourceEntity, effectState);
  const chanceResult = resolveJammerChance(effectState, targetEntity, rangeMultiplier);
  const randomRoll = clamp(
    callbacks.random && typeof callbacks.random === "function"
      ? callbacks.random()
      : Math.random(),
    0,
    1,
  );
  const jamApplied = chanceResult.jamChance > 0 && randomRoll < chanceResult.jamChance;

  if (jamApplied) {
    upsertJamRecord(
      targetEntity,
      buildJamRecord(
        sourceEntity,
        effectState,
        targetEntity,
        nowMs,
        chanceResult.sensorProfile,
        chanceResult.jammerStrength,
        chanceResult.jamChance,
      ),
    );
  }

  const recomputeResult = recomputeEntityJammedState(targetEntity, nowMs);
  if (
    jamApplied &&
    callbacks.clearOutgoingTargetLocksExcept &&
    typeof callbacks.clearOutgoingTargetLocksExcept === "function"
  ) {
    callbacks.clearOutgoingTargetLocksExcept(
      targetEntity,
      recomputeResult.allowedTargetIDs,
      buildJamLockClearOptions(sourceEntity),
    );
  }

  return {
    success: true,
    data: {
      targetEntity,
      jamApplied,
      previousJamApplied: Boolean(previousRecord),
      jamStateChanged: recomputeResult.changed,
      jammed: recomputeResult.jammed,
      allowedTargetIDs: recomputeResult.allowedTargetIDs,
      jamChance: chanceResult.jamChance,
      randomRoll: roundNumber(randomRoll, 6),
      sensorType: chanceResult.sensorProfile
        ? String(chanceResult.sensorProfile.sensorType || "")
        : "",
    },
  };
}

function executeJammerModuleCycle({
  scene,
  entity,
  effectState,
  nowMs,
  callbacks = {},
} = {}) {
  if (!scene || !entity || !effectState) {
    return {
      success: false,
      stopReason: "module",
    };
  }

  const targetEntity =
    callbacks.getEntityByID && typeof callbacks.getEntityByID === "function"
      ? callbacks.getEntityByID(toInt(effectState.targetID, 0))
      : scene.getEntityByID(toInt(effectState.targetID, 0));
  if (
    !targetEntity ||
    targetEntity.kind !== "ship" ||
    !canEntitiesInteractLocally(entity, targetEntity)
  ) {
    return {
      success: false,
      errorMsg: "TARGET_NOT_FOUND",
      stopReason: "target",
    };
  }
  if (isCloakedTargetEntity(targetEntity)) {
    return {
      success: false,
      errorMsg: "TARGET_NOT_FOUND",
      stopReason: "target",
    };
  }

  if (
    !callbacks.isEntityLockedTarget ||
    callbacks.isEntityLockedTarget(entity, effectState.targetID) !== true
  ) {
    return {
      success: false,
      errorMsg: "TARGET_NOT_LOCKED",
      stopReason: "target",
    };
  }

  const previousRecord = removeJamRecord(targetEntity, entity, effectState);
  const rangeResult = resolveJammerRangeMultiplier(
    effectState,
    entity,
    targetEntity,
    callbacks,
  );
  if (!rangeResult.success) {
    recomputeEntityJammedState(targetEntity, nowMs);
    return rangeResult;
  }

  const chanceResult = resolveJammerChance(
    effectState,
    targetEntity,
    rangeResult.multiplier,
  );
  const randomRoll = clamp(
    callbacks.random && typeof callbacks.random === "function"
      ? callbacks.random()
      : Math.random(),
    0,
    1,
  );
  const jamApplied = chanceResult.jamChance > 0 && randomRoll < chanceResult.jamChance;

  if (jamApplied) {
    upsertJamRecord(
      targetEntity,
      buildJamRecord(
        entity,
        effectState,
        targetEntity,
        nowMs,
        chanceResult.sensorProfile,
        chanceResult.jammerStrength,
        chanceResult.jamChance,
      ),
    );
  }

  const recomputeResult = recomputeEntityJammedState(targetEntity, nowMs);
  if (
    jamApplied &&
    callbacks.clearOutgoingTargetLocksExcept &&
    typeof callbacks.clearOutgoingTargetLocksExcept === "function"
  ) {
    callbacks.clearOutgoingTargetLocksExcept(
      targetEntity,
      recomputeResult.allowedTargetIDs,
      buildJamLockClearOptions(entity),
    );
  }

  return {
    success: true,
    data: {
      targetEntity,
      jamApplied,
      previousJamApplied: Boolean(previousRecord),
      jamStateChanged: recomputeResult.changed,
      jammed: recomputeResult.jammed,
      allowedTargetIDs: recomputeResult.allowedTargetIDs,
      jamChance: chanceResult.jamChance,
      randomRoll: roundNumber(randomRoll, 6),
      sensorType: chanceResult.sensorProfile
        ? String(chanceResult.sensorProfile.sensorType || "")
        : "",
    },
  };
}

function executeJammerBurstCycle({
  scene,
  entity,
  effectState,
  nowMs,
  callbacks = {},
} = {}) {
  if (!scene || !entity || !effectState) {
    return {
      success: false,
      stopReason: "module",
    };
  }

  const affectedTargets = [];
  for (const targetEntity of listJammerBurstTargets(scene, entity, effectState, callbacks)) {
    if (
      callbacks.recordOffensiveAggression &&
      typeof callbacks.recordOffensiveAggression === "function"
    ) {
      callbacks.recordOffensiveAggression(entity, targetEntity, nowMs);
    }

    const chanceResult = resolveJammerChance(effectState, targetEntity, 1);
    const randomRoll = clamp(
      callbacks.random && typeof callbacks.random === "function"
        ? callbacks.random()
        : Math.random(),
      0,
      1,
    );
    const jamApplied = chanceResult.jamChance > 0 && randomRoll < chanceResult.jamChance;
    let lockClearResult = null;
    if (
      jamApplied &&
      callbacks.clearOutgoingTargetLocksExcept &&
      typeof callbacks.clearOutgoingTargetLocksExcept === "function"
    ) {
      lockClearResult = callbacks.clearOutgoingTargetLocksExcept(
        targetEntity,
        new Set(),
        buildJamLockClearOptions(entity),
      );
    }

    affectedTargets.push({
      targetEntity,
      jamApplied,
      jamChance: chanceResult.jamChance,
      randomRoll: roundNumber(randomRoll, 6),
      sensorType: chanceResult.sensorProfile
        ? String(chanceResult.sensorProfile.sensorType || "")
        : "",
      clearedTargetIDs:
        lockClearResult && Array.isArray(lockClearResult.clearedTargetIDs)
          ? [...lockClearResult.clearedTargetIDs]
          : [],
      cancelledPendingIDs:
        lockClearResult && Array.isArray(lockClearResult.cancelledPendingIDs)
          ? [...lockClearResult.cancelledPendingIDs]
          : [],
    });
  }

  return {
    success: true,
    data: {
      affectedTargets,
      jammedTargetIDs: affectedTargets
        .filter((entry) => entry && entry.jamApplied === true)
        .map((entry) => toInt(entry.targetEntity && entry.targetEntity.itemID, 0))
        .filter((value) => value > 0),
    },
  };
}

module.exports = {
  ECM_FAMILY,
  ECM_BURST_FAMILY,
  ECM_JAMMING_TYPE,
  hasUsableJammerStrength,
  resolveJammerDefinition,
  resolveJammerModuleActivation,
  resolveJammerChance,
  applyJammerModuleState,
  removeJammerModuleState,
  executeJammerModuleCycle,
  executeJammerBurstCycle,
  recomputeEntityJammedState,
  isEntityJammed,
  canEntityLockTargetWhileJammed,
  getActiveJammerSourceIDs,
  resolveJammerReach,
};
