"use strict";

// Domain observers run after the caller's mutation/receipt stack has finished.
// This leaf never imports inventory or a gameplay domain.
const listeners = new Set();
function subscribe(listener, selectItemIDs = (ids) => ids || []) {
  const subscription = { listener, selectItemIDs };
  listeners.add(subscription);
  return () => listeners.delete(subscription);
}
function publish(changedItemIDs, items) {
  if (!listeners.size) return;
  const ids = changedItemIDs ? [...new Set(changedItemIDs)] : null;
  for (const subscription of listeners) {
    const snapshots = new Map();
    for (const id of subscription.selectItemIDs(ids)) {
      const item = items[String(id)];
      snapshots.set(Number(id), item ? {
        itemID: Number(id), ownerID: item.ownerID, locationID: item.locationID,
        flagID: item.flagID, typeID: item.typeID, singleton: item.singleton,
        quantity: Number(item.stacksize ?? item.quantity),
        inventoryCustodyRevision: item.inventoryCustodyRevision,
      } : null);
    }
    if (!snapshots.size) continue;
    queueMicrotask(() => {
      if (listeners.has(subscription)) subscription.listener(ids, snapshots);
    });
  }
}
module.exports = { subscribe, publish };
