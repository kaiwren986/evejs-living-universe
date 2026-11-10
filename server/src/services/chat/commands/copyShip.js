"use strict";

const { getActiveShipRecord } = require("../../character/characterState");
const { cloneDockedShipForCharacter } = require("../../inventory/itemStore");
const { getDockedLocationID, isDockedSession } = require("../../structure/structureLocation");
const { hasStaffDebugRole } = require("./commandAccess");
const { handledResult } = require("./commandReplies");
const { syncInventoryChangesToSession } = require("./commandInventorySync");
const log = require("../../../utils/logger");

function handleCopyShipCommand(session, argumentText, chatHub, options) {
  const reply = (message) => handledResult(chatHub, session, options, message);
  if (!hasStaffDebugRole(session)) return reply("/copyship requires a staff/admin role.");
  // svc_copycat2.DoClonePerfect sends this exact form while docked. Other
  // copy flags and remote ship targets have no verified client contract.
  const match = /^(\d+)\s+1$/.exec(String(argumentText || "").trim());
  if (!match || !Number.isSafeInteger(Number(match[1]))) {
    return reply("Usage: /copyship <activeShipID> 1");
  }
  const characterID = Number(session && session.characterID) || 0;
  const shipID = Number(match[1]);
  const ship = characterID > 0 && getActiveShipRecord(characterID);
  if (!isDockedSession(session) || !ship || Number(ship.itemID) !== shipID) {
    return reply("Dock in your own active ship before using /copyship.");
  }
  const result = cloneDockedShipForCharacter(characterID, shipID, getDockedLocationID(session));
  if (!result.success) return reply(`Ship copy refused: ${result.errorMsg}.`);
  log.info(`[GM copyship] character=${characterID} source=${shipID} copy=${result.data.ship.itemID} items=${result.data.changes.length}`);
  syncInventoryChangesToSession(session, result.data.changes);
  return reply(`Copied ${ship.itemName} (${shipID}) to ship ${result.data.ship.itemID} in your hangar, including its contents.`);
}

module.exports = { handleCopyShipCommand };
