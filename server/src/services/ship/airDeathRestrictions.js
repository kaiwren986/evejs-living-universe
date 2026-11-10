"use strict";

// Read-only restrictions for an already accepted AIR loss. The death owners
// retain authority to settle it; ordinary player actions cannot change its tree.
function accepted(characterID) {
  if (!(Number(characterID) > 0)) return [];
  return Object.values(require("../character/characterState").peekCharacterRecord(Number(characterID))?.authoredAirTutorial?.encounter?.combat?.deaths || {})
    .filter(entry => entry.status === "accepted" && entry.plan?.shipRecord?.ownerID === Number(characterID));
}
function shipPending(characterID, shipID) {
  return accepted(characterID).some(entry => entry.plan.shipRecord.itemID === Number(shipID));
}
function mutationBlocked(characterID, itemID, destinationID) {
  const contains = node => Number(node.itemID) === Number(itemID) ||
    [...node.children || [], ...node.resolvedChildren || []].some(contains);
  return accepted(characterID).some(entry => {
    const hullID = entry.plan.shipRecord.itemID;
    return hullID === Number(itemID) || hullID === Number(destinationID) || entry.plan.loot.resolvedTree.some(contains);
  });
}
module.exports = { shipPending, mutationBlocked };
