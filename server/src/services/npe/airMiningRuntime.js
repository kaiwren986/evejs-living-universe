"use strict";

const characters = require("../character/characterState");
const inventory = require("../inventory/itemStore");
const dungeon = require("../dungeon/dungeonRuntime");
const authority = require("../dungeon/dungeonAuthority");
const extraction = require("../mining/airMiningSettlement");
const { graphError } = require("../nodegraph/nodeGraphCompiler");
const { cloneValue: clone } = require("../../common/clone");
const TEMPLATE_ID = "evejs.air-tutorial:9245";
const ROCK_IDS = Object.freeze([1114285, 1114286, 1114287]);
const WRECK_OBJECT_ID = 1114288;
// Scene 2.1.01 counts the pilot as arrived only within 5,000 km of the client's
// "2.1._beacon_item_id", and steps 2.1.02-2.1.05 run only while that check passes. The site
// entity (entry_item_id_mining_dungeon) is shown only in the pilot's bubble, ~265 km from the
// warp-in point, so the client never has that ball. The site's big asteroid (this dungeon
// object, same spot as the site entity) is visible site-wide (content pack 1.0.4).
const BEACON_OBJECT_ID = 1114302;
const LOOT_BOX_TYPE_ID = 60784;
const ports = () => require("../dungeon/dungeonUniverseSiteService").airMiningPorts;
const runtime = () => require("../../space/runtime");
function ok(result) { if (!result?.success) throw graphError("AIR_MINING_ACTION_FAILED", result?.errorMsg); return result; }
function saveCharacter(characterID, state) {
  ok(characters.updateCharacterRecord(characterID, record => ({ ...record, authoredAirTutorial: clone(state) })));
  ok(require("../../gameStore").flushTableSync("characters"));
}
function siteFor(characterID) {
  const state = characters.getCharacterRecord(characterID)?.authoredAirTutorial;
  const site = state?.miningInstanceID && dungeon.getInstance(state.miningInstanceID);
  return site?.ownership?.characterID === characterID && site.templateID === TEMPLATE_ID && site.metadata?.operationKey === `air:${state.runID}:mining` && site.lifecycleState === "active" ? site : null;
}
function entities(scene, site) {
  return [...(scene?.staticEntitiesByID?.values() || []), ...(scene?.getDynamicEntities() || [])].filter(entity => entity.dungeonSiteInstanceID === site.instanceID);
}
function object(scene, site, objectID) { return entities(scene, site).find(entity => Number(entity.dunObjectID || entity.dungeonSourceObjectID) === Number(objectID)) || null; }
function beaconID(characterID) {
  const site = siteFor(characterID);
  return Number(site && object(runtime().scenes.get(site.solarSystemID), site, BEACON_OBJECT_ID)?.itemID) || null;
}
// The wreck can come back with a new item ID after the site was rebuilt or the server
// restarted. Graph values saved before still name the old one; they mean the current wreck.
function currentItemID(characterID, itemID) {
  const state = characters.getCharacterRecord(characterID)?.authoredAirTutorial;
  return state?.miningRetiredWreckIDs?.includes(Number(itemID)) && state.miningWreckID ? state.miningWreckID : Number(itemID);
}
// Step 2.1.05 wants the box from the site's wreck. Keep the remembered box while it still
// exists (in a station, or in a container or ship that still exists); otherwise the wreck was
// re-created, and EveJS seeds a site's loot only once, so a re-created wreck is empty: put the
// box back and remember that one.
function lootBoxIDs(state, wreckID) {
  const reachable = (id) => {
    const item = inventory.findItemById(id);
    return Boolean(item && (Number(item.locationID) < 1e9 || inventory.findItemById(item.locationID)));
  };
  if (state.miningSourceItemIDs?.some(reachable)) return state.miningSourceItemIDs;
  const boxes = () => inventory.listContainerItems(null, wreckID).filter(item => item.typeID === LOOT_BOX_TYPE_ID).map(item => item.itemID);
  if (!boxes().length) ok(inventory.grantItemsToOwnerLocation(1, wreckID, 5, [{ itemType: LOOT_BOX_TYPE_ID, quantity: 1 }]));
  return boxes();
}
function persist(site, updates) {
  dungeon.mergeSpawnState(site.instanceID, { airMining: { ...clone(dungeon.getInstance(site.instanceID).spawnState.airMining || {}), ...updates } });
  ok(require("../../gameStore").flushTableSync("dungeonRuntimeState"));
}
function purgeSite(characterID) {
  const site = siteFor(characterID);
  if (!site) return;
  extraction.reconcile(site.instanceID);
  const scene = runtime().scenes.get(site.solarSystemID);
  for (const actor of entities(scene, site).filter(entity => entity.airMiningActorKey)) {
    if (actor.airMiningFxTarget) scene.broadcastSpecialFx(actor.itemID, "effects.Mining", { targetID: actor.airMiningFxTarget, start: 0, active: 0 }, actor);
    ok(ports().remove(scene, actor, { broadcast: true, suppressWreck: true, reason: "air-cleanup" }));
  }
  ok(require("../dungeon/dungeonUniverseSiteService").purgePrivateOperationForCharacter(characterID, site.instanceID, site.metadata.operationKey));
  ok(require("../../gameStore").flushTableSync("dungeonRuntimeState"));
  require("../dungeon/operationSiteRuntime").removeOperationSpawnpointRecord(characterID, 2674);
}
function ensureSite(session, state, root = null) {
  if (!session._space) return state;
  let site = siteFor(state.characterID);
  if (state.miningInstanceID && !site) throw graphError("AIR_MINING_INSTANCE_STALE");
  if (site && site.solarSystemID !== Number(session.solarsystemid2 || session.solarsystemid)) throw graphError("AIR_MINING_SYSTEM_STALE");
  if (site) extraction.reconcile(site.instanceID);
  const result = ok(require("../dungeon/dungeonUniverseSiteService").spawnTemplateForSession(session, TEMPLATE_ID, {
    operationKey: `air:${state.runID}:mining`, broadcast: false, spawnEncounters: false,
    // 7 AU out, on the pilot's own lane (operationSiteRuntime.pilotLanePosition).
    markCurrentDungeonRoom: false,
    position: state.miningPosition || require("../dungeon/operationSiteRuntime").pilotLanePosition(session, 7 * 149597870700), spawnOffsetMeters: 7 * 149597870700,
  }));
  site = dungeon.getInstance(result.data.instance.instanceID);
  state.miningInstanceID = site.instanceID; state.miningPosition = site.position; state.miningSystemID = site.solarSystemID;
  // Skip must find an owned instance even when later actor creation fails.
  // Commit the site's inventory and runtime before publishing its pointer.
  ok(require("../../gameStore").flushTableSync("items"));
  ok(require("../../gameStore").flushTableSync("dungeonRuntimeState"));
  saveCharacter(state.characterID, state);
  const scene = runtime().getSceneForSession(session);
  ports().scope(scene, site);
  const template = authority.getTemplateByID(TEMPLATE_ID);
  if (!template?.airEncounter?.mining) throw graphError("AIR_MINING_CONTENT_VERSION_REQUIRED");
  ports().actors(scene, site, template.airEncounter.actors);
  const wreck = object(scene, site, WRECK_OBJECT_ID);
  if (!wreck) throw graphError("AIR_MINING_WRECK_MISSING");
  if (state.miningWreckID && state.miningWreckID !== wreck.itemID) {
    state.miningRetiredWreckIDs = [...new Set([...(state.miningRetiredWreckIDs || []), state.miningWreckID])].slice(-8);
  }
  state.miningWreckID = wreck.itemID;
  state.miningSourceItemIDs = lootBoxIDs(state, wreck.itemID);
  // Rebuild the graph's presentation policy before any resumed action or
  // native acquisition. The durable extraction ledger decides depletion.
  extraction.reconcile(site.instanceID, scene);
  const checkpoint = Number(characters.getCharacterRecord(state.characterID).serverNodeGraphCheckpoints?.[49]);
  const activeObjectID = ({ 50: ROCK_IDS[0], 51: ROCK_IDS[0], 52: ROCK_IDS[1], 56: ROCK_IDS[2] })[checkpoint];
  for (const id of ROCK_IDS) {
    const rock = object(scene, site, id);
    if (rock) ports().targetable(scene, rock, id === activeObjectID);
  }
  const reveal = [53, 54, 57].includes(checkpoint) || root?.blackboard?.dungeon_state === "loot_wreck" || root?.blackboard?.dungeon_state === "return_loot";
  if (Boolean(wreck.cloaked) === reveal) ports().cloak(scene, wreck, !reveal);
  const choreographyState = site.spawnState.airMining;
  for (const [group, command] of Object.entries(choreographyState?.commands || {})) {
    for (const selected of command.kind ? [command] : [command.movement, command.effect]) {
      if (selected) applyCommand(scene, site, group, selected);
    }
  }
  require("../dungeon/operationSiteRuntime").registerOperationSpawnpointRecord({ characterID: state.characterID, siteID: 2674, solarSystemID: site.solarSystemID, spawnID: site.instanceID, dungeonInstanceID: site.instanceID, position: { x: site.position.x + template.airEncounter.mining.entryOffset.x, y: site.position.y + template.airEncounter.mining.entryOffset.y, z: site.position.z + template.airEncounter.mining.entryOffset.z } });
  saveCharacter(state.characterID, state);
  ok(require("../../gameStore").flushTableSync("dungeonRuntimeState"));
  return state;
}
function evidence(session, task, state) {
  const site = siteFor(state.characterID), ship = characters.getActiveShipRecord(state.characterID);
  if (!site || !ship || ship.ownerID !== state.characterID) return false;
  const inSite = session._space && runtime().getSceneForSession(session)?.getShipEntityForSession(session)?.dungeonCurrentInstanceID === site.instanceID;
  if (task === "2.1.01_enter_mining_site") return Boolean(inSite);
  const index = ["2.1.02_mine_asteroid_1", "2.1.03_mine_asteroid_2", "2.1.04_mine_asteroid_3"].indexOf(task);
  if (index >= 0) return Boolean(inSite && extraction.harvested(site.instanceID, ROCK_IDS[index]) >= 38);
  const record = characters.getCharacterRecord(state.characterID);
  const originalBox = state.miningSourceItemIDs?.some(id => { const item = inventory.findItemById(id); return item?.ownerID === state.characterID && item.typeID === 60784 && [ship.itemID, record.stationID].includes(item.locationID); });
  if (task === "2.1.05_loot_wreck") return Boolean(inSite && originalBox);
  if (task === "2.1.06_back_to_station") return Boolean(record.stationID && originalBox && ROCK_IDS.every(id => extraction.harvested(site.instanceID, id) >= 38));
  return false;
}
function scoped(context) {
  const { root, instance, session, parameters: p } = context;
  if (root.ownerKey !== "air" || root.graphID !== 711 || ![711, 737].includes(instance.graphID) || !session || session.characterID !== root.characterID || session.socket?.destroyed) throw graphError("AIR_MINING_GRAPH_FORBIDDEN");
  const site = siteFor(root.characterID);
  const scene = runtime().getSceneForSession(session) || (site && runtime().scenes.get(site.solarSystemID));
  if (!site || Number(session.solarsystemid2 || session.solarsystemid) !== site.solarSystemID || scene?.systemID !== site.solarSystemID || p.solar_system_id && Number(p.solar_system_id) !== site.solarSystemID || p.dungeon_spawn_id && Number(p.dungeon_spawn_id) !== site.instanceID || p.spawn_id && Number(p.spawn_id) !== site.instanceID) throw graphError("AIR_MINING_SCENE_FORBIDDEN");
  return { site, scene };
}
// Cycles of the fleet's fake-mining beam: in effect until stopped (8 s cycles, about 22 hours).
const FAKE_MINING_REPEAT = 10000;
function applyCommand(scene, site, group, command) {
  const contract = authority.getTemplateByID(TEMPLATE_ID).airEncounter.mining;
  const descriptor = contract.allowedTargets[String(command.target)];
  const target = descriptor?.kind === "actorType" ? entities(scene, site).find(entity => entity.typeID === descriptor.typeID) : object(scene, site, descriptor?.dungeonObjectID);
  const actors = entities(scene, site).filter(entity => entity.airMiningGroup === group);
  // Distance and speed come from the current pack, also for a command saved by an older one.
  const authored = Object.values(contract.commands || {}).find(entry => entry.kind === command.kind && entry.groups?.includes(group));
  if (authored) command = { ...command, rangeMeters: authored.rangeMeters, maxSpeedMeters: authored.maxSpeedMeters };
  // A mined-out target is legitimately absent when a saved presentation
  // command is replayed. Stop the visual effect; never recreate that rock.
  if (!target && descriptor?.kind !== "actorType" && ROCK_IDS.includes(descriptor?.dungeonObjectID) && extraction.harvested(site.instanceID, descriptor.dungeonObjectID) >= 38) command = { ...command, kind: "stopFakeMining" };
  if (!target && command.kind !== "stopFakeMining") throw graphError("AIR_MINING_TARGET_MISSING");
  for (const actor of actors) {
    if ((command.kind === "follow" || command.kind === "startHaulerCycle") && !scene.followShipEntity(actor, target.itemID, command.rangeMeters || 1000)) throw graphError("AIR_MINING_MOVEMENT_REFUSED");
    // maxSpeedMeters (pack 1.0.5): the security escort's AIR Frigate and AIR Cruiser make 1,890 m/s
    // and would whirl around Elias; each actor orbits at most at that speed.
    const orbitOptions = command.maxSpeedMeters > 0 && actor.maxVelocity > command.maxSpeedMeters ? { speedFraction: command.maxSpeedMeters / actor.maxVelocity } : {};
    if (command.kind === "orbit" && !scene.orbitShipEntity(actor, target.itemID, command.rangeMeters || 500, orbitOptions)) throw graphError("AIR_MINING_MOVEMENT_REFUSED");
    if (["startFakeMining", "stopFakeMining"].includes(command.kind)) {
      const start = command.kind === "startFakeMining";
      actor.presentationSpecialFx ||= new Map();
      // Fake mining is presentation only and runs until the client's "Stop Fake Mine" command, as
      // on TQ: one 8-second cycle showed the beams only briefly.
      if (start) actor.presentationSpecialFx.set("air-mining", { guid: "effects.Mining", targetID: target.itemID, durationMs: 8000, repeat: FAKE_MINING_REPEAT, forceFreshAcquireSpecialFxReplay: true });
      else actor.presentationSpecialFx.delete("air-mining");
      if (actor.airMiningFxTarget !== (start ? target.itemID : null)) {
        scene.broadcastSpecialFx(actor.itemID, "effects.Mining", { targetID: target?.itemID || actor.airMiningFxTarget, start: start ? 1 : 0, active: start ? 1 : 0, duration: 8000, repeat: start ? FAKE_MINING_REPEAT : 0 }, actor);
        actor.airMiningFxTarget = start ? target.itemID : null;
      }
    }
  }
}
function choreography(scene, site, p) {
  const contract = authority.getTemplateByID(TEMPLATE_ID).airEncounter.mining;
  const binding = contract.messageBindings[p.message_key];
  if (!binding) throw graphError("AIR_MINING_COMMAND_FORBIDDEN");
  const state = clone(site.spawnState.airMining || {}), targets = state.targets || {};
  if (binding.kind === "target") {
    if (!contract.allowedTargets[String(p.message_value)]) throw graphError("AIR_MINING_TARGET_FORBIDDEN");
    targets[binding.group] = Number(p.message_value); persist(site, { targets }); return {};
  }
  const command = contract.commands[p.message_value];
  if (!command?.groups.includes(binding.group)) throw graphError("AIR_MINING_COMMAND_FORBIDDEN");
  const selected = { kind: command.kind, rangeMeters: command.rangeMeters, maxSpeedMeters: command.maxSpeedMeters, target: targets[binding.group] };
  const slot = ["startFakeMining", "stopFakeMining"].includes(command.kind) ? "effect" : command.kind === "stageTarget" ? "staged" : "movement";
  const commands = { ...state.commands, [binding.group]: { ...state.commands?.[binding.group], [slot]: selected } };
  persist(site, { commands });
  applyCommand(scene, site, binding.group, selected);
  return {};
}
function register(graphs, encounter) {
  const supports = ({ graphID, ownerKey }) => ownerKey === "air" && [711, 737].includes(graphID);
  for (const atomID of [214, 278, 408, 409, 457, 459, 460, 461, 464]) graphs.registerAtom(4, atomID, context => {
    const { root, session, parameters: p } = context;
    if (atomID === 278 && [685, 686].includes(root.graphID)) return encounter.message(context);
    if (atomID === 214 && root.ownerKey === "air" && root.graphID === 711 && !siteFor(root.characterID) && Number(p.spawn_id) === characters.getCharacterRecord(root.characterID)?.authoredAirTutorial?.miningInstanceID) return {};
    if (atomID === 409) {
      if (p.dungeon_id !== 9245) throw graphError("AIR_MINING_DUNGEON_FORBIDDEN");
      ensureSite(session, characters.getCharacterRecord(root.characterID).authoredAirTutorial, root);
    }
    const { scene, site } = scoped(context);
    if (atomID === 409) {
      const offset = authority.getTemplateByID(TEMPLATE_ID).airEncounter.mining.entryOffset;
      return { spawn_id: site.instanceID, beacon_id: site.spawnState.siteID, entry_position: { x: site.position.x + offset.x, y: site.position.y + offset.y, z: site.position.z + offset.z } };
    }
    if (atomID === 408) {
      // "Warp to Site" while already inside: EveJS refuses it (DunCannotWarpWithinComplex), and
      // the failed action is replayed at every login. The pilot is already there: done.
      if (scene.getShipEntityForSession(session)?.dungeonCurrentInstanceID === site.instanceID) return {};
      // AIR's instance warps land unjittered.
      ok(runtime().warpToPoint(session, p.position, { destinationStaticInstanceID: site.instanceID, destinationDungeonSiteID: site.spawnState.siteID, stopDistance: 0, warpJitter: null }));
      return {};
    }
    if (atomID === 278) return choreography(scene, site, p);
    if (atomID === 214) { purgeSite(root.characterID); return {}; }
    const entity = p.item_id ? scene.getEntityByID(currentItemID(root.characterID, p.item_id)) : object(scene, site, p.dungeon_object_id);
    if (!entity && atomID === 464 && ROCK_IDS.includes(Number(p.dungeon_object_id)) && extraction.harvested(site.instanceID, Number(p.dungeon_object_id)) >= 38) return {};
    if (!entity || entity.dungeonSiteInstanceID !== site.instanceID) throw graphError("AIR_MINING_OBJECT_FORBIDDEN");
    if ([457, 459].includes(atomID)) ports().targetable(scene, entity, atomID === 457);
    else if ([460, 461].includes(atomID)) ports().cloak(scene, entity, atomID === 460);
    else if (atomID === 464) { if (extraction.harvested(site.instanceID, Number(p.dungeon_object_id)) < 38) throw graphError("AIR_MINING_ROCK_UNFINISHED"); ok(ports().remove(scene, entity, { broadcast: true })); }
    return {};
  }, atomID === 278 ? ({ graphID, ownerKey }) => ownerKey === "air" && [685, 686, 711, 737].includes(graphID) : supports);
  graphs.registerAtom(30, 458, context => { const { scene, site } = scoped(context); const entity = object(scene, site, context.parameters.dungeon_object_id); if (!entity) throw graphError("AIR_MINING_OBJECT_MISSING"); return { item_id: entity.itemID }; }, supports);
}
function retainOre(context) {
  const { site } = scoped(context), p = context.parameters;
  // The authored keep-114 clamp cannot destroy ore obtained elsewhere.
  if (p.type_id !== 60771 || p.quantity_to_keep !== 114 || Object.values(site.spawnState.airMining?.extractions || {}).reduce((sum, value) => sum + value.quantity, 0) > 114) throw graphError("AIR_MINING_QUANTITY_INVALID");
  return {};
}
module.exports = { TEMPLATE_ID, ROCK_IDS, siteFor, beaconID, ensureSite, evidence, register, purgeSite, retainOre };
