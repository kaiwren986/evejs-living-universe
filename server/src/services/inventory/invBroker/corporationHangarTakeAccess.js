"use strict";

// The take rule for inventory moves out of a corporation hangar, shared by the inventory
// broker's item moves and corporation delivery.

const path = require("path");

const {
  canTakeFromCorporationHangarDivision,
  canTakeFromOwnerLocation,
} = require(path.join(__dirname, "../../industry/industryAccess"));

// Moving an item out of a corporation hangar is plain inventory work: it needs
// that division's Hangar Take role and nothing else. canTakeFromOwnerLocation
// additionally demands Factory Manager, which is right for drawing materials
// into an industry job and wrong here - it left a member holding only the
// division's take role unable to take from it. Flags with no mapped take role
// (canTakeFromCorporationHangarDivision returns null) keep their previous
// behaviour rather than being silently opened or closed.
function canTakeFromCorporationHangarForInventory(session, ownerID, locationID, flagID) {
  const divisionAccess = canTakeFromCorporationHangarDivision(
    session,
    ownerID,
    locationID,
    flagID,
  );
  return divisionAccess === null
    ? canTakeFromOwnerLocation(session, ownerID, locationID, flagID)
    : divisionAccess;
}

module.exports = {
  canTakeFromCorporationHangarForInventory,
};
