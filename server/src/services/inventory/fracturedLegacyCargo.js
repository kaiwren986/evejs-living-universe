"use strict";

// The captured Sisters' Odysseus accepts the isotope cargo into NPC custody.
// It is a native NPC, not a player inventory hull. Its narrow inventory port
// never grants access to another NPC or to the player's remote inventory.
const { resolveSessionCharacterID } = require("../_shared/sessionIdentity");
const items = require("./itemStore");
const custody = require("./itemCustody");

function findReceiver(session, receiverID) {
  const scene = require("../../space/runtime").getSceneForSession(session);
  const entity = scene?.getEntityByID(Number(receiverID));
  if (entity?.nativeNpc !== true || Number(entity.typeID) !== 90423 || !(Number(entity.dungeonSiteInstanceID) > 0)) return null;
  const instance = require("../dungeon/dungeonRuntime").getInstance(entity.dungeonSiteInstanceID);
  const template = instance && require("../dungeon/dungeonAuthority").getTemplateByID(instance.templateID);
  const policy = template?.fracturedLegacy;
  if (policy?.version !== 1 || policy.epicArcID !== 128 || policy.missionID !== 17131 ||
      Number(template.sourceDungeonID) !== 13339 || !template.requiresMechanics?.includes("fractured-legacy-v1") || !policy.delivery) return null;
  return { scene, entity, instance, policy: policy.delivery };
}

function isReceiver(session, receiverID) {
  return findReceiver(session, receiverID) !== null;
}

function resolveReceiver(session, receiverID) {
  const context = findReceiver(session, receiverID);
  if (!context) return null;
  const { scene, entity, instance, policy } = context;
  const characterID = resolveSessionCharacterID(session);
  const shipID = Number(session?._space?.shipID || session?.shipID || session?.shipid);
  const ship = scene.getEntityByID(shipID);
  if (!(characterID > 0) || !ship ||
      Number(ship.characterID || ship.pilotCharacterID || ship.ownerID) !== characterID ||
      Number(instance.ownership?.missionOwnerCharacterID || instance.ownership?.characterID) !== characterID ||
      !["seeded", "active", "paused"].includes(instance.lifecycleState) ||
      Number(instance.solarSystemID) !== Number(scene.systemID) ||
      Number(ship.dungeonCurrentInstanceID) !== Number(instance.instanceID) ||
      Number(entity.ownerID) !== 1000130 || Number(policy.containerTypeID) !== 90423 ||
      Number(policy.oreTypeID) !== 90421 || Number(policy.quantity) !== 4000 ||
      Number(policy.ownerID) !== 1000130 || session.stationid || session.stationID) return null;
  const distance = Math.hypot(ship.position.x - entity.position.x, ship.position.y - entity.position.y,
    ship.position.z - entity.position.z) - Math.max(0, Number(ship.radius) || 0) - Math.max(0, Number(entity.radius) || 0);
  if (!Number.isFinite(distance) || distance > 2500) return null;
  return { ...context, ship, characterID };
}

function listReceived(session, receiverID) {
  const context = resolveReceiver(session, receiverID);
  if (!context) return [];
  return items.listContainerItems(1000130, Number(receiverID), items.ITEM_FLAGS.CARGO_HOLD)
    .filter(item => Number(item.typeID) === 90421);
}

function receiverItem(session, receiverID) {
  const context = resolveReceiver(session, receiverID);
  if (!context) return null;
  const { entity, scene } = context;
  const type = require("./itemTypeRegistry").resolveItemByTypeID(90423);
  return { itemID: entity.itemID, typeID: 90423, ownerID: 1000130,
    locationID: scene.systemID, flagID: 0, quantity: 1, stacksize: 1, singleton: 1,
    groupID: type?.groupID, categoryID: type?.categoryID, customInfo: "",
    itemName: entity.itemName || entity.slimName || type?.name || "SOE Odysseus" };
}


// A handover is an accepted instance-owned command, not a live NPC inventory
// quantity. Its command is frozen before custody and acknowledged after both
// the custody receipt and this instance state are durable.
function deliveryKeyFor(instance, template) {
  const populationHints = instance?.spawnState?.populationHints || template?.populationHints;
  const rows = (populationHints?.encounters || []).flatMap(plan => plan.spawnEntries || [])
    .filter(entry => Number(entry.typeID) === 90423 && typeof entry.key === "string" && entry.key.length);
  return rows.length === 1 ? rows[0].key : null;
}

function deliveryIdentity(instance) {
  const template = instance && require("../dungeon/dungeonAuthority").getTemplateByID(instance.templateID);
  const policy = template && require("../dungeon/fracturedLegacyRuntime").contract(template);
  const characterID = Number(instance?.ownership?.missionOwnerCharacterID || instance?.ownership?.characterID);
  const receiverKey = deliveryKeyFor(instance, template);
  if (policy?.missionID !== 17131 || !receiverKey || !(characterID > 0)) return null;
  return { instanceID: Number(instance.instanceID), characterID, receiverKey,
    idempotencyKey: `fractured-delivery:${instance.instanceID}:${characterID}:${receiverKey}` };
}

function matchesDelivery(intent, identity) {
  return intent?.version === 1 && identity &&
    ["instanceID", "characterID", "receiverKey", "idempotencyKey"].every(key => intent[key] === identity[key]) &&
    intent.command?.idempotencyKey === identity.idempotencyKey && intent.command.items?.quantity === 4000 &&
    intent.command.from?.ownerID === identity.characterID && intent.command.to?.ownerID === 1000130 &&
    intent.command.to?.flagID === items.ITEM_FLAGS.CARGO_HOLD &&
    intent.command.actor === identity.characterID &&
    intent.command.reason === custody.CUSTODY_REASON.INV_BROKER_OWNER_TRANSFER &&
    [items.ITEM_FLAGS.CARGO_HOLD, items.ITEM_FLAGS.GENERAL_MINING_HOLD].includes(intent.command.from?.flagID) &&
    [intent.command.items?.itemID, intent.command.from?.locationID, intent.command.to?.locationID]
      .every(value => Number.isSafeInteger(value) && value > 0);
}

function settleDelivery(input) {
  const identity = deliveryIdentity(input);
  if (!identity) return { success: true, deliveredQuantity: 0, changes: [] };
  const runtime = require("../dungeon/dungeonRuntime");
  const persisted = runtime.getPersistedInstance(input.instanceID);
  const acknowledged = persisted?.spawnState?.fracturedLegacyDelivery;
  if (matchesDelivery(acknowledged, identity) && acknowledged.status === "completed") {
    return { success: true, deliveredQuantity: 4000, changes: [] };
  }
  const intent = runtime.getInstance(input.instanceID)?.spawnState?.fracturedLegacyDelivery || acknowledged;
  if (!intent) return { success: true, deliveredQuantity: 0, changes: [] };
  if (!matchesDelivery(intent, identity)) return { success: false, errorMsg: "FRACTURED_DELIVERY_INTENT_MISMATCH" };
  // A failed prepare/ack fence can still be present in the hot cache. Fence
  // this exact accepted command again before a new or duplicate custody call.
  runtime.mergeSpawnState(input.instanceID, { fracturedLegacyDelivery: { ...intent, status: "prepared" } },
    { durable: true, force: true });
  const result = custody.transfer(intent.command);
  if (!result?.success || result.durable !== true) return {
    success: false, errorMsg: result?.errorMsg || "FRACTURED_DELIVERY_CUSTODY_PENDING" };
  runtime.mergeSpawnState(input.instanceID, { fracturedLegacyDelivery: { ...intent, status: "completed" } },
    { durable: true, force: true });
  const committedChanges = result.data?.receipt?.resultData?.changes || result.data?.changes || [];
  return { success: true, deliveredQuantity: 4000, changes: committedChanges, command: intent.command };
}

function reconcileDelivery(input) {
  try { return settleDelivery(input); }
  catch (error) { return { success: false, errorMsg: error.message || "FRACTURED_DELIVERY_PENDING" }; }
}

// A replay has no new changes; its receipt identifies the rows the pilot
// missed during the refused fence. Send current rows, never stale quantities.
function currentDeliveryChanges(result) {
  if (!result.success || !result.changes?.length) return [];
  const command = result.command;
  return result.changes.map(change => {
    const previous = change.item || change.previousData;
    const current = items.findItemById(previous.itemID);
    const visible = current && (Number(current.ownerID) === command.actor ||
      (Number(current.ownerID) === command.to.ownerID && Number(current.locationID) === command.to.locationID));
    return { ...change, item: visible ? current : items.buildRemovedItemNotificationState(previous) };
  });
}

function publishRecoveredDelivery(result, session) {
  const changes = currentDeliveryChanges(result);
  if (!changes.length) return;
  const command = result.command;
  const characters = require("../character/characterState");
  for (const target of require("../raffles/raffleInventory").getCharacterSessions(command.actor, { includeSession: session })) {
    characters.emitItemsChangedBatchForSession(target, changes);
  }
}

function tryDeliver(session, receiverID, item, requestedQuantity) {
  if (!isReceiver(session, receiverID)) return null;
  const reject = { handled: true, success: false, changes: [] };
  try {
    const context = resolveReceiver(session, receiverID);
    if (!context) return reject;
    const identity = deliveryIdentity(context.instance);
    if (!identity || context.entity.dungeonSiteContentKey !== identity.receiverKey) return reject;
    const runtime = require("../dungeon/dungeonRuntime");
    if (runtime.getInstance(context.instance.instanceID)?.spawnState?.fracturedLegacyDelivery) {
      const recovered = reconcileDelivery(context.instance);
      return { handled: true, success: recovered.success === true && recovered.deliveredQuantity === 4000,
        changes: currentDeliveryChanges(recovered) };
    }
    if (!item || Number(item.ownerID) !== context.characterID || Number(item.typeID) !== 90421 ||
        Number(item.locationID) !== Number(context.ship.itemID) ||
        ![items.ITEM_FLAGS.CARGO_HOLD, items.ITEM_FLAGS.GENERAL_MINING_HOLD].includes(Number(item.flagID))) return reject;
    const available = Number(item.stacksize ?? item.quantity);
    const quantity = requestedQuantity === null || requestedQuantity === undefined ? available : Number(requestedQuantity);
    const delivered = listReceived(session, receiverID).reduce((sum, row) => sum + Number(row.quantity), 0);
    // Preserve the captured full-deposit contract: 4003 is refused, 4000 accepted.
    if (!Number.isSafeInteger(quantity) || quantity !== 4000 || delivered !== 0 || quantity > available) return reject;
    const command = {
      items: { itemID: Number(item.itemID), quantity },
      from: custody.custodyRef.ownerLocation(context.characterID, context.ship.itemID, item.flagID),
      to: custody.custodyRef.ownerLocation(1000130, Number(receiverID), items.ITEM_FLAGS.CARGO_HOLD),
      actor: context.characterID, reason: custody.CUSTODY_REASON.INV_BROKER_OWNER_TRANSFER,
      idempotencyKey: identity.idempotencyKey,
    };
    const intent = { version: 1, ...identity, status: "prepared", command };
    runtime.mergeSpawnState(context.instance.instanceID, { fracturedLegacyDelivery: intent }, { durable: true, force: true });
    const settled = reconcileDelivery(context.instance);
    return { handled: true, success: settled.success === true && settled.deliveredQuantity === 4000,
      changes: currentDeliveryChanges(settled) };
  } catch (error) {
    return { ...reject, errorMsg: error.message || "FRACTURED_DELIVERY_PENDING" };
  }
}

module.exports = { isReceiver, resolveReceiver, listReceived, receiverItem, tryDeliver, reconcileDelivery, publishRecoveredDelivery };
