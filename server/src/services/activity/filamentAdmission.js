"use strict";

const { resolveSessionCharacterID } = require("../_shared/sessionIdentity");
const { peekCharacterRecord } = require("../character/characterState");
const { findItemById, findShipItemById, getItemMetadata, ITEM_FLAGS } = require("../inventory/itemStore");
const registry = require("../chat/sessionRegistry");
const { isEntityCloaked } = require("../../space/runtime/shipCloak");
const { isEntityStructureTethered } = require("../../space/structureTethering");
const { isEntityWarpScrambled } = require("../../space/modules/hostileModuleRuntime");
const { isAbyssalHostLocationID } = require("../../abyssal").engineSupport.hostLocation;
const { getWallclockNowMs } = require("../../space/runtime/runtimeClock");

const positiveID = (id) => Number.isSafeInteger(id) && id > 0;
function getKey(itemID) {
  return positiveID(itemID) ? findItemById(itemID) : null;
}
function collectActorContext(session, nowMs = getWallclockNowMs()) {
  const characterID = resolveSessionCharacterID(session);
  const character = peekCharacterRecord(characterID);
  const identityValid = Boolean(character && !character.deletedAt && !character.isDeleted &&
    registry.isRegisteredSession(session) && !session.socket?.destroyed &&
    Number(session.userid) === Number(character.accountId));
  const shipID = Number(session?._space?.shipID || session?.shipID || session?.shipid);
  const shipItem = positiveID(shipID) ? findShipItemById(shipID) : null;
  const runtime = require("../../space/runtime");
  const scene = runtime.getSceneForSession(session);
  const ship = scene?.getShipEntityForSession(session) || null;
  const docked = Boolean(session?.stationid || session?.stationID || session?.structureid || session?.structureID);
  const custodyValid = Boolean(identityValid && shipItem && Number(shipItem.ownerID) === characterID &&
    Number(character.shipID) === shipID && Number(session.shipID || session.shipid) === shipID);
  const terminal = positiveID(shipID) && require("../ship/breacherPodDeathRuntime").isShipDeathPending(shipID);
  const liveShipValid = Boolean(custodyValid && !terminal && scene && runtime.scenes.get(scene.sceneKey) === scene &&
    scene.sessions.get(session.clientID) === session && scene.getEntityByID(shipID) === ship &&
    ship?.session === session && !ship.destroyed && Number(ship.categoryID) === 6 &&
    Number(ship.ownerID) === characterID && Number(ship.typeID) === Number(shipItem.typeID) &&
    Number(shipItem.locationID) === Number(scene.systemID) && Number(ship.conditionState?.damage || 0) < 1);
  const context = { session, characterID, character, identityValid, shipID, shipItem, ship, scene,
    docked, custodyValid, liveShipValid, terminal, nowMs };
  if (!identityValid) return context;
  context.sessionChanging = Boolean(session._transitionState ||
    Math.max(Number(session.nextSessionChangeMs) || 0, Number(session.nextSessionChange) || 0) > nowMs);
  context.selfDestructing = positiveID(shipID) && require("../ship/selfDestructRuntime").isShipSelfDestructing(shipID);
  context.cloaked = isEntityCloaked(ship);
  context.tethered = isEntityStructureTethered(ship);
  context.warping = Boolean(ship && (/WARP/i.test(String(ship.mode))));
  context.scrambled = Boolean(ship && isEntityWarpScrambled(ship));
  context.invulnerable = Boolean(ship && (runtime.isEntityUndockInvulnerable(ship, nowMs) ||
    ship.invulnerable === true || ship.isInvulnerable === true || Number(ship.invulnerableUntilMs) > nowMs ||
    Number(ship.tacticalReclonerInvulnerableUntilMs) > nowMs));
  context.inAbyssal = Boolean(scene?.sceneKind === "abyssal" || isAbyssalHostLocationID(scene?.systemID || shipItem?.locationID));
  const crimewatch = require("../security/crimewatchState").getCharacterCrimewatchState(characterID, nowMs);
  context.pvpTimerActive = Number(crimewatch?.pvpTimerExpiresAtMs) > nowMs;
  return context;
}

// Policy accepts an authoritative context and the native PvP error enum.
// PvP uses different trailing codes from the PvE Abyssal enum.
function keyErrors(context, item, requestedTypeID, groupID, errors) {
  const result = [], add = (code, args = []) => result.push([code, args]);
  if (!item) { add(errors.KEY_NOT_FOUND); return result; }
  const metadata = getItemMetadata(item.typeID);
  if (!positiveID(requestedTypeID) || Number(item.typeID) !== requestedTypeID || metadata?.groupID !== groupID) {
    add(errors.INVALID_KEY_TYPE, [context.characterID]);
  }
  if (!context.identityValid || Number(item.ownerID) !== context.characterID) add(errors.INVALID_OWNER, [context.characterID]);
  const quantity = Number(item.singleton) === 1 ? 1 : Number(item.stacksize ?? item.quantity);
  if (!Number.isSafeInteger(quantity) || quantity < 1) add(errors.INVALID_KEY_AMOUNT);
  if (!context.custodyValid || Number(item.locationID) !== context.shipID || Number(item.flagID) !== ITEM_FLAGS.CARGO_HOLD) {
    add(errors.ITEM_NOT_REACHABLE, [Number(item.typeID)]);
  }
  return result;
}
function actorErrors(context, errors) {
  const result = [], add = (code, args = []) => result.push([code, args]);
  if (!context.identityValid) { add(errors.SHIP_NOT_FOUND); return result; }
  if (!context.custodyValid || context.terminal || (!context.docked && !context.liveShipValid)) add(errors.SHIP_NOT_FOUND);
  if (context.docked) add(errors.SHIP_IS_DOCKED, [context.characterID]);
  if (context.cloaked) add(errors.SHIP_IS_CLOAKED, [context.characterID]);
  if (context.invulnerable) add(errors.SHIP_IS_INVULNERABLE, [context.characterID]);
  if (context.selfDestructing) add(errors.SHIP_IS_SELF_DESTRUCTING, [context.characterID]);
  if (context.tethered) add(errors.SHIP_IS_TETHERED, [context.characterID]);
  if (context.warping) add(errors.SHIP_IN_WARP, [context.characterID]);
  if (context.scrambled) add(errors.SHIP_IS_WARP_SCRAMBLED, [context.characterID]);
  if (context.inAbyssal) add(errors.IN_ABYSS_SYSTEM, [context.characterID]);
  if (context.sessionChanging) add(errors.SESSION_CHANGE_IN_PROGRESS, [context.characterID]);
  if (context.pvpTimerActive) add(errors.PVP_TIMER_ACTIVE, [context.characterID]);
  return result;
}
module.exports = { positiveID, getKey, collectActorContext, keyErrors, actorErrors };
