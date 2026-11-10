"use strict";

const { getActiveShipRecord } = require("../../character/characterState");
const { findShipItemById, listContainerItems } = require("../../inventory/itemStore");
const { isFittedModuleItem } = require("../../fitting/liveFittingState");
const { hasStaffDebugRole } = require("./commandAccess");
const { handledResult } = require("./commandReplies");

function handleGetShipSetupCommand(session, argumentText, chatHub, options) {
  const reply = (message) => handledResult(chatHub, session, options, message);
  if (!hasStaffDebugRole(session)) return reply("/getshipsetup requires a staff/admin role.");
  const target = String(argumentText || "").trim();
  const active = target.toLowerCase() === "me" && getActiveShipRecord(session && session.characterID);
  const shipID = active ? Number(active.itemID) : /^\d+$/.test(target) ? Number(target) : 0;
  const ship = Number.isSafeInteger(shipID) && shipID > 0 ? findShipItemById(shipID) : null;
  if (!ship) return reply("Usage: /getshipsetup <shipID|me> (ship must exist)");
  const byFlag = new Map(listContainerItems(null, shipID).filter(isFittedModuleItem)
    .map((item) => [Number(item.flagID), Number(item.typeID)]));
  const subsystemFlags = [...byFlag.keys()].filter((flag) => flag >= 125 && flag < 133)
    .sort((left, right) => left - right);
  // dna.py advances subsystem flags from 125, but only accepts hole markers
  // 0..3. Marker 4 is parsed as a type ID; dropping it shifts later subsystems
  // into the wrong flags. Refuse that unrepresentable setup explicitly.
  if (subsystemFlags.some((flag, index) => flag !== 125 + index)) {
    return reply("Cannot export this setup: legacy client DNA cannot represent empty subsystem slots before a fitted subsystem.");
  }
  // devtools/dna.py consumes legacy DNA:<hull>:<module> fragments. A rack
  // number 0..3 represents a hole before its last module; charges are not fittings.
  const fragments = ["DNA", Number(ship.typeID)];
  [27, 19, 11, 92, 125].forEach((firstFlag, group) => {
    const flags = [...byFlag.keys()].filter((flag) => flag >= firstFlag && flag < firstFlag + 8);
    if (!flags.length) return;
    for (let flag = firstFlag; flag <= Math.max(...flags); flag++) {
      fragments.push(byFlag.get(flag) || group);
    }
  });
  const dna = fragments.join(":");
  return reply(dna);
}

module.exports = { handleGetShipSetupCommand };
