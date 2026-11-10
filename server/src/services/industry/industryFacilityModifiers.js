"use strict";

const {
  toInt,
} = require("../../common/numbers");

const path = require("path");

const worldData = require(path.join(__dirname, "../../space/worldData"));
const {
  TABLE,
  readStaticTable,
  readStaticRows,
} = require(path.join(__dirname, "../_shared/referenceData"));
const {
  listContainerItems,
} = require(path.join(__dirname, "../inventory/itemStore"));
const {
  INDUSTRY_REFERENCE,
} = require(path.join(__dirname, "./industryConstants"));

const RIG_SLOT_FLAGS = Object.freeze([92, 93, 94, 95, 96, 97, 98, 99]);

const authority = require("./industryModifierAuthority.json");
const ATTRIBUTE_HISEC_MODIFIER = 2355;
const ATTRIBUTE_LOWSEC_MODIFIER = 2356;
const ATTRIBUTE_NULLSEC_MODIFIER = 2357;
const MODIFIER_INDEX = Object.freeze({ time: 0, material: 1, cost: 2 });
const MODIFIER_KIND = Object.freeze(["time", "material", "cost"]);
const SECURITY_SCALED_RIG_ATTRIBUTES = new Set([2593, 2594, 2595, 2653, 2713, 2714]);
let categoryByGroupID = null;

function getCategoryByGroupID() {
  if (!categoryByGroupID) {
    const categories = new Map();
    for (const type of readStaticRows(TABLE.ITEM_TYPES)) {
      const groupID = toInt(type.groupID, 0);
      const categoryID = toInt(type.categoryID, 0);
      if (groupID > 0 && categoryID > 0) {
        const previous = categories.get(groupID);
        if (previous && previous !== categoryID) {
          throw new Error(`Industry group ${groupID} has conflicting categories`);
        }
        categories.set(groupID, categoryID);
      }
    }
    categoryByGroupID = categories;
  }
  return categoryByGroupID;
}

// Native filters are category/group unions, as industryCommon.py:600-617
// specifies. A missing filter is unrestricted. The checked importer rejects
// unresolved filters rather than broadening a restricted modifier silently.
function getNativeModifierTargets(typeID, attributeID = null) {
  return (authority.modifiersByTypeID[String(Number(typeID))] || []).flatMap(
    ([activityID, modifierIndex, dogmaAttributeID, filterID]) => {
      if (attributeID !== null && dogmaAttributeID !== Number(attributeID)) return [];
      const base = { activityID, kind: MODIFIER_KIND[modifierIndex], dogmaAttributeID };
      if (filterID === null) return [base];
      const filter = authority.filtersByID[filterID];
      if (!filter) throw new Error(`Unknown industry modifier filter ${filterID}`);
      if (!filter.categories.length && !filter.groups.length) return [base];
      return [
        ...filter.categories.map(categoryID => ({ ...base, categoryID })),
        // Wire rows multiply independently in both the client and server. A
        // group already covered by a category must not emit a second factor.
        // Groups have one category; retain unknown groups (which currently
        // cannot match a known product) rather than broadening the filter.
        ...filter.groups
          .filter(groupID => !filter.categories.length ||
            !filter.categories.includes(getCategoryByGroupID().get(groupID)))
          .map(groupID => ({ ...base, groupID })),
      ];
    },
  );
}

let typeDogmaPayload = null;

function toFloat(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function cloneActivityEntry(entry) {
  if (!Array.isArray(entry)) {
    return [[], [], [], [], [], []];
  }
  return [0, 1, 2, 3, 4, 5].map((index) => (
    Array.isArray(entry[index])
      ? entry[index].map((value) => (Array.isArray(value) ? [...value] : value))
      : []
  ));
}

function cloneActivities(activities = {}) {
  return Object.fromEntries(
    Object.entries(activities || {}).map(([activityID, entry]) => [
      activityID,
      cloneActivityEntry(entry),
    ]),
  );
}

function ensureActivityEntryShape(entry) {
  if (!Array.isArray(entry)) {
    return [[], [], [], [], [], []];
  }
  for (let index = 0; index < 6; index += 1) {
    if (!Array.isArray(entry[index])) {
      entry[index] = [];
    }
  }
  return entry;
}

function appendUniqueInt(values, value) {
  const numericValue = toInt(value, 0);
  if (numericValue <= 0 || !Array.isArray(values)) {
    return;
  }
  if (!values.some((candidate) => toInt(candidate, 0) === numericValue)) {
    values.push(numericValue);
  }
}

function getTypeDogmaPayload() {
  if (!typeDogmaPayload) {
    typeDogmaPayload = readStaticTable(TABLE.TYPE_DOGMA) || {};
  }
  return typeDogmaPayload;
}

function getTypeDogmaEntry(typeID) {
  const payload = getTypeDogmaPayload();
  return (
    payload &&
    payload.typesByTypeID &&
    payload.typesByTypeID[String(toInt(typeID, 0))]
  ) || null;
}

function getEffectDogmaEntry(effectID) {
  const payload = getTypeDogmaPayload();
  return (
    payload &&
    payload.effectTypesByID &&
    payload.effectTypesByID[String(toInt(effectID, 0))]
  ) || null;
}

function getDogmaAttributes(typeRecord) {
  return typeRecord && typeRecord.attributes && typeof typeRecord.attributes === "object"
    ? typeRecord.attributes
    : {};
}

function resolveStructureSecurityBand(structure) {
  const solarSystem = worldData.getSolarSystemByID(toInt(structure && structure.solarSystemID, 0));
  const security = toFloat(solarSystem && solarSystem.security, 0);
  if (security >= 0.45) {
    return "high";
  }
  if (security > 0) {
    return "low";
  }
  return "null";
}

function getRigSecurityMultiplier(attributes, securityBand) {
  if (securityBand === "high") {
    return toFloat(attributes[String(ATTRIBUTE_HISEC_MODIFIER)], 1);
  }
  if (securityBand === "low") {
    return toFloat(attributes[String(ATTRIBUTE_LOWSEC_MODIFIER)], 1);
  }
  return toFloat(attributes[String(ATTRIBUTE_NULLSEC_MODIFIER)], 1);
}

function getRigSourceAttribute(attributes, sourceAttributeID, securityBand) {
  const numericSourceAttributeID = toInt(sourceAttributeID, 0);
  const value = toFloat(attributes[String(numericSourceAttributeID)], 0);
  if (!SECURITY_SCALED_RIG_ATTRIBUTES.has(numericSourceAttributeID)) {
    return value;
  }
  return value * getRigSecurityMultiplier(attributes, securityBand);
}

function postPercentAmount(percent) {
  return Math.max(0, 1 + toFloat(percent, 0) / 100);
}

function appendActivityModifier(activities, target, amount, reference) {
  const activityID = toInt(target && target.activityID, 0);
  const modifierIndex = MODIFIER_INDEX[target && target.kind];
  if (activityID <= 0 || modifierIndex === undefined || !activities[String(activityID)]) {
    return false;
  }
  const entry = ensureActivityEntryShape(activities[String(activityID)]);
  const categoryID = toInt(target && target.categoryID, 0) || null;
  const groupID = toInt(target && target.groupID, 0) || null;
  const invTypeID = toInt(target && target.invTypeID, 0) || null;
  entry[modifierIndex].push([
    amount,
    categoryID,
    groupID,
    invTypeID,
    reference,
  ]);
  return true;
}

function applyNativeHullModifiers(structure, activities) {
  const attributes = getDogmaAttributes(getTypeDogmaEntry(structure && structure.typeID));
  for (const target of getNativeModifierTargets(structure && structure.typeID)) {
    const amount = toFloat(attributes[String(target.dogmaAttributeID)], 1);
    if (amount > 0 && Math.abs(amount - 1) > 1e-9) {
      appendActivityModifier(activities, target, amount, INDUSTRY_REFERENCE.HULL);
    }
  }
}

function appendRigActivityID(rigModifiers, rigTypeID, activityID) {
  const key = String(toInt(rigTypeID, 0));
  if (!rigModifiers[key]) {
    rigModifiers[key] = [];
  }
  appendUniqueInt(rigModifiers[key], activityID);
}

function applyFittedRigModifiers(structure, activities) {
  const structureID = toInt(structure && structure.structureID, 0);
  if (structureID <= 0) {
    return {};
  }

  const rigModifiers = {};
  const securityBand = resolveStructureSecurityBand(structure);
  const fittedRigs = listContainerItems(null, structureID, null)
    .filter((item) => item && RIG_SLOT_FLAGS.includes(toInt(item.flagID, 0)));

  for (const rigItem of fittedRigs) {
    const rigTypeID = toInt(rigItem && rigItem.typeID, 0);
    const typeRecord = getTypeDogmaEntry(rigTypeID);
    const attributes = getDogmaAttributes(typeRecord);
    const effects = Array.isArray(typeRecord && typeRecord.effects)
      ? typeRecord.effects
      : [];

    for (const effectID of effects) {
      const effect = getEffectDogmaEntry(effectID);
      const modifierInfo = Array.isArray(effect && effect.modifierInfo)
        ? effect.modifierInfo
        : [];
      for (const modifier of modifierInfo) {
        if (
          !modifier ||
          modifier.domain !== "structureID" ||
          modifier.func !== "ItemModifier" ||
          toInt(modifier.operation, 0) !== 6
        ) {
          continue;
        }
        const targets = getNativeModifierTargets(rigTypeID, toInt(modifier.modifiedAttributeID, 0));
        if (!targets.length) {
          continue;
        }
        const sourceValue = getRigSourceAttribute(
          attributes,
          modifier.modifyingAttributeID,
          securityBand,
        );
        const amount = postPercentAmount(sourceValue);
        if (!(amount > 0) || Math.abs(amount - 1) <= 1e-9) {
          continue;
        }
        for (const target of targets) {
          if (
            appendActivityModifier(
              activities,
              target,
              amount,
              INDUSTRY_REFERENCE.RIG,
            )
          ) {
            appendRigActivityID(rigModifiers, rigTypeID, target.activityID);
          }
        }
      }
    }
  }

  for (const activityIDs of Object.values(rigModifiers)) {
    activityIDs.sort((left, right) => left - right);
  }
  return rigModifiers;
}

function buildStructureIndustryFacilityModifiers(structure, activities = {}) {
  const nextActivities = cloneActivities(activities);
  applyNativeHullModifiers(structure, nextActivities);
  const rigModifiers = applyFittedRigModifiers(structure, nextActivities);
  return {
    activities: nextActivities,
    rigModifiers,
  };
}

function resetIndustryFacilityModifierCachesForTests() {
  typeDogmaPayload = null;
  categoryByGroupID = null;
}

module.exports = {
  RIG_SLOT_FLAGS,
  getNativeModifierTargets,
  buildStructureIndustryFacilityModifiers,
  resetIndustryFacilityModifierCachesForTests,
};
