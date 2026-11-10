"use strict";

const runtime = require("../../../space/runtime");
const items = require("../../inventory/itemStore");
const { resolveItemByName } = require("../../inventory/itemTypeRegistry");
const { isCargoContainerType } = require("../../ship/cargoContainerRuntime");
const { buildChildEntityScopeMetadata } = require("../../../space/destiny/identity/interactionScope");
const { tokenizeQuotedArguments } = require("./commandArguments");
const { hasStaffDebugRole } = require("./commandAccess");
const { handledResult } = require("./commandReplies");
const log = require("../../../utils/logger");
const { randomUUID } = require("node:crypto");

const PENDING_SPAWN_KEY = "evejsNativeSpawnPending";
const pendingCleanupByScene = new WeakMap();

function pendingInventorySpawn(item) {
  try {
    const pending = JSON.parse(item.customInfo || "{}")[PENDING_SPAWN_KEY];
    return pending?.version === 1 && typeof pending.batchID === "string" &&
      pending.batchID.length > 0 && Number.isSafeInteger(pending.actorID) && pending.actorID > 0 &&
      Number.isSafeInteger(pending.solarSystemID) && pending.solarSystemID > 0 ? pending : null;
  } catch (_error) { return null; }
}

function retainPendingSpawn(scene, entry) {
  let entries = pendingCleanupByScene.get(scene);
  if (!entries) pendingCleanupByScene.set(scene, entries = new Map());
  entries.set(entry.item.itemID, entry);
}

function cleanupPendingSpawns(scene, anchor, actorID) {
  const pending = pendingCleanupByScene.get(scene) || new Map();
  // The original grant carries cleanup intent. A new command module/process
  // can find failed inventory spawns after scene disposal or restart too.
  for (const item of items.listItemsMatching((row) => typeof row?.customInfo === "string" && row.customInfo.includes(PENDING_SPAWN_KEY))) {
    const marker = pendingInventorySpawn(item);
    if (marker && marker.actorID === actorID && marker.solarSystemID === scene.systemID && !pending.has(item.itemID) &&
        require("../../../space/destiny/identity/interactionScope").canEntitiesInteractLocally(anchor, marker.scope)) {
      pending.set(item.itemID, { item, marker, npc: false });
    }
  }
  // Inventory owns the unresolved receipt across command-module reloads.
  // This is only known same-process persistence ambiguity, not RPC deduplication.
  for (const completion of items.listPendingNativeSpawnCompletions(actorID, scene.systemID)) {
    if (!require("../../../space/destiny/identity/interactionScope").canEntitiesInteractLocally(anchor, completion.marker.scope)) continue;
    for (const id of completion.ids) {
      pending.set(id, { item: items.findItemById(id) || { itemID: id },
        marker: completion.marker, npc: false, completion });
    }
  }
  const errors = [];
  const recovered = [];
  for (const [id, entry] of pending) {
    if (entry.marker?.actorID !== actorID ||
        !require("../../../space/destiny/identity/interactionScope").canEntitiesInteractLocally(anchor, entry.marker.scope)) continue;
    try {
      if (entry.completion) {
        const completion = entry.completion;
        const result = items.commitNativeSpawnItems(completion.ids, completion.marker.batchID, completion.marker.actorID, completion);
        if (!result.success) throw new Error(`completion pending: ${result.errorMsg}`);
        for (const completedID of completion.ids) {
          const entity = scene.getEntityByID(completedID);
          if (entity) {
            entity.evejsInitialPublicationDeferred = false;
            scene.broadcastAddBalls([entity], null, { freshAcquire: true });
          }
          pending.delete(completedID);
        }
        recovered.push(completion);
        continue;
      }
      let result;
      if (entry.npc) {
        // These actors were born transient and never ticked their behavior.
        // Remove their owned rows before retiring the live projection.
        result = require("../../../space/npc/nativeNpcStore").removeNativeEntityCascade(id);
      } else {
        if (require("../sessionRegistry").getSessions().some((session) => Number(session._space?.shipID) === id)) {
          throw new Error("SPAWN_CLEANUP_OCCUPIED_SHIP");
        }
        const custody = require("../../inventory/itemCustody");
        result = custody.transfer({ items: { itemID: id },
          from: custody.custodyRef.inSpace(entry.marker.actorID, entry.marker.solarSystemID),
          to: custody.custodyRef.void(), reason: custody.CUSTODY_REASON.NATIVE_SPAWN_ROLLBACK,
          actor: entry.marker.actorID, idempotencyKey: `gm-spawn-rollback:${entry.marker.batchID}:${id}`,
          options: { removeContents: false },
        });
      }
      if (!result?.success) throw new Error(result?.errorMsg || "SPAWN_CLEANUP_FAILED");
      const entity = scene.getEntityByID(id);
      if (entry.npc) require("../../../space/npc/npcRegistry").unregisterController(id);
      if (entity) scene.unregisterDynamicEntity(entity, { persistSpaceState: false });
      pending.delete(id);
    } catch (error) {
      errors.push(`${id}: ${error.message}`);
      if (entry.completion) continue;
      // A failed compensation is retained and reported, never hidden behind a
      // generic failure. If its initial projection failed, try to expose it.
      try {
        let entity = scene.getEntityByID(id);
        if (!entity && !entry.npc && items.findItemById(id)) {
          const restored = runtime.spawnDynamicInventoryEntity(scene.systemID, id,
            { sceneDescriptor: scene.sceneDescriptor, broadcast: false });
          entity = restored?.success ? restored.data?.entity : null;
        }
        if (entity) {
          entity.evejsInitialPublicationDeferred = false;
          scene.broadcastAddBalls([entity], null, { freshAcquire: true });
        }
      } catch (publishError) {
        log.warn(`[NativeGmSpawn] Pending cleanup publication failed entity=${id}: ${publishError.message}`);
      }
    }
  }
  if (pending.size) pendingCleanupByScene.set(scene, pending);
  else pendingCleanupByScene.delete(scene);
  return { errors, recovered };
}

function handleNativeSpawnCommand(session, command, argumentText, chatHub, options) {
  const reply = (message) => handledResult(chatHub, session, options, message);
  if (!hasStaffDebugRole(session)) return reply(`/${command} requires a staff/admin role.`);
  const scene = runtime.getSceneForSession(session);
  const anchor = scene && scene.getShipEntityForSession(session);
  if (!anchor) return reply("Enter space before spawning entities.");
  const recovery = cleanupPendingSpawns(scene, anchor, Number(session.characterID));
  if (recovery.errors.length) return reply(`Spawn cleanup pending: ${recovery.errors.join(", ")}. No new entities created.`);
  if (recovery.recovered.length) {
    const previous = recovery.recovered[0];
    return { ...reply(`Recovered prior spawn of ${previous.ids.length} ${previous.typeName}; no new entities created.`),
      returnValue: previous.command === "spawn" ? previous.ids[0] : previous.ids };
  }
  let name = null, spread = 0, valid = true;
  const text = String(argumentText || "").replace(/\b(name|stddev)=("[^"]*"|'[^']*'|\S+)/gi, (_, key, value) => {
    const unquoted = value.replace(/^(["'])(.*)\1$/, "$2");
    if (key.toLowerCase() === "name") name = unquoted;
    else { spread = Number(unquoted); valid = valid && Number.isFinite(spread) && spread >= 0; }
    return "";
  });
  const tokens = tokenizeQuotedArguments(text);
  let count = 1, distance = 4000, query;
  if (command === "spawn") query = tokens.join(" ");
  else if (command === "spawnn") {
    count = Number(tokens.shift()); distance = Number(tokens.shift()); query = tokens.join(" ");
  } else {
    valid = valid && String(tokens.shift() || "").toLowerCase() === "deploy";
    count = Number(tokens.shift()); query = tokens.join(" ");
  }
  // Use the existing /npc command's batch ceiling for the native aliases too.
  if (!valid || !Number.isSafeInteger(count) || count < 1 || count > 50 ||
      !Number.isFinite(distance) || distance < 0 || !query) {
    return reply("Usage: /spawn <type> [name=\"name\"] [stddev=meters], /spawnN <1..50> <meters> <type>, /entity deploy <1..50> <type>");
  }
  const lookup = resolveItemByName(query);
  if (!lookup.success) return reply(`Spawn type lookup failed: ${query}.`);
  const type = lookup.match;
  let definition = null;
  if (Number(type.categoryID) === 11) {
    const data = require("../../../space/npc/npcData");
    const profile = data.listNpcProfiles().find((row) => Number(row.shipTypeID) === Number(type.typeID));
    definition = profile && data.buildNpcDefinition(profile.profileID);
    if (!definition) return reply("That NPC type has no authored runtime profile.");
  } else if (Number(type.categoryID) !== 6 && Number(type.groupID) !== 186 && !isCargoContainerType(type)) {
    return reply("That type requires its dedicated deployment service; native spawn supports ships, authored NPCs, cargo containers and wrecks.");
  }
  const scope = buildChildEntityScopeMetadata(anchor);
  const spawned = [];
  const marker = { version: 1, batchID: randomUUID(), actorID: Number(session.characterID),
    solarSystemID: Number(scene.systemID), scope };
  try {
    for (let index = 0; index < count; index++) {
      const angle = index * 2 * Math.PI / count;
      const jitter = () => spread > 0 ? spread * Math.sqrt(-2 * Math.log(Math.max(Number.EPSILON, Math.random()))) * Math.cos(2 * Math.PI * Math.random()) : 0;
      const position = { x: anchor.position.x + distance * Math.cos(angle) + jitter(),
        y: anchor.position.y + jitter(), z: anchor.position.z + distance * Math.sin(angle) + jitter() };
      if (!Object.values(position).every(Number.isFinite)) throw new Error("INVALID_SPAWN_POSITION");
      const state = { systemID: scene.systemID, position, targetPoint: { ...position },
        velocity: { x: 0, y: 0, z: 0 }, direction: { ...anchor.direction }, mode: "STOP", speedFraction: 0, ...scope };
      let result;
      if (definition) {
        result = require("../../../space/npc/nativeNpcService").spawnNativeNpcEntityInContext(
          { scene, systemID: scene.systemID, anchorEntity: anchor }, definition,
          { broadcast: false, initialPublication: "deferred", transient: true, entityScopeMetadata: scope,
            spawnStateOverride: state, skipInitialBehaviorTick: true, ...(name === null ? {} : { slimNameOverride: name }) },
        );
        if (result?.data?.entity) retainPendingSpawn(scene,
          { item: result.data.entity, marker, npc: true });
      } else {
        const grant = items.grantItemToCharacterLocation(session.characterID, scene.locationID || scene.systemID, 0, type, 1,
          { singleton: 1, spaceState: state, customInfo: JSON.stringify({ [PENDING_SPAWN_KEY]: marker }),
            ...(name === null ? {} : { itemName: name }) });
        if (!grant.success) throw new Error(grant.errorMsg || "SPAWN_ITEM_CREATE_FAILED");
        const item = grant.data.items[0];
        retainPendingSpawn(scene, { item, marker, npc: false });
        result = runtime.spawnDynamicInventoryEntity(scene.systemID, item.itemID,
          { sceneDescriptor: scene.sceneDescriptor, broadcast: false, initialPublication: "deferred", entityScopeMetadata: scope });
      }
      if (!result?.success || !result.data?.entity) throw new Error(result?.errorMsg || "SPAWN_FAILED");
      spawned.push({ entity: result.data.entity, npc: Boolean(definition) });
    }
    const inventoryIDs = spawned.filter((entry) => !entry.npc).map((entry) => entry.entity.itemID);
    if (inventoryIDs.length) {
      const completion = { ids: inventoryIDs, marker, command, typeName: type.name };
      const committed = items.commitNativeSpawnItems(inventoryIDs, marker.batchID, marker.actorID, completion);
      if (!committed.success) {
        if (committed.ambiguous) {
          for (const id of inventoryIDs) pendingCleanupByScene.get(scene).get(id).completion = completion;
          return reply(`Spawn completion pending for ${inventoryIDs.join(", ")}: ${committed.errorMsg}. Retry to resolve this batch.`);
        }
        throw new Error(committed.errorMsg || "SPAWN_COMMIT_FAILED");
      }
    }
  } catch (error) {
    const pending = cleanupPendingSpawns(scene, anchor, Number(session.characterID));
    return reply(`Spawn failed: ${error.message}.${pending.errors.length ? ` Cleanup pending: ${pending.errors.join(", ")}.` : ""}`);
  }
  const retained = pendingCleanupByScene.get(scene);
  for (const { entity } of spawned) retained?.delete(entity.itemID);
  if (retained?.size === 0) pendingCleanupByScene.delete(scene);
  for (const { entity } of spawned) entity.evejsInitialPublicationDeferred = false;
  try { scene.broadcastAddBalls(spawned.map((entry) => entry.entity), null, { freshAcquire: true }); }
  catch (error) { log.warn(`[NativeGmSpawn] Publication failed: ${error.message}`); }
  const ids = spawned.map((entry) => entry.entity.itemID);
  return { ...reply(`Spawned ${ids.length} ${type.name}.`), returnValue: command === "spawn" ? ids[0] : ids };
}

module.exports = { handleNativeSpawnCommand };
