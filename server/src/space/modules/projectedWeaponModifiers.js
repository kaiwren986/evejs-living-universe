"use strict";

const path = require("path");

const {
  getRequiredSkillRequirements,
} = require(path.join(__dirname, "../../services/fitting/liveFittingState"));

// Skill type IDs the decompiled client names in its own projection tables.
// `invConst.typeGunnery` is 3300.
const SKILL_GUNNERY = 3300;

// A Remote Tracking Computer and a Tracking Disruptor both project onto the
// weapons of *another* ship, and both are declared in the V24 client as
// location modifiers keyed on a required skill:
//
//   eve/common/script/dogma/pythonEffects/remoteTrackingComputer.py
//     SKILL_MODIFIER_CHANGES_FOR_LOCATION = [
//       (dgmAssPostPercent, invConst.typeGunnery, attributeMaxRange,      attributeMaxRangeBonus),
//       (dgmAssPostPercent, invConst.typeGunnery, attributeFalloff,       attributeFalloffBonus),
//       (dgmAssPostPercent, invConst.typeGunnery, attributeTrackingSpeed, attributeTrackingSpeedBonus)]
//
//   eve/common/script/dogma/pythonEffects/weaponDisruptionUtil.py
//     GetTrackingDisruptionAttributes()[categoryShip] -> the same three rows,
//     also keyed on invConst.typeGunnery.
//
// Neither effect carries any modifierInfo in the SDE, so this engine builds the
// modifier entries itself — and, until this filter existed, applied them to
// every weapon module on the target with no skill test at all. That reached the
// one published weapon family that declares `maxRange` without requiring
// Gunnery: Vorton Projectors, which require Vorton Projector Operation (55033).
//
// The client's *other* branches — categoryEntity, categoryDrone,
// categoryFighter — carry `None` where the skill would be, i.e. no filter. Our
// native NPCs fire synthetic hull modules stamped with the NPC hull's own
// typeID, which declares no weapon skill, so "declares no required skill at
// all" is treated as unfiltered and NPC weapons keep behaving exactly as
// before.
function weaponItemAcceptsRequiredSkill(weaponModuleItem, requiredSkillTypeID) {
  const skillTypeID = Number(requiredSkillTypeID);
  if (!Number.isFinite(skillTypeID) || skillTypeID <= 0) {
    return true;
  }
  if (!weaponModuleItem || typeof weaponModuleItem !== "object") {
    return true;
  }
  if (weaponModuleItem.npcSyntheticHullModule === true) {
    return true;
  }
  const typeID = Number(weaponModuleItem.typeID);
  if (!Number.isFinite(typeID) || typeID <= 0) {
    return true;
  }
  const requirements = getRequiredSkillRequirements(typeID) || [];
  if (requirements.length === 0) {
    return true;
  }
  return requirements.some(
    (requirement) => Number(requirement && requirement.skillTypeID) === skillTypeID,
  );
}

// Drops the entries whose declared `requiredSkillTypeID` the weapon module does
// not satisfy. Entries without one are always kept, so families that project
// unconditionally are untouched.
function filterProjectedWeaponModifierEntries(entries, weaponModuleItem) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return [];
  }
  if (!weaponModuleItem) {
    return [...entries];
  }
  return entries.filter((entry) => weaponItemAcceptsRequiredSkill(
    weaponModuleItem,
    entry && entry.requiredSkillTypeID,
  ));
}

module.exports = {
  SKILL_GUNNERY,
  weaponItemAcceptsRequiredSkill,
  filterProjectedWeaponModifierEntries,
};
