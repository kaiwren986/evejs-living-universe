"use strict";

const path = require("path");
const log = require(path.join(__dirname, "../../utils/logger"));
const {
  MachoWrappedException,
  buildUserErrorPayload,
  isMachoWrappedException,
} = require(path.join(__dirname, "../../common/machoErrors"));
const modern = require("./sovModernState");
const orbitalState = require("../planet/planetOrbitalState");
const { peekCharacterRecord, syncInventoryItemForSession } = require("../character/characterState");
const { getAccessGroup } = require("../bookmark/bookmarkRuntimeState");
const { findItemById, listContainerItems, getItemMetadata, ITEM_FLAGS,
  grantItemToOwnerLocationIdempotent, getIdempotentGrantReceipt } = require("../inventory/itemStore");
const { getShipFittingSnapshot } = require("../../_secondary/fitting/fittingRuntime");
const { getSpecialShipHoldCapacity } = require("../inventory/specialShipHoldRegistry");
const { getShipBaseAttributeValue } = require("../fitting/liveFittingState");
const publicGatewayNotices = require("../../_secondary/express/publicGatewayNotices");

// Sends to open gateway streams; there are none until the public gateway has loaded.
function publishGatewayNotice(noticeTypeName, payloadBuffer, targetGroup) {
  const gateway = publicGatewayNotices.getPublicGateway();
  if (gateway) gateway.publishGatewayNotice(noticeTypeName, payloadBuffer, targetGroup);
}

function identityFor(session) {
  const characterID = Number(session && (session.characterID || session.charid));
  const character = peekCharacterRecord(characterID);
  return character && !character.deletedAt && !character.isDeleted ? {
    characterID, corporationID: Number(character.corporationID),
    allianceID: Number(character.allianceID),
    solarSystemID: Number(session.solarsystemid2 || session.solarsystemid),
  } : null;
}

function isCharacterAuthorised(session, skyhookID) {
  const identity = identityFor(session);
  if (!identity) return false;
  const orbital = orbitalState.getOrbitalByID(skyhookID);
  const result = modern.getSkyhook(skyhookID, identity);
  if (!result.ok || orbital && orbital.destroyedAtMs) return false;
  if (identity.corporationID === result.skyhook.corporationID) return true;
  const group = orbital && orbital.aclGroupID && getAccessGroup(orbital.aclGroupID);
  return isOnTakeAccessList(group, identity);
}

function isOnTakeAccessList(group, identity) {
  if (!group) return false;
  if (Number(group.creatorID) === identity.characterID) return true;
  // More specific entries override inherited corporation/alliance/public access.
  for (const subject of [identity.characterID, identity.corporationID, identity.allianceID, 0]) {
    if (!Number.isFinite(subject)) continue;
    const membership = group.membershipTypes && group.membershipTypes[String(subject)];
    if (membership !== undefined) return [0, 1, 2].includes(Number(membership));
    if ((group.admins || []).includes(subject) || (group.members || []).includes(subject)) return true;
  }
  return false;
}

function publishReagents(skyhook) {
  const { buildSkyhookSimulationPayload } = require("../../_secondary/express/gatewayServices/sovereigntyGatewayService");
  const { getSovereigntyProtoTypes } = require("./sovGatewayProto");
  const type = getSovereigntyProtoTypes().skyhookReagentSimulationsNotice;
  const payload = {
    skyhook: { sequential: skyhook.skyhookID }, planet: { sequential: skyhook.planetID },
    simulations: skyhook.reagentSimulations.map(buildSkyhookSimulationPayload),
  };
  publishGatewayNotice(
    "eve_public.sovereignty.skyhook.api.ReagentSimulationsNotice",
    Buffer.from(type.encode(type.fromObject(payload)).finish()),
    { solar_system: skyhook.solarSystemID },
  );
}

function publishSkyhookState(solarSystemID) {
  const { buildSkyhookNoticePayload } = require("../../_secondary/express/gatewayServices/sovereigntyGatewayService");
  const { getSovereigntyProtoTypes } = require("./sovGatewayProto");
  const type = getSovereigntyProtoTypes().skyhookAllInSolarSystemNotice;
  const payload = { solar_system: { sequential: solarSystemID },
    skyhooks: modern.listLocalSkyhooks({ solarSystemID }).skyhooks.map(buildSkyhookNoticePayload) };
  publishGatewayNotice(
    "eve_public.sovereignty.skyhook.api.AllInSolarSystemNotice",
    Buffer.from(type.encode(type.fromObject(payload)).finish()), { solar_system: solarSystemID },
  );
}

// The client shows its "extraction failed" message only when this call raises,
// and the dispatcher answers a plain Error with an empty reply, so every refusal
// is a wrapped user error. The reason stays on the error for logs and tests; the
// client never sees it.
function refusal(message, reason, values = {}) {
  const error = new MachoWrappedException(buildUserErrorPayload(message, values));
  error.reason = reason;
  return error;
}

// A reservation left by a failed grant or a crash is settled from its grant
// receipt before anything new is reserved. A receipt means the cargo arrived;
// no receipt means it never did, so the stock goes back to the bay.
function settleLeftoverReservation(skyhookID) {
  const pending = modern.getPendingSkyhookExtraction(skyhookID);
  if (!pending) return;
  const receipt = getIdempotentGrantReceipt(pending.receiptKey, { requireDurable: true });
  if (!receipt.success) {
    throw refusal("SkyhookExtractionFailed", receipt.errorMsg || "SKYHOOK_RECEIPT_UNKNOWN");
  }
  modern.releaseSkyhookExtraction(skyhookID, pending.receiptKey, { returnStock: !receipt.found });
}

function extractReagentsToShip(session, skyhookID, flagID, quantity) {
  try {
    return extractOrRefuse(session, Number(skyhookID), Number(flagID), Number(quantity));
  } catch (error) {
    if (isMachoWrappedException(error)) throw error;
    log.warn(`[SkyhookRuntime] Extraction failed skyhook=${skyhookID}: ${error && error.message}`);
    throw refusal("SkyhookExtractionFailed", error && error.message || "SKYHOOK_EXTRACTION_FAILED");
  }
}

function extractOrRefuse(session, skyhookID, flagID, quantity) {
  if (!isCharacterAuthorised(session, skyhookID)) throw refusal("SkyhookExtractionFailed", "SKYHOOK_ACCESS_DENIED");
  const identity = identityFor(session);
  const shipID = Number(session._space && session._space.shipID);
  const ship = findItemById(shipID);
  const item = findItemById(skyhookID);
  const runtime = require("../../space/runtime");
  const { MAX_CARGO_CONTAINER_TRANSFER_DISTANCE_METERS } = require("../ship/cargoContainerRuntime");
  const shipEntity = ship && runtime.getEntity(session, shipID);
  const skyhookEntity = item && runtime.getEntity(session, skyhookID);
  if (!ship || ship.ownerID !== identity.characterID || !shipEntity || !skyhookEntity ||
      item.locationID !== identity.solarSystemID || ship.locationID !== identity.solarSystemID) {
    throw refusal("GenericTooFarAway", "SKYHOOK_OUT_OF_RANGE");
  }
  const distance = Math.hypot(...["x", "y", "z"].map((axis) =>
    Number(shipEntity.position[axis]) - Number(skyhookEntity.position[axis]))) -
    Number(shipEntity.radius || 0) - Number(skyhookEntity.radius || 0);
  // TargetTooFar is the module-activation message; sent without a module and
  // a distance, the client printed its raw template.
  if (!Number.isFinite(distance)) {
    throw refusal("GenericTooFarAway", "SKYHOOK_OUT_OF_RANGE");
  }
  if (distance > MAX_CARGO_CONTAINER_TRANSFER_DISTANCE_METERS) {
    throw refusal("CantUseTooDistantWithType", "SKYHOOK_OUT_OF_RANGE", {
      desired: MAX_CARGO_CONTAINER_TRANSFER_DISTANCE_METERS,
      actual: Math.round(distance),
      typeID: Number(item.typeID),
    });
  }
  if (![ITEM_FLAGS.CARGO_HOLD, ITEM_FLAGS.COLONY_RESOURCES_HOLD].includes(flagID) ||
      !Number.isSafeInteger(quantity) || quantity <= 0) {
    throw refusal("SkyhookExtractionFailed", "INVALID_EXTRACTION");
  }
  const snapshot = getShipFittingSnapshot(identity.characterID, shipID, { shipItem: ship, reason: "skyhook.extract" });
  const resources = snapshot && snapshot.resourceState || {};
  const capacity = flagID === ITEM_FLAGS.CARGO_HOLD ? Number(resources.cargoCapacity || 0) :
    getSpecialShipHoldCapacity(resources, ship.typeID, flagID, getShipBaseAttributeValue);
  const state = modern.getSkyhook(skyhookID, identity).skyhook;
  const reagent = state && state.reagentDefinitions[0];
  if (!reagent) throw refusal("SkyhookExtractionFailed", "SKYHOOK_NO_REAGENTS");
  settleLeftoverReservation(skyhookID);
  const used = listContainerItems(identity.characterID, shipID, flagID).reduce((sum, entry) =>
    sum + Number(entry.volume || getItemMetadata(entry.typeID).volume || 0) * Math.max(1, Number(entry.stacksize || entry.quantity || 1)), 0);
  const volume = Number(getItemMetadata(reagent.reagentTypeID).volume);
  if (!(volume > 0) || used + volume * quantity > capacity + 1e-8) {
    throw refusal("SkyhookExtractionFailed", "NOT_ENOUGH_CARGO_SPACE");
  }
  const result = modern.extractSkyhookReagents(skyhookID, quantity,
    { characterID: identity.characterID, shipID, flagID }, (pending) =>
      grantItemToOwnerLocationIdempotent(pending.characterID, pending.shipID, pending.flagID,
        pending.typeID, pending.quantity, { receiptKey: pending.receiptKey }));
  for (const change of result.granted.data && result.granted.data.changes || []) {
    syncInventoryItemForSession(session, change.item || findItemById(change.itemID), change.previousState || {});
  }
  publishReagents(result.skyhook);
  return result.quantity;
}

module.exports = { isCharacterAuthorised, extractReagentsToShip, isOnTakeAccessList, publishSkyhookState, publishReagents };
