"use strict";

const { randomUUID } = require("node:crypto");
const { TABLE, readStaticRows } = require("../services/_shared/referenceData");
const { resolveItemByTypeID } = require("../services/inventory/itemTypeRegistry");
const { resolveSolarSystemByName } = require("../services/chat/solarSystemRegistry");
const { hasStaffDebugRole } = require("../services/chat/commands/commandAccess");
const sessions = require("../services/chat/sessionRegistry");
const world = require("./worldData");
const native = require("./npc/nativeNpcStore");
const { buildStaticStargateEntity, buildDunRotationFromDirection } = require("./runtime/staticSceneEntity");
const { buildChildEntityScopeMetadata, canEntitiesInteractLocally } = require("./destiny/identity/interactionScope");
const { decorateEntitySceneOwnership } = require("./runtime/sceneIdentity");
const { cloneVector, normalizeVector, buildPerpendicular, addVectors, scaleVector,
  subtractVectors } = require("../common/vector");

const LIMITS = Object.freeze({ maxGates: 64, lifetimeMs: 1200000 });
const space = () => require("./runtime");
const normalize = (text) => String(text || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const failure = (message) => ({ success: false, message });

function gateTypes() {
  const samples = new Set(readStaticRows(TABLE.STARGATES).map((row) => row.typeID));
  return readStaticRows(TABLE.STARGATE_TYPES).filter((row) => {
    const type = resolveItemByTypeID(row.typeID);
    // These are unpublished environment assets, validated by installed native
    // world samples rather than purchasable inventory publication flags.
    return samples.has(row.typeID) && row.groupID === 10 && row.categoryID === 2 &&
      row.graphicID > 0 && type?.graphicID === row.graphicID && type.radius > 0;
  }).map((row) => {
    const aliases = new Set([normalize(row.typeName)]);
    if (/^stargate\s*\(/i.test(row.typeName)) {
      aliases.add(normalize(row.typeName.match(/\(([^)]+)\)/)?.[1]));
    }
    return { ...row, aliases: [...aliases].filter(Boolean) };
  }).sort((left, right) => left.typeName.localeCompare(right.typeName));
}

function resolveType(query, types = gateTypes()) {
  const normalized = normalize(query);
  const exact = types.filter((row) => String(row.typeID) === String(query).trim() || row.aliases.includes(normalized));
  const matches = exact.length ? exact : types.filter((row) => normalized && row.aliases.some((alias) => alias.includes(normalized)));
  return matches.length === 1 ? { success: true, type: matches[0] }
    : failure(`${matches.length ? "Ambiguous" : "Unknown"} gate type: ${query}.` +
      (matches.length ? ` Suggestions: ${matches.slice(0, 8).map((row) => row.typeName).join(", ")}.` : ""));
}

function parseRequest(command, text) {
  const value = String(text || "").trim();
  if (value === "stop") return { success: true, stop: true };
  if (value.length > 200) return failure("Gate arguments are too long.");
  const types = gateTypes();
  if (!types.length) return failure("Installed gate model/radius authority is unavailable.");
  if (command === "gateshowcase") {
    const destination = resolveSolarSystemByName(value || "Polaris");
    return destination.success ? { success: true, types, destination: destination.match }
      : failure(`Unknown or ambiguous destination: ${value}. ${destination.suggestions.join(", ")}`);
  }
  const words = value.split(/\s+/).filter(Boolean);
  const matches = [];
  const errors = [];
  for (let split = 1; split < words.length; split++) {
    const type = resolveType(words.slice(0, split).join(" "), types);
    const destination = resolveSolarSystemByName(words.slice(split).join(" "));
    if (type.success && destination.success) matches.push({ success: true, types: [type.type], destination: destination.match });
    else if (destination.success) errors.push(type.message);
  }
  if (matches.length === 1) return matches[0];
  return failure(errors[0] || "Usage: /gate <type> <destination solar system>. Unknown or ambiguous arguments.");
}

function sceneContext(session) {
  const scene = session?._space && space().getSceneForSession(session);
  const ship = scene?.getShipEntityForSession(session);
  if (!sessions.isRegisteredSession(session) || !ship || ship.session !== session ||
      scene.sceneKey !== `solar-system:${scene.systemID}` || ship.mode === "WARP" ||
      !canEntitiesInteractLocally(ship, ship)) return null;
  return { scene, ship };
}

function cancelPending(controller, predicate = () => true) {
  for (const [session, pending] of controller.pending) {
    if (!predicate(pending)) continue;
    controller.pending.delete(session);
    pending.cancel();
  }
}

function removeGate(scene, route) {
  if (scene.getEntityByID(route.entity.itemID) === route.entity) {
    scene.removeStaticEntity(route.entity.itemID, { broadcast: true });
  }
}

function clearScene(scene) {
  const controller = scene?.transientGateController;
  if (!controller) return;
  scene.transientGateController = null;
  cancelPending(controller);
  for (const route of controller.routes.values()) removeGate(scene, route);
  controller.routes.clear();
}

function handleCommand(session, command, text) {
  if (!session?.characterID || !hasStaffDebugRole(session)) return failure("Transient gates require a selected staff/admin character.");
  const context = sceneContext(session);
  if (!context) return failure("You must be in your exact public space scene to create transient gates.");
  const { scene, ship } = context;
  const existing = scene.transientGateController;
  if (existing && (existing.session !== session || existing.characterID !== session.characterID)) return failure("Another pilot owns this scene's transient gates.");
  const request = parseRequest(command, text);
  if (!request.success) return request;
  if (request.stop) { clearScene(scene); return { success: true, message: "Transient gates stopped." }; }
  if (request.destination.solarSystemID === scene.systemID) return failure("A transient gate must lead to another solar system.");
  const spawn = require("./transitions").buildSolarSystemSpawnState(request.destination.solarSystemID);
  if (!spawn || !spawn.anchorID) return failure("Destination spawn authority is unavailable.");
  const currentRoutes = existing ? [...existing.routes.values()] : [];
  const matchesRequest = (route, type) => route.destination.solarSystemID === request.destination.solarSystemID &&
    route.entity.typeID === type.typeID && scene.getEntityByID(route.entity.itemID) === route.entity;
  const duplicate = command === "gate"
    ? currentRoutes.some((route) => matchesRequest(route, request.types[0]))
    : existing?.mode === command && currentRoutes.length === request.types.length &&
      request.types.every((type) => currentRoutes.some((route) => matchesRequest(route, type)));
  if (duplicate) return { success: true, message: "Those transient gates are already present." };
  const retained = command === "gate" && existing ? existing.routes.size : 0;
  if (retained + request.types.length > LIMITS.maxGates) return failure("Transient gate limit reached; stop or replace the showcase first.");
  const controller = command === "gate" && existing ? existing : { id: randomUUID(),
    session, characterID: session.characterID, owner: ship, mode: command, expiresAtMs: scene.getCurrentSimTimeMs() + LIMITS.lifetimeMs,
    routes: new Map(), pending: new Map() };
  const staged = [];
  const forward = normalizeVector(ship.direction, { x: 1, y: 0, z: 0 });
  const right = buildPerpendicular(forward);
  // Radius-aware spacing preserves separate visible models for all 29 types.
  const spacing = Math.max(...request.types.map((type) => resolveItemByTypeID(type.typeID).radius * 2)) + 10000;
  try {
    for (let index = 0; index < request.types.length; index++) {
      const allocated = native.allocateEntityID({ transient: true });
      if (!allocated.success || !Number.isSafeInteger(allocated.data) || scene.getEntityByID(allocated.data) ||
          world.getStargateByID(allocated.data)) throw new Error("Transient gate identity collision.");
      const type = request.types[index];
      const column = index % 6, row = Math.floor(index / 6);
      const position = addVectors(ship.position, addVectors(scaleVector(forward,
        command === "gate" ? 60000 : 90000 + row * spacing), scaleVector(right,
        command === "gate" ? 0 : (column - 2.5) * spacing)));
      const entity = buildStaticStargateEntity({ ...type, itemID: allocated.data,
        itemName: `${type.typeName} to ${request.destination.solarSystemName}`, solarSystemID: scene.systemID,
        destinationID: spawn.anchorID, destinationSolarSystemID: request.destination.solarSystemID,
        position, dunRotation: buildDunRotationFromDirection(subtractVectors(ship.position, position)) });
      Object.assign(entity, buildChildEntityScopeMetadata(ship), { transient: true, solarSystemID: scene.systemID,
        transientGateGeneration: controller.id, direction: normalizeVector(subtractVectors(ship.position, position)),
        mode: "STOP", targetPoint: cloneVector(position) });
      const route = { entity, destination: request.destination, spawn,
        destinationGate: spawn.anchorType === "stargate" ? world.getStargateByID(spawn.anchorID) : null };
      entity.systemID = scene.systemID;
      decorateEntitySceneOwnership(entity, scene.sceneDescriptor);
      if (!scene.addStaticEntity(entity)) throw new Error("STATIC_GATE_SPAWN_FAILED");
      staged.push(route);
    }
  } catch (error) {
    for (const route of staged) removeGate(scene, route);
    return failure(`Transient gate spawn failed: ${error.message} Temporary gates removed; existing gates retained.`);
  }
  if (controller !== existing) clearScene(scene);
  for (const route of staged) controller.routes.set(route.entity.itemID, route);
  scene.transientGateController = controller;
  // Initial acquisition uses the normal visibility/presentation owner.
  scene.broadcastAddBalls(staged.map((route) => route.entity), null, { freshAcquire: true });
  return { success: true, message: `Spawned ${staged.length} transient gate(s) to ${request.destination.solarSystemName}.` };
}

function resolveRoute(session, gateID) {
  const scene = space().getSceneForSession(session);
  const controller = scene?.transientGateController;
  const route = controller?.routes.get(gateID);
  return route && scene.getEntityByID(gateID) === route.entity ? { ...route, scene, controller } : null;
}

function scheduleJump(route, pending) {
  if (route.scene.transientGateController !== route.controller || route.controller.pending.has(pending.session)) return false;
  route.controller.pending.set(pending.session, { ...pending, route });
  return true;
}

function tickScene(scene) {
  const controller = scene.transientGateController;
  if (!controller) return;
  if (!sessions.isRegisteredSession(controller.session) || !hasStaffDebugRole(controller.session) ||
      controller.session.characterID !== controller.characterID ||
      space().getSceneForSession(controller.session) !== scene ||
      scene.getShipEntityForSession(controller.session) !== controller.owner ||
      controller.owner.session !== controller.session || scene.getCurrentSimTimeMs() >= controller.expiresAtMs) {
    clearScene(scene); return;
  }
  for (const [id, route] of controller.routes) {
    if (scene.getEntityByID(id) !== route.entity) {
      controller.routes.delete(id);
      cancelPending(controller, (pending) => pending.route.entity === route.entity);
    }
  }
  for (const [session, pending] of controller.pending) {
    if (!sessions.isRegisteredSession(session) || session.socket?.destroyed ||
        space().getSceneForSession(session) !== scene || session._space !== pending.spaceGeneration ||
        session._transitionState !== pending.transition || session.characterID !== pending.characterID ||
        scene.getShipEntityForSession(session) !== pending.ship || pending.ship.session !== session ||
        scene.getEntityByID(pending.route.entity.itemID) !== pending.route.entity ||
        !canEntitiesInteractLocally(pending.ship, pending.route.entity)) {
      controller.pending.delete(session); pending.cancel(); continue;
    }
    if (scene.getCurrentSessionSimTimeMs(session) < pending.deadlineSimTimeMs) continue;
    // Remove before transfer: detach may clear the creator's gate generation.
    controller.pending.delete(session);
    try {
      const result = pending.complete();
      if (!result?.success) {
        pending.cancel();
        require("../utils/logger").warn(`[TransientGates] Handoff failed: ${result?.errorMsg}`);
      }
    } catch (error) {
      pending.cancel();
      require("../utils/logger").warn(`[TransientGates] Handoff failed: ${error.message}`);
    }
  }
}

function handleSessionDisconnected(session, scene = space().getSceneForSession(session)) {
  const controller = scene?.transientGateController;
  if (!controller) return;
  if (controller.session === session) clearScene(scene);
  else cancelPending(controller, (pending) => pending.session === session);
}

function handleEntityRemoved(scene, entity) {
  const controller = scene.transientGateController;
  if (!controller) return;
  if (controller.owner === entity) { clearScene(scene); return; }
  const route = controller.routes.get(entity.itemID);
  if (route?.entity === entity) controller.routes.delete(entity.itemID);
  cancelPending(controller, (pending) => pending.ship === entity || pending.route.entity === entity);
}

function prepareShipDestruction(session) {
  const scene = space().getSceneForSession(session);
  const ship = scene?.getShipEntityForSession(session);
  // Release only this owner's ephemeral gate lock before the destruction
  // owner starts its native eject/capsule transition.
  if (ship?.session === session) handleEntityRemoved(scene, ship);
}

module.exports = { LIMITS, gateTypes, resolveType, parseRequest, handleCommand, resolveRoute,
  scheduleJump, tickScene, clearScene, handleSessionDisconnected, handleEntityRemoved, prepareShipDestruction };
