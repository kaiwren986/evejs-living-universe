"use strict";

const { getActiveShipRecord, syncShipFittingStateForSession } = require("../../character/characterState");
const { getShipFittingSnapshot } = require("../../../_secondary/fitting/fittingRuntime");
const { getDockedLocationID, isDockedSession } = require("../../structure/structureLocation");
const fitting = require("../../fitting/liveFittingState");
const overrides = require("../../dogma/gmDogmaOverrides");
const { hasStaffDebugRole } = require("./commandAccess");
const { handledResult } = require("./commandReplies");
const log = require("../../../utils/logger");

function validateSlotEdit(ship, attributeName, value) {
  const families = { hiSlots: "high", medSlots: "med", lowSlots: "low", rigSlots: "rig" };
  if (!Object.hasOwn(families, attributeName) && attributeName !== "upgradeSlotsLeft") return null;
  const fitted = fitting.listFittedItems(ship.ownerID, ship.itemID);
  if (attributeName === "upgradeSlotsLeft") {
    return value < fitting.getFittedEffectSlotsUsed(fitted, "rigSlot")
      ? "Unfit rigs before reducing upgradeSlotsLeft below their slot usage." : null;
  }
  const family = families[attributeName];
  const attributeID = overrides.SHIP_RESOURCE_ATTRIBUTES[attributeName];
  const oldBase = overrides.getAttributeOverrides(ship)[attributeID] ??
    fitting.getShipBaseAttributeValue(ship.typeID, attributeName) ?? 0;
  const nextCount = fitting.getShipSlotCounts(ship.typeID, fitted, ship.itemID)[family] + value - oldBase;
  if (nextCount < 0 || nextCount > 8) return "The slot base plus subsystem modifiers must remain between 0 and 8.";
  const flags = fitting.SLOT_FAMILY_FLAGS[family];
  return fitted.some((item) => fitting.isFittedModuleItem(item) && flags.includes(Number(item.flagID)) &&
    flags.indexOf(Number(item.flagID)) >= nextCount)
    ? "Unfit modules from the affected slots before reducing the slot count." : null;
}

function handleDogmaCommand(session, argumentText, chatHub, options) {
  const reply = (message) => handledResult(chatHub, session, options, message);
  if (!hasStaffDebugRole(session)) return reply("/dogma requires a staff/admin role.");
  const match = /^(me|"me"|'me'|\d+)\s+(?:(reset)|([A-Za-z][A-Za-z0-9]*)\s*=\s*(\S+))$/i.exec(String(argumentText || "").trim());
  if (!match) return reply("Usage: /dogma <me|activeShipID> <attributeName> = <value>, or /dogma me reset");
  const characterID = Number(session && session.characterID) || 0;
  const ship = characterID > 0 && getActiveShipRecord(characterID);
  const requestedID = /^['"]?me['"]?$/i.test(match[1]) ? Number(ship && ship.itemID) : Number(match[1]);
  if (!ship || !Number.isSafeInteger(requestedID) || Number(ship.itemID) !== requestedID ||
      Number(ship.ownerID) !== characterID || !isDockedSession(session) ||
      Number(ship.locationID) !== Number(getDockedLocationID(session))) {
    return reply("/dogma currently supports only your own docked active ship.");
  }
  const hardpointError = validateHardpointEdit(ship, match[3], Number(match[4]));
  if (hardpointError) return reply(hardpointError);
  const resetting = Boolean(match[2]);
  const attributeName = match[3];
  const attributeID = overrides.SHIP_RESOURCE_ATTRIBUTES[attributeName];
  const value = Number(match[4]);
  if (!resetting && (!Object.hasOwn(overrides.SHIP_RESOURCE_ATTRIBUTES, attributeName) ||
      fitting.getAttributeIDByNames(attributeName) !== attributeID)) {
    return reply(`Supported /dogma attributes: ${Object.keys(overrides.SHIP_RESOURCE_ATTRIBUTES).join(", ")}.`);
  }
  if (!resetting && !overrides.isValidAttributeValue(attributeID, value)) {
    return reply(overrides.isFittingCountAttribute(attributeID)
      ? "Fitting counts must be whole numbers from 0 to 8."
      : "The attribute value must be a finite number greater than 0 and at most 1000000000000.");
  }
  const slotError = !resetting && validateSlotEdit(ship, attributeName, value);
  if (slotError) return reply(slotError);
  // Retain the actual pre-change snapshot for client deltas before moving the
  // Dogma version. The resource builder applies the new BASE before modifiers.
  getShipFittingSnapshot(characterID, ship);
  if (resetting) overrides.clearShipOverrides(session, ship.itemID);
  else if (!overrides.setAttributeOverride(session, ship, attributeID, value)) return reply("Dogma assignment refused.");
  syncShipFittingStateForSession(session, ship.itemID, { emitInventorySync: false });
  log.info(`[GM dogma] character=${characterID} ship=${ship.itemID} ${resetting ? "reset" : `${attributeName} base=${value}`}`);
  return reply(resetting ? "Cleared your temporary Dogma overrides for this ship."
    : `Set ${attributeName} base to ${value} on ship ${ship.itemID}; normal modifiers still apply. Temporary until disconnect or /dogma me reset.`);
}

function validateHardpointEdit(ship, name, value) {
  if (!["turretSlotsLeft", "launcherSlotsLeft"].includes(name) || !Number.isInteger(value) || value < 0 || value > 8) return null;
  const kind = name === "turretSlotsLeft" ? "turret" : "launcher";
  const fitted = fitting.listFittedItems(ship.ownerID, ship.itemID);
  const oldBase = overrides.getAttributeOverrides(ship)[overrides.SHIP_RESOURCE_ATTRIBUTES[name]] ??
    fitting.getShipBaseAttributeValue(ship.typeID, name) ?? 0;
  const total = fitting.getShipHardpointCounts(ship.typeID, fitted, ship.itemID)[kind] + value - oldBase;
  if (total > 8) return "The hardpoint base plus subsystem modifiers must remain between 0 and 8.";
  return total < fitting.getFittedEffectSlotsUsed(fitted, `${kind}Fitted`)
    ? "Unfit weapons before reducing hardpoints below their slot usage." : null;
}

module.exports = { handleDogmaCommand };
