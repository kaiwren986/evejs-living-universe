"use strict";

const runtime = require("../../../space/runtime");
const items = require("../../inventory/itemStore");
const sessions = require("../sessionRegistry");
const { canEntitiesInteractLocally } = require("../../../space/destiny/identity/interactionScope");
const { isInventoryBackedDynamicEntity } = require("../../../space/runtime/inventorySpaceEntity");
const { hasStaffDebugRole } = require("./commandAccess");
const { handledResult } = require("./commandReplies");
const { finishNativeGmCompanionRetirement } = require("./nativeCompanionRetirement");

// The names and values used by svc_slash.py's WorldMod cleanup macros.
const FILTERS = Object.freeze({
  categorydrone: ["categoryID", 18], categoryfighter: ["categoryID", 87],
  groupwreck: ["groupID", 186], groupcargocontainer: ["groupID", 12],
  groupfreightcontainer: ["groupID", 649], groupsecurecargocontainer: ["groupID", 340],
  groupauditlogsecurecontainer: ["groupID", 448],
});

function retireEntity(session, scene, entity) {
  const id = Number(entity.itemID);
  if (!Number.isSafeInteger(id) || id <= 0) return { success: false, errorMsg: "UNSUPPORTED_ENTITY_ID" };
  if (sessions.getSessions().some((pilot) => Number(pilot?._space?.shipID) === id) ||
      Number(session._space.shipID) === id) return { success: false, errorMsg: "OCCUPIED_SHIP" };
  if (entity.nativeNpc === true) {
    return require("../../../space/npc/npcService").destroyNpcControllerByEntityID(id, { scene, broadcast: true });
  }
  if (entity.nativeNpcWreck === true) return require("../../../space/npc/nativeNpcWreckService").destroyNativeWreck(id, { scene, broadcast: true });
  if (isInventoryBackedDynamicEntity(entity)) return scene.destroyInventoryBackedDynamicEntity(id, { actor: session.characterID, reason: "gm-unspawn" });
  const stored = items.findItemById(id);
  if (stored) {
    if (entity.kind !== "ship" || Number(stored.flagID) !== 0 || Number(stored.locationID) !== Number(scene.locationID || scene.systemID)) {
      return { success: false, errorMsg: "UNSUPPORTED_UNSPAWN_CUSTODY" };
    }
    const custody = require("../../inventory/itemCustody");
    const result = custody.transfer({ items: { itemID: id },
      from: custody.custodyRef.inSpace(stored.ownerID, stored.locationID, stored.spaceState),
      to: custody.custodyRef.void(), reason: custody.CUSTODY_REASON.SPACE_ENTITY_DESTROY,
      actor: session.characterID, idempotencyKey: `gm-unspawn:${id}`, options: { removeContents: true } });
    if (!result.success) return result;
  }
  scene.unregisterDynamicEntity(entity, { persistSpaceState: false });
  return { success: true };
}

function handleUnspawnCommand(session, argumentText, chatHub, options) {
  const reply = (message) => handledResult(chatHub, session, options, message);
  if (!hasStaffDebugRole(session)) return reply("/unspawn requires a staff/admin role.");
  const scene = runtime.getSceneForSession(session), ego = scene && scene.getShipEntityForSession(session);
  if (!ego) return reply("Enter space before using /unspawn.");
  const text = String(argumentText || "").trim();
  let targets;
  if (/^\d+$/.test(text) && Number.isSafeInteger(Number(text))) {
    const entity = scene.dynamicEntities.get(Number(text));
    targets = entity && canEntitiesInteractLocally(ego, entity) ? [entity] : [];
  } else {
    const tokens = text.split(/\s+/), values = new Map();
    for (const token of tokens) {
      const match = /^(range|only)=(\S+)$/i.exec(token);
      if (!match || values.has(match[1].toLowerCase())) return reply("Usage: /unspawn <entityID> or /unspawn range=<meters> only=<category/group names>");
      values.set(match[1].toLowerCase(), match[2]);
    }
    const range = Number(values.get("range"));
    const filters = String(values.get("only") || "").toLowerCase().split(",").map((name) => FILTERS[name]);
    if (!Number.isFinite(range) || range <= 0 || !filters.length || filters.some((filter) => !filter)) {
      return reply("Usage: /unspawn <entityID> or /unspawn range=<meters> only=<category/group names>");
    }
    targets = scene.getVisibleEntitiesForSession(session).filter((entity) =>
      scene.dynamicEntities.get(entity.itemID) === entity && entity !== ego &&
      canEntitiesInteractLocally(ego, entity) &&
      filters.some(([field, value]) => Number(entity[field]) === value) &&
      Math.hypot(entity.position.x - ego.position.x, entity.position.y - ego.position.y, entity.position.z - ego.position.z) <= range);
  }
  let count = 0;
  const refused = [];
  for (const entity of targets) {
    const result = finishNativeGmCompanionRetirement(scene, entity, retireEntity(session, scene, entity));
    if (result.success) count++;
    else refused.push(`${entity.itemID}: ${result.errorMsg}`);
  }
  return reply(`Unspawned ${count} entities.${refused.length ? ` Refused ${refused.length}: ${refused.join(", ")}.` : ""}`);
}

module.exports = { handleUnspawnCommand };
