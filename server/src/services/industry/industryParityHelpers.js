"use strict";

const path = require("path");

const {
  TABLE,
  readStaticTable,
} = require(path.join(__dirname, "../_shared/referenceData"));
const {
  getCachedCharacterSkillMap,
  getSkillMutationVersion,
} = require(path.join(__dirname, "../skills/skillState"));
const {
  resolveCharacterIndustryAttributes,
} = require(path.join(__dirname, "../dogma/brain/providers/industryBrainProvider"));
const {
  resolveItemByTypeID,
} = require(path.join(__dirname, "../inventory/itemTypeRegistry"));
const worldData = require(path.join(__dirname, "../../space/worldData"));
const {
  INDUSTRY_ACTIVITY,
  INDUSTRY_SECURITY_TAX_RATE,
  SAFE_SECURITY_CLASS_LEVEL,
  MAX_MATERIAL_EFFICIENCY,
  MAX_TIME_EFFICIENCY,
  MATERIAL_ROUND_PRECISION,
  RESEARCH_TIME_MULTIPLIERS,
  STEP_MATERIAL_EFFICIENCY,
  STEP_TIME_EFFICIENCY,
} = require(path.join(__dirname, "./industryConstants"));
const {
  resolveBlueprintActivityPrice,
} = require(path.join(__dirname, "./industryPricing"));

const REQUIRED_SKILL_TIME_ATTRIBUTE_ID = 1982;
const JOB_COST_MULTIPLIER_ATTRIBUTE_ID = 1954;
const CLONE_STATE_ALPHA = 0;
const CLONE_STATE_INDUSTRY_TAX = 1.0025;
const ATTRIBUTE_MANUFACTURE_TIME_MULTIPLIER = 219;
const ATTRIBUTE_MANUFACTURING_TIME_RESEARCH_SPEED = 385;
const ATTRIBUTE_COPY_SPEED_PERCENT = 387;
const ATTRIBUTE_MINERAL_NEED_RESEARCH_SPEED = 398;
const ATTRIBUTE_INVENTION_RESEARCH_SPEED = 1959;
const ATTRIBUTE_REACTION_TIME_MULTIPLIER = 2662;

const ACTIVITY_KEY_BY_ID = Object.freeze({
  [INDUSTRY_ACTIVITY.MANUFACTURING]: "manufacturing",
  [INDUSTRY_ACTIVITY.RESEARCH_TIME]: "research_time",
  [INDUSTRY_ACTIVITY.RESEARCH_MATERIAL]: "research_material",
  [INDUSTRY_ACTIVITY.COPYING]: "copying",
  [INDUSTRY_ACTIVITY.INVENTION]: "invention",
  [INDUSTRY_ACTIVITY.REACTION]: "reaction",
});

const CHARACTER_TIME_ATTRIBUTE_BY_ACTIVITY = Object.freeze({
  [INDUSTRY_ACTIVITY.MANUFACTURING]: ATTRIBUTE_MANUFACTURE_TIME_MULTIPLIER,
  [INDUSTRY_ACTIVITY.RESEARCH_TIME]: ATTRIBUTE_MANUFACTURING_TIME_RESEARCH_SPEED,
  [INDUSTRY_ACTIVITY.RESEARCH_MATERIAL]: ATTRIBUTE_MINERAL_NEED_RESEARCH_SPEED,
  [INDUSTRY_ACTIVITY.COPYING]: ATTRIBUTE_COPY_SPEED_PERCENT,
  [INDUSTRY_ACTIVITY.INVENTION]: ATTRIBUTE_INVENTION_RESEARCH_SPEED,
  [INDUSTRY_ACTIVITY.REACTION]: ATTRIBUTE_REACTION_TIME_MULTIPLIER,
});

let typeDogmaAttributesByTypeID = null;
const characterSkillLevelsCache = new Map();
const requiredSkillTimePercentCache = new Map();

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function toFloat(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function getTypeDogmaAttributesByTypeID() {
  if (typeDogmaAttributesByTypeID) {
    return typeDogmaAttributesByTypeID;
  }
  const table = readStaticTable(TABLE.TYPE_DOGMA);
  typeDogmaAttributesByTypeID =
    table && typeof table === "object" && table.typesByTypeID
      ? table.typesByTypeID
      : {};
  return typeDogmaAttributesByTypeID;
}

function getRequiredSkillTimePercentPerLevel(typeID) {
  const numericTypeID = toInt(typeID, 0);
  if (numericTypeID <= 0) {
    return 0;
  }
  if (requiredSkillTimePercentCache.has(numericTypeID)) {
    return requiredSkillTimePercentCache.get(numericTypeID);
  }

  const typeRecord = getTypeDogmaAttributesByTypeID()[String(numericTypeID)] || null;
  const attributes =
    typeRecord && typeRecord.attributes && typeof typeRecord.attributes === "object"
      ? typeRecord.attributes
      : {};
  const value = toFloat(attributes[String(REQUIRED_SKILL_TIME_ATTRIBUTE_ID)], 0);
  requiredSkillTimePercentCache.set(numericTypeID, value);
  return value;
}

// The blueprint type's own job cost multiplier, or null where the type has no
// such attribute. A type that has it at 0 is not a type without it: its jobs
// cost nothing.
function getBlueprintJobCostMultiplier(blueprintTypeID) {
  const numericTypeID = toInt(blueprintTypeID, 0);
  if (numericTypeID <= 0) {
    return null;
  }

  const typeRecord = getTypeDogmaAttributesByTypeID()[String(numericTypeID)] || null;
  const attributes =
    typeRecord && typeRecord.attributes && typeof typeRecord.attributes === "object"
      ? typeRecord.attributes
      : {};
  const value = attributes[String(JOB_COST_MULTIPLIER_ATTRIBUTE_ID)];
  if (value === undefined || value === null) {
    return null;
  }
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? Math.max(0, numericValue) : null;
}

function getCachedCharacterSkillLevels(characterID) {
  const numericCharacterID = toInt(characterID, 0);
  if (numericCharacterID <= 0) {
    return {};
  }

  const cacheKey = `${numericCharacterID}:${getSkillMutationVersion()}`;
  if (characterSkillLevelsCache.has(cacheKey)) {
    return characterSkillLevelsCache.get(cacheKey);
  }

  const skillMap = getCachedCharacterSkillMap(numericCharacterID);
  const levels = {};
  for (const [typeID, skillRecord] of skillMap.entries()) {
    levels[String(toInt(typeID, 0))] = Math.max(
      0,
      toInt(
        skillRecord &&
          (skillRecord.effectiveSkillLevel ??
            skillRecord.trainedSkillLevel ??
            skillRecord.skillLevel),
        0,
      ),
    );
  }

  characterSkillLevelsCache.set(cacheKey, levels);
  return levels;
}

function getIndustryActivityKey(activityID) {
  return ACTIVITY_KEY_BY_ID[toInt(activityID, 0)] || null;
}

function getIndustryActivity(definition, activityID) {
  const activityKey = getIndustryActivityKey(activityID);
  if (!activityKey) {
    return null;
  }
  return (
    definition &&
    definition.activities &&
    typeof definition.activities === "object" &&
    definition.activities[activityKey]
  ) || null;
}

// A material's quantity as the client makes it whole (industry/job.py
// _get_materials, 479): rounded to MATERIAL_ROUND_PRECISION places, taken up to
// the whole number at or above that, and never fewer than the job's runs.
//
// The client's Python 2.7 rounds the number itself, to the nearer of the two
// and a number that is exactly a half away from nought. toFixed is that for a
// number that is not below nought. Rounding the number's hundredfold is not: a
// double a little under 940.005 has a hundredfold of 94000.5, which rounds up
// where the client's rounds down, and the quantity comes out one more.
function roundMaterialQuantity(quantity, runs) {
  return Math.max(
    Math.trunc(
      Math.ceil(Number(quantity.toFixed(MATERIAL_ROUND_PRECISION))),
    ),
    runs,
  );
}

function modifierMatchesProduct(modifier, productTypeID) {
  const categoryID = toInt(Array.isArray(modifier) ? modifier[1] : 0, 0);
  const groupID = toInt(Array.isArray(modifier) ? modifier[2] : 0, 0);
  const invTypeID = toInt(Array.isArray(modifier) ? modifier[3] : 0, 0);
  if (categoryID <= 0 && groupID <= 0 && invTypeID <= 0) {
    return true;
  }

  const typeID = toInt(productTypeID, 0);
  if (typeID <= 0) {
    return false;
  }
  const itemType = resolveItemByTypeID(typeID);
  if (!itemType) {
    return false;
  }
  if (categoryID > 0) {
    return toInt(itemType.categoryID, 0) === categoryID;
  }
  if (groupID > 0) {
    return toInt(itemType.groupID, 0) === groupID;
  }
  return toInt(itemType.typeID, 0) === invTypeID;
}

function buildIndustryActivityMaterials(
  definition,
  activityID,
  runs,
  options = {},
) {
  const activity = getIndustryActivity(definition, activityID);
  const baseMaterials = Array.isArray(activity && activity.materials)
    ? activity.materials
    : [];
  const normalizedRuns = Math.max(0, toInt(runs, 0));
  // What the quantity is multiplied by for the job's runs: the runs, and for
  // a copy job the runs times the licensed runs of each copy
  // (industry/activity.py job_material_runs, 38-39;
  // industry/activities/copying.py, 18-19).
  const materialRuns =
    toInt(activityID, 0) === INDUSTRY_ACTIVITY.COPYING
      ? normalizedRuns * Math.max(1, toInt(options.licensedRuns, 1))
      : normalizedRuns;
  const materialEfficiency = Math.max(0, toInt(options.materialEfficiency, 0));
  const blueprintModifier =
    toInt(activityID, 0) === INDUSTRY_ACTIVITY.MANUFACTURING
      ? 1.0 - materialEfficiency / 100.0
      : 1.0;
  const productTypeID = toInt(
    options.productTypeID,
    toInt(definition && definition.productTypeID, 0),
  );

  // The client reckons these quantities itself before it sends the job, a job
  // with a quantity that differs is refused with MISMATCH_MATERIAL, and these
  // are also what the job takes. A quantity is a double until it is made
  // whole, so the two only agree to the unit when it is multiplied in the
  // client's order and by one factor at a time (industry/job.py _get_materials,
  // 470-485, over the input modifiers of the list _get_all_modifiers builds,
  // 230-248 and 300-303): the blueprint's own quantity, the blueprint's
  // material research (industry/activities/manufacturing.py job_modifiers,
  // 10-16: manufacturing alone, and left out where there is none, which the
  // 1.0 it is here comes to), each of the facility's material modifiers
  // (eve/common/script/util/industryCommon.py Facility, 378-418), and the runs
  // last.
  return baseMaterials
    .map((material) => {
      let quantity = Math.max(0, toInt(material && material.quantity, 0));
      quantity *= blueprintModifier;
      quantity = applyFacilityActivityModifiers(
        quantity,
        options.facility,
        activityID,
        1,
        productTypeID,
      );
      quantity *= materialRuns;
      return {
        typeID: toInt(material && material.typeID, 0),
        quantity: roundMaterialQuantity(quantity, normalizedRuns),
      };
    })
    .filter((material) => material.typeID > 0 && material.quantity > 0);
}

// Multiplies currentValue by each of the facility's modifiers that match the
// product, one at a time and in the facility's own order.
function applyFacilityActivityModifiers(
  currentValue,
  facility,
  activityID,
  modifierIndex,
  productTypeID = 0,
) {
  const activityEntry =
    facility &&
    facility.activities &&
    facility.activities[toInt(activityID, 0)];
  const modifiers = Array.isArray(activityEntry && activityEntry[modifierIndex])
    ? activityEntry[modifierIndex]
    : [];
  let value = currentValue;
  for (const modifier of modifiers) {
    if (!modifierMatchesProduct(modifier, productTypeID)) {
      continue;
    }
    value *= Math.max(0, toFloat(Array.isArray(modifier) ? modifier[0] : 1, 1));
  }
  return value;
}

function resolveFacilityActivityModifier(
  facility,
  activityID,
  modifierIndex,
  productTypeID = 0,
) {
  return applyFacilityActivityModifiers(
    1.0,
    facility,
    activityID,
    modifierIndex,
    productTypeID,
  );
}

function resolveFacilityTimeModifier(facility, activityID, productTypeID = 0) {
  return resolveFacilityActivityModifier(facility, activityID, 0, productTypeID);
}

function resolveFacilityMaterialModifier(facility, activityID, productTypeID = 0) {
  return resolveFacilityActivityModifier(facility, activityID, 1, productTypeID);
}

function resolveFacilityCostModifier(facility, activityID, productTypeID = 0) {
  return resolveFacilityActivityModifier(facility, activityID, 2, productTypeID);
}

function applyTimePercentModifier(currentValue, percentPerLevel, level) {
  if (!(currentValue > 0) || !(level > 0) || !Number.isFinite(percentPerLevel) || percentPerLevel === 0) {
    return currentValue;
  }
  return currentValue * Math.max(0, 1.0 + (percentPerLevel * level) / 100.0);
}

// Multiplies currentValue by each required skill's time amount, one at a time
// and in the activity's own skill order.
function applyRequiredSkillTimeModifiers(
  currentValue,
  activityID,
  characterID,
  requiredSkills = [],
) {
  const levels = getCachedCharacterSkillLevels(characterID);
  let value = currentValue;

  if (toInt(activityID, 0) === INDUSTRY_ACTIVITY.MANUFACTURING) {
    for (const skill of Array.isArray(requiredSkills) ? requiredSkills : []) {
      const skillTypeID = toInt(skill && skill.typeID, 0);
      if (skillTypeID <= 0) {
        continue;
      }
      const percentPerLevel = getRequiredSkillTimePercentPerLevel(skillTypeID);
      if (!(percentPerLevel < 0)) {
        continue;
      }
      const level = Math.max(0, toInt(levels[String(skillTypeID)], 0));
      value = applyTimePercentModifier(value, percentPerLevel, level);
    }
  }

  return value;
}

function resolveCharacterIndustryTimeModifier(activityID, characterID) {
  const numericActivityID = toInt(activityID, 0);
  const attributeID = CHARACTER_TIME_ATTRIBUTE_BY_ACTIVITY[numericActivityID] || 0;
  if (attributeID <= 0) {
    return 1.0;
  }

  const attributes = resolveCharacterIndustryAttributes(characterID);
  const modifier = toFloat(
    attributes && attributes[attributeID],
    1.0,
  );
  return modifier > 0 ? modifier : 1.0;
}

function resolveIndustryJobBaseCost(definition, activityID, costPercentage = 1) {
  const blueprintTypeID = toInt(definition && definition.blueprintTypeID, 0);
  if (blueprintTypeID <= 0) {
    return 0;
  }
  return Math.max(
    0,
    resolveBlueprintActivityPrice(blueprintTypeID, activityID) * Math.max(0, toFloat(costPercentage, 0)),
  );
}

// A job's cost in whole ISK, from the activity's base cost before that base is
// rounded.
//
// The client reckons this cost itself before it sends the job, a job whose
// cost differs is refused with MISMATCH_COST, and this is also what the job is
// charged. These are doubles, so the whole ISK only agree when the cost is
// reckoned as the client reckons it (industry/job.py _get_cost_for_modifiers,
// 310-320): the base is multiplied by each cost modifier in turn, an additive
// modifier's share of the unmodified base is summed apart, and the two are
// rounded together once. The modifiers come in the order _get_all_modifiers
// builds (230-248), the job's own before the facility's.
//
// The job's own (eve/common/script/util/industryCommon.py GetJobModifiers,
// 485-513) are the blueprint type's job cost multiplier where the type has one
// and, for an alpha clone, an additive 1.0025 (clonegrade/const.py, 12 and 33).
// The facility's (industryCommon.py Facility, 378-418) are its cost modifiers
// in their row order. The client puts the facility's faction and system
// amounts before those only where they are not 1.0, and every facility here is
// sent with both at 1.0, the system cost index being a row of the cost
// modifiers instead, so there is nothing of them to multiply.
function resolveIndustryJobCost(
  baseCost,
  blueprintTypeID,
  activityID,
  facility,
  productTypeID = 0,
  cloneGrade = null,
) {
  const unroundedBaseCost = Math.max(0, toFloat(baseCost, 0));
  let cost = unroundedBaseCost;
  const blueprintMultiplier = getBlueprintJobCostMultiplier(blueprintTypeID);
  if (blueprintMultiplier !== null) {
    cost *= blueprintMultiplier;
  }
  cost = applyFacilityActivityModifiers(
    cost,
    facility,
    activityID,
    2,
    productTypeID,
  );
  const additiveCost =
    cloneGrade === CLONE_STATE_ALPHA
      ? unroundedBaseCost * (CLONE_STATE_INDUSTRY_TAX - 1.0)
      : 0;
  return Math.round(cost + additiveCost);
}

function resolveIndustryJobTimeSeconds(
  definition,
  activityID,
  runs,
  timeEfficiency,
  facility,
  characterID,
  licensedRuns = 1,
  productTypeID = 0,
) {
  const activity = getIndustryActivity(definition, activityID);
  const activityBaseTime = Math.max(0, toInt(activity && activity.time, 0));
  const normalizedRuns = Math.max(1, toInt(runs, 1));
  const normalizedLicensedRuns = Math.max(1, toInt(licensedRuns, 1));
  let baseTime = activityBaseTime * normalizedRuns;

  if (toInt(activityID, 0) === INDUSTRY_ACTIVITY.COPYING) {
    baseTime = activityBaseTime * normalizedLicensedRuns * normalizedRuns;
  } else if (
    toInt(activityID, 0) === INDUSTRY_ACTIVITY.RESEARCH_TIME ||
    toInt(activityID, 0) === INDUSTRY_ACTIVITY.RESEARCH_MATERIAL
  ) {
    const stepSize =
      toInt(activityID, 0) === INDUSTRY_ACTIVITY.RESEARCH_TIME
        ? STEP_TIME_EFFICIENCY
        : STEP_MATERIAL_EFFICIENCY;
    const maxEfficiency =
      toInt(activityID, 0) === INDUSTRY_ACTIVITY.RESEARCH_TIME
        ? MAX_TIME_EFFICIENCY
        : MAX_MATERIAL_EFFICIENCY;
    const currentLevel = Math.max(0, toInt(timeEfficiency, 0)) / stepSize;
    const maxIndex = Math.max(0, RESEARCH_TIME_MULTIPLIERS.length - 1);
    baseTime = 0;
    for (let index = 0; index < normalizedRuns; index += 1) {
      const levelIndex = Math.min(currentLevel + index, maxIndex);
      if (currentLevel + index >= maxEfficiency / stepSize) {
        break;
      }
      baseTime += activityBaseTime * RESEARCH_TIME_MULTIPLIERS[levelIndex];
    }
  }
  const blueprintModifier =
    toInt(activityID, 0) === INDUSTRY_ACTIVITY.MANUFACTURING
      ? Math.max(0, 1.0 - toInt(timeEfficiency, 0) / 100.0)
      : 1.0;
  const activityProductTypeID = toInt(
    productTypeID,
    toInt(definition && definition.productTypeID, 0),
  );
  const characterModifier = resolveCharacterIndustryTimeModifier(
    activityID,
    characterID,
  );

  // The client reckons this time itself before it sends the job, and a job
  // whose time differs is refused with MISMATCH_TIME. These are doubles, so the
  // whole seconds only agree when the running time is multiplied in the
  // client's order and by one factor at a time (industry/job.py _get_time,
  // 460-468, over the list _get_all_modifiers builds, 230-248): each required
  // skill's amount and then the character's attribute
  // (eve/common/script/util/industryCommon.py GetJobModifiers, 485-513), the
  // blueprint's time efficiency (industry/activities/manufacturing.py
  // job_modifiers, 10-16), then each of the facility's time modifiers
  // (industryCommon.py Facility, 378-418).
  let totalSeconds = applyRequiredSkillTimeModifiers(
    baseTime,
    activityID,
    characterID,
    activity && activity.skills,
  );
  totalSeconds *= characterModifier;
  totalSeconds *= blueprintModifier;
  totalSeconds = applyFacilityActivityModifiers(
    totalSeconds,
    facility,
    activityID,
    0,
    activityProductTypeID,
  );
  return Math.max(
    1,
    Math.round(totalSeconds),
  );
}

function clearIndustryParityCaches() {
  characterSkillLevelsCache.clear();
  requiredSkillTimePercentCache.clear();
}

// A job's industry security tax in whole ISK: five hundredths of the rounded
// base where the facility's system is of the safe class, a security of 0.95 or
// more, and nothing elsewhere or where the facility names no system
// (industry/job.py _get_industry_security_tax, 164-172). The client adds it to
// its total beside the tax and the SCC surcharge (total_cost, 133) and sends
// none of the three: what a job is charged has to have it.
function resolveIndustrySecurityTax(baseCost, facility) {
  const system = worldData.getSolarSystemByID(
    toInt(facility && facility.solarSystemID, 0),
  );
  // No system, and so no security to compare, is not the safe class.
  if (!(Number(system && system.security) >= SAFE_SECURITY_CLASS_LEVEL)) {
    return 0;
  }
  return Math.round(baseCost * INDUSTRY_SECURITY_TAX_RATE);
}

module.exports = {
  buildIndustryActivityMaterials,
  clearIndustryParityCaches,
  getIndustryActivity,
  getIndustryActivityKey,
  resolveFacilityCostModifier,
  resolveFacilityMaterialModifier,
  resolveFacilityTimeModifier,
  resolveIndustryJobBaseCost,
  resolveIndustryJobCost,
  resolveIndustryJobTimeSeconds,
  resolveIndustrySecurityTax,
};
