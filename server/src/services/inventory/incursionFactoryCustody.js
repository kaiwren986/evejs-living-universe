"use strict";

// Inventory owns the withdrawal fact. Missing stock, an RPC and a scene body
// cannot establish that a player received it or start a production timer.
const LEDGER = "__evejsIncursionFactoryWithdrawals";
const VERSION = "evejs.incursion-mtac-stock.v1";
const positive = value => Number.isSafeInteger(value) && value > 0;
function isFactory(item) {
  const state = item?.spaceState;
  return item?.typeID === 3498 && item.ownerID === 1 && item.flagID === 0 && positive(item.locationID) &&
    state?.dungeonMaterializedContainer === true && state.dungeonSiteContentRole === "incursion_mtac_factory" &&
    positive(state.dungeonSiteInstanceID) && state.dungeonSiteContentKey === "incursion-factory:1011577";
}
function stock(item) {
  if (item?.typeID !== 3501 || typeof item.customInfo !== "string") return null;
  let marker;
  try { marker = JSON.parse(item.customInfo).incursionMtac; } catch (_) { return null; }
  if (!marker || marker.version !== VERSION) return null;
  if (!positive(marker.instanceID) || !positive(marker.factoryID) || !positive(marker.serial) ||
      marker.serial > 65536 || marker.operationID !== `incursion-v2:${marker.instanceID}` ||
      !/^[a-f0-9]{64}$/.test(marker.policyFingerprint || "") ||
      marker.productionKey !== `incursion-mtac:${marker.instanceID}:${marker.serial}`) throw new Error("INCURSION_FACTORY_STOCK_INVALID");
  return marker;
}
function stageWithdrawals(base, items, stagedRows, removedRows, atMs) {
  const touched = new Set([...stagedRows.keys(), ...removedRows]), receipts = [];
  for (const key of touched) {
    const before = base[key];
    if (before?.typeID !== 3501) continue;
    const parent = base[String(before.locationID)];
    if (!isFactory(parent)) continue;
    const marker = stock(before);
    if (!marker || marker.factoryID !== parent.itemID || marker.instanceID !== parent.spaceState.dungeonSiteInstanceID ||
        before.quantity !== 1 || before.ownerID !== parent.ownerID || before.flagID !== 5) throw new Error("INCURSION_FACTORY_STOCK_INVALID");
    const after = items[key];
    if (after?.locationID === parent.itemID) continue;
    let destination = after;
    if (!destination) {
      // Stack merging may remove the source row. Accept only an independently
      // staged positive stock delta outside the factory, never deletion alone.
      destination = [...stagedRows.entries()].filter(([id, next]) => Number(id) > 0 && next?.typeID === 3501 &&
        next.locationID !== parent.itemID && next.ownerID > 1 &&
        Number(next.quantity) - Number(base[id]?.quantity || 0) >= 1).map(([, next]) => next)
        .sort((left, right) => left.itemID - right.itemID)[0];
    }
    if (!destination || destination.typeID !== 3501 || destination.ownerID <= 1 || !positive(destination.locationID) ||
        !positive(destination.itemID)) continue;
    const prior = base[LEDGER]?.[marker.productionKey];
    if (prior) continue;
    receipts.push({ version: VERSION, ...structuredClone(marker), itemID: before.itemID, quantity: 1,
      sourceOwnerID: before.ownerID, destinationOwnerID: destination.ownerID, destinationItemID: destination.itemID,
      destinationLocationID: destination.locationID, destinationFlagID: destination.flagID, atMs: atMs() });
  }
  if (!receipts.length) return [];
  const ledger = structuredClone(base[LEDGER] || {});
  for (const receipt of receipts) {
    if (!positive(receipt.atMs)) throw new Error("INCURSION_FACTORY_CLOCK_INVALID");
    ledger[receipt.productionKey] = receipt;
  }
  items[LEDGER] = ledger;
  return receipts.map(receipt => `/${LEDGER}/${receipt.productionKey}`);
}
module.exports = { VERSION, LEDGER, isFactory, stock, stageWithdrawals };
