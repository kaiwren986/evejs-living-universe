"use strict";

// Both completed encounters and terminal tales withdraw through the existing
// native owner. Offline cleanup never creates a solar-system scene.
const { fail } = require("./incursionLifecycleContract");
function checked(result) {
  if (result?.success === false) fail(result.errorMsg || "INCURSION_TERMINAL_CLEANUP_PENDING");
  return result;
}
function retireActors(operation, nowMs, options = {}) {
  const store = require("../../space/npc/nativeNpcStore"), native = require("../../space/npc/nativeNpcService");
  const instance = require("../dungeon/dungeonRuntime").getInstance(operation.identity.instanceID);
  const runtime = require.cache[require.resolve("../../space/runtime")]?.exports;
  const scene = runtime?.scenes?.get(operation.identity.solarSystemID);
  const sealed = options.preserveCombatDeaths
    ? require("./incursionRewardStore").getOperation(operation.identity.operationID) : null;
  let removed = 0;
  for (const record of store.listNativeEntitiesForSystem(operation.identity.solarSystemID)) {
    if (Number(record.dungeonSiteInstanceID) !== operation.identity.instanceID) continue;
    if (options.includePreparing === true) {
      const actor = require("./incursionSiteModel").actorDeclaration(operation, record.dungeonSiteContentKey);
      if (!instance || !actor || record.incursionOperationID && record.incursionOperationID !== operation.identity.operationID ||
          record.transient !== false || record.dungeonMaterializedSiteContent !== true ||
          !["required_actor_preparing", "required_actor"].includes(record.dungeonSiteContentRole) ||
          Number(record.dungeonSiteID) !== Number(instance.metadata.siteID) || Number(record.typeID) !== actor.typeID ||
          Number(record.ownerID) !== actor.ownerID || record.profileID !== actor.profileID) fail("INCURSION_ACTOR_CLEANUP_SCOPE_INVALID");
      const live = scene?.getEntityByID(record.entityID);
      if (live && (live.nativeNpc !== true || Number(live.typeID) !== Number(record.typeID) || Number(live.ownerID) !== Number(record.ownerID) ||
          Number(live.dungeonSiteInstanceID) !== operation.identity.instanceID || live.dungeonSiteContentKey !== record.dungeonSiteContentKey ||
          live.incursionOperationID && live.incursionOperationID !== operation.identity.operationID)) fail("INCURSION_ACTOR_CLEANUP_LIVE_SCOPE_INVALID");
    } else if (record.incursionOperationID !== operation.identity.operationID) continue;
    const retirement = sealed?.retirements?.[record.dungeonSiteContentKey];
    if (options.preserveInFlightDamage && require("./incursionHooks").isDamageInProgress(scene?.getEntityByID?.(record.entityID))) continue;
    // A final lethal hit can seal completion before its native wreck owner
    // runs. Keep that committed death in the live owner until it finishes.
    if ((sealed?.receiptID || sealed?.failure) && retirement?.reason === "destroyed" && retirement.entityID === record.entityID && retirement.typeID === record.typeID &&
        Number(scene?.getEntityByID?.(record.entityID)?.conditionState?.damage) >= 1) continue;
    // Independently committed deaths publish their frozen wreck before their
    // native body is deleted, without materializing an offline scene.
    const death = checked(require("../../space/npc/incursionDeathWrecks").publish(record));
    if (instance) checked(native.retireRequiredDungeonActor(record, "incursion-withdrawal", nowMs));
    // Dematerialization is allowed only in an already loaded scene. Offline
    // cleanup must never wake a separate solar-system simulation.
    if (scene) checked(native.dematerializeNativeController({ entityID: record.entityID,
      systemID: operation.identity.solarSystemID }, { persistState: false, broadcast: true }));
    checked(store.removeNativeEntityCascade(record.entityID));
    if (scene) checked(require("../../space/npc/nativeNpcWreckService").projectIncursionDeathWreck(scene, death));
    removed++;
  }
  return removed;
}
module.exports = { retireActors };
