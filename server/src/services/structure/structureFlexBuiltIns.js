"use strict";

const {
  grantItemToOwnerLocation,
  listContainerItems,
  updateInventoryItem,
} = require("../inventory/itemStore");
const { getFlexFuelProfile } = require("./structureFlexFuelRuntime");
const { STRUCTURE_SERVICE_STATE, STRUCTURE_STATE } = require("./structureConstants");

const SERVICE_SLOT_0 = 164;

function isIntegratedFlexModule(structure, item) {
  const profile = getFlexFuelProfile(structure && structure.typeID);
  return Boolean(profile && item && Number(item.typeID) === profile.serviceModuleTypeID);
}

function moduleStateForStructure(structure, profile) {
  const online = !structure.destroyedAt &&
    Number(structure.serviceStates && structure.serviceStates[String(profile.serviceID)]) ===
      STRUCTURE_SERVICE_STATE.ONLINE;
  const fuelState = structure.devFlags && structure.devFlags.flexFuelState;
  return {
    online,
    serviceFuelNextCycleAt: online ? Number(fuelState && fuelState.nextCycleAt) || null : null,
    serviceFuelRemainder: 0,
  };
}

// Fitting and dogma expose real inventory items. Repair older anchored FLEXes
// as well as new deployments, without replacing a player's online/offline edit.
function ensureFlexServiceModule(structure) {
  const profile = getFlexFuelProfile(structure && structure.typeID);
  if (!profile || structure.destroyedAt || structure.state === STRUCTURE_STATE.UNANCHORED) {
    return { success: true, skipped: true };
  }
  const items = listContainerItems(null, structure.structureID, SERVICE_SLOT_0);
  const existing = items.find((item) => isIntegratedFlexModule(structure, item));
  if (existing) return { success: true, item: existing, changes: [] };
  if (items.length > 0) return { success: false, errorMsg: "INTEGRATED_SERVICE_SLOT_OCCUPIED" };
  const result = grantItemToOwnerLocation(
    structure.ownerCorpID || structure.ownerID,
    structure.structureID,
    SERVICE_SLOT_0,
    profile.serviceModuleTypeID,
    1,
    { singleton: 1, moduleState: moduleStateForStructure(structure, profile) },
  );
  if (!result.success) return result;
  return { success: true, item: result.data.items[0], changes: result.data.changes || [] };
}

function syncFlexServiceModule(structure) {
  const ensured = ensureFlexServiceModule(structure);
  if (!ensured.success || !ensured.item) return ensured;
  const item = ensured.item;
  const nextState = moduleStateForStructure(structure, getFlexFuelProfile(structure.typeID));
  const currentState = item.moduleState || {};
  if (Boolean(currentState.online) === nextState.online &&
      (currentState.serviceFuelNextCycleAt || null) === nextState.serviceFuelNextCycleAt) {
    return ensured;
  }
  const result = updateInventoryItem(item.itemID, (current) => ({
    ...current,
    moduleState: { ...(current.moduleState || {}), ...nextState },
  }));
  return {
    success: result.success,
    item: result.success ? result.data : item,
    changes: result.success ? [{ previousData: item, item: result.data }] : [],
    errorMsg: result.errorMsg,
  };
}

// The FLEX service owns the startup charge and hourly clock. The fitted item
// follows that clock so the generic service-module runner cannot charge twice.
function onlineFlexService(structure, options = {}) {
  const profile = getFlexFuelProfile(structure.typeID);
  const result = require("./structureState").setStructureServiceState(
    structure.structureID, profile.serviceID, STRUCTURE_SERVICE_STATE.ONLINE, options,
  );
  return {
    ...result,
    changes: (result.fuelResult && result.fuelResult.changes) || [],
  };
}

function followFlexServiceCycle(structure, moduleItem) {
  const synced = syncFlexServiceModule(structure);
  const updated = synced.item || moduleItem;
  const online = Boolean(updated.moduleState && updated.moduleState.online);
  return {
    success: synced.success && online,
    errorMsg: online ? synced.errorMsg : "NOT_ENOUGH_FUEL",
    offlined: !online,
    moduleItem: updated,
    cycleCount: 0,
    changes: synced.changes || [],
  };
}

module.exports = {
  ensureFlexServiceModule,
  followFlexServiceCycle,
  isIntegratedFlexModule,
  onlineFlexService,
  syncFlexServiceModule,
};
