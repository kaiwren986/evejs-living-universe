"use strict";

const {
  round6,
  toFiniteNumber,
} = require("../../common/numbers");

const path = require("path");

const {
  getAttributeIDByNames,
} = require(path.join(__dirname, "../../services/fitting/liveFittingState"));
const {
  currentFileTime,
  buildMarshalReal,
} = require(path.join(__dirname, "../../services/_shared/serviceHelpers"));

const ATTRIBUTE_STRUCTURE_HP = getAttributeIDByNames("hp", "structureHP") || 9;
const ATTRIBUTE_ARMOR_HP = getAttributeIDByNames("armorHP") || 265;
const ATTRIBUTE_SHIELD_CAPACITY = getAttributeIDByNames("shieldCapacity") || 263;
const ATTRIBUTE_ARMOR_EM_RESONANCE =
  getAttributeIDByNames("armorEmDamageResonance") || 267;
const ATTRIBUTE_ARMOR_EXPLOSIVE_RESONANCE =
  getAttributeIDByNames("armorExplosiveDamageResonance") || 268;
const ATTRIBUTE_ARMOR_KINETIC_RESONANCE =
  getAttributeIDByNames("armorKineticDamageResonance") || 269;
const ATTRIBUTE_ARMOR_THERMAL_RESONANCE =
  getAttributeIDByNames("armorThermalDamageResonance") || 270;
const ATTRIBUTE_SHIELD_EM_RESONANCE =
  getAttributeIDByNames("shieldEmDamageResonance") || 271;
const ATTRIBUTE_SHIELD_EXPLOSIVE_RESONANCE =
  getAttributeIDByNames("shieldExplosiveDamageResonance") || 272;
const ATTRIBUTE_SHIELD_KINETIC_RESONANCE =
  getAttributeIDByNames("shieldKineticDamageResonance") || 273;
const ATTRIBUTE_SHIELD_THERMAL_RESONANCE =
  getAttributeIDByNames("shieldThermalDamageResonance") || 274;
const ATTRIBUTE_STRUCTURE_EM_RESONANCE =
  getAttributeIDByNames("emDamageResonance") || 113;
const ATTRIBUTE_STRUCTURE_THERMAL_RESONANCE =
  getAttributeIDByNames("thermalDamageResonance") || 110;
const ATTRIBUTE_STRUCTURE_KINETIC_RESONANCE =
  getAttributeIDByNames("kineticDamageResonance") || 109;
const ATTRIBUTE_STRUCTURE_EXPLOSIVE_RESONANCE =
  getAttributeIDByNames("explosiveDamageResonance") || 111;

const DAMAGE_TYPES = Object.freeze([
  "em",
  "thermal",
  "kinetic",
  "explosive",
]);

function clamp(value, min, max) {
  return Math.min(Math.max(toFiniteNumber(value, min), min), max);
}

function getEntityAttributeMap(entity) {
  const attributes =
    entity &&
    entity.passiveDerivedState &&
    entity.passiveDerivedState.attributes &&
    typeof entity.passiveDerivedState.attributes === "object"
      ? entity.passiveDerivedState.attributes
      : null;
  return attributes || null;
}

function getEntityAttributeValue(entity, attributeID, fallback = NaN) {
  const attributes = getEntityAttributeMap(entity);
  if (attributes && attributes[String(attributeID)] !== undefined) {
    return toFiniteNumber(attributes[String(attributeID)], fallback);
  }
  if (attributes && attributes[attributeID] !== undefined) {
    return toFiniteNumber(attributes[attributeID], fallback);
  }
  return fallback;
}

function getEntityMaxHealthLayers(entity) {
  const shieldCapacity = Math.max(
    0,
    toFiniteNumber(
      entity && entity.shieldCapacity,
      getEntityAttributeValue(entity, ATTRIBUTE_SHIELD_CAPACITY, 0),
    ),
  );
  const armorHP = Math.max(
    0,
    toFiniteNumber(
      entity && entity.armorHP,
      getEntityAttributeValue(entity, ATTRIBUTE_ARMOR_HP, 0),
    ),
  );
  const structureHP = Math.max(
    0,
    toFiniteNumber(
      entity && entity.structureHP,
      getEntityAttributeValue(entity, ATTRIBUTE_STRUCTURE_HP, 0),
    ),
  );

  return {
    shield: shieldCapacity,
    armor: armorHP,
    structure: structureHP,
  };
}

function getEntityCurrentHealthLayers(entity, maxLayers = getEntityMaxHealthLayers(entity)) {
  const conditionState =
    entity && entity.conditionState && typeof entity.conditionState === "object"
      ? entity.conditionState
      : {};
  const shieldCharge =
    conditionState.shieldCharge === undefined || conditionState.shieldCharge === null
      ? 1
      : conditionState.shieldCharge;
  const armorDamage =
    conditionState.armorDamage === undefined || conditionState.armorDamage === null
      ? 0
      : conditionState.armorDamage;
  const structureDamage =
    conditionState.damage === undefined || conditionState.damage === null
      ? 0
      : conditionState.damage;

  return {
    shield:
      maxLayers.shield > 0
        ? maxLayers.shield * clamp(shieldCharge, 0, 1)
        : 0,
    armor:
      maxLayers.armor > 0
        ? maxLayers.armor * clamp(1 - toFiniteNumber(armorDamage, 0), 0, 1)
        : 0,
    structure:
      maxLayers.structure > 0
        ? maxLayers.structure * clamp(1 - toFiniteNumber(structureDamage, 0), 0, 1)
        : 0,
  };
}

function hasDamageableHealth(entity) {
  // Arming generated empire scenery must not make its visual hull destructible.
  if (entity && entity.empireSentry === true) return false;
  const maxLayers = getEntityMaxHealthLayers(entity);
  return maxLayers.shield > 0 || maxLayers.armor > 0 || maxLayers.structure > 0;
}

function normalizeDamageVector(rawDamage = {}) {
  const source =
    rawDamage && typeof rawDamage === "object"
      ? rawDamage
      : {};
  return {
    em: Math.max(0, toFiniteNumber(source.em, 0)),
    thermal: Math.max(0, toFiniteNumber(source.thermal, 0)),
    kinetic: Math.max(0, toFiniteNumber(source.kinetic, 0)),
    explosive: Math.max(0, toFiniteNumber(source.explosive, 0)),
  };
}

function sumDamageVector(vector) {
  return DAMAGE_TYPES.reduce(
    (sum, damageType) => sum + Math.max(0, toFiniteNumber(vector && vector[damageType], 0)),
    0,
  );
}

function getLayerResonances(entity, layerName) {
  if (layerName === "shield") {
    const resonances = {
      em: Math.max(0, toFiniteNumber(
        getEntityAttributeValue(entity, ATTRIBUTE_SHIELD_EM_RESONANCE, 1),
        1,
      )),
      thermal: Math.max(0, toFiniteNumber(
        getEntityAttributeValue(entity, ATTRIBUTE_SHIELD_THERMAL_RESONANCE, 1),
        1,
      )),
      kinetic: Math.max(0, toFiniteNumber(
        getEntityAttributeValue(entity, ATTRIBUTE_SHIELD_KINETIC_RESONANCE, 1),
        1,
      )),
      explosive: Math.max(0, toFiniteNumber(
        getEntityAttributeValue(entity, ATTRIBUTE_SHIELD_EXPLOSIVE_RESONANCE, 1),
        1,
      )),
    };
    return Number(entity && entity.categoryID) === 23 && Number(entity.groupID) === 365
      ? require("../../services/starbase/starbaseResistanceRuntime").applyTowerShieldResonances(entity, resonances)
      : resonances;
  }

  if (layerName === "armor") {
    return {
      em: Math.max(0, toFiniteNumber(
        getEntityAttributeValue(entity, ATTRIBUTE_ARMOR_EM_RESONANCE, 1),
        1,
      )),
      thermal: Math.max(0, toFiniteNumber(
        getEntityAttributeValue(entity, ATTRIBUTE_ARMOR_THERMAL_RESONANCE, 1),
        1,
      )),
      kinetic: Math.max(0, toFiniteNumber(
        getEntityAttributeValue(entity, ATTRIBUTE_ARMOR_KINETIC_RESONANCE, 1),
        1,
      )),
      explosive: Math.max(0, toFiniteNumber(
        getEntityAttributeValue(entity, ATTRIBUTE_ARMOR_EXPLOSIVE_RESONANCE, 1),
        1,
      )),
    };
  }

  return {
    em: Math.max(0, toFiniteNumber(
      getEntityAttributeValue(entity, ATTRIBUTE_STRUCTURE_EM_RESONANCE, 1),
      1,
    )),
    thermal: Math.max(0, toFiniteNumber(
      getEntityAttributeValue(entity, ATTRIBUTE_STRUCTURE_THERMAL_RESONANCE, 1),
      1,
    )),
    kinetic: Math.max(0, toFiniteNumber(
      getEntityAttributeValue(entity, ATTRIBUTE_STRUCTURE_KINETIC_RESONANCE, 1),
      1,
    )),
    explosive: Math.max(0, toFiniteNumber(
      getEntityAttributeValue(entity, ATTRIBUTE_STRUCTURE_EXPLOSIVE_RESONANCE, 1),
      1,
    )),
  };
}

function getEntityHealthRatios(entity) {
  if (!hasDamageableHealth(entity)) {
    return {
      shieldRatio: 1,
      armorRatio: 1,
      structureRatio: 1,
      shieldTau: 110000,
    };
  }

  const maxLayers = getEntityMaxHealthLayers(entity);
  const currentLayers = getEntityCurrentHealthLayers(entity, maxLayers);
  return {
    shieldRatio:
      maxLayers.shield > 0 ? clamp(currentLayers.shield / maxLayers.shield, 0, 1) : 0,
    armorRatio:
      maxLayers.armor > 0 ? clamp(currentLayers.armor / maxLayers.armor, 0, 1) : 0,
    structureRatio:
      maxLayers.structure > 0
        ? clamp(currentLayers.structure / maxLayers.structure, 0, 1)
        : 0,
    shieldTau:
      maxLayers.shield > 0
        ? Math.max(0, toFiniteNumber(entity && entity.shieldRechargeRate, 0) / 5)
        : 0,
  };
}

function buildDamageState(entity, simFileTime = currentFileTime()) {
  const conditionState = require("../../services/incursion/incursionRepairPresentation").condition(entity);
  const view = conditionState === entity?.conditionState ? entity : { ...entity, conditionState };
  const {
    shieldRatio,
    armorRatio,
    structureRatio,
    shieldTau,
  } = getEntityHealthRatios(view);
  // Latest/eveInflight/damageStateValue.py:9-22 returns None for a non-tuple
  // shield entry; moonmining.py:931-941 renders that as Reinforced. A normal
  // positive-tau tuple would incorrectly animate recharge during invulnerability.
  const reinforcedStarbase = Number(entity && entity.categoryID) === 23 &&
    Number(entity.groupID) === 365 &&
    require("../../services/starbase/starbaseReinforcementRuntime").isReinforced(entity.itemID);

  return [
    reinforcedStarbase ? null : [
      buildMarshalReal(shieldRatio, 0),
      buildMarshalReal(shieldTau, 0),
      { type: "long", value: simFileTime },
    ],
    buildMarshalReal(armorRatio, 0),
    buildMarshalReal(structureRatio, 0),
  ];
}

function buildLiveDamageState(entity, simFileTime = currentFileTime()) {
  return buildDamageState(entity, simFileTime);
}

function applyDamageToEntity(entity, rawDamage, options = {}) {
  if (!entity || !hasDamageableHealth(entity)) {
    return {
      success: false,
      errorMsg: "ENTITY_NOT_DAMAGEABLE",
    };
  }

  const maxLayers = getEntityMaxHealthLayers(entity);
  const startingLayers = getEntityCurrentHealthLayers(entity, maxLayers);
  const beforeConditionState = {
    ...(entity.conditionState || {}),
  };
  const beforeArmorDamageAmount = maxLayers.armor > 0
    ? maxLayers.armor * Math.max(
      0,
      toFiniteNumber(beforeConditionState.armorDamage, 0),
    )
    : 0;
  const rawRemaining = normalizeDamageVector(rawDamage);
  const perLayer = [];
  // Optional per-layer caps on the effective damage this call may apply, used
  // for the Upwell per-second damage limits. Damage a cap stops inside a layer
  // is lost; it never spills into the next layer.
  const layerDamageLimits =
    options.layerDamageLimits && typeof options.layerDamageLimits === "object"
      ? options.layerDamageLimits
      : null;

  for (const layerName of ["shield", "armor", "structure"]) {
    const maxHP = maxLayers[layerName];
    let currentHP = startingLayers[layerName];
    const layerLimit = layerDamageLimits
      ? Math.max(0, toFiniteNumber(layerDamageLimits[layerName], Infinity))
      : Infinity;
    if (currentHP > 0 && layerLimit <= 0) {
      for (const damageType of DAMAGE_TYPES) {
        rawRemaining[damageType] = 0;
      }
    }
    if (maxHP <= 0 || currentHP <= 0 || sumDamageVector(rawRemaining) <= 0) {
      perLayer.push({
        layer: layerName,
        maxHP: round6(maxHP),
        beforeHP: round6(currentHP),
        afterHP: round6(currentHP),
        appliedRaw: normalizeDamageVector(null),
        appliedEffective: 0,
      });
      continue;
    }

    const resonances = getLayerResonances(entity, layerName);
    // Callers may supply an explicit encounter policy without mutating native
    // dogma or the entity's derived attributes. Invalid/missing fields retain
    // the native resonance independently for each layer and damage type.
    const resonanceOverrides = options.layerResonanceOverrides?.[layerName];
    if (resonanceOverrides && typeof resonanceOverrides === "object") {
      for (const damageType of DAMAGE_TYPES) {
        const value = resonanceOverrides[damageType];
        if (typeof value === "number" && Number.isFinite(value) && value >= 0) resonances[damageType] = value;
      }
    }
    const effectiveRemaining = DAMAGE_TYPES.reduce(
      (sum, damageType) => sum + (rawRemaining[damageType] * resonances[damageType]),
      0,
    );
    if (effectiveRemaining <= 0) {
      perLayer.push({
        layer: layerName,
        maxHP: round6(maxHP),
        beforeHP: round6(currentHP),
        afterHP: round6(currentHP),
        appliedRaw: normalizeDamageVector(null),
        appliedEffective: 0,
      });
      continue;
    }

    const beforeHP = currentHP;
    let appliedRaw = normalizeDamageVector(null);
    let appliedEffective = 0;
    if (effectiveRemaining <= Math.min(currentHP, layerLimit) + 1e-9) {
      for (const damageType of DAMAGE_TYPES) {
        appliedRaw[damageType] = rawRemaining[damageType];
        rawRemaining[damageType] = 0;
        appliedEffective += appliedRaw[damageType] * resonances[damageType];
      }
      currentHP = Math.max(0, currentHP - appliedEffective);
    } else if (layerLimit < currentHP && effectiveRemaining > layerLimit) {
      const consumedFraction = layerLimit / effectiveRemaining;
      for (const damageType of DAMAGE_TYPES) {
        appliedRaw[damageType] = rawRemaining[damageType] * consumedFraction;
        appliedEffective += appliedRaw[damageType] * resonances[damageType];
        rawRemaining[damageType] = 0;
      }
      currentHP = Math.max(0, currentHP - appliedEffective);
    } else {
      const consumedFraction = currentHP / effectiveRemaining;
      for (const damageType of DAMAGE_TYPES) {
        const consumedRaw = rawRemaining[damageType] * consumedFraction;
        appliedRaw[damageType] = consumedRaw;
        rawRemaining[damageType] = Math.max(0, rawRemaining[damageType] - consumedRaw);
        appliedEffective += consumedRaw * resonances[damageType];
      }
      currentHP = 0;
    }

    startingLayers[layerName] = currentHP;
    perLayer.push({
      layer: layerName,
      maxHP: round6(maxHP),
      beforeHP: round6(beforeHP),
      afterHP: round6(currentHP),
      appliedRaw: normalizeDamageVector(appliedRaw),
      appliedEffective: round6(appliedEffective),
    });
  }
  const armorLayerResult = perLayer.find((layer) => layer.layer === "armor") || null;
  const nextArmorDamageAmount =
    beforeArmorDamageAmount +
    toFiniteNumber(armorLayerResult && armorLayerResult.appliedEffective, 0);

  entity.conditionState = {
    ...(entity.conditionState || {}),
    damage:
      maxLayers.structure > 0
        ? round6(1 - clamp(startingLayers.structure / maxLayers.structure, 0, 1))
        : 1,
    charge: clamp(
      toFiniteNumber(
        beforeConditionState.charge,
        entity.capacitorChargeRatio === undefined ? 1 : entity.capacitorChargeRatio,
      ),
      0,
      1,
    ),
    armorDamage: maxLayers.armor > 0
      ? round6(nextArmorDamageAmount / maxLayers.armor)
      : 0,
    shieldCharge:
      maxLayers.shield > 0
        ? round6(clamp(startingLayers.shield / maxLayers.shield, 0, 1))
        : 0,
    incapacitated:
      options.incapacitated === undefined || options.incapacitated === null
        ? Boolean(beforeConditionState.incapacitated)
        : Boolean(options.incapacitated),
  };

  return {
    success: true,
    data: {
      maxLayers: {
        shield: round6(maxLayers.shield),
        armor: round6(maxLayers.armor),
        structure: round6(maxLayers.structure),
      },
      beforeLayers: {
        shield: round6(getEntityCurrentHealthLayers(
          { ...entity, conditionState: beforeConditionState },
          maxLayers,
        ).shield),
        armor: round6(getEntityCurrentHealthLayers(
          { ...entity, conditionState: beforeConditionState },
          maxLayers,
        ).armor),
        structure: round6(getEntityCurrentHealthLayers(
          { ...entity, conditionState: beforeConditionState },
          maxLayers,
        ).structure),
      },
      afterLayers: {
        shield: round6(startingLayers.shield),
        armor: round6(startingLayers.armor),
        structure: round6(startingLayers.structure),
      },
      beforeConditionState,
      afterConditionState: {
        ...entity.conditionState,
      },
      perLayer,
      rawDamage: normalizeDamageVector(rawDamage),
      remainingRaw: normalizeDamageVector(rawRemaining),
      destroyed:
        maxLayers.structure > 0 &&
        startingLayers.structure <= 1e-9 &&
        sumDamageVector(rawDamage) > 0,
    },
  };
}

// Applies an amount that has already been resolved to post-mitigation damage.
// This is intentionally separate from raw damage vectors because callers such
// as environmental hazards may have observed applied retail damage without a
// defensible raw damage type or resistance profile.
function applyResolvedDamageAmountToEntity(entity, resolvedDamageAmount, options = {}) {
  const requestedDamage = Math.max(0, toFiniteNumber(resolvedDamageAmount, 0));
  if (!entity || !hasDamageableHealth(entity)) {
    return {
      success: false,
      errorMsg: "ENTITY_NOT_DAMAGEABLE",
    };
  }
  if (requestedDamage <= 0) {
    return {
      success: false,
      errorMsg: "RESOLVED_DAMAGE_AMOUNT_INVALID",
    };
  }

  const maxLayers = getEntityMaxHealthLayers(entity);
  const startingLayers = getEntityCurrentHealthLayers(entity, maxLayers);
  const beforeLayers = { ...startingLayers };
  const beforeConditionState = {
    ...(entity.conditionState || {}),
  };
  const beforeArmorDamageAmount = maxLayers.armor > 0
    ? maxLayers.armor * Math.max(
      0,
      toFiniteNumber(beforeConditionState.armorDamage, 0),
    )
    : 0;
  let remainingDamage = requestedDamage;
  const perLayer = [];

  for (const layerName of ["shield", "armor", "structure"]) {
    const maxHP = maxLayers[layerName];
    const beforeHP = startingLayers[layerName];
    const appliedEffective =
      maxHP > 0 && beforeHP > 0 && remainingDamage > 0
        ? Math.min(beforeHP, remainingDamage)
        : 0;
    startingLayers[layerName] = Math.max(0, beforeHP - appliedEffective);
    remainingDamage = Math.max(0, remainingDamage - appliedEffective);
    perLayer.push({
      layer: layerName,
      maxHP: round6(maxHP),
      beforeHP: round6(beforeHP),
      afterHP: round6(startingLayers[layerName]),
      appliedRaw: normalizeDamageVector(null),
      appliedEffective: round6(appliedEffective),
      appliedResolved: round6(appliedEffective),
    });
  }
  const armorLayerResult = perLayer.find((layer) => layer.layer === "armor") || null;
  const nextArmorDamageAmount =
    beforeArmorDamageAmount +
    toFiniteNumber(armorLayerResult && armorLayerResult.appliedEffective, 0);

  entity.conditionState = {
    ...(entity.conditionState || {}),
    damage:
      maxLayers.structure > 0
        ? round6(1 - clamp(startingLayers.structure / maxLayers.structure, 0, 1))
        : 1,
    charge: clamp(
      toFiniteNumber(
        beforeConditionState.charge,
        entity.capacitorChargeRatio === undefined ? 1 : entity.capacitorChargeRatio,
      ),
      0,
      1,
    ),
    armorDamage: maxLayers.armor > 0
      ? round6(nextArmorDamageAmount / maxLayers.armor)
      : 0,
    shieldCharge:
      maxLayers.shield > 0
        ? round6(clamp(startingLayers.shield / maxLayers.shield, 0, 1))
        : 0,
    incapacitated:
      options.incapacitated === undefined || options.incapacitated === null
        ? Boolean(beforeConditionState.incapacitated)
        : Boolean(options.incapacitated),
  };

  return {
    success: true,
    data: {
      maxLayers: {
        shield: round6(maxLayers.shield),
        armor: round6(maxLayers.armor),
        structure: round6(maxLayers.structure),
      },
      beforeLayers: {
        shield: round6(beforeLayers.shield),
        armor: round6(beforeLayers.armor),
        structure: round6(beforeLayers.structure),
      },
      afterLayers: {
        shield: round6(startingLayers.shield),
        armor: round6(startingLayers.armor),
        structure: round6(startingLayers.structure),
      },
      beforeConditionState,
      afterConditionState: {
        ...entity.conditionState,
      },
      perLayer,
      rawDamage: normalizeDamageVector(null),
      remainingRaw: normalizeDamageVector(null),
      resolvedDamageAmount: round6(requestedDamage),
      remainingResolvedDamage: round6(remainingDamage),
      destroyed:
        maxLayers.structure > 0 &&
        startingLayers.structure <= 1e-9 &&
        requestedDamage > 0,
    },
  };
}

module.exports = {
  DAMAGE_TYPES,
  normalizeDamageVector,
  sumDamageVector,
  hasDamageableHealth,
  getEntityMaxHealthLayers,
  getEntityCurrentHealthLayers,
  buildDamageState,
  buildLiveDamageState,
  applyDamageToEntity,
  applyResolvedDamageAmountToEntity,
};
