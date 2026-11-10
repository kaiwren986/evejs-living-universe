"use strict";

const campaign = require("./campaignTrailCatalog");
const native = require("./gallenteOutreachRecipes.json");
const { resolveItemByTypeID } = require("../inventory/itemTypeRegistry");
const SYSTEM_ID = 30002659;
// Authored replay HQ positions, not recovered retail dungeon coordinates.
const CENTERS = Object.freeze([92433, 92434, 92435].map((typeID, index) => {
  const type = resolveItemByTypeID(typeID);
  return Object.freeze({
    itemID: 8400300026590101 + index, beaconID: 8400300026590201 + index,
    typeID, name: type.name, radius: type.radius, graphicID: type.graphicID,
    position: { x: 120000000000 + index * 20000000, y: 10000000000, z: -80000000000 },
    ...native.centers[typeID].itemTrader,
  });
}));

function getCenter(itemID) { return CENTERS.find(center => center.itemID === Number(itemID)) || null; }
function getRecipe(center, recipeID) {
  return center?.recipes.includes(Number(recipeID)) ? native.recipes[recipeID] : null;
}

function getStaticEntitiesForSystem(systemID) {
  if (!campaign.canTrade() || Number(systemID) !== SYSTEM_ID) return [];
  return CENTERS.flatMap(center => {
    const common = { solarSystemID: SYSTEM_ID, ownerID: 500004, categoryID: 2,
      staticVisibilityScope: "system", velocity: { x: 0, y: 0, z: 0 },
      direction: { x: 1, y: 0, z: 0 } };
    const hqName = `${center.name.split("'s")[0]}'s Campaign HQ`;
    // The centres and their "system" beacons are global Balls, as upstream
    // shows them.
    return [
      { ...common, kind: "gallenteOutreachCenter", itemID: center.itemID, isGlobal: true,
        typeID: center.typeID, groupID: 226, graphicID: center.graphicID,
        itemName: center.name, slimName: center.name, radius: center.radius,
        position: { ...center.position } },
      { ...common, kind: "campaignTrailBeacon", itemID: center.beaconID, isGlobal: true,
        typeID: campaign.BEACON_TYPE_ID, groupID: 310, graphicID: 1211,
        itemName: hqName, slimName: hqName, radius: 1,
        position: { ...center.position, x: center.position.x + center.radius + 1500 } },
    ];
  });
}

module.exports = { SYSTEM_ID, CENTERS, getCenter, getRecipe, getStaticEntitiesForSystem };
