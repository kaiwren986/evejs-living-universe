"use strict";

const config = require("../../config");
const { distance } = require("../../common/vector");
const { getWallclockNowMs, toFileTimeFromMs } = require("../../space/runtime/runtimeClock");
const { buildDict } = require("../_shared/serviceHelpers");
const character = require("../character/characterState");
const dungeon = require("../dungeon/dungeonRuntime");
const items = require("../inventory/itemStore");
const log = require("../../utils/logger");
const world = require("../../space/worldData");
const { RUINED_ELECTRICAL, VOID_SPACE_JUMP_ERROR: E, isVoidSystemID, validateReplayAdmission } = require("./voidReplayAdmission");
const { ROOM_ORIGIN, VOID_REPLAY_ORIGIN, createReplayRoom, isVoidReplayInstance, materializeReplayRoom } = require("./voidReplayRoom");

const VOID_EXPIRY_TIMER_TYPE = 16;
const ORIGIN_GATE_RANGE_M = 2500;
const REPLAY_BOUNDARY_RADIUS_M = 55_000;
const pendingCharacters = new Set();
const collapsingInstances = new Set();

function checked(result) {
  if (!result?.success) throw new Error(result?.errorMsg || "VOID_REPLAY_OWNER_UNAVAILABLE");
  return result.data;
}

function getReplay(characterID) {
  const instance = dungeon.findInstanceBySiteKey(`${VOID_REPLAY_ORIGIN}:${characterID}`, { activeOnly: true, full: true });
  return isVoidReplayInstance(instance) ? instance : null;
}

function getReplayInSystem(systemID) {
  if (!isVoidSystemID(systemID)) return null;
  return dungeon.listActiveInstancesBySystem(systemID, { full: true }).find(isVoidReplayInstance) || null;
}

function getState(instance) {
  return instance?.environmentState?.voidReplay;
}

function persistState(instance, patch) {
  return dungeon.mergeEnvironmentStateDurably(instance.instanceID, {
    voidReplay: { ...getState(instance), ...patch },
  });
}

function receiptKey(instance, operation) {
  return `void-replay:${instance.instanceID}:${operation}`;
}

function allocateSystem() {
  for (const system of world.getSolarSystems()) {
    const id = system.solarSystemID;
    if (isVoidSystemID(id) && !getReplayInSystem(id) && items.listSystemSpaceItems(id).length === 0) return id;
  }
  return null;
}

// Ordinary system moves may not enter or leave a reserved replay system.
// Shared travel accepts this authorization only for the recorded pilot, ship
// and leg of the durable run. No client method takes these options.
function authorizeTransfer(session, destinationID, instanceID) {
  const sourceID = Number(session._space?.systemID || session.solarsystemid2);
  const source = getReplayInSystem(sourceID);
  const destination = getReplayInSystem(destinationID);
  if (!source && !destination) return null;
  const instance = source || destination;
  const state = getState(instance);
  if (instance.instanceID !== instanceID || instance.ownership.characterID !== Number(session.characterID) ||
      state?.shipID !== Number(session.shipID || session.shipid)) return false;
  const entering = !source && state.phase === "entering" && state.originSystemID === sourceID;
  const exiting = !destination && state.phase === "exiting" && state.originSystemID === destinationID;
  if (!entering && !exiting) return false;
  return {
    transitionID: receiptKey(instance, entering ? "enter" : "exit"),
    characterID: instance.ownership.characterID,
    shipID: state.shipID,
    sourceSystemID: sourceID,
    destinationSystemID: destinationID,
  };
}

function transfer(session, instance, targetSystemID, position, direction) {
  return require("../../space/transitions").jumpSessionToSolarSystem(session, targetSystemID, {
    voidReplayInstanceID: instance.instanceID,
    spawnStateOverride: { position, direction, anchorType: "void-replay", anchorID: instance.instanceID },
    countsTowardJumpGoal: false,
  });
}

function closeReplay(instance, lifecycle, reason) {
  const space = require("../../space/runtime");
  const scenes = require("../dungeon/dungeonUniverseSiteService");
  const scene = space.scenes.get(`solar-system:${instance.solarSystemID}`);
  const cleanup = {
    instance,
    instanceID: instance.instanceID,
    siteID: instance.metadata.siteID,
  };
  if (scene) {
    scenes.removeSceneSiteContent(scene, cleanup.siteID, cleanup);
    scene.removeStaticEntity(cleanup.siteID);
  } else {
    scenes.removeStoredDungeonSiteContent(instance.solarSystemID, cleanup);
  }
  if (!require("../../gameStore").flushTableSync("items").success) throw new Error("VOID_REPLAY_CLEANUP_PENDING");
  const closed = dungeon.setLifecycleState(instance.instanceID, lifecycle, { lifecycleReason: reason, durable: true });
  if (scene) delete scene._voidReplay;
  return closed;
}

function compensateUnentered(instance, session) {
  const state = getState(instance);
  if (state.phase !== "entering") return;
  const ship = items.findShipItemById(state.shipID);
  if (!ship || Number(ship.locationID) !== state.originSystemID) return;
  const consumed = items.getIdempotentGrantReceipt(receiptKey(instance, "filament"), { reconcileWriteRefusal: true });
  if (!consumed.success) throw new Error(consumed.errorMsg || "VOID_REPLAY_CONSUMPTION_UNCERTAIN");
  if (consumed.data) {
    const refund = items.grantItemToOwnerLocationIdempotent(
      instance.ownership.characterID, state.shipID, items.ITEM_FLAGS.CARGO_HOLD,
      RUINED_ELECTRICAL.filamentTypeID, 1, { receiptKey: receiptKey(instance, "refund") },
    );
    if (!refund.success) throw new Error(refund.errorMsg || "VOID_REPLAY_REFUND_PENDING");
    if (!refund.duplicate && session) character.emitItemsChangedBatchForSession(session, refund.data.changes);
  }
  closeReplay(instance, "failed", "void-entry-cancelled");
  if (session && !session._space) require("../../space/transitions").restoreSpaceSession(session);
}

function sendReady(scene, session, instance, relog) {
  const remainingMs = Math.max(0, getState(instance).expiresAtMs - getWallclockNowMs());
  const endTime = toFileTimeFromMs(scene.getCurrentSimTimeMs() + remainingMs);
  const fields = [
    ["content_id", instance.instanceID],
    ["nebula_graphic_id", RUINED_ELECTRICAL.nebulaGraphicID],
  ];
  if (relog) fields.push(["end_time", endTime]);
  session.sendNotification(relog ? "OnVoidSpaceRelog" : "OnVoidSpaceEntered", "charid", [buildDict(fields)]);
  if (!relog) session.sendNotification("OnAddExpiryDurationForVoidSpaceContent", "charid", [endTime]);
}

function readyRoom(session, instance, relog, notify = true) {
  const space = require("../../space/runtime");
  const scene = space.getSceneForSession(session);
  const result = materializeReplayRoom(scene, instance, session);
  if (!result.success) throw new Error(result.errorMsg || "VOID_REPLAY_ROOM_UNAVAILABLE");
  if (getState(instance).phase === "entering") {
    instance = persistState(instance, { phase: "entered" });
  }
  scene._voidReplay = {
    instanceID: instance.instanceID,
    characterID: instance.ownership.characterID,
    shipID: getState(instance).shipID,
    expiresAtMs: getState(instance).expiresAtMs,
  };
  const ship = scene.getShipEntityForSession(session);
  if (ship?.itemID === scene._voidReplay.shipID && !ship.voidReplayElectrical) {
    ship.voidReplayElectrical = true;
    checked(space.refreshShipDerivedState(session, { notifyTargeting: true, notifyGenericModuleAttributes: true }));
  }
  if (notify) sendReady(scene, session, instance, relog);
  return result;
}

function enterReplay(admission) {
  const { actor, key } = admission;
  const systemID = allocateSystem();
  if (!systemID) return { errors: [[E.UNKNOWN_ERROR, []]] };
  const instance = createReplayRoom(systemID, actor.characterID, {
    phase: "entering",
    shipID: actor.shipID,
    originSystemID: actor.scene.systemID,
    originPosition: actor.ship.position,
    originDirection: actor.ship.direction,
    expiresAtMs: getWallclockNowMs() + RUINED_ELECTRICAL.durationMs,
  }, getWallclockNowMs());
  try {
    const consumed = items.consumeInventoryItemQuantityIdempotent(key.itemID, 1, {
      receiptKey: receiptKey(instance, "filament"),
      fingerprint: { itemID: key.itemID, typeID: key.typeID, characterID: actor.characterID, shipID: actor.shipID },
    });
    if (!consumed.success) throw new Error(consumed.errorMsg);
    if (!consumed.duplicate) character.emitItemsChangedBatchForSession(actor.session, consumed.data.changes);
    const jump = transfer(actor.session, instance, systemID, ROOM_ORIGIN, { x: 1, y: 0, z: 0 });
    if (!jump.success) throw new Error(jump.errorMsg);
    readyRoom(actor.session, instance, false);
    return { errors: [], boundResult: jump.data.boundResult };
  } catch (error) {
    log.warn(`[VoidReplay] Entry for instance ${instance.instanceID} needs reconciliation: ${error.message}`);
    compensateUnentered(instance, actor.session);
    return { errors: [[E.UNKNOWN_ERROR, []]] };
  }
}

async function startReplay(itemID, typeID, session) {
  if (config.voidReplayEnabled !== true) return { errors: [[E.UNKNOWN_ERROR, []]] };
  const first = validateReplayAdmission(itemID, typeID, session);
  if (first.errors.length) return first;
  const { characterID, shipID, scene } = first.actor;
  if (pendingCharacters.has(characterID) || getReplay(characterID)) return { errors: [[E.VOID_SPACE_DISALLOWED, []]] };
  pendingCharacters.add(characterID);
  try {
    await new Promise((resolve) => setTimeout(resolve, RUINED_ELECTRICAL.activationDelayMs));
    if (config.voidReplayEnabled !== true) return { errors: [[E.UNKNOWN_ERROR, []]] };
    const admission = validateReplayAdmission(itemID, typeID, session);
    if (admission.errors.length) return admission;
    if (admission.actor.scene !== scene || admission.actor.shipID !== shipID || getReplay(characterID)) {
      return { errors: [[E.SESSION_CHANGE_IN_PROGRESS, [characterID]]] };
    }
    return enterReplay(admission);
  } finally {
    pendingCharacters.delete(characterID);
  }
}

function exitReplay(gateID, session) {
  let instance = getReplay(session?.characterID);
  const state = getState(instance);
  const scene = require("../../space/runtime").getSceneForSession(session);
  const ship = scene?.getShipEntityForSession(session);
  const gate = scene?.getEntityByID(gateID);
  if (!state || state.phase !== "entered" || state.expiresAtMs <= getWallclockNowMs() ||
      scene?.systemID !== instance.solarSystemID || ship?.itemID !== state.shipID ||
      ship.destroyed || ship.mode === "WARP" || gate?.typeID !== RUINED_ELECTRICAL.originGateTypeID ||
      gate.dungeonSiteInstanceID !== instance.instanceID ||
      distance(ship.position, gate.position) - ship.radius - gate.radius > ORIGIN_GATE_RANGE_M) return null;
  instance = persistState(instance, { phase: "exiting" });
  const jump = transfer(session, instance, state.originSystemID, state.originPosition, state.originDirection);
  if (!jump.success) {
    if (items.findShipItemById(state.shipID)?.locationID === instance.solarSystemID) {
      persistState(instance, { phase: "entered" });
    }
    return null;
  }
  closeReplay(instance, "completed", "void-origin-conduit");
  session.sendNotification("OnVoidSpaceContentFinished", "charid", [instance.instanceID, VOID_EXPIRY_TIMER_TYPE]);
  return jump;
}

function clientIsReady(session) {
  const instance = getReplay(session?.characterID);
  const state = getState(instance);
  if (state && ["entering", "entered"].includes(state.phase) &&
      character.getActiveShipRecord(session.characterID)?.itemID === state.shipID &&
      Number(session._space?.systemID) === instance.solarSystemID) {
    readyRoom(session, instance, true);
  }
  return null;
}

function snapshotDeath(instance, ship, liveSession) {
  const death = require("../../space/shipDestruction");
  const characterID = instance.ownership.characterID;
  const scene = {
    systemID: instance.solarSystemID,
    sceneKey: `solar-system:${instance.solarSystemID}`,
    sceneKind: "solarSystem",
    sceneDescriptor: { systemID: instance.solarSystemID },
    getCurrentSimTimeMs: getWallclockNowMs,
  };
  const key = receiptKey(instance, `collapse:${ship.itemID}`);
  const entity = { ...ship, ...ship.spaceState, pilotCharacterID: characterID };
  const plan = death.prepareDurableShipDeath(entity, ship, key, scene, liveSession || {
    characterID,
    homeStationID: character.peekCharacterRecord(characterID)?.homeStationID,
  }, { suppressWreck: true });
  if (plan.capsule) {
    plan.durablePodDeathKey = key;
    plan.cloneImplants = structuredClone(character.peekCharacterRecord(characterID)?.implants || []);
  }
  return plan;
}

function settleCollapseLoss(plan, session) {
  const death = require("../../space/shipDestruction");
  if (session?._space?.shipID === plan.shipRecord.itemID &&
      items.findShipItemById(plan.shipRecord.itemID)) {
    checked(death.destroySessionShip(session, {
      deathReceipt: plan,
      destructionReason: "void-space-collapse",
      sessionChangeReason: "voidSpaceCollapse",
      suppressWreck: true,
    }));
  }
  if (plan.capsule) checked(death.finishDurablePodDeath(plan, session));
  else checked(death.finishDurableShipDeathHandoff(plan));
  const settled = checked(death.settleDurableShipDeath(plan));
  if (settled.debrisID && items.findItemById(settled.debrisID)) {
    const scene = require("../../space/runtime").scenes.get(`solar-system:${plan.systemID}`);
    if (scene?.getEntityByID(settled.debrisID)) {
      scene.removeDynamicEntity(settled.debrisID, { broadcast: true });
    }
    checked(items.removeInventoryItem(settled.debrisID, { removeContents: true }));
  }
  checked(require("../../gameStore").flushTablesSync(["characters", "items", "insuranceContracts", "notifications"]));
}

function collapseReplay(instance, session = null) {
  if (collapsingInstances.has(instance.instanceID)) return;
  collapsingInstances.add(instance.instanceID);
  try {
    let state = getState(instance);
    if (state.phase !== "collapsing") {
      instance = persistState(instance, { phase: "collapsing" });
      state = getState(instance);
    }
    const originalHull = items.findShipItemById(state.shipID);
    if (!state.hullDeath && originalHull?.locationID === instance.solarSystemID) {
      instance = persistState(instance, { hullDeath: snapshotDeath(instance, originalHull, session) });
      state = getState(instance);
    }
    if (state.hullDeath) settleCollapseLoss(state.hullDeath, session);

    const capsule = character.getActiveShipRecord(instance.ownership.characterID);
    if (!state.podDeath && items.isCapsuleTypeID(capsule?.typeID) &&
        capsule.locationID === instance.solarSystemID) {
      instance = persistState(instance, { podDeath: snapshotDeath(instance, capsule, session) });
      state = getState(instance);
    }
    if (state.podDeath) settleCollapseLoss(state.podDeath, session);
    if (character.getActiveShipRecord(instance.ownership.characterID)?.locationID === instance.solarSystemID) {
      throw new Error("VOID_REPLAY_COLLAPSE_PENDING");
    }
    closeReplay(instance, "failed", "void-space-collapse");
    session?.sendNotification("OnVoidSpaceContentFinished", "charid", [instance.instanceID, VOID_EXPIRY_TIMER_TYPE]);
  } finally {
    collapsingInstances.delete(instance.instanceID);
  }
}

function reconcileBeforeSelection(characterID) {
  if (pendingCharacters.has(characterID)) return;
  const instance = getReplay(characterID);
  if (!instance) return;
  const state = getState(instance);
  const ship = items.findShipItemById(state.shipID);
  const systemID = ship?.locationID;
  if (state.phase === "entering" && systemID === state.originSystemID) {
    compensateUnentered(instance);
    return;
  }
  if (state.phase === "exiting" && systemID === state.originSystemID) {
    syncCharacterLocation(characterID, systemID);
    closeReplay(instance, "completed", "void-origin-conduit");
    return;
  }
  if (state.phase === "collapsing" || state.expiresAtMs <= getWallclockNowMs() ||
      systemID !== instance.solarSystemID) {
    collapseReplay(instance);
    return;
  }
  syncCharacterLocation(characterID, systemID);
  if (state.phase === "exiting") persistState(instance, { phase: "entered" });
}

function syncCharacterLocation(characterID, systemID) {
  const current = character.peekCharacterRecord(characterID);
  if (current.solarSystemID === systemID && !current.stationID && !current.structureID) return;
  const system = world.getSolarSystemByID(systemID);
  checked(character.updateCharacterRecord(characterID, (record) => ({
    ...record, stationID: null, structureID: null, solarSystemID: systemID,
    constellationID: system.constellationID, regionID: system.regionID, worldSpaceID: 0,
  }), { expectedLocationTransitionReason: "void-replay-recovery" }));
  checked(require("../../gameStore").flushTableSync("characters"));
}

function restoreRoom(session) {
  const instance = getReplay(session?.characterID);
  if (instance && Number(session._space?.systemID) === instance.solarSystemID) {
    readyRoom(session, instance, true, false);
  }
}

function tickScene(scene) {
  const replay = scene._voidReplay;
  if (!replay) return;
  const session = require("../chat/sessionRegistry").findSessionByCharacterID(replay.characterID);
  if (!session) return;
  const ship = scene.getShipEntityForSession(session);
  if (!ship) return;
  if (getWallclockNowMs() >= replay.expiresAtMs || ship.itemID !== replay.shipID) {
    const instance = getReplay(replay.characterID);
    if (instance?.instanceID === replay.instanceID) collapseReplay(instance, session);
    return;
  }
  const { x, y, z } = ship.position;
  const radius = Math.hypot(x, y, z);
  if (radius >= REPLAY_BOUNDARY_RADIUS_M) {
    const scale = -(REPLAY_BOUNDARY_RADIUS_M - 1000) / radius;
    scene.teleportDynamicEntityToPoint(ship.itemID, { x: x * scale, y: y * scale, z: z * scale });
  }
}

module.exports = { authorizeTransfer, clientIsReady, exitReplay, reconcileBeforeSelection, restoreRoom, startReplay, tickScene };
