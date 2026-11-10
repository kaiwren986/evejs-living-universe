"use strict";

const {
  toInt,
} = require("../common/numbers");

const path = require("path");

const {
  resolveItemByTypeID,
} = require(path.join(__dirname, "../services/inventory/itemTypeRegistry"));

// Podding leaves a corpse rather than a wreck. Both corpse types live in the
// Biomass group, which is what the client keys its Corpse space object and its
// Scoop to Cargo Hold menu entry off of
// (clientcodegrabber/latest/menucheckers/baseCheckers.py IsBiomass).
const GROUP_BIOMASS = 14;
const CORPSE_TYPE_ID_MALE = 25;
const CORPSE_TYPE_ID_FEMALE = 29148;
// carbon/common/lib/const.py: genderFemale = 0, genderMale = 1. Anything else
// falls back to the male corpse rather than guessing.
const GENDER_ID_FEMALE = 0;

function isCorpseType(itemOrType) {
  if (!itemOrType) {
    return false;
  }
  const groupID = toInt(itemOrType.groupID, 0);
  if (groupID === GROUP_BIOMASS) {
    return true;
  }
  if (groupID > 0) {
    return false;
  }
  const typeRecord = resolveItemByTypeID(toInt(itemOrType.typeID, 0));
  return toInt(typeRecord && typeRecord.groupID, 0) === GROUP_BIOMASS;
}

function resolveCorpseTypeID(genderID) {
  return toInt(genderID, -1) === GENDER_ID_FEMALE
    ? CORPSE_TYPE_ID_FEMALE
    : CORPSE_TYPE_ID_MALE;
}

function resolveCorpseType(genderID) {
  const corpseTypeID = resolveCorpseTypeID(genderID);
  const typeRecord = resolveItemByTypeID(corpseTypeID);
  if (typeRecord && toInt(typeRecord.groupID, 0) === GROUP_BIOMASS) {
    return typeRecord;
  }
  return resolveItemByTypeID(CORPSE_TYPE_ID_MALE) || null;
}

module.exports = {
  CORPSE_TYPE_ID_FEMALE,
  CORPSE_TYPE_ID_MALE,
  GROUP_BIOMASS,
  isCorpseType,
  resolveCorpseType,
  resolveCorpseTypeID,
};
