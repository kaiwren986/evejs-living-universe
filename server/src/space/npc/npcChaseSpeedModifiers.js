"use strict";

const {
  toFiniteNumber,
} = require("../../common/numbers");

const path = require("path");

const {
  applyPassiveShipAttributeModifiers,
  getAttributeIDByNames,
} = require(path.join(__dirname, "../../services/fitting/liveFittingState"));

const ATTRIBUTE_MAX_VELOCITY = getAttributeIDByNames("maxVelocity") || 37;

function resolveNpcChaseMaxVelocity(baseMaxVelocity, modifierEntries = []) {
  const normalizedBase = Math.max(0, toFiniteNumber(baseMaxVelocity, 0));
  if (normalizedBase <= 0) {
    return 0;
  }

  const maxVelocityModifiers = (Array.isArray(modifierEntries) ? modifierEntries : [])
    .filter((entry) => (
      Number.isSafeInteger(Number(entry && entry.modifiedAttributeID)) &&
      Number(entry.modifiedAttributeID) === ATTRIBUTE_MAX_VELOCITY
    ));
  if (maxVelocityModifiers.length === 0) {
    return normalizedBase;
  }

  const attributes = { [ATTRIBUTE_MAX_VELOCITY]: normalizedBase };
  applyPassiveShipAttributeModifiers(attributes, maxVelocityModifiers);
  return Math.max(
    0,
    toFiniteNumber(attributes[ATTRIBUTE_MAX_VELOCITY], normalizedBase),
  );
}

module.exports = {
  resolveNpcChaseMaxVelocity,
};
