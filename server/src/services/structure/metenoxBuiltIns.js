"use strict";

/**
 * What a Metenox Moon Drill is built with: its drill module and its core.
 *
 * The SDE pre-fits both on the Metenox type: preFitServiceSlot0 (2792) is the
 * Standup Metenox Moon Drill (82941), and preFitStructureCore (5701) is the
 * Integrated Moon Drill Armature (81920), the core CCP describes as built into
 * the structure during manufacture and always dropped when it dies. Neither
 * can be fitted or removed by a player. The client's fitting window shows
 * only real items at the service slot flags, and a player onlines or
 * offlines the drill there with the ordinary dogma SetModuleOnline and
 * TakeModuleOffline calls (fittingController, clientDogmaLocation), so the
 * drill has to exist as an item in service slot 0; the core sits in the deed
 * bay like an installed quantum core, so the Metenox can finish onlining.
 *
 * The drill's fuel is the Metenox's own: 1,000 fuel blocks to online, then 5
 * blocks and 200 Magmatic Gas an hour, all charged by
 * structureAutoMoonFuelRuntime. This module keeps the drill item in step with
 * that service in both directions, so the generic service-module fuel cycle
 * never charges it a second time and a starved or reinforced Metenox shows
 * its drill offline.
 */

const path = require("path");

const log = require(path.join(__dirname, "../../utils/logger"));
const { getWallclockNowMs } = require(path.join(__dirname, "../../space/runtime/runtimeClock"));

const TYPE_METENOX_MOON_DRILL = 81826;
const TYPE_METENOX_DRILL_MODULE = 82941;
const TYPE_METENOX_CORE = 81920;
const FLAG_STRUCTURE_DEED = 180;
const SERVICE_SLOT_FLAGS = Object.freeze([164, 165, 166, 167, 168, 169, 170, 171]);
const HOUR_MS = 60 * 60 * 1000;

// The Metenox tick mirrors the service onto the module several times a
// second; remember what was last applied so an unchanged state costs a Map
// lookup rather than an inventory read.
const lastMirroredByStructureID = new Map();

function toPositiveInt(value) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : 0;
}

function lazy(relativeId) {
  return require(path.join(__dirname, relativeId));
}

function isMetenox(structure) {
  return toPositiveInt(structure && structure.typeID) === TYPE_METENOX_MOON_DRILL;
}

/** Whether a fitted module is the Metenox's own drill. */
function isIntegratedDrill(structure, moduleItem) {
  return isMetenox(structure) &&
    toPositiveInt(moduleItem && moduleItem.typeID) === TYPE_METENOX_DRILL_MODULE;
}

function findDrillModule(structureID) {
  const { listContainerItems } = lazy("../inventory/itemStore");
  return (listContainerItems(null, structureID, null) || []).find((item) => (
    item &&
    toPositiveInt(item.typeID) === TYPE_METENOX_DRILL_MODULE &&
    SERVICE_SLOT_FLAGS.includes(Number(item.flagID))
  )) || null;
}

/** Put the built-in drill in service slot 0 of a Metenox that lacks it. */
function ensureDrillFitted(structureID) {
  const structure = lazy("./structureState").getStructureByID(toPositiveInt(structureID), { refresh: false });
  if (!isMetenox(structure) || structure.destroyedAt) {
    return { success: true, skipped: true };
  }
  const existing = findDrillModule(structure.structureID);
  if (existing) {
    return { success: true, fitted: false, item: existing };
  }
  const ownerID = toPositiveInt(structure.ownerCorpID || structure.ownerID);
  const { listContainerItems, grantItemToOwnerLocation } = lazy("../inventory/itemStore");
  const freeFlag = SERVICE_SLOT_FLAGS.find(
    (flagID) => (listContainerItems(null, structure.structureID, flagID) || []).length === 0,
  );
  if (!ownerID || !freeFlag) {
    return { success: false, errorMsg: ownerID ? "NO_FREE_SERVICE_SLOT" : "STRUCTURE_HAS_NO_OWNER" };
  }
  const { resolveItemByTypeID } = lazy("../inventory/itemTypeRegistry");
  const result = grantItemToOwnerLocation(
    ownerID,
    structure.structureID,
    freeFlag,
    resolveItemByTypeID(TYPE_METENOX_DRILL_MODULE),
    1,
    { singleton: 1, moduleState: { online: false } },
  );
  if (!result || result.success !== true) {
    log.warn(
      `[MetenoxBuiltIns] could not fit the built-in drill to Metenox ${structure.structureID}: ` +
        `${(result && result.errorMsg) || "UNKNOWN"}`,
    );
    return { success: false, errorMsg: (result && result.errorMsg) || "GRANT_FAILED" };
  }
  return { success: true, fitted: true };
}

/**
 * Put the built-in core in the deed bay and mark the Metenox cored, as a
 * docked pilot installing a quantum core does for other structures.
 */
function ensureCoreInstalled(structureID) {
  const structureState = lazy("./structureState");
  const structure = structureState.getStructureByID(toPositiveInt(structureID), { refresh: false });
  if (!isMetenox(structure) || structure.destroyedAt || structure.hasQuantumCore === true) {
    return { success: true, skipped: true };
  }
  const ownerID = toPositiveInt(structure.ownerCorpID || structure.ownerID);
  const { listContainerItems, grantItemToOwnerLocation } = lazy("../inventory/itemStore");
  const hasCoreItem = (listContainerItems(null, structure.structureID, FLAG_STRUCTURE_DEED) || [])
    .some((item) => toPositiveInt(item && item.typeID) === TYPE_METENOX_CORE);
  if (!hasCoreItem) {
    const { resolveItemByTypeID } = lazy("../inventory/itemTypeRegistry");
    const granted = grantItemToOwnerLocation(
      ownerID,
      structure.structureID,
      FLAG_STRUCTURE_DEED,
      resolveItemByTypeID(TYPE_METENOX_CORE),
      1,
      { singleton: 1 },
    );
    if (!granted || granted.success !== true) {
      log.warn(
        `[MetenoxBuiltIns] could not place the built-in core in Metenox ${structure.structureID}: ` +
          `${(granted && granted.errorMsg) || "UNKNOWN"}`,
      );
      return { success: false, errorMsg: (granted && granted.errorMsg) || "GRANT_FAILED" };
    }
  }
  const installed = structureState.setStructureQuantumCoreInstalled(structure.structureID, true);
  return { success: Boolean(installed && installed.success), installed: true };
}

/** A Metenox's drill and core, fitted if missing. */
function ensureBuiltIns(structureID) {
  return {
    drill: ensureDrillFitted(structureID),
    core: ensureCoreInstalled(structureID),
  };
}

/**
 * Mirror the Metenox drill service onto its module: online with the
 * service's next cycle as its fuel clock, or offline.
 */
function syncDrillModuleOnline(structureID, online, nextCycleAt = 0) {
  const moduleItem = findDrillModule(toPositiveInt(structureID));
  if (!moduleItem) {
    return { success: true, changed: false };
  }
  const state = moduleItem.moduleState || {};
  const nextFuelCycleAt = online ? toPositiveInt(nextCycleAt) || null : null;
  if (Boolean(state.online) === Boolean(online) && (state.serviceFuelNextCycleAt || null) === nextFuelCycleAt) {
    return { success: true, changed: false };
  }
  const { updateInventoryItem } = lazy("../inventory/itemStore");
  const result = updateInventoryItem(moduleItem.itemID, (current) => ({
    ...current,
    moduleState: {
      ...(current.moduleState || {}),
      online: Boolean(online),
      serviceFuelNextCycleAt: nextFuelCycleAt,
      serviceFuelRemainder: 0,
    },
  }));
  return { success: Boolean(result && result.success), changed: true, result };
}

/** The Metenox tick's view of its service, mirrored onto the module. */
function mirrorDrillService(structureID, online, nextCycleAt = 0) {
  const id = toPositiveInt(structureID);
  const key = `${Boolean(online)}:${online ? toPositiveInt(nextCycleAt) : 0}`;
  if (!id || lastMirroredByStructureID.get(id) === key) {
    return { success: true, changed: false };
  }
  const result = syncDrillModuleOnline(id, online, nextCycleAt);
  if (result.success) {
    lastMirroredByStructureID.set(id, key);
  }
  return result;
}

/**
 * A player onlines the drill (dogma SetModuleOnline). The Metenox service
 * pays its online fuel and starts its clock, exactly as the service does.
 */
function onlineDrillService(structureID, options = {}) {
  const structureState = lazy("./structureState");
  const { STRUCTURE_SERVICE_ID, STRUCTURE_SERVICE_STATE } = lazy("./structureConstants");
  const result = structureState.setStructureServiceState(
    toPositiveInt(structureID),
    STRUCTURE_SERVICE_ID.AUTOMOONMINING,
    STRUCTURE_SERVICE_STATE.ONLINE,
    { nowMs: options.nowMs },
  );
  if (!result || result.success !== true) {
    return {
      success: false,
      errorMsg: (result && result.errorMsg) || "NOT_ENOUGH_FUEL",
      changes: [],
    };
  }
  const fuelState = result.data && result.data.devFlags && result.data.devFlags.autoMoonFuelState;
  const nextCycleAt = toPositiveInt(fuelState && fuelState.nextCycleAt) ||
    (Number(options.nowMs) || getWallclockNowMs()) + HOUR_MS;
  syncDrillModuleOnline(structureID, true, nextCycleAt);
  return {
    success: true,
    changes: (result.fuelResult && result.fuelResult.changes) || [],
  };
}

/**
 * The generic hourly service-module cycle reaches the drill. The Metenox
 * clock has already charged the hour, so this only follows it: an online
 * service moves the module's clock to the next Metenox cycle, an offline one
 * (starved or reinforced) offlines the module.
 */
function followDrillServiceCycle(structure, moduleItem, nowMs) {
  const { STRUCTURE_SERVICE_ID, STRUCTURE_SERVICE_STATE } = lazy("./structureConstants");
  const online = Number(
    structure && structure.serviceStates &&
      structure.serviceStates[String(STRUCTURE_SERVICE_ID.AUTOMOONMINING)],
  ) === STRUCTURE_SERVICE_STATE.ONLINE;
  const fuelState = structure && structure.devFlags && structure.devFlags.autoMoonFuelState;
  const nextCycleAt = Math.max(
    toPositiveInt(fuelState && fuelState.nextCycleAt),
    (Number(nowMs) || getWallclockNowMs()) + 1,
  );
  const synced = syncDrillModuleOnline(structure.structureID, online, nextCycleAt);
  const updated = findDrillModule(structure.structureID) || moduleItem;
  const changes = synced.result && synced.result.success
    ? [{ previousData: synced.result.previousData || moduleItem, item: synced.result.data }]
    : [];
  return online
    ? { success: true, moduleItem: updated, cycleCount: 0, changes }
    : { success: false, errorMsg: "NOT_ENOUGH_FUEL", offlined: true, moduleItem: updated, cycleCount: 0, changes };
}

module.exports = {
  TYPE_METENOX_CORE,
  TYPE_METENOX_DRILL_MODULE,
  ensureBuiltIns,
  ensureCoreInstalled,
  ensureDrillFitted,
  findDrillModule,
  followDrillServiceCycle,
  isIntegratedDrill,
  mirrorDrillService,
  onlineDrillService,
  resetMetenoxDrillModuleForTests: () => lastMirroredByStructureID.clear(),
  syncDrillModuleOnline,
};
