"use strict";

const { peekCharacterRecord } = require("../character/characterState");
const { resolveSessionCharacterID } = require("../_shared/sessionIdentity");
const { findItemById, getItemMetadata } = require("../inventory/itemStore");
const { matchesTypeList } = require("../inventory/typeListAuthority");
const { resolveOmegaLicenseState } = require("../newEdenStore/storeState");
const { canEntitiesInteractLocally } = require("../../space/destiny/identity/interactionScope");
const { isEntityCloaked } = require("../../space/runtime/shipCloak");
const { buildSolarSystemSceneKey } = require("../../space/runtime/sceneIdentity");
const { getLinkWithShipComponentAttributes } = require("../_shared/clientSpaceComponentRules");
const { normalizeLinkRules } = require("./shipLinkPolicy");
const log = require("../../utils/logger");

const linksByScene = new WeakMap();
const residualsByScene = new WeakMap();
const presentationsByScene = new WeakMap();
const componentsByScene = new WeakMap();
const IDLE = 1;
const RUNNING = 2;
const COMPLETED = 3;
const DISABLED = 4;
const COMPLETION_PRESENTATION_MS = 10000;
const fail = (errorMsg) => ({ success: false, errorMsg });
function links(scene) {
  if (!linksByScene.has(scene)) linksByScene.set(scene, new Map());
  return linksByScene.get(scene);
}
function simNow(scene) { return Number(scene.getCurrentSimTimeMs()); }
function tuple(scene, entry, state) {
  // The slim serializer converts epoch milliseconds to FILETIME once.
  return [entry.addedAtSimMs, state, entry.completeAtSimMs, entry.ship.itemID];
}
function broadcast(scene, component) { scene.broadcastSlimItemChanges([component]); }
function surfaceDistance(scene, ship, component) {
  return scene.getEntitySurfaceDistance(ship, component);
}

function validateLive(scene, entry) {
  const currentItem = findItemById(entry.ship.itemID);
  const character = peekCharacterRecord(entry.characterID);
  if (entry.session.socket?.destroyed === true ||
      scene.getEntityByID(entry.component.itemID) !== entry.component ||
      scene.getEntityByID(entry.ship.itemID) !== entry.ship ||
      entry.ship.session !== entry.session ||
      Number(entry.session._space && entry.session._space.shipID) !== entry.ship.itemID ||
      Number(entry.ship.ownerID) !== entry.characterID ||
      (entry.domain && entry.ship.linkWithShipRestriction?.linkID !== entry.domain.linkID) ||
      !currentItem || Number(currentItem.ownerID) !== entry.characterID ||
      Number(currentItem.locationID) !== Number(scene.systemID) ||
      !character || character.deletedAt || character.isDeleted ||
      Number(entry.session.userid) !== Number(character.accountId) ||
      entry.component.destroyed === true || Number(entry.component.conditionState?.damage || 0) >= 1 ||
      entry.ship.destroyed === true || Number(entry.ship.conditionState && entry.ship.conditionState.damage) >= 1) {
    return "LINK_WITH_SHIP_CONTEXT_CHANGED";
  }
  if (entry.rules.omegaOnly && !resolveOmegaLicenseState(character.accountId).hasLicense) return "LINK_WITH_SHIP_OMEGA_REQUIRED";
  if (!canEntitiesInteractLocally(entry.ship, entry.component)) return "LINK_WITH_SHIP_SCENE_CHANGED";
  if (/WARP/i.test(String(entry.ship.mode || "")) || entry.ship.structureTether?.active ||
      isEntityCloaked(entry.ship)) {
    return "LINK_WITH_SHIP_MOVEMENT_CHANGED";
  }
  const distance = surfaceDistance(scene, entry.ship, entry.component);
  if (!Number.isFinite(distance) || distance > entry.rules.maxLinkRange) return "LINK_WITH_SHIP_OUT_OF_RANGE";
  return null;
}

function prepareLink(scene, session, component, rules, options = {}) {
  if (options.quick === true) return fail("LINK_WITH_SHIP_QUICK_NOT_PERMITTED");
  if (!scene || !session || !component || !rules || component.typeID !== rules.typeID ||
      scene.sceneKind !== "solarSystem" || Number(scene.instanceID || 0) !== 0 ||
      scene.sceneKey !== buildSolarSystemSceneKey(scene.systemID) ||
      scene.getEntityByID(component.itemID) !== component) return fail("LINK_WITH_SHIP_COMPONENT_NOT_FOUND");
  // Attribute overrides belong to trusted domain adapters (e.g. a friendly
  // silo duration), never to the entity or the calling client's arguments.
  const authority = getLinkWithShipComponentAttributes(component.typeID);
  if (!authority) return fail("LINK_WITH_SHIP_COMPONENT_NOT_AUTHORED");
  const combined = { ...authority, ...rules };
  rules = normalizeLinkRules({ ...combined,
    dbuffPostLinkDuration: combined.residualDurationMs / 1000 });
  if (!rules) return fail("LINK_WITH_SHIP_INVALID_RULES");
  const durationMs = options.durationMs ?? rules.linkDurationMs;
  if (!Number.isFinite(durationMs) || durationMs <= 0 ||
      !Number.isSafeInteger(rules.linkableShipTypeListID) || rules.linkableShipTypeListID <= 0 ||
      !Number.isFinite(rules.maxLinkRange) || rules.maxLinkRange <= 0 ||
      !Number.isFinite(rules.residualDurationMs) || rules.residualDurationMs < 0) {
    return fail("LINK_WITH_SHIP_INVALID_RULES");
  }
  for (const cost of [rules.characterEnergyCost, rules.solarsystemInterferenceCost]) {
    if (cost != null && (!Number.isFinite(cost) || cost < 0)) return fail("LINK_WITH_SHIP_INVALID_RULES");
  }
  const characterID = resolveSessionCharacterID(session);
  const character = peekCharacterRecord(characterID);
  const ship = scene.getShipEntityForSession(session);
  const item = ship && findItemById(ship.itemID);
  if (!character || character.deletedAt || character.isDeleted || !ship || ship.session !== session ||
      !item || Number(item.ownerID) !== characterID ||
      Number(session.userid) !== Number(character.accountId) ||
      Number(item.locationID) !== Number(scene.systemID)) return fail("LINK_WITH_SHIP_ACTING_PILOT_REQUIRED");
  const active = [...links(scene).values()];
  if (links(scene).has(component.itemID) || active.some((entry) => entry.ship === ship) ||
      ship.linkWithShipRestriction ||
      ship.mobileAnalysisBeaconLinkedBeaconID && Number(ship.mobileAnalysisBeaconWarpDisabledUntilMs) > simNow(scene)) {
    return fail("LINK_WITH_SHIP_ALREADY_LINKED");
  }
  if (Number(item.categoryID) !== 6 || !matchesTypeList(getItemMetadata(item.typeID), rules.linkableShipTypeListID)) {
    return fail("LINK_WITH_SHIP_INVALID_SHIP");
  }
  if (rules.omegaOnly && !resolveOmegaLicenseState(character.accountId).hasLicense) return fail("LINK_WITH_SHIP_OMEGA_REQUIRED");
  if (Number(rules.characterEnergyCost) > 0 || Number(rules.solarsystemInterferenceCost) > 0) {
    return fail("LINK_WITH_SHIP_UNSUPPORTED_COST_AUTHORITY");
  }
  if (rules.unsupportedDbuffs?.length || rules.generateCynoInhibitor) return fail("LINK_WITH_SHIP_UNSUPPORTED_COMPONENT_POLICY");
  if ([COMPLETED, DISABLED].includes(component.component_linkWithShip?.[1])) return fail("LINK_WITH_SHIP_COMPONENT_BUSY");
  const startedAtSimMs = simNow(scene);
  if (!Number.isFinite(startedAtSimMs)) return fail("LINK_WITH_SHIP_INVALID_CLOCK");
  const entry = { scene, component, ship, session, characterID, rules,
    addedAtSimMs: component.component_linkWithShip?.[0] ?? startedAtSimMs,
    startedAtSimMs, completeAtSimMs: startedAtSimMs + durationMs };
  const error = validateLive(scene, entry);
  return error ? fail(error) : { success: true, data: entry };
}

function activateLink(entry, domain) {
  const scene = entry.scene;
  const error = validateLive(scene, entry);
  if (error) return fail(error);
  if (!domain || !domain.linkID || typeof domain.validate !== "function" ||
      typeof domain.onComplete !== "function" || typeof domain.onBreak !== "function") return fail("LINK_WITH_SHIP_DOMAIN_REQUIRED");
  if (links(scene).has(entry.component.itemID) ||
      [...links(scene).values()].some((current) => current.ship === entry.ship) ||
      entry.ship.linkWithShipRestriction) return fail("LINK_WITH_SHIP_ALREADY_LINKED");
  entry.domain = domain;
  entry.sourceKey = `ship-link:${domain.linkID}`;
  links(scene).set(entry.component.itemID, entry);
  entry.ship.linkWithShipRestriction = { ...entry.rules, linkID: domain.linkID,
    componentItemID: entry.component.itemID };
  const applied = scene.setContinuousDbuffSource(entry.ship, entry.sourceKey, entry.rules.dbuffs,
    { nowMs: simNow(scene), reason: "ship-link-start" });
  if (!applied.success) {
    links(scene).delete(entry.component.itemID);
    delete entry.ship.linkWithShipRestriction;
    scene.clearContinuousDbuffSource(entry.ship, entry.sourceKey, { nowMs: simNow(scene) });
    return fail("LINK_WITH_SHIP_DBUFF_AUTHORITY_UNAVAILABLE");
  }
  scene.refreshShipEntityDerivedState(entry.ship, { broadcast: true });
  entry.component.component_linkWithShip = tuple(scene, entry, RUNNING);
  broadcast(scene, entry.component);
  return { success: true, data: { linkID: domain.linkID } };
}

function clearEntry(scene, entry, state) {
  if (links(scene).get(entry.component.itemID) !== entry) return false;
  links(scene).delete(entry.component.itemID);
  const residualMs = state === COMPLETED || entry.rules.keepDbuffDurationOnLinkBreak
    ? entry.rules.residualDurationMs : 0;
  if (entry.ship.linkWithShipRestriction && entry.ship.linkWithShipRestriction.linkID === entry.domain.linkID) {
    if (residualMs > 0 && scene.getEntityByID(entry.ship.itemID) === entry.ship) {
      entry.ship.linkWithShipRestriction.activeLinkEnded = true;
      entry.residualUntilSimMs = simNow(scene) + residualMs;
      if (!residualsByScene.has(scene)) residualsByScene.set(scene, new Map());
      residualsByScene.get(scene).set(entry.ship, entry);
    } else {
      delete entry.ship.linkWithShipRestriction;
      removeDbuffs(scene, entry, "ship-link-end");
    }
    if (scene.getEntityByID(entry.ship.itemID) === entry.ship) {
      scene.refreshShipEntityDerivedState(entry.ship, { broadcast: true });
    }
  } else {
    removeDbuffs(scene, entry, "ship-link-replaced");
  }
  if (scene.getEntityByID(entry.component.itemID) === entry.component) {
    entry.component.component_linkWithShip = state === IDLE ? [entry.addedAtSimMs, IDLE, null, null] : tuple(scene, entry, state);
    broadcast(scene, entry.component);
    if (state === COMPLETED) {
      if (!presentationsByScene.has(scene)) presentationsByScene.set(scene, new Map());
      presentationsByScene.get(scene).set(entry.component, { entry,
        resetAtSimMs: simNow(scene) + COMPLETION_PRESENTATION_MS });
    }
  }
  return true;
}

function breakLink(scene, componentID, reason = "link-broken") {
  const entry = links(scene).get(Number(componentID));
  if (!entry) return { success: true, unchanged: true };
  if (entry.settling) return fail("LINK_WITH_SHIP_SETTLEMENT_RUNNING");
  // Persist the interruption before releasing its transient projection. An
  // owner write failure leaves the entry retryable and unable to settle theft.
  invokeCallback(entry, "onBreak", reason);
  clearEntry(scene, entry, IDLE);
  return { success: true, reason };
}

function reevaluateLink(scene, componentID) {
  const entry = links(scene).get(Number(componentID));
  if (!entry) return fail("LINK_WITH_SHIP_NOT_RUNNING");
  if (entry.settling) return fail("LINK_WITH_SHIP_SETTLEMENT_RUNNING");
  const error = validateLive(scene, entry) || entry.domain.validate();
  if (error) return breakLink(scene, componentID, error);
  if (simNow(scene) < entry.completeAtSimMs) return { success: true, running: true };
  invokeCallback(entry, "onComplete");
  clearEntry(scene, entry, COMPLETED);
  return { success: true, completed: true };
}

function getLink(scene, componentID) { return links(scene).get(Number(componentID)) || null; }
function tickScene(scene) {
  const failures = [];
  for (const entry of [...links(scene).values()]) {
    try { reevaluateLink(scene, entry.component.itemID); }
    catch (error) {
      failures.push({ componentID: entry.component.itemID, errorMsg: error.message });
      log.warn(`[ShipLink] ${scene.sceneKey} component=${entry.component.itemID} awaits owner retry: ${error.message}`);
    }
  }
  for (const entry of residualsByScene.get(scene)?.values() || []) {
    if (simNow(scene) >= entry.residualUntilSimMs || scene.getEntityByID(entry.ship.itemID) !== entry.ship) clearResidual(scene, entry);
  }
  for (const [component, presentation] of presentationsByScene.get(scene) || []) {
    if (simNow(scene) < presentation.resetAtSimMs && scene.getEntityByID(component.itemID) === component) continue;
    presentationsByScene.get(scene).delete(component);
    if (scene.getEntityByID(component.itemID) !== component || links(scene).has(component.itemID)) continue;
    component.component_linkWithShip = [presentation.entry.addedAtSimMs,
      presentation.entry.rules.canRelink === false ? DISABLED : IDLE, null, null];
    broadcast(scene, component);
  }
  for (const component of componentsByScene.get(scene)?.keys() || []) {
    if (scene.getEntityByID(component.itemID) !== component) componentsByScene.get(scene).delete(component);
  }
  return { success: failures.length === 0, failures };
}
function breakLinksForSession(scene, session, reason) {
  if (!scene) return;
  for (const entry of [...links(scene).values()]) if (entry.session === session) breakLink(scene, entry.component.itemID, reason);
  for (const entry of [...(residualsByScene.get(scene)?.values() || [])]) if (entry.session === session) clearResidual(scene, entry);
}
function disposeScene(scene) {
  if (!scene) return;
  for (const entry of [...links(scene).values()]) breakLink(scene, entry.component.itemID, "scene-disposed");
  for (const entry of [...(residualsByScene.get(scene)?.values() || [])]) clearResidual(scene, entry);
  linksByScene.delete(scene);
  residualsByScene.delete(scene);
  presentationsByScene.delete(scene);
  componentsByScene.delete(scene);
}

function invokeCallback(entry, name, reason) {
  entry.settling = true;
  try {
    const result = entry.domain[name](reason);
    if (result?.then || result?.success === false) throw new Error(result?.errorMsg || "LINK_WITH_SHIP_SYNCHRONOUS_OWNER_REQUIRED");
  } finally { entry.settling = false; }
}
function clearResidual(scene, entry) {
  residualsByScene.get(scene)?.delete(entry.ship);
  // The exact entity reference and source generation prevent reused item IDs
  // or a replacement link from losing its restriction to an old expiry.
  if (entry.ship.linkWithShipRestriction?.linkID === entry.domain.linkID) delete entry.ship.linkWithShipRestriction;
  removeDbuffs(scene, entry, "ship-link-residual-end");
  if (scene.getEntityByID(entry.ship.itemID) === entry.ship) scene.refreshShipEntityDerivedState(entry.ship, { broadcast: true });
}
function removeDbuffs(scene, entry, reason) {
  if (scene.getEntityByID(entry.ship.itemID) === entry.ship) {
    scene.clearContinuousDbuffSource(entry.ship, entry.sourceKey, { nowMs: simNow(scene), reason });
  } else {
    // Clear the retired projection without sending its HUD to a replacement
    // entity/session that happens to reuse the same numeric ID.
    require("../../space/modules/commandBurstRuntime").clearContinuousDbuffSource(entry.ship, entry.sourceKey, simNow(scene));
  }
}

// Authored domains bind a live entity and a start adapter in its exact owning
// scene. Persistent intent and recovery stay with that domain; only in-memory
// adapters hold callbacks. RPCs cannot install an adapter or define a type.
function bindComponent(scene, component, start) {
  if (!scene || scene.getEntityByID(component?.itemID) !== component ||
      !getLinkWithShipComponentAttributes(component.typeID) || typeof start !== "function") return fail("LINK_WITH_SHIP_COMPONENT_NOT_AUTHORED");
  if (!componentsByScene.has(scene)) componentsByScene.set(scene, new Map());
  componentsByScene.get(scene).set(component, start);
  return { success: true };
}
function initiateLink(scene, session, componentID, options = {}) {
  if (options.quick === true) return fail("LINK_WITH_SHIP_QUICK_NOT_PERMITTED");
  const component = scene?.getEntityByID(Number(componentID));
  const rules = component && getLinkWithShipComponentAttributes(component.typeID);
  if (!rules) return fail("LINK_WITH_SHIP_COMPONENT_NOT_AUTHORED");
  const start = componentsByScene.get(scene)?.get(component);
  if (!start) return fail("LINK_WITH_SHIP_DOMAIN_REQUIRED");
  return start(session, options);
}

module.exports = { prepareLink, activateLink, getLink, breakLink, reevaluateLink,
  tickScene, breakLinksForSession, disposeScene, bindComponent, initiateLink,
  IDLE, RUNNING, COMPLETED, DISABLED };
