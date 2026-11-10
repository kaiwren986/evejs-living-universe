"use strict";

const { randomUUID } = require("node:crypto");
const native = require("../npc/nativeNpcStore");
const { resolveItemByTypeID } = require("../../services/inventory/itemTypeRegistry");
const { getTypeAttributeValue, getModuleChargeCapacity,
  isChargeCompatibleWithModule } = require("../../services/fitting/liveFittingState");
const { hasStaffDebugRole } = require("../../services/chat/commands/commandAccess");
const sessionRegistry = require("../../services/chat/sessionRegistry");
const { buildChildEntityScopeMetadata, canEntitiesInteractLocally } = require("../destiny/identity/interactionScope");
const { isFireShowShip } = require("./showIdentity");
const { cloneVector, normalizeVector, buildPerpendicular, crossProduct,
  addVectors, scaleVector, subtractVectors, magnitude } = require("../../common/vector");

const LIMITS = Object.freeze({ min: 6, max: 160, default: 36, lifetimeMs: 600000 });
const HULL_IDS = Object.freeze([17812, 17619, 17841, 17703]);
const CHARGE_IDS = Object.freeze([49991, 50138, 33572]);
const space = () => require("../runtime");
const failure = (message) => ({ success: false, message });

function allocate(allocator) {
  const result = allocator({ transient: true });
  if (!result?.success || !Number.isSafeInteger(result.data) || result.data <= 0) {
    throw new Error(result?.errorMsg || "NATIVE_SHOW_ID_ALLOCATION_FAILED");
  }
  return result.data;
}

function parseRequest(text) {
  const value = String(text || "").trim();
  if (value === "stop") return { success: true, stop: true };
  if (!value) return { success: true, count: LIMITS.default };
  if (!/^-?\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
    return failure("Usage: /fireshow [count|stop].");
  }
  return { success: true, count: Math.min(LIMITS.max, Math.max(LIMITS.min, Number(value))) };
}

function resolveResources() {
  const launcher = resolveItemByTypeID(19660);
  const hulls = HULL_IDS.map(resolveItemByTypeID);
  const charges = CHARGE_IDS.map(resolveItemByTypeID);
  if (!launcher || launcher.published !== true || launcher.groupID !== 501 ||
      hulls.some((hull) => !hull || hull.published !== true || hull.categoryID !== 6 ||
        getTypeAttributeValue(hull.typeID, "hiSlots") < 1) ||
      charges.some((charge) => !charge || charge.published !== true || charge.groupID !== 500 ||
        !isChargeCompatibleWithModule(launcher.typeID, charge.typeID) ||
        getModuleChargeCapacity(launcher.typeID, charge.typeID) < 1)) {
    return failure("Firework show assets are unavailable in installed static data.");
  }
  return { success: true, launcher, hulls, charges };
}

function formationPoint(owner, index, count) {
  const forward = normalizeVector(owner.direction, { x: 1, y: 0, z: 0 });
  const right = buildPerpendicular(forward);
  const up = normalizeVector(crossProduct(right, forward), { x: 0, y: 1, z: 0 });
  const ring = index % 3;
  const angle = index / count * Math.PI * 2 + ring * 0.72;
  const radius = [6000, 10000, 14000][ring];
  return addVectors(owner.position, addVectors(scaleVector(right, Math.cos(angle) * radius),
    addVectors(scaleVector(forward, Math.sin(angle) * radius), scaleVector(up, [-2500, 3500, 7000][ring]))));
}

function pseudoSession(scene, entity) {
  return { characterID: entity.itemID, corporationID: entity.corporationID,
    _space: { systemID: scene.systemID, shipID: entity.itemID, sceneKey: scene.sceneKey } };
}

function writeLoadout(controller, entry, resources, index) {
  const entity = entry.entity;
  const moduleID = allocate(native.allocateModuleID);
  const cargoID = allocate(native.allocateCargoID);
  const charge = resources.charges[index % resources.charges.length];
  const quantity = getModuleChargeCapacity(resources.launcher.typeID, charge.typeID);
  entry.moduleID = moduleID;
  entry.cargoID = cargoID;
  entry.chargeType = charge;
  entry.capacity = quantity;
  const state = { online: true, active: false, overloaded: false, damage: 0, incapacitated: false };
  const rows = [
    () => native.upsertNativeEntity({ entityID: entity.itemID, systemID: entity.systemID,
      typeID: entity.typeID, nativeNpc: true, transient: true, npcEntityType: "fireShow",
      fireShowID: controller.id, ...native.buildStoredEntityScopeMetadata(entity) }, { transient: true }),
    () => native.upsertNativeModule({ entityID: entity.itemID, moduleID,
      typeID: resources.launcher.typeID, groupID: 501, categoryID: 7,
      ownerID: entity.itemID, flagID: 27, itemName: resources.launcher.name,
      singleton: true, moduleState: state, transient: true, fireShowID: controller.id }, { transient: true }),
    () => native.upsertNativeCargo({ entityID: entity.itemID, cargoID, moduleID,
      typeID: charge.typeID, groupID: 500, categoryID: 8, ownerID: entity.itemID,
      flagID: 27, itemName: charge.name, quantity, singleton: false,
      transient: true, fireShowID: controller.id }, { transient: true }),
  ];
  for (const write of rows) {
    const result = write();
    if (!result || !result.success) throw new Error(result?.errorMsg || "NATIVE_SHOW_LOADOUT_FAILED");
  }
  entity.fittedItems = native.buildNativeFittedItems(entity.itemID);
  entity.nativeCargoItems = native.buildNativeCargoItems(entity.itemID);
}

function removeNativeEntry(entry, showID) {
  // Only rows carrying this generation's server-authored tag may be removed.
  for (const row of native.listNativeModulesForEntity(entry.entity.itemID)) {
    if (row.fireShowID === showID) native.removeNativeModule(row.moduleID);
  }
  for (const row of native.listNativeCargoForEntity(entry.entity.itemID)) {
    if (row.fireShowID === showID) native.removeNativeCargo(row.cargoID);
  }
  if (native.getNativeEntity(entry.entity.itemID)?.fireShowID === showID) {
    native.removeNativeEntity(entry.entity.itemID);
  }
}

function removeEntry(scene, entry, showID) {
  if (entry.removed) return;
  entry.removed = true;
  if (scene.getEntityByID(entry.entity.itemID) === entry.entity) {
    for (const moduleID of entry.entity.activeModuleEffects?.keys() || []) {
      scene.finalizeGenericModuleDeactivation(pseudoSession(scene, entry.entity), moduleID,
        { reason: "fireShowCleanup", nowMs: scene.getCurrentSimTimeMs() });
    }
    scene.removeDynamicEntity(entry.entity.itemID, { persistSpaceState: false });
  }
  if (scene.fireShowEntitiesByID?.get(entry.entity.itemID) === entry.entity) {
    scene.fireShowEntitiesByID.delete(entry.entity.itemID);
  }
  removeProjectilesForSource(scene, entry.entity, showID);
  removeNativeEntry(entry, showID);
}

function registerMissile(scene, source, missile) {
  if (scene.fireShowEntitiesByID?.get(source.itemID) === source &&
      scene.getEntityByID(source.itemID) === source && isFireShowShip(source) &&
      missile.fireShowID === source.fireShowID) {
    scene.fireShowEntitiesByID.set(missile.itemID, missile);
  }
}

function removeProjectilesForSource(scene, source, showID) {
  for (const missile of [...(scene.fireShowEntitiesByID?.values() || [])]) {
    if (missile.kind !== "missile" || missile.fireShowID !== showID || missile.sourceShipID !== source.itemID) continue;
    if (scene.getEntityByID(missile.itemID) === missile) {
      scene.removeDynamicEntity(missile.itemID, { persistSpaceState: false });
    }
    if (scene.fireShowEntitiesByID.get(missile.itemID) === missile) {
      scene.fireShowEntitiesByID.delete(missile.itemID);
    }
  }
}

function clearScene(scene) {
  if (!scene) return;
  const controller = scene.fireShowController;
  if (!controller && !scene.fireShowHasAssets && !scene.fireShowEntitiesByID?.size) return;
  scene.fireShowController = null;
  if (controller) {
    for (const entry of controller.entries) removeEntry(scene, entry, controller.id);
  }
  // Keep exact registered references even when a controller was interrupted.
  // A copied marker or reused ID never grants ownership of a replacement.
  for (const entity of [...(scene.fireShowEntitiesByID?.values() || [])]) {
    if (scene.getEntityByID(entity.itemID) === entity) {
      scene.removeDynamicEntity(entity.itemID, { persistSpaceState: false });
    }
    if (isFireShowShip(entity)) removeNativeEntry({ entity }, entity.fireShowID);
  }
  scene.fireShowEntitiesByID?.clear();
  for (const record of native.listNativeEntitiesForSystem(scene.systemID)) {
    if (record.sceneKey === scene.sceneKey && record.transient === true &&
        record.npcEntityType === "fireShow" && record.fireShowID) {
      removeNativeEntry({ entity: { itemID: record.entityID } }, record.fireShowID);
    }
  }
  scene.fireShowHasAssets = false;
}

function handleEntityRemoved(scene, entity) {
  const controller = scene.fireShowController;
  if (controller?.owner === entity) {
    clearScene(scene);
    return;
  }
  const owned = scene.fireShowEntitiesByID?.get(entity.itemID) === entity;
  if (!owned) return;
  scene.fireShowEntitiesByID.delete(entity.itemID);
  if (!isFireShowShip(entity)) return;
  const entry = controller?.entries.find((value) => value.entity === entity);
  if (entry) entry.removed = true;
  removeNativeEntry({ entity }, entity.fireShowID);
  removeProjectilesForSource(scene, entity, entity.fireShowID);
}

function handleSessionDisconnected(session, scene = space().getSceneForSession(session)) {
  if (scene?.fireShowController?.session === session) clearScene(scene);
}

function handleCommand(session, text) {
  if (!session?.characterID) return failure("Select a character before using /fireshow.");
  if (!hasStaffDebugRole(session)) return failure("Firework show requires a staff/admin role.");
  if (!session._space || !sessionRegistry.isRegisteredSession(session)) {
    return failure("You must be in space to use /fireshow.");
  }
  const request = parseRequest(text);
  if (!request.success) return request;
  const scene = space().getSceneForSession(session);
  const owner = scene?.getShipEntityForSession(session);
  if (!scene || !owner || owner.session !== session || owner.mode === "WARP" ||
      !canEntitiesInteractLocally(owner, owner)) {
    return failure("Active ship was not found in the exact current scene.");
  }
  const existing = scene.fireShowController;
  if (existing && existing.session !== session) {
    return failure("Another pilot owns the active firework show in this scene.");
  }
  if (request.stop) {
    clearScene(scene);
    return { success: true, message: "Firework show stopped." };
  }
  if (existing && existing.owner === owner) {
    return { success: true, message: `Your firework show is already running with ${existing.entries.length} ships.` };
  }
  const resources = resolveResources();
  if (!resources.success) return resources;
  clearScene(scene);
  const now = scene.getCurrentSimTimeMs();
  const controller = { id: randomUUID(), owner, session, characterID: session.characterID,
    startedAtMs: now, expiresAtMs: now + LIMITS.lifetimeMs, nextTickAtMs: now, entries: [] };
  scene.fireShowController = controller;
  scene.fireShowHasAssets = true;
  scene.fireShowEntitiesByID = new Map();
  try {
    for (let index = 0; index < request.count; index += 1) {
      const hull = resources.hulls[index % resources.hulls.length];
      const itemID = allocate(native.allocateEntityID);
      const position = formationPoint(owner, index, request.count);
      const result = space().spawnDynamicShip(scene.systemID, {
        itemID, typeID: hull.typeID, itemName: `Firework ${hull.name}`, ownerID: itemID,
        pilotCharacterID: itemID, characterID: itemID, npcEntityType: "fireShow",
        position, direction: normalizeVector(subtractVectors(owner.position, position)),
        nativeNpc: true, transient: true, mode: "STOP",
      }, { sceneDescriptor: scene.sceneDescriptor, entityScopeMetadata: buildChildEntityScopeMetadata(owner),
        broadcast: false, persistSpaceState: false });
      if (!result.success || !result.data?.entity) throw new Error(result.errorMsg || "SHOW_SPAWN_FAILED");
      const entity = result.data.entity;
      entity.fireShowID = controller.id;
      scene.fireShowEntitiesByID.set(entity.itemID, entity);
      const entry = { entity, removed: false, nextFireAtMs: now + (index % 4) * 250 };
      controller.entries.push(entry);
      writeLoadout(controller, entry, resources, index);
      scene.orbitShipEntity(entity, owner.itemID, magnitude(subtractVectors(position, owner.position)),
        { speedFraction: 0.5 });
    }
  } catch (error) {
    clearScene(scene);
    return failure(`Firework show could not start: ${error.message}. Temporary assets were removed.`);
  }
  return { success: true, message: `Firework show started with ${request.count} ships for ten simulation minutes.` };
}

function tickScene(scene) {
  const controller = scene.fireShowController;
  if (!controller) return;
  const now = scene.getCurrentSimTimeMs();
  if (now >= controller.expiresAtMs || !sessionRegistry.isRegisteredSession(controller.session) ||
      !hasStaffDebugRole(controller.session) ||
      controller.session.characterID !== controller.characterID ||
      space().getSceneForSession(controller.session) !== scene ||
      scene.getShipEntityForSession(controller.session) !== controller.owner ||
      controller.owner.session !== controller.session || controller.owner.mode === "WARP") {
    clearScene(scene);
    return;
  }
  if (now < controller.nextTickAtMs) return;
  controller.nextTickAtMs = now + 250;
  try {
    for (const entry of controller.entries) {
      const entity = entry.entity;
      if (entry.removed) continue;
      if (scene.getEntityByID(entity.itemID) !== entity) {
        removeEntry(scene, entry, controller.id);
        continue;
      }
      if (now < entry.nextFireAtMs) continue;
      const session = pseudoSession(scene, entity);
      // Native lock validation, scan-resolution delay and capacity are retained.
      const lock = scene.addTarget(session, controller.owner.itemID);
      if (!lock.success || lock.data?.pending) continue;
      const module = entity.fittedItems[0];
      if (entity.activeModuleEffects?.has(module.itemID)) continue;
      // Read the exact native row, avoiding a whole cargo-table scan per ship.
      const row = native.getNativeCargo(entry.cargoID);
      if (row && (row.fireShowID !== controller.id || row.entityID !== entity.itemID ||
          row.moduleID !== entry.moduleID)) throw new Error("SHOW_CARGO_IDENTITY_CHANGED");
      if (!row || row.quantity < 1) {
        const refill = native.upsertNativeCargo({ ...row, cargoID: entry.cargoID,
          entityID: entity.itemID, moduleID: entry.moduleID, ownerID: entity.itemID, flagID: 27,
          typeID: entry.chargeType.typeID, groupID: 500, categoryID: 8, itemName: entry.chargeType.name,
          quantity: entry.capacity, singleton: false, transient: true, fireShowID: controller.id }, { transient: true });
        if (!refill.success) throw new Error(refill.errorMsg || "SHOW_REFILL_FAILED");
        entity.nativeCargoItems = native.buildNativeCargoItems(entity.itemID);
      }
      const activation = scene.activateGenericModule(session, module, "useMissiles",
        { targetID: controller.owner.itemID, repeat: 0 });
      entry.nextFireAtMs = now + 1000;
      if (!activation.success && !["TARGET_NOT_LOCKED", "TARGET_OUT_OF_RANGE", "MODULE_ALREADY_ACTIVE"].includes(activation.errorMsg)) {
        throw new Error(activation.errorMsg || "SHOW_ACTIVATION_FAILED");
      }
    }
  } catch (error) {
    require("../../utils/logger").warn(`[FireShow] Stopping failed show: ${error.message}`);
    clearScene(scene);
  }
}

module.exports = { LIMITS, parseRequest, resolveResources, formationPoint, handleCommand,
  tickScene, clearScene, registerMissile, handleEntityRemoved, handleSessionDisconnected };
