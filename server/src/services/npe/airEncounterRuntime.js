"use strict";

const characters = require("../character/characterState");
const inventory = require("../inventory/itemStore");
const custody = require("../inventory/itemCustody");
const dungeon = require("../dungeon/dungeonRuntime");
const authority = require("../dungeon/dungeonAuthority");
const jobs = require("./airEncounterJobs");
const { graphError } = require("../nodegraph/nodeGraphCompiler");
const { cloneValue } = require("../../common/clone");
const { resolveSessionCharacterID } = require("../_shared/sessionIdentity");
const AU = 149597870700;
let callbacks = {};
const space = () => require("../../space/runtime");
const service = () => require("../dungeon/dungeonUniverseSiteService");
const ports = () => service().airEncounterPorts;
function ok(result) { if (!result?.success) throw graphError("AIR_ENCOUNTER_OWNER_FAILED", result?.errorMsg); return result; }
function offset(base, vector) { return { x: base.x + vector.x, y: base.y + vector.y, z: base.z + vector.z }; }
function template(operationID) { return authority.getTemplateByID(`evejs.air-tutorial:${operationID === 2423 ? 9103 : 9105}`); }
function siteFor(characterID, operationID) {
  const current = jobs.state(characterID), site = dungeon.getInstance(current?.encounter?.sites?.[operationID]?.instanceID);
  return site?.ownership?.characterID === characterID && site.lifecycleState === "active"
    && site.metadata?.operationKey === `air:${current.runID}:encounter:${operationID}` ? site : null;
}
function actors(scene, site) { return (scene?.getDynamicEntities() || []).filter(entity => entity.dungeonSiteInstanceID === site?.instanceID && entity.airEncounterSlot); }
function actor(scene, site, slot) { return actors(scene, site).find(entity => entity.airEncounterSlot === slot); }
function ensureSite(session, operationID) {
  const characterID = resolveSessionCharacterID(session), current = jobs.state(characterID);
  const stored = current.encounter.sites?.[operationID];
  const result = ok(service().spawnTemplateForSession(session, template(operationID).templateID, {
    operationKey: `air:${current.runID}:encounter:${operationID}`, broadcast: false, spawnEncounters: false,
    // On the pilot's own lane (operationSiteRuntime.pilotLanePosition). The fight site lies 1 AU
    // from the rescue site in -x: a ship faces the way it warped, and the combat site's anomaly
    // lies in -x from its entry (74 km), so the pilot lands facing it, as on TQ. At +4 AU the warp
    // ran +x and the pilot landed with the anomaly behind.
    markCurrentDungeonRoom: false,
    position: stored?.position || require("../dungeon/operationSiteRuntime").pilotLanePosition(session, (operationID === 2423 ? 3 : 2) * AU),
    spawnOffsetMeters: (operationID === 2423 ? 3 : 2) * AU,
  }));
  const site = result.data.instance;
  if (stored && stored.instanceID !== site.instanceID) throw graphError("AIR_ENCOUNTER_INSTANCE_STALE");
  ok(require("../../gameStore").flushTableSync("dungeonRuntimeState"));
  jobs.update(characterID, value => { value.encounter.sites ||= {}; value.encounter.sites[operationID] = { instanceID: site.instanceID, position: site.position, systemID: site.solarSystemID }; return value; });
  const point = offset(site.position, template(operationID).airEncounter.entryOffset);
  require("../dungeon/operationSiteRuntime").registerOperationSpawnpointRecord({ characterID, siteID: operationID, solarSystemID: site.solarSystemID, spawnID: site.instanceID, dungeonInstanceID: site.instanceID, position: point });
  return site;
}
function createBoardingHull(session, site) {
  const characterID = resolveSessionCharacterID(session), current = jobs.state(characterID), entry = current.encounter.entry;
  const previous = current.encounter.boardingHullID;
  if (previous) return inventory.findItemById(previous);
  const granted = ok(custody.transfer({ items: { typeID: 58745, quantity: 1, options: { singleton: 1, itemName: "AIR Civilian Astero" } },
    to: custody.custodyRef.ownerLocation(characterID, entry.stationID, 4), actor: characterID,
    reason: custody.CUSTODY_REASON.AIR_ENCOUNTER_GRANT, idempotencyKey: `air:${current.runID}:boarding-hull` }));
  let hull = inventory.findItemById(granted.data.items[0].itemID);
  if (hull.locationID === entry.stationID) {
    ok(require("../ship/starterShipFittingState").ensureStarterShipDefaultFit(characterID, entry.stationID, hull));
    ok(inventory.updateShipItem(hull.itemID, item => ({ ...item, conditionState: { ...item.conditionState, damage: 0, shieldCharge: 0, armorDamage: 0.375 } })));
    const position = offset(site.position, template(2423).airEncounter.boardingShipOffset);
    const spaceState = { systemID: site.solarSystemID, position, direction: { x: 1, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, mode: "STOP", speedFraction: 0 };
    const moved = ok(custody.transfer({ items: [{ itemID: hull.itemID }],
      from: custody.custodyRef.ownerLocation(characterID, entry.stationID, 4),
      to: custody.custodyRef.inSpace(characterID, site.solarSystemID, spaceState), options: { destinationItemPatch: { spaceState } },
      actor: characterID, reason: custody.CUSTODY_REASON.AIR_ENCOUNTER_GRANT, idempotencyKey: `air:${current.runID}:boarding-location` }));
    hull = inventory.findItemById(hull.itemID);
    for (const change of [...granted.data.changes || [], ...moved.data.changes || []]) if (change.item) characters.syncInventoryItemForSession(session, change.item, change.previousData || {}, { emitCfgLocation: true });
  }
  if (hull.ownerID !== characterID || hull.locationID !== site.solarSystemID || hull.flagID !== 0) throw graphError("AIR_BOARDING_HULL_CUSTODY_CONFLICT");
  ok(require("../../gameStore").flushTableSync("items"));
  jobs.update(characterID, value => { value.encounter.boardingHullID = hull.itemID; return value; });
  return hull;
}
function prepareEntryCapsule(session, phase, record, ship, publish = true) {
  const characterID = resolveSessionCharacterID(session);
  const stationID = Number(record.stationID);
  // Ordinary creation supplies a rookie hull. Only an unstarted, docked AIR
  // opening may leave that hull in its hangar and adopt a native capsule.
  if (phase.graphID !== 685 || Number(record.serverNodeGraphCheckpoints?.[49] || 0) !== 0 ||
      session._space || Number(session.stationid || session.stationID) !== stationID ||
      !ship || ship.ownerID !== characterID || ship.locationID !== stationID || ship.flagID !== inventory.ITEM_FLAGS.HANGAR) {
    throw graphError("AIR_ENTRY_CAPSULE_REQUIRED");
  }
  const capsule = ok(inventory.ensureCapsuleForCharacter(characterID, stationID));
  // A restart must find the capsule before the character can point at it.
  ok(require("../../gameStore").flushTableSync("items"));
  ok(inventory.setActiveShipForCharacter(characterID, capsule.data.itemID));
  const persisted = require("../../gameStore").flushTableSync("characters");
  if (!persisted.success) {
    ok(inventory.setActiveShipForCharacter(characterID, ship.itemID));
    ok(persisted);
  }
  // Also prime a capsule left by a prior failed save, before publishing shipid.
  if (publish) characters.syncInventoryItemForSession(session, capsule.data,
    { locationID: 0, flagID: 0, quantity: 0, singleton: 0, stacksize: 0 }, { emitCfgLocation: true });
  ok(characters.activateShipForSession(session, capsule.data.itemID, { emitNotifications: publish, logSelection: true }));
  return characters.getActiveShipRecord(characterID);
}
function prepareForSelection(session, current) {
  if (current.status !== "active" || session._space || !session.stationid ||
      current.encounter?.entry.status === "complete") return;
  if (!template(2423)?.airEncounter?.balin || !template(2433)?.airEncounter) throw graphError("AIR_ENCOUNTER_CONTENT_REQUIRED");
  const characterID = resolveSessionCharacterID(session), record = characters.getCharacterRecord(characterID);
  let ship = characters.getActiveShipRecord(characterID);
  if (!current.encounter) {
    if (!inventory.isCapsuleTypeID(ship?.typeID) || Number(session.shipid || session.shipID) !== ship?.itemID) {
      ship = prepareEntryCapsule(session, { graphID: 685 }, record, ship, false);
    }
    if (!inventory.isCapsuleTypeID(ship?.typeID) || !record.stationID) throw graphError("AIR_ENTRY_CAPSULE_REQUIRED");
    current.encounter = { entry: { shipID: ship.itemID, stationID: record.stationID, systemID: record.solarSystemID }, sites: {}, jobs: {} };
    jobs.update(characterID, () => cloneValue(current));
  }
  if (ship?.itemID !== current.encounter.entry.shipID || !inventory.isCapsuleTypeID(ship?.typeID)) throw graphError("AIR_ENTRY_CAPSULE_REQUIRED");
  // Use the native transition owner, but defer client presentation to the
  // initial selection plan and normal space restore. Publishing a hangar first
  // races its inventory loads against the subsequent automatic undock.
  ok(require("../../space/transitions").undockSession(session, { deferInitialSelection: true }));
  ok(require("../../gameStore").flushTableSync("items"));
  ok(require("../../gameStore").flushTableSync("characters"));
}
async function ensure(session, current, phase, root = null) {
  if (![685, 686].includes(phase.graphID)) return current;
  const characterID = resolveSessionCharacterID(session);
  if (!template(2423)?.airEncounter?.balin || !template(2433)?.airEncounter) throw graphError("AIR_ENCOUNTER_CONTENT_REQUIRED");
  if (!current.encounter) {
    const record = characters.getCharacterRecord(characterID);
    let ship = characters.getActiveShipRecord(characterID);
    if ((!inventory.isCapsuleTypeID(ship?.typeID) || Number(session.shipid || session.shipID) !== ship?.itemID) && record.stationID) {
      ship = prepareEntryCapsule(session, phase, record, ship);
    }
    if (!inventory.isCapsuleTypeID(ship?.typeID) || !record.stationID) throw graphError("AIR_ENTRY_CAPSULE_REQUIRED");
    current.encounter = { entry: { shipID: ship.itemID, stationID: record.stationID, systemID: record.solarSystemID }, sites: {}, jobs: {} };
    jobs.update(characterID, () => cloneValue(current));
  }
  current = jobs.state(characterID);
  if (phase.graphID === 686 && current.encounter.combat?.deaths?.pod?.status === "complete") { await jobs.resume(characterID); await require("./airCombatRuntime").resumeAfterPodDeath(session); return current; }
  if (current.encounter.entry.status !== "complete") {
    if (!session._space) ok(require("../../space/transitions").undockSession(session));
    const scene = space().getSceneForSession(session), site = ensureSite(session, 2423);
    ensureSite(session, 2433);
    const hull = createBoardingHull(session, site);
    if (!scene.getEntityByID(hull.itemID)) ok(space().spawnDynamicInventoryEntity(site.solarSystemID, hull.itemID));
    const entity = scene.getEntityByID(hull.itemID);
    Object.assign(entity, { dungeonSiteInstanceID: site.instanceID, airNpeOwnerCharacterID: characterID, airNpeInstanceID: site.instanceID, airNpeOperationID: 2423 });
    const capsule = scene.getShipEntityForSession(session);
    ok(scene.teleportDynamicEntityToPoint(capsule, offset(site.position, template(2423).airEncounter.entryOffset), { direction: capsule.direction }));
    ports().scopeShip(scene.getShipEntityForSession(session), site, 2423);
    jobs.update(characterID, value => { value.encounter.entry.status = "complete"; return value; });
  }
  current = jobs.state(characterID);
  if (session._space && Number(session.solarsystemid2 || session.solarsystemid) === current.encounter.entry.systemID) {
    const scene = space().getSceneForSession(session), site = siteFor(characterID, phase.graphID === 685 ? 2423 : 2433);
    if (!site) throw graphError("AIR_ENCOUNTER_SITE_STALE");
    ensureSite(session, 2423); ensureSite(session, 2433);
    const shipDeath = current.encounter.combat?.deaths?.ship;
    const pilotEntity = scene.getShipEntityForSession(session);
    if (phase.graphID === 686 && shipDeath?.status === "complete" && pilotEntity?.itemID === shipDeath.capsuleID &&
        Math.hypot(pilotEntity.position.x - site.position.x, pilotEntity.position.y - site.position.y, pilotEntity.position.z - site.position.z) <= 1000000) {
      ports().scopeShip(pilotEntity, site, 2433);
    }
    if (phase.graphID === 685) {
      ports().actors(scene, site, template(2423).airEncounter.actors.map(actor => ({ ...actor, key: `backdrop:${actor.key}` })));
      const hull = inventory.findItemById(current.encounter.boardingHullID);
      if (hull?.flagID === 0 && hull.locationID === scene.systemID && !scene.getEntityByID(hull.itemID)) ok(space().spawnDynamicInventoryEntity(scene.systemID, hull.itemID));
    }
    for (const [key, job] of Object.entries(current.encounter.jobs || {})) if (job.status === "complete" && key.startsWith("arrival:")) {
      const spec = companionSpecs().find(spec => spec.key === key.slice(8));
      if (spec && !require("./airFleetBattle").hasCompletedDeparture(current, site.instanceID, spec.key)) {
        ports().actors(scene, site, [phase.graphID === 686 ? { ...spec, positionOffset: template(2433).airEncounter.entryOffset } : spec]);
      }
    }
  }
  if (phase.graphID === 685) handleBoarding(session);
  if (phase.graphID === 686 && session._space) {
    require("./airCombatRuntime").restore(session);
    ok(require("../career/careerExplorationSources").recordTutorialCombatArrival(session));
  }
  await jobs.resume(characterID);
  return jobs.state(characterID);
}
function companionSpecs() {
  const content = template(2423).airEncounter;
  return [content.balin, ...content.escorts.map((spec, index) => ({ ...spec, key: `escort:${index}` }))];
}
function restoreEscort(session) {
  const characterID = resolveSessionCharacterID(session), current = jobs.state(characterID);
  if (current?.status !== "active" || current.phaseGraphID !== 686 || current.encounter?.fleetTransition?.status !== "complete" || current.encounter.combat?.deaths) return false;
  let scope;
  try { scope = scoped(session, 2433); } catch { return false; }
  const { scene, site, entity } = scope;
  if (entity.itemID !== current.encounter.boardingHullID || current.encounter.fleetTransition.destinationInstanceID !== site.instanceID) return false;
  const balin = actor(scene, site, "balin");
  if (!balin || balin.nativeNpc !== true || balin.airNpeOwnerCharacterID !== characterID || balin.airNpeInstanceID !== site.instanceID || balin.mode === "WARP" || scene.hasQueuedWarpOrder(balin)) return false;
  const order = require("../../space/npc/npcService").getControllerByEntityID(balin.itemID)?.manualOrder;
  if (order?.type === "follow" && Number(order.targetID) === entity.itemID && Number(order.followRangeMeters) === BALIN_ESCORT_RANGE_METERS && order.allowWeapons === false) return true;
  ports().follow(scene, balin, entity, BALIN_ESCORT_RANGE_METERS);
  return true;
}
function handleBoarding(session) {
  const characterID = resolveSessionCharacterID(session), current = jobs.state(characterID);
  if (current?.status !== "active" || !current.encounter || characters.getActiveShipRecord(characterID)?.itemID !== current.encounter.boardingHullID) return;
  const scene = space().getSceneForSession(session), site = siteFor(characterID, 2423), entity = scene?.getShipEntityForSession(session);
  if (!site || scene.systemID !== site.solarSystemID || !entity || entity.ownerID !== characterID || Math.hypot(entity.position.x - site.position.x, entity.position.y - site.position.y, entity.position.z - site.position.z) > 1000000) return;
  ports().scopeShip(entity, site, 2423);
}
function blackboard(characterID) {
  const one = siteFor(characterID, 2423), two = siteFor(characterID, 2433);
  return { void_solar_system_id: one?.solarSystemID, spawn_id_dungeon_1: one?.instanceID, spawn_id_dungeon_2: two?.instanceID,
    entry_point_dungeon_1: one && offset(one.position, template(2423).airEncounter.entryOffset),
    entry_point_dungeon_2: two && offset(two.position, template(2433).airEncounter.entryOffset),
    entry_item_id_dungeon_1: one?.spawnState.siteID, entry_item_id_dungeon_2: two?.spawnState.siteID,
    target_item_id: jobs.state(characterID)?.encounter?.boardingHullID, target_type_id: 58745 };
}
function scoped(session, operationID = 2423) {
  const characterID = resolveSessionCharacterID(session), site = siteFor(characterID, operationID), scene = space().getSceneForSession(session);
  const ship = characters.getActiveShipRecord(characterID), entity = scene?.getShipEntityForSession(session);
  if (!site || scene?.systemID !== site.solarSystemID || !ship || ship.ownerID !== characterID || entity?.itemID !== ship.itemID || entity.session !== session || entity.dungeonCurrentInstanceID !== site.instanceID)
    throw graphError("AIR_ENCOUNTER_SCENE_FORBIDDEN");
  return { characterID, site, scene, ship, entity };
}
function evidence(session, task) {
  try {
    const { characterID, scene, site, ship } = scoped(session);
    const current = jobs.state(characterID), hull = current.encounter.boardingHullID;
    if (["board_ship", "ship_hud"].includes(task)) return ship.itemID === hull;
    if (task === "start_repairing") {
      // Native graph 748 acknowledges approaching Balin once, while repairs
      // are still running. Graph 749 owns the subsequent full-armour gate.
      // Rejecting that one-shot acknowledgement strands the client in 748.
      return ship.itemID === hull && current.encounter.repairStarted && actor(scene, site, "balin")?.mode !== "WARP";
    }
    if (task === "balin_warping") {
      // ShipHealth (client atom 172) rounds the armour fraction to a whole
      // percentage. Shields are not part of graph 749's departure condition.
      const armorPercent = Number((1 - inventory.getShipConditionState(ship).armorDamage).toFixed(2)) * 100;
      return ship.itemID === hull && armorPercent === 100 && Boolean(current.encounter.repairStarted && actor(scene, site, "balin")) && companionSpecs().every(spec => current.encounter.jobs[`arrival:${spec.key}`]?.status === "complete" && actor(scene, site, spec.key)?.mode !== "WARP" && !scene.hasQueuedWarpOrder(actor(scene, site, spec.key)));
    }
  } catch { return false; }
  return false;
}
function authorizeCommand(session, root, value) {
  return root.graphID === 685 && root.activeTask === "start_repairing" && value === "balin_repairing" && evidence(session, "ship_hud");
}
function repair(session) {
  const { scene, site, entity, characterID } = scoped(session), balin = actor(scene, site, "balin");
  if (!balin || balin.mode === "WARP") throw graphError("AIR_REPAIR_COMPANION_NOT_READY");
  ok(ports().repair(scene, balin, entity));
  jobs.update(characterID, value => { value.encounter.repairStarted = true; return value; });
}
async function message(context) {
  const { root, session, parameters: p } = context;
  if (root.graphID === 686) return require("./airCombatRuntime").message(context);
  if (root.ownerKey !== "air" || root.graphID !== 685 || resolveSessionCharacterID(session) !== root.characterID) throw graphError("AIR_ENCOUNTER_GRAPH_FORBIDDEN");
  const { scene, site, entity, characterID } = scoped(session);
  if (p.dungeon_spawn_id !== site.instanceID || p.solar_system_id !== scene.systemID) throw graphError("AIR_ENCOUNTER_MESSAGE_SCOPE");
  const common = { sceneKey: scene.sceneKey, instanceID: site.instanceID, operationID: 2423, shipID: entity.itemID, rootID: root.instanceID };
  if (["BALIN_WARP_TO_SITE_1", "BALIN_SPAWN"].includes(p.message_key) && p.message_value === "ENABLED") {
    for (const spec of companionSpecs()) await jobs.enqueue(characterID, `arrival:${spec.key}`, spec.arrivalDelayMs, common);
    return {};
  }
  if (p.message_key === "BALIN_REPAIR_PLAYER" && p.message_value === "ENABLED") { repair(session); return {}; }
  if (p.message_key === "BALIN_WARP_TO_SITE_2" && p.message_value === "ENABLED") {
    if (!evidence(session, "balin_warping")) throw graphError("AIR_FLEET_NOT_READY");
    const destination = siteFor(characterID, 2433);
    jobs.update(characterID, value => { value.encounter.fleetTransition = { status: "prepared", shipID: entity.itemID, sourceInstanceID: site.instanceID, destinationInstanceID: destination.instanceID }; return value; });
    await jobs.enqueue(characterID, "fleet-warp", 0, common);
    return {};
  }
  throw graphError("AIR_ENCOUNTER_MESSAGE_UNSUPPORTED", p.message_key);
}
async function handleJob(session, key, job) {
  if (key.startsWith("death:")) return require("./airCombatRuntime").handleJob(session, key, job);
  if (!require("./tutorialRuntime").getCharacterTutorialSnapshot(resolveSessionCharacterID(session)).canPlayTutorial) return { success: true, stale: true };
  if (key.startsWith("reinforcement:") || key.startsWith("combat-progress:")) return require("./airCombatRuntime").handleJob(session, key, job);
  let context;
  if (key === "fleet-arrival") {
    const characterID = resolveSessionCharacterID(session), scene = space().getSceneForSession(session), site = siteFor(characterID, 2433), entity = scene?.getShipEntityForSession(session);
    if (!scene || !site || scene.systemID !== site.solarSystemID || entity?.itemID !== job.shipID) return { success: true, deferred: true };
    context = { characterID, scene, site, entity };
  } else try { context = scoped(session, job.operationID); } catch { return { success: true, deferred: true }; }
  const { scene, site, entity, characterID } = context;
  const current = jobs.state(characterID), root = characters.getCharacterRecord(characterID).serverNodeGraphs?.[job.rootID];
  if (scene.sceneKey !== job.sceneKey || site.instanceID !== job.instanceID || entity.itemID !== job.shipID || !root || root.ownerKey !== "air") return { success: true, stale: true };
  if (key.startsWith("arrival:")) {
    if (entity.mode === "WARP" || scene.hasQueuedWarpOrder(entity)) return { success: true, deferred: true };
    if (root.graphID !== 685 || root.stopped || !["start_repairing", "balin_warping"].includes(root.activeTask)) return { success: true, stale: true };
    const spec = companionSpecs().find(spec => spec.key === key.slice(8));
    if (!spec) throw graphError("AIR_COMPANION_SLOT_UNKNOWN");
    ports().arrive(scene, site, [spec]); return { success: true };
  }
  if (key === "fleet-warp") {
    if (!root.stopped || root.activeTask !== "frigates_arrived") throw graphError("AIR_FLEET_GRAPH_NOT_STOPPED");
    const destination = siteFor(characterID, 2433), point = offset(destination.position, template(2433).airEncounter.entryOffset);
    const companions = actors(scene, site).filter(actor => !actor.airEncounterSlot.startsWith("backdrop:"));
    warpPilot(scene, session, point, destination);
    ports().fleetWarp(scene, session, companions, point, destination);
    jobs.update(characterID, value => { value.encounter.fleetTransition.status = "warping"; return value; });
    await jobs.enqueue(characterID, "fleet-arrival", 1000, { ...job, operationID: 2433, instanceID: destination.instanceID });
    // Scene 1.2 starts now, while the fleet is in warp, not after landing. Its client graph
    // switches off full stop / warp (command set 6) when it starts and switches them on again
    // on "Dungeon Entered" for the combat site (9105); its first step waits for the warp to
    // finish. Started after landing, the pilot is already in 9105: the switch-on runs before
    // the switch-off and Stop stays disabled for the whole scene.
    ok(characters.updateCharacterRecord(characterID, record => ({ ...record, serverNodeGraphCheckpoints: { ...record.serverNodeGraphCheckpoints, 49: 16 } })));
    ok(require("../../gameStore").flushTableSync("characters"));
    await callbacks.ensureForSession(session);
    return { success: true };
  }
  if (key === "fleet-arrival") {
    const point = offset(site.position, template(2433).airEncounter.entryOffset);
    if (entity.mode === "WARP" || scene.hasQueuedWarpOrder(entity) || entity.dungeonCurrentInstanceID !== site.instanceID || Math.hypot(entity.position.x - point.x, entity.position.y - point.y, entity.position.z - point.z) > 100000) return { success: true, retry: true };
    ports().scopeShip(entity, site, 2433);
    // As on TQ, Balin moves with the pilot after landing, about 13 km off, well inside his
    // repair range, so the frigate lesson, which waits for the pilot within 20 km of him,
    // starts where the pilot is.
    // He lands a tick after the pilot (fleetWarp); a follow order in warp would cut it short.
    const balin = actor(scene, site, "balin");
    if (balin && (balin.mode === "WARP" || scene.hasQueuedWarpOrder(balin))) return { success: true, retry: true };
    if (balin) ports().follow(scene, balin, entity, BALIN_ESCORT_RANGE_METERS);
    // As on TQ, some of the fleet lands burning (airFleetBattle).
    require("./airFleetBattle").scar(scene, site);
    jobs.update(characterID, value => { value.encounter.fleetTransition.status = "complete"; return value; });
    ok(characters.updateCharacterRecord(characterID, record => ({ ...record, serverNodeGraphCheckpoints: { ...record.serverNodeGraphCheckpoints, 49: 16 } })));
    ok(require("../../gameStore").flushTableSync("characters"));
    ok(require("../career/careerExplorationSources").recordTutorialCombatArrival(session));
    await callbacks.ensureForSession(session); return { success: true };
  }
  throw graphError("AIR_ENCOUNTER_JOB_UNKNOWN", key);
}
// The 2423 -> 2433 move is a server warp that lands the pilot unjittered.
// Dungeon sites' fleetWarp passes no jitter, so the pilot's own warp goes
// first, with warpJitter: null; fleetWarp then skips the ship already warping
// and warps the companions.
const BALIN_ESCORT_RANGE_METERS = 13000;
function warpPilot(scene, session, point, destination) {
  const ship = scene.getShipEntityForSession(session);
  if (!ship || ship.mode === "WARP" || scene.hasQueuedWarpOrder(ship) ||
      Math.hypot(ship.position.x - point.x, ship.position.y - point.y, ship.position.z - point.z) <= 100000) return;
  const result = scene.warpToPoint(session, point, { destinationStaticInstanceID: destination.instanceID, destinationDungeonSiteID: destination.spawnState.siteID, stopDistance: 0, warpJitter: null });
  if (!result?.success) throw graphError("AIR_PLAYER_WARP_FAILED", result?.errorMsg);
}
// The pilot woke at the home station after the pod death: the rescue and combat sites and their
// ships are done with, and go (the tutorial's jobs and state stay).
function retireSites(characterID) {
  const current = jobs.state(characterID);
  if (!current?.encounter) return;
  const scene = space().scenes.get(current.encounter.entry.systemID);
  const instanceIDs = Object.values(current.encounter.sites || {}).map(site => site.instanceID);
  if (scene) {
    // What the fight left there goes with the sites: the NPCs' wrecks and the pilot's own wreck
    // and corpse (each carries its site's scope). Left behind, a later pilot's site on the freed
    // lane showed them.
    for (const entity of scene.getDynamicEntities()) {
      if (![186, 14].includes(Number(entity.groupID)) || ![entity.dungeonSiteInstanceID, entity.airNpeInstanceID].some(id => instanceIDs.includes(Number(id)))) continue;
      const nativeWreck = require("../../space/npc/nativeNpcWreckService");
      if (require("../../space/npc/nativeNpcStore").getNativeWreck(entity.itemID)) ok(nativeWreck.destroyNativeWreck(entity.itemID, { broadcast: true }));
      else {
        scene.removeDynamicEntity(entity.itemID, { allowSessionOwned: true, broadcast: true });
        if (inventory.findItemById(entity.itemID)) ok(inventory.removeInventoryItem(entity.itemID, { removeContents: true }));
      }
    }
    ports().retire(scene, characterID, instanceIDs);
  }
  ok(require("../../gameStore").flushTableSync("items"));
  for (const operationID of [2423, 2433]) {
    const site = siteFor(characterID, operationID);
    if (site) ok(service().purgePrivateOperationForCharacter(characterID, site.instanceID, site.metadata.operationKey));
    require("../dungeon/operationSiteRuntime").removeOperationSpawnpointRecord(characterID, operationID);
  }
  ok(require("../../gameStore").flushTableSync("dungeonRuntimeState"));
}
async function cleanup(characterID) {
  await jobs.cancel(characterID);
  const current = jobs.state(characterID);
  if (current?.encounter) {
    const scene = space().scenes.get(current.encounter.entry.systemID);
    if (scene) ports().retire(scene, characterID, Object.values(current.encounter.sites).map(site => site.instanceID));
    ok(require("../../gameStore").flushTableSync("items"));
  }
  for (const operationID of [2423, 2433]) {
    const site = siteFor(characterID, operationID);
    if (site) ok(service().purgePrivateOperationForCharacter(characterID, site.instanceID, site.metadata.operationKey));
    require("../dungeon/operationSiteRuntime").removeOperationSpawnpointRecord(characterID, operationID);
  }
  ok(require("../../gameStore").flushTableSync("dungeonRuntimeState"));
}
jobs.registerHandler(handleJob);
module.exports = { ensure, prepareForSelection, blackboard, evidence, authorizeCommand, message, cleanup, retireSites, siteFor, companionSpecs, handleBoarding,
  scoped, restoreEscort,
  async resumePending(session) {
    const characterID = resolveSessionCharacterID(session), current = jobs.state(characterID);
    await ensure(session, current, { graphID: 685 });
    if (current.encounter.fleetTransition.status === "warping") {
      const scene = space().getSceneForSession(session), source = siteFor(characterID, 2423), destination = siteFor(characterID, 2433);
      if (scene?.systemID === destination?.solarSystemID && scene.getShipEntityForSession(session)?.itemID === current.encounter.fleetTransition.shipID) {
        const companions = scene.getDynamicEntities().filter(actor => actor.airNpeOwnerCharacterID === characterID &&
          [source.instanceID, destination.instanceID].includes(actor.airNpeInstanceID) &&
          companionSpecs().some(spec => spec.key === actor.airEncounterSlot));
        ports().fleetWarp(scene, session, companions, offset(destination.position, template(2433).airEncounter.entryOffset), destination);
      }
    }
    await jobs.resume(characterID);
  },
  waiting(characterID) { return ["prepared", "warping"].includes(jobs.state(characterID)?.encounter?.fleetTransition?.status); },
  configure(value) { callbacks = value; } };
