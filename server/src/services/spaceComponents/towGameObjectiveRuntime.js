"use strict";

const { getTowGameObjectiveComponentAttributes } = require("../_shared/clientSpaceComponentRules");
const { resolveSessionCharacterID } = require("../_shared/sessionIdentity");
const { peekCharacterRecord } = require("../character/characterState");
const { findShipItemById, getItemMetadata } = require("../inventory/itemStore");
const { matchesTypeList } = require("../inventory/typeListAuthority");
const { getPersistedCaptureFaction } = require("../faction/facWarMgrService");
const sessionRegistry = require("../chat/sessionRegistry");
const { canEntitiesInteractLocally } = require("../../space/destiny/identity/interactionScope");
const { isEntityCloaked } = require("../../space/runtime/shipCloak");
const log = require("../../utils/logger");

// Only live references own relationships. Slims, copied entity fields and saved
// item spaceState never authorize a link or an encounter's capture factions.
const states = new WeakMap();
const projections = new WeakMap();
const CAPTURE_FACTIONS = new Set([500018, 500010, 500011]);
const fail = (errorMsg) => ({ success: false, errorMsg });
function state(scene) {
  if (!states.has(scene)) states.set(scene, { objectives: new Map(), links: new Map(), ships: new Set(), dirty: new Set() });
  return states.get(scene);
}
function currentScene(scene) {
  return Boolean(scene && require("../../space/runtime").scenes.get(scene.sceneKey) === scene);
}
function liveEntity(scene, entity) {
  return Boolean(entity && scene.getEntityByID(entity.itemID) === entity &&
    !entity.destroyed && Number(entity.conditionState?.damage || 0) < 1);
}
function validateObjectiveContext(entity, context) {
  const rules = getTowGameObjectiveComponentAttributes(entity?.typeID);
  if (!rules) return fail("TOW_GAME_OBJECTIVE_NOT_AUTHORED");
  if (!context || !Array.isArray(context.validFactions) || context.validFactions.length === 0 ||
    !context.validFactions.every((id) => Number.isSafeInteger(id) && CAPTURE_FACTIONS.has(id))) {
    return fail("TOW_GAME_OBJECTIVE_FACTION_CONTEXT_REQUIRED");
  }
  // No current owner validates goalposts or scoring. A guessed target is not
  // native encounter authority; the bounded relationship has a null goalpost.
  if (context.targetGoalpostID != null) return fail("TOW_GAME_OBJECTIVE_SCORING_UNAVAILABLE");
  return { success: true, data: { rules, validFactions: [...new Set(context.validFactions)].sort((a, b) => a - b) } };
}
function markShip(scene, ship) {
  const data = state(scene);
  if (Number(ship.categoryID) !== 6) return false;
  data.ships.add(ship);
  if (projections.has(ship)) return false;
  projections.set(ship, { component_towable_towingID: null });
  return true;
}
function registerSceneEntity(scene, entity, context, options = {}) {
  const data = state(scene);
  const rules = getTowGameObjectiveComponentAttributes(entity.typeID);
  if (rules) {
    const binding = { entity, rules, validFactions: context?.validFactions || [] };
    data.objectives.set(entity, binding);
    projections.set(entity, { component_towable_towedState: null,
      component_towable_validFactions: [...binding.validFactions] });
    const seededShips = [...scene.dynamicEntities.values()].filter((ship) => markShip(scene, ship));
    // The native menu reads the ship's nullable towing ID before start RPC.
    // Existing ships need that field when an objective first arrives.
    if (options.broadcast !== false && seededShips.length) publish(scene, seededShips);
  } else if (data.objectives.size) markShip(scene, entity);
}
function getPresentation(entity) {
  const value = projections.get(entity);
  return value ? structuredClone(value) : null;
}
function publish(scene, entities) {
  const data = state(scene);
  for (const entity of entities) if (scene.getEntityByID(entity.itemID) === entity) data.dirty.add(entity);
  if (!data.dirty.size) return;
  const changes = [...data.dirty].filter((entity) => scene.getEntityByID(entity.itemID) === entity);
  try { if (changes.length) scene.broadcastSlimItemChanges(changes); data.dirty.clear(); }
  catch (error) { log.warn(`[Tow] Committed relationship presentation pending: ${error.message}`); }
}
function resolveActor(scene, session) {
  const characterID = resolveSessionCharacterID(session);
  const character = peekCharacterRecord(characterID);
  const ship = scene?.getShipEntityForSession(session);
  const item = ship && findShipItemById(ship.itemID);
  if (!currentScene(scene) || !character || character.deletedAt || character.isDeleted ||
    !sessionRegistry.isRegisteredSession(session) || session.socket?.destroyed ||
    Number(session.userid) !== Number(character.accountId) || scene.sessions.get(session.clientID) !== session ||
    !liveEntity(scene, ship) || ship.session !== session || Number(ship.ownerID) !== characterID ||
    Number(session._space?.shipID) !== ship.itemID || !item || Number(item.ownerID) !== characterID ||
    Number(item.locationID) !== Number(scene.systemID) || Number(item.typeID) !== Number(ship.typeID) ||
    Number(character.shipID) !== ship.itemID) return null;
  return { characterID, ship, session, item };
}
function movementInvalid(ship) {
  return Boolean(/WARP/i.test(String(ship.mode || "")) ||
    isEntityCloaked(ship) || ship.structureTether?.active);
}
function validateBinding(scene, binding) {
  return Boolean(binding && liveEntity(scene, binding.entity) && binding.entity.typeID === binding.rules.typeID &&
    getTowGameObjectiveComponentAttributes(binding.entity.typeID) && binding.validFactions.length);
}
function clearLink(scene, link, broadcast = true) {
  const data = state(scene);
  if (data.links.get(link.objective) !== link) return false;
  data.links.delete(link.objective);
  projections.set(link.objective, { component_towable_towedState: null,
    component_towable_validFactions: [...link.binding.validFactions] });
  projections.set(link.ship, { component_towable_towingID: null });
  if (broadcast) publish(scene, [link.objective, link.ship]);
  return true;
}
function linkIsValid(scene, link) {
  const actor = resolveActor(scene, link.session);
  if (!actor || !liveEntity(scene, link.objective)) return false;
  const distance = scene.getEntitySurfaceDistance(link.ship, link.objective);
  return Boolean(actor?.ship === link.ship && actor.characterID === link.characterID &&
    validateBinding(scene, link.binding) && canEntitiesInteractLocally(link.ship, link.objective) &&
    !movementInvalid(link.ship) && link.binding.validFactions.includes(getPersistedCaptureFaction(link.characterID)) &&
    matchesTypeList(getItemMetadata(actor.item.typeID), link.binding.rules.towingShipTypeListID) &&
    Number.isFinite(distance) && distance <= link.binding.rules.breakTowAboveRange);
}
function tickScene(scene) {
  const data = states.get(scene);
  if (!data) return;
  for (const link of [...data.links.values()]) if (!currentScene(scene) || !linkIsValid(scene, link)) clearLink(scene, link);
  if (data.dirty.size) publish(scene, []);
}
function startTowing(scene, session, itemID) {
  const actor = resolveActor(scene, session);
  if (!actor) return fail("TOW_GAME_OBJECTIVE_ACTING_PILOT_REQUIRED");
  tickScene(scene);
  const objective = scene.getEntityByID(itemID);
  const binding = state(scene).objectives.get(objective);
  if (!binding || !getTowGameObjectiveComponentAttributes(objective?.typeID)) return fail("TOW_GAME_OBJECTIVE_NOT_AUTHORED");
  if (!validateBinding(scene, binding)) return fail("TOW_GAME_OBJECTIVE_FACTION_CONTEXT_REQUIRED");
  if (!canEntitiesInteractLocally(actor.ship, objective)) return fail("TOW_GAME_OBJECTIVE_SCENE_CHANGED");
  if (!binding.validFactions.includes(getPersistedCaptureFaction(actor.characterID))) return fail("TOW_GAME_OBJECTIVE_WRONG_FACTION");
  if (movementInvalid(actor.ship)) return fail("TOW_GAME_OBJECTIVE_MOVEMENT_CHANGED");
  const existing = state(scene).links.get(objective);
  if (existing) return existing.ship === actor.ship && existing.session === session
    ? { success: true, duplicate: true } : fail("TOW_GAME_OBJECTIVE_ALREADY_TOWED");
  if ([...state(scene).links.values()].some((link) => link.ship === actor.ship)) return fail("TOW_GAME_OBJECTIVE_LINKED_TO_DIFFERENT_ITEM");
  if (!matchesTypeList(getItemMetadata(actor.item.typeID), binding.rules.towingShipTypeListID)) return fail("TOW_GAME_OBJECTIVE_WRONG_SHIP");
  const distance = scene.getEntitySurfaceDistance(actor.ship, objective);
  if (!Number.isFinite(distance) || distance > binding.rules.startTowingMaxRange) return fail("TOW_GAME_OBJECTIVE_TOO_FAR_AWAY");
  const link = { binding, objective, ship: actor.ship, session, characterID: actor.characterID };
  state(scene).links.set(objective, link);
  markShip(scene, actor.ship);
  projections.set(objective, { component_towable_towedState: [actor.ship.itemID, null],
    component_towable_validFactions: [...binding.validFactions] });
  projections.set(actor.ship, { component_towable_towingID: objective.itemID });
  publish(scene, [objective, actor.ship]);
  return { success: true };
}
function stopTowing(scene, session, itemID) {
  const actor = resolveActor(scene, session);
  if (!actor) return fail("TOW_GAME_OBJECTIVE_ACTING_PILOT_REQUIRED");
  const objective = scene.getEntityByID(itemID);
  const binding = state(scene).objectives.get(objective);
  if (!binding || !validateBinding(scene, binding) || !canEntitiesInteractLocally(actor.ship, objective)) return fail("TOW_GAME_OBJECTIVE_NOT_AUTHORED");
  const link = state(scene).links.get(objective);
  if (!link) return { success: true, duplicate: true };
  if (link.ship !== actor.ship || link.session !== session) return fail("TOW_GAME_OBJECTIVE_TOWED_BY_OTHER_SHIP");
  clearLink(scene, link);
  return { success: true };
}
function handleEntityRemoved(scene, entity) {
  const data = states.get(scene);
  if (!data) return;
  for (const link of [...data.links.values()]) if (link.ship === entity || link.objective === entity) clearLink(scene, link);
  data.objectives.delete(entity); data.ships.delete(entity); data.dirty.delete(entity); projections.delete(entity);
}
function handleSessionDisconnected(session) {
  const scene = require("../../space/runtime").getSceneForSession(session);
  if (scene) {
    const data = states.get(scene);
    for (const link of [...(data?.links.values() || [])]) if (link.session === session) clearLink(scene, link);
  }
}
function disposeScene(scene) {
  const data = states.get(scene);
  if (!data) return;
  for (const link of [...data.links.values()]) clearLink(scene, link, false);
  for (const entity of [...data.objectives.keys(), ...data.ships]) projections.delete(entity);
  states.delete(scene);
}
module.exports = { validateObjectiveContext, registerSceneEntity, getPresentation, startTowing, stopTowing,
  tickScene, handleEntityRemoved, handleSessionDisconnected, disposeScene };
