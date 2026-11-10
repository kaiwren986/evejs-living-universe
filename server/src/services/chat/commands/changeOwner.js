"use strict";

const runtime = require("../../../space/runtime");
const items = require("../../inventory/itemStore");
const { buildSpaceLootRightsSnapshot, readSpaceLootInfo } = require("../../_shared/spaceLootEntitlement");
const { getCharacterRecord } = require("../../character/characterState");
const { isCargoContainerType } = require("../../ship/cargoContainerRuntime");
const { canEntitiesInteractLocally } = require("../../../space/destiny/identity/interactionScope");
const { buildOwnerTransferIdempotencyKey } = require("../../inventory/invBroker/ownerTransferIdempotencyKey");
const { syncInventoryChangesToSession } = require("./commandInventorySync");
const { hasStaffDebugRole } = require("./commandAccess");
const { handledResult } = require("./commandReplies");

function handleChangeOwnerCommand(session, argumentText, chatHub, options) {
  const reply = (message) => handledResult(chatHub, session, options, message);
  if (!hasStaffDebugRole(session)) return reply("/chowner requires a staff/admin role.");
  const match = /^(\d+)\s+(\d+)$/.exec(String(argumentText || "").trim());
  if (!match || !match.slice(1).every((value) => Number.isSafeInteger(Number(value)) && Number(value) > 0)) {
    return reply("Usage: /chowner <containerID> <characterID>");
  }
  const [, rawID, rawOwner] = match, id = Number(rawID), ownerID = Number(rawOwner);
  const owner = getCharacterRecord(ownerID);
  if (!owner) return reply("Destination character not found.");
  const scene = runtime.getSceneForSession(session), ego = scene && scene.getShipEntityForSession(session);
  const entity = scene && scene.dynamicEntities.get(id), item = items.findItemById(id);
  if (ego && entity?.nativeNpcWreck === true && canEntitiesInteractLocally(ego, entity)) {
    const previousOwnerID = entity.ownerID;
    const result = require("../../../space/npc/nativeNpcWreckService").transferNativeWreckOwnership(id, { ...owner, ownerID },
      { scene, actorID: session.characterID, operationID: buildOwnerTransferIdempotencyKey() });
    if (!result.success) return reply(`Ownership change refused: ${result.errorMsg}.`);
    const recipients = new Set([session, ...require("../sessionRegistry").getSessions().filter((pilot) =>
      Number(pilot.characterID) === Number(previousOwnerID) || Number(pilot.characterID) === ownerID)]);
    for (const recipient of recipients) syncInventoryChangesToSession(recipient, result.data.changes);
    return reply(`Changed owner of ${id} and its contents to ${ownerID}.`);
  }
  // This is the native gridutils loot-container operation. Other object owners
  // (deployables and occupied ships) need their own transfer reducers.
  if (!ego || !entity || !canEntitiesInteractLocally(ego, entity) || !item ||
      (!isCargoContainerType(item) && Number(item.groupID) !== 186) ||
      Number(item.flagID) !== 0 || Number(item.locationID) !== Number(scene.locationID || scene.systemID)) {
    return reply("Only local inventory-backed loot containers and wrecks support /chowner.");
  }
  if (Number(item.ownerID) === ownerID) return reply(`Item ${id} already belongs to ${ownerID}.`);
  const custody = require("../../inventory/itemCustody");
  const result = require("../../inventory/deliveryItemCustody").transferItem({
    item, ownerID, locationID: item.locationID, flagID: item.flagID,
    actor: session.characterID, reason: custody.CUSTODY_REASON.INV_BROKER_OWNER_TRANSFER,
    idempotencyKey: buildOwnerTransferIdempotencyKey(),
    ownerTransferLootInfo: buildSpaceLootRightsSnapshot({
      corporationID: owner.corporationID, allianceID: owner.allianceID, warFactionID: owner.warFactionID,
      // Explicit abandonment survives an owner edit, as it does for native
      // wrecks; the previous owner's fleet grant does not.
      abandoned: readSpaceLootInfo(item.customInfo).abandoned === true, lootRightFleetID: null,
    }),
  });
  if (!result.success) return reply(`Ownership change refused: ${result.errorMsg}.`);
  // The custody owner recursively transfers contents and records the acting GM.
  // Only publish after that durable transition has succeeded.
  scene.broadcastSlimItemChanges([entity]);
  const recipients = new Set([session, ...require("../sessionRegistry").getSessions().filter((pilot) =>
    Number(pilot.characterID) === Number(item.ownerID) || Number(pilot.characterID) === ownerID)]);
  for (const recipient of recipients) syncInventoryChangesToSession(recipient, result.data.changes);
  return reply(`Changed owner of ${id} and its contents to ${ownerID}.`);
}

module.exports = { handleChangeOwnerCommand };
