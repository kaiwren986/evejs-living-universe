"use strict";

// A ship's condition in the client's units.
//
// The store keeps a ship's hull damage, armor damage, shield charge and capacitor
// charge as fractions of the ship's own capacities (conditionState, each 0 to 1).
// The client is told each in its own units, as four dogma attributes of the ship:
// damage (3), charge (18), armorDamage (266) and shieldCharge (264).

const path = require("path");
const {
  getAttributeIDByNames,
} = require(path.join(__dirname, "../fitting/liveFittingState"));

const ATTRIBUTE_ITEM_DAMAGE = 3;
const ATTRIBUTE_STRUCTURE_HP = getAttributeIDByNames("hp", "structureHP") || 9;
const ATTRIBUTE_CHARGE = 18;
const ATTRIBUTE_SHIELD_CAPACITY = 263;
const ATTRIBUTE_SHIELD_CHARGE = 264;
const ATTRIBUTE_ARMOR_HP = 265;
const ATTRIBUTE_ARMOR_DAMAGE = 266;
const ATTRIBUTE_CAPACITOR_CAPACITY = 482;

/**
 * The four condition attributes of a ship, by attribute ID, worked out from the
 * ship's attributes (which hold its capacities) and its stored condition. One
 * whose capacity or fraction is not a number is left out.
 */
function buildShipConditionAttributes(shipAttributes = {}, condition = {}) {
  const worked = {};
  const shieldCapacity = Number(shipAttributes[ATTRIBUTE_SHIELD_CAPACITY]);
  if (
    Number.isFinite(shieldCapacity) &&
    shieldCapacity >= 0 &&
    Number.isFinite(condition.shieldCharge)
  ) {
    worked[ATTRIBUTE_SHIELD_CHARGE] = Number(
      (shieldCapacity * condition.shieldCharge).toFixed(6),
    );
  }
  const armorHP = Number(shipAttributes[ATTRIBUTE_ARMOR_HP]);
  if (
    Number.isFinite(armorHP) &&
    armorHP >= 0 &&
    Number.isFinite(condition.armorDamage)
  ) {
    worked[ATTRIBUTE_ARMOR_DAMAGE] = Number(
      (armorHP * condition.armorDamage).toFixed(6),
    );
  }
  // The client reads the hull as hp - damage (activeShipController.GetStructureHP),
  // the way it reads armor as armorHP - armorDamage, so "damage" is hit points
  // of hull damage. conditionState.damage stores the 0-1 fraction.
  const structureHP = Number(shipAttributes[ATTRIBUTE_STRUCTURE_HP]);
  if (
    Number.isFinite(structureHP) &&
    structureHP >= 0 &&
    Number.isFinite(condition.damage)
  ) {
    worked[ATTRIBUTE_ITEM_DAMAGE] = Number(
      (structureHP * condition.damage).toFixed(6),
    );
  }
  // CCP parity: Set attribute 18 ("charge") to the current capacitor energy
  // in GJ so the client's HUD capacitor gauge displays correctly.  The value
  // is capacitorCapacity * chargeRatio (conditionState.charge stores 0-1).
  const capacitorCapacity = Number(shipAttributes[ATTRIBUTE_CAPACITOR_CAPACITY]);
  if (
    Number.isFinite(capacitorCapacity) &&
    capacitorCapacity > 0 &&
    Number.isFinite(condition.charge)
  ) {
    worked[ATTRIBUTE_CHARGE] = Number(
      (capacitorCapacity * condition.charge).toFixed(6),
    );
  }
  return worked;
}

/**
 * The same four as the ship's own row of a ship's state has them (GetAllInfo's
 * shipState, ship.Board's answer), read from attributes that already hold them.
 * Tranquility's rows have amounts, and the same ones as the ship's attributes in
 * the same answer: a capsule's row reads charge 143.75 and shield 66.15 beside
 * 18: 143.75 and 264: 66.15, and a damaged ship's reads hull damage 95.399 and
 * armor damage 437.5. One that is not there is nought.
 */
function readShipConditionAmounts(shipAttributes = {}) {
  const read = (attributeID) => {
    const value = Number(shipAttributes[attributeID]);
    return Number.isFinite(value) ? value : 0;
  };
  return {
    damage: read(ATTRIBUTE_ITEM_DAMAGE),
    charge: read(ATTRIBUTE_CHARGE),
    armorDamage: read(ATTRIBUTE_ARMOR_DAMAGE),
    shieldCharge: read(ATTRIBUTE_SHIELD_CHARGE),
  };
}

module.exports = {
  buildShipConditionAttributes,
  readShipConditionAmounts,
};
