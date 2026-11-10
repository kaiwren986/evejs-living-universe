"use strict";

// Is a hull something a weapon can actually work on?
//
// NPC hit points come from the ship type's dogma and from nowhere else: no NPC
// profile carries a health override. 38 of the SDE's 7334 entity types have no
// typeDogma row at all - unpublished placeholders such as 53326 "Battleship
// Elite", the Swarm Overmind series and the Imperial Escort set - and three more
// (the diamond Molok and Dagon) have a row that declares no hit points. 30
// authored profiles point at one of those types.
//
// An NPC built from such a profile spawns with shieldCapacity, armorHP and
// structureHP all zero, which makes hasDamageableHealth() false. The rat
// renders, locks, orbits and can be warped to, but every weapon activation
// against it is refused, no drone will engage it, and no amount of damage can
// kill it - so a dungeon wave that rolls one never clears and the site is stuck
// for good. The Customs Office builder already guards the same failure by giving
// the office a dogma-derived health envelope; here there is no envelope to
// derive, so the profile is simply not spawnable.
//
// Every path that turns a spawn pool into a chosen profile asks this first.

const path = require("path");

const {
  getTypeAttributeValue,
} = require(path.join(__dirname, "../../services/fitting/liveFittingState"));
const log = require(path.join(__dirname, "../../utils/logger"));

const warnedProfileIDs = new Set();

function toPositiveInt(value) {
  const numeric = Math.trunc(Number(value) || 0);
  return numeric > 0 ? numeric : 0;
}

function shipTypeHasDamageableHull(shipTypeID) {
  const numericShipTypeID = toPositiveInt(shipTypeID);
  if (numericShipTypeID <= 0) {
    return false;
  }
  return (
    (Number(getTypeAttributeValue(numericShipTypeID, "shieldCapacity")) || 0) > 0 ||
    (Number(getTypeAttributeValue(numericShipTypeID, "armorHP")) || 0) > 0 ||
    (Number(getTypeAttributeValue(numericShipTypeID, "hp", "structureHP")) || 0) > 0
  );
}

// Reports once per profile rather than once per roll: a busy pool would
// otherwise repeat the same line for every wave in every site, forever.
function npcProfileHasDamageableHull(profile) {
  const shipTypeID = toPositiveInt(profile && profile.shipTypeID);
  if (shipTypeHasDamageableHull(shipTypeID)) {
    return true;
  }

  const profileID = String(profile && profile.profileID || "").trim();
  if (profileID && !warnedProfileIDs.has(profileID)) {
    warnedProfileIDs.add(profileID);
    log.warn(
      `[NpcSpawn] profile ${profileID} is not spawnable: entity type ${shipTypeID} ` +
      "declares no shield, armor or structure hit points, so the spawned NPC " +
      "could not be shot at, damaged or killed",
    );
  }
  return false;
}

module.exports = {
  npcProfileHasDamageableHull,
};
