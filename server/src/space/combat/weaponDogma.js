"use strict";

const {
  round6,
  toFiniteNumber,
} = require("../../common/numbers");

const path = require("path");

const {
  getAttributeIDByNames,
  getEffectTypeRecord,
  getTypeEffectRecords,
  getPassiveModifierEffectRecords,
  getTypeAttributeMap,
  cloneAttributeMap,
  typeHasEffectName,
  listFittedItems,
  listFittedItemsForLocation,
  getPassiveModifierSourceItems,
  isPassiveModifierSource,
  appendDirectModifierEntries,
  appendSelfItemModifierEntries,
  appendLocationModifierEntries,
  buildEffectiveItemAttributeMap,
  indexOverloadEffectRecordsByModuleID,
  buildProjectedModuleSourceAttributeMap,
  isStructureDogmaHost,
  isChargeCompatibleWithModule,
  resolveDogmaSkillMapForHost,
  applyOtherItemModifiersToAttributes,
  applyModifierGroups,
} = require(path.join(__dirname, "../../services/fitting/liveFittingState"));
const {
  buildNpcEffectiveModuleItem,
} = require(path.join(__dirname, "../npc/npcCapabilityResolver"));
const {
  TABLE,
  readStaticRows,
} = require(path.join(__dirname, "../../services/_shared/referenceData"));
const {
  getActiveImplantCharacterModifierEntries,
  getActiveImplantLocationModifierSources,
  getActiveImplantShipModifierEntries,
} = require(path.join(
  __dirname,
  "../../services/dogma/implants/activeImplantModifiers",
));

const ATTRIBUTE_CAPACITOR_NEED = getAttributeIDByNames("capacitorNeed") || 6;
const ATTRIBUTE_SPEED = getAttributeIDByNames("speed") || 51;
const ATTRIBUTE_MAX_VELOCITY = getAttributeIDByNames("maxVelocity") || 37;
const ATTRIBUTE_MAX_RANGE = getAttributeIDByNames("maxRange") || 54;
const ATTRIBUTE_FALLOFF = getAttributeIDByNames("falloff") || 158;
const ATTRIBUTE_TRACKING_SPEED = getAttributeIDByNames("trackingSpeed") || 160;
const ATTRIBUTE_CHARGE_SIZE = getAttributeIDByNames("chargeSize") || 128;
const ATTRIBUTE_OPTIMAL_SIG_RADIUS = getAttributeIDByNames("optimalSigRadius") || 620;
const ATTRIBUTE_DAMAGE_MULTIPLIER = getAttributeIDByNames("damageMultiplier") || 64;
const ATTRIBUTE_MISSILE_DAMAGE_MULTIPLIER =
  getAttributeIDByNames("missileDamageMultiplier") || 212;
const ATTRIBUTE_EM_DAMAGE = getAttributeIDByNames("emDamage") || 114;
const ATTRIBUTE_EXPLOSIVE_DAMAGE = getAttributeIDByNames("explosiveDamage") || 116;
const ATTRIBUTE_KINETIC_DAMAGE = getAttributeIDByNames("kineticDamage") || 117;
const ATTRIBUTE_THERMAL_DAMAGE = getAttributeIDByNames("thermalDamage") || 118;
const ATTRIBUTE_SKILL_LEVEL = getAttributeIDByNames("skillLevel") || 280;
const ATTRIBUTE_EXPLOSION_DELAY = getAttributeIDByNames("explosionDelay") || 281;
const ATTRIBUTE_AOE_VELOCITY = getAttributeIDByNames("aoeVelocity") || 653;
const ATTRIBUTE_AOE_CLOUD_SIZE = getAttributeIDByNames("aoeCloudSize") || 654;
const ATTRIBUTE_DOT_DURATION = getAttributeIDByNames("dotDuration");
const ATTRIBUTE_DOT_MAX_DAMAGE = getAttributeIDByNames("dotMaxDamagePerTick");
const ATTRIBUTE_DOT_HP_PERCENTAGE = getAttributeIDByNames("dotMaxHPPercentagePerTick");
const ATTRIBUTE_AOE_DAMAGE_REDUCTION_FACTOR =
  getAttributeIDByNames("aoeDamageReductionFactor") || 1353;
const ATTRIBUTE_AOE_DAMAGE_REDUCTION_SENSITIVITY =
  getAttributeIDByNames("aoeDamageReductionSensitivity") || 1354;
const ATTRIBUTE_VORTON_ARC_RANGE = getAttributeIDByNames("VortonArcRange") || 3036;
const ATTRIBUTE_VORTON_ARC_TARGETS = getAttributeIDByNames("VortonArcTargets") || 3037;

const ENERGY_TURRET_GROUP_ID = 53;
const PROJECTILE_TURRET_GROUP_ID = 55;
const HYBRID_TURRET_GROUP_ID = 74;
const PRECURSOR_WEAPON_GROUP_ID = 1986;
const VORTON_PROJECTOR_GROUP_ID = 4060;
const PROJECTILE_AMMO_GROUP_ID = 83;
const HYBRID_CHARGE_GROUP_ID = 85;
const FREQUENCY_CRYSTAL_GROUP_ID = 86;
const EXOTIC_PLASMA_GROUP_ID = 1987;
const ADVANCED_EXOTIC_PLASMA_GROUP_ID = 1989;
// Every vorton projector declares chargeGroup1 = 4062 (Condenser Pack). Only
// the T2 and Consortium types add chargeGroup2 = 4061 (Advanced Condenser
// Pack), so an "Ultra" pack is a T2/faction privilege - the T1, Compact and
// Scoped projectors cannot load one. Both groups map to the vorton family here
// because either one identifies the weapon; fitment is gated separately by
// isChargeCompatibleWithModule.
const CONDENSER_PACK_GROUP_ID = 4061;
const ADVANCED_CONDENSER_PACK_GROUP_ID = 4062;
const LIGHT_MISSILE_GROUP_ID = 384;
const HEAVY_MISSILE_GROUP_ID = 385;
const CRUISE_MISSILE_GROUP_ID = 386;
const ROCKET_GROUP_ID = 387;
const TORPEDO_GROUP_ID = 89;
const XL_TORPEDO_GROUP_ID = 476;
const XL_CRUISE_MISSILE_GROUP_ID = 1019;
const HEAVY_ASSAULT_MISSILE_GROUP_ID = 772;
const DEFENDER_MISSILE_GROUP_ID = 88;
const HEAVY_DEFENDER_MISSILE_GROUP_ID = 1158;
const CRUISE_MISSILE_LAUNCHER_GROUP_ID = 506;
const ROCKET_LAUNCHER_GROUP_ID = 507;
const TORPEDO_LAUNCHER_GROUP_ID = 508;
const LIGHT_MISSILE_LAUNCHER_GROUP_ID = 509;
const HEAVY_MISSILE_LAUNCHER_GROUP_ID = 510;
const DEFENDER_LAUNCHER_GROUP_ID = 512;
const XL_TORPEDO_LAUNCHER_GROUP_ID = 524;
const RAPID_LIGHT_MISSILE_LAUNCHER_GROUP_ID = 511;
const HEAVY_ASSAULT_MISSILE_LAUNCHER_GROUP_ID = 771;
const XL_CRUISE_MISSILE_LAUNCHER_GROUP_ID = 1674;
const RAPID_HEAVY_MISSILE_LAUNCHER_GROUP_ID = 1245;
const STRUCTURE_XL_MISSILE_LAUNCHER_GROUP_ID = 1327;
const STRUCTURE_GUIDED_BOMB_LAUNCHER_GROUP_ID = 1328;
const STRUCTURE_MULTIROLE_MISSILE_LAUNCHER_GROUP_ID = 1562;
const STRUCTURE_ANTI_CAPITAL_MISSILE_GROUP_ID = 1546;
const STRUCTURE_ANTI_SUBCAPITAL_MISSILE_GROUP_ID = 1547;
const STRUCTURE_GUIDED_BOMB_GROUP_ID = 1548;
const MISSILE_DEPLOYMENT_GUID = "effects.MissileDeployment";
const TORPEDO_DEPLOYMENT_GUID = "effects.TorpedoDeployment";
const VORTON_VISUAL_GUID_BY_CHARGE_SIZE = Object.freeze({
  1: "effects.UpwellChainWeaponSmall",
  2: "effects.UpwellChainWeaponMedium",
  3: "effects.UpwellChainWeaponLarge",
});
const ACTIVATABLE_EFFECT_CATEGORIES = new Set([1, 2, 3]);
const PASSIVE_SLOT_EFFECTS = new Set([
  "online",
  "onlineforstructures",
  "anchordropforstructures",
  "anchorliftforstructures",
  "hipower",
  "medpower",
  "lopower",
  "rigslot",
  "subsystem",
  "turretfitted",
  "launcherfitted",
]);
const WEAPON_FAMILY_BY_MODULE_GROUP_ID = Object.freeze({
  [ENERGY_TURRET_GROUP_ID]: "laserTurret",
  [PROJECTILE_TURRET_GROUP_ID]: "projectileTurret",
  [HYBRID_TURRET_GROUP_ID]: "hybridTurret",
  [PRECURSOR_WEAPON_GROUP_ID]: "precursorTurret",
  [VORTON_PROJECTOR_GROUP_ID]: "vortonProjector",
});
const WEAPON_FAMILY_BY_CHARGE_GROUP_ID = Object.freeze({
  [PROJECTILE_AMMO_GROUP_ID]: "projectileTurret",
  [HYBRID_CHARGE_GROUP_ID]: "hybridTurret",
  [FREQUENCY_CRYSTAL_GROUP_ID]: "laserTurret",
  [EXOTIC_PLASMA_GROUP_ID]: "precursorTurret",
  [ADVANCED_EXOTIC_PLASMA_GROUP_ID]: "precursorTurret",
  [CONDENSER_PACK_GROUP_ID]: "vortonProjector",
  [ADVANCED_CONDENSER_PACK_GROUP_ID]: "vortonProjector",
});
const STANDARD_MISSILE_CHARGE_GROUP_IDS = new Set([
  LIGHT_MISSILE_GROUP_ID,
  HEAVY_MISSILE_GROUP_ID,
  CRUISE_MISSILE_GROUP_ID,
  ROCKET_GROUP_ID,
  TORPEDO_GROUP_ID,
  XL_TORPEDO_GROUP_ID,
  XL_CRUISE_MISSILE_GROUP_ID,
  HEAVY_ASSAULT_MISSILE_GROUP_ID,
  STRUCTURE_ANTI_CAPITAL_MISSILE_GROUP_ID,
  STRUCTURE_ANTI_SUBCAPITAL_MISSILE_GROUP_ID,
  STRUCTURE_GUIDED_BOMB_GROUP_ID,
]);
const DEFENDER_MISSILE_CHARGE_GROUP_IDS = new Set([
  DEFENDER_MISSILE_GROUP_ID,
  HEAVY_DEFENDER_MISSILE_GROUP_ID,
]);
const STANDARD_MISSILE_LAUNCHER_GROUP_IDS = new Set([
  CRUISE_MISSILE_LAUNCHER_GROUP_ID,
  ROCKET_LAUNCHER_GROUP_ID,
  TORPEDO_LAUNCHER_GROUP_ID,
  LIGHT_MISSILE_LAUNCHER_GROUP_ID,
  HEAVY_MISSILE_LAUNCHER_GROUP_ID,
  XL_TORPEDO_LAUNCHER_GROUP_ID,
  RAPID_LIGHT_MISSILE_LAUNCHER_GROUP_ID,
  HEAVY_ASSAULT_MISSILE_LAUNCHER_GROUP_ID,
  XL_CRUISE_MISSILE_LAUNCHER_GROUP_ID,
  RAPID_HEAVY_MISSILE_LAUNCHER_GROUP_ID,
  STRUCTURE_XL_MISSILE_LAUNCHER_GROUP_ID,
  STRUCTURE_GUIDED_BOMB_LAUNCHER_GROUP_ID,
  STRUCTURE_MULTIROLE_MISSILE_LAUNCHER_GROUP_ID,
]);
const DEFENDER_MISSILE_LAUNCHER_GROUP_IDS = new Set([
  DEFENDER_LAUNCHER_GROUP_ID,
]);
const CHARACTER_DIRECT_MODIFIER_OPTIONS = Object.freeze({
  allowedDomains: new Set(["charID"]),
  allowedFuncs: new Set(["ItemModifier"]),
});
const DEFAULT_MISSILE_DAMAGE_REDUCTION_SENSITIVITY = 5.5;
let cachedSkillEffectiveAttributes = null;
let cachedShipModifierAttributes = null;
let cachedSkillLevelShipBonusScalers = null;

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function clamp(value, min, max) {
  return Math.min(Math.max(toFiniteNumber(value, min), min), max);
}

function ensureSkillEffectiveAttributeCache() {
  if (!cachedSkillEffectiveAttributes) {
    cachedSkillEffectiveAttributes = new Map();
  }
  return cachedSkillEffectiveAttributes;
}

function ensureShipModifierAttributeCache() {
  if (!cachedShipModifierAttributes) {
    cachedShipModifierAttributes = new Map();
  }
  return cachedShipModifierAttributes;
}

// A hull's `shipBonus*` attribute is a PER-LEVEL coefficient, not a bonus. It
// only becomes a real number once the racial skill's `ItemModifier` / `shipID`
// effect multiplies it by that skill's level — effect 460
// `caldariFrigateSkillLevelPreMulShipBonusCFShip` turns the Griffin Navy
// Issue's `shipBonusCF` 10 into 10 x level. Walking only the skills PRESENT in
// the map skips that multiply for a skill the pilot has not trained, which
// leaves the raw coefficient standing and makes the hull read exactly as if the
// skill were at level 1.
//
// The correct default is 0 on every authority: `skillState`'s own
// DEFAULT_MISSING_SKILL_LEVEL is 0, and the client coerces a missing level the
// same way (`characterskills.GetSkillLevelRaw(0 sp) === 0`,
// `GetEffectiveLevel(...) or 0`, `if skillLevel is None: skillLevel = 0`).
//
// This index is the exact population: attributeID -> the rows that scale it by
// skillLevel (280) through ItemModifier / shipID. In this SDE build that is 364
// attributes over 91 skills, one scaler skill each, every one operation 0 or 4
// (multiply). So evaluating an absent scaler at level 0 can only zero a
// coefficient the hull already declares — it can never create or set an
// attribute, and it can never overwrite a scaling a PRESENT skill applied.
function getSkillLevelShipBonusScalerIndex() {
  if (cachedSkillLevelShipBonusScalers) {
    return cachedSkillLevelShipBonusScalers;
  }

  const index = new Map();
  for (const skillType of readStaticRows(TABLE.SKILL_TYPES)) {
    const skillTypeID = toInt(skillType && skillType.typeID, 0);
    if (skillTypeID <= 0) {
      continue;
    }
    for (const effectRecord of getTypeEffectRecords(skillTypeID)) {
      for (const modifier of effectRecord.modifierInfo || []) {
        if (
          !modifier ||
          modifier.func !== "ItemModifier" ||
          modifier.domain !== "shipID" ||
          toInt(modifier.modifyingAttributeID, 0) !== ATTRIBUTE_SKILL_LEVEL
        ) {
          continue;
        }
        const modifiedAttributeID = toInt(modifier.modifiedAttributeID, 0);
        if (modifiedAttributeID <= 0) {
          continue;
        }
        if (!index.has(modifiedAttributeID)) {
          index.set(modifiedAttributeID, []);
        }
        index.get(modifiedAttributeID).push({
          skillTypeID,
          operation: toInt(modifier.operation, 0),
        });
      }
    }
  }

  cachedSkillLevelShipBonusScalers = index;
  return index;
}

// Run the scalers whose skill is MISSING from the pilot's sheet at level 0.
//
// Gated on a non-empty skill map on purpose. An empty map is not "a pilot who
// trained nothing", it is "there is no pilot" — an NPC or synthetic hull, whose
// bonus attributes are the only stats it has. Zeroing those would delete the
// hull's profile outright, which is the failure mode this audit has already
// paid for once. A structure host is covered by the same gate plus the fact
// that no structure type declares a skill-scaled bonus attribute at all.
function applyAbsentSkillLevelShipBonusScalers(shipAttributes, resolvedSkillMap) {
  if (!(resolvedSkillMap instanceof Map) || resolvedSkillMap.size <= 0) {
    return;
  }

  const index = getSkillLevelShipBonusScalerIndex();
  for (const attributeID of Object.keys(shipAttributes)) {
    const numericAttributeID = toInt(attributeID, 0);
    const scalers = numericAttributeID > 0 ? index.get(numericAttributeID) : null;
    if (!scalers) {
      continue;
    }
    for (const scaler of scalers) {
      if (resolvedSkillMap.has(scaler.skillTypeID)) {
        continue;
      }
      applyDirectModifier(shipAttributes, numericAttributeID, 0, scaler.operation);
    }
  }
}

function resolveSkillLevel(skillRecord) {
  return Math.max(
    0,
    toInt(
      skillRecord && (
        skillRecord.effectiveSkillLevel ??
        skillRecord.trainedSkillLevel ??
        skillRecord.skillLevel
      ),
      0,
    ),
  );
}

function buildSkillProfileCacheKey(skillMap) {
  if (!(skillMap instanceof Map) || skillMap.size === 0) {
    return "";
  }

  const keyParts = [];
  for (const skillRecord of skillMap.values()) {
    const skillTypeID = toInt(skillRecord && skillRecord.typeID, 0);
    if (skillTypeID <= 0) {
      continue;
    }
    keyParts.push(`${skillTypeID}:${resolveSkillLevel(skillRecord)}`);
  }
  return keyParts.join(",");
}

function getModuleChargeGroupIDs(itemOrTypeID) {
  const attributeMap = buildEffectiveItemAttributeMap(itemOrTypeID);
  const chargeGroupIDs = new Set();
  for (let index = 1; index <= 5; index += 1) {
    const chargeGroupID = toInt(
      attributeMap[getAttributeIDByNames(`chargeGroup${index}`)],
      0,
    );
    if (chargeGroupID > 0) {
      chargeGroupIDs.add(chargeGroupID);
    }
  }
  return chargeGroupIDs;
}

function resolveWeaponActivationEffect(typeID) {
  for (const effectRecord of getTypeEffectRecords(typeID)) {
    if (
      !effectRecord ||
      !ACTIVATABLE_EFFECT_CATEGORIES.has(toInt(effectRecord.effectCategoryID, 0))
    ) {
      continue;
    }
    const normalizedName = String(effectRecord.name || "").trim().toLowerCase();
    if (PASSIVE_SLOT_EFFECTS.has(normalizedName)) {
      continue;
    }
    return effectRecord;
  }
  return null;
}

function normalizeEffectGUID(guid) {
  const normalizedGUID = String(guid || "").trim();
  return normalizedGUID && normalizedGUID.toLowerCase() !== "none"
    ? normalizedGUID
    : "";
}

function resolveWeaponSpecialFxGUID({
  family = null,
  moduleItem = null,
  chargeItem = null,
  activationEffect = null,
} = {}) {
  const explicitGUID = normalizeEffectGUID(activationEffect && activationEffect.guid);
  const resolvedFamily = family || resolveWeaponFamily(moduleItem, chargeItem);
  if (isVortonWeaponFamily(resolvedFamily)) {
    // ChainLightning's SDE GUID only changes the ship's attack pose. The client
    // effects registry binds these size-specific GUIDs to ChainWeaponEffect and
    // the chain turret stretch graphics; the class name itself is not a GUID.
    const chargeSize = toInt(
      buildEffectiveItemAttributeMap(moduleItem)[ATTRIBUTE_CHARGE_SIZE],
      0,
    );
    const visualGUID = VORTON_VISUAL_GUID_BY_CHARGE_SIZE[chargeSize];
    if (visualGUID) {
      const guids = explicitGUID
        ? explicitGUID.split(",").map((guid) => guid.trim()).filter(Boolean)
        : [];
      if (!guids.includes(visualGUID)) {
        guids.push(visualGUID);
      }
      return guids.join(",");
    }
  }
  if (explicitGUID) {
    return explicitGUID;
  }

  if (!isMissileWeaponFamily(resolvedFamily)) {
    return "";
  }

  const chargeGroupID = toInt(chargeItem && chargeItem.groupID, 0);
  const moduleGroupID = toInt(moduleItem && moduleItem.groupID, 0);
  if (
    chargeGroupID === TORPEDO_GROUP_ID ||
    chargeGroupID === XL_TORPEDO_GROUP_ID ||
    moduleGroupID === TORPEDO_LAUNCHER_GROUP_ID ||
    moduleGroupID === XL_TORPEDO_LAUNCHER_GROUP_ID
  ) {
    return TORPEDO_DEPLOYMENT_GUID;
  }

  return MISSILE_DEPLOYMENT_GUID;
}

function resolveWeaponChargeMode(family) {
  return family === "laserTurret" ? "crystal" : "stack";
}

function isTurretWeaponFamily(family) {
  return (
    family === "laserTurret" ||
    family === "hybridTurret" ||
    family === "projectileTurret" ||
    family === "precursorTurret"
  );
}

// A vorton projector is turretFitted and shares the turret cycle, but it carries
// no trackingSpeed and instead applies damage through aoeCloudSize/aoeVelocity
// like a missile, so it is deliberately not a turret family: resolveTurretShot
// would read tracking 0 as infinite angular error and miss every shot.
function isVortonWeaponFamily(family) {
  return family === "vortonProjector";
}

// Cycle membership is a different question from the damage model.  Everything
// driving the turret cycle - banking, reloads, grouped FX, repeat handling -
// applies to vortons too; only shot resolution differs.  Gate cycle machinery on
// this, and use isTurretWeaponFamily only where turret tracking math is meant.
function isTurretCycleWeaponFamily(family) {
  return isTurretWeaponFamily(family) || isVortonWeaponFamily(family);
}

function isMissileWeaponFamily(family) {
  return family === "missileLauncher" || family === "festivalLauncher" || isBreacherPodWeaponFamily(family);
}

function isBreacherPodWeaponFamily(family) { return family === "breacherPodLauncher"; }

function hasModuleDirectWeaponDamage(itemOrTypeID) {
  const attributeMap = buildEffectiveItemAttributeMap(itemOrTypeID);
  return (
    toFiniteNumber(attributeMap[ATTRIBUTE_EM_DAMAGE], 0) > 0 ||
    toFiniteNumber(attributeMap[ATTRIBUTE_THERMAL_DAMAGE], 0) > 0 ||
    toFiniteNumber(attributeMap[ATTRIBUTE_KINETIC_DAMAGE], 0) > 0 ||
    toFiniteNumber(attributeMap[ATTRIBUTE_EXPLOSIVE_DAMAGE], 0) > 0
  );
}

function isChargeOptionalTurretWeapon(moduleItem, chargeItem = null) {
  if (!moduleItem) {
    return false;
  }

  const family = resolveWeaponFamily(moduleItem, chargeItem);
  if (!isTurretWeaponFamily(family)) {
    return false;
  }

  if (moduleItem.npcSyntheticHullWeapon === true) {
    return true;
  }

  const effectiveModuleItem = buildNpcEffectiveModuleItem(moduleItem);
  const moduleTypeID = toInt(effectiveModuleItem && effectiveModuleItem.typeID, 0);
  if (moduleTypeID <= 0) {
    return false;
  }

  return (
    getModuleChargeGroupIDs(effectiveModuleItem).size <= 0 &&
    hasModuleDirectWeaponDamage(effectiveModuleItem)
  );
}

// A drone or a fighter is its OWN entity. It sits in the character's location,
// not the ship's, so it must not receive the ship location's modifiers. CCP's
// own rule, and the SDE bears it out exactly: `shipID` means "the modules
// fitted to this ship", and everything meant to reach an owned entity is
// written `charID` + OwnerRequiredSkillModifier.
//
// Cross-tabbed over this SDE build, the ONLY `shipID` rows gated on a drone
// skill are effects 8217/8220 `expeditionFrigateBonus*Drones*_DEPRICATED`,
// which no type carries. Every live drone or fighter bonus is `charID`: the
// drone-side skills (Drone Navigation, Mining/Repair/Salvage/Ice Drone
// Operation, the racial specializations), every hull drone damage / tracking /
// HP / range bonus, the Omnidirectional Tracking Link and Enhancer, the Drone
// Damage Amplifier, and the system-wide drone effects (Magnetar, Triglavian
// Invasion, Plasma Firestorm). What arrives through `shipID` instead is
// ship-MODULE skills that a drone happens to list as a required skill —
// Signal Dispersion leaking +25 % into ECM drone jam strength, Mining +
// Astrogeology into mining-drone yield, Salvaging into salvage drones — plus
// the module-side halves of the wormhole and storm effects.
const OWNED_ENTITY_LOCATION_MODIFIER_DOMAINS = Object.freeze(new Set(["charID"]));

function buildLocationModifiedAttributeMap(
  targetItem,
  shipItem,
  skillMap,
  shipModifierAttributes,
  fittedItems,
  activeModuleContexts,
  options = {},
) {
  if (!targetItem || !shipItem) {
    return {};
  }

  const attributes = cloneAttributeMap(buildEffectiveItemAttributeMap(targetItem));
  const modifierEntries = [];
  const isStructureHost = isStructureDogmaHost(shipItem);
  const resolvedSkillMap = resolveDogmaSkillMapForHost(0, shipItem, {
    skillMap: skillMap instanceof Map ? skillMap : new Map(),
  });
  const resolvedFittedItems = Array.isArray(fittedItems) ? fittedItems : [];
  const resolvedPassiveModifierSourceItems = getPassiveModifierSourceItems(
    shipItem,
    resolvedFittedItems,
  );
  const resolvedActiveModuleContexts = Array.isArray(activeModuleContexts)
    ? activeModuleContexts
    : [];
  const excludeItemID = toInt(options.excludeItemID, 0);
  // Drones and fighters pass ownedEntityTarget; see the note on
  // OWNED_ENTITY_LOCATION_MODIFIER_DOMAINS. Nothing structure-side reaches a
  // fighter through `structureID` either (zero rows in the SDE), so an owned
  // entity reads `charID` only on both host kinds.
  const isOwnedEntityTarget = options.ownedEntityTarget === true;
  const locationModifierDomains = isOwnedEntityTarget
    ? OWNED_ENTITY_LOCATION_MODIFIER_DOMAINS
    : isStructureHost
      ? new Set(["structureID", "charID"])
      : new Set(["shipID", "charID"]);
  const fittedModuleLocationModifierDomains = isOwnedEntityTarget
    ? OWNED_ENTITY_LOCATION_MODIFIER_DOMAINS
    : isStructureHost
      ? new Set(["structureID", "shipID", "charID"])
      : locationModifierDomains;
  const additionalLocationModifierSources = Array.isArray(
    options.additionalLocationModifierSources,
  )
    ? (isStructureHost ? [] : options.additionalLocationModifierSources)
    : [];

  for (const skillRecord of resolvedSkillMap.values()) {
    appendLocationModifierEntries(
      modifierEntries,
      peekSkillEffectiveAttributes(skillRecord),
      getTypeEffectRecords(skillRecord.typeID),
      "skill",
      targetItem,
      {
        allowedDomains: locationModifierDomains,
        sourceTypeID: skillRecord.typeID,
      },
    );
  }

  appendLocationModifierEntries(
    modifierEntries,
    shipModifierAttributes,
    getTypeEffectRecords(shipItem.typeID),
    "ship",
    targetItem,
    { allowedDomains: locationModifierDomains },
  );

  for (const fittedItem of resolvedPassiveModifierSourceItems) {
    if (
      !isPassiveModifierSource(fittedItem) ||
      (
        excludeItemID > 0 &&
        toInt(fittedItem && fittedItem.itemID, 0) === excludeItemID
      )
    ) {
      continue;
    }

    appendLocationModifierEntries(
      modifierEntries,
      buildEffectiveItemAttributeMap(fittedItem),
      getTypeEffectRecords(fittedItem.typeID),
      "fittedModule",
      targetItem,
      { allowedDomains: fittedModuleLocationModifierDomains },
    );
  }

  // An overloaded module must project the strength it actually has, not the
  // strength its type declares cold.
  const overloadEffectRecordsByModuleID = indexOverloadEffectRecordsByModuleID(
    resolvedActiveModuleContexts,
  );

  for (const activeModuleContext of resolvedActiveModuleContexts) {
    const activeModuleItem = buildNpcEffectiveModuleItem(
      activeModuleContext && activeModuleContext.moduleItem,
    );
    const activeEffectRecord =
      (activeModuleContext && activeModuleContext.effectRecord) ||
      getEffectTypeRecord(activeModuleContext && activeModuleContext.effectID);
    if (!activeModuleItem || !activeEffectRecord) {
      continue;
    }

    if (
      (
        activeModuleContext &&
        activeModuleContext.effectState &&
        activeModuleContext.effectState.isOverload === true
      ) ||
      toInt(activeEffectRecord.effectCategoryID, 0) === 5
    ) {
      if (
        toInt(activeModuleItem.itemID, 0) === toInt(targetItem && targetItem.itemID, 0)
      ) {
        appendSelfItemModifierEntries(
          modifierEntries,
          buildEffectiveItemAttributeMap(
            activeModuleItem,
            activeModuleContext && activeModuleContext.chargeItem,
          ),
          [activeEffectRecord],
          "fittedModule",
        );
      }
    }

    appendLocationModifierEntries(
      modifierEntries,
      buildProjectedModuleSourceAttributeMap(
        activeModuleItem,
        activeModuleContext && activeModuleContext.chargeItem,
        overloadEffectRecordsByModuleID.get(toInt(activeModuleItem.itemID, 0)),
      ),
      [activeEffectRecord],
      "fittedModule",
      targetItem,
      { allowedDomains: locationModifierDomains },
    );
  }

  for (const source of additionalLocationModifierSources) {
    if (!source || typeof source !== "object") {
      continue;
    }
    appendLocationModifierEntries(
      modifierEntries,
      source.sourceAttributes,
      source.sourceEffects,
      String(source.sourceKind || "system"),
      targetItem,
      { allowedDomains: locationModifierDomains },
    );
  }

  applyModifierGroups(attributes, modifierEntries);
  return attributes;
}

function collectCharacterModifierAttributes(
  skillMap,
  fittedItems,
  activeModuleContexts,
  options = {},
) {
  const characterAttributes = {
    [ATTRIBUTE_MISSILE_DAMAGE_MULTIPLIER]: 1,
  };
  const modifierEntries = [];
  const resolvedSkillMap = skillMap instanceof Map ? skillMap : new Map();
  const resolvedFittedItems = Array.isArray(fittedItems) ? fittedItems : [];
  const resolvedActiveModuleContexts = Array.isArray(activeModuleContexts)
    ? activeModuleContexts
    : [];
  const additionalDirectModifierEntries = Array.isArray(
    options.additionalDirectModifierEntries,
  )
    ? options.additionalDirectModifierEntries
    : [];

  for (const skillRecord of resolvedSkillMap.values()) {
    appendDirectModifierEntries(
      modifierEntries,
      peekSkillEffectiveAttributes(skillRecord),
      getTypeEffectRecords(skillRecord.typeID),
      "skill",
      CHARACTER_DIRECT_MODIFIER_OPTIONS,
    );
  }

  for (const fittedItem of resolvedFittedItems) {
    if (!isPassiveModifierSource(fittedItem)) {
      continue;
    }

    const passiveSourceEffects = getPassiveModifierEffectRecords(fittedItem.typeID);
    if (passiveSourceEffects.length <= 0) {
      continue;
    }

    appendDirectModifierEntries(
      modifierEntries,
      buildEffectiveItemAttributeMap(fittedItem),
      passiveSourceEffects,
      "fittedModule",
      CHARACTER_DIRECT_MODIFIER_OPTIONS,
    );
  }

  for (const activeModuleContext of resolvedActiveModuleContexts) {
    const activeModuleItem = buildNpcEffectiveModuleItem(
      activeModuleContext && activeModuleContext.moduleItem,
    );
    const activeEffectRecord =
      (activeModuleContext && activeModuleContext.effectRecord) ||
      getEffectTypeRecord(activeModuleContext && activeModuleContext.effectID);
    if (!activeModuleItem || !activeEffectRecord) {
      continue;
    }

    appendDirectModifierEntries(
      modifierEntries,
      buildEffectiveItemAttributeMap(
        activeModuleItem,
        activeModuleContext && activeModuleContext.chargeItem,
      ),
      [activeEffectRecord],
      "fittedModule",
      CHARACTER_DIRECT_MODIFIER_OPTIONS,
    );
  }

  applyModifierGroups(characterAttributes, [
    ...modifierEntries,
    ...additionalDirectModifierEntries,
  ]);
  return characterAttributes;
}

// A skill's effective attributes at its level, as cached: frozen, for a
// caller that only reads them. Every module's live attributes read every
// skill's, so a copy each time cost more than the read
// (buildSkillEffectiveAttributes copies them for a caller that writes).
function peekSkillEffectiveAttributes(skillRecord) {
  const typeID = toInt(skillRecord && skillRecord.typeID, 0);
  const level = resolveSkillLevel(skillRecord);
  const cacheKey = `${typeID}:${level}`;
  const cache = ensureSkillEffectiveAttributeCache();
  const cached = cache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const attributes = getTypeAttributeMap(typeID);
  attributes[ATTRIBUTE_SKILL_LEVEL] = level;

  for (const effectRecord of getTypeEffectRecords(typeID)) {
    if (String(effectRecord.name || "").toLowerCase() === "skilleffect") {
      continue;
    }
    for (const modifier of effectRecord.modifierInfo || []) {
      if (
        modifier.func !== "ItemModifier" ||
        modifier.domain !== "itemID" ||
        toInt(modifier.modifiedAttributeID, 0) === ATTRIBUTE_SKILL_LEVEL
      ) {
        continue;
      }

      applyDirectModifier(
        attributes,
        modifier.modifiedAttributeID,
        attributes[modifier.modifyingAttributeID],
        modifier.operation,
      );
    }
  }

  const frozen = Object.freeze(attributes);
  cache.set(cacheKey, frozen);
  return frozen;
}

function buildSkillEffectiveAttributes(skillRecord) {
  return cloneAttributeMap(peekSkillEffectiveAttributes(skillRecord));
}

function applyDirectModifier(attributes, attributeID, rawValue, operation) {
  const numericAttributeID = toInt(attributeID, 0);
  const value = toFiniteNumber(rawValue, NaN);
  if (numericAttributeID <= 0 || !Number.isFinite(value)) {
    return;
  }

  const currentValue = toFiniteNumber(attributes[numericAttributeID], NaN);
  switch (toInt(operation, 0)) {
    case 0:
    case 4: {
      const base = Number.isFinite(currentValue) ? currentValue : 1;
      attributes[numericAttributeID] = round6(base * value);
      break;
    }
    case 2: {
      const base = Number.isFinite(currentValue) ? currentValue : 0;
      attributes[numericAttributeID] = round6(base + value);
      break;
    }
    case 3: {
      const base = Number.isFinite(currentValue) ? currentValue : 0;
      attributes[numericAttributeID] = round6(base - value);
      break;
    }
    case 5: {
      const base = Number.isFinite(currentValue) ? currentValue : 1;
      if (Math.abs(value) > 1e-9) {
        attributes[numericAttributeID] = round6(base / value);
      }
      break;
    }
    case 6: {
      const base = Number.isFinite(currentValue) ? currentValue : 0;
      attributes[numericAttributeID] = round6(base * (1 + (value / 100)));
      break;
    }
    case 7: {
      attributes[numericAttributeID] = round6(value);
      break;
    }
    default:
      break;
  }
}

const SHIP_ITEM_MODIFIER_OPTIONS = Object.freeze({
  allowedDomains: new Set(["shipID"]),
  allowedFuncs: new Set(["ItemModifier"]),
});
const STRUCTURE_ITEM_MODIFIER_OPTIONS = Object.freeze({
  allowedDomains: new Set(["structureID", "shipID"]),
  allowedFuncs: new Set(["ItemModifier"]),
});

function collectShipModifierAttributes(
  shipItem,
  skillMap,
  activeModuleContexts = null,
  options = {},
) {
  const shipTypeID = toInt(shipItem && shipItem.typeID, 0);
  const isStructureHost = isStructureDogmaHost(shipItem);
  const resolvedSkillMap = resolveDogmaSkillMapForHost(0, shipItem, {
    skillMap: skillMap instanceof Map ? skillMap : new Map(),
  });
  const cacheKey = `${shipTypeID}|${buildSkillProfileCacheKey(resolvedSkillMap)}`;
  const cache = ensureShipModifierAttributeCache();
  const cached = cache.get(cacheKey);
  const baseShipAttributes = cached
    ? cloneAttributeMap(cached)
    : (() => {
      const shipAttributes = getTypeAttributeMap(shipTypeID);
      for (const skillRecord of resolvedSkillMap.values()) {
        const effectiveSkillAttributes = peekSkillEffectiveAttributes(skillRecord);
        for (const effectRecord of getTypeEffectRecords(skillRecord.typeID)) {
          for (const modifier of effectRecord.modifierInfo || []) {
            if (
              modifier.func !== "ItemModifier" ||
              modifier.domain !== "shipID"
            ) {
              continue;
            }
            applyDirectModifier(
              shipAttributes,
              modifier.modifiedAttributeID,
              effectiveSkillAttributes[modifier.modifyingAttributeID],
              modifier.operation,
            );
          }
        }
      }
      // A skill missing from a pilot's sheet is untrained, which is level 0 —
      // not level 1. Run the scalers the loop above could not reach.
      applyAbsentSkillLevelShipBonusScalers(shipAttributes, resolvedSkillMap);
      const frozen = Object.freeze(shipAttributes);
      cache.set(cacheKey, frozen);
      return cloneAttributeMap(frozen);
    })();

  const resolvedActiveModuleContexts = Array.isArray(activeModuleContexts)
    ? activeModuleContexts
    : [];
  const resolvedFittedItems = Array.isArray(options.fittedItems)
    ? options.fittedItems
    : [];
  const hiddenModifierSourceOptions = Array.isArray(options.hiddenModifierItems)
    ? { hiddenModifierItems: options.hiddenModifierItems }
    : {};
  const additionalDirectModifierEntries = !isStructureHost && Array.isArray(
    options.additionalDirectModifierEntries,
  )
    ? options.additionalDirectModifierEntries
    : [];
  const hiddenModifierSources = getPassiveModifierSourceItems(
    shipItem,
    [],
    hiddenModifierSourceOptions,
  );
  const fittedModifierSources = isStructureHost
    ? getPassiveModifierSourceItems(
      shipItem,
      resolvedFittedItems,
      hiddenModifierSourceOptions,
    )
    : hiddenModifierSources;
  if (
    resolvedActiveModuleContexts.length <= 0 &&
    additionalDirectModifierEntries.length <= 0 &&
    fittedModifierSources.length <= 0
  ) {
    return baseShipAttributes;
  }

  const modifierEntries = [];
  for (const modifierSource of fittedModifierSources) {
    if (!isPassiveModifierSource(modifierSource)) {
      continue;
    }
    appendDirectModifierEntries(
      modifierEntries,
      buildEffectiveItemAttributeMap(modifierSource),
      getPassiveModifierEffectRecords(modifierSource.typeID),
      "fittedModule",
      isStructureHost ? STRUCTURE_ITEM_MODIFIER_OPTIONS : SHIP_ITEM_MODIFIER_OPTIONS,
    );
  }
  for (const activeModuleContext of resolvedActiveModuleContexts) {
    const activeModuleItem = buildNpcEffectiveModuleItem(
      activeModuleContext && activeModuleContext.moduleItem,
    );
    const activeEffectRecord =
      (activeModuleContext && activeModuleContext.effectRecord) ||
      getEffectTypeRecord(activeModuleContext && activeModuleContext.effectID);
    if (!activeModuleItem || !activeEffectRecord) {
      continue;
    }

    appendDirectModifierEntries(
      modifierEntries,
      buildEffectiveItemAttributeMap(
        activeModuleItem,
        activeModuleContext && activeModuleContext.chargeItem,
      ),
      [activeEffectRecord],
      "fittedModule",
      SHIP_ITEM_MODIFIER_OPTIONS,
    );
  }
  applyModifierGroups(baseShipAttributes, [
    ...modifierEntries,
    ...additionalDirectModifierEntries,
  ]);
  return baseShipAttributes;
}

function resolveWeaponFamily(moduleItem, chargeItem = null) {
  const explicitFamily = String(
    moduleItem && (
      moduleItem.npcWeaponFamily ??
      moduleItem.weaponFamily
    ) || "",
  ).trim();
  if (explicitFamily) {
    return explicitFamily;
  }

  const effectiveModuleItem = buildNpcEffectiveModuleItem(moduleItem);
  const moduleTypeID = toInt(effectiveModuleItem && effectiveModuleItem.typeID, 0);
  if (moduleTypeID <= 0) {
    return null;
  }
  const moduleGroupID = toInt(effectiveModuleItem && effectiveModuleItem.groupID, 0);
  if (moduleGroupID === 862 && typeHasEffectName(moduleTypeID, "useMissiles")) {
    return "bombLauncher";
  }
  if (moduleGroupID === 4807 && typeHasEffectName(moduleTypeID, "useMissiles")) {
    return "breacherPodLauncher";
  }
  // Current POS batteries have entity/structure firing effects, not the
  // turretFitted/useMissiles effects used by ship modules. Their ammunition
  // still goes through the ordinary compatibility and weapon snapshot path.
  if (toInt(effectiveModuleItem.categoryID, 0) === 23) {
    const batteryFamilies = {
      426: "projectileTurret", 449: "hybridTurret", 430: "laserTurret",
      417: "missileLauncher",
    };
    if (batteryFamilies[moduleGroupID]) return batteryFamilies[moduleGroupID];
  }
  const chargeGroupID = toInt(chargeItem && chargeItem.groupID, 0);
  // Festival charges share native missile flight/presentation, but never
  // damage or aggression. An unloaded festival module remains unclassified.
  if (moduleGroupID === 501 && chargeGroupID === 500 &&
      typeHasEffectName(moduleTypeID, "useMissiles")) {
    return "festivalLauncher";
  }
  const isMissileLauncher =
    typeHasEffectName(moduleTypeID, "useMissiles") &&
    (
      typeHasEffectName(moduleTypeID, "launcherFitted") ||
      DEFENDER_MISSILE_LAUNCHER_GROUP_IDS.has(moduleGroupID) ||
      STANDARD_MISSILE_LAUNCHER_GROUP_IDS.has(moduleGroupID)
    );
  if (isMissileLauncher) {
    const moduleChargeGroupIDs = getModuleChargeGroupIDs(effectiveModuleItem);
    if (DEFENDER_MISSILE_CHARGE_GROUP_IDS.has(chargeGroupID)) {
      if (
        DEFENDER_MISSILE_LAUNCHER_GROUP_IDS.has(moduleGroupID) ||
        moduleChargeGroupIDs.has(chargeGroupID)
      ) {
        return "missileLauncher";
      }
      return null;
    }

    if (STANDARD_MISSILE_CHARGE_GROUP_IDS.has(chargeGroupID)) {
      return "missileLauncher";
    }

    for (const standardChargeGroupID of STANDARD_MISSILE_CHARGE_GROUP_IDS) {
      if (moduleChargeGroupIDs.has(standardChargeGroupID)) {
        return "missileLauncher";
      }
    }

    for (const defenderChargeGroupID of DEFENDER_MISSILE_CHARGE_GROUP_IDS) {
      if (moduleChargeGroupIDs.has(defenderChargeGroupID)) {
        return "missileLauncher";
      }
    }

    if (STANDARD_MISSILE_LAUNCHER_GROUP_IDS.has(moduleGroupID)) {
      return "missileLauncher";
    }
  }

  const isTurret = typeHasEffectName(
    moduleTypeID,
    "turretFitted",
  );
  if (!isTurret) {
    return null;
  }

  const familyFromChargeGroup = WEAPON_FAMILY_BY_CHARGE_GROUP_ID[chargeGroupID] || null;
  if (familyFromChargeGroup) {
    return familyFromChargeGroup;
  }

  const moduleChargeGroupIDs = getModuleChargeGroupIDs(effectiveModuleItem);
  for (const [rawChargeGroupID, family] of Object.entries(WEAPON_FAMILY_BY_CHARGE_GROUP_ID)) {
    if (moduleChargeGroupIDs.has(toInt(rawChargeGroupID, 0))) {
      return family;
    }
  }

  return WEAPON_FAMILY_BY_MODULE_GROUP_ID[moduleGroupID] || null;
}

function buildMissileModuleSnapshot({
  shipItem,
  moduleItem,
  chargeItem,
  fittedItems,
  skillMap,
  activeModuleContexts,
  effectiveModuleItem,
  family = "missileLauncher",
  additionalLocationModifierSources = null,
  directModuleModifierEntries = null,
  directChargeModifierEntries = null,
  directCharacterModifierEntries = null,
  directShipModifierEntries = null,
  hiddenModifierItems = null,
} = {}) {
  if (!shipItem || !moduleItem || !chargeItem) {
    return null;
  }

  const resolvedFittedItems = Array.isArray(fittedItems) ? fittedItems : [];
  const resolvedSkillMap = skillMap instanceof Map ? skillMap : new Map();
  const resolvedActiveModuleContexts = Array.isArray(activeModuleContexts)
    ? activeModuleContexts
    : [];
  const resolvedAdditionalLocationModifierSources = Array.isArray(
    additionalLocationModifierSources,
  )
    ? additionalLocationModifierSources
    : [];
  const resolvedDirectModuleModifierEntries = Array.isArray(directModuleModifierEntries)
    ? directModuleModifierEntries
    : [];
  const resolvedDirectChargeModifierEntries = Array.isArray(directChargeModifierEntries)
    ? directChargeModifierEntries
    : [];
  const resolvedDirectCharacterModifierEntries = Array.isArray(
    directCharacterModifierEntries,
  )
    ? directCharacterModifierEntries
    : [];
  const resolvedDirectShipModifierEntries = Array.isArray(directShipModifierEntries)
    ? directShipModifierEntries
    : [];
  const shipModifierAttributes = collectShipModifierAttributes(
    shipItem,
    resolvedSkillMap,
    resolvedActiveModuleContexts,
    {
      fittedItems: resolvedFittedItems,
      additionalDirectModifierEntries: resolvedDirectShipModifierEntries,
      ...(Array.isArray(hiddenModifierItems) ? { hiddenModifierItems } : {}),
    },
  );
  const moduleAttributes = buildLocationModifiedAttributeMap(
    effectiveModuleItem,
    shipItem,
    resolvedSkillMap,
    shipModifierAttributes,
    resolvedFittedItems,
    resolvedActiveModuleContexts,
    {
      excludeItemID: toInt(moduleItem && moduleItem.itemID, 0),
      additionalLocationModifierSources: resolvedAdditionalLocationModifierSources,
    },
  );
  const chargeAttributes = buildLocationModifiedAttributeMap(
    chargeItem,
    shipItem,
    resolvedSkillMap,
    shipModifierAttributes,
    resolvedFittedItems,
    resolvedActiveModuleContexts,
    {
      additionalLocationModifierSources: resolvedAdditionalLocationModifierSources,
    },
  );
  applyOtherItemModifiersToAttributes(moduleAttributes, chargeItem);
  applyOtherItemModifiersToAttributes(chargeAttributes, effectiveModuleItem);
  applyModifierGroups(moduleAttributes, resolvedDirectModuleModifierEntries);
  applyModifierGroups(chargeAttributes, resolvedDirectChargeModifierEntries);

  const characterAttributes = collectCharacterModifierAttributes(
    resolvedSkillMap,
    resolvedFittedItems,
    resolvedActiveModuleContexts,
    {
      additionalDirectModifierEntries: resolvedDirectCharacterModifierEntries,
    },
  );
  const activationEffect = resolveWeaponActivationEffect(effectiveModuleItem.typeID);
  const chargeMode = resolveWeaponChargeMode(family);
  const chargeGroupID = toInt(chargeItem && chargeItem.groupID, 0);
  const moduleGroupID = toInt(effectiveModuleItem && effectiveModuleItem.groupID, 0);
  const isDefenderMissile =
    DEFENDER_MISSILE_CHARGE_GROUP_IDS.has(chargeGroupID) ||
    DEFENDER_MISSILE_LAUNCHER_GROUP_IDS.has(moduleGroupID);
  const missileDamageMultiplier = Math.max(
    0,
    family === "bombLauncher" ? 1 : toFiniteNumber(characterAttributes[ATTRIBUTE_MISSILE_DAMAGE_MULTIPLIER], 1),
  );
  const baseDamage = {
    em: Math.max(0, toFiniteNumber(chargeAttributes[ATTRIBUTE_EM_DAMAGE], 0)),
    thermal: Math.max(0, toFiniteNumber(chargeAttributes[ATTRIBUTE_THERMAL_DAMAGE], 0)),
    kinetic: Math.max(0, toFiniteNumber(chargeAttributes[ATTRIBUTE_KINETIC_DAMAGE], 0)),
    explosive: Math.max(0, toFiniteNumber(chargeAttributes[ATTRIBUTE_EXPLOSIVE_DAMAGE], 0)),
  };
  if (family === "festivalLauncher" || isBreacherPodWeaponFamily(family)) {
    for (const key of Object.keys(baseDamage)) baseDamage[key] = 0;
  }

  const flightTimeMs = Math.max(
    1,
    round6(toFiniteNumber(chargeAttributes[ATTRIBUTE_EXPLOSION_DELAY], 1000)),
  );
  const maxVelocity = Math.max(
    0,
    round6(toFiniteNumber(chargeAttributes[ATTRIBUTE_MAX_VELOCITY], 0)),
  );

  return {
    family,
    moduleID: toInt(moduleItem.itemID, 0),
    moduleTypeID: toInt(moduleItem.typeID, 0),
    moduleGroupID,
    chargeItemID: toInt(chargeItem.itemID, 0),
    chargeTypeID: toInt(chargeItem.typeID, 0),
    chargeGroupID,
    chargeMode,
    missileRole: isDefenderMissile ? "defender" : "standard",
    isDefenderMissile,
    chargeQuantity: Math.max(
      0,
      toInt(chargeItem && (chargeItem.stacksize ?? chargeItem.quantity), 0),
    ),
    activationEffectID: toInt(activationEffect && activationEffect.effectID, 0),
    activationEffectName: String(activationEffect && activationEffect.name || ""),
    effectGUID: resolveWeaponSpecialFxGUID({
      family,
      moduleItem: effectiveModuleItem,
      chargeItem,
      activationEffect,
    }),
    durationMs: Math.max(1, round6(toFiniteNumber(moduleAttributes[
      toInt(activationEffect && activationEffect.durationAttributeID, ATTRIBUTE_SPEED)
    ], 1000))),
    capNeed: Math.max(0, round6(toFiniteNumber(moduleAttributes[ATTRIBUTE_CAPACITOR_NEED], 0))),
    damageMultiplier: missileDamageMultiplier,
    baseDamage,
    rawShotDamage: {
      em: round6(baseDamage.em * missileDamageMultiplier),
      thermal: round6(baseDamage.thermal * missileDamageMultiplier),
      kinetic: round6(baseDamage.kinetic * missileDamageMultiplier),
      explosive: round6(baseDamage.explosive * missileDamageMultiplier),
    },
    maxVelocity,
    flightTimeMs,
    explosionRadius: Math.max(
      1,
      round6(toFiniteNumber(chargeAttributes[ATTRIBUTE_AOE_CLOUD_SIZE], 1)),
    ),
    explosionVelocity: Math.max(
      0.001,
      round6(toFiniteNumber(chargeAttributes[ATTRIBUTE_AOE_VELOCITY], 0.001)),
    ),
    damageReductionFactor: clamp(
      toFiniteNumber(chargeAttributes[ATTRIBUTE_AOE_DAMAGE_REDUCTION_FACTOR], 1),
      0.000001,
      1,
    ),
    damageReductionSensitivity: Math.max(
      0.000001,
      round6(toFiniteNumber(
        chargeAttributes[ATTRIBUTE_AOE_DAMAGE_REDUCTION_SENSITIVITY],
        DEFAULT_MISSILE_DAMAGE_REDUCTION_SENSITIVITY,
      )),
    ),
    approxRange: round6(maxVelocity * (flightTimeMs / 1000)),
    ...(isBreacherPodWeaponFamily(family) ? {
      dotDurationMs: Math.max(0, round6(toFiniteNumber(chargeAttributes[ATTRIBUTE_DOT_DURATION], 0))),
      dotMaxDamagePerTick: Math.max(0, round6(toFiniteNumber(chargeAttributes[ATTRIBUTE_DOT_MAX_DAMAGE], 0))),
      dotMaxHPPercentagePerTick: Math.max(0, round6(toFiniteNumber(chargeAttributes[ATTRIBUTE_DOT_HP_PERCENTAGE], 0))),
      targetTypeListID: toInt(moduleAttributes[5745], 0),
    } : {}),
    moduleAttributes,
    chargeAttributes,
    shipModifierAttributes,
    characterAttributes,
  };
}

function isDefenderMissileWeaponSnapshot(snapshot) {
  return Boolean(
    snapshot &&
    (
      snapshot.isDefenderMissile === true ||
      String(snapshot.missileRole || "").toLowerCase() === "defender" ||
      DEFENDER_MISSILE_CHARGE_GROUP_IDS.has(toInt(snapshot.chargeGroupID, 0)) ||
      DEFENDER_MISSILE_LAUNCHER_GROUP_IDS.has(toInt(snapshot.moduleGroupID, 0))
    ),
  );
}

function buildWeaponModuleSnapshot({
  characterID,
  shipItem,
  moduleItem,
  chargeItem = null,
  fittedItems = null,
  skillMap = null,
  activeModuleContexts = null,
  additionalLocationModifierSources = null,
  directModuleModifierEntries = null,
  directChargeModifierEntries = null,
  hiddenModifierItems = null,
} = {}) {
  if (!shipItem || !moduleItem) {
    return null;
  }

  // A gunner commands the battery, but their hull, skills and implants are
  // never its fitted dogma host (Client moondefencebutton activates the source
  // structure's own effect). Keep this true for direct snapshot callers too.
  if (toInt(shipItem.categoryID, 0) === 23) {
    characterID = 0;
    skillMap = new Map();
    activeModuleContexts = [];
    additionalLocationModifierSources = [];
    hiddenModifierItems = [];
  }
  const numericCharacterID = toInt(characterID, 0);
  const isStructureHost = isStructureDogmaHost(shipItem);
  const effectiveModuleItem = buildNpcEffectiveModuleItem(moduleItem);
  const family = resolveWeaponFamily(effectiveModuleItem, chargeItem);
  if (
    chargeItem &&
    toInt(chargeItem.typeID, 0) > 0 &&
    !isChargeCompatibleWithModule(effectiveModuleItem.typeID, chargeItem.typeID)
  ) {
    return null;
  }
  const implantLocationModifierSources =
    !isStructureHost && numericCharacterID > 0
      ? getActiveImplantLocationModifierSources(characterID)
      : [];
  const mergedAdditionalLocationModifierSources = [
    ...implantLocationModifierSources,
    ...(!isStructureHost && Array.isArray(additionalLocationModifierSources)
      ? additionalLocationModifierSources
      : []),
  ];
  const implantCharacterModifierEntries =
    !isStructureHost && numericCharacterID > 0
      ? getActiveImplantCharacterModifierEntries(characterID)
      : [];
  const implantShipModifierEntries =
    !isStructureHost && numericCharacterID > 0
      ? getActiveImplantShipModifierEntries(characterID)
      : [];
  const chargeOptionalTurretWeapon = isChargeOptionalTurretWeapon(
    effectiveModuleItem,
    chargeItem,
  );
  if (isMissileWeaponFamily(family) || family === "bombLauncher") {
    if (!chargeItem) {
      return null;
    }

    const resolvedFittedItems = Array.isArray(fittedItems)
      ? fittedItems
      : isStructureHost
        ? listFittedItemsForLocation(shipItem.itemID)
        : listFittedItems(characterID, shipItem.itemID);
    const resolvedSkillMap = resolveDogmaSkillMapForHost(
      characterID,
      shipItem,
      { skillMap },
    );
    const resolvedActiveModuleContexts = Array.isArray(activeModuleContexts)
      ? activeModuleContexts
      : [];

    return buildMissileModuleSnapshot({
      shipItem,
      moduleItem,
      chargeItem,
      fittedItems: resolvedFittedItems,
      skillMap: resolvedSkillMap,
      activeModuleContexts: resolvedActiveModuleContexts,
      effectiveModuleItem,
      family,
      additionalLocationModifierSources: mergedAdditionalLocationModifierSources,
      directModuleModifierEntries,
      directChargeModifierEntries,
      directCharacterModifierEntries: implantCharacterModifierEntries,
      directShipModifierEntries: implantShipModifierEntries,
      ...(Array.isArray(hiddenModifierItems) ? { hiddenModifierItems } : {}),
    });
  }
  // Vorton projectors share the turret snapshot: same dogma modifier collection,
  // same cycle and ammo handling.  Only damage application differs, which the
  // vorton-only fields on the returned snapshot carry.
  if (!isTurretWeaponFamily(family) && !isVortonWeaponFamily(family)) {
    return null;
  }

  const resolvedFittedItems = Array.isArray(fittedItems)
    ? fittedItems
    : isStructureHost
      ? listFittedItemsForLocation(shipItem.itemID)
      : listFittedItems(characterID, shipItem.itemID);
  const resolvedSkillMap = resolveDogmaSkillMapForHost(
    characterID,
    shipItem,
    { skillMap },
  );
  const resolvedActiveModuleContexts = Array.isArray(activeModuleContexts)
    ? activeModuleContexts
    : [];
  const resolvedAdditionalLocationModifierSources = Array.isArray(
    mergedAdditionalLocationModifierSources,
  )
    ? mergedAdditionalLocationModifierSources
    : [];
  const resolvedDirectModuleModifierEntries = Array.isArray(directModuleModifierEntries)
    ? directModuleModifierEntries
    : [];
  const resolvedDirectChargeModifierEntries = Array.isArray(directChargeModifierEntries)
    ? directChargeModifierEntries
    : [];
  const hiddenModifierSourceOptions = Array.isArray(hiddenModifierItems)
    ? { hiddenModifierItems }
    : {};
  const resolvedPassiveModifierSourceItems = getPassiveModifierSourceItems(
    shipItem,
    resolvedFittedItems,
    hiddenModifierSourceOptions,
  );
  const locationModifierDomains = isStructureHost
    ? new Set(["structureID", "charID"])
    : new Set(["shipID", "charID"]);
  const shipModifierAttributes = collectShipModifierAttributes(
    shipItem,
    resolvedSkillMap,
    resolvedActiveModuleContexts,
    {
      fittedItems: resolvedFittedItems,
      additionalDirectModifierEntries: implantShipModifierEntries,
      ...(Array.isArray(hiddenModifierItems) ? { hiddenModifierItems } : {}),
    },
  );
  const moduleAttributes = Boolean(
    moduleItem &&
    moduleItem.npcSyntheticHullWeapon === true &&
    toInt(effectiveModuleItem.typeID, 0) === toInt(shipItem.typeID, 0),
  )
    ? cloneAttributeMap(shipModifierAttributes)
    : cloneAttributeMap(buildEffectiveItemAttributeMap(effectiveModuleItem));
  const modifierEntries = [];
  const chargeAttributes =
    chargeItem && typeof chargeItem === "object"
      ? buildLocationModifiedAttributeMap(
        chargeItem,
        shipItem,
        resolvedSkillMap,
        shipModifierAttributes,
        resolvedFittedItems,
        resolvedActiveModuleContexts,
        {
          additionalLocationModifierSources: resolvedAdditionalLocationModifierSources,
        },
      )
      : {};

  for (const skillRecord of resolvedSkillMap.values()) {
    appendLocationModifierEntries(
      modifierEntries,
      peekSkillEffectiveAttributes(skillRecord),
      getTypeEffectRecords(skillRecord.typeID),
      "skill",
      effectiveModuleItem,
      {
        allowedDomains: locationModifierDomains,
        sourceTypeID: skillRecord.typeID,
      },
    );
  }

  appendLocationModifierEntries(
    modifierEntries,
    shipModifierAttributes,
    getTypeEffectRecords(shipItem.typeID),
    "ship",
    effectiveModuleItem,
    { allowedDomains: locationModifierDomains },
  );

  for (const fittedItem of resolvedPassiveModifierSourceItems) {
    if (
      !isPassiveModifierSource(fittedItem) ||
      toInt(fittedItem.itemID, 0) === toInt(moduleItem.itemID, 0)
    ) {
      continue;
    }

    appendLocationModifierEntries(
      modifierEntries,
      buildEffectiveItemAttributeMap(fittedItem),
      getTypeEffectRecords(fittedItem.typeID),
      "fittedModule",
      effectiveModuleItem,
      { allowedDomains: locationModifierDomains },
    );
  }

  // An overloaded projector — a Tracking Computer feeding this turret, say —
  // must project the strength it actually has, not the strength its type
  // declares cold.
  const overloadEffectRecordsByModuleID = indexOverloadEffectRecordsByModuleID(
    resolvedActiveModuleContexts,
  );

  for (const activeModuleContext of resolvedActiveModuleContexts) {
    const activeModuleItem = buildNpcEffectiveModuleItem(
      activeModuleContext && activeModuleContext.moduleItem,
    );
    const activeEffectRecord =
      (activeModuleContext && activeModuleContext.effectRecord) ||
      getEffectTypeRecord(activeModuleContext && activeModuleContext.effectID);
    if (!activeModuleItem || !activeEffectRecord) {
      continue;
    }

    if (
      (
        activeModuleContext &&
        activeModuleContext.effectState &&
        activeModuleContext.effectState.isOverload === true
      ) ||
      toInt(activeEffectRecord.effectCategoryID, 0) === 5
    ) {
      if (
        toInt(activeModuleItem.itemID, 0) ===
        toInt(effectiveModuleItem.itemID || moduleItem.itemID, 0)
      ) {
        appendSelfItemModifierEntries(
          modifierEntries,
          buildEffectiveItemAttributeMap(
            activeModuleItem,
            activeModuleContext && activeModuleContext.chargeItem,
          ),
          [activeEffectRecord],
          "fittedModule",
        );
      }
    }

    appendLocationModifierEntries(
      modifierEntries,
      buildProjectedModuleSourceAttributeMap(
        activeModuleItem,
        activeModuleContext && activeModuleContext.chargeItem,
        overloadEffectRecordsByModuleID.get(toInt(activeModuleItem.itemID, 0)),
      ),
      [activeEffectRecord],
      "fittedModule",
      effectiveModuleItem,
      { allowedDomains: locationModifierDomains },
    );
  }

  for (const source of resolvedAdditionalLocationModifierSources) {
    if (!source || typeof source !== "object") {
      continue;
    }
    // NPC hull weapons retain the hull's group for their Dogma attributes.
    // Match Abyssal turret weather against the weapon family instead; otherwise
    // every group-filtered range penalty silently skips these weapons.
    const weatherTurretGroupID = source.sourceKind === "abyssalWeather" &&
      moduleItem.npcSyntheticHullWeapon === true
      ? {
        laserTurret: ENERGY_TURRET_GROUP_ID,
        projectileTurret: PROJECTILE_TURRET_GROUP_ID,
        hybridTurret: HYBRID_TURRET_GROUP_ID,
        precursorTurret: PRECURSOR_WEAPON_GROUP_ID,
      }[family]
      : 0;
    appendLocationModifierEntries(
      modifierEntries,
      source.sourceAttributes,
      source.sourceEffects,
      String(source.sourceKind || "system"),
      weatherTurretGroupID
        ? { ...effectiveModuleItem, groupID: weatherTurretGroupID }
        : effectiveModuleItem,
      { allowedDomains: locationModifierDomains },
    );
  }

  applyModifierGroups(moduleAttributes, modifierEntries);
  applyOtherItemModifiersToAttributes(moduleAttributes, chargeItem);
  applyOtherItemModifiersToAttributes(chargeAttributes, effectiveModuleItem);
  applyModifierGroups(moduleAttributes, resolvedDirectModuleModifierEntries);
  applyModifierGroups(chargeAttributes, resolvedDirectChargeModifierEntries);

  const damageMultiplier = Math.max(
    0,
    toFiniteNumber(moduleAttributes[ATTRIBUTE_DAMAGE_MULTIPLIER], 1),
  );
  const activationEffect = resolveWeaponActivationEffect(effectiveModuleItem.typeID);
  const chargeMode = resolveWeaponChargeMode(family);
  const damageSourceAttributes =
    chargeItem || !chargeOptionalTurretWeapon
      ? chargeAttributes
      : moduleAttributes;
  const chargeDamage = {
    em: Math.max(0, toFiniteNumber(damageSourceAttributes[ATTRIBUTE_EM_DAMAGE], 0)),
    thermal: Math.max(0, toFiniteNumber(damageSourceAttributes[ATTRIBUTE_THERMAL_DAMAGE], 0)),
    kinetic: Math.max(0, toFiniteNumber(damageSourceAttributes[ATTRIBUTE_KINETIC_DAMAGE], 0)),
    explosive: Math.max(0, toFiniteNumber(damageSourceAttributes[ATTRIBUTE_EXPLOSIVE_DAMAGE], 0)),
  };

  return {
    family,
    moduleID: toInt(moduleItem.itemID, 0),
    moduleTypeID: toInt(moduleItem.typeID, 0),
    chargeItemID: toInt(chargeItem && chargeItem.itemID, 0),
    chargeTypeID: toInt(chargeItem && chargeItem.typeID, 0),
    chargeMode,
    chargeQuantity: Math.max(
      0,
      toInt(chargeItem && (chargeItem.stacksize ?? chargeItem.quantity), 0),
    ),
    activationEffectID: toInt(activationEffect && activationEffect.effectID, 0),
    activationEffectName: String(activationEffect && activationEffect.name || ""),
    effectGUID: resolveWeaponSpecialFxGUID({
      family,
      moduleItem: effectiveModuleItem,
      chargeItem,
      activationEffect,
    }),
    durationMs: Math.max(1, round6(toFiniteNumber(moduleAttributes[ATTRIBUTE_SPEED], 1000))),
    capNeed: Math.max(0, round6(toFiniteNumber(moduleAttributes[ATTRIBUTE_CAPACITOR_NEED], 0))),
    optimalRange: Math.max(0, round6(toFiniteNumber(moduleAttributes[ATTRIBUTE_MAX_RANGE], 0))),
    falloff: Math.max(0, round6(toFiniteNumber(moduleAttributes[ATTRIBUTE_FALLOFF], 0))),
    trackingSpeed: Math.max(0, round6(toFiniteNumber(moduleAttributes[ATTRIBUTE_TRACKING_SPEED], 0))),
    optimalSigRadius: Math.max(
      1,
      round6(toFiniteNumber(moduleAttributes[ATTRIBUTE_OPTIMAL_SIG_RADIUS], 40000)),
    ),
    damageMultiplier,
    baseDamage: chargeDamage,
    rawShotDamage: {
      em: round6(chargeDamage.em * damageMultiplier),
      thermal: round6(chargeDamage.thermal * damageMultiplier),
      kinetic: round6(chargeDamage.kinetic * damageMultiplier),
      explosive: round6(chargeDamage.explosive * damageMultiplier),
    },
    // Vorton application and arc data.  Unlike missiles, which carry these on the
    // charge, a vorton projector declares them on the module itself.
    ...(isVortonWeaponFamily(family)
      ? {
        explosionRadius: Math.max(
          0.000001,
          round6(toFiniteNumber(moduleAttributes[ATTRIBUTE_AOE_CLOUD_SIZE], 1)),
        ),
        explosionVelocity: Math.max(
          0.000001,
          round6(toFiniteNumber(moduleAttributes[ATTRIBUTE_AOE_VELOCITY], 1)),
        ),
        damageReductionFactor: round6(
          toFiniteNumber(moduleAttributes[ATTRIBUTE_AOE_DAMAGE_REDUCTION_FACTOR], 1),
        ),
        damageReductionSensitivity: round6(
          toFiniteNumber(
            moduleAttributes[ATTRIBUTE_AOE_DAMAGE_REDUCTION_SENSITIVITY],
            5.5,
          ),
        ),
        arcRange: Math.max(
          0,
          round6(toFiniteNumber(moduleAttributes[ATTRIBUTE_VORTON_ARC_RANGE], 0)),
        ),
        arcTargets: Math.max(
          0,
          Math.trunc(toFiniteNumber(moduleAttributes[ATTRIBUTE_VORTON_ARC_TARGETS], 0)),
        ),
      }
      : {}),
    moduleAttributes,
    chargeAttributes,
    shipModifierAttributes,
  };
}

function buildWeaponDogmaAttributeOverrides(options = {}) {
  const snapshot = buildWeaponModuleSnapshot(options);
  if (!snapshot) {
    return null;
  }

  return {
    family: snapshot.family || null,
    moduleAttributes: cloneAttributeMap(snapshot.moduleAttributes || {}),
    chargeAttributes: cloneAttributeMap(snapshot.chargeAttributes || {}),
    shipModifierAttributes: cloneAttributeMap(snapshot.shipModifierAttributes || {}),
    characterAttributes: cloneAttributeMap(snapshot.characterAttributes || {}),
    snapshot,
  };
}

module.exports = {
  ENERGY_TURRET_GROUP_ID,
  PROJECTILE_TURRET_GROUP_ID,
  HYBRID_TURRET_GROUP_ID,
  VORTON_PROJECTOR_GROUP_ID,
  PROJECTILE_AMMO_GROUP_ID,
  HYBRID_CHARGE_GROUP_ID,
  FREQUENCY_CRYSTAL_GROUP_ID,
  CONDENSER_PACK_GROUP_ID,
  ADVANCED_CONDENSER_PACK_GROUP_ID,
  buildSkillEffectiveAttributes,
  peekSkillEffectiveAttributes,
  collectShipModifierAttributes,
  collectCharacterModifierAttributes,
  buildLocationModifiedAttributeMap,
  isTurretWeaponFamily,
  isMissileWeaponFamily,
  isBreacherPodWeaponFamily,
  isVortonWeaponFamily,
  isTurretCycleWeaponFamily,
  isDefenderMissileWeaponSnapshot,
  isChargeOptionalTurretWeapon,
  resolveWeaponFamily,
  resolveWeaponSpecialFxGUID,
  buildWeaponModuleSnapshot,
  buildWeaponDogmaAttributeOverrides,
};
