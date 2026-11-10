"use strict";

// AIR owns the lesson journal; combat, inventory and clone owners own its effects.
const characters = require("../character/characterState");
const inventory = require("../inventory/itemStore");
const jobs = require("./airEncounterJobs");
const { graphError } = require("../nodegraph/nodeGraphCompiler");
const { cloneValue } = require("../../common/clone");
const events = require("../nodegraph/nodeGraphEvents");
const space = () => require("../../space/runtime");
const encounter = () => require("./airEncounterRuntime");
const ports = () => require("../dungeon/dungeonUniverseSiteService").airEncounterPorts;
const death = () => require("../../space/shipDestruction");
function ok(result) { if (!result?.success) throw graphError("AIR_COMBAT_OWNER_FAILED", result?.errorMsg); return result; }
function content() { return require("../dungeon/dungeonAuthority").getTemplateByID("evejs.air-tutorial:9105")?.airEncounter; }
function state(characterID) { return jobs.state(characterID)?.encounter?.combat || {}; }
function update(characterID, mutate) { jobs.update(characterID, value => { value.encounter.combat = mutate(value.encounter.combat || {}); return value; }); }
function context(session) { return encounter().scoped(session, 2433); }
function actors(scene, site) { return scene.getDynamicEntities().filter(entity => entity.airNpeOwnerCharacterID === site.ownership.characterID && entity.airNpeInstanceID === site.instanceID); }
function slot(scene, site, key) { return actors(scene, site).find(entity => entity.airEncounterSlot === key); }
function waveSpecs() {
  const contract = content();
  if (!contract?.initialHostiles?.length || !contract?.reinforcements?.length) throw graphError("AIR_COMBAT_CONTENT_REQUIRED");
  return [...contract.initialHostiles, ...contract.reinforcements];
}
function restore(session) {
  const characterID = Number(session.characterID), current = state(characterID);
  if (current.deaths?.pod?.status === "complete" || !session._space) return;
  const { scene, site } = context(session);
  for (const spec of waveSpecs()) {
    if (!current.waves?.[spec.wave] || current.destroyed?.[spec.key]) continue;
    ports().hostiles(scene, site, [spec]);
  }
}
function effect(session, target, typeID) {
  const ship = space().getSceneForSession(session)?.getShipEntityForSession(session);
  return [...ship?.activeModuleEffects?.values() || []].some(entry => Number(entry.targetID) === target?.itemID && Number(entry.moduleTypeID || inventory.findItemById(entry.moduleID)?.typeID) === typeID);
}
async function queueProgress(session, root = null) {
  const characterID = Number(session?.characterID), current = jobs.state(characterID);
  if (current?.status !== "active" || current.phaseGraphID !== 686) return;
  root ||= characters.getCharacterRecord(characterID)?.serverNodeGraphs?.[current.rootID];
  if (!root || root.ownerKey !== "air" || root.graphID !== 686 || root.stopped || root.activeTask !== "frigates_destroyed" || !evidence(session, "frigates_destroyed")) return;
  const { scene, site, ship } = context(session);
  // Client explosion listeners are transient and consume their first event.
  // Retain all native kills and reconcile the active lesson through a durable
  // job, including kills made before its client instruction subscribed.
  await jobs.enqueue(characterID, "combat-progress:frigates", 0, {
    rootID: root.instanceID, sceneKey: scene.sceneKey, instanceID: site.instanceID,
    shipID: ship.itemID, operationID: 2433,
  });
}
function evidence(session, task) {
  const characterID = Number(session.characterID), current = state(characterID), active = characters.getActiveShipRecord(characterID);
  if (task === "player_dead") return current.deaths?.pod?.status === "complete" && Number(characters.getCharacterRecord(characterID)?.stationID) === Number(current.deaths.pod.plan.homeStationID) && active?.itemID !== current.deaths.pod.plan.shipRecord.itemID;
  try {
    const { scene, site, entity, ship } = context(session);
    if (task === "player_in_pod") return current.deaths?.ship?.status === "complete" && active?.itemID === current.deaths.ship.capsuleID && inventory.isCapsuleTypeID(active.typeID) && scene.sceneKey === current.deaths.ship.sceneKey;
    if (ship.itemID !== jobs.state(characterID).encounter.boardingHullID || entity.mode === "WARP" || scene.hasQueuedWarpOrder(entity)) return false;
    if (task === "frigates_arrived") {
      const point = content().entryOffset;
      return jobs.state(characterID).encounter.fleetTransition?.status === "complete" && encounter().companionSpecs().every(spec => {
        const companion = slot(scene, site, spec.key);
        return companion && companion.mode !== "WARP" && !scene.hasQueuedWarpOrder(companion) &&
          Math.hypot(companion.position.x - site.position.x - point.x, companion.position.y - site.position.y - point.y, companion.position.z - site.position.z - point.z) <= 100000;
      });
    }
    if (task === "orbiting_balin") return entity.mode === "ORBIT" && Number(entity.targetEntityID) === slot(scene, site, "balin")?.itemID;
    if (task === "fleet_arrived") return current.waves?.initial && content().initialHostiles.every(spec => current.destroyed?.[spec.key] || Boolean(slot(scene, site, spec.key)));
    if (task === "frigates_destroyed") return content().initialHostiles.filter(spec => spec.typeID === 57801).every(spec => current.destroyed?.[spec.key]);
    if (task === "cruiser_destroyed") return Boolean(current.destroyed?.["hostile:cruiser"] && current.webbed);
    if (task === "player_engaged_battleship") return Boolean(current.battleshipDamaged && current.ecmActivated);
  } catch { return false; }
  return false;
}
function authorizeCommand(session, root, value) {
  if (root.graphID !== 686) return false;
  try {
    const { scene, site, ship } = context(session);
    if (ship.itemID !== jobs.state(root.characterID).encounter.boardingHullID) return false;
    if (value === "cruiser_webbed") return root.activeTask === "cruiser_destroyed" && (state(root.characterID).webbed || effect(session, slot(scene, site, "hostile:cruiser"), 30328));
    const condition = inventory.getShipConditionState(ship);
    return ["armor_damaged", "armor_healed"].includes(value) && ["frigates_destroyed", "cruiser_destroyed", "player_engaged_battleship"].includes(root.activeTask) && (value === "armor_damaged" ? condition.armorDamage > 0 : condition.armorDamage === 0);
  } catch { return false; }
}
async function message({ root, session, parameters: p }) {
  if (root.ownerKey !== "air" || root.graphID !== 686 || Number(session?.characterID) !== root.characterID) throw graphError("AIR_COMBAT_GRAPH_FORBIDDEN");
  const { characterID, scene, site, entity } = context(session);
  if (Number(p.dungeon_spawn_id) !== site.instanceID || Number(p.solar_system_id) !== scene.systemID) throw graphError("AIR_COMBAT_MESSAGE_SCOPE");
  if (p.message_key === "PLAYER_IN_ANOMALY_RANGE" && p.message_value === "True") return {};
  if (p.message_key === "SPAWN_UNIDENTIFIED_FLEET" && p.message_value === "True") {
    update(characterID, value => { value.waves ||= {}; value.waves.initial = true; return value; });
    restore(session);
    for (const spec of content().reinforcements) await jobs.enqueue(characterID, `reinforcement:${spec.key}`, spec.arrivalDelayMs, { sceneKey: scene.sceneKey, instanceID: site.instanceID, operationID: 2433, shipID: entity.itemID, rootID: root.instanceID, slot: spec.key });
    return {};
  }
  if (p.message_key === "FRIGATES_DESTROYED" && p.message_value === "True") { if (!evidence(session, "frigates_destroyed")) throw graphError("AIR_FRIGATES_ALIVE"); update(characterID, value => ({ ...value, stage: "cruiser" })); return {}; }
  if (p.message_key === "WEB_ACTIVATED" && p.message_value === "True") { if (!state(characterID).webbed) throw graphError("AIR_WEB_REQUIRED"); return {}; }
  if (p.message_key === "CRUISER_WEBBED" && p.message_value === "True") { if (!evidence(session, "cruiser_destroyed")) throw graphError("AIR_CRUISER_ALIVE"); return {}; }
  if (p.message_key === "ECM_ACTIVATED" && p.message_value === "True") { if (!evidence(session, "player_engaged_battleship")) throw graphError("AIR_BATTLESHIP_COMBAT_REQUIRED"); await acceptDeath(session, "ship", root, 60000); ports().attack(scene, [slot(scene, site, "hostile:battleship:0"), slot(scene, site, "hostile:battleship:1")], entity); return {}; }
  if (p.message_key === "PLAYER_IN_POD" && p.message_value === "True") { if (!evidence(session, "player_in_pod")) throw graphError("AIR_CAPSULE_HANDOFF_REQUIRED"); await acceptDeath(session, "pod", root, 8000); ports().attack(scene, [slot(scene, site, "hostile:battleship:0"), slot(scene, site, "hostile:battleship:1")], entity, false); return {}; }
  if (p.message_key === "BALIN_REPAIR_ARMOR" && ["True", "False"].includes(p.message_value)) {
    const balin = slot(scene, site, "balin"); if (!balin) throw graphError("AIR_BALIN_MISSING");
    if (p.message_value === "True") ok(ports().repair(scene, balin, entity));
    else for (const [moduleID] of balin.activeModuleEffects || []) scene.deactivateGenericModule({ characterID: 0, _space: { systemID: scene.systemID, shipID: balin.itemID }, sendNotification() {} }, moduleID, { reason: "air-repair-complete" });
    return {};
  }
  throw graphError("AIR_COMBAT_MESSAGE_UNSUPPORTED", p.message_key);
}
async function acceptDeath(session, kind, root, delayMs) {
  const { scene, site, entity, ship, characterID } = context(session);
  const previous = state(characterID).deaths?.[kind];
  if (!previous) {
    const key = `air:${jobs.state(characterID).runID}:death:${kind}`;
    const source = slot(scene, site, "hostile:battleship:0");
    if (!source || !slot(scene, site, "hostile:battleship:1")) throw graphError("AIR_LETHAL_PAIR_MISSING");
    const plan = death().prepareDurableShipDeath(entity, cloneValue(ship), key, scene, session);
    plan.airDeathKey = key;
    plan.cloneImplants = cloneValue(characters.getCharacterRecord(characterID).implants || []);
    ok(require("../../gameStore").flushTableSync("items"));
    update(characterID, value => { value.deaths ||= {}; value.deaths[kind] = { status: "accepted", plan, sceneKey: scene.sceneKey, source: { itemID: source.itemID, typeID: source.typeID, nativeNpc: true, ownerID: source.ownerID, corporationID: source.corporationID }, dueAtMs: jobs.now() + delayMs }; return value; });
  }
  await jobs.enqueue(characterID, `death:${kind}`, delayMs, { critical: true, characterID, kind, rootID: root.instanceID }, state(characterID).deaths[kind].dueAtMs);
}
function settleDeath(characterID, kind, session) {
  const record = state(characterID).deaths?.[kind];
  if (!record || record.status === "complete") return { success: true };
  const plan = record.plan, originalID = plan.shipRecord.itemID, scene = space().scenes.get(record.sceneKey), entity = scene?.getEntityByID(originalID);
  // An accepted receipt is irrevocable. It only names the original hull/pod.
  if (entity && session?._space?.shipID === originalID && characters.getActiveShipRecord(characterID)?.itemID === originalID) ok(death().destroySessionShip(session, { deathReceipt: plan, attackerEntity: record.source, destructionReason: "air-tutorial", sessionChangeReason: "combat" }));
  ok(death().finishDurableShipDeathHandoff(plan));
  const settled = ok(death().settleDurableShipDeath(plan));
  if (kind === "pod") ok(death().finishDurablePodDeath(plan, session));
  const killmail = require("../killmail/killmailState").createKillmailRecordIdempotent({ killTime: plan.destroyedAtFiletime, solarSystemID: plan.systemID, victimCharacterID: characterID, victimCorporationID: plan.victimCorporationID, victimAllianceID: plan.victimAllianceID, victimShipTypeID: plan.shipRecord.typeID, victimDamageTaken: 0, finalCharacterID: null, attackers: [{ characterID: null, corporationID: record.source.corporationID, shipTypeID: record.source.typeID, damageDone: 0, finalBlow: true }], items: plan.loot.items }, plan.key);
  if (!killmail?.killID) throw graphError("AIR_DEATH_KILLMAIL_FAILED");
  ok(require("../../gameStore").flushTablesSync(["items", "characters", "insuranceContracts", "notifications"]));
  if (scene?.getEntityByID(originalID)) scene.removeDynamicEntity(originalID, { broadcast: true });
  update(characterID, value => { value.deaths[kind] = { ...value.deaths[kind], status: "complete", killID: killmail.killID, debrisID: settled.data.debrisID, ...(kind === "ship" ? { capsuleID: characters.getActiveShipRecord(characterID)?.itemID } : {}) }; return value; });
  return { success: true };
}
async function handleJob(session, key, job) {
  if (key.startsWith("death:")) return settleDeath(job.characterID, job.kind, session);
  if (key === "combat-progress:frigates") {
    const root = characters.getCharacterRecord(Number(session?.characterID))?.serverNodeGraphs?.[job.rootID];
    if (!root || root.ownerKey !== "air" || root.graphID !== 686 || root.stopped || root.activeTask !== "frigates_destroyed") return { success: true, stale: true };
    let scope; try { scope = context(session); } catch { return { success: true, deferred: true }; }
    if (scope.scene.sceneKey !== job.sceneKey || scope.site.instanceID !== job.instanceID || scope.ship.itemID !== job.shipID) return { success: true, deferred: true };
    if (!evidence(session, "frigates_destroyed")) return { success: true, deferred: true };
    // Use the installed completion route and its ordinary authority checks.
    // A duplicate client acknowledgment can win first; the next job is stale.
    try {
      await require("../nodegraph/nodeGraphRuntime").processClientMessage(session, 753, root.instanceID, "client_complete_task", "frigates_destroyed");
    } catch (error) {
      const committed = characters.getCharacterRecord(root.characterID)?.serverNodeGraphs?.[root.instanceID];
      // The native client can win between our precheck and the serialized
      // graph dispatch. Only that committed transition makes a refusal stale.
      if (error.code !== "NODEGRAPH_TASK_FORBIDDEN" || !committed || committed.activeTask === "frigates_destroyed") throw error;
      return { success: true, stale: true };
    }
    return { success: true };
  }
  const { characterID, scene, site, entity } = context(session);
  if (entity.itemID !== job.shipID || scene.sceneKey !== job.sceneKey || site.instanceID !== job.instanceID || entity.mode === "WARP" || scene.hasQueuedWarpOrder(entity)) return { success: true, deferred: true };
  const spec = content().reinforcements.find(spec => spec.key === job.slot);
  if (!spec) throw graphError("AIR_REINFORCEMENT_SLOT_UNKNOWN");
  update(characterID, value => { value.waves ||= {}; value.waves[spec.wave] = true; return value; });
  if (!state(characterID).destroyed?.[spec.key]) ports().hostiles(scene, site, [spec]);
  return { success: true };
}
events.subscribe(async (session, event, details) => {
  if (event === "air.player-destroyed") {
    const characterID = Number(session?.characterID);
    const receipt = Object.entries(state(characterID).deaths || {}).find(([, entry]) => entry.status === "accepted" && entry.plan.key === details.key && !inventory.findItemById(entry.plan.shipRecord.itemID));
    if (receipt) {
      // Finish after the native caller reserves its actual combat killmail.
      // The original durable deadline remains the fallback if settlement fails.
      await Promise.resolve();
      settleDeath(characterID, receipt[0], session);
    }
    return;
  }
  if (!["air.weapon-damage", "air.npc-destroyed", "inventory.module-activated"].includes(event) || !session?._space) return;
  const characterID = Number(session.characterID), current = jobs.state(characterID);
  if (current?.status !== "active" || current.phaseGraphID !== 686) return;
  let scope; try { scope = context(session); } catch { return; }
  const target = details.target;
  if (!target || target.airNpeOwnerCharacterID !== characterID || target.airNpeInstanceID !== scope.site.instanceID || !target.airEncounterSlot?.startsWith("hostile:")) return;
  if (scope.ship.itemID !== current.encounter.boardingHullID) return;
  const proof = state(characterID);
  if (event === "air.weapon-damage" && (target.typeID !== 57803 || details.damage <= 0 || proof.battleshipDamaged)) return;
  if (event === "air.npc-destroyed" && proof.destroyed?.[target.airEncounterSlot]) return;
  if (event === "inventory.module-activated" && !(details.typeID === 30328 && target.typeID === 57802 && !proof.webbed || details.typeID === 1957 && target.typeID === 57803 && !proof.ecmActivated)) return;
  update(characterID, value => {
    if (event === "air.npc-destroyed") { value.destroyed ||= {}; value.destroyed[target.airEncounterSlot] = { typeID: target.typeID, itemID: target.itemID }; }
    if (event === "air.weapon-damage" && target.typeID === 57803 && details.damage > 0) value.battleshipDamaged = true;
    if (event === "inventory.module-activated" && details.typeID === 30328 && target.typeID === 57802) value.webbed = true;
    if (event === "inventory.module-activated" && details.typeID === 1957 && target.typeID === 57803) value.ecmActivated = true;
    return value;
  });
  if (event === "air.npc-destroyed") await queueProgress(session);
});
async function reconcileAccepted(characterID) {
  for (const [kind, entry] of Object.entries(state(characterID).deaths || {})) if (entry.status === "accepted") await jobs.enqueue(characterID, `death:${kind}`, 0, { critical: true, characterID, kind }, entry.dueAtMs);
}
jobs.registerRecovery(reconcileAccepted);
module.exports = { restore, evidence, authorizeCommand, message, handleJob, state, waveSpecs, reconcileAccepted, queueProgress };
