"use strict";

const state = require("./shipSkinState");
const authority = require("./shipSkinComponentAuthority");
const itemStore = require("../inventory/itemStore");
const custody = require("../inventory/itemCustody");
const characterState = require("../character/characterState");
const { createDurableSchedulerBinding } = require("../_shared/durableSchedulerBinding");
const TABLE_NAME = "shipSkinComponentRuntime";
const JOB_TYPE = "skinr.component-activation";
const binding = createDurableSchedulerBinding();
function read() {
  return { version: 1, finite: {}, infinite: {}, activations: {}, reservations: {}, ...state.read(TABLE_NAME) };
}
function save(root) { return state.write(TABLE_NAME, root); }
function key(characterID, componentID) { return `${characterID}:${componentID}`; }
function getOwnedShipSkinComponentLicenses(characterID) {
  const root = read();
  return { finite: Object.values(root.finite).filter(row => row.characterID === characterID && row.capacity > 0),
    infinite: Object.values(root.infinite).filter(row => row.characterID === characterID) };
}
function getFiniteShipSkinComponentLicense(characterID, componentID) {
  return read().finite[key(characterID, componentID)] || null;
}
function getInfiniteShipSkinComponentLicense(characterID, componentID) {
  return read().infinite[key(characterID, componentID)] || null;
}
function addLicense(root, characterID, componentID, licenseType, capacity = 0, snapshot = null) {
  const component = snapshot || authority.getShipSkinComponent(componentID) ||
    root.finite[key(characterID, componentID)] || root.infinite[key(characterID, componentID)];
  if (!component) throw new Error("SKINR_COMPONENT_NOT_FOUND");
  const collection = licenseType === "finite" ? root.finite : root.infinite;
  const id = key(characterID, componentID);
  const previous = collection[id];
  const nextCapacity = capacity + (previous?.capacity || 0);
  if (licenseType === "finite" && !state.positive(nextCapacity)) throw new Error("SKINR_CAPACITY_OVERFLOW");
  const record = { characterID, componentID, categoryID: component.categoryID,
    firstAcquiredMs: previous?.firstAcquiredMs || Date.now(),
    ...(licenseType === "finite" ? { capacity: nextCapacity } : {}) };
  collection[id] = record;
  return record;
}
function activationID(characterID, requestID) { return `component:${characterID}:${requestID}`; }
function pendingActivations(root, characterID, componentID) {
  return Object.values(root.activations).filter(operation => operation.state === "prepared" &&
    operation.characterID === characterID && operation.componentID === componentID);
}
function finiteCapacityIncludingIntents(root, characterID, componentID) {
  // Reserved uses remain refundable until sequencing commits. Pending physical
  // grants also already own capacity headroom, even before custody recovers.
  let total = BigInt(root.finite[key(characterID, componentID)]?.capacity || 0);
  for (const operation of pendingActivations(root, characterID, componentID)) {
    if (operation.licenseType === "finite") total += BigInt(operation.capacity);
  }
  for (const reservation of Object.values(root.reservations)) {
    if (reservation.characterID !== characterID || reservation.state !== "reserved") continue;
    for (const request of reservation.consumed) {
      if (request.componentID === componentID && request.licenseType === "finite") total += BigInt(request.quantity);
    }
  }
  return total;
}
function grantAllShipSkinComponentLicenses(characterID, finiteUses = 1000) {
  characterID = state.positive(characterID);
  finiteUses = state.positive(finiteUses);
  if (!characterID || !characterState.getCharacterRecord(characterID)) return state.fail("CHARACTER_REQUIRED", 401);
  if (!finiteUses) return state.fail("INVALID_COMPONENT_GRANT", 400);
  const components = authority.listShipSkinComponents();
  if (!components.length) return state.fail("SKINR_COMPONENT_CATALOG_EMPTY", 503);
  const root = read();
  const planned = [];
  let infiniteAlreadyOwned = 0;
  for (const component of components) {
    const licenseTypes = new Set((component.associatedItems || []).map(item => item.licenseType));
    if (licenseTypes.has("infinite")) {
      if (root.infinite[key(characterID, component.componentID)]) infiniteAlreadyOwned += 1;
      else {
        if (pendingActivations(root, characterID, component.componentID).some(operation => operation.licenseType === "infinite")) return state.fail("SKINR_ACTIVATION_PENDING");
        planned.push({ component, licenseType: "infinite", grantedCapacity: 0 });
      }
    }
    if (licenseTypes.has("finite")) {
      if (finiteCapacityIncludingIntents(root, characterID, component.componentID) + BigInt(finiteUses) > BigInt(Number.MAX_SAFE_INTEGER)) return state.fail("SKINR_CAPACITY_OVERFLOW", 400);
      planned.push({ component, licenseType: "finite", grantedCapacity: finiteUses });
    }
  }
  // Validate every component before committing the complete grant. Pending item
  // activations and refundable sequencing uses retain their capacity headroom.
  const grants = planned.map(({ component, licenseType, grantedCapacity }) => ({
    componentID: component.componentID, licenseType, grantedCapacity,
    license: addLicense(root, characterID, component.componentID, licenseType, grantedCapacity, component),
  }));
  if (grants.length) save(root);
  return { success: true, data: {
    infiniteGranted: grants.filter(grant => grant.licenseType === "infinite").length,
    infiniteAlreadyOwned,
    finiteGranted: grants.filter(grant => grant.licenseType === "finite").length,
    finiteUsesPerComponent: finiteUses,
    grants,
  } };
}
function settleActivation(id) {
  let root = read();
  let operation = root.activations[id];
  if (!operation) return state.fail("SKINR_ACTIVATION_NOT_FOUND", 404);
  if (operation.state === "completed") return { success: true, duplicate: true, ...state.cloneValue(operation.result) };
  if (operation.state === "refused") return state.fail(operation.errorMsg);
  const transfer = custody.transfer({
    items: { itemID: operation.itemID, quantity: operation.quantity },
    from: custody.custodyRef.ownerLocation(operation.characterID, operation.locationID, operation.flagID),
    to: custody.custodyRef.void(), actor: operation.characterID,
    reason: custody.CUSTODY_REASON.SKIN_COMPONENT_CONSUME, idempotencyKey: id,
  });
  if (!transfer.success) {
    if (transfer.ambiguous) throw new Error(transfer.errorMsg || "SKINR_CUSTODY_PENDING");
    root = read();
    root.activations[id] = { ...root.activations[id], state: "refused", errorMsg: transfer.errorMsg };
    save(root);
    return state.fail(transfer.errorMsg);
  }
  // The intent and custody receipt survive a kill here. Grant and completion
  // share one domain checkpoint; replay cannot add a second capacity grant.
  root = read();
  operation = root.activations[id];
  const license = addLicense(root, operation.characterID, operation.componentID,
    operation.licenseType, operation.capacity, { componentID: operation.componentID, categoryID: operation.categoryID });
  const result = { license, licenseType: operation.licenseType, componentID: operation.componentID, grantedCapacity: operation.capacity,
    inventoryChanges: transfer.data?.changes || [] };
  root.activations[id] = { ...operation, state: "completed", result };
  save(root);
  return { success: true, ...result };
}
function consumeShipSkinComponentItem(characterID, itemID, quantity, requestID) {
  if (!state.positive(characterID) || !characterState.getCharacterRecord(characterID)) return state.fail("CHARACTER_REQUIRED", 401);
  if (!state.positive(itemID) || !state.positive(quantity, 2147483647) || !state.requestKey(requestID)) return state.fail("INVALID_REQUEST", 400);
  const id = activationID(characterID, requestID);
  const root = read();
  const hash = state.fingerprint([characterID, itemID, quantity]);
  if (root.activations[id]) return root.activations[id].fingerprint === hash
    ? settleActivation(id) : state.fail("IDEMPOTENCY_KEY_REUSED");
  const item = itemStore.findItemById(itemID);
  if (!item || Number(item.ownerID) !== characterID) return state.fail("ITEM_NOT_FOUND", 404);
  if (![itemStore.ITEM_FLAGS.HANGAR, itemStore.ITEM_FLAGS.CARGO_HOLD].includes(Number(item.flagID))) return state.fail("SKINR_ITEM_LOCATION_UNAVAILABLE");
  const mapping = authority.getShipSkinComponentItemByTypeID(item.typeID);
  if (!mapping) return state.fail("ITEM_NOT_COMPONENT_LICENSE");
  const pending = pendingActivations(root, characterID, mapping.componentID);
  if (mapping.licenseType === "infinite" && pending.some(operation => operation.licenseType === "infinite")) return state.fail("SKINR_ACTIVATION_PENDING");
  if (mapping.licenseType === "infinite" && quantity !== 1) return state.fail("SKINR_INFINITE_QUANTITY_INVALID", 400);
  if (mapping.licenseType === "infinite" && root.infinite[key(characterID, mapping.componentID)]) return state.fail("SKINR_INFINITE_ALREADY_OWNED");
  const capacity = mapping.licenseType === "finite" ? quantity * mapping.licenseUsesGranted : 0;
  if (mapping.licenseType === "finite" && (!state.positive(capacity) ||
    finiteCapacityIncludingIntents(root, characterID, mapping.componentID) + BigInt(capacity) > BigInt(Number.MAX_SAFE_INTEGER))) return state.fail("SKINR_CAPACITY_OVERFLOW", 400);
  if (Number(item.stacksize ?? item.quantity) < quantity) return state.fail("INSUFFICIENT_ITEM_QUANTITY");
  root.activations[id] = { fingerprint: hash, characterID, itemID, quantity, state: "prepared",
    componentID: mapping.componentID, categoryID: mapping.categoryID, licenseType: mapping.licenseType, capacity,
    locationID: Number(item.locationID), flagID: Number(item.flagID) };
  save(root);
  return settleActivation(id);
}

function normalizeRequests(requests) {
  if (!Array.isArray(requests) || requests.length > 64) return null;
  const aggregated = new Map();
  for (const request of requests) {
    if (!state.positive(request?.componentID) || !state.positive(request?.quantity) ||
      !["finite", "infinite"].includes(request?.licenseType) || !authority.getShipSkinComponent(request.componentID)) return null;
    const id = `${request.licenseType}:${request.componentID}`;
    const row = aggregated.get(id) || { componentID: request.componentID, licenseType: request.licenseType, quantity: 0 };
    row.quantity += request.quantity;
    if (!state.positive(row.quantity)) return null;
    aggregated.set(id, row);
  }
  return [...aggregated.values()].sort((a, b) => a.componentID - b.componentID || a.licenseType.localeCompare(b.licenseType));
}
function reserveShipSkinComponentLicenses(characterID, requests, requestID) {
  const normalized = normalizeRequests(requests);
  if (!state.positive(characterID) || !normalized || !state.requestKey(requestID)) return state.fail("INVALID_REQUEST", 400);
  const root = read();
  const id = key(characterID, requestID);
  const hash = state.fingerprint(normalized);
  const previous = root.reservations[id];
  if (previous) {
    if (previous.fingerprint !== hash) return state.fail("IDEMPOTENCY_KEY_REUSED");
    if (previous.state === "released") return state.fail("SKINR_RESERVATION_FINALIZED");
    return { success: true, duplicate: true, data: previous };
  }
  for (const request of normalized) {
    const owned = (request.licenseType === "finite" ? root.finite : root.infinite)[key(characterID, request.componentID)];
    if (!owned || request.licenseType === "finite" && owned.capacity < request.quantity) return state.fail("COMPONENT_LICENSES_INSUFFICIENT");
  }
  for (const request of normalized) {
    if (request.licenseType === "finite") root.finite[key(characterID, request.componentID)].capacity -= request.quantity;
  }
  const reservation = { characterID, fingerprint: hash, state: "reserved", consumed: normalized };
  root.reservations[id] = reservation;
  save(root);
  return { success: true, data: reservation };
}
function finishReservation(characterID, requestID, nextState) {
  const root = read();
  const reservation = root.reservations[key(characterID, requestID)];
  if (!reservation) return state.fail("SKINR_RESERVATION_NOT_FOUND", 404);
  if (reservation.state === nextState) return { success: true, duplicate: true, data: reservation };
  if (reservation.state !== "reserved") return state.fail("SKINR_RESERVATION_FINALIZED");
  if (nextState === "released") {
    for (const request of reservation.consumed) {
      if (request.licenseType === "finite") addLicense(root, characterID, request.componentID, "finite", request.quantity);
    }
  }
  reservation.state = nextState;
  save(root);
  return { success: true, data: reservation };
}
async function reconcile() {
  for (const [id, operation] of Object.entries(read().activations)) {
    if (operation.state !== "prepared") continue;
    if (binding.get()) await binding.get().schedule({ jobID: `skinr:${id}`, type: JOB_TYPE, dueAtMs: Date.now(), payload: { id } });
    else settleActivation(id);
  }
}
function grantShipSkinComponentLicenseOnce(characterID, componentID, licenseType, quantity, receiptID) {
  const component = authority.getShipSkinComponent(componentID);
  if (!state.positive(characterID) || !state.requestKey(receiptID) || !state.positive(quantity) ||
      !component?.associatedItems.some(item => item.licenseType === licenseType)) return state.fail("INVALID_COMPONENT_GRANT", 400);
  const next = read(), fingerprint = state.fingerprint([characterID, componentID, licenseType, quantity]);
  next.storeGrants ||= {};
  if (next.storeGrants[receiptID]) return next.storeGrants[receiptID] === fingerprint ? { success: true, duplicate: true } : state.fail("COMPONENT_GRANT_CONFLICT");
  if (licenseType === "infinite" && next.infinite[key(characterID, componentID)]) return state.fail("INFINITE_LICENSE_ALREADY_OWNED");
  if (licenseType === "infinite" && pendingActivations(next, characterID, componentID).some(operation => operation.licenseType === "infinite")) return state.fail("SKINR_ACTIVATION_PENDING");
  if (licenseType === "finite" && finiteCapacityIncludingIntents(next, characterID, componentID) + BigInt(quantity) > BigInt(Number.MAX_SAFE_INTEGER)) return state.fail("COMPONENT_CAPACITY_OVERFLOW");
  addLicense(next, characterID, componentID, licenseType, quantity);
  next.storeGrants[receiptID] = fingerprint;
  save(next);
  return { success: true };
}
module.exports = { TABLE_NAME, JOB_TYPE, getOwnedShipSkinComponentLicenses, getFiniteShipSkinComponentLicense,
  grantShipSkinComponentLicenseOnce, grantAllShipSkinComponentLicenses,
  getInfiniteShipSkinComponentLicense, consumeShipSkinComponentItem, reserveShipSkinComponentLicenses,
  commitShipSkinComponentLicenses: (characterID, requestID) => finishReservation(characterID, requestID, "consumed"),
  rollbackShipSkinComponentLicenses: (characterID, requestID) => finishReservation(characterID, requestID, "released"),
  bindDurableScheduler: binding.bind, unbindDurableScheduler: binding.unbind, reconcile,
  handleJob: job => settleActivation(job.payload.id) };
