"use strict";

const { getActiveShipRecord } = require("../../character/characterState");
const { listFittedItems, getTypeEffectRecords, isModuleOnline } = require("../../fitting/liveFittingState");
const { hasStaffDebugRole } = require("./commandAccess");
const { handledResult } = require("./commandReplies");
const { findItemById } = require("../../inventory/itemStore");
const { isDockedSession, getDockedLocationID } = require("../../structure/structureLocation");
const runtime = require("../../../space/runtime");
const { canEntitiesInteractLocally } = require("../../../space/destiny/identity/interactionScope");

function handleOnlineCommand(session, argumentText, chatHub, options) {
  const reply = (message) => handledResult(chatHub, session, options, message);
  if (!hasStaffDebugRole(session)) return reply("/online requires a staff/admin role.");
  const target = String(argumentText || "").trim().replace(/^(["'])(.*)\1$/, "$2");
  const ship = target.toLowerCase() === "me" ? getActiveShipRecord(session && session.characterID)
    : /^\d+$/.test(target) && Number.isSafeInteger(Number(target)) ? findItemById(Number(target)) : null;
  if (!ship || Number(ship.categoryID) !== 6) return reply("Usage: /online <me|shipID>");
  const ownerSession = Number(ship.ownerID) === Number(session.characterID) ? session
    : require("../sessionRegistry").findSessionByCharacterID(ship.ownerID);
  if (!ownerSession) return reply("The target ship's pilot must be connected.");
  if (isDockedSession(ownerSession)) {
    if (!isDockedSession(session) || Number(getDockedLocationID(session)) !== Number(getDockedLocationID(ownerSession)) ||
        Number(ship.locationID) !== Number(getDockedLocationID(ownerSession))) {
      return reply("The target ship must be in your docked location.");
    }
  } else {
    const scene = runtime.getSceneForSession(session), ownerScene = runtime.getSceneForSession(ownerSession);
    const ego = scene && scene.getShipEntityForSession(session), entity = ownerScene && ownerScene.getShipEntityForSession(ownerSession);
    if (!ego || !entity || scene !== ownerScene || Number(entity.itemID) !== Number(ship.itemID) ||
        !canEntitiesInteractLocally(ego, entity) || !scene.getVisibleEntitiesForSession(session).includes(entity)) {
      return reply("The target must be a locally visible active ship.");
    }
  }
  // Reuse dogma's skill, fitting-resource, capacitor and presentation authority.
  const DogmaService = require("../../dogma/dogmaService");
  const dogma = new DogmaService();
  let count = 0;
  const refused = [];
  for (const item of listFittedItems(ownerSession.characterID, ship.itemID)) {
    if (isModuleOnline(item) || !getTypeEffectRecords(item.typeID).some((effect) => effect.effectID === 16)) continue;
    const result = dogma._setModuleOnlineState(ship.itemID, item.itemID, true, ownerSession);
    if (result.success) count++;
    else refused.push(`${item.itemID}: ${result.errorMsg}`);
  }
  return reply(`Onlined ${count} modules.${refused.length ? ` Refused ${refused.length}: ${refused.join(", ")}.` : ""}`);
}

module.exports = { handleOnlineCommand };
