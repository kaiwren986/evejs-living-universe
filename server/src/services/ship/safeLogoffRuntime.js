"use strict";

// A safe-logoff lease belongs to one live transport and one controlled entity.
// It is deliberately ephemeral: restarting cannot resume a client's countdown.
const { randomUUID } = require("node:crypto");
const { resolveSessionCharacterID } = require("../_shared/sessionIdentity");
const registry = require("../chat/sessionRegistry");
const characterState = require("../character/characterState");
const { getWallclockNowMs, toFileTimeFromMs } = require("../../space/runtime/runtimeClock");
const { canEntitiesInteractLocally, buildChildEntityScopeMetadata } = require("../../space/destiny/identity/interactionScope");
const { isEntityCloaked, isCloakingModuleEffectState } = require("../../space/runtime/shipCloak");
const DURATION_MS = 30000;
const START_INTENT = Symbol("safe-logoff-response-intent");
// Localization labels the client shows (gameui.py: OnSafeLogoffFailed lists each failed
// condition under UI/Inflight/SafeLogoff/ConditionsFailedHeader, OnSafeLogoffAborted shows one
// reason). Paths as in the client's localization; a path it does not have shows "[no label]".
const condition = suffix => `UI/Inflight/SafeLogoff/Condition${suffix}`;
const LABELS = Object.freeze({
  ALREADY_IN_PROGRESS: "UI/Messages/3876/SafeLogoffAlreadyInProgressBody",
  PVP_TIMER: condition("PvpTimer"),
  PVE_TIMER: condition("PveTimer"),
  IN_FLEET: condition("InFleet"),
  CLOAKED: condition("Cloaked"),
  ACTIVE_MODULES: condition("ActiveModules"),
  ACTIVE_PROBES: condition("ActiveProbes"),
  DRONES_CONNECTED: condition("DronesConnected"),
  TARGETED: condition("TargetLocked"),
  TARGET_LOCKING: condition("TargetLock"),
  MOVEMENT_ACTIVE: condition("ShipOrbitingOrKeepingAtRange"),
  WARPING: condition("ShipInWarp"),
  ESS_LINKED: condition("LinkedToESS"),
  ESS_UNLOCKED: condition("UnlockedReserveBank"),
});
// What a running safe logoff was aborted by (OnSafeLogoffAborted), per condition.
const ABORT_LABELS = Object.freeze({
  [LABELS.ACTIVE_MODULES]: "UI/Inflight/SafeLogoff/AbortModuleActivated",
  [LABELS.MOVEMENT_ACTIVE]: "UI/Inflight/SafeLogoff/AbortShipMovement",
  [LABELS.TARGET_LOCKING]: "UI/Inflight/SafeLogoff/AbortShipTargeting",
  [LABELS.TARGETED]: "UI/Inflight/SafeLogoff/AbortShipTargeted",
  [LABELS.IN_FLEET]: "UI/Inflight/SafeLogoff/AbortInFleet",
  [LABELS.PVP_TIMER]: "UI/Inflight/SafeLogoff/AbortPvpTimer",
  [LABELS.PVE_TIMER]: "UI/Inflight/SafeLogoff/AbortNpcTimer",
  [LABELS.WARPING]: "UI/Inflight/SafeLogoff/AbortShipWarping",
  [LABELS.CLOAKED]: "UI/Inflight/SafeLogoff/AbortLostCloak",
  [LABELS.DRONES_CONNECTED]: "UI/Inflight/SafeLogoff/AbortDronesConnected",
});
const LABEL_ORDER = Object.values(LABELS);
function space() { return require("../../space/runtime"); }
function resolvePilot(session) {
  const characterID = resolveSessionCharacterID(session);
  if (!characterID || !session.socket || session.socket.destroyed ||
      session._characterControlDisconnected === true || !registry.isRegisteredSession(session) ||
      registry.findSessionByCharacterID(characterID) !== session)
    return { success: false, errorMsg: "SAFE_LOGOFF_LIVE_SESSION_REQUIRED" };
  if (!session._space || session.stationid || session.stationID || session.structureid || session.structureID)
    return { success: false, errorMsg: "SAFE_LOGOFF_NOT_IN_SPACE" };
  const ship = characterState.getActiveShipRecord(characterID);
  const scene = space().getSceneForSession(session);
  const entity = scene && ship && scene.getEntityByID(ship.itemID);
  if (!ship || !scene || !entity || entity.kind !== "ship" || entity.session !== session ||
      entity.sceneKey !== scene.sceneKey || Number(ship.ownerID) !== characterID || ship.flagID !== 0 ||
      ship.transient === true || Number(ship.locationID) !== Number(scene.systemID) ||
      Number(session._space.shipID) !== Number(ship.itemID) ||
      Number(session.shipID || session.shipid) !== Number(ship.itemID) ||
      Number(entity.pilotCharacterID || entity.characterID) !== characterID ||
      !Array.from(scene.sessions.values()).includes(session))
    return { success: false, errorMsg: "SAFE_LOGOFF_SHIP_AUTHORITY_MISMATCH" };
  return { success: true, characterID, ship, scene, entity };
}
function exactPilot(session, record, requireLease = true) {
  const context = resolvePilot(session);
  return context.success && (!requireLease || record === session._safeLogoff) && record.clientID === session.clientID &&
    record.sessionID === String(session.sessionID ?? session.sid) &&
    record.characterID === context.characterID && record.shipID === Number(context.ship.itemID) &&
    record.scene === context.scene && record.entity === context.entity && record.spaceState === session._space &&
    record.sceneKey === context.scene.sceneKey && record.instanceID === String(context.scene.instanceID || "") &&
    record.scope === JSON.stringify(buildChildEntityScopeMetadata(context.entity))
    ? context : null;
}
function collectFailedConditions(session, { includeProgress = true, nowMs = getWallclockNowMs(), context = resolvePilot(session) } = {}) {
  if (!context.success) return { ...context, labels: [] };
  const { characterID, ship, scene, entity } = context;
  const labels = [];
  const add = condition => { if (!labels.includes(condition)) labels.push(condition); };
  if (includeProgress && session._safeLogoff) add(LABELS.ALREADY_IN_PROGRESS);
  const timers = require("../security/crimewatchState").getCharacterCrimewatchState(characterID, nowMs) || {};
  if (timers.pvpTimerExpiresAtMs > nowMs || timers.weaponTimerExpiresAtMs > nowMs) add(LABELS.PVP_TIMER);
  if (timers.npcTimerExpiresAtMs > nowMs) add(LABELS.PVE_TIMER);
  if (require("../fleets/fleetRuntime").getFleetForCharacter(characterID)) add(LABELS.IN_FLEET);
  const modules = space().getActiveModuleContextsForSession(session, { genericOnly: false });
  if (isEntityCloaked(entity) || modules.some(context => isCloakingModuleEffectState(context.effectState))) add(LABELS.CLOAKED);
  if (modules.some(context => !isCloakingModuleEffectState(context.effectState)) ||
      require("./selfDestructRuntime").isShipSelfDestructing(ship.itemID)) add(LABELS.ACTIVE_MODULES);
  const probes = require("../exploration/probes/probeRuntimeState").getCharacterProbeLaunchCapState(
    characterID, scene.systemID, { scopeMetadata: buildChildEntityScopeMetadata(entity) });
  if (!probes.valid || probes.probes.some(probe =>
    canEntitiesInteractLocally(entity, { ...probe, ...probe.scopeMetadata }))) add(LABELS.ACTIVE_PROBES);
  for (const other of [...scene.dynamicEntities.values(), ...scene.staticEntities.values()]) {
    if (!canEntitiesInteractLocally(entity, other)) continue;
    if ((other.kind === "fighter" || (other.kind === "drone" && other.droneStateVisible !== false)) &&
        Number(other.controllerID) === Number(ship.itemID)) add(LABELS.DRONES_CONNECTED);
    if (other !== entity && (other.lockedTargets?.has(Number(ship.itemID)) ||
        other.pendingTargetLocks?.has(Number(ship.itemID)) || entity.targetedBy?.has(Number(other.itemID)))) add(LABELS.TARGETED);
  }
  if (entity.lockedTargets?.size || entity.pendingTargetLocks?.size) add(LABELS.TARGET_LOCKING);
  if (entity.mode === "FOLLOW" || entity.mode === "ORBIT" || entity.followRange > 0 || entity.orbitDistance > 0)
    add(LABELS.MOVEMENT_ACTIVE);
  if (entity.mode === "WARP") add(LABELS.WARPING);
  const ess = require("../dynamic/dynamicResourceState").getSystemState(scene.systemID);
  if (ess?.mainBankLink?.characterID === characterID || ess?.reserveLinkedCharacterIDs.has(characterID)) add(LABELS.ESS_LINKED);
  if (ess?.reserveBankPulsesRemaining > 0 && ess.reserveUnlockerCharacterID === characterID) add(LABELS.ESS_UNLOCKED);
  labels.sort((a, b) => LABEL_ORDER.indexOf(a) - LABEL_ORDER.indexOf(b));
  return { success: true, labels, context };
}
function clear(session, record) {
  if (!record || session?._safeLogoff !== record) return false;
  delete session._safeLogoff;
  record.state = "cleared";
  return true;
}
function abort(session, { notify = true, labels = null, reason = LABELS.MOVEMENT_ACTIVE } = {}) {
  const record = session?._safeLogoff;
  if (!clear(session, record)) return false;
  if (notify && record.startedAtMs === undefined) record.pendingFailure = labels || [reason];
  // A staged request has no timer UI yet. Its after-response hook is fenced by
  // the discarded intent, so it cannot resurrect the lease.
  if (notify && record.startedAtMs !== undefined && !session.socket?.destroyed) {
    try {
      session.sendNotification(labels ? "OnSafeLogoffFailed" : "OnSafeLogoffAborted", "clientID", labels ? [labels] : [ABORT_LABELS[reason] || reason]);
    } catch (error) {
      require("../../utils/logger").warn(`[SafeLogoff] abort notification failed: ${error.message}`);
    }
  }
  return true;
}
function prepareStart(session) {
  const result = collectFailedConditions(session);
  if (!result.success) return result;
  if (result.labels.length) return { success: true, data: result.labels };
  const { characterID, ship, scene, entity } = result.context;
  const record = { generation: randomUUID(), state: "staged", clientID: session.clientID,
    sessionID: String(session.sessionID ?? session.sid), scope: JSON.stringify(buildChildEntityScopeMetadata(entity)),
    characterID, shipID: Number(ship.itemID), sceneKey: scene.sceneKey,
    instanceID: String(scene.instanceID || ""), scene, entity, spaceState: session._space };
  session._safeLogoff = record;
  const data = [];
  Object.defineProperty(data, START_INTENT, { value: record });
  return { success: true, data };
}
function publishDeadline(session, record, nowMs) {
  // Retail reads this FILETIME against GetSimTime. Keep the server's duration
  // on the wall clock while projecting its endpoint into this scene's clock.
  const dilation = record.scene.getTimeDilation();
  const deadline = toFileTimeFromMs(record.scene.getCurrentSimTimeMs() +
    Math.max(0, record.expiresAtMs - nowMs) * dilation);
  if (record.presentedDeadline === undefined || record.presentedDilation !== dilation) {
    record.presentedDeadline = deadline;
    record.presentedDilation = dilation;
    session.sendNotification("OnSafeLogoffTimerStarted", "clientID", [deadline]);
  }
}
function startAfterResponse(session, response) {
  const record = response?.[START_INTENT];
  if (!record || record.responseHandled) return false;
  record.responseHandled = true;
  try {
  if (record.state === "cleared" && record.pendingFailure && !session?._safeLogoff && exactPilot(session, record, false)) {
    session.sendNotification("OnSafeLogoffFailed", "clientID", [record.pendingFailure]);
    return false;
  }
  if (!record || record.state !== "staged" || session?._safeLogoff !== record) return false;
  const context = exactPilot(session, record);
  if (!context) { abort(session, { notify: false }); return false; }
  const nowMs = getWallclockNowMs();
  const result = collectFailedConditions(session, { includeProgress: false, nowMs, context });
  if (result.labels.length) {
    clear(session, record);
    session.sendNotification("OnSafeLogoffFailed", "clientID", [result.labels]);
    return false;
  }
  record.state = "countdown";
  record.startedAtMs = nowMs;
  record.expiresAtMs = nowMs + DURATION_MS;
  publishDeadline(session, record, nowMs);
  return true;
  } catch (error) { clear(session, record); throw error; }
}
function processScene(scene, nowMs = getWallclockNowMs()) {
  for (const session of Array.from(scene.sessions.values())) {
    const record = session._safeLogoff;
    if (!record || record.state !== "countdown" || record.scene !== scene) continue;
    const context = exactPilot(session, record);
    if (!context) {
      abort(session, { notify: record.characterID === resolveSessionCharacterID(session) &&
        record.sessionID === String(session.sessionID ?? session.sid) });
      continue;
    }
    const result = collectFailedConditions(session, { includeProgress: false, nowMs, context });
    if (result.labels.length) { abort(session, { labels: result.labels }); continue; }
    if (nowMs < record.expiresAtMs) { publishDeadline(session, record, nowMs); continue; }
    if (!clear(session, record)) continue;
    // Clear first: nested callbacks, tick retries and disconnect cleanup cannot
    // activate twice or acquire a replacement session by character ID.
    try { session.sendNotification("OnSafeLogoffActivated", "clientID", []); }
    catch (error) { require("../../utils/logger").warn(`[SafeLogoff] activation notification failed: ${error.message}`); }
    finally {
      require("../_shared/sessionDisconnect").disconnectCharacterSession(session, {
        broadcast: true, clearSession: true });
    }
  }
}
function handleSceneDisposed(scene) {
  for (const session of scene.sessions.values()) abort(session);
}
function handleIncomingTarget(source, target) {
  if (!canEntitiesInteractLocally(source, target)) return;
  if (source.session?._safeLogoff) abort(source.session, { labels: [LABELS.TARGET_LOCKING] });
  if (target.session?._safeLogoff) abort(target.session, { labels: [LABELS.TARGETED] });
}
function handleFleetJoined(session) { abort(session, { labels: [LABELS.IN_FLEET] }); }
function handleCrimewatchStateChanged(state) {
  const session = registry.findSessionByCharacterID(state.characterID);
  if (!session?._safeLogoff) return;
  const now = getWallclockNowMs();
  const labels = [];
  if (state.pvpTimerExpiresAtMs > now || state.weaponTimerExpiresAtMs > now) labels.push(LABELS.PVP_TIMER);
  if (state.npcTimerExpiresAtMs > now) labels.push(LABELS.PVE_TIMER);
  if (labels.length) abort(session, { labels });
}
const ACTIONS = Object.freeze({
  ship: new Set(["SelfDestruct", "LaunchDrones", "LaunchFromShip", "LaunchFromContainer", "Drop", "Jettison", "ActivateShip", "LeaveShip", "BoardStoredShip", "StoreVessel", "Board", "Undock", "Eject"]),
  dogmaIM: new Set(["Activate", "LaunchProbes", "AddTarget", "AddTargetOBO"]),
  scanMgr: new Set(["SetProbeDestination", "SetProbeRangeStep", "SetProbeActivity", "RequestScans", "RecoverProbes", "ReconnectToLostProbes"]),
  entity: new Set(["CmdMineRepeatedly", "CmdEngage", "CmdSalvage", "CmdAssist", "CmdGuard", "CmdReconnectToDrones", "CmdReturnHome", "CmdReturnBay", "CmdAbandonDrone"]),
  fighterMgr: new Set(["LaunchFightersFromTubes", "RecallFightersToTubes", "ExecuteMovementCommandOnFighters", "CmdActivateAbilitySlots", "CmdAbandonFighter"]),
});
function handleServiceAction(session, service, method) {
  if (!session?._safeLogoff) return;
  if ((service === "beyonce" && /^Cmd/.test(method)) || ACTIONS[service]?.has(method))
    abort(session, { reason: service === "dogmaIM" ? LABELS.ACTIVE_MODULES : LABELS.MOVEMENT_ACTIVE });
}

module.exports = { DURATION_MS, LABELS, collectFailedConditions, prepareStart, startAfterResponse,
  processScene, abort, handleSceneDisposed, handleIncomingTarget, handleFleetJoined,
  handleCrimewatchStateChanged, handleServiceAction };
