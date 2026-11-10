"use strict";

const crypto = require("node:crypto");
const graphs = require("../nodegraph/nodeGraphRuntime");
const characters = require("../character/characterState");
const inventory = require("../inventory/itemStore");
const tutorial = require("./tutorialRuntime");
const { resolveSessionCharacterID } = require("../_shared/sessionIdentity");
const { graphError } = require("../nodegraph/nodeGraphCompiler");
const mining = require("./airMiningRuntime");
const encounter = require("./airEncounterRuntime");
const combat = require("./airCombatRuntime");
mining.register(graphs, encounter);
const economy = require("./airEconomyRuntime");
economy.register(graphs);
require("./airGuidanceRuntime").register(graphs);

// These are installed target-client graphs, not donor graph replacements.
// Checkpoints are authored identifiers, not an increasing numeric counter.
const PHASES = Object.freeze([
  { graphID: 685, scene: "1.1", checkpoints: [0, 12], next: 16, operationID: 2423 },
  { graphID: 686, scene: "1.2", checkpoints: [16], next: 44, operationID: 2433 },
  { graphID: 695, scene: "1.3", checkpoints: [44, 85, 86, 87, 88], next: 45 },
  { graphID: 709, scene: "1.4", checkpoints: [45], next: 89, operationID: 2594, templateID: "evejs.air-tutorial:10461" },
  { graphID: 710, scene: "1.5", checkpoints: [89, 90, 46, 47, 48, 49, 55], next: 50 },
  { graphID: 711, scene: "2.1", checkpoints: [50, 51, 52, 56, 53, 54], next: 57, operationID: 2674, templateID: mining.TEMPLATE_ID },
  { graphID: 712, scene: "2.2", checkpoints: [57, 58, 59, 60, 62], next: 63 },
  { graphID: 713, scene: "2.3", checkpoints: [63], next: 64 },
  { graphID: 714, scene: "2.4", checkpoints: [64, 65, 66], next: 67 },
  { graphID: 715, scene: "2.5", checkpoints: [67, 91, 92], next: null },
]);
const CLIENT_CHAPTERS = Object.freeze({ 685: 725, 686: 726, 695: 717, 709: 718, 710: 724,
  711: 719, 712: 720, 713: 721, 714: 722, 715: 723 });
const sessions = new Map();
const operationLanes = new Map();
function serialized(characterID, operation) {
  const pending = (operationLanes.get(characterID) || Promise.resolve()).catch(() => {}).then(operation);
  operationLanes.set(characterID, pending);
  pending.then(() => { if (operationLanes.get(characterID) === pending) operationLanes.delete(characterID); }, () => { if (operationLanes.get(characterID) === pending) operationLanes.delete(characterID); });
  return pending;
}
const { cloneValue: clone } = require("../../common/clone");
function read(characterID) { return characters.getCharacterRecord(characterID)?.authoredAirTutorial || null; }
function save(characterID, state) {
  const result = characters.updateCharacterRecord(characterID, record => ({ ...record, authoredAirTutorial: clone(state) }));
  if (!result.success || !require("../../gameStore").flushTableSync("characters").success) throw graphError("AIR_STATE_FLUSH_FAILED");
}
function checkpoint(characterID) { return Number(characters.getCharacterRecord(characterID)?.serverNodeGraphCheckpoints?.[49] || 0); }
function activeRoot(session) {
  const state = read(resolveSessionCharacterID(session));
  return state && graphs.listForSession(session).find(root => root.instanceID === state.rootID && root.ownerKey === "air");
}
function activePhase(characterID) { return PHASES.find(phase => phase.checkpoints.includes(checkpoint(characterID))); }
function eligible(session) { return tutorial.getCharacterTutorialSnapshot(resolveSessionCharacterID(session)).canPlayTutorial; }
function requireSuccess(result) {
  if (!result?.success) throw graphError("AIR_OWNER_ACTION_FAILED", result?.errorMsg);
  return result;
}
function birthBlackboard(characterID, state) {
  const record = characters.getCharacterRecord(characterID);
  const stationID = Number(record.birthStationID || record.schoolStationID || state?.encounter?.entry.stationID || record.homeStationID || 0);
  const station = require("../_shared/stationStaticData").getStationRecord(null, stationID);
  return { birth_station_id: stationID, birth_system_id: Number(station?.solarSystemID || state?.encounter?.entry.systemID || 0) };
}

// Scene 1.4's item-retrieval site: one site per solar system, shared by every pilot in the step,
// as on TQ (the scenes 1.1 and 1.2 sites stay each pilot's own).
function retrievalSiteKey(systemID) { return `air:retrieval:${Number(systemID)}`; }
function ownedSite(session, state = read(resolveSessionCharacterID(session))) {
  const site = state?.siteInstanceID && require("../dungeon/dungeonRuntime").getInstance(state.siteInstanceID);
  const systemID = Number(session.solarsystemid2 || session.solarsystemid || 0);
  if (!site || site.lifecycleState !== "active" || site.solarSystemID !== systemID || site.metadata?.operationKey !== retrievalSiteKey(systemID)) return null;
  return site;
}
// Where a warp to the pilot's system's sun lands (warpInPointParity), or undefined without a sun.
function sunWarpInPoint(session) {
  const scene = require("../../space/runtime").getSceneForSession(session);
  const sun = (scene?.staticEntities || []).find(entity => entity && (entity.kind === "sun" || Number(entity.groupID) === 6));
  return sun ? require("../../space/destiny/simulation/warpInPointParity").getSunWarpInPoint(sun) : undefined;
}
function ensureRetrievalSite(session, state) {
  if (!session._space) return state;
  // A pilot's own site from an earlier release (one per pilot, at the same spot for everyone at
  // the sun) gives way to the shared one.
  const dungeonRuntime = require("../dungeon/dungeonRuntime"), sites = require("../dungeon/dungeonUniverseSiteService");
  const own = state.siteInstanceID && dungeonRuntime.getInstance(state.siteInstanceID);
  if (own && own.ownership?.characterID === state.characterID && own.metadata?.operationKey === `air:${state.runID}:retrieval`) {
    requireSuccess(sites.purgePrivateOperationForCharacter(state.characterID, own.instanceID, `air:${state.runID}:retrieval`));
  }
  const result = requireSuccess(sites.spawnTemplateForSession(session, "evejs.air-tutorial:10461", {
    sharedOperationKey: retrievalSiteKey(session.solarsystemid2 || session.solarsystemid), broadcast: true, spawnEncounters: false,
    // On TQ the item-retrieval site is at the system's sun: the step's warp to the star lands in
    // it, with the star filling the view. It stands at the star's own warp-in point, far from the
    // station, whose deadspace capture sphere would otherwise break the native warp-out.
    markCurrentDungeonRoom: false, position: sunWarpInPoint(session), spawnOffsetMeters: 6000000000,
  }));
  const site = result.data.instance;
  state.siteInstanceID = site.instanceID;
  state.sitePosition = site.position;
  state.siteSystemID = site.solarSystemID;
  delete state.sourceItemIDs;
  require("../dungeon/operationSiteRuntime").registerOperationSpawnpointRecord({ characterID: state.characterID, siteID: 2594, solarSystemID: site.solarSystemID, spawnID: site.instanceID, dungeonInstanceID: site.instanceID, position: site.position });
  save(state.characterID, state);
  requireSuccess(require("../../gameStore").flushTableSync("dungeonRuntimeState"));
  return state;
}
// The item the site's wrecks give, as the pack says (populationHints.containers[].itemOnOpen).
function itemOnOpen(site, role = null) {
  const containers = require("../dungeon/dungeonAuthority").getTemplateByID(site?.templateID)?.populationHints?.containers || [];
  const spec = containers.find(entry => entry?.itemOnOpen && (role === null || entry.role === role));
  const typeID = Number(spec?.itemOnOpen?.typeID) || 0;
  return typeID > 0 ? { typeID, quantity: Math.max(1, Number(spec.itemOnOpen.quantity) || 1) } : null;
}
// The step is done once the pilot has the item (taken from any of the site's wrecks, theirs or
// one another pilot left there) in the ship or at the station.
function retrieved(session, state) {
  const site = ownedSite(session, state), item = itemOnOpen(site);
  if (!item) return false;
  const ship = characters.getActiveShipRecord(state.characterID);
  const record = characters.getCharacterRecord(state.characterID);
  return inventory.listOwnedItems(state.characterID).some(owned => owned.typeID === item.typeID && Number(owned.stacksize ?? owned.quantity) > 0 && [ship?.itemID, record.stationID].includes(owned.locationID));
}
// A pilot in step 1.4 opened one of the site's wrecks (invBroker GetInventoryFromId): on TQ the
// item appears in whichever wreck is opened, when that wreck holds none. A pilot who already has
// one anywhere (the ship, the station, a jettisoned can of theirs) gets none, so it cannot be
// farmed; once theirs is gone for good, the next wreck they open has one again.
function onRetrievalWreckOpened(session, container) {
  const characterID = resolveSessionCharacterID(session), state = read(characterID);
  if (!container || !state || state.status !== "active" || state.phaseGraphID !== 709) return;
  const site = ownedSite(session, state);
  if (!site || Number(container.dungeonSiteInstanceID) !== Number(site.instanceID)) return;
  const item = itemOnOpen(site, container.dungeonSiteContentRole);
  if (!item) return;
  if (inventory.listContainerItems(null, container.itemID).some(held => held.typeID === item.typeID)) return;
  if (inventory.listOwnedItems(characterID).some(owned => owned.typeID === item.typeID)) return;
  requireSuccess(inventory.grantItemsToOwnerLocation(1, container.itemID, inventory.ITEM_FLAGS.CARGO_HOLD, [{ itemType: item.typeID, quantity: item.quantity }]));
}
// Scene 1.4 "warp to this system's sun": the client's step is a plain warp to the star. The
// system's item-retrieval site stands at the star's warp-in point (ensureRetrievalSite). While
// the step is active, a warp to the star goes into the site.
function retrievalWarpTarget(session, targetEntityID) {
  const characterID = resolveSessionCharacterID(session), state = read(characterID);
  if (!state || state.status !== "active" || state.phaseGraphID !== 709 || !state.siteInstanceID || !session?._space) return null;
  const root = activeRoot(session);
  if (!root || root.stopped || root.graphID !== 709 || root.activeTask !== "1.4.01_item_retrieval") return null;
  const target = require("../../space/runtime").getSceneForSession(session)?.getEntityByID(Number(targetEntityID));
  if (!target || !(target.kind === "sun" || Number(target.groupID) === 6)) return null;
  const site = ownedSite(session, state);
  return site ? { point: site.position, instanceID: site.instanceID, siteID: site.spawnState?.siteID } : null;
}
function taskEvidence(session, root, task, state) {
  const ship = characters.getActiveShipRecord(root.characterID);
  const fitting = require("../fitting/liveFittingState");
  switch (task) {
    case "frigates_arrived": case "orbiting_balin": case "fleet_arrived": case "frigates_destroyed": case "cruiser_destroyed": case "player_engaged_battleship": case "player_in_pod": case "player_dead": return combat.evidence(session, task);
    case "board_ship": case "ship_hud": case "start_repairing": case "balin_warping": return encounter.evidence(session, task);
    case "2.3.01_system_navigation_introduction":
    case "2.4.01_agent_introduction": case "2.4.02_skill_plan_reminder": case "2.4.03_opportunities_mission_reminder": return require("./airGuidanceRuntime").atCareerStation(session);
    case "2.5.01_acp_reward_reminder": return require("./airGuidanceRuntime").acpRewardReminderDone(session);
    case "2.2.01_move_ore": case "2.2.02_market_introduction": case "2.2.03_wallet_introduction": case "2.2.04_acp_goal_introduction": case "2.2.05_undock": return economy.evidence(session, task, state);
    case "2.1.01_enter_mining_site": case "2.1.02_mine_asteroid_1": case "2.1.03_mine_asteroid_2": case "2.1.04_mine_asteroid_3": case "2.1.05_loot_wreck": case "2.1.06_back_to_station": return mining.evidence(session, task, state);
    case "1.3.04_board_corvette": return Boolean(ship && ship.ownerID === root.characterID && !inventory.isCapsuleTypeID(ship.typeID));
    case "1.3.05_undock": return Boolean(session._space && ship?.locationID === Number(session.solarsystemid2 || session.solarsystemid));
    case "1.4.01_item_retrieval": return retrieved(session, state);
    case "1.5.02_online_module_attempt": return Boolean(ship && (fitting.getFittedModuleItems(root.characterID, ship.itemID).some(item => item.typeID === 78677) || state.fittingAttempt?.rootID === root.instanceID && state.fittingAttempt.shipID === ship.itemID));
    case "1.5.03_skill_introduction": return require("../skills/skillState").ensureCharacterSkills(root.characterID).some(skill => skill.typeID === 22578);
    case "1.5.06_online_module": return Boolean(ship && fitting.getFittedModuleItems(root.characterID, ship.itemID).some(item => item.typeID === 78677 && fitting.isEffectivelyOnlineModule(item)));
    // 2.5.02 (graph 684) and 2.5.03 (graph 705) are the Agency help page and the handoff
    // conversation: client UI only, asked for wherever the pilot is.
    default: return ["2.5.02_help_section_introduction", "2.5.03_handoff", "1.3.01_wake-up", "1.3.02_acp_reward_introduction", "1.3.03_redeeming_introduction", "1.5.01_fitting_introduction", "1.5.04_skill_point_introduction", "1.5.05_skill_plan_introduction", "1.5.07_opportunities_mission_introduction"].includes(task);
  }
}
function authorizeClientMessage(session, root, key, value) {
  const state = read(root.characterID);
  if (!eligible(session) || state?.rootID !== root.instanceID || state.status !== "active" || root.stopped) return false;
  if (["client_complete_task", "client_task_complete"].includes(key)) return typeof value === "string" && value === root.activeTask && taskEvidence(session, root, value, state);
  if (key === "client_npc_command") return encounter.authorizeCommand(session, root, value) || combat.authorizeCommand(session, root, value);
  if (root.graphID === 711) {
    const site = mining.siteFor(root.characterID);
    if (key === "client_action") return value === "warp_to_mining_dungeon" && Boolean(session._space && site && site.solarSystemID === Number(session.solarsystemid2 || session.solarsystemid));
    if (["client_enter_dungeon", "client_exit_dungeon"].includes(key)) return Boolean(site && (key === "client_enter_dungeon" ? mining.evidence(session, "2.1.01_enter_mining_site", state) : characters.getCharacterRecord(root.characterID).stationID));
  }
  const record = characters.getCharacterRecord(root.characterID), ship = characters.getActiveShipRecord(root.characterID);
  return key === "client_upgrade_missing" && value === null && root.graphID === 710 && Boolean(record.stationID || record.structureID) && !inventory.listOwnedItems(root.characterID).some(item => item.typeID === 78677 && [ship?.itemID, record.stationID, record.structureID].includes(item.locationID));
}
graphs.registerOwnerPolicy("air", {
  authorizeClientGraph(session, root, graphID) {
    return graphID === 716 || graphs.isClientGraphDescendant(CLIENT_CHAPTERS[root.graphID], graphID);
  },
  authorizeClientMessage,
  canPublish(session, root, event) {
    if (event.type === "OnStopClientNodeGraph") return true;
    if (!eligible(session)) return false;
    // "server_warped_to_dungeon" carries the client's arrival beacon. The graph sends the site
    // entity, which the client never sees from the warp-in point; send the site's asteroid.
    if (root.graphID === 711 && event.type === "OnClientNodeGraphMessage" && event.args?.[1] === "server_warped_to_dungeon") {
      const beacon = mining.beaconID(root.characterID);
      if (beacon) event.args[2] = beacon;
    }
    return true;
  },
  routeClientMessage(session, root, key, value) {
    if (!["client_complete_task", "client_task_complete"].includes(key)) return null;
    if (root.graphID === 686) return { messageKey: "client_complete_task" };
    return { handled: true, blackboard: { last_task_complete: value } };
  },
  afterClientMessage(session, root) {
    return serialized(root.characterID, async () => {
      if (!root.stopped) return combat.queueProgress(session, root);
      const state = read(root.characterID);
      if (!state || state.status !== "active" || state.rootID !== root.instanceID) return;
      state.rootID = null;
      save(root.characterID, state);
      if (sessions.get(root.characterID) === session && !session.socket?.destroyed) await ensureNow(session);
    });
  },
});

function ensureForSession(session) {
  return serialized(resolveSessionCharacterID(session), async () => {
    const result = await ensureNow(session);
    require("./airOpportunityRuntime").restore(session);
    return result;
  });
}
function prepareForSelection(session) {
  const characterID = resolveSessionCharacterID(session);
  if (!characterID || !eligible(session) || activePhase(characterID)?.graphID !== 685) return;
  encounter.prepareForSelection(session, read(characterID) || {
    version: 1, characterID, runID: crypto.randomUUID(), status: "active", rootID: null,
  });
}
async function ensureNow(session) {
  const characterID = resolveSessionCharacterID(session);
  if (!characterID) return { success: false, errorMsg: "CHARACTER_REQUIRED" };
  if (session.socket?.destroyed) return { success: false, errorMsg: "AIR_SESSION_DISCONNECTED" };
  if (!eligible(session)) { await cleanupNow(characterID); return { success: true, active: false }; }
  const phase = activePhase(characterID);
  let state = read(characterID) || { version: 1, characterID, runID: crypto.randomUUID(), status: "active", rootID: null };
  if (state.status !== "active") return { success: true, active: false };
  const alreadyAttached = sessions.get(characterID) === session;
  let root = activeRoot(session);
  if (root && !root.stopped) {
    if (!PHASES.some(entry => entry.graphID === root.graphID) || root.graphID !== phase?.graphID && !root.queue.length && !root.failure) throw graphError("AIR_GRAPH_PHASE_CONFLICT");
    // Ordinary disconnect removes the pilot Ball and its pending companion warp.
    // A durable active graph must resume that transition too, before this new
    // attachment is remembered (so a refused resume remains retryable).
    if (!alreadyAttached && [685, 686].includes(root.graphID) && encounter.waiting(characterID)) await encounter.resumePending(session);
    sessions.set(characterID, session);
    if ([685, 686].includes(root.graphID)) state = await encounter.ensure(session, state, phase, root);
    const birth = birthBlackboard(characterID, state);
    if (Object.entries(birth).some(([key, value]) => root.blackboard[key] !== value || !root.publicBlackboardKeys.includes(key))) {
      root = await graphs.updateRootBlackboard(session, root.instanceID, birth, { publicBlackboardKeys: Object.keys(birth), publishToClient: true, deferExecution: true });
    }
    if (phase?.graphID === 709) state = ensureRetrievalSite(session, state);
    if (phase?.graphID === 712) state = economy.prepare(session, state);
    if (root.graphID === 711 && phase?.graphID === 711) {
      state = mining.ensureSite(session, state, root);
      // Also when only the wreck (re-created) or the beacon changed: the client's wreck signal
      // and "stop the ship" sequence wait for the current wreck, and the beacon value is
      // client-only memory, gone after a relog. The client master gets the root blackboard
      // when it starts.
      const updates = miningBlackboard(state, root);
      if (state.miningInstanceID && ["entry_item_id_mining_dungeon", "wreck_item_id", "2.1._beacon_item_id"].some(key => (root.blackboard[key] ?? null) !== (updates[key] ?? null))) {
        await graphs.updateRootBlackboard(session, root.instanceID, updates, { publishToClient: true });
      }
    }
    // A final checkpoint can commit before its graph's terminal stop. Finish
    // that saved queue before selecting the next chapter, including CP 50.
    const resumed = alreadyAttached && !root.failure && !root.queue.length ? root : await graphs.resumeSession(session, root.instanceID);
    if (resumed.stopped) {
      save(characterID, { ...read(characterID), rootID: null });
      return ensureNow(session);
    }
    if (resumed.graphID === 686) await combat.queueProgress(session, resumed);
    return { success: true, active: true, root: resumed };
  }
  if (encounter.waiting(characterID)) {
    await encounter.resumePending(session);
    // Scene 1.2 runs during the fleet warp (airEncounterRuntime "fleet-warp").
    if (phase?.graphID !== 686) return { success: true, active: true, pendingArrival: true };
  }
  if (!phase) return { success: false, errorMsg: "AIR_ENCOUNTER_GRAPH_UNSUPPORTED", checkpoint: checkpoint(characterID) };
  sessions.set(characterID, session);
  save(characterID, state);
  if ([685, 686].includes(phase.graphID)) state = await encounter.ensure(session, state, phase);
  if (phase.graphID === 709) state = ensureRetrievalSite(session, state);
  if (phase.graphID === 711) state = mining.ensureSite(session, state);
  if (phase.graphID === 712) state = economy.prepare(session, state);
  // Resolve a graph committed just before AIR's root pointer was persisted.
  const committed = graphs.listForSession(session).find(entry => !entry.stopped && entry.graphID === phase.graphID && entry.ownerKey === "air");
  state.phaseGraphID = phase.graphID;
  save(characterID, state);
  const started = await (committed ? graphs.resumeSession(session, committed.instanceID) : graphs.startServerGraph(session, phase.graphID, {
    ownerKey: "air", sceneKey: null, clientScene: phase.scene, startClientGraphIDs: [716], clientGraphIDs: [716],
    ...(phase.graphID === 686 ? { clientTask: "frigates_arrived" } : {}),
    blackboard: { character_id: characterID, ...birthBlackboard(characterID, state), solar_system_id: Number(session.solarsystemid2 || session.solarsystemid), dungeon_spawn_id: state.siteInstanceID || null, ...(phase.graphID === 711 ? miningBlackboard(state) : {}), ...([685, 686].includes(phase.graphID) ? encounter.blackboard(characterID) : {}) },
    publicBlackboardKeys: ["birth_station_id", "birth_system_id", "active_scene", "active_task", "character_id", "solar_system_id", "dungeon_spawn_id", ...([685, 686].includes(phase.graphID) ? Object.keys(encounter.blackboard(characterID)) : []), ...(phase.graphID === 711 ? ["mining_dungeon_spawn_id", "mining_solar_system_id", "entry_point_mining_dungeon", "entry_item_id_mining_dungeon", "wreck_item_id"] : [])],
  }));
  // Starting a graph can commit owner actions into this same character state.
  // Retain those writes when publishing its root pointer.
  save(characterID, { ...read(characterID), rootID: started.instanceID });
  if (started.graphID === 686) await combat.queueProgress(session, started);
  return { success: true, active: true, root: started };
}
function miningBlackboard(state, root = null) {
  const site = mining.siteFor(state.characterID);
  const offset = site && require("../dungeon/dungeonAuthority").getTemplateByID(mining.TEMPLATE_ID).airEncounter.mining.entryOffset;
  // The operation owner can prepare a bookmark before warp. The graph must
  // still run its setup subgraph once: that edge arms its actor/state watchers.
  // Only the authored setup output publishes the spawn ID to the graph.
  return { mining_dungeon_spawn_id: root?.blackboard.mining_dungeon_spawn_id || null, mining_solar_system_id: site?.solarSystemID || state.miningSystemID || null, entry_item_id_mining_dungeon: site?.spawnState.siteID || null, wreck_item_id: state.miningWreckID || null, "2.1._beacon_item_id": mining.beaconID(state.characterID) || root?.blackboard["2.1._beacon_item_id"] || null, entry_point_mining_dungeon: offset ? { x: site.position.x + offset.x, y: site.position.y + offset.y, z: site.position.z + offset.z } : null };
}
function cleanup(characterID) { return serialized(characterID, () => cleanupNow(characterID)); }
async function cleanupNow(characterID) {
  const state = read(characterID);
  if (!state || state.status === "stopped" || state.status === "completed" && !state.rootID) return;
  await graphs.stopOwnedGraphs(characterID, "air");
  await encounter.cleanup(characterID);
  const miningSite = mining.siteFor(characterID);
  if (miningSite) {
    mining.purgeSite(characterID);
  }
  require("../dungeon/operationSiteRuntime").removeOperationSpawnpointRecord(characterID, 2674);
  if (state.siteInstanceID) {
    const dungeonRuntime = require("../dungeon/dungeonRuntime"), site = dungeonRuntime.getInstance(state.siteInstanceID);
    if (site?.ownership?.characterID === characterID && site.metadata?.operationKey === `air:${state.runID}:retrieval`) {
      requireSuccess(require("../dungeon/dungeonUniverseSiteService").purgePrivateOperationForCharacter(characterID, site.instanceID, `air:${state.runID}:retrieval`));
      requireSuccess(require("../../gameStore").flushTableSync("dungeonRuntimeState"));
    }
  }
  require("../dungeon/operationSiteRuntime").removeOperationSpawnpointRecord(characterID, 2594);
  sessions.delete(characterID);
  save(characterID, { ...read(characterID), status: state.completion ? "completed" : "stopped", rootID: null });
}
function handleSessionDisconnected(session) {
  const characterID = resolveSessionCharacterID(session);
  if (sessions.get(characterID) === session) sessions.delete(characterID);
  require("../dungeon/operationSiteRuntime").removeOperationSpawnpointRecord(characterID, 2594);
  require("../dungeon/operationSiteRuntime").removeOperationSpawnpointRecord(characterID, 2674);
  for (const operationID of [2423, 2433]) require("../dungeon/operationSiteRuntime").removeOperationSpawnpointRecord(characterID, operationID);
}
function startSite(session, categoryID, operationID) { return serialized(resolveSessionCharacterID(session), () => startSiteNow(session, categoryID, operationID)); }
async function startSiteNow(session, categoryID, operationID) {
  if (Number(categoryID) !== 2122 || Number(operationID) !== activePhase(resolveSessionCharacterID(session))?.operationID || !eligible(session)) return false;
  return (await ensureNow(session)).success;
}
require("./tutorialLifecycle").subscribe(cleanup);
require("../nodegraph/nodeGraphEvents").subscribe((session, atomID) => { if (atomID === 305) handleSessionDisconnected(session); });
require("../nodegraph/nodeGraphEvents").subscribe((session, atomID) => { if (atomID === 190) encounter.handleBoarding(session); });
require("../nodegraph/nodeGraphEvents").subscribe((session, event, details) => {
  if (event !== "inventory.fitting-refused" || details.typeID !== 78677 || !eligible(session)) return;
  const characterID = resolveSessionCharacterID(session), state = read(characterID), root = activeRoot(session);
  const item = inventory.findItemById(details.itemID), ship = characters.getActiveShipRecord(characterID);
  if (!root || root.stopped || root.activeTask !== "1.5.02_online_module_attempt" || item?.ownerID !== characterID || ship?.itemID !== details.shipID) return;
  state.fittingAttempt = { rootID: root.instanceID, shipID: ship.itemID, itemID: item.itemID, reason: String(details.reason) };
  save(characterID, state);
});
encounter.configure({ ensureForSession });
// The tutorial has the pilot queue skills (1.5.03 and later) and expects them to train. A second
// character on an account whose training slot is in use could not; while its tutorial runs, its
// client is told of a free slot (userService.getSessionTrainingSlots). A valid activation
// pauses only enough other queues to fit the licensed slots; paused saves preserve them
// (skillQueueRuntime.saveQueue).
function isTutorialActive(characterID) { return read(characterID)?.status === "active"; }
module.exports = { PHASES, prepareForSelection, ensureForSession, authorizeClientMessage, cleanup, handleSessionDisconnected, startSite, retrievalWarpTarget, onRetrievalWreckOpened, isTutorialActive };
