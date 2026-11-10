"use strict";
const items = () => require("../inventory/itemStore");
const runtime = () => require("./homefrontRuntime");
const rewards = require("./homefrontRewards");
const engine = require("./homefrontEngine");
const FREIGHT = 77474;
function isReceiver(session, id) {
  return (
    require("../../space/runtime")
      .getSceneForSession(session)
      ?.getEntityByID(Number(id))?.homefrontRole === "receiver"
  );
}
function tryDeliver(session, receiverID, item, quantity) {
  const scene = require("../../space/runtime").getSceneForSession(session);
  const receiver = scene?.getEntityByID(Number(receiverID));
  if (receiver?.homefrontRole !== "receiver") return null;
  const instance = require("../dungeon/dungeonRuntime").getInstance(
    receiver.dungeonSiteInstanceID,
  );
  const siteConfig = runtime().config(instance);
  const operationState = rewards.getOperation(instance);
  const id = Number(session.characterID || session.charid);
  const ship = runtime()
    .players(scene, instance, siteConfig)
    .find((entity) => runtime().character(entity) === id);
  const reject = { handled: true, success: false, changes: [] };
  if (
    !ship ||
    operationState?.status !== "active" ||
    item.typeID !== FREIGHT ||
    item.ownerID !== id ||
    item.locationID !== ship.itemID ||
    item.flagID !== items().ITEM_FLAGS.CARGO_HOLD
  )
    return reject;
  if (
    Math.hypot(
      ship.position.x - receiver.position.x,
      ship.position.y - receiver.position.y,
      ship.position.z - receiver.position.z,
    ) -
      (ship.radius || 0) -
      (receiver.radius || 0) >
    2500
  )
    return reject;
  const amount = Math.min(
    4 - operationState.deliveries,
    Number(item.quantity || item.stacksize) || 0,
    quantity || Number(item.quantity || item.stacksize) || 0,
  );
  if (!Number.isSafeInteger(amount) || amount <= 0) return reject;
  const key = `delivery:${instance.instanceID}:${item.itemID}:${operationState.deliveries}`;
  operationState.pendingDelivery = {
    key,
    characterID: id,
    itemID: item.itemID,
    amount,
    nowMs: Date.now(),
    presentCharacterIDs: runtime()
      .players(scene, instance, siteConfig)
      .map(runtime().character),
  };
  rewards.saveOperation(instance, operationState);
  return finishDelivery(instance, siteConfig, operationState);
}
function finishDelivery(instance, siteConfig, operationState) {
  const pending = operationState.pendingDelivery;
  if (!pending) return null;
  const result = items().consumeInventoryItemQuantityIdempotent(
    pending.itemID,
    pending.amount,
    {
      receiptKey: pending.key,
      fingerprint: {
        operation: "homefront-delivery",
        instanceID: instance.instanceID,
        characterID: pending.characterID,
        itemID: pending.itemID,
        quantity: pending.amount,
      },
    },
  );
  if (!result.success) return { handled: true, success: false, changes: [] };
  // The pending record survives a crash after consumption; the inventory
  // receipt is replayed before the objective is advanced exactly once.
  engine.event(operationState, siteConfig, {
    kind: "delivery",
    key: pending.key,
    characterID: pending.characterID,
    amount: pending.amount,
    nowMs: pending.nowMs,
  });
  engine.sealRewards(
    operationState,
    siteConfig,
    pending.presentCharacterIDs || [pending.characterID],
    pending.nowMs,
  );
  delete operationState.pendingDelivery;
  rewards.saveOperation(instance, operationState);
  return { handled: true, success: true, changes: result.data?.changes || [] };
}
function cleanup(ship) {
  if (!ship?.itemID) return;
  for (const item of items().listContainerItems(null, ship.itemID))
    if (item.typeID === FREIGHT) {
      const result = items().consumeInventoryItemQuantity(
        item.itemID,
        Number(item.quantity || item.stacksize) || 1,
      );
      if (!result.success) throw new Error("Homefront cargo cleanup failed");
    }
}
module.exports = { FREIGHT, isReceiver, tryDeliver, finishDelivery, cleanup };
