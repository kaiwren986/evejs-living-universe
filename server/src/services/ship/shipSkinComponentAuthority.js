"use strict";

const { cloneValue } = require("../../common/clone");
const { TABLE, readStaticTable } = require("../_shared/referenceData");
const COMPONENT_CATEGORY = Object.freeze({ MATERIAL: 1, PATTERN: 2, METALLIC: 3 });
function authority() { return readStaticTable(TABLE.SHIP_SKIN_COMPONENT_AUTHORITY); }
function getShipSkinComponent(componentID) {
  return cloneValue(authority().componentsByID?.[String(componentID)] || null);
}
function getShipSkinComponentItemByTypeID(typeID) {
  return cloneValue(authority().itemsByTypeID?.[String(typeID)] || null);
}
function getShipSkinSlot(slotID) { return cloneValue(authority().slotsByID?.[String(slotID)] || null); }
function getShipSkinSlotConfiguration(shipTypeID) {
  return cloneValue((authority().slotConfigurations || []).find(config =>
    config.allowAllShips || config.shipTypeIDs.includes(Number(shipTypeID))) || null);
}
function listShipSkinComponents() { return cloneValue(Object.values(authority().componentsByID || {})); }
function buildComponentIdentifier(componentOrID) {
  const component = typeof componentOrID === "object" ? componentOrID : getShipSkinComponent(componentOrID);
  return component ? { [component.categoryID === COMPONENT_CATEGORY.PATTERN ? "pattern" : "coating"]:
    { sequential: component.componentID } } : null;
}
function resolveComponentIdentifier(identifier) {
  const coating = Number(identifier?.coating?.sequential || 0);
  const pattern = Number(identifier?.pattern?.sequential || 0);
  if (Boolean(coating) === Boolean(pattern)) return null;
  const component = getShipSkinComponent(coating || pattern);
  return component && ((component.categoryID === COMPONENT_CATEGORY.PATTERN) === Boolean(pattern)) ? component : null;
}
module.exports = { COMPONENT_CATEGORY, getShipSkinComponent, getShipSkinComponentItemByTypeID,
  getShipSkinSlot, getShipSkinSlotConfiguration, listShipSkinComponents, buildComponentIdentifier, resolveComponentIdentifier };
