"use strict";

// EveJS RPG fork: one-click test ships.
//
// Hands a docked pilot a fully fitted hull and maximum skills so that contract
// content can be played and tuned. A development aid, reached from Crew Link's
// Requisition tab; it is not part of the game's economy. It reuses the pieces
// EveJS's own preset-fit commands (/laser, /heavy, ...) are built from: spawn a
// hull in the hangar, grant items to the hangar, move them onto the ship, board.

const path = require("path");

const {
  spawnShipInHangarForSession,
  activateShipForSession,
  getActiveShipRecord,
} = require(path.join(__dirname, "../../services/character/characterState"));
const { moveItemTypeFromCharacterLocation, ITEM_FLAGS } =
  require(path.join(__dirname, "../../services/inventory/itemStore"));
const { resolveShipByName } = require(path.join(__dirname, "../../services/chat/shipTypeRegistry"));
const { resolveItemByName } = require(path.join(__dirname, "../../services/inventory/itemTypeRegistry"));
const { selectAutoFitFlagForType, listFittedItems } =
  require(path.join(__dirname, "../../services/fitting/liveFittingState"));
const { getDockedLocationID } = require(path.join(__dirname, "../../services/structure/structureLocation"));
const { syncInventoryChangesToSession, grantStationHangarBatchAndSyncSession } =
  require(path.join(__dirname, "../../services/chat/commands/commandInventorySync"));
const log = require(path.join(__dirname, "../../utils/logger"));

// Fits are listed in fitting order. Each must be valid for an all-skills-V pilot.
const LOADOUTS = Object.freeze({
  gila: {
    label: "Gila",
    summary: "Drone cruiser. Two faction medium drones do most of the work; rapid light launchers finish frigates. Passive shield tank.",
    ship: "Gila",
    modules: [
      ["Caldari Navy Rapid Light Missile Launcher", 4],
      ["Caldari Navy Large Shield Extender", 3],
      ["Pithum C-Type Multispectrum Shield Hardener", 2],
      ["Republic Fleet 10MN Afterburner", 1],
      ["Dread Guristas Drone Damage Amplifier", 3],
      ["Medium Core Defense Field Purger II", 3],
    ],
    drones: [
      ["Caldari Navy Vespa", 6],
      ["Federation Navy Hammerhead", 4],
    ],
    cargo: [
      ["Caldari Navy Scourge Light Missile", 3000],
      ["Caldari Navy Inferno Light Missile", 2000],
      ["Nanite Repair Paste", 200],
    ],
  },
});

function fail(message) {
  const error = new Error(message);
  error.code = "REQUISITION";
  return error;
}

function resolveEntries(rows) {
  return rows.map(([name, quantity]) => {
    const itemType = resolveItemByName(name, { exactOnly: true })?.match;
    if (!itemType) throw fail(`Supply error: "${name}" is not in the item database.`);
    return { itemType, quantity };
  });
}

function move(session, stationID, shipItem, flagID, itemType, quantity) {
  const result = moveItemTypeFromCharacterLocation(
    session.characterID, stationID, ITEM_FLAGS.HANGAR, shipItem.itemID, flagID, itemType.typeID, quantity,
  );
  if (result.success) syncInventoryChangesToSession(session, result.data && result.data.changes);
  return result.success === true;
}

function board(session, stationID, shipItem, serviceManager) {
  const shipService = serviceManager && typeof serviceManager.lookup === "function" ? serviceManager.lookup("ship") : null;
  if (shipService && typeof shipService.callMethod === "function") {
    shipService.callMethod("BoardStoredShip", [stationID, shipItem.itemID], session, null);
  } else {
    activateShipForSession(session, shipItem.itemID, { emitNotifications: true, logSelection: false });
  }
  return Number(getActiveShipRecord(session.characterID)?.itemID) === Number(shipItem.itemID);
}

function listLoadouts() {
  return Object.entries(LOADOUTS).map(([key, loadout]) => ({ key, label: loadout.label, summary: loadout.summary }));
}

/**
 * Give the docked pilot max skills and a fitted ship, and board it.
 * @returns {{label: string, notes: string[]}} what was done, in plain words
 */
function requisition(session, key, { serviceManager, grantSkills } = {}) {
  const loadout = LOADOUTS[String(key || "").toLowerCase()];
  if (!loadout) throw fail("That loadout does not exist.");
  const stationID = Number(getDockedLocationID(session) || 0);
  if (stationID <= 0) throw fail("Dock at a station first. Ships are delivered to your hangar.");

  const notes = [];
  if (typeof grantSkills === "function") {
    grantSkills();
    notes.push("All skills trained to V.");
  }

  const shipType = resolveShipByName(loadout.ship);
  if (!shipType?.success || !shipType.match) throw fail(`Supply error: no hull named ${loadout.ship}.`);
  const modules = resolveEntries(loadout.modules);
  const drones = resolveEntries(loadout.drones);
  const cargo = resolveEntries(loadout.cargo);

  const spawned = spawnShipInHangarForSession(session, shipType.match);
  if (!spawned?.success || !spawned.ship) throw fail("The hull could not be delivered to your hangar.");
  const shipItem = spawned.ship;

  const granted = grantStationHangarBatchAndSyncSession(session, stationID, [...modules, ...drones, ...cargo]);
  if (!granted?.success) throw fail(`The equipment could not be delivered (${granted?.errorMsg || "write error"}).`);

  let fitted = 0;
  let wanted = 0;
  for (const { itemType, quantity } of modules) {
    for (let index = 0; index < quantity; index += 1) {
      wanted += 1;
      const flagID = selectAutoFitFlagForType(shipItem, listFittedItems(session.characterID, shipItem.itemID), itemType.typeID);
      if (flagID && move(session, stationID, shipItem, flagID, itemType, 1)) fitted += 1;
    }
  }
  notes.push(fitted === wanted
    ? `${loadout.label} fitted (${fitted} modules and rigs).`
    : `${loadout.label}: ${fitted} of ${wanted} modules fitted; the rest are in your hangar.`);

  const droneCount = drones.reduce((sum, { itemType, quantity }) =>
    sum + (move(session, stationID, shipItem, ITEM_FLAGS.DRONE_BAY, itemType, quantity) ? quantity : 0), 0);
  notes.push(droneCount ? `${droneCount} drones loaded in the drone bay.` : "Drones are in your hangar; drag them to the drone bay.");

  const stowed = cargo.filter(({ itemType, quantity }) => move(session, stationID, shipItem, ITEM_FLAGS.CARGO_HOLD, itemType, quantity));
  notes.push(stowed.length === cargo.length
    ? "Missiles and repair paste are in the cargo hold. Load the launchers before you undock (right-click a launcher)."
    : "Some supplies stayed in your hangar.");

  const boarded = board(session, stationID, shipItem, serviceManager);
  notes.push(boarded ? `You are now flying the ${loadout.label}.` : `The ${loadout.label} is in your hangar. Right-click it and choose Make Active.`);
  log.info(`[Requisition] ${session.characterID} took a ${loadout.label}: ${fitted}/${wanted} modules, ${droneCount} drones, boarded=${boarded}`);
  return { label: loadout.label, notes };
}

module.exports = { listLoadouts, requisition };
